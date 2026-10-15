// What the Repo Overview's deploy blocks share (repo-env-cards.ts, repo-drift.ts, repo-apps-table.ts,
// repo-not-shipped.ts): the design's `MARKS` mapped onto marks.ts kinds, the sha chip, a byline person, a
// part's host line, a URL that never links out in sample mode, the open / closed disclosure, and the commit
// groups (a PR, or commits pushed straight to a branch) that drift and not-shipped both list.
//
// Marks: every design mark is a `kindMark` / `markShape` over `STATE_KIND` — no kind was added. The one
// departure is Building: the design draws a pulsing BLUE ring; Trov's in-flight mark is the `waiting` ring
// (repo.ts already says "Deploying" with it), pulsing by `.repo-kit-pulse` and still under reduced motion.
import type { FactsCommitGroup, FactsDeploy, FactsPart } from "@shared/repo-facts-core";
import { esc, attr } from "./ui";
import { kindMark, markShape, STATE_KIND, type StateKind } from "./marks";
import { personNameLink } from "./people";
import { ago } from "./repo";
import type { OverviewCtx } from "./repo-overview-ctx";

export type RepoMarkKey =
  | "healthy" | "degraded" | "failing" | "down" | "unknown" | "outOfStep"
  | "building" | "live" | "failed" | "rolledBack" | "stale" | "waiting";

/** The design's `MARKS` (repo-data.js) as marks.ts kinds: its word and what the state means (`data-mtip`). */
export const REPO_MARK: Record<RepoMarkKey, { word: string; kind: StateKind; tip: string; pulse?: true }> = {
  healthy: { word: "Healthy", kind: "good", tip: "Checks pass on the branch head and every app here is live." },
  degraded: { word: "Degraded", kind: "warn", tip: "Checks are failing on the branch head." },
  failing: { word: "Failing", kind: "bad", tip: "A deploy here failed." },
  down: { word: "Down", kind: "stopped", tip: "Its health check gets no answer." },
  unknown: { word: "Unknown", kind: "waiting", tip: "Trov has not seen a deploy here yet." },
  outOfStep: { word: "Out of step", kind: "warn", tip: "Apps in this environment run different commits." },
  building: { word: "Building", kind: "waiting", tip: "The host is building this commit now.", pulse: true },
  live: { word: "Live", kind: "good", tip: "Serving traffic." },
  failed: { word: "Failed", kind: "bad", tip: "The deploy did not finish." },
  rolledBack: { word: "Rolled back", kind: "warn", tip: "Runs an older commit than the deploy before it." },
  stale: { word: "No recent reading", kind: "waiting", tip: "The source has not reported for over 30 minutes." },
  waiting: { word: "Waiting", kind: "warn", tip: "Merged, not deployed yet." },
};

const pulse = (key: RepoMarkKey, html: string): string => (REPO_MARK[key].pulse ? `<span class="repo-kit-pulse" style="display:inline-flex">${html}</span>` : html);

/** A state as its shape and word; `word` replaces the design's word where the line says more ("Reading 34m old"). */
export function repoMark(key: RepoMarkKey, size = 12, word?: string): string {
  const m = REPO_MARK[key];
  return pulse(key, kindMark(word ?? m.word, m.kind, size, m.tip));
}

/** The shape alone (the design's `shapeOnly`), for a line whose words already say the state. Named for a
 *  screen reader and explained by its tooltip, since nothing beside it says the word. */
export function repoShape(key: RepoMarkKey, size = 9): string {
  const m = REPO_MARK[key];
  const k = STATE_KIND[m.kind];
  return pulse(key, `<span role="img" aria-label="${attr(m.word)}" data-mtip="${attr(`${m.word}. ${m.tip}`)}" style="display:inline-flex;flex:none">${markShape(k.shape, k.tone, size)}</span>`);
}

export const LABEL = "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";
export const TOP = "border-top:1px solid var(--border)";
const SHA = "font-family:var(--label);font-size:12.5px;color:var(--fg);background:var(--hover);border:1px solid var(--border);border-radius:4px;padding:0 5px;line-height:18px;white-space:nowrap";

/** A commit as the design's chip; nothing for an unknown sha (never guessed). */
export const shaChip = (sha: string | null): string => (sha ? `<span style="${SHA}">${esc(sha)}</span>` : "");

/** A short sha for a sentence (the facts carry what the source reported; a full sha is cut to 7). */
export const short = (sha: string): string => (/^[0-9a-f]{8,}$/i.test(sha) ? sha.slice(0, 7) : sha);

/** When a deploy happened: when it went live, else when it started. */
export const deployAge = (d: FactsDeploy, now: number): string => ago(d.readyAt ?? d.createdAt, now);

/** A handle in a byline: the button to their person card when it is someone in the org (never in sample
 *  mode, whose people are no one); plain text otherwise (a bot, an outside contributor). */
export function who(handle: string, x: Pick<OverviewCtx, "persons" | "sample">): string {
  const h = handle.toLowerCase();
  const p = x.sample ? null : x.persons.find((y) => y.handle.toLowerCase() === h) ?? null;
  return personNameLink(p, handle);
}

/** "Railway", "Fly.io via deploy-jobs.yml", "Railway via GitHub" (deploys from GitHub while the host is not connected). */
export const hostLine = (p: Pick<FactsPart, "host" | "via" | "viaGithub">): string =>
  p.host + (p.via ? ` via ${p.via}` : p.viaGithub ? " via GitHub" : "");

export const displayUrl = (u: string): string => u.replace(/^https?:\/\//i, "").replace(/\/$/, "");

/** A part's public URL: a link out, except in sample mode (nothing links to a real host) or for a non-http URL. */
export function urlHtml(url: string, x: Pick<OverviewCtx, "sample">, style = ""): string {
  const text = esc(displayUrl(url));
  const box = `font-size:12.5px;align-self:flex-start;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%${style ? `;${style}` : ""}`;
  return !x.sample && /^https?:\/\//i.test(url)
    ? `<a href="${attr(url)}" target="_blank" rel="noopener" class="repo-link" style="${box}">${text} ↗</a>`
    : `<span style="${box};color:var(--fg-55)">${text}</span>`;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The disclosure every block opens the same way: one act, the block's own key (`x.open`). */
export const TOGGLE_ACT = "repoOpen";
export const toggleAttrs = (key: string, open: boolean): string =>
  `data-act="${TOGGLE_ACT}" data-arg="${attr(key)}" aria-expanded="${open}"`;
export const chevron = (open: boolean): string =>
  `<svg class="repo-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="2.4" aria-hidden="true" style="flex:none;transform:rotate(${open ? 90 : 0}deg)"><path d="M9 6l6 6-6 6"></path></svg>`;

/** What a disclosure opens: always emitted (a stable structure for the morph), shown by `data-open`. */
export const panel = (open: boolean, inner: string, attrs = ""): string =>
  `<div class="repo-drift"${attrs} data-open="${open ? "1" : "0"}"><div style="overflow:hidden;min-height:0">${inner}</div></div>`;

export interface GroupOpts {
  /** The branch a PR merged into, said in the chain form ("merged into develop"). */
  into?: string | null;
}

/** The commit groups a drift step or a not-shipped entry lists: a header per PR (or per batch of direct
 *  pushes) with who and when, then its commits, then how many more the compare did not return. */
export function commitGroups(groups: readonly FactsCommitGroup[], x: OverviewCtx, o: GroupOpts = {}): string {
  return groups.map((g) => {
    const rest = g.kind === "direct" && g.commits.length === 0 && g.more > 0;
    const tag = g.kind === "pr" && g.pr !== null ? `#${g.pr}` : rest ? "More" : "Pushed";
    const people = g.by.map((h) => who(h, x)).join(", ");
    const when = g.kind === "pr" && g.mergedAt ? `merged${o.into ? ` into ${esc(o.into)}` : ""} ${esc(ago(g.mergedAt, x.now))} ago` : "";
    const meta = [people, when].filter(Boolean).join(" · ");
    return `<div class="repo-cgroup">
      <div style="display:flex;align-items:center;gap:9px;padding:10px 22px;${TOP};background:color-mix(in srgb,var(--fg) 2%,transparent)">
        <span style="font-family:var(--label);font-size:11.5px;font-weight:600;color:${g.kind === "pr" ? "var(--accent)" : "var(--fg-55)"};flex:none">${esc(tag)}</span>
        <span style="font-size:13px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.title)}</span>
        ${meta ? `<span style="font-size:11.5px;color:var(--fg-40);flex:none;margin-left:auto;white-space:nowrap">${meta}</span>` : ""}
      </div>
      ${g.commits.map((c) => `<div class="repo-commit" style="display:grid;grid-template-columns:84px minmax(0,1fr) 64px;gap:10px;align-items:center;padding:7px 22px 7px 30px;${TOP}">
        <span style="font-family:var(--label);font-size:11.5px;color:var(--fg-55)">${esc(short(c.sha))}</span>
        <span style="font-size:12.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.msg)}</span>
        <span style="font-size:11px;color:var(--fg-40);text-align:right">${esc(ago(c.at, x.now))}</span>
      </div>`).join("")}
      ${g.more > 0 && g.commits.length > 0 ? `<div style="padding:7px 22px 7px 30px;${TOP};font-size:12px;color:var(--fg-40)">and ${plural(g.more, "more commit")}</div>` : ""}
    </div>`;
  }).join("");
}
