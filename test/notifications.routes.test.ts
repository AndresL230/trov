/**
 * Phase 5 — cookie-gated /api/notifications/* routes and the signed one-click
 * unsubscribe POST. Assertions on responses AND on the rows they change.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import worker from "../src/index";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { all, first, run } from "./helpers/db";
import { seedNotificationPolicy } from "../src/notifications/policy";
import { unsubscribeToken } from "../src/notifications/unsubscribe";
import { seedPerson } from "./helpers/persons";
import type { NotificationPolicyRow, NotificationPrefRow, NotificationSettingsRow, PersonRow } from "@shared/rows";
import type { Env } from "../src/env";

import { platformCtx, systemCtx } from "./helpers/tenant";
async function cookieFor(login: string, email: string | null = "me@example.com"): Promise<string> {
  await seedPerson(login, { email });
  const { id } = await createSession(platformCtx(), login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}
const json = (method: string, body: unknown, cookie: string): RequestInit => ({
  method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
});
interface PrefsView {
  email: string | null; unsubscribed: boolean;
  kinds: { id: string; label: string; allowedCadences: string[]; cadence: string; orgDefault: string; inherited: boolean }[];
}

describe("GET/PUT /api/notifications/prefs", () => {
  it("401s without a session", async () => {
    expect((await app.request("/api/notifications/prefs", {}, env)).status).toBe(401);
    expect((await app.request("/api/notifications/prefs", { method: "PUT" }, env)).status).toBe(401);
  });

  it("GET returns the address, the flag, and one resolved row per ENABLED kind, hiding policy-disabled kinds", async () => {
    await seedNotificationPolicy(systemCtx());
    await run(env.DB, `UPDATE notification_policy SET enabled = 0 WHERE kind = 'review_queue'`);
    await run(env.DB, `UPDATE notification_policy SET default_cadence = 'daily' WHERE kind = 'roadmap_plan'`);
    const cookie = await cookieFor("u1");
    await run(env.DB, `INSERT INTO notification_prefs (user_id, kind, cadence, updated_at) VALUES ('u1', 'my_work', 'weekly', 'x')`);

    const res = await app.request("/api/notifications/prefs", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const v = (await res.json()) as PrefsView;
    expect(v.email).toBe("me@example.com");
    expect(v.unsubscribed).toBe(false);
    expect(v.kinds.map((k) => k.id)).toEqual(["my_work", "roadmap_plan", "ticketq"]);
    expect(v.kinds[0]).toMatchObject({ cadence: "weekly", orgDefault: "daily", inherited: false, allowedCadences: ["daily", "weekly", "off"] });
    expect(v.kinds[1]).toMatchObject({ cadence: "daily", orgDefault: "daily", inherited: true });
  });

  it("PUT writes a valid pref, rejects a cadence outside allowedCadences, and null resets (deletes the row)", async () => {
    const cookie = await cookieFor("u1");
    let res = await app.request("/api/notifications/prefs", json("PUT", { prefs: { my_work: "weekly" } }, cookie), env);
    expect(res.status).toBe(200);
    expect(await first<NotificationPrefRow>(env.DB, `SELECT * FROM notification_prefs WHERE user_id = 'u1' AND kind = 'my_work'`)).toMatchObject({ cadence: "weekly" });

    res = await app.request("/api/notifications/prefs", json("PUT", { prefs: { review_queue: "weekly" } }, cookie), env);
    expect(res.status).toBe(400);
    expect(await first(env.DB, `SELECT * FROM notification_prefs WHERE user_id = 'u1' AND kind = 'review_queue'`)).toBeNull();

    res = await app.request("/api/notifications/prefs", json("PUT", { prefs: { nope: "daily" } }, cookie), env);
    expect(res.status).toBe(400);

    res = await app.request("/api/notifications/prefs", json("PUT", { prefs: { my_work: null } }, cookie), env);
    expect(res.status).toBe(200);
    expect(await first(env.DB, `SELECT * FROM notification_prefs WHERE user_id = 'u1'`)).toBeNull();
    expect(((await res.json()) as PrefsView).kinds[0].inherited).toBe(true);
  });

  it("PUT updates the address (empty clears it) and the unsubscribe flag, leaving prefs intact", async () => {
    const cookie = await cookieFor("u1");
    await run(env.DB, `INSERT INTO notification_prefs (user_id, kind, cadence, updated_at) VALUES ('u1', 'my_work', 'weekly', 'x')`);
    let res = await app.request("/api/notifications/prefs", json("PUT", { email: "new@example.com", unsubscribed: true }, cookie), env);
    expect(res.status).toBe(200);
    let u = (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'u1'`))!;
    expect(u.email).toBe("new@example.com");
    expect(u.email_unsubscribed).toBe(1);
    expect(await all(env.DB, `SELECT * FROM notification_prefs WHERE user_id = 'u1'`)).toHaveLength(1);

    res = await app.request("/api/notifications/prefs", json("PUT", { email: "not-an-email" }, cookie), env);
    expect(res.status).toBe(400);

    res = await app.request("/api/notifications/prefs", json("PUT", { email: "", unsubscribed: false }, cookie), env);
    expect(res.status).toBe(200);
    u = (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'u1'`))!;
    expect(u.email).toBeNull();
    expect(u.email_unsubscribed).toBe(0);
  });

  it("a user can only ever write their own row", async () => {
    const cookie = await cookieFor("u1");
    await cookieFor("u2", "other@example.com");
    await app.request("/api/notifications/prefs", json("PUT", { email: "x@example.com", user_id: "u2" }, cookie), env);
    expect((await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'u2'`))!.email).toBe("other@example.com");
  });

  it("PUT refuses an address already on another person's row (409, nothing written), but allows re-saving your own", async () => {
    const cookie1 = await cookieFor("u1", "taken@example.com");
    const cookie2 = await cookieFor("u2", "u2@example.com");
    let res = await app.request("/api/notifications/prefs", json("PUT", { email: "taken@example.com" }, cookie2), env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "email_in_use" });
    expect((await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'u2'`))!.email).toBe("u2@example.com");
    // Case-insensitive match too.
    res = await app.request("/api/notifications/prefs", json("PUT", { email: "TAKEN@example.com" }, cookie2), env);
    expect(res.status).toBe(409);
    // The owner can re-save their own address.
    res = await app.request("/api/notifications/prefs", json("PUT", { email: "taken@example.com" }, cookie1), env);
    expect(res.status).toBe(200);
    expect((await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'u1'`))!.email).toBe("taken@example.com");
  });
});

describe("admin routes: policy, settings, outbox, user email", () => {
  it("403 for a non-admin on every admin route", async () => {
    const cookie = await cookieFor("not-admin");
    for (const [path, init] of [
      ["/api/notifications/policy", { headers: { cookie } }],
      ["/api/notifications/policy", json("PUT", { kind: "my_work", enabled: false }, cookie)],
      ["/api/notifications/settings", { headers: { cookie } }],
      ["/api/notifications/settings", json("PUT", { send_hour: 9 }, cookie)],
      ["/api/notifications/outbox", { headers: { cookie } }],
      ["/api/notifications/persons/u1", json("PUT", { email: "a@b.co" }, cookie)],
    ] as const) {
      expect((await app.request(path, init, env)).status, `${init.method ?? "GET"} ${path}`).toBe(403);
    }
  });

  it("GET policy lists every registry kind with its stored policy; PUT toggles enabled and default_cadence with validation", async () => {
    const cookie = await cookieFor("admin-user");
    let res = await app.request("/api/notifications/policy", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const view = (await res.json()) as { kinds: { id: string; enabled: boolean; default_cadence: string; allowedCadences: string[]; updated_by: string }[] };
    expect(view.kinds.map((k) => k.id)).toEqual(["my_work", "review_queue", "roadmap_plan", "ticketq"]);
    expect(view.kinds[2]).toMatchObject({ enabled: true, default_cadence: "weekly" });

    res = await app.request("/api/notifications/policy", json("PUT", { kind: "roadmap_plan", enabled: false, default_cadence: "daily" }, cookie), env);
    expect(res.status).toBe(200);
    const row = (await first<NotificationPolicyRow>(env.DB, `SELECT * FROM notification_policy WHERE kind = 'roadmap_plan'`))!;
    expect(row).toMatchObject({ enabled: 0, default_cadence: "daily", updated_by: "admin-user" });

    res = await app.request("/api/notifications/policy", json("PUT", { kind: "review_queue", default_cadence: "weekly" }, cookie), env);
    expect(res.status).toBe(400); // not in allowedCadences
    res = await app.request("/api/notifications/policy", json("PUT", { kind: "nope", enabled: true }, cookie), env);
    expect(res.status).toBe(400);
  });

  it("GET/PUT settings round-trip the singleton and validate hour, timezone and from_address", async () => {
    const cookie = await cookieFor("admin-user");
    let res = await app.request("/api/notifications/settings", { headers: { cookie } }, env);
    expect(await res.json()).toMatchObject({ send_hour: 8, timezone: "America/New_York" });

    res = await app.request("/api/notifications/settings", json("PUT", { send_hour: 7, timezone: "Europe/Berlin", from_address: "Trov <digest@mail.example>" }, cookie), env);
    expect(res.status).toBe(200);
    expect(await first<NotificationSettingsRow>(env.DB, `SELECT * FROM notification_settings WHERE org_id = 'org_saplinglearn'`)).toMatchObject({ send_hour: 7, timezone: "Europe/Berlin", from_address: "Trov <digest@mail.example>" });

    expect((await app.request("/api/notifications/settings", json("PUT", { send_hour: 24 }, cookie), env)).status).toBe(400);
    expect((await app.request("/api/notifications/settings", json("PUT", { timezone: "Mars/Olympus" }, cookie), env)).status).toBe(400);
    expect((await app.request("/api/notifications/settings", json("PUT", { from_address: "" }, cookie), env)).status).toBe(400);
  });

  it("GET outbox returns recent rows newest first, capped by limit", async () => {
    const cookie = await cookieFor("admin-user");
    for (const [k, at] of [["a:daily:2026-09-09", "2026-09-09T12:00:00Z"], ["b:daily:2026-09-10", "2026-09-10T12:00:00Z"], ["c:daily:2026-09-11", "2026-09-11T12:00:00Z"]]) {
      await run(env.DB, `INSERT INTO notification_outbox (idempotency_key, user_id, cadence, window_id, kinds, status, created_at) VALUES (?, ?, 'daily', ?, '[]', 'skipped', ?)`, k, k.split(":")[0], k.split(":")[2], at);
    }
    const res = await app.request("/api/notifications/outbox?limit=2", { headers: { cookie } }, env);
    const v = (await res.json()) as { rows: { user_id: string }[] };
    expect(v.rows.map((r) => r.user_id)).toEqual(["c", "b"]);
  });

  it("PUT persons/:handle sets a teammate's address (admin edit in Maintenance)", async () => {
    const cookie = await cookieFor("admin-user");
    await cookieFor("u1", null);
    const res = await app.request("/api/notifications/persons/u1", json("PUT", { email: "fixed@example.com" }, cookie), env);
    expect(res.status).toBe(200);
    expect((await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'u1'`))!.email).toBe("fixed@example.com");
    expect((await app.request("/api/notifications/persons/ghost", json("PUT", { email: "x@example.com" }, cookie), env)).status).toBe(404);
  });

  it("PUT persons/:handle refuses an address already on a different person's row (409, nothing written)", async () => {
    const cookie = await cookieFor("admin-user");
    await cookieFor("u1", "taken3@example.com");
    await cookieFor("u2", null);
    const res = await app.request("/api/notifications/persons/u2", json("PUT", { email: "taken3@example.com" }, cookie), env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "email_in_use" });
    expect((await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'u2'`))!.email).toBeNull();
  });
});

describe("signed one-click unsubscribe (/u/:token) — no cookie", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const wenv = env as unknown as Env;

  it("POST with a valid token sets email_unsubscribed = 1 and nothing else", async () => {
    await seedPerson("u1", { name: "U", email: "me@example.com" });
    await run(env.DB, `INSERT INTO notification_prefs (user_id, kind, cadence, updated_at) VALUES ('u1', 'my_work', 'weekly', 'x')`);
    const token = await unsubscribeToken("u1", "test-cookie-secret");
    const res = await worker.fetch(new Request(`https://trov.example/u/${token}`, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } }), wenv, ctx);
    expect(res.status).toBe(200);
    const u = (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'u1'`))!;
    expect(u.email_unsubscribed).toBe(1);
    expect(u.email).toBe("me@example.com");
    expect(await all(env.DB, `SELECT * FROM notification_prefs WHERE user_id = 'u1'`)).toHaveLength(1);
  });

  it("POST with a tampered or foreign token changes nothing and 401s", async () => {
    await seedPerson("u1", { name: "U", email: "me@example.com" });
    const token = await unsubscribeToken("u1", "wrong-secret");
    const res = await worker.fetch(new Request(`https://trov.example/u/${token}`, { method: "POST" }), wenv, ctx);
    expect(res.status).toBe(401);
    expect((await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'u1'`))!.email_unsubscribed).toBe(0);
  });

  it("GET redirects to the in-app (cookie-gated) unsubscribe screen without flipping anything", async () => {
    await seedPerson("u1", { name: "U", email: "me@example.com" });
    const token = await unsubscribeToken("u1", "test-cookie-secret");
    const res = await worker.fetch(new Request(`https://trov.example/u/${token}`), wenv, ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://trov.example/#unsubscribe");
    expect((await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'u1'`))!.email_unsubscribed).toBe(0);
  });
});
