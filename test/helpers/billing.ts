// A stand-in for Stripe, for the billing suites: an in-memory account behind a `fetch` that answers the
// handful of endpoints src/billing/ calls, the way Stripe does. NOTHING here reaches the network — a
// request to any other host, or to an endpoint the stand-in does not know, fails the test.
import { env } from "cloudflare:test";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { app } from "../../src/routes";

export const STRIPE_KEY = "sk_test_51TrovFakeKeyForTests0000000000000000000000000000000000000000";
export const WEBHOOK_SECRET = "whsec_test_0123456789abcdef0123456789abcdef";
export const PRICES = { team: "price_team_m", team_year: "price_team_y" } as const;
/** A PUBLISHABLE key of the same (test) mode as `STRIPE_KEY`: set it and checkout is embedded. Public by design. */
export const PUBLISHABLE_KEY = "pk_test_51TrovFakePublishableKeyForTests000000000000000000000000000000";
export const embeddedEnv = (over: Partial<Env> = {}): Env => billingEnv({ STRIPE_PUBLISHABLE_KEY: PUBLISHABLE_KEY, ...over });

/** The pool's env with billing switched ON (the pool default is off — vitest.config.ts). */
export const billingEnv = (over: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_TEAM: PRICES.team, STRIPE_PRICE_TEAM_YEARLY: PRICES.team_year,
  ...over,
});

export interface FakeSession {
  id: string; url: string; status: "open" | "complete" | "expired"; payment_status: "unpaid" | "paid" | "no_payment_required"; mode: string;
  subscription: string | null; customer: string | null; customer_email: string | null; client_reference_id: string | null;
  metadata: Record<string, string>; price: string; success_url: string; cancel_url: string;
  /** The line item's quantity — the seats a per-seat checkout starts at (the buyer may change it on Stripe's page). */
  quantity: number;
  /** `hosted` (Stripe's page, a `url`) or `embedded` (Trov's page: a `client_secret` and a `return_url`, no `url`). */
  ui_mode: "hosted" | "embedded";
  return_url: string;
  client_secret: string | null;
}
export interface FakeSubscription {
  id: string; customer: string; status: string; cancel_at_period_end: boolean; cancel_at: number | null; current_period_end: number;
  livemode: boolean; price: string; item: string; metadata: Record<string, string>;
  /** The item's quantity: the seats paid for. */
  quantity: number;
}
export interface StripeCall { method: string; path: string; params: URLSearchParams; headers: Headers }

export const PERIOD_1 = 1_800_000_000; // 2027-01-15T08:00:00Z
export const PERIOD_2 = 1_802_678_400; // a month on
export const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

export class FakeStripe {
  calls: StripeCall[] = [];
  sessions = new Map<string, FakeSession>();
  subscriptions = new Map<string, FakeSubscription>();
  portals: { customer: string; return_url: string; flow: URLSearchParams }[] = [];
  private n = 0;
  /** Set to make every call fail the way a broken upstream would. */
  fail: ((call: StripeCall) => Response | null) | null = null;

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.origin !== "https://api.stripe.com") throw new Error(`a billing test reached for ${url.origin}`);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const params = method === "GET" ? url.searchParams : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    const call: StripeCall = { method, path: url.pathname, params, headers };
    this.calls.push(call);
    const failed = this.fail?.(call);
    if (failed) return failed;
    if (headers.get("authorization") !== `Bearer ${STRIPE_KEY}`) return Response.json({ error: { type: "invalid_request_error", message: "Invalid API Key provided" } }, { status: 401 });
    return this.route(call);
  }) as typeof fetch;

  private route(c: StripeCall): Response {
    const notFound = () => Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, { status: 404 });
    if (c.method === "POST" && c.path === "/v1/checkout/sessions") {
      // Stripe answers a repeated idempotency key with the first answer.
      const key = c.headers.get("idempotency-key") ?? "";
      const held = [...this.sessions.values()].find((s) => s.metadata.__idem === key);
      if (held) return Response.json(this.sessionJson(held));
      // Stripe refuses an embedded session that names the hosted page's URLs, and one with nowhere to return to.
      const ui = c.params.get("ui_mode") ?? "hosted";
      const bad = (message: string) => Response.json({ error: { type: "invalid_request_error", code: "parameter_invalid", message } }, { status: 400 });
      if (ui !== "hosted" && ui !== "embedded") return bad(`Invalid ui_mode: ${ui}`);
      if (ui === "embedded" && (c.params.has("success_url") || c.params.has("cancel_url"))) return bad("You can not pass `success_url` or `cancel_url` in `embedded` mode.");
      if (ui === "embedded" && !c.params.get("return_url")) return bad("`return_url` is required in `embedded` mode.");
      if (ui === "hosted" && !c.params.get("success_url")) return bad("`success_url` is required.");
      const id = `cs_test_${++this.n}`;
      const metadata: Record<string, string> = { __idem: key };
      for (const [k, v] of c.params) { const m = /^metadata\[(\w+)\]$/.exec(k); if (m) metadata[m[1]] = v; }
      const s: FakeSession = {
        id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open", payment_status: "unpaid", mode: c.params.get("mode") ?? "",
        subscription: null, customer: c.params.get("customer"), customer_email: c.params.get("customer_email"), client_reference_id: c.params.get("client_reference_id"),
        metadata, price: c.params.get("line_items[0][price]") ?? "", success_url: c.params.get("success_url") ?? "", cancel_url: c.params.get("cancel_url") ?? "",
        quantity: Number(c.params.get("line_items[0][quantity]") ?? "1"),
        ui_mode: ui, return_url: c.params.get("return_url") ?? "",
        client_secret: ui === "embedded" ? `${id}_secret_${[...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("")}` : null,
      };
      this.sessions.set(id, s);
      return Response.json(this.sessionJson(s));
    }
    let m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(c.path);
    if (c.method === "GET" && m) { const s = this.sessions.get(m[1]); return s ? Response.json(this.sessionJson(s)) : notFound(); }
    m = /^\/v1\/subscriptions\/([^/]+)$/.exec(c.path);
    if (c.method === "GET" && m) { const s = this.subscriptions.get(m[1]); return s ? Response.json(this.subscriptionJson(s)) : notFound(); }
    if (c.method === "POST" && c.path === "/v1/billing_portal/sessions") {
      this.portals.push({ customer: c.params.get("customer") ?? "", return_url: c.params.get("return_url") ?? "", flow: c.params });
      return Response.json({ id: `bps_${++this.n}`, object: "billing_portal.session", url: `https://billing.stripe.com/p/session/test_${this.n}` });
    }
    throw new Error(`the Stripe stand-in has no ${c.method} ${c.path}`);
  }

  sessionJson(s: FakeSession): Record<string, unknown> {
    const { __idem: _idem, ...metadata } = s.metadata;
    return { id: s.id, object: "checkout.session", url: s.status === "open" && s.ui_mode === "hosted" ? s.url : null, ui_mode: s.ui_mode,
      client_secret: s.status === "open" ? s.client_secret : null, return_url: s.ui_mode === "embedded" ? s.return_url : null, status: s.status, payment_status: s.payment_status, mode: s.mode,
      subscription: s.subscription, customer: s.customer, customer_email: s.customer_email, client_reference_id: s.client_reference_id, metadata, livemode: false };
  }
  subscriptionJson(s: FakeSubscription): Record<string, unknown> {
    return { id: s.id, object: "subscription", customer: s.customer, status: s.status, cancel_at_period_end: s.cancel_at_period_end, cancel_at: s.cancel_at,
      current_period_end: s.current_period_end, livemode: s.livemode, metadata: s.metadata, items: { object: "list", data: [{ id: s.item, object: "subscription_item", price: { id: s.price, object: "price" }, quantity: s.quantity }] } };
  }

  /** The buyer pays at Stripe's checkout: the session completes, and its subscription and customer exist.
   *  `seats` = the quantity they settled on there (default: the one the checkout started at). */
  pay(sessionId: string, seats?: number): FakeSubscription {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`no session ${sessionId}`);
    const sub: FakeSubscription = {
      id: `sub_test_${++this.n}`, customer: s.customer ?? `cus_test_${this.n}`, status: "active", cancel_at_period_end: false, cancel_at: null,
      current_period_end: PERIOD_1, livemode: false, price: s.price, item: `si_test_${this.n}`, metadata: {}, quantity: seats ?? s.quantity,
    };
    this.subscriptions.set(sub.id, sub);
    Object.assign(s, { status: "complete", payment_status: "paid", subscription: sub.id, customer: sub.customer });
    return sub;
  }
  /** The last Checkout Session created. */
  lastSession(): FakeSession { return [...this.sessions.values()].at(-1)!; }
  callsTo(method: string, path: string | RegExp): StripeCall[] {
    return this.calls.filter((c) => c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path)));
  }
}

// ── events ───────────────────────────────────────────────────────────────────

let eventN = 0;
export interface FakeEvent { id: string; object: "event"; type: string; livemode: boolean; created: number; data: { object: unknown } }
export const event = (type: string, object: unknown, o: { id?: string; livemode?: boolean } = {}): FakeEvent =>
  ({ id: o.id ?? `evt_test_${++eventN}`, object: "event", type, livemode: o.livemode ?? false, created: Math.floor(Date.now() / 1000), data: { object } });

/** The `Stripe-Signature` header Stripe would send for `rawBody`. */
export async function signature(rawBody: string, secret: string = WEBHOOK_SECRET, timestampS: number = Math.floor(Date.now() / 1000)): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestampS}.${rawBody}`)));
  return `t=${timestampS},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const noCtx = { waitUntil() { /* nothing to wait for */ }, passThroughOnException() { /* unused */ } } as unknown as ExecutionContext;

/** POST one request to the Worker's own entry point (src/index.ts), as Stripe would. */
export async function postWebhook(rawBody: string, headers: Record<string, string>, e: Env = billingEnv()): Promise<{ status: number; text: string; json: Record<string, unknown> | null; headers: Headers }> {
  const res = await worker.fetch(new Request("https://trov.test/webhook/stripe", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: rawBody }), e, noCtx);
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: res.status, text, json, headers: res.headers };
}
/** Deliver one signed event. */
export async function deliver(ev: FakeEvent, e: Env = billingEnv()): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const raw = JSON.stringify(ev);
  return postWebhook(raw, { "stripe-signature": await signature(raw) }, e);
}

/** One request against the app with billing ON. `cookie` = "" for a signed-out visitor. */
export async function bcall<T = Record<string, unknown>>(method: string, path: string, cookie: string, body?: unknown, o: { env?: Env; headers?: Record<string, string> } = {}): Promise<{ status: number; json: T; text: string; headers: Headers }> {
  const res = await app.request(path, {
    method, redirect: "manual",
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...o.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, o.env ?? billingEnv());
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* a page or a redirect */ }
  return { status: res.status, json: json as T, text, headers: res.headers };
}
