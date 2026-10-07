// Raw D1 helpers for FIXTURES and assertions: a test may read and write `env.DB` directly (production
// code may not — it goes through a context, src/data/). These are what src/db.ts exported before the
// data layer; they live here so no production module keeps a query helper that takes a bare D1 handle.
export { nowIso } from "../../src/db";

export type DB = D1Database;

/** First row of a query, or null. */
export async function first<T>(db: DB, query: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(query).bind(...params).first<T>()) ?? null;
}

/** All rows of a query (empty array if none). */
export async function all<T>(db: DB, query: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await db.prepare(query).bind(...params).all<T>();
  return results ?? [];
}

/** Run a write and return the D1 result. */
export async function run(db: DB, query: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(query).bind(...params).run();
}
