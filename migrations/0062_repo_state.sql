-- 0062_repo_state: what Trov writes about where a repository stands — Repo › Overview's State and
-- `get_repo_dashboard`'s `state` (docs/architecture/ai.md › Repo state; repo-dashboard.md;
-- docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase D). ADDITIVE ONLY: one new TENANT table.
--
-- APPEND-ONLY, a computed direct write (`src/ai/repo-state.ts` through `appendRepoState`, src/tools/repo-state.ts):
-- each run of the `repo.state` job adds version N+1 for the repository and deletes every version older than the
-- last 20 in the same batch. The screens read the newest (`readRepoState`). No handle column.
--   version        1, 2, … per (org, repo)
--   generated_at   when it was written
--   basis_until    the instant the input was read up to: the next run reads what happened after it
--   model / prompt_version   what wrote it
--   event_count    how many events the input carried — counted by the server ("Written by Trov from N events")
--   state_json     { headline, shipped[], inFlight[], attention[] }, each line `{ text, cites[] }` with every cite
--                  resolved by the server from rows it read (`{ ref, label, href }`) — never a model's link
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). It LOSES the written states (the next
-- run starts from none):
--   DROP TABLE IF EXISTS repo_state;
--   DELETE FROM d1_migrations WHERE name = '0062_repo_state.sql';
CREATE TABLE IF NOT EXISTS repo_state (
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  repo            TEXT NOT NULL,
  version         INTEGER NOT NULL CHECK (version >= 1),
  generated_at    TEXT NOT NULL,
  basis_until     TEXT NOT NULL,
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  event_count     INTEGER CHECK (event_count IS NULL OR event_count >= 0),
  state_json      TEXT NOT NULL,
  PRIMARY KEY (org_id, repo, version)
);
