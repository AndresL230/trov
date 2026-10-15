/**
 * The Usage tab's EXTRA families per part (repo setups, Phase G — src/tools/repo-extras.ts, through the providers
 * section of `getRepoDashboard`): outcomes, runtime, storage and schedules, read back from the `hx_*` points the
 * Cloudflare poll stores. D1 only; the real registry (Cloudflare declares the four families).
 *
 * Never guess: an hourly figure with no point is 0 only inside the covered interval of a family that was read; a
 * daily figure with no point is null; the day's quantiles and a database's size only while their day is current; a
 * family the provider could not read carries its reason; one never read is `none`.
 */
import { describe, it, expect } from "vitest";
import type { RepoProviderPart } from "@shared/hosting";
import { ENVS } from "./helpers/repo";
import { setOrgEnvironments } from "./helpers/org-config";
import { addPart, pollState } from "./helpers/dashboard-hosting";
import { ORG_A, systemCtx } from "./helpers/tenant";
import { getRepoDashboard } from "../src/tools/repo";
import { shapeRepoDashboard } from "../src/tools/repo-agent";
import { putMetrics } from "../src/repo/store";
import type { RepoEnvConfig } from "../src/repo/config";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-07T12:05:00Z"); // the last complete hour ends at 12:00; the last completed day is 10-06
const D1 = "6c71838c-18f7-4f68-8513-b58e86c237b9";
const BARE: RepoEnvConfig[] = [{ ...ENVS[0], key: "production", label: "Production" }];

const put = (metric: string, at: string, value: number, part = "trov") =>
  putMetrics(systemCtx(ORG_A), [{ metric, env: "production", part, at: new Date(at).toISOString(), value }]);

async function cfPart(): Promise<RepoProviderPart> {
  const s = (await getRepoDashboard(systemCtx(ORG_A), "o/r", NOW, BARE)).providers;
  if (s.status !== "ok") throw new Error(`providers is ${s.status}`);
  return s.data.find((p) => p.part === "trov")!;
}

async function setup(o: { covered?: [string, string]; unavailable?: unknown[]; settings?: Record<string, string> } = {}): Promise<void> {
  await setOrgEnvironments(BARE, ORG_A);
  await addPart(ORG_A, "production", "trov", "cloudflare", "web", o.settings ?? { worker: "trov", d1_database_ids: D1, crons: "*/10 * * * *;0 13 * * *" });
  await pollState(ORG_A, "production", "trov", "cloudflare", NOW, { covered: o.covered ?? ["2026-10-07T00:00:00.000Z", "2026-10-07T12:00:00.000Z"], unavailable: o.unavailable ?? [] });
  // Something on the part so the section is `ok` (a request point).
  await put("hx_requests", "2026-10-07T10:00:00Z", 1610);
}

describe("the providers section carries the part's families and extras", () => {
  it("a Cloudflare part reads every family; outcomes per range are the buckets that exist, by Cloudflare's own names, largest first", async () => {
    await setup();
    await put("hx_outcome_success", "2026-10-07T09:00:00Z", 1500);
    await put("hx_outcome_clientDisconnected", "2026-10-07T09:00:00Z", 21);
    await put("hx_outcome_success", "2026-10-07T10:00:00Z", 1610);
    await put("hx_outcome_scriptThrewException", "2026-10-02T10:00:00Z", 4);   // older than 24h, inside 7d
    await put("hx_outcome_success", "2026-10-07T12:00:00Z", 999);              // the running hour: never counted
    const p = await cfPart();
    expect(p.families).toEqual(["traffic", "outcomes", "runtime", "storage", "schedules"]);
    expect(p.extras?.outcomes?.state).toBe("ok");
    expect(p.extras?.outcomes?.ranges["24h"]).toEqual([
      { status: "success", label: "Success", tone: "good", count: 3110 },
      { status: "clientDisconnected", label: "Client disconnected", tone: "neutral", count: 21 },
    ]);
    expect(p.extras?.outcomes?.ranges["7d"]?.map((b) => [b.label, b.count])).toEqual([["Success", 3110], ["Client disconnected", 21], ["Script errors", 4]]);
    expect(p.extras?.outcomes?.since).toBe("2026-10-02T10:00:00.000Z");
    expect(JSON.stringify(p.extras)).not.toMatch(/4xx|5xx/);
  });

  it("an hourly range with no point reads 0 only inside a covered interval of a family that was read — else null", async () => {
    await setup({ covered: ["2026-10-07T06:00:00.000Z", "2026-10-07T12:00:00.000Z"] });
    await put("hx_outcome_success", "2026-10-07T09:00:00Z", 10);
    const p = await cfPart();
    // 24h: there is a point. The cron runs: none, but the window is covered and schedules were read → 0.
    expect(p.extras?.schedules?.crons.map((c) => [c.expr, c.runs["24h"], c.failed["24h"], c.last_run])).toEqual([
      ["*/10 * * * *", 0, 0, null], ["0 13 * * *", 0, 0, null],
    ]);
    // A stored reason for schedules: coverage proves nothing for it.
    await addPart(ORG_A, "production", "edge", "cloudflare", "web", { worker: "edge" }, 1);
    await pollState(ORG_A, "production", "edge", "cloudflare", NOW, { covered: ["2026-10-07T06:00:00.000Z", "2026-10-07T12:00:00.000Z"], unavailable: [{ family: "schedules", reason: "Cloudflare did not answer for cron runs: 403" }] });
    const s = (await getRepoDashboard(systemCtx(ORG_A), "o/r", NOW, BARE)).providers;
    const edge = s.status === "ok" ? s.data.find((x) => x.part === "edge") : undefined;
    expect(edge?.extras?.schedules).toMatchObject({ state: "unavailable", reason: "Cloudflare did not answer for cron runs: 403", crons: [] });
    expect(edge?.extras?.storage).toMatchObject({ state: "none", databases: [] });
    expect(edge?.extras?.outcomes?.ranges["24h"]).toBeNull();
  });

  it("schedules: runs and failures per range, the last run, a configured cron that never ran listed beside the ones that did", async () => {
    await setup();
    await put("hx_cron_runs:*/10_*_*_*_*", "2026-10-07T09:00:00Z", 6);
    await put("hx_cron_failed:*/10_*_*_*_*", "2026-10-07T09:00:00Z", 1);
    await put("hx_cron_last:*/10_*_*_*_*", "2026-10-07T09:00:00Z", Date.parse("2026-10-07T09:50:01Z"));
    await put("hx_cron_runs:*/10_*_*_*_*", "2026-10-03T09:00:00Z", 6);
    await put("hx_cron_failed:*/10_*_*_*_*", "2026-10-03T09:00:00Z", 0);
    await put("hx_cron_last:*/10_*_*_*_*", "2026-10-03T09:00:00Z", Date.parse("2026-10-03T09:50:00Z"));
    await put("hx_cron_runs:0_*_*_*_SUN,MON", "2026-10-05T11:00:00Z", 1);
    await put("hx_cron_failed:0_*_*_*_SUN,MON", "2026-10-05T11:00:00Z", 0);
    await put("hx_cron_last:0_*_*_*_SUN,MON", "2026-10-05T11:00:00Z", Date.parse("2026-10-05T11:00:00Z"));
    const p = await cfPart();
    const crons = p.extras?.schedules?.crons ?? [];
    expect(crons.map((c) => [c.expr, c.runs["24h"], c.runs["7d"], c.failed["24h"], c.failed["7d"], c.last_run])).toEqual([
      ["*/10 * * * *", 6, 12, 1, 1, "2026-10-07T09:50:01.000Z"],
      ["0 * * * SUN,MON", 0, 1, 0, 0, "2026-10-05T11:00:00.000Z"],
      ["0 13 * * *", 0, 0, 0, 0, null],
    ]);
    expect(p.extras?.schedules?.state).toBe("ok");
  });

  it("runtime: the newest completed day's quantiles in ms while current, the CPU p99 line per day, subrequests per range", async () => {
    await setup();
    await put("hx_cpu_time_p50_us", "2026-10-06T00:00:00Z", 2257);
    await put("hx_cpu_time_p99_us", "2026-10-06T00:00:00Z", 55106);
    await put("hx_wall_time_p50_us", "2026-10-06T00:00:00Z", 23491);
    await put("hx_cpu_time_p99_us", "2026-10-04T00:00:00Z", 16400);
    await put("hx_subrequests", "2026-10-07T09:00:00Z", 917);
    await put("hx_subrequests", "2026-10-07T10:00:00Z", 1022);
    const r = (await cfPart()).extras?.runtime;
    expect(r).toMatchObject({ state: "ok", day: "2026-10-06", cpu_p50_ms: 2.26, cpu_p99_ms: 55.11, wall_p50_ms: 23.49 });
    expect(r?.subrequests).toEqual({ "24h": 1939, "7d": 1939, "30d": 1939 });
    expect(r?.trend).toEqual([{ at: "2026-10-04T00:00:00.000Z", cpu_p99_ms: 16.4 }, { at: "2026-10-06T00:00:00.000Z", cpu_p99_ms: 55.11 }]);
  });

  it("a quantile day older than two days is not current: no figure, the family stale — never the old number as today's", async () => {
    await setup();
    await put("hx_cpu_time_p99_us", "2026-10-03T00:00:00Z", 16400);
    const r = (await cfPart()).extras?.runtime;
    expect(r).toMatchObject({ state: "stale", day: null, cpu_p50_ms: null, cpu_p99_ms: null, wall_p50_ms: null });
  });

  it("storage: per database, the daily sums of the range's completed days, the size while current — null where no day was read", async () => {
    await setup();
    await put(`hx_d1_read_queries:${D1}`, "2026-10-06T00:00:00Z", 9672);
    await put(`hx_d1_read_queries:${D1}`, "2026-10-02T00:00:00Z", 8000);
    await put(`hx_d1_write_queries:${D1}`, "2026-10-06T00:00:00Z", 3093);
    await put(`hx_d1_size_bytes:${D1}`, "2026-10-06T00:00:00Z", 27545600);
    const s = (await cfPart()).extras?.storage;
    expect(s?.state).toBe("ok");
    expect(s?.databases).toEqual([{
      id: D1,
      read_queries: { "24h": 9672, "7d": 17672, "30d": 17672 }, write_queries: { "24h": 3093, "7d": 3093, "30d": 3093 },
      rows_read: { "24h": null, "7d": null, "30d": null }, rows_written: { "24h": null, "7d": null, "30d": null },
      size_bytes: 27545600, size_day: "2026-10-06",
      trend: [{ at: "2026-10-02T00:00:00.000Z", reads: 8000 }, { at: "2026-10-06T00:00:00.000Z", reads: 9672 }],
    }]);
  });

  it("a part with no D1 id: storage is unavailable with the poll's own reason", async () => {
    await setup({ settings: { worker: "trov" }, unavailable: [{ metric: "latency_p50_ms", reason: "not read" }, { family: "storage", reason: "no D1 database is named for this part" }] });
    const p = await cfPart();
    expect(p.extras?.storage).toEqual({ state: "unavailable", reason: "no D1 database is named for this part", databases: [] });
    // The metric entries beside it are untouched: `unavailable` still lists the metric, and only the metric.
    expect(p.unavailable).toEqual([{ metric: "latency_p50_ms", reason: "not read" }]);
  });

  it("a provider that declares no extra family carries no extras (and the extra read is not made for it alone)", async () => {
    await setOrgEnvironments(BARE, ORG_A);
    await addPart(ORG_A, "production", "api", "render", "service", { service_id: "srv-abc" });
    await pollState(ORG_A, "production", "api", "render", NOW, { covered: ["2026-10-07T00:00:00.000Z", "2026-10-07T12:00:00.000Z"] });
    await putMetrics(systemCtx(ORG_A), [{ metric: "hx_cpu", env: "production", part: "api", at: "2026-10-07T11:00:00.000Z", value: 0.4 }]);
    const s = (await getRepoDashboard(systemCtx(ORG_A), "o/r", NOW, BARE)).providers;
    const api = s.status === "ok" ? s.data.find((x) => x.part === "api") : undefined;
    expect(api?.families).toEqual(["traffic", "latency", "compute"]);
    expect(api && "extras" in api).toBe(false);
  });

  it("MCP collapses every per-range record of the extras to the asked range", async () => {
    await setup();
    await put("hx_outcome_success", "2026-10-07T09:00:00Z", 10);
    await put("hx_cron_runs:*/10_*_*_*_*", "2026-10-07T09:00:00Z", 6);
    await put("hx_cron_failed:*/10_*_*_*_*", "2026-10-07T09:00:00Z", 0);
    const dash = await getRepoDashboard(systemCtx(ORG_A), "o/r", NOW, BARE);
    const view = shapeRepoDashboard(dash, { tab: "usage", range: "24h", includeTrends: false }) as unknown as { sections: { providers: { data: { extras: Record<string, Record<string, unknown>> }[] } } };
    const x = view.sections.providers.data[0].extras;
    expect(x.outcomes.buckets).toEqual([{ status: "success", label: "Success", tone: "good", count: 10 }]);
    expect(x.outcomes.ranges).toBeUndefined();
    expect((x.schedules.crons as { runs: unknown }[])[0].runs).toBe(6);
    expect(x.runtime && "trend" in x.runtime).toBe(false);
  });
});
