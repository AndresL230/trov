// Repo dashboard › Usage — the design's UsageTarget (repo setups, Phase G): ONE card per TARGET (a part: an app in
// an environment), then what its provider's EXTRA families say — requests by outcome, the Worker's runtime, its D1
// databases, its cron triggers — for the parts whose provider reads them.
//
// THE SPA NEVER BRANCHES ON A PROVIDER ID: a card reads the part's role, its `families` (what its provider reads), its
// `connection` (THE status function) and its figures; an extra block appears because the part CARRIES that family.
//
// NEVER A GUESS (invariant 7). A card is in exactly one of four states, the three empty ones drawn as #185 drew them:
//   ok           figures for the range on screen
//   stale        "No recent reading" — the source has reported before, or its host is connected and has not yet
//   nc           "Not connected" — the part's host is not connected (an admin is offered Connect <host>)
//   na           "Not available from <host>" + its reason — the host has nothing Trov can read for this role
// A repository never reads "not connected" for a thing it does not have: a part's host that reports no usage is
// `na`, never `nc`, and a family a provider does not read is not drawn at all. An unconfirmed figure never shows.
//
// Pure: props in, markup out. Motion hooks are the dashboard's (`repo-swap` for the range switch, `repo-spark`).

import { REPO_WIDE, type FactsPart, type RepoFacts } from "@shared/repo-facts-core";
import type { RepoRange, RepoTone, RepoUsageEnv } from "@shared/repo";
import { HOSTING_METRICS, type RepoProviderPart } from "@shared/hosting";
import type { CoreFamily, PartExtras, UsageTone } from "@shared/usage-families-core";
import { esc, attr } from "./ui";
import { markShape, stateMark } from "./marks";
import { emptyLayout } from "./skeleton";
import { compactNumber, errorRateTone, formatBytes, formatMemory, gapPath, neverReadLine, type RepoHostingTools } from "./repo-hosting";

const LABEL_SM = "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";
const NUM = "font-family:var(--label);font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap";
const QUIET = "font-size:11.5px;color:var(--fg-40)";
const TOP = "border-top:1px solid var(--border)";
const TONE: Record<RepoTone, string> = { neutral: "var(--fg-40)", good: "var(--green)", warn: "var(--amber)", bad: "var(--red)" };

export type TargetState = "ok" | "stale" | "nc" | "na";

/** The figures a role reads, in words — the not-connected sentence's "to see …". */
const WHAT: Record<RepoProviderPart["role"], string> = { web: "requests and error rate", service: "CPU and memory" };

/** Does the part's provider read the role's CORE family at all? (`families` absent — a payload from before Phase G —
 *  falls back on what the projection already says: a web part with `traffic: null` reads none.) */
function readsRole(p: RepoProviderPart): boolean {
  if (p.role === "web" && p.traffic === null) return false;
  if (!p.families) return true;
  return p.families.includes(CORE_OF_ROLE[p.role]);
}
/** The core family a card's headline figures come from, per role. */
const CORE_OF_ROLE: Record<RepoProviderPart["role"], CoreFamily> = { web: "traffic", service: "compute" };

/** THE state of one target in one range (exported: the tests hold every scenario to it). */
export function targetState(p: RepoProviderPart, range: RepoRange): TargetState {
  if (!readsRole(p)) return "na";
  if (p.connection === "not_connected" || p.connection === "revoked") return "nc";
  if (p.role === "web") return p.traffic?.[range].requests !== null && p.traffic?.[range].requests !== undefined ? "ok" : "stale";
  return p.resources && (p.resources.cpu !== null || p.resources.mem_mb !== null) ? "ok" : "stale";
}

/** Why the host has nothing for this role: its own reason (`unavailable`), else a plain sentence. */
function naReason(p: RepoProviderPart): string {
  const mine = p.unavailable.find((u) => HOSTING_METRICS[u.metric]?.role === p.role);
  return mine?.reason ?? `${p.provider_label} reports no ${p.role === "web" ? "traffic" : "CPU or memory"} Trov can read.`;
}

export interface UsageOpts { admin: boolean; sample: boolean; app?: string | null }

/**
 * A target the facts name but the providers section does not carry (a section that is `empty` sends no part, or a
 * part nothing has been read for): the part as the facts know it — its role, host, connection and whether its host
 * reads usage at all (`reportsMetrics`, a capability) — with NO figure. It can only read `nc`, `na` or "No recent
 * reading"; never a number.
 */
export function partFromFacts(fp: FactsPart, envLabel: string): RepoProviderPart {
  const blank = { requests: null, errors: null, error_rate: null, latency_p95_ms: null, bandwidth_bytes: null, trend: [] };
  return {
    env: fp.env, env_label: envLabel, part: fp.app, label: fp.label, role: fp.role, provider: fp.provider, provider_label: fp.host,
    console_url: fp.consoleUrl, deploys: [],
    traffic: fp.role === "web" && fp.reportsMetrics ? { "24h": blank, "7d": blank, "30d": blank } : null,
    resources: fp.role === "service" ? { cpu: null, mem_mb: null, at: null, trend: [] } : null,
    seen: { traffic: false, resources: false, deploys: false }, unavailable: [], status: "not_connected", tone: "neutral", last_poll: null,
    // Deploys that arrive through GitHub while the host is not connected leave its figures not connected.
    connection: fp.viaGithub ? "not_connected" : fp.connection,
    families: fp.reportsMetrics ? [CORE_OF_ROLE[fp.role]] : [],
  };
}

/** The targets of a facts view: each facts part (already narrowed by the App menu) with the providers section's own
 *  part when it carries one, else `partFromFacts`. */
export function targetsFromFacts(f: Pick<RepoFacts, "parts" | "envs">, providerParts: readonly RepoProviderPart[]): RepoProviderPart[] {
  return f.parts.map((fp) => providerParts.find((x) => x.env === fp.env && x.part === fp.app)
    ?? partFromFacts(fp, f.envs.find((e) => e.key === fp.env)?.name ?? fp.env));
}

/** The parts the Usage tab shows: every part, or (the App menu) only the chosen app's; none for Repo-wide only. */
export function targetsInView(parts: RepoProviderPart[], app: string | null | undefined): RepoProviderPart[] {
  if (app === REPO_WIDE) return [];
  return app ? parts.filter((p) => p.part === app) : parts;
}

// ── a target card ────────────────────────────────────────────────────────────

interface Row { key: string; label: string; value: string; color?: string; of?: string; spark: string }

const sparkLine = (points: string, stroke: string, key: string): string =>
  points ? `<svg class="repo-spark" data-uspark="${attr(key)}" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true" style="width:100%;height:40px;display:block;margin-top:8px"><polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.6" vector-effect="non-scaling-stroke"></polyline></svg>` : "";
const gapLine = (d: string, stroke: string, key: string): string =>
  d ? `<svg class="repo-spark" data-uspark="${attr(key)}" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true" style="width:100%;height:40px;display:block;margin-top:8px"><path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke"></path></svg>` : "";

function rowsOf(p: RepoProviderPart, t: RepoHostingTools, users: RepoUsageEnv | null): Row[] {
  if (p.role === "web" && p.traffic) {
    const r = p.traffic[t.range];
    const rows: Row[] = [];
    if (r.requests !== null) rows.push({ key: "requests", label: `Requests · ${t.range}`, value: compactNumber(r.requests), spark: sparkLine(r.trend.length > 1 ? t.sparkPoints(r.trend.map((b) => b.requests)) : "", "var(--accent)", "requests") });
    if (r.error_rate !== null) {
      const c = TONE[errorRateTone(r.error_rate) === "good" ? "good" : errorRateTone(r.error_rate)];
      rows.push({ key: "error_rate", label: "Error rate", value: `${r.error_rate.toFixed(2)}%`, color: c,
        spark: sparkLine(r.trend.length > 1 ? t.sparkPoints(r.trend.map((b) => (b.requests ? (b.errors / b.requests) * 100 : 0))) : "", c, "error_rate") });
    }
    if (r.latency_p95_ms !== null) rows.push({ key: "latency_p95_ms", label: "p95 latency", value: `${Math.round(r.latency_p95_ms)} ms`, spark: "" });
    if (r.bandwidth_bytes !== null) rows.push({ key: "bandwidth_bytes", label: "Bandwidth", value: formatBytes(r.bandwidth_bytes), spark: "" });
    const u = users?.users ?? null;
    if (u) rows.push({ key: "users", label: "Active users", value: u.value, spark: sparkLine(u.trend.length > 1 ? t.sparkPoints(u.trend) : "", "var(--blue)", "users") });
    return rows;
  }
  const res = p.resources;
  if (!res) return [];
  const rows: Row[] = [];
  if (res.cpu !== null) rows.push({ key: "cpu", label: "CPU", value: res.cpu.toFixed(2), of: "vCPU", spark: gapLine(gapPath(res.trend.map((x) => ({ at: x.at, v: x.cpu }))), "var(--accent)", "cpu") });
  if (res.mem_mb !== null) rows.push({ key: "mem_mb", label: "Memory", value: formatMemory(res.mem_mb), spark: gapLine(gapPath(res.trend.map((x) => ({ at: x.at, v: x.mem_mb }))), "var(--blue)", "mem_mb") });
  return rows;
}

const metricRow = (m: Row): string => `<div data-urow="${attr(m.key)}" style="${TOP};padding:12px 0">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px"><span style="${LABEL_SM}">${esc(m.label)}</span><span style="display:flex;align-items:baseline;gap:6px"><span style="${NUM};font-size:17px;${m.color ? `color:${m.color}` : ""}">${esc(m.value)}</span>${m.of ? `<span style="${QUIET}">${esc(m.of)}</span>` : ""}</span></div>
    ${m.spark}
  </div>`;

/** One target, as the design's UsageTarget draws it. `users`: the environment's active users, for its first web part. */
export function targetCard(p: RepoProviderPart, t: RepoHostingTools, o: UsageOpts, users: RepoUsageEnv | null = null): string {
  const state = targetState(p, t.range);
  const source = state === "ok" || state === "stale" ? `from ${p.provider_label}` : "";
  const head = `<div style="display:flex;align-items:baseline;gap:9px;margin-bottom:10px;min-width:0">
      <span style="font-size:15px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.label)}</span>
      <span style="font-size:12.5px;color:var(--fg-55);white-space:nowrap">${esc(p.env_label)}</span>
      ${source ? `<span style="margin-left:auto;font-size:11px;color:var(--fg-40);white-space:nowrap">${esc(source)}</span>` : ""}
    </div>`;
  let body = "";
  if (state === "ok") {
    body = rowsOf(p, t, users).map(metricRow).join("");
  } else if (state === "stale") {
    const labels = p.role === "web" ? [`Requests · ${t.range}`, "Error rate"] : ["CPU", "Memory"];
    const last = p.last_poll ? ` · last poll ${t.ago(p.last_poll.at, t.now)} ago` : "";
    const note = p.status === "not_connected" ? neverReadLine(p)
      : esc(`${p.provider_label} has not reported for this range. Readings resume when it does; nothing is assumed in between.`);
    body = `${labels.map((l) => `<div style="${TOP};padding:12px 0;display:flex;align-items:center;justify-content:space-between;gap:8px"><span style="${LABEL_SM}">${esc(l)}</span><span style="display:flex;align-items:center;gap:6px">${stateMark("No recent reading", "var(--fg-55)", "ring", 11.5)}<span style="${QUIET}">${esc(last)}</span></span></div>`).join("")}
      <div data-ustale style="font-size:12px;line-height:1.5;color:var(--fg-55);padding:2px 0 8px">${note}</div>`;
  } else if (state === "nc") {
    const action = o.admin && !o.sample
      ? `<button type="button" data-act="orgGo" data-arg="hosting" class="cnpy-accentbtn" style="margin-top:12px;height:30px;padding:0 13px;border-radius:8px;background:var(--accent);color:var(--accent-fg);border:1px solid transparent;font-size:12.5px;font-weight:600;white-space:nowrap">Connect ${esc(p.provider_label)}</button>`
      : o.admin ? "" : `<div style="${QUIET};margin-top:8px">An admin connects it in Org settings › Hosting.</div>`;
    body = `<div style="flex:1;display:flex;align-items:center;padding:6px 0 12px"><div data-unc style="border:1px dashed color-mix(in srgb,var(--accent) 45%,transparent);border-radius:11px;padding:18px 20px;text-align:center;width:100%;box-sizing:border-box;background:color-mix(in srgb,var(--accent) 4%,transparent)">
        <div style="font-size:13.5px;font-weight:600">Not connected</div>
        <div style="font-size:12.5px;color:var(--fg-55);margin-top:4px;line-height:1.55">${esc(`Connect ${p.provider_label} to see ${WHAT[p.role]} for ${p.label} in ${p.env_label}.`)}</div>
        ${action}
      </div></div>`;
  } else {
    body = `<div data-una style="${TOP};padding:14px 0 12px;flex:1">
        <div style="font-size:13px;line-height:1.55;color:var(--fg-70)">${esc(`Not available from ${p.provider_label}`)}</div>
        <div style="font-size:12px;line-height:1.5;color:var(--fg-55);margin-top:4px">${esc(naReason(p))}</div>
      </div>`;
  }
  return `<div data-utarget="${attr(`${p.env}/${p.part}`)}" data-ustate="${state}" style="padding:18px 20px 8px;min-width:0;box-sizing:border-box;display:flex;flex-direction:column">${head}${body}</div>`;
}

/** Every target in view, side by side on the dashboard's lattice. The environment's active users ride its FIRST web
 *  part (they are the app's, not a host's) — only when that environment has ever reported them. */
export function usageTargets(parts: RepoProviderPart[], t: RepoHostingTools, o: UsageOpts, usersByEnv: ReadonlyMap<string, RepoUsageEnv> = new Map()): string {
  const shown = targetsInView(parts, o.app);
  if (!shown.length) {
    const text = o.app === REPO_WIDE
      ? "Usage is read per app — Repo-wide only has none. Pick an app, or All apps, in the App menu."
      : "Usage is read per target. Accept the apps Trov found in Org settings, give each a target and a host connection, and their traffic or CPU and memory show here.";
    return `<div data-utargets="none">${emptyLayout("repo-usage-targets", { text, sayStyle: "margin:14px 20px 16px" })}</div>`;
  }
  const firstWeb = new Set<string>();
  const cards = shown.map((p) => {
    const env = usersByEnv.get(p.env_label) ?? null;
    const takesUsers = p.role === "web" && !firstWeb.has(p.env) && env !== null && (env.users !== null || env.seen.users);
    if (takesUsers) firstWeb.add(p.env);
    return targetCard(p, t, o, takesUsers ? env : null);
  });
  return `<div class="repo-cells repo-swap" data-utargets="${shown.length}"><div style="grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr))">${cards.join("")}</div></div>`;
}

// ── the extra families ───────────────────────────────────────────────────────

const OUTCOME_FILL: Record<UsageTone, string> = { good: "var(--green)", neutral: "var(--fg-40)", warn: "var(--amber)", bad: "var(--red)" };
const OUTCOME_SHAPE: Record<UsageTone, Parameters<typeof markShape>[0]> = { good: "dot", neutral: "square", warn: "triangle", bad: "diamond" };
const shortDay = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const ms = (v: number): string => (v < 100 ? v.toFixed(1) : String(Math.round(v)));

const blockHead = (title: string, aside: string): string =>
  `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px"><span style="${LABEL_SM};min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(title)}</span><span style="font-size:11px;color:var(--fg-40);white-space:nowrap">${esc(aside)}</span></div>`;
const calm = (key: string, text: string): string => `<div data-ucalm="${attr(key)}" style="font-size:12px;line-height:1.5;color:var(--fg-55)">${esc(text)}</div>`;
const stat = (fig: string, unit: string, label: string, key: string): string => `<div data-ustat="${attr(key)}" style="min-width:0">
    <div style="${NUM};font-size:21px;letter-spacing:-0.02em">${esc(fig)}${unit ? `<span style="font-size:11.5px;font-weight:500;letter-spacing:0;color:var(--fg-55);margin-left:5px">${esc(unit)}</span>` : ""}</div>
    <div style="font-size:12px;color:var(--fg-55);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</div>
  </div>`;
/** "since Oct 14" when the family's capture began inside the range (the range is partial), else "". */
const sinceNote = (since: string | null, range: RepoRange, now: number): string => {
  if (!since) return "";
  const hours = range === "24h" ? 24 : range === "7d" ? 168 : 720;
  return Date.parse(since) > now - hours * 3_600_000 + 3_600_000 ? ` · since ${shortDay(since)}` : "";
};
/** The words for a family the provider could not read, or that has gone quiet. */
const familyCalm = (state: string, reason: string | null, host: string): string | null =>
  state === "unavailable" ? `Not available from ${host}${reason ? `: ${reason}` : ""}.`.replace(/\.\.$/, ".")
    : state === "stale" ? "No recent reading." : null;

function outcomeBlock(p: RepoProviderPart, x: NonNullable<PartExtras["outcomes"]>, t: RepoHostingTools, name: string): string {
  const aside = `from ${p.provider_label} · last ${t.range}${sinceNote(x.since, t.range, t.now)}`;
  const calmText = familyCalm(x.state, x.reason, p.provider_label);
  const buckets = x.ranges[t.range];
  let body: string;
  if (x.state === "unavailable" && calmText) body = calm("outcomes", calmText);
  else if (buckets === null) body = calm("outcomes", "No recent reading.");
  else if (!buckets.length) body = calm("outcomes", "No request in this range.");
  else {
    const total = buckets.reduce((n, b) => n + b.count, 0) || 1;
    body = `<div role="img" aria-label="Requests by outcome" style="display:flex;height:10px;border-radius:999px;overflow:hidden;background:var(--hover);gap:2px">${buckets.map((b) =>
        `<span data-uoutcome-bar="${attr(b.status)}" title="${attr(`${b.label}: ${compactNumber(b.count)}`)}" style="display:block;height:100%;width:${Math.max(0.6, (b.count / total) * 100).toFixed(2)}%;background:${OUTCOME_FILL[b.tone]}"></span>`).join("")}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(190px,100%),1fr));gap:10px 18px;margin-top:12px">${buckets.map((b) =>
        `<div data-uoutcome="${attr(b.status)}" style="display:flex;align-items:baseline;gap:8px;min-width:0"><span style="align-self:center;display:flex">${markShape(OUTCOME_SHAPE[b.tone], OUTCOME_FILL[b.tone], 9)}</span><span style="${NUM};font-size:17px">${esc(compactNumber(b.count))}</span><span style="font-size:12px;color:var(--fg-55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.label)}</span></div>`).join("")}</div>
      <div style="font-size:11px;color:var(--fg-40);margin-top:10px">How each invocation ended, as ${esc(p.provider_label)} reports it — not an HTTP status.</div>`;
  }
  return `<div data-uextra="outcomes" style="padding:16px 20px 18px;${TOP}">${blockHead(`Requests by outcome · ${name}`, aside)}${body}</div>`;
}

function runtimeBlock(p: RepoProviderPart, x: NonNullable<PartExtras["runtime"]>, t: RepoHostingTools, name: string): string {
  const calmText = familyCalm(x.state, x.reason, p.provider_label);
  const sub = x.subrequests[t.range];
  const figs = [
    x.cpu_p50_ms !== null ? stat(ms(x.cpu_p50_ms), "ms", "CPU time p50", "cpu_p50") : "",
    x.cpu_p99_ms !== null ? stat(ms(x.cpu_p99_ms), "ms", "CPU time p99", "cpu_p99") : "",
    x.wall_p50_ms !== null ? stat(ms(x.wall_p50_ms), "ms", "Wall time p50", "wall_p50") : "",
    sub !== null ? stat(compactNumber(sub), "", `Subrequests · ${t.range}`, "subrequests") : "",
  ].filter(Boolean);
  const line = x.trend.length > 1 ? t.sparkPoints(x.trend.map((d) => d.cpu_p99_ms)) : "";
  const body = figs.length
    ? `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px">${figs.join("")}</div>
       ${line ? `<svg class="repo-spark" data-uspark="cpu_p99" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true" style="width:100%;height:40px;display:block;margin-top:14px"><polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.6" vector-effect="non-scaling-stroke"></polyline></svg>` : ""}
       <div style="font-size:11px;color:var(--fg-40);margin-top:6px">${esc(x.day ? `CPU time p99 per day · quantiles for ${shortDay(`${x.day}T00:00:00Z`)}, the last completed UTC day` : "CPU time p99 per day")}</div>`
    : calm("runtime", calmText ?? "No recent reading.");
  return `<div data-uextra="runtime" style="padding:16px 20px 18px;min-width:0">${blockHead(`Worker · ${name}`, `from ${p.provider_label}`)}${body}</div>`;
}

function storageBlocks(p: RepoProviderPart, x: NonNullable<PartExtras["storage"]>, t: RepoHostingTools): string[] {
  const calmText = familyCalm(x.state, x.reason, p.provider_label);
  if (!x.databases.length) {
    return calmText ? [`<div data-uextra="storage" style="padding:16px 20px 18px;min-width:0">${blockHead("D1 database", `from ${p.provider_label}`)}${calm("storage", calmText)}</div>`] : [];
  }
  const days = t.range === "24h" ? "the last completed day" : t.range === "7d" ? "the last 7 completed days" : "the last 30 completed days";
  return x.databases.map((d) => {
    const figs = [
      d.read_queries[t.range] !== null ? stat(compactNumber(d.read_queries[t.range]!), "", "Read queries", "read_queries") : "",
      d.write_queries[t.range] !== null ? stat(compactNumber(d.write_queries[t.range]!), "", "Write queries", "write_queries") : "",
      d.rows_read[t.range] !== null ? stat(compactNumber(d.rows_read[t.range]!), "", "Rows read", "rows_read") : "",
      d.rows_written[t.range] !== null ? stat(compactNumber(d.rows_written[t.range]!), "", "Rows written", "rows_written") : "",
      d.size_bytes !== null ? stat(formatBytes(d.size_bytes), "", "Database size", "size_bytes") : "",
    ].filter(Boolean);
    const line = d.trend.length > 1 ? t.sparkPoints(d.trend.map((x2) => x2.reads)) : "";
    const body = figs.length
      ? `<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px 16px">${figs.join("")}</div>
         ${line ? `<svg class="repo-spark" data-uspark="d1_reads" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true" style="width:100%;height:40px;display:block;margin-top:14px"><polyline points="${line}" fill="none" stroke="var(--blue)" stroke-width="1.6" vector-effect="non-scaling-stroke"></polyline></svg>` : ""}
         <div style="font-size:11px;color:var(--fg-40);margin-top:6px">${esc(`Read queries per day · counts over ${days}${d.size_day ? ` · size on ${shortDay(`${d.size_day}T00:00:00Z`)}` : ""}`)}</div>`
      : calm("storage", "No reading for this range.");
    return `<div data-uextra="storage" data-udb="${attr(d.id)}" style="padding:16px 20px 18px;min-width:0">${blockHead(`D1 database · ${d.id.slice(0, 8)}`, `from ${p.provider_label}`)}${body}</div>`;
  });
}

function cronBlock(p: RepoProviderPart, x: NonNullable<PartExtras["schedules"]>, t: RepoHostingTools, name: string): string {
  const aside = `cron triggers · from ${p.provider_label} · last ${t.range}${sinceNote(x.since, t.range, t.now)}`;
  const calmText = familyCalm(x.state, x.reason, p.provider_label);
  const head = blockHead(`Scheduled runs · ${name}`, aside);
  if (!x.crons.length) return `<div data-uextra="schedules" style="padding:16px 20px 18px;${TOP}">${head}${calm("schedules", calmText ?? "No cron trigger has run.")}</div>`;
  const cols = "grid-template-columns:18px minmax(0,1.2fr) 70px 70px minmax(0,90px)";
  const rows = x.crons.map((c) => {
    const runs = c.runs[t.range], failed = c.failed[t.range];
    const bad = failed !== null && failed > 0;
    const mk = runs === null ? markShape("ring", "var(--fg-55)", 9) : bad ? markShape("diamond", "var(--red)", 9) : runs > 0 ? markShape("dot", "var(--green)", 9) : markShape("ring", "var(--fg-55)", 9);
    return `<div data-ucron="${attr(c.expr)}" style="display:grid;${cols};gap:12px;align-items:center;padding:7px 0;${TOP}">
        <span style="display:flex">${mk}</span>
        <code style="font-family:var(--code);font-size:12px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.expr)}</code>
        <span style="${NUM};font-size:12.5px;text-align:right">${runs === null ? "&mdash;" : esc(compactNumber(runs))}</span>
        <span style="${NUM};font-size:12.5px;text-align:right;${bad ? "color:var(--red)" : "color:var(--fg-40);font-weight:400"}">${failed === null ? "&mdash;" : esc(String(failed))}</span>
        <span style="font-size:12px;color:var(--fg-55);text-align:right;white-space:nowrap">${c.last_run ? `${esc(t.ago(c.last_run, t.now))} ago` : "&mdash;"}</span>
      </div>`;
  }).join("");
  return `<div data-uextra="schedules" style="padding:16px 20px 18px;${TOP}">${head}
      <div style="overflow-x:auto"><div style="min-width:420px">
        <div style="display:grid;${cols};gap:12px;padding:0 0 6px"><span></span><span style="${LABEL_SM}">Schedule</span><span style="${LABEL_SM};text-align:right">Runs</span><span style="${LABEL_SM};text-align:right">Failed</span><span style="${LABEL_SM};text-align:right">Last run</span></div>
        ${rows}
      </div></div>
      ${calmText && x.state === "unavailable" ? `<div style="margin-top:8px">${calm("schedules", calmText)}</div>` : ""}
    </div>`;
}

/** The extra families of every target in view that carries them — and whose card is not `nc` / `na` (a host that is
 *  not connected, or has nothing to read, says so once, on its card). A family never read (`none`) is not drawn. */
export function usageExtras(parts: RepoProviderPart[], t: RepoHostingTools, o: UsageOpts): string {
  const shown = targetsInView(parts, o.app).filter((p) => p.extras && (targetState(p, t.range) === "ok" || targetState(p, t.range) === "stale"));
  return shown.map((p) => {
    const x = p.extras!;
    const name = `${p.label} · ${p.env_label}`;
    const drawn = (s: { state: string } | undefined): boolean => !!s && s.state !== "none";
    const pair = [
      drawn(x.runtime) ? runtimeBlock(p, x.runtime!, t, name) : "",
      ...(drawn(x.storage) ? storageBlocks(p, x.storage!, t) : []),
    ].filter(Boolean);
    const blocks = [
      drawn(x.outcomes) ? outcomeBlock(p, x.outcomes!, t, name) : "",
      pair.length ? `<div class="repo-cells" style="${TOP}"><div style="grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr))">${pair.join("")}</div></div>` : "",
      drawn(x.schedules) ? cronBlock(p, x.schedules!, t, name) : "",
    ].filter(Boolean);
    return blocks.length ? `<section data-uextras="${attr(`${p.env}/${p.part}`)}" class="repo-swap" aria-label="${attr(`${p.label} in ${p.env_label}: more from ${p.provider_label}`)}">${blocks.join("")}</section>` : "";
  }).join("");
}
