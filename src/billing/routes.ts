// Billing's routes (docs/architecture/billing.md › Routes). Two sub-apps, mounted in src/routes.ts:
//
//   `billingApp` — person-level, at `/`:
//     GET  /billing/start?plan=team[&interval=month|year]            PUBLIC, a link: signed out → sign in and
//                                                                    come back; signed in → Stripe Checkout
//     GET  /api/billing/config                                       PUBLIC: what can be bought on this deployment
//     GET  /api/billing/status?session_id=…                          session: the waiting room's poll
//   `orgBillingApp` — an org's, at `/api/o/:slug` (behind `tenantGate`), cookie only, OWNER only:
//     POST /billing/portal     the Stripe Customer Portal for this org's customer      → { url }
//                              (`{ seats: true }`: straight to changing the seat count — "Add a seat")
//     POST /billing/upgrade    a Free org buys Pro: a new subscription, same org       → { url }
//
// Pro is sold PER SEAT. A checkout's quantity starts at the seats the org uses now — members plus pending
// invitations, at least 1 (a buyer with no org yet: 1) — and the buyer can change it on Stripe's page,
// up to Pro's seat cap. What is paid for becomes the org's seat cap when the webhook lands (./sync.ts).
//
// While Stripe is not set up, every one of them answers 503 `billing_unavailable` (the link: a page that
// says so) and nothing else in the app changes. A payment is never fulfilled here: the browser coming
// back proves nothing — the webhook does it (./webhook.ts), and the status route's look at Stripe calls
// the SAME idempotent fulfilment for the case a delivery is late.
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv, Principal } from "../auth/principal";
import { resolveSessionPrincipal } from "../auth/principal";
import { randomToken } from "../auth/crypto";
import { PAGE_CSP } from "../auth/oauth-routes";
import { setReturnTo } from "../auth/return-to";
import { hasRole, isSuperadmin } from "../data/context";
import type { PlatformContext } from "../data/platform-sql";
import { cookieOnly } from "../orgs/routes";
import { mailOrigin } from "../orgs/mail";
import { welcomeRecipient } from "../orgs/repo";
import { takeLimit } from "../platform/limits";
import { orgPlan, type OrgPlan } from "../plans/billing";
import { seatCounts } from "../plans/state";
import { FREE_PLAN, PLANS, UPGRADE_PLAN, type PlanId } from "@shared/plans";
import {
  BILLING_CONTACT, BILLING_DONE_PATH, BILLING_UNAVAILABLE, BILLING_UNAVAILABLE_MESSAGE, PRICING_PATH,
  billingAskHref, billingCheckoutHref, billingStartHref, isBillingInterval, isPurchasablePlan, orgBillingHref,
  type BillingCheckoutResponse, type BillingConfigResponse, type BillingInterval, type BillingStatusResponse, type PurchasablePlan,
} from "@shared/billing";
import { billingConfig, billingOffers, intervalsOf, priceFor, type BillingConfig } from "./config";
import { StripeError, stripeCall } from "./stripe";
import {
  checkoutBySession, createCheckout, dropCheckout, grantOfSubscription, managedOrgs, orgById, setCheckoutSession, takeCheckoutLook,
  type CheckoutRow,
} from "./store";
import { fulfilCheckout, readCheckoutSession, sessionPaid } from "./sync";
import { enterprisePage, rateLimitedPage, stripeFailedPage, superadminPage, unavailablePage } from "./pages";

/** The waiting room may make Trov look at Stripe for one session at most this often. */
const STATUS_LOOK_MS = 5_000;

const unavailable = (c: Context<AppEnv>) => c.json({ error: BILLING_UNAVAILABLE, message: BILLING_UNAVAILABLE_MESSAGE }, 503);
const page = (c: Context<AppEnv>, html: string, status: 200 | 400 | 403 | 429 | 502 | 503) =>
  c.html(html, status, { "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": PAGE_CSP });
/** The origin Stripe sends the person back to: the request's own (https everywhere but local dev). */
function returnOrigin(reqUrl: string): string {
  const u = new URL(reqUrl);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  return `${local ? u.protocol : "https:"}//${u.host}`;
}
/** The session of a PUBLIC route, read by hand (`sessionGate` lets the path through). */
const caller = async (c: Context<AppEnv>): Promise<Principal | null> => (c.env.DEV_LOGIN ? { handle: c.env.DEV_LOGIN } : resolveSessionPrincipal(c));
/** Where Stripe may send a browser: https (Stripe's own pages), or the loopback stand-in of a test. */
const redirectable = (cfg: BillingConfig, url: unknown): url is string => {
  if (typeof url !== "string") return false;
  try { const u = new URL(url); return u.protocol === "https:" || u.origin === cfg.apiBase; } catch { return false; }
};
const logStripe = (what: string, e: unknown): void =>
  console.error(what, e instanceof StripeError ? `${e.kind} ${e.status} ${e.message}` : e instanceof Error ? e.name : "unknown");

/** The most seats one checkout sells: the plan's own seat cap (Pro's 50). */
const maxSeats = (plan: PurchasablePlan): number => PLANS[plan].entitlements.seats ?? 9999;
/** The seats a checkout starts at: what `orgId` uses now — members plus pending invitations — at least 1
 *  and at most the plan's cap. No org yet (a first purchase): 1. */
async function seatQuantity(p: PlatformContext, plan: PurchasablePlan, orgId: string | null): Promise<number> {
  const n = orgId ? await seatCounts(p, orgId) : { members: 0, pending: 0 };
  return Math.min(maxSeats(plan), Math.max(1, n.members + n.pending));
}

// ── starting a checkout ──────────────────────────────────────────────────────

class CheckoutRefused extends Error { constructor(readonly why: "rate_limited" | "stripe", readonly retryAfter = 0) { super(why); } }

interface CheckoutAsk { person: string; plan: PurchasablePlan; interval: BillingInterval; price: string; forOrg?: { id: string; slug: string; customer: string | null } }
/** A session Stripe made: its page on Stripe (hosted), or the secret Trov's own page mounts it with (embedded). */
type StartedCheckout = { ui: "hosted"; url: string } | { ui: "embedded"; clientSecret: string; sessionId: string };

/**
 * Create a Checkout Session for `person`: HOSTED (Stripe's URL) or EMBEDDED (the session's client secret,
 * for Trov's own payment page). Which one is `cfg.embedded` — the one decision — unless the caller asks
 * for hosted outright (the payment page's fallback when Stripe.js would not load). The two differ ONLY in
 * where the buyer is while paying: an embedded session takes `ui_mode` + `return_url` where a hosted one
 * takes `success_url` + `cancel_url` (Stripe refuses those in embedded mode); everything else is the same.
 * The row that binds the session to the person is written BEFORE Stripe is asked (its `ref` is the
 * idempotency key and travels in the session's metadata), so a webhook can never arrive for a session
 * Trov has no row for.
 *
 * The client secret is returned to the caller and goes nowhere else: not a log line, not a D1 column.
 */
async function startCheckout(c: Context<AppEnv>, cfg: BillingConfig, o: CheckoutAsk, want: { hosted?: boolean } = {}): Promise<StartedCheckout> {
  const p = c.var.p;
  const embedded = cfg.embedded && !want.hosted;
  // Per person per day (docs/architecture/abuse-limits.md): each one is a Stripe object and a row here.
  const retryAfter = await takeLimit(p, o.person, "checkout");
  if (retryAfter !== null) throw new CheckoutRefused("rate_limited", retryAfter);
  const ref = randomToken(18);
  const quantity = await seatQuantity(p, o.plan, o.forOrg?.id ?? null);
  await createCheckout(p, { ref, person: o.person, plan: o.plan, interval: o.interval, forOrg: o.forOrg?.id ?? null });
  const origin = returnOrigin(c.req.url);
  // The receipt goes where Stripe sends it; Trov only ever SUGGESTS the person's provider-verified address.
  const email = o.forOrg?.customer ? null : (await welcomeRecipient(p, o.person).catch(() => null))?.email ?? null;
  const metadata = { trov_ref: ref, trov_plan: o.plan, trov_person: o.person, ...(o.forOrg ? { trov_org: o.forOrg.slug } : {}) };
  try {
    const done = `${origin}${BILLING_DONE_PATH}?session_id={CHECKOUT_SESSION_ID}`;
    const session = await stripeCall<{ id?: unknown; url?: unknown; client_secret?: unknown }>(cfg, "POST", "/v1/checkout/sessions", {
      mode: "subscription",
      // Per seat: the price is one seat's; the buyer can change the count on Stripe's page.
      line_items: [{ price: o.price, quantity, adjustable_quantity: { enabled: true, minimum: 1, maximum: maxSeats(o.plan) } }],
      client_reference_id: o.person,
      ...(o.forOrg?.customer ? { customer: o.forOrg.customer } : email ? { customer_email: email } : {}),
      // Either way Stripe sends the buyer to the SAME waiting room when the payment is made. An embedded
      // session has no cancel URL: backing out is the payment page's own Back link.
      ...(embedded
        ? { ui_mode: "embedded", return_url: done }
        : { success_url: done, cancel_url: o.forOrg ? `${origin}${orgBillingHref(o.forOrg.slug)}` : `${origin}${PRICING_PATH}` }),
      metadata,
      subscription_data: { metadata },
      // Tax is Stripe's to work out (`STRIPE_TAX`): the subscription keeps `automatic_tax`, so every later
      // invoice — a renewal, a seat change — is taxed by the same rule with nothing more from Trov. Stripe
      // asks for the billing address it needs; a customer it already knows must be allowed to save the one
      // entered (and the name a tax id goes with), or Stripe refuses the session.
      ...(cfg.tax ? {
        automatic_tax: { enabled: true },
        tax_id_collection: { enabled: true },
        ...(o.forOrg?.customer ? { customer_update: { address: "auto", name: "auto" } } : {}),
      } : {}),
    }, { idempotencyKey: `trov-checkout-${ref}` });
    if (typeof session.id !== "string") throw new StripeError("shape", 200, null, "stripe POST /v1/checkout/sessions: no session id");
    if (embedded) {
      if (!isClientSecret(session.client_secret)) throw new StripeError("shape", 200, null, "stripe POST /v1/checkout/sessions: no client secret");
      await setCheckoutSession(p, ref, session.id);
      return { ui: "embedded", clientSecret: session.client_secret, sessionId: session.id };
    }
    if (!redirectable(cfg, session.url)) throw new StripeError("shape", 200, null, "stripe POST /v1/checkout/sessions: no session url");
    await setCheckoutSession(p, ref, session.id);
    return { ui: "hosted", url: session.url };
  } catch (e) {
    await dropCheckout(p, ref).catch(() => undefined);
    logStripe("billing checkout failed", e);
    throw new CheckoutRefused("stripe");
  }
}

// ── the payment page's call (embedded checkout) ──────────────────────────────

const SESSION_ID = /^cs_[A-Za-z0-9_]{1,200}$/;
/** A Checkout Session's client secret, as far as Trov reads it: Stripe's own opaque string. */
const isClientSecret = (v: unknown): v is string => typeof v === "string" && v.startsWith("cs_") && v.length <= 2000;
const NO_STORE = { "cache-control": "no-store" };

/**
 * The session the payment page says it already showed (a reload; Back from the confirmation). Only the
 * caller's OWN session for the same purchase is looked at — anyone else's id, or an unknown one, is null
 * and the page simply gets a new session, so a session id teaches nothing here either. Paid → `complete`
 * (the page goes to the waiting room: it must never offer a second payment for the same purchase);
 * expired → `expired`; still open and embedded → the SAME session's client secret again, with no new
 * Stripe object and no unit of the `checkout` limit. Throws the Stripe failure: with the session's state
 * unknown, starting another could charge twice.
 */
async function resumeCheckout(c: Context<AppEnv>, cfg: BillingConfig, o: CheckoutAsk, sessionId: string): Promise<BillingCheckoutResponse | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const row = await checkoutBySession(c.var.p, sessionId);
  if (!row || row.person.toLowerCase() !== o.person.toLowerCase() || row.plan !== o.plan || (row.for_org ?? null) !== (o.forOrg?.id ?? null)) return null;
  if (row.subscription_id) return { ui: "complete", session_id: sessionId };
  let s: { status?: unknown; ui_mode?: unknown; client_secret?: unknown };
  try {
    s = await stripeCall(cfg, "GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  } catch (e) {
    logStripe("billing checkout resume failed", e);
    throw new CheckoutRefused("stripe");
  }
  if (s.status === "complete") return { ui: "complete", session_id: sessionId };
  if (s.status === "expired") return { ui: "expired" };
  if (cfg.embedded && cfg.publishableKey && row.interval === o.interval && s.status === "open" && s.ui_mode === "embedded" && isClientSecret(s.client_secret)) {
    return { ui: "embedded", client_secret: s.client_secret, publishable_key: cfg.publishableKey, session_id: sessionId };
  }
  return null;
}

/**
 * What the payment page (`/billing/checkout`) is answered: the client secret to mount Stripe's form with —
 * or Stripe's own URL when embedded checkout is off or the page asked for hosted (`ui: "hosted"`, its
 * fallback), or what became of the session it named. `no-store`, and to the signed-in buyer only: both
 * routes that call this are behind the session gate and refuse a bearer.
 */
async function pageCheckout(c: Context<AppEnv>, cfg: BillingConfig, o: CheckoutAsk, b: Record<string, unknown>): Promise<Response> {
  const hosted = b.ui === "hosted";
  try {
    const held = typeof b.session_id === "string" ? await resumeCheckout(c, cfg, o, b.session_id) : null;
    // The fallback wants Stripe's page whatever the old session was — unless that session was PAID.
    if (held && (!hosted || held.ui === "complete")) return c.json(held satisfies BillingCheckoutResponse, 200, NO_STORE);
    const s = await startCheckout(c, cfg, o, { hosted });
    const answer: BillingCheckoutResponse = s.ui === "hosted" ? { ui: "hosted", url: s.url }
      : { ui: "embedded", client_secret: s.clientSecret, publishable_key: cfg.publishableKey ?? "", session_id: s.sessionId };
    return c.json(answer, 200, NO_STORE);
  } catch (e) {
    if (!(e instanceof CheckoutRefused)) throw e;
    if (e.why === "stripe") return stripeFailed(c, "Trov could not reach Stripe just now. Nothing was charged. Try again in a minute.");
    return c.json({ error: "rate_limited", retry_after: e.retryAfter }, 429, { "retry-after": String(e.retryAfter) });
  }
}

export const billingApp = new Hono<AppEnv>();
billingApp.use("/api/billing/checkout", cookieOnly);

billingApp.get("/billing/start", async (c) => {
  const plan = c.req.query("plan");
  if (plan === "enterprise") return page(c, enterprisePage(), 200); // never bought here
  if (!isPurchasablePlan(plan)) return c.redirect(PRICING_PATH, 302);
  const cfg = billingConfig(c.env);
  const asked = c.req.query("interval");
  const interval: BillingInterval | null = asked === undefined ? (cfg ? intervalsOf(cfg, plan)[0] ?? null : "month") : isBillingInterval(asked) ? asked : null;
  const price = cfg && interval ? priceFor(cfg, plan, interval) : null;
  if (!cfg || !interval || !price) {
    return (c.req.header("accept") ?? "").includes("text/html") ? page(c, unavailablePage(), 503) : unavailable(c);
  }
  const me = await caller(c);
  if (!me) {
    await setReturnTo(c, billingStartHref(plan, interval));
    // `via` (the app's Get started dialog, where the provider was already picked): straight on to that
    // provider's sign-in, with the same sealed return — not a second page asking the same question. The
    // return path is still the allowlisted one built above; `via` is never part of it.
    const via = c.req.query("via");
    if (via === "github") return c.redirect("/auth/login", 302);
    if (via === "google") return c.redirect("/auth/google/login", 302);
    // No provider picked yet (the pricing page's "Choose Pro", a pasted link): the app's own Get started
    // dialog asks, opened on this plan (`billingAskHref`; web/src/main.ts reads it). There is no separate
    // "sign in to continue" page any more — it was a second screen asking what the dialog already asks.
    return c.redirect(billingAskHref(plan, interval), 302);
  }
  if (await isSuperadmin(c.var.p, me.handle)) return page(c, superadminPage(), 403);
  // Embedded checkout: the buyer pays on Trov's own page, which asks for its session itself
  // (`POST /api/billing/checkout`) — nothing is created by following this link.
  if (cfg.embedded) return c.redirect(billingCheckoutHref(plan, interval), 303);
  try {
    const s = await startCheckout(c, cfg, { person: me.handle, plan, interval, price });
    if (s.ui !== "hosted") throw new CheckoutRefused("stripe"); // unreachable: `embedded` was just read as off
    return c.redirect(s.url, 303);
  } catch (e) {
    if (!(e instanceof CheckoutRefused)) throw e;
    return e.why === "rate_limited" ? page(c, rateLimitedPage(), 429) : page(c, stripeFailedPage(), 502);
  }
});

// The payment page's own call (web/src/billing-checkout.ts), for a NEW purchase: a session for the person
// signed in, as a client secret (embedded) or Stripe's URL (embedded off, or `ui: "hosted"`). Behind the
// session gate — a signed-out caller is the app's bare 401 — and never a token's.
billingApp.post("/api/billing/checkout", async (c) => {
  const cfg = billingConfig(c.env);
  if (!cfg) return unavailable(c);
  const b = await body(c);
  if (!isPurchasablePlan(b.plan)) return c.json({ error: "invalid_plan", message: `plan must be ${UPGRADE_PLAN}` }, 400);
  const interval = b.interval === undefined ? intervalsOf(cfg, b.plan)[0] ?? null : isBillingInterval(b.interval) ? b.interval : null;
  const price = interval ? priceFor(cfg, b.plan, interval) : null;
  if (!interval || !price) return unavailable(c);
  const me = c.get("principal").handle;
  if (await isSuperadmin(c.var.p, me)) return c.json({ error: "superadmin", message: "A superadmin adds organizations in Platform, on any plan, without paying." }, 403);
  return pageCheckout(c, cfg, { person: me, plan: b.plan, interval, price }, b);
});

// What can be bought on this deployment. Public; the signed-in part is the caller's own. (The static pricing
// page does not ask it — shared/pricing.ts decides its buttons.)
billingApp.get("/api/billing/config", async (c) => {
  const cfg = billingConfig(c.env);
  const me = await caller(c);
  return c.json({
    available: cfg !== null, mode: cfg?.mode ?? null, ...(cfg?.embedded ? { embedded: true as const } : {}), plans: billingOffers(cfg), contact: BILLING_CONTACT,
    signed_in: me !== null, manage: me ? await managedOrgs(c.var.p, me.handle) : [],
  } satisfies BillingConfigResponse, 200, { "cache-control": "no-store" });
});

/** What Trov's own rows say about a checkout — no Stripe call. */
async function checkoutState(p: PlatformContext, row: CheckoutRow): Promise<BillingStatusResponse> {
  if (!row.subscription_id) return { state: "pending", paid: false };
  if (row.for_org) {
    const org = await orgById(p, row.for_org);
    return org ? { state: "done", org: { slug: org.slug, name: org.name } } : { state: "pending", paid: true };
  }
  const grant = await grantOfSubscription(p, row.subscription_id);
  if (!grant) return { state: "pending", paid: true };
  if (grant.status === "used" && grant.org_slug) return { state: "done", org: { slug: grant.org_slug, name: grant.org_name ?? grant.org_slug } };
  if (grant.status === "unused") return { state: "ready", plan: grant.plan as PlanId, grant: grant.id };
  return { state: "ended" }; // revoked: the subscription was cancelled before it was used
}

// The waiting room (`/billing/done?session_id=…`) polls this. The session must be one THIS person
// started: anyone else's id — a guessed one, a shared link — is the same 404 as an unknown one, so a
// session id is never a way to learn about, or claim, another person's purchase.
billingApp.get("/api/billing/status", async (c) => {
  const cfg = billingConfig(c.env);
  if (!cfg) return unavailable(c);
  const me = c.get("principal").handle;
  const sessionId = c.req.query("session_id") ?? "";
  const row = /^cs_[A-Za-z0-9_]{1,200}$/.test(sessionId) ? await checkoutBySession(c.var.p, sessionId) : null;
  if (!row || row.person.toLowerCase() !== me.toLowerCase()) return c.json({ error: "not_found" }, 404);
  let state = await checkoutState(c.var.p, row);
  // The webhook has not landed: look at Stripe ourselves (throttled) and run the SAME fulfilment it would.
  if (state.state === "pending" && (await takeCheckoutLook(c.var.p, row.ref, STATUS_LOOK_MS))) {
    try {
      const session = readCheckoutSession(await stripeCall(cfg, "GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`));
      if (session && session.status === "expired") state = { state: "unpaid" };
      else if (session && sessionPaid(session)) {
        state = { state: "pending", paid: true }; // Stripe has the money: from here the page never says otherwise
        await fulfilCheckout(c.env, cfg, session, { origin: mailOrigin(c.env, c.req.url) });
        const after = await checkoutBySession(c.var.p, sessionId);
        const now = after ? await checkoutState(c.var.p, after) : state;
        if (now.state !== "pending") state = now;
      }
    } catch (e) {
      logStripe("billing status look failed", e); // the poll carries on; the webhook is still on its way
    }
  }
  return c.json(state satisfies BillingStatusResponse, 200, { "cache-control": "no-store" });
});

// ── an org's billing: its owner only ─────────────────────────────────────────

export const orgBillingApp = new Hono<AppEnv>();
orgBillingApp.use("/billing/*", cookieOnly);

const body = async (c: Context<AppEnv>): Promise<Record<string, unknown>> => {
  const json: unknown = await c.req.json().catch(() => null);
  return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
};
const forbidden = (c: Context<AppEnv>) => c.json({ error: "forbidden", message: "only an owner of this organization manages its billing" }, 403);
const notBilled = (c: Context<AppEnv>) => c.json({ error: "not_billed", message: "this organization does not pay through Trov's billing" }, 409);
const stripeFailed = (c: Context<AppEnv>, message = "Trov could not reach Stripe just now. Nothing was changed. Try again in a minute.") =>
  c.json({ error: "billing_failed", message }, 502);
const portalKey = (): string => `trov-portal-${randomToken(18)}`;

/** The gate every org billing route shares: owner, Stripe set up, and an org that pays through it. */
async function billedOrg(c: Context<AppEnv>): Promise<{ refused: Response } | { cfg: BillingConfig; plan: OrgPlan; customer: string; returnUrl: string }> {
  if (!hasRole(c.var.ctx, "owner")) return { refused: forbidden(c) };
  const cfg = billingConfig(c.env);
  if (!cfg) return { refused: unavailable(c) };
  const plan = await orgPlan(c.var.p, c.var.ctx.orgId);
  if (plan.source !== "billing" || !plan.customer_id) return { refused: notBilled(c) };
  return { cfg, plan, customer: plan.customer_id, returnUrl: `${returnOrigin(c.req.url)}${orgBillingHref(c.req.param("slug") ?? "")}` };
}

// "Manage billing": card, invoices, seats, cancel — Stripe's own pages, for THIS org's customer.
// `{ seats: true }` ("Add a seat", at the seat cap): straight to the subscription's update page, where the
// seat count is changed (the portal must allow quantity updates — billing.md › Owner checklist); a plain
// portal when there is no live subscription to update. `{ cancel: true }` ("Cancel plan"): the cancel page.
orgBillingApp.post("/billing/portal", async (c) => {
  const g = await billedOrg(c);
  if ("refused" in g) return g.refused;
  const b = await body(c);
  const live = g.plan.status !== "canceled" && g.plan.plan !== FREE_PLAN && !!g.plan.subscription_id;
  const seats = b.seats === true && live;
  // `{ cancel: true }` ("Cancel plan"): straight to the subscription's cancel page, and — like the seat
  // change — BACK to Trov when it is done. The plain portal's own cancel ends on Stripe's confirmation
  // page with only a back link, so a person who cancelled there was left on Stripe.
  const cancel = !seats && b.cancel === true && live;
  const flow = seats ? { type: "subscription_update", subscription_update: { subscription: g.plan.subscription_id } }
    : cancel ? { type: "subscription_cancel", subscription_cancel: { subscription: g.plan.subscription_id } }
    : null;
  try {
    const session = await stripeCall<{ url?: unknown }>(g.cfg, "POST", "/v1/billing_portal/sessions", {
      customer: g.customer, return_url: g.returnUrl,
      ...(flow ? { flow_data: { ...flow, after_completion: { type: "redirect", redirect: { return_url: g.returnUrl } } } } : {}),
    }, { idempotencyKey: portalKey() });
    if (!redirectable(g.cfg, session.url)) throw new StripeError("shape", 200, null, "stripe POST /v1/billing_portal/sessions: no url");
    return c.json({ url: session.url });
  } catch (e) {
    logStripe("billing portal failed", e);
    return stripeFailed(c);
  }
});

// "Upgrade to Pro": a Free org — one that never paid, or one whose subscription ended (it moved to Free) —
// starts a subscription for the SAME org, with its Stripe customer when it has one: a checkout, no grant.
// The seats start at what the org uses now. (A legacy `canceled` org pays again the same way.)
// An org whose plan is a GIFT (0048_plan_gifts) may start paying the same way before the gift ends, so there
// is no lapse: fulfilment (`upgradeOrg` → `setOrgPlan`, source billing) clears the gift.
orgBillingApp.post("/billing/upgrade", async (c) => {
  if (!hasRole(c.var.ctx, "owner")) return forbidden(c);
  const cfg = billingConfig(c.env);
  if (!cfg) return unavailable(c);
  const now = await orgPlan(c.var.p, c.var.ctx.orgId);
  const gifted = now.source !== "billing" && now.gift_until !== null;
  if (now.plan !== FREE_PLAN && now.status !== "canceled" && !gifted) return c.json({ error: "not_free", message: "this organization is not on Free; use Manage billing" }, 409);
  const b = await body(c);
  const plan = b.plan === undefined ? UPGRADE_PLAN : isPurchasablePlan(b.plan) ? b.plan : null;
  if (!plan) return c.json({ error: "invalid_plan", message: `plan must be ${UPGRADE_PLAN}` }, 400);
  const interval = b.interval === undefined ? intervalsOf(cfg, plan)[0] ?? null : isBillingInterval(b.interval) ? b.interval : null;
  const price = interval ? priceFor(cfg, plan, interval) : null;
  if (!interval || !price) return unavailable(c);
  const customer = now.source === "billing" ? now.customer_id : null;
  const slug = c.req.param("slug") ?? "";
  const ask: CheckoutAsk = { person: c.get("principal").handle, plan, interval, price, forOrg: { id: c.var.ctx.orgId, slug, customer } };
  // The payment page itself (`ui`): a client secret, Stripe's URL, or what became of its session.
  if (b.ui !== undefined) return pageCheckout(c, cfg, ask, b);
  // The button. Embedded checkout: on to Trov's own payment page for this org — which asks this route
  // again as the page — and nothing is created yet. Otherwise Stripe's page, as ever.
  if (cfg.embedded) return c.json({ url: billingCheckoutHref(plan, interval, { org: slug }) });
  try {
    const s = await startCheckout(c, cfg, ask);
    if (s.ui !== "hosted") throw new CheckoutRefused("stripe"); // unreachable: `embedded` was just read as off
    return c.json({ url: s.url });
  } catch (e) {
    if (!(e instanceof CheckoutRefused)) throw e;
    if (e.why === "stripe") return stripeFailed(c);
    return c.json({ error: "rate_limited", retry_after: e.retryAfter }, 429, { "retry-after": String(e.retryAfter) });
  }
});
