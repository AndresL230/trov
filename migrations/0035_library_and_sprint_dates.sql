-- 0035_library_and_sprint_dates — every schema change of the 2026-09-26 redesign batch, in ONE
-- migration (it was two while in development: 0035_library_metadata + 0036_sprint_start;
-- consolidated before either reached production). Four independent parts:
--   PART A — My Work's library strip: docs.owner, artifact_pages.published_at, prompt usage.
--   PART B — sprint start dates: sprints.start_date + its conservative backfill.
--   PART C — prompt soft delete: prompts.deleted_at / deleted_by + prompts_fts skips deleted rows.
--   PART D — artifact soft delete: artifact_pages.deleted_at / deleted_by.
-- Tests re-run a part's backfill by cutting the file at the PART B / C / D marker lines below.

-- ═══ PART A: library metadata ═══════════════════════════════════════════════════
-- Three data sources for My Work's "library" strip (2026-09-26): who OWNS a doc, when an
-- artifact was PUBLISHED, and how often a prompt is USED. Every column below is nullable
-- or has a CONSTANT default — SQLite's ALTER TABLE ADD COLUMN refuses a non-constant one —
-- and each is backfilled by an UPDATE right after it is added.

-- ── 1. docs.owner ─────────────────────────────────────────────────────────────
-- A person HANDLE: the author of the doc's FIRST version (the proposer — the
-- authenticated principal the gate stamped on that doc_versions row), set once when
-- the doc row is created (`propose_doc_update` in src/tools/writes.ts) and NEVER
-- overwritten by a later edit or promotion (`updated_by` is who last promoted). Listed
-- in HANDLE_COLUMNS (src/auth/persons.ts) so a handle rename rewrites it.
ALTER TABLE docs ADD COLUMN owner TEXT;

-- Backfill: the earliest doc_versions row's created_by; a doc with no version rows
-- falls back to updated_by (which the create path also sets to the proposer).
UPDATE docs SET owner = COALESCE(
  (SELECT v.created_by FROM doc_versions v WHERE v.slug = docs.slug ORDER BY v.version ASC, v.id ASC LIMIT 1),
  updated_by
) WHERE owner IS NULL;

-- ── 2. artifact_pages.published_at ────────────────────────────────────────────
-- When the page's CURRENT published content went live: stamped when a page moves
-- draft → published (PATCH, or private → org), and when a later version auto-publishes
-- it (every version after v1 publishes, so the new version IS a new publication).
-- Cleared to NULL when the page goes back to draft (a draft is not published). A PATCH
-- that leaves it published (or un-ratifies it to published) keeps the stamp; ratify
-- never touches it. Rules live in src/tools/artifacts.ts (writeVersion / patchPage).
ALTER TABLE artifact_pages ADD COLUMN published_at TEXT;

-- Backfill for pages already published / ratified: the created_at of the CURRENT
-- version. For current_version > 1 that IS the moment it published (a later version
-- auto-publishes); for a v1 page published by PATCH the PATCH time was never recorded,
-- so v1's created_at is the best available lower bound. Drafts stay NULL.
UPDATE artifact_pages SET published_at = COALESCE(
  (SELECT v.created_at FROM artifact_versions v WHERE v.page_id = artifact_pages.id AND v.version_no = artifact_pages.current_version),
  updated_at
) WHERE status IN ('published', 'ratified') AND published_at IS NULL;

-- ── 3. prompts.use_count / last_used_at ───────────────────────────────────────
-- Bumped (one UPDATE per call) by MCP get_prompt and by POST /api/prompts/:slug/used
-- (the web Copy button). No history before this migration: every prompt starts at 0.
ALTER TABLE prompts ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE prompts ADD COLUMN last_used_at TEXT;

-- The FTS rebuild trigger fired on ANY update of a prompts row, so every use would
-- have rewritten the prompt's prompts_fts row. Narrow it to the columns the index
-- reads (and current_version, which picks the body); a use bump now costs one row write.
DROP TRIGGER IF EXISTS prompts_fts_au;
CREATE TRIGGER prompts_fts_au AFTER UPDATE OF slug, title, description, tags, current_version ON prompts BEGIN
  DELETE FROM prompts_fts WHERE slug = old.slug;
  DELETE FROM prompts_fts WHERE slug = new.slug;
  INSERT INTO prompts_fts (slug, title, description, body, tags)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags
    FROM prompts p LEFT JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version
    WHERE p.slug = new.slug;
END;

-- ═══ PART B: sprint start dates ════════════════════════════════════════════════
-- A sprint gets a real START date (2026-09-26). Until now the only start a sprint had
-- was whatever the Timeline could parse out of the free-text `dates` label ("Sep 8 – 19"),
-- falling back to "two weeks before due" drawn with a dashed "start not set" edge.
--
-- `start_date` is nullable, `YYYY-MM-DD` (a real calendar day), and the DTO calls it
-- `start` (the seam in shared/sprints.ts: column `start_date` ↔ `view.start`, beside
-- `target_date` ↔ `view.due`). Every write path validates it and `due` with the ONE
-- validator, `sprintDatesProblem` in shared/sprints-core.ts; this migration only adds
-- the column and backfills it. Nothing here rewrites `dates` or `target_date`: a legacy
-- non-ISO `target_date` stays exactly as stored and still reads (as an unscheduled
-- sprint on the Timeline, shown as its raw text).
ALTER TABLE sprints ADD COLUMN start_date TEXT;

-- ── Backfill: a CONSERVATIVE subset of the Timeline's `parseStart` ───────────
-- Only where `dates` yields a start UNAMBIGUOUSLY, and only for a sprint whose
-- `target_date` is itself a real ISO date. Two shapes, both anchored at the START of
-- the label (parseStart searches anywhere; anything it would find mid-string is left
-- to it — the Timeline still falls back to parsing `dates` whenever `start` is NULL):
--   (a) the label BEGINS with an ISO date:            "2026-05-01 → 2026-06-10"
--   (b) the label BEGINS with "<month> <day>", NO year: "Sep 8 – 19", "may 1 – jun 10",
--       "Sept. 20 – Oct 20", "September 8th – 19"
--       The year is the due date's, or the year before when that would put the start
--       after the due date — parseStart's own rule — but the year before ONLY for a
--       range that crosses New Year ("Dec 20 – Jan 10", the start's month later than the
--       due's). A label that disagrees with its own due date ("Oct 20 – 30" due Oct 1)
--       and one carrying a YEAR after the day ("Sep 8, 2025 – …") are skipped, not guessed.
-- Either way the start must be a real calendar day, on or before the due date and at
-- most 366 days before it (parseStart's plausibility window) — anything else stays NULL.

-- (a) a leading ISO date.
UPDATE sprints
   SET start_date = substr(trim(dates), 1, 10)
 WHERE start_date IS NULL
   AND trim(dates) GLOB '[1-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]*'
   AND NOT substr(trim(dates), 11, 1) GLOB '[0-9]'
   AND date(substr(trim(dates), 1, 10)) = substr(trim(dates), 1, 10)
   AND target_date GLOB '[1-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
   AND date(target_date) = target_date
   AND substr(trim(dates), 1, 10) <= target_date
   AND julianday(target_date) - julianday(substr(trim(dates), 1, 10)) <= 366;

-- (b) a leading "<month> <day>" with no year.
WITH
p AS (
  SELECT id, target_date AS due, lower(trim(dates)) AS d
    FROM sprints
   WHERE start_date IS NULL
     AND dates IS NOT NULL
     AND target_date GLOB '[1-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
     AND date(target_date) = target_date
     AND instr(lower(trim(dates)), ' ') > 0
),
w AS (   -- first word (a trailing '.' dropped) and the rest, leading spaces dropped
  SELECT id, due,
         rtrim(substr(d, 1, instr(d, ' ') - 1), '.') AS word,
         ltrim(substr(d, instr(d, ' ') + 1)) AS rest
    FROM p
),
m AS (   -- the month: its 3-letter abbreviation, "sept", or the full name
  SELECT id, due, rest,
         CASE word
           WHEN 'jan' THEN 1  WHEN 'january' THEN 1
           WHEN 'feb' THEN 2  WHEN 'february' THEN 2
           WHEN 'mar' THEN 3  WHEN 'march' THEN 3
           WHEN 'apr' THEN 4  WHEN 'april' THEN 4
           WHEN 'may' THEN 5
           WHEN 'jun' THEN 6  WHEN 'june' THEN 6
           WHEN 'jul' THEN 7  WHEN 'july' THEN 7
           WHEN 'aug' THEN 8  WHEN 'august' THEN 8
           WHEN 'sep' THEN 9  WHEN 'sept' THEN 9  WHEN 'september' THEN 9
           WHEN 'oct' THEN 10 WHEN 'october' THEN 10
           WHEN 'nov' THEN 11 WHEN 'november' THEN 11
           WHEN 'dec' THEN 12 WHEN 'december' THEN 12
         END AS mo
    FROM w
),
dd AS (  -- the day: one or two digits, NOT followed by a third
  SELECT id, due, mo,
         CASE
           WHEN rest GLOB '[0-9][0-9]*' AND NOT rest GLOB '[0-9][0-9][0-9]*' THEN substr(rest, 1, 2)
           WHEN rest GLOB '[0-9]*' AND NOT rest GLOB '[0-9][0-9]*' THEN substr(rest, 1, 1)
         END AS day,
         rest
    FROM m
   WHERE mo IS NOT NULL
),
y AS (   -- skip a label with a year after the day ("sep 8, 2025", "sep 8th 2025")
  SELECT id, due, mo, CAST(day AS INTEGER) AS day
    FROM dd
   WHERE day IS NOT NULL
     AND NOT ltrim(substr(rest, length(day) + 1), 'stndrh., ') GLOB '[0-9][0-9][0-9][0-9]*'
),
c AS (   -- the candidate in the due date's year, and the year before
  SELECT id, due, mo,
         printf('%04d-%02d-%02d', CAST(substr(due, 1, 4) AS INTEGER), mo, day) AS same,
         printf('%04d-%02d-%02d', CAST(substr(due, 1, 4) AS INTEGER) - 1, mo, day) AS prev
    FROM y
),
s AS (
  SELECT id, due,
         CASE
           WHEN date(same) = same AND same <= due THEN same
           WHEN date(prev) = prev AND mo > CAST(substr(due, 6, 2) AS INTEGER) THEN prev
         END AS start
    FROM c
)
UPDATE sprints
   SET start_date = (SELECT start FROM s WHERE s.id = sprints.id)
 WHERE id IN (
   SELECT id FROM s
    WHERE start IS NOT NULL
      AND start <= due
      AND julianday(due) - julianday(start) <= 366
 );

-- ═══ PART C: prompt soft delete ═══════════════════════════════════════════════
-- A prompt can be DELETED (2026-09-26) — softly, like every other exit in Canopy:
-- the row and every prompt_versions row stay in D1; `deleted_at` / `deleted_by` (a
-- person HANDLE, listed in HANDLE_COLUMNS so a rename rewrites it) mark it gone.
-- A deleted prompt is absent from every read (the library, GET /api/prompts/:slug,
-- versions, /search/quick, MCP search_prompts / get_prompt) and its slug stays
-- RESERVED: a save to it is a 409 naming the fix (restore it). Writers and rules in
-- src/tools/prompts.ts (deletePrompt / restorePrompt: the author or an admin, over
-- the session cookie only — never an MCP tool). Both columns NULL = live; a restore
-- clears both.
ALTER TABLE prompts ADD COLUMN deleted_at TEXT;
ALTER TABLE prompts ADD COLUMN deleted_by TEXT;

-- prompts_fts holds ONLY live prompts: each rebuild trigger re-inserts a slug's row
-- only while `deleted_at IS NULL`, and the prompts update trigger now also fires on
-- `deleted_at` — so a delete drops the FTS row and a restore puts it back. (The
-- readers filter `deleted_at IS NULL` as well; the index is simply never a leak.)
DROP TRIGGER IF EXISTS prompts_fts_ai;
CREATE TRIGGER prompts_fts_ai AFTER INSERT ON prompts BEGIN
  DELETE FROM prompts_fts WHERE slug = new.slug;
  INSERT INTO prompts_fts (slug, title, description, body, tags)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags
    FROM prompts p LEFT JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version
    WHERE p.slug = new.slug AND p.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS prompts_fts_au;
CREATE TRIGGER prompts_fts_au AFTER UPDATE OF slug, title, description, tags, current_version, deleted_at ON prompts BEGIN
  DELETE FROM prompts_fts WHERE slug = old.slug;
  DELETE FROM prompts_fts WHERE slug = new.slug;
  INSERT INTO prompts_fts (slug, title, description, body, tags)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags
    FROM prompts p LEFT JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version
    WHERE p.slug = new.slug AND p.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS prompts_fts_vai;
CREATE TRIGGER prompts_fts_vai AFTER INSERT ON prompt_versions BEGIN
  DELETE FROM prompts_fts WHERE slug = new.slug;
  INSERT INTO prompts_fts (slug, title, description, body, tags)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags
    FROM prompts p LEFT JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version
    WHERE p.slug = new.slug AND p.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS prompts_fts_vau;
CREATE TRIGGER prompts_fts_vau AFTER UPDATE ON prompt_versions BEGIN
  DELETE FROM prompts_fts WHERE slug = new.slug;
  INSERT INTO prompts_fts (slug, title, description, body, tags)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags
    FROM prompts p LEFT JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version
    WHERE p.slug = new.slug AND p.deleted_at IS NULL;
END;

-- ═══ PART D: artifact soft delete ═════════════════════════════════════════════
-- An artifact page can be DELETED (2026-09-26) — softly, the same design as PART C:
-- the page row, every artifact_versions row, its artifact_links and the R2 bytes all
-- stay; `deleted_at` / `deleted_by` (a person HANDLE, listed in HANDLE_COLUMNS so a
-- rename rewrites it) mark it gone. A deleted page is the ONE byte-identical not-found
-- on every surface — the visibility predicate every read and write binds (`VISIBLE_SQL`
-- in src/tools/artifacts.ts) carries `p.deleted_at IS NULL` — and its slug stays
-- RESERVED (a new page never takes it; `uniqueSlug` counts every row). Only the author
-- or an admin, over the session cookie — never an MCP tool (deletePage / restorePage).
-- Both columns NULL = live; a restore clears both. artifacts_fts is kept in sync by the
-- repository, not triggers: a delete drops the page's FTS row, a restore re-inserts it.
ALTER TABLE artifact_pages ADD COLUMN deleted_at TEXT;
ALTER TABLE artifact_pages ADD COLUMN deleted_by TEXT;
