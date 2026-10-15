// The org's AI switch (`orgs.ai_automation`, Org settings › AI) covers the capture-time summaries of pull
// requests and issues (docs/architecture/ai.md › Eligibility, the allowance and the switch). Off: the webhook
// and Sync make NO summarizer call and write NOTHING — no summary row (not even the excerpt marker), no meter —
// and a summary already written stays readable exactly as it was. On: exactly as before.
// The model call is the dependency-injected summarizer's fetch, stubbed at the Response level — never the network.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import type { PrSummaryRow, IssueSummaryRow } from "@shared/rows";
import { syncLeftoverText, syncSummariesText } from "@shared/sync";
import { all, first, run } from "./helpers/db";
import { ORG_A, systemCtx } from "./helpers/tenant";
import { runBackfill } from "./helpers/org-config";
import { orgSummarizers, summaryAllowance } from "../src/plans/summaries";
import { captureDelivery } from "../src/webhook";
import prMerged from "./fixtures/gh-pr-merged.json";
import issueAssigned from "./fixtures/gh-issue-assigned.json";
import { FAKE_ANTHROPIC_KEY, messageResponse } from "./helpers/anthropic";

const keyed = (): Env => ({ ...(env as unknown as Env), ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, GITHUB_SERVICE_TOKEN: "svc-token", GITHUB_REPO: "o/r" });
const setSwitch = (on: boolean) => run(env.DB, `UPDATE orgs SET ai_automation = ? WHERE id = ?`, on ? 1 : 0, ORG_A);

/** A Messages API stand-in that counts every call made through the org's summarizer. */
function claude(): { fetchImpl: typeof fetch; calls: number } {
  const g = {
    calls: 0,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      g.calls++;
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
      const isIssue = String(init?.body ?? "").includes("personal to-do list");
      return messageResponse(JSON.stringify(isIssue
        ? { title: "AI issue", summary: "AI summary", next_step: null }
        : { title: "AI pr", what: "AI what", why: null, impact: null }));
    }) as unknown as typeof fetch,
  };
  return g;
}

const usage = () => all<{ metric: string; count: number }>(env.DB, `SELECT metric, count FROM org_usage_daily WHERE org_id = ? AND metric GLOB 'summary*'`, ORG_A);
const prRows = () => all<PrSummaryRow>(env.DB, `SELECT pr_number, model, title, what FROM pr_summaries WHERE org_id = ? ORDER BY pr_number`, ORG_A);
const issueRows = () => all<IssueSummaryRow>(env.DB, `SELECT issue_number, model, summary, title FROM issue_summaries WHERE org_id = ? ORDER BY issue_number`, ORG_A);

describe("the summaries' allowance reads the org's AI switch", () => {
  it("off is `disabled` — whatever the allowance says — with this month's use still shown; on is `on`", async () => {
    await setSwitch(false);
    expect(await summaryAllowance(keyed(), systemCtx())).toMatchObject({ status: "disabled", used: 0 });
    const s = await orgSummarizers(keyed(), systemCtx(), { actor: "github-webhook", ai: { fetchImpl: claude().fetchImpl } });
    expect([s.pr(), s.issue(), s.switchedOff()]).toEqual([null, null, true]);
    await s.skipped("pr"); // nothing counted while off
    expect(await usage()).toEqual([]);
    await setSwitch(true);
    expect((await summaryAllowance(keyed(), systemCtx())).status).toBe("on");
    expect((await orgSummarizers(keyed(), systemCtx(), { actor: "github-webhook" })).switchedOff()).toBe(false);
  });

  it("the Sync panel says the switch is what stops them", () => {
    const view = { status: "disabled" as const, used: 3, cap: 300, remaining: 297, pending: 2, per_run: 50 };
    expect(syncSummariesText(view)).toBe("This organization's AI switch is off (Org settings › AI), so nothing new is summarized.");
    expect(syncLeftoverText({ summaries_pending: 2 }, view)).toContain("AI switch is off");
  });
});

describe("the webhook path (captureDelivery)", () => {
  const scope = { repo: "o/r", githubToken: async () => null };
  const deliver = (name: string, payload: unknown, g: { fetchImpl: typeof fetch }) =>
    captureDelivery(systemCtx(ORG_A, "github-webhook"), keyed(), scope, name, JSON.stringify(payload), { ai: { fetchImpl: g.fetchImpl } });

  it("switch off: a merged pull request and an assigned issue are captured, with zero summarizer calls and nothing written", async () => {
    await setSwitch(false);
    const g = claude();
    expect((await (await deliver("pull_request", prMerged, g)).json() as { captured: number }).captured).toBe(1);
    expect((await (await deliver("issues", issueAssigned, g)).json() as { captured: number }).captured).toBe(1);
    expect(g.calls).toBe(0);
    expect(await prRows()).toEqual([]);
    expect(await issueRows()).toEqual([]);
    expect(await usage()).toEqual([]);
  });

  it("switch off: a summary already written stays exactly as it was (a write gate, not a hide)", async () => {
    // Summarized while on…
    await setSwitch(true);
    const on = claude();
    await deliver("pull_request", prMerged, on);
    await deliver("issues", issueAssigned, on);
    expect(on.calls).toBe(2);
    const before = [await prRows(), await issueRows()];
    expect(before.map((rows) => rows.map((r) => r.title))).toEqual([["AI pr"], ["AI issue"]]);
    // …then the switch goes off and the issue is assigned again: a NEW event, which would have
    // replaced its summary with an excerpt. Nothing is called and nothing is replaced.
    await setSwitch(false);
    const off = claude();
    const reassigned = { ...issueAssigned, issue: { ...issueAssigned.issue, updated_at: "2026-10-02T09:00:00Z" } };
    expect((await (await deliver("issues", reassigned, off)).json() as { captured: number }).captured).toBe(1);
    expect(off.calls).toBe(0);
    expect([await prRows(), await issueRows()]).toEqual(before);
  });

  it("switch on: exactly as before — one call each, the summaries written and counted", async () => {
    await setSwitch(true);
    const g = claude();
    await deliver("pull_request", prMerged, g);
    await deliver("issues", issueAssigned, g);
    expect(g.calls).toBe(2);
    expect((await prRows()).map((r) => [r.pr_number, r.title])).toEqual([[42, "AI pr"]]);
    expect((await issueRows()).map((r) => [r.issue_number, r.title])).toEqual([[17, "AI issue"]]);
    expect(Object.fromEntries((await usage()).map((r) => [r.metric, r.count]))).toMatchObject({ "summary:pr": 1, "summary:issue": 1 });
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
  const github = (): typeof fetch => (async (url: string | URL | Request) => {
    const u = String(url);
    return new Response(JSON.stringify(u.includes("/pulls") ? [pr(1), pr(2)] : u.includes("/issues") ? [issue] : []), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  it("switch off: zero summarizer calls, no summary row, no meter — the items wait, and the batch says why", async () => {
    await setSwitch(false);
    const g = claude();
    const res = await runBackfill(keyed(), "admin-user", { fetchImpl: github(), ai: { fetchImpl: g.fetchImpl }, summaryCallDelayMs: 0 });
    expect(res).toMatchObject({ ok: true, summarized: 0, summariesWritten: 0, summariesSkipped: 0, summariesPending: 3, summaryBudgetExhausted: false });
    expect(res.allowance?.status).toBe("disabled");
    expect(g.calls).toBe(0);
    expect(await prRows()).toEqual([]);
    expect(await issueRows()).toEqual([]);
    expect(await usage()).toEqual([]);
    // Turned back on, the next Sync summarizes all of them.
    await setSwitch(true);
    const again = await runBackfill(keyed(), "admin-user", { fetchImpl: github(), ai: { fetchImpl: g.fetchImpl }, summaryCallDelayMs: 0 });
    expect(again).toMatchObject({ summariesWritten: 3, summariesPending: 0 });
    expect(g.calls).toBe(3);
  });

  it("switch on: exactly as before", async () => {
    await setSwitch(true);
    const g = claude();
    const res = await runBackfill(keyed(), "admin-user", { fetchImpl: github(), ai: { fetchImpl: g.fetchImpl }, summaryCallDelayMs: 0 });
    expect(res).toMatchObject({ ok: true, summarized: 3, summariesWritten: 3, summariesPending: 0 });
    expect(res.allowance?.status).toBe("on");
    expect(g.calls).toBe(3);
  });
});
