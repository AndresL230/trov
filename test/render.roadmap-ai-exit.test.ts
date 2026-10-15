/**
 * The Roadmap's exits, driven through the REAL controller (web/src/ai-actions.ts) — RULES §8 / web-ui.md › A row
 * leaving a list: an Accept / Dismiss on a Roadmap card is sent at once and the card collapses (`leaving`, then
 * `decided`), the re-read waits until no card is collapsing, a failed write puts the card back exactly; "Wrong?" on a
 * note collapses it the same way. Under reduced motion, and off the Roadmap, it goes at once (no `leaving`).
 * The API calls are stubbed (they are the network); everything else is the shipped code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls = vi.hoisted(() => ({ accept: [] as Array<(ok: boolean) => void>, dismiss: [] as Array<(ok: boolean) => void>, feedback: [] as Array<(ok: boolean) => void> }));
vi.mock("../web/src/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../web/src/api")>();
  const pending = (list: Array<(ok: boolean) => void>) => new Promise<unknown>((res, rej) => list.push((ok) => (ok ? res({}) : rej(new real.ApiError(400, "invalid")))));
  return {
    ...real,
    acceptAiSuggestion: () => pending(calls.accept),
    dismissAiSuggestion: () => pending(calls.dismiss),
    sendAiFeedback: () => pending(calls.feedback),
  };
});
vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));

import { createAiController } from "../web/src/ai-actions";
import { AI_EXIT_MS, aiLeaveKey } from "../web/src/ai-ui";
import { initialState, type AppState } from "../web/src/render";
import { roadmapSuggestionCards } from "../web/src/roadmap-ai";
import { roadmapFixture } from "@shared/ai-fixtures";
import { aiItemRef } from "@shared/ai-core";

const fx = roadmapFixture("ready", new Date("2026-10-14T12:00:00Z"))!;
const [A, B] = fx.suggestions;
const flush = () => new Promise<void>((r) => queueMicrotask(r)).then(() => Promise.resolve()).then(() => Promise.resolve());

function harness(screen: "roadmap" | "repo" = "roadmap") {
  const state: AppState = {
    ...initialState(), view: "app", screen, roadmapTab: "narrative",
    roadmap: { status: "ok", data: { narrative: "", version: 1, updated_at: null, updated_by: null, sprints: [], suggestions: fx.suggestions, drift: fx.drift } },
  };
  const log = { rerenders: 0, flashes: [] as string[], afterDecide: [] as Array<[number, string]> };
  const ctl = createAiController({
    state, mount: {} as HTMLElement, rerender: () => { log.rerenders++; }, flash: (m) => { log.flashes.push(m); }, unauth: () => {},
    afterDecide: (id, how) => { log.afterDecide.push([id, how]); },
  });
  return { state, ctl, log, cards: () => roadmapSuggestionCards(state.roadmap.data.suggestions, state.ai) };
}

let reduced = false;
beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  calls.accept.length = 0; calls.dismiss.length = 0; calls.feedback.length = 0;
  vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("a Roadmap card leaves by Review's exit", () => {
  it("Accept: sent at once, the card collapses, then is gone; the re-read waits for the exit", async () => {
    const h = harness();
    h.ctl.act("aiAccept", String(A.id), null);
    expect(calls.accept).toHaveLength(1);
    expect(h.state.ai.decided).toEqual([A.id]);
    expect(h.state.ai.leaving).toEqual([aiLeaveKey.suggestion(A.id)]);
    expect(h.cards()).toContain(`data-morph-key="s:${A.id}" data-verdict="out" inert>`);
    calls.accept[0](true);  // the write lands BEFORE the exit is over
    await flush();
    expect(h.log.flashes).toEqual(["Accepted"]);
    expect(h.log.afterDecide).toEqual([]);  // held: a card is still collapsing
    vi.advanceTimersByTime(AI_EXIT_MS);
    expect(h.state.ai.leaving).toEqual([]);
    expect(h.cards()).not.toContain(`s:${A.id}`);
    expect(h.cards()).toContain(`s:${B.id}`);
    expect(h.log.afterDecide).toEqual([[A.id, "accept"]]);
    h.ctl.act("aiAccept", String(A.id), null);  // a second click on a card already taken does nothing
    expect(calls.accept).toHaveLength(1);
  });

  it("two cards in a row: ONE re-read, after the last exit", async () => {
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
    expect(h.cards()).toBe("");
  });

  it("a failed write puts the card back exactly, with a toast", async () => {
    const h = harness();
    const before = h.cards();
    h.ctl.act("aiAccept", String(A.id), null);
    calls.accept[0](false);
    await flush();
    expect(h.state.ai.decided).toEqual([]);
    expect(h.state.ai.leaving).toEqual([]);
    expect(h.cards()).toBe(before);
    expect(h.log.flashes).toEqual(["Couldn't do that. Try again."]);
    vi.advanceTimersByTime(AI_EXIT_MS);
    expect(h.log.afterDecide).toEqual([]);
  });

  it("reduced motion: gone at once, no collapsing state", async () => {
    reduced = true;
    const h = harness();
    h.ctl.act("aiDismiss", String(A.id), null);
    expect(h.state.ai.leaving).toEqual([]);
    expect(h.cards()).not.toContain(`s:${A.id}`);
    calls.dismiss[0](true);
    await flush();
    expect(h.log.afterDecide).toEqual([[A.id, "dismiss"]]);
  });

  it("off the Roadmap (a theme proposal on Repo) the kit's own busy path is unchanged: no leaving", async () => {
    const h = harness("repo");
    h.ctl.act("aiAccept", String(A.id), null);
    expect(h.state.ai.busy).toEqual([A.id]);
    expect(h.state.ai.leaving).toEqual([]);
    expect(h.state.ai.decided).toEqual([]);
  });
});

describe("'Wrong?' on a Roadmap note collapses it the same way", () => {
  const body = (itemRef: string) => JSON.stringify({ itemType: "sprint_note", itemRef, kind: "sprint_note", model: null, promptVersion: null });
  it("hidden at once, leaving for the exit, then simply hidden; a failure brings it back", async () => {
    const ref = aiItemRef.sprintNote(1, fx.notes[0].generatedAt);
    const key = `sprint_note:${ref}`;
    const h = harness();
    h.ctl.act("aiWrong", body(ref), null);
    expect(h.state.ai.hidden).toEqual([key]);
    expect(h.state.ai.leaving).toEqual([key]);
    vi.advanceTimersByTime(AI_EXIT_MS);
    expect(h.state.ai.leaving).toEqual([]);
    calls.feedback[0](false);
    await flush();
    expect(h.state.ai.hidden).toEqual([]);
  });
});
