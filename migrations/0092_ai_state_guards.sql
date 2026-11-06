-- 0092_ai_state_guards: three columns (and one index) that let the AI features' state changes be claimed, recovered
-- and retried safely (docs/architecture/ai.md, ask.md). ADDITIVE ONLY: nothing existing changes, no row is rewritten.
--   · chat_threads.turn_at — the running turn's LEASE (src/data/ask.ts `claimThread`): set when a turn starts, NULL
--     when it ends. A second turn on the same thread while one runs is refused (`409 busy`); a lease older than
--     `ASK_TURN_LEASE_MS` belongs to a turn whose Worker died and is taken over. NULL for every existing thread.
--   · ai_dirty.held_at — when the scope was HELD for a Message Batch (src/data/ai-dirty.ts `holdScopes`). A held scope
--     reads clean like before, but is now told apart from one that ran: when its batch is lost, or nothing collected
--     it within `AI_BATCH_HOLD_MAX_MS`, it becomes due again. NULL = not held.
--   · sprints.source_key — the AI suggestion a sprint was created from (`<suggestion id>:<index>`,
--     src/ai/roadmap-accept.ts): a second Accept of the same drafted sprint finds it instead of creating another. NULL
--     for every sprint a person made. Unique per org when set.
-- Rollback by hand:
--   DROP INDEX IF EXISTS idx_sprints_source_key;
--   ALTER TABLE sprints DROP COLUMN source_key;
--   ALTER TABLE ai_dirty DROP COLUMN held_at;
--   ALTER TABLE chat_threads DROP COLUMN turn_at;
-- then DELETE FROM d1_migrations WHERE name = '0092_ai_state_guards.sql'.
ALTER TABLE chat_threads ADD COLUMN turn_at TEXT;
ALTER TABLE ai_dirty ADD COLUMN held_at TEXT;
ALTER TABLE sprints ADD COLUMN source_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sprints_source_key ON sprints(org_id, source_key) WHERE source_key IS NOT NULL;
