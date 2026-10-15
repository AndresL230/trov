// Repo › Overview, rules R1 and R2 — a repository with no app accepted yet.
//   R1 `foundBlock` (the design's `FoundApps.dc.html`): the apps the scan suggests — folder, kind, host and the
//      file that gave it away — with Accept / Ignore for an admin (`repoFoundAccept` / `repoFoundIgnore` with the
//      suggestion's id; Phase D wires them), the deploy names GitHub has seen, and the way to Org settings ›
//      Repositories. A suggestion changes nothing on this screen but this card until a person accepts it.
//   R2 `unseenBlock` (RepoScreen's unseen card): Trov does not see deploys — what it looked for, what it DOES
//      see (tags, pull requests, CI workflows, GitHub deployments in 30 days), the latest tags, and "Add an app
//      by hand" for an admin.
// Sample mode offers no write: the buttons are drawn disabled.
import type { FactsFoundApp, FactsSignal, FactsUnseen } from "@shared/repo-facts-core";
import { esc, attr } from "./ui";
import { markShape } from "./marks";
import { ago } from "./repo";
import type { OverviewBlock, OverviewCtx } from "./repo-overview-ctx";
import { LABEL, LABEL_SM, agoWords, andList, byName } from "./repo-block-kit";

const TOP = "border-top:1px solid var(--border)";
/** A provider's short name for a one-line summary (the registry's labels live on the Worker — repo.ts keeps the
 *  same table for its poll strip). An id it does not know reads as itself. */
const PROVIDER_NAME: Record<string, string> = {
  cloudflare: "Cloudflare", railway: "Railway", vercel: "Vercel", render: "Render", netlify: "Netlify", fly: "Fly.io", aws: "AWS",
  github: "GitHub deployments",
};
const providerName = (id: string | null): string | null => (id ? PROVIDER_NAME[id] ?? id : null);

const SAMPLE_TIP = "Sample data: nothing is changed.";
const BTN_PRIMARY = "height:32px;padding:0 13px;border-radius:8px;font-size:12.5px;font-weight:600;background:var(--accent);color:var(--accent-fg);border:1px solid transparent;white-space:nowrap";
const BTN_OUTLINE = "height:28px;padding:0 11px;border-radius:8px;font-size:12px;font-weight:500;border:1px solid var(--border);color:var(--fg-70);background:transparent;white-space:nowrap";

/** A write button: its act and argument, or — in sample mode — drawn disabled and saying why. */
const writeBtn = (label: string, act: string, arg: string, style: string, cls: string, x: Pick<OverviewCtx, "sample">, aria?: string): string =>
  `<button type="button" class="${cls}" data-act="${act}" data-arg="${attr(arg)}"${aria ? ` aria-label="${attr(aria)}"` : ""}${x.sample ? ` disabled title="${SAMPLE_TIP}"` : ""} style="${style}${x.sample ? ";opacity:.55;cursor:default" : ""}">${esc(label)}</button>`;
/** Org settings › Repositories — where apps are accepted, ignored or added by hand. A navigation, so it works
 *  in sample mode too. */
const orgReposBtn = (label: string): string =>
  `<button type="button" class="cnpy-accentbtn" data-act="orgGo" data-arg="repos" style="${BTN_PRIMARY}">${esc(label)}</button>`;

// ── R1: found apps ───────────────────────────────────────────────────────────
function foundRow(a: FactsFoundApp, x: OverviewCtx): string {
  const host = providerName(a.provider);
  const actions = x.admin
    ? `<span class="repo-found-act" style="display:flex;gap:6px;justify-content:flex-end">${writeBtn("Accept", "repoFoundAccept", a.id, BTN_OUTLINE, "cnpy-outlinebtn", x, `Accept ${a.folder}`)}${writeBtn("Ignore", "repoFoundIgnore", a.id, BTN_OUTLINE, "cnpy-outlinebtn", x, `Ignore ${a.folder}`)}</span>`
    : "";
  return `<div class="repo-found-row${x.admin ? " has-act" : ""}" data-found="${attr(a.id)}" style="padding:10px 0;${TOP}">
    <span role="img" aria-label="Suggested" data-mtip="Suggested by the scan, not accepted. Nothing changes until a person accepts it." style="align-self:center;display:flex">${markShape("ring", "var(--blue)", 9)}</span>
    <span style="font-family:var(--label);font-size:12.5px;color:var(--fg);overflow-wrap:anywhere">${esc(a.folder)}</span>
    <span style="font-size:12.5px;color:var(--fg-70)">${esc(a.kind)}</span>
    <span style="font-size:12.5px;color:${host ? "var(--fg-70)" : "var(--fg-40)"}">${esc(host ?? "no host")}</span>
    <span class="repo-found-ev" style="font-size:12px;color:var(--fg-40);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.evidence)}</span>
    ${actions}
  </div>`;
}

const signalText = (s: FactsSignal): string =>
  `${s.name}${providerName(s.provider) ? ` · ${providerName(s.provider)}` : ""}, ${s.count} ${s.count === 1 ? "time" : "times"}`;

export const foundBlock: OverviewBlock = (f, x) => {
  const found = f.found;
  if (!found || !found.apps.length) return "";
  const n = found.apps.length;
  const lead = x.admin
    ? "Nothing changes until you accept them. Until then this page shows pull requests, CI and this week’s figures, which need no setup."
    : "Nothing changes until an admin accepts them in Org settings. Pull requests, CI and this week’s figures already work.";
  return `<section class="repo-found" data-block="found" style="padding:20px 22px 16px">
    <div style="display:flex;align-items:flex-start;gap:10px 16px;flex-wrap:wrap">
      <div style="flex:1 1 360px;min-width:0">
        <div style="font-size:16.5px;font-weight:600;letter-spacing:-0.01em">Trov found ${n} ${n === 1 ? "app" : "apps"} in ${esc(f.repo)}</div>
        <p style="margin:5px 0 0;font-size:13px;line-height:1.55;color:var(--fg-55);max-width:70ch">${lead}</p>
      </div>
      ${x.admin ? `<div style="display:flex;gap:8px;flex:none">${orgReposBtn("Review in Org settings › Repositories")}</div>` : ""}
    </div>
    <div style="margin-top:14px">
      ${found.apps.map((a) => foundRow(a, x)).join("")}
      ${found.signals.length ? `<div data-signals style="display:flex;gap:6px 10px;flex-wrap:wrap;padding:10px 0 2px;${TOP};font-size:12px;color:var(--fg-55)">
        <span style="${LABEL_SM};padding-top:2px">Deploys seen</span>
        ${found.signals.map((s) => `<span>${esc(signalText(s))}</span>`).join(`<span aria-hidden="true" style="color:var(--fg-40)">·</span>`)}
      </div>` : ""}
    </div>
  </section>`;
};

// ── R2: nothing recognised ───────────────────────────────────────────────────
/** What Trov DOES see, as the card's four facts. Unknown counts read "—", never 0. */
export function unseenSees(u: FactsUnseen, now: number): [string, string][] {
  const num = (n: number | null): string => (n === null ? "—" : String(n));
  const t = u.tags;
  return [
    ["Tags", t === null ? "—" : t.count === 0 ? "No tags" : `${t.count} ${t.count === 1 ? "tag" : "tags"}${t.latest ? `; the latest is ${t.latest.tag}, ${agoWords(t.latest.at, now)} ago` : ""}`],
    ["Pull requests", `${num(u.prs.open)} open, ${num(u.prs.mergedThisMonth)} merged this month`],
    ["CI", u.workflows.length ? andList(u.workflows) : "No workflows seen"],
    ["GitHub deployments", u.deploymentsSeen30d === 0 ? "None reported in 30 days" : `${u.deploymentsSeen30d} reported in 30 days`],
  ];
}

export const unseenBlock: OverviewBlock = (f, x) => {
  const u = f.unseen;
  if (!u) return "";
  const looked = u.looked.length ? `It looked for ${andList(u.looked)}, and found none.` : "It found no file that names a host.";
  const none = u.deploymentsSeen30d === 0 ? " No host has reported a deploy to GitHub in 30 days." : "";
  return `<section class="repo-unseen" data-block="unseen">
    <div style="padding:20px 22px 16px">
      <div style="font-size:16.5px;font-weight:600;letter-spacing:-0.01em">Trov does not see deploys for this repository</div>
      <p style="margin:6px 0 0;font-size:13px;line-height:1.55;color:var(--fg-55);max-width:76ch">${esc(looked + none)} Everything else on this page works without one.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:0 28px;margin-top:14px">
        ${unseenSees(u, x.now).map(([k, v]) => `<div data-sees="${attr(k)}" style="padding:10px 0;${TOP}"><div style="${LABEL_SM}">${esc(k)}</div><div style="font-size:13px;color:var(--fg-70);margin-top:4px">${esc(v)}</div></div>`).join("")}
      </div>
      ${x.admin ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">${orgReposBtn("Add an app by hand")}</div>` : ""}
    </div>
    ${u.tags?.recent.length ? `<div style="${TOP};padding:14px 22px 8px">
      <div style="${LABEL};margin-bottom:4px">Latest tags</div>
      ${u.tags.recent.map((t) => `<div class="repo-unseen-tag" style="display:grid;grid-template-columns:120px minmax(0,1fr) 60px;gap:12px;padding:8px 0;${TOP};align-items:center"><span style="font-family:var(--label);font-size:12.5px;font-weight:600">${esc(t.tag)}</span><span style="font-size:12px;color:var(--fg-55)">${t.by ? `by ${byName(t.by, x)}` : ""}</span><span style="font-size:11.5px;color:var(--fg-40);text-align:right">${esc(ago(t.at, x.now))}</span></div>`).join("")}
    </div>` : ""}
  </section>`;
};
