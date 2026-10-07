import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { all, first, type DB } from "../src/db";
import { pkce, sha256Hex } from "../src/auth/crypto";
import { seedPerson } from "./helpers/persons";
import {
  oauthOrigin, mcpResource, protectedResourceMetadata, authorizationServerMetadata,
  isAllowedRedirectUri, redirectMatches, validateRegistration, registerClient, getClient, OAuthError,
  checkAuthorizeRequest, issueAuthorization, exchangeAuthorizationCode, resolveOAuthAccessToken,
  canonicalAuthorizeQuery, type RegisteredClient, refreshAccessToken, revokeOAuthToken, listGrants, revokeGrant, pruneOAuth, mcpUnauthorized,
} from "../src/auth/oauth";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");

describe("0029_oauth schema", () => {
  it("creates the four oauth tables", async () => {
    const rows = await all<{ name: string }>(env.DB,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'oauth_%' ORDER BY name`);
    expect(rows.map((r) => r.name)).toEqual(["oauth_clients", "oauth_codes", "oauth_grants", "oauth_tokens"]);
  });
});

describe("oauthOrigin", () => {
  it("forces https for public hosts and keeps http for local dev", () => {
    expect(oauthOrigin("http://canopy.saplinglearn.com/mcp")).toBe("https://canopy.saplinglearn.com");
    expect(oauthOrigin("http://localhost:8787/mcp")).toBe("http://localhost:8787");
    expect(oauthOrigin("http://127.0.0.1:8787/x")).toBe("http://127.0.0.1:8787");
  });
});

describe("metadata", () => {
  it("protected resource names /mcp and this origin as its authorization server", () => {
    expect(protectedResourceMetadata("https://c.test")).toEqual({
      resource: "https://c.test/mcp", authorization_servers: ["https://c.test"],
      scopes_supported: ["mcp"], bearer_methods_supported: ["header"],
    });
    expect(mcpResource("https://c.test")).toBe("https://c.test/mcp");
  });
  it("authorization server lists the endpoints, S256 only, public clients only", () => {
    const m = authorizationServerMetadata("https://c.test");
    expect(m).toEqual({
      issuer: "https://c.test",
      authorization_endpoint: "https://c.test/oauth/authorize",
      token_endpoint: "https://c.test/oauth/token",
      registration_endpoint: "https://c.test/oauth/register",
      revocation_endpoint: "https://c.test/oauth/revoke",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  });
});

describe("redirect URIs", () => {
  it("allows https and loopback http; refuses other http, fragments, junk", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:33418/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:5000/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:5000/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example/cb")).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai/cb#frag")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });
  it("https matches exactly; a loopback http redirect matches on any port (RFC 8252)", () => {
    const reg = ["http://localhost:1111/callback", "https://claude.ai/cb"];
    expect(redirectMatches(reg, "https://claude.ai/cb")).toBe(true);
    expect(redirectMatches(reg, "https://claude.ai/cb2")).toBe(false);
    expect(redirectMatches(reg, "http://localhost:2222/callback")).toBe(true);
    expect(redirectMatches(reg, "http://localhost:2222/other")).toBe(false);
    expect(redirectMatches(reg, "http://127.0.0.1:1111/callback")).toBe(false); // host must match
    expect(redirectMatches(["https://a.test:1/cb"], "https://a.test:2/cb")).toBe(false); // https: exact
  });
});

describe("validateRegistration", () => {
  const ok = { client_name: "Claude Code", redirect_uris: ["http://localhost:1/callback"] };
  it("accepts a minimal public client and defaults / trims / cuts the name", () => {
    expect(validateRegistration(ok)).toEqual({ client_name: "Claude Code", redirect_uris: ["http://localhost:1/callback"] });
    expect(validateRegistration({ redirect_uris: ok.redirect_uris }).client_name).toBe("Unnamed client");
    expect(validateRegistration({ ...ok, client_name: "  x  " }).client_name).toBe("x");
    expect(validateRegistration({ ...ok, client_name: "y".repeat(200) }).client_name).toHaveLength(80);
    expect(validateRegistration({ ...ok, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] })).toBeTruthy();
  });
  it.each([
    ["not an object", "nope"],
    ["array body", []],
    ["no redirect_uris", { client_name: "x" }],
    ["empty redirect_uris", { redirect_uris: [] }],
    ["six redirect_uris", { redirect_uris: Array.from({ length: 6 }, (_, i) => `http://localhost:${i + 1}/cb`) }],
    ["non-loopback http", { redirect_uris: ["http://evil.example/cb"] }],
    ["confidential client", { ...ok, token_endpoint_auth_method: "client_secret_basic" }],
    ["unsupported grant", { ...ok, grant_types: ["client_credentials"] }],
    ["unsupported response type", { ...ok, response_types: ["token"] }],
  ])("rejects %s with invalid_client_metadata", (_label, body) => {
    try { validateRegistration(body); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(OAuthError); expect((e as OAuthError).code).toBe("invalid_client_metadata"); expect((e as OAuthError).status).toBe(400); }
  });
});

describe("registerClient / getClient", () => {
  it("stores a client and reads it back with its redirect list", async () => {
    const c = await registerClient(env.DB, { client_name: "Claude Code", redirect_uris: ["http://localhost:1/callback"] }, NOW);
    expect(c.client_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await getClient(env.DB, c.client_id)).toEqual(c);
    expect((await first<{ created_at: string }>(env.DB, `SELECT created_at FROM oauth_clients WHERE client_id = ?`, c.client_id))?.created_at).toBe("2026-09-24T12:00:00.000Z");
    expect(await getClient(env.DB, "nope")).toBeNull();
  });
});

const ORIGIN = "https://trov.test";
const REDIRECT = "http://localhost:4444/callback";

async function client(): Promise<RegisteredClient> {
  return registerClient(env.DB, { client_name: "Claude Code", redirect_uris: [REDIRECT] }, NOW);
}
function authQuery(c: RegisteredClient, challenge: string, extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256", state: "st-1", ...extra,
  });
}
/** Register, consent as `person`, and return what a client holds after the redirect. */
async function authorized(person = "real-user", extra: Record<string, string> = {}) {
  await seedPerson(person);
  const c = await client();
  const { verifier, challenge } = await pkce();
  const check = await checkAuthorizeRequest(env.DB, authQuery(c, challenge, extra), ORIGIN);
  if (!check.ok) throw new Error("expected ok");
  const { code, grantId } = await issueAuthorization(env.DB, { client: c, params: check.params, person, nowMs: NOW });
  return { c, verifier, code, grantId };
}

describe("checkAuthorizeRequest", () => {
  it("accepts a well-formed request", async () => {
    const c = await client();
    const { challenge } = await pkce();
    const r = await checkAuthorizeRequest(env.DB, authQuery(c, challenge, { resource: `${ORIGIN}/mcp`, scope: "mcp" }), ORIGIN);
    expect(r).toEqual({ ok: true, client: c, params: { client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, state: "st-1", resource: `${ORIGIN}/mcp` } });
  });
  it("unknown client or unregistered redirect → an error PAGE, never a redirect", async () => {
    const c = await client();
    const { challenge } = await pkce();
    const unknown = await checkAuthorizeRequest(env.DB, authQuery({ ...c, client_id: "nope" }, challenge), ORIGIN);
    expect(unknown).toMatchObject({
      ok: false, kind: "page",
      message: "Trov doesn't recognise this app's registration. In Claude Code, run /mcp, choose trov → Clear authentication, then Authenticate again.",
    });
    const q = authQuery(c, challenge); q.set("redirect_uri", "https://evil.example/cb");
    expect(await checkAuthorizeRequest(env.DB, q, ORIGIN)).toMatchObject({ ok: false, kind: "page" });
  });
  it("loopback redirect matches on any port", async () => {
    const c = await client();
    const { challenge } = await pkce();
    const q = authQuery(c, challenge); q.set("redirect_uri", "http://localhost:9999/callback");
    const r = await checkAuthorizeRequest(env.DB, q, ORIGIN);
    expect(r.ok && r.params.redirect_uri).toBe("http://localhost:9999/callback");
  });
  it.each([
    ["response_type", { response_type: "token" }],
    ["plain PKCE", { code_challenge_method: "plain" }],
    ["short challenge", { code_challenge: "abc" }],
    ["foreign resource", { resource: "https://other.test/mcp" }],
    ["oversized state", { state: "s".repeat(1025) }],
  ])("%s → invalid_request redirect carrying state", async (_l, extra) => {
    const c = await client();
    const { challenge } = await pkce();
    const r = await checkAuthorizeRequest(env.DB, authQuery(c, challenge, extra), ORIGIN);
    expect(r).toMatchObject({ ok: false, kind: "redirect", redirect_uri: REDIRECT });
  });
  it("resource with trailing slash is the same resource; an unknown scope is ignored", async () => {
    const c = await client();
    const { challenge } = await pkce();
    const r = await checkAuthorizeRequest(env.DB, authQuery(c, challenge, { resource: `${ORIGIN}/mcp/`, scope: "claudeai offline_access" }), ORIGIN);
    expect(r.ok).toBe(true);
  });
  it("canonicalAuthorizeQuery keeps only the authorize keys, in a fixed order, skipping empties", () => {
    const q = new URLSearchParams({ state: "s", junk: "x", client_id: "c", response_type: "code", scope: "" });
    expect(canonicalAuthorizeQuery(q)).toBe("response_type=code&client_id=c&state=s");
  });
});

describe("code exchange", () => {
  it("swaps a code + verifier for a token pair that resolves to the person", async () => {
    const { c, verifier, code } = await authorized();
    const t = await exchangeAuthorizationCode(env.DB, { code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: c.client_id, resource: null }, ORIGIN, NOW + 1000);
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp" });
    expect(t.access_token.startsWith("trov_oat_")).toBe(true);
    expect(t.refresh_token.startsWith("trov_ort_")).toBe(true);
    expect(await resolveOAuthAccessToken(env.DB, t.access_token, NOW + 2000)).toEqual({ handle: "real-user" });
    // hashes only
    expect(await first(env.DB, `SELECT 1 AS x FROM oauth_tokens WHERE token_hash IN (?, ?)`, t.access_token, t.refresh_token)).toBeNull();
  });
  it("an access token issued before the rename (`canopy_oat_…`) still resolves until it expires", async () => {
    const { c, verifier, code } = await authorized();
    await exchangeAuthorizationCode(env.DB, { code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: c.client_id, resource: null }, ORIGIN, NOW + 1000);
    const grant = (await first<{ id: number }>(env.DB, `SELECT id FROM oauth_grants ORDER BY id DESC LIMIT 1`))!.id;
    const legacy = "canopy_oat_issued-before-the-rename-0123456789";
    await env.DB.prepare(`INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at) VALUES (?, ?, 'access', ?, ?)`)
      .bind(await sha256Hex(legacy), grant, new Date(NOW).toISOString(), new Date(NOW + 3_600_000).toISOString()).run();
    expect(await resolveOAuthAccessToken(env.DB, legacy, NOW + 2000)).toEqual({ handle: "real-user" });
    expect(await resolveOAuthAccessToken(env.DB, legacy, NOW + 3_600_001)).toBeNull();
  });
  it("a code works once", async () => {
    const { c, verifier, code } = await authorized();
    const req = { code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: c.client_id, resource: null };
    await exchangeAuthorizationCode(env.DB, req, ORIGIN, NOW + 1000);
    await expect(exchangeAuthorizationCode(env.DB, req, ORIGIN, NOW + 2000)).rejects.toMatchObject({ code: "invalid_grant" });
  });
  it("rejects an expired code, a wrong verifier, and a redirect/client/resource mismatch — and burns the code", async () => {
    const cases: Array<(a: Awaited<ReturnType<typeof authorized>>) => Parameters<typeof exchangeAuthorizationCode>[1]> = [
      (a) => ({ code: a.code, code_verifier: "x".repeat(43), redirect_uri: REDIRECT, client_id: a.c.client_id, resource: null }),
      (a) => ({ code: a.code, code_verifier: a.verifier, redirect_uri: "http://localhost:5555/callback", client_id: a.c.client_id, resource: null }),
      (a) => ({ code: a.code, code_verifier: a.verifier, redirect_uri: REDIRECT, client_id: "other", resource: null }),
      (a) => ({ code: a.code, code_verifier: a.verifier, redirect_uri: REDIRECT, client_id: a.c.client_id, resource: "https://other.test/mcp" }),
    ];
    for (const [i, make] of cases.entries()) {
      const a = await authorized(`p-case-${i}`);
      await expect(exchangeAuthorizationCode(env.DB, make(a), ORIGIN, NOW + 1000)).rejects.toMatchObject({ code: "invalid_grant" });
      const good = { code: a.code, code_verifier: a.verifier, redirect_uri: REDIRECT, client_id: a.c.client_id, resource: null };
      await expect(exchangeAuthorizationCode(env.DB, good, ORIGIN, NOW + 2000)).rejects.toMatchObject({ code: "invalid_grant" });
    }
    const late = await authorized("p-late");
    await expect(exchangeAuthorizationCode(env.DB, { code: late.code, code_verifier: late.verifier, redirect_uri: REDIRECT, client_id: late.c.client_id, resource: null }, ORIGIN, NOW + 61_000))
      .rejects.toMatchObject({ code: "invalid_grant" });
  });
  it("a code on a grant revoked before the exchange is refused", async () => {
    const a = await authorized();
    await env.DB.prepare(`UPDATE oauth_grants SET revoked_at = 't', revoked_reason = 'user' WHERE id = ?`).bind(a.grantId).run();
    await expect(exchangeAuthorizationCode(env.DB, { code: a.code, code_verifier: a.verifier, redirect_uri: REDIRECT, client_id: a.c.client_id, resource: null }, ORIGIN, NOW + 1000))
      .rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("resolveOAuthAccessToken", () => {
  it("expires after an hour, stops on a revoked grant, and throttles last_used_at", async () => {
    const a = await authorized();
    const t = await exchangeAuthorizationCode(env.DB, { code: a.code, code_verifier: a.verifier, redirect_uri: REDIRECT, client_id: a.c.client_id, resource: null }, ORIGIN, NOW);
    expect(await resolveOAuthAccessToken(env.DB, t.access_token, NOW + 1000)).toEqual({ handle: "real-user" });
    const used1 = (await first<{ last_used_at: string }>(env.DB, `SELECT last_used_at FROM oauth_grants WHERE id = ?`, a.grantId))!.last_used_at;
    expect(used1).toBe(new Date(NOW + 1000).toISOString());
    await resolveOAuthAccessToken(env.DB, t.access_token, NOW + 30_000); // inside the throttle: no write
    expect((await first<{ last_used_at: string }>(env.DB, `SELECT last_used_at FROM oauth_grants WHERE id = ?`, a.grantId))!.last_used_at).toBe(used1);
    expect(await resolveOAuthAccessToken(env.DB, t.access_token, NOW + 3_600_000)).toBeNull();
    await env.DB.prepare(`UPDATE oauth_grants SET revoked_at = 't' WHERE id = ?`).bind(a.grantId).run();
    expect(await resolveOAuthAccessToken(env.DB, t.access_token, NOW + 2000)).toBeNull();
    expect(await resolveOAuthAccessToken(env.DB, t.refresh_token, NOW + 2000)).toBeNull(); // a refresh token is never a bearer
    expect(await resolveOAuthAccessToken(env.DB, "canopy_oat_unknown", NOW)).toBeNull();
  });
  it("the throttled last_used_at bump is best-effort — a DB error there still resolves the handle", async () => {
    const a = await connected();
    const throwingDB = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.trim().startsWith("UPDATE oauth_grants")) throw new Error("d1 down");
            return Reflect.get(target, prop, receiver).call(target, sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as DB;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await resolveOAuthAccessToken(throwingDB, a.t.access_token, NOW + 1000)).toEqual({ handle: "real-user" });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("oauth last_used_at"));
    errSpy.mockRestore();
  });
});

async function connected(person = "real-user") {
  const a = await authorized(person);
  const t = await exchangeAuthorizationCode(env.DB, { code: a.code, code_verifier: a.verifier, redirect_uri: REDIRECT, client_id: a.c.client_id, resource: null }, ORIGIN, NOW);
  return { ...a, t };
}
const grantRow = (id: number) => first<{ revoked_at: string | null; revoked_reason: string | null }>(env.DB, `SELECT revoked_at, revoked_reason FROM oauth_grants WHERE id = ?`, id);

describe("refresh", () => {
  it("rotates: a new pair, the old access token keeps working until it expires, the idle window moves", async () => {
    const a = await connected();
    const r = await refreshAccessToken(env.DB, { refresh_token: a.t.refresh_token, client_id: a.c.client_id }, NOW + 10 * 86_400_000);
    expect(r.refresh_token).not.toBe(a.t.refresh_token);
    expect(await resolveOAuthAccessToken(env.DB, r.access_token, NOW + 10 * 86_400_000 + 1)).toEqual({ handle: "real-user" });
    const exp = await first<{ expires_at: string }>(env.DB, `SELECT expires_at FROM oauth_tokens WHERE kind = 'refresh' AND rotated_at IS NULL`);
    expect(exp?.expires_at).toBe(new Date(NOW + 100 * 86_400_000).toISOString());
  });
  it("reuse within 60 s (concurrent sessions) → another fresh pair, grant untouched", async () => {
    const a = await connected();
    await refreshAccessToken(env.DB, { refresh_token: a.t.refresh_token, client_id: a.c.client_id }, NOW + 1000);
    const again = await refreshAccessToken(env.DB, { refresh_token: a.t.refresh_token, client_id: a.c.client_id }, NOW + 30_000);
    expect(await resolveOAuthAccessToken(env.DB, again.access_token, NOW + 31_000)).toEqual({ handle: "real-user" });
    expect((await grantRow(a.grantId))?.revoked_at).toBeNull();
  });
  it("reuse after 60 s → the whole grant is revoked (reason 'reuse') and its tokens stop", async () => {
    const a = await connected();
    const fresh = await refreshAccessToken(env.DB, { refresh_token: a.t.refresh_token, client_id: a.c.client_id }, NOW + 1000);
    await expect(refreshAccessToken(env.DB, { refresh_token: a.t.refresh_token, client_id: a.c.client_id }, NOW + 62_000)).rejects.toMatchObject({ code: "invalid_grant" });
    expect((await grantRow(a.grantId))?.revoked_reason).toBe("reuse");
    expect(await resolveOAuthAccessToken(env.DB, fresh.access_token, NOW + 63_000)).toBeNull();
    await expect(refreshAccessToken(env.DB, { refresh_token: fresh.refresh_token, client_id: a.c.client_id }, NOW + 64_000)).rejects.toMatchObject({ code: "invalid_grant" });
  });
  it("revoked grant's refresh token → invalid_grant, reason stays 'user'", async () => {
    const a = await connected();
    expect(await revokeGrant(env.DB, "real-user", a.grantId, NOW + 1000)).toBe(true);
    await expect(refreshAccessToken(env.DB, { refresh_token: a.t.refresh_token, client_id: a.c.client_id }, NOW + 2000)).rejects.toMatchObject({ code: "invalid_grant" });
    expect((await grantRow(a.grantId))?.revoked_reason).toBe("user");
  });
  it("rejects an expired refresh token, a wrong client_id, an access token, and an unknown token; client_id may be omitted", async () => {
    const a = await connected();
    await expect(refreshAccessToken(env.DB, { refresh_token: a.t.refresh_token, client_id: "other" }, NOW + 1000)).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(refreshAccessToken(env.DB, { refresh_token: a.t.access_token, client_id: null }, NOW + 1000)).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(refreshAccessToken(env.DB, { refresh_token: "canopy_ort_nope", client_id: null }, NOW + 1000)).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(refreshAccessToken(env.DB, { refresh_token: a.t.refresh_token, client_id: null }, NOW + 91 * 86_400_000)).rejects.toMatchObject({ code: "invalid_grant" });
    const b = await connected("p-omit");
    expect((await refreshAccessToken(env.DB, { refresh_token: b.t.refresh_token, client_id: null }, NOW + 1000)).token_type).toBe("Bearer");
  });
});

describe("revocation", () => {
  it("revoking a refresh token revokes the grant; revoking an access token expires just it; unknown is a no-op", async () => {
    const a = await connected();
    await revokeOAuthToken(env.DB, a.t.access_token, NOW + 1000);
    expect(await resolveOAuthAccessToken(env.DB, a.t.access_token, NOW + 2000)).toBeNull();
    expect((await grantRow(a.grantId))?.revoked_at).toBeNull();
    await revokeOAuthToken(env.DB, a.t.refresh_token, NOW + 3000);
    expect((await grantRow(a.grantId))?.revoked_reason).toBe("user");
    await revokeOAuthToken(env.DB, "canopy_ort_unknown", NOW); // no throw
  });
  it("listGrants shows only the caller's live grants, newest first; revokeGrant is own-only and idempotent", async () => {
    const a = await connected("real-user");
    const b = await connected("other-user");
    const later = await authorized("real-user");
    await env.DB.prepare(`UPDATE oauth_grants SET created_at = '2026-09-25T00:00:00.000Z' WHERE id = ?`).bind(later.grantId).run();
    expect((await listGrants(env.DB, "real-user")).map((g) => g.id)).toEqual([later.grantId, a.grantId]);
    expect(Object.keys((await listGrants(env.DB, "real-user"))[0]).sort()).toEqual(["client_name", "created_at", "id", "last_used_at"]);
    expect(await revokeGrant(env.DB, "real-user", b.grantId, NOW)).toBe(false);
    expect((await grantRow(b.grantId))?.revoked_at).toBeNull();
    expect(await revokeGrant(env.DB, "real-user", a.grantId, NOW)).toBe(true);
    expect(await revokeGrant(env.DB, "real-user", a.grantId, NOW + 5)).toBe(true);
    expect((await listGrants(env.DB, "real-user")).map((g) => g.id)).toEqual([later.grantId]);
  });
});

describe("pruneOAuth", () => {
  it("drops spent codes and dead tokens; keeps grants, live rows, and a grant-less client under 90 days", async () => {
    const a = await connected();
    await refreshAccessToken(env.DB, { refresh_token: a.t.refresh_token, client_id: a.c.client_id }, NOW + 1000);
    const recentOrphan = await registerClient(env.DB, { client_name: "Recent orphan", redirect_uris: [REDIRECT] }, NOW);
    const staleOrphan = await registerClient(env.DB, { client_name: "Stale orphan", redirect_uris: [REDIRECT] }, NOW - 91 * 86_400_000);
    await pruneOAuth(env.DB, NOW + 2 * 86_400_000);
    expect(await all(env.DB, `SELECT code_hash FROM oauth_codes`)).toEqual([]);
    const tokens = await all<{ kind: string }>(env.DB, `SELECT kind FROM oauth_tokens ORDER BY kind`);
    expect(tokens.map((t) => t.kind)).toEqual(["refresh", "refresh"]); // the original and rotated refresh tokens
    // 2 days old, never granted — a denied/not-yet-invited person retrying keeps their registration.
    expect(await getClient(env.DB, recentOrphan.client_id)).not.toBeNull();
    // 91 days old, never granted — truly abandoned.
    expect(await getClient(env.DB, staleOrphan.client_id)).toBeNull();
    expect(await getClient(env.DB, a.c.client_id)).not.toBeNull();
    expect(await grantRow(a.grantId)).not.toBeNull();
  });
  it("keeps rotated refresh tokens until expiry so late reuse is still detected", async () => {
    const a = await connected();
    const rotated = await refreshAccessToken(env.DB, { refresh_token: a.t.refresh_token, client_id: a.c.client_id }, NOW + 1000);
    await pruneOAuth(env.DB, NOW + 2 * 86_400_000);
    await expect(refreshAccessToken(env.DB, { refresh_token: a.t.refresh_token, client_id: a.c.client_id }, NOW + 2 * 86_400_000 + 1000)).rejects.toMatchObject({ code: "invalid_grant" });
    expect((await grantRow(a.grantId))?.revoked_reason).toBe("reuse");
  });
});

describe("mcpUnauthorized", () => {
  it("points at the protected-resource metadata; flags a bad token", async () => {
    const r = mcpUnauthorized("https://c.test", false);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="https://c.test/.well-known/oauth-protected-resource"`);
    expect(mcpUnauthorized("https://c.test", true).headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="https://c.test/.well-known/oauth-protected-resource", error="invalid_token"`);
    expect(await r.json()).toEqual({ error: "unauthorized" });
  });
});
