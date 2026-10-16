/**
 * The renderers (Phase E: the shorter e-mail), against REAL D1 rows through the REAL reads — the stored brief My Work
 * shows (`storedBrief`), Sift's importance as My Work and the Feed read it (`toMyWorkPr`, `get_feed`), the review
 * queue, the sprint, the tickets. Every renderer is a pure read: the tests also assert nothing was written.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { ORG_B as ORG_B_ID, platformCtx, systemCtx } from "./helpers/tenant";
import { first, run } from "./helpers/db";
import { ingestEvent, ingestDocProposal, ingestAdrDraft } from "../src/consumer";
import { promote_doc } from "../src/tools/writes";
import { storePrSummary, type Summarizer, type PrSummary } from "../src/tools/summarize";
import { create_ticket } from "../src/tools/tickets";
import { create_sprint, set_sprint_active } from "../src/tools/sprints";
import { storeBrief } from "../src/data/person-brief";
import { getKind } from "../src/notifications/registry";
import { needsMe } from "../src/notifications/renderers/my-work";
import { dueWords } from "../src/notifications/renderers/roadmap-plan";
import { seedPerson } from "./helpers/persons";
import { TicketCreate } from "@shared/tickets";
import { SprintCreate } from "@shared/sprints";
import type { Window } from "@shared/notifications";
import { aiItemRef } from "@shared/ai";
import type { CapturedEvent } from "@shared/contract";

// Window under test: the 24h ending 2026-09-11T12:00Z (a Friday).
const WINDOW: Window = { cadence: "daily", start: new Date("2026-09-10T12:00:00.000Z"), end: new Date("2026-09-11T12:00:00.000Z"), id: "2026-09-11" };
const IN_WINDOW = "2026-09-11T03:00:00Z"; // GitHub-style (no millis) — must still fall inside
const BEFORE_WINDOW = "2026-09-09T03:00:00Z";
const LOGIN = "AndresL230";
const ORG = "org_saplinglearn";

function prEvent(number: number, login: string, occurredAt: string, title = `PR ${number}`, repo = "o/r"): CapturedEvent {
  return {
    semantic_key: `gh:pr:${number}:merged`, event_type: "pr_merged", ref_number: number, subject_login: login,
    raw: JSON.stringify({ pr: { number, title, body: "b", html_url: `https://github.com/${repo}/pull/${number}`, merged: true, merged_at: occurredAt, user: { login }, base: { ref: "main" } } }),
    provenance: "webhook", occurred_at: occurredAt,
  };
}
const stub = (s: PrSummary): Summarizer<PrSummary> => ({ model: "stub", summarize: async () => s });
async function merged(n: number, login: string, at: string, importance: string | null, title = `PR ${n}`, repo = "o/r"): Promise<void> {
  await ingestEvent(systemCtx(), platformCtx(), prEvent(n, login, at, title, repo), "github-webhook");
  await storePrSummary(systemCtx(), stub({ title, what: "w", why: "y", impact: "i" }), { semantic_key: `gh:pr:${n}:merged`, pr_number: n, title, body: "b" });
  if (importance) await run(env.DB, `UPDATE pr_summaries SET importance = ? WHERE semantic_key = ?`, importance, `gh:pr:${n}:merged`);
}
async function note(author: string, summary: string, importance: string | null, at = IN_WINDOW, prs: string[] = []): Promise<void> {
  await run(env.DB, `INSERT INTO feed (org_id, author, summary, brief, artifacts, created_at, importance) VALUES (?, ?, ?, NULL, ?, ?, ?)`, ORG, author, summary, JSON.stringify({ prs, commits: [], issues: [] }), at, importance);
}
async function ticket(title: string, assignees: string[], o: { status?: string; sprint?: number; at?: string } = {}): Promise<number> {
  for (const a of assignees) await seedPerson(a);
  const id = await create_ticket(systemCtx(), TicketCreate.parse({ title, assignees, sprint_id: o.sprint ?? null }), LOGIN);
  await run(env.DB, `UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?`, o.status ?? "submitted", o.at ?? IN_WINDOW, id);
  return id;
}
const aiOn = () => run(env.DB, `UPDATE orgs SET ai_automation = 1 WHERE id = ?`, ORG);
const aiOff = () => run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG);
const BRIEF = {
  now: { text: "You are in the middle of the hosting work.", cites: [{ ref: "pr:171", label: "#171", href: "https://github.com/o/r/pull/171" }] },
  recently: null,
  next: { items: [{ ref: "ticket:9", kind: "ticket", title: "From the brief", why: "It is assigned to you.", cites: [{ ref: "ticket:9", label: "#9", href: "#tickets/9" }] }] },
};
const storeTheBrief = () => storeBrief(systemCtx(), LOGIN, { generatedAt: "2026-09-11T11:00:00.000Z", model: "claude-haiku-5-5", promptVersion: "brief.1", inputHash: "h", briefJson: JSON.stringify(BRIEF) });

async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["events", "pr_summaries", "doc_versions", "adrs", "plan_versions", "sprints", "tickets", "ticket_assignees", "feed", "person_brief", "ai_suggestions"]) {
    out[t] = (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${t}`))!.n;
  }
  return out;
}

describe("my_work renderer: Your brief and Also", () => {
  const kind = () => getKind("my_work")!;

  it("null with nothing assigned and nothing notable; null for someone who is not a member", async () => {
    await merged(1, LOGIN, IN_WINDOW, "routine");
    expect(await kind().render(systemCtx(), LOGIN, WINDOW)).toBeNull();
    expect(await kind().render(systemCtx(), "unmapped-login", WINDOW)).toBeNull();
  });

  it("AI OFF: the 3 most recently updated assigned tickets in plain words — even with a brief stored — subject from the first", async () => {
    await aiOff();
    await storeTheBrief(); // stored, but the org's switch is off: My Work would not show it, nor does the e-mail
    await ticket("Oldest", [LOGIN], { at: "2026-09-08T00:00:00Z" });
    await ticket("Second", [LOGIN], { status: "in_progress", at: "2026-09-10T00:00:00Z" });
    await ticket("Newest <b>", [LOGIN], { at: "2026-09-11T00:00:00Z" });
    await ticket("Third", [LOGIN], { at: "2026-09-09T00:00:00Z" });
    await ticket("Someone else's", ["lpcooper-arch"]);
    const before = await tableCounts();
    const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    expect(await tableCounts()).toEqual(before); // pure read
    expect(s.heading).toBe("Your brief");
    expect(s.html).toContain("ASSIGNED TO YOU");
    expect(s.html).not.toContain("From the brief");
    expect(s.html).toContain("Newest &lt;b&gt;");
    expect(s.html).toContain("In progress");
    expect(s.html).not.toContain("Oldest");
    expect(s.html).not.toContain("Someone else");
    expect(s.subject).toBe("Newest <b>, plus 3 more");
  });

  it("AI ON: the SAME stored brief My Work shows — its Now and Next, the subject from its top item", async () => {
    await aiOn();
    await storeTheBrief();
    await ticket("Assigned but not in the brief", [LOGIN]);
    const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    expect(s.html).toContain("You are in the middle of the hosting work.");
    expect(s.html).toContain("From the brief");
    expect(s.html).toContain("{{trov-app}}/#tickets/9"); // resolved by the assembler to the org's address
    expect(s.html).not.toContain("Assigned but not in the brief");
    expect(s.subject).toBe("From the brief");
  });

  // Q42 (owner ruling 2026-10-16): every missing brief falls back to the 3 most recent assigned items.
  it("every missing brief falls back to the assigned tickets: none stored, an empty one, Wrong? on it, the allowance used up", async () => {
    await aiOn();
    await ticket("Assigned one", [LOGIN]);
    const fallsBack = async (why: string) => {
      const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
      expect(s.html, why).toContain("ASSIGNED TO YOU");
      expect(s.html, why).toContain("Assigned one");
      expect(s.html, why).not.toContain("From the brief");
      expect(s.subject, why).toBe("Assigned one");
    };
    await fallsBack("no row");
    // An empty one: the pass stored a row with no model (nothing written).
    await storeBrief(systemCtx(), LOGIN, { generatedAt: "2026-09-11T10:00:00.000Z", model: null, promptVersion: "brief.1", inputHash: "e", briefJson: JSON.stringify({ now: null, recently: null, next: { items: [] } }) });
    await fallsBack("empty");
    // Wrong? on the stored one.
    await storeTheBrief();
    expect((await kind().render(systemCtx(), LOGIN, WINDOW))!.html).toContain("From the brief"); // shown until…
    await run(env.DB, `INSERT INTO ai_feedback (org_id, handle, item_type, item_ref, kind, model, prompt_version, created_at) VALUES (?, ?, 'brief', ?, 'brief', NULL, NULL, ?)`,
      ORG, LOGIN, aiItemRef.brief("2026-09-11T11:00:00.000Z"), IN_WINDOW);
    await fallsBack("Wrong?");
    await run(env.DB, `DELETE FROM ai_feedback`);
    // Capped: the org's month of runs used up — the last brief is NOT mailed (a missing brief).
    await run(env.DB, `UPDATE orgs SET plan = 'free' WHERE id = ?`, ORG);
    await run(env.DB, `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, '2026-09-05', 'ai_run:brief', 'x', 250, ?)`, ORG, IN_WINDOW);
    await fallsBack("capped");
  });

  it("a capped brief adds ONE footer line, for an admin or owner only — why briefs are paused, and when they resume", async () => {
    await aiOn();
    await seedPerson("lpcooper-arch");
    await storeTheBrief();
    await storeBrief(systemCtx(), "lpcooper-arch", { generatedAt: "2026-09-11T11:00:00.000Z", model: "claude-haiku-5-5", promptVersion: "brief.1", inputHash: "h", briefJson: JSON.stringify(BRIEF) });
    await ticket("Mine", [LOGIN]);
    await ticket("Luke's", ["lpcooper-arch"]);
    await run(env.DB, `UPDATE orgs SET plan = 'free' WHERE id = ?`, ORG);
    await run(env.DB, `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, '2026-09-05', 'ai_run:brief', 'x', 250, ?)`, ORG, IN_WINDOW);
    const owner = (await kind().render(systemCtx(), LOGIN, WINDOW))!; // AndresL230 is the seed org's owner
    expect(owner.footnote).toBe("Your brief is paused: this organization has used this month's AI allowance; it resumes Oct 1 (Org settings › AI).");
    const member = (await kind().render(systemCtx(), "lpcooper-arch", WINDOW))!;
    expect(member.footnote).toBeUndefined();
    // An ended plan says so instead of a date.
    await run(env.DB, `UPDATE orgs SET plan = 'team', plan_status = 'canceled' WHERE id = ?`, ORG);
    expect((await kind().render(systemCtx(), LOGIN, WINDOW))!.footnote).toBe("Your brief is paused: this organization's Pro plan has ended, so Trov's AI is paused until it is renewed (Org settings › General).");
    // Not capped: no line.
    await run(env.DB, `UPDATE orgs SET plan = 'enterprise', plan_status = 'active' WHERE id = ?`, ORG);
    expect((await kind().render(systemCtx(), LOGIN, WINDOW))!.footnote).toBeUndefined();
  });

  it("a Google-only member (no GitHub identity) still gets their assigned tickets", async () => {
    await seedPerson("priya", { github: false, email: "p@example.com" });
    await ticket("Priya's", ["priya"]);
    expect((await kind().render(systemCtx(), "priya", WINDOW))!.html).toContain("Priya&#39;s");
  });

  // Q43 (owner ruling 2026-10-16): what touches the person's work, since when, which 3 win, where each links.
  it("ALSO: notable / breaking items that touch their tickets, their pull requests or a repository they pushed to — each linking into Trov", async () => {
    await seedPerson("lpcooper-arch");
    const REPO = "SaplingLearn/sapling";
    // A PR they authored → My Work.
    await merged(10, LOGIN, IN_WINDOW, "notable", "Mine, notable");
    // Luke's PR linked to a ticket they REQUESTED (assigned to Luke) → that ticket.
    const t = await ticket("Their request", ["lpcooper-arch"]);
    await run(env.DB, `UPDATE tickets SET requester = ? WHERE id = ?`, LOGIN, t);
    const tn = (await first<{ number: number }>(env.DB, `SELECT number FROM tickets WHERE id = ?`, t))!.number;
    await merged(20, "lpcooper-arch", "2026-09-11T04:00:00Z", "breaking", "On their ticket");
    await run(env.DB, `INSERT INTO ticket_links (org_id, ticket_id, url, kind, label, meta, created_by, created_at) VALUES (?, ?, 'https://github.com/o/r/pull/20', 'github', '#20', '{}', ?, ?)`, ORG, t, LOGIN, IN_WINDOW);
    // Luke's PR in a repository they pushed to this week → its Repo dashboard.
    await merged(30, "lpcooper-arch", "2026-09-11T05:00:00Z", "notable", "In their repo", "Other/elsewhere");
    await run(env.DB, `INSERT INTO repo_events (org_id, repo, semantic_key, kind, actor_login, raw, provenance, occurred_at, recorded_at) VALUES (?, ?, 'push:1', 'push', ?, '{}', 'webhook', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z')`, ORG, "Other/elsewhere", LOGIN);
    // A push older than 14 days does not make a repository theirs.
    await run(env.DB, `INSERT INTO repo_events (org_id, repo, semantic_key, kind, actor_login, raw, provenance, occurred_at, recorded_at) VALUES (?, ?, 'push:2', 'push', ?, '{}', 'webhook', '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z')`, ORG, "Luke/solo", LOGIN);
    // Not theirs: Luke's PR in a repository they did not push to lately, on no ticket of theirs.
    await merged(40, "lpcooper-arch", IN_WINDOW, "breaking", "Luke's own", "Luke/solo");
    // Rated routine or not at all, or merged before the window: never.
    await merged(11, LOGIN, IN_WINDOW, "routine", "Routine of mine");
    await merged(12, LOGIN, IN_WINDOW, null, "Unrated of mine");
    await merged(14, LOGIN, BEFORE_WINDOW, "notable", "Old notable of mine");
    const before = await tableCounts();
    const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    expect(await tableCounts()).toEqual(before); // pure read
    expect(s.heading).toBe("Also"); // nothing assigned to them, no brief: Also alone
    // Breaking first, then newest; at most 3.
    const titles = [...s.html.matchAll(/<a href="[^"]*"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    expect(titles).toEqual(["On their ticket", "In their repo", "Mine, notable"]);
    // Each links INTO Trov, never GitHub.
    expect(s.html).toContain(`href="{{trov-app}}/#tickets/${tn}"`);
    expect(s.html).toContain(`href="{{trov-app}}/#repo?repo=Other%2Felsewhere"`);
    expect(s.html).toContain(`href="{{trov-app}}/#mywork"`);
    expect(s.html).not.toContain("github.com");
    for (const no of ["Luke&#39;s own", "Routine of mine", "Unrated of mine", "Old notable of mine"]) expect(s.html).not.toContain(no);
  });

  it("ALSO from the Feed: an entry naming their PR, an issue of their ticket, or a session in their repo — not one that only has them as author", async () => {
    await seedPerson("lpcooper-arch");
    await merged(14, LOGIN, BEFORE_WINDOW, null, "Their older PR"); // named below; not itself a line
    await note("lpcooper-arch", "Luke on my PR", "notable", "2026-09-11T01:00:00Z", ["#14"]);
    const t = await ticket("Mirrored", [LOGIN], { status: "done" });
    await run(env.DB, `UPDATE tickets SET source = 'github', source_ref = 'o/r#77' WHERE id = ?`, t);
    await run(env.DB, `INSERT INTO feed (org_id, author, summary, artifacts, created_at, importance) VALUES (?, 'lpcooper-arch', 'About issue 77', ?, '2026-09-11T02:00:00Z', 'breaking')`, ORG, JSON.stringify({ prs: [], commits: [], issues: [77] }));
    await run(env.DB, `INSERT INTO repo_events (org_id, repo, semantic_key, kind, actor_login, raw, provenance, occurred_at, recorded_at) VALUES (?, 'O/r', 'push:9', 'push', ?, '{}', 'webhook', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z')`, ORG, LOGIN);
    const f = await run(env.DB, `INSERT INTO feed (org_id, author, summary, artifacts, created_at, importance) VALUES (?, 'trov', 'Shipped: the repo work', '{}', '2026-09-11T00:30:00Z', 'notable')`, ORG);
    await run(env.DB, `INSERT INTO ai_sessions (org_id, repo, actor_login, started_at, ended_at, status, feed_id, created_at) VALUES (?, 'O/r', 'someone', 'a', 'b', 'done', ?, 'c')`, ORG, f.meta.last_row_id);
    await note(LOGIN, "Mine, about nothing of theirs", "breaking"); // authored by them, but touches none of the three
    const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    const also = s.html.slice(s.html.indexOf("data-brief-also"));
    const titles = [...also.matchAll(/<a href="([^"]*)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[2], m[1]]);
    expect(titles).toEqual([["About issue 77", "{{trov-app}}/#feed"], ["Luke on my PR", "{{trov-app}}/#feed"], ["Shipped: the repo work", "{{trov-app}}/#feed"]]);
    expect(s.html).not.toContain("Mine, about nothing of theirs");
  });

  it("ALSO looks back to their last daily SENT in this org (a test send is not one), not only the window", async () => {
    await merged(10, LOGIN, "2026-09-09T20:00:00Z", "notable", "Since the last send"); // before WINDOW.start
    expect((await kind().render(systemCtx(), LOGIN, WINDOW))).toBeNull();
    await run(env.DB, `INSERT INTO notification_outbox (org_id, idempotency_key, user_id, cadence, window_id, kinds, status, created_at, sent_at) VALUES (?, 'k1', ?, 'daily', '2026-09-08', '[]', 'sent', '2026-09-08T12:00:00Z', '2026-09-08T12:00:01Z')`, ORG, LOGIN);
    await run(env.DB, `INSERT INTO notification_outbox (org_id, idempotency_key, user_id, cadence, window_id, kinds, status, created_at, sent_at) VALUES (?, 'k2', ?, 'daily', '2026-09-10 (test)', '[]', 'sent', '2026-09-10T00:00:00Z', '2026-09-10T00:00:01Z')`, ORG, LOGIN);
    expect((await kind().render(systemCtx(), LOGIN, WINDOW))!.html).toContain("Since the last send");
    // A send in another org is not this org's.
    await run(env.DB, `UPDATE notification_outbox SET status = 'skipped' WHERE idempotency_key = 'k1'`);
    expect((await kind().render(systemCtx(), LOGIN, WINDOW))).toBeNull();
  });

  it("the weekly carries the brief but no Also", async () => {
    await merged(10, LOGIN, IN_WINDOW, "breaking");
    expect(await kind().render(systemCtx(), LOGIN, { ...WINDOW, cadence: "weekly" })).toBeNull();
  });

  it("needsMe: a Next item, or something notable that touched their work — else false", async () => {
    expect(await needsMe(systemCtx(), LOGIN, WINDOW)).toBe(false);
    await merged(10, LOGIN, IN_WINDOW, "notable");
    expect(await needsMe(systemCtx(), LOGIN, WINDOW)).toBe(true);
    await run(env.DB, `DELETE FROM pr_summaries`);
    await ticket("Mine", [LOGIN]);
    expect(await needsMe(systemCtx(), LOGIN, WINDOW)).toBe(true);
  });
});

describe("review_queue renderer: one line", () => {
  const kind = () => getKind("review_queue")!;

  it("null when nothing waits", async () => {
    expect(await kind().render(systemCtx(), LOGIN, WINDOW)).toBeNull();
  });

  it("'Review: N waiting' over open proposals and draft decisions; '…, 1 changes a decision' only with the AI switch on and Sift's open review.risk", async () => {
    await ingestDocProposal(systemCtx(), { slug: "auth-flow", section: "reference", title: "Auth flow", body: "v1", change_summary: "init", confidence: "high" }, "agent");
    await promote_doc(systemCtx(), "auth-flow", 1, "human");
    await ingestDocProposal(systemCtx(), { slug: "auth-flow", section: "reference", title: "Auth flow", body: "v2 proposed", change_summary: "edit", confidence: "high" }, "agent");
    await ingestAdrDraft(systemCtx(), { title: "Use D1 for outbox", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await ingestAdrDraft(systemCtx(), { title: "Already ratified", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await run(env.DB, `UPDATE adrs SET status = 'ratified' WHERE title = 'Already ratified'`);
    const adr = (await first<{ id: number }>(env.DB, `SELECT id FROM adrs WHERE title = 'Use D1 for outbox'`))!.id;
    await run(env.DB, `INSERT INTO ai_suggestions (org_id, item_type, item_ref, kind, value_json, confidence, reason, created_at) VALUES (?, 'proposal', ?, 'review.risk', ?, 0.9, 'r', ?)`,
      ORG, `adr:${adr}`, JSON.stringify({ risk: "decision", label: "Changes a decision" }), IN_WINDOW);

    await aiOff();
    const before = await tableCounts();
    const off = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    expect(await tableCounts()).toEqual(before);
    expect(off.layout).toBe("line");
    expect(off.text).toBe("Review: 2 waiting");
    await aiOn();
    expect((await kind().render(systemCtx(), LOGIN, WINDOW))!.text).toBe("Review: 2 waiting, 1 changes a decision");
    // Q44: with no risk suggestion the clause is dropped — never "0 change a decision".
    await run(env.DB, `UPDATE ai_suggestions SET state = 'dismissed'`);
    expect((await kind().render(systemCtx(), LOGIN, WINDOW))!.text).toBe("Review: 2 waiting");
  });

  // Q44 (owner ruling 2026-10-16): only to people who can promote — every role may today (organizations.md §4).
  it("goes only to someone who can promote: each role of the org does; a non-member does not", async () => {
    await ingestAdrDraft(systemCtx(), { title: "Pending", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await seedPerson("an-admin", { member: false });
    await run(env.DB, `INSERT INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, 'an-admin', 'admin', 'now', 'seed')`, ORG);
    for (const who of [LOGIN /* owner */, "an-admin", "lpcooper-arch" /* member */]) {
      expect((await kind().render(systemCtx(), who, WINDOW))?.text, who).toBe("Review: 1 waiting");
    }
    await seedPerson("outsider", { member: false });
    expect(await kind().render(systemCtx(), "outsider", WINDOW)).toBeNull();
    expect(await kind().render(systemCtx(ORG_B_ID), LOGIN, WINDOW)).toBeNull(); // not a member of the other org
  });
});

describe("roadmap_plan renderer: the Sprint line", () => {
  const kind = () => getKind("roadmap_plan")!;

  it("null with no sprint in progress (the plan diff is gone)", async () => {
    await create_sprint(systemCtx(), SprintCreate.parse({ label: "Upcoming", due: "2026-09-18" }), LOGIN);
    expect(await kind().render(systemCtx(), LOGIN, WINDOW)).toBeNull();
  });

  it("'Sprint: Hosting, due Mon, 2 of 3 done' — declined tickets do not count; the person's sprint before another", async () => {
    const other = await create_sprint(systemCtx(), SprintCreate.parse({ label: "Other", due: "2026-09-12" }), LOGIN);
    await set_sprint_active(systemCtx(), other.id, true);
    const s = await create_sprint(systemCtx(), SprintCreate.parse({ label: "Hosting", due: "2026-09-14" }), LOGIN);
    await set_sprint_active(systemCtx(), s.id, true);
    await ticket("a", [LOGIN], { sprint: s.id });
    await ticket("b", ["lpcooper-arch"], { sprint: s.id, status: "done" });
    await ticket("c", ["lpcooper-arch"], { sprint: s.id, status: "done" });
    await ticket("d", ["lpcooper-arch"], { sprint: s.id, status: "declined" });
    const before = await tableCounts();
    const line = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    expect(await tableCounts()).toEqual(before);
    expect(line.text).toBe("Sprint: Hosting, due Mon, 2 of 3 done");
    // Someone with nothing in either gets the org's sprint due soonest; a sprint with no tickets has no count.
    expect((await kind().render(systemCtx(), "Darkest-Teddy", WINDOW))!.text).toBe("Sprint: Other, due Sat");
  });

  it("due words: today, a weekday within the week, a date beyond it, days late; nothing for no date", () => {
    const now = new Date("2026-09-11T12:00:00Z");
    expect(dueWords("2026-09-11", now)).toBe("due today");
    expect(dueWords("2026-09-14", now)).toBe("due Mon");
    expect(dueWords("2026-10-01", now)).toBe("due Oct 1");
    expect(dueWords("2026-09-10", now)).toBe("1 day late");
    expect(dueWords("2026-09-08", now)).toBe("3 days late");
    expect(dueWords(null, now)).toBeNull();
  });
});
