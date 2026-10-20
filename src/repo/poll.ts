// Scheduled pulls for the repo dashboard — health pings, and Sapling's active
// users and product metrics (ONE request answers both). Each writes
// repo_metrics; none may throw — a dead target or a bad token costs one data
// point, never the cron tick. A HOST's usage (Cloudflare, Railway, Vercel, …)
// is not read here: that is the hosting providers' `:40` job (src/hosting/poll.ts).
import type { PollOutcome } from "@shared/repo";
import type { TenantContext } from "../data/sql";
import type { RepoEnvConfig } from "./config";
import { countMetric, totalMetric } from "./product";
import { deleteSnapshot, putMetric, putMetrics, putSnapshot } from "./store";
import type { RepoMetric } from "./types";

export type { PollOutcome };

/** What the HOURLY poller below (`pollSaplingMetrics`) hands back — one entry per configured
 *  environment each CONSIDERED, in config order — so an admin's on-demand run
 *  (`POST /admin/poll-usage`) can show what the cron only logs. `written` is
 *  NEW `repo_metrics` rows (`putMetric` says whether it wrote one): `0` on an
 *  `ok` is a re-poll of hours already stored, not a fault. A `failed` detail is
 *  the SAME scrubbed message the poller logs, cut to `DETAIL_CHARS`; a
 *  `skipped` detail names what is missing, never a secret's value. (`pingHealth`
 *  returns the same shape, per part.) */
const DETAIL_CHARS = 200;
const okOutcome = (env: string, written: number, detail?: string): PollOutcome =>
  ({ env, status: "ok", written, ...(detail ? { detail: detail.slice(0, DETAIL_CHARS) } : {}) });
const failedOutcome = (env: string, message: string, written = 0): PollOutcome => ({ env, status: "failed", written, detail: message.slice(0, DETAIL_CHARS) });
const skippedOutcome = (env: string, detail: string): PollOutcome => ({ env, status: "skipped", written: 0, detail });

const TEN_MIN = 600_000;
const PING_TIMEOUT_MS = 8_000;

/** Two targets per environment: its frontend URL and its API's health path
 *  (`frontend_url`, `api_url` + `health_path` — whatever hosts them). Polite: GET, an 8s timeout, follows redirects, a
 *  distinct user-agent, no retries. Every target is pinged CONCURRENTLY
 *  (`Promise.all`) — sequentially, four dead targets would burn 4 × the timeout
 *  before the tick's real work; each target still times ITSELF, so `health_ms`
 *  is unaffected by the concurrency.
 *
 *  NOTE on what "up" means here: `redirect: "follow"` + `res.ok` counts a
 *  redirect that LANDS on a 200 page as up — an apex that 301s to www, or a
 *  frontend that bounces an unauthenticated visitor to a sign-in page, reads as
 *  healthy. It is a reachability check, not a content check.
 *
 *  `at` is the 10-minute bucket the whole ping run shares; `putMetric`
 *  normalises it, and every read of `repo_metrics` (`latestMetric` /
 *  `metricSeries` / `latestHealth`) compares that one format as a raw string.
 *
 *  Returns one `PollOutcome` per TARGET (`part` set), in config order — the
 *  cron ignores it; the admin's "Poll now" shows it. `ok` = up; `failed` = down,
 *  its `detail` a few FIXED words (`timeout` / `HTTP <status>` / `unreachable`)
 *  — never the thrown error's text, never a URL. `written` = new rows (0–2).
 *
 *  `bucketMs` is the width `at` is floored to. The cron leaves it at ten
 *  minutes (a double-fired tick is a no-op). The on-demand run passes ONE
 *  SECOND: `putMetric` is first-write-wins, so a reading floored to the cron's
 *  bucket would be dropped and the screen would keep showing the tick's — and
 *  a ONE-MINUTE floor still collided with it for the whole of the tick's own
 *  minute (`:X0:00`–`:X0:59` floors to the tick's `at` either way): a real
 *  "down" shown in the strip was dropped and the pill stayed HEALTHY. A second
 *  lands a NEWER row, which `latestHealth` (the only reader, latest row per
 *  target) picks up. The floor no longer guards a double fire on this path —
 *  the refresh lock does, and more strictly (`REFRESH_LOCK_MS`). Second-stamped
 *  rows read and prune like any other (`at` is one normalised format; pruned at
 *  45 days): a poll every 2 minutes for a day is 720 × 2 rows per target —
 *  5,760 rows for two environments, beside the cron's own 1,152. */
export const HEALTH_ON_DEMAND_BUCKET_MS = 1_000;
export async function pingHealth(ctx: TenantContext, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch, bucketMs: number = TEN_MIN): Promise<PollOutcome[]> {
  const at = new Date(Math.floor(now / bucketMs) * bucketMs).toISOString();
  // A target with no URL configured (an org's environment may name only one of the two, or neither
  // yet) is not pinged and writes no row: an unconfigured target is unknown, never "down".
  const targets = envs.flatMap((cfg) =>
    ([["frontend", cfg.frontendUrl, cfg.frontendUrl], ["backend", cfg.apiUrl, cfg.apiUrl + cfg.healthPath]] as const)
      .filter(([, base]) => base !== "")
      .map(([part, , url]) => ({ env: cfg.key, part, url }))
  );
  const readings = await Promise.all(targets.map(async (t) => {
    const started = Date.now();
    let up = 0;
    let why = "";
    try {
      const res = await fetchImpl(t.url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        headers: { "user-agent": "canopy-health" },
      });
      up = res.ok ? 1 : 0;
      if (!up) why = `HTTP ${res.status}`;
    } catch (e) {
      up = 0; // a thrown fetch (timeout, DNS, connection refused) is "down", never an exception out of the cron
      why = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "unreachable";
    }
    return { ...t, up, why, ms: Date.now() - started };
  }));
  const out: PollOutcome[] = [];
  for (const r of readings) {
    const wrote = [
      await putMetric(ctx, { metric: "health_up", env: r.env, part: r.part, value: r.up, at }),
      await putMetric(ctx, { metric: "health_ms", env: r.env, part: r.part, value: r.ms, at }),
    ].filter(Boolean).length;
    out.push(r.up ? { env: r.env, part: r.part, status: "ok", written: wrote } : { env: r.env, part: r.part, status: "failed", written: wrote, detail: r.why });
  }
  return out;
}

const HOUR = 3_600_000;
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

// ── Sapling active users (source M) ──────────────────────────────────────────
const SAPLING_METRICS_PATH = "/api/internal/metrics";
const SAPLING_RANGES = ["24h", "7d", "30d"] as const;
/** A sanity ceiling, far past any plausible user count — `repo_metrics` is
 *  append-only, so an absurd number written once would be permanent. */
const SAPLING_MAX_USERS = 10_000_000;
const SAPLING_BODY_LOG_CHARS = 80;

/**
 * The three windows of a Sapling metrics body, or the reason it is refused.
 * THE WHOLE RESPONSE OR NOTHING: each of `24h` / `7d` / `30d` must be a JSON
 * number that is a non-negative INTEGER ≤ `SAPLING_MAX_USERS` (a string, a
 * float, a negative, null and a missing key are all refused), AND the windows
 * must nest — `24h ≤ 7d ≤ 30d`, which distinct-users-in-a-trailing-window
 * guarantees by construction. Numbers that contradict each other are not
 * evidence, so one bad window refuses the other two as well. Pure.
 */
function saplingActiveUsers(body: unknown): { values: number[] } | { refused: string } {
  const users = record(body).active_users;
  if (!users || typeof users !== "object" || Array.isArray(users)) return { refused: "no active_users object" };
  const values: number[] = [];
  for (const range of SAPLING_RANGES) {
    const v = (users as Record<string, unknown>)[range];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > SAPLING_MAX_USERS) {
      return { refused: `active_users.${range} is not an integer in 0–${SAPLING_MAX_USERS} (${v === null ? "null" : typeof v})` };
    }
    values.push(v);
  }
  if (values[0] > values[1] || values[1] > values[2]) return { refused: "the windows do not nest (24h ≤ 7d ≤ 30d)" };
  return { values };
}

// ── Sapling product metrics (contract v2) ────────────────────────────────────
// docs/superpowers/specs/2026-09-21-sapling-product-metrics.md §3. The same
// response may ALSO carry `counts` (windowed) and `totals` (point-in-time).
const PRODUCT_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const PRODUCT_MAX_COUNTS = 48;
const PRODUCT_MAX_TOTALS = 24;
/** `repo_metrics` is append-only and first-write-wins: an absurd number written
 *  once is permanent. 1e12 is exactly representable, as is every integer under it. */
const PRODUCT_MAX_VALUE = 1_000_000_000_000;
const PRODUCT_DROPPED_NAMES = 20;
const PRODUCT_NAME_CHARS = 40;

export interface ProductWindows { h24: number; d7: number; d30: number }
export interface SaplingProductMetrics {
  counts: Record<string, ProductWindows>;
  totals: Record<string, number>;
  /** What was refused, BY NAME — `counts.<key>` / `totals.<key>`, or `counts.*` /
   *  `totals.*` when the whole section was ignored. At most 20 names, each cut
   *  to 40 printable characters (a name is another service's text); never a value. */
  dropped: string[];
  /** How many KEYS were refused — `dropped` may name fewer: an ignored section
   *  is ONE name (`counts.*`) but counts every key it held (a section that is
   *  not an object held none to count, so it counts 1). */
  droppedCount: number;
  /** True when the 20-name cap left a refusal unnamed — what earns the note its
   *  trailing "…" (an ignored section is fully named by its one `counts.*`). */
  namesOmitted: boolean;
}

/** A JSON integer in `0..1e12`. `typeof` refuses booleans, strings and null;
 *  `Number.isInteger` refuses floats, NaN and ±Infinity. */
const productInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= PRODUCT_MAX_VALUE;

/**
 * The `counts` / `totals` of a Sapling metrics body, validated PER KEY — one bad
 * key never costs the others, and nothing here depends on `active_users`
 * (which `saplingActiveUsers` judges on its own). A section that is absent is
 * simply empty; one that is present but not a JSON object, or that holds more
 * than 48 / 24 keys (a runaway producer is not evidence), is ignored WHOLE. A
 * key must match `^[a-z][a-z0-9_]{0,39}$`; a `totals` value must be an integer
 * in `0..1e12`; a `counts` value must be an object with EXACTLY the own keys
 * `24h` / `7d` / `30d`, each such an integer, nesting `24h ≤ 7d ≤ 30d`.
 *
 * Pure, and never throws. The key names are another service's text: only OWN
 * enumerable keys are read (`Object.keys`), and the results are
 * prototype-less objects — so a key called `constructor` or `toString` is an
 * ordinary entry, and `__proto__` (which the key pattern refuses anyway) can
 * never reach a prototype.
 *
 * `clean` is the caller's secret-scrub (default: identity, which keeps this
 * pure). It runs on a rejected name BEFORE the name is cut to 40 characters —
 * a scrub matches a WHOLE secret, so cutting first would hand the caller 40
 * characters of a 64-character token that no later scrub could recognise.
 */
export function saplingProductMetrics(body: unknown, clean: (s: string) => string = (s) => s): SaplingProductMetrics {
  const counts = Object.create(null) as Record<string, ProductWindows>;
  const totals = Object.create(null) as Record<string, number>;
  const dropped: string[] = [];
  let droppedCount = 0;
  let namesOmitted = false;
  const drop = (name: string, keys = 1) => {
    droppedCount += keys;
    if (dropped.length < PRODUCT_DROPPED_NAMES) dropped.push(name);
    else namesOmitted = true;
  };
  const printable = (key: string) => clean(key).slice(0, PRODUCT_NAME_CHARS).replace(/[^\x20-\x7e]/g, "?"); // scrubbed BEFORE the cut
  const top = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const section = (name: "counts" | "totals", cap: number, keep: (key: string, v: unknown) => boolean) => {
    if (!Object.hasOwn(top, name) || top[name] === undefined) return;
    const raw = top[name];
    const keys = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : null;
    if (!keys || keys.length > cap) { drop(`${name}.*`, keys ? keys.length : 1); return; } // the whole section, counted by the keys it held
    for (const key of keys) {
      if (!PRODUCT_KEY.test(key) || !keep(key, (raw as Record<string, unknown>)[key])) drop(`${name}.${printable(key)}`);
    }
  };
  section("counts", PRODUCT_MAX_COUNTS, (key, v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const entry = v as Record<string, unknown>;
    const own = Object.keys(entry);
    if (own.length !== SAPLING_RANGES.length || !SAPLING_RANGES.every((r) => Object.hasOwn(entry, r))) return false;
    const [h24, d7, d30] = SAPLING_RANGES.map((r) => entry[r]);
    if (!productInt(h24) || !productInt(d7) || !productInt(d30) || h24 > d7 || d7 > d30) return false;
    counts[key] = { h24, d7, d30 };
    return true;
  });
  section("totals", PRODUCT_MAX_TOTALS, (key, v) => {
    if (!productInt(v)) return false;
    totals[key] = v;
    return true;
  });
  return { counts, totals, dropped, droppedCount, namesOmitted };
}

// ── app metrics contract v3 (docs/superpowers/specs/2026-10-15-app-metrics-v3.md) ──
// The body SAYS what it holds: `version: 3`, optionally the `part` it describes and a `label`, and `groups` —
// each with its own id, label, SHAPE (`ranked` / `stats` / `figure` / `status`), an optional note, and metrics that
// are all windowed (`values: { 24h, 7d, 30d }`) or all point-in-time (`value`). The values are stored exactly as v2
// stores `counts` / `totals` (`sap_c_<key>_<window>` / `sap_t_<key>`); the DESCRIPTION — labels, groups, shapes,
// formats, tones, never a value — is the environment's `app_metrics:<env>` snapshot, so the screen draws whatever a
// new producer reports with no Trov change. v1 and v2 bodies parse exactly as before (they carry no `version`).
export const APP_METRICS_V3_SHAPES = ["ranked", "stats", "figure", "status"] as const;
export type AppMetricsShape = (typeof APP_METRICS_V3_SHAPES)[number];
const V3_GROUP_ID = /^[a-z][a-z0-9_]{0,31}$/;
const V3_MAX_GROUPS = 12;
const V3_MAX_METRICS_PER_GROUP = 24;
const V3_LABEL_CHARS = 60;
const V3_NOTE_CHARS = 160;
/** A label or note: printable text, folded to one line, `1..max` characters after trimming — else null. Another
 *  service's words: they are stored for the screen, which escapes them; nothing here interprets them. */
const v3Text = (v: unknown, max: number, clean: (s: string) => string): string | null => {
  if (typeof v !== "string") return null;
  const s = clean(v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s && s.length <= max ? s : null;
};

/** One metric of a v3 group, as the snapshot keeps it. */
export interface AppMetricsV3Metric { key: string; label: string; format: "int" | "cents"; tone: "bad" | "neutral" | null }
/** One group of a v3 body, as the snapshot keeps it — `window: "now"` = point-in-time values, else windowed. */
export interface AppMetricsV3Group { id: string; label: string; shape: AppMetricsShape; note: string | null; window: "range" | "now"; metrics: AppMetricsV3Metric[] }
/** The `app_metrics:<env>` snapshot: what the last body DESCRIBED (no value), or `{ version: 2 }` after a v1 / v2 body. */
export type AppMetricsDescriptor = { version: 3; part: string | null; label: string | null; groups: AppMetricsV3Group[] } | { version: 2 };
export const APP_METRICS_SNAPSHOT_PREFIX = "app_metrics:";
export const appMetricsSnapshotKind = (envKey: string): string => `${APP_METRICS_SNAPSHOT_PREFIX}${envKey}`;

export interface AppMetricsV3 {
  descriptor: Extract<AppMetricsDescriptor, { version: 3 }>;
  /** The values, in v2's two shapes — stored by the same writer. */
  counts: Record<string, ProductWindows>;
  totals: Record<string, number>;
  /** What was refused, BY NAME (`groups.<id>`, `groups.<id>.<key>`), ≤ 20, each scrubbed before it is cut. */
  dropped: string[];
  droppedCount: number;
}

/**
 * A v3 body's groups, validated PER GROUP and PER METRIC — one bad metric never costs its group, one bad group never
 * the others, and nothing here depends on `active_users`. Pure; never throws. A group is dropped whole when it is not
 * an object, its id is not `^[a-z][a-z0-9_]{0,31}$` (or repeats), its label is not 1–60 printable characters, its
 * shape is not one of the four, it has no metric list, or the body holds more than 12 groups (the ones past 12). A
 * metric is dropped when its key is not v2's key pattern or repeats one already kept anywhere in the body, its label is
 * not 1–60 printable characters, its value is not v2's (a JSON integer in 0..1e12; windows exactly `24h` / `7d` / `30d`,
 * nesting), it is the other kind than the group's first metric, or the group or body caps are full (24 a group; 48
 * windowed and 24 point-in-time keys in the body, counting v2 `counts` / `totals` the caller already kept). A group
 * left with no metric is dropped too.
 */
export function appMetricsV3(body: unknown, clean: (s: string) => string = (s) => s, taken: { counts: number; totals: number; keys: ReadonlySet<string> } = { counts: 0, totals: 0, keys: new Set() }): AppMetricsV3 {
  const top = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const counts = Object.create(null) as Record<string, ProductWindows>;
  const totals = Object.create(null) as Record<string, number>;
  const dropped: string[] = [];
  let droppedCount = 0;
  const drop = (name: string) => { droppedCount++; if (dropped.length < PRODUCT_DROPPED_NAMES) dropped.push(clean(name).slice(0, PRODUCT_NAME_CHARS * 2).replace(/[^\x20-\x7e]/g, "?")); };
  const keys = new Set<string>(taken.keys);
  let nCounts = taken.counts, nTotals = taken.totals;
  const part = typeof top.part === "string" && /^[a-z0-9_-]{1,32}$/.test(top.part) ? top.part : null;
  const label = v3Text(top.label, V3_LABEL_CHARS, clean);
  const groups: AppMetricsV3Group[] = [];
  const raw = Array.isArray(top.groups) ? top.groups : [];
  raw.forEach((g, i) => {
    const o = g && typeof g === "object" && !Array.isArray(g) ? (g as Record<string, unknown>) : null;
    const id = o && typeof o.id === "string" && V3_GROUP_ID.test(o.id) ? o.id : null;
    const name = `groups.${id ?? i}`;
    const glabel = o ? v3Text(o.label, V3_LABEL_CHARS, clean) : null;
    const shape = o && (APP_METRICS_V3_SHAPES as readonly unknown[]).includes(o.shape) ? (o.shape as AppMetricsShape) : null;
    if (!o || !id || groups.some((x) => x.id === id) || !glabel || !shape || !Array.isArray(o.metrics) || groups.length >= V3_MAX_GROUPS) { drop(name); return; }
    const note = v3Text(o.note, V3_NOTE_CHARS, clean);
    let window: "range" | "now" | null = null;
    const metrics: AppMetricsV3Metric[] = [];
    for (const m of o.metrics as unknown[]) {
      const mo = m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
      const key = typeof mo.key === "string" && PRODUCT_KEY.test(mo.key) ? mo.key : null;
      const mname = `${name}.${typeof mo.key === "string" ? mo.key : "?"}`;
      const mlabel = v3Text(mo.label, V3_LABEL_CHARS, clean);
      const kind: "range" | "now" | null = Object.hasOwn(mo, "values") ? "range" : Object.hasOwn(mo, "value") ? "now" : null;
      if (!key || keys.has(key) || !mlabel || !kind || (window && kind !== window) || metrics.length >= V3_MAX_METRICS_PER_GROUP) { drop(mname); continue; }
      if (kind === "range") {
        const v = mo.values;
        const entry = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
        const own = entry ? Object.keys(entry) : [];
        const [h24, d7, d30] = SAPLING_RANGES.map((r) => entry?.[r]);
        if (!entry || own.length !== 3 || !SAPLING_RANGES.every((r) => Object.hasOwn(entry, r)) || !productInt(h24) || !productInt(d7) || !productInt(d30)
          || h24 > d7 || d7 > d30 || nCounts >= PRODUCT_MAX_COUNTS) { drop(mname); continue; }
        counts[key] = { h24, d7, d30 };
        nCounts++;
      } else {
        if (!productInt(mo.value) || nTotals >= PRODUCT_MAX_TOTALS) { drop(mname); continue; }
        totals[key] = mo.value;
        nTotals++;
      }
      window = kind;
      keys.add(key);
      metrics.push({ key, label: mlabel, format: mo.format === "cents" ? "cents" : "int", tone: mo.tone === "bad" || mo.tone === "neutral" ? mo.tone : null });
    }
    if (!metrics.length || !window) { drop(name); return; }
    groups.push({ id, label: glabel, shape, note, window, metrics });
  });
  if (Object.hasOwn(top, "groups") && !Array.isArray(top.groups)) drop("groups.*");
  return { descriptor: { version: 3, part, label, groups }, counts, totals, dropped, droppedCount };
}

/**
 * Hourly `active_users_24h` / `_7d` / `_30d` per environment, `env` = the
 * config key, `part` = "". Trov cannot compute these — only Sapling's
 * database knows who signed in — so each environment's BACKEND is asked:
 * `GET {apiUrl}/api/internal/metrics`, `Authorization: Bearer <token>`, and a
 * `200` carrying `{ "active_users": { "24h": n, "7d": n, "30d": n } }` (the
 * contract: docs/superpowers/specs/2026-09-20-sapling-metrics-endpoint.md).
 *
 * THE TOKEN GOES TO ONE PLACE. The URL is `apiUrl` (trailing slashes dropped)
 * plus the fixed path; an `apiUrl` that is not `https:` is never fetched — a
 * bearer token is not sent in clear — and `redirect: "manual"` plus "only a
 * 200 is an answer" means a 3xx is a failure, never a hop that would carry the
 * header somewhere else. NOTHING here may log the token, a header or the
 * request init: only `cfg.key` and a short message reach the console, and the
 * message is scrubbed of the token in case a failure ever quotes it back. A
 * refused body is quoted to at most 80 characters.
 *
 * `at` is the CURRENT hour's floor, with NO lag and no complete-hours rule —
 * unlike the two pollers above. Those store per-hour sums/averages, where a
 * partial hour written once is permanently short. This is a point-in-time
 * GAUGE the endpoint computes at request time ("distinct users in the trailing
 * 24h, as of now"), so there is no partial-hour problem: the reading is whole
 * the moment it is taken, the hour is only its label, and `INSERT OR IGNORE`
 * keeps the FIRST reading of each hour.
 *
 * Never throws, and returns one `PollOutcome` per environment — a non-https
 * `apiUrl` is `skipped` (still logged, never fetched), every other refusal is
 * `failed`. One request per environment, sequentially (2 today). Anything
 * but a valid 200 — a non-200, a thrown fetch, a body that is not JSON or fails
 * `saplingActiveUsers` — is logged and writes NO `active_users_*` row for that
 * environment this tick; the loop moves on, and Active users reads "not
 * connected" — or, once a reading HAS landed and is over 3 hours old, "no
 * recent reading" (src/tools/repo.ts's `seen`).
 *
 * PRODUCT METRICS (contract v2) ride the SAME response: whatever valid
 * `counts` / `totals` keys it carries (`saplingProductMetrics`, judged per
 * key) are stored as `sap_c_<key>_<24h|7d|30d>` / `sap_t_<key>` gauges — same
 * `env`, `part` = "", same hour-floor `at`, first write of the hour wins — so
 * Sapling can add a metric with no change here. The two halves never cost each
 * other: a v1 body (no `counts` / `totals`) is a plain success, and a body
 * whose `active_users` is REFUSED still has its valid product keys stored —
 * the environment then reads `failed` (the contract's core half failed; the
 * `detail` names that), with `written` the rows that did land. All of one
 * environment's rows go in ONE `putMetrics` call (D1 batches of 50). Dropped
 * keys are logged once per environment, by NAME only, and named in the
 * outcome's `detail` — an `ok`'s ("2 keys dropped: counts.foo, totals.bar")
 * and, appended to the refusal, a `failed`'s. A name is scrubbed BEFORE it is
 * cut (the validator takes this poller's `scrub`).
 */
export async function pollSaplingMetrics(
  ctx: TenantContext, token: string, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch
): Promise<PollOutcome[]> {
  const at = new Date(Math.floor(now / HOUR) * HOUR).toISOString();
  const outcomes: PollOutcome[] = [];
  // Scrubbed BEFORE it is cut: cutting first could leave half a token behind.
  const scrub = (s: string) => (token ? s.split(token).join("[redacted]") : s);
  const excerpt = (s: string) => scrub(s).slice(0, SAPLING_BODY_LOG_CHARS);
  for (const cfg of envs) {
    let fetched = false;
    let written = 0; // NEW rows this environment's one batch wrote — reported even when the poll reads failed
    try {
      const base = cfg.apiUrl.replace(/\/+$/, "");
      let protocol = "";
      try { protocol = new URL(base).protocol; } catch { /* not a URL: refused below */ }
      if (protocol !== "https:") throw new Error("apiUrl is not an https URL — not fetched");
      fetched = true;
      const res = await fetchImpl(base + SAPLING_METRICS_PATH, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        headers: { authorization: `Bearer ${token}`, "user-agent": "canopy-metrics" },
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new Error(`body is not JSON: ${excerpt(text)}`); }
      // Two verdicts on ONE body, neither costing the other: `active_users` is
      // whole-or-nothing, `counts` / `totals` are judged per key. Everything
      // that survives is ONE `putMetrics` call — batches of 50, not a D1
      // round-trip per row (a full v2 body is 171 rows).
      // Contract v3 (`version: 3`): `active_users` becomes optional — absent, nothing is refused; present, it is judged
      // exactly as before — and `groups` describe themselves (`appMetricsV3`). A v1 / v2 body has no `version`.
      const isV3 = record(body).version === 3;
      const usersAbsent = isV3 && !Object.hasOwn(record(body), "active_users");
      const parsed = usersAbsent ? null : saplingActiveUsers(body);
      const product = saplingProductMetrics(body, scrub); // the scrub goes IN: a name is scrubbed before it is cut
      const v3 = isV3 ? appMetricsV3(body, scrub, {
        counts: Object.keys(product.counts).length, totals: Object.keys(product.totals).length,
        keys: new Set([...Object.keys(product.counts), ...Object.keys(product.totals)]),
      }) : null;
      const rows: RepoMetric[] = [];
      const gauge = (metric: string, value: number) => rows.push({ metric, env: cfg.key, part: "", value, at });
      if (parsed && !("refused" in parsed)) for (const [i, range] of SAPLING_RANGES.entries()) gauge(`active_users_${range}`, parsed.values[i]);
      const allCounts = { ...product.counts, ...(v3?.counts ?? {}) };
      const allTotals = { ...product.totals, ...(v3?.totals ?? {}) };
      for (const key of Object.keys(allCounts)) {
        const c = allCounts[key];
        gauge(countMetric(key, "24h"), c.h24);
        gauge(countMetric(key, "7d"), c.d7);
        gauge(countMetric(key, "30d"), c.d30);
      }
      for (const key of Object.keys(allTotals)) gauge(totalMetric(key), allTotals[key]);
      written = await putMetrics(ctx, rows);
      // What the body DESCRIBED (v3) — or, for a v1 / v2 body, no description at all (deleted, a no-op when there is
      // none), so an older description never outlives a producer that went back to v2. A computed write, direct
      // (src/repo/store.ts), like every snapshot.
      if (v3) await putSnapshot(ctx, appMetricsSnapshotKind(cfg.key), v3.descriptor, new Date(now).toISOString());
      else await deleteSnapshot(ctx, appMetricsSnapshotKind(cfg.key));
      // Dropped keys: NAMES only, handed to the outcome. Each name was scrubbed
      // INSIDE the validator, before it was cut to 40 characters — this second
      // scrub is belt and braces, and could not catch a token already cut.
      const droppedCount = product.droppedCount + (v3?.droppedCount ?? 0);
      const allNames = [...product.dropped, ...(v3?.dropped ?? [])];
      const droppedNames = allNames.slice(0, PRODUCT_DROPPED_NAMES);
      const omitted = product.namesOmitted || (v3 !== null && v3.dropped.length < v3.droppedCount) || allNames.length > droppedNames.length;
      const droppedNote = droppedCount
        ? scrub(`${droppedCount} key${droppedCount === 1 ? "" : "s"} dropped: ${droppedNames.join(", ")}${omitted ? ", …" : ""}`).slice(0, 200)
        : "";
      // The contract's core part failing is still a FAILED poll — `written`
      // (kept by the catch below) says what the product half stored anyway, and
      // the refusal carries the dropped note with it: the catch builds the
      // outcome from this message alone, so a note left out here is never seen.
      if (parsed && "refused" in parsed) throw new Error(`${parsed.refused}${droppedNote ? ` · ${droppedNote}` : ""}: ${excerpt(text)}`);
      // Logged once per environment (the refusal above logs it as part of its own line).
      if (droppedNote) console.error("pollSaplingMetrics", cfg.key, droppedNote);
      outcomes.push(okOutcome(cfg.key, written, droppedNote));
    } catch (e) {
      // The message only — never the error object, the request init or a header.
      const message = scrub(e instanceof Error ? e.message : String(e)).slice(0, 200);
      console.error("pollSaplingMetrics", cfg.key, message);
      // Refused BEFORE any request (the only throw above `fetched`) is a
      // configuration gap, not a failed poll.
      outcomes.push(fetched ? failedOutcome(cfg.key, message, written) : skippedOutcome(cfg.key, "apiUrl is not https"));
    }
  }
  return outcomes;
}
