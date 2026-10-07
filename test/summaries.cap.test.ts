// AI summaries, per org (docs/architecture/plans.md › AI summaries): every attempted summarizer call is
// counted in `org_usage_daily`, and the plan's monthly allowance (`ai_summaries`) turns the summarizer
// off when it is used up. The Gemini call is ALWAYS a stub here — never the network.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import type { PrSummaryRow, IssueSummaryRow } from "@shared/rows";
import { PLANS, monthStartDay, planRefusal, resolveEntitlements, overLimits } from "@shared/plans";
import { all, first, run } from "./helpers/db";
import { ORG_A, ORG_B, platformCtx, systemCtx } from "./helpers/tenant";
import { runBackfill } from "./helpers/org-config";
import { orgSummarizers, summaryAllowance } from "../src/plans/summaries";
import { orgPlanView, summariesUsed } from "../src/plans/gate";
import { captureDelivery } from "../src/webhook";
import { platformUsage } from "../src/platform/usage";
import prMerged from "./fixtures/gh-pr-merged.json";
import issueAssigned from "./fixtures/gh-issue-assigned.json";

const KEY = "AIzaFAKE_gemini_key_for_tests_0123456789";
const keyed = (over: Partial<Env> = {}): Env => ({ ...(env as unknown as Env), GEMINI_API_KEY: KEY, GITHUB_SERVICE_TOKEN: "svc-token", GITHUB_REPO: "o/r", ...over });
const CANARY = "CANARY-SUMMARY-TEXT";

/** A Gemini `generateContent` stand-in. `ok: false` answers 500; `tokens` adds `usageMetadata`. */
function gemini(o: { ok?: boolean; tokens?: boolean } = {}): { fetchImpl: typeof fetch; calls: number; bodies: string[] } {
  const g = {
    calls: 0, bodies: [] as string[],
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      g.calls++;
      g.bodies.push(String(init?.body ?? ""));
      expect(String(url)).toContain("generativelanguage.googleapis.com");
      if (o.ok === false) return new Response("upstream said no", { status: 500 });
      const isIssue = String(init?.body ?? "").includes("personal to-do list");
      const text = JSON.stringify(isIssue
        ? { title: `${CANARY} issue`, summary: `${CANARY} summary`, next_step: null }
        : { title: `${CANARY} pr`, what: `${CANARY} what`, why: null, impact: null });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
        ...(o.tokens === false ? {} : { usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 45, totalTokenCount: 366 } }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  };
  return g;
}

interface UsageRow { org_id: string; day: string; metric: string; actor: string; count: number }
const usage = (orgId: string = ORG_A) => all<UsageRow>(env.DB, `SELECT org_id, day, metric, actor, count FROM org_usage_daily WHERE org_id = ? ORDER BY metric, actor`, orgId);
const metric = async (name: string, orgId: string = ORG_A): Promise<number> =>
  (await first<{ n: number }>(env.DB, `SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE org_id = ? AND metric = ?`, orgId, name))?.n ?? 0;
const setPlan = (plan: string, overrides: Record<string, number | null> = {}, status = "active", orgId: string = ORG_A) =>
  run(env.DB, `UPDATE orgs SET plan = ?, plan_overrides = ?, plan_status = ? WHERE id = ?`, plan, JSON.stringify(overrides), status, orgId);
const seedUsed = (n: number, day: string, orgId: string = ORG_A, name = "summary:pr") =>
  run(env.DB, `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, ?, ?, 'seed', ?, ?)
               ON CONFLICT(org_id, day, metric, actor) DO UPDATE SET count = count + excluded.count`, orgId, day, name, n, `${day}T12:00:00.000Z`);
const NOW = new Date("2026-10-07T12:00:00.000Z");
const today = "2026-10-07";

const input = { title: "Add export", body: `The body. ${CANARY}` };

describe("the allowance (`ai_summaries`, shared/plans.ts)", () => {
  it("is a normal limit with placeholder defaults: 300 / 3,000 / unlimited, overridable per org, monthly", () => {
    expect([PLANS.personal, PLANS.team, PLANS.enterprise].map((p) => p.entitlements.ai_summaries)).toEqual([300, 3000, null]);
    expect(resolveEntitlements("team", { ai_summaries: 12 }).ai_summaries).toBe(12);
    expect(resolveEntitlements("team", { ai_summaries: null }).ai_summaries).toBeNull();
    const team = { plan: "team" as const, overrides: {}, status: "active" as const };
    expect(planRefusal(team, "ai_summaries", 2999)).toBeNull();
    expect(planRefusal(team, "ai_summaries", 3000)).toMatchObject({ limit: "ai_summaries", cap: 3000 });
    // Using a month's allowance up is not being "over a limit": nothing is refused with a 402.
    expect(overLimits(PLANS.team.entitlements, { ai_summaries: 3004 })).toEqual([]);
    expect(monthStartDay(new Date("2026-10-31T23:59:59.999Z"))).toBe("2026-10-01");
    expect(monthStartDay(new Date("2026-11-01T00:00:00.000Z"))).toBe("2026-11-01");
  });

  it("reads under / at / over the cap, an override, Enterprise's unlimited, an ended plan — and off without a key", async () => {
    const ctx = systemCtx();
    await setPlan("personal");
    await seedUsed(299, today);
    expect(await summaryAllowance(keyed(), ctx, NOW)).toEqual({ status: "on", used: 299, cap: 300, remaining: 1 });
    await seedUsed(1, today);
    expect(await summaryAllowance(keyed(), ctx, NOW)).toEqual({ status: "capped", used: 300, cap: 300, remaining: 0 });
    await seedUsed(4, today, ORG_A, "summary:issue"); // issues count toward the same allowance
    expect(await summaryAllowance(keyed(), ctx, NOW)).toEqual({ status: "capped", used: 304, cap: 300, remaining: 0 });
    await setPlan("personal", { ai_summaries: 500 });
    expect(await summaryAllowance(keyed(), ctx, NOW)).toEqual({ status: "on", used: 304, cap: 500, remaining: 196 });
    await setPlan("enterprise");
    expect(await summaryAllowance(keyed(), ctx, NOW)).toEqual({ status: "on", used: 304, cap: null, remaining: null });
    await setPlan("enterprise", {}, "canceled");
    expect((await summaryAllowance(keyed(), ctx, NOW)).status).toBe("ended");
    await setPlan("team", {}, "past_due"); // a grace period changes nothing
    expect((await summaryAllowance(keyed(), ctx, NOW)).status).toBe("on");
    // No platform key: off — whatever the plan, and without reading anything.
    expect(await summaryAllowance(env as unknown as Env, ctx, NOW)).toEqual({ status: "off", used: 0, cap: null, remaining: null });
  });

  it("resets with the calendar month, in UTC", async () => {
    const ctx = systemCtx();
    await setPlan("team", { ai_summaries: 5 });
    await seedUsed(5, "2026-09-30");
    // 23:59:59 UTC on the 30th: used up. One second later it is October, and the allowance is whole.
    expect(await summariesUsed(ctx, new Date("2026-09-30T23:59:59.000Z"))).toBe(5);
    expect((await summaryAllowance(keyed(), ctx, new Date("2026-09-30T23:59:59.000Z"))).status).toBe("capped");
    expect(await summaryAllowance(keyed(), ctx, new Date("2026-10-01T00:00:00.000Z"))).toEqual({ status: "on", used: 0, cap: 5, remaining: 5 });
    // A local-time evening in a UTC-behind zone is already the next UTC day: the boundary is UTC's.
    await seedUsed(2, "2026-10-01");
    expect(await summariesUsed(ctx, new Date("2026-10-01T00:00:01.000Z"))).toBe(2);
    expect(await summariesUsed(ctx, new Date("2026-10-31T23:59:59.999Z"))).toBe(2);
    expect(await summariesUsed(ctx, new Date("2026-11-01T00:00:00.000Z"))).toBe(0);
  });

  it("is the org's own: another org's use does not count, and the Plan block shows it as use of a limit", async () => {
    await setPlan("team", { ai_summaries: 5 });
    await setPlan("team", { ai_summaries: 5 }, "active", ORG_B);
    await seedUsed(5, monthStartDay(), ORG_B);
    await seedUsed(2, monthStartDay());
    expect((await summaryAllowance(keyed(), systemCtx(ORG_A))).status).toBe("on");
    expect((await summaryAllowance(keyed(), systemCtx(ORG_B))).status).toBe("capped");
    const view = await orgPlanView(systemCtx(ORG_B));
    expect(view.entitlements.ai_summaries).toBe(5);
    expect(view.usage.ai_summaries).toBe(5);
    expect(view.over).toEqual([]);
    expect((await orgPlanView(systemCtx(ORG_A))).usage.ai_summaries).toBe(2);
  });
});

describe("orgSummarizers — THE summarizer for an org, and its metering", () => {
  it("with no platform key answers null, counts nothing and caps nothing", async () => {
    const s = await orgSummarizers(env as unknown as Env, systemCtx(), { actor: "admin-user" });
    expect(s.pr()).toBeNull();
    expect(s.issue()).toBeNull();
    await s.skipped("pr");
    expect(s.allowance().status).toBe("off");
    expect(await usage()).toEqual([]);
  });

  it("counts every attempt with its outcome and size — and never the text", async () => {
    await setPlan("team");
    const ok = gemini();
    const s = await orgSummarizers(keyed(), systemCtx(), { actor: "admin-user", gemini: { fetchImpl: ok.fetchImpl }, now: NOW });
    const out = await s.pr()!.summarize(input);
    expect(out).toMatchObject({ title: `${CANARY} pr` });
    await s.issue()!.summarize(input);
    const bad = gemini({ ok: false });
    const s2 = await orgSummarizers(keyed(), systemCtx(), { actor: "admin-user", gemini: { fetchImpl: bad.fetchImpl }, now: NOW });
    expect(await s2.pr()!.summarize(input)).toBeNull();

    const rows = await usage();
    const by = Object.fromEntries(rows.map((r) => [r.metric, r.count]));
    expect(by["summary:pr"]).toBe(2);
    expect(by["summary:issue"]).toBe(1);
    expect(by["summary_failed:pr"]).toBe(1);
    expect(by["summary_failed:issue"]).toBeUndefined();
    // Sizes: characters always (prompt + title + body in, the model's text out); tokens from usageMetadata.
    const sent = ok.bodies.concat(bad.bodies).map((b) => JSON.parse(b) as { system_instruction: { parts: { text: string }[] }; contents: { parts: { text: string }[] }[] });
    expect(by["summary_chars_in"]).toBe(sent.reduce((n, b) => n + b.system_instruction.parts[0].text.length + b.contents[0].parts[0].text.length, 0));
    expect(by["summary_chars_out"]).toBeGreaterThan(0);
    expect(by["summary_tokens_in"]).toBe(2 * 321);
    expect(by["summary_tokens_out"]).toBe(2 * 45);
    expect(rows.every((r) => r.actor === "admin-user" && r.day === today && r.org_id === ORG_A)).toBe(true);
    // The metering table holds metric names, an actor and numbers. No title, body or summary reaches it.
    expect(JSON.stringify(await all(env.DB, `SELECT * FROM org_usage_daily`))).not.toContain(CANARY);
    expect(JSON.stringify(await all(env.DB, `SELECT * FROM org_usage_daily`))).not.toContain(KEY);
    expect(s.allowance()).toMatchObject({ status: "on", used: 2 });
  });

  it("an answer without usageMetadata records characters and no tokens", async () => {
    const g = gemini({ tokens: false });
    const s = await orgSummarizers(keyed(), systemCtx(), { actor: "admin-user", gemini: { fetchImpl: g.fetchImpl } });
    await s.pr()!.summarize(input);
    expect(await metric("summary_chars_in")).toBeGreaterThan(0);
    expect(await metric("summary_tokens_in")).toBe(0);
    expect(await metric("summary_tokens_out")).toBe(0);
  });

  it("spends what was left when it was read and no more: the answer turns null, and a summarizer held from before attempts nothing", async () => {
    await setPlan("team", { ai_summaries: 3 });
    await seedUsed(1, today);
    const g = gemini();
    const s = await orgSummarizers(keyed(), systemCtx(), { actor: "admin-user", gemini: { fetchImpl: g.fetchImpl }, now: NOW });
    const held = s.pr()!;
    expect(await held.summarize(input)).not.toBeNull();
    expect(await s.issue()!.summarize(input)).not.toBeNull();
    expect(s.allowance()).toEqual({ status: "capped", used: 3, cap: 3, remaining: 0 });
    expect(s.pr()).toBeNull();
    expect(s.issue()).toBeNull();
    expect(await held.summarize(input)).toBeNull(); // nothing attempted
    expect(g.calls).toBe(2);
    expect(await summariesUsed(systemCtx(), NOW)).toBe(3);
    expect(await metric("summary_capped:pr")).toBe(1);
    // …and the next reader sees it used up before making any call.
    const next = await orgSummarizers(keyed(), systemCtx(), { actor: "github-webhook", gemini: { fetchImpl: g.fetchImpl }, now: NOW });
    expect(next.pr()).toBeNull();
    expect(g.calls).toBe(2);
  });

  it("overshoots only by what simultaneous readers were each allowed: one call per reader that read before the others wrote", async () => {
    await setPlan("team", { ai_summaries: 2 });
    await seedUsed(1, today);
    const g = gemini();
    // Three webhook deliveries read the allowance at the same moment: each sees 1 left and makes its one call.
    const readers = await Promise.all([1, 2, 3].map(() => orgSummarizers(keyed(), systemCtx(), { actor: "github-webhook", gemini: { fetchImpl: g.fetchImpl }, now: NOW })));
    await Promise.all(readers.map((r) => r.pr()!.summarize(input)));
    expect(g.calls).toBe(3);
    expect(await summariesUsed(systemCtx(), NOW)).toBe(4); // cap 2 + (3 readers - 1)
    // None of them can make a second call, and nobody who reads after them makes any: no runaway.
    expect(readers.map((r) => r.pr())).toEqual([null, null, null]);
    expect((await orgSummarizers(keyed(), systemCtx(), { actor: "github-webhook", gemini: { fetchImpl: g.fetchImpl }, now: NOW })).pr()).toBeNull();
    expect(g.calls).toBe(3);
  });

  it("hands metering to waitUntil when there is one, and awaits it when there is not", async () => {
    const g = gemini();
    const deferred: Promise<unknown>[] = [];
    const s = await orgSummarizers(keyed(), systemCtx(), { actor: "github-webhook", gemini: { fetchImpl: g.fetchImpl }, waitUntil: (p) => { deferred.push(p); } });
    await s.pr()!.summarize(input);
    expect(deferred.length).toBe(2); // the attempt, then its outcome
    await Promise.all(deferred);
    expect(await metric("summary:pr")).toBe(1);
    // No execution context (Sync, a job): written by the time the call returns.
    const s2 = await orgSummarizers(keyed(), systemCtx(), { actor: "admin-user", gemini: { fetchImpl: g.fetchImpl } });
    await s2.pr()!.summarize(input);
    expect(await metric("summary:pr")).toBe(2);
  });

  it("a metering write that fails never fails the summary", async () => {
    const g = gemini();
    const s = await orgSummarizers(keyed(), systemCtx(), { actor: "x".repeat(10), gemini: { fetchImpl: g.fetchImpl } });
    await run(env.DB, `ALTER TABLE org_usage_daily RENAME TO org_usage_daily_gone`);
    try {
      expect(await s.pr()!.summarize(input)).toMatchObject({ title: `${CANARY} pr` });
    } finally {
      await run(env.DB, `ALTER TABLE org_usage_daily_gone RENAME TO org_usage_daily`);
    }
  });
});

describe("the webhook path (captureDelivery)", () => {
  const hook = () => systemCtx(ORG_A, "github-webhook");
  const scope = { repo: "o/r", githubToken: async () => null };
  const deliver = (e: Env, name: string, payload: unknown, opts: Parameters<typeof captureDelivery>[5]) =>
    captureDelivery(hook(), e, scope, name, JSON.stringify(payload), opts);

  it("counts a merged pull request's and an assigned issue's summary against the org, as github-webhook, through waitUntil", async () => {
    const g = gemini();
    const deferred: Promise<unknown>[] = [];
    const opts = { gemini: { fetchImpl: g.fetchImpl }, waitUntil: (p: Promise<unknown>) => { deferred.push(p); } };
    expect((await (await deliver(keyed(), "pull_request", prMerged, opts)).json() as { captured: number }).captured).toBe(1);
    expect((await (await deliver(keyed(), "issues", issueAssigned, opts)).json() as { captured: number }).captured).toBe(1);
    await Promise.all(deferred);
    expect(g.calls).toBe(2);
    const rows = await usage();
    expect(rows.filter((r) => r.metric === "summary:pr" || r.metric === "summary:issue").map((r) => [r.metric, r.actor, r.count]))
      .toEqual([["summary:issue", "github-webhook", 1], ["summary:pr", "github-webhook", 1]]);
    expect((await first<PrSummaryRow>(env.DB, `SELECT model, title FROM pr_summaries WHERE pr_number = 42`))?.title).toBe(`${CANARY} pr`);
    // A redelivery writes no event, so it asks for no summary and counts nothing.
    await deliver(keyed(), "pull_request", prMerged, opts);
    await Promise.all(deferred);
    expect(g.calls).toBe(2);
    expect(await metric("summary:pr")).toBe(1);
  });

  it("with no execution context the count is written before the delivery returns", async () => {
    const g = gemini();
    await deliver(keyed(), "pull_request", prMerged, { gemini: { fetchImpl: g.fetchImpl } });
    expect(await metric("summary:pr")).toBe(1);
  });

  it("at the cap nothing errors: the item is stored with the excerpt fallback, nothing is attempted, and the fallback is counted", async () => {
    await setPlan("personal", { ai_summaries: 1 });
    await seedUsed(1, monthStartDay());
    const g = gemini();
    const res = await deliver(keyed(), "pull_request", prMerged, { gemini: { fetchImpl: g.fetchImpl } });
    expect(res.status).toBe(200);
    expect(g.calls).toBe(0);
    expect(await first<PrSummaryRow>(env.DB, `SELECT model, title, what FROM pr_summaries WHERE pr_number = 42`)).toEqual({ model: "excerpt", title: null, what: null });
    await deliver(keyed(), "issues", issueAssigned, { gemini: { fetchImpl: g.fetchImpl } });
    const issue = await first<IssueSummaryRow>(env.DB, `SELECT model, summary FROM issue_summaries WHERE issue_number = 17`);
    expect(issue?.model).toBe("excerpt");
    expect(issue?.summary.length).toBeGreaterThan(0); // the excerpt of its own body, exactly as without a key
    expect(g.calls).toBe(0);
    expect([await metric("summary_capped:pr"), await metric("summary_capped:issue"), await metric("summary:pr")]).toEqual([1, 1, 1]);
  });

  it("with no platform key nothing is counted, exactly as before", async () => {
    await deliver(env as unknown as Env, "pull_request", prMerged, {});
    expect((await first<PrSummaryRow>(env.DB, `SELECT model FROM pr_summaries WHERE pr_number = 42`))?.model).toBe("excerpt");
    expect(await usage()).toEqual([]);
  });
});

describe("the Sync path (runBackfill)", () => {
  const pr = (number: number) => ({
    number, title: `PR ${number}`, body: `body ${number}`, html_url: `https://github.com/o/r/pull/${number}`,
    merged_at: "2026-06-28T00:00:00Z", closed_at: "2026-06-28T00:00:00Z", updated_at: "2026-06-28T00:00:00Z", user: { login: "octocat" }, milestone: null,
  });
  const issue = {
    number: 20, title: "Fix bug", body: "Full description of the bug.", html_url: "https://github.com/o/r/issues/20", state: "open",
    updated_at: "2026-06-28T00:00:00Z", user: { login: "octocat" }, assignees: [{ login: "octocat" }], labels: ["bug"], milestone: null,
  };
  const github = (prs: unknown[], issues: unknown[]): typeof fetch => (async (url: string | URL | Request) => {
    const u = String(url);
    return new Response(JSON.stringify(u.includes("/pulls") ? prs : u.includes("/issues") ? issues : []), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const models = async () => (await all<PrSummaryRow>(env.DB, `SELECT pr_number, model FROM pr_summaries ORDER BY pr_number`)).map((r) => r.model);

  it("counts each attempt against the admin who pressed Sync — with no execution context", async () => {
    const g = gemini();
    const res = await runBackfill(keyed(), "admin-user", { fetchImpl: github([pr(1), pr(2)], [issue]), gemini: { fetchImpl: g.fetchImpl }, summaryCallDelayMs: 0 });
    expect(res).toMatchObject({ ok: true, summarized: 3, summariesWritten: 3, summariesFailed: 0, summariesSkipped: 0, summariesPending: 0 });
    expect(g.calls).toBe(3);
    const rows = (await usage()).filter((r) => r.metric.startsWith("summary:"));
    expect(rows.map((r) => [r.metric, r.actor, r.count])).toEqual([["summary:issue", "admin-user", 1], ["summary:pr", "admin-user", 2]]);
    expect(res.allowance).toMatchObject({ status: "on", used: 3, cap: null });
  });

  it("a failed call is counted as attempted and failed, the item keeps its excerpt, and the next Sync tries again", async () => {
    const bad = gemini({ ok: false });
    const one = await runBackfill(keyed(), "admin-user", { fetchImpl: github([pr(1)], []), gemini: { fetchImpl: bad.fetchImpl }, summaryCallDelayMs: 0 });
    expect(one).toMatchObject({ summarized: 1, summariesWritten: 0, summariesFailed: 1, summariesPending: 1 });
    expect(await models()).toEqual(["excerpt"]);
    const ok = gemini();
    const two = await runBackfill(keyed(), "admin-user", { fetchImpl: github([pr(1)], []), gemini: { fetchImpl: ok.fetchImpl }, summaryCallDelayMs: 0 });
    expect(two).toMatchObject({ summariesWritten: 1, summariesPending: 0 });
    expect([await metric("summary:pr"), await metric("summary_failed:pr")]).toEqual([2, 1]);
  });

  it("reaching the cap mid-batch: what is left is summarized, the rest get their excerpt once, and the run ends", async () => {
    await setPlan("personal", { ai_summaries: 2 });
    const g = gemini();
    const fetchImpl = github([pr(1), pr(2), pr(3), pr(4)], []);
    const one = await runBackfill(keyed(), "admin-user", { fetchImpl, gemini: { fetchImpl: g.fetchImpl }, summaryCallDelayMs: 0 });
    expect(one).toMatchObject({ ok: true, summarized: 2, summariesWritten: 2, summariesSkipped: 2, summariesPending: 2, summaryBudgetExhausted: false });
    expect(one.allowance).toEqual({ status: "capped", used: 2, cap: 2, remaining: 0 });
    expect(await models()).toEqual([expect.not.stringMatching("excerpt"), expect.not.stringMatching("excerpt"), "excerpt", "excerpt"]);
    expect(g.calls).toBe(2);
    expect(await metric("summary_capped:pr")).toBe(2);

    // Another Sync in the same month: nothing is attempted, nothing is rewritten, nothing is counted twice.
    const stamps = await all<PrSummaryRow>(env.DB, `SELECT pr_number, created_at FROM pr_summaries ORDER BY pr_number`);
    const two = await runBackfill(keyed(), "admin-user", { fetchImpl, gemini: { fetchImpl: g.fetchImpl }, summaryCallDelayMs: 0 });
    expect(two).toMatchObject({ ok: true, summarized: 0, summariesSkipped: 0, summariesPending: 2, summaryBudgetExhausted: false });
    expect(g.calls).toBe(2);
    expect(await metric("summary_capped:pr")).toBe(2);
    expect(await all<PrSummaryRow>(env.DB, `SELECT pr_number, created_at FROM pr_summaries ORDER BY pr_number`)).toEqual(stamps);

    // Once allowed again — the cap raised here; a new month does the same — a Sync fills the excerpts in.
    await setPlan("personal", { ai_summaries: 10 });
    const three = await runBackfill(keyed(), "admin-user", { fetchImpl, gemini: { fetchImpl: g.fetchImpl }, summaryCallDelayMs: 0 });
    expect(three).toMatchObject({ summariesWritten: 2, summariesPending: 0 });
    expect((await models()).includes("excerpt")).toBe(false);
    expect(await summariesUsed(systemCtx())).toBe(4);
  });

  it("a new month refills excerpts left at the cap, bounded by the batch — never the whole backlog in one batch", async () => {
    await setPlan("personal", { ai_summaries: 1 });
    const g = gemini();
    const prs = Array.from({ length: 9 }, (_, i) => pr(i + 1));
    const sept = new Date("2026-09-30T22:00:00.000Z");
    const a = await runBackfill(keyed(), "admin-user", { fetchImpl: github(prs, []), gemini: { fetchImpl: g.fetchImpl }, summaryCallDelayMs: 0, now: sept });
    expect(a).toMatchObject({ summariesWritten: 1, summariesSkipped: 8, summaryBudgetExhausted: false });
    // October, with a larger allowance: one batch attempts its five, and says more are waiting.
    await setPlan("personal", { ai_summaries: 100 });
    const oct = new Date("2026-10-01T00:05:00.000Z");
    const b = await runBackfill(keyed(), "admin-user", { fetchImpl: github(prs, []), gemini: { fetchImpl: g.fetchImpl }, summaryCallDelayMs: 0, now: oct });
    expect(b).toMatchObject({ summarized: 5, summariesWritten: 5, summariesPending: 3, summaryBudgetExhausted: true });
    expect(b.allowance).toMatchObject({ status: "on", used: 5, cap: 100, remaining: 95 });
  });

  it("an ended plan summarizes nothing; no platform key counts nothing", async () => {
    await setPlan("team", {}, "canceled");
    const g = gemini();
    const res = await runBackfill(keyed(), "admin-user", { fetchImpl: github([pr(1)], []), gemini: { fetchImpl: g.fetchImpl }, summaryCallDelayMs: 0 });
    expect(res).toMatchObject({ ok: true, summarized: 0, summariesSkipped: 1 });
    expect(res.allowance?.status).toBe("ended");
    expect(g.calls).toBe(0);
    await run(env.DB, `DELETE FROM org_usage_daily`);
    await run(env.DB, `DELETE FROM pr_summaries`);
    const off = await runBackfill({ ...keyed(), GEMINI_API_KEY: "" }, "admin-user", { fetchImpl: github([pr(1)], []), summaryCallDelayMs: 0 });
    expect(off).toMatchObject({ ok: true, summarized: 0, summariesSkipped: 1 });
    expect(off.allowance?.status).toBe("off");
    expect(await usage()).toEqual([]);
  });
});

describe("Platform › Usage reads the summary counters per org", () => {
  it("attempted / succeeded / fell back for the window and the month against the cap, for two orgs with no bleed", async () => {
    await setPlan("team", { ai_summaries: 40 });
    await setPlan("personal", {}, "active", ORG_B);
    const now = new Date("2026-10-07T12:00:00.000Z");
    const put = (orgId: string, day: string, name: string, n: number, actor = "github-webhook") => seedUsed(n, day, orgId, name).then(() =>
      run(env.DB, `UPDATE org_usage_daily SET actor = ? WHERE org_id = ? AND day = ? AND metric = ? AND actor = 'seed'`, actor, orgId, day, name));
    // A: 10 attempts in October (3 failed), 2 capped, and 30 attempts on Sept 30 — in the 30-day window, not the month.
    await put(ORG_A, "2026-10-02", "summary:pr", 7);
    await put(ORG_A, "2026-10-03", "summary:issue", 3);
    await put(ORG_A, "2026-10-03", "summary_failed:pr", 3);
    await put(ORG_A, "2026-10-03", "summary_capped:pr", 2);
    await put(ORG_A, "2026-10-03", "summary_chars_in", 12000);
    await put(ORG_A, "2026-10-03", "summary_chars_out", 2400);
    await put(ORG_A, "2026-10-03", "summary_tokens_in", 3100);
    await put(ORG_A, "2026-10-03", "summary_tokens_out", 610);
    await put(ORG_A, "2026-09-30", "summary:pr", 30);
    // B: 4 attempts, all good.
    await put(ORG_B, "2026-10-05", "summary:pr", 4, "boss");
    await put(ORG_B, "2026-10-05", "summary_chars_in", 900, "boss");

    const res = await platformUsage(platformCtx(), 30, now, { summariesEnabled: true });
    const a = res.orgs.find((o) => o.slug === "saplinglearn")!;
    const b = res.orgs.find((o) => o.slug === "acme")!;
    expect(a.summaries).toEqual({ attempted: 40, succeeded: 37, failed: 3, capped: 2, fell_back: 5, chars_in: 12000, chars_out: 2400, tokens_in: 3100, tokens_out: 610, month_used: 10, cap: 40 });
    expect(b.summaries).toEqual({ attempted: 4, succeeded: 4, failed: 0, capped: 0, fell_back: 0, chars_in: 900, chars_out: 0, tokens_in: 0, tokens_out: 0, month_used: 4, cap: 300 });
    expect(res.summaries).toEqual({ attempted: 44, succeeded: 41, failed: 3, capped: 2, fell_back: 5, chars_in: 12900, chars_out: 2400, tokens_in: 3100, tokens_out: 610 });
    expect(res.summaries_enabled).toBe(true);
    // The platform's own calls are not a person's requests: no active people, no "last activity", no API counts.
    expect([a.activity.active_people, b.activity.active_people, res.totals.activity.active_people]).toEqual([0, 0, 0]);
    expect([a.last_activity_at, a.activity.api_requests, a.activity.mcp_tool_calls]).toEqual([null, 0, 0]);
    expect((await platformUsage(platformCtx(), 30, now)).summaries_enabled).toBe(false);
  });
});
