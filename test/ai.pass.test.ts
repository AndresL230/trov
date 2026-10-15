// The AI pass (src/ai/pass.ts, docs/architecture/ai.md): the machinery every AI job runs in. Its registry is EMPTY
// in production — so the first suite proves it does nothing at all — and the rest register STAND-IN jobs
// (test/helpers/ai-pass.ts) over real `ai_dirty` rows to drive the guards: the switch, the keys, the allowances,
// the per-tick caps, the cron budget, the rotation cursor and metering. Both providers are stubs answering real
// response bodies; the assertions are on meter rows, `ai_dirty` and the cursor.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { AI_JOBS, AI_PASS_ACTOR, AI_PASS_JOB, AI_RUNS_PER_TICK, runAiPass, type AiJob } from "../src/ai/pass";
import { aiEligibility } from "../src/ai/eligibility";
import { newBudget } from "../src/repo/dispatch";
import { handleRepoCron } from "../src/repo/cron";
import { PLANS } from "@shared/plans";
import { AiUsageSchema } from "@shared/ai";
import { platformUsage } from "../src/platform/usage";
import { all, first, run } from "./helpers/db";
import { ORG_A, ORG_B, platformCtx, systemCtx } from "./helpers/tenant";
import { setOrgEnvironments } from "./helpers/org-config";
import { ENVS } from "./helpers/repo";
import { answerEveryKey, claudeJob, dirtyRow, jevCardJob, keyedEnv, markRow, stubProviders, type Stub } from "./helpers/ai-pass";

const NOW = new Date("2026-10-14T12:40:00.000Z"); // a :40 tick: no heavy job (no hosting part is stored)
const DAY = "2026-10-14";
const BEFORE = "2026-10-14T12:00:00.000Z";
const KIND = "summary_pr" as const; // the stand-in Haiku job borrows an existing kind: Phase B adds no real kind

/** `n` stale cards `x:1…x:n` for the org (debounce: next tick). */
async function cards(orgId: string, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) await markRow(orgId, "card", `x:${i}`, BEFORE);
}
const job = () => claudeJob("card", { keyPrefix: "x:" });
const stub = (o: { ok?: boolean } = {}): Stub => stubProviders({ claude: o.ok === false ? () => ({ status: 500 }) : answerEveryKey });

const metric = async (name: string, orgId: string = ORG_A): Promise<number> =>
  (await first<{ n: number }>(env.DB, `SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE org_id = ? AND metric = ?`, orgId, name))!.n;
const aiRows = () => all<{ org_id: string; metric: string; actor: string; count: number }>(env.DB,
  `SELECT org_id, metric, actor, count FROM org_usage_daily WHERE metric GLOB 'ai_*' ORDER BY org_id, metric`);
const setPlan = (plan: string, orgId: string = ORG_A) => run(env.DB, `UPDATE orgs SET plan = ?, plan_overrides = '{}', plan_status = 'active' WHERE id = ?`, plan, orgId);
const seedRuns = (n: number, orgId: string = ORG_A, metricName = "ai_run:seed") =>
  run(env.DB, `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, ?, ?, 'seed', ?, ?)
               ON CONFLICT(org_id, day, metric, actor) DO UPDATE SET count = count + excluded.count`, orgId, DAY, metricName, n, `${DAY}T01:00:00.000Z`);
const switchOff = (orgId: string = ORG_A) => run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, orgId);
/** The pass's `cron_cursor` row (the reset blanks every row to '' and keeps it). */
const cursor = async () => (await first<{ last_key: string }>(env.DB, `SELECT last_key FROM cron_cursor WHERE job = ?`, AI_PASS_JOB))?.last_key ?? "";
/** The rotation's order is the org id's: `org_b` (ORG_B), then `org_saplinglearn` (ORG_A), then these. */
const SEED_ORDER = [ORG_B, ORG_A];
/** `n` more active orgs, ids `org_z1`…, sorted after the two seed orgs. */
async function moreOrgs(n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, (_, i) => `org_z${i + 1}`);
  for (const id of ids) await run(env.DB, `INSERT INTO orgs (id, slug, name, created_at, created_by) VALUES (?, ?, ?, ?, 'test')`, id, id.replace("_", "-"), id, DAY);
  return ids;
}
const pass = (s: Stub, jobs: readonly AiJob[], limit = 900, e: Env = keyedEnv()) =>
  runAiPass(e, newBudget(s.fetchImpl, limit), { jobs, now: NOW });

describe("the real registry, with nothing it takes", () => {
  it("AI_JOBS holds the producers; over scopes none of them takes it makes zero calls and writes nothing — with both keys and stale scopes", async () => {
    expect(AI_JOBS.map((j) => j.name)).toEqual(["tag.fit:new-item", "feed.importance:feed", "feed.importance:pr", "pr.theme", "themes.propose", "themes.caption", "themes.backfill"]);
    await cards(ORG_A, 3);
    const s = stub();
    expect(await runAiPass(keyedEnv(), newBudget(s.fetchImpl), { now: NOW })).toMatchObject({ calls: 0, haiku: 0, jev: 0, batched: 0, collected: 0, deferred: 0 });
    expect(s.haiku + s.jev + s.other).toBe(0);
    expect(await aiRows()).toEqual([]);
    expect(await cursor()).toBe(""); // every org finished: nothing to resume
    expect((await dirtyRow(ORG_A, "card", "x:1"))!.last_run_at).toBeNull();
  });

  it("the */10 tick runs it after the health pings and it still does nothing", async () => {
    await setOrgEnvironments([ENVS[0]]);
    const s = stub();
    await handleRepoCron(keyedEnv(), NOW.getTime(), s.fetchImpl);
    expect(s.other).toBe(2); // the environment's two health pings
    expect(s.haiku + s.jev).toBe(0);
    expect(await aiRows()).toEqual([]);
  });
});

describe("with a job registered", () => {
  it("an ok org: the attempt is metered BEFORE the call, then the tokens; the scope is cleared", async () => {
    await cards(ORG_A, 1);
    const s = stub();
    const seen: number[] = [];
    const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://api.anthropic.com/")) seen.push((await first<{ n: number }>(env.DB, `SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE metric GLOB 'ai_run:*'`))!.n);
      return s.fetchImpl(input, init);
    }) as typeof fetch;
    const j = job();
    expect(await runAiPass(keyedEnv(), newBudget(counting), { jobs: [j], now: NOW })).toMatchObject({ calls: 1, haiku: 1, deferred: 0 });
    expect(seen).toEqual([1]); // the stub read the `ai_run:` row while the call was in flight
    expect(j.wrote).toEqual(["x:1"]);
    expect(await aiRows()).toEqual([
      { org_id: ORG_A, metric: `ai_run:${KIND}`, actor: AI_PASS_ACTOR, count: 1 },
      { org_id: ORG_A, metric: "ai_tokens_cached", actor: AI_PASS_ACTOR, count: 40 },
      { org_id: ORG_A, metric: "ai_tokens_in", actor: AI_PASS_ACTOR, count: 100 },
      { org_id: ORG_A, metric: "ai_tokens_out", actor: AI_PASS_ACTOR, count: 7 },
    ]);
    expect(await dirtyRow(ORG_A, "card", "x:1")).toBeNull(); // a written card is gone
  });

  it("a call that answers nothing is `ai_run_failed`, still one run, and the scope's attempt is counted", async () => {
    await cards(ORG_A, 1);
    await pass(stub({ ok: false }), [job()]);
    expect(await metric(`ai_run:${KIND}`)).toBe(1);
    expect(await metric(`ai_run_failed:${KIND}`)).toBe(1);
    expect(await dirtyRow(ORG_A, "card", "x:1")).toMatchObject({ attempts: 1, last_error: "no_answer" });
  });

  it("a Free org at 250 makes no call and counts one `ai_run_capped`; a Pro org at 250 runs", async () => {
    expect([PLANS.free.entitlements.ai_runs, PLANS.personal.entitlements.ai_runs, PLANS.team.entitlements.ai_runs, PLANS.enterprise.entitlements.ai_runs]).toEqual([250, 250, 2000, null]);
    await setPlan("free", ORG_A);
    await seedRuns(250, ORG_A);
    await setPlan("team", ORG_B);
    await seedRuns(250, ORG_B);
    await cards(ORG_A, 3);
    await cards(ORG_B, 3);
    const s = stub();
    await pass(s, [job()]);
    expect(await metric(`ai_run:${KIND}`, ORG_A)).toBe(0);
    expect(await metric(`ai_run_capped:${KIND}`, ORG_A)).toBe(1); // one per job that had work, not per unit
    expect(await metric(`ai_run:${KIND}`, ORG_B)).toBe(3);
    expect(await metric(`ai_run_capped:${KIND}`, ORG_B)).toBe(0);
    expect(s.haiku).toBe(3);
    expect((await dirtyRow(ORG_A, "card", "x:1"))!.attempts).toBe(0); // capped is not a failure: the scope waits
  });

  it("the allowance left at the org's start is never overspent within the tick", async () => {
    await setPlan("free", ORG_A);
    await seedRuns(248, ORG_A);
    await cards(ORG_A, 5);
    const s = stub();
    await pass(s, [job()]);
    expect(await metric(`ai_run:${KIND}`)).toBe(2);
    expect(await metric(`ai_run_capped:${KIND}`)).toBe(1);
    expect(s.haiku).toBe(2);
  });

  it("Jev requests are held to `jev_checks` (metric `ai_suggest`), not `ai_runs`", async () => {
    await setPlan("free", ORG_A);
    await seedRuns(PLANS.free.entitlements.jev_checks! - 1, ORG_A, "ai_suggest");
    for (let i = 1; i <= 3; i++) await markRow(ORG_A, "card", `ticket:${i}`, BEFORE);
    const s = stub();
    const j = jevCardJob();
    await pass(s, [j]);
    expect(s.jev).toBe(1);
    expect(await metric("ai_suggest")).toBe(PLANS.free.entitlements.jev_checks!); // the seed + this one
    expect(await metric("ai_run_capped:tag.fit")).toBe(1);
    expect(await metric("ai_run:tag.fit")).toBe(0); // a Jev request is never an `ai_runs`
    expect(await metric("ai_jev_tokens_in")).toBe(50);
  });

  it("an ended plan is capped too", async () => {
    await run(env.DB, `UPDATE orgs SET plan = 'team', plan_status = 'canceled' WHERE id = ?`, ORG_A);
    await cards(ORG_A, 1);
    const s = stub();
    await pass(s, [job()]);
    expect(s.haiku).toBe(0);
    expect(await metric(`ai_run_capped:${KIND}`)).toBe(1);
  });

  it("THE SWITCH off: no call, nothing counted, the scopes untouched", async () => {
    await switchOff(ORG_A);
    await switchOff(ORG_B);
    await cards(ORG_A, 2);
    const s = stub();
    const j = job();
    await pass(s, [j, jevCardJob("x:")]);
    expect(s.haiku + s.jev).toBe(0);
    expect(j.wrote).toEqual([]);
    expect(await aiRows()).toEqual([]);
    expect(await dirtyRow(ORG_A, "card", "x:1")).toMatchObject({ attempts: 0, last_run_at: null });
  });

  it("no key: no call, nothing read or counted — a Jev job needs TypeSafe's key, a Haiku job Anthropic's", async () => {
    await cards(ORG_A, 2);
    const s = stub();
    let asked = 0;
    const j = job();
    const spy: AiJob = { ...j, input: async (c, sc) => { asked++; return j.input(c, sc); } };
    const bare = env as unknown as Env;
    expect(await runAiPass(bare, newBudget(s.fetchImpl), { jobs: [spy, jevCardJob("x:")], now: NOW })).toEqual({ calls: 0, haiku: 0, jev: 0, batched: 0, collected: 0, served: [], deferred: 0 });
    // Only Anthropic's key: the Jev job is not run at all.
    await runAiPass(keyedEnv({ TYPESAFE_API_KEY: undefined }), newBudget(s.fetchImpl), { jobs: [jevCardJob("x:")], now: NOW });
    expect(s.haiku + s.jev).toBe(0);
    expect(asked).toBe(0);
    expect(await aiRows()).toEqual([]);
  });

  it(`THE CAP: AI_RUNS_PER_TICK (${AI_RUNS_PER_TICK}) Haiku calls across orgs, and the next tick resumes where it stopped`, async () => {
    const extra = await moreOrgs(3); // five orgs, five cards each
    for (const o of [...SEED_ORDER, ...extra]) await cards(o, 5);
    const s = stub();
    const first1 = await pass(s, [job()]);
    expect(s.haiku).toBe(AI_RUNS_PER_TICK);
    expect(first1.haiku).toBe(AI_RUNS_PER_TICK);
    // 12 = the first org's 5 + the second's 5 + two of the third's: two finished, the third goes first next tick.
    expect(first1.served).toEqual(SEED_ORDER);
    expect(await cursor()).toBe(SEED_ORDER[1]);
    const s2 = stub();
    const j2 = job();
    await pass(s2, [j2]);
    expect(s2.haiku).toBe(AI_RUNS_PER_TICK);
    // The third org's three left, then the fourth's five, the fifth's five — 13: the cap stops it one short.
    expect(await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ai_dirty WHERE org_id = ?`, extra[0])).toEqual({ n: 0 });
  });

  it("a budget with room for N calls makes N, and the cursor resumes at the next org on the following tick", async () => {
    const extra = await moreOrgs(3);
    const order = [...SEED_ORDER, ...extra];
    for (const o of order) await cards(o, 1);
    const s = stub();
    const r = await pass(s, [job()], 3);
    expect(s.haiku).toBe(3);
    expect(r).toMatchObject({ calls: 3, served: order.slice(0, 3), deferred: 2 });
    expect(await cursor()).toBe(order[2]);
    const s2 = stub();
    const r2 = await pass(s2, [job()], 3);
    // The two left first; the three written last tick have nothing due and cost nothing — every org is served.
    expect(r2.served).toEqual([order[3], order[4], order[0], order[1], order[2]]);
    expect(s2.haiku).toBe(2);
    expect(await cursor()).toBe("");
  });

  it("a budget already spent makes no call and leaves the cursor where it was", async () => {
    await run(env.DB, `INSERT INTO cron_cursor (job, last_key, updated_at) VALUES (?, ?, ?) ON CONFLICT(job) DO UPDATE SET last_key = excluded.last_key`, AI_PASS_JOB, ORG_B, DAY);
    await cards(ORG_A, 1);
    const s = stub();
    const budget = newBudget(s.fetchImpl, 5);
    budget.spent = 5;
    expect(await runAiPass(keyedEnv(), budget, { jobs: [job()], now: NOW })).toMatchObject({ calls: 0, served: [] });
    expect(s.haiku).toBe(0);
    expect(await cursor()).toBe(ORG_B);
  });

  it("in the tick it shares the cron's budget with the health pings, and a heavy tick does not run it", async () => {
    await setOrgEnvironments([ENVS[0]]);
    await cards(ORG_A, 5);
    const s = stub();
    await handleRepoCron(keyedEnv(), NOW.getTime(), s.fetchImpl, 4, { jobs: [job()] });
    expect(s.other).toBe(2); // health first
    expect(s.haiku).toBe(2); // the pass gets what is left: 4 - 2
    const heavy = stub();
    await handleRepoCron(keyedEnv(), Date.parse("2026-10-14T13:00:00.000Z"), heavy.fetchImpl, 900, { jobs: [job()] });
    expect(heavy.haiku).toBe(0); // :00 is the usage polls' alone
  });

  it("a job that throws fails its scope, and the loop moves on to the next org", async () => {
    await cards(ORG_A, 1);
    await cards(ORG_B, 1);
    const s = stub();
    const j = job();
    const bad: AiJob = { ...j, input: async (ctx, sc) => { if (ctx.orgId === ORG_A) throw new Error("boom"); return j.input(ctx, sc); } };
    const r = await pass(s, [bad]);
    expect(r.served).toEqual(SEED_ORDER);
    expect(await dirtyRow(ORG_A, "card", "x:1")).toMatchObject({ attempts: 1, last_error: "input" });
    expect(await dirtyRow(ORG_B, "card", "x:1")).toBeNull();
  });
});

describe("aiEligibility", () => {
  it("ok / off / no_key / capped — and an org that is not there reads as off", async () => {
    const ctx = systemCtx(ORG_A);
    expect(await aiEligibility(ctx, keyedEnv(), NOW)).toBe("ok");
    expect(await aiEligibility(ctx, env as unknown as Env, NOW)).toBe("no_key");
    await setPlan("free");
    await seedRuns(249);
    expect(await aiEligibility(ctx, keyedEnv(), NOW)).toBe("ok");
    await seedRuns(1);
    expect(await aiEligibility(ctx, keyedEnv(), NOW)).toBe("capped");
    // Last month's runs do not count.
    expect(await aiEligibility(ctx, keyedEnv(), new Date("2026-11-01T00:00:00.000Z"))).toBe("ok");
    await switchOff();
    expect(await aiEligibility(ctx, keyedEnv(), NOW)).toBe("off");
    expect(await aiEligibility(ctx, env as unknown as Env, NOW)).toBe("no_key");
    expect(await aiEligibility(systemCtx("org_missing"), keyedEnv(), NOW)).toBe("off");
    // Only `ai_run:*` counts toward the allowance: failures, caps and tokens do not.
    await run(env.DB, `UPDATE orgs SET ai_automation = 1 WHERE id = ?`, ORG_A);
    await run(env.DB, `DELETE FROM org_usage_daily`);
    for (const m of ["ai_run_failed:x", "ai_run_capped:x", "ai_tokens_in"]) {
      await run(env.DB, `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, ?, ?, 'seed', 999, ?)`, ORG_A, DAY, m, `${DAY}T01:00:00.000Z`);
    }
    expect(await aiEligibility(ctx, keyedEnv(), NOW)).toBe("ok");
  });
});

describe("Platform › Usage — AI runs and tokens per provider (OrgUsage.ai, PlatformUsageResponse.ai)", () => {
  it("are read from the pass's metrics per org and in total, only when a key is set; the pass is never an active person", async () => {
    await cards(ORG_A, 2);
    await pass(stub({ ok: false }), [job()]);
    await setPlan("free", ORG_B);
    await seedRuns(250, ORG_B);
    await cards(ORG_B, 1);
    for (let i = 1; i <= 2; i++) await markRow(ORG_A, "card", `ticket:${i}`, BEFORE);
    await pass(stub(), [job(), jevCardJob()]);
    const p = platformCtx();
    const on = await platformUsage(p, 30, NOW, { aiEnabled: true });
    const a = on.orgs.find((o) => o.slug === "saplinglearn")!;
    const b = on.orgs.find((o) => o.slug === "acme")!;
    // ORG_A: two failed Haiku runs (their scopes were retried on the second pass: two more runs), two Jev checks.
    expect(AiUsageSchema.parse(a.ai)).toEqual({ runs: 4, failed: 2, capped: 0, tokensIn: 200, tokensOut: 14, tokensCached: 80, jevChecks: 2, jevTokensIn: 100, jevTokensOut: 2 });
    expect(b.ai).toEqual({ runs: 250, failed: 0, capped: 1, tokensIn: 0, tokensOut: 0, tokensCached: 0, jevChecks: 0, jevTokensIn: 0, jevTokensOut: 0 }); // the seeded `ai_run:seed` counts as runs
    expect(on.ai).toEqual({ runs: 254, failed: 2, capped: 1, tokensIn: 200, tokensOut: 14, tokensCached: 80, jevChecks: 2, jevTokensIn: 100, jevTokensOut: 2 });
    // Not a person's request: no active people, no "last activity".
    expect(a.activity.active_people).toBe(0);
    expect(a.last_activity_at).toBeNull();
    // No key: the field is not there at all (Platform says AI is off, as for summaries).
    const off = await platformUsage(p, 30, NOW);
    expect(off).not.toHaveProperty("ai");
    expect(off.orgs.every((o) => !("ai" in o))).toBe(true);
  });
});
