// Platform usage stats (canopy-multitenancy.md §5.4) — `GET /api/platform/usage`, superadmin only.
//
// THIS IS THE ONE MODULE THAT READS TENANT TABLES ACROSS ORGS. Every statement below is a deliberate
// cross-org platform read: a `COUNT` / `SUM` `GROUP BY org_id` over a tenant table, with NO `org_id = ?`
// predicate, run through the PLATFORM query surface. It returns sizes and counts only — never a row's
// content — and nothing outside `requireSuperadmin` may call it. The data-layer static test (§4.4)
// allowlists exactly this file; do not write a cross-org tenant read anywhere else.
import { type PlatformContext, type Stmt, stmt, batch } from "../data/platform-sql";
import { METRIC_API_READ, METRIC_API_WRITE, METRIC_MCP_REQUEST, METRIC_MCP_TOOL_PREFIX, USAGE_RETENTION_DAYS } from "../data/meter";
import { orgLogoSrc, type OrgUsage, type PlatformUsageResponse, type UsageActivity, type UsageCreated, type UsageDay, type UsageSizes } from "@shared/orgs";

export const USAGE_DEFAULT_DAYS = 30;
export const USAGE_MAX_DAYS = USAGE_RETENTION_DAYS;

/** `?days=` → a whole number of days in [1, USAGE_MAX_DAYS]; anything else is the default. */
export function usageDays(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= USAGE_MAX_DAYS ? n : USAGE_DEFAULT_DAYS;
}

const DAY_MS = 86_400_000;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// Sizes now: one row per org. Soft-deleted prompts and artifact pages are not counted.
const SIZE_SQL: Record<Exclude<keyof UsageSizes, "tickets_open" | "tickets_total">, string> = {
  members: `SELECT org_id, COUNT(*) AS n FROM memberships GROUP BY org_id`,
  docs: `SELECT org_id, COUNT(*) AS n FROM docs GROUP BY org_id`,
  feed_entries: `SELECT org_id, COUNT(*) AS n FROM feed GROUP BY org_id`,
  sprints: `SELECT org_id, COUNT(*) AS n FROM sprints GROUP BY org_id`,
  prompts: `SELECT org_id, COUNT(*) AS n FROM prompts WHERE deleted_at IS NULL GROUP BY org_id`,
  handoffs: `SELECT org_id, COUNT(*) AS n FROM handoffs GROUP BY org_id`,
  artifacts: `SELECT org_id, COUNT(*) AS n FROM artifact_pages WHERE deleted_at IS NULL GROUP BY org_id`,
  artifact_bytes: `SELECT org_id, COALESCE(SUM(size_bytes), 0) AS n FROM artifact_versions GROUP BY org_id`,
  repo_events: `SELECT org_id, COUNT(*) AS n FROM repo_events GROUP BY org_id`,
  mcp_tokens: `SELECT org_id, COUNT(*) AS n FROM mcp_tokens WHERE revoked = 0 GROUP BY org_id`,
  oauth_grants: `SELECT org_id, COUNT(*) AS n FROM oauth_grants WHERE revoked_at IS NULL GROUP BY org_id`,
};
const TICKETS_SQL = `SELECT org_id, COUNT(*) AS n, COALESCE(SUM(status NOT IN ('done', 'declined')), 0) AS open FROM tickets GROUP BY org_id`;

// Items created in the window: one row per org, bound to the window's first instant.
const CREATED_SQL: Record<keyof UsageCreated, string> = {
  feed_entries: `SELECT org_id, COUNT(*) AS n FROM feed WHERE created_at >= ? GROUP BY org_id`,
  tickets: `SELECT org_id, COUNT(*) AS n FROM tickets WHERE created_at >= ? GROUP BY org_id`,
  doc_versions: `SELECT org_id, COUNT(*) AS n FROM doc_versions WHERE created_at >= ? GROUP BY org_id`,
  sprints: `SELECT org_id, COUNT(*) AS n FROM sprints WHERE created_at >= ? GROUP BY org_id`,
  prompts: `SELECT org_id, COUNT(*) AS n FROM prompts WHERE created_at >= ? GROUP BY org_id`,
  handoffs: `SELECT org_id, COUNT(*) AS n FROM handoffs WHERE created_at >= ? GROUP BY org_id`,
  artifacts: `SELECT org_id, COUNT(*) AS n FROM artifact_pages WHERE created_at >= ? GROUP BY org_id`,
};
const EMAILS_SQL = `SELECT org_id, COUNT(*) AS n FROM notification_outbox WHERE status = 'sent' AND created_at >= ? GROUP BY org_id`;

type N = { org_id: string; n: number };
const byOrg = (rows: N[]): Map<string, number> => new Map(rows.map((r) => [r.org_id, Number(r.n) || 0]));

const zeroSizes = (): UsageSizes => ({
  members: 0, docs: 0, feed_entries: 0, tickets_open: 0, tickets_total: 0, sprints: 0, prompts: 0, handoffs: 0,
  artifacts: 0, artifact_bytes: 0, repo_events: 0, mcp_tokens: 0, oauth_grants: 0,
});
const zeroCreated = (): UsageCreated => ({ feed_entries: 0, tickets: 0, doc_versions: 0, sprints: 0, prompts: 0, handoffs: 0, artifacts: 0 });
const zeroActivity = (): UsageActivity => ({
  api_requests: 0, api_reads: 0, api_writes: 0, mcp_requests: 0, mcp_tool_calls: 0, active_people: 0,
  created: zeroCreated(), emails_sent: 0, top_tools: [],
});
const topTools = (m: Map<string, number>) =>
  [...m].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)).slice(0, 10);

/**
 * Platform totals plus one row per org (suspended ones included), for the last `days` UTC days ending
 * today. One D1 batch. `series` is zero-filled, oldest first, exactly `days` long — in every org row and
 * in the totals.
 */
export async function platformUsage(p: PlatformContext, days: number = USAGE_DEFAULT_DAYS, now: Date = new Date()): Promise<PlatformUsageResponse> {
  const until = dayOf(now.getTime());
  const since = dayOf(now.getTime() - (days - 1) * DAY_MS);
  const sinceIso = `${since}T00:00:00.000Z`;
  const dayList = Array.from({ length: days }, (_, i) => dayOf(now.getTime() - (days - 1 - i) * DAY_MS));

  const sizeKeys = Object.keys(SIZE_SQL) as (keyof typeof SIZE_SQL)[];
  const createdKeys = Object.keys(CREATED_SQL) as (keyof UsageCreated)[];
  const stmts: Stmt[] = [
    stmt(p, `SELECT id, slug, name, created_at, suspended_at, logo_sha FROM orgs ORDER BY name COLLATE NOCASE ASC`),
    stmt(p, `SELECT COUNT(*) AS n FROM persons WHERE handle <> 'github-webhook'`),
    stmt(p, TICKETS_SQL),
    stmt(p, EMAILS_SQL, sinceIso),
    stmt(p, `SELECT org_id, day, metric, SUM(count) AS n FROM org_usage_daily WHERE day >= ? GROUP BY org_id, day, metric`, since),
    stmt(p, `SELECT org_id, COUNT(DISTINCT lower(actor)) AS n FROM org_usage_daily WHERE day >= ? GROUP BY org_id`, since),
    stmt(p, `SELECT COUNT(DISTINCT lower(actor)) AS n FROM org_usage_daily WHERE day >= ?`, since),
    stmt(p, `SELECT org_id, MAX(last_at) AS at FROM org_usage_daily GROUP BY org_id`),
    ...sizeKeys.map((k) => stmt(p, SIZE_SQL[k])),
    ...createdKeys.map((k) => stmt(p, CREATED_SQL[k], sinceIso)),
  ];
  const res = await batch<Record<string, unknown>>(p, stmts);
  const rows = <T>(i: number): T[] => (res[i].results ?? []) as T[];

  const orgs = rows<{ id: string; slug: string; name: string; created_at: string; suspended_at: string | null; logo_sha: string | null }>(0);
  const persons = Number(rows<{ n: number }>(1)[0]?.n ?? 0);
  const tickets = new Map(rows<{ org_id: string; n: number; open: number }>(2).map((r) => [r.org_id, r]));
  const emails = byOrg(rows<N>(3));
  const usage = rows<{ org_id: string; day: string; metric: string; n: number }>(4);
  const actors = byOrg(rows<N>(5));
  const totalActors = Number(rows<{ n: number }>(6)[0]?.n ?? 0);
  const lastAt = new Map(rows<{ org_id: string; at: string | null }>(7).map((r) => [r.org_id, r.at]));
  const sizes = new Map(sizeKeys.map((k, i) => [k, byOrg(rows<N>(8 + i))]));
  const created = new Map(createdKeys.map((k, i) => [k, byOrg(rows<N>(8 + sizeKeys.length + i))]));

  const out: OrgUsage[] = orgs.map((o) => {
    const s = zeroSizes();
    for (const k of sizeKeys) s[k] = sizes.get(k)!.get(o.id) ?? 0;
    s.tickets_total = Number(tickets.get(o.id)?.n ?? 0);
    s.tickets_open = Number(tickets.get(o.id)?.open ?? 0);
    const a = zeroActivity();
    for (const k of createdKeys) a.created[k] = created.get(k)!.get(o.id) ?? 0;
    a.emails_sent = emails.get(o.id) ?? 0;
    a.active_people = actors.get(o.id) ?? 0;
    const series = new Map<string, UsageDay>(dayList.map((day) => [day, { day, requests: 0, mcp_calls: 0 }]));
    const tools = new Map<string, number>();
    for (const u of usage) {
      if (u.org_id !== o.id) continue;
      const n = Number(u.n) || 0;
      const point = series.get(u.day);
      if (u.metric === METRIC_API_READ) a.api_reads += n;
      else if (u.metric === METRIC_API_WRITE) a.api_writes += n;
      else if (u.metric === METRIC_MCP_REQUEST) a.mcp_requests += n;
      else if (u.metric.startsWith(METRIC_MCP_TOOL_PREFIX)) {
        a.mcp_tool_calls += n;
        const tool = u.metric.slice(METRIC_MCP_TOOL_PREFIX.length);
        tools.set(tool, (tools.get(tool) ?? 0) + n);
        if (point) point.mcp_calls += n;
      }
      if (point && (u.metric === METRIC_API_READ || u.metric === METRIC_API_WRITE)) point.requests += n;
    }
    a.api_requests = a.api_reads + a.api_writes;
    a.top_tools = topTools(tools);
    return {
      slug: o.slug, name: o.name, logo_url: orgLogoSrc(o), status: o.suspended_at ? "suspended" : "active", created_at: o.created_at,
      last_activity_at: lastAt.get(o.id) ?? null, sizes: s, activity: a, series: [...series.values()],
    };
  });

  // Totals: every number is the sum of the org rows, except the two that are not additive.
  const tSizes = zeroSizes();
  const tAct = zeroActivity();
  const tSeries = dayList.map((day) => ({ day, requests: 0, mcp_calls: 0 }));
  const tTools = new Map<string, number>();
  let last: string | null = null;
  for (const o of out) {
    for (const k of Object.keys(tSizes) as (keyof UsageSizes)[]) tSizes[k] += o.sizes[k];
    for (const k of createdKeys) tAct.created[k] += o.activity.created[k];
    tAct.api_reads += o.activity.api_reads;
    tAct.api_writes += o.activity.api_writes;
    tAct.mcp_requests += o.activity.mcp_requests;
    tAct.mcp_tool_calls += o.activity.mcp_tool_calls;
    tAct.emails_sent += o.activity.emails_sent;
    o.series.forEach((d, i) => { tSeries[i].requests += d.requests; tSeries[i].mcp_calls += d.mcp_calls; });
    if (o.last_activity_at && (!last || o.last_activity_at > last)) last = o.last_activity_at;
  }
  for (const u of usage) {
    if (!u.metric.startsWith(METRIC_MCP_TOOL_PREFIX)) continue;
    const tool = u.metric.slice(METRIC_MCP_TOOL_PREFIX.length);
    tTools.set(tool, (tTools.get(tool) ?? 0) + (Number(u.n) || 0));
  }
  tAct.api_requests = tAct.api_reads + tAct.api_writes;
  tAct.active_people = totalActors; // a person active in two orgs is ONE active person
  tAct.top_tools = topTools(tTools);

  return {
    days, since, until, generated_at: now.toISOString(),
    totals: {
      orgs: out.length, suspended_orgs: out.filter((o) => o.status === "suspended").length, persons,
      last_activity_at: last, sizes: tSizes, activity: tAct, series: tSeries,
    },
    orgs: out,
  };
}
