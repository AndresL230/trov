// The segmented switch — THE one component for every "pick one of a few" control in the
// app (Feed view, Roadmap tabs, the queue's Board/Table and Open/Closed, the Repo ranges,
// an artifact's status, …). Never hand-roll a segment group: use this, so they all look
// and move the same.
//
// Motion: the picked option's fill is ONE indicator (`.cnpy-seg-ind`) that slides to the
// new option. `rerender()` swaps <main> wholesale, so the switch that was clicked is not
// the element on screen afterwards — `syncSegments` (run after every paint) remembers each
// switch's indicator box by its `id` and plays the slide from the old box to the new one
// (FLIP). Until it runs (first paint), the picked button carries the fill itself, so the
// markup is right with no script at all. Off under prefers-reduced-motion. The indicator is
// `data-keep`: on a page patched in place (morph.ts) it is left to this module alone.
//
// Keyboard: a switch is ONE Tab stop, on the picked option (a roving tabindex: the picked
// option is tabindex 0, the rest -1; nothing picked, or the picked one locked → the first
// option that is not locked). It is a group of toggle buttons (role="group", aria-pressed),
// so ←/→ move FOCUS between its options (skipping locked ones, wrapping) and Home/End jump —
// Enter / Space picks, as on any button. A move never picks: an option's act may save (an
// artifact's status, a notification cadence), and one arrow press is not a choice.
// `onSegmentedKey` is wired once in main.ts.
//
// Pure markup plus `segKeyTarget`; `syncSegments` and `onSegmentedKey` are the only DOM
// code, the styles live in trov.css.

import { esc, attr } from "./ui";
import { tabKeyTarget } from "./tabs";

export interface SegOption {
  value: string;
  /** Plain text (escaped here). */
  label: string;
  /** Pre-rendered markup before the label (an icon). */
  icon?: string;
  /** Pre-rendered markup after the label (a dot, a count). */
  trail?: string;
  /** Override the switch's act / the arg (default: the switch's `act`, arg = `value`). */
  act?: string;
  arg?: string;
  title?: string;
  /** Shown but not pickable: dimmed, no act. */
  locked?: boolean;
  /** Tint of the fill when this option is picked. */
  tone?: "accent";
}

export interface SegmentedProps {
  /** Stable name — the slide animates between two renders of the same id. */
  id: string;
  ariaLabel: string;
  value: string;
  /** The `data-act` each option dispatches (with `data-arg` = its value). */
  act: string;
  options: SegOption[];
  /** md = header chrome, sm = in-page toolbars, xs = compact (inline in a toolbar row). */
  size?: "md" | "sm" | "xs";
  /** The picked option carries no act, so re-pressing it replays nothing. */
  inertOn?: boolean;
  /** Stretch across the parent, equal segments (a form field). */
  fill?: boolean;
  /** Extra classes on the group (a screen's flash hook). */
  className?: string;
}

export function segmented(p: SegmentedProps): string {
  const size = p.size ?? "md";
  // The one Tab stop: the picked option, else the first that is not locked.
  const picked = p.options.findIndex((o) => o.value === p.value && !o.locked);
  const stop = picked >= 0 ? picked : p.options.findIndex((o) => !o.locked);
  const btns = p.options.map((o, i) => {
    const on = o.value === p.value;
    const act = o.act ?? p.act;
    const live = !o.locked && !(on && p.inertOn);
    return `<button type="button" tabindex="${i === stop ? 0 : -1}" class="cnpy-seg-btn${on ? " is-on" : ""}"${live ? ` data-act="${attr(act)}" data-arg="${attr(o.arg ?? o.value)}"` : ""}${o.locked ? " disabled" : ""}${o.tone ? ` data-tone="${o.tone}"` : ""} aria-pressed="${on}"${o.title ? ` title="${attr(o.title)}"` : ""}>${o.icon ?? ""}${esc(o.label)}${o.trail ?? ""}</button>`;
  }).join("");
  return `<div class="cnpy-seg cnpy-seg--${size}${p.fill ? " cnpy-seg--fill" : ""}${p.className ? ` ${attr(p.className)}` : ""}" data-seg="${attr(p.id)}" data-morph-key="seg:${attr(p.id)}" role="group" aria-label="${attr(p.ariaLabel)}"><span class="cnpy-seg-ind" aria-hidden="true" data-keep></span>${btns}</div>`;
}

/** Where a key moves focus from option `at` (`locked[i]`: option i cannot take focus):
 *  ←/→ step over the open options (wrapping), Home/End jump; null = not a switch key. */
export function segKeyTarget(key: string, at: number, locked: boolean[]): number | null {
  const open = locked.flatMap((l, i) => (l ? [] : [i]));
  const to = tabKeyTarget(key, open.indexOf(at), open.length);
  return to === null ? null : open[to];
}

/** A switch's keyboard: move focus (and the roving Tab stop) to the target option. */
export function onSegmentedKey(e: KeyboardEvent): void {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const btn = (e.target as Element | null)?.closest?.<HTMLButtonElement>(".cnpy-seg > .cnpy-seg-btn");
  const seg = btn?.parentElement;
  if (!btn || !seg) return;
  const btns = Array.from(seg.querySelectorAll<HTMLButtonElement>(":scope > .cnpy-seg-btn"));
  const to = segKeyTarget(e.key, btns.indexOf(btn), btns.map((b) => b.disabled));
  if (to === null) return;
  e.preventDefault();
  for (const [i, b] of btns.entries()) b.tabIndex = i === to ? 0 : -1;
  btns[to].focus();
}

interface Box { x: number; y: number; w: number; h: number }
const boxes = new Map<string, Box>();

/** Place every switch's indicator under its picked option, sliding from where the same
 *  switch's indicator was on the previous paint. Call after each paint. */
export function syncSegments(root: ParentNode, opts: { instant?: boolean } = {}): void {
  const reduced = typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const seen = new Set<string>();
  for (const seg of Array.from(root.querySelectorAll<HTMLElement>(".cnpy-seg[data-seg]"))) {
    const id = seg.dataset.seg ?? "";
    const ind = seg.querySelector<HTMLElement>(":scope > .cnpy-seg-ind");
    const on = seg.querySelector<HTMLElement>(":scope > .cnpy-seg-btn.is-on");
    if (!ind || !on || !on.offsetWidth) { seg.classList.remove("is-live"); continue; }   // hidden, or nothing picked
    seen.add(id);
    const next: Box = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
    const place = (b: Box) => {
      ind.style.transform = `translate(${b.x}px, ${b.y}px)`;
      ind.style.width = `${b.w}px`;
      ind.style.height = `${b.h}px`;
    };
    if (on.dataset.tone) ind.dataset.tone = on.dataset.tone; else delete ind.dataset.tone;
    const prev = boxes.get(id);
    const moved = prev && (prev.x !== next.x || prev.w !== next.w || prev.y !== next.y);
    if (moved && !reduced && !opts.instant) {
      ind.classList.remove("is-sliding");
      place(prev);
      seg.classList.add("is-live");
      void ind.offsetWidth;            // commit the old box before the transition starts
      ind.classList.add("is-sliding");
      place(next);
    } else {
      place(next);
      seg.classList.add("is-live");
    }
    boxes.set(id, next);
  }
  // A switch that left the screen starts fresh when it comes back — no slide on entry.
  for (const id of Array.from(boxes.keys())) if (!seen.has(id)) boxes.delete(id);
}
