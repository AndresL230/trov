import type { SprintRow, PlanVersionRow } from "@shared/rows";
import type { NotificationKind, Section, Window } from "@shared/notifications";
import { type TenantContext, first } from "../../data/sql";
import { escapeHtml, isoOf } from "../html";
import { EMAIL_STYLE as S, EMAIL_CARD as K, EMAIL_SPACE as SP, type ChipTone } from "../assemble";

const DEEP_LINK = "/#roadmap";
const PLAN_TONE: Record<PlanDiffLine["label"], ChipTone> = { added: "green", changed: "blue", reordered: "muted", done: "accent" };

// Plan-layer diff between two sprint snapshots. Progress (sprint_progress) is not
// in a snapshot, so a progress-only change can never surface here. The snapshots
// are SprintRow[] — DB column names (title / target_date), not the DTO's
// label / due.
export interface PlanDiffLine {
  label: "added" | "changed" | "reordered" | "done";
  text: string;
}

export function diffSprints(before: SprintRow[], after: SprintRow[]): PlanDiffLine[] {
  const lines: PlanDiffLine[] = [];
  const prev = new Map(before.map((m) => [m.id, m]));

  for (const m of after) {
    const old = prev.get(m.id);
    if (!old) {
      lines.push({ label: "added", text: `${m.title} — targeting ${m.target_date}` });
      continue;
    }
    if (old.title !== m.title) lines.push({ label: "changed", text: `${old.title} → ${m.title} (renamed)` });
    if ((old.description ?? "") !== (m.description ?? "")) lines.push({ label: "changed", text: `${m.title} — description updated` });
    if (old.status !== "done" && m.status === "done") lines.push({ label: "done", text: `${m.title} — confirmed complete` });
  }

  // Reorder: the relative order of sprints present in BOTH snapshots changed
  // (snapshots are target_date ASC, id ASC, so a date move shows up here).
  const common = new Set(after.filter((m) => prev.has(m.id)).map((m) => m.id));
  const beforeOrder = before.filter((m) => common.has(m.id)).map((m) => m.id);
  const afterOrder = after.filter((m) => common.has(m.id)).map((m) => m.id);
  const moved = afterOrder.filter((id, i) => beforeOrder[i] !== id);
  if (moved.length) {
    const titles = after.filter((m) => moved.includes(m.id)).map((m) => m.title);
    lines.push({ label: "reordered", text: `${titles.join(", ")} — order changed` });
  }
  return lines;
}

/**
 * roadmap_plan — diff the latest plan version whose created_at falls in the
 * window against the last version BEFORE the window. No version in the window,
 * or no sprint-level change between the two, renders null.
 */
async function render(ctx: TenantContext, _login: string, window: Window): Promise<Section | null> {
  const start = isoOf(window.start);
  const end = isoOf(window.end);
  const latest = await first<PlanVersionRow>(
    ctx,
    `SELECT * FROM plan_versions
      WHERE org_id = ? AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
      ORDER BY version DESC LIMIT 1`,
    ctx.orgId,
    start,
    end
  );
  if (!latest) return null;
  const baseline = await first<PlanVersionRow>(
    ctx,
    `SELECT * FROM plan_versions WHERE org_id = ? AND datetime(created_at) < datetime(?) ORDER BY version DESC LIMIT 1`,
    ctx.orgId,
    start
  );

  const before = baseline ? (JSON.parse(baseline.sprints_json) as SprintRow[]) : [];
  const after = JSON.parse(latest.sprints_json) as SprintRow[];
  const lines = diffSprints(before, after);
  if (lines.length === 0) return null;

  const html =
    `<table ${S.table} style="margin-top:${SP.m}px;">` +
    lines.map((l) => `<tr><td width="96" style="vertical-align:top;padding:${SP.xs}px 8px ${SP.xs}px 0;">${K.chip(l.label.toUpperCase(), PLAN_TONE[l.label])}</td><td style="${S.body}">${escapeHtml(l.text)}</td></tr>`).join("") +
    `</table>`;
  const text = lines.map((l) => `  ${l.label.padEnd(10)} ${l.text}`).join("\n");
  const n = lines.length;
  const summary = `${n} plan ${n === 1 ? "change" : "changes"} this ${window.cadence === "weekly" ? "week" : "day"}`;
  return { heading: "Roadmap plan changes", summary, html, text, deepLink: DEEP_LINK, linkLabel: "Roadmap" };
}

export const roadmapPlanKind: NotificationKind<TenantContext> = {
  id: "roadmap_plan",
  label: "Roadmap plan changes",
  description: "Sprint progress and slips.",
  defaultCadence: "weekly",
  allowedCadences: ["daily", "weekly", "off"],
  render,
};
