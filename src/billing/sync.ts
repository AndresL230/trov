// Stripe → Trov (docs/architecture/billing.md › Events). Two entry points, both IDEMPOTENT and both
// CONVERGENT — each reads the subscription's CURRENT state from Stripe and makes Trov match it, so the
// order events arrive in, a delivery repeated, and the waiting room's fallback racing the webhook all end
// in the same rows:
//
//   • `fulfilCheckout`   a Checkout Session Trov started was paid → the buyer's GRANT (the same grant a
//                        superadmin gives by hand), or — for a renewal — the org's plan.
//   • `syncSubscription` anything else about a subscription (renewed, failed, paid again, plan switched,
//                        cancelled, ended) → the org's plan, status and period; or, while the grant is
//                        still unused, the grant itself.
//
// An org's plan is only ever changed through the seam (src/plans/billing.ts). Trov computes no amount,
// tax or proration: it stores ids and a status, and Stripe is the record of everything else.
import type { Env } from "../env";
import { platform, type PlatformContext } from "../data/context";
import { planDef, type PlanId, type PlanStatus } from "@shared/plans";
import type { BillingInterval } from "@shared/billing";
import {
  BILLING_ACTOR, GrantError, grantOrganization, getGrant, revokeGrant, setPaidGrantPlan,
  setOrgPlan, setOrgPlanStatus, markOrgPastDue, cancelOrgPlan, orgPlan,
} from "../plans/billing";
import { sendGrantNotice } from "../notifications/grant";
import { welcomeRecipient } from "../orgs/repo";
import { planOfPrice, type BillingConfig } from "./config";
import { stripeCall } from "./stripe";
import {
  checkoutBySession, completeCheckout, getSubscription, grantOfSubscription, orgById, orgOfSubscription, putSubscription,
  type BilledOrg, type CheckoutRow,
} from "./store";

export interface SyncOpts { fetchImpl?: typeof fetch; /** The absolute origin for the notice's one link; omitted = no notice. */ origin?: string }

/** The context every billing write is made in: no person, no session — `granted_by` / `plan_changed_by` read `billing`. */
export const billingContext = (env: Env): PlatformContext => platform(env, BILLING_ACTOR);

// ── reading Stripe's objects ─────────────────────────────────────────────────
// Only the fields Trov uses, read defensively: a field that moved between API versions is looked for in
// both places (the client pins a version, but an EVENT's payload is shaped by the endpoint's own).

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
/** An id, whether Stripe sent the id or the expanded object. */
const idOf = (v: unknown): string | null => str(v) ?? str(obj(v)?.id);
const isoOf = (seconds: unknown): string | null => (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null);

/** Stripe's status word → the three Trov knows. `past_due` is the grace period (Stripe is retrying);
 *  everything that means "nobody is paying for this any more" is `canceled`. */
export function planStatusOf(stripeStatus: string): PlanStatus {
  switch (stripeStatus) {
    case "active": case "trialing": return "active";
    case "past_due": case "incomplete": return "past_due";
    default: return "canceled"; // canceled, unpaid, incomplete_expired, paused — and any word Stripe adds later (fail closed)
  }
}

export interface SubscriptionState {
  id: string; customer: string; status: string; priceId: string | null; periodEnd: string | null;
  cancelAtPeriodEnd: boolean; livemode: boolean; itemId: string | null;
}

export function readSubscription(json: unknown): SubscriptionState | null {
  const s = obj(json);
  const id = str(s?.id), customer = idOf(s?.customer), status = str(s?.status);
  if (!s || !id || !customer || !status) return null;
  const item = obj((obj(s.items)?.data as unknown[] | undefined)?.[0]);
  return {
    id, customer, status, priceId: idOf(item?.price), itemId: str(item?.id),
    periodEnd: isoOf(s.current_period_end) ?? isoOf(item?.current_period_end),
    // A cancellation scheduled for a date (`cancel_at`) ends the plan just as surely as the checkbox.
    cancelAtPeriodEnd: s.cancel_at_period_end === true || (typeof s.cancel_at === "number" && status !== "canceled"),
    livemode: s.livemode === true,
  };
}

export async function fetchSubscription(cfg: BillingConfig, id: string, fetchImpl?: typeof fetch): Promise<SubscriptionState | null> {
  return readSubscription(await stripeCall<Json>(cfg, "GET", `/v1/subscriptions/${encodeURIComponent(id)}`, {}, { fetchImpl }));
}

/** The subscription an event's object is about: the object itself, or the invoice's (both API shapes). */
export function subscriptionIdOfEvent(type: string, object: unknown): string | null {
  const o = obj(object);
  if (!o) return null;
  if (type.startsWith("customer.subscription.")) return str(o.id);
  if (type.startsWith("invoice.")) return idOf(o.subscription) ?? idOf(obj(obj(o.parent)?.subscription_details)?.subscription);
  return null;
}

// ── a subscription's state → Trov ────────────────────────────────────────────

/**
 * Make Trov match `sub`. `buyer` names the person on first sight (fulfilment); without one, a
 * subscription Trov has no row for is not Trov's and is left alone. Returns one word for the ledger.
 */
export async function applySubscription(p: PlatformContext, cfg: BillingConfig, sub: SubscriptionState, buyer: string | null = null): Promise<string> {
  const held = await getSubscription(p, sub.id);
  if (!held && !buyer) return "unknown_subscription";
  const priced = planOfPrice(cfg, sub.priceId);
  // A price Trov does not sell (changed by hand in Stripe): keep the plan it was on; status and period still follow.
  const plan: PlanId | null = priced?.plan ?? (held ? planDef(held.plan).id : null);
  if (!plan) return "unknown_price";
  const interval: BillingInterval | null = priced?.interval ?? (held?.interval === "month" || held?.interval === "year" ? held.interval : null);
  const status = planStatusOf(sub.status);
  await putSubscription(p, {
    subscription_id: sub.id, customer_id: sub.customer, person: buyer, plan, price_id: sub.priceId, interval,
    stripe_status: sub.status, plan_status: status, period_end: sub.periodEnd, cancel_at_period_end: sub.cancelAtPeriodEnd, livemode: sub.livemode,
  });

  const org = await orgOfSubscription(p, sub.id);
  if (org) return applyToOrg(p, org, sub, plan, status, held?.plan_pinned === 1);

  // No org yet: the grant, while it waits to be used, follows the subscription.
  const grant = await grantOfSubscription(p, sub.id);
  if (!grant || grant.status !== "unused") return grant ? `grant_${grant.status}` : "no_org";
  if (status === "canceled") {
    // Cancelled before the buyer named an organization: there is nothing left to set one up on.
    await revokeGrant(p, grant.id).catch((e) => { if (!(e instanceof GrantError)) throw e; });
    return "grant_revoked";
  }
  return (await setPaidGrantPlan(p, sub.id, plan)) ? "grant_plan" : "grant_waiting";
}

/** The org's plan, status and period, through the seam — and only what differs, so a replay writes nothing. */
async function applyToOrg(p: PlatformContext, org: BilledOrg, sub: SubscriptionState, plan: PlanId, status: PlanStatus, pinned: boolean): Promise<string> {
  // A superadmin took the org back (Change plan on an ended subscription → `granted`): billing no longer moves it.
  if (org.plan_source !== "billing") return "org_not_billing";
  const now = await orgPlan(p, org.id);
  const want = pinned ? now.plan : plan; // pinned: the superadmin's plan stands; status and period still follow
  if (now.plan !== want || now.customer_id !== sub.customer) {
    await setOrgPlan(p, org.slug, { plan: want, source: "billing", status, period_end: sub.periodEnd, customer_id: sub.customer, subscription_id: sub.id });
    return now.plan !== want ? "org_plan" : "org_linked";
  }
  if (now.status !== status || now.period_end !== sub.periodEnd) {
    if (now.period_end !== sub.periodEnd) await setOrgPlanStatus(p, org.slug, status, { period_end: sub.periodEnd });
    else if (status === "past_due") await markOrgPastDue(p, org.slug);
    else if (status === "canceled") await cancelOrgPlan(p, org.slug);
    else await setOrgPlanStatus(p, org.slug, "active");
    return now.status !== status ? `org_${status}` : "org_period";
  }
  return "unchanged";
}

/** Re-read one subscription from Stripe and apply it. */
export async function syncSubscription(env: Env, cfg: BillingConfig, subscriptionId: string, opts: SyncOpts = {}): Promise<string> {
  const p = billingContext(env);
  // Not Trov's (no checkout of ours led to it): do not spend a Stripe call on it.
  if (!(await getSubscription(p, subscriptionId))) return "unknown_subscription";
  const sub = await fetchSubscription(cfg, subscriptionId, opts.fetchImpl);
  return sub ? applySubscription(p, cfg, sub) : "unreadable_subscription";
}

// ── a paid checkout → the grant ──────────────────────────────────────────────

export interface CheckoutSession {
  id: string; status: string | null; paymentStatus: string | null; mode: string | null;
  subscription: string | null; customer: string | null; ref: string | null;
}
export function readCheckoutSession(json: unknown): CheckoutSession | null {
  const s = obj(json);
  const id = str(s?.id);
  if (!s || !id) return null;
  return {
    id, status: str(s.status), paymentStatus: str(s.payment_status), mode: str(s.mode),
    subscription: idOf(s.subscription), customer: idOf(s.customer), ref: str(obj(s.metadata)?.trov_ref),
  };
}
/** Stripe took the payment (or none was due: a trial, a 100% coupon). */
export const sessionPaid = (s: CheckoutSession): boolean =>
  s.status === "complete" && (s.paymentStatus === "paid" || s.paymentStatus === "no_payment_required");

/**
 * A Checkout Session was paid. Called by the webhook (`checkout.session.completed`) AND by the waiting
 * room's fallback, with the same session — both land on ONE grant, because the grant is idempotent on
 * the subscription id (`org_grants.external_ref`).
 *
 * WHO gets it is read from Trov's own row for the session (`billing_checkouts`, written when the
 * checkout was created by a signed-in person) — never from whoever presents the session id, and never
 * from a field of the payload alone: a session Trov did not create, or whose reference does not match
 * the row, grants nothing.
 */
export async function fulfilCheckout(env: Env, cfg: BillingConfig, session: CheckoutSession, opts: SyncOpts = {}): Promise<string> {
  const p = billingContext(env);
  const row = await checkoutBySession(p, session.id);
  if (!row) return "unknown_checkout";
  if (session.ref !== row.ref) return "ref_mismatch";
  if (session.mode !== "subscription" || !session.subscription) return "not_a_subscription";
  if (!sessionPaid(session)) return "not_paid";
  const sub = await fetchSubscription(cfg, session.subscription, opts.fetchImpl);
  if (!sub) return "unreadable_subscription";
  await completeCheckout(p, row.ref, sub.id);
  return row.for_org ? renewOrg(p, cfg, row, sub) : grantBuyer(env, p, cfg, row, sub, opts);
}

async function grantBuyer(env: Env, p: PlatformContext, cfg: BillingConfig, row: CheckoutRow, sub: SubscriptionState, opts: SyncOpts): Promise<string> {
  const plan = planOfPrice(cfg, sub.priceId)?.plan ?? planDef(row.plan).id;
  // Ended before fulfilment ran (an immediate cancel, events out of order): record it, grant nothing.
  if (planStatusOf(sub.status) === "canceled") return applySubscription(p, cfg, sub, row.person);
  let grant;
  try {
    grant = await grantOrganization(env, p, { to: { handle: row.person }, plan, external_ref: sub.id, note: "Paid through Stripe" });
  } catch (e) {
    // The buyer's account is gone, or has become a superadmin: there is nobody to grant. Stripe keeps the payment; refund by hand.
    if (e instanceof GrantError) { await applySubscription(p, cfg, sub, row.person); return `grant_refused_${e.code}`; }
    throw e;
  }
  const outcome = await applySubscription(p, cfg, sub, row.person);
  // Trov's own notice — to the buyer's provider-VERIFIED address only (never one typed at checkout), once.
  if (opts.origin && grant.status === "unused" && grant.mail_status === null) {
    const to = await welcomeRecipient(p, row.person).catch(() => null);
    const fresh = to ? await getGrant(p, grant.id) : null;
    if (to && fresh?.mail_status === null) {
      const def = planDef(plan);
      await sendGrantNotice(env, p, { grantId: grant.id, email: to.email, granterHandle: null, planName: def.name, planDescription: def.description, origin: opts.origin, fetchImpl: opts.fetchImpl, paid: true });
    }
  }
  return grant.status === "unused" ? "granted" : outcome;
}

/** A canceled org's owner paid again: a NEW subscription for the SAME org — no grant. */
async function renewOrg(p: PlatformContext, cfg: BillingConfig, row: CheckoutRow, sub: SubscriptionState): Promise<string> {
  const org = row.for_org ? await orgById(p, row.for_org) : null;
  if (!org) return "org_gone";
  const plan = planOfPrice(cfg, sub.priceId)?.plan ?? planDef(row.plan).id;
  const before = await orgPlan(p, org.id);
  const outcome = await applySubscription(p, cfg, sub, row.person); // the mirror row — and, on a replay, the org it already pays for
  if (before.subscription_id === sub.id && before.source === "billing") return outcome;
  await setOrgPlan(p, org.slug, { plan, source: "billing", status: planStatusOf(sub.status), period_end: sub.periodEnd, customer_id: sub.customer, subscription_id: sub.id });
  return "org_renewed";
}
