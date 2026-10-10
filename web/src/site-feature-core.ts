// The DOM-free half of the tour's dialog (web/src/site-feature.ts): its state, and the pure choices
// around it. Its own module so render.ts and landing.ts can name the state without pulling the
// controller (and the DOM types) into a program that has none.

export type FxMode = "vt" | "css" | "none";
/** `dir`: how the feature on screen was reached — 0 opened, 1 next, -1 previous. */
export interface FeatureState { key: string; dir: -1 | 0 | 1; mode: FxMode }

/** Exit animation length. MUST match `--fx-fast` in trov.css. */
export const FX_EXIT_MS = 180;
/** The longest move (the card growing into the dialog). MUST match `--fx-slow` in trov.css. */
export const FX_MOVE_MS = 300;
export const VT_NAME = "site-fx";
export const VT_CLASS = "site-fx-vt";

/** Which motion an open or a close gets. Reduced motion wins; a hidden tab cannot run a View Transition. */
export function fxMode(env: { vt: boolean; reduced: boolean; hidden: boolean }): FxMode {
  if (env.reduced) return "none";
  return env.vt && !env.hidden ? "vt" : "css";
}

/** The feature `dir` steps away from `cur`, wrapping at both ends. */
export function stepKey<K extends string>(keys: readonly K[], cur: string, dir: -1 | 1): K {
  const i = keys.indexOf(cur as K);
  return keys[((i < 0 ? 0 : i) + dir + keys.length) % keys.length];
}

/** A touch that left the dialog: is it a swipe to another feature? `dx` / `dy` are how far the finger
 *  travelled, `ms` how long it was down. A swipe is mostly sideways (twice as far across as down — the
 *  sheet scrolls vertically, and a scroll must never step), at least SWIPE_MIN_PX long, and quick.
 *  Swiping LEFT brings the next feature in from the right (1); swiping right, the previous one (-1). */
export const SWIPE_MIN_PX = 56;
export const SWIPE_MAX_MS = 700;
export function swipeStep(dx: number, dy: number, ms: number): -1 | 0 | 1 {
  if (ms > SWIPE_MAX_MS || Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

/** Where Tab / Shift+Tab lands inside a trapped set: the next one, wrapping; the first (or last) from outside. */
export function trapIndex(count: number, at: number, back: boolean): number {
  if (count <= 0) return -1;
  if (at < 0) return back ? count - 1 : 0;
  return (at + (back ? -1 : 1) + count) % count;
}
