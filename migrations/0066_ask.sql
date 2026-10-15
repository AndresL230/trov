-- 0066_ask: Ask Trov — a person's chat threads with Trov, the writes it proposed, its attachments, the person's
-- own Ask settings, and the "Flagged in Ask" lines Review shows (docs/architecture/ask.md;
-- docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase F as amended by Trov handoff #12 §2).
-- ADDITIVE ONLY: seven new TENANT tables (one an FTS index) with the triggers that keep the index, and one
-- nullable column on `ai_feedback`; nothing existing changes, no row is rewritten, and a Worker from before it
-- keeps working (it names none of them). `orgs.ai_chat_auto` (the org's Auto switch) is NOT here: 0058_ai_dirty.
--
-- Everything but `ask_flags` is PRIVATE TO ONE PERSON: a thread is its owner's (`chat_threads.handle`), and every
-- other row hangs off a thread. Every statement names `org_id` (src/data/ask.ts) AND the owner, so another org's —
-- or another person's — thread, message, action or attachment is the one `not_found`. In `ORG_TABLES` and the
-- reset seed; the two handle columns are in `HANDLE_COLUMNS`; deleting an ACCOUNT deletes the person's threads,
-- messages, actions, attachment links and settings (src/deletion/person.ts).
--
-- chat_threads — one conversation.
--   handle        the owner (HANDLE_COLUMNS); only they ever read or write it
--   title         written from the first exchange (by the same model call), or the person's rename; '' until then
--   mode          fast | smart | thinking — the thread's mode (a new thread starts in the person's default, Smart
--                 unless Settings › Trov changed it); every answer records its own mode too
--   origin        page (the Ask screen) | panel (the ⌘J panel)
--   context_ref   the item a ⌘J thread was opened on (`ticket:14`), else NULL
--   pinned        1 = pinned to the top of the list
--   auto_mode     1 = "Auto": a write runs at once (still a chat_actions row, with Undo) — only while the org's
--                 `ai_chat_auto` is on, never update_plan or a Publish, at most 5 per answer
--   draft         the unsent composer text
--   summary       the compacted older part of the thread (written once by Fast, sent as a cached prefix); '' = none
--   summary_through  the last message id the summary covers; 0 = none
--   turn          the current turn number (a proposed card expires when the next turn starts)
--   stop_requested 1 = the person pressed Stop: the running turn ends at its next step
--
-- chat_messages — one question or one answer.
--   role          user | assistant
--   mode          the mode it was asked / answered in
--   content_json  { text, command?, context?, blocks?, activity?, followups?, thinking?, refs?, attached? }
--   cites_json    the RefViews the answer's tokens link: ONLY items a tool returned in this thread (or attached)
--   attachments_json  a question's attachments: [{ id, slug, title, kind, … }]
--   model, tokens_in, tokens_out, tokens_cached  the provider's own counts (an answer); 0 on a question
--   units         the questions the answer counted as in `ai_chat` (1 / 1 / 5); 0 on a question
--   stopped       1 = the answer was stopped (or ran out of time) part-way: what it said is partial
--   replaced_at   set when edit-and-resend or regenerate replaced it: hidden, out of search, its cards expired
--
-- chat_fts — full-text over the text of a person's own messages that are not replaced (search joins it to the
--   owner's threads, so a rename never touches the index).
--
-- chat_actions — one write card. Nothing on this table runs by itself:
--   state         proposed | waiting (past the Auto cap, or Confirm-only) → confirmed | cancelled | failed |
--                 expired (with the next turn, or its answer replaced); auto (ran in Auto mode);
--                 confirmed | auto → undone; `running` while a write is in flight (the one claim)
--   kind          ticket | handoff | doc_edit | move | publish | sprint | other — the card's shape
--   group_id      consecutive calls to the same tool in one answer share it: one card, one Undo
--   tool, args_json  the write tool and its validated arguments (editable fields re-validated on Confirm)
--   preview_json  what the card shows — built by the SERVER from Trov's rows, never model text
--   result_json   what the write returned (or why it failed)
--   undo_json     the previous values Undo writes back, and the item's state right after the write (Undo refuses
--                 when someone changed it since); NULL = no reverse exists
--
-- chat_artifacts — an artifact a thread carried or made: an attachment (stored as a PRIVATE artifact on attach,
--   BEFORE the model sees it) or a saved answer. The bytes live in the artifacts store (R2 / D1).
--   role          attachment | saved;  message_id  the message it was sent with / saved from (NULL until sent)
--
-- person_ask_settings — Settings › Trov: "How Trov should answer you" (≤ 500 characters, appended to the system
--   prompt AFTER the rules) and the default mode (Pro; NULL = Smart).
--
-- ask_flags — "Wrong?" with "A source is wrong" or "It is out of date" on an answer flags each item it cited:
--   Review shows "Flagged in Ask" with the REASON only. No handle, no thread, no message, no text: threads stay
--   private. (The person's own "Wrong?" row, with its detail, is `ai_feedback`.)
-- ai_feedback.detail_json — "Wrong?" on an answer: { reason, mode, messageId, cites } (NULL on every other item).
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). It LOSES every thread, message, card,
-- Ask setting and flag (the attachments and saved answers stay in the artifacts library):
--   DROP TRIGGER IF EXISTS chat_fts_ai; DROP TRIGGER IF EXISTS chat_fts_au; DROP TRIGGER IF EXISTS chat_fts_ad;
--   DROP TRIGGER IF EXISTS chat_fts_replaced;
--   DROP TABLE IF EXISTS chat_fts; DROP TABLE IF EXISTS chat_artifacts; DROP TABLE IF EXISTS chat_actions;
--   DROP TABLE IF EXISTS chat_messages; DROP TABLE IF EXISTS chat_threads; DROP TABLE IF EXISTS person_ask_settings;
--   DROP TABLE IF EXISTS ask_flags; ALTER TABLE ai_feedback DROP COLUMN detail_json;
--   DELETE FROM d1_migrations WHERE name = '0066_ask.sql';
CREATE TABLE IF NOT EXISTS chat_threads (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  handle           TEXT NOT NULL COLLATE NOCASE,
  title            TEXT NOT NULL DEFAULT '',
  mode             TEXT NOT NULL DEFAULT 'smart' CHECK (mode IN ('fast', 'smart', 'thinking')),
  origin           TEXT NOT NULL DEFAULT 'page' CHECK (origin IN ('page', 'panel')),
  context_ref      TEXT,
  pinned           INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  auto_mode        INTEGER NOT NULL DEFAULT 0 CHECK (auto_mode IN (0, 1)),
  draft            TEXT NOT NULL DEFAULT '',
  summary          TEXT NOT NULL DEFAULT '',
  summary_through  INTEGER NOT NULL DEFAULT 0,
  turn             INTEGER NOT NULL DEFAULT 0,
  stop_requested   INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0, 1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_owner ON chat_threads (org_id, handle, pinned, updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id            TEXT NOT NULL REFERENCES orgs(id),
  thread_id         INTEGER NOT NULL REFERENCES chat_threads(id),
  role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  mode              TEXT NOT NULL CHECK (mode IN ('fast', 'smart', 'thinking')),
  content_json      TEXT NOT NULL DEFAULT '{}',
  cites_json        TEXT NOT NULL DEFAULT '[]',
  attachments_json  TEXT NOT NULL DEFAULT '[]',
  model             TEXT,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  tokens_cached     INTEGER NOT NULL DEFAULT 0,
  units             INTEGER NOT NULL DEFAULT 0,
  stopped           INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1)),
  replaced_at       TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (org_id, thread_id, id);

-- Standalone FTS5 (like tickets_fts), one row per live message, kept by the triggers below.
CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
  message_id UNINDEXED, thread_id UNINDEXED, text, org_id UNINDEXED, tokenize = 'porter unicode61');
CREATE TRIGGER IF NOT EXISTS chat_fts_ai AFTER INSERT ON chat_messages WHEN new.replaced_at IS NULL BEGIN
  INSERT INTO chat_fts (message_id, thread_id, text, org_id)
    VALUES (CAST(new.id AS TEXT), CAST(new.thread_id AS TEXT), COALESCE(json_extract(new.content_json, '$.text'), ''), new.org_id);
END;
CREATE TRIGGER IF NOT EXISTS chat_fts_au AFTER UPDATE OF content_json ON chat_messages WHEN new.replaced_at IS NULL BEGIN
  DELETE FROM chat_fts WHERE message_id = CAST(new.id AS TEXT) AND org_id = new.org_id;
  INSERT INTO chat_fts (message_id, thread_id, text, org_id)
    VALUES (CAST(new.id AS TEXT), CAST(new.thread_id AS TEXT), COALESCE(json_extract(new.content_json, '$.text'), ''), new.org_id);
END;
-- A replaced message leaves search.
CREATE TRIGGER IF NOT EXISTS chat_fts_replaced AFTER UPDATE OF replaced_at ON chat_messages WHEN new.replaced_at IS NOT NULL BEGIN
  DELETE FROM chat_fts WHERE message_id = CAST(new.id AS TEXT) AND org_id = new.org_id;
END;
CREATE TRIGGER IF NOT EXISTS chat_fts_ad AFTER DELETE ON chat_messages BEGIN
  DELETE FROM chat_fts WHERE message_id = CAST(old.id AS TEXT) AND org_id = old.org_id;
END;

CREATE TABLE IF NOT EXISTS chat_actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  thread_id     INTEGER NOT NULL REFERENCES chat_threads(id),
  message_id    INTEGER,
  turn          INTEGER NOT NULL,
  tool          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('ticket', 'handoff', 'doc_edit', 'move', 'publish', 'sprint', 'other')),
  group_id      TEXT,
  tool_use_id   TEXT NOT NULL DEFAULT '',
  args_json     TEXT NOT NULL DEFAULT '{}',
  preview_json  TEXT NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL CHECK (state IN ('proposed', 'waiting', 'running', 'confirmed', 'auto', 'undone', 'cancelled', 'failed', 'expired')),
  result_json   TEXT,
  undo_json     TEXT,
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_actions_thread ON chat_actions (org_id, thread_id, state);

CREATE TABLE IF NOT EXISTS chat_artifacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  thread_id    INTEGER NOT NULL REFERENCES chat_threads(id),
  artifact_id  INTEGER NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('attachment', 'saved')),
  message_id   INTEGER,
  created_at   TEXT NOT NULL,
  UNIQUE (org_id, thread_id, artifact_id, role)
);

CREATE TABLE IF NOT EXISTS person_ask_settings (
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  handle        TEXT NOT NULL COLLATE NOCASE,
  instructions  TEXT NOT NULL DEFAULT '' CHECK (length(instructions) <= 500),
  default_mode  TEXT CHECK (default_mode IS NULL OR default_mode IN ('fast', 'smart', 'thinking')),
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, handle)
);

CREATE TABLE IF NOT EXISTS ask_flags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  item_ref    TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('source_wrong', 'out_of_date')),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ask_flags_item ON ask_flags (org_id, item_ref);

ALTER TABLE ai_feedback ADD COLUMN detail_json TEXT;
