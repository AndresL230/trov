-- An organization's image (docs/architecture/organizations.md › The organization's image). Until now an
-- org had none: everywhere it is shown the SPA drew a square with the first letter of its name. The image
-- is the person photo's sibling (0036): bytes in R2, content-addressed (`org-logos/<sha256>`), served by
-- the session-gated `GET /org-logo/<sha>`; these columns say WHICH image an org shows and where it came from.
--
-- ADDITIVE only: five nullable columns on `orgs`, nothing existing changes, no backfill. Every existing
-- org reads NULL in all five ("no image": the initial tile) until an admin uploads one or the periodic
-- GitHub reconcile imports its primary repository owner's avatar.
--   logo_sha     SHA-256 of the image shown now; NULL = none
--   logo_source  'upload' (an admin's) | 'github' (imported). THE rule (src/orgs/logo.ts): an import
--                writes only while this is NULL or 'github' — an uploaded image is never replaced by it
--   logo_by      the person who uploaded it (a handle: `HANDLE_COLUMNS`); NULL for an import
--   logo_from    the GitHub login the image was imported from (the primary repo's owner); NULL for an upload
--   logo_at      when it was uploaded / last imported
ALTER TABLE orgs ADD COLUMN logo_sha TEXT CHECK (logo_sha IS NULL OR length(logo_sha) = 64);
ALTER TABLE orgs ADD COLUMN logo_source TEXT CHECK (logo_source IS NULL OR logo_source IN ('upload', 'github'));
ALTER TABLE orgs ADD COLUMN logo_by TEXT;
ALTER TABLE orgs ADD COLUMN logo_from TEXT;
ALTER TABLE orgs ADD COLUMN logo_at TEXT;
