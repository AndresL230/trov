import {
  REPO_RANGES,
  type RepoActivity, type RepoBars, type RepoBranches, type RepoCfRow, type RepoCodeStat, type RepoContributor,
  type RepoDashboard, type RepoDeploy, type RepoDeployRow, type RepoDrift, type RepoEnv, type RepoEnvPart,
  type RepoHealth, type RepoHosting, type RepoLabels, type RepoPerson, type RepoPr, type RepoProductCount, type RepoProductEnv,
  type RepoProductGroup, type RepoProductTotal, type RepoRange, type RepoSection, type RepoSprint,
  type RepoStat, type RepoTodos, type RepoTone, type RepoTrend, type RepoUsageEnv, type RepoUsageMetric,
} from "@shared/repo";
import type { PersonColor } from "@shared/rows";
import { OPEN_STATUS_SQL } from "@shared/tickets-core";
import { type DB, all, first, nowIso, ph } from "../db";
import { legacyTenant } from "../data/legacy";
import { ISSUE_GONE_ACTIONS } from "./issue-gone";
import { list_sprints } from "./sprints";
import {
  approvedPrs, branchHeads, checkState, ciDailyRates, ciFailureRows, commitsByDay, deployHistories,
  hasCaptured, latestChecks, prStatesAsOf, pushRowsSince, recentPrRows, recordingSince, reviewRowsSince,
} from "../repo/reads";
import type { RepoEnvConfig } from "../repo/config";
import { PRODUCT_GROUPS, PRODUCT_PREFIX, type ProductFormat, compareProductKeys, parseProductMetric, productKeyInfo } from "../repo/product";
import {
  MIDNIGHT_TAIL, type MetricGroup, getSnapshot, latestHealth, latestMetric, metricSeries, metricsEver, metricsSince, productReadings,
} from "../repo/store";
import { CF_POLLED, cfCovered, type RepoEventRow, type RepoPrRow } from "../repo/types";

// The Repo dashboard: a D1-ONLY read projection, in the same class as My Work —
// no live GitHub, no per-user token, nothing written. It reads what the webhook,
// the backfill and the repo cron (src/repo/cron.ts) already captured — deploys,
// checks, runs, branches, drift and environment health, from `repo_events` /
// `repo_snapshots` / `repo_metrics` — plus `events` (merged/closed PRs + issue
// snapshots), the ticket queue and the sprints. Coverage, bundle size and the
// TODO/FIXME count (Task 14) are ALSO `repo_metrics`, fed by the target repo's
// CI posting a commit status (`canopy/coverage` / `canopy/bundle-kb` /
// `canopy/todo`) that the webhook's `status` branch turns into a metric point
// (see `docs/superpowers/specs/2026-09-20-sapling-ci-metrics.md`) — never a
// live scan at render time. The Usage tab's requests / error rate and the
// Cloudflare panel (Task 16) are `repo_metrics` too: hourly `cf_requests` /
// `cf_errors` the repo cron's minute-0 tick polls from Cloudflare's analytics
// API (src/repo/poll.ts), read back here in ONE statement — beside the poll's
// `cf_polled` snapshot, the covered interval inside which a missing hour may be drawn as 0.
// The hosting block (Task 17) rides that SAME statement: hourly `rw_cpu` /
// `rw_mem_mb` the minute-0 tick polls from Railway, the latest point per
// environment picked out in memory and shown only while it is current.
//
// Active users (Task 18) ride it too: hourly `active_users_<range>` GAUGES the
// minute-0 tick asks Sapling's own backend for — Trov cannot compute them —
// shown, like hosting, only while the latest reading is current.
//
// Product metrics (contract v2) are the same poll's OTHER half: whatever
// `counts` / `totals` Sapling reports, stored generically as `sap_c_*` /
// `sap_t_*` gauges and read back in ONE more statement (`productReadings`) —
// their names are dynamic, so they cannot ride `metricsSince`'s named groups.
//
// Every SECTION now has a capture path, so the `UNCAPTURED` object that used to
// list the ones without is gone with its last entry (hosting). A section — or
// one metric inside the usage section, e.g. `users: null` while Sapling's
// endpoint is not built — whose capture has not landed yet is still
// `not_connected`, never guessed.

const DAY = 86_400_000;
const PR_LIMIT = 8;
const ACTIVITY_LIMIT = 20;
const CONTRIBUTOR_LIMIT = 8;
const LABEL_LIMIT = 6;
const CI_FAILURE_LIMIT = 5;
const BAR_DAYS = 14; // = the two-week PR window below
const RECENT_PR_DAYS = 90; // recentPrRows' bound — a PR untouched this long need not be "recent"
/** A health row older than this means the cron (src/repo/cron.ts, every 10
 *  minutes) has stopped — never trust a stale "up"/"down" as current: treat it
 *  as absent, both for display and for the environment pill. */
const HEALTH_STALE_MS = 30 * 60_000;

/** Event time: the payload's own clock, else when Trov recorded it. */
const AT = `COALESCE(occurred_at, recorded_at)`;

const ok = <T>(data: T): RepoSection<T> => ({ status: "ok", data });
const EMPTY = { status: "empty" } as const;
const NOT_CONNECTED = { status: "not_connected" } as const;

export function emptyRepoDashboard(repo: string, degraded: boolean): RepoDashboard {
  return {
    repo, generatedAt: nowIso(), degraded,
    usage: NOT_CONNECTED, cloudflare: NOT_CONNECTED, hosting: NOT_CONNECTED, product: NOT_CONNECTED,
    environments: NOT_CONNECTED, deploys: NOT_CONNECTED, ciFailures: NOT_CONNECTED, drift: NOT_CONNECTED,
    branches: NOT_CONNECTED, health: NOT_CONNECTED, coverage: NOT_CONNECTED, bundle: NOT_CONNECTED, todos: NOT_CONNECTED,
    stats: EMPTY, codeStats: EMPTY, bars: EMPTY, prs: EMPTY, activity: EMPTY,
    sprint: EMPTY, contributors: EMPTY, labels: EMPTY,
  };
}

/** A hosting figure is shown as CURRENT, so it must be: the Railway poll
 *  (src/repo/poll.ts) is hourly and stores complete hours only, so a healthy
 *  poller's newest point is 1–2 hours old. Past 3 hours the poll has stopped —
 *  the cell reads "—" rather than pass an old gauge off as now.
 *  The ONE staleness rule for an hourly gauge: active users (Task 18) reuse it
 *  — that poll stamps the current hour, so a healthy reading is under ~1h10m
 *  old and 3 hours forgives two missed ticks, no more. */
const HOSTING_STALE_MS = 3 * 3_600_000;

/** Each environment ships two deployables, on two different hosts. */
const HOSTS = { backend: "Railway", frontend: "Cloudflare" } as const;
const PARTS = ["backend", "frontend"] as const;
/** The word the dot strip labels each half with: "staging · api" / "· web". */
const PART_WORD = { backend: "api", frontend: "web" } as const;

const PR_STATES = ["draft", "review", "approved", "merged", "closed"] as const;
const isKnownPrState = (s: string | null): s is RepoPr["state"] => (PR_STATES as readonly string[]).includes(s ?? "");

const REVIEW_TEXT: Record<string, string> = {
  approved: "approved", changes_requested: "requested changes on",
  commented: "commented on", dismissed: "dismissed a review on",
};

// ── people ───────────────────────────────────────────────────────────────────
type PersonMap = Map<string, RepoPerson>;

/** Every mapped GitHub login → its person, in ONE query (logins are case-insensitive). */
async function personsByLogin(db: DB): Promise<PersonMap> {
  const rows = await all<{ subject: string; handle: string; name: string | null; color: PersonColor }>(
    db,
    `SELECT i.subject, p.handle, p.name, p.color FROM identities i
       JOIN persons p ON p.handle = i.person WHERE i.provider = 'github'`
  );
  const out: PersonMap = new Map();
  for (const r of rows) out.set(r.subject.toLowerCase(), { login: r.subject, handle: r.handle, name: r.name, color: r.color });
  return out;
}
const personOf = (people: PersonMap, login: string): RepoPerson =>
  people.get(login.toLowerCase()) ?? { login, handle: null, name: null, color: null };

// ── issues: the latest snapshot per issue, as of a moment ────────────────────
interface OpenIssue { number: number; labels: string[] }

/** The issues whose LATEST captured snapshot at `asOf` says `open` (and is not a
 *  deleted / transferred delivery, whose snapshot still says open). Reads the
 *  state/labels with json_extract so the (large) issue bodies never leave D1. */
async function openIssuesAsOf(db: DB, asOf: string): Promise<OpenIssue[]> {
  const rows = await all<{ ref_number: number; state: string | null; labels: string | null }>(
    db,
    `SELECT ref_number, state, labels FROM (
       SELECT ref_number,
              json_extract(raw, '$.issue.state')  AS state,
              json_extract(raw, '$.issue.labels') AS labels,
              json_extract(raw, '$.action')       AS action,
              ROW_NUMBER() OVER (PARTITION BY ref_number ORDER BY ${AT} DESC, id DESC) AS rn
         FROM events WHERE event_type = 'issue' AND ${AT} <= ?
     ) WHERE rn = 1 AND state = 'open' AND (action IS NULL OR action NOT IN (${ph(ISSUE_GONE_ACTIONS.length)}))`,
    asOf, ...ISSUE_GONE_ACTIONS
  );
  return rows.map((r) => ({ number: r.ref_number, labels: parseLabels(r.labels) }));
}

function parseLabels(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
const isBug = (i: OpenIssue): boolean => i.labels.some((l) => l.toLowerCase() === "bug");

// ── tickets ──────────────────────────────────────────────────────────────────
/** Open tickets now, and the NET change over the window: filed − resolved + re-opened.
 *  NATIVE tickets only: the tile sits beside the open-ISSUE tiles, and a ticket
 *  mirrored from an issue (0032) is already counted there. */
async function ticketCounts(db: DB, since: string): Promise<{ open: number; delta: number }> {
  const open = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM tickets WHERE status IN ${OPEN_STATUS_SQL} AND source = 'canopy'`);
  const filed = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM tickets WHERE created_at > ? AND source = 'canopy'`, since);
  const moves = await first<{ resolved: number | null; reopened: number | null }>(
    db,
    `SELECT SUM(CASE WHEN e.to_status IN ('done','declined') AND (e.from_status IS NULL OR e.from_status NOT IN ('done','declined')) THEN 1 ELSE 0 END) AS resolved,
            SUM(CASE WHEN e.from_status IN ('done','declined') AND e.to_status NOT IN ('done','declined') THEN 1 ELSE 0 END) AS reopened
       FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id AND t.source = 'canopy'
      WHERE e.created_at > ?`,
    since
  );
  return { open: open?.n ?? 0, delta: (filed?.n ?? 0) - (moves?.resolved ?? 0) + (moves?.reopened ?? 0) };
}

// ── PR + issue event reads ───────────────────────────────────────────────────
interface PrRow { event_type: string; ref_number: number; subject_login: string; at: string; title: string | null; url: string | null; base: string | null }
interface IssueRow { ref_number: number; subject_login: string; at: string; action: string | null; title: string | null; url: string | null; author: string | null }

const PR_COLS = `event_type, ref_number, subject_login, ${AT} AS at,
  json_extract(raw, '$.pr.title') AS title, json_extract(raw, '$.pr.html_url') AS url,
  json_extract(raw, '$.pr.base.ref') AS base`;

const prOf = (people: PersonMap, r: PrRow): RepoPr => ({
  number: r.ref_number,
  title: r.title ?? `PR #${r.ref_number}`,
  url: r.url ?? "",
  author: personOf(people, r.subject_login),
  branch: r.base ? `→ ${r.base}` : null,
  state: r.event_type === "pr_merged" ? "merged" : "closed",
  checks: null, // the `events` fallback carries no head sha to look checks up by
  at: r.at,
});

/** A lower delta is good for a backlog count; a rising bug count is a warning. */
const backlogTone = (delta: number, warnOnRise: boolean): RepoTone =>
  delta < 0 ? "good" : delta > 0 && warnOnRise ? "warn" : "neutral";

// ── coverage / bundle / TODO metrics (Task 14) ───────────────────────────────
const SEVEN_DAYS = 7 * DAY;

/** A delta claims a trend only once the window holds ≥2 points whose first and
 *  last are ≥7 days apart — a single reading (or two readings a day apart)
 *  cannot support "over 30 days". `points` is ascending by `at` (metricSeries'
 *  own order), so `[0]`/`[length-1]` ARE the window's first and last. */
function windowDelta(points: { at: string; value: number }[]): number | null {
  if (points.length < 2) return null;
  const first = Date.parse(points[0].at);
  const last = Date.parse(points[points.length - 1].at);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last - first < SEVEN_DAYS) return null;
  return points[points.length - 1].value - points[0].value;
}

const fixed = (n: number, d: number): string => (Math.round(n * 10 ** d) / 10 ** d).toString();
const signed = (n: number, d: number, unit = ""): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fixed(Math.abs(n), d)}${unit}`;

// ── usage + Cloudflare (Task 16) ─────────────────────────────────────────────
const HOUR = 3_600_000;
/** Every series the Usage tab reads, fetched in ONE statement (each bounded by
 *  its own window — `usageReadGroups` below names them again, per bound; this
 *  list is what the `metricsEver` existence check asks about): Cloudflare's
 *  hourly counts and the `active_users_<range>` gauges `pollSaplingMetrics`
 *  writes (src/repo/poll.ts) — one metric PER RANGE, because a 7-day distinct
 *  count is not derivable from 24-hour ones. */
const USAGE_METRICS = ["cf_requests", "cf_errors", "active_users_24h", "active_users_7d", "active_users_30d"];
/** The hosting block's two gauges — appended to the SAME one read, never a
 *  statement per environment. Kept apart from `USAGE_METRICS` because the two
 *  sources share a read but not a STATE: a Railway row says nothing about
 *  whether usage is connected, and the other way round. */
const HOSTING_METRICS = ["rw_cpu", "rw_mem_mb"];
/** A range is its last N COMPLETE hours, cut into equal buckets that END at the
 *  last complete hour — so every bucket of a range covers the same span, and
 *  the newest one is never a half-finished UTC day drawn as a drop. */
const USAGE_RANGES: Record<RepoRange, { hours: number; step: number }> = {
  "24h": { hours: 24, step: HOUR }, "7d": { hours: 168, step: DAY }, "30d": { hours: 720, step: DAY },
};

/** The ONE Usage read's groups — each series bounded by what the projection
 *  below actually consumes, not by the widest range: Cloudflare's counts need
 *  all 30 days (every range is sliced from them, and "capture predates the
 *  range" is read off their first point), each `active_users_<range>` gauge
 *  only its own trailing range, and the hosting gauges only the staleness
 *  window a figure may be shown in. Every row this leaves out is one the
 *  projection already filtered away — at steady state more than half of them. */
function usageReadGroups(usageEnd: number, now: number): MetricGroup[] {
  const since = (ms: number) => new Date(ms).toISOString();
  const rangeStart = (range: RepoRange) => since(usageEnd - USAGE_RANGES[range].hours * HOUR);
  return [
    { metrics: ["cf_requests", "cf_errors", "active_users_30d"], since: rangeStart("30d") },
    { metrics: ["active_users_7d"], since: rangeStart("7d") },
    { metrics: ["active_users_24h"], since: rangeStart("24h") },
    { metrics: HOSTING_METRICS, since: since(now - HOSTING_STALE_MS) },
  ];
}

/** 1_234 → "1.2K", 2_500_000 → "2.50M", 2_500_000_000 → "2.50B". (999_950 up
 *  rounds to "1000.0K", so it is already an M — and likewise at each tier above.) */
function compact(n: number): string {
  if (n >= 999_995_000_000) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 999_995_000) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 999_950) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

interface UsagePoint { t: number; value: number }

/** An hourly gauge's trend, THINNED for the wider ranges — 720 hourly readings
 *  in a 100-unit sparkline is sub-pixel detail and ~8 KB of `points` text per
 *  line. Thinned, never truncated: a "30d" line that showed only its newest
 *  5 days would be mislabelled. 30d keeps the LAST reading of each UTC day
 *  (≤ 31 points); 7d the last of each 6-hour block, the blocks ENDING with the
 *  current hour (≤ 28); 24h stays hourly. `pts` is ascending, so a later
 *  reading overwrites an earlier one under the same key while the Map keeps the
 *  keys in first-seen — chronological — order. A block with no reading has no
 *  key: still never zero-filled, never summed. */
function thinGauge(pts: UsagePoint[], range: RepoRange, now: number): number[] {
  if (range === "24h") return pts.map((p) => p.value);
  const endHour = Math.floor(now / HOUR) * HOUR;
  const key = range === "30d" ? (t: number) => Math.floor(t / DAY) : (t: number) => Math.floor((endHour - t) / (6 * HOUR));
  const last = new Map<number, number>();
  for (const p of pts) last.set(key(p.t), p.value);
  return [...last.values()];
}

/**
 * The Usage tab and the Cloudflare panel, derived IN MEMORY from one read of
 * the last 30 days (`rows`, ascending by `at`). `endExcl` is the start of the
 * current hour: only complete hours count, whatever the table holds. `polled`
 * is the `cf_polled` snapshot — per environment, the interval `[from, to)` its
 * polls are known to have looked at (src/repo/poll.ts; read via `cfCovered`).
 *
 * Never guess. Cloudflare returns NO row for an hour without invocations, so a
 * missing bucket is drawn as 0 — leaving it out would silently compress the
 * x-axis — but only where a zero is something we are entitled to say:
 *  - The fill STARTS at the first captured point in the range, or at the
 *    range's start when this read shows capture predates it. Before capture
 *    began the value is unknown, not zero.
 *  - …unless that would cross a HOLE: `polled` holds each environment's covered
 *    INTERVAL `{ from, to }`, and an hour before `from` with no real point is
 *    one no poll ever looked at (an outage longer than the poll's 3-hour
 *    window). The series then starts at `from` — the contiguous covered
 *    stretch only — while the totals still sum every real point in the range.
 *  - The first bucket drawn is the first WHOLE bucket (7d / 30d buckets are
 *    days): a bucket capture or coverage began inside is counted, not drawn.
 *  - The fill ENDS at `min(last complete hour, that environment's covered
 *    `to`)` — and, with NO marker, at the last real point. "No row" means zero
 *    only for an hour a poll looked at; past that the poll may simply be dead.
 *    (A real point is always drawn, whatever the marker says.)
 *  - `requests` is non-null when there is something known in the range: a real
 *    point, OR capture predating the range AND covered hours inside it — the
 *    second reads a true "0" with an all-zero trend. (Its `trend` can still be
 *    `[]` when the only known stretch is one partial bucket; the screen draws
 *    no sparkline under 2 points.)
 *  - `errorRate` needs a real point in the range. With points that sum to 0
 *    requests it is a true "0.00%"; with NO point, 0 of 0 is not a rate: `null`.
 *  - Totals are sums of real points only; the bound changes which zero buckets
 *    the sparkline may draw, never a number.
 *
 * ACTIVE USERS are a different kind of series — an hourly GAUGE Sapling
 * computes at request time ("distinct users in the trailing 24h, as of now"),
 * one metric per range — so none of the above applies to them:
 *  - `users.value` for range R is the LATEST `active_users_R` reading, NEVER a
 *    sum of readings, and only while it is CURRENT: at most `HOSTING_STALE_MS`
 *    older than `now` (and not stamped ahead of it), else `users: null` — an
 *    old gauge is not passed off as now. With `seen.users` false that renders
 *    "not connected" under Active users — the true, designed state while
 *    Cloudflare is connected and Sapling's endpoint is not built yet; once a
 *    reading HAS landed, a stale one renders "no recent reading" instead.
 *  - `users.trend` is the readings inside the trailing range, oldest first
 *    (thinned for 7d / 30d — see `thinGauge`), and is NEVER zero-filled: a
 *    missing hour is a poll that did not land — unknown, not zero users.
 */
function projectUsage(
  rows: { metric: string; env: string; part: string; at: string; value: number }[], envs: RepoEnvConfig[], endExcl: number,
  polled: Record<string, unknown>, now: number
): { usage: Record<RepoRange, RepoUsageEnv[]>; cloudflare: Record<RepoRange, RepoCfRow[]>; anyUsage: boolean } {
  const usage = {} as Record<RepoRange, RepoUsageEnv[]>;
  const cloudflare = {} as Record<RepoRange, RepoCfRow[]>;
  for (const range of REPO_RANGES) { usage[range] = []; cloudflare[range] = []; }
  let anyUsage = false;

  for (const cfg of envs) {
    const series = (metric: string, part: string): UsagePoint[] =>
      rows.filter((r) => r.metric === metric && r.env === cfg.key && r.part === part)
        .map((r) => ({ t: Date.parse(r.at), value: r.value })).filter((p) => Number.isFinite(p.t));
    const complete = (pts: UsagePoint[]) => pts.filter((p) => p.t < endExcl);
    const reqEvery = series("cf_requests", "frontend");
    const reqAll = complete(reqEvery);
    const errAll = complete(series("cf_errors", "frontend"));
    // Has this environment's source reported AT ALL inside this read? It is
    // what lets the screen tell "connected, nothing recent" from "not
    // connected" when a metric below comes out null. Both are derivable from
    // the one read because `cf_requests` and `active_users_30d` keep its widest
    // (30-day) bound — and a healthy Sapling poll always writes all three
    // `active_users_*` together, so any of them is evidence.
    // KNOWN LIMIT: `seen` looks back those 30 days only. A source silent for
    // longer reads "not connected" per metric again, while the section-level
    // `metricsEver` check (any age) still says `empty`.
    const seen = {
      requests: reqEvery.length > 0,
      users: rows.some((r) => r.env === cfg.key && r.part === "" && r.metric.startsWith("active_users_")),
    };
    // The covered interval, snapped INWARD to whole hours; its end is clamped to
    // the last complete hour. −∞ / −∞ = no marker at all.
    const covered = cfCovered(polled[cfg.key]);
    const coveredFrom = covered ? Math.ceil(covered.from / HOUR) * HOUR : -Infinity;
    const polledExcl = covered ? Math.min(endExcl, Math.floor(covered.to / HOUR) * HOUR) : -Infinity;

    for (const range of REPO_RANGES) {
      const { hours, step } = USAGE_RANGES[range];
      const start = endExcl - hours * HOUR;
      const inRange = (pts: UsagePoint[]) => pts.filter((p) => p.t >= start);
      const req = inRange(reqAll);
      const err = inRange(errAll);
      // The gauge's window trails `now`, not the last complete hour: its
      // newest reading is stamped with the CURRENT hour (`endExcl` itself).
      const usr = series(`active_users_${range}`, "").filter((p) => p.t <= now && p.t > now - hours * HOUR);

      // `reqAll` is ascending: its first point predating the range means
      // capture was already running when the range began.
      const predates = reqAll.length > 0 && reqAll[0].t < start;
      const fillFrom = predates ? start : req.length ? req[0].t : null;
      const fillToExcl = Math.max(polledExcl, req.length ? req[req.length - 1].t + HOUR : -Infinity);

      let requests: RepoUsageMetric | null = null;
      let errorRate: RepoUsageMetric | null = null;
      if (fillFrom !== null && fillToExcl > fillFrom) {
        // A HOLE: an hour between where the fill would begin and where the
        // covered interval begins that holds no real point — nothing ever looked
        // at it, so it may not be drawn as 0, and a dense array cannot draw
        // "unknown". The series then starts at the covered interval instead.
        // (Real points running right up to `coveredFrom` are no hole: a stored
        // point IS an hour a poll looked at.)
        const seenHours = new Set(req.map((p) => Math.floor(p.t / HOUR) * HOUR));
        let hole = false;
        for (let h = fillFrom; h < Math.min(coveredFrom, fillToExcl) && !hole; h += HOUR) hole = !seenHours.has(h);
        const drawFrom = hole ? coveredFrom : fillFrom;
        const idx = (t: number) => Math.floor((t - start) / step);
        // The first bucket drawn is the first WHOLE one: when capture (or the
        // covered interval) begins mid-bucket, that bucket holds only part of its
        // span and would read as a dip beside full ones. `ceil` is the mirror of
        // the rule at the other end ("never a half-finished day drawn as a
        // drop"); hourly buckets are always whole. Totals are untouched.
        const firstIdx = Math.ceil((drawFrom - start) / step);
        const bucket = (pts: UsagePoint[]): number[] => {
          const out = new Array<number>((hours * HOUR) / step).fill(0);
          for (const p of pts) out[idx(p.t)] += p.value;
          // The last bucket drawn is the one holding the last KNOWN hour.
          return out.slice(firstIdx, idx(fillToExcl - HOUR) + 1);
        };
        const reqBuckets = bucket(req);
        const errBuckets = bucket(err);
        const total = req.reduce((n, p) => n + p.value, 0);
        const errors = err.reduce((n, p) => n + p.value, 0);
        requests = { value: compact(total), trend: reqBuckets, tone: "neutral" };
        if (req.length) {
          const rate = total ? (errors / total) * 100 : 0;
          errorRate = {
            value: `${rate.toFixed(2)}%`, tone: rate >= 1 ? "warn" : "good",
            trend: errBuckets.map((e, i) => (reqBuckets[i] ? (e / reqBuckets[i]) * 100 : 0)),
          };
        }
        cloudflare[range].push(
          { env: cfg.label, label: "Workers requests", value: compact(total) },
          { env: cfg.label, label: "Workers errors", value: compact(errors) },
        );
      }
      const latestUsers = usr.length ? usr[usr.length - 1] : null; // `rows` is ascending by `at`
      const users: RepoUsageMetric | null = latestUsers && now - latestUsers.t <= HOSTING_STALE_MS
        ? { value: compact(latestUsers.value), trend: thinGauge(usr, range, now), tone: "neutral" }
        : null;
      if (requests || users) anyUsage = true;
      usage[range].push({ name: cfg.label, host: cfg.frontendUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""), requests, errorRate, users, seen });
    }
  }
  return { usage, cloudflare, anyUsage };
}

/**
 * The hosting block, derived IN MEMORY from the same read (`rows`, ascending by
 * `at`): per configured environment, the LATEST `rw_cpu` / `rw_mem_mb` of its
 * backend — each shown only when that point is at most `HOSTING_STALE_MS` old,
 * else "—". An environment with neither figure current is left out, so an
 * empty list means nothing current anywhere (the caller decides `empty` vs
 * `not_connected`).
 */
function projectHosting(
  rows: { metric: string; env: string; part: string; at: string; value: number }[], envs: RepoEnvConfig[], now: number
): RepoHosting[] {
  const out: RepoHosting[] = [];
  for (const cfg of envs) {
    const current = (metric: string): number | null => {
      let latest: { t: number; value: number } | null = null;
      for (const r of rows) {
        if (r.metric !== metric || r.env !== cfg.key || r.part !== "backend") continue;
        const t = Date.parse(r.at);
        // `t <= now`: a point stamped ahead of the clock is not a current reading.
        if (Number.isFinite(t) && t <= now && (!latest || t >= latest.t)) latest = { t, value: r.value };
      }
      return latest && now - latest.t <= HOSTING_STALE_MS ? latest.value : null;
    };
    const cpu = current("rw_cpu");
    const mem = current("rw_mem_mb");
    if (cpu === null && mem === null) continue;
    out.push({ env: cfg.label, cpu: cpu === null ? "—" : `${cpu.toFixed(2)} vCPU`, memory: mem === null ? "—" : `${Math.round(mem)} MB` });
  }
  return out;
}

// ── product metrics (Sapling contract v2) ────────────────────────────────────
/** The trend's reach: the 00:00 UTC readings of the last 30 days. */
const PRODUCT_TREND_DAYS = 30;

/** Integer cents as dollars — "$118.30"; from $10K up the cents are noise (and
 *  the screen's value cell is narrow): "$12.3K". */
const productValue = (v: number, format: ProductFormat): string =>
  format !== "cents" ? compact(v)
  : v >= 1_000_000 ? `$${compact(v / 100)}`
  : (v / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * The product section, derived IN MEMORY from `productReadings` (`rows`,
 * ascending by `at`): per configured environment — every one, in config order;
 * one that reported nothing has no groups — the `counts` keys grouped and
 * ordered by the registry (src/repo/product.ts; an unknown key → "Other",
 * labelled from the key) and the `totals` keys on their own.
 *
 * Never guess:
 *  - a figure is the LATEST reading of its own metric (`sap_c_<key>_<range>` /
 *    `sap_t_<key>`), shown only while CURRENT — at most `HOSTING_STALE_MS` (the
 *    one staleness rule of an hourly gauge) older than `now`, and not stamped
 *    ahead of it — else `null`, which the screen reads as "no recent reading".
 *    The key stays listed: it HAS been reported. A key with no row in the read
 *    (never reported, or silent past the 30-day trend) is simply absent.
 *  - the trend is the readings stamped exactly 00:00 UTC — the `24h` window for
 *    a count, i.e. the daily totals — oldest first, never zero-filled: a missed
 *    midnight is a poll that did not land, not a day on which nothing happened.
 *    One trend per key, the same whatever the range.
 * `anyProduct` = some figure is current somewhere (the caller's `ok`).
 */
function projectProduct(
  rows: { metric: string; env: string; at: string; value: number }[], envs: RepoEnvConfig[], now: number
): { product: RepoProductEnv[]; anyProduct: boolean } {
  interface Reading { t: number; value: number }
  interface Series { latest: Partial<Record<RepoRange | "total", Reading>>; trend: number[] }
  const trendFrom = now - PRODUCT_TREND_DAYS * DAY;
  let anyProduct = false;
  const current = (r: Reading | undefined): number | null => (r && now - r.t <= HOSTING_STALE_MS ? r.value : null);

  const product = envs.map((cfg): RepoProductEnv => {
    const counts = new Map<string, Series>();
    const totals = new Map<string, Series>();
    for (const r of rows) {
      if (r.env !== cfg.key) continue;
      const name = parseProductMetric(r.metric);
      const t = Date.parse(r.at);
      // `t <= now`: a point stamped ahead of the clock is not a reading of now.
      if (!name || !Number.isFinite(t) || t > now) continue;
      const bucket = name.kind === "count" ? counts : totals;
      let series = bucket.get(name.key);
      if (!series) bucket.set(name.key, (series = { latest: {}, trend: [] }));
      series.latest[name.kind === "count" ? name.range : "total"] = { t, value: r.value }; // ascending: the last one wins
      if ((name.kind === "total" || name.range === "24h") && t >= trendFrom && r.at.endsWith(MIDNIGHT_TAIL)) series.trend.push(r.value);
    }

    const byGroup = new Map<string, RepoProductCount[]>();
    for (const key of [...counts.keys()].sort(compareProductKeys)) {
      const series = counts.get(key)!;
      const info = productKeyInfo(key);
      const values = {} as Record<RepoRange, string | null>;
      const raw = {} as Record<RepoRange, number | null>;
      for (const range of REPO_RANGES) {
        raw[range] = current(series.latest[range]);
        values[range] = raw[range] === null ? null : productValue(raw[range], info.format);
        if (raw[range] !== null) anyProduct = true;
      }
      const list = byGroup.get(info.group) ?? [];
      list.push({ key, label: info.label, values, raw, trend: series.trend, ...(info.note ? { note: info.note } : {}) });
      byGroup.set(info.group, list);
    }
    const groups: RepoProductGroup[] = PRODUCT_GROUPS.flatMap(([id, title]) => {
      const metrics = byGroup.get(id);
      return metrics ? [{ id, title, metrics }] : [];
    });
    const totalRows: RepoProductTotal[] = [...totals.keys()].sort(compareProductKeys).map((key) => {
      const series = totals.get(key)!;
      const info = productKeyInfo(key);
      const raw = current(series.latest.total);
      if (raw !== null) anyProduct = true;
      return { key, label: info.label, value: raw === null ? null : productValue(raw, info.format), raw, trend: series.trend, ...(info.note ? { note: info.note } : {}) };
    });
    return { name: cfg.label, groups, totals: totalRows };
  });
  return { product, anyProduct };
}

/** `YYYY-MM-DD` (UTC) for each of the last `n` days, oldest first. */
function lastDays(now: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => new Date(now - (n - 1 - i) * DAY).toISOString().slice(0, 10));
}

function activityOf(people: PersonMap, r: IssueRow): RepoActivity | null {
  const ref = `#${r.ref_number} “${r.title ?? ""}”`;
  const base = { url: r.url, at: r.at };
  switch (r.action) {
    // `opened` is the one issue action whose actor the snapshot names (the author).
    case "opened": return { kind: "issue", actor: personOf(people, r.author ?? r.subject_login), text: `opened ${ref}`, ...base };
    case "closed": return { kind: "close", actor: null, text: `${ref} was closed`, ...base };
    case "reopened": return { kind: "issue", actor: null, text: `${ref} was reopened`, ...base };
    // An assigned event is ABOUT the assignee (its subject_login), not by them.
    case "assigned": return { kind: "review", actor: null, text: `${ref} was assigned to @${personOf(people, r.subject_login).handle ?? r.subject_login}`, ...base };
    default: return null; // edited / unassigned / (de)milestoned — noise in a feed
  }
}

export async function getRepoDashboard(
  db: DB,
  repo: string,
  now: number = Date.now(),
  /** The environments this deployment reports on (`REPO_ENVIRONMENTS`). None
   *  configured → the environment/deploy sections stay `not_connected`. */
  envs: RepoEnvConfig[] = []
): Promise<RepoDashboard> {
  const nowAt = new Date(now).toISOString();
  const weekAgo = new Date(now - 7 * DAY).toISOString();
  const twoWeeksAgo = new Date(now - 14 * DAY).toISOString();
  const ninetyDaysAgo = new Date(now - RECENT_PR_DAYS * DAY).toISOString();

  // Never on the render path: GitHub's GraphQL refs query is called off
  // reconcileRepo only — this only reads back the snapshot it wrote. No
  // snapshot yet → not_connected; a stale one is still shown, same as `drift`
  // below — and NOTHING on screen says how old it is (`computedAt` is stored
  // but never travels in the DTO).
  const branchSnap = await getSnapshot<RepoBranches>(db, "branches");

  const people = await personsByLogin(db);

  // Two weeks of PR closes cover the week-over-week delta AND the 14-day bars.
  const recentPrs = await all<PrRow>(
    db, `SELECT ${PR_COLS} FROM events WHERE event_type IN ('pr_merged','pr_closed') AND ${AT} > ? ORDER BY ${AT} DESC, id DESC`,
    twoWeeksAgo
  );
  // The list and the feed are NOT window-scoped: a quiet fortnight still shows the last PRs.
  const latestPrs = await all<PrRow>(
    db, `SELECT ${PR_COLS} FROM events WHERE event_type IN ('pr_merged','pr_closed') ORDER BY ${AT} DESC, id DESC LIMIT ?`, ACTIVITY_LIMIT
  );
  const listPrs = latestPrs.slice(0, PR_LIMIT);
  const merged = recentPrs.filter((p) => p.event_type === "pr_merged");
  const mergedThisWeek = merged.filter((p) => p.at > weekAgo);
  const mergedLastWeek = merged.filter((p) => p.at <= weekAgo && p.at > twoWeeksAgo);
  const closedUnmerged = recentPrs.filter((p) => p.event_type === "pr_closed" && p.at > weekAgo);

  const openNow = await openIssuesAsOf(db, nowAt);
  const openThen = await openIssuesAsOf(db, weekAgo);

  // ── repo capture (sources A, B) ───────────────────────────────────────────
  // `prCaptured` is a COMPLETENESS marker (`prs_reconciled`, written by
  // reconcileRepo only after the open-PR list is fetched AND ingested), not
  // "any pr row exists" — a single webhook delivery must not claim a complete
  // open-PR count. Same field name/shape as before; only what it gates on
  // changed.
  const prCaptured = (await getSnapshot(db, "prs_reconciled")) !== null;
  const isOpen = (r: RepoPrRow) => r.state === "draft" || r.state === "review";
  const prsNow = prCaptured ? (await prStatesAsOf(db, nowAt)).filter(isOpen) : [];
  const prsThen = prCaptured ? (await prStatesAsOf(db, weekAgo)).filter(isOpen) : [];
  // The PR list: the latest state per PR, unknown states dropped (never guessed).
  const prRows = prCaptured ? (await recentPrRows(db, PR_LIMIT, ninetyDaysAgo)).filter((r) => isKnownPrState(r.state)) : [];
  // ONE approval read for both consumers below — the listed PRs and the open-PR
  // tile. An approved PR is no longer "awaiting review".
  const approved = await approvedPrs(db, [...prsNow, ...prRows].filter((r) => r.state === "review").map((r) => r.number ?? 0));
  const awaiting = (rows: RepoPrRow[], done: Set<number> = new Set()) =>
    rows.filter((r) => r.state === "review" && !done.has(r.number ?? -1)).length;
  // A delta is only real once capture was RECORDING for the whole comparison
  // window — otherwise "now vs a week ago" is really "now vs whenever capture
  // began", which reads as a spurious spike. `tickets` is the fallback tile's
  // own read, so skip it entirely once PR capture makes that tile unreachable.
  const prRecordingSince = prCaptured ? await recordingSince(db, "pr") : null;
  const prDeltaOk = prRecordingSince !== null && prRecordingSince <= weekAgo;
  const tickets = prCaptured ? { open: 0, delta: 0 } : await ticketCounts(db, weekAgo);
  const pushes = await pushRowsSince(db, twoWeeksAgo);
  const pushesThisWeek = pushes.filter((p) => p.occurred_at > weekAgo);
  const sum = (rows: RepoEventRow[]) => rows.reduce((n, r) => n + (r.count ?? 0), 0);
  const commitsThisWeek = sum(pushesThisWeek);
  const commitsLastWeek = sum(pushes.filter((p) => p.occurred_at <= weekAgo));
  const pushRecordingSince = pushes.length ? await recordingSince(db, "push") : null;
  const pushDeltaOk = pushRecordingSince !== null && pushRecordingSince <= twoWeeksAgo;

  // ── environments: two deployables each (Railway backend, Cloudflare frontend) ─
  // Batched on purpose: ONE deploy-history read covering every environment and
  // both halves, ONE branch-head read, and ONE check read covering the
  // environment heads AND the listed PRs' heads together. N environments cost
  // the same three round-trips as one.
  const strips = envs.length ? await deployHistories(db, now) : new Map<string, RepoDeploy[]>();
  const heads = envs.length ? await branchHeads(db, envs.map((e) => e.branch)) : new Map<string, string>();
  const checks = await latestChecks(db, [...heads.values(), ...prRows.map((r) => r.sha ?? "")]);

  // Environment health: 10-minute pings the repo cron writes (src/repo/poll.ts).
  // A row older than HEALTH_STALE_MS means the cron has stopped — never guess
  // "up" off a stale ping, so a stale (or missing) row is simply left out here,
  // which also keeps it out of the pill below (never guessed either). But a
  // stale row is still EVIDENCE THE PINGS EXIST, which is a different answer
  // from never having been set up: `healthEver` carries that apart, so the
  // block can read `empty` ("the last ping is old") rather than claiming
  // nothing pings these URLs. ONE query for every environment half.
  const healthRows = envs.length ? await latestHealth(db) : new Map<string, { at: string; value: number }>();
  const health: RepoHealth[] = [];
  let healthEver = false;
  for (const cfg of envs) {
    for (const [part, label, url] of [["frontend", "web", cfg.frontendUrl], ["backend", "api", cfg.apiUrl + cfg.healthPath]] as const) {
      const up = healthRows.get(`health_up:${cfg.key}:${part}`);
      const ms = healthRows.get(`health_ms:${cfg.key}:${part}`);
      if (!up) continue;
      healthEver = true;
      if (now - Date.parse(up.at) <= HEALTH_STALE_MS) health.push({ env: `${cfg.label} · ${label}`, url, up: up.value === 1, ms: Math.round(ms?.value ?? 0) });
    }
  }

  const deployRows: RepoDeployRow[] = [];
  const cards = envs.map((cfg) => {
    const parts: RepoEnvPart[] = PARTS.map((part) => {
      const history = strips.get(`${cfg.key}:${part}`) ?? [];
      // A half with no capture gets no dot strip at all — an empty one would
      // read as "nothing has deployed", which is not what is known.
      if (history.length) deployRows.push({ env: cfg.key, part, label: `${cfg.label} · ${PART_WORD[part]}`, deploys: history });
      const last = history[history.length - 1] ?? null;
      return { part, host: HOSTS[part], sha: last?.sha ?? null, deployedAt: last?.at ?? null, deployedBy: last?.by ?? null, result: last?.result ?? null };
    });
    const head = heads.get(cfg.branch);
    const onHead = (head ? checks.get(head) : undefined) ?? [];
    const failing = onHead.filter((c) => c.state === "failure" || c.state === "timed_out").map((c) => c.name);
    const settled = onHead.filter((c) => c.state !== "pending");
    const ci = !onHead.length ? "No checks captured"
      : failing.length ? `${failing.length} of ${onHead.length} checks failing — ${failing[0]}`
      : settled.length < onHead.length ? `${settled.length} of ${onHead.length} checks finished`
      : `All ${onHead.length} checks passing`;
    const envHealth = health.filter((h) => h.env.startsWith(`${cfg.label} ·`));
    const down = envHealth.some((h) => !h.up);
    // The card is CONNECTED once anything about the environment was captured —
    // a deploy result, a head check, or a health ping. That is a different
    // question from the pill, which is a verdict: HEALTHY is a claim about
    // CHECKS, so it needs checks captured on the head, none of them failing,
    // and no failed part — a health ping alone (up, but no deploys/checks) is
    // not enough to call it HEALTHY, only enough to call it connected. A part
    // that FAILED is a fact on its own, so FAILING does not wait for checks.
    // DOWN outranks everything: the site being unreachable is the headline,
    // whatever the checks say.
    // Two different questions, and the second is NOT the first: the card is
    // connected once ANYTHING about the environment landed (health included),
    // but the DEPLOYS section's fallback must ignore health — one ping is not
    // grounds to say "No deploys recorded" while no deploy capture exists at all.
    const deployCapture = parts.some((p) => p.result !== null) || onHead.length > 0;
    const connected = deployCapture || envHealth.length > 0;
    const failed = parts.some((p) => p.result === "fail");
    const known = onHead.length > 0;
    const card: RepoEnv = {
      key: cfg.key, name: cfg.label, note: cfg.note, parts, url: cfg.frontendUrl, ci,
      ciTone: !onHead.length ? "neutral" : failing.length ? "bad" : "good",
      pill: down ? "DOWN" : failed ? "FAILING" : failing.length ? "DEGRADED" : known ? "HEALTHY" : "UNKNOWN",
      tone: down || failed ? "bad" : failing.length ? "warn" : known ? "good" : "neutral",
    };
    return { card, connected, deployCapture };
  });
  const envCards: RepoEnv[] = cards.map((c) => c.card);
  const anyEnvCapture = cards.some((c) => c.connected);
  const anyDeployCapture = cards.some((c) => c.deployCapture);

  // CI is `not_connected` until a workflow run has ever been captured — a 0%
  // failure rate over nothing is a guess, not an answer. And the SEVEN-DAY rate
  // (and its per-day trend) waits for the same recording-window rule the PR and
  // commit deltas use: until `run` capture predates the whole week, a day with
  // no captured runs is a day capture was not running, not a green day. The
  // failures LIST is not gated — those rows are facts.
  const runCaptured = await hasCaptured(db, "run");
  const runRecordingSince = runCaptured ? await recordingSince(db, "run") : null;
  const ciRates = runRecordingSince !== null && runRecordingSince <= weekAgo ? await ciDailyRates(db, now) : null;
  const failureRows = runCaptured ? await ciFailureRows(db, weekAgo, CI_FAILURE_LIMIT) : [];
  // The list is capped; the COUNT is not. Same window and definition as
  // `ciFailureRows` (a failed/timed-out run after `weekAgo`), so "N failures"
  // never reads the cap off the list.
  const failureTotal = !runCaptured ? 0
    : failureRows.length < CI_FAILURE_LIMIT ? failureRows.length
    : (await first<{ n: number }>(db,
        `SELECT COUNT(*) AS n FROM repo_events WHERE kind = 'run' AND state IN ('failure', 'timed_out') AND occurred_at > ?`, weekAgo))?.n ?? failureRows.length;
  const reviews = await reviewRowsSince(db, twoWeeksAgo);

  const issueEvents = await all<IssueRow>(
    db,
    `SELECT ref_number, subject_login, ${AT} AS at,
            json_extract(raw, '$.action') AS action, json_extract(raw, '$.issue.title') AS title,
            json_extract(raw, '$.issue.html_url') AS url, json_extract(raw, '$.issue.user.login') AS author
       FROM events WHERE event_type = 'issue'
        AND json_extract(raw, '$.action') IN ('opened','closed','reopened','assigned')
      ORDER BY ${AT} DESC, id DESC LIMIT ?`,
    // Enough to fill the feed AND cover a busy week of opens/closes for the tiles.
    200
  );
  const issuesThisWeek = issueEvents.filter((e) => e.at > weekAgo);
  const openedThisWeek = issuesThisWeek.filter((e) => e.action === "opened");
  const closedThisWeek = issuesThisWeek.filter((e) => e.action === "closed");

  // ── Overview tiles ────────────────────────────────────────────────────────
  const bugsNow = openNow.filter(isBug).length;
  const bugsThen = openThen.filter(isBug).length;
  const issueTiles: RepoStat[] = [
    { label: "Open issues", value: openNow.length, delta: openNow.length - openThen.length, tone: backlogTone(openNow.length - openThen.length, false) },
    { label: "Open bugs", value: bugsNow, delta: bugsNow - bugsThen, tone: backlogTone(bugsNow - bugsThen, true) },
  ];
  // Until PR state has been captured (or backfilled) an "Open PRs: 0" would be a lie.
  const stats: RepoStat[] = prCaptured
    ? [
        { label: "Open PRs", value: prsNow.length, delta: prDeltaOk ? prsNow.length - prsThen.length : 0, tone: "neutral" },
        // The week-ago value keeps the approval-blind form on purpose: which
        // PRs were approved a week ago is not knowable from today's reviews,
        // and the delta is suppressed anyway until capture predates the window.
        { label: "Awaiting review", value: awaiting(prsNow, approved), delta: prDeltaOk ? awaiting(prsNow, approved) - awaiting(prsThen) : 0, tone: "neutral" },
        ...issueTiles,
      ]
    : [
        { label: "Merged PRs", value: mergedThisWeek.length, delta: mergedThisWeek.length - mergedLastWeek.length, tone: "neutral" },
        ...issueTiles,
        { label: "Open tickets", value: tickets.open, delta: tickets.delta, tone: backlogTone(tickets.delta, false) },
      ];

  // ── Code ──────────────────────────────────────────────────────────────────
  const mergers = new Set(mergedThisWeek.map((p) => p.subject_login.toLowerCase())).size;
  const commitDelta = commitsThisWeek - commitsLastWeek;
  const codeStats: RepoCodeStat[] = [
    prCaptured
      ? { label: "Open PRs", value: prsNow.length, sub: `${awaiting(prsNow, approved)} awaiting review`, tone: "neutral" }
      : { label: "Closed unmerged", value: closedUnmerged.length, sub: "this week", tone: "neutral" },
    { label: "Merged this week", value: mergedThisWeek.length, sub: mergers === 0 ? "this week" : mergers === 1 ? "by 1 person" : `by ${mergers} people`, tone: "neutral" },
    pushes.length
      ? {
          label: "Commits this week", value: commitsThisWeek,
          sub: pushDeltaOk ? `${commitDelta >= 0 ? "▲" : "▼"} ${Math.abs(commitDelta)} vs last week` : "this week",
          tone: "neutral",
        }
      : { label: "Issues opened", value: openedThisWeek.length, sub: "this week", tone: "neutral" },
    // Never guess: the tile is "Active branches" only once a branches
    // snapshot exists; until then it keeps its previous content.
    branchSnap
      ? { label: "Active branches", value: branchSnap.data.active, sub: `${branchSnap.data.stale} stale`, tone: branchSnap.data.stale ? "warn" : "neutral" }
      : { label: "Issues closed", value: closedThisWeek.length, sub: "this week", tone: "neutral" },
  ];

  // Commits once pushes are captured; merges (what `events` has always had) until then.
  const commitDays = pushes.length ? await commitsByDay(db, twoWeeksAgo) : null;
  const perDay = new Map<string, number>();
  for (const p of merged) perDay.set(p.at.slice(0, 10), (perDay.get(p.at.slice(0, 10)) ?? 0) + 1);
  const days = lastDays(now, BAR_DAYS).map((date) => ({ date, count: (commitDays ?? perDay).get(date) ?? 0 }));
  const barTotal = days.reduce((n, d) => n + d.count, 0);
  const noun = commitDays ? "commit" : "merged PR";
  const bars: RepoBars = {
    title: `${commitDays ? "Commit" : "Merge"} activity — last ${BAR_DAYS} days`,
    note: `${barTotal} ${noun}${barTotal === 1 ? "" : "s"} · all branches`,
    days,
  };

  // ── Activity: PR closes + issue moves, one time-ordered feed ──────────────
  const prActivity: RepoActivity[] = latestPrs.map((p) => ({
    kind: p.event_type === "pr_merged" ? "merge" as const : "close" as const,
    // The capture names the PR's AUTHOR, not who pressed merge — so say whose it is.
    actor: null,
    text: `#${p.ref_number} “${p.title ?? ""}” by @${personOf(people, p.subject_login).handle ?? p.subject_login} was ${p.event_type === "pr_merged" ? "merged" : "closed unmerged"}`,
    url: p.url, at: p.at,
  }));
  const issueActivity = issueEvents.map((e) => activityOf(people, e)).filter((a): a is RepoActivity => a !== null);
  // A backfilled push is a synthetic count-1 row PER COMMIT (40 real commits
  // become 40 rows), so it would flood the feed with lines a real push never
  // produces — keep the feed to what the webhook actually saw.
  const pushActivity: RepoActivity[] = pushes.filter((p) => p.provenance === "webhook").slice(0, ACTIVITY_LIMIT).map((p) => ({
    kind: "push" as const, actor: p.actor_login ? personOf(people, p.actor_login) : null,
    text: `pushed ${p.count ?? 0} commit${p.count === 1 ? "" : "s"} to ${p.ref ?? "a branch"}`, url: p.url, at: p.occurred_at,
  }));
  const reviewActivity: RepoActivity[] = reviews.slice(0, ACTIVITY_LIMIT).map((r) => ({
    kind: "review" as const, actor: r.actor_login ? personOf(people, r.actor_login) : null,
    text: `${REVIEW_TEXT[r.state ?? "commented"] ?? "reviewed"} #${r.number ?? "?"}`, url: r.url, at: r.occurred_at,
  }));
  // A deploy line is worth a feed row only once it landed — a failed or
  // cancelled attempt belongs to the dot strip, not to "what happened".
  const deployActivity: RepoActivity[] = deployRows.flatMap((row) =>
    row.deploys.filter((d) => d.result === "ok").map((d) => ({
      kind: "deploy" as const, actor: null, text: `${d.sha} deployed to ${row.label}`, url: null, at: d.at,
    })));
  const activity = prActivity.concat(issueActivity, pushActivity, reviewActivity, deployActivity)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, ACTIVITY_LIMIT);

  // ── Team & Planning ───────────────────────────────────────────────────────
  const tally = new Map<string, { login: string; pushes: number; merged: number; reviews: number }>();
  const bump = (login: string, key: "pushes" | "merged" | "reviews") => {
    const k = login.toLowerCase();
    const row = tally.get(k) ?? { login, pushes: 0, merged: 0, reviews: 0 };
    row[key] += 1;
    tally.set(k, row);
  };
  // A bot's pushes are not a person's week; nor is a backfilled one — a
  // 40-commit backfilled push would tally P=40 for one person against a real
  // push's P=1 for the same 40 commits.
  for (const p of pushesThisWeek) if (p.actor_login && !p.actor_login.endsWith("[bot]") && p.provenance === "webhook") bump(p.actor_login, "pushes");
  for (const p of mergedThisWeek) bump(p.subject_login, "merged");
  // A tally of 0 would render as a real "0 reviews" column. Show the count only
  // once a `review` row has been captured BY THE WEBHOOK; until then it is
  // `null` (never guessed) — `reviews` in the window can legitimately be 0 for a
  // person. A polled row does not open the gate: reconcile's `reviews` arm sees
  // only the 30 most recently updated OPEN PRs × their last 10 reviews, so a
  // person whose one review sits on a PR merged before the poll would read a
  // hard `0` — a claim ("reviewed nothing") that arm cannot support. The
  // webhook, once subscribed, is complete going forward. With the gate open,
  // polled rows count like any other (they dedupe against the webhook's).
  // `approvedPrs` / "Awaiting review" above are NOT gated, and use polled rows
  // at once: they ask only about OPEN PRs — the set the arm reads — and act on
  // a POSITIVE fact (an approval or a change request exists). What the arm can
  // miss (an open PR past the 30th, an approval buried under 10 later reviews)
  // leaves that PR reading "awaiting review", which is what EVERY open PR read
  // before the arm existed: a polled row can only make that tile more right.
  const hasReviewCapture = await hasCaptured(db, "review", "webhook");
  // Tallied only with the gate open: a hidden count must not order the list or
  // add a row ("0 · 0 · —") for someone known only by a polled review. Same
  // rule as the pushes above: a review bot (CodeRabbit, Copilot) is not a
  // person having a week, and would dwarf every human column.
  if (hasReviewCapture) {
    for (const r of reviews) if (r.occurred_at > weekAgo && r.actor_login && !r.actor_login.endsWith("[bot]")) bump(r.actor_login, "reviews");
  }
  const contributors: RepoContributor[] = [...tally.values()]
    .sort((a, b) => (b.pushes + b.merged + b.reviews) - (a.pushes + a.merged + a.reviews) || a.login.localeCompare(b.login))
    .slice(0, CONTRIBUTOR_LIMIT)
    .map((t) => ({ person: personOf(people, t.login), pushes: t.pushes, merged: t.merged, reviews: hasReviewCapture ? t.reviews : null }));

  const byLabel = new Map<string, number>();
  for (const i of openNow) for (const l of i.labels) byLabel.set(l, (byLabel.get(l) ?? 0) + 1);
  const labels: RepoLabels = {
    total: openNow.length,
    rows: [...byLabel.entries()].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, LABEL_LIMIT),
  };

  // The sprint a person marked active (roadmap order) — never inferred from dates.
  const current = (await list_sprints(legacyTenant(db))).find((sp) => sp.active) ?? null;
  const sprint: RepoSprint | null = current
    ? { id: current.id, label: current.label, due: current.due, closed: current.progress.closed, total: current.progress.total, pct: current.progress.pct }
    : null;

  // `prRows` was already read (and filtered to known states) above, so the
  // checks and approvals could be resolved for the whole page in one query each.
  const capturedPrs: RepoPr[] = prCaptured
    ? prRows.map((r) => ({
        number: r.number ?? 0, title: r.title ?? `PR #${r.number}`, url: r.url ?? "",
        author: personOf(people, r.actor_login ?? "unknown"), branch: r.ref,
        // An approval is a state the capture can prove; everything else is the
        // row's own state (an unrecognized one was dropped, never guessed).
        state: r.state === "review" && approved.has(r.number ?? -1) ? "approved" : (r.state as RepoPr["state"]),
        checks: checkState(checks.get(r.sha ?? "")), at: r.occurred_at,
      }))
    : listPrs.map((p) => prOf(people, p));

  const some = <T>(rows: T[]): RepoSection<T[]> => (rows.length ? ok(rows) : EMPTY);
  // Never on the render path: GitHub's compare API is called off a push
  // webhook or reconcileRepo, never here — this only reads back what one of
  // those already wrote. No snapshot yet → not_connected; a stale one is
  // still shown, with nothing on screen saying how old it is (see `branches`).
  const driftSnap = await getSnapshot<RepoDrift>(db, "drift");

  // ── coverage / bundle / TODO count — repo_metrics, fed by the target repo's
  // CI posting a commit status that `handleGithubWebhook`'s `status` branch
  // (src/webhook.ts) turns into a metric point. Never a live scan at render time.
  const monthAgo = new Date(now - 30 * DAY).toISOString();
  // A wider window than coverage/bundle (90 days, not 30): the TODO count
  // moves slowly, so a 30-day window would too often hold only one point.
  const todoWindowStart = new Date(now - 90 * DAY).toISOString();
  // Three independent reads (M9) — batched rather than three sequential round-trips.
  const [covPts, bunPts, todoPts] = await Promise.all([
    metricSeries(db, "coverage", "", "", monthAgo),
    metricSeries(db, "bundle_kb", "", "", monthAgo),
    metricSeries(db, "todo_count", "", "", todoWindowStart),
  ]);
  // I2: a metric that has gone QUIET (nothing in the window) is not the same
  // as one that was never connected. `latestMetric` with no time bound answers
  // "has ANYTHING ever landed for this metric" — non-null → `empty` ("no
  // reading in the window"), null → `not_connected` ("nothing reports this at
  // all"). Only reached on the empty path, so it costs nothing once the
  // window already has points.
  const everEmpty = async (metric: string) => ((await latestMetric(db, metric, "", "")) !== null ? EMPTY : NOT_CONNECTED);
  // windowDelta's baseline is the window's FIRST point — once a series holds
  // more than 10 readings, that baseline can lie to the LEFT of the 10-point
  // sparkline drawn below (`.slice(-10)`): the delta and the drawn trend may
  // legitimately start from different points.
  const covDelta = windowDelta(covPts);
  const coverage: RepoSection<RepoTrend> = covPts.length
    ? ok({
        value: `${fixed(covPts[covPts.length - 1].value, 1)}%`,
        trend: covPts.slice(-10).map((p) => p.value),
        delta: covDelta === null ? "" : signed(covDelta, 1),
        tone: covDelta === null ? "neutral" : covDelta >= 0 ? "good" : "warn",
        note: "over 30 days",
      })
    : await everEmpty("coverage");
  const bunDelta = windowDelta(bunPts);
  const bundle: RepoSection<RepoTrend> = bunPts.length
    ? ok({
        value: `${fixed(bunPts[bunPts.length - 1].value, 0)} KB`,
        trend: bunPts.slice(-10).map((p) => p.value),
        delta: bunDelta === null ? "" : signed(bunDelta, 0, " KB"),
        tone: bunDelta === null ? "neutral" : bunDelta > 0 ? "warn" : "good",
        note: "over 30 days · gzip",
      })
    : await everEmpty("bundle_kb");
  const todoDelta = windowDelta(todoPts);
  const todos: RepoSection<RepoTodos> = todoPts.length
    ? ok({
        count: todoPts[todoPts.length - 1].value,
        delta: todoDelta,
        since: todoDelta === null ? "" : new Date(todoPts[0].at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
        trend: todoPts.slice(-10).map((p) => p.value),
      })
    : await everEmpty("todo_count");

  // ── usage + the Cloudflare panel — hourly `cf_*` metrics the repo cron polls
  // at minute 0 (src/repo/poll.ts). ONE statement for every range, environment
  // and series; the 24h / 7d / 30d views are sliced in memory. Same three
  // states as health and coverage: `ok` with something to show, `empty` when a
  // point has EVER landed but nothing is in the window (the poll has gone
  // quiet), `not_connected` when none ever did — and that existence read
  // (`metricsEver`, one more statement) is only made on the not-ok path. No
  // environment configured → nothing to attribute a Worker to: not_connected.
  // The `cf_polled` snapshot (the interval each environment's polls have looked at —
  // what entitles a missing hour to be drawn as 0) is ONE more read, issued
  // beside the first and never per environment.
  // Active users (Task 18) are in that SAME statement too — `active_users_*`
  // is in `usageReadGroups` and `USAGE_METRICS`, so a CURRENT reading makes `usage` ok on its
  // own, and a reading that has ever landed makes a quiet section `empty`.
  // The hosting block's `rw_*` gauges (Task 17) ride the SAME statement, and its
  // three states mirror health's: `ok` with a CURRENT figure for any
  // environment, `empty` when an `rw_*` row has ever landed but none is current
  // (the Railway poll has stopped), `not_connected` when none ever did.
  const usageEnd = Math.floor(now / HOUR) * HOUR;
  // Product metrics (contract v2) are ONE more statement beside those two —
  // `productReadings`: their names are dynamic, so they cannot be a named
  // `metricsSince` group. Its states are its own (a `sap_*` row says nothing
  // about whether usage is connected), but its "has anything EVER landed?"
  // question rides the SAME `metricsEver` statement, as a prefix family.
  const [usageRows, polledSnap, productRows] = envs.length
    ? await Promise.all([
        metricsSince(db, usageReadGroups(usageEnd, now)),
        getSnapshot<unknown>(db, CF_POLLED),
        // DISTINCT keys: the read joins against a `VALUES` list of them, so a key
        // listed twice in `REPO_ENVIRONMENTS` would return every row twice — and
        // every midnight would be pushed into its trend twice.
        productReadings(db, [...new Set(envs.map((e) => e.key))], new Date(now - HOSTING_STALE_MS).toISOString(), new Date(now - PRODUCT_TREND_DAYS * DAY).toISOString()),
      ])
    : [[], null, []];
  const polled = polledSnap?.data && typeof polledSnap.data === "object" ? (polledSnap.data as Record<string, unknown>) : {};
  const used = projectUsage(usageRows, envs, usageEnd, polled, now);
  // Gated on the WIDEST range; a narrower one may legitimately hold no rows.
  const anyCf = used.cloudflare["30d"].length > 0;
  const hosting = projectHosting(usageRows, envs, now);
  const produced = projectProduct(productRows, envs, now);
  const ever = envs.length && (!used.anyUsage || !anyCf || !hosting.length || !produced.anyProduct)
    ? await metricsEver(db, [...USAGE_METRICS, ...HOSTING_METRICS], [PRODUCT_PREFIX])
    : new Set<string>();
  const everAny = (metrics: string[]) => metrics.some((m) => ever.has(m));

  return {
    repo, generatedAt: nowAt, degraded: false,
    usage: used.anyUsage ? ok(used.usage) : everAny(USAGE_METRICS) ? EMPTY : NOT_CONNECTED,
    cloudflare: anyCf ? ok(used.cloudflare) : ever.has("cf_requests") ? EMPTY : NOT_CONNECTED,
    hosting: hosting.length ? ok(hosting) : everAny(HOSTING_METRICS) ? EMPTY : NOT_CONNECTED,
    product: produced.anyProduct ? ok(produced.product) : ever.has(`${PRODUCT_PREFIX}*`) ? EMPTY : NOT_CONNECTED,
    coverage, bundle, todos,
    drift: driftSnap ? ok(driftSnap.data) : NOT_CONNECTED,
    branches: branchSnap ? ok(branchSnap.data) : NOT_CONNECTED,
    // Three states, not two. Every row here is already fresh (stale ones were
    // filtered out above); readings that exist but have all gone stale mean the
    // PINGS STOPPED (`empty`), and only a target that was never pinged at all
    // is `not_connected`.
    health: health.length ? ok(health) : healthEver ? EMPTY : NOT_CONNECTED,
    // An environment card needs BOTH a configured environment and something
    // captured about it; a configured-but-silent environment is not connected.
    environments: envs.length && anyEnvCapture ? ok(envCards) : NOT_CONNECTED,
    // `anyDeployCapture`, NOT `anyEnvCapture`: health says nothing about deploys.
    deploys: deployRows.length ? ok(deployRows) : envs.length && anyDeployCapture ? EMPTY : NOT_CONNECTED,
    ciFailures: runCaptured
      ? ok({
          // null / [] until the week is covered — never a rate over a partial window.
          rate: ciRates?.rate ?? null, trend: ciRates?.days ?? [],
          rows: failureRows.map((r) => ({
            workflow: r.name ?? "workflow", branch: r.ref ?? "", job: r.title ?? "—",
            at: r.occurred_at, url: r.url ?? "",
          })),
          total: failureTotal,
        })
      : NOT_CONNECTED,
    stats: ok(stats),
    codeStats: ok(codeStats),
    bars: barTotal > 0 ? ok(bars) : EMPTY,
    // `openCount` is the "Open PRs" tile's own figure (`prsNow`), so the list's
    // consumers never count open PRs off the capped rows — and it is `null`
    // until the `prs_reconciled` marker makes it a complete count.
    prs: capturedPrs.length || prCaptured ? ok({ rows: capturedPrs, openCount: prCaptured ? prsNow.length : null }) : EMPTY,
    activity: some(activity),
    sprint: sprint ? ok(sprint) : EMPTY,
    contributors: some(contributors),
    labels: labels.rows.length ? ok(labels) : EMPTY,
  };
}
