-- Plans (tiers), grants and the columns billing will need (docs/architecture/plans.md).
--
-- ADDITIVE ONLY — `ADD COLUMN` and `CREATE TABLE IF NOT EXISTS`, plus one backfill UPDATE over `orgs`.
-- Nothing is rebuilt, dropped or renamed, so it is safe on live data and a Worker from before it keeps
-- working (it reads none of this). The plans themselves and every number are in CODE (shared/plans.ts),
-- not here: a plan id is not a CHECK, so a plan can be added without a table rebuild.
--
--    1 · orgs            the org's plan, its per-org limit overrides, and the billing columns (unused)
--    2 · org_grants      "this person may set up ONE organization on this plan"
--    3 · platform mail   where LOCAL mode keeps a mail that belongs to no org (the grant notice)
--
-- Both new tables are GLOBAL platform tables (no `org_id` column — test/data-layer.static.test.ts derives
-- tenancy from that column): a grant is about a person, before any org exists.
--
-- ROLLBACK (by hand; nothing else depends on these):
--   DROP TABLE IF EXISTS platform_outbox_bodies;
--   DROP TABLE IF EXISTS org_grants;                       -- loses every grant, used or not
--   ALTER TABLE orgs DROP COLUMN plan;                     -- …and the eight columns below, one statement each:
--     plan_overrides, plan_source, plan_status, plan_period_end, billing_customer_id,
--     billing_subscription_id, plan_changed_at, plan_changed_by
--   DELETE FROM d1_migrations WHERE name = '0044_plans.sql';
-- together with `wrangler rollback` to the Worker from before it. Every org is then unlimited again, as
-- before plans. (`scripts/mt/rollback/0042_organizations.down.sql` predates this file: run the lines
-- above first if both are ever rolled back.)


-- ═══ 1 · orgs: the plan ════════════════════════════════════════════════════════════════════════════════════
-- `plan` is a shared/plans.ts PlanId. The column default is the SMALLEST plan (fail closed): an org row
-- written by anything that does not name a plan gets `personal`. `createOrg` always names one.
ALTER TABLE orgs ADD COLUMN plan TEXT NOT NULL DEFAULT 'personal';
-- Per-org exceptions as JSON, `{ "<limit>": <whole number> | null }` (null = unlimited). A key that is
-- absent means "the plan's own value". How an Enterprise org is sized, and an exception on any plan.
ALTER TABLE orgs ADD COLUMN plan_overrides TEXT NOT NULL DEFAULT '{}';
-- Who put the org on this plan: 'granted' (the superadmin, directly or through a grant) | 'billing'.
ALTER TABLE orgs ADD COLUMN plan_source TEXT;
-- 'active' | 'past_due' | 'canceled'. Only 'canceled' changes behaviour today (additions are refused).
ALTER TABLE orgs ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'active';
-- RESERVED FOR BILLING — written by nothing yet (src/plans/state.ts `setOrgPlan` accepts them):
ALTER TABLE orgs ADD COLUMN plan_period_end TEXT;           -- the paid period's end, ISO-8601
ALTER TABLE orgs ADD COLUMN billing_customer_id TEXT;       -- the payment provider's customer, opaque
ALTER TABLE orgs ADD COLUMN billing_subscription_id TEXT;   -- the payment provider's subscription, opaque
ALTER TABLE orgs ADD COLUMN plan_changed_at TEXT;
ALTER TABLE orgs ADD COLUMN plan_changed_by TEXT;           -- a handle (HANDLE_COLUMNS), or 'migration' / 'billing'

-- Every org that exists today keeps working exactly as it did: Enterprise, whose seats are unlimited
-- and whose repository / environment limits are the caps from before plans (10 each).
UPDATE orgs SET plan = 'enterprise', plan_source = 'granted', plan_changed_at = '2026-10-07T00:00:00.000Z', plan_changed_by = 'migration';


-- ═══ 2 · org_grants: the right to set up one organization ══════════════════════════════════════════════════
-- A superadmin (later: billing) names a person and a plan; that person creates the org themselves
-- (POST /api/orgs), which CONSUMES the grant — one grant, one org. The grantee need not have an account:
-- a grant is matched at sign-in the way an invitation is (src/orgs/repo.ts `MINE`): `person` to the
-- handle, `github_login` to one of the person's GitHub identities, `email` to a provider-VERIFIED
-- address — never to the editable `persons.email`.
--
-- `status` holds only what was DONE to the grant; "expired" is derived (unused and past `expires_at`).
-- The CHECK on it is also the consume guard: creating the org sets `status` to 'used' when the grant is
-- usable and to a value this CHECK refuses when it is not, which aborts the whole creating batch
-- (src/plans/grants.ts `consumeStmt`, which recognises the failure by the constraint's NAME). Do not
-- widen or rename it without reading that.
CREATE TABLE IF NOT EXISTS org_grants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  person        TEXT COLLATE NOCASE,                   -- a handle (HANDLE_COLUMNS)
  github_login  TEXT COLLATE NOCASE,
  email         TEXT COLLATE NOCASE,
  plan          TEXT NOT NULL,                         -- shared/plans.ts PlanId
  overrides     TEXT NOT NULL DEFAULT '{}',            -- as orgs.plan_overrides; copied onto the org
  note          TEXT,
  source        TEXT NOT NULL DEFAULT 'granted',       -- 'granted' | 'billing' — becomes orgs.plan_source
  external_ref  TEXT,                                  -- RESERVED FOR BILLING: the payment's opaque id (idempotency)
  granted_by    TEXT NOT NULL,                         -- a handle (HANDLE_COLUMNS), or 'billing'
  created_at    TEXT NOT NULL,
  expires_at    TEXT,
  status        TEXT NOT NULL DEFAULT 'unused' CONSTRAINT org_grant_usable CHECK (status IN ('unused', 'used', 'revoked')),
  used_at       TEXT,
  used_by       TEXT,                                  -- a handle (HANDLE_COLUMNS)
  used_org      TEXT REFERENCES orgs(id),              -- the org it became (not named `org_id`: this is not an org's row)
  revoked_at    TEXT,
  revoked_by    TEXT,                                  -- a handle (HANDLE_COLUMNS)
  mail_status   TEXT CHECK (mail_status IS NULL OR mail_status IN ('sent', 'failed')),
  mail_at       TEXT,
  mail_error    TEXT,
  CHECK ((person IS NOT NULL) + (github_login IS NOT NULL) + (email IS NOT NULL) = 1)
);
CREATE INDEX IF NOT EXISTS idx_org_grants_person ON org_grants(person, status);
CREATE INDEX IF NOT EXISTS idx_org_grants_login ON org_grants(github_login, status);
CREATE INDEX IF NOT EXISTS idx_org_grants_email ON org_grants(email, status);
-- One grant per payment: a billing event delivered twice creates one grant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_grants_external_ref ON org_grants(external_ref) WHERE external_ref IS NOT NULL;


-- ═══ 3 · platform mail in local mode ═══════════════════════════════════════════════════════════════════════
-- `notification_outbox_bodies` is per org; a grant notice is sent before any org exists. With
-- NOTIFICATIONS_MODE = "local" (production today) a platform mail is written here instead of leaving.
CREATE TABLE IF NOT EXISTS platform_outbox_bodies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL,
  to_address      TEXT NOT NULL,
  subject         TEXT NOT NULL,
  html            TEXT NOT NULL,
  text            TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
