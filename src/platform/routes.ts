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
import { registerSupportRoutes } from "./support-routes";
import { confirmMismatch, deleteOrganization, deletionRefusal, orgDeletionPreview, orgForDeletion } from "../deletion/org";
import { accountDeletionPreview, deleteAccount } from "../deletion/person";
import { confirms } from "@shared/deletion-core";

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
 *  org that pays (0045_billing) beside its plan — ids, Stripe's status and the dashboard link; no amounts.
 *  A granted org's row carries no `billing` at all. */
async function platformRows(p: PlatformContext, slug?: string): Promise<PlatformOrgRow[]> {
  const [orgs, billing] = await Promise.all([listPlatformOrgs(p, slug), platformBillingBySlug(p, slug)]);
  return orgs.map(publicRow).map((o) => { const paid = billing.get(o.slug); return o.plan && paid ? { ...o, plan: { ...o.plan, billing: paid } } : o; });
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
  return { org: (await platformRows(c.var.p, org.slug))[0], ...people, usage: usage.orgs.find((o) => o.slug === org.slug)!, summaries_enabled: !!c.env.GEMINI_API_KEY };
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

// ── deletion (src/deletion/): the SAME cores as an owner's "Delete organization" and a person's "Delete my
// account" — the superadmin is just another caller. An organization needs no membership (the superadmin has
// none: they see its name, slug and counts, never its content). An account keeps every guard rail that
// protects other people, and is refused for a superadmin's account or one's own (`superadmin` / `self`).
// Each is recorded in the audit trail (`org.delete`, `person.delete`), the superadmin as its actor.
const refusedDeletion = (c: Context<AppEnv>, e: unknown): Response => {
  const refused = deletionRefusal(e);
  if (refused) return c.json(refused.body, refused.status);
  throw e;
};
platformApp.get("/orgs/:slug/deletion", async (c) => {
  const org = await orgForDeletion(c.var.p, { slug: c.req.param("slug") });
  return org ? c.json(await orgDeletionPreview(c.env, c.var.p, org), 200, { "cache-control": "no-store" }) : c.json({ error: "not_found" }, 404);
});
platformApp.post("/orgs/:slug/delete", async (c) => {
  const org = await orgForDeletion(c.var.p, { slug: c.req.param("slug") });
  if (!org) return c.json({ error: "not_found" }, 404);
  const b = await body(c);
  if (!confirms(b?.confirm, org.slug)) return c.json(confirmMismatch("slug"), 400);
  try {
    await deleteOrganization(c.env, c.var.p, org, { by: "platform", actor: c.get("principal").handle });
    return c.json({ ok: true, slug: org.slug });
  } catch (e) { return refusedDeletion(c, e); }
});
platformApp.get("/persons/:handle/deletion", async (c) => {
  const me = c.get("principal").handle;
  const preview = await accountDeletionPreview(c.var.p, c.req.param("handle"), { by: "platform", actor: me });
  return preview ? c.json(preview, 200, { "cache-control": "no-store" }) : c.json({ error: "not_found", message: "No account has that handle." }, 404);
});
platformApp.post("/persons/:handle/delete", async (c) => {
  const me = c.get("principal").handle;
  const preview = await accountDeletionPreview(c.var.p, c.req.param("handle"), { by: "platform", actor: me });
  if (!preview) return c.json({ error: "not_found", message: "No account has that handle." }, 404);
  const b = await body(c);
  if (!confirms(b?.confirm, preview.handle)) return c.json(confirmMismatch("handle"), 400);
  try {
    const done = await deleteAccount(c.env, c.var.p, preview.handle, { by: "platform", actor: me });
    // Not the tombstone: nothing here should pair the old handle with the new one.
    return c.json({ ok: true, orgs_deleted: done.orgs_deleted });
  } catch (e) { return refusedDeletion(c, e); }
});

// ── plans and grants (0044_plans): /orgs/:slug/plan, /grants… — src/plans/routes.ts ──
registerPlanRoutes(platformApp, (slug, p) => platformRows(p, slug).then((rows) => rows[0] ?? null));

// ── support reports (0049_support_reports): /support… — ./support-routes.ts ──
registerSupportRoutes(platformApp);

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

platformApp.get("/usage", async (c) => c.json(await platformUsage(c.var.p, usageDays(c.req.query("days")), new Date(), { summariesEnabled: !!c.env.GEMINI_API_KEY })));
