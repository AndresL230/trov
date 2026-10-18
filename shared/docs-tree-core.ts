// The Docs Library's page tree — the rules, ONCE (zod-free and pure: the SPA imports it as a value).
// A doc sits in one space (`docs.space`), under one parent page (`docs.parent_slug`, NULL = the top level
// of its space) at a saved position among its siblings (`docs.tree_rank`, NULL = no position yet). The
// Worker's move route (`POST /doc/:slug/move`) and the docs pane's optimistic drop both run `planMove`
// below, so a drop lands exactly where the server puts it.
//
// Rules:
//   - At most MAX_DEPTH levels: the top level is depth 0, so the deepest page is depth MAX_DEPTH − 1.
//     A move checks the moved page's WHOLE subtree, not just the page. A page already deeper than that (stored
//     before the limit was lowered) stays where it is and reads as usual; it may move anywhere that does not take
//     its subtree deeper than it already goes — only moving deeper is refused.
//   - A page can never be moved under itself or one of its descendants (`cycle`), never next to or into
//     itself (`self`), and never to another space (`other_space`) — moves are same-space only.
//   - "into" appends the page as the target's LAST child; "top" appends it at the END of the space root;
//     "before" / "after" insert it as a sibling of the target.
//   - Sibling order (`treeOrder`): positioned pages by rank, then the unpositioned ones (every doc before
//     its first move, or a new one) A to Z by title, then slug. The first drop into a list holding an
//     unpositioned page renumbers the whole list in that visible order (`placeAmong`, placement-core).
//   - A page whose parent is missing (or sits in another space, or the data holds a loop) is drawn at the
//     top level of its own space, never lost.

import { placeAmong, RANK_STEP } from "./placement-core";

export { placeAmong, RANK_STEP } from "./placement-core";
export type { Placement, RankedKey } from "./placement-core";

/** The deepest a tree may go, in levels (the top level is level 1, depth 0): the owner's ruling, 5 (it was 6). */
export const MAX_DEPTH = 5;

export interface DocTreeNode {
  slug: string;
  parent_slug: string | null;
  tree_rank: number | null;
  space: string;
  title?: string | null;
  updated_at?: string | null;
}

/** Sibling order: ranked pages by rank, then unranked ones A to Z by title, then slug. */
export function treeOrder(a: DocTreeNode, b: DocTreeNode): number {
  const an = a.tree_rank === null || a.tree_rank === undefined;
  const bn = b.tree_rank === null || b.tree_rank === undefined;
  if (an !== bn) return an ? 1 : -1;
  if (!an && a.tree_rank !== b.tree_rank) return (a.tree_rank as number) - (b.tree_rank as number);
  const at = (a.title ?? a.slug).toLowerCase(), bt = (b.title ?? b.slug).toLowerCase();
  if (at !== bt) return at < bt ? -1 : 1;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

export interface DocTree<N extends DocTreeNode = DocTreeNode> {
  bySlug: Map<string, N>;
  /** The EFFECTIVE parent of each page (null = top level): a dangling, cross-space or looping parent is null. */
  parentOf: Map<string, string | null>;
  /** A page's children, in `treeOrder`. Pages with none have no entry. */
  children: Map<string, N[]>;
  /** Each space's top-level pages, in `treeOrder`. */
  roots: Map<string, N[]>;
}

/** Index a flat list of pages (any number of spaces) into a tree. */
export function buildTree<N extends DocTreeNode>(nodes: readonly N[]): DocTree<N> {
  const bySlug = new Map<string, N>();
  for (const n of nodes) bySlug.set(n.slug, n);
  const declared = (s: string): string | null => {
    const n = bySlug.get(s);
    const p = n?.parent_slug ?? null;
    if (p === null || p === s) return null;
    const pn = bySlug.get(p);
    return pn && pn.space === n!.space ? p : null;
  };
  // Break any loop in the stored parents: a page whose ancestor chain comes back to itself goes to the top.
  const parentOf = new Map<string, string | null>();
  for (const n of bySlug.values()) {
    let p = declared(n.slug);
    const seen = new Set<string>([n.slug]);
    let cur = p;
    while (cur !== null) {
      if (seen.has(cur)) { p = null; break; }
      seen.add(cur);
      cur = declared(cur);
    }
    parentOf.set(n.slug, p);
  }
  const children = new Map<string, N[]>();
  const roots = new Map<string, N[]>();
  for (const n of bySlug.values()) {
    const p = parentOf.get(n.slug) ?? null;
    const list = p === null ? roots.get(n.space) ?? roots.set(n.space, []).get(n.space)! : children.get(p) ?? children.set(p, []).get(p)!;
    list.push(n);
  }
  for (const l of children.values()) l.sort(treeOrder);
  for (const l of roots.values()) l.sort(treeOrder);
  return { bySlug, parentOf, children, roots };
}

/** A page's children (null = the top level of `space`), in tree order. */
export function childrenOf<N extends DocTreeNode>(tree: DocTree<N>, parent: string | null, space: string): N[] {
  return parent === null ? tree.roots.get(space) ?? [] : tree.children.get(parent) ?? [];
}

/** A page's ancestors, nearest LAST (root first) — the breadcrumb trail and the auto-expand set. */
export function ancestorsOf<N extends DocTreeNode>(tree: DocTree<N>, slug: string): N[] {
  const out: N[] = [];
  let p = tree.parentOf.get(slug) ?? null;
  while (p !== null) {
    out.unshift(tree.bySlug.get(p) as N);
    p = tree.parentOf.get(p) ?? null;
  }
  return out;
}

/** A page's depth (0 = top level). An unknown slug is -1. */
export function depthOf(tree: DocTree, slug: string): number {
  if (!tree.bySlug.has(slug)) return -1;
  return ancestorsOf(tree, slug).length;
}

/** Levels BELOW a page (0 = no children). An unknown slug is 0. */
export function subtreeHeight(tree: DocTree, slug: string): number {
  const kids = tree.children.get(slug);
  if (!kids || kids.length === 0) return 0;
  let h = 0;
  for (const k of kids) h = Math.max(h, subtreeHeight(tree, k.slug));
  return h + 1;
}

/** Every page below `slug`, depth-first in tree order. */
export function descendantsOf<N extends DocTreeNode>(tree: DocTree<N>, slug: string): N[] {
  const out: N[] = [];
  const walk = (s: string) => { for (const k of tree.children.get(s) ?? []) { out.push(k); walk(k.slug); } };
  walk(slug);
  return out;
}

/** Would putting `slug` under `newParent` make a loop (the parent is the page itself or below it)? */
export function wouldCycle(tree: DocTree, slug: string, newParent: string | null): boolean {
  let p = newParent;
  while (p !== null) {
    if (p === slug) return true;
    p = tree.parentOf.get(p) ?? null;
  }
  return false;
}

export interface FlatRow<N extends DocTreeNode = DocTreeNode> {
  node: N;
  depth: number;
  hasChildren: boolean;
}

/** One space's pages depth-first in tree order — the pane's rows. With `expanded`, only the children of
 *  expanded pages are walked (the top level always shows). */
export function flattenTree<N extends DocTreeNode>(tree: DocTree<N>, space: string, expanded?: ReadonlySet<string>): FlatRow<N>[] {
  const out: FlatRow<N>[] = [];
  const walk = (list: N[], depth: number) => {
    for (const n of list) {
      const kids = tree.children.get(n.slug) ?? [];
      out.push({ node: n, depth, hasChildren: kids.length > 0 });
      if (kids.length && (!expanded || expanded.has(n.slug))) walk(kids, depth + 1);
    }
  };
  walk(tree.roots.get(space) ?? [], 0);
  return out;
}

export type MoveTarget = { kind: "into" | "before" | "after"; ref: string } | { kind: "top" };

export type MoveRefusal = "not_found" | "cycle" | "too_deep" | "other_space" | "self";

export type MovePlan =
  | { ok: true; parent_slug: string | null; tree_rank: number; renumber: Map<string, number> | null }
  | { ok: false; reason: MoveRefusal };

/**
 * Where `slug` goes for a drop on `target`, or why it can't. `renumber` (when not null) is the new rank of
 * every OTHER page under the new parent — the caller writes those too. Pure: the same nodes and target give
 * the same plan in the Worker and the SPA.
 */
export function planMove(nodes: readonly DocTreeNode[] | DocTree, slug: string, target: MoveTarget): MovePlan {
  const tree = isTree(nodes) ? nodes : buildTree(nodes);
  const moved = tree.bySlug.get(slug);
  if (!moved) return { ok: false, reason: "not_found" };
  let parent: string | null;
  let space = moved.space;
  if (target.kind !== "top") {
    const ref = tree.bySlug.get(target.ref);
    if (!ref) return { ok: false, reason: "not_found" };
    if (ref.slug === slug) return { ok: false, reason: "self" };
    if (ref.space !== moved.space) return { ok: false, reason: "other_space" };
    space = ref.space;
    parent = target.kind === "into" ? ref.slug : tree.parentOf.get(ref.slug) ?? null;
  } else {
    parent = null;
  }
  if (wouldCycle(tree, slug, parent)) return { ok: false, reason: "cycle" };
  const depth = parent === null ? 0 : depthOf(tree, parent) + 1;
  const height = subtreeHeight(tree, slug);
  // Past the limit is refused only when it is deeper than the subtree already goes (a page stored deeper than the
  // limit may still be reordered or moved up).
  if (depth + height > MAX_DEPTH - 1 && depth > depthOf(tree, slug)) return { ok: false, reason: "too_deep" };

  const siblings = childrenOf(tree, parent, space).filter((n) => n.slug !== slug);
  let afterKey: string | null;
  if (target.kind === "into" || target.kind === "top") {
    afterKey = siblings.length ? siblings[siblings.length - 1].slug : null;
  } else {
    const i = siblings.findIndex((n) => n.slug === target.ref);
    afterKey = target.kind === "after" ? target.ref : i > 0 ? siblings[i - 1].slug : null;
  }
  const { rank, renumber } = placeAmong(siblings.map((n) => ({ key: n.slug, rank: n.tree_rank ?? null })), afterKey);
  return { ok: true, parent_slug: parent, tree_rank: rank, renumber };
}

function isTree(x: readonly DocTreeNode[] | DocTree): x is DocTree {
  return !Array.isArray(x) && (x as DocTree).bySlug instanceof Map;
}

/** Apply a successful plan to a flat list (the SPA's optimistic drop; the Worker writes the same values). */
export function applyMove<N extends DocTreeNode>(nodes: readonly N[], slug: string, plan: MovePlan): N[] {
  if (!plan.ok) return [...nodes];
  return nodes.map((n) => {
    if (n.slug === slug) return { ...n, parent_slug: plan.parent_slug, tree_rank: plan.tree_rank };
    const r = plan.renumber?.get(n.slug);
    return r === undefined ? n : { ...n, tree_rank: r };
  });
}

// ── Archive page / Restore (0083_doc_archive; docs-library.md › Archiving a page) ──

/** One page's new place (the archive's and the restore's writes). */
export interface TreePlace { slug: string; parent_slug: string | null; tree_rank: number }

/**
 * What archiving `slug` does to the tree it leaves (`nodes`: the space's pages in the Library, the page itself
 * included): its direct children move UP to its own parent (the same space), taking its place among its siblings in
 * their own order. The new sibling list — the siblings before it, its children, the siblings after it — is renumbered
 * in that visible order (RANK_STEP apart), so the saved order is the one the person saw. A page with no children
 * moves nothing (`places` is empty). Never deeper than before: each child goes up a level. Null when `slug` is not
 * among `nodes`.
 */
export function planArchive(nodes: readonly DocTreeNode[] | DocTree, slug: string): { parent_slug: string | null; places: TreePlace[] } | null {
  const tree = isTree(nodes) ? nodes : buildTree(nodes);
  const page = tree.bySlug.get(slug);
  if (!page) return null;
  const parent = tree.parentOf.get(slug) ?? null;
  const kids = childrenOf(tree, slug, page.space);
  if (!kids.length) return { parent_slug: parent, places: [] };
  const merged = childrenOf(tree, parent, page.space).flatMap((n) => (n.slug === slug ? kids : [n]));
  return { parent_slug: parent, places: merged.map((n, i) => ({ slug: n.slug, parent_slug: parent, tree_rank: (i + 1) * RANK_STEP })) };
}

/**
 * Where a restored page goes (`nodes`: the space's pages in the Library, WITHOUT it): back under `oldParent`, as its
 * last child, when that page is in the Library, in the same space, and the 6-level cap allows it — else at the end of
 * the space's top level. It comes back alone: the children it had moved up when it was archived stay where they are.
 */
export function planRestore(nodes: readonly DocTreeNode[], page: { slug: string; space: string }, oldParent: string | null): Extract<MovePlan, { ok: true }> {
  const withPage = [...nodes.filter((n) => n.slug !== page.slug), { slug: page.slug, parent_slug: null, tree_rank: null, space: page.space }];
  const tree = buildTree(withPage);
  if (oldParent && oldParent !== page.slug) {
    const plan = planMove(tree, page.slug, { kind: "into", ref: oldParent });
    if (plan.ok) return plan;
  }
  return planMove(tree, page.slug, { kind: "top" }) as Extract<MovePlan, { ok: true }>;
}

/** The pane's left indent for a depth: 14px a level to level 4, then 9px a level so deep trees fit. */
export function indentPx(depth: number): number {
  const d = Math.max(0, depth);
  return d <= 4 ? d * 14 : 56 + (d - 4) * 9;
}
