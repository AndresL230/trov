// Repo › Overview — not shipped (the design's `NotShipped.dc.html`, `notShippedModel` in
// repo-setups-design/repo-data.js): what is merged on an app's environment branch and not serving, grouped by
// pull request and by commits pushed straight to the branch, opened by its header (key `ns:<app>><env>`).
//
// Which entry is drawn (the design draws ONE: `buildScreen`'s `s.notShipped`):
//  - one deployed app in view (R4 / R5, or the App menu narrowed to one) → that app's entry for the production
//    environment (the one called Production, else the last in promotion order): "4 commits on web not in
//    Production · oldest 2d ago", or "web is up to date in Production" at 0;
//  - several apps (R6 / R7) → the app with the most commits waiting (ties: the apps' order), and only when its
//    commits are listed — a bare count is already the apps table's Not shipped column and the attention list.
//    That is scenario E's web; F's and G's entries carry counts and no commits, and the design draws none there.
//  - nothing when the count is unknown (`null`) or no entry exists — never "up to date" for an unknown.
import type { FactsNotShipped, RepoFacts } from "@shared/repo-facts-core";
import { esc, attr } from "./ui";
import type { OverviewBlock } from "./repo-overview-ctx";
import { LABEL, TOP, chevron, commitGroups, panel, plural, toggleAttrs } from "./repo-block-kit";
import { productionEnv } from "./repo-apps-table";
import { ago } from "./repo";

export const notShippedKey = (n: Pick<FactsNotShipped, "app" | "env">): string => `ns:${n.app}>${n.env}`;

/** The one entry the block draws, per the rule above; null for none. */
export function notShippedEntry(f: RepoFacts): FactsNotShipped | null {
  const prod = productionEnv(f.envs);
  if (!prod) return null;
  const deployed = f.apps.filter((a) => a.kind !== "Package" && f.parts.some((p) => p.app === a.key));
  const inProd = (app: string): FactsNotShipped | undefined => f.notShipped.find((n) => n.app === app && n.env === prod.key);
  if (deployed.length === 1) {
    const n = inProd(deployed[0].key);
    return n && n.count !== null ? n : null;
  }
  let best: FactsNotShipped | null = null;
  for (const a of deployed) {
    const n = inProd(a.key);
    if (n && n.count !== null && n.count > 0 && n.groups.length && (!best || n.count > (best.count ?? 0))) best = n;
  }
  return best;
}

export const notShippedBlock: OverviewBlock = (f, x) => {
  const n = notShippedEntry(f);
  if (!n || n.count === null) return "";
  const app = esc(f.apps.find((a) => a.key === n.app)?.label ?? n.app);
  const env = esc(f.envs.find((e) => e.key === n.env)?.name ?? n.env);
  if (n.count === 0) {
    return `<div class="repo-notshipped" data-not-shipped="${attr(n.app)}" style="${TOP}">
      <div style="display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;padding:14px 22px 12px">
        <span style="${LABEL};font-size:10.5px">Not shipped</span>
        <span style="font-size:13px;font-weight:500;color:var(--fg)">${app} is up to date in ${env}</span>
        <span style="font-size:12.5px;color:var(--fg-55)">Everything merged is deployed.</span>
      </div>
    </div>`;
  }
  const key = notShippedKey(n);
  const open = x.open.has(key);
  const hasGroups = n.groups.length > 0;
  const head = `<span style="${LABEL};font-size:10.5px">Not shipped</span>
    <span style="font-size:13px;font-weight:500;color:var(--fg)">${plural(n.count, "commit")} on ${app} not in ${env}</span>
    ${n.oldestAt ? `<span style="font-size:11.5px;color:var(--fg-40);white-space:nowrap">oldest ${esc(ago(n.oldestAt, x.now))} ago</span>` : ""}`;
  return `<div class="repo-notshipped" data-not-shipped="${attr(n.app)}" style="${TOP}">
    ${hasGroups
      ? `<button type="button" ${toggleAttrs(key, open)} class="repo-strip" style="width:100%;display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;padding:14px 22px 12px;text-align:left">${head}<span style="margin-left:auto;display:flex">${chevron(open)}</span></button>
        ${panel(open, commitGroups(n.groups, x))}`
      : `<div style="display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;padding:14px 22px 12px">${head}</div>`}
  </div>`;
};
