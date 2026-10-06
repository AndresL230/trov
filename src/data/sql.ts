// The tenant query surface (canopy-multitenancy.md §4.1): src/db.ts's helpers, taking a TenantContext
// instead of a D1 handle. A ported module imports everything it needs from here. The context does NOT
// add the tenant predicate — every statement writes its own `<alias.>org_id = ?`, bound from
// `ctx.orgId` (§4.3; docs/architecture/data-layer.md).
import { d1Of, type TenantContext } from "./context";
import { chunked, ph } from "../db";

export type { TenantContext } from "./context";
export { nowIso, ph, chunked, ID_CHUNK } from "../db";

/** A prepared, bound statement — only ever handed to `batch`. */
export type Stmt = D1PreparedStatement;

/** First row of a query, or null. */
export async function first<T>(ctx: TenantContext, query: string, ...params: unknown[]): Promise<T | null> {
  return (await d1Of(ctx).prepare(query).bind(...params).first<T>()) ?? null;
}

/** All rows of a query (empty array if none). */
export async function all<T>(ctx: TenantContext, query: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await d1Of(ctx).prepare(query).bind(...params).all<T>();
  return results ?? [];
}

/** Run a write and return the D1 result (use res.meta.last_row_id for inserts). */
export async function run(ctx: TenantContext, query: string, ...params: unknown[]): Promise<D1Result> {
  return d1Of(ctx).prepare(query).bind(...params).run();
}

/** One statement of a batch: what `db.prepare(query).bind(...params)` was. */
export function stmt(ctx: TenantContext, query: string, ...params: unknown[]): Stmt {
  return d1Of(ctx).prepare(query).bind(...params);
}

/** Run statements as ONE implicit transaction, results in statement order (D1's `batch`). D1 refuses
 *  an empty batch, so a caller that builds its list conditionally checks the length first, as before. */
export function batch<T = unknown>(ctx: TenantContext, stmts: Stmt[]): Promise<D1Result<T>[]> {
  return d1Of(ctx).batch<T>(stmts);
}

/**
 * One `IN (…)` fan-out per id chunk, rows concatenated — src/db.ts's `fanOut` (see the 100-bound-
 * parameter note there). `leading` params bind BEFORE the ids: that is where `ctx.orgId` goes, so the
 * statement reads `WHERE org_id = ? AND id IN (${ph})`.
 */
export async function fanOut<R>(
  ctx: TenantContext,
  ids: readonly (string | number)[],
  sql: (placeholders: string) => string,
  leading: unknown[] = []
): Promise<R[]> {
  const out: R[] = [];
  for (const chunk of chunked(ids)) {
    out.push(...(await all<R>(ctx, sql(ph(chunk.length)), ...leading, ...chunk)));
  }
  return out;
}
