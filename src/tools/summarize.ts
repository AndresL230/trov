import type { PrSummaryRow, IssueSummaryRow } from "@shared/rows";
import { type TenantContext, run, nowIso } from "../data/sql";

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

// Capture-time summaries come from Google Gemini (gemini-2.5-flash-lite) over the
// REST generateContent endpoint — the same provider sapling standardizes on, so
// this reuses one team-wide GEMINI_API_KEY. Flash-Lite is fast and cheap; a
// healthy call resolves in ~1s. The prior Workers AI path (gemma-4-26b) started
// fast-failing once the daily Neuron budget was exhausted, silently regressing
// every live capture to the excerpt fallback.
const GEMINI_MODEL = "gemini-2.5-flash-lite";

// The summarizer runs INLINE on the webhook/backfill request, so a slow or hung
// call must never wedge capture. Every call is raced against this timeout via an
// AbortSignal (aborting the in-flight fetch), degrading to the excerpt fallback
// instead of stalling; 10s is comfortably above a healthy Flash-Lite latency.
export const GEMINI_TIMEOUT_MS = 10000;

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

// Gemini's generateContent nests the model text under
// candidates[0].content.parts[0].text. Anything else (a safety block that
// returns no candidate, a malformed shape) yields null → the excerpt fallback.
function extractGeminiText(data: unknown): string | null {
  const t = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> } | null)
    ?.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof t === "string" ? t : null;
}

/** Extracts the single JSON object a summarizer prompt demands. Strips an
 *  accidental markdown fence, then tolerates any prose the model prepends or
 *  appends around the object by slicing from the first `{` to the last `}`;
 *  anything that isn't one JSON object → null. */
export function parseStructuredJson(text: string): Record<string, unknown> | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const parsed: unknown = JSON.parse(stripped.slice(first, last + 1));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Field coercion: required = non-empty string after trim (else the whole
// object is rejected); nullable = trimmed string, '' / null / undefined → null,
// any other type rejects the whole object (undefined is the reject marker).
function reqStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function nullableStr(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export function validatePrSummary(o: Record<string, unknown>): PrSummary | null {
  const title = reqStr(o.title);
  const what = reqStr(o.what);
  if (title === null || what === null) return null;
  const why = nullableStr(o.why);
  const impact = nullableStr(o.impact);
  if (why === undefined || impact === undefined) return null;
  return { title, what, why, impact };
}

export function validateIssueSummary(o: Record<string, unknown>): IssueSummary | null {
  const title = reqStr(o.title);
  const summary = reqStr(o.summary);
  if (title === null || summary === null) return null;
  const next_step = nullableStr(o.next_step);
  if (next_step === undefined) return null;
  return { title, summary, next_step };
}

/** Injectable overrides for both Gemini summarizers — the model string, the
 *  inline-call timeout, and the fetch impl (stubbed in tests, never the network). */
export interface GeminiOpts {
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Told the SIZE of every call once it has ended, whatever its outcome — what the per-org metering
   *  records (src/plans/summaries.ts). Sizes only: it is never handed the text. */
  onCall?: (size: SummaryCallSize) => void;
}

/** One summarizer call's size. Characters are always known; the token counts are Gemini's own
 *  (`usageMetadata`), present only when its answer carried them. */
export interface SummaryCallSize {
  inputChars: number;
  outputChars: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

function geminiTokens(data: unknown): { inputTokens: number | null; outputTokens: number | null } {
  const u = (data as { usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown } } | null)?.usageMetadata;
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  return { inputTokens: n(u?.promptTokenCount), outputTokens: n(u?.candidatesTokenCount) };
}

/** Shared Gemini call machinery for both summarizers — only the prompt and
 *  validator differ. Never throws: any failure (network, non-2xx, timeout,
 *  empty output, prose instead of JSON, malformed/mistyped fields) resolves to
 *  null so the caller falls back to excerptSummary.
 *
 *  The call runs inline on the webhook/backfill request the browser waits on, so
 *  it's raced against a timeout via an AbortSignal — when the timer fires it
 *  aborts the in-flight fetch (whose rejection lands in the catch) and degrades
 *  to the excerpt fallback instead of wedging capture. clearTimeout in finally so
 *  a healthy call doesn't leave the timer pending. */
function makeGeminiSummarizer<T>(
  apiKey: string,
  systemPrompt: string,
  validate: (o: Record<string, unknown>) => T | null,
  opts?: GeminiOpts
): Summarizer<T> {
  const model = opts?.model ?? GEMINI_MODEL;
  const timeoutMs = opts?.timeoutMs ?? GEMINI_TIMEOUT_MS;
  const doFetch = opts?.fetchImpl ?? fetch;
  return {
    model,
    async summarize({ title, body }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const userText = `Title: ${title}\n\nBody: ${body}`;
      const size: SummaryCallSize = { inputChars: systemPrompt.length + userText.length, outputChars: 0, inputTokens: null, outputTokens: null };
      try {
        const res = await doFetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: "user", parts: [{ text: userText }] }],
              generationConfig: { response_mime_type: "application/json", temperature: 0 },
            }),
            signal: controller.signal,
          }
        );
        if (!res.ok) return null;
        const data: unknown = await res.json();
        Object.assign(size, geminiTokens(data));
        const text = extractGeminiText(data);
        if (text === null) return null;
        size.outputChars = text.length;
        const obj = parseStructuredJson(text);
        return obj === null ? null : validate(obj);
      } catch (err) {
        // A timeout/abort, a network error, or malformed output all land here and
        // degrade to the excerpt fallback. Logged so a spike (bad key, Gemini
        // outage) is visible in `wrangler tail`.
        const kind = systemPrompt === SUMMARIZER_SYSTEM_PROMPT ? "pr" : "issue";
        console.error(`geminiSummarizer (${kind}) failed:`, err instanceof Error ? err.message : err);
        return null;
      } finally {
        clearTimeout(timer);
        try { opts?.onCall?.(size); } catch { /* a listener never fails a summary */ }
      }
    },
  };
}

/** PR summarizer. Bounded to that PR's own title+body — no other context is sent.
 *  `opts` (injectable for tests) overrides model/timeout/fetch; any failure → null → excerpt. */
export function geminiPrSummarizer(apiKey: string, opts?: GeminiOpts): Summarizer<PrSummary> {
  return makeGeminiSummarizer(apiKey, SUMMARIZER_SYSTEM_PROMPT, validatePrSummary, opts);
}

/** Issue summarizer. Bounded to that issue's own title+body — no other context is sent.
 *  `opts` (injectable for tests) overrides model/timeout/fetch; any failure → null → excerpt. */
export function geminiIssueSummarizer(apiKey: string, opts?: GeminiOpts): Summarizer<IssueSummary> {
  return makeGeminiSummarizer(apiKey, ISSUE_SUMMARIZER_SYSTEM_PROMPT, validateIssueSummary, opts);
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
 * excerpt). On success, title/what/why/impact are stored. INSERT OR REPLACE
 * keeps one row per semantic_key. NEVER throws — a summary failure must not fail
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
    `INSERT OR REPLACE INTO pr_summaries (org_id, semantic_key, pr_number, model, created_at, title, what, why, impact)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
