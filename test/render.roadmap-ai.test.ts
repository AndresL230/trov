/**
 * The Roadmap's AI pieces (web/src/roadmap-ai.ts, Phase D): the forecast line, a sprint's note, the drift line and
 * an admin's suggestion cards — and that each renders NOTHING when its field is absent (the full field-absent
 * render is pinned in render.ai-absent.test.ts). Pure render, no DOM.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`,
  renderMarkdownInline: (text: string) => text,
}));
import { render, initialState, type AppState } from "../web/src/render";
import { forecastLine, forecastWords, sprintNoteBlock, driftLine, roadmapSuggestionCards } from "../web/src/roadmap-ai";
import { sprintCard } from "../web/src/sprints";
import { AI_EXIT_MS, aiSuggestionKey, initialAiUi } from "../web/src/ai-ui";
import { REVIEW_EXIT_MS } from "../web/src/review";
import { aiItemRef } from "@shared/ai-core";
import css from "../web/src/trov.css?raw";
import { roadmapFixture } from "@shared/ai-fixtures";
import type { PlanView, SprintView } from "../web/src/api";

const NOW = new Date("2026-10-14T12:00:00.000Z");
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });

const ME = { handle: "alice", name: "Alice", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "admin" as const }], superadmin: false, pending_invites: 0 };
const sprint = (o: Partial<SprintView> = {}): SprintView => ({
  id: 1, label: "Hosting screens", summary: null, description: null, phase: null, dates: null, start: "2026-10-01", due: "2026-10-20",
  status: "in_progress", active: true, urgency: "normal", lead: null, domain: null, github_ref: null, created_at: "2026-09-30T10:00:00Z",
  created_by: "alice", updated_at: null, progress: { closed: 2, total: 5, pct: 40 }, issues: null, members: [], ...o,
});
const fx = roadmapFixture("ready", NOW)!;
const app = (plan: PlanView): AppState => ({
  ...initialState(), view: "app", me: ME, orgSlug: "saplinglearn", screen: "roadmap", roadmapTab: "narrative",
  roadmap: { status: "ok", data: plan }, roadmapFeed: { status: "ok", data: [] },
});

describe("the forecast line — the server's arithmetic, in words; no AI mark", () => {
  it("late, early, on the day, no due day", () => {
    expect(forecastWords({ remaining: 3, perDay: 0.2, projected: "2026-11-02", daysLate: 3 })).toEqual({ lead: "At this pace, done Nov 2", delta: "3 days late", late: true });
    expect(forecastWords({ remaining: 1, perDay: 1, projected: "2026-10-18", daysLate: -2 }).delta).toBe("2 days early");
    expect(forecastWords({ remaining: 1, perDay: 1, projected: "2026-10-20", daysLate: 0 }).delta).toBe("on the due day");
    expect(forecastWords({ remaining: 1, perDay: 1, projected: "2026-10-20", daysLate: null }).delta).toBeNull();
    const html = forecastLine({ remaining: 3, perDay: 0.2, projected: "2026-11-02", daysLate: 1 });
    expect(html).toContain("At this pace, done Nov 2");
    expect(html).toContain("1 day late");
    expect(html).not.toContain("cnpy-ai-by");
  });
  it("absent or null → nothing", () => {
    expect(forecastLine(undefined)).toBe("");
    expect(forecastLine(null)).toBe("");
  });
});

describe("a sprint's note", () => {
  it("Trov's line, its cites, the byline and 'Wrong?' — hidden for the person who pressed it", () => {
    const note = fx.notes[0];
    const html = sprintNoteBlock(sprint(), note, initialAiUi());
    expect(html).toContain(note.text);
    expect(html).toContain("Written by Trov");
    expect(html).toContain('href="#tickets/21"');
    expect(html).toContain("aiWrong");
    expect(html).toContain('&quot;itemType&quot;:&quot;sprint_note&quot;');
    const hidden = { ...initialAiUi(), hidden: [`sprint_note:1@${note.generatedAt}`] };
    expect(sprintNoteBlock(sprint(), note, hidden)).toBe("");
    expect(sprintNoteBlock(sprint(), undefined, initialAiUi())).toBe("");
  });
  it("at the month's cap (the read rule, Q19): the LAST note and drift with the AI kit's capped line — and none without it", () => {
    const capped = { state: "capped" as const, resumesOn: "2026-11-01", upgrade: true };
    const note = sprintNoteBlock(sprint(), { ...fx.notes[0], ...capped }, initialAiUi());
    expect(note).toContain(fx.notes[0].text);
    expect(note).toContain("Monthly AI allowance used; notes resume Nov 1.");
    expect(note).toContain("Upgrade to Pro");
    expect(driftLine({ ...fx.drift, ...capped, upgrade: false }, initialAiUi())).toContain("Monthly AI allowance used; notes resume Nov 1.");
    expect(sprintNoteBlock(sprint(), fx.notes[0], initialAiUi())).not.toContain("cnpy-ai-capped");
  });
  it("on the card: the forecast and the note on an active sprint; a done card shows neither", () => {
    const sp = sprint({ forecast: { remaining: 3, perDay: 0.2, projected: "2026-11-02", daysLate: 13 }, note: fx.notes[0] });
    const html = sprintCard(sp, [], { now: NOW.getTime() });
    expect(html).toContain("At this pace, done Nov 2");
    expect(html).toContain(fx.notes[0].text);
    const done = sprintCard({ ...sp, status: "done", active: false }, [], { now: NOW.getTime() });
    expect(done).not.toContain("At this pace");
    expect(done).not.toContain(fx.notes[0].text);
  });
});

describe("the drift line and the suggestion cards on the Roadmap", () => {
  it("drift: the sentence, the server's shares, the byline from its window, 'Wrong?'", () => {
    const html = driftLine(fx.drift, initialAiUi());
    expect(html).toContain("The last two weeks went mostly to Billing and plans, which isn&#39;t in any sprint.");
    expect(html).toContain("Billing and plans 46%");
    expect(html).toContain("(in no sprint)");
    expect(html).toContain("from the last 14 days");
    expect(driftLine(fx.drift, { ...initialAiUi(), hidden: [`plan_drift:${fx.drift.generatedAt}`] })).toBe("");
    expect(driftLine(undefined, initialAiUi())).toBe("");
  });
  it("suggestion cards: the kit's box with what it proposes inside it, and an Accept that says what it does", () => {
    const html = roadmapSuggestionCards(fx.suggestions, initialAiUi());
    expect(html).toContain('<span class="cnpy-ai-chip-label">3 sprints from 10 backlog tickets</span>');
    expect(html).toMatch(/cnpy-ai-accept"[^>]*>Create 3 sprints<\/button>/);
    expect(html).toMatch(/cnpy-ai-accept"[^>]*>Use this narrative<\/button>/);
    // the drafted sprints sit INSIDE the box, never loose under it
    const first = html.slice(html.indexOf('class="cnpy-ai-chip has-body"'), html.indexOf('data-suggestion="', html.indexOf('data-suggestion="') + 20));
    expect(first).toContain('class="cnpy-ai-chip-body"');
    expect(first).toContain("Hosting polish");
    expect(html).toContain("Hosting polish");
    expect(html).toContain('href="#tickets/27"');
    expect(html).toContain("a new plan narrative");
    expect(html).toContain("mock-live-md");
    expect(html.match(/data-act="aiAccept"/g)).toHaveLength(2);
    expect(roadmapSuggestionCards(undefined, initialAiUi())).toBe("");
    expect(roadmapSuggestionCards([{ ...fx.suggestions[0], value: { nope: 1 } }], initialAiUi())).toBe("");
  });
  it("the whole screen with every field present: a Trov button on the narrative card opens the suggestions and the drift; notes stay on their cards", () => {
    const plan: PlanView = { narrative: "Now: hosting.", version: 1, updated_at: null, updated_by: null,
      sprints: [sprint({ note: fx.notes[0] })], drift: fx.drift, suggestions: fx.suggestions };
    const html = render(app(plan));
    // Not in the page's flow (the owner's call): the button sits in the narrative card's head, with its count and dot.
    expect(html).not.toContain("rm-suggestions");
    expect(html).not.toContain('class="rm-drift"');
    const head = html.slice(html.indexOf("What's happening"), html.indexOf('class="cnpy-md"'));
    expect(head).toMatch(/data-act="rmTrov"[^>]*class="rm-trov-btn"/);
    expect(head).toContain(`<span class="rm-trov-n">${fx.suggestions.length + 1}</span>`);
    expect(head).toContain('class="rm-trov-dot"');
    expect(html).toContain("rm-note");
    // Pressed: a dialog holding both suggestions and the drift, then Done.
    const open = render({ ...app(plan), rmTrovOpen: true });
    const dlg = open.slice(open.indexOf('id="rm-trov"'));
    expect(dlg).toContain("rm-suggestions");
    expect(dlg).toContain('class="rm-drift"');
    expect(dlg.match(/data-act="aiAccept"/g)?.length).toBe(fx.suggestions.length);
    expect(dlg).toContain('data-confirm-cancel="rmTrov"');
    // Nothing to show: no button, no dialog.
    const bare: PlanView = { ...plan, drift: undefined, suggestions: undefined };
    expect(render({ ...app(bare), rmTrovOpen: true })).not.toMatch(/rm-trov-btn|id="rm-trov"/);
  });
});

// RULES §8 (the owner's ruling): Trov's Roadmap pieces move with the app's own motion — entrances with the screen's,
// and a card that goes leaves by the AI kit's ONE exit (ai-ui.ts › Leaving; web-ui.md › The AI kit), never a new one.
describe("motion — the app's entrance and the AI kit's one exit, nothing new", () => {
  it("the Narrative tab is patched in place (data-morph) — the Timeline is rebuilt as before", () => {
    const plan: PlanView = { narrative: "x", version: 1, updated_at: null, updated_by: null, sprints: [sprint()], suggestions: fx.suggestions };
    expect(render(app(plan))).toContain('<main data-morph="roadmap:narrative"');
    expect(render({ ...app(plan), roadmapTab: "timeline" })).not.toContain("data-morph=\"roadmap");
  });

  it("the cards are a keyed list that rises with the entrance; nothing leaving draws no exit", () => {
    const cards = roadmapSuggestionCards(fx.suggestions, initialAiUi());
    expect(cards).toMatch(/^<section class="rm-suggestions cnpy-stagger"[^>]*data-morph-list/);
    for (const s of fx.suggestions) expect(cards).toContain(`<div class="rm-suggestion-row" data-morph-key="s:${s.id}"><div style="padding-bottom:16px">`);
    expect(cards).not.toMatch(/<\/div>\s+<div class="rm-suggestion-row/); // children joined with nothing between (morphList)
    expect(cards).not.toContain("cnpy-ai-leave");
    expect(driftLine(fx.drift, initialAiUi())).toMatch(/^<div class="rm-drift-row"><div style="padding-top:14px">/);
    expect(sprintNoteBlock(sprint(), fx.notes[0], initialAiUi())).toMatch(/^<div class="rm-note-row"><div style="padding-top:10px">/);
  });

  it("a card an Accept / Dismiss took collapses in `.cnpy-ai-leave` (its key stays on the row) and stays collapsed; the others stay", () => {
    const [a, b] = fx.suggestions;
    const at = Date.now();
    const html = roadmapSuggestionCards(fx.suggestions, { ...initialAiUi(), leaving: [{ key: aiSuggestionKey(a.id), at: at - 50 }] });
    expect(html).toContain(`data-morph-key="s:${a.id}"><div class="cnpy-ai-leave" data-ai-leaving inert style="--leave-t:-50ms">`);
    expect(html).toContain(`data-morph-key="s:${b.id}"><div style=`);
    const held = roadmapSuggestionCards(fx.suggestions, { ...initialAiUi(), leaving: [{ key: aiSuggestionKey(a.id), at: at - 5_000 }] });
    expect(held).toContain(`data-morph-key="s:${a.id}"><div class="cnpy-ai-leave" data-ai-leaving inert style="--leave-t:-${AI_EXIT_MS}ms">`);
  });

  it("'Wrong?' on a note or the drift: collapsing while leaving, then not drawn", () => {
    const noteKey = `sprint_note:${aiItemRef.sprintNote(1, fx.notes[0].generatedAt)}`;
    const driftKey = `plan_drift:${aiItemRef.planDrift(fx.drift.generatedAt)}`;
    const at = Date.now();
    const ui = { ...initialAiUi(), hidden: [noteKey, driftKey], leaving: [{ key: noteKey, at }, { key: driftKey, at }] };
    expect(sprintNoteBlock(sprint(), fx.notes[0], ui)).toMatch(/^<div class="rm-note-row"><div class="cnpy-ai-leave" data-ai-leaving inert/);
    expect(driftLine(fx.drift, ui)).toContain('<div class="cnpy-ai-leave" data-ai-leaving inert');
    const after = { ...ui, leaving: [] };
    expect(sprintNoteBlock(sprint(), fx.notes[0], after)).toBe("");
    expect(driftLine(fx.drift, after)).toBe("");
  });

  it("the exit keeps Review's clock, and the kit's CSS is still under reduced motion", () => {
    expect(AI_EXIT_MS).toBe(REVIEW_EXIT_MS);
    expect(css).toContain("@media (prefers-reduced-motion: reduce) { .cnpy-ai-leave { animation:none !important; display:none; } }");
    expect(css).toMatch(/\[data-enter\] \.cnpy-rise \{/);
    expect(css).toMatch(/\[data-enter\] \.cnpy-stagger > \* \{/);
  });
});
