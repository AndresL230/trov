// THE WEEKLY HIGHLIGHTS (`digest.week`; docs/architecture/ai.md › The weekly highlights; the decided build's Phase E):
// the weekly e-mail's "This week" — at most 3 cited highlights of ONE organization's week, written by the AI pass on
// the scope `digest:week:<YYYY-Www>:<send instant>` through the Message Batches API (`batch: true`): ONE request per
// org per week, shared by every member's weekly e-mail.
//
// WHEN: the digest pre-warm (src/notifications/cron.ts `prewarmDigests`) marks the scope `WEEK_HIGHLIGHTS_LEAD_MS` before the
// org's weekly send, so the batch is submitted on that tick and collected on a later one before the send. The window
// is the weekly run's own ([send − 7 days, send)), carried in the key, so the submit and the collect read the same week.
//
// ONCE A WEEK: a week that already has highlights reads `null` (no call); the store keeps the first answer only.
// NEVER GUESS: ./week-core.ts `weekFromAnswer`. The e-mail reads the stored row (src/data/digest-highlights.ts) and
// never calls a model; with the org's AI switch off it shows none.
import { parseWeekScopeKey } from "@shared/ai";
import { all, nowIso, type TenantContext } from "../data/sql";
import { storeWeekHighlights, weekHighlights } from "../data/digest-highlights";
import { primaryRepo } from "../integrations/settings";
import { get_feed } from "../tools/reads";
import { toMyWorkPr, type PrEventJoinRow } from "../tools/mywork";
import type { DirtyScope } from "../data/ai-dirty";
import type { ClaudeJob, JobItem } from "./jobs";
import { keep } from "./sections";
import {
  WEEK_JOB, WEEK_PROMPT_VERSION, WEEK_SYSTEM, WeekAnswerSchema, orderWeekItems, weekFromAnswer, weekPromptInput,
  type WeekAnswer, type WeekInput, type WeekItem,
} from "./week-core";
import type { AiCite } from "@shared/ai";
import { isFeedImportance } from "@shared/ai";

export * from "./week-core";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Caps on what one prompt carries (a week is a few thousand tokens at most). */
const MAX_PRS = 25;
const MAX_NOTES = 20;
const MAX_TICKETS = 20;
const MAX_ITEMS = 50;

/** The line the handoff writer puts in the feed for every handoff (src/tools/handoffs.ts) — not a session note. */
const HANDOFF_LINE = /^\S+ left a handoff for \S+: #\d+ /;
const clip = (s: string | null | undefined, max: number): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const day = (iso: string | null | undefined): string => (iso ?? "").slice(0, 10);
const inWindow = (iso: string, from: Date, to: Date): boolean => {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= from.getTime() && t < to.getTime();
};

/** One organization's week, from D1 only (no model, no network). Items are read up to `min(end, now)`. */
export async function buildWeekInput(ctx: TenantContext, weekId: string, end: Date, now: Date = new Date()): Promise<WeekInput> {
  const start = new Date(end.getTime() - 7 * DAY_MS);
  const until = new Date(Math.min(end.getTime(), now.getTime()));
  const cites: Record<string, AiCite> = {};
  const items: WeekItem[] = [];
  const add = (i: WeekItem, c: AiCite) => { cites[c.ref] = c; items.push(i); };

  // ── merged pull requests on the primary repository (the card: the summary's title, what changed, Sift's rating) ──
  const repo = await primaryRepo(ctx);
  if (repo) {
    const rows = await all<PrEventJoinRow>(ctx,
      `SELECT e.*, s.title AS s_title, s.what AS s_what, s.why AS s_why, s.impact AS s_impact, s.importance AS s_importance
         FROM events e LEFT JOIN pr_summaries s ON s.org_id = ? AND s.semantic_key = e.semantic_key
        WHERE e.org_id = ? AND e.repo = ? AND e.event_type = 'pr_merged'
          AND COALESCE(e.occurred_at, e.recorded_at) >= ? AND COALESCE(e.occurred_at, e.recorded_at) < ?
        ORDER BY COALESCE(e.occurred_at, e.recorded_at) DESC, e.id DESC LIMIT ${MAX_PRS}`,
      ctx.orgId, ctx.orgId, repo, start.toISOString(), until.toISOString());
    for (const r of rows) {
      let pr;
      try { pr = toMyWorkPr(r); } catch { continue; } // a malformed raw is skipped, never guessed at
      add({ ref: `pr:${pr.number}`, kind: "pr", at: day(pr.occurredAt), title: clip(pr.displayTitle ?? pr.title, 200) || `#${pr.number}`,
        detail: pr.what ? clip(pr.what, 280) : null, importance: pr.importance ?? null, who: r.subject_login ?? null },
      { ref: `pr:${pr.number}`, label: `#${pr.number}`, href: pr.url ?? null });
    }
  }

  // ── the feed's session notes (the Feed's own read: importance as the Feed shows it) ──
  const notes = (await get_feed(ctx, { since: start.toISOString(), limit: 200 }))
    .filter((f) => inWindow(f.created_at, start, until) && !HANDOFF_LINE.test(f.summary))
    .slice(0, MAX_NOTES);
  for (const f of notes) {
    add({ ref: `feed:${f.id}`, kind: "note", at: day(f.created_at), title: clip(f.summary, 200), detail: f.brief ? clip(f.brief, 280) : null,
      importance: isFeedImportance(f.importance) ? f.importance : null, who: f.ai?.subject ?? f.author },
    { ref: `feed:${f.id}`, label: clip(f.summary, 48) || `feed entry ${f.id}`, href: "#feed" });
  }

  // ── tickets a person marked done this week (a person's act: nothing infers it) ──
  const done = await all<{ number: number; title: string; at: string; actor: string }>(ctx,
    `SELECT t.number, t.title, MAX(e.created_at) AS at, e.actor FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id AND t.org_id = ?
      WHERE e.org_id = ? AND e.to_status = 'done' AND t.status = 'done' AND e.created_at >= ? AND e.created_at < ? AND t.number IS NOT NULL
      GROUP BY t.id ORDER BY at DESC LIMIT ${MAX_TICKETS}`,
    ctx.orgId, ctx.orgId, start.toISOString(), until.toISOString());
  for (const t of done) {
    add({ ref: `ticket:${t.number}`, kind: "ticket", at: day(t.at), title: clip(t.title, 200), detail: null, importance: null, who: t.actor },
      { ref: `ticket:${t.number}`, label: `#${t.number}`, href: `#tickets/${t.number}` });
  }

  // ── sprints a person completed this week ──
  const sprints = await all<{ id: number; title: string; updated_at: string }>(ctx,
    `SELECT id, title, updated_at FROM sprints WHERE org_id = ? AND status = 'done' AND updated_at >= ? AND updated_at < ? ORDER BY updated_at DESC LIMIT 5`,
    ctx.orgId, start.toISOString(), until.toISOString());
  for (const s of sprints) {
    add({ ref: `sprint:${s.id}`, kind: "sprint", at: day(s.updated_at), title: clip(s.title, 200), detail: null, importance: null, who: null },
      { ref: `sprint:${s.id}`, label: clip(s.title, 48), href: "#roadmap" });
  }

  const ordered = orderWeekItems(items).slice(0, MAX_ITEMS);
  const keepRefs = new Set(ordered.map((i) => i.ref));
  for (const r of Object.keys(cites)) if (!keepRefs.has(r)) delete cites[r];
  return { weekId, from: day(start.toISOString()), to: day(new Date(end.getTime() - 1).toISOString()), items: ordered, cites };
}

export interface WeekJobInput { week: WeekInput }

export const weekJob: ClaudeJob<WeekJobInput, WeekAnswer> = {
  provider: "claude",
  kind: "digest.week",
  name: WEEK_JOB,
  scope: "digest",
  keyPrefix: "week:",
  promptVersion: WEEK_PROMPT_VERSION,
  group: 1,
  batch: true, // non-urgent: the Message Batches API, half the price
  schema: WeekAnswerSchema,
  maxTokens: 1000,
  /** Null — and NO request — for a malformed key, a week that already has highlights (one per org per week), or a
   *  week with nothing in it. */
  async input(ctx: TenantContext, scope: DirtyScope): Promise<WeekJobInput | null> {
    const k = parseWeekScopeKey(scope.key);
    if (!k) return null;
    if (await weekHighlights(ctx, k.weekId)) return null;
    const week = await buildWeekInput(ctx, k.weekId, k.end);
    return week.items.length ? { week } : null;
  },
  prompt(items: readonly JobItem<WeekJobInput>[]) {
    return { system: WEEK_SYSTEM, input: weekPromptInput(items[0].input.week) };
  },
  async write(ctx, items, output, meta) {
    const written: string[] = [];
    for (const it of items) {
      const lines = weekFromAnswer(it.input.week, keep(output).kept);
      if (!lines.length) continue; // nothing valid: nothing written
      await storeWeekHighlights(ctx, {
        week_id: it.input.week.weekId, generated_at: nowIso(), model: meta.model, prompt_version: WEEK_PROMPT_VERSION, highlights_json: JSON.stringify(lines),
      });
      written.push(it.scope.key);
    }
    return written;
  },
};
