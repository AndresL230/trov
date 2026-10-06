/**
 * The browser-tab icon follows the APP's theme, not the OS's.
 *
 * Two colourways of the Trov mark (shared/mark.ts):
 *   light — the brand purple
 *   dark  — the same mark in the lifted purple
 * web/public/favicon.svg carries both behind `prefers-color-scheme` (right before JS
 * runs); after every paint main.ts calls `syncFavicon` with the resolved app theme,
 * which points the SVG icon link at a `data:` URL of that theme's colourway.
 *
 * Cheap on rerenders: nothing is written until the theme changes.
 */
import { TROV_MARK_COLORS, TROV_MARK_PATH } from "@shared/mark";

export type FaviconTheme = "light" | "dark";

export const FAVICON_COLORS: Record<FaviconTheme, string> = TROV_MARK_COLORS;

/** The mark with a little air around it — geometry identical to web/public/favicon.svg. */
export function faviconSvg(fill: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 108 108"><path fill="${fill}" d="${TROV_MARK_PATH}"/></svg>`;
}

export function faviconHref(fill: string): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(fill))}`;
}

/** The slice of `document` the sync touches (a fake in tests — workerd has no DOM). */
export interface FaviconDoc {
  querySelector(sel: string): { setAttribute(name: string, value: string): void } | null;
  createElement(tag: string): { setAttribute(name: string, value: string): void };
  head: { appendChild(node: never): unknown } | null;
}

/** A sync with its own cache (the app uses the one `syncFavicon` below; tests make fresh ones). */
export function createFaviconSync() {
  let lastTheme: FaviconTheme | null = null;
  let lastHref: string | null = null;
  /** Returns true when the icon link was written. Never throws. */
  return function sync(
    theme: FaviconTheme,
    _root?: Element | null,
    doc: FaviconDoc | undefined = typeof document === "undefined" ? undefined : (document as unknown as FaviconDoc),
  ): boolean {
    if (theme === lastTheme || !doc) return false;
    try {
      const href = faviconHref(FAVICON_COLORS[theme]);
      lastTheme = theme;
      if (href === lastHref) return false;
      let link = doc.querySelector('link[rel="icon"][type="image/svg+xml"]');
      if (!link) {
        if (!doc.head) return false;
        link = doc.createElement("link");
        link.setAttribute("rel", "icon");
        link.setAttribute("type", "image/svg+xml");
        doc.head.appendChild(link as never);
      }
      link.setAttribute("href", href);
      lastHref = href;
      return true;
    } catch {
      return false;
    }
  };
}

export const syncFavicon = createFaviconSync();
