// MCP OAuth — the HTTP surface over ./oauth.ts. Metadata, register, token and revoke
// are public JSON endpoints with open CORS (no cookies are read); authorize is the
// one route that reads the session, to show the consent page. Never a 500.
import { Hono, type Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "./principal";
import {
  OAuthError, oauthOrigin, protectedResourceMetadata, authorizationServerMetadata,
  validateRegistration, registerClient, exchangeAuthorizationCode, refreshAccessToken, revokeOAuthToken,
  AUTHORIZE_KEYS, canonicalAuthorizeQuery, checkAuthorizeRequest, issueAuthorization, type AuthorizeCheck,
} from "./oauth";
import { readSessionCookie, getSessionUser } from "./session";
import { hmacSeal, hmacUnseal, b64uEncode, b64uDecode } from "./crypto";
import { errorPage, signInPage, consentPage } from "./oauth-pages";
import { platformContext } from "../data/gate";
import { resolveSoleTenant } from "../data/context";

const MAX_REGISTER_BYTES = 8 * 1024;
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
};

export const OAUTH_PENDING_COOKIE = "oauth_pending";
const OAUTH_PENDING_TTL_S = 600;

/** Remember a validated authorize request across sign-in (and onboarding): sealed,
 *  HttpOnly, 10 minutes — the same shape as the `onboard` cookie. */
export async function setOAuthPending(c: Context<AppEnv>, q: URLSearchParams, nowMs: number): Promise<void> {
  const value = b64uEncode(JSON.stringify({ q: canonicalAuthorizeQuery(q), exp: nowMs + OAUTH_PENDING_TTL_S * 1000 }));
  setCookie(c, OAUTH_PENDING_COOKIE, await hmacSeal(value, `oauth-pending:${c.env.COOKIE_SECRET}`),
    { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: OAUTH_PENDING_TTL_S });
}

/** After a sign-in lands a session: where to send the person — the pending authorize
 *  URL (re-validated there) — or null. Always clears the cookie. A tampered, expired
 *  or malformed cookie is null, so the person just lands in the app. */
export async function takeOAuthPending(c: Context<AppEnv>, nowMs: number = Date.now()): Promise<string | null> {
  const sealed = getCookie(c, OAUTH_PENDING_COOKIE);
  if (!sealed) return null;
  deleteCookie(c, OAUTH_PENDING_COOKIE, { path: "/" });
  const v = await hmacUnseal(sealed, `oauth-pending:${c.env.COOKIE_SECRET}`);
  if (!v) return null;
  try {
    const o = JSON.parse(b64uDecode(v)) as { q?: unknown; exp?: unknown };
    if (typeof o.q !== "string" || typeof o.exp !== "number" || o.exp <= nowMs) return null;
    return `/oauth/authorize?${o.q}`;
  } catch { return null; }
}

/** The consent CSRF value: an HMAC over the session id and the canonical request, so
 *  a form can't be replayed by another session or with altered parameters. */
async function consentCsrf(secret: string, sessionId: string, q: URLSearchParams): Promise<string> {
  const sealed = await hmacSeal(`${sessionId}|${canonicalAuthorizeQuery(q)}`, `oauth-consent:${secret}`);
  return sealed.slice(sealed.lastIndexOf(".") + 1);
}
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The signed-in person for authorize. DEV_LOGIN mirrors sessionGate's local-dev
 *  bypass (inert in prod), so the flow can be exercised over `wrangler dev`. */
async function consentSession(c: Context<AppEnv>): Promise<{ id: string; handle: string } | null> {
  if (c.env.DEV_LOGIN) return { id: "dev", handle: c.env.DEV_LOGIN };
  const id = await readSessionCookie(c, c.env.COOKIE_SECRET);
  if (!id) return null;
  const handle = await getSessionUser(c.var.p, id);
  return handle ? { id, handle } : null;
}

// Geist comes from Google Fonts, like the SPA's index.html; nothing else loads.
// form-action stays LAST: the consent page appends the app's redirect origin to it.
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; form-action 'self'";

export interface OAuthDeps { now?: () => number }

export function buildOAuthApp(deps: OAuthDeps = {}): Hono<AppEnv> {
  const now = deps.now ?? Date.now;
  const o = new Hono<AppEnv>();
  // OAuth clients, codes, grants and tokens are global tables: `c.var.p` (set here too, so the app stands alone).
  o.use("*", platformContext);

  const json = (c: Context<AppEnv>, body: unknown, status: 200 | 201 | 400 | 401 | 503 = 200, cache = "no-store") =>
    c.json(body, status, { ...CORS, "cache-control": cache });
  const oauthError = (c: Context<AppEnv>, e: OAuthError) =>
    json(c, { error: e.code, error_description: e.description }, e.status as 400 | 401);

  // ── Metadata ──
  const prm = (c: Context<AppEnv>) => json(c, protectedResourceMetadata(oauthOrigin(c.req.url)), 200, "public, max-age=3600");
  o.get("/.well-known/oauth-protected-resource", prm);
  o.get("/.well-known/oauth-protected-resource/mcp", prm);
  o.get("/.well-known/oauth-authorization-server", (c) =>
    json(c, authorizationServerMetadata(oauthOrigin(c.req.url)), 200, "public, max-age=3600"));
  const preflight = (c: Context<AppEnv>) => c.body(null, 204, CORS);
  o.options("/.well-known/*", preflight);
  o.options("/oauth/*", preflight);

  // ── Registration ──
  o.post("/oauth/register", async (c) => {
    const declaredLen = c.req.header("content-length");
    if (declaredLen !== undefined && Number(declaredLen) > MAX_REGISTER_BYTES) {
      return oauthError(c, new OAuthError("invalid_client_metadata", "the registration body is over 8 KB"));
    }
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > MAX_REGISTER_BYTES) return oauthError(c, new OAuthError("invalid_client_metadata", "the registration body is over 8 KB"));
    const text = new TextDecoder().decode(bytes);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return oauthError(c, new OAuthError("invalid_client_metadata", "the body must be JSON")); }
    try {
      const client = await registerClient(c.var.p, validateRegistration(body), now());
      return json(c, {
        ...client, client_id_issued_at: Math.floor(now() / 1000), token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      }, 201);
    } catch (e) {
      if (e instanceof OAuthError) return oauthError(c, e);
      console.error("oauth register: unexpected error", e instanceof Error ? e.message : "unknown");
      return json(c, { error: "temporarily_unavailable" }, 503);
    }
  });

  /** Form-encoded (the standard) or JSON; string values only. Reads the body as
   *  bytes (not .text()) so a form-urlencoded content-type never trips workerd's
   *  "does not appear to be text" warning. */
  async function params(c: Context<AppEnv>): Promise<URLSearchParams> {
    const text = new TextDecoder().decode(await c.req.arrayBuffer());
    if ((c.req.header("content-type") ?? "").includes("application/json")) {
      try {
        const obj = JSON.parse(text) as Record<string, unknown>;
        return new URLSearchParams(Object.entries(obj).filter((e): e is [string, string] => typeof e[1] === "string"));
      } catch { return new URLSearchParams(); }
    }
    return new URLSearchParams(text);
  }
  const need = (p: URLSearchParams, k: string): string => {
    const v = p.get(k);
    if (!v) throw new OAuthError("invalid_request", `${k} is required`);
    return v;
  };

  // ── Token ──
  o.post("/oauth/token", async (c) => {
    const p = await params(c);
    try {
      const grant = p.get("grant_type");
      if (grant === "authorization_code") {
        return json(c, await exchangeAuthorizationCode(c.var.p, {
          code: need(p, "code"), code_verifier: need(p, "code_verifier"), redirect_uri: need(p, "redirect_uri"),
          client_id: need(p, "client_id"), resource: p.get("resource"),
        }, oauthOrigin(c.req.url), now()));
      }
      if (grant === "refresh_token") {
        return json(c, await refreshAccessToken(c.var.p, { refresh_token: need(p, "refresh_token"), client_id: p.get("client_id") }, now()));
      }
      throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    } catch (e) {
      if (e instanceof OAuthError) return oauthError(c, e);
      console.error("oauth token: unexpected error", e instanceof Error ? e.message : "unknown");
      return json(c, { error: "temporarily_unavailable" }, 503);
    }
  });

  // ── Revocation (RFC 7009): always 200 on success, never a 500 ──
  o.post("/oauth/revoke", async (c) => {
    const token = (await params(c)).get("token");
    try {
      if (token) await revokeOAuthToken(c.var.p, token, now());
    } catch (e) {
      console.error("oauth revoke: unexpected error", e instanceof Error ? e.message : "unknown");
      return json(c, { error: "temporarily_unavailable" }, 503);
    }
    return c.body(null, 200, CORS);
  });

  // ── Authorize ──
  // Chrome applies form-action to the redirect that follows a form POST, so the
  // consent page must also allow the app's redirect origin.
  const page = (c: Context<AppEnv>, html: string, status: 200 | 400 | 403 | 409 | 503, formTarget?: string) =>
    c.html(html, status, {
      "cache-control": "no-store", "x-frame-options": "DENY",
      "content-security-policy": formTarget ? `${PAGE_CSP} ${formTarget}` : PAGE_CSP,
    });
  const back = (redirectUri: string, state: string | null, params: Record<string, string>): string => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (state) u.searchParams.set("state", state);
    return u.toString();
  };
  const refuse = (c: Context<AppEnv>, check: Exclude<AuthorizeCheck, { ok: true }>) =>
    check.kind === "page"
      ? page(c, errorPage(check.message), 400)
      : c.redirect(back(check.redirect_uri, check.state, { error: "invalid_request", error_description: check.description }), 302);
  // Never a 500: an unexpected throw (e.g. D1 down) renders the same hardened error
  // page as a known refusal, just at 503 — logging only the message, never request data.
  const unavailable = (c: Context<AppEnv>, e: unknown) => {
    console.error("oauth authorize: unexpected error", e instanceof Error ? e.message : "unknown");
    return page(c, errorPage("Trov couldn't finish this right now. Try again from the app."), 503);
  };

  o.get("/oauth/authorize", async (c) => {
    try {
      const q = new URL(c.req.url).searchParams;
      const check = await checkAuthorizeRequest(c.var.p, q, oauthOrigin(c.req.url));
      if (!check.ok) return refuse(c, check);
      const s = await consentSession(c);
      if (!s) {
        await setOAuthPending(c, q, now());
        return page(c, signInPage(check.client.client_name), 200);
      }
      const hidden: Record<string, string> = {};
      for (const k of AUTHORIZE_KEYS) { const v = q.get(k); if (v) hidden[k] = v; }
      const target = new URL(check.params.redirect_uri);
      return page(c, consentPage({
        clientName: check.client.client_name, redirectHost: target.hostname, handle: s.handle,
        hidden, csrf: await consentCsrf(c.env.COOKIE_SECRET, s.id, q),
      }), 200, target.origin);
    } catch (e) {
      return unavailable(c, e);
    }
  });

  o.post("/oauth/authorize", async (c) => {
    try {
      const body = await c.req.parseBody();
      const q = new URLSearchParams();
      for (const k of AUTHORIZE_KEYS) { const v = body[k]; if (typeof v === "string" && v) q.set(k, v); }
      const check = await checkAuthorizeRequest(c.var.p, q, oauthOrigin(c.req.url));
      if (!check.ok) return refuse(c, check);
      const s = await consentSession(c);
      const csrf = typeof body.csrf === "string" ? body.csrf : "";
      if (!s || !constantTimeEqual(csrf, await consentCsrf(c.env.COOKIE_SECRET, s.id, q))) {
        return page(c, errorPage("This approval form expired or didn't come from your session. Start the connection again from the app."), 403);
      }
      if (body.decision !== "allow") return c.redirect(back(check.params.redirect_uri, check.params.state, { error: "access_denied" }), 302);
      // MT: a connection is granted FOR an org (§7.1). Until the consent page offers the choice (Phase 5a)
      // that is the person's only org — the same cut-over alias every tenant route resolves through.
      const sole = await resolveSoleTenant(c.env, s.handle, "session");
      if (!sole.ok) {
        // A suspended org answers like one the person is not in (§5.4).
        return page(c, errorPage(sole.reason !== "org_required"
          ? "You aren't a member of an organization on Trov yet, so there is nothing to connect this app to."
          : "You belong to more than one organization, and choosing one here isn't available yet."), 409);
      }
      const { code } = await issueAuthorization(c.var.p, { client: check.client, params: check.params, person: s.handle, orgId: sole.ctx.orgId, nowMs: now() });
      return c.redirect(back(check.params.redirect_uri, check.params.state, { code }), 302);
    } catch (e) {
      return unavailable(c, e);
    }
  });

  return o;
}

export const oauthApp = buildOAuthApp();
