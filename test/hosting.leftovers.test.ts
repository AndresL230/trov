// The Railway leftover-token bug (repo-setups Phase 0): 0057 left SaplingLearn's per-environment Railway PROJECT
// tokens in `org_secrets` (kind `railway`, scope = an environment key). Nothing reads them. Org settings › Hosting
// drew a card per (provider, scope) credential, so it showed "Railway · staging" / "Railway · production" as
// Connected "workspace tokens" while the org-wide connection the parts need did not exist.
//
// What holds now: ONE card per provider (its org-wide connection); a scoped credential of a provider is a LEFTOVER,
// never a connection — not counted, never Connected — shown inside the card, and removable ("Remove old tokens",
// a cookie-only admin route, audited). And ONE status function (shared/hosting-status-core.ts) answers for the
// card, the part rows, the checklist, Test this part and the Repo dashboard alike.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { HostingSetupDTO, HostingTestDTO } from "@shared/hosting";
import { hostingStatus, orgConnection } from "@shared/hosting-status-core";
import type { IntegrationsListDTO } from "@shared/integrations";
import { app } from "../src/routes";
import { setSecret } from "../src/data/secrets";
import { getRepoDashboard } from "../src/tools/repo";
import { all } from "./helpers/db";
import { deployRow } from "./helpers/dashboard-hosting";
import { ENVS } from "./helpers/repo";
import { ownerCookie, roleCookie, seedOrgSettings } from "./helpers/integrations";
import { send } from "./helpers/hosting-setup";
import { ORG_A, systemCtx, tenantCtx } from "./helpers/tenant";

const A = "/api/o/saplinglearn";
const PROJECT_STAGING = "rw_project_" + "St4g1ngT0k3n".repeat(3) + "5024";
const PROJECT_PRODUCTION = "rw_project_" + "Pr0duct10nT0k".repeat(3) + "51b1";
const WORKSPACE = "rw_workspace_" + "W0rksp4c3".repeat(4) + "c71e";

/** SaplingLearn as 0057 left it: two environments with a Railway backend each, and the two old project tokens. */
async function asMigrated(): Promise<void> {
  await seedOrgSettings();
  const ctx = await tenantCtx("AndresL230");
  await setSecret(ctx, "railway", "staging", PROJECT_STAGING);
  await setSecret(ctx, "railway", "production", PROJECT_PRODUCTION);
}
const setup = async (): Promise<HostingSetupDTO> => (await send(app, "GET", `${A}/hosting`, await ownerCookie(), undefined, env as never)).json as unknown as HostingSetupDTO;

describe("leftover per-environment tokens are never a connection", () => {
  it("ONE Railway connection — org-wide, Not connected — and the two project tokens as leftovers, labelled as they were stored", async () => {
    await asMigrated();
    const dto = await setup();
    // GUARD 1: one row per provider; a scoped credential never makes one, and is never counted as connected.
    expect(dto.connections.map((c) => [c.provider, c.scope, c.status])).toEqual([["cloudflare", "", "not_connected"], ["railway", "", "not_connected"]]);
    expect(dto.connections.filter((c) => c.scope !== "")).toEqual([]);
    expect(dto.leftovers).toEqual([
      { provider: "railway", scope: "staging", scope_label: "staging", label: "Project token", hint_last4: "5024", created_by: "AndresL230", created_at: expect.any(String) },
      { provider: "railway", scope: "production", scope_label: "production", label: "Project token", hint_last4: "51b1", created_by: "AndresL230", created_at: expect.any(String) },
    ]);
    // Every Backend reads Not connected; the checklist still asks to connect Railway.
    for (const e of dto.environments) expect(e.parts.find((p) => p.key === "backend")!.connection).toBe("not_connected");
    expect(dto.checklist.find((i) => i.id === "connect:railway:")).toMatchObject({ done: false, action: { kind: "connect", provider: "railway", scope: "" } });
  });

  it("connected once with a workspace token: Connected, the leftovers still listed (and still not a connection)", async () => {
    await asMigrated();
    await setSecret(await tenantCtx("AndresL230"), "railway", "", WORKSPACE);
    const dto = await setup();
    expect(dto.connections.filter((c) => c.provider === "railway").map((c) => [c.scope, c.status, c.hint_last4])).toEqual([["", "connected", "c71e"]]);
    expect(dto.leftovers?.map((l) => l.scope)).toEqual(["staging", "production"]);
    for (const e of dto.environments) expect(e.parts.find((p) => p.key === "backend")!.connection).toBe("connected");
  });

  it("the part rows, the checklist and the org-wide connection agree — THE status function, for every part", async () => {
    await asMigrated();
    await setSecret(await tenantCtx("AndresL230"), "cloudflare_analytics", "", "cf_" + "T0k3n".repeat(8));
    const dto = await setup();
    for (const e of dto.environments) {
      for (const part of e.parts) {
        const label = dto.providers.find((p) => p.id === part.provider)!.label;
        const st = hostingStatus(orgConnection(dto.connections, part.provider), label);
        expect(part.connection, `${e.key}/${part.key}`).toBe(st.state);
        expect(dto.checklist.find((i) => i.id === `connect:${part.provider}:`)?.done, `${part.provider} checklist`).toBe(st.live);
      }
    }
  });

  it("Test this part on Railway, not connected: says \"Railway isn't connected.\" — never \"No secret is set\" — and probes nothing", async () => {
    await asMigrated();
    const r = await send(app, "POST", `${A}/hosting/railway/test`, await ownerCookie(), { env: "staging", part: "backend" }, env as never);
    expect(r.status).toBe(200);
    const dto = r.json as unknown as HostingTestDTO;
    expect(dto).toMatchObject({ ok: false, detail: "Railway isn't connected.", connection: { provider: "railway", scope: "", status: "not_connected" } });
    expect(JSON.stringify(dto)).not.toContain("No secret");
    // Nothing was probed: no outcome was recorded on any credential (the leftovers included).
    expect((await all(env.DB, `SELECT scope, last_error FROM org_secrets WHERE org_id = ? AND kind = 'railway' ORDER BY scope`, ORG_A))).toEqual([
      { scope: "production", last_error: null }, { scope: "staging", last_error: null },
    ]);
  });

  it("the Integrations list does not offer them either (a scope the kind cannot have)", async () => {
    await asMigrated();
    const r = await send(app, "GET", `${A}/integrations`, await ownerCookie(), undefined, env as never);
    const list = (r.json as unknown as IntegrationsListDTO).integrations;
    expect(list.filter((i) => i.kind === "railway").map((i) => i.scope)).toEqual([""]);
  });
});

describe("Remove old tokens — DELETE /hosting/:provider/leftovers", () => {
  it("deletes the provider's scoped credentials as the admin, audited; never the org-wide one", async () => {
    await asMigrated();
    await setSecret(await tenantCtx("AndresL230"), "railway", "", WORKSPACE);
    const r = await send(app, "DELETE", `${A}/hosting/railway/leftovers`, await ownerCookie(), undefined, env as never);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ removed: 2, connection: { provider: "railway", scope: "", status: "connected", hint_last4: "c71e" } });
    expect(await all(env.DB, `SELECT scope FROM org_secrets WHERE org_id = ? AND kind = 'railway'`, ORG_A)).toEqual([{ scope: "" }]);
    const admin = await all<{ actor: string; action: string; target: string; detail: string }>(env.DB,
      `SELECT actor, action, target, detail FROM org_admin_audit WHERE org_id = ? AND action = 'hosting.leftovers_removed'`, ORG_A);
    expect(admin.map((a) => [a.actor, a.target, JSON.parse(a.detail)])).toEqual([["AndresL230", "railway", { provider: "railway", scopes: ["production", "staging"], count: 2 }]]);
    const trail = await all<{ target: string; detail: string }>(env.DB, `SELECT target, detail FROM org_audit WHERE org_id = ? AND action = 'secret.delete' ORDER BY target`, ORG_A);
    expect(trail.map((t) => [t.target, JSON.parse(t.detail)])).toEqual([
      ["railway:production", { hint_last4: "51b1", reason: "leftover" }], ["railway:staging", { hint_last4: "5024", reason: "leftover" }],
    ]);
    expect((await setup()).leftovers).toEqual([]);
    // Nothing left: 404, and nothing else changes.
    expect((await send(app, "DELETE", `${A}/hosting/railway/leftovers`, await ownerCookie(), undefined, env as never)).status).toBe(404);
    expect(await all(env.DB, `SELECT scope FROM org_secrets WHERE org_id = ? AND kind = 'railway'`, ORG_A)).toEqual([{ scope: "" }]);
  });

  it("an admin's cookie only: a member is 403, a bearer is 403, an unknown provider 404 — and none of them removes anything", async () => {
    await asMigrated();
    const path = `${A}/hosting/railway/leftovers`;
    expect((await send(app, "DELETE", path, await roleCookie("casey", "member"), undefined, env as never)).status).toBe(403);
    expect((await send(app, "DELETE", path, await ownerCookie(), undefined, env as never, { authorization: "Bearer trov_mcp_x" })).status).toBe(403);
    expect((await send(app, "DELETE", `${A}/hosting/nope/leftovers`, await ownerCookie(), undefined, env as never)).status).toBe(404);
    expect(await all(env.DB, `SELECT scope FROM org_secrets WHERE org_id = ? AND kind = 'railway' ORDER BY scope`, ORG_A)).toEqual([{ scope: "production" }, { scope: "staging" }]);
  });
});

describe("the Repo dashboard reads the same status", () => {
  it("a never-polled Railway part: not connected while only leftovers exist; connected once the org-wide token is stored", async () => {
    await asMigrated();
    // Cloudflare's frontend has reported (so the section draws its parts); Railway's backends never have.
    const now = Date.now();
    await deployRow(ORG_A, "staging", "frontend", "cloudflare", "d1", "ready", new Date(now - 3_600_000).toISOString());
    const envs = ["staging", "production"].map((key) => ({ ...ENVS[0], key, label: key }));
    const backends = async () => {
      const s = (await getRepoDashboard(systemCtx(ORG_A), "SaplingLearn/sapling", now, envs)).providers;
      expect(s.status).toBe("ok");
      return s.status === "ok" ? s.data.filter((p) => p.part === "backend") : [];
    };
    for (const b of await backends()) expect([b.env, b.status, b.connection]).toEqual([b.env, "not_connected", "not_connected"]);
    await setSecret(await tenantCtx("AndresL230"), "railway", "", WORKSPACE);
    // Connected, not read yet: the dashboard no longer calls it "not connected" (the card says Connected).
    for (const b of await backends()) expect([b.status, b.connection]).toEqual(["not_connected", "connected"]);
  });
});
