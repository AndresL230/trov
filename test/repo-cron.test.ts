/**
 * Task 13 — health pings and the 10-minute cron trigger.
 *
 * `pingHealth` writes the health_up/health_ms metrics one 10-minute bucket at a
 * time; `handleRepoCron` is the single repo cron trigger's dispatcher. ONE heavy
 * job per invocation, keyed off the fire time's minute/hour (see the budget
 * comment in src/repo/cron.ts): health on EVERY tick, the hourly-polls slot at
 * minute 0, and — every 6th hour — the progress backstop at :10, the GitHub
 * reconcile at :20 and the capture prune at :30, each in its own invocation.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { ORG_A, systemCtx } from "./helpers/tenant";
import { addPart, deployRow } from "./helpers/dashboard-hosting";
import wranglerToml from "../wrangler.toml?raw";
import { all, run, nowIso } from "./helpers/db";
import { ingestRepoEvent } from "../src/consumer";
import { pingHealth, reservedHost } from "../src/repo/poll";
import { REPO_CRON } from "../src/repo/cron";
import { handleRepoCron } from "./helpers/org-config";
import { getRepoDashboard } from "../src/tools/repo";
import { getSnapshot, putMetric } from "../src/repo/store";
import { ENVS, fakeGithub, seedOrgRepoConfig } from "./helpers/repo";
import type { RepoEvent } from "../src/repo/types";
import type { Env } from "../src/env";

const T = Date.parse("2026-09-20T12:07:31Z");
/** The four ticks the dispatcher treats specially (F1). */
const HOURLY = Date.parse("2026-09-20T12:00:00Z");        // health + the (empty) hourly-polls slot
const PROGRESS_TICK = Date.parse("2026-09-20T12:10:00Z"); // the progress backstop, alone
const RECONCILE_TICK = Date.parse("2026-09-20T12:20:00Z");// reconcileRepo, alone
const PRUNE_TICK = Date.parse("2026-09-20T12:30:00Z");    // pruneRepoCapture (D1 only)
const NOT_SIX = Date.parse("2026-09-20T13:20:00Z");       // the same minute, a non-6-hourly hour

/** `SAPLING_METRICS_TOKEN` is pinned absent unless a test sets it: a local `.dev.vars` must not decide a request count. */
const ghEnv = (over: Partial<Env> = {}): Env =>
  ({ ...env, GITHUB_SERVICE_TOKEN: "t", GITHUB_REPO: "o/r", SAPLING_METRICS_TOKEN: undefined, ...over }) as unknown as Env;
const okFetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
const snapshots = () => all(env.DB, `SELECT 1 FROM repo_snapshots`);
const progressRows = () => all(env.DB, `SELECT 1 FROM sprint_progress`);
const ok = <T>(s: { status: string; data?: T }): T => { expect(s.status).toBe("ok"); return (s as { data: T }).data; };

/** A sprint whose github_ref is a one-issue array — what recomputeAllProgress reads. */
async function seedSprint(): Promise<void> {
  await run(env.DB, `INSERT INTO sprints (title, target_date, status, github_ref, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
    "M", "2026-10-01", "in_progress", "[1]", nowIso(), "andres");
}

const base = { raw: "{}", provenance: "webhook" as const };
const put = async (rows: RepoEvent[]) => { for (const r of rows) await ingestRepoEvent(systemCtx(), r); };
const deploy = (id: number, state: string, mins: number): RepoEvent =>
  ({ ...base, semantic_key: `gh:deploy:${id}:${state}`, kind: "deploy", number: id, env: "staging", part: "backend", sha: "abc", state, actor_login: "railway-app[bot]", occurred_at: new Date(T - mins * 60_000).toISOString() });

describe("pingHealth", () => {
  it("records up/ms per target in a 10-minute bucket, and a throw as down", async () => {
    const fetchImpl = (async (u: RequestInfo | URL) => {
      if (String(u) === "https://api.saplinglearn.com/api/health") throw new Error("connect timeout");
      return new Response("ok", { status: String(u).includes("staging.sapling") ? 200 : 503 });
    }) as typeof fetch;
    await pingHealth(systemCtx(), ENVS, T, fetchImpl);
    await pingHealth(systemCtx(), ENVS, T + 60_000, fetchImpl); // same bucket → no second row
    const up = await all<{ env: string; part: string; value: number; at: string }>(env.DB, `SELECT env, part, value, at FROM repo_metrics WHERE metric = 'health_up' ORDER BY env, part`);
    expect(up).toEqual([
      { env: "production", part: "backend", value: 0, at: "2026-09-20T12:00:00.000Z" },
      { env: "production", part: "frontend", value: 0, at: "2026-09-20T12:00:00.000Z" },
      { env: "staging", part: "backend", value: 1, at: "2026-09-20T12:00:00.000Z" },
      { env: "staging", part: "frontend", value: 1, at: "2026-09-20T12:00:00.000Z" },
    ]);
  });

  it("never pings a host on a reserved name (the local seed's *.example.com): no request, no row", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (u: RequestInfo | URL) => { asked.push(String(u)); return new Response("ok"); }) as typeof fetch;
    const made = ENVS.map((e) => ({ ...e, frontendUrl: `https://app.${e.key}.sapling.example.com`, apiUrl: `https://api.${e.key}.acme.test` }));
    expect(await pingHealth(systemCtx(), made, T, fetchImpl)).toEqual([]);
    expect(asked).toEqual([]);
    expect(await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).toEqual([]);
    for (const u of ["https://example", "http://x.invalid/", "https://example.net", "https://a.example.org."]) expect(reservedHost(u), u).toBe(true);
    for (const u of ["https://api.saplinglearn.com", "https://myexample.com", "https://example.com.au", "http://localhost:8787", "not a url"]) expect(reservedHost(u), u).toBe(false);
  });

  // M13: the four targets are pinged CONCURRENTLY — sequentially they cost up to
  // 4 × the 8s timeout before the tick's real work starts.
  it("pings every target concurrently", async () => {
    let inFlight = 0, peak = 0;
    const fetchImpl = (async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    await pingHealth(systemCtx(), ENVS, T, fetchImpl);
    expect(peak).toBe(4);
  });

  it("feeds the health block and drags the pill to DOWN when a target is unreachable", async () => {
    const fetchImpl = (async (u: RequestInfo | URL) => new Response("x", { status: String(u).includes("api.staging") ? 500 : 200 })) as typeof fetch;
    await pingHealth(systemCtx(), ENVS, T, fetchImpl);
    const d = await getRepoDashboard(systemCtx(), "o/r", T, ENVS);
    const rows = ok(d.health);
    expect(rows.map((r) => [r.env, r.up])).toEqual([["staging · web", true], ["staging · api", false], ["production · web", true], ["production · api", true]]);
    // F5: the code produces DOWN (tone `bad`), never DEGRADED, for an unreachable target.
    const [staging, production] = ok(d.environments);
    expect(staging).toMatchObject({ pill: "DOWN", tone: "bad" });
    expect(production).toMatchObject({ pill: "UNKNOWN", tone: "neutral" });
  });

  it("DOWN outranks a failed deploy and a failing check", async () => {
    await put([
      { ...base, semantic_key: "gh:push:abc:main", kind: "push", ref: "main", sha: "abc", actor_login: "AndresL230", count: 1, occurred_at: new Date(T - 40 * 60_000).toISOString() },
      deploy(1, "failure", 30),
      { ...base, semantic_key: "gh:check:9:completed", kind: "check", number: 9, name: "e2e", state: "failure", sha: "abc", ref: "main", occurred_at: new Date(T - 20 * 60_000).toISOString() },
    ]);
    const fetchImpl = (async (u: RequestInfo | URL) => new Response("x", { status: String(u).includes("api.staging") ? 500 : 200 })) as typeof fetch;
    await pingHealth(systemCtx(), ENVS, T, fetchImpl);
    const [staging] = ok((await getRepoDashboard(systemCtx(), "o/r", T, ENVS)).environments);
    expect(staging).toMatchObject({ pill: "DOWN", tone: "bad" });
  });

  it("a fresh, up ping with nothing deployed or checked is UNKNOWN, never HEALTHY", async () => {
    await pingHealth(systemCtx(), ENVS, T, okFetch);
    const [staging] = ok((await getRepoDashboard(systemCtx(), "o/r", T, ENVS)).environments);
    expect(staging).toMatchObject({ pill: "UNKNOWN", tone: "neutral", ci: "No checks captured" });
  });

  // F4: connectivity for the ENVIRONMENT cards includes health; the DEPLOYS
  // fallback must not — one ping is not "no deploys recorded".
  it("a health ping alone connects the environment cards but leaves deploys not_connected", async () => {
    await pingHealth(systemCtx(), ENVS, T, okFetch);
    const d = await getRepoDashboard(systemCtx(), "o/r", T, ENVS);
    expect(d.environments.status).toBe("ok");
    expect(d.deploys.status).toBe("not_connected");
  });

  // F3: three states. A reading that has gone stale means the PINGS stopped, not
  // that they were never set up — `empty`, never `not_connected`.
  it("a health row older than 30 minutes is stale — the block is empty, not not_connected", async () => {
    const stale = T - 31 * 60_000;
    await putMetric(systemCtx(), { metric: "health_up", env: "staging", part: "frontend", value: 1, at: new Date(stale).toISOString() });
    await putMetric(systemCtx(), { metric: "health_ms", env: "staging", part: "frontend", value: 100, at: new Date(stale).toISOString() });
    expect((await getRepoDashboard(systemCtx(), "o/r", T, ENVS)).health.status).toBe("empty");
  });

  it("is not_connected only when no reading has EVER landed", async () => {
    expect((await getRepoDashboard(systemCtx(), "o/r", T, ENVS)).health.status).toBe("not_connected");
  });

  // F5: a stale DOWN reading cannot drag the pill — the ping stopped, the site
  // is not known to be down.
  it("a stale down reading does not produce DOWN", async () => {
    const stale = T - 31 * 60_000;
    // A part with a landed deploy, so the card has something to show beside the stale ping.
    await seedOrgRepoConfig(env.DB, ORG_A, "o/r");
    await addPart(ORG_A, "staging", "frontend", "cloudflare", "web", { worker: "w" });
    await deployRow(ORG_A, "staging", "frontend", "cloudflare", "d1", "ready", new Date(T - 20 * 60_000).toISOString());
    await putMetric(systemCtx(), { metric: "health_up", env: "staging", part: "frontend", value: 0, at: new Date(stale).toISOString() });
    const [staging] = ok((await getRepoDashboard(systemCtx(), "o/r", T, ENVS)).environments);
    expect(staging).toMatchObject({ pill: "UNKNOWN", tone: "neutral" });
  });
});

describe("handleRepoCron", () => {
  // M8: `src/index.ts` dispatches on exact string equality, so a wrangler.toml
  // that drifted from REPO_CRON would silently stop the health pings AND the
  // progress backstop. Assert the declaration, not just the constant.
  it("is the cron expression wrangler.toml declares", () => {
    expect(REPO_CRON).toBe("*/10 * * * *");
    expect(wranglerToml).toContain(`"${REPO_CRON}"`);
  });

  // Without `global_fetch_strictly_public`, a Worker's fetch() to a host on its OWN zone skips Cloudflare's
  // front door and goes to the zone's origin — trov.dev has none behind the Worker, so the ping of Trov's own
  // deployment always failed and its Repo dashboard read production as Down while trov.dev was up. Workerd
  // here has no zones, so only the declaration (and its reason, beside it) can be pinned.
  it("pings through the public front door: wrangler.toml sets global_fetch_strictly_public, with its reason", () => {
    const flags = /^compatibility_flags\s*=\s*\[([^\]]*)\]/m.exec(wranglerToml)?.[1] ?? "";
    expect(flags.split(",").map((f) => f.trim())).toEqual(expect.arrayContaining(['"nodejs_compat"', '"global_fetch_strictly_public"']));
    expect(wranglerToml).toMatch(/# `global_fetch_strictly_public`: .*front door/);
    expect(wranglerToml).toContain("pingHealth");
  });

  it("pings every tick; with no service token it does nothing else and never throws", async () => {
    await handleRepoCron(ghEnv({ GITHUB_SERVICE_TOKEN: undefined }), T, okFetch);
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
    expect(await snapshots()).toHaveLength(0);
  });

  it("at minute 0 only health runs when no hourly poller is configured — never a 6-hourly heavy job", async () => {
    await seedSprint();
    // A GitHub that would answer every arm: nothing may run here regardless.
    const gh = fakeGithub({ "/issues/1": { state: "closed" } });
    await handleRepoCron(ghEnv(), HOURLY, gh.fetchImpl);
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
    expect(await snapshots()).toHaveLength(0);
    expect(await progressRows()).toHaveLength(0);
    expect(gh.calls).toHaveLength(4); // the four health pings, nothing else
  });

  // The hourly slot's one poller (a host's usage is the hosting providers' `:40` job —
  // test/hosting.cron.test.ts). Sapling's active users run at minute 0 ONLY, and only
  // when `SAPLING_METRICS_TOKEN` is set (and not empty).
  describe("the hourly Sapling active-users poll", () => {
    const METRICS_PATH = "/api/internal/metrics";
    const spEnv = (over: Partial<Env> = {}): Env =>
      ghEnv({ REPO_ENVIRONMENTS: JSON.stringify(ENVS), SAPLING_METRICS_TOKEN: "s3cret", ...over });
    /** Health pings answer 200; Sapling answers its three windows; `broken` URLs throw. */
    const recorder = (broken: string[] = []) => {
      const calls: string[] = [];
      const auth: (string | null)[] = [];
      const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
        const url = String(u);
        calls.push(url);
        if (broken.includes(url)) throw new Error("connect timeout");
        if (!url.endsWith(METRICS_PATH)) return new Response("ok", { status: 200 });
        auth.push(new Headers(init?.headers).get("authorization"));
        return new Response(JSON.stringify({ active_users: { "24h": 74, "7d": 318, "30d": 318 } }), { status: 200 });
      }) as typeof fetch;
      return { calls, auth, fetchImpl, sapling: () => calls.filter((c) => c.endsWith(METRICS_PATH)) };
    };
    const spRows = () => all<{ env: string; metric: string; value: number; at: string }>(env.DB,
      `SELECT env, metric, value, at FROM repo_metrics WHERE metric LIKE 'active_users_%' ORDER BY env, metric`);

    it("at minute 0 with the token, asks each environment's backend once and stores the hour", async () => {
      const r = recorder();
      await handleRepoCron(spEnv(), HOURLY, r.fetchImpl);
      expect(r.sapling()).toEqual([
        "https://api.staging.saplinglearn.com/api/internal/metrics", "https://api.saplinglearn.com/api/internal/metrics",
      ]);
      expect(r.auth).toEqual(["Bearer s3cret", "Bearer s3cret"]);
      expect(r.calls).toHaveLength(6); // 4 health pings + 2 Sapling requests
      const at = "2026-09-20T12:00:00.000Z";
      expect(await spRows()).toEqual([
        { env: "production", metric: "active_users_24h", value: 74, at }, { env: "production", metric: "active_users_30d", value: 318, at },
        { env: "production", metric: "active_users_7d", value: 318, at },
        { env: "staging", metric: "active_users_24h", value: 74, at }, { env: "staging", metric: "active_users_30d", value: 318, at },
        { env: "staging", metric: "active_users_7d", value: 318, at },
      ]);
      expect(await snapshots()).toHaveLength(0); // still nothing ELSE on this tick
    });

    it("the full slot: health 2N + Sapling N = 3N requests — the legacy Cloudflare secrets add none", async () => {
      const r = recorder();
      await handleRepoCron(spEnv({ CF_ANALYTICS_TOKEN: "cf-token", CF_ANALYTICS_ACCOUNT_ID: "acct" }), HOURLY, r.fetchImpl);
      expect(r.calls).toHaveLength(6);
      expect(r.sapling()).toHaveLength(2);
    });

    it("at minute 10 it is not called", async () => {
      const r = recorder();
      await handleRepoCron(spEnv(), PROGRESS_TICK, r.fetchImpl);
      expect(r.sapling()).toHaveLength(0);
      expect(await spRows()).toEqual([]);
    });

    it.each([["absent", undefined], ["empty", ""]])("with the token %s it is not called", async (_name, token) => {
      const r = recorder();
      await handleRepoCron(spEnv({ SAPLING_METRICS_TOKEN: token }), HOURLY, r.fetchImpl);
      expect(r.sapling()).toHaveLength(0);
      expect(r.calls).toHaveLength(4); // the health pings, nothing else
      expect(await spRows()).toEqual([]);
    });

    it("a Sapling endpoint that throws never costs the tick", async () => {
      const r = recorder(["https://api.staging.saplinglearn.com/api/internal/metrics", "https://api.saplinglearn.com/api/internal/metrics"]);
      await expect(handleRepoCron(spEnv(), HOURLY, r.fetchImpl)).resolves.toBeUndefined();
      expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
      expect(await spRows()).toEqual([]);
    });
  });

  it("at :10 of a 6-hourly hour the progress backstop runs, and the reconcile does not", async () => {
    await seedSprint();
    const gh = fakeGithub({ "/issues/1": { state: "closed" } });
    await handleRepoCron(ghEnv(), PROGRESS_TICK, gh.fetchImpl);
    expect(await progressRows()).toHaveLength(1);
    expect(await snapshots()).toHaveLength(0);
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
  });

  it("at :20 of a 6-hourly hour the reconcile runs through the injected fetch, alone, well under the subrequest cap", async () => {
    await seedSprint();
    const gh = fakeGithub({
      "/pulls?state=open": [], "/pulls?state=closed": [],
      "/commits?sha=main&per_page=1": [{ sha: "mainhead0000001", commit: { message: "ship it", committer: { date: "2026-09-20T10:00:00Z" } }, author: { login: "AndresL230" } }],
      "/commits?sha=production&per_page=1": [{ sha: "prodhead1234567", commit: { message: "release cut", committer: { date: "2026-09-19T10:00:00Z" } }, author: { login: "AndresL230" } }],
    });
    await handleRepoCron(ghEnv(), RECONCILE_TICK, gh.fetchImpl);
    // The end-to-end cover the admin route can never have (it has no fetchImpl seam).
    expect(await getSnapshot(systemCtx(), "prs_reconciled")).not.toBeNull();
    expect(await getSnapshot(systemCtx(), "env_heads")).not.toBeNull();
    expect(await getSnapshot(systemCtx(), "drift")).not.toBeNull();
    expect(await getSnapshot(systemCtx(), "branches")).not.toBeNull();
    // Health still pinged on the same tick.
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
    // The progress backstop is NOT stacked on this invocation (F1): it is
    // unbounded — one fetch per issue number of every array-ref sprint.
    expect(await progressRows()).toHaveLength(0);
    // Cloudflare caps one invocation at 50 subrequests on the free plan; every
    // outbound fetch of this tick went through the injected impl.
    expect(gh.calls.length).toBeLessThan(50);
  });

  it("at :20 with no service token, only health runs and no snapshot is written", async () => {
    await handleRepoCron(ghEnv({ GITHUB_SERVICE_TOKEN: undefined }), RECONCILE_TICK, okFetch);
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
    expect(await snapshots()).toHaveLength(0);
  });

  it("at :30 of a 6-hourly hour the prune runs, and the reconcile does not", async () => {
    const old = new Date(PRUNE_TICK - 100 * 24 * 60 * 60 * 1000).toISOString(); // past the 45-day retention
    await putMetric(systemCtx(), { metric: "health_up", env: "staging", part: "frontend", value: 1, at: old });
    await handleRepoCron(ghEnv(), PRUNE_TICK, okFetch);
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up' AND at = ?`, old)).length).toBe(0);
    expect(await snapshots()).toHaveLength(0);
  });

  it("at the same minute of an hour that is not a 6-hourly one, none of the three jobs run", async () => {
    await seedSprint();
    const old = new Date(NOT_SIX - 100 * 24 * 60 * 60 * 1000).toISOString();
    await putMetric(systemCtx(), { metric: "health_up", env: "staging", part: "frontend", value: 1, at: old });
    await handleRepoCron(ghEnv(), NOT_SIX, okFetch);
    // Prune did not run — the old ping is still there.
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up' AND at = ?`, old)).length).toBe(1);
    // Neither the reconcile nor the progress backstop ran.
    expect(await snapshots()).toHaveLength(0);
    expect(await progressRows()).toHaveLength(0);
  });

  describe("the :30 tick also prunes OAuth", () => {
    it("deletes an old spent code alongside the repo prune", async () => {
      await env.DB.prepare(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES ('c', 'C', '[]', '2026-01-01T00:00:00.000Z')`).run();
      await env.DB.prepare(`INSERT INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('p', 'P', 'stone', 't', 't')`).run();
      await env.DB.prepare(`INSERT INTO oauth_grants (id, person, client_id, client_name, created_at) VALUES (1, 'p', 'c', 'C', 't')`).run();
      await env.DB.prepare(`INSERT INTO oauth_codes (code_hash, client_id, person, grant_id, redirect_uri, code_challenge, created_at, expires_at, used_at) VALUES ('h', 'c', 'p', 1, 'r', 'x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', '2026-01-01T00:00:30.000Z')`).run();
      const ok = (async () => new Response("ok", { status: 200 })) as typeof fetch;
      await handleRepoCron(env as unknown as Env, Date.parse("2026-09-24T06:30:00.000Z"), ok);
      expect(await env.DB.prepare(`SELECT 1 AS x FROM oauth_codes`).first()).toBeNull();
    });
  });
});
