/**
 * Phase 4 — the Resend client behind the env gate. The HTTP request the client
 * builds is inspected at the Request/Response level (the codebase's stub
 * pattern); outcomes are asserted on outbox rows.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { all, run } from "../src/db";
import { ingestAdrDraft } from "../src/consumer";
import { resendDelivery, deliveryFor } from "../src/notifications/resend";
import { runDigest } from "../src/notifications/run";
import { seedPerson } from "./helpers/persons";
import type { OutboundMessage } from "../src/notifications/delivery";
import type { NotificationOutboxRow } from "@shared/rows";
import type { Env } from "../src/env";

const FRI = new Date("2026-09-11T12:00:00.000Z");
const MSG: OutboundMessage = {
  idempotencyKey: "AndresL230:daily:2026-09-11", userId: "AndresL230", to: "andres@example.com",
  subject: "Trov daily, Sep 11", html: "<p>hi</p>", text: "hi",
  unsubscribeUrl: "https://trov.example/u/AndresL230.sig",
};

function capture(status = 200, body: unknown = { id: "em_123" }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("resendDelivery", () => {
  it("POSTs the message to Resend with the bearer key, from, both List-Unsubscribe headers, and returns the id", async () => {
    const { calls, fetchImpl } = capture();
    const d = resendDelivery({ apiKey: "re_test", from: "Trov <trov@mail.example>", fetchImpl });
    const r = await d.send(MSG);
    expect(r.id).toBe("em_123");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init.method).toBe("POST");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer re_test");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ from: "Trov <trov@mail.example>", to: ["andres@example.com"], subject: "Trov daily, Sep 11", html: "<p>hi</p>", text: "hi" });
    expect(body.headers["List-Unsubscribe"]).toBe("<mailto:trov@mail.example?subject=unsubscribe>, <https://trov.example/u/AndresL230.sig>");
    expect(body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("throws with the provider's message on a non-2xx response", async () => {
    const { fetchImpl } = capture(422, { message: "Invalid `from` field" });
    const d = resendDelivery({ apiKey: "re_test", from: "bad", fetchImpl });
    await expect(d.send(MSG)).rejects.toThrow(/422.*Invalid `from` field/);
  });

  it("omits the List-Unsubscribe headers when the message has no unsubscribeUrl (transactional mail)", async () => {
    const { calls, fetchImpl } = capture();
    const d = resendDelivery({ apiKey: "re_test", from: "Trov <c@x>", fetchImpl });
    await d.send({ ...MSG, unsubscribeUrl: undefined });
    const body = JSON.parse(String(calls[0].init.body)) as { headers?: unknown };
    expect(body.headers).toBeUndefined();
  });
});

describe("deliveryFor — env gate, default local", () => {
  const base = env as unknown as Env;
  it("defaults to local when NOTIFICATIONS_MODE is unset", () => {
    expect(deliveryFor({ ...base, NOTIFICATIONS_MODE: undefined, RESEND_API_KEY: "re_x" }, { from: "a@b" }).mode).toBe("local");
    expect(deliveryFor({ ...base, NOTIFICATIONS_MODE: "local", RESEND_API_KEY: "re_x" }, { from: "a@b" }).mode).toBe("local");
  });
  it("resend mode without a key is a configuration error, never a silent fallback", () => {
    expect(() => deliveryFor({ ...base, NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: undefined }, { from: "a@b" })).toThrow(/RESEND_API_KEY/);
  });
  it("in resend mode a run stores the provider id and writes no local body", async () => {
    // AndresL230 is pre-seeded by the global reset (email NULL) — seedPerson is
    // INSERT OR IGNORE, so force the email with an explicit UPDATE too.
    await seedPerson("AndresL230", { name: "a", email: "andres@example.com" });
    await run(env.DB, `UPDATE persons SET email = 'andres@example.com' WHERE handle = 'AndresL230'`);
    await ingestAdrDraft(systemCtx(), { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    const { fetchImpl } = capture(200, { id: "em_run" });
    const delivery = deliveryFor({ ...base, NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "re_x" }, { from: "Trov <c@mail.example>", fetchImpl });
    expect(delivery.mode).toBe("resend");
    await runDigest(env.DB, "daily", FRI, { delivery });
    const [row] = await all<NotificationOutboxRow>(env.DB, `SELECT * FROM notification_outbox`);
    expect(row).toMatchObject({ status: "sent", resend_id: "em_run" });
    expect(await all(env.DB, `SELECT * FROM notification_outbox_bodies`)).toHaveLength(0);
  });
});
