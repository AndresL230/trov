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
