-- 0049_support_reports: bug reports and support messages (docs/architecture/support.md). A signed-in
-- person sends one from Help › Report a bug / Contact support (`POST /api/support`); the platform's
-- operator reads them in Platform › Support and is mailed each one (`SUPPORT_NOTIFY_EMAIL`).
--
-- ADDITIVE ONLY — one new table and two indexes. Nothing existing changes, no row is rewritten, and a
-- Worker from before it keeps working (it reads and writes none of this).
--
-- The table is GLOBAL (platform data, reached only through src/data/platform-sql.ts): a report is
-- about a PERSON and may be sent from outside any organization. So the org it was sent from is
-- `from_org`, deliberately NOT `org_id` — this is not an org's row, no member of that org can read it,
-- and the data layer's static test treats every table with an `org_id` column as tenant data.
--
-- What a row holds is what the reporter TYPED (kind, subject, message) plus the four things the form
-- showed them it would attach: the screen (the route hash), the organization (its id and slug, kept
-- only when the reporter is a member of it), the app version and the browser's user agent. Nothing is
-- read from the organization, and the reporter's e-mail is not copied here: the reader joins the
-- provider-verified address on `identities` when it needs one.
--
--   reporter      a person HANDLE (HANDLE_COLUMNS: a rename rewrites it). Always the session's person.
--   resolved_by   a person HANDLE (HANDLE_COLUMNS), the superadmin who resolved it; NULL while open.
--   mail_status   what became of the mail to the operator: 'sent', 'failed' (mail_error says why,
--                 scrubbed of the provider key), 'skipped' (no SUPPORT_NOTIFY_EMAIL), NULL = not tried yet.
--
-- ROLLBACK (by hand; nothing else depends on this table). It LOSES every report sent so far:
--   DROP INDEX IF EXISTS idx_support_reports_status;
--   DROP INDEX IF EXISTS idx_support_reports_reporter;
--   DROP TABLE IF EXISTS support_reports;
--   DELETE FROM d1_migrations WHERE name = '0049_support_reports.sql';
-- together with `wrangler rollback` to the Worker from before it.
CREATE TABLE IF NOT EXISTS support_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('bug', 'question', 'feedback')),
  subject       TEXT NOT NULL,
  message       TEXT NOT NULL,
  reporter      TEXT NOT NULL COLLATE NOCASE,          -- a handle (HANDLE_COLUMNS)
  from_org      TEXT,                                  -- orgs.id it was sent from (not named `org_id`: this is not an org's row)
  from_org_slug TEXT,                                  -- that org's slug, as the form showed it
  route         TEXT,
  app_version   TEXT,
  user_agent    TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by   TEXT,                                  -- a handle (HANDLE_COLUMNS)
  resolved_at   TEXT,
  created_at    TEXT NOT NULL,
  mail_status   TEXT CHECK (mail_status IS NULL OR mail_status IN ('sent', 'failed', 'skipped')),
  mail_at       TEXT,
  mail_error    TEXT
);
-- The list: newest first, filtered by status (and the tab's count of open reports).
CREATE INDEX IF NOT EXISTS idx_support_reports_status ON support_reports(status, id);
CREATE INDEX IF NOT EXISTS idx_support_reports_reporter ON support_reports(reporter);
