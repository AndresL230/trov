/**
 * A run tagging the items, drawn live (web/src/fit-run.ts; Org settings › Tags): ONE bar whose fill is the real
 * `checked / candidates`, eased between polls and never ahead of the server, a counter beside it, and a colour
 * that says how the run ended. Pure tests, plus the CSS rules (reduced motion, no radius, the fixed height).
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import {
  POLL_MAX, EASE_MS, easeToward, applyAnswer, shownAt, shouldPoll, barFill, barState, shownAdded, runCounter, fitRunView, newLive, type LiveRun,
} from "../web/src/fit-run";
import { tagsTab, initialTagsUi } from "../web/src/tags";
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
  it("says what the bar shows — never ahead", () => {
    const l = live({ checked: 20, added: 5 });
    expect(runCounter(l, 20)).toBe("Checked 20 of 40 · 5 added");
    expect(runCounter(l, 10.4)).toBe(`Checked 10 of 40 · ${shownAdded(l, 10.4)} added`);
    expect(shownAdded(l, 10.4)).toBeLessThanOrEqual(5);
    expect(runCounter(live({ candidates: 0 }), 0)).toBe("Picking items to check…");
  });
  it("at the end: what it added, none fit, an empty organization, a stop", () => {
    expect(runCounter(live({ status: "done", checked: 40, added: 7 }), 40)).toBe("Added to 7 items.");
    expect(runCounter(live({ status: "done", checked: 40, added: 1 }), 40)).toBe("Added to 1 item.");
    expect(runCounter(live({ status: "done", checked: 40, added: 0 }), 40)).toBe("Checked 40 — none fit.");
    expect(runCounter(live({ status: "done", candidates: 0 }), 0)).toBe("Nothing in this organization to check yet.");
    expect(runCounter(live({ status: "capped", checked: 12, added: 1 }), 12)).toBe("Stopped at 12 of 40: this month's checks are used up. Added to 1 item.");
    expect(runCounter(live({ status: "failed", checked: 3 }), 3)).toBe("Stopped at 3 of 40: the model did not answer.");
  });
});

describe("the markup and the CSS", () => {
  it("one bar (a progressbar, filled by a transform) and a live counter; the same structure while running and at the end", () => {
    const a = fitRunView("billing", "ochre", live({ checked: 5, shown: 2.4 }));
    const b = fitRunView("billing", "ochre", live({ status: "done", checked: 40, added: 3, shown: 40 }));
    const structure = (h: string) => h.replace(/ (style|data-state|aria-valuenow|aria-valuemax)="[^"]*"/g, "").replace(/>[^<]*</g, "><");
    expect(structure(a)).toBe(structure(b));
    expect(a).toContain(`data-state="running"`);
    expect(b).toContain(`data-state="added"`);
    expect(fitRunView("x", "ochre", live({ status: "done", checked: 40, shown: 40 }))).toContain(`data-state="none"`);
    expect(a).toContain(`role="progressbar"`);
    expect(a).toContain(`aria-valuemax="40" aria-valuenow="2"`);
    expect(a).toContain("transform:scaleX(0.0600)");
    expect(a).toContain("--fit-c:var(--p-ochre)");
    expect(a).toContain(`role="status" aria-live="polite"`);
    expect(a).not.toContain("cnpy-fp"); // no particles
    expect(a).not.toMatch(/border-radius|●/);
  });

  it("CSS: the fill is a transform, its colour by state (the tag's own when added, quiet when not), a short colour transition — instant under reduced motion; no radius; the line keeps its height", () => {
    const at = css.indexOf("/* A run, live (web/src/fit-run.ts)");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at);
    expect(block).not.toMatch(/border-radius/);
    expect(block).toMatch(/\.cnpy-fitrun-bar > span \{[^}]*transform-origin:left center; transition:background-color \.45s/);
    expect(block).toMatch(/\.cnpy-fitrun\[data-state="added"\] \.cnpy-fitrun-bar > span \{ background:var\(--fit-c/);
    expect(block).toMatch(/\.cnpy-fitrun\[data-state="none"\] \.cnpy-fitrun-bar > span \{ background:var\(--fg-40\)/);
    expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.cnpy-fitrun-bar > span \{ transition:none; \} \}/);
    expect(css).not.toContain(".cnpy-fp");
    expect(css).toMatch(/\.cnpy-tagfitline \{[^}]*min-height:28px/);
    expect(block).toMatch(/\.cnpy-fitrun \{[^}]*height:28px/);
  });

  it("in the tag's row: the live view replaces the line while the run is drawn", () => {
    const tag = (name: string): OrgTagDTO => ({ name, description: "", color: "sky", starter: false, retired: false, counts: { feed: 0, doc: 0, adr: 0 } });
    const list: TagListDTO = {
      tags: [...STARTER_TAGS.map((t) => ({ ...tag(t.name), starter: true, color: t.color })), tag("desktop")], used: 7, cap: 30, suggestions: [],
      ai: { enabled: true, available: true, used: 0, cap: 300, spent: false }, runs: { desktop: run({ candidates: 20, checked: 4 }) },
    };
    const ui = { ...initialTagsUi(), live: { desktop: live({ candidates: 20, checked: 4, added: 1, shown: 4 }) } };
    const html = tagsTab({ slug: "acme", name: "Acme", role: "owner" }, { list: { status: "ok", data: list }, ui });
    const row = html.slice(html.indexOf(`data-org-tag="desktop"`));
    expect(row).toContain(`data-fitrun="desktop"`);
    expect(row).toContain("Checked 4 of 20 · 1 added");
    expect(row).not.toContain(`data-act="tagFind" data-arg="desktop"`);
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
