-- 0067_digest_email: the shorter e-mail, led by the brief (docs/architecture/notifications.md › The digest's shape;
-- docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase E). The base doc reserved this number as
-- `0067_notify_only_when_needed`; it also carries the weekly "This week" highlights, the one other row Phase E stores.
-- ADDITIVE ONLY: two new TENANT tables; nothing existing changes, no row is rewritten, and a Worker from before it
-- keeps working (it names neither).
--
-- PART 1 — notification_person_prefs: a member's e-mail options in one organization that are not a kind's cadence.
-- Today one: "Only when something needs me" (Settings › Email notifications). With it ON, a digest is sent only
-- when the person's brief has a "Next" item (with the AI off: an assigned ticket), or a notable or breaking item
-- touched their work in the window; otherwise the run marks their outbox row `skipped`. No row = OFF.
--   user_id           the member (HANDLE_COLUMNS: a rename rewrites it; an account deletion deletes the person's rows
--                     in every org — src/deletion/person.ts; an org's deletion deletes the org's — ORG_TABLES)
--   only_when_needed  0 / 1
--   updated_at        when the person last changed it
--
-- PART 2 — digest_highlights: the weekly digest's "This week" — at most 3 cited highlights per organization per week,
-- written by the AI pass's `digest.week` job (src/ai/week.ts) through the Message Batches API: ONE request per org
-- per week, shared by every member's weekly e-mail. A computed, DIRECT write (invariant 1); the e-mail reads it
-- (src/notifications/renderers/week-recap.ts) and never calls a model. The last 8 weeks are kept.
--   week_id         the weekly run's window id (`YYYY-Www`, src/notifications/window.ts)
--   generated_at    when the pass wrote it
--   model           the model that wrote it
--   prompt_version  the job's prompt version (`week.1`)
--   highlights_json `[{ text, cites }]` — the server-built cites (shared/ai-core.ts `AiLine`). Checked on every read.
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). It LOSES every member's "only when
-- something needs me" choice (they get every digest again) and the stored highlights (the weekly e-mail then has no
-- "This week" until the next week's are written):
--   DROP TABLE IF EXISTS notification_person_prefs;
--   DROP TABLE IF EXISTS digest_highlights;
--   DELETE FROM d1_migrations WHERE name = '0067_digest_email.sql';
CREATE TABLE IF NOT EXISTS notification_person_prefs (
  org_id            TEXT NOT NULL REFERENCES orgs(id),
  user_id           TEXT NOT NULL,
  only_when_needed  INTEGER NOT NULL DEFAULT 0 CHECK (only_when_needed IN (0, 1)),
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS digest_highlights (
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  week_id          TEXT NOT NULL,
  generated_at     TEXT NOT NULL,
  model            TEXT NOT NULL,
  prompt_version   TEXT NOT NULL,
  highlights_json  TEXT NOT NULL,
  PRIMARY KEY (org_id, week_id)
);
