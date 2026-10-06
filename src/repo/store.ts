import { type TenantContext, type Stmt, all, first, run, stmt, batch, nowIso, ph, chunked } from "../data/sql";
import { type PlatformContext, run as runPlatform } from "../data/platform-sql";
import { PRODUCT_PREFIX } from "./product";
import type { RepoMetric } from "./types";

const DAY = 86_400_000;
/** High-frequency series and rows that lose their value quickly. Deliberately
 *  does NOT cover `pr` / `push` — those stay forever (the dashboard's
 *  week-over-week deltas and 14-day bars read them). Called every 6-hourly
 *  tick of the repo cron (src/repo/cron.ts). */
const FAST_METRICS = ["health_up", "health_ms"];
const FAST_KINDS = ["check"];
const FAST_RETENTION_DAYS = 45;
/** Hourly usage series — Cloudflare analytics (`cf_*`), and the Railway
 *  (`rw_*`) and active-user (`active_users_*`) gauges later tasks add. The Usage
 *  tab reads 30 days at most, so 100 days is ample; unbounded, two environments
 *  add ~35,000 rows a year. GLOB, not LIKE: in LIKE `_` is itself a wildcard
 *  (`cf_%` would also match `cfx…`), and GLOB is case-sensitive like the names. */
const USAGE_METRIC_GLOBS = ["cf_*", "rw_*", "active_users_*"];
const USAGE_RETENTION_DAYS = 100;
/** Sapling's product metrics (`sap_c_*` / `sap_t_*`, src/repo/poll.ts) are the
 *  widest hourly series by far — up to 168 metrics per environment — and the
 *  projection reads them two ways only: the last 3 hours (the figure) and the
 *  00:00 UTC reading of each of the last 30 days (the trend). So an HOURLY row
 *  is kept 7 days, and only the rows stamped exactly at 00:00 UTC — the daily
 *  totals — get the 100 days. `sap_*` matches none of `USAGE_METRIC_GLOBS` and
 *  none of them matches it (in GLOB `_` is a literal), so the two rules never
 *  touch each other's rows. `at` is always `toISOString()`-shaped (see
 *  `normaliseAt`), so "exactly midnight" is a fixed 14-character tail. */
const PRODUCT_METRIC_GLOB = `${PRODUCT_PREFIX}*`;
/** A GLOB pattern as a SQL LITERAL. SQLite rewrites `metric GLOB 'sap_*'` into
 *  an index range on `idx_repo_metrics_series`, but only when it can see the
 *  pattern: a bound `GLOB ?` is a scan of the whole table. Inlining is safe
 *  ONLY because every caller passes a module constant — and this refuses, at
 *  module load, anything but `[a-z_]` plus one trailing `*`, so a pattern that
 *  could close the quote can never be written here by mistake. */
const globLiteral = (pattern: string): string => {
  if (!/^[a-z_]+\*$/.test(pattern)) throw new Error(`not a constant prefix glob: ${pattern}`);
  return `'${pattern}'`;
};
const USAGE_GLOB_SQL = USAGE_METRIC_GLOBS.map((g) => `metric GLOB ${globLiteral(g)}`).join(" OR ");
const PRODUCT_GLOB_SQL = `metric GLOB ${globLiteral(PRODUCT_METRIC_GLOB)}`;
const PRODUCT_HOURLY_RETENTION_DAYS = 7;
const PRODUCT_DAILY_RETENTION_DAYS = 100;
export const MIDNIGHT_TAIL = "T00:00:00.000Z";
/** A bound on `productReadings`' midnight list — it is one bound parameter each. */
const MAX_MIDNIGHTS = 62;
/** One D1 batch holds at most this many statements — see `putMetrics`. */
const BATCH_STATEMENTS = 50;

export async function putSnapshot(ctx: TenantContext, kind: string, data: unknown, now: string = nowIso()): Promise<void> {
  await run(ctx,
    `INSERT INTO repo_snapshots (org_id, kind, json, computed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(org_id, kind) DO UPDATE SET json = excluded.json, computed_at = excluded.computed_at`,
    ctx.orgId, kind, JSON.stringify(data), now);
}

export async function getSnapshot<T>(ctx: TenantContext, kind: string): Promise<{ data: T; computedAt: string } | null> {
  const row = await first<{ json: string; computed_at: string }>(ctx, `SELECT json, computed_at FROM repo_snapshots WHERE org_id = ? AND kind = ?`, ctx.orgId, kind);
  if (!row) return null;
  try { return { data: JSON.parse(row.json) as T, computedAt: row.computed_at }; } catch { return null; }
}

/** THE format of `repo_metrics.at`, enforced at the one write seam. Every read
 *  of that table compares `at` as a RAW STRING (`ORDER BY at`, `at >= ?`) and
 *  its UNIQUE key includes it, so two writers spelling the same instant
 *  differently ("…T10:00:00Z" vs "…T10:00:00.000Z" vs "…T12:00:00+02:00")
 *  would order wrongly AND duplicate. Normalising here — rather than trusting
 *  each caller's comment — binds every future writer (Phase 4's commit-status
 *  metrics, Phase 5's pollers) to the same shape. An unparseable `at` is
 *  SKIPPED: a row no read can order is worse than a missing data point. */
function normaliseAt(at: string): string | null {
  const t = Date.parse(at);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** First write wins: a redelivered status or a double-fired cron is a no-op.
 *  Returns whether a NEW row was written — false for an unparseable `at` or an
 *  already-recorded (metric, env, part, at). The webhook's `status` capture
 *  (Task 14) uses this to count only newly-captured metrics into
 *  `repo.captured`, a redelivery into `repo.unchanged` — the same shape
 *  `ingestRepoEvent` reports for every other repo-capture kind. */
export async function putMetric(ctx: TenantContext, m: RepoMetric): Promise<boolean> {
  const at = normaliseAt(m.at);
  if (at === null) {
    console.error("putMetric: unparseable at", m.metric, m.at);
    return false;
  }
  const res = await run(ctx, PUT_METRIC_SQL, ctx.orgId, m.metric, m.env, m.part, m.value, at);
  return res.meta.changes > 0;
}

const PUT_METRIC_SQL = `INSERT OR IGNORE INTO repo_metrics (org_id, metric, env, part, value, at) VALUES (?, ?, ?, ?, ?, ?)`;

/** `putMetric` for MANY rows: the same first-write-wins `INSERT OR IGNORE`, the
 *  same `at` normalisation (an unparseable `at` skips THAT row and is logged),
 *  but sent as `db.batch` calls of at most `BATCH_STATEMENTS` statements — one
 *  round-trip per 50 rows instead of one per row. Sapling's product metrics
 *  are up to 171 rows per environment per poll; written one by one that is 171
 *  sequential D1 calls inside one cron invocation. Each statement keeps its
 *  own `meta.changes`, so the return is still the count of NEW rows (0 for a
 *  re-poll of an hour already stored). A D1 batch is a transaction: one chunk
 *  lands whole or not at all, and a throw propagates to the caller. Each chunk
 *  is its OWN transaction, though: a throw between chunks leaves the earlier
 *  chunks committed, and the count the caller sees is then 0 (it never gets a
 *  return value) — the next poll is idempotent, and an in-hour re-poll fills
 *  the gap exactly (`INSERT OR IGNORE`). */
export async function putMetrics(ctx: TenantContext, rows: RepoMetric[]): Promise<number> {
  const statements: Stmt[] = [];
  for (const m of rows) {
    const at = normaliseAt(m.at);
    if (at === null) {
      console.error("putMetrics: unparseable at", m.metric, m.at);
      continue;
    }
    statements.push(stmt(ctx, PUT_METRIC_SQL, ctx.orgId, m.metric, m.env, m.part, m.value, at));
  }
  let written = 0;
  for (const chunk of chunked(statements, BATCH_STATEMENTS)) {
    for (const res of await batch(ctx, chunk)) if (res.meta.changes > 0) written++;
  }
  return written;
}

/** `sinceIso` is normalised the SAME way `at` is stored before comparing — its
 *  first production caller (src/tools/repo.ts's coverage/bundle/TODO reads)
 *  computes a bound (`new Date(now - N*DAY).toISOString()`) that may lack the
 *  milliseconds every stored `at` carries; compared as raw strings, "…00Z"
 *  sorts AFTER "…00.000Z" and would wrongly exclude that exact instant. An
 *  unparseable bound returns [] rather than every row ever written. */
export async function metricSeries(ctx: TenantContext, metric: string, env: string, part: string, sinceIso: string): Promise<{ at: string; value: number }[]> {
  const since = normaliseAt(sinceIso);
  if (since === null) return [];
  return all<{ at: string; value: number }>(ctx,
    `SELECT at, value FROM repo_metrics WHERE org_id = ? AND metric = ? AND env = ? AND part = ? AND at >= ? ORDER BY at ASC`,
    ctx.orgId, metric, env, part, since);
}

/** One bound for a set of metric names — see `metricsSince`. */
export interface MetricGroup { metrics: string[]; since: string }

/** Several series in ONE statement — every (env, part) of every named metric,
 *  ascending by `at`. The Usage tab's read: the caller asks ONCE and slices the
 *  ranges in memory, instead of a `metricSeries` per range × environment ×
 *  metric. Each GROUP carries its own bound (`WHERE (metric IN (…) AND at >= ?)
 *  OR (…)`), so a gauge that is only ever read for its last 3 hours does not
 *  drag 30 days of rows through the render beside a series that needs them.
 *  Each bound is normalised exactly as `metricSeries` normalises its own (see
 *  above); a group with an unparseable bound, or no metric names, is DROPPED —
 *  never widened — and with no usable group the answer is []. */
export async function metricsSince(ctx: TenantContext, groups: MetricGroup[]): Promise<{ metric: string; env: string; part: string; at: string; value: number }[]> {
  const clauses: string[] = [];
  const binds: string[] = [];
  for (const g of groups) {
    const since = normaliseAt(g.since);
    if (since === null || !g.metrics.length) continue;
    clauses.push(`(metric IN (${ph(g.metrics.length)}) AND at >= ?)`);
    binds.push(...g.metrics, since);
  }
  if (!clauses.length) return [];
  return all<{ metric: string; env: string; part: string; at: string; value: number }>(ctx,
    `SELECT metric, env, part, at, value FROM repo_metrics WHERE org_id = ? AND (${clauses.join(" OR ")}) ORDER BY at ASC, id ASC`,
    ctx.orgId, ...binds);
}

/** Which of `metrics` have EVER landed — any env, any part, any age. ONE
 *  statement, an index seek per name (`idx_repo_metrics_series` leads with
 *  `metric`), never a scan of the series. It is what separates a section that
 *  is `empty` (the source reported before and has gone quiet) from one that is
 *  `not_connected` — the many-metric sibling of the `latestMetric` existence
 *  check the coverage/bundle/TODO sections make.
 *
 *  `prefixes` asks the same question of a FAMILY whose names are not known in
 *  advance (Sapling's product metrics, `sap_`): "has any metric starting with
 *  this ever landed?" — answered in the SAME statement by one more index seek
 *  (a range on `metric`, `LIMIT`ed by `EXISTS`), and reported as `<prefix>*`. */
export async function metricsEver(ctx: TenantContext, metrics: string[], prefixes: string[] = []): Promise<Set<string>> {
  const families = prefixes.filter((p) => p.length > 0);
  const ctes: string[] = [];
  const arms: string[] = [];
  if (metrics.length) {
    ctes.push(`asked(metric) AS (VALUES ${metrics.map(() => "(?)").join(", ")})`);
    arms.push(`SELECT metric FROM asked WHERE EXISTS (SELECT 1 FROM repo_metrics r WHERE r.org_id = ? AND r.metric = asked.metric)`);
  }
  if (families.length) {
    ctes.push(`family(name, lo, hi) AS (VALUES ${families.map(() => "(?, ?, ?)").join(", ")})`);
    arms.push(`SELECT name AS metric FROM family WHERE EXISTS (SELECT 1 FROM repo_metrics r WHERE r.org_id = ? AND r.metric >= family.lo AND r.metric < family.hi)`);
  }
  if (!arms.length) return new Set();
  const rows = await all<{ metric: string }>(ctx, `WITH ${ctes.join(", ")} ${arms.join(" UNION ALL ")}`,
    ...metrics, ...families.flatMap((p) => [`${p}*`, p, prefixEnd(p)]), ...arms.map(() => ctx.orgId));
  return new Set(rows.map((r) => r.metric));
}

/** The smallest string greater than every string starting with `prefix`: its
 *  last character, plus one. (`sap_` → "sap`".) */
const prefixEnd = (prefix: string): string =>
  prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

/**
 * Sapling's product metrics for the render — ONE statement, however many keys
 * Sapling reports (their names are dynamic, so `metricsSince`, which takes
 * explicit names, cannot ask). Two disjoint slices of `sap_*`, `part = ''`, for
 * the configured environments:
 *  1. every reading at or after `freshSinceIso` — the figures;
 *  2. the readings stamped EXACTLY at a 00:00 UTC inside
 *     `[trendSinceIso, freshSinceIso)` of the metrics a trend is drawn from
 *     (`sap_c_<key>_24h` and `sap_t_<key>`) — the daily totals.
 *
 * Shaped as a LOOSE INDEX SCAN, because the obvious form (`metric GLOB 'sap_*'
 * AND (at >= ? OR …)`) does use `idx_repo_metrics_series` but only for the
 * `metric` range: it walks EVERY stored `sap_` entry — ~33k at steady state for
 * two environments (81 metrics each: 7 days of hourly rows plus ~93 older
 * midnights) — to return ~3k. Here the recursive `names` CTE hops from one
 * distinct metric name to the next (one index seek each), and each (name, env)
 * then seeks its own `at` range — and, for the trend, each midnight by
 * equality — so the rows READ track the rows returned, not the rows stored.
 * Measured at that volume (sqlite 3.53, this schema): ~2.7 ms against ~5.6 ms
 * for the plain form, a gap that widens with retention. What the shape saves is
 * reads, NOT the sort: `UNION ALL … ORDER BY` costs a temp b-tree in both arms
 * either way.
 *
 * Bound parameters: one per environment, one per midnight (≤ 31 for a 30-day
 * trend) and one bound — far under D1's 100. No environment → no read. Both
 * bounds are normalised as `metricsSince` normalises its own; an unparseable
 * one returns []. Ascending by `at`.
 */
export async function productReadings(
  ctx: TenantContext, envKeys: string[], freshSinceIso: string, trendSinceIso: string
): Promise<{ metric: string; env: string; at: string; value: number }[]> {
  const fresh = normaliseAt(freshSinceIso);
  const trend = normaliseAt(trendSinceIso);
  // `r.org_id = ?` (multitenancy): the per-org UNIQUE (org_id, metric, env, part, at) is the index both arms
  // SEARCH by full equality — without the org term the planner falls back to an automatic index.
  if (fresh === null || trend === null || !envKeys.length) return [];
  const midnights: string[] = [];
  for (let t = Math.ceil(Date.parse(trend) / DAY) * DAY; t < Date.parse(fresh) && midnights.length < MAX_MIDNIGHTS; t += DAY) {
    midnights.push(new Date(t).toISOString());
  }
  const hi = prefixEnd(PRODUCT_PREFIX);
  const names = `names(m) AS (
       SELECT MIN(metric) FROM repo_metrics WHERE org_id = ? AND metric >= '${PRODUCT_PREFIX}' AND metric < '${hi}'
       UNION ALL
       SELECT (SELECT MIN(metric) FROM repo_metrics WHERE org_id = ? AND metric > names.m AND metric < '${hi}') FROM names WHERE names.m IS NOT NULL
     ),
     envs(e) AS (VALUES ${envKeys.map(() => "(?)").join(", ")})`;
  const freshArm = `SELECT r.metric, r.env, r.at, r.value FROM names CROSS JOIN envs CROSS JOIN repo_metrics r
       WHERE names.m IS NOT NULL AND r.org_id = ? AND r.metric = names.m AND r.env = envs.e AND r.part = '' AND r.at >= ?`;
  const trendArm = `SELECT r.metric, r.env, r.at, r.value FROM names CROSS JOIN envs CROSS JOIN mids CROSS JOIN repo_metrics r
       WHERE names.m IS NOT NULL AND (names.m GLOB '${PRODUCT_PREFIX}c_*_24h' OR names.m GLOB '${PRODUCT_PREFIX}t_*')
         AND r.org_id = ? AND r.metric = names.m AND r.env = envs.e AND r.part = '' AND r.at = mids.a`;
  return midnights.length
    ? all(ctx,
        `WITH RECURSIVE ${names}, mids(a) AS (VALUES ${midnights.map(() => "(?)").join(", ")})
         ${freshArm} UNION ALL ${trendArm} ORDER BY 3 ASC`,
        ctx.orgId, ctx.orgId, ...envKeys, ...midnights, ctx.orgId, fresh, ctx.orgId)
    : all(ctx, `WITH RECURSIVE ${names} ${freshArm} ORDER BY 3 ASC`, ctx.orgId, ctx.orgId, ...envKeys, ctx.orgId, fresh);
}

export async function latestMetric(ctx: TenantContext, metric: string, env: string, part: string): Promise<{ at: string; value: number } | null> {
  return first<{ at: string; value: number }>(ctx,
    `SELECT at, value FROM repo_metrics WHERE org_id = ? AND metric = ? AND env = ? AND part = ? ORDER BY at DESC LIMIT 1`, ctx.orgId, metric, env, part);
}

/** The latest `health_up` / `health_ms` reading of EVERY environment half, keyed
 *  `<metric>:<env>:<part>` — ONE statement however many environments are
 *  configured (the render path read two per half, 8 round-trips for two
 *  environments). The map also answers "has a reading EVER landed", which is
 *  what separates a health block that is `empty` (the pings stopped) from one
 *  that is `not_connected` (they were never set up). */
export async function latestHealth(ctx: TenantContext): Promise<Map<string, { at: string; value: number }>> {
  const rows = await all<{ metric: string; env: string; part: string; at: string; value: number }>(ctx,
    `SELECT metric, env, part, at, value FROM (
       SELECT metric, env, part, at, value,
              ROW_NUMBER() OVER (PARTITION BY metric, env, part ORDER BY at DESC) AS rn
         FROM repo_metrics WHERE org_id = ? AND metric IN ('health_up', 'health_ms')
     ) WHERE rn = 1`, ctx.orgId);
  return new Map(rows.map((r) => [`${r.metric}:${r.env}:${r.part}`, { at: r.at, value: r.value }]));
}

export async function pruneRepoCapture(p: PlatformContext, now: number): Promise<void> {
  const cutoff = new Date(now - FAST_RETENTION_DAYS * DAY).toISOString();
  await runPlatform(p, `DELETE FROM repo_metrics WHERE metric IN (${ph(FAST_METRICS.length)}) AND at < ?`, ...FAST_METRICS, cutoff);
  // Hourly usage series get their own, longer bound. Every other metric
  // (coverage, bundle_kb, todo_count) matches neither rule and is kept forever.
  const usageCutoff = new Date(now - USAGE_RETENTION_DAYS * DAY).toISOString();
  await runPlatform(p, `DELETE FROM repo_metrics WHERE (${USAGE_GLOB_SQL}) AND at < ?`, usageCutoff);
  // Sapling's product metrics: hourly rows 7 days, the 00:00 UTC rows 100 days.
  const productHourly = new Date(now - PRODUCT_HOURLY_RETENTION_DAYS * DAY).toISOString();
  const productDaily = new Date(now - PRODUCT_DAILY_RETENTION_DAYS * DAY).toISOString();
  await runPlatform(p,
    `DELETE FROM repo_metrics WHERE ${PRODUCT_GLOB_SQL} AND (at < ? OR (at < ? AND substr(at, 11) != ?))`,
    productDaily, productHourly, MIDNIGHT_TAIL);
  // `part IS NULL` only: a `check` row carrying a `part` (a Workers Builds run
  // tagged as a frontend deploy — see the migration's column notes) is a
  // DEPLOY record and must be kept forever like `deploy` rows, or the
  // frontend dot strip would age out asymmetrically from the backend's.
  await runPlatform(p, `DELETE FROM repo_events WHERE kind IN (${ph(FAST_KINDS.length)}) AND part IS NULL AND occurred_at < ?`, ...FAST_KINDS, cutoff);
}
