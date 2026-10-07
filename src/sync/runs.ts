// Sync GitHub as a RUN (docs/architecture/sync.md; `sync_runs`, 0046_sync_runs).
//
// What a sync DOES is unchanged and lives where it always did: `runBackfill` (src/tools/backfill.ts)
// per batch, then the closing `runReconcileJob` (src/repo/cron.ts) on the batch that ends it. This
// module is the record around that work — who started it, where it stands, how it ended — and the
// two things the routes answer with:
//   • `runSyncBatch`  — `POST /admin/backfill`: start or continue a run, do one batch, report it;
//   • `syncStatus`    — `GET /sync`: the run in progress, the last one, and what a new one would do.
// The run row is also the LOCK: one run per org at a time (`startRun` is a single guarded INSERT).
//
// Not reachable from src/mcp.ts (it asks where the org's GitHub credential would come from —
// src/github-app/credential.ts `githubCredentialSource`, the SAME order `runBackfill` and the reconcile
// resolve it in; nothing is minted or revealed here).
import type { Env } from "../env";
import {
  SYNC_MAX_BATCHES, SYNC_PHASES, SYNC_STALE_MS, SYNC_SUMMARIES_PER_BATCH, SYNC_SUMMARIES_PER_RUN, zeroSyncCounts,
  type SyncBlock, type SyncBusy, type SyncCounts, type SyncCredential, type SyncFailure, type SyncPhase, type SyncRunStatus, type SyncRunView, type SyncStatusView,
  type SyncSummariesView,
} from "@shared/sync";
import { type TenantContext, all, first, run } from "../data/sql";
import { hasRole } from "../data/context";
import { appConfigured } from "../github-app/api";
import { githubCredentialSource } from "../github-app/credential";
import { accountMismatch } from "../github-app/status";
import { liveInstallation } from "../github-app/store";
import { jobTenant } from "../platform/jobs";
import { orgPrimaryRepo } from "../repo/config";
import { runReconcileJob } from "../repo/cron";
import type { ReconcileResult } from "../repo/github";
import { getSnapshot } from "../repo/store";
import { summaryAllowance, type SummaryAllowance } from "../plans/summaries";
import { isFinalBackfillBatch, runBackfill, type BackfillResult } from "../tools/backfill";
import { localUpstreamFetch } from "./local-upstream";

// ── the row ──────────────────────────────────────────────────────────────────

interface RunRow {
  id: number; repo: string; started_by: string; started_at: string; updated_at: string; ended_at: string | null;
  status: string; batch: number; batches: number | null; phase: string; done: number | null; total: number | null;
  counts: string; failures: string; previous_at: string | null;
}
const COLS = `id, repo, started_by, started_at, updated_at, ended_at, status, batch, batches, phase, done, total, counts, failures, previous_at`;

const parsed = <T>(json: string, fallback: T): T => { try { return JSON.parse(json) as T; } catch { return fallback; } };

/** A row as the wire shape. A `running` row that has not reported within `SYNC_STALE_MS` did not
 *  finish: it reads as `abandoned`, ended when it last reported — whether or not the row says so yet. */
export function runView(r: RunRow, now: number): SyncRunView {
  const stale = r.status === "running" && Date.parse(r.updated_at) <= now - SYNC_STALE_MS;
  const counts = { ...zeroSyncCounts(), ...parsed<Partial<SyncCounts>>(r.counts, {}) };
  const failures = parsed<SyncFailure[]>(r.failures, []);
  return {
    id: r.id, repo: r.repo, by: r.started_by, started_at: r.started_at, updated_at: r.updated_at,
    ended_at: stale ? r.updated_at : r.ended_at, status: stale ? "abandoned" : (r.status as SyncRunStatus),
    batch: r.batch, batches: r.batches, phase: (SYNC_PHASES as readonly string[]).includes(r.phase) ? (r.phase as SyncPhase) : "starting",
    done: r.done, total: r.total, counts, failures: Array.isArray(failures) ? failures : [], previous_at: r.previous_at,
  };
}

const getRun = (ctx: TenantContext, id: number): Promise<RunRow | null> =>
  first<RunRow>(ctx, `SELECT ${COLS} FROM sync_runs WHERE org_id = ? AND id = ?`, ctx.orgId, id);

/** The org's newest run that is still live (running, and heard from within `SYNC_STALE_MS`). */
const liveRun = (ctx: TenantContext, now: number): Promise<RunRow | null> =>
  first<RunRow>(ctx, `SELECT ${COLS} FROM sync_runs WHERE org_id = ? AND status = 'running' AND updated_at > ? ORDER BY id DESC LIMIT 1`,
    ctx.orgId, new Date(now - SYNC_STALE_MS).toISOString());

/**
 * Take the org's lock by starting a run: ONE statement, which inserts only when no live run exists —
 * of two starts racing, one writes. Returns the new row, or null when a live run stands. Whatever was
 * left `running` by a run that never finished is marked `abandoned` on the way.
 */
async function startRun(ctx: TenantContext, repo: string, by: string, now: number): Promise<RunRow | null> {
  const at = new Date(now).toISOString();
  const staleBefore = new Date(now - SYNC_STALE_MS).toISOString();
  const took = await run(ctx,
    `INSERT INTO sync_runs (org_id, repo, started_by, started_at, updated_at, batch, previous_at)
     SELECT ?1, ?2, ?3, ?4, ?4, 1, (SELECT MAX(ended_at) FROM sync_runs WHERE org_id = ?1 AND status IN ('ok', 'partial'))
      WHERE NOT EXISTS (SELECT 1 FROM sync_runs WHERE org_id = ?1 AND status = 'running' AND updated_at > ?5)`,
    ctx.orgId, repo, by, at, staleBefore);
  if (!took.meta.changes) return null;
  const id = Number(took.meta.last_row_id);
  await run(ctx, `UPDATE sync_runs SET status = 'abandoned', ended_at = updated_at WHERE org_id = ? AND status = 'running' AND id <> ? AND updated_at <= ?`,
    ctx.orgId, id, staleBefore).catch(() => undefined);
  return getRun(ctx, id);
}

/** Write where the run stands. Only a `running` row is ever updated: a run that was closed (or
 *  abandoned and replaced) is never revived by a late report. Never throws — reporting is not the sync. */
async function report(ctx: TenantContext, id: number, set: Partial<Pick<RunRow, "status" | "batch" | "batches" | "phase" | "done" | "total" | "counts" | "failures" | "ended_at">>, now: number = Date.now()): Promise<void> {
  const keys = Object.keys(set) as (keyof typeof set)[];
  const sql = `UPDATE sync_runs SET updated_at = ?${keys.map((k) => `, ${k} = ?`).join("")} WHERE org_id = ? AND id = ? AND status = 'running'`;
  await run(ctx, sql, new Date(now).toISOString(), ...keys.map((k) => set[k] ?? null), ctx.orgId, id).catch((e) => {
    console.error("sync run: report failed", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`);
  });
}

// ── what a new run would do (GET /sync) ──────────────────────────────────────

/** The org's primary repository, and where the credential to read it with would come from — the org's
 *  GitHub App installation, its stored token (SaplingLearn's legacy one), or nowhere. Asked as the
 *  org's system tenant, of the ONE source every GitHub read resolves from; nothing is minted or revealed. */
async function readiness(env: Env, ctx: TenantContext): Promise<{ repo: string | null; via: SyncCredential | null; wrongAccount: string | null }> {
  const job = jobTenant(env, ctx);
  const repo = (await orgPrimaryRepo(job))?.repo ?? null;
  const via = repo ? await githubCredentialSource(job, env, { repo }).catch(() => null) : null;
  // The App is connected, but on an account that does not own the repository: said by name, D1 only.
  const live = repo && via !== "app" ? await liveInstallation(job).catch(() => null) : null;
  const wrongAccount = live ? (await accountMismatch(job, live).catch(() => null))?.account_login ?? null : null;
  return { repo, via, wrongAccount };
}

/** Items stored with an excerpt, which a sync would try to summarize: every pull request marker row,
 *  and every issue row (an upper estimate — an issue that has since closed is no longer retried). */
async function pendingSummaries(ctx: TenantContext): Promise<number> {
  const r = await first<{ n: number }>(ctx,
    `SELECT (SELECT COUNT(*) FROM pr_summaries WHERE org_id = ?1 AND (model = 'excerpt' OR title IS NULL))
          + (SELECT COUNT(*) FROM issue_summaries WHERE org_id = ?1 AND (model = 'excerpt' OR title IS NULL)) AS n`, ctx.orgId);
  return r?.n ?? 0;
}

const summariesView = (a: SummaryAllowance, pending: number): SyncSummariesView =>
  ({ status: a.status, used: a.used, cap: a.cap, remaining: a.remaining, pending, per_run: SYNC_SUMMARIES_PER_RUN });

/**
 * `GET /sync` — any member: the run in progress, the latest one that is not, why a sync cannot start
 * (if it cannot), the org's summaries allowance, and when deployments and CI were last refreshed (the
 * `prs_reconciled` snapshot every reconcile writes — a sync's, Poll now's, or the scheduled one's).
 */
export async function syncStatus(env: Env, ctx: TenantContext, now: number = Date.now()): Promise<SyncStatusView> {
  const [ready, rows, allowance, pending, reconciled] = await Promise.all([
    readiness(env, ctx),
    all<RunRow>(ctx, `SELECT ${COLS} FROM sync_runs WHERE org_id = ? ORDER BY id DESC LIMIT 2`, ctx.orgId),
    summaryAllowance(env, ctx, new Date(now)).catch((): SummaryAllowance => ({ status: "off", used: 0, cap: null, remaining: null })),
    pendingSummaries(ctx).catch(() => 0),
    getSnapshot<{ at?: string }>(ctx, "prs_reconciled").catch(() => null),
  ]);
  const views = rows.map((r) => runView(r, now));
  const running = views[0]?.status === "running" ? views[0] : null;
  const last = views.find((v) => v.status !== "running") ?? null;
  const blocked: SyncBlock | null = !ready.repo ? "no_repo" : !ready.via ? "no_token" : running ? "running" : null;
  return {
    repo: ready.repo, admin: hasRole(ctx, "admin"), blocked, connect: appConfigured(env) ? "app" : "token", via: ready.via, wrong_account: ready.wrongAccount, running, last,
    summaries: summariesView(allowance, pending), refreshed_at: reconciled?.computedAt ?? null,
  };
}

// ── one batch (POST /admin/backfill) ─────────────────────────────────────────

export interface SyncBatchBody {
  /** The client's own 1-based batch number and its cap — `isFinalBackfillBatch`'s inputs, as before. */
  batch?: number;
  of?: number;
  /** The Sync panel's first batch: start a NEW run, and refuse (409) if one is in progress. */
  start?: boolean;
  /** A later batch of the run the first one answered with. */
  run?: number;
}

/** A batch's answer: the backfill's own result (and `repo`, on the batch that reconciled) exactly as
 *  before, plus the run it belongs to and the allowance as the batch left it. */
export type SyncBatchResult = BackfillResult & { repo?: ReconcileResult; run: SyncRunView; summaries: SyncSummariesView };

export type SyncBatchAnswer =
  | { status: 200; body: SyncBatchResult }
  | { status: 409; body: SyncBusy | { error: string } }
  | { status: 502 | 503; body: { error: string; run?: SyncRunView } };

export interface SyncBatchOpts {
  now?: () => number;
  /** Test seams — the route passes none of them. */
  backfill?: typeof runBackfill;
  backfillOpts?: Parameters<typeof runBackfill>[3];
  reconcile?: typeof runReconcileJob;
}

const add = (c: SyncCounts, res: BackfillResult): SyncCounts => ({
  ...c,
  prs_seen: res.prs, issues_seen: res.issues,
  prs_new: c.prs_new + res.capturedPrs, issues_changed: c.issues_changed + res.capturedIssues,
  tickets_created: c.tickets_created + res.ticketsCreated, tickets_updated: c.tickets_updated + res.ticketsUpdated,
  summaries_written: c.summaries_written + res.summariesWritten, summaries_failed: c.summaries_failed + res.summariesFailed,
  summaries_skipped: c.summaries_skipped + res.summariesSkipped, summaries_pending: res.summariesPending ?? 0,
});

/**
 * One batch of a sync, with its run record.
 *
 * WHICH RUN. `start: true` (the panel's first batch) starts a new run, or answers 409 `sync_running`
 * with the run in progress. `run: <id>` continues that run — it must be this org's, still live, and
 * started by the caller. A body naming neither (an older client, a hand-rolled request) continues the
 * caller's own live run if there is one and otherwise starts one; another person's live run is a 409.
 *
 * A failure of the batch closes the run as `failed` with a CODE, never upstream text (503, as before;
 * 502 for a throw, which used to be a bare 500).
 */
export async function runSyncBatch(env: Env, ctx: TenantContext, by: string, body: SyncBatchBody, opts: SyncBatchOpts = {}): Promise<SyncBatchAnswer> {
  const clock = opts.now ?? Date.now;
  const backfill = opts.backfill ?? runBackfill;
  // Undefined in production and in tests: only `wrangler dev` with a loopback `LOCAL_UPSTREAM` gets one.
  const local = localUpstreamFetch(env);
  const upstream: Parameters<typeof runBackfill>[3] = local ? { fetchImpl: local, gemini: { fetchImpl: local } } : {};

  // Nothing to sync with: the same 503 body as ever, and no run is recorded for a click that could not start.
  const ready = await readiness(env, ctx);
  if (!ready.repo || !ready.via) return { status: 503, body: { error: "service token or repo not configured" } };

  const live = await liveRun(ctx, clock());
  const mine = live && live.started_by.toLowerCase() === by.toLowerCase();
  let row: RunRow | null;
  if (typeof body.run === "number") {
    if (!live || live.id !== body.run || !mine) return { status: 409, body: live ? { error: "sync_running", run: runView(live, clock()) } : { error: "sync_not_running" } };
    row = live;
    await report(ctx, row.id, { batch: row.batch + 1, phase: "starting", done: null, total: null }, clock());
    row = { ...row, batch: row.batch + 1 };
  } else if (live && (body.start === true || !mine)) {
    return { status: 409, body: { error: "sync_running", run: runView(live, clock()) } };
  } else if (live) {
    row = live;
    await report(ctx, row.id, { batch: row.batch + 1, phase: "starting", done: null, total: null }, clock());
    row = { ...row, batch: row.batch + 1 };
  } else {
    row = await startRun(ctx, ready.repo, by, clock());
    if (!row) {
      const held = await liveRun(ctx, clock());
      return { status: 409, body: held ? { error: "sync_running", run: runView(held, clock()) } : { error: "sync_running" } };
    }
  }
  const id = row.id;
  let counts = { ...zeroSyncCounts(), ...parsed<Partial<SyncCounts>>(row.counts, {}) };
  const view = async (): Promise<SyncRunView> => runView((await getRun(ctx, id)) ?? row!, clock());

  let res: BackfillResult;
  try {
    res = await backfill(env, ctx, by, {
      ...upstream,
      ...opts.backfillOpts,
      onProgress: (p) => report(ctx, id, { phase: p.phase, done: p.done, total: p.total }, clock()),
    });
  } catch (e) {
    // The error's NAME only: nothing here knows which credential a message might quote.
    console.error("sync", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`);
    await report(ctx, id, { status: "failed", ended_at: new Date(clock()).toISOString(), failures: JSON.stringify([{ code: "unexpected" }]), phase: "done" }, clock());
    return { status: 502, body: { error: "sync failed", run: await view() } };
  }
  if (!res.ok) {
    await report(ctx, id, { status: "failed", ended_at: new Date(clock()).toISOString(), failures: JSON.stringify([res.failure ?? { code: "unexpected" }]), phase: "done" }, clock());
    return { status: 503, body: { error: res.error ?? "sync failed", run: await view() } };
  }
  counts = add(counts, res);

  // The closing refresh rides the batch that ENDS the run (`isFinalBackfillBatch`), and a run never
  // makes more than `SYNC_MAX_BATCHES` whatever the client says.
  const final = isFinalBackfillBatch(res, body.batch, body.of) || row.batch >= SYNC_MAX_BATCHES;
  let repo: ReconcileResult | undefined;
  if (final) {
    await report(ctx, id, { phase: "reconcile", done: null, total: null, counts: JSON.stringify(counts) }, clock());
    repo = (await (opts.reconcile ?? runReconcileJob)(env, ctx, clock(), { fetchImpl: local }).catch(() => null)) ?? undefined;
    // `failed` is the reconcile's ARM NAMES (or "unexpected error") — never upstream text.
    // `via` is where the credential stood when the batch began: it points the fix at the right tab.
    const failures: SyncFailure[] = (repo?.failed ?? []).map((arm) => (arm === "unexpected error" ? { code: "reconcile:unexpected" } : { code: `reconcile:${arm}`, via: ready.via ?? undefined }));
    counts = { ...counts, repo_written: repo ? repo.written : null };
    await report(ctx, id, {
      status: failures.length ? "partial" : "ok", ended_at: new Date(clock()).toISOString(), phase: "done", done: null, total: null,
      counts: JSON.stringify(counts), failures: JSON.stringify(failures), batches: row.batch,
    }, clock());
  } else {
    // How many batches the run will take, now that the backlog has been counted: one per
    // `SYNC_SUMMARIES_PER_BATCH` items still waiting, never past the bound.
    const batches = Math.min(SYNC_MAX_BATCHES, row.batch + Math.max(1, Math.ceil((res.summariesPending ?? 0) / SYNC_SUMMARIES_PER_BATCH)));
    await report(ctx, id, { counts: JSON.stringify(counts), batches }, clock());
  }

  const allowance = res.allowance ?? { status: "off" as const, used: 0, cap: null, remaining: null };
  return { status: 200, body: { ...res, ...(repo ? { repo } : {}), run: await view(), summaries: summariesView(allowance, res.summariesPending ?? 0) } };
}
