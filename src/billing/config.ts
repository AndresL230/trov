// Billing's configuration, read from the Worker's environment in ONE place (docs/architecture/billing.md).
// Pure: no fetch, no D1 — anything may import it. The Stripe client (./stripe.ts) is the only reader of
// the key this hands out.
//
// Billing is CONFIGURED when both secrets are set: the key (to start a checkout) and the webhook secret
// (to hear that it was paid — without it a payment could be taken and never fulfilled, so a deployment
// with only a key sells nothing). A plan is PURCHASABLE on the intervals it has a price id for. No amount
// is known here: a price is an opaque id the owner pastes into wrangler.toml.
import type { Env } from "../env";
import {
  BILLING_INTERVALS, PURCHASABLE_PLANS, NO_BILLING_OFFERS, billingStartHref,
  type BillingInterval, type BillingPlanOffer, type PurchasablePlan,
} from "@shared/billing";
import type { PlanId } from "@shared/plans";

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
}

const set = (v: string | undefined): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** `STRIPE_TEST_API_BASE` when it is a loopback http origin, else null. */
function loopbackBase(v: string | undefined): string | null {
  const raw = set(v);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") ? u.origin : null;
  } catch {
    return null;
  }
}

/** The configuration, or null when billing is off (no key, or no webhook secret). */
export function billingConfig(env: Env): BillingConfig | null {
  const secretKey = set(env.STRIPE_SECRET_KEY), webhookSecret = set(env.STRIPE_WEBHOOK_SECRET);
  if (!secretKey || !webhookSecret) return null;
  const mode = /^(sk|rk)_live_/.test(secretKey) ? "live" : "test";
  const price = (month: string | undefined, year: string | undefined): Partial<Record<BillingInterval, string>> => {
    const m = set(month), y = set(year);
    return { ...(m ? { month: m } : {}), ...(y ? { year: y } : {}) };
  };
  return {
    secretKey, webhookSecret, mode,
    apiBase: (mode === "test" ? loopbackBase(env.STRIPE_TEST_API_BASE) : null) ?? STRIPE_API,
    prices: {
      personal: price(env.STRIPE_PRICE_PERSONAL, env.STRIPE_PRICE_PERSONAL_YEARLY),
      team: price(env.STRIPE_PRICE_TEAM, env.STRIPE_PRICE_TEAM_YEARLY),
    },
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
