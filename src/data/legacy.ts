// TRANSITIONAL — the cut-over entry points. The data layer itself is org-explicit (every statement
// binds `ctx.orgId`); what is left here is the ONE place that still names an org: the entry points
// that cannot resolve theirs yet, and what only org #1 ever had. Each caller is marked `// MT:`;
// Phases 5b and 7 replace them.
import type { Env } from "../env";
import type { InviteRow } from "@shared/rows";
import { platform, systemTenant, type PlatformContext, type SystemActor, type TenantContext } from "./context";
import { first, stmt, batch, nowIso } from "./platform-sql";

/** Org #1 (0037): every pre-multitenancy row belongs to it, and so does every org-less entry point. */
export const SAPLINGLEARN_ORG_ID = "org_saplinglearn";

/**
 * The single org every org-less entry point acts on until it can name one: the GitHub webhook (Phase
 * 5b resolves the org from `org_repos`), the crons (5b enumerates `orgs` by rotation, §8.3), and the
 * token-authenticated artifact upload (the token row will carry its org). Each caller is marked `MT:`.
 */
export function legacySystemTenant(env: Env, actor: SystemActor): TenantContext {
  return systemTenant(platform(env, actor), SAPLINGLEARN_ORG_ID, actor);
}

/**
 * Is `ctx` org #1? For the few things that are still ITS alone, each marked `MT:` at the caller: the
 * Worker's own GitHub / poller configuration (`GITHUB_REPO`, `REPO_ENVIRONMENTS`, the service token — the
 * admin Sync / Poll routes and the Repo dashboard, until Phase 5b reads `org_repos` / `org_environments` /
 * `org_secrets`), and the legacy `invites` table (below).
 */
export function isLegacyOrg(ctx: TenantContext): boolean {
  return ctx.orgId === SAPLINGLEARN_ORG_ID;
}

// ── the legacy email-invite table ────────────────────────────────────────────
// `invites` (0023) is GLOBAL and keyed by email: before multitenancy it was org #1's invite list, and
// 0037 copied every row into `org_invites` for org #1. An invite is now an `org_invites` row
// (src/orgs/legacy-invites.ts); what survives of `invites` is (a) org #1's SIDECAR — the invitee's name
// and the email-delivery outcome, which `org_invites` has no columns for — and (b) the rule below.

/**
 * A live legacy invite for `email`, IF org #1 still stands behind it: the `invites` row is neither
 * accepted nor revoked, and org #1 either has a PENDING `org_invites` row for the address or has none at
 * all (a row written before 0037's copy). An invite revoked or declined through the org routes is dead
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
 * pending `org_invites` twin stamped accepted, and the audit rows. Returns whether it joined.
 * Every OTHER invite — any org's, by login or email — waits for an explicit `POST /api/invites/:id/accept`.
 */
export async function consumeLegacyInvite(p: PlatformContext, handle: string, verifiedEmail: string | null): Promise<boolean> {
  const invite = verifiedEmail ? await liveLegacyInvite(p, verifiedEmail) : null;
  if (!invite) return false;
  const at = nowIso();
  await batch(p, [
    stmt(p, `INSERT OR IGNORE INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, ?, 'member', ?, ?)`,
      SAPLINGLEARN_ORG_ID, handle, at, invite.invited_by),
    stmt(p, `UPDATE invites SET accepted_by = ? WHERE email = ? AND accepted_by IS NULL`, handle, invite.email),
    stmt(p, `UPDATE org_invites SET status = 'accepted', responded_at = ?, responded_by = ? WHERE org_id = ? AND email = ? AND status = 'pending'`,
      at, handle, SAPLINGLEARN_ORG_ID, invite.email),
    stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, 'member.add', ?, ?, ?)`,
      SAPLINGLEARN_ORG_ID, handle, handle, JSON.stringify({ role: "member", invite: "legacy" }), at),
  ]);
  return true;
}
