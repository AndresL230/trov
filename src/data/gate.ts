// The Hono middlewares that put a data-layer context on the request (`c.var.ctx`, `c.var.p`).
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/principal";
import { platform, resolveTenant } from "./context";
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
 * The membership was usually read already, in the session gate's own statement (`c.var.tenantHint`,
 * `resolveSessionTenant` — `resolveTenant`'s statement joined to the session row): it is used only when it
 * is for THIS person and THIS slug, and `resolveTenant` reads it otherwise (DEV_LOGIN, a path the hint
 * parsed differently, a gate mounted without sessionGate's hint).
 */
export const tenantGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const handle = c.get("principal").handle;
  const slug = c.req.param("slug") ?? "";
  const hint = c.get("tenantHint");
  const ctx = hint && hint.handle === handle && hint.slug === slug ? hint.ctx : await resolveTenant(c.env, handle, slug);
  if (!ctx) return c.json({ error: "not_found" }, 404);
  c.set("ctx", ctx);
  meterApiRequest(c, c.var.p ?? platform(c.env, handle), ctx); // the gate does not rely on `platformContext` having run
  return next();
};
