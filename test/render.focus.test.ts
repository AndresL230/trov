/**
 * Every interactive element shows where keyboard focus is (WCAG 2.4.7), with a ring of 3:1 or more against
 * what it sits on (1.4.11; --focus's ratio is held by test/render.contrast.test.ts). docs/architecture/web-ui.md
 * › Focus. Text fields are the hard case: their border and `outline:none` are INLINE styles in the templates,
 * which only `!important` outranks — so the ring is one rule in trov.css that every field matches.
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import { newDocView, blankDoc } from "../web/src/newdoc";
import { initialDropdownUi } from "../web/src/dropdown";
import { newSprintPanel, type NewSprintState } from "../web/src/sprints";
import { segmented, segKeyTarget, type SegOption } from "../web/src/segmented";
import mainSrc from "../web/src/main.ts?raw";
import { twinSelector } from "../web/src/focus-twin";

const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
/** [selector, declarations] of every top-level or nested rule. */
const rules = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]] as const);
const focusRules = rules.filter(([sel]) => /:focus(-visible|-within)?\b/.test(sel));
const FIELD_TYPES_SKIPPED = ["checkbox", "radio", "range", "file", "color", "hidden", "button", "submit", "reset", "image"];

const SPACE_PRODUCT = { slug: "product", name: "Product", icon: "compass", color: "#2f7d57", description: "", sort_rank: 1024, created_at: "t", created_by: "system", archived: false, archived_at: null, owners: [], pages: 0, waiting: 0 } as unknown as import("@shared/docs-core").SpaceDTO;

describe("focus — every focusable element shows a ring", () => {
  it("no :focus rule takes the outline away", () => {
    const bare = focusRules.filter(([, body]) => /outline:\s*(none|0)\b/.test(body)).map(([sel]) => sel);
    expect(bare).toEqual([]);
  });

  it("every focus ring is a 2px line in a colour that holds 3:1 where it is drawn", () => {
    const OK = /^(var\(--focus\)|var\(--accent\)|var\(--red\)|#fff|#faf8f3)$/;
    for (const [sel, body] of focusRules) {
      const outline = /(?:^|;)\s*outline:\s*([^;]+)/.exec(body)?.[1];
      if (outline) {
        const m = /^(\d+)px solid (.+)$/.exec(outline.trim());
        expect(m, `${sel}: outline:${outline}`).not.toBeNull();
        expect(Number(m![1]), sel).toBeGreaterThanOrEqual(2);
        expect(m![2].trim(), sel).toMatch(OK);
      }
      const color = /outline-color:\s*([^;]+)/.exec(body)?.[1];
      if (color) expect(color.trim(), sel).toMatch(OK);
    }
  });

  it("the three menu / option rows that only tinted now draw the ring", () => {
    for (const sel of [".cnpy-avmenu .cnpy-menurow:focus-visible", ".cnpy-dd-opt:focus-visible", ".cnpy-sfbar .fm-btn:focus-visible"]) {
      const r = focusRules.find(([s]) => s === sel);
      expect(r, sel).toBeDefined();
      expect(r![1]).toMatch(/outline:2px solid var\(--focus\)/);
    }
  });

  it("text fields: --border-input edge and a --focus ring, both !important (their styles are inline)", () => {
    const field = rules.find(([sel, body]) => sel.includes(":is(input:not(") && sel.endsWith(":not([aria-invalid=\"true\"])") && body.includes("border-color:var(--border-input) !important"));
    const focused = rules.find(([sel, body]) => sel.includes(":is(input:not(") && sel.endsWith(":focus-visible") && body.includes("border-color:var(--focus) !important") && body.includes("box-shadow:0 0 0 1px var(--focus) !important"));
    expect(field).toBeDefined();
    expect(focused).toBeDefined();
    for (const t of FIELD_TYPES_SKIPPED) expect(field![0]).toContain(`[type="${t}"]`);
    // A borderless field inside a bordered box puts the edge and the ring on the box.
    expect(rules.some(([sel, body]) => sel.includes(':has(> :is(input, textarea)[style*="border:none"]:focus-visible)') && body.includes("box-shadow:0 0 0 1px var(--focus) !important"))).toBe(true);
  });

  it("the New sprint form and the New doc body are fields the ring covers (they had none)", () => {
    const NS: NewSprintState = { open: true, name: "", start: "", desc: "", urgency: "normal", due: "", lead: null, domain: null, error: null };
    const doc = newDocView({ draft: { ...blankDoc("product"), step: "details" }, spaces: [SPACE_PRODUCT], pages: [], sections: ["reference"], dd: initialDropdownUi() });
    const fields = [...newSprintPanel(NS, []).matchAll(/<(input|textarea)\b[^>]*>/g), ...doc.matchAll(/<(input|textarea)\b[^>]*>/g)].map((m) => m[0]);
    expect(fields.some((f) => f.includes('data-arg="body"'))).toBe(true);
    expect(fields.some((f) => f.includes('data-arg="name"'))).toBe(true);
    for (const f of fields) {
      const type = /\stype="([^"]+)"/.exec(f)?.[1];
      if (type) expect(FIELD_TYPES_SKIPPED, f).not.toContain(type);
      expect(f, "a bordered field, so the field rule (not the box rule) draws its ring").not.toContain("border:none");
      expect(f).toMatch(/border:1px solid var\(--border-strong\)/); // the inline edge the !important rule recolours
    }
  });
});

describe("segmented() — one Tab stop, on the picked option (a roving tabindex)", () => {
  const opts: SegOption[] = [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }, { value: "c", label: "Gamma" }];
  const stops = (html: string) => [...html.matchAll(/<button type="button" tabindex="(-?\d)"[^>]*>([^<]+)</g)].map((m) => `${m[2]}:${m[1]}`);

  it("the picked option is tabindex 0 and every other option -1 — Tab lands on the picked one, not the first", () => {
    expect(stops(segmented({ id: "x", ariaLabel: "X", act: "pick", value: "b", options: opts }))).toEqual(["Alpha:-1", "Beta:0", "Gamma:-1"]);
    expect(stops(segmented({ id: "x", ariaLabel: "X", act: "pick", value: "c", options: opts }))).toEqual(["Alpha:-1", "Beta:-1", "Gamma:0"]);
    // An inert picked option (no act) is still the stop.
    expect(stops(segmented({ id: "x", ariaLabel: "X", act: "pick", value: "b", options: opts, inertOn: true }))).toEqual(["Alpha:-1", "Beta:0", "Gamma:-1"]);
  });

  it("with nothing pickable picked, the stop is the first option that is not locked", () => {
    expect(stops(segmented({ id: "x", ariaLabel: "X", act: "pick", value: "zzz", options: opts }))).toEqual(["Alpha:0", "Beta:-1", "Gamma:-1"]);
    const locked = [{ ...opts[0], locked: true }, opts[1], opts[2]];
    expect(stops(segmented({ id: "x", ariaLabel: "X", act: "pick", value: "a", options: locked }))).toEqual(["Alpha:-1", "Beta:0", "Gamma:-1"]);
  });

  it("←/→ step through the options that are not locked, wrapping; Home/End jump; other keys are not the switch's", () => {
    const off = [false, false, false];
    expect(segKeyTarget("ArrowRight", 0, off)).toBe(1);
    expect(segKeyTarget("ArrowRight", 2, off)).toBe(0);
    expect(segKeyTarget("ArrowLeft", 0, off)).toBe(2);
    expect(segKeyTarget("Home", 2, off)).toBe(0);
    expect(segKeyTarget("End", 0, off)).toBe(2);
    expect(segKeyTarget("Enter", 1, off)).toBeNull();
    expect(segKeyTarget("ArrowDown", 1, off)).toBeNull();
    // A locked (disabled) option is skipped.
    expect(segKeyTarget("ArrowRight", 0, [false, true, false])).toBe(2);
    expect(segKeyTarget("Home", 2, [true, false, false])).toBe(1);
    expect(segKeyTarget("ArrowRight", 0, [false, true, true])).toBe(0);
  });

  it("each option names itself for the repaint's focus restore (data-field), unique per switch and option", () => {
    const html = segmented({ id: "x", ariaLabel: "X", act: "pick", value: "b", options: opts })
      + segmented({ id: "y", ariaLabel: "Y", act: "pick", value: "a", options: opts });
    const fields = [...html.matchAll(/<button type="button" tabindex="-?\d" data-field="([^"]+)"/g)].map((m) => m[1]);
    expect(fields).toEqual(["seg:x:a", "seg:x:b", "seg:x:c", "seg:y:a", "seg:y:b", "seg:y:c"]);
    expect(new Set(fields).size).toBe(fields.length);
    // Enter / Space on an option repaints; focus comes back to the same option — now the picked one.
    const after = segmented({ id: "x", ariaLabel: "X", act: "pick", value: "c", options: opts });
    expect(after).toMatch(/<button type="button" tabindex="0" data-field="seg:x:c" class="cnpy-seg-btn is-on"/);
  });

  it("rerender() puts focus back on whatever element carries the focused data-field (not only text fields)", () => {
    expect(mainSrc).toContain('const field = active?.getAttribute?.("data-field") ?? null;');
    expect(mainSrc).toMatch(/if \(field\) \{\s*const el = mount\.querySelector<[^>]+>\(`\[data-field="\$\{field\}"\]`\);[\s\S]{0,200}el\.focus\(\);/);
  });

  it("the keyboard is wired once, for every switch on the page", () => {
    expect(mainSrc).toContain('document.addEventListener("keydown", onSegmentedKey);');
  });
});

// P04 (docs/testing/10-17-batch-test-log.md): Enter on a Prompt Library card's copy button copied the slug, and the toast's
// repaint swapped <main> and dropped focus on <body> — the next Tab started over at the top of the page. A focused BUTTON
// now finds its twin in the new <main> by `data-act` + `data-arg`, as a focused field already did by `data-field`.
describe("a repaint keeps a focused button focused (its twin in the new page)", () => {
  it("names the twin by its act and arg — an act alone only matches a twin without an arg", () => {
    expect(twinSelector({ act: "promptCopySlug", arg: "test-copy-published" })).toBe('[data-act="promptCopySlug"][data-arg="test-copy-published"]');
    expect(twinSelector({ act: "newPrompt", arg: null })).toBe('[data-act="newPrompt"]:not([data-arg])');
  });
  it("quotes and backslashes in an arg cannot break out of the selector", () => {
    const sel = twinSelector({ act: "x", arg: 'a"b\\c' });
    expect(sel).toBe('[data-act="x"][data-arg="a\\"b\\\\c"]');
  });
  it("nothing to pair on: no act, no twin", () => {
    expect(twinSelector({ act: null, arg: "a" })).toBeNull();
    expect(twinSelector({ act: "", arg: null })).toBeNull();
  });
  it("rerender restores it last, only when focus was lost and the screen did not change", () => {
    expect(mainSrc).toMatch(/twinSelector\(\{ act: focusAct, arg: active\?\.getAttribute\?\.\("data-arg"\) \?\? null \}\)/);
    expect(mainSrc).toContain("restoreTwinFocus(twin, screenBefore)");
  });
});
