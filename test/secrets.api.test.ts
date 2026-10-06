// canopy-multitenancy.md §10.5 "Write-only API" — /api/o/:slug/integrations, /repos, /environments
// (src/integrations/routes.ts): the gates, the write-only contract, the audit trail, Test connection.
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { IntegrationDTO, IntegrationsListDTO, OrgAuditDTO, OrgEnvironmentDTO, OrgRepoDTO } from "@shared/integrations";
import { orgSettingsApp } from "../src/integrations/routes";
import { githubAppTenantApp } from "../src/github-app/routes";
import { HOOK_A, SLOTS, call, ownerCookie, roleCookie, seedOrgSettings, slotPath } from "./helpers/integrations";
import { ORG_A, ORG_B, platformCtx } from "./helpers/tenant";
import { listAudit } from "../src/platform/repo";
import { seedInstallation } from "./helpers/github-app";

const TOKEN = "tok_" + "Q7w8E9r0".repeat(8);
const OTHER = "tok_" + "m1N2b3V4".repeat(8);
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const one = async (res: Response): Promise<IntegrationDTO> => (await json<{ integration: IntegrationDTO }>(res)).integration;
const audit = async (cookie: string) => (await json<{ audit: OrgAuditDTO[] }>(await call(cookie, "/integrations/audit"))).audit;
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

afterEach(() => { vi.restoreAllMocks(); });

describe("GET /integrations", () => {
  it("lists every expected integration, unconfigured, with the words the page shows — and no ciphertext", async () => {
    await seedOrgSettings();
    const res = await call(await ownerCookie(), "/integrations");
    expect(res.status).toBe(200);
    const body = await json<IntegrationsListDTO>(res);
    expect(body.secrets_available).toBe(true);
    expect(body.key_version).toBeNull();
    expect(body.integrations.map((i) => [i.kind, i.scope])).toEqual(SLOTS);
    for (const i of body.integrations) {
      expect(i).toMatchObject({ configured: false, expected: true, hint_last4: "", created_by: null, created_at: null, rotated_at: null, last_used_at: null, last_error: null, config: {} });
      expect(i.label.length).toBeGreaterThan(3);
      expect(i.description.length).toBeGreaterThan(20);
      expect(i.how_to.length).toBeGreaterThan(40);
      for (const forbidden of ["ciphertext", "iv", "key_version", "secret", "wrapped_key"]) expect(i).not.toHaveProperty(forbidden);
    }
    // The suite's GITHUB_WEBHOOK_SECRET still answers for the repo the legacy /webhook/github routes to.
    expect(body.integrations.map((i) => i.legacy_fallback)).toEqual([false, true, false, false, false, false, false]);
    const [gh, hook, cf, rw] = body.integrations;
    expect(gh).toMatchObject({ scope_type: "org", scope_label: null, webhook_url: null });
    expect(hook).toMatchObject({ scope_type: "repo", scope_label: "SaplingLearn/sapling", webhook_url: `https://trov.test/webhook/github/${HOOK_A}` });
    expect(cf.config_fields.map((f) => [f.key, f.required])).toEqual([["account_id", true]]);
    expect(rw).toMatchObject({ scope_type: "environment", scope_label: "staging" });
  });

  it("an org with no repo and no environment expects only the two org-wide integrations", async () => {
    const body = await json<IntegrationsListDTO>(await call(await ownerCookie(), "/integrations"));
    expect(body.integrations.map((i) => i.kind)).toEqual(["github_token", "cloudflare_analytics"]);
  });
});

describe("set / rotate / delete", () => {
  it("walks one secret through its life; every write answers the metadata row and is audited", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    const set = await call(me, "/integrations/github_token", { method: "PUT", body: { secret: TOKEN } });
    expect(set.status).toBe(201);
    const row = await one(set);
    expect(row).toMatchObject({ kind: "github_token", scope: "", configured: true, hint_last4: TOKEN.slice(-4), created_by: "AndresL230", rotated_at: null });
    expect(JSON.stringify(row)).not.toContain(TOKEN.slice(0, 8));

    const again = await call(me, "/integrations/github_token", { method: "PUT", body: { secret: OTHER } });
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ error: "already_configured" });

    const rotated = await call(me, "/integrations/github_token/rotate", { method: "POST", body: { secret: OTHER } });
    expect(rotated.status).toBe(200);
    const r2 = await one(rotated);
    expect(r2.hint_last4).toBe(OTHER.slice(-4));
    expect(r2.rotated_at).not.toBeNull();

    const list = await json<IntegrationsListDTO>(await call(me, "/integrations"));
    expect(list.key_version).toBe(1);
    expect(list.integrations[0]).toMatchObject({ kind: "github_token", configured: true, hint_last4: OTHER.slice(-4) });

    const del = await call(me, "/integrations/github_token", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await one(del)).toMatchObject({ kind: "github_token", configured: false, hint_last4: "" });
    expect((await call(me, "/integrations/github_token", { method: "DELETE" })).status).toBe(404);
    const missing = await call(me, "/integrations/github_token/rotate", { method: "POST", body: { secret: TOKEN } });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ error: "not_configured" });

    expect((await audit(me)).map((a) => [a.action, a.target, a.actor])).toEqual([
      ["secret.delete", "github_token:", "AndresL230"],
      ["secret.rotate", "github_token:", "AndresL230"],
      ["secret.set", "github_token:", "AndresL230"],
    ]);
  });

  it("scoped kinds need a scope the org has; an environment may even be called `config` or `rotate`", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    expect((await call(me, "/integrations/railway", { method: "PUT", body: { secret: TOKEN } })).status).toBe(404);
    const unknown = await call(me, "/integrations/railway/nope", { method: "PUT", body: { secret: TOKEN } });
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toMatchObject({ error: "unknown_scope" });
    expect((await call(me, "/integrations/github_webhook/hook_of_another_org", { method: "PUT", body: { secret: TOKEN } })).status).toBe(404);
    expect((await call(me, "/integrations/not_a_kind", { method: "PUT", body: { secret: TOKEN } })).status).toBe(404);
    expect((await call(me, "/integrations/github_token/staging", { method: "PUT", body: { secret: TOKEN } })).status).toBe(404);
    expect(await count("org_secrets")).toBe(0);

    expect(await one(await call(me, "/integrations/railway/staging", { method: "PUT", body: { secret: TOKEN } }))).toMatchObject({ kind: "railway", scope: "staging", configured: true });
    expect(await one(await call(me, `/integrations/github_webhook/${HOOK_A}`, { method: "PUT", body: { secret: OTHER } }))).toMatchObject({ kind: "github_webhook", scope: HOOK_A, configured: true });

    for (const key of ["config", "rotate"]) {
      expect((await call(me, `/environments/${key}`, { method: "PUT", body: { branch: "main" } })).status).toBe(201);
      expect(await one(await call(me, `/integrations/railway/${key}`, { method: "PUT", body: { secret: TOKEN } }))).toMatchObject({ scope: key, configured: true });
      expect(await one(await call(me, `/integrations/railway/${key}/rotate`, { method: "POST", body: { secret: OTHER } }))).toMatchObject({ scope: key, hint_last4: OTHER.slice(-4) });
    }
    const noSettings = await call(me, "/integrations/railway/config/config", { method: "PUT", body: { config: { x: "y" } } });
    expect(noSettings.status).toBe(400);
    expect(await json(noSettings)).toMatchObject({ error: "invalid_config", field: "config" });
  });

  it("validation errors name the field and never echo what was submitted", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    const bad: unknown[] = [
      { secret: ` ${TOKEN}` }, { secret: `${TOKEN}\n` }, { secret: "" }, { secret: 12345678 }, { secret: null }, {}, { secret: [TOKEN] },
      { secret: TOKEN + "x".repeat(4096) }, { token: TOKEN },
    ];
    for (const body of bad) {
      for (const [method, path] of [["PUT", "/integrations/github_token"], ["POST", "/integrations/github_token/rotate"]] as const) {
        const res = await call(me, path, { method, body });
        const text = await res.text();
        // rotate with nothing stored still validates first: the answer is 400, not 404
        expect([res.status, path]).toEqual([400, path]);
        expect(JSON.parse(text)).toMatchObject({ error: "invalid_secret", field: "secret" });
        expect(text).not.toContain(TOKEN.slice(0, 8));
      }
    }
    const notJson = await call(me, "/integrations/github_token", { method: "PUT", body: `secret=${TOKEN}` });
    expect(notJson.status).toBe(400);
    expect(await notJson.text()).not.toContain(TOKEN.slice(0, 8));
    const short = await call(me, `/integrations/github_webhook/${HOOK_A}`, { method: "PUT", body: { secret: "hunter2hunter2" } });
    expect(short.status).toBe(400);
    expect(await short.text()).not.toContain("hunter2");
    expect(await count("org_secrets")).toBe(0);
    expect(await count("org_audit")).toBe(0);
  });
});

describe("config and the org's data key", () => {
  it("stores Cloudflare's account id beside the secret, audited without the value's being needed", async () => {
    const me = await ownerCookie();
    const cfg = await call(me, "/integrations/cloudflare_analytics/config", { method: "PUT", body: { config: { account_id: ACCOUNT.toUpperCase() } } });
    expect(cfg.status).toBe(200);
    expect(await one(cfg)).toMatchObject({ kind: "cloudflare_analytics", configured: false, config: { account_id: ACCOUNT } });

    for (const config of [{ account_id: "not-an-id-" + TOKEN }, { account_id: 5 }, {}, { account_id: ACCOUNT, extra: TOKEN }, "x", null]) {
      const res = await call(me, "/integrations/cloudflare_analytics/config", { method: "PUT", body: { config } });
      const text = await res.text();
      expect(res.status).toBe(400);
      expect(JSON.parse(text)).toMatchObject({ error: "invalid_config" });
      expect(text).not.toContain(TOKEN.slice(0, 8));
    }
    const none = await call(me, "/integrations/github_token/config", { method: "PUT", body: { config: { a: "b" } } });
    expect(none.status).toBe(400);

    // `PUT /:kind { secret, config }` writes both in one batch.
    await env.DB.exec(`DELETE FROM org_integration_config`);
    const both = await call(me, "/integrations/cloudflare_analytics", { method: "PUT", body: { secret: TOKEN, config: { account_id: ACCOUNT } } });
    expect(both.status).toBe(201);
    expect(await one(both)).toMatchObject({ configured: true, config: { account_id: ACCOUNT } });
    const badBoth = await call(me, "/integrations/cloudflare_analytics/rotate", { method: "POST", body: { secret: OTHER } });
    expect(badBoth.status).toBe(200);
    const log = await audit(me);
    expect(log.map((a) => a.action)).toEqual(["secret.rotate", "integration.config", "secret.set", "integration.config"]);
    expect(log[1]).toMatchObject({ target: "cloudflare_analytics:", detail: { keys: ["account_id"] } });
  });

  it("rotate-key is the owner's: an admin is refused, the owner gets a new version", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    await call(me, "/integrations/github_token", { method: "PUT", body: { secret: TOKEN } });
    await call(me, "/integrations/railway/staging", { method: "PUT", body: { secret: OTHER } });
    const admin = await roleCookie("meilin", "admin");
    expect((await call(admin, "/integrations/rotate-key", { method: "POST" })).status).toBe(403);
    const res = await call(me, "/integrations/rotate-key", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rotated: true, key_version: 2, secrets: 2 });
    expect((await json<IntegrationsListDTO>(await call(me, "/integrations"))).key_version).toBe(2);
    expect((await audit(me))[0]).toMatchObject({ action: "key.rotate", target: "org_keys", actor: "AndresL230" });
    // An admin can do everything else.
    expect((await call(admin, "/integrations/github_token/rotate", { method: "POST", body: { secret: OTHER } })).status).toBe(200);
    expect((await audit(admin))[0]).toMatchObject({ action: "secret.rotate", actor: "meilin" });
  });

  it("answers 503 secrets_unavailable while TROV_KEK is unset or malformed — and stores nothing", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    for (const kek of ["", "not-a-key"]) {
      const broken = { ...env, TROV_KEK: kek };
      const res = await call(me, "/integrations/github_token", { method: "PUT", body: { secret: TOKEN }, env: broken });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "secrets_unavailable" });
      const list = await call(me, "/integrations", { env: broken });
      expect(list.status).toBe(200);
      expect((await json<IntegrationsListDTO>(list)).secrets_available).toBe(false);
    }
    expect(await count("org_secrets")).toBe(0);
    expect(await count("org_keys")).toBe(0);
    // A stored secret cannot be tested or rotated without the key; it can still be deleted.
    await call(me, "/integrations/github_token", { method: "PUT", body: { secret: TOKEN } });
    const broken = { ...env, TROV_KEK: "" };
    expect((await call(me, "/integrations/github_token/test", { method: "POST", env: broken })).status).toBe(503);
    expect((await call(me, "/integrations/github_token/rotate", { method: "POST", body: { secret: OTHER }, env: broken })).status).toBe(503);
    expect((await call(me, "/integrations/github_token", { method: "DELETE", env: broken })).status).toBe(200);
  });
});

describe("who may call it", () => {
  // One concrete request per route the two Org settings sub-apps register (src/integrations/routes.ts and the
  // GitHub App panel's, src/github-app/routes.ts).
  const REQUESTS: readonly (readonly [method: string, path: string, body?: unknown])[] = [
    ["GET", "/integrations"],
    ["GET", "/integrations/audit"],
    ["POST", "/integrations/rotate-key"],
    ["PUT", "/integrations/github_token", { secret: TOKEN }],
    ["PUT", "/integrations/railway/staging", { secret: TOKEN }],
    ["PUT", "/integrations/railway/staging/config", { config: {} }],
    ["POST", "/integrations/github_token/rotate", { secret: TOKEN }],
    ["POST", "/integrations/railway/staging/test"],
    ["DELETE", "/integrations/github_token"],
    ["DELETE", "/integrations/railway/staging"],
    ["GET", "/repos"],
    ["POST", "/repos", { repo_full_name: "acme/widgets" }],
    ["DELETE", `/repos/${HOOK_A}`],
    ["GET", "/environments"],
    ["PUT", "/environments", { order: ["production", "staging"] }],
    ["PUT", "/environments/preview", { branch: "preview" }],
    ["DELETE", "/environments/staging"],
    ["GET", "/github"],
    ["POST", "/github/install"],
    ["POST", "/github/installations/4242/refresh"],
    ["POST", "/github/installations/4242/disconnect"],
  ];
  const digest = async () => {
    const out: Record<string, unknown> = {};
    for (const t of ["org_secrets", "org_keys", "org_audit", "org_integration_config", "org_repos", "org_environments", "github_installations", "github_installation_repos", "org_admin_audit"]) {
      out[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
    }
    return JSON.stringify(out);
  };

  it("REQUESTS covers every route the sub-apps register", () => {
    const registered = [...orgSettingsApp.routes, ...githubAppTenantApp.routes].filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
    expect(registered.length).toBe(REQUESTS.length);
    for (const route of registered) {
      const [method, pattern] = route.split(" ");
      const re = new RegExp("^" + pattern.replace(/:[A-Za-z]+/g, "[^/]+") + "$");
      expect(REQUESTS.some(([m, p]) => m === method && re.test(p)), route).toBe(true);
    }
  });

  it("a member is refused on every integrations route and every write; nothing changes", async () => {
    await seedOrgSettings();
    await seedInstallation(ORG_A, 4242, [{ id: 1, full_name: "SaplingLearn/sapling" }]);
    await call(await ownerCookie(), "/integrations/github_token", { method: "PUT", body: { secret: OTHER } });
    const member = await roleCookie("sanaok", "member");
    const before = await digest();
    for (const [method, path, body] of REQUESTS) {
      const res = await call(member, path, { method, body });
      const readable = method === "GET" && (path === "/repos" || path === "/environments");
      expect([res.status, method, path]).toEqual([readable ? 200 : 403, method, path]);
      if (!readable) expect(await res.json()).toEqual({ error: "forbidden" });
    }
    expect(await digest()).toBe(before);
    // What a member does read carries no hook id.
    const repos = (await json<{ repos: OrgRepoDTO[] }>(await call(member, "/repos"))).repos;
    expect(repos).toMatchObject([{ id: null, webhook_url: null, repo_full_name: "SaplingLearn/sapling", is_primary: true }]);
  });

  it("an Authorization header is refused on every route — even the owner's, even beside a valid cookie", async () => {
    await seedOrgSettings();
    await seedInstallation(ORG_A, 4242, [{ id: 1, full_name: "SaplingLearn/sapling" }]);
    const me = await ownerCookie();
    const before = await digest();
    for (const [method, path, body] of REQUESTS) {
      for (const authorization of ["Bearer trov_mcp_whatever", "Basic Zm9vOmJhcg=="]) {
        const res = await call(me, path, { method, body, headers: { authorization } });
        expect([res.status, method, path]).toEqual([403, method, path]);
        expect(await res.json()).toMatchObject({ error: "forbidden" });
      }
    }
    expect(await digest()).toBe(before);
  });

  it("no session is 401; another org's slug and an unknown slug are the same 404", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    for (const [method, path, body] of REQUESTS) {
      expect((await call(null, path, { method, body })).status).toBe(401);
      for (const slug of ["acme", "no-such-org"]) {
        const res = await call(me, path, { method, body, slug });
        expect([res.status, slug, method, path]).toEqual([404, slug, method, path]);
        expect(await res.json()).toEqual({ error: "not_found" });
      }
    }
    expect(await count("org_secrets")).toBe(0);
  });
});

describe("Test connection", () => {
  interface Seen { url: string; method: string; headers: Record<string, string>; body: string; redirect?: string }
  const upstream = (respond: (req: Seen) => Response | Promise<Response>) => {
    const seen: Seen[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req: Seen = {
        url: String(input), method: init?.method ?? "GET", redirect: init?.redirect,
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
        body: typeof init?.body === "string" ? init.body : "",
      };
      seen.push(req);
      return respond(req);
    });
    return seen;
  };
  const test = async (me: string, kind: string, scope = "") =>
    json<{ ok: boolean; detail: string; integration: IntegrationDTO; error?: string }>(await call(me, `${slotPath(kind, scope)}/test`, { method: "POST" }));

  it("sends ONE request per kind, shaped like the poller's, and clears last_error on success", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    await call(me, "/integrations/github_token", { method: "PUT", body: { secret: TOKEN } });
    await call(me, "/integrations/cloudflare_analytics", { method: "PUT", body: { secret: TOKEN, config: { account_id: ACCOUNT } } });
    await call(me, "/integrations/railway/staging", { method: "PUT", body: { secret: TOKEN } });
    await call(me, "/integrations/metrics_endpoint/production", { method: "PUT", body: { secret: TOKEN } });
    await env.DB.exec(`UPDATE org_secrets SET last_error = 'an earlier failure'`);

    const seen = upstream((req) => {
      if (req.url === "https://api.github.com/repos/SaplingLearn/sapling") return Response.json({ full_name: "SaplingLearn/sapling" });
      if (req.url === "https://api.cloudflare.com/client/v4/graphql") return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } });
      if (req.url === "https://backboard.railway.com/graphql/v2") return Response.json({ data: { metrics: [] } });
      if (req.url === "https://api.example.com/api/internal/metrics") return Response.json({ active_users: { "24h": 1, "7d": 2, "30d": 3 } });
      return new Response("unexpected", { status: 500 });
    });

    const gh = await test(me, "github_token");
    expect(gh).toMatchObject({ ok: true, detail: "GitHub answered for SaplingLearn/sapling." });
    expect(gh.integration).toMatchObject({ last_error: null });
    expect(gh.integration.last_used_at).not.toBeNull();
    expect(seen.at(-1)).toMatchObject({ method: "GET", headers: { authorization: `Bearer ${TOKEN}` } });

    const cf = await test(me, "cloudflare_analytics");
    expect(cf).toMatchObject({ ok: true });
    const cfReq = seen.at(-1)!;
    expect(cfReq).toMatchObject({ method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    const cfBody = JSON.parse(cfReq.body) as { query: string; variables: Record<string, string> };
    expect(cfBody.query).toContain("workersInvocationsAdaptive");
    expect(cfBody.variables).toMatchObject({ a: ACCOUNT, s: "frontend-staging" });
    expect(Date.parse(cfBody.variables.to) - Date.parse(cfBody.variables.from)).toBe(3_600_000);

    const rw = await test(me, "railway", "staging");
    expect(rw).toMatchObject({ ok: true });
    const rwReq = seen.at(-1)!;
    expect(rwReq.headers["project-access-token"]).toBe(TOKEN);
    expect(rwReq.headers.authorization).toBeUndefined(); // never as a bearer
    expect((JSON.parse(rwReq.body) as { variables: Record<string, string> }).variables).toMatchObject({ e: "env-staging-id", s: "service-id" });

    const mx = await test(me, "metrics_endpoint", "production");
    expect(mx).toMatchObject({ ok: true });
    expect(seen.at(-1)).toMatchObject({ url: "https://api.example.com/api/internal/metrics", method: "GET", redirect: "manual", headers: { authorization: `Bearer ${TOKEN}` } });

    expect(seen.length).toBe(4);
    expect(await count("org_secrets WHERE last_error IS NOT NULL")).toBe(0);
    expect(await count("repo_metrics")).toBe(0); // a test writes no metric
  });

  it("a failure stores the scrubbed reason; fixing it clears it", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    await call(me, "/integrations/github_token", { method: "PUT", body: { secret: TOKEN } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    upstream(() => Response.json({ message: "Bad credentials" }, { status: 401 }));
    const failed = await test(me, "github_token");
    expect(failed).toMatchObject({ ok: false, detail: "github 401 for SaplingLearn/sapling — the token is not valid" });
    expect(failed.integration.last_error).toBe(failed.detail);
    expect(logged).toHaveBeenCalledWith("integration test failed", "github_token", "", failed.detail);
    vi.restoreAllMocks();
    upstream(() => Response.json({}));
    expect((await test(me, "github_token")).integration.last_error).toBeNull();
  });

  it("explains what is missing without calling anything", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    const seen = upstream(() => new Response("no", { status: 500 }));
    const none = await call(me, "/integrations/github_token/test", { method: "POST" });
    expect(none.status).toBe(404);
    expect(await none.json()).toMatchObject({ error: "not_configured" });

    await call(me, "/integrations/cloudflare_analytics", { method: "PUT", body: { secret: TOKEN } });
    expect(await test(me, "cloudflare_analytics")).toMatchObject({ ok: false, detail: "the Cloudflare account id is not set" });
    await env.DB.exec(`UPDATE org_environments SET railway_service_id = NULL, api_url = '' WHERE key = 'staging'`);
    await call(me, "/integrations/railway/staging", { method: "PUT", body: { secret: TOKEN } });
    await call(me, "/integrations/metrics_endpoint/staging", { method: "PUT", body: { secret: TOKEN } });
    expect(await test(me, "railway", "staging")).toMatchObject({ ok: false, detail: "the environment has no Railway service id" });
    expect(await test(me, "metrics_endpoint", "staging")).toMatchObject({ ok: false, detail: "the environment has no API URL" });
    // A stored api_url is re-checked at use: one that names a private address is never fetched.
    await env.DB.exec(`UPDATE org_environments SET api_url = 'https://169.254.169.254' WHERE key = 'staging'`);
    expect((await test(me, "metrics_endpoint", "staging")).detail).toMatch(/^API URL: that address is not reachable/);
    await env.DB.exec(`DELETE FROM org_repos`);
    await call(me, "/integrations/github_token", { method: "PUT", body: { secret: TOKEN } });
    expect(await test(me, "github_token")).toMatchObject({ ok: false, detail: "the org has no primary repository" });
    expect(seen.length).toBe(0);
  });

  it("the metrics endpoint counts only a 200 with the expected body, and never follows a redirect", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    await call(me, "/integrations/metrics_endpoint/staging", { method: "PUT", body: { secret: TOKEN } });
    const cases: [Response, RegExp][] = [
      [new Response(null, { status: 302, headers: { location: "https://evil.example/collect" } }), /HTTP 302 \(a redirect is never followed\)/],
      [Response.json({ active_users: { "24h": 1, "7d": 2, "30d": 3 } }, { status: 201 }), /HTTP 201/],
      [new Response("<html>", { status: 200 }), /the body is not JSON/],
      [Response.json({ users: 3 }), /no active_users object/],
      [Response.json({ active_users: { "24h": 1, "7d": "2", "30d": 3 } }), /active_users\.7d is not a whole number/],
    ];
    for (const [response, detail] of cases) {
      const seen = upstream(() => response);
      const res = await test(me, "metrics_endpoint", "staging");
      expect(res.ok).toBe(false);
      expect(res.detail).toMatch(detail);
      expect(seen.length).toBe(1); // exactly one request: the redirect was not followed
      vi.restoreAllMocks();
    }
  });

  it("a webhook secret has nothing to call: it reports the last verified delivery and the URL", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    const seen = upstream(() => new Response("no", { status: 500 }));
    expect((await call(me, `/integrations/github_webhook/${HOOK_A}/test`, { method: "POST", env: { ...env, GITHUB_WEBHOOK_SECRET: "" } })).status).toBe(404);
    await call(me, `/integrations/github_webhook/${HOOK_A}`, { method: "PUT", body: { secret: TOKEN } });
    const never = await test(me, "github_webhook", HOOK_A);
    expect(never.ok).toBe(false);
    expect(never.detail).toContain(`https://trov.test/webhook/github/${HOOK_A}`);
    expect(never.integration.last_error).toBeNull();
    await env.DB.exec(`UPDATE org_secrets SET last_used_at = '2026-10-06T10:00:00.000Z' WHERE kind = 'github_webhook'`);
    expect(await test(me, "github_webhook", HOOK_A)).toMatchObject({ ok: true, detail: `Last verified delivery at 2026-10-06T10:00:00.000Z. Payload URL: https://trov.test/webhook/github/${HOOK_A}` });
    expect(seen.length).toBe(0);
  });

  it("SaplingLearn's legacy Worker secret is listed as a fallback and can be tested until a value is stored", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    const legacy = { ...env, GITHUB_SERVICE_TOKEN: OTHER };
    const list = await json<IntegrationsListDTO>(await call(me, "/integrations", { env: legacy }));
    expect(list.integrations.map((i) => i.legacy_fallback)).toEqual([true, true, false, false, false, false, false]); // the token, and the legacy hook's test secret
    const seen = upstream(() => Response.json({}));
    const res = await call(me, "/integrations/github_token/test", { method: "POST", env: legacy });
    expect(await res.json()).toMatchObject({ ok: true, integration: { configured: false, legacy_fallback: true } });
    expect(seen[0].headers.authorization).toBe(`Bearer ${OTHER}`);
  });
});

describe("/repos", () => {
  const repos = async (cookie: string) => (await json<{ repos: OrgRepoDTO[] }>(await call(cookie, "/repos"))).repos;

  it("adds repositories with one primary, and hands the admin each webhook URL", async () => {
    const me = await ownerCookie();
    expect(await repos(me)).toEqual([]);
    const first = await call(me, "/repos", { method: "POST", body: { repo_full_name: "acme/widgets" } });
    expect(first.status).toBe(201);
    const a = (await json<{ repo: OrgRepoDTO }>(first)).repo;
    expect(a).toMatchObject({ repo_full_name: "acme/widgets", is_primary: true, legacy_hook: false, webhook_secret_configured: false, created_by: "AndresL230" });
    expect(a.id).toMatch(/^hook_[0-9a-f]{40}$/);
    expect(a.webhook_url).toBe(`https://trov.test/webhook/github/${a.id}`);

    const b = (await json<{ repo: OrgRepoDTO }>(await call(me, "/repos", { method: "POST", body: { repo_full_name: "acme/gadgets" } }))).repo;
    expect(b.is_primary).toBe(false);
    const dup = await call(me, "/repos", { method: "POST", body: { repo_full_name: "ACME/Widgets" } });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: "repo_exists" });

    // Promote the second: exactly one primary, always.
    const promoted = await call(me, "/repos", { method: "POST", body: { repo_full_name: "acme/gadgets", is_primary: true } });
    expect(promoted.status).toBe(200);
    expect((await repos(me)).map((r) => [r.repo_full_name, r.is_primary])).toEqual([["acme/gadgets", true], ["acme/widgets", false]]);

    for (const body of [{ repo_full_name: "no-slash" }, { repo_full_name: "a/b/c" }, { repo_full_name: 5 }, {}, { repo_full_name: "acme/x", is_primary: "yes" }, { repo_full_name: `acme/${TOKEN} x` }]) {
      const res = await call(me, "/repos", { method: "POST", body });
      const text = await res.text();
      expect(res.status).toBe(400);
      expect(text).not.toContain(TOKEN.slice(0, 8));
    }
    // The new repo's webhook secret is now an expected integration.
    const list = await json<IntegrationsListDTO>(await call(me, "/integrations"));
    expect(list.integrations.filter((i) => i.kind === "github_webhook").map((i) => i.scope_label)).toEqual(["acme/gadgets", "acme/widgets"]);
  });

  it("removing a repo removes its webhook secret in the same batch, audited; the primary goes last", async () => {
    const me = await ownerCookie();
    const a = (await json<{ repo: OrgRepoDTO }>(await call(me, "/repos", { method: "POST", body: { repo_full_name: "acme/widgets" } }))).repo;
    const b = (await json<{ repo: OrgRepoDTO }>(await call(me, "/repos", { method: "POST", body: { repo_full_name: "acme/gadgets" } }))).repo;
    await call(me, `/integrations/github_webhook/${b.id}`, { method: "PUT", body: { secret: TOKEN } });
    expect((await repos(me)).find((r) => r.id === b.id)!.webhook_secret_configured).toBe(true);

    const primary = await call(me, `/repos/${a.id}`, { method: "DELETE" });
    expect(primary.status).toBe(409);
    expect(await primary.json()).toMatchObject({ error: "primary_repo" });
    expect((await call(me, "/repos/hook_nope", { method: "DELETE" })).status).toBe(404);

    const gone = await call(me, `/repos/${b.id}`, { method: "DELETE" });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toMatchObject({ ok: true, removed_secrets: [`github_webhook:${b.id}`] });
    expect(await count("org_secrets")).toBe(0);
    expect((await audit(me))[0]).toMatchObject({ action: "secret.delete", target: `github_webhook:${b.id}`, detail: { reason: "repo_removed" } });
    expect((await call(me, `/repos/${a.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await repos(me)).toEqual([]);
  });

  it("is per org: another org's repo id is not found", async () => {
    await seedOrgSettings(ORG_B, "hook_of_org_b");
    const me = await ownerCookie();
    expect(await repos(me)).toEqual([]);
    expect((await call(me, "/repos/hook_of_org_b", { method: "DELETE" })).status).toBe(404);
    expect(await count("org_repos")).toBe(1);
  });
});

describe("/environments", () => {
  const envs = async (cookie: string) => (await json<{ environments: OrgEnvironmentDTO[] }>(await call(cookie, "/environments"))).environments;

  it("creates, updates field by field, and reorders", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    expect((await envs(me)).map((e) => [e.key, e.position])).toEqual([["staging", 0], ["production", 1]]);

    const created = await call(me, "/environments/preview", { method: "PUT", body: { branch: "preview", api_url: "https://api.preview.example.com", railway_environment_id: " " } });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      created: true, removed_secrets: [],
      environment: { key: "preview", position: 2, label: "preview", note: null, branch: "preview", api_url: "https://api.preview.example.com", health_path: "/", railway_environment_id: null, updated_by: "AndresL230" },
    });

    const updated = await call(me, "/environments/preview", { method: "PUT", body: { label: "Preview", worker: "frontend-preview" } });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ created: false, environment: { label: "Preview", worker: "frontend-preview", branch: "preview", api_url: "https://api.preview.example.com" } });

    const reordered = await call(me, "/environments", { method: "PUT", body: { order: ["preview", "staging", "production"] } });
    expect(reordered.status).toBe(200);
    expect((await envs(me)).map((e) => [e.key, e.position])).toEqual([["preview", 0], ["staging", 1], ["production", 2]]);
    for (const order of [["preview", "staging"], ["preview", "staging", "staging"], ["preview", "staging", "nope"], "preview", undefined]) {
      expect((await call(me, "/environments", { method: "PUT", body: { order } })).status).toBe(400);
    }
    // Any member reads them; only an admin writes.
    const member = await roleCookie("sanaok", "member");
    expect((await envs(member)).length).toBe(3);
    expect((await call(member, "/environments/preview", { method: "PUT", body: { label: "x" } })).status).toBe(403);
  });

  it("refuses a URL that is not https or names a private address, and never echoes it", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    const bad: [Record<string, unknown>, string][] = [
      [{ api_url: `http://api.example.com/${TOKEN}` }, "api_url"],
      [{ api_url: "https://127.0.0.1" }, "api_url"],
      [{ api_url: "https://169.254.169.254/latest" }, "api_url"],
      [{ api_url: "https://[::1]" }, "api_url"],
      [{ api_url: "https://db.internal" }, "api_url"],
      [{ api_url: `https://user:${TOKEN}@api.example.com` }, "api_url"],
      [{ api_url: `https://api.example.com/?token=${TOKEN}` }, "api_url"],
      [{ frontend_url: "ftp://example.com" }, "frontend_url"],
      [{ frontend_url: `not a url ${TOKEN}` }, "frontend_url"],
      [{ branch: "" }, "branch"],
      [{ branch: "has space" }, "branch"],
      [{ health_path: "health" }, "health_path"],
      [{ label: 7 }, "label"],
      [{ railway_service_id: "id with space" }, "railway_service_id"],
      [{ [TOKEN]: "x" }, "body"],
    ];
    for (const [body, field] of bad) {
      const res = await call(me, "/environments/staging", { method: "PUT", body });
      const text = await res.text();
      expect([res.status, field]).toEqual([400, field]);
      expect(JSON.parse(text)).toMatchObject({ error: "invalid", field });
      expect(text).not.toContain(TOKEN.slice(0, 8));
    }
    expect((await call(me, "/environments/Bad Key", { method: "PUT", body: { branch: "main" } })).status).toBe(400);
    expect((await call(me, "/environments/" + "k".repeat(33), { method: "PUT", body: { branch: "main" } })).status).toBe(400);
    expect((await call(me, "/environments/new-one", { method: "PUT", body: {} })).status).toBe(400); // a new environment needs a branch
    expect((await envs(me)).map((e) => e.api_url)).toEqual(["https://api.staging.example.com", "https://api.example.com"]);
  });

  it("deleting an environment deletes its railway / metrics secrets in the same batch, audited", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    for (const [kind, scope] of SLOTS) await call(me, slotPath(kind, scope), { method: "PUT", body: { secret: TOKEN } });
    expect(await count("org_secrets")).toBe(7);

    const res = await call(me, "/environments/staging", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await json<{ ok: boolean; removed_secrets: string[]; environments: OrgEnvironmentDTO[] }>(res);
    expect(body.removed_secrets).toEqual(["railway:staging", "metrics_endpoint:staging"]);
    expect(body.environments.map((e) => [e.key, e.position])).toEqual([["production", 0]]); // the gap is closed
    expect((await env.DB.prepare(`SELECT kind, scope FROM org_secrets ORDER BY kind, scope`).all()).results).toEqual([
      { kind: "cloudflare_analytics", scope: "" }, { kind: "github_token", scope: "" }, { kind: "github_webhook", scope: HOOK_A },
      { kind: "metrics_endpoint", scope: "production" }, { kind: "railway", scope: "production" },
    ]);
    expect((await audit(me)).slice(0, 2).map((a) => [a.action, a.target, a.detail.reason])).toEqual([
      ["secret.delete", "metrics_endpoint:staging", "environment_deleted"],
      ["secret.delete", "railway:staging", "environment_deleted"],
    ]);
    expect((await call(me, "/environments/staging", { method: "DELETE" })).status).toBe(404);
    expect((await json<IntegrationsListDTO>(await call(me, "/integrations"))).integrations.map((i) => i.scope)).toEqual(["", HOOK_A, "", "production", "production"]);
  });

  it("re-aiming api_url at another origin drops the metrics token that would be sent there", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    await call(me, "/integrations/metrics_endpoint/staging", { method: "PUT", body: { secret: TOKEN } });
    await call(me, "/integrations/railway/staging", { method: "PUT", body: { secret: TOKEN } });
    // Same origin (a path change, a label change): the token stays.
    const same = await json<{ removed_secrets: string[] }>(await call(me, "/environments/staging", { method: "PUT", body: { api_url: "https://api.staging.example.com/v2", label: "Staging" } }));
    expect(same.removed_secrets).toEqual([]);
    expect(await count("org_secrets")).toBe(2);
    const moved = await json<{ removed_secrets: string[] }>(await call(me, "/environments/staging", { method: "PUT", body: { api_url: "https://collector.example.net" } }));
    expect(moved.removed_secrets).toEqual(["metrics_endpoint:staging"]);
    expect((await env.DB.prepare(`SELECT kind FROM org_secrets`).all()).results).toEqual([{ kind: "railway" }]);
    expect((await audit(me))[0]).toMatchObject({ action: "secret.delete", target: "metrics_endpoint:staging", detail: { reason: "api_url_changed" } });
  });
});

// ── the repository / environment audit trail (org_admin_audit, merged into the page's history) ──
describe("repository and environment changes are audited", () => {
  const adminRows = async (orgId: string) => (await env.DB.prepare(`SELECT actor, action, target, detail FROM org_admin_audit WHERE org_id = ? ORDER BY id`).bind(orgId)
    .all<{ actor: string; action: string; target: string; detail: string }>()).results.map((r) => [r.action, r.target, JSON.parse(r.detail)]);

  it("every repo / environment write records who did what, in the batch that did it — and a refused write records nothing", async () => {
    const me = await ownerCookie();
    const post = (body: unknown) => call(me, "/repos", { method: "POST", body });
    const a = (await json<{ repo: OrgRepoDTO }>(await post({ repo_full_name: "acme/widgets" }))).repo;
    const b = (await json<{ repo: OrgRepoDTO }>(await post({ repo_full_name: "acme/gadgets" }))).repo;
    expect((await post({ repo_full_name: "acme/gadgets", is_primary: true })).status).toBe(200); // promote
    expect((await post({ repo_full_name: "acme/gadgets", is_primary: true })).status).toBe(200); // already primary: no change, no row
    expect((await post({ repo_full_name: "acme/gadgets" })).status).toBe(409);                    // refused
    await call(me, `/integrations/github_webhook/${a.id}`, { method: "PUT", body: { secret: "w".repeat(40) } });
    expect((await call(me, `/repos/${a.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(me, `/repos/${b.id}`, { method: "DELETE" })).status).toBe(200);

    expect((await call(me, "/environments/preview", { method: "PUT", body: { branch: "preview", api_url: "https://api.preview.example.com" } })).status).toBe(201);
    expect((await call(me, "/environments/preview", { method: "PUT", body: { label: "Preview" } })).status).toBe(200);
    expect((await call(me, "/environments/preview", { method: "PUT", body: { branch: "has space" } })).status).toBe(400); // refused
    expect((await call(me, "/environments/edge", { method: "PUT", body: { branch: "edge" } })).status).toBe(201);
    expect((await call(me, "/environments", { method: "PUT", body: { order: ["edge", "preview"] } })).status).toBe(200);
    expect((await call(me, "/environments/edge", { method: "DELETE" })).status).toBe(200);
    const member = await roleCookie("sanaok", "member");
    expect((await call(member, "/environments/preview", { method: "DELETE" })).status).toBe(403);

    expect(await adminRows(ORG_A)).toEqual([
      ["repo.add", "acme/widgets", { primary: true }],
      ["repo.add", "acme/gadgets", { primary: false }],
      ["repo.primary", "acme/gadgets", {}],
      ["repo.remove", "acme/widgets", { removed_secrets: [`github_webhook:${a.id}`] }],
      ["repo.remove", "acme/gadgets", { removed_secrets: [] }],
      ["environment.set", "preview", { created: true, fields: expect.arrayContaining(["branch", "api_url"]), removed_secrets: [] }],
      ["environment.set", "preview", { created: false, fields: ["label"], removed_secrets: [] }],
      ["environment.set", "edge", { created: true, fields: expect.any(Array), removed_secrets: [] }],
      ["environment.reorder", "environments", { order: ["edge", "preview"] }],
      ["environment.delete", "edge", { removed_secrets: [] }],
    ]);
    // A row says WHICH fields changed, never what to: no URL, no branch name.
    const raw = (await env.DB.prepare(`SELECT group_concat(detail) AS d FROM org_admin_audit`).first<{ d: string }>())!.d;
    expect(raw).not.toContain("example.com");
    expect((await env.DB.prepare(`SELECT DISTINCT actor FROM org_admin_audit`).all()).results).toEqual([{ actor: "AndresL230" }]);
  });

  it("GET /integrations/audit is ONE list — secret rows and settings rows, newest first, this org's only", async () => {
    await seedOrgSettings();
    await seedOrgSettings(ORG_B, "hook_b");
    await env.DB.prepare(`INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, 'bob-b', 'environment.set', 'b-only', '{}', '2099-01-01T00:00:00.000Z')`).bind(ORG_B).run();
    const me = await ownerCookie();
    await call(me, slotPath("railway", "staging"), { method: "PUT", body: { secret: TOKEN } });
    await call(me, "/environments/preview", { method: "PUT", body: { branch: "preview" } });
    await call(me, slotPath("github_token", ""), { method: "PUT", body: { secret: TOKEN } });
    await call(me, "/environments/staging", { method: "DELETE" });

    const log = await audit(me);
    expect(log.map((r) => [r.action, r.target])).toEqual([
      ["secret.delete", "railway:staging"],   // one batch: the secret it removed…
      ["environment.delete", "staging"],      // …then the removal itself
      ["secret.set", "github_token:"],
      ["environment.set", "preview"],
      ["secret.set", "railway:staging"],
    ]);
    expect(log.map((r) => r.id[0])).toEqual(["s", "a", "s", "a", "s"]);
    expect(new Set(log.map((r) => r.id)).size).toBe(5);
    expect(log.every((r) => r.actor === "AndresL230")).toBe(true);
    // A membership change is in the org's admin trail, but it is not this page's history.
    await env.DB.prepare(`INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, 'AndresL230', 'member.add', 'sanaok', '{}', '2099-01-01T00:00:00.000Z')`).bind(ORG_A).run();
    expect((await audit(me)).map((r) => r.action)).not.toContain("member.add");
    expect((await json<{ audit: OrgAuditDTO[] }>(await call(me, "/integrations/audit?limit=2"))).audit).toHaveLength(2);

    // The superadmin's audit page sees the same rows through its own merge.
    const platform = (await listAudit(platformCtx(), { orgSlug: "saplinglearn" })).map((r) => r.action);
    expect(platform).toEqual(expect.arrayContaining(["environment.delete", "environment.set", "secret.set", "secret.delete", "member.add"]));
  });
});
