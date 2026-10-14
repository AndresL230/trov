// A run tagging the items, drawn live (Org settings › Tags; docs/architecture/web-ui.md › Tags › A run, live).
//
// When an admin adds a tag or presses Find items, Jev checks the run's candidates one by one in the background
// (src/tools/tag-fit.ts) and the tag is added to each one it judges a fit. The tag's row shows it as it
// happens: ONE bar whose fill is exactly `checked / candidates`, and a counter beside it ("Checked 23 of 40 ·
// 5 added"). When the run ends the bar takes the tag's own colour if it added the tag to anything, a quiet
// tone if not.
//
// It is drawn from REAL progress only: `GET …/tags/:name/run` (polled every `POLL_MS` while a run goes) says how
// many are checked and how many were tagged. Between two answers the bar eases toward the latest numbers and
// never runs ahead of them. Pure: everything here is a function of the run and the time, tested without a DOM.
// The markup is the same structure on every paint (the fill is a transform, the state an attribute). Under
// prefers-reduced-motion the bar jumps to each answer and its colour change is instant (trov.css).
import type { TagRunDTO } from "@shared/tags-core";
import { tagTone } from "./marks";
import { esc, attr } from "./ui";

/** How often a running run is read. */
export const POLL_MS = 600;
/** At most this many reads of one run (3 minutes), then the view stops asking. */
export const POLL_MAX = 300;
/** How long the bar takes to catch up with a new answer. */
export const EASE_MS = 550;

/** A run as the client tracks it: the server's last answer, and where the bar is. */
export interface LiveRun {
  status: TagRunDTO["status"];
  candidates: number;
  /** The server's numbers. */
  checked: number;
  added: number;
  /** Where the bar was when the last answer came (`shown` then), and when it came (ms). */
  from: number;
  at: number;
  /** The checked count the bar shows now (fractional while it eases). Never above `checked`. */
  shown: number;
  polls: number;
}

export const newLive = (now: number): LiveRun => ({ status: "running", candidates: 0, checked: 0, added: 0, from: 0, at: now, shown: 0, polls: 0 });

/** Ease from `from` toward `to` over `EASE_MS`: never past `to`, never back before `from`. */
export function easeToward(from: number, to: number, elapsedMs: number, dur = EASE_MS): number {
  if (to <= from) return to;
  const t = Math.min(1, Math.max(0, elapsedMs / dur));
  return Math.min(to, from + (to - from) * (1 - (1 - t) ** 3));
}

/** One server answer into the live run: the target moves, and the bar eases from where it is. */
export function applyAnswer(live: LiveRun, run: TagRunDTO, now: number): LiveRun {
  return {
    ...live, status: run.status, candidates: Math.max(run.candidates, live.candidates), checked: run.checked, added: run.added,
    from: live.shown, at: now, polls: live.polls + 1,
  };
}

/** Where the bar is at `now`. With reduced motion it is simply the server's count. */
export const shownAt = (live: LiveRun, now: number, reduced = false): number =>
  reduced ? live.checked : easeToward(live.from, live.checked, now - live.at);

/** Should the run be read again? Only while it runs, the tab is visible, and the cap is not reached. */
export const shouldPoll = (live: LiveRun, hidden: boolean): boolean => live.status === "running" && !hidden && live.polls < POLL_MAX;

/** The bar's fill, 0–1: the shown checks over the candidates. */
export const barFill = (live: Pick<LiveRun, "candidates">, shown: number): number =>
  live.candidates > 0 ? Math.max(0, Math.min(1, shown / live.candidates)) : 0;

/** The bar's state — its colour: going; ended having tagged something (the tag's colour); ended with nothing. */
export function barState(live: Pick<LiveRun, "status" | "checked" | "added">, shown: number): "running" | "added" | "none" {
  if (live.status === "running" || shown < live.checked) return "running";
  return live.added > 0 ? "added" : "none";
}

/** How many of the shown checks were tagged — never ahead of the bar. */
export const shownAdded = (live: Pick<LiveRun, "checked" | "added">, shown: number): number =>
  live.checked > 0 ? Math.min(live.added, Math.floor((live.added * Math.min(shown, live.checked)) / live.checked + 1e-9)) : 0;

const items = (n: number): string => `${n} ${n === 1 ? "item" : "items"}`;

/** The counter's words. */
export function runCounter(live: Pick<LiveRun, "status" | "candidates" | "checked" | "added">, shown: number): string {
  const c = Math.floor(shown + 1e-9);
  const ended = live.status !== "running" && c >= live.checked;
  if (live.status === "running" && live.candidates === 0) return "Picking items to check…";
  if (live.status !== "running" && live.candidates === 0) return "Nothing in this organization to check yet.";
  if (ended && live.status === "capped") return `Stopped at ${live.checked} of ${live.candidates}: this month's checks are used up.${live.added ? ` Added to ${items(live.added)}.` : ""}`;
  if (ended && live.status === "failed") return `Stopped at ${live.checked} of ${live.candidates}: the model did not answer.${live.added ? ` Added to ${items(live.added)}.` : ""}`;
  if (ended && live.added === 0) return `Checked ${live.checked} — none fit.`;
  if (ended) return `Added to ${items(live.added)}.`;
  return `Checked ${c} of ${live.candidates} · ${shownAdded(live, shown)} added`;
}

/** The live view in a tag's row: the bar and the counter. */
export function fitRunView(tag: string, color: string, live: LiveRun): string {
  const shown = live.shown;
  return `<div class="cnpy-fitrun" data-fitrun="${attr(tag)}" data-state="${barState(live, shown)}" data-morph-key="fitrun:${attr(tag)}" style="--fit-c:${tagTone(color)}">
      <div class="cnpy-fitrun-bar" role="progressbar" aria-label="${attr(`Items checked for ${tag}`)}" aria-valuemin="0" aria-valuemax="${live.candidates}" aria-valuenow="${Math.floor(shown)}"><span style="transform:scaleX(${barFill(live, shown).toFixed(4)})"></span></div>
      <span class="cnpy-fitrun-n" role="status" aria-live="polite" data-fitrun-n>${esc(runCounter(live, shown))}</span>
    </div>`;
}
