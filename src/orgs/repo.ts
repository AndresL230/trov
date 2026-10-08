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
import { seatGate, SEAT_FREE, MEMBER_SEAT_FREE } from "../plans/state";
import type { PlanId, PlanOverrides, PlanSource } from "@shared/plans";
import {
  ORG_NAME_MAX, GITHUB_LOGIN_RE, INVITE_EMAIL_RE, orgSlugProblem,
  type OrgRole, type OrgAuditAction, type MyOrg, type MyInvite, type MyOrgsResponse, type OrgSettings,
  type OrgMember, type OrgInvite, type OrgMeResponse, type OrgLogoSource, type InviteMailStatus, INVITE_NAME_MAX, orgLogoSrc, orgLogoOf,
} from "@shared/orgs";

export type OrgErrorCode =
  | "invalid_slug" | "reserved_slug" | "invalid_name" | "invalid_invite" | "invalid_member"
  | "slug_taken" | "no_grant" | "free_org_limit" | "not_found" | "last_owner" | "invite_exists" | "already_member" | "no_address";

export const ORG_ERROR_STATUS: Record<OrgErrorCode, 400 | 403 | 404 | 409> = {
  invalid_slug: 400, reserved_slug: 400, invalid_name: 400, invalid_invite: 400, invalid_member: 400,
  slug_taken: 409, no_grant: 403, free_org_limit: 403, not_found: 404, last_owner: 409, invite_exists: 409, already_member: 409, no_address: 409,
};

export class OrgError extends Error {
  constructor(readonly code: OrgErrorCode, message?: string) { super(message ?? code); }
}

export interface OrgRow {
  id: string; slug: string; name: string; created_at: string; created_by: string;
  suspended_at: string | null; suspended_by: string | null;
  /** The image the org shows (0042_organizations) — on the wire it is `logo_url` (`orgLogoSrc`). */
  logo_sha: string | null;
}

const isUniqueViolation = (e: unknown): boolean => /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));

/** One `org_admin_audit` row — always a statement in the SAME batch as the change it records. */
export function auditStmt(p: PlatformContext, orgId: string | null, action: OrgAuditAction, target: string, detail: Record<string, unknown> = {}, at: string = nowIso()): Stmt {
  return stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    orgId, p.actor, action, target, JSON.stringify(detail), at);
}

export function getOrgBySlug(p: PlatformContext, slug: string): Promise<OrgRow | null> {
  return first<OrgRow>(p, `SELECT id, slug, name, created_at, created_by, suspended_at, suspended_by, logo_sha FROM orgs WHERE slug = ?`, slug);
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

/** The plan a new org starts on (0044_plans) — REQUIRED, so no path creates an org without choosing one. */
export interface OrgPlanSeed { id: PlanId; overrides: PlanOverrides; source: PlanSource }

export interface CreateOrgInput {
  slug: string;
  name: string;
  /** The person who becomes the org's first OWNER; null when a superadmin creates it for someone who
   *  is invited instead (they are NOT made a member — §5.4). */
  owner: string | null;
  plan: OrgPlanSeed;
  /** Statements to run in the same batch, given the new org's id (the superadmin's owner invite). */
  extra?: (orgId: string, at: string) => Stmt[];
}

/**
 * THE way an org comes to exist: the `orgs` row, its owner's membership, and every per-org singleton a
 * working org reads — what 0042_organizations seeded for SaplingLearn: the `plan` row, `notification_settings`,
 * one `notification_policy` row per registry kind, and both `org_counters` — in ONE batch, on the plan
 * `input.plan` names. `p.actor` is recorded as `created_by`. WHO may create one is the caller's to
 * enforce: a superadmin (src/platform `createOrgWithAdmin`), a person using a grant
 * (src/plans/grants.ts `createOrgFromGrant`, whose consuming statement rides in `extra`), or a person
 * creating a Free one of their own (src/plans/free.ts `createFreeOrg`, whose guard rides in `extra`).
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
    stmt(p, `INSERT INTO orgs (id, slug, name, created_at, created_by, plan, plan_overrides, plan_source, plan_status, plan_changed_at, plan_changed_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      id, slug, name, at, p.actor, input.plan.id, JSON.stringify(input.plan.overrides), input.plan.source, at, p.actor),
    stmt(p, `INSERT INTO org_counters (org_id, name, value) VALUES (?, 'ticket', 0), (?, 'handoff', 0)`, id, id),
    tenantStmt(sys, `INSERT INTO plan (org_id, narrative, current_version) VALUES (?, '', 0)`, sys.orgId),
    tenantStmt(sys, `INSERT INTO notification_settings (org_id, send_hour, timezone, from_address) VALUES (?, ?, ?, ?)`,
      sys.orgId, DEFAULT_SETTINGS.send_hour, DEFAULT_SETTINGS.timezone, DEFAULT_SETTINGS.from_address),
    ...REGISTRY.map((k) => tenantStmt(sys,
      `INSERT INTO notification_policy (org_id, kind, default_cadence, enabled, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, 'registry')`,
      sys.orgId, k.id, k.defaultCadence, at)),
    auditStmt(p, id, "org.create", slug, { name, owner: input.owner, plan: input.plan.id }, at),
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
  return { id, slug, name, created_at: at, created_by: p.actor, suspended_at: null, suspended_by: null, logo_sha: null };
}

// ── the caller's orgs and invites ────────────────────────────────────────────

export async function listMyOrgs(p: PlatformContext, handle: string): Promise<MyOrg[]> {
  const rows = await all<{ slug: string; name: string; role: OrgRole; logo_sha: string | null }>(p,
    `SELECT o.slug, o.name, m.role, o.logo_sha FROM memberships m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? COLLATE NOCASE AND o.suspended_at IS NULL ORDER BY o.name COLLATE NOCASE ASC`, handle);
  return rows.map((r) => ({ slug: r.slug, name: r.name, role: r.role, logo_url: orgLogoSrc(r) }));
}

interface InviteJoinRow {
  id: number; org_id: string; slug: string; name: string; logo_sha: string | null; role: "admin" | "member"; as_owner: number;
  invited_by: string; created_at: string; github_login: string | null; email: string | null;
}

// §5.3: an invite is the caller's when its GitHub login is one of THEIR GitHub identity logins, or its
// email is one of THEIR provider-verified emails — never `persons.email`, which the person can edit.
// (Both invite columns are COLLATE NOCASE, and `IN` compares with the left operand's collation.)
const MINE = `(
  i.github_login IN (SELECT subject FROM identities WHERE person = ?1 COLLATE NOCASE AND provider = 'github')
  OR i.email IN (SELECT verified_email FROM identities WHERE person = ?1 COLLATE NOCASE AND verified_email IS NOT NULL))`;
const INVITE_JOIN = `SELECT i.id, i.org_id, o.slug, o.name, o.logo_sha, i.role, i.as_owner, i.invited_by, i.created_at, i.github_login, i.email
  FROM org_invites i JOIN orgs o ON o.id = i.org_id
 WHERE i.status = 'pending' AND o.suspended_at IS NULL AND ${MINE}`;

const grantedRole = (r: { role: "admin" | "member"; as_owner: number }): OrgRole => (r.as_owner ? "owner" : r.role);

export async function listMyInvites(p: PlatformContext, handle: string): Promise<MyInvite[]> {
  const rows = await all<InviteJoinRow>(p, `${INVITE_JOIN} ORDER BY i.created_at DESC, i.id DESC`, handle);
  return rows.map((r) => ({
    id: r.id, org: { slug: r.slug, name: r.name, logo_url: orgLogoSrc(r) }, role: grantedRole(r), invited_by: r.invited_by,
    created_at: r.created_at, github_login: r.github_login, email: r.email,
  }));
}

/** The caller's orgs and invitations. `grants` / `can_create` / `free` are the route's to add
 *  (src/plans/grants.ts `usableGrants`, src/plans/free.ts `freeOrgState`): what lets a person create an org. */
export async function myOrgs(p: PlatformContext, handle: string): Promise<Omit<MyOrgsResponse, "grants" | "can_create" | "free">> {
  const [orgs, invites, superadmin] = await Promise.all([listMyOrgs(p, handle), listMyInvites(p, handle), isSuperadmin(p, handle)]);
  return { orgs, invites, superadmin };
}

/**
 * Accept or decline one of the caller's pending invites. The match is re-checked in the statement that
 * reads the invite, so an id that is not theirs — someone else's, answered, revoked, unknown — is
 * `not_found` for all alike. Accepting inserts the membership and stamps the invite in one batch; an
 * `as_owner` invite (0042_organizations, a superadmin's) grants OWNER, and lifts an existing member to owner.
 *
 * SEATS (0044_plans): the invitation reserved its seat when it was made, so accepting is refused only when
 * the org is already FULL OF MEMBERS (its plan shrank since) — 402 `plan_limit`, the invitation left
 * pending. The condition is in the membership INSERT itself, and the stamp and the audit rows follow
 * only if it wrote: of two people accepting into the last seat, exactly one joins.
 */
export async function respondToInvite(p: PlatformContext, handle: string, id: number, accept: boolean): Promise<{ org: { slug: string; name: string }; role: OrgRole | null; org_id: string; first_join: boolean }> {
  const inv = await first<InviteJoinRow>(p, `${INVITE_JOIN} AND i.id = ?2`, handle, id);
  if (!inv) throw new OrgError("not_found");
  const firstJoin = accept && (await neverJoined(p, handle));
  const at = nowIso();
  const role = grantedRole(inv);
  if (!accept) {
    await batch(p, [
      stmt(p, `UPDATE org_invites SET status = 'declined', responded_at = ?, responded_by = ? WHERE id = ? AND status = 'pending'`, at, handle, id),
      auditStmt(p, inv.org_id, "invite.decline", `invite:${id}`, {}, at),
    ]);
    return { org: { slug: inv.slug, name: inv.name }, role: null, org_id: inv.org_id, first_join: false };
  }
  const gate = await seatGate(p, inv.org_id, "accept", !!(await memberOf(p, inv.org_id, handle)));
  const joined = `EXISTS (SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ? COLLATE NOCASE)`;
  const audit = (action: OrgAuditAction, target: string, detail: Record<string, unknown>): Stmt =>
    stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) SELECT ?, ?, ?, ?, ?, ? WHERE ${joined}`,
      inv.org_id, p.actor, action, target, JSON.stringify(detail), at, inv.org_id, handle);
  const [res] = await batch(p, [
    // Already a member (invited twice, or an owner invite for a current member): never a demotion, and no new seat.
    stmt(p, `INSERT INTO memberships (org_id, user_id, role, created_at, created_by)
             SELECT ?, ?, ?, ?, ? WHERE ${MEMBER_SEAT_FREE} OR ${joined}
             ON CONFLICT(org_id, user_id) DO UPDATE SET role = CASE WHEN excluded.role = 'owner' THEN 'owner' ELSE memberships.role END`,
      inv.org_id, handle, role, at, inv.invited_by, gate.cap, inv.org_id, gate.cap, inv.org_id, handle),
    stmt(p, `UPDATE org_invites SET status = 'accepted', responded_at = ?, responded_by = ? WHERE id = ? AND status = 'pending' AND ${joined}`,
      at, handle, id, inv.org_id, handle),
    audit("invite.accept", `invite:${id}`, { role }),
    audit("member.add", handle, { role, invite: id }),
  ]);
  if ((res.meta.changes ?? 0) === 0) throw gate.refuse(); // lost the race for the last seat
  return { org: { slug: inv.slug, name: inv.name }, role, org_id: inv.org_id, first_join: firstJoin };
}

// ── inside one org: me, settings ─────────────────────────────────────────────

export async function orgMe(p: PlatformContext, ctx: TenantContext): Promise<Omit<OrgMeResponse, "repos"> | null> {
  const row = await first<{ slug: string; name: string; logo_sha: string | null; role: OrgRole; title: string | null; responsibilities: string | null }>(p,
    `SELECT o.slug, o.name, o.logo_sha, m.role, m.title, m.responsibilities FROM orgs o JOIN memberships m ON m.org_id = o.id
      WHERE o.id = ? AND m.user_id = ? COLLATE NOCASE`, ctx.orgId, ctx.userId);
  return row ? { org: { slug: row.slug, name: row.name, logo_url: orgLogoSrc(row) }, role: row.role, title: row.title, responsibilities: row.responsibilities } : null;
}

interface SettingsRow {
  slug: string; name: string; created_at: string; created_by: string;
  logo_sha: string | null; logo_source: OrgLogoSource | null; logo_by: string | null; logo_from: string | null; logo_at: string | null;
}

/** Any member: the name, the slug, and the org's image with where it came from (src/orgs/logo.ts writes it). */
export async function getOrgSettings(p: PlatformContext, ctx: TenantContext): Promise<OrgSettings | null> {
  const r = await first<SettingsRow>(p, `SELECT slug, name, created_at, created_by, logo_sha, logo_source, logo_by, logo_from, logo_at FROM orgs WHERE id = ?`, ctx.orgId);
  return r ? { slug: r.slug, name: r.name, created_at: r.created_at, created_by: r.created_by, logo: orgLogoOf(r) } : null;
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
  name: string | null; mail_status: InviteMailStatus | null; mail_at: string | null; mail_error: string | null;
}
const INVITE_COLS = `id, github_login, email, role, as_owner, status, invited_by, created_at, responded_at, responded_by, name, mail_status, mail_at, mail_error`;
const toInvite = (r: InviteRow): OrgInvite => ({
  id: r.id, github_login: r.github_login, email: r.email, role: grantedRole(r), status: r.status,
  invited_by: r.invited_by, created_at: r.created_at, responded_at: r.responded_at, responded_by: r.responded_by,
  name: r.name, mail_status: r.mail_status, mail_at: r.mail_at, mail_error: r.mail_error,
});

/** One invite of this org by id, whatever its status (the row a send or a resend reports back). */
export async function getOrgInvite(p: PlatformContext, orgId: string, id: number): Promise<OrgInvite | null> {
  const row = await first<InviteRow>(p, `SELECT ${INVITE_COLS} FROM org_invites WHERE id = ? AND org_id = ?`, id, orgId);
  return row ? toInvite(row) : null;
}

/** The invitee's name: optional, trimmed, at most `INVITE_NAME_MAX` characters; blank is none. */
export function cleanInviteName(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new OrgError("invalid_invite", "name must be text");
  const t = v.trim();
  if (t.length > INVITE_NAME_MAX) throw new OrgError("invalid_invite", `a name is at most ${INVITE_NAME_MAX} characters`);
  return t === "" ? null : t;
}

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

/**
 * The pending-invite INSERT; `asOwner` is the superadmin's flag (src/platform) and nobody else's.
 * `seatCap` is REQUIRED (0044_plans): the org's seat cap from `seatGate(p, orgId, "reserve")` — the row is
 * written only while members + pending invitations are under it, so a caller checks `meta.changes` and
 * throws the gate's refusal on 0. `null` = no cap (an unlimited plan, or a brand-new org's first seat).
 */
export function inviteStmt(p: PlatformContext, orgId: string, a: InviteAddress, role: "admin" | "member", asOwner: boolean, at: string, name: string | null, seatCap: number | null): Stmt {
  return stmt(p, `INSERT INTO org_invites (org_id, github_login, email, role, as_owner, invited_by, status, created_at, name)
                  SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ? WHERE ${SEAT_FREE}`,
    orgId, a.github_login ?? null, a.email ?? null, role, asOwner ? 1 : 0, p.actor, at, name, seatCap, orgId, orgId, seatCap);
}

/** Admin+ invites by GitHub login or email, as admin or member. Never an owner: that is the superadmin's.
 *  An invitation RESERVES A SEAT (0044_plans): refused with 402 `plan_limit` once members + pending
 *  invitations reach the plan's seats — and outright on a one-person plan. */
export async function createInvite(p: PlatformContext, ctx: TenantContext, input: { github_login?: unknown; email?: unknown; role?: unknown; name?: unknown }): Promise<OrgInvite> {
  requireRole(ctx, "admin");
  const address = parseInviteAddress(input);
  const name = cleanInviteName(input.name);
  const role = input.role === undefined ? "member" : input.role;
  if (role !== "admin" && role !== "member") throw new OrgError("invalid_invite", "role must be admin or member");
  const person = await personForAddress(p, address);
  if (person && (await memberOf(p, ctx.orgId, person))) throw new OrgError("already_member");
  const gate = await seatGate(p, ctx.orgId, "reserve");
  const at = nowIso();
  let id: number;
  try {
    const [res] = await batch(p, [
      inviteStmt(p, ctx.orgId, address, role, false, at, name, gate.cap),
      stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at)
               SELECT ?, ?, 'invite.create', 'invite:' || last_insert_rowid(), ?, ? WHERE changes() > 0`, ctx.orgId, p.actor, JSON.stringify({ ...address, role }), at),
    ]);
    if ((res.meta.changes ?? 0) === 0) throw gate.refuse(); // another invitation took the last seat
    id = res.meta.last_row_id;
  } catch (e) {
    if (isUniqueViolation(e)) throw new OrgError("invite_exists");
    throw e;
  }
  return (await getOrgInvite(p, ctx.orgId, id))!;
}

/**
 * Admin+: the PENDING e-mail invite a resend mails again. `not_found` for an unknown id, another org's,
 * or one already answered or revoked; `no_address` (409) for a GitHub-login invite — there is nothing
 * to mail, the person sees it when they sign in.
 */
export async function resendableInvite(p: PlatformContext, ctx: TenantContext, id: number): Promise<OrgInvite & { email: string }> {
  requireRole(ctx, "admin");
  const inv = await getOrgInvite(p, ctx.orgId, id);
  if (!inv || inv.status !== "pending") throw new OrgError("not_found");
  if (inv.email === null) throw new OrgError("no_address", "a GitHub-login invite has no address to mail — the person sees it when they sign in");
  return inv as OrgInvite & { email: string };
}

// ── joining for the first time (the welcome mail) ────────────────────────────

/**
 * Has `handle` never been a member of ANY org? Asked BEFORE a join is written: no membership today and
 * no `member.add` in the audit trail (so leaving every org and joining another is not a second "first").
 * People from before orgs have a membership (0042_organizations), so they never read as new.
 */
export async function neverJoined(p: PlatformContext, handle: string): Promise<boolean> {
  const row = await first<{ n: number }>(p,
    `SELECT (SELECT COUNT(*) FROM memberships WHERE user_id = ?1 COLLATE NOCASE)
          + (SELECT COUNT(*) FROM org_admin_audit WHERE action = 'member.add' AND target = ?1 COLLATE NOCASE) AS n`, handle);
  return (row?.n ?? 0) === 0;
}

/** Who a welcome is addressed to: the person's name and a provider-VERIFIED address (never the editable
 *  notification address — abuse-limits.md), newest sign-in first. Null when no provider gave one. */
export async function welcomeRecipient(p: PlatformContext, handle: string): Promise<{ handle: string; name: string | null; email: string } | null> {
  return first<{ handle: string; name: string | null; email: string }>(p,
    `SELECT pe.handle, pe.name, d.verified_email AS email FROM persons pe JOIN identities d ON d.person = pe.handle
      WHERE pe.handle = ? COLLATE NOCASE AND d.verified_email IS NOT NULL ORDER BY d.linked_at DESC LIMIT 1`, handle);
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
