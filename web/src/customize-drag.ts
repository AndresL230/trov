// Customize sidebar's order by dragging (library.ts `customizeSidebarDialog`) — on the app's one pointer drag
// (pointer-drag.ts: mouse and pen only, the slop, Escape, the held paints). A picked row (`data-cdrag`) is lifted
// and moves through the list as the pointer passes the middle of another row; the DOM is the drag state, and the
// drop hands the new order to `commit` (main.ts → `libCustomizeOrder`). A press on a row's own button (remove) is
// not a drag. The keyboard does the same with Alt+↑ / Alt+↓ on a focused row (main.ts → `libCustomizeUp` / `Down`).
import { pointerDrag } from "./pointer-drag";

interface Press { row: HTMLElement; list: HTMLElement }

export interface CustomizeDragHost {
  /** The new order of the picked slugs, after a drop. */
  commit(order: string[]): void;
  /** A cancelled drag (Escape): repaint, so the list is drawn from the state again. */
  cancel(): void;
}

export function installCustomizeDrag(mount: HTMLElement, host: CustomizeDragHost): void {
  pointerDrag<Press>(mount, {
    press(target) {
      if (target.closest("button")) return null;
      const row = target.closest<HTMLElement>("#lib-customize [data-cdrag]");
      const list = row?.parentElement;
      return row && list ? { row, list } : null;
    },
    begin(p) { p.row.classList.add("is-lifted"); },
    over(p, e) {
      const at = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-cdrag]");
      if (!at || at === p.row || at.parentElement !== p.list) return;
      const r = at.getBoundingClientRect();
      const below = e.clientY > r.top + r.height / 2;
      p.list.insertBefore(p.row, below ? at.nextElementSibling : at);
    },
    drop(p, commit, done) {
      p.row.classList.remove("is-lifted");
      const order = [...p.list.querySelectorAll<HTMLElement>("[data-cdrag]")].map((r) => r.dataset.cdrag as string);
      done();
      if (commit) host.commit(order); else host.cancel();
    },
  });
}
