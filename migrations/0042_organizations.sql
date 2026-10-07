-- Organizations (canopy-multitenancy.md): everything that turns the one-team database into a multi-org
-- one, as ONE migration. It was written and tested as ten files and consolidated before release — the ten
-- sections below are those files' statements, unchanged and in their original order (the old → new map is
-- at the top of canopy-multitenancy.md §3). `0041_trov_name.sql` had already shipped on its own, so this
-- file takes the next number and always runs AFTER it.
--
--    1 · Orgs               the platform tables, and SaplingLearn as org #1
--    2 · Tenant columns     `org_id` on every tenant table whose keys do not change; per-org display numbers
--    3 · Tenant rebuilds    the 20 tables whose key must include `org_id`; ends in the foreign-key GUARD
--    4 · Tenant FTS         org-scoped search tables and triggers
--    5 · Platform admins    the superadmin
--    6 · Platform orgs      suspension, the owner invite, usage metering, the org-administration audit
--    7 · Identity uid       a GitHub identity pinned to the account's immutable id
--    8 · Abuse limits       per-person counters
--    9 · Org invite mail    the invitee's name and the mail's outcome, on the invite
--   10 · Org logo           the organization's image
--
-- ALL OR NOTHING. D1 applies a migration file as one batch, so a failure anywhere — section 3's guard above
-- all — leaves the database exactly as it was (0036 + 0041) and the file unrecorded
-- (test/migrations.multitenancy.test.ts proves it for the whole file). That, and the d1_migrations ledger
-- never re-applying a recorded file (§3.3), is what makes a retry safe; the `IF NOT EXISTS` /
-- `INSERT OR IGNORE` / deterministic ids kept from the ten files are harmless and no longer load-bearing.
--
-- Foreign keys are enforced immediately everywhere EXCEPT section 3, which defers them between its own two
-- PRAGMAs: sections 1–2 run before the deferral is switched on and 4–10 after it is switched off.
--
-- The whole file travels to D1 as one request: keep it under D1's 100 KB SQL limit (the same test checks).
-- A LOCAL database that recorded the ten old file names cannot apply this on top of them — reset it
-- (HANDOFF.md). Production never recorded them. Rollback: scripts/mt/rollback/0042_organizations.down.sql.


-- ═══ 1 · Orgs — the platform tables, and SaplingLearn as org #1 (Phase 2) ══════════════════════════════════
--
-- Everything here is additive: new tables, two nullable person/identity columns, and seed rows built
-- from data already in D1. No tenant table changes shape until section 2.
--
-- The legacy org id `org_saplinglearn` is the transitional DEFAULT of every tenant `org_id` column
-- (sections 2–3, §3.2): an INSERT that names no org lands here. The Phase 7 cleanup migration removes
-- those defaults.

-- ── orgs, memberships, invites ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,                       -- 'org_' + random; legacy: 'org_saplinglearn'
  slug        TEXT NOT NULL UNIQUE COLLATE NOCASE
              CHECK (length(slug) BETWEEN 2 AND 39 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*'),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL                           -- a handle (HANDLE_COLUMNS); 'migration' for org #1
);

CREATE TABLE IF NOT EXISTS memberships (
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  user_id          TEXT NOT NULL COLLATE NOCASE REFERENCES persons(handle),   -- the person handle IS the user id
  role             TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  title            TEXT,                              -- was persons.role (0036) — per org (Q9)
  responsibilities TEXT,                              -- was persons.responsibilities (0036) — per org (Q9)
  created_at       TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

CREATE TABLE IF NOT EXISTS org_invites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  github_login  TEXT COLLATE NOCASE,                  -- a GitHub-login invite (D4)
  email         TEXT COLLATE NOCASE,                  -- an email invite (Q1), matched against identities.verified_email
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  invited_by    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked')),
  created_at    TEXT NOT NULL,
  responded_at  TEXT,
  responded_by  TEXT,
  CHECK ((github_login IS NULL) <> (email IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invites_pending_login ON org_invites(org_id, github_login) WHERE status = 'pending' AND github_login IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invites_pending_email ON org_invites(org_id, email) WHERE status = 'pending' AND email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_org_invites_login ON org_invites(github_login, status);
CREATE INDEX IF NOT EXISTS idx_org_invites_email ON org_invites(email, status);

-- ── repositories, environments (D10, D16) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_repos (
  id              TEXT PRIMARY KEY,                   -- 'hook_' + random: the webhook path id and the github_webhook secret's scope
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  repo_full_name  TEXT NOT NULL COLLATE NOCASE,       -- 'owner/repo'
  is_primary      INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  legacy_hook     INTEGER NOT NULL DEFAULT 0 CHECK (legacy_hook IN (0,1)),  -- reachable via the old /webhook/github (cut-over only)
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  UNIQUE (org_id, repo_full_name)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_repos_primary ON org_repos(org_id) WHERE is_primary = 1;

CREATE TABLE IF NOT EXISTS org_environments (
  org_id                 TEXT NOT NULL REFERENCES orgs(id),
  key                    TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 32 AND key NOT GLOB '*[^a-z0-9_-]*'),
  position               INTEGER NOT NULL,          -- ORDER MATTERS: [0] = drift head + canopy/* status branch; last = drift base
  label                  TEXT NOT NULL,
  note                   TEXT,
  branch                 TEXT NOT NULL,
  railway_env            TEXT NOT NULL DEFAULT '',
  worker                 TEXT NOT NULL DEFAULT '',
  worker_check           TEXT NOT NULL DEFAULT '',
  frontend_url           TEXT NOT NULL DEFAULT '',
  api_url                TEXT NOT NULL DEFAULT '',
  health_path            TEXT NOT NULL DEFAULT '/',
  railway_environment_id TEXT,
  railway_service_id     TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  updated_by             TEXT NOT NULL,
  PRIMARY KEY (org_id, key),
  UNIQUE (org_id, position)
);

-- ── integration secrets (D14, D15) ───────────────────────────────────────────
-- One wrapped data key per org and version, wrapped under the Worker secret TROV_KEK (§8.7.1).
CREATE TABLE IF NOT EXISTS org_keys (
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  key_version     INTEGER NOT NULL CHECK (key_version >= 1),
  wrapped_key     TEXT NOT NULL,
  wrap_iv         TEXT NOT NULL,
  kek_fingerprint TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  retired_at      TEXT,
  PRIMARY KEY (org_id, key_version)
);

-- Exactly D14's columns. The only reader is getSecret(ctx, kind, scope) (Phase 5b).
CREATE TABLE IF NOT EXISTS org_secrets (
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  kind          TEXT NOT NULL CHECK (kind IN ('cloudflare_analytics','railway','metrics_endpoint','github_token','github_webhook')),
  scope         TEXT NOT NULL DEFAULT '',
  ciphertext    TEXT NOT NULL,
  iv            TEXT NOT NULL,
  key_version   INTEGER NOT NULL,
  hint_last4    TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  rotated_at    TEXT,
  last_used_at  TEXT,
  last_error    TEXT,
  UNIQUE (org_id, kind, scope),
  FOREIGN KEY (org_id, key_version) REFERENCES org_keys(org_id, key_version)
);

CREATE TABLE IF NOT EXISTS org_integration_config (
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  kind        TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '',
  config      TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  PRIMARY KEY (org_id, kind, scope)
);

CREATE TABLE IF NOT EXISTS org_audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id  TEXT NOT NULL REFERENCES orgs(id),
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL CHECK (action IN ('secret.set','secret.rotate','secret.delete','integration.config','key.rotate')),
  target  TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT '{}',
  at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_audit_org ON org_audit(org_id, at);

-- ── attribution, numbering, polling ──────────────────────────────────────────
-- Per-org ATTRIBUTION of a GitHub login to a person (C-1). Never read by sign-in.
CREATE TABLE IF NOT EXISTS org_login_map (
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  github_login TEXT NOT NULL COLLATE NOCASE,
  person       TEXT NOT NULL REFERENCES persons(handle),
  mapped_at    TEXT NOT NULL,
  mapped_by    TEXT NOT NULL,
  PRIMARY KEY (org_id, github_login)
);

-- Per-org display numbers (Q2): the next ticket / handoff number. Only ever increases, so a deleted
-- ticket's number is never reissued. Advanced by the tickets/handoffs AFTER INSERT triggers (section 2).
CREATE TABLE IF NOT EXISTS org_counters (
  org_id  TEXT NOT NULL REFERENCES orgs(id),
  name    TEXT NOT NULL CHECK (name IN ('ticket','handoff')),
  value   INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  PRIMARY KEY (org_id, name)
);

-- The rotation cursor of the per-(org, environment) poll jobs (D17 as amended, §8.3).
CREATE TABLE IF NOT EXISTS cron_cursor (
  job        TEXT PRIMARY KEY,
  last_key   TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

-- ── person / identity columns ────────────────────────────────────────────────
-- Q6: the org-creation cap override (NULL = the default, 3).
ALTER TABLE persons ADD COLUMN org_limit INTEGER CHECK (org_limit IS NULL OR org_limit >= 0);
-- Q1: the email the provider VERIFIED at the last sign-in — what an email invite is matched against.
ALTER TABLE identities ADD COLUMN verified_email TEXT;
-- A Google identity's label IS its verified email (0023; unverified addresses are refused at sign-in).
UPDATE identities SET verified_email = lower(label) WHERE provider = 'google' AND verified_email IS NULL;

-- ── SaplingLearn: org #1 ─────────────────────────────────────────────────────
INSERT OR IGNORE INTO orgs (id, slug, name, created_at, created_by)
  VALUES ('org_saplinglearn', 'saplinglearn', 'SaplingLearn', '2026-10-06T00:00:00.000Z', 'migration');

-- Every existing person except the reserved system handles is a member; title and responsibilities
-- move onto the membership (Q9 — the person columns stay, unread, until the Phase 7 cleanup).
INSERT OR IGNORE INTO memberships (org_id, user_id, role, title, responsibilities, created_at, created_by)
  SELECT 'org_saplinglearn', handle, 'member', role, responsibilities, created_at, 'migration'
    FROM persons
   WHERE lower(handle) NOT IN ('github-webhook', 'system', 'admin', 'canopy', 'me');
-- Q3: andres is the owner. A ONE-TIME data seed: `AndresL230` is the same person's earlier handle
-- (both were in ADMIN_LOGINS through the rename), so whichever one exists today becomes owner.
UPDATE memberships SET role = 'owner'
 WHERE org_id = 'org_saplinglearn' AND lower(user_id) IN ('andres', 'andresl230');

-- Attribution as it is today: every GitHub sign-in identity attributes its login inside org #1.
INSERT OR IGNORE INTO org_login_map (org_id, github_login, person, mapped_at, mapped_by)
  SELECT 'org_saplinglearn', subject, person, linked_at, linked_by FROM identities WHERE provider = 'github';

-- The admin's email invites carry over (Q1). Accepted / revoked ones are kept as history.
-- (`AS status` names nothing the INSERT reads; it is there because wrangler's statement splitter — local
-- and test databases — ends a CASE only at `END` + whitespace, and would otherwise run the REST OF THIS FILE
-- as one statement.)
INSERT INTO org_invites (org_id, email, role, invited_by, status, created_at, responded_at, responded_by)
  SELECT 'org_saplinglearn', lower(email), 'member', invited_by,
         CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN accepted_by IS NOT NULL THEN 'accepted' ELSE 'pending' END AS status,
         invited_at, revoked_at, accepted_by
    FROM invites
   WHERE NOT EXISTS (SELECT 1 FROM org_invites o WHERE o.org_id = 'org_saplinglearn' AND o.email = lower(invites.email));

-- GITHUB_REPO and REPO_ENVIRONMENTS (wrangler.toml [vars], 2026-10-06) become rows (D16). A one-time
-- copy of configuration; from Phase 5b the dashboard reads these rows, not the var.
INSERT OR IGNORE INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by)
  VALUES ('hook_saplinglearn_sapling', 'org_saplinglearn', 'SaplingLearn/sapling', 1, 1, '2026-10-06T00:00:00.000Z', 'migration');
INSERT OR IGNORE INTO org_environments (org_id, key, position, label, note, branch, railway_env, worker, worker_check,
    frontend_url, api_url, health_path, railway_environment_id, railway_service_id, created_at, updated_at, updated_by)
  VALUES
  ('org_saplinglearn', 'staging', 0, 'staging', 'main', 'main', 'Sapling / staging', 'frontend-staging', 'Workers Builds: frontend-staging',
   'https://staging.saplinglearn.com', 'https://api.staging.saplinglearn.com', '/api/health',
   '76bb36e5-cf12-4b1e-b47f-d276a56c3b85', 'c67bfc38-32a9-41a7-9440-f033d255af30',
   '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z', 'migration'),
  ('org_saplinglearn', 'production', 1, 'production', 'production', 'production', 'Sapling / production', 'frontend', 'Workers Builds: frontend',
   'https://saplinglearn.com', 'https://api.saplinglearn.com', '/api/health',
   'dd058398-45bc-4c7d-80b1-12d46e3f28fb', 'c67bfc38-32a9-41a7-9440-f033d255af30',
   '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z', 'migration');

INSERT OR IGNORE INTO cron_cursor (job, last_key, updated_at) VALUES
  ('health', '', '2026-10-06T00:00:00.000Z'), ('usage', '', '2026-10-06T00:00:00.000Z'),
  ('reconcile', '', '2026-10-06T00:00:00.000Z'), ('progress', '', '2026-10-06T00:00:00.000Z');


-- ═══ 2 · Tenant columns — `org_id` where the keys do not change; per-org numbers (Phase 2) ═════════════════
-- `org_id` on every tenant table whose KEYS do not change, and the per-org display numbers (Q2).
--
-- These tables keep their shape and gain one column. SQLite's ADD COLUMN cannot carry a REFERENCES clause
-- with a non-NULL default, so here `org_id` has no foreign key to orgs(id); the Phase 7 cleanup rebuild that
-- removes the transitional DEFAULT adds it, together with the composite in-org foreign keys
-- (ticket_* → tickets(org_id, id), …). Until then the org is guaranteed by the default and by the data
-- layer. Every existing row becomes SaplingLearn's (the column default fills it).
--
-- The tables whose primary key or inline UNIQUE must include org_id are REBUILT in section 3.

ALTER TABLE feed ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE adrs ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE needs_triage ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE sprints ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE sprint_resources ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE sprint_progress ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE tickets ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE ticket_assignees ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE ticket_links ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE ticket_comments ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE ticket_events ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE handoffs ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE mcp_tokens ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE oauth_grants ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE oauth_codes ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE artifact_versions ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE artifact_links ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE artifact_upload_tokens ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE doc_image_upload_tokens ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE notification_outbox ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';
ALTER TABLE notification_outbox_bodies ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_saplinglearn';

-- ── in-org uniqueness on surrogate ids (the targets of the Phase 7 cleanup's composite foreign keys) ──
CREATE UNIQUE INDEX IF NOT EXISTS idx_sprints_org_id ON sprints(org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_org_id ON tickets(org_id, id);

-- A GitHub issue is mirrored once PER ORG (audit §2): the partial UNIQUE on source_ref gains org_id.
DROP INDEX IF EXISTS idx_tickets_source_ref;
CREATE UNIQUE INDEX idx_tickets_source_ref ON tickets(org_id, source_ref) WHERE source_ref IS NOT NULL;

-- ── per-org display numbers (Q2) ─────────────────────────────────────────────
-- `#12` becomes a per-org number; the global `id` stays the internal key. Existing rows keep number = id, so
-- every SaplingLearn reference (`#12` in a doc, a commit, a chat) still names the same ticket / handoff.
ALTER TABLE tickets ADD COLUMN number INTEGER;
ALTER TABLE handoffs ADD COLUMN number INTEGER;
UPDATE tickets SET number = id WHERE number IS NULL;
UPDATE handoffs SET number = id WHERE number IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_org_number ON tickets(org_id, number) WHERE number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoffs_org_number ON handoffs(org_id, number) WHERE number IS NOT NULL;

-- The counters start where AUTOINCREMENT is (sqlite_sequence remembers deleted ids too), so the next
-- SaplingLearn number is the next id — no number is ever reissued.
INSERT OR IGNORE INTO org_counters (org_id, name, value)
  SELECT 'org_saplinglearn', 'ticket', MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'tickets'), 0), COALESCE((SELECT MAX(id) FROM tickets), 0));
INSERT OR IGNORE INTO org_counters (org_id, name, value)
  SELECT 'org_saplinglearn', 'handoff', MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'handoffs'), 0), COALESCE((SELECT MAX(id) FROM handoffs), 0));

-- Allocation is the database's job, in the same statement as the insert: a row inserted without a number
-- takes its org's next one. (UPDATE OF number fires no FTS trigger — those watch title/body only.)
CREATE TRIGGER IF NOT EXISTS tickets_number_ai AFTER INSERT ON tickets WHEN new.number IS NULL BEGIN
  INSERT OR IGNORE INTO org_counters (org_id, name, value) VALUES (new.org_id, 'ticket', 0);
  UPDATE org_counters SET value = value + 1 WHERE org_id = new.org_id AND name = 'ticket';
  UPDATE tickets SET number = (SELECT value FROM org_counters WHERE org_id = new.org_id AND name = 'ticket') WHERE id = new.id;
END;
CREATE TRIGGER IF NOT EXISTS handoffs_number_ai AFTER INSERT ON handoffs WHEN new.number IS NULL BEGIN
  INSERT OR IGNORE INTO org_counters (org_id, name, value) VALUES (new.org_id, 'handoff', 0);
  UPDATE org_counters SET value = value + 1 WHERE org_id = new.org_id AND name = 'handoff';
  UPDATE handoffs SET number = (SELECT value FROM org_counters WHERE org_id = new.org_id AND name = 'handoff') WHERE id = new.id;
END;


-- ═══ 3 · Tenant rebuilds — the tables whose key must include `org_id` (Phase 2) ════════════════════════════
-- REBUILD every tenant table whose primary key or inline UNIQUE must include org_id (audit §2), so two
-- orgs can hold the same slug, the same semantic key, the same singleton.
--
-- The 0033 pattern: create `x_new`, copy every row with org_id = 'org_saplinglearn', carry the
-- AUTOINCREMENT counter (a copy alone would restart it at MAX(id) and reissue deleted ids), drop the old
-- table, rename. A child rebuilt here references its parent's `_new` name, which the rename rewrites.
-- Children that are NOT rebuilt (artifact_versions / artifact_links / artifact_upload_tokens →
-- artifact_pages(id)) keep resolving by name, because every row keeps its id.
--
-- Foreign keys are deferred for this section only and the deferral is switched OFF at its end — which is
-- also what lets the parent drops through (SQLite's deferred counter would otherwise count the dropped
-- parents). So the section does not rely on SQLite to check them: the GUARD before its end inserts the
-- violation count of every table touched here into a CHECK (count = 0) column, and any dangling reference
-- fails the whole MIGRATION — sections 1 and 2 included (D1 applies a migration file atomically — nothing
-- is left half-done).
--
-- The FTS tables and every FTS trigger are re-created in section 4; the triggers that lived on the tables
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
-- differs in case ("SaplingLearn/Sapling") can never split one event into two rows. The Phase 7 cleanup
-- drops the default.
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

-- ── guard: no dangling reference anywhere this section touched ──────────────
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


-- ═══ 4 · Tenant FTS — org-scoped search tables and triggers (Phase 2) ══════════════════════════════════════
-- Every FTS5 table gets `org_id UNINDEXED` (D9) and every FTS trigger becomes org-scoped.
--
-- org_id is the LAST column, never the first: the readers weight bm25 by column POSITION
-- (`bm25(docs_fts, 1.0, 5.0, …)`) and pick snippet columns by number (`snippet(tickets_fts, 2, …)`), so a
-- leading column would silently shift every ranking. An UNINDEXED trailing column takes the default
-- weight and contributes nothing to the match.
--
-- Why every trigger changes (audit F-1): `docs_fts` and `prompts_fts` are keyed by slug and
-- `roadmap_fts`'s plan row by the literal 'plan' — keys that are per-org now. An unscoped
-- `DELETE … WHERE slug = new.slug` would delete ANOTHER org's search row.
--
-- The indexes are rebuilt from their base tables exactly as the creating migrations did, except
-- artifacts_fts, which the repository maintains (it strips tags the SQL cannot): its rows are carried over
-- verbatim through a holding table and gain the page's org.

-- ── drop every FTS trigger (some already went with section 3's rebuilt tables) ────
DROP TRIGGER IF EXISTS docs_fts_ai;
DROP TRIGGER IF EXISTS docs_fts_au;
DROP TRIGGER IF EXISTS docs_fts_ad;
DROP TRIGGER IF EXISTS feed_fts_ai;
DROP TRIGGER IF EXISTS feed_fts_ad;
DROP TRIGGER IF EXISTS adrs_fts_ai;
DROP TRIGGER IF EXISTS adrs_fts_ad;
DROP TRIGGER IF EXISTS roadmap_fts_plan_au;
DROP TRIGGER IF EXISTS roadmap_fts_sprint_ai;
DROP TRIGGER IF EXISTS roadmap_fts_sprint_au;
DROP TRIGGER IF EXISTS roadmap_fts_sprint_ad;
DROP TRIGGER IF EXISTS tickets_fts_ai;
DROP TRIGGER IF EXISTS tickets_fts_au;
DROP TRIGGER IF EXISTS tickets_fts_ad;
DROP TRIGGER IF EXISTS prompts_fts_ai;
DROP TRIGGER IF EXISTS prompts_fts_au;
DROP TRIGGER IF EXISTS prompts_fts_ad;
DROP TRIGGER IF EXISTS prompts_fts_vai;
DROP TRIGGER IF EXISTS prompts_fts_vau;
DROP TRIGGER IF EXISTS artifacts_fts_ad;

-- ── artifacts_fts: hold the repository-written rows ──────────────────────────
DROP TABLE IF EXISTS _mt_artifacts_fts_hold;
CREATE TABLE _mt_artifacts_fts_hold (page_id TEXT, title TEXT, description TEXT, body TEXT);
INSERT INTO _mt_artifacts_fts_hold (page_id, title, description, body)
  SELECT page_id, title, description, body FROM artifacts_fts;

-- ── re-create the seven tables ───────────────────────────────────────────────
DROP TABLE IF EXISTS docs_fts;
DROP TABLE IF EXISTS feed_fts;
DROP TABLE IF EXISTS adrs_fts;
DROP TABLE IF EXISTS roadmap_fts;
DROP TABLE IF EXISTS tickets_fts;
DROP TABLE IF EXISTS prompts_fts;
DROP TABLE IF EXISTS artifacts_fts;

CREATE VIRTUAL TABLE docs_fts USING fts5(
  slug UNINDEXED, title, section UNINDEXED, body, org_id UNINDEXED, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE feed_fts USING fts5(
  feed_id UNINDEXED, summary, body, org_id UNINDEXED, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE adrs_fts USING fts5(
  adr_id UNINDEXED, title, context, decision, rationale, org_id UNINDEXED, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE roadmap_fts USING fts5(
  ref UNINDEXED, title, body, org_id UNINDEXED, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE tickets_fts USING fts5(
  ticket_id UNINDEXED, title, body, org_id UNINDEXED, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE prompts_fts USING fts5(
  slug, title, description, body, tags, org_id UNINDEXED, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE artifacts_fts USING fts5(
  page_id UNINDEXED, title, description, body, org_id UNINDEXED, tokenize = 'porter unicode61');

-- ── docs ─────────────────────────────────────────────────────────────────────
CREATE TRIGGER docs_fts_ai AFTER INSERT ON docs BEGIN
  DELETE FROM docs_fts WHERE slug = new.slug AND org_id = new.org_id;
  INSERT INTO docs_fts (slug, title, section, body, org_id) VALUES (new.slug, new.title, new.section, new.body, new.org_id);
END;
CREATE TRIGGER docs_fts_au AFTER UPDATE OF title, section, body ON docs BEGIN
  DELETE FROM docs_fts WHERE slug = new.slug AND org_id = new.org_id;
  INSERT INTO docs_fts (slug, title, section, body, org_id) VALUES (new.slug, new.title, new.section, new.body, new.org_id);
END;
CREATE TRIGGER docs_fts_ad AFTER DELETE ON docs BEGIN
  DELETE FROM docs_fts WHERE slug = old.slug AND org_id = old.org_id;
END;
INSERT INTO docs_fts (slug, title, section, body, org_id) SELECT slug, title, section, body, org_id FROM docs;

-- ── feed, adrs ───────────────────────────────────────────────────────────────
CREATE TRIGGER feed_fts_ai AFTER INSERT ON feed BEGIN
  INSERT INTO feed_fts (feed_id, summary, body, org_id) VALUES (CAST(new.id AS TEXT), new.summary, new.body, new.org_id);
END;
CREATE TRIGGER feed_fts_ad AFTER DELETE ON feed BEGIN
  DELETE FROM feed_fts WHERE feed_id = CAST(old.id AS TEXT) AND org_id = old.org_id;
END;
INSERT INTO feed_fts (feed_id, summary, body, org_id) SELECT CAST(id AS TEXT), summary, body, org_id FROM feed;

CREATE TRIGGER adrs_fts_ai AFTER INSERT ON adrs BEGIN
  INSERT INTO adrs_fts (adr_id, title, context, decision, rationale, org_id)
    VALUES (CAST(new.id AS TEXT), new.title, new.context, new.decision, new.rationale, new.org_id);
END;
CREATE TRIGGER adrs_fts_ad AFTER DELETE ON adrs BEGIN
  DELETE FROM adrs_fts WHERE adr_id = CAST(old.id AS TEXT) AND org_id = old.org_id;
END;
INSERT INTO adrs_fts (adr_id, title, context, decision, rationale, org_id)
  SELECT CAST(id AS TEXT), title, context, decision, rationale, org_id FROM adrs;

-- ── roadmap: one plan row PER ORG, plus sprints ─────────────────────────────
CREATE TRIGGER roadmap_fts_plan_au AFTER UPDATE OF narrative ON plan BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'plan' AND org_id = new.org_id;
  INSERT INTO roadmap_fts (ref, title, body, org_id)
    SELECT 'plan', 'Roadmap plan', new.narrative, new.org_id WHERE new.narrative != '';
END;
CREATE TRIGGER roadmap_fts_sprint_ai AFTER INSERT ON sprints BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'sprint:' || new.id AND org_id = new.org_id;
  INSERT INTO roadmap_fts (ref, title, body, org_id)
    VALUES ('sprint:' || new.id, new.title,
            COALESCE(new.description, '') || ' ' || COALESCE(new.summary, '') || ' ' ||
            COALESCE(new.phase, '') || ' ' || COALESCE(new.status, ''), new.org_id);
END;
CREATE TRIGGER roadmap_fts_sprint_au AFTER UPDATE OF title, description, summary, phase, status ON sprints BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'sprint:' || new.id AND org_id = new.org_id;
  INSERT INTO roadmap_fts (ref, title, body, org_id)
    VALUES ('sprint:' || new.id, new.title,
            COALESCE(new.description, '') || ' ' || COALESCE(new.summary, '') || ' ' ||
            COALESCE(new.phase, '') || ' ' || COALESCE(new.status, ''), new.org_id);
END;
CREATE TRIGGER roadmap_fts_sprint_ad AFTER DELETE ON sprints BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'sprint:' || old.id AND org_id = old.org_id;
END;
INSERT INTO roadmap_fts (ref, title, body, org_id)
  SELECT 'plan', 'Roadmap plan', narrative, org_id FROM plan WHERE narrative != '';
INSERT INTO roadmap_fts (ref, title, body, org_id)
  SELECT 'sprint:' || id, title,
         COALESCE(description, '') || ' ' || COALESCE(summary, '') || ' ' ||
         COALESCE(phase, '') || ' ' || COALESCE(status, ''), org_id
    FROM sprints;

-- ── tickets ──────────────────────────────────────────────────────────────────
CREATE TRIGGER tickets_fts_ai AFTER INSERT ON tickets BEGIN
  DELETE FROM tickets_fts WHERE ticket_id = CAST(new.id AS TEXT) AND org_id = new.org_id;
  INSERT INTO tickets_fts (ticket_id, title, body, org_id) VALUES (CAST(new.id AS TEXT), new.title, new.body, new.org_id);
END;
CREATE TRIGGER tickets_fts_au AFTER UPDATE OF title, body ON tickets BEGIN
  DELETE FROM tickets_fts WHERE ticket_id = CAST(new.id AS TEXT) AND org_id = new.org_id;
  INSERT INTO tickets_fts (ticket_id, title, body, org_id) VALUES (CAST(new.id AS TEXT), new.title, new.body, new.org_id);
END;
CREATE TRIGGER tickets_fts_ad AFTER DELETE ON tickets BEGIN
  DELETE FROM tickets_fts WHERE ticket_id = CAST(old.id AS TEXT) AND org_id = old.org_id;
END;
INSERT INTO tickets_fts (ticket_id, title, body, org_id) SELECT CAST(id AS TEXT), title, body, org_id FROM tickets;

-- ── prompts: the LATEST version, live (not soft-deleted) prompts only (0035 PART C) ──
CREATE TRIGGER prompts_fts_ai AFTER INSERT ON prompts BEGIN
  DELETE FROM prompts_fts WHERE slug = new.slug AND org_id = new.org_id;
  INSERT INTO prompts_fts (slug, title, description, body, tags, org_id)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags, p.org_id
    FROM prompts p LEFT JOIN prompt_versions v ON v.org_id = p.org_id AND v.slug = p.slug AND v.version = p.current_version
    WHERE p.org_id = new.org_id AND p.slug = new.slug AND p.deleted_at IS NULL;
END;
CREATE TRIGGER prompts_fts_au AFTER UPDATE OF slug, title, description, tags, current_version, deleted_at ON prompts BEGIN
  DELETE FROM prompts_fts WHERE slug = old.slug AND org_id = old.org_id;
  DELETE FROM prompts_fts WHERE slug = new.slug AND org_id = new.org_id;
  INSERT INTO prompts_fts (slug, title, description, body, tags, org_id)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags, p.org_id
    FROM prompts p LEFT JOIN prompt_versions v ON v.org_id = p.org_id AND v.slug = p.slug AND v.version = p.current_version
    WHERE p.org_id = new.org_id AND p.slug = new.slug AND p.deleted_at IS NULL;
END;
CREATE TRIGGER prompts_fts_ad AFTER DELETE ON prompts BEGIN
  DELETE FROM prompts_fts WHERE slug = old.slug AND org_id = old.org_id;
END;
CREATE TRIGGER prompts_fts_vai AFTER INSERT ON prompt_versions BEGIN
  DELETE FROM prompts_fts WHERE slug = new.slug AND org_id = new.org_id;
  INSERT INTO prompts_fts (slug, title, description, body, tags, org_id)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags, p.org_id
    FROM prompts p LEFT JOIN prompt_versions v ON v.org_id = p.org_id AND v.slug = p.slug AND v.version = p.current_version
    WHERE p.org_id = new.org_id AND p.slug = new.slug AND p.deleted_at IS NULL;
END;
CREATE TRIGGER prompts_fts_vau AFTER UPDATE ON prompt_versions BEGIN
  DELETE FROM prompts_fts WHERE slug = new.slug AND org_id = new.org_id;
  INSERT INTO prompts_fts (slug, title, description, body, tags, org_id)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags, p.org_id
    FROM prompts p LEFT JOIN prompt_versions v ON v.org_id = p.org_id AND v.slug = p.slug AND v.version = p.current_version
    WHERE p.org_id = new.org_id AND p.slug = new.slug AND p.deleted_at IS NULL;
END;
INSERT INTO prompts_fts (slug, title, description, body, tags, org_id)
  SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags, p.org_id
  FROM prompts p LEFT JOIN prompt_versions v ON v.org_id = p.org_id AND v.slug = p.slug AND v.version = p.current_version
  WHERE p.deleted_at IS NULL;

-- ── artifacts: the repository's rows, carried over with their page's org ─────
CREATE TRIGGER artifacts_fts_ad AFTER DELETE ON artifact_pages BEGIN
  DELETE FROM artifacts_fts WHERE page_id = CAST(old.id AS TEXT) AND org_id = old.org_id;
END;
INSERT INTO artifacts_fts (page_id, title, description, body, org_id)
  SELECT h.page_id, h.title, h.description, h.body, p.org_id
    FROM _mt_artifacts_fts_hold h JOIN artifact_pages p ON p.id = CAST(h.page_id AS INTEGER);
DROP TABLE _mt_artifacts_fts_hold;


-- ═══ 5 · Platform admins — the SUPERADMIN role (owner decision, 2026-10-06) ════════════════════════════════
--
-- One platform-wide role above every org, separate from the per-org owner / admin / member in
-- `memberships`. A table, not an env allowlist, so a handle rename carries it (persons.ts HANDLE_COLUMNS)
-- and the superadmin screens can grant and revoke it.
--
-- What it does NOT mean (canopy-multitenancy.md §5.4): no implicit access to any org's content — reading an
-- org still takes a membership. Nothing is granted here except below.

CREATE TABLE IF NOT EXISTS platform_admins (
  person     TEXT PRIMARY KEY COLLATE NOCASE REFERENCES persons(handle),
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL
);

-- The one superadmin: andres (`AndresL230` is the same person's earlier handle — whichever exists).
INSERT OR IGNORE INTO platform_admins (person, granted_at, granted_by)
  SELECT handle, '2026-10-06T00:00:00.000Z', 'migration' FROM persons WHERE lower(handle) IN ('andres', 'andresl230');


-- ═══ 6 · Platform orgs — the org + platform backend (canopy-multitenancy.md §5.3, §5.4) ════════════════════
--
-- What the superadmin's "take on an org", "suspend an org" and "usage" surfaces need. ADDITIVE only — three
-- nullable / defaulted columns and two new tables; no table is rebuilt and nothing existing changes meaning.

-- ── suspension ───────────────────────────────────────────────────────────────
-- A suspended org's members get 404 from the tenant gates and its bearer tokens stop resolving
-- (src/data/gate.ts, src/data/bearer.ts). The data is untouched; clearing the column restores everything.
ALTER TABLE orgs ADD COLUMN suspended_at TEXT;
ALTER TABLE orgs ADD COLUMN suspended_by TEXT;       -- a handle (HANDLE_COLUMNS)

-- ── the owner invite ─────────────────────────────────────────────────────────
-- `org_invites.role` allows only admin | member, and an org admin must never be able to mint an owner by
-- invite. A SUPERADMIN taking on an org for someone who has not signed in yet (or rescuing an org whose
-- owner left) sets this flag instead: accepting an `as_owner` invite makes the person an OWNER. Only
-- src/platform writes 1 here; the tenant invite route always writes the default.
ALTER TABLE org_invites ADD COLUMN as_owner INTEGER NOT NULL DEFAULT 0 CHECK (as_owner IN (0, 1));

-- ── usage metering ───────────────────────────────────────────────────────────
-- One counter per (org, UTC day, metric, person), bumped by an upsert in `waitUntil` so it never slows
-- or fails a request (src/data/meter.ts). Metrics: `api_read`, `api_write` (the gate middlewares),
-- `mcp_request`, and `mcp_tool:<name>` per MCP tool call. `actor` is a person handle — what gives
-- "distinct active people"; `last_at` is the last bump, so an org's last activity is one MAX().
-- Rows older than 400 days are pruned by the daily cron.
CREATE TABLE IF NOT EXISTS org_usage_daily (
  org_id  TEXT NOT NULL REFERENCES orgs(id),
  day     TEXT NOT NULL CHECK (length(day) = 10),     -- 'YYYY-MM-DD', UTC
  metric  TEXT NOT NULL CHECK (length(metric) BETWEEN 1 AND 80),
  actor   TEXT NOT NULL,                              -- a handle (HANDLE_COLUMNS)
  count   INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  last_at TEXT NOT NULL,
  PRIMARY KEY (org_id, day, metric, actor)
);
CREATE INDEX IF NOT EXISTS idx_org_usage_daily_day ON org_usage_daily(day);

-- ── the org-administration audit trail ───────────────────────────────────────
-- `org_audit` (section 1) is the integration-secrets trail, and its `action` CHECK admits only the five secret
-- actions; widening a CHECK takes a table rebuild, which this section does not do. Membership, invite,
-- settings, repository / environment and platform actions are therefore recorded here, in the same shape, with the action list
-- kept in code (shared/orgs.ts ORG_AUDIT_ACTIONS) so it can grow. `org_id` is NULL for a platform-level
-- action that concerns no org (a superadmin grant, a person's org limit). Never holds a secret.
CREATE TABLE IF NOT EXISTS org_admin_audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id  TEXT REFERENCES orgs(id),
  actor   TEXT NOT NULL,                              -- a handle (HANDLE_COLUMNS)
  action  TEXT NOT NULL,
  target  TEXT NOT NULL,                              -- a handle, `invite:<id>`, the org slug, a repo, an environment key
  detail  TEXT NOT NULL DEFAULT '{}',                 -- JSON
  at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_admin_audit_org ON org_admin_audit(org_id, at);
CREATE INDEX IF NOT EXISTS idx_org_admin_audit_at ON org_admin_audit(at);


-- ═══ 7 · Identity uid — a GitHub identity is pinned to the account's immutable id (Phase 4, §5.1) ══════════
--
-- Sign-in is no longer gated on membership of one GitHub org, so ANY GitHub account can now present a
-- login. `identities.subject` for GitHub is the LOGIN, and a login can be renamed away and re-registered by
-- someone else — who would then sign in as the person the old row names. This column pins a GitHub
-- identity to the account's immutable numeric id.
--
-- ADDITIVE only: one nullable column, no data change, nothing rebuilt. It is NULL for every existing row
-- and is filled at that identity's next sign-in (src/auth/onboard.ts `completeSignIn`); from then on a
-- sign-in with the same login but a DIFFERENT id is refused. A Worker from before it never reads it.
-- Google identities do not need it: their `subject` already is Google's immutable `sub`.
ALTER TABLE identities ADD COLUMN provider_uid TEXT;


-- ═══ 8 · Abuse limits (docs/architecture/abuse-limits.md) ══════════════════════════════════════════════════
--
-- Sign-in is open to any GitHub account (Phase 4), so the few actions that send mail, store bytes or answer
-- a lookup are capped per person. One counter per (subject, action, window), taken by a single guarded
-- upsert (src/platform/limits.ts) — the same pattern as `org_usage_daily` (section 6), but keyed by PERSON,
-- not by org: a person's cap must not multiply with the orgs they create.
--
-- ADDITIVE only: one new table, nothing existing changes. GLOBAL (no `org_id`) — a platform table.
-- `subject` is a person handle (carried by a rename, src/auth/persons.ts) or, for a caller who is not a
-- person yet, `onboard:<provider>:<subject>`. `bucket` is the window's UTC start: 'YYYY-MM-DD' for a daily
-- limit, 'YYYY-MM-DDTHH' for an hourly one. Rows of past windows are pruned by the daily cron.
CREATE TABLE IF NOT EXISTS abuse_counters (
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  action  TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 40),
  bucket  TEXT NOT NULL CHECK (length(bucket) IN (10, 13)),
  count   INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  last_at TEXT NOT NULL,
  PRIMARY KEY (subject, action, bucket)
);
CREATE INDEX IF NOT EXISTS idx_abuse_counters_bucket ON abuse_counters(bucket);


-- ═══ 9 · Org invite mail — the invitation e-mail's bookkeeping, on the invite itself ═══════════════════════
-- (docs/architecture/organizations.md)
--
-- `org_invites` (section 1) has no column for the invitee's NAME or the mail's delivery outcome; both lived
-- in the legacy `invites` table, a sidecar read and written for org #1 only — so no other org's invite
-- was ever mailed. `POST /api/o/:slug/invites` sends the invitation and records what happened here.
--
-- ADDITIVE only: four nullable columns, nothing existing changes, no backfill. The invites section 1
-- copied read NULL in all four ("never mailed from here"); org #1's older rows still show the
-- sidecar's values through the legacy `/invites` alias (src/orgs/legacy-invites.ts) until Phase 7.
--   name        the invitee's name as the inviter typed it (greeting only; never an identity)
--   mail_status 'sent' | 'failed' — the LAST attempt; NULL = no mail (a GitHub-login invite has no address)
--   mail_at     when that attempt was made
--   mail_error  the provider's refusal text when it failed (admin-visible)
ALTER TABLE org_invites ADD COLUMN name TEXT CHECK (name IS NULL OR length(name) <= 120);
ALTER TABLE org_invites ADD COLUMN mail_status TEXT CHECK (mail_status IS NULL OR mail_status IN ('sent', 'failed'));
ALTER TABLE org_invites ADD COLUMN mail_at TEXT;
ALTER TABLE org_invites ADD COLUMN mail_error TEXT;


-- ═══ 10 · Org logo — an organization's image ═══════════════════════════════════════════════════════════════
-- (docs/architecture/organizations.md › The organization's image)
--
-- Without it, everywhere an org is shown the SPA draws a square with the first letter of its name. The
-- image is the person photo's sibling (0036): bytes in R2, content-addressed (`org-logos/<sha256>`), served
-- by the session-gated `GET /org-logo/<sha>`; these columns say WHICH image an org shows and where it came
-- from.
--
-- ADDITIVE only: five nullable columns on `orgs`, nothing existing changes, no backfill. Every org reads
-- NULL in all five ("no image": the initial tile) until an admin uploads one or the periodic GitHub
-- reconcile imports its primary repository owner's avatar.
--   logo_sha     SHA-256 of the image shown now; NULL = none
--   logo_source  'upload' (an admin's) | 'github' (imported). THE rule (src/orgs/logo.ts): an import
--                writes only while this is NULL or 'github' — an uploaded image is never replaced by it
--   logo_by      the person who uploaded it (a handle: `HANDLE_COLUMNS`); NULL for an import
--   logo_from    the GitHub login the image was imported from (the primary repo's owner); NULL for an upload
--   logo_at      when it was uploaded / last imported
ALTER TABLE orgs ADD COLUMN logo_sha TEXT CHECK (logo_sha IS NULL OR length(logo_sha) = 64);
ALTER TABLE orgs ADD COLUMN logo_source TEXT CHECK (logo_source IS NULL OR logo_source IN ('upload', 'github'));
ALTER TABLE orgs ADD COLUMN logo_by TEXT;
ALTER TABLE orgs ADD COLUMN logo_from TEXT;
ALTER TABLE orgs ADD COLUMN logo_at TEXT;
