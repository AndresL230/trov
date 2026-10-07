// The SUPERADMIN surface, /api/platform/* (canopy-multitenancy.md §5.4). Session cookie only, never MCP.
//
// Every route is behind `requireSuperadmin`, and a caller who is not one gets 404 `not_found` on EVERY
// path under the prefix — existing or not — so the surface is not discoverable. A superadmin whose
// request carries an Authorization header is refused (the artifact-ratify rule). Being superadmin is
// not a membership: nothing here reads an org's content, and `tenantGate` still 404s them on its routes.
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../auth/principal";
import { RoleError, requireSuperadmin } from "../data/context";
import { OrgError, ORG_ERROR_STATUS } from "../orgs/repo";
import { cookieOnly } from "../orgs/routes";
import {
  PlatformError, PLATFORM_ERROR_STATUS, createOrgWithAdmin, assignOrgAdmin, listPlatformOrgs, platformOrgPeople,
  setSuspended, listAdmins, grantAdmin, revokeAdmin, listAudit,
} from "./repo";
import { PlanError, PLAN_ERROR_STATUS } from "../plans/state";
import { registerPlanRoutes } from "../plans/routes";
import { platformUsage, usageDays, USAGE_DEFAULT_DAYS } from "./usage";
import { mailInvite, mailOrigin, welcomeFirstJoin } from "../orgs/mail";
import { rateLimited } from "./limits";
import type { AdminAssignment, PlatformOrgDetail, PlatformOrgRow } from "@shared/orgs";
import type { PlatformContext } from "../data/platform-sql";
import { platformBillingBySlug } from "../billing/store";

export const platformApp = new Hono<AppEnv>();

platformApp.use("*", async (c, next) => {
  try {
    await requireSuperadmin(c.var.p, c.get("principal").handle);
  } catch (e) {
    if (e instanceof RoleError) return c.json({ error: "not_found" }, 404);
    throw e;
  }
  return next();
});
platformApp.use("*", cookieOnly);

function fail(c: Context<AppEnv>, e: unknown): Response {
  if (e instanceof PlatformError) return c.json({ error: e.code, message: e.message }, PLATFORM_ERROR_STATUS[e.code]);
  if (e instanceof OrgError) return c.json({ error: e.code, message: e.message }, ORG_ERROR_STATUS[e.code]);
  if (e instanceof PlanError) return c.json({ error: e.code, message: e.message }, PLAN_ERROR_STATUS[e.code]);
  throw e; // a PlanLimitError goes on to the app's one handler (src/routes.ts): 402
}
const body = async (c: Context<AppEnv>): Promise<Record<string, unknown> | null> => {
  const json: unknown = await c.req.json().catch(() => null);
  return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
};
const invalid = (c: Context<AppEnv>) => c.json({ error: "invalid payload" }, 400);
const publicRow = ({ id: _id, ...row }: PlatformOrgRow & { id: string }): PlatformOrgRow => row;

/**
 * Tell the person just named an org's owner. An e-mail owner invite is mailed ("you have been made the
 * owner of <org>") and its outcome recorded on the invite; a GitHub-login invite has no address — they
 * see it when they sign in. An existing person made owner directly gets the welcome if this is their
 * first org. The invite limit is taken like any invite's (a superadmin is exempt, so it never refuses
 * here); neither mail can fail the request.
 */
async function notifyAdmin(c: Context<AppEnv>, orgId: string, admin: AdminAssignment, firstJoin: boolean): Promise<void> {
  const origin = mailOrigin(c.env, c.req.url);
  if (admin.status === "owner") return welcomeFirstJoin(c.env, c.var.p, orgId, admin.handle, firstJoin, origin);
  if (admin.email === null || (await rateLimited(c, "invite"))) return;
  await mailInvite(c.env, c.var.p, orgId, { id: admin.invite_id, email: admin.email, name: null, role: "owner" }, origin);
}

// ── orgs ─────────────────────────────────────────────────────────────────────
/** The rows as Platform shows them: without the internal id, and with the Stripe subscription of each
 *  org that pays (0045_billing) beside its plan — ids, Stripe's status and the dashboard link; no amounts. */
async function platformRows(p: PlatformContext, slug?: string): Promise<PlatformOrgRow[]> {
  const [orgs, billing] = await Promise.all([listPlatformOrgs(p, slug), platformBillingBySlug(p, slug)]);
  return orgs.map(publicRow).map((o) => (o.plan ? { ...o, plan: { ...o.plan, billing: billing.get(o.slug) ?? null } } : o));
}

platformApp.get("/orgs", async (c) => c.json({ orgs: await platformRows(c.var.p) }));

platformApp.post("/orgs", async (c) => {
  const b = await body(c);
  if (!b) return invalid(c);
  try {
    const { org, admin, first_join } = await createOrgWithAdmin(c.var.p, { slug: b.slug as string, name: b.name as string, admin: b.admin, plan: b.plan, overrides: b.overrides });
    await notifyAdmin(c, org.id, admin, first_join);
    return c.json({ ok: true, org: (await platformRows(c.var.p, org.slug))[0], admin }, 201);
  } catch (e) { return fail(c, e); }
});

async function detail(c: Context<AppEnv>, slug: string): Promise<PlatformOrgDetail | null> {
  const [org] = await listPlatformOrgs(c.var.p, slug);
  if (!org) return null;
  const [people, usage] = await Promise.all([platformOrgPeople(c.var.p, org.id), platformUsage(c.var.p, USAGE_DEFAULT_DAYS)]);
  return { org: (await platformRows(c.var.p, org.slug))[0], ...people, usage: usage.orgs.find((o) => o.slug === org.slug)! };
}

platformApp.get("/orgs/:slug", async (c) => {
  const d = await detail(c, c.req.param("slug"));
  return d ? c.json(d) : c.json({ error: "not_found" }, 404);
});

platformApp.post("/orgs/:slug/admin", async (c) => {
  const b = await body(c);
  if (!b) return invalid(c);
  try {
    const { org_id, first_join, admin } = await assignOrgAdmin(c.var.p, c.req.param("slug"), b);
    await notifyAdmin(c, org_id, admin, first_join);
    return c.json({ ok: true, admin });
  } catch (e) { return fail(c, e); }
});

const suspend = (suspended: boolean) => async (c: Context<AppEnv>) => {
  try {
    await setSuspended(c.var.p, c.req.param("slug") ?? "", suspended);
    return c.json({ ok: true, org: (await platformRows(c.var.p, c.req.param("slug")))[0] });
  } catch (e) { return fail(c, e); }
};
platformApp.post("/orgs/:slug/suspend", suspend(true));
platformApp.post("/orgs/:slug/unsuspend", suspend(false));

// ── plans and grants (0044_plans): /orgs/:slug/plan, /grants… — src/plans/routes.ts ──
registerPlanRoutes(platformApp, (slug, p) => platformRows(p, slug).then((rows) => rows[0] ?? null));

// ── superadmins ──────────────────────────────────────────────────────────────
platformApp.get("/admins", async (c) => c.json({ admins: await listAdmins(c.var.p) }));
platformApp.post("/admins", async (c) => {
  const b = await body(c);
  if (!b) return invalid(c);
  try {
    await grantAdmin(c.var.p, b.handle);
    return c.json({ ok: true, admins: await listAdmins(c.var.p) });
  } catch (e) { return fail(c, e); }
});
platformApp.delete("/admins/:handle", async (c) => {
  try {
    await revokeAdmin(c.var.p, c.req.param("handle"));
    return c.json({ ok: true, admins: await listAdmins(c.var.p) });
  } catch (e) { return fail(c, e); }
});

// ── audit, usage ─────────────────────────────────────────────────────────────
platformApp.get("/audit", async (c) => {
  const limit = Number(c.req.query("limit"));
  try {
    return c.json({ audit: await listAudit(c.var.p, { orgSlug: c.req.query("org") || undefined, limit: Number.isFinite(limit) ? limit : undefined }) });
  } catch (e) { return fail(c, e); }
});

platformApp.get("/usage", async (c) => c.json(await platformUsage(c.var.p, usageDays(c.req.query("days")))));
