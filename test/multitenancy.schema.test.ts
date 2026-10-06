/**
 * Multitenancy Phase 2 — what the per-org SCHEMA guarantees on its own, before any query is ported
 * (canopy-multitenancy.md §2): two orgs may hold the same slug / key / singleton, a key is still unique
 * INSIDE an org, the search triggers never touch another org's rows (audit F-1), and display numbers are
 * per org (Q2). Rows are written directly with an explicit org_id — the seed's org_b is the neighbour.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run } from "../src/db";

const A = "org_saplinglearn";
const B = "org_b";
const T = "2026-10-06T00:00:00.000Z";

const doc = (org: string, slug: string, body: string) =>
  run(env.DB, `INSERT INTO docs (org_id, slug, section, title, body, current_version) VALUES (?, ?, 'reference', ?, ?, 1)`, org, slug, `Doc ${org}`, body);
const ftsRows = (table: string, where: string, ...p: unknown[]) => all<Record<string, unknown>>(env.DB, `SELECT * FROM ${table} WHERE ${where} ORDER BY org_id`, ...p);

describe("per-org keys", () => {
  it("the same doc slug lives in two orgs, but twice in one org is refused", async () => {
    await doc(A, "shared-slug", "alpha");
    await doc(B, "shared-slug", "beta");
    await expect(doc(B, "shared-slug", "again")).rejects.toThrow();
    expect((await all(env.DB, `SELECT org_id FROM docs WHERE slug = 'shared-slug' ORDER BY org_id`)).length).toBe(2);
  });

  it("a doc version belongs to the doc of ITS org (composite foreign key)", async () => {
    await doc(A, "only-in-a", "x");
    await expect(run(env.DB, `INSERT INTO doc_versions (org_id, slug, version, body, created_at, created_by) VALUES (?, 'only-in-a', 1, 'b', ?, 'x')`, B, T)).rejects.toThrow();
    await run(env.DB, `INSERT INTO doc_versions (org_id, slug, version, body, created_at, created_by) VALUES (?, 'only-in-a', 1, 'b', ?, 'x')`, A, T);
  });

  it("a row for an org that does not exist is refused", async () => {
    await expect(doc("org_nope", "x", "y")).rejects.toThrow();
  });

  it("replay ledger, events, repo capture, identity tasks, policy, prompts and artifacts are unique per org", async () => {
    for (const org of [A, B]) {
      await run(env.DB, `INSERT INTO processed_items (org_id, session_id, item_index, item_type, outcome, created_at) VALUES (?, 's1', 0, 'feed', 'written', ?)`, org, T);
      await run(env.DB, `INSERT INTO events (org_id, repo, semantic_key, event_type, ref_number, subject_login, raw, provenance, recorded_at, recorded_by) VALUES (?, 'o/r', 'gh:pr:1:merged', 'pr_merged', 1, 'x', '{}', 'webhook', ?, 'github-webhook')`, org, T);
      await run(env.DB, `INSERT INTO repo_metrics (org_id, metric, env, part, value, at) VALUES (?, 'coverage', '', '', 80, ?)`, org, T);
      await run(env.DB, `INSERT INTO repo_snapshots (org_id, kind, json, computed_at) VALUES (?, 'drift', '{}', ?)`, org, T);
      await run(env.DB, `INSERT INTO identity_tasks (org_id, login, first_seen) VALUES (?, 'outsider', ?)`, org, T);
      await run(env.DB, `INSERT INTO notification_policy (org_id, kind, default_cadence, enabled, updated_at, updated_by) VALUES (?, 'my_work', 'daily', 1, ?, 'x')`, org, T);
      await run(env.DB, `INSERT INTO prompts (org_id, slug, title, author, created_at, updated_at) VALUES (?, 'same-prompt', 'P', 'x', ?, ?)`, org, T, T);
      await run(env.DB, `INSERT INTO artifact_pages (org_id, slug, title, kind, area, author_id, created_at, updated_at) VALUES (?, 'same-page', 'P', 'markdown', 'ui', 'x', ?, ?)`, org, T, T);
    }
    // …and INSIDE one org each key still dedupes exactly as before.
    expect((await run(env.DB, `INSERT OR IGNORE INTO events (org_id, repo, semantic_key, event_type, ref_number, subject_login, raw, provenance, recorded_at, recorded_by) VALUES (?, 'o/r', 'gh:pr:1:merged', 'pr_merged', 1, 'x', '{}', 'webhook', ?, 'github-webhook')`, B, T)).meta.changes).toBe(0);
    expect((await run(env.DB, `INSERT OR IGNORE INTO repo_metrics (org_id, metric, env, part, value, at) VALUES (?, 'coverage', '', '', 99, ?)`, B, T)).meta.changes).toBe(0);
    await expect(run(env.DB, `INSERT INTO processed_items (org_id, session_id, item_index, item_type, outcome, created_at) VALUES (?, 's1', 0, 'feed', 'written', ?)`, A, T)).rejects.toThrow();
    await expect(run(env.DB, `INSERT INTO artifact_pages (org_id, slug, title, kind, area, author_id, created_at, updated_at) VALUES (?, 'same-page', 'P', 'markdown', 'ui', 'x', ?, ?)`, A, T, T)).rejects.toThrow();
  });

  it("a GitHub issue is mirrored once per org: source_ref is unique per org", async () => {
    for (const org of [A, B]) {
      await run(env.DB, `INSERT INTO tickets (org_id, title, requester, created_at, updated_at, source, source_ref) VALUES (?, 'm', 'github-webhook', ?, ?, 'github', 'o/r#1')`, org, T, T);
    }
    await expect(run(env.DB, `INSERT INTO tickets (org_id, title, requester, created_at, updated_at, source, source_ref) VALUES (?, 'm', 'github-webhook', ?, ?, 'github', 'o/r#1')`, B, T, T)).rejects.toThrow();
  });
});

describe("search triggers never touch another org's rows (audit F-1)", () => {
  it("docs_fts: same slug in two orgs — an update or delete in B leaves A's search row", async () => {
    await doc(A, "twin", "apple orchard");
    await doc(B, "twin", "banana grove");
    await run(env.DB, `UPDATE docs SET body = 'cherry field' WHERE org_id = ? AND slug = 'twin'`, B);
    expect(await ftsRows("docs_fts", "slug = 'twin'")).toEqual([
      expect.objectContaining({ org_id: B, body: "cherry field" }), // ORDER BY org_id: "org_b" < "org_saplinglearn"
      expect.objectContaining({ org_id: A, body: "apple orchard" }),
    ]);
    await run(env.DB, `DELETE FROM docs WHERE org_id = ? AND slug = 'twin'`, B);
    expect(await ftsRows("docs_fts", "slug = 'twin'")).toEqual([expect.objectContaining({ org_id: A, body: "apple orchard" })]);
    // and a MATCH scoped to B finds nothing of A's
    expect(await all(env.DB, `SELECT slug FROM docs_fts WHERE docs_fts MATCH 'apple' AND org_id = ?`, B)).toEqual([]);
  });

  it("roadmap_fts: each org has its own 'plan' row", async () => {
    await run(env.DB, `UPDATE plan SET narrative = 'org a now' WHERE org_id = ?`, A);
    await run(env.DB, `INSERT INTO plan (org_id, narrative, current_version) VALUES (?, '', 0)`, B);
    await run(env.DB, `UPDATE plan SET narrative = 'org b now' WHERE org_id = ?`, B);
    await run(env.DB, `UPDATE plan SET narrative = 'org b later' WHERE org_id = ?`, B);
    expect(await ftsRows("roadmap_fts", "ref = 'plan'")).toEqual([
      expect.objectContaining({ org_id: B, body: "org b later" }),
      expect.objectContaining({ org_id: A, body: "org a now" }),
    ]);
  });

  it("prompts_fts: same slug in two orgs, each indexed at its own latest version", async () => {
    for (const [org, body] of [[A, "alpha prompt"], [B, "beta prompt"]] as const) {
      await run(env.DB, `INSERT INTO prompts (org_id, slug, title, author, current_version, created_at, updated_at) VALUES (?, 'p', 'P', 'x', 1, ?, ?)`, org, T, T);
      await run(env.DB, `INSERT INTO prompt_versions (org_id, slug, version, status, author, body, created_at) VALUES (?, 'p', 1, 'published', 'x', ?, ?)`, org, body, T);
    }
    await run(env.DB, `UPDATE prompts SET deleted_at = ? WHERE org_id = ? AND slug = 'p'`, T, B); // soft delete drops B's row only
    expect(await ftsRows("prompts_fts", "slug = 'p'")).toEqual([expect.objectContaining({ org_id: A, body: "alpha prompt" })]);
  });

  it("tickets_fts and feed_fts carry the row's org", async () => {
    await run(env.DB, `INSERT INTO tickets (org_id, title, requester, created_at, updated_at) VALUES (?, 'quokka', 'meilin', ?, ?)`, B, T, T);
    await run(env.DB, `INSERT INTO feed (org_id, author, summary, created_at) VALUES (?, 'x', 'wombat', ?)`, B, T);
    expect(await all(env.DB, `SELECT org_id FROM tickets_fts WHERE tickets_fts MATCH 'quokka'`)).toEqual([{ org_id: B }]);
    expect(await all(env.DB, `SELECT org_id FROM feed_fts WHERE feed_fts MATCH 'wombat'`)).toEqual([{ org_id: B }]);
  });
});

describe("per-org display numbers (Q2)", () => {
  it("each org counts its own tickets and handoffs from 1; a deleted number is never reissued", async () => {
    const ticket = async (org: string, title: string) => {
      await run(env.DB, `INSERT INTO tickets (org_id, title, requester, created_at, updated_at) VALUES (?, ?, 'meilin', ?, ?)`, org, title, T, T);
      return (await first<{ number: number }>(env.DB, `SELECT number FROM tickets WHERE org_id = ? AND title = ?`, org, title))!.number;
    };
    expect(await ticket(B, "b1")).toBe(1);
    expect(await ticket(A, "a1")).toBe(1);
    expect(await ticket(B, "b2")).toBe(2);
    await run(env.DB, `DELETE FROM tickets WHERE org_id = ? AND title = 'b2'`, B);
    expect(await ticket(B, "b3")).toBe(3);
    await run(env.DB, `INSERT INTO handoffs (org_id, sender, recipient, body, created_at, expires_at) VALUES (?, 'x', 'anyone', 'b', ?, ?)`, B, T, T);
    expect(await first(env.DB, `SELECT number FROM handoffs WHERE org_id = ?`, B)).toEqual({ number: 1 });
  });
});

describe("the seed", () => {
  it("SaplingLearn holds the six persons (AndresL230 owner) and org_b is empty", async () => {
    const m = await all<{ user_id: string; role: string }>(env.DB, `SELECT user_id, role FROM memberships WHERE org_id = ? ORDER BY user_id`, A);
    expect(m).toHaveLength(6);
    expect(m.filter((x) => x.role === "owner").map((x) => x.user_id)).toEqual(["AndresL230"]);
    expect(await all(env.DB, `SELECT * FROM memberships WHERE org_id = ?`, B)).toEqual([]);
  });
});
