// Platform › Usage (superadmin) — sizes and counts per organization, never content.
// The window switch (7 / 30 / 90 days, the app's `segmented`), the platform totals as stat
// tiles in the Repo dashboard's tile idiom, and one row per organization sorted by activity,
// each with a per-day sparkline for requests and for MCP tool calls. A row opens to what was
// created in the window and the most used MCP tools; `orgUsageBlock` is the same figures for
// one organization (its detail page).
//
// Purely presentational: props in, markup out; interactions dispatch `plat…` acts.

import type { OrgUsage, PlatformUsageResponse, UsageActivity, UsageCreated, UsageDay } from "@shared/orgs";
import { esc, attr, relTime, statusBadge, surface } from "./ui";
import { segmented } from "./segmented";
import { tabLead } from "./org-ui";

export const USAGE_WINDOWS = [7, 30, 90] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

const LABEL = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";
const NUM = "font-family:var(--label);font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap";
const QUIET = "font-size:11.5px;color:var(--fg-40)";

/** 1234 → "1,234"; from 10,000 up "12.3K" / "4.56M" (the exact figure rides in `title`). */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 999_950) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString("en-US");
}
const exact = (n: number): string => (n >= 10_000 ? ` title="${attr(Math.round(n).toLocaleString("en-US"))}"` : "");

/** Bytes as "0 B" / "512 B" / "1.4 KB" / "23.0 MB" / "1.20 GB" (binary units). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** The polyline of a sparkline in a `w`×`h` box. The scale runs from ZERO to the peak (a day
 *  with half the requests sits at half height), and it never returns a broken path: no data,
 *  one point or all zeros is a flat line along the baseline. */
export function sparkPath(values: number[], w = 100, h = 24, pad = 3): string {
  const base = (h - pad).toFixed(1);
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const peak = Math.max(0, ...clean);
  if (clean.length < 2 || peak === 0) return `0,${base} ${w},${base}`;
  return clean.map((v, i) => `${((i / (clean.length - 1)) * w).toFixed(1)},${(h - pad - (v / peak) * (h - 2 * pad)).toFixed(1)}`).join(" ");
}

/** One series as an inline SVG, in the app's tokens (so it follows the theme). All zeros is a
 *  flat, muted line — "nothing happened", not a missing chart. `label` names it for a screen
 *  reader, with the total and the peak day. */
export function sparkline(values: number[], color: string, label: string, height = 24): string {
  const total = values.reduce((a, v) => a + (v > 0 ? v : 0), 0);
  const peak = Math.max(0, ...values);
  const flat = total === 0;
  const text = flat ? `${label}: none in this window` : `${label}: ${formatNumber(total)} in total, ${formatNumber(peak)} on the busiest day`;
  return `<svg class="plat-spark" role="img" aria-label="${attr(text)}" viewBox="0 0 100 24" preserveAspectRatio="none" style="display:block;width:100%;height:${height}px"><title>${esc(text)}</title><polyline points="${sparkPath(values)}" fill="none" stroke="${flat ? "var(--border-strong)" : color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></polyline></svg>`;
}

const REQ_COLOR = "var(--accent)";
const MCP_COLOR = "var(--blue)";
const requestsOf = (s: UsageDay[]): number[] => s.map((d) => d.requests);
const mcpOf = (s: UsageDay[]): number[] => s.map((d) => d.mcp_calls);

/** How busy an org was in the window — what the table sorts by. */
export const activityScore = (a: UsageActivity): number => a.api_requests + a.mcp_requests + a.mcp_tool_calls;
const createdTotal = (c: UsageCreated): number => c.feed_entries + c.tickets + c.doc_versions + c.sprints + c.prompts + c.handoffs + c.artifacts;
/** Nothing metered and nothing created: the window is empty. */
export const noActivity = (a: UsageActivity): boolean => activityScore(a) === 0 && createdTotal(a.created) === 0 && a.emails_sent === 0;

/** Most active first; ties by the latest activity, then by name. */
export function sortByActivity(orgs: OrgUsage[]): OrgUsage[] {
  return [...orgs].sort((a, b) => activityScore(b.activity) - activityScore(a.activity)
    || (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "")
    || a.name.localeCompare(b.name));
}

const CREATED_LABELS: [keyof UsageCreated, string][] = [
  ["feed_entries", "Feed entries"], ["tickets", "Tickets"], ["doc_versions", "Doc versions"], ["sprints", "Sprints"],
  ["prompts", "Prompts"], ["handoffs", "Handoffs"], ["artifacts", "Artifacts"],
];

/** What was created in the window, by kind, and the most used MCP tools — the opened row's
 *  (and the org detail's) breakdown. */
export function usageBreakdown(a: UsageActivity, days: number): string {
  const created = CREATED_LABELS.map(([k, label]) =>
    `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:5px 0;border-top:1px solid var(--border)"><span style="font-size:12.5px;color:var(--fg-70)">${label}</span><span style="${NUM};font-size:12.5px;color:${a.created[k] ? "var(--fg)" : "var(--fg-40)"}">${formatNumber(a.created[k])}</span></div>`).join("");
  const peak = Math.max(1, ...a.top_tools.map((t) => t.count));
  const tools = a.top_tools.length
    ? a.top_tools.map((t) => `<div style="padding:5px 0;border-top:1px solid var(--border)">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px"><span style="font-family:var(--code);font-size:12px;color:var(--fg-70);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.tool)}</span><span style="${NUM};font-size:12.5px">${formatNumber(t.count)}</span></div>
        <div aria-hidden="true" style="height:3px;margin-top:4px;background:var(--hover)"><div style="height:100%;width:${Math.max(2, Math.round((t.count / peak) * 100))}%;background:${MCP_COLOR}"></div></div>
      </div>`).join("")
    : `<div style="padding:8px 0;border-top:1px solid var(--border);${QUIET}">No MCP tool was called in the last ${days} days.</div>`;
  const line = (label: string, value: string) => `<span style="white-space:nowrap">${label} <span style="${NUM};color:var(--fg-70)">${value}</span></span>`;
  return `<div class="plat-breakdown">
    <div style="min-width:0"><div style="${LABEL};margin-bottom:8px">Created in the last ${days} days</div>${created}</div>
    <div style="min-width:0"><div style="${LABEL};margin-bottom:8px">Top MCP tools</div>${tools}</div>
    <div class="plat-breakdown-foot" style="display:flex;flex-wrap:wrap;gap:6px 18px;${QUIET}">
      ${line("API reads", formatNumber(a.api_reads))}${line("API writes", formatNumber(a.api_writes))}${line("MCP requests", formatNumber(a.mcp_requests))}${line("Emails sent", formatNumber(a.emails_sent))}
    </div>
  </div>`;
}

interface Tile { label: string; value: string; raw?: number; sub: string; spark?: string }
function tiles(items: Tile[]): string {
  return `<div class="repo-cells"><div class="plat-tiles">${items.map((t) => `<div style="padding:16px 20px">
      <div style="${LABEL};overflow:hidden;text-overflow:ellipsis">${esc(t.label)}</div>
      <div style="display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-top:8px"><span class="plat-tile-n" style="${NUM};font-size:27px;letter-spacing:-0.02em"${t.raw !== undefined ? exact(t.raw) : ""}>${esc(t.value)}</span><span style="font-size:11px;color:var(--fg-40)">${esc(t.sub)}</span></div>
      ${t.spark ? `<div style="margin-top:10px">${t.spark}</div>` : ""}
    </div>`).join("")}</div></div>`;
}

/** One organization's usage, on its detail page: four tiles (two with their sparkline),
 *  its sizes, and the breakdown. */
export function orgUsageBlock(u: OrgUsage, days: number): string {
  const a = u.activity, z = u.sizes;
  const size = (label: string, value: string) => `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:6px 0;border-top:1px solid var(--border)"><span style="font-size:12.5px;color:var(--fg-70)">${label}</span><span style="${NUM};font-size:12.5px">${value}</span></div>`;
  return `<div${surface("overflow:hidden", { cls: "plat-cq" })}>
    ${tiles([
      { label: "API requests", value: formatNumber(a.api_requests), raw: a.api_requests, sub: `last ${days} days`, spark: sparkline(requestsOf(u.series), REQ_COLOR, "API requests per day", 30) },
      { label: "MCP tool calls", value: formatNumber(a.mcp_tool_calls), raw: a.mcp_tool_calls, sub: `last ${days} days`, spark: sparkline(mcpOf(u.series), MCP_COLOR, "MCP tool calls per day", 30) },
      { label: "Active people", value: formatNumber(a.active_people), sub: `of ${formatNumber(z.members)} ${z.members === 1 ? "member" : "members"}` },
      { label: "Storage", value: formatBytes(z.artifact_bytes), sub: `${formatNumber(z.artifacts)} ${z.artifacts === 1 ? "artifact" : "artifacts"}` },
    ])}
    <div style="padding:16px 20px;border-top:1px solid var(--border)">
      ${noActivity(a) ? `<div style="${QUIET};margin-bottom:14px">No activity in the last ${days} days.</div>` : ""}
      ${usageBreakdown(a, days)}
      <div style="${LABEL};margin:18px 0 8px">Size now</div>
      <div class="plat-sizes">
        ${size("Docs", formatNumber(z.docs))}${size("Feed entries", formatNumber(z.feed_entries))}${size("Tickets", `${formatNumber(z.tickets_open)} open of ${formatNumber(z.tickets_total)}`)}
        ${size("Sprints", formatNumber(z.sprints))}${size("Prompts", formatNumber(z.prompts))}${size("Handoffs", formatNumber(z.handoffs))}
        ${size("MCP tokens", formatNumber(z.mcp_tokens))}${size("OAuth grants", formatNumber(z.oauth_grants))}${size("Repo events", formatNumber(z.repo_events))}
      </div>
    </div>
  </div>`;
}

export interface UsageProps {
  status: "idle" | "loading" | "ok" | "error";
  usage: PlatformUsageResponse | null;
  days: UsageWindow;
  /** The org row that is open (its slug), or null. */
  open: string | null;
}

const CHEV = (open: boolean): string => `<svg class="plat-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true" style="flex:none;transform:rotate(${open ? 90 : 0}deg)"><path d="M9 6l6 6-6 6"></path></svg>`;

function orgRow(u: OrgUsage, days: number, open: boolean): string {
  const a = u.activity, z = u.sizes;
  const cell = (label: string, inner: string, cls = "") => `<div class="plat-c${cls ? ` ${cls}` : ""}" style="min-width:0"><span class="plat-cl">${label}</span>${inner}</div>`;
  const metric = (n: number, spark: string) => `<div style="display:flex;align-items:center;gap:10px;min-width:0"><span style="${NUM};font-size:14px;color:${n ? "var(--fg)" : "var(--fg-40)"};min-width:46px"${exact(n)}>${formatNumber(n)}</span><span style="flex:1;min-width:40px;max-width:120px">${spark}</span></div>`;
  // The figures that matter are the two metered ones; the sizes beside them are context.
  const num = (n: number) => `<span style="font-variant-numeric:tabular-nums;font-size:12.5px;font-weight:400;white-space:nowrap;color:${n ? "var(--fg-55)" : "var(--fg-40)"}">${formatNumber(n)}</span>`;
  const id = `plat-usage-${u.slug}`;
  return `<div class="plat-urow" data-open="${open ? "1" : "0"}">
    <button type="button" data-act="platUsageToggle" data-arg="${attr(u.slug)}" data-field="platUsageRow:${attr(u.slug)}" aria-expanded="${open}" aria-controls="${attr(id)}" class="plat-row plat-usage-grid" style="width:100%;text-align:left;padding:12px 20px">
      <div class="plat-c plat-c-name" style="min-width:0;display:flex;align-items:center;gap:9px">${CHEV(open)}<span style="min-width:0"><span style="display:flex;align-items:center;gap:8px;min-width:0"><span style="font-size:13.5px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.name)}</span>${u.status === "suspended" ? statusBadge("SUSPENDED", "var(--red)") : ""}</span><span style="display:block;font-family:var(--code);font-size:11.5px;color:var(--fg-40);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.slug)}</span></span></div>
      ${cell("API requests", metric(a.api_requests, sparkline(requestsOf(u.series), REQ_COLOR, `${u.name}: API requests per day`)), "plat-c-wide")}
      ${cell("MCP calls", metric(a.mcp_tool_calls, sparkline(mcpOf(u.series), MCP_COLOR, `${u.name}: MCP tool calls per day`)), "plat-c-wide")}
      ${cell("Active", num(a.active_people))}
      ${cell("Members", num(z.members))}
      ${cell("Docs", num(z.docs))}
      ${cell("Tickets", num(z.tickets_total))}
      ${cell("Artifacts", `<span style="white-space:nowrap">${num(z.artifacts)} <span style="${QUIET}">· ${formatBytes(z.artifact_bytes)}</span></span>`)}
      ${cell("Last activity", `<span style="font-size:12px;color:var(--fg-40);white-space:nowrap">${u.last_activity_at ? esc(relTime(u.last_activity_at)) : "Never"}</span>`)}
    </button>
    ${open ? `<div id="${attr(id)}" style="padding:16px 20px 18px 41px;border-top:1px solid var(--border);background:var(--bg)" class="plat-urow-body">${usageBreakdown(a, days)}
      <button type="button" data-act="platOpenOrg" data-arg="${attr(u.slug)}" class="cnpy-mutelink" style="margin-top:12px;padding:0;font-size:12.5px;font-weight:500;color:var(--accent)">Open ${esc(u.name)}</button></div>` : ""}
  </div>`;
}

/** The window switch — the app's segmented control. */
export function usageWindowSwitch(days: UsageWindow): string {
  return segmented({
    id: "plat-usage-days", ariaLabel: "Usage window", act: "platUsageDays", value: String(days), size: "sm", inertOn: true,
    options: USAGE_WINDOWS.map((d) => ({ value: String(d), label: `${d} days` })),
  });
}

const dashed = (title: string, sub: string): string =>
  `<div style="border:1px dashed var(--border-strong);border-radius:11px;padding:22px 24px;text-align:center"><div style="font-size:13.5px;font-weight:600;color:var(--fg-70)">${esc(title)}</div><div style="font-size:12.5px;color:var(--fg-40);margin-top:4px;line-height:1.5">${esc(sub)}</div></div>`;

export function usageView(p: UsageProps): string {
  const u = p.usage;
  const ranked = u ? sortByActivity(u.orgs) : [];
  const active = ranked.filter((o) => !noActivity(o.activity)).length;
  // The lead says what the tiles under it do not: how many organizations did anything, and which most.
  const head = tabLead(`${u ? `<strong>${active} of ${u.orgs.length}</strong> ${u.orgs.length === 1 ? "organization" : "organizations"} active in ${u.days} days${active ? ` &middot; busiest <strong>${esc(ranked[0].name)}</strong>` : ""}. ` : ""}Sizes and counts only: no organization's content is read here.`, usageWindowSwitch(p.days));
  if (!u) {
    return head + (p.status === "error"
      ? `<div role="alert" style="font-size:13px;color:var(--fg-70)">Couldn't load usage. <button type="button" data-act="platReload" class="cnpy-mutelink" style="padding:0;font-size:13px;font-weight:500;color:var(--accent)">Try again</button></div>`
      : `<div style="font-size:12.5px;color:var(--fg-40);padding:10px 0">Loading usage…</div>`);
  }
  const t = u.totals, a = t.activity;
  const top = tiles([
    { label: "Organizations", value: formatNumber(t.orgs), sub: t.suspended_orgs ? `${t.suspended_orgs} suspended` : "none suspended" },
    { label: "People", value: formatNumber(t.persons), sub: "with an account" },
    { label: "API requests", value: formatNumber(a.api_requests), raw: a.api_requests, sub: `${formatNumber(a.api_reads)} reads · ${formatNumber(a.api_writes)} writes`, spark: sparkline(requestsOf(t.series), REQ_COLOR, "API requests per day, all organizations", 30) },
    { label: "MCP tool calls", value: formatNumber(a.mcp_tool_calls), raw: a.mcp_tool_calls, sub: `${formatNumber(a.mcp_requests)} MCP requests`, spark: sparkline(mcpOf(t.series), MCP_COLOR, "MCP tool calls per day, all organizations", 30) },
    { label: "Active people", value: formatNumber(a.active_people), sub: `last ${u.days} days` },
    { label: "Storage", value: formatBytes(t.sizes.artifact_bytes), sub: `${formatNumber(t.sizes.artifacts)} ${t.sizes.artifacts === 1 ? "artifact" : "artifacts"}` },
  ]);
  const empty = noActivity(a)
    ? `<div style="margin-top:14px">${dashed(`No activity in the last ${u.days} days`, u.orgs.length ? "Requests and MCP tool calls appear here once a member or an agent uses an organization. Sizes below are current." : "Add an organization first. Its requests and MCP tool calls will appear here.")}</div>`
    : "";
  const rows = sortByActivity(u.orgs);
  const table = rows.length ? `<div${surface("overflow:hidden;margin-top:14px", { cls: "plat-table" })}>
      <div class="plat-thead plat-usage-grid" aria-hidden="true" style="padding:12px 20px 9px;border-bottom:1px solid var(--border)">
        <span style="padding-left:21px">Organization</span><span>API requests</span><span>MCP calls</span><span>Active</span><span>Members</span><span>Docs</span><span>Tickets</span><span>Artifacts</span><span>Last activity</span>
      </div>
      ${rows.map((o) => orgRow(o, u.days, p.open === o.slug)).join("")}
    </div>
    <div style="${QUIET};margin-top:10px">${esc(u.since)} to ${esc(u.until)} (UTC), most active first. Open a row for what was created and its most used MCP tools.</div>` : "";
  return `${head}<div${surface("overflow:hidden", { cls: `plat-cq${p.status === "loading" ? " plat-busy" : ""}` })}>${top}</div>${empty}${table}`;
}
