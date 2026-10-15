// THE BATCH HALF OF THE AI PASS (docs/architecture/ai.md › Batches): non-urgent kinds (theme proposals, theme
// backfill, captions, doc drift, the weekly recap, the narrative proposal — any job flagged `batch`) go through
// Anthropic's Message Batches API at half the price: the pass QUEUES their items during the tick, SUBMITS them as
// one batch at its end, and a LATER tick COLLECTS the results and writes them. Phase B ships the machinery; no
// batch job exists yet.
//
//   submit   ONE `batches.create` (one subrequest) for every queued request, each exactly what a direct call would
//            send — the org's cached prefix first. `ai_run:<kind>` is counted per request BEFORE it (one request
//            is one run). Recorded in `ai_batches` / `ai_batch_requests` (platform: src/data/ai-batches.ts) with
//            `custom_id` = `<org>:<scope>:<key>:<prompt version>`, and each scope HELD (it reads clean, so no tick
//            submits it twice; a mark after the submit makes it due again only once the batch is collected).
//   collect  the oldest open batches, a few per tick: `retrieve` (one subrequest); once it ENDED, `results` (two).
//            Per result — and ONLY for an org that still exists, is not suspended and has the AI switch on (else
//            NOTHING is written: no row, no meter, no scope) — the answer is read exactly as a direct call's
//            (`answer`: refusal / max_tokens / a schema miss is null), the item's input re-read from D1, and the
//            job's `write` stores it; the scope clears, or fails (attempts + 1). Then the batch's counts are kept
//            and its request rows deleted.
import { systemTenant, type PlatformContext, type TenantContext } from "../data/context";
import {
  METRIC_AI_TOKENS_CACHED, METRIC_AI_TOKENS_IN, METRIC_AI_TOKENS_OUT, aiRunFailedMetric, aiRunMetric, meterBy,
} from "../data/meter";
import { clearScopes, failScopes, holdScopes, type DirtyScope, type ScopeKey } from "../data/ai-dirty";
import {
  batchChecked, batchRequests, closeBatch, openBatches, orgsStillOn, recordBatch, type BatchRequestRow,
} from "../data/ai-batches";
import { nowIso } from "../data/sql";
import { providerFor, type AiProviderOpts, type AiUsage, type ClaudeBatchRequest, type ClaudeProvider } from "./client";
import { parseCustomId, type AiJob, type ClaudeJob, type JobItem } from "./jobs";
import type { Budget } from "../repo/dispatch";

/** Requests one tick may queue, across every org. */
export const AI_BATCH_PER_TICK = 100;
/** Open batches one tick asks about. */
export const AI_BATCH_COLLECT_PER_TICK = 3;
/** Subrequests: a submit is one; a collect is a retrieve, then the results (the batch again, then its file). */
export const BATCH_SUBMIT_COST = 1;
export const BATCH_COLLECT_COST = 3;
const ACTOR = "ai-pass";

/** One item waiting for the end-of-tick submit. */
export interface QueuedRequest {
  orgId: string;
  ctx: TenantContext;
  job: ClaudeJob;
  item: JobItem<unknown>;
  /** The org's cached prefix (built once per org turn). */
  prefix: string;
  customId: string;
}

interface Deps {
  p: PlatformContext;
  budget: Budget;
  apiKey: string | undefined;
  ai?: Pick<AiProviderOpts, "model" | "timeoutMs">;
  /** The tick's clock: what the meter rows are dated by, and the HOLD / clear instant of a batch's scopes. */
  at: string;
}

const affords = (b: Budget, cost: number): boolean => b.spent + cost <= b.limit && Date.now() - b.started <= b.wallMs;
const errName = (e: unknown): string => (e instanceof Error ? e.name : "error");
const keyOf = (s: ScopeKey): ScopeKey => ({ scope: s.scope, key: s.key });

/** Submit the tick's queue as ONE batch. Returns how many requests it carried (0 = nothing was submitted: the
 *  queue's scopes stay due, or — when the provider refused — failed). Never throws. */
export async function submitBatches(d: Deps, queue: readonly QueuedRequest[]): Promise<number> {
  if (!queue.length || !d.apiKey) return 0;
  // The budget cannot afford the one request: nothing was counted or held, so every scope simply stays due.
  if (!affords(d.budget, BATCH_SUBMIT_COST)) return 0;
  try {
    const reqs: ClaudeBatchRequest[] = [];
    const rows: BatchRequestRow[] = [];
    const sent: QueuedRequest[] = [];
    for (const q of queue) {
      let prompt: { system: string; input: string };
      try { prompt = q.job.prompt([q.item]); } catch (e) {
        console.error("ai batch: prompt failed", q.job.name, errName(e), `org=${q.orgId}`);
        await failScopes(q.ctx, [keyOf(q.item.scope)], "prompt").catch(() => undefined);
        continue;
      }
      const requestId = `r${reqs.length}`;
      reqs.push({ requestId, req: { kind: q.job.kind, system: prompt.system, prefix: q.prefix, cache: true, input: prompt.input, schema: q.job.schema, maxTokens: q.job.maxTokens } });
      rows.push({ request_id: requestId, custom_id: q.customId, job: q.job.name });
      sent.push(q);
    }
    if (!reqs.length) return 0;
    // The attempts are counted BEFORE the call: one request is one run of its org's month.
    for (const q of sent) await meterBy(d.p, q.orgId, ACTOR, [[aiRunMetric(q.job.kind), 1]], d.at);
    const provider = providerFor(sent[0].job.kind, { ...d.ai, apiKey: d.apiKey, fetchImpl: d.budget.fetch }) as ClaudeProvider | null;
    const batch = provider ? await provider.submitBatch(reqs) : null;
    if (!batch) {
      for (const q of sent) {
        await meterBy(d.p, q.orgId, ACTOR, [[aiRunFailedMetric(q.job.kind), 1]], d.at);
        await failScopes(q.ctx, [keyOf(q.item.scope)], "batch_submit").catch(() => undefined);
      }
      return 0;
    }
    await recordBatch(d.p, batch.id, rows, d.at);
    for (const q of sent) await holdScopes(q.ctx, [keyOf(q.item.scope)], d.at);
    return sent.length;
  } catch (e) {
    console.error("ai batch: submit failed", errName(e));
    return 0;
  }
}

/** Collect the oldest open batches the budget can afford. Returns how many results WROTE. Never throws. */
export async function collectBatches(d: Deps & { jobs: readonly AiJob[] }): Promise<number> {
  if (!d.apiKey) return 0;
  let written = 0;
  try {
    for (const b of await openBatches(d.p, AI_BATCH_COLLECT_PER_TICK)) {
      if (!affords(d.budget, BATCH_COLLECT_COST)) break;
      written += await collectOne(d, b.id, b.submitted_at);
    }
  } catch (e) {
    console.error("ai batch: collect failed", errName(e));
  }
  return written;
}

async function collectOne(d: Deps & { jobs: readonly AiJob[] }, batchId: string, submittedAt: string): Promise<number> {
  const reqs = await batchRequests(d.p, batchId);
  const batchJobs = new Map(d.jobs.filter((j): j is ClaudeJob => j.provider === "claude" && !!j.batch).map((j) => [j.name, j]));
  let size: AiUsage | null = null;
  const anyKind = reqs.map((r) => batchJobs.get(r.job)?.kind).find((k) => !!k) ?? [...batchJobs.values()][0]?.kind;
  const provider = anyKind ? (providerFor(anyKind, { ...d.ai, apiKey: d.apiKey, fetchImpl: d.budget.fetch, onCall: (u) => { size = u; } }) as ClaudeProvider | null) : null;
  if (!provider) return 0;
  const status = await provider.retrieveBatch(batchId);
  const at = nowIso();
  if (status === null) { await batchChecked(d.p, batchId, at); return 0; }
  const parsed = reqs.map((r) => ({ r, id: parseCustomId(r.custom_id) }));
  // ONLY orgs that still exist, are not suspended and have the switch on are written to — anything else, nothing.
  const on = await orgsStillOn(d.p, parsed.flatMap((x) => (x.id ? [x.id.orgId] : [])));
  const scopeOf = (x: NonNullable<(typeof parsed)[number]["id"]>): DirtyScope =>
    ({ scope: x.scope, key: x.key, dirtySince: submittedAt, markedAt: submittedAt, attempts: 0, urgent: false });

  if (status === "gone") {
    // The provider no longer knows it: its scopes are due again (for the orgs that may still be written).
    for (const { id } of parsed) if (id && on.has(id.orgId)) await failScopes(systemTenant(d.p, id.orgId, "system"), [{ scope: id.scope, key: id.key }], "batch_lost").catch(() => undefined);
    await closeBatch(d.p, batchId, "lost", at, null, null);
    return 0;
  }
  if (!status.ended) { await batchChecked(d.p, batchId, at); return 0; }
  const results = await provider.batchResults(batchId);
  if (!results) { await batchChecked(d.p, batchId, at); return 0; }
  const byId = new Map(results.map((r) => [r.requestId, r]));

  let wrote = 0;
  for (const { r, id } of parsed) {
    if (!id || !on.has(id.orgId)) continue; // a deleted, suspended or switched-off org: NOTHING is written
    const ctx = systemTenant(d.p, id.orgId, "system");
    const key: ScopeKey = { scope: id.scope, key: id.key };
    const meter = (entries: [string, number][]) => meterBy(d.p, id.orgId, ACTOR, entries, d.at);
    const job = batchJobs.get(r.job);
    try {
      // The job is gone, or its prompt changed since: the answer is not this build's — the scope runs again.
      if (!job || job.promptVersion !== id.promptVersion) { await failScopes(ctx, [key], "batch_stale"); continue; }
      const res = byId.get(r.request_id);
      if (!res || res.type !== "succeeded") {
        await meter([[aiRunFailedMetric(job.kind), 1]]);
        await failScopes(ctx, [key], `batch_${res?.type ?? "missing"}`);
        continue;
      }
      size = null;
      const answer = provider.answer({ kind: job.kind, schema: job.schema }, res.message);
      const s = size as AiUsage | null;
      await meter([[METRIC_AI_TOKENS_IN, s?.inputTokens ?? 0], [METRIC_AI_TOKENS_OUT, s?.outputTokens ?? 0], [METRIC_AI_TOKENS_CACHED, s?.cachedTokens ?? 0]]);
      if (!answer) { await meter([[aiRunFailedMetric(job.kind), 1]]); await failScopes(ctx, [key], "no_answer"); continue; }
      // The input is read again: what is written is checked against today's rows, never against a stale copy.
      const input = await job.input(ctx, scopeOf(id));
      if (input === null) { await clearScopes(ctx, [key], submittedAt); continue; }
      const out = await job.write(ctx, [{ scope: scopeOf(id), input }], answer.value, { model: provider.model });
      if (out.includes(id.key)) { await clearScopes(ctx, [key], submittedAt); wrote++; }
      else { await meter([[aiRunFailedMetric(job.kind), 1]]); await failScopes(ctx, [key], "not_written"); }
    } catch (e) {
      console.error("ai batch: result failed", r.job, errName(e), `org=${id.orgId}`);
      await failScopes(ctx, [key], "write").catch(() => undefined);
    }
  }
  await closeBatch(d.p, batchId, "collected", at, status.counts, wrote);
  return wrote;
}
