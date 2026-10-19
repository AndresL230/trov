/**
 * Render tests — the componentized triage surfaces (Review + Maintenance).
 *
 * Tests pure functions exported from web/src:
 *  • lineDiff / collapsedLineDiff (render.ts) — the diff helpers kept for the
 *    wire-up phase (they'll feed the Review diff viewer from real bodies)
 *  • reviewView / maintenanceView and their pieces — populated + empty states,
 *    diff view modes, and attribute/text escaping (components are presentational
 *    and mock-fed, so escaping is verified by injecting hostile props directly)
 *
 * All tests are pure (no D1 / Miniflare bindings). They run in the same Vitest
 * pool-workers harness as the backend tests; nothing here touches the DOM.
 */
import { describe, it, expect, vi } from "vitest";

// marked + DOMPurify cannot run in this workerd pool (no DOM), so the markdown module is mocked,
// as in the other render tests: the mock ESCAPES and wraps, so a body can be seen to have gone
// through the renderer. What Rendered does with a body is test/render.review-rendered.test.ts.
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-md">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`,
  renderMarkdownInline: (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  sanitizeSvg: () => "",
}));

import { lineDiff, collapsedLineDiff } from "../web/src/diff";
import { attachAskFlags } from "../web/src/triage-map";
import { reviewView, reviewPagePane, reviewGroups, changedLinesText, pageKindWord, APPROVE_NOTE, reviewDetail, reviewCard, reviewFilterSwitch, diffViewer, unifiedDiff, splitDiffRows, staleBaseWarning, REVIEW_EXIT_MS, REVIEW_INTRO, type ReviewItem, type ReviewProps } from "../web/src/review";
import { LOW_CONFIDENCE } from "../web/src/marks";
import css from "../web/src/trov.css?raw";
import morphSrc from "../web/src/morph.ts?raw";
import { maintenanceView, type MaintenanceProps, type UnplacedItem } from "../web/src/maintenance";
import { identitySection, personPicker, type IdentityProps, type IdentityGroup } from "../web/src/identity";
import { render, initialState, triageCounts, identityCount } from "../web/src/render";
import mainSrc from "../web/src/main.ts?raw";
import { setMarkdownLib } from "../web/src/markdown-load";
import * as markdownLibModule from "../web/src/markdown-lib";

// The Markdown chunk (marked's lexer, which the Rendered view cuts blocks with) as if it had loaded.
setMarkdownLib(markdownLibModule);

// ── lineDiff ──────────────────────────────────────────────────────────────────

describe("lineDiff", () => {
  it("treats two empty strings as one shared empty context line", () => {
    // "".split("\n") === [""] — the LCS sees one matching empty line, not zero lines
    const rows = lineDiff("", "");
    expect(rows).toEqual([{ t: "ctx", text: "" }]);
  });

  it("produces add rows for non-empty lines when oldText is empty", () => {
    const rows = lineDiff("", "line1\nline2");
    expect(rows.some((r) => r.t === "add" && r.text === "line1")).toBe(true);
    expect(rows.some((r) => r.t === "add" && r.text === "line2")).toBe(true);
  });

  it("produces del rows for non-empty lines when newText is empty", () => {
    const rows = lineDiff("line1\nline2", "");
    expect(rows.some((r) => r.t === "del" && r.text === "line1")).toBe(true);
    expect(rows.some((r) => r.t === "del" && r.text === "line2")).toBe(true);
  });

  it("marks unchanged lines as ctx", () => {
    const rows = lineDiff("same\nline", "same\nline");
    expect(rows.every((r) => r.t === "ctx")).toBe(true);
  });

  it("detects a single line change", () => {
    const rows = lineDiff("line1\nold\nline3", "line1\nnew\nline3");
    const del = rows.filter((r) => r.t === "del");
    const add = rows.filter((r) => r.t === "add");
    expect(del.some((r) => r.text === "old")).toBe(true);
    expect(add.some((r) => r.text === "new")).toBe(true);
  });
});

// ── collapsedLineDiff ─────────────────────────────────────────────────────────

describe("collapsedLineDiff", () => {
  it("collapses large unchanged runs to a single ellipsis row", () => {
    const unchanged = Array.from({ length: 10 }, (_, i) => `ctx${i}`).join("\n");
    const old = `${unchanged}\nold line\n${unchanged}`;
    const nw = `${unchanged}\nnew line\n${unchanged}`;
    const rows = collapsedLineDiff(old, nw, 3);
    const ellipses = rows.filter((r) => r.t === "ellipsis");
    expect(ellipses.length).toBeGreaterThanOrEqual(1);
    expect(ellipses[0].text).toMatch(/\d+ unchanged line/);
  });

  it("keeps context lines around a changed line visible (within ctx window)", () => {
    const unchanged = Array.from({ length: 10 }, (_, i) => `ctx${i}`).join("\n");
    const old = `${unchanged}\nold line\n${unchanged}`;
    const nw = `${unchanged}\nnew line\n${unchanged}`;
    const rows = collapsedLineDiff(old, nw, 3);
    expect(rows.some((r) => r.t === "add")).toBe(true);
    expect(rows.some((r) => r.t === "del")).toBe(true);
    expect(rows.filter((r) => r.t === "ctx").length).toBeGreaterThanOrEqual(1);
  });

  it("returns all rows unchanged when the texts are identical", () => {
    const rows = collapsedLineDiff("a\nb\nc", "a\nb\nc");
    expect(rows.every((r) => r.t === "ctx" || r.t === "ellipsis")).toBe(true);
  });

  it("treats two empty strings as one shared empty context line (mirrors lineDiff)", () => {
    const rows = collapsedLineDiff("", "");
    expect(rows).toEqual([{ t: "ctx", text: "" }]);
  });
});

// ── Review surface ────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "p1",
    kind: "proposal",
    eyebrow: "PROPOSAL · DOCS / TEST",
    title: "Test Proposal",
    summary: "A summary",
    agent: "agent · session 0000",
    agentInitials: "A0",
    time: "1h ago",
    liveVersion: "LIVE (v2)",
    diff: [
      { t: "h", s: "## Heading" },
      { t: "ctx", s: "kept line" },
      { t: "del", s: "old line" },
      { t: "add", s: "new line" },
      { t: "gap" },
      { t: "add", s: "trailing add" },
    ],
    ...overrides,
  };
}

function makeReviewProps(overrides: Partial<ReviewProps> = {}): ReviewProps {
  return { items: [makeItem()], filter: "all", selectedId: null, diffView: "unified", ...overrides };
}
/** A drafted decision: the one kind of item that is a card of its own in the list (a doc change is a page of its
 *  agent's group — or of its import's). */
function makeAdr(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return makeItem({ kind: "decision", eyebrow: "DECISION · ADR-007", diff: undefined, adr: [{ h: "Context", p: "Why." }], ...overrides });
}

describe("reviewView — populated", () => {
  it("an agent's doc changes are ONE group card (the design's \"Written by ‹Name›'s agent\"), nothing picked until a page is", () => {
    const items = [makeItem({ agent: "pia", agentName: "Pia Test-Agent", space: "engineering", at: "2026-10-17T10:00:00Z" }), makeItem({ id: "p2", title: "Second", agent: "pia", agentName: "Pia Test-Agent", space: "engineering", isNew: true })];
    const html = reviewView(makeReviewProps({ items }));
    expect(html).toContain('data-morph-key="rvg:agent:pia"');
    expect(html).toContain("Written by Pia&#39;s agent");
    expect(html).toMatch(/data-rv-group="agent:pia" data-kind="agent"/);
    expect(html).toMatch(/class="cnpy-rvg-agav" role="img" aria-label="@pia&#39;s agent"/);
    expect(html).toMatch(/2 pages · /);
    expect(html).toMatch(/data-act="reviewGroupApprove" data-arg="agent:pia"[^>]*>Approve all 2</);
    expect(html).toContain('data-act="reviewGroupReject" data-arg="agent:pia"');
    expect(html).not.toContain('data-morph-key="rv:p1"');   // no card of its own
    expect(html).not.toContain('data-morph-key="rvd:');     // nothing picked by default
    // Opened, its pages are rows: a change to a live page reads "Change", a page nothing is live under "New page".
    const open = reviewView(makeReviewProps({ items, groupsOpen: { "agent:pia": true }, selectedId: "p1" }));
    expect(open).toMatch(/data-arg="p1" class="cnpy-rvg-pg" aria-current="true"[\s\S]*?<span class="cnpy-rvg-pk">Change<\/span>/);
    expect(open).toMatch(/data-arg="p2" class="cnpy-rvg-pg"[\s\S]*?<span class="cnpy-rvg-pk">New page<\/span>/);
    expect(open).toContain("Page 1 of 2 · Pia&#39;s agent");
    expect(open).toContain('data-morph-key="rvd:p1"');
    // Each author is a group of their own; a decision stays a card.
    const two = reviewView(makeReviewProps({ items: [...items, makeItem({ id: "p3", agent: "max" }), makeAdr({ id: "d1" })] }));
    expect(two).toContain('data-morph-key="rvg:agent:max"');
    expect(two).toContain("Written by max&#39;s agent");
    expect(two).toContain('data-morph-key="rv:d1"');
    expect(two).toContain('data-morph-key="rvd:d1"');        // the decision is the default selection
  });

  it("labels the accept action Ratify for decisions and renders the ADR record", () => {
    const item = makeItem({
      id: "d1", kind: "decision",
      diff: undefined, adr: [{ h: "Context", p: "Why." }, { h: "Decision", p: "What." }],
    });
    const html = reviewView(makeReviewProps({ items: [item] }));
    expect(html).toContain("Ratify");
    expect(html).toContain("PROPOSED RECORD");
    expect(html).toContain("no prior version");
    expect(html).not.toContain("WHAT CHANGED");
  });

  it("shows the stale-base warning only when stale", () => {
    const stale = makeItem({ stale: true, staleNote: "Proposed from v6 — live is v8." });
    expect(reviewView(makeReviewProps({ items: [stale], selectedId: "p1" }))).toContain(">Stale base</span>");
    expect(reviewView(makeReviewProps({ selectedId: "p1" }))).not.toContain("Stale base");
  });

  it("filter hides what it does not hold: Imports shows the import groups, Written by agents everything else", () => {
    const items = [makeItem(), makeItem({ id: "d1", kind: "decision", title: "A Decision", diff: undefined, adr: [] }), makeItem({ id: "i1", title: "Imported page", importId: 5, importFile: "handbook.zip", slug: "imported-page", space: "engineering" })];
    const imports = reviewView(makeReviewProps({ items, filter: "imports" }));
    expect(imports).toContain("Import from handbook.zip");
    // The agent rows are filtered out of the list: nothing is picked by default (a decision the filter hides is not).
    expect(imports).not.toContain("rvg:agent:");
    expect(imports).not.toContain("A Decision");
    const agents = reviewView(makeReviewProps({ items, filter: "agents" }));
    expect(agents).toContain("A Decision");
    expect(agents).toContain('data-morph-key="rvg:agent:');
    expect(agents).not.toContain("Import from handbook.zip");
  });
});

describe("reviewView — surface cards", () => {
  it("queue cards are clickable surfaces; every diff mode and the ADR record is one surface", () => {
    const list = reviewView(makeReviewProps({ items: [makeAdr()] }));
    // RV-OWNER-1: the card is a surface with a hit area (the author's avatar is its own button inside it).
    expect(list).toContain('class="cnpy-titem cnpy-surface cnpy-card cnpy-hitbox"');
    expect(list).toMatch(/<button( aria-current="true")? data-act="reviewSelect" data-arg="[^"]+" class="cnpy-hit" aria-label="[^"]+"><\/button>/);
    for (const diffView of ["unified", "split", "rendered"] as const) {
      const html = reviewDetail(makeItem(), diffView);
      expect(html.match(/cnpy-surface/g)?.length, diffView).toBe(1);
      expect(html, diffView).not.toContain("border:1px solid var(--border);border-radius:10px");
      expect(html, diffView).not.toContain("color-mix(in srgb,var(--fg) 2.5%");
    }
    const adr = reviewDetail(makeItem({ kind: "decision", diff: undefined, adr: [{ h: "Context", p: "Why." }] }), "unified");
    // The proposed record keeps its green accent rule on top of the surface.
    expect(adr).toMatch(/class="cnpy-surface" style="padding:24px 28px 26px"/);
    expect(adr).not.toContain("border-left:2px solid var(--green)"); // no accent edge on the record
    const stale = reviewDetail(makeItem({ stale: true, staleNote: "Proposed from v6." }), "unified");
    expect(stale).toMatch(/class="cnpy-surface" style="padding:11px 15px;margin-top:18px/);
    expect(staleBaseWarning("Proposed from v6.")).not.toContain("border-left"); // a warning mark, never a coloured edge
    expect(stale).toContain(">Stale base</span>");
  });
});

describe("reviewView — diff view modes", () => {
  it("unified mode renders +/− prefixed lines", () => {
    const html = reviewDetail(makeItem(), "unified");
    expect(html).toContain("old line");
    expect(html).toContain("new line");
    expect(html).toContain("−");
    expect(html).toContain("+");
  });

  it("split mode renders the LIVE and PROPOSED column headers", () => {
    const html = reviewDetail(makeItem(), "split");
    expect(html).toContain("LIVE (v2)");
    expect(html).toContain("PROPOSED");
    expect(html).toContain("grid-template-columns:1fr 1fr");
  });

  it("rendered mode renders the two BODIES through the markdown renderer, not the line-cut diff", () => {
    const html = reviewDetail(makeItem({ liveBody: "## Heading\n\nold line", proposedBody: "## Heading\n\nnew line" }), "rendered");
    expect(html).toContain('class="cnpy-md cnpy-rv-md"');
    expect(html).toContain('<div class="mock-md">new line</div>');
    expect(html).toContain("added in this proposal");
    expect(html).toContain("removed (struck)");
    // The diff's own lines (the fixture's "trailing add") are source views only.
    expect(html).not.toContain("trailing add");
  });
});

describe("reviewDetail — restructured header", () => {
  const decision = () => makeItem({
    id: "d1", kind: "decision", eyebrow: "DECISION · ADR-005",
    title: "Append-only feed as the record", agent: "AndresL230", time: "Jun 25",
    diff: undefined, adr: [{ h: "Context", p: "Why." }],
  });

  it("drops the uppercase eyebrow and folds type/id/author/date into one byline", () => {
    const html = reviewDetail(decision(), "unified");
    // The standalone uppercase eyebrow line is gone.
    expect(html).not.toContain("DECISION · ADR-005");
    // Title-cased record type, author, and date share the byline.
    expect(html).toContain(">Decision<");
    expect(html).toContain("AndresL230");
    expect(html).toContain("Jun 25");
    // The identifier reads as a reference: the label face.
    expect(html).toMatch(/font-family:var\(--label\)[^>]*>ADR-005</);
    // Title is the first element — it precedes the byline record type.
    expect(html.indexOf("Append-only feed as the record")).toBeLessThan(html.indexOf(">Decision<"));
  });

  it("wears no state tag — the verdict buttons say it is waiting — and the low-confidence mark beside them when set", () => {
    const html = reviewDetail(decision(), "unified");
    expect(html).not.toMatch(/>DRAFT<|>STAGED<|Low confidence/);
    expect(html.indexOf("Reject")).toBeLessThan(html.indexOf("Ratify"));
    const flagged = reviewDetail({ ...decision(), flagged: true }, "unified");
    expect(flagged).toContain(LOW_CONFIDENCE());
    expect(flagged.indexOf("Append-only feed as the record")).toBeLessThan(flagged.indexOf("Low confidence"));
    expect(flagged.indexOf("Low confidence")).toBeLessThan(flagged.indexOf("Reject"));
  });
});

describe("reviewCard — restructured to match the detail header", () => {
  it("leads with the title, no state tag, folds type/id/author/date into one byline", () => {
    const html = reviewCard(makeItem({
      eyebrow: "DECISION · ADR-005",
      title: "A decision card title", agent: "AndresL230", time: "Jun 25",
    }), false);
    // The uppercase eyebrow line above the title is gone.
    expect(html).not.toContain("DECISION · ADR-005");
    // Title is first — before the byline record type and before the badge.
    expect(html.indexOf("A decision card title")).toBeLessThan(html.indexOf(">Decision<"));
    expect(html).not.toMatch(/>DRAFT<|>STAGED</);
    // Byline folds type/id/author/date; identifier in the label face.
    expect(html).toContain(">Decision<");
    expect(html).toMatch(/font-family:var\(--label\)[^>]*>ADR-005</);
    expect(html).toContain("AndresL230");
    expect(html).toContain("Jun 25");
  });
});

describe("reviewView — agent handle carries the mapped person's color", () => {
  it("renders the agent's colored handle tag when agentColor is set, muted when it isn't", () => {
    const colored = makeAdr({ agent: "AndresL230", agentColor: "sky" });
    const html = reviewView(makeReviewProps({ items: [colored] }));
    expect(html).toContain("var(--p-sky)");
    expect(html).toContain("@AndresL230");

    const uncolored = makeAdr();
    const plain = reviewView(makeReviewProps({ items: [uncolored] }));
    expect(plain).toContain(`@${uncolored.agent}`);
    expect(plain).not.toContain("var(--p-");
  });
});

describe("splitDiffRows", () => {
  it("pairs a del run with an add run side by side", () => {
    const rows = splitDiffRows([{ t: "del", s: "old" }, { t: "add", s: "new" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].left).toMatchObject({ t: "del", text: "old" });
    expect(rows[0].right).toMatchObject({ t: "add", text: "new" });
  });

  it("fills the short side with empty cells when runs are uneven", () => {
    const rows = splitDiffRows([{ t: "del", s: "old" }, { t: "add", s: "a" }, { t: "add", s: "b" }]);
    expect(rows).toHaveLength(2);
    expect(rows[1].left.t).toBe("empty");
    expect(rows[1].right).toMatchObject({ t: "add", text: "b" });
  });

  it("spans ctx and heading rows across both columns", () => {
    const rows = splitDiffRows([{ t: "ctx", s: "same" }]);
    expect(rows[0].left.text).toBe("same");
    expect(rows[0].right.text).toBe("same");
  });
});

describe("diff viewer — ellipsis rows (collapsed unchanged runs)", () => {
  it("unifiedDiff renders an ellipsis row as a muted marker", () => {
    const html = unifiedDiff([{ t: "add", s: "new" }, { t: "ellipsis", s: "12 unchanged lines" }]);
    expect(html).toContain("12 unchanged lines");
  });

  it("splitDiffRows spans an ellipsis across both columns", () => {
    const rows = splitDiffRows([{ t: "ellipsis", s: "5 unchanged lines" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].left.text).toBe("5 unchanged lines");
    expect(rows[0].right.text).toBe("5 unchanged lines");
  });

  it("Rendered never shows a collapsed run: it renders the whole proposed doc, not the diff's rows", () => {
    const html = diffViewer({ diff: [{ t: "add", s: "kept" }, { t: "ellipsis", s: "9 unchanged lines" }], liveBody: "a", proposedBody: "a\n\nkept" }, "rendered");
    expect(html).toContain("kept");
    expect(html).not.toContain("9 unchanged lines");
  });
});

describe("reviewView — flagged marker (low-confidence scrutiny signal)", () => {
  it("marks Low confidence only on flagged items — an amber triangle and the words, never a tag", () => {
    const flagged = reviewView(makeReviewProps({ items: [makeAdr({ flagged: true })] }));
    expect(flagged).toContain(LOW_CONFIDENCE(12));
    expect(flagged).not.toContain("FLAGGED");
    expect(reviewView(makeReviewProps({ items: [makeAdr()] }))).not.toContain("Low confidence");
  });
});

describe("reviewView — empty states", () => {
  it("with no items the list says so and both panes draw their shape empty", () => {
    const html = reviewView(makeReviewProps({ items: [] }));
    expect(html).toContain('data-empty="review-list"');
    // The design's words (owner ruling, E2E RV18): a title and its sentence.
    expect(html).toContain('<p class="cnpy-empty-title">Nothing to review</p><p class="cnpy-empty-text">Pages that are imported or written by agents wait here until someone approves them. You&#39;ll see each import as one group.</p>');
    // The detail pane is a picture only: the list carries the one sentence.
    expect(html.split("cnpy-empty-text").length - 1).toBe(1);
    expect(html.split("cnpy-empty-shapes").length - 1).toBe(2);
    expect(html).not.toContain("data-skel=");
  });

  it("renders the list empty state when the filter hides everything, keeping the selected detail", () => {
    const html = reviewView(makeReviewProps({ filter: "imports", selectedId: "p1" }));
    expect(html).toContain("Nothing of this kind is waiting for review.");
    // Selection survives the filter — the detail still shows the proposal (its agent's page pane)
    expect(html).toContain("What changes");
  });
});

// ── XSS: hostile props are escaped ───────────────────────────────────────────

describe("XSS: review item fields are escaped in text and attributes", () => {
  const hostile = makeItem({
    id: 'x" onmouseover="alert(1)',
    title: "x<script>alert(1)</script",
    summary: 'sum"mary',
    diff: [{ t: "add", s: "<img src=x onerror=alert(1)>" }],
  });

  it("does not emit the raw attribute-breakout payload", () => {
    const html = reviewView(makeReviewProps({ items: [hostile], selectedId: hostile.id, groupsOpen: { [`agent:${hostile.agent}`]: true } }));
    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain("&quot;");
  });

  it("escapes angle brackets in titles and diff lines", () => {
    const html = reviewView(makeReviewProps({ items: [hostile], selectedId: hostile.id, groupsOpen: { [`agent:${hostile.agent}`]: true } }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;");
  });

  it("unifiedDiff escapes hostile line content directly", () => {
    const html = unifiedDiff([{ t: "add", s: "<b>bold</b>" }]);
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });
});

// ── Maintenance surface ───────────────────────────────────────────────────────

function makeUnplaced(overrides: Partial<UnplacedItem> = {}): UnplacedItem {
  return {
    id: "u1", title: "Loose thing", snippet: "A snippet.", reason: "Flagged by an agent",
    meta: "agent · session 0000 · 1h ago", reasonNote: "Could not place.", ...overrides,
  };
}

function makeGroup(overrides: Partial<IdentityGroup> = {}): IdentityGroup {
  return {
    id: "mk-dev2", login: "mk-dev2", meta: "first seen 3w ago",
    countLabel: "recent activity",
    sample: [{ kind: "PR", text: "#412 Fix a thing", when: "2d ago" }],
    ...overrides,
  };
}

function makeMaintProps(overrides: Partial<MaintenanceProps> = {}): MaintenanceProps {
  return {
    unplaced: [makeUnplaced()],
    assign: {
      kinds: [
        { key: "doc", label: "Doc section" },
        { key: "adr", label: "Decision record" },
        { key: "feed", label: "Feed update" },
      ],
      sections: ["reference", "context", "decisions"],
      spaces: [{ key: "engineering", label: "Engineering" }, { key: "product", label: "Product" }],
      tags: [{ name: "auth", color: "plum" }, { name: "infra", color: "rust" }],
    },
    assignOpen: null, assignKind: null, assignSection: null, assignSpace: null, assignTags: [],
    people: [{ id: "maya-k", name: "maya-k", initials: "MA" }],
    ...overrides,
  };
}

/** Org settings › Members › Unmatched logins (it was Maintenance › Identity). */
function makeIdentity(overrides: Partial<IdentityProps> = {}): IdentityProps {
  return {
    status: "ok", groups: [makeGroup()], discarded: [], showDiscarded: false,
    people: [{ id: "maya-k", name: "maya-k", initials: "MA" }], mapPicks: {}, mapConfirm: null,
    ...overrides,
  };
}

describe("identitySection — the unmatched logins (Org settings › Members)", () => {
  it("pairs the activity sample with the person picker", () => {
    const html = identitySection(makeIdentity());
    expect(html).toContain("mk-dev2");
    expect(html).toContain("#412 Fix a thing");
    expect(html).toContain("Who is this?");
    expect(html).toContain("maya-k");
    expect(html).toContain("Map login");
  });

  it("each card has a one-click Discard (no arm step — the toast carries the Undo)", () => {
    const html = identitySection(makeIdentity());
    expect(html).toMatch(/data-act="identityDiscard" data-arg="mk-dev2"[^>]*>Discard</);
  });

  it("no discarded logins → no discarded line; some → a quiet 'N discarded' toggle, Restore rows only when open", () => {
    expect(identitySection(makeIdentity())).not.toContain("identityToggleDiscarded");
    const discarded = [{ login: "rando-1", meta: "discarded 2h ago by andres" }, { login: "rando-2", meta: "discarded 1d ago by andres" }];
    const closed = identitySection(makeIdentity({ discarded }));
    expect(closed).toContain('data-act="identityToggleDiscarded" aria-expanded="false"');
    expect(closed).toContain("2 discarded &middot; Show");
    expect(closed).not.toContain('data-act="identityRestore"');
    const open = identitySection(makeIdentity({ discarded, showDiscarded: true }));
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('data-act="identityRestore" data-arg="rando-1"');
    expect(open).toContain('data-act="identityRestore" data-arg="rando-2"');
    expect(open).toContain("discarded 2h ago by andres");
    // With nothing waiting, the discarded logins are still reachable, so the last one can be brought back.
    const empty = identitySection(makeIdentity({ groups: [], discarded, showDiscarded: true }));
    expect(empty).toContain('data-act="identityRestore" data-arg="rando-1"');
    // Nothing waiting and nothing discarded: the section is simply not there.
    expect(identitySection(makeIdentity({ groups: [] }))).toBe("");
  });

  it("the discard toast carries the Undo that restores the login", () => {
    const html = render({
      ...initialState(), view: "app",
      me: { handle: "andres", name: null, avatar_url: null, color: "moss", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" as const }], superadmin: false, pending_invites: 0 },
      toast: "Discarded @rando-1", toastAction: { label: "Undo", act: "identityRestore", arg: "rando-1" }, toastAt: Date.now(), toastMs: 8000,
    });
    expect(html).toContain("Discarded @rando-1");
    expect(html).toContain('data-act="identityRestore" data-arg="rando-1" class="cnpy-toast-act"');
    // main.ts wires it: Discard flashes with UNDO_TOAST_MS and the identityRestore action.
    expect(mainSrc).toMatch(/flash\(`Discarded @\$\{arg\}`, UNDO_TOAST_MS, \{ label: "Undo", act: "identityRestore", arg \}\)/);
  });
});

describe("Unplaced — one queue, where Maintenance and its tabs were", () => {
  const triage = (id: number) => ({ id, raw: "{}", reason: "low_confidence", source_author: null, resolved: 0, created_at: "2026-09-27T00:00:00Z", resolved_at: null, resolved_by: null, resolution: null, assigned_ref: null }) as never;
  const task = (login: string) => ({ login, first_seen: "2026-09-27T00:00:00Z", status: "pending", resolved_at: null, resolved_by: null, sample: [] }) as never;
  const app = (over: Partial<ReturnType<typeof initialState>> = {}, role: "admin" | "member" = "admin") => render({
    ...initialState(), view: "app", screen: "review", reviewView: "unplaced", orgSlug: "saplinglearn",
    me: { handle: "andres", name: null, avatar_url: null, color: "moss", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role }], superadmin: false, pending_invites: 0 },
    needsTriage: { status: "ok", data: [triage(1), triage(2), triage(3)] },
    identityTasks: { status: "ok", data: [task("mk-dev2"), task("sky-42")] },
    ...over,
  });
  const header = (html: string) => html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  const main = (html: string) => html.slice(html.indexOf("</header>"), html.indexOf('class="cnpy-scrim"'));
  const navRow = (html: string, key: string) => { const at = html.indexOf(`cnpy-navrow n-${key}`); return html.slice(at, html.indexOf("</div>", at)); };

  it("is Review's other view: titled Review, the header's To review / Unplaced switch on Unplaced, no tab bar, no back button and no crumb", () => {
    const html = app();
    expect(header(html)).toContain(">Review</h1>");
    expect(header(html)).not.toContain(">Unplaced</h1>");
    // ONE segmented() switch in the header, each side with how many wait there; the picked side carries no act.
    expect(header(html)).toContain('data-seg="triage-view"');
    // Review's own reads are not in and no badges read has landed: its count is left off, never a guessed 0.
    expect(header(html)).toMatch(/aria-pressed="false"[^>]*>To review<\/button>/);
    expect(header(app({ proposals: { status: "ok", data: [] }, draftAdrs: { status: "ok", data: [] } }))).toMatch(/>To review<span class="cnpy-seg-n">0<\/span>/);
    expect(header(html)).toMatch(/class="cnpy-seg-btn is-on" aria-pressed="true">Unplaced<span class="cnpy-seg-n">3<\/span>/);
    // The switch picks a VIEW of the one Review screen (`setReviewView`), never another screen.
    expect(header(html)).toContain('data-act="setReviewView" data-arg="queue"');
    expect(header(html)).not.toContain('data-act="goMaintenance"');
    expect(header(html)).not.toContain("›");
    expect(main(html)).toContain('data-screen-label="Unplaced"');
    expect(main(html)).not.toContain('role="tablist"');
    expect(main(html)).not.toContain('role="tabpanel"');
    expect(html).not.toContain("setMaintTab");
    expect(mainSrc).not.toContain("setMaintTab");
  });

  it("holds only the queue: nothing of Identity, People or the e-mail digests is on it", () => {
    const body = main(app());
    expect(body).toContain("Things an agent produced");
    expect(body).toContain('data-act="maintDiscard"');
    for (const gone of ["Who is this?", "identityMap", "mk-dev2", "Unmatched logins", "policyToggle", "schedHour", "outboxToggle", "openPerson\" data-arg=\"andres"]) expect(body, gone).not.toContain(gone);
  });

  it("has no sidebar entry of its own: Review is lit, and its count is Review's queue plus the 3 unplaced", () => {
    const html = app();
    expect(html).not.toContain("cnpy-navrow n-maintenance");
    const row = navRow(html, "review");
    expect(row).toContain("cnpy-navrow n-review is-active");
    expect(row).toContain('<span class="cnpy-lbl cnpy-badge" data-n="3">3</span>');   // 3 unplaced; the 2 logins are not in it
    expect(navRow(app({ proposals: { status: "ok", data: [] }, draftAdrs: { status: "ok", data: [] }, badges: { proposals: 0, decisions: 0 } }), "review")).toContain('data-n="3"');
    expect(html).not.toContain(">Maintenance<");
    expect(triageCounts({ ...initialState(), needsTriage: { status: "ok", data: [triage(1)] }, identityTasks: { status: "ok", data: [task("a"), task("b")] } }).unplaced).toBe(1);
  });

  it("the logins to match are counted where an admin will act on them: the org switcher and its Org settings row", () => {
    const admin = app();
    expect(admin).toMatch(/data-orgsw-trigger[\s\S]*?<span class="cnpy-lbl cnpy-badge" data-n="2" title="2 logins to match in Org settings">2<\/span>/);
    const menu = app({ orgsUi: { ...initialState().orgsUi, menu: true } });
    expect(menu).toMatch(/data-act="orgsSettings"[^>]*>[\s\S]*?Org settings<\/span><span class="cnpy-badge" data-n="2" title="2 logins to match">2<\/span>/);
    // …and nowhere for a member, who cannot map a login.
    const member = app({ orgsUi: { ...initialState().orgsUi, menu: true } }, "member");
    expect(identityCount({ ...initialState(), identityTasks: { status: "ok", data: [task("a")] } })).toBe(0);
    expect(member).toMatch(/data-orgsw-trigger[\s\S]*?<span class="cnpy-lbl cnpy-badge" data-n="0"/);
    expect(member).toMatch(/Org settings<\/span><span class="cnpy-badge" data-n="0"/);
  });

  it("puts a degraded hint above the queue it could not refresh", () => {
    const html = main(app({ needsTriage: { status: "error", data: [triage(1)], error: "x" } as never }));
    expect(html).toContain("Couldn't load the triage queue.");
    expect(html.indexOf("Couldn't load the triage queue.")).toBeLessThan(html.indexOf("Things an agent produced"));
    expect(main(app({ needsTriage: { status: "error", data: [], error: "x" } as never }))).toContain("Couldn't load the Unplaced queue.");
  });

  it("a stale goMaintenance for a tab that moved opens Org settings › Members; otherwise it is Review's Unplaced view", () => {
    expect(mainSrc).toMatch(/case "goMaintenance":\s*if \(arg === "identity" \|\| arg === "people"\) \{ dispatch\("orgGo", "members", null\); return; \}\s*showReview\("unplaced"\);/);
  });
});

describe("XSS: maintenance fields are escaped in text and attributes", () => {
  it("escapes a hostile unplaced id and snippet", () => {
    const hostile = makeUnplaced({ id: 'u" onmouseover="alert(1)', snippet: "<img src=x onerror=alert(1)>" });
    const html = maintenanceView(makeMaintProps({ unplaced: [hostile] }));
    expect(html).not.toContain('" onmouseover="');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("escapes a hostile login and sample text", () => {
    const hostile = makeGroup({ login: "x<script>y", sample: [{ kind: "PR", text: '<svg onload="alert(1)">', when: "now" }] });
    const html = identitySection(makeIdentity({ groups: [hostile] }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<svg onload");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("personPicker — two-step confirm guard", () => {
  const people = [{ id: "maya-k", name: "maya-k", initials: "MA" }];

  it("shows Map login and no effect-note before the first click", () => {
    const html = personPicker("mk-dev2", people, "maya-k", false);
    expect(html).toContain("Map login");
    expect(html).not.toContain("past and future");
  });

  it("states the concrete effect and switches to Confirm mapping when confirming", () => {
    const html = personPicker("mk-dev2", people, "maya-k", true);
    expect(html).toContain("mk-dev2's activity will show as maya-k's, past and future.");
    expect(html).toContain("Confirm mapping");
    expect(html).toContain('data-act="identityCancel"');
  });
});

describe("Review and Unplaced — the detail's author opens their person card", () => {
  it("a mapped proposer is one chip in the detail byline; on the list card their avatar alone opens their card", () => {
    const it0 = makeItem({ agent: "maya-k", agentColor: "plum", agentHandle: "maya-k", agentName: "Maya K" });
    expect(reviewDetail(it0, "unified")).toMatch(/<button data-act="openPerson" data-arg="maya-k" class="cnpy-personchip"/);
    // RV-OWNER-1: the card is no longer a button (a hit area), so the avatar can be one — never a button in a button.
    const card = reviewCard(it0, false);
    expect(card).toMatch(/<button data-act="openPerson" data-arg="maya-k" class="cnpy-personav"[^>]*aria-label="@maya-k \(Maya K\) — person card"/);
    expect(card).not.toContain("cnpy-personchip");
  });

  it("an unmapped proposer stays plain in the detail", () => {
    expect(reviewDetail(makeItem(), "unified")).not.toContain('data-act="openPerson"');
  });

  it("the Unplaced author opens their card when mapped (the card's avatar and the detail's byline, as on Review), plain when not; the list rows stay select buttons", () => {
    const people = [{ id: "maya-k", name: "Maya K", initials: "MK", color: "plum" as const }];
    const mapped = maintenanceView(makeMaintProps({ people, unplaced: [makeUnplaced({ author: "maya-k", when: "1h ago" })] }));
    expect(mapped).toMatch(/<button data-act="openPerson" data-arg="maya-k" class="cnpy-personchip"/);
    expect(mapped).toMatch(/<button data-act="openPerson" data-arg="maya-k" class="cnpy-personav"/);
    expect((mapped.match(/data-act="openPerson"/g) ?? []).length).toBe(2);
    expect(mapped).toContain('data-act="maintSelect" data-arg="u1" class="cnpy-hit"');
    const stranger = maintenanceView(makeMaintProps({ people, unplaced: [makeUnplaced({ author: "ghost", when: "1h ago" })] }));
    expect(stranger).not.toContain('data-act="openPerson"');
  });
});

// ── the 0.26 polish: one title, two switches, a keyed list, a card that leaves ──────────────────

describe("Review — the screen is named once", () => {
  const html = render({ ...initialState(), view: "app", screen: "review", proposals: { status: "ok", data: [] }, draftAdrs: { status: "ok", data: [] } });
  it("the app header carries the title; the page has no heading of its own, only the one line", () => {
    expect(html.match(/<h1[ >]/g)?.length).toBe(1);
    expect(html).toMatch(/<h1 style="[^"]*">Review<\/h1>/);
    expect(html.split(REVIEW_INTRO).length - 1).toBe(1);
    expect(reviewView(makeReviewProps())).not.toContain("<h1");
  });
  it("Unplaced (Review's other view) does the same: the header's title, Review, and one line", () => {
    const un = render({ ...initialState(), view: "app", screen: "review", reviewView: "unplaced", needsTriage: { status: "ok", data: [] } });
    expect(un.match(/<h1[ >]/g)?.length).toBe(1);
    expect(un).toMatch(/<h1 style="[^"]*">Review<\/h1>/);   // Unplaced is Review's other view: the header names Review
  });
});

describe("Review — Unified / Side by side / Rendered is ONE segmented switch", () => {
  it("is a segmented() group with the same act and the picked mode pressed", () => {
    const html = reviewDetail(makeItem(), "split");
    const seg = html.slice(html.indexOf('data-seg="review-diff"'));
    expect(html).toMatch(/class="cnpy-seg cnpy-seg--sm" data-seg="review-diff"/);
    expect(seg).toContain('role="group"');
    for (const mode of ["unified", "rendered"]) expect(html).toContain(`data-act="reviewDiffView" data-arg="${mode}"`);
    expect(html).toMatch(/class="cnpy-seg-btn is-on" aria-pressed="true">Side by side</);
    // No hand-rolled chips left: the old ones were accent-bordered buttons.
    expect(html).not.toContain("border:1px solid var(--accent);color:var(--accent);background:var(--accent-soft)");
  });
  it("the mode's body is a keyed part, so a switch replaces it alone; the item's body is keyed by the item", () => {
    expect(reviewDetail(makeItem(), "unified")).toContain('class="cnpy-rv-diff" data-morph-key="diff:unified"');
    expect(reviewDetail(makeItem(), "rendered")).toContain('data-morph-key="diff:rendered"');
    expect(reviewDetail(makeItem(), "unified")).toContain('class="cnpy-rv-body" data-morph-key="rvd:p1"');
  });
  it("the default mode is still Unified", () => {
    expect(initialState().reviewDiffView).toBe("unified");
  });
});

describe("Review — All / Imports / Written by agents is a segmented switch with counts", () => {
  const items = [makeAdr(), makeAdr({ id: "p2", title: "Second" }), makeItem({ id: "i1", title: "Imported", importId: 4, importFile: "notes.zip", slug: "imported" })];
  it("picks one view of the same list, each option carrying how many wait", () => {
    const html = reviewView(makeReviewProps({ items, filter: "agents" }));
    expect(html).toMatch(/class="cnpy-seg cnpy-seg--sm" data-seg="review-filter"/);
    expect(html).not.toContain('role="tablist"');
    expect(html).toMatch(/data-act="reviewFilter" data-arg="all"[^>]*>All<span class="cnpy-seg-n">3<\/span>/);
    expect(html).toMatch(/class="cnpy-seg-btn is-on" aria-pressed="true">Written by agents<span class="cnpy-seg-n">2<\/span>/);
    expect(html).toMatch(/>Imports<span class="cnpy-seg-n">1<\/span>/);
  });
  it("shows no count while the queue is still being read (never a made-up 0)", () => {
    expect(reviewFilterSwitch("all", null)).not.toContain("cnpy-seg-n");
    expect(reviewView(makeReviewProps({ items: [], loading: true }))).not.toContain("cnpy-seg-n");
  });
  it("a selection the filter still shows stays selected; one it hides keeps its detail", () => {
    const shown = reviewView(makeReviewProps({ items, filter: "agents", selectedId: "p2" }));
    expect(shown).toMatch(/class="cnpy-titem cnpy-surface cnpy-card cnpy-hitbox" data-rv-card="p2" aria-current="true">\s*<button aria-current="true" data-act="reviewSelect" data-arg="p2"/);
    const hidden = reviewView(makeReviewProps({ items, filter: "imports", selectedId: "p2" }));
    expect(hidden).toContain('data-morph-key="rvd:p2"');
  });
});

describe("Review — the list is keyed, and a card with a verdict leaves it", () => {
  const items = [makeAdr(), makeAdr({ id: "p2", title: "Second" }), makeAdr({ id: "p3", title: "Third" })];
  const rowKeys = (html: string) => [...html.matchAll(/class="cnpy-rv-row" data-morph-key="([^"]+)"/g)].map((m) => m[1]);

  it("every row is a keyed child of a data-morph-list container, and the screen is patched in place", () => {
    const html = reviewView(makeReviewProps({ items }));
    expect(html).toMatch(/class="cnpy-scroll cnpy-stagger cnpy-rv-rows" data-morph-list/);
    expect(rowKeys(html)).toEqual(["rv:p1", "rv:p2", "rv:p3"]);
    expect(render({ ...initialState(), view: "app", screen: "review" })).toContain('<main data-morph="review"');
    expect(morphSrc).toContain('next.hasAttribute("data-morph-list")');
  });

  it("a card's structure is the same selected or not, with or without a verdict (only attributes differ)", () => {
    const shape = (h: string) => h.replace(/ aria-current="true"| data-verdict="\w+" inert/g, "").replace(/<span class="cnpy-rv-verdict" aria-hidden="true">.*?<\/span>/s, "<V/>");
    const plain = reviewCard(items[0], false);
    expect(shape(reviewCard(items[0], true))).toBe(shape(plain));
    expect(shape(reviewCard(items[0], false, "promoted"))).toBe(shape(plain));
    expect(plain).toContain('<span class="cnpy-selbar"></span>');
    expect(plain).toContain('<span class="cnpy-rv-verdict" aria-hidden="true"></span>');
  });

  it("a leaving card wears its verdict, is inert, and is out of the selection and the counts", () => {
    const html = reviewView(makeReviewProps({ items, selectedId: null, leaving: { p1: "promoted" } }));
    expect(rowKeys(html)).toEqual(["rv:p1", "rv:p2", "rv:p3"]);   // still in the list, same order
    expect(html).toMatch(/data-morph-key="rv:p1" data-verdict="promoted" inert/);
    expect(html).toMatch(/<span class="cnpy-rv-verdict" aria-hidden="true"><svg[^>]*>.*?<\/svg>Promoted<\/span>/);
    expect(html).toContain('data-morph-key="rvd:p2"');             // the detail moved on
    expect(html).toMatch(/class="cnpy-titem cnpy-surface cnpy-card cnpy-hitbox" data-rv-card="p2" aria-current="true">\s*<button aria-current="true" data-act="reviewSelect" data-arg="p2"/);
    expect(html).toMatch(/>All<span class="cnpy-seg-n">2<\/span>/);
    expect(reviewCard(items[0], false, "ratified")).toContain(">Ratified</span>");
    expect(reviewCard(items[0], false, "rejected")).toContain(">Rejected</span>");
  });

  it("the last card leaving already has the empty layout under it, so nothing jumps when it is gone", () => {
    const html = reviewView(makeReviewProps({ items: [items[0]], leaving: { p1: "rejected" } }));
    expect(html.indexOf('data-morph-key="rv:p1"')).toBeLessThan(html.indexOf('data-morph-key="rv-empty"'));
    expect(html).toContain('data-empty="review-list"');
    expect(html).not.toContain('data-morph-key="rvd:');          // nothing left to show: the detail draws its shape
  });

  it("the sidebar count drops with the card and comes back if the entry is removed (a failed write)", () => {
    const p = { slug: "a", version: 2, title: "A", section: "Architecture", space: "technical", summary: null, author: "x", confidence: null, status: "staged", change_kind: "edit" as const, low_confidence: 0, base_version: 1, current_version: 1, created_at: "2026-10-01T00:00:00Z", stagedBody: "b", promotedBody: "a", parent_slug: null, import_id: null, import_path: null, import_file_name: null, import_by: null, import_at: null };
    const s = { ...initialState(), view: "app" as const, screen: "review" as const, proposals: { status: "ok" as const, data: [p, { ...p, slug: "b" }] }, draftAdrs: { status: "ok" as const, data: [] } };
    expect(triageCounts(s).review).toBe(2);
    const leaving = { ...s, reviewLeaving: { "doc:a@2": { verdict: "promoted" as const, gone: false } } };
    expect(triageCounts(leaving).review).toBe(1);
    // Both are pages of x's agent's group: the one decided counts as reviewed while it leaves.
    expect(render(leaving)).toMatch(/data-morph-key="rvg:agent:x"/);
    expect(render(leaving)).toContain(">1 of 2 reviewed<");
    const gone = { ...s, reviewLeaving: { "doc:a@2": { verdict: "promoted" as const, gone: true } } };
    expect(triageCounts(gone).review).toBe(1);
    expect(render(gone)).not.toContain('data-morph-key="rv:doc:a@2"');
    expect(triageCounts({ ...s, reviewLeaving: {} }).review).toBe(2);
  });

  it("an agent's group: Reject all asks in the design's agent words; deciding it whole goes through each page's own cookie route", () => {
    const p = { slug: "a", version: 2, title: "A", section: "reference", space: "engineering", summary: null, author: "x", confidence: null, status: "staged", change_kind: "edit" as const, low_confidence: 0, base_version: 1, current_version: 1, created_at: "2026-10-01T00:00:00Z", stagedBody: "b", promotedBody: "a", parent_slug: null, import_id: null, import_path: null, import_file_name: null, import_by: null, import_at: null };
    const s = { ...initialState(), view: "app" as const, screen: "review" as const, proposals: { status: "ok" as const, data: [p, { ...p, slug: "b" }] }, draftAdrs: { status: "ok" as const, data: [] }, reviewGroupReject: { id: "agent:x", busy: false } };
    const html = render(s);
    expect(html).toContain("Reject 2 pages from x&#39;s agent?");
    expect(html).toContain("The agent&#39;s changes are thrown away. The live pages stay as they are.");
    expect(html).toMatch(/data-act="reviewGroupRejectGo" data-arg="agent:x"[^>]*>Reject 2 pages</);
    const fn = mainSrc.slice(mainSrc.indexOf("function reviewGroupVerdict"), mainSrc.indexOf("function noteGroupTotals"));
    // No new write: the agent's pages are promoted / rejected one by one, oldest first, by the routes a person uses.
    expect(fn).toContain("[...items].reverse()");
    expect(fn).toContain("accept ? promoteDoc(ref.slug, ref.version) : rejectDoc(ref.slug, ref.version)");
  });

  it("a group's Reject all moves the focus into its dialog, and closing it gives the focus back to Reject all (case RV12, Batch C)", () => {
    const at = (act: string) => mainSrc.slice(mainSrc.indexOf(`case "${act}":`), mainSrc.indexOf("case ", mainSrc.indexOf(`case "${act}":`) + 6));
    expect(at("reviewGroupReject")).toMatch(/rerender\(\);\s*mount\.querySelector<HTMLElement>\("\[data-confirm-focus\]"\)\?\.focus\(\);/);
    expect(at("reviewGroupRejectClose")).toContain('[data-act="reviewGroupReject"][data-arg="${CSS.escape(id)}"]');
  });

  it("the write is optimistic but restorable: main.ts deletes the entry and restores the selection when it fails", () => {
    const fn = mainSrc.slice(mainSrc.indexOf("function reviewVerdict"), mainSrc.indexOf("function loadDraftAdrsIfNeeded"));
    expect(fn).toMatch(/\.catch\(\(e\) => \{[\s\S]*delete state\.reviewLeaving\[id\];[\s\S]*state\.reviewSel = exit\.selBefore/);
    expect(fn).toContain("prefers-reduced-motion: reduce");   // no movement: the card is gone at once
    expect(fn).toContain("REVIEW_EXIT_MS");
    // The verdicts are still the four session-cookie writes, nothing else.
    for (const call of ["promoteDoc(ref.slug, ref.version)", "rejectDoc(ref.slug, ref.version)", "ratifyAdr(ref.id)", "rejectAdr(ref.id)"]) expect(fn).toContain(call);
  });
});

describe("Review — the exit's CSS (trov.css)", () => {
  const rule = (sel: string) => css.match(new RegExp(`${sel.replace(/[.[\]"=*]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
  it("a row is a one-track grid that collapses to 0fr on the app's one clock", () => {
    expect(rule(".cnpy-rv-row")).toContain("grid-template-rows:1fr");
    expect(rule(".cnpy-rv-row")).toContain("transition:grid-template-rows var(--fx-fast) var(--fx-ease), opacity var(--fx-fast) var(--fx-ease)");
    expect(rule(".cnpy-rv-row[data-verdict]")).toContain("grid-template-rows:0fr");
    expect(rule(".cnpy-rv-row[data-verdict]")).toContain("transition-delay:.13s");
  });
  it("a row's box may shrink below its card's content: an import group card never pushes the list sideways (E2E RV1)", () => {
    // The one track is `auto` wide: without min-width:0 the box takes its card's min-content width (the group card's
    // header and action row), 17px past the list, and the left pane scrolled sideways.
    expect(rule(".cnpy-rv-row-in")).toContain("min-width:0");
  });
  it("the script's timer is the hold plus the collapse, and the whole exit stays under 350ms", () => {
    const fast = Number(css.match(/--fx-fast:\.(\d+)s/)?.[1]) * 10;   // ".18s" → 180
    expect(REVIEW_EXIT_MS).toBe(130 + fast);
    expect(REVIEW_EXIT_MS).toBeLessThanOrEqual(350);
  });
  it("nothing eases under prefers-reduced-motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.cnpy-rv-row, \.cnpy-rv-row \.cnpy-titem, \.cnpy-rv-card-in, \.cnpy-rv-verdict \{ transition:none !important; \}/);
  });
  it("the verdict's tone is the diff's: green for promoted and ratified, red for rejected", () => {
    expect(css).toContain('.cnpy-rv-row[data-verdict="promoted"], .cnpy-rv-row[data-verdict="ratified"] { --rv-tone:var(--green); }');
    expect(css).toContain('.cnpy-rv-row[data-verdict="rejected"] { --rv-tone:var(--red); }');
  });
});

// e2e RV-OWNER-1 (Phase H, the owner): "the bottom rows with tags are confusing and are inconsistent in size and
// length being one or two lines". Every card's meta row is ONE line with the same slots in the same order; the path
// is sentence case and the only part that gives way (an ellipsis, the whole path in its tooltip). RV-OWNER-2: Trov's
// risk is not on the list card at all — only in the item's detail.
describe("Review cards: one meta row, the same slots; the risk only in the detail (RV-OWNER-1, RV-OWNER-2)", () => {
  const risk = [{ id: 7, itemType: "proposal", itemRef: "doc:x@2", kind: "review.risk", value: { risk: "decision", label: "Changes a decision" }, label: "Changes a decision", reason: "it changes ADR-1", confidence: 0.8, cites: [], state: "open" as const }] as unknown as ReviewItem["ai"];
  const meta = (html: string) => html.slice(html.indexOf('class="cnpy-rv-meta"'), html.indexOf("</div>", html.indexOf('data-slot="time"')));
  const proposal = () => makeItem({ eyebrow: "PROPOSAL · TECHNICAL / ARCHITECTURE" });
  it("ONE line: no wrap, a fixed height, overflow hidden", () => {
    const m = meta(reviewCard(proposal(), false));
    expect(m).toMatch(/^class="cnpy-rv-meta" style="display:flex;align-items:center;flex-wrap:nowrap;white-space:nowrap;overflow:hidden;[^"]*height:20px;/);
  });
  it("the slots, in the owner's order on every card: author (avatar), kind, where, time", () => {
    for (const it of [proposal(), makeItem({ kind: "decision", eyebrow: "DECISION · ADR-005", diff: undefined, adr: [] })]) {
      const slots = [...meta(reviewCard(it, false)).matchAll(/data-slot="(\w+)"/g)].map((x) => x[1]);
      expect(slots).toEqual(["author", "kind", "where", "time"]);
    }
  });
  it("the path is sentence case and the one part that truncates, the whole of it in the tooltip; an ADR number stays", () => {
    const m = meta(reviewCard(proposal(), false));
    expect(m).toContain('data-slot="where" data-mtip="Technical / Architecture" style="flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis">Technical / Architecture</span>');
    expect(m).not.toContain("TECHNICAL");
    for (const s of ["kind", "time"]) expect(m).toMatch(new RegExp(`data-slot="${s}" style="flex:none`));
    expect(m).toMatch(/data-slot="author" data-mtip="@[^"]+" style="flex:none/);
    expect(meta(reviewCard(makeItem({ kind: "decision", eyebrow: "DECISION · ADR-005" }), false))).toContain(">ADR-005</span>");
  });
  // RV-OWNER-2 (the owner): "remove the contradicts a doc thing from the cards, those are fine in the thing itself".
  it("a card with a risk looks exactly like one without: no risk mark on the list card", () => {
    const withRisk = reviewCard({ ...proposal(), ai: risk }, false);
    expect(withRisk).toBe(reviewCard(proposal(), false));
    expect(withRisk).not.toContain("Changes a decision");
    expect(withRisk).not.toContain("cnpy-ai-risk");
    expect(withRisk).not.toContain("cnpy-rv-marks");
  });
  it("the risk stays in the item's detail: its line, its reason one tap away, Dismiss", () => {
    const d = reviewDetail({ ...proposal(), ai: risk }, "unified");
    expect(d).toContain('class="cnpy-ai-risk-line"');
    expect(d).toContain("Changes a decision");
    expect(d).toMatch(/data-act="aiDismiss" data-arg="7"/);
  });
  it("the author is their avatar alone: no handle text in the row, the handle in its tooltip and accessible name", () => {
    const unmapped = meta(reviewCard(makeItem({ agent: "trov" }), false));
    expect(unmapped).toMatch(/data-slot="author" data-mtip="@trov"[^>]*><span role="img" aria-label="@trov"/);
    expect(unmapped.replace(/<[^>]+>/g, " ")).not.toContain("@trov");
    const mapped = meta(reviewCard(makeItem({ agent: "maya-k", agentColor: "plum", agentHandle: "maya-k", agentName: "Maya K" }), false));
    expect(mapped).toContain('data-act="openPerson" data-arg="maya-k"');
    expect(mapped.replace(/<[^>]+>/g, " ")).not.toContain("@maya-k");
  });
  it("Low confidence stays up-right on the title row; the title takes the room left of it and never shrinks it", () => {
    const html = reviewCard({ ...proposal(), flagged: true, ai: risk }, false);
    expect(html).toMatch(/<div style="flex:1 1 auto;[^"]*min-width:0">[^<]*<\/div>\s*<div class="cnpy-rv-marks" style="flex:none;margin-top:1px">/);
    const marks = html.slice(html.indexOf('class="cnpy-rv-marks"'), html.indexOf('class="cnpy-rv-meta"'));
    expect(marks).toContain("Low confidence");
    expect(marks).not.toContain("Changes a decision");
  });
});

// e2e RV-8 (Phase H): `GET /proposals` and `GET /adrs` carry `askFlags` (handoff #12 § 2.14), but nothing drew them —
// Review showed no "Flagged in Ask" line. The line: the reasons and how often, never the question, answer or asker.
describe("Flagged in Ask (handoff #12 § 2.14)", () => {
  const flags = [
    { ref: "doc:auth", reason: "out_of_date" as const, count: 1, lastAt: "2026-10-15T10:00:00Z" },
    { ref: "doc:auth", reason: "source_wrong" as const, count: 2, lastAt: "2026-10-15T10:00:00Z" },
  ];
  it("the detail draws one line of reasons and counts, most flagged first", () => {
    const html = reviewDetail(makeItem({ askFlags: flags }), "unified");
    const at = html.indexOf("cnpy-rv-askflags");
    expect(at).toBeGreaterThan(0);
    const line = html.slice(at, html.indexOf("</p>", at)).replace(/<[^>]+>/g, "").replace(/&middot;/g, "·").replace(/\s+/g, " ");
    expect(line).toContain("Flagged in Ask: A source is wrong (2) · It is out of date (1)");
  });
  it("no flags, no line (the detail as before)", () => {
    expect(reviewDetail(makeItem(), "unified")).not.toContain("Flagged in Ask");
    expect(reviewDetail(makeItem({ askFlags: [] }), "unified")).not.toContain("Flagged in Ask");
  });
  it("each read's flags go to their own item: a proposal by `doc:<slug>`, a decision by `decision:<id>`", () => {
    const rows = [{ slug: "auth" }, { slug: "other" }];
    const out = attachAskFlags(rows, flags, (r) => `doc:${r.slug}`);
    expect(out[0].askFlags).toEqual(flags);
    expect("askFlags" in out[1]).toBe(false);
    expect(attachAskFlags([{ id: 7 }], [{ ...flags[0], ref: "decision:7" }], (r) => `decision:${r.id}`)[0].askFlags).toHaveLength(1);
    expect(attachAskFlags(rows, undefined, (r) => `doc:${r.slug}`)).toEqual(rows);
  });
});

// ── the page pane (owner ruling round 2, E2E RV5 / RV6 / RV7): a group's page as the design draws it ──────────────

describe("Review — a group's page, picked, is the design's page pane", () => {
  const imp = (o: Partial<ReviewItem> = {}) => makeItem({ id: "doc:first-week@1", title: "Your first week", importId: 7, importFile: "handbook.zip", importPath: "handbook/onboarding/first-week.md", slug: "first-week", space: "engineering", path: ["Getting started", "Onboarding"], isNew: true, proposedBody: "Welcome.\n\n## Day one\n\nSee [[local-setup|Local setup]].", diff: [{ t: "add", s: "Welcome." }], ...o });
  const ver = imp({ id: "doc:local-setup@2", title: "Local setup", slug: "local-setup", path: ["Getting started"], isNew: false, proposedBody: "Install Node 20 and pnpm 9.", diff: [{ t: "ctx", s: "# Local setup" }, { t: "del", s: "Install Node 18 and pnpm." }, { t: "add", s: "Install Node 20 and pnpm 9." }, { t: "add", s: "Run pnpm setup." }] });
  const props = (sel: string, items = [imp(), ver]) => makeReviewProps({ items, selectedId: sel, groupsOpen: { 7: true }, spaceNames: { engineering: "Engineering" } });

  it("a new page: the bar, the crumb (its space, then the pages above it), the title, \"New page\" from its file, the page rendered — no diff box", () => {
    const html = reviewView(props("doc:first-week@1"));
    expect(html).toContain("Page 2 of 2 · handbook.zip");   // the queue is newest first: the group reverses it
    expect(html).toContain('<div class="cnpy-rvp-crumb">Engineering › Getting started › Onboarding</div>');
    expect(html).toContain('<h2 class="cnpy-rvp-h">Your first week</h2>');
    expect(html).toMatch(/<div class="cnpy-rvp-kind">[\s\S]*?>New page<\/span>[\s\S]*?<span class="cnpy-rvp-file">from handbook\/onboarding\/first-week.md<\/span>/);
    expect(html).not.toContain("What changes");
    // The page as it will read, through the reader's renderer, a [[link]] as its words.
    expect(html).toContain('<div class="cnpy-md cnpy-rvp-md"><div class="mock-md">Welcome.\n\n## Day one\n\nSee Local setup.</div></div>');
    // The old byline / Unified-Side by side-Rendered switch / header buttons are not on it.
    expect(html).not.toContain("WHAT CHANGED");
    expect(html).not.toContain('data-act="reviewDiffView"');
    expect(html).not.toContain(">Promote<");
    expect(html).not.toContain("<h1");
  });

  it("a new version: \"New version of ‹Title›\", then the diff box (\"What changes\", \"N lines added, M removed\"), then the page", () => {
    const html = reviewView(props("doc:local-setup@2"));
    expect(html).toContain(">New version of Local setup</span>");
    expect(html).toContain('<span style="font-weight:600;color:var(--fg)">What changes</span><span>2 lines added, 1 removed</span>');
    expect(html).toContain('<div class="cnpy-rvp-dl" data-t="del"><span class="cnpy-rvp-dp" aria-hidden="true">−</span>Install Node 18 and pnpm.</div>');
    expect(html).toContain('<div class="cnpy-rvp-dl" data-t="add"><span class="cnpy-rvp-dp" aria-hidden="true">+</span>Install Node 20 and pnpm 9.</div>');
    expect(html.indexOf("What changes")).toBeLessThan(html.indexOf("cnpy-rvp-md"));
  });

  it("the footer: the design's sentence, Reject and ✓ Approve — the queue's own verdict acts", () => {
    const html = reviewView(props("doc:local-setup@2"));
    const foot = html.slice(html.indexOf('class="cnpy-rvp-foot"'));
    expect(foot).toContain(`<span class="cnpy-rvp-note">${APPROVE_NOTE}</span>`);
    expect(APPROVE_NOTE).toBe("Approving makes this page live for everyone.");
    expect(foot).toMatch(/data-act="reviewReject" data-arg="doc:local-setup@2"[^>]*>Reject<\/button>/);
    expect(foot).toMatch(/data-act="reviewAccept" data-arg="doc:local-setup@2"[^>]*><svg[^>]*>.*?<\/svg>Approve<\/button>/);
    // A verdict button that had focus hands it on to the next page's (main.ts reads the footer too).
    expect(mainSrc).toContain('active?.closest?.(".cnpy-rv-head, .cnpy-rvp-foot")');
  });

  it("an agent's page: \"Change to a live page\" (or \"New page\"), no file; a decision keeps its own detail", () => {
    const a = makeItem({ id: "doc:rate-limits@2", title: "Rate limits", agent: "pia", agentName: "Pia", space: "engineering", path: ["Architecture", "API"] });
    const g = reviewGroups([a]).get("agent:pia")!;
    const pane = reviewPagePane(a, g, 1, {}, "Engineering");
    expect(pane).toContain("Page 1 of 1 · Pia&#39;s agent");
    expect(pane).toContain("Engineering › Architecture › API");
    expect(pane).toContain(">Change to a live page</span>");
    expect(pane).not.toContain("cnpy-rvp-file");
    expect(pageKindWord({ isNew: true, title: "X" }, "agent")).toBe("New page");
    expect(pageKindWord({ isNew: false, title: "X" }, "import")).toBe("New version of X");
    const d = reviewView(makeReviewProps({ items: [makeAdr({ id: "d1" })] }));
    expect(d).toContain("PROPOSED RECORD");
    expect(d).not.toContain("cnpy-rvp");
  });

  it("a page keeps its place: \"Page i of N\" does not shift when another page of the group is decided (Batch B finding, RV7)", () => {
    const page = (id: string) => imp({ id, title: id, slug: id, path: [] });
    // The queue is newest first: the group reverses it, so its order is a, b, c, d. d was decided and is gone.
    const html = reviewView(makeReviewProps({ items: [page("c"), page("b"), page("a")], selectedId: "b", groupsOpen: { 7: true }, groupTotals: { 7: 4 }, groupPages: { 7: ["a", "b", "c", "d"] }, spaceNames: { engineering: "Engineering" } }));
    expect(html).toContain("Page 2 of 4 · handbook.zip");
    expect(html).toContain(">1 of 4 reviewed<");
  });

  it("the diff box says how many lines changed, in words", () => {
    expect(changedLinesText([{ t: "add", s: "a" }, { t: "add", s: "b" }, { t: "add", s: "c" }, { t: "del", s: "d" }])).toBe("3 lines added, 1 removed");
    expect(changedLinesText([{ t: "add", s: "a" }])).toBe("1 line added");
    expect(changedLinesText([{ t: "del", s: "a" }, { t: "del", s: "b" }])).toBe("2 lines removed");
    expect(changedLinesText([{ t: "ctx", s: "a" }])).toBe("No line changes");
  });

  it("hostile words stay text in the crumb, the file and the diff", () => {
    const html = reviewView(props("doc:first-week@1", [imp({ path: ["<b>x</b>"], importPath: "a/<img src=x>.md", title: "<script>t</script>" })]));
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<script>t");
  });
});
