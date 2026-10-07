/**
 * The underline tab bar (web/src/tabs.ts) — page-level navigation between a screen's
 * sections: text tabs on a full-width hairline, the picked tab's 2px accent underline
 * sliding between tabs. Pure markup + the key map here; the CSS contract and the wiring
 * in main.ts are pinned by reading the sources.
 */
import { describe, it, expect } from "vitest";
import { tabBar, tabPanelAttrs, tabKeyTarget } from "../web/src/tabs";
import css from "../web/src/trov.css?raw";
import mainSrc from "../web/src/main.ts?raw";

const bar = (value = "b") => tabBar({
  id: "demo", ariaLabel: "Demo sections", act: "setDemo", value,
  tabs: [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta & co", trail: '<span class="cnpy-badge" data-n="2">2</span>' },
    { value: "c", label: "Gamma" },
  ],
});

describe("tabBar — markup and semantics", () => {
  it("is a labelled tablist carrying ONE indicator, then the tabs in order", () => {
    const html = bar();
    expect(html).toMatch(/^<div class="cnpy-tabs" data-tabs="demo" role="tablist" aria-label="Demo sections"><span class="cnpy-tabs-ind" aria-hidden="true"><\/span><button/);
    expect(html.match(/role="tab"/g)?.length).toBe(3);
    expect(html.indexOf(">Alpha<")).toBeLessThan(html.indexOf(">Beta &amp; co<"));
    expect(html.indexOf(">Beta &amp; co<")).toBeLessThan(html.indexOf(">Gamma<"));
  });

  it("marks the picked tab selected, inert and the one Tab stop; the others dispatch the act", () => {
    const html = bar("b");
    expect(html).toContain('<button type="button" role="tab" id="demo-b" class="cnpy-tab is-on" aria-selected="true" aria-controls="demo-panel" tabindex="0" data-field="tab:demo:b">');
    expect(html).not.toContain('data-arg="b"');
    expect(html).toContain('id="demo-a" class="cnpy-tab" data-act="setDemo" data-arg="a" aria-selected="false" aria-controls="demo-panel" tabindex="-1"');
    expect(html).toContain('id="demo-c" class="cnpy-tab" data-act="setDemo" data-arg="c" aria-selected="false"');
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1);
  });

  it("puts a tab's trail (a count badge) after its label, inside the tab", () => {
    expect(bar()).toContain('>Beta &amp; co<span class="cnpy-badge" data-n="2">2</span></button>');
  });

  it("labels the panel by the picked tab", () => {
    expect(tabPanelAttrs("demo", "c")).toBe(' role="tabpanel" id="demo-panel" aria-labelledby="demo-c"');
  });
});

describe("tabKeyTarget — the keyboard", () => {
  it("steps with ←/→, wrapping at either end", () => {
    expect(tabKeyTarget("ArrowRight", 0, 3)).toBe(1);
    expect(tabKeyTarget("ArrowRight", 2, 3)).toBe(0);
    expect(tabKeyTarget("ArrowLeft", 1, 3)).toBe(0);
    expect(tabKeyTarget("ArrowLeft", 0, 3)).toBe(2);
  });

  it("jumps with Home/End", () => {
    expect(tabKeyTarget("Home", 2, 3)).toBe(0);
    expect(tabKeyTarget("End", 0, 3)).toBe(2);
  });

  it("ignores every other key and a tab it cannot place", () => {
    expect(tabKeyTarget("Enter", 1, 3)).toBeNull();
    expect(tabKeyTarget("ArrowDown", 1, 3)).toBeNull();
    expect(tabKeyTarget("ArrowRight", -1, 3)).toBeNull();
    expect(tabKeyTarget("ArrowRight", 0, 0)).toBeNull();
  });

  it("is wired once on the mount, and the slide runs after every paint and on resize / font load", () => {
    expect(mainSrc).toContain('mount.addEventListener("keydown", onTabBarKey);');
    expect(mainSrc).toMatch(/syncSegments\(mount\);\s*syncTabBars\(mount\);/);
    expect(mainSrc).toContain("syncTabBars(mount, { instant: true })");
  });
});

describe("tabBar — the CSS contract", () => {
  const rule = (sel: string) => css.match(new RegExp(`${sel.replace(/[.[\]()>-]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

  it("draws the hairline across the bar and scrolls a too-wide row inside it, never the page", () => {
    const r = rule(".cnpy-tabs");
    expect(r).toContain("box-shadow:inset 0 -1px 0 var(--border)");
    expect(r).toContain("overflow-x:auto");
    expect(r).toContain("scrollbar-width:none");
  });

  it("gives every tab the same 40px height (a tap target; a badge never makes one taller), no pill or box", () => {
    const r = rule(".cnpy-tab");
    expect(r).toContain("height:40px");
    expect(r).toContain("flex:none");
    expect(r).not.toContain("border-radius");
    expect(r).not.toContain("background");
  });

  it("underlines the picked tab with a 2px accent that sits on the hairline, then hands it to the sliding indicator", () => {
    expect(rule(".cnpy-tab.is-on")).toContain("box-shadow:inset 0 -2px 0 var(--accent)");
    expect(rule(".cnpy-tabs.is-live > .cnpy-tab.is-on")).toContain("box-shadow:none");
    const ind = rule(".cnpy-tabs-ind");
    expect(ind).toContain("bottom:0");
    expect(ind).toContain("height:2px");
    expect(ind).toContain("background:var(--accent)");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.cnpy-tabs-ind\.is-sliding \{ transition:none; \}/);
  });

  it("brightens the picked tab's badge like the sidebar's active row", () => {
    expect(css).toContain(".cnpy-navrow.is-active .cnpy-badge, .cnpy-tab.is-on > .cnpy-badge {");
  });
});
