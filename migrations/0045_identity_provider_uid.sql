-- Phase 4 (canopy-multitenancy.md §5.1): sign-in is no longer gated on membership of one GitHub org, so
-- ANY GitHub account can now present a login. `identities.subject` for GitHub is the LOGIN, and a login can
-- be renamed away and re-registered by someone else — who would then sign in as the person the old row
-- names. This column pins a GitHub identity to the account's immutable numeric id.
--
-- ADDITIVE only: one nullable column, no data change, nothing rebuilt. It is NULL for every existing row
-- and is filled at that identity's next sign-in (src/auth/onboard.ts `completeSignIn`); from then on a
-- sign-in with the same login but a DIFFERENT id is refused. A pre-0045 Worker never reads it.
-- Google identities do not need it: their `subject` already is Google's immutable `sub`.
ALTER TABLE identities ADD COLUMN provider_uid TEXT;
