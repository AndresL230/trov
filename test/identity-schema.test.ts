import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run } from "./helpers/db";
import type { IdentityTaskRow, IdentityRow } from "@shared/rows";

describe("identity_tasks schema (0016)", () => {
  it("stores one task per login with pending status and null audit columns", async () => {
    await run(
      env.DB,
      `INSERT INTO identity_tasks (login, first_seen, status) VALUES (?, ?, 'pending')`,
      "mystery-dev",
      "2026-07-01T10:00:00Z"
    );
    const row = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = ?`, "mystery-dev");
    expect(row).toMatchObject({
      login: "mystery-dev",
      first_seen: "2026-07-01T10:00:00Z",
      status: "pending",
      resolved_at: null,
      resolved_by: null,
    });
  });

  it("login is the PK: INSERT OR IGNORE collapses a second task for the same login", async () => {
    await run(env.DB, `INSERT OR IGNORE INTO identity_tasks (login, first_seen, status) VALUES ('dup', '2026-07-01T10:00:00Z', 'pending')`);
    await run(env.DB, `INSERT OR IGNORE INTO identity_tasks (login, first_seen, status) VALUES ('dup', '2026-07-02T10:00:00Z', 'pending')`);
    const rows = await all<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'dup'`);
    expect(rows.length).toBe(1);
    expect(rows[0].first_seen).toBe("2026-07-01T10:00:00Z"); // the first sighting wins
  });

  // Sequential within this file: this test dirties identities; the next asserts
  // the harness reset restored the dev/test seed. Guards Task 3's runtime writes
  // from leaking across tests.
  it("dirties the identities map (setup for the reseed assertion below)", async () => {
    await run(
      env.DB,
      `INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('github', 'leaky-login', 'leaky-login', 'AndresL230', '2026-01-01T00:00:00Z', 'test')`
    );
    expect((await all<IdentityRow>(env.DB, `SELECT * FROM identities`)).length).toBe(7); // 6 seeded + the leak
  });

  it("beforeEach resets identities back to exactly the dev/test seed", async () => {
    const identities = await all<IdentityRow>(env.DB, `SELECT * FROM identities ORDER BY subject`);
    // Four github identities (the engineers) + two google ones (the non-engineer
    // requesters seeded for the ticket queue) = the whole dev/test seed.
    expect(identities.length).toBe(6);
    expect(identities.map((i) => i.subject).sort()).toEqual(
      ["AndresL230", "Darkest-Teddy", "Jose-Gael-Cruz-Lopez", "google-sub-meilin", "google-sub-sanaok", "lpcooper-arch"].sort()
    );
    expect(await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'leaky-login'`)).toBeNull();
  });
});
