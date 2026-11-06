// One step of a flow giving way to the next, as a morph and not a snap: the browser snapshots the
// page, `change` repaints it, and anything that carries the same `view-transition-name` on both sides
// (a first-run card: `.cnpy-orgs-card`) glides from its old box to its new
// one while the rest cross-fades. So two steps of different heights grow or shrink into each other.
//
// Where View Transitions are not available, the tab is hidden, or the person asked for reduced motion,
// `change` simply runs.
//
// With a transition, `change` runs LATER — the browser calls it once the old page is captured, after this returns.
// So whatever must see the new step (focus its heading, read its state) waits for the promise this returns: it
// settles once `change` has run (the transition's `updateCallbackDone`), at once when there is no transition.
// And a guard that must stop a second click is set BEFORE calling this, not inside `change`.

type Doc = Document & { startViewTransition?: (cb: () => void) => { updateCallbackDone?: Promise<unknown> } | undefined };

export function morphStep(change: () => void): Promise<void> {
  const d = typeof document === "undefined" ? null : (document as Doc);
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!d?.startViewTransition || still || d.hidden) { change(); return Promise.resolve(); }
  let t: { updateCallbackDone?: Promise<unknown> } | undefined;
  try { t = d.startViewTransition(change); } catch { change(); return Promise.resolve(); }
  // Settled either way: a `change` that threw is the caller's to see in the console, not a reason to skip what follows.
  return Promise.resolve(t?.updateCallbackDone).then(() => undefined, () => undefined);
}
