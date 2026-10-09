// One step of a flow giving way to the next, as a morph and not a snap: the browser snapshots the
// page, `change` repaints it, and anything that carries the same `view-transition-name` on both sides
// (a first-run card: `.cnpy-orgs-card`) glides from its old box to its new
// one while the rest cross-fades. So two steps of different heights grow or shrink into each other.
//
// Where View Transitions are not available, the tab is hidden, or the person asked for reduced motion,
// `change` simply runs.

type Doc = Document & { startViewTransition?: (cb: () => void) => unknown };

export function morphStep(change: () => void): void {
  const d = typeof document === "undefined" ? null : (document as Doc);
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!d?.startViewTransition || still || d.hidden) { change(); return; }
  try { d.startViewTransition(change); } catch { change(); }
}
