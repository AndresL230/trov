/**
 * Empty layouts and the state preview (web/src/skeleton.ts `emptyLayout`, web/src/preview.ts).
 *
 * What is pinned here:
 *   • the helper's contract: one sentence (escaped), at most one action, and shapes that are
 *     `aria-hidden` and hold NOTHING a person could read as data — no text, no image, no
 *     control, no status colour (CLAUDE.md invariant 7: never guess on read);
 *   • every screen, in four states — loading, empty for a member, empty for an admin (where
 *     the action differs) and with data — and that loading and empty are never confusable:
 *     a skeleton is `aria-busy` with `data-skel`, an empty layout is `data-empty` with neither;
 *   • the trov.css rules that make the two LOOK different (hollow and still vs filled and
 *     pulsing), in theme tokens only;
 *   • the preview: `?preview=empty|loading` projects the state at render time, never touches
 *     it, shows its banner, and refuses every write before it leaves the browser.
 *
 * Pure (no D1 / Miniflare, no DOM): HTML-string assertions over real render() passes.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-md">${body}</div>`,
  renderMarkdownInline: (text: string) => text,
  sanitizeSvg: (svg: string) => svg,
}));
import css from "../web/src/trov.css?raw";
import { render, initialState, docReaderHtml, shownState } from "../web/src/render";
import type { AppState, Screen } from "../web/src/render";
import { emptyLayout, emptySay, emptyShapes, skLine, skCard, skBox, CONNECT_AGENT } from "../web/src/skeleton";
import { parsePreview, previewSearch, withPreview, previewState, previewBanner, PREVIEW_BLOCKED } from "../web/src/preview";
import { setApiOrg, setWriteBlock, isWriteMethod, PreviewBlocked, getFeed, createTicket } from "../web/src/api";
import { repoView, type RepoProps } from "../web/src/repo";
import { orgEmpty } from "../web/src/org-ui";
import { sprintScreen } from "../web/src/sprints";
import type { FeedRow, DocRow } from "@shared/rows";
import type { TicketListItem } from "@shared/tickets";
import type { SprintView, SprintDetail } from "@shared/sprints";
import type { HandoffView } from "@shared/handoffs";
import type { PromptSummary } from "@shared/handoffs";
import type { ArtifactSummaryDTO } from "@shared/artifacts-core";

// ── fixtures ─────────────────────────────────────────────────────────────────
const T0 = "2026-09-14T10:00:00Z";
const ME = { handle: "alice", name: "Alice", avatar_url: null, color: "stone" as const, identities: [], superadmin: false, pending_invites: 0 };
const base = (screen: Screen, role: "member" | "admin", over: Partial<AppState> = {}): AppState => ({
  ...initialState(), view: "app", screen, orgSlug: "acme",
  me: { ...ME, orgs: [{ slug: "acme", name: "Acme", role }] } as AppState["me"],
  orgMe: { status: "ok", data: { org: { slug: "acme", name: "Acme" }, role, title: null, responsibilities: null, repos: { primary: null, all: [] } } as never },
  ...over,
});
/** Every read answered, with nothing: what a brand-new organization holds. */
const EMPTY: Partial<AppState> = {
  persons: { status: "ok", data: [] },
  mywork: { status: "ok", data: { person: "alice", previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false } },
  mwSessions: { status: "ok", data: [] }, mwDocs: { status: "ok", data: [] },
  feed: { status: "ok", data: [] }, feedStats: { status: "ok", data: { days: [], total: 0, people: 0, topTags: [], topAuthors: [] } },
  docsList: { status: "ok", data: [] }, docDetail: { status: "ok", data: null },
  roadmap: { status: "ok", data: { narrative: "", version: 0, updated_at: null, updated_by: null, sprints: [] } }, roadmapFeed: { status: "ok", data: [] },
  proposals: { status: "ok", data: [] }, draftAdrs: { status: "ok", data: [] }, needsTriage: { status: "ok", data: [] },
  tickets: { status: "ok", data: [] }, sprints: { status: "ok", data: [] },
  handoffs: { status: "ok", data: [] }, promptList: { status: "ok", data: [] },
  repo: { status: "ok", data: null },
};
const emptyState = (screen: Screen, role: "member" | "admin" = "member", over: Partial<AppState> = {}): AppState => {
  const s = base(screen, role, { ...EMPTY, ...over });
  return { ...s, art: { ...s.art, list: { status: "ok", data: [] } } };
};
/** Nothing read yet: every slice is as `initialState()` leaves it. */
const loadingState = (screen: Screen, over: Partial<AppState> = {}): AppState => base(screen, "member", { orgMe: { status: "loading", data: null }, ...over });

const feedRow: FeedRow = { id: 1, author: "alice", summary: "Shipped the thing.", brief: null, body: null, artifacts: null, created_at: T0 } as FeedRow;
const ticket: TicketListItem = {
  id: 7, title: "A real ticket", body: "", category: "bug", priority: "normal", status: "submitted", requester: "alice",
  parent_id: null, sprint_id: null, created_at: T0, updated_at: T0, source: "canopy", source_ref: null, source_author: null,
  source_updated_at: null, board_rank: null, assignees: [], link_count: 0, sub_count: 0, sprint_label: null,
} as TicketListItem;
const sprint: SprintView = {
  id: 3, label: "A real sprint", summary: "", description: null, phase: null, dates: null, start: null, due: "2027-01-10", status: "upcoming", active: false,
  urgency: "normal", lead: null, domain: null, github_ref: null, created_at: T0, created_by: "alice", updated_at: null,
  progress: { closed: 0, total: 0, pct: 0 }, issues: null, members: [],
} as unknown as SprintView;
const handoff: HandoffView = {
  id: 12, sender: "alice", recipient: "alice", status: "pending", created_at: T0, claimed_at: null, claimed_by: null, claimed_by_session: null,
  prompt: null, body: "A real handoff.", context: { repo: "acme/api", branch: "main", task: "t", done: [], next: [], files: [] },
} as HandoffView;
const prompt: PromptSummary = { slug: "a-real-prompt", title: "A real prompt", tags: [], author: "alice", version: 1, status: "published", updated_at: T0, excerpt: "x", use_count: 0, last_used_at: null } as PromptSummary;
const artifact: ArtifactSummaryDTO = {
  id: 1, slug: "a-real-artifact", title: "A real artifact", kind: "markdown", area: "ui", repo: "acme/api", author_id: "alice", status: "published",
  visibility: "org", current_version: 1, updated_at: T0, published_at: T0, size_bytes: 1200, excerpt: null, ticket_ids: [], sprint_ids: [],
} as unknown as ArtifactSummaryDTO;
const doc = { slug: "a-real-doc", title: "A real doc", space: "technical", section: "Overview", body: "Body.", current_version: 1, updated_at: T0, updated_by: "alice" } as unknown as DocRow;

/** The page body: everything inside the scroll pane (so the sidebar never counts). */
const body = (html: string): string => html.slice(html.indexOf('id="cnpy-main"'), html.indexOf('class="cnpy-scrim"'));
const emptyKeys = (html: string): string[] => [...html.matchAll(/data-empty="([^"]+)"/g)].map((m) => m[1]);
const skelKeys = (html: string): string[] => [...html.matchAll(/data-skel="([^"]+)"/g)].map((m) => m[1]);
/** The balanced `<div …>…</div>` starting at `from`. */
function divAt(html: string, from: number): string {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = from;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(from, re.lastIndex);
  }
  return html.slice(from);
}
/** The acts offered by the sentences of the empty layouts in `html`, in order. */
const acts = (html: string): string[] => [...html.matchAll(/<div class="cnpy-empty-say/g)]
  .flatMap((m) => [...divAt(html, m.index).matchAll(/data-act="([^"]+)"/g)].map((x) => x[1]));
const sentences = (html: string): string[] => [...html.matchAll(/<p class="cnpy-empty-text">([^<]*)<\/p>/g)].map((m) => m[1]);

/**
 * Everything inside the `.cnpy-empty-shapes` regions of `html`, as { text, markup } — found by
 * walking the tags (the regions nest divs and spans), so a test can assert that a shape holds
 * nothing but boxes.
 */
function shapes(html: string): { text: string; markup: string } {
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
  const VOID = new Set(["input", "img", "br", "hr", "meta", "link"]);
  let depth = 0, inside = -1, last = 0, text = "", markup = "";
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (inside >= 0) text += html.slice(last, m.index);
    last = re.lastIndex;
    const [tag, close, name, attrs] = m;
    if (close) {
      depth--;
      if (inside >= 0 && depth === inside) inside = -1;
      else if (inside >= 0) markup += tag;
    } else {
      if (inside >= 0) markup += tag;
      else if (/class="cnpy-empty-shapes/.test(attrs)) inside = depth;
      if (!VOID.has(name.toLowerCase()) && !attrs.trim().endsWith("/")) depth++;
    }
  }
  return { text, markup };
}
/** The rule every empty layout obeys: its shapes are a picture — never data, never a control. */
function expectOnlyBoxes(html: string): void {
  const s = shapes(html);
  expect(s.markup.length, "the screen draws no shapes").toBeGreaterThan(0);
  expect(s.text.trim(), "text inside placeholder shapes").toBe("");
  expect(s.markup).not.toMatch(/<(img|button|a|input|svg|select|textarea)\b/);
  expect(s.markup).not.toMatch(/data-act=|href=|title=|aria-label=/);
  // No status or person colour: a shape is drawn in the neutral border tokens alone.
  expect(s.markup).not.toMatch(/var\(--(green|amber|red|blue|purple|accent|p-[a-z]+)\)|#[0-9a-fA-F]{3,8}\b|rgba?\(/);
}
/** Loading and empty never look alike in the markup either. */
function expectEmptyNotLoading(html: string): void {
  expect(skelKeys(html)).toEqual([]);
  expect(html).not.toContain('aria-busy="true"');
  expect(emptyKeys(html).length).toBeGreaterThan(0);
}
function expectLoadingNotEmpty(html: string): void {
  expect(emptyKeys(html)).toEqual([]);
  expect(html).not.toContain("cnpy-empty-say");
  expect(skelKeys(html).length).toBeGreaterThan(0);
  expect(html).toContain('aria-busy="true"');
}

// ── the helper ───────────────────────────────────────────────────────────────
describe("skeleton.ts — emptyLayout", () => {
  it("is one sentence, one action and hidden shapes, in one keyed region", () => {
    const html = emptyLayout("things", { text: "No things yet.", action: { label: "New thing", act: "newThing", arg: "x" }, shapes: skLine("60%") });
    expect(html).toBe('<div class="cnpy-empty" data-empty="things"><div class="cnpy-empty-say"><p class="cnpy-empty-text">No things yet.</p><button type="button" data-act="newThing" data-arg="x" class="cnpy-empty-act">New thing</button></div><div class="cnpy-empty-shapes" aria-hidden="true"><span class="cnpy-skl" style="height:20px"><span class="cnpy-sk" style="width:60%;height:9px"></span></span></div></div>');
    expect(html).not.toContain("aria-busy");
    expect(html).not.toContain("data-skel");
  });
  it("escapes the sentence, the title and the action's label — they are plain text", () => {
    const html = emptyLayout("k", { title: "A <b>", text: `x "<i>" & y`, action: { label: "<go>", act: "a" } });
    expect(html).toContain("A &lt;b&gt;");
    expect(html).toContain("x &quot;&lt;i&gt;&quot; &amp; y");
    expect(html).toContain("&lt;go&gt;");
    expect(html).not.toContain("<i>");
  });
  it("with no action there is no button; with no shapes there is no shapes box", () => {
    const html = emptyLayout("k", { text: "Nothing is waiting." });
    expect(html).not.toContain("<button");
    expect(html).not.toContain("cnpy-empty-shapes");
    expect(emptySay("x", null, { plain: true })).toContain('class="cnpy-empty-say is-plain"');
  });
  it("shapes are the skeleton's own builders, hidden from assistive tech; `contents` makes them cells of the wrapper's grid", () => {
    expect(emptyShapes(skCard(skBox(10, 10)))).toMatch(/^<div class="cnpy-empty-shapes" aria-hidden="true"><div class="cnpy-surface"/);
    expect(emptyLayout("k", { text: "x", shapes: skBox(1, 1), contents: true, cls: "cnpy-mw-grid is-3" })).toContain('<div class="cnpy-empty cnpy-mw-grid is-3" data-empty="k">');
    expect(emptyShapes("", { contents: true })).toContain('class="cnpy-empty-shapes is-contents"');
  });
  it("the action for a screen an agent writes is connecting one: the guided setup's agent step", () => {
    expect(CONNECT_AGENT).toEqual({ label: "Connect an agent", act: "welcomeOpen", arg: "agent" });
  });
});

describe("trov.css — empty is told apart from loading at a glance", () => {
  const rule = (sel: string): string => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
  it("a loading bar is filled and pulses; an empty one is hollow, outlined and still", () => {
    expect(rule(".cnpy-sk")).toContain("background:var(--border)");
    expect(rule(".cnpy-sk")).toContain("animation:cnpy-skel-pulse");
    const hollow = rule(".cnpy-empty-shapes .cnpy-sk");
    expect(hollow).toContain("background:transparent");
    expect(hollow).toContain("box-shadow:inset 0 0 0 1px var(--border-strong)");
    expect(hollow).toContain("animation:none");
  });
  it("a card is a dashed outline with no fill, and the sentence sits in a dashed card of its own", () => {
    const card = rule(".cnpy-empty-shapes .cnpy-surface");
    expect(card).toContain("background:transparent");
    expect(card).toContain("border-style:dashed");
    expect(card).toContain("box-shadow:none");
    expect(rule(".cnpy-empty-say")).toContain("border:1px dashed var(--border-strong)");
  });
  it("uses theme tokens only (so dark follows), and nothing in it moves", () => {
    const block = css.slice(css.indexOf("/* ── empty layouts"), css.indexOf("/* The state preview's banner"));
    expect(block.length).toBeGreaterThan(400);
    expect(block.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(block).not.toMatch(/@keyframes|animation:(?!none)/);
    expect(block).toContain("@media (prefers-reduced-motion: reduce) { .cnpy-empty-act { transition:none; } }");
  });
  it("the shapes cannot be clicked or selected", () => {
    expect(rule(".cnpy-empty-shapes")).toContain("pointer-events:none");
    expect(rule(".cnpy-empty-shapes")).toContain("user-select:none");
  });
});

// ── every screen: loading · empty (member) · empty (admin) · with data ───────
interface Case {
  name: string;
  screen: Screen;
  over?: Partial<AppState>;
  /** The empty regions the screen draws, in order. */
  empty: string[];
  /** The acts its sentences offer a member, and an admin when that differs. */
  member: string[];
  admin?: string[];
  /** A state with data, and a string of that data that must then be on screen. */
  withData: (s: AppState) => AppState;
  data: string;
  /** The regions that are gone once there is data (default: all of `empty`). */
  gone?: string[];
}
const CASES: Case[] = [
  { name: "My Work", screen: "mywork", empty: ["mw-tickets", "mw-sessions", "mw-repo", "mw-review"], member: ["newTicket"], admin: ["newTicket", "orgGo"],
    withData: (s) => ({ ...s, mywork: { status: "ok", data: { ...s.mywork.data!, tickets: [{ id: 7, title: "A real ticket", body: "", category: "bug", priority: "normal", status: "submitted", source: "canopy", requester: "alice", sprint: null, updatedAt: T0, createdAt: T0 }], ticketsTotal: 1 } } }),
    data: "A real ticket", gone: ["mw-tickets"] },
  { name: "Tickets › Board", screen: "tickets", empty: ["tickets-board"], member: ["newTicket"],
    withData: (s) => ({ ...s, tickets: { status: "ok", data: [ticket] } }), data: "A real ticket" },
  { name: "Tickets › Table", screen: "tickets", over: { qView: "table" }, empty: ["tickets-table"], member: ["newTicket"],
    withData: (s) => ({ ...s, tickets: { status: "ok", data: [ticket] } }), data: "A real ticket" },
  { name: "Roadmap › Narrative", screen: "roadmap", empty: ["roadmap-narrative", "roadmap-sprints", "roadmap-happenings"], member: ["nsToggle"],
    withData: (s) => ({ ...s, roadmap: { status: "ok", data: { ...s.roadmap.data, narrative: "The real plan.", sprints: [sprint] } }, roadmapFeed: { status: "ok", data: [feedRow] } }), data: "A real sprint" },
  { name: "Roadmap › Timeline", screen: "roadmap", over: { roadmapTab: "timeline" }, empty: ["roadmap-timeline"], member: ["nsToggle"],
    withData: (s) => ({ ...s, roadmap: { status: "ok", data: { ...s.roadmap.data, sprints: [sprint] } } }), data: "A real sprint" },
  { name: "Feed", screen: "feed", empty: ["feed", "feed-week", "feed-review"], member: ["welcomeOpen"],
    withData: (s) => ({ ...s, feed: { status: "ok", data: [feedRow] } }), data: "Shipped the thing.", gone: ["feed"] },
  { name: "Docs", screen: "docs", empty: ["docs-tree", "doc"], member: ["newDoc"],
    withData: (s) => ({ ...s, docsList: { status: "ok", data: [doc] }, docSlug: "a-real-doc", docDetail: { status: "ok", data: { doc, versions: [] } } }), data: "A real doc" },
  { name: "Artifacts", screen: "artifacts", empty: ["artifacts"], member: ["artNew"],
    withData: (s) => ({ ...s, art: { ...s.art, list: { status: "ok", data: [artifact] } } }), data: "A real artifact" },
  { name: "Handoffs", screen: "handoffs", empty: ["handoffs"], member: ["newHandoff"],
    withData: (s) => ({ ...s, handoffs: { status: "ok", data: [handoff] } }), data: "A real handoff." },
  { name: "Prompt Library", screen: "prompts", empty: ["prompts"], member: ["newPrompt"],
    withData: (s) => ({ ...s, promptList: { status: "ok", data: [prompt] } }), data: "A real prompt" },
  { name: "Review", screen: "review", empty: ["review-list"], member: [],
    withData: (s) => ({ ...s, draftAdrs: { status: "ok", data: [{ id: 4, title: "A real decision", context: "c", decision: "d", rationale: "r", status: "draft", confidence: null, created_at: T0, created_by: "alice", content_hash: null }] } }), data: "A real decision" },
  { name: "Unplaced", screen: "maintenance", empty: ["unplaced"], member: [],
    withData: (s) => ({ ...s, needsTriage: { status: "ok", data: [{ id: 9, raw: "A real unplaced item", reason: "low_confidence", source_author: "alice", resolved: 0, created_at: T0, resolved_at: null, resolved_by: null, resolution: null, assigned_ref: null } as never] } }), data: "A real unplaced item" },
];

describe("every screen — loading, empty and with data", () => {
  for (const c of CASES) {
    describe(c.name, () => {
      it("loading: a skeleton in the screen's frame, and no empty layout yet", () => {
        expectLoadingNotEmpty(body(render(loadingState(c.screen, c.over))));
      });
      it("empty (member): the screen's shape drawn empty, one sentence per region, only the acts a member has", () => {
        const html = body(render(emptyState(c.screen, "member", c.over)));
        expectEmptyNotLoading(html);
        expect(emptyKeys(html)).toEqual(c.empty);
        expect(sentences(html).length).toBe(c.empty.length);
        for (const t of sentences(html)) expect(t.length).toBeGreaterThan(12);
        expect(acts(html)).toEqual(c.member);
        expectOnlyBoxes(html);
      });
      it("empty (admin): the same layout, with the action an admin has", () => {
        const html = body(render(emptyState(c.screen, "admin", c.over)));
        expect(emptyKeys(html)).toEqual(c.empty);
        expect(acts(html)).toEqual(c.admin ?? c.member);
        expectOnlyBoxes(html);
      });
      it("with data: the data, and the region's empty layout is gone", () => {
        const html = body(render(c.withData(emptyState(c.screen, "member", c.over))));
        expect(html).toContain(c.data);
        for (const k of c.gone ?? c.empty) expect(emptyKeys(html)).not.toContain(k);
        expect(skelKeys(html)).toEqual([]);
      });
    });
  }

  it("the empty layout keeps the screen's own chrome: the queue's toolbar and columns, the tab bars, the section heads", () => {
    const board = body(render(emptyState("tickets")));
    expect(board).toContain("cnpy-sfbar");
    expect(board.split("data-tdrop=").length - 1).toBeGreaterThanOrEqual(3);
    expect(board).toContain("0 shown · 0 unassigned");
    const table = body(render(emptyState("tickets", "member", { qView: "table" })));
    expect(table).toContain("<div>TITLE</div><div>OPENED BY</div>");
    const roadmap = body(render(emptyState("roadmap")));
    expect(roadmap).toContain('role="tablist"');
    expect(roadmap).toContain("Recent happenings");
    const handoffs = body(render(emptyState("handoffs")));
    expect(handoffs).toContain("WAITING TO BE CLAIMED");
    expect(handoffs).toContain("HISTORY");
    const prompts = body(render(emptyState("prompts")));
    expect(prompts).toContain('placeholder="Search titles, slugs and bodies"');
    expect(prompts).toContain('class="cnpy-empty cnpy-mw-grid is-3"');
    const artifacts = body(render(emptyState("artifacts")));
    expect(artifacts).toContain('placeholder="Search by title, area, kind or ticket"');
    expect(artifacts).toContain("0 shown · 0 total");
    const review = body(render(emptyState("review")));
    expect(review).toContain(">Review</h1>");
    expect(review).toContain('data-act="reviewFilter"');
  });

  it("a filter or a search that hides everything is NOT the empty layout — it says nothing matches", () => {
    expect(emptyKeys(body(render(emptyState("tickets", "member", { qQ: "zzz" }))))).toEqual([]);
    expect(emptyKeys(body(render(emptyState("tickets", "member", { qCategory: "bug" }))))).toEqual([]);
    expect(emptyKeys(body(render(emptyState("feed", "member", { feedAuthor: "bob" }))))).not.toContain("feed");
    const withOne = { ...emptyState("prompts"), promptList: { status: "ok" as const, data: [prompt] }, promptQ: "zzz" };
    expect(body(render(withOne))).toContain("No prompts match");
    expect(emptyKeys(body(render(withOne)))).toEqual([]);
  });

  it("Artifacts keeps its real toolbar while the list is out (it used to be a skeleton of one), and claims no count", () => {
    const html = body(render(loadingState("artifacts")));
    expect(html).toContain('placeholder="Search by title, area, kind or ticket"');
    expect(skelKeys(html)).toEqual(["artifacts"]);
    expect(html).not.toContain("0 shown");
  });

  it("the Docs reader draws the empty page through the in-place path too", () => {
    expect(docReaderHtml(emptyState("docs"))).toContain('data-empty="doc"');
  });

  it("a sprint with no tickets draws its ticket grid empty and points at the queue", () => {
    const detail = { ...sprint, tickets: [], members: [], resources: [] } as unknown as SprintDetail;
    const html = sprintScreen({ detail, persons: [], resourceDraft: "", deleteArmed: false });
    expect(emptyKeys(html)).toEqual(["sprint-tickets"]);
    expect(acts(html)).toEqual(["goTickets"]);
    expectOnlyBoxes(html);
  });
});

describe("the Repo dashboard with no repository", () => {
  const props = (over: Partial<RepoProps> = {}): RepoProps => ({
    tab: "overview", range: "7d", driftOpen: null, repo: { status: "ok", data: null }, fetchedAt: null, sample: false, admin: false, poll: null, productEnv: null, persons: [], noRepo: true, ...over,
  } as RepoProps);
  it("keeps its tab bar and every section's chrome, drawn empty, on each tab", () => {
    for (const tab of ["overview", "code", "ci", "usage", "planning"] as const) {
      const html = repoView(props({ tab }));
      expect(emptyKeys(html)).toEqual(["repo"]);
      expect(html).toContain('role="tablist"');
      expect(skelKeys(html)).toEqual([]);
      expectOnlyBoxes(html);
    }
  });
  it("points at Preview with sample data; only an admin is also offered Org settings › Repositories", () => {
    expect(acts(repoView(props()))).toEqual(["repoSampleOn"]);
    expect(acts(repoView(props({ admin: true })))).toEqual(["orgGo", "repoSampleOn"]);
    expect(repoView(props())).toContain("Preview with sample data shows every section filled in.");
  });
  it("sample data replaces it with the full dashboard", () => {
    expect(emptyKeys(repoView(props({ sample: true })))).not.toContain("repo");
  });
});

describe("Org settings' lists", () => {
  it("an empty list is the shared layout with its rows drawn empty; a notice that is not a list has none", () => {
    const list = orgEmpty("No environments yet", "The Repo dashboard reports on each one you add.", "", 2);
    expect(list).toContain('data-empty="org-no-environments-yet"');
    expect(list).toContain('<p class="cnpy-empty-title">No environments yet</p>');
    expectOnlyBoxes(list);
    const notice = orgEmpty("Admins only", "Only an admin can open this.");
    expect(notice).not.toContain("cnpy-empty-shapes");
  });
  it("the outbox is a skeleton while its first read is out — never “No sends yet” before it is known", () => {
    const admin = (over: Partial<AppState>) => body(render({ ...base("org", "admin", over), org: { ...initialState().org, tab: "notifications" } }));
    const out = admin({ notifOutbox: { status: "loading", data: [] } });
    expect(out).toContain('data-skel="notif-outbox"');
    expect(out).not.toContain("No sends yet");
    expect(admin({ notifOutbox: { status: "ok", data: [] } })).toContain("No sends yet");
  });
});

// ── the preview ──────────────────────────────────────────────────────────────
describe("preview.ts — the flag", () => {
  it("reads only the two modes", () => {
    expect(parsePreview("?preview=empty")).toBe("empty");
    expect(parsePreview("?x=1&preview=loading")).toBe("loading");
    expect(parsePreview("?preview=1")).toBeNull();
    expect(parsePreview("?preview=EMPTY")).toBeNull();
    expect(parsePreview("")).toBeNull();
  });
  it("is written before the hash, keeps other parameters, and leaves cleanly", () => {
    expect(withPreview("/acme/#tickets", "empty")).toBe("/acme/?preview=empty#tickets");
    expect(withPreview("/acme/?x=1#tickets/7", "loading")).toBe("/acme/?x=1&preview=loading#tickets/7");
    expect(withPreview("/acme/#tickets", null)).toBe("/acme/#tickets");
    expect(previewSearch("?preview=empty&x=1", null)).toBe("?x=1");
    expect(previewSearch("?preview=empty", null)).toBe("");
    expect(previewSearch("", "loading")).toBe("?preview=loading");
  });
});

describe("preview — every screen, whatever the organization holds", () => {
  /** An organization FULL of data, as the owner's is. */
  const full = (screen: Screen, over: Partial<AppState> = {}): AppState => {
    const s = base(screen, "admin", {
      persons: { status: "ok", data: [{ handle: "alice", name: "Alice", color: "stone", avatar_url: null, role: null }, { handle: "bob", name: "Bob Realname", color: "moss", avatar_url: null, role: null }] as never },
      mywork: { status: "ok", data: { person: "alice", previousActivity: [], todo: [], tickets: [{ id: 7, title: "A real ticket", body: "", category: "bug", priority: "normal", status: "submitted", source: "canopy", requester: "alice", sprint: null, updatedAt: T0, createdAt: T0 }], ticketsTotal: 1, degraded: false } },
      mwSessions: { status: "ok", data: [feedRow] }, mwDocs: { status: "ok", data: [] },
      feed: { status: "ok", data: [feedRow] }, feedAuthors: ["alice"], feedStats: { status: "ok", data: { days: [{ date: "2026-09-14", count: 3 }], total: 3, people: 1, topTags: [], topAuthors: [{ author: "alice", count: 3 }] } },
      docsList: { status: "ok", data: [doc] }, docSlug: "a-real-doc", docDetail: { status: "ok", data: { doc, versions: [] } },
      roadmap: { status: "ok", data: { narrative: "The real plan.", version: 1, updated_at: T0, updated_by: "alice", sprints: [sprint] } }, roadmapFeed: { status: "ok", data: [feedRow] },
      proposals: { status: "ok", data: [] }, draftAdrs: { status: "ok", data: [] }, needsTriage: { status: "ok", data: [] },
      tickets: { status: "ok", data: [ticket] }, ticketBadge: 4, sprints: { status: "ok", data: [sprint] },
      handoffs: { status: "ok", data: [handoff] }, promptList: { status: "ok", data: [prompt] },
      ...over,
    });
    return { ...s, art: { ...s.art, list: { status: "ok", data: [artifact] } } };
  };
  const REAL = ["A real ticket", "A real sprint", "Shipped the thing.", "A real doc", "A real artifact", "A real handoff.", "A real prompt", "The real plan.", "Bob Realname"];
  const SCREENS: Screen[] = ["mywork", "tickets", "roadmap", "feed", "docs", "artifacts", "handoffs", "prompts", "review", "maintenance", "repo"];

  it("off: the screens show the data (so the fixtures below prove something)", () => {
    expect(render(full("tickets"))).toContain("A real ticket");
    expect(render(full("feed"))).toContain("Shipped the thing.");
    expect(render(full("tickets"))).not.toContain("cnpy-preview");
  });

  for (const mode of ["empty", "loading"] as const) {
    it(`${mode}: no screen shows a single piece of the organization's data, and each shows its ${mode === "empty" ? "empty layout" : "skeleton"}`, () => {
      for (const screen of SCREENS) {
        for (const over of screen === "tickets" ? [{}, { qView: "table" as const }] : screen === "roadmap" ? [{}, { roadmapTab: "timeline" as const }] : [{}]) {
          const html = render(full(screen, { ...over, preview: mode }));
          const page = body(html);
          for (const real of REAL) expect(page, `${screen}: “${real}” under ?preview=${mode}`).not.toContain(real);
          if (mode === "empty") { expectEmptyNotLoading(page); expectOnlyBoxes(page); }
          else if (screen !== "repo") expectLoadingNotEmpty(page);
          // The banner is on every screen, and says which state this is.
          expect(html).toContain(`data-preview="${mode}"`);
        }
      }
    });
  }

  it("the sidebar's counts are not the organization's either", () => {
    const html = render(full("tickets", { preview: "empty" }));
    const aside = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    expect(render(full("tickets"))).toMatch(/data-n="4"/);
    expect(aside).not.toMatch(/data-n="4"/);
  });

  it("is a projection: the real state is not touched, and the same object paints the data again once it is off", () => {
    const s = full("tickets", { preview: "empty" });
    const before = JSON.stringify({ ...s, landingSeen: null });
    const shown = shownState(s);
    expect(shown).not.toBe(s);
    expect(shown.tickets.data).toEqual([]);
    render(s);
    expect(JSON.stringify({ ...s, landingSeen: null })).toBe(before);
    expect(s.tickets.data).toEqual([ticket]);
    expect(render({ ...s, preview: null })).toContain("A real ticket");
    // Applying it to its own output changes nothing more (docReaderHtml and render both project).
    expect(shownState(shown)).toBe(shown);
  });

  it("keeps who is looking: the person, their organization and role decide the actions as they really would", () => {
    const admin = body(render(full("mywork", { preview: "empty" })));
    expect(acts(admin)).toEqual(["newTicket", "orgGo"]);
    const member = full("mywork", { preview: "empty" });
    member.me = { ...member.me!, orgs: [{ slug: "acme", name: "Acme", role: "member" }] } as AppState["me"];
    expect(acts(body(render(member)))).toEqual(["newTicket"]);
    expect(render(full("mywork", { preview: "empty" }))).toContain("Alice");
  });

  it("empty keeps a page that opens ONE existing thing; loading shows its skeleton", () => {
    const one = { ticketDetail: { status: "ok" as const, data: null }, ticketId: 7 };
    const blank = initialState();
    const s = full("ticketdetail", one);
    expect(previewState(s, "empty", blank).ticketDetail).toBe(s.ticketDetail);
    expect(previewState(s, "loading", blank).ticketDetail).toEqual({ status: "loading", data: null });
  });

  it("does nothing outside an organization (the landing page, the picker)", () => {
    const s = { ...initialState(), preview: "empty" as const };
    expect(shownState(s)).toBe(s);
    expect(render(s)).not.toContain("cnpy-preview");
  });

  it("the banner says which state, that nothing is changed, offers the other state and Close", () => {
    const b = previewBanner("empty");
    expect(b).toContain("Previewing the empty state");
    expect(b).toContain("nothing is changed");
    expect(b).toMatch(/data-act="previewSet" data-arg="loading"[^>]*>Show loading</);
    expect(b).toMatch(/data-act="previewSet" data-arg=""[^>]*aria-label="Close the preview">Close</);
    expect(previewBanner("loading")).toContain("Previewing the loading state");
    expect(b).toContain('role="status"');
  });
});

describe("preview — it never sends a write", () => {
  afterEach(() => { setWriteBlock(null); setApiOrg(null); vi.unstubAllGlobals(); });

  it("only a GET or a HEAD is a read", () => {
    expect(isWriteMethod(undefined)).toBe(false);
    expect(isWriteMethod("get")).toBe(false);
    expect(isWriteMethod("HEAD")).toBe(false);
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) expect(isWriteMethod(m)).toBe(true);
  });

  it("while it is on, a write is refused before fetch is called, and the app is told; reads still go out", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    setApiOrg("acme");
    const told = vi.fn();
    setWriteBlock(told);
    await expect(createTicket({ title: "x" } as never)).rejects.toBeInstanceOf(PreviewBlocked);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(told).toHaveBeenCalledTimes(1);
    await getFeed();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[1]).not.toMatchObject({ method: "POST" });
    // Off again: the write goes out.
    setWriteBlock(null);
    await createTicket({ title: "x" } as never).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(PREVIEW_BLOCKED).toContain("nothing is changed");
  });

  it("main.ts turns the block on with the flag and off with it — in one place", async () => {
    const main = (await import("../web/src/main.ts?raw")).default as string;
    expect(main).toContain("applyPreview(parsePreview(location.search));");
    expect(main).toMatch(/function applyPreview\(mode: PreviewMode \| null\): void \{\s*state\.preview = mode;\s*setWriteBlock\(mode \? /);
    // Nothing else sets the flag.
    expect(main.split("state.preview =").length - 1).toBe(1);
  });
});
