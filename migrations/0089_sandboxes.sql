-- 0089_sandboxes: Sandboxes (docs/architecture/sandboxes.md). An organization a superadmin has given a `sandboxes`
-- limit (shared/plans.ts — 0 on every plan, set per org in Platform) can create Daytona sandboxes from its agents
-- over MCP. The VMs live in Daytona and are driven by the trov-sandbox Worker (the `SANDBOX` Service Binding), which
-- holds the Daytona key; Trov keeps only which sandbox belongs to which org and who made it. ADDITIVE:
--   · org_sandboxes — one row per sandbox created through Trov. `sandbox_id` is Daytona's id. `deleted_at` is set
--     when someone deletes it (`deleted_by`, a handle) or when Daytona no longer has it (`deleted_by` NULL: it
--     auto-deleted). A live row (deleted_at IS NULL) counts toward the `sandboxes` limit.
--     `created_by` / `deleted_by` are handles (HANDLE_COLUMNS).
-- Rollback by hand:
--   DROP TABLE org_sandboxes;
-- then DELETE FROM d1_migrations WHERE name = '0089_sandboxes.sql'.
CREATE TABLE IF NOT EXISTS org_sandboxes (
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  sandbox_id  TEXT NOT NULL CHECK (length(sandbox_id) BETWEEN 1 AND 128),
  created_by  TEXT NOT NULL COLLATE NOCASE,
  created_at  TEXT NOT NULL,
  deleted_at  TEXT,
  deleted_by  TEXT COLLATE NOCASE,
  PRIMARY KEY (org_id, sandbox_id)
);
CREATE INDEX IF NOT EXISTS idx_org_sandboxes_live ON org_sandboxes (org_id, deleted_at);
