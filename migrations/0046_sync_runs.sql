-- 0046_sync_runs: one row per Sync GitHub RUN, so a sync is visible to the person who pressed it, to
-- everyone else in the org, and after a reload (docs/architecture/sync.md).
--
-- ADDITIVE only: one new table and its index; nothing existing changes. A TENANT table: every statement
-- that touches it names `org_id` (src/sync/runs.ts), and the retention sweep deletes rows by age alone
-- (src/platform/sweeps.ts `pruneSyncRuns`).
--
-- A run is one or more batches (the browser POSTs `/admin/backfill` once per batch). The row is written
-- when the first batch starts, updated as each batch reports — `updated_at` is its heartbeat — and closed
-- by the batch that ends the run. A row still `running` whose `updated_at` is older than three minutes
-- never reported an end (the tab closed, the request died): it stops holding the lock, reads as
-- "did not finish", and is marked `abandoned` when the next run starts.
--
-- It holds COUNTS and failure CODES only: no title, no body, no summary text, no token, and no text an
-- upstream wrote — `failures` is a JSON array of `{ code, status? }` from a fixed vocabulary
-- (shared/sync.ts `SyncFailure`).
CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  repo        TEXT NOT NULL,                              -- the primary repository it read, 'owner/repo'
  started_by  TEXT NOT NULL,                              -- a handle (HANDLE_COLUMNS)
  started_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,                              -- the heartbeat: the last time the run reported
  ended_at    TEXT,
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed', 'abandoned')),
  batch       INTEGER NOT NULL DEFAULT 0,                 -- the batch under way (1-based), or the last one made
  batches     INTEGER,                                    -- how many it is expected to take; NULL = not known yet
  phase       TEXT NOT NULL DEFAULT 'starting',           -- shared/sync.ts SYNC_PHASES
  done        INTEGER,                                    -- items done within the phase
  total       INTEGER,                                    -- of how many; NULL where no total is known
  counts      TEXT NOT NULL DEFAULT '{}',                 -- JSON: shared/sync.ts SyncCounts
  failures    TEXT NOT NULL DEFAULT '[]',                 -- JSON: SyncFailure[]
  previous_at TEXT                                        -- when the previous finished run ended
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_org ON sync_runs(org_id, id);
