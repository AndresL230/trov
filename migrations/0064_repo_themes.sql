-- 0064_repo_themes: "Where the work went" (Repo › Planning; docs/architecture/ai.md › Themes,
-- docs/architecture/repo-dashboard.md; docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase D "Themes").
-- ADDITIVE ONLY: three new TENANT tables; nothing existing changes, no row is rewritten, and a Worker from before
-- it keeps working (it names none of them). Every statement names `org_id` (src/data/themes.ts).
--
-- repo_themes — a repository's themes. Trov PROPOSES them (the `themes.propose` batch job writes `proposed` rows,
-- each with an open `ai_suggestions` row of kind `themes.propose`); only an ADMIN makes one `active` — Accept,
-- Rename (accept with a new name) or Merge (fold it into another theme) — or `removed` (Remove = dismiss), all
-- through the cookie suggestion routes (src/ai/themes.ts). Nothing AI-written is active without a person.
--   repo          `owner/repo` — the org's primary repository when it was proposed
--   name          1–40 characters; unique (case aside) among the repo's themes that are not removed
--   description   one or two sentences (what the lane's detail shows)
--   color_key     a `--p-*` palette key (shared/ai-core.ts AI_THEME_COLORS), chosen by the SERVER, never the model
--   status        proposed → active | removed
--   position      the lane order (proposal order)
--   seed_prs      JSON array of the PR numbers the proposal cited (each checked against its input): what a PROPOSED
--                 lane draws before any classification exists
--   merged_into   the theme a removed theme was merged into (Merge), else NULL
--   model, prompt_version   what proposed it
--   created_by    a handle (HANDLE_COLUMNS): `trov` (TROV_SYSTEM_HANDLE) for a proposal
--   created_at
--   decided_by, decided_at   a handle (HANDLE_COLUMNS): the admin who accepted, renamed, merged or removed it
--
-- pr_themes — which theme a merged PR belongs to. ONE row per (repo, PR). `source`:
--   'ai'      written by `pr.theme` (Jev, a new PR's card) or `themes.backfill` (Haiku, through the Batch API)
--   'person'  a person's choice — NEVER overwritten by the model (every AI write is an upsert guarded by
--             `WHERE pr_themes.source <> 'person'`)
--   theme_id     the repo_themes row (NULL = a person said "no theme"; the model never writes NULL)
--   confidence   Jev's probability for its pick; NULL for a Haiku pick or a person's
--   model, prompt_version   what wrote an AI row
--   set_by       a handle (HANDLE_COLUMNS) for a person's row; NULL for an AI row
--   set_at       when it was written (an AI row older than the newest active theme's acceptance is re-classified
--                by the backfill)
--
-- repo_theme_captions — the caption above the chart. The SERVER computes the theme shares and passes them in;
-- the model writes only the sentence. A caption with a digit, or naming a theme that is not active, is discarded
-- before it is stored. The read shows the newest; the last 10 per (repo, range) are kept.
--   range        shared/ai-core.ts AI_THEME_RANGES (the job writes `8w`)
--   caption      the sentence
--   theme_ids    JSON array of the active theme ids it names (checked)
--   basis_hash   a hash of the shares it was written from: the same basis twice makes no second call
--   model, prompt_version, generated_at
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). It LOSES every theme, every PR's
-- theme (people's choices included) and every caption:
--   DROP INDEX IF EXISTS idx_repo_theme_captions_repo;
--   DROP TABLE IF EXISTS repo_theme_captions;
--   DROP INDEX IF EXISTS idx_pr_themes_theme;
--   DROP TABLE IF EXISTS pr_themes;
--   DROP INDEX IF EXISTS idx_repo_themes_name;
--   DROP INDEX IF EXISTS idx_repo_themes_repo;
--   DROP TABLE IF EXISTS repo_themes;
--   DELETE FROM d1_migrations WHERE name = '0064_repo_themes.sql';
--   (and the open `themes.propose` suggestions: DELETE FROM ai_suggestions WHERE kind = 'themes.propose';)
CREATE TABLE IF NOT EXISTS repo_themes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id         TEXT NOT NULL REFERENCES orgs(id),
  repo           TEXT NOT NULL COLLATE NOCASE,
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  description    TEXT NOT NULL DEFAULT '',
  color_key      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'removed')),
  position       INTEGER NOT NULL DEFAULT 0,
  seed_prs       TEXT NOT NULL DEFAULT '[]',
  merged_into    INTEGER,
  model          TEXT,
  prompt_version TEXT,
  created_by     TEXT NOT NULL,                        -- a handle (HANDLE_COLUMNS)
  created_at     TEXT NOT NULL,
  decided_by     TEXT,                                 -- a handle (HANDLE_COLUMNS)
  decided_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_repo_themes_repo ON repo_themes(org_id, repo, status);
-- One live theme per name in a repository (a removed one frees its name).
CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_themes_name ON repo_themes(org_id, repo, name COLLATE NOCASE) WHERE status <> 'removed';

CREATE TABLE IF NOT EXISTS pr_themes (
  org_id         TEXT NOT NULL REFERENCES orgs(id),
  repo           TEXT NOT NULL COLLATE NOCASE,
  pr_number      INTEGER NOT NULL,
  theme_id       INTEGER,
  source         TEXT NOT NULL CHECK (source IN ('ai', 'person')),
  confidence     REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  model          TEXT,
  prompt_version TEXT,
  set_by         TEXT,                                 -- a handle (HANDLE_COLUMNS); NULL for an AI row
  set_at         TEXT NOT NULL,
  PRIMARY KEY (org_id, repo, pr_number)
);
CREATE INDEX IF NOT EXISTS idx_pr_themes_theme ON pr_themes(org_id, repo, theme_id);

CREATE TABLE IF NOT EXISTS repo_theme_captions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id         TEXT NOT NULL REFERENCES orgs(id),
  repo           TEXT NOT NULL COLLATE NOCASE,
  range          TEXT NOT NULL CHECK (range IN ('8w', 'quarter')),
  caption        TEXT NOT NULL CHECK (length(caption) > 0),
  theme_ids      TEXT NOT NULL DEFAULT '[]',
  basis_hash     TEXT NOT NULL,
  model          TEXT,
  prompt_version TEXT,
  generated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repo_theme_captions_repo ON repo_theme_captions(org_id, repo, range, generated_at);
