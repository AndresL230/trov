/**
 * Phase 1 — the three renderers, against real D1 fixtures. Every renderer is a
 * pure read: the tests also assert nothing was written.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { platformCtx, systemCtx } from "./helpers/tenant";
import { all, first, run } from "../src/db";
import { ingestEvent, ingestDocProposal, ingestAdrDraft } from "../src/consumer";
import { promote_doc } from "../src/tools/writes";
import { storePrSummary, type Summarizer, type PrSummary } from "../src/tools/summarize";
import { write_plan } from "../src/tools/plan";
import { upsertProgress } from "../src/tools/progress";
import { getKind } from "../src/notifications/registry";
import { seedPerson } from "./helpers/persons";
import type { Window } from "@shared/notifications";
import type { CapturedEvent } from "@shared/contract";

// Window under test: the 24h ending 2026-09-11T12:00Z.
const WINDOW: Window = {
  cadence: "daily",
  start: new Date("2026-09-10T12:00:00.000Z"),
  end: new Date("2026-09-11T12:00:00.000Z"),
  id: "2026-09-11",
};
const IN_WINDOW = "2026-09-11T03:00:00Z"; // GitHub-style (no millis) — must still fall inside
const BEFORE_WINDOW = "2026-09-09T03:00:00Z";
const LOGIN = "AndresL230"; // resolved via persons + identities by the harness reset

function prEvent(number: number, login: string, occurredAt: string, title = `PR ${number}`): CapturedEvent {
  return {
    semantic_key: `gh:pr:${number}:merged`,
    event_type: "pr_merged",
    ref_number: number,
    subject_login: login,
    raw: JSON.stringify({
      pr: { number, title, body: "b", html_url: `https://github.com/o/r/pull/${number}`, merged: true, merged_at: occurredAt, user: { login }, base: { ref: "main" } },
    }),
    provenance: "webhook",
    occurred_at: occurredAt,
  };
}

function issueEvent(number: number, login: string, state: "open" | "closed", updatedAt: string, title = `Issue ${number}`): CapturedEvent {
  return {
    semantic_key: `gh:issue:${number}:${state}:${updatedAt}`,
    event_type: "issue",
    ref_number: number,
    subject_login: login,
    // `milestone` below is GitHub's own key — not Trov vocabulary.
    raw: JSON.stringify({
      action: state === "open" ? "assigned" : "closed",
      issue: { number, title, html_url: `https://github.com/o/r/issues/${number}`, state, updated_at: updatedAt, user: { login }, assignees: [{ login }], labels: [], milestone: null },
    }),
    provenance: "webhook",
    occurred_at: updatedAt,
  };
}

const stubSummarizer = (s: PrSummary): Summarizer<PrSummary> => ({ model: "stub", summarize: async () => s });

async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["events", "pr_summaries", "issue_summaries", "doc_versions", "adrs", "plan_versions", "sprints", "sprint_progress", "needs_triage", "feed"]) {
    out[t] = (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${t}`))!.n;
  }
  return out;
}

describe("my_work renderer", () => {
  const kind = () => getKind("my_work")!;

  it("returns null when the user has no merged PRs in the window and no open assigned issues", async () => {
    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, LOGIN, BEFORE_WINDOW), "github-webhook");
    await ingestEvent(systemCtx(), platformCtx(), issueEvent(2, LOGIN, "closed", IN_WINDOW), "github-webhook");
    expect(await kind().render(env.DB, LOGIN, WINDOW)).toBeNull();
  });

  it("includes a merged PR in the window with its stored structured summary, excluding PRs before the window", async () => {
    await ingestEvent(systemCtx(), platformCtx(), prEvent(10, LOGIN, IN_WINDOW, "Raw PR title"), "github-webhook");
    await storePrSummary(systemCtx(), stubSummarizer({ title: "Humanized ten", what: "Did the thing", why: "Because", impact: "Users win" }), { semantic_key: "gh:pr:10:merged", pr_number: 10, title: "Raw PR title", body: "b" });
    await ingestEvent(systemCtx(), platformCtx(), prEvent(11, LOGIN, BEFORE_WINDOW, "Old PR"), "github-webhook");

    const before = await tableCounts();
    const s = await kind().render(env.DB, LOGIN, WINDOW);
    expect(await tableCounts()).toEqual(before); // pure read

    expect(s).not.toBeNull();
    expect(s!.deepLink).toBe("/#mywork");
    expect(s!.html).toContain("Humanized ten");
    expect(s!.html).toContain("Did the thing");
    expect(s!.html).toContain("https://github.com/o/r/pull/10");
    expect(s!.html).not.toContain("Old PR");
    expect(s!.text).toContain("Humanized ten");
    expect(s!.text).not.toContain("Old PR");
  });

  it("falls back to the raw PR title and a placeholder when the summary is an excerpt-fallback row", async () => {
    await ingestEvent(systemCtx(), platformCtx(), prEvent(12, LOGIN, IN_WINDOW, "Only raw"), "github-webhook");
    await storePrSummary(systemCtx(), null, { semantic_key: "gh:pr:12:merged", pr_number: 12, title: "Only raw", body: "b" });
    const s = await kind().render(env.DB, LOGIN, WINDOW);
    expect(s!.html).toContain("Only raw");
    expect(s!.html).toContain("No summary recorded");
  });

  it("lists open assigned issues (latest snapshot wins) and omits closed and other people's issues", async () => {
    await ingestEvent(systemCtx(), platformCtx(), issueEvent(20, LOGIN, "open", BEFORE_WINDOW, "Mine open"), "github-webhook");
    await ingestEvent(systemCtx(), platformCtx(), issueEvent(21, LOGIN, "open", BEFORE_WINDOW, "Was open"), "github-webhook");
    await ingestEvent(systemCtx(), platformCtx(), issueEvent(21, LOGIN, "closed", IN_WINDOW, "Was open"), "github-webhook");
    await ingestEvent(systemCtx(), platformCtx(), issueEvent(22, "lpcooper-arch", "open", IN_WINDOW, "Lukes"), "github-webhook");

    const s = await kind().render(env.DB, LOGIN, WINDOW);
    expect(s).not.toBeNull();
    expect(s!.html).toContain("Mine open");
    expect(s!.html).not.toContain("Was open");
    expect(s!.html).not.toContain("Lukes");
    expect(s!.text).toContain("Mine open");
  });

  it("escapes HTML in titles", async () => {
    await ingestEvent(systemCtx(), platformCtx(), issueEvent(30, LOGIN, "open", IN_WINDOW, "<script>alert(1)</script>"), "github-webhook");
    const s = await kind().render(env.DB, LOGIN, WINDOW);
    expect(s!.html).not.toContain("<script>");
    expect(s!.html).toContain("&lt;script&gt;");
  });

  it("returns null for a login not in the identity map, matching My Work", async () => {
    await ingestEvent(systemCtx(), platformCtx(), prEvent(40, "unmapped-login", IN_WINDOW), "github-webhook");
    expect(await kind().render(env.DB, "unmapped-login", WINDOW)).toBeNull();
  });

  it("returns null for a person with no GitHub identity (Google-only), even though the window has other people's content", async () => {
    await seedPerson("priya", { name: "Priya", github: false, email: "priya@example.com" });
    // Content exists in the window, but it belongs to someone else — proves the
    // identity gate short-circuits render before any event is queried for
    // priya, not merely that there happens to be nothing to show.
    await ingestEvent(systemCtx(), platformCtx(), prEvent(41, LOGIN, IN_WINDOW), "github-webhook");
    await ingestEvent(systemCtx(), platformCtx(), issueEvent(42, LOGIN, "open", IN_WINDOW), "github-webhook");
    expect(await kind().render(env.DB, "priya", WINDOW)).toBeNull();
  });
});

describe("review_queue renderer", () => {
  const kind = () => getKind("review_queue")!;

  it("returns null when there are no open proposals and no draft decisions", async () => {
    expect(await kind().render(env.DB, LOGIN, WINDOW)).toBeNull();
  });

  it("reports counts and top items for staged doc versions and draft ADRs, excluding ratified/promoted", async () => {
    // A promoted v1 (live), then a staged v2 → one open proposal.
    await ingestDocProposal(systemCtx(), { slug: "auth-flow", section: "reference", title: "Auth flow", body: "v1", change_summary: "init", confidence: "high" }, "agent");
    await promote_doc(systemCtx(), "auth-flow", 1, "human");
    await ingestDocProposal(systemCtx(), { slug: "auth-flow", section: "reference", title: "Auth flow", body: "v2 proposed", change_summary: "edit", confidence: "high" }, "agent");
    // A fully promoted doc contributes nothing to the queue.
    await ingestDocProposal(systemCtx(), { slug: "settled-doc", section: "reference", title: "Settled doc", body: "s", change_summary: "init", confidence: "high" }, "agent");
    await promote_doc(systemCtx(), "settled-doc", 1, "human");
    await ingestAdrDraft(systemCtx(), { title: "Use D1 for outbox", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await ingestAdrDraft(systemCtx(), { title: "Already ratified", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await run(env.DB, `UPDATE adrs SET status = 'ratified' WHERE title = 'Already ratified'`);

    const before = await tableCounts();
    const s = await kind().render(env.DB, LOGIN, WINDOW);
    expect(await tableCounts()).toEqual(before);

    expect(s).not.toBeNull();
    expect(s!.deepLink).toBe("/#review");
    expect(s!.summary).toBe("1 proposal, 1 decision waiting on review");
    expect(s!.html).toContain("Auth flow");
    expect(s!.html).toContain("Use D1 for outbox");
    expect(s!.html).not.toContain("Already ratified");
    expect(s!.html).not.toContain("Settled doc");
  });
});

describe("roadmap_plan renderer", () => {
  const kind = () => getKind("roadmap_plan")!;
  const AUTHOR = "admin";

  async function stampLatestVersion(createdAt: string): Promise<void> {
    await run(env.DB, `UPDATE plan_versions SET created_at = ? WHERE version = (SELECT MAX(version) FROM plan_versions)`, createdAt);
  }

  it("returns null when no plan version rows fall in the window", async () => {
    await write_plan(env.DB, { narrative: "n", sprints: [{ label: "M1", due: "2026-10-01", status: "upcoming" }] }, AUTHOR);
    await stampLatestVersion(BEFORE_WINDOW);
    expect(await kind().render(env.DB, LOGIN, WINDOW)).toBeNull();
  });

  it("returns null when only progress rows changed in the window (progress layer excluded)", async () => {
    const r = await write_plan(env.DB, { narrative: "n", sprints: [{ label: "M1", due: "2026-10-01", status: "upcoming", github_ref: 7 }] }, AUTHOR);
    await stampLatestVersion(BEFORE_WINDOW);
    await upsertProgress(env.DB, r.sprints[0].id, 3, 5, "event");
    await run(env.DB, `UPDATE sprint_progress SET computed_at = ?`, IN_WINDOW);
    expect(await kind().render(env.DB, LOGIN, WINDOW)).toBeNull();
  });

  it("reports a sprint added in the window", async () => {
    await write_plan(env.DB, { narrative: "n", sprints: [{ label: "M1", due: "2026-10-01", status: "upcoming" }] }, AUTHOR);
    await stampLatestVersion(BEFORE_WINDOW);
    await write_plan(env.DB, { narrative: "n", sprints: [{ label: "M2 new", due: "2026-11-01", status: "upcoming" }] }, AUTHOR);
    await stampLatestVersion(IN_WINDOW);

    const before = await tableCounts();
    const s = await kind().render(env.DB, LOGIN, WINDOW);
    expect(await tableCounts()).toEqual(before);

    expect(s).not.toBeNull();
    expect(s!.deepLink).toBe("/#roadmap");
    expect(s!.text).toMatch(/added\s+M2 new/);
    expect(s!.html).toContain("M2 new");
    expect(s!.html).not.toMatch(/ADDED.*M1/);
  });

  it("reports title and description changes", async () => {
    const r = await write_plan(env.DB, { narrative: "n", sprints: [{ label: "Old title", description: "old d", due: "2026-10-01", status: "upcoming" }] }, AUTHOR);
    await stampLatestVersion(BEFORE_WINDOW);
    const id = r.sprints[0].id;
    await write_plan(env.DB, { narrative: "n", sprints: [{ id, label: "New title", description: "new d", due: "2026-10-01", status: "upcoming" }] }, AUTHOR);
    await stampLatestVersion(IN_WINDOW);

    const s = await kind().render(env.DB, LOGIN, WINDOW);
    expect(s!.text).toMatch(/changed\s+Old title → New title/);
    expect(s!.text).toMatch(/changed\s+New title — description updated/);
  });

  it("reports a reorder when target dates swap the sprint order", async () => {
    const r = await write_plan(env.DB, { narrative: "n", sprints: [
      { label: "First", due: "2026-10-01", status: "upcoming" },
      { label: "Second", due: "2026-11-01", status: "upcoming" },
    ] }, AUTHOR);
    await stampLatestVersion(BEFORE_WINDOW);
    const first_ = r.sprints.find((m) => m.title === "First")!;
    await write_plan(env.DB, { narrative: "n", sprints: [{ id: first_.id, label: "First", due: "2026-12-01", status: "upcoming" }] }, AUTHOR);
    await stampLatestVersion(IN_WINDOW);

    const s = await kind().render(env.DB, LOGIN, WINDOW);
    expect(s!.text).toMatch(/reordered\s+.*First/);
    expect(s!.text).toContain("First");
  });

  it("reports a sprint confirmed done", async () => {
    const r = await write_plan(env.DB, { narrative: "n", sprints: [{ label: "Ship it", due: "2026-10-01", status: "in_progress" }] }, AUTHOR);
    await stampLatestVersion(BEFORE_WINDOW);
    await write_plan(env.DB, { narrative: "n", sprints: [{ id: r.sprints[0].id, label: "Ship it", due: "2026-10-01", status: "done" }] }, AUTHOR);
    await stampLatestVersion(IN_WINDOW);

    const s = await kind().render(env.DB, LOGIN, WINDOW);
    expect(s!.text).toMatch(/done\s+Ship it — confirmed complete/);
  });

  it("diffs the latest in-window version against the last version BEFORE the window, not the previous version", async () => {
    // v1 before window: M1. v2 in window: +M2. v3 in window: +M3. Report both M2 and M3 as added.
    await write_plan(env.DB, { narrative: "n", sprints: [{ label: "M1", due: "2026-10-01", status: "upcoming" }] }, AUTHOR);
    await stampLatestVersion(BEFORE_WINDOW);
    await write_plan(env.DB, { narrative: "n", sprints: [{ label: "M2", due: "2026-11-01", status: "upcoming" }] }, AUTHOR);
    await stampLatestVersion("2026-09-10T20:00:00Z");
    await write_plan(env.DB, { narrative: "n", sprints: [{ label: "M3", due: "2026-12-01", status: "upcoming" }] }, AUTHOR);
    await stampLatestVersion(IN_WINDOW);

    const s = await kind().render(env.DB, LOGIN, WINDOW);
    expect(s!.text).toMatch(/added\s+M2/);
    expect(s!.text).toMatch(/added\s+M3/);
  });

  it("returns null when an in-window version changed nothing at the sprint level", async () => {
    await write_plan(env.DB, { narrative: "n", sprints: [{ label: "M1", due: "2026-10-01", status: "upcoming" }] }, AUTHOR);
    await stampLatestVersion(BEFORE_WINDOW);
    await write_plan(env.DB, { narrative: "narrative only", sprints: [] }, AUTHOR);
    await stampLatestVersion(IN_WINDOW);
    expect(await kind().render(env.DB, LOGIN, WINDOW)).toBeNull();
  });

  it("treats every sprint as added when there is no version before the window", async () => {
    await write_plan(env.DB, { narrative: "n", sprints: [{ label: "Genesis", due: "2026-10-01", status: "upcoming" }] }, AUTHOR);
    await stampLatestVersion(IN_WINDOW);
    const s = await kind().render(env.DB, LOGIN, WINDOW);
    expect(s!.text).toMatch(/added\s+Genesis/);
  });
});
