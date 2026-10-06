import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, run, nowIso } from "./helpers/db";
import { RESET_STATEMENTS } from "../scripts/seed/reset.mjs";
import { seedPerson } from "./helpers/persons";

// Schema proof for migration 0024_tickets.sql: the five tables, their CHECK
// vocabularies, the tickets_fts index and its ai/au/ad triggers, and the
// harness-truncation isolation those triggers buy.

// The EXACT statement test/apply-migrations.ts runs beforeEach — imported, not
// hand-duplicated, so it can never drift from the real reset.
const HARNESS_TRUNCATION = RESET_STATEMENTS.join("; ") + ";";

const count = async (sql: string, ...p: unknown[]) =>
  (await all<{ n: number }>(env.DB, sql, ...p))[0].n;

const ftsCount = () => count(`SELECT COUNT(*) AS n FROM tickets_fts`);
const ftsMatch = (q: string) =>
  all<{ ticket_id: string }>(env.DB, `SELECT ticket_id FROM tickets_fts WHERE tickets_fts MATCH ?`, q);

async function insertTicket(fields: Partial<{
  title: string; body: string; category: string; priority: string; status: string;
  requester: string; parent_id: number | null;
}> = {}): Promise<number> {
  const now = nowIso();
  const f = {
    title: "Printer offline", body: "The floor printer stopped responding.",
    category: "other", priority: "normal", status: "submitted",
    requester: "meilin", parent_id: null, ...fields,
  };
  await seedPerson(f.requester);
  const res = await run(env.DB,
    `INSERT INTO tickets (title, body, category, priority, status, requester, parent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.title, f.body, f.category, f.priority, f.status, f.requester, f.parent_id, now, now);
  return res.meta.last_row_id as number;
}

describe("0024_tickets — tables and constraints", () => {
  it("creates the five ticket tables", async () => {
    const rows = await all<{ name: string }>(env.DB,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tickets','ticket_assignees','ticket_links','ticket_comments','ticket_events') ORDER BY name`);
    expect(rows.map((r) => r.name)).toEqual(["ticket_assignees", "ticket_comments", "ticket_events", "ticket_links", "tickets"]);
  });

  it("applies the column defaults the brief specifies", async () => {
    await seedPerson("meilin");
    const now = nowIso();
    await run(env.DB, `INSERT INTO tickets (title, requester, created_at, updated_at) VALUES ('Bare ticket', 'meilin', ?, ?)`, now, now);
    const row = await all<{ body: string; category: string; priority: string; status: string; parent_id: number | null; sprint_id: number | null }>(
      env.DB, `SELECT body, category, priority, status, parent_id, sprint_id FROM tickets WHERE title = 'Bare ticket'`);
    expect(row[0]).toEqual({ body: "", category: "other", priority: "normal", status: "submitted", parent_id: null, sprint_id: null });
  });

  it("CHECK constraints reject an out-of-vocabulary category, priority or status", async () => {
    await expect(insertTicket({ category: "chore" })).rejects.toThrow();
    await expect(insertTicket({ priority: "urgent" })).rejects.toThrow();
    await expect(insertTicket({ status: "closed" })).rejects.toThrow();
    // …and every in-vocabulary value is accepted.
    for (const category of ["bug", "request", "question", "access", "other"]) {
      await expect(insertTicket({ category })).resolves.toBeGreaterThan(0);
    }
    for (const status of ["submitted", "in_progress", "done", "declined"]) {
      await expect(insertTicket({ status })).resolves.toBeGreaterThan(0);
    }
  });

  it("CHECK constraints police ticket_links.kind and the ticket_events status pair", async () => {
    const id = await insertTicket();
    const now = nowIso();
    const link = (kind: string) => run(env.DB,
      `INSERT INTO ticket_links (ticket_id, url, kind, label, meta, created_by, created_at) VALUES (?, 'https://example.com', ?, 'l', 'LINK', 'meilin', ?)`, id, kind, now);
    await expect(link("slack")).rejects.toThrow();
    await expect(link("figma")).resolves.toBeTruthy();

    const ev = (from: string | null, to: string) => run(env.DB,
      `INSERT INTO ticket_events (ticket_id, actor, from_status, to_status, created_at) VALUES (?, 'meilin', ?, ?, ?)`, id, from, to, now);
    await expect(ev(null, "submitted")).resolves.toBeTruthy();   // the opening row
    await expect(ev("submitted", "in_progress")).resolves.toBeTruthy();
    await expect(ev("submitted", "archived")).rejects.toThrow();
    await expect(ev("archived", "done")).rejects.toThrow();
  });

  it("ticket_assignees is keyed (ticket_id, login) — the same assignee cannot land twice", async () => {
    const id = await insertTicket();
    await run(env.DB, `INSERT INTO ticket_assignees (ticket_id, login) VALUES (?, 'AndresL230')`, id);
    await expect(run(env.DB, `INSERT INTO ticket_assignees (ticket_id, login) VALUES (?, 'AndresL230')`, id)).rejects.toThrow();
    // INSERT OR IGNORE is what makes the Phase 2 toggle idempotent.
    await run(env.DB, `INSERT OR IGNORE INTO ticket_assignees (ticket_id, login) VALUES (?, 'AndresL230')`, id);
    expect(await count(`SELECT COUNT(*) AS n FROM ticket_assignees WHERE ticket_id = ?`, id)).toBe(1);
  });

  it("declares hard FKs for requester and parent_id, and keeps sprint_id a soft reference", async () => {
    const fks = await all<{ table: string; from: string; to: string }>(env.DB, `PRAGMA foreign_key_list(tickets)`);
    const pairs = fks.map((f) => `${f.from}→${f.table}.${f.to}`).sort();
    // sprint_id is deliberately NOT in this list: `sprints` arrives in 0025, and
    // SQLite resolves a table's FKs when it PREPARES a statement against it, so a
    // real `REFERENCES sprints(id)` here makes every `DELETE FROM tickets` throw
    // `no such table: main.sprints` until 0025 has run. See 0024_tickets.sql.
    expect(pairs).toEqual(["parent_id→tickets.id", "requester→persons.handle"]);
    // …and the column itself is still there, nullable (NULL = backlog).
    await seedPerson("meilin");
    const now = nowIso();
    await run(env.DB, `INSERT INTO tickets (title, requester, sprint_id, created_at, updated_at) VALUES ('In a sprint', 'meilin', 41, ?, ?)`, now, now);
    expect(await count(`SELECT COUNT(*) AS n FROM tickets WHERE sprint_id = 41`)).toBe(1);

    for (const t of ["ticket_assignees", "ticket_links", "ticket_comments", "ticket_events"]) {
      const child = await all<{ table: string; from: string }>(env.DB, `PRAGMA foreign_key_list(${t})`);
      expect(child.map((f) => `${f.from}→${f.table}`)).toEqual(["ticket_id→tickets"]);
    }
  });

  it("stores a one-level parent/child pair (depth is a route rule, not a schema rule)", async () => {
    const parent = await insertTicket({ title: "Onboarding kit" });
    const child = await insertTicket({ title: "Order the laptop", parent_id: parent });
    expect(await count(`SELECT COUNT(*) AS n FROM tickets WHERE parent_id = ?`, parent)).toBe(1);
    const row = await all<{ parent_id: number }>(env.DB, `SELECT parent_id FROM tickets WHERE id = ?`, child);
    expect(row[0].parent_id).toBe(parent);
  });
});

describe("0024_tickets — tickets_fts index and triggers", () => {
  it("starts empty every test (the beforeEach truncation left no leak)", async () => {
    expect(await ftsCount()).toBe(0);
  });

  it("AFTER INSERT mirrors the ticket into tickets_fts", async () => {
    const id = await insertTicket({ title: "Zebraword projector", body: "quokkaterm in the body" });
    expect(await ftsCount()).toBe(1);
    expect((await ftsMatch("zebraword")).map((r) => r.ticket_id)).toEqual([String(id)]);
    expect((await ftsMatch("quokkaterm")).map((r) => r.ticket_id)).toEqual([String(id)]);
  });

  it("AFTER UPDATE OF title re-indexes: the old term stops matching, the new one starts", async () => {
    const id = await insertTicket({ title: "Zebraword projector", body: "b" });
    await run(env.DB, `UPDATE tickets SET title = 'Narwhalword projector' WHERE id = ?`, id);
    expect(await ftsCount()).toBe(1);                       // re-indexed, not duplicated
    expect(await ftsMatch("zebraword")).toEqual([]);
    expect((await ftsMatch("narwhalword")).map((r) => r.ticket_id)).toEqual([String(id)]);
  });

  it("AFTER UPDATE OF body re-indexes too; a status flip does not duplicate the row", async () => {
    const id = await insertTicket({ title: "t", body: "quokkaterm" });
    await run(env.DB, `UPDATE tickets SET body = 'ocelotterm' WHERE id = ?`, id);
    expect(await ftsMatch("quokkaterm")).toEqual([]);
    expect((await ftsMatch("ocelotterm")).map((r) => r.ticket_id)).toEqual([String(id)]);

    await run(env.DB, `UPDATE tickets SET status = 'in_progress' WHERE id = ?`, id);
    expect(await ftsCount()).toBe(1);
    expect((await ftsMatch("ocelotterm")).map((r) => r.ticket_id)).toEqual([String(id)]);
  });

  it("AFTER DELETE removes the row from tickets_fts", async () => {
    const id = await insertTicket({ title: "Zebraword projector" });
    expect(await ftsCount()).toBe(1);
    await run(env.DB, `DELETE FROM tickets WHERE id = ?`, id);
    expect(await ftsCount()).toBe(0);
    expect(await ftsMatch("zebraword")).toEqual([]);
  });

  it("the harness truncation statement cascades into tickets_fts (no leaked rows)", async () => {
    const id = await insertTicket({ title: "Zebraword projector", body: "b" });
    await run(env.DB, `INSERT INTO ticket_assignees (ticket_id, login) VALUES (?, 'AndresL230')`, id);
    await run(env.DB, `INSERT INTO ticket_links (ticket_id, url, kind, label, meta, created_by, created_at) VALUES (?, 'https://example.com', 'plain', 'example.com', 'LINK', 'meilin', ?)`, id, nowIso());
    await run(env.DB, `INSERT INTO ticket_comments (ticket_id, author, body, created_at) VALUES (?, 'meilin', 'c', ?)`, id, nowIso());
    await run(env.DB, `INSERT INTO ticket_events (ticket_id, actor, from_status, to_status, created_at) VALUES (?, 'meilin', NULL, 'submitted', ?)`, id, nowIso());
    expect(await ftsCount()).toBe(1);

    // Run the EXACT statement test/apply-migrations.ts runs beforeEach.
    await env.DB.exec(HARNESS_TRUNCATION);

    expect(await ftsCount()).toBe(0);
    for (const t of ["tickets", "ticket_assignees", "ticket_links", "ticket_comments", "ticket_events"]) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${t}`), `${t} was not truncated`).toBe(0);
    }
    const fkViolations = await all(env.DB, `PRAGMA foreign_key_check`);
    expect(fkViolations).toEqual([]);
  });
});
