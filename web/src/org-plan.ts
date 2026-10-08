// The organization's PLAN as its members see it (shared/plans.ts; GET /api/o/:slug/plan):
//   • Org settings › General — the Plan block: the plan, what it includes, the org's use of
//     each limit, and how to change it. Everyone reads it. An org that PAYS for its plan
//     (shared/billing.ts `OrgBillingView`) also shows how it pays — its seats, renews / past
//     due / cancelled, ends on a date — and gives its OWNER the ways to change that: Manage
//     billing, Change seats. A Free org (never paid, or its subscription ended)
//     offers its owner "Upgrade to Pro". Each one leaves for Stripe's own pages
//     (org-billing-actions.ts). A granted org on another plan shows nothing about payment.
//   • Org settings › Members — the seats in the lead line, and what replaces the invite form
//     when no seat is free (or the plan is for one person): the sentence, and for the OWNER the
//     one thing that fixes it — "Add a seat" (a paid Pro org) or "Upgrade to Pro" (Free).
// Pure markup over the org pages' atoms (org-ui.ts). The server is the gate: this only says,
// before a refusal, what the server would say.

import {
  LIMIT_KEYS, LIMITS, PLANS, UPGRADE_PLAN, formatLimit, formatUse, isSoloPlan, limitNoun, planRefusal, planRefusalSentence,
  type LimitKey, type OrgPlanView, type PlanNext,
} from "@shared/plans";
import { billingDate, isPast, type PurchasablePlan } from "@shared/billing";
import type { OrgRole } from "@shared/orgs";
import { esc, surface } from "./ui";
import { O_ERR, O_HELP, O_LABEL, chip, quietBtn, sliceNote, type OrgSlice } from "./org-ui";

/** The plan as the state `planRefusal` reads: its resolved limits stand in for plan + overrides. */
const stateOf = (v: OrgPlanView) => ({ plan: v.plan, overrides: v.entitlements, status: v.status, source: v.source });

/** Can this org invite someone now? `open`, or why not — in the server's own words, and (for its
 *  owner) the one thing that fixes it: `add_seat` on a paid Pro org, `upgrade` on a Free one. */
export type InviteGate = { kind: "open" } | { kind: "solo" | "full" | "ended"; sentence: string; next: PlanNext | null };
export function inviteGate(v: OrgPlanView | null, role: OrgRole): InviteGate {
  if (!v) return { kind: "open" }; // not read yet: the form is offered, and the server answers
  const refusal = planRefusal(stateOf(v), "seats", v.usage.seats);
  if (!refusal) return { kind: "open" };
  const sentence = planRefusalSentence(refusal, role);
  // Its button only where it can work: an owner's, with the org's billing view saying how it pays.
  const next = role === "owner" && refusal.next && v.billing
    && (refusal.next === "add_seat" ? v.billing.subscribed && v.billing.customer : v.billing.upgrade_to.length > 0) ? refusal.next : null;
  // "solo" — no invite section at all — only for a plan FOR one person; an org that bought one seat is "full".
  return { kind: v.status === "canceled" ? "ended" : (v.entitlements.seats ?? 2) <= 1 && isSoloPlan(v.plan) ? "solo" : "full", sentence, next };
}

/** The Members tab's button for an owner at the seat cap: "Add a seat" (the portal's seat count) or
 *  "Upgrade to Pro" (a checkout for this org). The Plan block's own acts (org-billing-actions.ts). */
export function seatCapAction(next: PlanNext | null, b: OrgBillingUi, available: boolean): string {
  if (!next) return "";
  const act = next === "add_seat" ? "orgBillingSeats" : "orgBillingUpgrade";
  const key = next === "add_seat" ? act : `${act}:${UPGRADE_PLAN}`;
  const busy = b.busy === key;
  const off = !available || b.busy !== null;
  const text = next === "add_seat" ? "Add a seat" : `Upgrade to ${PLANS[UPGRADE_PLAN].name}`;
  return quietBtn(busy ? "Opening Stripe…" : text, act, { arg: next === "add_seat" ? undefined : UPGRADE_PLAN, field: key, disabled: off, busy, extra: off ? "" : "color:var(--fg)" });
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
  // A monthly allowance that is used up (AI summaries) is not "over": the row says what happens instead.
  const spent = d.period && d.atCap && cap !== null && v.usage[key] >= cap ? `<div data-limit-spent style="font-size:12px;line-height:1.45;color:var(--fg-70);margin-top:3px">${esc(d.atCap)}</div>` : "";
  return `<li class="cnpy-plan-row" data-limit="${key}"${over ? ' data-over="1"' : ""}>
    <div class="cnpy-plan-what">
      <div style="font-size:13px;font-weight:500;color:var(--fg)">${esc(d.label)}${d.per === "person" ? ` <span style="font-weight:400;color:var(--fg-40)">per person</span>` : ""}</div>
      <div style="font-size:12px;line-height:1.45;color:var(--fg-40);margin-top:1px">${esc(d.counts)}</div>${spent}
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
}
export const initialOrgBillingUi = (): OrgBillingUi => ({ busy: null, error: null });

interface BillingPart { state: "active" | "past_due" | "cancelling" | "ended" | "free"; chip: string; line: string; actions: string; foot: string }

/** The chip beside the plan's name, the sentence under it, the owner's actions, the closing line. */
function billingPart(v: OrgPlanView, role: OrgRole, b: OrgBillingUi): BillingPart | null {
  const bill = v.billing;
  if (!bill) return null;
  const owner = role === "owner";
  const date = billingDate(v.period_end);
  const every = bill.interval === "year" ? "yearly " : bill.interval === "month" ? "monthly " : "";
  const cancelling = bill.subscribed && bill.cancel_at_period_end;
  const pro = PLANS[UPGRADE_PLAN].name;
  const seats = bill.seats === null ? "" : `${bill.seats} ${bill.seats === 1 ? "seat" : "seats"}, paid per seat. `;
  let line: string;
  const ended = date && isPast(v.period_end) ? ` on ${date}` : "";
  // Ended: the org moved to Free (a legacy org frozen as `canceled` says only that it ended).
  if (bill.ended) line = v.status === "canceled" ? `The subscription ended${ended}.`
    : `The ${pro} subscription ended${ended}, so this organization is on ${v.name} now. Nothing was removed; anything over a ${v.name} limit waits until it is back under.`;
  else if (!bill.subscribed) line = `${pro} is paid per seat: one for each member or pending invitation. It raises every limit below.`;
  else if (cancelling) line = `Cancelled: the plan ends${date ? ` on ${date}` : " at the end of the paid period"}, and then this organization moves to Free. Until then everything works as before.${owner ? " To keep it, resume the subscription in Manage billing." : ""}`;
  else if (v.status === "past_due") line = `The last payment did not go through. Stripe is trying the card again, and nothing changes while it does; if it keeps failing, the organization moves to Free.${date ? ` The current period runs to ${date}.` : ""}${owner ? " Update the card in Manage billing." : ""}`;
  else line = `${seats}${date ? `Renews on ${date}. ` : ""}Billed ${every}through Stripe.`;
  if (bill.pinned) line += " Trov set this plan for your organization, so it does not follow the subscription's.";

  const off = !bill.available || b.busy !== null;
  const btn = (text: string, act: string, plan?: PurchasablePlan): string => {
    const key = plan ? `${act}:${plan}` : act;
    const busy = b.busy === key;
    return quietBtn(busy ? "Opening Stripe…" : text, act, { arg: plan, field: key, disabled: off, busy, extra: off ? "" : "color:var(--fg)" });
  };
  const manage = bill.customer ? btn("Manage billing", "orgBillingPortal") : "";
  const actions = !owner ? ""
    : !bill.subscribed ? bill.upgrade_to.map((to) => btn(`Upgrade to ${PLANS[to].name}`, "orgBillingUpgrade", to)).join("") + manage
    : (bill.seats !== null && !cancelling && !bill.pinned ? btn("Change seats", "orgBillingSeats") : "") + manage;
  const foot = !owner ? (bill.subscribed || bill.ended ? "An owner of this organization manages its plan and billing." : `An owner of this organization can upgrade it to ${pro}.`)
    : !bill.available ? "Billing is not available right now, so these are off. Your plan is unchanged."
    : bill.subscribed ? "Card, invoices, seats and cancelling are on Stripe's pages. Trov never sees your card."
    : `${pro} is paid through Stripe; you choose the number of seats there. Trov never sees your card.`;
  return {
    state: bill.subscribed ? (cancelling ? "cancelling" : v.status === "past_due" ? "past_due" : "active") : bill.ended ? "ended" : "free",
    chip: cancelling ? chip("Cancelled", "var(--amber)") : "", line, actions, foot,
  };
}

/**
 * Org settings › General › Plan, as TWO tiles of General's bento (org-settings.ts `generalTab`).
 * The Plan tile: the plan's name and what it is for; for a paid org how it pays and (its owner) the
 * ways to change that; who changes the plan. The Limits tile: each limit with the org's use of it,
 * and what being over a limit means (nothing is removed — additions wait).
 */
export function planBlock(s: OrgSlice<OrgPlanView | null>, role: OrgRole, b: OrgBillingUi = initialOrgBillingUi()): string {
  const eyebrow = (title: string, id: string): string => `<h2 id="${id}" style="${O_LABEL};margin:0 0 12px">${title}</h2>`;
  if (!s.data) return `<section${surface("", { cls: "cnpy-tile cnpy-org-gen-limits" })} aria-labelledby="org-plan-t">${eyebrow("Plan", "org-plan-t")}${sliceNote(s, "the plan", false)}</section>`;
  const v = s.data;
  const overNames = v.over.map(limitNoun);
  const over = v.status === "canceled"
    ? `<div role="status" class="cnpy-plan-note" style="border-radius:9px">This plan has ended. Everything here stays as it is and keeps working, but nothing a limit covers can be added until the plan is renewed or upgraded.</div>`
    : overNames.length
      ? `<div role="status" class="cnpy-plan-note" style="border-radius:9px">This organization is over its plan's ${esc(overNames.join(" and "))}. Nothing was removed and everyone keeps their access; more can be added once it is back under the limit.</div>`
      : "";
  const pay = billingPart(v, role, b);
  const foot = pay ? pay.foot : role === "owner" ? `To change your plan, contact Trov.` : `An owner of this organization can ask Trov to change the plan.`;
  return `<section${surface("", { cls: "cnpy-tile cnpy-org-gen-plan" })} aria-labelledby="org-plan-t" data-org-plan="${v.plan}"${pay ? ` data-org-billing="${pay.state}"` : ""}>
      ${eyebrow("Plan", "org-plan-t")}
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-size:15px;font-weight:600;letter-spacing:-0.005em">${esc(v.name)}</span>${STATUS_CHIP[v.status]}${pay?.chip ?? ""}</div>
      <div style="font-size:12.5px;line-height:1.5;color:var(--fg-55);margin-top:2px">${esc(v.description)}</div>
      ${pay ? `<p data-plan-billing style="margin:8px 0 0;font-size:12.5px;line-height:1.55;color:var(--fg-70)">${esc(pay.line)}</p>` : ""}
      ${pay?.actions ? `<div class="cnpy-plan-actions">${pay.actions}</div>` : ""}
      ${pay && b.error ? `<div role="alert" style="${O_ERR}">${esc(b.error)}</div>` : ""}
      <div class="cnpy-tile-foot" style="${O_HELP};margin-top:auto;padding-top:14px">${esc(foot)}</div>
    </section>
    <section${surface("", { cls: "cnpy-tile cnpy-org-gen-limits" })} aria-labelledby="org-limits-t">
      ${eyebrow("Limits", "org-limits-t")}
      ${over}
      <ul class="cnpy-plan-rows">${LIMIT_KEYS.map((k) => limitRow(v, k)).join("")}</ul>
    </section>`;
}
