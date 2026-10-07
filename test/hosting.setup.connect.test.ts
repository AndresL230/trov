// Org settings › Hosting — CONNECTIONS (src/hosting/connections.ts, src/hosting/webhook.ts, src/hosting/routes.ts):
// the connection list's statuses, the install round trip (start → the provider → the callback), its refusals,
// Disconnect from Trov's side, the provider-side uninstall notice, and the Integrations page keeping an install
// row honest. Every provider with behaviour here is a FAKE (test/helpers/hosting-setup.ts) — the real ones are
// tested in their own suites — and every check that a credential did not leak looks for any 8-character piece.
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { ConnectStartDTO, HostingConnectionDTO, HostingTestDTO } from "@shared/hosting";
import worker from "../src/index";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { b64uDecode, hmacUnseal } from "../src/auth/crypto";
import { getIntegrationConfig, getSecret, getSecretMeta, recordSecretOutcome, setIntegrationConfig, setSecret } from "../src/data/secrets";
import { completeConnect, listConnections, startConnect } from "../src/hosting/connections";
import { HostingError } from "../src/hosting/http";
import { handleHostingWebhook } from "../src/hosting/webhook";
import { all, first, run } from "./helpers/db";
import { ownerCookie, roleCookie, seedOrgSettings } from "./helpers/integrations";
import {
  CLIENT_SECRET, FAKE_HOST, fakeProviders, hmacHex, hostingTestApp, installEnv, noInstallEnv, send, tokenEndpoint,
} from "./helpers/hosting-setup";
import { LONG_TOKEN, leakedFragments } from "./helpers/repo";
import { ORG_A, ORG_B, ensureMember, tenantCtx } from "./helpers/tenant";

const A = "/api/o/saplinglearn";
const PASTED = "pat_" + "Hq3Lm7Rt".repeat(6);
const exec = { waitUntil() {}, passThroughException() {} } as unknown as ExecutionContext;

afterEach(() => { vi.restoreAllMocks(); });

const rows = (orgId = ORG_A) => all<Record<string, unknown>>(env.DB,
  `SELECT provider, scope, method, external_id, account_id, account_label, status, connected_by, revoked_by, revoked_reason FROM org_hosting_connections WHERE org_id = ? ORDER BY provider, scope`, orgId);
const adminAudit = (action: string, orgId = ORG_A) => all<{ actor: string; target: string; detail: string }>(env.DB,
  `SELECT actor, target, detail FROM org_admin_audit WHERE org_id = ? AND action = ? ORDER BY id`, orgId, action);
const secretAudit = (orgId = ORG_A) => all<{ actor: string; action: string; target: string; detail: string }>(env.DB,
  `SELECT actor, action, target, detail FROM org_audit WHERE org_id = ? ORDER BY id`, orgId);
const secretCount = async (orgId = ORG_A) => (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM org_secrets WHERE org_id = ?`, orgId))!.n;

/** Every text a leak could hide in: the given texts, the audit trails, the connection rows, `last_error`s. */
async function everything(...texts: string[]): Promise<string> {
  const dump = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM org_audit`), env.DB.prepare(`SELECT * FROM org_admin_audit`),
    env.DB.prepare(`SELECT * FROM org_hosting_connections`), env.DB.prepare(`SELECT kind, scope, hint_last4, last_error FROM org_secrets`),
    env.DB.prepare(`SELECT * FROM org_integration_config`),
  ]);
  return [...texts, ...dump.map((d) => JSON.stringify(d.results))].join("\n");
}

/** A part on (fake) Vercel in staging, so the org USES the provider. */
async function vercelPart(web: ReturnType<typeof hostingTestApp>, cookie: string): Promise<void> {
  expect((await send(web, "PUT", `${A}/environments/staging/parts/web`, cookie, { provider: "vercel", settings: { project: "site" } })).status).toBe(201);
}

/** Start a connect through the route; returns the DTO, the nonce cookie and the sealed state. */
async function start(web: ReturnType<typeof hostingTestApp>, cookie: string, e: Env = installEnv()) {
  const r = await send(web, "POST", `${A}/hosting/vercel/connect`, cookie, undefined, e);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const dto = r.json as unknown as ConnectStartDTO;
  const setCookie = r.headers.get("set-cookie") ?? "";
  const nonce = /trov_hx=([^;]+)/.exec(setCookie)?.[1] ?? "";
  const state = new URL(dto.url).searchParams.get("state") ?? "";
  return { dto, setCookie, nonce, state };
}

const callback = (web: ReturnType<typeof hostingTestApp>, cookie: string, nonce: string | null, q: Record<string, string>, e: Env = installEnv()) =>
  web.request(`/hosting/vercel/callback?${new URLSearchParams(q)}`, { headers: { cookie: nonce === null ? cookie : `${cookie}; trov_hx=${nonce}` } }, e as unknown as Record<string, unknown>);

describe("the connection list", () => {
  it("one row per (provider, scope) a part uses or the org holds a credential for — each status by its rule", async () => {
    await seedOrgSettings();
    const { providers } = fakeProviders();
    const web = hostingTestApp(providers);
    const me = await ownerCookie();
    await vercelPart(web, me);
    const ctx = await tenantCtx("AndresL230");
    const e = installEnv({ CF_ANALYTICS_TOKEN: "cf_legacy_token_value_0000000000" });
    const list = async () => listConnections(ctx, e, providers);
    const byKey = (l: HostingConnectionDTO[]) => Object.fromEntries(l.map((c) => [`${c.provider}:${c.scope}`, c]));

    let l = byKey(await list());
    expect(Object.keys(l)).toEqual(["cloudflare:", "railway:staging", "railway:production", "vercel:"]);
    expect(l["vercel:"]).toMatchObject({ status: "not_connected", method: null, account: null, legacy_fallback: false, used_by: [{ env: "staging", part: "web" }], scope_label: null });
    // SaplingLearn's cut-over: a legacy Worker secret answers for Cloudflare (the list says so; it is not "connected").
    expect(l["cloudflare:"]).toMatchObject({ status: "not_connected", legacy_fallback: true, used_by: [{ env: "staging", part: "frontend" }, { env: "production", part: "frontend" }] });
    expect(l["railway:staging"]).toMatchObject({ scope_label: "staging", used_by: [{ env: "staging", part: "backend" }] });

    await setSecret(ctx, "vercel", "", PASTED);
    l = byKey(await list());
    expect(l["vercel:"]).toMatchObject({ status: "connected", method: "token", hint_last4: PASTED.slice(-4), connected_by: "AndresL230", last_error: null });
    await recordSecretOutcome(ctx, "vercel", "", { ok: false, message: `401 for ${PASTED}`, revealed: PASTED });
    l = byKey(await list());
    expect(l["vercel:"].status).toBe("error");
    expect(l["vercel:"].last_error).toBe("401 for [redacted]");

    // An unused provider with a credential is listed too (it can be disconnected without breaking anything).
    await setSecret(ctx, "render", "", PASTED);
    expect(byKey(await list())["render:"]).toMatchObject({ status: "connected", used_by: [] });

    // Revoked: a connection row that ended, with no credential behind it.
    await run(env.DB, `DELETE FROM org_secrets WHERE org_id = ? AND kind = 'vercel'`, ORG_A);
    await run(env.DB, `INSERT INTO org_hosting_connections (org_id, provider, scope, method, external_id, account_id, account_label, status, connected_by, connected_at, revoked_at, revoked_by, revoked_reason)
      VALUES (?, 'vercel', '', 'install', 'icfg_old', 'team_x', 'Team X', 'revoked', 'AndresL230', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', 'vercel', 'removed on Fakecel')`, ORG_A);
    expect(byKey(await list())["vercel:"]).toMatchObject({ status: "revoked", method: null, revoked_reason: "removed on Fakecel", account: { id: "team_x", label: "Team X" }, external_id: "icfg_old" });
    expect(leakedFragments(JSON.stringify(await list()), PASTED)).toEqual([]);
  });
});

describe("connect: start", () => {
  it("answers where to send the browser, with a sealed state for (org, slug, provider, person) and a nonce cookie bound to /hosting/<provider>/", async () => {
    await seedOrgSettings();
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers);
    const { dto, setCookie, nonce, state } = await start(web, await ownerCookie());
    expect(dto.method).toBe("install");
    expect(Date.parse(dto.expires_at) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(dto.url.startsWith("https://fake-host.test/integrations/trov-test/new?client_id=oac_fake_client")).toBe(true);
    expect(setCookie).toMatch(/trov_hx=[A-Za-z0-9_-]{20,}; Max-Age=600; Path=\/hosting\/vercel\/; HttpOnly; Secure; SameSite=Lax/);
    const opened = await hmacUnseal(state, "hosting-connect:test-cookie-secret");
    expect(opened).not.toBeNull();
    expect(JSON.parse(b64uDecode(opened!))).toMatchObject({ o: ORG_A, s: "saplinglearn", p: "vercel", h: "AndresL230", n: nonce });
    // The provider got the redirect URI (PUBLIC_ORIGIN) and the method's vars — never the client SECRET.
    const [args] = fakes.calls.authorize;
    expect(args.redirectUri).toBe("https://trov.test/hosting/vercel/callback");
    expect(args.vars).toEqual({ VERCEL_INTEGRATION_CLIENT_ID: "oac_fake_client", VERCEL_INTEGRATION_SLUG: "trov-test" });
    expect(leakedFragments(JSON.stringify(dto) + setCookie, CLIENT_SECRET)).toEqual([]);
  });

  it("refuses: no install method (409), not supported yet (409), not configured on this deployment (409), unknown (404), a member (403), a token (403)", async () => {
    const { providers } = fakeProviders();
    const web = hostingTestApp(providers);
    const me = await ownerCookie();
    const post = async (provider: string, e: Env = installEnv(), cookie = me, headers: Record<string, string> = {}) =>
      send(web, "POST", `${A}/hosting/${provider}/connect`, cookie, undefined, e, headers);
    expect((await post("render")).json).toMatchObject({ error: "not_installable" });
    expect((await post("railway")).json).toMatchObject({ error: "not_installable" });
    expect((await post("aws")).json).toMatchObject({ error: "not_available" });
    const unconfigured = await post("vercel", noInstallEnv());
    expect([unconfigured.status, unconfigured.json?.error]).toEqual([409, "not_configured"]);
    expect(unconfigured.headers.get("set-cookie")).toBeNull();
    expect((await post("nope")).status).toBe(404);
    expect((await post("vercel", installEnv(), await roleCookie("casey", "member"))).json).toEqual({ error: "forbidden" });
    expect((await post("vercel", installEnv(), me, { authorization: "Bearer x" })).status).toBe(403);
  });
});

describe("connect: the callback", () => {
  it("stores the token, the grant's config and the install row; audits it; redirects to the org's Hosting tab — and nothing echoes the token", async () => {
    await seedOrgSettings();
    const fakes = fakeProviders();
    const endpoint = tokenEndpoint();
    const web = hostingTestApp(fakes.providers, endpoint.fetch);
    const me = await ownerCookie();
    await vercelPart(web, me);
    const s = await start(web, me);
    const res = await callback(web, me, s.nonce, { code: "code-123", state: s.state, configurationId: "icfg_one", teamId: "team_acme", next: "https://fake-host.test/done" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/o/saplinglearn/#org/hosting?connected=vercel");
    expect(res.headers.get("set-cookie")).toMatch(/trov_hx=; Max-Age=0; Path=\/hosting\/vercel\//);
    expect(res.headers.get("cache-control")).toBe("no-store");

    // The exchange: through the fixed-host fetch, with the client secret, the same redirect URI, the callback's query.
    expect(endpoint.urls).toEqual([`https://${FAKE_HOST}/oauth/token`]);
    const [x] = fakes.calls.exchange;
    expect(x).toMatchObject({ code: "code-123", clientId: "oac_fake_client", clientSecret: CLIENT_SECRET, redirectUri: "https://trov.test/hosting/vercel/callback" });
    expect(x.query).toMatchObject({ configurationId: "icfg_one", teamId: "team_acme" });

    const ctx = await tenantCtx("AndresL230");
    expect((await getSecret(ctx, "vercel", ""))!.reveal()).toBe(LONG_TOKEN);
    expect(await getIntegrationConfig(ctx, "vercel", "")).toEqual({ team_id: "team_acme" });
    expect(await rows()).toEqual([{
      provider: "vercel", scope: "", method: "install", external_id: "icfg_one", account_id: "team_acme", account_label: "Acme Team",
      status: "active", connected_by: "AndresL230", revoked_by: null, revoked_reason: null,
    }]);
    expect((await adminAudit("hosting.connect")).map((a) => [a.actor, a.target, JSON.parse(a.detail)])).toEqual([
      ["AndresL230", "vercel", { provider: "vercel", method: "install", account: "Acme Team" }],
    ]);
    const conn = (await listConnections(ctx, installEnv(), fakes.providers)).find((c) => c.provider === "vercel")!;
    expect(conn).toMatchObject({ status: "connected", method: "install", external_id: "icfg_one", account: { id: "team_acme", label: "Acme Team" }, config: { team_id: "team_acme" } });
    const setup = await send(web, "GET", `${A}/hosting`, me);
    const all = await everything(res.headers.get("location")!, JSON.stringify(setup.json), JSON.stringify(conn));
    expect(leakedFragments(all, LONG_TOKEN)).toEqual([]);
    expect(leakedFragments(all, CLIENT_SECRET)).toEqual([]);
  });

  it("over a pasted token: the install's token replaces it (rotated), and the row says install", async () => {
    await seedOrgSettings();
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers, tokenEndpoint().fetch);
    const me = await ownerCookie();
    await setSecret(await tenantCtx("AndresL230"), "vercel", "", PASTED);
    const s = await start(web, me);
    expect((await callback(web, me, s.nonce, { code: "c", state: s.state })).headers.get("location")).toBe("/o/saplinglearn/#org/hosting?connected=vercel");
    const meta = await getSecretMeta(await tenantCtx("AndresL230"), "vercel", "");
    expect(meta).toMatchObject({ hint_last4: LONG_TOKEN.slice(-4) });
    expect(meta!.rotated_at).not.toBeNull();
    expect((await rows())[0]).toMatchObject({ method: "install", status: "active" });
  });

  it("every refusal is a redirect with a fixed code, writes nothing, and quotes nothing from the provider", async () => {
    await seedOrgSettings();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers, tokenEndpoint({ status: 400 }).fetch);
    const me = await ownerCookie();
    const s = await start(web, me);
    const loc = async (r: Response | Promise<Response>) => (await r).headers.get("location");

    expect(await loc(callback(web, me, s.nonce, { code: "c", state: s.state.slice(0, -2) + "xx" }))).toBe("/#org/hosting?connect_error=mismatch");
    expect(await loc(callback(web, me, s.nonce, { code: "c" }))).toBe("/#org/hosting?connect_error=mismatch");
    expect(await loc(callback(web, me, null, { code: "c", state: s.state }))).toBe("/o/saplinglearn/#org/hosting?connect_error=mismatch");
    expect(await loc(callback(web, me, "another-nonce", { code: "c", state: s.state }))).toBe("/o/saplinglearn/#org/hosting?connect_error=mismatch");
    expect(await loc(callback(web, await roleCookie("admin-user", "admin"), s.nonce, { code: "c", state: s.state }))).toBe("/o/saplinglearn/#org/hosting?connect_error=mismatch");
    expect(await loc(web.request(`/hosting/netlify/callback?${new URLSearchParams({ code: "c", state: s.state })}`, { headers: { cookie: `${me}; trov_hx=${s.nonce}` } }, installEnv() as never)))
      .toMatch(/connect_error=(mismatch|unknown_provider)/);
    expect(await loc(callback(web, me, s.nonce, { error: "access_denied", state: s.state }))).toBe("/o/saplinglearn/#org/hosting?connect_error=denied");
    expect(await loc(callback(web, me, s.nonce, { state: s.state }))).toBe("/o/saplinglearn/#org/hosting?connect_error=mismatch");
    expect(await loc(callback(web, me, s.nonce, { code: "c", state: s.state }, noInstallEnv()))).toBe("/o/saplinglearn/#org/hosting?connect_error=not_configured");

    // The upstream refuses AND echoes the request (code + client secret): a fixed code out, a scrubbed log line.
    expect(await loc(callback(web, me, s.nonce, { code: "code-XYZ-1234567", state: s.state }))).toBe("/o/saplinglearn/#org/hosting?connect_error=exchange_failed");
    const logged = err.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).toContain("hosting connect: exchange failed");
    expect(leakedFragments(logged, CLIENT_SECRET)).toEqual([]);
    expect(logged).not.toContain("code-XYZ-1234567");

    // Expired: the same state, ten minutes and a second later.
    const later = await completeConnect(installEnv(), {
      handle: "AndresL230", provider: "vercel", query: { code: "c", state: s.state }, cookieNonce: s.nonce, origin: "https://trov.test",
      now: Date.now() + 10 * 60_000 + 1000, providers: fakes.providers,
    });
    expect(later).toEqual({ location: "/o/saplinglearn/#org/hosting?connect_error=expired", ok: false, error: "expired" });

    // Demoted between the start and the callback: forbidden.
    await ensureMember("AndresL230", "member");
    expect(await loc(callback(web, me, s.nonce, { code: "c", state: s.state }))).toBe("/o/saplinglearn/#org/hosting?connect_error=forbidden");
    await ensureMember("AndresL230", "owner");

    expect(await secretCount()).toBe(0);
    expect(await rows()).toEqual([]);
    expect(await adminAudit("hosting.connect")).toEqual([]);
  });

  it("the callback is at the app root and reachable by a person in SEVERAL orgs (the one-org alias does not apply)", async () => {
    await ensureMember("AndresL230", "admin", ORG_B);
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers, tokenEndpoint().fetch);
    const me = await ownerCookie();
    const s = await start(web, me);
    expect((await callback(web, me, s.nonce, { code: "c", state: s.state })).headers.get("location")).toBe("/o/saplinglearn/#org/hosting?connected=vercel");
    expect(await rows(ORG_B)).toEqual([]);
    // The real app mounts it too (an unsealed state is a redirect, never the 409 org_required of the alias gate).
    const real = await app.request(`/hosting/vercel/callback?state=x&code=y`, { headers: { cookie: me } }, env);
    expect([real.status, real.headers.get("location")]).toEqual([302, "/#org/hosting?connect_error=mismatch"]);
  });
});

describe("disconnect", () => {
  async function installed(fakes = fakeProviders()) {
    await seedOrgSettings();
    const web = hostingTestApp(fakes.providers, tokenEndpoint().fetch);
    const me = await ownerCookie();
    await vercelPart(web, me);
    const s = await start(web, me);
    await callback(web, me, s.nonce, { code: "c", state: s.state });
    return { web, me, fakes };
  }

  it("removes the install on the provider's side, deletes the secret, marks the row revoked — one batch, audited", async () => {
    const { web, me, fakes } = await installed();
    const r = await send(web, "POST", `${A}/hosting/vercel/disconnect`, me, {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ upstream: "revoked", connection: { provider: "vercel", status: "revoked", revoked_reason: "disconnected in Trov", used_by: [{ env: "staging", part: "web" }] } });
    const [rv] = fakes.calls.revoke;
    expect(rv.secret.reveal()).toBe(LONG_TOKEN);
    expect(rv).toMatchObject({ externalId: "icfg_one", config: { team_id: "team_acme" } });
    expect(await secretCount()).toBe(0);
    expect((await rows())[0]).toMatchObject({ status: "revoked", revoked_by: "AndresL230", revoked_reason: "disconnected in Trov" });
    expect((await adminAudit("hosting.disconnect")).map((a) => JSON.parse(a.detail))).toEqual([{ provider: "vercel", method: "install", upstream: "revoked" }]);
    expect((await secretAudit()).filter((a) => a.action === "secret.delete").map((a) => [a.target, JSON.parse(a.detail).reason])).toEqual([["vercel:", "disconnected"]]);
    expect((await send(web, "POST", `${A}/hosting/vercel/disconnect`, me, {})).status).toBe(404);
  });

  it("a provider-side failure is logged scrubbed and does not stop the disconnect", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { web, me } = await installed(fakeProviders({ revoke: async ({ secret }) => { throw new HostingError(`refused token ${secret.reveal()}`); } }));
    const r = await send(web, "POST", `${A}/hosting/vercel/disconnect`, me);
    expect([r.status, r.json?.upstream]).toEqual([200, "failed"]);
    expect(await secretCount()).toBe(0);
    const logged = err.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).toContain("provider-side removal failed");
    expect(leakedFragments(logged + JSON.stringify(r.json), LONG_TOKEN)).toEqual([]);
  });

  it("a token connection just loses its secret; a bad scope is 400; a member is 403", async () => {
    await seedOrgSettings();
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers);
    const me = await ownerCookie();
    await setSecret(await tenantCtx("AndresL230"), "render", "", PASTED);
    expect((await send(web, "POST", `${A}/hosting/render/disconnect`, await roleCookie("casey", "member"), {})).status).toBe(403);
    expect((await send(web, "POST", `${A}/hosting/render/disconnect`, me, { scope: "staging" })).json).toMatchObject({ error: "invalid", field: "scope" });
    expect((await send(web, "POST", `${A}/hosting/render/disconnect`, me, { scope: "", other: 1 })).status).toBe(400);
    const r = await send(web, "POST", `${A}/hosting/render/disconnect`, me, { scope: "" });
    expect(r.json).toMatchObject({ upstream: "none", connection: { status: "not_connected" } });
    expect(fakes.calls.revoke).toEqual([]);
    expect(await secretCount()).toBe(0);
    expect(await rows()).toEqual([]);
  });
});

describe("the provider-side uninstall notice: POST /webhook/hosting/:provider", () => {
  async function seedInstall(orgId: string, handle: string, externalId: string): Promise<void> {
    await ensureMember(handle, "owner", orgId);
    await setSecret(await tenantCtx(handle, "owner", { orgId }), "vercel", "", orgId === ORG_A ? LONG_TOKEN : PASTED);
    await run(env.DB, `INSERT INTO org_hosting_connections (org_id, provider, scope, method, external_id, account_id, account_label, status, connected_by, connected_at)
      VALUES (?, 'vercel', '', 'install', ?, 'team_x', 'Team X', 'active', ?, '2026-10-01T00:00:00Z')`, orgId, externalId, handle);
  }
  const deliver = async (body: string, signature: string | null, providers = fakeProviders().providers, e: Env = installEnv()) =>
    handleHostingWebhook(new Request("https://trov.test/webhook/hosting/vercel", { method: "POST", body, headers: signature ? { "x-fake-signature": signature } : {} }), e, "vercel", providers);

  it("a bad or missing signature is the bare 401 and writes nothing; so is a deployment with no client secret", async () => {
    await seedInstall(ORG_A, "AndresL230", "icfg_a");
    const body = JSON.stringify({ type: "removed", id: "icfg_a" });
    for (const sig of [null, "00", await hmacHex("wrong-secret", body)]) {
      const r = await deliver(body, sig);
      expect([r.status, await r.json()]).toEqual([401, { error: "unauthorized" }]);
    }
    expect((await deliver(body, await hmacHex(CLIENT_SECRET, body), undefined, noInstallEnv())).status).toBe(401);
    expect(await secretCount()).toBe(1);
    expect((await rows())[0]).toMatchObject({ status: "active" });
    expect(await adminAudit("hosting.revoked")).toEqual([]);
  });

  it("a verified removal revokes the org holding that installation — and only it", async () => {
    await seedInstall(ORG_A, "AndresL230", "icfg_a");
    await seedInstall(ORG_B, "boss", "icfg_b");
    const body = JSON.stringify({ type: "removed", id: "icfg_a" });
    const r = await deliver(body, await hmacHex(CLIENT_SECRET, body));
    expect([r.status, await r.json()]).toEqual([200, { ok: true, revoked: 1 }]);
    expect(await secretCount(ORG_A)).toBe(0);
    expect((await rows(ORG_A))[0]).toMatchObject({ status: "revoked", revoked_by: "vercel", revoked_reason: "removed on Fakecel" });
    expect((await adminAudit("hosting.revoked")).map((a) => [a.actor, a.target, JSON.parse(a.detail)])).toEqual([
      ["system", "vercel", { provider: "vercel", method: "install", reason: "removed on Fakecel" }],
    ]);
    expect((await secretAudit()).map((a) => [a.actor, a.action, a.target, JSON.parse(a.detail).reason])).toEqual([
      ["AndresL230", "secret.set", "vercel:", undefined], ["system", "secret.delete", "vercel:", "removed on Fakecel"],
    ]);
    // Org B: its own installation, untouched.
    expect(await secretCount(ORG_B)).toBe(1);
    expect((await rows(ORG_B))[0]).toMatchObject({ status: "active", external_id: "icfg_b" });
    // The same notice again: nothing left to revoke.
    expect(await (await deliver(body, await hmacHex(CLIENT_SECRET, body))).json()).toEqual({ ok: true, revoked: 0 });
  });

  it("a verified notice about something else revokes nothing; bad JSON is 400; an oversized body is 413", async () => {
    await seedInstall(ORG_A, "AndresL230", "icfg_a");
    const other = JSON.stringify({ type: "deployment.created", id: "icfg_a" });
    expect(await (await deliver(other, await hmacHex(CLIENT_SECRET, other))).json()).toEqual({ ok: true, revoked: 0 });
    expect((await deliver("not json", await hmacHex(CLIENT_SECRET, "not json"))).status).toBe(400);
    const big = "x".repeat(262_145);
    expect((await deliver(big, await hmacHex(CLIENT_SECRET, big))).status).toBe(413);
    expect(await secretCount()).toBe(1);
  });

  it("through the Worker: an unknown provider and one with no notice are 404 — before any signature is read", async () => {
    for (const p of ["nope", "aws", "cloudflare", "railway"]) {
      const res = await worker.fetch(new Request(`https://trov.test/webhook/hosting/${p}`, { method: "POST", body: "{}" }), env as unknown as Env, exec);
      expect(res.status, p).toBe(404);
    }
    expect((await handleHostingWebhook(new Request("https://trov.test/webhook/hosting/render", { method: "POST", body: "{}" }), installEnv(), "render", fakeProviders().providers)).status).toBe(404);
  });
});

describe("the Integrations page keeps an install row honest", () => {
  it("a pasted token over an installed one supersedes the install — so an uninstall notice for the OLD installation deletes nothing", async () => {
    await seedOrgSettings();
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers, tokenEndpoint().fetch);
    const me = await ownerCookie();
    const s = await start(web, me);
    await callback(web, me, s.nonce, { code: "c", state: s.state });
    const rotated = await app.request(`${A}/integrations/vercel/rotate`, { method: "POST", headers: { cookie: me, "content-type": "application/json" }, body: JSON.stringify({ secret: PASTED }) }, env);
    expect(rotated.status).toBe(200);
    expect((await rows())[0]).toMatchObject({ status: "revoked", revoked_by: "AndresL230", revoked_reason: "replaced by a pasted token" });
    const conn = (await listConnections(await tenantCtx("AndresL230"), installEnv(), fakes.providers)).find((c) => c.provider === "vercel")!;
    expect(conn).toMatchObject({ status: "connected", method: "token", account: null, external_id: null });

    const body = JSON.stringify({ type: "removed", id: "icfg_one" });
    const r = await handleHostingWebhook(new Request("https://trov.test/webhook/hosting/vercel", { method: "POST", body, headers: { "x-fake-signature": await hmacHex(CLIENT_SECRET, body) } }), installEnv(), "vercel", fakes.providers);
    expect(await r.json()).toEqual({ ok: true, revoked: 0 });
    expect((await getSecret(await tenantCtx("AndresL230"), "vercel", ""))!.reveal()).toBe(PASTED);
    // Deleting it on the Integrations page after a fresh install supersedes that one too.
    const s2 = await start(web, me);
    await callback(web, me, s2.nonce, { code: "c", state: s2.state });
    expect((await app.request(`${A}/integrations/vercel`, { method: "DELETE", headers: { cookie: me } }, env)).status).toBe(200);
    expect((await rows())[0]).toMatchObject({ status: "revoked", revoked_reason: "credential deleted in Trov" });
  });
});

describe("test connection: POST /hosting/:provider/test", () => {
  it("Cloudflare runs its Integrations probe and records the outcome; the answer carries the connection", async () => {
    await seedOrgSettings();
    const ctx = await tenantCtx("AndresL230");
    await setSecret(ctx, "cloudflare_analytics", "", LONG_TOKEN);
    await setIntegrationConfig(ctx, "cloudflare_analytics", "", { account_id: "0123456789abcdef0123456789abcdef" });
    const seen: string[] = [];
    const cfFetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } }), { status: 200 });
    }) as typeof fetch;
    const web = hostingTestApp(fakeProviders().providers, cfFetch);
    const r = await send(web, "POST", `${A}/hosting/cloudflare/test`, await ownerCookie(), { env: "staging", part: "frontend" });
    expect(r.status).toBe(200);
    const dto = r.json as unknown as HostingTestDTO;
    expect(dto.ok).toBe(true);
    expect(dto.detail).toContain("Cloudflare answered");
    expect(dto.connection).toMatchObject({ provider: "cloudflare", status: "connected", last_error: null });
    expect(dto.connection.last_used_at).not.toBeNull();
    expect(seen).toEqual(["https://api.cloudflare.com/client/v4/graphql"]);
    expect(leakedFragments(JSON.stringify(r.json), LONG_TOKEN)).toEqual([]);
  });

  it("refuses: no credential (404 not_configured), a part of another provider (404), a scope a provider does not take (400), a member (403)", async () => {
    await seedOrgSettings();
    const web = hostingTestApp(fakeProviders().providers);
    const me = await ownerCookie();
    const t = (p: string, body: unknown, cookie = me) => send(web, "POST", `${A}/hosting/${p}/test`, cookie, body);
    expect((await t("vercel", {})).json).toMatchObject({ error: "not_configured" });
    expect((await t("vercel", { env: "staging", part: "frontend" })).status).toBe(404);
    expect((await t("vercel", { env: "staging" })).status).toBe(400);
    expect((await t("vercel", { scope: "staging" })).json).toMatchObject({ field: "scope" });
    expect((await t("railway", {})).json).toMatchObject({ field: "scope" });
    expect((await t("railway", { env: "staging", part: "backend", scope: "production" })).json).toMatchObject({ field: "scope" });
    expect((await t("railway", { env: "staging", part: "backend" })).json).toMatchObject({ error: "not_configured" }); // scope = the part's environment
    expect((await t("vercel", {}, await roleCookie("casey", "member"))).status).toBe(403);
  });
});
