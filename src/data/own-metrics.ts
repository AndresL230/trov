// Trov's OWN app metrics (repo setups, Phase G): the contract-v3 body `GET /api/internal/metrics` answers for ONE
// organization (docs/superpowers/specs/2026-10-15-app-metrics-v3.md §4) — scenario B's Product block. D1 only, never a
// call out; every statement binds the caller's org id (the bearer's one org, src/data/bearer.ts). Counts only: no
// person, no content, nothing per-user leaves (v1 §5's privacy rule) — `actor` is read only to count distinct people.
//
// Windows: the trailing 24 h / 7 d / 30 d from `now` for what carries a timestamp (doc proposals, triage items); the
// usage meter (`org_usage_daily`) is per UTC DAY, so its windows are whole days — 24h is TODAY so far, 7d the last 7
// days, 30d the last 30 — and its groups say so in their note. Nesting (24h ≤ 7d ≤ 30d) holds by construction.
import { type TenantContext, all, first } from "./sql";
import { METRIC_MCP_TOOL_PREFIX, SUMMARY_METRIC_GLOB, AI_METRIC_GLOB } from "./meter";
import { OPEN_STATUS_SQL } from "@shared/tickets-core";

const DAY = 86_400_000;
/** The ranked tool list keeps the busiest this many. */
export const OWN_TOOLS_LIMIT = 12;
const PER_DAY_NOTE = "Counted per UTC day: 24h is today so far.";
type Windows = { "24h": number; "7d": number; "30d": number };
const win = (a: unknown, b: unknown, c: unknown): Windows => ({ "24h": Number(a) || 0, "7d": Number(b) || 0, "30d": Number(c) || 0 });

/** A tool name (`[A-Za-z0-9_.-]{1,64}`, the meter's own rule) as a contract key: `mcp_` + lower case, anything else `_`. */
const toolKey = (tool: string): string => `mcp_${tool.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`.slice(0, 40);

/** The v3 body for `ctx`'s organization at `now`. */
export async function ownMetricsBody(ctx: TenantContext, now: number = Date.now()): Promise<Record<string, unknown>> {
  const org = ctx.orgId;
  const iso = (ms: number) => new Date(ms).toISOString();
  const h24 = iso(now - DAY), d7 = iso(now - 7 * DAY), d30 = iso(now - 30 * DAY);
  const day = (back: number) => new Date(now - back * DAY).toISOString().slice(0, 10);
  const today = day(0), day7 = day(6), day30 = day(29);

  const [people, liveDocs, awaiting, triage, tickets, tokens, grants, gate, toTriage, tools, active] = await Promise.all([
    first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?`, org),
    first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM docs WHERE org_id = ? AND current_version > 0`, org),
    // Awaiting review: what the Proposals screen lists — a staged version newer than the live one.
    first<{ n: number }>(ctx,
      `SELECT COUNT(*) AS n FROM doc_versions v JOIN docs d ON d.slug = v.slug AND d.org_id = ?
        WHERE v.org_id = ? AND v.status = 'staged' AND v.version > d.current_version`, org, org),
    first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM needs_triage WHERE org_id = ? AND resolved = 0`, org),
    first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM tickets WHERE org_id = ? AND status IN ${OPEN_STATUS_SQL}`, org),
    first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM mcp_tokens WHERE org_id = ? AND revoked = 0`, org),
    // A live OAuth connection that can reach the org: its own org, or one of the orgs it may use / has used (0051).
    first<{ n: number }>(ctx,
      `SELECT COUNT(*) AS n FROM oauth_grants g WHERE g.revoked_at IS NULL
          AND (g.org_id = ? OR g.id IN (SELECT grant_id FROM oauth_grant_orgs WHERE org_id = ?))`, org, org),
    // The gate: doc proposals MADE in each window, and where they stand now.
    first<Record<string, number>>(ctx,
      `SELECT SUM(created_at >= ?) AS s1, SUM(created_at >= ?) AS s7, COUNT(*) AS s30,
              SUM(created_at >= ? AND status = 'promoted') AS p1, SUM(created_at >= ? AND status = 'promoted') AS p7, SUM(status = 'promoted') AS p30,
              SUM(created_at >= ? AND status = 'rejected') AS r1, SUM(created_at >= ? AND status = 'rejected') AS r7, SUM(status = 'rejected') AS r30
         FROM doc_versions WHERE org_id = ? AND created_at >= ?`, h24, d7, h24, d7, h24, d7, org, d30),
    first<Record<string, number>>(ctx,
      `SELECT SUM(created_at >= ?) AS t1, SUM(created_at >= ?) AS t7, COUNT(*) AS t30 FROM needs_triage WHERE org_id = ? AND created_at >= ?`, h24, d7, org, d30),
    all<{ metric: string; d1: number; d7: number; d30: number }>(ctx,
      `SELECT metric, SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS d1, SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS d7, SUM(count) AS d30
         FROM org_usage_daily WHERE org_id = ? AND day >= ? AND metric GLOB 'mcp_tool:*' GROUP BY metric`, today, day7, org, day30),
    // People active: a person with a metered request (not the platform's own summary / AI calls) — counted, never named.
    first<Record<string, number>>(ctx,
      `SELECT COUNT(DISTINCT CASE WHEN day >= ? THEN lower(actor) END) AS a1, COUNT(DISTINCT CASE WHEN day >= ? THEN lower(actor) END) AS a7,
              COUNT(DISTINCT lower(actor)) AS a30
         FROM org_usage_daily WHERE org_id = ? AND day >= ? AND metric NOT GLOB '${SUMMARY_METRIC_GLOB}' AND metric NOT GLOB '${AI_METRIC_GLOB}'`, today, day7, org, day30),
  ]);

  const toolRows = tools.map((t) => ({ tool: t.metric.slice(METRIC_MCP_TOOL_PREFIX.length), v: win(t.d1, t.d7, t.d30) }))
    .filter((t) => /^[A-Za-z0-9_.-]{1,64}$/.test(t.tool));
  const sessions = toolRows.find((t) => t.tool === "record_session")?.v ?? win(0, 0, 0);
  const used = new Set<string>();
  const ranked = toolRows.sort((a, b) => b.v["30d"] - a.v["30d"] || b.v["7d"] - a.v["7d"] || (a.tool < b.tool ? -1 : 1)).flatMap((t) => {
    const key = toolKey(t.tool);
    if (used.has(key) || used.size >= OWN_TOOLS_LIMIT) return [];
    used.add(key);
    return [{ key, label: t.tool.slice(0, 60), values: t.v }];
  });
  const n = (r: { n: number } | null) => Number(r?.n) || 0;

  const groups: Record<string, unknown>[] = [
    { id: "now", label: "Right now", shape: "stats", metrics: [
      { key: "people", label: "People", value: n(people) },
      { key: "live_docs", label: "Live docs", value: n(liveDocs) },
      { key: "awaiting_review", label: "Awaiting review", value: n(awaiting) },
      { key: "in_triage", label: "In triage", value: n(triage) },
      { key: "open_tickets", label: "Open tickets", value: n(tickets) },
      { key: "agents_connected", label: "Agents connected", value: n(tokens) + n(grants) },
    ] },
    ...(ranked.length ? [{ id: "mcp_tools", label: "MCP tool calls", shape: "ranked", note: PER_DAY_NOTE, metrics: ranked }] : []),
    { id: "gate", label: "Agent writes through the gate", shape: "stats", note: "Every agent write goes through the gate; a person promotes or rejects it.", metrics: [
      { key: "gate_staged", label: "Staged", values: win(gate?.s1, gate?.s7, gate?.s30) },
      { key: "gate_promoted", label: "Promoted", values: win(gate?.p1, gate?.p7, gate?.p30) },
      { key: "gate_rejected", label: "Rejected", values: win(gate?.r1, gate?.r7, gate?.r30) },
      { key: "gate_to_triage", label: "To triage", values: win(toTriage?.t1, toTriage?.t7, toTriage?.t30) },
    ] },
    { id: "activity", label: "Activity", shape: "stats", note: PER_DAY_NOTE, metrics: [
      { key: "sessions_recorded", label: "Sessions recorded", values: sessions },
      { key: "people_active", label: "People active", values: win(active?.a1, active?.a7, active?.a30) },
    ] },
  ];
  return { version: 3, label: "Trov", groups };
}
