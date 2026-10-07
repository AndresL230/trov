// Billing's routes (docs/architecture/billing.md › Routes). Two sub-apps, mounted in src/routes.ts:
//
//   `billingApp` — person-level, at `/`:
//     GET  /billing/start?plan=personal|team[&interval=month|year]   PUBLIC, a link: signed out → sign in and
//                                                                    come back; signed in → Stripe Checkout
//     GET  /api/billing/config                                       PUBLIC: what can be bought, for the pricing page
//     GET  /api/billing/status?session_id=…                          session: the waiting room's poll
//   `orgBillingApp` — an org's, at `/api/o/:slug` (behind `tenantGate`), cookie only, OWNER only:
//     POST /billing/portal     the Stripe Customer Portal for this org's customer      → { url }
//     POST /billing/change     move THIS org's subscription to another plan            → { url } (Stripe confirms it)
//     POST /billing/renew      a canceled org pays again: a new subscription, same org → { url }
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
import type { PlanId } from "@shared/plans";
import {
  BILLING_CONTACT, BILLING_DONE_PATH, BILLING_UNAVAILABLE, BILLING_UNAVAILABLE_MESSAGE, PRICING_PATH,
  billingStartHref, isBillingInterval, isPurchasablePlan, orgBillingHref,
  type BillingConfigResponse, type BillingInterval, type BillingStatusResponse, type PurchasablePlan,
} from "@shared/billing";
import { billingConfig, billingOffers, intervalsOf, priceFor, type BillingConfig } from "./config";
import { StripeError, stripeCall } from "./stripe";
import {
  checkoutBySession, createCheckout, dropCheckout, grantOfSubscription, managedOrgs, orgById, orgSubscription, setCheckoutSession, takeCheckoutLook,
  type CheckoutRow,
} from "./store";
import { fetchSubscription, fulfilCheckout, readCheckoutSession, sessionPaid } from "./sync";
import { billingSignInPage, enterprisePage, rateLimitedPage, stripeFailedPage, superadminPage, unavailablePage } from "./pages";

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

// ── starting a checkout ──────────────────────────────────────────────────────

class CheckoutRefused extends Error { constructor(readonly why: "rate_limited" | "stripe", readonly retryAfter = 0) { super(why); } }

/**
 * Create a Checkout Session for `person` and return Stripe's URL. The row that binds the session to the
 * person is written BEFORE Stripe is asked (its `ref` is the idempotency key and travels in the
 * session's metadata), so a webhook can never arrive for a session Trov has no row for.
 */
async function startCheckout(c: Context<AppEnv>, cfg: BillingConfig, o: { person: string; plan: PurchasablePlan; interval: BillingInterval; price: string; forOrg?: { id: string; slug: string; customer: string | null } }): Promise<string> {
  const p = c.var.p;
  // Per person per day (docs/architecture/abuse-limits.md): each one is a Stripe object and a row here.
  const retryAfter = await takeLimit(p, o.person, "checkout");
  if (retryAfter !== null) throw new CheckoutRefused("rate_limited", retryAfter);
  const ref = randomToken(18);
  await createCheckout(p, { ref, person: o.person, plan: o.plan, interval: o.interval, forOrg: o.forOrg?.id ?? null });
  const origin = returnOrigin(c.req.url);
  // The receipt goes where Stripe sends it; Trov only ever SUGGESTS the person's provider-verified address.
  const email = o.forOrg?.customer ? null : (await welcomeRecipient(p, o.person).catch(() => null))?.email ?? null;
  const metadata = { trov_ref: ref, trov_plan: o.plan, trov_person: o.person, ...(o.forOrg ? { trov_org: o.forOrg.slug } : {}) };
  try {
    const session = await stripeCall<{ id?: unknown; url?: unknown }>(cfg, "POST", "/v1/checkout/sessions", {
      mode: "subscription",
      line_items: [{ price: o.price, quantity: 1 }],
      client_reference_id: o.person,
      ...(o.forOrg?.customer ? { customer: o.forOrg.customer } : email ? { customer_email: email } : {}),
      success_url: `${origin}${BILLING_DONE_PATH}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: o.forOrg ? `${origin}${orgBillingHref(o.forOrg.slug)}` : `${origin}${PRICING_PATH}`,
      metadata,
      subscription_data: { metadata },
    }, { idempotencyKey: `trov-checkout-${ref}` });
    if (typeof session.id !== "string" || !redirectable(cfg, session.url)) throw new StripeError("shape", 200, null, "stripe POST /v1/checkout/sessions: no session url");
    await setCheckoutSession(p, ref, session.id);
    return session.url;
  } catch (e) {
    await dropCheckout(p, ref).catch(() => undefined);
    logStripe("billing checkout failed", e);
    throw new CheckoutRefused("stripe");
  }
}

export const billingApp = new Hono<AppEnv>();

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
    return page(c, billingSignInPage(plan), 200);
  }
  if (await isSuperadmin(c.var.p, me.handle)) return page(c, superadminPage(), 403);
  try {
    return c.redirect(await startCheckout(c, cfg, { person: me.handle, plan, interval, price }), 303);
  } catch (e) {
    if (!(e instanceof CheckoutRefused)) throw e;
    return e.why === "rate_limited" ? page(c, rateLimitedPage(), 429) : page(c, stripeFailedPage(), 502);
  }
});

// What the pricing page asks before it draws its buttons. Public; the signed-in part is the caller's own.
billingApp.get("/api/billing/config", async (c) => {
  const cfg = billingConfig(c.env);
  const me = await caller(c);
  return c.json({
    available: cfg !== null, mode: cfg?.mode ?? null, plans: billingOffers(cfg), contact: BILLING_CONTACT,
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

// "Manage billing": card, invoices, cancel — Stripe's own pages, for THIS org's customer.
orgBillingApp.post("/billing/portal", async (c) => {
  const g = await billedOrg(c);
  if ("refused" in g) return g.refused;
  try {
    const session = await stripeCall<{ url?: unknown }>(g.cfg, "POST", "/v1/billing_portal/sessions", { customer: g.customer, return_url: g.returnUrl }, { idempotencyKey: portalKey() });
    if (!redirectable(g.cfg, session.url)) throw new StripeError("shape", 200, null, "stripe POST /v1/billing_portal/sessions: no url");
    return c.json({ url: session.url });
  } catch (e) {
    logStripe("billing portal failed", e);
    return stripeFailed(c);
  }
});

// "Upgrade to Team" / "Switch to Personal": the portal's confirm screen for THIS subscription — Stripe shows
// the price and the proration and takes the confirmation; the plan changes here when its webhook lands.
orgBillingApp.post("/billing/change", async (c) => {
  const g = await billedOrg(c);
  if ("refused" in g) return g.refused;
  const to = (await body(c)).plan;
  if (!isPurchasablePlan(to)) return c.json({ error: "invalid_plan", message: "plan must be personal or team" }, 400);
  if (g.plan.status === "canceled" || !g.plan.subscription_id) return c.json({ error: "plan_ended", message: "this plan has ended; renew it instead" }, 409);
  const held = await orgSubscription(c.var.p, c.var.ctx.orgId);
  const interval: BillingInterval = held?.interval === "year" ? "year" : "month";
  const price = priceFor(g.cfg, to, interval);
  if (!price) return unavailable(c);
  if (held?.price_id === price) return c.json({ error: "same_plan", message: "this organization is already on that plan" }, 409);
  try {
    const sub = await fetchSubscription(g.cfg, g.plan.subscription_id);
    if (!sub?.itemId) throw new StripeError("shape", 200, null, "stripe GET /v1/subscriptions: no item");
    const session = await stripeCall<{ url?: unknown }>(g.cfg, "POST", "/v1/billing_portal/sessions", {
      customer: g.customer, return_url: g.returnUrl,
      flow_data: {
        type: "subscription_update_confirm",
        subscription_update_confirm: { subscription: sub.id, items: [{ id: sub.itemId, price, quantity: 1 }] },
        after_completion: { type: "redirect", redirect: { return_url: g.returnUrl } },
      },
    }, { idempotencyKey: portalKey() });
    if (!redirectable(g.cfg, session.url)) throw new StripeError("shape", 200, null, "stripe POST /v1/billing_portal/sessions: no url");
    return c.json({ url: session.url });
  } catch (e) {
    logStripe("billing change failed", e);
    return stripeFailed(c, "Trov could not open the plan change in Stripe. Nothing was changed. Try Manage billing, or try again in a minute.");
  }
});

// A canceled org pays again: a new subscription for the SAME org and the same Stripe customer — no grant.
orgBillingApp.post("/billing/renew", async (c) => {
  const g = await billedOrg(c);
  if ("refused" in g) return g.refused;
  if (g.plan.status !== "canceled") return c.json({ error: "not_ended", message: "this plan has not ended" }, 409);
  const b = await body(c);
  const plan = b.plan === undefined ? (isPurchasablePlan(g.plan.plan) ? g.plan.plan : null) : isPurchasablePlan(b.plan) ? b.plan : null;
  if (!plan) return c.json({ error: "invalid_plan", message: "plan must be personal or team" }, 400);
  const interval = b.interval === undefined ? intervalsOf(g.cfg, plan)[0] ?? null : isBillingInterval(b.interval) ? b.interval : null;
  const price = interval ? priceFor(g.cfg, plan, interval) : null;
  if (!interval || !price) return unavailable(c);
  try {
    const url = await startCheckout(c, g.cfg, { person: c.get("principal").handle, plan, interval, price, forOrg: { id: c.var.ctx.orgId, slug: c.req.param("slug") ?? "", customer: g.customer } });
    return c.json({ url });
  } catch (e) {
    if (!(e instanceof CheckoutRefused)) throw e;
    if (e.why === "stripe") return stripeFailed(c);
    return c.json({ error: "rate_limited", retry_after: e.retryAfter }, 429, { "retry-after": String(e.retryAfter) });
  }
});
