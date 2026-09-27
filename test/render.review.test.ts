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
import { describe, it, expect } from "vitest";
import { lineDiff, collapsedLineDiff } from "../web/src/diff";
import { reviewView, reviewDetail, reviewCard, unifiedDiff, renderedPreview, splitDiffRows, type ReviewItem, type ReviewProps } from "../web/src/review";
import { maintenanceView, assignPanel, personPicker, fileHint, type MaintenanceProps, type UnplacedItem, type IdentityGroup } from "../web/src/maintenance";

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
    badge: "STAGED",
    badgeColor: "var(--amber)",
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

describe("reviewView — populated", () => {
  it("renders the list card and the detail pane for the default selection", () => {
    const html = reviewView(makeReviewProps());
    expect(html).toContain("Test Proposal");
    expect(html).toContain("WHAT CHANGED");
    expect(html).toContain("Promote");
    expect(html).toContain("Reject");
  });

  it("labels the accept action Ratify for decisions and renders the ADR record", () => {
    const item = makeItem({
      id: "d1", kind: "decision", badge: "DRAFT", badgeColor: "var(--blue)",
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
    expect(reviewView(makeReviewProps({ items: [stale] }))).toContain("STALE BASE");
    expect(reviewView(makeReviewProps())).not.toContain("STALE BASE");
  });

  it("filter hides non-matching kinds from the list", () => {
    const props = makeReviewProps({
      items: [makeItem(), makeItem({ id: "d1", kind: "decision", title: "A Decision", diff: undefined, adr: [] })],
      filter: "decision",
    });
    const html = reviewView(props);
    expect(html).toContain("A Decision");
    // The proposal row is filtered out of the list (its title appears nowhere else)
    expect(html).not.toContain("Test Proposal");
  });
});

describe("reviewView — surface cards", () => {
  it("queue cards are clickable surfaces; every diff mode and the ADR record is one surface", () => {
    const list = reviewView(makeReviewProps());
    expect(list).toContain('class="cnpy-titem cnpy-surface cnpy-card"');
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
    expect(stale).toMatch(/class="cnpy-surface" style="border-left:2px solid var\(--amber\)/);
  });
});

describe("reviewView — diff view modes", () => {
  it("unified mode renders +/− prefixed lines", () => {
    const html = reviewView(makeReviewProps({ diffView: "unified" }));
    expect(html).toContain("old line");
    expect(html).toContain("new line");
    expect(html).toContain("−");
    expect(html).toContain("+");
  });

  it("split mode renders the LIVE and PROPOSED column headers", () => {
    const html = reviewView(makeReviewProps({ diffView: "split" }));
    expect(html).toContain("LIVE (v2)");
    expect(html).toContain("PROPOSED");
    expect(html).toContain("grid-template-columns:1fr 1fr");
  });

  it("rendered mode strips heading markers and shows the legend", () => {
    const html = reviewView(makeReviewProps({ diffView: "rendered" }));
    expect(html).toContain("added in this proposal");
    expect(html).toContain("removed (struck)");
    expect(html).toContain("Heading");
    expect(html).not.toContain("## Heading");
  });
});

describe("reviewDetail — restructured header", () => {
  const decision = () => makeItem({
    id: "d1", kind: "decision", eyebrow: "DECISION · ADR-005", badge: "DRAFT", badgeColor: "var(--blue)",
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

  it("moves the status badge up-right, next to the verdict controls", () => {
    const html = reviewDetail(decision(), "unified");
    expect(html).toContain("DRAFT");
    // Badge sits on the title's row (after the title) and beside the buttons (before Reject).
    expect(html.indexOf("Append-only feed as the record")).toBeLessThan(html.indexOf("DRAFT"));
    expect(html.indexOf("DRAFT")).toBeLessThan(html.indexOf("Reject"));
    expect(html.indexOf("Reject")).toBeLessThan(html.indexOf("Ratify"));
  });
});

describe("reviewCard — restructured to match the detail header", () => {
  it("leads with the title, badge up-right, folds type/id/author/date into one byline", () => {
    const html = reviewCard(makeItem({
      eyebrow: "DECISION · ADR-005", badge: "DRAFT", badgeColor: "var(--blue)",
      title: "A decision card title", agent: "AndresL230", time: "Jun 25",
    }), false);
    // The uppercase eyebrow line above the title is gone.
    expect(html).not.toContain("DECISION · ADR-005");
    // Title is first — before the byline record type and before the badge.
    expect(html.indexOf("A decision card title")).toBeLessThan(html.indexOf(">Decision<"));
    expect(html.indexOf("A decision card title")).toBeLessThan(html.indexOf("DRAFT"));
    // Byline folds type/id/author/date; identifier in the label face.
    expect(html).toContain(">Decision<");
    expect(html).toMatch(/font-family:var\(--label\)[^>]*>ADR-005</);
    expect(html).toContain("AndresL230");
    expect(html).toContain("Jun 25");
  });
});

describe("reviewView — agent handle carries the mapped person's color", () => {
  it("renders the agent's colored handle tag when agentColor is set, muted when it isn't", () => {
    const colored = makeItem({ agent: "AndresL230", agentColor: "sky" });
    const html = reviewView(makeReviewProps({ items: [colored] }));
    expect(html).toContain("var(--p-sky)");
    expect(html).toContain("@AndresL230");

    const uncolored = makeItem();
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

  it("renderedPreview replaces an ellipsis row with a divider (no count text)", () => {
    const html = renderedPreview([{ t: "add", s: "kept" }, { t: "ellipsis", s: "9 unchanged lines" }]);
    expect(html).toContain("kept");
    expect(html).not.toContain("9 unchanged lines");
    expect(html).toContain("border-top:1px dashed");
  });
});

describe("reviewView — flagged marker (low-confidence scrutiny signal)", () => {
  it("renders FLAGGED only for flagged items", () => {
    expect(reviewView(makeReviewProps({ items: [makeItem({ flagged: true })] }))).toContain("FLAGGED");
    expect(reviewView(makeReviewProps())).not.toContain("FLAGGED");
  });
});

describe("reviewView — empty states", () => {
  it("renders the list 'All clear' card and the detail 'Queue is clear' card with no items", () => {
    const html = reviewView(makeReviewProps({ items: [] }));
    expect(html).toContain("All clear");
    expect(html).toContain("Queue is clear");
  });

  it("renders the list empty state when the filter hides everything, keeping the selected detail", () => {
    const html = reviewView(makeReviewProps({ filter: "decision", selectedId: "p1" }));
    expect(html).toContain("All clear");
    // Selection survives the filter — the detail still shows the proposal
    expect(html).toContain("WHAT CHANGED");
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
    const html = reviewView(makeReviewProps({ items: [hostile] }));
    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain("&quot;");
  });

  it("escapes angle brackets in titles and diff lines", () => {
    const html = reviewView(makeReviewProps({ items: [hostile] }));
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
    id: "u1", title: "Loose thing", snippet: "A snippet.", reason: "AGENT FLAGGED",
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
    tab: "unplaced",
    unplaced: [makeUnplaced()],
    assign: {
      kinds: [
        { key: "doc", label: "Doc section" },
        { key: "adr", label: "Decision record" },
        { key: "feed", label: "Feed update" },
      ],
      sections: ["reference", "context", "decisions"],
      spaces: ["technical", "product"],
      tags: ["auth", "infra"],
    },
    assignOpen: null, assignKind: null, assignSection: null, assignSpace: null, assignTags: [],
    discardArm: false,
    identity: [makeGroup()],
    people: [{ id: "maya-k", name: "maya-k", initials: "MA" }],
    mapPicks: {},
    mapConfirm: null,
    ...overrides,
  };
}

describe("maintenanceView — Unplaced tab", () => {
  it("lists the items and shows the first one on screen with its position", () => {
    const html = maintenanceView(makeMaintProps({ unplaced: [makeUnplaced(), makeUnplaced({ id: "u2", title: "Second thing", snippet: "Second." })] }));
    expect(html).toContain("Things an agent produced but couldn&#39;t place.");
    expect(html).toContain('data-act="maintSelect" data-arg="u1"');
    expect(html).toContain('data-act="maintSelect" data-arg="u2"');
    expect(html).toContain("1 of 2");
    expect(html).toContain("Why it wasn't placed:");
    expect(html).not.toContain("mk-dev2"); // Identity is its own tab now
  });

  it("selecting another item puts it on screen", () => {
    const html = maintenanceView(makeMaintProps({ unplaced: [makeUnplaced(), makeUnplaced({ id: "u2", title: "Second thing", snippet: "Second." })], assignOpen: "u2" }));
    expect(html).toContain("2 of 2");
    expect(html).toContain('data-act="maintFile" data-arg="u2"');
  });

  it("centers its wrapper (margin:0 auto) like every other screen", () => {
    const html = maintenanceView(makeMaintProps());
    expect(html).toMatch(/max-width:\s*\d+px;\s*margin:\s*0 auto/);
  });

  it("gates File it on a kind (and a section for a doc), and arms Discard in two steps", () => {
    const none = maintenanceView(makeMaintProps());
    expect(none).toContain("Pick what it is first");
    expect(none).not.toMatch(/class="cnpy-accentbtn"[^>]*>File it/);
    const doc = maintenanceView(makeMaintProps({ assignOpen: "u1", assignKind: "doc" }));
    expect(doc).toContain("Pick a section");
    expect(doc).toContain("reference");
    const ready = maintenanceView(makeMaintProps({ assignOpen: "u1", assignKind: "doc", assignSection: "reference" }));
    expect(ready).toContain("Stages a proposal in reference");
    expect(ready).toContain("cnpy-accentbtn");
    expect(maintenanceView(makeMaintProps())).toContain(">Discard<");
    expect(maintenanceView(makeMaintProps({ discardArm: true }))).toContain("Click again to discard");
  });
});

describe("maintenanceView — Identity tab", () => {
  it("pairs the activity sample with the person picker", () => {
    const html = maintenanceView(makeMaintProps({ tab: "identity" }));
    expect(html).toContain("mk-dev2");
    expect(html).toContain("#412 Fix a thing");
    expect(html).toContain("Who is this?");
    expect(html).toContain("maya-k");
    expect(html).toContain("Map login");
    expect(html).not.toContain("Loose thing");
  });
});

describe("maintenanceView — surface cards", () => {
  it("Unplaced and Identity each sit in ONE surface card, rows hairline-divided inside", () => {
    for (const tab of ["unplaced", "identity"] as const) {
      const html = maintenanceView(makeMaintProps({ tab }));
      expect(html.match(/cnpy-surface/g)?.length, tab).toBe(1);
      expect(html, tab).not.toContain("border-radius:12px");
      expect(html, tab).not.toContain("color-mix(in srgb,var(--fg) 2.5%");
    }
  });
});

describe("maintenanceView — empty states", () => {
  it("Unplaced and Identity each have their own empty card", () => {
    const u = maintenanceView(makeMaintProps({ unplaced: [], identity: [] }));
    expect(u).toContain("All clear");
    expect(u).toContain("Everything an agent produced found its place on its own.");
    const i = maintenanceView(makeMaintProps({ tab: "identity", unplaced: [], identity: [] }));
    expect(i).toContain("Everyone is accounted for");
    expect(i).toContain("Every login in the activity stream is matched to a person.");
  });

  it("People renders the body the caller passes", () => {
    expect(maintenanceView(makeMaintProps({ tab: "people" }), "<p>directory</p>")).toContain("<p>directory</p>");
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
    const html = maintenanceView(makeMaintProps({ tab: "identity", identity: [hostile] }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<svg onload");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("assignPanel — per-type targets from the real vocabulary", () => {
  const assign = makeMaintProps().assign;

  it("offers the three kinds and no target until one is picked", () => {
    const html = assignPanel("7", assign, null, null, null, []);
    expect(html).toContain("File it as");
    expect(html).toContain("Doc section");
    expect(html).not.toContain("reference");
  });

  it("doc kind offers sections plus an optional space", () => {
    const html = assignPanel("7", assign, "doc", null, null, []);
    expect(html).toContain("reference");
    expect(html).toContain("decisions");
    expect(html).toContain("technical");
    expect(html).toContain("optional");
  });

  it("feed kind offers multi-select tags", () => {
    const html = assignPanel("7", assign, "feed", null, null, ["auth"]);
    expect(html).toContain('data-act="maintAssignTag" data-arg="auth"');
    expect(html).toContain('data-act="maintAssignTag" data-arg="infra"');
  });

  it("the adr kind needs no target", () => {
    const html = assignPanel("7", assign, "adr", null, null, []);
    expect(html).not.toContain("maintAssignSection");
    expect(html).not.toContain("maintAssignTag");
    expect(fileHint("adr", null)).toBe("Creates a draft decision in Review");
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

// ── doc images in the Rendered view (docs/superpowers/specs/2026-09-24-doc-images-design.md) ──

describe("Review › Rendered shows the proposed images", () => {
  const A = "f".repeat(64);
  it("an added image line renders the picture (zoomable), outlined as added, with its alt as caption", () => {
    const html = renderedPreview([{ t: "add", s: `![The deploy flow](/img/${A})` }]);
    expect(html).toContain(`<img src="/img/${A}" alt="The deploy flow"`);
    expect(html).toContain(`data-act="docImgZoom" data-arg="${A}"`);
    expect(html).toContain("border-color:var(--green)");
    expect(html).toContain("<figcaption");
    expect(html).not.toContain("![The deploy flow]");
  });
  it("a removed image is dimmed with a red outline; text around an image still reads as text", () => {
    const html = renderedPreview([{ t: "del", s: `See ![old](/img/${A}) above` }]);
    expect(html).toContain("border-color:var(--red);opacity:.55");
    expect(html).toContain("See  above");
  });
  it("an alt text cannot inject markup", () => {
    const html = renderedPreview([{ t: "add", s: `![<b onmouseover=x>](/img/${A})` }]);
    expect(html).not.toContain("<b onmouseover");
    expect(html).toContain("&lt;b onmouseover=x&gt;");
  });
});
