// Fly.io (#101). One Fly APP per environment part (Fly has no preview deploys: an environment is its own app,
// e.g. myapp-staging / myapp), read with ONE org-wide credential:
//
//   connection   a READ-ONLY org token — `fly tokens create readonly <org> --name trov --expiry 8760h` — a
//                macaroon that can read one organization and change nothing; the narrowest Fly offers (there is
//                no integration or OAuth app for API access). Never `fly auth token`: that is the person's own
//                token, with full write access to every organization they belong to.
//   deploys      the app's RELEASES — flyctl's own REST route (`GET api.fly.io/api/v1/apps/<app>/releases`,
//                internal/uiex/releases.go in superfly/flyctl), which Fly does NOT document. A release carries
//                a version, a status and who ran it, but no commit SHA, no branch and no URL of its own.
//   metrics      Fly's hosted Prometheus (VictoriaMetrics underneath) at `api.fly.io/prometheus/<org>/`: the
//                edge's HTTP counters and latency histogram for a `web` part, the machines' CPU and memory for
//                a `service` part. Fly keeps ≈ 15 days, far more than the 3-hour poll window needs.
//   probe        the Machines API's `GET api.machines.dev/v1/apps/<app>` (documented) — the app exists, the
//                token sees it, and it belongs to the configured organization — then one Prometheus instant
//                query, so "Test connection passes" also means the metric read will.
//
// THE HEADER (fly-go `tokens.Parse` + `normalized()`, superfly/fly-go tokens/tokens.go): `fly tokens create`
// prints `FlyV1 fm2_…,fm2_…` — a scheme, then comma-separated macaroons (the token and its discharges). The
// stored value is normalised the way fly-go does it: any leading `FlyV1` / `Bearer` scheme stripped
// (case-insensitive, repeatedly), split on commas, each piece trimmed. A piece whose prefix before `_` is
// `fm1r` / `fm1a` / `fm2` is a macaroon; when there is at least one, the header is `FlyV1 <macaroons joined
// by ",">` (the Machines API's `FlapsHeader`, and what fly-go's GraphQL transport sends to api.fly.io);
// otherwise the value is a legacy personal token and travels as `Bearer <token>`. UNCONFIRMED: flyctl's own
// releases client sends `Bearer <macaroons>` to api.fly.io — that the same host also takes `FlyV1` there
// (it does for its GraphQL and logs routes) is the owner's first live check, with whether a READ-ONLY token
// may read Prometheus and the releases route at all.
//
// A Prometheus sample at T for `increase(x[1h])` / `rate(x[1h])` / `avg_over_time(x[1h])` describes the hour
// BEFORE T, so the range query runs `start = from + 1h … end = to` at `step = 1h` and each sample is stored at
// `at = T − 1h`: exactly the window's three complete, settled hours, no more. A sample at any other instant
// (unaligned, before the window, at or after its end) is dropped — never re-bucketed — and NaN / ±Inf (a
// quantile over an idle hour) is skipped: no point, never a zero.
import type { DeployState, HostingMetric } from "@shared/hosting";
import type { HostingDeploy, HostingPoint, HostingProvider, PartRef, PollResult, ProbeResult, ProviderContext } from "../types";
import {
  HOUR, HostingError, asHostingError, instant, iso, num, pollWindow, probeFailure, readJson, record, refuse, str, type Revealed,
} from "../http";

const MACHINES_HOST = "api.machines.dev";
const API_HOST = "api.fly.io";

const ORG_SLUG = /^[a-z0-9-]{1,63}$/;
const APP_NAME = /^[a-z0-9-]{2,63}$/;

/** Releases asked for per poll — the contract's "≤ 20, newest first". */
const RELEASES_LIMIT = 20;

// ── the credential ──────────────────────────────────────────────────────────

/** fly-go's macaroon prefixes (the part of a piece before its first `_`). Anything else is a legacy token. */
const MACAROON_PREFIXES = new Set(["fm1r", "fm1a", "fm2"]);

/** fly-go `StripAuthorizationScheme`: drop a leading `Bearer` / `FlyV1` (any case), as often as it repeats.
 *  One departure: a value that is ONLY a scheme is empty here (fly-go would send the word as a token). */
function stripScheme(token: string): string {
  let t = token.trim();
  for (;;) {
    if (/^(bearer|flyv1)$/i.test(t)) return "";
    const m = /^(\S+)\s+([\s\S]*)$/.exec(t);
    if (!m || !/^(bearer|flyv1)$/i.test(m[1])) return t;
    t = m[2].trim();
  }
}

interface FlyAuth {
  header: string;
  /** Everything a refusal could quote back: the stored value, every piece of it, and the header itself — a
   *  response that echoes ONE macaroon of several would slip past a scrub of the whole joined string. */
  revealed: Revealed;
}

function flyAuth(pc: ProviderContext): FlyAuth {
  const stored = pc.credential.secret.reveal();
  const pieces = stripScheme(stored).split(",").map((p) => p.trim()).filter(Boolean);
  // A header value cannot carry whitespace inside a token or a control character; refuse in fixed words
  // rather than let `fetch` throw on it (or send half of it).
  if (!pieces.length || pieces.some((p) => !/^[\x21-\x7e]+$/.test(p))) {
    throw new HostingError("the Fly.io token is not in the expected form — paste the whole output of fly tokens create readonly", [stored, ...pieces]);
  }
  const macaroons = pieces.filter((p) => MACAROON_PREFIXES.has(p.split("_")[0]));
  const header = macaroons.length ? `FlyV1 ${macaroons.join(",")}` : `Bearer ${pieces.join(",")}`;
  return { header, revealed: [pc.credential.secret, stored, ...pieces, header] };
}

/** The org slug (the Prometheus path segment) and, given a part, its app — re-checked here although the
 *  framework validated them: neither ever reaches a URL or a PromQL string unless it matches its pattern. */
function orgSlug(pc: ProviderContext): string {
  const org = pc.credential.config.org_slug;
  if (!org || !ORG_SLUG.test(org)) throw new HostingError("the Fly.io organization slug is not set — fly orgs list shows it");
  return org;
}

function appName(part: PartRef): string {
  const app = part.settings.app;
  if (!app || !APP_NAME.test(app)) throw new HostingError("the part's Fly.io app name is not set or not in the expected form");
  return app;
}

// ── requests ────────────────────────────────────────────────────────────────

const NOT_VALID = "the token is not valid or has expired — create a new one with fly tokens create readonly";
const MACHINES_HINTS = { 401: NOT_VALID, 403: "the token cannot read this app — it must be a read-only token for the app's organization", 404: "no app by that name that the token can see" };
const RELEASES_HINTS = { 401: NOT_VALID, 403: "the token cannot read this app's releases" };
const PROM_HINTS = { 401: NOT_VALID, 403: "the token cannot read this organization's metrics — check the organization slug", 404: "no metrics for that organization slug — check it (fly orgs list)" };

const MISSING = Symbol("missing");

/** One authenticated GET through the fixed-host fetch → parsed JSON. `missingOk`: a 404 answers `MISSING`
 *  instead of throwing. Anything thrown is a `HostingError` whose message never quotes the request. */
async function flyGet(
  pc: ProviderContext, auth: FlyAuth, url: string, what: string, hints: Readonly<Record<number, string>>, missingOk = false,
): Promise<unknown> {
  let res: Response;
  try {
    res = await pc.fetch(url, { headers: { authorization: auth.header, accept: "application/json" } });
  } catch (e) { throw asHostingError(what, e); }
  if (missingOk && res.status === 404) { await res.body?.cancel().catch(() => undefined); return MISSING; }
  if (!res.ok) await refuse(what, res, auth.revealed, hints);
  try { return await readJson(res, what); } catch (e) { throw asHostingError(what, e); }
}

/** The Machines API's app: `{ id, name, status, organization: { name, slug } }` (fly-go flaps `App`). */
async function getApp(pc: ProviderContext, auth: FlyAuth, app: string): Promise<Record<string, unknown>> {
  return record(await flyGet(pc, auth, `https://${MACHINES_HOST}/v1/apps/${encodeURIComponent(app)}`, "fly.io app", MACHINES_HINTS));
}

/** The fixed-text reason the app is NOT in `org`, or null. An answer naming no organization is not a
 *  mismatch: a read-only token sees only its own organization's apps, and the Prometheus read (whose path IS
 *  the slug) is what proves the slug. */
function otherOrg(appBody: Record<string, unknown>, app: string, org: string): string | null {
  const slug = str(record(appBody.organization).slug);
  return slug && slug !== org
    ? `Fly.io app ${app} belongs to another organization than ${org} — set the organization slug the read-only token was created for`
    : null;
}

/**
 * A Prometheus API call (`query` or `query_range`) → `data.result`. Prometheus reports a refused query as
 * `{ status: "error", errorType, error }` — with a 4xx (which `refuse` reads, `error` being the reason it
 * looks for) or, from some proxies, a 200; the 200 case is refused here with the same scrubbed text
 * (`HostingError` scrubs the WHOLE text before it cuts).
 */
async function promQuery(
  pc: ProviderContext, auth: FlyAuth, org: string, path: "query" | "query_range", params: Record<string, string>, what: string,
): Promise<{ resultType: string | null; result: unknown[] }> {
  const url = `https://${API_HOST}/prometheus/${encodeURIComponent(org)}/api/v1/${path}?${new URLSearchParams(params).toString()}`;
  const body = record(await flyGet(pc, auth, url, what, PROM_HINTS));
  if (body.status === "error") throw new HostingError(`${what}: ${str(body.error) ?? "the query was refused"}`, auth.revealed);
  const data = record(body.data);
  if (body.status !== "success" || !Array.isArray(data.result)) throw new HostingError(`${what}: the response is not a Prometheus answer`);
  return { resultType: str(data.resultType), result: data.result };
}

// ── metrics ─────────────────────────────────────────────────────────────────

/** A PromQL double-quoted string. The app name matched `APP_NAME` already (no quote, no backslash can be in
 *  it) — this is the second lock, so no setting is ever interpolated raw. */
const promString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"`;

interface FlyQuery {
  metric: HostingMetric;
  promql: (app: string) => string;
  /** Plausibility bound — over it the point is skipped (a stored point is permanent). */
  max: number;
  /** From the query's unit to the vocabulary's. */
  store: (v: number) => number;
  /** Several series (never expected: every query aggregates to one) may be summed; a quantile may not. */
  additive: boolean;
}

const round = (v: number, places: number): number => { const f = 10 ** places; return Math.round(v * f) / f; };

// `increase` over a counter: Prometheus extrapolates to the range's edges, so a count arrives as a float —
// rounded to a whole count. UNCONFIRMED: that the edge counter's `status` label holds the exact code ("503")
// rather than a class ("5xx") — `5..` matches either spelling.
const WEB_QUERIES: readonly FlyQuery[] = [
  { metric: "requests", additive: true, max: 1e12, store: Math.round,
    promql: (a) => `sum(increase(fly_edge_http_responses_count{app=${promString(a)}}[1h]))` },
  { metric: "errors", additive: true, max: 1e12, store: Math.round,
    promql: (a) => `sum(increase(fly_edge_http_responses_count{app=${promString(a)},status=~"5.."}[1h]))` },
  // Seconds → ms. The quantile of an hour with no requests is NaN (0 / 0) — skipped, never a zero latency.
  { metric: "latency_p95_ms", additive: false, max: 1e7, store: (v) => round(v, 1),
    promql: (a) => `histogram_quantile(0.95, sum(rate(fly_edge_http_response_time_seconds_bucket{app=${promString(a)}}[1h])) by (le)) * 1000` },
  { metric: "bandwidth_bytes", additive: true, max: 1e15, store: Math.round,
    promql: (a) => `sum(increase(fly_edge_data_out{app=${promString(a)}}[1h]))` },
];

const SERVICE_QUERIES: readonly FlyQuery[] = [
  // `fly_instance_cpu` counts CENTISECONDS of CPU per mode: its per-second rate ÷ 100 is the average number
  // of busy vCPUs over the hour, summed over the app's machines.
  { metric: "cpu", additive: true, max: 1e5, store: (v) => round(v, 3),
    promql: (a) => `sum(rate(fly_instance_cpu{app=${promString(a)},mode!="idle"}[1h])) / 100` },
  // Bytes in use (total − available, each averaged over the hour, matched per machine), summed, → MB.
  { metric: "mem_mb", additive: true, max: 1e8, store: (v) => round(v, 1),
    promql: (a) => `sum(avg_over_time(fly_instance_memory_mem_total{app=${promString(a)}}[1h]) - avg_over_time(fly_instance_memory_mem_available{app=${promString(a)}}[1h])) / 1048576` },
];

/** What a `web` part cannot show from Fly. The p50 is in the same histogram, but the dashboard shows a p95
 *  only, so it is not read (a query per poll the screen would never use). */
const WEB_UNAVAILABLE: readonly { metric: HostingMetric; reason: string }[] = [
  { metric: "latency_p50_ms", reason: "Trov reads Fly.io's edge latency as a p95 only" },
];

/** A Prometheus sample value: a decimal string. "NaN", "+Inf", "-Inf" and anything else → null. */
const PROM_NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const promValue = (v: unknown): number | null => (typeof v === "string" && PROM_NUMBER.test(v) ? Number(v) : null);
/** A sample's timestamp: unix seconds, a JSON number (possibly fractional) — or its decimal string. */
const promTime = (v: unknown): number | null => num(v) ?? (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null);

/**
 * A matrix → `{ at → value }` for the window's hours. Each sample at T (unix seconds, possibly fractional)
 * belongs to the hour starting T − 1h; one at any other instant, or outside `[from, to)`, is dropped, and a
 * malformed one is skipped on its own. With several series (none expected), an additive query sums them and
 * a quantile is left unread.
 */
function hourValues(result: unknown[], q: FlyQuery, from: number, to: number): Map<number, number> {
  const out = new Map<number, number>();
  if (result.length > 1 && !q.additive) return out;
  for (const series of result) {
    const values = record(series).values;
    if (!Array.isArray(values)) continue;
    for (const sample of values) {
      if (!Array.isArray(sample) || sample.length !== 2) continue;
      const t = promTime(sample[0]);
      const v = promValue(sample[1]);
      if (t === null || v === null || !Number.isFinite(v) || v < 0) continue;
      const end = Math.round(t * 1000);
      if (end % HOUR !== 0) continue;
      const at = end - HOUR;
      if (at < from || at >= to) continue;
      out.set(at, (out.get(at) ?? 0) + v);
    }
  }
  return out;
}

async function readMetrics(pc: ProviderContext, auth: FlyAuth, org: string, app: string, queries: readonly FlyQuery[], from: number, to: number): Promise<HostingPoint[]> {
  const params = { start: String((from + HOUR) / 1000), end: String(to / 1000), step: String(HOUR / 1000) };
  const read = new Map<HostingMetric, Map<number, number>>();
  for (const q of queries) {
    const { resultType, result } = await promQuery(pc, auth, org, "query_range", { query: q.promql(app), ...params }, `fly.io metrics (${q.metric})`);
    if (resultType !== null && resultType !== "matrix") throw new HostingError(`fly.io metrics (${q.metric}): the response is not a range result`);
    const stored = new Map<number, number>();
    for (const [at, raw] of hourValues(result, q, from, to)) {
      const value = q.store(raw);
      if (Number.isFinite(value) && value >= 0 && value < q.max) stored.set(at, value === 0 ? 0 : value); // no -0
    }
    read.set(q.metric, stored);
  }
  // The 5xx series exists only once the app has answered a 5xx: Prometheus keeps no series for a status that
  // never happened, so an hour with a stored request count that the errors query (which succeeded) left
  // empty is a MEASURED zero, not a gap. Written explicitly so an error rate can be drawn for that hour.
  const requests = read.get("requests"), errors = read.get("errors");
  if (requests && errors) for (const at of requests.keys()) if (!errors.has(at)) errors.set(at, 0);

  return queries.flatMap((q) => [...(read.get(q.metric) ?? [])]
    .sort((a, b) => a[0] - b[0])
    .map(([at, value]): HostingPoint => ({ metric: q.metric, at: iso(at), value })));
}

// ── deploys ─────────────────────────────────────────────────────────────────

/**
 * A release's `status` → DEPLOY_STATES. flyctl itself writes `running` when a deploy starts, then
 * `complete` / `failed` / `interrupted` (internal/command/deploy/machines_deploymachinesapp.go); the rest are
 * accepted spellings of the same outcomes. UNCONFIRMED: the full set the backend may report (a release
 * created but not yet started is assumed `pending`). A status not listed is SKIPPED — unless the release
 * says `in_progress: true`, which is `building` — never guessed.
 *
 *   complete, succeeded                 → ready
 *   failed                              → error
 *   interrupted, cancelled, canceled    → canceled   (abandoned, not a failure)
 *   running, pending, in_progress       → building
 *   anything else, in_progress true     → building
 *   anything else                       → skipped
 */
const RELEASE_STATE: Readonly<Record<string, DeployState>> = {
  complete: "ready", succeeded: "ready",
  failed: "error",
  interrupted: "canceled", cancelled: "canceled", canceled: "canceled",
  running: "building", pending: "building", in_progress: "building",
};

const PLAIN_LINE = /^[^\u0000-\u001f\u007f]{1,200}$/;

function releaseDeploy(raw: unknown, app: string): HostingDeploy | null {
  const r = record(raw);
  const status = str(r.status)?.toLowerCase() ?? "";
  const state: DeployState | null = RELEASE_STATE[status] ?? (r.in_progress === true ? "building" : null);
  if (!state) return null;
  const createdAt = instant(r.created_at);
  if (!createdAt) return null;
  const version = num(r.version);
  const v = version !== null && Number.isInteger(version) && version >= 0 ? version : null;
  const rawId = str(r.id) ?? (typeof r.id === "number" && Number.isFinite(r.id) ? String(r.id) : null);
  const id = rawId && PLAIN_LINE.test(rawId) ? rawId : v !== null ? `v${v}` : null;
  if (!id) return null;
  // flyctl's strategies are UPPER_SNAKE (ROLLING, BLUEGREEN, CANARY, IMMEDIATE, ROLLING_ONE…): shown lower-case.
  const strategy = str(r.strategy);
  const how = strategy && /^[A-Za-z_ -]{1,30}$/.test(strategy) ? strategy.toLowerCase().replace(/_/g, " ") : null;
  // flyctl's REST `Release.user` is a string (an email); the GraphQL one is `{ email, name }` — take either.
  const u = r.user;
  const who = typeof u === "string" ? str(u) : str(record(u).email) ?? str(record(u).name);
  return {
    id,
    state,
    target: "production", // one app per environment: every release is that environment's live deploy
    sha: null, // a release carries an image ref, not a commit
    branch: null,
    message: v !== null ? (how ? `v${v} · ${how}` : `v${v}`) : null,
    by: who && PLAIN_LINE.test(who) ? who : null,
    createdAt,
    readyAt: null, // a release reports no finish time
    url: `https://${app}.fly.dev`,
    inspectUrl: `https://fly.io/apps/${encodeURIComponent(app)}/releases`,
  };
}

/**
 * The app's newest releases, newest first. A 404 is read as "this route is gone" (it is undocumented) only
 * once the documented Machines API confirms the app exists in the organization — otherwise a typo in the
 * app name would read as a live app with no deploys AND (Prometheus answers an unknown app with an empty
 * result) a covered window of true zeros. That second fetch happens only on the 404 path.
 */
async function readReleases(pc: ProviderContext, auth: FlyAuth, org: string, app: string): Promise<HostingDeploy[]> {
  const url = `https://${API_HOST}/api/v1/apps/${encodeURIComponent(app)}/releases?limit=${RELEASES_LIMIT}`;
  const body = await flyGet(pc, auth, url, "fly.io releases", RELEASES_HINTS, true);
  if (body === MISSING) {
    const wrong = otherOrg(await getApp(pc, auth, app), app, org);
    if (wrong) throw new HostingError(wrong);
    return [];
  }
  const list = Array.isArray(body) ? body : record(body).releases;
  if (!Array.isArray(list)) throw new HostingError("fly.io releases: the response has no releases list");
  const deploys: { d: HostingDeploy; v: number }[] = [];
  for (const raw of list) {
    const d = releaseDeploy(raw, app);
    if (d) deploys.push({ d, v: num(record(raw).version) ?? -1 });
  }
  return deploys
    .sort((a, b) => Date.parse(b.d.createdAt) - Date.parse(a.d.createdAt) || b.v - a.v)
    .slice(0, RELEASES_LIMIT)
    .map((x) => x.d);
}

// ── the provider ────────────────────────────────────────────────────────────

export const fly: HostingProvider = {
  id: "fly",
  label: "Fly.io",
  status: "available",
  summary: "A Fly.io app: requests, server errors, p95 latency and bandwidth (web) or CPU and memory (service) from Fly's Prometheus metrics; its releases as deploys (version only — Fly reports no commit).",
  roles: ["web", "service"],
  apiHosts: [MACHINES_HOST, API_HOST],
  docsUrl: "https://fly.io/docs/monitoring/metrics/",
  credentialScope: "org",
  connectionMethods: [
    {
      method: "token",
      label: "Paste a read-only token",
      howTo: "Run fly tokens create readonly <org-slug> --name trov --expiry 8760h (fly orgs list shows the slug) and paste the whole output — a leading \"FlyV1 \" is fine. It is a READ-ONLY token for one organization, the narrowest Fly.io offers: it can read that organization's apps, releases and metrics and change nothing. Never paste the output of fly auth token — that is your personal token, with full access to every organization you belong to. The token stops working after its --expiry (8760h is one year); create a new one before then. It is only ever sent to api.machines.dev and api.fly.io.",
      grants: ["Read-only access to one Fly.io organization: its apps, releases and metrics"],
    },
  ],
  orgConfigFields: [
    { key: "org_slug", label: "Organization slug", description: "The organization the read-only token was created for — fly orgs list shows it (a personal organization is \"personal\"). Metrics are read from it.", required: true, placeholder: "my-org", pattern: ORG_SLUG },
  ],
  partSettings: [
    { key: "app", label: "App name", description: "The Fly.io app this part runs as — one app per environment, e.g. myapp-staging (fly apps list).", required: true, placeholder: "myapp-staging", pattern: APP_NAME },
  ],
  capabilities: { deploys: true, metrics: ["requests", "errors", "latency_p95_ms", "bandwidth_bytes", "cpu", "mem_mb"] },
  planNote: null,
  // Worst case, a web part: releases (1) + the Machines app check, only when releases answers 404 (1) + four
  // metric queries (4) = 6. A service part: 1 + 1 + 2 = 4.
  pollCost: 6,
  consoleUrl(part) {
    const app = part.settings.app;
    return app && APP_NAME.test(app) ? `https://fly.io/apps/${encodeURIComponent(app)}` : null;
  },

  async probe(pc: ProviderContext, part: PartRef | null): Promise<ProbeResult> {
    try {
      const auth = flyAuth(pc);
      const org = orgSlug(pc);
      if (!part) {
        // The token and the org slug together: an instant query only that org's reader may make.
        await promQuery(pc, auth, org, "query", { query: "count(fly_instance_up)" }, "fly.io metrics");
        return { ok: true, detail: `Fly.io answered for organization ${org}.` };
      }
      const app = appName(part);
      const body = await getApp(pc, auth, app);
      const wrong = otherOrg(body, app, org);
      if (wrong) return { ok: false, detail: wrong };
      await promQuery(pc, auth, org, "query", { query: `count(fly_instance_up{app=${promString(app)}})` }, "fly.io metrics");
      const status = str(body.status);
      return { ok: true, detail: status && /^[A-Za-z_ -]{1,30}$/.test(status) ? `Fly.io answered for app ${app} (${status}).` : `Fly.io answered for app ${app}.` };
    } catch (e) {
      return probeFailure("fly.io", e);
    }
  },

  async poll(pc: ProviderContext, part: PartRef): Promise<PollResult> {
    const auth = flyAuth(pc);
    const org = orgSlug(pc);
    const app = appName(part);
    const deploys = await readReleases(pc, auth, org, app);
    const { from, to } = pollWindow(pc.now);
    const queries = part.role === "web" ? WEB_QUERIES : SERVICE_QUERIES;
    const points = await readMetrics(pc, auth, org, app, queries, from, to);
    return {
      deploys,
      points,
      unavailable: part.role === "web" ? WEB_UNAVAILABLE.map((u) => ({ ...u })) : [],
      covered: { from: iso(from), to: iso(to) },
    };
  },
};
