// Ordered placement by a saved REAL rank — ONE definition for every hand-ordered list: a ticket board
// column (`placeInColumn`, tickets-core), a doc's siblings in the page tree (`planMove`, docs-tree-core)
// and the order of an org's spaces. Zod-free and import-free: the SPA imports it as a value, so an
// optimistic drop lands exactly where the Worker will put it.
//
// A list is given in its VISIBLE order (the caller sorts with its own comparator). A NULL rank means
// "no saved position yet"; the first drop into a list that holds one renumbers the whole list in that
// visible order, so what the person saw is what gets saved.

/** Spacing between renumbered positions, so later drops have room to split. */
export const RANK_STEP = 1024;

export interface RankedKey<K> {
  key: K;
  rank: number | null;
}

export interface Placement<K> {
  /** The moved item's new rank. */
  rank: number;
  /** When the list had to be renumbered first (it holds a NULL rank, or two neighbours are too close to
   *  split): the new rank of EVERY other item — the caller writes those too. Else null. */
  renumber: Map<K, number> | null;
}

/**
 * Where an item dropped into `list` right after `afterKey` (null = the top) goes. `list` is the target
 * list WITHOUT the moved item, in its visible order. An `afterKey` not in the list means the top.
 */
export function placeAmong<K>(list: ReadonlyArray<RankedKey<K>>, afterKey: K | null): Placement<K> {
  let col = list.map((t) => ({ key: t.key, rank: t.rank }));
  let renumber: Map<K, number> | null = null;
  const respace = () => {
    const next = new Map<K, number>(col.map((t, i) => [t.key, (i + 1) * RANK_STEP]));
    renumber = next;
    col = col.map((t) => ({ key: t.key, rank: next.get(t.key) as number }));
  };
  if (col.some((t) => t.rank === null)) respace();
  const at = afterKey === null ? 0 : col.findIndex((t) => t.key === afterKey) + 1;   // -1 + 1 = 0: the top
  const between = (): number | null => {
    const prev = col[at - 1]?.rank ?? null;
    const next = col[at]?.rank ?? null;
    if (prev === null && next === null) return RANK_STEP;
    if (prev === null) return (next as number) - RANK_STEP;
    if (next === null) return prev + RANK_STEP;
    return next - prev > 1e-6 ? (prev + next) / 2 : null;
  };
  let rank = between();
  if (rank === null) { respace(); rank = between() as number; }
  return { rank, renumber };
}
