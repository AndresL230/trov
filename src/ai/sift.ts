// The Sift run (docs/architecture/ai.md › Where a model call may happen; feed-and-search.md › Tags): "which
// existing items fit this tag?", asked of TypeSafe AI's Jev one item at a time. The rules that bind it — the
// two bands, provenance, Undo, what is sent — are in src/tools/tag-fit.ts, which holds everything about Sift
// that is NOT a model call (the candidates, the switches' reads, Undo, the review counts). This file is the
// call site: it is in src/ai/ so nothing reachable from src/mcp.ts can import it (test/secrets.mcp.test.ts),
// and it names a KIND (`tag.fit`), never a provider — `providerFor` (./client.ts) hands it Jev.
//
// THE SWITCHES. A run starts, and each request is made, only while BOTH are on: the organization's AI switch
// (`orgs.ai_automation`, Org settings › AI — it gates every AI feature) and Sift's own (`org_ai_settings`,
// kind `tag.fit`, the Tags tab). Both are read before every request (`siftSwitches`, one statement), so
// turning either off stops a run in progress at its next request.
//
// Never on a render path: a run starts after a tag is added (or a suggested one accepted) and from "Find
// items" — in the background (`waitUntil`), never while a page loads.
import type { Env } from "../env";
import { normalizeTagName, type TagRunDTO } from "@shared/tags-core";
import { platform, type TenantContext } from "../data/context";
import { METRIC_AI_SUGGEST, meter } from "../data/meter";
import { batch, first, nowIso, run, stmt } from "../data/sql";
import {
  FIT_ANSWERS, FIT_APPLY, FIT_SUGGEST, JEV_ACTOR, TAG_FIT_KIND, fitAuditStmt, fitCandidates, scoreReason, siftSwitches, suggestAllowance,
} from "../tools/tag-fit";
import { providerFor, type AiProviderOpts, type Classifier } from "./client";

/** A run still "running" after this long died with its Worker: the next start takes over. */
const STALE_MS = 15 * 60 * 1000;

export type FitStart =
  | { status: "started"; run: number }
  | { status: "off" | "no_key" | "busy" | "capped" | "not_found" };

/**
 * Begin a run for `tag` — the checks a person waits on, and the run's row. Nothing is sent here; the
 * caller hands `continueTagFit` to the request's `waitUntil`. Refused (no row, no call) when the
 * platform has no key, the organization's AI switch or Sift's own is off, the tag is not live, the
 * month's allowance is spent, or a run for the tag is already going.
 */
export async function startTagFit(env: Pick<Env, "TYPESAFE_API_KEY">, ctx: TenantContext, rawTag: unknown): Promise<FitStart> {
  const tag = normalizeTagName(rawTag);
  if (!tag) return { status: "not_found" };
  if (!env.TYPESAFE_API_KEY) return { status: "no_key" };
  if (!(await siftSwitches(ctx)).on) return { status: "off" };
  const row = await first<{ retired_at: string | null }>(ctx, `SELECT retired_at FROM org_tags WHERE org_id = ? AND name = ?`, ctx.orgId, tag);
  if (!row || row.retired_at !== null) return { status: "not_found" };
  if ((await suggestAllowance(ctx)).spent) return { status: "capped" };
  const at = nowIso();
  // A run whose Worker died is let go, so it never blocks the tag for good.
  await run(ctx, `UPDATE org_tag_runs SET status = 'failed', ended_at = ? WHERE org_id = ? AND tag = ? AND status = 'running' AND started_at < ?`,
    at, ctx.orgId, tag, new Date(Date.now() - STALE_MS).toISOString());
  try {
    const res = await run(ctx, `INSERT INTO org_tag_runs (org_id, tag, status, started_by, started_at) VALUES (?, ?, 'running', ?, ?)`, ctx.orgId, tag, ctx.userId, at);
    return { status: "started", run: res.meta.last_row_id as number };
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e))) return { status: "busy" };
    throw e;
  }
}

export interface FitRunOpts {
  /** The classify call. Default: the `tag.fit` provider (Jev) with the platform key (`TYPESAFE_API_KEY`). */
  classifier?: Classifier;
  /** Test seams for the default provider: its fetch (stubbed at the Response level), timeout, retry delay, width. */
  jev?: Pick<AiProviderOpts, "fetchImpl" | "timeoutMs" | "retryDelayMs" | "concurrency">;
}

/**
 * The run itself, in the background: supersede the tag's open model suggestions, pre-select candidates,
 * then ask about each one — every request counted BEFORE it is made, and refused once the allowance is
 * spent or either switch is off — and store each confident "fits". Never throws; ends the run's row with
 * what happened (`capped` when the allowance stopped it, `failed` when the provider did).
 */
export async function continueTagFit(env: Env, ctx: TenantContext, runId: number, rawTag: string, opts: FitRunOpts = {}): Promise<TagRunDTO["status"]> {
  const tag = normalizeTagName(rawTag) ?? "";
  let calls = 0, added = 0, candidates = 0;
  let status: TagRunDTO["status"] = "done";
  try {
    const desc = (await first<{ description: string }>(ctx, `SELECT description FROM org_tags WHERE org_id = ? AND name = ?`, ctx.orgId, tag))?.description ?? "";
    await run(ctx, `UPDATE org_tag_suggestions SET state = 'superseded', resolved_at = ? WHERE org_id = ? AND tag = ? AND source = 'model' AND state = 'open'`, nowIso(), ctx.orgId, tag);
    const list = await fitCandidates(ctx, tag, desc);
    candidates = list.length;
    // The run, as it goes: what the Tags tab draws live (`GET …/tags/:name/run`).
    let checked = 0;
    const progress = (): Promise<unknown> =>
      run(ctx, `UPDATE org_tag_runs SET candidates = ?, calls = ?, checked = ?, added = ? WHERE org_id = ? AND id = ? AND status = 'running'`,
        candidates, calls, checked, added, ctx.orgId, runId).catch(() => undefined);
    await progress();
    const classifier = opts.classifier ?? providerFor(TAG_FIT_KIND, { ...opts.jev, apiKey: env.TYPESAFE_API_KEY });
    if (!classifier) status = "failed";
    else if (list.length) {
      let capped = false;
      const result = await classifier.classify({
        kind: TAG_FIT_KIND,
        question: `Is this item about the tag "${tag}"${desc ? ` (${desc})` : ""}? Say yes only when the item is clearly about it.`,
        criteria: {
          true: `The item is about ${tag}${desc ? `: ${desc}` : ""}.`,
          false: `The item is not about ${tag}, or only mentions it in passing.`,
        },
        answers: FIT_ANSWERS,
        items: list.map((c, k) => ({ id: String(k), text: `${c.title}${c.text ? `\n\n${c.text}` : ""}`, evidence: c.evidence })),
      }, {
        // Before EACH request: either switch can be turned off mid-run, and the month's allowance is
        // checked — then the request is counted, before it is made.
        gate: async () => {
          if (!(await siftSwitches(ctx)).on) return false;
          if ((await suggestAllowance(ctx)).spent) { capped = true; return false; }
          await meter(platform(env, ctx.userId), ctx.orgId, ctx.userId, METRIC_AI_SUGGEST);
          calls++;
          return true;
        },
        // Each answer as it comes: a confident "fits" ADDS the tag to the item at once — the entry_tags row
        // and its provenance in ONE batch — and the run's counts move on.
        onItem: async (it, j) => {
          checked++;
          const fits = !!j && j.answer === FIT_ANSWERS[0];
          if (j && fits && j.confidence >= FIT_SUGGEST && j.confidence < FIT_APPLY) {
            // Not sure enough to add on its own: suggested, for a person to add or dismiss.
            const c = list[Number(it.id)];
            await run(ctx,
              `INSERT OR IGNORE INTO org_tag_suggestions (org_id, entry_type, entry_id, tag, source, confidence, reason, model, prompt_version, suggested_by, suggested_at, state, run_id)
               VALUES (?, ?, ?, ?, 'model', ?, ?, ?, ?, 'system', ?, 'open', ?)`,
              ctx.orgId, c.type, c.id, tag, j.confidence, j.reason ?? scoreReason(j.confidence), j.model, classifier.promptVersion, nowIso(), runId);
          }
          if (j && fits && j.confidence >= FIT_APPLY) {
            const c = list[Number(it.id)];
            const at = nowIso();
            const [tagged] = await batch(ctx, [
              stmt(ctx, `INSERT OR IGNORE INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, ?, ?, ?)`, ctx.orgId, tag, c.type, c.id),
              stmt(ctx,
                `INSERT INTO org_tag_suggestions (org_id, entry_type, entry_id, tag, source, confidence, reason, model, prompt_version, suggested_by, suggested_at,
                                                  state, resolved_to, resolved_at, resolved_by, run_id)
                 SELECT ?, ?, ?, ?, 'model', ?, ?, ?, ?, 'system', ?, 'accepted', ?, ?, '${JEV_ACTOR}', ? WHERE changes() > 0`,
                ctx.orgId, c.type, c.id, tag, j.confidence, j.reason ?? scoreReason(j.confidence), j.model, classifier.promptVersion, at, tag, at, runId),
            ]);
            added += tagged.meta.changes ?? 0;
          }
          await progress();
        },
      });
      calls = result.calls;
      if (capped) status = "capped";
      else if (result.stopped === "provider") status = "failed";
    }
  } catch (e) {
    status = "failed";
    console.error("tag fit run failed", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`);
  }
  const end = nowIso();
  // The run's end, and ONE audit row for it (counts only), in one batch.
  await batch(ctx, [
    stmt(ctx, `UPDATE org_tag_runs SET status = ?, ended_at = ?, candidates = ?, calls = ?, added = MAX(added, ?) WHERE org_id = ? AND id = ?`,
      status, end, candidates, calls, added, ctx.orgId, runId),
    fitAuditStmt(ctx, "tag.fit", tag, { run: runId, status, candidates, calls, added }, end),
  ]).catch(() => undefined);
  return status;
}

/** Start and finish a run in one go (Find items without a `waitUntil`, and tests). */
export async function runTagFit(env: Env, ctx: TenantContext, tag: string, opts: FitRunOpts = {}): Promise<FitStart["status"] | TagRunDTO["status"]> {
  const s = await startTagFit(env, ctx, tag);
  return s.status === "started" ? continueTagFit(env, ctx, s.run, tag, opts) : s.status;
}
