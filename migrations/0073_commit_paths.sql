-- 0073_commit_paths — which files a commit and a pull request touched (Repo setups, Phase E: monorepos).
--
-- ADDITIVE: three new tables, no rebuild, nothing removed. They let the Repo screen narrow Code and CI to one app
-- (the App menu): a commit, a run or a pull request belongs to an app when its files fall under the app's watch
-- paths (`repo_apps.watch`, src/repo/watch.ts). Captured ONLY through the gate (src/consumer.ts — the repo
-- capture's sibling arms `ingestCommitPaths` / `ingestPrFiles`); read by src/repo/app-scope.ts and the not-shipped
-- arm (src/repo/facts-compute.ts). Never on a render path.
--
--   commit_paths   one row per (org, repository, commit, file). From a `push` delivery's own
--                  `commits[].added / modified / removed` (`scope = 'commit'`: exactly that commit's files). When the
--                  push lists more commits than its payload holds (GitHub caps it at 20) or a commit's lists are
--                  cut short, ONE `compare` (before...after) fills in — but a compare's `files` belong to the whole
--                  push, not to any one commit, so they are stored under the push's head commit with `scope =
--                  'push'` (or `'push_partial'` when the compare itself returned its 300-file cap) and ONLY when that
--                  head commit has no exact list of its own. A filter treats a `push*` row as the push's, never as
--                  a commit's: a commit with no `commit` rows has UNKNOWN paths. `at` is the commit's (or the
--                  push's) own instant. Kept 100 days (`pruneRepoCapture`, COMMIT_PATHS_RETENTION_DAYS) — the
--                  widest window anything reads is the 14-day commit bars and the not-shipped compares.
--   pr_files       one row per (org, repository, pull request, file): `GET /pulls/{n}/files`, at most 3 pages of
--                  100, only for a repository with two or more apps, for open PRs and PRs merged in the last 14
--                  days — on the `pull_request` webhook (opened / synchronize / closed-merged) and in reconcile's
--                  bounded `pr_files` arm. Replaced whole when the PR's head moves.
--   pr_file_reads  one row per (org, repository, pull request): the head commit the files were read for, whether
--                  the list is complete (fewer than 3 full pages) and the gate's content hash — so "never read"
--                  (no row: unknown, never guessed into an app) is told apart from "read, touches nothing".
--
-- `pr_files` and `pr_file_reads` are pruned with the read: 100 days after `fetched_at`. None of the three holds a
-- handle (nothing to add to HANDLE_COLUMNS). All three go with the org (src/deletion/tables.ts ORG_TABLES).
-- Rollback: DROP TABLE pr_file_reads; DROP TABLE pr_files; DROP TABLE commit_paths;

CREATE TABLE IF NOT EXISTS commit_paths (
  org_id  TEXT NOT NULL REFERENCES orgs(id),
  repo    TEXT NOT NULL COLLATE NOCASE,          -- `owner/name` as org_repos.repo_full_name spells it
  sha     TEXT NOT NULL,                         -- the commit (a `push*` row: the push's head commit)
  path    TEXT NOT NULL,                         -- a file path, as GitHub lists it
  scope   TEXT NOT NULL DEFAULT 'commit' CHECK (scope IN ('commit', 'push', 'push_partial')),
  at      TEXT NOT NULL,
  PRIMARY KEY (org_id, repo, sha, path)
);
CREATE INDEX IF NOT EXISTS idx_commit_paths_sha ON commit_paths(org_id, sha);
CREATE INDEX IF NOT EXISTS idx_commit_paths_at ON commit_paths(at);

CREATE TABLE IF NOT EXISTS pr_files (
  org_id  TEXT NOT NULL REFERENCES orgs(id),
  repo    TEXT NOT NULL COLLATE NOCASE,
  number  INTEGER NOT NULL,
  path    TEXT NOT NULL,
  PRIMARY KEY (org_id, repo, number, path)
);

CREATE TABLE IF NOT EXISTS pr_file_reads (
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  repo          TEXT NOT NULL COLLATE NOCASE,
  number        INTEGER NOT NULL,
  head_sha      TEXT,                            -- the PR head the list was read for
  complete      INTEGER NOT NULL DEFAULT 1 CHECK (complete IN (0, 1)),
  content_hash  TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, repo, number)
);
CREATE INDEX IF NOT EXISTS idx_pr_file_reads_fetched ON pr_file_reads(fetched_at);
