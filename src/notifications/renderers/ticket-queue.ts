import type { NotificationKind, Section, Window } from "@shared/notifications";
import type { TicketCategory, TicketPriority, TicketStatus } from "@shared/tickets";
import { TICKET_STATUS_LABEL } from "@shared/tickets";
import { type TenantContext, all } from "../../data/sql";
import { listAssignedTickets } from "../../tools/mywork";
import { escapeHtml } from "../html";
import { EMAIL_STYLE as S, EMAIL_CARD as K, EMAIL_SPACE as SP, type ChipTone } from "../assemble";

const DEEP_LINK = "/#tickets";
const TOP = 5;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const pad = (s: string, w: number) => s.padEnd(w);

/** Status pill tones mirror the app's `ticketPill` (design call #5): submitted blue, in progress green, testing accent (the email has no amber-as-testing; amber is declined here), done muted, declined red-ish. */
const STATUS_TONE: Record<TicketStatus, ChipTone> = { submitted: "blue", in_progress: "green", testing: "accent", done: "muted", declined: "amber" };

/**
 * Short age, the design's `age()` — "42m" / "6h" / "3d". Measured against the
 * window END rather than wall-clock `Date.now()`: a digest states the queue as
 * of the run, and it keeps the rendered string deterministic.
 */
function age(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((now.getTime() - then) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

interface UnassignedRow {
  id: number;
  title: string;
  category: TicketCategory;
  priority: TicketPriority;
  created_at: string;
  requester: string;
  requester_name: string;
}

/**
 * Part one of the section: what nobody has picked up. `submitted` with zero
 * assignee rows, org-wide and NOT window-scoped — the queue is state, like
 * review_queue, not a log of what happened since yesterday. Newest first, so
 * the top of the list is the thing filed most recently. NATIVE tickets only: a
 * mirrored ticket (0032) is a GitHub issue, and GitHub's own triage covers it.
 */
async function unassignedTickets(ctx: TenantContext): Promise<UnassignedRow[]> {
  return all<UnassignedRow>(
    ctx,
    `SELECT t.id, t.title, t.category, t.priority, t.created_at, t.requester,
            COALESCE(NULLIF(p.name, ''), t.requester) AS requester_name
       FROM tickets t
       LEFT JOIN persons p ON p.handle = t.requester
      WHERE t.org_id = ? AND t.status = 'submitted' AND t.source = 'canopy'
        AND NOT EXISTS (SELECT 1 FROM ticket_assignees a WHERE a.ticket_id = t.id AND a.org_id = ?)
      ORDER BY t.created_at DESC, t.id DESC`,
    ctx.orgId,
    ctx.orgId
  );
}

/**
 * ticketq — the org's ticket queue, in two halves: what is unclaimed (submitted
 * with no assignees) and what is on the recipient's own plate (assigned to them,
 * not done/declined). The second half reuses `listAssignedTickets`, the read My
 * Work renders, with its DEFAULT `sources: "canopy"` — native tickets only, so a
 * mirrored ticket (already a GitHub issue) is never mailed twice; My Work lists
 * both sources. Pure read; null when both halves are empty.
 */
async function render(ctx: TenantContext, handle: string, window: Window): Promise<Section | null> {
  const unassigned = await unassignedTickets(ctx);
  const mine = await listAssignedTickets(ctx, handle, { sources: "canopy" });
  if (unassigned.length === 0 && mine.length === 0) return null;

  const html: string[] = [];
  const text: string[] = [];

  if (unassigned.length) {
    const shown = unassigned.slice(0, TOP);
    html.push(`<div style="${S.label}padding-top:${SP.l}px;padding-bottom:${SP.s}px;">UNASSIGNED</div>`);
    html.push(
      shown
        .map((t, i) =>
          K.item({
            title: escapeHtml(t.title),
            number: null,
            url: null,
            rows: [K.row("Category", escapeHtml(t.category)), K.row("Requester", escapeHtml(t.requester_name))],
            footer:
              `${K.chip(t.priority.toUpperCase(), "muted")}` +
              `<span style="padding-left:8px;">opened ${escapeHtml(age(t.created_at, window.end))} ago</span>`,
            first: i === 0,
          })
        )
        .join("")
    );
    if (unassigned.length > TOP) html.push(`<div style="${S.muted}padding-top:${SP.s}px;">+${unassigned.length - TOP} more waiting in Tickets</div>`);
    for (const t of shown) {
      text.push(`  ${pad("unassigned", 11)} ${t.title}`);
      text.push(`  ${pad("", 17)} ${t.category} · ${t.priority} · filed by ${t.requester_name} · ${age(t.created_at, window.end)} old`);
    }
    if (unassigned.length > TOP) text.push(`  ${pad("", 17)} +${unassigned.length - TOP} more waiting in Tickets`);
  }

  if (mine.length) {
    html.push(`<div style="${S.label}padding-top:${SP.l}px;padding-bottom:${SP.s}px;">ASSIGNED TO YOU</div>`);
    html.push(
      mine
        .map((t, i) =>
          K.item({
            title: escapeHtml(t.title),
            number: null,
            url: null,
            rows: [K.row("Sprint", escapeHtml(t.sprint ? t.sprint.label : "Backlog"))],
            footer:
              `${K.chip(TICKET_STATUS_LABEL[t.status], STATUS_TONE[t.status])} ${K.chip(t.priority.toUpperCase(), "muted")}` +
              `<span style="padding-left:8px;">updated ${escapeHtml(age(t.updatedAt, window.end))} ago</span>`,
            first: i === 0,
          })
        )
        .join("")
    );
    for (const t of mine) {
      text.push(`  ${pad("assigned", 11)} ${t.title}`);
      text.push(`  ${pad("", 17)} ${TICKET_STATUS_LABEL[t.status]} · ${t.sprint ? t.sprint.label : "Backlog"}`);
    }
  }

  // "3 tickets unassigned · 1 assigned to you" — the noun sits on whichever
  // half leads, so both halves read grammatically on their own.
  const summary = unassigned.length
    ? [`${plural(unassigned.length, "ticket", "tickets")} unassigned`, mine.length ? `${mine.length} assigned to you` : null].filter(Boolean).join(" · ")
    : `${plural(mine.length, "ticket", "tickets")} assigned to you`;

  return { heading: "Ticket queue", summary, html: html.join(""), text: text.join("\n"), deepLink: DEEP_LINK, linkLabel: "Tickets" };
}

export const ticketQueueKind: NotificationKind<TenantContext> = {
  id: "ticketq",
  label: "Ticket queue",
  description: "New and unassigned tickets across the org.",
  defaultCadence: "daily",
  allowedCadences: ["daily", "weekly", "off"],
  render,
};
