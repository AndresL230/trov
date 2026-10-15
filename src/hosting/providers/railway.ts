// Railway — ONE Railway service in ONE Railway environment per part, read with ONE org-wide token over
// Railway's public GraphQL API (`POST https://backboard.railway.com/graphql/v2`, `Authorization: Bearer
// <token>`). The facts below are from docs.railway.com/reference/public-api, the API's own schema (it answers
// introspection) and Railway's CLI (railwayapp/cli `src/gql/queries/strings/*.graphql`,
// `src/controllers/metrics.rs`); what none of them settles is marked UNCONFIRMED and read defensively.
//
//   credential   a WORKSPACE token (or an ACCOUNT token), created under Account Settings › Tokens with the
//                workspace that owns the project picked in its Workspace dropdown. Both travel as `Authorization:
//                Bearer` (the docs: "Project tokens use the Project-Access-Token header"; the others Bearer).
//                PROJECT tokens are not supported: one is bound to ONE environment, and a part may name any
//                environment of the workspace. Railway has no read-only scope: a workspace token can change
//                everything in its workspace, an account token everything the account can. One per org
//                (one org-wide credential); sent only to backboard.railway.com.
//   part         `environment_id` + `service_id` (both required), and an optional `project_id` that only builds
//                the "Open in Railway" link (`consoleUrl` is synchronous and reads settings only). Roles: `web`
//                (HTTP traffic and egress) and `service` (CPU and memory).
//   deploys      `deployments(first: 20, input: { environmentId, serviceId }) { edges { node { id status
//                createdAt statusUpdatedAt projectId url staticUrl meta } } }` (the schema's `Deployment`; the
//                CLI's Deployments.graphql asks the same list). `meta` is an untyped JSON scalar: its
//                `commitHash` / `branch` / `commitMessage` / `commitAuthor` keys are UNCONFIRMED and read only
//                when they are strings of the expected form. The status map is below; that `REMOVED` is what a
//                deployment becomes once a NEWER one replaces it (so it landed) is UNCONFIRMED — a build
//                cancelled mid-way may read `REMOVED` too, and would then be drawn as landed.
//   metrics      `metrics(environmentId, serviceId, startDate, endDate, measurements: [...], sampleRateSeconds:
//                3600) { measurement values { ts value } }` — the old `:00` usage poller's query
//                (src/repo/poll.ts `pollRailway`): CPU_USAGE (vCPU) and MEMORY_USAGE_GB (→ MB) for a `service`
//                part, NETWORK_TX_GB (→ bytes, egress) for a `web` part. `ts` is unix seconds; each sample is
//                filed in its hour, the LATEST valid sample of an hour wins for a gauge, samples of one hour are
//                summed for egress. UNCONFIRMED: that an hourly NETWORK_TX_GB sample is the GB sent IN that hour
//                (not a running total), and that its GB is binary (2^30 bytes, the memory conversion's rule).
//                HTTP traffic (`web`): `httpMetricsGroupedByStatus(…, stepSeconds: 3600) { statusCode samples
//                { ts value } }` → requests (every status) and errors (500–599), and `httpDurationMetrics(…,
//                stepSeconds: 3600) { samples { ts p50 p95 } }` → latency. Both are in the public schema and are
//                exactly what Railway's CLI runs for `railway metrics --http` (HttpMetricsByStatus.graphql,
//                HttpDurationMetrics.graphql), but docs.railway.com does not describe them: UNCONFIRMED that a
//                sample's `value` is the request COUNT of its step (the CLI sums them as counts), that `ts` is the
//                step's START, and that p50 / p95 are milliseconds (the CLI prints them as `p95_ms`). A refused
//                HTTP read (a GraphQL error, a 4xx but 401 / 408 / 429) costs THOSE metrics — `unavailable`, with
//                the reason — never the poll. A latency is stored only for an hour that had requests: an idle
//                hour's percentile is not a reading.
//   probe        with a part: ONE query reading `serviceInstance(environmentId, serviceId)` (the service EXISTS
//                in that environment, and the token can see it) and `environment(id) { name projectId }` (with
//                a `project_id` set, it must match). Without a part: `workspace(workspaceId)` when the optional
//                org config `workspace_id` is set — the docs' own workspace-token check —, else `projects(first:
//                1)`, which a workspace token is assumed to answer for its workspace (UNCONFIRMED). (`me` is
//                refused to a workspace token, per the docs.) ONE fetch either way.
//   one poll     web: deployments (1) + egress (1) + HTTP by status (1) + HTTP latency (1) = 4 (`pollCost`);
//                service: deployments (1) + CPU and memory (1) = 2. Railway's limits: 1000 requests / hour on
//                Hobby, 10000 on Pro.
//
// GraphQL reports a failure beside a 200 as a non-empty `errors` array; `data` beside it is never read (except
// that an HTTP-metrics error costs only its metrics). Every message is scrubbed of the token BEFORE it is cut
// (../http.ts). Nothing is logged here.
import type { DeployState, HostingMetric } from "@shared/hosting";
import type { HostingDeploy, HostingPoint, HostingProvider, PartRef, PollResult, ProbeResult, ProviderContext } from "../types";
import {
  HostingError, type Revealed, asHostingError, hourFloor, instant, iso, pollWindow, probeFailure, readJson, record, refuse, sane, scrub, str,
} from "../http";

const GRAPHQL = "https://backboard.railway.com/graphql/v2";
const DASHBOARD = "https://railway.com";
const UA = "trov-hosting";

const RAILWAY_ID = /^[A-Za-z0-9-]{1,100}$/;
const PLAIN_LINE = /^[^\u0000-\u001f\u007f]{1,200}$/;
const DEPLOY_LIMIT = 20;
const STEP_S = 3600;

// ── the credential and the settings ──────────────────────────────────────────

interface RwAuth { header: string; revealed: Revealed }

/** The Bearer header. A pasted leading "Bearer " is dropped; a value with whitespace or a control character
 *  inside is refused in fixed words before any request. */
function rwAuth(pc: ProviderContext): RwAuth {
  const stored = pc.credential.secret.reveal();
  const token = stored.trim().replace(/^bearer\s+/i, "");
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new HostingError("the Railway token is not in the expected form — paste the token itself, without quotes or spaces", [stored, token]);
  }
  const header = `Bearer ${token}`;
  return { header, revealed: [pc.credential.secret, stored, token, header] };
}

interface Ids { env: string; service: string; project: string | null }

/** The part's ids, re-checked here although the framework validated them: none reaches a query unless it is
 *  in its expected form (they travel as GraphQL VARIABLES, never inside the query text, as a second lock). */
function partIds(part: PartRef): Ids {
  const env = part.settings.environment_id, service = part.settings.service_id, project = part.settings.project_id;
  if (!env || !RAILWAY_ID.test(env)) throw new HostingError("the part's Railway environment ID is not set or not in the expected form");
  if (!service || !RAILWAY_ID.test(service)) throw new HostingError("the part's Railway service ID is not set or not in the expected form");
  return { env, service, project: project && RAILWAY_ID.test(project) ? project : null };
}

/** Upstream text: scrubbed FIRST, control characters and runs of whitespace folded, THEN cut. */
function upstream(v: unknown, revealed: Revealed, max: number): string | null {
  if (typeof v !== "string") return null;
  const text = scrub(v, revealed).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return text || null;
}

// ── requests ─────────────────────────────────────────────────────────────────

const HINTS = {
  400: "Railway refused the query",
  401: "the token is not valid — create a workspace token under Account Settings › Tokens (a project token is not accepted)",
  403: "the token cannot read this — it must be a workspace token for the workspace that owns the project",
};

/** What a GraphQL call answered: its `data`, or the (scrubbed) reason it was refused beside a 200. */
type Answer = { data: Record<string, unknown> } | { refused: string };

/**
 * One GraphQL POST through the fixed-host fetch. A non-2xx throws (`refuse`, scrubbed) unless `softStatus`
 * says it costs only this read; a 200 carrying `errors` is `{ refused }` with the first message, scrubbed and
 * cut. Anything thrown is a `HostingError` whose message never quotes the request.
 */
async function gql(
  pc: ProviderContext, auth: RwAuth, query: string, variables: Record<string, unknown>, what: string,
  softStatus: (status: number) => boolean = () => false,
): Promise<Answer> {
  let res: Response;
  try {
    res = await pc.fetch(GRAPHQL, {
      method: "POST",
      headers: { authorization: auth.header, accept: "application/json", "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) { throw asHostingError(what, e); }
  if (!res.ok && softStatus(res.status)) {
    await res.body?.cancel().catch(() => undefined);
    return { refused: `Railway refused it (HTTP ${res.status})` };
  }
  if (!res.ok) await refuse(what, res, auth.revealed, HINTS);
  let parsed: unknown;
  try { parsed = await readJson(res, what); } catch (e) { throw asHostingError(what, e); }
  const body = record(parsed);
  if (Array.isArray(body.errors) && body.errors.length) {
    return { refused: upstream(record(body.errors[0]).message, auth.revealed, 160) ?? "the query was refused" };
  }
  return { data: record(body.data) };
}

/** `gql` for a read the poll cannot go on without: a refusal beside a 200 throws too. */
async function gqlData(pc: ProviderContext, auth: RwAuth, query: string, variables: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
  const a = await gql(pc, auth, query, variables, what);
  if ("refused" in a) throw new HostingError(`${what}: ${a.refused}`, auth.revealed);
  return a.data;
}

/** Statuses on an HTTP-metrics read that cost only those metrics: every 4xx but 401 (the token), 408 and 429
 *  (try again — the next poll does). Render's rule for its metrics endpoints. */
const metricUnavailable = (status: number): boolean => status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;

// ── deploys ──────────────────────────────────────────────────────────────────

const DEPLOYMENTS_QUERY = `query($e: String!, $s: String!, $first: Int!) {
  deployments(first: $first, input: { environmentId: $e, serviceId: $s }) {
    edges { node { id status createdAt statusUpdatedAt projectId url staticUrl meta } }
  }
}`;

/**
 * Railway's `DeploymentStatus` → DEPLOY_STATES. The whole enum (the schema, 2026-10):
 *
 *   QUEUED, WAITING, INITIALIZING, NEEDS_APPROVAL   → queued
 *   BUILDING, DEPLOYING                             → building
 *   SUCCESS, SLEEPING                               → ready     (SLEEPING: live, idled by App Sleeping)
 *   REMOVING, REMOVED                               → ready     replaced by a newer deployment — it landed
 *                                                               (UNCONFIRMED, see the header)
 *   FAILED, CRASHED                                 → error
 *   SKIPPED                                         → canceled  never ran (not a failure)
 *
 * Anything else is a status Trov does not know: that deployment is skipped, never guessed.
 */
const STATE: Readonly<Record<string, DeployState>> = {
  QUEUED: "queued", WAITING: "queued", INITIALIZING: "queued", NEEDS_APPROVAL: "queued",
  BUILDING: "building", DEPLOYING: "building",
  SUCCESS: "ready", SLEEPING: "ready", REMOVING: "ready", REMOVED: "ready",
  FAILED: "error", CRASHED: "error",
  SKIPPED: "canceled",
};
/** The statuses whose `statusUpdatedAt` is when the deployment went live or finished failing. */
const FINISHED = new Set(["SUCCESS", "SLEEPING", "FAILED", "CRASHED"]);
/** The statuses that serve the service's domain. */
const SERVING = new Set(["SUCCESS", "SLEEPING"]);

/** An https URL from a field that may be a bare host (`my-app.up.railway.app`) — else null. */
function httpsUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(candidate);
    return u.protocol === "https:" && u.hostname && !u.username && !u.password ? u.toString().replace(/\/$/, "") : null;
  } catch { return null; }
}

const serviceLink = (project: string, ids: Ids): string =>
  `${DASHBOARD}/project/${encodeURIComponent(project)}/service/${encodeURIComponent(ids.service)}?environmentId=${encodeURIComponent(ids.env)}`;

/**
 * One edge of `deployments` → a `HostingDeploy`, or null when it is malformed (no id, an unknown status, no
 * parseable `createdAt`).
 *
 *   sha / branch / message / by   `meta.commitHash` / `branch` / `commitMessage` (first line) / `commitAuthor`
 *                                 — a deployment from an image or the CLI has none of them (null).
 *   target    always `production`: a Railway environment is the part's environment, and a PR environment is
 *             a separate environment with its own id.
 *   url       the deployment's `staticUrl` (else `url`) on a SERVING deployment only, as https.
 *   readyAt   `statusUpdatedAt` once it went live or failed (UNCONFIRMED that it is set then).
 *   inspect   the deployment in Railway's dashboard, from the deployment's own `projectId` (UNCONFIRMED path).
 */
function deployOf(edge: unknown, ids: Ids, auth: RwAuth): HostingDeploy | null {
  const n = record(record(edge).node);
  const id = str(n.id);
  const status = str(n.status);
  const createdAt = instant(n.createdAt);
  const state = status && Object.hasOwn(STATE, status) ? STATE[status] : null;
  if (!id || !RAILWAY_ID.test(id) || !state || !createdAt) return null;
  const meta = record(n.meta);
  const sha = str(meta.commitHash);
  const branch = str(meta.branch);
  const who = str(meta.commitAuthor);
  const message = typeof meta.commitMessage === "string" ? upstream(meta.commitMessage.split(/\r?\n/, 1)[0], auth.revealed, 300) : null;
  const project = str(n.projectId) ?? ids.project;
  return {
    id,
    state,
    target: "production",
    sha: sha && /^[0-9a-f]{7,64}$/i.test(sha) ? sha.toLowerCase() : null,
    branch: branch && PLAIN_LINE.test(branch) ? branch : null,
    message,
    by: who && PLAIN_LINE.test(who) ? who : null,
    createdAt,
    readyAt: status && FINISHED.has(status) ? instant(n.statusUpdatedAt) : null,
    url: status && SERVING.has(status) ? httpsUrl(n.staticUrl) ?? httpsUrl(n.url) : null,
    inspectUrl: project && RAILWAY_ID.test(project) ? `${serviceLink(project, ids)}&id=${encodeURIComponent(id)}` : null,
  };
}

async function readDeploys(pc: ProviderContext, auth: RwAuth, ids: Ids): Promise<HostingDeploy[]> {
  const data = await gqlData(pc, auth, DEPLOYMENTS_QUERY, { e: ids.env, s: ids.service, first: DEPLOY_LIMIT }, "railway deployments");
  const edges = record(data.deployments).edges;
  if (!Array.isArray(edges)) throw new HostingError("railway deployments: the response has no deployments list");
  const seen = new Set<string>();
  const deploys: HostingDeploy[] = [];
  for (const edge of edges) {
    const d = deployOf(edge, ids, auth);
    if (d && !seen.has(d.id)) { seen.add(d.id); deploys.push(d); }
  }
  return deploys.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, DEPLOY_LIMIT);
}

// ── metrics ──────────────────────────────────────────────────────────────────

/** A sample's `ts` → epoch ms: unix seconds (as the schema's `Int` and the old poller read it), or — should
 *  Railway ever send them — milliseconds. Anything else → null. */
const sampleMs = (ts: unknown): number | null =>
  typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : null;

interface Win { from: number; to: number }
type Hours = Map<number, number>;

/** The hour a sample belongs to, when it is one of the window's complete hours — else null. */
function hourOf(ts: unknown, win: Win): { at: number; t: number } | null {
  const t = sampleMs(ts);
  if (t === null) return null;
  const at = hourFloor(t);
  return at >= win.from && at < win.to ? { at, t } : null;
}

/**
 * How each `metrics` measurement is stored: the metric, the ceiling above which a value is not believed
 * (the old poller's: 1024 vCPU / 4096 GB; 10 PB of egress in an hour), the conversion, and whether an hour's
 * samples are a GAUGE (the latest wins — Railway's array order is undocumented) or a SUM (egress).
 */
const MEASUREMENTS: Readonly<Record<string, { metric: HostingMetric; max: number; store: (v: number) => number; sum: boolean }>> = {
  CPU_USAGE: { metric: "cpu", max: 1024, store: (v) => Math.round(v * 10_000) / 10_000, sum: false },
  MEMORY_USAGE_GB: { metric: "mem_mb", max: 4096, store: (v) => Math.round(v * 1024 * 10) / 10, sum: false },
  NETWORK_TX_GB: { metric: "bandwidth_bytes", max: 1e7, store: (v) => Math.round(v * 1024 ** 3), sum: true },
};

/** The `metrics` query of a role — the measurements are fixed enum literals, never a setting. */
const metricsQuery = (measurements: readonly string[]): string =>
  `query($e: String!, $s: String!, $start: DateTime!, $end: DateTime!) {
  metrics(environmentId: $e, serviceId: $s, startDate: $start, endDate: $end, measurements: [${measurements.join(", ")}], sampleRateSeconds: ${STEP_S}) {
    measurement values { ts value }
  }
}`;
const SERVICE_MEASUREMENTS = ["CPU_USAGE", "MEMORY_USAGE_GB"] as const;
const WEB_MEASUREMENTS = ["NETWORK_TX_GB"] as const;

/**
 * One `metrics` read → points. A measurement the query did not ask for is ignored; a sample outside the
 * window, with a malformed `ts`, or a value that is not a finite number in `[0, max]` is skipped on its own.
 */
async function readUsage(pc: ProviderContext, auth: RwAuth, ids: Ids, measurements: readonly string[], win: Win): Promise<HostingPoint[]> {
  const data = await gqlData(pc, auth, metricsQuery(measurements), { e: ids.env, s: ids.service, start: iso(win.from), end: iso(win.to) }, "railway metrics");
  const series = data.metrics;
  if (!Array.isArray(series)) throw new HostingError("railway metrics: no metrics in the response");
  const picked = new Map<HostingMetric, Map<number, { t: number; v: number }>>();
  for (const entry of series) {
    const { measurement, values } = record(entry);
    if (typeof measurement !== "string" || !measurements.includes(measurement) || !Array.isArray(values)) continue;
    const spec = MEASUREMENTS[measurement];
    const hours = picked.get(spec.metric) ?? new Map<number, { t: number; v: number }>();
    picked.set(spec.metric, hours);
    for (const raw of values) {
      const { ts, value } = record(raw);
      const h = hourOf(ts, win);
      if (!h || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > spec.max) continue;
      const held = hours.get(h.at);
      if (spec.sum) hours.set(h.at, { t: Math.max(h.t, held?.t ?? 0), v: (held?.v ?? 0) + value });
      else if (!held || h.t > held.t) hours.set(h.at, { t: h.t, v: value });
    }
  }
  const points: HostingPoint[] = [];
  for (const m of measurements) {
    const spec = MEASUREMENTS[m];
    for (const [at, { v }] of [...(picked.get(spec.metric) ?? [])].sort((a, b) => a[0] - b[0])) {
      const value = spec.store(v);
      if (Number.isFinite(value) && value >= 0) points.push({ metric: spec.metric, at: iso(at), value: value === 0 ? 0 : value });
    }
  }
  return points;
}

const HTTP_STATUS_QUERY = `query($e: String!, $s: String!, $start: DateTime!, $end: DateTime!) {
  httpMetricsGroupedByStatus(environmentId: $e, serviceId: $s, startDate: $start, endDate: $end, stepSeconds: ${STEP_S}) {
    statusCode samples { ts value }
  }
}`;
const HTTP_DURATION_QUERY = `query($e: String!, $s: String!, $start: DateTime!, $end: DateTime!) {
  httpDurationMetrics(environmentId: $e, serviceId: $s, startDate: $start, endDate: $end, stepSeconds: ${STEP_S}) {
    samples { ts p50 p95 }
  }
}`;

const MAX_COUNT = 1e12;
const MAX_MS = 3_600_000;
const HTTP_REFUSED = (why: string): string => `Railway did not answer HTTP metrics for this service: ${why}`;

/** `web`: requests + errors (one read by status code), then p50 / p95 latency for the hours that had
 *  requests. Each read that Railway refuses costs only its metrics. */
async function readHttp(
  pc: ProviderContext, auth: RwAuth, ids: Ids, win: Win,
): Promise<{ points: HostingPoint[]; unavailable: { metric: HostingMetric; reason: string }[]; read: boolean }> {
  const vars = { e: ids.env, s: ids.service, start: iso(win.from), end: iso(win.to) };
  const points: HostingPoint[] = [];
  const unavailable: { metric: HostingMetric; reason: string }[] = [];
  let read = false;

  let requests: Hours | null = null;
  const byStatus = await gql(pc, auth, HTTP_STATUS_QUERY, vars, "railway http metrics", metricUnavailable);
  const groups = "data" in byStatus ? byStatus.data.httpMetricsGroupedByStatus : null;
  if ("refused" in byStatus || !Array.isArray(groups)) {
    const why = "refused" in byStatus ? byStatus.refused : "the response has no status groups";
    for (const metric of ["requests", "errors"] as const) unavailable.push({ metric, reason: HTTP_REFUSED(why) });
  } else {
    read = true;
    requests = new Map();
    const errors: Hours = new Map();
    for (const g of groups) {
      const { statusCode, samples } = record(g);
      if (typeof statusCode !== "number" || !Number.isInteger(statusCode) || !Array.isArray(samples)) continue;
      for (const s of samples) {
        const { ts, value } = record(s);
        const h = hourOf(ts, win);
        const v = typeof value === "number" ? sane(value, MAX_COUNT) : null;
        if (!h || v === null) continue;
        requests.set(h.at, (requests.get(h.at) ?? 0) + v);
        if (statusCode >= 500 && statusCode <= 599) errors.set(h.at, (errors.get(h.at) ?? 0) + v);
      }
    }
    const hours = [...requests.keys()].sort((a, b) => a - b);
    for (const at of hours) points.push({ metric: "requests", at: iso(at), value: Math.round(requests.get(at)!) });
    // An hour with requests and no 5xx group is a MEASURED zero — Railway lists only the statuses it saw.
    for (const at of hours) points.push({ metric: "errors", at: iso(at), value: Math.round(errors.get(at) ?? 0) });
  }

  const duration = await gql(pc, auth, HTTP_DURATION_QUERY, vars, "railway http latency", metricUnavailable);
  const samples = "data" in duration ? record(duration.data.httpDurationMetrics).samples : null;
  if ("refused" in duration || !Array.isArray(samples)) {
    const why = "refused" in duration ? duration.refused : "the response has no latency samples";
    for (const metric of ["latency_p50_ms", "latency_p95_ms"] as const) unavailable.push({ metric, reason: HTTP_REFUSED(why) });
  } else {
    read = true;
    const latest = new Map<number, { t: number; p50: number | null; p95: number | null }>();
    for (const s of samples) {
      const { ts, p50, p95 } = record(s);
      const h = hourOf(ts, win);
      if (!h) continue;
      // An idle hour's percentile is not a reading: with the request count known, only an hour that had
      // requests; without it, only a non-zero value.
      const busy = requests ? (requests.get(h.at) ?? 0) > 0 : true;
      const ms = (v: unknown): number | null => {
        const n = typeof v === "number" ? sane(v, MAX_MS) : null;
        if (n === null || !busy || (requests === null && n === 0)) return null;
        return Math.round(n * 10) / 10;
      };
      const held = latest.get(h.at);
      if (!held || h.t > held.t) latest.set(h.at, { t: h.t, p50: ms(p50), p95: ms(p95) });
    }
    const hours = [...latest].sort((a, b) => a[0] - b[0]);
    for (const [at, v] of hours) if (v.p50 !== null) points.push({ metric: "latency_p50_ms", at: iso(at), value: v.p50 });
    for (const [at, v] of hours) if (v.p95 !== null) points.push({ metric: "latency_p95_ms", at: iso(at), value: v.p95 });
  }
  return { points, unavailable, read };
}

// ── the probe's queries ──────────────────────────────────────────────────────

const PART_PROBE_QUERY = `query($e: String!, $s: String!) {
  serviceInstance(environmentId: $e, serviceId: $s) { serviceName environmentId }
  environment(id: $e) { name projectId }
}`;
const WORKSPACE_PROBE_QUERY = `query($w: String!) { workspace(workspaceId: $w) { id name } }`;
const PROJECTS_PROBE_QUERY = `query { projects(first: 1) { edges { node { id name } } } }`;

// ── the provider ─────────────────────────────────────────────────────────────

export const railway: HostingProvider = {
  id: "railway",
  label: "Railway",
  status: "available",
  summary: "A Railway service. Trov reads its deploys, and its traffic or CPU and memory.",
  roles: ["web", "service"],
  apiHosts: ["backboard.railway.com"],
  docsUrl: "https://docs.railway.com/reference/public-api",
  connectionMethods: [
    {
      method: "token",
      label: "Paste a workspace token",
      howTo: "In Railway open Account Settings › Tokens (railway.com/account/tokens), create a token and, in its Workspace dropdown, pick the workspace that owns the project — a WORKSPACE token, limited to that workspace, is the narrowest Railway offers. An account token (\"No workspace\") also works but reaches every workspace you belong to; a project token does not work (it is bound to one environment). Railway has no read-only scope: the token can also change what is in its workspace. The token is only ever sent to backboard.railway.com.",
      grants: ["Full access to one Railway workspace — everything in it (Railway has no read-only token)"],
    },
  ],
  orgConfigFields: [
    {
      key: "workspace_id", label: "Workspace ID",
      description: "Optional. The Railway workspace the token belongs to (Workspace settings). Test connection then checks the token against it. Not a secret.",
      required: false, pattern: RAILWAY_ID,
    },
  ],
  partSettings: [
    { key: "environment_id", label: "Railway environment ID", description: "The environment's id: Project › Settings › Environments, or environmentId= in the service's URL.", required: true, pattern: RAILWAY_ID },
    { key: "service_id", label: "Railway service ID", description: "The service's id: its Settings tab, or the part after /service/ in its URL. The same in every environment.", required: true, pattern: RAILWAY_ID },
    { key: "project_id", label: "Railway project ID", description: "Optional. The project's id (Project › Settings, or the part after /project/ in its URL) — only for the Open in Railway link.", required: false, pattern: RAILWAY_ID },
  ],
  capabilities: { deploys: true, metrics: ["requests", "errors", "latency_p50_ms", "latency_p95_ms", "bandwidth_bytes", "cpu", "mem_mb"] },
  planNote: null,
  // web: deployments (1) + egress (1) + HTTP by status (1) + HTTP latency (1) = 4; service: 2.
  pollCost: 4,
  // Account and workspace tokens are both created and deleted on the account's Tokens page.
  manageUrl(_config, method) {
    return method === "token" ? `${DASHBOARD}/account/tokens` : null;
  },
  consoleUrl(part) {
    const { environment_id: env, service_id: service, project_id: project } = part.settings;
    return env && service && project && RAILWAY_ID.test(env) && RAILWAY_ID.test(service) && RAILWAY_ID.test(project)
      ? serviceLink(project, { env, service, project })
      : null;
  },

  async probe(pc: ProviderContext, part: PartRef | null): Promise<ProbeResult> {
    try {
      const auth = rwAuth(pc);
      if (part) {
        const ids = partIds(part);
        const data = await gqlData(pc, auth, PART_PROBE_QUERY, { e: ids.env, s: ids.service }, "railway service");
        const instance = record(data.serviceInstance);
        const env = record(data.environment);
        if (!str(instance.serviceName) && !str(instance.environmentId)) throw new HostingError("railway service: the response has no service instance");
        const project = str(env.projectId);
        if (ids.project && project && project !== ids.project) {
          return { ok: false, detail: "Railway answered, but that environment belongs to a different project than the project ID set here." };
        }
        const service = upstream(instance.serviceName, auth.revealed, 80) ?? ids.service;
        const envName = upstream(env.name, auth.revealed, 80);
        return { ok: true, detail: envName ? `Railway answered for service ${service} in ${envName}.` : `Railway answered for service ${service}.` };
      }
      const configured = pc.credential.config.workspace_id;
      if (configured && RAILWAY_ID.test(configured)) {
        const ws = record((await gqlData(pc, auth, WORKSPACE_PROBE_QUERY, { w: configured }, "railway workspace")).workspace);
        const name = upstream(ws.name, auth.revealed, 80);
        return { ok: true, detail: name ? `Railway answered for workspace ${name}.` : "Railway answered for the workspace." };
      }
      const edges = record((await gqlData(pc, auth, PROJECTS_PROBE_QUERY, {}, "railway projects")).projects).edges;
      if (!Array.isArray(edges)) throw new HostingError("railway projects: the response has no projects list");
      return { ok: true, detail: edges.length ? "Railway answered: the token can see the workspace's projects." : "Railway answered, but the token sees no project." };
    } catch (e) {
      return probeFailure("railway", e);
    }
  },

  async poll(pc: ProviderContext, part: PartRef): Promise<PollResult> {
    const auth = rwAuth(pc);
    const ids = partIds(part);
    const deploys = await readDeploys(pc, auth, ids);
    const win = pollWindow(pc.now);
    const covered = { from: iso(win.from), to: iso(win.to) };
    if (part.role === "service") {
      const points = await readUsage(pc, auth, ids, SERVICE_MEASUREMENTS, win);
      return { deploys, points, unavailable: [], covered };
    }
    const usage = await readUsage(pc, auth, ids, WEB_MEASUREMENTS, win);
    const http = await readHttp(pc, auth, ids, win);
    // The egress read always succeeded here (a refusal throws), so the window is covered.
    return { deploys, points: [...http.points, ...usage], unavailable: http.unavailable, covered };
  },
};
