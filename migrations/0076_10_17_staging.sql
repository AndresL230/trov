-- 0076_10_17_staging: the 10-17 staging epic (PR #195) — Ask sharing (#193) and handoff prompts by upload (#194) —
-- in ONE migration. It consolidates what were three files (0076_ask_sharing, 0077_ask_people_sharing,
-- 0080_handoff_upload_tokens) before any of them reached production: each part below starts with a
-- `-- ══ part <old name> ══` marker and keeps that file's own header — what it adds, why, and its by-hand rollback
-- (roll back the parts in REVERSE order; each part's `d1_migrations` line names its old file, and the one row to
-- delete once every part is rolled back is `0076_10_17_staging.sql`). Every part is ADDITIVE (one new column and
-- index on `chat_threads`, the tables `chat_thread_people` and `handoff_upload_tokens`, and nullable `asked_by` on
-- `chat_messages` / `chat_actions`), so a Worker from before it keeps working. Applied in one go by
-- `wrangler d1 migrations apply`.
-- Parts: 0076_ask_sharing, 0077_ask_people_sharing, 0080_handoff_upload_tokens.

-- ══ part 0076_ask_sharing ══════════════════════════════════════════════════════════════════════
-- 0076_ask_sharing — an Ask Trov conversation can be SHARED with its organization, read-only.
--
-- Until now a thread was private to its owner (`chat_threads.handle`; 0066_ask). The owner may now share it with the
-- org they asked it in (`PATCH /ask/threads/:id { shared }`, a cookie route — never MCP) and stop sharing it again.
-- While it is shared, any LIVE member of the SAME org can open it read-only (`GET /ask/threads/:id`, listed by
-- `GET /ask/shared`); only the owner can continue, rename, pin, export or delete it, and deleting it deletes it for
-- everyone. The owner's PRIVATE attachments stay private: a viewer sees a file's name, never its contents
-- (docs/architecture/ask.md › Sharing a conversation).
--
-- chat_threads.shared_at  when the owner shared it; NULL = private (every existing thread). Stop sharing sets it back
--                         to NULL. A pending holder (`pending = 1`) is never shared: every route leaves it out.
--
-- ADDITIVE ONLY: one nullable column and one index; no row is rewritten, and a Worker from before it keeps working
-- (it never reads the column, and every thread stays its owner's alone). No new table and no new handle column:
-- `chat_threads` is already in ORG_TABLES (an org's deletion) and its `handle` in HANDLE_COLUMNS, and an account's
-- deletion already removes the person's threads, shared or not (src/deletion/person.ts).
--
-- ROLLBACK (by hand, after `wrangler rollback` to the Worker from before it): every shared thread becomes private
-- again, nothing else is lost:
--   DROP INDEX IF EXISTS idx_chat_threads_shared;
--   ALTER TABLE chat_threads DROP COLUMN shared_at;
--   DELETE FROM d1_migrations WHERE name = '0076_ask_sharing.sql';
ALTER TABLE chat_threads ADD COLUMN shared_at TEXT;
CREATE INDEX IF NOT EXISTS idx_chat_threads_shared ON chat_threads (org_id, shared_at) WHERE shared_at IS NOT NULL;

-- ══ part 0077_ask_people_sharing ═══════════════════════════════════════════════════════════════
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

-- ══ part 0080_handoff_upload_tokens ════════════════════════════════════════════════════════════
-- 0080_handoff_upload_tokens — a handoff whose prompt is UPLOADED instead of typed into the tool call.
--
-- ADDITIVE: one new table and one index; nothing existing is touched. MCP `send_handoff` with the upload form
-- (`prompt: { title, sha256, size_bytes }`) writes NO handoff: it stores the whole pending handoff here — the
-- sender (the bearer principal), the recipient, body, context, the prompt's title and the declared sha256 +
-- size of its text, the session ledger key — and returns a single-use PUT link. `PUT /api/artifacts/upload/
-- <token>` (the route artifacts and doc images already use; src/artifacts/upload.ts) checks the bytes against
-- the declared size and sha256 and only then creates the handoff (src/tools/handoffs.ts
-- `consumeHandoffUploadToken`), so a half-made handoff is never in anyone's inbox. Only the token's SHA-256 is
-- stored, as for `artifact_upload_tokens`; the TTL is the artifact uploads' (5 minutes).
--
-- Org-keyed (ORG_TABLES), `principal` is a handle (HANDLE_COLUMNS). Rows go once their window has closed, used
-- or not: the repo cron's every-tick sweep (`pruneHandoffUploadTokens`, src/platform/sweeps.ts).
--
-- Rollback: DROP TABLE IF EXISTS handoff_upload_tokens;

CREATE TABLE IF NOT EXISTS handoff_upload_tokens (
  token_hash   TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  principal    TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  body         TEXT NOT NULL,
  context      TEXT NOT NULL,
  prompt_title TEXT NOT NULL,
  sha256       TEXT NOT NULL CHECK (length(sha256) = 64),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes >= 1 AND size_bytes <= 32768),
  session_id   TEXT,
  link_base    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handoff_upload_tokens_expires ON handoff_upload_tokens(expires_at);
