-- 0071_repo_settings — an admin's per-repository defaults for the Repo screen (Repo setups, Phase C).
--
-- One row per (org, repository), written only by an admin through the cookie route
-- `PUT /api/o/:slug/repo/settings` (src/repo/settings-routes.ts), audited as `repo.settings` in
-- org_admin_audit. Read by the Overview's facts read (`readRepoSettings`, src/data/repo-settings.ts) as
-- `facts.groupDefault`. No row = no default: the Overview draws the opener its layout rules decide.
--
--   overview_group   the Overview's default Group by — 'env' (environment cards) or 'app' (the apps table),
--                    honoured only where the layout can draw either (two or more deployed apps in two or more
--                    environments, shared/repo-layout-core.ts `layoutOf`); NULL = none. A viewer's own flip of the
--                    switch is session-only and never written.
--   updated_by       a person HANDLE (src/auth/persons.ts HANDLE_COLUMNS), so a rename or a deleted account
--                    rewrites it.
--
-- `repo` is not a foreign key: a repository disconnected from the org keeps its row (harmless, never read for a
-- repository the org does not have — the route and the read both check `org_repos`), and it goes with the org
-- (src/deletion/tables.ts ORG_TABLES). Rollback: DROP TABLE repo_settings; DELETE FROM org_admin_audit WHERE action = 'repo.settings';

CREATE TABLE IF NOT EXISTS repo_settings (
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  repo            TEXT NOT NULL COLLATE NOCASE,      -- `owner/name` as org_repos.repo_full_name spells it
  overview_group  TEXT CHECK (overview_group IN ('env', 'app')),
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL,
  PRIMARY KEY (org_id, repo)
);
