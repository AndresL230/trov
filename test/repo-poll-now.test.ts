/**
 * "Poll usage now" — the hourly usage poller, on demand.
 *
 * `runUsagePolls` (src/repo/cron.ts) is the ONE function behind both the repo
 * cron's minute-0 tick and the admin-only `POST /admin/poll-usage`: it runs
 * `pollSaplingMetrics` (the app's own metrics endpoint) in a guarded arm and
 * reports a `PollOutcome[]` — or `"not_configured"` when its secret is absent.
 * A host's usage (Cloudflare, Railway, …) is not here: every host is a hosting
 * provider, polled per part (test/hosting.cron.test.ts). The response carries
 * outcomes and NEVER a token or a header.
 * The fetch is stubbed at the Response level; rows are asserted in real D1.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { all } from "./helpers/db";
import { app } from "../src/routes";
import { handleRepoCron, runUsagePolls, syncOrgConfig } from "./helpers/org-config";
import { cookieFor } from "./helpers/persons";
import { ENVS } from "./helpers/repo";
import type { Env } from "../src/env";

const HOURLY = Date.parse("2026-09-20T12:00:00Z");
const LATER = Date.parse("2026-09-20T12:37:12Z"); // the same hour, an arbitrary minute
const METRICS_PATH = "/api/internal/metrics";
const METRICS_URLS = ENVS.map((e) => e.apiUrl + METRICS_PATH);

const SECRETS = {
  CF_ANALYTICS_TOKEN: "cf-s3cret-token", CF_ANALYTICS_ACCOUNT_ID: "acct-1d-9f3b",
  SAPLING_METRICS_TOKEN: "sp-s3cret-token",
} as const;
const NONE = Object.fromEntries(Object.keys(SECRETS).map((k) => [k, undefined]));
/** Every secret pinned — set or absent — so a local `.dev.vars` never decides a test. */
const pollEnv = (over: Partial<Env> = {}): Env =>
  ({ ...env, REPO_ENVIRONMENTS: JSON.stringify(ENVS), ...SECRETS, ...over }) as unknown as Env;

/** The app's metrics answer one reading; anything else (a health ping) a 200. */
const recorder = () => {
  const calls: string[] = [];
  const fetchImpl = (async (u: RequestInfo | URL) => {
    const url = String(u);
    calls.push(url);
    if (url.endsWith(METRICS_PATH)) return new Response(JSON.stringify({ active_users: { "24h": 74, "7d": 318, "30d": 318 } }), { status: 200 });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
};
const metricCount = async () => (await all(env.DB, `SELECT 1 FROM repo_metrics`)).length;
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try { return await fn(); } finally { spy.mockRestore(); }
};

describe("runUsagePolls", () => {
  it("with the secret absent the source is not_configured and nothing is fetched — the legacy Cloudflare secrets fetch nothing either", async () => {
    const r = recorder();
    expect(await runUsagePolls(pollEnv({ SAPLING_METRICS_TOKEN: undefined }), LATER, r.fetchImpl)).toEqual({ sapling: "not_configured" });
    expect(r.calls).toEqual([]);
  });

  it("asks each environment's backend once, at N requests — and no health ping", async () => {
    const r = recorder();
    expect(await runUsagePolls(pollEnv(), LATER, r.fetchImpl)).toEqual({
      sapling: [{ env: "staging", status: "ok", written: 3 }, { env: "production", status: "ok", written: 3 }],
    });
    expect(r.calls).toEqual(METRICS_URLS); // one environment at a time — each is its own (org, environment) job
    expect(await metricCount()).toBe(6);
  });

  // The poller keys on the HOUR FLOOR of `now` and every write is INSERT OR
  // IGNORE, so an on-demand run at any minute repeats the cron's own writes.
  it("is idempotent with the cron's minute-0 tick of the same hour", async () => {
    const r = recorder();
    await handleRepoCron(pollEnv(), HOURLY, r.fetchImpl);
    const before = await metricCount();
    const res = await runUsagePolls(pollEnv(), LATER, r.fetchImpl);
    expect(res.sapling).toEqual([{ env: "staging", status: "ok", written: 0 }, { env: "production", status: "ok", written: 0 }]);
    expect(await metricCount()).toBe(before);
  });

  it("the cron's minute-0 tick makes the same requests, after its health pings", async () => {
    const viaCron = recorder();
    await handleRepoCron(pollEnv(), HOURLY, viaCron.fetchImpl);
    const onDemand = recorder();
    await runUsagePolls(pollEnv(), HOURLY, onDemand.fetchImpl);
    expect(viaCron.calls).toHaveLength(6); // 4 health + N
    expect(viaCron.calls.slice(4)).toEqual(onDemand.calls);
  });

  it("one environment failing never skips the other", async () => {
    const r = recorder();
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) =>
      String(u) === METRICS_URLS[0] ? new Response("", { status: 500 }) : r.fetchImpl(u, init)) as typeof fetch;
    const res = await quietly(() => runUsagePolls(pollEnv(), LATER, fetchImpl));
    expect(res).toEqual({
      sapling: [{ env: "staging", status: "failed", written: 0, detail: "HTTP 500" }, { env: "production", status: "ok", written: 3 }],
    });
  });

  // The worst case: every failure quotes its own request — headers AND body —
  // back. The result is what the route returns verbatim, so nothing in it may
  // carry a token or a header value.
  it("never carries a secret, even when every failure echoes the request back", async () => {
    const echoThrow = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      throw new Error(`request failed: ${JSON.stringify(init?.headers)} ${String(init?.body ?? "")}`);
    }) as typeof fetch;
    const echoBody = (async (_u: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify({ errors: [{ message: `denied ${JSON.stringify(init?.headers)} ${String(init?.body ?? "")}` }] }), { status: 200 })) as typeof fetch;
    for (const fetchImpl of [echoThrow, echoBody]) {
      const res = await quietly(() => runUsagePolls(pollEnv(), LATER, fetchImpl));
      expect(res.sapling).toHaveLength(2);
      for (const o of res.sapling as { status: string }[]) expect(o.status).toBe("failed");
      const body = JSON.stringify(res);
      for (const secret of Object.values(SECRETS)) expect(body).not.toContain(secret);
      expect(body).toContain("[redacted]");
    }
  });
});

describe("POST /admin/poll-usage (session- + admin-gated, never MCP)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("401s without a session", async () => {
    const res = await app.request("/admin/poll-usage", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("403s for a non-admin principal", async () => {
    const res = await app.request("/admin/poll-usage", { method: "POST", headers: { cookie: await cookieFor("not-admin") } }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "admin only" });
  });

  it("for an admin with every secret unset (the pool default): 200, not_configured, no network", async () => {
    const res = await app.request("/admin/poll-usage", { method: "POST", headers: { cookie: await cookieFor("admin-user") } }, await syncOrgConfig(pollEnv(NONE)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sapling: "not_configured" });
  });

  // The route has no fetch seam of its own (like /admin/backfill, it calls the
  // real fetch in production), so this one test swaps the GLOBAL fetch — the
  // pollers' default `fetchImpl = fetch` resolves it at call time. Guarded: the
  // stub is proven to be the one in force BEFORE any secret-bearing env is used.
  it("with fake secrets and a fetch that echoes its request into the error: 200, the source failed, and no secret in the JSON", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (async (u: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(u));
      throw new Error(`request failed: ${JSON.stringify(init?.headers)} ${String(init?.body ?? "")}`);
    }) as typeof fetch);
    await expect(fetch("https://stub-check.invalid/")).rejects.toThrow("request failed");
    expect(seen).toEqual(["https://stub-check.invalid/"]);

    const res = await quietly(async () =>
      app.request("/admin/poll-usage", { method: "POST", headers: { cookie: await cookieFor("admin-user") } }, await syncOrgConfig(pollEnv())));
    expect(res.status).toBe(200); // every source failed — the BODY says so
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, { status: string }[]>;
    expect(Object.keys(body).sort()).toEqual(["sapling"]);
    for (const source of Object.values(body)) expect(source.map((o) => o.status)).toEqual(["failed", "failed"]);
    expect(seen).toHaveLength(3); // the stub check + N — nothing reached the network
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    expect(text).toContain("[redacted]"); // the echo DID reach the detail — scrubbed
  });
});
