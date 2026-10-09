/**
 * Review › Rendered (web/src/review-rendered.ts, web/src/md-blocks.ts).
 *
 * The bug this pins (0.26): Rendered printed the line-cut diff one escaped line at a time, so a
 * staged doc showed its markdown SOURCE — `# Title`, `**bold**`, a table as `| a | b |` rows. A
 * table, a list or a code fence only exists across several lines, so nothing cut by line can
 * render one. Rendered now hands whole BLOCKS (marked's own lexer) to the Docs reader's renderer.
 *
 * What runs here and what cannot: `marked` is pure and runs in this workerd pool, so the block
 * cutting and the elements it produces are REAL. DOMPurify needs a DOM and cannot run here (the
 * reason every render test mocks `web/src/markdown`), so the mock below is marked WITHOUT the
 * sanitizer, wrapped in a marker. The safety property is therefore tested structurally — every
 * byte of a proposal reaches the page only inside `renderMarkdown`'s output, which in the app is
 * sanitized — and the real pipeline was checked in a browser (a staged doc with a `<script>` and
 * an `onerror` image renders neither).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const md = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../web/src/markdown", async () => {
  const { marked } = await import("marked");
  return {
    renderMarkdown: (body: string) => { md.calls.push(body); return `<!--md-->${marked.parse(body, { async: false })}<!--/md-->`; },
    renderMarkdownInline: (text: string) => text,
    sanitizeSvg: () => "",
  };
});

import { renderedDoc, RENDERED_NEW_NOTE, RENDERED_SAME_NOTE } from "../web/src/review-rendered";
import { markdownBlocks } from "../web/src/md-blocks";
import { diffViewer } from "../web/src/review";
import { proposalReviewItem } from "../web/src/triage-map";
import reviewRenderedSrc from "../web/src/review-rendered.ts?raw";
import css from "../web/src/trov.css?raw";

beforeEach(() => { md.calls.length = 0; });

/** What this module wrote itself: the output with everything the renderer returned cut out. */
const outsideMd = (html: string) => html.replace(/<!--md-->[\s\S]*?<!--\/md-->/g, "");

const NEW_DOC = `# Billing with Stripe

Trov sells **one** paid plan.

## What is sold

**Pro** (plan id \`team\`) is billed per organization.

| Name | Kind | If missing |
| --- | --- | --- |
| \`STRIPE_SECRET_KEY\` | secret | billing is off |
| \`STRIPE_PRICE_TEAM\` | var | checkout answers 503 |

1. An admin picks Pro.
2. The Worker creates a session.

- Nothing is charged early.

\`\`\`ts
const session = await stripe.checkout.sessions.create({});
\`\`\`
`;

const LIVE = `# Rate limits

Every write is counted per organization.

## The limits

| Surface | Limit | Window |
| --- | --- | --- |
| MCP writes | 120 | 1 minute |
| Sign-in mail | 5 | 1 hour |

## What a caller sees

- The MCP tool returns an error.
- The web app shows a toast.
- Nothing is queued.
`;
const STAGED = `# Rate limits

Every write is counted per organization and per person.

## The limits

| Surface | Limit | Window |
| --- | --- | --- |
| MCP writes | 300 | 1 minute |
| Sign-in mail | 5 | 1 hour |

## What a caller sees over the limit

- The MCP tool returns an error.
- The web app shows a toast and keeps what was typed.
- Nothing is queued.
`;

describe("markdownBlocks — a body cut where the renderer cuts it", () => {
  it("a table, a list and a code fence are ONE block each, whatever lines they span", () => {
    const { blocks } = markdownBlocks(NEW_DOC);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "heading", "paragraph", "table", "list", "list", "code"]);
    const table = blocks.find((b) => b.type === "table")!;
    expect(table.table?.head).toBe("| Name | Kind | If missing |\n| --- | --- | --- |");
    expect(table.table?.rows).toHaveLength(2);
    expect(blocks.filter((b) => b.type === "list").map((b) => [b.list?.ordered, b.list?.items.length])).toEqual([[true, 2], [false, 1]]);
  });
  it("link reference definitions are kept apart, to travel with a block rendered alone", () => {
    const { blocks, defs } = markdownBlocks("See [the docs][d].\n\n[d]: https://example.com/docs\n");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph"]);
    expect(defs).toBe("[d]: https://example.com/docs");
  });
});

describe("Rendered — a NEW doc reads as it will once promoted", () => {
  const html = renderedDoc("", NEW_DOC, true);
  it("renders real elements: headings, a table, lists, a code block, inline code and bold", () => {
    expect(html).toContain("<h1>Billing with Stripe</h1>");
    expect(html).toContain("<h2>What is sold</h2>");
    expect(html).toMatch(/<table>[\s\S]*<th>Name<\/th>[\s\S]*<td><code>STRIPE_SECRET_KEY<\/code><\/td>[\s\S]*<\/table>/);
    expect(html).toMatch(/<ol>\s*<li>An admin picks Pro\.<\/li>/);
    expect(html).toMatch(/<ul>\s*<li>Nothing is charged early\.<\/li>/);
    expect(html).toMatch(/<pre><code class="language-ts">/);
    expect(html).toContain("<strong>Pro</strong> (plan id <code>team</code>)");
  });
  it("no markdown source survives: no table pipes, no heading marks, no asterisks or fences", () => {
    expect(html).not.toContain("| --- |");
    expect(html).not.toMatch(/\| Name \|/);
    expect(html).not.toMatch(/(^|>|\n)#{1,6} /);
    expect(html).not.toContain("**");
    expect(html).not.toContain("```");
  });
  it("is the reader's rendering of the whole body, in the reader's styles: ONE call, nothing marked", () => {
    expect(renderedDoc("", `${NEW_DOC}\nagain`, true)).toContain('class="cnpy-md cnpy-rv-md"');
    expect(md.calls).toEqual([`${NEW_DOC}\nagain`]);
    expect(html).not.toContain("cnpy-rv-blk");
    expect(html).not.toContain("<ins");
  });
  it("says so once, quietly, and shows no added / removed legend (there is nothing to tell apart)", () => {
    expect(html.split(RENDERED_NEW_NOTE).length - 1).toBe(1);
    expect(html).not.toContain("added in this proposal");
    expect(html).not.toContain("removed (struck)");
    expect(html).not.toContain("cnpy-rv-legend");
  });
  it("a proposal for a slug with nothing live is new, whatever its change_kind says", () => {
    const base = { slug: "s", version: 1, title: "T", section: "Architecture", space: "technical", summary: null, author: "a", confidence: null, status: "staged", low_confidence: 0, base_version: null, created_at: "2026-10-01T00:00:00Z", stagedBody: "# T" };
    expect(proposalReviewItem({ ...base, change_kind: "new", current_version: 0, promotedBody: "" }).isNew).toBe(true);
    expect(proposalReviewItem({ ...base, change_kind: null, current_version: 0, promotedBody: "" }).isNew).toBe(true);
    const edit = proposalReviewItem({ ...base, version: 2, change_kind: "edit", current_version: 1, promotedBody: "# Old" });
    expect(edit.isNew).toBe(false);
    expect([edit.liveBody, edit.proposedBody]).toEqual(["# Old", "# T"]);
  });
});

describe("Rendered — an EDIT marks what changed, block by block", () => {
  const html = renderedDoc(LIVE, STAGED, false);
  it("still renders real elements and leaves no source behind", () => {
    expect(html).toContain("<h1>Rate limits</h1>");
    expect(html).toContain("<h2>The limits</h2>");
    expect(html.match(/<table>/g)?.length).toBe(1);
    expect(html).not.toContain("| --- |");
    expect(html).not.toMatch(/(^|>|\n)#{1,6} /);
  });
  it("a changed paragraph is the old one removed, then the new one added", () => {
    expect(html).toMatch(/<del class="cnpy-rv-blk" data-chg="del"><!--md--><p>Every write is counted per organization\.<\/p>\s*<!--\/md--><\/del><ins class="cnpy-rv-blk" data-chg="add"><!--md--><p>Every write is counted per organization and per person\.<\/p>/);
  });
  it("a changed heading is marked as a block", () => {
    expect(html).toMatch(/<del class="cnpy-rv-blk" data-chg="del"><!--md--><h2>What a caller sees<\/h2>/);
    expect(html).toMatch(/<ins class="cnpy-rv-blk" data-chg="add"><!--md--><h2>What a caller sees over the limit<\/h2>/);
  });
  it("a table with one changed row is ONE table: that row removed and added, the others plain", () => {
    const table = html.slice(html.indexOf("<table>"), html.indexOf("</table>"));
    expect(table).toMatch(/<tr class="cnpy-rv-row-del">\s*<td>MCP writes<\/td>\s*<td>120<\/td>/);
    expect(table).toMatch(/<tr class="cnpy-rv-row-add">\s*<td>MCP writes<\/td>\s*<td>300<\/td>/);
    expect(table).toMatch(/<tr>\s*<td>Sign-in mail<\/td>/);
    expect(table.match(/<tr[ >]/g)?.length).toBe(4);   // the header row and three body rows
    // The table itself is not wrapped as removed + added.
    expect(html).not.toMatch(/<del class="cnpy-rv-blk" data-chg="del"><!--md--><table>/);
  });
  it("a changed list item is marked alone; the items around it stay plain", () => {
    expect(html).toMatch(/<del class="cnpy-rv-blk" data-chg="del"><!--md--><ul>\s*<li>The web app shows a toast\.<\/li>/);
    expect(html).toMatch(/<ins class="cnpy-rv-blk" data-chg="add"><!--md--><ul>\s*<li>The web app shows a toast and keeps what was typed\.<\/li>/);
    expect(html).toMatch(/<div class="cnpy-rv-list"><!--md--><ul>\s*<li>The MCP tool returns an error\.<\/li>/);
  });
  it("reads in the document's order: what was removed sits where it was, before what replaced it", () => {
    const at = (s: string) => html.indexOf(s);
    expect(at("<table>")).toBeLessThan(at("<h2>What a caller sees</h2>"));
    expect(at("<h2>What a caller sees</h2>")).toBeLessThan(at("<h2>What a caller sees over the limit</h2>"));
    expect(at("<h2>What a caller sees over the limit</h2>")).toBeLessThan(at("The MCP tool returns an error."));
  });
  it("unchanged blocks are not marked", () => {
    expect(html).toContain("<!--md--><h1>Rate limits</h1>");
    expect(html).not.toMatch(/data-chg="\w+"><!--md--><h1>/);
  });
  it("an ordered list keeps its numbering around a changed item", () => {
    const o = renderedDoc("1. one\n2. two\n3. three\n", "1. one\n2. TWO\n3. three\n", false);
    expect(o).toMatch(/<ins class="cnpy-rv-blk" data-chg="add"><!--md--><ol start="2">\s*<li>TWO<\/li>/);
    expect(o).toMatch(/<!--md--><ol start="3">\s*<li>three<\/li>/);
  });
  it("a table whose header changed is shown whole, removed then added (never half-merged)", () => {
    const t = renderedDoc("| A | B |\n| --- | --- |\n| 1 | 2 |\n", "| A | C |\n| --- | --- |\n| 1 | 2 |\n", false);
    expect(t.match(/<table>/g)?.length).toBe(2);
    expect(t).toMatch(/<del class="cnpy-rv-blk" data-chg="del"><!--md--><table>/);
    expect(t).not.toContain("cnpy-rv-row-");
  });
});

describe("Rendered — the legend says what is on the page", () => {
  it("names added and removed only when each is shown", () => {
    const both = renderedDoc("old\n", "new\n", false);
    expect(both).toContain("added in this proposal");
    expect(both).toContain("removed (struck)");
    const addOnly = renderedDoc("a\n", "a\n\nb\n", false);
    expect(addOnly).toContain("added in this proposal");
    expect(addOnly).not.toContain("removed (struck)");
    const delOnly = renderedDoc("a\n\nb\n", "a\n", false);
    expect(delOnly).toContain("removed (struck)");
    expect(delOnly).not.toContain("added in this proposal");
  });
  it("an edit that changes no block says so instead of showing a legend for nothing", () => {
    const same = renderedDoc("a\n\n\nb\n", "a\n\nb\n", false);
    expect(same).toContain(RENDERED_SAME_NOTE);
    expect(same).not.toContain("added in this proposal");
  });
  it("its swatches are elements, not a ■ character", () => {
    expect(renderedDoc("old\n", "new\n", false)).toContain('class="cnpy-rv-sw"');
    expect(reviewRenderedSrc).not.toContain("■");
  });
});

describe("Rendered — the trust boundary: a proposal reaches the page only through the renderer", () => {
  const HOSTILE = `# T <script>alert(1)</script>

<img src="x" onerror="alert(2)">

| A | B |
| --- | --- |
| <b onmouseover="alert(3)">x</b> | javascript:alert(4) |

- item <script>alert(5)</script>
`;
  const HOSTILE_OLD = `# T

| A | B |
| --- | --- |
| old | row |

- item
`;
  for (const [name, html] of [["a new doc", () => renderedDoc("", HOSTILE, true)], ["an edit", () => renderedDoc(HOSTILE_OLD, HOSTILE, false)], ["a removal", () => renderedDoc(HOSTILE, HOSTILE_OLD, false)]] as const) {
    it(`${name}: nothing of the body is written outside renderMarkdown's output`, () => {
      const mine = outsideMd(html());
      for (const bad of ["<script", "onerror", "onmouseover", "javascript:", "alert(", "<img", "<b "]) expect(mine, bad).not.toContain(bad);
      // What is left is this module's own constant markup: no text of the document at all.
      expect(mine.replace(/<[^>]+>/g, "").replace(/added in this proposal|removed \(struck\)/g, "").replace(RENDERED_NEW_NOTE, "").trim()).toBe("");
    });
  }
  it("every block of both bodies was handed to the renderer (none dropped, none interpolated)", () => {
    renderedDoc(HOSTILE_OLD, HOSTILE, false);
    const sent = md.calls.join("\n");
    for (const piece of ["<script>alert(1)</script>", 'onerror="alert(2)"', 'onmouseover="alert(3)"', "<script>alert(5)</script>", "| old | row |"]) expect(sent, piece).toContain(piece);
  });
  it("the one edit made to rendered output inserts a constant: a class on a table row", () => {
    expect(reviewRenderedSrc).toContain('`<tr class="cnpy-rv-row-${t}">`');
    expect(reviewRenderedSrc).not.toMatch(/\besc\(|innerHTML/);       // it escapes nothing itself: it never holds body text to escape
    expect(reviewRenderedSrc).toContain('import { renderMarkdown } from "./markdown"');
    expect(reviewRenderedSrc).not.toMatch(/from "marked"|from "dompurify"/);   // no second renderer
  });
  it("a row count the renderer does not confirm falls back to whole tables (a cell that opens a row)", () => {
    const t = renderedDoc("| A |\n| --- |\n| 1 |\n", "| A |\n| --- |\n| <tr> |\n| 2 |\n", false);
    expect(t).not.toContain("cnpy-rv-row-");
    expect(t.match(/<table>/g)?.length).toBe(2);
  });
});

describe("Rendered — Unified and Side by side still show the source", () => {
  const item = { diff: [{ t: "add" as const, s: "# Billing with Stripe" }, { t: "add" as const, s: "| --- | --- |" }], liveBody: "", proposedBody: NEW_DOC, isNew: true };
  it("the source views print the lines as they are; only Rendered calls the renderer", () => {
    expect(diffViewer(item, "unified")).toContain("# Billing with Stripe");
    expect(diffViewer(item, "split")).toContain("| --- | --- |");
    expect(md.calls).toHaveLength(0);
    expect(diffViewer({ ...item, proposedBody: `${NEW_DOC}\n(unified → rendered)` }, "rendered")).toContain("<h1>Billing with Stripe</h1>");
    expect(md.calls).toHaveLength(1);
  });
});

describe("Rendered — the marks' CSS (trov.css)", () => {
  it("a changed block is a block box with a tint and a rule; a removed one is struck", () => {
    expect(css).toMatch(/\.cnpy-rv-md \.cnpy-rv-blk \{ display:block;[^}]*text-decoration:none;/);
    expect(css).toMatch(/\.cnpy-rv-md \.cnpy-rv-blk\[data-chg="del"\][^{]*\{[^}]*text-decoration:line-through/);
    expect(css).toContain(".cnpy-rv-md tr.cnpy-rv-row-add > td");
    expect(css).toContain(".cnpy-rv-md tr.cnpy-rv-row-del > td");
  });
  it("declares no radius (nothing to register in the corners block)", () => {
    const block = css.slice(css.indexOf("/* ── Review › Rendered"), css.indexOf("/* Review under a tablet's width"));
    expect(block.length).toBeGreaterThan(500);
    expect(block).not.toContain("border-radius");
  });
});
