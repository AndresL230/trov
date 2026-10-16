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
//   links into the tabs                                each with a one-line summary read from the facts
//
// Each block is wrapped in `<div class="repo-block" data-repo-block="<name>">` so the frame and its tests can see
// what was drawn whatever a block returns; an empty wrapper is hidden by CSS. "Repo-wide only" (`REPO_WIDE`) has no
// app rows, so it draws its own short note instead of an opener (the rules would read it as `unseen`).
import { REPO_WIDE, type FactsPart, type RepoFacts } from "@shared/repo-facts-core";
import type { RepoTab } from "@shared/repo";
import { esc, attr } from "./ui";
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
  | "envCards" | "drift" | "appsTable" | "notShipped" | "repoWide" | "week" | "links";

const list = (xs: string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const uniq = (xs: string[]): string[] => [...new Set(xs)];
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ── the links row's one-line summaries ───────────────────────────────────────

/** Where usage comes from, read from the parts in view — their capability to report metrics and their
 *  connection, never a provider id: "from Cloudflare Workers and Railway", "not available from Netlify" (no part's
 *  host reports a metric), "not connected" (a host that would report them is not connected). */
export function usageSummary(parts: readonly FactsPart[]): string {
  const able = parts.filter((p) => p.reportsMetrics);
  const live = uniq(able.filter((p) => p.connection === "connected").map((p) => p.host));
  if (live.length) return `from ${list(live)}`;
  if (able.length) return "not connected";
  if (parts.length) return `not available from ${list(uniq(parts.map((p) => p.host)))}`;
  return "nothing deploys here yet";
}

/** The CI tab's line: deploys this week, or what the deploy figure waits on. */
function ciSummary(f: RepoFacts, release: boolean): string {
  if (release) {
    const failing = f.ci.filter((c) => c.state === "fail");
    if (failing.length) return `Checks failing on ${list(failing.map((c) => f.envs.find((e) => e.key === c.env)?.branch ?? c.env))}`;
    if (f.ci.length && f.ci.every((c) => c.state === "pass")) return "All checks passing";
    return "Runs and checks";
  }
  const deploys = f.week.find((w) => w.key === "deploys")?.value ?? null;
  if (deploys !== null) return `${plural(deploys, "deploy")} this week`;
  const host = f.connect?.need === "deploys" ? f.parts.find((p) => p.provider === f.connect?.provider)?.host ?? null : null;
  return host ? `CI only until ${host} is connected` : "Deploys and runs";
}

export interface OverviewLink { tab: RepoTab; label: string; text: string }

/** The links into the tabs: each tab of the layout with its summary. */
export function overviewLinks(f: RepoFacts, x: Pick<OverviewCtx, "layout">): OverviewLink[] {
  const release = x.layout.rule === "release";
  const open = f.week.find((w) => w.key === "openPrs")?.value ?? null;
  const text: Record<RepoTab, string> = {
    overview: "",
    code: open === null ? "Pull requests and branches" : `${plural(open, "open pull request")}`,
    ci: ciSummary(f, release),
    usage: usageSummary(f.parts),
    planning: "Roadmap and issues",
  };
  return x.layout.tabs.filter(([t]) => t !== "overview").map(([tab, label]) => ({ tab, label, text: text[tab] }));
}

const linksBlock: OverviewBlock = (f, x) => {
  const links = overviewLinks(f, x);
  if (!links.length) return "";
  return `<div class="repo-links">${links.map((l) => `<button type="button" data-act="setRepoTab" data-arg="${attr(l.tab)}" class="repo-link-cell" data-link="${attr(l.tab)}">
      <span style="font-size:13px;font-weight:600;color:var(--fg)">${esc(l.label)} <span aria-hidden="true" style="color:var(--fg-40)">→</span></span>
      <span data-link-text style="font-size:12px;color:var(--fg-55)">${esc(l.text)}</span>
    </button>`).join("")}</div>`;
};

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
  // The design gives the found / unseen openers no links row: the page under them is pull requests, CI and figures.
  if (f.app === REPO_WIDE || (o !== "found" && o !== "unseen")) out.push("links");
  return out;
}

const BLOCKS: Record<Exclude<OverviewBlockName, "state">, OverviewBlock> = {
  attention: attentionBlock, connect: connectBlock, found: foundBlock, unseen: unseenBlock, release: releaseBlock,
  production: productionBlock, previews: previewsBlock, envCards: envCardsBlock, drift: driftBlock,
  appsTable: appsTableBlock, notShipped: notShippedBlock, repoWide: repoWideBlock, week: weekBlock, links: linksBlock,
};

/** The Overview from facts: every block the layout asks for, each in its wrapper, with the entrance stagger. */
export function overviewFacts(f: RepoFacts, x: OverviewCtx): string {
  return overviewBlocks(f, x).map((name, i) => name === "state"
    // The design's place for #178's AI `state`, above the rule-picked opener. Always empty: the owner split it
    // out to the Summary tab (2026-10-15; repo.ts `summaryTab`).
    ? `<div data-repo-state-slot></div>`
    : `<div class="repo-block cnpy-rise" style="--i:${i}" data-repo-block="${name}">${BLOCKS[name](f, x)}</div>`).join("");
}
