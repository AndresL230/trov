/**
 * "Poll usage now" — the three hourly usage pollers, on demand.
 *
 * `runUsagePolls` (src/repo/cron.ts) is the ONE function behind both the repo
 * cron's minute-0 tick and the admin-only `POST /admin/poll-usage`: it runs
 * `pollCloudflare` / `pollRailway` / `pollSaplingMetrics`, each in its own
 * guarded arm, and reports a `PollOutcome[]` per source — or `"not_configured"`
 * when that source's secret(s) are absent. The response carries outcomes and
 * NEVER a token, a header or an account id.
 * The fetch is stubbed at the Response level; rows are asserted in real D1.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { all } from "./helpers/db";
import { app } from "../src/routes";
import { handleRepoCron, runUsagePolls } from "../src/repo/cron";
import { cookieFor } from "./helpers/persons";
import { ENVS } from "./helpers/repo";
import type { Env } from "../src/env";

const HOURLY = Date.parse("2026-09-20T12:00:00Z");
const LATER = Date.parse("2026-09-20T12:37:12Z"); // the same hour, an arbitrary minute
const CF_URL = "https://api.cloudflare.com/client/v4/graphql";
const RW_URL = "https://backboard.railway.com/graphql/v2";
const METRICS_PATH = "/api/internal/metrics";
const WITH_IDS = ENVS.map((e, i) => ({ ...e, railwayEnvironmentId: `env-${i}`, railwayServiceId: "svc" }));

const SECRETS = {
  CF_ANALYTICS_TOKEN: "cf-s3cret-token", CF_ANALYTICS_ACCOUNT_ID: "acct-1d-9f3b",
  RAILWAY_TOKEN_STAGING: "rw-s3cret-staging", RAILWAY_TOKEN_PRODUCTION: "rw-s3cret-production",
  SAPLING_METRICS_TOKEN: "sp-s3cret-token",
} as const;
const NONE = Object.fromEntries(Object.keys(SECRETS).map((k) => [k, undefined]));
/** Every secret pinned — set or absent — so a local `.dev.vars` never decides a test. */
const pollEnv = (over: Partial<Env> = {}): Env =>
  ({ ...env, REPO_ENVIRONMENTS: JSON.stringify(WITH_IDS), ...SECRETS, ...over }) as unknown as Env;

/** Every source answers one complete hour / one reading. */
const recorder = () => {
  const calls: string[] = [];
  const fetchImpl = (async (u: RequestInfo | URL) => {
    const url = String(u);
    calls.push(url);
    if (url === CF_URL) return new Response(JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
      { dimensions: { datetimeHour: "2026-09-20T10:00:00Z" }, sum: { requests: 640, errors: 3 } },
    ] }] } } }), { status: 200 });
    if (url === RW_URL) return new Response(JSON.stringify({ data: { metrics: [
      { measurement: "CPU_USAGE", values: [{ ts: Date.parse("2026-09-20T11:00:00Z") / 1000, value: 0.12 }] },
      { measurement: "MEMORY_USAGE_GB", values: [{ ts: Date.parse("2026-09-20T11:00:00Z") / 1000, value: 0.4 }] },
    ] } }), { status: 200 });
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
  it("with every secret absent, each source is not_configured and nothing is fetched", async () => {
    const r = recorder();
    expect(await runUsagePolls(pollEnv(NONE), LATER, r.fetchImpl)).toEqual({
      cloudflare: "not_configured", railway: "not_configured", sapling: "not_configured",
    });
    expect(r.calls).toEqual([]);
  });

  it("Cloudflare needs BOTH the token and the account id", async () => {
    const r = recorder();
    const res = await runUsagePolls(pollEnv({ ...NONE, CF_ANALYTICS_TOKEN: "cf-token" }), LATER, r.fetchImpl);
    expect(res.cloudflare).toBe("not_configured");
    expect(r.calls).toEqual([]);
  });

  it("runs all three, in the cron's order, at 3N requests — and no health ping", async () => {
    const r = recorder();
    expect(await runUsagePolls(pollEnv(), LATER, r.fetchImpl)).toEqual({
      cloudflare: [{ env: "staging", status: "ok", written: 2 }, { env: "production", status: "ok", written: 2 }],
      railway: [{ env: "staging", status: "ok", written: 2 }, { env: "production", status: "ok", written: 2 }],
      sapling: [{ env: "staging", status: "ok", written: 3 }, { env: "production", status: "ok", written: 3 }],
    });
    expect(r.calls).toEqual([
      CF_URL, CF_URL, RW_URL, RW_URL,
      "https://api.staging.saplinglearn.com/api/internal/metrics", "https://api.saplinglearn.com/api/internal/metrics",
    ]);
    expect(await metricCount()).toBe(14);
  });

  // Every poller keys on the HOUR FLOOR of `now` and every write is INSERT OR
  // IGNORE, so an on-demand run at any minute repeats the cron's own writes.
  it("is idempotent with the cron's minute-0 tick of the same hour", async () => {
    const r = recorder();
    await handleRepoCron(pollEnv(), HOURLY, r.fetchImpl);
    const before = await metricCount();
    const res = await runUsagePolls(pollEnv(), LATER, r.fetchImpl);
    for (const source of [res.cloudflare, res.railway, res.sapling]) {
      expect(source).toEqual([{ env: "staging", status: "ok", written: 0 }, { env: "production", status: "ok", written: 0 }]);
    }
    expect(await metricCount()).toBe(before);
  });

  it("the cron's minute-0 tick makes the same requests, after its health pings", async () => {
    const viaCron = recorder();
    await handleRepoCron(pollEnv(), HOURLY, viaCron.fetchImpl);
    const onDemand = recorder();
    await runUsagePolls(pollEnv(), HOURLY, onDemand.fetchImpl);
    expect(viaCron.calls).toHaveLength(10); // 4 health + 3N
    expect(viaCron.calls.slice(4)).toEqual(onDemand.calls);
  });

  it("one source failing never skips another, and a Railway environment with no token is skipped", async () => {
    const r = recorder();
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) =>
      String(u) === CF_URL ? new Response("", { status: 500 }) : r.fetchImpl(u, init)) as typeof fetch;
    const res = await quietly(() => runUsagePolls(pollEnv({ RAILWAY_TOKEN_STAGING: undefined }), LATER, fetchImpl));
    expect(res).toEqual({
      cloudflare: [
        { env: "staging", status: "failed", written: 0, detail: "cloudflare analytics 500" },
        { env: "production", status: "failed", written: 0, detail: "cloudflare analytics 500" },
      ],
      railway: [{ env: "staging", status: "skipped", written: 0, detail: "no project token" }, { env: "production", status: "ok", written: 2 }],
      sapling: [{ env: "staging", status: "ok", written: 3 }, { env: "production", status: "ok", written: 3 }],
    });
  });

  // The worst case: every failure quotes its own request — headers AND body —
  // back. The result is what the route returns verbatim, so nothing in it may
  // carry a token, a header value or the account id.
  it("never carries a secret, even when every failure echoes the request back", async () => {
    const echoThrow = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      throw new Error(`request failed: ${JSON.stringify(init?.headers)} ${String(init?.body ?? "")}`);
    }) as typeof fetch;
    const echoBody = (async (_u: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify({ errors: [{ message: `denied ${JSON.stringify(init?.headers)} ${String(init?.body ?? "")}` }] }), { status: 200 })) as typeof fetch;
    for (const fetchImpl of [echoThrow, echoBody]) {
      const res = await quietly(() => runUsagePolls(pollEnv(), LATER, fetchImpl));
      for (const source of [res.cloudflare, res.railway, res.sapling]) {
        expect(source).toHaveLength(2);
        for (const o of source as { status: string }[]) expect(o.status).toBe("failed");
      }
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

  it("for an admin with every secret unset (the pool default): 200, all three not_configured, no network", async () => {
    const res = await app.request("/admin/poll-usage", { method: "POST", headers: { cookie: await cookieFor("admin-user") } }, pollEnv(NONE));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cloudflare: "not_configured", railway: "not_configured", sapling: "not_configured" });
  });

  // The route has no fetch seam of its own (like /admin/backfill, it calls the
  // real fetch in production), so this one test swaps the GLOBAL fetch — the
  // pollers' default `fetchImpl = fetch` resolves it at call time. Guarded: the
  // stub is proven to be the one in force BEFORE any secret-bearing env is used.
  it("with fake secrets and a fetch that echoes its request into the error: 200, every source failed, and no secret in the JSON", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (async (u: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(u));
      throw new Error(`request failed: ${JSON.stringify(init?.headers)} ${String(init?.body ?? "")}`);
    }) as typeof fetch);
    await expect(fetch("https://stub-check.invalid/")).rejects.toThrow("request failed");
    expect(seen).toEqual(["https://stub-check.invalid/"]);

    const res = await quietly(async () =>
      app.request("/admin/poll-usage", { method: "POST", headers: { cookie: await cookieFor("admin-user") } }, pollEnv()));
    expect(res.status).toBe(200); // every source failed — the BODY says so
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, { status: string }[]>;
    expect(Object.keys(body).sort()).toEqual(["cloudflare", "railway", "sapling"]);
    for (const source of Object.values(body)) expect(source.map((o) => o.status)).toEqual(["failed", "failed"]);
    expect(seen).toHaveLength(7); // the stub check + 3N — nothing reached the network
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    expect(text).toContain("[redacted]"); // the echo DID reach the detail — scrubbed
  });
});
