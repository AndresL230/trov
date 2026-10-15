// Repo › Overview › this week's figures (the design's `weekModel`, repo-data.js): one tile per `FactsWeekFigure`,
// in the order the facts give them. Never guess: a figure Trov cannot know is "—" (never 0) and says why — "unknown
// until <host> is connected" when the connect hint names the host that would report it — a figure with no week to
// compare against says "since connecting", and a delta reads ▲ / ▼ / "—". Failed deploys read the other way round:
// more of them is the red direction.
import type { FactsWeekFigure, RepoFacts, WeekKey } from "@shared/repo-facts-core";
import { esc, attr } from "./ui";
import type { OverviewBlock, OverviewCtx } from "./repo-overview-ctx";

export const WEEK_LABEL: Record<WeekKey, string> = {
  mergedPrs: "Merged PRs", deploys: "Deploys", failedDeploys: "Failed deploys", openPrs: "Open PRs",
  commits: "Commits", releases: "Releases", ciRuns: "CI runs",
};
/** Figures where MORE is worse. */
const INVERSE: ReadonlySet<WeekKey> = new Set(["failedDeploys"]);
/** The figures a host's connection feeds. */
const DEPLOY_FIGURES: ReadonlySet<WeekKey> = new Set(["deploys", "failedDeploys"]);

export interface WeekTile { key: WeekKey; label: string; value: string; delta: string; tone: string; vs: string }

/** The host a missing figure waits on: the connect hint's provider, by its part's label. */
const waitingOn = (f: Pick<RepoFacts, "connect" | "parts">): string | null =>
  f.connect ? f.parts.find((p) => p.provider === f.connect?.provider)?.host ?? null : null;

export function weekTile(w: FactsWeekFigure, f: Pick<RepoFacts, "connect" | "parts">): WeekTile {
  const d = w.delta;
  const delta = d === null ? "" : d > 0 ? `▲ ${d}` : d < 0 ? `▼ ${Math.abs(d)}` : "—";
  const bad = d !== null && d !== 0 && (INVERSE.has(w.key) ? d > 0 : d < 0);
  const tone = d === null || d === 0 ? "var(--fg-40)" : bad ? "var(--red)" : "var(--green)";
  // Only the deploy figures wait on a host that is not connected; any other unknown figure (PRs, releases, CI) is
  // waiting on GitHub's capture, never on the host.
  const host = DEPLOY_FIGURES.has(w.key) && f.connect?.need === "deploys" ? waitingOn(f) : null;
  const vs = d !== null ? "vs last week" : w.value === null ? (host ? `unknown until ${host} is connected` : "not known yet") : "since connecting";
  return { key: w.key, label: WEEK_LABEL[w.key], value: w.value === null ? "—" : String(w.value), delta, tone, vs };
}

const LABEL = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";

export const weekBlock: OverviewBlock = (f: RepoFacts, _x: OverviewCtx): string => {
  if (!f.week.length) return "";
  return `<div class="repo-week">${f.week.map((w) => {
    const t = weekTile(w, f);
    const num = w.value === null ? "" : ` data-count="${w.value}"`;
    return `<div class="repo-week-tile" data-week="${attr(t.key)}">
      <div style="${LABEL}">${esc(t.label)}</div>
      <div style="display:flex;align-items:baseline;gap:6px 10px;margin-top:8px;flex-wrap:wrap">
        <span${num} style="font-family:var(--label);font-size:27px;font-weight:600;letter-spacing:-0.02em;font-variant-numeric:tabular-nums${w.value === null ? ";color:var(--fg-40)" : ""}">${esc(t.value)}</span>
        ${t.delta ? `<span style="font-family:var(--label);font-size:11.5px;font-weight:600;color:${t.tone}">${esc(t.delta)}</span>` : ""}
        <span style="font-size:11px;color:var(--fg-40)">${esc(t.vs)}</span>
      </div>
    </div>`;
  }).join("")}</div>`;
};
