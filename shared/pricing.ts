// What each plan COSTS, as the public pricing page shows it (web/src/pricing.ts: the landing's
// Pricing section and the /pricing page). The plans themselves — names, descriptions, every
// limit — are shared/plans.ts; nothing here restates them. The purchase link is billing's own
// (shared/billing.ts); nothing else is imported.
//
// PRICES ARE THE OWNER'S TO DECIDE. `price: null` means "not announced" (or, for a plan that is not
// self-serve, "custom"): the page says so. `price: 0` is Free: the card says "Free" and its button
// starts an organization (sign in, then create it), never a purchase. Any other price is a purchase
// link — Pro's is PER SEAT (`per`). To offer yearly billing, set `yearly` too; the Monthly / Yearly
// switch appears once any plan has both. A plan that is not `offered` (shared/plans.ts) is not shown.

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
  free: { price: 0, per: "", yearly: null, yearlyPer: "", badge: null, selfServe: true },
  // Legacy: no longer sold, and not shown (shared/plans.ts `offered`).
  personal: { price: null, per: "per month", yearly: null, yearlyPer: "per year", badge: null, selfServe: false },
  team: { price: 10, per: "per seat / month", yearly: null, yearlyPer: "per seat / year", badge: "Most teams start here", selfServe: true },
  enterprise: { price: null, per: "per month", yearly: null, yearlyPer: "per year", badge: null, selfServe: false },
};

/** Can this plan be bought on the site right now? The page's ONLY test — it asks no server. Free is
 *  never bought (`isFreePrice`). */
export const canPurchase = (p: PlanPricing): boolean => p.selfServe && p.price !== null && p.price > 0;
/** A self-serve plan that costs nothing: its card starts an organization instead of a purchase. */
export const isFreePrice = (p: PlanPricing): boolean => p.selfServe && p.price === 0;
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
