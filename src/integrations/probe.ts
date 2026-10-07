// Test connection (canopy-multitenancy.md §8.7.4, D18): ONE outbound request per kind, shaped like the
// poller's own, that writes no metric — only the integration's `last_error` (cleared on success).
//
// The GitHub probe IS the pollers' reader (`ghJson`, which takes its token as a parameter). The other
// three pollers (`pollCloudflare`, `pollRailway`, `pollSaplingMetrics`, src/repo/poll.ts) take a D1
// handle and write `repo_metrics` in the same breath as they fetch, so their request is restated here:
// same endpoint, same headers, same query, the last hour only. Keep the two in step.
//
// Every `detail` is scrubbed of the credential BEFORE it is cut, logged, stored or returned.
import { checkFetchUrl, FetchUrlError } from "../artifacts/fetch-url";
import {
  SecretNotFoundError, getSecretMeta, recordSecretOutcome, resolveCloudflareAccountId, resolveCredential, scrub,
  type Revealed, type Secret,
} from "../data/secrets";
import type { TenantContext } from "../data/sql";
import type { Env } from "../env";
import { ghJson } from "../repo/github";
import type { IntegrationKind } from "@shared/integrations";
import { listEnvironments, primaryRepo, webhookUrl } from "./settings";
import { probeHostingKind } from "../hosting/probe";

export interface ProbeResult { ok: boolean; detail: string }

const HOUR = 3_600_000;
const TIMEOUT_MS = 10_000;
const DETAIL_CHARS = 300;
const REASON_READ_BYTES = 8192;
const REASON_CHARS = 160;
const METRICS_READ_BYTES = 262_144;

const ok = (detail: string): ProbeResult => ({ ok: true, detail });
const fail = (detail: string): ProbeResult => ({ ok: false, detail });
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

async function readCapped(res: Response, cap: number): Promise<{ text: string; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", cut: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    if (size + value.byteLength > cap) { chunks.push(value.subarray(0, cap - size)); size = cap; cut = true; break; }
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { text: new TextDecoder().decode(all), cut };
}

const longest = (revealed: Revealed): number => {
  if (Array.isArray(revealed)) return Math.max(0, ...(revealed as readonly Revealed[]).map(longest));
  if (typeof revealed === "string") return revealed.length;
  return revealed ? (revealed as Secret).reveal().length : 0;
};

/**
 * Why an upstream refused, from its body (bounded read): a GraphQL / REST `errors[0].message` or
 * `message`, else the raw text. An upstream may echo the request — its credential included — so the
 * text is scrubbed whole FIRST; and when the read was cut, the tail that could hold the first part of
 * a credential straddling the cut is dropped as well.
 */
async function reasonOf(res: Response, revealed: Revealed): Promise<string> {
  let text = "";
  try {
    const read = await readCapped(res, REASON_READ_BYTES);
    text = scrub(read.text, revealed);
    if (read.cut) text = text.slice(0, Math.max(0, text.length - 3 * longest(revealed) - 4)); // 3×: a URL-encoded spelling
  } catch { return ""; }
  let reason = "";
  try {
    const body = record(JSON.parse(text));
    const first = record(Array.isArray(body.errors) ? body.errors[0] : null).message ?? body.message ?? body.error;
    if (typeof first === "string") reason = first;
  } catch { /* not JSON: the raw text below */ }
  reason = (reason || text).replace(/\s+/g, " ").trim().slice(0, REASON_CHARS);
  return reason ? `: ${reason}` : "";
}

/**
 * A thrown fetch or a thrown parse. Its message is NEVER quoted: a fetch error may repeat the request,
 * and a JSON SyntaxError quotes a slice of the body — a slice can hold PART of a credential, which no
 * whole-value scrub would catch. The error's kind is all an admin needs.
 */
const thrown = (what: string, e: unknown): ProbeResult => {
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError") return fail(`${what}: the request timed out`);
  if (name === "SyntaxError") return fail(`${what}: the response is not JSON`);
  return fail(`${what}: the request failed`);
};

// ── Cloudflare: a one-hour workersInvocationsAdaptive query for the org's account ────────────────────
const CF_GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
// The poller's CF_QUERY; the scriptName filter is left out only when no environment names a Worker yet.
const cfQuery = (withScript: boolean) => `query($a: string!, ${withScript ? "$s: string!, " : ""}$from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $a }) {
    workersInvocationsAdaptive(limit: 100, filter: { ${withScript ? "scriptName: $s, " : ""}datetime_geq: $from, datetime_leq: $to }, orderBy: [datetimeHour_ASC]) {
      dimensions { datetimeHour }
      sum { requests errors }
    }
  } }
}`;
const CF_STATUS_HINTS: Record<number, string> = {
  400: " — the token value is malformed (quotes, spaces, or not an API token)",
  401: " — the token is not valid",
  403: " — the token lacks Account Analytics: Read",
};

async function probeCloudflare(ctx: TenantContext, env: Env, secret: Secret, now: number, fetchImpl: typeof fetch): Promise<ProbeResult> {
  const accountId = await resolveCloudflareAccountId(ctx, env);
  if (!accountId) return fail("the Cloudflare account id is not set");
  const worker = (await listEnvironments(ctx)).find((e) => e.worker)?.worker;
  const revealed: Revealed = [secret, accountId];
  const to = Math.floor(now / HOUR) * HOUR;
  try {
    const res = await fetchImpl(CF_GRAPHQL, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${secret.reveal()}`, "content-type": "application/json", "user-agent": "trov-analytics" },
      body: JSON.stringify({
        query: cfQuery(!!worker),
        variables: { a: accountId, ...(worker ? { s: worker } : {}), from: new Date(to - HOUR).toISOString(), to: new Date(to).toISOString() },
      }),
    });
    if (!res.ok) return fail(`cloudflare analytics ${res.status}${await reasonOf(res, revealed)}${CF_STATUS_HINTS[res.status] ?? ""}`);
    const body = record(JSON.parse((await readCapped(res, METRICS_READ_BYTES)).text));
    if (Array.isArray(body.errors) && body.errors.length) {
      return fail(`cloudflare analytics: ${scrub(String(record(body.errors[0]).message ?? "graphql error"), revealed).slice(0, REASON_CHARS)}`);
    }
    const accounts = record(record(body.data).viewer).accounts;
    if (!Array.isArray(accounts) || accounts.length === 0) return fail("cloudflare analytics: no account matched — check the account id, and that the token can see that account");
    return ok(worker ? `Cloudflare answered for the account (Worker ${worker}).` : "Cloudflare answered for the account.");
  } catch (e) {
    return thrown("cloudflare analytics", e);
  }
}

// ── Railway: the poller's `metrics` query for the last hour ──────────────────────────────────────────
const RW_GRAPHQL = "https://backboard.railway.com/graphql/v2";
const RW_QUERY = `query($e:String!,$s:String!,$start:DateTime!){metrics(environmentId:$e,serviceId:$s,startDate:$start,measurements:[CPU_USAGE,MEMORY_USAGE_GB],sampleRateSeconds:3600){measurement values{ts value}}}`;

async function probeRailway(ctx: TenantContext, scope: string, secret: Secret, now: number, fetchImpl: typeof fetch): Promise<ProbeResult> {
  const cfg = (await listEnvironments(ctx)).find((e) => e.key === scope);
  if (!cfg) return fail("the environment no longer exists");
  if (!cfg.railway_environment_id) return fail("the environment has no Railway environment id");
  if (!cfg.railway_service_id) return fail("the environment has no Railway service id");
  try {
    const res = await fetchImpl(RW_GRAPHQL, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "Project-Access-Token": secret.reveal(), "content-type": "application/json", "user-agent": "trov-hosting" },
      body: JSON.stringify({ query: RW_QUERY, variables: { e: cfg.railway_environment_id, s: cfg.railway_service_id, start: new Date(Math.floor(now / HOUR) * HOUR - HOUR).toISOString() } }),
    });
    if (!res.ok) return fail(`railway metrics ${res.status}${await reasonOf(res, secret)}`);
    const body = record(JSON.parse((await readCapped(res, METRICS_READ_BYTES)).text));
    if (Array.isArray(body.errors) && body.errors.length) {
      return fail(`railway metrics: ${scrub(String(record(body.errors[0]).message ?? "graphql error"), secret).slice(0, REASON_CHARS)}`);
    }
    if (!Array.isArray(record(body.data).metrics)) return fail("railway metrics: no metrics in the response");
    return ok("Railway answered with this environment's metrics.");
  } catch (e) {
    return thrown("railway metrics", e);
  }
}

// ── the app's own metrics endpoint: the poller's GET, body validated ─────────────────────────────────
const METRICS_PATH = "/api/internal/metrics";
const METRICS_RANGES = ["24h", "7d", "30d"] as const;

async function probeMetricsEndpoint(ctx: TenantContext, scope: string, secret: Secret, fetchImpl: typeof fetch): Promise<ProbeResult> {
  const cfg = (await listEnvironments(ctx)).find((e) => e.key === scope);
  if (!cfg) return fail("the environment no longer exists");
  if (!cfg.api_url) return fail("the environment has no API URL");
  let base: URL;
  // Re-checked at USE, not only when the URL was saved: https, and no private / loopback address.
  try { base = checkFetchUrl(cfg.api_url); } catch (e) { return fail(`API URL: ${e instanceof FetchUrlError ? e.message : "not a valid URL"}`); }
  try {
    const res = await fetchImpl(base.toString().replace(/\/+$/, "") + METRICS_PATH, {
      method: "GET",
      redirect: "manual", // the bearer never crosses a redirect
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${secret.reveal()}`, "user-agent": "canopy-metrics" },
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return fail(`metrics endpoint: HTTP ${res.status}${res.status >= 300 && res.status < 400 ? " (a redirect is never followed)" : ""}`);
    }
    let body: unknown;
    try { body = JSON.parse((await readCapped(res, METRICS_READ_BYTES)).text); } catch { return fail("metrics endpoint: the body is not JSON"); }
    const users = record(body).active_users;
    if (!users || typeof users !== "object" || Array.isArray(users)) return fail("metrics endpoint: no active_users object in the body");
    for (const range of METRICS_RANGES) {
      const v = (users as Record<string, unknown>)[range];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return fail(`metrics endpoint: active_users.${range} is not a whole number`);
    }
    return ok("The metrics endpoint answered with active users.");
  } catch (e) {
    return thrown("metrics endpoint", e);
  }
}

// ── GitHub: GET /repos/<primary repo>, through the pollers' own reader ───────────────────────────────
const GH_STATUS_HINTS: Record<string, string> = {
  "401": " — the token is not valid",
  "403": " — the token may not read this repository (or is rate-limited)",
  "404": " — the token cannot see this repository",
};

async function probeGithub(ctx: TenantContext, secret: Secret, fetchImpl: typeof fetch | undefined): Promise<ProbeResult> {
  const repo = await primaryRepo(ctx);
  if (!repo) return fail("the org has no primary repository");
  try {
    await ghJson<unknown>({ token: secret.reveal(), repo, fetchImpl }, "");
    return ok(`GitHub answered for ${repo}.`);
  } catch (e) {
    // `ghJson` throws `github <status> <path>` for a non-2xx: the STATUS is read out of it, nothing else.
    const status = e instanceof Error ? /^github (\d{3})\b/.exec(e.message)?.[1] : undefined;
    return status ? fail(`github ${status} for ${repo}${GH_STATUS_HINTS[status] ?? ""}`) : thrown("github", e);
  }
}

/**
 * Run Test connection for one integration. `SecretNotFoundError` when there is no credential to test.
 * A webhook secret has nothing to call: it reports the last VERIFIED delivery and the URL to configure,
 * and leaves `last_error` alone. Every other kind records its outcome on the org's row.
 */
export async function testConnection(
  ctx: TenantContext, env: Env, kind: IntegrationKind, scope: string, origin: string, now: number = Date.now(), fetchImpl?: typeof fetch
): Promise<ProbeResult> {
  if (kind === "github_webhook") {
    // Access is checked exactly as for a decrypt, though nothing is sent anywhere.
    if (!(await resolveCredential(ctx, env, kind, scope))) throw new SecretNotFoundError();
    const meta = await getSecretMeta(ctx, kind, scope);
    const url = webhookUrl(origin, scope);
    return meta?.last_used_at
      ? ok(`Last verified delivery at ${meta.last_used_at}. Payload URL: ${url}`)
      : fail(`No verified delivery yet. In the repository's webhook settings on GitHub set the Payload URL to ${url} and the secret to the value saved here.`);
  }
  const secret = await resolveCredential(ctx, env, kind, scope);
  if (!secret) throw new SecretNotFoundError();
  const doFetch: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init));
  const revealed: Revealed = [secret, kind === "cloudflare_analytics" ? await resolveCloudflareAccountId(ctx, env) : null];
  let result: ProbeResult;
  switch (kind) {
    case "cloudflare_analytics": result = await probeCloudflare(ctx, env, secret, now, doFetch); break;
    case "railway": result = await probeRailway(ctx, scope, secret, now, doFetch); break;
    case "metrics_endpoint": result = await probeMetricsEndpoint(ctx, scope, secret, doFetch); break;
    case "github_token": result = await probeGithub(ctx, secret, fetchImpl); break;
    // The hosting providers' own probe (src/hosting/probe.ts): the provider's cheapest authenticated read,
    // through its fixed-host fetch, against the first part that uses it (or the credential alone).
    case "vercel": case "render": case "netlify": case "fly": case "aws":
      result = await probeHostingKind(ctx, env, kind, secret, now, doFetch); break;
  }
  result = { ok: result.ok, detail: scrub(result.detail, revealed).replace(/\s+/g, " ").trim().slice(0, DETAIL_CHARS) };
  await recordSecretOutcome(ctx, kind, scope, result.ok ? { ok: true } : { ok: false, message: result.detail, revealed }, now);
  if (!result.ok) console.error("integration test failed", kind, scope, result.detail);
  return result;
}
