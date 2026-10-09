// Billing on the wire (docs/architecture/billing.md): what the Worker, the SPA and the pricing page agree
// on. Zod-free and dependency-free, like shared/plans.ts. NO PRICES live here or anywhere in Trov: an
// amount is Stripe's, shown at Stripe's checkout — Trov knows a price only as an id in `wrangler.toml`.
import { PLANS, type PlanId, type PlanOverrides, type PlanStatus } from "./plans";
import { PLATFORM_FROM_ADDRESS } from "./sender";

/** The plans a person can buy themselves: Pro (id `team`), PER SEAT. Free costs nothing and is never
 *  bought; Enterprise is arranged with Trov; Personal is no longer sold (shared/plans.ts). */
export const PURCHASABLE_PLANS = ["team"] as const;
export type PurchasablePlan = (typeof PURCHASABLE_PLANS)[number];
export const isPurchasablePlan = (v: unknown): v is PurchasablePlan => typeof v === "string" && (PURCHASABLE_PLANS as readonly string[]).includes(v);

/**
 * Pro is bought PER SEAT: the seats a subscription pays for ARE the org's seat cap — its `seats` override —
 * up to the plan's own cap (shared/plans.ts: Pro's 50, which is also checkout's maximum). A plan not sold
 * here, or a quantity Stripe did not send, overrides nothing.
 */
export function paidSeats(plan: PlanId, quantity: number | null): PlanOverrides {
  if (!isPurchasablePlan(plan) || quantity === null) return {};
  const cap = PLANS[plan].entitlements.seats;
  return { seats: Math.max(1, cap === null ? quantity : Math.min(quantity, cap)) };
}

export const BILLING_INTERVALS = ["month", "year"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];
export const isBillingInterval = (v: unknown): v is BillingInterval => typeof v === "string" && (BILLING_INTERVALS as readonly string[]).includes(v);

// ── the human-facing paths ───────────────────────────────────────────────────

/** Where a "Choose <plan>" button points: a plain link, signed in or not (GET, top-level navigation).
 *  THE one builder of that link — the pricing page's `purchaseHref` (shared/pricing.ts) calls it. */
export const BILLING_START_PATH = "/billing/start";
export const billingStartHref = (plan: PurchasablePlan, interval: BillingInterval = "month"): string =>
  `${BILLING_START_PATH}?plan=${plan}${interval === "month" ? "" : `&interval=${interval}`}`;
/** The purchase link with the sign-in provider already picked: the billing route seals the return and goes
 *  straight on to that provider (src/billing/routes.ts) — what the Get started dialog's Pro buttons use. */
export const billingViaHref = (plan: PurchasablePlan, via: "github" | "google", interval: BillingInterval = "month"): string =>
  `${billingStartHref(plan, interval)}&via=${via}`;
/** Where a signed-out buyer with NO provider picked is sent: the app's landing page, which opens its Get
 *  started dialog on this plan (`START_PARAM`; web/src/main.ts). */
export const START_PARAM = "start";
export const START_INTERVAL_PARAM = "interval";
export const billingAskHref = (plan: PurchasablePlan, interval: BillingInterval = "month"): string =>
  `/?${START_PARAM}=${plan}${interval === "month" ? "" : `&${START_INTERVAL_PARAM}=${interval}`}`;
/** Where Stripe sends the buyer back: the waiting room (`?session_id=…`). */
export const BILLING_DONE_PATH = "/billing/done";
/** Where a person who backs out of checkout lands, and where "see the plans" points: the public pricing
 *  page (web/pricing.html, a Vite input; test/render.pricing.test.ts holds the two together). */
export const PRICING_PATH = "/pricing";
/** An organization's Plan block (Org settings › General) — where its owner manages billing. */
export const orgBillingHref = (slug: string): string => `/${encodeURIComponent(slug)}/#org/general`;
/** Enterprise, and anything billing cannot do: write to Trov. */
export const BILLING_CONTACT = `mailto:${PLATFORM_FROM_ADDRESS}`;

/** `granted_by` of a grant a PAYMENT made (src/plans/billing.ts `BILLING_ACTOR`): not a person's handle. */
export const BILLING_GRANTER = "billing";

/** The one refusal of every billing route while Stripe is not set up (HTTP 503). */
export const BILLING_UNAVAILABLE = "billing_unavailable";
export const BILLING_UNAVAILABLE_MESSAGE = "Paid plans are not available yet.";

// ── GET /api/billing/config (public) ─────────────────────────────────────────

export interface BillingPlanOffer {
  /** A person can buy this plan now: Stripe is set up AND the plan has a price for at least one interval. */
  purchasable: boolean;
  /** The intervals it can be bought on. Empty when not purchasable. */
  intervals: BillingInterval[];
  /** The link for it (the first interval's), or null. */
  href: string | null;
}
/** An organization the signed-in person OWNS that pays through Stripe — where "Manage billing" goes. */
export interface BillingManagedOrg { slug: string; name: string; plan: PlanId; status: PlanStatus; href: string }

export interface BillingConfigResponse {
  /** Stripe is set up at all (a key and a webhook secret). False → every purchase link is off. */
  available: boolean;
  /** Which Stripe mode the deployment's key is in; null when not set up. */
  mode: "test" | "live" | null;
  plans: Record<PlanId, BillingPlanOffer>;
  /** Where "Contact us" points (Enterprise). */
  contact: string;
  signed_in: boolean;
  /** Signed in only: the caller's paid organizations (oldest first). Non-empty → the likelier intent of a
   *  plan button is "Manage billing" for `manage[0]`, with buying another organization the secondary link. */
  manage: BillingManagedOrg[];
}

/** No plan purchasable: what a page shows before it has asked, and what the route answers when unset. */
const NONE: BillingPlanOffer = { purchasable: false, intervals: [], href: null };
export const NO_BILLING_OFFERS: Record<PlanId, BillingPlanOffer> = { free: NONE, personal: NONE, team: NONE, enterprise: NONE };

// ── GET /api/billing/status?session_id=… (the waiting room's poll) ───────────

export type BillingStatusResponse =
  /** Not there yet: keep asking. `paid` = Stripe has confirmed the payment (so say "received", not "waiting"). */
  | { state: "pending"; paid: boolean }
  /** The grant exists: the buyer names their organization. */
  | { state: "ready"; plan: PlanId; grant: number }
  /** Nothing left to do here: the grant was used (`org` = the organization it became), or the payment was a renewal of `org`. */
  | { state: "done"; org: { slug: string; name: string } }
  /** The checkout was abandoned or expired unpaid. Never said about a payment Stripe took. */
  | { state: "unpaid" }
  /** The subscription was cancelled before an organization was set up on it: there is nothing to set up. */
  | { state: "ended" };

// ── an org's billing, as its members read it (on OrgPlanView) ────────────────

/** Present for an org that pays (or paid) through Stripe, and for every org on Free (it can upgrade); a
 *  granted org on another plan has none and shows nothing about payment. */
export interface OrgBillingView {
  /** Stripe is set up on this deployment (the buttons work). */
  available: boolean;
  /** The org pays through a LIVE subscription (active, past due, or cancelling). False: a Free org that never
   *  paid, or whose subscription ended (`ended`). */
  subscribed: boolean;
  /** The org's subscription ended, so it moved to Free (billing.md › What each state does). */
  ended: boolean;
  /** The org has a Stripe customer: "Manage billing" opens its card and invoices (also once it ended). */
  customer: boolean;
  interval: BillingInterval | null;
  /** The seats the live subscription pays for — Pro is per seat, and this is the org's seat cap. Null otherwise. */
  seats: number | null;
  /** The owner cancelled: the plan runs to `period_end` and then the org moves to Free. */
  cancel_at_period_end: boolean;
  /** Trov set this org's plan by hand: it no longer follows the subscription's. */
  pinned: boolean;
  /** The plans the org can START a subscription on — a Free org's upgrade (`POST …/billing/upgrade`), and
   *  what a GIFTED org's owner pays for to keep a plan past the gift's end. */
  upgrade_to: PurchasablePlan[];
  /** The org's plan is a gift from Trov (`OrgPlanView.gift_until`), not a subscription: nothing is paid yet. */
  gifted?: boolean;
}

// ── Platform (superadmin) ────────────────────────────────────────────────────

export interface PlatformOrgBilling {
  customer_id: string;
  subscription_id: string;
  /** Stripe's own status word. */
  stripe_status: string;
  /** The plan the SUBSCRIPTION pays for (the org's own plan differs when `pinned`). */
  plan: PlanId;
  /** The subscription has ended (Stripe's status is a final one): the org moved to Free. */
  ended: boolean;
  /** The seats the subscription pays for (its quantity); null when not known. */
  seats: number | null;
  interval: BillingInterval | null;
  period_end: string | null;
  cancel_at_period_end: boolean;
  pinned: boolean;
  livemode: boolean;
  /** The customer in the Stripe dashboard (test or live, by `livemode`). */
  dashboard_url: string;
}

/** The Stripe dashboard page of a customer. Built from the id alone; no API call, no key. */
export function stripeCustomerUrl(customerId: string, livemode: boolean): string {
  return `https://dashboard.stripe.com/${livemode ? "" : "test/"}customers/${encodeURIComponent(customerId)}`;
}

/** Has this instant passed? A subscription cancelled at once ends BEFORE its paid period's end, so an
 *  ended plan may only be given that date when it really is behind us. */
export const isPast = (iso: string | null | undefined, now: number = Date.now()): boolean => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t <= now;
};

/** "12 March 2027" from an ISO instant (UTC), or "" for none — one format for every billing date. */
export function billingDate(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
