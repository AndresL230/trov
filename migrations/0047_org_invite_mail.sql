-- The invitation e-mail's bookkeeping moves onto the invite itself (docs/architecture/organizations.md).
-- Until now `org_invites` had no column for the invitee's NAME or the mail's delivery outcome; both lived
-- in the legacy `invites` table, a sidecar read and written for org #1 only — so no other org's invite
-- was ever mailed. `POST /api/o/:slug/invites` now sends the invitation and records what happened here.
--
-- ADDITIVE only: four nullable columns, nothing existing changes, no backfill. A row from before this
-- migration reads NULL in all four ("never mailed from here"); org #1's older rows still show the
-- sidecar's values through the legacy `/invites` alias (src/orgs/legacy-invites.ts) until Phase 7.
--   name        the invitee's name as the inviter typed it (greeting only; never an identity)
--   mail_status 'sent' | 'failed' — the LAST attempt; NULL = no mail (a GitHub-login invite has no address)
--   mail_at     when that attempt was made
--   mail_error  the provider's refusal text when it failed (admin-visible)
ALTER TABLE org_invites ADD COLUMN name TEXT CHECK (name IS NULL OR length(name) <= 120);
ALTER TABLE org_invites ADD COLUMN mail_status TEXT CHECK (mail_status IS NULL OR mail_status IN ('sent', 'failed'));
ALTER TABLE org_invites ADD COLUMN mail_at TEXT;
ALTER TABLE org_invites ADD COLUMN mail_error TEXT;
