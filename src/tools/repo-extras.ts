// The Usage tab's EXTRA usage families per part (repo setups, Phase G — shared/usage-families-core.ts): outcomes,
// runtime, storage, schedules — what a provider that declares them (today Cloudflare Workers) stored, projected IN
// MEMORY from ONE read (`extraMetricsSince`, src/repo/store.ts). Pure: rows in, `PartExtras` out. Reachable from
// src/mcp.ts through src/tools/repo.ts, so it imports nothing that resolves a credential.
//
// NEVER A GUESS (invariant 7). An hourly family's range figure is the SUM of its real points in the range's last N
// complete hours; with no point it is 0 only where the part's covered interval (its last good polls) overlaps the
// range AND the family was read (no reason stored for it) — else null. A daily family's range figure is the sum of
// the daily points of the range's last 1 / 7 / 30 COMPLETED UTC days; with none it is null (a day with no point was
// not read, or read nothing: never a zero). The day's quantiles and a database's size are shown only while their day
// is at most two days old. A family the provider could not read carries its reason; one never read is `none` and is
// not drawn.
import { REPO_RANGES, type RepoRange } from "@shared/repo";
import {
  outcomeWords, parseExtraMetric, type ExtraFamily, type FamilyState, type PartExtras, type UsageCron, type UsageDatabase, type UsageOutcome,
} from "@shared/usage-families-core";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The range's span in complete hours (hourly families) and in completed days (daily families). */
const RANGE_HOURS: Record<RepoRange, number> = { "24h": 24, "7d": 168, "30d": 720 };
const RANGE_DAYS: Record<RepoRange, number> = { "24h": 1, "7d": 7, "30d": 30 };
/** A day's quantile / a database's size is "current" while its day is at most this many days before today. */
const DAILY_FRESH_DAYS = 2;

export interface ExtrasInput {
  env: string;
  part: string;
  /** The EXTRA families the part's provider declares. */
  families: readonly ExtraFamily[];
  /** The part's covered interval (its last good polls), as instants, or null. */
  covered: { from: number; to: number } | null;
  /** The family reasons stored in its poll state (`{ family, reason }` entries). */
  reasons: ReadonlyMap<ExtraFamily, string>;
  /** Its settings — `crons` lists the expressions the screen shows even when one never ran. */
  settings: Readonly<Record<string, string>>;
}
export type ExtraRow = { metric: string; env: string; part: string; at: string; value: number };

interface Pt { t: number; value: number }

/** `hx_*` reasons and family entries of a stored poll state: the `{ family, reason }` ones only, each checked. */
export function familyReasons(json: string | null | undefined): Map<ExtraFamily, string> {
  const out = new Map<ExtraFamily, string>();
  try {
    const v = json ? (JSON.parse(json) as unknown) : [];
    if (!Array.isArray(v)) return out;
    for (const x of v) {
      const o = x && typeof x === "object" ? (x as { family?: unknown; reason?: unknown }) : {};
      if ((o.family === "outcomes" || o.family === "runtime" || o.family === "storage" || o.family === "schedules") && typeof o.reason === "string") out.set(o.family, o.reason);
    }
  } catch { /* a malformed state says nothing */ }
  return out;
}

/** A family's state: `ok` with something in its newest window, `stale` with points only older than that, else its
 *  stored reason (`unavailable`), else `none`. */
function stateOf(any: boolean, fresh: boolean, reason: string | undefined): { state: FamilyState; reason: string | null } {
  if (any) return { state: fresh ? "ok" : "stale", reason: reason ?? null };
  return reason ? { state: "unavailable", reason } : { state: "none", reason: null };
}

/**
 * PURE. One part's extras from the extra rows (any env / part — filtered here), as of `endExcl` (the last complete
 * hour's end) and `now`. Only the families in `input.families` appear.
 */
export function projectExtras(input: ExtrasInput, rows: readonly ExtraRow[], endExcl: number, now: number): PartExtras | undefined {
  if (!input.families.length) return undefined;
  const mine = rows.filter((r) => r.env === input.env && r.part === input.part);
  const parsed = mine.flatMap((r) => {
    const name = parseExtraMetric(r.metric);
    const t = Date.parse(r.at);
    return name && Number.isFinite(t) && Number.isFinite(r.value) ? [{ name, t, value: r.value }] : [];
  });
  const hourStart = (range: RepoRange) => endExcl - RANGE_HOURS[range] * HOUR;
  const inHours = (pts: Pt[], range: RepoRange) => pts.filter((p) => p.t >= hourStart(range) && p.t < endExcl);
  // The last COMPLETED UTC day ends at today's 00:00.
  const today = Math.floor(now / DAY) * DAY;
  const inDays = (pts: Pt[], range: RepoRange) => pts.filter((p) => p.t >= today - RANGE_DAYS[range] * DAY && p.t < today);
  const sum = (pts: Pt[]) => pts.reduce((n, p) => n + p.value, 0);
  // Coverage proves a zero only for a family that was read (no stored reason) — and only inside the range.
  const coveredIn = (range: RepoRange, family: ExtraFamily): boolean => {
    if (!input.covered || input.reasons.has(family)) return false;
    const from = Math.max(hourStart(range), Math.ceil(input.covered.from / HOUR) * HOUR);
    return Math.min(endExcl, Math.floor(input.covered.to / HOUR) * HOUR) > from;
  };
  const hourly = (pts: Pt[], range: RepoRange, family: ExtraFamily): number | null => {
    const got = inHours(pts, range);
    return got.length ? sum(got) : coveredIn(range, family) ? 0 : null;
  };
  const daily = (pts: Pt[], range: RepoRange): number | null => {
    const got = inDays(pts, range);
    return got.length ? sum(got) : null;
  };
  const firstAt = (pts: Pt[]): string | null => (pts.length ? new Date(Math.min(...pts.map((p) => p.t))).toISOString() : null);
  const perRange = <T>(f: (r: RepoRange) => T): Record<RepoRange, T> => Object.fromEntries(REPO_RANGES.map((r) => [r, f(r)])) as Record<RepoRange, T>;
  const isFreshDay = (t: number) => t >= today - DAILY_FRESH_DAYS * DAY && t < today;
  const out: PartExtras = {};

  if (input.families.includes("outcomes")) {
    const byStatus = new Map<string, Pt[]>();
    for (const p of parsed) if (p.name.family === "outcomes") byStatus.set(p.name.status, [...(byStatus.get(p.name.status) ?? []), { t: p.t, value: p.value }]);
    const all = [...byStatus.values()].flat();
    const ranges = perRange((range): UsageOutcome[] | null => {
      const buckets = [...byStatus].map(([status, pts]) => ({ status, ...outcomeWords(status), count: sum(inHours(pts, range)) })).filter((b) => b.count > 0)
        .sort((a, b) => b.count - a.count || (a.status < b.status ? -1 : 1));
      return buckets.length ? buckets : coveredIn(range, "outcomes") && all.length ? [] : null;
    });
    out.outcomes = { ...stateOf(all.length > 0, inHours(all, "24h").length > 0 || ranges["24h"] !== null, input.reasons.get("outcomes")), ranges, since: firstAt(all) };
  }

  if (input.families.includes("runtime")) {
    const pick = (field: string): Pt[] => parsed.filter((p) => p.name.family === "runtime" && p.name.field === field).map((p) => ({ t: p.t, value: p.value }));
    const sub = pick("subrequests"), p50 = pick("cpu_p50"), p99 = pick("cpu_p99"), wall = pick("wall_p50");
    const newestDay = [...p50, ...p99, ...wall].filter((p) => p.t < today).reduce((m, p) => Math.max(m, p.t), -Infinity);
    const fresh = Number.isFinite(newestDay) && isFreshDay(newestDay);
    const at = (pts: Pt[]): number | null => {
      const hit = fresh ? pts.find((p) => p.t === newestDay) : undefined;
      return hit ? Math.round(hit.value / 10) / 100 : null; // µs → ms, two decimals
    };
    const quantiles = [...p50, ...p99, ...wall];
    out.runtime = {
      ...stateOf(quantiles.length + sub.length > 0, fresh || inHours(sub, "24h").length > 0, input.reasons.get("runtime")),
      day: fresh ? new Date(newestDay).toISOString().slice(0, 10) : null,
      cpu_p50_ms: at(p50), cpu_p99_ms: at(p99), wall_p50_ms: at(wall),
      subrequests: perRange((r) => hourly(sub, r, "runtime")),
      since: firstAt(sub),
      trend: p99.filter((p) => p.t >= today - 30 * DAY && p.t < today).sort((a, b) => a.t - b.t)
        .map((p) => ({ at: new Date(p.t).toISOString(), cpu_p99_ms: Math.round(p.value / 10) / 100 })),
    };
  }

  if (input.families.includes("storage")) {
    const ids: string[] = [];
    const series = new Map<string, Pt[]>();
    for (const p of parsed) {
      if (p.name.family !== "storage") continue;
      if (!ids.includes(p.name.database)) ids.push(p.name.database);
      const key = `${p.name.database}|${p.name.field}`;
      series.set(key, [...(series.get(key) ?? []), { t: p.t, value: p.value }]);
    }
    const of = (id: string, field: string) => series.get(`${id}|${field}`) ?? [];
    const databases = ids.map((id): UsageDatabase => {
      const size = of(id, "size_bytes").filter((p) => isFreshDay(p.t)).sort((a, b) => b.t - a.t)[0];
      const reads = of(id, "read_queries");
      return {
        id,
        read_queries: perRange((r) => daily(reads, r)), write_queries: perRange((r) => daily(of(id, "write_queries"), r)),
        rows_read: perRange((r) => daily(of(id, "rows_read"), r)), rows_written: perRange((r) => daily(of(id, "rows_written"), r)),
        size_bytes: size ? size.value : null, size_day: size ? new Date(size.t).toISOString().slice(0, 10) : null,
        trend: reads.filter((p) => p.t >= today - 30 * DAY && p.t < today).sort((a, b) => a.t - b.t).map((p) => ({ at: new Date(p.t).toISOString(), reads: p.value })),
      };
    });
    const any = [...series.values()].flat();
    out.storage = { ...stateOf(any.length > 0, any.some((p) => isFreshDay(p.t)), input.reasons.get("storage")), databases };
  }

  if (input.families.includes("schedules")) {
    const configured = (input.settings.crons ?? "").split(";").map((c) => c.trim().replace(/\s+/g, " ")).filter(Boolean);
    const exprs: string[] = [];
    const series = new Map<string, Pt[]>();
    for (const p of parsed) {
      if (p.name.family !== "schedules") continue;
      if (!exprs.includes(p.name.cron)) exprs.push(p.name.cron);
      const key = `${p.name.cron}|${p.name.field}`;
      series.set(key, [...(series.get(key) ?? []), { t: p.t, value: p.value }]);
    }
    for (const c of configured) if (!exprs.includes(c)) exprs.push(c);
    const of = (cron: string, field: string) => series.get(`${cron}|${field}`) ?? [];
    const crons = exprs.map((expr): UsageCron => {
      const last = of(expr, "last").reduce((m, p) => Math.max(m, p.value), -Infinity);
      return {
        expr,
        runs: perRange((r) => hourly(of(expr, "runs"), r, "schedules")),
        failed: perRange((r) => hourly(of(expr, "failed"), r, "schedules")),
        last_run: Number.isFinite(last) && last > 0 ? new Date(last).toISOString() : null,
      };
    });
    const any = [...series.values()].flat();
    out.schedules = { ...stateOf(any.length > 0, inHours(any, "24h").length > 0 || coveredIn("24h", "schedules"), input.reasons.get("schedules")), crons, since: firstAt(any) };
  }
  return out;
}

/** MCP's view of one range (`get_repo_dashboard` collapses every per-range record to the asked range). PURE. */
export function extrasForRange(x: PartExtras, range: RepoRange): unknown {
  const pick = <T>(rec: Record<RepoRange, T>): T => rec[range];
  return {
    ...(x.outcomes ? { outcomes: { ...x.outcomes, ranges: undefined, buckets: pick(x.outcomes.ranges) } } : {}),
    ...(x.runtime ? { runtime: { ...x.runtime, subrequests: pick(x.runtime.subrequests) } } : {}),
    ...(x.storage ? { storage: { ...x.storage, databases: x.storage.databases.map((d) => ({
      ...d, read_queries: pick(d.read_queries), write_queries: pick(d.write_queries), rows_read: pick(d.rows_read), rows_written: pick(d.rows_written),
    })) } } : {}),
    ...(x.schedules ? { schedules: { ...x.schedules, crons: x.schedules.crons.map((c) => ({ ...c, runs: pick(c.runs), failed: pick(c.failed) })) } } : {}),
  };
}
