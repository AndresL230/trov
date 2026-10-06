// The superadmin's writes and reads over the GLOBAL tables (canopy-multitenancy.md §5.4): take on an
// org and name its admin, suspend / restore it, the org-creation cap, the superadmin list, the audit
// trail. Every caller is behind `requireSuperadmin` (src/platform/routes.ts). Nothing here makes the
// superadmin a member of anything — no backdoor into an org's content. The cross-org usage reads over
// TENANT tables live in ./usage.ts, and only there.
import { type PlatformContext, first, all, stmt, batch, nowIso } from "../data/platform-sql";
import {
  OrgError, auditStmt, createOrg, getOrgBySlug, inviteStmt, listOrgInvites, neverJoined, parseInviteAddress, personForAddress,
  type InviteAddress, type OrgRow,
} from "../orgs/repo";
import type {
  AdminAssignment, PlatformAdmin, PlatformAuditRow, PlatformOrgMember, PlatformOrgOwner, PlatformOrgRow, OrgInvite,
} from "@shared/orgs";

export type PlatformErrorCode = "invalid_admin" | "no_such_person" | "invalid_limit" | "last_superadmin" | "not_found";
export const PLATFORM_ERROR_STATUS: Record<PlatformErrorCode, 400 | 404 | 409> = {
  invalid_admin: 400, no_such_person: 404, invalid_limit: 400, last_superadmin: 409, not_found: 404,
};
export class PlatformError extends Error {
  constructor(readonly code: PlatformErrorCode, message?: string) { super(message ?? code); }
}

const personHandle = async (p: PlatformContext, handle: string): Promise<string | null> =>
  (await first<{ handle: string }>(p, `SELECT handle FROM persons WHERE handle = ? COLLATE NOCASE`, handle))?.handle ?? null;

// ── naming an org's admin ────────────────────────────────────────────────────

type Resolved = { person: string } | { address: InviteAddress };

/**
 * `{ handle }` must be an existing person (404 otherwise — a handle cannot be invited). `{ github_login }`
 * / `{ email }` resolve to the person who holds that GitHub identity / provider-verified email today, or,
 * when nobody does, to an address to invite.
 */
async function resolveAdmin(p: PlatformContext, target: unknown): Promise<Resolved> {
  const t = (target && typeof target === "object" ? target : {}) as { handle?: unknown; github_login?: unknown; email?: unknown };
  const given = [t.handle, t.github_login, t.email].filter((v) => v !== undefined && v !== null && v !== "");
  if (given.length !== 1) throw new PlatformError("invalid_admin", "name the admin by exactly one of handle, github_login or email");
  if (t.handle !== undefined && t.handle !== null && t.handle !== "") {
    const person = typeof t.handle === "string" ? await personHandle(p, t.handle.trim()) : null;
    if (!person) throw new PlatformError("no_such_person", "no person has that handle — invite them by github_login or email");
    return { person };
  }
  let address: InviteAddress;
  try {
    address = parseInviteAddress(t);
  } catch (e) {
    throw new PlatformError("invalid_admin", e instanceof Error ? e.message : undefined);
  }
  const person = await personForAddress(p, address);
  return person ? { person } : { address };
}

/**
 * "Take on a new org and assign its admin." An existing person becomes the OWNER in the creating batch.
 * Anyone else gets a pending `as_owner` invite (0043): when they sign in and accept, they are the owner.
 * The superadmin (`p.actor`, recorded as `created_by`) is never made a member.
 */
export async function createOrgWithAdmin(p: PlatformContext, input: { slug: string; name: string; admin: unknown }): Promise<{ org: OrgRow; admin: AdminAssignment; first_join: boolean }> {
  const who = await resolveAdmin(p, input.admin);
  if ("person" in who) {
    const firstJoin = await neverJoined(p, who.person);
    const org = await createOrg(p, { slug: input.slug, name: input.name, owner: who.person });
    return { org, admin: { status: "owner", handle: who.person }, first_join: firstJoin };
  }
  const org = await createOrg(p, {
    slug: input.slug, name: input.name, owner: null,
    extra: (orgId, at) => [
      inviteStmt(p, orgId, who.address, "admin", true, at),
      auditStmt(p, orgId, "invite.create", "owner-invite", { ...who.address, role: "owner" }, at),
    ],
  });
  const invite = (await listOrgInvites(p, org.id, { pendingOnly: true }))[0];
  return { org, admin: { status: "invited", invite_id: invite.id, github_login: invite.github_login, email: invite.email }, first_join: false };
}

/**
 * Name an (additional) owner of an existing org — how an org whose admin left is rescued. An existing
 * person becomes an owner now (a current member is lifted to owner); anyone else gets an owner invite,
 * and a pending invite to the same address is upgraded to one rather than refused.
 */
export async function assignOrgAdmin(p: PlatformContext, slug: string, target: unknown): Promise<{ org_id: string; admin: AdminAssignment; first_join: boolean }> {
  const org = await getOrgBySlug(p, slug);
  if (!org) throw new PlatformError("not_found");
  const who = await resolveAdmin(p, target);
  const at = nowIso();
  if ("person" in who) {
    const firstJoin = await neverJoined(p, who.person);
    await batch(p, [
      stmt(p, `INSERT INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, ?, 'owner', ?, ?)
               ON CONFLICT(org_id, user_id) DO UPDATE SET role = 'owner'`, org.id, who.person, at, p.actor),
      auditStmt(p, org.id, "member.add", who.person, { role: "owner", by: "platform" }, at),
    ]);
    return { org_id: org.id, admin: { status: "owner", handle: who.person }, first_join: firstJoin };
  }
  const a = who.address;
  const pending = `org_id = ? AND status = 'pending' AND ${a.github_login !== undefined ? "github_login" : "email"} = ?`;
  const key = a.github_login ?? a.email;
  await batch(p, [
    stmt(p, `UPDATE org_invites SET as_owner = 1 WHERE ${pending}`, org.id, key),
    stmt(p, `INSERT INTO org_invites (org_id, github_login, email, role, as_owner, invited_by, status, created_at)
             SELECT ?, ?, ?, 'admin', 1, ?, 'pending', ? WHERE changes() = 0`, org.id, a.github_login ?? null, a.email ?? null, p.actor, at),
    auditStmt(p, org.id, "invite.create", "owner-invite", { ...a, role: "owner" }, at),
  ]);
  const row = await first<{ id: number; github_login: string | null; email: string | null }>(p,
    `SELECT id, github_login, email FROM org_invites WHERE ${pending}`, org.id, key);
  return { org_id: org.id, admin: { status: "invited", invite_id: row!.id, github_login: row!.github_login, email: row!.email }, first_join: false };
}

// ── the org list and one org ─────────────────────────────────────────────────

const toRow = (o: OrgRow, x: { owners: PlatformOrgOwner[]; members: number; invites: number; last: string | null }): PlatformOrgRow => ({
  slug: o.slug, name: o.name, status: o.suspended_at ? "suspended" : "active", created_at: o.created_at, created_by: o.created_by,
  suspended_at: o.suspended_at, suspended_by: o.suspended_by,
  owners: x.owners, member_count: x.members, pending_invites: x.invites, last_activity_at: x.last,
});

/** Every org, suspended ones included, newest first. `slug` narrows to one. */
export async function listPlatformOrgs(p: PlatformContext, slug?: string): Promise<(PlatformOrgRow & { id: string })[]> {
  const [orgs, owners, members, invites, last] = await Promise.all([
    all<OrgRow>(p, `SELECT id, slug, name, created_at, created_by, suspended_at, suspended_by FROM orgs
                     ${slug === undefined ? "" : "WHERE slug = ?"} ORDER BY created_at DESC, slug ASC`, ...(slug === undefined ? [] : [slug])),
    all<{ org_id: string; handle: string; name: string | null }>(p,
      `SELECT m.org_id, pe.handle, pe.name FROM memberships m JOIN persons pe ON pe.handle = m.user_id COLLATE NOCASE
        WHERE m.role = 'owner' ORDER BY pe.handle COLLATE NOCASE ASC`),
    all<{ org_id: string; n: number }>(p, `SELECT org_id, COUNT(*) AS n FROM memberships GROUP BY org_id`),
    all<{ org_id: string; n: number }>(p, `SELECT org_id, COUNT(*) AS n FROM org_invites WHERE status = 'pending' GROUP BY org_id`),
    all<{ org_id: string; at: string | null }>(p, `SELECT org_id, MAX(last_at) AS at FROM org_usage_daily GROUP BY org_id`),
  ]);
  const count = (rows: { org_id: string; n: number }[], id: string) => rows.find((r) => r.org_id === id)?.n ?? 0;
  return orgs.map((o) => ({
    id: o.id,
    ...toRow(o, {
      owners: owners.filter((r) => r.org_id === o.id).map(({ handle, name }) => ({ handle, name })),
      members: count(members, o.id), invites: count(invites, o.id), last: last.find((r) => r.org_id === o.id)?.at ?? null,
    }),
  }));
}

/** One org's people, as the superadmin sees them: who, and in what role — never the org's content. */
export async function platformOrgPeople(p: PlatformContext, orgId: string): Promise<{ members: PlatformOrgMember[]; invites: OrgInvite[] }> {
  const [members, invites] = await Promise.all([
    all<PlatformOrgMember>(p,
      `SELECT pe.handle, pe.name, m.role, m.title, m.created_at AS joined_at
         FROM memberships m JOIN persons pe ON pe.handle = m.user_id COLLATE NOCASE WHERE m.org_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, pe.handle COLLATE NOCASE ASC`, orgId),
    listOrgInvites(p, orgId, { pendingOnly: true }),
  ]);
  return { members, invites };
}

// ── suspend / unsuspend ──────────────────────────────────────────────────────

/** Suspended: the tenant gates answer 404 to its members and its bearer tokens stop resolving
 *  (src/data/suspension.ts). No row is touched but the org's own. Idempotent. */
export async function setSuspended(p: PlatformContext, slug: string, suspended: boolean): Promise<void> {
  const org = await getOrgBySlug(p, slug);
  if (!org) throw new PlatformError("not_found");
  if ((org.suspended_at !== null) === suspended) return;
  const at = nowIso();
  await batch(p, [
    suspended
      ? stmt(p, `UPDATE orgs SET suspended_at = ?, suspended_by = ? WHERE id = ?`, at, p.actor, org.id)
      : stmt(p, `UPDATE orgs SET suspended_at = NULL, suspended_by = NULL WHERE id = ?`, org.id),
    auditStmt(p, org.id, suspended ? "org.suspend" : "org.unsuspend", org.slug, {}, at),
  ]);
}

// ── persons: the org-creation cap ────────────────────────────────────────────

/** `limit` = how many orgs the person may create; null restores the default (shared/orgs.ts DEFAULT_ORG_LIMIT). */
export async function setOrgLimit(p: PlatformContext, handle: string, limit: unknown): Promise<{ handle: string; org_limit: number | null }> {
  if (limit !== null && !(typeof limit === "number" && Number.isInteger(limit) && limit >= 0 && limit <= 1000)) {
    throw new PlatformError("invalid_limit", "limit is a whole number from 0 to 1000, or null for the default");
  }
  const person = await personHandle(p, handle);
  if (!person) throw new PlatformError("no_such_person");
  await batch(p, [
    stmt(p, `UPDATE persons SET org_limit = ? WHERE handle = ?`, limit, person),
    auditStmt(p, null, "platform.org_limit", person, { limit }),
  ]);
  return { handle: person, org_limit: limit };
}

// ── superadmins ──────────────────────────────────────────────────────────────

export function listAdmins(p: PlatformContext): Promise<PlatformAdmin[]> {
  return all<PlatformAdmin>(p,
    `SELECT pe.handle, pe.name, a.granted_at, a.granted_by FROM platform_admins a JOIN persons pe ON pe.handle = a.person COLLATE NOCASE
      ORDER BY a.granted_at ASC, pe.handle COLLATE NOCASE ASC`);
}

export async function grantAdmin(p: PlatformContext, handle: unknown): Promise<void> {
  const person = typeof handle === "string" ? await personHandle(p, handle.trim()) : null;
  if (!person) throw new PlatformError("no_such_person");
  const at = nowIso();
  await batch(p, [
    stmt(p, `INSERT OR IGNORE INTO platform_admins (person, granted_at, granted_by) VALUES (?, ?, ?)`, person, at, p.actor),
    stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) SELECT NULL, ?, 'platform.admin.grant', ?, '{}', ? WHERE changes() > 0`,
      p.actor, person, at),
  ]);
}

/** The last superadmin cannot be removed (409) — the guard is in the DELETE itself. */
export async function revokeAdmin(p: PlatformContext, handle: string): Promise<void> {
  if (!(await first(p, `SELECT 1 AS x FROM platform_admins WHERE person = ? COLLATE NOCASE`, handle))) throw new PlatformError("not_found");
  const at = nowIso();
  const [res] = await batch(p, [
    stmt(p, `DELETE FROM platform_admins WHERE person = ? COLLATE NOCASE AND (SELECT COUNT(*) FROM platform_admins) > 1`, handle),
    stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) SELECT NULL, ?, 'platform.admin.revoke', ?, '{}', ? WHERE changes() > 0`,
      p.actor, handle, at),
  ]);
  if ((res.meta.changes ?? 0) === 0) throw new PlatformError("last_superadmin");
}

// ── audit ────────────────────────────────────────────────────────────────────

const parseDetail = (s: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * Recent audit rows across orgs, newest first: the org-administration trail (`org_admin_audit`, 0043)
 * and the integration-secrets trail (`org_audit`, 0037) as one list. Neither ever holds a secret value
 * (`org_audit.detail` carries a last-4 hint and a key version at most). `orgSlug` narrows to one org.
 */
export async function listAudit(p: PlatformContext, opts: { orgSlug?: string; limit?: number } = {}): Promise<PlatformAuditRow[]> {
  const limit = Math.trunc(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  let orgId: string | null = null;
  if (opts.orgSlug !== undefined) {
    orgId = (await getOrgBySlug(p, opts.orgSlug))?.id ?? null;
    if (!orgId) throw new PlatformError("not_found");
  }
  const where = orgId ? "WHERE a.org_id = ?" : "";
  const bind = orgId ? [orgId] : [];
  const rows = await all<{ id: string; org: string | null; actor: string; action: string; target: string; detail: string; at: string }>(p,
    `SELECT * FROM (
       SELECT 'a' || a.id AS id, o.slug AS org, a.actor, a.action, a.target, a.detail, a.at
         FROM org_admin_audit a LEFT JOIN orgs o ON o.id = a.org_id ${where}
       UNION ALL
       SELECT 's' || a.id AS id, o.slug AS org, a.actor, a.action, a.target, a.detail, a.at
         FROM org_audit a LEFT JOIN orgs o ON o.id = a.org_id ${where}
     ) ORDER BY at DESC, id DESC LIMIT ${limit}`, ...bind, ...bind);
  return rows.map((r) => ({ ...r, detail: parseDetail(r.detail) }));
}
