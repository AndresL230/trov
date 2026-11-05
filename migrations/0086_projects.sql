-- 0086_projects: Projects (docs/architecture/projects.md; the spec is docs/superpowers/specs/2026-11-05-projects.md, the
-- contract shared/projects-core.ts). A project is a place to work on one piece of work: it POINTS AT team records
-- (pins, by Ask ref) and OWNS only its details, its instructions, its members, the Ask threads started in it and the
-- artifacts saved from them or uploaded into it. ADDITIVE:
--   · projects — one row per project. `slug` is unique per org and stays reserved once the project is deleted
--     (`deleted_at`, soft: CLAUDE.md invariant 11). `owner` / `archived_by` are handles (HANDLE_COLUMNS).
--   · project_members — the people added to a `members` / `org` project, each `editor` or `viewer` (the owner is
--     `projects.owner`, never a row). Kept, and ignored, while the project is `private`.
--   · project_pins — what a project points at: an Ask ref (`ticket:87`, `doc:deploys`, `repo:owner/name`, …).
--   · chat_threads.project_id, artifact_pages.project_id — the thread / artifact is the project's (at most one).
--     No foreign key: a deleted project is a soft row, and the columns are cleared by src/deletion/projects.ts.
-- Rollback by hand:
--   DROP INDEX IF EXISTS idx_chat_threads_project; DROP INDEX IF EXISTS idx_artifact_pages_project;
--   ALTER TABLE chat_threads DROP COLUMN project_id; ALTER TABLE artifact_pages DROP COLUMN project_id;
--   DROP TABLE project_pins; DROP TABLE project_members; DROP TABLE projects;
-- then DELETE FROM d1_migrations WHERE name = '0086_projects.sql'.
CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  slug          TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 64), -- from the name (projectSlug); reserved forever
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  description   TEXT NOT NULL DEFAULT '',                         -- up to 140 characters
  icon          TEXT NOT NULL,                                    -- a key of PROJECT_ICONS (the spaces' set)
  color         TEXT NOT NULL,                                    -- one of PROJECT_COLORS ('#rrggbb')
  instructions  TEXT NOT NULL DEFAULT '',                         -- up to 2000 characters
  visibility    TEXT NOT NULL DEFAULT 'members' CHECK (visibility IN ('private', 'members', 'org')),
  owner         TEXT NOT NULL COLLATE NOCASE,
  archived_at   TEXT,
  archived_by   TEXT,
  deleted_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (org_id, slug),
  UNIQUE (org_id, id)
);
CREATE INDEX IF NOT EXISTS idx_projects_live ON projects (org_id, deleted_at, updated_at);

CREATE TABLE IF NOT EXISTS project_members (
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  handle      TEXT NOT NULL COLLATE NOCASE,
  role        TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  added_by    TEXT NOT NULL,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, project_id, handle)  -- the org leads every key (data-layer.md › Writing a statement)
);
CREATE INDEX IF NOT EXISTS idx_project_members_handle ON project_members (org_id, handle);

CREATE TABLE IF NOT EXISTS project_pins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  ref         TEXT NOT NULL CHECK (length(ref) BETWEEN 3 AND 160),
  added_by    TEXT NOT NULL,
  added_at    TEXT NOT NULL,
  UNIQUE (org_id, project_id, ref)
);
CREATE INDEX IF NOT EXISTS idx_project_pins_project ON project_pins (org_id, project_id);

ALTER TABLE chat_threads ADD COLUMN project_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_chat_threads_project ON chat_threads (org_id, project_id) WHERE project_id IS NOT NULL;
ALTER TABLE artifact_pages ADD COLUMN project_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_artifact_pages_project ON artifact_pages (org_id, project_id) WHERE project_id IS NOT NULL;
