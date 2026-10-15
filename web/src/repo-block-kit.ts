// Small pieces the Repo Overview's blocks share (repo-production.ts, repo-previews.ts, repo-release.ts,
// repo-found.ts): the section label, the sha chip, ages in words, links that never leave sample data, a
// person by handle, and the deploy-state marks — the design's `MARKS` mapped onto marks.ts (`stateMark`), so
// a deploy state looks the same in every block. Pure string templates, like the rest of the SPA.
import { esc, attr } from "./ui";
import { stateMark, type MarkShape } from "./marks";
import { personNameLink } from "./people";
import type { PersonSummary } from "./api";
import type { OverviewCtx } from "./repo-overview-ctx";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** A section's label (the design's 10.5px tracked caps — a heading, never a state). */
export const LABEL = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";
export const LABEL_SM = LABEL.replace("10.5px", "10px");
/** A sha, in the design's code chip. */
export const CODE = "font-family:var(--label);font-size:12.5px;color:var(--fg);background:var(--hover);border:1px solid var(--border);border-radius:4px;padding:0 5px;line-height:18px";

/** A commit as its chip — or, when no provider value and no single GitHub signal named one, says so. */
export function shaChip(sha: string | null): string {
  return sha
    ? `<span style="${CODE}">${esc(sha.slice(0, 7))}</span>`
    : `<span data-mtip="The host reported no commit, and no single GitHub signal matched this deploy." style="font-size:12px;color:var(--fg-40);white-space:nowrap">no commit</span>`;
}

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

// ── deploy states as marks ───────────────────────────────────────────────────
/** The design's deploy-state `MARKS` on marks.ts shapes: dot = fine, ring = waiting, triangle = a warning,
 *  diamond = failing, square = stopped. `tip` says what the state means (never the word again). */
export type DeployMarkKey = "live" | "failed" | "building" | "queued" | "cancelled" | "rolledBack" | "down" | "stale" | "unknown";
export const DEPLOY_MARK: Record<DeployMarkKey, { word: string; tone: string; shape: MarkShape; tip: string }> = {
  live: { word: "Live", tone: "var(--green)", shape: "dot", tip: "Serving traffic." },
  failed: { word: "Failed", tone: "var(--red)", shape: "diamond", tip: "The deploy did not finish." },
  building: { word: "Building", tone: "var(--blue)", shape: "ring", tip: "The host is building this commit now." },
  queued: { word: "Queued", tone: "var(--fg-55)", shape: "ring", tip: "Waiting for the host to start." },
  cancelled: { word: "Cancelled", tone: "var(--fg-40)", shape: "square", tip: "Stopped before it finished." },
  rolledBack: { word: "Rolled back", tone: "var(--amber)", shape: "triangle", tip: "Runs an older commit than the deploy before it." },
  down: { word: "Down", tone: "var(--red)", shape: "square", tip: "Its health check gets no answer." },
  stale: { word: "No recent reading", tone: "var(--fg-55)", shape: "ring", tip: "The source has not reported for over 30 minutes." },
  unknown: { word: "Unknown", tone: "var(--fg-55)", shape: "ring", tip: "Trov has not seen a deploy here yet." },
};
/** A deploy state's mark; `word` replaces the state's word ("e07b3a2 failed 12m ago"). Building's shape blinks
 *  (`.repo-blink`, still under reduced motion). */
export function deployMark(key: DeployMarkKey, size = 12, word?: string): string {
  const m = DEPLOY_MARK[key];
  const html = stateMark(word ?? m.word, m.tone, m.shape, size, m.tip);
  return key === "building" ? `<span class="repo-blink" style="display:inline-flex">${html}</span>` : html;
}
