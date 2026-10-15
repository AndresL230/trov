-- 0063_person_brief: My Work's "Your brief", written by the AI pass, and the one signal that says who gets one
-- (docs/architecture/ai.md › The brief; roadmap-my-work.md › My Work; docs/superpowers/specs/2026-10-15-server-ai-build.md
-- › Phase D, "The brief"; issue #163).
-- ADDITIVE ONLY: one new TENANT table and one column on `memberships`; nothing existing changes, no row is rewritten,
-- and a Worker from before it keeps working (it names neither).
--
-- PART 1 — person_brief: the last 5 briefs written for each member of an organization (the AI pass's `brief.person`
-- job, src/ai/brief.ts, on the scope `person:<handle>`). A computed, DIRECT write (invariant 1), append-only: a new
-- brief is a new `version`, and anything older than the newest 5 is deleted in the same batch. My Work
-- (`GET /me/dashboard`), MCP `get_my_work` and — from Phase E — the daily e-mail all read the NEWEST row
-- (src/data/person-brief.ts); none of them calls a model.
--   handle          the member it was written for (HANDLE_COLUMNS: a rename rewrites it; an account deletion deletes
--                   the person's rows — src/deletion/person.ts)
--   version         1, 2, 3… per (org, handle)
--   generated_at    when the pass wrote it (what "Wrong?" names: `aiItemRef.brief(generated_at)`)
--   model           the model that wrote it; NULL for an EMPTY brief, which the pass writes without a call when there
--                   is nothing left to say (the screen then says so)
--   prompt_version  the job's prompt version (`brief.1`)
--   input_hash      SHA-256 of what the model was given: an unchanged input writes nothing and calls nothing
--   brief_json      `{ now, recently, next: { items } }` — the server-built cites included (shared/ai-core.ts `AiBrief`
--                   without its meta). Checked against `AiBriefSchema` on every read; a row that fails is not shown.
--
-- PART 2 — memberships.mywork_opened_at: when the member last opened My Work in this organization (the cookie read
-- `GET /me/dashboard`, at most one write an hour; MCP's `get_my_work` does not count). A brief is written only for a
-- member who opened My Work in the last 14 days or who receives the digest e-mail. NULL = never (since this
-- migration). It goes with the membership: leaving the org, or deleting the account, removes it.
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). It LOSES every stored brief (the pass
-- writes a new one at the person's next mark) and who opened My Work when:
--   DROP TABLE IF EXISTS person_brief;
--   ALTER TABLE memberships DROP COLUMN mywork_opened_at;
--   DELETE FROM d1_migrations WHERE name = '0063_person_brief.sql';
CREATE TABLE IF NOT EXISTS person_brief (
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  handle          TEXT NOT NULL COLLATE NOCASE,
  version         INTEGER NOT NULL CHECK (version >= 1),
  generated_at    TEXT NOT NULL,
  model           TEXT,
  prompt_version  TEXT NOT NULL,
  input_hash      TEXT NOT NULL,
  brief_json      TEXT NOT NULL,
  PRIMARY KEY (org_id, handle, version)   -- also the read's index: a person's newest version
);

ALTER TABLE memberships ADD COLUMN mywork_opened_at TEXT;
