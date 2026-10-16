-- 0070_repo_apps — apps on top of #185's parts, and a commit on every deploy (repo setups, Phase A).
--
-- ADDITIVE: one new table, four new columns, no rebuild. What changes:
--
--   1. repo_apps         an APP is a part key (`org_environment_parts.part_key`) with a home: the repository
--                        and folder it lives in, its kind (Site / Service / Worker / Job / Package — the role
--                        follows the kind: shared/repo-apps-core.ts), the path globs that count as its changes
--                        (`watch`, a JSON array — the folder by default), how a release is recognised
--                        (`release_signal`, NULL until Phase F), where the row came from (`source`: migrated
--                        here, manual, or an accepted suggestion) and its order. PK (org_id, key). A part key
--                        with NO row still reads as an app at the primary repository's root
--                        (src/repo/apps.ts `listRepoApps` synthesises it), so nothing existing breaks.
--                        `repo` = '' means "the org's primary repository" (an org with no repository yet).
--   2. a row per existing part key, per org: repo = the org's primary repository (or ''), folder '/', label
--      from the part (the first environment's, by drift order), kind from the part's role — `web` on
--      Cloudflare → Worker, any other `web` → Site, `service` → Service. Written by 'migration'.
--   3. hosting_deploys   `source` (provider | github — a `github` part's deploys are written from the GitHub
--                        capture, src/hosting/github-deploys.ts), `reason` (a scrubbed failure reason, ≤ 140
--                        characters), `sha_source` (provider — the host said so; joined — exactly one GitHub
--                        signal finished in the 10 minutes before the deploy, src/hosting/sha-join.ts; NULL —
--                        no commit known), `rolled_back_from` (the sha a production deploy went BACK from:
--                        one GitHub compare answered `behind`, src/hosting/rollback.ts). Existing rows with a
--                        sha were the provider's: `sha_source = 'provider'`. `target` and `branch` already
--                        exist (0057).
--
-- GitHub deploy signals (deployment / deployment_status deliveries and non-`canopy/*` commit statuses) are
-- captured again as `repo_events` rows of the EXISTING kind `deploy`, untagged (env and part NULL), with
-- `raw.signal` saying which — so `repo_events`' kind CHECK needs no rebuild (src/repo/capture.ts).

-- ── 1. repo_apps ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS repo_apps (
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  key             TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 32 AND key NOT GLOB '*[^a-z0-9_-]*'),
  repo            TEXT NOT NULL DEFAULT '',            -- owner/name; '' = the org's primary repository
  label           TEXT NOT NULL,
  folder          TEXT NOT NULL DEFAULT '/',           -- '/' = the repository root; else a path without leading / trailing '/'
  kind            TEXT NOT NULL CHECK (kind IN ('Site','Service','Worker','Job','Package')),
  watch           TEXT NOT NULL DEFAULT '["/"]',       -- JSON array of path globs; the folder by default
  release_signal  TEXT,                                -- how a release is recognised (Phase F); NULL = none yet
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('migrated','manual','suggested')),
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,                       -- a handle (HANDLE_COLUMNS)
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL,                       -- a handle (HANDLE_COLUMNS)
  PRIMARY KEY (org_id, key)
);

-- ── 2. a row per existing part key ──────────────────────────────────────────
INSERT OR IGNORE INTO repo_apps (org_id, key, repo, label, folder, kind, watch, release_signal, source, position, created_at, created_by, updated_at, updated_by)
  SELECT p.org_id, p.part_key,
         COALESCE((SELECT r.repo_full_name FROM org_repos r WHERE r.org_id = p.org_id AND r.is_primary = 1), ''),
         p.label, '/',
         CASE WHEN p.role = 'service' THEN 'Service' WHEN p.provider = 'cloudflare' THEN 'Worker' ELSE 'Site' END,
         '["/"]', NULL, 'migrated',
         (SELECT COUNT(DISTINCT q.part_key) FROM org_environment_parts q
            WHERE q.org_id = p.org_id AND q.part_key < p.part_key),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration'
  FROM org_environment_parts p
  JOIN org_environments e ON e.org_id = p.org_id AND e.key = p.env_key
  -- the FIRST environment (drift order) holding the key names it
  WHERE NOT EXISTS (
    SELECT 1 FROM org_environment_parts p2 JOIN org_environments e2 ON e2.org_id = p2.org_id AND e2.key = p2.env_key
    WHERE p2.org_id = p.org_id AND p2.part_key = p.part_key AND (e2.position < e.position OR (e2.position = e.position AND e2.key < e.key))
  );

-- ── 3. hosting_deploys: where a deploy came from, why it failed, how its commit is known, a rollback ──
ALTER TABLE hosting_deploys ADD COLUMN source TEXT NOT NULL DEFAULT 'provider' CHECK (source IN ('provider','github'));
ALTER TABLE hosting_deploys ADD COLUMN reason TEXT CHECK (reason IS NULL OR length(reason) <= 140);
ALTER TABLE hosting_deploys ADD COLUMN sha_source TEXT CHECK (sha_source IS NULL OR sha_source IN ('provider','joined'));
ALTER TABLE hosting_deploys ADD COLUMN rolled_back_from TEXT;
UPDATE hosting_deploys SET sha_source = 'provider' WHERE sha IS NOT NULL AND sha_source IS NULL;
