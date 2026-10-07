// The org surface (canopy-multitenancy.md §5.3, §6.2, §6.3), three sub-apps:
//   • `orgsApp`      /api/orgs      — my orgs + my invites, create an org        (session; no membership needed)
//   • `myInvitesApp` /api/invites   — my pending invites, accept / decline        (session; no membership needed)
//   • `orgTenantApp` /api/o/:slug   — me, settings, members, invites of ONE org   (session + `tenantGate`)
//
// Session-cookie only, and NEVER MCP: like artifact ratification, every route here refuses a request that
// carries an Authorization header outright, so no future change to `sessionGate` can turn a bearer token
// into a membership change. Role gates live in the repository (`requireRole`); a `RoleError` is a 403.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/principal";
import { RoleError, hasRole } from "../data/context";
import { listRepoRows } from "../integrations/settings";
import { ORG_LOGO_MAX_BYTES, type OrgLogoResponse, type OrgMeResponse } from "@shared/orgs";
import { importLogoForOrg } from "../integrations/logo";
import { PeopleError } from "../tools/people";
import { getOrgLogo, removeOrgLogo, setOrgLogo } from "./logo";
import { rateLimited } from "../platform/limits";
import {
  OrgError, ORG_ERROR_STATUS, myOrgs, listMyInvites, createOrgForSelf, respondToInvite,
  orgMe, getOrgSettings, updateOrgSettings, listMembers, updateMember, removeMember,
  listOrgInvites, createInvite, revokeInvite, resendableInvite, getOrgInvite, neverJoined,
} from "./repo";
import { mailInvite, mailOrigin, welcomeFirstJoin } from "./mail";

/** Refuse a bearer-shaped caller before anything else runs (the artifact-ratify rule). */
export const cookieOnly: MiddlewareHandler<AppEnv> = async (c, next) =>
  c.req.header("authorization")
    ? c.json({ error: "forbidden", message: "this is a signed-in person's action, never a token's" }, 403)
    : next();

/** `RoleError` → 403 `forbidden`; an `OrgError` → its status and code. Anything else is a real 500. */
export function orgFail(c: Context<AppEnv>, e: unknown): Response {
  if (e instanceof RoleError) return c.json({ error: "forbidden" }, 403);
  if (e instanceof OrgError) return c.json({ error: e.code, message: e.message }, ORG_ERROR_STATUS[e.code]);
  throw e;
}

const body = async (c: Context<AppEnv>): Promise<Record<string, unknown> | null> => {
  const json: unknown = await c.req.json().catch(() => null);
  return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
};
const invalid = (c: Context<AppEnv>) => c.json({ error: "invalid payload" }, 400);
const inviteId = (c: Context<AppEnv>): number | null => {
  const id = Number(c.req.param("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
};
const me = (c: Context<AppEnv>): string => c.get("principal").handle;

// ── /api/orgs ────────────────────────────────────────────────────────────────
export const orgsApp = new Hono<AppEnv>();
orgsApp.use("*", cookieOnly);

orgsApp.get("/", async (c) => c.json(await myOrgs(c.var.p, me(c))));

orgsApp.post("/", async (c) => {
  const b = await body(c);
  if (!b) return invalid(c);
  try {
    const firstJoin = await neverJoined(c.var.p, me(c));
    const org = await createOrgForSelf(c.var.p, me(c), { slug: b.slug as string, name: b.name as string });
    await welcomeFirstJoin(c.env, c.var.p, org.id, me(c), firstJoin, mailOrigin(c.env, c.req.url));
    return c.json({ ok: true, org: { slug: org.slug, name: org.name, role: "owner" as const, logo_url: null } }, 201);
  } catch (e) { return orgFail(c, e); }
});

// ── /api/invites ─────────────────────────────────────────────────────────────
export const myInvitesApp = new Hono<AppEnv>();
myInvitesApp.use("*", cookieOnly);

myInvitesApp.get("/", async (c) => c.json({ invites: await listMyInvites(c.var.p, me(c)) }));

const respond = (accept: boolean) => async (c: Context<AppEnv>) => {
  const id = inviteId(c);
  if (id === null) return c.json({ error: "not_found" }, 404);
  try {
    const { org_id, first_join, ...answer } = await respondToInvite(c.var.p, me(c), id, accept);
    await welcomeFirstJoin(c.env, c.var.p, org_id, me(c), first_join, mailOrigin(c.env, c.req.url));
    return c.json({ ok: true, ...answer });
  } catch (e) { return orgFail(c, e); }
};
myInvitesApp.post("/:id/accept", respond(true));
myInvitesApp.post("/:id/decline", respond(false));

// ── /api/o/:slug ─────────────────────────────────────────────────────────────
// `tenantGate` (mounted on /api/o/:slug/* in src/routes.ts) has already resolved `c.var.ctx`.
export const orgTenantApp = new Hono<AppEnv>();
for (const path of ["/me", "/settings", "/logo", "/logo/*", "/members", "/members/*", "/invites", "/invites/*"]) orgTenantApp.use(path, cookieOnly);

orgTenantApp.get("/me", async (c) => {
  const [row, repos] = await Promise.all([orgMe(c.var.p, c.var.ctx), listRepoRows(c.var.ctx)]);
  if (!row) return c.json({ error: "not_found" }, 404);
  const names = repos.map((r) => r.repo_full_name); // primary first (listRepoRows' order)
  return c.json({ ...row, repos: { primary: repos.find((r) => r.is_primary === 1)?.repo_full_name ?? null, all: names } } satisfies OrgMeResponse);
});

orgTenantApp.get("/settings", async (c) => c.json({ org: await getOrgSettings(c.var.p, c.var.ctx), can_edit: hasRole(c.var.ctx, "admin") }));
orgTenantApp.put("/settings", async (c) => {
  const b = await body(c);
  if (!b) return invalid(c);
  try {
    return c.json({ ok: true, org: await updateOrgSettings(c.var.p, c.var.ctx, { name: b.name }) });
  } catch (e) { return orgFail(c, e); }
});

// The org's image (0042_organizations, ./logo.ts) — admin+. Upload: multipart, field `file`, checked like a person's
// photo; a declared length past the cap (plus multipart framing) is refused before the body is read, and
// the uploader's daily allowance is taken after the role gate (a refused member spends nothing).
orgTenantApp.post("/logo", async (c) => {
  if (!hasRole(c.var.ctx, "admin")) return c.json({ error: "forbidden" }, 403);
  const tooLarge = `an org image is at most ${ORG_LOGO_MAX_BYTES} bytes`;
  const len = Number(c.req.header("content-length"));
  if (Number.isFinite(len) && len > ORG_LOGO_MAX_BYTES + 64 * 1024) return c.json({ error: "too_large", message: tooLarge }, 413);
  const refused = await rateLimited(c, "org_logo_upload");
  if (refused) return refused;
  let file: File | null = null;
  try {
    const v = (await c.req.raw.formData()).get("file");
    file = v && typeof v !== "string" ? (v as File) : null;
  } catch {
    return c.json({ error: "invalid_image", message: "the body must be multipart/form-data" }, 400);
  }
  try {
    return c.json({ ok: true, logo: await setOrgLogo(c.var.p, c.var.ctx, c.env.ARTIFACTS_BUCKET, file) } satisfies OrgLogoResponse);
  } catch (e) {
    if (e instanceof PeopleError) return e.code === "too_large" ? c.json({ error: "too_large", message: e.message }, 413) : c.json({ error: "invalid_image", message: e.message }, 400);
    return orgFail(c, e);
  }
});
// Remove: an UPLOADED image only. The org then has none, so the GitHub import applies again and is
// tried at once — the answer carries what shows now (the repository owner's avatar when there is a
// repository and GitHub answered, else nothing: the initial tile). The import cannot fail the removal.
orgTenantApp.post("/logo/remove", async (c) => {
  try {
    if (await removeOrgLogo(c.var.p, c.var.ctx)) await importLogoForOrg(c.env, c.var.p, c.var.ctx);
    return c.json({ ok: true, logo: await getOrgLogo(c.var.p, c.var.ctx.orgId) } satisfies OrgLogoResponse);
  } catch (e) { return orgFail(c, e); }
});

orgTenantApp.get("/members", async (c) => c.json({ members: await listMembers(c.var.p, c.var.ctx) }));
orgTenantApp.put("/members/:handle", async (c) => {
  const b = await body(c);
  if (!b) return invalid(c);
  try {
    await updateMember(c.var.p, c.var.ctx, c.req.param("handle"), { role: b.role, title: b.title, responsibilities: b.responsibilities });
    return c.json({ ok: true, members: await listMembers(c.var.p, c.var.ctx) });
  } catch (e) { return orgFail(c, e); }
});
orgTenantApp.delete("/members/:handle", async (c) => {
  try {
    return c.json({ ok: true, ...(await removeMember(c.var.p, c.var.ctx, c.req.param("handle"))) });
  } catch (e) { return orgFail(c, e); }
});

orgTenantApp.get("/invites", async (c) => {
  if (!hasRole(c.var.ctx, "admin")) return c.json({ error: "forbidden" }, 403);
  return c.json({ invites: await listOrgInvites(c.var.p, c.var.ctx.orgId) });
});
orgTenantApp.post("/invites", async (c) => {
  const b = await body(c);
  if (!b) return invalid(c);
  if (!hasRole(c.var.ctx, "admin")) return c.json({ error: "forbidden" }, 403);
  const refused = await rateLimited(c, "invite");
  if (refused) return refused;
  try {
    const invite = await createInvite(c.var.p, c.var.ctx, { github_login: b.github_login, email: b.email, role: b.role, name: b.name });
    // An e-mail invite is mailed now; a GitHub-login invite has no address and waits for the person's sign-in.
    await mailInvite(c.env, c.var.p, c.var.ctx.orgId, invite, mailOrigin(c.env, c.req.url));
    return c.json({ ok: true, invite: (await getOrgInvite(c.var.p, c.var.ctx.orgId, invite.id))! }, 201);
  } catch (e) { return orgFail(c, e); }
});
orgTenantApp.post("/invites/:id/resend", async (c) => {
  const id = inviteId(c);
  if (id === null) return c.json({ error: "not_found" }, 404);
  try {
    const invite = await resendableInvite(c.var.p, c.var.ctx, id);
    const refused = await rateLimited(c, "invite");
    if (refused) return refused;
    await mailInvite(c.env, c.var.p, c.var.ctx.orgId, invite, mailOrigin(c.env, c.req.url));
    return c.json({ ok: true, invite: (await getOrgInvite(c.var.p, c.var.ctx.orgId, id))! });
  } catch (e) { return orgFail(c, e); }
});
orgTenantApp.post("/invites/:id/revoke", async (c) => {
  const id = inviteId(c);
  if (id === null) return c.json({ error: "not_found" }, 404);
  try {
    await revokeInvite(c.var.p, c.var.ctx, id);
    return c.json({ ok: true });
  } catch (e) { return orgFail(c, e); }
});
