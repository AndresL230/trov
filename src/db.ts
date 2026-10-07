// The D1-free primitives the two query surfaces share (src/data/sql.ts, src/data/platform-sql.ts re-export
// them). Nothing here touches the database: D1 is reached only through a context, in src/data/.

/** Current time as an ISO8601 string. Allowed in the Workers runtime. */
export const nowIso = (): string => new Date().toISOString();

// ── id-list fan-out (the 100-bound-parameter ceiling) ────────────────────────
//
// D1 caps a single statement at 100 BOUND PARAMETERS. Any `… IN (?, ?, …)` built
// from a row-id list therefore has a hard ceiling: past it D1 throws
// `too many SQL variables` and the whole read 500s — permanently, because the
// list only ever grows. Every grouped read that fans out over ids (the ticket
// queue's assignees/links/subs, a sprint's ticket links, query()'s hydration)
// runs its statement ONCE PER CHUNK and merges the rows (`fanOut`, src/data/sql.ts).
//
// 80, not 100: a fan-out usually binds a few non-id params too (statuses, a
// scope), and the margin means a caller never has to reason about the budget.

/** `IN (?, ?, …)` placeholders for `n` bound params. */
export const ph = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/** Max ids bound into one `IN (…)` list — see the note above. */
export const ID_CHUNK = 80;

/** Split an id list into `IN (…)`-sized chunks. An empty list yields no chunks. */
export function chunked<T>(xs: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
