// Line-diff helpers for the Review surface: an LCS line diff plus a collapsed
// variant that folds large unchanged runs into "N unchanged lines" ellipsis
// rows. Pure functions — no DOM, no state; test/render.review.test.ts covers
// them directly.

export type DiffKind = "ctx" | "add" | "del" | "ellipsis";

export type DiffRow = { t: DiffKind; text: string };

/** One step of an LCS walk over two sequences: kept (`ctx`, in both), removed (`del`, only in
 *  `a`) or added (`add`, only in `b`), with its index in the sequence it came from. */
export type SeqOp = { t: "ctx"; a: number; b: number } | { t: "del"; a: number } | { t: "add"; b: number };

/** LCS diff of two sequences of strings: lines for the source views, whole markdown blocks
 *  for Review's Rendered view (review-rendered.ts). */
export function diffSeq(a: string[], b: string[]): SeqOp[] {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: SeqOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: "ctx", a: i, b: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "del", a: i }); i++; }
    else { out.push({ t: "add", b: j }); j++; }
  }
  while (i < n) out.push({ t: "del", a: i++ });
  while (j < m) out.push({ t: "add", b: j++ });
  return out;
}

export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n"), b = newText.split("\n");
  return diffSeq(a, b).map((op): DiffRow => (op.t === "add" ? { t: "add", text: b[op.b] } : { t: op.t, text: a[op.a] }));
}

/**
 * Line diff with large unchanged runs collapsed to "N unchanged lines" ellipsis markers.
 * ctx = how many context lines to show around each changed hunk (default 3).
 */
export function collapsedLineDiff(oldText: string, newText: string, ctx = 3): DiffRow[] {
  const rows = lineDiff(oldText, newText);
  if (rows.length === 0) return [];
  const changed = new Set<number>();
  rows.forEach((r, i) => { if (r.t !== "ctx") changed.add(i); });
  if (changed.size === 0) return rows; // nothing changed — return as-is (or callers can skip)
  const visible = new Set<number>();
  changed.forEach((idx) => {
    for (let j = Math.max(0, idx - ctx); j <= Math.min(rows.length - 1, idx + ctx); j++) visible.add(j);
  });
  const out: DiffRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (visible.has(i)) { out.push(rows[i]); i++; }
    else {
      let j = i;
      while (j < rows.length && !visible.has(j)) j++;
      out.push({ t: "ellipsis", text: `${j - i} unchanged line${j - i !== 1 ? "s" : ""}` });
      i = j;
    }
  }
  return out;
}
