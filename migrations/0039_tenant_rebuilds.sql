-- Multitenancy (canopy-multitenancy.md, Phase 2) — part 3 of 4: REBUILD every tenant table whose primary
-- key or inline UNIQUE must include org_id (audit §2), so two orgs can hold the same slug, the same
-- semantic key, the same singleton.
--
-- The 0033 pattern: create `x_new`, copy every row with org_id = 'org_saplinglearn', carry the
-- AUTOINCREMENT counter (a copy alone would restart it at MAX(id) and reissue deleted ids), drop the old
-- table, rename. A child rebuilt here references its parent's `_new` name, which the rename rewrites.
-- Children that are NOT rebuilt (artifact_versions / artifact_links / artifact_upload_tokens →
-- artifact_pages(id)) keep resolving by name, because every row keeps its id.
--
-- Foreign keys are deferred for the file and the deferral is switched OFF at the end — which is also what
-- lets the parent drops through (SQLite's deferred counter would otherwise count the dropped parents). So
-- this file does not rely on SQLite to check them: the GUARD before the end inserts the violation count of
-- every table touched here into a CHECK (count = 0) column, and any dangling reference fails the whole
-- file (D1 applies a migration file atomically — nothing is left half-done).
--
-- The FTS tables and every FTS trigger are re-created in 0040; the triggers that lived on the tables
-- rebuilt here (docs_fts_*, plan / prompts / artifacts) go with the old tables.

PRAGMA defer_foreign_keys = true;

-- ── docs + doc_versions ──────────────────────────────────────────────────────
CREATE TABLE docs_new (
  org_id          TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  slug            TEXT NOT NULL,
  section         TEXT NOT NULL REFERENCES sections(name),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT,
  updated_by      TEXT,
  space           TEXT NOT NULL DEFAULT 'canopy',
  owner           TEXT,
  PRIMARY KEY (org_id, slug)
);
INSERT INTO docs_new (org_id, slug, section, title, body, current_version, updated_at, updated_by, space, owner)
  SELECT 'org_saplinglearn', slug, section, title, body, current_version, updated_at, updated_by, space, owner FROM docs;

CREATE TABLE doc_versions_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id         TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  slug           TEXT NOT NULL,
  version        INTEGER NOT NULL,
  body           TEXT NOT NULL,
  summary        TEXT,
  status         TEXT NOT NULL DEFAULT 'staged',
  confidence     TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  content_hash   TEXT,
  base_version   INTEGER,
  change_kind    TEXT,
  low_confidence INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (org_id, slug) REFERENCES docs_new(org_id, slug)
);
INSERT INTO doc_versions_new (id, org_id, slug, version, body, summary, status, confidence, created_at, created_by, content_hash, base_version, change_kind, low_confidence)
  SELECT id, 'org_saplinglearn', slug, version, body, summary, status, confidence, created_at, created_by, content_hash, base_version, change_kind, low_confidence FROM doc_versions;
INSERT INTO sqlite_sequence (name, seq) SELECT 'doc_versions_new', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'doc_versions_new');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'doc_versions'), 0)) WHERE name = 'doc_versions_new';

-- ── entry_tags, processed_items (the replay ledger, D8) ──────────────────────
CREATE TABLE entry_tags_new (
  org_id     TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  tag        TEXT NOT NULL REFERENCES tags(tag),
  entry_type TEXT NOT NULL,
  entry_id   TEXT NOT NULL,
  PRIMARY KEY (org_id, tag, entry_type, entry_id)
);
INSERT INTO entry_tags_new (org_id, tag, entry_type, entry_id) SELECT 'org_saplinglearn', tag, entry_type, entry_id FROM entry_tags;

CREATE TABLE processed_items_new (
  org_id     TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  session_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  item_type  TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  ref        TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, session_id, item_index)
);
INSERT INTO processed_items_new (org_id, session_id, item_index, item_type, outcome, ref, created_at)
  SELECT 'org_saplinglearn', session_id, item_index, item_type, outcome, ref, created_at FROM processed_items;

-- ── events + summaries (C-11: a `repo` column joins the key) ─────────────────
-- `repo` defaults to the one repository every captured row came from (GITHUB_REPO). It is a constant, not
-- parsed from `raw`, on purpose: a redelivery is keyed with the same default, so a raw spelling that
-- differs in case ("SaplingLearn/Sapling") can never split one event into two rows. 0041 drops the default.
CREATE TABLE events_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  repo          TEXT NOT NULL DEFAULT 'SaplingLearn/sapling',
  semantic_key  TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  ref_number    INTEGER NOT NULL,
  subject_login TEXT NOT NULL,
  raw           TEXT NOT NULL,
  provenance    TEXT NOT NULL,
  occurred_at   TEXT,
  recorded_at   TEXT NOT NULL,
  recorded_by   TEXT NOT NULL,
  UNIQUE (org_id, repo, semantic_key)
);
INSERT INTO events_new (id, org_id, repo, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
  SELECT id, 'org_saplinglearn', 'SaplingLearn/sapling', semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by FROM events;
INSERT INTO sqlite_sequence (name, seq) SELECT 'events_new', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'events_new');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)) WHERE name = 'events_new';

CREATE TABLE pr_summaries_new (
  org_id       TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  repo         TEXT NOT NULL DEFAULT 'SaplingLearn/sapling',
  semantic_key TEXT NOT NULL,
  pr_number    INTEGER NOT NULL,
  model        TEXT,
  created_at   TEXT NOT NULL,
  title        TEXT,
  what         TEXT,
  why          TEXT,
  impact       TEXT,
  PRIMARY KEY (org_id, repo, semantic_key),
  FOREIGN KEY (org_id, repo, semantic_key) REFERENCES events_new(org_id, repo, semantic_key)
);
INSERT INTO pr_summaries_new (org_id, repo, semantic_key, pr_number, model, created_at, title, what, why, impact)
  SELECT 'org_saplinglearn', 'SaplingLearn/sapling', semantic_key, pr_number, model, created_at, title, what, why, impact FROM pr_summaries;

CREATE TABLE issue_summaries_new (
  org_id       TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  repo         TEXT NOT NULL DEFAULT 'SaplingLearn/sapling',
  issue_number INTEGER NOT NULL,
  summary      TEXT NOT NULL,
  model        TEXT,
  created_at   TEXT NOT NULL,
  title        TEXT,
  next_step    TEXT,
  PRIMARY KEY (org_id, repo, issue_number)
);
INSERT INTO issue_summaries_new (org_id, repo, issue_number, summary, model, created_at, title, next_step)
  SELECT 'org_saplinglearn', 'SaplingLearn/sapling', issue_number, summary, model, created_at, title, next_step FROM issue_summaries;

-- ── plan (a singleton per org now), plan_versions ────────────────────────────
CREATE TABLE plan_new (
  org_id          TEXT PRIMARY KEY NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  narrative       TEXT NOT NULL DEFAULT '',
  current_version INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT,
  updated_by      TEXT
);
INSERT INTO plan_new (org_id, narrative, current_version, updated_at, updated_by)
  SELECT 'org_saplinglearn', narrative, current_version, updated_at, updated_by FROM plan WHERE id = 1;
INSERT OR IGNORE INTO plan_new (org_id, narrative, current_version) VALUES ('org_saplinglearn', '', 0);

CREATE TABLE plan_versions_new (
  org_id       TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  version      INTEGER NOT NULL,
  narrative    TEXT NOT NULL,
  sprints_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  PRIMARY KEY (org_id, version)
);
INSERT INTO plan_versions_new (org_id, version, narrative, sprints_json, created_at, created_by)
  SELECT 'org_saplinglearn', version, narrative, sprints_json, created_at, created_by FROM plan_versions;

-- ── identity_tasks (per-org intake, D10) ─────────────────────────────────────
CREATE TABLE identity_tasks_new (
  org_id      TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  login       TEXT NOT NULL,
  first_seen  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  resolved_at TEXT,
  resolved_by TEXT,
  PRIMARY KEY (org_id, login)
);
INSERT INTO identity_tasks_new (org_id, login, first_seen, status, resolved_at, resolved_by)
  SELECT 'org_saplinglearn', login, first_seen, status, resolved_at, resolved_by FROM identity_tasks;

-- ── notifications: per-org admin policy and settings (D11), per-org user prefs ──
CREATE TABLE notification_policy_new (
  org_id          TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  kind            TEXT NOT NULL,
  default_cadence TEXT NOT NULL CHECK (default_cadence IN ('daily','weekly','off')),
  enabled         INTEGER NOT NULL DEFAULT 1,
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL,
  PRIMARY KEY (org_id, kind)
);
INSERT INTO notification_policy_new (org_id, kind, default_cadence, enabled, updated_at, updated_by)
  SELECT 'org_saplinglearn', kind, default_cadence, enabled, updated_at, updated_by FROM notification_policy;

CREATE TABLE notification_settings_new (
  org_id       TEXT PRIMARY KEY NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  send_hour    INTEGER NOT NULL DEFAULT 8,
  timezone     TEXT NOT NULL DEFAULT 'America/New_York',
  from_address TEXT NOT NULL
);
INSERT INTO notification_settings_new (org_id, send_hour, timezone, from_address)
  SELECT 'org_saplinglearn', send_hour, timezone, from_address FROM notification_settings WHERE id = 1;

CREATE TABLE notification_prefs_new (
  org_id     TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  cadence    TEXT NOT NULL CHECK (cadence IN ('daily','weekly','off')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id, kind)
);
INSERT INTO notification_prefs_new (org_id, user_id, kind, cadence, updated_at)
  SELECT 'org_saplinglearn', user_id, kind, cadence, updated_at FROM notification_prefs;

-- ── repo capture (0027) ──────────────────────────────────────────────────────
CREATE TABLE repo_events_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  repo        TEXT NOT NULL DEFAULT 'SaplingLearn/sapling',
  semantic_key TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('push','pr','review','deploy','check','run')),
  ref         TEXT,
  sha         TEXT,
  number      INTEGER,
  env         TEXT,
  part        TEXT CHECK (part IS NULL OR part IN ('backend','frontend')),
  state       TEXT,
  name        TEXT,
  actor_login TEXT,
  title       TEXT,
  url         TEXT,
  count       INTEGER,
  raw         TEXT NOT NULL,
  provenance  TEXT NOT NULL CHECK (provenance IN ('webhook','backfill')),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (org_id, repo, semantic_key)
);
INSERT INTO repo_events_new (id, org_id, repo, semantic_key, kind, ref, sha, number, env, part, state, name, actor_login, title, url, count, raw, provenance, occurred_at, recorded_at)
  SELECT id, 'org_saplinglearn', 'SaplingLearn/sapling', semantic_key, kind, ref, sha, number, env, part, state, name, actor_login, title, url, count, raw, provenance, occurred_at, recorded_at FROM repo_events;
INSERT INTO sqlite_sequence (name, seq) SELECT 'repo_events_new', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'repo_events_new');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'repo_events'), 0)) WHERE name = 'repo_events_new';

CREATE TABLE repo_snapshots_new (
  org_id      TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  kind        TEXT NOT NULL,
  json        TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (org_id, kind)
);
INSERT INTO repo_snapshots_new (org_id, kind, json, computed_at)
  SELECT 'org_saplinglearn', kind, json, computed_at FROM repo_snapshots;

CREATE TABLE repo_metrics_new (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  metric TEXT NOT NULL,
  env    TEXT NOT NULL DEFAULT '',
  part   TEXT NOT NULL DEFAULT '',
  value  REAL NOT NULL,
  at     TEXT NOT NULL,
  UNIQUE (org_id, metric, env, part, at)
);
INSERT INTO repo_metrics_new (id, org_id, metric, env, part, value, at)
  SELECT id, 'org_saplinglearn', metric, env, part, value, at FROM repo_metrics;
INSERT INTO sqlite_sequence (name, seq) SELECT 'repo_metrics_new', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'repo_metrics_new');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'repo_metrics'), 0)) WHERE name = 'repo_metrics_new';

-- ── prompts + prompt_versions ────────────────────────────────────────────────
CREATE TABLE prompts_new (
  org_id          TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  slug            TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  tags            TEXT NOT NULL DEFAULT '[]',
  author          TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  use_count       INTEGER NOT NULL DEFAULT 0,
  last_used_at    TEXT,
  deleted_at      TEXT,
  deleted_by      TEXT,
  PRIMARY KEY (org_id, slug)
);
INSERT INTO prompts_new (org_id, slug, title, description, tags, author, current_version, created_at, updated_at, use_count, last_used_at, deleted_at, deleted_by)
  SELECT 'org_saplinglearn', slug, title, description, tags, author, current_version, created_at, updated_at, use_count, last_used_at, deleted_at, deleted_by FROM prompts;

-- ON UPDATE CASCADE: a person's slug rename (src/tools/prompts.ts) updates the prompt and then its
-- versions in one batch; the cascade carries the versions first, so the parent never points nowhere.
CREATE TABLE prompt_versions_new (
  org_id     TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  slug       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('draft','staged','published')),
  author     TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, slug, version),
  FOREIGN KEY (org_id, slug) REFERENCES prompts_new(org_id, slug) ON UPDATE CASCADE
);
INSERT INTO prompt_versions_new (org_id, slug, version, status, author, summary, body, created_at)
  SELECT 'org_saplinglearn', slug, version, status, author, summary, body, created_at FROM prompt_versions;

-- ── artifact_pages (slug unique per org), doc_images (per-org rows, C-10) ────
CREATE TABLE artifact_pages_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id           TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  slug             TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 60),
  title            TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('html','markdown','svg','mermaid','image','pdf','file')),
  area             TEXT NOT NULL CHECK (area IN ('auth','architecture','infra','api','ui','data')),
  repo             TEXT NOT NULL DEFAULT '',
  author_id        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','ratified')),
  visibility       TEXT NOT NULL DEFAULT 'org' CHECK (visibility IN ('org','private')),
  current_version  INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  ratified_version INTEGER,
  ratified_by      TEXT,
  ratified_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  published_at     TEXT,
  deleted_at       TEXT,
  deleted_by       TEXT,
  UNIQUE (org_id, slug),
  UNIQUE (org_id, id),
  CHECK ((status = 'ratified') = (ratified_version IS NOT NULL AND ratified_by IS NOT NULL AND ratified_at IS NOT NULL)),
  CHECK (status = 'ratified' OR (ratified_version IS NULL AND ratified_by IS NULL AND ratified_at IS NULL))
);
INSERT INTO artifact_pages_new (id, org_id, slug, title, kind, area, repo, author_id, status, visibility, current_version, ratified_version, ratified_by, ratified_at, created_at, updated_at, published_at, deleted_at, deleted_by)
  SELECT id, 'org_saplinglearn', slug, title, kind, area, repo, author_id, status, visibility, current_version, ratified_version, ratified_by, ratified_at, created_at, updated_at, published_at, deleted_at, deleted_by FROM artifact_pages;
INSERT INTO sqlite_sequence (name, seq) SELECT 'artifact_pages_new', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'artifact_pages_new');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'artifact_pages'), 0)) WHERE name = 'artifact_pages_new';

CREATE TABLE doc_images_new (
  org_id       TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  sha256       TEXT NOT NULL CHECK (length(sha256) = 64),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/gif','image/webp')),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes >= 1 AND size_bytes <= 10485760),
  uploaded_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (org_id, sha256)
);
INSERT INTO doc_images_new (org_id, sha256, content_type, size_bytes, uploaded_by, created_at)
  SELECT 'org_saplinglearn', sha256, content_type, size_bytes, uploaded_by, created_at FROM doc_images;

-- ── swap: children before parents, then rename ───────────────────────────────
DROP TABLE doc_versions;
DROP TABLE docs;
DROP TABLE entry_tags;
DROP TABLE processed_items;
DROP TABLE pr_summaries;
DROP TABLE issue_summaries;
DROP TABLE events;
DROP TABLE plan;
DROP TABLE plan_versions;
DROP TABLE identity_tasks;
DROP TABLE notification_policy;
DROP TABLE notification_settings;
DROP TABLE notification_prefs;
DROP TABLE repo_events;
DROP TABLE repo_snapshots;
DROP TABLE repo_metrics;
DROP TABLE prompt_versions;
DROP TABLE prompts;
DROP TABLE artifact_pages;
DROP TABLE doc_images;

ALTER TABLE docs_new RENAME TO docs;
ALTER TABLE doc_versions_new RENAME TO doc_versions;
ALTER TABLE entry_tags_new RENAME TO entry_tags;
ALTER TABLE processed_items_new RENAME TO processed_items;
ALTER TABLE events_new RENAME TO events;
ALTER TABLE pr_summaries_new RENAME TO pr_summaries;
ALTER TABLE issue_summaries_new RENAME TO issue_summaries;
ALTER TABLE plan_new RENAME TO plan;
ALTER TABLE plan_versions_new RENAME TO plan_versions;
ALTER TABLE identity_tasks_new RENAME TO identity_tasks;
ALTER TABLE notification_policy_new RENAME TO notification_policy;
ALTER TABLE notification_settings_new RENAME TO notification_settings;
ALTER TABLE notification_prefs_new RENAME TO notification_prefs;
ALTER TABLE repo_events_new RENAME TO repo_events;
ALTER TABLE repo_snapshots_new RENAME TO repo_snapshots;
ALTER TABLE repo_metrics_new RENAME TO repo_metrics;
ALTER TABLE prompts_new RENAME TO prompts;
ALTER TABLE prompt_versions_new RENAME TO prompt_versions;
ALTER TABLE artifact_pages_new RENAME TO artifact_pages;
ALTER TABLE doc_images_new RENAME TO doc_images;

-- ── indexes (the old ones went with the old tables) ──────────────────────────
-- The column lists the Phase-2 queries filter by are kept as they were (those queries do not name an org
-- yet); the org-leading forms the foreign keys need are added beside them. Phase 3 re-leads the rest.
CREATE INDEX idx_docs_space ON docs(space, section);
CREATE INDEX idx_doc_versions_slug ON doc_versions(slug);
CREATE INDEX idx_doc_versions_hash ON doc_versions(slug, content_hash);
CREATE INDEX idx_doc_versions_org_slug ON doc_versions(org_id, slug, content_hash);
CREATE INDEX idx_entry_tags_lookup ON entry_tags(entry_type, entry_id);
CREATE INDEX idx_events_subject ON events(event_type, subject_login, occurred_at);
CREATE INDEX idx_events_ref ON events(event_type, ref_number, occurred_at);
CREATE INDEX idx_repo_events_kind_at ON repo_events(kind, occurred_at);
CREATE INDEX idx_repo_events_kind_number ON repo_events(kind, number, occurred_at);
CREATE INDEX idx_repo_events_kind_sha ON repo_events(kind, sha);
CREATE INDEX idx_repo_events_kind_ref ON repo_events(kind, ref, occurred_at);
CREATE INDEX idx_repo_events_deploys ON repo_events(kind, env, part, occurred_at);
CREATE INDEX idx_repo_metrics_series ON repo_metrics(metric, env, part, at);
CREATE INDEX idx_prompt_versions_org_slug ON prompt_versions(org_id, slug);
CREATE INDEX idx_artifact_pages_updated ON artifact_pages(updated_at);
CREATE INDEX idx_artifact_pages_author ON artifact_pages(author_id);
CREATE INDEX idx_adrs_hash_org ON adrs(org_id, content_hash);

-- ── guard: no dangling reference anywhere this file touched ─────────────────
CREATE TABLE _mt_fk_guard (violations INTEGER NOT NULL CHECK (violations = 0));
INSERT INTO _mt_fk_guard (violations) SELECT
    (SELECT COUNT(*) FROM pragma_foreign_key_check('docs'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('doc_versions'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('entry_tags'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('processed_items'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('events'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('pr_summaries'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('issue_summaries'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('plan'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('plan_versions'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('identity_tasks'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('notification_policy'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('notification_settings'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('notification_prefs'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('repo_events'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('repo_snapshots'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('repo_metrics'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('prompts'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('prompt_versions'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('artifact_pages'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('artifact_versions'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('artifact_links'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('artifact_upload_tokens'))
  + (SELECT COUNT(*) FROM pragma_foreign_key_check('doc_images'));
DROP TABLE _mt_fk_guard;

PRAGMA defer_foreign_keys = false;
