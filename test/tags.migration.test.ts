/**
 * 0056_org_tags against REAL workerd D1: `MT_DB` (the second, empty database of vitest.config.ts) is
 * wiped, migrated to 0053, loaded with two orgs and tagged feed entries, and then given the migration.
 * The assertions are the header's claims: every org has the six starters, every stored tag survives and
 * is on its org's list, entry_tags no longer references the global `tags`, and the statements the
 * Worker from before it runs still work.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { STARTER_TAGS, TAG_COLORS } from "@shared/tags-core";
import { TAGS } from "@shared/vocabulary";
import { RESET_STATEMENTS } from "../scripts/seed/reset.mjs";
import migrationSql from "../migrations/0056_org_tags.sql?raw";

const MIGRATION = "0056_org_tags.sql";
const db = () => env.MT_DB;
const before = () => env.TEST_MIGRATIONS.filter((m) => m.name < MIGRATION);
const own = () => env.TEST_MIGRATIONS.filter((m) => m.name === MIGRATION);
const q = async <T>(sql: string, ...p: unknown[]) => (await db().prepare(sql).bind(...p).all<T>()).results;

/** Drop everything in MT_DB (as test/migrations.multitenancy.test.ts does). */
async function wipe(): Promise<void> {
  const objs = (await db().prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ type: string; name: string; sql: string | null }>()).results;
  if (!objs.length) return;
  const triggers = objs.filter((o) => o.type === "trigger").map((o) => `DROP TRIGGER IF EXISTS "${o.name}"`);
  const virtual = objs.filter((o) => o.type === "table" && /VIRTUAL TABLE/i.test(o.sql ?? "")).map((o) => o.name);
  const shadow = (n: string) => virtual.some((v) => n.startsWith(`${v}_`));
  const tables = objs.filter((o) => o.type === "table" && !virtual.includes(o.name) && !shadow(o.name)).map((o) => `DROP TABLE IF EXISTS "${o.name}"`);
  await db().batch([
    db().prepare("PRAGMA defer_foreign_keys = true"),
    ...triggers.map((s) => db().prepare(s)),
    ...virtual.map((v) => db().prepare(`DROP TABLE IF EXISTS "${v}"`)),
    ...tables.map((s) => db().prepare(s)),
    db().prepare("PRAGMA defer_foreign_keys = false"),
  ]);
}

const SEED = [
  `INSERT OR IGNORE INTO orgs (id, slug, name, created_at, created_by) VALUES ('org_saplinglearn', 'saplinglearn', 'SaplingLearn', 't', 'migration')`,
  `INSERT INTO orgs (id, slug, name, created_at, created_by) VALUES ('org_two', 'two', 'Two', 't', 'migration')`,
  `INSERT INTO feed (org_id, author, summary, body, created_at) VALUES ('org_saplinglearn', 'andres', 'one', 'b', 't'), ('org_two', 'bea', 'two', 'b', 't')`,
  `INSERT INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES ('org_saplinglearn', 'auth', 'feed', '1'), ('org_saplinglearn', 'ui', 'feed', '1'), ('org_two', 'data', 'feed', '2')`,
];

beforeEach(async () => {
  await wipe();
  await applyD1Migrations(db(), before());
  await db().batch(SEED.map((s) => db().prepare(s)));
});

describe("0056_org_tags", () => {
  it("before it, an org's own word cannot be stored: entry_tags references the six global tags", async () => {
    await expect(db().prepare(`INSERT INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES ('org_two', 'billing', 'feed', '2')`).run()).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("gives every existing org the six starter tags — the rows of STARTER_TAGS, in order", async () => {
    await applyD1Migrations(db(), own());
    for (const org of ["org_saplinglearn", "org_two"]) {
      const rows = await q<{ name: string; description: string; color: string; starter: number; retired_at: string | null; created_by: string }>(
        `SELECT name, description, color, starter, retired_at, created_by FROM org_tags WHERE org_id = ? ORDER BY id`, org);
      expect(rows).toEqual(STARTER_TAGS.map((t) => ({ ...t, starter: 1, retired_at: null, created_by: "migration" })));
    }
  });

  it("keeps every tagged row, and every stored tag is on its org's list", async () => {
    const was = await q(`SELECT org_id, tag, entry_type, entry_id FROM entry_tags ORDER BY org_id, tag`);
    await applyD1Migrations(db(), own());
    expect(await q(`SELECT org_id, tag, entry_type, entry_id FROM entry_tags ORDER BY org_id, tag`)).toEqual(was);
    expect(was.length).toBe(3);
    expect(await q(`SELECT 1 FROM entry_tags e WHERE NOT EXISTS (SELECT 1 FROM org_tags t WHERE t.org_id = e.org_id AND t.name = e.tag)`)).toEqual([]);
  });

  it("entry_tags is the same table minus the reference to `tags`: an org's own tag is stored, the org reference still holds", async () => {
    await applyD1Migrations(db(), own());
    const sql = (await q<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'entry_tags'`))[0].sql;
    expect(sql).not.toMatch(/REFERENCES\s+tags/i);
    expect(sql).toMatch(/org_id\s+TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs\(id\)/);
    expect(sql).toMatch(/PRIMARY KEY \(org_id, tag, entry_type, entry_id\)/);
    expect((await q<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entry_tags' AND name NOT LIKE 'sqlite_%' ORDER BY name`)).map((r) => r.name))
      .toEqual(["idx_entry_tags_item", "idx_entry_tags_lookup"]);
    expect(await q(`SELECT * FROM pragma_foreign_key_check('entry_tags')`)).toEqual([]);

    await db().prepare(`INSERT INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES ('org_two', 'billing', 'feed', '2')`).run();
    await expect(db().prepare(`INSERT INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES ('no_such_org', 'auth', 'feed', '9')`).run()).rejects.toThrow(/FOREIGN KEY/i);
    // No temporary table is left behind.
    expect(await q(`SELECT name FROM sqlite_master WHERE name IN ('entry_tags_new', '_org_tags_guard')`)).toEqual([]);
  });

  it("the Worker from before it keeps working: its feed write, its tag filter, and an org it creates", async () => {
    await applyD1Migrations(db(), own());
    // src/tools/writes.ts append_feed, as it was.
    await db().prepare(`INSERT OR IGNORE INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, ?, 'feed', ?)`).bind("org_two", "infra", "2").run();
    // scripts/seed/build.mjs relies on the column's default.
    await db().prepare(`INSERT INTO entry_tags (tag, entry_type, entry_id) VALUES ('api', 'feed', '1')`).run();
    // src/tools/reads.ts get_feed's join, as it was.
    const rows = await q<{ summary: string }>(
      `SELECT DISTINCT f.* FROM feed f JOIN entry_tags et ON et.org_id = ? AND et.entry_type = 'feed' AND et.entry_id = CAST(f.id AS TEXT) AND et.tag IN (?) WHERE f.org_id = ?`, "org_two", "infra", "org_two");
    expect(rows.map((r) => r.summary)).toEqual(["two"]);
    // An org made by the old Worker has no org_tags rows; nothing references them, so its feed still tags.
    await db().prepare(`INSERT INTO orgs (id, slug, name, created_at, created_by) VALUES ('org_late', 'late', 'Late', 't', 'old-worker')`).run();
    await db().prepare(`INSERT OR IGNORE INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES ('org_late', 'auth', 'feed', '7')`).run();
    expect(await q(`SELECT 1 FROM org_tags WHERE org_id = 'org_late'`)).toEqual([]);
  });

  it("is idempotent in what it seeds, and the suggestions table holds one OPEN row per item, tag and source", async () => {
    await applyD1Migrations(db(), own());
    const seed = migrationSql.split("\n").filter((l) => l.includes("FROM orgs ORDER BY id;")).length;
    expect(seed).toBe(6); // one statement per starter: D1 allows five terms in a compound SELECT
    const ins = `INSERT OR IGNORE INTO org_tag_suggestions (org_id, tag, entry_type, entry_id, source, suggested_by, suggested_at) VALUES ('org_two', 'billing', 'feed', '2', ?, 'bea', 't')`;
    await db().prepare(ins).bind("agent").run();
    await db().prepare(ins).bind("agent").run();   // a replay
    await db().prepare(ins).bind("model").run();   // a model's own judgement of the same pair, later
    expect((await q(`SELECT 1 FROM org_tag_suggestions`)).length).toBe(2);
    // Settled rows are history: the same pair may be suggested again.
    await db().prepare(`UPDATE org_tag_suggestions SET state = 'superseded' WHERE source = 'model'`).run();
    await db().prepare(ins).bind("model").run();
    expect((await q(`SELECT 1 FROM org_tag_suggestions`)).length).toBe(3);
    await expect(db().prepare(`UPDATE org_tag_suggestions SET state = 'pending'`).run()).rejects.toThrow(/CHECK/i);
    expect((await q<{ name: string }>(`SELECT name FROM pragma_table_info('org_tag_suggestions')`)).map((r) => r.name)).toEqual([
      "id", "org_id", "entry_type", "entry_id", "tag", "source", "confidence", "reason", "model", "prompt_version", "suggested_by", "suggested_at", "state", "resolved_to", "resolved_at", "resolved_by", "run_id",
    ]);
  });
});

describe("the starter set is defined once in each place, and the places agree", () => {
  it("shared/vocabulary.ts TAGS, shared/tags-core.ts STARTER_TAGS, the migration and the test seed name the same six", () => {
    expect(STARTER_TAGS.map((t) => t.name)).toEqual([...TAGS]);
    for (const t of STARTER_TAGS) {
      expect(TAG_COLORS).toContain(t.color);
      const row = `'${t.name}', '${t.description}', '${t.color}', 1,`;
      expect(migrationSql, `0056 seeds ${t.name}`).toContain(row);
      expect(RESET_STATEMENTS.some((s: string) => s.includes(row)), `reset.mjs seeds ${t.name}`).toBe(true);
    }
  });
});
