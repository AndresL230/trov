import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, run, nowIso } from "./helpers/db";
import { RESET_STATEMENTS } from "../scripts/seed/reset.mjs";

// Isolation proof for migration 0008_fts.sql.
//
// The *_fts virtual tables are populated by AFTER INSERT triggers and cleared by
// AFTER DELETE triggers on their base tables. The test harness truncates the base
// data tables (docs/feed/adrs) `beforeEach` — so for the FTS index to stay clean
// across tests, those delete-triggers must cascade `DELETE FROM <base>` into the
// matching `*_fts` table. These tests prove (a) the index starts empty every test
// (no leak from a prior test) and (b) the harness's exact truncation statement
// leaves zero leaked FTS rows.

// The EXACT statement test/apply-migrations.ts runs beforeEach — imported, not
// hand-duplicated, so it can never drift from the real reset.
const HARNESS_TRUNCATION = RESET_STATEMENTS.join("; ") + ";";

async function ftsCounts() {
  const docs = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM docs_fts`);
  const feed = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM feed_fts`);
  const adrs = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM adrs_fts`);
  // roadmap_fts (0013, re-keyed in 0025): sprints cascade via AFTER DELETE; the plan singleton is
  // reset by the harness's `UPDATE plan SET narrative=''`, whose trigger clears its row.
  const roadmap = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM roadmap_fts`);
  return { docs: docs[0].n, feed: feed[0].n, adrs: adrs[0].n, roadmap: roadmap[0].n };
}

describe("FTS5 migration 0008 — tables, triggers, harness isolation", () => {
  it("creates all *_fts virtual tables and they start empty (beforeEach truncation left no leak)", async () => {
    const counts = await ftsCounts();
    expect(counts).toEqual({ docs: 0, feed: 0, adrs: 0, roadmap: 0 });
  });

  it("AFTER INSERT triggers mirror base rows into the *_fts index", async () => {
    const now = nowIso();
    await run(env.DB, `INSERT INTO docs (slug, section, title, body, current_version, updated_at, updated_by) VALUES ('iso-doc', 'reference', 'Iso Doc', 'searchable doc body', 1, ?, 'tester')`, now);
    await run(env.DB, `INSERT INTO feed (author, summary, body, artifacts, created_at) VALUES ('tester', 'iso feed', 'searchable feed body', NULL, ?)`, now);
    await run(env.DB, `INSERT INTO adrs (title, context, decision, rationale, status, confidence, created_at, created_by) VALUES ('Iso ADR', 'ctx', 'dec', 'why', 'draft', 'high', ?, 'tester')`, now);
    await run(env.DB, `INSERT INTO sprints (title, description, target_date, status, created_at, created_by) VALUES ('Iso Sprint', 'd', '2026-08-01', 'upcoming', ?, 'tester')`, now);
    await run(env.DB, `UPDATE plan SET narrative = 'iso narrative' WHERE org_id = 'org_saplinglearn'`);

    expect(await ftsCounts()).toEqual({ docs: 1, feed: 1, adrs: 1, roadmap: 2 });
  });

  it("the harness truncation statement cascades into *_fts (delete-triggers, no leaked rows)", async () => {
    const now = nowIso();
    await run(env.DB, `INSERT INTO docs (slug, section, title, body, current_version, updated_at, updated_by) VALUES ('iso-doc-2', 'reference', 'Iso Doc 2', 'body', 1, ?, 'tester')`, now);
    await run(env.DB, `INSERT INTO feed (author, summary, body, artifacts, created_at) VALUES ('tester', 'iso feed 2', 'body', NULL, ?)`, now);
    await run(env.DB, `INSERT INTO adrs (title, context, decision, rationale, status, confidence, created_at, created_by) VALUES ('Iso ADR 2', 'c', 'd', 'r', 'draft', 'high', ?, 'tester')`, now);
    await run(env.DB, `INSERT INTO sprints (title, description, target_date, status, created_at, created_by) VALUES ('Iso Sprint 2', 'd', '2026-08-01', 'upcoming', ?, 'tester')`, now);
    await run(env.DB, `UPDATE plan SET narrative = 'iso narrative 2' WHERE org_id = 'org_saplinglearn'`);
    expect(await ftsCounts()).toEqual({ docs: 1, feed: 1, adrs: 1, roadmap: 2 });

    // Run the EXACT statement test/apply-migrations.ts runs beforeEach.
    await env.DB.exec(HARNESS_TRUNCATION);

    // roadmap_fts: the sprint DELETE cascades out; the plan UPDATE-to-'' clears its row.
    expect(await ftsCounts()).toEqual({ docs: 0, feed: 0, adrs: 0, roadmap: 0 });
  });

  it("AFTER UPDATE OF body re-indexes a doc (promote path makes a doc newly searchable)", async () => {
    const now = nowIso();
    // A freshly-proposed doc is created with an empty live body (current_version 0).
    await run(env.DB, `INSERT INTO docs (slug, section, title, body, current_version, updated_at, updated_by) VALUES ('promote-me', 'reference', 'Promote Me', '', 0, ?, 'tester')`, now);
    let hit = await all<{ slug: string }>(env.DB, `SELECT slug FROM docs_fts WHERE docs_fts MATCH 'zebraword'`);
    expect(hit.length).toBe(0);

    // Promote: the body UPDATE fires docs_fts_au and re-indexes the row.
    await run(env.DB, `UPDATE docs SET body = 'now contains zebraword', current_version = 1, updated_at = ?, updated_by = 'tester' WHERE slug = 'promote-me'`, now);
    hit = await all<{ slug: string }>(env.DB, `SELECT slug FROM docs_fts WHERE docs_fts MATCH 'zebraword'`);
    expect(hit.map((r) => r.slug)).toEqual(["promote-me"]);
  });
});
