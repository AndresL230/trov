/**
 * The big-screen zoom (web/src/zoom.ts, docs/architecture/web-ui.md › Big screens): past a ~3000px window Trov
 * zooms <html>, so a raw viewport unit (zoomed by the browser too) and a getBoundingClientRect() written back
 * into a style would both land 1.3× off. These tests pin the rule, its head copy, and that no raw unit returns.
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import { UI_ZOOM, ZOOM_BOOT, zoomFor, cssPx, rectOf, pointOf } from "../web/src/zoom";

describe("zoomFor — the one rule", () => {
  it("changes nothing at or under 3000px (a laptop, 1440p, a 32\" at 125%)", () => {
    for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080], [2560, 1440], [3000, 2000]]) expect(zoomFor(w, h)).toBe(1);
  });

  it("grows linearly to 1.3 at a 3840px window, and stops there", () => {
    expect(zoomFor(3420, 2160)).toBe(1.15);
    expect(zoomFor(3840, 2160)).toBe(1.3);
    expect(zoomFor(5120, 2880)).toBe(UI_ZOOM.max);
    expect(zoomFor(7680, 4320)).toBe(UI_ZOOM.max);
  });

  it("never leaves less than 900 CSS px of height", () => {
    expect(zoomFor(3840, 1080)).toBe(1.2);
    expect(zoomFor(5120, 1440)).toBe(1.3);
  });

  it("the <head> copy computes exactly what zoomFor does", () => {
    const body = /<script>([\s\S]*)<\/script>/.exec(ZOOM_BOOT)![1];
    for (const [w, h] of [[1440, 900], [3000, 2000], [3001, 2000], [3200, 1800], [3440, 1440], [3840, 2160], [3840, 1080], [5120, 1440]]) {
      const style: Record<string, string> = {};
      const document = { documentElement: { style: { set zoom(v: string) { style.zoom = v; }, setProperty: (k: string, v: string) => { style[k] = v; } } } };
      new Function("innerWidth", "innerHeight", "document", body)(w, h, document);
      const z = zoomFor(w, h);
      expect(style.zoom ?? "1", `${w}×${h}`).toBe(String(z));
      if (z > 1) expect(style["--vu"]).toBe(String(z));
    }
  });
});

describe("the CSS-px helpers are the identity when nothing is zoomed", () => {
  it("rectOf / pointOf / cssPx", () => {
    expect(cssPx(123.5)).toBe(123.5);
    expect(pointOf({ clientX: 10, clientY: 20 })).toEqual({ x: 10, y: 20 });
    const el = { getBoundingClientRect: () => ({ top: 1, left: 2, right: 3, bottom: 4, width: 5, height: 6 }) } as unknown as Element;
    expect(rectOf(el)).toEqual({ top: 1, left: 2, right: 3, bottom: 4, width: 5, height: 6 });
  });
});

describe("viewport units go through --vw / --vh / --dvh", () => {
  const sources = import.meta.glob("../web/src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

  it("trov.css defines them once, divided by the measured --vu", () => {
    expect(css).toContain(":root { --vw:calc(1vw / var(--vu, 1)); --vh:calc(1vh / var(--vu, 1)); --dvh:calc(1dvh / var(--vu, 1)); }");
  });

  it("no raw vw / vh / dvh is left in the app's styles or templates (comments, @supports and <img sizes> aside)", () => {
    const raw = /(^|[^\w.$-])-?\d*\.?\d+(dvh|vh|vw)\b/;
    const offenders: string[] = [];
    const scan = (file: string, text: string) => {
      text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*")) return;
        const clean = line.replace(/sizes="[^"]*"/g, "").replace(/@supports[^{]*/g, "").replace(/--(d?v[wh]):calc\(1d?v[wh] \/ var\(--vu, 1\)\)/g, "");
        if (raw.test(clean)) offenders.push(`${file}:${i + 1}: ${t.slice(0, 120)}`);
      });
    };
    scan("trov.css", css);
    for (const [file, src] of Object.entries(sources)) if (!file.endsWith("/zoom.ts")) scan(file, src);
    expect(offenders).toEqual([]);
  });
});
