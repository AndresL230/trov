/**
 * The browser-tab icon follows the APP's theme, not the OS's.
 *
 * Two fixed colourways of the ORIGINAL Canopy mark (the pre-2026-09-26 favicon.svg,
 * restored at the owner's request — geometry and dark colours exactly as it was):
 *   dark  — the original: electric-green top bar, white bars (bottom at 50%)
 *   light — the same mark with the light theme's indigo accent as the top bar
 * web/public/favicon.svg carries both behind `prefers-color-scheme` (right before JS
 * runs); after every paint main.ts calls `syncFavicon` with the resolved app theme,
 * which points the SVG icon link at a `data:` URL of that theme's colourway.
 *
 * Cheap on rerenders: nothing is written until the theme changes.
 */

export type FaviconTheme = "light" | "dark";
export interface FaviconColors { top: string; ink: string }

export const FAVICON_COLORS: Record<FaviconTheme, FaviconColors> = {
  light: { top: "#5e6ad2", ink: "#FFFFFF" },
  dark: { top: "#2BFF88", ink: "#FFFFFF" },
};

/** The original mark — geometry identical to web/public/favicon.svg. */
export function faviconSvg(c: FaviconColors): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">`
    + `<rect x="2" y="4.5" width="20" height="3.4" rx="1.7" fill="${c.top}"/>`
    + `<rect x="5" y="10.3" width="14" height="3.4" rx="1.7" fill="${c.ink}"/>`
    + `<rect x="8" y="16.1" width="8" height="3.4" rx="1.7" fill="${c.ink}" opacity="0.5"/>`
    + `</svg>`;
}

export function faviconHref(c: FaviconColors): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(c))}`;
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
