/**
 * Admin email preview + test send (cookie-gated, admin-only). Preview renders
 * the digest for the caller without touching the outbox; test send goes through
 * the real delivery gate and leaves a distinct outbox row.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx, platformCtx } from "./helpers/tenant";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { all, run } from "./helpers/db";
import { ingestAdrDraft } from "../src/consumer";
import { seedPerson } from "./helpers/persons";
import type { NotificationOutboxRow } from "@shared/rows";

async function cookieFor(login: string, email: string | null = "me@example.com"): Promise<string> {
  await seedPerson(login, { email });
  const { id } = await createSession(platformCtx(), login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}
const pending = () => ingestAdrDraft(systemCtx(), { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");

describe("GET /api/notifications/preview", () => {
  it("403s for a non-admin", async () => {
    const cookie = await cookieFor("not-admin");
    expect((await app.request("/api/notifications/preview?cadence=daily", { headers: { cookie } }, env)).status).toBe(403);
  });

  it("renders the daily digest for the caller as text/html with real data, ignoring prefs, writing no outbox row", async () => {
    const cookie = await cookieFor("admin-user");
    await pending();
    await run(env.DB, `INSERT INTO notification_prefs (user_id, kind, cadence, updated_at) VALUES ('admin-user', 'review_queue', 'off', 'x')`);
    const res = await app.request("/api/notifications/preview?cadence=daily", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Pending decision");
    expect(html).toContain("Daily digest");
    expect(await all(env.DB, `SELECT * FROM notification_outbox`)).toHaveLength(0);
  });

  it("format=text returns the plain-text alternative", async () => {
    const cookie = await cookieFor("admin-user");
    await pending();
    const res = await app.request("/api/notifications/preview?cadence=weekly&format=text", { headers: { cookie } }, env);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("TROV WEEKLY");
  });

  it("says so when nothing renders, and sample=1 renders the canned sample instead", async () => {
    const cookie = await cookieFor("admin-user");
    const empty = await app.request("/api/notifications/preview?cadence=daily", { headers: { cookie } }, env);
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("Nothing to render");
    const sample = await app.request("/api/notifications/preview?cadence=daily&sample=1", { headers: { cookie } }, env);
    const html = await sample.text();
    expect(html).toContain("My Work");
    expect(html).toContain("Review queue");
    expect(html).toContain("Roadmap plan changes");
    // …one canned section per registry kind, ticketq included, so the preview
    // shows the whole digest rather than three quarters of it.
    expect(html).toContain("Ticket queue");
    expect(html).toContain("UNASSIGNED");
    expect(html).toContain("ASSIGNED TO YOU");
    expect(html).toContain("Gradebook export comes back empty");
    expect(html).toContain("sample");
  });

  it("rejects an unknown cadence", async () => {
    const cookie = await cookieFor("admin-user");
    expect((await app.request("/api/notifications/preview?cadence=hourly", { headers: { cookie } }, env)).status).toBe(400);
  });
});

describe("POST /api/notifications/test-send", () => {
  const send = (cookie: string, body: unknown) =>
    app.request("/api/notifications/test-send", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, env);

  it("403s for a non-admin", async () => {
    expect((await send(await cookieFor("not-admin"), { cadence: "daily" })).status).toBe(403);
  });

  it("sends the digest to the admin through the delivery gate and logs a distinct outbox row (local mode → bodies table)", async () => {
    const cookie = await cookieFor("admin-user", "admin@example.com");
    await pending();
    const res = await send(cookie, { cadence: "daily" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string; key: string; mode: string; to: string };
    expect(body).toMatchObject({ ok: true, status: "sent", mode: "local", to: "admin@example.com" });
    expect(body.key.startsWith("org_saplinglearn:admin-user:daily:test-")).toBe(true);
    const rows = await all<NotificationOutboxRow>(env.DB, `SELECT * FROM notification_outbox`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: "admin-user", cadence: "daily", status: "sent" });
    const bodies = await all<{ to_address: string; subject: string; html: string }>(env.DB, `SELECT * FROM notification_outbox_bodies`);
    expect(bodies[0].to_address).toBe("admin@example.com");
    expect(bodies[0].subject).toMatch(/^Trov daily, /);
    expect(bodies[0].html).toContain("Pending decision");
  });

  it("does not consume the real window: a later scheduled run for the same window still sends", async () => {
    const cookie = await cookieFor("admin-user", "admin@example.com");
    await pending();
    await send(cookie, { cadence: "daily" });
    const { runDigest } = await import("../src/notifications/run");
    const { localDelivery } = await import("../src/notifications/delivery");
    const r = await runDigest(systemCtx(), platformCtx(), "daily", new Date(), { delivery: localDelivery(systemCtx()) });
    expect(r.sent).toBe(1);
    expect(r.alreadyRan).toBe(0);
  });

  it("400s when the admin has no address, and when nothing renders (unless sample=true)", async () => {
    const cookie = await cookieFor("admin-user", null);
    expect((await send(cookie, { cadence: "daily" })).status).toBe(400);
    await run(env.DB, `UPDATE persons SET email = 'admin@example.com' WHERE handle = 'admin-user'`);
    const empty = await send(cookie, { cadence: "daily" });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toMatch(/nothing to render/i);
    const sample = await send(cookie, { cadence: "weekly", sample: true });
    expect(sample.status).toBe(200);
    const bodies = await all<{ subject: string; html: string }>(env.DB, `SELECT * FROM notification_outbox_bodies`);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].html).toContain("Roadmap plan changes");
  });
});
