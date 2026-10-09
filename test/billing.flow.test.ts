/**
 * Buying a plan → setting up the organization (docs/architecture/billing.md), end to end against a
 * stand-in Stripe (test/helpers/billing.ts — nothing reaches the network):
 *   GET /billing/start → Stripe Checkout → POST /webhook/stripe → the SAME grant a superadmin gives →
 *   the buyer creates the org → the org is linked to the customer and the subscription.
 * And what must hold around it: one grant per payment however many times it is delivered or looked up,
 * events in any order, and a session id that is useless to anyone but the person who started it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import type { MyOrgsResponse } from "@shared/orgs";
import type { OrgPlanView, PlatformGrant } from "@shared/plans";
import type { BillingConfigResponse, BillingStatusResponse } from "@shared/billing";
import { LIMITS } from "../src/platform/limits";
import { STRIPE_VERSION } from "../src/billing/stripe";
import { RETURN_TO_COOKIE } from "../src/auth/return-to";
import { buildAuthApp } from "../src/auth/routes";
import { renamePerson } from "../src/auth/persons";
import { cookieFor, seedPerson } from "./helpers/persons";
import { platformCtx } from "./helpers/tenant";
import { call, one, rows, exec, SUPERADMIN } from "./helpers/orgs";
import { FakeStripe, PRICES, PERIOD_1, STRIPE_KEY, bcall, billingEnv, deliver, event, iso } from "./helpers/billing";

let stripe: FakeStripe;
beforeEach(() => { stripe = new FakeStripe(); vi.stubGlobal("fetch", stripe.fetch); });
afterEach(() => { vi.unstubAllGlobals(); });

const buyer = (handle: string, email: string | null = `${handle}@example.com`) => cookieFor(handle, { member: false, email, verified: email !== null });
const count = async (sql: string, ...p: unknown[]) => (await one<{ n: number }>(sql, ...p))!.n;
const grants = () => rows<{ id: number; person: string; plan: string; source: string; external_ref: string; granted_by: string; status: string }>(
  `SELECT id, person, plan, source, external_ref, granted_by, status FROM org_grants ORDER BY id`);
const myOrgs = async (cookie: string) => (await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json;
const status = (cookie: string, sessionId: string) => bcall<BillingStatusResponse>("GET", `/api/billing/status?session_id=${sessionId}`, cookie);

/** `handle` presses "Get <plan>" and pays at Stripe. Nothing is delivered yet. */
async function buy(handle: string, plan: "team" = "team", query = "", seats?: number) {
  const cookie = await buyer(handle);
  const start = await bcall("GET", `/billing/start?plan=${plan}${query}`, cookie);
  expect(start.status, start.text.slice(0, 200)).toBe(303);
  const session = stripe.lastSession();
  expect(start.headers.get("location")).toBe(session.url);
  const sub = stripe.pay(session.id, seats);
  return { cookie, session, sub, completed: () => event("checkout.session.completed", stripe.sessionJson(session)) };
}
const subEvent = (type: string, subId: string) => event(type, stripe.subscriptionJson(stripe.subscriptions.get(subId)!));

describe("GET /billing/start — a signed-in person starts a checkout", () => {
  it("creates ONE Stripe Checkout Session with Pro's per-seat price × 1 (no org yet), adjustable up to 50, bound to the person, and redirects to it", async () => {
    const cookie = await buyer("maya");
    const r = await bcall("GET", "/billing/start?plan=team", cookie);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    const [c] = stripe.callsTo("POST", "/v1/checkout/sessions");
    expect(stripe.calls).toHaveLength(1);
    const row = (await one<{ ref: string; person: string; plan: string; interval: string; for_org: string | null; session_id: string }>(`SELECT ref, person, plan, interval, for_org, session_id FROM billing_checkouts`))!;
    expect(row).toMatchObject({ person: "maya", plan: "team", interval: "month", for_org: null, session_id: stripe.lastSession().id });
    expect(Object.fromEntries(c.params)).toEqual({
      mode: "subscription", "line_items[0][price]": PRICES.team, "line_items[0][quantity]": "1",
      "line_items[0][adjustable_quantity][enabled]": "true", "line_items[0][adjustable_quantity][minimum]": "1", "line_items[0][adjustable_quantity][maximum]": "50",
      client_reference_id: "maya", customer_email: "maya@example.com",
      success_url: "http://localhost/billing/done?session_id={CHECKOUT_SESSION_ID}", cancel_url: "http://localhost/pricing",
      "metadata[trov_ref]": row.ref, "metadata[trov_plan]": "team", "metadata[trov_person]": "maya",
      "subscription_data[metadata][trov_ref]": row.ref, "subscription_data[metadata][trov_plan]": "team", "subscription_data[metadata][trov_person]": "maya",
    });
    // The key goes out as the bearer, to api.stripe.com only; the call is idempotent on Trov's own reference and version-pinned.
    expect(c.headers.get("authorization")).toBe(`Bearer ${STRIPE_KEY}`);
    expect(c.headers.get("idempotency-key")).toBe(`trov-checkout-${row.ref}`);
    expect(c.headers.get("stripe-version")).toBe(STRIPE_VERSION);
    expect(c.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(row.ref).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // Nothing is granted by starting a checkout.
    expect(await grants()).toEqual([]);
  });

  it("asks Stripe Tax for the tax only when STRIPE_TAX is on, and computes none itself", async () => {
    const { billingConfig } = await import("../src/billing/config");
    expect(billingConfig(billingEnv())!.tax).toBe(false);
    for (const v of ["", "off", "true", "1"]) expect(billingConfig(billingEnv({ STRIPE_TAX: v }))!.tax, v).toBe(false);
    expect(billingConfig(billingEnv({ STRIPE_TAX: " On " }))!.tax).toBe(true);
    const r = await bcall("GET", "/billing/start?plan=team", await buyer("maya"), undefined, { env: billingEnv({ STRIPE_TAX: "on" }) });
    expect(r.status).toBe(303);
    const [c] = stripe.callsTo("POST", "/v1/checkout/sessions");
    expect(c.params.get("automatic_tax[enabled]")).toBe("true");
    expect(c.params.get("tax_id_collection[enabled]")).toBe("true");
    // A new buyer has no Stripe customer yet: there is nothing to update, and Stripe refuses the field.
    expect([...c.params.keys()].some((k) => k.startsWith("customer_update"))).toBe(false);
    // Off (the first test's exact parameter list) sends none of it.
  });

  it("uses the yearly price when asked, and offers no e-mail it does not know to be the person's", async () => {
    await seedPerson("noaddr", { member: false, email: "typed-by-them@example.com" }); // persons.email is editable: never sent
    const r = await bcall("GET", "/billing/start?plan=team&interval=year", await cookieFor("noaddr", { member: false }));
    expect(r.status).toBe(303);
    const [c] = stripe.callsTo("POST", "/v1/checkout/sessions");
    expect(c.params.get("line_items[0][price]")).toBe(PRICES.team_year);
    expect(c.params.has("customer_email")).toBe(false);
    expect((await one<{ interval: string }>(`SELECT interval FROM billing_checkouts`))!.interval).toBe("year");
  });

  it("Enterprise is never purchasable: a page that points at Trov, and no Stripe call; an unknown plan — Personal and Free too — goes back to pricing", async () => {
    const ent = await bcall("GET", "/billing/start?plan=enterprise", await buyer("maya"));
    expect(ent.status).toBe(200);
    expect(ent.text).toContain("Enterprise is arranged with Trov");
    expect(ent.text).toContain('href="mailto:hello@trov.dev"');
    expect(ent.headers.get("content-security-policy")).toContain("default-src 'none'");
    for (const q of ["?plan=gold", "", "?plan=", "?plan=personal", "?plan=free"]) {
      const r = await bcall("GET", `/billing/start${q}`, await buyer("maya"));
      expect([r.status, r.headers.get("location")], q).toEqual([302, "/pricing"]);
    }
    expect(stripe.calls).toEqual([]);
    expect(await count(`SELECT COUNT(*) AS n FROM billing_checkouts`)).toBe(0);
  });

  it("a superadmin is told to use Platform; nothing is created", async () => {
    const r = await bcall("GET", "/billing/start?plan=team", await cookieFor(SUPERADMIN));
    expect(r.status).toBe(403);
    expect(r.text).toContain("A superadmin adds organizations in Platform");
    expect(stripe.calls).toEqual([]);
  });

  it("is rate-limited per person per day; the refusal charges nothing and creates nothing", async () => {
    const cookie = await buyer("maya");
    for (let i = 0; i < LIMITS.checkout.max; i++) expect((await bcall("GET", "/billing/start?plan=team", cookie)).status).toBe(303);
    const refused = await bcall("GET", "/billing/start?plan=team", cookie);
    expect(refused.status).toBe(429);
    expect(refused.text).toContain("Too many checkouts today");
    expect(stripe.callsTo("POST", "/v1/checkout/sessions")).toHaveLength(LIMITS.checkout.max);
    expect(await count(`SELECT COUNT(*) AS n FROM billing_checkouts`)).toBe(LIMITS.checkout.max);
    // Another person's allowance is their own.
    expect((await bcall("GET", "/billing/start?plan=team", await buyer("omar"))).status).toBe(303);
  });

  it("a Stripe failure is a page that says nothing was charged, and leaves no checkout row behind", async () => {
    stripe.fail = () => Response.json({ error: { type: "api_error", message: "boom" } }, { status: 500 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await bcall("GET", "/billing/start?plan=team", await buyer("maya"));
    expect(r.status).toBe(502);
    expect(r.text).toContain("Nothing was charged");
    expect(await count(`SELECT COUNT(*) AS n FROM billing_checkouts`)).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("billing not configured", () => {
  const off = env as unknown as Env; // the pool default: no key, no prices
  it("every billing route answers 503 billing_unavailable (the link: a page), and nothing else in the app changes", async () => {
    const cookie = await buyer("maya");
    const body = { error: "billing_unavailable", message: "Paid plans are not available yet." };
    const start = await bcall("GET", "/billing/start?plan=team", cookie, undefined, { env: off });
    expect([start.status, start.json]).toEqual([503, body]);
    const page = await bcall("GET", "/billing/start?plan=team", cookie, undefined, { env: off, headers: { accept: "text/html,application/xhtml+xml" } });
    expect(page.status).toBe(503);
    expect(page.text).toContain("Paid plans are not available yet");
    expect((await bcall("GET", "/api/billing/status?session_id=cs_test_1", cookie, undefined, { env: off })).json).toEqual(body);
    for (const path of ["/billing/portal", "/billing/upgrade"]) {
      const r = await bcall("POST", `/api/o/saplinglearn${path}`, await cookieFor(SUPERADMIN), {}, { env: off });
      expect([r.status, r.json], path).toEqual([503, body]);
    }
    const cfg = await bcall<BillingConfigResponse>("GET", "/api/billing/config", "", undefined, { env: off });
    expect(cfg.json).toEqual({
      available: false, mode: null, contact: "mailto:hello@trov.dev", signed_in: false, manage: [],
      plans: { free: { purchasable: false, intervals: [], href: null }, personal: { purchasable: false, intervals: [], href: null }, team: { purchasable: false, intervals: [], href: null }, enterprise: { purchasable: false, intervals: [], href: null } },
    });
    expect((await call("GET", "/api/orgs", cookie)).status).toBe(200);
    expect(stripe.calls).toEqual([]);
  });

  it("an interval with no price id is not offered while the other is; no price at all sells nothing; a key with no webhook secret sells nothing", async () => {
    const partial = billingEnv({ STRIPE_PRICE_TEAM_YEARLY: "" });
    const cfg = (await bcall<BillingConfigResponse>("GET", "/api/billing/config", await buyer("maya"), undefined, { env: partial })).json;
    expect(cfg).toMatchObject({ available: true, mode: "test", signed_in: true, manage: [] });
    expect(cfg.plans).toEqual({
      free: { purchasable: false, intervals: [], href: null },
      personal: { purchasable: false, intervals: [], href: null },
      team: { purchasable: true, intervals: ["month"], href: "/billing/start?plan=team" },
      enterprise: { purchasable: false, intervals: [], href: null },
    });
    const none = billingEnv({ STRIPE_PRICE_TEAM: "", STRIPE_PRICE_TEAM_YEARLY: "" });
    expect((await bcall<BillingConfigResponse>("GET", "/api/billing/config", "", undefined, { env: none })).json.plans.team).toEqual({ purchasable: false, intervals: [], href: null });
    expect((await bcall("GET", "/billing/start?plan=team", await buyer("maya"), undefined, { env: none })).status).toBe(503);
    expect((await bcall("GET", "/billing/start?plan=team&interval=year", await buyer("maya"), undefined, { env: partial })).status).toBe(503);
    expect((await bcall("GET", "/billing/start?plan=team&interval=weekly", await buyer("maya"), undefined, { env: partial })).status).toBe(503);
    expect((await bcall("GET", "/billing/start?plan=team", await buyer("maya"), undefined, { env: partial })).status).toBe(303);
    const noHook = billingEnv({ STRIPE_WEBHOOK_SECRET: "" });
    expect((await bcall<BillingConfigResponse>("GET", "/api/billing/config", "", undefined, { env: noHook })).json.available).toBe(false);
    expect((await bcall("GET", "/billing/start?plan=team", await buyer("maya"), undefined, { env: noHook })).status).toBe(503);
    // The full offer, with both intervals, and the live key's mode.
    const full = (await bcall<BillingConfigResponse>("GET", "/api/billing/config", "", undefined, { env: billingEnv({ STRIPE_SECRET_KEY: "sk_live_x" }) })).json;
    expect(full.mode).toBe("live");
    expect(full.plans.team).toEqual({ purchasable: true, intervals: ["month", "year"], href: "/billing/start?plan=team" });
  });

  it("the stand-in for Stripe's API is honoured only on loopback, and never with a live key", async () => {
    const { billingConfig, STRIPE_API } = await import("../src/billing/config");
    expect(billingConfig(billingEnv({ STRIPE_TEST_API_BASE: "http://127.0.0.1:8842" }))!.apiBase).toBe("http://127.0.0.1:8842");
    expect(billingConfig(billingEnv({ STRIPE_TEST_API_BASE: "http://localhost:8842/x" }))!.apiBase).toBe("http://localhost:8842");
    for (const base of ["https://evil.example", "http://evil.example", "https://127.0.0.1:8842", "http://127.0.0.1.evil.example", "nonsense", ""]) {
      expect(billingConfig(billingEnv({ STRIPE_TEST_API_BASE: base }))!.apiBase, base).toBe(STRIPE_API);
    }
    expect(billingConfig(billingEnv({ STRIPE_SECRET_KEY: "sk_live_x", STRIPE_TEST_API_BASE: "http://127.0.0.1:8842" }))!.apiBase).toBe(STRIPE_API);
    expect(billingConfig(billingEnv({ STRIPE_SECRET_KEY: "rk_live_x", STRIPE_TEST_API_BASE: "http://127.0.0.1:8842" }))!.apiBase).toBe(STRIPE_API);
  });
});

describe("signed out: sign in, then carry on to payment", () => {
  it("with `via`, a signed-out buyer goes straight to the provider they already picked — the same sealed return, no second sign-in page", async () => {
    for (const [via, to] of [["github", "/auth/login"], ["google", "/auth/google/login"]] as const) {
      const start = await bcall("GET", `/billing/start?plan=team&via=${via}`, "");
      expect([start.status, start.headers.get("location")]).toEqual([302, to]);
      const setCookie = start.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(new RegExp(`^${RETURN_TO_COOKIE}=[^;]+; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`));
      // (What the cookie returns to is the allowlisted purchase path, sealed by `setReturnTo` — the test
      // below follows it through the sign-in callback; `via` is never part of it.)
    }
    // Anything else is "no provider picked": the app's Get started dialog asks.
    const other = await bcall("GET", "/billing/start?plan=team&via=facebook", "");
    expect([other.status, other.headers.get("location")]).toEqual([302, "/?start=team"]);
    expect(stripe.calls).toEqual([]);
  });

  it("sends a signed-out buyer to the app's Get started dialog, remembers the purchase in a sealed cookie, and the sign-in callback returns to it", async () => {
    const start = await bcall("GET", "/billing/start?plan=team&interval=year", "");
    // No page of its own any more: the app's Get started dialog asks, opened on this plan and interval.
    expect([start.status, start.headers.get("location")]).toEqual([302, "/?start=team&interval=year"]);
    expect(stripe.calls).toEqual([]);
    const setCookie = start.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(new RegExp(`^${RETURN_TO_COOKIE}=[^;]+; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`));
    const returnTo = setCookie.split(";")[0];

    // The GitHub round trip (stubbed), for a person who already has an account.
    await seedPerson("maya", { member: false, email: "maya@example.com", verified: true });
    const auth = buildAuthApp({ fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/login/oauth/access_token")) return Response.json({ access_token: "gho_x" });
      if (url.endsWith("/user/emails")) return Response.json([{ email: "maya@example.com", primary: true, verified: true }]);
      if (url.endsWith("/user")) return Response.json({ login: "maya", id: 4242, name: "Maya", avatar_url: null });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch });
    const login = await auth.request("/login", { headers: { cookie: returnTo } }, billingEnv());
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    const tx = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const back = await auth.request(`/callback?code=c&state=${state}`, { headers: { cookie: `${returnTo}; ${tx}` } }, billingEnv());
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/billing/start?plan=team&interval=year");
    const session = /session=[^;]+/.exec(back.headers.get("set-cookie") ?? "")![0];

    // …and there, signed in, the checkout starts.
    const go = await bcall("GET", back.headers.get("location")!, session);
    expect(go.status).toBe(303);
    expect(stripe.lastSession()).toMatchObject({ price: PRICES.team_year, client_reference_id: "maya" });
  });

  it("the return cookie holds only a purchase path: a forged or foreign one sends nobody anywhere", async () => {
    const { isReturnPath, takeReturnTo, setReturnTo } = await import("../src/auth/return-to");
    for (const ok of ["/billing/start?plan=team", "/billing/start?plan=team&interval=month", "/billing/start?plan=team&interval=year"]) expect(isReturnPath(ok), ok).toBe(true);
    for (const bad of ["https://evil.example/", "//evil.example", "/billing/start?plan=team&next=//evil.example", "/billing/start?plan=enterprise", "/billing/start?plan=personal", "/billing/start?plan=free", "/o/acme/", "/billing/start", "/billing/start?plan=team#x"]) expect(isReturnPath(bad), bad).toBe(false);
    const { Hono } = await import("hono");
    const probe = new Hono<{ Bindings: Env }>();
    probe.get("/set", async (c) => { await setReturnTo(c as never, c.req.query("to") ?? ""); return c.text("ok"); });
    probe.get("/take", async (c) => c.json({ to: await takeReturnTo(c as never) }));
    const set = await probe.request("/set?to=" + encodeURIComponent("https://evil.example/"), {}, billingEnv());
    expect(set.headers.get("set-cookie")).toBeNull();
    const good = (await probe.request("/set?to=" + encodeURIComponent("/billing/start?plan=team"), {}, billingEnv())).headers.get("set-cookie")!.split(";")[0];
    expect(await (await probe.request("/take", { headers: { cookie: good } }, billingEnv())).json()).toEqual({ to: "/billing/start?plan=team" });
    expect(await (await probe.request("/take", { headers: { cookie: `${good}x` } }, billingEnv())).json()).toEqual({ to: null });
    expect(await (await probe.request("/take", { headers: { cookie: good } }, billingEnv({ COOKIE_SECRET: "another" }))).json()).toEqual({ to: null });
  });
});

describe("fulfilment is the webhook's", () => {
  it("checkout.session.completed → the grant a superadmin would give → the buyer names the org → it is linked to the customer and subscription, with the seats paid for", async () => {
    // At Stripe's checkout the buyer raised the seats from 1 to 4.
    const { cookie, session, sub, completed } = await buy("maya", "team", "", 4);
    // The browser coming back proves nothing: no grant yet.
    expect((await myOrgs(cookie)).grants).toEqual([]);

    const delivered = await deliver(completed());
    expect([delivered.status, delivered.json]).toEqual([200, { ok: true, outcome: "granted" }]);
    expect(await grants()).toEqual([{ id: expect.any(Number), person: "maya", plan: "team", source: "billing", external_ref: sub.id, granted_by: "billing", status: "unused" }]);
    const mine = await myOrgs(cookie);
    expect(mine.can_create).toBe(true);
    expect(mine.grants).toMatchObject([{ plan: "team", plan_name: "Pro", granted_by: "billing", expires_at: null }]);
    // The seats paid for travel on the grant: its limits are what the org will have.
    expect(mine.grants[0].entitlements.seats).toBe(4);
    expect(await one(`SELECT overrides FROM org_grants`)).toEqual({ overrides: '{"seats":4}' });
    // Trov's own notice went to the provider-verified address, through the platform's (local) delivery.
    expect(await rows(`SELECT to_address, subject FROM platform_outbox_bodies`)).toEqual([{ to_address: "maya@example.com", subject: "Your Trov organization is ready to set up" }]);
    // The waiting room sees it.
    expect((await status(cookie, session.id)).json).toEqual({ state: "ready", plan: "team", grant: mine.grants[0].id });

    const created = await call<{ ok: true; org: { slug: string } }>("POST", "/api/orgs", cookie, { slug: "maya-co", name: "Maya & Co" });
    expect(created.status).toBe(201);
    expect(await one(`SELECT plan, plan_overrides, plan_source, plan_status, plan_period_end, billing_customer_id, billing_subscription_id FROM orgs WHERE slug = 'maya-co'`)).toEqual({
      plan: "team", plan_overrides: '{"seats":4}', plan_source: "billing", plan_status: "active", plan_period_end: iso(PERIOD_1), billing_customer_id: sub.customer, billing_subscription_id: sub.id,
    });
    const plan = (await call<OrgPlanView>("GET", "/api/o/maya-co/plan", cookie)).json;
    expect(plan).toMatchObject({ plan: "team", name: "Pro", status: "active", source: "billing", period_end: iso(PERIOD_1), overridden: ["seats"] });
    expect(plan.entitlements.seats).toBe(4); // paid seats = allowed seats
    expect(plan.billing).toMatchObject({ subscribed: true, ended: false, customer: true, seats: 4, interval: "month" });
    expect((await status(cookie, session.id)).json).toEqual({ state: "done", org: { slug: "maya-co", name: "Maya & Co" } });
    expect((await grants())[0].status).toBe("used");
    // The trail: the grant by `billing`, its use by the buyer.
    expect(await rows(`SELECT actor, action FROM org_admin_audit WHERE action LIKE 'grant.%' ORDER BY id`)).toEqual([
      { actor: "billing", action: "grant.create" }, { actor: "maya", action: "grant.use" },
    ]);
  });

  it("a replayed event is a no-op: one grant, one notice, and no second look at Stripe", async () => {
    const { completed } = await buy("maya");
    const ev = completed();
    expect((await deliver(ev)).json).toEqual({ ok: true, outcome: "granted" });
    const lookups = stripe.callsTo("GET", /subscriptions/).length;
    for (let i = 0; i < 3; i++) expect((await deliver(ev)).json).toEqual({ ok: true, replay: true });
    expect(await grants()).toHaveLength(1);
    expect(stripe.callsTo("GET", /subscriptions/)).toHaveLength(lookups);
    expect(await count(`SELECT COUNT(*) AS n FROM platform_outbox_bodies`)).toBe(1);
    expect(await rows(`SELECT event_id, type, outcome FROM billing_events`)).toEqual([{ event_id: ev.id, type: "checkout.session.completed", outcome: "granted" }]);
    // The same payment under a NEW event id (Stripe re-sends by hand from the dashboard): still one grant.
    expect((await deliver(completed())).status).toBe(200);
    expect(await grants()).toHaveLength(1);
    expect(await count(`SELECT COUNT(*) AS n FROM platform_outbox_bodies`)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM org_admin_audit WHERE action = 'grant.create'`)).toBe(1);
  });

  it("an event whose handler failed is NOT marked done: Stripe's retry runs it again", async () => {
    const { completed } = await buy("maya");
    const ev = completed();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stripe.fail = (c) => (c.path.startsWith("/v1/subscriptions/") ? Response.json({ error: { message: "down" } }, { status: 503 }) : null);
    const failed = await deliver(ev);
    expect([failed.status, failed.json]).toEqual([500, { error: "try_again" }]);
    expect(await grants()).toEqual([]);
    expect(await rows(`SELECT processed_at, outcome FROM billing_events`)).toEqual([{ processed_at: null, outcome: null }]);
    stripe.fail = null;
    expect((await deliver(ev)).json).toEqual({ ok: true, outcome: "granted" });
    expect(await grants()).toHaveLength(1);
    spy.mockRestore();
  });

  it("the waiting room's fallback and the webhook make ONE grant, whichever comes first", async () => {
    // Fallback first: the webhook is late, the buyer is already back.
    const a = await buy("maya");
    const first = await status(a.cookie, a.session.id);
    expect(first.json).toMatchObject({ state: "ready", plan: "team" });
    expect(stripe.callsTo("GET", `/v1/checkout/sessions/${a.session.id}`)).toHaveLength(1);
    expect(await grants()).toHaveLength(1);
    expect((await deliver(a.completed())).status).toBe(200);
    expect(await grants()).toHaveLength(1);
    expect((await status(a.cookie, a.session.id)).json).toMatchObject({ state: "ready" });
    // …and once it is ready, the poll costs Stripe nothing.
    expect(stripe.callsTo("GET", `/v1/checkout/sessions/${a.session.id}`)).toHaveLength(1);

    // Webhook first.
    const b = await buy("omar", "team", "", 3);
    expect((await deliver(b.completed())).json).toEqual({ ok: true, outcome: "granted" });
    expect((await status(b.cookie, b.session.id)).json).toMatchObject({ state: "ready", plan: "team" });
    expect(stripe.callsTo("GET", `/v1/checkout/sessions/${b.session.id}`)).toHaveLength(0);
    expect((await grants()).map((g) => [g.person, g.plan])).toEqual([["maya", "team"], ["omar", "team"]]);
    expect((await rows<{ overrides: string }>(`SELECT overrides FROM org_grants ORDER BY id`)).map((r) => r.overrides)).toEqual(['{"seats":1}', '{"seats":3}']);
    expect(await count(`SELECT COUNT(*) AS n FROM platform_outbox_bodies`)).toBe(2);
  });

  it("both at once: the fallback and the webhook racing still make one grant", async () => {
    const { cookie, session, completed } = await buy("maya");
    const [s, d] = await Promise.all([status(cookie, session.id), deliver(completed())]);
    expect(s.status).toBe(200);
    expect(d.status).toBe(200);
    expect(await grants()).toHaveLength(1);
    expect(await count(`SELECT COUNT(*) AS n FROM billing_subscriptions`)).toBe(1);
  });

  it("the waiting room: an unpaid session keeps waiting (throttled looks), an expired one says so, a paid one never reads as failed", async () => {
    const cookie = await buyer("maya");
    await bcall("GET", "/billing/start?plan=team", cookie);
    const session = stripe.lastSession();
    expect((await status(cookie, session.id)).json).toEqual({ state: "pending", paid: false });
    // Polled again at once: Trov does not ask Stripe twice inside the throttle.
    expect((await status(cookie, session.id)).json).toEqual({ state: "pending", paid: false });
    expect(stripe.callsTo("GET", `/v1/checkout/sessions/${session.id}`)).toHaveLength(1);
    await exec(`UPDATE billing_checkouts SET checked_at = '2020-01-01T00:00:00.000Z'`);
    session.status = "expired";
    expect((await status(cookie, session.id)).json).toEqual({ state: "unpaid" });

    // Paid, but Stripe's subscription read fails: the answer is "received, not ready" — pending, never unpaid.
    const b = await buy("omar");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stripe.fail = (c) => (c.path.startsWith("/v1/subscriptions/") ? new Response("gateway", { status: 502 }) : null);
    expect((await status(b.cookie, b.session.id)).json).toEqual({ state: "pending", paid: true });
    stripe.fail = null;
    await exec(`UPDATE billing_checkouts SET checked_at = '2020-01-01T00:00:00.000Z'`);
    expect((await status(b.cookie, b.session.id)).json).toMatchObject({ state: "ready" });
    spy.mockRestore();
  });
});

describe("a session id is not a claim", () => {
  it("another person's session id finds nothing — before payment, after it, and after the grant exists — and never grants them anything", async () => {
    const { session, completed } = await buy("maya");
    const thief = await buyer("mallory");
    const NOT_FOUND = { error: "not_found" };
    expect((await status(thief, session.id)).json).toEqual(NOT_FOUND);
    await deliver(completed());
    const r = await status(thief, session.id);
    expect([r.status, r.json]).toEqual([404, NOT_FOUND]);
    // The same 404 as an id nobody has, and as garbage.
    for (const id of ["cs_test_does_not_exist", "", "' OR 1=1 --", "sub_x"]) expect((await status(thief, id)).json, id).toEqual(NOT_FOUND);
    expect((await myOrgs(thief)).grants).toEqual([]);
    // Naming maya's grant is refused; what they CAN make is their own Free org, and her grant stays hers.
    const [mayas] = await grants();
    expect((await call("POST", "/api/orgs", thief, { slug: "stolen", name: "Stolen", grant: mayas.id })).json).toMatchObject({ error: "no_grant" });
    expect((await call("POST", "/api/orgs", thief, { slug: "stolen", name: "Stolen" })).status).toBe(201);
    expect(await one(`SELECT plan, plan_source, billing_subscription_id FROM orgs WHERE slug = 'stolen'`)).toEqual({ plan: "free", plan_source: "granted", billing_subscription_id: null });
    expect((await grants()).map((g) => [g.person, g.status])).toEqual([["maya", "unused"]]);
    // Signed out: the gate's 401, like any session route.
    expect((await status("", session.id)).status).toBe(401);
  });

  it("the thief's look never reaches Stripe, so it cannot trigger a fulfilment either", async () => {
    const { session } = await buy("maya");
    const before = stripe.calls.length;
    await status(await buyer("mallory"), session.id);
    expect(stripe.calls).toHaveLength(before);
    expect(await grants()).toEqual([]);
  });

  it("a completed session Trov did not create, or whose reference was swapped, grants nothing", async () => {
    await seedPerson("maya", { member: false });
    // A Payment Link made in the dashboard: no row here.
    const foreign = { id: "cs_test_foreign", status: "complete", payment_status: "paid", mode: "subscription", subscription: "sub_foreign", customer: "cus_f", client_reference_id: "maya", metadata: { trov_ref: "guessed", trov_person: "maya" } };
    expect((await deliver(event("checkout.session.completed", foreign))).json).toEqual({ ok: true, outcome: "unknown_checkout" });
    // Trov's session, but the payload names another reference.
    const { session } = await buy("omar");
    expect((await deliver(event("checkout.session.completed", { ...stripe.sessionJson(session), metadata: { trov_ref: "someone-elses" } }))).json).toEqual({ ok: true, outcome: "ref_mismatch" });
    // Trov's session, not paid (an async payment method still pending).
    expect((await deliver(event("checkout.session.completed", { ...stripe.sessionJson(session), payment_status: "unpaid" }))).json).toEqual({ ok: true, outcome: "not_paid" });
    expect(await grants()).toEqual([]);
    // …and when that payment later succeeds, its own event fulfils it.
    expect((await deliver(event("checkout.session.async_payment_succeeded", stripe.sessionJson(session)))).json).toEqual({ ok: true, outcome: "granted" });
    expect((await grants()).map((g) => g.person)).toEqual(["omar"]);
  });

  it("the grant follows the PERSON who started the checkout, even renamed in between; the client_reference_id is not what decides", async () => {
    const { session, completed } = await buy("maya");
    expect(await renamePerson(platformCtx(), "maya", "maya-renamed")).toEqual({ ok: true });
    session.client_reference_id = "mallory"; // whatever the payload says
    await deliver(completed());
    expect((await grants()).map((g) => g.person)).toEqual(["maya-renamed"]);
  });
});

describe("a second purchase", () => {
  it("an owner who buys again gets a second grant — a second organization — and the pricing page is told about the first", async () => {
    const a = await buy("maya"); // one seat: a person on their own
    await deliver(a.completed());
    await call("POST", "/api/orgs", a.cookie, { slug: "maya-solo", name: "Maya solo" });
    const cfg = (await bcall<BillingConfigResponse>("GET", "/api/billing/config", a.cookie)).json;
    expect(cfg.signed_in).toBe(true);
    expect(cfg.manage).toEqual([{ slug: "maya-solo", name: "Maya solo", plan: "team", status: "active", href: "/maya-solo/#org/general" }]);
    // Someone who only belongs to it (or owns a granted org) is offered nothing to manage.
    expect((await bcall<BillingConfigResponse>("GET", "/api/billing/config", await cookieFor(SUPERADMIN))).json.manage).toEqual([]);

    const b = await buy("maya", "team", "", 6);
    await deliver(b.completed());
    expect((await grants()).map((g) => [g.plan, g.status, g.external_ref])).toEqual([["team", "used", a.sub.id], ["team", "unused", b.sub.id]]);
    await call("POST", "/api/orgs", b.cookie, { slug: "maya-team", name: "Maya team" });
    expect(await rows(`SELECT slug, plan, plan_overrides, billing_subscription_id FROM orgs WHERE plan_source = 'billing' ORDER BY slug`)).toEqual([
      { slug: "maya-solo", plan: "team", plan_overrides: '{"seats":1}', billing_subscription_id: a.sub.id },
      { slug: "maya-team", plan: "team", plan_overrides: '{"seats":6}', billing_subscription_id: b.sub.id },
    ]);
  });
});

describe("events in any order", () => {
  it("subscription events before checkout.session.completed are held off, then fulfilment reads the CURRENT state", async () => {
    const { cookie, sub, completed } = await buy("maya", "team", "", 2);
    // Not Trov's yet (no row): acknowledged, and not worth a Stripe call.
    const calls = stripe.calls.length;
    expect((await deliver(subEvent("customer.subscription.created", sub.id))).json).toEqual({ ok: true, outcome: "unknown_subscription" });
    expect((await deliver(event("invoice.paid", { id: "in_1", subscription: sub.id }))).json).toEqual({ ok: true, outcome: "unknown_subscription" });
    expect(stripe.calls).toHaveLength(calls);
    // Meanwhile the buyer added seats in Stripe.
    sub.quantity = 5;
    await deliver(completed());
    expect((await grants())[0]).toMatchObject({ plan: "team", status: "unused" });
    await call("POST", "/api/orgs", cookie, { slug: "maya-co", name: "Maya" });
    expect(await one(`SELECT plan, plan_overrides FROM orgs WHERE slug = 'maya-co'`)).toEqual({ plan: "team", plan_overrides: '{"seats":5}' });
  });

  it("a stale event cannot move an org backwards: every handler re-reads the subscription", async () => {
    const { cookie, sub, completed } = await buy("maya", "team");
    await deliver(completed());
    await call("POST", "/api/orgs", cookie, { slug: "maya-co", name: "Maya" });
    // Stripe's truth: paid, period 2. An OLD `past_due` payload arrives late — and one for a failed invoice after the paid one.
    const stalePastDue = event("customer.subscription.updated", { ...stripe.subscriptionJson(sub), status: "past_due" });
    sub.current_period_end = PERIOD_1 + 100;
    for (const ev of [event("invoice.paid", { id: "in_2", subscription: sub.id }), stalePastDue, event("invoice.payment_failed", { id: "in_1", subscription: sub.id })]) {
      expect((await deliver(ev)).status).toBe(200);
    }
    expect(await one(`SELECT plan_status, plan_period_end FROM orgs WHERE slug = 'maya-co'`)).toEqual({ plan_status: "active", plan_period_end: iso(PERIOD_1 + 100) });
  });

  it("deleted before completed: the subscription is recorded as ended and no grant is made", async () => {
    const { cookie, session, sub, completed } = await buy("maya");
    sub.status = "canceled";
    expect((await deliver(subEvent("customer.subscription.deleted", sub.id))).json).toEqual({ ok: true, outcome: "unknown_subscription" });
    expect((await deliver(completed())).json).toEqual({ ok: true, outcome: "no_org" });
    expect(await grants()).toEqual([]);
    expect((await myOrgs(cookie)).grants).toEqual([]);
    expect((await one<{ stripe_status: string; plan_status: string }>(`SELECT stripe_status, plan_status FROM billing_subscriptions`))).toEqual({ stripe_status: "canceled", plan_status: "canceled" });
    expect((await status(cookie, session.id)).json).toEqual({ state: "pending", paid: true });
  });

  it("the invoice's subscription is found in either API shape", async () => {
    const { sub, completed } = await buy("maya");
    await deliver(completed());
    sub.current_period_end = PERIOD_1 + 7;
    expect((await deliver(event("invoice.paid", { id: "in_new", parent: { subscription_details: { subscription: sub.id } } }))).json).toEqual({ ok: true, outcome: "grant_waiting" });
    expect((await one<{ period_end: string }>(`SELECT period_end FROM billing_subscriptions`))!.period_end).toBe(iso(PERIOD_1 + 7));
    expect((await deliver(event("invoice.paid", { id: "in_none" }))).json).toEqual({ ok: true, outcome: "ignored" });
    expect((await deliver(event("customer.created", { id: "cus_1" }))).json).toEqual({ ok: true, outcome: "ignored" });
  });
});

describe("the superadmin still sees a paid grant like any other", () => {
  it("Platform › Access lists it as billing's, with the buyer and the plan", async () => {
    const { completed } = await buy("maya", "team", "", 3);
    await deliver(completed());
    const list = (await call<{ grants: PlatformGrant[] }>("GET", "/api/platform/grants", await cookieFor(SUPERADMIN))).json.grants;
    expect(list).toMatchObject([{ handle: "maya", plan: "team", overrides: { seats: 3 }, source: "billing", granted_by: "billing", status: "unused", note: "Paid through Stripe", mail_status: "sent" }]);
  });
});
