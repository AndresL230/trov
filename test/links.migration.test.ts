/**
 * 0078_agent_links against REAL workerd D1: `MT_DB` (the second, empty database of vitest.config.ts) is wiped,
 * migrated to just before it, given two orgs with tickets and handoffs (so their counters have moved — and one
 * ticket deleted, so the counter is ahead of MAX(number)), and then given the migration. The assertions are the
 * header's claims: org_counters keeps every row and value, its CHECK now takes 'link' and still refuses anything
 * else, every org has a 'link' counter, ticket and handoff numbering continues across the rebuild, and a link's
 * number comes from its own org's counter.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";

const MIGRATION = "0078_agent_links.sql";
const db = () => env.MT_DB;
const before = () => env.TEST_MIGRATIONS.filter((m) => m.name < MIGRATION);
const own = () => env.TEST_MIGRATIONS.filter((m) => m.name === MIGRATION);
const q = async <T>(sql: string, ...p: unknown[]) => (await db().prepare(sql).bind(...p).all<T>()).results;
const exec = (sql: string, ...p: unknown[]) => db().prepare(sql).bind(...p).run();

/** Drop everything in MT_DB (as test/tags.migration.test.ts does) — the parents of the rows this suite writes
 *  last, since dropping a child that still holds rows checks them against its parent table. */
async function wipe(): Promise<void> {
  const objs = (await db().prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ type: string; name: string; sql: string | null }>()).results;
  if (!objs.length) return;
  const triggers = objs.filter((o) => o.type === "trigger").map((o) => `DROP TRIGGER IF EXISTS "${o.name}"`);
  const virtual = objs.filter((o) => o.type === "table" && /VIRTUAL TABLE/i.test(o.sql ?? "")).map((o) => o.name);
  const shadow = (n: string) => virtual.some((v) => n.startsWith(`${v}_`));
  const LAST = ["tickets", "persons", "orgs"];
  const tables = objs.filter((o) => o.type === "table" && !virtual.includes(o.name) && !shadow(o.name))
    .map((o) => o.name).sort((a, b) => LAST.indexOf(a) - LAST.indexOf(b)).map((n) => `DROP TABLE IF EXISTS "${n}"`);
  await db().batch([
    db().prepare("PRAGMA defer_foreign_keys = true"),
    ...triggers.map((s) => db().prepare(s)),
    ...virtual.map((v) => db().prepare(`DROP TABLE IF EXISTS "${v}"`)),
    ...tables.map((s) => db().prepare(s)),
    db().prepare("PRAGMA defer_foreign_keys = false"),
  ]);
}

const T = "2026-10-17T00:00:00.000Z";
const ticket = (org: string, title: string) =>
  exec(`INSERT INTO tickets (org_id, title, requester, created_at, updated_at) VALUES (?, ?, 'andres', ?, ?)`, org, title, T, T);
const handoff = (org: string, body: string) =>
  exec(`INSERT INTO handoffs (org_id, sender, recipient, body, created_at, expires_at) VALUES (?, 'andres', 'anyone', ?, ?, ?)`, org, body, T, T);
const link = (org: string) =>
  exec(`INSERT INTO agent_links (org_id, state, topic_kind, topic_ref, reason, requester, recipient, created_at, expires_at)
        VALUES (?, 'draft', 'person', 'bea', 'r', 'andres', 'bea', ?, ?)`, org, T, T);
const counters = () => q<{ org_id: string; name: string; value: number }>(`SELECT org_id, name, value FROM org_counters ORDER BY org_id, name`);

beforeEach(async () => {
  await wipe();
  await applyD1Migrations(db(), before());
  await exec(`INSERT OR IGNORE INTO orgs (id, slug, name, created_at, created_by) VALUES ('org_saplinglearn', 'saplinglearn', 'SaplingLearn', 't', 'migration')`);
  await exec(`INSERT INTO orgs (id, slug, name, created_at, created_by) VALUES ('org_two', 'two', 'Two', 't', 'migration')`);
  await exec(`INSERT INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('andres', 'Andres', 'moss', 't', 't')`);
  for (const t of ["a", "b", "c"]) await ticket("org_saplinglearn", t);
  await exec(`DELETE FROM tickets WHERE org_id = 'org_saplinglearn' AND number = 3`); // the counter stays at 3
  await ticket("org_two", "x");
  for (const h of ["a", "b"]) await handoff("org_saplinglearn", h);
});

describe("0078_agent_links", () => {
  it("before it, org_counters refuses a 'link' row", async () => {
    await expect(exec(`INSERT INTO org_counters (org_id, name, value) VALUES ('org_two', 'link', 0)`)).rejects.toThrow(/CHECK/i);
  });

  it("keeps every counter with its value, and gives every org a 'link' counter at 0", async () => {
    const was = await counters();
    expect(was).toEqual([
      { org_id: "org_saplinglearn", name: "handoff", value: 2 }, { org_id: "org_saplinglearn", name: "ticket", value: 3 },
      { org_id: "org_two", name: "ticket", value: 1 },
    ]);
    await applyD1Migrations(db(), own());
    expect(await counters()).toEqual([
      { org_id: "org_saplinglearn", name: "handoff", value: 2 }, { org_id: "org_saplinglearn", name: "link", value: 0 },
      { org_id: "org_saplinglearn", name: "ticket", value: 3 },
      { org_id: "org_two", name: "link", value: 0 }, { org_id: "org_two", name: "ticket", value: 1 },
    ]);
  });

  it("ticket and handoff numbering continues across the rebuild — a deleted ticket's number is not reissued", async () => {
    await applyD1Migrations(db(), own());
    await ticket("org_saplinglearn", "d");
    await ticket("org_two", "y");
    await handoff("org_saplinglearn", "c");
    await handoff("org_two", "first");
    expect(await q(`SELECT org_id, title, number FROM tickets ORDER BY id`)).toEqual([
      { org_id: "org_saplinglearn", title: "a", number: 1 }, { org_id: "org_saplinglearn", title: "b", number: 2 },
      { org_id: "org_two", title: "x", number: 1 },
      { org_id: "org_saplinglearn", title: "d", number: 4 }, { org_id: "org_two", title: "y", number: 2 },
    ]);
    expect(await q(`SELECT org_id, body, number FROM handoffs ORDER BY id`)).toEqual([
      { org_id: "org_saplinglearn", body: "a", number: 1 }, { org_id: "org_saplinglearn", body: "b", number: 2 },
      { org_id: "org_saplinglearn", body: "c", number: 3 }, { org_id: "org_two", body: "first", number: 1 },
    ]);
  });

  it("a link takes its own org's next number; the CHECK still refuses an unknown counter", async () => {
    await applyD1Migrations(db(), own());
    for (const org of ["org_two", "org_saplinglearn", "org_two"]) await link(org);
    expect(await q(`SELECT org_id, number FROM agent_links ORDER BY id`)).toEqual([
      { org_id: "org_two", number: 1 }, { org_id: "org_saplinglearn", number: 1 }, { org_id: "org_two", number: 2 },
    ]);
    expect((await counters()).filter((c) => c.name === "link")).toEqual([
      { org_id: "org_saplinglearn", name: "link", value: 1 }, { org_id: "org_two", name: "link", value: 2 },
    ]);
    await expect(exec(`INSERT INTO org_counters (org_id, name, value) VALUES ('org_two', 'sprint', 0)`)).rejects.toThrow(/CHECK/i);
    // The rebuilt table is the old one plus 'link': same key, a non-negative value.
    await expect(exec(`INSERT INTO org_counters (org_id, name, value) VALUES ('org_two', 'link', 0)`)).rejects.toThrow(/UNIQUE|PRIMARY/i);
    await expect(exec(`UPDATE org_counters SET value = -1 WHERE org_id = 'org_two' AND name = 'link'`)).rejects.toThrow(/CHECK/i);
  });

  it("a note belongs to a link of its org: an unknown (org, number) is refused", async () => {
    await applyD1Migrations(db(), own());
    await link("org_two");
    const note = (org: string, n: number) => exec(`INSERT INTO agent_link_notes (org_id, link_number, side, author, author_kind, author_agent_session, body, created_at)
      VALUES (?, ?, 'requester', 'andres', 'agent', 's', 'hi', ?)`, org, n, T);
    await note("org_two", 1);
    await expect(note("org_saplinglearn", 1)).rejects.toThrow(/FOREIGN KEY/i);
    await expect(exec(`INSERT INTO agent_link_notes (org_id, link_number, side, author, author_kind, author_agent_session, body, created_at)
      VALUES ('org_two', 1, 'requester', 'andres', 'person', 's', 'hi', ?)`, T)).rejects.toThrow(/CHECK/i); // a person's note has no session
    await expect(exec(`INSERT INTO agent_link_notes (org_id, link_number, side, author, author_kind, author_agent_session, body, created_at)
      VALUES ('org_two', 1, 'requester', 'andres', 'agent', 's', ?, ?)`, "x".repeat(1001), T)).rejects.toThrow(/CHECK/i);
  });
});
