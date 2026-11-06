-- 0088_state_machines: the state-machine fixes (PR #225 — issues #211–#217) in ONE migration. It consolidates what
-- were four files (0088_doc_versions_unique, 0089_sprint_completed_at, 0092_ai_state_guards,
-- 0093_integration_ordering) before any of them reached production: each part below starts with a
-- `-- ══ part <old name> ══` marker and keeps that file's own header — what it adds, why, and its by-hand rollback
-- (roll back the parts in REVERSE order, 0093_integration_ordering first; the one `d1_migrations` row to delete once
-- every part is rolled back is `0088_state_machines.sql`). Every part is ADDITIVE but one statement: one UNIQUE index
-- on `doc_versions` (ASSUMES NO DUPLICATE (org_id, slug, version) — check prod before applying, the query is in the
-- first part), stale staged doc versions marked `superseded`, `sprints.completed_at` (backfilled for done sprints) and
-- `sprints.source_key` + a partial unique index, `chat_threads.turn_at`, `ai_dirty.held_at`,
-- `notification_outbox.attempted_at`, `org_github_installations.suspension_at` / `.repos_changed_at`.

-- ══ part 0088_doc_versions_unique ════════════════════════════════════════════════════════════════════════
-- 0088_doc_versions_unique: a doc's version numbers are unique, and a promote leaves nothing stale waiting
-- (docs/architecture/ingestion-gate.md › Staged-write model).
--   · idx_doc_versions_version — UNIQUE (org_id, slug, version). The gate now takes a new version's number inside its
--     INSERT (src/tools/writes.ts `propose_doc_update`), and the index holds it in the schema: two proposals of one
--     page can never both be "v3". ASSUMES NO DUPLICATES EXIST — check before applying:
--       SELECT org_id, slug, version, COUNT(*) FROM doc_versions GROUP BY org_id, slug, version HAVING COUNT(*) > 1;
--   · `superseded`, a new value of doc_versions.status (the column has no CHECK; the values live in src/tools/writes.ts
--     `DOC_VERSION_STATUSES`): a promote marks the page's OLDER versions still `staged` superseded, in its own batch.
--     The ones a promote left behind before this are marked here — a staged version not newer than its page's live
--     one. Review, its badge and an import's Approve all already left them out (they read `staged` newer than
--     `current_version`); this stops them waiting forever, and the readers that count every `staged` row with them.
-- Rollback by hand:
--   DROP INDEX IF EXISTS idx_doc_versions_version;
--   UPDATE doc_versions SET status = 'staged' WHERE status = 'superseded';
-- (then the next part's rollback; the d1_migrations row is 0088_state_machines.sql — see the top).
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_versions_version ON doc_versions(org_id, slug, version);

UPDATE doc_versions SET status = 'superseded'
 WHERE status = 'staged'
   AND version <= (SELECT d.current_version FROM docs d WHERE d.org_id = doc_versions.org_id AND d.slug = doc_versions.slug);

-- ══ part 0089_sprint_completed_at ════════════════════════════════════════════════════════════════════════
-- 0089_sprint_completed_at: WHEN a sprint was completed (docs/architecture/roadmap-my-work.md). `sprints.status = 'done'`
-- said WHETHER, and "completed this week" (the weekly highlights, src/ai/week.ts) read `updated_at` for when — which
-- every plan write stamps on every sprint it lists, so a sprint finished months ago came back as finished this week.
--   · `completed_at` is set by the writers that make a sprint done (`complete_sprint`, and `write_plan` moving it to
--     done — kept when it already was) and cleared by every move off done (`set_sprint_active`, `write_plan`);
--   · a sprint already done is backfilled from its `updated_at`, the best time there is for it.
-- Rollback by hand:
--   ALTER TABLE sprints DROP COLUMN completed_at;
-- (then the next part's rollback; the d1_migrations row is 0088_state_machines.sql — see the top).
ALTER TABLE sprints ADD COLUMN completed_at TEXT;
UPDATE sprints SET completed_at = COALESCE(updated_at, created_at) WHERE status = 'done' AND completed_at IS NULL;

-- ══ part 0092_ai_state_guards ════════════════════════════════════════════════════════════════════════════
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
-- (then the next part's rollback; the d1_migrations row is 0088_state_machines.sql — see the top).
ALTER TABLE chat_threads ADD COLUMN turn_at TEXT;
ALTER TABLE ai_dirty ADD COLUMN held_at TEXT;
ALTER TABLE sprints ADD COLUMN source_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sprints_source_key ON sprints(org_id, source_key) WHERE source_key IS NOT NULL;

-- ══ part 0093_integration_ordering ═══════════════════════════════════════════════════════════════════════
-- 0093_integration_ordering: three nullable columns so out-of-order signals and dead runs can be told apart
-- (docs/architecture/notifications.md › Runs, github-app.md › Uninstall, suspend, disconnect). Additive only:
-- nothing is backfilled, and a Worker that does not know them yet keeps working (NULL reads as "not known").
--   · notification_outbox.attempted_at — when the latest send attempt of a row began. A `pending` row whose
--     attempt (or, with none, its claim: created_at) is older than the retry job's lease is a run that died
--     mid-send; the retry job takes it (src/notifications/retry.ts).
--   · org_github_installations.suspension_at — when the suspend / unsuspend the row reflects HAPPENED (GitHub's
--     time for a webhook's, Trov's for a state it read from GitHub). An older delivery changes nothing
--     (src/github-app/store.ts `setInstallationSuspended`).
--   · org_github_installations.repos_changed_at — an `installation_repositories` event was applied and no
--     complete repository list has confirmed it since; the cron's reconcile unit re-reads the list
--     (src/github-app/repos.ts `recheckInstallation`).
-- Rollback by hand:
--   ALTER TABLE notification_outbox DROP COLUMN attempted_at;
--   ALTER TABLE org_github_installations DROP COLUMN suspension_at;
--   ALTER TABLE org_github_installations DROP COLUMN repos_changed_at;
-- (then the next part's rollback; the d1_migrations row is 0088_state_machines.sql — see the top).
ALTER TABLE notification_outbox ADD COLUMN attempted_at TEXT;
ALTER TABLE org_github_installations ADD COLUMN suspension_at TEXT;
ALTER TABLE org_github_installations ADD COLUMN repos_changed_at TEXT;
