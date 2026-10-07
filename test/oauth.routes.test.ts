import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { pkce } from "../src/auth/crypto";
import { registerClient, checkAuthorizeRequest, issueAuthorization, exchangeAuthorizationCode } from "../src/auth/oauth";
import { buildOAuthApp } from "../src/auth/oauth-routes";
import { app } from "../src/routes";
import { seedPerson, cookieFor } from "./helpers/persons";
import type { Env } from "../src/env";

import { platformCtx, tenantCtx, credentialOf, mintTokenFor, ORG_A, ORG_B, ensureMember } from "./helpers/tenant";
const REDIRECT = "http://localhost:4444/callback";
const bearer = (t: string) => new Request("https://example.com/mcp", { headers: { authorization: `Bearer ${t}` } });

async function oauthAccessToken(person: string): Promise<string> {
  await seedPerson(person);
  const c = await registerClient(platformCtx(), { client_name: "Claude Code", redirect_uris: [REDIRECT] }, Date.now());
  const { verifier, challenge } = await pkce();
  const check = await checkAuthorizeRequest(platformCtx(), new URLSearchParams({
    response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256",
  }), "https://example.com");
  if (!check.ok) throw new Error("expected ok");
  const { code } = await issueAuthorization(await tenantCtx(person), { client: c, params: check.params, nowMs: Date.now() });
  const t = await exchangeAuthorizationCode(platformCtx(), { code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: c.client_id, resource: null }, "https://example.com", Date.now());
  return t.access_token;
}

describe("bearer dispatch", () => {
  it("an OAuth access token and a canopy_mcp_ token both resolve to their person", async () => {
    const oat = await oauthAccessToken("oauth-user");
    expect(await credentialOf(bearer(oat))).toEqual({ handle: "oauth-user", orgId: ORG_A });
    await seedPerson("token-user");
    const { raw } = await mintTokenFor("token-user");
    expect(await credentialOf(bearer(raw))).toEqual({ handle: "token-user", orgId: ORG_A });
  });
  it("/mcp lets an OAuth access token through (not a 401)", async () => {
    const oat = await oauthAccessToken("oauth-user");
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${oat}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    expect(res.status).not.toBe(401);
  });
});

const form = (o: Record<string, string>) => ({
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString(),
});

describe("metadata endpoints", () => {
  it("serve both documents publicly with CORS, including the /mcp-suffixed form", async () => {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await SELF.fetch(`https://example.com${p}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      expect(((await r.json()) as { resource: string }).resource).toBe("https://example.com/mcp");
    }
    const as = await SELF.fetch("https://example.com/.well-known/oauth-authorization-server");
    expect(((await as.json()) as { token_endpoint: string }).token_endpoint).toBe("https://example.com/oauth/token");
    const pre = await SELF.fetch("https://example.com/oauth/token", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("POST /oauth/register", () => {
  it("201 with a client_id for a valid public client", async () => {
    const r = await SELF.fetch("https://example.com/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [REDIRECT] }),
    });
    expect(r.status).toBe(201);
    const b = (await r.json()) as Record<string, unknown>;
    expect(b).toMatchObject({ client_name: "Claude Code", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    expect(typeof b.client_id).toBe("string");
  });
  it("400 invalid_client_metadata on bad JSON, a bad redirect, or a body over 8 KB — writing nothing", async () => {
    const bodies = ["{nope", JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }), JSON.stringify({ redirect_uris: [REDIRECT], client_name: "x".repeat(9000) })];
    for (const body of bodies) {
      const r = await SELF.fetch("https://example.com/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe("invalid_client_metadata");
    }
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM oauth_clients`).first<{ n: number }>())?.n).toBe(0);
  });
  it("400 invalid_client_metadata when multi-byte content pushes the body over 8 KB in bytes, under 8 KB in characters", async () => {
    const body = JSON.stringify({ redirect_uris: [REDIRECT], client_name: "€".repeat(3000) }); // 3000 chars, ~9000 UTF-8 bytes
    expect(body.length).toBeLessThan(8192);
    const r = await SELF.fetch("https://example.com/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_client_metadata");
  });
  it("400 invalid_client_metadata on a declared content-length over 8 KB, before the body is even read", async () => {
    const r = await SELF.fetch("https://example.com/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "100000" },
      body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [REDIRECT] }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_client_metadata");
  });
});

describe("POST /oauth/token", () => {
  async function codeFor(person: string) {
    await seedPerson(person);
    const c = await registerClient(platformCtx(), { client_name: "Claude Code", redirect_uris: [REDIRECT] }, Date.now());
    const { verifier, challenge } = await pkce();
    const check = await checkAuthorizeRequest(platformCtx(), new URLSearchParams({
      response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256",
    }), "https://example.com");
    if (!check.ok) throw new Error("expected ok");
    const { code } = await issueAuthorization(await tenantCtx(person), { client: c, params: check.params, nowMs: Date.now() });
    return { c, verifier, code };
  }
  it("authorization_code then refresh_token, form-encoded; no-store; CORS", async () => {
    const { c, verifier, code } = await codeFor("oauth-user");
    const r = await SELF.fetch("https://example.com/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: c.client_id }));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const t = (await r.json()) as { access_token: string; refresh_token: string };
    const r2 = await SELF.fetch("https://example.com/oauth/token", form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: c.client_id }));
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { access_token: string }).access_token).not.toBe(t.access_token);
  });
  it("accepts a JSON body too", async () => {
    const { c, verifier, code } = await codeFor("oauth-user");
    const r = await SELF.fetch("https://example.com/oauth/token", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: c.client_id }),
    });
    expect(r.status).toBe(200);
  });
  it("standard errors: missing param, bad code, unsupported grant", async () => {
    const miss = await SELF.fetch("https://example.com/oauth/token", form({ grant_type: "authorization_code", code: "x" }));
    expect(miss.status).toBe(400);
    expect(((await miss.json()) as { error: string }).error).toBe("invalid_request");
    const bad = await SELF.fetch("https://example.com/oauth/token", form({ grant_type: "authorization_code", code: "x", code_verifier: "v", redirect_uri: REDIRECT, client_id: "c" }));
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_grant");
    const un = await SELF.fetch("https://example.com/oauth/token", form({ grant_type: "password" }));
    expect(((await un.json()) as { error: string }).error).toBe("unsupported_grant_type");
  });
});

describe("POST /oauth/revoke", () => {
  it("always 200, and a revoked access token stops working on /mcp", async () => {
    const oat = await oauthAccessToken("oauth-user");
    expect((await SELF.fetch("https://example.com/oauth/revoke", form({ token: oat }))).status).toBe(200);
    expect((await SELF.fetch("https://example.com/oauth/revoke", form({ token: "junk" }))).status).toBe(200);
    expect(await credentialOf(bearer(oat))).toBeNull();
  });
});

async function registered() {
  const c = await registerClient(platformCtx(), { client_name: "Claude <Code>", redirect_uris: [REDIRECT] }, Date.now());
  const { verifier, challenge } = await pkce();
  const qs = new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st-9", scope: "mcp" });
  return { c, verifier, qs };
}
const manual = (init: RequestInit = {}) => ({ redirect: "manual" as const, ...init });
const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
function consentForm(qs: URLSearchParams, csrf: string, decision: "allow" | "deny"): URLSearchParams {
  const f = new URLSearchParams(qs); f.set("csrf", csrf); f.set("decision", decision); return f;
}

describe("GET /oauth/authorize", () => {
  it("unknown client → error page (400), no redirect; hardened headers", async () => {
    const r = await SELF.fetch("https://example.com/oauth/authorize?client_id=nope&redirect_uri=https://evil.example/cb", manual());
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
  it("a bad parameter on a good client → redirect with invalid_request and state", async () => {
    const { qs } = await registered();
    qs.set("code_challenge_method", "plain");
    const r = await SELF.fetch(`https://example.com/oauth/authorize?${qs}`, manual());
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("state")).toBe("st-9");
  });
  it("signed out → the sign-in page and an oauth_pending cookie", async () => {
    const { qs } = await registered();
    const r = await SELF.fetch(`https://example.com/oauth/authorize?${qs}`, manual());
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Claude &lt;Code&gt;");
    expect(html).toContain(`href="/auth/login"`);
    expect(html).toContain(`href="/auth/google/login"`);
    expect(r.headers.get("set-cookie") ?? "").toContain("oauth_pending=");
  });
  it("escapes HTML-significant characters in the client name, including a bare quote", async () => {
    const c = await registerClient(platformCtx(), { client_name: "O'Brien <x>", redirect_uris: [REDIRECT] }, Date.now());
    const { challenge } = await pkce();
    const qs = new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    const r = await SELF.fetch(`https://example.com/oauth/authorize?${qs}`, manual());
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("O&#39;Brien &lt;x&gt;");
  });
  it("signed in → the consent page naming the app, the redirect host and the handle; form-action allows the redirect origin", async () => {
    const { qs } = await registered();
    const r = await SELF.fetch(`https://example.com/oauth/authorize?${qs}`, manual({ headers: { cookie: await cookieFor("oauth-user") } }));
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Claude &lt;Code&gt;");
    expect(html).toContain("localhost");
    expect(html).toContain("@oauth-user");
    expect(csrfOf(html)).not.toBe("");
    expect(r.headers.get("content-security-policy")).toContain("form-action 'self' http://localhost:4444");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST /oauth/authorize", () => {
  it("Allow → redirect with a code that exchanges for tokens; the whole flow ends at /mcp", async () => {
    const { c, verifier, qs } = await registered();
    const cookie = await cookieFor("oauth-user");
    const page = await (await SELF.fetch(`https://example.com/oauth/authorize?${qs}`, manual({ headers: { cookie } }))).text();
    const r = await SELF.fetch("https://example.com/oauth/authorize", manual({
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: consentForm(qs, csrfOf(page), "allow").toString(),
    }));
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe("st-9");
    const code = loc.searchParams.get("code")!;
    const t = await SELF.fetch("https://example.com/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: c.client_id }));
    const { access_token } = (await t.json()) as { access_token: string };
    expect(await credentialOf(bearer(access_token))).toEqual({ handle: "oauth-user", orgId: ORG_A });
  });
  it("Allow records the person's org on the grant and its code; a person in no org gets a 409 page and no grant", async () => {
    const allow = async (handle: string, o: Parameters<typeof cookieFor>[1] = {}) => {
      const { qs } = await registered();
      const cookie = await cookieFor(handle, o);
      const page = await (await SELF.fetch(`https://example.com/oauth/authorize?${qs}`, manual({ headers: { cookie } }))).text();
      return SELF.fetch("https://example.com/oauth/authorize", manual({
        method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: consentForm(qs, csrfOf(page), "allow").toString(),
      }));
    };
    await seedPerson("acme-user", { member: false });
    await ensureMember("acme-user", "member", ORG_B);
    expect((await allow("acme-user", { member: false })).status).toBe(302);
    expect((await allow("oauth-user")).status).toBe(302);
    const orgs = async (table: string) =>
      (await env.DB.prepare(`SELECT person, org_id FROM ${table} ORDER BY person`).all<{ person: string; org_id: string }>()).results;
    const expected = [{ person: "acme-user", org_id: ORG_B }, { person: "oauth-user", org_id: ORG_A }];
    expect(await orgs("oauth_grants")).toEqual(expected);
    expect(await orgs("oauth_codes")).toEqual(expected);

    // In no org: the GET is the "join an organization first" page — no form, so no CSRF value to post —
    // and a POST forged without one is the usual 403. (The picker cases: test/isolation.mcp.test.ts.)
    const { qs } = await registered();
    const page = await SELF.fetch(`https://example.com/oauth/authorize?${qs}`, manual({ headers: { cookie: await cookieFor("drifter", { member: false }) } }));
    expect(page.status).toBe(409);
    const html = await page.text();
    expect(html).toContain("Join an organization first");
    expect(html).not.toContain("<form");
    const r = await allow("drifter", { member: false });
    expect(r.status).toBe(403);
    expect(r.headers.get("location")).toBeNull();
    expect(await orgs("oauth_grants")).toEqual(expected);
  });
  it("Deny → access_denied, nothing granted", async () => {
    const { qs } = await registered();
    const cookie = await cookieFor("oauth-user");
    const page = await (await SELF.fetch(`https://example.com/oauth/authorize?${qs}`, manual({ headers: { cookie } }))).text();
    const r = await SELF.fetch("https://example.com/oauth/authorize", manual({
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: consentForm(qs, csrfOf(page), "deny").toString(),
    }));
    expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM oauth_grants`).first<{ n: number }>())?.n).toBe(0);
  });
  it("a forged CSRF value, another session's CSRF, or no session → 403 page, nothing granted", async () => {
    const { qs } = await registered();
    const mine = await cookieFor("oauth-user");
    const theirs = await cookieFor("other-user");
    const theirPage = await (await SELF.fetch(`https://example.com/oauth/authorize?${qs}`, manual({ headers: { cookie: theirs } }))).text();
    for (const [cookie, csrf] of [[mine, "forged"], [mine, csrfOf(theirPage)], ["", csrfOf(theirPage)]] as const) {
      const r = await SELF.fetch("https://example.com/oauth/authorize", manual({
        method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: consentForm(qs, csrf, "allow").toString(),
      }));
      expect(r.status).toBe(403);
      expect(r.headers.get("location")).toBeNull();
    }
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM oauth_grants`).first<{ n: number }>())?.n).toBe(0);
  });
});

describe("never a 500", () => {
  // A DB that throws on every prepare() stands in for an unexpected D1 failure —
  // register and revoke must both answer 503, never let the throw escape as Hono's
  // plain-text 500.
  const throwingEnv = { ...env, DB: { prepare() { throw new Error("d1 down"); } } } as unknown as Env;

  it("register: an unexpected DB throw is a 503 temporarily_unavailable, not a 500", async () => {
    const r = await buildOAuthApp().request("/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [REDIRECT] }),
    }, throwingEnv);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "temporarily_unavailable" });
  });

  it("revoke: an unexpected DB throw is a 503, not a 500", async () => {
    const r = await buildOAuthApp().request("/oauth/revoke", form({ token: "whatever" }), throwingEnv);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "temporarily_unavailable" });
  });

  it("authorize: an unexpected DB throw is a 503 error page, not a 500", async () => {
    const r = await buildOAuthApp().request("/oauth/authorize?client_id=x&redirect_uri=y", {}, throwingEnv);
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("finish this right now");
  });
});

describe("Settings › Connected apps routes", () => {
  it("lists the caller's grants and revokes only their own", async () => {
    await oauthAccessToken("oauth-user");
    await oauthAccessToken("other-user");
    const mine = await cookieFor("oauth-user");
    const list = (await (await app.request("/auth/oauth-grants", { headers: { cookie: mine } }, env)).json()) as { grants: { id: number; client_name: string }[] };
    expect(list.grants).toHaveLength(1);
    expect(list.grants[0].client_name).toBe("Claude Code");
    const other = (await env.DB.prepare(`SELECT id FROM oauth_grants WHERE person = 'other-user'`).first<{ id: number }>())!.id;
    expect((await app.request(`/auth/oauth-grants/${other}/revoke`, { method: "POST", headers: { cookie: mine } }, env)).status).toBe(404);
    expect((await app.request(`/auth/oauth-grants/abc/revoke`, { method: "POST", headers: { cookie: mine } }, env)).status).toBe(404);
    const r = await app.request(`/auth/oauth-grants/${list.grants[0].id}/revoke`, { method: "POST", headers: { cookie: mine } }, env);
    expect(await r.json()).toEqual({ ok: true });
    expect((await app.request("/auth/oauth-grants", {}, env)).status).toBe(401);
  });
});
