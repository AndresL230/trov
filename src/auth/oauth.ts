// MCP OAuth — the authorization server behind /mcp (spec:
// docs/superpowers/specs/2026-09-24-mcp-oauth-design.md). OAuth is how a bearer
// token is OBTAINED; the token then resolves to a (person, org) exactly like a
// `trov_mcp_` token, so /mcp stays the bearer auth class. D1 only, no fetch,
// and every clock read is a `nowMs` parameter so tests control time. Raw codes
// and tokens are returned once and stored only as SHA-256 hashes.
//
// A connection (grant) has a MODE (0051, docs/architecture/data-layer.md § Bearer):
//   manual — it may use a SET of the person's organizations (`oauth_grant_orgs`) and acts in ONE at a
//            time, its current organization (`oauth_grants.org_id`). The set is changed only by the
//            person, signed in (consent, Settings); the current one also by the `switch_org` tool.
//   repo   — it follows the repository each call names; `org_id` is '' and its `oauth_grant_orgs`
//            rows are the organizations it has been used in.
// A code, an access token and a refresh token all get their reach through the grant row; which org a
// request acts in is decided per call, in src/data/bearer.ts, behind a live membership check.
import { requirePlan } from "../plans/gate";
import { type PlatformContext, all, first, run, stmt, batch } from "../data/platform-sql";
import { type TenantContext, first as tenantFirst, run as tenantRun } from "../data/sql";
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

export type GrantMode = "manual" | "repo";
/** What a `repo` grant carries in `org_id`: it belongs to no organization. Never an org's id, so a
 *  reader that takes it for one (a Worker from before 0051) finds no membership and refuses. */
export const NO_ORG = "";

/** Does `ctx`'s org already hold a row for this grant (it is allowed there / has been used there)? */
const holdsGrant = async (ctx: TenantContext, grantId: number): Promise<boolean> =>
  (await tenantFirst<{ ok: number }>(ctx, `SELECT 1 AS ok FROM oauth_grant_orgs WHERE org_id = ? AND grant_id = ?`, ctx.orgId, grantId)) !== null;
/** Write that row, as `ctx`'s org. */
const holdGrant = (ctx: TenantContext, grantId: number, nowMs: number) =>
  tenantRun(ctx, `INSERT OR IGNORE INTO oauth_grant_orgs (org_id, grant_id, person, added_at) VALUES (?, ?, ?, ?)`, ctx.orgId, grantId, ctx.userId, iso(nowMs));

/** Consent given to a MANUAL connection: the grant (the connection Settings lists) exists from here;
 *  the code is single-use, lives 60 s, and carries the grant id. `ctx` is the organization it STARTS
 *  in (its current one) and `a.orgs` the others it may use — every one a membership the consent POST
 *  just resolved, never a request value; with none it is a connection to `ctx`'s org alone, as every
 *  connection was before 0051. A connected app is one of the person's AGENT CONNECTIONS in EACH of
 *  those organizations (0044_plans): at any one's cap this throws `PlanLimitError` and nothing is written. */
export async function issueAuthorization(
  ctx: TenantContext, a: { client: RegisteredClient; params: AuthorizeParams; nowMs: number; orgs?: TenantContext[] },
): Promise<{ code: string; grantId: number }> {
  const allowed = [ctx, ...(a.orgs ?? [])].filter((o, i, list) => list.findIndex((x) => x.orgId === o.orgId) === i);
  if (allowed.some((o) => o.userId.toLowerCase() !== ctx.userId.toLowerCase())) throw new Error("issueAuthorization: every organization must be the same person's");
  for (const o of allowed) await requirePlan(o, "agent_connections");
  const g = await tenantRun(ctx, `INSERT INTO oauth_grants (org_id, person, client_id, client_name, created_at, mode) VALUES (?, ?, ?, ?, ?, 'manual')`,
    ctx.orgId, ctx.userId, a.client.client_id, a.client.client_name, iso(a.nowMs));
  const grantId = Number(g.meta.last_row_id);
  for (const o of allowed) await holdGrant(o, grantId, a.nowMs);
  const code = randomToken(32);
  await tenantRun(ctx,
    `INSERT INTO oauth_codes (org_id, code_hash, client_id, person, grant_id, redirect_uri, code_challenge, resource, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, await sha256Hex(code), a.client.client_id, ctx.userId, grantId, a.params.redirect_uri, a.params.code_challenge,
    a.params.resource, iso(a.nowMs), iso(a.nowMs + CODE_TTL_MS));
  return { code, grantId };
}

/** Consent given to a connection that FOLLOWS THE REPOSITORY: the grant is the person's and no
 *  organization's (`org_id` = NO_ORG), so it is written on the platform surface. It takes no agent-
 *  connection slot here — it takes one in an organization the first time a call resolves there
 *  (`admitGrantOrg`), which is where the plan can refuse it. */
export async function issueRepoAuthorization(
  p: PlatformContext, handle: string, a: { client: RegisteredClient; params: AuthorizeParams; nowMs: number },
): Promise<{ code: string; grantId: number }> {
  const g = await run(p, `INSERT INTO oauth_grants (org_id, person, client_id, client_name, created_at, mode) VALUES (?, ?, ?, ?, ?, 'repo')`,
    NO_ORG, handle, a.client.client_id, a.client.client_name, iso(a.nowMs));
  const grantId = Number(g.meta.last_row_id);
  const code = randomToken(32);
  await run(p,
    `INSERT INTO oauth_codes (org_id, code_hash, client_id, person, grant_id, redirect_uri, code_challenge, resource, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    NO_ORG, await sha256Hex(code), a.client.client_id, handle, grantId, a.params.redirect_uri, a.params.code_challenge,
    a.params.resource, iso(a.nowMs), iso(a.nowMs + CODE_TTL_MS));
  return { code, grantId };
}

/** A `repo` grant's first call into `ctx`'s org (src/data/bearer.ts): it takes one of the person's
 *  agent-connection slots there, or the plan refuses (`PlanLimitError`) and nothing is written. A no-op
 *  once the row exists — that organization has already admitted this connection. */
export async function admitGrantOrg(ctx: TenantContext, grantId: number, nowMs: number = Date.now()): Promise<void> {
  if (await holdsGrant(ctx, grantId)) return;
  await requirePlan(ctx, "agent_connections");
  await holdGrant(ctx, grantId, nowMs);
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

// A grant's standing, read in the statement that finds it — live facts, not the grant's own. Over the
// organizations it can reach: a manual grant's are the ones its person allowed (`oauth_grant_orgs`), a
// `repo` grant's are every organization its person is in. `member` = the person is STILL a member of at
// least one of them; `reachable` = at least one of those is not suspended (0042_organizations).
const GRANT_STANDING = `g.org_id, g.mode, g.revoked_at,
  CASE g.mode WHEN 'repo'
    THEN EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = g.person COLLATE NOCASE)
    ELSE EXISTS (SELECT 1 FROM oauth_grant_orgs a JOIN memberships m ON m.org_id = a.org_id AND m.user_id = g.person COLLATE NOCASE WHERE a.grant_id = g.id)
  END AS member,
  CASE g.mode WHEN 'repo'
    THEN EXISTS (SELECT 1 FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = g.person COLLATE NOCASE AND o.suspended_at IS NULL)
    ELSE EXISTS (SELECT 1 FROM oauth_grant_orgs a JOIN memberships m ON m.org_id = a.org_id AND m.user_id = g.person COLLATE NOCASE
                   JOIN orgs o ON o.id = a.org_id WHERE a.grant_id = g.id AND o.suspended_at IS NULL)
  END AS reachable`;
interface GrantStanding { org_id: string; mode: GrantMode; revoked_at: string | null; member: number; reachable: number }

/** Why a grant may not mint tokens right now, or null. A grant whose person is no longer a member of
 *  ANY organization it can reach is REVOKED here — `removeMember` already does that in its own batch;
 *  this covers every other way a membership can go. When the only ones left are suspended it refuses
 *  without revoking: a suspension can be lifted. */
async function grantRefusal(p: PlatformContext, grantId: number, g: GrantStanding | null, nowMs: number): Promise<string | null> {
  if (!g || g.revoked_at !== null) return "this connection was revoked";
  if (!g.member) {
    await run(p, `UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'member_removed' WHERE id = ? AND revoked_at IS NULL`, iso(nowMs), grantId);
    return "you are no longer a member of the organization this connection was made for";
  }
  if (!g.reachable) return "the organization this connection was made for is not available";
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

/** A `trov_oat_` (or legacy `canopy_oat_`) bearer → its grant: the person, the mode, and `orgId` — a
 *  manual grant's CURRENT organization, NO_ORG for a `repo` grant — while unexpired and its grant
 *  unrevoked. ONE read; `last_used_at` is written at most once a minute so MCP traffic isn't a write
 *  per call. The caller still checks the LIVE membership (src/data/bearer.ts). */
export async function resolveOAuthAccessToken(p: PlatformContext, raw: string, nowMs: number): Promise<{ handle: string; orgId: string; mode: GrantMode; grantId: number } | null> {
  if (!isAccessToken(raw)) return null;
  const row = await first<{ grant_id: number; person: string; org_id: string; mode: GrantMode; last_used_at: string | null }>(p,
    `SELECT g.id AS grant_id, g.person, g.org_id, g.mode, g.last_used_at FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
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
  return { handle: row.person, orgId: row.org_id, mode: row.mode === "repo" ? "repo" : "manual", grantId: row.grant_id };
}

/**
 * refresh_token grant with rotation. The first presentation rotates (ONE conditional
 * UPDATE, so concurrent requests have one winner) and mints a pair whose refresh
 * token expires 90 days out — the idle window. A token presented again within
 * REUSE_INTERVAL_MS of its rotation gets another pair on the same grant (several
 * Claude Code sessions share one credential); later than that is treated as theft
 * and revokes the whole grant.
 *
 * The pair is for the grant and reaches only what the grant reaches. Its standing is re-checked BEFORE
 * the rotation: a person who is no longer a member of any organization it can reach gets
 * `invalid_grant` and the grant is revoked; when all that is left is suspended it refuses too, without
 * spending the token.
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

/** Settings › Connected apps: the caller's live connections, newest first. USER-level — a connection
 *  is the person's, and each row says how it is scoped: its mode, the organizations it can use (manual)
 *  or has been used in (repo), and a manual one's current organization. Only organizations the person
 *  is a member of NOW and that are not suspended are named — what the connection can actually reach. */
export async function listGrants(p: PlatformContext, handle: string): Promise<OAuthGrantSummary[]> {
  const rows = await all<{ id: number; client_name: string; created_at: string; last_used_at: string | null; mode: GrantMode; org_id: string }>(p,
    `SELECT g.id, g.client_name, g.created_at, g.last_used_at, g.mode, g.org_id FROM oauth_grants g
     WHERE g.person = ? COLLATE NOCASE AND g.revoked_at IS NULL ORDER BY g.created_at DESC, g.id DESC`, handle);
  const orgs = await all<{ grant_id: number; org_id: string; slug: string; name: string }>(p,
    `SELECT a.grant_id, a.org_id, o.slug, o.name FROM oauth_grant_orgs a JOIN oauth_grants g ON g.id = a.grant_id
       JOIN orgs o ON o.id = a.org_id JOIN memberships m ON m.org_id = a.org_id AND m.user_id = g.person COLLATE NOCASE
      WHERE g.person = ? COLLATE NOCASE AND g.revoked_at IS NULL AND o.suspended_at IS NULL ORDER BY o.name COLLATE NOCASE ASC`, handle);
  return rows.map((r) => {
    const mine = orgs.filter((o) => o.grant_id === r.id);
    const mode: GrantMode = r.mode === "repo" ? "repo" : "manual";
    const current = mode === "manual" ? mine.find((o) => o.org_id === r.org_id) : undefined;
    return {
      id: r.id, client_name: r.client_name, created_at: r.created_at, last_used_at: r.last_used_at, mode,
      org: current ? { slug: current.slug, name: current.name } : null,
      orgs: mine.map((o) => ({ slug: o.slug, name: o.name })),
    };
  });
}

// ── Changing a connection's reach: a PERSON's act (session-cookie routes in ./routes.ts), never MCP ──
// Each is keyed by the grant's id AND its person, so someone else's id is the same miss as an unknown
// one. An organization is always handed in as a TenantContext — the live membership its caller resolved.

export type GrantScopeCode = "not_found" | "not_manual" | "current_org" | "last_org" | "not_allowed";
export class GrantScopeError extends Error {
  constructor(readonly code: GrantScopeCode) { super(code); }
}

/** One of `handle`'s own live grants (with how many organizations hold a row for it), or null. */
async function ownGrant(p: PlatformContext, handle: string, id: number): Promise<{ id: number; mode: GrantMode; org_id: string; orgs: number } | null> {
  const row = await first<{ id: number; mode: GrantMode; org_id: string; orgs: number }>(p,
    `SELECT g.id, g.mode, g.org_id, (SELECT COUNT(*) FROM oauth_grant_orgs a WHERE a.grant_id = g.id) AS orgs
       FROM oauth_grants g WHERE g.id = ? AND g.person = ? COLLATE NOCASE AND g.revoked_at IS NULL`, id, handle);
  return row ? { ...row, mode: row.mode === "repo" ? "repo" : "manual" } : null;
}

/** Is `id` one of `handle`'s own live grants? Else `not_found` — the same for someone else's and for none. */
export async function requireOwnGrant(p: PlatformContext, handle: string, id: number): Promise<void> {
  if (!(await ownGrant(p, handle, id))) throw new GrantScopeError("not_found");
}

/** Add `ctx`'s org to (or take it out of) the set a MANUAL connection may use. Adding takes one of the
 *  person's agent-connection slots there (`PlanLimitError` at the cap; nothing written). Taking out the
 *  current organization is refused (`current_org` — switch first), as is the last one (`last_org` —
 *  disconnect instead): a manual connection always has somewhere to act. */
export async function setGrantOrg(p: PlatformContext, ctx: TenantContext, id: number, on: boolean, nowMs: number = Date.now()): Promise<void> {
  const g = await ownGrant(p, ctx.userId, id);
  if (!g) throw new GrantScopeError("not_found");
  if (g.mode !== "manual") throw new GrantScopeError("not_manual");
  const held = await holdsGrant(ctx, id);
  if (on) {
    if (held) return;
    await requirePlan(ctx, "agent_connections");
    await holdGrant(ctx, id, nowMs);
    return;
  }
  if (!held) return;
  if (g.org_id === ctx.orgId) throw new GrantScopeError("current_org");
  if (g.orgs <= 1) throw new GrantScopeError("last_org");
  await tenantRun(ctx, `DELETE FROM oauth_grant_orgs WHERE org_id = ? AND grant_id = ?`, ctx.orgId, id);
}

/** Make `ctx`'s org a MANUAL connection's current organization — only one already in its allowed set
 *  (one statement, so the check and the write cannot part). Called by the Settings route and by the
 *  `switch_org` tool: it moves the connection inside what its person granted, and grants nothing. */
export async function setGrantCurrent(ctx: TenantContext, id: number): Promise<void> {
  const res = await tenantRun(ctx,
    `UPDATE oauth_grants SET org_id = ?1 WHERE id = ?2 AND person = ?3 COLLATE NOCASE AND mode = 'manual' AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM oauth_grant_orgs a WHERE a.grant_id = oauth_grants.id AND a.org_id = ?1)`, ctx.orgId, id, ctx.userId);
  if (res.meta.changes === 0) throw new GrantScopeError("not_allowed");
}

/** Change a connection between the two modes. To `repo`: it stops being any organization's — its
 *  allowed set is dropped (the slots it held are freed; it takes one again where it is next used). To
 *  `manual`: it is bound to `to.ctx`'s org alone, current and only allowed one (a slot there, unless it
 *  already holds one); the person adds others afterwards. */
export async function setGrantMode(
  p: PlatformContext, handle: string, id: number, to: { mode: "repo" } | { mode: "manual"; ctx: TenantContext }, nowMs: number = Date.now(),
): Promise<void> {
  const g = await ownGrant(p, handle, id);
  if (!g) throw new GrantScopeError("not_found");
  if (to.mode === "repo") {
    await batch(p, [
      stmt(p, `UPDATE oauth_grants SET mode = 'repo', org_id = ? WHERE id = ? AND person = ? COLLATE NOCASE AND revoked_at IS NULL`, NO_ORG, id, handle),
      stmt(p, `DELETE FROM oauth_grant_orgs WHERE grant_id = ? AND person = ? COLLATE NOCASE`, id, handle),
    ]);
    return;
  }
  const ctx = to.ctx;
  if (ctx.userId.toLowerCase() !== handle.toLowerCase()) throw new GrantScopeError("not_found");
  if (!(await holdsGrant(ctx, id))) await requirePlan(ctx, "agent_connections");
  await batch(p, [
    stmt(p, `DELETE FROM oauth_grant_orgs WHERE grant_id = ? AND org_id <> ?`, id, ctx.orgId),
    stmt(p, `INSERT OR IGNORE INTO oauth_grant_orgs (org_id, grant_id, person, added_at) VALUES (?, ?, ?, ?)`, ctx.orgId, id, handle, iso(nowMs)),
    stmt(p, `UPDATE oauth_grants SET mode = 'manual', org_id = ? WHERE id = ? AND person = ? COLLATE NOCASE AND revoked_at IS NULL`, ctx.orgId, id, handle),
  ]);
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
