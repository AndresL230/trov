// The organization's PLAN as its members see it (shared/plans.ts; GET /api/o/:slug/plan):
//   • Org settings › General — the Plan block: the plan, what it includes, the org's use of
//     each limit, and how to change it. Everyone reads it. An org that PAYS for its plan
//     (shared/billing.ts `OrgBillingView`) also shows how it pays — renews / past due /
//     cancelled, ends on a date — and gives its OWNER the three ways to change that: Manage
//     billing, a plan switch, a renewal. Each one leaves for Stripe's own pages
//     (org-billing-actions.ts). A granted org shows nothing about payment.
//   • Org settings › Members — the seats in the lead line, and what replaces the invite form
//     when no seat is free (or the plan is for one person).
// Pure markup over the org pages' atoms (org-ui.ts). The server is the gate: this only says,
// before a refusal, what the server would say.

import {
  LIMIT_KEYS, LIMITS, PLANS, formatLimit, formatUse, planRefusal, planRefusalSentence, resolveEntitlements,
  type LimitKey, type OrgPlanView,
} from "@shared/plans";
import { billingDate, isPast, type PurchasablePlan } from "@shared/billing";
import type { OrgRole } from "@shared/orgs";
import { esc, surface } from "./ui";
import { O_ERR, O_HELP, chip, orgHead, quietBtn, sliceNote, type OrgSlice } from "./org-ui";

/** The plan as the state `planRefusal` reads: its resolved limits stand in for plan + overrides. */
const stateOf = (v: OrgPlanView) => ({ plan: v.plan, overrides: v.entitlements, status: v.status, source: v.source });

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

// ── billing: how a paid org pays ─────────────────────────────────────────────

/** The Plan block's billing actions, as Org settings holds them (`OrgUi.billing`). */
export interface OrgBillingUi {
  /** The action on its way to Stripe, as `<act>` or `<act>:<plan>` (its button says so; the others wait). */
  busy: string | null;
  error: string | null;
  /** A switch to a SMALLER plan, waiting to be confirmed: the plan it would move to. */
  confirm: PurchasablePlan | null;
}
export const initialOrgBillingUi = (): OrgBillingUi => ({ busy: null, error: null, confirm: null });

/** Does a switch to `to` shrink the org's seats? Then it is confirmed here first, with what that means. */
export function isSmallerPlan(v: OrgPlanView, to: PurchasablePlan): boolean {
  const seats = PLANS[to].entitlements.seats;
  return seats !== null && (v.entitlements.seats === null || seats < v.entitlements.seats);
}

/**
 * What switching THIS org's subscription to a smaller plan does, said before the owner leaves for
 * Stripe. Stripe allows it whatever the org holds; Trov's over-limit rule then applies — nothing is
 * deleted and nobody is removed, additions of what is over wait.
 */
export function planSwitchCopy(v: OrgPlanView, orgName: string, to: PurchasablePlan): { title: string; body: string; confirmLabel: string; busyLabel: string } {
  const next = resolveEntitlements(to);
  const over = LIMIT_KEYS.filter((k) => LIMITS[k].per === "org" && next[k] !== null && v.usage[k] > (next[k] as number));
  const seats = next.seats !== null && v.usage.seats > next.seats
    ? `${PLANS[to].name} is for ${next.seats === 1 ? "one person" : `up to ${next.seats} people`}, and ${orgName} has ${v.usage.seats} (members and pending invitations). `
    : "";
  const effect = over.length
    ? `${seats}Nobody is removed and nothing is deleted, but it will be over the plan's ${over.map((k) => LIMITS[k].label.toLowerCase()).join(" and ")}: no more can be added until it is back under.`
    : `${orgName} fits within ${PLANS[to].name}, so nothing it has changes.`;
  return {
    title: `Switch ${orgName} to ${PLANS[to].name}?`,
    body: `${effect} Stripe shows the new price and what is credited, and takes the confirmation.`,
    confirmLabel: "Continue to Stripe", busyLabel: "Opening Stripe…",
  };
}

interface BillingPart { state: "active" | "past_due" | "cancelling" | "ended"; chip: string; line: string; actions: string; foot: string }

/** The chip beside the plan's name, the sentence under it, the owner's actions, the closing line. */
function billingPart(v: OrgPlanView, role: OrgRole, b: OrgBillingUi): BillingPart | null {
  const bill = v.billing;
  if (!bill) return null;
  const owner = role === "owner";
  const date = billingDate(v.period_end);
  const every = bill.interval === "year" ? "yearly " : bill.interval === "month" ? "monthly " : "";
  const cancelling = v.status !== "canceled" && bill.cancel_at_period_end;
  let line: string;
  if (v.status === "canceled") line = date && isPast(v.period_end) ? `The subscription ended on ${date}.` : "The subscription has ended.";
  else if (cancelling) line = `Cancelled: the plan ends${date ? ` on ${date}` : " at the end of the paid period"}. Until then everything works as before.${owner ? " To keep it, resume the subscription in Manage billing." : ""}`;
  else if (v.status === "past_due") line = `The last payment did not go through. Stripe is trying the card again, and nothing changes while it does; if it keeps failing, the plan ends.${date ? ` The current period runs to ${date}.` : ""}${owner ? " Update the card in Manage billing." : ""}`;
  else line = `${date ? `Renews on ${date}. ` : ""}Billed ${every}through Stripe.`;
  if (bill.pinned) line += " Trov set this plan for your organization, so it does not follow the subscription's.";

  const off = !bill.available || b.busy !== null;
  const btn = (text: string, act: string, plan?: PurchasablePlan): string => {
    const key = plan ? `${act}:${plan}` : act;
    const busy = b.busy === key;
    return quietBtn(busy ? "Opening Stripe…" : text, act, { arg: plan, field: key, disabled: off, busy, extra: off ? "" : "color:var(--fg)" });
  };
  const manage = btn("Manage billing", "orgBillingPortal");
  const up = bill.switch_to.filter((to) => !isSmallerPlan(v, to)), down = bill.switch_to.filter((to) => isSmallerPlan(v, to));
  const renew = [...bill.renew_on].sort((a, c) => Number(c === v.plan) - Number(a === v.plan));
  const actions = !owner ? ""
    : v.status === "canceled" ? renew.map((to) => btn(to === v.plan ? `Renew ${PLANS[to].name}` : `Renew on ${PLANS[to].name}`, "orgBillingRenew", to)).join("") + manage
    : up.map((to) => btn(`Upgrade to ${PLANS[to].name}`, "orgBillingChange", to)).join("") + manage + down.map((to) => btn(`Switch to ${PLANS[to].name}`, "orgBillingChange", to)).join("");
  const foot = !owner ? "An owner of this organization manages its plan and billing."
    : !bill.available ? "Billing is not available right now, so these are off. Your plan is unchanged."
    : "Card, invoices and cancelling are on Stripe's pages. Trov never sees your card.";
  return {
    state: v.status === "canceled" ? "ended" : cancelling ? "cancelling" : v.status,
    chip: cancelling ? chip("Cancelled", "var(--amber)") : "", line, actions, foot,
  };
}

/**
 * Org settings › General › Plan. The plan's name and what it is for; for a paid org how it pays and
 * (its owner) the ways to change that; each limit with the org's use of it; what being over a limit
 * means (nothing is removed — additions wait); and who changes the plan.
 */
export function planBlock(s: OrgSlice<OrgPlanView | null>, role: OrgRole, b: OrgBillingUi = initialOrgBillingUi()): string {
  const head = orgHead("Plan", "", null, "org-plan-t");
  if (!s.data) return `<section aria-labelledby="org-plan-t" style="margin-top:22px">${head}${sliceNote(s, "the plan", false)}</section>`;
  const v = s.data;
  const overNames = v.over.map((k) => LIMITS[k].label.toLowerCase());
  const over = v.status === "canceled"
    ? `<div role="status" class="cnpy-plan-note" style="border-radius:9px">This plan has ended. Everything here stays as it is and keeps working, but nothing a limit covers can be added until the plan is renewed.</div>`
    : overNames.length
      ? `<div role="status" class="cnpy-plan-note" style="border-radius:9px">This organization is over its plan's ${esc(overNames.join(" and "))}. Nothing was removed and everyone keeps their access; more can be added once it is back under the limit.</div>`
      : "";
  const pay = billingPart(v, role, b);
  const foot = pay ? pay.foot : role === "owner" ? `To change your plan, contact Trov.` : `An owner of this organization can ask Trov to change the plan.`;
  return `<section aria-labelledby="org-plan-t" data-org-plan="${v.plan}"${pay ? ` data-org-billing="${pay.state}"` : ""} style="margin-top:22px">
    ${head}
    <div${surface("padding:18px 20px")}>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-size:15px;font-weight:600;letter-spacing:-0.005em">${esc(v.name)}</span>${STATUS_CHIP[v.status]}${pay?.chip ?? ""}</div>
      <div style="font-size:12.5px;line-height:1.5;color:var(--fg-55);margin-top:2px">${esc(v.description)}</div>
      ${pay ? `<p data-plan-billing style="margin:8px 0 0;font-size:12.5px;line-height:1.55;color:var(--fg-70)">${esc(pay.line)}</p>` : ""}
      ${pay?.actions ? `<div class="cnpy-plan-actions">${pay.actions}</div>` : ""}
      ${pay && b.error ? `<div role="alert" style="${O_ERR}">${esc(b.error)}</div>` : ""}
      ${over}
      <ul class="cnpy-plan-rows">${LIMIT_KEYS.map((k) => limitRow(v, k)).join("")}</ul>
      <div style="${O_HELP};margin-top:14px">${esc(foot)}</div>
    </div>
  </section>`;
}
