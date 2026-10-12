/**
 * WCAG AA contrast, computed from the tokens themselves (web/src/trov.css), in BOTH themes — so a retuned
 * token that drops a pair under AA fails here, not in an audit. docs/architecture/web-ui.md › Contrast.
 *
 *  - Text (1.4.3): 4.5:1 for every token used as text, on --bg and on --surface; a tone also on its own chip
 *    (the app's `tint` idiom: the tone at 12% over the ground) and --accent on --accent-soft; the ink of a
 *    filled control on its fill (--accent-fg on --accent, --red-fg on --red, --p-ink on every person color).
 *  - Non-text (1.4.11): 3:1 for a text field's edge (--border-input) and the focus ring (--focus).
 *  - The brand banner: every white text on it at 4.5:1 at its two light points (the first gradient stop, top
 *    left; the highlight's peak over the middle stop, top right).
 * Alpha tokens are composited over the ground they sit on, as the browser does (sRGB).
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import welcomeSrc from "../web/src/welcome.ts?raw";

type Theme = "light" | "dark";
type RGB = [number, number, number];
type RGBA = [number, number, number, number];

const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every custom property declared on `[data-cnpy-theme="<theme>"] { … }` (the token blocks), var()s resolved. */
function tokens(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  const re = new RegExp(`(?:^|\\n)\\[data-cnpy-theme="${theme}"\\] \\{([^}]*)\\}`, "g");
  for (const m of stripped.matchAll(re)) for (const d of m[1].matchAll(/--([\w-]+):([^;]+);/g)) out[d[1]] = d[2].trim();
  const resolve = (v: string, depth = 0): string => (depth > 5 ? v : v.replace(/var\(--([\w-]+)\)/g, (_, k: string) => resolve(out[k] ?? "", depth + 1)));
  for (const k of Object.keys(out)) out[k] = resolve(out[k]);
  return out;
}

function parse(c: string): RGBA {
  const s = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [...[...m[1]].map((h) => parseInt(h + h, 16)), 1] as RGBA;
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(",").map((x) => parseFloat(x));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  throw new Error(`contrast test: cannot read the colour "${c}"`);
}
/** `fg` (maybe translucent) composited over an opaque `bg`. */
const over = (fg: RGBA, bg: RGB): RGB => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])) as RGB;
const lin = (v: number): number => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: RGB): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
/** WCAG contrast of `fg` drawn on the opaque `bg`. */
function ratio(fg: RGBA, bg: RGB): number {
  const a = lum(over(fg, bg)), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const opaque = (c: RGBA): RGB => [c[0], c[1], c[2]];
const tint = (c: RGBA, pct: number, ground: RGB): RGB => over([c[0], c[1], c[2], pct / 100], ground);

const TEXT = ["fg", "fg-70", "fg-55", "fg-40", "accent", "green", "amber", "blue", "red", "purple"];
const TONES = ["accent", "green", "amber", "blue", "red", "purple"];
const PEOPLE = ["moss", "fern", "sky", "slate", "plum", "rose", "rust", "ochre", "clay", "stone"];

/** Every pair the app draws, with the ratio it must reach. */
function pairs(theme: Theme): { pair: string; fg: RGBA; bg: RGB; min: number }[] {
  const t = tokens(theme);
  const c = (k: string): RGBA => {
    expect(t[k], `--${k} is not defined for ${theme}`).toBeDefined();
    return parse(t[k]);
  };
  const grounds: [string, RGB][] = [["bg", opaque(c("bg"))], ["surface", opaque(c("surface"))]];
  const out: { pair: string; fg: RGBA; bg: RGB; min: number }[] = [];
  for (const [gn, g] of grounds) {
    for (const k of TEXT) out.push({ pair: `--${k} on --${gn}`, fg: c(k), bg: g, min: 4.5 });
    for (const k of TONES) out.push({ pair: `--${k} on its 12% chip over --${gn}`, fg: c(k), bg: tint(c(k), 12, g), min: 4.5 });
    out.push({ pair: `--accent on --accent-soft over --${gn}`, fg: c("accent"), bg: over(c("accent-soft"), g), min: 4.5 });
    for (const p of PEOPLE) out.push({ pair: `--p-${p} (a handle) on --${gn}`, fg: c(`p-${p}`), bg: g, min: 4.5 });
    out.push({ pair: `--border-input on --${gn}`, fg: c("border-input"), bg: g, min: 3 });
    out.push({ pair: `--focus on --${gn}`, fg: c("focus"), bg: g, min: 3 });
  }
  out.push({ pair: "--accent-fg on --accent", fg: c("accent-fg"), bg: opaque(c("accent")), min: 4.5 });
  out.push({ pair: "--red-fg on --red", fg: c("red-fg"), bg: opaque(c("red")), min: 4.5 });
  for (const p of PEOPLE) out.push({ pair: `--p-ink on --p-${p} (avatar initials)`, fg: c("p-ink"), bg: opaque(c(`p-${p}`)), min: 4.5 });
  return out;
}

describe("contrast — every text and control token meets WCAG AA (web/src/trov.css)", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`${theme}: text 4.5:1, field edges and focus 3:1`, () => {
      const failing = pairs(theme).map((p) => ({ ...p, r: ratio(p.fg, p.bg) })).filter((p) => p.r < p.min);
      expect(failing.map((p) => `${p.pair}: ${p.r.toFixed(2)} < ${p.min}`)).toEqual([]);
    });
  }

  it("reads both themes' full token sets (the parser found what it checks)", () => {
    for (const theme of ["light", "dark"] as const) {
      const t = tokens(theme);
      for (const k of [...TEXT, "bg", "surface", "accent-soft", "accent-fg", "red-fg", "border-input", "focus", "p-ink", ...PEOPLE.map((p) => `p-${p}`)]) {
        expect(t[k], `${theme} --${k}`).toMatch(/^(#[0-9a-fA-F]{3,6}|rgba?\([^)]+\))$/);
      }
    }
  });

  it("the filled controls and avatars use the ink tokens, never a literal white", () => {
    const sources = import.meta.glob("../web/src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    for (const [file, src] of Object.entries(sources)) {
      expect(src, file).not.toMatch(/background:var\(--red\);color:#fff/);
      expect(src, file).not.toMatch(/background:var\(--p-[^)]+\)[^"`]*color:#fff\b/);
      expect(src, file).not.toMatch(/background:var\(--c\)[^"`]*color:#fff\b/);
    }
  });

  describe("the brand banner (.site-banner / .cnpy-orgs-banner)", () => {
    // The light banner is the base rule; the dark one is its [data-cnpy-theme="dark"] override.
    const base = /\.cnpy-orgs-banner, \.site-banner \{[^}]*background:([^;]+);/.exec(stripped)?.[1];
    const dark = /\[data-cnpy-theme="dark"\] \.site-banner, \[data-cnpy-theme="dark"\] \.cnpy-orgs-banner \{[^}]*background:([^;]+);/.exec(stripped)?.[1];
    const read = (bg: string | undefined) => {
      expect(bg, "banner background not found").toBeDefined();
      const glow = Number(/radial-gradient\([^,]+, rgba\(255,255,255,([.\d]+)\) 0%/.exec(bg!)?.[1]);
      const stops = [...(/linear-gradient\(135deg, ([^)]+)\)/.exec(bg!)?.[1] ?? "").matchAll(/(#[0-9a-f]{6}) \d+%/gi)].map((m) => opaque(parse(m[1])));
      expect(glow).toBeGreaterThan(0);
      expect(stops).toHaveLength(3);
      // The two light points: the first stop (top left — the highlight has faded out there) and the
      // highlight's peak over the middle stop (top right).
      return [stops[0], over([255, 255, 255, glow], stops[1])];
    };
    // Every text the banner carries, and how white it is.
    const TEXT_ON_BANNER = [
      ".site-legal-tab", ".site-legal-lede", ".site-legal-date", ".site-plan.is-top .site-plan-name",
      ".site-plan.is-top .site-plan-tba, .site-plan.is-top .site-plan-per", ".site-plan.is-top .site-plan-limits",
      ".site-hero-lede", ".site-hero-note", ".site-split-banner p", ".cnpy-onb-step", ".cnpy-orgs-lede",
      ".cnpy-orgs-banner .cnpy-mutelink",
    ];
    const alphaOf = (sel: string): number => {
      const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const a = new RegExp(`(?:^|\\n)${esc} \\{[^}]*[^-]color:rgba\\(255,255,255,([.\\d]+)\\)`).exec(stripped)?.[1];
      expect(a, `no white text colour for ${sel}`).toBeDefined();
      return Number(a);
    };
    for (const [theme, bg] of [["light", base], ["dark", dark]] as const) {
      it(`${theme}: every text on it reads at 4.5:1 at its lightest points`, () => {
        const points = read(bg);
        const failing: string[] = [];
        for (const sel of ["(headline, #fff)", ...TEXT_ON_BANNER]) {
          const a = sel.startsWith("(") ? 1 : alphaOf(sel);
          for (const p of points) {
            const r = ratio([255, 255, 255, a], p);
            if (r < 4.5) failing.push(`${sel} at ${a}: ${r.toFixed(2)}`);
          }
        }
        expect(failing).toEqual([]);
      });
    }
    it("the welcome card's eyebrow, written inline, is as white as the rest", () => {
      for (const m of welcomeSrc.matchAll(/color:rgba\(255,255,255,([.\d]+)\)/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(0.92);
    });
  });
});
