// The email invite list behind the OLD `/invites…` routes (Maintenance › People in the current SPA) —
// the cut-over alias of `/api/o/:slug/invites…` (§6.3). A PLATFORM module, like ./repo.ts.
//
// The model: an invite is an `org_invites` row of the CALLER's org — an email invite, role `member` —
// whichever route created it. These functions are a view of those rows in the old screen's shape
// (`InviteRow`, addressed by email instead of id), so the list an org sees here is exactly its own, and
// the same invite shows on, and can be revoked from, either route.
//
// The invitee's NAME and the invite email's delivery outcome are columns of `org_invites` since 0047
// (`name`, `mail_status` / `mail_at` / `mail_error`), written for every org by the same code as the org
// routes (src/orgs/mail.ts). The legacy `invites` table — GLOBAL, keyed by email — is still a sidecar
// for org #1 ONLY (`isLegacyOrg`, src/data/legacy.ts): a row from before 0047 shows its name and outcome
// from there, and an invite made HERE for org #1 still writes it, because a new person's first sign-in
// consumes it (`consumeLegacyInvite`). Nothing an org does can touch or reveal another org's row.
// Phase 7 drops the table.
//
// Becoming a member: an `org_invites` row is accepted through `POST /api/invites/:id/accept` like any
// other — except org #1's, which a NEW person's first sign-in still consumes (`consumeLegacyInvite`).
import { type PlatformContext, type Stmt, first, all, stmt, batch, nowIso } from "../data/platform-sql";
import { requireRole, type TenantContext } from "../data/context";
import { isLegacyOrg } from "../data/legacy";
import type { InviteRow } from "@shared/rows";
import type { OrgInviteStatus } from "@shared/orgs";
import { inviteStmt } from "./repo";

export type LegacyInviteErrorCode = "invite_exists" | "already_a_person";
export class LegacyInviteError extends Error {
  constructor(readonly code: LegacyInviteErrorCode) { super(code); }
}

const norm = (e: string) => e.trim().toLowerCase();
const isUniqueViolation = (e: unknown): boolean => /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));

interface Row {
  email: string; status: OrgInviteStatus; invited_by: string; created_at: string; responded_at: string | null; responded_by: string | null;
  name: string | null; email_sent_at: string | null; email_id: string | null; email_error: string | null;
}

// The LATEST invite of this org per address; the sidecar joins only when `?2` says this is org #1.
const SELECT = `SELECT o.email, o.status, o.invited_by, o.created_at, o.responded_at, o.responded_by,
       COALESCE(o.name, s.name) AS name,
       CASE WHEN o.mail_status IS NULL THEN s.email_sent_at ELSE o.mail_at END AS email_sent_at,
       CASE WHEN o.mail_status IS NULL THEN s.email_id END AS email_id,
       CASE WHEN o.mail_status IS NULL THEN s.email_error ELSE o.mail_error END AS email_error
  FROM org_invites o LEFT JOIN invites s ON ?2 = 1 AND s.email = o.email
 WHERE o.org_id = ?1 AND o.email IS NOT NULL
   AND o.id = (SELECT MAX(x.id) FROM org_invites x WHERE x.org_id = o.org_id AND x.email = o.email)`;

const toLegacy = (r: Row): InviteRow => ({
  email: r.email.toLowerCase(), name: r.name, invited_by: r.invited_by, invited_at: r.created_at,
  accepted_by: r.status === "accepted" ? r.responded_by : null,
  revoked_at: r.status === "revoked" || r.status === "declined" ? r.responded_at : null,
  email_sent_at: r.email_sent_at, email_id: r.email_id, email_error: r.email_error,
});

// MT: the sidecar is org #1's alone (see the header) — every statement here takes the flag.
const sidecar = (ctx: TenantContext): 0 | 1 => (isLegacyOrg(ctx) ? 1 : 0);

/** The org's email invites, newest first. */
export async function listLegacyInvites(p: PlatformContext, ctx: TenantContext): Promise<InviteRow[]> {
  requireRole(ctx, "admin");
  return (await all<Row>(p, `${SELECT} ORDER BY o.created_at DESC, o.email ASC LIMIT 500`, ctx.orgId, sidecar(ctx))).map(toLegacy);
}

/** One invite of this org by address, live or not. */
export async function getLegacyInvite(p: PlatformContext, ctx: TenantContext, email: string): Promise<InviteRow | null> {
  requireRole(ctx, "admin");
  const row = await first<Row>(p, `${SELECT} AND o.email = ?3`, ctx.orgId, sidecar(ctx), norm(email));
  return row ? toLegacy(row) : null;
}

/**
 * Invite `email` into the caller's org as a member. Refused when the address already has a PENDING invite
 * here (`invite_exists`) or belongs to a MEMBER of this org (`already_a_person` — the person's own email
 * or a provider-verified one). Whether the address is a person anywhere ELSE is not looked at, so this is
 * not an oracle for it. One batch: the `org_invites` row, its audit row and (org #1) the sidecar.
 */
export async function createLegacyInvite(p: PlatformContext, ctx: TenantContext, i: { email: string; name: string | null }): Promise<InviteRow> {
  requireRole(ctx, "admin");
  const email = norm(i.email);
  const member = await first(p,
    `SELECT 1 AS x FROM memberships m JOIN persons pe ON pe.handle = m.user_id
      WHERE m.org_id = ?1 AND (lower(pe.email) = ?2
         OR EXISTS (SELECT 1 FROM identities d WHERE d.person = pe.handle AND lower(d.verified_email) = ?2))`, ctx.orgId, email);
  if (member) throw new LegacyInviteError("already_a_person");
  if (await first(p, `SELECT 1 AS x FROM org_invites WHERE org_id = ? AND email = ? AND status = 'pending'`, ctx.orgId, email)) throw new LegacyInviteError("invite_exists");
  const at = nowIso();
  const stmts: Stmt[] = [
    inviteStmt(p, ctx.orgId, { email }, "member", false, at, i.name),
    stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at)
             VALUES (?, ?, 'invite.create', 'invite:' || last_insert_rowid(), ?, ?)`, ctx.orgId, p.actor, JSON.stringify({ email, role: "member" }), at),
  ];
  if (sidecar(ctx)) {
    stmts.push(stmt(p,
      `INSERT INTO invites (email, name, invited_by, invited_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, invited_by = excluded.invited_by, invited_at = excluded.invited_at,
         accepted_by = NULL, revoked_at = NULL, email_sent_at = NULL, email_id = NULL, email_error = NULL`,
      email, i.name, p.actor, at));
  }
  try {
    await batch(p, stmts);
  } catch (e) {
    if (isUniqueViolation(e)) throw new LegacyInviteError("invite_exists"); // lost a race for the pending slot
    throw e;
  }
  return (await getLegacyInvite(p, ctx, email))!;
}

/** The id of this org's PENDING invite for `email` — what the alias's mail is recorded on. */
export async function pendingInviteId(p: PlatformContext, ctx: TenantContext, email: string): Promise<number | null> {
  requireRole(ctx, "admin");
  return (await first<{ id: number }>(p, `SELECT id FROM org_invites WHERE org_id = ? AND email = ? AND status = 'pending'`, ctx.orgId, norm(email)))?.id ?? null;
}

/** Revoke this org's invite for `email`. False when the org has none; an invite that is no longer pending is left as it is. */
export async function revokeLegacyInvite(p: PlatformContext, ctx: TenantContext, rawEmail: string): Promise<boolean> {
  requireRole(ctx, "admin");
  const email = norm(rawEmail);
  if (!(await first(p, `SELECT 1 AS x FROM org_invites WHERE org_id = ? AND email = ?`, ctx.orgId, email))) return false;
  const at = nowIso();
  const stmts: Stmt[] = [
    stmt(p, `UPDATE org_invites SET status = 'revoked', responded_at = ?, responded_by = ? WHERE org_id = ? AND email = ? AND status = 'pending'`,
      at, p.actor, ctx.orgId, email),
    stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) SELECT ?, ?, 'invite.revoke', ?, '{}', ? WHERE changes() > 0`,
      ctx.orgId, p.actor, `invite:${email}`, at),
  ];
  if (sidecar(ctx)) stmts.push(stmt(p, `UPDATE invites SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL AND accepted_by IS NULL`, at, email));
  await batch(p, stmts);
  return true;
}
