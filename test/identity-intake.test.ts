import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { platformCtx, systemCtx } from "./helpers/tenant";
import { all, first, run } from "../src/db";
import { ingestEvent } from "../src/consumer";
import type { EventRow, IdentityTaskRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

const ev = (over: Partial<CapturedEvent> = {}): CapturedEvent => ({
  semantic_key: "gh:pr:7:merged",
  event_type: "pr_merged",
  ref_number: 7,
  subject_login: "mystery-dev",
  raw: JSON.stringify({ pr: { number: 7, title: "Fix the flux capacitor", body: "b" } }),
  provenance: "webhook",
  occurred_at: "2026-07-01T10:00:00Z",
  ...over,
});

describe("ingestEvent identity intake", () => {
  // The spec-mandated assertion: the event lands whether or not the task is raised.
  it("captures the event AND raises one pending identity task for an unknown login", async () => {
    const res = await ingestEvent(systemCtx(), platformCtx(), ev(), "github-webhook");
    expect(res.outcome).toBe("written");

    // The event row exists even though the login is unknown.
    const events = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(events.length).toBe(1);
    expect(events[0].subject_login).toBe("mystery-dev");

    const task = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`);
    expect(task).toMatchObject({ login: "mystery-dev", status: "pending", resolved_at: null, resolved_by: null });
    expect(task!.first_seen).toBeTruthy();
  });

  it("many events from one unknown person make one task", async () => {
    await ingestEvent(systemCtx(), platformCtx(), ev(), "github-webhook");
    await ingestEvent(systemCtx(), platformCtx(), ev({ semantic_key: "gh:pr:8:merged", ref_number: 8 }), "github-webhook");
    await ingestEvent(systemCtx(), platformCtx(), ev({ semantic_key: "gh:issue:9:closed:2026-07-01T10:00:00Z", event_type: "issue", ref_number: 9 }), "github-webhook");
    const tasks = await all<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks`);
    expect(tasks.length).toBe(1);
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(3);
  });

  it("a mapped login (0012 seed) raises nothing", async () => {
    await ingestEvent(systemCtx(), platformCtx(), ev({ subject_login: "AndresL230" }), "github-webhook");
    expect((await all<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks`)).length).toBe(0);
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(1); // event still captured
  });

  it("an unchanged redelivery still leaves exactly one task (intake runs on dedupe hits too)", async () => {
    await ingestEvent(systemCtx(), platformCtx(), ev(), "github-webhook");
    await run(env.DB, `DELETE FROM identity_tasks`); // simulate an event captured before the feature existed
    const res = await ingestEvent(systemCtx(), platformCtx(), ev(), "github-webhook");
    expect(res.outcome).toBe("unchanged");
    expect((await all<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`)).length).toBe(1);
  });

  it("a resolved task is never re-raised by later events (PK guard)", async () => {
    await ingestEvent(systemCtx(), platformCtx(), ev(), "github-webhook");
    await run(env.DB, `UPDATE identity_tasks SET status = 'resolved', resolved_at = '2026-07-02T00:00:00Z', resolved_by = 'andres' WHERE login = 'mystery-dev'`);
    await ingestEvent(systemCtx(), platformCtx(), ev({ semantic_key: "gh:pr:99:merged", ref_number: 99 }), "github-webhook");
    const tasks = await all<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`);
    expect(tasks.length).toBe(1);
    expect(tasks[0].status).toBe("resolved"); // untouched, not flipped back to pending
  });

  it("a bot login ([bot] suffix) never raises an identity task; the event still lands", async () => {
    await ingestEvent(systemCtx(), platformCtx(), ev({ subject_login: "dependabot[bot]" }), "github-webhook");
    expect((await all<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks`)).length).toBe(0);
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(1); // event still captured
  });

  it("intake failure never breaks event capture (identity_tasks table missing)", async () => {
    await run(env.DB, `DROP TABLE identity_tasks`);
    try {
      const res = await ingestEvent(systemCtx(), platformCtx(), ev(), "github-webhook");
      expect(res.outcome).toBe("written");
      expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(1);
    } finally {
      // Restore the 0016 schema so the harness beforeEach (DELETE FROM identity_tasks)
      // and later tests keep working. DDL identical to migrations/0016_identity_tasks.sql.
      await run(
        env.DB,
        `CREATE TABLE identity_tasks (
           login TEXT PRIMARY KEY,
           first_seen TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'pending',
           resolved_at TEXT,
           resolved_by TEXT
         )`
      );
    }
  });
});
