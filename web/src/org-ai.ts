// Org settings › AI (`#org/ai`) — the organization's switch for what Trov writes, this month's AI runs
// against the plan's allowance, and what is sent to Anthropic (organizations.md › Org settings › AI).
// Everyone reads the tab; only an admin or an owner flips the switch (`PUT /ai/settings`), and a
// member sees its state as words. Pure markup over `GET /ai/settings` (shared/ai-core.ts `AiSettings`);
// the acts are org-actions.ts's (`orgAiToggle`).

import type { AiSettings } from "@shared/ai-core";
import type { MyOrg } from "@shared/orgs";
import { esc, attr, surface } from "./ui";
import { orgHead, tabLead, sliceNote, type OrgSlice } from "./org-ui";
import { switchBtn } from "./notifications";
import { kindMark, aiMark } from "./marks";
import { aiDay } from "./ai-ui";
import { formatCount } from "@shared/plans";

const LIST = "overflow:hidden;list-style:none;margin:0;padding:0";
const ROW = "display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border);margin-bottom:-1px";

/** Why nothing runs although the switch is on — said as a fact, never as an error. */
const ELIGIBILITY_LINE: Record<AiSettings["eligibility"], string> = {
  ok: "",
  off: "",
  no_key: "This Trov has no Anthropic key, so nothing is written whatever the switch says. Whoever runs this Trov can add one.",
  capped: "",
};

/** "12 of 300 AI runs this month" / "12 AI runs this month (unlimited)". */
export function aiRunsLine(r: AiSettings["runs"]): string {
  return r.cap === null
    ? `${formatCount(r.used)} AI ${r.used === 1 ? "run" : "runs"} this month (unlimited)`
    : `${formatCount(r.used)} of ${formatCount(r.cap)} AI runs this month`;
}

export function aiTab(org: MyOrg, slice: OrgSlice<AiSettings | null>, saving: boolean): string {
  const a = slice.data;
  if (!a) return sliceNote(slice, "the AI settings", false, { form: true }) || "";
  const on = a.enabled;
  const capped = a.eligibility === "capped" || (a.runs.cap !== null && a.runs.used >= a.runs.cap);
  const lead = tabLead(`Trov's AI is <strong>${on ? "on" : "off"}</strong> for ${esc(org.name)}: it writes briefs, the Repo dashboard's state and themes, and feed entries from your work, and suggests values a person accepts.${a.canEdit ? "" : " Only an admin or an owner can change this."}`);

  // The switch — an admin's; a member reads its state as words.
  const control = a.canEdit
    ? `<span style="display:inline-flex;align-items:center;gap:10px"${saving ? ' aria-busy="true"' : ""}><span id="org-ai-switch-l" style="font-size:12.5px;color:var(--fg-55)">${on ? "On" : "Off"}</span>${switchBtn("orgAiToggle", null, on, "Trov's AI for this organization", saving)}</span>`
    : `<span style="font-size:13px;font-weight:500;color:var(--fg-70)">${on ? "On" : "Off"}</span>`;
  const note = ELIGIBILITY_LINE[a.eligibility];
  const automation = `<section aria-labelledby="org-ai-auto" data-org-ai="${on ? "on" : "off"}">
      ${orgHead("Automation", "", null, "org-ai-auto")}
      <ul${surface(LIST)}><li style="${ROW}">
        <span style="flex:none;margin-top:2px">${aiMark(15)}</span>
        <div style="flex:1 1 260px;min-width:0">
          <div style="font-size:13.5px;font-weight:600">Written by Trov</div>
          <div style="font-size:12.5px;color:var(--fg-55);margin-top:3px;line-height:1.55">Off stops every new brief, state, theme, feed entry and suggestion; what was already written stays until it is replaced.</div>
          ${note ? `<div style="font-size:12.5px;color:var(--fg-70);margin-top:6px;line-height:1.55">${kindMark("No key", "waiting", 12)} ${esc(note)}</div>` : ""}
        </div>
        <div style="flex:none">${control}</div>
      </li></ul>
    </section>`;

  // This month's runs against the plan's allowance.
  const r = a.runs;
  const pct = r.cap ? Math.min(100, Math.round((r.used / Math.max(1, r.cap)) * 100)) : 0;
  const meter = r.cap === null ? "" : `<div class="cnpy-meter" data-meter="${pct >= 100 ? "full" : "ok"}" role="meter" aria-label="AI runs this month" aria-valuemin="0" aria-valuemax="${r.cap}" aria-valuenow="${Math.min(r.used, r.cap)}" aria-valuetext="${attr(aiRunsLine(r))}"><span style="width:${pct}%"></span></div>`;
  const resume = capped && r.resumesOn
    ? `<div style="font-size:12.5px;color:var(--amber);margin-top:8px">Monthly AI allowance used; Trov writes again on ${esc(aiDay(r.resumesOn))}.</div>` : "";
  const month = `<section aria-labelledby="org-ai-month" style="margin-top:22px">
      ${orgHead("This month", "", null, "org-ai-month")}
      <div${surface("padding:14px 16px")}>
        <div data-ai-runs style="font-size:13.5px;font-weight:500;font-variant-numeric:tabular-nums">${esc(aiRunsLine(r))}</div>
        ${meter}${resume}
        <div style="font-size:12px;color:var(--fg-55);margin-top:8px">Counted per calendar month (UTC), against this organization's plan.</div>
      </div>
    </section>`;

  // What leaves Trov — a list, so it grows as features land.
  const sends = a.sends.length
    ? a.sends.map((s) => `<li style="${ROW}"><div style="min-width:0"><div style="font-size:13.5px;line-height:1.5">${esc(s.what)}</div><div style="font-size:12px;color:var(--fg-55);margin-top:2px">For ${esc(s.for.charAt(0).toLowerCase() + s.for.slice(1))}</div></div></li>`).join("")
    : `<li style="${ROW}"><span style="font-size:13px;color:var(--fg-55)">Nothing is sent yet.</span></li>`;
  const sent = `<section aria-labelledby="org-ai-sent" style="margin-top:22px">
      ${orgHead("What is sent to Anthropic", "", null, "org-ai-sent")}
      <ul${surface(LIST)} data-ai-sends>${sends}
        <li style="${ROW}"><div style="min-width:0"><div style="font-size:12px;font-weight:600;color:var(--fg-55)">Never sent</div><div style="font-size:13.5px;line-height:1.5;margin-top:2px">${esc(a.neverSent)}</div></div></li>
      </ul>
    </section>`;
  return `${lead}${automation}${month}${sent}`;
}
