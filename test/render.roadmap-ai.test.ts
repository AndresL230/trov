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
import { initialAiUi } from "../web/src/ai-ui";
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
  it("suggestion cards: the kit's chip over what it proposes — the drafted sprints and their tickets, the proposed narrative", () => {
    const html = roadmapSuggestionCards(fx.suggestions, initialAiUi());
    expect(html).toContain("Suggested: <span style=\"color:var(--fg-70);font-weight:500\">3 sprints from 10 backlog tickets</span>");
    expect(html).toContain("Hosting polish");
    expect(html).toContain('href="#tickets/27"');
    expect(html).toContain("a new plan narrative");
    expect(html).toContain("mock-live-md");
    expect(html.match(/data-act="aiAccept"/g)).toHaveLength(2);
    expect(roadmapSuggestionCards(undefined, initialAiUi())).toBe("");
    expect(roadmapSuggestionCards([{ ...fx.suggestions[0], value: { nope: 1 } }], initialAiUi())).toBe("");
  });
  it("the whole screen with every field present: cards above the narrative, the drift under it, notes on the active cards", () => {
    const plan: PlanView = { narrative: "Now: hosting.", version: 1, updated_at: null, updated_by: null,
      sprints: [sprint({ note: fx.notes[0] })], drift: fx.drift, suggestions: fx.suggestions };
    const html = render(app(plan));
    const at = (s: string) => html.indexOf(s);
    expect(at("rm-suggestions")).toBeGreaterThan(-1);
    expect(at("rm-suggestions")).toBeLessThan(at("What's happening"));
    expect(at("What's happening")).toBeLessThan(at("rm-drift"));
    expect(at("rm-drift")).toBeLessThan(at("rm-note"));
  });
});
