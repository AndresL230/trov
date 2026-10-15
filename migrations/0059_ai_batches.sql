-- 0059_ai_batches: the AI pass's Message Batches, and two columns the router's debounce needs on `ai_dirty`
-- (docs/architecture/ai.md › Batches, › Scopes and debounce; docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase B).
-- ADDITIVE ONLY: two new PLATFORM tables and two columns on `ai_dirty`; nothing existing changes, no row is
-- rewritten, and a Worker from before it keeps working (it names none of them).
--
-- PART 1 — ai_batches / ai_batch_requests: what the AI pass (src/ai/pass.ts, src/ai/batches.ts) handed to
-- Anthropic's Message Batches API and has not collected yet. PLATFORM tables (src/data/platform-sql.ts): a batch
-- carries requests from several organizations, so neither table has an `org_id` column and neither is in
-- `ORG_TABLES`. A request names its organization only inside `custom_id` (`<org>:<scope>:<key>:<prompt version>`),
-- and every request row is DELETED when its batch is collected — so a request outlives neither its batch (the
-- provider ends a batch within 24 h) nor, for long, its organization: a result for an organization that no longer
-- exists, or that has the AI switch off, writes nothing at all (src/ai/batches.ts).
--   ai_batches
--     id            the provider's batch id (`msgbatch_…`)
--     provider      who runs it: `claude` (the only provider with a batch API)
--     state         `submitted` → `collected` (its results were read and written) | `lost` (the provider no longer
--                   knows it: nothing was written; its scopes become due again when they are next marked)
--     requests      how many requests it carried
--     submitted_at  when the pass created it; ended_at when the provider said it ended; collected_at when the pass
--                   wrote its results; checked_at the last time the pass asked
--     succeeded / errored / canceled / expired   the provider's own counts, NULL until it ended (never a guess)
--     written       results that wrote something; NULL until collected
--   ai_batch_requests — one row per request while its batch is open
--     request_id    the id sent to the provider (the API allows only [A-Za-z0-9_-]{1,64}: `r0`, `r1`, …)
--     custom_id     `<org>:<scope>:<key>:<prompt version>` — what the result is written back to
--     job           the pass job that made it (its name): the schema the answer is checked against, and its writer
--
-- PART 2 — ai_dirty.marked_at, ai_dirty.urgent (the table is 0058's; nothing has written it before this migration):
--   marked_at   the LAST time the scope was marked. `dirty_since` stays the FIRST (since the last run); a session
--               closes 45 minutes after its LAST event, so its debounce counts from here. NULL = `dirty_since`.
--   urgent      1 = the scope skips its debounce: a breaking change on a `repo` (Pro / Enterprise), the digest
--               pre-warm on a `person` (shared/ai-core.ts `debounceMs`). Cleared when the scope is written.
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). It LOSES the open batches (their
-- results are never collected; the scopes they held become due again when next marked):
--   DROP TABLE IF EXISTS ai_batch_requests;
--   DROP INDEX IF EXISTS idx_ai_batches_state;
--   DROP TABLE IF EXISTS ai_batches;
--   ALTER TABLE ai_dirty DROP COLUMN urgent;
--   ALTER TABLE ai_dirty DROP COLUMN marked_at;
--   DELETE FROM d1_migrations WHERE name = '0059_ai_batches.sql';
CREATE TABLE IF NOT EXISTS ai_batches (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL DEFAULT 'claude' CHECK (provider IN ('claude')),
  state         TEXT NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted', 'collected', 'lost')),
  requests      INTEGER NOT NULL CHECK (requests >= 0),
  submitted_at  TEXT NOT NULL,
  checked_at    TEXT,
  ended_at      TEXT,
  collected_at  TEXT,
  succeeded     INTEGER,
  errored       INTEGER,
  canceled      INTEGER,
  expired       INTEGER,
  written       INTEGER
);
-- The pass reads the open batches oldest first.
CREATE INDEX IF NOT EXISTS idx_ai_batches_state ON ai_batches (state, submitted_at);

CREATE TABLE IF NOT EXISTS ai_batch_requests (
  batch_id      TEXT NOT NULL REFERENCES ai_batches(id),
  request_id    TEXT NOT NULL,
  custom_id     TEXT NOT NULL,
  job           TEXT NOT NULL,
  PRIMARY KEY (batch_id, request_id)
);

ALTER TABLE ai_dirty ADD COLUMN marked_at TEXT;
ALTER TABLE ai_dirty ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1));
