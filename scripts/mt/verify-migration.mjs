#!/usr/bin/env node
// Verify the multitenancy migrations (0037–0040) against a LOCAL COPY of production data
// (canopy-multitenancy.md §3.4). Production data never leaves your machine and never enters git
// (`.mt/` is gitignored).
//
// 1. Export the base tables' DATA from production. `wrangler d1 export` refuses databases with virtual
//    tables (Trov has seven FTS5 tables), so export data only, base tables only. `trov` below is the
//    database wrangler.toml binds as `DB` (`database_name`) — check it there before running:
//
//      mkdir -p .mt
//      TABLES=$(npx wrangler d1 execute trov --remote --json --command \
//        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' \
//         AND name <> 'd1_migrations' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT GLOB '*_fts_*'" \
//        | node -e "for (const r of JSON.parse(require('fs').readFileSync(0))[0].results) console.log(r.name)")
//      npx wrangler d1 export trov --remote --no-schema $(printf -- '--table %s ' $TABLES) --output .mt/prod-data.sql
//
// 2. Run:  node scripts/mt/verify-migration.mjs .mt/prod-data.sql
//
// It builds a 0036 database from THIS repo's migrations (Node's built-in SQLite, FTS5 included), loads the
// data (the FTS triggers re-index it as it lands; artifacts_fts is rebuilt the way 0030 did), snapshots
// every table, applies 0037–0040 each as ONE transaction (as D1 does), and checks: identical row counts;
// identical values in every pre-existing column; every tenant row in org_saplinglearn; FTS row counts
// equal to their base tables; a sample of MATCH queries returning the same ids; integrity_check ok;
// foreign_key_check empty; no AUTOINCREMENT counter moved backwards; every MCP token and OAuth grant
// pinned to org_saplinglearn; memberships for every non-reserved person. Exit code 1 on any failure.
//
// Known limits: the data export carries no sqlite_sequence, so counters are compared with MAX(id) as
// imported, not with production's (which may be higher after deletes — the migrations carry whatever is
// there). This is a check of the MIGRATIONS on real data; the deploy itself still goes through
// `npm run db:migrate:remote` after the export + Time Travel bookmark in the runbook (§3.5).
// Rolling back by hand (past Time Travel's window): scripts/mt/rollback/0043.down.sql FIRST, then
// scripts/mt/rollback/0037-0040.down.sql — the order, and what neither undoes, is in 0043.down.sql's header.
// scripts/mt/rollback/0046.down.sql (the abuse counters) is free-standing: run it at any point, or not at all.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const LEGACY = "org_saplinglearn";
const dataFile = process.argv[2];
if (!dataFile) {
  console.error("usage: node scripts/mt/verify-migration.mjs <data-only export .sql>");
  process.exit(2);
}

const migrations = readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
const pre = migrations.filter((f) => f < "0037");
const post = migrations.filter((f) => f >= "0037");

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");
const apply = (file) => {
  db.exec("BEGIN");
  try { db.exec(readFileSync(path.join(ROOT, "migrations", file), "utf8")); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); throw new Error(`${file}: ${e.message}`); }
};
const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

// ── 1. a 0036 database holding production's data ──
for (const f of pre) apply(f);
// The migrations seed a few rows production also has (vocabulary, the plan / settings singletons, the
// github-webhook person): the export's rows replace them.
const data = readFileSync(dataFile, "utf8").replace(/\bINSERT INTO\b/g, "INSERT OR REPLACE INTO");
db.exec("BEGIN"); db.exec("PRAGMA defer_foreign_keys = true");
try { db.exec(data); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); console.error(`loading ${dataFile}: ${e.message}`); process.exit(1); }
// Rebuild every search index from its base table exactly as the creating migrations did (the import's
// INSERT OR REPLACE does not fire the UPDATE-only plan trigger, and artifacts_fts is repository-written),
// so "before" is the consistent 0036 state production's indexes should already be in.
db.exec(`DELETE FROM docs_fts; INSERT INTO docs_fts (slug, title, section, body) SELECT slug, title, section, body FROM docs;
  DELETE FROM feed_fts; INSERT INTO feed_fts (feed_id, summary, body) SELECT CAST(id AS TEXT), summary, body FROM feed;
  DELETE FROM adrs_fts; INSERT INTO adrs_fts (adr_id, title, context, decision, rationale) SELECT CAST(id AS TEXT), title, context, decision, rationale FROM adrs;
  DELETE FROM roadmap_fts;
  INSERT INTO roadmap_fts (ref, title, body) SELECT 'plan', 'Roadmap plan', narrative FROM plan WHERE narrative != '';
  INSERT INTO roadmap_fts (ref, title, body) SELECT 'sprint:' || id, title, COALESCE(description, '') || ' ' || COALESCE(summary, '') || ' ' || COALESCE(phase, '') || ' ' || COALESCE(status, '') FROM sprints;
  DELETE FROM tickets_fts; INSERT INTO tickets_fts (ticket_id, title, body) SELECT CAST(id AS TEXT), title, body FROM tickets;
  DELETE FROM prompts_fts; INSERT INTO prompts_fts (slug, title, description, body, tags)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags FROM prompts p
      LEFT JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version WHERE p.deleted_at IS NULL;
  DELETE FROM artifacts_fts; INSERT INTO artifacts_fts (page_id, title, description, body)
  SELECT CAST(p.id AS TEXT), p.title, COALESCE(v.summary, ''), COALESCE(v.content, '')
    FROM artifact_pages p LEFT JOIN artifact_versions v ON v.page_id = p.id AND v.version_no = p.current_version
   WHERE p.deleted_at IS NULL`);
check(all("PRAGMA foreign_key_check").length === 0, "the imported data already has foreign key violations (fix before migrating)");

const baseTables = () => all(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT GLOB '*_fts_*'`).map((r) => r.name);
const columns = (t) => all(`PRAGMA table_info("${t}")`).map((c) => c.name);
const ADDED = (t) => ["org_id", ...(t === "tickets" || t === "handoffs" ? ["number"] : []),
  ...(["events", "repo_events", "pr_summaries", "issue_summaries"].includes(t) ? ["repo"] : []),
  ...(t === "persons" ? ["org_limit"] : []), ...(t === "identities" ? ["verified_email"] : [])];
const digest = (t, cols) => {
  const h = createHash("sha256");
  const rows = all(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${t}"`).map((r) => JSON.stringify(cols.map((c) => r[c]))).sort();
  for (const r of rows) h.update(r + "\n");
  return { count: rows.length, hash: h.digest("hex") };
};
const SAMPLE_MATCH = [["docs_fts", "slug"], ["feed_fts", "feed_id"], ["adrs_fts", "adr_id"], ["tickets_fts", "ticket_id"], ["prompts_fts", "slug"], ["roadmap_fts", "ref"]];
const sampleTerms = ["gate", "ticket", "sprint", "doc", "agent", "deploy"];

const before = new Map();
for (const t of baseTables()) before.set(t, { cols: columns(t), ...digest(t, columns(t)) });
const seqBefore = new Map(all("SELECT name, seq FROM sqlite_sequence").map((r) => [r.name, r.seq]));
const matchBefore = new Map();
for (const [fts, key] of SAMPLE_MATCH) for (const term of sampleTerms) matchBefore.set(`${fts}:${term}`, all(`SELECT ${key} AS k FROM ${fts} WHERE ${fts} MATCH ? ORDER BY 1`, term).map((r) => r.k));
const persons = all(`SELECT handle FROM persons WHERE lower(handle) NOT IN ('github-webhook','system','admin','canopy','me')`).map((r) => r.handle);

// ── 2. migrate (a file that fails — e.g. 0039's foreign-key guard — is the report, not a crash) ──
try {
  for (const f of post) apply(f);
} catch (e) {
  console.error(`\nFAILED: the migrations did not apply — ${e.message}`);
  const fk = all(`SELECT "table", parent, COUNT(*) AS n FROM pragma_foreign_key_check GROUP BY 1, 2`);
  if (fk.length) console.error(`dangling references (table → parent: rows): ${fk.map((r) => `${r.table} → ${r.parent}: ${r.n}`).join(", ")}`);
  process.exit(1);
}

// ── 3. compare ──
for (const [t, b] of before) {
  if (!columns(t).length) { failures.push(`${t}: table is gone`); continue; }
  const cols = b.cols.filter((c) => !(["plan", "notification_settings"].includes(t) && c === "id"));
  const after = digest(t, cols);
  check(after.count === b.count, `${t}: ${b.count} rows before, ${after.count} after`);
  if (!["plan", "notification_settings"].includes(t)) check(after.hash === b.hash, `${t}: values changed in pre-existing columns`);
  if (columns(t).includes("org_id")) {
    const other = get(`SELECT COUNT(*) AS n FROM "${t}" WHERE org_id IS NOT ?`, LEGACY).n;
    check(other === 0, `${t}: ${other} rows not in ${LEGACY}`);
  }
}
for (const [name, seq] of seqBefore) {
  const now = get("SELECT seq FROM sqlite_sequence WHERE name = ?", name)?.seq ?? 0;
  check(now >= seq, `sqlite_sequence ${name}: ${seq} → ${now}`);
}
// The app addresses a ticket and a handoff by its per-org NUMBER (`/tickets/12`, `#12` — src/tools/tickets.ts).
// Existing links and bookmarks keep working only because, for every pre-existing row, that number IS the old id.
for (const t of ["tickets", "handoffs"]) {
  const off = get(`SELECT COUNT(*) AS n FROM "${t}" WHERE number IS NULL OR number <> id`).n;
  check(off === 0, `${t}: ${off} rows whose per-org number differs from their id (old #links would point elsewhere)`);
}
for (const [fts, base, where] of [["docs_fts", "docs", ""], ["feed_fts", "feed", ""], ["adrs_fts", "adrs", ""], ["tickets_fts", "tickets", ""],
  ["prompts_fts", "prompts", "WHERE deleted_at IS NULL"], ["artifacts_fts", "artifact_pages", "WHERE deleted_at IS NULL"]]) {
  const a = get(`SELECT COUNT(*) AS n FROM ${fts} WHERE org_id = ?`, LEGACY).n;
  const b = get(`SELECT COUNT(*) AS n FROM ${base} ${where}`).n;
  check(a === b, `${fts}: ${a} rows, ${base} has ${b}`);
}
for (const [fts, key] of SAMPLE_MATCH) for (const term of sampleTerms) {
  const now = all(`SELECT ${key} AS k FROM ${fts} WHERE ${fts} MATCH ? AND org_id = ? ORDER BY 1`, term, LEGACY).map((r) => r.k);
  check(JSON.stringify(now) === JSON.stringify(matchBefore.get(`${fts}:${term}`)), `${fts} MATCH '${term}' returns different rows`);
}
check(get("PRAGMA integrity_check").integrity_check === "ok", "integrity_check failed");
const fk = all("PRAGMA foreign_key_check");
check(fk.length === 0, `foreign_key_check: ${fk.length} violations, e.g. ${JSON.stringify(fk.slice(0, 3))}`);
check(get(`SELECT COUNT(*) AS n FROM mcp_tokens WHERE org_id IS NOT ?`, LEGACY).n === 0, "an MCP token is not pinned to SaplingLearn");
check(get(`SELECT COUNT(*) AS n FROM oauth_grants WHERE org_id IS NOT ?`, LEGACY).n === 0, "an OAuth grant is not pinned to SaplingLearn");
const members = new Set(all(`SELECT lower(user_id) AS u FROM memberships WHERE org_id = ?`, LEGACY).map((r) => r.u));
for (const p of persons) check(members.has(p.toLowerCase()), `${p} is not a SaplingLearn member`);
check(get(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'`, LEGACY).n >= 1, "SaplingLearn has no owner");

const summary = [...before].map(([t, b]) => `${t}=${b.count}`).join(" ");
console.log(`tables: ${before.size}  rows: ${summary}`);
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nOK — 0037–0040 keep every row and value, pin everything to org_saplinglearn, and leave the indexes consistent.");
