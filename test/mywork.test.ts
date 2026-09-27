import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, run, nowIso } from "../src/db";
import { ingestEvent } from "../src/consumer";
import { storePrSummary, storeIssueSummary, type Summarizer, type PrSummary, type IssueSummary } from "../src/tools/summarize";
import { getMyWork, listAssignedTickets, countAssignedTickets } from "../src/tools/mywork";
import { create_ticket, transition_ticket } from "../src/tools/tickets";
import type { TicketCreate } from "@shared/tickets";
import { seedPerson } from "./helpers/persons";
import type { EventRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

const NOW = "2026-07-15T12:00:00.000Z";

function daysBefore(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function prEvent(over: Partial<CapturedEvent> & { number: number; login: string; merged?: boolean; baseRef?: string | null }): CapturedEvent {
  const { number, login, merged = true, baseRef = null, ...rest } = over;
  const raw = JSON.stringify({
    pr: {
      number,
      title: `PR ${number}`,
      body: "some body",
      html_url: `https://github.com/o/r/pull/${number}`,
      merged,
      merged_at: merged ? NOW : null,
      closed_at: NOW,
      user: { login },
      milestone: null, // GitHub's own key — not Canopy vocabulary
      base: baseRef ? { ref: baseRef } : null,
    },
  });
  return {
    semantic_key: `gh:pr:${number}:${merged ? "merged" : "closed"}`,
    event_type: merged ? "pr_merged" : "pr_closed",
    ref_number: number,
    subject_login: login,
    raw,
    provenance: "webhook",
    occurred_at: NOW,
    ...rest,
  };
}

function issueEvent(over: {
  number: number;
  login: string;
  action: string;
  state: "open" | "closed";
  updatedAt: string;
  title?: string;
  labels?: string[];
  assigneeLogin?: string;
  // GitHub's own key — not Canopy vocabulary (this is a GitHub payload literal).
  milestone?: { title?: string | null; due_on?: string | null; number?: number } | null;
}): CapturedEvent {
  // `milestone` is GitHub's own key — not Canopy vocabulary (a payload literal).
  const { number, login, action, state, updatedAt, title = `Issue ${number}`, labels = [], assigneeLogin = login, milestone = null } = over;
  const raw = JSON.stringify({
    action,
    issue: {
      number,
      title,
      html_url: `https://github.com/o/r/issues/${number}`,
      state,
      updated_at: updatedAt,
      user: { login },
      assignees: [{ login: assigneeLogin }],
      labels,
      milestone: milestone ?? null, // GitHub's own key — not Canopy vocabulary
    },
  });
  return {
    semantic_key: `gh:issue:${number}:${action}:${updatedAt}`,
    event_type: "issue",
    ref_number: number,
    subject_login: assigneeLogin,
    raw,
    provenance: "webhook",
    occurred_at: updatedAt,
  };
}

describe("getMyWork — previous activity cap", () => {
  it("returns only the 6 most recent merged/closed PR events, with the stored structured columns joined", async () => {
    for (let n = 1; n <= 7; n++) {
      await ingestEvent(env.DB, prEvent({ number: n, login: "AndresL230", occurred_at: daysBefore(NOW, 7 - n) }), "github-webhook");
    }
    await storePrSummary(env.DB, null, { semantic_key: "gh:pr:7:merged", pr_number: 7, title: "PR 7", body: "some body" });

    const work = await getMyWork(env.DB, "AndresL230");
    expect(work.degraded).toBe(false);
    expect(work.person).toBe("Andres");
    expect(work.previousActivity.map((p) => p.number)).toEqual([7, 6, 5, 4, 3, 2]); // newest first, oldest one cut
    expect(work.previousActivity[0]).toMatchObject({
      number: 7,
      title: "PR 7",
      url: "https://github.com/o/r/pull/7",
      merged: true,
      // Not yet populated by capture/summarize — null until the follow-up lands.
      displayTitle: null,
      what: null,
      why: null,
      impact: null,
      baseRef: null,
    });
  });

  it("does not surface another person's PR events", async () => {
    const mine = prEvent({ number: 3, login: "AndresL230", occurred_at: daysBefore(NOW, 2) });
    const theirs = prEvent({ number: 4, login: "Jose-Gael-Cruz-Lopez", occurred_at: daysBefore(NOW, 2) });
    await ingestEvent(env.DB, mine, "github-webhook");
    await ingestEvent(env.DB, theirs, "github-webhook");

    const work = await getMyWork(env.DB, "AndresL230");
    expect(work.previousActivity.map((p) => p.number)).toEqual([3]);
  });
});

describe("getMyWork — todo latest-snapshot semantics", () => {
  it("reflects only the LATEST snapshot per issue: open→closed drops it, reopen brings it back", async () => {
    const opened = issueEvent({
      number: 7,
      login: "AndresL230",
      action: "opened",
      state: "open",
      updatedAt: "2026-07-01T10:00:00.000Z",
      title: "[P1] Fix bug",
      labels: ["bug"],
    });
    await ingestEvent(env.DB, opened, "github-webhook");

    let work = await getMyWork(env.DB, "AndresL230");
    expect(work.todo).toHaveLength(1);
    expect(work.todo[0]).toMatchObject({
      number: 7,
      title: "Fix bug",
      priority: "P1",
      labels: ["bug"],
      url: "https://github.com/o/r/issues/7",
      // Not yet populated by capture/summarize — null until the follow-up lands.
      displayTitle: null,
      sprint: null,
      nextStep: null,
    });

    const closed = issueEvent({
      number: 7,
      login: "AndresL230",
      action: "closed",
      state: "closed",
      updatedAt: "2026-07-02T10:00:00.000Z",
      title: "[P1] Fix bug",
      labels: ["bug"],
    });
    await ingestEvent(env.DB, closed, "github-webhook");

    work = await getMyWork(env.DB, "AndresL230");
    expect(work.todo).toHaveLength(0);

    const reopened = issueEvent({
      number: 7,
      login: "AndresL230",
      action: "reopened",
      state: "open",
      updatedAt: "2026-07-03T10:00:00.000Z",
      title: "[P1] Fix bug",
      labels: ["bug"],
    });
    await ingestEvent(env.DB, reopened, "github-webhook");

    work = await getMyWork(env.DB, "AndresL230");
    expect(work.todo).toHaveLength(1);
    expect(work.todo[0].number).toBe(7);
  });
});

describe("getMyWork — todo cap", () => {
  it("returns only the 6 most recently updated open assigned issues, newest first", async () => {
    for (let n = 1; n <= 7; n++) {
      await ingestEvent(
        env.DB,
        issueEvent({
          number: n,
          login: "AndresL230",
          action: "assigned",
          state: "open",
          updatedAt: daysBefore(NOW, 7 - n), // issue 7 is the freshest
        }),
        "github-webhook"
      );
    }

    const work = await getMyWork(env.DB, "AndresL230");
    expect(work.todo.map((t) => t.number)).toEqual([7, 6, 5, 4, 3, 2]); // newest first, oldest one cut — mirrors the PR cap
  });
});

describe("getMyWork — unmapped login", () => {
  it("returns an empty, non-degraded projection but leaves captured events in place", async () => {
    const ev = prEvent({ number: 9, login: "stranger", occurred_at: daysBefore(NOW, 1) });
    await ingestEvent(env.DB, ev, "github-webhook");

    const work = await getMyWork(env.DB, "stranger");
    expect(work).toEqual({ person: null, previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false });

    const rows = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(rows).toHaveLength(1); // captured, never dropped
  });
});

describe("getMyWork — person with no GitHub identity (e.g. Google-only)", () => {
  it("returns an empty, non-degraded projection carrying the person's name, not null", async () => {
    await seedPerson("priya", { name: "Priya", github: false });

    const work = await getMyWork(env.DB, "priya");
    expect(work).toEqual({ person: "Priya", previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false });
  });
});

describe("getMyWork — todo carries the issue summary", () => {
  it("joins issue_summaries by issue number; null until a summary exists", async () => {
    const assigned = issueEvent({
      number: 8,
      login: "AndresL230",
      action: "assigned",
      state: "open",
      updatedAt: "2026-07-01T10:00:00.000Z",
    });
    await ingestEvent(env.DB, assigned, "github-webhook");

    let work = await getMyWork(env.DB, "AndresL230");
    expect(work.todo.find((t) => t.number === 8)?.summary).toBeNull();

    await storeIssueSummary(env.DB, null, { issue_number: 8, title: "Issue 8", body: "some body" });
    work = await getMyWork(env.DB, "AndresL230");
    expect(work.todo.find((t) => t.number === 8)?.summary).toBe("some body"); // excerpt fallback (no summarizer)
  });
});

describe("getMyWork — structured fields", () => {
  it("projects the structured PR summary columns and base.ref into the DTO", async () => {
    await seedPerson("dev", { name: "Dev" });
    await ingestEvent(env.DB, prEvent({ number: 7, login: "dev", baseRef: "main" }), "github-webhook");
    const stub: Summarizer<PrSummary> = {
      model: "stub-model",
      summarize: async () => ({ title: "Humanized seven", what: "Did the thing.", why: "It was broken.", impact: "Users can log in." }),
    };
    await storePrSummary(env.DB, stub, { semantic_key: "gh:pr:7:merged", pr_number: 7, title: "t", body: "b" });

    const work = await getMyWork(env.DB, "dev");
    expect(work.previousActivity[0]).toMatchObject({
      number: 7,
      displayTitle: "Humanized seven",
      what: "Did the thing.",
      why: "It was broken.",
      impact: "Users can log in.",
      baseRef: "main",
    });
  });

  it("projects the structured issue summary columns and the SPRINT into the todo", async () => {
    await seedPerson("dev", { name: "Dev" });
    await ingestEvent(
      env.DB,
      issueEvent({ number: 9, login: "dev", action: "assigned", state: "open", updatedAt: NOW, milestone: { number: 3, title: "Reliable event capture", due_on: "2026-07-20T07:00:00Z" } }),
      "github-webhook"
    );
    const stub: Summarizer<IssueSummary> = {
      model: "stub-model",
      summarize: async () => ({ title: "Humanized nine", summary: "What it is.", next_step: "Do the fix." }),
    };
    await storeIssueSummary(env.DB, stub, { issue_number: 9, title: "t", body: "b" });

    const work = await getMyWork(env.DB, "dev");
    expect(work.todo[0]).toMatchObject({
      number: 9,
      displayTitle: "Humanized nine",
      summary: "What it is.",
      nextStep: "Do the fix.",
      // No sprint claims GitHub group 3, so the group's own title stands in.
      sprint: { title: "Reliable event capture", dueOn: "2026-07-20T07:00:00Z" },
    });
  });

  it("resolves the issue's GitHub group number to the SPRINT whose github_ref is that number", async () => {
    await seedPerson("dev", { name: "Dev" });
    // Two sprints; only the second claims GitHub group 3.
    await run(env.DB, `INSERT INTO sprints (title, target_date, status, github_ref, created_at, created_by) VALUES ('Other sprint', '2026-07-01', 'upcoming', '9', ?, 'dev')`, NOW);
    await run(env.DB, `INSERT INTO sprints (title, target_date, status, github_ref, created_at, created_by) VALUES ('Sprint 12', '2026-07-20', 'in_progress', '3', ?, 'dev')`, NOW);
    await ingestEvent(
      env.DB,
      issueEvent({ number: 11, login: "dev", action: "assigned", state: "open", updatedAt: NOW, milestone: { number: 3, title: "Reliable event capture", due_on: "2026-07-20T07:00:00Z" } }),
      "github-webhook"
    );

    const work = await getMyWork(env.DB, "dev");
    // The SPRINT's title wins over the GitHub group's; the due date is still
    // GitHub's `due_on`.
    expect(work.todo[0].sprint).toEqual({ title: "Sprint 12", dueOn: "2026-07-20T07:00:00Z" });
  });

  it("an ARRAY github_ref claims no group number — the GitHub title is the fallback", async () => {
    await seedPerson("dev", { name: "Dev" });
    // `[3]` is a list of ISSUE numbers, not a group number: it must not claim 3.
    await run(env.DB, `INSERT INTO sprints (title, target_date, status, github_ref, created_at, created_by) VALUES ('Issue list sprint', '2026-07-20', 'in_progress', '[3]', ?, 'dev')`, NOW);
    await ingestEvent(
      env.DB,
      issueEvent({ number: 12, login: "dev", action: "assigned", state: "open", updatedAt: NOW, milestone: { number: 3, title: "Reliable event capture", due_on: null } }),
      "github-webhook"
    );

    const work = await getMyWork(env.DB, "dev");
    expect(work.todo[0].sprint).toEqual({ title: "Reliable event capture", dueOn: null });
  });

  it("yields nulls for a legacy raw (no base, GitHub group without a title) and a prose-era summary row", async () => {
    await seedPerson("dev", { name: "Dev" });
    await ingestEvent(env.DB, prEvent({ number: 8, login: "dev" }), "github-webhook");
    await ingestEvent(
      env.DB,
      issueEvent({ number: 10, login: "dev", action: "assigned", state: "open", updatedAt: NOW, milestone: { number: 3 } }),
      "github-webhook"
    );
    const work = await getMyWork(env.DB, "dev");
    expect(work.previousActivity[0]).toMatchObject({ number: 8, displayTitle: null, what: null, why: null, impact: null, baseRef: null });
    expect(work.todo[0]).toMatchObject({ number: 10, displayTitle: null, nextStep: null, sprint: null });
  });
});

// ── Phase 5b: the third My Work list — tickets assigned to me ────────────────
// Tickets are D1 rows keyed on a person HANDLE (never a GitHub login), so this
// block drives the real writers (`create_ticket` / `transition_ticket` /
// `set_ticket_sprint`) and reads the projection back off `getMyWork`.

describe("getMyWork — tickets assigned to me", () => {
  async function seedSprintRow(title: string): Promise<number> {
    const now = nowIso();
    const res = await run(
      env.DB,
      `INSERT INTO sprints (title, target_date, status, created_at, created_by, updated_at) VALUES (?, '2026-09-01', 'in_progress', ?, 'dev', ?)`,
      title, now, now
    );
    return res.meta.last_row_id as number;
  }
  const mk = (o: Partial<TicketCreate> & { title: string }): TicketCreate => ({
    body: "", category: "other", priority: "normal", assignees: [], ...o,
  });

  it("lists MY open tickets and never anyone else's, with the requester and sprint", async () => {
    await seedPerson("dev", { name: "Dev" });
    await seedPerson("meilin", { name: "Meilin Zhao", github: false });
    const sprintId = await seedSprintRow("Sprint 13 — Tickets");

    const mine = await create_ticket(env.DB, mk({ title: "Mine", body: "Please fix.", priority: "high", category: "bug", assignees: ["dev"], sprint_id: sprintId }), "meilin");
    await create_ticket(env.DB, mk({ title: "Theirs", assignees: ["meilin"] }), "meilin");
    await create_ticket(env.DB, mk({ title: "Nobody's" }), "meilin");

    const work = await getMyWork(env.DB, "dev");
    expect(work.tickets.map((t) => t.title)).toEqual(["Mine"]);
    expect(work.tickets[0]).toMatchObject({
      id: mine, title: "Mine", body: "Please fix.", category: "bug", priority: "high",
      status: "submitted", requester: "meilin", sprint: { id: sprintId, label: "Sprint 13 — Tickets" },
    });
  });

  it("a ticket with no sprint carries sprint: null (Backlog)", async () => {
    await seedPerson("dev", { name: "Dev" });
    await create_ticket(env.DB, mk({ title: "Backlogged", assignees: ["dev"] }), "dev");
    const work = await getMyWork(env.DB, "dev");
    expect(work.tickets[0].sprint).toBeNull();
  });

  it("drops a ticket once a person closes it (done AND declined), and never puts tickets in todo", async () => {
    await seedPerson("dev", { name: "Dev" });
    const a = await create_ticket(env.DB, mk({ title: "Will be done", assignees: ["dev"] }), "dev");
    const b = await create_ticket(env.DB, mk({ title: "Will be declined", assignees: ["dev"] }), "dev");
    const c = await create_ticket(env.DB, mk({ title: "Stays open", assignees: ["dev"] }), "dev");

    await transition_ticket(env.DB, a, "in_progress", "dev");
    await transition_ticket(env.DB, a, "done", "dev");
    await transition_ticket(env.DB, b, "declined", "dev");

    const work = await getMyWork(env.DB, "dev");
    expect(work.tickets.map((t) => t.id)).toEqual([c]);
    expect(work.todo).toEqual([]); // tickets are NEVER folded into the GitHub-issue list
  });

  it("orders by updated_at DESC — a touched ticket jumps to the front", async () => {
    await seedPerson("dev", { name: "Dev" });
    const first_ = await create_ticket(env.DB, mk({ title: "First", assignees: ["dev"] }), "dev");
    await new Promise((r) => setTimeout(r, 5));
    const second = await create_ticket(env.DB, mk({ title: "Second", assignees: ["dev"] }), "dev");
    expect((await getMyWork(env.DB, "dev")).tickets.map((t) => t.title)).toEqual(["Second", "First"]);

    await new Promise((r) => setTimeout(r, 5));
    await transition_ticket(env.DB, first_, "in_progress", "dev");
    expect((await getMyWork(env.DB, "dev")).tickets.map((t) => t.title)).toEqual(["First", "Second"]);
    expect(second).toBeGreaterThan(first_);
  });

  it("caps the list at 6, keeping the most recently updated", async () => {
    await seedPerson("dev", { name: "Dev" });
    for (let i = 1; i <= 8; i++) {
      await create_ticket(env.DB, mk({ title: `T${i}`, assignees: ["dev"] }), "dev");
      await new Promise((r) => setTimeout(r, 3));
    }
    const work = await getMyWork(env.DB, "dev");
    expect(work.tickets).toHaveLength(6);
    expect(work.tickets.map((t) => t.title)).toEqual(["T8", "T7", "T6", "T5", "T4", "T3"]);
    // The list is capped; the count is not — "6 open" must never be said of 8.
    expect(work.ticketsTotal).toBe(8);
  });

  it("ticketsTotal counts only OPEN tickets assigned to me, and matches the list when uncapped", async () => {
    await seedPerson("dev", { name: "Dev" });
    await seedPerson("meilin", { name: "Meilin Zhao", github: false });
    await create_ticket(env.DB, mk({ title: "Open", assignees: ["dev"] }), "dev");
    const closed = await create_ticket(env.DB, mk({ title: "Closed", assignees: ["dev"] }), "dev");
    await transition_ticket(env.DB, closed, "declined", "dev");
    await create_ticket(env.DB, mk({ title: "Theirs", assignees: ["meilin"] }), "meilin");
    const work = await getMyWork(env.DB, "dev");
    expect(work.tickets.map((t) => t.title)).toEqual(["Open"]);
    expect(work.ticketsTotal).toBe(1);
    expect(work.tickets[0].source).toBe("canopy");
  });

  it("matches the assignee handle case-INSENSITIVELY, like persons.handle and getPerson", async () => {
    // `persons.handle` is NOCASE and `getPerson` resolves "caseyq" → "CaseyQ". If
    // the ticket join stayed case-sensitive the person would be told "No tickets
    // assigned to you" while holding the whole queue — a silent wrong answer.
    await seedPerson("CaseyQ", { name: "Casey Quinn" });
    await create_ticket(env.DB, mk({ title: "Cased", assignees: ["CaseyQ"] }), "CaseyQ");

    const canonical = await getMyWork(env.DB, "CaseyQ");
    expect(canonical.tickets.map((t) => t.title)).toEqual(["Cased"]);

    const lowered = await getMyWork(env.DB, "caseyq");
    expect(lowered.person).toBe("Casey Quinn");
    expect(lowered.tickets.map((t) => t.title)).toEqual(["Cased"]);
  });

  it("a Google-only person (no github identity) still sees their tickets", async () => {
    await seedPerson("sanaok", { name: "Sana Okafor", github: false });
    await create_ticket(env.DB, mk({ title: "Access request", assignees: ["sanaok"] }), "sanaok");
    const work = await getMyWork(env.DB, "sanaok");
    expect(work.person).toBe("Sana Okafor");
    expect(work.tickets.map((t) => t.title)).toEqual(["Access request"]);
    expect(work.previousActivity).toEqual([]);
    expect(work.todo).toEqual([]);
  });
});

// ── sources: My Work lists mirrored tickets too; the digest's default does not ──
describe("listAssignedTickets — sources", () => {
  it("defaults to NATIVE only (the digest's rule); `all` adds mirrored tickets, and the count follows the same rule", async () => {
    await seedPerson("dev", { name: "Dev" });
    const native = await create_ticket(env.DB, { title: "Native", body: "", category: "other", priority: "normal", assignees: ["dev"] }, "dev");
    const mirrored = await create_ticket(env.DB, { title: "Mirrored", body: "", category: "other", priority: "normal", assignees: ["dev"] }, "dev");
    await run(env.DB, `UPDATE tickets SET source = 'github', source_ref = 'o/r#9' WHERE id = ?`, mirrored);

    expect((await listAssignedTickets(env.DB, "dev")).map((t) => t.id)).toEqual([native]);
    expect(await countAssignedTickets(env.DB, "dev")).toBe(1);
    const all_ = await listAssignedTickets(env.DB, "dev", { sources: "all" });
    expect(all_.map((t) => t.id).sort()).toEqual([native, mirrored].sort());
    expect(all_.find((t) => t.id === mirrored)!.source).toBe("github");
    expect(await countAssignedTickets(env.DB, "dev", "all")).toBe(2);

    const work = await getMyWork(env.DB, "dev");
    expect(work.tickets.map((t) => t.title).sort()).toEqual(["Mirrored", "Native"]);
    expect(work.ticketsTotal).toBe(2);
  });
});
