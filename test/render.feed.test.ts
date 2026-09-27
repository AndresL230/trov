/**
 * Feed screen render test — the handle-carries-color task: a feed row's chip AND
 * its author handle text are both rendered in the mapped person's color, and the
 * header's author-filter chip for that person carries the same color.
 *
 * Pure (no D1 / Miniflare); assertions are HTML-string based, over a real render()
 * pass with the feed screen active.
 */
import { describe, it, expect, vi } from "vitest";

// marked + DOMPurify cannot run in this pool (no DOM) — the same mock the ticket and sprint
// render tests use: escapes, then **x** → <strong> and `x` → <code>. A `<strong>` therefore
// proves the text went through the markdown fn; an escaped `<script>` proves it never reached
// the DOM raw.
const mdMock = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${mdMock(body)}</div>`,
  renderMarkdownInline: (text: string) => mdMock(text),
}));
import { render, initialState } from "../web/src/render";
import type { FeedRow, AdrRow } from "@shared/rows";
import type { FeedStats } from "@shared/feed-stats";
import type { StagedProposal } from "../web/src/api";

function feedRow(overrides: Partial<FeedRow> = {}): FeedRow {
  return {
    id: 1,
    author: "AndresL230",
    summary: "Shipped the colored-handle change.",
    brief: null,
    body: null,
    artifacts: null,
    created_at: "2026-09-14T10:00:00Z",
    ...overrides,
  };
}

function feedState(rows: FeedRow[], feedView: "reading" | "agents" = "agents"): ReturnType<typeof initialState> {
  const s = initialState();
  return {
    ...s,
    feedView,
    view: "app",
    screen: "feed",
    me: { handle: "alice", name: "Alice", avatar_url: null, color: "stone", identities: [], org: "SaplingLearn", admin: false },
    persons: { status: "ok", data: [{ handle: "AndresL230", name: "Andres", color: "moss", avatar_url: null }] },
    feed: { status: "ok", data: rows },
    feedAuthors: [...new Set(rows.map((r) => r.author))],
  };
}

describe("Feed — handle text carries the mapped person's color", () => {
  it("a feed row by a mapped author shows the color on both the chip and the handle text", () => {
    const html = render(feedState([feedRow()]));
    const occurrences = (html.match(/var\(--p-moss\)/g) ?? []).length;
    // Once for the colored chip's --c background var, once for the handleTag text.
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(html).toContain("@AndresL230");
  });

  it("the Filter menu's Author option for that person carries their color", () => {
    const html = render({ ...feedState([feedRow()]), feedFilterOpen: true });
    expect(html).toContain('data-act="setAuthor" data-arg="AndresL230"');
    const headerHtml = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(headerHtml).toContain('data-fm-pop="feed"');
    expect(headerHtml).toContain("var(--p-moss)");
  });

  it("an unmapped author renders a muted handle with no person color", () => {
    const html = render(feedState([feedRow({ author: "octo-stranger" })]));
    expect(html).toContain("@octo-stranger");
    expect(html).not.toContain("var(--p-moss)");
  });
});

describe("Feed — entries are markdown", () => {
  it("renders the body through the markdown fn, in the scaled-down md container", () => {
    const html = render(feedState([feedRow({ body: "- **Poll now** moved to the top bar\n- see `runRepoRefresh`" })]));
    expect(html).toContain('class="cnpy-md cnpy-feed-body"');
    expect(html).toContain("mock-live-md");
    expect(html).toContain("<strong>Poll now</strong>");
    expect(html).toContain("<code>runRepoRefresh</code>");
    expect(html).not.toContain("**Poll now**");
  });

  it("renders the summary as INLINE markdown — emphasis and code, never block elements", () => {
    const html = render(feedState([feedRow({ summary: "Shipped **Poll now** via `POST /admin/poll`" })]));
    expect(html).toContain('class="cnpy-md-inline"');
    expect(html).toContain("Shipped <strong>Poll now</strong> via <code>POST /admin/poll</code>");
    expect(html).not.toContain("mock-live-md"); // the block renderer is not used for a summary
  });

  it("XSS: summary and body reach the DOM ONLY through the markdown fns", () => {
    const html = render(feedState([feedRow({ summary: "<img src=x onerror=1>", body: "<script>alert(1)</script>" })]));
    expect(html).not.toContain("<img src=x onerror=1>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).toContain("&lt;script&gt;");
  });

  it("an empty or whitespace body renders no container", () => {
    expect(render(feedState([feedRow({ body: null })]))).not.toContain("cnpy-feed-body");
    expect(render(feedState([feedRow({ body: "   " })]))).not.toContain("cnpy-feed-body");
  });
});

describe("Feed — For reading / For agents", () => {
  const row = feedRow({
    summary: "Shipped: document indexing retries on its own",
    brief: "Uploaded course documents no longer silently fail to reach the tutor — indexing now retries & admins can see anything stuck.",
    body: "**What** a long agent record",
    artifacts: JSON.stringify({ prs: ["https://github.com/SaplingLearn/Sapling/pull/658"], commits: [], issues: [482] }),
  });

  it("defaults to For reading", () => {
    expect(initialState().feedView).toBe("reading");
  });

  it("For reading shows the title, the brief and the chips — never the body", () => {
    const html = render(feedState([row], "reading"));
    expect(html).toContain("Shipped: document indexing retries on its own");
    expect(html).toContain('class="cnpy-feed-brief"');
    expect(html).toContain("indexing now retries &amp; admins can see anything stuck."); // escaped, plain text
    expect(html).not.toContain("cnpy-feed-body");
    expect(html).not.toContain("a long agent record");
    expect(html).toContain("cnpy-issuechip");
  });

  it("For agents shows the full body and not the brief", () => {
    const html = render(feedState([row], "agents"));
    expect(html).toContain("cnpy-feed-body");
    expect(html).toContain("a long agent record");
    expect(html).not.toContain("cnpy-feed-brief");
  });

  it("an entry with no brief reads as its title alone", () => {
    const html = render(feedState([feedRow({ brief: null, body: "**What** body" })], "reading"));
    expect(html).toContain("Shipped the colored-handle change.");
    expect(html).not.toContain("cnpy-feed-brief");
    expect(html).not.toContain("cnpy-feed-body");
  });

  it("XSS: the brief is escaped text", () => {
    const html = render(feedState([feedRow({ brief: "<img src=x onerror=1>" })], "reading"));
    expect(html).not.toContain("<img src=x onerror=1>");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
  });

  it("the header switch marks the active view", () => {
    // The shared segmented switch: the picked option is inert (no act), the other dispatches.
    const reading = render(feedState([row], "reading"));
    expect(reading).toContain('data-seg="feed-view"');
    expect(reading).toMatch(/class="cnpy-seg-btn is-on" aria-pressed="true">For reading/);
    expect(reading).toContain('data-act="setFeedView" data-arg="agents" aria-pressed="false"');
    const agents = render(feedState([row], "agents"));
    expect(agents).toMatch(/class="cnpy-seg-btn is-on" aria-pressed="true">For agents/);
    expect(agents).toContain('data-act="setFeedView" data-arg="reading" aria-pressed="false"');
  });
});

describe("Feed — one Filter menu, the view switch at the far right", () => {
  it("the header has no author chips or selects — a closed Filter button stands in for them", () => {
    const header = (h: string) => h.slice(h.indexOf("<header"), h.indexOf("</header>"));
    const html = header(render(feedState([feedRow()])));
    expect(html).toContain('data-hover-menu="feed"');
    expect(html).not.toContain("cnpy-achip");
    expect(html).not.toContain("<select");
    expect(html).not.toContain('data-fm-pop="feed"'); // closed
  });

  it("the For reading / For agents switch sits just before the theme toggle, which stays rightmost", () => {
    const html = render(feedState([feedRow()]));
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    const sw = header.indexOf('data-seg="feed-view"');
    expect(sw).toBeGreaterThan(header.indexOf('data-hover-menu="feed"'));
    expect(header.indexOf('data-act="cycleTheme"')).toBeGreaterThan(sw);
  });

  it("the menu's badge counts the active filters", () => {
    const html = render({ ...feedState([feedRow()]), feedAuthor: "AndresL230", feedRange: "7d" });
    expect(html).toMatch(/Filter\s*<span[^>]*>2<\/span>/);
  });

  it("Time narrows the loaded rows client-side", () => {
    const old = feedRow({ id: 2, summary: "an old entry", created_at: "2020-01-01T00:00:00Z" });
    const fresh = feedRow({ id: 3, summary: "a fresh entry", created_at: new Date().toISOString() });
    const html = render({ ...feedState([fresh, old]), feedRange: "7d" });
    expect(html).toContain("a fresh entry");
    expect(html).not.toContain("an old entry");
  });
});

// ── the aside: This week + Waiting on review (ui.ts asideColumns, shared with the Roadmap) ──

/** One box's markup, from its data-screen-label to the end of its section. */
function box(html: string, label: string): string {
  const at = html.indexOf(`data-screen-label="${label}"`);
  expect(at, label).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</section>", at));
}

const week = (over: Partial<FeedStats> = {}): FeedStats => ({
  days: [
    { date: "2026-09-20", count: 3 }, { date: "2026-09-21", count: 0 }, { date: "2026-09-22", count: 5 },
    { date: "2026-09-23", count: 0 }, { date: "2026-09-24", count: 6 }, { date: "2026-09-25", count: 4 },
    { date: "2026-09-26", count: 5 },
  ],
  total: 23, people: 5,
  topTags: [{ tag: "ui", count: 9 }, { tag: "api", count: 4 }, { tag: "infra", count: 2 }],
  topAuthors: [{ author: "AndresL230", count: 11 }, { author: "kai", count: 6 }, { author: "mira", count: 3 }],
  ...over,
});

function proposal(slug: string, createdAt: string, author = "kai"): StagedProposal {
  return {
    slug, version: 2, title: `Doc ${slug}`, section: "Overview", space: "technical", summary: null, author,
    confidence: "high", status: "staged", change_kind: "edit", low_confidence: 0, base_version: 1, current_version: 1,
    created_at: createdAt, stagedBody: "STAGED-BODY-LINE", promotedBody: "PROMOTED-BODY-LINE",
  };
}
function adr(id: number, createdAt: string, by = "mira"): AdrRow {
  return { id, title: `Decision ${id}`, context: "ctx", decision: "We decide.", rationale: null, status: "draft", confidence: "high", created_at: createdAt, created_by: by, content_hash: null };
}

describe("Feed — the two-column page", () => {
  it("renders the feed beside the shared sticky aside, This week first", () => {
    const html = render(feedState([feedRow()]));
    const aside = html.indexOf('<aside class="cnpy-cols-aside cnpy-stagger">');
    expect(html).toContain('class="cnpy-scroll cnpy-cols-page"');
    expect(aside).toBeGreaterThan(html.indexOf("Shipped the colored-handle change."));
    expect(html.indexOf("Feed · This week")).toBeGreaterThan(aside);
    expect(html.indexOf("Feed · Waiting on review")).toBeGreaterThan(html.indexOf("Feed · This week"));
  });

  it("keeps the aside while the feed itself is loading or failed", () => {
    const s = feedState([]);
    expect(render({ ...s, feed: { status: "loading", data: [] } })).toContain("Feed · This week");
    expect(render({ ...s, feed: { status: "error", data: [], error: "x" } })).toContain("Feed · Waiting on review");
  });
});

describe("Feed aside — This week", () => {
  it("says what it covers: the whole team, unfiltered", () => {
    expect(box(render({ ...feedState([feedRow()]), feedStats: { status: "ok", data: week() } }), "Feed · This week"))
      .toContain("Whole team, last 7 days");
  });

  it("shows the entries and people counts, and one bar per day with zero days as empty bars", () => {
    const b = box(render({ ...feedState([feedRow()]), feedStats: { status: "ok", data: week() } }), "Feed · This week");
    expect(b).toContain(">23</span>");
    expect(b).toContain("entries · 5 people");
    const days = [...b.matchAll(/data-day="([\d-]+)" data-n="(\d+)"/g)].map((m) => [m[1], Number(m[2])]);
    expect(days).toEqual([["2026-09-20", 3], ["2026-09-21", 0], ["2026-09-22", 5], ["2026-09-23", 0], ["2026-09-24", 6], ["2026-09-25", 4], ["2026-09-26", 5]]);
    // A zero day draws its track with no fill; a counted day gets a filled bar (the max at 100%).
    const zero = b.slice(b.indexOf('data-day="2026-09-21"'), b.indexOf('data-day="2026-09-22"'));
    expect(zero).not.toContain("background:var(--accent)");
    const peak = b.slice(b.indexOf('data-day="2026-09-24"'), b.indexOf('data-day="2026-09-25"'));
    expect(peak).toContain("height:100%;background:var(--accent)");
    expect(b).toContain('title="Thu 24 Sep · 6 entries"');
  });

  it("singular counts read as one entry / one person", () => {
    const one = week({ days: week().days.map((d, i) => ({ ...d, count: i === 6 ? 1 : 0 })), total: 1, people: 1, topTags: [], topAuthors: [{ author: "kai", count: 1 }] });
    const b = box(render({ ...feedState([feedRow()]), feedStats: { status: "ok", data: one } }), "Feed · This week");
    expect(b).toContain("entry · 1 person");
    expect(b).not.toContain("Top tags"); // no tags this week → no empty group
  });

  it("tag and author chips apply the Feed's own filter acts, the active one selected (and clearing)", () => {
    const html = render({ ...feedState([feedRow()]), feedTag: "api", feedAuthor: "kai", feedStats: { status: "ok", data: week() } });
    const b = box(html, "Feed · This week");
    expect(b).toContain('data-act="setTag" data-arg="ui" aria-pressed="false"');
    expect(b).toContain('data-act="setTag" data-arg="all" aria-pressed="true"'); // api is active → pressing clears
    expect(b).toContain('data-act="setAuthor" data-arg="AndresL230" aria-pressed="false"');
    expect(b).toContain('data-act="setAuthor" data-arg="all" aria-pressed="true"'); // kai is active
    expect(b).toContain("@AndresL230");
    // Tags in the order the server ranked them.
    expect(b.indexOf(">ui<")).toBeLessThan(b.indexOf(">api<"));
    expect(b.indexOf(">api<")).toBeLessThan(b.indexOf(">infra<"));
  });

  it("links Everything this week to the Feed's 7-day range filter", () => {
    const b = box(render({ ...feedState([feedRow()]), feedStats: { status: "ok", data: week() } }), "Feed · This week");
    expect(b).toContain('data-act="setRange" data-arg="7d"');
    expect(b).toContain("Everything this week");
  });

  it("loading, failed and empty are each said honestly", () => {
    const s = feedState([feedRow()]);
    expect(box(render({ ...s, feedStats: { status: "idle", data: null } }), "Feed · This week")).toContain("Loading&hellip;");
    expect(box(render({ ...s, feedStats: { status: "loading", data: null } }), "Feed · This week")).toContain("Loading&hellip;");
    const failed = box(render({ ...s, feedStats: { status: "error", data: null, error: "503" } }), "Feed · This week");
    expect(failed).toContain("Couldn't load this week's numbers.");
    expect(failed).not.toContain("data-day=");
    const quiet = week({ days: week().days.map((d) => ({ ...d, count: 0 })), total: 0, people: 0, topTags: [], topAuthors: [] });
    expect(box(render({ ...s, feedStats: { status: "ok", data: quiet } }), "Feed · This week")).toContain("Nothing recorded in the last 7 days.");
  });

  it("a refresh keeps the numbers on screen", () => {
    const b = box(render({ ...feedState([feedRow()]), feedStats: { status: "loading", data: week() } }), "Feed · This week");
    expect(b).toContain(">23</span>");
  });
});

describe("Feed aside — Waiting on review", () => {
  const withQueue = (proposals: StagedProposal[], adrs: AdrRow[]) => ({
    ...feedState([feedRow()]),
    proposals: { status: "ok" as const, data: proposals },
    draftAdrs: { status: "ok" as const, data: adrs },
  });

  it("counts the queue by kind and lists up to five, newest first, each opening Review on that item", () => {
    const html = render(withQueue(
      [proposal("a", "2026-09-20T00:00:00Z"), proposal("b", "2026-09-25T00:00:00Z", "AndresL230"), proposal("c", "2026-09-10T00:00:00Z")],
      [adr(4, "2026-09-24T00:00:00Z"), adr(5, "2026-09-01T00:00:00Z")],
    ));
    const b = box(html, "Feed · Waiting on review");
    expect(b).toContain(">5</span> waiting · 3 proposals, 2 decisions");
    const opened = [...b.matchAll(/data-act="mwOpenReview" data-arg="([^"]+)"/g)].map((m) => m[1]);
    expect(opened).toEqual(["doc:b@2", "adr:4", "doc:a@2", "doc:c@2", "adr:5"]);
    expect(b).toContain("@AndresL230"); // who staged it
    expect(b).toContain("var(--p-moss)"); // … in their person color
    expect(b).toContain("@mira");
    expect(b).toContain('data-act="goReview"');
    // The cheap heads — never the diffing mapping: no body text reaches the box.
    expect(html).not.toContain("STAGED-BODY-LINE");
    expect(html).not.toContain("PROMOTED-BODY-LINE");
  });

  it("lists at most five, while the count still covers the whole queue", () => {
    const html = render(withQueue(
      ["a", "b", "c", "d"].map((x, i) => proposal(x, `2026-09-2${i}T00:00:00Z`)),
      [adr(1, "2026-09-10T00:00:00Z"), adr(2, "2026-09-01T00:00:00Z")],
    ));
    const b = box(html, "Feed · Waiting on review");
    expect(b).toContain(">6</span> waiting · 4 proposals, 2 decisions");
    expect([...b.matchAll(/data-act="mwOpenReview"/g)]).toHaveLength(5);
    expect(b).not.toContain('data-arg="adr:2"'); // the oldest is left for the Review screen
  });

  it("singular and one-kind counts read naturally", () => {
    const b = box(render(withQueue([], [adr(1, "2026-09-20T00:00:00Z")])), "Feed · Waiting on review");
    expect(b).toContain(">1</span> waiting · 1 decision<");
  });

  it("empty, loading and failed are each said honestly", () => {
    expect(box(render(withQueue([], [])), "Feed · Waiting on review")).toContain("Nothing waiting on review.");
    const s = feedState([feedRow()]);
    expect(box(render({ ...s, proposals: { status: "loading", data: [] }, draftAdrs: { status: "ok", data: [] } }), "Feed · Waiting on review"))
      .toContain("Loading&hellip;");
    expect(box(render({ ...s, proposals: { status: "error", data: [], error: "x" }, draftAdrs: { status: "ok", data: [adr(1, "2026-09-20T00:00:00Z")] } }), "Feed · Waiting on review"))
      .toContain("Couldn't load the review queue.");
  });
});
