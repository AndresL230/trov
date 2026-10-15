// Cloudflare Workers — ONE Worker script per environment part, read with ONE org-wide API token over
// Cloudflare's REST and GraphQL APIs (`https://api.cloudflare.com/client/v4`, `Authorization: Bearer <token>`).
//
//   credential   an API TOKEN (My Profile › API Tokens › Create Custom Token) with exactly two permissions on
//                ONE account: Account › Account Analytics › Read (the metrics) and Account › Workers Scripts ›
//                Read (the deployments, and the account read in `probe`). Both are read-only. The account's
//                32-hex id is the org config `account_id`. Sent only to api.cloudflare.com.
//   part         ONE Worker script (`worker`, its name as Workers & Pages lists it). Role `web` only.
//   deploys      the Workers Deployments API (documented):
//                  GET /accounts/{account_id}/workers/scripts/{script_name}/deployments
//                → `{ success, errors, result: { deployments: [{ id, created_on, source, strategy, versions:
//                  [{ version_id, percentage }], annotations?: { "workers/message"?, "workers/triggered_by"? },
//                  author_email? }] } }`, "the first deployment in the list is the latest deployment actively
//                serving traffic". A deployment exists only once it serves (Cloudflare has no build state on
//                this route — a Workers Builds build that fails never becomes one), so every deployment is
//                `ready`; a superseded one LANDED, so it stays `ready` (Render's `deactivated` rule). It carries
//                no commit, branch or URL: `sha` / `branch` / `url` are null. UNCONFIRMED: that `created_on` /
//                `author_email` / `annotations` are spelled and nested exactly as the API reference shows, and
//                the dashboard path the inspect link opens (`…/workers/services/view/<worker>/production/
//                deployments`). No `per_page` is sent: the newest 20 are kept from whatever the first page holds.
//   metrics      the GraphQL Analytics API (`POST /client/v4/graphql`), `workersInvocationsAdaptive` filtered
//                to the account and the script, `sum { requests errors }` grouped by `datetimeHour` — the
//                query the old `:00` usage poller ran (src/repo/poll.ts `pollCloudflare`), over `pollWindow(now)`
//                instead of its one-hour lag. `datetime_leq` is INCLUSIVE, so the bucket AT the window's end can
//                come back and is dropped, as is anything outside the window. `errors` are invocations that
//                ended in an error (an uncaught exception, exceeded limits) — Cloudflare's count, filed as the
//                vocabulary's server errors. A quiet hour has NO row (the dataset groups invocations), so the
//                window is `covered` whenever Cloudflare answered for the account — even with zero rows: inside
//                it, an hour with no point is a true zero. An answer naming NO account (a wrong Account ID, a
//                token that cannot see it) is a failure, never "polled and found quiet". Latency and bandwidth
//                are not read (`unavailable`, fixed reasons).
//   probe        without a part: `GET /accounts/{account_id}` (documented; Workers Scripts Read is one of the
//                permissions it accepts — so it proves the token, the account AND the deploy permission) and
//                one account-wide analytics query over the window's last hour (Account Analytics Read). Not
//                `/user/tokens/verify`: that answers only for a USER-owned token, and proves no permission. With
//                a part: the script's deployments (Workers Scripts Read + the Worker exists) and the same
//                one-hour analytics query for that script. TWO fetches either way.
//   commit       the Workers Builds API (repo setups, Phase A; step 0 CONFIRMED the data — a build carries
//                `build_trigger_metadata.commit_hash` / `.branch`): ONE `GET /accounts/{account_id}/builds/builds?
//                version_ids=<id>` for the NEWEST deployment's version (the one at 100 %), and its commit and branch
//                when EXACTLY ONE build with a commit answers. It needs the token's optional third permission,
//                Workers CI Read (Workers Builds Configuration), on a USER token; refused (401 / 403 / an auth
//                error) the poll notes "commit: the token needs Workers CI Read" and the commit is left to the
//                GitHub join (src/hosting/sha-join.ts) — never a guess, and never a failed poll. UNCONFIRMED: the
//                response's exact nesting (`result.builds` keyed by version id, or a list) — both are read; that
//                Read (not Edit) suffices.
//   outcomes     (repo setups, Phase G) the SAME analytics query groups by `status` too and sums `subrequests`:
//                `status` is the invocation OUTCOME (`success`, `clientDisconnected`, `scriptThrewException`,
//                `exceededResources`, … — step 0 CONFIRMED it is not an HTTP status), so each (hour, outcome) is stored
//                as its own hourly `hx_outcome_<status>` point and requests / errors are the hour's sums over them.
//                No 4xx / 5xx split exists in this dataset and none is invented. `hx_subrequests` per hour beside them.
//   schedules    ONE more GraphQL query: `workersInvocationsScheduled` (step 0 CONFIRMED: per-run rows with `cron`,
//                `status`, `datetime`, `cpuTimeUs`) for the script over the same window — per (hour, cron) the runs,
//                the runs whose status is not `success`, and the epoch ms of the hour's last run. A refusal or an
//                answer with no row list is the family's reason, never a failed poll. UNCONFIRMED: the filter's
//                field names (`datetime_geq` / `datetime_leq`, as on the adaptive datasets).
//   daily        once a day, for the completed UTC day the framework names (`pc.daily`, ../poll.ts): the day's
//                quantiles — `workersInvocationsAdaptive(…) { quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 } }`,
//                step 0 CONFIRMED the fields, µs — stored as daily points with the `hx_daily_read` marker (so a day
//                with no traffic is not asked again), and, when the part names D1 databases (its `d1_database_ids`
//                setting — the repo scan's wrangler detector fills it on accept), ONE query of
//                `d1AnalyticsAdaptiveGroups` (read / write queries, rows read / written) and `d1StorageAdaptiveGroups`
//                (`max { databaseSizeBytes }`) for the first 3 of them — step 0 CONFIRMED both with Account Analytics
//                Read. UNCONFIRMED: the `datetime_lt` filter, the `Date` variable type of the D1 filters. A part with
//                no D1 id says so (`storage`: "no D1 database is named for this part"), never zero.
//   one poll     deployments (1) + the newest deployment's build (1) + analytics (1) + scheduled runs (1) + on the
//                day's first poll the quantiles (1) and D1 (1) = 6 (`pollCost`).
//
// Every message is scrubbed of the token — and of the account id, as the old poller did: Cloudflare's own
// errors can name the account they refused — BEFORE it is cut (../http.ts). Nothing is logged here.
import type { HostingMetric } from "@shared/hosting";
import {
  CRON_EXPR_RE, D1_ID_RE, DAILY_READ_METRIC, OUTCOME_STATUS_RE, RUNTIME_DAILY, SUBREQUESTS_METRIC, cronMetric, d1Metric, outcomeMetric,
  type ExtraFamily,
} from "@shared/usage-families-core";
import type { HostingDeploy, HostingPoint, HostingProvider, PartRef, PollResult, ProbeResult, ProviderContext } from "../types";
import {
  HOUR, HostingError, type Revealed, asHostingError, instant, iso, pollWindow, probeFailure, readJson, record, refuse, sane, scrub, str,
} from "../http";

const API = "https://api.cloudflare.com/client/v4";
const GRAPHQL = `${API}/graphql`;
const DASHBOARD = "https://dash.cloudflare.com";
const UA = "trov-hosting";

const ACCOUNT_ID = /^[0-9a-fA-F]{32}$/;
const WORKER = /^[A-Za-z0-9_-]{1,63}$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9-]{1,64}$/;
const VERSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const SHA = /^[0-9a-f]{7,64}$/i;
const PLAIN_LINE = /^[^\u0000-\u001f\u007f]{1,200}$/;
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
/** Up to five D1 ids, comma-separated (a space allowed after a comma) — 5 × 36 + separators stays under the 200-character field limit. */
const D1_IDS = new RegExp(`^${UUID}(?:, ?${UUID}){0,4}$`);
/** Up to ten cron expressions of cron characters, `;`-separated. */
const CRONS = /^[0-9A-Za-z*/,?#\- ]{1,80}(?:;[0-9A-Za-z*/,?#\- ]{1,80}){0,9}$/;

/** Deployments kept per poll — the contract's "≤ 20, newest first". */
const DEPLOY_LIMIT = 20;

/** Cloudflare's schema spells its scalar `string`, LOWERCASE — `String!` is rejected as an unknown type.
 *  `Time` is theirs too. `limit: 100` is far more than the ≤ 4 hourly groups one Worker returns for the
 *  window (three hours, `datetime_leq` inclusive). The old poller's query, unchanged. */
const ANALYTICS_QUERY = `query($a: string!, $s: string!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $a }) {
    workersInvocationsAdaptive(limit: 200, filter: { scriptName: $s, datetime_geq: $from, datetime_leq: $to }, orderBy: [datetimeHour_ASC]) {
      dimensions { datetimeHour status }
      sum { requests errors subrequests }
    }
  } }
}`;

/** The script's cron runs over the window — per-run rows (step 0). 1000 rows is a cron every minute for 16 hours;
 *  an answer that FILLS the limit may be cut short, so it is not stored (the family says why). */
const SCHEDULED_LIMIT = 1000;
const SCHEDULED_QUERY = `query($a: string!, $s: string!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $a }) {
    workersInvocationsScheduled(limit: ${SCHEDULED_LIMIT}, filter: { scriptName: $s, datetime_geq: $from, datetime_leq: $to }) {
      cron status datetime
    }
  } }
}`;

/** The completed day's quantiles for the script — one row (`date` = the day), or none on a day with no invocation. */
const RUNTIME_QUERY = `query($a: string!, $s: string!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $a }) {
    workersInvocationsAdaptive(limit: 10, filter: { scriptName: $s, datetime_geq: $from, datetime_lt: $to }) {
      dimensions { date }
      quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 }
    }
  } }
}`;

/** D1 for up to `D1_PER_POLL` databases, one alias pair each — the query text names only aliases and variables. */
const D1_PER_POLL = 3;
function d1Query(n: number): string {
  const vars = Array.from({ length: n }, (_, i) => `$d${i}: string!`).join(", ");
  const fields = Array.from({ length: n }, (_, i) => `
    q${i}: d1AnalyticsAdaptiveGroups(limit: 10, filter: { databaseId: $d${i}, date_geq: $day, date_leq: $day }) {
      dimensions { date }
      sum { readQueries writeQueries rowsRead rowsWritten }
    }
    s${i}: d1StorageAdaptiveGroups(limit: 10, filter: { databaseId: $d${i}, date_geq: $day, date_leq: $day }) {
      dimensions { date }
      max { databaseSizeBytes }
    }`).join("");
  return `query($a: string!, $day: Date!, ${vars}) {
  viewer { accounts(filter: { accountTag: $a }) {${fields}
  } }
}`;
}

/** `probe` without a part: the same dataset for the whole account, one row at most. */
const ACCOUNT_PROBE_QUERY = `query($a: string!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $a }) {
    workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $from, datetime_leq: $to }) {
      sum { requests }
    }
  } }
}`;

const WEB_UNAVAILABLE: readonly { metric: HostingMetric; reason: string }[] = [
  { metric: "latency_p50_ms", reason: "Cloudflare's Workers analytics report CPU and wall time per invocation, not HTTP response latency" },
  { metric: "latency_p95_ms", reason: "Cloudflare's Workers analytics report CPU and wall time per invocation, not HTTP response latency" },
  { metric: "bandwidth_bytes", reason: "Trov reads requests and errors only from Cloudflare's Workers analytics" },
];

// ── the credential and the settings ──────────────────────────────────────────

interface CfAuth {
  header: string;
  /** Everything a refusal could quote back: the token, its header, and the account id. */
  revealed: Revealed;
  account: string;
}

/** The header and the account, re-checked here although the framework validated the config: neither ever
 *  reaches a URL or a header unless it is in its expected form. */
function cfAuth(pc: ProviderContext): CfAuth {
  const stored = pc.credential.secret.reveal();
  const token = stored.trim().replace(/^bearer\s+/i, "");
  const account = pc.credential.config.account_id;
  // A header value cannot carry whitespace inside a token or a control character; refuse in fixed words
  // rather than let `fetch` throw on it (or send half of it).
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new HostingError("the Cloudflare API token is not in the expected form — paste the token itself, without quotes or spaces", [stored, token]);
  }
  if (!account || !ACCOUNT_ID.test(account)) throw new HostingError("the Cloudflare Account ID is not set — Workers & Pages › Overview shows it");
  const header = `Bearer ${token}`;
  return { header, revealed: [pc.credential.secret, stored, token, header, account], account };
}

function workerName(part: PartRef): string {
  const w = part.settings.worker;
  if (!w || !WORKER.test(w)) throw new HostingError("the part's Worker name is not set or not in the expected form");
  return w;
}

/** Upstream text for a message or a field: scrubbed FIRST, control characters and runs of whitespace
 *  folded, THEN cut. null when nothing is left. */
function upstream(v: unknown, revealed: Revealed, max: number): string | null {
  if (typeof v !== "string") return null;
  const text = scrub(v, revealed).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return text || null;
}

// ── requests ─────────────────────────────────────────────────────────────────

/** Cloudflare answers 400 when the Authorization value is not token-shaped at all, 401 when it is
 *  token-shaped but wrong, 403 when the token is real but lacks the permission (the old poller's hints). */
const MALFORMED = "the token value is malformed (quotes, spaces, or not an API token)";
const NOT_VALID = "the token is not valid — create a new one under My Profile › API Tokens";
const ANALYTICS_HINTS = { 400: MALFORMED, 401: NOT_VALID, 403: "the token lacks Account Analytics: Read on this account" };
const SCRIPTS_HINTS = {
  400: MALFORMED, 401: NOT_VALID, 403: "the token lacks Workers Scripts: Read on this account",
  404: "no Worker by that name on this account (check the Worker name and the Account ID)",
};
const BUILDS_HINTS = {
  400: MALFORMED, 401: "the token cannot read Workers Builds — it needs Workers CI Read (a user token)", 403: "the token lacks Workers CI Read on this account",
};
/** What a poll notes when the Builds API refuses the token (the commit is then left to the GitHub join). */
export const COMMIT_NEEDS_CI_READ = "commit: the token needs Workers CI Read";
/** …and when it fails some other way. */
export const COMMIT_UNREAD = "commit: Workers Builds did not answer — the commit is joined from GitHub when it can be";
const ACCOUNT_HINTS = { 400: MALFORMED, 401: NOT_VALID, 403: "the token cannot read this account — it needs Workers Scripts: Read on it", 404: "no account with that ID that the token can see" };

/** One request through the fixed-host fetch → parsed JSON. A non-2xx is a scrubbed refusal; anything thrown
 *  is a `HostingError` whose message never quotes the request. */
async function cfRequest(
  pc: ProviderContext, auth: CfAuth, url: string, what: string, hints: Readonly<Record<number, string>>, body?: unknown,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await pc.fetch(url, body === undefined
      ? { method: "GET", headers: { authorization: auth.header, accept: "application/json", "user-agent": UA } }
      : { method: "POST", headers: { authorization: auth.header, accept: "application/json", "content-type": "application/json", "user-agent": UA }, body: JSON.stringify(body) });
  } catch (e) { throw asHostingError(what, e); }
  if (!res.ok) await refuse(what, res, auth.revealed, hints);
  let parsed: unknown;
  try { parsed = await readJson(res, what); } catch (e) { throw asHostingError(what, e); }
  const out = record(parsed);
  // Both APIs report a failure beside a 200 as a non-empty `errors` array (the REST envelope also says
  // `success: false`). `data` / `result` beside it is never read. Scrubbed BEFORE the cut (HostingError).
  if (Array.isArray(out.errors) && out.errors.length) {
    throw new HostingError(`${what}: ${upstream(record(out.errors[0]).message, auth.revealed, 200) ?? "the request was refused"}`, auth.revealed);
  }
  if (out.success === false) throw new HostingError(`${what}: the request was refused`);
  return out;
}

// ── metrics ──────────────────────────────────────────────────────────────────

/** The `workersInvocationsAdaptive` rows of a GraphQL answer — or a failure when it names no account. */
function analyticsRows(body: Record<string, unknown>, what: string): unknown[] {
  const accounts = record(record(body.data).viewer).accounts;
  const rows = Array.isArray(accounts) ? record(accounts[0]).workersInvocationsAdaptive : null;
  if (!Array.isArray(rows)) {
    throw new HostingError(`${what}: Cloudflare answered for no account — check the Account ID, and that the token has Account Analytics: Read on it`);
  }
  return rows;
}

/** One analytics read of `worker` over [from, to] (Cloudflare's `datetime_leq` is inclusive). */
async function readAnalytics(pc: ProviderContext, auth: CfAuth, worker: string, from: number, to: number, what: string): Promise<unknown[]> {
  const body = await cfRequest(pc, auth, GRAPHQL, what, ANALYTICS_HINTS, {
    query: ANALYTICS_QUERY, variables: { a: auth.account, s: worker, from: iso(from), to: iso(to) },
  });
  return analyticsRows(body, what);
}

/** Ceilings far past anything real — a stored point is permanent (first write wins). */
const MAX_COUNT = 1e12;

type ExtraPoint = { metric: string; at: string; value: number };

/**
 * Rows → points: `requests` and `errors` for each hour of `[from, to)`, summed over the hour's rows (one per
 * invocation outcome), and — Phase G — each outcome's requests as `hx_outcome_<status>` and the hour's subrequests.
 * A row outside the window, the row AT `to` (the inclusive end), and a malformed one (an unparseable hour, a count
 * that is not a finite number ≥ 0) are skipped on their own — never repaired, never aborting the rows after them.
 * A row with no readable `status` still counts toward the hour's requests and errors, and toward no outcome; a
 * missing `subrequests` is simply not stored for that row's hour (never a zero).
 */
function hourPoints(rows: unknown[], from: number, to: number): { points: HostingPoint[]; extra: ExtraPoint[] } {
  const hours = new Map<number, { requests: number; errors: number; sub: number | null; outcomes: Map<string, number> }>();
  for (const row of rows) {
    const r = record(row);
    const dims = record(r.dimensions);
    const hour = dims.datetimeHour;
    const at = typeof hour === "string" ? Date.parse(hour) : Number.NaN;
    const sum = record(r.sum);
    const requests = typeof sum.requests === "number" ? sane(sum.requests, MAX_COUNT) : null;
    const errors = typeof sum.errors === "number" ? sane(sum.errors, MAX_COUNT) : null;
    if (!Number.isFinite(at) || at % HOUR !== 0 || at < from || at >= to || requests === null || errors === null) continue;
    const held = hours.get(at) ?? { requests: 0, errors: 0, sub: null, outcomes: new Map<string, number>() };
    held.requests += Math.round(requests);
    held.errors += Math.round(errors);
    const sub = typeof sum.subrequests === "number" ? sane(sum.subrequests, MAX_COUNT) : null;
    if (sub !== null) held.sub = (held.sub ?? 0) + Math.round(sub);
    const status = typeof dims.status === "string" ? dims.status : null;
    if (status && OUTCOME_STATUS_RE.test(status)) held.outcomes.set(status, (held.outcomes.get(status) ?? 0) + Math.round(requests));
    hours.set(at, held);
  }
  const sorted = [...hours].sort((a, b) => a[0] - b[0]);
  const extra: ExtraPoint[] = [];
  for (const [at, v] of sorted) {
    for (const [status, n] of v.outcomes) extra.push({ metric: outcomeMetric(status), at: iso(at), value: n });
    if (v.sub !== null) extra.push({ metric: SUBREQUESTS_METRIC, at: iso(at), value: v.sub });
  }
  return {
    points: [
      ...sorted.map(([at, v]): HostingPoint => ({ metric: "requests", at: iso(at), value: v.requests })),
      ...sorted.map(([at, v]): HostingPoint => ({ metric: "errors", at: iso(at), value: v.errors })),
    ],
    extra,
  };
}

/** The `<dataset>` list of a GraphQL answer for the account — or a failure when it names no account. */
function datasetRows(body: Record<string, unknown>, dataset: string, what: string): unknown[] {
  const accounts = record(record(body.data).viewer).accounts;
  const rows = Array.isArray(accounts) ? record(accounts[0])[dataset] : null;
  if (!Array.isArray(rows)) throw new HostingError(`${what}: Cloudflare answered with no ${dataset} list`);
  return rows;
}

/**
 * Cron runs → hourly points per (hour, cron): `runs`, `failed` (a status other than `success`) and `last` (the epoch
 * ms of the hour's newest run). A run outside `[from, to)`, with an expression that is not a cron or an unparseable
 * time, is skipped on its own.
 */
function cronPoints(rows: unknown[], from: number, to: number): ExtraPoint[] {
  const cells = new Map<string, { at: number; cron: string; runs: number; failed: number; last: number }>();
  for (const row of rows) {
    const r = record(row);
    const cron = typeof r.cron === "string" ? r.cron.trim() : "";
    const t = typeof r.datetime === "string" ? Date.parse(r.datetime) : Number.NaN;
    if (!cron || cron.length > 80 || !CRON_EXPR_RE.test(cron) || !Number.isFinite(t) || t < from || t >= to) continue;
    const at = Math.floor(t / HOUR) * HOUR;
    const key = `${at}|${cron}`;
    const cell = cells.get(key) ?? { at, cron, runs: 0, failed: 0, last: 0 };
    cell.runs++;
    if (r.status !== "success") cell.failed++;
    cell.last = Math.max(cell.last, t);
    cells.set(key, cell);
  }
  return [...cells.values()].sort((a, b) => a.at - b.at || (a.cron < b.cron ? -1 : 1)).flatMap((c) => [
    { metric: cronMetric("runs", c.cron), at: iso(c.at), value: c.runs },
    { metric: cronMetric("failed", c.cron), at: iso(c.at), value: c.failed },
    { metric: cronMetric("last", c.cron), at: iso(c.at), value: c.last },
  ]);
}

const DAY = 24 * HOUR;
/** A day's quantile in µs, sane (an hour of CPU at most) — else null. */
const micros = (v: unknown): number | null => (typeof v === "number" ? sane(v, 3_600_000_000) : null);

/** The completed day's quantiles → daily points, plus the `hx_daily_read` marker (the day was read, with or without a row). */
function runtimePoints(rows: unknown[], day: string, dayStart: number): ExtraPoint[] {
  const at = iso(dayStart);
  const out: ExtraPoint[] = [{ metric: DAILY_READ_METRIC, at, value: 1 }];
  const row = rows.map(record).find((r) => record(r.dimensions).date === day);
  if (!row) return out;
  const q = record(row.quantiles);
  const pick: [string, unknown][] = [[RUNTIME_DAILY.cpu_p50, q.cpuTimeP50], [RUNTIME_DAILY.cpu_p99, q.cpuTimeP99], [RUNTIME_DAILY.wall_p50, q.wallTimeP50]];
  for (const [metric, v] of pick) {
    const n = micros(v);
    if (n !== null) out.push({ metric, at, value: Math.round(n) });
  }
  return out;
}

/** The D1 answer → daily points per database: the day's sums and its size. A database whose rows are not that day's
 *  (or malformed) stores nothing — absent, never zero. */
function d1Points(body: Record<string, unknown>, ids: string[], day: string, dayStart: number): ExtraPoint[] {
  const accounts = record(record(body.data).viewer).accounts;
  const account = Array.isArray(accounts) && accounts.length ? record(accounts[0]) : null;
  if (!account) throw new HostingError("cloudflare d1: Cloudflare answered for no account");
  const at = iso(dayStart);
  const out: ExtraPoint[] = [];
  const ofDay = (v: unknown): Record<string, unknown> | undefined =>
    Array.isArray(v) ? v.map(record).find((r) => record(r.dimensions).date === day) : undefined;
  ids.forEach((id, i) => {
    const q = ofDay(account[`q${i}`]);
    if (q) {
      const sum = record(q.sum);
      const fields: [Parameters<typeof d1Metric>[0], unknown][] = [["read_queries", sum.readQueries], ["write_queries", sum.writeQueries], ["rows_read", sum.rowsRead], ["rows_written", sum.rowsWritten]];
      for (const [field, v] of fields) {
        const n = typeof v === "number" ? sane(v, MAX_COUNT) : null;
        if (n !== null) out.push({ metric: d1Metric(field, id), at, value: Math.round(n) });
      }
    }
    const st = ofDay(account[`s${i}`]);
    const size = st ? record(st.max).databaseSizeBytes : undefined;
    const n = typeof size === "number" ? sane(size, 1e13) : null;
    if (n !== null) out.push({ metric: d1Metric("size_bytes", id), at, value: Math.round(n) });
  });
  return out;
}

/** The part's D1 database ids (its `d1_database_ids` setting, comma-separated), each a UUID — at most `D1_PER_POLL` read. */
function d1Ids(part: PartRef): string[] {
  return [...new Set((part.settings.d1_database_ids ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => D1_ID_RE.test(x)))];
}

/** A family's reason from a thrown read: the error's own (already scrubbed) words, else fixed text. */
const familyReason = (prefix: string, e: unknown): string =>
  `${prefix}: ${e instanceof HostingError ? e.message.replace(/^cloudflare [a-z0-9 ]+: /i, "") : "the request failed"}`.slice(0, 200);

/** What `storage` says for a part that names no D1 database — every poll, with no request. */
export const NO_D1_DATABASE = "no D1 database is named for this part — set its D1 database ids (the repo scan fills them from wrangler)";

// ── deploys ──────────────────────────────────────────────────────────────────

/** The dashboard's deployments page of the Worker. UNCONFIRMED path (see the header). */
const deploymentsPage = (account: string, worker: string): string =>
  `${DASHBOARD}/${encodeURIComponent(account)}/workers/services/view/${encodeURIComponent(worker)}/production/deployments`;

/** One deployment → a `HostingDeploy`, or null when it is malformed (no id, no parseable `created_on`). */
function deployOf(raw: unknown, auth: CfAuth, worker: string): HostingDeploy | null {
  const d = record(raw);
  const id = str(d.id);
  const createdAt = instant(d.created_on);
  if (!id || !DEPLOYMENT_ID.test(id) || !createdAt) return null;
  const note = record(d.annotations)["workers/message"];
  const message = typeof note === "string" ? upstream(note.split(/\r?\n/, 1)[0], auth.revealed, 300) : null;
  const who = str(d.author_email);
  return {
    id,
    state: "ready", // a deployment exists only once it serves; a superseded one landed (see the header)
    target: "production", // one Worker per environment part
    sha: null,
    branch: null,
    message,
    by: who && PLAIN_LINE.test(who) ? who : null,
    createdAt,
    readyAt: null, // the route reports no finish time
    url: null,
    inspectUrl: deploymentsPage(auth.account, worker),
  };
}

/** The version a deployment serves WHOLLY: its only version, or the one at 100 % — else null (a split rollout
 *  serves two commits; neither is "the" deploy's). */
function servedVersion(raw: unknown): string | null {
  const versions = record(raw).versions;
  if (!Array.isArray(versions)) return null;
  const whole = versions.length === 1 ? versions[0] : versions.find((v) => record(v).percentage === 100);
  const id = str(record(whole).version_id);
  return id && VERSION_ID.test(id) ? id : null;
}

/** The commit of the build that produced `version` — exactly ONE build with a commit, else null. */
async function readBuildCommit(pc: ProviderContext, auth: CfAuth, version: string): Promise<{ sha: string; branch: string | null } | null> {
  const url = `${API}/accounts/${encodeURIComponent(auth.account)}/builds/builds?version_ids=${encodeURIComponent(version)}`;
  const body = await cfRequest(pc, auth, url, "cloudflare builds", BUILDS_HINTS);
  const result = body.result;
  let builds: unknown[] = [];
  if (Array.isArray(result)) builds = result;
  else {
    const held = record(result).builds;
    if (Array.isArray(held)) builds = held;
    else if (held && typeof held === "object") builds = [record(held)[version]].filter((b) => b !== undefined);
  }
  const commits = builds
    .map((b) => { const m = record(record(b).build_trigger_metadata); return { sha: str(m.commit_hash), branch: str(m.branch) }; })
    .filter((c): c is { sha: string; branch: string | null } => !!c.sha && SHA.test(c.sha));
  const distinct = [...new Set(commits.map((c) => c.sha.toLowerCase()))];
  if (distinct.length !== 1) return null;
  const branch = commits[0].branch;
  return { sha: distinct[0], branch: branch && PLAIN_LINE.test(branch) ? branch : null };
}

/** The script's deployments → its newest ≤ 20, newest first. A body with no deployments list is refused. */
async function readDeployments(pc: ProviderContext, auth: CfAuth, worker: string): Promise<HostingDeploy[]> {
  return (await readDeploymentsWithVersions(pc, auth, worker)).deploys;
}

/** …with the version each one serves wholly (`servedVersion`), by deploy id. */
async function readDeploymentsWithVersions(pc: ProviderContext, auth: CfAuth, worker: string): Promise<{ deploys: HostingDeploy[]; versions: Map<string, string> }> {
  const url = `${API}/accounts/${encodeURIComponent(auth.account)}/workers/scripts/${encodeURIComponent(worker)}/deployments`;
  const body = await cfRequest(pc, auth, url, "cloudflare deployments", SCRIPTS_HINTS);
  const list = record(body.result).deployments;
  if (!Array.isArray(list)) throw new HostingError("cloudflare deployments: the response has no deployments list");
  const seen = new Set<string>();
  const deploys: HostingDeploy[] = [];
  const versions = new Map<string, string>();
  for (const raw of list) {
    const d = deployOf(raw, auth, worker);
    if (d && !seen.has(d.id)) {
      seen.add(d.id); deploys.push(d);
      const v = servedVersion(raw);
      if (v) versions.set(d.id, v);
    }
  }
  // A stable sort: two deployments of one instant keep Cloudflare's order (its first is the live one).
  return { deploys: deploys.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, DEPLOY_LIMIT), versions };
}

// ── the provider ─────────────────────────────────────────────────────────────

export const cloudflare: HostingProvider = {
  id: "cloudflare",
  label: "Cloudflare Workers",
  status: "available",
  summary: "A Cloudflare Worker. Trov reads its deploys, requests and errors.",
  roles: ["web"],
  apiHosts: ["api.cloudflare.com"],
  docsUrl: "https://developers.cloudflare.com/analytics/graphql-api/",
  connectionMethods: [
    {
      method: "token",
      label: "Paste an API token",
      howTo: "1. In the Cloudflare dashboard, open My Profile › API Tokens › Create Token › Create Custom Token.\n2. Add two permissions, both read-only: Account › Account Analytics › Read, and Account › Workers Scripts › Read.\n3. Optional, for the commit behind each deploy: also add Account › Workers CI › Read (Workers Builds). Without it Trov finds the commit from GitHub when it can.\n4. Under Account Resources, pick only the account your Workers live under.\n5. Paste the token here, and set Account ID to that account's 32-character id (Workers & Pages › Overview).\nThe token is only ever sent to api.cloudflare.com.",
      grants: ["Account Analytics: Read on one account", "Workers Scripts: Read on that account (its Workers' deployments)", "Optional — Workers CI: Read (the commit each deploy was built from)"],
    },
  ],
  orgConfigFields: [
    { key: "account_id", label: "Account ID", description: "The 32-character id of the Cloudflare account the Workers live under. Not a secret.", required: true, placeholder: "0123456789abcdef0123456789abcdef", pattern: ACCOUNT_ID },
  ],
  partSettings: [
    { key: "worker", label: "Worker name", description: "The Worker script's name, as Workers & Pages lists it.", required: true, placeholder: "frontend-staging", pattern: WORKER },
    // Repo setups, Phase G: the D1 databases and cron triggers the Usage tab reads for this Worker. The repo scan's
    // wrangler detector proposes both (its `d1_databases[].database_id` and `triggers.crons`); an admin may edit them.
    { key: "d1_database_ids", label: "D1 database ids", description: "Optional. The ids of the D1 databases this Worker binds (wrangler's d1_databases), comma-separated — up to 5; the first 3 are read.", required: false, placeholder: "6c71838c-18f7-4f68-8513-b58e86c237b9", pattern: D1_IDS },
    { key: "crons", label: "Cron triggers", description: "Optional. The Worker's cron expressions (wrangler's triggers.crons), separated by ;. Runs are read either way; a listed cron that never ran in a range reads as none.", required: false, placeholder: "*/10 * * * *;0 13 * * *", pattern: CRONS },
  ],
  capabilities: { deploys: true, metrics: ["requests", "errors"], families: ["outcomes", "runtime", "storage", "schedules"] },
  planNote: null,
  // Deployments (1) + the newest deployment's build (1) + analytics (1) + scheduled runs (1) + once a day the
  // quantiles (1) and D1 (1).
  pollCost: 6,
  // A pasted API token is managed (and rolled or deleted) under My Profile › API Tokens.
  manageUrl(_config, method) {
    return method === "token" ? `${DASHBOARD}/profile/api-tokens` : null;
  },
  consoleUrl(part, config) {
    const account = config.account_id, worker = part.settings.worker;
    return account && ACCOUNT_ID.test(account) && worker && WORKER.test(worker)
      ? `${DASHBOARD}/${encodeURIComponent(account)}/workers/services/view/${encodeURIComponent(worker)}/production`
      : null;
  },

  async probe(pc: ProviderContext, part: PartRef | null): Promise<ProbeResult> {
    try {
      const auth = cfAuth(pc);
      const { to } = pollWindow(pc.now);
      const from = to - HOUR;
      if (!part) {
        const account = record((await cfRequest(pc, auth, `${API}/accounts/${encodeURIComponent(auth.account)}`, "cloudflare account", ACCOUNT_HINTS)).result);
        const body = await cfRequest(pc, auth, GRAPHQL, "cloudflare analytics", ANALYTICS_HINTS, {
          query: ACCOUNT_PROBE_QUERY, variables: { a: auth.account, from: iso(from), to: iso(to) },
        });
        analyticsRows(body, "cloudflare analytics");
        const name = upstream(account.name, auth.revealed, 80);
        return { ok: true, detail: name ? `Cloudflare answered for account ${name}.` : "Cloudflare answered for the account." };
      }
      const worker = workerName(part);
      const deploys = await readDeployments(pc, auth, worker);
      await readAnalytics(pc, auth, worker, from, to, "cloudflare analytics");
      return { ok: true, detail: deploys.length ? `Cloudflare answered for Worker ${worker}.` : `Cloudflare answered for Worker ${worker} (no deployments yet).` };
    } catch (e) {
      return probeFailure("cloudflare", e);
    }
  },

  async poll(pc: ProviderContext, part: PartRef): Promise<PollResult> {
    const auth = cfAuth(pc);
    const worker = workerName(part);
    // A token made before deploys were read here has Account Analytics but not Workers Scripts: Cloudflare refuses
    // the deployments list with a 403 (UNCONFIRMED: 403, not 401, is what a missing permission answers). Its traffic
    // is still read — the part shows no deploys until the token gains the permission; any other failure fails the poll.
    let deploys: HostingDeploy[] = [];
    let versions = new Map<string, string>();
    try {
      ({ deploys, versions } = await readDeploymentsWithVersions(pc, auth, worker));
    } catch (e) {
      if (!(e instanceof HostingError && e.status === 403)) throw e;
    }
    // The NEWEST deployment's commit, from the build that made its version (one request). Refused or failing, it is
    // noted and left to the GitHub join — the poll itself never fails for it.
    const notes: string[] = [];
    const newest = deploys[0];
    const version = newest ? versions.get(newest.id) : undefined;
    if (newest && version) {
      try {
        const commit = await readBuildCommit(pc, auth, version);
        if (commit) { newest.sha = commit.sha; newest.branch = commit.branch; }
      } catch (e) {
        const refused = e instanceof HostingError && (e.status === 401 || e.status === 403 || (e.status === undefined && /authentication|forbidden|permission/i.test(e.message)));
        notes.push(refused ? COMMIT_NEEDS_CI_READ : COMMIT_UNREAD);
      }
    }
    const { from, to } = pollWindow(pc.now);
    const rows = await readAnalytics(pc, auth, worker, from, to, "cloudflare analytics");
    const hourly = hourPoints(rows, from, to);
    const extra: ExtraPoint[] = [...hourly.extra];
    const families: { family: ExtraFamily; reason: string | null }[] = [{ family: "outcomes", reason: null }];

    // Scheduled runs over the same window: ONE query; its failure is the family's reason, never the poll's.
    try {
      const body = await cfRequest(pc, auth, GRAPHQL, "cloudflare schedules", ANALYTICS_HINTS, {
        query: SCHEDULED_QUERY, variables: { a: auth.account, s: worker, from: iso(from), to: iso(to) },
      });
      const runs = datasetRows(body, "workersInvocationsScheduled", "cloudflare schedules");
      if (runs.length >= SCHEDULED_LIMIT) families.push({ family: "schedules", reason: `more than ${SCHEDULED_LIMIT - 1} cron runs in three hours — too many to read in one answer` });
      else { extra.push(...cronPoints(runs, from, to)); families.push({ family: "schedules", reason: null }); }
    } catch (e) {
      families.push({ family: "schedules", reason: familyReason("Cloudflare did not answer for cron runs", e) });
    }

    // Once a day (the framework says which completed day): the quantiles, then D1 when the part names a database.
    const ids = d1Ids(part);
    const day = pc.daily && /^\d{4}-\d{2}-\d{2}$/.test(pc.daily) ? pc.daily : null;
    const dayStart = day ? Date.parse(`${day}T00:00:00.000Z`) : Number.NaN;
    if (day && Number.isFinite(dayStart) && dayStart + DAY <= pc.now) {
      try {
        const body = await cfRequest(pc, auth, GRAPHQL, "cloudflare runtime", ANALYTICS_HINTS, {
          query: RUNTIME_QUERY, variables: { a: auth.account, s: worker, from: iso(dayStart), to: iso(dayStart + DAY) },
        });
        extra.push(...runtimePoints(datasetRows(body, "workersInvocationsAdaptive", "cloudflare runtime"), day, dayStart));
        families.push({ family: "runtime", reason: null });
      } catch (e) {
        families.push({ family: "runtime", reason: familyReason("Cloudflare did not answer for the day's CPU and wall time", e) });
      }
      if (ids.length) {
        const read = ids.slice(0, D1_PER_POLL);
        try {
          const vars: Record<string, string> = { a: auth.account, day };
          read.forEach((id, i) => { vars[`d${i}`] = id; });
          const body = await cfRequest(pc, auth, GRAPHQL, "cloudflare d1", ANALYTICS_HINTS, { query: d1Query(read.length), variables: vars });
          extra.push(...d1Points(body, read, day, dayStart));
          families.push({ family: "storage", reason: null });
        } catch (e) {
          families.push({ family: "storage", reason: familyReason("Cloudflare did not answer for D1", e) });
        }
      }
    }
    if (!ids.length) families.push({ family: "storage", reason: NO_D1_DATABASE });
    return {
      deploys,
      points: hourly.points,
      unavailable: WEB_UNAVAILABLE.map((u) => ({ ...u })),
      covered: { from: iso(from), to: iso(to) },
      ...(notes.length ? { notes } : {}),
      extraPoints: extra,
      families,
    };
  },
};
