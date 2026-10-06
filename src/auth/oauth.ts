// MCP OAuth — the authorization server behind /mcp (spec:
// docs/superpowers/specs/2026-09-24-mcp-oauth-design.md). OAuth is how a bearer
// token is OBTAINED; the token then resolves to a (person, org) exactly like a
// `trov_mcp_` token, so /mcp stays the bearer auth class. D1 only, no fetch,
// and every clock read is a `nowMs` parameter so tests control time. Raw codes
// and tokens are returned once and stored only as SHA-256 hashes.
//
// A connection (grant) is made FOR one org (§7.1): `issueAuthorization` writes the org of the
// TenantContext it is handed onto the grant and its code, and nothing later changes it — a code, an
// access token and a refresh token all reach their org through the grant row.
import { type PlatformContext, all, first, run, stmt, batch } from "../data/platform-sql";
import { type TenantContext, run as tenantRun } from "../data/sql";
import { randomToken, sha256Hex, pkceChallenge } from "./crypto";
import type { OAuthGrantSummary } from "@shared/rows";

export const ACCESS_PREFIX = "trov_oat_";
export const REFRESH_PREFIX = "trov_ort_";
/** Issued before the rename to Trov; still valid until each expires (an hour for access tokens — refresh
 *  tokens are looked up by hash, so an old `canopy_ort_` one rotates into a `trov_` pair as usual). */
const LEGACY_ACCESS_PREFIX = "canopy_oat_";
/** Is this bearer an OAuth ACCESS token (either spelling)? `/mcp` dispatches on it. */
export const isAccessToken = (raw: string): boolean => raw.startsWith(ACCESS_PREFIX) || raw.startsWith(LEGACY_ACCESS_PREFIX);
export const OAUTH_SCOPE = "mcp";
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
/** A rotated refresh token presented again inside this window gets a fresh pair
 *  (several Claude Code sessions share one stored credential and can refresh at
 *  once); after it, the reuse revokes the whole grant. */
export const REUSE_INTERVAL_MS = 60 * 1000;
export const LAST_USED_THROTTLE_MS = 60 * 1000;
/** Keeps the sealed `oauth_pending` cookie far below a browser's 4 KB limit. */
export const MAX_STATE_LENGTH = 1024;
/** A client registration that never earned a grant (e.g. a person denied at
 *  authorize — not yet invited — who retries) is kept this long before it's pruned,
 *  so a retry days later still finds its registration and never hits "this app
 *  isn't registered" (the SDK forgets `client_id` only on `invalid_client`). */
export const UNGRANTED_CLIENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_REDIRECT_URIS = 5;
const MAX_CLIENT_NAME = 80;
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

const iso = (ms: number): string => new Date(ms).toISOString();

/** A standard OAuth error: `code` is the RFC error string, `status` the HTTP status. */
export class OAuthError extends Error {
  constructor(public code: string, public description: string, public status = 400) {
    super(description);
  }
}

/** This deployment's public origin, from the request. https for every public host
 *  (same rule as callbackUrl in ./routes.ts), http kept only for local dev. */
export function oauthOrigin(reqUrl: string): string {
  const u = new URL(reqUrl);
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  return `${isLocal ? u.protocol : "https:"}//${u.host}`;
}

export const mcpResource = (origin: string): string => `${origin}/mcp`;

/** RFC 9728 — what /mcp's 401 points at. */
export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: mcpResource(origin), authorization_servers: [origin],
    scopes_supported: [OAUTH_SCOPE], bearer_methods_supported: ["header"],
  };
}

/** RFC 8414 — Trov is its own authorization server. */
export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: GRANT_TYPES,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
  };
}

// ── Registration (RFC 7591, public clients only) ─────────────────────────────

export interface RegisteredClient { client_id: string; client_name: string; redirect_uris: string[] }

function parseUrl(raw: string): URL | null {
  try { return new URL(raw); } catch { return null; }
}

/** https anywhere, or http on a loopback host; never a fragment. */
export function isAllowedRedirectUri(raw: string): boolean {
  const u = parseUrl(raw);
  if (!u || raw.includes("#")) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

/** Exact match — except a loopback http redirect, which matches a registered
 *  loopback URI on host + path + query at ANY port (RFC 8252 §7.3): a native
 *  client such as Claude Code listens on a fresh port each attempt. */
export function redirectMatches(registered: string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true;
  const c = parseUrl(candidate);
  if (!c || c.protocol !== "http:" || !LOOPBACK_HOSTS.has(c.hostname)) return false;
  return registered.some((r) => {
    const u = parseUrl(r);
    return !!u && u.protocol === "http:" && u.hostname === c.hostname && u.pathname === c.pathname && u.search === c.search;
  });
}

const badMetadata = (d: string) => new OAuthError("invalid_client_metadata", d);

export function validateRegistration(body: unknown): { client_name: string; redirect_uris: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badMetadata("the body must be a JSON object");
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS
    || !uris.every((u) => typeof u === "string" && isAllowedRedirectUri(u))) {
    throw badMetadata("redirect_uris must be 1-5 https or loopback http URLs without a fragment");
  }
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== "none") {
    throw badMetadata("only public clients are supported (token_endpoint_auth_method: none)");
  }
  if (b.grant_types !== undefined && !(Array.isArray(b.grant_types) && b.grant_types.every((g) => GRANT_TYPES.includes(g as string)))) {
    throw badMetadata("grant_types may only be authorization_code and refresh_token");
  }
  if (b.response_types !== undefined && !(Array.isArray(b.response_types) && b.response_types.every((r) => r === "code"))) {
    throw badMetadata("response_types may only be code");
  }
  const name = typeof b.client_name === "string" ? b.client_name.trim().slice(0, MAX_CLIENT_NAME) : "";
  return { client_name: name || "Unnamed client", redirect_uris: uris as string[] };
}

export async function registerClient(p: PlatformContext, meta: { client_name: string; redirect_uris: string[] }, nowMs: number): Promise<RegisteredClient> {
  const client_id = randomToken(32);
  await run(p, `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)`,
    client_id, meta.client_name, JSON.stringify(meta.redirect_uris), iso(nowMs));
  return { client_id, client_name: meta.client_name, redirect_uris: meta.redirect_uris };
}

export async function getClient(p: PlatformContext, clientId: string): Promise<RegisteredClient | null> {
  const row = await first<{ client_id: string; client_name: string; redirect_uris: string }>(
    p, `SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?`, clientId);
  if (!row) return null;
  return { client_id: row.client_id, client_name: row.client_name, redirect_uris: JSON.parse(row.redirect_uris) as string[] };
}

// ── Authorize ───────────────────────────────────────────────────────────────

export const AUTHORIZE_KEYS = [
  "response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource",
] as const;

/** The authorize parameters that matter, in a fixed order — what the consent CSRF
 *  signs and what the `oauth_pending` cookie carries. */
export function canonicalAuthorizeQuery(q: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const k of AUTHORIZE_KEYS) {
    const v = q.get(k);
    if (v) out.set(k, v);
  }
  return out.toString();
}

export interface AuthorizeParams { client_id: string; redirect_uri: string; code_challenge: string; state: string | null; resource: string | null }
export type AuthorizeCheck =
  | { ok: true; client: RegisteredClient; params: AuthorizeParams }
  | { ok: false; kind: "page"; message: string }
  | { ok: false; kind: "redirect"; redirect_uri: string; state: string | null; description: string };

/**
 * Validate an authorize request. A bad client or redirect is an error PAGE — never a
 * redirect, so authorize can't be used as an open redirector; any other problem
 * redirects back with invalid_request. `scope` is deliberately lenient: every token
 * is issued with scope `mcp` whatever was asked for (RFC 6749 §3.3).
 */
export async function checkAuthorizeRequest(p: PlatformContext, q: URLSearchParams, origin: string): Promise<AuthorizeCheck> {
  const clientId = q.get("client_id") ?? "";
  const redirect = q.get("redirect_uri") ?? "";
  const client = clientId ? await getClient(p, clientId) : null;
  if (!client) return { ok: false, kind: "page", message: "Trov doesn't recognise this app's registration. In Claude Code, run /mcp, choose trov → Clear authentication, then Authenticate again." };
  if (!redirectMatches(client.redirect_uris, redirect)) {
    return { ok: false, kind: "page", message: "This app asked to return to an address it never registered, so Trov won't send you there." };
  }
  const state = q.get("state");
  const bad = (description: string): AuthorizeCheck => ({ ok: false, kind: "redirect", redirect_uri: redirect, state, description });
  if (q.get("response_type") !== "code") return bad("response_type must be code");
  const challenge = q.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return bad("a PKCE code_challenge is required");
  if (q.get("code_challenge_method") !== "S256") return bad("code_challenge_method must be S256");
  if (state && state.length > MAX_STATE_LENGTH) return bad(`state must be at most ${MAX_STATE_LENGTH} characters`);
  const resource = q.get("resource");
  if (resource && resource.replace(/\/+$/, "") !== mcpResource(origin)) return bad(`resource must be ${mcpResource(origin)}`);
  return { ok: true, client, params: { client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, state, resource } };
}

/** Consent given: the grant (the connection Settings lists) exists from here; the
 *  code is single-use, lives 60 s, and carries the grant id. The connection is `ctx.userId`'s INTO
 *  `ctx.orgId` (§7.1) — the membership the consent POST just resolved, never a request value — and
 *  the grant and its code both record it. */
export async function issueAuthorization(
  ctx: TenantContext, a: { client: RegisteredClient; params: AuthorizeParams; nowMs: number },
): Promise<{ code: string; grantId: number }> {
  const g = await tenantRun(ctx, `INSERT INTO oauth_grants (org_id, person, client_id, client_name, created_at) VALUES (?, ?, ?, ?, ?)`,
    ctx.orgId, ctx.userId, a.client.client_id, a.client.client_name, iso(a.nowMs));
  const grantId = Number(g.meta.last_row_id);
  const code = randomToken(32);
  await tenantRun(ctx,
    `INSERT INTO oauth_codes (org_id, code_hash, client_id, person, grant_id, redirect_uri, code_challenge, resource, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, await sha256Hex(code), a.client.client_id, ctx.userId, grantId, a.params.redirect_uri, a.params.code_challenge,
    a.params.resource, iso(a.nowMs), iso(a.nowMs + CODE_TTL_MS));
  return { code, grantId };
}

// ── Tokens ──────────────────────────────────────────────────────────────────

export interface TokenResponse { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string }

const invalidGrant = (d: string) => new OAuthError("invalid_grant", d);

/** A fresh access (1 h) + refresh (90 d from now — the idle window) pair on a grant. */
async function mintPair(p: PlatformContext, grantId: number, nowMs: number): Promise<TokenResponse> {
  const access = ACCESS_PREFIX + randomToken(32);
  const refresh = REFRESH_PREFIX + randomToken(32);
  const insert = `INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`;
  await batch(p, [
    stmt(p, insert, await sha256Hex(access), grantId, "access", iso(nowMs), iso(nowMs + ACCESS_TTL_MS)),
    stmt(p, insert, await sha256Hex(refresh), grantId, "refresh", iso(nowMs), iso(nowMs + REFRESH_TTL_MS)),
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: OAUTH_SCOPE };
}

// A grant's standing, read in the statement that finds it: is its person STILL a member of the
// grant's org (`member`), and is that org suspended (0043)? Both are live facts, not the grant's own.
const GRANT_STANDING = `g.org_id, g.revoked_at,
  EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = g.org_id AND m.user_id = g.person COLLATE NOCASE) AS member,
  (SELECT o.suspended_at FROM orgs o WHERE o.id = g.org_id) AS suspended_at`;
interface GrantStanding { org_id: string; revoked_at: string | null; member: number; suspended_at: string | null }

/** Why a grant may not mint tokens right now, or null. A grant whose person has left its org is
 *  REVOKED here — `removeMember` already does that in its own batch; this covers every other way a
 *  membership can go. A suspended org refuses without revoking: a suspension can be lifted. */
async function grantRefusal(p: PlatformContext, grantId: number, g: GrantStanding | null, nowMs: number): Promise<string | null> {
  if (!g || g.revoked_at !== null) return "this connection was revoked";
  if (!g.member) {
    await run(p, `UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'member_removed' WHERE id = ? AND revoked_at IS NULL`, iso(nowMs), grantId);
    return "you are no longer a member of the organization this connection was made for";
  }
  if (g.suspended_at !== null) return "the organization this connection was made for is not available";
  return null;
}

/** authorization_code grant. The code is burned by ONE conditional UPDATE before any
 *  check, so a failed check still spends it and a race has one winner. */
export async function exchangeAuthorizationCode(
  p: PlatformContext, r: { code: string; code_verifier: string; redirect_uri: string; client_id: string; resource: string | null },
  origin: string, nowMs: number,
): Promise<TokenResponse> {
  const row = await first<{ org_id: string; client_id: string; grant_id: number; redirect_uri: string; code_challenge: string; resource: string | null }>(p,
    `UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
     RETURNING org_id, client_id, grant_id, redirect_uri, code_challenge, resource`,
    iso(nowMs), await sha256Hex(r.code), iso(nowMs));
  if (!row) throw invalidGrant("the code is unknown, expired, or already used");
  if (row.client_id !== r.client_id || row.redirect_uri !== r.redirect_uri) throw invalidGrant("client_id or redirect_uri does not match the authorization");
  if ((await pkceChallenge(r.code_verifier)) !== row.code_challenge) throw invalidGrant("code_verifier does not match the code_challenge");
  const expected = (row.resource ?? mcpResource(origin)).replace(/\/+$/, "");
  if (r.resource && r.resource.replace(/\/+$/, "") !== expected) throw invalidGrant("resource does not match the authorization");
  // The code and its grant were written for the same org; a pair that disagrees is not honoured.
  const grant = await first<GrantStanding>(p, `SELECT ${GRANT_STANDING} FROM oauth_grants g WHERE g.id = ?`, row.grant_id);
  const refusal = await grantRefusal(p, row.grant_id, grant && grant.org_id === row.org_id ? grant : null, nowMs);
  if (refusal) throw invalidGrant(refusal);
  return mintPair(p, row.grant_id, nowMs);
}

/** A `trov_oat_` (or legacy `canopy_oat_`) bearer → the (person, org) of its grant, while unexpired and its
 *  grant unrevoked. ONE read; `last_used_at` is written at most once a minute so MCP traffic isn't a write
 *  per call. The caller still checks the LIVE membership (src/data/bearer.ts). */
export async function resolveOAuthAccessToken(p: PlatformContext, raw: string, nowMs: number): Promise<{ handle: string; orgId: string } | null> {
  if (!isAccessToken(raw)) return null;
  const row = await first<{ grant_id: number; person: string; org_id: string; last_used_at: string | null }>(p,
    `SELECT g.id AS grant_id, g.person, g.org_id, g.last_used_at FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
     WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ? AND g.revoked_at IS NULL`,
    await sha256Hex(raw), iso(nowMs));
  if (!row) return null;
  if (!row.last_used_at || Date.parse(row.last_used_at) <= nowMs - LAST_USED_THROTTLE_MS) {
    // Best-effort: the bump is a courtesy for the Connected apps list, never load-bearing
    // for auth, so a failed write here must not cost the caller their resolved principal.
    try {
      await run(p, `UPDATE oauth_grants SET last_used_at = ? WHERE id = ?`, iso(nowMs), row.grant_id);
    } catch (e) {
      console.error("oauth last_used_at: " + (e instanceof Error ? e.message : String(e)));
    }
  }
  return { handle: row.person, orgId: row.org_id };
}

/**
 * refresh_token grant with rotation. The first presentation rotates (ONE conditional
 * UPDATE, so concurrent requests have one winner) and mints a pair whose refresh
 * token expires 90 days out — the idle window. A token presented again within
 * REUSE_INTERVAL_MS of its rotation gets another pair on the same grant (several
 * Claude Code sessions share one credential); later than that is treated as theft
 * and revokes the whole grant.
 *
 * The pair is for the grant's org and no other (fixed at consent). The membership is re-checked
 * BEFORE the rotation: a person who has left that org gets `invalid_grant` and the grant is revoked;
 * a suspended org refuses too, without spending the token.
 */
export async function refreshAccessToken(p: PlatformContext, r: { refresh_token: string; client_id: string | null }, nowMs: number): Promise<TokenResponse> {
  const hash = await sha256Hex(r.refresh_token);
  const row = await first<GrantStanding & { grant_id: number; expires_at: string; rotated_at: string | null; client_id: string }>(p,
    `SELECT t.grant_id, t.expires_at, t.rotated_at, g.client_id, ${GRANT_STANDING} FROM oauth_tokens t
     JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ? AND t.kind = 'refresh'`, hash);
  if (!row || row.revoked_at !== null || row.expires_at <= iso(nowMs)) throw invalidGrant("the refresh token is unknown, expired, or revoked");
  if (r.client_id && r.client_id !== row.client_id) throw invalidGrant("client_id does not match the refresh token");
  const refusal = await grantRefusal(p, row.grant_id, row, nowMs);
  if (refusal) throw invalidGrant(refusal);
  let rotatedAt = row.rotated_at;
  if (rotatedAt === null) {
    const res = await run(p, `UPDATE oauth_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL`, iso(nowMs), hash);
    if (res.meta.changes > 0) return mintPair(p, row.grant_id, nowMs);
    rotatedAt = (await first<{ rotated_at: string | null }>(p, `SELECT rotated_at FROM oauth_tokens WHERE token_hash = ?`, hash))?.rotated_at ?? null;
  }
  if (rotatedAt !== null && nowMs - Date.parse(rotatedAt) <= REUSE_INTERVAL_MS) return mintPair(p, row.grant_id, nowMs);
  await run(p, `UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'reuse' WHERE id = ? AND revoked_at IS NULL`, iso(nowMs), row.grant_id);
  throw invalidGrant("this refresh token was already used; the connection has been revoked");
}

/** RFC 7009. A refresh token revokes its grant; an access token is expired in place;
 *  anything else is a no-op (the endpoint always answers 200). */
export async function revokeOAuthToken(p: PlatformContext, raw: string, nowMs: number): Promise<void> {
  const hash = await sha256Hex(raw);
  const row = await first<{ grant_id: number; kind: string }>(p, `SELECT grant_id, kind FROM oauth_tokens WHERE token_hash = ?`, hash);
  if (!row) return;
  if (row.kind === "refresh") {
    await run(p, `UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'user' WHERE id = ? AND revoked_at IS NULL`, iso(nowMs), row.grant_id);
  } else {
    await run(p, `UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?`, iso(nowMs), hash);
  }
}

/** Settings › Connected apps: the caller's live connections, newest first. USER-level — it spans every
 *  org the person connected an app to, and each row names its org. */
export async function listGrants(p: PlatformContext, handle: string): Promise<OAuthGrantSummary[]> {
  const rows = await all<{ id: number; client_name: string; created_at: string; last_used_at: string | null; slug: string; name: string }>(p,
    `SELECT g.id, g.client_name, g.created_at, g.last_used_at, o.slug, o.name FROM oauth_grants g JOIN orgs o ON o.id = g.org_id
     WHERE g.person = ? COLLATE NOCASE AND g.revoked_at IS NULL ORDER BY g.created_at DESC, g.id DESC`, handle);
  return rows.map((r) => ({ id: r.id, client_name: r.client_name, created_at: r.created_at, last_used_at: r.last_used_at, org: { slug: r.slug, name: r.name } }));
}

/** Revoke one of the caller's OWN grants, whichever org it is into (user-level, like the list). False
 *  for an unknown id and someone else's alike (never an existence oracle); true again on a repeat. */
export async function revokeGrant(p: PlatformContext, handle: string, id: number, nowMs: number): Promise<boolean> {
  const res = await run(p,
    `UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, 'user')
     WHERE id = ? AND person = ? COLLATE NOCASE`, iso(nowMs), id, handle);
  return res.meta.changes > 0;
}

/** The repo cron's 6-hourly :30 tick. D1 only. Grants are never deleted. */
export async function pruneOAuth(p: PlatformContext, nowMs: number): Promise<void> {
  const hourAgo = iso(nowMs - 60 * 60 * 1000);
  const dayAgo = iso(nowMs - 24 * 60 * 60 * 1000);
  const ungrantedClientCutoff = iso(nowMs - UNGRANTED_CLIENT_TTL_MS);
  await batch(p, [
    stmt(p, `DELETE FROM oauth_codes WHERE expires_at < ? OR used_at < ?`, hourAgo, hourAgo),
    stmt(p, `DELETE FROM oauth_tokens WHERE kind = 'access' AND expires_at < ?`, dayAgo),
    stmt(p, `DELETE FROM oauth_tokens WHERE kind = 'refresh' AND expires_at < ?`, iso(nowMs)),
    stmt(p, `DELETE FROM oauth_clients WHERE created_at < ?
      AND client_id NOT IN (SELECT client_id FROM oauth_grants) AND client_id NOT IN (SELECT client_id FROM oauth_codes)`, ungrantedClientCutoff),
  ]);
}

/** /mcp's 401: tells an MCP client where to start OAuth (RFC 9728 §5.1). */
export function mcpUnauthorized(origin: string, invalidToken: boolean): Response {
  const meta = `${origin}/.well-known/oauth-protected-resource`;
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer resource_metadata="${meta}"${invalidToken ? `, error="invalid_token"` : ""}`,
    },
  });
}
