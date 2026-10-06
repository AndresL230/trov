/**
 * Task 15 render tests — Roadmap screen rebuild (admin narrative + cached progress).
 *
 * Tests pure helper functions exported from web/src/render.ts:
 *  • planNarrativeBlock — the ADMIN-authored plan narrative rendered via an injected
 *    markdown fn (the injected-markdownFn pattern); empty → dashed-card hint.
 *  • render() over a roadmap-populated AppState — narrative tab shows the narrative,
 *    the New sprint toggle and the sprint cards (ticket progress "4/6 done", phase
 *    suffix, Confirm-done); the timeline tab is the calendar (web/src/timeline.ts,
 *    see render.timeline.test.ts); search results of type "sprint" navigate via goRoadmap;
 *    Narrative / Timeline are the underline tab bar heading the page body (tabs.ts).
 *
 * All tests are pure (no D1 / Miniflare bindings) and assertions are HTML-string based.
 * The module-level renderMarkdown (marked + DOMPurify) cannot run in this workerd test
 * environment (DOMPurify needs DOM globals — same reason render.triage.test.ts and
 * render.mywork.test.ts never drive it), so the markdown module is vi.mock'd with an
 * ESCAPING mock: anything that appears inside the mock wrapper provably went through
 * the markdown fn (the XSS discipline under test), never raw interpolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { setPrimaryRepo } from "../web/src/github";
import trovCss from "../web/src/trov.css?raw";
import mainSrc from "../web/src/main.ts?raw";
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
    start: null,
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
    me: { handle: "alice", name: "Alice", avatar_url: null, color: "moss", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" as const }], superadmin: false, pending_invites: 0 },
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

  it("puts the Now and Recent happenings boxes in the aside, after the narrative", () => {
    const html = render(stateWithPlan(makePlanView(), "narrative"));
    expect(html).toContain('data-screen-label="Roadmap · Now"'); // the in-progress sprint's box
    expect(html).toContain('class="cnpy-cols-aside');
    expect(html).toContain("Vectorize GA");
    expect(html).toContain("Recent happenings");
    // Narrative block precedes the spotlight
    expect(html.indexOf("mock-live-md")).toBeLessThan(html.indexOf("Roadmap · Now"));
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
    expect(html).toContain("Roadmap · Now");
    expect(html).not.toContain("issues closed");
  });

  it("the sprint cards never show the issue counts — only the shared Now box does", () => {
    const withIssues = makeSprint({
      id: 7, label: "Vectorize GA", status: "in_progress", github_ref: "[41,42,43]",
      progress: { closed: 1, total: 4, pct: 25 }, issues: { closed: 2, total: 3 },
    });
    const html = render(stateWithPlan(makePlanView({ sprints: [withIssues] }), "narrative"));
    expect(html).toContain("1/4 done");      // the tickets-only bar on the card
    // The count appears exactly once, and inside the aside's Now box.
    expect(html.match(/issues closed/g)?.length).toBe(1);
    expect(html.indexOf("issues closed")).toBeGreaterThan(html.indexOf('class="cnpy-cols-aside'));
  });

  it("empty narrative → the update-plan hint in the narrative tab", () => {
    const html = render(stateWithPlan(makePlanView({ narrative: "" }), "narrative"));
    expect(html).toContain("No plan narrative yet — write one with the update-plan skill");
    // (the Now box's sprint description is markdown too — only the narrative's wrapper is absent)
    expect(html).not.toContain('<div class="cnpy-md"><div class="mock-live-md">');
  });

  it("XSS: a <script> narrative reaches the DOM only via the (sanitizing) markdown module", () => {
    const html = render(stateWithPlan(makePlanView({ narrative: '<script>alert(1)</script>' }), "narrative"));
    expect(html).toContain("mock-live-md"); // the markdown fn produced the output
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ── full render() — the sprint cards (Narrative tab) ─────────────────────────
// The cards moved from the old Timeline tab to the Narrative tab when the Timeline
// became a calendar (web/src/timeline.ts, pinned in render.timeline.test.ts).

describe("render() — Roadmap sprint cards (narrative tab)", () => {
  it("shows the sprint's TICKET progress as 4/6 done (no live GitHub, no issue counts)", () => {
    const html = render(stateWithPlan(makePlanView(), "narrative"));
    expect(html).toContain("4/6 done");
  });

  it("shows the phase as a small mono suffix before the date label, · separated", () => {
    const plan = makePlanView({ sprints: [makeSprint({ phase: "Phase 2 — reads" })] });
    const html = render(stateWithPlan(plan, "narrative"));
    expect(html).toContain("Phase 2 — reads · ");
    // Date label is kept alongside the phase (target 2026-09-01 → "Sep 1, 2026")
    expect(html).toContain("Sep 1, 2026");
  });

  it("omits the phase suffix when phase is null", () => {
    const html = render(stateWithPlan(makePlanView(), "narrative"));
    expect(html).not.toContain("null · ");
    expect(html).toContain("Sep 1, 2026");
  });

  it("XSS: a malicious phase is escaped", () => {
    const plan = makePlanView({ sprints: [makeSprint({ phase: '<img src=x onerror=alert(1)>' })] });
    const html = render(stateWithPlan(plan, "narrative"));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("keeps the Confirm-done button for a ready sprint (all its TICKETS resolved, not done)", () => {
    const ready = makeSprint({ id: 9, label: "All wrapped", progress: { closed: 6, total: 6, pct: 100 } });
    const html = render(stateWithPlan(makePlanView({ sprints: [ready] }), "narrative"));
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
    expect(render(stateWithPlan(makePlanView({ sprints: [ready] }), "narrative"))).toContain('data-act="confirmSprint"');

    // Every cached ISSUE closed but tickets still open → NOT ready.
    const notReady = makeSprint({
      id: 11, label: "Issues all done", progress: { closed: 1, total: 6, pct: 17 },
      issues: { closed: 9, total: 9 },
    });
    const html = render(stateWithPlan(makePlanView({ sprints: [notReady] }), "narrative"));
    expect(html).not.toContain('data-act="confirmSprint"');
    expect(html).not.toContain("ready to complete");
  });

  it("a sprint with nothing to count (0/0) shows no progress bar and is never 'ready to complete'", () => {
    // SprintView.progress is always present; total 0 is the "no tickets" case,
    // which must render exactly like the old progress:null sprint did.
    const empty = makeSprint({ id: 4, label: "Nothing counted", progress: { closed: 0, total: 0, pct: 0 } });
    const html = render(stateWithPlan(makePlanView({ sprints: [empty] }), "narrative"));
    expect(html).toContain("Nothing counted");
    expect(html).not.toContain("0/0 done");
    expect(html).not.toContain("ready to complete");
    expect(html).not.toContain('data-act="confirmSprint"');
  });

  it("an unscheduled sprint (due: null) reads 'No target date' and is never overdue", () => {
    const unscheduled = makeSprint({ id: 5, label: "Unscheduled", due: null, status: "upcoming", progress: { closed: 0, total: 0, pct: 0 } });
    const html = render(stateWithPlan(makePlanView({ sprints: [unscheduled] }), "narrative"));
    expect(html).toContain("No target date");
    expect(html).not.toContain(">OVERDUE<");
    expect(html).not.toContain("Invalid Date");
  });
});

// ── full render() — timeline tab (the calendar) ──────────────────────────────

describe("render() — Roadmap timeline tab", () => {
  it("draws the calendar full width — no aside, no sprint cards, no old overview", () => {
    const html = render(stateWithPlan(makePlanView(), "timeline"));
    expect(html).toContain('data-screen-label="Roadmap · Timeline"');
    expect(html).toMatch(/class="tl-bar" data-act="openSprint" data-arg="1"/);
    expect(html).not.toContain('class="cnpy-cols-aside');
    expect(html).not.toContain('class="cnpy-cols');
    expect(html).not.toContain("Roadmap · Now");
    expect(html).not.toContain("Recent happenings");
    expect(html).not.toContain("Roadmap Overview");
    expect(html).not.toContain("Open sprint<svg"); // no sprintCard on this tab
  });

  it("never shows the GitHub issue counts (they live in the Narrative tab's Now box only)", () => {
    const withIssues = makeSprint({ id: 7, github_ref: "[41]", issues: { closed: 2, total: 3 } });
    const html = render(stateWithPlan(makePlanView({ sprints: [withIssues] }), "timeline"));
    expect(html).not.toContain("issues closed");
  });
});

describe("render() — New sprint: a header button, the form on either tab", () => {
  it("the Roadmap header carries the New sprint button on both tabs; the page body does not", () => {
    for (const tab of ["narrative", "timeline"] as const) {
      const html = render(stateWithPlan(makePlanView(), tab));
      const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
      expect(header).toContain('data-act="nsToggle"');
      expect(html.slice(html.indexOf('id="cnpy-main"'))).not.toContain('data-act="nsToggle"');
    }
  });

  it("opens the form at the top of the main column on the Narrative tab", () => {
    const html = render({ ...stateWithPlan(makePlanView(), "narrative"), nsOpen: true });
    expect(html).toContain('data-act="nsCreate"');
    expect(html.indexOf('data-act="nsCreate"')).toBeLessThan(html.indexOf("mock-live-md"));
  });

  it("opens the form above the calendar on the Timeline tab", () => {
    const html = render({ ...stateWithPlan(makePlanView(), "timeline"), nsOpen: true });
    expect(html).toContain('data-act="nsCreate"');
    expect(html.indexOf('data-act="nsCreate"')).toBeLessThan(html.indexOf('data-screen-label="Roadmap · Timeline"'));
  });

  it("renders no form while closed", () => {
    for (const tab of ["narrative", "timeline"] as const) {
      expect(render(stateWithPlan(makePlanView(), tab))).not.toContain('data-act="nsCreate"');
    }
  });

  it("opens the form UNDER the tab bar's line, inside the panel, on either tab", () => {
    for (const tab of ["narrative", "timeline"] as const) {
      const html = render({ ...stateWithPlan(makePlanView(), tab), nsOpen: true });
      const panel = html.indexOf('id="roadmap-tab-panel"');
      expect(panel, tab).toBeGreaterThan(html.indexOf('data-tabs="roadmap-tab"'));
      expect(html.indexOf('data-act="nsCreate"'), tab).toBeGreaterThan(panel);
    }
  });
});

// ── the tab bar heading the page (tabs.ts tabBar) ─────────────────────────────

describe("render() — Roadmap: the tab bar heading the page body, not a header switch", () => {
  /** The `.cnpy-tabs` bar carrying `data-tabs="roadmap-tab"`, up to its closing </div>. */
  const tabs = (html: string) => {
    const at = html.indexOf('data-tabs="roadmap-tab"');
    return at < 0 ? "" : html.slice(at, html.indexOf("</div>", at));
  };
  const header = (html: string) => html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  const main = (html: string) => html.slice(html.indexOf("</header>"));
  const RED_DOT = '<span style="width:6px;height:6px;border-radius:50%;background:var(--red);margin-left:1px"></span>';
  const late = makeSprint({ id: 2, label: "Late", status: "in_progress", active: true, due: "2020-01-01" });
  const onTime = makeSprint({ id: 3, label: "On time", status: "in_progress", active: true, due: "2099-01-01" });

  it("offers Narrative · Timeline in that order, the current one selected and inert", () => {
    for (const tab of ["narrative", "timeline"] as const) {
      const bar = tabs(render(stateWithPlan(makePlanView(), tab)));
      const other = tab === "narrative" ? "timeline" : "narrative";
      expect(bar, tab).toContain('role="tablist" aria-label="Roadmap sections"');
      expect(bar.match(/role="tab"/g)?.length, tab).toBe(2);
      expect(bar.indexOf(">Narrative<"), tab).toBeLessThan(bar.indexOf(">Timeline"));
      expect(bar, tab).toMatch(new RegExp(`id="roadmap-tab-${tab}" class="cnpy-tab is-on" aria-selected="true"[^>]*tabindex="0"`));
      expect(bar, tab).not.toContain(`data-arg="${tab}"`);
      // The other tab switches it: setRoadmapTab, ONE rerender.
      expect(bar, tab).toContain(`id="roadmap-tab-${other}" class="cnpy-tab" data-act="setRoadmapTab" data-arg="${other}" aria-selected="false"`);
    }
  });

  it("the switch is one plain rerender (nothing loads), and quick search's roadmapTimeline still works", () => {
    expect(mainSrc).toMatch(/case "setRoadmapTab":\s*if \(arg !== "narrative" && arg !== "timeline"\) return;\s*state\.roadmapTab = arg;\s*break;/);
    expect(mainSrc).toMatch(/case "roadmapTimeline": state\.roadmapTab = "timeline"; break;/);
    expect(mainSrc).not.toContain('case "roadmapNarrative"');
  });

  it("the Timeline tab carries the red overdue dot as its trail — only while a sprint is overdue, on both tabs", () => {
    for (const tab of ["narrative", "timeline"] as const) {
      expect(tabs(render(stateWithPlan(makePlanView({ sprints: [late] }), tab))), tab).toContain(`>Timeline${RED_DOT}</button>`);
      expect(tabs(render(stateWithPlan(makePlanView({ sprints: [onTime] }), tab))), tab).toContain(">Timeline</button>");
    }
    // A status dot is an element, and its radius has a rule in the Corners block.
    expect(trovCss).toContain('[style*="border-radius:50%"]');
  });

  it("heads the page BODY (not the header), and the labelled panel follows its line", () => {
    for (const tab of ["narrative", "timeline"] as const) {
      const html = render(stateWithPlan(makePlanView(), tab));
      expect(header(html), tab).not.toContain('data-tabs="roadmap-tab"');
      expect(header(html), tab).not.toContain("cnpy-seg");
      expect(header(html), tab).not.toContain(">Narrative<");
      const body = main(html);
      const page = body.indexOf('class="cnpy-scroll cnpy-cols-page"');
      const at = body.indexOf('data-tabs="roadmap-tab"');
      const panel = body.indexOf(`role="tabpanel" id="roadmap-tab-panel" aria-labelledby="roadmap-tab-${tab}"`);
      expect(page, tab).toBeGreaterThan(-1);
      expect(at, tab).toBeGreaterThan(page);
      expect(panel, tab).toBeGreaterThan(at);
      // Nothing of the page sits above the bar: it is the page's first thing.
      expect(body.slice(page, at), tab).not.toMatch(/>[^<\s]/);
    }
    // Each tab's content sits in the panel: the narrative + aside columns, the calendar.
    const narrative = main(render(stateWithPlan(makePlanView(), "narrative")));
    expect(narrative.indexOf('<div class="cnpy-cols">')).toBeGreaterThan(narrative.indexOf('id="roadmap-tab-panel"'));
    const timeline = main(render(stateWithPlan(makePlanView(), "timeline")));
    expect(timeline.indexOf('data-screen-label="Roadmap · Timeline"')).toBeGreaterThan(timeline.indexOf('id="roadmap-tab-panel"'));
  });

  it("sits in the SAME page frame on both tabs, so the underline slides and the bar never moves", () => {
    const frame = (html: string) => {
      const body = main(html);
      const page = body.lastIndexOf("<div", body.indexOf('class="cnpy-scroll cnpy-cols-page"'));
      return body.slice(page, body.indexOf('<div class="cnpy-tabs"', page));
    };
    const n = frame(render(stateWithPlan(makePlanView(), "narrative")));
    expect(n).toContain('style="max-width:1200px;margin:0 auto;padding:var(--cols-pad-top) 32px 80px"');
    expect(frame(render(stateWithPlan(makePlanView(), "timeline")))).toBe(n);
  });

  it("New sprint stays in the header, beside no switch", () => {
    for (const tab of ["narrative", "timeline"] as const) {
      const h = header(render(stateWithPlan(makePlanView(), tab)));
      expect(h, tab).toContain('data-act="nsToggle"');
      expect(h, tab).not.toContain("roadmap-tab");
    }
  });

  it("switching tabs never replays the screen's entrance (the underline slides unbroken)", () => {
    expect(mainSrc).toMatch(/hashForRoute\(\{ \.\.\.currentRoute\(\), [^}]*roadmapTab: undefined[^}]*\}\)/);
  });

  it("the Feed keeps asideColumns' plain frame: no tab bar, no panel", () => {
    const html = render({ ...initialState(), view: "app", screen: "feed" });
    expect(html).not.toContain('role="tabpanel"');
    expect(html).not.toContain('class="cnpy-tabs"');
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
  return { ...s, roadmapFeed: { status: "ok", data: [feedRow({ artifacts })] } };
}

describe("render() — Recent happenings GitHub chips", () => {
  // A bare number or sha belongs to the org's PRIMARY repository (github.ts, set from `GET /api/o/:slug/me`).
  beforeEach(() => setPrimaryRepo("SaplingLearn/sapling"));
  afterEach(() => setPrimaryRepo(null));

  it("with NO repository connected a bare PR / issue / commit is a plain chip, never a link to someone else's repo", () => {
    setPrimaryRepo(null);
    const html = render(stateWithFeed(JSON.stringify({ prs: ["14"], commits: ["8ad9756a407f0b2a3092cbfbb93f1dbc197546c3"], issues: [292] })));
    expect(html).toContain(">#14<");
    expect(html).toContain(">8ad9756<");
    expect(html).toContain(">#292<");
    expect(html).toContain("No repository is connected to this organization");
    expect(html).not.toContain("/pull/14");
    expect(html).not.toContain("/issues/292");
    expect(html).not.toContain("SaplingLearn");
    // A full URL names its own repository, so it still links.
    expect(render(stateWithFeed(JSON.stringify({ prs: ["https://github.com/acme/web/pull/9"], commits: [], issues: [] })))).toContain('href="https://github.com/acme/web/pull/9"');
  });

  it("links a bare reference to whatever the org's primary repository is", () => {
    setPrimaryRepo("acme/web");
    const html = render(stateWithFeed(JSON.stringify({ prs: ["14"], commits: [], issues: [292] })));
    expect(html).toContain('href="https://github.com/acme/web/pull/14"');
    expect(html).toContain('href="https://github.com/acme/web/issues/292"');
  });

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
      JSON.stringify({ prs: ["https://github.com/AndresL230/trov/pull/7"], commits: [], issues: [] }),
    ));
    expect(html).toContain(">#7<");
    expect(html).toContain("https://github.com/AndresL230/trov/pull/7");
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
      me: { handle: "alice", name: "Alice", avatar_url: null, color: "moss", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" as const }], superadmin: false, pending_invites: 0 },
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
      me: { handle: "alice", name: "Alice", avatar_url: null, color: "moss", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" as const }], superadmin: false, pending_invites: 0 },
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

describe("render() — Recent happenings limit", () => {
  it("shows at most 4 feed entries", () => {
    const s = stateWithPlan(makePlanView(), "narrative");
    const data = [1, 2, 3, 4, 5, 6].map((n) => feedRow({ id: n, summary: `happening number ${n}` }));
    const html = render({ ...s, roadmapFeed: { status: "ok", data } });
    const shown = [1, 2, 3, 4, 5, 6].filter((n) => html.includes(`happening number ${n}`));
    expect(shown).toEqual([1, 2, 3, 4]);
  });
});

// ── Recent happenings — its OWN unfiltered read, honest states ───────────────

describe("render() — Recent happenings reads its own slice, not the Feed screen's", () => {
  const base = () => stateWithPlan(makePlanView(), "narrative");

  it("ignores a filtered Feed-screen slice entirely", () => {
    const html = render({
      ...base(),
      feedAuthor: "meilin", feedTag: "infra",
      feed: { status: "ok", data: [feedRow({ id: 9, summary: "only meilin's infra entry" })] },
      roadmapFeed: { status: "ok", data: [feedRow({ id: 1, summary: "the newest entry, any author" })] },
    });
    expect(html).toContain("the newest entry, any author");
    expect(html).not.toContain("only meilin's infra entry");
  });

  it("a failed read says so — never 'No recent activity yet.'", () => {
    const html = render({ ...base(), roadmapFeed: { status: "error", data: [], error: "boom" } });
    expect(html).toContain("Couldn't load recent activity.");
    expect(html).not.toContain("No recent activity yet.");
  });

  it("…even when the Feed screen's own slice holds rows", () => {
    const html = render({
      ...base(),
      feed: { status: "ok", data: [feedRow({ summary: "feed screen row" })] },
      roadmapFeed: { status: "error", data: [], error: "boom" },
    });
    expect(html).toContain("Couldn't load recent activity.");
    expect(html).not.toContain("feed screen row");
  });

  it("idle / loading with nothing yet → Loading…; an empty ok read → the empty copy", () => {
    for (const status of ["idle", "loading"] as const) {
      const html = render({ ...base(), roadmapFeed: { status, data: [] } });
      expect(html).toContain("Loading&hellip;");
      expect(html).not.toContain("No recent activity yet.");
    }
    expect(render({ ...base(), roadmapFeed: { status: "ok", data: [] } })).toContain("No recent activity yet.");
  });

  it("a refresh keeps what is already shown", () => {
    const html = render({ ...base(), roadmapFeed: { status: "loading", data: [feedRow({ summary: "still here" })] } });
    expect(html).toContain("still here");
    expect(html).not.toContain("Loading&hellip;");
  });
});

// ── the Now box's sprint description ─────────────────────────────────────────

describe("render() — the Now box renders the description as markdown, clamped", () => {
  const nowBox = (html: string) => {
    const at = html.indexOf('data-screen-label="Roadmap · Now"');
    return html.slice(at, html.indexOf("</section>", at));
  };

  it("goes through the markdown module inside the clamped wrapper — no raw markers", () => {
    const html = render(stateWithPlan(makePlanView({ sprints: [makeSprint({ description: "Ship **semantic** search <b>now</b>." })] }), "narrative"));
    const box = nowBox(html);
    expect(box).toContain('<div class="cnpy-md rm-now-about"><div class="mock-live-md">');
    expect(box).not.toContain("<b>now</b>"); // escaped by the (sanitizing) markdown fn
    expect(box).toContain("&lt;b&gt;");
  });

  it("the clamp is CSS: three lines with an ellipsis", () => {
    expect(trovCss).toMatch(/\.cnpy-md\.rm-now-about \{[^}]*-webkit-line-clamp:3/);
  });

  it("no description → no wrapper", () => {
    const html = render(stateWithPlan(makePlanView({ sprints: [makeSprint({ description: null })] }), "narrative"));
    expect(nowBox(html)).not.toContain("rm-now-about");
  });
});

// ── the shared two-column helper (ui.ts asideColumns, also the Feed's) ────────

describe("render() — Roadmap Narrative uses the shared two-column helper", () => {
  it("is exactly asideColumns(main, aside): the page frame, the grid, the sticky aside", () => {
    const html = render(stateWithPlan(makePlanView(), "narrative"));
    const page = html.indexOf('class="cnpy-scroll cnpy-cols-page"');
    const cols = html.indexOf('<div class="cnpy-cols">');
    const aside = html.indexOf('<aside class="cnpy-cols-aside cnpy-stagger">');
    expect(page).toBeGreaterThan(-1);
    expect(cols).toBeGreaterThan(page);
    expect(aside).toBeGreaterThan(cols);
    // The Roadmap's own boxes sit inside that aside, after the narrative.
    expect(html.indexOf("Roadmap · Now")).toBeGreaterThan(aside);
    expect(html.indexOf("mock-live-md")).toBeLessThan(aside);
    // The Roadmap no longer carries a layout class of its own.
    expect(html).not.toMatch(/class="[^"]*\brm-(page|cols|aside)\b/);
  });

  it("the shared CSS: a 360px aside, sticky at the page's own top padding, one column under 880px", () => {
    expect(trovCss).toMatch(/\.cnpy-cols \{[^}]*grid-template-columns:minmax\(0,1fr\) 360px/);
    expect(trovCss).toMatch(/\.cnpy-cols-page \{[^}]*--cols-pad-top:28px/);
    expect(trovCss).toMatch(/\.cnpy-cols-aside \{[^}]*position:sticky; top:var\(--cols-pad-top\)/);
    expect(trovCss).toMatch(/@container colspage \(max-width: 880px\)/);
    // NOT the sidebar's .cnpy-aside, whose width and border-right would leak onto it.
    const html = render(stateWithPlan(makePlanView(), "narrative"));
    expect(html).not.toContain('<aside class="cnpy-aside cnpy-stagger">');
    expect(html).toContain("padding:var(--cols-pad-top) 32px 80px");
  });
});

describe("render() — Recent happenings caps each row's GitHub chips", () => {
  it("shows at most three chips, then a quiet +N naming the rest", () => {
    const html = render(stateWithFeed(JSON.stringify({ prs: ["1", "2"], commits: ["abc1234"], issues: [7, 8] })));
    const box = html.slice(html.indexOf("Roadmap · Recent happenings"));
    expect(box).toContain(">#1<");
    expect(box).toContain(">#2<");
    expect(box).not.toContain(">#7<");
    expect(box).toContain(">+2</span>");
  });

  it("three or fewer chips → no +N", () => {
    const html = render(stateWithFeed(JSON.stringify({ prs: ["1"], commits: [], issues: [7] })));
    expect(html.slice(html.indexOf("Roadmap · Recent happenings"))).not.toMatch(/>\+\d+<\/span>/);
  });
});

describe("render() — Recent happenings authors open their person card", () => {
  it("a known author's @handle is a button; an unknown one stays plain", () => {
    const s = stateWithFeed("");
    const known = render({ ...s, persons: { status: "ok", data: [{ handle: "AndresL230", name: "Andres", color: "moss", avatar_url: null, role: null }] } });
    expect(known).toMatch(/<button data-act="openPerson" data-arg="AndresL230" class="cnpy-personlink"[^>]*><span[^>]*>@AndresL230<\/span><\/button>/);
    expect(render(s)).not.toContain('data-act="openPerson" data-arg="AndresL230"');
  });
});
