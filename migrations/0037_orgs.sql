-- Multitenancy (canopy-multitenancy.md, Phase 2) — part 1 of 4: the platform tables, and SaplingLearn
-- as org #1.
--
-- Everything here is additive: new tables, two nullable person/identity columns, and seed rows built
-- from data already in D1. No tenant table changes shape until 0038. Re-running is harmless (IF NOT
-- EXISTS / INSERT OR IGNORE / deterministic ids) — the d1_migrations ledger never re-applies a file
-- anyway (§3.3).
--
-- The legacy org id `org_saplinglearn` is the transitional DEFAULT of every tenant `org_id` column
-- (0038–0039, §3.2): until the queries are ported (Phase 3) an INSERT that names no org lands here.
-- 0041 (Phase 7) removes those defaults.

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
-- ticket's number is never reissued. Advanced by the tickets/handoffs AFTER INSERT triggers (0038).
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
-- move onto the membership (Q9 — the person columns stay, unread, until 0041).
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
INSERT INTO org_invites (org_id, email, role, invited_by, status, created_at, responded_at, responded_by)
  SELECT 'org_saplinglearn', lower(email), 'member', invited_by,
         CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN accepted_by IS NOT NULL THEN 'accepted' ELSE 'pending' END,
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
