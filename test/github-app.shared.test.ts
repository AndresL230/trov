/**
 * One GitHub account's installation, SEVERAL Trov orgs (issue #170; migration 0053_installation_repos;
 * docs/architecture/github-app.md › One installation, several orgs). Any number of orgs may bind an
 * installation and several may track the SAME repository: its events go to each. What an org reaches is
 * cut to what the admin who connected it could read — an `all` binding spans the installation, a
 * `selected` one reaches only its listed repositories: in the picker, in the webhook's routing, and in
 * the tokens minted for it.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import worker from "../src/index";
import migration from "../migrations/0053_installation_repos.sql?raw";
import { all, first, run } from "./helpers/db";
import { ORG_A, ORG_B, ensureMember, platformCtx, systemCtx } from "./helpers/tenant";
import { cookieFor } from "./helpers/persons";
import { addOrgRepo } from "./helpers/org-config";
import { call } from "./helpers/integrations";
import { fakeApp, seedInstallation, signAppWebhook, type FakeApp } from "./helpers/github-app";
import { clearInstallationTokens } from "../src/github-app/api";
import { resolveGithubCredential } from "../src/github-app/credential";
import { clearRepoLists } from "../src/github-app/repos";
import { allowedRepos, liveInstallation, repoAllowed } from "../src/github-app/store";
import { installationRepoOrgs } from "../src/platform/jobs";
import type { GithubReposDTO } from "@shared/github-app";
import prMerged from "./fixtures/gh-pr-merged.json";

const e = env as unknown as Env;
const NOW = Date.now();
const INST = 701; // the App on the GitHub account `solo`, which both orgs connect
const ALPHA = "solo/alpha"; // org A's primary
const BETA = "solo/beta"; // org B's primary
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeEach(() => { clearInstallationTokens(); clearRepoLists(); });
afterEach(() => { vi.unstubAllGlobals(); });

const github = (): FakeApp => fakeApp({
  now: () => NOW,
  installations: { [INST]: { account: { login: "solo", id: 5, type: "User" }, repos: [{ full_name: ALPHA }, { full_name: BETA }, { full_name: "solo/gamma", private: true }] } },
});

/** Both orgs bound to the SAME installation, each spanning it; A's primary is alpha, B's is beta. */
async function shared(): Promise<void> {
  await addOrgRepo(ALPHA, ORG_A);
  await addOrgRepo(BETA, ORG_B);
  await run(env.DB, `UPDATE org_repos SET connection = 'app'`);
  await seedInstallation(ORG_A, INST, "solo", { type: "User" });
  await seedInstallation(ORG_B, INST, "solo", { type: "User", by: "olive" });
}
/** Org A spans the installation; org B's admin reads only beta, so B's binding is `selected`: [beta]. */
async function partial(): Promise<void> {
  await addOrgRepo(ALPHA, ORG_A);
  await addOrgRepo(BETA, ORG_B);
  await run(env.DB, `UPDATE org_repos SET connection = 'app'`);
  await seedInstallation(ORG_A, INST, "solo", { type: "User" });
  await seedInstallation(ORG_B, INST, "solo", { type: "User", by: "olive", repos: [{ full_name: BETA }] });
}
const marks = (org: string) => all<{ repo_full_name: string; connection: string; lost: number }>(env.DB,
  `SELECT repo_full_name, connection, access_lost_at IS NOT NULL AS lost FROM org_repos WHERE org_id = ? ORDER BY repo_full_name`, org);
const eventOrgs = async () => (await all<{ org_id: string }>(env.DB, `SELECT org_id FROM events ORDER BY org_id`)).map((r) => r.org_id);

async function deliver(eventName: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return worker.fetch(new Request("https://trov.test/webhook/github/app", {
    method: "POST", body, headers: { "x-github-event": eventName, "content-type": "application/json", "x-hub-signature-256": await signAppWebhook(body) },
  }), e, execCtx);
}
const pr = (repo: string) => ({ ...prMerged, repository: { full_name: repo }, installation: { id: INST } });

describe("0053_installation_repos — the file", () => {
  it("rebuilds no table and deletes nothing: one index stops being unique, one column and one table are added", () => {
    const sql = migration.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
    expect(sql).not.toMatch(/\b(DROP TABLE|DELETE|RENAME|INSERT|UPDATE)\b/i);
    expect(sql.match(/DROP INDEX IF EXISTS (\w+)/g)).toEqual(["DROP INDEX IF EXISTS idx_org_github_installations_installation"]);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_org_github_installations_installation/);
    expect(sql).not.toMatch(/UNIQUE/i); // nothing limits a repository to one org
    expect(sql).toMatch(/ADD COLUMN repo_access TEXT NOT NULL DEFAULT 'all'/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS org_github_installation_repos/);
    expect(migration).toContain("DELETE FROM d1_migrations WHERE name = '0053_installation_repos.sql';"); // its rollback is in its header
  });

  it("a binding made before it (no `repo_access` named) spans its installation", async () => {
    await run(env.DB, `INSERT INTO org_github_installations (org_id, installation_id, account_login, account_id, account_type, repository_selection, connected_by, connected_at)
      VALUES (?, ?, 'solo', '5', 'User', 'all', 'x', '2026-10-01T00:00:00Z')`, ORG_A, INST);
    const row = (await liveInstallation(systemCtx(ORG_A)))!;
    expect(row.repo_access).toBe("all");
    expect(await allowedRepos(systemCtx(ORG_A), row)).toBeNull();
    expect(await repoAllowed(systemCtx(ORG_A), row, "solo/anything")).toBe(true);
  });
});

describe("the App webhook — routed by repository, to every org that tracks it", () => {
  it("two orgs on one installation: each repository's events land where it is tracked, and in BOTH when both track it", async () => {
    await shared();
    // Org B makes alpha its primary too: two teams, one repository.
    await run(env.DB, `UPDATE org_repos SET is_primary = 0 WHERE org_id = ?`, ORG_B);
    await addOrgRepo(ALPHA, ORG_B);
    await run(env.DB, `UPDATE org_repos SET connection = 'app' WHERE org_id = ?`, ORG_B);
    expect((await installationRepoOrgs(platformCtx(), INST, "Solo/Alpha")).map((r) => r.org_id)).toEqual([ORG_A, ORG_B]);
    const counts = () => all(env.DB, `SELECT org_id, COUNT(*) AS n FROM repo_events GROUP BY org_id ORDER BY org_id`);
    expect((await deliver("pull_request", pr(ALPHA))).status).toBe(200);
    expect(await counts()).toEqual([{ org_id: ORG_B, n: 1 }, { org_id: ORG_A, n: 1 }]);
    // A redelivery writes nothing twice, in either org.
    expect((await deliver("pull_request", pr(ALPHA))).status).toBeLessThan(300);
    expect(await counts()).toEqual([{ org_id: ORG_B, n: 1 }, { org_id: ORG_A, n: 1 }]);
    // Beta is tracked by B alone, and is no longer its primary: nothing is captured for it.
    expect((await deliver("pull_request", pr(BETA))).status).toBe(202);
    // A repository nobody tracks, and an org that is suspended: nothing for them, the other still captures.
    expect((await deliver("pull_request", pr("solo/gamma"))).status).toBe(202);
    await run(env.DB, `UPDATE orgs SET suspended_at = '2026-10-10T00:00:00Z', suspended_by = 'x' WHERE id = ?`, ORG_A);
    expect((await installationRepoOrgs(platformCtx(), INST, ALPHA)).map((r) => [r.org_id, r.org_suspended])).toEqual([[ORG_A, 1], [ORG_B, 0]]);
    expect(await installationRepoOrgs(platformCtx(), 999, ALPHA)).toEqual([]);
  });

  it("an org whose binding does not reach a repository gets none of its events, even with the name typed in", async () => {
    await partial();
    await run(env.DB, `UPDATE org_repos SET is_primary = 0 WHERE org_id = ?`, ORG_B);
    await addOrgRepo(ALPHA, ORG_B); // typed by name, now B's primary — but olive cannot read alpha
    expect((await installationRepoOrgs(platformCtx(), INST, ALPHA)).map((r) => r.org_id)).toEqual([ORG_A]);
    expect((await deliver("pull_request", pr(ALPHA))).status).toBe(200);
    expect(await eventOrgs()).toEqual([ORG_A]);
    expect((await installationRepoOrgs(platformCtx(), INST, BETA)).map((r) => r.org_id)).toEqual([ORG_B]);
  });

  it("uninstalled on GitHub: EVERY org's binding ends and each is told in its own audit log; suspend reaches both too", async () => {
    await partial();
    expect((await deliver("installation", { action: "suspend", installation: { id: INST } })).status).toBe(200);
    expect(await all(env.DB, `SELECT org_id, suspended_at IS NOT NULL AS s FROM org_github_installations ORDER BY org_id`)).toEqual([{ org_id: ORG_B, s: 1 }, { org_id: ORG_A, s: 1 }]);
    expect((await deliver("installation", { action: "deleted", installation: { id: INST } })).status).toBe(200);
    expect(await all(env.DB, `SELECT org_id, removed_reason FROM org_github_installations ORDER BY org_id`)).toEqual([{ org_id: ORG_B, removed_reason: "uninstalled" }, { org_id: ORG_A, removed_reason: "uninstalled" }]);
    expect([...(await marks(ORG_A)), ...(await marks(ORG_B))].map((r) => r.connection)).toEqual(["manual", "manual"]);
    expect(await all(env.DB, `SELECT * FROM org_github_installation_repos`)).toEqual([]); // what a binding reached goes with it
    for (const org of [ORG_A, ORG_B]) {
      const audit = await all<{ actor: string; action: string; detail: string }>(env.DB, `SELECT actor, action, detail FROM org_admin_audit WHERE org_id = ? AND action LIKE 'github.%' ORDER BY id`, org);
      expect(audit.map((r) => [r.actor, r.action])).toEqual([["github-webhook", "github.suspend"], ["github-webhook", "github.uninstall"]]);
      expect(audit.map((r) => r.detail).join()).not.toMatch(/org_|saplinglearn|acme/); // no row names another org
    }
  });

  it("a repository removed from the App's selection is lost by every org that tracks it; one added is marked only where the binding reaches it", async () => {
    await partial();
    await addOrgRepo(ALPHA, ORG_B, { primary: false }); // typed by name: outside B's reach
    await addOrgRepo(BETA, ORG_A, { primary: false });
    await run(env.DB, `UPDATE org_repos SET connection = 'app' WHERE repo_full_name = ?`, BETA);
    const change = (action: string, list: string[]) => deliver("installation_repositories", {
      action, installation: { id: INST }, repository_selection: "selected",
      repositories_added: action === "added" ? list.map((full_name) => ({ full_name })) : [], repositories_removed: action === "removed" ? list.map((full_name) => ({ full_name })) : [],
    });
    expect((await change("removed", [BETA])).status).toBe(200);
    expect(await marks(ORG_A)).toEqual([{ repo_full_name: ALPHA, connection: "app", lost: 0 }, { repo_full_name: BETA, connection: "app", lost: 1 }]);
    expect(await marks(ORG_B)).toEqual([{ repo_full_name: ALPHA, connection: "manual", lost: 0 }, { repo_full_name: BETA, connection: "app", lost: 1 }]);
    expect((await change("added", [ALPHA, BETA])).status).toBe(200);
    expect(await marks(ORG_A)).toEqual([{ repo_full_name: ALPHA, connection: "app", lost: 0 }, { repo_full_name: BETA, connection: "app", lost: 0 }]);
    // B gets beta back; alpha stays by hand — olive cannot read it.
    expect(await marks(ORG_B)).toEqual([{ repo_full_name: ALPHA, connection: "manual", lost: 0 }, { repo_full_name: BETA, connection: "app", lost: 0 }]);
  });
});

describe("Org settings › Repositories — picking from a shared installation", () => {
  const J = async <T>(res: Response): Promise<T> => (await res.json()) as T;
  async function olive(): Promise<string> {
    const cookie = await cookieFor("olive", { member: false });
    await ensureMember("olive", "admin", ORG_B);
    return cookie;
  }

  it("an org that spans the installation may track a repository another org already tracks; nothing says who else does", async () => {
    await shared();
    const admin = await olive();
    vi.stubGlobal("fetch", github().fetchImpl);
    const body = await J<GithubReposDTO>(await call(admin, "/github/repositories", { slug: "acme" }));
    expect(body.repositories).toEqual([
      { full_name: ALPHA, private: false, tracked: false, is_primary: false },
      { full_name: BETA, private: false, tracked: true, is_primary: true },
      { full_name: "solo/gamma", private: true, tracked: false, is_primary: false },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/saplinglearn|org_/i);
    expect((await call(admin, "/github/repositories", { slug: "acme", method: "POST", body: { repo_full_name: "Solo/Alpha" } })).status).toBe(201);
    expect((await marks(ORG_B)).map((r) => [r.repo_full_name, r.connection])).toEqual([[ALPHA, "app"], [BETA, "app"]]);
    expect(await marks(ORG_A)).toEqual([{ repo_full_name: ALPHA, connection: "app", lost: 0 }]); // A's is untouched
  });

  it("a `selected` binding lists and tracks only what its admin could read: the rest is not shown, and a typed name is refused", async () => {
    await partial();
    const admin = await olive();
    vi.stubGlobal("fetch", github().fetchImpl);
    const body = await J<GithubReposDTO>(await call(admin, "/github/repositories?refresh=1", { slug: "acme" }));
    expect(body).toEqual({ repositories: [{ full_name: BETA, private: false, tracked: true, is_primary: true }], total: 1, truncated: false });
    expect(JSON.stringify(body)).not.toMatch(/alpha|gamma/);
    const before = await all(env.DB, `SELECT * FROM org_repos ORDER BY id`);
    for (const name of [ALPHA, "solo/gamma"]) {
      const refused = await call(admin, "/github/repositories", { slug: "acme", method: "POST", body: { repo_full_name: name } });
      expect([refused.status, (await J<{ error: string }>(refused)).error]).toEqual([404, "not_visible"]);
    }
    expect(await all(env.DB, `SELECT * FROM org_repos ORDER BY id`)).toEqual(before);
    // Typed by name on the manual path it is tracked — by hand: reading the list again does not mark it `app`.
    await addOrgRepo(ALPHA, ORG_B, { primary: false });
    await call(admin, "/github/repositories?refresh=1", { slug: "acme" });
    expect(await marks(ORG_B)).toEqual([{ repo_full_name: ALPHA, connection: "manual", lost: 0 }, { repo_full_name: BETA, connection: "app", lost: 0 }]);
    const status = await J<{ installation: { repo_access: string } }>(await call(admin, "/github", { slug: "acme" }));
    expect(status.installation.repo_access).toBe("selected");
  });

  it("disconnecting in one org ends only that org's binding and touches only its repositories", async () => {
    await partial();
    const admin = await olive();
    vi.stubGlobal("fetch", github().fetchImpl);
    expect((await call(admin, "/github/disconnect", { slug: "acme", method: "POST" })).status).toBe(200);
    expect(await liveInstallation(systemCtx(ORG_B))).toBeNull();
    expect(await all(env.DB, `SELECT * FROM org_github_installation_repos`)).toEqual([]);
    expect((await liveInstallation(systemCtx(ORG_A)))?.installation_id).toBe(INST);
    expect([await marks(ORG_A), await marks(ORG_B)]).toEqual([[{ repo_full_name: ALPHA, connection: "app", lost: 0 }], [{ repo_full_name: BETA, connection: "manual", lost: 0 }]]);
    expect((await deliver("pull_request", pr(ALPHA))).status).toBe(200); // A still captures through it
    expect((await deliver("pull_request", pr(BETA))).status).toBe(202);
    expect(await eventOrgs()).toEqual([ORG_A]);
  });
});

describe("the installation token — only for what the org's binding reaches", () => {
  it("a `selected` org gets the App's token for a listed repository and nothing for another, whatever name it typed", async () => {
    await partial();
    await addOrgRepo(ALPHA, ORG_B, { primary: false });
    const gh = github();
    const b = systemCtx(ORG_B);
    const own = await resolveGithubCredential(b, e, { repo: "Solo/Beta", fetchImpl: gh.fetchImpl, now: NOW });
    expect(own?.source).toBe("app");
    expect(await resolveGithubCredential(b, e, { repo: ALPHA, fetchImpl: gh.fetchImpl, now: NOW })).toBeNull();
    expect(gh.mints.map((m) => m.repositories)).toEqual([["Beta"]]); // no mint was even asked for alpha
    expect((await first<{ last_error: string | null }>(env.DB, `SELECT last_error FROM org_github_installations WHERE org_id = ?`, ORG_B))?.last_error).toBeNull();
    // The org that spans the installation reads alpha through it; so would a second org that does.
    expect((await resolveGithubCredential(systemCtx(ORG_A), e, { repo: ALPHA, fetchImpl: gh.fetchImpl, now: NOW }))?.source).toBe("app");
  });
});
