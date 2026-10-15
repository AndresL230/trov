// Repo › Overview — the environment cards (the design's `EnvCard.dc.html`, `rowFor` / `envCards` in
// repo-setups-design/repo-data.js). One card per environment in `facts.envs` order (promotion order); a row per
// part in it, in the apps' order — the promotion chain (R5) has one app, so one row each; the environment cards
// (R6) a row per app. Everything is derived from `RepoFacts` here; nothing arrives worded.
//
// A row: the app, the commit serving (or building), "<age> ago · by <who> · <host>[ via <workflow>]", the URL,
// the health reading (ms, Down, or how old a stale reading is), and a line for what is going on: a failed deploy
// and its reason, a build and what serves meanwhile, a rollback; a flag when the app is behind another app. A
// part with no deploy at all is Unknown and says why, never 0 and never "not connected" for a host it has.
import type { FactsPart, RepoFacts } from "@shared/repo-facts-core";
import { esc, attr } from "./ui";
import type { OverviewBlock, OverviewCtx } from "./repo-overview-ctx";
import { ciLine, envVerdict } from "./repo-verdict";
import { LABEL, TOP, deployAge, hostLine, plural, repoMark, repoShape, shaChip, short, urlHtml, who, displayUrl } from "./repo-block-kit";
import { ago } from "./repo";

// The CI line's wording is repo-verdict.ts `ciLine` (one function for every block); re-exported for its tests.
export { ciLine };

const CI_TONE = { good: "var(--green)", bad: "var(--red)", warn: "var(--amber)" } as const;
const CI_GLYPH = { good: "✓", bad: "✕", warn: `<span class="repo-gdot" aria-hidden="true"></span>` } as const;

/** Why a part has no deploy to show. */
function unknownWhy(p: FactsPart): string {
  if (!p.reportsDeploys) return `${p.host} does not report deploys`;
  if (p.connection !== "connected") return `${p.host} does not report deploys to GitHub`;
  return "No deploy seen yet";
}

interface Line { mark: string; html: string }

/** One part's row. */
function partRow(f: RepoFacts, p: FactsPart, x: OverviewCtx): string {
  const label = f.apps.find((a) => a.key === p.app)?.label ?? p.label;
  const inFlight = p.latest && (p.latest.state === "building" || p.latest.state === "queued") ? p.latest : null;
  const shown = inFlight ?? p.serving;
  const lines: Line[] = [];
  let state = "";
  let meta: string;
  let sha: string | null = null;

  if (!shown) {
    meta = esc(unknownWhy(p));
    state = repoMark("unknown", 12);
  } else {
    sha = shown.sha;
    meta = [`${esc(deployAge(shown, x.now))} ago`, shown.by ? `by ${who(shown.by, x)}` : "", esc(hostLine(p))].filter(Boolean).join(" · ");
    if (inFlight) {
      state = repoMark("building", 12);
      if (p.serving) lines.push({ mark: "", html: `${p.serving.sha ? esc(short(p.serving.sha)) : "The deploy before it"} is serving until it finishes.` });
    }
    const failed = p.latest?.state === "error" ? p.latest : null;
    if (failed) {
      const what = failed.sha ? `${esc(short(failed.sha))} failed` : "A deploy failed";
      const serving = p.serving ? (p.serving.sha ? ` ${esc(short(p.serving.sha))} is still serving.` : " The deploy before it is still serving.") : "";
      lines.push({ mark: repoShape("failed"), html: `${what} ${esc(ago(failed.createdAt, x.now))} ago${failed.reason ? ` · ${esc(failed.reason)}` : ""}.${serving}` });
    }
    if (p.serving?.rolledBackFrom) {
      if (!inFlight) state = repoMark("rolledBack", 12);
      lines.push({ mark: "", html: `Rolled back from ${esc(short(p.serving.rolledBackFrom))}${p.serving.by ? ` by ${who(p.serving.by, x)}` : ""} ${esc(deployAge(p.serving, x.now))} ago.` });
    }
  }

  // Health: a reading of the URL. Down says since when (the attention item has it); stale says how old it is.
  let health = "";
  if (p.health) {
    if (p.health.stale) health = repoMark("stale", 12, `Reading ${ago(p.health.at, x.now)} old`);
    else if (!p.health.up) {
      health = repoMark("down", 12);
      const since = f.attention.find((a) => a.kind === "down" && a.app === p.app && a.env === p.env)?.refs.since;
      lines.unshift({ mark: repoShape("down"), html: `No answer from ${esc(displayUrl(p.health.url))}${since ? ` for ${esc(ago(since, x.now))}` : ""}` });
    } else if (p.health.ms !== null) health = `<span>${p.health.ms} ms</span>`;
  } else if (p.url && shown) health = `<span data-mtip="No health reading for this URL yet.">—</span>`;

  const oos = f.outOfStep.find((o) => o.env === p.env && o.app === p.app);
  const flag = oos ? `<div style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--fg-70)">${repoShape("outOfStep")}<span style="white-space:nowrap">${plural(oos.behindBy, "commit")} behind ${esc(f.apps.find((a) => a.key === oos.of)?.label ?? oos.of)}</span></div>` : "";

  return `<div class="repo-envrow" data-part="${attr(`${p.app}/${p.env}`)}" style="${TOP}">
    <span class="repo-envrow-app" style="font-size:13px;font-weight:600;color:var(--fg);line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span>
    <div style="min-width:0;display:flex;flex-direction:column;gap:5px">
      <div style="display:flex;align-items:center;gap:6px 9px;flex-wrap:wrap;min-height:22px">${shaChip(sha)}<span style="font-size:12px;color:var(--fg-55)">${meta}</span>${state}</div>
      ${lines.map((l) => `<div style="display:flex;align-items:flex-start;gap:7px;font-size:12.5px;line-height:1.5;color:var(--fg-70)">${l.mark ? `<span style="padding-top:4px;flex:none;display:flex">${l.mark}</span>` : ""}<span>${l.html}</span></div>`).join("")}
      ${flag}
      ${p.url ? urlHtml(p.url, x) : ""}
    </div>
    <div class="repo-envrow-health" style="display:flex;align-items:center;justify-content:flex-end;gap:6px;font-size:12px;color:var(--fg-55);line-height:22px;white-space:nowrap;font-variant-numeric:tabular-nums">${health}</div>
  </div>`;
}

/** One environment's card. */
function envCard(f: RepoFacts, envKey: string, x: OverviewCtx): string {
  const e = f.envs.find((v) => v.key === envKey)!;
  const order = (app: string): number => { const i = f.apps.findIndex((a) => a.key === app); return i < 0 ? f.apps.length : i; };
  const parts = f.parts.filter((p) => p.env === envKey).sort((a, b) => order(a.app) - order(b.app));
  const ci = ciLine(f.ci.find((c) => c.env === envKey));
  const verdict = envVerdict(f, envKey);
  return `<section class="repo-envcard" data-env="${attr(e.key)}" aria-label="${attr(e.name)}">
    <div style="display:flex;align-items:center;gap:6px 10px;margin-bottom:12px;flex-wrap:wrap">
      <span style="font-size:16.5px;font-weight:600;letter-spacing:-0.01em">${esc(e.name)}</span>
      ${e.branch ? `<span style="font-size:12px;color:var(--fg-40);white-space:nowrap">from <span style="font-family:var(--label);font-size:11.5px;color:var(--fg-55)">${esc(e.branch)}</span></span>` : ""}
      <span style="margin-left:auto" data-verdict="${verdict.key}">${repoMark(verdict.key, 12.5)}</span>
    </div>
    ${parts.map((p) => partRow(f, p, x)).join("")}
    ${ci ? `<div class="repo-envci" style="${TOP}">
      <span style="${LABEL}">CI on head</span>
      <span style="font-size:12.5px;line-height:1.5;color:${CI_TONE[ci.tone]};display:flex;gap:7px;align-items:center;min-width:0"><span style="font-family:var(--label);font-size:12.5px;font-weight:600;flex:none">${CI_GLYPH[ci.tone]}</span><span>${esc(ci.text)}</span></span>
    </div>` : ""}
  </section>`;
}

/** The cards, side by side as room allows (three environments get narrower cards, as in the design). */
export const envCardsBlock: OverviewBlock = (f, x) => {
  if (!f.envs.length) return "";
  return `<div class="repo-envcards" data-envcards style="--card-min:${f.envs.length >= 3 ? 300 : 340}px">${f.envs.map((e) => `<div class="repo-envcell">${envCard(f, e.key, x)}</div>`).join("")}</div>`;
};
