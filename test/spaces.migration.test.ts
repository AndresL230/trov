/**
 * 0081_docs_library — now a part of 0076_10_17_staging — against REAL workerd D1: `MT_DB` (the second, empty database
 * of vitest.config.ts) is wiped, migrated to just before that part, loaded with two orgs and docs in every old space
 * value, then given the part.
 * The assertions are the header's claims: every org has the three starter spaces (the rows of STARTER_SPACES),
 * every doc not in `product` is in `engineering`, the tree / link / import schema exists, a name is unique among
 * live spaces only, and the statements the Worker from before it runs still work.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { STARTER_SPACES } from "@shared/docs-core";
import { RESET_STATEMENTS } from "../scripts/seed/reset.mjs";

const MIGRATION = "0076_10_17_staging.sql";
const db = () => env.MT_DB;
/** The consolidated file's statements, cut at the 0081_docs_library part: the parts before it, the part itself
 *  (it ends where 0082_doc_import_manifest's first statement starts). */
function cut(): { earlier: D1Migration; part: D1Migration } {
  const m = env.TEST_MIGRATIONS.find((x) => x.name === MIGRATION)!;
  const from = m.queries.findIndex((q) => q.includes("CREATE TABLE IF NOT EXISTS doc_spaces"));
  const to = m.queries.findIndex((q) => q.includes("ALTER TABLE doc_imports ADD COLUMN manifest"));
  if (from < 1 || to <= from) throw new Error(`${MIGRATION}: the 0081_docs_library part was not found`);
  return {
    earlier: { name: `${MIGRATION} (before 0081_docs_library)`, queries: m.queries.slice(0, from) },
    part: { name: `${MIGRATION} › 0081_docs_library`, queries: m.queries.slice(from, to) },
  };
}
const before = () => [...env.TEST_MIGRATIONS.filter((m) => m.name < MIGRATION), cut().earlier];
const own = () => [cut().part];
const q = async <T>(sql: string, ...p: unknown[]) => (await db().prepare(sql).bind(...p).all<T>()).results;

/** Drop everything in MT_DB (as test/tags.migration.test.ts does, newest table first). */
async function wipe(): Promise<void> {
  const objs = (await db().prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ type: string; name: string; sql: string | null }>()).results;
  if (!objs.length) return;
  const triggers = objs.filter((o) => o.type === "trigger").map((o) => `DROP TRIGGER IF EXISTS "${o.name}"`);
  const virtual = objs.filter((o) => o.type === "table" && /VIRTUAL TABLE/i.test(o.sql ?? "")).map((o) => o.name);
  const shadow = (n: string) => virtual.some((v) => n.startsWith(`${v}_`));
  // Newest first: a later migration's table may reference an older one, and dropping a table whose rows reference a
  // dropped parent fails even with deferred keys — so the parents (orgs …) go last.
  const tables = objs.filter((o) => o.type === "table" && !virtual.includes(o.name) && !shadow(o.name)).reverse().map((o) => `DROP TABLE IF EXISTS "${o.name}"`);
  await db().batch([
    db().prepare("PRAGMA defer_foreign_keys = true"),
    ...triggers.map((s) => db().prepare(s)),
    ...virtual.map((v) => db().prepare(`DROP TABLE IF EXISTS "${v}"`)),
    ...tables.map((s) => db().prepare(s)),
    db().prepare("PRAGMA defer_foreign_keys = false"),
  ]);
}

const doc = (org: string, slug: string, space: string) =>
  `INSERT INTO docs (org_id, slug, section, title, body, current_version, updated_at, updated_by, space, owner) VALUES ('${org}', '${slug}', 'reference', '${slug}', 'body of ${slug}', 1, 't', 'andres', '${space}', 'andres')`;
const SEED = [
  `INSERT OR IGNORE INTO orgs (id, slug, name, created_at, created_by) VALUES ('org_saplinglearn', 'saplinglearn', 'SaplingLearn', 't', 'migration')`,
  `INSERT INTO orgs (id, slug, name, created_at, created_by) VALUES ('org_two', 'two', 'Two', 't', 'migration')`,
  doc("org_saplinglearn", "tech", "technical"), doc("org_saplinglearn", "prod", "product"), doc("org_saplinglearn", "old", "canopy"),
  doc("org_two", "stray", "sapling"), doc("org_two", "prod", "product"),
];

beforeEach(async () => {
  await wipe();
  await applyD1Migrations(db(), before());
  await db().batch(SEED.map((s) => db().prepare(s)));
});

describe("0076_10_17_staging › 0081_docs_library", () => {
  it("gives every existing org the three starter spaces — the rows of STARTER_SPACES, in order, by 'system'", async () => {
    await applyD1Migrations(db(), own());
    for (const org of ["org_saplinglearn", "org_two"]) {
      const rows = await q(`SELECT slug, name, icon, color, sort_rank, description, archived_at, created_by FROM doc_spaces WHERE org_id = ? ORDER BY sort_rank`, org);
      expect(rows).toEqual(STARTER_SPACES.map((s) => ({ ...s, description: "", archived_at: null, created_by: "system" })));
    }
  });

  it("every doc not in product moves to engineering — technical, the old canopy default and a stray value; product stays", async () => {
    await applyD1Migrations(db(), own());
    expect(await q(`SELECT org_id, slug, space FROM docs ORDER BY org_id, slug`)).toEqual([
      { org_id: "org_saplinglearn", slug: "old", space: "engineering" },
      { org_id: "org_saplinglearn", slug: "prod", space: "product" },
      { org_id: "org_saplinglearn", slug: "tech", space: "engineering" },
      { org_id: "org_two", slug: "prod", space: "product" },
      { org_id: "org_two", slug: "stray", space: "engineering" },
    ]);
    // The search index is untouched (its update trigger fires on title / section / body only).
    expect((await q<{ n: number }>(`SELECT COUNT(*) AS n FROM docs_fts WHERE docs_fts MATCH 'body'`))[0].n).toBe(5);
  });

  it("adds the tree, link and import schema; every new column starts empty", async () => {
    await applyD1Migrations(db(), own());
    const cols = async (t: string) => (await q<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, t)).map((c) => c.name);
    expect(await cols("docs")).toEqual(expect.arrayContaining(["parent_slug", "tree_rank"]));
    expect(await cols("doc_versions")).toEqual(expect.arrayContaining(["parent_slug", "import_id", "import_path"]));
    expect(await cols("doc_links")).toEqual(["org_id", "from_slug", "to_slug"]);
    expect(await cols("doc_imports")).toEqual(["id", "org_id", "space_slug", "parent_slug", "file_name", "started_by", "started_at", "updated_at", "ended_at", "status", "counts", "failures", "total"]);
    expect(await cols("doc_space_owners")).toEqual(["org_id", "space_slug", "handle", "added_at", "added_by"]);
    expect(await q(`SELECT DISTINCT parent_slug, tree_rank FROM docs`)).toEqual([{ parent_slug: null, tree_rank: null }]);
    const idx = (await q<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_docs_tree', 'idx_doc_versions_import', 'idx_doc_links_to', 'idx_doc_imports_org', 'idx_doc_spaces_name') ORDER BY name`)).map((r) => r.name);
    expect(idx).toEqual(["idx_doc_imports_org", "idx_doc_links_to", "idx_doc_spaces_name", "idx_doc_versions_import", "idx_docs_tree"]);
    await expect(db().prepare(`INSERT INTO doc_imports (org_id, space_slug, file_name, started_by, started_at, updated_at, status) VALUES ('org_two', 'engineering', 'a.zip', 'bea', 't', 't', 'nope')`).run()).rejects.toThrow(/CHECK/i);
  });

  it("a name is unique per org among LIVE spaces, whatever its case; an archived one frees it", async () => {
    await applyD1Migrations(db(), own());
    const add = (org: string, slug: string, name: string) => db().prepare(
      `INSERT INTO doc_spaces (org_id, slug, name, icon, color, created_at, created_by) VALUES (?, ?, ?, 'shield', '#b4562c', 't', 'andres')`).bind(org, slug, name).run();
    await expect(add("org_two", "eng-2", "ENGINEERING")).rejects.toThrow(/UNIQUE/i);
    await add("org_saplinglearn", "security", "Security");
    await add("org_two", "security", "Security"); // another org's
    await db().prepare(`UPDATE doc_spaces SET archived_at = 't' WHERE org_id = 'org_two' AND slug = 'engineering'`).run();
    await add("org_two", "engineering-2", "Engineering");
  });

  it("the Worker from before it still writes and reads a doc (it names no new column)", async () => {
    await applyD1Migrations(db(), own());
    await db().prepare(`INSERT INTO docs (org_id, slug, section, title, body, current_version, updated_at, updated_by, space, owner) VALUES ('org_two', 'legacy', 'reference', 'Legacy', '', 0, 't', 'bea', 'technical', 'bea')`).run();
    expect(await q(`SELECT slug, space FROM docs WHERE org_id = 'org_two' AND space = 'technical'`)).toEqual([{ slug: "legacy", space: "technical" }]);
  });

  it("the test seed (scripts/seed/reset.mjs) writes the same three starter spaces", () => {
    const seeded = RESET_STATEMENTS.filter((s) => s.startsWith("INSERT INTO doc_spaces"));
    expect(seeded.length).toBe(STARTER_SPACES.length);
    STARTER_SPACES.forEach((s, i) => expect(seeded[i]).toContain(`'${s.slug}', '${s.name}', '${s.icon}', '${s.color}', '', ${s.sort_rank}`));
  });
});
