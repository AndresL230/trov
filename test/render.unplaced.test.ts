/**
 * Review › Unplaced (web/src/maintenance.ts; the switch at the top of Review), restyled to Review's frame (2026-10-18): the two panes, the queue a KEYED
 * list of surface cards that leave by the app's one row exit when an item is placed or discarded, the item in Review's
 * page pane with Discard and Place in its footer, the picks as `segmented()` / `dropdown()` (never a <select>), the
 * Low confidence mark from marks.ts, the empty layout and the skeleton — and main.ts's wiring (the exit, the Undo).
 */
import { describe, it, expect, vi } from "vitest";

// marked + DOMPurify cannot run in this pool (no DOM) — the render tests' usual mock.
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`,
  renderMarkdownInline: (text: string) => text,
}));
import {
  maintenanceView, maintenanceSkeleton, effectivePicks, fileHint, UNPLACED_EXIT_MS, UNPLACED_EMPTY, UNPLACED_INTRO,
  type MaintenanceProps, type UnplacedItem,
} from "../web/src/maintenance";
import { REVIEW_EXIT_MS, reviewView } from "../web/src/review";
import { unplacedFromRow, unplacedReasonWord } from "../web/src/triage-map";
import { render, initialState, triageCounts } from "../web/src/render";
import type { NeedsTriageRow } from "@shared/rows";
import css from "../web/src/trov.css?raw";
import mainSrc from "../web/src/main.ts?raw";

const doc = (over: Partial<UnplacedItem> = {}): UnplacedItem => ({
  id: "u1", title: "Deploy checklist", snippet: "Run the migrations, then check health.", reason: "Unknown section",
  meta: "", reasonNote: "out-of-vocab section: runbooks", author: "maya-k", when: "2h ago", kind: "doc",
  body: "Run the migrations, then check **health**.", section: "runbooks", space: null, tags: [], ...over,
});

function props(over: Partial<MaintenanceProps> = {}): MaintenanceProps {
  return {
    unplaced: [doc(), doc({ id: "u2", title: "Second", section: "reference" })],
    assign: {
      kinds: [{ key: "doc", label: "Doc" }, { key: "adr", label: "Decision" }, { key: "feed", label: "Feed entry" }],
      sections: ["reference", "context", "decisions"],
      spaces: [{ key: "engineering", label: "Engineering" }, { key: "product", label: "Product" }],
      tags: [{ name: "auth", color: "plum" }, { name: "infra", color: "rust" }],
    },
    assignOpen: null, assignKind: null, assignSection: null, assignSpace: null, assignTags: [],
    people: [{ id: "maya-k", name: "Maya K", initials: "MK", color: "plum" }],
    ...over,
  };
}

describe("Unplaced — Review's frame", () => {
  it("two panes (they take turns on a phone), the intro, a keyed list of surface cards", () => {
    const html = maintenanceView(props());
    expect(html).toContain('class="cnpy-rv cnpy-up-screen" data-screen-label="Unplaced" data-view="unplaced" data-pane="list"');
    expect(html).toContain(UNPLACED_INTRO.replaceAll("'", "&#39;"));
    // How many wait is on the header's To review / Unplaced switch (render.ts `triageSwitch`), as Review's are.
    expect(html).not.toContain("waiting<");
    expect(html).toMatch(/class="cnpy-scroll cnpy-stagger cnpy-rv-rows" data-morph-list/);
    expect(html).toContain('data-morph-key="up:u1"');
    expect(html).toContain('data-morph-key="up:u2"');
    expect(html.match(/class="cnpy-titem cnpy-surface cnpy-card cnpy-hitbox"/g)).toHaveLength(2);
    // The first is on screen when none is picked; its page and footer are keyed by it.
    expect(html).toMatch(/data-up-card="u1" aria-current="true"/);
    expect(html).toContain('data-morph-key="upd:u1"');
    expect(html).toContain('data-morph-key="upf:u1"');
    expect(html).toContain("1 of 2 unplaced");
    expect(html).toContain('data-act="maintBack" class="cnpy-rv-back"');
  });

  it("an item picked by hand is on screen, and on a phone the item's pane shows", () => {
    const html = maintenanceView(props({ assignOpen: "u2" }));
    expect(html).toContain('data-pane="detail"');
    expect(html).toMatch(/data-up-card="u2" aria-current="true"/);
    expect(html).toContain("2 of 2 unplaced");
  });

  it("a card: the title, two lines of it, then ONE line — the author, what it is, why it is here (a fact, plain), when", () => {
    const html = maintenanceView(props());
    const card = html.slice(html.indexOf('data-morph-key="up:u1"'), html.indexOf('data-morph-key="up:u2"'));
    expect(card).toContain('data-slot="kind" style="flex:none">Doc proposal<');
    expect(card).toMatch(/data-slot="why" data-mtip="out-of-vocab section: runbooks"[^>]*>Unknown section</);
    expect(card).toContain('data-slot="time" style="flex:none;color:var(--fg-40)">2h ago<');
    expect(card).not.toMatch(/text-transform:uppercase/);
  });

  it("an item sent with low confidence wears Review's Low confidence mark (a mark, never a pill)", () => {
    const html = maintenanceView(props({ unplaced: [doc({ lowConfidence: true, reason: "Low confidence" })] }));
    expect(html).toContain('<div class="cnpy-rv-marks"');
    expect(html).toContain("Low confidence");
    expect(maintenanceView(props())).not.toContain("cnpy-rv-marks");
  });

  it("the page pane: why it wasn't placed (verbatim), the doc rendered as it will read, then Place it as", () => {
    const html = maintenanceView(props());
    expect(html).toContain('<div class="cnpy-rvp cnpy-rvp--bg cnpy-up">');
    expect(html).toContain("Why it wasn't placed");
    expect(html).toContain("out-of-vocab section: runbooks");
    expect(html).toContain('<div class="cnpy-md cnpy-rvp-md">');
    expect(html).toContain('<div class="mock-live-md">Run the migrations, then check **health**.</div>');
    expect(html.indexOf("Why it wasn't placed")).toBeLessThan(html.indexOf("Place it as"));
  });
});

describe("Unplaced — Place it as", () => {
  it("every pick is a segmented switch, never a native select", () => {
    const html = maintenanceView(props());
    expect(html).toContain('data-seg="up-kind"');
    expect(html).toContain('data-seg="up-section"');
    expect(html).toContain('data-seg="up-space"');
    expect(html).not.toContain("<select");
    // Sections in sentence case; the item's kind already picked (it is a doc).
    expect(html).toMatch(/class="cnpy-seg-btn is-on"[^>]*aria-pressed="true">Doc</);
    expect(html).toContain(">Reference<");
  });

  it("starts from what the agent sent when it is valid: a well-formed doc is one press from placed", () => {
    // u2 was sent to `reference`, no space → the default space.
    const html = maintenanceView(props({ assignOpen: "u2" }));
    expect(html).toContain('data-act="maintFile" data-arg="u2"');
    expect(html).toContain("Stages a proposal in Reference · Engineering, for Review");
    // u1's section is not one of the vocabulary's: Place waits for a pick.
    const bad = maintenanceView(props());
    expect(bad).not.toContain('data-act="maintFile"');
    expect(bad).toMatch(/<button type="button" disabled class="cnpy-rvp-btn cnpy-up-place-btn"/);
    expect(bad).toContain("Pick a section");
  });

  it("past four spaces the Space pick is the app's dropdown", () => {
    const spaces = ["a", "b", "c", "d", "e"].map((k) => ({ key: k, label: k.toUpperCase() }));
    const html = maintenanceView(props({ assign: { ...props().assign, spaces } }));
    expect(html).toContain('data-dd="up-space"');
    expect(html).not.toContain('data-seg="up-space"');
  });

  it("a feed entry offers the org's tags as toggles in their own colour; a decision needs no target", () => {
    const feed = maintenanceView(props({ unplaced: [doc({ kind: "feed" })], assignOpen: "u1", assignTags: ["auth"] }));
    expect(feed).toMatch(/data-act="maintAssignTag" data-arg="auth" class="cnpy-up-tag is-on" aria-pressed="true"/);
    expect(feed).toMatch(/data-act="maintAssignTag" data-arg="infra" class="cnpy-up-tag" aria-pressed="false"/);
    expect(feed).toContain('class="cnpy-tagmark" data-tag="auth"');
    expect(feed).toContain("Posts it to the feed");
    const adr = maintenanceView(props({ unplaced: [doc({ kind: "decision", adr: [{ h: "Decision", p: "Use D1." }] })] }));
    expect(adr).not.toContain("maintAssignSection");
    expect(adr).toContain("Use D1.");
    expect(adr).toContain("Stages a draft decision, for Review");
  });

  it("a note (free text) has nowhere to go: it says so, and only Discard is offered", () => {
    const html = maintenanceView(props({ unplaced: [doc({ kind: "note", body: "remember to cap pools" })] }));
    expect(html).toContain("there is nowhere to place it");
    expect(html).not.toContain("maintFile");
    expect(html).toContain('data-act="maintDiscard" data-arg="u1"');
  });

  it("effectivePicks: the person's picks for the item on screen, else what was sent when valid, else the default space", () => {
    const p = props();
    expect(effectivePicks(doc({ section: "context", space: "product" }), p, false)).toEqual({ kind: "doc", section: "context", space: "product", tags: [] });
    expect(effectivePicks(doc({ space: "gone" }), p, false)).toMatchObject({ section: null, space: "engineering" });
    expect(effectivePicks(doc(), { ...p, assignSection: "decisions", assignSpace: "product" }, true)).toMatchObject({ section: "decisions", space: "product" });
    // Picks that belong to another item are not this one's.
    expect(effectivePicks(doc(), { ...p, assignSection: "decisions" }, false).section).toBeNull();
    expect(effectivePicks(doc({ kind: "note" }), p, false).kind).toBeNull();
    expect(fileHint(null, null)).toBe("Pick what it is first");
  });
});

describe("Unplaced — a card that leaves (placed or discarded)", () => {
  it("wears its verdict, inert, out of the count and never on screen; the next item is", () => {
    const html = maintenanceView(props({ leaving: { u1: "discarded" } }));
    expect(html).toMatch(/data-morph-key="up:u1" data-verdict="discarded" inert/);
    expect(html).toContain("Discarded</span>");
    expect(html).toMatch(/data-up-card="u2" aria-current="true"/);
    expect(html).toContain('data-morph-key="upd:u2"');
    expect(maintenanceView(props({ leaving: { u2: "placed" } }))).toContain("Placed</span>");
  });

  it("the last card leaving has the empty layout already under it", () => {
    const html = maintenanceView(props({ unplaced: [doc()], leaving: { u1: "placed" } }));
    expect(html).toContain('data-morph-key="up-empty"');
    expect(html).toContain('data-empty="unplaced"');
  });

  it("Review's one exit and clock: the same row CSS, a tone per verdict, the same length, off under reduced motion", () => {
    expect(UNPLACED_EXIT_MS).toBe(REVIEW_EXIT_MS);
    expect(css).toContain('.cnpy-rv-row[data-verdict="placed"] { --rv-tone:var(--green); }');
    expect(css).toContain('.cnpy-rv-row[data-verdict="discarded"] { --rv-tone:var(--fg-55); }');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.cnpy-rv-row, [^}]*transition:none !important; \}/);
    // main.ts: the card is gone at once under reduced motion, and leaves only on this screen.
    expect(mainSrc).toContain('const animate = state.screen === "review" && state.reviewView === "unplaced" && !reducedMotion();');
    expect(mainSrc).toContain("state.unplacedLeaving[id] = { verdict, gone: !animate };");
  });

  it("Discard has no arm step: the toast carries the Undo, which restores the item (a soft exit)", () => {
    expect(maintenanceView(props())).toContain('data-act="maintDiscard" data-arg="u1" class="cnpy-rejectbtn cnpy-rvp-btn"');
    expect(mainSrc).not.toContain("maintDiscardArm");
    expect(mainSrc).toContain('flash("Discarded", UNDO_TOAST_MS, { label: "Undo", act: "maintRestore", arg })');
    expect(mainSrc).toMatch(/case "maintRestore": \{[\s\S]*?restoreTriage\(id\)/);
  });

  it("the badge drops with the card, not when the refetch lands", () => {
    const row = (id: number) => ({ id, raw: "{}", reason: "r", source_author: null, resolved: 0, created_at: "2026-10-18T00:00:00Z", resolved_at: null, resolved_by: null, resolution: null, assigned_ref: null }) as NeedsTriageRow;
    const s = { ...initialState(), needsTriage: { status: "ok" as const, data: [row(1), row(2)] } };
    expect(triageCounts(s).unplaced).toBe(2);
    expect(triageCounts({ ...s, unplacedLeaving: { "1": { verdict: "discarded", gone: false } } }).unplaced).toBe(1);
    // …and so does the count on Review's switch, which is the same number.
    const html = render({ ...s, view: "app", screen: "review", reviewView: "unplaced", unplacedLeaving: { "1": { verdict: "discarded", gone: false } } });
    const head = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(head).toContain('>Unplaced<span class="cnpy-seg-n">1</span>');
  });
});

describe("Unplaced — the screen", () => {
  const me = { handle: "andres", name: null, avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "admin" as const }], superadmin: false, pending_invites: 0 };
  const row: NeedsTriageRow = { id: 4, raw: JSON.stringify({ slug: "deploy", section: "reference", title: "Deploy", body: "b", change_summary: "s", confidence: "low" }), reason: "low confidence doc proposal", source_author: "maya-k", resolved: 0, created_at: "2026-10-18T00:00:00Z", resolved_at: null, resolved_by: null, resolution: null, assigned_ref: null };

  it("is patched in place (data-morph), so a card can leave with its animation", () => {
    const html = render({ ...initialState(), view: "app", screen: "review", reviewView: "unplaced", orgSlug: "saplinglearn", me, needsTriage: { status: "ok", data: [row] } });
    expect(html).toContain('<main data-morph="review"');
    expect(html).toContain('data-morph-key="up:4"');
  });

  it("is ONE screen with To review: the same page key, the header patched, only the two columns (keyed by view) replaced", () => {
    const base = { ...initialState(), view: "app" as const, screen: "review" as const, orgSlug: "saplinglearn", me, needsTriage: { status: "ok" as const, data: [row] }, proposals: { status: "ok" as const, data: [] }, draftAdrs: { status: "ok" as const, data: [] } };
    const queue = render({ ...base, reviewView: "queue" });
    const un = render({ ...base, reviewView: "unplaced" });
    for (const h of [queue, un]) {
      expect(h).toContain('<main data-morph="review"');
      expect(h).toContain('data-screen="review"');
      expect(h).toContain('data-seg="triage-view"');
    }
    expect(queue).toContain('class="cnpy-rv-list" data-morph-key="rv-list:queue"');
    expect(queue).toContain('class="cnpy-scroll cnpy-rv-detail" data-morph-key="rv-detail:queue"');
    expect(un).toContain('class="cnpy-rv-list" data-morph-key="rv-list:unplaced"');
    expect(un).toContain('class="cnpy-scroll cnpy-rv-detail" data-morph-key="rv-detail:unplaced"');
    // The switch picks the view in place; the picked side carries no act, the other `setReviewView`.
    const head = (h: string) => h.slice(h.indexOf("<header"), h.indexOf("</header>"));
    expect(head(queue)).toContain('data-act="setReviewView" data-arg="unplaced"');
    expect(head(un)).toContain('data-act="setReviewView" data-arg="queue"');
    // main.ts: the view is state, written to the route; a switch flashes the new columns in (never an entrance), and
    // Review reads both queues so the switch has nothing to load.
    expect(mainSrc).toContain('case "setReviewView": if (arg === "queue" || arg === "unplaced") showReview(arg); return;');
    expect(mainSrc).toMatch(/function showReview\(view: ReviewView\): void \{\s*if \(state\.screen === "review" && state\.reviewView !== view\) pendingFlash = REVIEW_VIEW_FLASH;/);
    expect(mainSrc).toContain('case "review": loadProposalsIfNeeded(); loadDraftAdrsIfNeeded(); loadNeedsTriageIfNeeded(); break;');
    expect(mainSrc).toContain('if (state.screen === "review" && state.reviewView === "unplaced") r.reviewView = "unplaced";');
    expect(mainSrc).not.toMatch(/screen === "maintenance"/);
    // The one-shot flash is off under reduced motion.
    expect(css).toContain("[data-enter] *, .cnpy-flash, .cnpy-flash *, .repo-pulse");
  });

  it("wears To review's colours: the pane on --bg, the item and Place it as in white surface cards, Review's list head", () => {
    const html = maintenanceView(props());
    // The reading pane: Review's page pane on the page's own background, footer included (light and dark: tokens).
    expect(css).toContain(".cnpy-rvp--bg, .cnpy-rvp--bg > .cnpy-rvp-foot { background:var(--bg); }");
    // The item, as To review's proposed record: a label row, then a white surface card.
    expect(html).toMatch(/What the agent sent<\/div>\s*<\/div>\s*<div class="cnpy-surface cnpy-up-item" style="padding:24px 28px 26px">/);
    expect(html).toMatch(/Place it as<\/div>\s*<\/div><div class="cnpy-surface cnpy-up-place" style="padding:24px 28px 26px" data-item="u1">/);
    // Nothing of its own paints a surface: the old divider-and-white-pane look is gone.
    expect(css).not.toMatch(/\.cnpy-up-place \{[^}]*border-top/);
    // The list head is Review's (`reviewFrame`): the same padding, the intro, then 12px to the first card.
    expect(html).toContain('<div class="cnpy-rv-lhead" style="padding:16px 20px 0">');
    expect(reviewView({ items: [], filter: "all", selectedId: null, diffView: "unified" })).toContain('<div class="cnpy-rv-lhead" style="padding:16px 20px 0">');
  });

  it("the skeleton is the frame with both panes loading; the empty queue its words and the cards drawn empty", () => {
    const sk = maintenanceSkeleton();
    expect(sk).toContain('data-skel="unplaced"');
    expect(sk).toContain('data-skel="unplaced-detail"');
    expect(sk).not.toContain("Nothing unplaced");
    const empty = maintenanceView(props({ unplaced: [] }));
    expect(empty).toContain("Nothing unplaced");
    expect(empty).toContain(UNPLACED_EMPTY.replaceAll("'", "&#39;"));
    expect(empty).toContain('class="cnpy-empty-shapes"');
  });

  it("the read is mapped once: what it is, its text, what was sent, why — in words", () => {
    const u = unplacedFromRow(row);
    expect(u).toMatchObject({ kind: "doc", lowConfidence: true, reason: "Low confidence", section: "reference", space: null, body: "b" });
    expect(unplacedFromRow({ ...row, raw: "a free note" })).toMatchObject({ kind: "note", body: "a free note" });
    expect(unplacedFromRow({ ...row, raw: JSON.stringify({ title: "T", context: "c", decision: "d", rationale: "r", confidence: "high" }) }).adr).toEqual([{ h: "Context", p: "c" }, { h: "Decision", p: "d" }, { h: "Rationale", p: "r" }]);
    expect(unplacedReasonWord("unknown space: nope")).toBe("No such space");
    expect(unplacedReasonWord("archived page: parked")).toBe("Archived page");
    expect(unplacedReasonWord("not sure where this goes")).toBe("Agent wasn't sure");
  });
});
