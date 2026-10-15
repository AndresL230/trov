-- 0057_ai_dirty: what the AI router marks stale, and the organization's Auto switch for Ask Trov
-- (docs/architecture/ai.md; docs/superpowers/specs/2026-10-15-server-ai-build.md › Phases A, B and F).
-- ADDITIVE ONLY: one new TENANT table and one column on `orgs`; nothing existing changes, no row is rewritten,
-- and a Worker from before it keeps working (it names neither).
--
-- PART 1 — ai_dirty: one row per SCOPE of an organization that a write made stale and the AI pass has not
-- written since (Phase B: `src/ai/router.ts` marks, `src/ai/pass.ts` clears). NOTHING WRITES IT YET — it ships
-- here so the router and the pass build on a table that is already in every database. Every statement names
-- `org_id`. No handle column (a `person:<handle>` scope key is text the pass reads, never an owner).
--   scope         what kind of thing is stale: `card`, `session`, `person`, `repo`, `org`, `sprint`,
--                 `theme_window`, `theme_backfill`, `doc_drift`
--   scope_key     which one: `pr:173`, `AndresL230/trov:andres`, a handle, a repo, '' for the org itself
--   dirty_since   when it FIRST went stale since its last run (marking an already-dirty scope keeps it)
--   last_run_at   when the pass last wrote it; NULL = never
--   attempts      failed runs since it was marked; after 3 it waits until it is marked again
--   last_error    the last failure's NAME only (never a model's text, never a secret); NULL = none
--
-- PART 2 — orgs.ai_chat_auto, the organization's Auto switch for Ask Trov (organizations.md › Org settings ›
-- AI). Ask Trov's "Auto" lets a person's writes run without a Confirm card (Phase F); an admin turns it off for
-- the whole organization in Org settings › AI (`PUT /api/o/:slug/ai/settings { chatAuto }`, a cookie route —
-- never MCP), audited `org.ai_chat_auto`. ON for every org (existing and new). It moved here from
-- 0065_ask, so Org settings › AI has a column for the switch from Phase A.
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). It LOSES every stale mark (the
-- pass re-marks on the next writes) and the admins' Auto choices:
--   DROP INDEX IF EXISTS idx_ai_dirty_since;
--   DROP TABLE IF EXISTS ai_dirty;
--   ALTER TABLE orgs DROP COLUMN ai_chat_auto;
--   DELETE FROM d1_migrations WHERE name = '0057_ai_dirty.sql';
CREATE TABLE IF NOT EXISTS ai_dirty (
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  scope        TEXT NOT NULL,
  scope_key    TEXT NOT NULL DEFAULT '',
  dirty_since  TEXT NOT NULL,
  last_run_at  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error   TEXT,
  PRIMARY KEY (org_id, scope, scope_key)
);
-- The pass reads an org's scopes oldest first.
CREATE INDEX IF NOT EXISTS idx_ai_dirty_since ON ai_dirty (org_id, dirty_since);

ALTER TABLE orgs ADD COLUMN ai_chat_auto INTEGER NOT NULL DEFAULT 1;
