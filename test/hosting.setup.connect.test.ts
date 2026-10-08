// Org settings › Hosting — CONNECTIONS (src/hosting/connections.ts, src/hosting/webhook.ts, src/hosting/routes.ts):
// the connection list's statuses, the install round trip (start → the provider → the callback), its refusals,
// Disconnect from Trov's side, the provider-side uninstall notice, Test connection ending a refused grant, and the
// Integrations page keeping an install row honest. Every provider with behaviour here is a FAKE
// (test/helpers/hosting-setup.ts) — the real ones are tested in their own suites — and every check that a
// credential did not leak looks for any 8-character piece.
//
// The property under test (issue #97, the GitHub App binding's guarantees): an installed connection is bound to
// ONE Trov org, for the signed-in admin who started it, from the browser that started it — the provider sees only
// a random state — and every refusal writes NOTHING and lands on a redirect, never JSON.
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { HOSTING_CONNECT_OUTCOMES, type ConnectStartDTO, type HostingConnectionDTO, type HostingTestDTO } from "@shared/hosting";
import worker from "../src/index";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { b64uDecode, hmacSeal, hmacUnseal } from "../src/auth/crypto";
import { getIntegrationConfig, getSecret, getSecretMeta, recordSecretOutcome, setIntegrationConfig, setSecret } from "../src/data/secrets";
import { ConnectionConflictError, bindConnection, completeConnect, connectReturnUrl, listConnections, startConnect } from "../src/hosting/connections";
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

/** What a refusal must leave untouched: every row a connection could write, in every org. */
async function writable(): Promise<string> {
  const dump = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM org_hosting_connections ORDER BY org_id, provider, scope`),
    env.DB.prepare(`SELECT org_id, kind, scope, hint_last4, created_at, rotated_at, last_error FROM org_secrets ORDER BY org_id, kind, scope`),
    env.DB.prepare(`SELECT * FROM org_integration_config ORDER BY org_id, kind, scope`),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM org_audit`), env.DB.prepare(`SELECT COUNT(*) AS n FROM org_admin_audit WHERE action LIKE 'hosting.%'`),
  ]);
  return JSON.stringify(dump.map((d) => d.results));
}

/** A part on (fake) Vercel in staging, so the org USES the provider. */
async function vercelPart(web: ReturnType<typeof hostingTestApp>, cookie: string): Promise<void> {
  expect((await send(web, "PUT", `${A}/environments/staging/parts/web`, cookie, { provider: "vercel", settings: { project: "site" } })).status).toBe(201);
}

/** Start a connect through the route; returns the DTO, the Set-Cookie, the sealed intent (the cookie's value) and the state the provider got. */
async function start(web: ReturnType<typeof hostingTestApp>, cookie: string, e: Env = installEnv()) {
  const r = await send(web, "POST", `${A}/hosting/vercel/connect`, cookie, undefined, e);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const dto = r.json as unknown as ConnectStartDTO;
  const setCookie = r.headers.get("set-cookie") ?? "";
  const intent = /trov_hx=([^;]+)/.exec(setCookie)?.[1] ?? "";
  const state = new URL(dto.url).searchParams.get("state") ?? "";
  return { dto, setCookie, intent, state };
}

/** The provider's return, as `session` (null: signed out) with the `trov_hx` intent (null: none). */
const callback = (web: ReturnType<typeof hostingTestApp>, session: string | null, intent: string | null, q: Record<string, string>, e: Env = installEnv(), provider = "vercel") =>
  web.request(`/hosting/${provider}/callback?${new URLSearchParams(q)}`, { headers: { cookie: [session, intent === null ? null : `trov_hx=${intent}`].filter(Boolean).join("; ") } }, e as unknown as Record<string, unknown>);

/** Where a return about SaplingLearn lands. */
const back = (outcome: string, provider: string | null = "vercel") => `/saplinglearn/?hosting=${outcome}${provider ? `&provider=${provider}` : ""}#org`;
const loc = async (r: Response | Promise<Response>): Promise<string> => {
  const res = await r;
  expect(res.status).toBe(302);
  expect(res.headers.get("content-type") ?? "").not.toContain("json");
  return res.headers.get("location")!;
};
const cleared = (res: Response) => expect(res.headers.get("set-cookie")).toMatch(/trov_hx=; Max-Age=0; Path=\/hosting\//);

/** Another org's ACTIVE install of the same installation (`icfg_one` — the token endpoint's default). */
async function seedOtherOrgInstall(externalId = "icfg_one"): Promise<void> {
  await ensureMember("boss", "owner", ORG_B);
  await setSecret(await tenantCtx("boss", "owner", { orgId: ORG_B }), "vercel", "", PASTED);
  await run(env.DB, `INSERT INTO org_hosting_connections (org_id, provider, scope, method, external_id, account_id, account_label, status, connected_by, connected_at)
    VALUES (?, 'vercel', '', 'install', ?, 'team_acme', 'Acme Team', 'active', 'boss', '2026-10-01T00:00:00Z')`, ORG_B, externalId);
}

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
    expect(l["vercel:"]).toMatchObject({ status: "not_connected", method: null, account: null, legacy_fallback: false, used_by: [{ env: "staging", part: "web" }], scope_label: null, manage_url: null });
    // SaplingLearn's cut-over: a legacy Worker secret answers for Cloudflare (the list says so; it is not "connected").
    expect(l["cloudflare:"]).toMatchObject({ status: "not_connected", legacy_fallback: true, used_by: [{ env: "staging", part: "frontend" }, { env: "production", part: "frontend" }] });
    expect(l["railway:staging"]).toMatchObject({ scope_label: "staging", used_by: [{ env: "staging", part: "backend" }], manage_url: null });

    await setSecret(ctx, "vercel", "", PASTED);
    l = byKey(await list());
    expect(l["vercel:"]).toMatchObject({ status: "connected", method: "token", hint_last4: PASTED.slice(-4), connected_by: "AndresL230", last_error: null, manage_url: "https://fake-host.test/tokens" });
    await recordSecretOutcome(ctx, "vercel", "", { ok: false, message: `401 for ${PASTED}`, revealed: PASTED });
    l = byKey(await list());
    expect(l["vercel:"].status).toBe("error");
    expect(l["vercel:"].last_error).toBe("401 for [redacted]");

    // An unused provider with a credential is listed too (it can be disconnected without breaking anything).
    await setSecret(ctx, "render", "", PASTED);
    expect(byKey(await list())["render:"]).toMatchObject({ status: "connected", used_by: [], manage_url: null });

    // Revoked: a connection row that ended, with no credential behind it — the reason is a CODE, worded by the DTO.
    await run(env.DB, `DELETE FROM org_secrets WHERE org_id = ? AND kind = 'vercel'`, ORG_A);
    await run(env.DB, `INSERT INTO org_hosting_connections (org_id, provider, scope, method, external_id, account_id, account_label, status, connected_by, connected_at, revoked_at, revoked_by, revoked_reason)
      VALUES (?, 'vercel', '', 'install', 'icfg_old', 'team_x', 'Team X', 'revoked', 'AndresL230', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', 'system', 'uninstalled')`, ORG_A);
    expect(byKey(await list())["vercel:"]).toMatchObject({
      status: "revoked", method: null, revoked_reason: "Removed on Fakecel", account: { id: "team_x", label: "Team X" }, external_id: "icfg_old",
      manage_url: "https://fake-host.test/personal/integrations",
    });
    for (const [code, words] of [["disconnected", "Disconnected in Trov"], ["superseded", "Replaced by a pasted token"], ["refused", "Fakecel refused the token — the grant was revoked or removed there"]]) {
      await run(env.DB, `UPDATE org_hosting_connections SET revoked_reason = ? WHERE org_id = ?`, code, ORG_A);
      expect(byKey(await list())["vercel:"].revoked_reason).toBe(words);
    }
    expect(leakedFragments(JSON.stringify(await list()), PASTED)).toEqual([]);
  });

  it("the schema: ONE active connection per installation across orgs; an ended row, or no installation id, never conflicts; the reason is a code", async () => {
    await ensureMember("boss", "owner", ORG_B);
    const ins = (org: string, ext: string | null, status = "active", reason: string | null = null) =>
      run(env.DB, `INSERT INTO org_hosting_connections (org_id, provider, scope, method, external_id, status, connected_by, connected_at, revoked_reason)
        VALUES (?, 'vercel', '', 'install', ?, ?, 'x', '2026-10-01T00:00:00Z', ?)`, org, ext, status, reason);
    await ins(ORG_A, "icfg_shared");
    await expect(ins(ORG_B, "icfg_shared")).rejects.toThrow(/UNIQUE constraint failed: org_hosting_connections/);
    await ins(ORG_B, "icfg_shared", "revoked", "uninstalled"); // an ended row of the same installation is fine
    await run(env.DB, `DELETE FROM org_hosting_connections`);
    await ins(ORG_A, null);
    await ins(ORG_B, null); // a grant with no installation id (Netlify's) claims nothing
    await expect(run(env.DB, `UPDATE org_hosting_connections SET status = 'revoked', revoked_reason = 'removed on Vercel' WHERE org_id = ?`, ORG_A)).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe("connect: start", () => {
  it("sends the provider ONLY a random state; the intent { org, slug, provider, person, state, exp } is sealed in an HttpOnly cookie on /hosting/", async () => {
    await seedOrgSettings();
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers);
    const { dto, setCookie, intent, state } = await start(web, await ownerCookie());
    expect(dto.method).toBe("install");
    expect(Date.parse(dto.expires_at) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(dto.url.startsWith("https://fake-host.test/integrations/trov-test/new?client_id=oac_fake_client")).toBe(true);
    expect(setCookie).toMatch(/^trov_hx=[A-Za-z0-9_.-]{40,}; Max-Age=600; Path=\/hosting\/; HttpOnly; Secure; SameSite=Lax$/);
    // The state the provider sees: 16 random bytes — nothing of Trov's (no org, slug, handle, nothing sealed).
    expect(state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(dto.url).not.toContain("saplinglearn"); // nor the org id, which contains it
    expect(dto.url).not.toContain("AndresL230");
    // The cookie: what the state answers for, sealed with the hosting-connect key.
    const opened = await hmacUnseal(intent, "hosting-connect:test-cookie-secret");
    expect(opened).not.toBeNull();
    const sealed = JSON.parse(b64uDecode(opened!));
    expect(sealed).toMatchObject({ o: ORG_A, s: "saplinglearn", p: "vercel", h: "AndresL230", state });
    expect(sealed.exp).toBe(Date.parse(dto.expires_at));
    // Two starts, two states.
    expect((await start(web, await ownerCookie())).state).not.toBe(state);
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

  it("an org already connected is not refused — a pasted token, an ended install, a LIVE install all start (the callback replaces it, as the GitHub App does)", async () => {
    await seedOrgSettings();
    const web = hostingTestApp(fakeProviders().providers);
    const me = await ownerCookie();
    await setSecret(await tenantCtx("AndresL230"), "vercel", "", PASTED);
    expect((await send(web, "POST", `${A}/hosting/vercel/connect`, me)).status).toBe(200); // a pasted token: an install supersedes it
    await run(env.DB, `INSERT INTO org_hosting_connections (org_id, provider, scope, method, external_id, status, connected_by, connected_at, revoked_at, revoked_by, revoked_reason)
      VALUES (?, 'vercel', '', 'install', 'icfg_old', 'revoked', 'AndresL230', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', 'system', 'uninstalled')`, ORG_A);
    expect((await send(web, "POST", `${A}/hosting/vercel/connect`, me)).status).toBe(200);
    await run(env.DB, `UPDATE org_hosting_connections SET status = 'active', revoked_at = NULL, revoked_by = NULL, revoked_reason = NULL WHERE org_id = ?`, ORG_A);
    const r = await send(web, "POST", `${A}/hosting/vercel/connect`, me);
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/trov_hx=/);
  });
});

describe("connect: the callback", () => {
  it("stores the token, the grant's config and the install row in one write; audits it; lands on Org settings with ?hosting=connected — and nothing echoes the token", async () => {
    await seedOrgSettings();
    const fakes = fakeProviders();
    const endpoint = tokenEndpoint();
    const web = hostingTestApp(fakes.providers, endpoint.fetch);
    const me = await ownerCookie();
    await vercelPart(web, me);
    const s = await start(web, me);
    const res = await callback(web, me, s.intent, { code: "code-123", state: s.state, configurationId: "icfg_one", teamId: "team_acme", next: "https://fake-host.test/done" });
    expect(await loc(res)).toBe(back("connected"));
    cleared(res);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

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
    expect((await secretAudit()).map((a) => [a.actor, a.action, a.target])).toEqual([
      ["AndresL230", "secret.set", "vercel:"], ["AndresL230", "integration.config", "vercel:"],
    ]);
    const conn = (await listConnections(ctx, installEnv(), fakes.providers)).find((c) => c.provider === "vercel")!;
    expect(conn).toMatchObject({
      status: "connected", method: "install", external_id: "icfg_one", account: { id: "team_acme", label: "Acme Team" }, config: { team_id: "team_acme" },
      manage_url: "https://fake-host.test/team_acme/integrations",
    });
    expect(fakes.calls.revoke).toEqual([]);
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
    expect(await loc(callback(web, me, s.intent, { code: "c", state: s.state }))).toBe(back("connected"));
    const meta = await getSecretMeta(await tenantCtx("AndresL230"), "vercel", "");
    expect(meta).toMatchObject({ hint_last4: LONG_TOKEN.slice(-4) });
    expect(meta!.rotated_at).not.toBeNull();
    expect((await rows())[0]).toMatchObject({ method: "install", status: "active" });
    expect((await secretAudit()).map((a) => a.action)).toEqual(["secret.set", "secret.rotate", "integration.config"]);
    expect(fakes.calls.revoke).toEqual([]);
  });

  it("every refusal is a redirect with a fixed code from the ONE vocabulary, spends the intent, writes nothing, and quotes nothing from the provider", async () => {
    await seedOrgSettings();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers, tokenEndpoint({ status: 400 }).fetch);
    const me = await ownerCookie();
    const s = await start(web, me);
    const other = await start(web, me);
    const before = await writable();

    // The intent cannot be read (none, tampered, sealed with another key): no org to go back to.
    expect(await loc(callback(web, me, null, { code: "c", state: s.state }))).toBe("/?hosting=expired");
    expect(await loc(callback(web, me, `${s.intent.slice(0, -3)}abc`, { code: "c", state: s.state }))).toBe("/?hosting=expired");
    const resealed = await hmacSeal(s.intent.slice(0, s.intent.lastIndexOf(".")), "hosting-connect:another-secret");
    expect(await loc(callback(web, me, resealed, { code: "c", state: s.state }))).toBe("/?hosting=expired");
    // The state: missing, wrong, or another start's.
    expect(await loc(callback(web, me, s.intent, { code: "c" }))).toBe(back("expired"));
    expect(await loc(callback(web, me, s.intent, { code: "c", state: "nope" }))).toBe(back("expired"));
    expect(await loc(callback(web, me, s.intent, { code: "c", state: other.state }))).toBe(back("expired"));
    // Another provider's callback for this intent; a provider Trov does not know.
    expect(await loc(callback(web, me, s.intent, { code: "c", state: s.state }, installEnv(), "netlify"))).toBe(back("expired", "netlify"));
    expect(await loc(callback(web, me, s.intent, { code: "c", state: s.state }, installEnv(), "nope"))).toBe(back("unknown_provider", null));
    // Someone else's browser session.
    expect(await loc(callback(web, await roleCookie("admin-user", "admin"), s.intent, { code: "c", state: s.state }))).toBe(back("wrong_person"));
    // The person declined; no code came back; the deployment lost its integration.
    expect(await loc(callback(web, me, s.intent, { error: "access_denied", state: s.state }))).toBe(back("denied"));
    expect(await loc(callback(web, me, s.intent, { state: s.state }))).toBe(back("exchange_failed"));
    expect(await loc(callback(web, me, s.intent, { code: "c", state: s.state }, noInstallEnv()))).toBe(back("not_configured"));

    // The upstream refuses AND echoes the request (code + client secret): a fixed code out, a scrubbed log line.
    const refused = await callback(web, me, s.intent, { code: "code-XYZ-1234567", state: s.state });
    expect(await loc(refused)).toBe(back("exchange_failed"));
    cleared(refused);
    const logged = err.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).toContain("hosting connect: exchange failed");
    expect(leakedFragments(logged, CLIENT_SECRET)).toEqual([]);
    expect(logged).not.toContain("code-XYZ-1234567");

    // Expired: the same intent, ten minutes and a second later.
    const later = await completeConnect(installEnv(), {
      handle: "AndresL230", provider: "vercel", query: { code: "c", state: s.state }, cookie: s.intent, origin: "https://trov.test",
      now: Date.now() + 10 * 60_000 + 1000, providers: fakes.providers,
    });
    expect(later).toEqual({ location: back("expired"), outcome: "expired" });

    // Demoted between the start and the callback; removed from the org.
    await ensureMember("AndresL230", "member");
    expect(await loc(callback(web, me, s.intent, { code: "c", state: s.state }))).toBe(back("not_admin"));
    await run(env.DB, `DELETE FROM memberships WHERE org_id = ? AND user_id = 'AndresL230'`, ORG_A);
    expect(await loc(callback(web, me, s.intent, { code: "c", state: s.state }))).toBe(back("not_admin"));
    await ensureMember("AndresL230", "owner");

    expect(await writable()).toBe(before);
    expect(fakes.calls.revoke).toEqual([]);
  });

  it("signed out: the provider's return lands on `/` — never the gate's 401 JSON — spends the intent and writes nothing", async () => {
    await seedOrgSettings();
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers, tokenEndpoint().fetch);
    const s = await start(web, await ownerCookie());
    const before = await writable();
    const res = await callback(web, null, s.intent, { code: "c", state: s.state });
    expect(await loc(res)).toBe("/");
    cleared(res);
    expect(await loc(callback(web, null, null, { code: "c", state: s.state }))).toBe("/");
    expect(fakes.calls.exchange).toEqual([]);
    expect(await writable()).toBe(before);
    // Through the real app: a public path, so the session gate's 401 never answers it.
    for (const cookie of [undefined, "session=garbage"]) {
      const real = await app.request(`/hosting/vercel/callback?state=x&code=y`, cookie ? { headers: { cookie } } : {}, env);
      expect([real.status, real.headers.get("location")]).toEqual([302, "/"]);
    }
  });

  it("never JSON, never a 500 for a human: every return is a redirect — the provider down included", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    const fakes = fakeProviders();
    const down = (async () => { throw new Error("the provider is down"); }) as typeof fetch;
    const web = hostingTestApp(fakes.providers, down);
    const s = await start(web, me);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const q of [
      {}, { state: s.state }, { code: "c" }, { error: "x", state: s.state }, { code: "c", state: "z" }, { code: "c", state: s.state, configurationId: "icfg_x" },
    ] as Record<string, string>[]) {
      for (const [session, intent] of [[me, s.intent], [me, null], [null, s.intent], [null, null], [me, "garbage"]] as [string | null, string | null][]) {
        for (const provider of ["vercel", "nope", "netlify"]) {
          const res = await callback(web, session, intent, q, installEnv(), provider);
          expect(res.status, `${provider} ${JSON.stringify(q)} ${!!session} ${intent}`).toBe(302);
          expect(res.headers.get("content-type") ?? "").not.toContain("json");
          expect(HOSTING_CONNECT_OUTCOMES.some((o) => res.headers.get("location") === "/" || res.headers.get("location")!.includes(`hosting=${o}`))).toBe(true);
        }
      }
    }
    // A D1 failure anywhere in it (the session lookup itself) is still a redirect.
    const broken = { ...installEnv(), DB: { prepare() { throw new Error("D1 down"); } } } as unknown as Env;
    const res = await callback(web, me, s.intent, { code: "c", state: s.state }, broken);
    expect([res.status, res.headers.get("location")]).toEqual([302, "/?hosting=failed"]);
    expect(await rows()).toEqual([]);
  });

  it("the callback is at the app root and reachable by a person in SEVERAL orgs; nothing else under /hosting/ escapes the one-org alias", async () => {
    await ensureMember("AndresL230", "admin", ORG_B);
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers, tokenEndpoint().fetch);
    const me = await ownerCookie();
    const s = await start(web, me);
    expect(await loc(callback(web, me, s.intent, { code: "c", state: s.state }))).toBe(back("connected"));
    expect(await rows(ORG_B)).toEqual([]);
    // The real app mounts it too (an unreadable intent is a redirect, never the 409 org_required of the alias gate).
    const real = await app.request(`/hosting/vercel/callback?state=x&code=y`, { headers: { cookie: me } }, env);
    expect([real.status, real.headers.get("location")]).toEqual([302, "/?hosting=expired"]);
    // Exactly the callback's shape is let past the alias: any other /hosting/ path meets it.
    for (const path of ["/hosting/vercel/other", "/hosting/vercel/callback/x", "/hosting/Vercel/callback"]) {
      expect((await app.request(path, { headers: { cookie: me } }, env)).status, path).toBe(409);
    }
  });
});

describe("connect: one org per installation, one install per org", () => {
  it("an installation another org holds is `taken` — even while that org is suspended; the new grant's TOKEN is handed back, never that org's installation", async () => {
    await seedOrgSettings();
    await seedOtherOrgInstall();
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers, tokenEndpoint().fetch);
    const me = await ownerCookie();
    const before = await writable();
    const s = await start(web, me);
    expect(await loc(callback(web, me, s.intent, { code: "c", state: s.state }))).toBe(back("taken"));
    expect(fakes.calls.revoke.map((r) => ({ externalId: r.externalId, token: r.secret.reveal(), config: r.config }))).toEqual([
      { externalId: null, token: LONG_TOKEN, config: { team_id: "team_acme" } },
    ]);
    await run(env.DB, `UPDATE orgs SET suspended_at = '2026-10-07T00:00:00Z', suspended_by = 'x' WHERE id = ?`, ORG_B);
    const s2 = await start(web, me);
    expect(await loc(callback(web, me, s2.intent, { code: "c", state: s2.state }))).toBe(back("taken"));
    await run(env.DB, `UPDATE orgs SET suspended_at = NULL, suspended_by = NULL WHERE id = ?`, ORG_B);
    expect(await writable()).toBe(before);
    expect((await getSecret(await tenantCtx("boss", "owner", { orgId: ORG_B }), "vercel", ""))!.reveal()).toBe(PASTED);
    // Once that org lets it go, this one may connect it.
    await run(env.DB, `UPDATE org_hosting_connections SET status = 'revoked', revoked_reason = 'disconnected' WHERE org_id = ?`, ORG_B);
    const s3 = await start(web, me);
    expect(await loc(callback(web, me, s3.intent, { code: "c", state: s3.state }))).toBe(back("connected"));
  });

  it("a lost race at the write (the unique index) is `taken` too — and the batch stores NOTHING: not the row, not the credential, not the config", async () => {
    await seedOrgSettings();
    await seedOtherOrgInstall("icfg_raced");
    const fakes = fakeProviders();
    const ctx = await tenantCtx("AndresL230");
    await setSecret(ctx, "vercel", "", PASTED); // a pasted token that must survive the failed bind
    const before = await writable();
    const grant = { accessToken: LONG_TOKEN, externalId: "icfg_raced", accountId: "team_acme", accountLabel: "Acme", config: { team_id: "team_acme" } };
    await expect(bindConnection(ctx, fakes.providers.vercel!, "install", grant)).rejects.toBeInstanceOf(ConnectionConflictError);
    expect(await writable()).toBe(before);
    expect((await getSecret(ctx, "vercel", ""))!.reveal()).toBe(PASTED);
    // The same bind with an installation nobody holds goes through, whole.
    await bindConnection(ctx, fakes.providers.vercel!, "install", { ...grant, externalId: "icfg_free" });
    expect((await getSecret(ctx, "vercel", ""))!.reveal()).toBe(LONG_TOKEN);
    expect((await rows())[0]).toMatchObject({ external_id: "icfg_free", status: "active" });
  });

  it("a DIFFERENT live install is REPLACED in one write — audited with `replaced_by` — and the OLD grant is removed on the provider's side with its own credential", async () => {
    await seedOrgSettings();
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers, tokenEndpoint().fetch);
    const me = await ownerCookie();
    const ctx = await tenantCtx("AndresL230");
    // The org is connected through another installation (the App on another account, in GitHub's words).
    await setSecret(ctx, "vercel", "", PASTED);
    await run(env.DB, `INSERT INTO org_hosting_connections (org_id, provider, scope, method, external_id, account_id, account_label, status, connected_by, connected_at)
      VALUES (?, 'vercel', '', 'install', 'icfg_other', 'team_other', 'Other', 'active', 'AndresL230', '2026-10-07T00:00:00Z')`, ORG_A);
    const s = await start(web, me);
    expect(await loc(callback(web, me, s.intent, { code: "c", state: s.state }))).toBe(back("connected"));
    // Upstream: the OLD installation, with the OLD credential — never the new token or the new installation.
    expect(fakes.calls.revoke.map((r) => ({ externalId: r.externalId, token: r.secret.reveal() }))).toEqual([{ externalId: "icfg_other", token: PASTED }]);
    expect(await rows()).toEqual([expect.objectContaining({ external_id: "icfg_one", account_id: "team_acme", status: "active", revoked_reason: null })]);
    expect((await getSecret(ctx, "vercel", ""))!.reveal()).toBe(LONG_TOKEN);
    const ended = await adminAudit("hosting.disconnect");
    expect(ended).toHaveLength(1);
    expect(JSON.parse(ended[0].detail)).toEqual({ provider: "vercel", method: "install", reason: "superseded", replaced: "icfg_other", replaced_by: "icfg_one" });
    expect(await adminAudit("hosting.connect")).toHaveLength(1);
    expect(leakedFragments(await everything(), PASTED)).toEqual([]);
    expect(leakedFragments(await everything(), LONG_TOKEN)).toEqual([]);
  });

  it("removing the replaced grant upstream is best effort — a failure is one scrubbed log line and the new connection stands; an old grant with no installation id loses only its credential", async () => {
    await seedOrgSettings();
    const fakes = fakeProviders({ revoke: async (a) => { throw new HostingError(`fakecel revoke 500: ${a.secret.reveal()}`); } });
    const web = hostingTestApp(fakes.providers, tokenEndpoint().fetch);
    const me = await ownerCookie();
    const ctx = await tenantCtx("AndresL230");
    await setSecret(ctx, "vercel", "", PASTED);
    // An OAuth-style row: no installation id, another account.
    await run(env.DB, `INSERT INTO org_hosting_connections (org_id, provider, scope, method, external_id, account_id, account_label, status, connected_by, connected_at)
      VALUES (?, 'vercel', '', 'oauth', NULL, 'team_other', 'Other', 'active', 'AndresL230', '2026-10-07T00:00:00Z')`, ORG_A);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = await start(web, me);
    expect(await loc(callback(web, me, s.intent, { code: "c", state: s.state }))).toBe(back("connected"));
    expect(fakes.calls.revoke.map((r) => ({ externalId: r.externalId, token: r.secret.reveal() }))).toEqual([{ externalId: null, token: PASTED }]);
    expect(await rows()).toEqual([expect.objectContaining({ external_id: "icfg_one", method: "install", status: "active" })]);
    expect((await getSecret(ctx, "vercel", ""))!.reveal()).toBe(LONG_TOKEN);
    const logged = errors.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).toMatch(/removing the replaced grant failed/);
    expect(leakedFragments(logged, PASTED)).toEqual([]);
    expect(leakedFragments(logged, LONG_TOKEN)).toEqual([]);
  });

  it("a replaced grant whose credential IS the new token is not removed upstream (it is the new connection)", async () => {
    await seedOrgSettings();
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers, tokenEndpoint().fetch);
    const me = await ownerCookie();
    await setSecret(await tenantCtx("AndresL230"), "vercel", "", LONG_TOKEN);
    await run(env.DB, `INSERT INTO org_hosting_connections (org_id, provider, scope, method, external_id, account_id, account_label, status, connected_by, connected_at)
      VALUES (?, 'vercel', '', 'install', 'icfg_other', 'team_other', 'Other', 'active', 'AndresL230', '2026-10-07T00:00:00Z')`, ORG_A);
    const s = await start(web, me);
    expect(await loc(callback(web, me, s.intent, { code: "c", state: s.state }))).toBe(back("connected"));
    expect(fakes.calls.revoke).toEqual([]);
    expect((await rows())[0]).toMatchObject({ external_id: "icfg_one", status: "active" });
  });

  it("the SAME installation again (a re-authorization) refreshes the connection — nothing is handed back", async () => {
    await seedOrgSettings();
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers, tokenEndpoint().fetch);
    const me = await ownerCookie();
    const s = await start(web, me);
    await setSecret(await tenantCtx("AndresL230"), "vercel", "", PASTED);
    await run(env.DB, `INSERT INTO org_hosting_connections (org_id, provider, scope, method, external_id, account_id, account_label, status, connected_by, connected_at)
      VALUES (?, 'vercel', '', 'install', 'icfg_one', 'team_acme', 'Acme Team', 'active', 'AndresL230', '2026-10-07T00:00:00Z')`, ORG_A);
    expect(await loc(callback(web, me, s.intent, { code: "c", state: s.state }))).toBe(back("connected"));
    expect(fakes.calls.revoke).toEqual([]);
    expect(await rows()).toHaveLength(1);
    expect((await getSecret(await tenantCtx("AndresL230"), "vercel", ""))!.reveal()).toBe(LONG_TOKEN);
  });

  it("no platform key: `secrets_unavailable`, nothing stored — and the grant nobody holds is handed back whole", async () => {
    await seedOrgSettings();
    const fakes = fakeProviders();
    const web = hostingTestApp(fakes.providers, tokenEndpoint().fetch);
    const me = await ownerCookie();
    const s = await start(web, me);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await loc(callback(web, me, s.intent, { code: "c", state: s.state }, installEnv({ TROV_KEK: "" })))).toBe(back("secrets_unavailable"));
    expect(fakes.calls.revoke.map((r) => r.externalId)).toEqual(["icfg_one"]);
    expect(await rows()).toEqual([]);
    expect(await secretCount()).toBe(0);
  });

  it("the return URL: the outcome in the QUERY, Org settings' canonical hash; no intent → the root", () => {
    expect(connectReturnUrl("acme", "taken", "vercel")).toBe("/acme/?hosting=taken&provider=vercel#org");
    expect(connectReturnUrl("acme", "unknown_provider", null)).toBe("/acme/?hosting=unknown_provider#org");
    expect(connectReturnUrl(null, "expired", "vercel")).toBe("/?hosting=expired");
  });
});

describe("disconnect", () => {
  async function installed(fakes = fakeProviders(), probe?: number) {
    await seedOrgSettings();
    const web = hostingTestApp(fakes.providers, tokenEndpoint({ probe }).fetch);
    const me = await ownerCookie();
    await vercelPart(web, me);
    const s = await start(web, me);
    expect(await loc(callback(web, me, s.intent, { code: "c", state: s.state }))).toBe(back("connected"));
    return { web, me, fakes };
  }

  it("removes the install on the provider's side, deletes the secret, marks the row revoked — one batch, audited", async () => {
    const { web, me, fakes } = await installed();
    const r = await send(web, "POST", `${A}/hosting/vercel/disconnect`, me, {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ upstream: "revoked", connection: { provider: "vercel", status: "revoked", revoked_reason: "Disconnected in Trov", used_by: [{ env: "staging", part: "web" }] } });
    const [rv] = fakes.calls.revoke;
    expect(rv.secret.reveal()).toBe(LONG_TOKEN);
    expect(rv).toMatchObject({ externalId: "icfg_one", config: { team_id: "team_acme" } });
    expect(await secretCount()).toBe(0);
    expect((await rows())[0]).toMatchObject({ status: "revoked", revoked_by: "AndresL230", revoked_reason: "disconnected" });
    expect((await adminAudit("hosting.disconnect")).map((a) => JSON.parse(a.detail))).toEqual([{ provider: "vercel", method: "install", upstream: "revoked" }]);
    expect((await secretAudit()).filter((a) => a.action === "secret.delete").map((a) => [a.target, JSON.parse(a.detail).reason])).toEqual([["vercel:", "disconnected"]]);
    expect((await send(web, "POST", `${A}/hosting/vercel/disconnect`, me, {})).status).toBe(404);
    // …and it may be connected again.
    expect((await send(web, "POST", `${A}/hosting/vercel/connect`, me)).status).toBe(200);
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

  it("from the provider's side, by Test connection: a 401 for an INSTALLED grant ends it as `system` — the credential deleted, the row revoked `refused`, audited", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { web, me, fakes } = await installed(fakeProviders(), 401);
    const r = await send(web, "POST", `${A}/hosting/vercel/test`, me, {});
    expect(r.status).toBe(200);
    const dto = r.json as unknown as HostingTestDTO;
    expect(dto.ok).toBe(false);
    // The REAL Vercel probe (Test connection reads the registry), against the part's project.
    expect(dto.detail).toBe("vercel project 401: Not authorized — the credential is not valid — Vercel no longer accepts the grant, so the connection was ended; connect it again");
    expect(dto.connection).toMatchObject({ status: "revoked", method: null, revoked_reason: "Fakecel refused the token — the grant was revoked or removed there", manage_url: "https://fake-host.test/team_acme/integrations" });
    expect(await secretCount()).toBe(0);
    expect((await rows())[0]).toMatchObject({ status: "revoked", revoked_by: "system", revoked_reason: "refused" });
    expect((await adminAudit("hosting.revoked")).map((a) => [a.actor, a.target, JSON.parse(a.detail)])).toEqual([
      ["system", "vercel", { provider: "vercel", method: "install", reason: "refused" }],
    ]);
    expect((await secretAudit()).at(-1)).toMatchObject({ actor: "system", action: "secret.delete", target: "vercel:" });
    expect(JSON.parse((await secretAudit()).at(-1)!.detail).reason).toBe("refused");
    expect(fakes.calls.revoke).toEqual([]); // the provider already let it go: nothing to remove there
    expect(leakedFragments(await everything(JSON.stringify(r.json)), LONG_TOKEN)).toEqual([]);
    // Nothing left to test.
    expect((await send(web, "POST", `${A}/hosting/vercel/test`, me, {})).json).toMatchObject({ error: "not_configured" });
  });

  it("…but never a pasted token's, and never on another refusal: those only record last_error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { web, me } = await installed(fakeProviders(), 403);
    const r = await send(web, "POST", `${A}/hosting/vercel/test`, me, {});
    expect(r.json).toMatchObject({ ok: false, connection: { status: "error", method: "install" } });
    expect((await rows())[0]).toMatchObject({ status: "active" });
    expect(await secretCount()).toBe(1);

    await run(env.DB, `DELETE FROM org_hosting_connections`);
    await run(env.DB, `DELETE FROM org_secrets`);
    await setSecret(await tenantCtx("AndresL230"), "vercel", "", PASTED);
    const web401 = hostingTestApp(fakeProviders().providers, tokenEndpoint({ probe: 401 }).fetch);
    const t = await send(web401, "POST", `${A}/hosting/vercel/test`, me, {});
    expect(t.json).toMatchObject({ ok: false, connection: { status: "error", method: "token" } });
    expect(String((t.json as { detail: string }).detail)).not.toContain("connection was ended");
    expect((await getSecret(await tenantCtx("AndresL230"), "vercel", ""))!.reveal()).toBe(PASTED);
    expect(await adminAudit("hosting.revoked")).toEqual([]);
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

  it("a verified removal ends the connection of the org holding that installation — and only it — as `system`, never naming the provider as a person", async () => {
    await seedInstall(ORG_A, "AndresL230", "icfg_a");
    await seedInstall(ORG_B, "boss", "icfg_b");
    const body = JSON.stringify({ type: "removed", id: "icfg_a" });
    const r = await deliver(body, await hmacHex(CLIENT_SECRET, body));
    expect([r.status, await r.json()]).toEqual([200, { ok: true, revoked: 1 }]);
    expect(await secretCount(ORG_A)).toBe(0);
    expect((await rows(ORG_A))[0]).toMatchObject({ status: "revoked", revoked_by: "system", revoked_reason: "uninstalled" });
    expect((await adminAudit("hosting.revoked")).map((a) => [a.actor, a.target, JSON.parse(a.detail)])).toEqual([
      ["system", "vercel", { provider: "vercel", method: "install", reason: "uninstalled" }],
    ]);
    expect((await secretAudit()).map((a) => [a.actor, a.action, a.target, JSON.parse(a.detail).reason])).toEqual([
      ["AndresL230", "secret.set", "vercel:", undefined], ["system", "secret.delete", "vercel:", "uninstalled"],
    ]);
    const conn = (await listConnections(await tenantCtx("AndresL230"), installEnv(), fakeProviders().providers)).find((c) => c.provider === "vercel")!;
    expect(conn).toMatchObject({ status: "revoked", revoked_reason: "Removed on Fakecel" });
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
    await callback(web, me, s.intent, { code: "c", state: s.state });
    const rotated = await app.request(`${A}/integrations/vercel/rotate`, { method: "POST", headers: { cookie: me, "content-type": "application/json" }, body: JSON.stringify({ secret: PASTED }) }, env);
    expect(rotated.status).toBe(200);
    expect((await rows())[0]).toMatchObject({ status: "revoked", revoked_by: "AndresL230", revoked_reason: "superseded" });
    const conn = (await listConnections(await tenantCtx("AndresL230"), installEnv(), fakes.providers)).find((c) => c.provider === "vercel")!;
    expect(conn).toMatchObject({ status: "connected", method: "token", account: null, external_id: null, manage_url: "https://fake-host.test/tokens" });

    const body = JSON.stringify({ type: "removed", id: "icfg_one" });
    const r = await handleHostingWebhook(new Request("https://trov.test/webhook/hosting/vercel", { method: "POST", body, headers: { "x-fake-signature": await hmacHex(CLIENT_SECRET, body) } }), installEnv(), "vercel", fakes.providers);
    expect(await r.json()).toEqual({ ok: true, revoked: 0 });
    expect((await getSecret(await tenantCtx("AndresL230"), "vercel", ""))!.reveal()).toBe(PASTED);
    // Deleting it on the Integrations page after a fresh install disconnects that one too.
    const s2 = await start(web, me);
    expect(await loc(callback(web, me, s2.intent, { code: "c", state: s2.state }))).toBe(back("connected"));
    expect((await app.request(`${A}/integrations/vercel`, { method: "DELETE", headers: { cookie: me } }, env)).status).toBe(200);
    expect((await rows())[0]).toMatchObject({ status: "revoked", revoked_reason: "disconnected" });
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
    expect(dto.connection).toMatchObject({ provider: "cloudflare", status: "connected", last_error: null, manage_url: "https://dash.cloudflare.com/profile/api-tokens" });
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

describe("completeConnect, directly", () => {
  it("nobody signed in: the browser goes to `/` and the provider is never asked anything", async () => {
    await seedOrgSettings();
    const fakes = fakeProviders();
    const { start: dto, cookie } = await startConnect(await tenantCtx("AndresL230"), installEnv(), "vercel", "https://trov.test", "saplinglearn", Date.now(), fakes.providers);
    const state = new URL(dto.url).searchParams.get("state")!;
    expect(await completeConnect(installEnv(), { handle: null, provider: "vercel", query: { code: "c", state }, cookie, origin: "https://trov.test", providers: fakes.providers }))
      .toEqual({ location: "/", outcome: null });
    expect(fakes.calls.exchange).toEqual([]);
  });
});
