-- Rollback of migrations/0044_hosting_providers.sql. Run it BEFORE scripts/mt/rollback/0042_organizations.down.sql.
-- The hosting tables go; org_secrets is rebuilt back to the five kinds 0042 admitted, and any hosting
-- credential stored since 0043 is DROPPED with it (their parts and connections go too — nothing reads them).
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

DELETE FROM d1_migrations WHERE name = '0044_hosting_providers.sql';
