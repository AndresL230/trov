/**
 * "Poll now" — EVERYTHING the Repo dashboard shows, on demand.
 *
 * `runRepoRefresh` (src/repo/cron.ts) runs health pings, then the three usage
 * pollers (`runUsagePolls`, unchanged), then the GitHub reconcile — each in its
 * own guarded arm — and `POST /admin/poll` returns what they report, behind a
 * `refresh_lock` snapshot. The budget is 19 + 7N subrequests; past the free
 * plan's 50 the GitHub arm is skipped and says so.
 * The fetch is stubbed at the Response level; rows are asserted in real D1.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run } from "./helpers/db";
import { app } from "../src/routes";
import {
  BUDGET_SKIP, REFRESH_LOCK, REFRESH_LOCK_MS, SUBREQUEST_CAP,
  refreshSubrequests,
} from "../src/repo/cron";
import { handleRepoCron, runLockedRepoRefresh, runRepoRefresh, syncOrgConfig } from "./helpers/org-config";
import { latestHealth } from "../src/repo/store";
import { getRepoDashboard } from "../src/tools/repo";
import { cookieFor } from "./helpers/persons";
import { ENVS, LONG_TOKEN, fakeGithub, leakedFragments } from "./helpers/repo";
import type { Env } from "../src/env";
import type { RepoRefreshResult } from "@shared/repo";

import { platformCtx, systemCtx } from "./helpers/tenant";
import { pruneRepoCapture } from "../src/platform/sweeps";
const NOW = Date.parse("2026-09-20T12:37:12Z");
const CF_URL = "https://api.cloudflare.com/client/v4/graphql";
const RW_URL = "https://backboard.railway.com/graphql/v2";
const GH = "https://api.github.com/";
const METRICS_PATH = "/api/internal/metrics";
const WITH_IDS = ENVS.map((e, i) => ({ ...e, railwayEnvironmentId: `env-${i}`, railwayServiceId: "svc" }));
const HEALTH_URLS = ENVS.flatMap((e) => [e.frontendUrl, e.apiUrl + e.healthPath]);

const GH_TOKEN = `ghs_${LONG_TOKEN}`;
const SECRETS = {
  CF_ANALYTICS_TOKEN: "cf-s3cret-token", CF_ANALYTICS_ACCOUNT_ID: "acct-1d-9f3b",
  RAILWAY_TOKEN_STAGING: "rw-s3cret-staging", RAILWAY_TOKEN_PRODUCTION: "rw-s3cret-production",
  SAPLING_METRICS_TOKEN: "sp-s3cret-token", GITHUB_SERVICE_TOKEN: GH_TOKEN,
} as const;
const NONE = Object.fromEntries(Object.keys(SECRETS).map((k) => [k, undefined]));
/** Every secret pinned — set or absent — so a local `.dev.vars` never decides a test. */
const refreshEnv = (over: Partial<Env> = {}): Env =>
  ({ ...env, REPO_ENVIRONMENTS: JSON.stringify(WITH_IDS), GITHUB_REPO: "o/r", ...SECRETS, ...over }) as unknown as Env;

/** Every source answers: GitHub through `fakeGithub` (empty-but-valid), the
 *  pollers with one complete hour / one reading, a health target with a 200. */
const world = (over: (url: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined> = () => undefined) => {
  const calls: string[] = [];
  const gh = fakeGithub({});
  const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = String(u);
    calls.push(url);
    const custom = await over(url, init);
    if (custom) return custom;
    if (url.startsWith(GH)) return gh.fetchImpl(u, init);
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

/** Runs `fn` with every console channel captured; returns what was logged, flattened. */
const captured = async <T>(fn: () => Promise<T>): Promise<{ out: T; logged: string }> => {
  const spies = (["error", "warn", "log", "info"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
  try {
    const out = await fn();
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls).map((c) => c.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : a))));
    return { out, logged };
  } finally { for (const s of spies) s.mockRestore(); }
};
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => (await captured(fn)).out;
const lockRow = () => first<{ json: string; computed_at: string }>(env.DB, `SELECT json, computed_at FROM repo_snapshots WHERE kind = ?`, REFRESH_LOCK);
const putLock = (ageMs: number, at = Date.now()) => run(env.DB, `INSERT INTO repo_snapshots (kind, json, computed_at) VALUES (?, ?, ?)`,
  REFRESH_LOCK, JSON.stringify({ by: "someone-else", at: new Date(at - ageMs).toISOString() }), new Date(at - ageMs).toISOString());

const UP = (envKey: string, part: "frontend" | "backend", written = 2) => ({ env: envKey, part, status: "ok", written });
const ALL_UP = [UP("staging", "frontend"), UP("staging", "backend"), UP("production", "frontend"), UP("production", "backend")];
const USAGE_OK = {
  cloudflare: [{ env: "staging", status: "ok", written: 2 }, { env: "production", status: "ok", written: 2 }],
  railway: [{ env: "staging", status: "ok", written: 2 }, { env: "production", status: "ok", written: 2 }],
  sapling: [{ env: "staging", status: "ok", written: 3 }, { env: "production", status: "ok", written: 3 }],
};

describe("the on-demand budget", () => {
  it("is 19 + 7N: 33 for two environments, inside the cap up to N = 4 (47) and past it at 5 (54)", () => {
    expect(refreshSubrequests(2)).toBe(33);
    expect(refreshSubrequests(4)).toBe(47);
    expect(refreshSubrequests(5)).toBe(54);
    expect(refreshSubrequests(4)).toBeLessThanOrEqual(SUBREQUEST_CAP);
    expect(refreshSubrequests(5)).toBeGreaterThan(SUBREQUEST_CAP);
  });
});

describe("runRepoRefresh", () => {
  it("runs health, then usage, then GitHub — every arm's outcome, in order, at ≤ 33 requests for N = 2", async () => {
    const w = world();
    const res = await runRepoRefresh(refreshEnv(), NOW, w.fetchImpl);
    expect(res).toEqual({ health: ALL_UP, ...USAGE_OK, github: { written: 0, unchanged: 0, failed: [] } });
    expect(Object.keys(res)).toEqual(["health", "cloudflare", "railway", "sapling", "github"]);

    expect(w.calls.slice(0, 4)).toEqual(HEALTH_URLS);
    expect(w.calls.slice(4, 10)).toEqual([
      CF_URL, RW_URL, "https://api.staging.saplinglearn.com/api/internal/metrics", // one environment at a time —
      CF_URL, RW_URL, "https://api.saplinglearn.com/api/internal/metrics",         // each is its own (org, environment) job
    ]);
    const github = w.calls.slice(10);
    expect(github.length).toBeGreaterThan(0);
    for (const url of github) expect(url.startsWith(GH)).toBe(true);
    expect(w.calls.length).toBeLessThanOrEqual(refreshSubrequests(2));
    expect(refreshSubrequests(2)).toBe(33);
    // Reconcile really ran: its completeness marker and its snapshots are in D1.
    const kinds = (await all<{ kind: string }>(env.DB, `SELECT kind FROM repo_snapshots ORDER BY kind`)).map((r) => r.kind);
    expect(kinds).toContain("prs_reconciled");
    expect(kinds).toContain("branches");
  });

  // First write wins, so a reading floored to the cron's ten-minute bucket
  // would be dropped and the screen would keep the tick's. The on-demand run
  // stamps the SECOND: a newer row, which the read picks up.
  it("lands a health reading NEWER than the cron's of the same ten minutes", async () => {
    const tick = Date.parse("2026-09-20T12:30:00Z");
    await handleRepoCron(refreshEnv(NONE), tick, world().fetchImpl);
    const down = world((url) => (url === ENVS[0].apiUrl + ENVS[0].healthPath ? new Response("", { status: 503 }) : undefined));
    const res = await runRepoRefresh(refreshEnv(NONE), NOW, down.fetchImpl);
    expect(res.health).toEqual([
      UP("staging", "frontend"), { env: "staging", part: "backend", status: "failed", written: 2, detail: "HTTP 503" },
      UP("production", "frontend"), UP("production", "backend"),
    ]);
    const rows = await all<{ value: number; at: string }>(env.DB,
      `SELECT value, at FROM repo_metrics WHERE metric = 'health_up' AND env = 'staging' AND part = 'backend' ORDER BY at`);
    expect(rows).toEqual([{ value: 1, at: "2026-09-20T12:30:00.000Z" }, { value: 0, at: "2026-09-20T12:37:12.000Z" }]);
  });

  // The review's M1: a ONE-MINUTE floor still collided with the tick for the
  // whole of the tick's own minute (12:30:40 floors to 12:30:00 either way), so
  // a real "down" was shown in the strip and then DROPPED — the health block and
  // the pill went on saying up.
  it("a DOWN seen 40 seconds after the cron's tick is stored, read back as the latest, and turns the pill DOWN", async () => {
    const tick = Date.parse("2026-09-20T12:30:00Z");
    await handleRepoCron(refreshEnv(NONE), tick, world().fetchImpl);
    const backend = ENVS[0].apiUrl + ENVS[0].healthPath;
    const before = await getRepoDashboard(systemCtx(), "o/r", tick + 5_000, ENVS);
    expect((before.environments as { data: { name: string; pill: string }[] }).data.map((e) => e.pill)).not.toContain("DOWN");

    const at = Date.parse("2026-09-20T12:30:40Z");
    const res = await runRepoRefresh(refreshEnv(NONE), at, world((url) => (url === backend ? new Response("", { status: 503 }) : undefined)).fetchImpl);
    expect((res.health as { part?: string; status: string; written: number; detail?: string }[])[1])
      .toEqual({ env: "staging", part: "backend", status: "failed", written: 2, detail: "HTTP 503" }); // written: the row LANDED

    expect(await all(env.DB, `SELECT value, at FROM repo_metrics WHERE metric = 'health_up' AND env = 'staging' AND part = 'backend' ORDER BY at`))
      .toEqual([{ value: 1, at: "2026-09-20T12:30:00.000Z" }, { value: 0, at: "2026-09-20T12:30:40.000Z" }]);
    expect((await latestHealth(systemCtx())).get("health_up:staging:backend")).toEqual({ at: "2026-09-20T12:30:40.000Z", value: 0 });

    const after = await getRepoDashboard(systemCtx(), "o/r", at + 5_000, ENVS);
    const pills = (after.environments as { data: { name: string; pill: string; tone: string }[] }).data;
    expect(pills.map((e) => [e.name, e.pill, e.tone])[0]).toEqual(["staging", "DOWN", "bad"]);
    expect(pills[1].pill).not.toBe("DOWN");

    // The cron's NEXT tick is newer still, and the 45-day prune treats a
    // second-stamped row like any other.
    await handleRepoCron(refreshEnv(NONE), tick + 600_000, world().fetchImpl);
    expect((await latestHealth(systemCtx())).get("health_up:staging:backend")).toEqual({ at: "2026-09-20T12:40:00.000Z", value: 1 });
    await pruneRepoCapture(platformCtx(), at + 46 * 86_400_000);
    expect(await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric IN ('health_up', 'health_ms')`)).toEqual([]);
  });

  it("a repeat inside the same second writes nothing new", async () => {
    await runRepoRefresh(refreshEnv(NONE), NOW, world().fetchImpl);
    const again = await runRepoRefresh(refreshEnv(NONE), NOW + 300, world().fetchImpl);
    expect(again.health).toEqual(ALL_UP.map((o) => ({ ...o, written: 0 })));
  });

  it("names a down target with fixed words only — timeout / unreachable, never the error's text", async () => {
    const w = world((url) => {
      if (url === ENVS[0].frontendUrl) throw Object.assign(new Error(`connect failed to ${url} with s3cret`), { name: "TimeoutError" });
      if (url === ENVS[1].frontendUrl) throw new Error(`dns failure for ${url}`);
      return undefined;
    });
    const res = await runRepoRefresh(refreshEnv(NONE), NOW, w.fetchImpl);
    expect(res.health).toEqual([
      { env: "staging", part: "frontend", status: "failed", written: 2, detail: "timeout" }, UP("staging", "backend"),
      { env: "production", part: "frontend", status: "failed", written: 2, detail: "unreachable" }, UP("production", "backend"),
    ]);
  });

  describe("not_configured", () => {
    it("health — no environment in REPO_ENVIRONMENTS (and GitHub still runs: branches need none)", async () => {
      const w = world();
      const res = await runRepoRefresh(refreshEnv({ REPO_ENVIRONMENTS: undefined }), NOW, w.fetchImpl);
      expect(res.health).toBe("not_configured");
      expect(res.railway).toBe("not_configured"); // no environment → no token to look up
      expect(res.github).toEqual({ written: 0, unchanged: 0, failed: [] });
      for (const url of w.calls) expect(url.startsWith(GH)).toBe(true);
    });

    it("the three usage sources — exactly as runUsagePolls reports them", async () => {
      const res = await runRepoRefresh(refreshEnv({ ...NONE, GITHUB_SERVICE_TOKEN: GH_TOKEN }), NOW, world().fetchImpl);
      expect(res).toMatchObject({ cloudflare: "not_configured", railway: "not_configured", sapling: "not_configured" });
      expect(res.health).toEqual(ALL_UP);
    });

    it("github — without GITHUB_SERVICE_TOKEN, and without GITHUB_REPO", async () => {
      for (const over of [{ GITHUB_SERVICE_TOKEN: undefined }, { GITHUB_REPO: undefined }, { GITHUB_SERVICE_TOKEN: "" }] as Partial<Env>[]) {
        const w = world();
        const res = await runRepoRefresh(refreshEnv(over), NOW, w.fetchImpl);
        expect(res.github).toBe("not_configured");
        expect(w.calls.filter((u) => u.startsWith(GH))).toEqual([]);
        expect(w.calls).toHaveLength(10); // health + usage still ran
      }
    });

    it("everything absent: nothing is fetched at all", async () => {
      const w = world();
      expect(await runRepoRefresh(refreshEnv({ ...NONE, REPO_ENVIRONMENTS: undefined }), NOW, w.fetchImpl)).toEqual({
        health: "not_configured", cloudflare: "not_configured", railway: "not_configured", sapling: "not_configured", github: "not_configured",
      });
      expect(w.calls).toEqual([]);
    });
  });

  describe("arm isolation", () => {
    it("GitHub failing on every request: health and usage still run and report; failed holds ARM NAMES", async () => {
      const w = world((url) => (url.startsWith(GH) ? new Response("boom", { status: 500 }) : undefined));
      const res = await quietly(() => runRepoRefresh(refreshEnv(), NOW, w.fetchImpl));
      expect(res.health).toEqual(ALL_UP);
      expect(res).toMatchObject(USAGE_OK);
      expect(res.github).toEqual({ written: 0, unchanged: 0, failed: ["open_prs", "closed_prs", "commits", "deployments", "runs", "env_heads", "checks", "statuses", "reviews", "branches", "drift"] });
    });

    it("reconcile itself throwing: a fixed phrase, and the other arms' results are kept", async () => {
      const boom = (async () => { throw new Error(`reconcile exploded with ${GH_TOKEN}`); }) as never;
      const { out, logged } = await captured(() => runRepoRefresh(refreshEnv(), NOW, world().fetchImpl, boom));
      expect(out.github).toEqual({ written: 0, unchanged: 0, failed: ["unexpected error"] });
      expect(out.health).toEqual(ALL_UP);
      expect(out).toMatchObject(USAGE_OK);
      expect(logged).toContain("[redacted]");
      expect(leakedFragments(logged, GH_TOKEN)).toEqual([]);
    });

    it("a poller failing, and every health target down: GitHub still runs", async () => {
      const w = world((url) => {
        if (url === CF_URL) return new Response("", { status: 500 });
        if (HEALTH_URLS.includes(url)) throw new Error("connection refused");
        return undefined;
      });
      const res = await quietly(() => runRepoRefresh(refreshEnv(), NOW, w.fetchImpl));
      expect((res.health as { status: string }[]).map((o) => o.status)).toEqual(["failed", "failed", "failed", "failed"]);
      expect((res.cloudflare as { status: string }[]).map((o) => o.status)).toEqual(["failed", "failed"]);
      expect(res.railway).toEqual(USAGE_OK.railway);
      expect(res.github).toEqual({ written: 0, unchanged: 0, failed: [] });
      expect(w.calls.some((u) => u.startsWith(GH))).toBe(true);
    });
  });

  it("with 5 environments (19 + 7·5 = 54 > 50) the GitHub arm is SKIPPED and says so; health and usage still run", async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      ...WITH_IDS[0], key: `env${i}`, label: `env${i}`, branch: `b${i}`,
      frontendUrl: `https://e${i}.example.com`, apiUrl: `https://api.e${i}.example.com`,
    }));
    const w = world();
    const res = await runRepoRefresh(refreshEnv({ REPO_ENVIRONMENTS: JSON.stringify(five) }), NOW, w.fetchImpl);
    expect(res.github).toEqual({ written: 0, unchanged: 0, failed: [BUDGET_SKIP] });
    expect(BUDGET_SKIP).toBe("skipped: would exceed the subrequest budget");
    expect(w.calls.filter((u) => u.startsWith(GH))).toEqual([]);
    expect(res.health).toHaveLength(10);
    expect(res.cloudflare).toHaveLength(5);
    expect(w.calls.length).toBeLessThanOrEqual(SUBREQUEST_CAP);
  });

  it("with 4 environments (47) the GitHub arm still runs", async () => {
    const four = Array.from({ length: 4 }, (_, i) => ({
      ...WITH_IDS[0], key: `env${i}`, label: `env${i}`, branch: `b${i}`,
      frontendUrl: `https://e${i}.example.com`, apiUrl: `https://api.e${i}.example.com`,
    }));
    const w = world();
    const res = await runRepoRefresh(refreshEnv({ REPO_ENVIRONMENTS: JSON.stringify(four) }), NOW, w.fetchImpl);
    expect(res.github).toEqual({ written: 0, unchanged: 0, failed: [] });
    expect(w.calls.length).toBeLessThanOrEqual(refreshSubrequests(4));
  });

  // The worst case: every failure quotes its own request — headers AND body —
  // back, GitHub included (a GraphQL `errors` message is what ghGraphql throws).
  it("never carries a secret — not in the result, not in the logs — even when every failure echoes the request back", async () => {
    const echoThrow = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      throw new Error(`request failed: ${JSON.stringify(init?.headers)} ${String(init?.body ?? "")}`);
    }) as typeof fetch;
    const echoBody = (async (_u: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify({ message: `denied ${JSON.stringify(init?.headers)}`, errors: [{ message: `denied ${JSON.stringify(init?.headers)} ${String(init?.body ?? "")}` }] }), { status: 200 })) as typeof fetch;
    for (const fetchImpl of [echoThrow, echoBody]) {
      const { out, logged } = await captured(() => runRepoRefresh(refreshEnv(), NOW, fetchImpl));
      expect(out.github === "not_configured" ? [] : out.github.failed.length).toBeGreaterThan(0);
      const body = JSON.stringify(out);
      for (const secret of Object.values(SECRETS)) {
        expect(body).not.toContain(secret);
        expect(logged).not.toContain(secret);
      }
      expect(leakedFragments(body, GH_TOKEN)).toEqual([]);
      expect(leakedFragments(logged, GH_TOKEN)).toEqual([]);
      expect(logged).toContain("reconcileRepo"); // the GitHub failures WERE logged — scrubbed
      expect(logged).toContain("[redacted]");
      // `failed` is arm names (lower-case words), nothing an error could have written.
      if (out.github !== "not_configured") for (const name of out.github.failed) expect(name).toMatch(/^[a-z_]+$/);
    }
  });
});

// N1: the cron's own generic logger (and runUsagePolls' arm) used to log the
// raw Error. "These arms never throw" is the argument that was already wrong
// once in src/repo/github.ts: the progress arm fetches GitHub with the service
// token, so whatever it throws may quote it.
describe("the repo cron's own log sites never print a secret", () => {
  /** env.DB, except that a statement matching `pattern` throws an error quoting every secret. */
  const poisonedDb = (pattern: RegExp): Env["DB"] => new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => {
        if (pattern.test(sql)) throw new Error(`D1 exploded near authorization: Bearer ${GH_TOKEN} / ${Object.values(SECRETS).join(" / ")}`);
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });

  it("the progress arm (`:10`, fetches GitHub with the service token) throwing an error that echoes the token", async () => {
    const tick = Date.parse("2026-09-20T12:10:00Z");
    const { logged } = await captured(() => handleRepoCron({ ...refreshEnv(), DB: poisonedDb(/FROM sprints/) } as Env, tick, world().fetchImpl));
    expect(logged).toContain('"repo cron","progress"'); // it WAS logged…
    expect(logged).toContain("D1 exploded near authorization: Bearer [redacted]"); // …as a message, scrubbed
    for (const secret of Object.values(SECRETS)) expect(logged).not.toContain(secret);
    expect(leakedFragments(logged, GH_TOKEN)).toEqual([]);
    expect(logged).not.toContain("    at "); // the message only — never the Error object and its stack
  });

  // A context reads `env.DB` at each use, so a dead binding fails inside the first guarded read that
  // needs it. On a quiet tick that is the cron's own `safely` — health (its write is outside the ping's
  // own guard) and the handoff sweep. The three pollers never throw: the same failure lands in their own
  // logger, with their own scrub (the per-poller tests below), never in runUsagePolls' arm.
  it("the every-tick arms throwing — health and the handoff sweep — log scrubbed messages only", async () => {
    const tick = Date.parse("2026-09-20T12:40:00Z");
    const noDb = Object.defineProperty({ ...refreshEnv() }, "DB", {
      get() { throw new Error(`no database for ${Object.values(SECRETS).join(" / ")}`); },
    }) as Env;
    const { logged } = await captured(() => handleRepoCron(noDb, tick, world().fetchImpl));
    for (const label of ["health", "handoff expiry"]) expect(logged, label).toContain(`"repo cron","${label}","no database for [redacted]`);
    for (const secret of Object.values(SECRETS)) expect(logged).not.toContain(secret);
    expect(leakedFragments(logged, GH_TOKEN)).toEqual([]);
    expect(logged).not.toContain("    at ");
  });

  it("pollCloudflare's own marker write failing logs its message with the Cloudflare secrets scrubbed", async () => {
    const tick = Date.parse("2026-09-20T12:00:00Z");
    const w = world();
    const { logged } = await captured(() => handleRepoCron({ ...refreshEnv(), DB: poisonedDb(/repo_snapshots/) } as Env, tick, w.fetchImpl));
    expect(logged).toContain('"pollCloudflare","cf_polled","D1 exploded');
    for (const secret of [SECRETS.CF_ANALYTICS_TOKEN, SECRETS.CF_ANALYTICS_ACCOUNT_ID]) expect(logged).not.toContain(secret);
    expect(logged).not.toContain("    at ");
    expect(w.calls.filter((u) => u === RW_URL)).toHaveLength(2); // Railway, after Cloudflare, still ran
  });
});

describe("runLockedRepoRefresh — the refresh_lock snapshot", () => {
  it("takes the lock for the run, records who and when, and clears it after success", async () => {
    let during: { json: string; computed_at: string } | null = null;
    const w = world(async (url) => { if (url === HEALTH_URLS[0]) during = await lockRow(); return undefined; });
    const res = await runLockedRepoRefresh(refreshEnv(NONE), "admin-user", NOW, w.fetchImpl);
    expect(res.ok).toBe(true);
    expect(during).toEqual({ json: JSON.stringify({ by: "admin-user", at: new Date(NOW).toISOString() }), computed_at: new Date(NOW).toISOString() });
    expect(await lockRow()).toBeNull();
  });

  it("an overlapping call is refused without running anything, and says since when", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = world(async (url) => { if (url === HEALTH_URLS[0]) await gate; return undefined; });
    const firstRun = runLockedRepoRefresh(refreshEnv(NONE), "admin-user", NOW, slow.fetchImpl);
    await vi.waitFor(async () => { expect(await lockRow()).not.toBeNull(); });

    const second = world();
    expect(await runLockedRepoRefresh(refreshEnv(NONE), "other-admin", NOW + 5_000, second.fetchImpl))
      .toEqual({ ok: false, since: new Date(NOW).toISOString() });
    expect(second.calls).toEqual([]);

    release();
    expect((await firstRun).ok).toBe(true);
    expect(await lockRow()).toBeNull();
  });

  it("a lock younger than 3 minutes blocks — 100 s old included; a stale one is ignored and overwritten", async () => {
    expect(REFRESH_LOCK_MS).toBe(180_000);
    await putLock(100_000, NOW); // stale under the old 90 s; a slow-but-live run today
    const slow = world();
    expect((await runLockedRepoRefresh(refreshEnv(NONE), "admin-user", NOW, slow.fetchImpl)).ok).toBe(false);
    expect(slow.calls).toEqual([]);
    await run(env.DB, `DELETE FROM repo_snapshots WHERE kind = ?`, REFRESH_LOCK);

    await putLock(REFRESH_LOCK_MS - 1_000, NOW);
    const blocked = world();
    expect((await runLockedRepoRefresh(refreshEnv(NONE), "admin-user", NOW, blocked.fetchImpl)).ok).toBe(false);
    expect(blocked.calls).toEqual([]);
    expect(await lockRow()).not.toBeNull(); // someone else's live lock is not ours to clear

    await run(env.DB, `DELETE FROM repo_snapshots WHERE kind = ?`, REFRESH_LOCK);
    await putLock(REFRESH_LOCK_MS + 1_000, NOW);
    const ran = world();
    expect((await runLockedRepoRefresh(refreshEnv(NONE), "admin-user", NOW, ran.fetchImpl)).ok).toBe(true);
    expect(ran.calls).toHaveLength(4);
    expect(await lockRow()).toBeNull();
  });

  it("clears the lock when the refresh throws", async () => {
    const boom = (async () => { throw new Error("arm exploded"); }) as never;
    await expect(runLockedRepoRefresh(refreshEnv(NONE), "admin-user", NOW, world().fetchImpl, boom)).rejects.toThrow("arm exploded");
    expect(await lockRow()).toBeNull();
  });

  it("a run that outlived its lock does not delete the lock of the run that replaced it", async () => {
    const theirs = JSON.stringify({ by: "other-admin", at: "later" });
    const replaced = (async () => {
      await run(env.DB, `UPDATE repo_snapshots SET json = ? WHERE kind = ?`, theirs, REFRESH_LOCK);
      return {} as RepoRefreshResult;
    }) as never;
    await runLockedRepoRefresh(refreshEnv(NONE), "admin-user", NOW, undefined, replaced);
    expect((await lockRow())?.json).toBe(theirs);
  });
});

describe("POST /admin/poll (session- + admin-gated, never MCP)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  /** The route has no fetch seam (like /admin/backfill), so these swap the GLOBAL fetch. */
  const stubFetch = (impl: typeof fetch): string[] => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", ((u: RequestInfo | URL, init?: RequestInit) => { seen.push(String(u)); return impl(u, init); }) as typeof fetch);
    return seen;
  };
  const post = async (who: string | null, e: Env) =>
    app.request("/admin/poll", { method: "POST", headers: who ? { cookie: await cookieFor(who) } : {} }, await syncOrgConfig(e));

  it("401s without a session, and nothing runs", async () => {
    const seen = stubFetch(world().fetchImpl);
    expect((await post(null, refreshEnv())).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("403s for a non-admin principal, and nothing runs", async () => {
    const seen = stubFetch(world().fetchImpl);
    const res = await post("not-admin", refreshEnv());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "admin only" });
    expect(seen).toEqual([]);
    expect(await lockRow()).toBeNull();
  });

  it("for an admin with nothing configured: 200, every source not_configured, no network", async () => {
    const seen = stubFetch(world().fetchImpl);
    const res = await post("admin-user", refreshEnv({ ...NONE, REPO_ENVIRONMENTS: undefined }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ health: "not_configured", cloudflare: "not_configured", railway: "not_configured", sapling: "not_configured", github: "not_configured" });
    expect(seen).toEqual([]);
  });

  it("for an admin with everything configured: 200 and the whole result; the lock is gone afterwards", async () => {
    stubFetch(world().fetchImpl);
    const res = await post("admin-user", refreshEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as RepoRefreshResult;
    expect(Object.keys(body)).toEqual(["health", "cloudflare", "railway", "sapling", "github"]);
    expect(body.github).toEqual({ written: 0, unchanged: 0, failed: [] });
    expect(await lockRow()).toBeNull();
  });

  it("409s while a refresh is already running — without running — and runs over a stale lock", async () => {
    const seen = stubFetch(world().fetchImpl);
    await putLock(10_000);
    const held = await lockRow();
    const res = await post("admin-user", refreshEnv());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "a refresh is already running", since: held?.computed_at });
    expect(seen).toEqual([]);

    await run(env.DB, `UPDATE repo_snapshots SET computed_at = ? WHERE kind = ?`, new Date(Date.now() - REFRESH_LOCK_MS - 5_000).toISOString(), REFRESH_LOCK);
    expect((await post("admin-user", refreshEnv(NONE))).status).toBe(200);
    expect(seen).toHaveLength(4);
    expect(await lockRow()).toBeNull();
  });

  // Guarded like the /admin/poll-usage test: the stub is proven to be the one
  // in force BEFORE any secret-bearing env is used.
  it("every source failing, each echoing its request into the error: 200, never a 500, no secret in the JSON or the logs", async () => {
    const seen = stubFetch((async (_u: RequestInfo | URL, init?: RequestInit) => {
      throw new Error(`request failed: ${JSON.stringify(init?.headers)} ${String(init?.body ?? "")}`);
    }) as typeof fetch);
    await expect(fetch("https://stub-check.invalid/")).rejects.toThrow("request failed");
    expect(seen).toEqual(["https://stub-check.invalid/"]);

    const { out: res, logged } = await captured(() => post("admin-user", refreshEnv()));
    expect(res.status).toBe(200); // every source failed — the BODY says so
    const text = await res.text();
    const body = JSON.parse(text) as RepoRefreshResult;
    expect((body.health as { status: string }[]).map((o) => o.status)).toEqual(["failed", "failed", "failed", "failed"]);
    expect(body.github).toMatchObject({ written: 0, unchanged: 0 });
    expect((body.github as { failed: string[] }).failed).toContain("deployments");
    for (const secret of Object.values(SECRETS)) {
      expect(text).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
    expect(leakedFragments(text, GH_TOKEN)).toEqual([]);
    expect(leakedFragments(logged, GH_TOKEN)).toEqual([]);
    expect(seen.length).toBeLessThanOrEqual(1 + refreshSubrequests(2)); // the stub check + the refresh — nothing reached the network
    expect(await lockRow()).toBeNull();
  });
});
