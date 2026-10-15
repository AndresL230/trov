// Usage METRIC FAMILIES (repo setups, Phase G) — what the Usage tab reads, whoever hosts a part. Zod-free: the
// SPA imports the vocabularies below as VALUES (the `*-core.ts` rule), the Worker imports the same names.
//
// A family is a group of figures that are drawn together. The three CORE families are the normalised hosting
// vocabulary (`HOSTING_METRICS`, shared/hosting.ts) cut by what they say:
//   traffic    requests, server errors, bandwidth                (role web)
//   latency    response latency p50 / p95                        (role web)
//   compute    CPU, memory                                       (role service)
// and four EXTRA families only a provider that really reads them declares (`capabilities.families` — today only
// Cloudflare Workers; step 0 of the build confirmed each dataset against a live account):
//   outcomes   requests by invocation OUTCOME (`workersInvocationsAdaptive.status`: success, clientDisconnected,
//              scriptThrewException, exceededResources, … — NOT an HTTP status: there is no 4xx / 5xx split)
//   runtime    CPU time p50 / p99 and wall time p50 per completed UTC day (quantiles), subrequests per hour
//   storage    D1: read / write queries, rows read / written per completed UTC day, database size
//   schedules  cron triggers: runs, failures and the last run, per cron expression, per hour
// The SPA never branches on a provider id: it reads a part's families, their states and its capabilities.
//
// Every extra point is a `repo_metrics` row under the hosting prefix `hx_` (pruned at 100 days with the rest):
//   hx_outcome_<status>            hourly sum   (status: Cloudflare's own word, letters only)
//   hx_subrequests                 hourly sum
//   hx_cpu_time_p50_us / _p99_us   daily gauge  (`at` = 00:00 UTC of the day it describes, µs as Cloudflare reports)
//   hx_wall_time_p50_us            daily gauge
//   hx_daily_read                  daily marker (1): the day's quantiles were read — the once-a-day rule
//   hx_d1_<field>:<database id>    daily (read_queries / write_queries / rows_read / rows_written sums; size_bytes gauge)
//   hx_cron_<field>:<expression>   hourly (runs / failed sums; last = the epoch ms of the hour's last run)
// A cron expression is stored with its spaces as `_` (`*/10_*_*_*_*`): a cron field never holds `_`.

import type { HostingMetric, PartRole } from "./hosting";
import type { RepoRange } from "./repo";

// ── the families ─────────────────────────────────────────────────────────────

export const CORE_FAMILIES = ["traffic", "latency", "compute"] as const;
export const EXTRA_FAMILIES = ["outcomes", "runtime", "storage", "schedules"] as const;
export const USAGE_FAMILIES = [...CORE_FAMILIES, ...EXTRA_FAMILIES] as const;
export type CoreFamily = (typeof CORE_FAMILIES)[number];
export type ExtraFamily = (typeof EXTRA_FAMILIES)[number];
export type UsageFamily = (typeof USAGE_FAMILIES)[number];
export const isUsageFamily = (v: unknown): v is UsageFamily => typeof v === "string" && (USAGE_FAMILIES as readonly string[]).includes(v);
export const isExtraFamily = (v: unknown): v is ExtraFamily => typeof v === "string" && (EXTRA_FAMILIES as readonly string[]).includes(v);

/** The core families over the normalised vocabulary — every `HOSTING_METRICS` key in exactly one. */
export const FAMILY_METRICS: Record<CoreFamily, readonly HostingMetric[]> = {
  traffic: ["requests", "errors", "bandwidth_bytes"],
  latency: ["latency_p50_ms", "latency_p95_ms"],
  compute: ["cpu", "mem_mb"],
};
/** The role each family's figures belong to. */
export const FAMILY_ROLE: Record<UsageFamily, PartRole> = {
  traffic: "web", latency: "web", compute: "service", outcomes: "web", runtime: "web", storage: "web", schedules: "web",
};
/** How the screen names a family. */
export const FAMILY_LABEL: Record<UsageFamily, string> = {
  traffic: "Traffic", latency: "Latency", compute: "CPU and memory", outcomes: "Requests by outcome", runtime: "Runtime",
  storage: "D1 database", schedules: "Scheduled runs",
};

/** The family a normalised metric belongs to. */
export function familyOfMetric(m: HostingMetric): CoreFamily {
  return (CORE_FAMILIES.find((f) => FAMILY_METRICS[f].includes(m)) ?? "traffic");
}

/** The families a provider reads: the core families its `capabilities.metrics` touch, then the extra families it
 *  declares (`capabilities.families`) — each once, in vocabulary order. */
export function familiesOf(capabilities: { metrics: readonly HostingMetric[]; families?: readonly ExtraFamily[] }): UsageFamily[] {
  const have = new Set<UsageFamily>(capabilities.metrics.map(familyOfMetric));
  for (const f of capabilities.families ?? []) have.add(f);
  return USAGE_FAMILIES.filter((f) => have.has(f));
}

// ── the stored names of the extra families ───────────────────────────────────

/** A Cloudflare invocation outcome as stored: letters only, ≤ 40 (`success`, `clientDisconnected`, …). */
export const OUTCOME_STATUS_RE = /^[A-Za-z]{1,40}$/;
export const OUTCOME_PREFIX = "hx_outcome_";
export const outcomeMetric = (status: string): string => `${OUTCOME_PREFIX}${status}`;
export const SUBREQUESTS_METRIC = "hx_subrequests";
export const RUNTIME_DAILY = {
  cpu_p50: "hx_cpu_time_p50_us", cpu_p99: "hx_cpu_time_p99_us", wall_p50: "hx_wall_time_p50_us",
} as const;
export const DAILY_READ_METRIC = "hx_daily_read";

/** A D1 database id: Cloudflare's UUID. */
export const D1_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const D1_FIELDS = ["read_queries", "write_queries", "rows_read", "rows_written", "size_bytes"] as const;
export type D1Field = (typeof D1_FIELDS)[number];
export const d1Metric = (field: D1Field, databaseId: string): string => `hx_d1_${field}:${databaseId}`;

/** A cron expression as Cloudflare reports it: five (or six) space-separated fields of cron characters, ≤ 80. */
export const CRON_EXPR_RE = /^[0-9A-Za-z*/,?#-]+(?: [0-9A-Za-z*/,?#-]+){4,5}$/;
export const CRON_FIELDS = ["runs", "failed", "last"] as const;
export type CronField = (typeof CRON_FIELDS)[number];
export const encodeCron = (expr: string): string => expr.replace(/ /g, "_");
export const decodeCron = (enc: string): string => enc.replace(/_/g, " ");
export const cronMetric = (field: CronField, expr: string): string => `hx_cron_${field}:${encodeCron(expr)}`;

/** The grain a stored extra point has: `hour` (an hour start, a complete hour) or `day` (00:00 UTC of a completed day). */
export type ExtraGrain = "hour" | "day";
export type ExtraMetricName =
  | { family: "outcomes"; field: "outcome"; status: string; grain: "hour" }
  | { family: "runtime"; field: "subrequests"; grain: "hour" }
  | { family: "runtime"; field: keyof typeof RUNTIME_DAILY; grain: "day" }
  | { family: "runtime"; field: "daily_read"; grain: "day" }
  | { family: "storage"; field: D1Field; database: string; grain: "day" }
  | { family: "schedules"; field: CronField; cron: string; grain: "hour" };

/** The inverse of the builders above: what an extra metric name says, or null for any other name. A name that
 *  merely starts like one (a bad status, a malformed id, an expression that is not a cron) is null — never a guess. */
export function parseExtraMetric(name: string): ExtraMetricName | null {
  if (name === SUBREQUESTS_METRIC) return { family: "runtime", field: "subrequests", grain: "hour" };
  if (name === DAILY_READ_METRIC) return { family: "runtime", field: "daily_read", grain: "day" };
  for (const [field, metric] of Object.entries(RUNTIME_DAILY) as [keyof typeof RUNTIME_DAILY, string][]) {
    if (name === metric) return { family: "runtime", field, grain: "day" };
  }
  if (name.startsWith(OUTCOME_PREFIX)) {
    const status = name.slice(OUTCOME_PREFIX.length);
    return OUTCOME_STATUS_RE.test(status) ? { family: "outcomes", field: "outcome", status, grain: "hour" } : null;
  }
  const d1 = /^hx_d1_([a-z_]+):(.+)$/.exec(name);
  if (d1) {
    const field = d1[1] as D1Field;
    return (D1_FIELDS as readonly string[]).includes(field) && D1_ID_RE.test(d1[2]) ? { family: "storage", field, database: d1[2], grain: "day" } : null;
  }
  const cron = /^hx_cron_([a-z]+):(.+)$/.exec(name);
  if (cron) {
    const field = cron[1] as CronField;
    const expr = decodeCron(cron[2]);
    return (CRON_FIELDS as readonly string[]).includes(field) && cron[2].length <= 80 && CRON_EXPR_RE.test(expr)
      ? { family: "schedules", field, cron: expr, grain: "hour" } : null;
  }
  return null;
}

/** The SQL GLOBs that find every extra point (GLOB: `_` is literal, `*` any run) — the projection's one read. */
export const EXTRA_METRIC_GLOBS = ["hx_outcome_*", SUBREQUESTS_METRIC, "hx_cpu_time_*", "hx_wall_time_*", "hx_d1_*", "hx_cron_*"] as const;

// ── outcomes, in words ───────────────────────────────────────────────────────

/** How an outcome reads, by Cloudflare's own status name. An outcome not listed reads as its own name split into
 *  words ("someNewOutcome" → "Some new outcome"), neutral — shown, never folded into another bucket. */
const OUTCOME_WORDS: Record<string, { label: string; tone: UsageTone }> = {
  success: { label: "Success", tone: "good" },
  clientDisconnected: { label: "Client disconnected", tone: "neutral" },
  scriptThrewException: { label: "Script errors", tone: "bad" },
  exceededResources: { label: "Exceeded limits", tone: "warn" },
  exceededCpu: { label: "Exceeded CPU limit", tone: "warn" },
  exceededMemory: { label: "Exceeded memory limit", tone: "warn" },
  internalError: { label: "Internal errors", tone: "bad" },
};
export type UsageTone = "neutral" | "good" | "warn" | "bad";
export function outcomeWords(status: string): { label: string; tone: UsageTone } {
  if (Object.hasOwn(OUTCOME_WORDS, status)) return OUTCOME_WORDS[status];
  const words = status.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return { label: words ? words[0].toUpperCase() + words.slice(1) : status, tone: "neutral" };
}

// ── the projection: what a part's extra families say (RepoProviderPart.extras) ──

/**
 * The state of one family for one part:
 *   ok           something to show in at least one range
 *   stale        read before (inside the projection's own 30-day read), nothing current
 *   unavailable  the provider could not read it for this part, with its reason (`reason`)
 *   none         never read — the block is not drawn
 */
export type FamilyState = "ok" | "stale" | "unavailable" | "none";
export interface FamilyStatus { state: FamilyState; reason: string | null }

/** One outcome bucket in one range: its status as Cloudflare names it, its words, its count. */
export interface UsageOutcome { status: string; label: string; tone: UsageTone; count: number }
export interface UsageOutcomes extends FamilyStatus {
  /** Per range, the buckets that EXIST (a status with a point in range), largest first; null = nothing known in that range. */
  ranges: Record<RepoRange, UsageOutcome[] | null>;
}
export interface UsageRuntime extends FamilyStatus {
  /** The completed UTC day the quantiles describe (`YYYY-MM-DD`), or null. Shown only while it is at most 2 days old. */
  day: string | null;
  cpu_p50_ms: number | null;
  cpu_p99_ms: number | null;
  wall_p50_ms: number | null;
  /** Hourly sums per range; null when nothing is known in the range. */
  subrequests: Record<RepoRange, number | null>;
  /** CPU time p99 per completed day, oldest first, a missed day ABSENT — ≤ 30 points. */
  cpu_p99_trend: { at: string; ms: number }[];
}
export interface UsageDatabase {
  id: string;
  /** Sums of the daily points over the range's last N completed UTC days (24h → 1, 7d → 7, 30d → 30); null = none in it. */
  read_queries: Record<RepoRange, number | null>;
  write_queries: Record<RepoRange, number | null>;
  rows_read: Record<RepoRange, number | null>;
  rows_written: Record<RepoRange, number | null>;
  /** The newest size reading (bytes) and its day, while it is at most 2 days old; else null. */
  size_bytes: number | null;
  size_day: string | null;
  /** Read queries per completed day, oldest first, a missed day ABSENT. */
  trend: { at: string; reads: number }[];
}
export interface UsageStorage extends FamilyStatus { databases: UsageDatabase[] }
export interface UsageCron {
  expr: string;
  runs: Record<RepoRange, number | null>;
  failed: Record<RepoRange, number | null>;
  /** The newest run seen (ISO), or null. */
  last_run: string | null;
}
export interface UsageSchedules extends FamilyStatus { crons: UsageCron[] }

/** `RepoProviderPart.extras`: one entry per EXTRA family the part's provider reads (absent = it reads none of it). */
export interface PartExtras {
  outcomes?: UsageOutcomes;
  runtime?: UsageRuntime;
  storage?: UsageStorage;
  schedules?: UsageSchedules;
}
