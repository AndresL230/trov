-- 0072_repo_scans — the repo scan and its suggestions (repo setups, Phase D). ADDITIVE: two new tables.
--
--   1. repo_scans             the last scan of each repository (src/repo/scan.ts, a guarded arm of reconcileRepo):
--                             the default branch's root TREE sha it read (a scan with the same sha is skipped — no
--                             further request), when, the files it looked for (`looked`, a JSON array of names, for
--                             the "Trov looked for …" sentence) and why it could not run (`error`, fixed scrubbed
--                             text, never a token). PK (org_id, repo).
--   2. repo_app_suggestions   what the scan found — an app (or a package) at a folder, with its kind, host, evidence
--                             (JSON array of { kind, text } — a signal's entry also names the signal), the parts it
--                             proposes (JSON array of { env, provider, settings }) and, for a package, the apps that
--                             use it (`used_by`, JSON array of folders). `id` is stable: a hash of repo + folder + kind,
--                             so a rescan updates the same row. `state`: pending → accepted (an admin wrote the app and
--                             its parts — src/repo/scan-store.ts, audited, with Undo) or ignored (hidden until an
--                             admin's Scan again). A scan never re-suggests an accepted one. `decided_by` is a handle
--                             (HANDLE_COLUMNS). A suggestion changes NOTHING on the Repo screen but the found-apps card
--                             until it is accepted.
CREATE TABLE IF NOT EXISTS repo_scans (
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  repo        TEXT NOT NULL,                         -- owner/name, as org_repos holds it
  tree_sha    TEXT,                                  -- the default branch's root tree sha the last scan read
  scanned_at  TEXT,
  looked      TEXT NOT NULL DEFAULT '[]',            -- JSON array of file names
  error       TEXT CHECK (error IS NULL OR length(error) <= 200),
  PRIMARY KEY (org_id, repo)
);

CREATE TABLE IF NOT EXISTS repo_app_suggestions (
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  repo        TEXT NOT NULL,                         -- owner/name
  id          TEXT NOT NULL,                         -- stable: hash of repo + folder + kind
  key         TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 32 AND key NOT GLOB '*[^a-z0-9_-]*'),
  folder      TEXT NOT NULL,                         -- '/' = the repository root
  kind        TEXT NOT NULL CHECK (kind IN ('Site','Service','Worker','Job','Package')),
  provider    TEXT,                                  -- a hosting provider id, or NULL (no host Trov knows)
  evidence    TEXT NOT NULL DEFAULT '[]',            -- JSON array of { kind, text[, signal] }
  parts       TEXT NOT NULL DEFAULT '[]',            -- JSON array of { env, provider, settings }
  used_by     TEXT NOT NULL DEFAULT '[]',            -- JSON array of folders (a Package's dependents)
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','ignored')),
  decided_at  TEXT,
  decided_by  TEXT,                                  -- a handle (HANDLE_COLUMNS)
  created_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS idx_repo_app_suggestions_repo ON repo_app_suggestions(org_id, repo, state);
