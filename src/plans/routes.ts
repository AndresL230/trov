// The superadmin's plan and grant routes (docs/architecture/plans.md), registered ON `platformApp`
// (src/platform/routes.ts) — so every one is behind `requireSuperadmin` (404 for anyone else) and
// `cookieOnly`, like the rest of /api/platform:
//   GET  /api/platform/grants               every grant, newest first
//   POST /api/platform/grants               grant a person an organization of their own
//   POST /api/platform/grants/:id/revoke    revoke an unused one
//   PUT  /api/platform/orgs/:slug/plan      change an org's plan and its limit overrides
// An org member reads their org's plan at GET /api/o/:slug/plan (src/orgs/routes.ts).
import type { Context, Hono } from "hono";
import type { AppEnv } from "../auth/principal";
import type { PlatformContext } from "../data/platform-sql";
import type { PlatformOrgRow } from "@shared/orgs";
import { mailOrigin } from "../orgs/mail";
import { GrantError, GRANT_ERROR_STATUS, createGrant, getGrant, listGrants, mailGrant, revokeGrant } from "./grants";
import { PlanError, PLAN_ERROR_STATUS, setOrgPlan } from "./state";

function fail(c: Context<AppEnv>, e: unknown): Response {
  if (e instanceof GrantError) return c.json({ error: e.code, message: e.message }, GRANT_ERROR_STATUS[e.code]);
  if (e instanceof PlanError) return c.json({ error: e.code, message: e.message }, PLAN_ERROR_STATUS[e.code]);
  throw e;
}
const body = async (c: Context<AppEnv>): Promise<Record<string, unknown> | null> => {
  const json: unknown = await c.req.json().catch(() => null);
  return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
};

/** `orgRow` is Platform's own row for a slug (it carries the plan), so the answer to a plan change is
 *  the same shape the list and the org page already render. */
export function registerPlanRoutes(app: Hono<AppEnv>, orgRow: (slug: string, p: PlatformContext) => Promise<PlatformOrgRow | null>): void {
  app.get("/grants", async (c) => c.json({ grants: await listGrants(c.var.p) }));

  app.post("/grants", async (c) => {
    const b = await body(c);
    if (!b) return c.json({ error: "invalid payload" }, 400);
    try {
      const grant = await createGrant(c.var.p, { to: b.to, plan: b.plan, overrides: b.overrides, note: b.note, expires_in_days: b.expires_in_days });
      // An e-mail grant is told by mail; a handle or a GitHub login has no address — the person sees it when they sign in.
      await mailGrant(c.env, c.var.p, grant, mailOrigin(c.env, c.req.url));
      return c.json({ ok: true, grant: (await getGrant(c.var.p, grant.id))! }, 201);
    } catch (e) { return fail(c, e); }
  });

  app.post("/grants/:id/revoke", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "not_found" }, 404);
    try {
      return c.json({ ok: true, grant: await revokeGrant(c.var.p, id) });
    } catch (e) { return fail(c, e); }
  });

  app.put("/orgs/:slug/plan", async (c) => {
    const b = await body(c);
    if (!b) return c.json({ error: "invalid payload" }, 400);
    try {
      await setOrgPlan(c.var.p, c.req.param("slug"), { plan: b.plan, overrides: b.overrides });
      return c.json({ ok: true, org: (await orgRow(c.req.param("slug"), c.var.p))! });
    } catch (e) { return fail(c, e); }
  });
}
