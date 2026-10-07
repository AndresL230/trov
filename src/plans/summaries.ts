// THE summarizer for an org, right now (docs/architecture/plans.md › AI summaries).
//
// One platform key (`GEMINI_API_KEY`) pays for every org's capture-time summaries, so the choice of
// summarizer is made in ONE place — `orgSummarizers` — for both capture paths (the webhook,
// src/webhook.ts; Sync GitHub, src/tools/backfill.ts). It answers the Gemini summarizer, or null when
//   • the deployment has no key            (`off`    — nothing is counted, nothing is capped),
//   • the org's plan has ended             (`ended`),
//   • the org has used its month's allowance (`capped` — the `ai_summaries` limit, shared/plans.ts).
// A null summarizer is not an error anywhere: the item is stored with the excerpt fallback exactly as
// it always was without a key (src/tools/summarize.ts), and a later Sync fills it in once allowed.
//
// Every call made through the summarizer it hands out is COUNTED for the org (`org_usage_daily`,
// src/data/meter.ts): the attempt before the call, then its outcome and size after it. Sizes only —
// the text never leaves the summarizer.
import type { Env } from "../env";
import { planRefusal, resolveEntitlements } from "@shared/plans";
import type { SummariesStatus } from "@shared/sync";
import { platform, type TenantContext } from "../data/context";
import {
  METRIC_SUMMARY, METRIC_SUMMARY_CAPPED, METRIC_SUMMARY_CHARS_IN, METRIC_SUMMARY_CHARS_OUT, METRIC_SUMMARY_FAILED,
  METRIC_SUMMARY_TOKENS_IN, METRIC_SUMMARY_TOKENS_OUT, meterBy, type SummaryKind,
} from "../data/meter";
import {
  geminiIssueSummarizer, geminiPrSummarizer,
  type GeminiOpts, type IssueSummary, type PrSummary, type SummaryCallSize, type Summarizer,
} from "../tools/summarize";
import { planAndSummaries } from "./gate";

export interface SummaryAllowance {
  status: SummariesStatus;
  /** Attempts this calendar month (UTC), including the ones made through this object. */
  used: number;
  /** The allowance in force; null = unlimited. */
  cap: number | null;
  /** What is left of it, never below 0; null = unlimited. */
  remaining: number | null;
}

export interface OrgSummarizers {
  /** The summarizer for a pull request / an issue NOW, or null (see the file header). Ask per item:
   *  the answer turns null the moment the allowance read at creation is spent. */
  pr(): Summarizer<PrSummary> | null;
  issue(): Summarizer<IssueSummary> | null;
  /** An item was stored with its excerpt because the answer above was null. Counted for the org,
   *  unless the deployment simply has no key. */
  skipped(kind: SummaryKind): Promise<void>;
  /** Where the allowance stands, as of the last call made through this object. */
  allowance(): SummaryAllowance;
}

export interface OrgSummarizersOpts {
  /** Who the calls are counted against: `github-webhook`, or the admin who pressed Sync. */
  actor: string;
  /** The request's `waitUntil`, when it has one (the webhook): metering then never delays the
   *  capture. Without one (Sync, a job) each write is awaited — and never throws. */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Test seams: the Gemini call's fetch / model / timeout, and the clock the month is read from. */
  gemini?: Omit<GeminiOpts, "onCall">;
  now?: Date;
}

const OFF: SummaryAllowance = { status: "off", used: 0, cap: null, remaining: null };

/** Where an org's allowance stands — the read the Sync panel shows before a run. Never throws. */
export async function summaryAllowance(env: Pick<Env, "GEMINI_API_KEY">, ctx: TenantContext, now: Date = new Date()): Promise<SummaryAllowance> {
  if (!env.GEMINI_API_KEY) return OFF;
  const { plan, used } = await planAndSummaries(ctx, now);
  const cap = resolveEntitlements(plan.plan, plan.overrides).ai_summaries;
  const remaining = cap === null ? null : Math.max(0, cap - used);
  // The one question (shared/plans.ts): may this org add one more of `ai_summaries`?
  const refusal = planRefusal(plan, "ai_summaries", used, 1);
  return { status: !refusal ? "on" : plan.status === "canceled" ? "ended" : "capped", used, cap, remaining };
}

/**
 * The summarizers for `ctx`'s org, good for ONE webhook delivery or ONE Sync batch. The allowance is
 * read once, here (one statement); each call made through the result spends one of what was left, so
 * a batch can never make more calls than the org had — only requests that read at the same moment
 * can overshoot, by at most what each of them is allowed to attempt (one call per webhook delivery,
 * `SYNC_SUMMARIES_PER_BATCH` per Sync batch). A failed read answers `off`: no summary, no bill.
 */
export async function orgSummarizers(env: Env, ctx: TenantContext, opts: OrgSummarizersOpts): Promise<OrgSummarizers> {
  const key = env.GEMINI_API_KEY;
  let state: SummaryAllowance = OFF;
  if (key) {
    try {
      state = await summaryAllowance(env, ctx, opts.now);
    } catch (e) {
      console.error("summaries: allowance read failed", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`);
    }
  }
  const p = platform(env, opts.actor);
  const write = async (entries: [string, number][]): Promise<void> => {
    const done = meterBy(p, ctx.orgId, opts.actor, entries, opts.now?.toISOString());
    if (opts.waitUntil) opts.waitUntil(done); else await done;
  };
  const spend = (): boolean => {
    if (state.status !== "on") return false;
    const remaining = state.remaining === null ? null : state.remaining - 1;
    state = { ...state, used: state.used + 1, remaining, status: remaining !== null && remaining <= 0 ? "capped" : "on" };
    return true;
  };

  const metered = <T>(kind: SummaryKind, make: (apiKey: string, o: GeminiOpts) => Summarizer<T>): (() => Summarizer<T> | null) => {
    const model = key ? make(key, {}).model : "";
    const summarizer: Summarizer<T> = {
      model,
      async summarize(input) {
        // Held from before the allowance ran out: nothing is attempted, and the caller's excerpt stands.
        if (!key || !spend()) { await write([[METRIC_SUMMARY_CAPPED[kind], 1]]); return null; }
        // The attempt is counted BEFORE the call, so a concurrent reader sees it for the call's whole length.
        await write([[METRIC_SUMMARY[kind], 1]]);
        let size: SummaryCallSize | null = null;
        let result: T | null = null;
        try {
          result = await make(key, { ...opts.gemini, onCall: (s) => { size = s; } }).summarize(input);
        } catch {
          result = null;
        }
        const s = size as SummaryCallSize | null;
        await write([
          [METRIC_SUMMARY_FAILED[kind], result === null ? 1 : 0],
          [METRIC_SUMMARY_CHARS_IN, s?.inputChars ?? 0], [METRIC_SUMMARY_CHARS_OUT, s?.outputChars ?? 0],
          [METRIC_SUMMARY_TOKENS_IN, s?.inputTokens ?? 0], [METRIC_SUMMARY_TOKENS_OUT, s?.outputTokens ?? 0],
        ]);
        return result;
      },
    };
    return () => (state.status === "on" ? summarizer : null);
  };

  return {
    pr: metered("pr", geminiPrSummarizer),
    issue: metered("issue", geminiIssueSummarizer),
    skipped: (kind) => (state.status === "off" ? Promise.resolve() : write([[METRIC_SUMMARY_CAPPED[kind], 1]])),
    allowance: () => state,
  };
}
