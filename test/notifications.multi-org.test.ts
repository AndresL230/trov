/**
 * Multitenancy Phase 5b — the digest cron runs PER ORG (canopy-multitenancy.md §8.4, §10.2): each org
 * on its own send hour, with its own members and content. A person in two orgs gets one digest per
 * org, each containing only that org's content; the unsubscribe is global. Row assertions only —
 * the bodies are read back from `notification_outbox_bodies` (local delivery).
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { TicketCreate } from "@shared/tickets";
import worker from "../src/index";
import { all, run, nowIso } from "./helpers/db";
import { seedPerson } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember, systemCtx } from "./helpers/tenant";
import { ingestAdrDraft } from "../src/consumer";
import { create_ticket } from "../src/tools/tickets";
import { DAILY_CRON, WEEKLY_CRON, handleNotificationCron } from "../src/notifications/cron";
import { platformFrom } from "../src/notifications/resend";

const FRI_8_ET = new Date("2026-09-11T12:00:00.000Z");
const FRI_9_ET = new Date("2026-09-11T13:00:00.000Z");
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const localEnv = (): Env => ({ ...(env as unknown as Env), NOTIFICATIONS_MODE: undefined, PUBLIC_ORIGIN: "https://trov.example" });
const fire = (cron: string, at: Date) => worker.scheduled({ cron, scheduledTime: at.getTime(), noRetry() {} }, localEnv(), execCtx);

interface Sent { org_id: string; user_id: string; status: string; html: string; text: string; to_address: string }
const sent = () => all<Sent>(env.DB,
  `SELECT o.org_id, o.user_id, o.status, b.html, b.text, b.to_address
     FROM notification_outbox o LEFT JOIN notification_outbox_bodies b ON b.idempotency_key = o.idempotency_key AND b.org_id = o.org_id
    ORDER BY o.org_id, o.user_id`);
const outbox = () => all<{ org_id: string; user_id: string; idempotency_key: string }>(env.DB, `SELECT org_id, user_id, idempotency_key FROM notification_outbox ORDER BY org_id, user_id`);

/** A person with an address, in the given orgs (and ONLY those). */
async function person(handle: string, orgs: string[], unsubscribed: 0 | 1 = 0): Promise<void> {
  await seedPerson(handle, { name: handle, email: `${handle}@example.com`, unsubscribed, member: false });
  await run(env.DB, `UPDATE persons SET email = ?, email_unsubscribed = ? WHERE handle = ?`, `${handle}@example.com`, unsubscribed, handle);
  await run(env.DB, `DELETE FROM memberships WHERE user_id = ?`, handle);
  for (const org of orgs) await ensureMember(handle, "member", org);
}

/** One pending decision and one unassigned ticket in `org`, every text field carrying its canary. */
async function content(org: string, canary: string): Promise<void> {
  await ingestAdrDraft(systemCtx(org), { title: `${canary} decision`, context: `${canary} context`, decision: `${canary} d`, rationale: `${canary} r`, confidence: "high" }, "agent");
  await seedPerson("filer", { github: false, member: false });
  await ensureMember("filer", "member", org);
  await create_ticket(systemCtx(org), TicketCreate.parse({ title: `${canary} ticket`, assignees: [] }), "filer");
}

async function twoOrgs(): Promise<void> {
  // The seeded SaplingLearn people have no address, so only these three are eligible.
  await person("dana", [ORG_A, ORG_B]); // in BOTH orgs
  await person("alba", [ORG_A]);
  await person("bob", [ORG_B]);
  await run(env.DB, `UPDATE persons SET email = NULL WHERE handle = 'filer'`);
  await content(ORG_A, "CANARY_A");
  await content(ORG_B, "CANARY_B");
}

describe("the digest cron, two orgs", () => {
  it("a person in two orgs gets one digest per org, and no org's content appears in another org's body", async () => {
    await twoOrgs();
    await fire(DAILY_CRON, FRI_8_ET);
    const rows = await sent();
    expect(rows.map((r) => [r.org_id, r.user_id, r.status])).toEqual([
      [ORG_B, "bob", "sent"], [ORG_B, "dana", "sent"], [ORG_A, "alba", "sent"], [ORG_A, "dana", "sent"],
    ]);
    for (const r of rows) {
      const [mine, theirs] = r.org_id === ORG_A ? ["CANARY_A", "CANARY_B"] : ["CANARY_B", "CANARY_A"];
      for (const body of [r.html, r.text]) {
        expect(body, `${r.org_id} ${r.user_id}`).toContain(`${mine} decision`);
        expect(body, `${r.org_id} ${r.user_id}`).toContain(`${mine} ticket`);
        expect(body, `${r.org_id} ${r.user_id}`).not.toContain(theirs);
      }
      expect(r.to_address).toBe(`${r.user_id}@example.com`);
    }
    // The outbox key carries the org: dana's two rows cannot collide, and neither can a re-fire.
    const keys = (await outbox()).map((r) => r.idempotency_key);
    expect(keys).toEqual([`${ORG_B}:bob:daily:2026-09-11`, `${ORG_B}:dana:daily:2026-09-11`, `${ORG_A}:alba:daily:2026-09-11`, `${ORG_A}:dana:daily:2026-09-11`]);
    await fire(DAILY_CRON, FRI_8_ET);
    expect(await outbox()).toHaveLength(4);
  });

  it("each org is due on its OWN send hour and timezone", async () => {
    await twoOrgs();
    await run(env.DB, `INSERT INTO notification_settings (org_id, send_hour, timezone, from_address) VALUES (?, 9, 'America/New_York', 'Acme <hello@trov.dev>')`, ORG_B);
    await fire(DAILY_CRON, FRI_8_ET);
    expect([...new Set((await outbox()).map((r) => r.org_id))]).toEqual([ORG_A]);
    await fire(DAILY_CRON, FRI_9_ET);
    expect([...new Set((await outbox()).map((r) => r.org_id))]).toEqual([ORG_B, ORG_A]);
    expect((await outbox()).filter((r) => r.user_id === "dana")).toHaveLength(2);
  });

  it("the unsubscribe is global: one flag stops every org's mail to that person", async () => {
    await twoOrgs();
    await run(env.DB, `UPDATE persons SET email_unsubscribed = 1 WHERE handle = 'dana'`);
    await fire(DAILY_CRON, FRI_8_ET);
    expect((await outbox()).map((r) => [r.org_id, r.user_id])).toEqual([[ORG_B, "bob"], [ORG_A, "alba"]]);
  });

  it("someone removed from an org gets that org's digest no more — and still the other's", async () => {
    await twoOrgs();
    await run(env.DB, `DELETE FROM memberships WHERE org_id = ? AND user_id = 'dana'`, ORG_A);
    await fire(DAILY_CRON, FRI_8_ET);
    expect((await outbox()).filter((r) => r.user_id === "dana").map((r) => r.org_id)).toEqual([ORG_B]);
  });

  it("one org failing (a broken timezone) is logged with its org id and never stops the next org", async () => {
    await twoOrgs();
    // ORG_B sorts first, so it fails BEFORE SaplingLearn is reached.
    await run(env.DB, `INSERT INTO notification_settings (org_id, send_hour, timezone, from_address) VALUES (?, 8, 'Not/A_Zone', 'Acme <hello@trov.dev>')`, ORG_B);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const reports = await handleNotificationCron(localEnv(), DAILY_CRON, FRI_8_ET);
      expect(Object.keys(reports)).toEqual([ORG_A]);
      expect(reports[ORG_A].run).toMatchObject({ eligible: 2, sent: 2, failed: 0 });
      expect(JSON.stringify(spy.mock.calls)).toContain(`org=${ORG_B}`);
    } finally { spy.mockRestore(); }
    expect([...new Set((await outbox()).map((r) => r.org_id))]).toEqual([ORG_A]);
  });

  it("a suspended org gets no digest", async () => {
    await twoOrgs();
    await run(env.DB, `UPDATE orgs SET suspended_at = ?, suspended_by = 'AndresL230' WHERE id = ?`, nowIso(), ORG_B);
    await fire(DAILY_CRON, FRI_8_ET);
    expect([...new Set((await outbox()).map((r) => r.org_id))]).toEqual([ORG_A]);
  });

  it("an org with members but nothing to say sends nothing and leaves the other org's digest intact", async () => {
    await person("dana", [ORG_A, ORG_B]);
    await content(ORG_A, "CANARY_A");
    await run(env.DB, `UPDATE persons SET email = NULL WHERE handle = 'filer'`);
    await fire(DAILY_CRON, FRI_8_ET);
    expect((await sent()).map((r) => [r.org_id, r.status])).toEqual([[ORG_B, "skipped"], [ORG_A, "sent"]]);
    expect((await all(env.DB, `SELECT org_id FROM notification_outbox_bodies`))).toEqual([{ org_id: ORG_A }]);
  });

  it("the weekly trigger on a Friday does nothing, in any org", async () => {
    await twoOrgs();
    await fire(WEEKLY_CRON, FRI_8_ET);
    expect(await outbox()).toHaveLength(0);
  });
});

describe("platformFrom", () => {
  it("keeps an org's display name and always sends from the platform's address", () => {
    expect(platformFrom("Trov <hello@trov.dev>")).toBe("Trov <hello@trov.dev>"); // SaplingLearn's stored value: unchanged
    expect(platformFrom("Acme Eng <alerts@acme.example>")).toBe("Acme Eng <hello@trov.dev>");
    expect(platformFrom("security@trov.dev")).toBe("Trov <hello@trov.dev>");
    expect(platformFrom('"Quoted" <x@y.z>')).toBe("Quoted <hello@trov.dev>");
    expect(platformFrom("")).toBe("Trov <hello@trov.dev>");
  });
});
