-- The org + platform backend (canopy-multitenancy.md §5.3, §5.4): what the superadmin's "take on an org",
-- "suspend an org" and "usage" surfaces need. ADDITIVE only — three nullable / defaulted columns and two new
-- tables; no table is rebuilt and nothing existing changes meaning. (The Phase 7 cleanup that had reserved
-- this number — dropping the transitional `org_id` defaults — takes a later one.)

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
-- `org_audit` (0037) is the integration-secrets trail, and its `action` CHECK admits only the five secret
-- actions; widening a CHECK takes a table rebuild, which this migration does not do. Membership, invite,
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
