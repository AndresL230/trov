/**
 * A run sorting the items, drawn live (web/src/fit-run.ts; Org settings › Tags). Pure tests: where every square
 * is for a given run and moment, the counter's words, when to stop polling, the reduced-motion branch, and that
 * the markup is structurally stable from frame to frame.
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import {
  PARTICLES_MAX, POLL_MAX, EASE_MS, assignOutcomes, easeToward, applyAnswer, shownAt, shouldPoll, particleFrame, particleCount,
  shownFits, runCounter, fitRunView, newLive, type LiveRun,
} from "../web/src/fit-run";
import { tagsTab, initialTagsUi } from "../web/src/tags";
import { STARTER_TAGS, type OrgTagDTO, type TagListDTO, type TagRunDTO } from "@shared/tags-core";

const run = (o: Partial<TagRunDTO> = {}): TagRunDTO => ({ status: "running", started_at: "t", ended_at: null, candidates: 40, checked: 0, suggested: 0, ...o });
const live = (o: Partial<LiveRun> = {}): LiveRun => ({ ...newLive(0), candidates: 40, ...o });

describe("outcomes — from the server's counts only", () => {
  it("each batch of newly checked squares gets exactly as many fits as the count grew by, spread, and earlier ones never change", () => {
    const a = assignOutcomes([], 10, 3);
    expect(a.length).toBe(10);
    expect(a.filter((o) => o === "fit").length).toBe(3);
    const b = assignOutcomes(a, 14, 4);
    expect(b.slice(0, 10)).toEqual(a);
    expect(b.filter((o) => o === "fit").length).toBe(4);
    expect(assignOutcomes(b, 14, 4)).toEqual(b);          // the same answer twice changes nothing
    expect(assignOutcomes([], 3, 9).filter((o) => o === "fit").length).toBe(3); // never more fits than checks
    expect(assignOutcomes([], 0, 0)).toEqual([]);
  });

  it("easing never runs ahead of the server, nor back", () => {
    expect(easeToward(2, 6, 0)).toBe(2);
    const mid = easeToward(2, 6, EASE_MS / 2);
    expect(mid).toBeGreaterThan(2);
    expect(mid).toBeLessThan(6);
    expect(easeToward(2, 6, EASE_MS * 5)).toBe(6);
    expect(easeToward(6, 6, 100)).toBe(6);
    for (let t = 0; t <= EASE_MS; t += 37) expect(easeToward(0, 3, t)).toBeLessThanOrEqual(3);
  });

  it("an answer moves the target; the view eases from where it was; reduced motion shows the count at once", () => {
    let l = applyAnswer(newLive(0), run({ checked: 5, suggested: 1 }), 1000);
    expect(l).toMatchObject({ checked: 5, suggested: 1, from: 0, at: 1000, polls: 1 });
    expect(shownAt(l, 1000)).toBe(0);
    expect(shownAt(l, 1000 + EASE_MS)).toBe(5);
    expect(shownAt(l, 1000, true)).toBe(5);
    l = { ...l, shown: shownAt(l, 1200) };
    const next = applyAnswer(l, run({ checked: 9, suggested: 2 }), 1300);
    expect(next.from).toBe(l.shown);
    expect(next.outcomes.slice(0, 5)).toEqual(l.outcomes);
  });

  it("polling stops when the run ends, while the tab is hidden, and at the cap", () => {
    expect(shouldPoll(live(), false)).toBe(true);
    expect(shouldPoll(live(), true)).toBe(false);
    for (const status of ["done", "capped", "failed"] as const) expect(shouldPoll(live({ status }), false)).toBe(false);
    expect(shouldPoll(live({ polls: POLL_MAX }), false)).toBe(false);
    expect(shouldPoll(live({ polls: POLL_MAX - 1 }), false)).toBe(true);
  });
});

describe("where each square is", () => {
  it("one square per candidate, at most 40; before any check every square waits in the queue on the left", () => {
    expect(particleCount(60)).toBe(PARTICLES_MAX);
    expect(particleCount(7)).toBe(7);
    const f = particleFrame(12, [], 0);
    expect(f.length).toBe(12);
    expect(f.every((p) => p.kind === "wait" && p.x <= 0.3 && p.o === 1)).toBe(true);
  });

  it("checked squares settle: a fit in the group on the right, a miss faded out mid-track; the one being checked is on its way", () => {
    const outcomes = assignOutcomes([], 6, 2);
    const f = particleFrame(10, outcomes, 6.5);
    const fits = f.filter((p) => p.kind === "fit");
    const outs = f.filter((p) => p.kind === "out");
    expect(fits.length).toBe(2);
    expect(fits.every((p) => p.x >= 0.7 && p.o === 1)).toBe(true);
    expect(outs.length).toBe(4);
    expect(outs.every((p) => p.o === 0 && p.x === 0.5)).toBe(true);
    expect(f.slice(7).every((p) => p.kind === "wait")).toBe(true);
    // The 7th square has no outcome yet (the server checked 6): it waits — the view never runs ahead.
    expect(f[6].kind).toBe("wait");
    const moving = particleFrame(10, assignOutcomes([], 7, 2), 6.5)[6];
    expect(moving.kind).toBe("move");
    expect(moving.x).toBeGreaterThan(0);
    expect(moving.x).toBeLessThan(0.7);
  });

  it("with more candidates than squares, each square stands for one candidate in order", () => {
    const outcomes = assignOutcomes([], 60, 60);
    const f = particleFrame(60, outcomes, 30);
    expect(f.length).toBe(40);
    expect(f.filter((p) => p.kind === "fit").length).toBe(20);
  });
});

describe("the counter", () => {
  it("says what the squares show — never ahead", () => {
    const l = live({ checked: 23, outcomes: assignOutcomes([], 23, 5) });
    expect(runCounter(l, 23)).toBe("Checked 23 of 40 · 5 may fit");
    expect(runCounter(l, 10.6)).toBe(`Checked 10 of 40 · ${shownFits(l.outcomes, 10.6)} may fit`);
    expect(runCounter(live({ candidates: 0 }), 0)).toBe("Picking items to check…");
  });
  it("at the end: none fit, plainly; an empty organization; a stop", () => {
    expect(runCounter(live({ status: "done", checked: 40, outcomes: assignOutcomes([], 40, 0) }), 40)).toBe("Checked 40 — none fit.");
    expect(runCounter(live({ status: "done", candidates: 0 }), 0)).toBe("Nothing in this organization to check yet.");
    expect(runCounter(live({ status: "capped", checked: 12, outcomes: assignOutcomes([], 12, 1) }), 12)).toBe("Stopped at 12 of 40: this month's checks are used up.");
    expect(runCounter(live({ status: "failed", checked: 3, outcomes: assignOutcomes([], 3, 0) }), 3)).toBe("Stopped at 3 of 40: the model did not answer.");
  });
});

describe("the markup", () => {
  it("a fixed set of square elements, moved by CSS variables (transform), with a bar and a live counter; the same structure frame to frame", () => {
    const a = fitRunView("billing", "ochre", live({ checked: 5, outcomes: assignOutcomes([], 5, 2), shown: 2.4 }));
    const b = fitRunView("billing", "ochre", live({ checked: 9, outcomes: assignOutcomes([], 9, 3), shown: 7.1 }));
    const structure = (h: string) => h.replace(/ style="[^"]*"/g, "").replace(/ data-kind="[^"]*"/g, "").replace(/>[^<]*</g, "><");
    expect(structure(a)).toBe(structure(b));
    expect((a.match(/class="cnpy-fp"/g) ?? []).length).toBe(40);
    expect(a).toContain(`data-fitrun="billing"`);
    expect(a).toContain("--fit-c:var(--p-ochre)");
    expect(a).toMatch(/class="cnpy-fp" data-p="0" data-kind="(fit|out)" style="--x:[\d.]+;--y:[\d.]+px;opacity:[\d.]+"/);
    expect(a).toContain(`class="cnpy-fitrun-bar"`);
    expect(a).toContain(`role="status" aria-live="polite"`);
    expect(a).not.toMatch(/border-radius|●/);
  });

  it("CSS: squares have no radius and move by transform only; reduced motion hides the track and shows the plain bar; the line keeps its height", () => {
    const at = css.indexOf("/* A run, live (web/src/fit-run.ts)");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at);
    expect(block).not.toMatch(/border-radius/);
    expect(block).toMatch(/\.cnpy-fp \{[^}]*transform:translate\(calc\(var\(--x, 0\) \* \(var\(--track-w\) - 6px\)\), var\(--y, 0px\)\)/);
    expect(block).not.toMatch(/\.cnpy-fp\[^}]*\b(left|top):\s*calc/);
    expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.cnpy-fitrun-track \{ display:none; \}\s*\.cnpy-fitrun-bar \{ display:block; \}/);
    expect(css).toMatch(/\.cnpy-tagfitline \{ min-height:28px; \}/);
    expect(block).toMatch(/\.cnpy-fitrun \{[^}]*height:28px/);
  });

  it("in the tag's row: the live view replaces the line while the run is drawn; after it, a plain sentence when nothing fit or nothing was there", () => {
    const tag = (name: string): OrgTagDTO => ({ name, description: "", color: "sky", starter: false, retired: false, counts: { feed: 0, doc: 0, adr: 0 } });
    const list = (fits: TagListDTO["fits"]): TagListDTO => ({
      tags: [...STARTER_TAGS.map((t) => ({ ...tag(t.name), starter: true, color: t.color })), tag("desktop")], used: 7, cap: 30, suggestions: [],
      ai: { enabled: true, available: true, used: 0, cap: 300, spent: false }, fits,
    });
    const org = { slug: "acme", name: "Acme", role: "owner" as const };
    const liveUi = { ...initialTagsUi(), live: { desktop: live({ candidates: 20, checked: 4, outcomes: assignOutcomes([], 4, 1), shown: 4 }) } };
    const html = tagsTab(org, { list: { status: "ok", data: list({ desktop: { open: 0, run: run({ candidates: 20, checked: 4 }) } }) }, ui: liveUi });
    const row = html.slice(html.indexOf(`data-org-tag="desktop"`));
    expect(row).toContain(`data-fitrun="desktop"`);
    expect(row).toContain("Checked 4 of 20 · 1 may fit");
    expect(row).not.toContain(`data-act="tagFind" data-arg="desktop"`);

    const none = tagsTab(org, { list: { status: "ok", data: list({ desktop: { open: 0, run: run({ status: "done", candidates: 20, checked: 20 }) } }) }, ui: initialTagsUi() });
    expect(none).toContain("Checked 20 — none fit.");
    const empty = tagsTab(org, { list: { status: "ok", data: list({ desktop: { open: 0, run: run({ status: "done", candidates: 0 }) } }) }, ui: initialTagsUi() });
    expect(empty).toContain("Nothing in this organization to check yet.");
  });

  it("the add row nudges for a description once a name is typed — it never requires one", () => {
    const org = { slug: "acme", name: "Acme", role: "owner" as const };
    const l: TagListDTO = { tags: STARTER_TAGS.map((t) => ({ name: t.name, description: t.description, color: t.color, starter: true, retired: false, counts: { feed: 0, doc: 0, adr: 0 } })), used: 6, cap: 30, suggestions: [] };
    const typed = tagsTab(org, { list: { status: "ok", data: l }, ui: { ...initialTagsUi(), nameDraft: "desktop" } });
    expect(typed).toMatch(/style="[^"]*"\s+data-org-tag-nudge>A one-line description helps find the right items\./);
    expect(typed).toMatch(/data-act="tagAdd"(?![^>]*disabled)/);
    const described = tagsTab(org, { list: { status: "ok", data: l }, ui: { ...initialTagsUi(), nameDraft: "desktop", descDraft: "The Electron app" } });
    expect(described).toMatch(/ hidden data-org-tag-nudge>/);
  });
});
