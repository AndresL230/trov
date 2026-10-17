-- 0077_ask_people_sharing — an Ask Trov conversation can be shared with SPECIFIC PEOPLE, each able to read it or
-- to continue it.
--
-- 0076_ask_sharing let the owner share a thread with the whole org, read-only. The owner may now also name people
-- in the same org (`PATCH /ask/threads/:id { people }`, a cookie route — never MCP), choosing for each what they
-- may do: `read`, or `continue` — ask follow-ups in it as themselves (their allowance, their instructions, their
-- rights for every card). Every turn belongs to whoever asked it: only they edit, regenerate, save, flag or decide
-- the cards of their own turns. Rename, pin, share, export and delete stay the owner's
-- (docs/architecture/ask.md › Sharing a conversation).
--
-- chat_thread_people     one row per person a thread is shared with by name. `handle` is in HANDLE_COLUMNS, the
--                        table in ORG_TABLES and the reset seed; it goes with its thread (`deleteThread`), with the
--                        owner's or the person's account (src/deletion/person.ts) and with the org.
-- chat_messages.asked_by who asked the turn — set on the question AND its answer. NULL on every row from before
--                        this: the thread's owner (only they could ask).
-- chat_actions.asked_by  who asked the turn that proposed the card: the only person who may decide or undo it.
--                        NULL = the thread's owner, as above.
-- Both `asked_by` columns are in HANDLE_COLUMNS: a rename follows them, and a deleted account's turns in someone
-- else's thread keep the conversation whole under its `deleted-…` tombstone.
--
-- ADDITIVE ONLY: one new table, two nullable columns, one index; no row is rewritten. A Worker from before it keeps
-- working: it never reads them, and every thread stays its owner's (and the org's, when shared).
--
-- ROLLBACK (by hand, after `wrangler rollback` to the Worker from before it): every share by name is lost, and the
-- turns other people asked read as the owner's:
--   DROP TABLE IF EXISTS chat_thread_people;
--   ALTER TABLE chat_messages DROP COLUMN asked_by;
--   ALTER TABLE chat_actions DROP COLUMN asked_by;
--   DELETE FROM d1_migrations WHERE name = '0077_ask_people_sharing.sql';
CREATE TABLE IF NOT EXISTS chat_thread_people (
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  thread_id  INTEGER NOT NULL REFERENCES chat_threads(id),
  handle     TEXT NOT NULL COLLATE NOCASE,
  access     TEXT NOT NULL CHECK (access IN ('read', 'continue')),
  shared_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, thread_id, handle)
);
CREATE INDEX IF NOT EXISTS idx_chat_thread_people_handle ON chat_thread_people (org_id, handle);
ALTER TABLE chat_messages ADD COLUMN asked_by TEXT;
ALTER TABLE chat_actions ADD COLUMN asked_by TEXT;
