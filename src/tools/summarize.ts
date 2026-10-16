import type { PrSummaryRow, IssueSummaryRow } from "@shared/rows";
import { z } from "zod";
import { type TenantContext, run, nowIso } from "../data/sql";
import { AI_TIMEOUT_MS, CLAUDE_MODEL, providerFor, type AiUsage, type ClaudeKind } from "../ai/client";

export type { AiUsage };

// Capture-time completed-PR summarizer. Runs ONCE, when the webhook captures a
// newly-written pr_merged/pr_closed event (src/webhook.ts) — never at render
// time. A summary failure (throw, empty response) must never fail capture; the
// deterministic excerpt fallback guarantees storePrSummary always succeeds.

/** Structured PR summary — the JSON object the PR prompt demands. */
export interface PrSummary {
  title: string;          // humanized display title, grounded in the real title+body
  what: string;           // the concrete change that shipped
  why: string | null;     // motivation, only when the body states one
  impact: string | null;  // one user-facing outcome sentence, never files
}

/** Structured issue summary — the JSON object the issue prompt demands. */
export interface IssueSummary {
  title: string;
  summary: string;          // plain restatement of what the issue is
  next_step: string | null; // only when the issue states/implies an action
}

/** One PR/issue's title+body in, a validated structured summary (or null) out.
 *  `model` is the provenance recorded on the stored row. */
export interface Summarizer<T> {
  readonly model: string;
  summarize(input: { title: string; body: string }): Promise<T | null>;
}

// Capture-time summaries come from Anthropic's Claude (claude-haiku-5-5) through the shared model
// client (src/ai/client.ts: structured outputs, so the answer is the schema's JSON object). One
// platform key (ANTHROPIC_API_KEY) serves every org; Haiku is fast and cheap.

// The summarizer runs INLINE on the webhook/backfill request, so a slow or hung
// call must never wedge capture. Every call carries this deadline (the client
// aborts the in-flight request when it passes), degrading to the excerpt fallback
// instead of stalling; GitHub gives a hook 10s.
export const SUMMARY_TIMEOUT_MS = AI_TIMEOUT_MS;

// Room for the answer (a few short sentences) plus whatever thinking the model does at low effort. An
// answer cut off here is no answer (stop_reason max_tokens → the excerpt).
export const SUMMARY_MAX_TOKENS = 2048;

// The description is the one unbounded part of a call, and input is most of its cost (one platform key
// pays for every org — docs/architecture/plans.md › AI summaries). At most this many characters of it
// are sent; the title always goes whole. A summary of a longer description reads its opening.
export const SUMMARY_BODY_MAX = 8000;

/** The description as sent: at most `SUMMARY_BODY_MAX` characters, never ending in half a surrogate pair. */
export function capSummaryBody(body: string): string {
  if (body.length <= SUMMARY_BODY_MAX) return body;
  const cut = /[\uD800-\uDBFF]/.test(body[SUMMARY_BODY_MAX - 1]) ? SUMMARY_BODY_MAX - 1 : SUMMARY_BODY_MAX;
  return body.slice(0, cut);
}

export const SUMMARIZER_SYSTEM_PROMPT =
  "Summarize this pull request for a team activity feed — what shipped. " +
  "Respond with a SINGLE JSON object and nothing else — no code fences, no preamble: " +
  '{"title": string, "what": string, "why": string or null, "impact": string or null}. ' +
  '"title": a short humanized sentence-case rewrite of what the PR did, grounded only in the provided title and description — never invent scope. ' +
  '"what": 1-2 sentences leading with the concrete change that shipped; do not just restate the title. ' +
  '"why": the motivation, only where the description states one; else null. ' +
  '"impact": one sentence on the outcome for people using the product — what it enables or fixes; NEVER a list of files touched; null when the description does not support one. ' +
  "The description records work that already happened — report what it states, never extrapolate beyond it. " +
  'If the description is empty or too thin to add anything beyond the title, use the title verbatim for "title" and "what" and null for "why" and "impact".';

export const ISSUE_SUMMARIZER_SYSTEM_PROMPT =
  "Summarize this GitHub issue for a personal to-do list. " +
  "Respond with a SINGLE JSON object and nothing else — no code fences, no preamble: " +
  '{"title": string, "summary": string, "next_step": string or null}. ' +
  '"title": a short humanized sentence-case rewrite of what the issue is about, grounded only in its title and description. ' +
  '"summary": 1-3 sentences plainly restating what the issue is, grounded only in its title and description. ' +
  '"next_step": what needs doing, ONLY where the issue states or clearly implies an action; if the issue is vague, aspirational, or states no clear action, use null — never invent a next step, a plan, or a scope the issue never stated. ' +
  'If the description is empty or too thin, use the title verbatim for "title" and "summary" and null for "next_step".';

// The answers' shapes. The JSON Schema of each (src/ai/schema.ts) constrains what the model writes; the
// zod schema then checks the parsed answer: a required field is a non-empty string after trim (else the
// whole answer is rejected), a nullable one is a trimmed string or null, with '' → null.
const requiredText = z.string().trim().min(1);
const nullableText = z.string().trim().nullable().transform((v) => (v ? v : null));

export const PrSummarySchema: z.ZodType<PrSummary> = z.object({ title: requiredText, what: requiredText, why: nullableText, impact: nullableText });
export const IssueSummarySchema: z.ZodType<IssueSummary> = z.object({ title: requiredText, summary: requiredText, next_step: nullableText });

/** Injectable overrides for both summarizers — the model string, the
 *  inline-call timeout, and the fetch impl (stubbed in tests, never the network). */
export interface AiOpts {
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Told the SIZE of every call once it has ended, whatever its outcome — what the per-org metering
   *  records (src/plans/summaries.ts). Sizes only: it is never handed the text. A call no response came
   *  back for reports the characters it sent and zero tokens. */
  onCall?: (usage: AiUsage) => void;
}

/** Shared machinery for both summarizers — only the kind, prompt and schema
 *  differ. Never throws: any failure (network, non-2xx, timeout, a refusal, an
 *  answer cut off at max_tokens, malformed/mistyped fields) resolves to null so
 *  the caller falls back to excerptSummary. The call itself is the shared client's
 *  (src/ai/client.ts), which aborts the in-flight request at the deadline. */
function makeClaudeSummarizer<T>(
  apiKey: string,
  kind: ClaudeKind,
  systemPrompt: string,
  schema: z.ZodType<T>,
  opts?: AiOpts
): Summarizer<T> {
  const model = opts?.model ?? CLAUDE_MODEL;
  return {
    model,
    async summarize({ title, body }) {
      const input = `Title: ${title}\n\nBody: ${capSummaryBody(body)}`;
      let usage: AiUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, inputChars: systemPrompt.length + input.length, outputChars: 0 };
      try {
        const provider = providerFor(kind, {
          apiKey,
          model,
          fetchImpl: opts?.fetchImpl,
          timeoutMs: opts?.timeoutMs ?? SUMMARY_TIMEOUT_MS,
          onCall: (u) => { usage = u; },
        });
        const answer = provider ? await provider.structured({ kind, system: systemPrompt, input, schema, maxTokens: SUMMARY_MAX_TOKENS }) : null;
        return answer?.value ?? null;
      } catch {
        return null; // the client never throws; a summary failure never fails capture either way
      } finally {
        try { opts?.onCall?.(usage); } catch { /* a listener never fails a summary */ }
      }
    },
  };
}

/** PR summarizer. Bounded to that PR's own title+body — no other context is sent.
 *  `opts` (injectable for tests) overrides model/timeout/fetch; any failure → null → excerpt. */
export function claudePrSummarizer(apiKey: string, opts?: AiOpts): Summarizer<PrSummary> {
  return makeClaudeSummarizer(apiKey, "summary_pr", SUMMARIZER_SYSTEM_PROMPT, PrSummarySchema, opts);
}

/** Issue summarizer. Bounded to that issue's own title+body — no other context is sent.
 *  `opts` (injectable for tests) overrides model/timeout/fetch; any failure → null → excerpt. */
export function claudeIssueSummarizer(apiKey: string, opts?: AiOpts): Summarizer<IssueSummary> {
  return makeClaudeSummarizer(apiKey, "summary_issue", ISSUE_SUMMARIZER_SYSTEM_PROMPT, IssueSummarySchema, opts);
}

const EXCERPT_MAX = 280;

/** Deterministic fallback: first 280 chars of the body with whitespace
 *  collapsed, suffixed `…` when truncated. Empty body → the title verbatim. */
export function excerptSummary(title: string, body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return title;
  if (collapsed.length <= EXCERPT_MAX) return collapsed;
  return collapsed.slice(0, EXCERPT_MAX) + "…";
}

/**
 * Try the summarizer; on any null/throw store a marker row (model:'excerpt',
 * NULL structured columns) with no content — a PR is structured-only, so the
 * fallback is just a "not summarized yet" marker that Sync retries (not a prose
 * excerpt). On success, title/what/why/impact are stored. The upsert keeps one
 * row per semantic_key (and the row's computed `importance`). NEVER throws — a summary failure must not fail
 * the webhook capture that triggered it.
 */
export async function storePrSummary(
  ctx: TenantContext,
  summarizer: Summarizer<PrSummary> | null,
  pr: { semantic_key: string; pr_number: number; title: string; body: string }
): Promise<PrSummaryRow> {
  let structured: PrSummary | null = null;
  let model = "excerpt";
  if (summarizer) {
    try {
      structured = await summarizer.summarize({ title: pr.title, body: pr.body });
      if (structured) model = summarizer.model;
    } catch {
      structured = null;
    }
  }
  const created_at = nowIso();
  await run(
    ctx,
    // An upsert of the summary's OWN columns, never a REPLACE: a re-summarized PR keeps what the AI pass computed
    // about it (`importance`, 0060 — src/ai/importance.ts).
    `INSERT INTO pr_summaries (org_id, semantic_key, pr_number, model, created_at, title, what, why, impact)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, repo, semantic_key) DO UPDATE SET pr_number = excluded.pr_number, model = excluded.model, created_at = excluded.created_at,
       title = excluded.title, what = excluded.what, why = excluded.why, impact = excluded.impact`,
    ctx.orgId,
    pr.semantic_key,
    pr.pr_number,
    model,
    created_at,
    structured?.title ?? null,
    structured?.what ?? null,
    structured?.why ?? null,
    structured?.impact ?? null
  );
  return {
    semantic_key: pr.semantic_key,
    pr_number: pr.pr_number,
    model,
    created_at,
    title: structured?.title ?? null,
    what: structured?.what ?? null,
    why: structured?.why ?? null,
    impact: structured?.impact ?? null,
  };
}

/**
 * Issue mirror of storePrSummary: `summary` is the structured summary field on
 * success, the excerpt on fallback; title/next_step NULL on fallback. INSERT OR
 * REPLACE keeps one row per issue_number. NEVER throws.
 */
export async function storeIssueSummary(
  ctx: TenantContext,
  summarizer: Summarizer<IssueSummary> | null,
  issue: { issue_number: number; title: string; body: string }
): Promise<IssueSummaryRow> {
  let structured: IssueSummary | null = null;
  let model = "excerpt";
  if (summarizer) {
    try {
      structured = await summarizer.summarize({ title: issue.title, body: issue.body });
      if (structured) model = summarizer.model;
    } catch {
      structured = null;
    }
  }
  const summary = structured ? structured.summary : excerptSummary(issue.title, issue.body);
  const created_at = nowIso();
  await run(
    ctx,
    `INSERT OR REPLACE INTO issue_summaries (org_id, issue_number, summary, model, created_at, title, next_step)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId,
    issue.issue_number,
    summary,
    model,
    created_at,
    structured?.title ?? null,
    structured?.next_step ?? null
  );
  return {
    issue_number: issue.issue_number,
    summary,
    model,
    created_at,
    title: structured?.title ?? null,
    next_step: structured?.next_step ?? null,
  };
}
