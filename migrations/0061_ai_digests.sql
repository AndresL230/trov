-- 0061_ai_digests: session digests — Trov's own feed entries — and the `trov` system person
-- (docs/architecture/ai.md › Session digests; docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase D).
-- ADDITIVE ONLY: three columns on `feed` (every existing row reads as an agent's), one new TENANT table, one
-- `persons` row. A Worker from before it keeps working (it names none of them).
--
-- PART 1 — feed.origin / feed.model / feed.subject. An entry written by Trov (`src/ai/digests.ts`, through the gate's
-- `ingestFeedEntry`) is `origin = 'ai'`, records the `model` that wrote it, and names its `subject`: the member the
-- session was for (a HANDLE — in HANDLE_COLUMNS, so a rename or an account deletion rewrites it; NULL when the GitHub
-- login maps to no member). Every other entry is `origin = 'agent'` with NULL model and subject, as before.
--
-- PART 2 — ai_sessions: one row per burst of one GitHub login's work on one repository that the AI pass looked at
-- (the router's `session:<repo>:<login>` scope). It is the pass's own bookkeeping, a computed direct write:
--   started_at / ended_at   the burst's first and last captured event (`repo_events.recorded_at`)
--   status                  `done` (a digest was written: `feed_id`), or `skipped` — `reason` says why:
--                           `not_substantive` (the session gate, Jev or its plain rule), `agent_recorded` (an agent's
--                           entry already cites these commits or PRs: no model call at all)
--   shas / prs              the burst's commits (short shas) and pull requests, JSON arrays — what dedupe compares
--   model / prompt_version  what wrote the digest (`done` only)
-- `actor_login` is a GitHub login, not a handle (not in HANDLE_COLUMNS); an account's deletion deletes the rows of
-- its logins (src/deletion/person.ts), as it does their `session` scopes.
--
-- PART 3 — the `trov` system person: the author of every entry Trov writes, and (Phase D's doc drift) of its
-- proposals — the ONE exception to "the author is the authenticated principal" (ingestion-gate.md). Like
-- `github-webhook` (0032) it is a row only because `feed.author` must name a person; `trov` is in RESERVED_HANDLES,
-- so nobody can sign up as, rename to or be renamed from it; it is never a member, never listed, never assignable,
-- and account deletion refuses it (`accountDeletionPreview` → not found).
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). It LOSES which entries Trov wrote (they
-- stay in the feed, as entries by `trov`) and the session bookkeeping (the pass would digest a session again only
-- if it were marked again):
--   DROP INDEX IF EXISTS idx_ai_sessions_feed;
--   DROP TABLE IF EXISTS ai_sessions;
--   ALTER TABLE feed DROP COLUMN subject;
--   ALTER TABLE feed DROP COLUMN model;
--   ALTER TABLE feed DROP COLUMN origin;
--   DELETE FROM d1_migrations WHERE name = '0061_ai_digests.sql';
-- (the `trov` persons row can stay: it is reserved either way, and feed rows may still name it).
ALTER TABLE feed ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent', 'ai'));
ALTER TABLE feed ADD COLUMN model TEXT;
ALTER TABLE feed ADD COLUMN subject TEXT;

CREATE TABLE IF NOT EXISTS ai_sessions (
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  repo            TEXT NOT NULL,
  actor_login     TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('done', 'skipped')),
  reason          TEXT CHECK (reason IS NULL OR reason IN ('not_substantive', 'agent_recorded')),
  shas            TEXT NOT NULL DEFAULT '[]',
  prs             TEXT NOT NULL DEFAULT '[]',
  feed_id         INTEGER,
  model           TEXT,
  prompt_version  TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (org_id, repo, actor_login, started_at)
);
-- The Feed reads a digest's repository by its entry.
CREATE INDEX IF NOT EXISTS idx_ai_sessions_feed ON ai_sessions(org_id, feed_id) WHERE feed_id IS NOT NULL;

INSERT OR IGNORE INTO persons (handle, name, color, created_at, onboarded_at)
  VALUES ('trov', 'Trov', 'moss', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z');
