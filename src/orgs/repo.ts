// Orgs, memberships and org invites (canopy-multitenancy.md §5.3). A PLATFORM module: `orgs`,
// `memberships`, `org_invites` and `org_admin_audit` are global tables, read and written through a
// PlatformContext. A function that acts INSIDE one org also takes the caller's TenantContext — the org
// it names and the role it checks come from the membership the gate already resolved, never a request value.
import {
  type PlatformContext, type Stmt, first, all, run, stmt, batch, nowIso,
} from "../data/platform-sql";
import { stmt as tenantStmt } from "../data/sql";
import { systemTenant, isSuperadmin, requireRole, hasRole, type TenantContext } from "../data/context";
import { REGISTRY } from "../notifications/registry";
import { DEFAULT_SETTINGS } from "../notifications/cron";
import { avatarSrc, ROLE_MAX, RESPONSIBILITIES_MAX } from "@shared/people";
import type { PersonColor } from "@shared/rows";
import {
  DEFAULT_ORG_LIMIT, ORG_NAME_MAX, GITHUB_LOGIN_RE, INVITE_EMAIL_RE, orgSlugProblem,
  type OrgRole, type OrgAuditAction, type MyOrg, type MyInvite, type MyOrgsResponse, type OrgSettings,
  type OrgMember, type OrgInvite, type OrgMeResponse,
} from "@shared/orgs";

export type OrgErrorCode =
  | "invalid_slug" | "reserved_slug" | "invalid_name" | "invalid_invite" | "invalid_member"
  | "slug_taken" | "org_limit" | "not_found" | "last_owner" | "invite_exists" | "already_member";

export const ORG_ERROR_STATUS: Record<OrgErrorCode, 400 | 403 | 404 | 409> = {
  invalid_slug: 400, reserved_slug: 400, invalid_name: 400, invalid_invite: 400, invalid_member: 400,
  slug_taken: 409, org_limit: 403, not_found: 404, last_owner: 409, invite_exists: 409, already_member: 409,
};

export class OrgError extends Error {
  constructor(readonly code: OrgErrorCode, message?: string) { super(message ?? code); }
}

export interface OrgRow {
  id: string; slug: string; name: string; created_at: string; created_by: string;
  suspended_at: string | null; suspended_by: string | null;
}

const isUniqueViolation = (e: unknown): boolean => /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));

/** One `org_admin_audit` row — always a statement in the SAME batch as the change it records. */
export function auditStmt(p: PlatformContext, orgId: string | null, action: OrgAuditAction, target: string, detail: Record<string, unknown> = {}, at: string = nowIso()): Stmt {
  return stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    orgId, p.actor, action, target, JSON.stringify(detail), at);
}

export function getOrgBySlug(p: PlatformContext, slug: string): Promise<OrgRow | null> {
  return first<OrgRow>(p, `SELECT id, slug, name, created_at, created_by, suspended_at, suspended_by FROM orgs WHERE slug = ?`, slug);
}

// ── create ───────────────────────────────────────────────────────────────────

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** `org_` + 26 random base32 characters (130 bits). */
export function newOrgId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return "org_" + Array.from(bytes, (b) => B32[b & 31]).join("");
}

export function cleanOrgName(name: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  if (n.length < 1 || n.length > ORG_NAME_MAX) throw new OrgError("invalid_name", `an org name is 1–${ORG_NAME_MAX} characters`);
  return n;
}

/** How many orgs `handle` has created, and how many they may (null = no cap: a superadmin). */
export async function orgAllowance(p: PlatformContext, handle: string): Promise<{ created: number; limit: number | null; can_create: boolean; superadmin: boolean }> {
  const [superadmin, row] = await Promise.all([
    isSuperadmin(p, handle),
    first<{ created: number; org_limit: number | null }>(p,
      `SELECT (SELECT COUNT(*) FROM orgs WHERE created_by = ?1 COLLATE NOCASE) AS created,
              (SELECT org_limit FROM persons WHERE handle = ?1 COLLATE NOCASE) AS org_limit`, handle),
  ]);
  const created = row?.created ?? 0;
  const limit = superadmin ? null : row?.org_limit ?? DEFAULT_ORG_LIMIT;
  return { created, limit, can_create: limit === null || created < limit, superadmin };
}

export interface CreateOrgInput {
  slug: string;
  name: string;
  /** The person who becomes the org's first OWNER; null when a superadmin creates it for someone who
   *  is invited instead (they are NOT made a member — §5.4). */
  owner: string | null;
  /** Statements to run in the same batch, given the new org's id (the superadmin's owner invite). */
  extra?: (orgId: string, at: string) => Stmt[];
}

/**
 * THE way an org comes to exist: the `orgs` row, its owner's membership, and every per-org singleton a
 * working org reads — what 0037–0039 seeded for SaplingLearn: the `plan` row, `notification_settings`,
 * one `notification_policy` row per registry kind, and both `org_counters` — in ONE batch. `p.actor`
 * is recorded as `created_by` (what the creation cap counts). The cap itself is the caller's to
 * enforce (`orgAllowance`): a superadmin taking on an org is not subject to it.
 */
export async function createOrg(p: PlatformContext, input: CreateOrgInput): Promise<OrgRow> {
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  const problem = orgSlugProblem(slug);
  if (problem === "invalid") throw new OrgError("invalid_slug", "a slug is 2–39 characters: lowercase letters, digits and hyphens, not starting with a hyphen");
  if (problem === "reserved") throw new OrgError("reserved_slug", `"${slug}" is reserved`);
  const name = cleanOrgName(input.name);
  if (await first(p, `SELECT 1 AS x FROM orgs WHERE slug = ?`, slug)) throw new OrgError("slug_taken");

  const id = newOrgId();
  const at = nowIso();
  const sys = systemTenant(p, id, "system"); // the tenant rows below are written AS the new org
  const stmts: Stmt[] = [
    stmt(p, `INSERT INTO orgs (id, slug, name, created_at, created_by) VALUES (?, ?, ?, ?, ?)`, id, slug, name, at, p.actor),
    stmt(p, `INSERT INTO org_counters (org_id, name, value) VALUES (?, 'ticket', 0), (?, 'handoff', 0)`, id, id),
    tenantStmt(sys, `INSERT INTO plan (org_id, narrative, current_version) VALUES (?, '', 0)`, sys.orgId),
    tenantStmt(sys, `INSERT INTO notification_settings (org_id, send_hour, timezone, from_address) VALUES (?, ?, ?, ?)`,
      sys.orgId, DEFAULT_SETTINGS.send_hour, DEFAULT_SETTINGS.timezone, DEFAULT_SETTINGS.from_address),
    ...REGISTRY.map((k) => tenantStmt(sys,
      `INSERT INTO notification_policy (org_id, kind, default_cadence, enabled, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, 'registry')`,
      sys.orgId, k.id, k.defaultCadence, at)),
    auditStmt(p, id, "org.create", slug, { name, owner: input.owner }, at),
  ];
  if (input.owner) {
    stmts.push(
      stmt(p, `INSERT INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, ?, 'owner', ?, ?)`, id, input.owner, at, p.actor),
      auditStmt(p, id, "member.add", input.owner, { role: "owner" }, at),
    );
  }
  if (input.extra) stmts.push(...input.extra(id, at));
  try {
    await batch(p, stmts);
  } catch (e) {
    if (isUniqueViolation(e)) throw new OrgError("slug_taken"); // lost a race for the slug
    throw e;
  }
  return { id, slug, name, created_at: at, created_by: p.actor, suspended_at: null, suspended_by: null };
}

/** `POST /api/orgs`: any signed-in person, under their cap; they become the owner. */
export async function createOrgForSelf(p: PlatformContext, handle: string, input: { slug: string; name: string }): Promise<OrgRow> {
  const allowance = await orgAllowance(p, handle);
  if (!allowance.can_create) throw new OrgError("org_limit", `you can create at most ${allowance.limit} orgs`);
  // Awaited, not returned: workerd reports a refusal thrown before the caller's handler attaches as unhandled.
  return await createOrg(p, { slug: input.slug, name: input.name, owner: handle });
}

// ── the caller's orgs and invites ────────────────────────────────────────────

export function listMyOrgs(p: PlatformContext, handle: string): Promise<MyOrg[]> {
  return all<MyOrg>(p,
    `SELECT o.slug, o.name, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? COLLATE NOCASE AND o.suspended_at IS NULL ORDER BY o.name COLLATE NOCASE ASC`, handle);
}

interface InviteJoinRow {
  id: number; org_id: string; slug: string; name: string; role: "admin" | "member"; as_owner: number;
  invited_by: string; created_at: string; github_login: string | null; email: string | null;
}

// §5.3: an invite is the caller's when its GitHub login is one of THEIR GitHub identity logins, or its
// email is one of THEIR provider-verified emails — never `persons.email`, which the person can edit.
// (Both invite columns are COLLATE NOCASE, and `IN` compares with the left operand's collation.)
const MINE = `(
  i.github_login IN (SELECT subject FROM identities WHERE person = ?1 COLLATE NOCASE AND provider = 'github')
  OR i.email IN (SELECT verified_email FROM identities WHERE person = ?1 COLLATE NOCASE AND verified_email IS NOT NULL))`;
const INVITE_JOIN = `SELECT i.id, i.org_id, o.slug, o.name, i.role, i.as_owner, i.invited_by, i.created_at, i.github_login, i.email
  FROM org_invites i JOIN orgs o ON o.id = i.org_id
 WHERE i.status = 'pending' AND o.suspended_at IS NULL AND ${MINE}`;

const grantedRole = (r: { role: "admin" | "member"; as_owner: number }): OrgRole => (r.as_owner ? "owner" : r.role);

export async function listMyInvites(p: PlatformContext, handle: string): Promise<MyInvite[]> {
  const rows = await all<InviteJoinRow>(p, `${INVITE_JOIN} ORDER BY i.created_at DESC, i.id DESC`, handle);
  return rows.map((r) => ({
    id: r.id, org: { slug: r.slug, name: r.name }, role: grantedRole(r), invited_by: r.invited_by,
    created_at: r.created_at, github_login: r.github_login, email: r.email,
  }));
}

export async function myOrgs(p: PlatformContext, handle: string): Promise<MyOrgsResponse> {
  const [orgs, invites, allowance] = await Promise.all([listMyOrgs(p, handle), listMyInvites(p, handle), orgAllowance(p, handle)]);
  return { orgs, invites, superadmin: allowance.superadmin, can_create: allowance.can_create, created: allowance.created, limit: allowance.limit };
}

/**
 * Accept or decline one of the caller's pending invites. The match is re-checked in the statement that
 * reads the invite, so an id that is not theirs — someone else's, answered, revoked, unknown — is
 * `not_found` for all alike. Accepting inserts the membership and stamps the invite in one batch; an
 * `as_owner` invite (0043, a superadmin's) grants OWNER, and lifts an existing member to owner.
 */
export async function respondToInvite(p: PlatformContext, handle: string, id: number, accept: boolean): Promise<{ org: { slug: string; name: string }; role: OrgRole | null }> {
  const inv = await first<InviteJoinRow>(p, `${INVITE_JOIN} AND i.id = ?2`, handle, id);
  if (!inv) throw new OrgError("not_found");
  const at = nowIso();
  const role = grantedRole(inv);
  const stamp = stmt(p, `UPDATE org_invites SET status = ?, responded_at = ?, responded_by = ? WHERE id = ? AND status = 'pending'`,
    accept ? "accepted" : "declined", at, handle, id);
  if (!accept) {
    await batch(p, [stamp, auditStmt(p, inv.org_id, "invite.decline", `invite:${id}`, {}, at)]);
    return { org: { slug: inv.slug, name: inv.name }, role: null };
  }
  await batch(p, [
    stamp,
    // Already a member (invited twice, or an owner invite for a current member): never a demotion.
    stmt(p, `INSERT INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(org_id, user_id) DO UPDATE SET role = CASE WHEN excluded.role = 'owner' THEN 'owner' ELSE memberships.role END`,
      inv.org_id, handle, role, at, inv.invited_by),
    auditStmt(p, inv.org_id, "invite.accept", `invite:${id}`, { role }, at),
    auditStmt(p, inv.org_id, "member.add", handle, { role, invite: id }, at),
  ]);
  return { org: { slug: inv.slug, name: inv.name }, role };
}

// ── inside one org: me, settings ─────────────────────────────────────────────

export async function orgMe(p: PlatformContext, ctx: TenantContext): Promise<Omit<OrgMeResponse, "repos"> | null> {
  const row = await first<{ slug: string; name: string; role: OrgRole; title: string | null; responsibilities: string | null }>(p,
    `SELECT o.slug, o.name, m.role, m.title, m.responsibilities FROM orgs o JOIN memberships m ON m.org_id = o.id
      WHERE o.id = ? AND m.user_id = ? COLLATE NOCASE`, ctx.orgId, ctx.userId);
  return row ? { org: { slug: row.slug, name: row.name }, role: row.role, title: row.title, responsibilities: row.responsibilities } : null;
}

export async function getOrgSettings(p: PlatformContext, ctx: TenantContext): Promise<OrgSettings | null> {
  return first<OrgSettings>(p, `SELECT slug, name, created_at, created_by FROM orgs WHERE id = ?`, ctx.orgId);
}

/** Admin+. The slug is not editable: it is every member's URL. */
export async function updateOrgSettings(p: PlatformContext, ctx: TenantContext, patch: { name: unknown }): Promise<OrgSettings> {
  requireRole(ctx, "admin");
  const name = cleanOrgName(patch.name);
  await batch(p, [
    stmt(p, `UPDATE orgs SET name = ? WHERE id = ?`, name, ctx.orgId),
    auditStmt(p, ctx.orgId, "org.update", "settings", { name }),
  ]);
  return (await getOrgSettings(p, ctx))!;
}

// ── members ──────────────────────────────────────────────────────────────────

interface MemberRow {
  handle: string; name: string | null; color: PersonColor; avatar_url: string | null; avatar_sha: string | null;
  role: OrgRole; title: string | null; responsibilities: string | null; joined_at: string;
}

/** Any member. `responsibilities` goes out only to an admin+ (shared/people.ts). Owners, then admins, then members. */
export async function listMembers(p: PlatformContext, ctx: TenantContext): Promise<OrgMember[]> {
  const rows = await all<MemberRow>(p,
    `SELECT pe.handle, pe.name, pe.color, pe.avatar_url, pe.avatar_sha, m.role, m.title, m.responsibilities, m.created_at AS joined_at
       FROM memberships m JOIN persons pe ON pe.handle = m.user_id COLLATE NOCASE
      WHERE m.org_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, pe.handle COLLATE NOCASE ASC`, ctx.orgId);
  const admin = hasRole(ctx, "admin");
  return rows.map((r) => ({
    handle: r.handle, name: r.name, color: r.color, avatar_url: avatarSrc(r), role: r.role, title: r.title,
    ...(admin ? { responsibilities: r.responsibilities } : {}), joined_at: r.joined_at,
  }));
}

const memberOf = (p: PlatformContext, orgId: string, handle: string) =>
  first<{ user_id: string; role: OrgRole; title: string | null; responsibilities: string | null }>(p,
    `SELECT user_id, role, title, responsibilities FROM memberships WHERE org_id = ? AND user_id = ? COLLATE NOCASE`, orgId, handle);
const ownerCount = async (p: PlatformContext, orgId: string): Promise<number> =>
  (await first<{ n: number }>(p, `SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'`, orgId))?.n ?? 0;

const cleanText = (v: unknown, max: number, field: string): string | null => {
  if (v === null) return null;
  if (typeof v !== "string") throw new OrgError("invalid_member", `${field} must be text or null`);
  const t = v.trim();
  if (t.length > max) throw new OrgError("invalid_member", `${field} is at most ${max} characters`);
  return t === "" ? null : t;
};

export interface MemberPatch { role?: unknown; title?: unknown; responsibilities?: unknown }

/**
 * Admin+ edits a member's role, title and responsibilities. Only an OWNER grants or revokes `owner`;
 * the last owner cannot be demoted (409 `last_owner`) — checked here for the message and again in the
 * UPDATE itself, so two concurrent demotions cannot leave an org with no owner.
 */
export async function updateMember(p: PlatformContext, ctx: TenantContext, handle: string, patch: MemberPatch): Promise<void> {
  requireRole(ctx, "admin");
  const cur = await memberOf(p, ctx.orgId, handle);
  if (!cur) throw new OrgError("not_found");
  let role = cur.role;
  if (patch.role !== undefined) {
    if (patch.role !== "owner" && patch.role !== "admin" && patch.role !== "member") throw new OrgError("invalid_member", "role must be owner, admin or member");
    role = patch.role;
  }
  const title = patch.title === undefined ? cur.title : cleanText(patch.title, ROLE_MAX, "title");
  const responsibilities = patch.responsibilities === undefined ? cur.responsibilities : cleanText(patch.responsibilities, RESPONSIBILITIES_MAX, "responsibilities");
  if (role !== cur.role && (role === "owner" || cur.role === "owner")) requireRole(ctx, "owner");
  if (cur.role === "owner" && role !== "owner" && (await ownerCount(p, ctx.orgId)) <= 1) throw new OrgError("last_owner");

  const changed: Record<string, unknown> = {};
  if (role !== cur.role) changed.role = { from: cur.role, to: role };
  if (title !== cur.title) changed.title = title;
  if (responsibilities !== cur.responsibilities) changed.responsibilities = true; // the fact, not the text
  if (Object.keys(changed).length === 0) return;
  const [res] = await batch(p, [
    stmt(p, `UPDATE memberships SET role = ?1, title = ?2, responsibilities = ?3
              WHERE org_id = ?4 AND user_id = ?5 COLLATE NOCASE
                AND (role <> 'owner' OR ?1 = 'owner' OR (SELECT COUNT(*) FROM memberships WHERE org_id = ?4 AND role = 'owner') > 1)`,
      role, title, responsibilities, ctx.orgId, cur.user_id),
    auditStmt(p, ctx.orgId, "member.update", cur.user_id, changed),
  ]);
  if ((res.meta.changes ?? 0) === 0) throw new OrgError("last_owner");
}

/**
 * Admin+ removes a member, or anyone removes THEMSELVES (leave). Removing an owner takes an owner; the
 * last owner can neither leave nor be removed (409). One batch: the membership goes, and — only if it
 * did — that person's MCP tokens and OAuth grants INTO THIS ORG are revoked. Their authored content stays.
 */
export async function removeMember(p: PlatformContext, ctx: TenantContext, handle: string): Promise<{ left: boolean }> {
  const self = handle.toLowerCase() === ctx.userId.toLowerCase();
  if (!self) requireRole(ctx, "admin");
  const cur = await memberOf(p, ctx.orgId, handle);
  if (!cur) throw new OrgError("not_found");
  if (cur.role === "owner") {
    if (!self) requireRole(ctx, "owner");
    if ((await ownerCount(p, ctx.orgId)) <= 1) throw new OrgError("last_owner");
  }
  const at = nowIso();
  const gone = `NOT EXISTS (SELECT 1 FROM memberships WHERE org_id = ?1 AND user_id = ?2 COLLATE NOCASE)`;
  const [res] = await batch(p, [
    stmt(p, `DELETE FROM memberships WHERE org_id = ?1 AND user_id = ?2 COLLATE NOCASE
              AND (role <> 'owner' OR (SELECT COUNT(*) FROM memberships WHERE org_id = ?1 AND role = 'owner') > 1)`, ctx.orgId, cur.user_id),
    stmt(p, `UPDATE mcp_tokens SET revoked = 1 WHERE org_id = ?1 AND person = ?2 COLLATE NOCASE AND revoked = 0 AND ${gone}`, ctx.orgId, cur.user_id),
    stmt(p, `UPDATE oauth_grants SET revoked_at = ?3, revoked_reason = 'member_removed'
              WHERE org_id = ?1 AND person = ?2 COLLATE NOCASE AND revoked_at IS NULL AND ${gone}`, ctx.orgId, cur.user_id, at),
    stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) SELECT ?1, ?4, ?5, ?2, '{}', ?3 WHERE ${gone}`,
      ctx.orgId, cur.user_id, at, p.actor, (self ? "member.leave" : "member.remove") satisfies OrgAuditAction),
  ]);
  if ((res.meta.changes ?? 0) === 0) throw new OrgError("last_owner");
  return { left: self };
}

// ── invites (admin+) ─────────────────────────────────────────────────────────

interface InviteRow {
  id: number; github_login: string | null; email: string | null; role: "admin" | "member"; as_owner: number; status: OrgInvite["status"];
  invited_by: string; created_at: string; responded_at: string | null; responded_by: string | null;
}
const INVITE_COLS = `id, github_login, email, role, as_owner, status, invited_by, created_at, responded_at, responded_by`;
const toInvite = (r: InviteRow): OrgInvite => ({
  id: r.id, github_login: r.github_login, email: r.email, role: grantedRole(r), status: r.status,
  invited_by: r.invited_by, created_at: r.created_at, responded_at: r.responded_at, responded_by: r.responded_by,
});

/** An org's invites, pending first, then newest. `orgId` comes from a resolved context or a superadmin lookup. */
export async function listOrgInvites(p: PlatformContext, orgId: string, opts: { pendingOnly?: boolean } = {}): Promise<OrgInvite[]> {
  const rows = await all<InviteRow>(p,
    `SELECT ${INVITE_COLS} FROM org_invites WHERE org_id = ? ${opts.pendingOnly ? "AND status = 'pending'" : ""}
      ORDER BY (status = 'pending') DESC, created_at DESC, id DESC LIMIT 200`, orgId);
  return rows.map(toInvite);
}

export type InviteAddress = { github_login: string; email?: undefined } | { email: string; github_login?: undefined };

/** Validate "exactly one of github_login / email" and its shape; the email goes out lower-cased. */
export function parseInviteAddress(input: { github_login?: unknown; email?: unknown }): InviteAddress {
  const login = typeof input.github_login === "string" ? input.github_login.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if ((login === "") === (email === "")) throw new OrgError("invalid_invite", "give exactly one of github_login or email");
  if (login) {
    if (!GITHUB_LOGIN_RE.test(login)) throw new OrgError("invalid_invite", "not a GitHub login");
    return { github_login: login };
  }
  if (email.length > 254 || !INVITE_EMAIL_RE.test(email)) throw new OrgError("invalid_invite", "not an email address");
  return { email };
}

/** The person a GitHub login / verified email belongs to today, if exactly one does. */
export async function personForAddress(p: PlatformContext, a: InviteAddress): Promise<string | null> {
  const rows = a.github_login !== undefined
    ? await all<{ person: string }>(p, `SELECT DISTINCT person FROM identities WHERE provider = 'github' AND subject = ? COLLATE NOCASE LIMIT 2`, a.github_login)
    : await all<{ person: string }>(p, `SELECT DISTINCT person FROM identities WHERE verified_email = ? COLLATE NOCASE LIMIT 2`, a.email);
  return rows.length === 1 ? rows[0].person : null;
}

/** The pending-invite INSERT; `asOwner` is the superadmin's flag (src/platform) and nobody else's. */
export function inviteStmt(p: PlatformContext, orgId: string, a: InviteAddress, role: "admin" | "member", asOwner: boolean, at: string): Stmt {
  return stmt(p, `INSERT INTO org_invites (org_id, github_login, email, role, as_owner, invited_by, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    orgId, a.github_login ?? null, a.email ?? null, role, asOwner ? 1 : 0, p.actor, at);
}

/** Admin+ invites by GitHub login or email, as admin or member. Never an owner: that is the superadmin's. */
export async function createInvite(p: PlatformContext, ctx: TenantContext, input: { github_login?: unknown; email?: unknown; role?: unknown }): Promise<OrgInvite> {
  requireRole(ctx, "admin");
  const address = parseInviteAddress(input);
  const role = input.role === undefined ? "member" : input.role;
  if (role !== "admin" && role !== "member") throw new OrgError("invalid_invite", "role must be admin or member");
  const person = await personForAddress(p, address);
  if (person && (await memberOf(p, ctx.orgId, person))) throw new OrgError("already_member");
  const at = nowIso();
  let id: number;
  try {
    const [res] = await batch(p, [
      inviteStmt(p, ctx.orgId, address, role, false, at),
      stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at)
               VALUES (?, ?, 'invite.create', 'invite:' || last_insert_rowid(), ?, ?)`, ctx.orgId, p.actor, JSON.stringify({ ...address, role }), at),
    ]);
    id = res.meta.last_row_id;
  } catch (e) {
    if (isUniqueViolation(e)) throw new OrgError("invite_exists");
    throw e;
  }
  return toInvite((await first<InviteRow>(p, `SELECT ${INVITE_COLS} FROM org_invites WHERE id = ? AND org_id = ?`, id, ctx.orgId))!);
}

/** Admin+ revokes a PENDING invite of this org; anything else is `not_found`. */
export async function revokeInvite(p: PlatformContext, ctx: TenantContext, id: number): Promise<void> {
  requireRole(ctx, "admin");
  const at = nowIso();
  const [res] = await batch(p, [
    stmt(p, `UPDATE org_invites SET status = 'revoked', responded_at = ?, responded_by = ? WHERE id = ? AND org_id = ? AND status = 'pending'`,
      at, p.actor, id, ctx.orgId),
    stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) SELECT ?, ?, 'invite.revoke', ?, '{}', ? WHERE changes() > 0`,
      ctx.orgId, p.actor, `invite:${id}`, at),
  ]);
  if ((res.meta.changes ?? 0) === 0) throw new OrgError("not_found");
}
