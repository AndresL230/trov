-- 0078_agent_links — agent links: a short-lived, one-to-one line between two sessions through Trov
-- (docs/superpowers/specs/2026-10-17-agent-links.md; src/tools/links.ts).
--
--   org_counters      REBUILT so its CHECK accepts 'link' beside 'ticket' and 'handoff' (SQLite cannot
--                     alter a CHECK), every row copied; a 'link' counter (0) for every existing org
--   agent_links       a link: its per-org number (from org_counters 'link', by the insert trigger, as tickets
--                     and handoffs are numbered), state, topic, reason, and its two sides — each a person, and
--                     the agent session bound to that side once one joins
--   agent_link_notes  the short notes the sides leave each other, each delivered to the OTHER side once
--
-- WHY org_counters IS REBUILT (create *_new, copy, drop, rename). A link's number must come from the same
-- never-decreasing counter as a ticket's (0042_organizations section 2) — not `MAX(number) + 1`, which would
-- reissue a number after a delete — and the old CHECK refuses the name. Nothing references org_counters; it
-- has no index but its primary key and no view. The only things that name it are the two numbering triggers
-- (tickets_number_ai, handoffs_number_ai): they are dropped before the swap, so the rename sees no trigger
-- naming a missing table, and recreated after it exactly as 0042 wrote them. A guard refuses the swap —
-- failing the whole migration, which D1 applies as one transaction — unless the copy holds exactly the rows
-- of the original, so ticket and handoff numbering continues where it was (test/links.migration.test.ts).
--
-- `*_agent_session` (never `*_session`): Trov already has its own "session" (`ai_sessions`, 0058). A side's
-- session is whatever id its agent sent (Claude Code's session id, a chat's chosen id) or, for an Ask Trov
-- thread, `ask-thread-<chat_threads.id>`, written only by Ask.
--
-- SAFE ON THE WORKER FROM BEFORE IT: it never names the new tables, and every org_counters statement it runs
-- (the triggers, createOrg's seed) works unchanged on the rebuilt table.
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it):
--   DROP TRIGGER IF EXISTS agent_links_number_ai;
--   DROP TABLE IF EXISTS agent_link_notes; DROP TABLE IF EXISTS agent_links;
--   DELETE FROM org_counters WHERE name = 'link';
--   (then the same rebuild as below with the CHECK back to ('ticket','handoff'))
--   DELETE FROM d1_migrations WHERE name = '0078_agent_links.sql';

-- ── org_counters, with 'link' ────────────────────────────────────────────────
DROP TRIGGER IF EXISTS tickets_number_ai;
DROP TRIGGER IF EXISTS handoffs_number_ai;

-- Per-org display numbers (Q2): the next ticket / handoff / link number. Only ever increases, so a deleted
-- ticket's number is never reissued. Advanced by the AFTER INSERT triggers below.
CREATE TABLE org_counters_new (
  org_id  TEXT NOT NULL REFERENCES orgs(id),
  name    TEXT NOT NULL CHECK (name IN ('ticket','handoff','link')),
  value   INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  PRIMARY KEY (org_id, name)
);
INSERT INTO org_counters_new (org_id, name, value) SELECT org_id, name, value FROM org_counters;

-- Guard: the copy holds every row with its value. A violation fails the INSERT's CHECK, and with it the
-- migration, before anything is dropped.
CREATE TABLE _org_counters_guard (violations INTEGER NOT NULL CHECK (violations = 0));
INSERT INTO _org_counters_guard (violations) SELECT
    ABS((SELECT COUNT(*) FROM org_counters) - (SELECT COUNT(*) FROM org_counters_new))
  + (SELECT COUNT(*) FROM org_counters o WHERE NOT EXISTS (
       SELECT 1 FROM org_counters_new n WHERE n.org_id = o.org_id AND n.name = o.name AND n.value = o.value));
DROP TABLE _org_counters_guard;

DROP TABLE org_counters;
ALTER TABLE org_counters_new RENAME TO org_counters;

-- Every existing org starts its links at #1 (src/orgs/repo.ts `createOrg` seeds the row for a new one).
INSERT OR IGNORE INTO org_counters (org_id, name, value) SELECT id, 'link', 0 FROM orgs;

-- The two numbering triggers, exactly as 0042_organizations section 2 wrote them.
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

-- ── agent_links ──────────────────────────────────────────────────────────────
-- States: draft (an agent's request_link, its requester side bound; a person sends it) → requested (sent)
-- → open (accepted; a self-link opens on send) → closed. Or declined / cancelled / expired (the cron).
-- `expires_at` is the current state's deadline: a draft's +1 h, a request's +24 h, an open link's +7 days.
-- `closed_at` is when the link ENDED, whichever way; `closed_by` / `close_reason` only for a close.
-- Person columns hold HANDLES (COLLATE NOCASE, like persons.handle) and are in HANDLE_COLUMNS.
CREATE TABLE IF NOT EXISTS agent_links (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id                   TEXT NOT NULL REFERENCES orgs(id),
  number                   INTEGER,
  state                    TEXT NOT NULL CHECK (state IN ('draft','requested','open','declined','cancelled','closed','expired')),
  repo                     TEXT,                    -- null for a link with no repository (a ticket, a person, the web)
  topic_kind               TEXT NOT NULL CHECK (topic_kind IN ('pr','branch','ticket','person')),
  topic_ref                TEXT NOT NULL,           -- the PR / ticket number, the branch name, the person's handle
  reason                   TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 280),
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

-- ── agent_link_notes ─────────────────────────────────────────────────────────
-- `side` is the side the note was written FROM: it goes to the other side's bound session. It is stored, not
-- derived from `author`, because a self-link's two sides are the same person. `author_agent_session` is null
-- exactly for a person's note (written on the link's page). `delivered_at` is stamped once, by the inbox read
-- that hands the note over.
CREATE TABLE IF NOT EXISTS agent_link_notes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  link_number           INTEGER NOT NULL,
  side                  TEXT NOT NULL CHECK (side IN ('requester','recipient')),
  author                TEXT NOT NULL COLLATE NOCASE,
  author_kind           TEXT NOT NULL CHECK (author_kind IN ('agent','ask','person')),
  author_agent_session  TEXT,
  body                  TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at            TEXT NOT NULL,
  delivered_at          TEXT,
  CHECK ((author_kind = 'person') = (author_agent_session IS NULL)),
  FOREIGN KEY (org_id, link_number) REFERENCES agent_links(org_id, number)
);
CREATE INDEX IF NOT EXISTS idx_agent_link_notes_link ON agent_link_notes(org_id, link_number, side, id);
CREATE INDEX IF NOT EXISTS idx_agent_link_notes_waiting ON agent_link_notes(org_id, link_number, side) WHERE delivered_at IS NULL;
