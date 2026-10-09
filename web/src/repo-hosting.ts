// Repo dashboard › Usage › Hosting — ONE provider-neutral panel for every part of every environment, whoever
// hosts it (`RepoDashboard.providers`, shared/hosting.ts `RepoProviderPart`). It replaces the two blocks that
// only understood one stack ("Cloudflare — frontend Workers", "Hosting — Railway backend"): the legacy
// Cloudflare frontend and Railway backend are parts here like any other.
//
// Environments sit side by side (comparing them is the point), their parts stacked inside. A part shows its
// last deploy and a strip of the last ten, then what its ROLE reads: traffic for a web part (per range),
// resources for a service (right now, with the last 24 hours).
//
// NEVER A GUESS (invariant 7). A figure the payload does not carry is "—", never 0, and says which of three
// calm things it is: "not available from <provider>" with the provider's own reason (`unavailable[]`), "no
// recent reading" (the source has reported before — `seen`), or "not connected" (it never has). Nothing here
// derives a figure the payload does not hold.
//
// Pure: props in, markup out. The motion hooks are the dashboard's own (`repo-swap` for the range switch,
// `data-count`, `repo-spark`, `repo-dot`, `repo-pulse`) — all off under prefers-reduced-motion (trov.css).

import type { RepoRange, RepoTone } from "@shared/repo";
import type { DeployState, HostingMetric, HostingProviderId, ProviderDeployDTO, ProviderResources, ProviderTrafficRange, RepoProviderPart } from "@shared/hosting";
import { esc, attr, statusBadge } from "./ui";
import { emptyLayout, emptyShapes, skBar, skBox, skLine, skeleton } from "./skeleton";

/** What the section borrows from repo.ts (passed in, so the two modules do not import each other). */
export interface RepoHostingTools {
  range: RepoRange;
  now: number;
  /** repo.ts `ago`: "12m", "3h", "2d". */
  ago(iso: string, now: number): string;
  /** repo.ts `sparkPoints`: polyline points in a 100×26 box. */
  sparkPoints(values: number[]): string;
}

const LABEL_SM = "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";
const NUM = "font-family:var(--label);font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap";
const TONE: Record<RepoTone, string> = { neutral: "var(--fg-40)", good: "var(--green)", warn: "var(--amber)", bad: "var(--red)" };
const TONE_WORD: Record<RepoTone, string> = { neutral: "no signal", good: "healthy", warn: "needs a look", bad: "failing" };
const GLYPH: Record<HostingProviderId, string> = { cloudflare: "CF", railway: "RW", vercel: "V", render: "R", netlify: "N", fly: "F", aws: "AW" };
const ROLE_WORD = { web: "Web", service: "Service" } as const;
/** A captured URL must be https — never `javascript:` / `data:`. */
const safeUrl = (u: string | null): string | null => (u && /^https:\/\//i.test(u) ? u : null);

// ── figures ──────────────────────────────────────────────────────────────────

/** 12400 → "12.4K" (the Worker's own compaction — repo.ts `formatCount`). */
export function compactNumber(v: number): string {
  return v >= 999_995_000_000 ? `${(v / 1e12).toFixed(2)}T` : v >= 999_995_000 ? `${(v / 1e9).toFixed(2)}B`
    : v >= 999_950 ? `${(v / 1e6).toFixed(2)}M` : v >= 1_000 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v));
}
/** Bytes as KB / MB / GB (decimal, as providers bill it): 1 840 000 000 → "1.84 GB". */
export function formatBytes(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB`;
  return `${Math.round(b)} B`;
}
/** Memory in MB, or GB from 1024 MB up: 742 → "742 MB", 1229 → "1.20 GB". */
export const formatMemory = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`);
/** An error rate (a percentage) with two decimals, and its tone: amber from 1 %, red from 5 %. */
export const errorRateTone = (rate: number): RepoTone => (rate >= 5 ? "bad" : rate >= 1 ? "warn" : "good");
/** "1m 42s" between two instants; null when it is not a positive, sane span. */
export function duration(from: string, to: string | null): string | null {
  if (!to) return null;
  const s = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000);
  if (!Number.isFinite(s) || s <= 0 || s > 6 * 3600) return null;
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Why a figure is absent, in this order: the provider cannot read it (its reason), else the source has gone
 *  quiet, else it never reported. Three different, calm states — none of them is "0". */
export function absentHint(part: Pick<RepoProviderPart, "unavailable" | "provider_label">, metric: HostingMetric, seen: boolean): string {
  const u = part.unavailable.find((x) => x.metric === metric);
  if (u) return `not available from ${part.provider_label}: ${u.reason}`;
  return seen ? "no recent reading" : "not connected";
}

interface Fig { key: string; label: string; value: string | null; hint: string; tone?: RepoTone; count?: number | null; unit?: string }
/** One figure over its label. Absent, it is "—" with the reason under the label. */
function figure(f: Fig): string {
  const color = f.value === null ? "color:var(--fg-40)" : f.tone && f.tone !== "good" && f.tone !== "neutral" ? `color:${TONE[f.tone]}` : "";
  const count = f.value !== null && f.count !== undefined && f.count !== null && Number.isFinite(f.count) ? ` data-count="${f.count}"${f.value === String(f.count) ? "" : ' data-count-fmt="compact"'}` : "";
  return `<div data-hfig="${attr(f.key)}"${f.value === null ? ' data-absent="1"' : ""} style="min-width:0">
      <div style="${NUM};font-size:17px;letter-spacing:-0.02em;${color}"><span${count}>${f.value === null ? "&mdash;" : esc(f.value)}</span>${f.value !== null && f.unit ? `<span style="font-size:11.5px;font-weight:500;letter-spacing:0;color:var(--fg-55);margin-left:5px">${esc(f.unit)}</span>` : ""}</div>
      <div style="font-size:12px;color:var(--fg-55);margin-top:2px">${esc(f.label)}</div>
      ${f.value === null ? `<div data-hfig-why style="font-size:11px;line-height:1.4;color:var(--fg-40);margin-top:2px;overflow-wrap:anywhere">${esc(f.hint)}</div>` : ""}
    </div>`;
}

// ── sparklines ───────────────────────────────────────────────────────────────

/** Requests as a line; each bucket with a server error as a red tick on the baseline. */
function trafficSpark(trend: ProviderTrafficRange["trend"], t: RepoHostingTools): string {
  if (trend.length < 2) return "";
  const n = trend.length;
  const ticks = trend.map((b, i) => (b.errors > 0 ? `<line x1="${((i / (n - 1)) * 100).toFixed(1)}" x2="${((i / (n - 1)) * 100).toFixed(1)}" y1="26" y2="22" stroke="var(--red)" stroke-width="1.6" vector-effect="non-scaling-stroke"></line>` : "")).join("");
  return `<div class="repo-spark" data-hspark="traffic" title="Requests per ${t.range === "24h" ? "hour" : "day"}; a red tick marks a bucket with server errors" style="margin-top:10px"><svg viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true" style="width:100%;height:34px;display:block"><polyline points="${t.sparkPoints(trend.map((b) => b.requests))}" fill="none" stroke="var(--accent)" stroke-width="1.6" vector-effect="non-scaling-stroke"></polyline>${ticks}</svg></div>`;
}

const HOUR = 3_600_000;
/**
 * A gauge's hourly points as an SVG path in a 100×26 box, placed by TIME — so a missing hour is a gap in the
 * line, never a point drawn at zero. Segments break wherever two points are more than 90 minutes apart; a
 * point with nobody beside it is a short dash (a line needs two ends).
 */
export function gapPath(points: { at: string; v: number | null }[], w = 100, h = 26, pad = 3): string {
  const pts = points.flatMap((p) => { const t = new Date(p.at).getTime(); return p.v === null || !Number.isFinite(p.v) || Number.isNaN(t) ? [] : [{ t, v: p.v }]; }).sort((a, b) => a.t - b.t);
  if (!pts.length) return "";
  const t0 = pts[0].t, span = Math.max(HOUR, pts[pts.length - 1].t - t0);
  const mn = Math.min(...pts.map((p) => p.v)), rg = (Math.max(...pts.map((p) => p.v)) - mn) || 1;
  const x = (t: number): string => (((t - t0) / span) * w).toFixed(1);
  const y = (v: number): string => (h - pad - ((v - mn) / rg) * (h - 2 * pad)).toFixed(1);
  let d = "";
  pts.forEach((p, i) => {
    const joined = i > 0 && p.t - pts[i - 1].t <= 1.5 * HOUR;
    const alone = !joined && !(i + 1 < pts.length && pts[i + 1].t - p.t <= 1.5 * HOUR);
    d += joined ? ` L${x(p.t)},${y(p.v)}` : `${d ? " " : ""}M${x(p.t)},${y(p.v)}${alone ? ` h0.8` : ""}`;
  });
  return d;
}
function gaugeSpark(trend: ProviderResources["trend"], pick: "cpu" | "mem_mb", stroke: string): string {
  const d = gapPath(trend.map((p) => ({ at: p.at, v: p[pick] })));
  return d ? `<div class="repo-spark" data-hspark="${pick}" title="The last 24 hours; a gap is an hour with no reading" style="margin-top:8px"><svg viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true" style="width:100%;height:28px;display:block"><path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke"></path></svg></div>` : "";
}

// ── deploys ──────────────────────────────────────────────────────────────────

const DEPLOY: Record<DeployState, { word: string; tone: string }> = {
  queued: { word: "Queued", tone: "var(--fg-55)" }, building: { word: "Building", tone: "var(--blue)" }, ready: { word: "Ready", tone: "var(--green)" },
  error: { word: "Failed", tone: "var(--red)" }, canceled: { word: "Canceled", tone: "var(--fg-55)" },
};
const inFlight = (s: DeployState): boolean => s === "queued" || s === "building";
const firstLine = (s: string | null): string => (s ?? "").split("\n")[0].trim().slice(0, 140);
const QUIET_LINK = "color:var(--fg-55);text-decoration:underline;text-underline-offset:2px";

/** The newest deploy, as one line that reads well with or without a commit (a Fly.io release has none). */
function lastDeploy(d: ProviderDeployDTO, t: RepoHostingTools): string {
  const s = DEPLOY[d.state];
  const took = d.state === "ready" ? duration(d.at, d.ready_at) : null;
  const url = safeUrl(d.url), log = safeUrl(d.inspect_url);
  const msg = firstLine(d.message);
  const pill = `<span style="display:inline-flex;align-items:center;gap:6px">${inFlight(d.state) ? `<span class="repo-envdot repo-pulse" aria-hidden="true" style="--c:${s.tone};flex:none;width:7px;height:7px;border-radius:50%;background:${s.tone}"></span>` : ""}${statusBadge(s.word.toUpperCase(), s.tone)}</span>`;
  const bits = [
    d.sha ? `<code style="font-family:var(--label);font-size:11.5px;color:var(--fg-70)">${esc(d.sha.slice(0, 7))}</code>` : "",
    d.branch ? `<span style="font-family:var(--label);font-size:11.5px;color:var(--fg-55)">${esc(d.branch)}</span>` : "",
    d.target ? `<span>${esc(d.target)}</span>` : "",
    d.by ? `<span>by ${esc(d.by)}</span>` : "",
    `<time datetime="${attr(d.at)}" title="${attr(d.at)}">${esc(t.ago(d.at, t.now))} ago</time>`,
    took ? `<span>ready in ${esc(took)}</span>` : "",
    url ? `<a href="${attr(url)}" target="_blank" rel="noopener noreferrer" class="repo-quiet" style="${QUIET_LINK}">Open</a>` : "",
    log ? `<a href="${attr(log)}" target="_blank" rel="noopener noreferrer" class="repo-quiet" style="${QUIET_LINK}">Log</a>` : "",
  ].filter(Boolean).join(`<span aria-hidden="true" style="color:var(--fg-40)"> &middot; </span>`);
  return `<div data-hdeploy="${d.state}" style="margin-top:10px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="${LABEL_SM}">Last deploy</span>${pill}${msg ? `<span style="flex:1 1 160px;min-width:0;font-size:12.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${attr(msg)}">${esc(msg)}</span>` : ""}</div>
      <div style="font-size:11.5px;line-height:1.6;color:var(--fg-40);margin-top:3px;overflow-wrap:anywhere">${bits}</div>
    </div>`;
}

/** The last ≤ 10 deploys as dots, newest at the right: green landed, red failed, hollow canceled, pulsing in flight. */
function deployStrip(deploys: ProviderDeployDTO[], t: RepoHostingTools): string {
  if (deploys.length < 2) return "";
  const dots = [...deploys].reverse().map((d, i) => {
    const s = DEPLOY[d.state];
    const hollow = d.state === "canceled";
    const what = `${d.sha ? `${d.sha.slice(0, 7)} ` : ""}${s.word.toLowerCase()} ${t.ago(d.at, t.now)} ago${d.by ? ` by ${d.by}` : ""}`;
    return `<span class="repo-dotwrap" style="position:relative;display:inline-block">
        <button type="button" class="repo-dot${inFlight(d.state) ? " repo-envdot repo-pulse" : ""}" data-hdot="${d.state}" style="--i:${i};--c:${s.tone};width:11px;height:11px;border-radius:50%;background:${hollow ? "transparent" : s.tone};${hollow ? "border:1.5px solid var(--fg-40);box-sizing:border-box;" : ""}display:block;padding:0" aria-label="${attr(what)}"></button>
        <span class="repo-tip" role="tooltip">
          <span style="display:block;font-family:var(--label);font-size:11.5px;font-weight:600">${esc(d.sha ? d.sha.slice(0, 7) : firstLine(d.message) || d.id.slice(0, 16))}</span>
          <span style="display:block;font-size:11.5px;color:var(--fg-55);margin-top:2px">${esc(t.ago(d.at, t.now))} ago${d.by ? ` · by ${esc(d.by)}` : ""}</span>
          <span style="display:block;font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.04em;margin-top:4px;color:${s.tone}">${esc(s.word.toUpperCase())}</span>
        </span>
      </span>`;
  }).join("");
  return `<div data-hdots style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:9px">${dots}</div>`;
}

// ── a part ───────────────────────────────────────────────────────────────────

const HEADLINE_WEB: HostingMetric[] = ["requests", "errors", "latency_p95_ms", "bandwidth_bytes"];

/** A web part's traffic in the range on screen — or, when its provider reads no usage at all, ONE calm line. */
function trafficBlock(part: RepoProviderPart, t: RepoHostingTools): string {
  if (!part.traffic) {
    const reason = part.unavailable.find((u) => HEADLINE_WEB.includes(u.metric))?.reason;
    const line = reason ? `Usage isn't available from ${part.provider_label}: ${reason}.`.replace(/\.\.$/, ".")
      : part.seen.traffic ? "No recent traffic reading." : `Traffic: not connected. Nothing has been read from ${part.provider_label} for this part yet.`;
    return `<div data-htraffic="${reason ? "unavailable" : part.seen.traffic ? "stale" : "none"}" style="margin-top:12px;font-size:12px;line-height:1.5;color:var(--fg-40)">${esc(line)}</div>`;
  }
  const r = part.traffic[t.range];
  const seen = part.seen.traffic;
  const figs: Fig[] = [
    { key: "requests", label: "Requests", value: r.requests === null ? null : compactNumber(r.requests), count: r.requests, hint: absentHint(part, "requests", seen) },
    { key: "error_rate", label: "Error rate", value: r.error_rate === null ? null : `${r.error_rate.toFixed(2)}%`, tone: r.error_rate === null ? undefined : errorRateTone(r.error_rate),
      // No request in range is not an outage of the reading: there is simply nothing to take a rate of.
      hint: r.requests !== null && r.error_rate === null ? "no request in this range" : absentHint(part, "errors", seen) },
    { key: "latency_p95_ms", label: "p95 latency", value: r.latency_p95_ms === null ? null : String(Math.round(r.latency_p95_ms)), unit: "ms", hint: absentHint(part, "latency_p95_ms", seen) },
    { key: "bandwidth_bytes", label: "Bandwidth", value: r.bandwidth_bytes === null ? null : formatBytes(r.bandwidth_bytes), hint: absentHint(part, "bandwidth_bytes", seen) },
  ];
  return `<div class="repo-swap" data-htraffic="${attr(t.range)}" style="margin-top:14px">
      <div class="repo-hfigs">${figs.map(figure).join("")}</div>
      ${r.requests === null ? "" : trafficSpark(r.trend, t)}
    </div>`;
}

/** A service part's resources, right now (the range switch does not change them). */
function resourcesBlock(part: RepoProviderPart): string {
  const r = part.resources;
  const seen = part.seen.resources;
  const figs: Fig[] = [
    { key: "cpu", label: "CPU", value: r?.cpu === null || r?.cpu === undefined ? null : r.cpu.toFixed(2), unit: "vCPU", hint: absentHint(part, "cpu", seen) },
    { key: "mem_mb", label: "Memory", value: r?.mem_mb === null || r?.mem_mb === undefined ? null : formatMemory(r.mem_mb), hint: absentHint(part, "mem_mb", seen) },
  ];
  return `<div data-hresources style="margin-top:14px">
      <div class="repo-hfigs repo-hfigs--2"><div style="min-width:0">${figure(figs[0])}${r && r.cpu !== null ? gaugeSpark(r.trend, "cpu", "var(--accent)") : ""}</div><div style="min-width:0">${figure(figs[1])}${r && r.mem_mb !== null ? gaugeSpark(r.trend, "mem_mb", "var(--blue)") : ""}</div></div>
    </div>`;
}

function partCard(part: RepoProviderPart, t: RepoHostingTools): string {
  const console_ = safeUrl(part.console_url);
  const head = `<div style="display:flex;align-items:center;gap:6px 9px;flex-wrap:wrap">
      <span data-htone="${part.tone}" title="${attr(TONE_WORD[part.tone])}" style="flex:none;width:8px;height:8px;border-radius:50%;background:${TONE[part.tone]}"></span><span class="cnpy-sr">${esc(TONE_WORD[part.tone])}: </span>
      <span style="font-size:14px;font-weight:600;overflow-wrap:anywhere">${esc(part.label)}</span>
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--fg-55);white-space:nowrap"><span aria-hidden="true" style="display:inline-grid;place-items:center;width:18px;height:18px;border-radius:5px;border:1px solid var(--border-strong);background:var(--hover);font-family:var(--label);font-size:8.5px;font-weight:700;line-height:1;color:var(--fg-70)">${GLYPH[part.provider] ?? "?"}</span>${esc(part.provider_label)}</span>
      ${statusBadge(ROLE_WORD[part.role].toUpperCase(), "var(--fg-55)")}
      ${console_ ? `<a href="${attr(console_)}" target="_blank" rel="noopener noreferrer" class="repo-quiet" style="margin-left:auto;font-size:11.5px;white-space:nowrap;${QUIET_LINK}">Open in ${esc(part.provider_label)}</a>` : ""}
    </div>`;
  const deploys = part.deploys.length ? `${lastDeploy(part.deploys[0], t)}${deployStrip(part.deploys, t)}`
    : `<div data-hdeploy="none" style="margin-top:10px;font-size:12px;color:var(--fg-40)">${part.seen.deploys ? "No deploy in the last 90 days." : "No deploy read yet."}</div>`;
  // `not_connected` = never polled: there is nothing to draw but the fact. `empty` = polled, nothing in range.
  const body = part.status === "not_connected"
    ? `<div data-hstate="not_connected" style="margin-top:10px;font-size:12px;line-height:1.5;color:var(--fg-40)">Not connected: nothing has been read from ${esc(part.provider_label)} for this part yet.</div>`
    : `${deploys}${part.role === "web" ? trafficBlock(part, t) : resourcesBlock(part)}${part.status === "empty" ? `<div data-hstate="empty" style="margin-top:10px;font-size:12px;color:var(--fg-40)">Polled, but nothing to show in the last 30 days.</div>` : ""}`;
  const failed = part.last_poll?.status === "failed"
    ? `<div data-hpollfail role="status" style="margin-top:12px;border:1px solid color-mix(in srgb,var(--amber) 40%,transparent);background:color-mix(in srgb,var(--amber) 7%,transparent);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.5;color:var(--fg-70);overflow-wrap:anywhere"><strong style="font-weight:600;color:var(--fg)">Last poll failed ${esc(t.ago(part.last_poll.at, t.now))} ago.</strong> ${esc(part.last_poll.detail ?? "The provider did not answer.")}</div>` : "";
  return `<article data-hpart="${attr(`${part.env}/${part.part}`)}" data-provider="${attr(part.provider)}" data-status="${part.status}" class="repo-hpart">${head}${body}${failed}</article>`;
}

// ── the section ──────────────────────────────────────────────────────────────

/** Every part, grouped by environment in the payload's own order (the first deploys from the head branch). */
export function hostingParts(parts: RepoProviderPart[], t: RepoHostingTools): string {
  const envs: { key: string; label: string; parts: RepoProviderPart[] }[] = [];
  for (const p of parts) {
    let e = envs.find((x) => x.key === p.env);
    if (!e) { e = { key: p.env, label: p.env_label, parts: [] }; envs.push(e); }
    e.parts.push(p);
  }
  return `<div class="repo-cells" data-hosting="ok" style="border-top:1px solid var(--border)"><div style="grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr))">${envs.map((e) => `<section data-henv="${attr(e.key)}" class="repo-henv" aria-label="${attr(`${e.label} hosting`)}">
      <div style="display:flex;align-items:baseline;gap:9px;margin-bottom:2px"><h3 style="margin:0;font-size:15px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.label)}</h3><span style="font-family:var(--label);font-size:10px;color:var(--fg-40)">${e.parts.length} ${e.parts.length === 1 ? "part" : "parts"}</span></div>
      ${e.parts.map((p) => partCard(p, t)).join("")}
    </section>`).join("")}</div></div>`;
}

// ── shapes: ONE builder for the section's loading skeleton and its empty layouts (web-ui.md › Empty layouts) ──

/** One part's card as a shape: its head, the last-deploy line, the dot strip, a row of figures. Boxes only. */
const partShape = (): string => `<div class="repo-hpart">
    <div style="display:flex;align-items:center;gap:9px">${skBox(8, 8)}${skLine(120, 14, 1.4)}${skLine(84, 12, 1.4)}</div>
    <div style="margin-top:10px">${skLine("70%", 12.5, 1.5)}</div>
    <div style="display:flex;gap:7px;margin-top:9px">${Array.from({ length: 6 }, () => skBox(11, 11)).join("")}</div>
    <div class="repo-hfigs" style="margin-top:14px">${Array.from({ length: 4 }, () => `<div style="min-width:0">${skBar(54, 17)}${skBar(64, 10, "margin-top:8px")}</div>`).join("")}</div>
  </div>`;
/** The section's shape: environments side by side on the lattice the real parts use, two parts in each. */
export function hostingShapes(envs = 2, parts = 2): string {
  return `<div class="repo-cells" style="border-top:1px solid var(--border)"><div style="grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr))">${Array.from({ length: envs }, () =>
    `<div class="repo-henv">${skLine(88, 15, 1.4)}${Array.from({ length: parts }, partShape).join("")}</div>`).join("")}</div></div>`;
}
/** The section while the dashboard's read is out. */
export const hostingSkeleton = (key: string): string => skeleton(key, "Loading hosting&hellip;", hostingShapes());
/** The organization has no repository at all (the dashboard's `blank` phase): the section's shape, drawn empty —
 *  the dashboard's own empty layout, above, carries the sentence. */
export const hostingBlank = (): string => emptyShapes(hostingShapes());

/** What the section says while it holds nothing (exported: tests read the same words). */
export const HOSTING_NOT_CONNECTED = "No hosting provider is connected. Each part of each environment shows here once it is set up in Org settings \u203a Hosting: its deploys, and the traffic or resources its host reports.";
export const HOSTING_NOT_CONNECTED_MEMBER = "No hosting provider is connected. An admin sets up each environment's parts in Org settings \u203a Hosting; their deploys, traffic and resources then show here.";
export const HOSTING_EMPTY = "Parts are set up, but no provider has reported yet. The hourly poll fills this in, or an admin can press Poll now.";

/** Nothing is set up: the section's shape drawn empty under one sentence, with the way there for an admin. Never a failure. */
export function hostingNotConnected(admin: boolean): string {
  return `<div data-hosting="not_connected">${emptyLayout("repo-hosting", {
    text: admin ? HOSTING_NOT_CONNECTED : HOSTING_NOT_CONNECTED_MEMBER, sayStyle: "margin:0 20px 16px",
    action: admin ? { label: "Open Org settings \u203a Hosting", act: "orgGo", arg: "hosting" } : null, shapes: hostingShapes(),
  })}</div>`;
}
/** Parts exist, and no provider has reported for any of them yet. */
export function hostingEmpty(): string {
  return `<div data-hosting="empty">${emptyLayout("repo-hosting", { text: HOSTING_EMPTY, sayStyle: "margin:0 20px 16px", shapes: hostingShapes() })}</div>`;
}
