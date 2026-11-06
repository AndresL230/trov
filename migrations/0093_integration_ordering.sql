-- 0093_integration_ordering: three nullable columns so out-of-order signals and dead runs can be told apart
-- (docs/architecture/notifications.md › Runs, github-app.md › Uninstall, suspend, disconnect). Additive only:
-- nothing is backfilled, and a Worker that does not know them yet keeps working (NULL reads as "not known").
--   · notification_outbox.attempted_at — when the latest send attempt of a row began. A `pending` row whose
--     attempt (or, with none, its claim: created_at) is older than the retry job's lease is a run that died
--     mid-send; the retry job takes it (src/notifications/retry.ts).
--   · org_github_installations.suspension_at — when the suspend / unsuspend the row reflects HAPPENED (GitHub's
--     time for a webhook's, Trov's for a state it read from GitHub). An older delivery changes nothing
--     (src/github-app/store.ts `setInstallationSuspended`).
--   · org_github_installations.repos_changed_at — an `installation_repositories` event was applied and no
--     complete repository list has confirmed it since; the cron's reconcile unit re-reads the list
--     (src/github-app/repos.ts `recheckInstallation`).
-- Rollback by hand:
--   ALTER TABLE notification_outbox DROP COLUMN attempted_at;
--   ALTER TABLE org_github_installations DROP COLUMN suspension_at;
--   ALTER TABLE org_github_installations DROP COLUMN repos_changed_at;
-- then DELETE FROM d1_migrations WHERE name = '0093_integration_ordering.sql'.
ALTER TABLE notification_outbox ADD COLUMN attempted_at TEXT;
ALTER TABLE org_github_installations ADD COLUMN suspension_at TEXT;
ALTER TABLE org_github_installations ADD COLUMN repos_changed_at TEXT;
