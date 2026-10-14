// A run sorting the items, drawn live (Org settings › Tags; docs/architecture/web-ui.md › Tags › A run, live).
//
// When an admin adds a tag or presses Find items, Jev checks the run's candidates one by one in the background
// (src/tools/tag-fit.ts). The row shows it as it happens: the candidates are small squares queued on the left
// of a short track; each one the server reports as checked travels along it and either settles into a "may
// fit" group on the right, in the tag's colour, or fades out mid-way as not a fit. A quiet counter says
// "Checked 23 of 40 · 5 may fit".
//
// It is drawn from REAL progress only: `GET …/tags/:name/run` (polled every `POLL_MS` while a run goes) says how
// many are checked and how many fit. Between two answers the view eases toward the latest numbers and never
// runs ahead of them. Which square fits is not known item by item, so each batch of newly checked squares
// gets as many "fit" outcomes as the server's count grew by (`assignOutcomes`) — and keeps them.
//
// Pure: everything here is a function of the run and the time, so it is tested without a DOM. The markup is
// STABLE across repaints: a fixed set of square elements (one per candidate, at most `PARTICLES_MAX`), moved
// with a transform built from CSS variables, their state in attributes. Under prefers-reduced-motion the
// track is hidden and a plain bar shows the same count, with no movement (trov.css).
import type { TagRunDTO } from "@shared/tags-core";
import { tagTone } from "./marks";
import { esc, attr } from "./ui";

export const PARTICLES_MAX = 40;
/** How often a running run is read. */
export const POLL_MS = 600;
/** At most this many reads of one run (3 minutes), then the view stops asking. */
export const POLL_MAX = 300;
/** How long the view takes to catch up with a new answer. */
export const EASE_MS = 550;

export type Outcome = "fit" | "out";

/** A run as the client tracks it: the server's last answer, and where the view is. */
export interface LiveRun {
  status: TagRunDTO["status"];
  candidates: number;
  /** The server's numbers. */
  checked: number;
  suggested: number;
  /** One outcome per checked candidate, in order — assigned once, never changed. */
  outcomes: Outcome[];
  /** Where the view was when the last answer came (`shown` then), and when it came (ms). */
  from: number;
  at: number;
  /** The checked count the view shows now (fractional while a square is on its way). Never above `checked`. */
  shown: number;
  polls: number;
}

export const newLive = (now: number): LiveRun => ({ status: "running", candidates: 0, checked: 0, suggested: 0, outcomes: [], from: 0, at: now, shown: 0, polls: 0 });

/** Extend `prev` to `checked` outcomes: the newly checked ones get as many fits as `suggested` grew by,
 *  spread among them. Earlier outcomes never change; never more fits than the server counted. */
export function assignOutcomes(prev: readonly Outcome[], checked: number, suggested: number): Outcome[] {
  const out = prev.slice();
  const had = out.filter((o) => o === "fit").length;
  const add = Math.max(0, checked - out.length);
  const fits = Math.min(add, Math.max(0, suggested - had));
  // Spread: the k-th new one fits when the running share of fits crosses a whole number — exactly `fits` of them.
  for (let k = 0; k < add; k++) out.push(Math.floor(((k + 1) * fits) / add) > Math.floor((k * fits) / add) ? "fit" : "out");
  return out;
}

/** Ease from `from` toward `to` over `EASE_MS`: never past `to`, never back before `from`. */
export function easeToward(from: number, to: number, elapsedMs: number, dur = EASE_MS): number {
  if (to <= from) return to;
  const t = Math.min(1, Math.max(0, elapsedMs / dur));
  const e = 1 - (1 - t) ** 3;
  return Math.min(to, from + (to - from) * e);
}

/** One server answer into the live run: the outcomes grow, and the view starts easing from where it is. */
export function applyAnswer(live: LiveRun, run: TagRunDTO, now: number): LiveRun {
  return {
    ...live,
    status: run.status,
    candidates: Math.max(run.candidates, live.candidates),
    checked: run.checked,
    suggested: run.suggested,
    outcomes: assignOutcomes(live.outcomes, run.checked, run.suggested),
    from: live.shown,
    at: now,
    polls: live.polls + 1,
  };
}

/** Where the view is at `now`. With reduced motion it is simply the server's count. */
export const shownAt = (live: LiveRun, now: number, reduced = false): number =>
  reduced ? live.checked : easeToward(live.from, live.checked, now - live.at);

/** Should the run be read again? Only while it runs, the tab is visible, and the cap is not reached. */
export const shouldPoll = (live: LiveRun, hidden: boolean): boolean => live.status === "running" && !hidden && live.polls < POLL_MAX;

export interface Particle {
  /** Across the track, 0 (left) to 1 (right). */
  x: number;
  /** Down from the track's top, px. */
  y: number;
  /** Opacity. */
  o: number;
  kind: "wait" | "move" | "fit" | "out";
}

export const particleCount = (candidates: number): number => Math.max(0, Math.min(PARTICLES_MAX, candidates));
const QUEUE_W = 0.3, FIT_X0 = 0.7, FIT_STEP = 0.02, OUT_X = 0.5, ROW = [3, 11];

/**
 * Every square's place at a moment: the candidates (`candidates`, drawn as at most `PARTICLES_MAX` squares,
 * each standing for one candidate), their outcomes so far, and how many the view has checked (`shown`,
 * fractional while one is on its way). A square waits in the queue, moves while its candidate is being
 * checked, then settles in the "may fit" group or fades out.
 */
export function particleFrame(candidates: number, outcomes: readonly Outcome[], shown: number): Particle[] {
  const n = particleCount(candidates);
  let fitRank = 0;
  const out: Particle[] = [];
  for (let i = 0; i < n; i++) {
    const ci = Math.floor((i * candidates) / n);
    const y = ROW[i % 2];
    const queueX = (QUEUE_W * i) / Math.max(1, n);
    const t = shown - ci; // > 0 once its candidate is being checked; ≥ 1 once checked
    const outcome = outcomes[ci];
    if (t <= 0 || !outcome) { out.push({ x: queueX, y, o: 1, kind: "wait" }); continue; }
    const destX = outcome === "fit" ? Math.min(0.98, FIT_X0 + FIT_STEP * fitRank) : OUT_X;
    const destY = outcome === "fit" ? ROW[fitRank % 2] : y;
    if (outcome === "fit") fitRank++;
    if (t >= 1) { out.push({ x: destX, y: destY, o: outcome === "fit" ? 1 : 0, kind: outcome }); continue; }
    out.push({ x: queueX + (destX - queueX) * t, y: y + (destY - y) * t, o: outcome === "fit" ? 1 : 1 - t, kind: "move" });
  }
  return out;
}

/** How many of the shown checks fit — what the counter says (never ahead of the squares). */
export const shownFits = (outcomes: readonly Outcome[], shown: number): number =>
  outcomes.slice(0, Math.floor(shown + 1e-9)).filter((o) => o === "fit").length;

/** The counter's words. */
export function runCounter(live: Pick<LiveRun, "status" | "candidates" | "checked" | "outcomes">, shown: number): string {
  const c = Math.floor(shown + 1e-9);
  const fits = shownFits(live.outcomes, shown);
  if (live.status === "running" && live.candidates === 0) return "Picking items to check…";
  if (live.status !== "running" && live.candidates === 0) return "Nothing in this organization to check yet.";
  if (live.status === "capped" && c >= live.checked) return `Stopped at ${live.checked} of ${live.candidates}: this month's checks are used up.`;
  if (live.status === "failed" && c >= live.checked) return `Stopped at ${live.checked} of ${live.candidates}: the model did not answer.`;
  if (live.status === "done" && c >= live.checked && live.checked > 0 && fits === 0) return `Checked ${live.checked} — none fit.`;
  return `Checked ${c} of ${live.candidates} · ${fits} may fit`;
}

/** The inline style of one square. */
export const particleStyle = (p: Particle): string => `--x:${p.x.toFixed(4)};--y:${p.y.toFixed(2)}px;opacity:${p.o.toFixed(3)}`;

/** The live view in a tag's row: the track of squares, the reduced-motion bar, the counter. */
export function fitRunView(tag: string, color: string, live: LiveRun): string {
  const shown = live.shown;
  const parts = particleFrame(live.candidates, live.outcomes, shown);
  const share = live.candidates > 0 ? Math.min(1, shown / live.candidates) : 0;
  return `<div class="cnpy-fitrun" data-fitrun="${attr(tag)}" data-status="${live.status}" data-n="${parts.length}" data-morph-key="fitrun:${attr(tag)}" style="--fit-c:${tagTone(color)}">
      <div class="cnpy-fitrun-track" aria-hidden="true">${parts.map((p, i) => `<i class="cnpy-fp" data-p="${i}" data-kind="${p.kind}" style="${particleStyle(p)}"></i>`).join("")}</div>
      <div class="cnpy-fitrun-bar" aria-hidden="true"><span style="transform:scaleX(${share.toFixed(4)})"></span></div>
      <span class="cnpy-fitrun-n" role="status" aria-live="polite" data-fitrun-n>${esc(runCounter(live, shown))}</span>
    </div>`;
}
