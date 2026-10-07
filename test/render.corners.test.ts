/**
 * Trov's corners are tighter than the design file's: ONE block at the end of
 * web/src/trov.css shrinks every radius by one factor, --corner-scale. It has to
 * use !important and key inline radii by value, because nearly every radius in the
 * app is an INLINE style — so a radius nobody gave a rule silently renders square.
 * These tests pin the block's shape and that every radius in use has a rule.
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";

describe("corners — the tightened-radius layer (web/src/trov.css)", () => {
  // The block from its header on, comments stripped.
  const block = css.slice(css.indexOf("/* ── corners: tightened")).replace(/\/\*[\s\S]*?\*\//g, "");
  const design = css.slice(0, css.indexOf("/* ── corners: tightened")).replace(/\/\*[\s\S]*?\*\//g, "");
  const sources = import.meta.glob("../web/src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

  it("zeroes everything first with !important (the radii are inline styles), then scales by one factor", () => {
    expect(block).toMatch(/\[data-cnpy-theme\] \*,\s*\[data-cnpy-theme\] \*::before,\s*\[data-cnpy-theme\] \*::after \{ border-radius:0 !important; \}/);
    expect(block).toMatch(/\[data-cnpy-theme\] \{ --corner-scale:[0-9.]+; \}/);
  });

  it("has a scaled rule for every inline radius the templates use — an unlisted one would fall back to square", () => {
    const used = new Set<string>();
    for (const src of Object.values(sources)) for (const m of src.matchAll(/border-radius:(\d+px|\d+%)/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(10);
    for (const v of used) {
      const rule = new RegExp(`\\[style\\*="border-radius:${v}"\\][^{]*\\{ border-radius:([^;]+) !important; \\}`);
      const got = block.match(rule)?.[1];
      expect(got, `no corners rule for inline border-radius:${v}`).toBeDefined();
      if (v === "50%" || v === "999px") expect(got).toBe("min(calc(12px * var(--corner-scale)), 25%)");
      else expect(got).toBe(`calc(${v} * var(--corner-scale))`);
    }
  });

  it("has a rule for every class in trov.css that declares a radius", () => {
    for (const m of design.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const radius = m[2].match(/border-radius:\s*([^;]+)/)?.[1].trim();
      if (!radius || radius === "0" || radius === "inherit") continue;
      for (const sel of m[1].split(",").map((x) => x.trim().replace(/\s+/g, " "))) {
        expect(block, `no corners rule for ${sel} (border-radius:${radius})`).toContain(`[data-cnpy-theme] ${sel}`);
      }
    }
  });

  it("keeps a square edge square: the code block's inner pre, the quote's ruled side, the selection bar's inherit", () => {
    expect(block).toContain('[data-cnpy-theme] .cnpy-md .cnpy-code pre { border-radius:0 !important; }');
    expect(block).toContain("border-radius:0 calc(8px * var(--corner-scale)) calc(8px * var(--corner-scale)) 0 !important;");
    expect(block).toContain('[data-cnpy-theme] .cnpy-selbar { border-radius:inherit !important; }');
  });
});
