// THE AI PASS (docs/architecture/ai.md › The pass): besides the capture-time summary seams (src/tools/summarize.ts)
// and the Sift run (./sift.ts), the one place Trov calls a model — on its own, from the `*/10` repo tick
// (src/repo/cron.ts), never on a render path and never from MCP (test/secrets.mcp.test.ts).
//
// It works through what the ROUTER marked stale (`ai_dirty`: src/tools/ai-route.ts, src/data/ai-dirty.ts) with the
// jobs in the REGISTRY (`AI_JOBS`, ./jobs.ts). Phase B ships the machinery and an EMPTY registry: no producer
// exists yet (Phases C and D add them), so in production the pass returns before it reads anything — no
// statement, no request, no log line. What every job gets, unchanged:
//   • ROTATION — orgs in a stable order, starting after the one the last tick stopped at (`cron_cursor`, job
//     `ai_pass`; ../repo/dispatch.ts `rotated`). The cursor is written only when a tick could not finish every org.
//   • THE SWITCH AND THE ALLOWANCES — per org, ONE statement (`planAndAiSettings`): the switch off → nothing at
//     all; a Haiku call is one `ai_runs`, a Jev request one `jev_checks`, and neither is ever overspent (the month's
//     use read at the org's start, plus what this tick spent). At an allowance a job makes no call and one
//     `ai_run_capped:<kind>` is counted; the scopes wait.
//   • THE DEBOUNCE — a scope runs only once its wait is over (`debounceMs` / `debounceFrom`, shared/ai-core.ts).
//   • THE ORDER — sessions, cards, briefs, repo state, the org rollup, themes, doc drift (`AI_PASS_STAGES`).
//   • GROUPING — Jev: ONE item per request. Haiku: up to 20 items per call (`groupOf`). A Haiku job may have a Jev
//     GATE before it, asked once per item; when Jev is unavailable the gate's plain rule decides.
//   • THE PREFIX — every Haiku prompt starts with the org's cached prefix (./prefix.ts), built once per org turn.
//   • BATCHES — a job flagged `batch` is queued and submitted through the Message Batches API at the end of the
//     tick, and written when a later tick collects it (./batches.ts).
//   • CLEARING — a written scope is cleared; a failed one gets `attempts + 1` and its error's NAME, and after 3 it
//     waits until it is marked again (src/data/ai-dirty.ts). A scope several jobs take clears when all of them
//     wrote it.
//   • THE CAPS — at most `AI_RUNS_PER_TICK` Haiku calls and `JEV_CALLS_PER_TICK` Jev requests per tick across
//     every org, and none the invocation's budget (the cron's subrequests and wall clock, shared with the health
//     pings) cannot afford. Every call goes through the budget's own fetch.
//   • METERING (src/data/meter.ts, actor `ai-pass`) — `ai_run:<kind>` BEFORE each Haiku call (one call = one run,
//     however many items), `ai_run_failed:<kind>` when it wrote nothing, Claude's tokens; `ai_suggest` (what
//     `jev_checks` counts) BEFORE each Jev request, Jev's tokens.
//   • ISOLATION — one org's failure (a read, a job's throw) is logged by name with the org id and the loop moves
//     on. Nothing throws out of `runAiPass`.
import type { Env } from "../env";
import { platform, systemTenant } from "../data/context";
import {
  METRIC_AI_SUGGEST, METRIC_AI_TOKENS_CACHED, METRIC_AI_TOKENS_IN, METRIC_AI_TOKENS_OUT, METRIC_JEV_TOKENS_IN, METRIC_JEV_TOKENS_OUT,
  aiRunCappedMetric, aiRunFailedMetric, aiRunMetric, meterBy,
} from "../data/meter";
import { planRefusal } from "@shared/plans";
import { AI_PASS_STAGES, debounceFrom, debounceMs, isAiScope } from "@shared/ai";
import { listActiveOrgIds, readCursor, writeCursor } from "../platform/jobs";
import { rotated, type Budget } from "../repo/dispatch";
import { planAndAiSettings } from "../plans/gate";
import { clearScopes, dueScopes, failScopes, type DirtyScope } from "../data/ai-dirty";
import { inFlightCustomIds } from "../data/ai-batches";
import { providerFor, type AiProviderOpts, type AiUsage, type JevAsk, type JevKind } from "./client";
import { groupOf, takes, validJob, customIdOf, type AiJob, type ClaudeJob, type JevGate, type JevJob, type JevRequest, type JobItem } from "./jobs";
import { orgPrefix } from "./prefix";
import { collectBatches, submitBatches, AI_BATCH_PER_TICK, type QueuedRequest } from "./batches";

export type { AiJob } from "./jobs";

/** THE registry. Empty: Phase B ships the machinery; Phases C and D register the producers. */
export const AI_JOBS: readonly AiJob[] = [];

/** Haiku calls one tick may make, across every org. */
export const AI_RUNS_PER_TICK = 12;
/** Jev requests one tick may make, across every org (cards and gates: one subrequest each, no text written). */
export const JEV_CALLS_PER_TICK = 60;
/** The `cron_cursor` job key. */
export const AI_PASS_JOB = "ai_pass";
/** Who the pass's meter rows are counted against (`org_usage_daily.actor`). */
export const AI_PASS_ACTOR = "ai-pass";
/** Subrequests one call costs (Claude makes no retries; Jev's `ask` makes none). */
export const AI_CALL_COST = 1;

export interface AiPassOpts {
  /** The registry to run (tests). Default `AI_JOBS`. */
  jobs?: readonly AiJob[];
  /** The clock: the debounce is measured, the month read and the meter rows dated by it. */
  now?: Date;
  /** Haiku calls per tick (tests). Default `AI_RUNS_PER_TICK`. */
  perTick?: number;
  /** Jev requests per tick (tests). Default `JEV_CALLS_PER_TICK`. */
  jevPerTick?: number;
  /** Batch requests one tick may queue (tests). Default `AI_BATCH_PER_TICK`. */
  batchPerTick?: number;
  /** The providers' model / timeout (tests). Their fetch is always the budget's. */
  ai?: Pick<AiProviderOpts, "model" | "timeoutMs">;
}

export interface AiPassResult {
  /** Model requests made this tick (Haiku calls + Jev requests; a batch submit or collect is not one). */
  calls: number;
  haiku: number;
  jev: number;
  /** Requests handed to a Message Batch this tick, and batch results written. */
  batched: number;
  collected: number;
  /** Orgs whose turn finished this tick, in order. */
  served: string[];
  /** Orgs left for the next tick. */
  deferred: number;
}

const NOTHING: AiPassResult = { calls: 0, haiku: 0, jev: 0, batched: 0, collected: 0, served: [], deferred: 0 };

/** A Jev status that means the PROVIDER refuses (a bad key, rate limited, overloaded, down): Jev is unavailable for
 *  the rest of the tick and no scope is blamed. Anything else (422, 400, 413, a timeout: status 0, Trov refusing to
 *  send: -1) is this ITEM's failure. */
const jevStops = (status: number): boolean => status === 401 || status === 403 || status === 429 || status === 529 || status >= 500;

const errName = (e: unknown): string => (e instanceof Error ? e.name : "error");

/** Is the scope's wait over at `nowMs` (its plan's debounce, from its first or last mark)? */
export function isDue(s: DirtyScope, plan: string, nowMs: number): boolean {
  if (!isAiScope(s.scope)) return false;
  const from = Date.parse(debounceFrom(s.scope) === "last" ? s.markedAt : s.dirtySince);
  return Number.isFinite(from) && from + debounceMs(s.scope, plan, { urgent: s.urgent }) <= nowMs;
}

/**
 * One tick's pass. `budget` is the cron invocation's (src/repo/dispatch.ts): a call starts only while one more fits
 * under `budget.limit` and the wall clock is not spent, and the pass stops — leaving the cursor at the last org it
 * finished — the moment a call it needs does not fit.
 */
export async function runAiPass(env: Env, budget: Budget, opts: AiPassOpts = {}): Promise<AiPassResult> {
  const claudeKey = env.ANTHROPIC_API_KEY;
  const jevKey = env.TYPESAFE_API_KEY;
  // A job runs only with its provider's key (a gated Haiku job needs only Claude's: its gate falls back to rules).
  const jobs = (opts.jobs ?? AI_JOBS).filter((j) => validJob(j) && (j.provider === "claude" ? !!claudeKey : !!jevKey));
  // Nothing registered, or no key for any of it: nothing could run, so nothing is read.
  if (jobs.length === 0) return NOTHING;
  const perTick = opts.perTick ?? AI_RUNS_PER_TICK;
  const jevPerTick = opts.jevPerTick ?? JEV_CALLS_PER_TICK;
  const batchMax = opts.batchPerTick ?? AI_BATCH_PER_TICK;
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const at = now.toISOString();
  const p = platform(env, AI_PASS_ACTOR);
  const tally = { haiku: 0, jev: 0 };
  let jevStopped = !jevKey;
  const queue: QueuedRequest[] = [];
  const room = (): boolean => budget.spent + AI_CALL_COST <= budget.limit && Date.now() - budget.started <= budget.wallMs;
  const canCall = (who: "claude" | "jev"): boolean => (who === "claude" ? tally.haiku < perTick : tally.jev < jevPerTick) && room();
  const meter = (orgId: string, entries: [string, number][]) => meterBy(p, orgId, AI_PASS_ACTOR, entries, at);
  const aiOpts = { ...opts.ai, fetchImpl: budget.fetch };
  const hasBatchJob = jobs.some((j) => j.provider === "claude" && j.batch);

  /** One Jev request, metered BEFORE it is made (`ai_suggest`, what `jev_checks` counts) and its tokens after. */
  const askJev = async (orgId: string, kind: JevKind, req: JevRequest): Promise<JevAsk> => {
    await meter(orgId, [[METRIC_AI_SUGGEST, 1]]);
    tally.jev++;
    const provider = providerFor(kind, { ...aiOpts, apiKey: jevKey });
    const r: JevAsk = provider ? await provider.ask(req.state, req.questions) : { ok: false, status: -1 };
    if (r.ok) await meter(orgId, [[METRIC_JEV_TOKENS_IN, r.usage.inputTokens], [METRIC_JEV_TOKENS_OUT, r.usage.outputTokens]]);
    else if (jevStops(r.status)) jevStopped = true;
    return r;
  };

  /** One org's turn. false = it still had work the tick could not afford: the next tick starts with it. */
  const serveOrg = async (orgId: string, inFlight: Set<string>): Promise<boolean> => {
    const ctx = systemTenant(p, orgId, "system");
    let state: Awaited<ReturnType<typeof planAndAiSettings>>;
    let due: DirtyScope[];
    try {
      state = await planAndAiSettings(ctx, now);
      // The switch off: nothing is read, asked or counted.
      if (!state.enabled) return true;
      due = (await dueScopes(ctx)).filter((s) => isDue(s, state.plan.plan, nowMs) && !inFlight.has(`${orgId}:${s.scope}:${s.key}`));
    } catch (e) {
      console.error("ai pass: read failed", errName(e), `org=${orgId}`);
      return true;
    }
    if (!due.length) return true;
    const plan = state.plan;
    let runsUsed = state.used.ai_runs;
    let jevUsed = state.used.jev_checks;
    let prefix: string | null = null;
    const runAt = at;

    // A scope clears when EVERY job that takes it wrote it; one failure fails it (once).
    const id = (s: DirtyScope): string => `${s.scope}\u0000${s.key}`;
    const need = new Map(due.map((s) => [id(s), jobs.filter((j) => takes(j, s)).length]));
    const failed = new Set<string>();
    const queued = new Set<string>();
    const done = async (s: DirtyScope): Promise<void> => {
      const left = (need.get(id(s)) ?? 1) - 1;
      need.set(id(s), left);
      if (left <= 0 && !failed.has(id(s)) && !queued.has(id(s))) await clearScopes(ctx, [s], runAt).catch((e) => console.error("ai pass: clear failed", errName(e), `org=${orgId}`));
    };
    const fail = async (s: DirtyScope, why: string): Promise<void> => {
      if (failed.has(id(s))) return;
      failed.add(id(s));
      await failScopes(ctx, [s], why).catch((e) => console.error("ai pass: fail write failed", errName(e), `org=${orgId}`));
    };
    /** The item's input; `undefined` when reading it threw (the scope failed). */
    const inputOf = async (job: AiJob, s: DirtyScope): Promise<unknown> => {
      try {
        return await job.input(ctx, s);
      } catch (e) {
        console.error("ai pass: input failed", job.name, errName(e), `org=${orgId}`);
        await fail(s, "input");
        return undefined;
      }
    };
    const cappedOnce = new Set<string>();
    const capped = async (job: AiJob): Promise<void> => {
      if (cappedOnce.has(job.name)) return;
      cappedOnce.add(job.name);
      await meter(orgId, [[aiRunCappedMetric(job.kind), 1]]);
    };
    const prefixOnce = async (): Promise<string> => (prefix ??= await orgPrefix(ctx).catch(() => ""));

    /** A Jev job: one request per item. false = the tick could not afford the next request. */
    const runJev = async (job: JevJob, mine: DirtyScope[]): Promise<boolean> => {
      for (const s of mine) {
        if (jevStopped) return true; // Jev unavailable: the rest wait, nothing is blamed
        if (planRefusal(plan, "jev_checks", jevUsed, 1)) { await capped(job); return true; }
        if (!canCall("jev")) return false;
        const input = await inputOf(job, s);
        if (input === undefined) continue;
        if (input === null) { await done(s); continue; }
        const item: JobItem<unknown> = { scope: s, input };
        let req: JevRequest;
        try { req = job.ask(item); } catch (e) { console.error("ai pass: ask failed", job.name, errName(e), `org=${orgId}`); await fail(s, "ask"); continue; }
        jevUsed++;
        const r = await askJev(orgId, job.kind, req);
        if (!r.ok) {
          if (!jevStops(r.status)) await fail(s, `jev_${r.status}`);
          continue;
        }
        let wrote = false;
        try { wrote = await job.write(ctx, item, { model: r.model, answers: r.answers }); } catch (e) { console.error("ai pass: write failed", job.name, errName(e), `org=${orgId}`); }
        if (wrote) await done(s); else await fail(s, "not_written");
      }
      return true;
    };

    /** A gate's verdict for one item: Jev when it can answer, else the plain rule. `wait` = the tick cannot afford it. */
    const gateOf = async (gate: JevGate, item: JobItem<unknown>): Promise<"pass" | "skip" | "wait"> => {
      const rule = (): "pass" | "skip" => { try { return gate.fallback(item) ? "pass" : "skip"; } catch { return "skip"; } };
      if (jevStopped || planRefusal(plan, "jev_checks", jevUsed, 1)) return rule();
      if (!canCall("jev")) return "wait";
      let req: JevRequest;
      try { req = gate.ask(item); } catch { return rule(); }
      jevUsed++;
      const r = await askJev(orgId, gate.kind, req);
      if (!r.ok) return rule();
      try { return gate.pass({ model: r.model, answers: r.answers }) ? "pass" : "skip"; } catch { return rule(); }
    };

    /** A Haiku job: items gathered into calls of up to `groupOf(job)`, each past its gate; batch jobs queue. */
    const runClaude = async (job: ClaudeJob, mine: DirtyScope[]): Promise<boolean> => {
      const group = groupOf(job);
      let chunk: JobItem<unknown>[] = [];
      let stop = false;
      const flush = async (): Promise<boolean> => {
        if (!chunk.length) return true;
        const items = chunk;
        chunk = [];
        if (planRefusal(plan, "ai_runs", runsUsed, 1)) { await capped(job); stop = true; return true; }
        if (!canCall("claude")) return false;
        let prompt: { system: string; input: string };
        try { prompt = job.prompt(items); } catch (e) {
          console.error("ai pass: prompt failed", job.name, errName(e), `org=${orgId}`);
          for (const it of items) await fail(it.scope, "prompt");
          return true;
        }
        const pre = await prefixOnce();
        // The attempt is counted BEFORE the call, so a concurrent reader sees it for the call's whole length.
        await meter(orgId, [[aiRunMetric(job.kind), 1]]);
        runsUsed++;
        tally.haiku++;
        let size: AiUsage | null = null;
        const provider = providerFor(job.kind, { ...aiOpts, apiKey: claudeKey, onCall: (u) => { size = u; } });
        const res = provider
          ? await provider.structured({ kind: job.kind, system: prompt.system, prefix: pre, cache: true, input: prompt.input, schema: job.schema, maxTokens: job.maxTokens })
          : null;
        let written: readonly string[] = [];
        if (res && provider) {
          try { written = await job.write(ctx, items, res.value, { model: provider.model }); } catch (e) { console.error("ai pass: write failed", job.name, errName(e), `org=${orgId}`); }
        }
        const s = size as AiUsage | null;
        await meter(orgId, [
          [aiRunFailedMetric(job.kind), written.length ? 0 : 1],
          [METRIC_AI_TOKENS_IN, s?.inputTokens ?? 0], [METRIC_AI_TOKENS_OUT, s?.outputTokens ?? 0], [METRIC_AI_TOKENS_CACHED, s?.cachedTokens ?? 0],
        ]);
        for (const it of items) {
          if (written.includes(it.scope.key)) await done(it.scope);
          else await fail(it.scope, res ? "not_written" : "no_answer");
        }
        return true;
      };
      for (const s of mine) {
        if (stop) break;
        if (job.batch) {
          if (queue.length >= batchMax) break;
          if (planRefusal(plan, "ai_runs", runsUsed, 1)) { await capped(job); break; }
        } else if (!canCall("claude")) {
          // No Haiku call is affordable: nothing more is gathered (and no gate is asked) this tick; what was
          // gathered stays dirty for the next one.
          return false;
        }
        const input = await inputOf(job, s);
        if (input === undefined) continue;
        if (input === null) { await done(s); continue; }
        const item: JobItem<unknown> = { scope: s, input };
        if (job.gate) {
          const verdict = await gateOf(job.gate, item);
          if (verdict === "wait") return false;
          if (verdict === "skip") {
            try { await job.gate.skip?.(ctx, item); } catch (e) { console.error("ai pass: skip failed", job.name, errName(e), `org=${orgId}`); }
            await done(s);
            continue;
          }
        }
        if (job.batch) {
          runsUsed++; // reserved now; metered when the batch is submitted
          queued.add(id(s));
          queue.push({ orgId, ctx, job, item, prefix: await prefixOnce(), customId: customIdOf(orgId, s, job.promptVersion) });
          continue;
        }
        chunk.push(item);
        if (chunk.length >= group && !(await flush())) return false;
      }
      return flush();
    };

    for (const stage of AI_PASS_STAGES) {
      for (const job of jobs) {
        if (!stage.includes(job.scope)) continue;
        const mine = due.filter((s) => takes(job, s) && !failed.has(id(s)));
        if (!mine.length) continue;
        try {
          const finished = job.provider === "jev" ? await runJev(job, mine) : await runClaude(job, mine);
          if (!finished) return false;
        } catch (e) {
          console.error("ai pass: job failed", job.name, errName(e), `org=${orgId}`);
        }
      }
    }
    return true;
  };

  let collected = 0;
  let batched = 0;
  try {
    // Last ticks' batches first: what they wrote is in place before this tick reads anything.
    if (hasBatchJob) collected = await collectBatches({ p, jobs, budget, apiKey: claudeKey, ai: opts.ai, at });
    const inFlight = new Set<string>();
    if (hasBatchJob) for (const c of await inFlightCustomIds(p)) inFlight.add(c.slice(0, c.lastIndexOf(":")));
    const orgs = (await listActiveOrgIds(p)).map((id) => ({ key: id, orgId: id, cost: AI_CALL_COST }));
    if (orgs.length === 0) return { ...NOTHING, collected };
    const cursor = await readCursor(p, AI_PASS_JOB);
    const order = rotated(orgs, cursor);
    const served: string[] = [];
    for (const unit of order) {
      if (!room()) break;
      if (!(await serveOrg(unit.orgId, inFlight))) break;
      served.push(unit.key);
    }
    batched = await submitBatches({ p, budget, apiKey: claudeKey, ai: opts.ai, at }, queue);
    const deferred = order.length - served.length;
    // Every org finished → the next tick starts from the top. Otherwise it resumes after the last one
    // finished; with none finished (nothing was affordable) the cursor stands.
    const next = deferred === 0 ? "" : served.length ? served[served.length - 1] : cursor;
    if (next !== cursor) await writeCursor(p, AI_PASS_JOB, next);
    if (deferred) console.warn("ai pass", `finished ${served.length} of ${order.length} orgs; the rest resume next tick`);
    return { calls: tally.haiku + tally.jev, haiku: tally.haiku, jev: tally.jev, batched, collected, served, deferred };
  } catch (e) {
    console.error("ai pass", errName(e));
    return { ...NOTHING, calls: tally.haiku + tally.jev, haiku: tally.haiku, jev: tally.jev, batched, collected };
  }
}
