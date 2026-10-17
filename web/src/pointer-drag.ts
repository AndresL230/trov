// The app's pointer drag, ONCE — the press → drag → drop lifecycle every draggable list shares (the ticket board's
// cards, main.ts; the docs pane's pages, tree-drag.ts). What each one draws while it drags (a lifted card and its
// slot; a ghost chip, a drop line, a ringed row) and what a drop commits are its own HANDLERS; this module owns the
// rules they have in common:
//   • mouse and pen only — on touch a press must still scroll the list;
//   • a press becomes a drag only past DRAG_SLOP px, so a plain click still opens what was pressed, and the click a
//     real drag's release fires is swallowed (it is not an "open");
//   • Escape and pointercancel cancel; pointerup drops;
//   • while a drag is on (and while its drop settles), paints are held — the DOM IS the drag state — and the paint
//     that was held runs once it is over (`onIdle`).
// One drag at a time across every engine.

export const DRAG_SLOP = 5;

export interface DragHandlers<P> {
  /** A press on `target`: this engine's payload when it is one of its rows, else null (not ours). */
  press(target: Element, e: PointerEvent): P | null;
  /** The press moved past the slop: lift it (build the ghost, mark the row). */
  begin(p: P, e: PointerEvent): void;
  /** The pointer moved while dragging. */
  over(p: P, e: PointerEvent): void;
  /** Released (`commit`) or cancelled. Call `done()` once the drop has settled (an animation may run first); the
   *  drag holds paints until then. */
  drop(p: P, commit: boolean, done: () => void): void;
}

interface Live { handlers: DragHandlers<unknown>; p: unknown; x: number; y: number; begun: boolean; settling: boolean }

let live: Live | null = null;
let swallowClick = false;
const idlers: (() => void)[] = [];
let installed: HTMLElement | null = null;

/** Is a drag (or its drop's settling) on? main.ts holds every paint while it is. */
export const dragging = (): boolean => live !== null && live.begun;

function finish(): void {
  live = null;
  document.documentElement.classList.remove("cnpy-grabbing");
  for (const f of idlers) f();
}

function end(commit: boolean): void {
  const d = live;
  if (!d || d.settling) return;
  if (!d.begun) { live = null; return; }            // a plain click: let it open what was pressed
  swallowClick = true;                               // the click this release fires is not an "open"
  setTimeout(() => { swallowClick = false; }, 0);
  d.settling = true;
  let once = false;
  d.handlers.drop(d.p, commit, () => { if (once) return; once = true; finish(); });
}

function install(mount: HTMLElement): void {
  if (installed === mount) return;
  installed = mount;
  document.addEventListener("pointermove", (e) => {
    const d = live;
    if (!d || d.settling) return;
    if (!d.begun) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_SLOP) return;
      d.begun = true;
      document.documentElement.classList.add("cnpy-grabbing");
      d.handlers.begin(d.p, e);
    }
    e.preventDefault();                              // no text selection mid-drag
    d.handlers.over(d.p, e);
  });
  document.addEventListener("pointerup", () => end(true));
  document.addEventListener("pointercancel", () => end(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && live?.begun) { e.preventDefault(); end(false); } });
  mount.addEventListener("click", (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

/**
 * Register one draggable list on `mount`. `onIdle` runs after every drag of ANY engine ends (main.ts runs the paint it
 * held). Returns nothing: the engine is the document's listeners plus `dragging()`.
 */
export function pointerDrag<P>(mount: HTMLElement, handlers: DragHandlers<P>, onIdle?: () => void): void {
  install(mount);
  if (onIdle) idlers.push(onIdle);
  mount.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.pointerType === "touch" || live) return;
    const target = e.target as Element | null;
    if (!target?.closest) return;
    const p = handlers.press(target, e);
    if (p === null) return;
    live = { handlers: handlers as DragHandlers<unknown>, p, x: e.clientX, y: e.clientY, begun: false, settling: false };
  });
}
