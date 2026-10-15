/**
 * The hosting poll framework's EXTRA usage families (repo setups, Phase G — shared/usage-families-core.ts): what a
 * provider that declares outcomes / runtime / storage / schedules may store, the families' state in
 * `hosting_poll_state.unavailable`, and THE ONCE-A-DAY RULE — a provider with a daily family is handed the completed
 * UTC day to read only until that day's `hx_daily_read` marker is stored. Fake providers, real Miniflare D1.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { all, first } from "./helpers/db";
import { LONG_TOKEN, ENVS } from "./helpers/repo";
import { setOrgEnvironments } from "./helpers/org-config";
import { ORG_A, systemCtx, tenantCtx } from "./helpers/tenant";
import { setIntegrationConfig, setSecret } from "../src/data/secrets";
import { listAllParts } from "../src/hosting/parts";
import { dailyDay, mergeFamilies, pollPart, validatePoll, type ProviderMap } from "../src/hosting/poll";
import type { HostingProvider, PollResult, ProviderContext } from "../src/hosting/types";
import type { ExtraFamily } from "@shared/usage-families-core";

const e = env as unknown as Env;
const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-07T12:40:00Z");
const ALL: ExtraFamily[] = ["outcomes", "runtime", "storage", "schedules"];

function fake(poll: (pc: ProviderContext) => Promise<Partial<PollResult>>, families: ExtraFamily[] = ALL): HostingProvider {
  return {
    id: "cloudflare", label: "Cloudflare Workers", status: "available", summary: "", roles: ["web"], apiHosts: ["api.cloudflare.test"], docsUrl: "",
    connectionMethods: [], orgConfigFields: [], partSettings: [{ key: "worker", label: "Worker name", description: "", required: true, pattern: /^[a-z-]+$/ }],
    capabilities: { deploys: true, metrics: ["requests", "errors"], families }, planNote: null, pollCost: 6,
    consoleUrl: () => null, probe: async () => ({ ok: true, detail: "" }),
    poll: async (pc) => ({ deploys: [], points: [], unavailable: [], covered: null, ...(await poll(pc)) }),
  };
}

async function setup(): Promise<void> {
  await setOrgEnvironments(ENVS, ORG_A);
  await env.DB.prepare(
    `INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
     VALUES (?, 'production', 'web', 0, 'web', 'web', 'cloudflare', '{"worker":"trov"}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'test')`,
  ).bind(ORG_A).run();
  const admin = await tenantCtx("AndresL230");
  await setSecret(admin, "cloudflare_analytics", "", LONG_TOKEN);
  await setIntegrationConfig(admin, "cloudflare_analytics", "", { account_id: "0123456789abcdef0123456789abcdef" });
}
const run = async (provider: HostingProvider, now = NOW) => {
  const [part] = await listAllParts(systemCtx(ORG_A));
  return pollPart(e, systemCtx(ORG_A), part, now, (async () => Response.json({})) as typeof fetch, { cloudflare: provider } as ProviderMap);
};
const rows = (glob: string) => all<{ metric: string; at: string; value: number }>(env.DB,
  `SELECT metric, at, value FROM repo_metrics WHERE org_id = ? AND metric GLOB ? ORDER BY metric, at`, ORG_A, glob);
const stateJson = async () => JSON.parse((await first<{ unavailable: string }>(env.DB,
  `SELECT unavailable FROM hosting_poll_state WHERE org_id = ? AND env = 'production' AND part = 'web'`, ORG_A))?.unavailable ?? "[]") as unknown[];

const web = { env: "production", key: "web", role: "web" as const };

describe("validatePoll — extra family points", () => {
  it("keeps a declared family's points at their grain; drops an undeclared family, a wrong role, a running hour, an unfinished day, a bad name", () => {
    const r = validatePoll({
      extraPoints: [
        { metric: "hx_outcome_success", at: "2026-10-07T10:00:00.000Z", value: 1500 },
        { metric: "hx_outcome_success", at: "2026-10-07T10:00:00.000Z", value: 99 },          // the same instant: the first wins
        { metric: "hx_outcome_success", at: "2026-10-07T12:00:00.000Z", value: 5 },           // the running hour
        { metric: "hx_outcome_4xx!", at: "2026-10-07T10:00:00.000Z", value: 5 },              // not a status
        { metric: "hx_cpu_time_p99_us", at: "2026-10-06T00:00:00.000Z", value: 55106 },
        { metric: "hx_cpu_time_p99_us", at: "2026-10-07T00:00:00.000Z", value: 1 },           // today is not over
        { metric: "hx_cpu_time_p99_us", at: "2026-10-06T01:00:00.000Z", value: 1 },           // a daily point off midnight
        { metric: "hx_cron_last:*/10_*_*_*_*", at: "2026-10-07T09:00:00.000Z", value: Date.parse("2026-10-07T09:50:01Z") },
        { metric: "hx_cron_last:0_*_*_*_*", at: "2026-10-07T09:00:00.000Z", value: Date.parse("2026-10-07T11:00:00Z") }, // outside its hour
        { metric: "hx_cron_runs:rm_-rf", at: "2026-10-07T09:00:00.000Z", value: 1 },          // not a cron
        { metric: "hx_d1_rows_read:not-a-uuid", at: "2026-10-06T00:00:00.000Z", value: 1 },
        { metric: "hx_requests", at: "2026-10-07T09:00:00.000Z", value: 1 },                  // a core metric is not an extra point
        { metric: "hx_subrequests", at: "2026-10-07T09:00:00.000Z", value: -1 },
        { metric: "hx_subrequests", at: "2026-10-07T09:00:00.000Z", value: Number.NaN },
        "junk", null,
      ],
      families: [{ family: "outcomes", reason: null }, { family: "storage", reason: "no D1 database" }, { family: "storage", reason: "twice" }, { family: "latency", reason: "x" }],
    }, web, NOW, null, ALL);
    expect(r.extra.map((p) => [p.metric, p.at, p.value])).toEqual([
      ["hx_outcome_success", "2026-10-07T10:00:00.000Z", 1500],
      ["hx_cpu_time_p99_us", "2026-10-06T00:00:00.000Z", 55106],
      ["hx_cron_last:*/10_*_*_*_*", "2026-10-07T09:00:00.000Z", Date.parse("2026-10-07T09:50:01Z")],
    ]);
    expect(r.extra.every((p) => p.env === "production" && p.part === "web")).toBe(true);
    expect(r.dropped.points).toBe(13);
    expect(r.families).toEqual([{ family: "outcomes", reason: null }, { family: "storage", reason: "no D1 database" }]);
  });

  it("a provider that declares no family stores none of them; a service part stores no web family", () => {
    const pts = { extraPoints: [{ metric: "hx_outcome_success", at: "2026-10-07T10:00:00.000Z", value: 1 }], families: [{ family: "outcomes", reason: null }] };
    expect(validatePoll(pts, web, NOW, null, []).extra).toEqual([]);
    expect(validatePoll(pts, web, NOW, null, ["storage"]).extra).toEqual([]);
    expect(validatePoll(pts, { ...web, role: "service" }, NOW, null, ALL).extra).toEqual([]);
    expect(validatePoll(pts, { ...web, role: "service" }, NOW, null, ALL).families).toEqual([]);
  });
});

describe("the families' state", () => {
  it("mergeFamilies keeps a family not attempted, replaces an attempted one, drops one read cleanly — beside the metric entries, never touching them", () => {
    const prev = JSON.stringify([{ metric: "latency_p95_ms", reason: "not read" }, { family: "storage", reason: "old" }, { family: "runtime", reason: "refused" }, { family: "bogus", reason: "x" }]);
    expect(mergeFamilies(prev, [{ family: "runtime", reason: null }, { family: "schedules", reason: "refused" }])).toEqual([
      { family: "storage", reason: "old" }, { family: "schedules", reason: "refused" },
    ]);
    expect(mergeFamilies("not json", [])).toEqual([]);
  });

  it("a poll stores the extra points and the families' reasons; a daily family's reason outlives the hourly polls that do not attempt it", async () => {
    await setup();
    let n = 0;
    const provider = fake(async () => {
      n++;
      return {
        covered: { from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T12:00:00.000Z" },
        extraPoints: [{ metric: "hx_outcome_clientDisconnected", at: "2026-10-07T09:00:00.000Z", value: 21 }],
        families: n === 1 ? [{ family: "outcomes", reason: null }, { family: "runtime", reason: "refused" }] : [{ family: "outcomes", reason: null }],
      };
    });
    const out = await run(provider);
    expect(out.status).toBe("ok");
    expect(await rows("hx_outcome_*")).toEqual([{ metric: "hx_outcome_clientDisconnected", at: "2026-10-07T09:00:00.000Z", value: 21 }]);
    expect(await stateJson()).toEqual([{ family: "runtime", reason: "refused" }]);
    await run(provider, NOW + HOUR);
    expect(await stateJson()).toEqual([{ family: "runtime", reason: "refused" }]);
  });
});

describe("the once-a-day rule", () => {
  it("dailyDay: the newest UTC day that ended at least 15 minutes ago", () => {
    expect(dailyDay(Date.parse("2026-10-07T00:40:00Z"))).toBe("2026-10-06");
    expect(dailyDay(Date.parse("2026-10-07T23:59:00Z"))).toBe("2026-10-06");
    expect(dailyDay(Date.parse("2026-10-07T00:10:00Z"))).toBe("2026-10-05");
  });

  it("the provider is handed the day until its marker lands — then not again that day; the next day is asked once more", async () => {
    await setup();
    const asked: (string | null | undefined)[] = [];
    const provider = fake(async (pc) => {
      asked.push(pc.daily);
      return pc.daily
        ? { extraPoints: [{ metric: "hx_daily_read", at: `${pc.daily}T00:00:00.000Z`, value: 1 }, { metric: "hx_cpu_time_p99_us", at: `${pc.daily}T00:00:00.000Z`, value: 55106 }], families: [{ family: "runtime", reason: null }] }
        : {};
    });
    await run(provider, NOW);
    await run(provider, NOW + HOUR);
    await run(provider, NOW + 2 * HOUR);
    await run(provider, NOW + 24 * HOUR);
    expect(asked).toEqual(["2026-10-06", null, null, "2026-10-07"]);
    expect((await rows("hx_daily_read")).map((r) => r.at)).toEqual(["2026-10-06T00:00:00.000Z", "2026-10-07T00:00:00.000Z"]);
  });

  it("a failed daily read stores no marker, so the next poll asks for the day again", async () => {
    await setup();
    const asked: (string | null | undefined)[] = [];
    const provider = fake(async (pc) => { asked.push(pc.daily); return { families: [{ family: "runtime", reason: "refused" }] }; });
    await run(provider, NOW);
    await run(provider, NOW + HOUR);
    expect(asked).toEqual(["2026-10-06", "2026-10-06"]);
  });

  it("a provider with no daily family is never handed a day", async () => {
    await setup();
    const asked: (string | null | undefined)[] = [];
    await run(fake(async (pc) => { asked.push(pc.daily); return {}; }, ["outcomes", "schedules"]), NOW);
    expect(asked).toEqual([null]);
  });
});
