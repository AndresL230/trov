/**
 * The organizations migration (`migrations/0042_organizations.sql`) and its rollback, against REAL workerd
 * D1 (canopy-multitenancy.md §3.3–3.5).
 *
 * The harness has already migrated `DB`, so these tests use `MT_DB`, a second empty database
 * (vitest.config.ts): each one wipes it, applies 0001–0036, loads a small corpus that touches every table
 * the migration changes, applies 0041 (production's order: the sender rename shipped first), then the
 * migration, and asserts on the rows. The production check is the same idea against a real export:
 * scripts/mt/verify-migration.mjs.
 *
 * The migration was written as ten files and consolidated before release, so there is no intermediate
 * state to inspect any more: every assertion is about the database BEFORE it (0036 + 0041) or AFTER it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import migrationSql from "../migrations/0042_organizations.sql?raw";

const LEGACY = "org_saplinglearn";
const MIGRATION = "0042_organizations.sql";
const db = () => env.MT_DB;

const upTo0036 = () => env.TEST_MIGRATIONS.filter((m) => m.name < "0037");
/** 0001–0036 and 0041 — everything production had recorded before the migration. */
const beforeOrgs = () => env.TEST_MIGRATIONS.filter((m) => m.name < MIGRATION);
const orgs = () => env.TEST_MIGRATIONS.filter((m) => m.name === MIGRATION);
const applyOrgs = () => applyD1Migrations(db(), orgs());

const SEED_0036 = [
  `INSERT INTO persons (handle,name,color,created_at,onboarded_at,role,responsibilities) VALUES ('andres','Andres','moss','t','t','Founder','All'),('meilin','Mei','rose','t','t',NULL,NULL)`,
  `INSERT INTO identities VALUES ('github','AndresL230','AndresL230','andres','t','seed'),('google','sub1','Mei@x.org','meilin','t','seed')`,
  `INSERT INTO invites (email, invited_by, invited_at) VALUES ('new@x.org','andres','t')`,
  `INSERT INTO docs (slug,section,title,body,current_version) VALUES ('gate-doc','reference','The gate','the gate reconciles',1),('stub','reference','Stub','',0)`,
  `INSERT INTO doc_versions (slug,version,body,status,created_at,created_by,content_hash) VALUES ('gate-doc',1,'the gate reconciles','promoted','t','andres','h1'),('gate-doc',2,'v2','staged','t','andres','h2')`,
  `DELETE FROM doc_versions WHERE version=2`,
  `INSERT INTO doc_versions (slug,version,body,status,created_at,created_by) VALUES ('gate-doc',2,'v2b','staged','t','andres')`,
  `INSERT INTO feed (author,summary,body,created_at) VALUES ('andres','did gate work','body','t')`,
  `INSERT INTO entry_tags VALUES ((SELECT tag FROM tags LIMIT 1),'feed','1')`,
  `INSERT INTO adrs (title,context,decision,rationale,created_at,created_by,content_hash) VALUES ('ADR one','c','d','r','t','andres','ah')`,
  `INSERT INTO processed_items VALUES ('s1',0,'feed','written','1','t')`,
  `INSERT INTO events (semantic_key,event_type,ref_number,subject_login,raw,provenance,recorded_at,recorded_by) VALUES ('gh:pr:1:merged','pr_merged',1,'AndresL230','{}','webhook','t','github-webhook')`,
  `INSERT INTO pr_summaries (semantic_key,pr_number,model,created_at,title) VALUES ('gh:pr:1:merged',1,'m','t','PR one')`,
  `INSERT INTO issue_summaries (issue_number,summary,created_at) VALUES (5,'s','t')`,
  `UPDATE plan SET narrative='Now we build the gate', current_version=1`,
  `INSERT INTO plan_versions VALUES (1,'Now we build the gate','[]','t','andres')`,
  `INSERT INTO sprints (title,target_date,created_at,created_by) VALUES ('Sprint A','2026-10-10','t','andres')`,
  `INSERT INTO sprint_progress VALUES (1,1,2,'event','t')`,
  `INSERT INTO sprint_resources (sprint_id,url,kind,label,meta) VALUES (1,'u','plain','l','{}')`,
  `INSERT INTO tickets (title,requester,sprint_id,created_at,updated_at) VALUES ('T1','andres',1,'t','t'),('T2','meilin',NULL,'t','t'),('T3','meilin',NULL,'t','t')`,
  `DELETE FROM tickets WHERE id=3`,
  `INSERT INTO ticket_assignees VALUES (1,'andres')`,
  `INSERT INTO ticket_comments (ticket_id,author,body,created_at) VALUES (1,'andres','c','t')`,
  `INSERT INTO ticket_events (ticket_id,actor,to_status,created_at) VALUES (1,'andres','submitted','t')`,
  `INSERT INTO identity_tasks (login,first_seen) VALUES ('outsider','t')`,
  `INSERT INTO notification_policy VALUES ('my_work','daily',1,'t','andres')`,
  `INSERT INTO notification_prefs VALUES ('andres','my_work','weekly','t')`,
  `INSERT INTO notification_outbox VALUES ('andres:daily:w','andres','daily','w','[]','sent',NULL,NULL,'t',NULL)`,
  `INSERT INTO repo_events (semantic_key,kind,raw,provenance,occurred_at,recorded_at) VALUES ('gh:push:1','push','{}','webhook','t','t')`,
  `INSERT INTO repo_snapshots VALUES ('drift','{}','t')`,
  `INSERT INTO repo_metrics (metric,value,at) VALUES ('coverage',80,'t')`,
  `INSERT INTO handoffs (sender,recipient,body,created_at,expires_at) VALUES ('andres','anyone','b','t','t')`,
  `INSERT INTO prompts (slug,title,author,current_version,created_at,updated_at) VALUES ('p1','Prompt','andres',1,'t','t')`,
  `INSERT INTO prompt_versions VALUES ('p1',1,'published','andres','','body of prompt','t')`,
  `INSERT INTO artifact_pages (slug,title,kind,area,author_id,current_version,created_at,updated_at) VALUES ('a1','Art','markdown','ui','andres',1,'t','t')`,
  `INSERT INTO artifact_versions (page_id,version_no,content,size_bytes,content_type,sha256,created_by,created_at) VALUES (1,1,'hello',5,'text/markdown',printf('%064d',1),'andres','t')`,
  `INSERT INTO artifacts_fts (page_id,title,description,body) VALUES ('1','Art','','hello')`,
  `INSERT INTO doc_images VALUES (printf('%064d',2),'image/png',10,'andres','t')`,
  `INSERT INTO mcp_tokens (person,token_hash,created_at) VALUES ('andres','th','t')`,
];

/** Drop everything in MT_DB (triggers, FTS tables, tables), so each test starts from nothing. */
async function wipe(): Promise<void> {
  const objs = (await db().prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ type: string; name: string; sql: string | null }>()).results;
  const triggers = objs.filter((o) => o.type === "trigger").map((o) => `DROP TRIGGER IF EXISTS "${o.name}"`);
  const virtual = objs.filter((o) => o.type === "table" && /VIRTUAL TABLE/i.test(o.sql ?? "")).map((o) => o.name);
  const shadow = (n: string) => virtual.some((v) => n.startsWith(`${v}_`));
  const tables = objs.filter((o) => o.type === "table" && !virtual.includes(o.name) && !shadow(o.name)).map((o) => `DROP TABLE IF EXISTS "${o.name}"`);
  if (!objs.length) return;
  await db().batch([
    db().prepare("PRAGMA defer_foreign_keys = true"),
    ...triggers.map((q) => db().prepare(q)),
    ...virtual.map((v) => db().prepare(`DROP TABLE IF EXISTS "${v}"`)),
    ...tables.map((q) => db().prepare(q)),
    db().prepare("PRAGMA defer_foreign_keys = false"),
  ]);
}

async function at0036WithData(extra: string[] = []): Promise<void> {
  await wipe();
  await applyD1Migrations(db(), upTo0036());
  await db().batch([...SEED_0036, ...extra].map((q) => db().prepare(q)));
  // 0023's identity-task backfill stamps first_seen with the clock at migration time — pin it, so two runs
  // of THIS migration can be compared byte for byte.
  await db().prepare(`UPDATE identity_tasks SET first_seen = 't'`).run();
}

/** Where production stands when the migration arrives: 0036 with data, then 0041 (both recorded). */
async function atBaseWithData(extra: string[] = []): Promise<void> {
  await at0036WithData(extra);
  await applyD1Migrations(db(), beforeOrgs());
}

const rows = async <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => (await db().prepare(sql).bind(...p).all<T>()).results;
const one = async <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => (await db().prepare(sql).bind(...p).first<T>());

/** The columns the migration ADDS to a pre-existing table (left out when comparing a table with its old self). */
const ADDED_COLUMNS = (table: string): string[] => [
  "org_id",
  ...(table === "tickets" || table === "handoffs" ? ["number"] : []),
  ...(["events", "repo_events", "pr_summaries", "issue_summaries"].includes(table) ? ["repo"] : []),
  ...(table === "persons" ? ["org_limit"] : []),
  ...(table === "identities" ? ["verified_email", "provider_uid"] : []),
];

/** Every user table (no FTS shadows, no ledger) → its rows, each serialised, sorted. */
async function dump(opts: { withoutOrg?: boolean } = {}): Promise<Record<string, string[]>> {
  const objs = await rows<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`);
  const virtual = objs.filter((o) => /VIRTUAL TABLE/i.test(o.sql)).map((o) => o.name);
  const out: Record<string, string[]> = {};
  for (const { name } of objs) {
    if (virtual.some((v) => name.startsWith(`${v}_`))) continue;
    const cols = (await rows<{ name: string }>(`PRAGMA table_info("${name}")`)).map((c) => c.name)
      .filter((c) => !(opts.withoutOrg && ADDED_COLUMNS(name).includes(c)));
    out[name] = (await rows(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${name}"`)).map((r) => JSON.stringify(r)).sort();
  }
  // d1_migrations is the ledger, not data (its counter moves when the rollback forgets the migration).
  out["sqlite_sequence"] = (await rows(`SELECT name, seq FROM sqlite_sequence WHERE name <> 'd1_migrations'`)).map((r) => JSON.stringify(r)).sort();
  return out;
}

/** The tables that are not tenant data (no org_id expected). */
const NOT_TENANT = new Set([
  "sections", "tags", "persons", "identities", "sessions", "oauth_clients", "oauth_tokens", "invites",
  "orgs", "cron_cursor", "platform_admins", "abuse_counters", "sqlite_sequence",
]);

// SQLite quotes names it rewrites on RENAME, and a re-created table loses the creating migration's
// `--` comments: neither is a difference in the schema.
const normalise = (sql: string | null) => (sql ?? "").replace(/--[^\n]*/g, "").replace(/"/g, "").replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/ ,/g, ",").trim();
const schema = async () =>
  (await rows<{ type: string; name: string; sql: string | null }>(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`))
    .map((o) => `${o.type} ${o.name} ${normalise(o.sql)}`).sort();
const recorded = async () => (await rows<{ name: string }>(`SELECT name FROM d1_migrations ORDER BY name`)).map((r) => r.name);
const columnsOf = async (table: string) => (await rows<{ name: string }>(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`)).map((c) => c.name);

describe("the migration on a populated 0036 + 0041 database", () => {
  beforeEach(() => atBaseWithData());

  it("keeps every row and every value, and gives every tenant row to SaplingLearn", async () => {
    const pre = await dump();
    await applyOrgs();
    const post = await dump({ withoutOrg: true });

    for (const [table, raw] of Object.entries(pre)) {
      if (table === "sqlite_sequence") continue;
      // The two singletons' `id = 1` became the org key — the rest of the row must be unchanged.
      const before = table === "plan" || table === "notification_settings"
        ? raw.map((r) => { const { id: _id, ...rest } = JSON.parse(r) as Record<string, unknown>; return JSON.stringify(rest); })
        : raw;
      if (!(table in post)) throw new Error(`${table} is gone`);
      expect(post[table], `${table}: rows or values changed`).toEqual(before);
    }
    // AUTOINCREMENT counters never move backwards (a deleted id is never reissued).
    const seqAfter = new Map((await rows<{ name: string; seq: number }>(`SELECT name, seq FROM sqlite_sequence`)).map((r) => [r.name, r.seq]));
    for (const r of pre.sqlite_sequence.map((s) => JSON.parse(s) as { name: string; seq: number })) {
      expect(seqAfter.get(r.name), `sqlite_sequence ${r.name}`).toBeGreaterThanOrEqual(r.seq);
    }
    // Every tenant table has a NOT NULL org_id, and every row is SaplingLearn's.
    // (The FTS tables carry org_id too, UNINDEXED and unconstrained — the next test covers them.)
    const tables = Object.keys(post).filter((t) => !NOT_TENANT.has(t) && !t.startsWith("org_") && t !== "memberships" && !t.endsWith("_fts"));
    for (const t of tables) {
      const col = (await rows<{ name: string; notnull: number }>(`PRAGMA table_info("${t}")`)).find((c) => c.name === "org_id");
      expect(col, `${t}.org_id`).toBeDefined();
      expect(col!.notnull, `${t}.org_id NOT NULL`).toBe(1);
      expect((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t}" WHERE org_id <> ?`, LEGACY))!.n, t).toBe(0);
    }
    expect(await rows(`PRAGMA foreign_key_check`)).toEqual([]);
    expect((await recorded()).filter((n) => n >= "0037")).toEqual(["0041_trov_name.sql", MIGRATION]);
  });

  it("rebuilds every search index with the org, and search still finds the same things", async () => {
    await applyOrgs();
    const counts = async (fts: string, base: string, where = "") => [
      (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${fts} WHERE org_id = ?`, LEGACY))!.n,
      (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${base} ${where}`))!.n,
    ];
    for (const [fts, base, where] of [["docs_fts", "docs"], ["feed_fts", "feed"], ["adrs_fts", "adrs"], ["tickets_fts", "tickets"],
      ["prompts_fts", "prompts", "WHERE deleted_at IS NULL"], ["artifacts_fts", "artifact_pages"]] as const) {
      const [a, b] = await counts(fts, base, where);
      expect(a, fts).toBe(b);
    }
    // roadmap: the plan narrative + one row per sprint
    expect((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM roadmap_fts WHERE org_id = ?`, LEGACY))!.n).toBe(2);
    expect(await rows(`SELECT slug FROM docs_fts WHERE docs_fts MATCH 'gate' AND org_id = ?`, LEGACY)).toEqual([{ slug: "gate-doc" }]);
    expect(await rows(`SELECT page_id FROM artifacts_fts WHERE artifacts_fts MATCH 'hello' AND org_id = ?`, LEGACY)).toEqual([{ page_id: "1" }]);
    // org_id is the LAST column, so the readers' positional bm25 weights and snippet columns are unchanged.
    const lastCol = async (t: string) => (await rows<{ name: string }>(`PRAGMA table_info(${t})`)).at(-1)!.name;
    for (const t of ["docs_fts", "feed_fts", "adrs_fts", "roadmap_fts", "tickets_fts", "prompts_fts", "artifacts_fts"]) expect(await lastCol(t), t).toBe("org_id");
  });

  it("seeds SaplingLearn: members (andres owner, roles moved), attribution, invites, repo and environments", async () => {
    await applyOrgs();
    expect(await rows(`SELECT id, slug, name FROM orgs`)).toEqual([{ id: LEGACY, slug: "saplinglearn", name: "SaplingLearn" }]);
    expect(await rows(`SELECT user_id, role, title, responsibilities FROM memberships ORDER BY user_id`)).toEqual([
      { user_id: "andres", role: "owner", title: "Founder", responsibilities: "All" },
      { user_id: "meilin", role: "member", title: null, responsibilities: null },
    ]); // the reserved github-webhook person is not a member
    expect(await rows(`SELECT github_login, person FROM org_login_map`)).toEqual([{ github_login: "AndresL230", person: "andres" }]);
    expect(await rows(`SELECT email, status FROM org_invites`)).toEqual([{ email: "new@x.org", status: "pending" }]);
    expect(await rows(`SELECT verified_email FROM identities WHERE provider = 'google'`)).toEqual([{ verified_email: "mei@x.org" }]);
    expect(await rows(`SELECT repo_full_name, is_primary, legacy_hook FROM org_repos`)).toEqual([{ repo_full_name: "SaplingLearn/sapling", is_primary: 1, legacy_hook: 1 }]);
    expect((await rows<{ key: string }>(`SELECT key FROM org_environments ORDER BY position`)).map((r) => r.key)).toEqual(["staging", "production"]);
    expect((await rows<{ job: string }>(`SELECT job FROM cron_cursor ORDER BY job`)).map((r) => r.job)).toEqual(["health", "progress", "reconcile", "usage"]);
  });

  it("per-org numbers: existing tickets keep #id, the next one continues — a deleted number is never reissued", async () => {
    await applyOrgs();
    expect(await rows(`SELECT id, number FROM tickets ORDER BY id`)).toEqual([{ id: 1, number: 1 }, { id: 2, number: 2 }]);
    await db().prepare(`INSERT INTO tickets (title, requester, created_at, updated_at) VALUES ('next', 'andres', 't', 't')`).run();
    expect(await one(`SELECT number FROM tickets WHERE title = 'next'`)).toEqual({ number: 4 }); // #3 was deleted at 0036
    expect(await one(`SELECT number FROM handoffs`)).toEqual({ number: 1 });
    // THE claim the number-addressed routes rest on (`/tickets/:id` now means the per-org number): for every
    // row that existed before orgs — all of them SaplingLearn's — the number IS the old id, so an existing
    // link, bookmark, mention or agent note that says `#2` still names the same ticket. Asked of the data:
    expect(await one(`SELECT COUNT(*) AS n FROM tickets WHERE org_id <> '${LEGACY}' OR number IS NULL OR number <> id`)).toEqual({ n: 0 });
    expect(await one(`SELECT COUNT(*) AS n FROM handoffs WHERE org_id <> '${LEGACY}' OR number IS NULL OR number <> id`)).toEqual({ n: 0 });
    // …and its counters sit at the highest id ever issued (the deleted #3 included), so the next number is the next id.
    expect(await rows(`SELECT name, value FROM org_counters WHERE org_id = '${LEGACY}' ORDER BY name`)).toEqual([{ name: "handoff", value: 1 }, { name: "ticket", value: 4 }]);
  });

  it("is convergent: two independent runs end in identical databases", async () => {
    await applyOrgs();
    const first = [await schema(), await dump()];
    await atBaseWithData();
    await applyOrgs();
    expect([await schema(), await dump()]).toEqual(first);
  });
});

describe("all or nothing — a failure anywhere leaves the 0036 + 0041 database untouched", () => {
  const ORPHAN = `INSERT INTO prompt_versions (slug, version, status, author, body, created_at) VALUES ('orphan', 1, 'draft', 'x', 'b', 't')`;
  const state = async () => ({ schema: await schema(), data: await dump(), ledger: await recorded() });

  it("the foreign-key guard: one dangling row (no FK before, a composite FK after) fails the WHOLE migration", async () => {
    await atBaseWithData([ORPHAN]);
    const before = await state();
    await expect(applyOrgs()).rejects.toThrow(/CHECK constraint failed: violations = 0/);
    // Nothing happened — not the rebuilds the guard closes, and not the two sections BEFORE them either
    // (as separate files those had already been committed when the guard fired).
    expect(await state()).toEqual(before);
    expect(before.ledger).not.toContain(MIGRATION);
    expect(await rows(`SELECT name FROM sqlite_master WHERE name IN ('orgs', 'memberships', 'docs_new', '_mt_fk_guard', 'platform_admins')`)).toEqual([]);
    expect(await columnsOf("persons")).not.toContain("org_limit");
    expect(await columnsOf("tickets")).not.toContain("org_id");
    expect((await one<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'prompts'`))!.sql).toMatch(/slug TEXT PRIMARY KEY/);
    expect((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM prompt_versions`))!.n).toBe(2);
    // …so the fix is to repair the data and apply again: the same file then goes through.
    await db().prepare(`DELETE FROM prompt_versions WHERE slug = 'orphan'`).run();
    await applyOrgs();
    expect(await recorded()).toContain(MIGRATION);
    expect((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM memberships`))!.n).toBe(2);
  });

  it("a statement failing at the very END (after all ten sections ran) rolls every one of them back", async () => {
    await atBaseWithData();
    const before = await state();
    const [m] = orgs();
    const broken = [{ name: m.name, queries: [...m.queries, `INSERT INTO _no_such_table VALUES (1)`] }];
    await expect(applyD1Migrations(db(), broken)).rejects.toThrow(/no such table/);
    expect(await state()).toEqual(before);
  });

  it("the file reaches D1 as separate statements, the two PRAGMAs among them, and under the 100 KB limit", async () => {
    const [m] = orgs();
    // wrangler's splitter (local and test databases) ends a CASE only at `END` + whitespace: one `END,`
    // and everything after it would run as ONE statement. The count is the file's real statement count.
    expect(m.queries.length).toBe(266);
    const on = m.queries.indexOf("PRAGMA defer_foreign_keys = true");
    const off = m.queries.indexOf("PRAGMA defer_foreign_keys = false");
    expect(m.queries.filter((q) => /^PRAGMA/i.test(q))).toHaveLength(2);
    // The deferral covers section 3 only: the org tables and added columns come before it, search and the
    // later additions after it.
    const at = (re: RegExp) => m.queries.findIndex((q) => re.test(q));
    expect(at(/^CREATE TABLE IF NOT EXISTS orgs\b/)).toBeLessThan(on);
    expect(at(/^CREATE TRIGGER IF NOT EXISTS handoffs_number_ai\b/)).toBeLessThan(on);
    expect(at(/^CREATE TABLE docs_new\b/)).toBeGreaterThan(on);
    expect(at(/^DROP TABLE _mt_fk_guard\b/)).toBe(off - 1);
    expect(at(/^DROP TRIGGER IF EXISTS docs_fts_ai\b/)).toBe(off + 1);
    expect(at(/^CREATE TABLE IF NOT EXISTS platform_admins\b/)).toBeGreaterThan(off);
    // A remote apply sends the file whole, in one request (D1: 100 KB of SQL).
    expect(new TextEncoder().encode(migrationSql).length).toBeLessThan(100_000);
  });
});

describe("the rollback (scripts/mt/rollback/0042_organizations.down.sql)", () => {
  const runDown = () => db().batch(env.MT_ROLLBACK.flatMap((m) => m.queries).map((q) => db().prepare(q)));

  it("is one file", () => {
    expect(env.MT_ROLLBACK.map((m) => m.name)).toEqual(["0042_organizations.down.sql"]);
  });

  it("up → down restores the exact 0036 + 0041 schema and every row, and forgets the migration", async () => {
    await atBaseWithData();
    const schema0 = await schema();
    const data0 = await dump();
    await applyOrgs();
    // Rows in everything the later sections added, so each drop is a drop of real data.
    await db().batch([
      db().prepare(`INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, '2026-10-06', 'api_read', 'x', 1, 't')`).bind(LEGACY),
      db().prepare(`INSERT INTO org_admin_audit (org_id, actor, action, target, at) VALUES (?, 'x', 'org.update', 'settings', 't')`).bind(LEGACY),
      db().prepare(`INSERT INTO abuse_counters (subject, action, bucket, count, last_at) VALUES ('x', 'invite', '2026-10-06', 1, 't')`),
      db().prepare(`UPDATE identities SET provider_uid = '4242' WHERE provider = 'github'`),
      db().prepare(`UPDATE orgs SET logo_sha = ?, logo_source = 'upload', logo_by = 'andres', logo_at = 't', suspended_at = 't', suspended_by = 'andres'`).bind("a".repeat(64)),
      db().prepare(`UPDATE org_invites SET name = 'New Person', mail_status = 'sent', mail_at = 't'`),
    ]);
    await runDown();
    expect(await schema()).toEqual(schema0); // no table, column, index or trigger of the migration is left
    expect(await dump()).toEqual(data0);
    // 0041 is NOT undone: it stays recorded, and the sender it renamed stays renamed.
    expect((await recorded()).filter((n) => n >= "0037")).toEqual(["0041_trov_name.sql"]);
    expect(await one(`SELECT from_address FROM notification_settings`)).toEqual({ from_address: "Trov <hello@trov.dev>" });
    expect(await rows(`PRAGMA foreign_key_check`)).toEqual([]);
    // …so applying again works, and lands in the same place.
    await applyOrgs();
    expect((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM memberships`))!.n).toBe(2);
    expect(await one(`SELECT COUNT(*) AS n FROM abuse_counters`)).toEqual({ n: 0 });
  });

  it("refuses to run once a second org exists (its rows would be lost)", async () => {
    await atBaseWithData();
    await applyOrgs();
    await db().prepare(`INSERT INTO orgs (id, slug, name, created_at, created_by) VALUES ('org_b', 'acme', 'Acme', 't', 'x')`).run();
    const before = await schema();
    await expect(runDown()).rejects.toThrow();
    expect(await one(`SELECT id FROM orgs WHERE id = 'org_b'`)).toEqual({ id: "org_b" });
    expect(await schema()).toEqual(before);
  });

  it("refuses on a database the migration never ran on, and changes nothing", async () => {
    await atBaseWithData();
    const before = [await schema(), await dump()];
    await expect(runDown()).rejects.toThrow(/no such table: orgs/);
    expect([await schema(), await dump()]).toEqual(before);
  });
});

describe("0041 — the sender's rename — runs BEFORE the migration, on the table it later rebuilds", () => {
  it("the untouched default sender, renamed to Trov <hello@trov.dev>, is carried into the org's settings", async () => {
    await at0036WithData();
    expect(await one(`SELECT from_address FROM notification_settings WHERE id = 1`)).toEqual({ from_address: "Canopy <canopy@canopy.saplinglearn.com>" });
    await applyD1Migrations(db(), beforeOrgs());
    await applyOrgs();
    expect(await rows(`SELECT org_id, from_address FROM notification_settings`)).toEqual([{ org_id: LEGACY, from_address: "Trov <hello@trov.dev>" }]);
  });

  it("an admin's own sender is left alone, and carried over as it is", async () => {
    await at0036WithData([`UPDATE notification_settings SET from_address = 'Team <team@example.org>' WHERE id = 1`]);
    await applyD1Migrations(db(), beforeOrgs());
    await applyOrgs();
    expect(await rows(`SELECT org_id, from_address FROM notification_settings`)).toEqual([{ org_id: LEGACY, from_address: "Team <team@example.org>" }]);
  });
});

describe("the later additions (sections 5–10), on the final schema", () => {
  beforeEach(async () => {
    await atBaseWithData();
    await applyOrgs();
  });

  it("the superadmin: andres is the one platform admin, and still the only owner of SaplingLearn", async () => {
    expect(await rows(`SELECT person, granted_by FROM platform_admins`)).toEqual([{ person: "andres", granted_by: "migration" }]);
    expect(await rows(`SELECT user_id, role FROM memberships WHERE role IN ('owner', 'admin')`)).toEqual([{ user_id: "andres", role: "owner" }]);
  });

  it("suspension, the owner invite, usage metering and the administration audit", async () => {
    expect(await rows(`SELECT suspended_at, suspended_by FROM orgs`)).toEqual([{ suspended_at: null, suspended_by: null }]);
    expect(await rows(`SELECT as_owner FROM org_invites`)).toEqual([{ as_owner: 0 }]); // the copied invite is an ordinary one
    await expect(db().prepare(`UPDATE org_invites SET as_owner = 2`).run()).rejects.toThrow(/CHECK/i);
    // One usage counter per (org, day, metric, person); an org that does not exist is refused.
    const usage = `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, '2026-10-06', 'api_read', 'x', 1, 't')`;
    await db().prepare(usage).bind(LEGACY).run();
    await expect(db().prepare(usage).bind(LEGACY).run()).rejects.toThrow(/UNIQUE/i);
    await expect(db().prepare(usage).bind("org_nope").run()).rejects.toThrow(/FOREIGN KEY/i);
    // The audit takes any action (the list lives in code) and a NULL org for a platform-level one.
    await db().prepare(`INSERT INTO org_admin_audit (org_id, actor, action, target, at) VALUES (?, 'x', 'org.update', 'settings', 't'), (NULL, 'x', 'platform.grant', 'andres', 't')`).bind(LEGACY).run();
    expect(await one(`SELECT COUNT(*) AS n FROM org_admin_audit`)).toEqual({ n: 2 });
  });

  it("the identity uid: one nullable column, NULL for every identity that already existed", async () => {
    expect((await columnsOf("identities")).slice(-2)).toEqual(["verified_email", "provider_uid"]);
    expect(await rows(`SELECT DISTINCT provider_uid FROM identities`)).toEqual([{ provider_uid: null }]);
  });

  it("the abuse counters: one row per (subject, action, window); a window is a day or an hour", async () => {
    const bump = `INSERT INTO abuse_counters (subject, action, bucket, count, last_at) VALUES ('x', 'invite', ?, 1, 't')`;
    await db().prepare(bump).bind("2026-10-06").run();
    await db().prepare(bump).bind("2026-10-06T14").run();
    await expect(db().prepare(bump).bind("2026-10-06").run()).rejects.toThrow(/UNIQUE/i);
    await expect(db().prepare(bump).bind("2026-10").run()).rejects.toThrow(/CHECK/i);
    expect(await columnsOf("abuse_counters")).not.toContain("org_id"); // a platform table: a person's cap is not per org
  });

  it("the invite's name and mail outcome: the invite copied from the legacy list keeps every value and reads NULL in the four", async () => {
    expect((await columnsOf("org_invites")).slice(-5)).toEqual(["as_owner", "name", "mail_status", "mail_at", "mail_error"]);
    expect(await rows(`SELECT email, role, invited_by, status, name, mail_status, mail_at, mail_error FROM org_invites`)).toEqual([
      { email: "new@x.org", role: "member", invited_by: "andres", status: "pending", name: null, mail_status: null, mail_at: null, mail_error: null },
    ]);
    // The CHECKs hold: an outcome is 'sent' or 'failed', a name is at most 120 characters.
    await db().prepare(`UPDATE org_invites SET mail_status = 'sent', mail_at = 't', name = 'New Person'`).run();
    await expect(db().prepare(`UPDATE org_invites SET mail_status = 'queued'`).run()).rejects.toThrow(/CHECK/i);
    await expect(db().prepare(`UPDATE org_invites SET name = ?`).bind("x".repeat(121)).run()).rejects.toThrow(/CHECK/i);
  });

  it("the org's image: five nullable columns, NULL for the org that already exists", async () => {
    expect((await columnsOf("orgs")).slice(-5)).toEqual(["logo_sha", "logo_source", "logo_by", "logo_from", "logo_at"]);
    expect(await rows(`SELECT id, slug, logo_sha, logo_source, logo_by, logo_from, logo_at FROM orgs`)).toEqual([
      { id: LEGACY, slug: "saplinglearn", logo_sha: null, logo_source: null, logo_by: null, logo_from: null, logo_at: null },
    ]);
    // The CHECKs hold: a source is 'upload' or 'github', a hash is 64 characters.
    await db().prepare(`UPDATE orgs SET logo_sha = ?, logo_source = 'github', logo_from = 'SaplingLearn', logo_at = 't'`).bind("a".repeat(64)).run();
    await expect(db().prepare(`UPDATE orgs SET logo_source = 'gravatar'`).run()).rejects.toThrow(/CHECK/i);
    await expect(db().prepare(`UPDATE orgs SET logo_sha = 'abc'`).run()).rejects.toThrow(/CHECK/i);
  });
});
