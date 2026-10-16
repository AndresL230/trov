// FEED.IMPORTANCE — the AI pass's Jev job that rates how much a feed entry or a merged PR matters (docs/architecture/
// ai.md › Jobs; docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase C). ONE Jev `choice` question per item —
// routine / notable / breaking — one request per item (`card:feed:<id>` from the gate's `ingestFeedEntry`,
// `card:pr:<n>` from a merge).
//
// What it writes is a COMPUTED FACT, not a suggestion: `feed.importance` / `pr_summaries.importance` (0060). The
// Feed marks notable and breaking entries, `get_feed` and My Work's PRs carry it, Phase B's debounce lets a breaking
// change skip the repo wait, and Phase E's emails pick "notable or breaking" lines from it.
//
// NEVER GUESS. Only an answer Jev gives with at least `IMPORTANCE_MIN_CONFIDENCE` is stored; below it nothing is
// written and the column stays NULL — unknown, which every screen draws exactly as before. A malformed answer is a
// failed attempt (retried on a later tick, at most 3 times), never a default. An item already rated is not asked
// again. No reason is stored or shown: the mark's words are Trov's own.
//
// A BREAKING item marks the org's primary repo `urgent` (`ai_dirty.urgent`, through the router's own `markDirty`),
// so the repo state is rewritten on the next tick instead of after its wait (Pro and Enterprise; shared/ai-core.ts
// `debounceMs`).
//
// It imports no model client (the pass asks Jev for it) and nothing reachable from src/mcp.ts imports it.
import { isFeedImportance, type FeedImportance } from "@shared/ai-core";
import { markDirty, type DirtyScope } from "../data/ai-dirty";
import { first, run, type TenantContext } from "../data/sql";
import { excerptOf } from "../tools/tag-fit";
import type { JevAnswers, JevJob, JevRequest, JobItem } from "./jobs";

type JevQuestion = JevRequest["questions"][string];

export const IMPORTANCE_KIND = "feed.importance";
export const IMPORTANCE_PROMPT_VERSION = "jev-importance-1";
/** The least confidence an answer is stored at — the eval's choice (test/ai-evals/feed.importance/cases.json):
 *  below it the item stays unrated (NULL), never a guessed `routine`. */
export const IMPORTANCE_MIN_CONFIDENCE = 0.7;
/** The most of an entry's or PR's body that is sent (cut and scrubbed like Sift's excerpts: no code, no
 *  credential-shaped strings, no link targets). */
export const IMPORTANCE_EXCERPT_MAX = 600;

/** THE question: one `choice` of the three (shared/ai-core.ts `FEED_IMPORTANCES`). */
export const IMPORTANCE_QUESTION: JevQuestion = {
  type: "choice",
  instructions: "How important is this for the rest of the team to know about? Judge what actually changed for other people, not how much work it took.",
  criteria: {
    routine: "Small, internal or not a change yet: a fix, polish, copy, tests, docs, refactoring or chores, or a note that a task was handed off, planned or started. Nobody needs to act or change how they work.",
    notable: "A change that landed and teammates should know about: a new feature, a visible change to a screen or workflow, or a new capability.",
    breaking: "Changes or removes something people or agents rely on: a renamed or removed API, route, tool, setting, environment variable or address, a data migration, or anything that needs action from others.",
  },
};
const QUESTION_ID = "importance";

/** What is rated: where to store it, the text sent, and the org's primary repo (for the urgent mark). */
export interface ImportanceInput { target: "feed" | "pr"; key: string; text: string; repo: string | null }

/** The org's primary repo, in the same statement as the item. */
const PRIMARY = `(SELECT r.repo_full_name FROM org_repos r WHERE r.org_id = ?1 AND r.is_primary = 1 LIMIT 1)`;

/** A summary has not been written for a merged PR yet (the webhook writes it just after the event): the card fails
 *  this attempt and a later tick tries again. */
class SummaryPending extends Error { override name = "SummaryPending"; }

const join = (...parts: (string | null | undefined)[]): string => parts.map((p) => (p ?? "").trim()).filter(Boolean).join("\n\n");

/** What is sent for a feed entry (`state`): its title, brief and a scrubbed excerpt of its body. Pure — the eval set
 *  (test/ai-evals/feed.importance/) builds its requests with it. */
export function feedImportanceText(row: { summary: string; brief: string | null; body: string | null }): string {
  return join(`Feed entry: ${excerptOf(row.summary, 300)}`, excerptOf(row.brief, 400), excerptOf(row.body, IMPORTANCE_EXCERPT_MAX));
}

/** What is sent for a merged PR: its (humanized) title and its capture-time summary — or, with no summary content,
 *  a scrubbed excerpt of its body. Pure, like `feedImportanceText`. */
export function prImportanceText(n: number, pr: { title: string; body: string | null }, s: { title: string | null; what: string | null; why: string | null; impact: string | null } | null): string {
  const summarized = !!(s && (s.what || s.impact));
  return join(
    `Pull request #${n}: ${excerptOf(s?.title || pr.title, 300)}`,
    summarized && s ? join(s.what && `What changed: ${s.what}`, s.why && `Why: ${s.why}`, s.impact && `Impact: ${s.impact}`)
      : excerptOf(pr.body ?? "", IMPORTANCE_EXCERPT_MAX),
  );
}

/** Store the answer when it is sure enough. true = written (the card clears, whether or not a value was stored). */
async function store(ctx: TenantContext, item: JobItem<ImportanceInput>, res: JevAnswers): Promise<boolean> {
  const a = res.answers[QUESTION_ID];
  if (!a || a.type !== "choice" || !isFeedImportance(a.choice)) return false; // malformed: a failed attempt
  // Below the threshold: unknown. Nothing is written — the card is done, the column stays NULL.
  if (!(a.confidence >= IMPORTANCE_MIN_CONFIDENCE)) return true;
  const value: FeedImportance = a.choice;
  const { target, key, repo } = item.input;
  // Only an unrated row: a value already there (a producer's, or an earlier answer) is never overwritten.
  if (target === "feed") {
    await run(ctx, `UPDATE feed SET importance = ? WHERE org_id = ? AND id = ? AND importance IS NULL`, value, ctx.orgId, Number(key));
  } else {
    await run(ctx, `UPDATE pr_summaries SET importance = ? WHERE org_id = ? AND semantic_key = ? AND importance IS NULL`, value, ctx.orgId, key);
  }
  if (value === "breaking" && repo) await markDirty(ctx, [{ scope: "repo", key: repo, urgent: true }]);
  return true;
}

/** `card:feed:<id>` — an entry the gate wrote. */
export const FEED_IMPORTANCE_JOB: JevJob<ImportanceInput> = {
  name: "feed.importance:feed",
  provider: "jev",
  kind: IMPORTANCE_KIND,
  scope: "card",
  keyPrefix: "feed:",
  promptVersion: IMPORTANCE_PROMPT_VERSION,
  async input(ctx: TenantContext, scope: DirtyScope): Promise<ImportanceInput | null> {
    const id = Number(scope.key.slice("feed:".length));
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const row = await first<{ summary: string; brief: string | null; body: string | null; importance: string | null; repo: string | null }>(ctx,
      `SELECT f.summary, f.brief, f.body, f.importance, ${PRIMARY} AS repo FROM feed f WHERE f.org_id = ?1 AND f.id = ?2`, ctx.orgId, id);
    // Gone, or already rated: nothing to ask.
    if (!row || row.importance !== null) return null;
    return { target: "feed", key: String(id), text: feedImportanceText(row), repo: row.repo };
  },
  ask: ({ input }) => ({ state: input.text, questions: { [QUESTION_ID]: IMPORTANCE_QUESTION } }),
  write: (ctx, item, res) => store(ctx, item, res),
};

/** `card:pr:<n>` — a PR merged on the primary repo: its title and capture-time summary (or, with none, its body's
 *  scrubbed excerpt). */
export const PR_IMPORTANCE_JOB: JevJob<ImportanceInput> = {
  name: "feed.importance:pr",
  provider: "jev",
  kind: IMPORTANCE_KIND,
  scope: "card",
  keyPrefix: "pr:",
  promptVersion: IMPORTANCE_PROMPT_VERSION,
  async input(ctx: TenantContext, scope: DirtyScope): Promise<ImportanceInput | null> {
    const n = Number(scope.key.slice("pr:".length));
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    const key = `gh:pr:${n}:merged`;
    const row = await first<{ raw: string; has: number; title: string | null; what: string | null; why: string | null; impact: string | null; importance: string | null; repo: string | null }>(ctx,
      `SELECT e.raw, s.semantic_key IS NOT NULL AS has, s.title, s.what, s.why, s.impact, s.importance, ${PRIMARY} AS repo
         FROM events e LEFT JOIN pr_summaries s ON s.org_id = e.org_id AND s.semantic_key = e.semantic_key
        WHERE e.org_id = ?1 AND e.semantic_key = ?2 LIMIT 1`, ctx.orgId, key);
    if (!row) return null;
    // The importance is stored on the summary's row: none yet → try again on a later tick.
    if (!Number(row.has)) throw new SummaryPending();
    if (row.importance !== null) return null;
    let pr: { title?: unknown; body?: unknown } = {};
    try { pr = (JSON.parse(row.raw) as { pr?: typeof pr }).pr ?? {}; } catch { /* a raw we cannot read: the summary alone */ }
    const text = prImportanceText(n, { title: typeof pr.title === "string" ? pr.title : "", body: typeof pr.body === "string" ? pr.body : null }, row);
    return { target: "pr", key, text, repo: row.repo };
  },
  ask: ({ input }) => ({ state: input.text, questions: { [QUESTION_ID]: IMPORTANCE_QUESTION } }),
  write: (ctx, item, res) => store(ctx, item, res),
};

/** Both halves of the kind, registered together (one line in `AI_JOBS`). */
export const IMPORTANCE_JOBS: readonly JevJob<ImportanceInput>[] = [FEED_IMPORTANCE_JOB, PR_IMPORTANCE_JOB];
