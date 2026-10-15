// What the Repo Overview's blocks share (repo-env-cards.ts, repo-drift.ts, repo-apps-table.ts, repo-not-shipped.ts,
// repo-production.ts, repo-previews.ts, repo-release.ts, repo-found.ts): ONE table of the design's `MARKS` drawn
// through marks.ts (`stateMark` / `markShape` — the design's shape and tone per state, so a state looks the same in
// every block and in the header's pills), the section label, the sha chip, ages in words, a byline person, a part's
// host line, links that never leave sample data, the open / closed disclosure, and the commit groups (a PR, or
// commits pushed straight to a branch) that drift and not-shipped both list. Building pulses (`.repo-kit-pulse`),
// still under reduced motion.
import type { FactsCommitGroup, FactsDeploy, FactsPart } from "@shared/repo-facts-core";
import { esc, attr } from "./ui";
import { markShape, stateMark, type MarkShape } from "./marks";
import { personNameLink } from "./people";
import type { PersonSummary } from "./api";
import { ago } from "./repo";
import type { OverviewCtx } from "./repo-overview-ctx";

export type RepoMarkKey =
  | "healthy" | "degraded" | "failing" | "down" | "unknown" | "outOfStep"
  | "queued" | "building" | "live" | "failed" | "cancelled" | "superseded" | "rolledBack" | "stale" | "waiting";

const G = "var(--green)", AM = "var(--amber)", RD = "var(--red)", N = "var(--fg-55)", BL = "var(--blue)", OFF = "var(--fg-40)";
/** The design's `MARKS` (repo-data.js), shape and tone as it draws them; `tip` says what the state means. */
export const REPO_MARK: Record<RepoMarkKey, { word: string; tone: string; shape: MarkShape; tip: string; pulse?: true }> = {
  healthy: { word: "Healthy", tone: G, shape: "dot", tip: "Checks pass on the branch head and every app here is live." },
  degraded: { word: "Degraded", tone: AM, shape: "triangle", tip: "Checks are failing on the branch head." },
  failing: { word: "Failing", tone: RD, shape: "diamond", tip: "A deploy here failed." },
  down: { word: "Down", tone: RD, shape: "square", tip: "Its health check gets no answer." },
  unknown: { word: "Unknown", tone: N, shape: "ring", tip: "Trov has not seen a deploy here yet." },
  outOfStep: { word: "Out of step", tone: AM, shape: "triangle", tip: "Apps in this environment run different commits." },
  queued: { word: "Queued", tone: N, shape: "ring", tip: "Waiting for the host to start." },
  building: { word: "Building", tone: BL, shape: "ring", tip: "The host is building this commit now.", pulse: true },
  live: { word: "Live", tone: G, shape: "dot", tip: "Serving traffic." },
  failed: { word: "Failed", tone: RD, shape: "diamond", tip: "The deploy did not finish." },
  cancelled: { word: "Cancelled", tone: OFF, shape: "square", tip: "Stopped before it finished." },
  superseded: { word: "Superseded", tone: OFF, shape: "square", tip: "A newer deploy replaced it first." },
  rolledBack: { word: "Rolled back", tone: AM, shape: "triangle", tip: "Runs an older commit than the deploy before it." },
  stale: { word: "No recent reading", tone: N, shape: "ring", tip: "The source has not reported for over 30 minutes." },
  waiting: { word: "Waiting", tone: AM, shape: "triangle", tip: "Merged, not deployed yet." },
};

const pulse = (key: RepoMarkKey, html: string): string => (REPO_MARK[key].pulse ? `<span class="repo-kit-pulse" style="display:inline-flex">${html}</span>` : html);

/** A state as its shape and word; `word` replaces the design's word where the line says more ("Reading 34m old"). */
export function repoMark(key: RepoMarkKey, size = 12, word?: string): string {
  const m = REPO_MARK[key];
  return pulse(key, stateMark(word ?? m.word, m.tone, m.shape, size, m.tip));
}

/** The shape alone (the design's `shapeOnly`), for a line whose words already say the state. Named for a
 *  screen reader and explained by its tooltip, since nothing beside it says the word. */
export function repoShape(key: RepoMarkKey, size = 9): string {
  const m = REPO_MARK[key];
  return pulse(key, `<span role="img" aria-label="${attr(m.word)}" data-mtip="${attr(`${m.word}. ${m.tip}`)}" style="display:inline-flex;flex:none">${markShape(m.shape, m.tone, size)}</span>`);
}

export const LABEL = "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";
export const TOP = "border-top:1px solid var(--border)";
const SHA = "font-family:var(--label);font-size:12.5px;color:var(--fg);background:var(--hover);border:1px solid var(--border);border-radius:4px;padding:0 5px;line-height:18px;white-space:nowrap";

/** A commit as the design's chip; nothing for an unknown sha (never guessed). */
export const shaChip = (sha: string | null): string => (sha ? `<span style="${SHA}">${esc(sha)}</span>` : "");

/** A short sha for a sentence (the facts carry what the source reported; a full sha is cut to 7). */
/** A deploy's commit, or — when there is none — "no commit" with why (the single-app blocks name every deploy's
 *  commit; a row that has nothing to say draws `shaChip`'s empty string instead). */
export const shaOrNone = (sha: string | null): string => sha
  ? shaChip(sha.slice(0, 7))
  : `<span data-mtip="The host reported no commit, and no single GitHub signal matched this deploy." style="font-size:12px;color:var(--fg-40);white-space:nowrap">no commit</span>`;

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
    // Phase E: in a monorepo a commit whose changed files are not known stays in an app's list — and says so.
    const unknown = g.pathsUnknown
      ? `<span data-paths-unknown data-mtip="${attr("Which files these commits changed is not known yet, so they are kept in, not filtered by the app's watch paths.")}">${g.pathsUnknown >= g.commits.length ? "paths unknown" : `${g.pathsUnknown} with paths unknown`}</span>`
      : "";
    const meta = [people, when, unknown].filter(Boolean).join(" · ");
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

// ── from the single-app blocks (repo-production.ts, repo-previews.ts, repo-release.ts, repo-found.ts) ──
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export const LABEL_SM = LABEL.replace("10.5px", "10px");
/** A sha, in the design's code chip. */
export const CODE = "font-family:var(--label);font-size:12.5px;color:var(--fg);background:var(--hover);border:1px solid var(--border);border-radius:4px;padding:0 5px;line-height:18px";

/** A commit as its chip — or, when no provider value and no single GitHub signal named one, says so. */
/** An age in words: "12 minutes", "3 hours", "1 day", "9 days" (the release block's and the sentences'). */
export function agoWords(iso: string, now: number): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  if (Number.isNaN(ms)) return "";
  const n = (v: number, unit: string): string => `${v} ${unit}${v === 1 ? "" : "s"}`;
  if (ms < HOUR) return n(Math.max(1, Math.round(ms / MIN)), "minute");
  if (ms < DAY) return n(Math.round(ms / HOUR), "hour");
  return n(Math.round(ms / DAY), "day");
}

/** "a", "a and b", "a, b and c". */
export const andList = (xs: readonly string[]): string =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** A captured URL that may be linked: https only (never javascript:, data: or plain http). */
export const httpsUrl = (u: string | null | undefined): string | null => (u && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : null);
/** A URL as the screen prints it: no scheme, no trailing slash. */
export const bareUrl = (u: string): string => u.replace(/^https?:\/\//i, "").replace(/\/$/, "");

/** A link out — an `<a>` to an https URL, or the same words as plain text in sample mode (nothing links out to
 *  a real host) and when the URL is not https. */
export function outLink(url: string | null, text: string, x: Pick<OverviewCtx, "sample">, style = "font-size:12.5px"): string {
  const href = httpsUrl(url);
  return href && !x.sample
    ? `<a href="${attr(href)}" target="_blank" rel="noopener" class="repo-link" style="${style};white-space:nowrap">${esc(text)} ↗</a>`
    : `<span style="${style};color:var(--fg-55);white-space:nowrap">${esc(text)}</span>`;
}

/** The org's person behind a handle — whose card a name opens; null (plain text) for a handle no one holds and
 *  for sample data, which is no one. */
export function personFor(handle: string | null, x: Pick<OverviewCtx, "persons" | "sample">): PersonSummary | null {
  const h = handle?.toLowerCase();
  return h && !x.sample ? x.persons.find((p) => p.handle.toLowerCase() === h) ?? null : null;
}
/** A handle inline in a line of text, as the button that opens the person's card (people.ts). */
export const byName = (handle: string, x: Pick<OverviewCtx, "persons" | "sample">, style = ""): string =>
  personNameLink(personFor(handle, x), handle, style);


/** The deploy-state marks the single-app blocks name — the same table as every other block. */
export type DeployMarkKey = Extract<RepoMarkKey, "live" | "failed" | "building" | "queued" | "cancelled" | "rolledBack" | "down" | "stale" | "unknown">;
export const deployMark = (key: DeployMarkKey, size = 12, word?: string): string => repoMark(key, size, word);
