// POST /webhook/stripe — Stripe's deliveries (docs/architecture/billing.md › The webhook). Dispatched in
// src/index.ts BEFORE the app: it has no session and never touches `sessionGate`. The signature IS the
// auth: `Stripe-Signature` over the raw body, against STRIPE_WEBHOOK_SECRET (./signature.ts).
//
//   • A delivery that fails its signature writes NOTHING and gets the SAME bare 401 whatever was wrong —
//     no header, a stale timestamp, a tampered body, the wrong secret, billing not configured at all.
//   • A verified event's id is recorded once (`billing_events`). One already handled is acknowledged and
//     does nothing; one whose handler failed is run again on Stripe's retry.
//   • A handler never trusts an event's ORDER or its copy of the subscription: it re-reads the
//     subscription from Stripe and converges on that (./sync.ts).
//   • A failure answers 500 with no detail, so Stripe retries; the log line carries the event's id and
//     type and a message already scrubbed of the key (./stripe.ts) — never the payload.
import type { Env } from "../env";
import { mailOrigin } from "../orgs/mail";
import { billingConfig } from "./config";
import { verifyStripeSignature } from "./signature";
import { claimEvent, finishEvent } from "./store";
import { billingContext, fulfilCheckout, readCheckoutSession, subscriptionIdOfEvent, syncSubscription } from "./sync";

export const STRIPE_WEBHOOK_PATH = "/webhook/stripe";
/** The events the endpoint is subscribed to in Stripe — the owner's checklist lists exactly these. */
export const STRIPE_EVENTS = [
  "checkout.session.completed", "checkout.session.async_payment_succeeded",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "invoice.paid", "invoice.payment_failed",
] as const;
/** Stripe's own limit on an event is far below this; anything larger is not one. */
const MAX_BODY_BYTES = 512 * 1024;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
/** The one refusal. */
const unauthorized = (): Response => json({ error: "unauthorized" }, 401);

export interface StripeWebhookDeps { fetchImpl?: typeof fetch; now?: () => number }

export async function handleStripeWebhook(request: Request, env: Env, deps: StripeWebhookDeps = {}): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return unauthorized();
  const rawBody = await request.text();
  const cfg = billingConfig(env);
  if (!cfg || rawBody.length > MAX_BODY_BYTES) return unauthorized();
  if (!(await verifyStripeSignature(cfg.webhookSecret, rawBody, request.headers.get("stripe-signature"), (deps.now ?? Date.now)()))) return unauthorized();

  let event: { id?: unknown; type?: unknown; livemode?: unknown; data?: { object?: unknown } | null };
  try { event = JSON.parse(rawBody) as typeof event; } catch { return json({ ok: true, ignored: "not_json" }); }
  const id = typeof event?.id === "string" ? event.id : null, type = typeof event?.type === "string" ? event.type : null;
  if (!id || !type) return json({ ok: true, ignored: "not_an_event" });
  // A test-mode event at a live deployment (or the reverse) is another account's business, not an error.
  if ((event.livemode === true) !== (cfg.mode === "live")) return json({ ok: true, ignored: "other_mode" });

  const p = billingContext(env);
  if ((await claimEvent(p, { id, type, livemode: event.livemode === true })) === "done") return json({ ok: true, replay: true });
  try {
    const outcome = await handle(env, type, event.data?.object, { fetchImpl: deps.fetchImpl, origin: mailOrigin(env, request.url) });
    await finishEvent(p, id, outcome);
    return json({ ok: true, outcome });
  } catch (e) {
    // The message only (a StripeError's is already scrubbed); never the Error object, never the payload.
    console.error("stripe webhook failed", type, id, e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : "unknown");
    return json({ error: "try_again" }, 500);
  }
}

async function handle(env: Env, type: string, object: unknown, opts: { fetchImpl?: typeof fetch; origin: string }): Promise<string> {
  const cfg = billingConfig(env)!;
  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    const session = readCheckoutSession(object);
    return session ? fulfilCheckout(env, cfg, session, opts) : "unreadable_session";
  }
  const subscription = subscriptionIdOfEvent(type, object);
  if (subscription) return syncSubscription(env, cfg, subscription, opts);
  return "ignored";
}
