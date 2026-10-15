// Repo › Overview, rule R3 — the release block, for a repository whose apps are packages only (the design's
// `ReleaseBlock.dc.html` + `releaseModel`, repo-data.js): the latest tag (age, date, who, notes), what merged
// since it with the pull requests still waiting to ship (a feature only where the PR says so — `feature: true`
// came from a prefix or a label, never guessed), and the cadence strip with the gaps before it in words.
import type { FactsRelease } from "@shared/repo-facts-core";
import { esc, attr } from "./ui";
import { glyph } from "./marks";
import { ago } from "./repo";
import type { OverviewBlock, OverviewCtx } from "./repo-overview-ctx";
import { LABEL, agoWords, andList, byName, outLink } from "./repo-block-kit";

const DAY = 86_400_000;
const TOP = "border-top:1px solid var(--border)";
const BIG = "font-family:var(--label);font-size:27px;font-weight:600;letter-spacing:-0.02em;font-variant-numeric:tabular-nums";

/** "5 Oct" — and the year when it is not this one (UTC, so a fixed `now` draws the same date everywhere). */
export function shortDate(iso: string, now: number): string {
  const d = new Date(iso);
  const sameYear = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

/** The gaps between releases, newest first, in whole days: the latest's gap to the one before it, then that
 *  one's, and so on. */
export function releaseGaps(r: FactsRelease): number[] {
  const times = [...r.cadence.map((c) => c.at), r.at].map((t) => new Date(t).getTime()).sort((a, b) => b - a);
  return times.slice(1).map((t, i) => Math.round((times[i] - t) / DAY));
}
/** "The gaps before it were 14, 12, 21, 14 and 21 days." — from the cadence, never typed. */
export function gapsSentence(r: FactsRelease): string {
  const g = releaseGaps(r);
  if (!g.length) return "Trov has seen no release before it.";
  if (g.length === 1) return `The gap before it was ${g[0]} ${g[0] === 1 ? "day" : "days"}.`;
  return `The gaps before it were ${andList(g.map(String))} days.`;
}

/** "Two features are waiting to ship: DatePicker range mode and Toast stacking and swipe to dismiss." */
export function featureLine(r: FactsRelease): string {
  const feats = r.waiting.filter((w) => w.feature);
  if (!feats.length) return r.waiting.length ? "Merged since the last release:" : "";
  const names = andList(feats.map((w) => w.title.replace(/^feat(\([^)]*\))?:\s*/i, "")));
  const n = feats.length === 1 ? "One feature is" : feats.length === 2 ? "Two features are" : `${feats.length} features are`;
  return `${n} waiting to ship: ${names}.`;
}

function cadence(r: FactsRelease, now: number): string {
  const ticks = [...r.cadence.map((c) => ({ ...c, last: false })), { tag: r.tag, at: r.at, last: true }];
  const ageDays = (iso: string): number => Math.max(0, (now - new Date(iso).getTime()) / DAY);
  const oldest = Math.max(...ticks.map((t) => ageDays(t.at)));
  // The design's window is the last 100 days; a longer history widens it to the oldest release, in tens.
  const span = Math.max(100, Math.ceil((oldest + 5) / 10) * 10);
  const from = shortDate(new Date(now - span * DAY).toISOString(), now);
  const marks = ticks.map((t) => {
    const left = Math.min(100, Math.max(0, 100 - (ageDays(t.at) / span) * 100)).toFixed(2);
    return `<div class="repo-rel-tick${t.last ? " is-last" : ""}" data-tag="${attr(t.tag)}" style="position:absolute;top:0;left:${left}%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px">
      <span style="font-family:var(--label);font-size:10.5px;white-space:nowrap;color:${t.last ? "var(--fg)" : "var(--fg-55)"};font-weight:${t.last ? 600 : 400}">${esc(t.tag)}</span>
      <span aria-hidden="true" style="width:${t.last ? 3 : 2}px;height:${t.last ? 16 : 12}px;margin-top:${t.last ? 0 : 2}px;background:${t.last ? "var(--accent)" : "var(--fg-40)"}"></span>
    </div>`;
  }).join("");
  return `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px"><span style="${LABEL}">Release cadence</span><span style="font-size:11px;color:var(--fg-40)">last ${span} days</span></div>
    <div role="img" aria-label="${attr(`Releases over the last ${span} days: ${ticks.map((t) => t.tag).join(", ")}`)}" style="position:relative;height:64px;margin-top:18px">
      <div style="position:absolute;left:0;right:0;top:22px;height:1px;background:var(--border-strong)"></div>
      ${marks}
      <div style="position:absolute;right:0;top:15px;width:1px;height:15px;background:var(--fg-40)"></div>
      <div style="position:absolute;left:0;right:0;top:44px;display:flex;justify-content:space-between;font-size:10.5px;color:var(--fg-40)"><span>${esc(from)}</span><span>today</span></div>
    </div>
    <p data-gaps style="margin:10px 0 0;font-size:12.5px;line-height:1.55;color:var(--fg-70)">${esc(r.tag)} shipped ${esc(agoWords(r.at, now))} ago. ${esc(gapsSentence(r))}</p>`;
}

function waitingRow(w: FactsRelease["waiting"][number], x: OverviewCtx): string {
  return `<div class="repo-rel-pr" data-pr="${w.pr}" style="display:flex;align-items:center;gap:10px;padding:8px 0;${TOP}">
    ${glyph("done", "var(--accent)", 13, "Merged", "Merged. Not in a release yet.")}
    <span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:${w.feature ? 600 : 500}">${esc(w.title)} <span style="font-family:var(--label);font-size:11px;font-weight:400;color:var(--fg-40)">#${w.pr}${w.by ? ` · ${byName(w.by, x)}` : ""}${w.feature ? " · feature" : ""}</span></span>
    <span style="font-size:11.5px;color:var(--fg-40);white-space:nowrap">merged ${esc(ago(w.mergedAt, x.now))} ago</span>
  </div>`;
}

const num = (n: number | null): string => (n === null ? "—" : String(n));

export const releaseBlock: OverviewBlock = (f, x) => {
  const r = f.release;
  if (!r) {
    return `<section class="repo-rel" data-block="release" style="padding:20px 22px 18px">
      <span style="${LABEL}">Latest release</span>
      <p data-empty style="margin:8px 0 0;font-size:13px;color:var(--fg-55)">Trov has not seen a release of this repository yet.</p>
    </section>`;
  }
  const gh = `https://github.com/${f.repo.split("/").map(encodeURIComponent).join("/")}`;
  const feat = featureLine(r);
  return `<section class="repo-rel" data-block="release">
    <div style="padding:20px 22px 18px">
      <div style="display:flex;align-items:center;gap:8px 14px;flex-wrap:wrap">
        <span style="${LABEL}">Latest release</span>
        <span style="margin-left:auto;display:flex;gap:14px">${outLink(`${gh}/releases/tag/${encodeURIComponent(r.tag)}`, "Release notes", x)}${outLink(`${gh}/releases`, "All releases", x)}</span>
      </div>
      <div style="display:flex;align-items:baseline;gap:6px 14px;flex-wrap:wrap;margin-top:8px">
        <span style="font-family:var(--label);font-size:26px;font-weight:600;letter-spacing:-0.02em">${esc(r.tag)}</span>
        <span style="font-size:12.5px;color:var(--fg-55);white-space:nowrap">${esc(agoWords(r.at, x.now))} ago · ${esc(shortDate(r.at, x.now))}${r.by ? ` · by ${byName(r.by, x)}` : ""}</span>
      </div>
      ${r.notes ? `<p style="margin:10px 0 0;max-width:74ch;font-size:13.5px;line-height:1.6;color:var(--fg-70);text-wrap:pretty">${esc(r.notes)}</p>` : ""}
    </div>
    <div style="overflow:hidden;${TOP}">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr));margin:-1px 0 0 -1px">
        <div style="padding:16px 22px 10px;min-width:0;border-left:1px solid var(--border);${TOP}">
          <div style="${LABEL}">Since ${esc(r.tag)}</div>
          <div data-since style="display:flex;align-items:baseline;gap:10px;margin-top:8px;flex-wrap:wrap">
            <span style="${BIG}">${num(r.since.commits)}</span><span style="font-size:12.5px;color:var(--fg-55)">${r.since.commits === 1 ? "commit" : "commits"}</span>
            <span style="${BIG};margin-left:10px">${num(r.since.prs)}</span><span style="font-size:12.5px;color:var(--fg-55)">${r.since.prs === 1 ? "pull request" : "pull requests"}</span>
          </div>
          ${feat ? `<div data-feat style="font-size:12.5px;color:var(--fg-70);margin:10px 0 6px">${esc(feat)}</div>` : ""}
          ${r.waiting.map((w) => waitingRow(w, x)).join("")}
        </div>
        <div style="padding:16px 22px 18px;min-width:0;border-left:1px solid var(--border);${TOP}">${cadence(r, x.now)}</div>
      </div>
    </div>
  </section>`;
};
