// week_recap — the weekly e-mail's "This week" (Phase E; notifications.md › The weekly). A PURE READ:
//
//   • THE HIGHLIGHTS — at most 3 cited lines the AI pass's `digest.week` job stored for this week
//     (src/data/digest-highlights.ts; ONE batch request per org per week, shared by every member). Shown only while
//     the org's AI switch is on; a row that fails its schema is not shown. No row → no highlights (never a guess).
//   • ONE NUMBERS LINE — computed by the server from D1, never by the model: pull requests merged (only when the org
//     has a repository connected — unknown is left out, never 0), tickets a person marked done, entries in the Feed.
//
// Null when there are no highlights and every number is zero.
import { z } from "zod";
import { AiLineSchema, type AiLine } from "@shared/ai";
import type { NotificationKind, Section, Window } from "@shared/notifications";
import { type TenantContext, first } from "../../data/sql";
import { weekHighlights } from "../../data/digest-highlights";
import { primaryRepo } from "../../integrations/settings";
import { planAndAiRuns } from "../../plans/gate";
import { escapeHtml, isoOf } from "../html";
import { EMAIL_STYLE as S, EMAIL_SPACE as SP, appHref } from "../assemble";

const DEEP_LINK = "/#feed";
const Highlights = z.array(AiLineSchema).max(3);

/** The stored highlights for the window's week, or [] (none, AI off, or a row that fails its schema). */
export async function storedHighlights(ctx: TenantContext, window: Window): Promise<AiLine[]> {
  if (!(await planAndAiRuns(ctx, window.end)).enabled) return [];
  const row = await weekHighlights(ctx, window.id);
  if (!row) return [];
  try {
    const parsed = Highlights.safeParse(JSON.parse(row.highlights_json));
    return parsed.success ? parsed.data : [];
  } catch { return []; }
}

export interface WeekNumbers { prsMerged: number | null; ticketsDone: number; feedEntries: number }

/** The week's numbers, from D1. `prsMerged` is null when the org has no repository connected. */
export async function weekNumbers(ctx: TenantContext, window: Window): Promise<WeekNumbers> {
  const from = isoOf(window.start);
  const to = isoOf(window.end);
  const repo = await primaryRepo(ctx);
  const prs = repo
    ? await first<{ n: number }>(ctx,
      `SELECT COUNT(DISTINCT ref_number) AS n FROM events WHERE org_id = ? AND repo = ? AND event_type = 'pr_merged'
          AND COALESCE(occurred_at, recorded_at) >= ? AND COALESCE(occurred_at, recorded_at) < ?`, ctx.orgId, repo, from, to)
    : null;
  const tickets = await first<{ n: number }>(ctx,
    `SELECT COUNT(DISTINCT e.ticket_id) AS n FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id AND t.org_id = ?
      WHERE e.org_id = ? AND e.to_status = 'done' AND t.status = 'done' AND e.created_at >= ? AND e.created_at < ?`, ctx.orgId, ctx.orgId, from, to);
  const feed = await first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM feed WHERE org_id = ? AND created_at >= ? AND created_at < ?`, ctx.orgId, from, to);
  return { prsMerged: prs ? Number(prs.n) : null, ticketsDone: Number(tickets?.n ?? 0), feedEntries: Number(feed?.n ?? 0) };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "12 pull requests merged, 4 tickets done, 9 entries in the Feed" — zero parts left out; null when all are. */
export function numbersLine(n: WeekNumbers): string | null {
  const parts = [
    n.prsMerged ? `${plural(n.prsMerged, "pull request", "pull requests")} merged` : null,
    n.ticketsDone ? `${plural(n.ticketsDone, "ticket", "tickets")} done` : null,
    n.feedEntries ? `${plural(n.feedEntries, "entry", "entries")} in the Feed` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

const citeLink = (c: AiLine["cites"][number]): string | null => (!c.href ? null : c.href.startsWith("#") ? appHref(c.href) : c.href);

export function renderWeek(highlights: AiLine[], numbers: string | null): Section | null {
  if (!highlights.length && !numbers) return null;
  const html: string[] = [];
  const text: string[] = [];
  if (highlights.length) {
    html.push(`<table data-week-highlights ${S.table} style="margin-top:${SP.s}px;">` + highlights.map((h) => {
      const cites = h.cites.map((c) => {
        const href = citeLink(c);
        return href ? `<a href="${escapeHtml(href)}" style="${S.link}text-decoration:underline;text-underline-offset:2px;">${escapeHtml(c.label)}</a>` : escapeHtml(c.label);
      }).join(", ");
      return `<tr><td style="${S.body}">${escapeHtml(h.text)}${cites ? ` <span style="${S.meta}">(${cites})</span>` : ""}</td></tr>`;
    }).join("") + `</table>`);
    for (const h of highlights) text.push(`  - ${h.text}${h.cites.length ? ` (${h.cites.map((c) => c.label).join(", ")})` : ""}`);
  }
  if (numbers) {
    html.push(`<div data-week-numbers style="${S.muted}padding-top:${highlights.length ? SP.s : SP.xs}px;">${escapeHtml(numbers)}</div>`);
    text.push(`${highlights.length ? "\n" : ""}  ${numbers}`);
  }
  return { heading: "This week", summary: highlights[0]?.text ?? numbers ?? undefined, html: html.join(""), text: text.join("\n"), deepLink: DEEP_LINK, linkLabel: "the Feed" };
}

async function render(ctx: TenantContext, _handle: string, window: Window): Promise<Section | null> {
  if (window.cadence !== "weekly") return null;
  const [highlights, numbers] = await Promise.all([storedHighlights(ctx, window), weekNumbers(ctx, window)]);
  return renderWeek(highlights, numbersLine(numbers));
}

export const weekRecapKind: NotificationKind<TenantContext> = {
  id: "week_recap",
  label: "This week",
  description: "Once a week: the team's highlights and the week's numbers.",
  defaultCadence: "weekly",
  allowedCadences: ["weekly", "off"],
  render,
};
