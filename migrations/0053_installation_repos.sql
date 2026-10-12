-- 0053_installation_repos — one GitHub App installation, several Trov organizations, and an org that
-- may use only the repositories its admin can read (issue #170; docs/architecture/github-app.md).
--
-- 0043_github_app said "an installation belongs to at most ONE org", and the connect flow refused
-- anyone who could not read EVERY repository the installation covers. An installation is one GitHub
-- account, so a large account could be used by one Trov organization only, connected by someone who
-- reads all of it. Both rules go:
--
--   before   one live binding per installation        (idx_org_github_installations_installation, UNIQUE)
--            a binding always spans the whole installation
--   after    any number of orgs may bind an installation; each still has ONE live binding
--            (idx_org_github_installations_org stays). A binding is `repo_access = 'all'` (the person
--            who connected it could read everything the installation covers — every binding made
--            before this migration) or `'selected'`: it reaches only the repositories listed for it in
--            org_github_installation_repos, the ones that person could read when they connected.
--
-- A repository may be tracked by SEVERAL orgs, through the App or by hand: its events go to each.
--
-- SAFE ON LIVE DATA, AND ON THE WORKER FROM BEFORE IT. No table is rebuilt and no row is lost. That
-- Worker still refuses a second org and a partial reader in code, and its INSERT takes the new column's
-- default (`all`), which is what its own check proved.
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). End every `selected`
-- binding, and every binding but the oldest of an installation — the old Worker reads a binding as the
-- whole installation, and the old unique index cannot be created over two:
--   UPDATE org_repos SET connection = 'manual', access_lost_at = NULL WHERE connection = 'app' AND org_id IN
--     (SELECT org_id FROM org_github_installations WHERE removed_at IS NULL AND repo_access = 'selected');
--   UPDATE org_github_installations SET removed_at = datetime('now'), removed_reason = 'disconnected'
--    WHERE removed_at IS NULL AND (repo_access = 'selected' OR EXISTS (SELECT 1 FROM org_github_installations o
--          WHERE o.installation_id = org_github_installations.installation_id AND o.removed_at IS NULL AND o.id < org_github_installations.id));
--   DROP TABLE IF EXISTS org_github_installation_repos;
--   DROP INDEX IF EXISTS idx_org_github_installations_installation;
--   CREATE UNIQUE INDEX idx_org_github_installations_installation ON org_github_installations(installation_id) WHERE removed_at IS NULL;
--   DELETE FROM d1_migrations WHERE name = '0053_installation_repos.sql';
-- (`repo_access` may stay: the old Worker never names it.)

DROP INDEX IF EXISTS idx_org_github_installations_installation;
-- The same name, no longer unique: the App webhook still looks bindings up by installation.
CREATE INDEX IF NOT EXISTS idx_org_github_installations_installation ON org_github_installations(installation_id) WHERE removed_at IS NULL;

ALTER TABLE org_github_installations ADD COLUMN repo_access TEXT NOT NULL DEFAULT 'all' CHECK (repo_access IN ('all', 'selected'));

-- The repositories a `selected` binding reaches: what the admin who connected it could read then
-- (GitHub's own list, `GET /user/installations/:id/repositories`). Connecting again ADDS to it; it is
-- emptied when the binding ends. Names, ids and visibility only.
CREATE TABLE IF NOT EXISTS org_github_installation_repos (
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  binding_id      INTEGER NOT NULL REFERENCES org_github_installations(id),
  repo_id         INTEGER NOT NULL,                 -- GitHub's id of the repository
  repo_full_name  TEXT NOT NULL COLLATE NOCASE,     -- owner/name as GitHub gave it then
  private         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, binding_id, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_org_github_installation_repos_name ON org_github_installation_repos(org_id, binding_id, repo_full_name);
