/**
 * The tab icon follows the app's resolved theme (web/src/favicon.ts): the ORIGINAL
 * three-bar mark — dark in its original electric-green/white colourway, light the same mark
 * with the indigo accent on top — written to the SVG icon link as a data: URL, and
 * only when the theme actually changes.
 */
import { describe, it, expect } from "vitest";
import {
  createFaviconSync, faviconHref, faviconSvg, FAVICON_COLORS, type FaviconDoc,
} from "../web/src/favicon";

function fakeDoc(withLink = true) {
  const writes: string[] = [];
  const appended: unknown[] = [];
  const mk = () => {
    const attrs: Record<string, string> = {};
    return { attrs, setAttribute(n: string, v: string) { attrs[n] = v; if (n === "href") writes.push(v); } };
  };
  const link = withLink ? mk() : null;
  const doc: FaviconDoc = {
    querySelector: (sel) => (sel === 'link[rel="icon"][type="image/svg+xml"]' ? link : null),
    createElement: () => mk(),
    head: { appendChild: (n: never) => { appended.push(n); return n; } },
  };
  return { doc, writes, appended };
}

describe("favicon — follows the app theme", () => {
  it("draws the original mark: the top bar, then the two ink bars, the bottom at 50%", () => {
    const svg = faviconSvg({ top: "#5e6ad2", ink: "#16161a" });
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('<rect x="2" y="4.5" width="20" height="3.4" rx="1.7" fill="#5e6ad2"/>');
    expect(svg).toContain('<rect x="5" y="10.3" width="14" height="3.4" rx="1.7" fill="#16161a"/>');
    expect(svg).toContain('<rect x="8" y="16.1" width="8" height="3.4" rx="1.7" fill="#16161a" opacity="0.5"/>');
    const href = faviconHref({ top: "#5e6ad2", ink: "#16161a" });
    expect(href.startsWith("data:image/svg+xml,")).toBe(true);
    expect(href).not.toMatch(/[#<>"]/);
    expect(decodeURIComponent(href.slice("data:image/svg+xml,".length))).toBe(svg);
  });

  it("dark is the original colourway; light is its purple variant", () => {
    expect(FAVICON_COLORS.dark).toEqual({ top: "#2BFF88", ink: "#FFFFFF" });
    expect(FAVICON_COLORS.light).toEqual({ top: "#5e6ad2", ink: "#FFFFFF" });
  });

  it("writes the link once per theme change — rerenders on the same theme are no-ops", () => {
    const sync = createFaviconSync();
    const { doc, writes } = fakeDoc();
    expect(sync("light", null, doc)).toBe(true);
    expect(sync("light", null, doc)).toBe(false);
    expect(sync("light", null, doc)).toBe(false);
    expect(sync("dark", null, doc)).toBe(true);
    expect(sync("dark", null, doc)).toBe(false);
    expect(sync("light", null, doc)).toBe(true);
    expect(writes).toEqual([
      faviconHref(FAVICON_COLORS.light), faviconHref(FAVICON_COLORS.dark), faviconHref(FAVICON_COLORS.light),
    ]);
  });

  it("creates the icon link when the page has none, and never throws without a document", () => {
    const sync = createFaviconSync();
    const { doc, appended } = fakeDoc(false);
    expect(sync("dark", null, doc)).toBe(true);
    expect(appended).toHaveLength(1);
    expect((appended[0] as { attrs: Record<string, string> }).attrs).toMatchObject({ rel: "icon", type: "image/svg+xml" });
    expect(() => createFaviconSync()("light", null, undefined)).not.toThrow();
  });
});
