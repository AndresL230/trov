/**
 * Loading skeletons (web/src/skeleton.ts): the ONE helper every screen composes its
 * "not loaded yet" state from, and the main screens' loading paints.
 *
 * What is pinned here:
 *   • the primitives' markup and the wrapper's accessibility contract (`aria-busy`
 *     on the region, the bars `aria-hidden`, the loading line kept for a screen reader);
 *   • a skeleton is for a read that is OUT — a loaded-and-empty screen keeps its empty
 *     state, a failed one its error, and a refetch keeps the content on screen;
 *   • the skeleton sits in the screen's REAL frame (same wrappers, real chrome), so
 *     nothing moves when the read lands;
 *   • the motion rules in trov.css: off under reduced motion, theme tokens only.
 *
 * Pure (no D1 / Miniflare, no DOM): HTML-string assertions over real render() passes.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-md">${body}</div>`,
  renderMarkdownInline: (text: string) => text,
  sanitizeSvg: (svg: string) => svg,
}));
import css from "../web/src/trov.css?raw";
import { render, initialState, docReaderHtml } from "../web/src/render";
import type { Screen } from "../web/src/render";
import { skeleton, skBar, skBox, skLine, skLines, skRow, skList, skCard, skRows, skForm, skTable, skProse, skDetail, skKey, skW, SKEL_DELAY_MS } from "../web/src/skeleton";
import { loadingNote } from "../web/src/org-ui";
import { ticketsTile, reviewTile, sessionsTile, repoTile, libraryStrip } from "../web/src/mywork";

type State = ReturnType<typeof initialState>;
const app = (screen: Screen, over: Partial<State> = {}): State => ({
  ...initialState(),
  view: "app",
  screen,
  me: { handle: "alice", name: "Alice", avatar_url: null, color: "stone", identities: [], orgs: [{ slug: "acme", name: "Acme", role: "member" as const }], superadmin: false, pending_invites: 0 },
  ...over,
});
/** The page body: everything inside the scroll pane (so the sidebar never counts). */
const body = (html: string): string => html.slice(html.indexOf('id="cnpy-main"'), html.indexOf('class="cnpy-scrim"'));
const keys = (html: string): string[] => [...html.matchAll(/data-skel="([^"]+)"/g)].map((m) => m[1]);
const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe("skeleton.ts — the primitives", () => {
  it("a bar and a box are one muted element sized by parameters, with no colour or radius of their own", () => {
    expect(skBar(120, 9)).toBe('<span class="cnpy-sk" style="width:120px;height:9px"></span>');
    expect(skBar("64%")).toBe('<span class="cnpy-sk" style="width:64%;height:10px"></span>');
    expect(skBar(40, 8, "margin-left:auto")).toContain("height:8px;margin-left:auto");
    expect(skBox(30, 30)).toBe('<span class="cnpy-sk" style="width:30px;height:30px"></span>');
    for (const html of [skBar(), skBox("100%", 36), skLine(), skProse(), skDetail({ rail: 258 })]) {
      expect(html).not.toMatch(/border-radius|background:#|rgba?\(/);
    }
  });

  it("a text line reserves the real line box (font-size × line-height) around a letter-high bar", () => {
    // 14px / 1.5 → a 21px line box; the bar is the height of the letters.
    expect(skLine("70%", 14, 1.5)).toBe('<span class="cnpy-skl" style="height:21px"><span class="cnpy-sk" style="width:70%;height:10px"></span></span>');
    expect(skLine(96, 22, 1.3)).toContain("height:29px");
    expect(count(skLines(["100%", "80%", "40%"]), "cnpy-skl")).toBe(3);
  });

  it("rows, lists, cards, tables and the page composites are built from those", () => {
    const row = skRow({ lead: skBox(24, 24), body: skLine(), trail: skBar(40, 9) });
    expect(row).toMatch(/^<div class="cnpy-skrow" style="gap:12px;align-items:flex-start">/);
    expect(row).toContain('<span class="cnpy-skcol">');
    expect(count(skList(4, () => skBar()), "cnpy-sk")).toBe(4);
    expect(skCard(skBar(), "padding:16px 18px")).toMatch(/^<div class="cnpy-surface" style="padding:16px 18px">/);
    // A table: an optional head, then `rows` rows of `cells` bars on the caller's columns.
    const table = skTable(3, "2fr 1fr 1fr", 3, { head: true });
    expect(count(table, "grid-template-columns:2fr 1fr 1fr")).toBe(4);
    expect(count(table, "cnpy-sk")).toBe(12);
    expect(count(skProse(2), "cnpy-skl")).toBe(8);
    expect(skDetail({ rail: 258 })).toContain("grid-template-columns:minmax(0,1fr) 258px");
    expect(skW(0)).not.toBe(skW(1));
    expect(skKey("the org's settings")).toBe("the-org-s-settings");
  });

  it("the wrapper marks the region busy, hides the bars from a screen reader and keeps the loading line", () => {
    const html = skeleton("feed", "Loading feed&hellip;", skBar(), "margin-top:10px");
    expect(html).toBe('<div class="cnpy-skel" data-skel="feed" aria-busy="true" style="margin-top:10px"><span class="cnpy-sr" role="status">Loading feed&hellip;</span><div class="cnpy-skel-in" aria-hidden="true"><span class="cnpy-sk" style="width:100%;height:10px"></span></div></div>');
    // The settings lists: rows (optionally with an avatar and a control) or a form's fields.
    const rows = skRows("org-members", "Loading members&hellip;", 4, { avatar: 28, trail: 84 });
    expect(rows).toContain('data-skel="org-members" aria-busy="true"');
    expect(count(rows, "cnpy-skrow")).toBe(4);
    expect(count(rows, "border-top:1px solid var(--border)")).toBe(3);
    expect(skForm("org-general", "Loading&hellip;", 3)).toContain('aria-hidden="true"');
  });

  it("holds no button, link or field — a skeleton is never interactive", () => {
    for (const html of [skDetail({ rail: 200 }), skRows("k", "Loading", 3, { avatar: 20, trail: 60 }), skForm("k", "Loading", 2), skTable(2, "1fr 1fr", 2), loadingNote("members")]) {
      expect(html).not.toMatch(/<(button|a|input|select|textarea)\b/);
    }
  });
});

describe("skeleton motion (trov.css)", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  it("a fast read never shows one: the bars fade in only after the delay, on a clock a rerender keeps", () => {
    expect(rules).toContain(`animation-delay:calc(${SKEL_DELAY_MS}ms + var(--skel-t, 0ms))`);
    expect(rules).toMatch(/\.cnpy-sk \{[^}]*animation-delay:var\(--skel-t, 0ms\)/);
  });
  it("is off under prefers-reduced-motion — the bars, the fade-in and the landing fade", () => {
    expect(rules).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.cnpy-skel-in, \.cnpy-sk, \.cnpy-settle \{ animation:none !important; \}/);
  });
  it("uses the theme's tokens only, and has its line in the corners block", () => {
    const sk = rules.match(/\.cnpy-sk \{([^}]*)\}/)?.[1] ?? "";
    expect(sk).toContain("background:var(--border)");
    expect(sk).not.toMatch(/#[0-9a-f]{3,6}|rgba?\(/i);
    expect(rules).toContain("[data-cnpy-theme] .cnpy-sk { border-radius:calc(4px * var(--corner-scale)) !important; }");
  });
  it("what replaces a skeleton gets one plain fade — never the staggered entrance", () => {
    expect(rules).toMatch(/@keyframes cnpy-settle \{ from \{ opacity:\.3; \} to \{ opacity:1; \} \}/);
    expect(rules).not.toMatch(/\.cnpy-settle[^{]*\{[^}]*translate/);
  });
});

describe("Feed — loading", () => {
  it("a first read that is out shows cards in the feed's own two columns, beside the real aside", () => {
    for (const status of ["idle", "loading"] as const) {
      const html = body(render(app("feed", { feed: { status, data: [] } })));
      expect(html).toContain('data-skel="feed" aria-busy="true"');
      expect(html).toContain("Loading feed&hellip;");
      expect(html).toContain('class="cnpy-cols"');
      expect(html).toContain("Feed · This week");
      expect(html).not.toContain("No entries match this filter.");
    }
  });
  it("each aside box fills on its own read", () => {
    const html = body(render(app("feed", { feed: { status: "loading", data: [] }, feedStats: { status: "loading", data: null }, proposals: { status: "loading", data: [] }, draftAdrs: { status: "loading", data: [] } })));
    expect(keys(html)).toEqual(["feed", "feed-week", "feed-review"]);
    // The review box lands while the others are still out.
    const landed = body(render(app("feed", { feed: { status: "loading", data: [] }, feedStats: { status: "loading", data: null }, proposals: { status: "ok", data: [] }, draftAdrs: { status: "ok", data: [] } })));
    expect(keys(landed)).toEqual(["feed", "feed-week"]);
    expect(landed).toContain("Nothing waiting on review.");
  });
  it("loaded-and-empty is the empty state, a failure is the error — never a skeleton", () => {
    const empty = body(render(app("feed", { feed: { status: "ok", data: [] }, feedStats: { status: "ok", data: null as never }, proposals: { status: "ok", data: [] }, draftAdrs: { status: "ok", data: [] } })));
    expect(empty).toContain("No entries match this filter.");
    expect(empty).not.toContain('data-skel="feed"');
    const failed = body(render(app("feed", { feed: { status: "error", data: [] } })));
    expect(failed).toContain("Couldn't load the feed.");
    expect(failed).not.toContain('data-skel="feed"');
  });
});

describe("Docs — loading", () => {
  it("the tree and the reader each hold a skeleton in the real two panes", () => {
    const html = body(render(app("docs", { docsList: { status: "loading", data: [] } })));
    expect(keys(html)).toEqual(["docs-tree", "doc"]);
    expect(html).toContain('class="cnpy-scroll cnpy-docs-tree"');
    expect(html).toContain('id="cnpy-reader"');
    expect(html).not.toContain("Select a doc from the tree.");
    // The reader's skeleton sits in the doc page's own frame.
    expect(docReaderHtml(app("docs", { docSlug: "x", docDetail: { status: "loading", data: null } }))).toContain("max-width:1080px;margin:0 auto;padding:34px 52px 120px");
  });
  it("no docs is the empty state; nothing picked is the prompt to pick", () => {
    const html = body(render(app("docs", { docsList: { status: "ok", data: [] } })));
    expect(keys(html)).toEqual([]);
    expect(html).toContain("Select a doc from the tree.");
  });
});

describe("Roadmap — loading", () => {
  it("Narrative: the real tab bar, then the narrative and sprint cards beside the aside's boxes", () => {
    const html = body(render(app("roadmap")));
    expect(html).toContain('data-tabs="roadmap-tab"');
    expect(keys(html)).toEqual(["roadmap", "roadmap-now", "roadmap-happenings"]);
    expect(html).toContain("Roadmap · Recent happenings");
    expect(html).toContain("Loading roadmap&hellip;");
  });
  it("Timeline: the same frame and tab bar, the rows in the Timeline's place", () => {
    const html = body(render(app("roadmap", { roadmapTab: "timeline", roadmap: { ...initialState().roadmap, status: "loading" } })));
    expect(html).toContain('data-tabs="roadmap-tab"');
    expect(keys(html)).toEqual(["roadmap-timeline"]);
  });
  it("a loaded plan with no sprints is not a skeleton", () => {
    const html = body(render(app("roadmap", { roadmap: { ...initialState().roadmap, status: "ok" }, roadmapFeed: { status: "ok", data: [] } })));
    expect(keys(html)).toEqual([]);
    expect(html).toContain("No recent activity yet.");
  });
});

describe("Tickets — loading", () => {
  it("Board: the toolbar and the columns are real; each column holds skeleton cards, never “Nothing here”", () => {
    const html = body(render(app("tickets", { tickets: { status: "loading", data: [] } })));
    expect(html).toContain('class="cnpy-board"');
    expect(html).toContain('data-tdrop="submitted"');
    expect(keys(html).every((k) => k.startsWith("tickets-col-"))).toBe(true);
    expect(keys(html).length).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain("Nothing here");
    expect(html).toContain("Loading the queue&hellip;");
  });
  it("Table: skeleton rows on the table's own column template", () => {
    const html = body(render(app("tickets", { qView: "table", tickets: { status: "loading", data: [] } })));
    expect(keys(html)).toEqual(["tickets-table"]);
    expect(html).toContain("cnpy-ttable");
    expect(html).not.toContain("Nothing in this view.");
  });
  it("a loaded, empty queue is the empty state", () => {
    const board = body(render(app("tickets", { tickets: { status: "ok", data: [] } })));
    expect(keys(board)).toEqual([]);
    expect(board).toContain("Nothing here");
    expect(body(render(app("tickets", { qView: "table", tickets: { status: "ok", data: [] } })))).toContain("Nothing in this view.");
  });
  it("a ticket and a sprint each open on their own page's grid", () => {
    const ticket = body(render(app("ticketdetail", { ticketDetail: { status: "loading", data: null } })));
    expect(keys(ticket)).toEqual(["ticket"]);
    expect(ticket).toContain('class="cnpy-td-grid"');
    expect(body(render(app("ticketdetail", { ticketDetail: { status: "ok", data: null } })))).toContain("That ticket doesn't exist.");
    const sprint = body(render(app("sprint", { sprintDetail: { status: "loading", data: null } })));
    expect(keys(sprint)).toEqual(["sprint"]);
    expect(sprint).toContain('class="cnpy-sprint-grid"');
    expect(body(render(app("sprint", { sprintDetail: { status: "error", data: null } })))).toContain("Couldn't load this sprint.");
  });
});

describe("Review, Unplaced, Search — loading", () => {
  it("Review keeps its frame and filter; the list and the detail pane hold skeletons, never “Queue is clear”", () => {
    const html = body(render(app("review", { proposals: { status: "loading", data: [] }, draftAdrs: { status: "loading", data: [] } })));
    expect(keys(html)).toEqual(["review-list", "review-detail"]);
    expect(html).toContain(">Review</h1>");
    expect(html).not.toContain("Queue is clear");
    const clear = body(render(app("review", { proposals: { status: "ok", data: [] }, draftAdrs: { status: "ok", data: [] } })));
    expect(keys(clear)).toEqual([]);
    expect(clear).toContain("Queue is clear");
  });
  it("Unplaced keeps its intro; the card is a skeleton until the queue is known", () => {
    const html = body(render(app("maintenance", { needsTriage: { status: "loading", data: [] } })));
    expect(keys(html)).toEqual(["unplaced"]);
    expect(html).not.toContain("All clear");
    expect(body(render(app("maintenance", { needsTriage: { status: "ok", data: [] } })))).toContain("All clear");
  });
  it("Search shows a skeleton only with nothing on screen — a re-query keeps the results it has", () => {
    const first = body(render(app("search", { searchResults: { ...initialState().searchResults, status: "loading" } })));
    expect(keys(first)).toEqual(["search"]);
    expect(first).toContain("Searching&hellip;");
    const hit = { type: "doc" as const, id: "doc:x", title: "Deploy runbook", authority: "live" as const, body: "How we deploy.", score: 1 };
    const again = body(render(app("search", { searchQuery: "deploy", searchResults: { status: "loading", data: { primary: [hit as never], pointers: [], meta: { engine: "fts5", total: 1 } } } })));
    expect(keys(again)).toEqual([]);
    expect(again).toContain("Deploy runbook");
  });
});

describe("My Work — each tile fills on its own read", () => {
  it("a tile whose read is out holds rows in its own box, under its real header", () => {
    const tickets = ticketsTile({ load: "pending", rows: [] }, false, 7);
    expect(tickets).toContain("Tickets for you");
    expect(tickets).toContain('data-skel="mw-tickets" aria-busy="true"');
    expect(count(tickets, "padding:10px 16px;border-top:1px solid var(--border)")).toBe(3);
    expect(reviewTile([], "pending", 5)).toContain('data-skel="mw-review"');
    expect(sessionsTile([], "pending", [], 5)).toContain('data-skel="mw-sessions"');
    expect(repoTile(null, "pending", "prs", 7)).toContain('data-skel="mw-repo"');
    const lib = libraryStrip({ docs: { load: "pending", total: 0, stale: [] }, artifacts: { load: "pending", publishedThisWeek: 0, latest: null }, handoffs: { load: "pending", count: 0, newest: null } }, 12);
    expect(keys(lib)).toEqual(["mw-lib-docs", "mw-lib-arts", "mw-lib-handoffs"]);
  });
  it("empty and failed tiles say so instead", () => {
    expect(ticketsTile({ load: "ok", rows: [] }, false, 7)).not.toContain("data-skel");
    expect(reviewTile([], "error", 5)).toContain("Couldn't load the review queue.");
    expect(reviewTile([], "error", 5)).not.toContain("data-skel");
    expect(repoTile(null, "error", "prs", 7)).toContain("Couldn't load the Repo dashboard.");
    expect(sessionsTile([], "ok", [], 5)).not.toContain("data-skel");
  });
  it("the whole page: every region has its own key, so regions fill without moving each other", () => {
    const html = body(render(app("mywork")));
    const k = keys(html);
    expect(new Set(k).size).toBe(k.length);
    expect(k).toEqual(expect.arrayContaining(["mw-tickets", "mw-sessions", "mw-repo"]));
    expect(html).toContain('class="mw-bento cnpy-stagger"');
  });
});

describe("Handoffs, Prompt Library, Artifacts, Repo, Settings — loading", () => {
  it("each opens on a skeleton in its own frame", () => {
    const cases: [Screen, string[]][] = [
      ["handoffs", ["handoffs"]],
      ["handoff", ["handoff"]],
      ["prompts", ["prompts"]],
      ["prompt", ["prompt"]],
      ["artifacts", ["artifacts"]],
    ];
    for (const [screen, want] of cases) expect(keys(body(render(app(screen)))), screen).toEqual(want);
    expect(body(render(app("prompts")))).toContain('class="cnpy-mw-grid is-3"');
    expect(body(render(app("handoffs")))).toContain("Handoffs you sent or that were left for you.");
  });
  it("Repo: the tab bar and every section's chrome are real, each section a keyed skeleton", () => {
    for (const repoTab of ["overview", "code", "ci", "usage", "planning"] as const) {
      const html = body(render(app("repo", { repoTab, repo: { status: "loading", data: null } })));
      const k = keys(html);
      expect(html).toContain('data-tabs="repo-tab"');
      expect(k.length, repoTab).toBeGreaterThan(0);
      expect(new Set(k).size, repoTab).toBe(k.length);
    }
  });
  it("Settings: connected apps and email settings are skeletons until their reads land", () => {
    const html = body(render(app("settings", { grants: { status: "loading", data: [] }, notifPrefs: { status: "loading", data: null } })));
    expect(keys(html)).toEqual(expect.arrayContaining(["grants", "email-prefs"]));
    expect(html).toContain("Loading connected apps&hellip;");
    expect(html).toContain("Loading email settings&hellip;");
    const landed = body(render(app("settings", { grants: { status: "ok", data: [] }, notifPrefs: { status: "loading", data: null } })));
    expect(keys(landed)).not.toContain("grants");
    expect(landed).toContain("No apps connected yet.");
  });
  it("Org settings and Platform read one helper: “Loading <what>…” for a screen reader, rows or fields on screen", () => {
    const rows = loadingNote("members", { rows: 4, avatar: 28 });
    expect(rows).toContain('data-skel="org-members"');
    expect(rows).toContain("Loading members&hellip;");
    expect(count(rows, "cnpy-skrow")).toBe(4);
    expect(loadingNote("your org", { form: true })).toContain('data-skel="org-your-org"');
  });
});

describe("every loading paint keeps the rules", () => {
  const screens: Screen[] = ["mywork", "feed", "docs", "roadmap", "review", "maintenance", "tickets", "ticketdetail", "sprint", "handoffs", "handoff", "prompts", "prompt", "artifacts", "repo", "settings"];
  it("is busy-marked, hidden from a screen reader, keeps a status line, and has unique region keys", () => {
    for (const screen of screens) {
      const html = body(render(app(screen)));
      const n = count(html, 'class="cnpy-skel"');
      expect(n, screen).toBeGreaterThan(0);
      expect(count(html, 'aria-busy="true"'), screen).toBe(n);
      expect(count(html, '<div class="cnpy-skel-in" aria-hidden="true">'), screen).toBe(n);
      expect(count(html, '<span class="cnpy-sr" role="status">'), screen).toBeGreaterThanOrEqual(n);
      const k = keys(html);
      expect(new Set(k).size, screen).toBe(k.length);
    }
  });
});
