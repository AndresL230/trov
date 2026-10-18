/**
 * The Roadmap's exits, driven through the REAL controller (web/src/ai-actions.ts) — RULES §8 / web-ui.md › The AI
 * kit: the Roadmap uses the kit's ONE exit (ai-ui.ts › Leaving). An Accept / Dismiss on a Roadmap card is sent at
 * once and the card collapses (`.cnpy-ai-leave`, held collapsed until the re-read), the re-read waits until the LAST
 * exit is over (one read for several), a failed write puts the card back exactly; "Wrong?" on a note collapses it the
 * same way. Under reduced motion it goes at once and the re-read goes at once.
 * The Roadmap's dialog (2026-10-18): an ACCEPT there waits for the server, busy in place; then the dialog closes when
 * no other suggestion is left (else the card collapses out), the Roadmap is read again, and what it changed rises in
 * once the read lands (`state.rmRise`). A Dismiss that takes the last suggestion closes the dialog at once.
 * The API calls are stubbed (they are the network); everything else is the shipped code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** A pending call is answered with true (200), false (a bare 400 `invalid`), the error to reject with, or a 200's
 *  body (`{ body }`). */
type Answer = (ok: boolean | Error | { body: unknown }) => void;
const calls = vi.hoisted(() => ({ accept: [] as Array<Answer>, dismiss: [] as Array<Answer>, feedback: [] as Array<Answer> }));
vi.mock("../web/src/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../web/src/api")>();
  const pending = (list: Array<Answer>) => new Promise<unknown>((res, rej) => list.push((ok) => (ok === true ? res({}) : ok instanceof Error ? rej(ok) : ok === false ? rej(new real.ApiError(400, "invalid")) : res(ok.body))));
  return {
    ...real,
    acceptAiSuggestion: () => pending(calls.accept),
    dismissAiSuggestion: () => pending(calls.dismiss),
    sendAiFeedback: () => pending(calls.feedback),
  };
});
vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));

import { AI_OFF_REFUSAL, createAiController } from "../web/src/ai-actions";
import { OrgApiError } from "../web/src/api";
import { AI_EXIT_MS, aiSuggestionKey } from "../web/src/ai-ui";
import { initialState, type AppState } from "../web/src/render";
import { roadmapSuggestionCards } from "../web/src/roadmap-ai";
import { planNarrativeBlock } from "../web/src/render";
import { RM_RISE_MS } from "../web/src/sprints";
import type { SprintView } from "@shared/sprints";
import { roadmapFixture, themesFixture } from "@shared/ai-fixtures";
import { aiItemRef } from "@shared/ai-core";

const fx = roadmapFixture("ready", new Date("2026-10-14T12:00:00Z"))!;
const [A, B] = fx.suggestions;
const flush = () => new Promise<void>((r) => queueMicrotask(r)).then(() => Promise.resolve()).then(() => Promise.resolve());

function harness(screen: "roadmap" | "repo" = "roadmap") {
  const state: AppState = {
    ...initialState(), view: "app", screen, roadmapTab: "narrative",
    roadmap: { status: "ok", data: { narrative: "", version: 1, updated_at: null, updated_by: null, sprints: [], suggestions: fx.suggestions, drift: fx.drift } },
  };
  const log = { rerenders: 0, flashes: [] as string[], afterDecide: [] as Array<[number, string]>, closed: 0 };
  // The Roadmap's re-read, as main.ts's `decided` hands it back: `nextRead` (when set) is what the read brings.
  const read: { next: Partial<typeof state.roadmap.data> | null; land: (() => void) | null } = { next: null, land: null };
  const ctl = createAiController({
    state, mount: {} as HTMLElement, rerender: () => { log.rerenders++; }, flash: (m) => { log.flashes.push(m); }, unauth: () => {},
    decided: (id, how) => {
      log.afterDecide.push([id, how]);
      if (!read.next) return;
      const next = read.next;
      return new Promise<void>((res) => { read.land = () => { state.roadmap = { status: "ok", data: { ...state.roadmap.data, ...next } }; res(); }; });
    },
    closeRoadmapTrov: () => { log.closed++; state.rmTrovOpen = false; },
  });
  return { state, ctl, log, read, cards: () => roadmapSuggestionCards(state.roadmap.data.suggestions, state.ai) };
}

let reduced = false;
beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  calls.accept.length = 0; calls.dismiss.length = 0; calls.feedback.length = 0;
  vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const NOW = Date.parse("2026-10-14T12:00:00Z");
const leavingCard = (id: number) => new RegExp(`data-morph-key="s:${id}"><div class="cnpy-ai-leave" data-ai-leaving inert style="--leave-t:-\\d+ms">`);

describe("a Roadmap card leaves by the AI kit's one exit", () => {
  it("Accept: sent at once, the card STAYS, busy, until the server answers; then it collapses (another waits) and the re-read follows the exit", async () => {
    vi.setSystemTime(NOW);
    const h = harness();
    h.state.rmTrovOpen = true;
    h.ctl.act("aiAccept", String(A.id), null);
    expect(calls.accept).toHaveLength(1);
    expect(h.state.ai.leaving).toEqual([]);                 // never an empty card while the writers run
    expect(h.cards()).not.toMatch(leavingCard(A.id));
    expect(h.cards()).toContain("Creating 3 sprints…");     // the Accept says what it is doing
    expect(h.cards()).toMatch(/data-act="aiAccept" data-arg="9101" disabled aria-busy="true"/);
    h.ctl.act("aiAccept", String(A.id), null);  // a second click while the write is out does nothing
    expect(calls.accept).toHaveLength(1);
    vi.advanceTimersByTime(5_000);               // a draft's writers take seconds: still there, still busy
    expect(h.state.ai.leaving).toEqual([]);
    vi.setSystemTime(NOW + 5_000);
    calls.accept[0](true);
    await flush();
    expect(h.log.flashes).toEqual(["Accepted"]);
    expect(h.log.closed).toBe(0);                // B still waits in the dialog: it stays open
    expect(h.state.ai.leaving).toEqual([{ key: aiSuggestionKey(A.id), at: NOW + 5_000 }]);
    expect(h.cards()).toMatch(leavingCard(A.id));
    expect(h.log.afterDecide).toEqual([]);       // held: the card is still collapsing
    vi.advanceTimersByTime(AI_EXIT_MS);
    expect(h.cards()).toContain(`--leave-t:-${AI_EXIT_MS}ms`); // held collapsed until the read drops it
    expect(h.cards()).toContain(`data-morph-key="s:${B.id}"><div style=`);
    expect(h.log.afterDecide).toEqual([[A.id, "accept"]]);
  });

  it("Accept on the LAST suggestion: the dialog closes once the write lands, the Roadmap is read again, and the narrative rises in", async () => {
    vi.setSystemTime(NOW);
    const h = harness();
    h.state.roadmap.data.suggestions = [B];      // the narrative proposal alone
    h.state.rmTrovOpen = true;
    h.read.next = { narrative: "**Now:** Hosting.\n\n**Next:** Billing.\n\n**Later:** Docs.", suggestions: undefined };
    h.ctl.act("aiAccept", String(B.id), null);
    expect(h.cards()).toContain("Updating the narrative…");
    expect(h.log.closed).toBe(0);                // not before the server answered
    calls.accept[0](true);
    await flush();
    expect(h.log.closed).toBe(1);
    expect(h.state.rmTrovOpen).toBe(false);
    vi.advanceTimersByTime(AI_EXIT_MS);
    expect(h.log.afterDecide).toEqual([[B.id, "accept"]]);
    expect(h.state.rmRise).toBeNull();           // the read has not landed yet
    const before = h.log.rerenders;
    h.read.land!();
    await flush();
    expect(h.state.rmRise).toEqual({ at: NOW + AI_EXIT_MS, narrative: true, sprints: [] });
    expect(h.log.rerenders).toBeGreaterThan(before);
    // The card draws the new narrative as the box, rising in (the app's one-shot flash, at a negative delay).
    const html = planNarrativeBlock(h.state.roadmap.data.narrative, (b) => b, "", 0);
    expect(html).toMatch(/<dl class="rm-nnl cnpy-flash" style="animation-delay:-0ms">/);
    vi.advanceTimersByTime(RM_RISE_MS);
    expect(h.state.rmRise).toBeNull();           // one shot
    expect(planNarrativeBlock(h.state.roadmap.data.narrative, (b) => b, "", RM_RISE_MS)).not.toContain("cnpy-flash");
  });

  it("an accepted sprint draft: the sprint cards it created rise in — only those", async () => {
    vi.setSystemTime(NOW);
    const h = harness();
    const old = { id: 1, label: "Old" } as SprintView;
    h.state.roadmap.data.sprints = [old];
    h.state.roadmap.data.suggestions = [A];
    h.read.next = { sprints: [old, { id: 40, label: "Hosting" } as SprintView, { id: 41, label: "Billing" } as SprintView], suggestions: undefined };
    h.ctl.act("aiAccept", String(A.id), null);
    calls.accept[0](true);
    await flush();
    vi.advanceTimersByTime(AI_EXIT_MS);
    h.read.land!();
    await flush();
    expect(h.state.rmRise).toMatchObject({ narrative: false, sprints: [40, 41] });
  });

  it("Dismiss on the LAST suggestion closes the dialog at once (optimistic), and nothing rises", async () => {
    const h = harness();
    h.state.roadmap.data.suggestions = [B];
    h.state.rmTrovOpen = true;
    h.read.next = { suggestions: undefined };
    h.ctl.act("aiDismiss", String(B.id), null);
    expect(h.log.closed).toBe(1);
    expect(h.cards()).toMatch(leavingCard(B.id));
    calls.dismiss[0](true);
    await flush();
    vi.advanceTimersByTime(AI_EXIT_MS);
    h.read.land?.();
    await flush();
    expect(h.state.rmRise).toBeNull();
  });

  it("two cards in a row: ONE re-read, after the last exit", async () => {
    vi.setSystemTime(NOW);
    const h = harness();
    h.ctl.act("aiDismiss", String(A.id), null);
    vi.advanceTimersByTime(100);
    h.ctl.act("aiDismiss", String(B.id), null);
    calls.dismiss[0](true); calls.dismiss[1](true);
    await flush();
    vi.advanceTimersByTime(AI_EXIT_MS - 100);
    expect(h.log.afterDecide).toEqual([]);  // B still collapsing
    vi.advanceTimersByTime(100);
    expect(h.log.afterDecide).toHaveLength(1);
  });

  it("a failed write puts the card back exactly, with a toast", async () => {
    const h = harness();
    const before = h.cards();
    h.ctl.act("aiAccept", String(A.id), null);
    calls.accept[0](false);
    await flush();
    expect(h.state.ai.leaving).toEqual([]);
    expect(h.cards()).toBe(before);
    expect(h.log.flashes).toEqual(["Couldn't do that. Try again."]);
    vi.advanceTimersByTime(AI_EXIT_MS);
    expect(h.log.afterDecide).toEqual([]);
  });

  it("a 400 that carries the server's sentence says it as it is (Q21/Q40: a Roadmap writer; Q20: a theme name)", async () => {
    const h = harness();
    h.ctl.act("aiAccept", String(A.id), null);
    calls.accept[0](new OrgApiError(400, "invalid", "that sprint draft is not one Trov can create", null));
    await flush();
    expect(h.log.flashes).toEqual(["that sprint draft is not one Trov can create"]);
    expect(h.state.ai.leaving).toEqual([]); // back exactly, as any failure
    const r = harness("repo");
    r.state.ai.rename = { id: B.id, draft: "Billing" };
    r.ctl.act("aiRenameSave", null, null);
    calls.accept[1](new OrgApiError(400, "invalid", "A theme named Billing already exists.", null));
    await flush();
    expect(r.log.flashes).toEqual(["A theme named Billing already exists."]);
    expect(r.state.ai.rename).toEqual({ id: B.id, draft: "Billing" }); // the field stays open to change the name
    // A 409 with no sentence keeps its own words.
    const n = harness();
    n.ctl.act("aiDismiss", String(A.id), null);
    calls.dismiss[0](new OrgApiError(409, "not_open", null, null));
    await flush();
    expect(n.log.flashes).toEqual(["Someone already answered that suggestion."]);
    // A 403 `off` (the AI read rule: the switch off, or no key) says so — never "Couldn't do that".
    const o = harness();
    o.ctl.act("aiAccept", String(A.id), null);
    calls.accept[2](new OrgApiError(403, "off", null, null));
    await flush();
    expect(o.log.flashes).toEqual([AI_OFF_REFUSAL]);
    expect(AI_OFF_REFUSAL).toBe("Trov's AI is off for this organization, so nothing was changed. An admin can turn it on in Org settings › AI.");
  });

  it("reduced motion: gone at once (the exit's class is display:none there), and the re-read goes at once", async () => {
    reduced = true;
    const h = harness();
    h.ctl.act("aiDismiss", String(A.id), null);
    expect(h.cards()).toMatch(leavingCard(A.id));
    calls.dismiss[0](true);
    await flush();
    vi.advanceTimersByTime(0);
    expect(h.log.afterDecide).toEqual([[A.id, "dismiss"]]);
    // An Accept: the same result — the dialog closes, the read goes at once, the change is marked (CSS keeps it still).
    const a = harness();
    a.state.roadmap.data.suggestions = [B];
    a.state.rmTrovOpen = true;
    a.read.next = { narrative: "**Now:** a\n\n**Next:** b\n\n**Later:** c", suggestions: undefined };
    a.ctl.act("aiAccept", String(B.id), null);
    calls.accept[0](true);
    await flush();
    vi.advanceTimersByTime(0);
    expect([a.log.closed, a.log.afterDecide]).toEqual([1, [[B.id, "accept"]]]);
    a.read.land!();
    await flush();
    expect(a.state.rmRise).toMatchObject({ narrative: true });
  });

  it("off the Roadmap (a theme proposal on Repo) it is the SAME exit: one kit", async () => {
    vi.setSystemTime(NOW);
    const h = harness("repo");
    h.ctl.act("aiAccept", String(A.id), null);
    expect(h.state.ai.busy).toEqual([A.id]);
    expect(h.state.ai.leaving).toEqual([{ key: aiSuggestionKey(A.id), at: NOW }]);
  });
});

describe("LOCAL_AI_PREVIEW: a sample's decision is taken locally, with 'Not saved in preview' (Q5)", () => {
  const PREVIEW = { body: { ok: true, preview: true } };
  it("a Roadmap card leaves and STAYS gone (no re-read would bring the sample back), whatever exits follow", async () => {
    vi.setSystemTime(NOW);
    const h = harness();
    h.ctl.act("aiAccept", String(A.id), null);
    calls.accept[0](PREVIEW);
    await flush();
    expect(h.log.flashes).toEqual(["Not saved in preview"]);
    expect(h.state.ai.busy).toEqual([]);
    expect(h.state.ai.previewDecided).toEqual([A.id]);
    vi.advanceTimersByTime(20_000);
    expect(h.log.afterDecide).toEqual([]); // nothing was saved: nothing to re-read
    h.ctl.act("aiDismiss", String(B.id), null); // a later exit does not drop A's held one
    expect(h.state.ai.leaving.map((l) => l.key)).toEqual([aiSuggestionKey(A.id), aiSuggestionKey(B.id)]);
    expect(h.cards()).toMatch(leavingCard(A.id));
  });
  it("a proposed theme: Accept (renamed) makes the lane active under its name, Remove takes it off the chart", async () => {
    const now = new Date(NOW);
    const h = harness("repo");
    h.state.repo = { status: "ok", data: { themes: { "8w": themesFixture("proposed", "8w", now), quarter: themesFixture("proposed", "quarter", now) } } as never };
    const [l0, l1] = h.state.repo.data!.themes!["8w"]!.lanes;
    h.state.ai.rename = { id: l0.suggestionId!, draft: "Org work" };
    h.ctl.act("aiRenameSave", null, null);
    calls.accept[0](PREVIEW);
    await flush();
    h.ctl.act("aiDismiss", String(l1.suggestionId), null);
    calls.dismiss[0](PREVIEW);
    await flush();
    for (const range of ["8w", "quarter"] as const) {
      const lanes = h.state.repo.data!.themes![range]!.lanes;
      expect(lanes.find((l) => l.id === l0.id)).toMatchObject({ name: "Org work", status: "active", suggestionId: null });
      expect(lanes.find((l) => l.id === l1.id)).toBeUndefined();
    }
    expect(h.state.ai.rename).toBeNull();
    expect(h.log.flashes).toEqual(["Not saved in preview", "Not saved in preview"]);
  });
});

describe("'Wrong?' on a Roadmap note collapses it the same way", () => {
  const body = (itemRef: string) => JSON.stringify({ itemType: "sprint_note", itemRef, kind: "sprint_note", model: null, promptVersion: null });
  it("hidden at once, leaving for the exit, then simply hidden; a failure brings it back", async () => {
    vi.setSystemTime(NOW);
    const ref = aiItemRef.sprintNote(1, fx.notes[0].generatedAt);
    const key = `sprint_note:${ref}`;
    const h = harness();
    h.ctl.act("aiWrong", body(ref), null);
    expect(h.state.ai.hidden).toEqual([key]);
    expect(h.state.ai.leaving).toEqual([{ key, at: NOW }]);
    vi.advanceTimersByTime(AI_EXIT_MS);
    expect(h.state.ai.leaving).toEqual([]);
    calls.feedback[0](false);
    await flush();
    expect(h.state.ai.hidden).toEqual([]);
  });
});
