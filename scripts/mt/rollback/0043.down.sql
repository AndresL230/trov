-- HAND-WRITTEN (not generated — scripts/mt/build-rollback.py only writes 0037-0040.down.sql).
-- Rollback of 0043_platform_orgs.sql: the two tables it created. Run it BEFORE 0037-0040.down.sql —
-- both tables reference orgs(id), which that file drops:
--   wrangler d1 execute canopy --remote --file scripts/mt/rollback/0043.down.sql
--   wrangler d1 execute canopy --remote --file scripts/mt/rollback/0037-0040.down.sql
-- Every statement is a no-op when 0043 was never applied, so it is safe to run on any database.
--
-- Not undone here, on purpose:
--   • the columns 0043 added (orgs.suspended_at / suspended_by, org_invites.as_owner) — a column drop is
--     optional: both tables are dropped whole by 0037-0040.down.sql, and on their own the columns are
--     NULL / 0 for every row and unread by a pre-0043 Worker;
--   • 0041 (a data change: the mail sender) and 0042 (`platform_admins`, which references only persons) —
--     neither blocks the 0037-0040 rollback; drop `platform_admins` by hand if a full return to 0036 is wanted.

DROP INDEX IF EXISTS idx_org_usage_daily_day;
DROP TABLE IF EXISTS org_usage_daily;
DROP INDEX IF EXISTS idx_org_admin_audit_org;
DROP INDEX IF EXISTS idx_org_admin_audit_at;
DROP TABLE IF EXISTS org_admin_audit;
DELETE FROM d1_migrations WHERE name = '0043_platform_orgs.sql';
