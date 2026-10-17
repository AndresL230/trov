// Dragging a page in the docs pane (design spec §1.3) — on the app's one pointer drag (pointer-drag.ts: the slop, the
// swallowed click, Escape, the held paints). What this adds is the TREE's drop:
//   • the hit zones: over a row, its top 30% is "before", its bottom 30% "after", the middle "into"; the pane's head
//     row is "the top level of the space"; the pointer must stay within the rows' x range (−24px … +40px of slack);
//   • a target the tree's rules refuse (the page itself, a page under it, too deep — `planMove`, the SAME function the
//     Worker's move route runs) is no target at all;
//   • the ghost (a chip with the title, and a pill saying where it goes: "Put inside ‹Title›", "Move above ‹Title›",
//     "Move below ‹Title›", "Move to the top level of ‹Space›"), the 2px drop line with its square handle, and the
//     ringed "into" row;
//   • on release, `commit(slug, target)`: main.ts applies the move at once (`applyMove`), posts it, and offers Undo.
// The keyboard does the same without a pointer (`treeKeyTarget`): on a focused row, Alt+↑ / Alt+↓ move it above the
// page before it / below the page after it, Alt+→ puts it inside the page before it, Alt+← takes it out to its
// parent's level.
import { buildTree, childrenOf, indentPx, planMove, type MoveTarget } from "@shared/docs-tree-core";
import { MAX_DEPTH } from "@shared/docs-tree-core";
import type { LibraryPageDTO } from "@shared/docs-core";
import { pointerDrag } from "./pointer-drag";
import { pointOf, rectOf } from "./zoom";

export interface TreeDragHost {
  /** The pages of the space whose pane holds `slug` (null while not read). */
  pages(): LibraryPageDTO[] | null;
  /** That space's name (the top-level hint). */
  spaceName(): string;
  /** A drop the rules accept. */
  commit(slug: string, target: MoveTarget): void;
}

interface TreePress {
  row: HTMLElement; slug: string; title: string;
  ghost: HTMLElement | null; hint: HTMLElement | null; line: HTMLElement | null;
  over: HTMLElement | null; target: MoveTarget | null;
}

/** The ghost's pill, by where the page would go. */
export function dropHint(target: MoveTarget | null, title: (slug: string) => string, space: string, refused?: string): string {
  if (refused) return refused;
  if (!target) return "Drag onto a page to put it inside";
  if (target.kind === "top") return `Move to the top level of ${space}`;
  if (target.kind === "into") return `Put inside ${title(target.ref)}`;
  return `${target.kind === "before" ? "Move above" : "Move below"} ${title(target.ref)}`;
}

/** The zone of a row the pointer is over: top 30% before, bottom 30% after, else into. */
export const rowZone = (y: number, top: number, height: number): "before" | "after" | "into" => {
  const f = height > 0 ? (y - top) / height : 0.5;
  return f < 0.3 ? "before" : f > 0.7 ? "after" : "into";
};

/** The move a key asks for on a focused row, or null. */
export function treeKeyTarget(pages: readonly LibraryPageDTO[], slug: string, key: string): MoveTarget | null {
  const tree = buildTree(pages);
  const me = tree.bySlug.get(slug);
  if (!me) return null;
  const parent = tree.parentOf.get(slug) ?? null;
  const sibs = childrenOf(tree, parent, me.space);
  const i = sibs.findIndex((n) => n.slug === slug);
  if (key === "ArrowUp") return i > 0 ? { kind: "before", ref: sibs[i - 1].slug } : null;
  if (key === "ArrowDown") return i >= 0 && i < sibs.length - 1 ? { kind: "after", ref: sibs[i + 1].slug } : null;
  if (key === "ArrowRight") return i > 0 ? { kind: "into", ref: sibs[i - 1].slug } : null;
  if (key === "ArrowLeft") return parent === null ? null : { kind: "after", ref: parent };
  return null;
}

const REFUSED_DEEP = `Pages go at most ${MAX_DEPTH} levels deep`;

export function installTreeDrag(mount: HTMLElement, host: TreeDragHost, onIdle?: () => void): void {
  const titleOf = (slug: string): string => host.pages()?.find((p) => p.slug === slug)?.title ?? slug;
  const clearOver = (p: TreePress) => {
    p.over?.classList.remove("is-into");
    p.over = null;
    if (p.line) p.line.hidden = true;
  };
  pointerDrag<TreePress>(mount, {
    press(target) {
      if (target.closest(".cnpy-dp-chev:not(.is-empty), .cnpy-dp-act, .cnpy-dp-menu")) return null;
      const row = target.closest<HTMLElement>(".cnpy-dpane [data-dtree]");
      if (!row || !host.pages()) return null;
      const slug = row.dataset.dtree as string;
      return { row, slug, title: titleOf(slug), ghost: null, hint: null, line: null, over: null, target: null };
    },
    begin(p) {
      p.row.classList.add("is-lifted");
      const root = mount.firstElementChild ?? document.body;
      const ghost = document.createElement("div");
      ghost.className = "cnpy-dp-ghost";
      ghost.setAttribute("aria-hidden", "true");
      const chip = document.createElement("div");
      chip.className = "cnpy-dp-chip";
      chip.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
      const t = document.createElement("span");
      t.textContent = p.title;
      chip.appendChild(t);
      const hint = document.createElement("div");
      hint.className = "cnpy-dp-hint";
      hint.textContent = dropHint(null, titleOf, host.spaceName());
      ghost.append(chip, hint);
      root.appendChild(ghost);
      const line = document.createElement("div");
      line.className = "cnpy-dp-line";
      line.hidden = true;
      line.innerHTML = `<i></i>`;
      root.appendChild(line);
      p.ghost = ghost; p.hint = hint; p.line = line;
    },
    over(p, e) {
      if (!p.ghost || !p.hint || !p.line) return;
      // The ghost and the line are placed in CSS px (zoom.ts); the hit tests stay in raw client px.
      const at = pointOf(e);
      p.ghost.style.left = `${at.x + 14}px`;
      p.ghost.style.top = `${at.y - 12}px`;
      const pane = p.row.closest<HTMLElement>(".cnpy-dpane");
      const pages = host.pages();
      clearOver(p);
      p.target = null;
      let refused: string | undefined;
      if (pane && pages) {
        const pr = pane.getBoundingClientRect();
        const inX = e.clientX >= pr.left - 24 && e.clientX <= pr.right + 40;
        const el = inX ? document.elementFromPoint(Math.min(Math.max(e.clientX, pr.left + 2), pr.right - 2), e.clientY) : null;
        const head = el?.closest<HTMLElement>("[data-dtree-head]");
        const row = el?.closest<HTMLElement>("[data-dtree]");
        let target: MoveTarget | null = null;
        let over: HTMLElement | null = null;
        if (head && pane.contains(head)) { target = { kind: "top" }; over = head; }
        else if (row && pane.contains(row) && row !== p.row) {
          const r = row.getBoundingClientRect();
          const zone = rowZone(e.clientY, r.top, r.height);
          target = { kind: zone, ref: row.dataset.dtree as string };
          over = row;
        }
        if (target) {
          const plan = planMove(pages, p.slug, target);
          if (!plan.ok) { if (plan.reason === "too_deep") refused = REFUSED_DEEP; target = null; over = null; }
        }
        p.target = target;
        if (target && over) {
          if (target.kind === "into" || target.kind === "top") { over.classList.add("is-into"); p.over = over; }
          else {
            const r = rectOf(over);
            const depth = Number(over.dataset.depth ?? 0);
            const left = r.left + 6 + indentPx(depth) + 4;
            p.line.style.left = `${left}px`;
            p.line.style.width = `${Math.max(12, r.right - 2 - left)}px`;
            p.line.style.top = `${(target.kind === "before" ? r.top : r.bottom) - 1}px`;
            p.line.hidden = false;
          }
        }
      }
      p.hint.textContent = dropHint(p.target, titleOf, host.spaceName(), refused);
    },
    drop(p, commit, done) {
      clearOver(p);
      p.row.classList.remove("is-lifted");
      p.ghost?.remove();
      p.line?.remove();
      done();
      if (commit && p.target) host.commit(p.slug, p.target);
    },
  }, onIdle);
}
