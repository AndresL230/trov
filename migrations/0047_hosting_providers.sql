-- 0047_hosting_providers — hosting providers behind one interface (issues #97–#102).
--
-- Additive apart from section 1. Nothing here touches an existing row's meaning: an environment's
-- Cloudflare frontend and Railway backend stay in `org_environments`' own columns (the LEGACY parts,
-- src/hosting/parts.ts), so SaplingLearn's dashboard reads exactly what it read before. What is new:
--
--   1. org_secrets              REBUILT (create *_new, copy, drop, rename — SQLite cannot ALTER a CHECK, the
--                               0033 pattern) only to admit the five hosting kinds in its `kind` CHECK.
--   2. org_environment_parts    the parts of an environment on a NON-legacy provider (web / service).
--   3. org_hosting_connections  how an org is connected to a provider when it is MORE than a pasted token:
--                               an installed integration or an OAuth grant (its provider-side id, account,
--                               revocation). A pasted token needs no row here: its `org_secrets` row is it.
--                               AN INSTALLATION BELONGS TO AT MOST ONE ORG — a partial unique index over the
--                               ACTIVE rows that carry an installation id (the GitHub App's rule, 0043).
--   4. hosting_deploys          deploys a provider reported, normalised, upserted by (org, env, part,
--                               provider, deploy id) — a deploy's state moves (building → ready), so this is
--                               a computed upsert, not first-write-wins.
--   5. hosting_poll_state       the last poll of each part: outcome, the interval covered (no point inside
--                               it = a true zero), the metrics the provider could not read and why.
--
-- Normalised metric POINTS need no table: they are `repo_metrics` rows named `hx_<metric>` (env = the
-- environment key, part = the part key), pruned with the other hourly usage metrics (src/repo/store.ts).
-- Rollback: scripts/hosting/0047_hosting_providers.down.sql (run it BEFORE 0042's own rollback).

-- ── 1. org_secrets: the kind CHECK admits the hosting providers ──────────────
PRAGMA defer_foreign_keys = true;

CREATE TABLE org_secrets_new (
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  kind          TEXT NOT NULL CHECK (kind IN ('cloudflare_analytics','railway','metrics_endpoint','github_token','github_webhook',
                                              'vercel','render','netlify','fly','aws')),
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
INSERT INTO org_secrets_new (org_id, kind, scope, ciphertext, iv, key_version, hint_last4, created_by, created_at, rotated_at, last_used_at, last_error)
  SELECT org_id, kind, scope, ciphertext, iv, key_version, hint_last4, created_by, created_at, rotated_at, last_used_at, last_error FROM org_secrets;
DROP TABLE org_secrets;
ALTER TABLE org_secrets_new RENAME TO org_secrets;

PRAGMA defer_foreign_keys = false;

-- ── 2. parts ─────────────────────────────────────────────────────────────────
-- `provider` is deliberately NOT CHECKed (like org_integration_config.kind): the registry in code
-- (src/hosting/registry.ts) is the vocabulary, so a provider is added without a rebuild. The two legacy
-- providers never have a row here — `putPart` refuses them (they are the environment's own columns).
CREATE TABLE IF NOT EXISTS org_environment_parts (
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  env_key     TEXT NOT NULL,
  part_key    TEXT NOT NULL CHECK (length(part_key) BETWEEN 1 AND 32 AND part_key NOT GLOB '*[^a-z0-9_-]*'),
  position    INTEGER NOT NULL,
  label       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('web','service')),
  provider    TEXT NOT NULL,
  settings    TEXT NOT NULL DEFAULT '{}',          -- JSON object of strings, validated against the provider's part_settings
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,                       -- a handle (HANDLE_COLUMNS)
  PRIMARY KEY (org_id, env_key, part_key),
  FOREIGN KEY (org_id, env_key) REFERENCES org_environments(org_id, key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_org_environment_parts_provider ON org_environment_parts(org_id, provider);

-- ── 3. connections (install / OAuth) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_hosting_connections (
  org_id         TEXT NOT NULL REFERENCES orgs(id),
  provider       TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT '',
  method         TEXT NOT NULL CHECK (method IN ('install','oauth','token','assume_role')),
  external_id    TEXT,                             -- the provider's installation id (Vercel's configurationId)
  account_id     TEXT,                             -- the provider-side team / user the grant reaches
  account_label  TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  connected_by   TEXT NOT NULL,                    -- a handle (HANDLE_COLUMNS)
  connected_at   TEXT NOT NULL,
  revoked_at     TEXT,
  revoked_by     TEXT,                             -- a handle (HANDLE_COLUMNS), or 'system' (a reserved handle) when the
                                                   -- provider's side ended it — never a provider id
  -- A CODE, never a sentence (the DTO derives the words, shared/hosting.ts `hostingRevokedReasonText`):
  -- disconnected (in Trov) · uninstalled (on the provider) · superseded (by a pasted token) · refused (a 401 at Test connection).
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR revoked_reason IN ('disconnected','uninstalled','superseded','refused')),
  PRIMARY KEY (org_id, provider, scope)
);
-- One org per installation: a provider-side installation id is held by at most ONE active connection, across
-- every org (an ended row, or a grant with no installation id — Netlify's — never conflicts). The connect
-- callback checks it first (src/platform/jobs.ts `connectionsForExternalId`) and a lost race lands here, as a
-- UNIQUE violation the callback answers `taken`. It also serves the uninstall notice's lookup by installation
-- id (`provider = ? AND external_id = ? AND status = 'active'` implies the index's WHERE).
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_hosting_connections_installation ON org_hosting_connections(provider, external_id)
  WHERE status = 'active' AND external_id IS NOT NULL;

-- ── 4. deploys ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hosting_deploys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  env          TEXT NOT NULL,
  part         TEXT NOT NULL,
  provider     TEXT NOT NULL,
  deploy_id    TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('queued','building','ready','error','canceled')),
  target       TEXT CHECK (target IS NULL OR target IN ('production','preview')),
  sha          TEXT,
  branch       TEXT,
  message      TEXT,
  actor        TEXT,
  url          TEXT,
  inspect_url  TEXT,
  created_at   TEXT NOT NULL,                      -- the provider's own creation instant
  ready_at     TEXT,
  recorded_at  TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (org_id, env, part, provider, deploy_id)
);
CREATE INDEX IF NOT EXISTS idx_hosting_deploys_part ON hosting_deploys(org_id, env, part, created_at);

-- ── 5. poll state ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hosting_poll_state (
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  env          TEXT NOT NULL,
  part         TEXT NOT NULL,
  provider     TEXT NOT NULL,
  polled_at    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('ok','failed','skipped')),
  detail       TEXT,                               -- scrubbed, ≤ 300 characters
  last_ok_at   TEXT,
  covered_from TEXT,                               -- the contiguous covered interval [from, to)
  covered_to   TEXT,
  unavailable  TEXT NOT NULL DEFAULT '[]',         -- JSON [{ metric, reason }]
  PRIMARY KEY (org_id, env, part)
);
