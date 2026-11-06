-- 0089_sprint_completed_at: WHEN a sprint was completed (docs/architecture/roadmap-my-work.md). `sprints.status = 'done'`
-- said WHETHER, and "completed this week" (the weekly highlights, src/ai/week.ts) read `updated_at` for when — which
-- every plan write stamps on every sprint it lists, so a sprint finished months ago came back as finished this week.
--   · `completed_at` is set by the writers that make a sprint done (`complete_sprint`, and `write_plan` moving it to
--     done — kept when it already was) and cleared by every move off done (`set_sprint_active`, `write_plan`);
--   · a sprint already done is backfilled from its `updated_at`, the best time there is for it.
-- Rollback by hand:
--   ALTER TABLE sprints DROP COLUMN completed_at;
-- then DELETE FROM d1_migrations WHERE name = '0089_sprint_completed_at.sql'.
ALTER TABLE sprints ADD COLUMN completed_at TEXT;
UPDATE sprints SET completed_at = COALESCE(updated_at, created_at) WHERE status = 'done' AND completed_at IS NULL;
