-- HAND-WRITTEN (not generated — scripts/mt/build-rollback.py only writes 0037-0040.down.sql).
-- Rollback of 0046_abuse_limits.sql: the one table it created. It references nothing and nothing
-- references it, so it can run at any point — before or after 0043.down.sql and 0037-0040.down.sql:
--   wrangler d1 execute canopy --remote --file scripts/mt/rollback/0046.down.sql
-- Every statement is a no-op when 0046 was never applied, so it is safe to run on any database.
-- A pre-0046 Worker never reads the table; dropping it only forgets the current windows' counts.
--
-- Not undone here, on purpose: 0045 (`identities.provider_uid`, one nullable column — NULL or an
-- account id for every row and unread by a pre-0045 Worker) and 0047 (four nullable columns on
-- `org_invites`, unread by a pre-0047 Worker). There is no 0045.down.sql, no 0047.down.sql and no 0044.

DROP INDEX IF EXISTS idx_abuse_counters_bucket;
DROP TABLE IF EXISTS abuse_counters;
DELETE FROM d1_migrations WHERE name = '0046_abuse_limits.sql';
