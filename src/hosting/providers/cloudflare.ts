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
//   one poll     deployments (1) + analytics (1) = 2 (`pollCost`).
//
// Every message is scrubbed of the token — and of the account id, as the old poller did: Cloudflare's own
// errors can name the account they refused — BEFORE it is cut (../http.ts). Nothing is logged here.
import type { HostingMetric } from "@shared/hosting";
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
const PLAIN_LINE = /^[^\u0000-\u001f\u007f]{1,200}$/;

/** Deployments kept per poll — the contract's "≤ 20, newest first". */
const DEPLOY_LIMIT = 20;

/** Cloudflare's schema spells its scalar `string`, LOWERCASE — `String!` is rejected as an unknown type.
 *  `Time` is theirs too. `limit: 100` is far more than the ≤ 4 hourly groups one Worker returns for the
 *  window (three hours, `datetime_leq` inclusive). The old poller's query, unchanged. */
const ANALYTICS_QUERY = `query($a: string!, $s: string!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $a }) {
    workersInvocationsAdaptive(limit: 100, filter: { scriptName: $s, datetime_geq: $from, datetime_leq: $to }, orderBy: [datetimeHour_ASC]) {
      dimensions { datetimeHour }
      sum { requests errors }
    }
  } }
}`;

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

/**
 * Rows → points: `requests` and `errors` for each hour of `[from, to)`, an hour per row. A row outside the
 * window, the row AT `to` (the inclusive end), and a malformed one (an unparseable hour, a count that is not
 * a finite number ≥ 0) are skipped on their own — never repaired, never aborting the rows after them. Two
 * rows for one hour (never expected) are summed.
 */
function hourPoints(rows: unknown[], from: number, to: number): HostingPoint[] {
  const hours = new Map<number, { requests: number; errors: number }>();
  for (const row of rows) {
    const r = record(row);
    const hour = record(r.dimensions).datetimeHour;
    const at = typeof hour === "string" ? Date.parse(hour) : Number.NaN;
    const sum = record(r.sum);
    const requests = typeof sum.requests === "number" ? sane(sum.requests, MAX_COUNT) : null;
    const errors = typeof sum.errors === "number" ? sane(sum.errors, MAX_COUNT) : null;
    if (!Number.isFinite(at) || at % HOUR !== 0 || at < from || at >= to || requests === null || errors === null) continue;
    const held = hours.get(at) ?? { requests: 0, errors: 0 };
    hours.set(at, { requests: held.requests + Math.round(requests), errors: held.errors + Math.round(errors) });
  }
  const sorted = [...hours].sort((a, b) => a[0] - b[0]);
  return [
    ...sorted.map(([at, v]): HostingPoint => ({ metric: "requests", at: iso(at), value: v.requests })),
    ...sorted.map(([at, v]): HostingPoint => ({ metric: "errors", at: iso(at), value: v.errors })),
  ];
}

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

/** The script's deployments → its newest ≤ 20, newest first. A body with no deployments list is refused. */
async function readDeployments(pc: ProviderContext, auth: CfAuth, worker: string): Promise<HostingDeploy[]> {
  const url = `${API}/accounts/${encodeURIComponent(auth.account)}/workers/scripts/${encodeURIComponent(worker)}/deployments`;
  const body = await cfRequest(pc, auth, url, "cloudflare deployments", SCRIPTS_HINTS);
  const list = record(body.result).deployments;
  if (!Array.isArray(list)) throw new HostingError("cloudflare deployments: the response has no deployments list");
  const seen = new Set<string>();
  const deploys: HostingDeploy[] = [];
  for (const raw of list) {
    const d = deployOf(raw, auth, worker);
    if (d && !seen.has(d.id)) { seen.add(d.id); deploys.push(d); }
  }
  // A stable sort: two deployments of one instant keep Cloudflare's order (its first is the live one).
  return deploys.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, DEPLOY_LIMIT);
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
      howTo: "In the Cloudflare dashboard open My Profile › API Tokens › Create Token › Create Custom Token and grant exactly two permissions: Account › Account Analytics › Read and Account › Workers Scripts › Read, with Account Resources limited to the ONE account your Workers live under. Both are read-only. Paste the token here and set Account ID to that account's 32-character id (Workers & Pages › Overview). The token is only ever sent to api.cloudflare.com.",
      grants: ["Account Analytics: Read on one account", "Workers Scripts: Read on that account (its Workers' deployments)"],
    },
  ],
  orgConfigFields: [
    { key: "account_id", label: "Account ID", description: "The 32-character id of the Cloudflare account the Workers live under. Not a secret.", required: true, placeholder: "0123456789abcdef0123456789abcdef", pattern: ACCOUNT_ID },
  ],
  partSettings: [
    { key: "worker", label: "Worker name", description: "The Worker script's name, as Workers & Pages lists it.", required: true, placeholder: "frontend-staging", pattern: WORKER },
  ],
  capabilities: { deploys: true, metrics: ["requests", "errors"] },
  planNote: null,
  // Deployments (1) + analytics (1).
  pollCost: 2,
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
    try {
      deploys = await readDeployments(pc, auth, worker);
    } catch (e) {
      if (!(e instanceof HostingError && e.status === 403)) throw e;
    }
    const { from, to } = pollWindow(pc.now);
    const rows = await readAnalytics(pc, auth, worker, from, to, "cloudflare analytics");
    return {
      deploys,
      points: hourPoints(rows, from, to),
      unavailable: WEB_UNAVAILABLE.map((u) => ({ ...u })),
      covered: { from: iso(from), to: iso(to) },
    };
  },
};
