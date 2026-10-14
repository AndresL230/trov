-- 0055_ai: the AI base (docs/architecture/ai.md) — the organization's AI switch, and the tables for what the
-- model suggests and the "Wrong?" people press. ADDITIVE ONLY: one column on `orgs` and two new TENANT tables;
-- nothing existing changes, no row is rewritten, and a Worker from before it keeps working (it names none of them).
--
-- PART 1 — orgs.ai_automation, the AI switch (organizations.md › Org settings › AI).
-- An admin turns it off in Org settings › AI (`PUT /api/o/:slug/ai/settings`, a cookie route — never MCP);
-- while it is off the AI pass (src/ai/pass.ts) makes no model call for the org and the screens show
-- nothing it would write. It does NOT govern the capture-time PR / issue summaries, which have their own
-- allowance (`ai_summaries`, plans.md › AI summaries). ON for every org (existing and new).
--
-- PART 2 — ai_suggestions and ai_feedback. Every statement names `org_id` (src/data/ai.ts). Nothing WRITES a
-- suggestion yet: no producer exists, so `ai_suggestions` stays empty until one ships; the routes that answer
-- one (`POST /api/o/:slug/ai/suggestions/:id/accept|dismiss`) are cookie-only.
--
-- ai_suggestions — one suggested value for one field of one item ("Suggested: <label>, because <reason>").
--   item_type, item_ref  the item it is about (`ticket` + its NUMBER, `theme` + a lane id, …)
--   kind                 what is suggested — the accept handler's key (src/ai/suggestions.ts)
--   value_json           the kind's own value; accepting writes it to the real field AS the person
--   confidence           0..1 when the model gave one; NULL = none given
--   reason               why — NOT NULL: a suggestion with no reason is never stored or shown
--   cites_json           the sources it was written from (shared/ai-core.ts `AiCite[]`)
--   model, prompt_version  what wrote it
--   state                open → accepted | dismissed (a person's decision, remembered) | superseded (the
--                        same kind re-run for the same item: the open one is replaced, never piled up)
--   decided_by           a handle (HANDLE_COLUMNS), who accepted or dismissed it; NULL while open
--
-- ai_feedback — "Wrong?" on something Trov wrote: it HIDES that item for the person who pressed it (the
-- producers read `hiddenFor`), and never edits the record. One row per (person, item): pressing again
-- writes nothing new.
--   handle               a handle (HANDLE_COLUMNS) — always the signed-in person
--   item_type, item_ref  shared/ai-core.ts AI_ITEM_TYPES, and the item's own ref
--   kind, model, prompt_version  what wrote it, for the accept / dismiss / "Wrong?" rates per kind
--
-- ROLLBACK (by hand, with `wrangler rollback` to the Worker from before it). It LOSES the admins' switch
-- choices, every suggestion and every "Wrong?":
--   DROP INDEX IF EXISTS idx_ai_suggestions_item;
--   DROP INDEX IF EXISTS idx_ai_suggestions_state;
--   DROP TABLE IF EXISTS ai_suggestions;
--   DROP TABLE IF EXISTS ai_feedback;
--   ALTER TABLE orgs DROP COLUMN ai_automation;
--   DELETE FROM d1_migrations WHERE name = '0055_ai.sql';
ALTER TABLE orgs ADD COLUMN ai_automation INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id         TEXT NOT NULL REFERENCES orgs(id),
  item_type      TEXT NOT NULL,
  item_ref       TEXT NOT NULL,
  kind           TEXT NOT NULL,
  value_json     TEXT NOT NULL,
  confidence     REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  reason         TEXT NOT NULL CHECK (length(reason) > 0),
  cites_json     TEXT NOT NULL DEFAULT '[]',
  model          TEXT,
  prompt_version TEXT,
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'dismissed', 'superseded')),
  created_at     TEXT NOT NULL,
  decided_by     TEXT,                                 -- a handle (HANDLE_COLUMNS)
  decided_at     TEXT
);
-- An item's suggestions by state (the screen's "open" ones; the producer's supersede of the same kind).
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_item ON ai_suggestions(org_id, item_type, item_ref, state);
-- Accept / dismiss / supersede rates per kind (Platform, later).
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_state ON ai_suggestions(org_id, kind, state);

CREATE TABLE IF NOT EXISTS ai_feedback (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id         TEXT NOT NULL REFERENCES orgs(id),
  handle         TEXT NOT NULL COLLATE NOCASE,         -- a handle (HANDLE_COLUMNS)
  item_type      TEXT NOT NULL,
  item_ref       TEXT NOT NULL,
  kind           TEXT NOT NULL,
  model          TEXT,
  prompt_version TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (org_id, handle, item_type, item_ref)
);
