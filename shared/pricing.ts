// What each plan COSTS, as the public pricing page shows it (web/src/pricing.ts: the landing's
// Pricing section and the /pricing page). The plans themselves — names, descriptions, every
// limit — are shared/plans.ts; nothing here restates them. The purchase link is billing's own
// (shared/billing.ts); nothing else is imported.
//
// PRICES ARE THE OWNER'S TO DECIDE. `price: null` means "not announced": the page says so and
// offers a waitlist e-mail instead of a purchase link. To announce one, set `price` (and
// `yearly`, if the plan can be paid by the year) below — nothing else changes: the card shows
// the amount, its button becomes the purchase link, and the Monthly / Yearly switch appears once
// any plan has both.

import type { PlanId } from "./plans";
import { billingStartHref, isPurchasablePlan, type BillingInterval, type PurchasablePlan } from "./billing";

export type { BillingInterval };

export interface PlanPricing {
  /** The price for one `per`, in whole units of PRICE_CURRENCY (12, 12.5). null = not announced. */
  price: number | null;
  /** What `price` buys, as the words after the amount: "per month", "per seat, per month". */
  per: string;
  /** The price when paid by the year, or null when the plan is monthly only. */
  yearly: number | null;
  /** The words after `yearly`: "per year". */
  yearlyPer: string;
  /** One quiet line beside the plan's name, or null. */
  badge: string | null;
  /** true: bought on the site (once it has a price). false: by conversation — never a purchase link. */
  selfServe: boolean;
}

/** ISO 4217. Every price above is in it. */
export const PRICE_CURRENCY = "USD";

export const PRICING: Record<PlanId, PlanPricing> = {
  personal: { price: null, per: "per month", yearly: null, yearlyPer: "per year", badge: null, selfServe: true },
  team: { price: null, per: "per month", yearly: null, yearlyPer: "per year", badge: "Most teams start here", selfServe: true },
  enterprise: { price: null, per: "per month", yearly: null, yearlyPer: "per year", badge: null, selfServe: false },
};

/** Can this plan be bought on the site right now? The page's ONLY test — it asks no server. */
export const canPurchase = (p: PlanPricing): boolean => p.selfServe && p.price !== null;
/** The same test for a plan by id, narrowing it to one billing sells: a plan billing's route would turn
 *  away (Enterprise) never gets a purchase link, whatever the table above says. */
export const canPurchasePlan = (id: PlanId, p: PlanPricing): id is PurchasablePlan => canPurchase(p) && isPurchasablePlan(id);
/** Can it also be bought by the year? */
export const hasYearly = (p: PlanPricing): boolean => canPurchase(p) && p.yearly !== null;

/** "$12", "$12.50", "€9". */
export function formatPrice(amount: number, currency: string = PRICE_CURRENCY): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 }).format(amount);
}

/**
 * THE purchase link: a plain navigation (no fetch) to the billing route, which handles sign-in
 * and payment. `interval` is on the URL only for a yearly purchase. ONE source: this is
 * `billingStartHref` (shared/billing.ts), the path the billing route itself seals and returns to.
 */
export const purchaseHref = (plan: PurchasablePlan, interval: BillingInterval = "month"): string => billingStartHref(plan, interval);
