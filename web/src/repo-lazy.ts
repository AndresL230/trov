// The Repo screen is its own chunk (repo.ts and its blocks; web-ui.md › The app's bundles). render.ts
// draws it through these: the real screen once the chunk is in, a skeleton in the screen's own frame
// until then (a sentence that says to reload, should the chunk fail). main.ts starts the load when a
// paint needs it and repaints when it lands. What main.ts needs eagerly is repo-core.ts.
import type * as RepoModule from "./repo";
import type { RepoProps } from "./repo";
import type { DropdownProps } from "./dropdown";
import { lazyChunk, chunkFailedView } from "./lazy-chunk";
import { esc } from "./ui";
import { skeleton, skBar, skCard, skList, skW } from "./skeleton";

export const repoChunk = lazyChunk<typeof RepoModule>(() => import("./repo"));

const FRAME = "max-width:var(--frame-dash);margin:0 auto;padding:22px 32px 36px";

export function repoView(p: RepoProps): string {
  const m = repoChunk.get();
  if (m) return m.repoView(p);
  if (repoChunk.failed()) return `<div style="${FRAME}">${chunkFailedView("Repo")}</div>`;
  const card = (i: number) => skCard(`${skBar(skW(i, [140, 180, 120]), 11)}<div style="margin-top:14px">${skBar("100%", 64)}</div>`, "padding:18px 20px");
  return `<div style="${FRAME}">${skeleton("repo", "Loading Repo…", `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr));gap:14px">${skList(4, card)}</div>`)}</div>`;
}

/** The header's controls: none until the chunk is in. */
export function repoControls(p: RepoProps): string {
  const m = repoChunk.get();
  return m ? m.repoControls(p) : "";
}

/** The header's crumb: the repository's slug until the chunk is in (repo.ts `repoCrumb`'s own fallback). */
export function repoCrumb(p: RepoProps): string {
  const m = repoChunk.get();
  if (m) return m.repoCrumb(p);
  const slug = p.repo.data?.repo ?? "";
  return slug
    ? `<span style="font-family:var(--label);font-size:11px;color:var(--fg-40);white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(slug)}</span>`
    : "";
}

/** The screen's dropdowns: none can be open before the chunk is in. */
export function repoDropdowns(p: RepoProps): DropdownProps[] {
  const m = repoChunk.get();
  return m ? m.repoDropdowns(p) : [];
}

/** Needs attention's dialog (repo.ts `repoAttentionOverlay`): none before the chunk is in. */
export function repoAttentionOverlay(p: RepoProps): string {
  const m = repoChunk.get();
  return m ? m.repoAttentionOverlay(p) : "";
}
