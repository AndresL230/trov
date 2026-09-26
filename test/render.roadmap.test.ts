/**
 * Task 15 render tests — Roadmap screen rebuild (admin narrative + cached progress).
 *
 * Tests pure helper functions exported from web/src/render.ts:
 *  • planNarrativeBlock — the ADMIN-authored plan narrative rendered via an injected
 *    markdown fn (the injected-markdownFn pattern); empty → dashed-card hint.
 *  • render() over a roadmap-populated AppState — narrative tab shows the narrative,
 *    timeline tab shows cached progress ("4/6 closed"), phase mono suffix, and the
 *    Confirm-done button; search results of type "sprint" navigate via goRoadmap.
 *
 * All tests are pure (no D1 / Miniflare bindings) and assertions are HTML-string based.
 * The module-level renderMarkdown (marked + DOMPurify) cannot run in this workerd test
 * environment (DOMPurify needs DOM globals — same reason render.triage.test.ts and
 * render.mywork.test.ts never drive it), so the markdown module is vi.mock'd with an
 * ESCAPING mock: anything that appears inside the mock wrapper provably went through
 * the markdown fn (the XSS discipline under test), never raw interpolation.
 */
import { describe, it, expect, vi } from "vitest";

// Hoisted above the render.ts import — full render() trees use this mock in place of
// the real marked+DOMPurify pipeline. It escapes its input so the "was the markdown fn
// what produced the output?" assertion is direct: raw <script> can never survive it.
vi.mock("../web/src/markdown", () => ({
  renderMarkdownInline: (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>"),
  renderMarkdown: (body: string) =>
    `<div class="mock-live-md">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`,
}));

import { planNarrativeBlock, render, initialState } from "../web/src/render";
import type { PlanView, SprintView, FeedRow } from "../web/src/api";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Mock markdown function for direct planNarrativeBlock calls (pattern: render.triage.test.ts). */
const mockMd = (body: string) => `<div class="mock-md">${body}</div>`;

/** Escaping mock — mirrors what a sanitizer does, for the XSS assertions. */
const escMockMd = (body: string) =>
  `<div class="mock-md">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`;

function makeSprint(overrides: Partial<SprintView> = {}): SprintView {
  return {
    id: 1,
    label: "Vectorize GA",
    summary: null,
    description: "Ship semantic search to everyone.",
    phase: null,
    dates: null,
    due: "2026-09-01",
    status: "in_progress",
    active: true,
    urgency: "normal",
    lead: null,
    domain: null,
    github_ref: null,
    created_at: "2026-07-01T00:00:00Z",
    created_by: "admin",
    updated_at: null,
    progress: { closed: 4, total: 6, pct: 67 },
    issues: null,
    members: [],
    ...overrides,
  };
}

function makePlanView(overrides: Partial<PlanView> = {}): PlanView {
  return {
    narrative: "The plan **narrative** prose.",
    version: 3,
    updated_at: "2026-07-02T00:00:00Z",
    updated_by: "admin",
    sprints: [makeSprint()],
    ...overrides,
  };
}

function stateWithPlan(plan: PlanView, tab: "narrative" | "timeline"): ReturnType<typeof initialState> {
  const s = initialState();
  return {
    ...s,
    view: "app",
    screen: "roadmap",
    roadmapTab: tab,
    me: { handle: "alice", name: "Alice", avatar_url: null, color: "moss", identities: [], org: "SaplingLearn", admin: false },
    roadmap: { status: "ok", data: plan },
  };
}

// ── planNarrativeBlock ────────────────────────────────────────────────────────

describe("planNarrativeBlock", () => {
  it("renders the narrative through the injected markdown fn inside a cnpy-md wrapper", () => {
    const html = planNarrativeBlock("Some **plan** prose.", mockMd);
    expect(html).toContain("mock-md");
    expect(html).toContain("Some **plan** prose.");
    expect(html).toContain('class="cnpy-md"');
  });

  it("empty narrative → dashed-card hint, no markdown wrapper", () => {
    const html = planNarrativeBlock("", mockMd);
    expect(html).toContain("No plan narrative yet — write one with the update-plan skill");
    expect(html).not.toContain("mock-md");
    expect(html).not.toContain("cnpy-md");
    expect(html).toContain("dashed");
  });

  it("whitespace-only narrative also falls back to the hint", () => {
    const html = planNarrativeBlock("   \n  ", mockMd);
    expect(html).toContain("No plan narrative yet");
    expect(html).not.toContain("mock-md");
  });

  it("XSS: the narrative goes ONLY through markdownFn — an escaping mock leaves no raw <script>", () => {
    const html = planNarrativeBlock('<script>alert(1)</script>', escMockMd);
    // The mock fn is what produced the output (its wrapper is present)…
    expect(html).toContain("mock-md");
    // …and the raw payload never appears unescaped anywhere in the block.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ── full render() — narrative tab ────────────────────────────────────────────

describe("render() — Roadmap narrative tab", () => {
  it("opens with the admin narrative rendered via the markdown module", () => {
    const html = render(stateWithPlan(makePlanView(), "narrative"));
    expect(html).toContain("mock-live-md");
    expect(html).toContain("The plan **narrative** prose.");
  });

  it("keeps the sprint spotlight and Recent happenings sections below the narrative", () => {
    const html = render(stateWithPlan(makePlanView(), "narrative"));
    expect(html).toContain(">NOW<"); // spotlight badge for the in-progress sprint
    expect(html).toContain("Vectorize GA");
    expect(html).toContain("Recent happenings");
    // Narrative block precedes the spotlight
    expect(html.indexOf("mock-live-md")).toBeLessThan(html.indexOf(">NOW<"));
  });

  it("the spotlight is the ONE place the cached GitHub issue counts appear — 'N/M issues closed' beside the chips", () => {
    const withIssues = makeSprint({
      id: 7, label: "Vectorize GA", status: "in_progress", github_ref: "[41,42,43]",
      progress: { closed: 1, total: 4, pct: 25 }, issues: { closed: 2, total: 3 },
    });
    const html = render(stateWithPlan(makePlanView({ sprints: [withIssues] }), "narrative"));
    expect(html).toContain("2/3 issues closed");
    // …and it sits with the issue chips it explains.
    expect(html).toContain("#41");
    expect(html.indexOf("#41")).toBeLessThan(html.indexOf("2/3 issues closed"));
    // The tickets-only bar is unaffected by the issue counts.
    expect(html).toContain("1/4 closed");
    expect(html).not.toContain("3/7");
  });

  it("the spotlight shows nothing when `issues` is null", () => {
    const noIssues = makeSprint({
      id: 8, label: "Vectorize GA", status: "in_progress",
      progress: { closed: 1, total: 4, pct: 25 }, issues: null,
    });
    const html = render(stateWithPlan(makePlanView({ sprints: [noIssues] }), "narrative"));
    expect(html).toContain(">NOW<");
    expect(html).not.toContain("issues closed");
  });

  it("the Timeline tab never shows the issue counts — they are narrative-only", () => {
    const withIssues = makeSprint({
      id: 7, label: "Vectorize GA", status: "in_progress", github_ref: "[41,42,43]",
      progress: { closed: 1, total: 4, pct: 25 }, issues: { closed: 2, total: 3 },
    });
    const html = render(stateWithPlan(makePlanView({ sprints: [withIssues] }), "timeline"));
    expect(html).toContain("1/4 done");      // the tickets-only bar
    expect(html).not.toContain("issues closed");
    expect(html).not.toContain("2/3");
  });

  it("empty narrative → the update-plan hint in the narrative tab", () => {
    const html = render(stateWithPlan(makePlanView({ narrative: "" }), "narrative"));
    expect(html).toContain("No plan narrative yet — write one with the update-plan skill");
    expect(html).not.toContain("mock-live-md");
  });

  it("XSS: a <script> narrative reaches the DOM only via the (sanitizing) markdown module", () => {
    const html = render(stateWithPlan(makePlanView({ narrative: '<script>alert(1)</script>' }), "narrative"));
    expect(html).toContain("mock-live-md"); // the markdown fn produced the output
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ── full render() — timeline tab ─────────────────────────────────────────────

describe("render() — Roadmap timeline tab", () => {
  it("shows the sprint's TICKET progress as 4/6 done (no live GitHub, no issue counts)", () => {
    const html = render(stateWithPlan(makePlanView(), "timeline"));
    expect(html).toContain("4/6 done");
  });

  it("shows the phase as a small mono suffix before the date label, · separated", () => {
    const plan = makePlanView({ sprints: [makeSprint({ phase: "Phase 2 — reads" })] });
    const html = render(stateWithPlan(plan, "timeline"));
    expect(html).toContain("Phase 2 — reads · ");
    // Date label is kept alongside the phase (target 2026-09-01 → "Sep 1, 2026")
    expect(html).toContain("Sep 1, 2026");
  });

  it("omits the phase suffix when phase is null", () => {
    const html = render(stateWithPlan(makePlanView(), "timeline"));
    expect(html).not.toContain("null · ");
    expect(html).toContain("Sep 1, 2026");
  });

  it("XSS: a malicious phase is escaped", () => {
    const plan = makePlanView({ sprints: [makeSprint({ phase: '<img src=x onerror=alert(1)>' })] });
    const html = render(stateWithPlan(plan, "timeline"));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("keeps the Confirm-done button for a ready sprint (all its TICKETS resolved, not done)", () => {
    const ready = makeSprint({ id: 9, label: "All wrapped", progress: { closed: 6, total: 6, pct: 100 } });
    const html = render(stateWithPlan(makePlanView({ sprints: [ready] }), "timeline"));
    expect(html).toContain('data-act="confirmSprint"');
    expect(html).toContain('data-arg="9"');
    expect(html).toContain("Confirm done");
  });

  it("the ready rule is TICKETS only: open GitHub issues never block it, closed ones never grant it", () => {
    // Every ticket resolved but the cached issues are still open → still ready.
    const ready = makeSprint({
      id: 10, label: "Tickets all done", progress: { closed: 6, total: 6, pct: 100 },
      issues: { closed: 0, total: 9 },
    });
    expect(render(stateWithPlan(makePlanView({ sprints: [ready] }), "timeline"))).toContain('data-act="confirmSprint"');

    // Every cached ISSUE closed but tickets still open → NOT ready.
    const notReady = makeSprint({
      id: 11, label: "Issues all done", progress: { closed: 1, total: 6, pct: 17 },
      issues: { closed: 9, total: 9 },
    });
    const html = render(stateWithPlan(makePlanView({ sprints: [notReady] }), "timeline"));
    expect(html).not.toContain('data-act="confirmSprint"');
    expect(html).not.toContain("ready to complete");
  });

  it("a sprint with nothing to count (0/0) shows no progress bar and is never 'ready to complete'", () => {
    // SprintView.progress is always present; total 0 is the "no tickets" case,
    // which must render exactly like the old progress:null sprint did.
    const empty = makeSprint({ id: 4, label: "Nothing counted", progress: { closed: 0, total: 0, pct: 0 } });
    const html = render(stateWithPlan(makePlanView({ sprints: [empty] }), "timeline"));
    expect(html).toContain("Nothing counted");
    expect(html).not.toContain("0/0 done");
    expect(html).not.toContain("ready to complete");
    expect(html).not.toContain('data-act="confirmSprint"');
  });

  it("an unscheduled sprint (due: null) reads 'No target date' and is never overdue", () => {
    const unscheduled = makeSprint({ id: 5, label: "Unscheduled", due: null, status: "upcoming", progress: { closed: 0, total: 0, pct: 0 } });
    const html = render(stateWithPlan(makePlanView({ sprints: [unscheduled] }), "timeline"));
    expect(html).toContain("No target date");
    expect(html).not.toContain(">OVERDUE<");
    expect(html).not.toContain("Invalid Date");
  });
});

// ── Recent happenings — GitHub artifact chips (feedArtifacts, via render) ─────
// Prod feed rows carry PRs as full pull URLs and commits as full 40-char SHAs
// (the intended bare-id shape is only what the append_feed helper produces). The
// chip LABEL must be the short human form; the href keeps the full/canonical ref.

function feedRow(overrides: Partial<FeedRow> = {}): FeedRow {
  return {
    id: 1,
    author: "AndresL230",
    summary: "shipped a thing",
    brief: null,
    body: null,
    artifacts: null,
    created_at: "2026-07-07T09:00:00Z",
    ...overrides,
  };
}

function stateWithFeed(artifacts: string): ReturnType<typeof initialState> {
  const s = stateWithPlan(makePlanView(), "narrative");
  return { ...s, feed: { status: "ok", data: [feedRow({ artifacts })] } };
}

describe("render() — Recent happenings GitHub chips", () => {
  it("renders a PR given as a full pull URL as #<number>, not the URL", () => {
    const html = render(stateWithFeed(
      JSON.stringify({ prs: ["https://github.com/SaplingLearn/Sapling/pull/321"], commits: [], issues: [] }),
    ));
    expect(html).toContain(">#321<");           // clean label
    expect(html).not.toContain(">#https://");    // never the URL as the label
    // href still points at the real (possibly cross-repo) PR
    expect(html).toContain("https://github.com/SaplingLearn/Sapling/pull/321");
  });

  it("keeps the correct href for a cross-repo PR URL (not rewritten to REPO_URL)", () => {
    const html = render(stateWithFeed(
      JSON.stringify({ prs: ["https://github.com/SaplingLearn/canopy/pull/7"], commits: [], issues: [] }),
    ));
    expect(html).toContain(">#7<");
    expect(html).toContain("https://github.com/SaplingLearn/canopy/pull/7");
  });

  it("shortens a full commit SHA to 7 chars in the label, keeps the full SHA in the href", () => {
    const html = render(stateWithFeed(
      JSON.stringify({ prs: [], commits: ["8ad9756a407f0b2a3092cbfbb93f1dbc197546c3"], issues: [] }),
    ));
    expect(html).toContain(">8ad9756<");                                              // short label
    expect(html).not.toContain(">8ad9756a407f");                                      // not the full SHA as label
    expect(html).toContain("/commit/8ad9756a407f0b2a3092cbfbb93f1dbc197546c3");       // full SHA in href
  });

  it("still renders bare-numeric PRs and issues unchanged", () => {
    const html = render(stateWithFeed(
      JSON.stringify({ prs: ["14"], commits: [], issues: [292] }),
    ));
    expect(html).toContain(">#14<");
    expect(html).toContain(">#292<");
    expect(html).toContain("/pull/14");
  });
});

// ── search results — sprint type navigates to the Roadmap screen ────────────

describe("search results — sprint hits navigate via goRoadmap", () => {
  it("a sprint-typed primary result renders as a goRoadmap button", () => {
    const s = initialState();
    const html = render({
      ...s,
      view: "app",
      screen: "search",
      me: { handle: "alice", name: "Alice", avatar_url: null, color: "moss", identities: [], org: "SaplingLearn", admin: false },
      searchResults: {
        status: "ok",
        data: {
          primary: [{
            type: "sprint", id: "sprint:1", title: "Vectorize GA",
            section: null, space: null, body: "Ship semantic search.",
            authority: "live", current_version: null, pending_version: null,
            staged_body: null, confidence: null,
            updated_at: null, updated_by: null, score: 1,
          }],
          pointers: [],
          meta: { engine: "fts5", total: 1 },
        },
      },
    });
    expect(html).toContain('data-act="goRoadmap"');
  });

  it("a sprint-typed pointer result also gets the goRoadmap action", () => {
    const s = initialState();
    const html = render({
      ...s,
      view: "app",
      screen: "search",
      me: { handle: "alice", name: "Alice", avatar_url: null, color: "moss", identities: [], org: "SaplingLearn", admin: false },
      searchResults: {
        status: "ok",
        data: {
          primary: [],
          pointers: [{ type: "sprint", id: "sprint:2", title: "Plan hit", snippet: "…", authority: "live", score: 1 }],
          meta: { engine: "fts5", total: 1 },
        },
      },
    });
    expect(html).toContain('data-act="goRoadmap"');
  });
});
