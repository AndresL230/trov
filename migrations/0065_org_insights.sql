-- 0065_org_insights: what Trov writes about the ROADMAP (docs/architecture/roadmap-my-work.md › Roadmap
-- intelligence; docs/architecture/ai.md; docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase D, "Roadmap").
-- ADDITIVE ONLY: one new TENANT table; nothing existing changes, no row is rewritten, and a Worker from before it
-- keeps working (it never names it).
--
-- org_insights: one row per thing the AI pass's org rollup WROTE — a computed write, never a suggestion and never
-- official. Every statement names `org_id`. No handle column (nothing here is owned by a person).
--   kind            `sprint_note` (key = the sprint's id, as text) or `plan_drift` (key = '')
--   key             which one
--   version         1, 2, 3… per (org, kind, key); the newest is what the Roadmap reads. The writer keeps the
--                   LAST 10 per key and deletes the rest in the same batch.
--   generated_at    when the pass wrote it
--   model           the model that wrote the words (provenance; NULL never written by the pass)
--   prompt_version  the job's prompt version
--   json            `{ text, cites: AiCite[] }` (+ `shares` for a drift): the cites were checked against the
--                   input the model was given, and the numbers in a drift came from the server, never the model
--
-- In ORG_TABLES (an org's deletion takes it) and the reset seed.
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). It LOSES every sprint note and
-- drift line (the pass writes them again at the next rollup):
--   DROP INDEX IF EXISTS idx_org_insights_latest;
--   DROP TABLE IF EXISTS org_insights;
--   DELETE FROM d1_migrations WHERE name = '0065_org_insights.sql';
CREATE TABLE IF NOT EXISTS org_insights (
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  kind            TEXT NOT NULL CHECK (kind IN ('sprint_note', 'plan_drift')),
  key             TEXT NOT NULL DEFAULT '',
  version         INTEGER NOT NULL CHECK (version >= 1),
  generated_at    TEXT NOT NULL,
  model           TEXT,
  prompt_version  TEXT,
  json            TEXT NOT NULL,
  PRIMARY KEY (org_id, kind, key, version)
);
-- The Roadmap reads the newest version per key.
CREATE INDEX IF NOT EXISTS idx_org_insights_latest ON org_insights(org_id, kind, key, version DESC);
