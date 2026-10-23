-- 0085_phase7_cleanup: the multitenancy cut-over's last leftovers (docs/architecture/data-layer.md). Nothing reads
-- either of these any more, so apply this AFTER the Worker that stops reading them is live:
--   · invites — the pre-organization email-invite table (0023). 0042_organizations copied every row into
--     `org_invites`; what was left was org #1's sidecar (an invitee's name, the mail outcome of a pre-0042 row) and
--     the rule that a first sign-in consumed a live row as a SaplingLearn membership. Both are gone: a pending
--     invitee accepts their `org_invites` row on the org picker like everyone else.
--   · org_repos.legacy_hook — the flag the old `POST /webhook/github` routed by. That route is gone; every repo's
--     webhook is `/webhook/github/<org_repos.id>`.
-- Rollback by hand (the table comes back EMPTY — its rows are not kept):
--   CREATE TABLE invites (email TEXT PRIMARY KEY, name TEXT, invited_by TEXT NOT NULL, invited_at TEXT NOT NULL,
--     accepted_by TEXT, revoked_at TEXT, email_sent_at TEXT, email_id TEXT, email_error TEXT);
--   ALTER TABLE org_repos ADD COLUMN legacy_hook INTEGER NOT NULL DEFAULT 0 CHECK (legacy_hook IN (0,1));
-- then DELETE FROM d1_migrations WHERE name = '0085_phase7_cleanup.sql'.
DROP TABLE IF EXISTS invites;
ALTER TABLE org_repos DROP COLUMN legacy_hook;
