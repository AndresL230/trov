/**
 * A run tagging the items, drawn live (web/src/fit-run.ts; Org settings › Tags): ONE bar whose fill is the real
 * `checked / candidates`, eased between polls and never ahead of the server, the words above it, and a colour
 * that says how the run ended — all inside the row's "Added by Jev" cell, which is the same structure live and at
 * rest. Pure tests, plus the CSS rules (reduced motion, no radius, the bar out of the flow).
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import {
  POLL_MAX, EASE_MS, easeToward, applyAnswer, shownAt, shouldPoll, barFill, barState, shownAdded, runCounter, resultWords, fitCell, newLive, type LiveRun,
} from "../web/src/fit-run";
import { tagsTab, tagAddModal, initialTagsUi } from "../web/src/tags";
import { STARTER_TAGS, type OrgTagDTO, type TagListDTO, type TagRunDTO } from "@shared/tags-core";

const run = (o: Partial<TagRunDTO> = {}): TagRunDTO => ({ id: 1, status: "running", started_at: "t", ended_at: null, candidates: 40, checked: 0, added: 0, undone_at: null, ...o });
const live = (o: Partial<LiveRun> = {}): LiveRun => ({ ...newLive(0), candidates: 40, ...o });

describe("the bar — real progress only", () => {
  it("its fill is exactly checked / candidates, clamped", () => {
    expect(barFill(live(), 10)).toBe(0.25);
    expect(barFill(live(), 40)).toBe(1);
    expect(barFill(live({ candidates: 0 }), 0)).toBe(0);
    expect(barFill(live(), 99)).toBe(1);
  });

  it("easing never runs ahead of the server, nor back", () => {
    expect(easeToward(2, 6, 0)).toBe(2);
    const mid = easeToward(2, 6, EASE_MS / 2);
    expect(mid).toBeGreaterThan(2);
    expect(mid).toBeLessThan(6);
    expect(easeToward(2, 6, EASE_MS * 5)).toBe(6);
    for (let t = 0; t <= EASE_MS; t += 37) expect(easeToward(0, 3, t)).toBeLessThanOrEqual(3);
  });

  it("an answer moves the target; the bar eases from where it was; reduced motion shows the count at once", () => {
    let l = applyAnswer(newLive(0), run({ checked: 5, added: 1 }), 1000);
    expect(l).toMatchObject({ checked: 5, added: 1, from: 0, at: 1000, polls: 1 });
    expect(shownAt(l, 1000)).toBe(0);
    expect(shownAt(l, 1000 + EASE_MS)).toBe(5);
    expect(shownAt(l, 1000, true)).toBe(5);
    l = { ...l, shown: shownAt(l, 1200) };
    expect(applyAnswer(l, run({ checked: 9 }), 1300).from).toBe(l.shown);
  });

  it("its colour state: running until the run ends AND the bar has caught up; then 'added' (the tag's colour) or 'none' (quiet)", () => {
    expect(barState(live({ status: "running", checked: 10 }), 10)).toBe("running");
    expect(barState(live({ status: "done", checked: 40, added: 3 }), 31)).toBe("running"); // still catching up
    expect(barState(live({ status: "done", checked: 40, added: 3 }), 40)).toBe("added");
    expect(barState(live({ status: "done", checked: 40, added: 0 }), 40)).toBe("none");
    expect(barState(live({ status: "capped", checked: 9, added: 2 }), 9)).toBe("added");
  });

  it("polling stops when the run ends, while the tab is hidden, and at the cap", () => {
    expect(shouldPoll(live(), false)).toBe(true);
    expect(shouldPoll(live(), true)).toBe(false);
    for (const status of ["done", "capped", "failed"] as const) expect(shouldPoll(live({ status }), false)).toBe(false);
    expect(shouldPoll(live({ polls: POLL_MAX }), false)).toBe(false);
  });
});

describe("the counter", () => {
  it("says what the bar shows — never ahead — in few words (it sits in one narrow column)", () => {
    const l = live({ checked: 20, added: 5 });
    expect(runCounter(l, 20)).toBe("20 of 40 · 5 added");
    expect(runCounter(l, 10.4)).toBe(`10 of 40 · ${shownAdded(l, 10.4)} added`);
    expect(shownAdded(l, 10.4)).toBeLessThanOrEqual(5);
    expect(runCounter(live({ candidates: 0 }), 0)).toBe("Starting…");
  });
  it("at the end: the result's own words — the same the row keeps at rest — and the whole sentence for the tooltip", () => {
    expect(runCounter(live({ status: "done", checked: 40, added: 7 }), 40)).toBe("7 added");
    expect(runCounter(live({ status: "done", checked: 40, added: 0 }), 40)).toBe("None fit");
    expect(runCounter(live({ status: "done", candidates: 0 }), 0)).toBe("Nothing to check");
    expect(runCounter(live({ status: "capped", checked: 12, added: 1 }), 12)).toBe("Stopped · 1 added");
    expect(runCounter(live({ status: "failed", checked: 3 }), 3)).toBe("Stopped");
    expect(resultWords({ status: "done", candidates: 40, checked: 40, added: 1 }).full).toBe("Added to 1 item.");
    expect(resultWords({ status: "done", candidates: 40, checked: 40, added: 0 }).full).toBe("Checked 40 — none fit.");
    expect(resultWords({ status: "capped", candidates: 40, checked: 12, added: 1 }).full).toBe("Stopped at 12 of 40: this month's checks are used up. Added to 1 item.");
    expect(resultWords({ status: "failed", candidates: 40, checked: 3, added: 0 }).full).toBe("Stopped at 3 of 40: the model did not answer.");
    expect(resultWords({ status: "done", candidates: 40, checked: 40, added: 7, undone: true })).toEqual({ text: "Undone", full: "Undone: the 7 items this run tagged no longer have it." });
  });
});

describe("the markup and the CSS", () => {
  it("one cell, the SAME structure live and at rest: the words, then the bar (a progressbar filled by a transform)", () => {
    const a = fitCell("billing", "ochre", live({ checked: 5, shown: 2.4 }), undefined);
    const b = fitCell("billing", "ochre", live({ status: "done", checked: 40, added: 3, shown: 40 }), undefined);
    const rest = fitCell("billing", "ochre", null, run({ status: "done", checked: 40, added: 3 }));
    const structure = (h: string) => h.replace(/ (style|data-state|data-live|title|aria-hidden|aria-valuenow|aria-valuemax)="[^"]*"/g, "").replace(/>[^<]*</g, "><");
    expect(structure(a)).toBe(structure(b));
    expect(structure(a)).toBe(structure(rest));
    expect(a).toContain(`data-state="running" data-live="1"`);
    expect(b).toContain(`data-state="added" data-live="1"`);
    expect(rest).toContain(`data-state="added" data-morph-key`);   // at rest: no data-live, so the bar is hidden
    expect(rest).toContain(">3 added<");
    expect(b).toContain(">3 added<");                               // the words do not change when the list takes over
    expect(fitCell("x", "ochre", live({ status: "done", checked: 40, shown: 40 }), undefined)).toContain(`data-state="none"`);
    expect(fitCell("x", "ochre", null, undefined)).toContain(`data-state="idle"`);
    expect(a).toContain(`role="progressbar"`);
    expect(a).toContain(`aria-valuemax="40" aria-valuenow="2"`);
    expect(a).toContain("transform:scaleX(0.0600)");
    expect(a).toContain("--fit-c:var(--p-ochre)");
    expect(a).toContain(`role="status" aria-live="polite"`);
    expect(a).toContain(`data-morph-key="fitrun:billing"`);
    expect(a).not.toMatch(/border-radius|●/);
  });

  it("CSS: the bar is out of the flow and shown only while live; fill a transform, colour by state, instant under reduced motion; no radius", () => {
    const at = css.indexOf(`/* A row's "Added by Jev" cell`);
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("\n", css.indexOf("@media (prefers-reduced-motion: reduce) { .cnpy-fitrun-bar", at)));
    expect(block).not.toMatch(/border-radius/);
    expect(block).toMatch(/\.cnpy-tagjev \.cnpy-fitrun-bar \{ position:absolute;[^}]*opacity:0;/);
    expect(block).toMatch(/\.cnpy-tagjev\[data-live\] \.cnpy-fitrun-bar \{ opacity:1;/);
    expect(block).toMatch(/\.cnpy-fitrun-bar > span \{[^}]*transform-origin:left center; transition:background-color \.45s/);
    expect(block).toMatch(/\.cnpy-tagjev\[data-state="added"\] \.cnpy-fitrun-bar > span \{ background:var\(--fit-c/);
    expect(block).toMatch(/\.cnpy-tagjev\[data-state="none"\] \.cnpy-fitrun-bar > span \{ background:var\(--fg-40\)/);
    expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.cnpy-fitrun-bar > span, \.cnpy-tagjev \.cnpy-fitrun-bar \{ transition:none; \} \.cnpy-tagjev-undo \{ animation:none; \} \}/);
    expect(css).not.toContain(".cnpy-fp");
    expect(css).not.toContain(".cnpy-tagfitline");                  // no second line under a row any more
  });

  it("in the tag's row: the live view is the Jev cell, and Find items waits while the run goes", () => {
    const tag = (name: string): OrgTagDTO => ({ name, description: "", color: "sky", starter: false, retired: false, counts: { feed: 0, doc: 0, adr: 0 } });
    const list: TagListDTO = {
      tags: [...STARTER_TAGS.map((t) => ({ ...tag(t.name), starter: true, color: t.color })), tag("desktop")], used: 7, cap: 30, suggestions: [],
      ai: { enabled: true, available: true, used: 0, cap: 300, spent: false }, runs: { desktop: run({ candidates: 20, checked: 4 }) },
    };
    const ui = { ...initialTagsUi(), live: { desktop: live({ candidates: 20, checked: 4, added: 1, shown: 4 }) } };
    const html = tagsTab({ slug: "acme", name: "Acme", role: "owner" }, { list: { status: "ok", data: list }, ui });
    const row = html.slice(html.indexOf(`data-org-tag="desktop"`));
    expect(row).toContain(`data-fitrun="desktop"`);
    expect(row).toContain("4 of 20 · 1 added");
    expect(row).toMatch(/data-act="tagFind" data-arg="desktop"[^>]* disabled/);
  });

  it("the New tag modal: Find the items that fit it now is ON by default when Jev may look, and says why when it can't", () => {
    const tagRow = (t: (typeof STARTER_TAGS)[number]) => ({ name: t.name, description: t.description, color: t.color, starter: true, retired: false, counts: { feed: 0, doc: 0, adr: 0 } });
    const l = (ai?: TagListDTO["ai"]): TagListDTO => ({ tags: STARTER_TAGS.map(tagRow), used: 6, cap: 30, suggestions: [], ...(ai ? { ai } : {}) });
    const on = tagAddModal({ ...initialTagsUi(), addOpen: true, nameDraft: "desktop" }, l({ enabled: true, available: true, used: 0, cap: 300, spent: false }));
    expect(on).toMatch(/data-act="tagNewScan"[^>]*role="switch" aria-checked="true"/);
    expect(on).toContain(">Add and find items<");
    const off = tagAddModal({ ...initialTagsUi(), addOpen: true, nameDraft: "desktop", addScan: false }, l({ enabled: true, available: true, used: 0, cap: 300, spent: false }));
    expect(off).toMatch(/aria-checked="false"/);
    expect(off).toContain(">Add tag<");
    expect(off).toContain("Off: the tag is added to nothing.");
    const noKey = tagAddModal({ ...initialTagsUi(), addOpen: true }, l({ enabled: true, available: false, used: 0, cap: 300, spent: false }));
    expect(noKey).toContain("This Trov has no TypeSafe AI key set.");
    expect(noKey).toMatch(/<button [^>]*disabled[^>]*data-act="tagNewScan"/);
    expect(tagAddModal({ ...initialTagsUi(), addOpen: true }, l())).not.toContain("tagNewScan"); // a member's list carries no ai
  });

});
