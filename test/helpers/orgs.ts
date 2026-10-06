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
