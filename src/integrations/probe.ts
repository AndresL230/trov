// Test connection (canopy-multitenancy.md §8.7.4, D18): ONE outbound request per kind, shaped like the
// poller's own, that writes no metric — only the integration's `last_error` (cleared on success).
//
// The GitHub probe IS the pollers' reader (`ghJson`, which takes its token as a parameter). The app's
// metrics poller (`pollSaplingMetrics`, src/repo/poll.ts) takes a D1 handle and writes `repo_metrics` in
// the same breath as it fetches, so its request is restated here: same endpoint, same headers. Keep the
// two in step. Every hosting provider (Cloudflare and Railway included) is probed by its own `probe`
// (src/hosting/probe.ts).
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
import { endRefusedConnection, liveInstallConnection } from "../hosting/connections";
import { providerOfKind } from "@shared/hosting";
import { providerOf } from "../hosting/registry";

export interface ProbeResult {
  ok: boolean;
  detail: string;
  /** A hosting provider's refusal status (src/hosting/http.ts `probeFailure`) — internal: `testConnection` reads
   *  it and never returns it. */
  status?: number;
}

const TIMEOUT_MS = 10_000;
const DETAIL_CHARS = 300;
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
 * and leaves `last_error` alone. Every other kind records its outcome on the org's row. `partKey` (a hosting
 * provider's kind only — Org settings › Hosting's per-part Test) probes against THAT part's settings instead
 * of the first part that uses the provider.
 *
 * A hosting provider that answers 401 for a credential an install / OAuth grant put there has had that grant
 * revoked or removed on its side: the connection is ENDED, as the org's system tenant (secret deleted, row
 * revoked `refused`, audited `hosting.revoked` — src/hosting/connections.ts `endRefusedConnection`), so it can
 * be disconnected from either side even when the provider sends no notice. Only Test connection does this —
 * a person asked, and saw the answer; a poll's 401 only records `last_error` (src/hosting/poll.ts).
 */
export async function testConnection(
  ctx: TenantContext, env: Env, kind: IntegrationKind, scope: string, origin: string, now: number = Date.now(), fetchImpl?: typeof fetch,
  partKey?: { env: string; part: string },
): Promise<ProbeResult> {
  if (kind === "github_webhook") {
    // Access is checked exactly as for a decrypt, though nothing is sent anywhere.
    if (!(await resolveCredential(ctx, kind, scope))) throw new SecretNotFoundError();
    const meta = await getSecretMeta(ctx, kind, scope);
    const url = webhookUrl(origin, scope);
    return meta?.last_used_at
      ? ok(`Last verified delivery at ${meta.last_used_at}. Payload URL: ${url}`)
      : fail(`No verified delivery yet. In the repository's webhook settings on GitHub set the Payload URL to ${url} and the secret to the value saved here.`);
  }
  // Read BEFORE the probe: a refusal ends only the install / OAuth connection that was tested, never one made since.
  const installed = providerOfKind(kind) ? await liveInstallConnection(ctx, kind, scope) : null;
  const secret = await resolveCredential(ctx, kind, scope);
  if (!secret) throw new SecretNotFoundError();
  const doFetch: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init));
  const revealed: Revealed = [secret, kind === "cloudflare_analytics" ? await resolveCloudflareAccountId(ctx) : null];
  let result: ProbeResult;
  switch (kind) {
    case "metrics_endpoint": result = await probeMetricsEndpoint(ctx, scope, secret, doFetch); break;
    case "github_token": result = await probeGithub(ctx, secret, fetchImpl); break;
    // The hosting providers' own probe (src/hosting/probe.ts): the provider's cheapest authenticated read,
    // through its fixed-host fetch, against the first part that uses it (or the credential alone).
    case "cloudflare_analytics": case "railway": case "vercel": case "render": case "netlify": case "fly": case "aws":
      result = await probeHostingKind(ctx, env, kind, secret, now, doFetch, partKey); break;
  }
  const refused = !result.ok && result.status === 401;
  result = { ok: result.ok, detail: scrub(result.detail, revealed).replace(/\s+/g, " ").trim().slice(0, DETAIL_CHARS) };
  await recordSecretOutcome(ctx, kind, scope, result.ok ? { ok: true } : { ok: false, message: result.detail, revealed }, now);
  if (!result.ok) console.error("integration test failed", kind, scope, result.detail);
  if (refused && installed && (await endRefusedConnection(env, ctx, kind, scope, installed.connected_at))) {
    const id = providerOfKind(kind)!;
    console.error("integration test: the provider refused an installed grant — the connection was ended", kind, scope);
    const ended = ` — ${providerOf(id).label} no longer accepts the grant, so the connection was ended; connect it again`;
    result = { ok: false, detail: `${result.detail.slice(0, DETAIL_CHARS - ended.length)}${ended}` };
  }
  return result;
}
