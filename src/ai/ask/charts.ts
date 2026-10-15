// `show_chart` (docs/architecture/ask.md › Blocks; #12 §2.8): a FIXED set of queries the server runs. The model names
// a query and its parameters; every value in the chart — and its total — comes from D1 here, never from the model.
import { all, first, type TenantContext } from "../../data/sql";
import { TICKET_STATUSES, TICKET_STATUS_LABEL } from "@shared/tickets-core";
import type { AskChart, AskChartQuery } from "@shared/ai-ask-core";

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `Sep 14` for a `YYYY-MM-DD` day. */
export const shortDay = (d: string): string => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/** The Monday (UTC) of `d`'s week, `YYYY-MM-DD`. */
export function mondayOf(d: Date): string {
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  u.setUTCDate(u.getUTCDate() - ((u.getUTCDay() + 6) % 7));
  return u.toISOString().slice(0, 10);
}

/** `weeks` Mondays, oldest first, ending with this week's. */
export function weekStarts(now: Date, weeks: number): string[] {
  const thisMonday = new Date(`${mondayOf(now)}T00:00:00Z`).getTime();
  return Array.from({ length: weeks }, (_, i) => new Date(thisMonday - (weeks - 1 - i) * 7 * DAY).toISOString().slice(0, 10));
}

function byWeek(dates: (string | null)[], starts: string[]): number[] {
  const counts = starts.map(() => 0);
  for (const at of dates) {
    if (!at) continue;
    const i = starts.indexOf(mondayOf(new Date(at)));
    if (i >= 0) counts[i]++;
  }
  return counts;
}

const clampWeeks = (w: unknown): number => (typeof w === "number" && Number.isInteger(w) ? Math.min(26, Math.max(1, w)) : 8);

export interface ChartParams { weeks?: number; repo?: string; sprint_id?: number }

export class ChartError extends Error {
  readonly code = "bad_request" as const;
}

/** Run one fixed query. Throws only for a bad parameter (`sprint_burndown` without a known sprint). */
export async function runChart(ctx: TenantContext, query: AskChartQuery, p: ChartParams, now: Date = new Date()): Promise<AskChart> {
  const params: Record<string, unknown> = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
  const weekly = (title: string, unit: string, starts: string[], values: number[]): AskChart => ({
    title, unit, query, params, total: values.reduce((a, b) => a + b, 0), rows: starts.map((s, i) => ({ label: shortDay(s), value: values[i] })),
  });
  switch (query) {
    case "merged_prs_by_week": {
      const starts = weekStarts(now, clampWeeks(p.weeks));
      const rows = await all<{ occurred_at: string | null }>(ctx,
        `SELECT occurred_at FROM events WHERE org_id = ? AND event_type = 'pr_merged' AND occurred_at >= ? AND (? = '' OR repo = ?)`,
        ctx.orgId, starts[0], p.repo ?? "", p.repo ?? "");
      return weekly("Merged PRs by week", "merged pull requests", starts, byWeek(rows.map((r) => r.occurred_at), starts));
    }
    case "ci_failures_by_week": {
      const starts = weekStarts(now, clampWeeks(p.weeks));
      const rows = await all<{ occurred_at: string | null }>(ctx,
        `SELECT occurred_at FROM repo_events WHERE org_id = ? AND kind = 'run' AND state IN ('failure', 'timed_out') AND occurred_at >= ? AND (? = '' OR repo = ?)`,
        ctx.orgId, starts[0], p.repo ?? "", p.repo ?? "");
      return weekly("Failed CI runs by week", "failed CI runs", starts, byWeek(rows.map((r) => r.occurred_at), starts));
    }
    case "tickets_by_status": {
      const rows = await all<{ status: string; n: number }>(ctx, `SELECT status, COUNT(*) AS n FROM tickets WHERE org_id = ? GROUP BY status`, ctx.orgId);
      const out = TICKET_STATUSES.map((s) => ({ label: TICKET_STATUS_LABEL[s], value: Number(rows.find((r) => r.status === s)?.n ?? 0) }));
      return { title: "Tickets by status", unit: "tickets", query, params, total: out.reduce((a, r) => a + r.value, 0), rows: out };
    }
    case "theme_shares":
      // Themes are written by the AI pass (Phase D); until an org has active themes there is nothing to share out.
      return { title: "Merged PRs by theme", unit: "merged pull requests", query, params, total: 0, rows: [] };
    case "sprint_burndown": {
      const id = typeof p.sprint_id === "number" && Number.isInteger(p.sprint_id) ? p.sprint_id : null;
      const s = id === null ? null : await first<{ id: number; title: string; start_date: string | null; target_date: string | null; created_at: string }>(ctx,
        `SELECT id, title, start_date, target_date, created_at FROM sprints WHERE id = ? AND org_id = ?`, id, ctx.orgId);
      if (!s) throw new ChartError(`no such sprint: ${p.sprint_id ?? "(none given)"}`);
      const tickets = await all<{ id: number }>(ctx, `SELECT id FROM tickets WHERE org_id = ? AND sprint_id = ?`, ctx.orgId, s.id);
      // When each ticket was LAST closed (done / declined) — one moved back to open later is open again.
      const moves = await all<{ ticket_id: number; at: string; to_status: string }>(ctx,
        `SELECT e.ticket_id, e.created_at AS at, e.to_status FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id AND t.org_id = e.org_id
          WHERE e.org_id = ? AND t.sprint_id = ? ORDER BY e.created_at`, ctx.orgId, s.id);
      const startDay = (s.start_date || s.created_at).slice(0, 10);
      const today = now.toISOString().slice(0, 10);
      const endDay = s.target_date && s.target_date < today ? s.target_date : today;
      const days: string[] = [];
      for (let t = new Date(`${startDay}T00:00:00Z`).getTime(); t <= new Date(`${endDay}T00:00:00Z`).getTime() && days.length < 120; t += DAY) {
        days.push(new Date(t).toISOString().slice(0, 10));
      }
      const rows = days.map((d) => ({
        label: shortDay(d),
        value: tickets.filter((tk) => {
          const last = moves.filter((m) => m.ticket_id === tk.id && m.at.slice(0, 10) <= d).at(-1);
          return !last || (last.to_status !== "done" && last.to_status !== "declined");
        }).length,
      }));
      return { title: `${s.title}: open tickets by day`, unit: "open tickets", query, params, total: tickets.length, rows };
    }
  }
}
