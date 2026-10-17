/**
 * Phase C's three screens — the ticket detail, Unplaced and Review — with Trov's suggestions on them
 * (`ticket.category` / `ticket.priority` / `ticket.duplicate`, `unplaced.destination`, `review.risk`).
 *
 * FIELD ABSENT renders exactly what it rendered before: the snapshots under "field absent" were written by
 * THIS file against `ai/screens` at 15b639ef (before any of these screens drew a suggestion), at a fixed
 * clock — so a change to these screens' field-absent markup fails here. Re-pinned after #186 (main 2b7d0183) was
 * merged in: its app shell adds one empty whitespace line, nothing else.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const mdMock = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${mdMock(body)}</div>`,
  renderMarkdownInline: (text: string) => mdMock(text),
}));
import { render, initialState, type AppState } from "../web/src/render";
import type { TicketDetail } from "@shared/tickets";
import type { AdrRow, NeedsTriageRow } from "@shared/rows";
import type { StagedProposal } from "../web/src/api";
import { reviewRiskFixture, ticketSuggestionsFixture, unplacedSuggestionFixture } from "@shared/ai-fixtures";
import { AI_EXIT_MS, aiSuggestionKey, initialAiUi } from "../web/src/ai-ui";
import css from "../web/src/trov.css?raw";
import mainSrc from "../web/src/main.ts?raw";
import { loadWebChunks } from "./helpers/web-chunks";

// The lazy screens (web-ui.md › The app's bundles) render themselves, not their skeletons.
loadWebChunks();

const NOW = new Date("2026-10-15T12:00:00.000Z");
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });

const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();
const H = 3_600_000;
const ME = { handle: "alice", name: "Alice", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "admin" as const }], superadmin: false, pending_invites: 0 };

export function app(o: Partial<AppState>): AppState {
  return {
    ...initialState(), view: "app", me: ME, orgSlug: "saplinglearn",
    persons: { status: "ok", data: [{ handle: "alice", name: "Alice", color: "moss", avatar_url: null, role: null }, { handle: "andres", name: "Andres", color: "sky", avatar_url: null, role: null }] },
    ...o,
  };
}

export const ticketDetail = (o: Partial<TicketDetail> = {}): TicketDetail => ({
  id: 14, title: "Login page shows a blank screen on Safari", body: "Since this morning the login page is blank on Safari 18. Chrome works.",
  category: "other", priority: "normal", status: "submitted", requester: "alice", parent_id: null, sprint_id: null,
  created_at: iso(2 * H), updated_at: iso(H), source: "canopy", source_ref: null, source_author: null, source_updated_at: null, board_rank: null,
  assignees: [], links: [], comments: [], events: [{ id: 1, ticket_id: 14, actor: "alice", from_status: null, to_status: "submitted", created_at: iso(2 * H) }],
  parent: null, children: [], sprint: null,
  ...o,
});

export const triageRow = (o: Partial<NeedsTriageRow> = {}): NeedsTriageRow => ({
  id: 7, raw: JSON.stringify({ slug: "deploy-checklist", section: "runbooks", title: "Deploy checklist", body: "Before a deploy, run the migrations, then check the health endpoint.", change_summary: "New checklist", confidence: "high" }),
  reason: "section 'runbooks' is not in the vocabulary", source_author: "andres", resolved: 0, created_at: iso(3 * H),
  resolved_at: null, resolved_by: null, resolution: null, assigned_ref: null,
  ...o,
});

export const proposal = (o: Partial<StagedProposal> = {}): StagedProposal => ({
  slug: "auth-flow", version: 3, title: "Auth flow", section: "reference", space: "technical", summary: "Sessions now last 30 days",
  author: "andres", confidence: "high", status: "staged", change_kind: "edit", low_confidence: 0, base_version: 2, current_version: 2,
  created_at: iso(4 * H), stagedBody: "# Auth flow\n\nA session lasts 30 days.\n", promotedBody: "# Auth flow\n\nA session lasts 7 days.\n", parent_slug: null, import_id: null, import_path: null, import_file_name: null, import_by: null, import_at: null, 
  ...o,
});

export const adr = (o: Partial<AdrRow> = {}): AdrRow => ({
  id: 5, title: "Use D1 for the search index", context: "Search needs an index.", decision: "Use D1's FTS5.", rationale: "One store.",
  status: "draft", confidence: "high", created_at: iso(5 * H), created_by: "andres", content_hash: null,
  ...o,
});

describe("field absent — each screen renders exactly what it did before Phase C", () => {
  it("ticket detail (no `ai`)", () => {
    expect(render(app({ screen: "ticketdetail", ticketId: 14, ticketDetail: { status: "ok", data: ticketDetail() } }))).toMatchSnapshot();
  });
  it("Unplaced (no row carries `ai`)", () => {
    expect(render(app({ screen: "maintenance", needsTriage: { status: "ok", data: [triageRow(), triageRow({ id: 8, raw: "a free-form note", reason: "Flagged by an agent" })] } }))).toMatchSnapshot();
  });
  it("Review (no row carries `ai`)", () => {
    expect(render(app({ screen: "review", proposals: { status: "ok", data: [proposal()] }, draftAdrs: { status: "ok", data: [adr()] } }))).toMatchSnapshot();
  });
});

// ── field present ────────────────────────────────────────────────────────────
const MODE = "ready" as const;
const tSugg = ticketSuggestionsFixture(MODE, 14, { number: 9, title: "Blank login on Safari" });

/** Every <button>…</button> span in `html`, and whether any holds another <button. */
function nestedButtons(html: string): boolean {
  let depth = 0;
  for (const m of html.matchAll(/<\/?button\b/g)) {
    if (m[0] === "<button") { if (depth > 0) return true; depth++; } else depth = Math.max(0, depth - 1);
  }
  return false;
}

describe("field present — Trov's suggestions on the three screens", () => {
  it("ticket detail: category and priority chips under Properties, a possible duplicate above Linked work; Accept / Dismiss on each", () => {
    const html = render(app({ screen: "ticketdetail", ticketId: 14, ticketDetail: { status: "ok", data: ticketDetail({ ai: tSugg }) } }));
    expect(html).toContain("bug category");
    expect(html).toContain("high priority");
    expect(html).toContain("possible duplicate of #9 Blank login on Safari");
    expect(html.match(/data-act="aiAccept"/g)).toHaveLength(3);
    expect(html.match(/data-act="aiDismiss"/g)).toHaveLength(3);
    // The reason is one tap away, hidden until opened; the duplicate cites the ticket in-app.
    expect(html).toContain("because it says “…the login page is blank on Safari…”");
    expect(html).toContain('href="#tickets/9"');
    expect(html.indexOf("cnpy-ai-td-dup")).toBeLessThan(html.indexOf("cnpy-ai-td-fields")); // left column first
    expect(nestedButtons(html)).toBe(false);
    // The values a person set are still drawn as they were: the chip is beside them, never in place of them.
    expect(html).toContain(">other</div>");
  });

  it("Unplaced: a chip above “File it as” on the item, and a mark (no button) on its row", () => {
    const s = unplacedSuggestionFixture(MODE, 7)!;
    const html = render(app({ screen: "maintenance", needsTriage: { status: "ok", data: [triageRow({ ai: [s] }), triageRow({ id: 8, raw: "a free-form note", reason: "Flagged by an agent" })] } }));
    expect(html).toContain("file it as a doc in reference");
    expect(html.indexOf("cnpy-ai-unplaced")).toBeLessThan(html.indexOf("File it as"));
    expect(html.match(/cnpy-ai-row-mark/g)).toHaveLength(1);
    // e2e EV-UP-chip-P (Phase H): at 360px the row's one-line byline cut the mark's words off mid-quote, no ellipsis.
    // The mark may shrink, and its words end in an ellipsis.
    const mark = html.slice(html.indexOf('class="cnpy-ai-row-mark"'));
    expect(mark).toMatch(/^class="cnpy-ai-row-mark"[^>]*style="[^"]*flex:0 1 auto;min-width:0/);
    expect(mark).toMatch(/<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">[^<]+<\/span><\/span>/);
    expect(html.match(/data-act="aiAccept"/g)).toHaveLength(1);
    expect(nestedButtons(html)).toBe(false);
  });

  it("Review: the risk as a quiet line in the detail (the reason and Dismiss) — not on the list card (RV-OWNER-2); never an Accept, Promote or Reject of its own", () => {
    const risk = reviewRiskFixture(MODE, "doc:auth-flow@3", 0)!;
    const html = render(app({ screen: "review", proposals: { status: "ok", data: [proposal({ ai: [risk] })] }, draftAdrs: { status: "ok", data: [adr()] } }));
    expect(html).not.toContain('class="cnpy-ai-risk"'); // not on the list card (RV-OWNER-2)
    expect(html).toContain("cnpy-ai-risk-line");
    expect(html).toContain("Changes a decision");
    expect(html).not.toContain('data-act="aiAccept"');
    expect(html.match(/data-act="aiDismiss"/g)).toHaveLength(1);
    // Review's own verdict buttons are the only Promote / Reject, exactly as before.
    expect(html.match(/data-act="reviewAccept"/g)).toHaveLength(1);
    expect(html.match(/data-act="reviewReject"/g)).toHaveLength(1);
    expect(nestedButtons(html)).toBe(false);
  });

  it("a decided (not open) suggestion draws nothing", () => {
    const decided = tSugg.map((s) => ({ ...s, state: "accepted" as const }));
    const html = render(app({ screen: "ticketdetail", ticketId: 14, ticketDetail: { status: "ok", data: ticketDetail({ ai: decided }) } }));
    expect(html).not.toContain("cnpy-ai-chip");
  });
});

// ── motion (web-ui.md › The AI kit; › A row leaving a list; RULES §8) ─────────────────────────────
// Phase C's chips use the AI kit's ONE exit (ai-ui.ts › Leaving: `AiUi.leaving`, `.cnpy-ai-leave`, `AI_EXIT_MS`,
// `aiLeaving`) — the same as "Wrong?", the Feed's note and the themes' chips (test/render.ai-motion.test.ts).
describe("motion — a suggestion enters with its screen and leaves by the AI kit's one exit", () => {
  const risk = () => reviewRiskFixture(MODE, "doc:auth-flow@3", 0)!;
  const unplaced = () => unplacedSuggestionFixture(MODE, 7)!;
  const at = (o: Record<number, number>) => ({ ...initialAiUi(), leaving: Object.entries(o).map(([id, t]) => ({ key: aiSuggestionKey(Number(id)), at: t })) });
  const screens = (leaving: Record<number, number> = {}) => ({
    ticket: render(app({ screen: "ticketdetail", ticketId: 14, ticketDetail: { status: "ok", data: ticketDetail({ ai: tSugg }) }, ai: at(leaving) })),
    unplaced: render(app({ screen: "maintenance", needsTriage: { status: "ok", data: [triageRow({ ai: [unplaced()] })] }, ai: at(leaving) })),
    review: render(app({ screen: "review", proposals: { status: "ok", data: [proposal({ ai: [risk()] })] }, draftAdrs: { status: "ok", data: [] }, ai: at(leaving) })),
  });

  it("every chip and the risk line rise with the screen (`.cnpy-rise`; nothing replays on a rerender); nothing leaving, no exit drawn", () => {
    const { ticket, unplaced: u, review } = screens();
    const box = /<div class="cnpy-rise[^"]*" style="--i:\d;[^"]*"><div class="cnpy-ai-(chip|risk-line)"/g;
    expect(ticket.match(box)).toHaveLength(3);
    expect(u.match(box)).toHaveLength(1);
    expect(review.match(box)).toHaveLength(1);
    for (const h of [ticket, u, review]) expect(h).not.toContain("cnpy-ai-leave");
  });

  it("a decided suggestion is drawn leaving in `.cnpy-ai-leave`, its elapsed time a negative delay; the others are untouched", () => {
    const cat = tSugg.find((x) => x.kind === "ticket.category")!;
    const { ticket, unplaced: u, review } = screens({ [cat.id]: NOW.getTime() - 120, [unplaced().id]: NOW.getTime(), [risk().id]: NOW.getTime() - 40 });
    expect(ticket.match(/class="cnpy-ai-leave"/g)).toHaveLength(1);
    expect(ticket).toMatch(/<div class="cnpy-ai-leave" data-ai-leaving inert style="--leave-t:-120ms"><div class="cnpy-ai-leave-in"><div class="cnpy-rise"[^>]*><div class="cnpy-ai-chip" data-ai-chip="ticket\.category-/);
    expect(u).toMatch(/<div class="cnpy-ai-leave" data-ai-leaving inert style="--leave-t:-0ms"><div class="cnpy-ai-leave-in"><div class="cnpy-rise cnpy-ai-unplaced"/);
    // The list row's mark leaves with it, inline.
    expect(u).toMatch(/<span class="cnpy-ai-leave" data-inline data-ai-leaving inert style="--leave-t:-0ms"><span class="cnpy-ai-leave-in"><span class="cnpy-ai-row-mark"/);
    expect(review).toMatch(/<div class="cnpy-ai-leave" data-ai-leaving inert style="--leave-t:-40ms"><div class="cnpy-ai-leave-in"><div class="cnpy-rise"[^>]*><div class="cnpy-ai-risk-line"/);
  });

  it("past the exit a suggestion stays collapsed (held at AI_EXIT_MS) until its screen's re-read drops it", () => {
    const cat = tSugg.find((x) => x.kind === "ticket.category")!;
    const { ticket } = screens({ [cat.id]: NOW.getTime() - 5_000 });
    expect(ticket).toContain(`style="--leave-t:-${AI_EXIT_MS}ms"><div class="cnpy-ai-leave-in">`);
  });

  it("ONE exit in the kit: no second class, constant or state for chips; the re-read comes after the exit", () => {
    expect(css).not.toContain("cnpy-ai-out");
    expect(css).toContain(".cnpy-ai-leave[data-inline], [data-enter] .cnpy-ai-leave[data-inline] { display:inline-grid; vertical-align:middle; }");
    expect(Object.keys(initialState())).not.toContain("aiLeaving");
    // main.ts's `decided` re-reads at once: the controller calls it only once the last exit is over.
    const hook = mainSrc.slice(mainSrc.indexOf("decided: () =>"), mainSrc.indexOf("const aiFilterCtl"));
    expect(hook).toContain("loadTicketDetail(state.ticketId)");
    expect(hook).not.toContain("setTimeout");
  });
});
