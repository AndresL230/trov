-- Abuse limits (docs/architecture/abuse-limits.md): sign-in is open to any GitHub account (Phase 4), so the
-- few actions that send mail, store bytes or answer a lookup are capped per person. One counter per
-- (subject, action, window), taken by a single guarded upsert (src/platform/limits.ts) — the same pattern as
-- `org_usage_daily` (0043), but keyed by PERSON, not by org: a person's cap must not multiply with the
-- orgs they create.
--
-- ADDITIVE only: one new table, nothing existing changes. GLOBAL (no `org_id`) — a platform table.
-- `subject` is a person handle (carried by a rename, src/auth/persons.ts) or, for a caller who is not a
-- person yet, `onboard:<provider>:<subject>`. `bucket` is the window's UTC start: 'YYYY-MM-DD' for a daily
-- limit, 'YYYY-MM-DDTHH' for an hourly one. Rows of past windows are pruned by the daily cron.
CREATE TABLE IF NOT EXISTS abuse_counters (
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  action  TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 40),
  bucket  TEXT NOT NULL CHECK (length(bucket) IN (10, 13)),
  count   INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  last_at TEXT NOT NULL,
  PRIMARY KEY (subject, action, bucket)
);
CREATE INDEX IF NOT EXISTS idx_abuse_counters_bucket ON abuse_counters(bucket);
