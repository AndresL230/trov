// The docs pane's acts (docs-library.md › The page tree): open and close a page's children, the row's "…" menu (Copy
// link, Move to the top level), a page inside one ("+"), the doc page's On this page, and a MOVE — from a drop
// (tree-drag.ts), the keyboard or the menu. A move is applied at once (`planMove` + `applyMove`, the rules the Worker
// runs too), posted (`POST /doc/:slug/move`), and toasted with Undo (the reverse move); a refusal puts the tree back
// and says why in words. The views are docs-pane.ts / doc-page.ts (pure).
import { applyMove, buildTree, childrenOf, ancestorsOf, descendantsOf, planMove, samePlace, type MoveTarget, type MoveRefusal } from "@shared/docs-tree-core";
import type { LibraryPageDTO, DocTreePlace } from "@shared/docs-core";
import type { AppState, ToastAction } from "./render";
import { ApiError, PreviewBlocked, Unauthorized, moveDoc } from "./api";
import { expandedSet } from "./docs-pane";
import { MAX_DEPTH } from "@shared/docs-tree-core";
import { rectOf } from "./zoom";

export interface TreeHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  flash(msg: string, ms?: number, action?: ToastAction | null): void;
  unauth(e: unknown): void;
  /** Open New page in `space` under `parent`. */
  newPage(space: string, parent: string | null): void;
  /** Is motion reduced? */
  reducedMotion(): boolean;
  /** A move went through: what is drawn from the doc read (the open page's "Pages under", its breadcrumb) is read again. */
  treeChanged(): void;
}

export interface TreeController {
  act(act: string, arg: string | null, value: string | null): boolean;
  /** Move a page (a drop, a key, the menu). */
  move(slug: string, target: MoveTarget): void;
  /** The pages of the pane's space, when they are in. */
  pages(): LibraryPageDTO[] | null;
}

/** A refusal of a move, in words. */
export function moveRefusalText(code: string): string {
  switch (code as MoveRefusal | "archived" | "invalid") {
    case "cycle": return "A page can't go inside a page that is under it.";
    case "self": return "A page can't go next to or inside itself.";
    case "too_deep": return `Pages go at most ${MAX_DEPTH} levels deep.`;
    case "other_space": return "A page moves only within its own space.";
    case "archived": return "This space is archived. Restore it before moving its pages.";
    case "not_found": return "That page isn't there any more. Reload the page.";
    default: return "Couldn't move the page. Try again.";
  }
}

/** Where `slug` sits now, as a target that puts it back there: before the page after it, else after the page before
 *  it, else into its parent (or the top level). */
export function placeOf(pages: readonly LibraryPageDTO[], slug: string): MoveTarget {
  const tree = buildTree(pages);
  const me = tree.bySlug.get(slug);
  if (!me) return { kind: "top" };
  const parent = tree.parentOf.get(slug) ?? null;
  const sibs = childrenOf(tree, parent, me.space);
  const i = sibs.findIndex((n) => n.slug === slug);
  if (i >= 0 && i < sibs.length - 1) return { kind: "before", ref: sibs[i + 1].slug };
  if (i > 0) return { kind: "after", ref: sibs[i - 1].slug };
  return parent === null ? { kind: "top" } : { kind: "into", ref: parent };
}

/** The pages with each one's `path` (the ancestors' titles) recomputed after a move. */
function withPaths(pages: LibraryPageDTO[]): LibraryPageDTO[] {
  const tree = buildTree(pages);
  return pages.map((p) => ({ ...p, path: ancestorsOf(tree, p.slug).map((a) => a.title) }));
}

export function createTreeController(host: TreeHost): TreeController {
  const { state } = host;
  const space = () => state.spaceHome.data?.space ?? null;
  const pages = (): LibraryPageDTO[] | null => state.spaceHome.data?.pages ?? null;
  const titleOf = (slug: string) => pages()?.find((p) => p.slug === slug)?.title ?? slug;
  const setPages = (list: LibraryPageDTO[]) => {
    const h = state.spaceHome.data;
    if (h) state.spaceHome = { ...state.spaceHome, data: { ...h, pages: withPaths(list) } };
  };
  let undoNext: { slug: string; target: MoveTarget } | null = null;
  let seq = 0;

  function move(slug: string, target: MoveTarget, isUndo = false): void {
    const before = pages();
    const sp = space();
    if (!before || !sp) return;
    const plan = planMove(before, slug, target);
    if (!plan.ok) { host.flash(moveRefusalText(plan.reason), 4200); return; }
    const after = applyMove(before, slug, plan);
    if (samePlace(before, after, slug)) return;           // dropped where it already is: nothing to move, post or say
    const back = placeOf(before, slug);
    setPages(after);
    const first = rowTops();
    if (target.kind === "into") state.treeOpen[target.ref] = true;
    state.treeMenu = null;
    host.rerender();
    landMove(slug, first);
    // A page dropped into a long parent can land below the pane's fold: bring it into view.
    host.mount.querySelector<HTMLElement>(`.cnpy-dpane [data-dtree="${CSS.escape(slug)}"]`)?.scrollIntoView?.({ block: "nearest", behavior: host.reducedMotion() ? "auto" : "smooth" });
    const mine = ++seq;
    const title = titleOf(slug);
    moveDoc(slug, target.kind === "top" ? { target: "top" } : { target: target.kind, ref: target.ref })
      .then((r) => {
        // The Worker's places win (the same plan, unless someone moved a page meanwhile).
        const now = pages();
        if (now && mine === seq) {
          const at = new Map<string, DocTreePlace>(r.places.map((p) => [p.slug, p]));
          setPages(now.map((p) => { const w = at.get(p.slug); return w ? { ...p, parent_slug: w.parent_slug, tree_rank: w.tree_rank } : p; }));
        }
        host.treeChanged();
        if (isUndo) { host.flash(`Moved “${title}” back`); host.rerender(); return; }
        undoNext = { slug, target: back };
        const words = target.kind === "into" ? `Moved “${title}” inside ${titleOf(target.ref)}`
          : target.kind === "top" ? `Moved “${title}” to the top level of ${sp.name}` : `Moved “${title}”`;
        host.flash(words, 4200, { label: "Undo", act: "treeUndo", arg: slug });
        host.rerender();
      })
      .catch((e) => {
        if (e instanceof Unauthorized) { host.unauth(e); return; }
        if (mine === seq) setPages(before);
        host.flash(e instanceof PreviewBlocked ? "This is a preview: nothing is changed." : moveRefusalText(e instanceof ApiError ? e.message : ""), 5000);
        host.rerender();
      });
  }

  /** Where each pane row is now (CSS px, zoom.ts), by slug: the "first" of the move's FLIP. */
  function rowTops(): Map<string, number> {
    const at = new Map<string, number>();
    for (const r of Array.from(host.mount.querySelectorAll<HTMLElement>(".cnpy-dpane .cnpy-dp-row[data-dtree]"))) at.set(r.dataset.dtree as string, rectOf(r).top);
    return at;
  }

  /** After a move's repaint: the moved page (and the pages it carries) lands where it was dropped — it fades in over
   *  the gap the others open, its highlight tinted once — the rows that only shifted slide to their new place, and the
   *  rows a parent opened for the drop fade in. Every row is at its final place from the first frame; only the slide moves. Web Animations on the rows themselves, so the repaints that follow (the
   *  Worker's answer, the doc read again) rewriting a row's class or style never cut them short — a class-driven flash
   *  was stripped two frames in, and the tint snapped off. */
  function landMove(slug: string, first: Map<string, number>): void {
    if (host.reducedMotion() || typeof Element.prototype.animate !== "function") return;
    const carried = new Set([slug, ...descendantsOf(buildTree(pages() ?? []), slug).map((n) => n.slug)]);
    for (const r of Array.from(host.mount.querySelectorAll<HTMLElement>(".cnpy-dpane .cnpy-dp-row[data-dtree]"))) {
      const s = r.dataset.dtree as string;
      if (carried.has(s)) {
        r.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: 90, easing: "ease-out", fill: "backwards" });
        if (s === slug) {
          const accent = getComputedStyle(r).getPropertyValue("--accent").trim();
          if (accent) r.animate([{ offset: 0, backgroundColor: `color-mix(in srgb, ${accent} 18%, transparent)` }], { duration: 900, easing: "ease-out", pseudoElement: "::before" });
        }
        continue;
      }
      const was = first.get(s);
      // A row the drop's parent revealed fades in where it is — never an unfold, whose growing height would push the
      // landed page down while it appears (that drift read as floating).
      if (was === undefined) { r.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: 90, easing: "ease-out", fill: "backwards" }); continue; }
      const dy = was - rectOf(r).top;
      if (Math.abs(dy) > 0.5) r.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 220, easing: "cubic-bezier(.2,.7,.2,1)" });
    }
  }

  function scrollToHeading(id: string): void {
    const scroller = host.mount.querySelector<HTMLElement>("#cnpy-libmain");
    const target = scroller?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (!scroller || !target) return;
    const top = scroller.scrollTop + rectOf(target).top - rectOf(scroller).top - 24;   // CSS px (zoom.ts), as scrollTop is
    scroller.scrollTo({ top, behavior: host.reducedMotion() ? "auto" : "smooth" });
  }

  /** Pages whose children are folding away (a second click waits for the first). */
  const closing = new Set<string>();
  /** Fold a pane row open (from no height) or shut (to none): height and opacity, clipped while it runs. */
  function foldRow(row: HTMLElement, opening: boolean, delay = 0): Animation {
    const h = `${row.offsetHeight}px`;
    row.style.overflow = "hidden";
    const frames = [{ height: "0px", opacity: 0 }, { height: h, opacity: 1 }];
    const a = row.animate(opening ? frames : frames.reverse(), {
      duration: opening ? 200 : 150, delay, easing: opening ? "cubic-bezier(.2,.7,.2,1)" : "cubic-bezier(.4,0,.6,1)", fill: opening ? "backwards" : "forwards",
    });
    a.finished.then(() => { if (opening) row.style.overflow = ""; }, () => { row.style.overflow = ""; });
    return a;
  }

  function act(act: string, arg: string | null): boolean {
    switch (act) {
      case "treeToggle": {
        const list = pages();
        if (!arg || !list || closing.has(arg)) return true;
        const open = expandedSet(list, state.screen === "docs" ? state.docSlug : null, state.treeOpen).has(arg);
        const under = new Set(descendantsOf(buildTree(list), arg).map((n) => n.slug));
        const shown = (): HTMLElement[] => Array.from(host.mount.querySelectorAll<HTMLElement>(".cnpy-dpane .cnpy-dp-row[data-dtree]"))
          .filter((r) => under.has(r.dataset.dtree as string));
        const moving = !host.reducedMotion() && typeof Element.prototype.animate === "function";
        if (open && moving) {
          // Close: the rows under it fold away first (height and opacity), then the tree drops them.
          const rows = shown();
          closing.add(arg);
          host.mount.querySelector(`.cnpy-dpane [data-dtree="${CSS.escape(arg)}"] .cnpy-dp-chev`)?.classList.remove("is-open");   // it turns as they fold
          const done = () => { closing.delete(arg); state.treeOpen[arg] = false; host.rerender(); };
          if (!rows.length) { done(); return true; }
          let left = rows.length;
          for (const r of rows) foldRow(r, false).finished.then(() => { if (--left === 0) done(); }, () => { if (--left === 0) done(); });
          return true;
        }
        const before = new Set(shown());
        state.treeOpen[arg] = !open;
        host.rerender();
        // Open: the rows that just appeared unfold from the chevron's row, one after another.
        if (!open && moving) shown().filter((r) => !before.has(r)).forEach((r, i) => foldRow(r, true, Math.min(i, 6) * 18));
        return true;
      }
      case "treeMenu":
        state.treeMenu = arg && state.treeMenu !== arg ? arg : null;
        host.rerender();
        return true;
      case "treeCopyLink": {
        state.treeMenu = null;
        if (!arg) return true;
        const url = `${location.origin}${location.pathname}#doc/${encodeURIComponent(arg)}`;
        const done = () => { host.flash("Link copied"); host.rerender(); };
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => { host.flash("Couldn't copy the link."); host.rerender(); });
        else done();
        return true;
      }
      case "treeMoveTop": if (arg) move(arg, { kind: "top" }); return true;
      case "treeUndo": {
        const u = undoNext;
        undoNext = null;
        if (u && u.slug === arg) move(u.slug, u.target, true);
        return true;
      }
      case "treeNew": {
        state.treeMenu = null;
        const sp = space();
        if (sp && arg) host.newPage(sp.slug, arg);
        return true;
      }
      case "docToc": if (arg) scrollToHeading(arg); return true;
    }
    return false;
  }

  return { act, move, pages };
}
