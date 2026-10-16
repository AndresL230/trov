// The server-side AI e2e seed (scripts/seed/server-ai-e2e.mjs; docs/testing/server-ai-test-matrix.md): its statement
// builder against THIS branch's real schema — every section whose tables exist runs and every fixture it names is
// there; a section whose migration is missing is skipped (never a half-written section); a second run gives the same
// rows (idempotent); and the literal builder escapes what it must.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  SECTIONS, SCHEMA_SQL, insert, isoWeekId, missingFrom, schemaFromRows, serverAiE2eStatements, allFixtures,
} from "../scripts/seed/server-ai-e2e.mjs";
import { targetsRemote } from "../scripts/seed/build.mjs";
import { RefViewSchema } from "@shared/ai-ask";

const NOW = new Date("2026-10-15T12:00:00.000Z");

async function schema() {
  const { results } = await env.DB.prepare(SCHEMA_SQL).all<{ t: string; c: string }>();
  return schemaFromRows(results);
}

async function seed() {
  const out = serverAiE2eStatements(await schema(), { now: NOW, base: false });
  for (const st of out.statements) await env.DB.prepare(st).run();
  return out;
}

async function count(sql: string): Promise<number> {
  const row = await env.DB.prepare(sql).first<{ n: number }>();
  return Number(row?.n ?? 0);
}
// The idempotence case writes the whole seed twice: 30 s per case (5 s ran out under a loaded full suite).
// The seed writes a few thousand statements twice in one test: 30 s each (5 s ran out under a loaded full suite).
describe("server-ai e2e seed", { timeout: 30_000 }, () => {
  it("runs every section this schema can take, and every fixture of those sections is present", async () => {
    const { sections, fixtures } = await seed();
    const s = await schema();
    for (const sec of sections) expect(sec.ran).toBe(missingFrom(s, sec.needs) === null);
    expect(sections.find((x) => x.id === "core")?.ran).toBe(true);
    expect(sections.find((x) => x.id === "ask")?.ran).toBe(true);
    expect(fixtures.length).toBeGreaterThan(40);
    const missing: string[] = [];
    for (const f of fixtures) for (const [sql, least] of f.checks) if ((await count(sql)) < least) missing.push(`${f.name}: ${sql}`);
    expect(missing).toEqual([]);
  });

  it("is idempotent: a second run leaves the same test rows", async () => {
    const tally = () => count(`SELECT (SELECT COUNT(*) FROM orgs WHERE id LIKE 'org_test_%') + (SELECT COUNT(*) FROM tickets WHERE org_id LIKE 'org_test_%') * 1000 + (SELECT COUNT(*) FROM ai_suggestions) * 1000000 + (SELECT COUNT(*) FROM chat_actions) * 100000000 AS n`);
    await seed();
    const once = await tally();
    await seed();
    expect(await tally()).toBe(once);
    expect(once).toBeGreaterThan(0);
  });

  // e2e AU-6: a seeded cite whose mark is not one of ASK_MARKS drew "undefined" in the chip. A stored cite is a
  // RefView the server built, so every seeded one must pass the contract's own schema.
  it("stores Ask cites that are valid RefViews (the contract's marks and tones)", async () => {
    await seed();
    const rows = await env.DB.prepare("SELECT id, cites_json FROM chat_messages WHERE org_id LIKE 'org_test_%' AND cites_json <> '[]'").all<{ id: number; cites_json: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const r of rows.results) for (const v of JSON.parse(r.cites_json) as unknown[]) {
      const p = RefViewSchema.safeParse(v);
      if (!p.success) bad.push(`${r.id}: ${JSON.stringify(p.error.issues.map((i) => i.path.join(".")))}`);
    }
    expect(bad).toEqual([]);
  });

  // e2e TC-1 / TC-3 (Phase H): the ticket category / priority rows were stored as a bare `bug`, not the JSON the
  // writer (src/data/ai.ts `JSON.stringify(value)`) stores, so the chips read "Suggested: null category" and Accept
  // was refused.
  it("stores every suggestion's value as the JSON the writer would (the reads JSON.parse it)", async () => {
    await seed();
    const rows = await env.DB.prepare("SELECT id, value_json FROM ai_suggestions").all<{ id: number; value_json: string }>();
    const bad = rows.results.filter((r) => { try { JSON.parse(r.value_json); return false; } catch { return true; } }).map((r) => r.id);
    expect(bad).toEqual([]);
    const cat = await env.DB.prepare("SELECT value_json FROM ai_suggestions WHERE id = 5101").first<{ value_json: string }>();
    expect(cat?.value_json).toBe('"bug"');
  });

  it("only ever writes obviously fake rows: test- handles and org_test_ orgs", async () => {
    await seed();
    const persons = await env.DB.prepare("SELECT handle, email FROM persons WHERE handle LIKE 'test-%'").all<{ handle: string; email: string | null }>();
    expect(persons.results.length).toBeGreaterThan(5);
    for (const p of persons.results) if (p.email !== null) expect(p.email).toMatch(/@example\.com$/);
    const orgs = await env.DB.prepare("SELECT id, slug FROM orgs WHERE id LIKE 'org_test_%'").all<{ id: string; slug: string }>();
    for (const o of orgs.results) expect(o.slug).toMatch(/^test-/);
  });

  it("skips a section whose table is missing, naming it", () => {
    const empty = schemaFromRows([{ t: "orgs", c: "id" }]);
    const { sections, statements } = serverAiE2eStatements(empty, { now: NOW, base: false });
    expect(sections.every((x) => !x.ran)).toBe(true);
    expect(sections.find((x) => x.id === "phase-e-emails")?.missing).toBe("notification_person_prefs");
    expect(statements.some((st) => st.includes("org_test_"))).toBe(false);
  });

  it("names every section's migration as one that exists on a branch (no reserved-but-unused names)", () => {
    for (const sec of SECTIONS) expect(sec.migration).not.toMatch(/only_when_needed/);
    expect(allFixtures(NOW).every((f) => SECTIONS.some((s) => s.id === f.section))).toBe(true);
  });

  it("builds literals safely and computes ISO weeks like window.ts", () => {
    expect(insert("t", { a: "O'Hara", b: null, c: 3, d: true, e: { x: 1 }, f: { sql: "now()" } }))
      .toBe("INSERT INTO t (a, b, c, d, e, f) VALUES ('O''Hara', NULL, 3, 1, '{\"x\":1}', now())");
    expect(isoWeekId(new Date("2026-10-15T12:00:00Z"))).toBe("2026-W42");
    expect(isoWeekId(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
    expect(targetsRemote(["--remote"])).toBe(true);
  });
});
