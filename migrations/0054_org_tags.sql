-- 0054_org_tags — ONE tag list per organization, phase 1 (docs/architecture/feed-and-search.md › Tags).
--
-- Until now a feed entry's tags came from six words fixed for every org: the global `tags` table
-- (0001, seeded by 0002_seed_vocab) that `entry_tags.tag` REFERENCES. An org could not have a tag of
-- its own, and an agent's entry with any other word was sent whole to needs_triage.
--
--   before   tags(tag)                       global, six rows, the gate's whole tag vocabulary
--            entry_tags.tag REFERENCES tags  so no other word can be stored
--   after    org_tags                        the org's own list: name, one-line description, colour;
--                                            every org starts with the six (`starter = 1`)
--            org_tag_suggestions             a tag someone thinks an item should carry — one row per
--                                            item. Phase 1: a tag an agent sent that is not on the
--                                            list, until an admin accepts, maps or dismisses it
--            org_ai_settings                 an organization's switches for model suggestions (issue
--                                            #158): one row per kind, OFF unless an admin turned it on
--            org_tag_runs                    each run of "which existing items fit this tag" (the
--                                            model's side of org_tag_suggestions): one at a time per tag
--            entry_tags                      the same table and rows, WITHOUT the reference to `tags`:
--                                            what may be stored is the gate's rule (src/tools/tags.ts),
--                                            read from org_tags
--
-- `tags` itself stays, with its six rows: 0002 and shared/vocabulary.ts still agree on it, and it now
-- names the STARTER set, not the vocabulary. Nothing reads it after this migration.
--
-- WHY entry_tags IS REBUILT. SQLite cannot drop a foreign key, and with it in place an org's own tag
-- could only be stored by also writing it to the global `tags` table — one org's word in a table every
-- org shares. So the table is rebuilt (create *_new, copy, drop, rename) exactly as 0042_organizations
-- built it, minus `REFERENCES tags(tag)`: same columns, same defaults, same primary key, same index.
-- No reference is added to org_tags on purpose (see the next paragraph).
--
-- SAFE ON LIVE DATA. Nothing references entry_tags (it is only ever a child), it has no trigger and no
-- view, and it is small (a few rows per feed entry). Every row is copied; a guard refuses the swap —
-- failing the whole migration, which D1 applies as one transaction — unless the copy holds exactly the
-- rows of the original. Every tag stored today is one of the six (the old reference guaranteed it), and
-- every existing org is given those six, so every stored tag is on its org's list afterwards.
--
-- SAFE ON THE WORKER FROM BEFORE IT. That Worker writes `INSERT OR IGNORE INTO entry_tags (org_id, tag,
-- entry_type, entry_id)` and reads by `tag`: both work unchanged on the rebuilt table, and it only ever
-- stores the six words. It never names org_tags or org_tag_suggestions. An org it creates between this
-- migration and the new Worker has no org_tags rows yet: there is no reference from entry_tags to trip,
-- and the new Worker seeds the six the first time it reads an org that has none
-- (src/tools/tags.ts `tagRows`).
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). The old Worker needs the
-- reference back only for tidiness — it works without it — but its gate knows six words, so first drop
-- what it cannot have written:
--   DELETE FROM entry_tags WHERE tag NOT IN (SELECT tag FROM tags);   -- an org's own tags leave their items
--   PRAGMA defer_foreign_keys = true;
--   CREATE TABLE entry_tags_old (
--     org_id TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id), tag TEXT NOT NULL REFERENCES tags(tag),
--     entry_type TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY (org_id, tag, entry_type, entry_id));
--   INSERT INTO entry_tags_old SELECT org_id, tag, entry_type, entry_id FROM entry_tags;
--   DROP TABLE entry_tags; ALTER TABLE entry_tags_old RENAME TO entry_tags;
--   CREATE INDEX idx_entry_tags_lookup ON entry_tags(entry_type, entry_id);
--   PRAGMA defer_foreign_keys = false;
--   DROP TABLE IF EXISTS org_tag_runs; DROP TABLE IF EXISTS org_ai_settings;
--   DROP TABLE IF EXISTS org_tag_suggestions; DROP TABLE IF EXISTS org_tags;
--   DELETE FROM org_admin_audit WHERE action LIKE 'tag.%';
--   DELETE FROM d1_migrations WHERE name = '0054_org_tags.sql';
-- A starter tag an admin RENAMED is, to the old Worker, an unknown word: its rows are the ones the first
-- statement deletes. Rename it back before rolling back to keep them.

-- ── the org's list ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  name        TEXT NOT NULL,                 -- lowercase letters, digits, hyphens (shared/tags-core.ts normalizeTagName)
  description TEXT NOT NULL DEFAULT '',      -- one line: what it is for
  color       TEXT NOT NULL DEFAULT 'slate', -- a key of shared/tags-core.ts TAG_COLORS
  starter     INTEGER NOT NULL DEFAULT 0,    -- one of the six every org starts with: renamed, never retired or merged away
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  updated_at  TEXT,
  updated_by  TEXT,
  retired_at  TEXT,                          -- retired: stays on what has it, can no longer be picked
  retired_by  TEXT,
  merged_into TEXT                           -- retired by a merge: the tag its items moved to (an agent that still sends this name gets that one)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_tags_name ON org_tags(org_id, name);

-- The six starters, for every org that exists now (a new org gets them from src/orgs/repo.ts createOrg).
-- The same rows as shared/tags-core.ts STARTER_TAGS — test/tags.migration.test.ts compares them.
-- One statement per tag, in list order: D1 allows at most five terms in a compound SELECT, so the six
-- cannot be one UNION ALL.
INSERT OR IGNORE INTO org_tags (org_id, name, description, color, starter, created_at, created_by)
  SELECT id, 'auth', 'Sign-in, sessions, tokens, permissions', 'plum', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration' FROM orgs ORDER BY id;
INSERT OR IGNORE INTO org_tags (org_id, name, description, color, starter, created_at, created_by)
  SELECT id, 'architecture', 'How the system is put together', 'slate', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration' FROM orgs ORDER BY id;
INSERT OR IGNORE INTO org_tags (org_id, name, description, color, starter, created_at, created_by)
  SELECT id, 'infra', 'Deploys, hosting, CI', 'rust', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration' FROM orgs ORDER BY id;
INSERT OR IGNORE INTO org_tags (org_id, name, description, color, starter, created_at, created_by)
  SELECT id, 'api', 'Routes and what they return', 'sky', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration' FROM orgs ORDER BY id;
INSERT OR IGNORE INTO org_tags (org_id, name, description, color, starter, created_at, created_by)
  SELECT id, 'ui', 'Screens and components', 'rose', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration' FROM orgs ORDER BY id;
INSERT OR IGNORE INTO org_tags (org_id, name, description, color, starter, created_at, created_by)
  SELECT id, 'data', 'Tables, migrations, storage', 'fern', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration' FROM orgs ORDER BY id;

-- ── suggestions: a tag someone (an agent now, a model later) thinks an item should carry ────────
-- One row per ITEM and suggested tag — never a per-name counter — so the same table holds both kinds:
--   • an AGENT sent a tag that is not on the org's list (phase 1, `source = 'agent'`): the item was
--     saved without it. Org settings › Tags groups the open rows by `tag` ("Suggested by agents").
--   • a MODEL judges that an item should carry a tag that IS on the list, or which existing items a
--     new tag fits (`source = 'model'`; issues #154–#158, #166 — nothing writes these yet). The
--     columns it needs are here now so that work lands without a rebuild: `confidence`, a one-sentence
--     `reason`, the `model` and `prompt_version` that produced it, and `superseded` for a re-run.
-- A suggestion is NEVER the tag itself (#156): the item's tags are entry_tags, set by a person or by
-- the gate from the org's list. Accepting is an ordinary authored write by the admin who accepts:
-- it writes entry_tags and marks the row. `resolved_to` is the tag the item was given — the suggested
-- one, or another the admin mapped it to. `state`, as #156: open | accepted | dismissed | superseded.
CREATE TABLE IF NOT EXISTS org_tag_suggestions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id         TEXT NOT NULL REFERENCES orgs(id),
  entry_type     TEXT NOT NULL,               -- the item: as entry_tags (feed | doc | adr; more in phase 2)
  entry_id       TEXT NOT NULL,
  tag            TEXT NOT NULL,               -- the suggested tag's text (normalized); on the list or not
  source         TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent', 'model')),
  confidence     REAL,                        -- a model's, 0–1; NULL for an agent
  reason         TEXT,                        -- one sentence; NULL for an agent
  model          TEXT,
  prompt_version TEXT,
  suggested_by   TEXT NOT NULL,               -- the person whose agent sent it; 'system' for a model
  suggested_at   TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'dismissed', 'superseded')),
  resolved_to    TEXT,
  resolved_at    TEXT,
  resolved_by    TEXT
);
-- At most ONE open suggestion of a tag on an item per source: a replay records nothing new, and a
-- re-run supersedes the old row before writing its own. Settled rows are history and may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_tag_suggestions_open ON org_tag_suggestions(org_id, source, entry_type, entry_id, tag) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_org_tag_suggestions_tag ON org_tag_suggestions(org_id, state, tag);
CREATE INDEX IF NOT EXISTS idx_org_tag_suggestions_item ON org_tag_suggestions(org_id, entry_type, entry_id, state);

-- ── the organization's switches for model suggestions (issue #158) ───────────
-- OFF unless an admin of the org turned the kind on: no row, or `enabled = 0`, means nothing of the org's
-- is ever sent to a model for that kind. Phase 1 has one kind, `tag.fit` ("does this item fit this tag?",
-- src/tools/tag-fit.ts). Capture-time PR / issue summaries are NOT behind this switch (they predate it
-- and the Privacy Policy names them separately).
CREATE TABLE IF NOT EXISTS org_ai_settings (
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  kind       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (org_id, kind)
);

-- ── one run of "which existing items fit this tag" ───────────────────────────
-- Started when an admin adds a tag (or accepts a suggested one) and by "Find items" — in the background,
-- never on a page load. ONE running row per tag (the partial unique index): a second start while one runs
-- is refused. A run supersedes the tag's open MODEL suggestions, then writes its own (source = 'model').
-- `status`: running → done | capped (the month's `ai_suggestions` allowance ran out) | failed.
CREATE TABLE IF NOT EXISTS org_tag_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  tag         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'capped', 'failed')),
  started_by  TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  candidates  INTEGER NOT NULL DEFAULT 0,   -- items pre-selected without the model (the org's own FTS)
  calls       INTEGER NOT NULL DEFAULT 0,   -- model calls made (each counted against the allowance; a retry is a call)
  checked     INTEGER NOT NULL DEFAULT 0,   -- candidates the model has answered about (or failed on) so far
  suggested   INTEGER NOT NULL DEFAULT 0    -- "fits" judgements stored as suggestions
  -- candidates / calls / checked / suggested are written AS THE RUN GOES (one small UPDATE per answer), so
  -- the Tags tab can show it live (GET …/tags/:name/run).
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_tag_runs_running ON org_tag_runs(org_id, tag) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_org_tag_runs_tag ON org_tag_runs(org_id, tag, id);

-- ── entry_tags without the reference to the global `tags` ────────────────────
PRAGMA defer_foreign_keys = true;

CREATE TABLE entry_tags_new (
  org_id     TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id),
  tag        TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  entry_id   TEXT NOT NULL,
  PRIMARY KEY (org_id, tag, entry_type, entry_id)
);
INSERT INTO entry_tags_new (org_id, tag, entry_type, entry_id) SELECT org_id, tag, entry_type, entry_id FROM entry_tags;

-- Guard: the copy holds every row, and every stored tag is on its org's list. A violation fails the
-- INSERT's CHECK, and with it the migration, before anything is dropped.
CREATE TABLE _org_tags_guard (violations INTEGER NOT NULL CHECK (violations = 0));
INSERT INTO _org_tags_guard (violations) SELECT
    ABS((SELECT COUNT(*) FROM entry_tags) - (SELECT COUNT(*) FROM entry_tags_new))
  + (SELECT COUNT(*) FROM entry_tags e WHERE NOT EXISTS (SELECT 1 FROM org_tags t WHERE t.org_id = e.org_id AND t.name = e.tag));
DROP TABLE _org_tags_guard;

DROP TABLE entry_tags;
ALTER TABLE entry_tags_new RENAME TO entry_tags;
CREATE INDEX idx_entry_tags_lookup ON entry_tags(entry_type, entry_id);
-- An item's own tags, within its org (the feed read, a doc's page).
CREATE INDEX IF NOT EXISTS idx_entry_tags_item ON entry_tags(org_id, entry_type, entry_id);

PRAGMA defer_foreign_keys = false;
