-- HAND-WRITTEN (not generated — scripts/mt/build-rollback.py only writes 0037-0040.down.sql).
-- Rollback of 0048_github_app.sql: the two tables it created. Both reference orgs(id), so this runs BEFORE
-- 0043.down.sql and 0037-0040.down.sql:
--   wrangler d1 execute trov --remote --file scripts/mt/rollback/0048.down.sql
-- Every statement is a no-op when 0048 was never applied, so it is safe to run on any database. A pre-0048
-- Worker never reads either table; dropping them forgets every bound installation (an admin re-installs).
--
-- Not undone here, on purpose: `org_repos.installation_id` (one nullable column, unread by a pre-0048 Worker;
-- the generated rollback drops org_repos whole).

DROP INDEX IF EXISTS idx_github_installation_repos_org;
DROP TABLE IF EXISTS github_installation_repos;
DROP INDEX IF EXISTS idx_github_installations_org;
DROP TABLE IF EXISTS github_installations;
DELETE FROM d1_migrations WHERE name = '0048_github_app.sql';
