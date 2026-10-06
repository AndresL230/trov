/**
 * Phase 2 — migration 0021 (notification tables + teammate email columns) and
 * policy seeding from the registry. Asserts on real D1 rows and constraints.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run } from "../src/db";
import { REGISTRY } from "../src/notifications/registry";
import { seedNotificationPolicy } from "../src/notifications/policy";
import type { NotificationPolicyRow, NotificationSettingsRow, PersonRow } from "@shared/rows";

import { systemCtx } from "./helpers/tenant";
async function columns(table: string): Promise<string[]> {
  const rows = await all<{ name: string }>(env.DB, `PRAGMA table_info(${table})`);
  return rows.map((r) => r.name);
}

describe("migration 0021 — notification tables", () => {
  it("creates the four tables with the spec's columns", async () => {
    expect(await columns("notification_policy")).toEqual(["org_id", "kind", "default_cadence", "enabled", "updated_at", "updated_by"]);
    expect(await columns("notification_settings")).toEqual(["org_id", "send_hour", "timezone", "from_address"]);
    expect(await columns("notification_prefs")).toEqual(["org_id", "user_id", "kind", "cadence", "updated_at"]);
    expect(await columns("notification_outbox")).toEqual([
      "idempotency_key", "user_id", "cadence", "window_id", "kinds", "status", "resend_id", "error", "created_at", "sent_at", "org_id",
    ]);
  });

  it("the teammate record (persons, 0023) carries email and email_unsubscribed (default 0)", async () => {
    await run(env.DB, `INSERT INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('u1', 'U', 'stone', '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z')`);
    const p = await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'u1'`);
    expect(p!.email).toBeNull();
    expect(p!.email_unsubscribed).toBe(0);
  });

  it("rejects an off-vocabulary cadence on prefs and policy, and an unknown outbox status", async () => {
    await expect(run(env.DB, `INSERT INTO notification_prefs (user_id, kind, cadence, updated_at) VALUES ('u', 'my_work', 'immediate', 'now')`)).rejects.toThrow();
    await expect(run(env.DB, `INSERT INTO notification_policy (kind, default_cadence, enabled, updated_at, updated_by) VALUES ('k', 'hourly', 1, 'now', 'x')`)).rejects.toThrow();
    await expect(
      run(env.DB, `INSERT INTO notification_outbox (idempotency_key, user_id, cadence, window_id, kinds, status, created_at) VALUES ('u:daily:2026-09-11', 'u', 'daily', '2026-09-11', '[]', 'queued', 'now')`)
    ).rejects.toThrow();
  });

  it("enforces one outbox row per idempotency key", async () => {
    const ins = `INSERT INTO notification_outbox (idempotency_key, user_id, cadence, window_id, kinds, status, created_at) VALUES ('u:daily:2026-09-11', 'u', 'daily', '2026-09-11', '[]', 'pending', 'now')`;
    await run(env.DB, ins);
    await expect(run(env.DB, ins)).rejects.toThrow();
  });

  // 0039 (multitenancy): the singleton is per ORG — one row per org, keyed by org_id.
  it("seeds the org-level settings singleton and refuses a second row for the same org", async () => {
    const s = await first<NotificationSettingsRow>(env.DB, `SELECT * FROM notification_settings WHERE org_id = 'org_saplinglearn'`);
    expect(s).toMatchObject({ org_id: "org_saplinglearn", send_hour: 8, timezone: "America/New_York" });
    expect(s!.from_address).toBeTruthy();
    await expect(run(env.DB, `INSERT INTO notification_settings (org_id, send_hour, timezone, from_address) VALUES ('org_saplinglearn', 8, 'UTC', 'x@y')`)).rejects.toThrow();
    // …and a row for an org that does not exist is refused by the foreign key.
    await expect(run(env.DB, `INSERT INTO notification_settings (org_id, send_hour, timezone, from_address) VALUES ('org_nope', 8, 'UTC', 'x@y')`)).rejects.toThrow();
  });
});

describe("policy seeding from the registry", () => {
  it("inserts one enabled policy row per registry kind carrying the registry default", async () => {
    await run(env.DB, `DELETE FROM notification_policy`);
    const r = await seedNotificationPolicy(systemCtx());
    const rows = await all<NotificationPolicyRow>(env.DB, `SELECT * FROM notification_policy ORDER BY kind`);
    expect(rows.map((p) => p.kind)).toEqual([...REGISTRY.map((k) => k.id)].sort());
    for (const k of REGISTRY) {
      const row = rows.find((p) => p.kind === k.id)!;
      expect(row.default_cadence).toBe(k.defaultCadence);
      expect(row.enabled).toBe(1);
      expect(row.updated_by).toBe("registry");
    }
    expect(r.inserted.sort()).toEqual([...REGISTRY.map((k) => k.id)].sort());
  });

  it("never overwrites an existing row: an admin change survives a re-seed", async () => {
    await run(env.DB, `DELETE FROM notification_policy`);
    await seedNotificationPolicy(systemCtx());
    await run(env.DB, `UPDATE notification_policy SET default_cadence = 'off', enabled = 0, updated_by = 'admin' WHERE kind = 'my_work'`);
    const r = await seedNotificationPolicy(systemCtx());
    expect(r.inserted).toEqual([]);
    const row = await first<NotificationPolicyRow>(env.DB, `SELECT * FROM notification_policy WHERE kind = 'my_work'`);
    expect(row).toMatchObject({ default_cadence: "off", enabled: 0, updated_by: "admin" });
  });

  it("inserts only the kinds that are missing, leaving the others untouched", async () => {
    await run(env.DB, `DELETE FROM notification_policy`);
    await seedNotificationPolicy(systemCtx());
    await run(env.DB, `UPDATE notification_policy SET enabled = 0 WHERE kind = 'review_queue'`);
    await run(env.DB, `DELETE FROM notification_policy WHERE kind = 'roadmap_plan'`);
    const r = await seedNotificationPolicy(systemCtx());
    expect(r.inserted).toEqual(["roadmap_plan"]);
    const rq = await first<NotificationPolicyRow>(env.DB, `SELECT * FROM notification_policy WHERE kind = 'review_queue'`);
    expect(rq!.enabled).toBe(0);
  });
});
