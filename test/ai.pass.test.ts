// The AI pass (src/ai/pass.ts, docs/architecture/ai.md): the skeleton every AI job will run in. Its registry
// is EMPTY in production — so the first suite proves it does nothing at all — and the rest register a FAKE
// job through `opts.jobs` to drive the guards: eligibility (the switch, the key, the allowance), the per-tick
// cap, the cron budget and the rotation cursor. Anthropic is a stub answering real Messages API bodies; the
// assertions are on meter rows and the cursor, except the zero-fetch checks.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { z } from "zod";
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
import { FAKE_ANTHROPIC_KEY, errorResponse, messageResponse } from "./helpers/anthropic";

const NOW = new Date("2026-10-14T12:40:00.000Z"); // a :40 tick: no heavy job
const DAY = "2026-10-14";
const keyed = (over: Partial<Env> = {}): Env => ({ ...(env as unknown as Env), ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, ...over });
const KIND = "summary_pr" as const; // a test job borrows an existing AiKind: the registry adds no real kind

/** The Messages API stand-in, and every non-Anthropic request (health pings) answered 200. `seen` records
 *  the org's `ai_run:*` count AT the moment each model call arrives — the attempt must already be there. */
function stub(o: { ok?: boolean } = {}) {
  const g = {
    anthropic: 0, other: 0, seen: [] as number[],
    fetchImpl: (async (url: string | URL | Request) => {
      const u = String(url instanceof Request ? url.url : url);
      if (!u.startsWith("https://api.anthropic.com/")) { g.other++; return new Response("ok", { status: 200 }); }
      g.anthropic++;
      g.seen.push((await first<{ n: number }>(env.DB, `SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE metric GLOB 'ai_run:*'`))!.n);
      return o.ok === false ? errorResponse(500) : messageResponse(JSON.stringify({ ok: true }), { usage: { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 40 } });
    }) as unknown as typeof fetch,
  };
  return g;
}

/** A job with `n(orgId)` units waiting; each run makes ONE structured call. Records the orgs it ran for. */
function fakeJob(n: (orgId: string) => number = () => 1): AiJob & { ran: string[] } {
  const ran: string[] = [];
  return {
    kind: KIND, ran,
    pending: async (ctx) => n(ctx.orgId),
    run: async (ctx, provider) => {
      ran.push(ctx.orgId);
      const r = await provider.structured({ kind: KIND, system: "test", input: "test", schema: z.object({ ok: z.boolean() }), maxTokens: 50 });
      return r ? "done" : "failed";
    },
  };
}

const metric = async (name: string, orgId: string = ORG_A): Promise<number> =>
  (await first<{ n: number }>(env.DB, `SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE org_id = ? AND metric = ?`, orgId, name))!.n;
const aiRows = () => all<{ org_id: string; metric: string; actor: string; count: number }>(env.DB,
  `SELECT org_id, metric, actor, count FROM org_usage_daily WHERE metric GLOB 'ai_*' ORDER BY org_id, metric`);
const setPlan = (plan: string, orgId: string = ORG_A) => run(env.DB, `UPDATE orgs SET plan = ?, plan_overrides = '{}', plan_status = 'active' WHERE id = ?`, plan, orgId);
const seedRuns = (n: number, orgId: string = ORG_A) =>
  run(env.DB, `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, ?, 'ai_run:seed', 'seed', ?, ?)
               ON CONFLICT(org_id, day, metric, actor) DO UPDATE SET count = count + excluded.count`, orgId, DAY, n, `${DAY}T01:00:00.000Z`);
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
const pass = (s: ReturnType<typeof stub>, jobs: readonly AiJob[], limit = 900, e: Env = keyed()) =>
  runAiPass(e, newBudget(s.fetchImpl, limit), { jobs, now: NOW });

describe("the real registry is empty", () => {
  it("AI_JOBS has nothing in it, and a pass with it makes zero calls and writes nothing — with a key, every org eligible", async () => {
    expect(AI_JOBS).toEqual([]);
    const s = stub();
    expect(await runAiPass(keyed(), newBudget(s.fetchImpl), { now: NOW })).toEqual({ calls: 0, served: [], deferred: 0 });
    expect(s.anthropic + s.other).toBe(0);
    expect(await aiRows()).toEqual([]);
    expect(await cursor()).toBe(""); // nothing read, nothing written
  });

  it("the */10 tick runs it after the health pings and it still does nothing", async () => {
    await setOrgEnvironments([ENVS[0]]);
    const s = stub();
    await handleRepoCron(keyed(), NOW.getTime(), s.fetchImpl);
    expect(s.other).toBe(2); // the environment's two health pings
    expect(s.anthropic).toBe(0);
    expect(await aiRows()).toEqual([]);
  });
});

describe("with a job registered", () => {
  it("an ok org: the attempt is metered BEFORE the call, then the tokens; the run is counted against the org", async () => {
    const s = stub();
    const job = fakeJob((org) => (org === ORG_A ? 1 : 0));
    expect(await pass(s, [job])).toMatchObject({ calls: 1, deferred: 0 });
    expect(s.anthropic).toBe(1);
    expect(s.seen).toEqual([1]); // the stub read the `ai_run:` row while the call was in flight
    expect(job.ran).toEqual([ORG_A]);
    expect(await aiRows()).toEqual([
      { org_id: ORG_A, metric: `ai_run:${KIND}`, actor: AI_PASS_ACTOR, count: 1 },
      { org_id: ORG_A, metric: "ai_tokens_cached", actor: AI_PASS_ACTOR, count: 40 },
      { org_id: ORG_A, metric: "ai_tokens_in", actor: AI_PASS_ACTOR, count: 100 },
      { org_id: ORG_A, metric: "ai_tokens_out", actor: AI_PASS_ACTOR, count: 7 },
    ]);
  });

  it("a call that answers nothing is `ai_run_failed`, and still one run", async () => {
    const s = stub({ ok: false });
    await pass(s, [fakeJob((org) => (org === ORG_A ? 1 : 0))]);
    expect(await metric(`ai_run:${KIND}`)).toBe(1);
    expect(await metric(`ai_run_failed:${KIND}`)).toBe(1);
  });

  it("a Free org at 250 makes no call and counts one `ai_run_capped`; a Pro org at 250 runs", async () => {
    expect([PLANS.free.entitlements.ai_runs, PLANS.personal.entitlements.ai_runs, PLANS.team.entitlements.ai_runs, PLANS.enterprise.entitlements.ai_runs]).toEqual([250, 250, 2000, null]);
    await setPlan("free", ORG_A);
    await seedRuns(250, ORG_A);
    await setPlan("team", ORG_B);
    await seedRuns(250, ORG_B);
    const s = stub();
    const job = fakeJob(() => 3);
    await pass(s, [job]);
    expect(job.ran.every((o) => o === ORG_B)).toBe(true);
    expect(await metric(`ai_run:${KIND}`, ORG_A)).toBe(0);
    expect(await metric(`ai_run_capped:${KIND}`, ORG_A)).toBe(1); // one per job that had work, not per unit
    expect(await metric(`ai_run:${KIND}`, ORG_B)).toBe(3);
    expect(await metric(`ai_run_capped:${KIND}`, ORG_B)).toBe(0);
    expect(s.anthropic).toBe(3);
  });

  it("the allowance left at the org's start is never overspent within the tick", async () => {
    await setPlan("free", ORG_A);
    await seedRuns(248, ORG_A);
    const s = stub();
    await pass(s, [fakeJob((org) => (org === ORG_A ? 5 : 0))]);
    expect(await metric(`ai_run:${KIND}`)).toBe(2);
    expect(await metric(`ai_run_capped:${KIND}`)).toBe(1);
    expect(s.anthropic).toBe(2);
  });

  it("an ended plan is capped too", async () => {
    await run(env.DB, `UPDATE orgs SET plan = 'team', plan_status = 'canceled' WHERE id = ?`, ORG_A);
    const s = stub();
    await pass(s, [fakeJob((org) => (org === ORG_A ? 1 : 0))]);
    expect(s.anthropic).toBe(0);
    expect(await metric(`ai_run_capped:${KIND}`)).toBe(1);
  });

  it("the switch off: no call, nothing counted", async () => {
    await switchOff(ORG_A);
    await switchOff(ORG_B);
    const s = stub();
    const job = fakeJob(() => 2);
    await pass(s, [job]);
    expect(s.anthropic).toBe(0);
    expect(job.ran).toEqual([]);
    expect(await aiRows()).toEqual([]);
  });

  it("no key: no call, nothing read or counted", async () => {
    const s = stub();
    const job = fakeJob(() => 2);
    let asked = 0;
    const r = await runAiPass(env as unknown as Env, newBudget(s.fetchImpl), { jobs: [{ ...job, pending: async (c) => { asked++; return job.pending(c); } }], now: NOW });
    expect(r).toEqual({ calls: 0, served: [], deferred: 0 });
    expect(s.anthropic).toBe(0);
    expect(asked).toBe(0);
    expect(await aiRows()).toEqual([]);
  });

  it(`AI_RUNS_PER_TICK (${AI_RUNS_PER_TICK}) caps the calls across orgs, and the next tick resumes where it stopped`, async () => {
    const extra = await moreOrgs(3); // five orgs, five units each
    const s = stub();
    const job = fakeJob(() => 5);
    const first1 = await pass(s, [job]);
    expect(s.anthropic).toBe(AI_RUNS_PER_TICK);
    expect(first1.calls).toBe(AI_RUNS_PER_TICK);
    // 12 = the first org's 5 + the second's 5 + two of the third's: two finished, the third goes first next tick.
    expect(first1.served).toEqual(SEED_ORDER);
    expect(await cursor()).toBe(SEED_ORDER[1]);
    const s2 = stub();
    const job2 = fakeJob(() => 5);
    await pass(s2, [job2]);
    expect(job2.ran[0]).toBe(extra[0]);
  });

  it("a budget with room for N calls makes N, and the cursor resumes at the next org on the following tick", async () => {
    const extra = await moreOrgs(3);
    const order = [...SEED_ORDER, ...extra];
    const s = stub();
    const job = fakeJob(() => 1);
    const r = await pass(s, [job], 3);
    expect(s.anthropic).toBe(3);
    expect(r).toEqual({ calls: 3, served: order.slice(0, 3), deferred: 2 });
    expect(job.ran).toEqual(order.slice(0, 3));
    expect(await cursor()).toBe(order[2]);
    // The next tick starts after it: the two left, then round to the top.
    const s2 = stub();
    const job2 = fakeJob(() => 1);
    const r2 = await pass(s2, [job2], 3);
    expect(job2.ran).toEqual([order[3], order[4], order[0]]);
    expect(r2.served).toEqual([order[3], order[4], order[0]]);
    expect(await cursor()).toBe(order[0]);
  });

  it("a budget already spent makes no call and leaves the cursor where it was", async () => {
    await run(env.DB, `INSERT INTO cron_cursor (job, last_key, updated_at) VALUES (?, ?, ?) ON CONFLICT(job) DO UPDATE SET last_key = excluded.last_key`, AI_PASS_JOB, ORG_B, DAY);
    const s = stub();
    const budget = newBudget(s.fetchImpl, 5);
    budget.spent = 5;
    expect(await runAiPass(keyed(), budget, { jobs: [fakeJob()], now: NOW })).toMatchObject({ calls: 0, served: [] });
    expect(s.anthropic).toBe(0);
    expect(await cursor()).toBe(ORG_B);
  });

  it("in the tick it shares the cron's budget with the health pings, and a heavy tick does not run it", async () => {
    await setOrgEnvironments([ENVS[0]]);
    const s = stub();
    const job = fakeJob((org) => (org === ORG_A ? 5 : 0));
    await handleRepoCron(keyed(), NOW.getTime(), s.fetchImpl, 4, { jobs: [job] });
    expect(s.other).toBe(2); // health first
    expect(s.anthropic).toBe(2); // the pass gets what is left: 4 - 2
    const heavy = stub();
    await handleRepoCron(keyed(), Date.parse("2026-10-14T13:00:00.000Z"), heavy.fetchImpl, 900, { jobs: [fakeJob(() => 5)] });
    expect(heavy.anthropic).toBe(0); // :00 is the usage polls' alone
  });

  it("a job that throws is one failed run, and the loop moves on to the next org", async () => {
    const s = stub();
    const bad: AiJob = { kind: KIND, pending: async () => 1, run: async (ctx) => { if (ctx.orgId === ORG_A) throw new Error("boom"); return "done"; } };
    const r = await pass(s, [bad]);
    expect(r.served).toEqual(SEED_ORDER);
    expect(await metric(`ai_run_failed:${KIND}`, ORG_A)).toBe(1);
    expect(await metric(`ai_run_failed:${KIND}`, ORG_B)).toBe(0);
  });
});

describe("aiEligibility", () => {
  it("ok / off / no_key / capped — and an org that is not there reads as off", async () => {
    const ctx = systemCtx(ORG_A);
    expect(await aiEligibility(ctx, keyed(), NOW)).toBe("ok");
    expect(await aiEligibility(ctx, env as unknown as Env, NOW)).toBe("no_key");
    await setPlan("free");
    await seedRuns(249);
    expect(await aiEligibility(ctx, keyed(), NOW)).toBe("ok");
    await seedRuns(1);
    expect(await aiEligibility(ctx, keyed(), NOW)).toBe("capped");
    // Last month's runs do not count.
    expect(await aiEligibility(ctx, keyed(), new Date("2026-11-01T00:00:00.000Z"))).toBe("ok");
    await switchOff();
    expect(await aiEligibility(ctx, keyed(), NOW)).toBe("off");
    expect(await aiEligibility(ctx, env as unknown as Env, NOW)).toBe("no_key");
    expect(await aiEligibility(systemCtx("org_missing"), keyed(), NOW)).toBe("off");
    // Only `ai_run:*` counts toward the allowance: failures, caps and tokens do not.
    await run(env.DB, `UPDATE orgs SET ai_automation = 1 WHERE id = ?`, ORG_A);
    await run(env.DB, `DELETE FROM org_usage_daily`);
    for (const m of ["ai_run_failed:x", "ai_run_capped:x", "ai_tokens_in"]) {
      await run(env.DB, `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, ?, ?, 'seed', 999, ?)`, ORG_A, DAY, m, `${DAY}T01:00:00.000Z`);
    }
    expect(await aiEligibility(ctx, keyed(), NOW)).toBe("ok");
  });
});

describe("Platform › Usage — AI runs and tokens (OrgUsage.ai, PlatformUsageResponse.ai)", () => {
  it("are read from the pass's metrics per org and in total, only when a key is set; the pass is never an active person", async () => {
    await pass(stub({ ok: false }), [fakeJob((org) => (org === ORG_A ? 2 : 0))]);
    await setPlan("free", ORG_B);
    await seedRuns(250, ORG_B);
    await pass(stub(), [fakeJob((org) => (org === ORG_B ? 1 : 0))]);
    const p = platformCtx();
    const on = await platformUsage(p, 30, NOW, { aiEnabled: true });
    const a = on.orgs.find((o) => o.slug === "saplinglearn")!;
    const b = on.orgs.find((o) => o.slug === "acme")!;
    expect(AiUsageSchema.parse(a.ai)).toEqual({ runs: 2, failed: 2, capped: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0 });
    expect(b.ai).toEqual({ runs: 250, failed: 0, capped: 1, tokensIn: 0, tokensOut: 0, tokensCached: 0 }); // the seeded `ai_run:seed` counts as runs
    expect(on.ai).toEqual({ runs: 252, failed: 2, capped: 1, tokensIn: 0, tokensOut: 0, tokensCached: 0 });
    // Not a person's request: no active people, no "last activity".
    expect(a.activity.active_people).toBe(0);
    expect(a.last_activity_at).toBeNull();
    // No key: the field is not there at all (Platform says AI is off, as for summaries).
    const off = await platformUsage(p, 30, NOW);
    expect(off).not.toHaveProperty("ai");
    expect(off.orgs.every((o) => !("ai" in o))).toBe(true);
  });
});
