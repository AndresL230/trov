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
