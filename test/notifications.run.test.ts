/**
 * Phase 3 — cadence resolution, window computation and the run assembler in
 * local mode. Every assertion is on D1 rows (outbox + the dev-only bodies
 * table), never on mock calls.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { platformCtx, systemCtx } from "./helpers/tenant";
import { all, first, run } from "../src/db";
import { ingestEvent, ingestAdrDraft } from "../src/consumer";
import { seedNotificationPolicy } from "../src/notifications/policy";
import { resolveCadence } from "../src/notifications/resolve";
import { computeWindow } from "../src/notifications/window";
import { runDigest } from "../src/notifications/run";
import { localDelivery } from "../src/notifications/delivery";
import { REGISTRY } from "../src/notifications/registry";
import { seedPerson } from "./helpers/persons";
import type { NotificationKind } from "@shared/notifications";
import type { NotificationOutboxRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";
import type { DB } from "../src/db";

const TZ = "America/New_York";
const FRI = new Date("2026-09-11T12:00:00.000Z"); // Friday 08:00 ET
const MON = new Date("2026-09-14T12:00:00.000Z"); // Monday 08:00 ET

// seedPerson is INSERT OR IGNORE — for the four persons the global reset
// already seeds (e.g. AndresL230), it would leave email/unsubscribed
// untouched. This helper always seeds AND forces email/unsubscribed to the
// requested value, so eligibility (`email IS NOT NULL ... AND email_unsubscribed = 0`)
// is exactly what each test asks for regardless of pre-seeding.
async function user(login: string, email: string | null, unsubscribed = 0): Promise<void> {
  await seedPerson(login, { name: login, email, unsubscribed: unsubscribed as 0 | 1 });
  await run(env.DB, `UPDATE persons SET email = ?, email_unsubscribed = ? WHERE handle = ?`, email, unsubscribed, login);
}
function openIssue(number: number, login: string): CapturedEvent {
  const updatedAt = "2026-09-10T15:00:00Z";
  return {
    semantic_key: `gh:issue:${number}:assigned:${updatedAt}`, event_type: "issue", ref_number: number, subject_login: login, provenance: "webhook", occurred_at: updatedAt,
    // GitHub's own key — not Trov vocabulary (a payload literal).
    raw: JSON.stringify({ action: "assigned", issue: { number, title: `Issue ${number}`, html_url: `https://github.com/o/r/issues/${number}`, state: "open", updated_at: updatedAt, user: { login }, assignees: [{ login }], labels: [], milestone: null } }),
  };
}
const outbox = () => all<NotificationOutboxRow>(env.DB, `SELECT * FROM notification_outbox ORDER BY user_id, cadence`);
const bodies = () => all<{ idempotency_key: string; to_address: string; subject: string; html: string; text: string }>(env.DB, `SELECT * FROM notification_outbox_bodies ORDER BY idempotency_key`);
const kindsOf = (row: NotificationOutboxRow) => JSON.parse(row.kinds) as string[];

describe("computeWindow", () => {
  it("daily on a weekday: previous 24h, id is the org-local date", () => {
    const w = computeWindow("daily", FRI, TZ);
    expect(w).toMatchObject({ cadence: "daily", id: "2026-09-11" });
    expect(w.end.toISOString()).toBe(FRI.toISOString());
    expect(w.start.toISOString()).toBe("2026-09-10T12:00:00.000Z");
  });
  it("daily on Monday covers Friday send to Monday send (72h)", () => {
    const w = computeWindow("daily", MON, TZ);
    expect(w.id).toBe("2026-09-14");
    expect(w.start.toISOString()).toBe("2026-09-11T12:00:00.000Z");
  });
  it("the daily id follows the org timezone, not UTC", () => {
    // 02:00Z on Sep 12 is 22:00 ET on Sep 11.
    expect(computeWindow("daily", new Date("2026-09-12T02:00:00.000Z"), TZ).id).toBe("2026-09-11");
  });
  it("weekly: previous 7 days, id is the ISO week", () => {
    const w = computeWindow("weekly", MON, TZ);
    expect(w).toMatchObject({ cadence: "weekly", id: "2026-W38" });
    expect(w.start.toISOString()).toBe("2026-09-07T12:00:00.000Z");
    expect(computeWindow("weekly", new Date("2026-01-04T12:00:00.000Z"), TZ).id).toBe("2026-W01"); // Sunday Jan 4 2026 → ISO week 1
  });
});

describe("resolveCadence — three layers, first match wins", () => {
  it("falls through to the registry default when neither pref nor policy row exists", async () => {
    expect(await resolveCadence(env.DB, "u", "roadmap_plan")).toBe("weekly");
  });
  it("policy default_cadence beats the registry default", async () => {
    await seedNotificationPolicy(env.DB);
    await run(env.DB, `UPDATE notification_policy SET default_cadence = 'daily' WHERE kind = 'roadmap_plan'`);
    expect(await resolveCadence(env.DB, "u", "roadmap_plan")).toBe("daily");
  });
  it("a user pref beats the policy default", async () => {
    await seedNotificationPolicy(env.DB);
    await run(env.DB, `INSERT INTO notification_prefs (user_id, kind, cadence, updated_at) VALUES ('u', 'my_work', 'weekly', 'now')`);
    expect(await resolveCadence(env.DB, "u", "my_work")).toBe("weekly");
    expect(await resolveCadence(env.DB, "someone-else", "my_work")).toBe("daily");
  });
  it("policy enabled = 0 short-circuits to off before the user layer is consulted", async () => {
    await seedNotificationPolicy(env.DB);
    await run(env.DB, `UPDATE notification_policy SET enabled = 0 WHERE kind = 'my_work'`);
    await run(env.DB, `INSERT INTO notification_prefs (user_id, kind, cadence, updated_at) VALUES ('u', 'my_work', 'daily', 'now')`);
    expect(await resolveCadence(env.DB, "u", "my_work")).toBe("off");
  });
  it("an unknown kind resolves to off", async () => {
    expect(await resolveCadence(env.DB, "u", "nope")).toBe("off");
  });
});

describe("runDigest (local mode)", () => {
  const delivery = () => localDelivery(env.DB);

  it("running the same window twice yields exactly one outbox row per eligible user", async () => {
    await user("AndresL230", "andres@example.com");
    await user("lpcooper-arch", "luke@example.com");
    await ingestAdrDraft(systemCtx(), { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");

    const r1 = await runDigest(env.DB, "daily", FRI, { delivery: delivery() });
    const r2 = await runDigest(env.DB, "daily", FRI, { delivery: delivery() });
    const rows = await outbox();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotency_key).sort()).toEqual(["AndresL230:daily:2026-09-11", "lpcooper-arch:daily:2026-09-11"]);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    expect(r1.sent).toBe(2);
    expect(r2.alreadyRan).toBe(2);
    expect(await bodies()).toHaveLength(2);
  });

  it("a user whose renderers all return null gets a skipped row and no body", async () => {
    await user("AndresL230", "andres@example.com");
    await runDigest(env.DB, "daily", FRI, { delivery: delivery() });
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "skipped", kinds: "[]", resend_id: null, sent_at: null });
    expect(await bodies()).toHaveLength(0);
  });

  it("an unsubscribed user and a user with no address get no row at all", async () => {
    await user("AndresL230", "andres@example.com", 1);
    await user("lpcooper-arch", null);
    await user("Darkest-Teddy", "");
    await ingestAdrDraft(systemCtx(), { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await runDigest(env.DB, "daily", FRI, { delivery: delivery() });
    expect(await outbox()).toHaveLength(0);
    expect(await bodies()).toHaveLength(0);
  });

  it("a policy-disabled kind is never rendered regardless of the user's pref", async () => {
    await user("AndresL230", "andres@example.com");
    await seedNotificationPolicy(env.DB);
    await run(env.DB, `UPDATE notification_policy SET enabled = 0 WHERE kind = 'review_queue'`);
    await run(env.DB, `INSERT INTO notification_prefs (user_id, kind, cadence, updated_at) VALUES ('AndresL230', 'review_queue', 'daily', 'now')`);
    await ingestAdrDraft(systemCtx(), { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await ingestEvent(systemCtx(), platformCtx(), openIssue(1, "AndresL230"), "github-webhook");

    await runDigest(env.DB, "daily", FRI, { delivery: delivery() });
    const [row] = await outbox();
    expect(row.status).toBe("sent");
    expect(kindsOf(row)).toEqual(["my_work"]);
    const [body] = await bodies();
    expect(body.html).not.toContain("Pending decision");
    expect(body.text).not.toContain("Review queue");
  });

  it("a weekly pref on my_work excludes it from the daily run and includes it in the weekly run", async () => {
    await user("AndresL230", "andres@example.com");
    await run(env.DB, `INSERT INTO notification_prefs (user_id, kind, cadence, updated_at) VALUES ('AndresL230', 'my_work', 'weekly', 'now')`);
    await ingestEvent(systemCtx(), platformCtx(), openIssue(1, "AndresL230"), "github-webhook");

    await runDigest(env.DB, "daily", MON, { delivery: delivery() });
    await runDigest(env.DB, "weekly", MON, { delivery: delivery() });
    const rows = await outbox();
    const daily = rows.find((r) => r.cadence === "daily")!;
    const weekly = rows.find((r) => r.cadence === "weekly")!;
    expect(daily.status).toBe("skipped"); // nothing else renders for a fresh store
    expect(kindsOf(daily)).not.toContain("my_work");
    expect(weekly.status).toBe("sent");
    expect(kindsOf(weekly)).toContain("my_work");
    const b = (await bodies()).find((x) => x.idempotency_key === weekly.idempotency_key)!;
    expect(b.text).toContain("Issue 1");
  });

  it("assembles one message per user with the spec subject, all sections, and absolute deep links", async () => {
    await user("AndresL230", "andres@example.com");
    await ingestAdrDraft(systemCtx(), { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await ingestEvent(systemCtx(), platformCtx(), openIssue(1, "AndresL230"), "github-webhook");

    await runDigest(env.DB, "daily", FRI, { delivery: delivery(), origin: "https://trov.example" });
    const [row] = await outbox();
    expect(row).toMatchObject({ status: "sent", user_id: "AndresL230", window_id: "2026-09-11" });
    expect(kindsOf(row)).toEqual(["my_work", "review_queue"]);
    expect(row.sent_at).not.toBeNull();
    const [body] = await bodies();
    expect(body.to_address).toBe("andres@example.com");
    expect(body.subject).toBe("Trov daily, Sep 11");
    expect(body.html).toContain("My Work");
    expect(body.html).toContain("Review queue");
    expect(body.html).toContain(`href="https://trov.example/#mywork"`);
    expect(body.text).toContain("https://trov.example/#review");
    expect(body.text).toContain("Issue 1");
    expect(body.text).toContain("Pending decision");
  });

  it("weekly subject names the work week", async () => {
    await user("AndresL230", "andres@example.com");
    await ingestEvent(systemCtx(), platformCtx(), openIssue(1, "AndresL230"), "github-webhook");
    await run(env.DB, `INSERT INTO notification_prefs (user_id, kind, cadence, updated_at) VALUES ('AndresL230', 'my_work', 'weekly', 'now')`);
    await runDigest(env.DB, "weekly", MON, { delivery: delivery() });
    const [body] = await bodies();
    expect(body.subject).toBe("Trov weekly, Sep 7 to 11");
  });

  it("a renderer that throws marks the row failed with the error and sends nothing", async () => {
    await user("AndresL230", "andres@example.com");
    const boom: NotificationKind<DB> = {
      id: "boom", label: "Boom", description: "x", defaultCadence: "daily", allowedCadences: ["daily", "off"],
      render: async () => { throw new Error("renderer exploded"); },
    };
    await runDigest(env.DB, "daily", FRI, { delivery: delivery(), registry: [...REGISTRY, boom] });
    const [row] = await outbox();
    expect(row.status).toBe("failed");
    expect(row.error).toContain("renderer exploded");
    expect(await bodies()).toHaveLength(0);
  });

  it("a delivery failure marks the row failed with the error", async () => {
    await user("AndresL230", "andres@example.com");
    await ingestAdrDraft(systemCtx(), { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await runDigest(env.DB, "daily", FRI, { delivery: { send: async () => { throw new Error("smtp down"); } } });
    const [row] = await outbox();
    expect(row).toMatchObject({ status: "failed", resend_id: null, sent_at: null });
    expect(row.error).toContain("smtp down");
  });

  it("never sends to the same user twice even if the first run failed (retry is a separate job)", async () => {
    await user("AndresL230", "andres@example.com");
    await ingestAdrDraft(systemCtx(), { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await runDigest(env.DB, "daily", FRI, { delivery: { send: async () => { throw new Error("smtp down"); } } });
    const r = await runDigest(env.DB, "daily", FRI, { delivery: delivery() });
    expect(r.alreadyRan).toBe(1);
    const [row] = await outbox();
    expect(row.status).toBe("failed");
    expect(await bodies()).toHaveLength(0);
  });
});

describe("assembled message follows the designed template", () => {
  it("carries a preheader, the section sublines, the footer unsubscribe link, and the text layout", async () => {
    await user("AndresL230", "andres@example.com");
    await ingestAdrDraft(systemCtx(), { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await ingestEvent(systemCtx(), platformCtx(), openIssue(1, "AndresL230"), "github-webhook");
    await runDigest(env.DB, "daily", FRI, {
      delivery: localDelivery(env.DB), origin: "https://trov.example",
      unsubscribeUrl: async (login) => `https://trov.example/u/${login}.sig`,
    });
    const [b] = await bodies();
    expect(b.html).toContain("1 assigned issue open");           // section subline
    expect(b.html).toContain("1 decision waiting");                // review subline
    expect(b.html).toContain(`href="https://trov.example/u/AndresL230.sig"`); // footer
    expect(b.html).toContain("daily Trov digest for AndresL230");
    expect(b.text).toContain("TROV DAILY — SEP 11");
    expect(b.text).toContain("Unsubscribe: https://trov.example/u/AndresL230.sig");
    expect(b.text).toMatch(/open\s+#1\s+Issue 1/);
  });
});
