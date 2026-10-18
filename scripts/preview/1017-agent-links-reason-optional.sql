-- RUN BY HAND, ONCE, on a D1 that recorded 0076_10_17_staging before the reason became optional (trov-preview, and a
-- local .wrangler state): npx wrangler d1 execute <db> --file=scripts/preview/1017-agent-links-reason-optional.sql
-- A fresh D1 needs none of this: the migration itself has the new CHECK. Never run against production by hand.
-- The 10-17 staging epic: agent_links.reason optional (DEFAULT '', CHECK length <= 280) on a D1 that already ran
-- 0076_10_17_staging with the old CHECK (1..280). SQLite cannot alter a CHECK: rebuild, copy every row, same indexes
-- and trigger. agent_link_notes references agent_links(org_id, number), so its rows are set aside for the swap and
-- put back after (a deferred check does not recount children once the parent is renamed into place).
PRAGMA defer_foreign_keys = on;
CREATE TABLE agent_link_notes_swap AS SELECT * FROM agent_link_notes;
DELETE FROM agent_link_notes;
DROP TRIGGER IF EXISTS agent_links_number_ai;
CREATE TABLE agent_links_new (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id                   TEXT NOT NULL REFERENCES orgs(id),
  number                   INTEGER,
  state                    TEXT NOT NULL CHECK (state IN ('draft','requested','open','declined','cancelled','closed','expired')),
  repo                     TEXT,                    -- null for a link with no repository (a ticket, a person, the web)
  topic_kind               TEXT NOT NULL CHECK (topic_kind IN ('pr','branch','ticket','person')),
  topic_ref                TEXT NOT NULL,           -- the PR / ticket number, the branch name, the person's handle
  reason                   TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 280),   -- optional: '' when none given
  requester                TEXT NOT NULL COLLATE NOCASE,
  requester_kind           TEXT CHECK (requester_kind IN ('code','chat','ask')),   -- null until a session is bound
  requester_agent_session  TEXT,
  requester_branch         TEXT,                    -- null for chat and ask
  recipient                TEXT NOT NULL COLLATE NOCASE,
  recipient_kind           TEXT CHECK (recipient_kind IN ('code','chat','ask')),
  recipient_agent_session  TEXT,
  recipient_branch         TEXT,
  created_at               TEXT NOT NULL,
  sent_at                  TEXT,
  decided_at               TEXT,                    -- accepted or declined; a self-link's send
  closed_at                TEXT,
  closed_by                TEXT COLLATE NOCASE,
  close_reason             TEXT,
  expires_at               TEXT NOT NULL,
  requester_seen_at        TEXT,                    -- the side's agent last checked its inbox, joined or wrote
  recipient_seen_at        TEXT
);
INSERT INTO agent_links_new (id, org_id, number, state, repo, topic_kind, topic_ref, reason, requester, requester_kind, requester_agent_session, requester_branch, recipient, recipient_kind, recipient_agent_session, recipient_branch, created_at, sent_at, decided_at, closed_at, closed_by, close_reason, expires_at, requester_seen_at, recipient_seen_at) SELECT id, org_id, number, state, repo, topic_kind, topic_ref, reason, requester, requester_kind, requester_agent_session, requester_branch, recipient, recipient_kind, recipient_agent_session, recipient_branch, created_at, sent_at, decided_at, closed_at, closed_by, close_reason, expires_at, requester_seen_at, recipient_seen_at FROM agent_links;
DROP TABLE agent_links;
ALTER TABLE agent_links_new RENAME TO agent_links;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_links_org_number ON agent_links(org_id, number);
-- The inbox: an open link by the session bound to either side.
CREATE INDEX IF NOT EXISTS idx_agent_links_requester_session ON agent_links(org_id, requester_agent_session) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_agent_links_recipient_session ON agent_links(org_id, recipient_agent_session) WHERE state = 'open';
-- A person's links (the lists, the five-link cap), and the expiry sweep.
CREATE INDEX IF NOT EXISTS idx_agent_links_requester ON agent_links(org_id, requester, state);
CREATE INDEX IF NOT EXISTS idx_agent_links_recipient ON agent_links(org_id, recipient, state);
CREATE INDEX IF NOT EXISTS idx_agent_links_expiry ON agent_links(state, expires_at);

CREATE TRIGGER IF NOT EXISTS agent_links_number_ai AFTER INSERT ON agent_links WHEN new.number IS NULL BEGIN
  INSERT OR IGNORE INTO org_counters (org_id, name, value) VALUES (new.org_id, 'link', 0);
  UPDATE org_counters SET value = value + 1 WHERE org_id = new.org_id AND name = 'link';
  UPDATE agent_links SET number = (SELECT value FROM org_counters WHERE org_id = new.org_id AND name = 'link') WHERE id = new.id;
END;
INSERT INTO agent_link_notes SELECT * FROM agent_link_notes_swap;
DROP TABLE agent_link_notes_swap;
