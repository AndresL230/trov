// When the app paints (web-ui.md › "Paints: now, batched, or once a frame").
//
// Every paint re-renders the whole app to a string and `paint()` (morph.ts) parses it, so a paint is
// tens to hundreds of milliseconds on a big screen. The boot starts a dozen and a half reads, and
// each one painted when it started and again when it landed: 25 full-app paints before the first
// screen settled. This module decides when a requested paint actually runs:
//
//  • `now()`   — the interactive paint (`rerender()`): it runs at once, because its callers focus
//                an element, measure, or read the DOM right after it. Inside a batch it only marks
//                the app dirty.
//  • `batch(fn)` — every `now()` / `soon()` inside `fn` is folded into ONE synchronous paint when
//                the outermost batch ends (the boot's `enterOrg`, `loadForScreen`), so the DOM is
//                current by the time `batch` returns.
//  • `soon()`  — a READ LANDING (a loader's `.then` / `.catch`): paints once, on the next animation
//                frame, however many reads land before it. A visible tab uses requestAnimationFrame;
//                a hidden one (where rAF never fires: a background tab, an automation tab) or an
//                environment without rAF uses a timeout instead, and a visible tab keeps a timeout as
//                a backstop in case it is hidden before the frame comes. Reads that land one after
//                another, each a frame or two apart (the boot's, from a busy Worker), would still
//                paint once each: so a landing paints no sooner than SOON_GAP_MS after the last
//                landing or batch paint (an interactive paint does not hold one back). The first
//                landing after a quiet spell paints on the next frame.
//
// Any paint clears a pending `soon()`: the paint just made has already drawn the state it would have.

export interface PaintScheduler {
  raf?: (cb: () => void) => number;
  cancelRaf?: (id: number) => void;
  timeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  /** True when a frame callback would not run (a hidden document). */
  hidden: () => boolean;
  /** A clock in milliseconds (performance.now). */
  now: () => number;
}

export interface PaintQueue {
  now(): void;
  soon(): void;
  batch<T>(fn: () => T): T;
  /** A `soon()` paint is waiting for its frame. */
  readonly pending: boolean;
  /** Paints actually made (for tests and the boot measurement). */
  readonly paints: number;
}

/** The backstop for a frame that never comes (the tab went hidden after the request). */
const FRAME_BACKSTOP_MS = 100;
/** A read landing paints no sooner than this after the previous paint (at most ~10 landing paints a second). */
export const SOON_GAP_MS = 100;

export function browserScheduler(): PaintScheduler {
  const hasRaf = typeof requestAnimationFrame === "function";
  return {
    raf: hasRaf ? (cb) => requestAnimationFrame(() => cb()) : undefined,
    cancelRaf: hasRaf ? (id) => cancelAnimationFrame(id) : undefined,
    timeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    hidden: () => typeof document !== "undefined" && document.hidden === true,
    now: () => performance.now(),
  };
}

export function createPaintQueue(paint: () => void, sched: PaintScheduler = browserScheduler()): PaintQueue {
  let depth = 0;
  let dirty = false;
  let frame: number | null = null;
  let timer: unknown = null;
  let paints = 0;
  let lastPaint = Number.NEGATIVE_INFINITY;

  const cancel = (): void => {
    if (frame !== null && sched.cancelRaf) sched.cancelRaf(frame);
    if (timer !== null) sched.clearTimeout(timer);
    frame = null;
    timer = null;
  };
  const run = (): void => {
    cancel();
    dirty = false;
    paints++;
    paint();
  };
  // A paint the gap is counted from: a landing's or a batch's (never an interactive one — a read
  // landing while someone types is not held back by their keystrokes). From its END, so a slow
  // paint is followed by time for input.
  const runSpaced = (): void => {
    try { run(); } finally { lastPaint = sched.now(); }
  };
  // The frame or its backstop, whichever comes first; the other is cancelled.
  const flush = (): void => {
    cancel();
    if (depth > 0) { dirty = true; return; }
    runSpaced();
  };

  // The next frame (with its backstop), or a timeout where no frame will come.
  const toFrame = (): void => {
    if (sched.raf && !sched.hidden()) {
      frame = sched.raf(flush);
      timer = sched.timeout(flush, FRAME_BACKSTOP_MS);
    } else {
      timer = sched.timeout(flush, 0);
    }
  };

  return {
    now() {
      if (depth > 0) { dirty = true; return; }
      run();
    },
    soon() {
      if (depth > 0) { dirty = true; return; }
      if (frame !== null || timer !== null) return;
      const wait = lastPaint + SOON_GAP_MS - sched.now();
      if (wait > 0) timer = sched.timeout(() => { timer = null; toFrame(); }, wait);
      else toFrame();
    },
    batch<T>(fn: () => T): T {
      depth++;
      try {
        return fn();
      } finally {
        depth--;
        if (depth === 0 && (dirty || frame !== null || timer !== null)) runSpaced();
      }
    },
    get pending() { return frame !== null || timer !== null; },
    get paints() { return paints; },
  };
}
