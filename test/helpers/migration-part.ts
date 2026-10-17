// One part of a consolidated migration (0076_10_17_staging: each old file is a `-- ══ part <name> ══` section), as
// D1 migrations a test can apply: everything before the part, then the part alone. A part is found by its FIRST
// statement and ends where the next part's first statement starts (null = the end of the file).
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

export function migrationPart(all: D1Migration[], file: string, part: string, first: string, next: string | null): { before: D1Migration[]; part: D1Migration[] } {
  const m = all.find((x) => x.name === file);
  if (!m) throw new Error(`${file}: not found`);
  const from = m.queries.findIndex((q) => q.includes(first));
  const to = next === null ? m.queries.length : m.queries.findIndex((q) => q.includes(next));
  if (from < 1 || to <= from) throw new Error(`${file}: the ${part} part was not found`);
  return {
    before: [...all.filter((x) => x.name < file), { name: `${file} (before ${part})`, queries: m.queries.slice(0, from) }],
    part: [{ name: `${file} › ${part}`, queries: m.queries.slice(from, to) }],
  };
}
