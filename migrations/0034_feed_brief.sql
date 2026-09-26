-- A feed entry's BRIEF: 1–2 plain sentences (≤ 280 characters) on the problem the work
-- solved, written for people. The Feed's "For reading" view shows the summary + brief;
-- "For agents" keeps the full body. NULL for an entry written without one (every entry
-- before this migration, until the one-off scripts/backfill-feed-briefs.mjs fills it).
ALTER TABLE feed ADD COLUMN brief TEXT;
