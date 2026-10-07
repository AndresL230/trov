// The Hono middlewares that put a data-layer context on the request (`c.var.ctx`, `c.var.p`).
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/principal";
import { platform, resolveSoleTenant, resolveTenant } from "./context";
import { meterApiRequest } from "./meter";

/** `c.var.p`: the PlatformContext for the global tables. Costs no query, so it is set on every request —
 *  the actor is the session principal, or "anonymous" on a public path. */
export const platformContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("p", platform(c.env, c.get("principal")?.handle ?? "anonymous"));
  return next();
};

/**
 * `/api/o/:slug/*` (§5.2): session principal → membership of the org the path names → `c.var.ctx`.
 * No row — an unknown slug OR not a member — is 404 `{ error: "not_found" }`, never 403: an org's
 * existence is not disclosed — and a SUSPENDED org (0042_organizations) answers the same 404, from the same one
 * statement (`resolveTenant`). Runs after sessionGate.
 * Meters the request (src/data/meter.ts) once the tenant is known.
 */
export const tenantGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const handle = c.get("principal").handle;
  const ctx = await resolveTenant(c.env, handle, c.req.param("slug") ?? "");
  if (!ctx) return c.json({ error: "not_found" }, 404);
  c.set("ctx", ctx);
  meterApiRequest(c, c.var.p ?? platform(c.env, handle), ctx); // the gate does not rely on `platformContext` having run
  return next();
};

/** Session routes that are NOT the cut-over alias's: the person-level surface, reachable with no org at
 *  all (/auth, /avatar, /org-logo, the org picker and invites, the superadmin surface) and the routes that name
 *  their org in the path (`/api/o/:slug/*` — `tenantGate`'s). */
const isPlatformPath = (path: string): boolean =>
  path.startsWith("/auth/") || path.startsWith("/avatar/") || path.startsWith("/org-logo/") ||
  path === "/api/orgs" || path.startsWith("/api/orgs/") || path === "/api/invites" || path.startsWith("/api/invites/") ||
  path.startsWith("/api/platform/") || path.startsWith("/api/o/");

/**
 * CUT-OVER ALIAS (§6.3, Phases 3–5): every pre-multitenancy session route resolves its tenant as "the
 * caller's only org" and sets `c.var.ctx`. A person with no membership, or with more than one, gets
 * 409 `{ error: "org_required" }`; a member of a SUSPENDED org gets 404. Runs after sessionGate; a public
 * path (no principal) and the person-level paths pass through with no ctx. Phase 7 deletes this with the aliases.
 */
export const soleTenantGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const principal = c.get("principal");
  if (!principal || isPlatformPath(c.req.path)) return next();
  const sole = await resolveSoleTenant(c.env, principal.handle, "session");
  if (!sole.ok) return sole.reason === "suspended" ? c.json({ error: "not_found" }, 404) : c.json({ error: "org_required" }, 409);
  c.set("ctx", sole.ctx);
  meterApiRequest(c, c.var.p ?? platform(c.env, principal.handle), sole.ctx);
  return next();
};
