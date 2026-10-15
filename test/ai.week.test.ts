// THE WEEKLY HIGHLIGHTS (`digest.week`, Phase E; src/ai/week.ts): the weekly e-mail's "This week", through the REAL
// router, pass, Batch API path and store, with Anthropic stubbed and COUNTED at the `Response` level. Real D1 rows,
// written by the real writers. Proves: the pre-warm marks ONE scope per org a few hours before the weekly send; the
// pass submits it through the Message Batches API (no direct call), metered once; cites and numbers are checked by the
// server; a second mark of the same week makes NO second request; the e-mail then reads what was stored, through the
// real renderer — and with the org's AI switch off it shows no highlights, only the server's numbers line.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { runAiPass, type AiJob } from "../src/ai/pass";
import { weekJob, buildWeekInput } from "../src/ai/week";
import { newBudget, CRON_SUBREQUEST_BUDGET } from "../src/repo/dispatch";
import { routeAi } from "../src/tools/ai-route";
import { prewarmDigests, WEEK_HIGHLIGHTS_LEAD_MS } from "../src/notifications/cron";
import { computeWindow } from "../src/notifications/window";
import { runDigest } from "../src/notifications/run";
import { localDelivery } from "../src/notifications/delivery";
import { seedNotificationPolicy } from "../src/notifications/policy";
import { ingestEvent } from "../src/consumer";
import { storePrSummary, type PrSummary, type Summarizer } from "../src/tools/summarize";
import { create_ticket, transition_ticket } from "../src/tools/tickets";
import { weekScopeKey } from "@shared/ai-core";
import { TicketCreate } from "@shared/tickets";
import type { CapturedEvent } from "@shared/contract";
import { all, first, run } from "./helpers/db";
import { ORG_A, ORG_B, platformCtx, systemCtx } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";
import { keyedEnv, markRow, stubProviders, succeededLine, type Stub } from "./helpers/ai-pass";

const REPO = "SaplingLearn/sapling";
const TZ = "America/New_York";
/** Monday 2026-09-14, 08:00 in New York: SaplingLearn's weekly send. Its window is the 7 days before. */
const SEND = new Date("2026-09-14T12:00:00.000Z");
const WEEK_ID = computeWindow("weekly", SEND, TZ).id; // 2026-W38
const KEY = weekScopeKey(WEEK_ID, SEND);
const HOUR = 3600_000;

const pass = (s: Stub, now: Date, jobs: readonly AiJob[] = [weekJob]) =>
  runAiPass(keyedEnv(), newBudget(s.fetchImpl, CRON_SUBREQUEST_BUDGET), { jobs, now });
const count = async (sql: string, ...p: unknown[]) => (await first<{ n: number }>(env.DB, sql, ...p))!.n;

const prEvent = (n: number, at: string, title: string): CapturedEvent => ({
  semantic_key: `gh:pr:${n}:merged`, event_type: "pr_merged", ref_number: n, subject_login: "AndresL230",
  raw: JSON.stringify({ pr: { number: n, title, body: "b", html_url: `https://github.com/${REPO}/pull/${n}`, merged: true, merged_at: at, user: { login: "AndresL230" }, base: { ref: "main" } } }),
  provenance: "webhook", occurred_at: at,
});
const summarizer = (s: PrSummary): Summarizer<PrSummary> => ({ model: "stub", summarize: async () => s });

/** SaplingLearn's week, through the real writers: two merged PRs (one Sift rated breaking), a notable session note,
 *  a ticket a person marked done. Returns the note's feed id. */
async function seedWeek(): Promise<number> {
  const ctx = systemCtx(ORG_A);
  await addOrgRepo(REPO, ORG_A);
  for (const [n, at, title, importance] of [[301, "2026-09-10T15:00:00Z", "Repository setups", "breaking"], [302, "2026-09-11T15:00:00Z", "Fix the sidebar flicker", "routine"]] as const) {
    await ingestEvent(ctx, platformCtx(), prEvent(n, at, title), "github-webhook");
    await storePrSummary(ctx, summarizer({ title, what: `${title}: what changed.`, why: "y", impact: "i" }), { semantic_key: `gh:pr:${n}:merged`, pr_number: n, title, body: "b" });
    await run(env.DB, `UPDATE pr_summaries SET importance = ? WHERE semantic_key = ?`, importance, `gh:pr:${n}:merged`);
  }
  await run(env.DB, `INSERT INTO feed (org_id, author, summary, brief, artifacts, created_at, importance) VALUES (?, 'AndresL230', 'Hosting deploys now poll every hour', 'The :40 job reads each provider.', '{}', '2026-09-12T10:00:00Z', 'notable')`, ORG_A);
  const feedId = (await first<{ id: number }>(env.DB, `SELECT MAX(id) AS id FROM feed WHERE org_id = ?`, ORG_A))!.id;
  const t = await create_ticket(ctx, TicketCreate.parse({ title: "Provider connection card", assignees: ["AndresL230"] }), "AndresL230");
  await transition_ticket(ctx, t, "in_progress", "AndresL230");
  await transition_ticket(ctx, t, "done", "AndresL230");
  await run(env.DB, `UPDATE ticket_events SET created_at = '2026-09-12T16:00:00Z' WHERE org_id = ?`, ORG_A);
  // The pass's own work on these writes (Sift, cards) is not under test: start from a clean queue.
  await run(env.DB, `DELETE FROM ai_dirty`);
  return feedId;
}

const answer = (feedId: number) => JSON.stringify({ highlights: [
  { text: "Repository setups shipped, and every repository now names its environments.", cites: ["pr:301", "pr:99999"] }, // one invented cite: dropped, the line kept
  { text: "Hosting deploys are now polled every hour.", cites: [`feed:${feedId}`] },
  { text: "The team fixed 42 bugs this week.", cites: ["pr:302"] }, // a number the input does not have: dropped
  { text: "Something nobody did.", cites: ["ticket:777"] }, // no valid cite: dropped
] });

describe("digest.week — the pre-warm marks it once per org, hours before the weekly send", () => {
  it("Monday 08:50 UTC (3h10 before the 12:00 UTC send): ONE digest scope for the org, keyed by its week and send instant; never on another day, never with This week off", async () => {
    await run(env.DB, `UPDATE persons SET email = handle || '@example.test'`);
    const tick = new Date(SEND.getTime() - WEEK_HIGHLIGHTS_LEAD_MS - 10 * 60_000); // the :50 tick
    expect(tick.toISOString()).toBe("2026-09-14T08:50:00.000Z");
    await prewarmDigests(env as unknown as Env, tick);
    expect(await all(env.DB, `SELECT org_id, scope_key FROM ai_dirty WHERE scope = 'digest'`)).toEqual([{ org_id: ORG_A, scope_key: KEY }]);
    await run(env.DB, `DELETE FROM ai_dirty`);
    // Wednesday at the same time: no weekly send three hours on.
    await prewarmDigests(env as unknown as Env, new Date("2026-09-16T08:50:00.000Z"));
    expect(await count(`SELECT COUNT(*) AS n FROM ai_dirty WHERE scope = 'digest'`)).toBe(0);
    // The org turned "This week" off: nothing is marked.
    await seedNotificationPolicy(systemCtx(ORG_A));
    await run(env.DB, `UPDATE notification_policy SET enabled = 0 WHERE org_id = ? AND kind = 'week_recap'`, ORG_A);
    await prewarmDigests(env as unknown as Env, tick);
    expect(await count(`SELECT COUNT(*) AS n FROM ai_dirty WHERE scope = 'digest'`)).toBe(0);
  });

  it("an org with the AI switch off is marked nothing (the router's own guard)", async () => {
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_B);
    await routeAi(systemCtx(ORG_B), { type: "digest_week", key: KEY });
    expect(await count(`SELECT COUNT(*) AS n FROM ai_dirty WHERE org_id = ?`, ORG_B)).toBe(0);
  });
});

describe("digest.week — one Batch API request per org per week, its cites checked, then the weekly e-mail", () => {
  it("submits ONE batch request (no direct call, one run metered), writes only valid highlights, and a second mark of the week makes no new request", async () => {
    const feedId = await seedWeek();
    await run(env.DB, `UPDATE orgs SET ai_automation = 1 WHERE id IN (?, ?)`, ORG_A, ORG_B);
    await routeAi(systemCtx(ORG_A), { type: "digest_week", key: KEY });
    await routeAi(systemCtx(ORG_B), { type: "digest_week", key: KEY }); // ORG_B's week is empty: no request at all
    const s = stubProviders();
    // The pass runs on the real clock (the router marked on it); the week it reads is the one in the key.
    const submitAt = new Date(Date.now() + 60_000);

    const r1 = await pass(s, submitAt);
    expect([r1.batched, s.batchCreates, s.haiku]).toEqual([1, 1, 0]);
    const req = s.batchBodies[0].requests;
    expect(req).toHaveLength(1);
    const prompt = JSON.stringify(req[0].params);
    expect(prompt).toContain("pr:301");
    expect(prompt).toContain("[breaking]");
    expect(prompt).toContain(`feed:${feedId}`);
    expect(prompt).toContain("ticket:1");
    expect(await count(`SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE org_id = ? AND metric = 'ai_run:digest.week'`, ORG_A)).toBe(1);
    expect(await count(`SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE org_id = ? AND metric LIKE 'ai_run:%'`, ORG_B)).toBe(0);

    // The same week marked again before the answer is back (a re-run of the pre-warm): still ONE request.
    // (a mark AFTER the hold, as a re-run of the pre-warm would make it — the router stamps the real clock, so the
    // fixture writes the row at the pass's clock)
    await markRow(ORG_A, "digest", KEY, new Date(submitAt.getTime() + 5 * 60_000).toISOString());
    const r2 = await pass(s, new Date(submitAt.getTime() + 10 * 60_000));
    expect(s.batchCreates).toBe(1);
    expect(r2.batched).toBe(0);

    const reqs = await all<{ request_id: string }>(env.DB, `SELECT request_id FROM ai_batch_requests`);
    expect(reqs).toHaveLength(1);
    s.batch.ended = true;
    s.batch.results = reqs.map((q) => succeededLine(q.request_id, answer(feedId)));
    const r3 = await pass(s, new Date(submitAt.getTime() + HOUR));
    expect(r3.collected).toBe(1);

    const row = (await first<{ week_id: string; prompt_version: string; highlights_json: string }>(env.DB, `SELECT week_id, prompt_version, highlights_json FROM digest_highlights WHERE org_id = ?`, ORG_A))!;
    expect(row.week_id).toBe(WEEK_ID);
    expect(JSON.parse(row.highlights_json)).toEqual([
      { text: "Repository setups shipped, and every repository now names its environments.", cites: [{ ref: "pr:301", label: "#301", href: `https://github.com/${REPO}/pull/301` }] },
      { text: "Hosting deploys are now polled every hour.", cites: [{ ref: `feed:${feedId}`, label: "Hosting deploys now poll every hour", href: "#feed" }] },
    ]);
    expect(await count(`SELECT COUNT(*) AS n FROM digest_highlights WHERE org_id = ?`, ORG_B)).toBe(0);

    // A week that has its highlights: marked again, it reads null — no request, ever.
    await markRow(ORG_A, "digest", KEY, new Date(submitAt.getTime() + 90 * 60_000).toISOString());
    await pass(s, new Date(submitAt.getTime() + 2 * HOUR));
    expect([s.batchCreates, s.haiku]).toEqual([1, 0]);

    // THE WEEKLY E-MAIL, through the real renderers and reads: the brief, This week (the stored highlights with their
    // cites linked), the server's numbers line.
    await run(env.DB, `UPDATE persons SET email = 'andres@example.com', email_unsubscribed = 0 WHERE handle = 'AndresL230'`);
    await run(env.DB, `UPDATE persons SET email = NULL WHERE handle != 'AndresL230'`);
    await runDigest(systemCtx(ORG_A), platformCtx(), "weekly", SEND, { delivery: localDelivery(systemCtx(ORG_A)), origin: "https://trov.dev" });
    const [body] = await all<{ subject: string; html: string; text: string }>(env.DB, `SELECT subject, html, text FROM notification_outbox_bodies`);
    expect(body.subject).toBe("Trov weekly, Sep 7 to 11");
    expect(body.html).toContain("This week");
    expect(body.html).toContain("Repository setups shipped, and every repository now names its environments.");
    expect(body.html).toContain(`href="https://github.com/${REPO}/pull/301"`);
    expect(body.html).toContain('href="https://trov.dev/#feed"'); // an in-app cite hangs off the org's address
    expect(body.html).not.toContain("42 bugs");
    expect(body.text).toContain("2 pull requests merged, 1 ticket done, 1 entry in the Feed");
    expect(body.html.indexOf("Your brief")).toBeLessThan(body.html.indexOf("This week")); // the brief leads
  });

  it("with the AI switch OFF the weekly e-mail shows no highlights — only the server's numbers line", async () => {
    await seedWeek();
    await run(env.DB, `INSERT INTO digest_highlights (org_id, week_id, generated_at, model, prompt_version, highlights_json) VALUES (?, ?, 'x', 'm', 'week.1', ?)`,
      ORG_A, WEEK_ID, JSON.stringify([{ text: "Stored before the switch went off.", cites: [{ ref: "pr:301", label: "#301", href: null }] }]));
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
    await run(env.DB, `UPDATE persons SET email = 'andres@example.com', email_unsubscribed = 0 WHERE handle = 'AndresL230'`);
    await run(env.DB, `UPDATE persons SET email = NULL WHERE handle != 'AndresL230'`);
    await runDigest(systemCtx(ORG_A), platformCtx(), "weekly", SEND, { delivery: localDelivery(systemCtx(ORG_A)) });
    const [body] = await all<{ html: string; text: string }>(env.DB, `SELECT html, text FROM notification_outbox_bodies`);
    expect(body.html).toContain("This week");
    expect(body.html).not.toContain("data-week-highlights");
    expect(body.html).not.toContain("Stored before the switch went off.");
    expect(body.text).toContain("2 pull requests merged, 1 ticket done, 1 entry in the Feed");
  });

  it("the input is the org's own week only, in the server's order (breaking first), read up to the send", async () => {
    const feedId = await seedWeek();
    const w = await buildWeekInput(systemCtx(ORG_A), WEEK_ID, SEND, SEND);
    expect(w.items.map((i) => i.ref)).toEqual(["pr:301", `feed:${feedId}`, "ticket:1", "pr:302"]);
    expect(w.from).toBe("2026-09-07");
    expect(w.to).toBe("2026-09-14");
    expect((await buildWeekInput(systemCtx(ORG_B), WEEK_ID, SEND, SEND)).items).toEqual([]);
  });
});
