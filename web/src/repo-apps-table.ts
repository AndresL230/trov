// Repo › Overview — the apps table (the design's `AppsTable.dc.html`, `appsTable` in
// repo-setups-design/repo-data.js), for four or more deployed apps or apps whose environments differ (R7), or
// when Group by is App. A row per app that is not a Package, worst first — failed, building, waiting (more than
// two commits not shipped), unknown, live — then the packages, which ship inside the apps that use them.
// Columns: the production environment (the commit serving, its age, what is going on), then Previews when any
// app has previews, else the other environment, then Not shipped. Unknown is "Unknown", never "Up to date".
import type { FactsApp, FactsEnv, FactsPart, RepoFacts } from "@shared/repo-facts-core";
import { esc, attr } from "./ui";
import type { OverviewBlock, OverviewCtx } from "./repo-overview-ctx";
import { LABEL, deployAge, displayUrl, plural, repoMark, repoShape, shaChip, short, type RepoMarkKey } from "./repo-block-kit";
import { ago } from "./repo";

/** The environment the first column reads: the one called Production, else the last in promotion order. */
export function productionEnv(envs: readonly FactsEnv[]): FactsEnv | null {
  return envs.find((e) => e.key === "production" || e.name.toLowerCase() === "production") ?? envs[envs.length - 1] ?? null;
}

type Rank = 0 | 1 | 2 | 3 | 4;
const RANK_MARK: Record<Rank, RepoMarkKey> = { 0: "failed", 1: "building", 2: "waiting", 3: "unknown", 4: "live" };

interface Row { app: FactsApp; rank: Rank; html: string }

const hostOf = (parts: FactsPart[]): string => {
  const p = parts[0];
  return p ? p.host + (p.via ? ` via ${p.via}` : p.viaGithub ? " via GitHub" : "") : "";
};

/** The production cell and the row's rank. */
function prodCell(f: RepoFacts, a: FactsApp, p: FactsPart | undefined, x: OverviewCtx): { rank: Rank; html: string } {
  const top = (sha: string | null, age: string): string =>
    `<span style="display:flex;align-items:center;gap:8px;min-height:20px">${shaChip(sha)}<span style="font-size:12px;color:var(--fg-55);white-space:nowrap">${esc(age)}</span></span>`;
  const sub = (t: string): string => (t ? `<span style="font-size:12px;color:var(--fg-55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t}</span>` : "");
  const inFlight = p?.latest && (p.latest.state === "building" || p.latest.state === "queued") ? p.latest : null;
  if (!p || (!p.serving && !p.latest)) return { rank: 3, html: repoMark("unknown", 12) };
  if (p.latest?.state === "error") {
    const fl = p.latest;
    const word = `${fl.sha ? `${short(fl.sha)} failed` : "Failed"} ${ago(fl.createdAt, x.now)} ago`;
    return {
      rank: 0,
      html: `${p.serving ? top(p.serving.sha, `${deployAge(p.serving, x.now)} ago`) : ""}${repoMark("failed", 12, word)}${sub(p.serving?.sha ? `${esc(short(p.serving.sha))} still serving` : "")}`,
    };
  }
  if (inFlight) {
    return {
      rank: 1,
      html: `${top(inFlight.sha, `${deployAge(inFlight, x.now)} ago`)}${repoMark("building", 12)}${sub(p.serving?.sha ? `${esc(short(p.serving.sha))} serving until it finishes` : "")}`,
    };
  }
  const s = p.serving!;
  const ns = f.notShipped.find((n) => n.app === a.key && n.env === p.env);
  const rank: Rank = ns?.count != null && ns.count > 2 ? 2 : 4;
  return { rank, html: `${top(s.sha, `${deployAge(s, x.now)} ago`)}${sub(p.url ? esc(displayUrl(p.url)) : p.via ? `via ${esc(p.via)}` : "")}` };
}

/** The second column: this app's previews, or its deploy in the other environment. */
function secondCell(f: RepoFacts, a: FactsApp, second: FactsEnv | "previews" | null, x: OverviewCtx): string {
  if (second === null) return "";
  if (second === "previews") {
    if (!a.previews) return `<span style="font-size:12.5px;color:var(--fg-40);white-space:nowrap">No preview target</span>`;
    const pv = f.previews.filter((p) => p.app === a.key);
    const marks = pv.slice(0, 4).map((p) => repoShape(p.state === "error" ? "failed" : p.state === "ready" ? "live" : "building")).join("");
    return `<span style="display:flex;align-items:center;gap:8px;min-height:20px"><span style="font-size:12.5px;color:var(--fg-70);white-space:nowrap">${pv.length ? `${pv.length} open` : "None open"}</span>${marks ? `<span style="display:inline-flex;gap:4px;align-items:center">${marks}</span>` : ""}</span>`;
  }
  const t = f.parts.find((p) => p.app === a.key && p.env === second.key);
  const inFlight = t?.latest && (t.latest.state === "building" || t.latest.state === "queued") ? t.latest : null;
  const d = inFlight ?? t?.serving ?? null;
  if (!t || !d) return repoMark("unknown", 12);
  return `<span style="display:flex;align-items:center;gap:8px;min-height:20px;flex-wrap:wrap">${shaChip(d.sha)}<span style="font-size:12px;color:var(--fg-55);white-space:nowrap">${esc(deployAge(d, x.now))} ago</span>${inFlight ? repoMark("building", 12) : t.latest?.state === "error" ? repoMark("failed", 12) : ""}</span>`;
}

/** Not shipped: "4 commits" over "oldest 2d", "Up to date" at 0, "Unknown" when it is not known (never 0). */
function nsCell(f: RepoFacts, a: FactsApp, env: FactsEnv | null, x: OverviewCtx): string {
  const ns = env ? f.notShipped.find((n) => n.app === a.key && n.env === env.key) : undefined;
  const quiet = (t: string, tip = ""): string => `<span style="font-size:12.5px;color:var(--fg-40);white-space:nowrap"${tip ? ` data-mtip="${attr(tip)}"` : ""}>${t}</span>`;
  if (!ns || ns.count === null) return quiet("Unknown", "Trov has not compared what is serving with the branch yet.");
  if (ns.count === 0) return quiet("Up to date");
  return `<span style="font-size:12.5px;color:var(--fg-70);white-space:nowrap">${plural(ns.count, "commit")}</span>${ns.oldestAt ? `<span style="font-size:11.5px;color:var(--fg-40);white-space:nowrap">oldest ${esc(ago(ns.oldestAt, x.now))}</span>` : ""}`;
}

export const appsTableBlock: OverviewBlock = (f, x) => {
  const prod = productionEnv(f.envs);
  const anyPreview = f.apps.some((a) => a.previews);
  const other = f.envs.find((e) => e !== prod) ?? null;
  const second: FactsEnv | "previews" | null = anyPreview ? "previews" : other;
  const secLabel = second === "previews" ? "Previews" : second ? second.name : "";

  const rows: Row[] = f.apps.filter((a) => a.kind !== "Package").map((a) => {
    const parts = f.parts.filter((p) => p.app === a.key);
    const p = prod ? parts.find((q) => q.env === prod.key) : undefined;
    const cell = prodCell(f, a, p, x);
    const host = hostOf(parts);
    return {
      app: a, rank: cell.rank,
      html: `<div role="row" class="repo-appsrow${cell.rank === 0 ? " is-failed" : ""}" data-app="${attr(a.key)}" data-rank="${cell.rank}">
        <span role="cell" style="display:flex;justify-content:center;padding-top:5px">${repoShape(RANK_MARK[cell.rank], 10)}</span>
        <div role="cell" style="min-width:0;display:flex;flex-direction:column;gap:3px">
          <span style="display:flex;align-items:baseline;gap:8px;min-width:0"><span style="font-size:13.5px;font-weight:600">${esc(a.label)}</span><span style="font-family:var(--label);font-size:11px;color:var(--fg-40);white-space:nowrap">${esc(a.folder)}</span></span>
          <span style="font-size:12px;color:var(--fg-55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(a.kind)}${host ? ` · ${esc(host)}` : ""}</span>
        </div>
        <div role="cell" style="min-width:0;display:flex;flex-direction:column;gap:4px">${cell.html}</div>
        <div role="cell" style="min-width:0;display:flex;flex-direction:column;gap:4px">${secondCell(f, a, second, x)}</div>
        <div role="cell" style="min-width:0;display:flex;flex-direction:column;gap:2px;padding-top:1px">${nsCell(f, a, prod, x)}</div>
      </div>`,
    };
  });
  // Worst first; equal ranks keep the apps' own order (a stable sort).
  rows.sort((a, b) => a.rank - b.rank);

  const packages = f.apps.filter((a) => a.kind === "Package");
  if (!rows.length && !packages.length) return "";
  const head = (t: string): string => `<span role="columnheader" style="${LABEL}">${esc(t)}</span>`;
  return `<div class="repo-appstable" data-apps-table>
    <div class="repo-appstable-scroll">
      <div role="table" aria-label="Apps" class="repo-appstable-in">
        <div role="row" class="repo-appsrow repo-appshead"><span role="columnheader" aria-label="State"></span>${head("App")}${head(prod?.name ?? "Production")}${secLabel ? head(secLabel) : `<span role="columnheader"></span>`}${head("Not shipped")}</div>
        ${rows.map((r) => r.html).join("")}
        ${packages.length ? `<div class="repo-appspkghead"><span style="font-size:12px;font-weight:600;color:var(--fg-70)">Packages</span><span style="font-size:11.5px;color:var(--fg-40)">${packages.length}</span><span style="margin-left:auto;font-size:11.5px;color:var(--fg-40)">no deploys; they ship inside the apps that use them</span></div>
        ${packages.map((a) => `<div role="row" class="repo-appspkg" data-app="${attr(a.key)}">
          <span role="cell"></span>
          <span role="cell" style="display:flex;align-items:baseline;gap:8px;min-width:0"><span style="font-size:13.5px;font-weight:600">${esc(a.label)}</span><span style="font-family:var(--label);font-size:11px;color:var(--fg-40)">${esc(a.folder)}</span></span>
          <span role="cell" style="font-size:12.5px;color:var(--fg-55)">${a.usedBy?.length ? `Not deployed on its own; ships inside ${esc(a.usedBy.join(", "))}.` : "Not deployed on its own."}</span>
        </div>`).join("")}` : ""}
      </div>
    </div>
  </div>`;
};
