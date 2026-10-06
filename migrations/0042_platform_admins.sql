-- The SUPERADMIN role (owner decision, 2026-10-06): one platform-wide role above every org, separate from
-- the per-org owner / admin / member in `memberships`. A table, not an env allowlist, so a handle rename
-- carries it (persons.ts HANDLE_COLUMNS) and the superadmin screens can grant and revoke it later.
--
-- What it does NOT mean (canopy-multitenancy.md §5.4): no implicit access to any org's content — reading an
-- org still takes a membership. No route reads or writes this table yet; nothing is granted except below.
CREATE TABLE IF NOT EXISTS platform_admins (
  person     TEXT PRIMARY KEY COLLATE NOCASE REFERENCES persons(handle),
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL
);

-- The one superadmin: andres (`AndresL230` is the same person's earlier handle — whichever exists).
INSERT OR IGNORE INTO platform_admins (person, granted_at, granted_by)
  SELECT handle, '2026-10-06T00:00:00.000Z', 'migration' FROM persons WHERE lower(handle) IN ('andres', 'andresl230');
