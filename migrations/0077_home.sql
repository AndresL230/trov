-- 0077_home: Home's "Docs promoted" figure (shared/home-core.ts, src/tools/home.ts) needs WHEN a doc version was
-- promoted; until now only its status changed. ADDITIVE:
--   · doc_versions.promoted_at — set by promote_doc (src/tools/writes.ts) from now on; NULL on every version promoted
--     before this file (never backfilled: the staging time is not the promotion time, and Home never guesses).
--   · orgs.promotions_timed_at — when this org's promotions started being timed: every org that exists now gets the
--     moment this file runs; an org created later keeps NULL and is timed from its own created_at. Home reads a day
--     before that moment as unknown ("—"), never as 0.
-- Rollback by hand: ALTER TABLE doc_versions DROP COLUMN promoted_at; ALTER TABLE orgs DROP COLUMN promotions_timed_at;
-- then DELETE FROM d1_migrations WHERE name = '0077_home.sql'.
ALTER TABLE doc_versions ADD COLUMN promoted_at TEXT;
ALTER TABLE orgs ADD COLUMN promotions_timed_at TEXT;
UPDATE orgs SET promotions_timed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
CREATE INDEX IF NOT EXISTS idx_doc_versions_promoted ON doc_versions(org_id, promoted_at);
