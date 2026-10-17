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

-- The three spaces every org starts with — the same rows as shared/docs-core.ts STARTER_SPACES (a test
-- compares them). One statement per space: D1 allows at most five terms in a compound SELECT.
INSERT OR IGNORE INTO doc_spaces (org_id, slug, name, icon, color, description, sort_rank, created_at, created_by)
  SELECT id, 'engineering', 'Engineering', 'braces', '#525cc3', '', 1024, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system' FROM orgs ORDER BY id;
INSERT OR IGNORE INTO doc_spaces (org_id, slug, name, icon, color, description, sort_rank, created_at, created_by)
  SELECT id, 'product', 'Product', 'compass', '#2f7d57', '', 2048, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system' FROM orgs ORDER BY id;
INSERT OR IGNORE INTO doc_spaces (org_id, slug, name, icon, color, description, sort_rank, created_at, created_by)
  SELECT id, 'design', 'Design', 'pen', '#a84a68', '', 3072, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system' FROM orgs ORDER BY id;

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
