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
import { reviewView, reviewDetail, reviewCard, reviewFilterSwitch, diffViewer, unifiedDiff, splitDiffRows, REVIEW_EXIT_MS, REVIEW_INTRO, type ReviewItem, type ReviewProps } from "../web/src/review";
import css from "../web/src/trov.css?raw";
import morphSrc from "../web/src/morph.ts?raw";
import { maintenanceView, assignPanel, fileHint, type MaintenanceProps, type UnplacedItem } from "../web/src/maintenance";
import { identitySection, personPicker, type IdentityProps, type IdentityGroup } from "../web/src/identity";
import { render, initialState, triageCounts, identityCount } from "../web/src/render";
import mainSrc from "../web/src/main.ts?raw";

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

  it("rendered mode renders the two BODIES through the markdown renderer, not the line-cut diff", () => {
    const html = reviewView(makeReviewProps({ diffView: "rendered", items: [makeItem({ liveBody: "## Heading\n\nold line", proposedBody: "## Heading\n\nnew line" })] }));
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

  it("Rendered never shows a collapsed run: it renders the whole proposed doc, not the diff's rows", () => {
    const html = diffViewer({ diff: [{ t: "add", s: "kept" }, { t: "ellipsis", s: "9 unchanged lines" }], liveBody: "a", proposedBody: "a\n\nkept" }, "rendered");
    expect(html).toContain("kept");
    expect(html).not.toContain("9 unchanged lines");
  });
});

describe("reviewView — flagged marker (low-confidence scrutiny signal)", () => {
  it("renders FLAGGED only for flagged items", () => {
    expect(reviewView(makeReviewProps({ items: [makeItem({ flagged: true })] }))).toContain("FLAGGED");
    expect(reviewView(makeReviewProps())).not.toContain("FLAGGED");
  });
});

describe("reviewView — empty states", () => {
  it("with no items the list says so and both panes draw their shape empty", () => {
    const html = reviewView(makeReviewProps({ items: [] }));
    expect(html).toContain('data-empty="review-list"');
    expect(html).toContain("Nothing is waiting for review.");
    // The detail pane is a picture only: the list carries the one sentence.
    expect(html.split("cnpy-empty-text").length - 1).toBe(1);
    expect(html.split("cnpy-empty-shapes").length - 1).toBe(2);
    expect(html).not.toContain("data-skel=");
  });

  it("renders the list empty state when the filter hides everything, keeping the selected detail", () => {
    const html = reviewView(makeReviewProps({ filter: "decision", selectedId: "p1" }));
    expect(html).toContain("Nothing of this kind is waiting for review.");
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

describe("maintenanceView — the Unplaced queue", () => {
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
    ...initialState(), view: "app", screen: "maintenance", orgSlug: "saplinglearn",
    me: { handle: "andres", name: null, avatar_url: null, color: "moss", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role }], superadmin: false, pending_invites: 0 },
    needsTriage: { status: "ok", data: [triage(1), triage(2), triage(3)] },
    identityTasks: { status: "ok", data: [task("mk-dev2"), task("sky-42")] },
    ...over,
  });
  const header = (html: string) => html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  const main = (html: string) => html.slice(html.indexOf("</header>"), html.indexOf('class="cnpy-scrim"'));
  const navRow = (html: string, key: string) => { const at = html.indexOf(`cnpy-navrow n-${key}`); return html.slice(at, html.indexOf("</div>", at)); };

  it("is titled Unplaced, with no tab bar, no back button and no crumb", () => {
    const html = app();
    expect(header(html)).toContain(">Unplaced</h1>");
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
    expect(body).toContain('data-act="maintFile"');
    for (const gone of ["Who is this?", "identityMap", "mk-dev2", "Unmatched logins", "policyToggle", "schedHour", "outboxToggle", "openPerson\" data-arg=\"andres"]) expect(body, gone).not.toContain(gone);
  });

  it("the sidebar entry is Unplaced, and its count is the queue alone", () => {
    const row = navRow(app(), "maintenance");
    expect(row).toContain('data-act="goMaintenance"');
    expect(row).toContain('aria-label="Unplaced"');
    expect(row).toContain(">Unplaced</span>");
    expect(row).toContain('<span class="cnpy-lbl cnpy-badge" data-n="3">3</span>');   // 3 unplaced; the 2 logins are not in it
    expect(app()).not.toContain(">Maintenance<");
    expect(triageCounts({ ...initialState(), needsTriage: { status: "ok", data: [triage(1)] }, identityTasks: { status: "ok", data: [task("a"), task("b")] } }).maintenance).toBe(1);
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

  it("a stale goMaintenance for a tab that moved opens Org settings › Members", () => {
    expect(mainSrc).toMatch(/case "goMaintenance":\s*if \(arg === "identity" \|\| arg === "people"\) \{ dispatch\("orgGo", "members", null\); return; \}/);
  });
});

describe("maintenanceView — surface cards", () => {
  it("the queue sits in ONE surface card, rows hairline-divided inside", () => {
    const html = maintenanceView(makeMaintProps());
    expect(html.match(/cnpy-surface/g)?.length).toBe(1);
    expect(html).not.toContain("border-radius:12px");
    expect(html).not.toContain("color-mix(in srgb,var(--fg) 2.5%");
  });
});

describe("maintenanceView — empty state", () => {
  it("an empty queue has its own card", () => {
    const u = maintenanceView(makeMaintProps({ unplaced: [] }));
    expect(u).toContain('data-empty="unplaced"');
    expect(u).toContain("Nothing is unplaced, which is this queue");
    // It never claims an agent produced anything: a new organization's queue is empty too.
    expect(u).not.toContain("found its place");
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

describe("Review and Unplaced — the detail's author opens their person card", () => {
  it("a mapped proposer is one chip in the detail byline; the list card (a select button) keeps a plain pair", () => {
    const it0 = makeItem({ agent: "maya-k", agentColor: "plum", agentHandle: "maya-k", agentName: "Maya K" });
    expect(reviewDetail(it0, "unified")).toMatch(/<button data-act="openPerson" data-arg="maya-k" class="cnpy-personchip"/);
    expect(reviewCard(it0, false)).not.toContain('data-act="openPerson"');
  });

  it("an unmapped proposer stays plain in the detail", () => {
    expect(reviewDetail(makeItem(), "unified")).not.toContain('data-act="openPerson"');
  });

  it("the Unplaced detail's author is a chip when mapped, plain when not; the list rows stay select buttons", () => {
    const people = [{ id: "maya-k", name: "Maya K", initials: "MK", color: "plum" as const }];
    const mapped = maintenanceView(makeMaintProps({ people, unplaced: [makeUnplaced({ author: "maya-k", when: "1h ago" })] }));
    expect(mapped).toMatch(/<button data-act="openPerson" data-arg="maya-k" class="cnpy-personchip"/);
    expect((mapped.match(/data-act="openPerson"/g) ?? []).length).toBe(1);
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
  it("Unplaced does the same: the header's title and one line", () => {
    const un = render({ ...initialState(), view: "app", screen: "maintenance", needsTriage: { status: "ok", data: [] } });
    expect(un.match(/<h1[ >]/g)?.length).toBe(1);
    expect(un).toMatch(/<h1 style="[^"]*">Unplaced<\/h1>/);
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

describe("Review — All / Proposals / Decisions is a segmented switch with counts", () => {
  const items = [makeItem(), makeItem({ id: "p2", title: "Second" }), makeItem({ id: "d1", kind: "decision", title: "A Decision", diff: undefined, adr: [] })];
  it("picks one view of the same list, each option carrying how many wait", () => {
    const html = reviewView(makeReviewProps({ items, filter: "proposal" }));
    expect(html).toMatch(/class="cnpy-seg cnpy-seg--sm" data-seg="review-filter"/);
    expect(html).not.toContain('role="tablist"');
    expect(html).toMatch(/data-act="reviewFilter" data-arg="all"[^>]*>All<span class="cnpy-seg-n">3<\/span>/);
    expect(html).toMatch(/class="cnpy-seg-btn is-on" aria-pressed="true">Proposals<span class="cnpy-seg-n">2<\/span>/);
    expect(html).toMatch(/>Decisions<span class="cnpy-seg-n">1<\/span>/);
  });
  it("shows no count while the queue is still being read (never a made-up 0)", () => {
    expect(reviewFilterSwitch("all", null)).not.toContain("cnpy-seg-n");
    expect(reviewView(makeReviewProps({ items: [], loading: true }))).not.toContain("cnpy-seg-n");
  });
  it("a selection the filter still shows stays selected; one it hides keeps its detail", () => {
    const shown = reviewView(makeReviewProps({ items, filter: "proposal", selectedId: "p2" }));
    expect(shown).toMatch(/data-arg="p2" class="cnpy-titem cnpy-surface cnpy-card" aria-current="true"/);
    const hidden = reviewView(makeReviewProps({ items, filter: "decision", selectedId: "p2" }));
    expect(hidden).toContain('data-morph-key="rvd:p2"');
  });
});

describe("Review — the list is keyed, and a card with a verdict leaves it", () => {
  const items = [makeItem(), makeItem({ id: "p2", title: "Second" }), makeItem({ id: "p3", title: "Third" })];
  const rowKeys = (html: string) => [...html.matchAll(/class="cnpy-rv-row" data-morph-key="([^"]+)"/g)].map((m) => m[1]);

  it("every row is a keyed child of a data-morph-list container, and the screen is patched in place", () => {
    const html = reviewView(makeReviewProps({ items }));
    expect(html).toMatch(/class="cnpy-scroll cnpy-stagger cnpy-rv-rows" data-morph-list/);
    expect(rowKeys(html)).toEqual(["rv:p1", "rv:p2", "rv:p3"]);
    expect(render({ ...initialState(), view: "app", screen: "review" })).toContain('<main data-morph="review"');
    expect(morphSrc).toContain('next.hasAttribute("data-morph-list")');
  });

  it("a card's structure is the same selected or not, with or without a verdict (only attributes differ)", () => {
    const shape = (h: string) => h.replace(/ aria-current="true"| data-verdict="\w+" inert/g, "").replace(/<span class="cnpy-rv-verdict" aria-hidden="true">.*?<\/span>\s*<\/button>/s, "<V/></button>");
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
    expect(html).toMatch(/data-arg="p2" class="cnpy-titem cnpy-surface cnpy-card" aria-current="true"/);
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
    const p = { slug: "a", version: 2, title: "A", section: "Architecture", space: "technical", summary: null, author: "x", confidence: null, status: "staged", change_kind: "edit" as const, low_confidence: 0, base_version: 1, current_version: 1, created_at: "2026-10-01T00:00:00Z", stagedBody: "b", promotedBody: "a" };
    const s = { ...initialState(), view: "app" as const, screen: "review" as const, proposals: { status: "ok" as const, data: [p, { ...p, slug: "b" }] }, draftAdrs: { status: "ok" as const, data: [] } };
    expect(triageCounts(s).review).toBe(2);
    const leaving = { ...s, reviewLeaving: { "doc:a@2": { verdict: "promoted" as const, gone: false } } };
    expect(triageCounts(leaving).review).toBe(1);
    expect(render(leaving)).toMatch(/data-morph-key="rv:doc:a@2" data-verdict="promoted" inert/);
    const gone = { ...s, reviewLeaving: { "doc:a@2": { verdict: "promoted" as const, gone: true } } };
    expect(triageCounts(gone).review).toBe(1);
    expect(render(gone)).not.toContain('data-morph-key="rv:doc:a@2"');
    expect(triageCounts({ ...s, reviewLeaving: {} }).review).toBe(2);
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
