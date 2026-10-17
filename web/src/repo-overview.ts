// Repo › Overview, drawn from `facts` (shared/repo-facts-core.ts) — the composition of the design's `buildScreen`
// (docs/superpowers/specs/repo-setups-design/repo-data.js) and RepoScreen.dc.html, top to bottom:
//
//   the AI state slot (the design's place for #178's `state`; it stays EMPTY — State is the Summary tab, repo.ts)
//   Needs attention                                    only when something is wrong (repo-attention.ts)
//   the connect card                                   only with `facts.connect` (repo-connect.ts), above the opener
//   the opener, by `layout.opener` (shared/repo-layout-core.ts — the same rules MCP returns):
//     found       → foundBlock                         (repo-found.ts)
//     unseen      → unseenBlock                        (repo-found.ts)
//     release     → releaseBlock                       (repo-release.ts)
//     production  → productionBlock, notShipped, previewsBlock (repo-production.ts, repo-previews.ts)
//     chain / envCards → envCardsBlock, driftBlock     (repo-env-cards.ts, repo-drift.ts)
//     appsTable   → appsTableBlock                     (repo-apps-table.ts)
//   not shipped                                        where the design draws it: a part with commit groups waiting
//   this week's figures                                (repo-week.ts)
//
// The design closes with a row of links into the tabs; Trov draws none — they repeated the tab bar above.
//
// Each block is wrapped in `<div class="repo-block" data-repo-block="<name>">` so the frame and its tests can see
// what was drawn whatever a block returns; an empty wrapper is hidden by CSS. "Repo-wide only" (`REPO_WIDE`) has no
// app rows, so it draws its own short note instead of an opener (the rules would read it as `unseen`).
import { REPO_WIDE, type RepoFacts } from "@shared/repo-facts-core";
import type { OverviewBlock, OverviewCtx } from "./repo-overview-ctx";
import { attentionBlock } from "./repo-attention";
import { connectBlock } from "./repo-connect";
import { weekBlock } from "./repo-week";
import { envCardsBlock } from "./repo-env-cards";
import { driftBlock } from "./repo-drift";
import { appsTableBlock } from "./repo-apps-table";
import { notShippedBlock } from "./repo-not-shipped";
import { productionBlock } from "./repo-production";
import { previewsBlock } from "./repo-previews";
import { releaseBlock } from "./repo-release";
import { foundBlock, unseenBlock } from "./repo-found";

/** The names a block's wrapper carries (`data-repo-block`). */
export type OverviewBlockName =
  | "state" | "attention" | "connect" | "found" | "unseen" | "release" | "production" | "previews"
  | "envCards" | "drift" | "appsTable" | "notShipped" | "repoWide" | "week";

/** "Repo-wide only": files outside every app. No app rows, so no opener — what the view is, and the way back. */
const repoWideBlock: OverviewBlock = () =>
  `<div style="padding:18px 22px 16px"><div style="font-size:14px;font-weight:600">Files outside every app</div>
    <p style="margin:6px 0 0;font-size:12.5px;line-height:1.55;color:var(--fg-55);max-width:76ch">Pull requests and checks that touch no app's folder. Deploys belong to apps, so none is shown here — pick an app, or All apps, in the App menu.</p></div>`;

// ── the composition ──────────────────────────────────────────────────────────

/** Which blocks the facts and the layout draw, in screen order — the design's `buildScreen`. */
export function overviewBlocks(f: RepoFacts, x: Pick<OverviewCtx, "layout">): OverviewBlockName[] {
  const out: OverviewBlockName[] = ["state"];
  if (f.attention.length) out.push("attention");
  if (f.connect) out.push("connect");
  const notShipped = f.notShipped.some((n) => n.groups.length > 0);
  const o = x.layout.opener;
  if (f.app === REPO_WIDE) out.push("repoWide");
  else if (o === "found") out.push("found");
  else if (o === "unseen") out.push("unseen");
  // A package's latest release; the design draws nothing in its place when there is none yet (a package picked in
  // the App menu of a monorepo whose releases are the repository's).
  else if (o === "release") { if (f.release) out.push("release"); }
  else if (o === "production") {
    out.push("production");
    if (notShipped) out.push("notShipped");
    if (f.previews.length || f.apps.some((a) => a.previews)) out.push("previews");
  } else if (o === "chain" || o === "envCards") {
    out.push("envCards");
    if (f.drift.length) out.push("drift");
  } else out.push("appsTable");
  // The design draws not-shipped whenever a part has commit groups waiting, right under the opener's card (and,
  // under the Production card, above the previews).
  if (notShipped && !out.includes("notShipped") && f.app !== REPO_WIDE) out.push("notShipped");
  if (f.week.length) out.push("week");
  return out;
}

const BLOCKS: Record<Exclude<OverviewBlockName, "state">, OverviewBlock> = {
  attention: attentionBlock, connect: connectBlock, found: foundBlock, unseen: unseenBlock, release: releaseBlock,
  production: productionBlock, previews: previewsBlock, envCards: envCardsBlock, drift: driftBlock,
  appsTable: appsTableBlock, notShipped: notShippedBlock, repoWide: repoWideBlock, week: weekBlock,
};

/** The Overview from facts: every block the layout asks for, each in its wrapper, with the entrance stagger. */
export function overviewFacts(f: RepoFacts, x: OverviewCtx): string {
  return overviewBlocks(f, x).map((name, i) => name === "state"
    // The design's place for #178's AI `state`, above the rule-picked opener. Always empty: the owner split it
    // out to the Summary tab (2026-10-15; repo.ts `summaryTab`).
    ? `<div data-repo-state-slot></div>`
    : `<div class="repo-block cnpy-rise" style="--i:${i}" data-repo-block="${name}">${BLOCKS[name](f, x)}</div>`).join("");
}
