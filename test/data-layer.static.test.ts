// The Phase 3 exit criteria, enforced over the SOURCE TEXT of src/ (canopy-multitenancy.md §4.4).
//
//   1. D1 is reached only inside src/data/ — no `.prepare(` / `.batch(` / `.exec(` / `D1Database` /
//      `env.DB` anywhere else. No allowlist.
//   2. A statement run on the TENANT surface (src/data/sql.ts) names `org_id` once per org-keyed table
//      it references, lists `org_id` in every INSERT's columns and in every upsert target, and never
//      compares it to a literal.
//   3. A statement run on the PLATFORM surface (src/data/platform-sql.ts) names no tenant table —
//      except the declared, deliberately cross-org statements in PLATFORM_ALLOW below.
//   4. The table lists are read from the live schema after migrations: every table with an `org_id`
//      column is org-keyed, so a new table is covered the day its migration lands.
//
// How a statement is found and attributed: test/helpers/sql-extract.ts. A failure names file:line, the
// rule and the statement. docs/architecture/data-layer.md describes the conventions this checks.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { scanSource, surfaceImports, surfaceOfLiteral, type Literal, type Surface } from "./helpers/sql-extract";

const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }))
    .map(([path, text]) => [path.replace(/^\.\.\//, ""), text]),
);

// ── rule 4: the table lists ──────────────────────────────────────────────────

/**
 * Org-keyed tables that are PLATFORM-owned: rows about an org's place on the platform (who is in it,
 * who was invited, its counters, its metering, its admin trail), written by the platform modules
 * (src/orgs, src/platform, src/data/meter.ts). A platform statement may name them. Every OTHER table
 * with an `org_id` column is a TENANT table — including `org_repos`, `org_environments`,
 * `org_integration_config`, `org_login_map`, `org_secrets`, `org_keys` and `org_audit`, which hold an
 * org's own configuration and are read through a TenantContext (src/integrations, src/data/secrets.ts).
 * A tenant statement must name `org_id` for a table of EITHER kind.
 */
const PLATFORM_OWNED = ["memberships", "org_invites", "org_counters", "org_usage_daily", "org_admin_audit"];

let ORG_KEYED: Set<string>;
let TENANT: Set<string>;

beforeAll(async () => {
  const tables = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'd1_%'`,
  ).all<{ name: string }>();
  const keyed: string[] = [];
  for (const t of tables.results) {
    const cols = await env.DB.prepare(`SELECT name FROM pragma_table_info(?)`).bind(t.name).all<{ name: string }>();
    if (cols.results.some((c) => c.name === "org_id")) keyed.push(t.name);
  }
  ORG_KEYED = new Set(keyed);
  TENANT = new Set(keyed.filter((t) => !PLATFORM_OWNED.includes(t)));
});

// ── the declared exceptions ──────────────────────────────────────────────────

interface Allow { file: string; fn: string; tables?: string[]; why: string }

/**
 * Rule 3 — platform statements that name a tenant table ON PURPOSE. `fn` is the top-level declaration
 * the statement sits in (`*` = the whole file). An entry that matches nothing fails the test, so this
 * list cannot outlive the code it excuses.
 */
const PLATFORM_ALLOW: Allow[] = [
  // The cross-org retention sweeps (§4.4): write-only, bounded by age, run by the cron for every org.
  { file: "src/auth/oauth.ts", fn: "pruneOAuth", tables: ["oauth_grants", "oauth_codes"], why: "retention sweep, cross-org and write-only" },
  { file: "src/platform/sweeps.ts", fn: "pruneRepoCapture", tables: ["repo_events", "repo_metrics", "hosting_deploys"], why: "retention sweep, cross-org and write-only" },
  { file: "src/platform/sweeps.ts", fn: "expireDueHandoffs", tables: ["handoffs"], why: "retention sweep, cross-org and write-only (§4.4)" },
  // Bearer credentials are looked up by HASH before any org is known: the row is what names the
  // (person, org), and src/data/bearer.ts then checks that membership live (§7.1). Each lookup is listed
  // by function. Minting / listing / revoking a personal token and writing a grant with its code run on
  // the TENANT surface (rule 2 holds them to `org_id`), so they need — and have — no entry here.
  { file: "src/auth/tokens.ts", fn: "resolveToken", tables: ["mcp_tokens"], why: "token lookup by hash (+ the last_used_at bump, by the id just read)" },
  { file: "src/auth/oauth.ts", fn: "resolveOAuthAccessToken", tables: ["oauth_grants"], why: "access-token lookup by hash → its grant's (person, org) (+ the last_used_at bump)" },
  { file: "src/auth/oauth.ts", fn: "exchangeAuthorizationCode", tables: ["oauth_codes", "oauth_grants"], why: "code lookup by hash at the public token endpoint; its grant read by the id on the code" },
  { file: "src/auth/oauth.ts", fn: "refreshAccessToken", tables: ["oauth_grants"], why: "refresh-token lookup by hash → its grant; a reused token revokes that grant" },
  { file: "src/auth/oauth.ts", fn: "revokeOAuthToken", tables: ["oauth_grants"], why: "RFC 7009: a presented refresh token, found by hash, revokes its own grant" },
  { file: "src/auth/oauth.ts", fn: "grantRefusal", tables: ["oauth_grants"], why: "revokes the ONE grant just found by hash, when its person has left the grant's org" },
  // Settings › Connected apps is USER-level (§6.3): a person's own connections across every org they
  // made one into, each row naming its org — keyed by the person, never by an org.
  { file: "src/auth/oauth.ts", fn: "listGrants", tables: ["oauth_grants"], why: "a person's own connections across their orgs; each row names its org" },
  { file: "src/auth/oauth.ts", fn: "revokeGrant", tables: ["oauth_grants"], why: "a person revokes their OWN connection — by id AND person — whichever org it is into" },
  // The upload PUT has no session: its single-use token is looked up by hash to learn its org, and
  // everything after runs as that org's system tenant.
  { file: "src/artifacts/upload.ts", fn: "uploadTokenOrg", tables: ["doc_image_upload_tokens", "artifact_upload_tokens"], why: "upload-token lookup by hash, returning only its org_id" },
  // The superadmin (§5.4): the usage page counts rows per org — counts only, never content — and the
  // audit page merges both trails (`org_admin_audit` + the secret trail). A secret audit row names the
  // action, the kind and the actor, never a value.
  { file: "src/platform/repo.ts", fn: "listAudit", tables: ["org_audit"], why: "the superadmin's merged audit trail; org_audit holds no secret material" },
  { file: "src/platform/usage.ts", fn: "*", why: "the superadmin's cross-org usage COUNTS — no content column is selected" },
  // Background work is per org (§8.3, §8.5): the cron's dispatcher lists its units — (org, environment)
  // and org-with-a-primary-repo — and a webhook delivery finds its org by hook id, BEFORE any org is
  // known. Ids, an environment key and a repo name only; everything after runs as that org's tenant.
  { file: "src/platform/jobs.ts", fn: "*", tables: ["org_repos", "org_environments"], why: "the cron's unit lists and the webhook's hook lookup — ids and a repo name, no content, no secret" },
  // The `hosting` job's units (src/repo/cron.ts, :40): one per (org, environment, STORED part), with the
  // part's provider id — what the unit's subrequest cost is looked up by. Keys and a provider id only;
  // the part's settings are read again by the unit, as that org's system tenant.
  { file: "src/platform/jobs.ts", fn: "listPartUnits", tables: ["org_environment_parts"], why: "the hosting job's unit list — env / part keys and a provider id, no settings, no secret" },
  // A hosting provider's VERIFIED "uninstalled" notice names only its installation id, so the org(s) holding
  // that installation are found across orgs BEFORE any org is known; the revocation then runs as each org's
  // system tenant (src/hosting/connections.ts `revokeFromProviderSide`). Org ids and a scope only.
  { file: "src/hosting/webhook.ts", fn: "connectionsForExternalId", tables: ["org_hosting_connections"], why: "the uninstall notice's org lookup by installation id — org ids and a scope, no secret" },
  // Removing a member revokes that person's tokens for the org in the same batch as the membership row.
  { file: "src/orgs/repo.ts", fn: "removeMember", tables: ["mcp_tokens", "oauth_grants"], why: "member removal revokes the person's credentials for that org, atomically" },
];

/**
 * Statements whose table name is INTERPOLATED, so no rule can read it: classified by hand, as the
 * audit did (Appendix A). Each must still be listed here, and a tenant one must carry `org_id`.
 */
const INTERPOLATED_ALLOW: (Allow & { surface: Surface })[] = [
  { file: "src/tools/artifacts.ts", fn: "normalizeLinkRef", surface: "tenant",
    why: "`tickets WHERE number` or `sprints WHERE id`, picked from a two-value literal — … = ? AND org_id = ?" },
  { file: "src/auth/persons.ts", fn: "renamePerson", surface: "platform",
    why: "the HANDLE_COLUMNS update: a rename MUST rewrite the handle in every org's rows (C-14)" },
];

/** Rule 2 — upsert targets that cannot name the org. */
const UPSERT_ALLOW: Allow[] = [
  // `sprint_progress`'s primary key is `sprint_id` ALONE (0042_organizations added org_id as a column; the key is
  // rebuilt in the Phase 7 cleanup), so `ON CONFLICT(sprint_id)` is the only target SQLite accepts. The
  // statement is still org-safe: its DO UPDATE carries `WHERE sprint_progress.org_id = excluded.org_id`,
  // so a sprint id from another org updates nothing. The check below asserts that guard is present.
  { file: "src/tools/progress.ts", fn: "*", tables: ["sprint_progress"], why: "PK is sprint_id alone; guarded by WHERE sprint_progress.org_id = excluded.org_id" },
];

// ── extraction ───────────────────────────────────────────────────────────────

const TABLE_REF = /\b(FROM|JOIN|INTO|UPDATE)\s+(\$\{[^}]*\}|[A-Za-z_]\w*)/g;
const LOOKS_LIKE_SQL = /\bSELECT\b[\s\S]*\bFROM\b|\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b|\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b/;

interface Statement extends Literal { surface: Surface | "ambiguous" | null; refs: string[]; interpolated: boolean }

/** Every literal in `sources` that references a table in a FROM / JOIN / INTO / UPDATE position. */
function statements(sources: Record<string, string>, orgKeyed: Set<string>): Statement[] {
  const out: Statement[] = [];
  for (const [file, src] of Object.entries(sources)) {
    const { helpers } = surfaceImports(file, src);
    const scan = scanSource(file, src);
    for (const lit of scan.literals) {
      const refs: string[] = [];
      let interpolated = false;
      for (const m of lit.text.matchAll(TABLE_REF)) {
        if (m[2].startsWith("${")) interpolated ||= LOOKS_LIKE_SQL.test(lit.text);
        else if (orgKeyed.has(m[2])) refs.push(m[2]);
      }
      if (refs.length || interpolated) out.push({ ...lit, surface: surfaceOfLiteral(lit, helpers, scan), refs, interpolated });
    }
  }
  return out;
}

const at = (s: Literal) => `${s.file}:${s.line}`;
const show = (s: Literal) => s.text.replace(/\s+/g, " ").trim().slice(0, 220);
const allowed = (list: Allow[], s: Statement, table?: string) =>
  list.find((a) => a.file === s.file && (a.fn === "*" || a.fn === s.fn) && (!a.tables || !table || a.tables.includes(table)));

interface Violation { where: string; rule: string; statement: string }

/** Rule 1: D1 outside src/data/. */
function d1Leaks(sources: Record<string, string>): Violation[] {
  const out: Violation[] = [];
  const patterns: [RegExp, string][] = [
    [/\.prepare\(/g, ".prepare("], [/\.batch\(/g, ".batch("], [/\bD1Database\b/g, "D1Database"],
    [/\bD1PreparedStatement\b/g, "D1PreparedStatement"], [/\bD1Result\b/g, "D1Result"],
    [/\benv\.DB\b/g, "env.DB"],
  ];
  for (const [file, src] of Object.entries(sources)) {
    if (file.startsWith("src/data/")) continue;
    const { code, regexEnds } = scanSource(file, src);
    const lineOf = (i: number) => code.slice(0, i).split("\n").length;
    const lineText = (i: number) => src.split("\n")[lineOf(i) - 1].trim();
    for (const [re, name] of patterns) {
      for (const m of code.matchAll(re)) out.push({ where: `${file}:${lineOf(m.index)}`, rule: `1: ${name} outside src/data/`, statement: lineText(m.index) });
    }
    // `.exec(` is D1's unless it is called on a regex: a regex literal, or a name this file binds to one.
    const regexNames = new Set([...code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:\/|new RegExp\b)/g)].map((m) => m[1]));
    for (const m of code.matchAll(/\.exec\(/g)) {
      const receiver = /[\w$]*$/.exec(code.slice(0, m.index))![0];
      if (regexEnds.has(m.index) || regexNames.has(receiver)) continue;
      out.push({ where: `${file}:${lineOf(m.index)}`, rule: "1: .exec( outside src/data/", statement: lineText(m.index) });
    }
  }
  return out;
}

/** Rule 2: tenant-surface statements. `null` surface (a file with no query import) is held to the same rule. */
function tenantViolations(all: Statement[], orgKeyed: Set<string>): Violation[] {
  const out: Violation[] = [];
  const bad = (s: Statement, rule: string) => out.push({ where: at(s), rule, statement: show(s) });
  for (const s of all) {
    if (s.surface === "platform") continue;
    if (s.surface === "ambiguous") {
      bad(s, "2: this file imports BOTH query surfaces and the statement's cannot be told — pass it inline to the helper that runs it");
      continue;
    }
    if (s.interpolated && !INTERPOLATED_ALLOW.some((a) => a.surface === "tenant" && a.file === s.file && a.fn === s.fn)) {
      bad(s, "2: interpolated table name — classify it in INTERPOLATED_ALLOW");
    }
    const orgIds = (s.text.match(/\borg_id\b/g) ?? []).length;
    if (orgIds < s.refs.length) bad(s, `2: names ${s.refs.length} org-keyed table(s) [${s.refs.join(", ")}] but org_id ${orgIds} time(s)`);
    if (/\borg_id\s*=\s*'/.test(s.text)) bad(s, "2: org_id compared to a literal — bind ctx.orgId");
    for (const m of s.text.matchAll(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*(\(([^)]*)\))?/g)) {
      if (!orgKeyed.has(m[1])) continue;
      if (!m[3] || !/\borg_id\b/.test(m[3])) bad(s, `2: INSERT INTO ${m[1]} does not list org_id`);
      for (const c of s.text.matchAll(/\bON\s+CONFLICT\s*\(([^)]*)\)/g)) {
        if (/\borg_id\b/.test(c[1])) continue;
        if (!allowed(UPSERT_ALLOW, s, m[1])) bad(s, `2: upsert target ON CONFLICT(${c[1].trim()}) does not name org_id`);
        else if (!new RegExp(`\\b${m[1]}\\.org_id\\s*=\\s*excluded\\.org_id\\b`).test(s.text)) bad(s, `2: allowlisted upsert lost its ${m[1]}.org_id = excluded.org_id guard`);
      }
    }
  }
  return out;
}

/** Rule 3: platform-surface statements. */
function platformViolations(all: Statement[], tenant: Set<string>, used?: Set<Allow>): Violation[] {
  const out: Violation[] = [];
  for (const s of all) {
    if (s.surface !== "platform") continue;
    if (s.interpolated) {
      const a = INTERPOLATED_ALLOW.find((x) => x.surface === "platform" && x.file === s.file && x.fn === s.fn);
      if (a) used?.add(a);
      else out.push({ where: at(s), rule: "3: interpolated table name — classify it in INTERPOLATED_ALLOW", statement: show(s) });
    }
    for (const table of new Set(s.refs)) {
      if (!tenant.has(table)) continue;
      const a = allowed(PLATFORM_ALLOW, s, table);
      if (a) used?.add(a);
      else out.push({ where: at(s), rule: `3: platform statement in ${s.fn ?? "?"} names tenant table ${table}`, statement: show(s) });
    }
  }
  return out;
}

const report = (v: Violation[]) => v.map((x) => `${x.where}  [rule ${x.rule}]\n    ${x.statement}`).join("\n");

// ── the rules, over src/ ─────────────────────────────────────────────────────

describe("data layer — static enforcement (§4.4)", () => {
  it("reads the whole of src/", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(80);
    expect(SOURCES["src/data/context.ts"]).toContain("resolveTenant");
  });

  it("rule 4: the table lists come from the live schema", () => {
    for (const t of ["tickets", "docs", "feed_fts", "org_secrets", "org_keys", "mcp_tokens", "sprint_progress"]) expect(TENANT.has(t), t).toBe(true);
    for (const t of PLATFORM_OWNED) {
      expect(ORG_KEYED.has(t), `${t} is declared platform-owned but has no org_id column`).toBe(true);
      expect(TENANT.has(t)).toBe(false);
    }
    for (const t of ["persons", "identities", "sessions", "orgs", "invites", "oauth_tokens", "platform_admins"]) expect(ORG_KEYED.has(t), t).toBe(false);
  });

  it("rule 1: no D1 access outside src/data/", () => {
    const v = d1Leaks(SOURCES);
    expect(v, `\n${report(v)}\n`).toEqual([]);
  });

  it("the query surfaces are imported by name (a namespace import would hide a statement's surface)", () => {
    const ns = Object.entries(SOURCES).flatMap(([file, src]) => surfaceImports(file, src).namespace.map((n) => `${file}: import * as ${n}`));
    expect(ns).toEqual([]);
  });

  it("SQL keywords are upper-case (the extractor keys on them)", () => {
    const lower: string[] = [];
    const names = [...ORG_KEYED].join("|");
    const re = new RegExp(`\\bselect\\b[^.;]*\\bfrom\\s+(?:${names})\\b|\\binsert\\s+(?:or\\s+\\w+\\s+)?into\\s+(?:${names})\\b|\\bupdate\\s+(?:${names})\\s+set\\b|\\bdelete\\s+from\\s+(?:${names})\\b`);
    for (const [file, src] of Object.entries(SOURCES)) {
      for (const lit of scanSource(file, src).literals) if (re.test(lit.text)) lower.push(`${at(lit)}  ${show(lit)}`);
    }
    expect(lower, `\n${lower.join("\n")}\n`).toEqual([]);
  });

  it("rule 2: every tenant statement names org_id for each org-keyed table, in every INSERT and upsert target", () => {
    const v = tenantViolations(statements(SOURCES, ORG_KEYED), ORG_KEYED);
    expect(v, `\n${report(v)}\n`).toEqual([]);
  });

  it("rule 3: no platform statement names a tenant table, outside the declared allowlist", () => {
    const used = new Set<Allow>();
    const v = platformViolations(statements(SOURCES, ORG_KEYED), TENANT, used);
    expect(v, `\n${report(v)}\n`).toEqual([]);
    const stale = [...PLATFORM_ALLOW, ...INTERPOLATED_ALLOW.filter((a) => a.surface === "platform")].filter((a) => !used.has(a)).map((a) => `${a.file} ${a.fn}`);
    expect(stale, `allowlist entries that excuse nothing: ${stale.join("; ")}`).toEqual([]);
  });

  // What is still org #1's alone, through src/data/legacy.ts — no entry point acts on "the" org any more
  // (every job, hook and route resolves its own). Each call is marked `// MT:` and lives in one of the
  // files below, with its reason — so the list of what Phase 7 still has to remove is this test, not a grep.
  it("only the marked cut-over entry points reach for the legacy org", () => {
    const ENTRY_POINTS: Record<string, string> = {
      "src/auth/onboard.ts": "liveLegacyInvite — a legacy invite lets a Google account reach onboarding and seeds the invitee's name",
      "src/auth/routes.ts": "consumeLegacyInvite — a new person with a live legacy invite joins org #1 at onboarding (and gets its welcome mail)",
      "src/orgs/legacy-invites.ts": "isLegacyOrg — the legacy `invites` sidecar (a pre-0042_organizations row's invitee name and mail outcome; the row a first sign-in consumes) is read and written for org #1 only",
    };
    // …and the ONE importer of the org's id: the env-secret fallback (`resolveCredential`, §8.7.6).
    const ID_IMPORTERS = ["src/data/secrets.ts"];
    const found = new Set<string>();
    const unmarked: string[] = [];
    for (const [file, src] of Object.entries(SOURCES)) {
      if (file === "src/data/legacy.ts") continue;
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!/\b(isLegacyOrg|liveLegacyInvite|consumeLegacyInvite)\(/.test(line)) return;
        found.add(file);
        if (!lines.slice(Math.max(0, i - 3), i + 1).some((l) => l.includes("// MT:"))) unmarked.push(`${file}:${i + 1}  ${line.trim()}`);
      });
      if (/org_saplinglearn/.test(scanSource(file, src).code)) unmarked.push(`${file}: names org_saplinglearn outside src/data/legacy.ts`);
    }
    expect(unmarked, `\n${unmarked.join("\n")}\n`).toEqual([]);
    expect([...found].sort()).toEqual(Object.keys(ENTRY_POINTS).sort());
    const importers = Object.entries(SOURCES).filter(([file, src]) => file !== "src/data/legacy.ts" && /\bSAPLINGLEARN_ORG_ID\b/.test(scanSource(file, src).code)).map(([file]) => file);
    expect(importers).toEqual(ID_IMPORTERS);
  });

  it("the sprint_progress upsert is still there to be excused", () => {
    const hit = statements(SOURCES, ORG_KEYED).filter((s) => s.file === "src/tools/progress.ts" && /ON\s+CONFLICT\s*\(\s*sprint_id\s*\)/.test(s.text));
    expect(hit).toHaveLength(1);
  });
});

// ── the checker itself: one violation of each kind must be caught ────────────

describe("data layer — the static checker catches what it claims to", () => {
  const keyed = new Set(["tickets", "ticket_links", "memberships", "sprint_progress"]);
  const tenant = new Set(["tickets", "ticket_links", "sprint_progress"]);
  const TEN = `import { type TenantContext, first, run, fanOut } from "../data/sql";\n`;
  const PLAT = `import { type PlatformContext, first, run } from "../data/platform-sql";\n`;
  const rule2 = (body: string, head = TEN) => tenantViolations(statements({ "src/tools/x.ts": head + body }, keyed), keyed);
  const rule3 = (body: string) => platformViolations(statements({ "src/auth/x.ts": PLAT + body }, keyed), tenant);

  it("rule 1", () => {
    const leaks = (src: string) => d1Leaks({ "src/tools/x.ts": src }).map((v) => v.rule);
    expect(leaks("const r = await env.DB.prepare(`SELECT 1`).first();\n")).toEqual(["1: .prepare( outside src/data/", "1: env.DB outside src/data/"]);
    expect(leaks("await c.env.DB.batch([]);\n")).toEqual(["1: .batch( outside src/data/", "1: env.DB outside src/data/"]);
    expect(leaks("function f(db: D1Database) { return db.exec('PRAGMA x'); }\n")).toEqual(["1: D1Database outside src/data/", "1: .exec( outside src/data/"]);
    // not D1: a regex, a name bound to one, and the same words in a comment or inside src/data/.
    expect(leaks("const m = /^a$/.exec(s); const re = /x/g; re.exec(s); // env.DB.prepare(\n/* D1Database */\n")).toEqual([]);
    expect(d1Leaks({ "src/data/sql.ts": "export type Stmt = D1PreparedStatement; d1Of(ctx).prepare(q);" })).toEqual([]);
    expect(d1Leaks({ "src/tools/x.ts": "\n\nx.prepare(q);" })[0].where).toBe("src/tools/x.ts:3");
  });

  it("rule 2: a missing predicate, a missing JOIN predicate, an INSERT without org_id, a literal org, a bare upsert target", () => {
    expect(rule2("const a = (ctx) => first(ctx, `SELECT * FROM tickets WHERE id = ? AND org_id = ?`, 1, ctx.orgId);")).toEqual([]);
    expect(rule2("const a = (ctx) => first(ctx, `SELECT * FROM tickets WHERE id = ?`, 1);")[0]).toMatchObject({ where: "src/tools/x.ts:2", rule: expect.stringContaining("org_id 0 time(s)") });
    expect(rule2("const a = (ctx) => first(ctx, `SELECT 1 FROM tickets t JOIN ticket_links l ON l.ticket_id = t.id WHERE t.org_id = ?`, ctx.orgId);")[0].rule).toContain("names 2 org-keyed table(s)");
    expect(rule2("const a = (ctx) => run(ctx, `INSERT INTO tickets (title) VALUES (?)`, 't');").map((v) => v.rule)).toContain("2: INSERT INTO tickets does not list org_id");
    expect(rule2("const a = (ctx) => first(ctx, `SELECT 1 FROM tickets WHERE org_id = 'org_saplinglearn'`);")[0].rule).toContain("compared to a literal");
    expect(rule2("const a = (ctx) => run(ctx, `INSERT INTO tickets (org_id, id) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET title = 'x'`);")[0].rule).toContain("upsert target");
    // a platform-owned org-keyed table needs its predicate on the tenant surface too
    expect(rule2("const a = (ctx) => first(ctx, `SELECT role FROM memberships WHERE user_id = ?`, 'x');")).toHaveLength(1);
    // a fan-out, a fragment with no SELECT, and a statement outside any helper call are all seen
    expect(rule2("const a = (ctx, ids) => fanOut(ctx, ids, (ph) => `SELECT * FROM tickets WHERE id IN (${ph})`);")).toHaveLength(1);
    expect(rule2("const assignedFrom = `FROM tickets t JOIN ticket_links l ON l.ticket_id = t.id`;")).toHaveLength(1);
    expect(rule2("const a = `DELETE FROM ${table} WHERE id = ?`;")[0].rule).toContain("interpolated table name");
  });

  it("a file that imports both surfaces: a detached statement takes the surface of the call that uses it", () => {
    const both = TEN + `import { first as platformFirst } from "../data/platform-sql";\n`;
    const all = (body: string) => statements({ "src/tools/x.ts": both + body }, keyed);
    // used by a tenant call (as an argument, or as a hole of the statement) → the tenant rule
    expect(tenantViolations(all("const Q = `SELECT * FROM tickets WHERE id = ?`;\nconst a = (ctx) => first<{ n: number }>(ctx, Q, 1);"), keyed)[0].rule).toContain("org_id 0 time(s)");
    expect(tenantViolations(all("const FROM = `FROM tickets t`;\nconst a = (ctx) => first(ctx, `SELECT 1 ${FROM} WHERE t.id = ?`, 1);"), keyed)[0].rule).toContain("org_id 0 time(s)");
    // used by a platform call → rule 3, even though it names org_id
    const plat = all("const Q = `SELECT * FROM tickets WHERE org_id = ?`;\nconst a = (p) => platformFirst(p, Q, 'x');");
    expect(tenantViolations(plat, keyed)).toEqual([]);
    expect(platformViolations(plat, tenant)[0].rule).toContain("names tenant table tickets");
    // used by neither (or by both) → it cannot be attributed, and that is itself a failure
    expect(tenantViolations(all("export const Q = `SELECT * FROM tickets WHERE org_id = ?`;"), keyed)[0].rule).toContain("BOTH query surfaces");
    expect(rule2("const a = (ctx) => first(ctx, `SELECT * FROM tickets WHERE org_id = ?`, ctx.orgId);", both)).toEqual([]);
    expect(rule2("const a = (p) => platformFirst<{ n: number }>(p, `SELECT COUNT(*) AS n FROM tickets`);", both)).toEqual([]); // rule 3's, not rule 2's
  });

  it("rule 3: a platform statement that names a tenant table, and an unclassified interpolated one", () => {
    expect(rule3("export function f(p) { return first(p, `SELECT * FROM persons WHERE handle = ?`, 'a'); }")).toEqual([]);
    expect(rule3("export function f(p) { return first(p, `SELECT role FROM memberships WHERE user_id = ?`, 'a'); }")).toEqual([]);
    expect(rule3("export function f(p) {\n  return first(p, `SELECT * FROM tickets WHERE id = ?`, 1);\n}")[0]).toMatchObject({ where: "src/auth/x.ts:3", rule: "3: platform statement in f names tenant table tickets" });
    expect(rule3("export async function g(p) { await run(p, `UPDATE ${t} SET x = ? WHERE y = ?`, 1, 2); }")[0].rule).toContain("interpolated table name");
  });
});
