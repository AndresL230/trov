// ── The tour's dialog: opening, stepping, closing ────────────────────────────
// landing.ts draws a tour feature's dialog (`featureDialog`, a root-level `data-overlay`) from
// `state.siteFeature`; this module is everything around that render: how the card GROWS into the
// dialog and back, the keys, the focus, the scroll lock.
//
// How it opens and closes (`fxMode` picks, once per open or close):
//   • "vt"   — a View Transition. The card on the page and the dialog's panel carry the same
//              `view-transition-name` (`site-fx`) on either side of ONE repaint, so the browser grows
//              one box into the other while the page cross-fades to its dimmed self (trov.css
//              `html.site-fx-vt::view-transition-*`). The name is on the card only for that repaint.
//   • "css"  — View Transitions are missing, or the tab is hidden (Chrome skips them): the dialog
//              plays its keyframe entrance, and its exit before it is removed (`data-closing`, FX_EXIT_MS).
//   • "none" — reduced motion: it is simply there, then simply gone.
// A step (previous / next) is the same in every mode: the keyed `.site-fx-main` is replaced and its
// text and mockup play a short slide from the side moved to (CSS; off under reduced motion). The
// panel, its stage and its footer are not touched by a step: the frame never moves or resizes.
//
// ONE clock: every length and the curve are the custom properties `--fx-fast` / `--fx-base` /
// `--fx-slow` / `--fx-ease` on `:root` (trov.css); FX_EXIT_MS and FX_MOVE_MS mirror them. Only
// transform and opacity move. `data-moving` on the overlay promotes the moving layers
// (`will-change`) for the length of a move and is dropped after it.
//
// On a phone the dialog is a full-height sheet, and a swipe steps it: left for the next feature, right
// for the previous one (`swipeStep`). Pointer events, touch only; the panel is `touch-action:pan-y`
// (trov.css), so a vertical scroll stays the browser's — it cancels the pointer and nothing steps —
// and a sideways move is ours. Nothing follows the finger: the step plays its own short slide.
//
// Nothing here touches the page behind: it is `data-morph="landing"`, so every repaint patches it.

import { FX_EXIT_MS, FX_MOVE_MS, VT_CLASS, VT_NAME, fxMode, stepKey, swipeStep, trapIndex, type FeatureState } from "./site-feature-core";
export * from "./site-feature-core";

/** The focusable controls of a dialog, in order — what Tab cycles through. */
export function focusables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'));
}

type VT = { finished: Promise<unknown> };
type Doc = Document & { startViewTransition?: (cb: () => void) => VT };

export interface FeatureDeps {
  mount: HTMLElement;
  keys: readonly string[];
  get(): FeatureState | null;
  set(v: FeatureState | null): void;
  rerender(): void;
}

export function createFeatureCtl(d: FeatureDeps) {
  /** The feature whose row opened the dialog: focus goes back to its Explore button. */
  let opener: string | null = null;
  let closing = false;
  const env = () => ({
    vt: typeof (document as Doc).startViewTransition === "function",
    reduced: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    hidden: document.hidden,
  });
  const card = (key: string) => d.mount.querySelector<HTMLElement>(`.site-fxcard[data-fx="${key}"]`);
  const overlay = () => d.mount.querySelector<HTMLElement>('[data-overlay="feature"]');
  const onScreen = (el: HTMLElement): boolean => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };

  let settle = 0;
  /** Promote the moving layers for one move, then let them go. */
  const moving = (): void => {
    const el = overlay();
    if (!el) return;
    el.setAttribute("data-moving", "");
    clearTimeout(settle);
    settle = window.setTimeout(() => overlay()?.removeAttribute("data-moving"), FX_MOVE_MS + 120);
  };
  let unlock: (() => void) | null = null;

  // The window is the landing's scroller. Hiding its scrollbar would widen the page under the
  // dialog, so the width it took is handed back as padding: nothing behind moves.
  const lock = (): void => {
    if (unlock) return;
    const root = document.documentElement;
    const [o, p] = [root.style.overflow, root.style.paddingRight];
    const bar = innerWidth - root.clientWidth;
    root.style.overflow = "hidden";
    if (bar > 0) root.style.paddingRight = `${bar}px`;
    unlock = () => { root.style.overflow = o; root.style.paddingRight = p; unlock = null; };
  };

  /** Run `change` inside a View Transition that grows `el`'s box (named before or after the repaint). */
  const morph = (change: () => void, named: () => HTMLElement | null, when: "before" | "after"): void => {
    const root = document.documentElement;
    let el: HTMLElement | null = when === "before" ? named() : null;
    const done = () => { if (el) el.style.viewTransitionName = ""; root.classList.remove(VT_CLASS); };
    if (el) el.style.viewTransitionName = VT_NAME;
    root.classList.add(VT_CLASS);
    try {
      const t = (document as Doc).startViewTransition!(() => {
        if (when === "before" && el) el.style.viewTransitionName = "";
        change();
        if (when === "after") { el = named(); if (el) el.style.viewTransitionName = VT_NAME; }
      });
      t.finished.then(done, done);
    } catch { done(); change(); }
  };

  function open(arg: string): void {
    const key = arg.split(":")[0];
    if (!d.keys.includes(key) || d.get()) return;
    opener = key;
    closing = false;
    const mode = fxMode(env());
    const show = () => {
      lock();
      d.set({ key, dir: 0, mode });
      d.rerender();
      if (mode !== "none") moving();
      overlay()?.querySelector<HTMLElement>(".site-fx-x")?.focus({ preventScroll: true });
    };
    if (mode === "vt" && card(key)) morph(show, () => card(key), "before");
    else show();
  }

  function close(): void {
    const cur = d.get();
    if (!cur || closing) return;
    const hide = () => {
      closing = false;
      d.set(null);
      d.rerender();
      unlock?.();
      const back = opener ? d.mount.querySelector<HTMLElement>(`[data-act="openFeature"][data-arg="${opener}:btn"]`) : null;
      opener = null;
      back?.focus({ preventScroll: true });
    };
    const mode = fxMode(env());
    // The dialog shrinks into the card of the feature it is SHOWING, when that card is in view;
    // stepped away to one that is off screen, it leaves by its own exit instead of flying there.
    const target = card(cur.key);
    if (mode === "vt" && target && onScreen(target)) { morph(hide, () => card(cur.key), "after"); return; }
    if (mode === "none") { hide(); return; }
    closing = true;
    moving();
    overlay()?.setAttribute("data-closing", "");
    // A timer, not animationend: an animation that never runs (a hidden tab) emits no event.
    setTimeout(hide, FX_EXIT_MS);
  }

  function step(dir: -1 | 1): void {
    const cur = d.get();
    if (!cur || closing) return;
    d.set({ key: stepKey(d.keys, cur.key, dir), dir, mode: cur.mode });
    d.rerender();
    if (cur.mode !== "none") moving();
  }

  /** Document keydown while the dialog is open: Esc closes, ← / → step, Tab stays inside. */
  function onKey(e: KeyboardEvent): void {
    if (!d.get()) return;
    const panel = overlay()?.querySelector<HTMLElement>(".site-fx-panel");
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      step(e.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (e.key !== "Tab" || !panel) return;
    const list = focusables(panel);
    const to = list[trapIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey)];
    if (!to) return;
    e.preventDefault();
    to.focus();
  }

  // A swipe on the open dialog (touch or pen; a mouse drag selects text and is left alone).
  let touch: { id: number; x: number; y: number; t: number } | null = null;
  function onPointerDown(e: PointerEvent): void {
    touch = null;
    if (!d.get() || closing || e.pointerType === "mouse" || !e.isPrimary) return;
    if (!(e.target as Element | null)?.closest?.(".site-fx-panel")) return;
    touch = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
  }
  function onPointerUp(e: PointerEvent): void {
    const from = touch;
    touch = null;
    if (!from || from.id !== e.pointerId || !d.get()) return;
    const dir = swipeStep(e.clientX - from.x, e.clientY - from.y, e.timeStamp - from.t);
    if (dir) step(dir);
  }
  /** The browser took the gesture (a vertical scroll): it is not a swipe. */
  function onPointerCancel(): void { touch = null; }

  return { open, close, step, onKey, onPointerDown, onPointerUp, onPointerCancel };
}
