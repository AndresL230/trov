// THE AI PASS (docs/architecture/ai.md › The pass): the one place, besides the capture-time summary seams
// (src/tools/summarize.ts), where Trov calls a model — on its own, from the `*/10` repo tick
// (src/repo/cron.ts), never on a render path and never from MCP (test/secrets.mcp.test.ts).
//
// It is a SKELETON today. What runs is decided by the JOB REGISTRY, and the registry is EMPTY (`AI_JOBS`):
// no producer exists yet (docs/superpowers/specs/2026-10-14-ai-base.md), so the pass returns before it
// reads anything — no statement, no request, no log line. A job is added by putting it in `AI_JOBS`; this
// file then gives it, unchanged:
//   • ROTATION — orgs in a stable order, starting after the one the last tick stopped at (`cron_cursor`,
//     job `ai_pass`; ./../repo/dispatch.ts `rotated`). The cursor is written only when a tick could not
//     finish every org, so with few orgs it is never written.
//   • ELIGIBILITY — per org, ONE statement (./eligibility.ts): `off` and `no_key` are skipped; `capped`
//     makes no call and counts one `ai_run_capped:<kind>` per job that had work.
//   • THE ALLOWANCE — every call is one `ai_runs` of the org's month, and the pass never starts one the
//     org does not have left (the count read at the org's start, less what this tick spent).
//   • THE CAPS — at most `AI_RUNS_PER_TICK` calls per tick across every org, and none the invocation's
//     budget (`Budget`: the cron's subrequest count and wall clock, shared with the health pings) cannot
//     afford. Every call goes through the budget's own fetch, so what it really spent is counted.
//   • METERING (src/data/meter.ts, actor `ai-pass`) — the attempt `ai_run:<kind>` BEFORE the call, so a
//     concurrent reader sees it; after it, `ai_run_failed:<kind>` when nothing was written, and the
//     provider's token counts (`ai_tokens_in` / `_out` / `_cached`) through its `onCall`.
//   • ISOLATION — one org's failure (a read, a job's throw) is logged by name with the org id, and the
//     loop moves on. Nothing throws out of `runAiPass`.
import type { Env } from "../env";
import { platform, systemTenant, type TenantContext } from "../data/context";
import {
  METRIC_AI_TOKENS_CACHED, METRIC_AI_TOKENS_IN, METRIC_AI_TOKENS_OUT,
  aiRunCappedMetric, aiRunFailedMetric, aiRunMetric, meterBy,
} from "../data/meter";
import { planRefusal } from "@shared/plans";
import { listActiveOrgIds, readCursor, writeCursor } from "../platform/jobs";
import { rotated, type Budget } from "../repo/dispatch";
import { providerFor, type AiProviderOpts, type AiUsage, type ClaudeKind, type ClaudeProvider } from "./client";
import { aiAllowance } from "./eligibility";

/** One kind of work the pass does for an org. A job never decides eligibility, metering or caps — the
 *  pass does — and it reaches D1 only through the context it is handed. */
export interface AiJob {
  kind: ClaudeKind;
  /** How many calls the job has waiting for this org right now (0 = nothing to do). D1 only, no model. */
  pending(ctx: TenantContext): Promise<number>;
  /** Do ONE unit of the waiting work: at most ONE model call, through `provider`. `done` = it wrote what it
   *  should; `failed` = it wrote nothing (a null answer, a refusal). Throwing counts as `failed`. */
  run(ctx: TenantContext, provider: ClaudeProvider): Promise<"done" | "failed">;
}

/** THE registry. Empty: nothing produces AI content yet. */
export const AI_JOBS: readonly AiJob[] = [];

/** Model calls one tick may make, across every org. */
export const AI_RUNS_PER_TICK = 12;
/** The `cron_cursor` job key. */
export const AI_PASS_JOB = "ai_pass";
/** Who the pass's meter rows are counted against (`org_usage_daily.actor`). */
export const AI_PASS_ACTOR = "ai-pass";
/** Subrequests one call costs (the provider makes no retries: `maxRetries: 0`). */
export const AI_CALL_COST = 1;

export interface AiPassOpts {
  /** The registry to run (tests). Default `AI_JOBS`. */
  jobs?: readonly AiJob[];
  /** The clock the month is read at and the meter rows are dated by. */
  now?: Date;
  /** Calls per tick (tests). Default `AI_RUNS_PER_TICK`. */
  perTick?: number;
  /** The provider's model / timeout (tests). Its fetch is always the budget's. */
  ai?: Pick<AiProviderOpts, "model" | "timeoutMs">;
}

export interface AiPassResult {
  /** Model calls made (attempted). */
  calls: number;
  /** Orgs whose turn finished this tick, in order. */
  served: string[];
  /** Orgs left for the next tick. */
  deferred: number;
}

const NOTHING: AiPassResult = { calls: 0, served: [], deferred: 0 };

/**
 * One tick's pass. `budget` is the cron invocation's (src/repo/dispatch.ts): the pass starts a call only
 * while one more fits under `budget.limit` and the wall clock is not spent, and stops — leaving the
 * cursor at the last org it finished — the moment a call does not fit or `AI_RUNS_PER_TICK` is reached.
 */
export async function runAiPass(env: Env, budget: Budget, opts: AiPassOpts = {}): Promise<AiPassResult> {
  const jobs = opts.jobs ?? AI_JOBS;
  const apiKey = env.ANTHROPIC_API_KEY;
  // Nothing registered, or no key: nothing could run, so nothing is read.
  if (jobs.length === 0 || !apiKey) return NOTHING;
  const perTick = opts.perTick ?? AI_RUNS_PER_TICK;
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const p = platform(env, AI_PASS_ACTOR);
  let calls = 0;
  const canCall = (): boolean =>
    calls < perTick && budget.spent + AI_CALL_COST <= budget.limit && Date.now() - budget.started <= budget.wallMs;
  const meter = (orgId: string, entries: [string, number][]) => meterBy(p, orgId, AI_PASS_ACTOR, entries, at);

  /** One org's turn. false = it still had work when the tick ran out: the next tick starts with it. */
  const serveOrg = async (orgId: string): Promise<boolean> => {
    const ctx = systemTenant(p, orgId, "system");
    let allowance;
    try {
      allowance = await aiAllowance(ctx, env, now);
    } catch (e) {
      console.error("ai pass: allowance read failed", e instanceof Error ? e.name : "error", `org=${orgId}`);
      return true;
    }
    if (allowance.eligibility === "off" || allowance.eligibility === "no_key") return true;
    let used = allowance.used;
    for (const job of jobs) {
      let pending = 0;
      try {
        pending = Math.max(0, Math.floor(Number(await job.pending(ctx)) || 0));
      } catch (e) {
        console.error("ai pass: pending failed", job.kind, e instanceof Error ? e.name : "error", `org=${orgId}`);
        continue;
      }
      for (let i = 0; i < pending; i++) {
        // The allowance (or an ended plan): no call, and the job's waiting work is counted once.
        if (planRefusal(allowance.plan, "ai_runs", used, 1)) {
          await meter(orgId, [[aiRunCappedMetric(job.kind), 1]]);
          break;
        }
        if (!canCall()) return false;
        // The attempt is counted BEFORE the call, so a concurrent reader sees it for the call's whole length.
        await meter(orgId, [[aiRunMetric(job.kind), 1]]);
        used++;
        calls++;
        let size: AiUsage | null = null;
        let outcome: "done" | "failed" = "failed";
        try {
          const provider = providerFor(job.kind, { ...opts.ai, apiKey, fetchImpl: budget.fetch, onCall: (u) => { size = u; } });
          if (provider) outcome = (await job.run(ctx, provider)) === "done" ? "done" : "failed";
        } catch (e) {
          console.error("ai pass: run failed", job.kind, e instanceof Error ? e.name : "error", `org=${orgId}`);
        }
        const s = size as AiUsage | null;
        await meter(orgId, [
          [aiRunFailedMetric(job.kind), outcome === "failed" ? 1 : 0],
          [METRIC_AI_TOKENS_IN, s?.inputTokens ?? 0], [METRIC_AI_TOKENS_OUT, s?.outputTokens ?? 0], [METRIC_AI_TOKENS_CACHED, s?.cachedTokens ?? 0],
        ]);
      }
    }
    return true;
  };

  try {
    const orgs = (await listActiveOrgIds(p)).map((id) => ({ key: id, orgId: id, cost: AI_CALL_COST }));
    if (orgs.length === 0) return NOTHING;
    const cursor = await readCursor(p, AI_PASS_JOB);
    const order = rotated(orgs, cursor);
    const served: string[] = [];
    for (const unit of order) {
      if (!canCall()) break;
      if (!(await serveOrg(unit.orgId))) break;
      served.push(unit.key);
    }
    const deferred = order.length - served.length;
    // Every org finished → the next tick starts from the top. Otherwise it resumes after the last one
    // finished; with none finished (nothing was affordable) the cursor stands.
    const next = deferred === 0 ? "" : served.length ? served[served.length - 1] : cursor;
    if (next !== cursor) await writeCursor(p, AI_PASS_JOB, next);
    if (deferred) console.warn("ai pass", `finished ${served.length} of ${order.length} orgs; the rest resume next tick`);
    return { calls, served, deferred };
  } catch (e) {
    console.error("ai pass", e instanceof Error ? e.name : "error");
    return { calls, served: [], deferred: 0 };
  }
}
