// Org settings › General › Plan's billing actions — the controller behind org-plan.ts's buttons
// (docs/architecture/billing.md › Managing billing). An OWNER's only, and each of the three ends the
// same way: the Worker answers a URL on Stripe's own pages and the browser goes there —
//   orgBillingPortal            Manage billing: card, invoices, cancel
//   orgBillingChange <plan>     move THIS subscription to another plan (Stripe confirms the price)
//   orgBillingRenew  <plan>     a plan that has ended: pay again, for the same organization
// A switch to a SMALLER plan is confirmed here first (`confirmModal`): Stripe allows it whatever the org
// holds, so this is where the owner is told nothing is deleted and what will wait. Nothing about the
// plan changes in this tab — it changes when Stripe's webhook lands; coming back reloads the block.

import type { AppState } from "./render";
import { isPurchasablePlan, type PurchasablePlan } from "@shared/billing";
import { ApiError, OrgApiError, Unauthorized, changeBillingPlan, openBillingPortal, rateLimitText, renewBilling } from "./api";
import { currentOrg } from "./org-settings";
import { isSmallerPlan } from "./org-plan";

export interface OrgBillingHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  unauth(e: unknown): void;
  /** Play the confirmation modal's exit, then run `then`. */
  confirmOut(then: () => void): void;
  /** Leave for Stripe. Injected so a test does not navigate. */
  go?(url: string): void;
}

/** A refused billing call as a sentence that says what to do next. */
export function billingErrorText(e: unknown): string {
  const limited = rateLimitText(e);
  if (limited) return limited;
  if (!(e instanceof ApiError)) return "Couldn't reach Trov. Check your connection and try again.";
  switch (e.message) {
    case "billing_unavailable": return "Billing is not available right now. Your plan is unchanged.";
    case "forbidden": return "Only an owner of this organization manages its billing.";
    case "not_billed": return "This organization's plan is set by Trov, not paid for here. Write to Trov to change it.";
    case "same_plan": return "This organization is already on that plan.";
    case "plan_ended": return "This plan has ended. Renew it instead.";
    case "not_ended": return "This plan has not ended, so there is nothing to renew. Use Manage billing.";
    default: return e instanceof OrgApiError && e.detail ? e.detail : "Couldn't open Stripe. Nothing was changed. Try again in a minute.";
  }
}

export function createOrgBillingActions(host: OrgBillingHost): { act(name: string, arg: string | null): boolean } {
  const { state, mount } = host;
  const ui = () => state.org.billing;
  const go = host.go ?? ((url: string) => { location.assign(url); });

  /** Ask for the Stripe URL and go there. The buttons wait (`busy`) until the page unloads or the call is refused. */
  function leave(key: string, ask: (slug: string) => Promise<{ url: string }>): void {
    const o = currentOrg(state);
    if (!o || o.role !== "owner" || ui().busy) return;
    ui().busy = key;
    ui().error = null;
    host.rerender();
    ask(o.slug)
      .then((r) => { go(r.url); })
      .catch((e) => {
        if (e instanceof Unauthorized) { host.unauth(e); return; }
        ui().busy = null;
        ui().confirm = null;
        ui().error = billingErrorText(e);
        host.rerender();
      });
  }

  // Back from Stripe by the browser's Back button (a page restored from its cache): the buttons work again.
  if (typeof window !== "undefined") {
    window.addEventListener("pageshow", (e) => {
      if (!e.persisted || (!ui().busy && !ui().confirm)) return;
      ui().busy = null;
      ui().confirm = null;
      host.rerender();
    });
  }

  function act(name: string, arg: string | null): boolean {
    if (!name.startsWith("orgBilling")) return false;
    const plan: PurchasablePlan | null = isPurchasablePlan(arg) ? arg : null;
    switch (name) {
      case "orgBillingPortal": leave("orgBillingPortal", openBillingPortal); break;
      case "orgBillingRenew": if (plan) leave(`orgBillingRenew:${plan}`, (slug) => renewBilling(slug, plan)); break;
      case "orgBillingChange": {
        const view = state.org.plan.data;
        if (!plan || !view || ui().busy) break;
        // Growing needs no word from Trov: Stripe's own screen shows the price and takes the confirmation.
        if (!isSmallerPlan(view, plan)) { leave(`orgBillingChange:${plan}`, (slug) => changeBillingPlan(slug, plan)); break; }
        ui().confirm = plan;
        ui().error = null;
        host.rerender();
        mount.querySelector<HTMLElement>("[data-confirm-focus]")?.focus();
        break;
      }
      case "orgBillingConfirmGo": {
        const to = ui().confirm;
        if (to) leave(`orgBillingChange:${to}`, (slug) => changeBillingPlan(slug, to));
        break;
      }
      case "orgBillingConfirmCancel": {
        const to = ui().confirm;
        if (!to || ui().busy) break;
        host.confirmOut(() => {
          ui().confirm = null;
          host.rerender();
          mount.querySelector<HTMLElement>(`[data-field="orgBillingChange:${to}"]`)?.focus();
        });
        break;
      }
    }
    return true;
  }
  return { act };
}
