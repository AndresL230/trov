// Org settings › Hosting — the ONE read (`GET /api/o/:slug/hosting`, src/hosting/setup.ts): providers,
// environments with their parts (legacy and stored), connections and the checklist generated from what the
// parts use; the provider catalogue for any member; the Integrations list expecting a provider's credential
// once a stored part uses it; and org isolation.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { HOSTING_PROVIDERS, type HostingChecklistItem, type HostingProviderDTO, type HostingSetupDTO } from "@shared/hosting";
import type { IntegrationsListDTO } from "@shared/integrations";
import { app } from "../src/routes";
import { recordSecretOutcome, setIntegrationConfig, setSecret } from "../src/data/secrets";
import { buildChecklist, getHostingSetup } from "../src/hosting/setup";
import { listConnections } from "../src/hosting/connections";
import { listAllParts } from "../src/hosting/parts";
import { all, run } from "./helpers/db";
import { SLOTS, call, ownerCookie, roleCookie, seedOrgSettings } from "./helpers/integrations";
import { cookieFor } from "./helpers/persons";
import { fakeProviders, hostingTestApp, installEnv, seedBareEnvironment, send } from "./helpers/hosting-setup";
import { ORG_A, ORG_B, ensureMember, tenantCtx } from "./helpers/tenant";

const A = "/api/o/saplinglearn";
const TOKEN = "tok_" + "Pp4Qq5Rr".repeat(6);
const ids = (items: HostingChecklistItem[]) => items.map((i) => [i.id, i.done]);

describe("GET /hosting", () => {
  it("SaplingLearn as migrated: two environments, each with its legacy frontend and backend; every provider described", async () => {
    await seedOrgSettings();
    await setIntegrationConfig(await tenantCtx("AndresL230"), "cloudflare_analytics", "", { account_id: "0123456789abcdef0123456789abcdef" });
    const r = await send(app, "GET", `${A}/hosting`, await ownerCookie(), undefined, env as never);
    expect(r.status).toBe(200);
    const dto = r.json as unknown as HostingSetupDTO;
    expect(dto.secrets_available).toBe(true);
    expect(dto.providers.map((p) => p.id)).toEqual([...HOSTING_PROVIDERS]);
    expect(dto.providers.find((p) => p.id === "aws")).toMatchObject({ status: "later" });
    expect(dto.environments.map((e) => [e.key, e.label, e.branch, e.parts.map((p) => p.key)])).toEqual([
      ["staging", "staging", "main", ["frontend", "backend"]], ["production", "production", "production", ["frontend", "backend"]],
    ]);
    const [fe, be] = dto.environments[0].parts;
    expect(fe).toMatchObject({
      env: "staging", key: "frontend", label: "Frontend", role: "web", provider: "cloudflare", legacy: true, position: -2,
      settings: { worker: "frontend-staging", worker_check: "Workers Builds: frontend-staging" }, last_poll: null, connection: "not_connected",
      console_url: "https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/workers/services/view/frontend-staging/production",
    });
    expect(be).toMatchObject({ key: "backend", provider: "railway", role: "service", legacy: true, console_url: null, settings: { railway_env: "Sapling / staging", railway_environment_id: "env-staging-id", railway_service_id: "service-id" } });
    expect(dto.connections.map((c) => [c.provider, c.scope, c.status])).toEqual([
      ["cloudflare", "", "not_connected"], ["railway", "staging", "not_connected"], ["railway", "production", "not_connected"],
    ]);
    expect(ids(dto.checklist)).toEqual([
      ["add_environment", true], ["add_part:staging", true], ["add_part:production", true],
      ["connect:cloudflare:", false], ["connect:railway:staging", false], ["connect:railway:production", false],
    ]);
    expect(dto.checklist.find((i) => i.id === "connect:railway:staging")).toMatchObject({
      title: "Connect Railway for staging", detail: "Used by staging › Backend.", action: { kind: "connect", provider: "railway", scope: "staging" },
    });
  });

  it("a legacy Worker secret counts as connected for its parts (the connection still says it is the fallback)", async () => {
    await seedOrgSettings();
    const r = await send(app, "GET", `${A}/hosting`, await ownerCookie(), undefined, { ...env, CF_ANALYTICS_TOKEN: "cf_legacy_0000000000000000", CF_ANALYTICS_ACCOUNT_ID: "fedcba9876543210fedcba9876543210" } as never);
    const dto = r.json as unknown as HostingSetupDTO;
    expect(dto.environments[0].parts[0]).toMatchObject({ connection: "connected", console_url: expect.stringContaining("fedcba9876543210fedcba9876543210") });
    expect(dto.connections[0]).toMatchObject({ provider: "cloudflare", status: "not_connected", legacy_fallback: true });
    expect(dto.checklist.filter((i) => i.id.includes("cloudflare"))).toEqual([
      expect.objectContaining({ id: "connect:cloudflare:", done: true, detail: expect.stringContaining("legacy Worker secret") }),
      expect.objectContaining({ id: "configure:cloudflare:", done: true }), // the account id falls back too
    ]);
  });

  it("a stored part's last poll is the hosting job's row; an outcome from ANOTHER provider (before a switch) is not shown", async () => {
    await seedBareEnvironment(ORG_A, "qa", 0, "QA");
    const { providers } = fakeProviders();
    const web = hostingTestApp(providers);
    const me = await ownerCookie();
    expect((await send(web, "PUT", `${A}/environments/qa/parts/web`, me, { provider: "vercel", settings: { project: "site" } })).status).toBe(201);
    expect((await send(web, "PUT", `${A}/environments/qa/parts/api`, me, { provider: "render", settings: { service_id: "srv-a" } })).status).toBe(201);
    await run(env.DB, `INSERT INTO hosting_poll_state (org_id, env, part, provider, polled_at, status, detail, last_ok_at, covered_from, covered_to, unavailable) VALUES
      (?, 'qa', 'web', 'vercel', '2026-10-07T05:00:00.000Z', 'failed', 'vercel deployments 403 — the credential lacks the permission this read needs', '2026-10-07T04:00:00.000Z', '2026-10-07T01:00:00.000Z', '2026-10-07T04:00:00.000Z',
       '[{"metric":"requests","reason":"needs Observability Plus"},{"metric":"bogus","reason":"x"},"junk"]'),
      (?, 'qa', 'api', 'vercel', '2026-10-07T05:00:00.000Z', 'ok', null, null, null, null, 'not json')`, ORG_A, ORG_A);
    const dto = (await send(web, "GET", `${A}/hosting`, me)).json as unknown as HostingSetupDTO;
    const [web0, api] = dto.environments[0].parts;
    expect(web0.last_poll).toEqual({
      at: "2026-10-07T05:00:00.000Z", status: "failed", detail: "vercel deployments 403 — the credential lacks the permission this read needs",
      last_ok_at: "2026-10-07T04:00:00.000Z", covered: { from: "2026-10-07T01:00:00.000Z", to: "2026-10-07T04:00:00.000Z" },
      unavailable: [{ metric: "requests", reason: "needs Observability Plus" }],
    });
    expect(web0.console_url).toBe("https://fake-host.test/personal/site");
    expect(api.last_poll).toBeNull();
  });
});

describe("the checklist", () => {
  it("no environment: one step", async () => {
    const dto = await getHostingSetup(await tenantCtx("AndresL230"), installEnv(), fakeProviders().providers);
    expect(dto.checklist).toEqual([{ id: "add_environment", title: "Add an environment", detail: expect.any(String), done: false, action: { kind: "add_environment" } }]);
    expect(dto.environments).toEqual([]);
    expect(dto.connections).toEqual([]);
  });

  it("walks a provider from unused to connected, configured and tested — only for what the parts use", async () => {
    await seedBareEnvironment(ORG_A, "staging", 0, "Staging");
    const { providers } = fakeProviders();
    const web = hostingTestApp(providers);
    const me = await ownerCookie();
    const ctx = await tenantCtx("AndresL230");
    const steps = async () => (await getHostingSetup(ctx, installEnv(), providers)).checklist;

    expect(ids(await steps())).toEqual([["add_environment", true], ["add_part:staging", false]]);
    expect((await steps())[1].action).toEqual({ kind: "add_part", env: "staging" });

    expect((await send(web, "PUT", `${A}/environments/staging/parts/api`, me, { provider: "render", settings: { service_id: "srv-a" } })).status).toBe(201);
    let s = await steps();
    expect(ids(s)).toEqual([["add_environment", true], ["add_part:staging", true], ["connect:render:", false]]);
    expect(s[2]).toMatchObject({ title: "Connect Fakender", detail: "Used by Staging › Api.", action: { kind: "connect", provider: "render", scope: "" } });

    await setSecret(ctx, "render", "", TOKEN);
    s = await steps();
    expect(ids(s)).toEqual([["add_environment", true], ["add_part:staging", true], ["connect:render:", true], ["configure:render:", false], ["test:render:", false]]);
    expect(s[3]).toMatchObject({ title: "Set the Fakender Owner ID", action: { kind: "configure", provider: "render", scope: "" } });
    expect(s[4]).toMatchObject({ title: "Test the Fakender connection", detail: expect.stringContaining("Not used successfully yet"), action: { kind: "test", provider: "render", scope: "" } });

    await setIntegrationConfig(ctx, "render", "", { owner_id: "own-1" });
    await recordSecretOutcome(ctx, "render", "", { ok: false, message: "render 401 — the credential is not valid", revealed: TOKEN });
    s = await steps();
    expect(s.find((i) => i.id === "configure:render:")).toMatchObject({ done: true, action: { kind: "none" } });
    expect(s.find((i) => i.id === "test:render:")).toMatchObject({ done: false, detail: "render 401 — the credential is not valid" });

    await recordSecretOutcome(ctx, "render", "", { ok: true });
    expect((await steps()).every((i) => i.done)).toBe(true);
    // A provider with a credential but no part adds no step.
    await setSecret(ctx, "vercel", "", TOKEN);
    expect((await steps()).some((i) => i.id.includes("vercel"))).toBe(false);
  });

  it("a part missing a required setting asks for it by name (a legacy frontend with only its check, here)", async () => {
    await seedBareEnvironment(ORG_A, "staging", 0, "Staging");
    await run(env.DB, `UPDATE org_environments SET worker_check = 'Workers Builds: x' WHERE org_id = ? AND key = 'staging'`, ORG_A);
    const ctx = await tenantCtx("AndresL230");
    const s = (await getHostingSetup(ctx, installEnv(), fakeProviders().providers)).checklist;
    expect(s.find((i) => i.id === "edit_part:staging/frontend")).toEqual({
      id: "edit_part:staging/frontend", title: "Set the Cloudflare Workers Worker name for Staging › Frontend",
      detail: "The Worker script's name, as Workers & Pages lists it.", done: false, action: { kind: "edit_part", env: "staging", part: "frontend" },
    });
  });

  it("is a pure function of its inputs (what the screen keys on is stable)", async () => {
    await seedOrgSettings();
    const ctx = await tenantCtx("AndresL230");
    const { providers } = fakeProviders();
    const parts = await listAllParts(ctx);
    const conns = await listConnections(ctx, installEnv(), providers);
    const a = buildChecklist([{ key: "staging", label: "staging" }, { key: "production", label: "production" }], parts, conns, providers, () => ({}));
    const b = buildChecklist([{ key: "staging", label: "staging" }, { key: "production", label: "production" }], parts, conns, providers, () => ({}));
    expect(a).toEqual(b);
  });
});

describe("gates and isolation", () => {
  it("GET /hosting is admin+; the provider catalogue is any member's; a token is refused", async () => {
    const member = await roleCookie("casey", "member");
    expect((await send(app, "GET", `${A}/hosting`, member, undefined, env as never)).json).toEqual({ error: "forbidden" });
    const cat = await send(app, "GET", `${A}/hosting/providers`, member, undefined, env as never);
    expect(cat.status).toBe(200);
    const providers = (cat.json as { providers: HostingProviderDTO[] }).providers;
    expect(providers.map((p) => p.id)).toEqual([...HOSTING_PROVIDERS]);
    expect(providers.find((p) => p.id === "cloudflare")).toMatchObject({ legacy_part_key: "frontend", credential_scope: "org" });
    expect(providers.find((p) => p.id === "railway")).toMatchObject({ legacy_part_key: "backend", credential_scope: "environment" });
    expect((await send(app, "GET", `${A}/hosting/providers`, member, undefined, env as never, { authorization: "Bearer x" })).status).toBe(403);
    expect((await send(app, "GET", `${A}/hosting`, await roleCookie("admin-user", "admin"), undefined, env as never)).status).toBe(200);
  });

  it("org B sees none of org A's parts or connections, and cannot write to A's environments through its own slug", async () => {
    await seedOrgSettings(); // org A
    const { providers } = fakeProviders();
    const web = hostingTestApp(providers);
    const ownerA = await ownerCookie();
    expect((await send(web, "PUT", `${A}/environments/staging/parts/web`, ownerA, { provider: "vercel", settings: { project: "a-site" } })).status).toBe(201);
    await setSecret(await tenantCtx("AndresL230"), "vercel", "", TOKEN);
    await ensureMember("boss", "owner", ORG_B);
    await ensureMember("bob", "member", ORG_B);
    const boss = await cookieFor("boss", { member: false });
    const bob = await cookieFor("bob", { member: false });

    const b = (await send(web, "GET", "/api/o/acme/hosting", boss)).json as unknown as HostingSetupDTO;
    expect(b.environments).toEqual([]);
    expect(b.connections).toEqual([]);
    expect(JSON.stringify(b)).not.toContain("a-site");
    const put = await send(web, "PUT", "/api/o/acme/environments/staging/parts/web", boss, { provider: "vercel", settings: { project: "b-site" } });
    expect([put.status, put.json?.error]).toEqual([404, "not_found"]);
    expect((await send(web, "DELETE", "/api/o/acme/environments/staging/parts/web", boss)).status).toBe(404);
    expect((await send(web, "POST", "/api/o/acme/hosting/vercel/disconnect", boss, {})).status).toBe(404);
    // Under A's slug, B's people are not members: the one 404.
    for (const who of [boss, bob]) expect((await send(web, "GET", `${A}/hosting`, who)).json).toEqual({ error: "not_found" });
    expect(await all(env.DB, `SELECT org_id, part_key FROM org_environment_parts`)).toEqual([{ org_id: ORG_A, part_key: "web" }]);
    expect(await all(env.DB, `SELECT org_id FROM org_secrets WHERE kind = 'vercel'`)).toEqual([{ org_id: ORG_A }]);
  });
});

describe("Org settings › Integrations expects a provider's credential once a stored part uses it", () => {
  it("adds one org-wide slot per used provider after Cloudflare — and nothing for an org without stored parts", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    const kinds = async () => (await (await call(me, "/integrations")).json() as IntegrationsListDTO).integrations.map((i) => [i.kind, i.scope, i.expected]);
    expect((await kinds()).map(([k, s]) => [k, s])).toEqual(SLOTS);
    const { providers } = fakeProviders();
    const web = hostingTestApp(providers);
    expect((await send(web, "PUT", `${A}/environments/staging/parts/web`, me, { provider: "vercel", settings: { project: "site" } })).status).toBe(201);
    expect((await send(web, "PUT", `${A}/environments/production/parts/web`, me, { provider: "vercel", settings: { project: "site" } })).status).toBe(201);
    expect((await send(web, "PUT", `${A}/environments/production/parts/api`, me, { provider: "render", settings: { service_id: "srv-a" } })).status).toBe(201);
    expect(await kinds()).toEqual([
      ["github_token", "", true], ["github_webhook", "hook_saplinglearn_sapling", true], ["cloudflare_analytics", "", true],
      ["vercel", "", true], ["render", "", true],
      ["railway", "staging", true], ["metrics_endpoint", "staging", true], ["railway", "production", true], ["metrics_endpoint", "production", true],
    ]);
    // The slot is writable through the Integrations routes like any org-wide kind.
    const set = await call(me, "/integrations/vercel", { method: "PUT", body: { secret: TOKEN } });
    expect(set.status).toBe(201);
  });
});
