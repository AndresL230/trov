/**
 * The tab icon follows the app's resolved theme (web/src/favicon.ts): the Trov mark,
 * brand purple in light and the dark theme's green in dark, written to the SVG icon link
 * as a data: URL, and only when the theme actually changes.
 */
import { describe, it, expect } from "vitest";
import {
  createFaviconSync, faviconHref, faviconSvg, FAVICON_COLORS, type FaviconDoc,
} from "../web/src/favicon";
import { TROV_MARK_PATH } from "@shared/mark";

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
  it("draws the Trov mark: one path, in the given fill, with air around it", () => {
    const svg = faviconSvg("#616ACB");
    expect(svg).toContain('viewBox="-4 -4 108 108"');
    expect(svg).toContain(`<path fill="#616ACB" d="${TROV_MARK_PATH}"/>`);
    const href = faviconHref("#616ACB");
    expect(href.startsWith("data:image/svg+xml,")).toBe(true);
    expect(href).not.toMatch(/[#<>"]/);
    expect(decodeURIComponent(href.slice("data:image/svg+xml,".length))).toBe(svg);
  });

  it("light is the brand purple; dark is the dark theme's green", () => {
    expect(FAVICON_COLORS).toEqual({ light: "#616ACB", dark: "#9aab65" });
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
