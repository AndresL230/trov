import { env } from "cloudflare:test";
import { app } from "../../src/routes";

/** One JSON request against the app as `cookie`'s person. `exec` passes a real ExecutionContext (metering). */
export async function call<T = Record<string, unknown>>(
  method: string, path: string, cookie: string, body?: unknown, o: { headers?: Record<string, string>; exec?: ExecutionContext } = {}
): Promise<{ status: number; json: T }> {
  const res = await app.request(path, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }), ...o.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env, o.exec);
  return { status: res.status, json: (await res.json().catch(() => null)) as T };
}

export const one = <T>(sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).first<T>();
export const rows = async <T>(sql: string, ...params: unknown[]) => (await env.DB.prepare(sql).bind(...params).all<T>()).results;
export const exec = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();

/** The seeded superadmin (scripts/seed/reset.mjs): SaplingLearn's owner. */
export const SUPERADMIN = "AndresL230";

/** Grant `handle` the right to create `n` organizations on `plan` (0044_plans `org_grants`) — what lets a
 *  person who is not a superadmin use `POST /api/orgs`. Returns the grants' ids, oldest first. */
export async function grantOrgs(handle: string, n = 1, plan = "team", overrides: Record<string, number | null> = {}): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await exec(`INSERT INTO org_grants (person, plan, overrides, granted_by, created_at) VALUES (?, ?, ?, ?, ?)`,
      handle, plan, JSON.stringify(overrides), SUPERADMIN, `2026-10-06T00:00:0${i}.000Z`);
    ids.push(res.meta.last_row_id);
  }
  return ids;
}
