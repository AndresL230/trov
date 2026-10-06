import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { readSessionCookie, getSessionUser } from "./session";
import { resolveToken } from "./tokens";
import { isAccessToken, resolveOAuthAccessToken } from "./oauth";
import { platform, type PlatformContext, type TenantContext } from "../data/context";

export interface Principal {
  handle: string;
}

// `p` (every request) and `ctx` (every tenant route) are set by the middlewares in src/data/gate.ts.
export type AppEnv = { Bindings: Env; Variables: { principal: Principal; p: PlatformContext; ctx: TenantContext } };

/**
 * Is this login an admin? ADMIN_LOGINS is a comma-separated allowlist of GitHub
 * logins permitted to run admin actions (e.g. the server-side backfill). An
 * absent/empty var means nobody is an admin — fails closed.
 */
export function isAdmin(env: Env, login: string): boolean {
  const allow = (env.ADMIN_LOGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return allow.includes(login);
}

// The only routes reachable without a session. Everything else is gated.
const PUBLIC_PATHS = new Set([
  "/auth/login", "/auth/callback",
  "/auth/google/login", "/auth/google/callback",
  "/auth/onboard", "/auth/handle-check", // gate themselves on the onboard cookie
]);

/** The OAuth endpoints take no session cookie (/oauth/authorize checks the session
 *  itself, to show a sign-in page instead of a bare 401). */
const isPublicPath = (path: string): boolean =>
  PUBLIC_PATHS.has(path) || path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-");

export async function resolveSessionPrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  const id = await readSessionCookie(c, c.env.COOKIE_SECRET);
  if (!id) return null;
  const handle = await getSessionUser(platform(c.env, "anonymous"), id);
  return handle ? { handle } : null;
}

/** The /mcp principal. Dispatches on the token prefix: an OAuth access token
 *  (`trov_oat_`, legacy `canopy_oat_`, obtained through /oauth/*) or a pasted `trov_mcp_` / legacy `canopy_mcp_` token — both
 *  resolve to the same `{ handle }`, so nothing downstream of /mcp can tell them apart. */
export async function resolveBearerPrincipal(request: Request, env: Env): Promise<Principal | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const raw = match[1].trim();
  const p = platform(env, "anonymous");
  if (isAccessToken(raw)) return resolveOAuthAccessToken(p, raw, Date.now());
  return resolveToken(p, raw);
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
  if (c.env.DEV_LOGIN) {
    c.set("principal", { handle: c.env.DEV_LOGIN });
    return next();
  }
  const principal = await resolveSessionPrincipal(c);
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  c.set("principal", principal);
  return next();
};
