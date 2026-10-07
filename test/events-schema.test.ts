import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, run, nowIso } from "./helpers/db";
import type { EventRow } from "@shared/rows";

describe("0012 stores", () => {
  it("events.semantic_key is UNIQUE and INSERT OR IGNORE dedupes", async () => {
    const now = nowIso();
    const ins = (key: string) =>
      run(env.DB, `INSERT OR IGNORE INTO events (semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
                   VALUES (?, 'pr_merged', 42, 'AndresL230', '{}', 'webhook', ?, ?, 'github-webhook')`, key, now, now);
    const first = await ins("gh:pr:42:merged");
    expect(first.meta.changes).toBe(1);
    const dup = await ins("gh:pr:42:merged");
    expect(dup.meta.changes).toBe(0);
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(1);
  });

  it("identities is seeded with the dev/test github logins mapped to their persons", async () => {
    const identities = await all<{ subject: string; name: string | null }>(
      env.DB,
      `SELECT i.subject AS subject, p.name AS name FROM identities i JOIN persons p ON p.handle = i.person WHERE i.provider = 'github' ORDER BY i.subject`
    );
    expect(identities.map((i) => [i.subject, i.name])).toEqual([
      ["AndresL230", "Andres"],
      ["Darkest-Teddy", "Jack"],
      ["Jose-Gael-Cruz-Lopez", "Jose"],
      ["lpcooper-arch", "Luke"],
    ]);
  });

  it("sprints has a phase column and plan/plan_versions exist", async () => {
    await run(env.DB, `INSERT INTO sprints (title, target_date, status, phase, created_at, created_by) VALUES ('m', '2026-08-01', 'upcoming', 'Phase 1', ?, 'a')`, nowIso());
    const rows = await all<{ phase: string | null }>(env.DB, `SELECT phase FROM sprints`);
    expect(rows[0].phase).toBe("Phase 1");
    expect(await all(env.DB, `SELECT * FROM plan_versions`)).toEqual([]);
  });

  // Revert guard (0014): the `focus` table (0007) is torn down for good — the
  // per-person "current focus" feature never shipped a reader beyond the gate.
  it("the focus table is gone (0014_drop_focus)", async () => {
    const rows = await all<{ name: string }>(
      env.DB,
      `SELECT name FROM sqlite_master WHERE type='table' AND name='focus'`
    );
    expect(rows).toEqual([]);
  });
});
