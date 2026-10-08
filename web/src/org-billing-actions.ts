// Org settings › General › Plan's billing actions — the controller behind org-plan.ts's buttons
// (docs/architecture/billing.md › Managing billing). An OWNER's only, and each of the four ends the
// same way: the Worker answers a URL on Stripe's own pages and the browser goes there —
//   orgBillingPortal            Manage billing: card, invoices, seats, cancel
//   orgBillingSeats             Add a seat / Change seats: the portal, straight to the seat count
//   orgBillingUpgrade <plan>    a Free org buys Pro (never paid, or its subscription ended): same organization
// The Members tab's "Add a seat" and "Upgrade to Pro" (at the seat cap) are these same acts. Nothing
// about the plan changes in this tab — it changes when Stripe's webhook lands; coming back reloads it.

import type { AppState } from "./render";
import { isPurchasablePlan, type PurchasablePlan } from "@shared/billing";
import { ApiError, OrgApiError, Unauthorized, openBillingPortal, openBillingSeats, rateLimitText, upgradeBilling } from "./api";
import { currentOrg } from "./org-settings";

export interface OrgBillingHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  unauth(e: unknown): void;
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
    case "not_free": return "This organization already has a paid plan. Use Manage billing.";
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
        ui().error = billingErrorText(e);
        host.rerender();
      });
  }

  // Back from Stripe by the browser's Back button (a page restored from its cache): the buttons work again.
  if (typeof window !== "undefined") {
    window.addEventListener("pageshow", (e) => {
      if (!e.persisted || !ui().busy) return;
      ui().busy = null;
      host.rerender();
    });
  }

  function act(name: string, arg: string | null): boolean {
    if (!name.startsWith("orgBilling")) return false;
    const plan: PurchasablePlan | null = isPurchasablePlan(arg) ? arg : null;
    switch (name) {
      case "orgBillingPortal": leave("orgBillingPortal", openBillingPortal); break;
      case "orgBillingSeats": leave("orgBillingSeats", openBillingSeats); break;
      case "orgBillingUpgrade": if (plan) leave(`orgBillingUpgrade:${plan}`, (slug) => upgradeBilling(slug, plan)); break;
    }
    return true;
  }
  return { act };
}
