/**
 * Phase 4 — cron gating (two hourly triggers, gated in code from
 * notification_settings), scheduled() dispatch in local mode, the retry job,
 * and the signed one-click unsubscribe token. Row assertions only.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import wranglerToml from "../wrangler.toml?raw";
import worker from "../src/index";
import { all, first, run } from "../src/db";
import { ingestAdrDraft } from "../src/consumer";
import { DAILY_CRON, WEEKLY_CRON, dueCadence } from "../src/notifications/cron";
import { REPO_CRON } from "../src/repo/cron";
import { retryFailed } from "../src/notifications/retry";
import { localDelivery } from "../src/notifications/delivery";
import { unsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl } from "../src/notifications/unsubscribe";
import { seedPerson } from "./helpers/persons";
import type { NotificationOutboxRow, NotificationSettingsRow } from "@shared/rows";
import type { Env } from "../src/env";

const FRI_8_ET = new Date("2026-09-11T12:00:00.000Z");
const MON_8_ET = new Date("2026-09-14T12:00:00.000Z");
const SETTINGS: NotificationSettingsRow = { org_id: "org_saplinglearn", send_hour: 8, timezone: "America/New_York", from_address: "Trov <trov@mail.example>" };

const outbox = () => all<NotificationOutboxRow>(env.DB, `SELECT * FROM notification_outbox ORDER BY idempotency_key`);
const bodies = () => all<{ idempotency_key: string; html: string; text: string }>(env.DB, `SELECT * FROM notification_outbox_bodies`);
// seedPerson is INSERT OR IGNORE — AndresL230 is pre-seeded (email NULL) by the
// global reset, so force the email/unsubscribed values on every call.
async function user(login: string, email: string, unsubscribed: 0 | 1 = 0): Promise<void> {
  await seedPerson(login, { name: login, email, unsubscribed });
  await run(env.DB, `UPDATE persons SET email = ?, email_unsubscribed = ? WHERE handle = ?`, email, unsubscribed, login);
}
async function pendingDecision(): Promise<void> {
  await ingestAdrDraft(env.DB, { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const localEnv = (): Env => ({ ...(env as unknown as Env), NOTIFICATIONS_MODE: undefined, PUBLIC_ORIGIN: "https://trov.example" });

describe("cron triggers", () => {
  it("wrangler.toml declares both notification triggers", () => {
    expect(wranglerToml).toContain(`"${DAILY_CRON}"`);
    expect(wranglerToml).toContain(`"${WEEKLY_CRON}"`);
    expect(DAILY_CRON).not.toBe(WEEKLY_CRON);
  });

  it("the daily trigger is due only Mon-Fri at send_hour in the org timezone", () => {
    expect(dueCadence(DAILY_CRON, FRI_8_ET, SETTINGS)).toBe("daily");
    expect(dueCadence(DAILY_CRON, MON_8_ET, SETTINGS)).toBe("daily");
    expect(dueCadence(DAILY_CRON, new Date("2026-09-11T13:00:00.000Z"), SETTINGS)).toBeNull(); // 09:00 ET
    expect(dueCadence(DAILY_CRON, new Date("2026-09-12T12:00:00.000Z"), SETTINGS)).toBeNull(); // Saturday
    expect(dueCadence(DAILY_CRON, FRI_8_ET, { ...SETTINGS, send_hour: 9 })).toBeNull();
  });

  it("the weekly trigger is due only Monday at send_hour, in any timezone", () => {
    expect(dueCadence(WEEKLY_CRON, MON_8_ET, SETTINGS)).toBe("weekly");
    expect(dueCadence(WEEKLY_CRON, FRI_8_ET, SETTINGS)).toBeNull();
    // Monday 08:00 in Tokyo is Sunday 23:00 UTC — still due.
    expect(dueCadence(WEEKLY_CRON, new Date("2026-09-13T23:00:00.000Z"), { ...SETTINGS, timezone: "Asia/Tokyo" })).toBe("weekly");
  });

  it("follows daylight saving: 08:00 ET is 12:00Z in September and 13:00Z in January", () => {
    expect(dueCadence(DAILY_CRON, new Date("2026-01-09T13:00:00.000Z"), SETTINGS)).toBe("daily");
    expect(dueCadence(DAILY_CRON, new Date("2026-01-09T12:00:00.000Z"), SETTINGS)).toBeNull();
  });
});

describe("scheduled() dispatch (local mode)", () => {
  it("the daily trigger at send_hour runs the daily digest and writes bodies locally", async () => {
    await user("AndresL230", "andres@example.com");
    await pendingDecision();
    await worker.scheduled({ cron: DAILY_CRON, scheduledTime: FRI_8_ET.getTime(), noRetry() {} }, localEnv(), ctx);
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cadence: "daily", window_id: "2026-09-11", status: "sent", resend_id: null });
    const [b] = await bodies();
    expect(b.html).toContain("https://trov.example/#review");
  });

  it("the daily trigger at another hour, and the weekly trigger on a Friday, do nothing", async () => {
    await user("AndresL230", "andres@example.com");
    await pendingDecision();
    await worker.scheduled({ cron: DAILY_CRON, scheduledTime: new Date("2026-09-11T15:00:00.000Z").getTime(), noRetry() {} }, localEnv(), ctx);
    await worker.scheduled({ cron: WEEKLY_CRON, scheduledTime: FRI_8_ET.getTime(), noRetry() {} }, localEnv(), ctx);
    expect(await outbox()).toHaveLength(0);
  });

  it("honours an admin-edited send_hour", async () => {
    await user("AndresL230", "andres@example.com");
    await pendingDecision();
    await run(env.DB, `UPDATE notification_settings SET send_hour = 11 WHERE org_id = 'org_saplinglearn'`);
    await worker.scheduled({ cron: DAILY_CRON, scheduledTime: FRI_8_ET.getTime(), noRetry() {} }, localEnv(), ctx);
    expect(await outbox()).toHaveLength(0);
    await worker.scheduled({ cron: DAILY_CRON, scheduledTime: new Date("2026-09-11T15:00:00.000Z").getTime(), noRetry() {} }, localEnv(), ctx);
    expect(await outbox()).toHaveLength(1);
  });

  it("the repo cron trigger (fired at its reconcile tick, the busiest) never runs digests", async () => {
    await user("AndresL230", "andres@example.com");
    await pendingDecision();
    // :20 of a 6-hourly hour is the reconcile slot (src/repo/cron.ts) — the
    // heaviest tick, and the one that shares a wall-clock hour with the daily
    // digest candidate. REPO_ENVIRONMENTS unset here: scheduled() dispatches
    // this cron to handleRepoCron with no fetchImpl seam (the real Worker uses
    // the global fetch), so an empty env list keeps this test from pinging the
    // real staging/production URLs — handleRepoCron itself is covered
    // end-to-end, with an injected fetchImpl, in test/repo-cron.test.ts.
    const reconcileTick = new Date("2026-09-11T12:20:00.000Z").getTime();
    await worker.scheduled({ cron: REPO_CRON, scheduledTime: reconcileTick, noRetry() {} }, { ...localEnv(), REPO_ENVIRONMENTS: undefined }, ctx);
    expect(await outbox()).toHaveLength(0);
  });
});

describe("retryFailed — failed rows only", () => {
  // retryFailed only considers rows younger than RETRY_MAX_AGE_HOURS (48h), measured
  // against wall-clock `now`. An absolute created_at silently ages out of that bound
  // and every assertion here starts passing vacuously, so stamp it relative to now.
  const recentIso = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  async function failedRow(key = "AndresL230:daily:2026-09-11"): Promise<void> {
    await run(env.DB, `INSERT INTO notification_outbox (idempotency_key, user_id, cadence, window_id, kinds, status, error, created_at) VALUES (?, 'AndresL230', 'daily', '2026-09-11', '["review_queue"]', 'failed', 'send: smtp down', ?)`, key, recentIso());
  }

  it("re-renders and sends a failed row, marking it sent", async () => {
    await user("AndresL230", "andres@example.com");
    await pendingDecision();
    await failedRow();
    const r = await retryFailed(env.DB, { delivery: localDelivery(env.DB), origin: "" });
    expect(r.retried).toBe(1);
    const [row] = await outbox();
    expect(row).toMatchObject({ status: "sent", error: null });
    expect(row.sent_at).not.toBeNull();
    expect((await bodies())[0].text).toContain("Pending decision");
  });

  it("leaves sent and skipped rows alone", async () => {
    await user("AndresL230", "andres@example.com");
    await run(env.DB, `INSERT INTO notification_outbox (idempotency_key, user_id, cadence, window_id, kinds, status, created_at, sent_at) VALUES ('AndresL230:daily:2026-09-10', 'AndresL230', 'daily', '2026-09-10', '["review_queue"]', 'sent', 'x', 'x')`);
    await run(env.DB, `INSERT INTO notification_outbox (idempotency_key, user_id, cadence, window_id, kinds, status, created_at) VALUES ('AndresL230:daily:2026-09-09', 'AndresL230', 'daily', '2026-09-09', '[]', 'skipped', 'x')`);
    const r = await retryFailed(env.DB, { delivery: localDelivery(env.DB), origin: "" });
    expect(r.retried).toBe(0);
    expect(await bodies()).toHaveLength(0);
  });

  it("a failed row whose re-render now has nothing to say becomes skipped", async () => {
    await user("AndresL230", "andres@example.com");
    await failedRow();
    await retryFailed(env.DB, { delivery: localDelivery(env.DB), origin: "" });
    const [row] = await outbox();
    expect(row).toMatchObject({ status: "skipped", kinds: "[]" });
    expect(await bodies()).toHaveLength(0);
  });

  it("a retry that fails again stays failed with the new error", async () => {
    await user("AndresL230", "andres@example.com");
    await pendingDecision();
    await failedRow();
    await retryFailed(env.DB, { delivery: { send: async () => { throw new Error("still down"); } }, origin: "" });
    const [row] = await outbox();
    expect(row.status).toBe("failed");
    expect(row.error).toContain("still down");
  });

  it("skips a failed row whose user has since unsubscribed or lost their address", async () => {
    await user("AndresL230", "a@example.com", 1);
    await pendingDecision();
    await failedRow();
    const r = await retryFailed(env.DB, { delivery: localDelivery(env.DB), origin: "" });
    expect(r.retried).toBe(0);
    expect((await outbox())[0].status).toBe("failed");
  });
});

describe("signed one-click unsubscribe token", () => {
  it("round-trips the login and rejects tampering or another secret", async () => {
    const t = await unsubscribeToken("AndresL230", "s3cret");
    expect(await verifyUnsubscribeToken(t, "s3cret")).toBe("AndresL230");
    expect(await verifyUnsubscribeToken(t.slice(0, -2) + "zz", "s3cret")).toBeNull();
    expect(await verifyUnsubscribeToken(t, "other")).toBeNull();
    expect(await verifyUnsubscribeToken(t.replace("AndresL230", "lpcooper-arch"), "s3cret")).toBeNull();
  });
  it("builds the /u/<token> URL on the public origin", async () => {
    const url = await unsubscribeUrl("https://trov.example", "AndresL230", "s3cret");
    expect(url.startsWith("https://trov.example/u/AndresL230.")).toBe(true);
  });
});
