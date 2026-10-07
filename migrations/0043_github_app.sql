-- 0043_github_app — an org connects its repositories by INSTALLING Trov's GitHub App (issue #95;
-- docs/architecture/github-app.md). Additive only: one new table, two nullable-or-defaulted columns on
-- `org_repos`. Safe on live data and on a Worker that does not know them yet; nothing is backfilled.
--
-- ONE LIVE INSTALLATION PER ORG, AND ONE ORG PER INSTALLATION. An installation is the App on ONE GitHub
-- account (a user or an organization), so "one live installation per org" also means "one GitHub account
-- per org". That is the simplest rule that is correct today: an org's GitHub credential is ONE value
-- (`resolveGithubCredential`, src/github-app/credential.ts) and only its PRIMARY repository is captured,
-- so a second account's repositories could be listed but never read. Lifting it later is a matter of
-- dropping `idx_org_github_installations_org` and resolving the credential per repository owner.
-- A row is never deleted: `removed_at` ends it (disconnected in Trov, uninstalled on GitHub, or GitHub
-- answered "no such installation"), and both partial unique indexes ignore ended rows — so the same
-- installation can be connected again, by this org or another, after it was let go.
--
-- ROLLBACK (by hand; there is no generated down file for this one — scripts/mt/rollback/ holds the
-- organizations migration's alone, and that file must be run AFTER these statements, never before):
--   DROP INDEX IF EXISTS idx_org_github_installations_installation;
--   DROP INDEX IF EXISTS idx_org_github_installations_org;
--   DROP TABLE IF EXISTS org_github_installations;
--   ALTER TABLE org_repos DROP COLUMN connection;
--   ALTER TABLE org_repos DROP COLUMN access_lost_at;
--   DELETE FROM d1_migrations WHERE name = '0043_github_app.sql';
-- Nothing is lost with it but the bindings themselves: the App stays installed on GitHub, and every org
-- falls back to its stored GitHub token (SaplingLearn: to the Worker's).

CREATE TABLE IF NOT EXISTS org_github_installations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  installation_id       INTEGER NOT NULL,                  -- GitHub's id of the installation
  account_login         TEXT NOT NULL COLLATE NOCASE,      -- the user / organization the App is installed on
  account_id            TEXT NOT NULL,                     -- that account's immutable numeric id (outlives a rename)
  account_type          TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  repository_selection  TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  connected_by          TEXT NOT NULL,                     -- a handle (HANDLE_COLUMNS): the admin who connected it
  connected_at          TEXT NOT NULL,
  suspended_at          TEXT,                              -- suspended on GitHub: no token can be minted until it is lifted
  removed_at            TEXT,                              -- the binding ended; the row stays for the history
  removed_reason        TEXT CHECK (removed_reason IS NULL OR removed_reason IN ('disconnected', 'uninstalled', 'not_found')),
  last_used_at          TEXT,                              -- a token was minted and used (throttled, like a secret's)
  last_error            TEXT                               -- scrubbed, <= 300 characters; NULL after a success
);
-- An installation belongs to at most ONE org; an org has at most ONE live installation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_github_installations_installation ON org_github_installations(installation_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_github_installations_org ON org_github_installations(org_id) WHERE removed_at IS NULL;

-- How a repository is connected: `manual` (typed as owner/repo; read with the org's token, delivered by
-- its own webhook) or `app` (visible to the org's installation; needs neither). `access_lost_at` is set
-- when the installation stops seeing an `app` repository (removed from its selection on GitHub).
ALTER TABLE org_repos ADD COLUMN connection TEXT NOT NULL DEFAULT 'manual' CHECK (connection IN ('manual', 'app'));
ALTER TABLE org_repos ADD COLUMN access_lost_at TEXT;
