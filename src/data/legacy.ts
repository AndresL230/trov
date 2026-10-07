// TRANSITIONAL — what only org #1 ever had. The data layer is org-explicit (every statement binds
// `ctx.orgId`) and every entry point resolves its own org; this is the ONE place that still names an
// org, for the two things that predate orgs: the legacy `invites` table (below) and the Worker secrets
// SaplingLearn's credentials still fall back to (`SAPLINGLEARN_ORG_ID`, read by src/data/secrets.ts).
// Each caller is marked `// MT:`; Phase 7 deletes both, and this file.
import type { InviteRow } from "@shared/rows";
import { systemTenant, type PlatformContext, type TenantContext } from "./context";
import { first, stmt, batch, nowIso } from "./platform-sql";
import { seatGate, PlanLimitError, MEMBER_SEAT_FREE } from "../plans/state";

/** Org #1 (0042_organizations): every pre-multitenancy row belongs to it. */
export const SAPLINGLEARN_ORG_ID = "org_saplinglearn";

/** Is `ctx` org #1? Asked only for the legacy `invites` sidecar (below), each use marked `MT:` at the caller. */
export function isLegacyOrg(ctx: TenantContext): boolean {
  return ctx.orgId === SAPLINGLEARN_ORG_ID;
}

// ── the legacy email-invite table ────────────────────────────────────────────
// `invites` (0023) is GLOBAL and keyed by email: before multitenancy it was org #1's invite list, and
// 0042_organizations copied every row into `org_invites` for org #1. An invite is now an `org_invites` row
// (src/orgs/legacy-invites.ts); what survives of `invites` is (a) org #1's SIDECAR — the invitee's name
// and the email-delivery outcome, which `org_invites` has no columns for — and (b) the rule below.

/**
 * A live legacy invite for `email`, IF org #1 still stands behind it: the `invites` row is neither
 * accepted nor revoked, and org #1 either has a PENDING `org_invites` row for the address or has none at
 * all (a row written before the organizations migration's copy). An invite revoked or declined through the org routes is dead
 * here too, whatever the old row says.
 */
export function liveLegacyInvite(p: PlatformContext, email: string): Promise<InviteRow | null> {
  return first<InviteRow>(p,
    `SELECT i.* FROM invites i
      WHERE i.email = ?1 AND i.revoked_at IS NULL AND i.accepted_by IS NULL
        AND (EXISTS (SELECT 1 FROM org_invites o WHERE o.org_id = ?2 AND o.email = i.email AND o.status = 'pending')
             OR NOT EXISTS (SELECT 1 FROM org_invites o WHERE o.org_id = ?2 AND o.email = i.email))`,
    email.trim().toLowerCase(), SAPLINGLEARN_ORG_ID);
}

/**
 * Onboarding (§5.1): a new person has NO membership — except that a live legacy invite for their
 * provider-VERIFIED email is consumed as a membership of org #1, exactly as signing up with one always
 * made a person a SaplingLearn member. One batch: the membership (`member`), the legacy row and its
 * pending `org_invites` twin stamped accepted, and the audit rows. Returns the system tenant of the org
 * joined (what the welcome mail is sent under), or null when there was no invite.
 * Every OTHER invite — any org's, by login or email — waits for an explicit `POST /api/invites/:id/accept`.
 */
export async function consumeLegacyInvite(p: PlatformContext, handle: string, verifiedEmail: string | null): Promise<TenantContext | null> {
  const invite = verifiedEmail ? await liveLegacyInvite(p, verifiedEmail) : null;
  if (!invite) return null;
  // The seat gate every join passes (0044_plans): this is an invitation being accepted. A refusal here
  // (the org is full of members) leaves the person signed up with no membership and the invite pending.
  let gate: Awaited<ReturnType<typeof seatGate>>;
  try {
    gate = await seatGate(p, SAPLINGLEARN_ORG_ID, "accept");
  } catch (e) {
    if (e instanceof PlanLimitError) return null;
    throw e;
  }
  const at = nowIso();
  await batch(p, [
    stmt(p, `INSERT OR IGNORE INTO memberships (org_id, user_id, role, created_at, created_by) SELECT ?, ?, 'member', ?, ? WHERE ${MEMBER_SEAT_FREE}`,
      SAPLINGLEARN_ORG_ID, handle, at, invite.invited_by, gate.cap, SAPLINGLEARN_ORG_ID, gate.cap),
    stmt(p, `UPDATE invites SET accepted_by = ? WHERE email = ? AND accepted_by IS NULL`, handle, invite.email),
    stmt(p, `UPDATE org_invites SET status = 'accepted', responded_at = ?, responded_by = ? WHERE org_id = ? AND email = ? AND status = 'pending'`,
      at, handle, SAPLINGLEARN_ORG_ID, invite.email),
    stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, 'member.add', ?, ?, ?)`,
      SAPLINGLEARN_ORG_ID, handle, handle, JSON.stringify({ role: "member", invite: "legacy" }), at),
  ]);
  return systemTenant(p, SAPLINGLEARN_ORG_ID, "system");
}
