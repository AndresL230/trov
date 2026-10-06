-- Multitenancy (canopy-multitenancy.md, Phase 2) — part 2 of 4: `org_id` on every tenant table whose
-- KEYS do not change, and the per-org display numbers (Q2).
--
-- These tables keep their shape and gain one column. SQLite's ADD COLUMN cannot carry a REFERENCES clause
-- with a non-NULL default, so here `org_id` has no foreign key to orgs(id); the 0042 rebuild (Phase 7) that
-- removes the transitional DEFAULT adds it, together with the composite in-org foreign keys
-- (ticket_* → tickets(org_id, id), …). Until then the org is guaranteed by the default and, from Phase 3, by
-- the data layer. Every existing row becomes SaplingLearn's (the column default fills it).
--
-- The tables whose primary key or inline UNIQUE must include org_id are REBUILT in 0039.

ALTER TABLE feed ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE adrs ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE needs_triage ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE sprints ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE sprint_resources ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE sprint_progress ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE tickets ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE ticket_assignees ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE ticket_links ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE ticket_comments ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE ticket_events ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE handoffs ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE mcp_tokens ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE oauth_grants ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE oauth_codes ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE artifact_versions ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE artifact_links ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE artifact_upload_tokens ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE doc_image_upload_tokens ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE notification_outbox ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE notification_outbox_bodies ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';

-- ── in-org uniqueness on surrogate ids (the targets of 0042's composite foreign keys) ──
CREATE UNIQUE INDEX IF NOT EXISTS idx_sprints_org_id ON sprints(org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_org_id ON tickets(org_id, id);

-- A GitHub issue is mirrored once PER ORG (audit §2): the partial UNIQUE on source_ref gains org_id.
DROP INDEX IF EXISTS idx_tickets_source_ref;
CREATE UNIQUE INDEX idx_tickets_source_ref ON tickets(org_id, source_ref) WHERE source_ref IS NOT NULL;

-- ── per-org display numbers (Q2) ─────────────────────────────────────────────
-- `#12` becomes a per-org number; the global `id` stays the internal key. Existing rows keep number = id, so
-- every SaplingLearn reference (`#12` in a doc, a commit, a chat) still names the same ticket / handoff.
ALTER TABLE tickets ADD COLUMN number INTEGER;
ALTER TABLE handoffs ADD COLUMN number INTEGER;
UPDATE tickets SET number = id WHERE number IS NULL;
UPDATE handoffs SET number = id WHERE number IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_org_number ON tickets(org_id, number) WHERE number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoffs_org_number ON handoffs(org_id, number) WHERE number IS NOT NULL;

-- The counters start where AUTOINCREMENT is (sqlite_sequence remembers deleted ids too), so the next
-- SaplingLearn number is the next id — no number is ever reissued.
INSERT OR IGNORE INTO org_counters (org_id, name, value)
  SELECT 'org_saplinglearn', 'ticket', MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'tickets'), 0), COALESCE((SELECT MAX(id) FROM tickets), 0));
INSERT OR IGNORE INTO org_counters (org_id, name, value)
  SELECT 'org_saplinglearn', 'handoff', MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'handoffs'), 0), COALESCE((SELECT MAX(id) FROM handoffs), 0));

-- Allocation is the database's job, in the same statement as the insert: a row inserted without a number
-- takes its org's next one. (UPDATE OF number fires no FTS trigger — those watch title/body only.)
CREATE TRIGGER IF NOT EXISTS tickets_number_ai AFTER INSERT ON tickets WHEN new.number IS NULL BEGIN
  INSERT OR IGNORE INTO org_counters (org_id, name, value) VALUES (new.org_id, 'ticket', 0);
  UPDATE org_counters SET value = value + 1 WHERE org_id = new.org_id AND name = 'ticket';
  UPDATE tickets SET number = (SELECT value FROM org_counters WHERE org_id = new.org_id AND name = 'ticket') WHERE id = new.id;
END;
CREATE TRIGGER IF NOT EXISTS handoffs_number_ai AFTER INSERT ON handoffs WHEN new.number IS NULL BEGIN
  INSERT OR IGNORE INTO org_counters (org_id, name, value) VALUES (new.org_id, 'handoff', 0);
  UPDATE org_counters SET value = value + 1 WHERE org_id = new.org_id AND name = 'handoff';
  UPDATE handoffs SET number = (SELECT value FROM org_counters WHERE org_id = new.org_id AND name = 'handoff') WHERE id = new.id;
END;
