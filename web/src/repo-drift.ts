// Repo › Overview — drift between environments (the design's `DriftStrip.dc.html`, `driftModel` in
// repo-setups-design/repo-data.js), under the environment cards. One step ("main is 9 commits ahead of
// production") is one strip that opens on what is waiting; three or more environments draw the chain form —
// each branch, then a button per step saying how far ahead it is — and each step opens on its own commits.
// A step's disclosure key is `drift:<fromEnv>><toEnv>` (`x.open`); the toggle is the blocks' one act.
import type { FactsDriftStep } from "@shared/repo-facts-core";
import { esc, attr } from "./ui";
import type { OverviewBlock, OverviewCtx } from "./repo-overview-ctx";
import { TOP, chevron, commitGroups, panel, plural, toggleAttrs } from "./repo-block-kit";

export const driftKey = (d: Pick<FactsDriftStep, "fromEnv" | "toEnv">): string => `drift:${d.fromEnv}>${d.toEnv}`;

const BRANCH_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="1.8" style="flex:none" aria-hidden="true"><path d="M6 3v12"></path><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>`;
const ARROW = `<svg width="14" height="10" viewBox="0 0 14 10" fill="none" stroke="var(--fg-40)" stroke-width="1.6" aria-hidden="true"><path d="M1 5h11M8.5 1.5 12 5 8.5 8.5"></path></svg>`;
const BR = "font-family:var(--label);font-size:12.5px";
const N = "font-family:var(--label);font-weight:600;color:var(--fg)";

/** "9 commits ahead of production" — and how far behind, when the later branch has commits the earlier lacks. */
const aheadText = (d: FactsDriftStep): string =>
  `<span style="${N}">${d.ahead}</span> ${d.ahead === 1 ? "commit" : "commits"} ahead${d.behind > 0 ? `, <span style="${N}">${d.behind}</span> behind` : ""}`;

/** What one step opens on. In the chain form it first says which step it is. */
const stepBody = (d: FactsDriftStep, x: OverviewCtx, chain: boolean): string =>
  `${chain ? `<div style="padding:9px 22px;${TOP};font-size:12px;color:var(--fg-55)">On <span style="font-family:var(--label);font-size:11.5px">${esc(d.from)}</span>, not yet on <span style="font-family:var(--label);font-size:11.5px">${esc(d.to)}</span></div>` : ""}${
    d.groups.length ? commitGroups(d.groups, x, { into: chain ? d.from : null }) : `<div style="padding:10px 22px;${TOP};font-size:12.5px;color:var(--fg-55)">${d.ahead > 0 ? `${plural(d.ahead, "commit")} on ${esc(d.from)}; Trov has not listed them yet.` : `Nothing on ${esc(d.from)} is missing from ${esc(d.to)}.`}</div>`}`;

export const driftBlock: OverviewBlock = (f, x) => {
  const steps = f.drift;
  if (!steps.length) return "";
  const chain = f.envs.length >= 3;
  if (!chain) {
    const d = steps[0];
    const open = x.open.has(driftKey(d));
    return `<div class="repo-driftblock" data-drift="single" style="${TOP}">
      <button type="button" ${toggleAttrs(driftKey(d), open)} class="repo-strip" style="width:100%;display:flex;align-items:center;justify-content:center;gap:10px;padding:12px 22px;font-size:13px;color:var(--fg-70)">
        ${BRANCH_ICON}<span><span style="${BR}">${esc(d.from)}</span> is ${aheadText(d)} of <span style="${BR}">${esc(d.to)}</span></span>${chevron(open)}
      </button>
      ${panel(open, stepBody(d, x, false), ` data-step="${attr(driftKey(d))}"`)}
    </div>`;
  }
  return `<div class="repo-driftblock" data-drift="chain" style="${TOP}">
    <div style="display:flex;align-items:center;justify-content:center;gap:4px 10px;padding:12px 22px;flex-wrap:wrap;font-size:13px;color:var(--fg-70)">
      ${BRANCH_ICON}${steps.map((d, i) => {
        const open = x.open.has(driftKey(d));
        return `<span style="display:inline-flex;align-items:center;gap:8px">
          <span style="${BR};color:var(--fg)">${esc(d.from)}</span>
          <button type="button" ${toggleAttrs(driftKey(d), open)} class="repo-driftstep${open ? " is-open" : ""}" aria-label="${attr(`${d.from} is ${plural(d.ahead, "commit")} ahead of ${d.to}`)}"><span style="${N}">${d.ahead}</span> ahead${ARROW}</button>
          ${i === steps.length - 1 ? `<span style="${BR};color:var(--fg)">${esc(d.to)}</span>` : ""}
        </span>`;
      }).join("")}
    </div>
    ${steps.map((d) => panel(x.open.has(driftKey(d)), stepBody(d, x, true), ` data-step="${attr(driftKey(d))}"`)).join("")}
  </div>`;
};
