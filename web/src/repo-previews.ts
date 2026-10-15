// Repo › Overview — the Previews list under the Production card (rule R4; the design's `PreviewsList.dc.html`
// + `previewsModel`, repo-data.js): one row per open pull request's preview — who, the PR and its branch, its
// state (a live preview has no mark; failed and building do), how long its builds have failed, a link to it,
// and its age. An app with no previews draws nothing; one with previews and no open PR says so.
import type { FactsPreview } from "@shared/repo-facts-core";
import { esc, attr } from "./ui";
import { personAvatarLink } from "./people";
import { ago } from "./repo";
import type { OverviewBlock, OverviewCtx } from "./repo-overview-ctx";
import { LABEL, agoWords, bareUrl, deployMark, outLink, personFor } from "./repo-block-kit";

/** "Failing for 3 days, last 4 builds" — only for a streak of two or more (one failure is just "Failed"). */
export function failingSince(p: FactsPreview, now: number): string | null {
  return p.failStreak >= 2 && p.failingSince ? `Failing for ${agoWords(p.failingSince, now)}, last ${p.failStreak} builds` : null;
}

function stateOf(p: FactsPreview): string {
  switch (p.state) {
    case "error": return deployMark("failed");
    case "building": return deployMark("building");
    case "queued": return deployMark("queued");
    case "canceled": return deployMark("cancelled");
    default: return ""; // live: the normal state has no mark
  }
}

function previewRow(p: FactsPreview, x: OverviewCtx): string {
  const who = p.by ? personAvatarLink(personFor(p.by, x), p.by, 22) : "";
  const since = failingSince(p, x.now);
  const link = p.state === "ready" && p.url ? outLink(p.url, bareUrl(p.url), x) : "";
  return `<div class="repo-pv-row" data-pr="${p.pr ?? ""}" style="display:flex;align-items:center;gap:12px;padding:9px 20px;border-bottom:1px solid var(--border);flex-wrap:wrap">
    <span${p.by ? ` title="${attr(p.by)}"` : ""} style="flex:none;display:flex;width:22px">${who}</span>
    <div style="min-width:0;flex:1 1 260px;display:flex;flex-direction:column;gap:2px">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500">${esc(p.title ?? p.branch)} <span style="font-family:var(--label);font-size:11px;font-weight:400;color:var(--fg-40)">${p.pr !== null ? `#${p.pr} · ` : ""}${esc(p.branch)}</span></span>
      ${since ? `<span data-since style="font-size:12px;color:var(--fg-55)">${esc(since)}</span>` : ""}
    </div>
    ${stateOf(p) ? `<span style="flex:none">${stateOf(p)}</span>` : ""}
    <span style="flex:0 1 auto;min-width:0;max-width:300px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${link}</span>
    <span style="width:34px;text-align:right;flex:none;font-size:11.5px;color:var(--fg-40)">${esc(ago(p.at, x.now))}</span>
  </div>`;
}

export const previewsBlock: OverviewBlock = (f, x) => {
  // Only an app that has had previews draws the list (never "no previews" for a repo that has none).
  if (!f.previews.length && !f.apps.some((a) => a.previews)) return "";
  const n = f.previews.length;
  return `<section class="repo-pv" data-block="previews" style="border-top:1px solid var(--border)">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:13px 20px;border-bottom:1px solid var(--border)">
      <span style="${LABEL}">Previews · ${n} open</span>
      <span style="font-size:11px;color:var(--fg-40);white-space:nowrap">one per open pull request</span>
    </div>
    ${n ? f.previews.map((p) => previewRow(p, x)).join("") : `<div data-empty style="padding:14px 20px;font-size:12.5px;color:var(--fg-55)">No open pull requests, so no previews.</div>`}
  </section>`;
};
