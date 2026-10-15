// Billing's configuration, read from the Worker's environment in ONE place (docs/architecture/billing.md).
// Pure: no fetch, no D1 — anything may import it. The Stripe client (./stripe.ts) is the only reader of
// the key this hands out.
//
// Billing is CONFIGURED when both secrets are set: the key (to start a checkout) and the webhook secret
// (to hear that it was paid — without it a payment could be taken and never fulfilled, so a deployment
// with only a key sells nothing). A plan is PURCHASABLE on the intervals it has a price id for. No amount
// is known here: a price is an opaque id the owner pastes into wrangler.toml. Pro (`team`) is the one
// plan sold, PER SEAT: its price is the price of one seat, and a checkout's quantity is the seat count.
import type { Env } from "../env";
import {
  BILLING_INTERVALS, PURCHASABLE_PLANS, NO_BILLING_OFFERS, billingStartHref,
  type BillingInterval, type BillingPlanOffer, type PurchasablePlan,
} from "@shared/billing";
import type { PlanId } from "@shared/plans";
import { isLiveStripeKey, loopbackOrigin } from "../platform/loopback";

/** The one host the key is ever sent to. */
export const STRIPE_API = "https://api.stripe.com";

export interface BillingConfig {
  /** The secret key. Read by ./stripe.ts for the Authorization header and by nothing else. */
  secretKey: string;
  webhookSecret: string;
  mode: "test" | "live";
  /** `STRIPE_API`, or — never with a live key — the loopback stand-in a test names. */
  apiBase: string;
  prices: Record<PurchasablePlan, Partial<Record<BillingInterval, string>>>;
  /** `STRIPE_TAX = "on"`: a checkout asks Stripe Tax for the tax. Stripe charges it only where the account
   *  holds a tax registration, so with none every invoice is the price alone — Trov computes no tax itself. */
  tax: boolean;
  /** `STRIPE_PUBLISHABLE_KEY` when it is a publishable key (`pk_test_…` / `pk_live_…`), else null. PUBLIC by
   *  design — the one Stripe value that may reach a browser. */
  publishableKey: string | null;
  /**
   * THE one decision between the two checkouts (routes.ts `startCheckout`, `/billing/start`, the org
   * upgrade): true → a purchase is paid in Trov's own page with Stripe's embedded form; false → Stripe's
   * hosted page. On only when the publishable key is set AND is the same mode as the secret key (a test
   * `pk_` beside a live `sk_` cannot mount the session, so the buyer would meet a dead form) AND the API
   * is the real Stripe: the loopback stand-in (`STRIPE_TEST_API_BASE`) has no Stripe.js to serve.
   */
  embedded: boolean;
}

/** Which mode a PUBLISHABLE key is, or null for anything that is not one (a secret key pasted here by
 *  mistake is never treated as publishable, so it can never be sent to a browser). */
export const publishableKeyMode = (key: string | null | undefined): "test" | "live" | null => {
  const m = typeof key === "string" ? /^pk_(test|live)_[A-Za-z0-9]+$/.exec(key.trim()) : null;
  return m ? (m[1] as "test" | "live") : null;
};

const set = (v: string | undefined): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** What `holdsLiveKey` reads. */
export type LiveKeyEnv = Pick<Env, "STRIPE_SECRET_KEY">;
/** The Worker holds a LIVE Stripe key — whether or not billing is otherwise configured. What every local
 *  stand-in asks before it is honoured (here, and src/sync/local-upstream.ts): none is, beside a live key.
 *  Answers a boolean; the key goes nowhere. */
export const holdsLiveKey = (env: LiveKeyEnv): boolean => isLiveStripeKey(env.STRIPE_SECRET_KEY);

/** The configuration, or null when billing is off (no key, or no webhook secret). */
export function billingConfig(env: Env): BillingConfig | null {
  const secretKey = set(env.STRIPE_SECRET_KEY), webhookSecret = set(env.STRIPE_WEBHOOK_SECRET);
  if (!secretKey || !webhookSecret) return null;
  const mode = isLiveStripeKey(secretKey) ? "live" : "test";
  const price = (month: string | undefined, year: string | undefined): Partial<Record<BillingInterval, string>> => {
    const m = set(month), y = set(year);
    return { ...(m ? { month: m } : {}), ...(y ? { year: y } : {}) };
  };
  // The stand-in (`STRIPE_TEST_API_BASE`): a loopback http origin, and never with a live key (src/platform/loopback.ts).
  const apiBase = (mode === "test" ? loopbackOrigin(env.STRIPE_TEST_API_BASE) : null) ?? STRIPE_API;
  const pk = set(env.STRIPE_PUBLISHABLE_KEY);
  const publishableKey = pk && publishableKeyMode(pk) ? pk : null;
  return {
    secretKey, webhookSecret, mode, apiBase,
    prices: {
      team: price(env.STRIPE_PRICE_TEAM, env.STRIPE_PRICE_TEAM_YEARLY),
    },
    tax: set(env.STRIPE_TAX)?.toLowerCase() === "on",
    publishableKey,
    embedded: publishableKey !== null && publishableKeyMode(publishableKey) === mode && apiBase === STRIPE_API,
  };
}

export const priceFor = (cfg: BillingConfig, plan: PurchasablePlan, interval: BillingInterval): string | null => cfg.prices[plan][interval] ?? null;
export const intervalsOf = (cfg: BillingConfig, plan: PurchasablePlan): BillingInterval[] => BILLING_INTERVALS.filter((i) => cfg.prices[plan][i] !== undefined);

/** Which plan and interval a Stripe price id is, or null for a price Trov does not sell. */
export function planOfPrice(cfg: BillingConfig, priceId: string | null | undefined): { plan: PurchasablePlan; interval: BillingInterval } | null {
  if (!priceId) return null;
  for (const plan of PURCHASABLE_PLANS) for (const interval of BILLING_INTERVALS) if (cfg.prices[plan][interval] === priceId) return { plan, interval };
  return null;
}

/** What each plan offers right now, from this deployment's Stripe config (`GET /api/billing/config`). The public
 *  pricing page does not ask: it offers a link only for a plan priced in shared/pricing.ts. */
export function billingOffers(cfg: BillingConfig | null): Record<PlanId, BillingPlanOffer> {
  const out = { ...NO_BILLING_OFFERS };
  if (!cfg) return out;
  for (const plan of PURCHASABLE_PLANS) {
    const intervals = intervalsOf(cfg, plan);
    if (intervals.length) out[plan] = { purchasable: true, intervals, href: billingStartHref(plan, intervals[0]) };
  }
  return out;
}
