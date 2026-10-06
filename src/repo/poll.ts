// Scheduled pulls for the repo dashboard — health pings, Cloudflare Workers
// analytics, Railway CPU/memory, Sapling's active users and product metrics
// (ONE request answers both). Each writes
// repo_metrics (the Cloudflare poll also its `cf_polled` snapshot); none may
// throw — a dead target or a bad token costs one data point, never the cron tick.
import type { PollOutcome } from "@shared/repo";
import type { TenantContext } from "../data/sql";
import type { RepoEnvConfig } from "./config";
import { countMetric, totalMetric } from "./product";
import { getSnapshot, putMetric, putMetrics, putSnapshot } from "./store";
import { CF_POLLED, CF_POLL_HOURS, cfCovered, type CfPolled, type RepoMetric } from "./types";

export type { PollOutcome };

/** What the three HOURLY pollers below hand back — one entry per configured
 *  environment each CONSIDERED, in config order — so an admin's on-demand run
 *  (`POST /admin/poll-usage`) can show what the cron only logs. `written` is
 *  NEW `repo_metrics` rows (`putMetric` says whether it wrote one): `0` on an
 *  `ok` is a re-poll of hours already stored, not a fault. A `failed` detail is
 *  the SAME scrubbed message the poller logs, cut to `DETAIL_CHARS`; a
 *  `skipped` detail names what is missing, never a secret's value. */
const DETAIL_CHARS = 200;
const okOutcome = (env: string, written: number, detail?: string): PollOutcome =>
  ({ env, status: "ok", written, ...(detail ? { detail: detail.slice(0, DETAIL_CHARS) } : {}) });
const failedOutcome = (env: string, message: string, written = 0): PollOutcome => ({ env, status: "failed", written, detail: message.slice(0, DETAIL_CHARS) });
const skippedOutcome = (env: string, detail: string): PollOutcome => ({ env, status: "skipped", written: 0, detail });

const TEN_MIN = 600_000;
const PING_TIMEOUT_MS = 8_000;

/** Two targets per environment: the Cloudflare frontend and the Railway
 *  backend's health path. Polite: GET, an 8s timeout, follows redirects, a
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

// ── Cloudflare Workers analytics (source K) ──────────────────────────────────
const HOUR = 3_600_000;
const CF_GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const CF_TIMEOUT_MS = 10_000;
/** Cloudflare's schema spells its scalar `string`, LOWERCASE — `String!` is
 *  rejected as an unknown type. `Time` is theirs too. `limit: 100` is far more
 *  than the ≤4 hourly groups one Worker can return for this window. */
const CF_QUERY = `query($a: string!, $s: string!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $a }) {
    workersInvocationsAdaptive(limit: 100, filter: { scriptName: $s, datetime_geq: $from, datetime_leq: $to }, orderBy: [datetimeHour_ASC]) {
      dimensions { datetimeHour }
      sum { requests errors }
    }
  } }
}`;

/** What a NON-2xx said about itself, as `: <reason>` (or `""`): the status alone
 *  ("cloudflare analytics 400") hid the real cause in production. The body is
 *  read as text; when it is JSON carrying `errors[0].message` that message is
 *  the reason, with `errors[0].code` (a number or a string) as ` [code]`;
 *  otherwise the raw text's start. One line, and SCRUBBED BEFORE IT IS CUT —
 *  with the caller's own scrub, the same one its log line goes through —
 *  because cutting first could leave half a token behind. Never throws: a body
 *  that cannot be read, or is not JSON, costs only the reason. */
const REASON_CHARS = 300;
const REASON_READ_BYTES = 8192;
/** At most `cap` bytes of a body, decoded; the rest of the stream is cancelled.
 *  `cut` says the cap was reached, so the text may END mid-word (a body of
 *  exactly `cap` bytes reads as cut too — the caller only loses a tail it never
 *  quotes). A Response without a readable stream (a test double) falls back to
 *  text(). */
async function readCapped(res: Response, cap: number): Promise<{ text: string; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) { const full = await res.text(); return { text: full.slice(0, cap), cut: full.length > cap }; }
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < cap) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value.subarray(0, cap - size));
    size += Math.min(value.byteLength, cap - size);
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { text: new TextDecoder().decode(all), cut: size >= cap };
}
/** Far longer than any secret this file holds (a Cloudflare token is 40
 *  characters, an account id 32, a Railway token 36, Sapling's 64). */
const SECRET_TAIL_GUARD = 256;
const RAW_REASON_CHARS = 120;
async function failureReason(res: Response, scrub: (s: string) => string): Promise<string> {
  // BOUNDED: an edge/proxy error page can be megabytes, and a Worker that
  // buffers past its memory ceiling is killed uncatchably — which would cost the
  // tick's other pollers and break the route's "never a 500". A few KB is far
  // more than any reason we keep.
  let text = "";
  try {
    const read = await readCapped(res, REASON_READ_BYTES);
    // THE READ CAP IS A CUT TOO, and it comes before every scrub below: a secret
    // straddling it arrives as a fragment no scrub can match, and a mostly-blank
    // body collapses to one line, pulling that fragment inside the characters
    // kept. So: scrub the text whole, then drop the tail a cut-off secret could
    // be hiding in. Nothing quoted below ever reaches that far into a real body.
    text = read.cut ? scrub(read.text).slice(0, -SECRET_TAIL_GUARD) : read.text;
  } catch { return ""; }
  const oneLine = (v: string) => scrub(v.replace(/\s+/g, " ").trim());
  let reason = "";
  try {
    const errors = record(JSON.parse(text)).errors;
    const { message, code } = record(Array.isArray(errors) ? errors[0] : null);
    if (typeof message === "string" && message.trim()) {
      reason = oneLine(`${message}${typeof code === "number" || typeof code === "string" ? ` [${code}]` : ""}`).slice(0, REASON_CHARS);
    }
  } catch { /* not JSON: the raw text below */ }
  if (!reason) reason = oneLine(text).slice(0, RAW_REASON_CHARS);
  return reason ? `: ${reason}` : "";
}

/** Cloudflare's three auth statuses, as FIXED hints (never derived from the
 *  secret): it answers 400 when the Authorization value is not token-shaped at
 *  all (quotes, spaces, a Global API Key, an account id, empty), 401 when it is
 *  token-shaped but wrong, 403 when the token is real but lacks the permission.
 *  Appended AFTER the message is cut, so a long body never costs the hint. */
const CF_STATUS_HINTS: Record<number, string> = {
  400: " — the token value is malformed (quotes, spaces, or not an API token)",
  401: " — the token is not valid",
  403: " — the token lacks Account Analytics: Read",
};

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
/** A count Cloudflare reported: a finite, non-negative number — anything else is not a count. */
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Hourly `cf_requests` / `cf_errors` per environment's FRONTEND Worker
 * (`cfg.worker`), `env` = the config key, `part` = "frontend".
 *
 * The window is LAGGED one hour, and that is load-bearing: `putMetric` is
 * first-write-wins, so a short count written once is PERMANENT — and this runs
 * at minute 0, seconds after the newest hour closes, when Cloudflare's adaptive
 * dataset may not have caught up with it yet. So `to` is the current hour's
 * floor MINUS an hour and the window is the 3 hours before it: every bucket has
 * had at least an hour to settle before its one and only write. The overlap
 * heals a missed tick, `INSERT OR IGNORE` dedupes it — but `datetime_leq: $to`
 * is INCLUSIVE, so the bucket AT `to` can come back and is skipped here, as is
 * anything outside the window.
 *
 * Never throws, and returns one `PollOutcome` per environment (an environment
 * naming no Worker is `skipped`, never fetched). A non-2xx says WHY — the
 * body's own reason (`failureReason`) and, for 400/401/403, a fixed hint. One
 * request per environment, sequentially (2 today). A non-2xx,
 * a thrown fetch, a 200 whose body carries a non-empty `errors` array (how
 * GraphQL reports a failure) or a body with no account in it (nothing was
 * looked at) is logged and costs THAT environment this tick's points — `data`
 * beside `errors` is never read — and the loop moves on. A malformed row is
 * skipped on its own and never aborts the rows after it.
 *
 * A quiet hour has NO row (the dataset groups invocations; none → no group), so
 * an absent hour is not written as 0 here — the projection zero-fills instead
 * (src/tools/repo.ts). But "no row" only means "zero" for an hour a poll is
 * KNOWN to have looked at, so each environment whose poll SUCCEEDED — even with
 * zero rows — has this window `[from, to)` merged into its covered INTERVAL in
 * the ONE `cf_polled` snapshot (`{ [env]: { from, to } }`): when the previous
 * interval reaches this window (`prev.to >= from`) it keeps its `from` and its
 * `to` becomes `max(prev.to, to)`; otherwise — no previous interval, or a GAP,
 * i.e. an outage longer than the 3-hour window left hours nothing ever looked
 * at — the interval RESTARTS at this window's `from`. That jump is the record
 * of the hole: the projection never draws a zero before `from`. ONE
 * read-modify-write per call, after the loop (read, merge every environment
 * that succeeded, write once) — no read when none succeeded, no write unless an
 * interval actually changed. A failed environment keeps its previous interval,
 * and neither end ever moves BACKWARDS (compared as parsed instants). A legacy
 * string entry is read through `cfCovered` and rewritten as an interval the
 * first time it advances. A failure here is logged and costs only the marker.
 */
export async function pollCloudflare(
  ctx: TenantContext, cf: { token: string; accountId: string }, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch
): Promise<PollOutcome[]> {
  const to = Math.floor(now / HOUR) * HOUR - HOUR;
  const from = to - CF_POLL_HOURS * HOUR;
  const succeeded: string[] = [];
  const outcomes: PollOutcome[] = [];
  // The ONE scrub of this poller — the log line, the outcome's `detail` and a
  // non-2xx body's reason all go through it. The token, and the ACCOUNT ID too:
  // Cloudflare's own errors can name the account they refused, and the detail
  // is what `POST /admin/poll-usage` hands to the browser.
  const scrub = (s: string) => [cf.token, cf.accountId].reduce((m, secret) => (secret ? m.split(secret).join("[redacted]") : m), s);
  for (const cfg of envs) {
    if (!cfg.worker) { outcomes.push(skippedOutcome(cfg.key, "no worker configured")); continue; }
    let hint = "";
    try {
      let written = 0;
      const res = await fetchImpl(CF_GRAPHQL, {
        method: "POST",
        signal: AbortSignal.timeout(CF_TIMEOUT_MS),
        headers: { authorization: `Bearer ${cf.token}`, "content-type": "application/json", "user-agent": "trov-analytics" },
        body: JSON.stringify({ query: CF_QUERY, variables: { a: cf.accountId, s: cfg.worker, from: new Date(from).toISOString(), to: new Date(to).toISOString() } }),
      });
      if (!res.ok) {
        hint = CF_STATUS_HINTS[res.status] ?? "";
        throw new Error(`cloudflare analytics ${res.status}${await failureReason(res, scrub)}`);
      }
      const body = record(await res.json());
      if (Array.isArray(body.errors) && body.errors.length) {
        // Scrubbed BEFORE the cut, like `failureReason`: a token straddling the
        // boundary would otherwise leave its first half behind — and this message
        // is now a PollOutcome.detail an admin's browser receives.
        throw new Error(`cloudflare analytics: ${scrub(String(record(body.errors[0]).message ?? "graphql error")).slice(0, 200)}`);
      }
      const accounts = record(record(body.data).viewer).accounts;
      const rows = Array.isArray(accounts) ? record(accounts[0]).workersInvocationsAdaptive : null;
      // No account matched (a wrong account id, a token that cannot see it):
      // the Worker was never looked at, so this is NOT "polled and found quiet".
      if (!Array.isArray(rows)) throw new Error("cloudflare analytics: no account in the response");
      for (const row of rows) {
        const hour = record(record(row).dimensions).datetimeHour;
        const at = typeof hour === "string" ? Date.parse(hour) : NaN;
        const sum = record(record(row).sum);
        const requests = count(sum.requests);
        const errors = count(sum.errors);
        // KNOWN LIMIT (accepted): a row IN the window that is malformed is skipped,
        // but the environment still counts as polled below — so that one hour may
        // be drawn as 0 rather than unknown. It takes Cloudflare changing its
        // response types; the blast radius is one bucket, and totals (sums of
        // real points) are unaffected. The fix, if it ever matters: remember the
        // first malformed in-window hour and end this poll's covered `to` there.
        if (!Number.isFinite(at) || at < from || at >= to || requests === null || errors === null) continue;
        const iso = new Date(at).toISOString();
        if (await putMetric(ctx, { metric: "cf_requests", env: cfg.key, part: "frontend", value: requests, at: iso })) written++;
        if (await putMetric(ctx, { metric: "cf_errors", env: cfg.key, part: "frontend", value: errors, at: iso })) written++;
      }
      succeeded.push(cfg.key);
      outcomes.push(okOutcome(cfg.key, written));
    } catch (e) {
      // The message only — never the error object, the request init or a header
      // — scrubbed of the token in case a failure ever quotes the request back
      // (the same rule `pollRailway` and `pollSaplingMetrics` keep below).
      // Scrubbed, THEN cut, THEN the fixed hint: the log line and the outcome's
      // `detail` are one string.
      const scrubbed = scrub(e instanceof Error ? e.message : String(e)).slice(0, 200) + hint;
      console.error("pollCloudflare", cfg.key, scrubbed);
      outcomes.push({ env: cfg.key, status: "failed", written: 0, detail: scrubbed });
    }
  }
  if (!succeeded.length) return outcomes;
  try {
    // A read-modify-write with NO lock. Cron ticks do not overlap each other
    // (hourly, against ~10s timeouts per environment), but an admin's on-demand
    // run (POST /admin/poll-usage) CAN overlap a tick or another admin's run, and
    // the later writer may then put back an OLDER `to`. That is accepted, not
    // prevented: the direction is safe (a stretch reads "never looked at", so it
    // draws unknown — never a fabricated zero) and the next successful poll
    // re-extends the interval. Beyond that a lost update is harmless anyway: every writer inside one hour computes the SAME
    // window, so the loser's interval is re-written identically next tick.
    const bounds = { ...record((await getSnapshot<unknown>(ctx, CF_POLLED))?.data) } as Record<string, unknown>;
    let changed = false;
    for (const key of succeeded) {
      const prev = cfCovered(bounds[key]);
      const next = prev && prev.to >= from ? { from: prev.from, to: Math.max(prev.to, to) } : { from, to };
      if (prev && next.from === prev.from && next.to === prev.to) continue;
      bounds[key] = { from: new Date(next.from).toISOString(), to: new Date(next.to).toISOString() };
      changed = true;
    }
    if (changed) await putSnapshot(ctx, CF_POLLED, bounds as CfPolled, new Date(now).toISOString());
  } catch (e) {
    // The message only, scrubbed — the rule every other log line in this file keeps.
    console.error("pollCloudflare", CF_POLLED, scrub(e instanceof Error ? e.message : String(e)));
  }
  return outcomes;
}

// ── Railway CPU and memory (source L) ────────────────────────────────────────
const RW_GRAPHQL = "https://backboard.railway.com/graphql/v2";
const RW_TIMEOUT_MS = 10_000;
const RW_HOURS = 3;
const RW_QUERY = `query($e:String!,$s:String!,$start:DateTime!){metrics(environmentId:$e,serviceId:$s,startDate:$start,measurements:[CPU_USAGE,MEMORY_USAGE_GB],sampleRateSeconds:3600){measurement values{ts value}}}`;
/** Railway measurement → the metric it is stored as, the ceiling above which a
 *  value is not believed (1024 vCPU / 4096 GB — sanity bounds, far past any
 *  plan), and the unit it is stored in: CPU as vCPU, memory as MB to one
 *  decimal (Railway reports GB). Anything not named here is ignored. */
const RW_MEASUREMENTS: Record<string, { metric: string; max: number; store: (v: number) => number }> = {
  CPU_USAGE: { metric: "rw_cpu", max: 1024, store: (v) => v },
  MEMORY_USAGE_GB: { metric: "rw_mem_mb", max: 4096, store: (v) => Math.round(v * 1024 * 10) / 10 },
};

/**
 * Hourly `rw_cpu` (vCPU) / `rw_mem_mb` per environment's BACKEND service,
 * `env` = the config key, `part` = "backend".
 *
 * `tokens[cfg.key]` is THAT environment's Railway PROJECT token — one token
 * reaches one environment of one project, and it travels as
 * `Project-Access-Token`, never `Authorization` (that header is for account /
 * workspace tokens; a project token is refused there). An environment with no
 * token, no `railwayEnvironmentId` or no `railwayServiceId` is skipped (its
 * outcome names WHICH is missing, never a value); the others still poll.
 * NOTHING here may log a token: only `cfg.key` and the
 * error's message reach the console, and the message is scrubbed of every
 * token in the map in case a failure ever quotes the request back.
 *
 * Only COMPLETE hours are stored: `putMetric` is first-write-wins, so a partial
 * sample written once is permanent — any value stamped at or after the current
 * hour's floor is skipped and picked up by a later tick instead. (Unlike
 * Cloudflare's counts these are gauges averaged per sample, so there is no
 * ingestion-lag undercount and no extra hour of lag.) The window asked for is
 * the 3 hours before that floor: the overlap heals a missed tick, `INSERT OR
 * IGNORE` dedupes it. Each sample is bucketed to its hour, so the UNIQUE key
 * holds one point per hour whatever second Railway stamps it with — and when
 * one response holds several valid samples for one bucket, the LATEST `ts`
 * is the one written (see the pick below), not whichever came first.
 *
 * Never throws, and returns one `PollOutcome` per environment. A non-2xx says
 * WHY (`failureReason` — the body's own message, scrubbed). One request per
 * environment, sequentially (2 today). A non-2xx,
 * a thrown fetch, a 200 whose body carries a non-empty `errors` array (how
 * GraphQL reports a failure — including a token this query is not permitted
 * to) or a body with no metrics list is logged and costs THAT environment this
 * tick's points — `data` beside `errors` is never read — and the loop moves on;
 * the hosting block then stays `not_connected`, never guessed. A malformed or
 * implausible value is skipped on its own and never aborts the rows after it.
 */
export async function pollRailway(
  ctx: TenantContext, tokens: Record<string, string | undefined>, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch
): Promise<PollOutcome[]> {
  const to = Math.floor(now / HOUR) * HOUR;
  const from = to - RW_HOURS * HOUR;
  const outcomes: PollOutcome[] = [];
  // The ONE scrub of this poller: EVERY token in the map, not just this environment's.
  const scrub = (s: string) => Object.values(tokens).reduce<string>((m, secret) => (secret ? m.split(secret).join("[redacted]") : m), s);
  for (const cfg of envs) {
    const token = tokens[cfg.key];
    if (!token || !cfg.railwayEnvironmentId || !cfg.railwayServiceId) {
      outcomes.push(skippedOutcome(cfg.key, !token ? "no project token" : !cfg.railwayEnvironmentId ? "no railwayEnvironmentId" : "no railwayServiceId"));
      continue;
    }
    try {
      const res = await fetchImpl(RW_GRAPHQL, {
        method: "POST",
        signal: AbortSignal.timeout(RW_TIMEOUT_MS),
        headers: { "Project-Access-Token": token, "content-type": "application/json", "user-agent": "trov-hosting" },
        body: JSON.stringify({ query: RW_QUERY, variables: { e: cfg.railwayEnvironmentId, s: cfg.railwayServiceId, start: new Date(from).toISOString() } }),
      });
      if (!res.ok) throw new Error(`railway metrics ${res.status}${await failureReason(res, scrub)}`);
      const body = record(await res.json());
      if (Array.isArray(body.errors) && body.errors.length) {
        throw new Error(`railway metrics: ${scrub(String(record(body.errors[0]).message ?? "graphql error")).slice(0, 200)}`); // scrubbed BEFORE the cut
      }
      const series = record(body.data).metrics;
      if (!Array.isArray(series)) throw new Error("railway metrics: no metrics in the response");
      // ONE row per metric per hour bucket, and WITHIN one response the sample
      // with the LATEST `ts` is the one kept — Railway's array order is
      // undocumented, and with `INSERT OR IGNORE` writing as it went, whichever
      // sample happened to come first won. The pick is made among VALID samples
      // only (every skip rule below runs before it), across every series entry
      // of the response; on an exact `ts` tie the first seen stays. This settles
      // ONE response only: a row an EARLIER poll already stored for that bucket
      // still wins (`putMetric` is first-write-wins across polls, unchanged).
      const picked = new Map<string, { metric: string; at: number; ts: number; value: number }>();
      for (const entry of series) {
        const { measurement, values } = record(entry);
        const spec = typeof measurement === "string" && Object.hasOwn(RW_MEASUREMENTS, measurement) ? RW_MEASUREMENTS[measurement] : null;
        if (!spec || !Array.isArray(values)) continue;
        for (const v of values) {
          const { ts, value } = record(v);
          // `ts` is unix SECONDS. A partial hour (>= `to`), anything before the
          // window asked for, and anything that is not a plausible gauge reading
          // is skipped — never stored, never NaN.
          if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) continue;
          const at = Math.floor((ts * 1000) / HOUR) * HOUR;
          if (!Number.isFinite(at) || at < from || at >= to) continue;
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > spec.max) continue;
          const key = `${spec.metric}|${at}`;
          const held = picked.get(key);
          if (!held || ts > held.ts) picked.set(key, { metric: spec.metric, at, ts, value: spec.store(value) });
        }
      }
      let written = 0;
      for (const p of picked.values()) {
        if (await putMetric(ctx, { metric: p.metric, env: cfg.key, part: "backend", value: p.value, at: new Date(p.at).toISOString() })) written++;
      }
      outcomes.push(okOutcome(cfg.key, written));
    } catch (e) {
      // The message only — never the error object, the request init or a header.
      const message = scrub(e instanceof Error ? e.message : String(e));
      console.error("pollRailway", cfg.key, message);
      outcomes.push(failedOutcome(cfg.key, message)); // the logged message, cut to DETAIL_CHARS
    }
  }
  return outcomes;
}

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
      const parsed = saplingActiveUsers(body);
      const product = saplingProductMetrics(body, scrub); // the scrub goes IN: a name is scrubbed before it is cut
      const rows: RepoMetric[] = [];
      const gauge = (metric: string, value: number) => rows.push({ metric, env: cfg.key, part: "", value, at });
      if (!("refused" in parsed)) for (const [i, range] of SAPLING_RANGES.entries()) gauge(`active_users_${range}`, parsed.values[i]);
      for (const key of Object.keys(product.counts)) {
        const c = product.counts[key];
        gauge(countMetric(key, "24h"), c.h24);
        gauge(countMetric(key, "7d"), c.d7);
        gauge(countMetric(key, "30d"), c.d30);
      }
      for (const key of Object.keys(product.totals)) gauge(totalMetric(key), product.totals[key]);
      written = await putMetrics(ctx, rows);
      // Dropped keys: NAMES only, handed to the outcome. Each name was scrubbed
      // INSIDE the validator, before it was cut to 40 characters — this second
      // scrub is belt and braces, and could not catch a token already cut.
      const droppedNote = product.droppedCount
        ? scrub(`${product.droppedCount} key${product.droppedCount === 1 ? "" : "s"} dropped: ${product.dropped.join(", ")}${product.namesOmitted ? ", …" : ""}`).slice(0, 200)
        : "";
      // The contract's core part failing is still a FAILED poll — `written`
      // (kept by the catch below) says what the product half stored anyway, and
      // the refusal carries the dropped note with it: the catch builds the
      // outcome from this message alone, so a note left out here is never seen.
      if ("refused" in parsed) throw new Error(`${parsed.refused}${droppedNote ? ` · ${droppedNote}` : ""}: ${excerpt(text)}`);
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
