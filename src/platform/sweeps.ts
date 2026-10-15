// The cross-org retention sweeps (canopy-multitenancy.md §4.4). Each is a WRITE-ONLY statement bounded
// by age alone, run by the cron for every org at once — which is why they take the PlatformContext and
// name tenant tables without an `org_id`: there is no org to scope to, and nothing is read back. They
// are the only platform statements that touch tenant CONTENT tables, and each is declared by name in
// test/data-layer.static.test.ts. A sweep that must read, or that differs per org, does not belong here.
// (The other two sweeps live with their tables: `pruneOAuth` in src/auth/oauth.ts, `pruneUsage` in
// src/data/meter.ts.)
import { type PlatformContext, run, ph } from "../data/platform-sql";
import {
  DAY, DEPLOY_SIGNAL_RETENTION_DAYS, FAST_KINDS, FAST_METRICS, FAST_RETENTION_DAYS, HOSTING_DEPLOY_RETENTION_DAYS, MIDNIGHT_TAIL, PRODUCT_DAILY_RETENTION_DAYS,
  PRODUCT_GLOB_SQL, PRODUCT_HOURLY_RETENTION_DAYS, USAGE_GLOB_SQL, USAGE_RETENTION_DAYS,
} from "../repo/store";
import { SYNC_RUN_RETENTION_DAYS } from "@shared/sync";
import { COMMIT_PATHS_RETENTION_DAYS } from "../repo/commit-paths";

/** Every pending handoff, in any org, past its `expires_at` flips to expired. Returns how many flipped. */
export async function expireDueHandoffs(p: PlatformContext, nowMs: number): Promise<number> {
  const res = await run(p, `UPDATE handoffs SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`, new Date(nowMs).toISOString());
  return res.meta.changes ?? 0;
}

/** Sync GitHub run records (0046_sync_runs) older than `SYNC_RUN_RETENTION_DAYS`, in every org — the
 *  daily cron. A run still in progress is far younger than the bound. Returns how many were deleted. */
export async function pruneSyncRuns(p: PlatformContext, now: number): Promise<number> {
  const res = await run(p, `DELETE FROM sync_runs WHERE started_at < ?`, new Date(now - SYNC_RUN_RETENTION_DAYS * DAY).toISOString());
  return res.meta.changes ?? 0;
}

/** Repo capture past its retention bound (the bounds, and why each, are in src/repo/store.ts). */
export async function pruneRepoCapture(p: PlatformContext, now: number): Promise<void> {
  const cutoff = new Date(now - FAST_RETENTION_DAYS * DAY).toISOString();
  await run(p, `DELETE FROM repo_metrics WHERE metric IN (${ph(FAST_METRICS.length)}) AND at < ?`, ...FAST_METRICS, cutoff);
  // Hourly usage series get their own, longer bound — the hosting providers'
  // normalised `hx_*` points among them. Every other metric (coverage,
  // bundle_kb, todo_count) matches neither rule and is kept forever.
  const usageCutoff = new Date(now - USAGE_RETENTION_DAYS * DAY).toISOString();
  await run(p, `DELETE FROM repo_metrics WHERE (${USAGE_GLOB_SQL}) AND at < ?`, usageCutoff);
  // Sapling's product metrics: hourly rows 7 days, the 00:00 UTC rows 100 days.
  const productHourly = new Date(now - PRODUCT_HOURLY_RETENTION_DAYS * DAY).toISOString();
  const productDaily = new Date(now - PRODUCT_DAILY_RETENTION_DAYS * DAY).toISOString();
  await run(p,
    `DELETE FROM repo_metrics WHERE ${PRODUCT_GLOB_SQL} AND (at < ? OR (at < ? AND substr(at, 11) != ?))`,
    productDaily, productHourly, MIDNIGHT_TAIL);
  // `part IS NULL` only: a `check` row carrying a `part` (a Workers Builds run
  // tagged as a frontend deploy — see the migration's column notes) is a
  // DEPLOY record and must be kept forever like `deploy` rows, or the
  // frontend dot strip would age out asymmetrically from the backend's.
  await run(p, `DELETE FROM repo_events WHERE kind IN (${ph(FAST_KINDS.length)}) AND part IS NULL AND occurred_at < ?`, ...FAST_KINDS, cutoff);
  // GitHub deploy signals (repo setups, Phase A): deployments and non-`canopy/*` statuses, captured UNTAGGED
  // (`env IS NULL`) — 90 days, the detection window. A `deploy` row tagged with an environment (captured
  // before 0057) is a deploy record and is kept, as before.
  await run(p, `DELETE FROM repo_events WHERE kind = 'deploy' AND env IS NULL AND occurred_at < ?`,
    new Date(now - DEPLOY_SIGNAL_RETENTION_DAYS * DAY).toISOString());
  // The hosting providers' deploy rows, by the provider's own creation instant. `hosting_poll_state` is
  // one row per part — it never grows, so it has no rule.
  await run(p, `DELETE FROM hosting_deploys WHERE created_at < ?`, new Date(now - HOSTING_DEPLOY_RETENTION_DAYS * DAY).toISOString());
  // Which files a commit / a PR touched (0073_commit_paths, Repo setups Phase E): a commit's by its own instant, a
  // PR's with its read — both 100 days (`COMMIT_PATHS_RETENTION_DAYS`). A PR still open past that is read again by
  // reconcile (no read row = never read). Its files first, while the read row still names them.
  const pathsCutoff = new Date(now - COMMIT_PATHS_RETENTION_DAYS * DAY).toISOString();
  await run(p, `DELETE FROM commit_paths WHERE at < ?`, pathsCutoff);
  await run(p, `DELETE FROM pr_files WHERE (org_id, repo, number) IN (SELECT org_id, repo, number FROM pr_file_reads WHERE fetched_at < ?)`, pathsCutoff);
  await run(p, `DELETE FROM pr_file_reads WHERE fetched_at < ?`, pathsCutoff);
}
