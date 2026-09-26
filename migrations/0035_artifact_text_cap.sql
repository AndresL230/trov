-- Artifacts: the text cap goes from 500 KB to 750 KB (2026-09-26, feat/feed-brief;
-- spec: docs/superpowers/specs/2026-09-26-feed-brief-design.md, Part 2).
-- (0034 is feed_brief, on the same branch — so this is 0035.)
--
-- `ARTIFACT_TEXT_CAP` (shared/artifacts-core.ts) is 750 * 1024 = 768000 UTF-8 bytes.
-- 0030 mirrored the old cap in a CHECK on artifact_versions
-- (`content IS NULL OR size_bytes <= 512000`), and SQLite cannot alter a CHECK, so
-- the table is REBUILT (create *_new, copy, drop, rename) — the 0033 pattern.
--
-- Nothing references artifact_versions (no FK, no view, no trigger; the one
-- artifacts_fts trigger lives on artifact_pages), so no FK deferral is needed. Every
-- row keeps its id, and the AUTOINCREMENT counter is carried over (a copy alone
-- would reset it to MAX(id)). Its only index is the inline UNIQUE, recreated with
-- the table. artifacts_fts is standalone and untouched.

CREATE TABLE artifact_versions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES artifact_pages(id),
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  summary TEXT NOT NULL DEFAULT '',
  content TEXT,
  r2_key TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 10485760),
  content_type TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  filename TEXT,
  created_by TEXT NOT NULL,                      -- a person handle
  created_at TEXT NOT NULL,
  CHECK ((content IS NULL) <> (r2_key IS NULL)),
  CHECK (content IS NULL OR size_bytes <= 768000),
  UNIQUE (page_id, version_no)
);
INSERT INTO artifact_versions_new (id, page_id, version_no, summary, content, r2_key, size_bytes, content_type,
                                   sha256, filename, created_by, created_at)
  SELECT id, page_id, version_no, summary, content, r2_key, size_bytes, content_type,
         sha256, filename, created_by, created_at
  FROM artifact_versions;
UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT seq FROM sqlite_sequence WHERE name = 'artifact_versions'))
  WHERE name = 'artifact_versions_new' AND EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'artifact_versions');
-- An emptied table has a counter but no copied row, so the new table has no counter yet: carry it too.
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'artifact_versions_new', seq FROM sqlite_sequence WHERE name = 'artifact_versions'
    AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'artifact_versions_new');
DROP TABLE artifact_versions;
ALTER TABLE artifact_versions_new RENAME TO artifact_versions;
