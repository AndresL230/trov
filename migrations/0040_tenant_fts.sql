-- Multitenancy (canopy-multitenancy.md, Phase 2) — part 4 of 4: every FTS5 table gets `org_id UNINDEXED`
-- (D9) and every FTS trigger becomes org-scoped.
--
-- org_id is the LAST column, never the first: the readers weight bm25 by column POSITION
-- (`bm25(docs_fts, 1.0, 5.0, …)`) and pick snippet columns by number (`snippet(tickets_fts, 2, …)`), so a
-- leading column would silently shift every ranking. An UNINDEXED trailing column takes the default
-- weight and contributes nothing to the match.
--
-- Why every trigger changes (audit F-1): `docs_fts` and `prompts_fts` are keyed by slug and
-- `roadmap_fts`'s plan row by the literal 'plan' — keys that are per-org now. An unscoped
-- `DELETE … WHERE slug = new.slug` would delete ANOTHER org's search row.
--
-- The indexes are rebuilt from their base tables exactly as the creating migrations did, except
-- artifacts_fts, which the repository maintains (it strips tags the SQL cannot): its rows are carried over
-- verbatim through a holding table and gain the page's org.

-- ── drop every FTS trigger (some already went with 0039's rebuilt tables) ────
DROP TRIGGER IF EXISTS docs_fts_ai;
DROP TRIGGER IF EXISTS docs_fts_au;
DROP TRIGGER IF EXISTS docs_fts_ad;
DROP TRIGGER IF EXISTS feed_fts_ai;
DROP TRIGGER IF EXISTS feed_fts_ad;
DROP TRIGGER IF EXISTS adrs_fts_ai;
DROP TRIGGER IF EXISTS adrs_fts_ad;
DROP TRIGGER IF EXISTS roadmap_fts_plan_au;
DROP TRIGGER IF EXISTS roadmap_fts_sprint_ai;
DROP TRIGGER IF EXISTS roadmap_fts_sprint_au;
DROP TRIGGER IF EXISTS roadmap_fts_sprint_ad;
DROP TRIGGER IF EXISTS tickets_fts_ai;
DROP TRIGGER IF EXISTS tickets_fts_au;
DROP TRIGGER IF EXISTS tickets_fts_ad;
DROP TRIGGER IF EXISTS prompts_fts_ai;
DROP TRIGGER IF EXISTS prompts_fts_au;
DROP TRIGGER IF EXISTS prompts_fts_ad;
DROP TRIGGER IF EXISTS prompts_fts_vai;
DROP TRIGGER IF EXISTS prompts_fts_vau;
DROP TRIGGER IF EXISTS artifacts_fts_ad;

-- ── artifacts_fts: hold the repository-written rows ──────────────────────────
DROP TABLE IF EXISTS _mt_artifacts_fts_hold;
CREATE TABLE _mt_artifacts_fts_hold (page_id TEXT, title TEXT, description TEXT, body TEXT);
INSERT INTO _mt_artifacts_fts_hold (page_id, title, description, body)
  SELECT page_id, title, description, body FROM artifacts_fts;

-- ── re-create the seven tables ───────────────────────────────────────────────
DROP TABLE IF EXISTS docs_fts;
DROP TABLE IF EXISTS feed_fts;
DROP TABLE IF EXISTS adrs_fts;
DROP TABLE IF EXISTS roadmap_fts;
DROP TABLE IF EXISTS tickets_fts;
DROP TABLE IF EXISTS prompts_fts;
DROP TABLE IF EXISTS artifacts_fts;

CREATE VIRTUAL TABLE docs_fts USING fts5(
  slug UNINDEXED, title, section UNINDEXED, body, org_id UNINDEXED, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE feed_fts USING fts5(
  feed_id UNINDEXED, summary, body, org_id UNINDEXED, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE adrs_fts USING fts5(
  adr_id UNINDEXED, title, context, decision, rationale, org_id UNINDEXED, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE roadmap_fts USING fts5(
  ref UNINDEXED, title, body, org_id UNINDEXED, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE tickets_fts USING fts5(
  ticket_id UNINDEXED, title, body, org_id UNINDEXED, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE prompts_fts USING fts5(
  slug, title, description, body, tags, org_id UNINDEXED, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE artifacts_fts USING fts5(
  page_id UNINDEXED, title, description, body, org_id UNINDEXED, tokenize = 'porter unicode61');

-- ── docs ─────────────────────────────────────────────────────────────────────
CREATE TRIGGER docs_fts_ai AFTER INSERT ON docs BEGIN
  DELETE FROM docs_fts WHERE slug = new.slug AND org_id = new.org_id;
  INSERT INTO docs_fts (slug, title, section, body, org_id) VALUES (new.slug, new.title, new.section, new.body, new.org_id);
END;
CREATE TRIGGER docs_fts_au AFTER UPDATE OF title, section, body ON docs BEGIN
  DELETE FROM docs_fts WHERE slug = new.slug AND org_id = new.org_id;
  INSERT INTO docs_fts (slug, title, section, body, org_id) VALUES (new.slug, new.title, new.section, new.body, new.org_id);
END;
CREATE TRIGGER docs_fts_ad AFTER DELETE ON docs BEGIN
  DELETE FROM docs_fts WHERE slug = old.slug AND org_id = old.org_id;
END;
INSERT INTO docs_fts (slug, title, section, body, org_id) SELECT slug, title, section, body, org_id FROM docs;

-- ── feed, adrs ───────────────────────────────────────────────────────────────
CREATE TRIGGER feed_fts_ai AFTER INSERT ON feed BEGIN
  INSERT INTO feed_fts (feed_id, summary, body, org_id) VALUES (CAST(new.id AS TEXT), new.summary, new.body, new.org_id);
END;
CREATE TRIGGER feed_fts_ad AFTER DELETE ON feed BEGIN
  DELETE FROM feed_fts WHERE feed_id = CAST(old.id AS TEXT) AND org_id = old.org_id;
END;
INSERT INTO feed_fts (feed_id, summary, body, org_id) SELECT CAST(id AS TEXT), summary, body, org_id FROM feed;

CREATE TRIGGER adrs_fts_ai AFTER INSERT ON adrs BEGIN
  INSERT INTO adrs_fts (adr_id, title, context, decision, rationale, org_id)
    VALUES (CAST(new.id AS TEXT), new.title, new.context, new.decision, new.rationale, new.org_id);
END;
CREATE TRIGGER adrs_fts_ad AFTER DELETE ON adrs BEGIN
  DELETE FROM adrs_fts WHERE adr_id = CAST(old.id AS TEXT) AND org_id = old.org_id;
END;
INSERT INTO adrs_fts (adr_id, title, context, decision, rationale, org_id)
  SELECT CAST(id AS TEXT), title, context, decision, rationale, org_id FROM adrs;

-- ── roadmap: one plan row PER ORG, plus sprints ─────────────────────────────
CREATE TRIGGER roadmap_fts_plan_au AFTER UPDATE OF narrative ON plan BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'plan' AND org_id = new.org_id;
  INSERT INTO roadmap_fts (ref, title, body, org_id)
    SELECT 'plan', 'Roadmap plan', new.narrative, new.org_id WHERE new.narrative != '';
END;
CREATE TRIGGER roadmap_fts_sprint_ai AFTER INSERT ON sprints BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'sprint:' || new.id AND org_id = new.org_id;
  INSERT INTO roadmap_fts (ref, title, body, org_id)
    VALUES ('sprint:' || new.id, new.title,
            COALESCE(new.description, '') || ' ' || COALESCE(new.summary, '') || ' ' ||
            COALESCE(new.phase, '') || ' ' || COALESCE(new.status, ''), new.org_id);
END;
CREATE TRIGGER roadmap_fts_sprint_au AFTER UPDATE OF title, description, summary, phase, status ON sprints BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'sprint:' || new.id AND org_id = new.org_id;
  INSERT INTO roadmap_fts (ref, title, body, org_id)
    VALUES ('sprint:' || new.id, new.title,
            COALESCE(new.description, '') || ' ' || COALESCE(new.summary, '') || ' ' ||
            COALESCE(new.phase, '') || ' ' || COALESCE(new.status, ''), new.org_id);
END;
CREATE TRIGGER roadmap_fts_sprint_ad AFTER DELETE ON sprints BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'sprint:' || old.id AND org_id = old.org_id;
END;
INSERT INTO roadmap_fts (ref, title, body, org_id)
  SELECT 'plan', 'Roadmap plan', narrative, org_id FROM plan WHERE narrative != '';
INSERT INTO roadmap_fts (ref, title, body, org_id)
  SELECT 'sprint:' || id, title,
         COALESCE(description, '') || ' ' || COALESCE(summary, '') || ' ' ||
         COALESCE(phase, '') || ' ' || COALESCE(status, ''), org_id
    FROM sprints;

-- ── tickets ──────────────────────────────────────────────────────────────────
CREATE TRIGGER tickets_fts_ai AFTER INSERT ON tickets BEGIN
  DELETE FROM tickets_fts WHERE ticket_id = CAST(new.id AS TEXT) AND org_id = new.org_id;
  INSERT INTO tickets_fts (ticket_id, title, body, org_id) VALUES (CAST(new.id AS TEXT), new.title, new.body, new.org_id);
END;
CREATE TRIGGER tickets_fts_au AFTER UPDATE OF title, body ON tickets BEGIN
  DELETE FROM tickets_fts WHERE ticket_id = CAST(new.id AS TEXT) AND org_id = new.org_id;
  INSERT INTO tickets_fts (ticket_id, title, body, org_id) VALUES (CAST(new.id AS TEXT), new.title, new.body, new.org_id);
END;
CREATE TRIGGER tickets_fts_ad AFTER DELETE ON tickets BEGIN
  DELETE FROM tickets_fts WHERE ticket_id = CAST(old.id AS TEXT) AND org_id = old.org_id;
END;
INSERT INTO tickets_fts (ticket_id, title, body, org_id) SELECT CAST(id AS TEXT), title, body, org_id FROM tickets;

-- ── prompts: the LATEST version, live (not soft-deleted) prompts only (0035 PART C) ──
CREATE TRIGGER prompts_fts_ai AFTER INSERT ON prompts BEGIN
  DELETE FROM prompts_fts WHERE slug = new.slug AND org_id = new.org_id;
  INSERT INTO prompts_fts (slug, title, description, body, tags, org_id)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags, p.org_id
    FROM prompts p LEFT JOIN prompt_versions v ON v.org_id = p.org_id AND v.slug = p.slug AND v.version = p.current_version
    WHERE p.org_id = new.org_id AND p.slug = new.slug AND p.deleted_at IS NULL;
END;
CREATE TRIGGER prompts_fts_au AFTER UPDATE OF slug, title, description, tags, current_version, deleted_at ON prompts BEGIN
  DELETE FROM prompts_fts WHERE slug = old.slug AND org_id = old.org_id;
  DELETE FROM prompts_fts WHERE slug = new.slug AND org_id = new.org_id;
  INSERT INTO prompts_fts (slug, title, description, body, tags, org_id)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags, p.org_id
    FROM prompts p LEFT JOIN prompt_versions v ON v.org_id = p.org_id AND v.slug = p.slug AND v.version = p.current_version
    WHERE p.org_id = new.org_id AND p.slug = new.slug AND p.deleted_at IS NULL;
END;
CREATE TRIGGER prompts_fts_ad AFTER DELETE ON prompts BEGIN
  DELETE FROM prompts_fts WHERE slug = old.slug AND org_id = old.org_id;
END;
CREATE TRIGGER prompts_fts_vai AFTER INSERT ON prompt_versions BEGIN
  DELETE FROM prompts_fts WHERE slug = new.slug AND org_id = new.org_id;
  INSERT INTO prompts_fts (slug, title, description, body, tags, org_id)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags, p.org_id
    FROM prompts p LEFT JOIN prompt_versions v ON v.org_id = p.org_id AND v.slug = p.slug AND v.version = p.current_version
    WHERE p.org_id = new.org_id AND p.slug = new.slug AND p.deleted_at IS NULL;
END;
CREATE TRIGGER prompts_fts_vau AFTER UPDATE ON prompt_versions BEGIN
  DELETE FROM prompts_fts WHERE slug = new.slug AND org_id = new.org_id;
  INSERT INTO prompts_fts (slug, title, description, body, tags, org_id)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags, p.org_id
    FROM prompts p LEFT JOIN prompt_versions v ON v.org_id = p.org_id AND v.slug = p.slug AND v.version = p.current_version
    WHERE p.org_id = new.org_id AND p.slug = new.slug AND p.deleted_at IS NULL;
END;
INSERT INTO prompts_fts (slug, title, description, body, tags, org_id)
  SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags, p.org_id
  FROM prompts p LEFT JOIN prompt_versions v ON v.org_id = p.org_id AND v.slug = p.slug AND v.version = p.current_version
  WHERE p.deleted_at IS NULL;

-- ── artifacts: the repository's rows, carried over with their page's org ─────
CREATE TRIGGER artifacts_fts_ad AFTER DELETE ON artifact_pages BEGIN
  DELETE FROM artifacts_fts WHERE page_id = CAST(old.id AS TEXT) AND org_id = old.org_id;
END;
INSERT INTO artifacts_fts (page_id, title, description, body, org_id)
  SELECT h.page_id, h.title, h.description, h.body, p.org_id
    FROM _mt_artifacts_fts_hold h JOIN artifact_pages p ON p.id = CAST(h.page_id AS INTEGER);
DROP TABLE _mt_artifacts_fts_hold;
