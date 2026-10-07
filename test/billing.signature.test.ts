/**
 * POST /webhook/stripe — the signature is the auth (src/billing/signature.ts, src/billing/webhook.ts).
 * A delivery is accepted only with a `v1` HMAC-SHA256 over `<t>.<raw body>` made with the endpoint's
 * secret, inside the tolerance window. Everything else is ONE refusal — the same status, body and
 * headers whatever was wrong — and writes nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { parseStripeSignature, verifyStripeSignature, SIGNATURE_TOLERANCE_S } from "../src/billing/signature";
import { FakeStripe, WEBHOOK_SECRET, billingEnv, event, postWebhook, signature } from "./helpers/billing";
import { one } from "./helpers/orgs";

const NOW = 1_800_000_000;
const BODY = JSON.stringify(event("invoice.paid", { id: "in_1", subscription: "sub_unknown" }));
const count = async (table: string) => (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;

describe("verifyStripeSignature", () => {
  it("accepts Stripe's own signature of the raw body", async () => {
    expect(await verifyStripeSignature(WEBHOOK_SECRET, BODY, await signature(BODY, WEBHOOK_SECRET, NOW), NOW * 1000)).toBe(true);
  });
  it("refuses another secret's, a tampered body, and a signature moved to another timestamp", async () => {
    const good = await signature(BODY, WEBHOOK_SECRET, NOW);
    expect(await verifyStripeSignature("whsec_someone_elses", BODY, good, NOW * 1000)).toBe(false);
    expect(await verifyStripeSignature(WEBHOOK_SECRET, `${BODY} `, good, NOW * 1000)).toBe(false);
    expect(await verifyStripeSignature(WEBHOOK_SECRET, BODY.replace("in_1", "in_2"), good, NOW * 1000)).toBe(false);
    expect(await verifyStripeSignature(WEBHOOK_SECRET, BODY, good.replace(`t=${NOW}`, `t=${NOW + 1}`), NOW * 1000)).toBe(false);
  });
  it("refuses a delivery outside the tolerance window, old or from the future, even with a good signature", async () => {
    const good = await signature(BODY, WEBHOOK_SECRET, NOW);
    expect(await verifyStripeSignature(WEBHOOK_SECRET, BODY, good, (NOW + SIGNATURE_TOLERANCE_S) * 1000)).toBe(true);
    expect(await verifyStripeSignature(WEBHOOK_SECRET, BODY, good, (NOW + SIGNATURE_TOLERANCE_S + 1) * 1000)).toBe(false);
    expect(await verifyStripeSignature(WEBHOOK_SECRET, BODY, good, (NOW - SIGNATURE_TOLERANCE_S - 1) * 1000)).toBe(false);
  });
  it("accepts when ANY of several v1 signatures verifies (a secret being rolled), in either position", async () => {
    const good = (await signature(BODY, WEBHOOK_SECRET, NOW)).split(",v1=")[1];
    const other = (await signature(BODY, "whsec_the_old_one", NOW)).split(",v1=")[1];
    expect(await verifyStripeSignature(WEBHOOK_SECRET, BODY, `t=${NOW},v1=${other},v1=${good}`, NOW * 1000)).toBe(true);
    expect(await verifyStripeSignature(WEBHOOK_SECRET, BODY, `t=${NOW},v1=${good},v1=${other},v0=ignored`, NOW * 1000)).toBe(true);
    expect(await verifyStripeSignature(WEBHOOK_SECRET, BODY, `t=${NOW},v1=${other},v1=${other}`, NOW * 1000)).toBe(false);
    // A `v0` (Stripe's test scheme) is never a signature here, even when it holds the right bytes.
    expect(await verifyStripeSignature(WEBHOOK_SECRET, BODY, `t=${NOW},v0=${good}`, NOW * 1000)).toBe(false);
  });
  it("is false, never a throw, for a missing or malformed header and for an empty secret", async () => {
    const good = await signature(BODY, WEBHOOK_SECRET, NOW);
    for (const header of [null, "", "nonsense", "t=,v1=", `t=${NOW}`, `v1=${"a".repeat(64)}`, `t=abc,v1=${"a".repeat(64)}`, `t=${NOW},v1=zz`, `t=${NOW},v1=${"a".repeat(63)}`, "x".repeat(5000)]) {
      expect(await verifyStripeSignature(WEBHOOK_SECRET, BODY, header, NOW * 1000), String(header).slice(0, 30)).toBe(false);
    }
    expect(await verifyStripeSignature("", BODY, good, NOW * 1000)).toBe(false);
    expect(parseStripeSignature(` t=${NOW} , v1=${"A".repeat(64)} `)).toEqual({ timestamp: NOW, v1: ["a".repeat(64)] });
  });
});

describe("POST /webhook/stripe refuses uniformly", () => {
  const stripe = new FakeStripe();
  beforeEach(() => { vi.stubGlobal("fetch", stripe.fetch); stripe.calls.length = 0; });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a missing header, a wrong secret, a stale timestamp, a tampered body and an unconfigured deployment get the SAME 401, and nothing is written or fetched", async () => {
    const now = Math.floor(Date.now() / 1000);
    const good = await signature(BODY);
    const off = { ...(env as unknown as Env), STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" };
    const attempts: [string, string, Record<string, string>, Env?][] = [
      ["no header", BODY, {}],
      ["an empty header", BODY, { "stripe-signature": "" }],
      ["another secret", BODY, { "stripe-signature": await signature(BODY, "whsec_someone_elses") }],
      ["a stale timestamp", BODY, { "stripe-signature": await signature(BODY, WEBHOOK_SECRET, now - SIGNATURE_TOLERANCE_S - 60) }],
      ["a tampered body", BODY.replace("in_1", "in_9"), { "stripe-signature": good }],
      ["GitHub's header instead", BODY, { "x-hub-signature-256": "sha256=00" }],
      ["billing not configured, with a signature that would otherwise verify", BODY, { "stripe-signature": good }, off],
      ["only the key configured", BODY, { "stripe-signature": good }, billingEnv({ STRIPE_WEBHOOK_SECRET: "" })],
    ];
    const answers = [];
    for (const [why, body, headers, e] of attempts) {
      const r = await postWebhook(body, headers, e);
      expect(r.status, why).toBe(401);
      answers.push(JSON.stringify([r.status, r.text, [...r.headers].filter(([k]) => k !== "date")]));
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain(`{\\"error\\":\\"unauthorized\\"}`);
    expect(await count("billing_events")).toBe(0);
    expect(stripe.calls).toEqual([]);
  });

  it("a verified delivery is acknowledged and recorded; one from the other Stripe mode is acknowledged and ignored", async () => {
    const ok = await postWebhook(BODY, { "stripe-signature": await signature(BODY) });
    expect([ok.status, ok.json]).toEqual([200, { ok: true, outcome: "unknown_subscription" }]);
    expect(await count("billing_events")).toBe(1);
    const live = JSON.stringify(event("invoice.paid", { id: "in_2", subscription: "sub_x" }, { livemode: true }));
    const other = await postWebhook(live, { "stripe-signature": await signature(live) });
    expect([other.status, other.json]).toEqual([200, { ok: true, ignored: "other_mode" }]);
    expect(await count("billing_events")).toBe(1);
    // A verified body that is not an event is acknowledged too: Stripe must not retry it for ever.
    const junk = "[1,2,3]";
    expect((await postWebhook(junk, { "stripe-signature": await signature(junk) })).json).toEqual({ ok: true, ignored: "not_an_event" });
  });

  it("only POST is the webhook: a GET there is just an unauthenticated app route", async () => {
    const worker = (await import("../src/index")).default;
    const res = await worker.fetch(new Request("https://trov.test/webhook/stripe"), billingEnv(), { waitUntil() { /* */ }, passThroughOnException() { /* */ } } as unknown as ExecutionContext);
    expect(res.status).toBe(401);
  });
});
