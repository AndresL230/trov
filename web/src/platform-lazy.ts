// Platform (superadmin) is its own chunk (platform-chunk.ts; web-ui.md › The app's bundles). render.ts
// draws the area through these: the real views once the chunk is in, a skeleton in the area's own
// frame until then, and — should the chunk fail to load — a sentence that says to reload. main.ts
// starts the load (with the controller's first read) and repaints when it lands.
import type * as PlatformChunk from "./platform-chunk";
import type { DropdownUi } from "./dropdown";
import { lazyChunk, chunkFailedView } from "./lazy-chunk";
import { platformPageShell, type PlatState } from "./platform-core";
import { skeleton, skRowsShape } from "./skeleton";

export const platformChunk = lazyChunk<typeof PlatformChunk>(() => import("./platform-chunk"));

const FRAME = "width:100%;max-width:1180px;margin:0 auto;padding:18px clamp(20px,2.6 * var(--vw),46px) 100px;box-sizing:border-box";
const waiting = (label: string): string => `<div class="plat" data-screen-label="${label}" style="${FRAME}">${platformChunk.failed()
  ? chunkFailedView("Platform")
  : skeleton("platform", "Loading Platform…", skRowsShape(6, { trail: 72 }))}</div>`;

export function platformView(p: PlatState, me: string | null = null, dd?: DropdownUi): string {
  const m = platformChunk.get();
  return m ? m.platformView(p, me, dd) : waiting("Platform");
}

export function platformOrgView(p: PlatState): string {
  const m = platformChunk.get();
  return m ? m.platformOrgView(p) : waiting("Platform organization");
}

/** The area's dialogs: none can be open before the chunk is in. */
export function platformDialogs(p: PlatState, screen: string, dd?: DropdownUi): string {
  const m = platformChunk.get();
  return m ? m.platformDialogs(p, screen, dd) : "";
}

export function platformPage(p: PlatState, screen: string, me: string | null, dd?: DropdownUi): string {
  const m = platformChunk.get();
  return m ? m.platformPage(p, screen, me, dd) : platformPageShell(p, screen, waiting(screen === "platformorg" ? "Platform organization" : "Platform"));
}
