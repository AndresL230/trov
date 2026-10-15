import type { NotificationKind, Section } from "@shared/notifications";
import { type TenantContext, first } from "../../data/sql";
import { countAssignedTickets } from "../../tools/mywork";
import { queueLine } from "../assemble";

const DEEP_LINK = "/#tickets";

/**
 * What nobody has picked up: `submitted` NATIVE tickets with no assignee, org-wide and NOT window-scoped — the queue
 * is state, not a log. A mirrored ticket (0032) is a GitHub issue, and GitHub's own triage covers it.
 */
async function unassignedCount(ctx: TenantContext): Promise<number> {
  const row = await first<{ n: number }>(ctx,
    `SELECT COUNT(*) AS n FROM tickets t
      WHERE t.org_id = ? AND t.status = 'submitted' AND t.source = 'canopy'
        AND NOT EXISTS (SELECT 1 FROM ticket_assignees a WHERE a.ticket_id = t.id AND a.org_id = ?)`,
    ctx.orgId, ctx.orgId);
  return Number(row?.n ?? 0);
}

/**
 * ticketq — ONE line (Phase E): "Tickets: 2 waiting for someone, 3 assigned to you". The unclaimed half is the
 * org's; the second half is the recipient's open NATIVE tickets (`countAssignedTickets`, the count My Work uses), so a
 * mirrored ticket is never counted twice. Pure read; null when both are zero.
 */
async function render(ctx: TenantContext, handle: string): Promise<Section | null> {
  const [unassigned, mine] = await Promise.all([unassignedCount(ctx), countAssignedTickets(ctx, handle, "canopy")]);
  if (unassigned === 0 && mine === 0) return null;
  const rest = [unassigned ? `${unassigned} waiting for someone` : null, mine ? `${mine} assigned to you` : null].filter(Boolean).join(", ");
  return queueLine({ label: "Tickets", rest, deepLink: DEEP_LINK, linkLabel: "Tickets" });
}

export const ticketQueueKind: NotificationKind<TenantContext> = {
  id: "ticketq",
  label: "Tickets",
  description: "One line: tickets nobody has picked up, and how many are yours.",
  defaultCadence: "daily",
  allowedCadences: ["daily", "weekly", "off"],
  render,
};
