// The docs pane's acts (docs-library.md › The page tree): open and close a page's children, the row's "…" menu (Copy
// link, Move to the top level), a page inside one ("+"), the doc page's On this page, and a MOVE — from a drop
// (tree-drag.ts), the keyboard or the menu. A move is applied at once (`planMove` + `applyMove`, the rules the Worker
// runs too), posted (`POST /doc/:slug/move`), and toasted with Undo (the reverse move); a refusal puts the tree back
// and says why in words. The views are docs-pane.ts / doc-page.ts (pure).
import { applyMove, buildTree, childrenOf, ancestorsOf, planMove, type MoveTarget, type MoveRefusal } from "@shared/docs-tree-core";
import type { LibraryPageDTO, DocTreePlace } from "@shared/docs-core";
import type { AppState, ToastAction } from "./render";
import { ApiError, PreviewBlocked, Unauthorized, moveDoc } from "./api";
import { expandedSet } from "./docs-pane";
import { MAX_DEPTH } from "@shared/docs-tree-core";

export interface TreeHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  flash(msg: string, ms?: number, action?: ToastAction | null): void;
  unauth(e: unknown): void;
  /** Flash these rows once after the next paint (main.ts `pendingFlash`). */
  flashNext(selector: string): void;
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
    const back = placeOf(before, slug);
    setPages(applyMove(before, slug, plan));
    if (target.kind === "into") state.treeOpen[target.ref] = true;
    state.treeMenu = null;
    host.flashNext(`.cnpy-dpane [data-dtree="${CSS.escape(slug)}"]`);
    host.rerender();
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

  function scrollToHeading(id: string): void {
    const scroller = host.mount.querySelector<HTMLElement>("#cnpy-libmain");
    const target = scroller?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (!scroller || !target) return;
    const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24;
    scroller.scrollTo({ top, behavior: host.reducedMotion() ? "auto" : "smooth" });
  }

  function act(act: string, arg: string | null): boolean {
    switch (act) {
      case "treeToggle": {
        const list = pages();
        if (!arg || !list) return true;
        const open = expandedSet(list, state.screen === "docs" ? state.docSlug : null, state.treeOpen).has(arg);
        state.treeOpen[arg] = !open;
        host.rerender();
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
