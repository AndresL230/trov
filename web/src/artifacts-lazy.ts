// Artifacts is its own chunk (artifacts.ts; web-ui.md › The app's bundles). render.ts draws the three
// screens through these: the real ones once the chunk is in, a skeleton in the screen's own frame until
// then (a sentence that says to reload, should the chunk fail). main.ts starts the load when a paint
// needs it, runs an `art…` act once it is in, and repaints when it lands. The state, the routes and the
// ticket page's Artifacts block are artifacts-state.ts, in the app's first download.
import type * as ArtifactsModule from "./artifacts";
import { lazyChunk, chunkFailedView } from "./lazy-chunk";
import type { ArtProps } from "./artifacts-state";
import { skeleton, skCard, skLine, skLines, skList, skW, skProse } from "./skeleton";

export const artifactsChunk = lazyChunk<typeof ArtifactsModule>(() => import("./artifacts"));

const SHELL = "width:100%;max-width:1440px;margin:0 auto;padding:26px clamp(20px,2.6 * var(--vw),46px) 100px";
const GRID = "display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:14px;margin-top:18px";

function waiting(p: ArtProps): string {
  if (artifactsChunk.failed()) return `<div style="${SHELL}">${chunkFailedView("Artifacts")}</div>`;
  const body = p.screen === "artifacts"
    ? `<div style="${GRID}">${skList(6, (i) => skCard(`<div style="height:160px;border-bottom:1px solid var(--border);background:var(--bg)"></div><div style="padding:14px 16px">${skLine(skW(i), 14, 1.4)}<div style="margin-top:8px">${skLines(["92%", "60%"], 12, 1.5)}</div></div>`, "padding:0;overflow:hidden"))}</div>`
    : `<div style="max-width:760px">${skLine("48%", 22, 1.3)}<div style="margin-top:22px">${skProse(3)}</div></div>`;
  return `<div style="${SHELL}">${skeleton("artifacts", "Loading Artifacts…", body)}</div>`;
}

export function artifactsView(p: ArtProps): string {
  const m = artifactsChunk.get();
  return m ? m.artifactsView(p) : waiting(p);
}

/** The header's title, crumb and controls: the screen's name until the chunk is in. */
export function artifactsHeader(p: ArtProps): { title: string; crumb: string; controls: string } {
  const m = artifactsChunk.get();
  return m ? m.artifactsHeader(p) : { title: `<h1 style="font-size:15px;font-weight:600;letter-spacing:-0.01em;margin:0">Artifacts</h1>`, crumb: "", controls: "" };
}

/** The screens' dialogs: none can be open before the chunk is in. */
export function artifactsDialogs(p: ArtProps): string {
  const m = artifactsChunk.get();
  return m ? m.artifactsDialogs(p) : "";
}
