// The GitHub App's D1 repository (src/github-app/installations.ts; spec §5) and the two places outside it that
// follow an installation: `addRepo` attaching a covered repository (src/integrations/settings.ts) and the
// Integrations screen's expected slots (src/integrations/catalog.ts; spec §10). Asserted in real D1: what each
// write leaves behind, its audit rows, and that org A's statements never touch org B's rows.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { RoleError } from "../src/data/context";
import {
  InstallationBoundElsewhereError, InstallationNotFoundError, bindInstallation, githubAppState, installationOwner, listInstallations,
  noteDelivery, primaryOnApp, repoInstallation, setInstallationSuspended, syncInstallationRepos, unbindInstallation,
} from "../src/github-app/installations";
import type { AppInstallation } from "../src/github-app/client";
import { addRepo, listRepos, removeRepo } from "../src/integrations/settings";
import { listIntegrations } from "../src/integrations/catalog";
import { listOrgAudit, setSecret } from "../src/data/secrets";
import { all, first, run } from "./helpers/db";
import { ORG_A, ORG_B, bearerCtx, platformCtx, systemCtx, tenantCtx } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";
import { HOOK_A, SLOTS, seedOrgSettings } from "./helpers/integrations";
import { appEnv, attachRepo, seedInstallation } from "./helpers/github-app";

const e = env as unknown as Env;
const ID = 4242;

const inst = (id = ID, o: Partial<AppInstallation> = {}): AppInstallation =>
  ({ id, account: { login: "acme-co", id: 9001, type: "Organization" }, repository_selection: "selected", suspended_at: null, ...o });
const repo = (id: number, full_name: string, priv = false) => ({ id, full_name, private: priv });
const ownerA = () => tenantCtx("AndresL230");
const adminB = () => tenantCtx("bob", "admin", { orgId: ORG_B });

const installations = () => all<{ installation_id: number; org_id: string; account_login: string; suspended_at: string | null; repos_synced_at: string | null; repository_selection: string; last_delivery_at: string | null; connected_by: string }>(env.DB,
  `SELECT installation_id, org_id, account_login, suspended_at, repos_synced_at, repository_selection, last_delivery_at, connected_by FROM github_installations ORDER BY installation_id`);
const instRepos = () => all<{ org_id: string; installation_id: number; repo_id: number; repo_full_name: string; private: number }>(env.DB,
  `SELECT org_id, installation_id, repo_id, repo_full_name, private FROM github_installation_repos ORDER BY installation_id, repo_id`);
const orgRepos = (org: string) => all<{ id: string; repo_full_name: string; installation_id: number | null }>(env.DB,
  `SELECT id, repo_full_name, installation_id FROM org_repos WHERE org_id = ? ORDER BY repo_full_name`, org);
const audits = (org: string) => all<{ actor: string; action: string; target: string; detail: string }>(env.DB,
  `SELECT actor, action, target, detail FROM org_admin_audit WHERE org_id = ? AND (action LIKE 'github.%' OR action LIKE 'repo.%') ORDER BY id`, org)
  .then((rows) => rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> })));

/** Org B's GitHub App rows and audit trail, as one string — unchanged by anything org A does. */
const orgBState = async () => JSON.stringify({
  inst: await all(env.DB, `SELECT * FROM github_installations WHERE org_id = ?`, ORG_B),
  repos: await all(env.DB, `SELECT * FROM github_installation_repos WHERE org_id = ?`, ORG_B),
  orgRepos: await all(env.DB, `SELECT * FROM org_repos WHERE org_id = ?`, ORG_B),
  audit: await all(env.DB, `SELECT * FROM org_admin_audit WHERE org_id = ?`, ORG_B),
});

describe("bindInstallation", () => {
  it("writes the installation and its repo list, ATTACHES the org's matching repos (by name, any case), and audits — one batch", async () => {
    const widgets = await addOrgRepo("acme-co/widgets", ORG_A, { id: "hook_widgets" });
    const other = await addOrgRepo("someone/else", ORG_A, { id: "hook_else", primary: false });
    const res = await bindInstallation(await ownerA(), platformCtx(), {
      installation: inst(), repos: [repo(1, "Acme-Co/Widgets"), repo(2, "acme-co/gadgets", true), repo(2, "acme-co/gadgets", true)], by: "AndresL230",
    });
    expect(res).toEqual({ created: true, attached: ["acme-co/widgets"], detached: [] });
    expect(await installations()).toEqual([expect.objectContaining({ installation_id: ID, org_id: ORG_A, account_login: "acme-co", connected_by: "AndresL230", suspended_at: null, last_delivery_at: null })]);
    expect((await installations())[0].repos_synced_at).not.toBeNull();
    expect(await instRepos()).toEqual([
      { org_id: ORG_A, installation_id: ID, repo_id: 1, repo_full_name: "Acme-Co/Widgets", private: 0 },
      { org_id: ORG_A, installation_id: ID, repo_id: 2, repo_full_name: "acme-co/gadgets", private: 1 },
    ]);
    expect(await orgRepos(ORG_A)).toEqual([
      { id: widgets, repo_full_name: "acme-co/widgets", installation_id: ID },
      { id: other, repo_full_name: "someone/else", installation_id: null },
    ]);
    expect(await audits(ORG_A)).toEqual([
      { actor: "AndresL230", action: "repo.attach", target: "acme-co/widgets", detail: { installation_id: ID } },
      { actor: "AndresL230", action: "github.connect", target: "acme-co", detail: {
        installation_id: ID, account_type: "Organization", repository_selection: "selected", repositories: 2, added: 2, removed: 0, rebind: false,
      } },
    ]);
    // …and the Integrations screen's history shows the App's rows too.
    expect((await listOrgAudit(await ownerA())).map((a) => a.action)).toEqual(expect.arrayContaining(["github.connect", "repo.attach"]));
  });

  it("an installation bound to ANOTHER org is refused — the message names no org — and nothing is written in either", async () => {
    await seedInstallation(ORG_A, ID, [repo(1, "acme-co/widgets")]);
    await addOrgRepo("acme-co/widgets", ORG_B, { id: "hook_b_widgets" });
    const before = JSON.stringify({ a: await installations(), r: await instRepos(), b: await orgBState(), aa: await audits(ORG_A) });
    const err = await bindInstallation(await adminB(), platformCtx(), { installation: inst(), repos: [repo(1, "acme-co/widgets")], by: "bob" }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(InstallationBoundElsewhereError);
    expect((err as Error).message).toBe("this GitHub App installation is already connected to another Trov organization");
    expect((err as Error).message).not.toMatch(/saplinglearn|org_/i);
    expect(JSON.stringify({ a: await installations(), r: await instRepos(), b: await orgBState(), aa: await audits(ORG_A) })).toBe(before);
  });

  it("a second org RACING the check (its owner read saw nothing) fails its whole batch on the primary key and reads as bound elsewhere", async () => {
    await seedInstallation(ORG_A, ID, [repo(1, "acme-co/widgets")]);
    await addOrgRepo("acme-co/widgets", ORG_B, { id: "hook_b_widgets" });
    // A platform context whose FIRST owner lookup answers "unbound" — as if org A bound it a moment later.
    let stale = 1;
    const db = env.DB;
    const racy = new Proxy(db, {
      get(target, key) {
        if (key === "prepare") {
          return (q: string) => (stale > 0 && q.includes("FROM github_installations i JOIN orgs") && stale--)
            ? { bind: () => ({ first: async () => null }) } : target.prepare(q);
        }
        const v = Reflect.get(target, key) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const before = await orgBState();
    await expect(bindInstallation(await adminB(), platformCtx("test", { ...e, DB: racy }), { installation: inst(), repos: [repo(1, "acme-co/widgets")], by: "bob" }))
      .rejects.toBeInstanceOf(InstallationBoundElsewhereError);
    expect(stale).toBe(0);
    expect(await orgBState()).toBe(before);
    expect(await installations()).toEqual([expect.objectContaining({ org_id: ORG_A })]);
    expect(await instRepos()).toEqual([expect.objectContaining({ org_id: ORG_A, repo_id: 1 })]);
  });

  it("a SUSPENDED org still holds its installation: another org cannot take it", async () => {
    await seedInstallation(ORG_A, ID);
    await run(env.DB, `UPDATE orgs SET suspended_at = '2026-10-06T00:00:00Z' WHERE id = ?`, ORG_A);
    expect(await installationOwner(platformCtx(), ID)).toEqual({ org_id: ORG_A, suspended_at: null, org_suspended: true });
    await expect(bindInstallation(await adminB(), platformCtx(), { installation: inst(), repos: [], by: "bob" })).rejects.toBeInstanceOf(InstallationBoundElsewhereError);
  });

  it("a re-bind by the same org updates the row in place, keeps last_delivery_at, replaces the list and detaches what left it", async () => {
    const widgets = await addOrgRepo("acme-co/widgets", ORG_A, { id: "hook_widgets" });
    const ctx = await ownerA();
    await bindInstallation(ctx, platformCtx(), { installation: inst(), repos: [repo(1, "acme-co/widgets"), repo(2, "acme-co/gadgets")], by: "AndresL230" });
    await noteDelivery(systemCtx(ORG_A, "github-webhook"), ID, Date.parse("2026-10-06T10:00:00Z"));
    const res = await bindInstallation(ctx, platformCtx(), { installation: inst(ID, { repository_selection: "all" }), repos: [repo(2, "acme-co/gadgets")], by: "AndresL230" });
    expect(res).toEqual({ created: false, attached: [], detached: ["acme-co/widgets"] });
    const [row] = await installations();
    expect(row).toMatchObject({ repository_selection: "all", last_delivery_at: "2026-10-06T10:00:00.000Z" });
    expect((await instRepos()).map((r) => r.repo_id)).toEqual([2]);
    expect(await orgRepos(ORG_A)).toEqual([{ id: widgets, repo_full_name: "acme-co/widgets", installation_id: null }]);
    expect((await audits(ORG_A)).slice(-2).map((a) => [a.action, a.target])).toEqual([["repo.detach", "acme-co/widgets"], ["github.connect", "acme-co"]]);
  });

  it("only an admin's session may bind: a member, a bearer admin and a system context are refused, and nothing is written", async () => {
    for (const ctx of [await tenantCtx("sanaok", "member"), await bearerCtx("AndresL230"), systemCtx(ORG_A, "github-webhook")]) {
      await expect(bindInstallation(ctx, platformCtx(), { installation: inst(), repos: [], by: ctx.userId })).rejects.toBeInstanceOf(RoleError);
    }
    expect(await installations()).toEqual([]);
  });
});

describe("syncInstallationRepos", () => {
  async function bound() {
    const widgets = await addOrgRepo("acme-co/widgets", ORG_A, { id: "hook_widgets" });
    const gadgets = await addOrgRepo("acme-co/gadgets", ORG_A, { id: "hook_gadgets", primary: false });
    await bindInstallation(await ownerA(), platformCtx(), { installation: inst(), repos: [repo(1, "acme-co/widgets")], by: "AndresL230" });
    await run(env.DB, `UPDATE github_installations SET repos_synced_at = NULL`);
    return { widgets, gadgets };
  }

  it("a FULL list replaces the stored one, attaches what arrived, detaches what left, stamps repos_synced_at and audits the counts", async () => {
    const { widgets, gadgets } = await bound();
    const res = await syncInstallationRepos(await ownerA(), ID, [repo(2, "acme-co/gadgets"), repo(3, "acme-co/new")], "AndresL230");
    expect(res).toEqual({ added: 2, removed: 1, attached: ["acme-co/gadgets"], detached: ["acme-co/widgets"] });
    expect((await instRepos()).map((r) => r.repo_full_name)).toEqual(["acme-co/gadgets", "acme-co/new"]);
    expect(await orgRepos(ORG_A)).toEqual([
      { id: gadgets, repo_full_name: "acme-co/gadgets", installation_id: ID },
      { id: widgets, repo_full_name: "acme-co/widgets", installation_id: null },
    ]);
    expect((await installations())[0].repos_synced_at).not.toBeNull();
    expect((await audits(ORG_A)).slice(-3).map((a) => [a.action, a.target, a.detail])).toEqual([
      ["repo.attach", "acme-co/gadgets", { installation_id: ID }],
      ["repo.detach", "acme-co/widgets", { installation_id: ID }],
      ["github.repos", "acme-co", { installation_id: ID, added: 2, removed: 1 }],
    ]);
  });

  it("a DELTA (installation_repositories) applies added / removed only, stores the selection, and leaves repos_synced_at alone", async () => {
    const { widgets, gadgets } = await bound();
    const gh = systemCtx(ORG_A, "github-webhook");
    const res = await syncInstallationRepos(gh, ID,
      { added: [{ id: 2, name: "gadgets", full_name: "acme-co/gadgets", private: true }, { junk: true }], removed: [{ id: 1, full_name: "acme-co/widgets" }] },
      "github-webhook", { repositorySelection: "all" });
    expect(res).toEqual({ added: 1, removed: 1, attached: ["acme-co/gadgets"], detached: ["acme-co/widgets"] });
    expect(await instRepos()).toEqual([{ org_id: ORG_A, installation_id: ID, repo_id: 2, repo_full_name: "acme-co/gadgets", private: 1 }]);
    expect(await orgRepos(ORG_A)).toEqual([
      { id: gadgets, repo_full_name: "acme-co/gadgets", installation_id: ID },
      { id: widgets, repo_full_name: "acme-co/widgets", installation_id: null },
    ]);
    expect((await installations())[0]).toMatchObject({ repository_selection: "all", repos_synced_at: null });
    const last = (await audits(ORG_A)).at(-1)!;
    expect(last).toEqual({ actor: "github-webhook", action: "github.repos", target: "acme-co", detail: { installation_id: ID, added: 1, removed: 1, repository_selection: "all" } });
  });

  it("a delivery that changes nothing writes no audit row; another org's installation id is not found", async () => {
    await bound();
    const n = (await audits(ORG_A)).length;
    await syncInstallationRepos(systemCtx(ORG_A, "github-webhook"), ID, { added: [{ id: 1, full_name: "acme-co/widgets" }] }, "github-webhook");
    expect(await audits(ORG_A)).toHaveLength(n);
    const before = await orgBState();
    await expect(syncInstallationRepos(systemCtx(ORG_B, "github-webhook"), ID, [], "github-webhook")).rejects.toBeInstanceOf(InstallationNotFoundError);
    expect(await orgBState()).toBe(before);
    expect(await instRepos()).toHaveLength(1);
  });

  it("a member is refused", async () => {
    await bound();
    await expect(syncInstallationRepos(await tenantCtx("sanaok", "member"), ID, [], "sanaok")).rejects.toBeInstanceOf(RoleError);
  });
});

describe("unbind, suspend, deliveries", () => {
  it("unbindInstallation detaches every attached repo, deletes the installation and its list, and audits; a second call is a no-op", async () => {
    const widgets = await addOrgRepo("acme-co/widgets", ORG_A, { id: "hook_widgets" });
    await bindInstallation(await ownerA(), platformCtx(), { installation: inst(), repos: [repo(1, "acme-co/widgets")], by: "AndresL230" });
    expect(await unbindInstallation(await ownerA(), ID, "AndresL230", "github.disconnect")).toBe(true);
    expect(await installations()).toEqual([]);
    expect(await instRepos()).toEqual([]);
    expect(await orgRepos(ORG_A)).toEqual([{ id: widgets, repo_full_name: "acme-co/widgets", installation_id: null }]);
    expect((await audits(ORG_A)).slice(-2)).toEqual([
      { actor: "AndresL230", action: "repo.detach", target: "acme-co/widgets", detail: { installation_id: ID } },
      { actor: "AndresL230", action: "github.disconnect", target: "acme-co", detail: { installation_id: ID, detached: 1 } },
    ]);
    expect(await unbindInstallation(systemCtx(ORG_A, "github-webhook"), ID, "github-webhook", "github.uninstall")).toBe(false);
  });

  it("GitHub's uninstall runs as the webhook's system tenant; org B's context cannot touch org A's installation", async () => {
    await seedInstallation(ORG_A, ID, [repo(1, "acme-co/widgets")]);
    expect(await unbindInstallation(systemCtx(ORG_B, "github-webhook"), ID, "github-webhook", "github.uninstall")).toBe(false);
    expect(await installations()).toHaveLength(1);
    expect(await unbindInstallation(systemCtx(ORG_A, "github-webhook"), ID, "github-webhook", "github.uninstall")).toBe(true);
    expect((await audits(ORG_A)).at(-1)).toMatchObject({ actor: "github-webhook", action: "github.uninstall", target: "acme" });
  });

  it("setInstallationSuspended records suspend and unsuspend once each; a redelivery writes nothing", async () => {
    await seedInstallation(ORG_A, ID);
    const gh = systemCtx(ORG_A, "github-webhook");
    expect(await setInstallationSuspended(gh, ID, "2026-10-06T12:00:00Z")).toBe(true);
    expect(await setInstallationSuspended(gh, ID, "2026-10-06T12:05:00Z")).toBe(false);
    expect((await installations())[0].suspended_at).toBe("2026-10-06T12:00:00.000Z");
    expect(await installationOwner(platformCtx(), ID)).toEqual({ org_id: ORG_A, suspended_at: "2026-10-06T12:00:00.000Z", org_suspended: false });
    expect(await setInstallationSuspended(gh, ID, null)).toBe(true);
    expect(await setInstallationSuspended(gh, ID, null)).toBe(false);
    expect((await audits(ORG_A)).map((a) => [a.actor, a.action])).toEqual([["github-webhook", "github.suspend"], ["github-webhook", "github.unsuspend"]]);
    expect(await setInstallationSuspended(systemCtx(ORG_B, "github-webhook"), ID, "2026-10-06T13:00:00Z")).toBe(false);
  });

  it("noteDelivery stamps last_delivery_at at most once per 10 minutes, and only for the org's own installation", async () => {
    await seedInstallation(ORG_A, ID);
    const gh = systemCtx(ORG_A, "github-webhook");
    const t0 = Date.parse("2026-10-06T10:00:00Z");
    expect(await noteDelivery(gh, ID, t0)).toBe(true);
    expect(await noteDelivery(gh, ID, t0 + 9 * 60_000)).toBe(false);
    expect((await installations())[0].last_delivery_at).toBe("2026-10-06T10:00:00.000Z");
    expect(await noteDelivery(gh, ID, t0 + 11 * 60_000)).toBe(true);
    expect(await noteDelivery(systemCtx(ORG_B, "github-webhook"), ID, t0 + 60 * 60_000)).toBe(false);
    expect((await installations())[0].last_delivery_at).toBe("2026-10-06T10:11:00.000Z");
  });

  it("installationOwner is null for an installation nobody bound", async () => {
    expect(await installationOwner(platformCtx(), 999)).toBeNull();
  });
});

describe("reads", () => {
  it("listInstallations: each installation with its repos, which are connected (org_repo_id) and which is primary; org B sees only its own", async () => {
    const widgets = await addOrgRepo("acme-co/widgets", ORG_A, { id: "hook_widgets" });
    await bindInstallation(await ownerA(), platformCtx(), {
      installation: inst(ID, { account: { login: "acme-co", id: 9001, type: "User" } }), repos: [repo(1, "acme-co/widgets", true), repo(2, "acme-co/gadgets")], by: "AndresL230",
    });
    await seedInstallation(ORG_B, 7, [repo(70, "beta/app")], { login: "beta" });
    const list = await listInstallations(await ownerA());
    expect(list).toEqual([{
      installation_id: ID, account_login: "acme-co", account_type: "User", repository_selection: "selected", suspended_at: null,
      connected_by: "AndresL230", connected_at: expect.any(String), last_delivery_at: null, repos_synced_at: expect.any(String),
      manage_url: `https://github.com/settings/installations/${ID}`,
      repos: [
        { repo_id: 2, full_name: "acme-co/gadgets", private: false, org_repo_id: null, is_primary: false },
        { repo_id: 1, full_name: "acme-co/widgets", private: true, org_repo_id: widgets, is_primary: true },
      ],
    }]);
    expect((await listInstallations(await adminB())).map((i) => [i.installation_id, i.manage_url])).toEqual([[7, "https://github.com/organizations/beta/settings/installations/7"]]);
    await expect(listInstallations(await tenantCtx("sanaok", "member"))).rejects.toBeInstanceOf(RoleError);
  });

  it("repoInstallation: only an attached row whose installation exists; another org's repo id reads as null", async () => {
    const widgets = await addOrgRepo("acme-co/widgets", ORG_A, { id: "hook_widgets" });
    const ctx = systemCtx(ORG_A);
    expect(await repoInstallation(ctx, widgets)).toBeNull();
    await attachRepo(widgets, ID); // attached to an installation with no row: not attached
    expect(await repoInstallation(ctx, widgets)).toBeNull();
    await seedInstallation(ORG_A, ID, [], { suspended: "2026-10-06T00:00:00Z" });
    expect(await repoInstallation(ctx, widgets)).toEqual({ installation_id: ID, suspended_at: "2026-10-06T00:00:00Z" });
    expect(await repoInstallation(systemCtx(ORG_B), widgets)).toBeNull();
  });

  it("githubAppState: configured only with all six secrets; primary_on_app only when the App is configured AND the primary is attached", async () => {
    const widgets = await addOrgRepo("acme-co/widgets", ORG_A, { id: "hook_widgets" });
    await seedInstallation(ORG_A, ID, [repo(1, "acme-co/widgets")]);
    const ctx = await ownerA();
    expect(await githubAppState(ctx, e)).toMatchObject({ configured: false, app_url: null, primary_on_app: false });
    await attachRepo(widgets, ID);
    expect(await primaryOnApp(ctx, e)).toBe(false);
    const state = await githubAppState(ctx, await appEnv());
    expect(state).toMatchObject({ configured: true, app_url: "https://github.com/apps/trov-test-app", primary_on_app: true });
    expect(state.installations).toHaveLength(1);
  });
});

describe("addRepo attaches a covered repository", () => {
  it("a NEW repo an installation of the org covers is connected through the App (repo.attach in the same batch); an uncovered one is not", async () => {
    await seedInstallation(ORG_A, ID, [repo(1, "acme-co/widgets")]);
    await seedInstallation(ORG_B, 7, [repo(70, "acme-co/gadgets")]); // org B's installation covers gadgets: nothing to org A
    const ctx = await ownerA();
    const { id } = await addRepo(ctx, { repo_full_name: "ACME-CO/widgets" });
    const { id: gadgets } = await addRepo(ctx, { repo_full_name: "acme-co/gadgets" });
    expect(await orgRepos(ORG_A)).toEqual([
      { id: gadgets, repo_full_name: "acme-co/gadgets", installation_id: null },
      { id, repo_full_name: "ACME-CO/widgets", installation_id: ID },
    ]);
    expect((await audits(ORG_A)).map((a) => [a.action, a.target])).toEqual([
      ["repo.add", "ACME-CO/widgets"], ["repo.attach", "ACME-CO/widgets"], ["repo.add", "acme-co/gadgets"],
    ]);
    const dto = await listRepos(ctx, "https://trov.test", true);
    expect(dto.map((r) => [r.repo_full_name, r.connection, r.installation_id])).toEqual([["ACME-CO/widgets", "app", ID], ["acme-co/gadgets", "token", null]]);
    // removeRepo keeps working for an attached row.
    await addRepo(ctx, { repo_full_name: "acme-co/gadgets", is_primary: true });
    expect(await removeRepo(ctx, id)).toEqual([]);
    expect((await orgRepos(ORG_A)).map((r) => r.repo_full_name)).toEqual(["acme-co/gadgets"]);
  });

  it("PROMOTING an unattached repo the org's installation covers attaches it too", async () => {
    const widgets = await addOrgRepo("acme-co/widgets", ORG_A, { id: "hook_widgets" });
    const gadgets = await addOrgRepo("acme-co/gadgets", ORG_A, { id: "hook_gadgets", primary: false });
    await seedInstallation(ORG_A, ID, [repo(2, "acme-co/gadgets")]);
    await addRepo(await ownerA(), { repo_full_name: "acme-co/gadgets", is_primary: true });
    expect(await orgRepos(ORG_A)).toEqual([
      { id: gadgets, repo_full_name: "acme-co/gadgets", installation_id: ID },
      { id: widgets, repo_full_name: "acme-co/widgets", installation_id: null },
    ]);
    expect((await audits(ORG_A)).map((a) => a.action)).toEqual(["repo.primary", "repo.attach"]);
    expect(await first(env.DB, `SELECT is_primary FROM org_repos WHERE id = ?`, gadgets)).toEqual({ is_primary: 1 });
  });
});

describe("the Integrations screen (catalog slots)", () => {
  const kinds = async (env2: Env) => (await listIntegrations(await ownerA(), env2, "https://trov.test")).integrations.map((i) => [i.kind, i.scope, i.expected] as const);

  it("with the App unconfigured an attachment changes nothing: the seven slots stay expected", async () => {
    await seedOrgSettings();
    await seedInstallation(ORG_A, ID, [repo(1, "SaplingLearn/sapling")]);
    await attachRepo(HOOK_A, ID);
    expect((await kinds(e)).map(([k, s]) => [k, s])).toEqual(SLOTS);
    expect((await kinds(e)).every(([, , expected]) => expected)).toBe(true);
  });

  it("an org whose primary is on the App expects no GitHub token and no webhook secret for the attached repo", async () => {
    await seedOrgSettings();
    const second = await addOrgRepo("SaplingLearn/docs", ORG_A, { id: "hook_docs", primary: false });
    await seedInstallation(ORG_A, ID, [repo(1, "SaplingLearn/sapling")]);
    await attachRepo(HOOK_A, ID);
    const app = await appEnv();
    expect(await kinds(app)).toEqual([
      ["github_webhook", second, true],
      ["cloudflare_analytics", "", true],
      ["railway", "staging", true], ["metrics_endpoint", "staging", true], ["railway", "production", true], ["metrics_endpoint", "production", true],
    ]);
  });

  it("a STILL-STORED token or webhook secret stays listed, in its place, as not expected — so it can be deleted", async () => {
    await seedOrgSettings();
    const owner = await ownerA();
    await setSecret(owner, "github_token", "", "ghp_".padEnd(40, "0123456789abcdef"));
    await setSecret(owner, "github_webhook", HOOK_A, "whsec_".padEnd(40, "0123456789abcdef"));
    await seedInstallation(ORG_A, ID, [repo(1, "SaplingLearn/sapling")]);
    await attachRepo(HOOK_A, ID);
    const list = (await listIntegrations(owner, await appEnv(), "https://trov.test")).integrations;
    expect(list.map((i) => [i.kind, i.scope, i.expected, i.configured])).toEqual([
      ["github_token", "", false, true],
      ["github_webhook", HOOK_A, false, true],
      ["cloudflare_analytics", "", true, false],
      ["railway", "staging", true, false], ["metrics_endpoint", "staging", true, false], ["railway", "production", true, false], ["metrics_endpoint", "production", true, false],
    ]);
    expect(list[1].scope_label).toBe("SaplingLearn/sapling");
  });

  it("a NON-primary repo on the App drops its webhook slot, but the token stays expected while the primary is not", async () => {
    await seedOrgSettings();
    const second = await addOrgRepo("SaplingLearn/docs", ORG_A, { id: "hook_docs", primary: false });
    await seedInstallation(ORG_A, ID, [repo(2, "SaplingLearn/docs")]);
    await attachRepo(second, ID);
    expect((await kinds(await appEnv())).slice(0, 2)).toEqual([["github_token", "", true], ["github_webhook", HOOK_A, true]]);
    expect((await kinds(await appEnv())).some(([k, s]) => k === "github_webhook" && s === second)).toBe(false);
  });
});
