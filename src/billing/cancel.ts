// Ending what Stripe would otherwise keep charging for, BEFORE anything is deleted (docs/architecture/billing.md
// › Deleting an organization or an account). The deletion core (src/deletion/) calls these and deletes nothing
// unless every one of them succeeded; a failure is a `StripeError`, already scrubbed (./stripe.ts).
//
//   • `cancelSubscriptionNow` — the subscription ends NOW: `DELETE /v1/subscriptions/<id>` with no
//     `prorate` and no `invoice_now`, Stripe's defaults, so nothing is credited or refunded for the period
//     already paid (the owner's policy: cancel any time, no refunds for a partial period — except where the
//     law requires, which is done by hand in the Stripe dashboard). The customer, its invoices and its
//     payment history stay in Stripe.
//   • `expireCheckoutNow` — an open Checkout Session for what is being deleted can no longer be paid
//     (`POST /v1/checkout/sessions/<id>/expire`), so nobody pays for an organization that is gone. A session
//     that was paid meanwhile answers its subscription, which the caller then cancels too.
//
// Both read Stripe's state first and again after a failed call: a cancel or an expiry that landed is one,
// whatever became of the answer. Nothing reachable from src/mcp.ts imports this (test/secrets.mcp.test.ts).
import type { BillingConfig } from "./config";
import { StripeError, stripeCall } from "./stripe";
import { fetchSubscription, readCheckoutSession, readSubscription, type SubscriptionState } from "./sync";

/** Stripe's words for a subscription that will never charge again. Anything else — `active`, `trialing`,
 *  `past_due`, `unpaid`, `paused`, `incomplete` — can still take money (or be paid back to life), so it is ended. */
const ENDED = new Set(["canceled", "incomplete_expired"]);
export const subscriptionEnded = (stripeStatus: string): boolean => ENDED.has(stripeStatus);

export type CancelOutcome = "canceled" | "already_ended" | "missing";

const missing = (e: unknown): boolean => e instanceof StripeError && e.kind === "http" && e.status === 404;

async function readSub(cfg: BillingConfig, id: string, fetchImpl?: typeof fetch): Promise<SubscriptionState | "missing"> {
  try {
    const sub = await fetchSubscription(cfg, id, fetchImpl);
    if (!sub) throw new StripeError("shape", 200, null, `stripe GET /v1/subscriptions/${id}: not a subscription`);
    return sub;
  } catch (e) {
    // Stripe has no such subscription in this account and mode: there is nothing it could charge.
    if (missing(e)) return "missing";
    throw e;
  }
}

/** End `id` now. Resolves only when Stripe says it has ended (or never existed); otherwise throws. */
export async function cancelSubscriptionNow(cfg: BillingConfig, id: string, fetchImpl?: typeof fetch): Promise<CancelOutcome> {
  const before = await readSub(cfg, id, fetchImpl);
  if (before === "missing") return "missing";
  if (subscriptionEnded(before.status)) return "already_ended";
  let failure: unknown = null;
  try {
    const after = readSubscription(await stripeCall(cfg, "DELETE", `/v1/subscriptions/${encodeURIComponent(id)}`, {}, { fetchImpl }));
    if (after && subscriptionEnded(after.status)) return "canceled";
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    failure = e;
  }
  // The answer was lost or said something else: ask again. A cancel that landed is a cancel.
  const again = await readSub(cfg, id, fetchImpl);
  if (again === "missing" || subscriptionEnded(again.status)) return "canceled";
  throw failure ?? new StripeError("shape", 0, null, `stripe DELETE /v1/subscriptions/${id}: the subscription is still ${again.status}`);
}

/** Close an open Checkout Session. `subscription` is set when it had already been PAID: the caller cancels it. */
export async function expireCheckoutNow(cfg: BillingConfig, sessionId: string, fetchImpl?: typeof fetch): Promise<{ subscription: string | null }> {
  const path = `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`;
  const read = async () => {
    try {
      return readCheckoutSession(await stripeCall(cfg, "GET", path, {}, { fetchImpl }));
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  };
  const settled = (s: NonNullable<Awaited<ReturnType<typeof read>>>): { subscription: string | null } | null =>
    s.status === "expired" ? { subscription: null } : s.status === "complete" ? { subscription: s.subscription } : null;
  const before = await read();
  if (!before) return { subscription: null };
  const done = settled(before);
  if (done) return done;
  let failure: unknown = null;
  try {
    await stripeCall(cfg, "POST", `${path}/expire`, {}, { fetchImpl, idempotencyKey: `trov-expire-${sessionId}` });
    return { subscription: null };
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    failure = e;
  }
  const again = await read();
  const now = again ? settled(again) : { subscription: null };
  if (now) return now;
  throw failure;
}
