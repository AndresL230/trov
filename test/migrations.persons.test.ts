/**
 * 0023_persons: replay the migration against a pre-0023 shape and assert the
 * backfill. The harness applied every migration at startup, so this test
 * rebuilds the OLD tables (users, people, sessions, mcp_tokens, bodies), drops
 * the NEW ones, seeds old-shape rows, then re-runs 0023's statements.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "./helpers/db";
import type { PersonRow, IdentityRow, IdentityTaskRow } from "@shared/rows";

const OLD_SHAPE = `
DELETE FROM memberships; DELETE FROM org_login_map; DELETE FROM platform_admins;
DROP TABLE IF EXISTS identities; DROP TABLE IF EXISTS invites; DROP TABLE IF EXISTS persons;
DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS mcp_tokens; DROP TABLE IF EXISTS notification_outbox_bodies;
CREATE TABLE users (github_login TEXT PRIMARY KEY, name TEXT, created_at TEXT NOT NULL, avatar_url TEXT, email TEXT, email_unsubscribed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE people (login TEXT PRIMARY KEY, person TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(github_login), created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE mcp_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL REFERENCES users(github_login), token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE notification_outbox_bodies (idempotency_key TEXT PRIMARY KEY REFERENCES notification_outbox(idempotency_key), to_address TEXT NOT NULL, subject TEXT NOT NULL, html TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
INSERT INTO users (github_login, name, created_at, avatar_url, email, email_unsubscribed) VALUES
  ('AndresL230', 'Andres', '2026-01-01T00:00:00Z', 'https://a/andres.png', 'andres@example.com', 0),
  ('Jose-Gael-Cruz-Lopez', 'Jose', '2026-01-02T00:00:00Z', NULL, NULL, 1);
INSERT INTO people (login, person) VALUES
  ('AndresL230', 'Andres'),
  ('andres-alt', 'Andres'),
  ('jose-bot-acct', 'Jose-Gael-Cruz-Lopez'),
  ('lpcooper-arch', 'Luke');
INSERT INTO sessions (id, user, created_at, expires_at) VALUES ('s1', 'AndresL230', '2026-01-03T00:00:00Z', '2099-01-01T00:00:00Z');
INSERT INTO mcp_tokens (user, token_hash, created_at) VALUES ('AndresL230', 'hash1', '2026-01-03T00:00:00Z');
`;

async function replay0023(): Promise<void> {
  await env.DB.exec(OLD_SHAPE.trim().split("\n").join(" "));
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0023"));
  if (!m) throw new Error("0023 migration not found");
  for (const q of m.queries) await env.DB.prepare(q).run();
  // Re-add the columns LATER migrations put on persons (0036's profile columns and avatar_source, 0037's
  // org_limit) and on identities (0037's verified_email), so the
  // rebuilt table is the shape the harness's per-test reset (scripts/seed/reset.mjs) writes.
  for (const later of env.TEST_MIGRATIONS.filter((x) => x.name > m.name)) {
    for (const q of later.queries) if (/\bALTER TABLE (persons|identities)\b/i.test(q)) await env.DB.prepare(q).run();
  }
}

describe("0023_persons backfill", () => {
  beforeEach(replay0023);

  it("every users row becomes a person with handle = login and a github identity", async () => {
    const andres = (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'AndresL230'`))!;
    expect(andres.name).toBe("Andres");
    expect(andres.avatar_url).toBe("https://a/andres.png");
    expect(andres.email).toBe("andres@example.com");
    expect(andres.onboarded_at).toBe("2026-01-01T00:00:00Z");
    expect(["moss","fern","sky","slate","plum","rose","rust","ochre","clay","stone"]).toContain(andres.color);
    const jose = (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'Jose-Gael-Cruz-Lopez'`))!;
    expect(jose.email_unsubscribed).toBe(1);
    const gh = await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE provider = 'github' AND subject = 'AndresL230'`);
    expect(gh?.person).toBe("AndresL230");
    expect(gh?.label).toBe("AndresL230");
    expect(gh?.linked_by).toBe("migration");
  });

  it("people rows map by login first, then by display name; unmatched raise an identity task", async () => {
    const byLogin = await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'jose-bot-acct'`);
    expect(byLogin?.person).toBe("Jose-Gael-Cruz-Lopez");
    const byName = await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'andres-alt'`);
    expect(byName?.person).toBe("AndresL230");
    const task = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'lpcooper-arch'`);
    expect(task?.status).toBe("pending");
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'lpcooper-arch'`)).toBeNull();
  });

  it("sessions and mcp_tokens are repointed to persons.handle and old tables are gone", async () => {
    const s = await first<{ person: string }>(env.DB, `SELECT person FROM sessions WHERE id = 's1'`);
    expect(s?.person).toBe("AndresL230");
    const t = await first<{ person: string }>(env.DB, `SELECT person FROM mcp_tokens WHERE token_hash = 'hash1'`);
    expect(t?.person).toBe("AndresL230");
    const tables = (await all<{ name: string }>(env.DB, `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users','people')`)).map((r) => r.name);
    expect(tables).toEqual([]);
  });

  it("the bodies table no longer references the outbox, and the color CHECK holds", async () => {
    const fks = await all(env.DB, `SELECT * FROM pragma_foreign_key_list('notification_outbox_bodies')`);
    expect(fks).toHaveLength(0);
    await expect(env.DB.prepare(`INSERT INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('x', 'X', 'neon', 't', 't')`).run()).rejects.toThrow();
  });
});
