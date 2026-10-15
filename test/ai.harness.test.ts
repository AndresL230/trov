// THE PASS HARNESS (docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase B, "The master's review"): a fake
// org with real D1 rows written by the REAL write paths (the webhook, the ticket writer), both providers stubbed at
// the `Response` level and COUNTED, and stand-in jobs for the kinds Phases C and D build. It proves the counts the
// design promises — ten pushes plus a merge give ONE repo call; 25 ticket cards give 25 Jev requests and zero
// Haiku calls; a non-substantive burst gives one Jev call and no Haiku call — and the machinery's guards:
// grouping, the caps, section isolation, the 3-attempt clearing, the prefix, the Batch API (and a result for a
// deleted or switched-off org writing nothing). The last suite MEASURES what a tick spends for a few org counts.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { z } from "zod";
import type { Env } from "../src/env";
import { JEV_CALLS_PER_TICK, runAiPass, type AiJob, type AiPassResult } from "../src/ai/pass";
import { HAIKU_GROUP_MAX, type ClaudeJob } from "../src/ai/jobs";
import { each, keep, sections } from "../src/ai/sections";
import { newBudget, CRON_SUBREQUEST_BUDGET, CRON_WALL_BUDGET_MS } from "../src/repo/dispatch";
import { captureDelivery } from "../src/webhook";
import { create_ticket } from "../src/tools/tickets";
import { markDirty } from "../src/data/ai-dirty";
import { batch as sqlBatch } from "../src/data/sql";
import { orgRowDeletes } from "../src/deletion/tables";
import { all, first, run } from "./helpers/db";
import { ORG_A, ORG_B, systemCtx } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";
import {
  answerEveryKey, claudeJob, dirtyRow, jevCardJob, keyedEnv, markRow, sessionGate, stubProviders, succeededLine, type Stub,
} from "./helpers/ai-pass";

const e = env as unknown as Env;
const REPO = "SaplingLearn/sapling";
const MIN = 60_000;
const later = (ms: number) => new Date(Date.now() + ms);
const pass = (s: Stub, jobs: readonly AiJob[], now: Date, o: { env?: Env; limit?: number } = {}): Promise<AiPassResult> =>
  runAiPass(o.env ?? keyedEnv(), newBudget(s.fetchImpl, o.limit ?? CRON_SUBREQUEST_BUDGET), { jobs, now });
const count = async (sql: string, ...p: unknown[]) => (await first<{ n: number }>(env.DB, sql, ...p))!.n;

/** One verified webhook delivery for SaplingLearn's primary repo, through the real capture (no summarizer). */
const deliver = (event: string, payload: unknown) =>
  captureDelivery(systemCtx(ORG_A, "github-webhook"), e, { repo: REPO, githubToken: async () => null }, event, JSON.stringify(payload), { summarizer: null, issueSummarizer: null });
const push = (i: number, ref = "main", actor = "jose", commits = 1) => ({
  ref: `refs/heads/${ref}`, after: String(i).padStart(40, "a"), before: "0".repeat(40), compare: "https://github.com/x",
  repository: { full_name: REPO, default_branch: "main", pushed_at: 1_760_000_000 + i }, sender: { login: actor },
  head_commit: { id: String(i), message: `commit ${i}`, timestamp: "2026-10-14T10:00:00Z" },
  commits: Array.from({ length: commits }, (_, k) => ({ id: `${i}-${k}`, distinct: true, message: `commit ${i}.${k}`, timestamp: "2026-10-14T10:00:00Z" })),
});
const merge = (n: number) => ({
  action: "closed", repository: { full_name: REPO, default_branch: "main" },
  pull_request: { number: n, title: `PR ${n}`, body: "", html_url: `https://github.com/${REPO}/pull/${n}`, state: "closed", merged: true,
    merged_at: "2026-10-14T10:30:00Z", closed_at: "2026-10-14T10:30:00Z", updated_at: "2026-10-14T10:30:00Z", user: { login: "AndresL230" },
    head: { ref: "feat/x", sha: "f".repeat(40) }, base: { ref: "main" }, milestone: null },
});

describe("THE THREE COUNTS the master checks", () => {
  it("ten pushes plus a merge on the default branch give ONE repo call (debounce + coalescing)", async () => {
    await addOrgRepo(REPO, ORG_A);
    for (let i = 1; i <= 10; i++) await deliver("push", push(i));
    await deliver("pull_request", merge(77));
    // Eleven events, ONE repo scope (and one session for the pushing actor).
    expect(await count(`SELECT COUNT(*) AS n FROM ai_dirty WHERE org_id = ? AND scope = 'repo'`, ORG_A)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM ai_dirty WHERE org_id = ? AND scope = 'session'`, ORG_A)).toBe(1);
    const s = stubProviders({ claude: answerEveryKey });
    const repoJob = claudeJob("repo");
    await pass(s, [repoJob], later(30 * MIN)); // inside the 60-minute wait (SaplingLearn is Enterprise)
    expect(s.haiku).toBe(0);
    await pass(s, [repoJob], later(61 * MIN));
    await pass(s, [repoJob], later(71 * MIN)); // written: nothing left for the next tick
    expect(s.haiku).toBe(1);
    expect(repoJob.wrote).toEqual([REPO]);
    expect(s.jev).toBe(0);
  });

  it("25 ticket cards give 25 Jev requests and ZERO Haiku calls", async () => {
    for (let i = 1; i <= 25; i++) await create_ticket(systemCtx(ORG_A), { title: `Ticket ${i}`, body: "", category: "other", priority: "normal", assignees: [] }, "AndresL230");
    expect(await count(`SELECT COUNT(*) AS n FROM ai_dirty WHERE org_id = ? AND scope = 'card'`, ORG_A)).toBe(25);
    const s = stubProviders();
    const cards = jevCardJob("ticket:");
    const r = await pass(s, [cards], later(MIN));
    expect([s.jev, s.haiku, r.jev, r.haiku]).toEqual([25, 0, 25, 0]);
    expect(cards.wrote).toHaveLength(25);
    expect(await count(`SELECT COUNT(*) AS n FROM ai_dirty WHERE org_id = ? AND scope = 'card'`, ORG_A)).toBe(0); // written cards are gone
    expect(await count(`SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE org_id = ? AND metric = 'ai_suggest'`, ORG_A)).toBe(25);
  });

  it("a NON-substantive session burst gives one Jev (gate) call and no Haiku call; a substantive one, one of each", async () => {
    for (let i = 1; i <= 3; i++) await deliver("push", push(i, "feat/typo", "jose"));
    const key = `${REPO}:jose`;
    const s = stubProviders({ jev: () => 0.2, claude: answerEveryKey });
    const gate = sessionGate();
    const digest = claudeJob("session", { gate });
    await pass(s, [digest], later(30 * MIN)); // the session is still open (45 min after its last push)
    expect(s.jev + s.haiku).toBe(0);
    await pass(s, [digest], later(46 * MIN));
    expect([s.jev, s.haiku]).toEqual([1, 0]);
    expect(gate.skipped).toEqual([key]);
    expect(await dirtyRow(ORG_A, "session", key)).toMatchObject({ attempts: 0 }); // written as skipped: clean
    await pass(s, [digest], later(56 * MIN));
    expect([s.jev, s.haiku]).toEqual([1, 0]);
    // A substantive burst: past the gate, one Haiku call.
    await deliver("push", push(9, "feat/real", "mia", 5));
    const s2 = stubProviders({ jev: () => 0.9, claude: answerEveryKey });
    await pass(s2, [claudeJob("session", { gate: sessionGate() })], later(46 * MIN));
    expect([s2.jev, s2.haiku]).toEqual([1, 1]);
  });

  it("with Jev unavailable the gate's plain rule decides (no key: no Jev request at all)", async () => {
    await markRow(ORG_A, "session", `${REPO}:jose`, new Date(Date.now() - 50 * MIN).toISOString());
    const s = stubProviders({ claude: answerEveryKey });
    await pass(s, [claudeJob("session", { gate: sessionGate(true) })], later(0), { env: keyedEnv({ TYPESAFE_API_KEY: undefined }) });
    expect([s.jev, s.haiku]).toEqual([0, 1]);
    // The provider stops (a 401): the rest of the tick falls back too, and no scope is blamed.
    for (const a of ["x", "y"]) await markRow(ORG_A, "session", `${REPO}:${a}`, new Date(Date.now() - 50 * MIN).toISOString());
    const s2 = stubProviders({ jev: () => ({ status: 401 }), claude: answerEveryKey });
    const gate = sessionGate(false);
    await pass(s2, [claudeJob("session", { gate })], later(0));
    expect([s2.jev, s2.haiku]).toEqual([1, 0]);
    expect(gate.skipped.sort()).toEqual([`${REPO}:x`, `${REPO}:y`]);
  });
});

describe("GROUPING: Jev one item per request; Haiku up to 20 per call", () => {
  it("25 Haiku cards go in two calls (20 + 5), each led by the cached org prefix", async () => {
    for (let i = 1; i <= 25; i++) await markRow(ORG_A, "card", `pr:${i}`, new Date(Date.now() - MIN).toISOString());
    const s = stubProviders({ claude: answerEveryKey });
    const j = claudeJob("card", { group: 50, keyPrefix: "pr:" }); // asks for 50: capped at HAIKU_GROUP_MAX
    await pass(s, [j], later(0));
    expect(HAIKU_GROUP_MAX).toBe(20);
    expect(j.calls).toEqual([20, 5]);
    expect(s.haiku).toBe(2);
    expect(j.wrote).toHaveLength(25);
    // THE PREFIX: the first user block, with the cache breakpoint; then the scope's input.
    const body = s.haikuBodies[0] as { messages: { content: { text: string; cache_control?: { type: string } }[] }[] };
    expect(body.messages[0].content).toHaveLength(2);
    expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[0].content[0].text).toContain("# Organization\nSaplingLearn");
    expect(body.messages[0].content[0].text).toContain("- auth: Sign-in, sessions, tokens, permissions");
    expect(body.messages[0].content[0].text).toContain("# Active themes\nnone");
    expect(body.messages[0].content[1].cache_control).toBeUndefined();
    expect(await count(`SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE metric = 'ai_run:summary_pr'`)).toBe(2); // one call = one run
  });

  it("Jev items never share a request, whatever a job says", async () => {
    for (let i = 1; i <= 3; i++) await markRow(ORG_A, "card", `ticket:${i}`, new Date(Date.now() - MIN).toISOString());
    const s = stubProviders();
    await pass(s, [{ ...jevCardJob(), group: 20 } as AiJob], later(0));
    expect(s.jev).toBe(3);
  });

  it(`THE JEV CAP: at most JEV_CALLS_PER_TICK (${JEV_CALLS_PER_TICK}) Jev requests a tick; the rest wait`, async () => {
    for (let i = 1; i <= 70; i++) await markRow(ORG_A, "card", `ticket:${i}`, new Date(Date.now() - MIN).toISOString());
    const s = stubProviders();
    const r = await pass(s, [jevCardJob()], later(0));
    expect([s.jev, r.deferred]).toEqual([JEV_CALLS_PER_TICK, 1]);
    await pass(s, [jevCardJob()], later(0));
    expect(s.jev).toBe(70);
  });
});

describe("SECTION ISOLATION: a bad section drops alone", () => {
  const Item = z.object({ key: z.string(), text: z.string().max(20) });
  const Schema = sections({ items: z.array(each(Item)).max(20), headline: z.string().max(30) });

  it("one bad item of three is dropped; the other two (and the valid section) still write", async () => {
    for (const k of ["pr:1", "pr:2", "pr:3"]) await markRow(ORG_A, "card", k, new Date(Date.now() - MIN).toISOString());
    const base = claudeJob("card", { group: 20, keyPrefix: "pr:" });
    const kept: unknown[] = [];
    const j: ClaudeJob<string, z.infer<typeof Schema>> = {
      ...base, schema: Schema,
      write: async (_ctx, items, out) => {
        const { kept: k, dropped } = keep(out);
        kept.push({ headline: k.headline, dropped });
        return (k.items ?? []).map((i) => i.key).filter((key) => items.some((it) => it.scope.key === key));
      },
    };
    const s = stubProviders({ claude: () => JSON.stringify({ items: [{ key: "pr:1", text: "fine" }, { key: "pr:2", text: "x".repeat(50) }, { key: "pr:3", text: "also fine" }], headline: "Two of three" }) });
    await pass(s, [j as AiJob], later(0));
    expect(s.haiku).toBe(1);
    expect(kept).toEqual([{ headline: "Two of three", dropped: 1 }]);
    expect(await dirtyRow(ORG_A, "card", "pr:1")).toBeNull();
    expect(await dirtyRow(ORG_A, "card", "pr:3")).toBeNull();
    expect(await dirtyRow(ORG_A, "card", "pr:2")).toMatchObject({ attempts: 1, last_error: "not_written" });
  });

  it("a bad top-level section is left out (never a guessed default); the rest of the answer stands", () => {
    const v = Schema.parse({ items: [{ key: "a", text: "ok" }], headline: "y".repeat(99) });
    expect(keep(v)).toEqual({ kept: { items: [{ key: "a", text: "ok" }] }, dropped: 1 });
    // Without isolation the same answer is rejected whole.
    expect(z.object({ items: z.array(Item), headline: z.string().max(30) }).safeParse({ items: [{ key: "a", text: "ok" }], headline: "y".repeat(99) }).success).toBe(false);
  });
});

describe("CLEARING: a written scope clears; a failure counts; after 3 it waits until it is marked again", () => {
  it("three failed attempts, then no call, then a re-mark runs it again", async () => {
    await markDirty(systemCtx(ORG_A), [{ scope: "card", key: "pr:5" }], new Date(Date.now() - MIN).toISOString());
    const s = stubProviders({ claude: () => ({ stop: "refusal" }) }); // a refusal writes nothing
    const j = claudeJob("card", { keyPrefix: "pr:" });
    for (let t = 1; t <= 3; t++) await pass(s, [j], later(t * 10 * MIN));
    expect(s.haiku).toBe(3);
    expect(await dirtyRow(ORG_A, "card", "pr:5")).toMatchObject({ attempts: 3, last_error: "no_answer" });
    await pass(s, [j], later(40 * MIN));
    expect(s.haiku).toBe(3); // waits
    await markDirty(systemCtx(ORG_A), [{ scope: "card", key: "pr:5" }]);
    expect((await dirtyRow(ORG_A, "card", "pr:5"))!.attempts).toBe(0);
    const ok = stubProviders({ claude: answerEveryKey });
    await pass(ok, [j], later(50 * MIN));
    expect(ok.haiku).toBe(1);
    expect(await dirtyRow(ORG_A, "card", "pr:5")).toBeNull();
  });

  it("a scope marked WHILE its run was going stays dirty, its wait counting from that mark", async () => {
    await addOrgRepo(REPO, ORG_A);
    const first0 = new Date(Date.now() - 2 * 60 * MIN).toISOString();
    await markDirty(systemCtx(ORG_A), [{ scope: "repo", key: REPO }], first0);
    const s = stubProviders({ claude: answerEveryKey });
    const j = claudeJob("repo");
    const during = new Date(Date.now() + 5 * MIN).toISOString();
    const marking: AiJob = { ...j, write: async (ctx, items, out, meta) => { await markDirty(ctx, [{ scope: "repo", key: REPO }], during); return j.write(ctx, items, out, meta); } };
    await pass(s, [marking], new Date(Date.now()));
    expect(await dirtyRow(ORG_A, "repo", REPO)).toMatchObject({ dirty_since: during, marked_at: during });
    await pass(s, [j], later(30 * MIN)); // 25 minutes after the mid-run mark: inside its 60-minute wait
    expect(s.haiku).toBe(1);
  });
});

describe("THE BATCH API: submitted at the end of a tick, collected on a later one", () => {
  it("submits ONE batch across orgs, holds the scopes, collects later — and a deleted or switched-off org gets NOTHING", async () => {
    await run(env.DB, `INSERT INTO orgs (id, slug, name, created_at, created_by) VALUES ('org_gone', 'gone', 'Gone', '2026-10-01', 'test')`);
    // Doc drift waits a week on Enterprise and a month on Free (`org_gone` is Free): past both.
    const eightDaysAgo = new Date(Date.now() - 31 * 24 * 60 * MIN).toISOString();
    for (const o of [ORG_A, ORG_B, "org_gone"]) await markRow(o, "doc_drift", "auth", eightDaysAgo);
    const s = stubProviders();
    const drift = claudeJob("doc_drift", { batch: true, name: "test.drift" });
    const r1 = await pass(s, [drift], later(0));
    expect([r1.batched, s.batchCreates, s.haiku]).toEqual([3, 1, 0]);
    expect(s.batchBodies[0].requests.map((q) => q.custom_id)).toEqual(["r0", "r1", "r2"]);
    const reqs = await all<{ request_id: string; custom_id: string; job: string }>(env.DB, `SELECT request_id, custom_id, job FROM ai_batch_requests ORDER BY request_id`);
    expect(reqs.map((q) => q.custom_id)).toEqual(["org_b:doc_drift:auth:t1", "org_gone:doc_drift:auth:t1", "org_saplinglearn:doc_drift:auth:t1"]);
    // Each request is what a direct call sends: the org prefix first, with its cache breakpoint.
    const params = s.batchBodies[0].requests[0].params as { messages: { content: { cache_control?: unknown; text: string }[] }[] };
    expect(params.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(params.messages[0].content[0].text).toContain("# Organization\nAcme");
    // One run each, counted at submission; every scope HELD (it reads clean, so no tick submits it twice).
    expect(await count(`SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE metric = 'ai_run:summary_pr'`)).toBe(3);
    const r2 = await pass(s, [drift], later(10 * MIN));
    expect([r2.batched, s.batchCreates, s.batchRetrieves]).toEqual([0, 1, 1]); // not ended: asked, nothing written
    // Before it ends: one org is DELETED and one switches AI OFF.
    // The deletion's own statements (every ORG_TABLES row, src/deletion/tables.ts), then the org row.
    await sqlBatch(systemCtx("org_gone"), orgRowDeletes(systemCtx("org_gone")));
    await run(env.DB, `DELETE FROM orgs WHERE id = 'org_gone'`);
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_B);
    const heldB = await dirtyRow(ORG_B, "doc_drift", "auth");
    const metersBefore = await count(`SELECT COUNT(*) AS n FROM org_usage_daily`);
    s.batch.ended = true;
    s.batch.results = reqs.map((q) => succeededLine(q.request_id, JSON.stringify({ items: [{ key: "auth", text: "drifted" }] })));
    const wroteFor: string[] = [];
    const tracking: AiJob = { ...drift, write: async (ctx, items, out, meta) => { wroteFor.push(ctx.orgId); return drift.write(ctx, items, out, meta); } };
    const r3 = await pass(s, [tracking], later(20 * MIN));
    expect(r3.collected).toBe(1);
    expect(wroteFor).toEqual([ORG_A]); // only the org that still exists with AI on
    expect(await dirtyRow(ORG_A, "doc_drift", "auth")).toMatchObject({ attempts: 0, last_error: null });
    expect(await dirtyRow(ORG_B, "doc_drift", "auth")).toEqual(heldB); // untouched
    expect(await count(`SELECT COUNT(*) AS n FROM org_usage_daily WHERE org_id IN ('org_gone', ?)`, ORG_B) ).toBe(1); // only org_b's submission run, from before
    expect(await count(`SELECT COUNT(*) AS n FROM org_usage_daily`)).toBe(metersBefore + 3); // ORG_A's three token rows
    expect(await first(env.DB, `SELECT state, requests, succeeded, written FROM ai_batches`)).toEqual({ state: "collected", requests: 3, succeeded: 3, written: 1 });
    expect(await count(`SELECT COUNT(*) AS n FROM ai_batch_requests`)).toBe(0);
  });

  it("a batch the provider no longer knows is `lost`: its scopes are due again", async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * MIN).toISOString();
    await markRow(ORG_A, "doc_drift", "auth", old);
    const s = stubProviders();
    const drift = claudeJob("doc_drift", { batch: true, name: "test.drift" });
    await pass(s, [drift], later(0));
    s.batch.gone = true;
    await pass(s, [drift], later(10 * MIN));
    expect(await first(env.DB, `SELECT state FROM ai_batches`)).toEqual({ state: "lost" });
    expect(await dirtyRow(ORG_A, "doc_drift", "auth")).toMatchObject({ attempts: 1, last_error: "batch_lost", last_run_at: null });
  });
});

describe("MEASURED: what one tick spends (the cron headroom the handoff asked for)", () => {
  it("subrequests and wall clock per tick for 1, 10 and 50 orgs, each with 5 ticket cards, a repo and a session", async () => {
    const out: string[] = [];
    for (const orgs of [1, 10, 50]) {
      await run(env.DB, `DELETE FROM ai_dirty`);
      await run(env.DB, `DELETE FROM org_usage_daily`);
      await run(env.DB, `UPDATE cron_cursor SET last_key = ''`);
      await run(env.DB, `DELETE FROM orgs WHERE id LIKE 'org_m%'`);
      const ids = [ORG_A, ...Array.from({ length: orgs - 1 }, (_, i) => `org_m${String(i).padStart(3, "0")}`)];
      for (const id of ids.slice(1)) await run(env.DB, `INSERT INTO orgs (id, slug, name, created_at, created_by, plan) VALUES (?, ?, ?, '2026-10-01', 'test', 'team')`, id, id.replace("_", "-"), id);
      const old = new Date(Date.now() - 2 * 60 * MIN).toISOString();
      for (const id of ids) {
        for (let i = 1; i <= 5; i++) await markRow(id, "card", `ticket:${i}`, old);
        await markRow(id, "repo", REPO, old);
        await markRow(id, "session", `${REPO}:jose`, old);
      }
      const s = stubProviders({ claude: answerEveryKey, jev: () => 0.9 });
      const jobs: AiJob[] = [jevCardJob(), claudeJob("repo"), claudeJob("session", { gate: sessionGate() })];
      // Tick after tick until every scope is written: the first tick's spend, the worst tick's, and how many ticks.
      let ticks = 0;
      let firstLine = "";
      let worst = { spent: 0, ms: 0 };
      for (;;) {
        const budget = newBudget(s.fetchImpl);
        const t0 = Date.now();
        const r = await runAiPass(keyedEnv(), budget, { jobs, now: later(ticks * 10 * MIN) });
        const ms = Date.now() - t0;
        ticks++;
        expect(budget.spent).toBeLessThanOrEqual(12 + JEV_CALLS_PER_TICK + 4);
        expect(ms).toBeLessThan(CRON_WALL_BUDGET_MS);
        worst = { spent: Math.max(worst.spent, budget.spent), ms: Math.max(worst.ms, ms) };
        if (ticks === 1) firstLine = `${budget.spent} subrequests (haiku ${r.haiku}, jev ${r.jev}), ${ms} ms, ${r.served.length} orgs served, ${r.deferred} deferred`;
        if (r.calls === 0 || ticks > 40) break;
      }
      const left = await count(`SELECT COUNT(*) AS n FROM ai_dirty WHERE last_run_at IS NULL OR COALESCE(marked_at, dirty_since) > last_run_at`);
      expect(left).toBe(0);
      out.push(`${orgs} org(s) with work: first tick ${firstLine}; drained in ${ticks - 1} ticks; worst tick ${worst.spent} subrequests / ${worst.ms} ms (of ${CRON_SUBREQUEST_BUDGET} / ${CRON_WALL_BUDGET_MS} ms)`);
    }
    console.warn(`AI pass, measured (stubs answer at once — wall clock is D1 and the pass's own work):\n  ${out.join("\n  ")}`);
  }, 120_000); // dozens of passes over hundreds of D1 rows: generous under a loaded full-suite run
});
