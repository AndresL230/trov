// THE BRIEF (src/ai/brief.ts, src/data/person-brief.ts, src/tools/mywork.ts `storedBrief`; docs/architecture/ai.md ›
// The brief): the `brief.person` job over REAL D1 rows (a primary repo with an open PR and a failing run, a merged PR
// card, session notes, tickets in an overdue and a due-soon sprint, a handoff), Anthropic stubbed at the `Response`
// level. The guards: Next is ONLY offered items, in the SERVER's order, with their own titles; cites must be in the
// input; numbers must be the input's; a refusal or `max_tokens` writes nothing; only for people who opened My Work in
// 14 days or receive the digest; 5 versions kept; the org switch; "Wrong?"; capped; field absent when none.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { runAiPass } from "../src/ai/pass";
import { briefJob, buildBriefInput, briefPromptInput, briefFromAnswer, numbersGrounded, orderNext, type NextOffer } from "../src/ai/brief";
import { BRIEF_LINE_MAX, BRIEF_NEXT_MAX, BRIEF_WHY_MAX, oneSentence, pickNext, shortDay } from "../src/ai/brief-core";
import { newBudget } from "../src/repo/dispatch";
import { briefVersions, latestBrief, markMyWorkOpened, storeBrief, BRIEF_VERSIONS_KEPT } from "../src/data/person-brief";
import { getMyWork, storedBrief } from "../src/tools/mywork";
import { recordFeedback } from "../src/data/ai";
import { AI_STALE_DAYS, aiItemRef } from "@shared/ai";
import { first, run } from "./helpers/db";
import { ORG_A, systemCtx } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";
import { cookieFor } from "./helpers/persons";
import { app } from "../src/routes";
import { buildSeedStatements } from "../scripts/seed/build.mjs";
import { briefDevStatements } from "../scripts/seed/brief-dev.mjs";
import tickets from "../fixtures/dev/tickets.json";
import handoffs from "../fixtures/dev/handoffs.json";
import roadmap from "../fixtures/dev/roadmap.json";
import { dirtyRow, keyedEnv, markRow, stubProviders, type ClaudeReply, type Stub } from "./helpers/ai-pass";
import { useAiKey } from "./helpers/ai-key";

// THE read rule (src/plans/gate.ts `aiShown`): no Anthropic key reads like the switch off, so these tests hold a fake one.
useAiKey();

const REPO = "AndresL230/trov";
const ME = "AndresL230";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const dayOf = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString().slice(0, 10);
const ctx = () => systemCtx(ORG_A);

/** One pass of the real brief job, one tick after the person's scope went stale (SaplingLearn is Enterprise: 30 min). */
async function briefPass(s: Stub, o: { env?: Env } = {}): Promise<void> {
  await runAiPass(o.env ?? keyedEnv(), newBudget(s.fetchImpl), { jobs: [briefJob], now: new Date(Date.now() + 31 * MIN) });
}
const markMe = (handle = ME) => markRow(ORG_A, "person", handle, iso(0));
const count = async (sql: string, ...p: unknown[]) => (await first<{ n: number }>(env.DB, sql, ...p))!.n;

/** The person's world: everything a brief is written from. */
async function seedWorld(): Promise<void> {
  await addOrgRepo(REPO, ORG_A);
  // An open PR (#12) on feat/hosting, its run failing and a check red; an older run of another workflow passing.
  await run(env.DB, `INSERT INTO repo_events (org_id, repo, semantic_key, kind, ref, sha, number, state, actor_login, title, url, raw, provenance, occurred_at, recorded_at)
    VALUES (?, ?, 'gh:prs:12:opened', 'pr', 'feat/hosting', 'sha12', 12, 'review', ?, 'Hosting screens', 'https://github.com/AndresL230/trov/pull/12', '{}', 'webhook', ?, ?)`, ORG_A, REPO, ME, iso(3 * 60 * MIN), iso(0));
  await run(env.DB, `INSERT INTO repo_events (org_id, repo, semantic_key, kind, ref, sha, number, state, name, title, actor_login, url, raw, provenance, occurred_at, recorded_at)
    VALUES (?, ?, 'gh:run:4812:1', 'run', 'feat/hosting', 'sha12', 4812, 'failure', 'CI', 'Netlify connect test', ?, 'https://github.com/AndresL230/trov/actions/runs/4812', '{}', 'webhook', ?, ?)`, ORG_A, REPO, ME, iso(2 * 60 * MIN), iso(0));
  await run(env.DB, `INSERT INTO repo_events (org_id, repo, semantic_key, kind, ref, sha, number, state, name, url, raw, provenance, occurred_at, recorded_at)
    VALUES (?, ?, 'gh:check:77:completed', 'check', 'feat/hosting', 'sha12', 77, 'failure', 'lint', NULL, '{}', 'webhook', ?, ?)`, ORG_A, REPO, iso(2 * 60 * MIN), iso(0));
  // Someone else's open PR: never theirs.
  await run(env.DB, `INSERT INTO repo_events (org_id, repo, semantic_key, kind, ref, sha, number, state, actor_login, title, url, raw, provenance, occurred_at, recorded_at)
    VALUES (?, ?, 'gh:prs:13:opened', 'pr', 'feat/other', 'sha13', 13, 'review', 'Jose-Gael-Cruz-Lopez', 'Other work', NULL, '{}', 'webhook', ?, ?)`, ORG_A, REPO, iso(60 * MIN), iso(0));
  // A PR merged 2 days ago, with its card.
  await run(env.DB, `INSERT INTO events (org_id, repo, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
    VALUES (?, ?, 'gh:pr:11:merged', 'pr_merged', 11, ?, ?, 'webhook', ?, ?, 'test')`, ORG_A, REPO, ME,
    JSON.stringify({ pr: { number: 11, title: "Status marks everywhere", body: "RAW BODY NEVER SENT", html_url: "https://github.com/AndresL230/trov/pull/11", merged: true } }), iso(2 * DAY), iso(2 * DAY));
  await run(env.DB, `INSERT INTO pr_summaries (org_id, repo, semantic_key, pr_number, model, created_at, title, what, why, impact)
    VALUES (?, ?, 'gh:pr:11:merged', 11, 'claude-haiku-5-5', ?, 'Status marks replace status tags', 'States read the same on every screen.', NULL, 'A glance tells you where things stand.')`, ORG_A, REPO, iso(2 * DAY));
  // Session notes: a Status and a Shipped; a handoff announcement (never a note); someone else's note.
  for (const [author, summary, ago] of [
    [ME, "Status: hosting screens half done, Netlify test failing", 60 * MIN],
    [ME, "Shipped: status marks across the app", 2 * DAY],
    [ME, "AndresL230 left a handoff for anyone: #9 something", 3 * 60 * MIN],
    ["Jose-Gael-Cruz-Lopez", "Status: not yours", 30 * MIN],
  ] as const) {
    await run(env.DB, `INSERT INTO feed (org_id, author, summary, brief, created_at) VALUES (?, ?, ?, NULL, ?)`, ORG_A, author, summary, iso(ago));
  }
  // Sprints: one overdue, one due in 3 days.
  await run(env.DB, `INSERT INTO sprints (id, org_id, title, target_date, status, created_at, created_by) VALUES (901, ?, 'Hosting', ?, 'in_progress', ?, 'AndresL230')`, ORG_A, dayOf(-3 * DAY), iso(10 * DAY));
  await run(env.DB, `INSERT INTO sprints (id, org_id, title, target_date, status, created_at, created_by) VALUES (902, ?, 'Polish', ?, 'in_progress', ?, 'AndresL230')`, ORG_A, dayOf(3 * DAY), iso(10 * DAY));
  // Tickets assigned to them: a plain one (#1), a due-soon one (#2), an overdue one (#3), and a closed one (#4).
  const ticket = async (n: number, title: string, status: string, sprint: number | null) => {
    await run(env.DB, `INSERT INTO tickets (id, org_id, number, title, body, category, priority, status, requester, sprint_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', 'other', 'normal', ?, 'meilin', ?, ?, ?)`, n, ORG_A, n, title, status, sprint, iso(5 * DAY), iso(n * MIN));
    await run(env.DB, `INSERT INTO ticket_assignees (org_id, ticket_id, login) VALUES (?, ?, ?)`, ORG_A, n, ME);
  };
  await ticket(1, "Guided repository setup", "submitted", null);
  await ticket(2, "Polish the Hosting tab", "in_progress", 902);
  await ticket(3, "Netlify connect flow", "in_progress", 901);
  await ticket(4, "Already done", "done", 901);
  // A handoff left for them by Jose; one for anyone; one expired.
  for (const [n, recipient, status, expires] of [[7, ME, "pending", 3 * DAY], [8, "anyone", "pending", 3 * DAY], [9, ME, "pending", -DAY]] as const) {
    await run(env.DB, `INSERT INTO handoffs (org_id, number, sender, recipient, status, body, created_at, expires_at) VALUES (?, ?, 'Jose-Gael-Cruz-Lopez', ?, ?, ?, ?, ?)`,
      ORG_A, n, recipient, status, `Handoff ${n} first line\nmore`, iso(DAY + n * MIN), new Date(Date.now() + expires).toISOString());
  }
}

/** What the stub answers: a brief citing what it is told to, whys for the refs given. */
function answer(o: { now?: unknown; recently?: unknown; next?: { ref: string; why: string }[] } = {}): ClaudeReply {
  return () => JSON.stringify({
    now: o.now === undefined ? { text: "You are on the hosting screens; the Netlify test fails on #12.", cites: ["pr:12", "run:4812"] } : o.now,
    recently: o.recently === undefined ? { text: "You shipped status marks.", cites: ["pr:11", "feed:2"] } : o.recently,
    next: o.next ?? [],
  });
}
const latestJson = async () => {
  const row = await latestBrief(ctx(), ME);
  return row ? JSON.parse(row.brief_json) : null;
};

/** The clock every test here runs on (only `Date` is faked): rows, the pass's `now` and the fixtures' ages are all
 *  read against it, so no test depends on the calendar. The 17th on purpose: the run's fact then reads "failed on
 *  Oct 17", and "Failing 17 times." must still be dropped — a date's day is never a count. */
const PINNED_NOW = new Date("2026-10-17T12:00:00.000Z");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
  await seedWorld();
  await markMyWorkOpened(ctx(), ME); // active: opened My Work just now
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the input: what the server offers, in the server's order", () => {
  it("Now, Recently and Next come from this person's rows only; Next is overdue → blocked → waiting → due soon → assigned", async () => {
    const b = (await buildBriefInput(ctx(), ME))!;
    expect(b.now.prs.map((p) => p.ref)).toEqual(["pr:12"]); // not Jose's #13
    expect(b.now.prs[0].failing).toEqual([{ ref: "run:4812", name: "Netlify connect test" }]);
    expect(b.now.prs[0].redChecks).toEqual(["lint"]);
    expect(b.now.status?.summary).toBe("Status: hosting screens half done, Netlify test failing");
    expect(b.recently.notes.map((n) => n.summary)).toEqual(["Shipped: status marks across the app"]); // no handoff line, no Status twice
    expect(b.recently.cards.map((c) => c.ref)).toEqual(["pr:11"]);
    expect(BRIEF_NEXT_MAX).toBe(3);
    expect(b.next.map((o) => [o.ref, o.rule])).toEqual([
      ["ticket:3", "overdue"], ["run:4812", "blocked"], ["handoff:7", "waiting"],
    ]); // 3 at most (BR-OWNER-1): handoff #8, the due-soon #2 and the plain assigned #1 are cut; the closed #4 and the
    // expired handoff #9 never offered
    expect(b.next.map((o) => o.title)).toEqual(["Netlify connect flow", "Netlify connect test", "Handoff 7 first line"]);
    // Past its sprint's date is its own kind, Overdue — never "due" (Due soon) — and its dates read "Jun 10", never ISO.
    expect(b.next.map((o) => o.kind)).toEqual(["overdue", "failing", "handoff"]);
    expect(b.next[0].facts).toMatch(/due [A-Z][a-z]{2} \d{1,2} \(passed\)/);
    expect(b.next[0].fallback).toMatch(/^Its sprint, .+, was due [A-Z][a-z]{2} \d{1,2}\.$/);
    for (const o of b.next) expect(`${o.facts} ${o.fallback}`, o.ref).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // The model never sees a raw PR body.
    expect(briefPromptInput(b)).not.toContain("RAW BODY NEVER SENT");
  });

  it("Trov's session digests FOR this person count as their notes (Q61): the latest Status digest is Now, the week's digests are Recently — never another member's", async () => {
    const digest = (summary: string, subject: string, ago: number) =>
      run(env.DB, `INSERT INTO feed (org_id, author, summary, brief, created_at, origin, model, subject) VALUES (?, 'trov', ?, 'by Trov', ?, 'ai', 'claude-haiku-5-5', ?)`, ORG_A, summary, iso(ago), subject);
    await digest("Status: Netlify connect step waits on the token check", ME, 20 * MIN); // newer than their own Status
    await digest("Shipped: Hosting tab polish", ME, DAY);
    await digest("Status: someone else's", "Jose-Gael-Cruz-Lopez", 5 * MIN);
    await digest("Shipped: too old", ME, 9 * DAY);
    const b = (await buildBriefInput(ctx(), ME))!;
    expect(b.now.status?.summary).toBe("Status: Netlify connect step waits on the token check");
    expect(b.recently.notes.map((n) => n.summary)).toEqual([
      "Status: hosting screens half done, Netlify test failing", "Shipped: Hosting tab polish", "Shipped: status marks across the app",
    ]);
    expect(briefPromptInput(b)).not.toContain("someone else's");
  });

  it("pickNext (BR-OWNER-1): ONE per kind's group — the top of each by the rule order — three at most, in that order", () => {
    const o = (ref: string, kind: NextOffer["kind"], rule: NextOffer["rule"], k = 0): NextOffer => ({ ref, kind, rule, title: ref, facts: "", fallback: "x", cites: [{ ref, label: ref, href: null }], order: [k, 0, ref] });
    // Three handoffs in a row (what the owner saw) give one; Overdue and Due soon are one group: the overdue wins.
    const offers = [o("h1", "handoff", "waiting", 0), o("h2", "handoff", "waiting", 1), o("h3", "handoff", "waiting", 2), o("d", "due", "due soon"), o("od", "overdue", "overdue"), o("t", "ticket", "assigned")];
    expect(pickNext(offers).map((x) => x.ref)).toEqual(["od", "h1", "t"]);
    expect(pickNext([o("h1", "handoff", "waiting"), o("h2", "handoff", "waiting", 1)]).map((x) => x.ref)).toEqual(["h1"]);
    expect(pickNext([o("f1", "failing", "blocked"), o("f2", "failing", "blocked", 1), o("d", "due", "due soon"), o("h", "handoff", "waiting"), o("t", "ticket", "assigned")]).map((x) => x.ref)).toEqual(["f1", "h", "d"]);
    expect(BRIEF_NEXT_MAX).toBe(3);
    expect(shortDay("2026-06-10")).toBe("Jun 10");
    expect(shortDay("2026-10-15T09:00:00.000Z")).toBe("Oct 15");
    expect(shortDay(null)).toBe("");
  });

  it("orderNext is the rule order whatever order the offers come in", () => {
    const o = (ref: string, rule: NextOffer["rule"], k = 0): NextOffer => ({ ref, rule, kind: "ticket", title: ref, facts: "", fallback: "x", cites: [{ ref, label: ref, href: null }], order: [k, 0, ref] });
    expect(orderNext([o("a", "assigned"), o("b", "due soon"), o("c", "waiting"), o("d", "blocked"), o("e", "overdue", 1), o("f", "overdue", -2)]).map((x) => x.ref))
      .toEqual(["f", "e", "d", "c", "b", "a"]);
  });
});

describe("the job: one Haiku call, only what the input says", () => {
  it("writes the brief: Next ONLY offered items, in the SERVER's order, titles their own; an unoffered ref is dropped", async () => {
    await markMe();
    const s = stubProviders({ claude: answer({ next: [
      { ref: "ticket:2", why: "Its sprint ends soon." },
      { ref: "ticket:999", why: "Invented." },
      { ref: "ticket:3", why: "Its sprint has passed." },
      { ref: "run:4812", why: "It blocks your pull request #12." },
    ] }) });
    await briefPass(s);
    expect(s.haiku).toBe(1);
    const b = await latestJson();
    // ticket:2 (due soon) is past the three offered: its why is dropped with it.
    expect(b.next.items.map((i: { ref: string }) => i.ref)).toEqual(["ticket:3", "run:4812", "handoff:7"]);
    expect(b.next.items.map((i: { title: string }) => i.title)[0]).toBe("Netlify connect flow");
    expect(b.next.items.find((i: { ref: string }) => i.ref === "ticket:3").why).toBe("Its sprint has passed.");
    // No why from the model: the server's own plain sentence.
    expect(b.next.items.find((i: { ref: string }) => i.ref === "handoff:7").why).toBe("Jose-Gael-Cruz-Lopez left it for you.");
    expect(b.next.items[0].cites[0]).toEqual({ ref: "ticket:3", label: "#3", href: "#tickets/3" });
    expect(b.now.cites.map((c: { ref: string }) => c.ref)).toEqual(["pr:12", "run:4812"]);
    expect(await dirtyRow(ORG_A, "person", ME)).toMatchObject({ attempts: 0 });
    // The prompt led with the cached org prefix.
    const content = (s.haikuBodies[0] as { messages: { content: { text: string; cache_control?: unknown }[] }[] }).messages[0].content;
    expect(content[0].text).toContain("# Organization");
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(await count(`SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE org_id = ? AND metric = 'ai_run:brief.person'`, ORG_A)).toBe(1);
  });

  it("cite validation: an invented cite is dropped; a line with no valid cite is not written", async () => {
    await markMe();
    await briefPass(stubProviders({ claude: answer({ now: { text: "On #12.", cites: ["pr:12", "pr:999"] }, recently: { text: "Shipped things.", cites: ["pr:404"] } }) }));
    const b = await latestJson();
    expect(b.now.cites.map((c: { ref: string }) => c.ref)).toEqual(["pr:12"]);
    expect(b.recently).toBeNull();
  });

  it("a number the input does not have drops the line (and a why); over-length is dropped, never cut", async () => {
    await markMe();
    await briefPass(stubProviders({ claude: answer({
      now: { text: "You have 42 failing tests on #12.", cites: ["pr:12"] },
      recently: { text: "x".repeat(BRIEF_LINE_MAX + 1), cites: ["pr:11"] },
      next: [{ ref: "ticket:3", why: "Three weeks late." }, { ref: "run:4812", why: "Failing 17 times." }],
    }) }));
    // The input carries 17 only as a day ("failed on Oct 17"), never as a count: that must not ground "17 times".
    const input = briefPromptInput((await buildBriefInput(ctx(), ME))!);
    expect(input).toContain("failed on Oct 17");
    expect(input.replace(/\b(?:Oct 17|\d{4}-\d{2}-17)\b/g, "")).not.toMatch(/\b17\b/);
    const b = await latestJson();
    expect(b.now).toBeNull();
    expect(b.recently).toBeNull();
    expect(b.next.items.find((i: { ref: string }) => i.ref === "ticket:3").why).toBe("Three weeks late.");
    expect(b.next.items.find((i: { ref: string }) => i.ref === "run:4812").why).toBe("It is failing on your pull request #12."); // server's
    expect(numbersGrounded("#12 and 4812", "pr:12 run:4812")).toBe(true);
    expect(numbersGrounded("42 tests", "pr:12")).toBe(false);
    expect(numbersGrounded("15 failures", "due 2026-10-15")).toBe(false); // a date's part is not a count
    expect(numbersGrounded("17 times", "feed:17")).toBe(false); // nor a feed row's id
    expect(numbersGrounded("due 2026-10-15", "due 2026-10-15")).toBe(true);
    expect(numbersGrounded("due 2026-10-16", "due 2026-10-15")).toBe(false);
    // The input's day in words ("Oct 17", as shortDay writes it) is a date too: its day is not a count, and a day in
    // words is grounded only by that same day in words.
    expect(numbersGrounded("Failing 17 times.", "its last run failed on Oct 17")).toBe(false);
    expect(numbersGrounded("fifteen failures", "due Oct 15")).toBe(false);
    expect(numbersGrounded("It failed on Oct 17.", "its last run failed on Oct 17")).toBe(true);
    expect(numbersGrounded("It failed on oct 7.", "failed on Oct 7")).toBe(true);
    expect(numbersGrounded("It failed on Oct 16.", "its last run failed on Oct 17")).toBe(false);
    expect(numbersGrounded("It failed on Oct 17.", "failed 17 times")).toBe(false); // a count is not a day either
    expect(numbersGrounded("Failing 17 times since Oct 17.", "failed 17 times, last on Oct 17")).toBe(true);
  });

  it("the one shape (BR-OWNER-1): Now and Recently ONE sentence each, within the cap; a why past its cap is the server's", async () => {
    await markMe();
    await briefPass(stubProviders({ claude: answer({
      now: { text: "You have #12 open. Its Netlify connect test is failing.", cites: ["pr:12"] }, // two sentences: dropped
      recently: { text: `You shipped ${"the hosting tab polish and ".repeat(6)}more.`.slice(0, BRIEF_LINE_MAX), cites: ["pr:11"] }, // one sentence, at the cap: kept
      next: [{ ref: "ticket:3", why: `Its sprint has passed${", and it waits on you".repeat(4)}.` }], // past BRIEF_WHY_MAX
    }) }));
    const b = await latestJson();
    expect(b.now).toBeNull();
    expect(b.recently.text.length).toBeLessThanOrEqual(BRIEF_LINE_MAX);
    const why = b.next.items.find((i: { ref: string }) => i.ref === "ticket:3").why;
    expect(why).toMatch(/^Its sprint, .+, was due [A-Z][a-z]{2} \d{1,2}\.$/); // the server's own, never a cut one
    // Every why the server keeps — the model's or its own — fits the line.
    for (const i of b.next.items) expect(i.why.length, i.ref).toBeLessThanOrEqual(BRIEF_WHY_MAX);
    expect(oneSentence("You shipped v0.34 and #178.")).toBe(true);
    expect(oneSentence("You shipped it. Then more.")).toBe(false);
    expect(oneSentence("You shipped “the tab.” Then more.")).toBe(false);
  });

  it("a refusal or an answer cut at max_tokens writes NOTHING and counts a failed attempt", async () => {
    for (const stop of ["refusal", "max_tokens"] as const) {
      await markMe();
      const s = stubProviders({ claude: () => ({ stop, text: JSON.stringify({ now: null, recently: null, next: [] }) }) });
      await briefPass(s);
      expect(s.haiku).toBe(1);
      expect(await briefVersions(ctx(), ME)).toEqual([]);
    }
    expect((await dirtyRow(ORG_A, "person", ME))!.attempts).toBeGreaterThanOrEqual(1);
    expect(await count(`SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE org_id = ? AND metric = 'ai_run_failed:brief.person'`, ORG_A)).toBe(2);
  });

  it("an unchanged input calls nothing the second time", async () => {
    await markMe();
    const s = stubProviders({ claude: answer() });
    await briefPass(s);
    await markMe();
    await briefPass(s);
    expect(s.haiku).toBe(1);
    expect(await briefVersions(ctx(), ME)).toHaveLength(1);
  });

  it("nothing left to say replaces a written brief with an EMPTY one, with no call", async () => {
    await markMe();
    await briefPass(stubProviders({ claude: answer() }));
    for (const t of ["ticket_assignees", "tickets", "handoffs", "feed", "pr_summaries", "repo_events", "events"]) await run(env.DB, `DELETE FROM ${t} WHERE org_id = ?`, ORG_A);
    await markMe();
    const s = stubProviders({ claude: answer() });
    await briefPass(s);
    expect(s.haiku).toBe(0);
    const rows = await briefVersions(ctx(), ME);
    expect(rows).toHaveLength(2);
    expect(rows[0].model).toBeNull();
    expect((await storedBrief(ctx(), ME))).toMatchObject({ state: "empty", generatedAt: null, now: null, next: { items: [] } });
  });
});

describe("only for people who opened My Work in 14 days, or who get the digest", () => {
  it("someone who never opened it and gets no digest: no call, no row, the scope written", async () => {
    await run(env.DB, `UPDATE memberships SET mywork_opened_at = NULL WHERE org_id = ? AND user_id = ?`, ORG_A, ME);
    await markMe();
    const s = stubProviders({ claude: answer() });
    await briefPass(s);
    expect(s.haiku).toBe(0);
    expect(await briefVersions(ctx(), ME)).toEqual([]);
    expect((await dirtyRow(ORG_A, "person", ME))!.attempts).toBe(0);
    // 15 days ago is too long ago too…
    await run(env.DB, `UPDATE memberships SET mywork_opened_at = ? WHERE org_id = ? AND user_id = ?`, iso(15 * DAY), ORG_A, ME);
    await markMe();
    await briefPass(s);
    expect(s.haiku).toBe(0);
    // …but a digest recipient (an address on file, not unsubscribed) gets one.
    await run(env.DB, `UPDATE persons SET email = 'andres@example.com', email_unsubscribed = 0 WHERE handle = ?`, ME);
    await markMe();
    await briefPass(s);
    expect(s.haiku).toBe(1);
  });

  it("opening My Work records it at most once an hour, and the route records it", async () => {
    await run(env.DB, `UPDATE memberships SET mywork_opened_at = NULL WHERE org_id = ? AND user_id = ?`, ORG_A, ME);
    const at = new Date("2026-10-15T10:00:00.000Z");
    await markMyWorkOpened(ctx(), ME, at);
    await markMyWorkOpened(ctx(), ME, new Date(at.getTime() + 30 * MIN));
    const opened = async () => (await first<{ t: string }>(env.DB, `SELECT mywork_opened_at AS t FROM memberships WHERE org_id = ? AND user_id = ?`, ORG_A, ME))!.t;
    expect(await opened()).toBe(at.toISOString());
    await markMyWorkOpened(ctx(), ME, new Date(at.getTime() + 61 * MIN));
    expect(await opened()).toBe(new Date(at.getTime() + 61 * MIN).toISOString());
  });
});

describe("storage and the read", () => {
  // Relative to now: a brief older than AI_STALE_DAYS is hidden (Q25), so a fixed date would age out of these tests.
  const at = (i: number) => new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - (10 - i) * 3_600_000).toISOString();
  const put = (i: number, generatedAt = at(i)) => storeBrief(ctx(), ME, {
    generatedAt, model: "claude-haiku-5-5", promptVersion: "brief.1", inputHash: `h${i}`,
    briefJson: JSON.stringify({ now: { text: `Version ${i}`, cites: [{ ref: "pr:12", label: "#12", href: null }] }, recently: null, next: { items: [] } }),
  });

  it(`keeps the last ${BRIEF_VERSIONS_KEPT} versions`, async () => {
    for (let i = 1; i <= 7; i++) await put(i);
    expect((await briefVersions(ctx(), ME)).map((r) => r.version)).toEqual([7, 6, 5, 4, 3]);
  });

  it("My Work and get_my_work read the newest; absent when none; absent with the org switch off; hidden after Wrong?", async () => {
    expect("brief" in (await getMyWork(ctx(), ME))).toBe(false); // none stored: the field is ABSENT
    await put(1);
    await put(2);
    const w = await getMyWork(ctx(), ME);
    expect(w.brief).toMatchObject({ state: "ready", generatedAt: at(2), model: "claude-haiku-5-5", now: { text: "Version 2" } });
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
    expect("brief" in (await getMyWork(ctx(), ME))).toBe(false);
    await run(env.DB, `UPDATE orgs SET ai_automation = 1 WHERE id = ?`, ORG_A);
    await recordFeedback(ctx(), ME, { itemType: "brief", itemRef: aiItemRef.brief(at(2)), kind: "brief", model: "claude-haiku-5-5", promptVersion: null });
    expect("brief" in (await getMyWork(ctx(), ME))).toBe(false);
    await put(3); // the next version shows again
    expect((await getMyWork(ctx(), ME)).brief?.now?.text).toBe("Version 3");
    // A stored row that fails the schema is not shown (never a 500).
    await run(env.DB, `UPDATE person_brief SET brief_json = '{"now":7}' WHERE org_id = ? AND version = 3`, ORG_A);
    expect("brief" in (await getMyWork(ctx(), ME))).toBe(false);
  });

  it(`stale (Q25): a brief older than ${AI_STALE_DAYS} days is hidden — read as none, on My Work, get_my_work and the e-mail's read`, async () => {
    const DAY = 86_400_000;
    await put(1, new Date(Date.now() - (AI_STALE_DAYS * DAY + 60_000)).toISOString());
    expect(await storedBrief(ctx(), ME)).toBeNull();
    expect("brief" in (await getMyWork(ctx(), ME))).toBe(false);
    // The e-mail reads it at its window's end: the same brief, read a day after it was written, is current there.
    expect(await storedBrief(ctx(), ME, new Date(Date.now() - (AI_STALE_DAYS - 1) * DAY))).toMatchObject({ state: "ready" });
    await put(2, new Date(Date.now() - (AI_STALE_DAYS * DAY - 3_600_000)).toISOString());
    expect(await storedBrief(ctx(), ME)).toMatchObject({ state: "ready", now: { text: "Version 2" } });
  });

  it("capped: the last brief, with the day it resumes; Free says upgrade", async () => {
    await put(1);
    await run(env.DB, `UPDATE orgs SET plan = 'free' WHERE id = ?`, ORG_A);
    await run(env.DB, `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, ?, 'ai_run:brief.person', 'ai-pass', 250, ?)`, ORG_A, new Date().toISOString().slice(0, 10), new Date().toISOString());
    expect(await storedBrief(ctx(), ME)).toMatchObject({ state: "capped", upgrade: true, now: { text: "Version 1" } });
    expect((await storedBrief(ctx(), ME))!.resumesOn).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it("briefFromAnswer: Next is the server's list even when the model returns nothing for it", async () => {
    const b = (await buildBriefInput(ctx(), ME))!;
    const c = briefFromAnswer(b, {});
    expect(c.now).toBeNull();
    expect(c.next.items.map((i) => i.ref)).toEqual(b.next.map((o) => o.ref));
    expect(c.next.items.every((i) => i.why.length > 0)).toBe(true);
  });
});

describe("GET /me/dashboard", () => {
  it("records that My Work was opened, carries the stored brief, and an `empty` one when there is none (Q24)", async () => {
    await run(env.DB, `UPDATE memberships SET mywork_opened_at = NULL WHERE org_id = ? AND user_id = ?`, ORG_A, ME);
    const cookie = await cookieFor(ME);
    const get = async () => (await (await app.request("/api/o/saplinglearn/me/dashboard", { headers: { cookie } }, env)).json()) as Record<string, unknown>;
    const none = await get();
    // None stored, under the read rule: the screen's read says `empty` (Q24 — the tile says when Trov writes it).
    expect(none.brief).toMatchObject({ state: "empty", generatedAt: null, now: null });
    expect((await first<{ t: string | null }>(env.DB, `SELECT mywork_opened_at AS t FROM memberships WHERE org_id = ? AND user_id = ?`, ORG_A, ME))!.t).not.toBeNull();
    await markMe();
    await briefPass(stubProviders({ claude: answer() }));
    const withBrief = await get();
    expect(withBrief.brief).toMatchObject({ state: "ready", model: "claude-haiku-5-5", now: { text: "You are on the hosting screens; the Netlify test fails on #12." } });
  });
});

describe("the local dev seed (scripts/seed/brief-dev.mjs)", () => {
  it("stores a brief My Work reads as it is, whose Next is exactly what the server offers, in its order", async () => {
    for (const stmt of [...buildSeedStatements({ tickets, handoffs, roadmap }), ...briefDevStatements()]) await env.DB.prepare(stmt).run();
    const shown = (await getMyWork(ctx(), ME)).brief!;
    expect(shown).toMatchObject({ state: "ready", model: "claude-haiku-5-5" });
    const offered = (await buildBriefInput(ctx(), ME))!.next;
    expect(shown.next.items.map((i) => [i.ref, i.kind, i.title])).toEqual(offered.map((o) => [o.ref, o.kind, o.title]));
  });
});
