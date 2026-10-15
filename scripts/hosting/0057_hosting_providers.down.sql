-- Rollback of migrations/0056_hosting_providers.sql. Run it BEFORE scripts/mt/rollback/0042_organizations.down.sql.
-- The hosting tables go; org_secrets is rebuilt back to the five kinds 0042 admitted, and any hosting
-- credential stored since 0056 is DROPPED with it (their parts and connections go too — nothing reads them).
-- Section 6 first: the five org_environments columns come back, filled from the Cloudflare / Railway parts
-- (the first of each per environment — the columns hold one), and the metric history gets its old names.
ALTER TABLE org_environments ADD COLUMN railway_env TEXT NOT NULL DEFAULT '';
ALTER TABLE org_environments ADD COLUMN worker TEXT NOT NULL DEFAULT '';
ALTER TABLE org_environments ADD COLUMN worker_check TEXT NOT NULL DEFAULT '';
ALTER TABLE org_environments ADD COLUMN railway_environment_id TEXT;
ALTER TABLE org_environments ADD COLUMN railway_service_id TEXT;
UPDATE org_environments SET worker = COALESCE((SELECT json_extract(p.settings, '$.worker') FROM org_environment_parts p
  WHERE p.org_id = org_environments.org_id AND p.env_key = org_environments.key AND p.provider = 'cloudflare' ORDER BY p.position LIMIT 1), '');
UPDATE org_environments SET
  railway_environment_id = (SELECT NULLIF(json_extract(p.settings, '$.environment_id'), '') FROM org_environment_parts p
    WHERE p.org_id = org_environments.org_id AND p.env_key = org_environments.key AND p.provider = 'railway' ORDER BY p.position LIMIT 1),
  railway_service_id = (SELECT NULLIF(json_extract(p.settings, '$.service_id'), '') FROM org_environment_parts p
    WHERE p.org_id = org_environments.org_id AND p.env_key = org_environments.key AND p.provider = 'railway' ORDER BY p.position LIMIT 1);
UPDATE OR IGNORE repo_metrics SET metric = 'cf_requests' WHERE metric = 'hx_requests' AND part = 'frontend';
UPDATE OR IGNORE repo_metrics SET metric = 'cf_errors' WHERE metric = 'hx_errors' AND part = 'frontend';
UPDATE OR IGNORE repo_metrics SET metric = 'rw_cpu' WHERE metric = 'hx_cpu' AND part = 'backend';
UPDATE OR IGNORE repo_metrics SET metric = 'rw_mem_mb' WHERE metric = 'hx_mem_mb' AND part = 'backend';
-- (`railway_env` and `worker_check` — the GitHub matching names — are not kept by parts: set them again under
-- Environments after a rollback.)

DROP TABLE IF EXISTS hosting_poll_state;
DROP TABLE IF EXISTS hosting_deploys;
DROP TABLE IF EXISTS org_hosting_connections;
DROP TABLE IF EXISTS org_environment_parts;
DELETE FROM repo_metrics WHERE metric GLOB 'hx_*';

PRAGMA defer_foreign_keys = true;
CREATE TABLE org_secrets_old (
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
INSERT INTO org_secrets_old (org_id, kind, scope, ciphertext, iv, key_version, hint_last4, created_by, created_at, rotated_at, last_used_at, last_error)
  SELECT org_id, kind, scope, ciphertext, iv, key_version, hint_last4, created_by, created_at, rotated_at, last_used_at, last_error
  FROM org_secrets WHERE kind IN ('cloudflare_analytics','railway','metrics_endpoint','github_token','github_webhook');
DROP TABLE org_secrets;
ALTER TABLE org_secrets_old RENAME TO org_secrets;
PRAGMA defer_foreign_keys = false;

DELETE FROM d1_migrations WHERE name = '0056_hosting_providers.sql';
