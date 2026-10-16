-- 0075_identities_person_nocase — an index that lets a person's identities be found without a scan.
--
-- ADDITIVE: one new index, no table touched, nothing removed. Every reader of a person's identities compares
-- the handle case-insensitively — `WHERE person = ? COLLATE NOCASE` (src/auth/persons.ts `listIdentities`,
-- which /auth/me runs on every boot, and `memberGithubLogins`; src/tools/people.ts, src/plans/grants.ts,
-- src/orgs/repo.ts, src/platform/support.ts, src/deletion/person.ts) — like `persons.handle` itself. The only
-- index on the column, `idx_identities_person` (0023_persons), is BINARY, which SQLite cannot use for a NOCASE
-- comparison, so each of those reads scanned the whole table. This one is NOCASE; the BINARY index stays for
-- any plain `person = ?` (a join on the column) that still uses it. `test/perf.indexes.test.ts` holds the plan
-- (EXPLAIN QUERY PLAN names this index, never a scan of identities).
--
-- Rollback: DROP INDEX IF EXISTS idx_identities_person_nocase;

CREATE INDEX IF NOT EXISTS idx_identities_person_nocase ON identities(person COLLATE NOCASE);
