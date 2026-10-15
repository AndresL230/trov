// Repo › Overview, rule R4 — ONE Production card: the one app in its one environment (the design's
// `ProductionCard.dc.html` + `productionModel`, repo-data.js). Drawn from `RepoFacts` alone: what is serving
// (sha, age, who, host, URL, health), the newest deploy when it failed or is still in flight, CI on the branch
// head, and the last 20 deploys as a strip, newest on the right. Nothing is pre-worded in the facts; every
// sentence is made here, and unknown stays unknown (no sha → "no commit", no reading → no figure).
import type { FactsCi, FactsDeploy, FactsPart, RepoFacts } from "@shared/repo-facts-core";
import { esc, attr } from "./ui";
import { stateMark } from "./marks";
import { ago } from "./repo";
import { envVerdict } from "./repo-verdict";
import type { OverviewBlock, OverviewCtx } from "./repo-overview-ctx";
import { LABEL_SM, agoWords, bareUrl, byName, deployMark, httpsUrl, outLink, shaOrNone, shaChip, type DeployMarkKey } from "./repo-block-kit";

const TOP = "border-top:1px solid var(--border)";
const META = "font-size:12px;color:var(--fg-55);white-space:nowrap";
const LINE = "font-size:12.5px;line-height:1.5;color:var(--fg-70)";

/** A label column and its value, the card's one row shape. */
const row = (label: string, body: string, pad = "11px 0"): string =>
  `<div class="repo-prod-row" style="display:grid;grid-template-columns:96px minmax(0,1fr);gap:12px;padding:${pad};${TOP}"><span style="${LABEL_SM};padding-top:4px">${label}</span><div style="display:flex;flex-direction:column;gap:5px;min-width:0">${body}</div></div>`;
const flex = (inner: string): string => `<div style="display:flex;align-items:center;gap:6px 9px;flex-wrap:wrap;min-height:22px">${inner}</div>`;

/** When a deploy happened: ready, else created. */
const whenOf = (d: FactsDeploy): string => d.readyAt ?? d.createdAt;
const host = (p: FactsPart): string => `${p.host}${p.via ? ` via ${p.via}` : ""}`;

// ── CI on the branch head ────────────────────────────────────────────────────
/** The design's CI line from the facts: "All 9 checks passing on c41e7d9", "2 of 9 checks failing on e07b3a2",
 *  "Checks running on f19ad20" (or the running checks by name). A count that is not known is not printed. */
export function ciLine(c: FactsCi | undefined): { glyph: string; tone: string; text: string } {
  if (!c || !c.state) return { glyph: "", tone: "var(--fg-40)", text: "No checks captured on the branch head yet" };
  const on = c.sha ? ` on ${c.sha.slice(0, 7)}` : "";
  if (c.state === "pass") {
    const text = c.total === null ? `Checks passing${on}` : c.total === 1 ? `1 check passing${on}` : `All ${c.total} checks passing${on}`;
    return { glyph: "✓", tone: "var(--green)", text };
  }
  if (c.state === "fail") {
    const text = c.failing !== null && c.total !== null ? `${c.failing} of ${c.total} ${c.total === 1 ? "check" : "checks"} failing${on}` : `Checks failing${on}`;
    return { glyph: "✕", tone: "var(--red)", text };
  }
  return { glyph: `<span class="repo-gdot" aria-hidden="true"></span>`, tone: "var(--amber)", text: c.names.length ? `${c.names.join(", ")} running${on}` : `Checks running${on}` };
}

// ── the strip ────────────────────────────────────────────────────────────────
type StripKey = "live" | "failed" | "building" | "rolledBack" | "cancelled";
const STRIP: Record<StripKey, { word: string; color: string }> = {
  live: { word: "Live", color: "var(--green)" },
  failed: { word: "Failed", color: "var(--red)" },
  building: { word: "Building", color: "var(--blue)" },
  rolledBack: { word: "Rolled back", color: "var(--amber)" },
  cancelled: { word: "Cancelled", color: "var(--fg-40)" },
};
const stripKey = (d: FactsDeploy): StripKey =>
  d.state === "error" ? "failed" : d.state === "canceled" ? "cancelled" : d.state === "queued" || d.state === "building" ? "building"
    : d.rolledBackFrom ? "rolledBack" : "live";

/** The last ≤ 20 deploys, oldest first: the settled history, then the newest when it is still in flight. */
export function stripOf(p: FactsPart): FactsDeploy[] {
  const all = [...p.history];
  if (p.latest && !all.some((d) => d.id === p.latest!.id)) all.push(p.latest);
  return all.slice(-20);
}

/** "Last 20 deploys · 17 live, 1 failed, 1 rolled back, 1 building". */
export function stripText(ds: readonly FactsDeploy[]): string {
  const n = (k: StripKey): number => ds.filter((d) => stripKey(d) === k).length;
  const parts = [`${n("live")} live`];
  if (n("failed")) parts.push(`${n("failed")} failed`);
  if (n("rolledBack")) parts.push(`${n("rolledBack")} rolled back`);
  if (n("building")) parts.push(`${n("building")} building`);
  if (n("cancelled")) parts.push(`${n("cancelled")} cancelled`);
  return `${ds.length === 1 ? "Last deploy" : `Last ${ds.length} deploys`} · ${parts.join(", ")}`;
}

function strip(p: FactsPart, now: number): string {
  const ds = stripOf(p);
  if (!ds.length) {
    return `<div style="${LABEL_SM};margin-bottom:10px">Deploys</div><div style="font-size:12.5px;color:var(--fg-40)">No deploy seen yet.</div>`;
  }
  const squares = ds.map((d, i) => {
    const k = stripKey(d);
    const tip = `${STRIP[k].word} · ${d.sha ? d.sha.slice(0, 7) : "no commit"} · ${ago(whenOf(d), now)} ago`;
    return `<span role="listitem" aria-label="${attr(tip)}" data-mtip="${attr(tip)}" class="repo-prod-sq${k === "building" ? " is-building" : ""}${i === ds.length - 1 ? " is-last" : ""}" style="width:14px;height:14px;border-radius:3px;background:${STRIP[k].color};flex:none"></span>`;
  }).join("");
  return `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <span style="${LABEL_SM}">Deploys</span><span data-strip-text style="font-size:11.5px;color:var(--fg-40)">${esc(stripText(ds))}</span>
    </div>
    <div role="list" aria-label="Last ${ds.length} deploys, oldest first" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">${squares}</div>
    <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:10.5px;color:var(--fg-40)"><span>oldest</span><span>latest</span></div>`;
}

// ── the card ─────────────────────────────────────────────────────────────────
/** The part the card is about: the one app's part in the one environment. */
export const productionPart = (f: RepoFacts): FactsPart | null =>
  f.parts.find((p) => f.envs.some((e) => e.key === p.env) && f.apps.some((a) => a.key === p.app && a.kind !== "Package")) ?? null;

function serving(p: FactsPart, f: RepoFacts, x: OverviewCtx): string {
  const s = p.serving;
  if (!s) {
    const why = p.latest ? "Nothing is serving yet." : p.connection !== "connected" && !p.viaGithub
      ? `${p.host} does not report deploys to GitHub` : "No deploy seen yet.";
    return flex(`${deployMark("unknown")}<span style="${META}">${esc(why)}</span>`);
  }
  const by = s.by ? ` · by ${byName(s.by, x)}` : "";
  const top = flex(`${shaOrNone(s.sha)}<span style="${META}">${esc(ago(whenOf(s), x.now))} ago${by} · ${esc(host(p))}</span>${s.rolledBackFrom ? deployMark("rolledBack") : ""}`);
  const failed = p.latest && (p.latest.state === "error" || p.latest.state === "canceled");
  const lines: string[] = [];
  if (!failed) {
    if (p.health && !p.health.up && !p.health.stale) {
      const since = f.attention.find((a) => a.kind === "down" && a.app === p.app && a.env === p.env)?.refs.since;
      lines.push(`No answer from ${bareUrl(p.health.url)}${since ? ` for ${agoWords(since, x.now)}` : ""}.`);
    }
    if (s.rolledBackFrom) lines.push(`Rolled back from ${s.rolledBackFrom.slice(0, 7)}${s.by ? ` by ${s.by}` : ""} ${ago(whenOf(s), x.now)} ago.`);
    else if (p.latest && (p.latest.state === "building" || p.latest.state === "queued")) lines.push(`${s.sha ? s.sha.slice(0, 7) : "The last deploy"} is serving until it finishes.`);
  }
  return top + lines.map((l) => `<span style="${LINE}">${esc(l)}</span>`).join("");
}

function lastDeploy(p: FactsPart, x: OverviewCtx): string {
  const d = p.latest;
  if (!d || (d.state !== "error" && d.state !== "canceled")) return "";
  const key: DeployMarkKey = d.state === "error" ? "failed" : "cancelled";
  const word = `${d.sha ? d.sha.slice(0, 7) : "A deploy with no commit"} ${d.state === "error" ? "failed" : "was cancelled"} ${ago(whenOf(d), x.now)} ago`;
  const still = p.serving ? `${p.serving.sha ? p.serving.sha.slice(0, 7) : "The last deploy"} is still serving.` : "Nothing is serving.";
  const why = d.reason ? `${d.reason.replace(/\.?\s*$/, ".")} ${still}` : still;
  return row("Last deploy", `${flex(`${deployMark(key, 12.5, word)}${d.by ? `<span style="${META}">by ${byName(d.by, x)}</span>` : ""}${httpsUrl(d.logUrl) && !x.sample ? outLink(d.logUrl, "Build log", x) : ""}`)}
    <span data-failed-why style="${LINE};color:var(--fg-55)">${esc(why)}</span>`);
}

function next(p: FactsPart, x: OverviewCtx): string {
  const d = p.latest;
  if (!d || (d.state !== "building" && d.state !== "queued")) return "";
  return row("Next", flex(`${shaOrNone(d.sha)}${deployMark(d.state === "building" ? "building" : "queued")}<span style="${META}">started ${esc(ago(d.createdAt, x.now))} ago</span>`));
}

function url(p: FactsPart, x: OverviewCtx): string {
  // A URL is printed only when it is a web address (never a javascript: or data: string, even as text).
  const u = [p.url, p.health?.url].find((v): v is string => !!v && /^https?:\/\/[^\s"'<>]+$/i.test(v)) ?? null;
  const h = p.health;
  const reading = !h ? "" : h.stale ? deployMark("stale", 12, `Reading ${ago(h.at, x.now)} old`)
    : !h.up ? deployMark("down") : h.ms !== null ? `<span style="${META};font-variant-numeric:tabular-nums">${h.ms} ms</span>` : "";
  return row("URL", flex(`${u ? outLink(u, bareUrl(u), x) : `<span style="${META};color:var(--fg-40)">No public URL known</span>`}${reading}`), "11px 0");
}

export const productionBlock: OverviewBlock = (f, x) => {
  const p = productionPart(f);
  if (!p) return "";
  const env = f.envs.find((e) => e.key === p.env)!;
  const app = f.apps.find((a) => a.key === p.app)!;
  const v = envVerdict(f, env.key);
  const ci = ciLine(f.ci.find((c) => c.env === env.key));
  return `<section class="repo-prod" data-block="production" style="padding:20px 22px 14px">
    <div style="display:flex;align-items:center;gap:6px 10px;margin-bottom:12px;flex-wrap:wrap">
      <span style="font-size:16.5px;font-weight:600;letter-spacing:-0.01em">${esc(env.name)}</span>
      <span style="font-size:12px;color:var(--fg-40)">${env.branch ? `from <span style="font-family:var(--label);font-size:11.5px;color:var(--fg-55)">${esc(env.branch)}</span> · ` : ""}${esc(app.label)} · ${esc(app.kind)} on ${esc(host(p))}</span>
      <span style="margin-left:auto">${stateMark(v.word, v.tone, v.shape, 12.5, v.tip)}</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(380px,100%),1fr));gap:0 40px">
      <div style="min-width:0">
        ${row("Serving", serving(p, f, x))}
        ${lastDeploy(p, x)}
        ${next(p, x)}
        ${url(p, x)}
        ${row("CI on head", `<span data-ci style="${LINE};color:${ci.tone};display:flex;gap:7px;align-items:center">${ci.glyph ? `<span style="font-weight:600">${ci.glyph}</span>` : ""}<span>${esc(ci.text)}</span></span>`, "11px 0 4px")}
      </div>
      <div style="min-width:0;padding:11px 0;${TOP}">${strip(p, x.now)}</div>
    </div>
  </section>`;
};

