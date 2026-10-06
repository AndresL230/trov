/**
 * Multitenancy Phase 2 — the migrations themselves (0037–0040) and their rollback, against REAL workerd
 * D1 (canopy-multitenancy.md §3.3–3.5).
 *
 * The harness has already migrated `DB`, so these tests use `MT_DB`, a second empty database
 * (vitest.config.ts): each one wipes it, applies 0001–0036, loads a small corpus that touches every table
 * the migrations change, applies 0037–0040 (or a subset), and asserts on the rows. The production check is
 * the same idea against a real export: scripts/mt/verify-migration.mjs.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";

const LEGACY = "org_saplinglearn";
const UP = ["0037", "0038", "0039", "0040"];
const db = () => env.MT_DB;

const before0037 = () => env.TEST_MIGRATIONS.filter((m) => m.name < "0037");
// The four files under test (0041 onward are later, unrelated changes — e.g. 0041 renames a sender).
const upTo = (prefix: string) => env.TEST_MIGRATIONS.filter((m) => m.name.slice(0, 4) <= prefix);

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
  await applyD1Migrations(db(), before0037());
  await db().batch([...SEED_0036, ...extra].map((q) => db().prepare(q)));
  // 0023's identity-task backfill stamps first_seen with the clock at migration time — pin it, so two runs
  // of THESE migrations can be compared byte for byte.
  await db().prepare(`UPDATE identity_tasks SET first_seen = 't'`).run();
}

const rows = async <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => (await db().prepare(sql).bind(...p).all<T>()).results;
const one = async <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => (await db().prepare(sql).bind(...p).first<T>());

/** The columns 0037–0040 ADD to a pre-existing table (left out when comparing a table with its 0036 self). */
const ADDED_COLUMNS = (table: string): string[] => [
  "org_id",
  ...(table === "tickets" || table === "handoffs" ? ["number"] : []),
  ...(["events", "repo_events", "pr_summaries", "issue_summaries"].includes(table) ? ["repo"] : []),
  ...(table === "persons" ? ["org_limit"] : []),
  ...(table === "identities" ? ["verified_email"] : []),
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
  // d1_migrations is the ledger, not data (its counter moves when the rollback forgets the four files).
  out["sqlite_sequence"] = (await rows(`SELECT name, seq FROM sqlite_sequence WHERE name <> 'd1_migrations'`)).map((r) => JSON.stringify(r)).sort();
  return out;
}

/** The tables that are not tenant data (no org_id expected). */
const NOT_TENANT = new Set([
  "sections", "tags", "persons", "identities", "sessions", "oauth_clients", "oauth_tokens", "invites",
  "orgs", "cron_cursor", "sqlite_sequence",
]);

describe("0037–0040 on a populated 0036 database", () => {
  beforeEach(() => at0036WithData());

  it("keeps every row and every value, and gives every tenant row to SaplingLearn", async () => {
    const pre = await dump();
    await applyD1Migrations(db(), upTo("0040"));
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
  });

  it("rebuilds every search index with the org, and search still finds the same things", async () => {
    await applyD1Migrations(db(), upTo("0040"));
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
    await applyD1Migrations(db(), upTo("0040"));
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
  });

  it("per-org numbers: existing tickets keep #id, the next one continues — a deleted number is never reissued", async () => {
    await applyD1Migrations(db(), upTo("0040"));
    expect(await rows(`SELECT id, number FROM tickets ORDER BY id`)).toEqual([{ id: 1, number: 1 }, { id: 2, number: 2 }]);
    await db().prepare(`INSERT INTO tickets (title, requester, created_at, updated_at) VALUES ('next', 'andres', 't', 't')`).run();
    expect(await one(`SELECT number FROM tickets WHERE title = 'next'`)).toEqual({ number: 4 }); // #3 was deleted at 0036
    expect(await one(`SELECT number FROM handoffs`)).toEqual({ number: 1 });
  });

  it("is convergent: two independent runs end in identical databases", async () => {
    await applyD1Migrations(db(), upTo("0040"));
    const first = await dump();
    await at0036WithData();
    await applyD1Migrations(db(), upTo("0040"));
    const second = await dump();
    expect(second).toEqual(first);
  });
});

describe("0039's guard — a dangling reference fails the file, atomically", () => {
  it("an orphan prompt version (no FK before 0039, a composite FK after) aborts 0039 and leaves the old tables", async () => {
    await at0036WithData([`INSERT INTO prompt_versions (slug, version, status, author, body, created_at) VALUES ('orphan', 1, 'draft', 'x', 'b', 't')`]);
    await applyD1Migrations(db(), upTo("0038"));
    const zero39 = env.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0039"));
    await expect(applyD1Migrations(db(), zero39)).rejects.toThrow();
    // Nothing of 0039 happened: the 0036 shape of prompts, docs, events is intact, and it is not recorded.
    const promptsSql = (await one<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'prompts'`))!.sql;
    expect(promptsSql).toMatch(/slug TEXT PRIMARY KEY/);
    expect(await one(`SELECT name FROM sqlite_master WHERE name = 'docs_new'`)).toBeNull();
    expect((await rows<{ name: string }>(`SELECT name FROM d1_migrations`)).map((r) => r.name.slice(0, 4))).not.toContain("0039");
    expect((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM prompt_versions`))!.n).toBe(2);
  });
});

describe("the rollback (scripts/mt/rollback/0037-0040.down.sql)", () => {
  // SQLite quotes names it rewrites on RENAME, and a re-created table loses the creating migration's
  // `--` comments: neither is a difference in the schema.
  const normalise = (sql: string | null) => (sql ?? "").replace(/--[^\n]*/g, "").replace(/"/g, "").replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/ ,/g, ",").trim();
  const schema = async () =>
    (await rows<{ type: string; name: string; sql: string | null }>(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`))
      .map((o) => `${o.type} ${o.name} ${normalise(o.sql)}`).sort();
  const runDown = () => db().batch(env.MT_ROLLBACK.flatMap((m) => m.queries).map((q) => db().prepare(q)));

  it("up → down restores the exact 0036 schema and every row, and forgets the four migrations", async () => {
    await at0036WithData();
    await applyD1Migrations(db(), before0037()); // records 0001–0036 in d1_migrations
    const schema0 = await schema();
    const data0 = await dump();
    await applyD1Migrations(db(), upTo("0040"));
    await runDown();
    const schema1 = await schema();
    expect(schema1).toEqual(schema0);
    const data1 = await dump();
    expect(data1).toEqual(data0);
    const recorded = (await rows<{ name: string }>(`SELECT name FROM d1_migrations`)).map((r) => r.name.slice(0, 4));
    for (const n of UP) expect(recorded).not.toContain(n);
    // …so applying again works, and lands in the same place.
    await applyD1Migrations(db(), upTo("0040"));
    expect((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM memberships`))!.n).toBe(2);
  });

  // 0041–0043 came after the generator: 0043's two tables reference orgs(id), so its hand-written
  // rollback (scripts/mt/rollback/0043.down.sql) runs FIRST, then the generated file.
  it("0043.down.sql, then the generated rollback: a database at 0043 is back on the 0036 schema (plus 0042's platform_admins)", async () => {
    await at0036WithData();
    await applyD1Migrations(db(), before0037());
    const schema0 = await schema();
    await applyD1Migrations(db(), upTo("0043"));
    await db().prepare(`INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, '2026-10-06', 'api_read', 'x', 1, 't')`).bind(LEGACY).run();
    await db().prepare(`INSERT INTO org_admin_audit (org_id, actor, action, target, at) VALUES (?, 'x', 'org.update', 'settings', 't')`).bind(LEGACY).run();
    // 0046.down.sql (one free-standing table) is order-independent and a no-op here: `runDown` above runs it too.
    expect(env.MT_ROLLBACK.map((m) => m.name).sort()).toEqual(["0037-0040.down.sql", "0043.down.sql", "0046.down.sql"]);
    const inOrder = env.MT_ROLLBACK.filter((m) => m.name !== "0046.down.sql").sort((a, b) => b.name.localeCompare(a.name)); // 0043 first
    await db().batch(inOrder[0].queries.map((q) => db().prepare(q)));
    expect(await rows(`SELECT name FROM sqlite_master WHERE name LIKE 'org_usage_daily%' OR name LIKE '%org_admin_audit%'`)).toEqual([]);
    expect(await one(`SELECT name FROM sqlite_master WHERE name = 'orgs'`)).toEqual({ name: "orgs" }); // nothing else was touched
    await db().batch(inOrder[1].queries.map((q) => db().prepare(q)));
    expect((await schema()).filter((o) => !o.includes("platform_admins"))).toEqual(schema0);
    expect((await rows<{ name: string }>(`SELECT name FROM d1_migrations`)).map((r) => r.name.slice(0, 4)).filter((n) => n >= "0037").sort()).toEqual(["0041", "0042"]);
  });

  it("0046.down.sql drops the abuse counters and forgets the migration; running it twice, or before 0046, is a no-op", async () => {
    await at0036WithData();
    const down = env.MT_ROLLBACK.find((m) => m.name === "0046.down.sql")!;
    const runIt = () => db().batch(down.queries.map((q) => db().prepare(q)));
    await applyD1Migrations(db(), before0037());
    await runIt(); // never applied: nothing to do
    await applyD1Migrations(db(), upTo("0046"));
    const before = (await schema()).filter((o) => !o.includes("abuse_counters"));
    await db().prepare(`INSERT INTO abuse_counters (subject, action, bucket, count, last_at) VALUES ('x', 'invite', '2026-10-06', 1, 't')`).run();
    await runIt();
    await runIt();
    expect(await schema()).toEqual(before);
    expect((await rows<{ name: string }>(`SELECT name FROM d1_migrations`)).map((r) => r.name.slice(0, 4))).not.toContain("0046");
    await applyD1Migrations(db(), upTo("0046")); // …and it applies again
    expect(await one(`SELECT name FROM sqlite_master WHERE name = 'abuse_counters'`)).toEqual({ name: "abuse_counters" });
  });

  it("refuses to run once a second org exists (its rows would be lost)", async () => {
    await at0036WithData();
    await applyD1Migrations(db(), upTo("0040"));
    await db().prepare(`INSERT INTO orgs (id, slug, name, created_at, created_by) VALUES ('org_b', 'acme', 'Acme', 't', 'x')`).run();
    await expect(runDown()).rejects.toThrow();
    expect(await one(`SELECT id FROM orgs WHERE id = 'org_b'`)).toEqual({ id: "org_b" });
  });
});

describe("0041 — the sender's rename", () => {
  it("moves the untouched default sender to Trov <hello@trov.dev>", async () => {
    await at0036WithData();
    await applyD1Migrations(db(), upTo("0041"));
    expect(await one(`SELECT from_address FROM notification_settings WHERE org_id = ?`, LEGACY)).toEqual({ from_address: "Trov <hello@trov.dev>" });
  });

  it("leaves an admin's own sender alone", async () => {
    await at0036WithData([`UPDATE notification_settings SET from_address = 'Team <team@example.org>' WHERE id = 1`]);
    await applyD1Migrations(db(), upTo("0041"));
    expect(await one(`SELECT from_address FROM notification_settings WHERE org_id = ?`, LEGACY)).toEqual({ from_address: "Team <team@example.org>" });
  });
});

describe("0042 — the superadmin", () => {
  it("andres is the one platform admin, and still the only owner of SaplingLearn", async () => {
    await at0036WithData();
    await applyD1Migrations(db(), upTo("0042"));
    expect(await rows(`SELECT person, granted_by FROM platform_admins`)).toEqual([{ person: "andres", granted_by: "migration" }]);
    expect(await rows(`SELECT user_id, role FROM memberships WHERE role IN ('owner', 'admin')`)).toEqual([{ user_id: "andres", role: "owner" }]);
  });
});
