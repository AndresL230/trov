import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { readSessionCookie, getSessionUser, sessionLive } from "./session";
import { platform, resolveSessionTenant, type PlatformContext, type TenantContext } from "../data/context";

export interface Principal {
  handle: string;
}

/** What `sessionGate` already knows about a `/api/o/:slug/*` request's org, from the SAME statement that read
 *  the session (`resolveSessionTenant`): `tenantGate` takes `ctx` from here when the person and the slug are
 *  the ones it resolves, and reads them itself otherwise. */
export interface TenantHint { handle: string; slug: string; ctx: TenantContext | null }

// `p` (every request) and `ctx` (every tenant route) are set by the middlewares in src/data/gate.ts.
export type AppEnv = { Bindings: Env; Variables: { principal: Principal; p: PlatformContext; ctx: TenantContext; tenantHint: TenantHint | undefined } };

// The only routes reachable without a session. Everything else is gated.
const PUBLIC_PATHS = new Set([
  "/auth/login", "/auth/callback",
  "/auth/google/login", "/auth/google/callback",
  "/auth/onboard", "/auth/handle-check", // gate themselves on the onboard cookie
  // Billing (src/billing/routes.ts): the pricing page's link — it reads the session itself, to show a
  // sign-in page instead of a bare 401 — and what that page asks before it draws its buttons.
  "/billing/start", "/api/billing/config",
  // The site's Contact form (src/platform/support-routes.ts): a signed-out visitor's message to the operator.
  // Unauthenticated like the two above, and bounded by its own limits (docs/architecture/abuse-limits.md);
  // it reads the session itself, so a signed-in sender is filed as that person.
  "/api/support/public",
]);

/** A hosting provider's install / OAuth return, and its "Configuration URL" (src/hosting/routes.ts:
 *  `/hosting/<provider>/callback`, `/hosting/<provider>/configure`). A person's browser arrives here FROM the
 *  provider, so it must never meet the gate's 401 JSON: each route resolves the signed-in person from the
 *  session cookie itself and answers a redirect whatever happened. Exactly these shapes. */
export const HOSTING_CALLBACK_PATH = /^\/hosting\/[a-z0-9_-]+\/(?:callback|configure)$/;

/** The OAuth endpoints take no session cookie (/oauth/authorize checks the session
 *  itself, to show a sign-in page instead of a bare 401). */
const isPublicPath = (path: string): boolean =>
  PUBLIC_PATHS.has(path) || path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-") || HOSTING_CALLBACK_PATH.test(path);

/** The signed-in person for a route that reads the session itself: the session cookie's, else — LOCAL DEV ONLY —
 *  `DEV_LOGIN`'s (as `sessionGate`). In production (no DEV_LOGIN) exactly `resolveSessionPrincipal`. */
export async function resolvePrincipalOrDev(c: Context<AppEnv>): Promise<Principal | null> {
  return (await resolveSessionPrincipal(c)) ?? (c.env.DEV_LOGIN ? { handle: c.env.DEV_LOGIN } : null);
}

export async function resolveSessionPrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  const id = await readSessionCookie(c, c.env.COOKIE_SECRET);
  if (!id) return null;
  const handle = await getSessionUser(platform(c.env, "anonymous"), id);
  return handle ? { handle } : null;
}

/** The org segment of a `/api/o/<slug>/…` path, decoded as a route parameter is — or null for any other
 *  path (or one that does not decode). Only a HINT: `tenantGate` compares it with its own `:slug`. */
export function tenantPathSlug(path: string): string | null {
  const m = /^\/api\/o\/([^/]+)(?:\/|$)/.exec(path);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

/** `resolveSessionPrincipal` for a `/api/o/<slug>/…` request: the session AND that org's membership in one
 *  statement. The session's answer is the same — no row, or an expired one, is no principal — and the org
 *  half is left for `tenantGate` (`c.var.tenantHint`). */
async function resolveSessionPrincipalWithTenant(c: Context<AppEnv>, slug: string): Promise<Principal | null> {
  const id = await readSessionCookie(c, c.env.COOKIE_SECRET);
  if (!id) return null;
  const row = await resolveSessionTenant(c.env, id, slug);
  if (!row || !sessionLive(row.expiresAt)) return null;
  c.set("tenantHint", { handle: row.person, slug, ctx: row.ctx });
  return { handle: row.person };
}

/**
 * Gate every route except the two public auth paths. Fails closed: 401 with no
 * data in the body. On success, sets the principal on the context for handlers.
 */
export const sessionGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isPublicPath(c.req.path)) return next();
  // LOCAL DEV ONLY: DEV_LOGIN exists only in .dev.vars (never in production vars or
  // secrets), so this branch is inert in prod. When set, skip the OAuth/session check
  // and act as that seeded user — lets the UI be exercised over `wrangler dev` without
  // the real GitHub flow. Mirrors scripts/dev-cookie.mjs, but with zero cookie fuss.
  // A session cookie still wins over it, so the local dev sign-in (src/auth/dev-signin.ts) can switch person.
  if (c.env.DEV_LOGIN) {
    c.set("principal", (await resolveSessionPrincipal(c)) ?? { handle: c.env.DEV_LOGIN });
    return next();
  }
  // A tenant path reads its org in the same round trip as the session (docs/architecture/data-layer.md ›
  // Round trips); every other path, the session alone.
  const slug = tenantPathSlug(c.req.path);
  const principal = slug === null ? await resolveSessionPrincipal(c) : await resolveSessionPrincipalWithTenant(c, slug);
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  c.set("principal", principal);
  return next();
};
