-- Billing: paying for a plan through Stripe (docs/architecture/billing.md).
--
-- ADDITIVE ONLY — three `CREATE TABLE IF NOT EXISTS` and their indexes. No column is added to a table that
-- exists: the org's side of billing is the columns 0044_plans reserved (`orgs.plan_source`, `plan_status`,
-- `plan_period_end`, `billing_customer_id`, `billing_subscription_id`) and `org_grants.external_ref`, which
-- for a paid grant is the Stripe SUBSCRIPTION id — the key of `billing_subscriptions` below, where the
-- customer id waits until the buyer names their organization. Safe on live data; a Worker from before it
-- reads none of this.
--
--    1 · billing_events          every Stripe event id, once (a replay is a no-op)
--    2 · billing_checkouts       a Checkout Session Trov started, bound to the person who started it
--    3 · billing_subscriptions   what Stripe last said about each subscription: ids, plan, status, period
--
-- All three are GLOBAL platform tables (no `org_id` column — test/data-layer.static.test.ts derives tenancy
-- from that column): a purchase happens before any org exists. `billing_checkouts.for_org` is deliberately
-- not named `org_id`. Nothing here holds an amount, a card, an address or a key: Stripe has those.
--
-- ROLLBACK (by hand; nothing else depends on these):
--   DROP TABLE IF EXISTS billing_subscriptions;   -- loses "cancels at the period's end" and the superadmin's pin
--   DROP TABLE IF EXISTS billing_checkouts;
--   DROP TABLE IF EXISTS billing_events;
--   DELETE FROM d1_migrations WHERE name = '0045_billing.sql';
-- together with `wrangler rollback` to the Worker from before it. Orgs keep the plan they are on (the
-- columns are 0044's); nothing moves them any more, so a subscription that ends in Stripe no longer ends
-- here — change those orgs by hand in Platform. Stripe itself is untouched: cancel subscriptions there.


-- ═══ 1 · billing_events: each Stripe event, once ═══════════════════════════════════════════════════════════
-- Written when a VERIFIED delivery arrives; `processed_at` is set when its handler finished. A delivery
-- whose id is here with `processed_at` set is acknowledged and does nothing; one whose handler failed
-- (`processed_at` NULL) is run again when Stripe retries — every handler converges, so twice is once.
CREATE TABLE IF NOT EXISTS billing_events (
  event_id      TEXT PRIMARY KEY,                      -- Stripe's `evt_…`
  type          TEXT NOT NULL,                         -- 'checkout.session.completed', …
  livemode      INTEGER NOT NULL DEFAULT 0,
  received_at   TEXT NOT NULL,
  processed_at  TEXT,
  outcome       TEXT                                   -- one short word from the handler; never a payload
);
CREATE INDEX IF NOT EXISTS idx_billing_events_received ON billing_events(received_at);


-- ═══ 2 · billing_checkouts: a purchase someone started ═════════════════════════════════════════════════════
-- One row per Checkout Session Trov created. `person` is who was signed in when it was created — the ONLY
-- person its payment can ever grant an organization to: the webhook and the waiting room look the session
-- up here, never the other way round, so a session id in someone else's hands claims nothing.
-- `for_org` is set when an owner renews a CANCELED organization: the payment goes to that org, not a grant.
CREATE TABLE IF NOT EXISTS billing_checkouts (
  ref              TEXT PRIMARY KEY,                   -- Trov's own random reference (also the Stripe idempotency key)
  person           TEXT NOT NULL COLLATE NOCASE,       -- a handle (HANDLE_COLUMNS)
  plan             TEXT NOT NULL,                      -- shared/plans.ts PlanId
  interval         TEXT NOT NULL DEFAULT 'month',      -- 'month' | 'year'
  for_org          TEXT REFERENCES orgs(id),           -- a renewal's org (not named `org_id`: this is not an org's row)
  session_id       TEXT,                               -- Stripe's `cs_…`, once Stripe has answered
  subscription_id  TEXT,                               -- Stripe's `sub_…`, once the session completed
  created_at       TEXT NOT NULL,
  completed_at     TEXT,
  checked_at       TEXT                                -- the waiting room's last look at Stripe (it is throttled)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_checkouts_session ON billing_checkouts(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_billing_checkouts_person ON billing_checkouts(person, created_at);


-- ═══ 3 · billing_subscriptions: Stripe's last word on each subscription ════════════════════════════════════
-- Trov's mirror of a subscription, rewritten from Stripe's CURRENT state on every event about it (the
-- handler re-reads the subscription; it never trusts an event's order). It is what links a paid grant to
-- its payment (`org_grants.external_ref` = `subscription_id`) and, once the grant is used, what the org's
-- billing columns are copied from in the batch that creates the org (src/plans/grants.ts).
--
-- `plan` / `plan_status` are Trov's reading of it (the price → a plan; Stripe's status → active /
-- past_due / canceled). `plan_pinned` = a superadmin set this org's plan by hand: events still move its
-- status and period, never its plan, until the superadmin lets it follow the subscription again.
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  subscription_id       TEXT PRIMARY KEY,              -- Stripe's `sub_…`
  customer_id           TEXT NOT NULL,                 -- Stripe's `cus_…`
  person                TEXT COLLATE NOCASE,           -- who bought it: a handle (HANDLE_COLUMNS)
  plan                  TEXT NOT NULL,                 -- shared/plans.ts PlanId
  price_id              TEXT,
  interval              TEXT,                          -- 'month' | 'year'
  stripe_status         TEXT NOT NULL,                 -- Stripe's own word: active, past_due, canceled, …
  plan_status           TEXT NOT NULL DEFAULT 'active',-- shared/plans.ts PlanStatus
  period_end            TEXT,                          -- the paid period's end, ISO-8601
  cancel_at_period_end  INTEGER NOT NULL DEFAULT 0,
  livemode              INTEGER NOT NULL DEFAULT 0,    -- which Stripe dashboard the customer is in
  plan_pinned           INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_customer ON billing_subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_person ON billing_subscriptions(person);
