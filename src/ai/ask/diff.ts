// A doc edit's changed hunks (#12 §2.12): the proposed body against the live one, line by line, as up to three
// stretches with the heading above each for context. Editing a hunk's `after` rebuilds the proposed body.
import type { AskDocHunk } from "@shared/ai-ask-core";

interface Region { oldStart: number; oldEnd: number; newStart: number; newEnd: number }

/** The changed regions between two line lists (an LCS walk; past ~600×600 lines, one region for the whole). */
function regions(a: string[], b: string[]): Region[] {
  if (a.length * b.length > 360_000) return a.join("\n") === b.join("\n") ? [] : [{ oldStart: 0, oldEnd: a.length, newStart: 0, newEnd: b.length }];
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: Region[] = [];
  let i = 0, j = 0;
  let open: Region | null = null;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      if (open) { out.push(open); open = null; }
      i++; j++;
    } else {
      open ??= { oldStart: i, oldEnd: i, newStart: j, newEnd: j };
      if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { j++; open.newEnd = j; } else { i++; open.oldEnd = i; }
    }
  }
  if (open) out.push(open);
  return out;
}

const headingBefore = (lines: string[], at: number): string | null => {
  for (let k = Math.min(at, lines.length) - 1; k >= 0; k--) if (/^#{1,6}\s/.test(lines[k])) return lines[k].trim();
  return null;
};

/** The hunks of a proposed body against the live one (all of them; a card shows the first three). */
export function docHunks(live: string, proposed: string): AskDocHunk[] {
  const a = live.split("\n"), b = proposed.split("\n");
  return regions(a, b).map((r, index) => ({
    index, heading: headingBefore(a, r.oldStart),
    before: a.slice(r.oldStart, r.oldEnd).join("\n"), after: b.slice(r.newStart, r.newEnd).join("\n"),
  }));
}

/** The proposed body with some hunks' `after` replaced (by index); null when an index names no hunk. */
export function applyHunkEdits(live: string, proposed: string, edits: readonly { index: number; after: string }[]): string | null {
  const a = live.split("\n"), b = proposed.split("\n");
  const rs = regions(a, b);
  if (edits.some((e) => !Number.isInteger(e.index) || e.index < 0 || e.index >= rs.length)) return null;
  const out: string[] = [];
  let i = 0;
  rs.forEach((r, k) => {
    out.push(...a.slice(i, r.oldStart));
    const edit = edits.find((e) => e.index === k);
    if (edit) { if (edit.after !== "") out.push(...edit.after.split("\n")); } else out.push(...b.slice(r.newStart, r.newEnd));
    i = r.oldEnd;
  });
  out.push(...a.slice(i));
  return out.join("\n");
}
