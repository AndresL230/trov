// The organization's PLAN as its members see it (shared/plans.ts; GET /api/o/:slug/plan):
//   • Org settings › General — the Plan block: the plan, what it includes, the org's use of
//     each limit, and how to change it. Everyone reads it; nobody edits it here.
//   • Org settings › Members — the seats in the lead line, and what replaces the invite form
//     when no seat is free (or the plan is for one person).
// Pure markup over the org pages' atoms (org-ui.ts). The server is the gate: this only says,
// before a refusal, what the server would say.

import {
  LIMIT_KEYS, LIMITS, formatLimit, formatUse, planRefusal, planRefusalSentence,
  type LimitKey, type OrgPlanView,
} from "@shared/plans";
import type { OrgRole } from "@shared/orgs";
import { esc, surface } from "./ui";
import { O_HELP, chip, orgHead, sliceNote, type OrgSlice } from "./org-ui";

/** The plan as the state `planRefusal` reads: its resolved limits stand in for plan + overrides. */
const stateOf = (v: OrgPlanView) => ({ plan: v.plan, overrides: v.entitlements, status: v.status });

/** Can this org invite someone now? `open`, or why not — in the server's own words. */
export type InviteGate = { kind: "open" } | { kind: "solo" | "full" | "ended"; sentence: string };
export function inviteGate(v: OrgPlanView | null, role: OrgRole): InviteGate {
  if (!v) return { kind: "open" }; // not read yet: the form is offered, and the server answers
  const refusal = planRefusal(stateOf(v), "seats", v.usage.seats);
  if (!refusal) return { kind: "open" };
  const sentence = planRefusalSentence(refusal, role);
  return { kind: v.status === "canceled" ? "ended" : (v.entitlements.seats ?? 2) <= 1 ? "solo" : "full", sentence };
}

/** The Members lead's opening: "7 of 10 seats used" (markup), or "" when seats are unlimited or unread. */
export function seatsLead(v: OrgPlanView | null): string {
  if (!v || v.entitlements.seats === null) return "";
  return `<strong>${v.usage.seats}</strong> of <strong>${v.entitlements.seats}</strong> ${v.entitlements.seats === 1 ? "seat" : "seats"} used`;
}

const STATUS_CHIP: Record<OrgPlanView["status"], string> = {
  active: "",
  past_due: chip("Payment past due", "var(--amber)"),
  canceled: chip("Ended", "var(--red)"),
};

function limitRow(v: OrgPlanView, key: LimitKey): string {
  const d = LIMITS[key];
  const cap = v.entitlements[key];
  const over = v.over.includes(key);
  // A count nobody can do anything with is noise: an unlimited limit shows what is used, and "Unlimited".
  const use = cap === null ? `${formatLimit(key, v.usage[key])} used &middot; ${formatLimit(key, null)}` : esc(formatUse(key, v.usage[key], cap));
  return `<li class="cnpy-plan-row" data-limit="${key}"${over ? ' data-over="1"' : ""}>
    <div style="flex:1 1 200px;min-width:0">
      <div style="font-size:13px;font-weight:500;color:var(--fg)">${esc(d.label)}${d.per === "person" ? ` <span style="font-weight:400;color:var(--fg-40)">per person</span>` : ""}</div>
      <div style="font-size:12px;line-height:1.45;color:var(--fg-40);margin-top:1px">${esc(d.counts)}</div>
    </div>
    <div style="flex:none;text-align:right;font-size:13px;font-variant-numeric:tabular-nums;color:var(--fg-70)">${use}${over ? `<div style="font-size:12px;font-weight:500;color:var(--amber);margin-top:1px">Over the limit</div>` : ""}</div>
  </li>`;
}

/**
 * Org settings › General › Plan. The plan's name and what it is for; each limit with the org's use of
 * it; what being over a limit means (nothing is removed — additions wait); and who changes the plan.
 */
export function planBlock(s: OrgSlice<OrgPlanView | null>, role: OrgRole): string {
  const head = orgHead("Plan", "", null, "org-plan-t");
  if (!s.data) return `<section aria-labelledby="org-plan-t" style="margin-top:22px">${head}${sliceNote(s, "the plan", false)}</section>`;
  const v = s.data;
  const overNames = v.over.map((k) => LIMITS[k].label.toLowerCase());
  const over = v.status === "canceled"
    ? `<div role="status" class="cnpy-plan-note" style="border-radius:9px">This plan has ended. Everything here stays as it is and keeps working, but nothing a limit covers can be added until the plan is renewed.</div>`
    : overNames.length
      ? `<div role="status" class="cnpy-plan-note" style="border-radius:9px">This organization is over its plan's ${esc(overNames.join(" and "))}. Nothing was removed and everyone keeps their access; more can be added once it is back under the limit.</div>`
      : "";
  return `<section aria-labelledby="org-plan-t" data-org-plan="${v.plan}" style="margin-top:22px">
    ${head}
    <div${surface("padding:18px 20px")}>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-size:15px;font-weight:600;letter-spacing:-0.005em">${esc(v.name)}</span>${STATUS_CHIP[v.status]}</div>
      <div style="font-size:12.5px;line-height:1.5;color:var(--fg-55);margin-top:2px">${esc(v.description)}</div>
      ${over}
      <ul class="cnpy-plan-rows">${LIMIT_KEYS.map((k) => limitRow(v, k)).join("")}</ul>
      <div style="${O_HELP};margin-top:14px">${role === "owner" ? `To change your plan, contact Trov.` : `An owner of this organization can ask Trov to change the plan.`}</div>
    </div>
  </section>`;
}
