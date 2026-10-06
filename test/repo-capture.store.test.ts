import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { all } from "../src/db";
import { ingestRepoEvent } from "../src/consumer";
import { repoEnvironments } from "../src/repo/config";
import { putSnapshot, getSnapshot, putMetric, putMetrics, metricSeries, metricsSince, metricsEver, productReadings, latestMetric, pruneRepoCapture } from "../src/repo/store";
import type { RepoEvent, RepoEventRow } from "../src/repo/types";

import { platformCtx, systemCtx, ORG_A } from "./helpers/tenant";
const push = (over: Partial<RepoEvent> = {}): RepoEvent => ({
  semantic_key: "gh:push:abc1234:main", kind: "push", ref: "main", sha: "abc1234", actor_login: "jose-a",
  count: 2, title: "fix: thing", raw: "{}", provenance: "webhook", occurred_at: "2026-09-20T10:00:00Z", ...over,
});

describe("ingestRepoEvent — the repo capture gate", () => {
  it("writes once and drops a redelivery as unchanged", async () => {
    expect((await ingestRepoEvent(systemCtx(), push())).outcome).toBe("written");
    expect((await ingestRepoEvent(systemCtx(), push())).outcome).toBe("unchanged");
    const rows = await all<RepoEventRow>(env.DB, `SELECT * FROM repo_events`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "push", ref: "main", sha: "abc1234", count: 2, env: null, part: null });
  });

  it("never raises an identity task — bots and CI are not people", async () => {
    await ingestRepoEvent(systemCtx(), push({ actor_login: "railway-app[bot]" }));
    expect(await all(env.DB, `SELECT * FROM identity_tasks`)).toHaveLength(0);
  });
});

describe("repoEnvironments", () => {
  it("parses the configured environments and tolerates junk", () => {
    const envs = repoEnvironments(env);
    expect(envs.map((e) => [e.key, e.branch])).toEqual([["staging", "main"], ["production", "production"]]);
    expect(repoEnvironments({ REPO_ENVIRONMENTS: "not json" })).toEqual([]);
    expect(repoEnvironments({})).toEqual([]);
  });
});

describe("snapshots and metrics", () => {
  it("a snapshot is last-write-wins", async () => {
    await putSnapshot(systemCtx(), "drift", { ahead: 1 }, "2026-09-20T10:00:00Z");
    await putSnapshot(systemCtx(), "drift", { ahead: 5 }, "2026-09-20T11:00:00Z");
    expect(await getSnapshot<{ ahead: number }>(systemCtx(), "drift")).toEqual({ data: { ahead: 5 }, computedAt: "2026-09-20T11:00:00Z" });
    expect(await getSnapshot(systemCtx(), "nope")).toBeNull();
  });

  // M9: `at` is compared as a RAW STRING by every read (`ORDER BY at`,
  // `at >= ?`), so the write seam normalises it — one `toISOString()` shape for
  // every writer, present and future.
  it("a metric point is unique per (metric, env, part, at), stored in one normalised format", async () => {
    const m = { metric: "health_ms", env: "staging", part: "backend", value: 212, at: "2026-09-20T10:00:00Z" };
    await putMetric(systemCtx(), m);
    await putMetric(systemCtx(), { ...m, value: 999 }); // a double-fired cron: first write stands
    await putMetric(systemCtx(), { ...m, at: "2026-09-20T10:10:00Z", value: 148 });
    expect(await metricSeries(systemCtx(), "health_ms", "staging", "backend", "2026-09-20T00:00:00Z"))
      .toEqual([{ at: "2026-09-20T10:00:00.000Z", value: 212 }, { at: "2026-09-20T10:10:00.000Z", value: 148 }]);
    expect(await latestMetric(systemCtx(), "health_ms", "staging", "backend")).toEqual({ at: "2026-09-20T10:10:00.000Z", value: 148 });
  });

  // M1 (Task 14): `metricSeries` compares `at >= sinceIso` as a raw string —
  // its FIRST production caller (the coverage/bundle/TODO reads) passes a
  // caller-computed bound that may lack milliseconds, which would otherwise
  // sort AFTER a normalised "…000Z" row of the same instant and wrongly
  // exclude it.
  it("normalises its `sinceIso` bound the same way `at` is stored, and returns [] for an unparseable one", async () => {
    await putMetric(systemCtx(), { metric: "coverage", env: "", part: "", value: 78.4, at: "2026-09-20T09:30:00Z" });
    // Bound given WITHOUT milliseconds — the point above is stored WITH them
    // ("2026-09-20T09:30:00.000Z"). A raw-string compare would exclude it.
    expect(await metricSeries(systemCtx(), "coverage", "", "", "2026-09-20T09:30:00Z"))
      .toEqual([{ at: "2026-09-20T09:30:00.000Z", value: 78.4 }]);
    expect(await metricSeries(systemCtx(), "coverage", "", "", "not a date")).toEqual([]);
  });

  // Task 16: the Usage tab reads every usage series of every environment in ONE
  // statement and slices the ranges in memory. P5-4: the read takes GROUPS, each
  // with its own bound, so a gauge that only needs 3 hours does not drag 30 days.
  it("metricsSince returns several metrics across envs in one ordered read, bound normalised like metricSeries", async () => {
    await putMetric(systemCtx(), { metric: "cf_requests", env: "production", part: "frontend", value: 9, at: "2026-09-20T11:00:00Z" });
    await putMetric(systemCtx(), { metric: "cf_requests", env: "staging", part: "frontend", value: 5, at: "2026-09-20T09:00:00Z" });
    await putMetric(systemCtx(), { metric: "cf_errors", env: "staging", part: "frontend", value: 1, at: "2026-09-20T10:00:00Z" });
    await putMetric(systemCtx(), { metric: "cf_requests", env: "staging", part: "frontend", value: 4, at: "2026-09-20T08:00:00Z" }); // before the bound
    await putMetric(systemCtx(), { metric: "coverage", env: "", part: "", value: 78.4, at: "2026-09-20T10:30:00Z" });                  // not asked for
    // Bound WITHOUT milliseconds, equal to a stored instant — a raw compare would drop it.
    expect(await metricsSince(systemCtx(), [{ metrics: ["cf_requests", "cf_errors"], since: "2026-09-20T09:00:00Z" }])).toEqual([
      { metric: "cf_requests", env: "staging", part: "frontend", at: "2026-09-20T09:00:00.000Z", value: 5 },
      { metric: "cf_errors", env: "staging", part: "frontend", at: "2026-09-20T10:00:00.000Z", value: 1 },
      { metric: "cf_requests", env: "production", part: "frontend", at: "2026-09-20T11:00:00.000Z", value: 9 },
    ]);
    expect(await metricsSince(systemCtx(), [{ metrics: ["cf_requests"], since: "not a date" }])).toEqual([]);
    expect(await metricsSince(systemCtx(), [{ metrics: [], since: "2026-09-20T09:00:00Z" }])).toEqual([]);
    expect(await metricsSince(systemCtx(), [])).toEqual([]);
  });

  it("metricsSince applies EACH group's bound independently, in one ordered result", async () => {
    // Two days old: inside cf_requests' 30-day bound, outside rw_cpu's 3-hour one.
    await putMetric(systemCtx(), { metric: "cf_requests", env: "staging", part: "frontend", value: 7, at: "2026-09-18T10:00:00Z" });
    await putMetric(systemCtx(), { metric: "rw_cpu", env: "staging", part: "backend", value: 0.4, at: "2026-09-18T10:00:00Z" });
    await putMetric(systemCtx(), { metric: "rw_cpu", env: "staging", part: "backend", value: 0.5, at: "2026-09-20T09:00:00Z" });
    await putMetric(systemCtx(), { metric: "active_users_24h", env: "staging", part: "", value: 3, at: "2026-09-18T10:00:00Z" }); // outside its 24h
    await putMetric(systemCtx(), { metric: "active_users_24h", env: "staging", part: "", value: 4, at: "2026-09-20T10:00:00Z" });
    const rows = await metricsSince(systemCtx(), [
      { metrics: ["cf_requests"], since: "2026-08-21T10:00:00Z" },
      { metrics: ["active_users_24h"], since: "2026-09-19T10:00:00Z" },
      { metrics: ["rw_cpu"], since: "2026-09-20T07:00:00Z" },
    ]);
    expect(rows.map((r) => [r.metric, r.at, r.value])).toEqual([
      ["cf_requests", "2026-09-18T10:00:00.000Z", 7],
      ["rw_cpu", "2026-09-20T09:00:00.000Z", 0.5],
      ["active_users_24h", "2026-09-20T10:00:00.000Z", 4],
    ]);
    // An unparseable bound drops ITS group only — never widens it to "everything".
    expect((await metricsSince(systemCtx(), [
      { metrics: ["cf_requests"], since: "2026-08-21T10:00:00Z" },
      { metrics: ["rw_cpu"], since: "not a date" },
    ])).map((r) => r.metric)).toEqual(["cf_requests"]);
  });

  it("metricsEver names which of the asked metrics have EVER landed, whatever their age or env", async () => {
    expect(await metricsEver(systemCtx(), ["cf_requests", "active_users_7d"])).toEqual(new Set());
    await putMetric(systemCtx(), { metric: "cf_requests", env: "staging", part: "frontend", value: 5, at: "2020-01-01T00:00:00Z" });
    expect(await metricsEver(systemCtx(), ["cf_requests", "active_users_7d"])).toEqual(new Set(["cf_requests"]));
    expect(await metricsEver(systemCtx(), [])).toEqual(new Set());
  });

  it("metricsEver answers a PREFIX family in the same statement — `sap_*` — and a lookalike is not in the family", async () => {
    expect(await metricsEver(systemCtx(), ["cf_requests"], ["sap_"])).toEqual(new Set());
    await putMetric(systemCtx(), { metric: "sapling", env: "", part: "", value: 1, at: "2020-01-01T00:00:00Z" });   // no underscore
    await putMetric(systemCtx(), { metric: "sap`x", env: "", part: "", value: 1, at: "2020-01-01T00:00:00Z" });     // just past the range
    await putMetric(systemCtx(), { metric: "rw_cpu", env: "", part: "", value: 1, at: "2020-01-01T00:00:00Z" });
    expect(await metricsEver(systemCtx(), ["cf_requests"], ["sap_"])).toEqual(new Set());
    await putMetric(systemCtx(), { metric: "sap_t_users", env: "production", part: "", value: 5, at: "2020-01-01T00:00:00Z" });
    expect(await metricsEver(systemCtx(), ["cf_requests", "rw_cpu"], ["sap_"])).toEqual(new Set(["rw_cpu", "sap_*"]));
    expect(await metricsEver(systemCtx(), [], ["sap_"])).toEqual(new Set(["sap_*"]));
    expect(await metricsEver(systemCtx(), [], [""])).toEqual(new Set());
  });

  describe("productReadings — the render's one read of sap_*", () => {
    const FRESH = "2026-09-20T09:05:00Z";
    const TREND = "2026-08-21T12:05:00Z";
    const seed = (rows: [string, string, string, number, string?][]) =>
      putMetrics(systemCtx(), rows.map(([metric, envKey, at, value, part]) => ({ metric, env: envKey, part: part ?? "", value, at })));

    it("returns the fresh readings of every sap_ metric, and only the midnight rows of the trend metrics before that", async () => {
      await seed([
        ["sap_c_signups_24h", "staging", "2026-09-20T12:00:00Z", 3],   // fresh
        ["sap_c_signups_7d", "staging", "2026-09-20T12:00:00Z", 21],   // fresh
        ["sap_c_signups_7d", "staging", "2026-09-20T09:00:00Z", 20],   // 5 minutes before the fresh bound → out
        ["sap_c_signups_24h", "staging", "2026-09-19T00:00:00Z", 5],   // a midnight → trend
        ["sap_c_signups_24h", "staging", "2026-09-19T01:00:00Z", 6],   // hourly, not fresh → out
        ["sap_c_signups_7d", "staging", "2026-09-19T00:00:00Z", 30],   // a midnight, but 7d draws no trend → out
        ["sap_t_users", "production", "2026-09-01T00:00:00Z", 1200],   // a total's midnight → trend
        ["sap_t_users", "production", "2026-08-21T00:00:00Z", 1100],   // before the trend bound → out
        ["sap_t_users", "elsewhere", "2026-09-20T12:00:00Z", 9],       // not a configured environment → out
        ["sap_t_users", "staging", "2026-09-20T12:00:00Z", 9, "backend"], // a part → nobody's product metric
        ["active_users_24h", "staging", "2026-09-20T12:00:00Z", 74],   // not sap_
        ["sapling", "staging", "2026-09-20T12:00:00Z", 1],
      ]);
      const rows = await productReadings(systemCtx(), ["staging", "production"], FRESH, TREND);
      expect(rows.map((r) => [r.metric, r.env, r.at, r.value])).toEqual([
        ["sap_t_users", "production", "2026-09-01T00:00:00.000Z", 1200],
        ["sap_c_signups_24h", "staging", "2026-09-19T00:00:00.000Z", 5],
        ["sap_c_signups_24h", "staging", "2026-09-20T12:00:00.000Z", 3],
        ["sap_c_signups_7d", "staging", "2026-09-20T12:00:00.000Z", 21],
      ].sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0)));
    });

    it("a midnight INSIDE the fresh window comes back once, not twice", async () => {
      await seed([["sap_c_signups_24h", "staging", "2026-09-20T00:00:00Z", 4]]);
      expect(await productReadings(systemCtx(), ["staging"], "2026-09-19T22:00:00Z", TREND)).toHaveLength(1);
    });

    it("no environment, no sap_ row, or an unparseable bound → []", async () => {
      expect(await productReadings(systemCtx(), ["staging"], FRESH, TREND)).toEqual([]);
      await seed([["sap_t_users", "staging", "2026-09-20T12:00:00Z", 9]]);
      expect(await productReadings(systemCtx(), [], FRESH, TREND)).toEqual([]);
      expect(await productReadings(systemCtx(), ["staging"], "not a date", TREND)).toEqual([]);
      expect(await productReadings(systemCtx(), ["staging"], FRESH, "not a date")).toEqual([]);
      // A trend bound at or after the fresh bound leaves no midnight to ask for: the fresh arm alone.
      expect(await productReadings(systemCtx(), ["staging"], FRESH, FRESH)).toHaveLength(1);
    });

    it("never scans the table: every access to repo_metrics is an index SEARCH", async () => {
      const spy: string[] = [];
      const db = new Proxy(env.DB, { get: (t, k) => (k === "prepare" ? (sql: string) => { spy.push(sql); return t.prepare(sql); } : Reflect.get(t, k).bind?.(t) ?? Reflect.get(t, k)) }) as typeof env.DB;
      await productReadings(systemCtx(ORG_A, "system", { ...env, DB: db } as unknown as Env), ["staging", "production"], FRESH, TREND);
      expect(spy).toHaveLength(1); // ONE statement
      const binds = spy[0].split("?").length - 1;
      expect(binds).toBeLessThan(100);
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${spy[0]}`).bind(...Array.from({ length: binds }, () => "x")).all<{ detail: string }>();
      const touching = plan.results.map((r) => r.detail).filter((d) => /repo_metrics|\br\b/.test(d));
      expect(touching.length).toBeGreaterThan(0);
      for (const d of touching) expect(d).toMatch(/^SEARCH .*USING (COVERING )?INDEX/);
    });
  });

  it("the same instant written in two formats is ONE row, and an unparseable `at` is skipped", async () => {
    const m = { metric: "health_up", env: "staging", part: "backend", value: 1 };
    await putMetric(systemCtx(), { ...m, at: "2026-09-20T10:00:00Z" });
    await putMetric(systemCtx(), { ...m, at: "2026-09-20T10:00:00.000Z" });
    await putMetric(systemCtx(), { ...m, at: "2026-09-20T12:00:00+02:00" }); // the same instant again
    await putMetric(systemCtx(), { ...m, at: "not a date" });
    expect(await all<{ at: string }>(env.DB, `SELECT at FROM repo_metrics`)).toEqual([{ at: "2026-09-20T10:00:00.000Z" }]);
  });

  it("prune drops old pings and check runs, keeps slow metrics and deploys", async () => {
    const now = Date.parse("2026-09-20T12:00:00Z");
    const old = "2026-07-01T00:00:00Z";
    await putMetric(systemCtx(), { metric: "health_ms", env: "staging", part: "backend", value: 1, at: old });
    await putMetric(systemCtx(), { metric: "coverage", env: "", part: "", value: 78.4, at: old });
    await ingestRepoEvent(systemCtx(), push({ semantic_key: "k1", kind: "check", occurred_at: old }));
    await ingestRepoEvent(systemCtx(), push({ semantic_key: "k2", kind: "deploy", occurred_at: old }));
    await pruneRepoCapture(platformCtx(), now);
    expect((await all<{ metric: string }>(env.DB, `SELECT metric FROM repo_metrics`)).map((r) => r.metric)).toEqual(["coverage"]);
    expect((await all<{ kind: string }>(env.DB, `SELECT kind FROM repo_events`)).map((r) => r.kind)).toEqual(["deploy"]);
  });

  // P2 (Task 13 parked finding): a FRONTEND DEPLOY is a `check` row carrying
  // `part = 'frontend'` (a Workers Builds check run), while backend deploys are
  // `deploy` rows kept forever. Pruning every old `check` row regardless of
  // `part` would age out the frontend dot strip asymmetrically — only a
  // `part IS NULL` (a plain CI check, not a deploy record) may be pruned.
  it("keeps an old frontend-deploy check row (part='frontend'), prunes a plain CI check (part=null)", async () => {
    const now = Date.parse("2026-09-20T12:00:00Z");
    const old = "2026-07-01T00:00:00Z";
    await ingestRepoEvent(systemCtx(), push({ semantic_key: "plain-ci", kind: "check", part: null, occurred_at: old }));
    await ingestRepoEvent(systemCtx(), push({ semantic_key: "frontend-deploy", kind: "check", env: "staging", part: "frontend", occurred_at: old }));
    await pruneRepoCapture(platformCtx(), now);
    const kept = await all<{ semantic_key: string }>(env.DB, `SELECT semantic_key FROM repo_events`);
    expect(kept.map((r) => r.semantic_key)).toEqual(["frontend-deploy"]);
  });

  // Task 16: hourly usage series (Cloudflare analytics, later Railway and the
  // active-user gauges) are read over 30 days at most — 100 days is ample, and
  // without a bound two environments add ~35,000 rows a year.
  it("prunes hourly usage metrics past 100 days, keeps younger ones and never touches a slow metric", async () => {
    const now = Date.parse("2026-09-20T12:00:00Z");
    const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();
    for (const metric of ["cf_requests", "cf_errors", "rw_cpu", "active_users_7d"]) {
      await putMetric(systemCtx(), { metric, env: "staging", part: "frontend", value: 1, at: daysAgo(101) });
      await putMetric(systemCtx(), { metric, env: "staging", part: "frontend", value: 2, at: daysAgo(99) });
    }
    await putMetric(systemCtx(), { metric: "coverage", env: "", part: "", value: 78.4, at: daysAgo(400) });
    // A metric that merely CONTAINS a usage prefix is not a usage metric.
    await putMetric(systemCtx(), { metric: "xcf_requests", env: "", part: "", value: 1, at: daysAgo(400) });
    // The 45-day rule is unchanged: a 60-day-old ping still goes, a 60-day-old usage point stays.
    await putMetric(systemCtx(), { metric: "health_up", env: "staging", part: "frontend", value: 1, at: daysAgo(60) });
    await putMetric(systemCtx(), { metric: "cf_requests", env: "staging", part: "frontend", value: 3, at: daysAgo(60) });
    await pruneRepoCapture(platformCtx(), now);
    const kept = await all<{ metric: string; value: number }>(env.DB, `SELECT metric, value FROM repo_metrics ORDER BY metric, at`);
    expect(kept).toEqual([
      { metric: "active_users_7d", value: 2 }, { metric: "cf_errors", value: 2 },
      { metric: "cf_requests", value: 2 }, { metric: "cf_requests", value: 3 },
      { metric: "coverage", value: 78.4 }, { metric: "rw_cpu", value: 2 }, { metric: "xcf_requests", value: 1 },
    ]);
  });
});
