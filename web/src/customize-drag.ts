// Customize sidebar's order by dragging (library.ts `customizeSidebarDialog`) — on the app's one pointer drag
// (pointer-drag.ts: mouse and pen only, the slop, Escape, the held paints), and drawn as the ticket board draws its
// cards: the pressed row LIFTS (a ghost of it follows the pointer up and down, with the board's shadow), an empty gap
// of its height holds its place, and the other rows SLIDE out of the way as soon as the ghost overlaps one by a third
// (`OVERLAP`) — only the rows on the side it is heading for, measured on their resting places, so none flips back. On release the ghost glides
// into the gap and the new order goes to `commit` (main.ts → `libCustomizeOrder`); Escape puts the row back. A press on a row's own button (remove) is not a drag. The keyboard does the same with
// Alt+↑ / Alt+↓ on a focused row (main.ts → `libCustomizeUp` / `Down`).
// `slideRows` is the slide on its own: every other change to the dialog's lists (Reset to the Library's order, Add,
// remove, Alt+arrows) runs its repaint inside it, so each row moves from where it was to where it lands.
import { pointerDrag } from "./pointer-drag";
import { pointOf, rectOf } from "./zoom";

const SLIDE_MS = 160;   // the board's: Reset, Add, remove, Alt+arrows
const DRAG_SLIDE_MS = 110; // a row getting out of the ghost's way
const OVERLAP = 0.33;
const EASE = "cubic-bezier(.2,.7,.2,1)";

interface Press {
  row: HTMLElement; list: HTMLElement; x: number; y: number; dy: number; lastTop: number;
  ghost: HTMLElement | null; slot: HTMLElement | null; homeNext: Element | null;
}

export interface CustomizeDragHost {
  /** The new order of the picked slugs, after a drop. */
  commit(order: string[]): void;
  /** A cancelled drag (Escape): repaint, so the list is drawn from the state again. */
  cancel(): void;
  reducedMotion(): boolean;
}

/** Run `change` (a repaint, or a DOM move) and slide every Customize row (`data-libc`) from where it was to where it
 *  is now — matched by its slug, so a row that changed lists (Add, remove) slides across too. */
export function slideRows(root: ParentNode, change: () => void, reduce: boolean, ms = SLIDE_MS): void {
  const rows = () => new Map([...root.querySelectorAll<HTMLElement>("#lib-customize [data-libc]")].map((el) => [el.dataset.libc as string, el]));
  const before = new Map([...rows()].map(([k, el]) => [k, rectOf(el).top]));   // CSS px (zoom.ts), as the translate is
  change();
  if (reduce) return;
  for (const [k, el] of rows()) {
    const was = before.get(k);
    if (was === undefined || el.classList.contains("is-lifted")) continue;
    const dy = was - rectOf(el).top;
    if (Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: ms, easing: EASE });
  }
}

/** The picked rows that take part in the layout (not the lifted one, not the slot). */
const liveRows = (list: Element): HTMLElement[] =>
  [...list.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute("data-cdrag") && !el.classList.contains("is-lifted"));

export function installCustomizeDrag(mount: HTMLElement, host: CustomizeDragHost): void {
  const clear = (p: Press) => {
    p.slot?.remove();
    p.ghost?.remove();
    p.row.classList.remove("is-lifted");
  };
  pointerDrag<Press>(mount, {
    press(target, e) {
      if (target.closest("button")) return null;
      const row = target.closest<HTMLElement>("#lib-customize [data-cdrag]");
      const list = row?.parentElement;
      return row && list ? { row, list, x: e.clientX, y: e.clientY, dy: 0, lastTop: 0, ghost: null, slot: null, homeNext: null } : null;
    },
    // The ghost is placed in CSS px (zoom.ts): `rectOf` / `pointOf`, so under the big-screen zoom it stays under the
    // pointer; the hit tests stay in raw client px.
    begin(p) {
      const r = rectOf(p.row);
      p.dy = pointOf({ clientX: p.x, clientY: p.y }).y - r.top;
      p.lastTop = r.top;
      const ghost = p.row.cloneNode(true) as HTMLElement;
      ghost.classList.add("cnpy-libc-ghost");
      ghost.removeAttribute("data-cdrag");
      ghost.removeAttribute("data-libc");
      ghost.removeAttribute("data-morph-key");
      ghost.removeAttribute("tabindex");
      ghost.setAttribute("aria-hidden", "true");
      for (const b of ghost.querySelectorAll("[data-act]")) b.removeAttribute("data-act");
      ghost.style.width = `${r.width}px`;
      ghost.style.height = `${r.height}px`;
      ghost.style.left = `${r.left}px`;
      ghost.style.top = `${r.top}px`;
      // Inside the app's theme root, so the row's colors resolve exactly as in the dialog.
      (mount.firstElementChild ?? document.body).appendChild(ghost);
      const slot = document.createElement("li");
      slot.className = "cnpy-libc-slot";
      slot.setAttribute("aria-hidden", "true");
      slot.style.height = `${r.height}px`;
      p.homeNext = p.row.nextElementSibling;
      p.list.insertBefore(slot, p.row);
      p.row.classList.add("is-lifted");
      p.ghost = ghost; p.slot = slot;
    },
    over(p, e) {
      const { ghost, slot } = p;
      if (!ghost || !slot) return;
      const top = pointOf(e).y - p.dy;                // up and down only: the list is one column
      ghost.style.top = `${top}px`;
      const dir = Math.sign(top - p.lastTop);
      p.lastTop = top;
      if (!dir) return;
      // Only the rows on the side the ghost is heading for give way, judged on their RESTING places (their layout, not
      // a slide's transform) in the ghost's CSS px: heading down, a row below the gap moves up once the ghost's bottom
      // is a third into it; heading up, a row above moves down once its top is. So a row never flips straight back.
      const bottom = top + slot.offsetHeight;
      const base = rectOf(p.list).top - p.list.offsetTop;
      const rows = liveRows(p.list);
      let gap = rows.findIndex((r) => !(r.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (gap === -1) gap = rows.length;
      let to = gap;
      if (dir > 0) while (to < rows.length && bottom > base + rows[to].offsetTop + rows[to].offsetHeight * OVERLAP) to++;
      else while (to > 0 && top < base + rows[to - 1].offsetTop + rows[to - 1].offsetHeight * (1 - OVERLAP)) to--;
      if (to === gap) return;
      const ref = rows[to] ?? null;
      slideRows(p.list, () => p.list.insertBefore(slot, ref), host.reducedMotion(), DRAG_SLIDE_MS);
    },
    drop(p, commit, done) {
      const { ghost, slot } = p;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (slot?.parentElement) {
          if (commit) p.list.insertBefore(p.row, slot);
          else p.list.insertBefore(p.row, p.homeNext);
        }
        clear(p);
        const order = liveRows(p.list).map((r) => r.dataset.cdrag as string);
        done();
        if (commit) host.commit(order); else host.cancel();
      };
      if (!ghost || !slot || !commit || host.reducedMotion()) { finish(); return; }
      // Glide the lifted row into its slot, then commit.
      const s = rectOf(slot);
      const g = rectOf(ghost);
      const anim = ghost.animate(
        [{ transform: "none" }, { transform: `translate(${s.left - g.left}px, ${s.top - g.top}px)`, boxShadow: "none" }],
        { duration: 150, easing: EASE, fill: "forwards" },
      );
      anim.onfinish = finish;
      anim.oncancel = finish;
      setTimeout(finish, 400);   // a paused animation (a background tab) never strands the drop
    },
  });
}
