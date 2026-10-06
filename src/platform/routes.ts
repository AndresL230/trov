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
  setSuspended, setOrgLimit, listAdmins, grantAdmin, revokeAdmin, listAudit,
} from "./repo";
import { platformUsage, usageDays, USAGE_DEFAULT_DAYS } from "./usage";
import type { PlatformOrgDetail, PlatformOrgRow } from "@shared/orgs";

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
  throw e;
}
const body = async (c: Context<AppEnv>): Promise<Record<string, unknown> | null> => {
  const json: unknown = await c.req.json().catch(() => null);
  return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
};
const invalid = (c: Context<AppEnv>) => c.json({ error: "invalid payload" }, 400);
const publicRow = ({ id: _id, ...row }: PlatformOrgRow & { id: string }): PlatformOrgRow => row;

// ── orgs ─────────────────────────────────────────────────────────────────────
platformApp.get("/orgs", async (c) => c.json({ orgs: (await listPlatformOrgs(c.var.p)).map(publicRow) }));

platformApp.post("/orgs", async (c) => {
  const b = await body(c);
  if (!b) return invalid(c);
  try {
    const { org, admin } = await createOrgWithAdmin(c.var.p, { slug: b.slug as string, name: b.name as string, admin: b.admin });
    return c.json({ ok: true, org: publicRow((await listPlatformOrgs(c.var.p, org.slug))[0]), admin }, 201);
  } catch (e) { return fail(c, e); }
});

async function detail(c: Context<AppEnv>, slug: string): Promise<PlatformOrgDetail | null> {
  const [org] = await listPlatformOrgs(c.var.p, slug);
  if (!org) return null;
  const [people, usage] = await Promise.all([platformOrgPeople(c.var.p, org.id), platformUsage(c.var.p, USAGE_DEFAULT_DAYS)]);
  return { org: publicRow(org), ...people, usage: usage.orgs.find((o) => o.slug === org.slug)! };
}

platformApp.get("/orgs/:slug", async (c) => {
  const d = await detail(c, c.req.param("slug"));
  return d ? c.json(d) : c.json({ error: "not_found" }, 404);
});

platformApp.post("/orgs/:slug/admin", async (c) => {
  const b = await body(c);
  if (!b) return invalid(c);
  try {
    return c.json({ ok: true, admin: await assignOrgAdmin(c.var.p, c.req.param("slug"), b) });
  } catch (e) { return fail(c, e); }
});

const suspend = (suspended: boolean) => async (c: Context<AppEnv>) => {
  try {
    await setSuspended(c.var.p, c.req.param("slug") ?? "", suspended);
    return c.json({ ok: true, org: publicRow((await listPlatformOrgs(c.var.p, c.req.param("slug")))[0]) });
  } catch (e) { return fail(c, e); }
};
platformApp.post("/orgs/:slug/suspend", suspend(true));
platformApp.post("/orgs/:slug/unsuspend", suspend(false));

// ── persons ──────────────────────────────────────────────────────────────────
platformApp.put("/persons/:handle/org-limit", async (c) => {
  const b = await body(c);
  if (!b || !("limit" in b)) return invalid(c);
  try {
    return c.json({ ok: true, person: await setOrgLimit(c.var.p, c.req.param("handle"), b.limit) });
  } catch (e) { return fail(c, e); }
});

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
