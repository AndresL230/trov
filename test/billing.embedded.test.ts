/**
 * Embedded checkout (docs/architecture/billing.md › Embedded checkout): with `STRIPE_PUBLISHABLE_KEY` set,
 * a buyer pays on Trov's own page (`/billing/checkout`) with Stripe's embedded form instead of being sent to
 * Stripe's hosted page. Against the stand-in Stripe (test/helpers/billing.ts — nothing reaches the network,
 * and it refuses what the real one refuses: `success_url` / `cancel_url` on an embedded session).
 *
 * What must hold: ONE switch decides between the two (`BillingConfig.embedded`); with it off nothing has
 * changed; with it on the session differs ONLY in `ui_mode` + `return_url`; the client secret reaches the
 * signed-in buyer and nobody else; and the page's fallback gets a hosted session whatever the switch says.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { BillingCheckoutResponse, BillingConfigResponse, BillingStatusResponse } from "@shared/billing";
import { billingCheckoutHref } from "@shared/billing";
import { billingConfig, publishableKeyMode } from "../src/billing/config";
import { LIMITS } from "../src/platform/limits";
import { cookieFor } from "./helpers/persons";
import { call, one, rows, SUPERADMIN } from "./helpers/orgs";
import { FakeStripe, PRICES, PUBLISHABLE_KEY, STRIPE_KEY, bcall, billingEnv, deliver, embeddedEnv, event } from "./helpers/billing";

let stripe: FakeStripe;
beforeEach(() => { stripe = new FakeStripe(); vi.stubGlobal("fetch", stripe.fetch); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ON = embeddedEnv();
const buyer = (handle: string) => cookieFor(handle, { member: false, email: `${handle}@example.com`, verified: true });
const checkouts = () => rows<Record<string, unknown>>(`SELECT * FROM billing_checkouts ORDER BY created_at, ref`);
const page = (cookie: string, body: Record<string, unknown>, e: Env = ON, path = "/api/billing/checkout") => bcall<BillingCheckoutResponse & { error?: string }>("POST", path, cookie, body, { env: e });
const sessionCalls = () => stripe.callsTo("POST", "/v1/checkout/sessions");

describe("the one switch: BillingConfig.embedded", () => {
  it("is on only for a publishable key of the secret key's own mode, against the real Stripe API", () => {
    expect(billingConfig(billingEnv())).toMatchObject({ embedded: false, publishableKey: null });
    expect(billingConfig(ON)).toMatchObject({ embedded: true, publishableKey: PUBLISHABLE_KEY, mode: "test" });
    expect(billingConfig(embeddedEnv({ STRIPE_PUBLISHABLE_KEY: `  ${PUBLISHABLE_KEY}  ` }))!.embedded).toBe(true);
    // The other mode: a live publishable key beside a test secret key (and the reverse) cannot mount the session.
    expect(billingConfig(embeddedEnv({ STRIPE_PUBLISHABLE_KEY: "pk_live_51Abc" }))).toMatchObject({ embedded: false, publishableKey: "pk_live_51Abc" });
    expect(billingConfig(embeddedEnv({ STRIPE_SECRET_KEY: "sk_live_51Abc", STRIPE_PUBLISHABLE_KEY: "pk_test_51Abc" }))!.embedded).toBe(false);
    expect(billingConfig(embeddedEnv({ STRIPE_SECRET_KEY: "sk_live_51Abc", STRIPE_PUBLISHABLE_KEY: "pk_live_51Abc" }))!.embedded).toBe(true);
    // The loopback stand-in serves no Stripe.js: hosted, whatever the key says.
    expect(billingConfig(embeddedEnv({ STRIPE_TEST_API_BASE: "http://127.0.0.1:8842" }))).toMatchObject({ embedded: false, apiBase: "http://127.0.0.1:8842" });
    // Anything that is not a publishable key is not one — above all a SECRET key pasted into the public var.
    for (const v of ["", "  ", "on", "true", "pk_", "pk_test_", STRIPE_KEY, "sk_live_51Abc", "rk_test_51Abc", "whsec_abc", "pk_test_has space"]) {
      expect(billingConfig(embeddedEnv({ STRIPE_PUBLISHABLE_KEY: v })), v).toMatchObject({ embedded: false, publishableKey: null });
    }
    expect([publishableKeyMode("pk_test_1a"), publishableKeyMode("pk_live_1a"), publishableKeyMode("sk_test_1a"), publishableKeyMode(undefined)]).toEqual(["test", "live", null, null]);
  });

  it("GET /api/billing/config says whether checkout is embedded, and never the key", async () => {
    const off = await bcall<BillingConfigResponse>("GET", "/api/billing/config", "");
    const on = await bcall<BillingConfigResponse>("GET", "/api/billing/config", "", undefined, { env: ON });
    expect([off.json.embedded, on.json.embedded]).toEqual([undefined, true]); // present only while it is on
    expect((await bcall<BillingConfigResponse>("GET", "/api/billing/config", "", undefined, { env: { ...(env as unknown as Env) } })).json.embedded).toBeUndefined();
    expect(on.text).not.toContain("pk_test");
    expect(on.text).not.toContain(STRIPE_KEY);
  });
});

describe("embedded OFF — everything is the hosted flow, unchanged", () => {
  it("GET /billing/start still creates a hosted session and redirects to Stripe (key unset, wrong mode, or the loopback stand-in)", async () => {
    const cookie = await buyer("maya");
    // The loopback base is honoured for real by the client, so it gets its own stand-in at that origin.
    const loop = "http://127.0.0.1:8842";
    const looped = (async (input: RequestInfo | URL, init?: RequestInit) => stripe.fetch(String(input).replace(loop, "https://api.stripe.com"), init)) as typeof fetch;
    const cases: [string, Env, typeof fetch][] = [
      ["unset", billingEnv(), stripe.fetch],
      ["a live publishable key beside a test secret key", embeddedEnv({ STRIPE_PUBLISHABLE_KEY: "pk_live_51Abc" }), stripe.fetch],
      ["the loopback stand-in", embeddedEnv({ STRIPE_TEST_API_BASE: loop }), looped],
    ];
    for (const [name, e, f] of cases) {
      vi.stubGlobal("fetch", f);
      const before = sessionCalls().length;
      const r = await bcall("GET", "/billing/start?plan=team", cookie, undefined, { env: e });
      expect(r.status, name).toBe(303);
      expect(r.headers.get("location"), name).toBe(stripe.lastSession().url);
      const c = sessionCalls().at(-1)!;
      expect(sessionCalls().length, name).toBe(before + 1);
      expect(c.params.get("success_url"), name).toBe("http://localhost/billing/done?session_id={CHECKOUT_SESSION_ID}");
      expect(c.params.get("cancel_url"), name).toBe("http://localhost/pricing");
      expect([c.params.has("ui_mode"), c.params.has("return_url")], name).toEqual([false, false]);
    }
  });

  it("the payment page, reached anyway, is answered Stripe's hosted URL — and the org's upgrade button a Stripe URL", async () => {
    const cookie = await buyer("maya");
    const r = await page(cookie, { plan: "team", ui: "embedded" }, billingEnv());
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ui: "hosted", url: stripe.lastSession().url });
    expect(stripe.lastSession()).toMatchObject({ ui_mode: "hosted", client_secret: null });
    expect((await call("POST", "/api/orgs", cookie, { slug: "maya-free", name: "Maya Free" })).status).toBe(201);
    const up = await bcall<{ url: string }>("POST", "/api/o/maya-free/billing/upgrade", cookie, {});
    expect(up.json).toEqual({ url: stripe.lastSession().url });
    expect(up.json.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });
});

describe("embedded ON — a new purchase", () => {
  it("GET /billing/start sends the signed-in buyer to Trov's own payment page and creates nothing; signed out it is the same sign-in as ever", async () => {
    const cookie = await buyer("maya");
    const r = await bcall("GET", "/billing/start?plan=team", cookie, undefined, { env: ON });
    expect([r.status, r.headers.get("location")]).toEqual([303, "/billing/checkout?plan=team"]);
    const y = await bcall("GET", "/billing/start?plan=team&interval=year", cookie, undefined, { env: ON });
    expect(y.headers.get("location")).toBe("/billing/checkout?plan=team&interval=year");
    expect(stripe.calls).toHaveLength(0);
    expect(await checkouts()).toEqual([]);
    // Signed out: nothing about the sign-in changed.
    const out = await bcall("GET", "/billing/start?plan=team", "", undefined, { env: ON });
    expect([out.status, out.headers.get("location")]).toEqual([302, "/?start=team"]);
    expect((await bcall("GET", "/billing/start?plan=team&via=google", "", undefined, { env: ON })).headers.get("location")).toBe("/auth/google/login");
    // A superadmin is told to use Platform before any page is offered.
    expect((await bcall("GET", "/billing/start?plan=team", await cookieFor(SUPERADMIN), undefined, { env: ON })).status).toBe(403);
  });

  it("the page's call creates ONE embedded session — ui_mode + return_url in place of success_url / cancel_url, every other parameter the hosted flow's — and returns its client secret with the publishable key", async () => {
    const cookie = await buyer("maya");
    const r = await page(cookie, { plan: "team", ui: "embedded" });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const session = stripe.lastSession();
    expect(session.client_secret).toMatch(/^cs_test_\d+_secret_[0-9a-f]{48}$/);
    expect(r.json).toEqual({ ui: "embedded", client_secret: session.client_secret, publishable_key: PUBLISHABLE_KEY, session_id: session.id });
    expect(stripe.calls).toHaveLength(1);
    const [c] = sessionCalls();
    const row = (await one<{ ref: string; person: string; plan: string; interval: string; for_org: string | null; session_id: string }>(`SELECT ref, person, plan, interval, for_org, session_id FROM billing_checkouts`))!;
    expect(row).toMatchObject({ person: "maya", plan: "team", interval: "month", for_org: null, session_id: session.id });
    expect(Object.fromEntries(c.params)).toEqual({
      mode: "subscription", "line_items[0][price]": PRICES.team, "line_items[0][quantity]": "1",
      "line_items[0][adjustable_quantity][enabled]": "true", "line_items[0][adjustable_quantity][minimum]": "1", "line_items[0][adjustable_quantity][maximum]": "50",
      client_reference_id: "maya", customer_email: "maya@example.com",
      ui_mode: "embedded", return_url: "http://localhost/billing/done?session_id={CHECKOUT_SESSION_ID}",
      "metadata[trov_ref]": row.ref, "metadata[trov_plan]": "team", "metadata[trov_person]": "maya",
      "subscription_data[metadata][trov_ref]": row.ref, "subscription_data[metadata][trov_plan]": "team", "subscription_data[metadata][trov_person]": "maya",
    });
    expect(c.headers.get("idempotency-key")).toBe(`trov-checkout-${row.ref}`);
    // The secret is in no column of the row Trov keeps.
    expect(JSON.stringify(await checkouts())).not.toContain("_secret_");
  });

  it("carries the tax parameters when STRIPE_TAX is on, and the yearly price when asked", async () => {
    const cookie = await buyer("maya");
    const r = await page(cookie, { plan: "team", interval: "year", ui: "embedded" }, embeddedEnv({ STRIPE_TAX: "on" }));
    expect(r.json).toMatchObject({ ui: "embedded" });
    const p = Object.fromEntries(sessionCalls()[0].params);
    expect(p).toMatchObject({ ui_mode: "embedded", "line_items[0][price]": PRICES.team_year, "automatic_tax[enabled]": "true", "tax_id_collection[enabled]": "true" });
    expect(Object.keys(p).filter((k) => k === "success_url" || k === "cancel_url" || k.startsWith("customer_update"))).toEqual([]);
  });

  it("answers the signed-in buyer only: signed out, a bearer, a superadmin, a plan not sold and billing off get no session and no secret", async () => {
    const cookie = await buyer("maya");
    const refused: [string, { status: number; text: string; json: { error?: string } }, number, string][] = [
      ["signed out", await page("", { plan: "team", ui: "embedded" }), 401, "unauthorized"],
      ["a bearer beside the cookie", await bcall("POST", "/api/billing/checkout", cookie, { plan: "team", ui: "embedded" }, { env: ON, headers: { authorization: "Bearer canopy_mcp_x" } }), 403, "forbidden"],
      ["a superadmin", await page(await cookieFor(SUPERADMIN), { plan: "team", ui: "embedded" }), 403, "superadmin"],
      ["enterprise", await page(cookie, { plan: "enterprise", ui: "embedded" }), 400, "invalid_plan"],
      ["no plan", await page(cookie, { ui: "embedded" }), 400, "invalid_plan"],
      ["billing off", await page(cookie, { plan: "team", ui: "embedded" }, { ...(env as unknown as Env) }), 503, "billing_unavailable"],
    ];
    for (const [name, r, status, error] of refused) {
      expect([r.status, r.json?.error], name).toEqual([status, error]);
      expect(r.text, name).not.toContain("_secret_");
    }
    expect(stripe.calls).toHaveLength(0);
    expect(await checkouts()).toEqual([]);
  });

  it("a Stripe failure is a 502 with nothing charged and no row kept; the daily limit is a 429", async () => {
    const cookie = await buyer("maya");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stripe.fail = () => Response.json({ error: { type: "api_error", message: "down" } }, { status: 500 });
    const r = await page(cookie, { plan: "team", ui: "embedded" });
    expect([r.status, r.json.error]).toEqual([502, "billing_failed"]);
    expect(await checkouts()).toEqual([]);
    expect(errors).toHaveBeenCalled();
    stripe.fail = null;
    // An answer with no client secret is not one to hand a page.
    stripe.fail = (c) => (c.method === "POST" ? Response.json({ id: "cs_test_x", ui_mode: "embedded", client_secret: null }) : null);
    expect((await page(cookie, { plan: "team", ui: "embedded" })).status).toBe(502);
    stripe.fail = null;
    for (let i = 2; i < LIMITS.checkout.max; i++) expect((await page(cookie, { plan: "team", ui: "embedded" })).status, `#${i}`).toBe(200);
    const over = await page(cookie, { plan: "team", ui: "embedded" });
    expect([over.status, over.json.error]).toEqual([429, "rate_limited"]);
    expect(over.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});

describe("embedded ON — the session the page already showed", () => {
  it("a reload resumes the SAME open session (no new Stripe object, no unit of the daily limit)", async () => {
    const cookie = await buyer("maya");
    const first = (await page(cookie, { plan: "team", ui: "embedded" })).json as Extract<BillingCheckoutResponse, { ui: "embedded" }>;
    for (let i = 0; i < LIMITS.checkout.max + 2; i++) {
      const again = await page(cookie, { plan: "team", ui: "embedded", session_id: first.session_id });
      expect(again.json).toEqual(first);
    }
    expect(sessionCalls()).toHaveLength(1);
    expect(await checkouts()).toHaveLength(1);
  });

  it("paid → `complete` (never a second form); expired → `expired`; and the waiting room then fulfils exactly as for a hosted checkout", async () => {
    const cookie = await buyer("maya");
    const first = (await page(cookie, { plan: "team", ui: "embedded" })).json as Extract<BillingCheckoutResponse, { ui: "embedded" }>;
    const session = stripe.sessions.get(first.session_id)!;
    expect(session.return_url).toBe("http://localhost/billing/done?session_id={CHECKOUT_SESSION_ID}");
    stripe.pay(session.id, 3);
    // Paid at Stripe, the webhook not yet here: Back from the confirmation must not offer to pay again.
    expect((await page(cookie, { plan: "team", ui: "embedded", session_id: session.id })).json).toEqual({ ui: "complete", session_id: session.id });
    // …nor may the fallback start a hosted session for a purchase already paid.
    expect((await page(cookie, { plan: "team", ui: "hosted", session_id: session.id })).json).toEqual({ ui: "complete", session_id: session.id });
    expect(sessionCalls()).toHaveLength(1);
    // The browser's return proved nothing: there is no grant until the webhook (or the status look) says so.
    expect(await rows(`SELECT id FROM org_grants`)).toEqual([]);
    expect((await deliver(event("checkout.session.completed", stripe.sessionJson(session)), ON)).status).toBe(200);
    const st = await bcall<BillingStatusResponse>("GET", `/api/billing/status?session_id=${session.id}`, cookie, undefined, { env: ON });
    expect(st.json).toMatchObject({ state: "ready", plan: "team" });
    expect(await one(`SELECT overrides FROM org_grants`)).toEqual({ overrides: '{"seats":3}' });
    // Fulfilled: `complete` now comes from Trov's own row, with no call to Stripe.
    const calls = stripe.calls.length;
    expect((await page(cookie, { plan: "team", ui: "embedded", session_id: session.id })).json).toEqual({ ui: "complete", session_id: session.id });
    expect(stripe.calls).toHaveLength(calls);

    const second = (await page(cookie, { plan: "team", ui: "embedded" })).json as Extract<BillingCheckoutResponse, { ui: "embedded" }>;
    stripe.sessions.get(second.session_id)!.status = "expired";
    expect((await page(cookie, { plan: "team", ui: "embedded", session_id: second.session_id })).json).toEqual({ ui: "expired" });
  });

  it("someone else's session id, an unknown one and a malformed one claim nothing: the caller just gets a session of their own", async () => {
    const maya = await buyer("maya"), omar = await buyer("omar");
    const hers = (await page(maya, { plan: "team", ui: "embedded" })).json as Extract<BillingCheckoutResponse, { ui: "embedded" }>;
    stripe.pay(hers.session_id);
    for (const id of [hers.session_id, "cs_test_999", "not a session", "cs_../v1/customers"]) {
      const r = await page(omar, { plan: "team", ui: "embedded", session_id: id });
      expect(r.json.ui, id).toBe("embedded");
      const mine = r.json as Extract<BillingCheckoutResponse, { ui: "embedded" }>;
      expect(mine.session_id, id).not.toBe(hers.session_id);
      expect(mine.client_secret, id).not.toBe(hers.client_secret);
      expect(r.text, id).not.toContain(hers.client_secret);
    }
    // Stripe was never asked about her session on his behalf.
    expect(stripe.callsTo("GET", /checkout\/sessions/)).toHaveLength(0);
    expect((await rows<{ person: string }>(`SELECT person FROM billing_checkouts WHERE person = 'omar'`))).toHaveLength(4);
  });

  it("when Stripe cannot say what became of the session, the page is refused rather than handed a second one", async () => {
    const cookie = await buyer("maya");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = (await page(cookie, { plan: "team", ui: "embedded" })).json as Extract<BillingCheckoutResponse, { ui: "embedded" }>;
    stripe.fail = (c) => (c.method === "GET" ? Response.json({ error: { message: "down" } }, { status: 503 }) : null);
    const r = await page(cookie, { plan: "team", ui: "embedded", session_id: first.session_id });
    expect([r.status, r.json.error]).toEqual([502, "billing_failed"]);
    expect(sessionCalls()).toHaveLength(1);
  });
});

describe("the fallback: ui hosted", () => {
  it("is a hosted session for the same purchase whatever the switch says, with the hosted flow's own parameters", async () => {
    const cookie = await buyer("maya");
    const first = (await page(cookie, { plan: "team", ui: "embedded" })).json as Extract<BillingCheckoutResponse, { ui: "embedded" }>;
    const r = await page(cookie, { plan: "team", ui: "hosted", session_id: first.session_id });
    const hosted = stripe.lastSession();
    expect(r.json).toEqual({ ui: "hosted", url: hosted.url });
    expect(hosted).toMatchObject({ ui_mode: "hosted", client_secret: null, success_url: "http://localhost/billing/done?session_id={CHECKOUT_SESSION_ID}", cancel_url: "http://localhost/pricing", client_reference_id: "maya" });
    expect(hosted.id).not.toBe(first.session_id);
    expect(r.text).not.toContain("_secret_");
    const p = sessionCalls().at(-1)!.params;
    expect([p.has("ui_mode"), p.has("return_url")]).toEqual([false, false]);
  });
});

describe("embedded ON — upgrading a Free org", () => {
  it("the button is sent to the payment page for THAT org and creates nothing; the page's call is an embedded session for the org; the fallback a hosted one", async () => {
    const cookie = await buyer("maya");
    expect((await call("POST", "/api/orgs", cookie, { slug: "maya-free", name: "Maya Free" })).status).toBe(201);
    const up = "/api/o/maya-free/billing/upgrade";
    const button = await bcall<{ url: string }>("POST", up, cookie, { plan: "team" }, { env: ON });
    expect(button.json).toEqual({ url: billingCheckoutHref("team", "month", { org: "maya-free" }) });
    expect(button.json.url).toBe("/billing/checkout?plan=team&org=maya-free");
    expect(stripe.calls).toHaveLength(0);

    const r = await page(cookie, { plan: "team", ui: "embedded" }, embeddedEnv({ STRIPE_TAX: "on" }), up);
    const session = stripe.lastSession();
    expect(r.json).toEqual({ ui: "embedded", client_secret: session.client_secret, publishable_key: PUBLISHABLE_KEY, session_id: session.id });
    expect(r.headers.get("cache-control")).toBe("no-store");
    const p = Object.fromEntries(sessionCalls()[0].params);
    expect(p).toMatchObject({ ui_mode: "embedded", return_url: "http://localhost/billing/done?session_id={CHECKOUT_SESSION_ID}", "metadata[trov_org]": "maya-free", "automatic_tax[enabled]": "true", "tax_id_collection[enabled]": "true", customer_email: "maya@example.com" });
    expect([p.success_url, p.cancel_url]).toEqual([undefined, undefined]);
    expect(await one(`SELECT for_org IS NOT NULL AS for_org FROM billing_checkouts WHERE session_id = ?`, session.id)).toEqual({ for_org: 1 });
    // A reload resumes it; a session of the same person for ANOTHER purchase (no org) is not this page's.
    expect((await page(cookie, { plan: "team", ui: "embedded", session_id: session.id }, ON, up)).json).toMatchObject({ ui: "embedded", session_id: session.id });
    expect(((await page(cookie, { plan: "team", ui: "embedded", session_id: session.id })).json as { session_id: string }).session_id).not.toBe(session.id);

    const hosted = await page(cookie, { plan: "team", ui: "hosted" }, ON, up);
    expect(hosted.json).toEqual({ ui: "hosted", url: stripe.lastSession().url });
    expect(stripe.lastSession()).toMatchObject({ ui_mode: "hosted", cancel_url: "http://localhost/maya-free/#org/general" });

    // Paid: the org is upgraded by the webhook, as for a hosted checkout — and the page then has nothing to sell.
    stripe.pay(session.id);
    expect((await deliver(event("checkout.session.completed", stripe.sessionJson(session)), ON)).json).toEqual({ ok: true, outcome: "org_upgraded" });
    expect((await page(cookie, { plan: "team", ui: "embedded", session_id: session.id }, ON, up)).json).toMatchObject({ error: "not_free" });
    // Only its owner: a stranger is the membership gate's refusal, with no session made.
    const made = sessionCalls().length;
    const stranger = await page(await buyer("omar"), { plan: "team", ui: "embedded" }, ON, up);
    expect(stranger.status).toBeGreaterThanOrEqual(403);
    expect(stranger.text).not.toContain("_secret_");
    expect(sessionCalls()).toHaveLength(made);
  });
});

describe("the page itself", () => {
  const noCtx = { waitUntil() { /* nothing */ }, passThroughOnException() { /* unused */ } } as unknown as ExecutionContext;
  it("`/billing/checkout` is the SPA shell, asked of the assets binding like `/billing/done` — and carries no session of its own", async () => {
    const asked: string[] = [];
    const e = { ...ON, ASSETS: { fetch: async (req: Request) => { asked.push(new URL(req.url).pathname); return new Response("<!doctype html><div id=app></div>", { headers: { "content-type": "text/html" } }); } } } as unknown as Env;
    for (const path of ["/billing/checkout?plan=team", "/billing/done?session_id=cs_test_1"]) {
      const res = await worker.fetch(new Request(`https://trov.test${path}`), e, noCtx);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain("id=app");
    }
    expect(asked).toEqual(["/index.html", "/index.html"]);
    expect(stripe.calls).toHaveLength(0);
  });
});
