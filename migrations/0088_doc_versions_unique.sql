-- 0088_doc_versions_unique: a doc's version numbers are unique, and a promote leaves nothing stale waiting
-- (docs/architecture/ingestion-gate.md › Staged-write model).
--   · idx_doc_versions_version — UNIQUE (org_id, slug, version). The gate now takes a new version's number inside its
--     INSERT (src/tools/writes.ts `propose_doc_update`), and the index holds it in the schema: two proposals of one
--     page can never both be "v3". ASSUMES NO DUPLICATES EXIST — check before applying:
--       SELECT org_id, slug, version, COUNT(*) FROM doc_versions GROUP BY org_id, slug, version HAVING COUNT(*) > 1;
--   · `superseded`, a new value of doc_versions.status (the column has no CHECK; the values live in src/tools/writes.ts
--     `DOC_VERSION_STATUSES`): a promote marks the page's OLDER versions still `staged` superseded, in its own batch.
--     The ones a promote left behind before this are marked here — a staged version not newer than its page's live
--     one. Review, its badge and an import's Approve all already left them out (they read `staged` newer than
--     `current_version`); this stops them waiting forever, and the readers that count every `staged` row with them.
-- Rollback by hand:
--   DROP INDEX IF EXISTS idx_doc_versions_version;
--   UPDATE doc_versions SET status = 'staged' WHERE status = 'superseded';
-- then DELETE FROM d1_migrations WHERE name = '0088_doc_versions_unique.sql'.
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_versions_version ON doc_versions(org_id, slug, version);

UPDATE doc_versions SET status = 'superseded'
 WHERE status = 'staged'
   AND version <= (SELECT d.current_version FROM docs d WHERE d.org_id = doc_versions.org_id AND d.slug = doc_versions.slug);
