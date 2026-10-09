// The Vercel webhook beyond "uninstalled" (src/hosting/webhook.ts, src/hosting/providers/vercel.ts), and the
// provider's Configuration URL (`GET /hosting/<provider>/configure`, src/hosting/routes.ts).
//
//   • a VERIFIED deployment / project event is a nudge: the stored parts on that project, in the org connected
//     to that provider-side account, are polled again — nothing from the delivery is stored;
//   • an unknown event type is answered 2xx and ignored; an unverified one is the bare 401 and polls nothing;
//   • the Configuration URL opens Org settings › Hosting for a signed-in admin of the org that holds the
//     installation, and is the SAME redirect to `/` for everything else — it never says whether one exists.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { setSecret } from "../src/data/secrets";
import { handleHostingWebhook } from "../src/hosting/webhook";
import { VERCEL_REFRESH_EVENTS, vercel } from "../src/hosting/providers/vercel";
import type { ProviderMap } from "../src/hosting/part-writes";
import type { HostingProvider, PartRef } from "../src/hosting/types";
import deploymentSucceeded from "../fixtures/hosting/vercel/webhook.deployment.succeeded.json";
import projectRenamed from "../fixtures/hosting/vercel/webhook.project.renamed.json";
import removed from "../fixtures/hosting/vercel/webhook.integration-configuration.removed.json";
import { all, run } from "./helpers/db";
import { ownerCookie, roleCookie, seedOrgSettings } from "./helpers/integrations";
import { CLIENT_SECRET, fakeProviders, hmacHex, hostingTestApp, installEnv, send } from "./helpers/hosting-setup";
import { LONG_TOKEN } from "./helpers/repo";
import { ORG_A, ORG_B, ensureMember, tenantCtx } from "./helpers/tenant";

const A = "/api/o/saplinglearn";
const TEAM = "team_x";

/** The fake Vercel with a `changedProject` hook (`{ type: "deployed", team, project }`) and a poll that is counted. */
function fakes(): { providers: ProviderMap; polled: string[] } {
  const base = fakeProviders().providers;
  const polled: string[] = [];
  const v = base.vercel;
  const provider: HostingProvider = {
    ...v,
    poll: async (_pc, part: PartRef) => { polled.push(`${part.orgId}:${part.env}/${part.key}`); return { deploys: [], points: [], unavailable: [], covered: null }; },
    install: {
      ...v.install!,
      webhook: {
        ...v.install!.webhook!,
        changedProject(p) {
          const x = p as { type?: unknown; team?: unknown; project?: unknown } | null;
          return x && x.type === "deployed" && typeof x.team === "string" && typeof x.project === "string" ? { accountId: x.team, names: [x.project] } : null;
        },
      },
    },
  };
  return { providers: { ...base, vercel: provider } as ProviderMap, polled };
}

async function seedInstall(orgId: string, handle: string, externalId: string, account = TEAM): Promise<void> {
  await ensureMember(handle, "owner", orgId);
  await setSecret(await tenantCtx(handle, "owner", { orgId }), "vercel", "", LONG_TOKEN);
  await run(env.DB, `INSERT INTO org_hosting_connections (org_id, provider, scope, method, external_id, account_id, account_label, status, connected_by, connected_at)
    VALUES (?, 'vercel', '', 'install', ?, ?, 'Team X', 'active', ?, '2026-10-01T00:00:00Z')`, orgId, externalId, account, handle);
}
const deliver = async (payload: unknown, f: { providers: ProviderMap }, o: { sign?: string | null; waitUntil?: (p: Promise<unknown>) => void } = {}) => {
  const body = JSON.stringify(payload);
  const sig = o.sign === undefined ? await hmacHex(CLIENT_SECRET, body) : o.sign;
  return handleHostingWebhook(new Request("https://trov.test/webhook/hosting/vercel", { method: "POST", body, headers: sig ? { "x-fake-signature": sig } : {} }), installEnv(), "vercel",
    { providers: f.providers, waitUntil: o.waitUntil });
};
const pollRows = () => all<{ org_id: string; env: string; part: string; status: string }>(env.DB, `SELECT org_id, env, part, status FROM hosting_poll_state ORDER BY org_id, env, part`);

/** Org A: staging/web on project `site`, staging/docs on project `docs`, connected by install to `team_x`. */
async function seedParts(f: { providers: ProviderMap }): Promise<void> {
  await seedOrgSettings();
  const web = hostingTestApp(f.providers);
  const me = await ownerCookie();
  for (const [key, project] of [["web", "site"], ["docs", "docs"]] as const) {
    expect((await send(web, "PUT", `${A}/environments/staging/parts/${key}`, me, { provider: "vercel", settings: { project } })).status).toBe(201);
  }
  await seedInstall(ORG_A, "AndresL230", "icfg_a");
}

describe("Vercel's own events, as the provider reads them", () => {
  const hook = vercel.install!.webhook!;

  it("every deployment event and project.removed / project.renamed names the account and the project — by id and by name", () => {
    expect(hook.changedProject!(deploymentSucceeded)).toEqual({ accountId: "team_a1B2c3D4e5F6g7H8i9J0k1L2", names: ["prj_Qm3xT8vLp2Rk7Yw4Nf6Hs9Bd1Cz5", "acme-web"] });
    expect(hook.changedProject!(projectRenamed)).toEqual({ accountId: "team_a1B2c3D4e5F6g7H8i9J0k1L2", names: ["prj_Qm3xT8vLp2Rk7Yw4Nf6Hs9Bd1Cz5", "acme-site"] });
    expect([...VERCEL_REFRESH_EVENTS].sort()).toEqual([
      "deployment.canceled", "deployment.created", "deployment.error", "deployment.promoted", "deployment.rollback", "deployment.succeeded", "project.removed", "project.renamed",
    ]);
    for (const type of VERCEL_REFRESH_EVENTS) expect(hook.changedProject!({ ...deploymentSucceeded, type }), type).not.toBeNull();
    // A personal account has no team: the user's id is the account.
    const personal = { type: "deployment.created", payload: { user: { id: "Xk2mP9qL4rT7vW1yZ3bN5cD8" }, project: { id: "prj_abc" } } };
    expect(hook.changedProject!(personal)).toEqual({ accountId: "Xk2mP9qL4rT7vW1yZ3bN5cD8", names: ["prj_abc"] });
  });

  it("anything else is null: another event type, the uninstall notice, no account, no usable project", () => {
    for (const type of ["deployment.ready", "domain.created", "integration-configuration.removed", "", 7]) expect(hook.changedProject!({ ...deploymentSucceeded, type }), String(type)).toBeNull();
    expect(hook.changedProject!(removed)).toBeNull();
    expect(hook.removedExternalId(deploymentSucceeded)).toBeNull();
    expect(hook.changedProject!({ type: "deployment.created", payload: { project: { id: "prj_abc" } } })).toBeNull();
    expect(hook.changedProject!({ type: "deployment.created", payload: { team: { id: "team_x" }, project: { id: "../../v2/user" }, deployment: { name: ".." } } })).toBeNull();
    for (const junk of [null, "x", [], { type: "deployment.created" }, { type: "deployment.created", payload: "x" }]) expect(hook.changedProject!(junk)).toBeNull();
  });
});

describe("POST /webhook/hosting/:provider — a changed project", () => {
  it("a verified event polls the parts on THAT project, in the org connected to that account — and only them", async () => {
    const f = fakes();
    await seedParts(f);
    // Org B is connected to another account, with a part on a project of the same name.
    await seedInstall(ORG_B, "boss", "icfg_b", "team_other");
    await run(env.DB, `INSERT INTO org_environments (org_id, key, label, branch, position, frontend_url, api_url, health_path, railway_env, worker, worker_check, created_at, updated_at, updated_by)
      VALUES (?, 'staging', 'Staging', 'main', 0, '', '', '/', '', '', '', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'boss')`, ORG_B);
    await run(env.DB, `INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
      VALUES (?, 'staging', 'web', 0, 'Web', 'web', 'vercel', '{"project":"site"}', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'boss')`, ORG_B);

    const r = await deliver({ type: "deployed", team: TEAM, project: "site" }, f);
    expect([r.status, await r.json()]).toEqual([200, { ok: true, revoked: 0, refreshed: 1 }]);
    expect(f.polled).toEqual([`${ORG_A}:staging/web`]);
    // The poll is the hourly poll's own: it records its outcome, as that org's system tenant.
    expect(await pollRows()).toEqual([{ org_id: ORG_A, env: "staging", part: "web", status: "ok" }]);
    // Nothing was revoked, and nothing about the connection changed.
    expect(await all(env.DB, `SELECT status FROM org_hosting_connections ORDER BY org_id`)).toEqual([{ status: "active" }, { status: "active" }]);
  });

  it("a project no part names, or an account no org is connected to, is acknowledged and polls nothing", async () => {
    const f = fakes();
    await seedParts(f);
    for (const payload of [{ type: "deployed", team: TEAM, project: "elsewhere" }, { type: "deployed", team: "team_nobody", project: "site" }]) {
      const r = await deliver(payload, f);
      expect([r.status, await r.json()]).toEqual([200, { ok: true, revoked: 0, refreshed: 0 }]);
    }
    expect(f.polled).toEqual([]);
    expect(await pollRows()).toEqual([]);
  });

  it("an unknown event type is a 2xx that does nothing; an unverified delivery is the bare 401 and polls nothing", async () => {
    const f = fakes();
    await seedParts(f);
    const other = await deliver({ type: "domain.created", team: TEAM, project: "site" }, f);
    expect([other.status, await other.json()]).toEqual([200, { ok: true, revoked: 0 }]);
    const body = { type: "deployed", team: TEAM, project: "site" };
    for (const sign of [null, "00", await hmacHex("wrong-secret", JSON.stringify(body))]) {
      const r = await deliver(body, f, { sign });
      expect([r.status, await r.json()]).toEqual([401, { error: "unauthorized" }]);
    }
    expect(f.polled).toEqual([]);
    expect(await pollRows()).toEqual([]);
  });

  it("answers before it polls when the Worker hands it waitUntil; a suspended org is not polled", async () => {
    const f = fakes();
    await seedParts(f);
    const deferred: Promise<unknown>[] = [];
    const r = await deliver({ type: "deployed", team: TEAM, project: "docs" }, f, { waitUntil: (p) => { deferred.push(p); } });
    expect(await r.json()).toEqual({ ok: true, revoked: 0, refreshed: 1 });
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(f.polled).toEqual([`${ORG_A}:staging/docs`]);

    await run(env.DB, `UPDATE orgs SET suspended_at = '2026-10-02T00:00:00Z' WHERE id = ?`, ORG_A);
    expect(await (await deliver({ type: "deployed", team: TEAM, project: "site" }, f)).json()).toEqual({ ok: true, revoked: 0, refreshed: 0 });
    expect(f.polled).toHaveLength(1);
  });

  it("the uninstall notice still ends the connection, with the registry passed the old way", async () => {
    const f = fakes();
    await seedParts(f);
    const body = JSON.stringify({ type: "removed", id: "icfg_a" });
    const r = await handleHostingWebhook(new Request("https://trov.test/webhook/hosting/vercel", { method: "POST", body, headers: { "x-fake-signature": await hmacHex(CLIENT_SECRET, body) } }), installEnv(), "vercel", f.providers);
    expect(await r.json()).toEqual({ ok: true, revoked: 1 });
    expect(f.polled).toEqual([]);
  });
});

describe("GET /hosting/:provider/configure — the provider's Configuration URL", () => {
  const go = async (web: ReturnType<typeof hostingTestApp>, cookie: string | null, path: string, e: Env = installEnv()) => {
    const res = await web.request(path, { headers: cookie ? { cookie } : {} }, e as unknown as Record<string, unknown>);
    expect(res.headers.get("content-type") ?? "").not.toContain("json");
    return [res.status, res.headers.get("location")];
  };

  it("opens Org settings › Hosting for a signed-in admin of the org that holds the installation", async () => {
    const f = fakes();
    await seedInstall(ORG_A, "AndresL230", "icfg_a");
    const web = hostingTestApp(f.providers);
    expect(await go(web, await ownerCookie(), "/hosting/vercel/configure?configurationId=icfg_a")).toEqual([302, "/saplinglearn/#org/hosting"]);
    expect(await go(web, await roleCookie("dana-admin", "admin"), "/hosting/vercel/configure?configurationId=icfg_a")).toEqual([302, "/saplinglearn/#org/hosting"]);
  });

  it("is the SAME redirect to / for everything else — it never says whether an installation exists", async () => {
    const f = fakes();
    await seedInstall(ORG_A, "AndresL230", "icfg_a");
    await seedInstall(ORG_B, "boss", "icfg_b");
    const web = hostingTestApp(f.providers);
    const owner = await ownerCookie();
    const home = [302, "/"];
    expect(await go(web, owner, "/hosting/vercel/configure?configurationId=icfg_b"), "another org's installation").toEqual(home);
    expect(await go(web, owner, "/hosting/vercel/configure?configurationId=icfg_nobody"), "unknown").toEqual(home);
    expect(await go(web, owner, "/hosting/vercel/configure"), "no id").toEqual(home);
    expect(await go(web, owner, "/hosting/vercel/configure?configurationId=" + encodeURIComponent("' OR 1=1 --")), "not an id").toEqual(home);
    expect(await go(web, await roleCookie("mel-member", "member"), "/hosting/vercel/configure?configurationId=icfg_a"), "a member, not an admin").toEqual(home);
    expect(await go(web, null, "/hosting/vercel/configure?configurationId=icfg_a"), "signed out").toEqual(home);
    for (const p of ["nope", "render", "aws"]) expect(await go(web, owner, `/hosting/${p}/configure?configurationId=icfg_a`), p).toEqual(home);
    // A suspended org's installation, and one that was disconnected, are gone too.
    await run(env.DB, `UPDATE org_hosting_connections SET status = 'revoked', revoked_at = '2026-10-02T00:00:00Z', revoked_by = 'AndresL230', revoked_reason = 'disconnected' WHERE org_id = ?`, ORG_A);
    expect(await go(web, owner, "/hosting/vercel/configure?configurationId=icfg_a"), "disconnected").toEqual(home);
  });
});
