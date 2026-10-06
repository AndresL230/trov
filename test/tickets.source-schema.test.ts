import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run, nowIso } from "./helpers/db";
import { HANDLE_COLUMNS } from "../src/auth/persons";

// Schema proof for migration 0032_ticket_source.sql: the four source columns on
// `tickets`, the partial UNIQUE index on source_ref, `ticket_links.locked`, and the
// `github-webhook` person the mirror files as when an author maps to no one.

async function insertTicket(f: { source?: string; source_ref?: string | null } = {}): Promise<number> {
  const now = nowIso();
  const cols = ["title", "requester", "created_at", "updated_at"];
  const vals: unknown[] = ["T", "meilin", now, now];
  if (f.source !== undefined) { cols.push("source"); vals.push(f.source); }
  if (f.source_ref !== undefined) { cols.push("source_ref"); vals.push(f.source_ref); }
  const res = await run(env.DB, `INSERT INTO tickets (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...vals);
  return res.meta.last_row_id as number;
}

describe("0032_ticket_source", () => {
  it("defaults a ticket to source 'canopy' with null source fields", async () => {
    const id = await insertTicket();
    const row = await first<Record<string, unknown>>(env.DB,
      `SELECT source, source_ref, source_author, source_updated_at FROM tickets WHERE id = ?`, id);
    expect(row).toEqual({ source: "canopy", source_ref: null, source_author: null, source_updated_at: null });
  });

  it("CHECK rejects a source outside trov/github", async () => {
    await expect(insertTicket({ source: "jira" })).rejects.toThrow();
    await expect(insertTicket({ source: "github", source_ref: "o/r#1" })).resolves.toBeTypeOf("number");
  });

  it("source_ref is UNIQUE when set, and any number of NULLs coexist", async () => {
    await insertTicket({ source: "github", source_ref: "o/r#7" });
    await expect(insertTicket({ source: "github", source_ref: "o/r#7" })).rejects.toThrow(/UNIQUE/);
    await insertTicket();
    await insertTicket();
    const n = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM tickets WHERE source_ref IS NULL`);
    expect(n?.n).toBe(2);
  });

  it("ticket_links.locked defaults to 0", async () => {
    const id = await insertTicket();
    await run(env.DB,
      `INSERT INTO ticket_links (ticket_id, url, kind, label, meta, created_by, created_at) VALUES (?, 'https://x.test', 'plain', 'x', 'LINK', 'meilin', ?)`,
      id, nowIso());
    const row = await first<{ locked: number }>(env.DB, `SELECT locked FROM ticket_links WHERE ticket_id = ?`, id);
    expect(row?.locked).toBe(0);
  });

  it("the github-webhook person exists after the harness reset, so it can be a requester", async () => {
    const p = await first<{ handle: string; color: string }>(env.DB, `SELECT handle, color FROM persons WHERE handle = 'github-webhook'`);
    expect(p).toEqual({ handle: "github-webhook", color: "stone" });
    const now = nowIso();
    await expect(run(env.DB,
      `INSERT INTO tickets (title, requester, created_at, updated_at) VALUES ('from gh', 'github-webhook', ?, ?)`, now, now)).resolves.toBeTruthy();
  });

  it("source_author is NOT a handle column — a rename never rewrites it", () => {
    expect(HANDLE_COLUMNS.some(([t, c]) => t === "tickets" && c === "source_author")).toBe(false);
  });

  it("the partial index exists on source_ref", async () => {
    const idx = await all<{ name: string }>(env.DB, `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tickets_source_ref'`);
    expect(idx).toHaveLength(1);
  });
});
