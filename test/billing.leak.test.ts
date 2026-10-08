/**
 * The Stripe secret key and the webhook secret are in NO response, NO log line, NO audit row and NO D1
 * column (docs/architecture/billing.md › Safety) — the canary method of test/secrets.leak.test.ts. Both
 * secrets are 64-character canaries; every scan looks for the canary and for every 8-character piece of
 * it. The stand-in Stripe does its worst: it echoes the request's Authorization header (and every other
 * header) straight back in its error bodies, in every shape an upstream fails in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { inspect } from "node:util";
import type { Env } from "../src/env";
import { StripeError, stripeCall } from "../src/billing/stripe";
import { billingConfig } from "../src/billing/config";
import { cookieFor } from "./helpers/persons";
import { call, exec } from "./helpers/orgs";
import { FakeStripe, bcall, billingEnv, event, postWebhook, signature } from "./helpers/billing";

const hex = async (label: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`canary:${label}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
let KEY = "", HOOK = "";
const canaries = new Map<string, string>();
/** The label of a canary `text` holds any 8-character piece of, or null. */
function leak(text: string): string | null {
  for (const [label, value] of canaries) for (let i = 0; i + 8 <= value.length; i++) if (text.includes(value.slice(i, i + 8))) return `${label} @${i}`;
  return null;
}
const expectClean = (text: string, where: string) => expect(leak(text), where).toBeNull();
const leaky = (): Env => billingEnv({ STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: HOOK });

// ── console: spied for the whole file ────────────────────────────────────────
const logged: unknown[][] = [];
function stringify(arg: unknown): string {
  const parts: string[] = [];
  const add = (f: () => unknown) => { try { parts.push(String(f())); } catch { /* unprintable that way */ } };
  add(() => arg);
  add(() => JSON.stringify(arg));
  add(() => inspect(arg, { depth: 8, showHidden: true, getters: true }));
  if (arg instanceof Error) { add(() => arg.message); add(() => arg.stack); add(() => inspect(arg.cause, { depth: 8, showHidden: true })); }
  if (arg && typeof arg === "object") add(() => JSON.stringify(Object.getOwnPropertyDescriptors(arg)));
  return parts.join("\n");
}

async function dumpD1(): Promise<string> {
  const tables = (await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ name: string }>()).results;
  expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["billing_events", "billing_checkouts", "billing_subscriptions", "org_admin_audit", "org_grants", "orgs"]));
  let out = "";
  for (const { name } of tables) {
    try { out += JSON.stringify((await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results); } catch { /* an FTS shadow table */ }
  }
  return out;
}

// ── upstreams that echo everything back ──────────────────────────────────────
type Echo = (dump: string) => Response;
const ECHOES: Record<string, Echo> = {
  "401 with the headers in Stripe's JSON error": (d) => Response.json({ error: { type: "invalid_request_error", code: `bad_${d}`, message: `Invalid API Key provided: ${d}` } }, { status: 401 }),
  "403 with the headers URL-encoded": (d) => Response.json({ error: { message: `nope ${encodeURIComponent(d)} ${d}` } }, { status: 403 }),
  "500 with a plain-text dump": (d) => new Response(`upstream crashed\n${d}\n${d}`, { status: 500 }),
  "502 where the key straddles the bounded read's cut": (d) => {
    const pad = "x".repeat(8192 - Math.floor(d.length / 2));
    const bytes = new TextEncoder().encode(pad + d + d);
    // Two chunks, split exactly at the cap — in the middle of the echoed credential.
    return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 8192)); c.enqueue(bytes.slice(8192)); c.close(); } }), { status: 502 });
  },
  "200 that is not JSON": (d) => new Response(`<html>${d}</html>`, { status: 200, headers: { "content-type": "text/html" } }),
  "200 JSON with the headers where a url should be": (d) => Response.json({ id: `cs_${d}`, url: `not a url ${d}`, status: d, customer: d }),
  "a redirect carrying the headers": (d) => new Response(null, { status: 302, headers: { location: `https://evil.example/?${encodeURIComponent(d)}` } }),
  "a network error quoting the request": (d) => { throw new TypeError(`fetch failed: ${d}`); },
};

let stripe: FakeStripe;
beforeEach(async () => {
  KEY ||= `sk_test_${await hex("stripe key")}`;
  HOOK ||= `whsec_${await hex("webhook secret")}`;
  canaries.set("stripe key", KEY.slice("sk_test_".length));
  canaries.set("webhook secret", HOOK.slice("whsec_".length));
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); });
  stripe = new FakeStripe();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const args of logged) for (const arg of args) expectClean(stringify(arg), "a console argument");
});

/** A Stripe that answers the real key normally — and, when `echo` is set, echoes the request back instead. */
function install(echo: Echo | null): void {
  const real = stripe.fetch;
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (echo) return echo(`${headers.get("authorization")} ${JSON.stringify([...headers])} ${String(init?.body ?? "")}`);
    // The stand-in checks the fixed test key; this file's key is the canary.
    headers.set("authorization", `Bearer ${(billingEnv()).STRIPE_SECRET_KEY}`);
    return real(input, { ...init, headers });
  }) as typeof fetch);
}

describe("the Stripe client", () => {
  it.each(Object.keys(ECHOES))("%s → a StripeError that holds no key, however it is printed", async (name) => {
    install(ECHOES[name]);
    const cfg = billingConfig(leaky())!;
    for (const [method, path] of [["POST", "/v1/checkout/sessions"], ["GET", "/v1/subscriptions/sub_1"]] as const) {
      let thrown: unknown = null;
      const ok = await stripeCall(cfg, method, path, { mode: "subscription" }, { idempotencyKey: "k" }).catch((e) => { thrown = e; return null; });
      expect(ok, `${name} ${path} resolved`).toBeNull(); // even a 200: an answer that echoes the key is refused whole
      expect(thrown).toBeInstanceOf(StripeError);
      expectClean(stringify(thrown), `${name} ${path} error`);
      expect((thrown as StripeError).message.length).toBeLessThanOrEqual(300);
    }
  });

  it("sends the key ONLY as the bearer of a request to api.stripe.com, never follows a redirect, and refuses a path or a mutation it should not send", async () => {
    const seen: { url: string; redirect: string | undefined; auth: string | null }[] = [];
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), redirect: init?.redirect, auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ id: "x" });
    }) as typeof fetch);
    const cfg = billingConfig(leaky())!;
    await stripeCall(cfg, "GET", "/v1/subscriptions/sub_1");
    await stripeCall(cfg, "POST", "/v1/billing_portal/sessions", { customer: "cus_1" }, { idempotencyKey: "k" });
    expect(seen).toEqual([
      { url: "https://api.stripe.com/v1/subscriptions/sub_1", redirect: "manual", auth: `Bearer ${KEY}` },
      { url: "https://api.stripe.com/v1/billing_portal/sessions", redirect: "manual", auth: `Bearer ${KEY}` },
    ]);
    await expect(stripeCall(cfg, "GET", "//evil.example/v1/x")).rejects.toBeInstanceOf(StripeError);
    await expect(stripeCall(cfg, "GET", "https://evil.example/v1/x")).rejects.toBeInstanceOf(StripeError);
    await expect(stripeCall(cfg, "POST", "/v1/checkout/sessions", {})).rejects.toThrow(/idempotency key/);
    expect(seen).toHaveLength(2);
  });
});

describe("every billing surface, against a Stripe that echoes the key back", () => {
  it.each(Object.keys(ECHOES))("%s", async (name) => {
    // A paid org to exercise the owner's routes, set up while Stripe still behaves.
    install(null);
    const e = leaky();
    const cookie = await cookieFor("maya", { member: false, email: "maya@example.com", verified: true });
    expect((await bcall("GET", "/billing/start?plan=team", cookie, undefined, { env: e })).status).toBe(303);
    const session = stripe.lastSession();
    const sub = stripe.pay(session.id);
    const completed = JSON.stringify(event("checkout.session.completed", stripe.sessionJson(session)));
    expect((await postWebhook(completed, { "stripe-signature": await signature(completed, HOOK) }, e)).status).toBe(200);
    expect((await call("POST", "/api/orgs", cookie, { slug: "maya-co", name: "Maya" })).status).toBe(201);
    // A second, unfulfilled checkout for the waiting room's own look at Stripe.
    await bcall("GET", "/billing/start?plan=team&interval=year", cookie, undefined, { env: e });
    const pending = stripe.lastSession();
    stripe.pay(pending.id);

    install(ECHOES[name]);
    const answers: [string, { status: number; text: string; headers: Headers }][] = [
      ["start", await bcall("GET", "/billing/start?plan=team", cookie, undefined, { env: e })],
      ["start (html)", await bcall("GET", "/billing/start?plan=team", cookie, undefined, { env: e, headers: { accept: "text/html" } })],
      ["status", await bcall("GET", `/api/billing/status?session_id=${pending.id}`, cookie, undefined, { env: e })],
      ["portal", await bcall("POST", "/api/o/maya-co/billing/portal", cookie, {}, { env: e })],
      ["seats", await bcall("POST", "/api/o/maya-co/billing/portal", cookie, { seats: true }, { env: e })],
      ["config", await bcall("GET", "/api/billing/config", cookie, undefined, { env: e })],
      ["plan", await bcall("GET", "/api/o/maya-co/plan", cookie, undefined, { env: e })],
    ];
    // The webhook, whose handler must read the subscription from the echoing Stripe.
    for (const type of ["customer.subscription.updated", "invoice.payment_failed"]) {
      const raw = JSON.stringify(event(type, type.startsWith("invoice") ? { id: "in_1", subscription: sub.id } : stripe.subscriptionJson(sub)));
      answers.push([type, await postWebhook(raw, { "stripe-signature": await signature(raw, HOOK) }, e)]);
    }
    const second = JSON.stringify(event("checkout.session.completed", stripe.sessionJson(pending)));
    answers.push(["checkout.session.completed", await postWebhook(second, { "stripe-signature": await signature(second, HOOK) }, e)]);
    // …and an upgrade, once the subscription has ended and the org is on Free.
    await exec(`UPDATE orgs SET plan = 'free' WHERE slug = 'maya-co'`);
    answers.push(["upgrade", await bcall("POST", "/api/o/maya-co/billing/upgrade", cookie, {}, { env: e })]);

    for (const [where, r] of answers) {
      expect(r.status, `${name}: ${where} → ${r.text.slice(0, 200)}`).toBeLessThan(600);
      expectClean(r.text, `${name}: ${where} body`);
      expectClean(JSON.stringify([...r.headers]), `${name}: ${where} headers`);
    }
    expectClean(await dumpD1(), `D1 after ${name}`);
    expect(logged.length).toBeGreaterThan(0); // the failures WERE logged — the afterEach scans every argument
  });

  it("a delivery signed with the wrong secret, and one with none, tell the caller nothing about the right one", async () => {
    install(null);
    const raw = JSON.stringify(event("invoice.paid", { id: "in_1", subscription: "sub_x" }));
    const attempts: Record<string, string>[] = [{}, { "stripe-signature": await signature(raw, "whsec_wrong") }, { "stripe-signature": `t=1,v1=${"0".repeat(64)}` }];
    for (const headers of attempts) {
      const r = await postWebhook(raw, headers, leaky());
      expect(r.status).toBe(401);
      expectClean(r.text, "the refusal");
      expectClean(JSON.stringify([...r.headers]), "the refusal's headers");
    }
    expectClean(await dumpD1(), "D1 after refused deliveries");
  });
});
