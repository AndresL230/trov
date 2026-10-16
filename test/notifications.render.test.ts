/**
 * The renderers (Phase E: the shorter e-mail), against REAL D1 rows through the REAL reads — the stored brief My Work
 * shows (`storedBrief`), Sift's importance as My Work and the Feed read it (`toMyWorkPr`, `get_feed`), the review
 * queue, the sprint, the tickets. Every renderer is a pure read: the tests also assert nothing was written.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { platformCtx, systemCtx } from "./helpers/tenant";
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
import type { CapturedEvent } from "@shared/contract";
import { useAiKey } from "./helpers/ai-key";

// THE read rule (src/plans/gate.ts `aiShown`): no Anthropic key reads like the switch off, so these tests hold a fake one.
useAiKey();

// Window under test: the 24h ending 2026-09-11T12:00Z (a Friday).
const WINDOW: Window = { cadence: "daily", start: new Date("2026-09-10T12:00:00.000Z"), end: new Date("2026-09-11T12:00:00.000Z"), id: "2026-09-11" };
const IN_WINDOW = "2026-09-11T03:00:00Z"; // GitHub-style (no millis) — must still fall inside
const BEFORE_WINDOW = "2026-09-09T03:00:00Z";
const LOGIN = "AndresL230";
const ORG = "org_saplinglearn";

function prEvent(number: number, login: string, occurredAt: string, title = `PR ${number}`): CapturedEvent {
  return {
    semantic_key: `gh:pr:${number}:merged`, event_type: "pr_merged", ref_number: number, subject_login: login,
    raw: JSON.stringify({ pr: { number, title, body: "b", html_url: `https://github.com/o/r/pull/${number}`, merged: true, merged_at: occurredAt, user: { login }, base: { ref: "main" } } }),
    provenance: "webhook", occurred_at: occurredAt,
  };
}
const stub = (s: PrSummary): Summarizer<PrSummary> => ({ model: "stub", summarize: async () => s });
async function merged(n: number, login: string, at: string, importance: string | null, title = `PR ${n}`): Promise<void> {
  await ingestEvent(systemCtx(), platformCtx(), prEvent(n, login, at, title), "github-webhook");
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

  it("a Google-only member (no GitHub identity) still gets their assigned tickets", async () => {
    await seedPerson("priya", { github: false, email: "p@example.com" });
    await ticket("Priya's", ["priya"]);
    expect((await kind().render(systemCtx(), "priya", WINDOW))!.html).toContain("Priya&#39;s");
  });

  it("ALSO: their notable / breaking merged PRs and feed entries in the window — not routine, not unrated, not someone else's, not before the window", async () => {
    await seedPerson("lpcooper-arch");
    await merged(10, LOGIN, IN_WINDOW, "breaking", "Breaking change of mine");
    await merged(11, LOGIN, IN_WINDOW, "routine", "Routine of mine");
    await merged(12, LOGIN, IN_WINDOW, null, "Unrated of mine");
    await merged(13, "lpcooper-arch", IN_WINDOW, "notable", "Luke's notable");
    await merged(14, LOGIN, BEFORE_WINDOW, "notable", "Old notable of mine");
    await note(LOGIN, "My notable note", "notable");
    await note("lpcooper-arch", "Luke's note about my PR", "notable", IN_WINDOW, ["14"]);
    await note("lpcooper-arch", "Luke's own note", "breaking");
    const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    expect(s.heading).toBe("Also"); // nothing assigned, no brief: Also alone
    expect(s.html).toMatch(/Breaking change of mine[\s\S]*My notable note|Breaking change of mine[\s\S]*Luke&#39;s note about my PR/);
    expect(s.html).toContain("Luke&#39;s note about my PR"); // it names one of THEIR pull requests
    for (const no of ["Routine of mine", "Unrated of mine", "Luke&#39;s notable", "Old notable of mine", "Luke&#39;s own note"]) expect(s.html).not.toContain(no);
    expect((s.html.match(/data-mark/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  it("the weekly carries the brief but no Also", async () => {
    await merged(10, LOGIN, IN_WINDOW, "breaking");
    expect(await kind().render(systemCtx(), LOGIN, { ...WINDOW, cadence: "weekly" })).toBeNull();
  });

  it("needsMe: a Next item, or something notable that touched their work — else false", async () => {
    expect(await needsMe(systemCtx(), LOGIN, WINDOW)).toBe(false);
    await note(LOGIN, "Notable", "notable");
    expect(await needsMe(systemCtx(), LOGIN, WINDOW)).toBe(true);
    await run(env.DB, `DELETE FROM feed`);
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
