// Org settings is its own chunk (org-chunk.ts; web-ui.md › The app's bundles). render.ts draws the
// screen through these: the real one once the chunk is in, a skeleton in the screen's own frame until
// then (a sentence that says to reload, should the chunk fail). main.ts starts the load with the
// controller's first read and repaints when it lands. The state is org-core.ts, in the first download.
import type * as OrgChunk from "./org-chunk";
import type { OrgSettingsProps } from "./org-core";
import { lazyChunk, chunkFailedView } from "./lazy-chunk";
import { skeleton, skBar, skList, skRowsShape, skW } from "./skeleton";

export const orgChunk = lazyChunk<typeof OrgChunk>(() => import("./org-chunk"));

const shell = (inner: string): string => `<div data-screen-label="Org settings" class="cnpy-org" style="width:100%;max-width:1180px;margin:0 auto;padding:18px clamp(20px,2.6vw,46px) 100px;box-sizing:border-box">${inner}</div>`;

export function orgSettingsView(p: OrgSettingsProps): string {
  const m = orgChunk.get();
  if (m) return m.orgSettingsView(p);
  if (orgChunk.failed()) return shell(chunkFailedView("Org settings"));
  const tabs = `<div style="display:flex;gap:22px;padding-bottom:12px;border-bottom:1px solid var(--border)">${skList(6, (i) => skBar(skW(i, [72, 88, 64, 80]), 11))}</div>`;
  return shell(skeleton("org-settings", "Loading Org settings…", `${tabs}<div style="padding-top:18px">${skRowsShape(4, { trail: 84 })}</div>`));
}

/** The screen's dialogs: none can be open before the chunk is in. */
export function orgOverlays(p: OrgSettingsProps): string {
  const m = orgChunk.get();
  return m ? m.orgOverlays(p) : "";
}
