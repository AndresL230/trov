-- 0051_mcp_connection_orgs: an MCP connection (an OAuth grant) is no longer bound to exactly one
-- organization (docs/architecture/data-layer.md § Bearer). It has a MODE:
--
--   manual   the connection may use a SET of the person's organizations (`oauth_grant_orgs`, one row
--            per organization) and acts in ONE of them at a time: its CURRENT organization, which is
--            `oauth_grants.org_id`, the column that always named the grant's org.
--   repo     the connection follows the repository the agent is working in: each call names a
--            repository and resolves to the one organization, among those the person is a member of
--            now, that has it connected. `oauth_grants.org_id` is '' (it belongs to no organization),
--            and its `oauth_grant_orgs` rows are the organizations it has been USED in, written the
--            first time a call resolves there (that is what the plan's agent-connection limit counts).
--
-- EVERY EXISTING GRANT KEEPS EXACTLY ITS REACH. The new column defaults to 'manual', and the backfill
-- below gives each live grant ONE row: the organization already on it, which stays its current one. A
-- grant reaches a second organization only when its person adds one in Settings, signed in.
--
-- ADDITIVE: one column with a default, one new table, one trigger. No existing row is rewritten. A
-- Worker from before this migration keeps working: it reads `oauth_grants.org_id` as it always did —
-- a manual grant's current organization (one its person allowed), and '' for a `repo` grant, which is
-- no organization's id and so resolves for nobody (a 401), never to someone's data.
--
--   oauth_grant_orgs.person   a person HANDLE (HANDLE_COLUMNS: a rename rewrites it) — the grant's own.
--
-- The trigger keeps the count honest wherever a grant is revoked (Settings, the token endpoint, a
-- reused refresh token, a removed member): a revoked grant holds no organization's slot.
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). First revoke the grants an
-- older Worker could not describe, then drop what was added:
--   UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, datetime('now')), revoked_reason = COALESCE(revoked_reason, 'user') WHERE mode = 'repo';
--   DROP TRIGGER IF EXISTS oauth_grants_revoked_au;
--   DROP INDEX IF EXISTS idx_oauth_grant_orgs_org_person;
--   DROP TABLE IF EXISTS oauth_grant_orgs;
--   ALTER TABLE oauth_grants DROP COLUMN mode;
--   DELETE FROM d1_migrations WHERE name = '0051_mcp_connection_orgs.sql';
-- A manual grant that was given several organizations is then bound to its current one again.

ALTER TABLE oauth_grants ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'repo'));

CREATE TABLE IF NOT EXISTS oauth_grant_orgs (
  grant_id  INTEGER NOT NULL REFERENCES oauth_grants(id),
  org_id    TEXT NOT NULL REFERENCES orgs(id),
  person    TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (grant_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_grant_orgs_org_person ON oauth_grant_orgs(org_id, person);

-- Each live grant: its one organization, and nothing else.
INSERT OR IGNORE INTO oauth_grant_orgs (grant_id, org_id, person, added_at)
SELECT g.id, g.org_id, g.person, g.created_at FROM oauth_grants g
 WHERE g.revoked_at IS NULL AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = g.org_id);

CREATE TRIGGER IF NOT EXISTS oauth_grants_revoked_au AFTER UPDATE OF revoked_at ON oauth_grants
WHEN new.revoked_at IS NOT NULL BEGIN
  DELETE FROM oauth_grant_orgs WHERE grant_id = new.id;
END;
