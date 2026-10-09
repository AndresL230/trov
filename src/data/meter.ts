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

/** One /mcp request that calls NO tool (initialize, tools/list, a notification): `mcp_request`, in the
 *  connection's own organization — `ctx`, or nothing when it has none (a connection that follows the
 *  repository acts in an organization only per call). A request that DOES call a tool is counted by
 *  `meterMcpTool`, in the organization each call resolved to. The body is read from a CLONE taken
 *  before the first await, so the handler still owns the original. Never rejects. */
export async function meterMcp(env: Env, ctx: TenantContext | null, request: Request): Promise<void> {
  let copy: Request | null = null;
  try {
    copy = request.method === "POST" ? request.clone() : null;
    const tools = copy ? toolCalls(await copy.json().catch(() => null)) : [];
    if (tools.length || !ctx) return;
    await meter(platform(env, ctx.userId), ctx.orgId, ctx.userId, METRIC_MCP_REQUEST);
  } catch {
    // never the request's problem
  }
}

/** One MCP tool call, counted in the organization it RESOLVED to (src/mcp.ts): `mcp_request` and
 *  `mcp_tool:<name>`. A call that resolved to no organization is counted nowhere. Never rejects. */
export async function meterMcpTool(env: Env, ctx: TenantContext, tool: string): Promise<void> {
  try {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(tool)) return;
    const p = platform(env, ctx.userId);
    const at = nowIso();
    await batch(p, [METRIC_MCP_REQUEST, METRIC_MCP_TOOL_PREFIX + tool].map((metric) => stmt(p, UPSERT, ctx.orgId, at.slice(0, 10), metric, ctx.userId, at)));
  } catch {
    // never the request's problem
  }
}

// ── AI summaries (docs/architecture/plans.md › AI summaries) ─────────────────
// One platform key pays for every org's summaries, so each ATTEMPTED call is counted here, per org —
// from the webhook (actor `github-webhook`) and from Sync GitHub (actor = the admin). Counts and sizes
// only: no title, no body, no summary text ever reaches this table.
export type SummaryKind = "pr" | "issue";
/** An attempted summarizer call — what the monthly allowance (`ai_summaries`) counts. */
export const METRIC_SUMMARY: Record<SummaryKind, string> = { pr: "summary:pr", issue: "summary:issue" };
/** An attempt that produced no summary (the item fell back to its excerpt). */
export const METRIC_SUMMARY_FAILED: Record<SummaryKind, string> = { pr: "summary_failed:pr", issue: "summary_failed:issue" };
/** An item stored with its excerpt because nothing could be attempted: the allowance was used up, or
 *  the plan had ended. Counted once, when the excerpt row is first written. */
export const METRIC_SUMMARY_CAPPED: Record<SummaryKind, string> = { pr: "summary_capped:pr", issue: "summary_capped:issue" };
/** Characters sent (prompt + title + body) and received, summed per day — for estimating cost. */
export const METRIC_SUMMARY_CHARS_IN = "summary_chars_in";
export const METRIC_SUMMARY_CHARS_OUT = "summary_chars_out";
/** The provider's own token counts, when its answer carried them (Gemini's `usageMetadata`). */
export const METRIC_SUMMARY_TOKENS_IN = "summary_tokens_in";
export const METRIC_SUMMARY_TOKENS_OUT = "summary_tokens_out";
/** Every metric above starts with this: none of them is a PERSON's request (src/platform/usage.ts). */
export const SUMMARY_METRIC_GLOB = "summary*";

const UPSERT_BY = `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(org_id, day, metric, actor) DO UPDATE SET count = count + excluded.count, last_at = excluded.last_at`;

/** Add `n` to each named counter, in one batch. Entries with `n <= 0` are dropped. Never rejects. */
export async function meterBy(p: PlatformContext, orgId: string, actor: string, entries: [metric: string, n: number][], at: string = nowIso()): Promise<void> {
  try {
    const rows = entries.filter(([, n]) => Number.isFinite(n) && n > 0);
    if (rows.length) await batch(p, rows.map(([metric, n]) => stmt(p, UPSERT_BY, orgId, at.slice(0, 10), metric, actor, Math.round(n), at)));
  } catch {
    // metering is never the caller's problem
  }
}

/** The daily cron: drop counters past the retention window. */
export async function pruneUsage(p: PlatformContext, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - USAGE_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  return (await run(p, `DELETE FROM org_usage_daily WHERE day < ?`, cutoff)).meta.changes ?? 0;
}
