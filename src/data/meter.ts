// Usage metering (0042_organizations `org_usage_daily`): one counter per (org, UTC day, metric, person). Every call
// site hands the returned promise to `waitUntil`, and a failed bump is swallowed here — metering never
// slows or fails the request it counts. Read back by src/platform/usage.ts.
import type { Context } from "hono";
import type { Env } from "../env";
import type { AppEnv } from "../auth/principal";
import { platform, type TenantContext } from "./context";
import { batch, run, stmt, nowIso, type PlatformContext } from "./platform-sql";

export const METRIC_API_READ = "api_read";
export const METRIC_API_WRITE = "api_write";
export const METRIC_MCP_REQUEST = "mcp_request";
/** `mcp_tool:<tool name>` — one per MCP `tools/call`. */
export const METRIC_MCP_TOOL_PREFIX = "mcp_tool:";
/** Rows older than this are pruned by the daily cron (`pruneUsage`). */
export const USAGE_RETENTION_DAYS = 400;

const UPSERT = `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, ?, ?, ?, 1, ?)
  ON CONFLICT(org_id, day, metric, actor) DO UPDATE SET count = count + 1, last_at = excluded.last_at`;

/** Bump one counter. Never rejects. */
export function meter(p: PlatformContext, orgId: string, actor: string, metric: string, at: string = nowIso()): Promise<void> {
  return run(p, UPSERT, orgId, at.slice(0, 10), metric, actor, at).then(() => undefined, () => undefined);
}

/** A session request through a tenant gate: reads and writes are separate metrics. No ExecutionContext
 *  (a test calling `app.request` without one) → nothing is metered, by design. */
export function meterApiRequest(c: Context<AppEnv>, p: PlatformContext, ctx: TenantContext): void {
  const metric = c.req.method === "GET" || c.req.method === "HEAD" ? METRIC_API_READ : METRIC_API_WRITE;
  try {
    c.executionCtx.waitUntil(meter(p, ctx.orgId, ctx.userId, metric));
  } catch {
    // Hono throws when the request carries no ExecutionContext.
  }
}

/** The tool names in an MCP request body: a JSON-RPC message, or a batch of them. */
function toolCalls(body: unknown): string[] {
  const out: string[] = [];
  for (const m of Array.isArray(body) ? body : [body]) {
    if (!m || typeof m !== "object") continue;
    const { method, params } = m as { method?: unknown; params?: { name?: unknown } };
    if (method === "tools/call" && typeof params?.name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(params.name)) out.push(params.name);
  }
  return out;
}

/** One /mcp request: `mcp_request`, plus `mcp_tool:<name>` per tool call in its body — read from a
 *  CLONE taken before the first await, so the handler still owns the original. Never rejects. */
export async function meterMcp(env: Env, ctx: TenantContext, request: Request): Promise<void> {
  let copy: Request | null = null;
  try {
    copy = request.method === "POST" ? request.clone() : null;
    const tools = copy ? toolCalls(await copy.json().catch(() => null)) : [];
    const p = platform(env, ctx.userId);
    const at = nowIso();
    await batch(p, [METRIC_MCP_REQUEST, ...tools.map((t) => METRIC_MCP_TOOL_PREFIX + t)]
      .map((metric) => stmt(p, UPSERT, ctx.orgId, at.slice(0, 10), metric, ctx.userId, at)));
  } catch {
    // never the request's problem
  }
}

/** The daily cron: drop counters past the retention window. */
export async function pruneUsage(p: PlatformContext, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - USAGE_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  return (await run(p, `DELETE FROM org_usage_daily WHERE day < ?`, cutoff)).meta.changes ?? 0;
}
