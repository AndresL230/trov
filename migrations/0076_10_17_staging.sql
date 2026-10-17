-- 0076_10_17_staging: the 10-17 staging epic (PR #195) — Ask sharing (#193), handoff prompts by upload (#194),
-- Ask Trov's GitHub lookups, agent links (#196) and the Docs Library (#197) — in ONE migration. It consolidates what
-- were nine files (0076_ask_sharing, 0077_ask_people_sharing, 0080_handoff_upload_tokens, 0076_ask_github,
-- 0078_agent_links, 0081_docs_library, 0082_doc_import_manifest, 0083_doc_archive, 0084_library_prefs) before any of
-- them reached production: each part below starts with a `-- ══ part <old name> ══` marker and keeps that file's own header — what
-- it adds, why, and its by-hand rollback (roll back the parts in REVERSE order, 0084_library_prefs first; each part's
-- `d1_migrations` line names its old file, and the one row to delete once every part is rolled back is
-- `0076_10_17_staging.sql`). Every part is ADDITIVE but one: one new column and index on `chat_threads`, the tables
-- `chat_thread_people` and `handoff_upload_tokens`, nullable `asked_by` on `chat_messages` / `chat_actions`,
-- `orgs.ai_chat_github` (default 0), the tables `agent_links` / `agent_link_notes`, the Library's tables `doc_spaces`,
-- `doc_space_owners`, `doc_links`, `doc_imports` and its columns on `docs` / `doc_versions`, three starter spaces per
-- org, `docs.space` remapped to a space slug and each person's `library_prefs`. The exception is 0078_agent_links, which REBUILDS `org_counters`
-- (every row copied, a guard fails the whole file unless the copy is exact) so its CHECK accepts 'link'. A Worker from
-- before it keeps working. Applied in one go, as one transaction, by `wrangler d1 migrations apply`.
-- Parts: 0076_ask_sharing, 0077_ask_people_sharing, 0080_handoff_upload_tokens, 0076_ask_github, 0078_agent_links,
-- 0081_docs_library, 0082_doc_import_manifest, 0083_doc_archive, 0084_library_prefs.

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

-- ══ part 0076_ask_github ══════════════════════════════════════════════════════════════════════
-- 0076_ask_github — orgs.ai_chat_github, the organization's switch for Ask Trov's GitHub lookups.
--
-- ADDITIVE: one new column, nothing else touched. Ask Trov can read an organization's CONNECTED repositories on
-- GitHub (files, pull requests and their changes, issues, commits, checks) to answer a question, and what it reads
-- goes to Anthropic (docs/architecture/ask.md › GitHub). An admin turns that on or off for the whole organization in
-- Org settings › AI (`PUT /api/o/:slug/ai/settings { chatGithub }`, a cookie route — never MCP), audited
-- `org.ai_chat_github`. It stacks: the AI switch (`ai_automation`) AND this AND each person's own GitHub access.
-- OFF for every org, existing and new: no organization starts sending source code to Anthropic until an admin
-- chooses it.
--
-- Rollback (by hand, with `wrangler rollback` to the Worker from before it; loses the admins' choices):
--   ALTER TABLE orgs DROP COLUMN ai_chat_github;
--   DELETE FROM d1_migrations WHERE name = '0076_ask_github.sql';

ALTER TABLE orgs ADD COLUMN ai_chat_github INTEGER NOT NULL DEFAULT 0 CHECK (ai_chat_github IN (0, 1));

-- ══ part 0078_agent_links ══════════════════════════════════════════════════════════════════════
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

-- ══ part 0081_docs_library ═════════════════════════════════════════════════════════════════════
-- 0081_docs_library — the Docs Library: an organization's own SPACES, a page TREE inside each, links between
-- pages, and Markdown IMPORT runs (docs/architecture/docs-library.md). ONE migration holds the schema for the
-- whole feature (spaces, the tree, links, imports) so the later parts never edit a migration.
--
-- ADDITIVE: four new tables, five new columns, four new indexes, one seed and one remap of an existing
-- column's values. No table is rebuilt, nothing is dropped. What each piece holds and who reads / writes it:
--
--   doc_spaces        one row per (org, slug): a space of the org's Library — name, icon (a key of
--                     shared/docs-core.ts SPACE_ICONS), color (one of SPACE_COLORS), a one-line description,
--                     its place in the sidebar (`sort_rank`, placed with shared/tickets-core.ts placeInColumn
--                     through docs-core `placeSpace`). Written ONLY by src/tools/spaces.ts: an admin creates,
--                     renames, re-icons, reorders, archives and restores (cookie routes, src/spaces/routes.ts);
--                     an admin or one of the space's owners edits the description. Archive is SOFT
--                     (`archived_at` / `archived_by`) and restorable. A slug is RESERVED FOREVER: a new space
--                     never takes a slug that exists, archived or not (`uniqueSpaceSlug` adds -2, -3 …). A name
--                     is unique per org, case-insensitive, among the spaces that are NOT archived
--                     (idx_doc_spaces_name, and the repository's trimmed check before it).
--   doc_space_owners  who owns a space (people who may edit its description and owners beside the admins).
--                     A creator is the new space's first owner. Same writer.
--   doc_links         one row per (org, from page, to page) for a `[[slug]]` in a page's LIVE body — rebuilt
--                     for a page on promote (the tree PR). A row whose target is no doc is a broken link.
--   doc_imports       one row per Markdown import run (the import PR), modelled on sync_runs (0046): a
--                     heartbeat (`updated_at`), a status, counts and failure CODES (never text).
--   docs.parent_slug  the page this page sits under (NULL = top level of its space); docs.tree_rank its place
--                     among its siblings. Written by the tree PR's move route and by a proposal's parent.
--   doc_versions.parent_slug   a proposal's requested parent (applied on promote for an existing doc).
--   doc_versions.import_id / import_path   the import run a staged version came from, and its path in the zip.
--
-- docs.space IS NOW A doc_spaces SLUG. Until now it held 'technical' or 'product' (0005, 0020; the column's
-- DEFAULT 'canopy' is never used — the app always writes the space). Every existing org gets three spaces,
-- `engineering`, `product` and `design` (a new org gets the same from src/orgs/repo.ts createOrg), and every doc
-- not in `product` moves to `engineering` — 'technical', the old 'canopy' default, any stray value. There is no
-- reference from docs.space to doc_spaces (no rebuild of docs): the gate checks the space (src/consumer.ts
-- `ingestDocProposal` — an unknown or archived space goes to needs_triage, never guessed), and an agent may
-- still send 'technical' (shared/docs-core.ts SPACE_ALIASES → 'engineering').
--
-- SAFE ON THE WORKER FROM BEFORE IT. That Worker never names the new tables or columns. It still writes a new
-- doc's space as 'technical'/'product' and lists only those two tabs, so in the seconds between this migration
-- and the new Worker's deploy a doc it creates may be written as 'technical'. The remap below is idempotent:
-- re-run `UPDATE docs SET space = 'engineering' WHERE space <> 'product' AND space NOT IN (SELECT slug FROM
-- doc_spaces WHERE doc_spaces.org_id = docs.org_id)` after the deploy to fold any such doc.
--
-- Rollback (by hand, with `wrangler rollback` to the Worker from before it):
--   UPDATE docs SET space = 'technical' WHERE space <> 'product';
--   DROP INDEX IF EXISTS idx_docs_tree; DROP INDEX IF EXISTS idx_doc_versions_import;
--   ALTER TABLE docs DROP COLUMN parent_slug; ALTER TABLE docs DROP COLUMN tree_rank;
--   ALTER TABLE doc_versions DROP COLUMN parent_slug; ALTER TABLE doc_versions DROP COLUMN import_id;
--   ALTER TABLE doc_versions DROP COLUMN import_path;
--   DROP TABLE IF EXISTS doc_imports; DROP TABLE IF EXISTS doc_links;
--   DROP TABLE IF EXISTS doc_space_owners; DROP TABLE IF EXISTS doc_spaces;
--   DELETE FROM org_admin_audit WHERE action LIKE 'space.%';
--   DELETE FROM d1_migrations WHERE name = '0081_docs_library.sql';
-- A doc moved into a space other than engineering/product folds to 'technical' by the first statement.

-- ── spaces ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doc_spaces (
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  slug        TEXT NOT NULL,                 -- lowercase letters, digits, hyphens; reserved forever
  name        TEXT NOT NULL,                 -- 1–40 characters (shared/docs-core.ts SPACE_NAME_MAX)
  icon        TEXT NOT NULL,                 -- a key of SPACE_ICONS
  color       TEXT NOT NULL,                 -- one of SPACE_COLORS ('#rrggbb')
  description TEXT NOT NULL DEFAULT '',      -- up to 140 characters (SPACE_DESCRIPTION_MAX)
  sort_rank   REAL,                          -- its place in the Library; NULL sorts last (by created_at)
  archived_at TEXT,                          -- archived (soft): hidden from the Library, restorable by an admin
  archived_by TEXT,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  PRIMARY KEY (org_id, slug)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_spaces_name ON doc_spaces(org_id, name COLLATE NOCASE) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS doc_space_owners (
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  space_slug TEXT NOT NULL,
  handle     TEXT NOT NULL,                  -- a person handle (HANDLE_COLUMNS)
  added_at   TEXT NOT NULL,
  added_by   TEXT NOT NULL,
  PRIMARY KEY (org_id, space_slug, handle)      -- no reference to doc_spaces: a space is never deleted (archive is soft)
);

-- The three spaces every org starts with, in A to Z order — the same rows as shared/docs-core.ts STARTER_SPACES (a test
-- compares them). One statement per space: D1 allows at most five terms in a compound SELECT.
INSERT OR IGNORE INTO doc_spaces (org_id, slug, name, icon, color, description, sort_rank, created_at, created_by)
  SELECT id, 'design', 'Design', 'pen', '#a84a68', '', 1024, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system' FROM orgs ORDER BY id;
INSERT OR IGNORE INTO doc_spaces (org_id, slug, name, icon, color, description, sort_rank, created_at, created_by)
  SELECT id, 'engineering', 'Engineering', 'braces', '#525cc3', '', 2048, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system' FROM orgs ORDER BY id;
INSERT OR IGNORE INTO doc_spaces (org_id, slug, name, icon, color, description, sort_rank, created_at, created_by)
  SELECT id, 'product', 'Product', 'compass', '#2f7d57', '', 3072, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system' FROM orgs ORDER BY id;

-- Every doc not in Product is an Engineering doc now ('technical', the old 'canopy' default, any stray value).
-- docs_fts's update trigger fires only on title / section / body, so this touches no search row.
UPDATE docs SET space = 'engineering' WHERE space <> 'product';

-- ── the page tree ────────────────────────────────────────────────────────────
ALTER TABLE docs ADD COLUMN parent_slug TEXT;   -- NULL = top level of its space
ALTER TABLE docs ADD COLUMN tree_rank REAL;     -- its place among its siblings; NULL sorts last
CREATE INDEX IF NOT EXISTS idx_docs_tree ON docs(org_id, space, parent_slug);

ALTER TABLE doc_versions ADD COLUMN parent_slug TEXT;   -- the parent a proposal asked for
ALTER TABLE doc_versions ADD COLUMN import_id INTEGER;  -- doc_imports.id of the run that staged it
ALTER TABLE doc_versions ADD COLUMN import_path TEXT;   -- the file's path inside the import
CREATE INDEX IF NOT EXISTS idx_doc_versions_import ON doc_versions(org_id, import_id);

-- ── links between pages ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doc_links (
  org_id    TEXT NOT NULL REFERENCES orgs(id),
  from_slug TEXT NOT NULL,
  to_slug   TEXT NOT NULL,
  PRIMARY KEY (org_id, from_slug, to_slug)
);
CREATE INDEX IF NOT EXISTS idx_doc_links_to ON doc_links(org_id, to_slug);

-- ── import runs ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doc_imports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  space_slug  TEXT NOT NULL,                  -- the space it imports into
  parent_slug TEXT,                           -- the page it imports under; NULL = the space's top level
  file_name   TEXT NOT NULL,                  -- what the person picked (a .zip or the first .md)
  started_by  TEXT NOT NULL,                  -- a handle (HANDLE_COLUMNS)
  started_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,                  -- the heartbeat: the last time the run reported
  ended_at    TEXT,
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'partial', 'failed', 'abandoned')),
  counts      TEXT NOT NULL DEFAULT '{}',     -- JSON: pages staged, skipped, images …
  failures    TEXT NOT NULL DEFAULT '[]',     -- JSON: failure CODES only, never text
  total       INTEGER                         -- files in the run; NULL until known
);
CREATE INDEX IF NOT EXISTS idx_doc_imports_org ON doc_imports(org_id, id);

-- ══ part 0082_doc_import_manifest ══════════════════════════════════════════════════════════════
-- 0082_doc_import_manifest — what a Markdown import run was ASKED to import, kept on its run row
-- (docs/architecture/docs-library.md › Import).
--
-- ADDITIVE: two new columns on doc_imports (0081_docs_library), each with a constant default; nothing rebuilt,
-- nothing removed. The browser unzips and sends the files in batches over several requests; the Worker
-- re-validates every one against what the run was started with, so the run must remember it:
--   doc_imports.manifest  JSON `{ files: [{ path, size, title }], choices: { <page key>: choice }, file_size }` —
--                         the file list (paths, sizes, each Markdown file's first heading) and the person's
--                         conflict choices, as `POST /imports` accepted them. The planner
--                         (shared/docs-import-core.ts `planImport` + `applyConflictChoices`) is re-run over it
--                         on every batch, so a page, its slug, its parent and its links come from the SERVER's
--                         plan, never from the request. Written once, by src/imports/runs.ts `startImport`.
--   doc_imports.images    JSON `[[path, sha256], …]` — the run's images as they were uploaded
--                         (`POST /imports/:id/images`, appended in one statement each), which a page's
--                         `![](path)` is rewritten to (`/img/<sha256>`). Written only by src/imports/runs.ts.
-- Readers: src/imports/runs.ts only. Neither column ever holds a file's text or an error message.
--
-- SAFE ON THE WORKER FROM BEFORE IT: that Worker never names doc_imports' new columns (nor, before 0081's import
-- part shipped, the table).
--
-- Rollback: ALTER TABLE doc_imports DROP COLUMN manifest; ALTER TABLE doc_imports DROP COLUMN images;
--   DELETE FROM d1_migrations WHERE name = '0082_doc_import_manifest.sql';

ALTER TABLE doc_imports ADD COLUMN manifest TEXT NOT NULL DEFAULT '{}';
ALTER TABLE doc_imports ADD COLUMN images TEXT NOT NULL DEFAULT '[]';

-- ══ part 0083_doc_archive ══════════════════════════════════════════════════════════════════════
-- 0083_doc_archive — Archive page: a Library page that a person archives leaves the Library, and can be restored
-- (docs/architecture/docs-library.md › Archiving a page).
--
-- ADDITIVE: two new nullable columns on docs; nothing rebuilt, nothing removed, no row written.
--   docs.archived_at  when a person archived the page (NULL = the page is in the Library). Set by
--                     src/tools/doc-archive.ts `archiveDoc`, cleared by `restoreDoc` — cookie routes only
--                     (`POST /doc/:slug/archive` / `restore`, src/routes.ts, under `cookieOnly`), for an org admin or
--                     an owner of the page's space. NEVER an MCP tool, and nothing the gate or an import writes:
--                     a proposal against an archived page goes to needs_triage (`archived page: <slug>`).
--   docs.archived_by  the handle who archived it (a handle column: src/auth/persons.ts HANDLE_COLUMNS).
-- Archive is SOFT (Invariant 11): the row, its body and every version stay; its slug stays reserved (a new page or
-- an import never takes it); `parent_slug` keeps the page's old place, which Restore puts it back under when that
-- parent is still in the Library. While archived, every read that lists or searches pages leaves it out (the tree,
-- Space home, the Library, list_docs / get_doc / query / search / quick search, Review, the badges), and its staged
-- versions are HIDDEN from Review (kept `staged`, not rejected) until it is restored.
--
-- SAFE ON THE WORKER FROM BEFORE IT: that Worker never names the columns, so it reads every page as it did (no
-- page is archived until the new Worker archives one).
--
-- Rollback (by hand, with `wrangler rollback` to the Worker from before it — an archived page then reads as in the
-- Library again, at its old place; its children stay where Archive moved them):
--   ALTER TABLE docs DROP COLUMN archived_at; ALTER TABLE docs DROP COLUMN archived_by;
--   DELETE FROM d1_migrations WHERE name = '0083_doc_archive.sql';

ALTER TABLE docs ADD COLUMN archived_at TEXT;
ALTER TABLE docs ADD COLUMN archived_by TEXT;

-- ══ part 0084_library_prefs ════════════════════════════════════════════════════════════════════
-- 0084_library_prefs — each person's own view of the Library, per organization: which spaces their sidebar shows
-- and in what order, and which space cards they pinned to the top of Library home or hid there
-- (docs/architecture/docs-library.md › Your own Library; shared/docs-core.ts `LibraryPrefsDTO`).
--
-- ADDITIVE: one new table, nothing else touched.
--   library_prefs  one row per (org, person), written only by that person (`PUT /spaces/prefs/me`, a cookie route —
--                  never MCP; src/tools/spaces.ts `saveLibraryPrefs`). `sidebar` is a JSON array of space slugs (at
--                  most 5), NULL = the default (the first five in the Library's order); `pinned` and `hidden` are
--                  JSON arrays of slugs. Slugs only — a space is never deleted and a slug is reserved forever, so a
--                  stale one (an archived space) is simply dropped on read. `handle` is in HANDLE_COLUMNS, the
--                  table in ORG_TABLES; an account's deletion removes the person's rows.
--
-- SAFE ON THE WORKER FROM BEFORE IT: it never names the table.
--
-- Rollback (by hand, with `wrangler rollback` to the Worker from before it; loses everyone's sidebar choices):
--   DROP TABLE IF EXISTS library_prefs;
--   DELETE FROM d1_migrations WHERE name = '0084_library_prefs.sql';

CREATE TABLE IF NOT EXISTS library_prefs (
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  handle     TEXT NOT NULL,                  -- the person whose view it is (HANDLE_COLUMNS)
  sidebar    TEXT,                           -- JSON array of space slugs, at most 5; NULL = the default
  pinned     TEXT NOT NULL DEFAULT '[]',     -- JSON array of space slugs, pinning order
  hidden     TEXT NOT NULL DEFAULT '[]',     -- JSON array of space slugs
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, handle)
);
