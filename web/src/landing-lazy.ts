// In the app, the landing is its own chunk (landing.ts with its mockups; web-ui.md › The app's bundles):
// a signed-in person never downloads it unless they reopen it (the sidebar logo, `#site`), and a
// signed-out visit to an app address (a deep link, an expired session) loads it then. The signed-out
// page at `/` does not come through here at all: its own boot (landing-page.ts) carries the landing.
// Until the chunk is in, the page is an empty main region in the app's colours; main.ts starts the load
// when a paint needs it and repaints when it lands. The build hands the module in (site-prerender.ts).
import type * as LandingModule from "./landing";
import type { LandingProps } from "./landing";
import { lazyChunk, chunkFailedView } from "./lazy-chunk";

export const landingChunk = lazyChunk<typeof LandingModule>(() => import("./landing"));

export function landingView(p: LandingProps): string {
  const m = landingChunk.get();
  if (m) return m.landingView(p);
  return `<div role="main" aria-busy="true" style="min-height:calc(100 * var(--vh))">${landingChunk.failed() ? chunkFailedView("This page") : ""}</div>`;
}
