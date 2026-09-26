-- Ticket board (2026-09-26, feat/tickets-board-default): a TESTING status, and a
-- saved position for each card on the board.
--
-- `testing` sits between in_progress and done — an optional step, not a gate (the
-- transition table in shared/tickets-core.ts is the rule; this CHECK only admits
-- the value). `board_rank` is the card's position in its board column, written
-- only by a drag (`move_ticket`); NULL = no position, which sorts at the TOP of
-- the column, newest-updated first (`boardOrder`). Every existing row starts NULL,
-- so the board opens in exactly today's order.
--
-- SQLite cannot alter a CHECK constraint, so `tickets` and `ticket_events` are
-- REBUILT (create *_new, copy, drop, rename), under `defer_foreign_keys` — the
-- D1-documented pattern, since ticket_assignees / ticket_links / ticket_comments
-- / ticket_events and tickets.parent_id all reference tickets(id) and the drop
-- would otherwise trip them mid-migration. Every row keeps its id, so every
-- reference resolves to the renamed table, and each AUTOINCREMENT counter is
-- carried over (a copy alone would reset it to MAX(id) and reissue deleted ids).
--
-- tickets_fts is a standalone FTS5 table (0024), untouched by the rebuild; its
-- three triggers live ON `tickets` and go with the old table, so they are dropped
-- first (explicitly — no DROP may fire the delete trigger into the index) and
-- recreated on the new one, and the index is rebuilt from the rows for good measure.

PRAGMA defer_foreign_keys = true;

DROP TRIGGER IF EXISTS tickets_fts_ai;
DROP TRIGGER IF EXISTS tickets_fts_au;
DROP TRIGGER IF EXISTS tickets_fts_ad;

-- ── tickets ──────────────────────────────────────────────────────────────────
CREATE TABLE tickets_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('bug','request','question','access','other')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','in_progress','testing','done','declined')),
  requester TEXT NOT NULL REFERENCES persons(handle),
  parent_id INTEGER REFERENCES tickets(id),
  sprint_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'canopy' CHECK (source IN ('canopy','github')),
  source_ref TEXT,
  source_author TEXT,
  source_updated_at TEXT,
  board_rank REAL
);
INSERT INTO tickets_new (id, title, body, category, priority, status, requester, parent_id, sprint_id,
                         created_at, updated_at, source, source_ref, source_author, source_updated_at, board_rank)
  SELECT id, title, body, category, priority, status, requester, parent_id, sprint_id,
         created_at, updated_at, source, source_ref, source_author, source_updated_at, NULL
  FROM tickets;
-- Keep AUTOINCREMENT's promise: the new table's counter starts where the old one
-- stood, not at MAX(id), so a deleted ticket's number is never handed out again.
UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT seq FROM sqlite_sequence WHERE name = 'tickets'))
  WHERE name = 'tickets_new' AND EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'tickets');
DROP TABLE tickets;
ALTER TABLE tickets_new RENAME TO tickets;

CREATE INDEX idx_tickets_status_updated ON tickets(status, updated_at);
CREATE INDEX idx_tickets_sprint ON tickets(sprint_id);
CREATE INDEX idx_tickets_parent ON tickets(parent_id);
CREATE UNIQUE INDEX idx_tickets_source_ref ON tickets(source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX idx_tickets_status_rank ON tickets(status, board_rank);

-- ── ticket_events (its status CHECKs name the vocabulary too) ────────────────
CREATE TABLE ticket_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  actor TEXT NOT NULL,
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('submitted','in_progress','testing','done','declined')),
  to_status TEXT NOT NULL CHECK (to_status IN ('submitted','in_progress','testing','done','declined')),
  created_at TEXT NOT NULL
);
INSERT INTO ticket_events_new (id, ticket_id, actor, from_status, to_status, created_at)
  SELECT id, ticket_id, actor, from_status, to_status, created_at FROM ticket_events;
UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT seq FROM sqlite_sequence WHERE name = 'ticket_events'))
  WHERE name = 'ticket_events_new' AND EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'ticket_events');
DROP TABLE ticket_events;
ALTER TABLE ticket_events_new RENAME TO ticket_events;
CREATE INDEX idx_ticket_events_ticket ON ticket_events(ticket_id, created_at);

-- ── tickets_fts: triggers back on the new table, index rebuilt from the rows ─
CREATE TRIGGER tickets_fts_ai AFTER INSERT ON tickets BEGIN
  DELETE FROM tickets_fts WHERE ticket_id = CAST(new.id AS TEXT);
  INSERT INTO tickets_fts (ticket_id, title, body)
    VALUES (CAST(new.id AS TEXT), new.title, new.body);
END;

CREATE TRIGGER tickets_fts_au AFTER UPDATE OF title, body ON tickets BEGIN
  DELETE FROM tickets_fts WHERE ticket_id = CAST(new.id AS TEXT);
  INSERT INTO tickets_fts (ticket_id, title, body)
    VALUES (CAST(new.id AS TEXT), new.title, new.body);
END;

CREATE TRIGGER tickets_fts_ad AFTER DELETE ON tickets BEGIN
  DELETE FROM tickets_fts WHERE ticket_id = CAST(old.id AS TEXT);
END;

DELETE FROM tickets_fts;
INSERT INTO tickets_fts (ticket_id, title, body)
  SELECT CAST(id AS TEXT), title, body FROM tickets;

PRAGMA defer_foreign_keys = false;
