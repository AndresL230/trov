// Query plans that must use an index (the performance plan, P3). EXPLAIN QUERY PLAN against the real, migrated
// Miniflare D1 — the statements are the production ones, spelled out, so a reader that drifts from the index
// (or an index that goes away) fails here.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "./helpers/db";

interface PlanRow { id: number; parent: number; notused: number; detail: string }

/** Every line of the statement's query plan. */
async function plan(sql: string, ...params: unknown[]): Promise<string[]> {
  return (await all<PlanRow>(env.DB, `EXPLAIN QUERY PLAN ${sql}`, ...params)).map((r) => r.detail);
}

describe("identities by person — the NOCASE index (0075_identities_person_nocase)", () => {
  it("exists, on identities(person COLLATE NOCASE)", async () => {
    const [row] = await all<{ sql: string }>(env.DB, `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_identities_person_nocase'`);
    expect(row?.sql).toMatch(/ON identities\s*\(\s*person COLLATE NOCASE\s*\)/i);
  });

  // The readers of a person's identities, as src/ writes them (each compares the handle without case).
  const READS: [where: string, sql: string, params: unknown[]][] = [
    ["listIdentities (/auth/me)", `SELECT * FROM identities WHERE person = ? COLLATE NOCASE ORDER BY linked_at ASC`, ["andresl230"]],
    ["getPersonProfile's GitHub login", `SELECT subject FROM identities WHERE provider = 'github' AND person = ? COLLATE NOCASE ORDER BY linked_at ASC LIMIT 1`, ["andresl230"]],
    ["the account deletion's preview", `SELECT provider, subject, label, verified_email FROM identities WHERE person = ? COLLATE NOCASE`, ["andresl230"]],
    ["memberGithubLogins", `SELECT i.subject, i.linked_at AS at FROM identities i JOIN memberships m ON m.user_id = i.person AND m.org_id = ?
      WHERE i.person = ? COLLATE NOCASE AND i.provider = 'github'`, ["org_saplinglearn", "andresl230"]],
  ];

  for (const [where, sql, params] of READS) {
    it(`${where}: searches identities with the index, never a scan`, async () => {
      const lines = await plan(sql, ...params);
      // Without the index, these read `SCAN identities` (or SEARCH on the provider half of the primary key).
      expect(lines.join("\n"), where).toMatch(/^SEARCH (identities|i) USING INDEX idx_identities_person_nocase \(person=\?\)/m);
      expect(lines.filter((l) => /^SCAN (identities|i)\b/.test(l)), where).toEqual([]);
    });
  }

  it("and the answer is still case-insensitive", async () => {
    const rows = await all<{ person: string }>(env.DB, `SELECT person FROM identities WHERE person = ? COLLATE NOCASE`, "ANDRESL230");
    expect(rows.map((r) => r.person)).toEqual(["AndresL230"]);
  });
});
