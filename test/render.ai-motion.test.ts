/**
 * Motion on what Trov wrote, in the app's one motion system (web-ui.md › Sidebar & motion, › A row leaving a
 * list): Repo › Overview › State and the Feed's Trov entries (with the one-time note).
 *
 *  • Entrances: State rises with the page (`.cnpy-rise`), a Trov entry cascades with the list (`.cnpy-stagger`);
 *    a Repo tab switch flashes State with the panel, a Source switch flashes the list (`pendingFlash`).
 *  • Exits: "Wrong?" and "Got it" take the item out with Review's exit timing — drawn `inert` in
 *    `.cnpy-ai-leave` for `AI_EXIT_MS`, its keyframe clocked by `--leave-t` (elapsed, negative) so a rebuild
 *    mid-exit JOINS it (these screens are rebuilt per paint), then gone. Never under reduced motion.
 * Pure: HTML strings over render() / the screen's own function, the CSS and main.ts as text, and the AI
 * controller over a stub host.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

const mdMock = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${mdMock(body)}</div>`,
  renderMarkdownInline: (text: string) => mdMock(text),
}));
const feedback = vi.hoisted(() => ({ next: (): Promise<unknown> => Promise.resolve({ ok: true }) }));
vi.mock("../web/src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../web/src/api")>()),
  sendAiFeedback: () => feedback.next(),
  acceptAiSuggestion: () => Promise.resolve({ ok: true }),
  dismissAiSuggestion: () => Promise.resolve({ ok: true }),
}));

import { render, initialState, type AppState } from "../web/src/render";
import { repoStateSection, themesSection, type RepoAiProps } from "../web/src/repo-ai";
import { AI_EXIT_MS, AI_NOTE_LEAVING, aiHiddenKey, aiLeavingT, aiSuggestionKey, initialAiUi, aiFeedback, type AiUi } from "../web/src/ai-ui";
import { createAiController } from "../web/src/ai-actions";
import { repoStateFixture, feedFixtures, briefFixture, themesFixture } from "@shared/ai-fixtures";
import { aiItemRef } from "@shared/ai-core";
import type { DashboardData } from "@shared/dashboard";
import type { FeedRow } from "@shared/rows";
import css from "../web/src/trov.css?raw";
import mainSrc from "../web/src/main.ts?raw";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const T = NOW.getTime();
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });

const ME = { handle: "andres", name: "Andres", avatar_url: null, color: "sky" as const, identities: [], orgs: [{ slug: "trov", name: "Trov", role: "admin" as const }], superadmin: false, pending_invites: 0 };
const PERSONS = [{ handle: "andres", name: "Andres", color: "sky" as const, avatar_url: null, role: null }];
const ui = (o: Partial<AiUi> = {}): AiUi => ({ ...initialAiUi(), ...o });
const rows = (): FeedRow[] => feedFixtures(NOW);
const trovId = () => rows().find((e) => e.ai?.origin === "ai")!.id;
const feedKey = (id: number) => aiHiddenKey("feed", aiItemRef.feed(id));
function feed(ai: AiUi): AppState {
  return { ...initialState(), view: "app", me: ME, orgSlug: "trov", persons: { status: "ok", data: PERSONS }, screen: "feed", feedView: "reading", feed: { status: "ok", data: rows() }, feedAuthors: ["trov", "andres"], ai };
}
const REPO = "AndresL230/trov";
const st = () => repoStateFixture("ready", NOW);
const stateKey = () => aiHiddenKey("repo_state", aiItemRef.repoState(REPO, st().generatedAt ?? "state"));
const rp = (o: Partial<AiUi> = {}): RepoAiProps => ({ ui: ui(o), admin: true, repo: REPO });
const brief = () => briefFixture("ready", NOW);
const briefKey = () => aiHiddenKey("brief", aiItemRef.brief(brief().generatedAt!));
function mywork(ai: AiUi): AppState {
  const data: DashboardData = { person: "andres", previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false, brief: brief() };
  return { ...initialState(), view: "app", me: ME, orgSlug: "trov", persons: { status: "ok", data: PERSONS }, screen: "mywork", mywork: { status: "ok", data }, ai };
}
/** The `.cnpy-ai-leave` wrapper around `inner`, if any. */
const leaving = (html: string) => html.match(/<div class="cnpy-ai-leave" data-ai-leaving inert style="--leave-t:(-?\d+)ms"><div class="cnpy-ai-leave-in">/);

describe("entrances — the app's own, nothing new", () => {
  it("State rises with the page; a Trov entry cascades in the feed's list", () => {
    expect(repoStateSection(st(), rp())).toMatch(/^<section[^>]*class="[^"]*\brepo-ai cnpy-rise\b/);
    const html = render(feed(ui()));
    const list = html.slice(html.indexOf('<div class="cnpy-stagger">'));
    expect(list).toContain(`data-feed-id="${trovId()}"`);
  });
  it("a Repo tab switch flashes State with the panel; a Source switch flashes the list (pendingFlash)", () => {
    expect(mainSrc).toContain('pendingFlash = ".repo-panel > :not(.repo-poll-strip), .repo-ai";');
    expect(mainSrc).toContain("flashNext: (sel) => { pendingFlash = sel; }");
    const flashed: string[] = [];
    const s = feed(ui());
    const ctl = createAiController({ state: s, mount: {} as HTMLElement, rerender: () => {}, flash: () => {}, unauth: () => {}, flashNext: (sel) => flashed.push(sel) });
    ctl.act("aiFeedSource", "trov", null);
    ctl.act("aiFeedSource", "trov", null); // the same value: nothing to flash
    expect(flashed).toEqual(["#cnpy-main .cnpy-stagger"]);
    expect(s.ai.feedSource).toBe("trov");
  });
});

describe("exits — Wrong? and Got it leave with Review's timing, and a rebuild joins them", () => {
  it("a Trov entry pressed Wrong? is drawn leaving, inert, then gone; a rebuild later is further in", () => {
    const id = trovId();
    const s = feed(ui({ hidden: [feedKey(id)], leaving: [{ key: feedKey(id), at: T - 100 }] }));
    const html = render(s);
    const m = leaving(html);
    expect(m?.[1]).toBe("-100");
    expect(html.slice(html.indexOf("data-ai-leaving"))).toContain(`data-feed-id="${id}"`);
    vi.setSystemTime(T + 150);
    expect(render(s)).toContain("--leave-t:-250ms"); // joins the exit where it was — never replays it
    vi.setSystemTime(T + AI_EXIT_MS);
    expect(render(s)).not.toContain(`data-feed-id="${id}"`);
    vi.setSystemTime(NOW);
    // Hidden with no exit (reduced motion, or long ago): simply not there, as before.
    expect(render(feed(ui({ hidden: [feedKey(id)] })))).not.toContain(`data-feed-id="${id}"`);
  });
  it("the note leaves after Got it the same way, then is not drawn again", () => {
    const seen = ui({ noteSeen: ["andres"], leaving: [{ key: AI_NOTE_LEAVING, at: T - 40 }] });
    const html = render(feed(seen));
    expect(html).toContain('style="--leave-t:-40ms"><div class="cnpy-ai-leave-in"><aside aria-label="New" class="cnpy-ai-note"');
    expect(render(feed(ui({ noteSeen: ["andres"] })))).not.toContain("cnpy-ai-note");
    expect(render(feed(ui()))).toContain("cnpy-ai-note");
  });
  it("State pressed Wrong? is drawn leaving (the whole section), then nothing", () => {
    const h = repoStateSection(st(), rp({ hidden: [stateKey()], leaving: [{ key: stateKey(), at: T - 10 }] }));
    expect(leaving(h)?.[1]).toBe("-10");
    expect(h).toContain('data-ai="repo_state"');
    expect(repoStateSection(st(), rp({ hidden: [stateKey()], leaving: [{ key: stateKey(), at: T - AI_EXIT_MS }] }))).toBe("");
    expect(repoStateSection(st(), rp({ hidden: [stateKey()] }))).toBe("");
    expect(aiLeavingT(ui({ leaving: [{ key: "x", at: T - 5 }] }), "x")).toBe(5);
  });
  it("the CSS: Review's clock, a keyframe on the negative delay, above the list's entrance, off under reduced motion", () => {
    const fast = Number(css.match(/--fx-fast:\.(\d+)s/)?.[1]) * 10; // ".18s" → 180
    expect(AI_EXIT_MS).toBe(130 + fast);
    expect(css).toContain("@keyframes cnpy-ai-leave {");
    expect(css).toContain(".cnpy-ai-leave, [data-enter] .cnpy-ai-leave, [data-enter] .cnpy-stagger > .cnpy-ai-leave { display:grid; grid-template-rows:0fr; opacity:0; pointer-events:none; animation:cnpy-ai-leave calc(.13s + var(--fx-fast)) var(--fx-ease) both; animation-delay:var(--leave-t, 0ms); }");
    expect(css).toContain(".cnpy-ai-leave-in { min-height:0; overflow:hidden; }");
    expect(css).toContain("@media (prefers-reduced-motion: reduce) { .cnpy-ai-leave { animation:none !important; display:none; } }");
  });
});

describe("the controller (ai-actions.ts)", () => {
  afterEach(() => { vi.unstubAllGlobals(); feedback.next = () => Promise.resolve({ ok: true }); vi.setSystemTime(NOW); });
  const host = (s: AppState) => {
    const paints = { n: 0 };
    const ctl = createAiController({ state: s, mount: {} as HTMLElement, rerender: () => { paints.n++; }, flash: () => {}, unauth: () => {} });
    return { ctl, paints };
  };
  const wrongArg = (id: number) => JSON.stringify(aiFeedback("feed", aiItemRef.feed(id), "feed", "claude-haiku-5-5"));
  const motion = (reduce: boolean) => vi.stubGlobal("window", { matchMedia: () => ({ matches: reduce }) });

  it("Wrong? hides at once AND starts the exit; the exit ends after AI_EXIT_MS with one more paint", async () => {
    motion(false);
    const s = feed(ui());
    const { ctl, paints } = host(s);
    ctl.act("aiWrong", wrongArg(trovId()), null);
    expect(s.ai.hidden).toEqual([feedKey(trovId())]);
    expect(s.ai.leaving).toEqual([{ key: feedKey(trovId()), at: T }]);
    await vi.advanceTimersByTimeAsync(AI_EXIT_MS);
    expect(s.ai.leaving).toEqual([]);
    expect(s.ai.hidden).toEqual([feedKey(trovId())]);
    expect(paints.n).toBe(2);
  });
  it("under reduced motion nothing leaves: it is simply gone", () => {
    motion(true);
    const s = feed(ui());
    host(s).ctl.act("aiWrong", wrongArg(trovId()), null);
    expect(s.ai.hidden).toEqual([feedKey(trovId())]);
    expect(s.ai.leaving).toEqual([]);
  });
  it("a failed write brings it back at once — no exit left running", async () => {
    motion(false);
    feedback.next = () => Promise.reject(new Error("boom"));
    const s = feed(ui());
    host(s).ctl.act("aiWrong", wrongArg(trovId()), null);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.ai.hidden).toEqual([]);
    expect(s.ai.leaving).toEqual([]);
  });
  it("Accept / Dismiss on ANY suggestion: the kit's one exit starts on the click (held: no timer clears it); ONE re-read once the exit is over", async () => {
    motion(false);
    vi.setSystemTime(NOW);
    const s = feed(ui());
    const decided: [number, string][] = [];
    const ctl = createAiController({ state: s, mount: {} as HTMLElement, rerender: () => {}, flash: () => {}, unauth: () => {}, decided: (id, how) => { decided.push([id, how]); } });
    ctl.act("aiAccept", "42", null);
    expect(s.ai.leaving).toEqual([{ key: aiSuggestionKey(42), at: T }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(decided).toEqual([]); // the exit is still running
    await vi.advanceTimersByTimeAsync(AI_EXIT_MS);
    expect(decided).toEqual([[42, "accept"]]);
    await vi.advanceTimersByTimeAsync(AI_EXIT_MS * 3);
    expect(s.ai.leaving).toEqual([{ key: aiSuggestionKey(42), at: T }]); // held until the re-read drops the chip
    // A later exit drops entries older than 10 s.
    vi.setSystemTime(T + 11_000);
    ctl.act("aiDismiss", "43", null);
    expect(s.ai.leaving).toEqual([{ key: aiSuggestionKey(43), at: T + 11_000 }]);
    vi.setSystemTime(NOW);
  });
  it("a theme proposal's answer re-reads the Repo dashboard only after the exit; under reduced motion at once (and it is gone at once)", async () => {
    for (const reduce of [false, true]) {
      motion(reduce);
      vi.setSystemTime(NOW);
      const s = { ...feed(ui()), repo: { status: "ok", data: { themes: { "8w": { lanes: [{ suggestionId: 7 }] } } } } } as unknown as AppState;
      let reloads = 0;
      const ctl = createAiController({ state: s, mount: {} as HTMLElement, rerender: () => {}, flash: () => {}, unauth: () => {}, reloadRepo: () => { reloads++; } });
      ctl.act("aiAccept", "7", null);
      expect(s.ai.leaving).toEqual([{ key: aiSuggestionKey(7), at: T }]); // recorded either way: `.cnpy-ai-leave` is display:none under reduced motion
      await vi.advanceTimersByTimeAsync(0);
      expect(reloads).toBe(reduce ? 1 : 0);
      await vi.advanceTimersByTimeAsync(AI_EXIT_MS);
      expect(reloads).toBe(1);
    }
  });
  it("Got it starts the note's exit", () => {
    motion(false);
    const s = feed(ui());
    host(s).ctl.act("aiNoteGotIt", null, null);
    expect(s.ai.noteSeen).toEqual(["andres"]);
    expect(s.ai.leaving).toEqual([{ key: AI_NOTE_LEAVING, at: T }]);
  });
  // e2e BR-10 / MO-18 (Phase H): the brief tile vanished at once on "Wrong?" and the bento jumped to its other layout.
  it("Wrong? on the brief: once the tile's exit is over, the bento that takes its place fades in (pendingFlash); none under reduced motion", async () => {
    for (const reduce of [false, true]) {
      motion(reduce);
      vi.setSystemTime(NOW);
      const s = mywork(ui());
      const flashed: string[] = [];
      const ctl = createAiController({ state: s, mount: {} as HTMLElement, rerender: () => {}, flash: () => {}, unauth: () => {}, flashNext: (sel) => { flashed.push(sel); } });
      ctl.act("aiWrong", JSON.stringify(aiFeedback("brief", aiItemRef.brief(brief().generatedAt!), "brief", "claude-haiku-5-5")), null);
      expect(s.ai.hidden).toEqual([briefKey()]);
      await vi.advanceTimersByTimeAsync(AI_EXIT_MS);
      expect(flashed).toEqual(reduce ? [] : [".mw-bento"]);
    }
  });
});

describe("Where the work went: Wrong? on a range leaves by the kit's one exit (e2e TH-16 / MO-26)", () => {
  const all = () => ({ "8w": themesFixture("ready", "8w", NOW), quarter: themesFixture("ready", "quarter", NOW) });
  const key8w = () => aiHiddenKey("themes", aiItemRef.themes(REPO, "8w", all()["8w"].generatedAt ?? "themes"));
  it("while it leaves, the card keeps its head and switch and what Trov wrote collapses inside it; then the card says why", () => {
    const during = themesSection(all(), rp({ hidden: [key8w()], leaving: [{ key: key8w(), at: T - 25 }] }));
    expect(during).toContain('data-act="aiThemesRange"');
    expect(leaving(during)?.[1]).toBe("-25");
    const inside = during.slice(during.indexOf('class="cnpy-ai-leave"'));
    expect(inside).toContain("repo-band");
    // the caption and the byline leave with it (only the heading and the switch stay)
    expect(all()["8w"].caption).toBeTruthy();
    expect(inside).toContain(all()["8w"].caption!);
    expect(inside).toContain("Themes and caption written by Trov");
    expect(during).not.toContain("You marked this range wrong");
    const after = themesSection(all(), rp({ hidden: [key8w()], leaving: [{ key: key8w(), at: T - AI_EXIT_MS }] }));
    expect(after).not.toContain("cnpy-ai-leave");
    expect(after).toContain("You marked this range wrong, so it is hidden for you until Trov writes it again.");
  });
  it("both ranges out: the whole card leaves, then nothing", () => {
    const { "8w": _g, ...onlyQuarter } = all();
    const keyQ = aiHiddenKey("themes", aiItemRef.themes(REPO, "quarter", all().quarter.generatedAt ?? "themes"));
    const p = (at: number) => rp({ themesRange: "quarter", hidden: [keyQ], leaving: [{ key: keyQ, at }] });
    expect(leaving(themesSection(onlyQuarter, p(T - 25)))).not.toBeNull();
    expect(themesSection(onlyQuarter, p(T - AI_EXIT_MS))).toBe("");
  });
});

describe("My Work's brief leaves by the kit's one exit (e2e BR-10 / MO-18)", () => {
  it("pressed Wrong?, the tile is drawn leaving IN its bento slot, then the bento without it", () => {
    const during = render(mywork(ui({ hidden: [briefKey()], leaving: [{ key: briefKey(), at: T - 40 }] })));
    expect(during).toContain("mw-bento-brief");
    expect(during).toMatch(/<div class="cnpy-ai-leave" data-ai-leaving inert style="--leave-t:-40ms"><div class="cnpy-ai-leave-in"><section[^>]*data-mw="brief"/);
    const after = render(mywork(ui({ hidden: [briefKey()], leaving: [{ key: briefKey(), at: T - AI_EXIT_MS }] })));
    expect(after).not.toContain('data-mw="brief"');
    expect(after).not.toContain("mw-bento-brief");
    expect(render(mywork(ui({ hidden: [briefKey()] })))).not.toContain('data-mw="brief"');
    expect(render(mywork(ui()))).not.toContain("cnpy-ai-leave");
  });
  it("the CSS keeps the leaving tile in the brief's area (and full width on a phone)", () => {
    expect(css).toContain(".mw-bento-brief > .cnpy-ai-leave { grid-area:brief; min-height:0; }");
    expect(css).toContain(".mw-bento-brief > .cnpy-ai-leave > .cnpy-ai-leave-in > .mw-tile { height:100%; }");
    expect(css).toContain(".mw-bento-brief > .cnpy-ai-leave { grid-area:auto; grid-column:span 12; }");
  });
});
