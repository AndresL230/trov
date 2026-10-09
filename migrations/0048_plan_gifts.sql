-- 0048_plan_gifts: a plan given for free UNTIL A DATE (docs/architecture/plans.md › Gifts). A superadmin
-- puts an org on Pro or Enterprise with an end; when the end passes the org moves to Free by itself
-- (src/plans/gifts.ts `expireGifts`, run by the repo cron's every tick), nothing deleted. A grant can
-- carry the same thing as a LENGTH: the clock starts when the grantee creates the organization.
--
-- ADDITIVE ONLY — two nullable columns and one partial index. Nothing existing changes, no row is
-- rewritten, and a Worker from before it keeps working (it reads and writes none of this). NULL is "no
-- gift": every org and grant that exists today is exactly as it was, and a plan set by hand still lasts
-- until someone changes it.
--
--   orgs.plan_gift_until   the instant the gifted plan ends (ISO-8601, UTC, always `toISOString()` so it
--                          compares as text); NULL = the plan is not a gift
--   org_grants.gift_days   the org this grant becomes is free for this many days from its creation
--
-- Who gave a gift, and when, is the audit trail's (`org_admin_audit`: `plan.gift`, `plan.gift_end`) and
-- the grant's own `granted_by` — there is no second handle column to keep in step with a rename.
--
-- ROLLBACK (by hand; nothing else depends on these). Without the column nothing ends a gifted plan, so
-- the orgs that hold one simply keep it until someone changes it.
--   DROP INDEX IF EXISTS idx_orgs_plan_gift;
--   ALTER TABLE orgs DROP COLUMN plan_gift_until;
--   ALTER TABLE org_grants DROP COLUMN gift_days;
--   DELETE FROM d1_migrations WHERE name = '0048_plan_gifts.sql';
-- together with `wrangler rollback` to the Worker from before it.
ALTER TABLE orgs ADD COLUMN plan_gift_until TEXT;
ALTER TABLE org_grants ADD COLUMN gift_days INTEGER CHECK (gift_days IS NULL OR gift_days > 0);

-- What the expiry reads every tick: the few orgs that hold a gift, by its end.
CREATE INDEX IF NOT EXISTS idx_orgs_plan_gift ON orgs(plan_gift_until) WHERE plan_gift_until IS NOT NULL;
