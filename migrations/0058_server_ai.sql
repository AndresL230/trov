-- 0058_server_ai: the server-side AI build (#178) and Ask Trov, in ONE migration. It consolidates what were eleven
-- files (0058_ai_dirty … 0068_ask_pending) before any of them reached production: each part below starts with a
-- `-- ══ part <old name> ══` marker and keeps that file's own header — what it adds, why, and its by-hand rollback
-- (roll back the parts in REVERSE order). Every part is ADDITIVE (new tables, triggers, indexes and nullable
-- columns), so a Worker from before it keeps working. Applied in one go by `wrangler d1 migrations apply`.
-- Parts: 0058_ai_dirty, 0059_ai_batches, 0060_ai_importance, 0061_ai_digests, 0062_repo_state, 0063_person_brief, 0064_repo_themes, 0065_org_insights, 0066_ask, 0067_digest_email, 0068_ask_pending.

-- ══ part 0058_ai_dirty ═════════════════════════════════════════════════════════════════════════
-- 0058_ai_dirty: what the AI router marks stale, and the organization's Auto switch for Ask Trov
-- (docs/architecture/ai.md; docs/superpowers/specs/2026-10-15-server-ai-build.md › Phases A, B and F).
-- ADDITIVE ONLY: one new TENANT table and one column on `orgs`; nothing existing changes, no row is rewritten,
-- and a Worker from before it keeps working (it names neither).
--
-- PART 1 — ai_dirty: one row per SCOPE of an organization that a write made stale and the AI pass has not
-- written since (Phase B: `src/ai/router.ts` marks, `src/ai/pass.ts` clears). NOTHING WRITES IT YET — it ships
-- here so the router and the pass build on a table that is already in every database. Every statement names
-- `org_id`. No handle column (a `person:<handle>` scope key is text the pass reads, never an owner).
--   scope         what kind of thing is stale: `card`, `session`, `person`, `repo`, `org`, `sprint`,
--                 `theme_window`, `theme_backfill`, `doc_drift`
--   scope_key     which one: `pr:173`, `AndresL230/trov:andres`, a handle, a repo, '' for the org itself
--   dirty_since   when it FIRST went stale since its last run (marking an already-dirty scope keeps it)
--   last_run_at   when the pass last wrote it; NULL = never
--   attempts      failed runs since it was marked; after 3 it waits until it is marked again
--   last_error    the last failure's NAME only (never a model's text, never a secret); NULL = none
--
-- PART 2 — orgs.ai_chat_auto, the organization's Auto switch for Ask Trov (organizations.md › Org settings ›
-- AI). Ask Trov's "Auto" lets a person's writes run without a Confirm card (Phase F); an admin turns it off for
-- the whole organization in Org settings › AI (`PUT /api/o/:slug/ai/settings { chatAuto }`, a cookie route —
-- never MCP), audited `org.ai_chat_auto`. ON for every org (existing and new). It moved here from
-- 0066_ask (the Ask migration), so Org settings › AI has a column for the switch from Phase A.
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). It LOSES every stale mark (the
-- pass re-marks on the next writes) and the admins' Auto choices:
--   DROP INDEX IF EXISTS idx_ai_dirty_since;
--   DROP TABLE IF EXISTS ai_dirty;
--   ALTER TABLE orgs DROP COLUMN ai_chat_auto;
--   DELETE FROM d1_migrations WHERE name = '0058_ai_dirty.sql';
CREATE TABLE IF NOT EXISTS ai_dirty (
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  scope        TEXT NOT NULL,
  scope_key    TEXT NOT NULL DEFAULT '',
  dirty_since  TEXT NOT NULL,
  last_run_at  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error   TEXT,
  PRIMARY KEY (org_id, scope, scope_key)
);
-- The pass reads an org's scopes oldest first.
CREATE INDEX IF NOT EXISTS idx_ai_dirty_since ON ai_dirty (org_id, dirty_since);

ALTER TABLE orgs ADD COLUMN ai_chat_auto INTEGER NOT NULL DEFAULT 1;

-- ══ part 0059_ai_batches ═══════════════════════════════════════════════════════════════════════
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

-- ══ part 0060_ai_importance ════════════════════════════════════════════════════════════════════
-- 0060_ai_importance: how much a feed entry or a merged pull request matters, as Sift rated it — a COMPUTED fact the
-- AI pass writes (docs/architecture/ai.md › Jobs › feed.importance; docs/superpowers/specs/2026-10-15-server-ai-build.md
-- › Phase C). ADDITIVE ONLY: one nullable column on each of two existing tables; no row is rewritten, and a Worker
-- from before it keeps working (it names neither column, and `SELECT *` only gains one).
--
--   feed.importance          the entry's importance (`card:feed:<id>`, src/ai/importance.ts)
--   pr_summaries.importance  the merged PR's importance (`card:pr:<n>`, the same job; the row of `gh:pr:<n>:merged`)
--
-- Values: `routine` | `notable` | `breaking` (shared/ai-core.ts `FEED_IMPORTANCES`), the answer of ONE Jev `choice`
-- question per item. NULL = UNKNOWN — never answered, Jev unsure (below `IMPORTANCE_MIN_CONFIDENCE`), the org's AI
-- switch off, or no key — and every screen draws NULL exactly as before this migration: never a guessed `routine`.
-- It is not a suggestion (nothing to accept) and not authored: no person sets it, and nothing official reads it as a
-- decision. A re-summarized PR keeps it (src/tools/summarize.ts upserts the summary's own columns only).
--
-- No new table, no handle column: ORG_TABLES, HANDLE_COLUMNS and the reset seed are unchanged.
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it; it loses only the ratings):
--   ALTER TABLE pr_summaries DROP COLUMN importance;
--   ALTER TABLE feed DROP COLUMN importance;
--   DELETE FROM d1_migrations WHERE name = '0060_ai_importance.sql';
ALTER TABLE feed ADD COLUMN importance TEXT CHECK (importance IS NULL OR importance IN ('routine', 'notable', 'breaking'));
ALTER TABLE pr_summaries ADD COLUMN importance TEXT CHECK (importance IS NULL OR importance IN ('routine', 'notable', 'breaking'));

-- ══ part 0061_ai_digests ═══════════════════════════════════════════════════════════════════════
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

-- ══ part 0062_repo_state ═══════════════════════════════════════════════════════════════════════
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

-- ══ part 0063_person_brief ═════════════════════════════════════════════════════════════════════
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

-- ══ part 0064_repo_themes ══════════════════════════════════════════════════════════════════════
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

-- ══ part 0065_org_insights ═════════════════════════════════════════════════════════════════════
-- 0065_org_insights: what Trov writes about the ROADMAP (docs/architecture/roadmap-my-work.md › Roadmap
-- intelligence; docs/architecture/ai.md; docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase D, "Roadmap").
-- ADDITIVE ONLY: one new TENANT table; nothing existing changes, no row is rewritten, and a Worker from before it
-- keeps working (it never names it).
--
-- org_insights: one row per thing the AI pass's org rollup WROTE — a computed write, never a suggestion and never
-- official. Every statement names `org_id`. No handle column (nothing here is owned by a person).
--   kind            `sprint_note` (key = the sprint's id, as text) or `plan_drift` (key = '')
--   key             which one
--   version         1, 2, 3… per (org, kind, key); the newest is what the Roadmap reads. The writer keeps the
--                   LAST 10 per key and deletes the rest in the same batch.
--   generated_at    when the pass wrote it
--   model           the model that wrote the words (provenance; NULL never written by the pass)
--   prompt_version  the job's prompt version
--   json            `{ text, cites: AiCite[] }` (+ `shares` for a drift): the cites were checked against the
--                   input the model was given, and the numbers in a drift came from the server, never the model
--
-- In ORG_TABLES (an org's deletion takes it) and the reset seed.
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). It LOSES every sprint note and
-- drift line (the pass writes them again at the next rollup):
--   DROP INDEX IF EXISTS idx_org_insights_latest;
--   DROP TABLE IF EXISTS org_insights;
--   DELETE FROM d1_migrations WHERE name = '0065_org_insights.sql';
CREATE TABLE IF NOT EXISTS org_insights (
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  kind            TEXT NOT NULL CHECK (kind IN ('sprint_note', 'plan_drift')),
  key             TEXT NOT NULL DEFAULT '',
  version         INTEGER NOT NULL CHECK (version >= 1),
  generated_at    TEXT NOT NULL,
  model           TEXT,
  prompt_version  TEXT,
  json            TEXT NOT NULL,
  PRIMARY KEY (org_id, kind, key, version)
);
-- The Roadmap reads the newest version per key.
CREATE INDEX IF NOT EXISTS idx_org_insights_latest ON org_insights(org_id, kind, key, version DESC);

-- ══ part 0066_ask ══════════════════════════════════════════════════════════════════════════════
-- 0066_ask: Ask Trov — a person's chat threads with Trov, the writes it proposed, its attachments, the person's
-- own Ask settings, and the "Flagged in Ask" lines Review shows (docs/architecture/ask.md;
-- docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase F as amended by Trov handoff #12 §2).
-- ADDITIVE ONLY: seven new TENANT tables (one an FTS index) with the triggers that keep the index, and one
-- nullable column on `ai_feedback`; nothing existing changes, no row is rewritten, and a Worker from before it
-- keeps working (it names none of them). `orgs.ai_chat_auto` (the org's Auto switch) is NOT here: 0058_ai_dirty.
--
-- Everything but `ask_flags` is PRIVATE TO ONE PERSON: a thread is its owner's (`chat_threads.handle`), and every
-- other row hangs off a thread. Every statement names `org_id` (src/data/ask.ts) AND the owner, so another org's —
-- or another person's — thread, message, action or attachment is the one `not_found`. In `ORG_TABLES` and the
-- reset seed; the two handle columns are in `HANDLE_COLUMNS`; deleting an ACCOUNT deletes the person's threads,
-- messages, actions, attachment links and settings (src/deletion/person.ts).
--
-- chat_threads — one conversation.
--   handle        the owner (HANDLE_COLUMNS); only they ever read or write it
--   title         written from the first exchange (by the same model call), or the person's rename; '' until then
--   mode          fast | smart | thinking — the thread's mode (a new thread starts in the person's default, Smart
--                 unless Settings › Trov changed it); every answer records its own mode too
--   origin        page (the Ask screen) | panel (the ⌘J panel)
--   context_ref   the item a ⌘J thread was opened on (`ticket:14`), else NULL
--   pinned        1 = pinned to the top of the list
--   auto_mode     1 = "Auto": a write runs at once (still a chat_actions row, with Undo) — only while the org's
--                 `ai_chat_auto` is on, never update_plan or a Publish, at most 5 per answer
--   draft         the unsent composer text
--   summary       the compacted older part of the thread (written once by Fast, sent as a cached prefix); '' = none
--   summary_through  the last message id the summary covers; 0 = none
--   turn          the current turn number (a proposed card expires when the next turn starts)
--   stop_requested 1 = the person pressed Stop: the running turn ends at its next step
--
-- chat_messages — one question or one answer.
--   role          user | assistant
--   mode          the mode it was asked / answered in
--   content_json  { text, command?, context?, blocks?, activity?, followups?, thinking?, refs?, attached? }
--   cites_json    the RefViews the answer's tokens link: ONLY items a tool returned in this thread (or attached)
--   attachments_json  a question's attachments: [{ id, slug, title, kind, … }]
--   model, tokens_in, tokens_out, tokens_cached  the provider's own counts (an answer); 0 on a question
--   units         the questions the answer counted as in `ai_chat` (1 / 1 / 5); 0 on a question
--   stopped       1 = the answer was stopped (or ran out of time) part-way: what it said is partial
--   replaced_at   set when edit-and-resend or regenerate replaced it: hidden, out of search, its cards expired
--
-- chat_fts — full-text over the text of a person's own messages that are not replaced (search joins it to the
--   owner's threads, so a rename never touches the index).
--
-- chat_actions — one write card. Nothing on this table runs by itself:
--   state         proposed | waiting (past the Auto cap, or Confirm-only) → confirmed | cancelled | failed |
--                 expired (with the next turn, or its answer replaced); auto (ran in Auto mode);
--                 confirmed | auto → undone; `running` while a write is in flight (the one claim)
--   kind          ticket | handoff | doc_edit | move | publish | sprint | other — the card's shape
--   group_id      consecutive calls to the same tool in one answer share it: one card, one Undo
--   tool, args_json  the write tool and its validated arguments (editable fields re-validated on Confirm)
--   preview_json  what the card shows — built by the SERVER from Trov's rows, never model text
--   result_json   what the write returned (or why it failed)
--   undo_json     the previous values Undo writes back, and the item's state right after the write (Undo refuses
--                 when someone changed it since); NULL = no reverse exists
--
-- chat_artifacts — an artifact a thread carried or made: an attachment (stored as a PRIVATE artifact on attach,
--   BEFORE the model sees it) or a saved answer. The bytes live in the artifacts store (R2 / D1).
--   role          attachment | saved;  message_id  the message it was sent with / saved from (NULL until sent)
--
-- person_ask_settings — Settings › Trov: "How Trov should answer you" (≤ 500 characters, appended to the system
--   prompt AFTER the rules) and the default mode (Pro; NULL = Smart).
--
-- ask_flags — "Wrong?" with "A source is wrong" or "It is out of date" on an answer flags each item it cited:
--   Review shows "Flagged in Ask" with the REASON only. No handle, no thread, no message, no text: threads stay
--   private. (The person's own "Wrong?" row, with its detail, is `ai_feedback`.)
-- ai_feedback.detail_json — "Wrong?" on an answer: { reason, mode, messageId, cites } (NULL on every other item).
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). It LOSES every thread, message, card,
-- Ask setting and flag (the attachments and saved answers stay in the artifacts library):
--   DROP TRIGGER IF EXISTS chat_fts_ai; DROP TRIGGER IF EXISTS chat_fts_au; DROP TRIGGER IF EXISTS chat_fts_ad;
--   DROP TRIGGER IF EXISTS chat_fts_replaced;
--   DROP TABLE IF EXISTS chat_fts; DROP TABLE IF EXISTS chat_artifacts; DROP TABLE IF EXISTS chat_actions;
--   DROP TABLE IF EXISTS chat_messages; DROP TABLE IF EXISTS chat_threads; DROP TABLE IF EXISTS person_ask_settings;
--   DROP TABLE IF EXISTS ask_flags; ALTER TABLE ai_feedback DROP COLUMN detail_json;
--   DELETE FROM d1_migrations WHERE name = '0066_ask.sql';
CREATE TABLE IF NOT EXISTS chat_threads (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  handle           TEXT NOT NULL COLLATE NOCASE,
  title            TEXT NOT NULL DEFAULT '',
  mode             TEXT NOT NULL DEFAULT 'smart' CHECK (mode IN ('fast', 'smart', 'thinking')),
  origin           TEXT NOT NULL DEFAULT 'page' CHECK (origin IN ('page', 'panel')),
  context_ref      TEXT,
  pinned           INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  auto_mode        INTEGER NOT NULL DEFAULT 0 CHECK (auto_mode IN (0, 1)),
  draft            TEXT NOT NULL DEFAULT '',
  summary          TEXT NOT NULL DEFAULT '',
  summary_through  INTEGER NOT NULL DEFAULT 0,
  turn             INTEGER NOT NULL DEFAULT 0,
  stop_requested   INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0, 1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_owner ON chat_threads (org_id, handle, pinned, updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id            TEXT NOT NULL REFERENCES orgs(id),
  thread_id         INTEGER NOT NULL REFERENCES chat_threads(id),
  role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  mode              TEXT NOT NULL CHECK (mode IN ('fast', 'smart', 'thinking')),
  content_json      TEXT NOT NULL DEFAULT '{}',
  cites_json        TEXT NOT NULL DEFAULT '[]',
  attachments_json  TEXT NOT NULL DEFAULT '[]',
  model             TEXT,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  tokens_cached     INTEGER NOT NULL DEFAULT 0,
  units             INTEGER NOT NULL DEFAULT 0,
  stopped           INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1)),
  replaced_at       TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (org_id, thread_id, id);

-- Standalone FTS5 (like tickets_fts), one row per live message, kept by the triggers below.
CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
  message_id UNINDEXED, thread_id UNINDEXED, text, org_id UNINDEXED, tokenize = 'porter unicode61');
CREATE TRIGGER IF NOT EXISTS chat_fts_ai AFTER INSERT ON chat_messages WHEN new.replaced_at IS NULL BEGIN
  INSERT INTO chat_fts (message_id, thread_id, text, org_id)
    VALUES (CAST(new.id AS TEXT), CAST(new.thread_id AS TEXT), COALESCE(json_extract(new.content_json, '$.text'), ''), new.org_id);
END;
CREATE TRIGGER IF NOT EXISTS chat_fts_au AFTER UPDATE OF content_json ON chat_messages WHEN new.replaced_at IS NULL BEGIN
  DELETE FROM chat_fts WHERE message_id = CAST(new.id AS TEXT) AND org_id = new.org_id;
  INSERT INTO chat_fts (message_id, thread_id, text, org_id)
    VALUES (CAST(new.id AS TEXT), CAST(new.thread_id AS TEXT), COALESCE(json_extract(new.content_json, '$.text'), ''), new.org_id);
END;
-- A replaced message leaves search.
CREATE TRIGGER IF NOT EXISTS chat_fts_replaced AFTER UPDATE OF replaced_at ON chat_messages WHEN new.replaced_at IS NOT NULL BEGIN
  DELETE FROM chat_fts WHERE message_id = CAST(new.id AS TEXT) AND org_id = new.org_id;
END;
CREATE TRIGGER IF NOT EXISTS chat_fts_ad AFTER DELETE ON chat_messages BEGIN
  DELETE FROM chat_fts WHERE message_id = CAST(old.id AS TEXT) AND org_id = old.org_id;
END;

CREATE TABLE IF NOT EXISTS chat_actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  thread_id     INTEGER NOT NULL REFERENCES chat_threads(id),
  message_id    INTEGER,
  turn          INTEGER NOT NULL,
  tool          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('ticket', 'handoff', 'doc_edit', 'move', 'publish', 'sprint', 'other')),
  group_id      TEXT,
  tool_use_id   TEXT NOT NULL DEFAULT '',
  args_json     TEXT NOT NULL DEFAULT '{}',
  preview_json  TEXT NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL CHECK (state IN ('proposed', 'waiting', 'running', 'confirmed', 'auto', 'undone', 'cancelled', 'failed', 'expired')),
  result_json   TEXT,
  undo_json     TEXT,
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_actions_thread ON chat_actions (org_id, thread_id, state);

CREATE TABLE IF NOT EXISTS chat_artifacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  thread_id    INTEGER NOT NULL REFERENCES chat_threads(id),
  artifact_id  INTEGER NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('attachment', 'saved')),
  message_id   INTEGER,
  created_at   TEXT NOT NULL,
  UNIQUE (org_id, thread_id, artifact_id, role)
);

CREATE TABLE IF NOT EXISTS person_ask_settings (
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  handle        TEXT NOT NULL COLLATE NOCASE,
  instructions  TEXT NOT NULL DEFAULT '' CHECK (length(instructions) <= 500),
  default_mode  TEXT CHECK (default_mode IS NULL OR default_mode IN ('fast', 'smart', 'thinking')),
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, handle)
);

CREATE TABLE IF NOT EXISTS ask_flags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  item_ref    TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('source_wrong', 'out_of_date')),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ask_flags_item ON ask_flags (org_id, item_ref);

ALTER TABLE ai_feedback ADD COLUMN detail_json TEXT;

-- ══ part 0067_digest_email ═════════════════════════════════════════════════════════════════════
-- 0067_digest_email: the shorter e-mail, led by the brief (docs/architecture/notifications.md › The digest's shape;
-- docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase E). The base doc reserved this number as
-- `0067_notify_only_when_needed`; it also carries the weekly "This week" highlights, the one other row Phase E stores.
-- ADDITIVE ONLY: two new TENANT tables; nothing existing changes, no row is rewritten, and a Worker from before it
-- keeps working (it names neither).
--
-- PART 1 — notification_person_prefs: a member's e-mail options in one organization that are not a kind's cadence.
-- Today one: "Only when something needs me" (Settings › Email notifications). With it ON, a digest is sent only
-- when the person's brief has a "Next" item (with the AI off: an assigned ticket), or a notable or breaking item
-- touched their work in the window; otherwise the run marks their outbox row `skipped`. No row = OFF.
--   user_id           the member (HANDLE_COLUMNS: a rename rewrites it; an account deletion deletes the person's rows
--                     in every org — src/deletion/person.ts; an org's deletion deletes the org's — ORG_TABLES)
--   only_when_needed  0 / 1
--   updated_at        when the person last changed it
--
-- PART 2 — digest_highlights: the weekly digest's "This week" — at most 3 cited highlights per organization per week,
-- written by the AI pass's `digest.week` job (src/ai/week.ts) through the Message Batches API: ONE request per org
-- per week, shared by every member's weekly e-mail. A computed, DIRECT write (invariant 1); the e-mail reads it
-- (src/notifications/renderers/week-recap.ts) and never calls a model. The last 8 weeks are kept.
--   week_id         the weekly run's window id (`YYYY-Www`, src/notifications/window.ts)
--   generated_at    when the pass wrote it
--   model           the model that wrote it
--   prompt_version  the job's prompt version (`week.1`)
--   highlights_json `[{ text, cites }]` — the server-built cites (shared/ai-core.ts `AiLine`). Checked on every read.
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). It LOSES every member's "only when
-- something needs me" choice (they get every digest again) and the stored highlights (the weekly e-mail then has no
-- "This week" until the next week's are written):
--   DROP TABLE IF EXISTS notification_person_prefs;
--   DROP TABLE IF EXISTS digest_highlights;
--   DELETE FROM d1_migrations WHERE name = '0067_digest_email.sql';
CREATE TABLE IF NOT EXISTS notification_person_prefs (
  org_id            TEXT NOT NULL REFERENCES orgs(id),
  user_id           TEXT NOT NULL,
  only_when_needed  INTEGER NOT NULL DEFAULT 0 CHECK (only_when_needed IN (0, 1)),
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS digest_highlights (
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  week_id          TEXT NOT NULL,
  generated_at     TEXT NOT NULL,
  model            TEXT NOT NULL,
  prompt_version   TEXT NOT NULL,
  highlights_json  TEXT NOT NULL,
  PRIMARY KEY (org_id, week_id)
);

-- ══ part 0068_ask_pending ══════════════════════════════════════════════════════════════════════
-- 0068_ask_pending: an Ask attachment uploaded before its conversation exists is PENDING (the owner's ruling Q60,
-- 2026-10-16; docs/architecture/ask.md › Attachments). Until now such an upload created a visible, untitled thread.
-- Now it is linked (`chat_artifacts`, unsent) to the person's hidden HOLDER thread — `chat_threads.pending = 1` —
-- which no Ask route lists, searches, opens or writes (`getThread`, `listThreads`, `searchThreads` leave it out).
-- Sending the question moves the attachments it names onto the new thread; what is never sent is swept 24 hours
-- after it was uploaded (src/deletion/ask.ts `sweepPendingAskAttachments`, on the hourly digest trigger — no new
-- cron), through the same hard delete as the composer's ✕.
-- ADDITIVE ONLY: one column with a default; no row is rewritten, and a Worker from before it keeps working (it never
-- writes a holder, and reads every existing thread as before, all `pending = 0`). The holder is an ordinary thread
-- row of the person's, so an account's deletion (src/deletion/person.ts) and an org's (ORG_TABLES) already remove it
-- and its attachments; no new table and no new handle column.
--
-- ROLLBACK (by hand, after `wrangler rollback` to the Worker from before it): the holders and their pending files
-- would show as untitled threads — delete them first through the Worker, or accept that, then:
--   ALTER TABLE chat_threads DROP COLUMN pending;
--   DELETE FROM d1_migrations WHERE name = '0068_ask_pending.sql';
ALTER TABLE chat_threads ADD COLUMN pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1));
