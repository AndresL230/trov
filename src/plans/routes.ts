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
import { PlanError, PLAN_ERROR_STATUS, cleanPlan, setOrgPlan } from "./state";
import { platformBillingBySlug, setPlanPinned } from "../billing/store";
import { paidSeats } from "@shared/billing";

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

  // An org that PAYS through Stripe (0045_billing, docs/architecture/billing.md › The superadmin and a paid org):
  // the superadmin may still set its plan. While its subscription is live the org STAYS a billing org — its
  // owner keeps Manage billing, its status and period keep following Stripe — and a plan that differs from
  // the one the subscription pays for is PINNED: no later subscription event moves it back. `follow_subscription`
  // lifts the pin and puts the org on the subscription's own plan again. Once the subscription has ENDED (the
  // org moved to Free), Change plan takes the org back as a granted one (active), as for any other org.
  app.put("/orgs/:slug/plan", async (c) => {
    const b = await body(c);
    if (!b) return c.json({ error: "invalid payload" }, 400);
    const slug = c.req.param("slug");
    try {
      const paid = (await platformBillingBySlug(c.var.p, slug)).get(slug) ?? null;
      const now = paid ? (await orgRow(slug, c.var.p))?.plan ?? null : null;
      if (b.follow_subscription === true) {
        if (!paid || !now) return c.json({ error: "not_billed", message: "this organization has no subscription to follow" }, 409);
        // …with the seats it pays for (Pro is per seat: the quantity is the seat cap).
        await setOrgPlan(c.var.p, slug, { plan: paid.plan, overrides: paidSeats(paid.plan, paid.seats), source: "billing", status: now.status });
        await setPlanPinned(c.var.p, paid.subscription_id, false);
      } else if (paid && now && !paid.ended && now.status !== "canceled") {
        const plan = cleanPlan(b.plan);
        await setOrgPlan(c.var.p, slug, { plan, overrides: b.overrides, source: "billing", status: now.status });
        await setPlanPinned(c.var.p, paid.subscription_id, plan !== paid.plan);
      } else {
        await setOrgPlan(c.var.p, slug, { plan: b.plan, overrides: b.overrides });
      }
      return c.json({ ok: true, org: (await orgRow(slug, c.var.p))! });
    } catch (e) { return fail(c, e); }
  });
}
