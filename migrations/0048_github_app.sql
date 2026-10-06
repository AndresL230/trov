-- The GitHub App (issue #95; docs/superpowers/specs/2026-10-06-github-app-design.md): an organization connects
-- its repositories by INSTALLING Trov's GitHub App instead of pasting a token and adding a webhook by hand.
-- Trov mints a short-lived installation token per job and receives every installed repository's events on
-- ONE App webhook (`POST /webhook/github-app`).
--
-- ADDITIVE only: two new tables and one nullable column; nothing existing changes meaning, nothing is
-- backfilled. An older Worker never reads either table and ignores the column, so the pasted-token /
-- per-repo-webhook path (0037) keeps working beside the App until an org's installation is live.

-- ── installations ────────────────────────────────────────────────────────────
-- One row per GitHub App installation BOUND to a Trov org. `installation_id` is GitHub's own id and the
-- PRIMARY KEY, so an installation belongs to exactly ONE org — binding it to a second org is refused, never
-- silently moved. A row exists only after an ADMIN of the org completed the install flow and GitHub confirmed,
-- with that person's own user token, that their account can read every repository the installation covers
-- (src/github-app/install.ts). An installation GitHub delivered events for but nobody bound has NO row, and
-- its deliveries are ignored.
--   account_*            the GitHub account the App is installed on (a user or an organization)
--   repository_selection 'all' | 'selected' — as GitHub reports it
--   suspended_at         set by the `installation.suspend` event (GitHub refuses tokens meanwhile); cleared by `unsuspend`
--   last_delivery_at     the last VERIFIED App delivery for this installation (throttled to one write per 10 minutes)
--   repos_synced_at      when `github_installation_repos` was last listed in full (bind / Refresh)
CREATE TABLE IF NOT EXISTS github_installations (
  installation_id      INTEGER PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES orgs(id),
  account_login        TEXT NOT NULL,
  account_id           INTEGER NOT NULL,
  account_type         TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  suspended_at         TEXT,
  connected_by         TEXT NOT NULL,                 -- a handle (HANDLE_COLUMNS)
  connected_at         TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  last_delivery_at     TEXT,
  repos_synced_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_github_installations_org ON github_installations(org_id);

-- ── the repositories an installation can see ────────────────────────────────
-- What Org settings › Repositories lists to connect from — read from D1, never from GitHub on render. Kept by
-- the bind, an admin's Refresh (a full re-list) and the `installation_repositories` added / removed events.
-- Holds names and ids only, never a credential. `org_id` is the installation's org, repeated so every
-- statement can bind it (test/data-layer.static.test.ts).
CREATE TABLE IF NOT EXISTS github_installation_repos (
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  installation_id INTEGER NOT NULL REFERENCES github_installations(installation_id) ON DELETE CASCADE,
  repo_id         INTEGER NOT NULL,                   -- GitHub's repository id
  repo_full_name  TEXT NOT NULL COLLATE NOCASE,       -- 'owner/repo'
  private         INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1)),
  PRIMARY KEY (installation_id, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_github_installation_repos_org ON github_installation_repos(org_id, repo_full_name);

-- ── a connected repository's installation ────────────────────────────────────
-- NULL = the repo is connected the 0037 way (a `github_token` secret + its own `/webhook/github/:hookId`).
-- Set = its credential is an installation token minted for THIS installation, and its live events arrive on the
-- App webhook. Set when an admin connects a repo the installation covers, or when an installation that covers
-- an already-connected repo is bound (SaplingLearn's cut-over); cleared when the installation is removed, or
-- stops covering the repo — the row itself is never deleted by GitHub, only by an admin.
ALTER TABLE org_repos ADD COLUMN installation_id INTEGER;
