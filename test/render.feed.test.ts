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
import type { FeedRow } from "@shared/rows";

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
