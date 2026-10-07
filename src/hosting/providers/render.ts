// Render (#99) — a web service, private service, background worker or static site on Render, read over
// Render's REST API (`https://api.render.com/v1`, `Authorization: Bearer <API key>`). The facts below are
// from docs/superpowers/specs/2026-10-07-hosting-providers-research.md and render-oss/cli's GENERATED client
// (pkg/client/types_gen.go, metrics/metrics_gen.go — Render's own OpenAPI); what neither could settle is
// marked UNCONFIRMED and read defensively.
//
//   credential   an API KEY (Account Settings › API Keys). Render has no integration and no third-party
//                OAuth, and a key has NO scopes: it acts as its user, with that user's full permissions, in
//                EVERY workspace the user belongs to. The narrowest Render offers is a key from a dedicated
//                member account that belongs only to this workspace (which workspace role suffices is
//                UNCONFIRMED). One key per org (`credentialScope: "org"`); sent only to api.render.com.
//   part         ONE Render service (`service_id`, `srv-…`). A web service can be either role — `web` reads
//                its HTTP traffic, `service` its CPU and memory; a background worker / private service is
//                a `service`. An optional workspace id (`owner_id`) is used only to cross-check in `probe`.
//   one poll     1 `GET /services/{id}` (the deploy list carries no branch or URL — the service does) +
//                1 `GET /services/{id}/deploys?limit=20` + the role's metrics: web 3 (`http-requests`
//                aggregated by status code → requests AND errors, `http-latency` p95, `bandwidth`), service
//                2 (`cpu`, `memory`). Worst case 5 (`pollCost`). Render's GET limit is 400/min.
//   metrics      `GET /metrics/<kind>?resource=<id>&startTime=&endTime=&resolutionSeconds=3600` for
//                `pollWindow(now)` → `[{ labels: [{ field, value }], unit, values: [{ timestamp, value }] }]`.
//                Every series' `unit` is READ and converted (never assumed); a unit Trov does not know makes
//                that metric `unavailable` with the unit quoted, so the owner sees what Render sent.
//
// A 4xx on a METRICS endpoint (a static site has no CPU, a worker no HTTP traffic, a plan without metrics)
// costs that metric — `unavailable` with a reason — never the poll; a 401 (the key), a 408 / 429 (try
// again) or a 5xx anywhere, or any non-2xx on the service or deploy read, throws (`refuse`). Nothing is
// logged; every message is scrubbed of the key before it is cut (../http.ts).
import type { DeployState, HostingMetric } from "@shared/hosting";
import type { HostingDeploy, HostingPoint, HostingProvider, PollResult, ProbeResult, ProviderContext } from "../types";
import {
  HostingError, type SecretLike, asHostingError, hourFloor, probeFailure, instant, iso, pollWindow, readJson, record, refuse, sane, scrub, str,
} from "../http";

const API = "https://api.render.com/v1";
const DASHBOARD = "https://dashboard.render.com";
/** Every Render service id is `srv-` + lower-case alphanumerics (20 today; the range is slack). */
const SERVICE_ID = /^srv-[a-z0-9]{10,40}$/;
/** A workspace (owner) id: `tea-…` for a team, `usr-…` for a personal workspace. The prefixes are
 *  UNCONFIRMED beyond those two, so any three-letter prefix is accepted — it only feeds a cross-check. */
const OWNER_ID = /^[a-z]{3}-[a-z0-9]{10,40}$/;
const DEPLOY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEPLOY_LIMIT = 20;
/** The bucket width every metric is asked for: one point per hour, so a point IS that hour's figure. */
const RESOLUTION_S = 3600;
const UA = "trov-hosting";

// ── deploys ──────────────────────────────────────────────────────────────────

/**
 * Render's deploy `status` → DEPLOY_STATES. The whole enum (render-oss/cli `DeployStatus`):
 *
 *   created, queued                                                  → queued
 *   build_in_progress, update_in_progress, pre_deploy_in_progress    → building
 *   live                                                             → ready
 *   deactivated                                                      → ready     it WAS live and has been
 *                                                                                superseded by a newer deploy —
 *                                                                                it landed, so it is not a failure
 *   build_failed, update_failed, pre_deploy_failed                   → error
 *   canceled (and the British "cancelled", defensively)              → canceled
 *
 * Anything else is a status Trov does not know: that deploy is skipped, never guessed.
 */
const STATE: Readonly<Record<string, DeployState>> = {
  created: "queued", queued: "queued",
  build_in_progress: "building", update_in_progress: "building", pre_deploy_in_progress: "building",
  live: "ready", deactivated: "ready",
  build_failed: "error", update_failed: "error", pre_deploy_failed: "error",
  canceled: "canceled", cancelled: "canceled",
};

/** What one `GET /services/{id}` says that a poll or a probe uses. */
interface ServiceFacts {
  name: string | null;
  type: string | null;
  /** The branch the service deploys (absent for an image-backed service). */
  branch: string | null;
  /** `serviceDetails.url` as an https URL (a private service / worker has none). */
  url: string | null;
  ownerId: string | null;
  suspended: boolean;
  /** The service's page in the Render dashboard — the base of every deploy's inspect link. */
  dashboard: string;
}

/** Render's service `type` in a person's words. An unknown type is never quoted (it is upstream text). */
const TYPE_WORDS: Readonly<Record<string, string>> = {
  web_service: "web service", private_service: "private service", background_worker: "background worker",
  static_site: "static site", cron_job: "cron job",
};
const typeWords = (type: string | null, fallback = "service"): string => (type && Object.hasOwn(TYPE_WORDS, type) ? TYPE_WORDS[type] : fallback);

/** Upstream text for a message or a field: scrubbed of the key FIRST, control characters and runs of
 *  whitespace folded, THEN cut. null when nothing is left. */
function upstream(v: unknown, secret: SecretLike, max: number): string | null {
  if (typeof v !== "string") return null;
  const text = scrub(v, secret).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return text || null;
}

/** An https URL from a field that may be a bare host (`my-app.onrender.com`) — else null. */
function httpsUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(candidate);
    return u.protocol === "https:" && u.hostname ? u.toString().replace(/\/$/, "") : null;
  } catch { return null; }
}

/**
 * The dashboard page of the service. Render's service carries `dashboardUrl` ("The URL to view the service
 * in the Render Dashboard"), which knows the service TYPE's path segment (`/web/`, `/worker/`, `/static/`…),
 * so it is preferred — but only an https URL on dashboard.render.com, without query or fragment. Else the
 * `/web/<id>` guess `consoleUrl` makes too (UNCONFIRMED: Render redirects the other types' paths).
 */
function dashboardOf(v: unknown, id: string): string {
  const s = str(v);
  if (s) {
    try {
      const u = new URL(s);
      if (u.protocol === "https:" && u.hostname === "dashboard.render.com" && !u.username && !u.password && !u.port) {
        return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
      }
    } catch { /* not a URL: the guess below */ }
  }
  return `${DASHBOARD}/web/${encodeURIComponent(id)}`;
}

function serviceFacts(body: unknown, id: string): ServiceFacts {
  const s = record(body);
  return {
    name: str(s.name), type: str(s.type), branch: str(s.branch), url: httpsUrl(record(s.serviceDetails).url),
    ownerId: str(s.ownerId), suspended: s.suspended === "suspended", dashboard: dashboardOf(s.dashboardUrl, id),
  };
}

/**
 * One item of `GET /services/{id}/deploys` → a `HostingDeploy`, or null when it is malformed (no id, an
 * unknown status, no parseable `createdAt`). Each item is `{ cursor, deploy }`; a bare deploy is accepted too.
 *
 *   sha       `commit.id` — a git SHA only. An IMAGE-backed deploy has no commit (its `image.sha` is a
 *             registry digest, not a commit), so its sha is null.
 *   branch    Render records none per deploy: the SERVICE's current branch. A deploy made before the
 *             service's branch was changed reads the new one — Render keeps no history of it.
 *   target    always `production`. A Render service deploys exactly one branch to one URL; a preview
 *             (a pull-request preview or a preview environment) is a SEPARATE service with its own id, so
 *             a part never sees a preview deploy of the service it names.
 *   by        null. A deploy carries only its `trigger` (`new_commit`, `manual`, `api`, …) — how, not who.
 *   url       the service's URL, on the `live` deploy only: it is the one serving it. Render gives a deploy
 *             no URL of its own, and a superseded or failed deploy does not serve the service's.
 *   readyAt   `finishedAt` — when it went live, or finished failing / was canceled.
 */
function deployOf(item: unknown, svc: ServiceFacts, secret: SecretLike): HostingDeploy | null {
  const wrapped = record(item);
  const d = record("deploy" in wrapped ? wrapped.deploy : item);
  const id = str(d.id);
  const status = str(d.status);
  const createdAt = instant(d.createdAt);
  const state = status && Object.hasOwn(STATE, status) ? STATE[status] : null;
  if (!id || !DEPLOY_ID.test(id) || !state || !createdAt) return null;
  const commit = record(d.commit);
  const sha = str(commit.id);
  const message = typeof commit.message === "string" ? upstream(commit.message.split(/\r?\n/, 1)[0], secret, 300) : null;
  return {
    id,
    state,
    target: "production",
    sha: sha && /^[0-9a-f]{7,64}$/i.test(sha) ? sha.toLowerCase() : null,
    branch: svc.branch,
    message,
    by: null,
    createdAt,
    readyAt: instant(d.finishedAt),
    url: status === "live" ? svc.url : null,
    inspectUrl: `${svc.dashboard}/deploys/${encodeURIComponent(id)}`,
  };
}

// ── requests ─────────────────────────────────────────────────────────────────

const headers = (secret: SecretLike): Record<string, string> => ({
  authorization: `Bearer ${secret.reveal()}`, accept: "application/json", "user-agent": UA,
});

/** One GET through the fixed-host fetch. A thrown fetch (timeout, refused host) becomes a fixed-text
 *  `HostingError` — never the original error, which may repeat the request. */
async function send(pc: ProviderContext, path: string, what: string): Promise<Response> {
  try {
    return await pc.fetch(`${API}${path}`, { method: "GET", headers: headers(pc.credential.secret) });
  } catch (e) {
    throw asHostingError(what, e);
  }
}

/** A GET whose non-2xx is a refusal (thrown, scrubbed), and whose body is read bounded. */
async function getJson(pc: ProviderContext, path: string, what: string): Promise<unknown> {
  const res = await send(pc, path, what);
  if (!res.ok) await refuse(what, res, pc.credential.secret);
  return readJson(res, what);
}

// ── metrics ──────────────────────────────────────────────────────────────────

interface Series {
  labels: Record<string, string>;
  unit: string;
  points: { t: number; v: number }[];
}

/**
 * A metrics body → its series. Not a list at all is a malformed answer (thrown). Inside it, a series with
 * no `values` list is skipped, and so is each point whose timestamp does not parse or whose value is not a
 * finite number ≥ 0. Timestamps: the generated client types them as RFC 3339 date-times, while its own
 * parameter description says "Epoch/Unix timestamp" — UNCONFIRMED, so `instant` reads ISO strings, epoch
 * seconds and epoch milliseconds alike. Labels are `[{ field, value }]`; an object map is accepted too.
 */
function seriesOf(body: unknown, what: string): Series[] {
  if (!Array.isArray(body)) throw new HostingError(`${what}: the response is not a list of time series`);
  const out: Series[] = [];
  for (const raw of body) {
    const s = record(raw);
    if (!Array.isArray(s.values)) continue;
    const labels: Record<string, string> = {};
    if (Array.isArray(s.labels)) {
      for (const l of s.labels) {
        const { field, value } = record(l);
        if (typeof field === "string" && typeof value === "string") labels[field] = value;
      }
    } else {
      for (const [k, v] of Object.entries(record(s.labels))) if (typeof v === "string") labels[k] = v;
    }
    const points: Series["points"] = [];
    for (const p of s.values) {
      const { timestamp, value } = record(p);
      const at = instant(timestamp);
      const v = sane(value, Number.POSITIVE_INFINITY);
      if (at !== null && v !== null) points.push({ t: Date.parse(at), v });
    }
    out.push({ labels, unit: typeof s.unit === "string" ? s.unit : "", points });
  }
  return out;
}

/** How a series' unit converts into the vocabulary's unit: multiply by `factor`; `rate` = the value is per
 *  SECOND, so a bucket's count is value × the bucket's seconds. Or why it cannot be converted. */
type UnitRead = { factor: number; rate: boolean } | { refused: string };

const RATE_SUFFIX = /^(.*?)\s*(?:\/\s*(?:s|sec|second)|\s+per\s+second)$/;
function splitRate(unit: string): { base: string; rate: boolean } {
  const u = unit.trim().toLowerCase();
  if (u === "rps") return { base: "requests", rate: true };
  const m = RATE_SUFFIX.exec(u);
  return m ? { base: m[1].trim(), rate: true } : { base: u, rate: false };
}

/** Sizes in BYTES — binary multiples (a "MB" is 2^20 bytes). Whether Render's MB / GB are binary or decimal
 *  is UNCONFIRMED; the two differ by under 7.4% even at GB. */
const SIZES: Readonly<Record<string, number>> = {
  b: 1, byte: 1, bytes: 1,
  kb: 1024, kib: 1024, kilobyte: 1024, kilobytes: 1024,
  mb: 1024 ** 2, mib: 1024 ** 2, megabyte: 1024 ** 2, megabytes: 1024 ** 2,
  gb: 1024 ** 3, gib: 1024 ** 3, gigabyte: 1024 ** 3, gigabytes: 1024 ** 3,
  tb: 1024 ** 4, tib: 1024 ** 4, terabyte: 1024 ** 4, terabytes: 1024 ** 4,
};
/** A count has no unit, so an EMPTY unit on the request metric reads as a count. */
const COUNTS = new Set(["", "count", "counts", "request", "requests", "req", "reqs"]);
const DURATIONS_MS: Readonly<Record<string, number>> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  ms: 1, msec: 1, millisecond: 1, milliseconds: 1,
  us: 0.001, "µs": 0.001, microsecond: 0.001, microseconds: 0.001,
  ns: 1e-6, nanosecond: 1e-6, nanoseconds: 1e-6,
};
const CORES = new Set(["cpu", "cpus", "vcpu", "vcpus", "core", "cores", "cpu cores"]);
const MILLICORES = new Set(["m", "mcpu", "millicpu", "millicore", "millicores"]);
const PERCENT = new Set(["%", "percent", "percentage"]);

/** The unit as a short quotable string — scrubbed FIRST, then reduced to plain characters, then cut. */
const quoteUnit = (unit: string, secret: SecretLike): string =>
  `"${scrub(unit, secret).replace(/[^\w %/.µ-]/g, "").slice(0, 24)}"`;
const unknownUnit = (label: string, unit: string, secret: SecretLike): { refused: string } =>
  ({ refused: `Render reported ${label} in a unit Trov does not recognise (${quoteUnit(unit, secret)})` });

const countUnit = (secret: SecretLike) => (unit: string): UnitRead => {
  const { base, rate } = splitRate(unit);
  return COUNTS.has(base) ? { factor: 1, rate } : unknownUnit("HTTP requests", unit, secret);
};
const bytesUnit = (secret: SecretLike) => (unit: string): UnitRead => {
  const { base, rate } = splitRate(unit);
  return Object.hasOwn(SIZES, base) ? { factor: SIZES[base], rate } : unknownUnit("bandwidth", unit, secret);
};
const msUnit = (secret: SecretLike) => (unit: string): UnitRead => {
  const u = unit.trim().toLowerCase();
  return Object.hasOwn(DURATIONS_MS, u) ? { factor: DURATIONS_MS[u], rate: false } : unknownUnit("latency", unit, secret);
};
const mbUnit = (secret: SecretLike) => (unit: string): UnitRead => {
  const u = unit.trim().toLowerCase();
  return Object.hasOwn(SIZES, u) ? { factor: SIZES[u] / 1024 ** 2, rate: false } : unknownUnit("memory", unit, secret);
};
const vcpuUnit = (secret: SecretLike) => (unit: string): UnitRead => {
  const u = unit.trim().toLowerCase();
  if (CORES.has(u)) return { factor: 1, rate: false };
  if (MILLICORES.has(u)) return { factor: 0.001, rate: false };
  if (PERCENT.has(u)) return { refused: "Render reported CPU as a percentage of the plan's limit; Trov stores vCPU and does not know the limit" };
  return unknownUnit("CPU", unit, secret);
};

interface Win { from: number; to: number }
type Hours = Map<number, number>;

/** The points of a series that fall in a COMPLETE hour of the window, each with its hour start. */
const inWindow = (s: Series, win: Win): { at: number; t: number; v: number }[] =>
  s.points.map((p) => ({ ...p, at: hourFloor(p.t) })).filter((p) => p.at >= win.from && p.at < win.to);

/** A series' step in seconds: the smallest gap between its timestamps, never more than the hour asked for
 *  (a missing bucket — a quiet hour Render leaves out — must not read as a wider step), the hour when the
 *  series has a single point. Used only to turn a per-second RATE into a bucket's count. */
function stepSeconds(s: Series): number {
  const ts = [...new Set(s.points.map((p) => p.t))].sort((a, b) => a - b);
  let gap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < ts.length; i++) gap = Math.min(gap, ts[i] - ts[i - 1]);
  return Number.isFinite(gap) ? Math.min(gap / 1000, RESOLUTION_S) : RESOLUTION_S;
}

/**
 * A COUNT per hour (requests, errors, bandwidth): every point of every series added into its hour.
 * Points are bucketed by their hour START. Whether Render stamps a bucket with its start or its end is
 * UNCONFIRMED; either way the window ends ≥ 15 minutes in the past (`pollWindow`), so no point read is
 * a running hour — at worst a figure is filed one hour early. With the hourly resolution asked for there is
 * one point per hour; a finer step (an endpoint that ignores `resolutionSeconds`) is summed into its hour.
 * A per-second unit is multiplied by the bucket's seconds — whether `http-requests` answers a count per
 * bucket or a rate is UNCONFIRMED, so the unit decides.
 */
function sumHours(series: Series[], win: Win, unitOf: (unit: string) => UnitRead): Hours | { refused: string } {
  const out: Hours = new Map();
  for (const s of series) {
    const pts = inWindow(s, win);
    if (!pts.length) continue;
    const u = unitOf(s.unit);
    if ("refused" in u) return u;
    const mult = u.factor * (u.rate ? stepSeconds(s) : 1);
    for (const p of pts) out.set(p.at, (out.get(p.at) ?? 0) + p.v * mult);
  }
  return out;
}

/**
 * A GAUGE per hour (CPU, memory, latency): per series, the LATEST point in each hour (Render's array order
 * is undocumented); then across series `sum` (CPU / memory: one series per INSTANCE, and the part's figure
 * is the whole service's use) or `max` (latency: a p95 cannot be combined exactly; the worst is honest).
 */
function gaugeHours(series: Series[], win: Win, unitOf: (unit: string) => UnitRead, combine: "sum" | "max"): Hours | { refused: string } {
  const out: Hours = new Map();
  for (const s of series) {
    const pts = inWindow(s, win);
    if (!pts.length) continue;
    const u = unitOf(s.unit);
    if ("refused" in u) return u;
    const latest = new Map<number, { t: number; v: number }>();
    for (const p of pts) {
      const held = latest.get(p.at);
      if (!held || p.t > held.t) latest.set(p.at, p);
    }
    for (const [at, p] of latest) {
      const v = p.v * u.factor;
      out.set(at, combine === "sum" ? (out.get(at) ?? 0) + v : Math.max(out.get(at) ?? 0, v));
    }
  }
  return out;
}

/** Ceilings far past anything real — a stored point is permanent (first write wins), so an absurd one is
 *  dropped rather than kept. */
const MAX: Readonly<Record<HostingMetric, number>> = {
  requests: 1e12, errors: 1e12, latency_p50_ms: 1e7, latency_p95_ms: 1e7, bandwidth_bytes: 1e16,
  cpu: 1024, mem_mb: 4096 * 1024,
};
const ROUND: Readonly<Record<HostingMetric, (n: number) => number>> = {
  requests: Math.round, errors: Math.round, bandwidth_bytes: Math.round,
  latency_p50_ms: (n) => Math.round(n * 10) / 10, latency_p95_ms: (n) => Math.round(n * 10) / 10,
  cpu: (n) => Math.round(n * 10_000) / 10_000, mem_mb: (n) => Math.round(n * 10) / 10,
};

/** What a role's metric reads collect: points, the metrics that could not be read, and whether any was. */
class Collect {
  points: HostingPoint[] = [];
  unavailable: { metric: HostingMetric; reason: string }[] = [];
  read = false;
  skip(metrics: readonly HostingMetric[], reason: string): void {
    for (const metric of metrics) this.unavailable.push({ metric, reason });
  }
  put(metric: HostingMetric, hours: Hours | { refused: string }): void {
    if (hours instanceof Map) {
      this.read = true;
      for (const [at, v] of [...hours].sort((a, b) => a[0] - b[0])) {
        const value = sane(ROUND[metric](v), MAX[metric]);
        if (value !== null) this.points.push({ metric, at: iso(at), value });
      }
    } else {
      this.skip([metric], hours.refused);
    }
  }
}

/** Query-string instants: RFC 3339 without milliseconds ("2026-10-07T09:00:00Z") — the form render-oss/cli
 *  sends (the parameter's description says epoch; the generated client sends a date-time — UNCONFIRMED). */
const queryTime = (ms: number): string => iso(ms).replace(".000Z", "Z");

/** Statuses on a metrics endpoint that mean "no such metric for this service", not "the poll failed": every
 *  4xx except 401 (the key itself), 408 and 429 (try again — the next poll does). */
const metricUnavailable = (status: number): boolean => status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;

/** One metrics read: its series, or the reason it is unavailable (a 4xx — see `metricUnavailable`). */
async function readMetric(
  pc: ProviderContext, kind: string, id: string, win: Win, params: Record<string, string>, label: string,
): Promise<Series[] | { refused: string }> {
  const what = `render ${kind} metrics`;
  // `resolutionSeconds` goes to every kind. render-oss/cli's generated client lists no `resolutionSeconds`
  // for `bandwidth` — whether Render honours it there, ignores it, or refuses it is UNCONFIRMED. A refusal
  // is a 4xx (bandwidth then reads unavailable, with the status); an ignored one leaves Render's default
  // step, which `sumHours` sums into hours when it is finer than an hour.
  const q = new URLSearchParams({
    resource: id, startTime: queryTime(win.from), endTime: queryTime(win.to), resolutionSeconds: String(RESOLUTION_S), ...params,
  });
  const res = await send(pc, `/metrics/${kind}?${q.toString()}`, what);
  if (!res.ok && metricUnavailable(res.status)) {
    await res.body?.cancel().catch(() => undefined);
    return {
      refused: res.status === 403
        ? `Render refused ${label} to this API key (HTTP 403)`
        : `Render reports no ${label} for this service type (HTTP ${res.status})`,
    };
  }
  if (!res.ok) await refuse(what, res, pc.credential.secret);
  return seriesOf(await readJson(res, what), what);
}

const STATUS_LABELS = ["statusCode", "status_code", "status"] as const;
const statusOf = (s: Series): string | null => {
  for (const k of STATUS_LABELS) if (s.labels[k]) return s.labels[k];
  return null;
};

const isP95 = (q: string | undefined): boolean => q === undefined || /^(p?95|0?\.950*)$/i.test(q.trim());

const P50_REASON = "Trov reads Render's p95 latency only";
const WEB_HTTP: readonly HostingMetric[] = ["requests", "errors", "latency_p95_ms"];

/** role `web`: requests + server errors (one `http-requests` read aggregated by status code), p95 latency,
 *  bandwidth. Render reports HTTP requests and latency for WEB SERVICES only — another type is not asked. */
async function webMetrics(pc: ProviderContext, id: string, svc: ServiceFacts, win: Win, c: Collect): Promise<void> {
  const secret = pc.credential.secret;
  c.skip(["latency_p50_ms"], P50_REASON);
  if (svc.type !== null && svc.type !== "web_service") {
    c.skip(WEB_HTTP, `Render reports HTTP requests and latency for web services only; this service is a ${typeWords(svc.type, "different type")}`);
  } else {
    const reqs = await readMetric(pc, "http-requests", id, win, { aggregateBy: "statusCode" }, "HTTP request metrics");
    if (!Array.isArray(reqs)) {
      c.skip(["requests", "errors"], reqs.refused);
    } else {
      const counted = reqs.filter((s) => inWindow(s, win).length > 0);
      c.put("requests", sumHours(counted, win, countUnit(secret)));
      // `errors` counts 5xx: the series whose status-code label starts with "5" ("503", or a "5xx" class).
      // The label's FIELD name is UNCONFIRMED ("statusCode" is the aggregateBy value) — the plausible
      // spellings are read. A series with traffic but no status label means the split did not happen, and
      // then errors are unknown, never zero.
      if (counted.some((s) => statusOf(s) === null)) {
        c.skip(["errors"], "Render did not break the requests down by status code");
      } else {
        c.put("errors", sumHours(counted.filter((s) => statusOf(s)!.startsWith("5")), win, countUnit(secret)));
      }
    }
    const lat = await readMetric(pc, "http-latency", id, win, { quantile: "0.95" }, "HTTP latency");
    if (!Array.isArray(lat)) c.skip(["latency_p95_ms"], lat.refused);
    else {
      // Only the p95 series: a series labelled with another quantile is not p95. The label's spelling is
      // UNCONFIRMED ("0.95" is what was asked for; "95" / "p95" are read too); an unlabelled series is the
      // one quantile asked for. Traffic in other quantiles only is unknown p95, never an empty hour.
      const p95 = lat.filter((s) => isP95(s.labels.quantile));
      if (!p95.some((s) => inWindow(s, win).length) && lat.some((s) => inWindow(s, win).length)) {
        c.skip(["latency_p95_ms"], "Render answered latency for other quantiles than p95");
      } else {
        c.put("latency_p95_ms", gaugeHours(p95, win, msUnit(secret), "max"));
      }
    }
  }
  const bw = await readMetric(pc, "bandwidth", id, win, {}, "bandwidth");
  if (!Array.isArray(bw)) c.skip(["bandwidth_bytes"], bw.refused);
  else c.put("bandwidth_bytes", sumHours(bw, win, bytesUnit(secret)));
}

/** role `service`: CPU (vCPU) and memory (MB), each summed across the service's INSTANCE series. Render
 *  reports neither for a static site, which is then not asked. `aggregationMethod` is deliberately NOT
 *  sent: Render's own description of it is "the aggregation method to apply to multiple time series", so
 *  AVG would fold the instances into their average — and the part's figure is the service's TOTAL use
 *  (whether Render then returns one series per instance is UNCONFIRMED; one series sums to itself). */
async function serviceMetrics(pc: ProviderContext, id: string, svc: ServiceFacts, win: Win, c: Collect): Promise<void> {
  const secret = pc.credential.secret;
  if (svc.type === "static_site") {
    c.skip(["cpu", "mem_mb"], "Render reports no CPU or memory for a static site");
    return;
  }
  const cpu = await readMetric(pc, "cpu", id, win, {}, "CPU");
  if (!Array.isArray(cpu)) c.skip(["cpu"], cpu.refused);
  else c.put("cpu", gaugeHours(cpu, win, vcpuUnit(secret), "sum"));
  const mem = await readMetric(pc, "memory", id, win, {}, "memory");
  if (!Array.isArray(mem)) c.skip(["mem_mb"], mem.refused);
  else c.put("mem_mb", gaugeHours(mem, win, mbUnit(secret), "sum"));
}

// ── the provider ─────────────────────────────────────────────────────────────

const serviceIdOf = (settings: Readonly<Record<string, string>>): string | null => {
  const id = settings.service_id;
  return typeof id === "string" && SERVICE_ID.test(id) ? id : null;
};

export const render: HostingProvider = {
  id: "render",
  label: "Render",
  status: "available",
  summary: "A Render web service, private service or background worker: deploys from Render's API, and HTTP requests, server errors, p95 latency and bandwidth (web) or CPU and memory (service) from Render's metrics API.",
  roles: ["web", "service"],
  apiHosts: ["api.render.com"],
  docsUrl: "https://api-docs.render.com/reference/introduction",
  credentialScope: "org",
  connectionMethods: [
    {
      method: "token",
      label: "Paste an API key",
      howTo: "In the Render Dashboard open Account Settings › API Keys › Create API Key, and paste the key here (Render shows it only once). Render API keys have NO scopes and no read-only mode, and are not bound to a workspace: a key acts as its user — with everything that user may do, including changing and deleting services — in EVERY workspace the user belongs to. The narrowest option Render offers is a key from a dedicated member account that belongs only to this workspace. The key is only ever sent to api.render.com.",
      grants: ["Everything the key's user can do, in every workspace that user belongs to (Render API keys have no scopes and no read-only mode)"],
    },
  ],
  orgConfigFields: [
    {
      key: "owner_id", label: "Workspace ID",
      description: "Optional. The Render workspace's id (tea-… for a team, usr-… for a personal workspace), from Workspace Settings. Test connection then checks that each service belongs to it. Not a secret.",
      required: false, placeholder: "tea-cn1t5h0l5elc73fk0abc", pattern: OWNER_ID,
    },
  ],
  partSettings: [
    {
      key: "service_id", label: "Service ID",
      description: "The Render service's id (srv-…): its Settings page, or the last part of its dashboard URL.",
      required: true, placeholder: "srv-d3k8q1j7mgec73a1b2c0", pattern: SERVICE_ID,
    },
  ],
  capabilities: { deploys: true, metrics: ["requests", "errors", "latency_p95_ms", "bandwidth_bytes", "cpu", "mem_mb"] },
  planNote: "Render reports HTTP requests and latency for web services only, and CPU and memory for every service but static sites.",
  pollCost: 5,
  // The dashboard's path segment depends on the service TYPE (`/web/`, `/worker/`, `/static/`, `/pserv/`,
  // `/cron/`) and is not in the part's settings; `/web/<id>` is the guess, and Render redirects a service
  // opened under another type's path — UNCONFIRMED. (A deploy's inspect link uses the service's own
  // `dashboardUrl` instead, which the API does return.)
  // An API key is managed (and revoked) under Account Settings › API Keys.
  manageUrl(_config, method) {
    return method === "token" ? `${DASHBOARD}/u/settings#api-keys` : null;
  },
  consoleUrl(part) {
    const id = serviceIdOf(part.settings);
    return id ? `${DASHBOARD}/web/${encodeURIComponent(id)}` : null;
  },

  /**
   * With a part: `GET /services/{id}` — proves the key AND that it can see the service; with a Workspace ID
   * set, the service must belong to it. Without one: `GET /owners/{owner_id}` when a Workspace ID is set
   * (the key can see that workspace), else `GET /owners?limit=1` (the key alone). ONE fetch either way.
   */
  async probe(pc: ProviderContext, part): Promise<ProbeResult> {
    const secret = pc.credential.secret;
    const configured = pc.credential.config.owner_id;
    const owner = typeof configured === "string" && OWNER_ID.test(configured) ? configured : null;
    const say = (text: string): string => scrub(text, secret).replace(/\s+/g, " ").trim().slice(0, 300);
    try {
      if (part) {
        const id = serviceIdOf(part.settings);
        if (!id) return { ok: false, detail: "The part has no Render service ID (srv-…)." };
        const svc = serviceFacts(await getJson(pc, `/services/${encodeURIComponent(id)}`, "render service"), id);
        const name = upstream(svc.name, secret, 80) ?? id;
        if (owner && svc.ownerId && svc.ownerId !== owner) {
          return { ok: false, detail: say(`Render answered for service ${name}, but it belongs to a different workspace than the Workspace ID set here.`) };
        }
        const suspended = svc.suspended ? " It is SUSPENDED on Render, so it reports no new deploys or traffic until it is resumed." : "";
        return { ok: true, detail: say(`Render answered for service ${name} (${typeWords(svc.type)}).${suspended}`) };
      }
      if (owner) {
        const o = record(await getJson(pc, `/owners/${encodeURIComponent(owner)}`, "render workspace"));
        const name = upstream(o.name, secret, 80) ?? owner;
        return { ok: true, detail: say(`Render answered for workspace ${name}.`) };
      }
      const list = await getJson(pc, "/owners?limit=1", "render workspaces");
      if (!Array.isArray(list)) throw new HostingError("render workspaces: the response is not a list");
      const name = upstream(record(record(list[0]).owner).name, secret, 80);
      return { ok: true, detail: say(name ? `Render answered: the API key can see workspace ${name}.` : "Render answered for the API key.") };
    } catch (e) {
      return probeFailure("render", e);
    }
  },

  /**
   * One poll: the service (branch, URL, type, dashboard link), its ≤ 20 newest deploys, and the part ROLE's
   * metrics for `pollWindow(now)`. `covered` is the window when at least one metric was read; null when
   * every metric of the role is unavailable.
   */
  async poll(pc: ProviderContext, part): Promise<PollResult> {
    const secret = pc.credential.secret;
    const id = serviceIdOf(part.settings);
    if (!id) throw new HostingError("render: the part has no valid service ID");
    const svc = serviceFacts(await getJson(pc, `/services/${encodeURIComponent(id)}`, "render service"), id);

    const list = await getJson(pc, `/services/${encodeURIComponent(id)}/deploys?limit=${DEPLOY_LIMIT}`, "render deploys");
    if (!Array.isArray(list)) throw new HostingError("render deploys: the response is not a list");
    const seen = new Set<string>();
    const deploys: HostingDeploy[] = [];
    for (const item of list) {
      const d = deployOf(item, svc, secret);
      if (d && !seen.has(d.id)) { seen.add(d.id); deploys.push(d); }
    }
    deploys.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    const win = pollWindow(pc.now);
    const c = new Collect();
    if (part.role === "web") await webMetrics(pc, id, svc, win, c);
    else await serviceMetrics(pc, id, svc, win, c);
    return {
      deploys: deploys.slice(0, DEPLOY_LIMIT),
      points: c.points,
      unavailable: c.unavailable,
      covered: c.read ? { from: iso(win.from), to: iso(win.to) } : null,
    };
  },
};
