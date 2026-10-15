// A run tagging the items, drawn live (Org settings › Tags; docs/architecture/web-ui.md › Tags › A run, live).
//
// When an admin adds a tag or presses Find items, Jev checks the run's candidates one by one in the background
// (src/tools/tag-fit.ts) and the tag is added to each one it judges a fit. The tag's row shows it as it
// happens: ONE bar whose fill is exactly `checked / candidates`, and a counter beside it ("23 of 40 ·
// 5 added"). When the run ends the bar takes the tag's own colour if it added the tag to anything, a quiet
// tone if not.
//
// The bar is a thin line under the words of the row's "Added by Jev" cell; at rest (no run drawn) it is hidden
// and the cell holds the latest result ("7 added", with Undo). It is drawn from REAL progress only: `GET …/tags/:name/run` (polled every `POLL_MS` while a run goes) says how
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

/** A run's result in a few words (they sit in one narrow column) and the whole sentence (the cell's tooltip). */
export function resultWords(r: Pick<TagRunDTO, "status" | "candidates" | "checked" | "added"> & { undone?: boolean }): { text: string; full: string } {
  if (r.undone) return { text: "Undone", full: `Undone: the ${items(r.added)} this run tagged no longer have it.` };
  if (r.candidates === 0) return { text: "Nothing to check", full: "Nothing in this organization to check yet." };
  const stop = r.status === "capped" ? `Stopped at ${r.checked} of ${r.candidates}: this month's checks are used up.`
    : r.status === "failed" ? `Stopped at ${r.checked} of ${r.candidates}: the model did not answer.` : "";
  if (stop) return { text: r.added ? `Stopped · ${r.added} added` : "Stopped", full: r.added ? `${stop} Added to ${items(r.added)}.` : stop };
  if (r.added === 0) return { text: "None fit", full: `Checked ${r.checked} — none fit.` };
  return { text: `${r.added} added`, full: `Added to ${items(r.added)}.` };
}

/** The counter's words: "12 of 40 · 3 added" while it goes, then the result's own words — the SAME words the
 *  row keeps once the list has the result, so nothing changes in the cell when the live view hands over. */
export function runCounter(live: Pick<LiveRun, "status" | "candidates" | "checked" | "added">, shown: number): string {
  const c = Math.floor(shown + 1e-9);
  if (live.status === "running" && live.candidates === 0) return "Starting…";
  if (live.status !== "running" && c >= live.checked) return resultWords(live).text;
  return `${c} of ${live.candidates} · ${shownAdded(live, shown)} added`;
}

/** A tag row's Jev cell (Org settings › Tags), live or at rest. ONE structure for both — the words, the Undo
 *  slot, and the bar — so the live view and the list's result morph into each other in place: when a run ends
 *  the bar takes its colour, then fades (`data-live` goes), and Undo fades in beside the same words.
 *  `last` is the latest run from the list; `undo` the Undo button's markup, or "". */
export function fitCell(tag: string, color: string, live: LiveRun | null, last: TagRunDTO | undefined, undo = ""): string {
  const shown = live?.shown ?? 0;
  const state = live ? barState(live, shown)
    : !last ? "idle"
    : last.status === "running" ? "running"
    : last.added > 0 && !last.undone_at ? "added" : "none";
  const words = live ? { text: runCounter(live, shown), full: "" }
    : !last ? { text: "—", full: "Not looked for yet" }
    : last.status === "running" ? { text: "Starting…", full: "" }
    : resultWords({ ...last, undone: !!last.undone_at });
  const fill = live ? barFill(live, shown) : last ? 1 : 0;
  return `<div data-col="jev" class="cnpy-tagjev" data-fitrun="${attr(tag)}" data-state="${state}"${live ? ' data-live="1"' : ""} data-morph-key="fitrun:${attr(tag)}" style="--fit-c:${tagTone(color)}">
      <span class="cnpy-tagjev-t" role="status" aria-live="polite" data-fitrun-n${words.full ? ` title="${attr(words.full)}"` : ""}>${esc(words.text)}</span>${undo}
      <div class="cnpy-fitrun-bar" role="progressbar" aria-label="${attr(`Items checked for ${tag}`)}" aria-valuemin="0" aria-valuemax="${live?.candidates ?? last?.candidates ?? 0}" aria-valuenow="${Math.floor(live ? shown : last?.checked ?? 0)}"${live ? "" : ' aria-hidden="true"'}><span style="transform:scaleX(${fill.toFixed(4)})"></span></div>
    </div>`;
}
