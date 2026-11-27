-- 0090_sandbox_monitor: Monitor › Sandboxes, profiles and the org's sandbox rules (docs/architecture/sandboxes.md).
-- ADDITIVE:
--   · org_sandboxes gains `name` (what people and agents call it; unique among the org's live sandboxes, checked in
--     src/tools/sandboxes.ts), `profile_key` (the profile it booted from, NULL for none), `boot_state`
--     ('none' | 'pending' | 'booting' | 'ready' | 'failed') and `boot_detail` (the runner's boot report, JSON).
--   · sandbox_events — Trov's own record of what happened in a sandbox: every sandbox_* tool call (source 'agent'),
--     every stop / start / delete from the web app (source 'person') and each boot step (source 'boot'). `actor` is a
--     handle (HANDLE_COLUMNS). `output` is a scrubbed tail, kept only for a failure. Kept after the sandbox is gone.
--   · sandbox_profiles — what an agent boots from by `key`: repository, branch, size, image, setup steps, start
--     command and port, plain env, lifetime. Soft deleted: a deleted key stays reserved. `created_by` / `updated_by` /
--     `deleted_by` are handles.
--   · orgs.sandbox_members_act (1 = anyone in the org may stop, start or delete a sandbox from the web app; 0 = admins
--     and owners) and orgs.sandbox_public (1 = agents may make a sandbox's previews public).
-- Rollback by hand:
--   DROP TABLE sandbox_events; DROP TABLE sandbox_profiles;
--   ALTER TABLE org_sandboxes DROP COLUMN name; ALTER TABLE org_sandboxes DROP COLUMN profile_key;
--   ALTER TABLE org_sandboxes DROP COLUMN boot_state; ALTER TABLE org_sandboxes DROP COLUMN boot_detail;
--   ALTER TABLE orgs DROP COLUMN sandbox_members_act; ALTER TABLE orgs DROP COLUMN sandbox_public;
-- then DELETE FROM d1_migrations WHERE name = '0090_sandbox_monitor.sql'.
ALTER TABLE org_sandboxes ADD COLUMN name TEXT;
ALTER TABLE org_sandboxes ADD COLUMN profile_key TEXT;
ALTER TABLE org_sandboxes ADD COLUMN boot_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE org_sandboxes ADD COLUMN boot_detail TEXT;

CREATE TABLE IF NOT EXISTS sandbox_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  sandbox_id  TEXT NOT NULL,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL COLLATE NOCASE,
  source      TEXT NOT NULL CHECK (source IN ('agent', 'person', 'boot')),
  tool        TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  result      TEXT NOT NULL DEFAULT '',
  exit_code   INTEGER,
  ms          INTEGER,
  failed      INTEGER NOT NULL DEFAULT 0,
  output      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sandbox_events_box ON sandbox_events (org_id, sandbox_id, id);
CREATE INDEX IF NOT EXISTS idx_sandbox_events_at ON sandbox_events (org_id, at);

CREATE TABLE IF NOT EXISTS sandbox_profiles (
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  key          TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 40),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  repo         TEXT,
  branch       TEXT NOT NULL DEFAULT 'main',
  size         TEXT NOT NULL DEFAULT 'small' CHECK (size IN ('small', 'medium', 'large')),
  image        TEXT,
  setup        TEXT NOT NULL DEFAULT '[]',
  start_cmd    TEXT,
  port         INTEGER,
  env          TEXT NOT NULL DEFAULT '{}',
  auto_stop    INTEGER NOT NULL DEFAULT 60,
  delete_days  INTEGER NOT NULL DEFAULT 7,
  created_by   TEXT NOT NULL COLLATE NOCASE,
  created_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL COLLATE NOCASE,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  deleted_by   TEXT COLLATE NOCASE,
  PRIMARY KEY (org_id, key)
);

ALTER TABLE orgs ADD COLUMN sandbox_members_act INTEGER NOT NULL DEFAULT 1;
ALTER TABLE orgs ADD COLUMN sandbox_public INTEGER NOT NULL DEFAULT 0;
