// The platform query surface (canopy-multitenancy.md §4.1, §4.2): the same helpers as ./sql.ts, for the
// GLOBAL tables — persons, identities, sessions, tokens, oauth, orgs, memberships. A statement run
// through here names no tenant table (the §4.4 static test holds the few declared exceptions).
import { d1Of, type PlatformContext } from "./context";
import { chunked, ph } from "../db";

export type { PlatformContext } from "./context";
export { nowIso, ph, chunked, ID_CHUNK } from "../db";

/** A prepared, bound statement — only ever handed to `batch`. */
export type Stmt = D1PreparedStatement;

/** First row of a query, or null. */
export async function first<T>(p: PlatformContext, query: string, ...params: unknown[]): Promise<T | null> {
  return (await d1Of(p).prepare(query).bind(...params).first<T>()) ?? null;
}

/** All rows of a query (empty array if none). */
export async function all<T>(p: PlatformContext, query: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await d1Of(p).prepare(query).bind(...params).all<T>();
  return results ?? [];
}

/** Run a write and return the D1 result (use res.meta.last_row_id for inserts). */
export async function run(p: PlatformContext, query: string, ...params: unknown[]): Promise<D1Result> {
  return d1Of(p).prepare(query).bind(...params).run();
}

/** One statement of a batch: what `db.prepare(query).bind(...params)` was. */
export function stmt(p: PlatformContext, query: string, ...params: unknown[]): Stmt {
  return d1Of(p).prepare(query).bind(...params);
}

/** Run statements as ONE implicit transaction, results in statement order (D1's `batch`). D1 refuses
 *  an empty batch, so a caller that builds its list conditionally checks the length first, as before. */
export function batch<T = unknown>(p: PlatformContext, stmts: Stmt[]): Promise<D1Result<T>[]> {
  return d1Of(p).batch<T>(stmts);
}

/** One `IN (…)` fan-out per id chunk, rows concatenated — src/db.ts's `fanOut`. `leading` params bind
 *  BEFORE the ids. */
export async function fanOut<R>(
  p: PlatformContext,
  ids: readonly (string | number)[],
  sql: (placeholders: string) => string,
  leading: unknown[] = []
): Promise<R[]> {
  const out: R[] = [];
  for (const chunk of chunked(ids)) {
    out.push(...(await all<R>(p, sql(ph(chunk.length)), ...leading, ...chunk)));
  }
  return out;
}
