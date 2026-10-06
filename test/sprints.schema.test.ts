/**
 * 0025_sprints.sql — the schema half of phase 1b.
 *
 * The `sprints` table IS the pre-0025 table, renamed in place — same rows, same
 * ids. These tests drive the REAL migrated schema (the harness applies every
 * migration in migrations/), so they prove the rename semantics this build leans
 * on rather than restating them:
 *  • a legacy-shaped row (title / target_date / status) reads back through
 *    get_plan as a sprint, with `active` derived from status;
 *  • the progress cache followed the table (name, key column, and the FK that
 *    SQLite rewrote for us);
 *  • roadmap_fts is re-keyed to 'sprint:<id>' with live triggers;
 *  • the proposal queue is gone from the database, not merely from the code;
 *  • sprint_resources exists with its CHECKed kind vocabulary.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run, nowIso } from "../src/db";
import type { SprintRow } from "@shared/rows";
import { sprintActive, toSprintView } from "@shared/sprints";
import { get_plan } from "../src/tools/plan";
import { upsertProgress, getProgress } from "../src/tools/progress";
import { app } from "../src/routes";
import { cookieFor } from "./helpers/persons";

import { systemCtx } from "./helpers/tenant";
/** A row inserted with EXACTLY the pre-0025 column set — what every migrated row looks like. */
async function seedLegacyRow(title: string, status: string, targetDate = "2026-08-01"): Promise<number> {
  const now = nowIso();
  const res = await run(
    env.DB,
    `INSERT INTO sprints (title, description, target_date, status, github_ref, created_at, created_by, updated_at, phase)
     VALUES (?, 'legacy description', ?, ?, NULL, ?, 'admin', NULL, 'Now')`,
    title,
    targetDate,
    status,
    now
  );
  return res.meta.last_row_id as number;
}

describe("0025: the table was RENAMED in place, never re-created", () => {
  it("a legacy-shaped row reads back as a sprint, with active derived from status", async () => {
    const runningId = await seedLegacyRow("Running", "in_progress", "2026-08-01");
    const laterId = await seedLegacyRow("Later", "upcoming", "2026-08-02");
    const doneId = await seedLegacyRow("Shipped", "done", "2026-08-03");

    const view = await get_plan(systemCtx());
    const byId = new Map(view.sprints.map((s) => [s.id, s]));

    expect(byId.get(runningId)).toMatchObject({ label: "Running", due: "2026-08-01", active: true, status: "in_progress" });
    expect(byId.get(laterId)!.active).toBe(false);
    expect(byId.get(doneId)!.active).toBe(false);

    // The legacy row's own columns survived the rename untouched.
    expect(byId.get(runningId)!.description).toBe("legacy description");
    expect(byId.get(runningId)!.phase).toBe("Now");
    // …and the 0025 additions defaulted the way the migration says.
    const row = await first<SprintRow>(env.DB, `SELECT * FROM sprints WHERE id = ?`, runningId);
    expect(row!.urgency).toBe("normal");   // NOT NULL DEFAULT 'normal'
    expect(row!.dates).toBeNull();
    expect(row!.summary).toBeNull();
    expect(row!.lead).toBeNull();
    expect(row!.domain).toBeNull();
  });

  it("the 0025 columns exist with their CHECK vocabularies enforced", async () => {
    const id = await seedLegacyRow("Vocab", "upcoming");
    await run(env.DB, `UPDATE sprints SET urgency = 'high', domain = 'tickets', dates = 'Sep 1 – Sep 14', summary = 's', lead = 'AndresL230' WHERE id = ?`, id);
    const row = await first<SprintRow>(env.DB, `SELECT * FROM sprints WHERE id = ?`, id);
    expect(row).toMatchObject({ urgency: "high", domain: "tickets", dates: "Sep 1 – Sep 14", summary: "s", lead: "AndresL230" });

    await expect(run(env.DB, `UPDATE sprints SET urgency = 'critical' WHERE id = ?`, id)).rejects.toThrow();
    await expect(run(env.DB, `UPDATE sprints SET domain = 'marketing' WHERE id = ?`, id)).rejects.toThrow();
    await expect(run(env.DB, `UPDATE sprints SET urgency = NULL WHERE id = ?`, id)).rejects.toThrow();
  });

  it("idx_sprints_target_date is the renamed index (the old name is gone)", async () => {
    const names = (await all<{ name: string }>(env.DB, `SELECT name FROM sqlite_master WHERE type = 'index'`)).map((r) => r.name);
    expect(names).toContain("idx_sprints_target_date");
    // RETIRED NAME, asserted absent — the literal is the point of the assertion.
    expect(names).not.toContain("idx_milestones_target_date");
  });

  it("sprintActive / toSprintView agree with the DB round-trip", async () => {
    const id = await seedLegacyRow("Round trip", "in_progress");
    const row = await first<SprintRow>(env.DB, `SELECT * FROM sprints WHERE id = ?`, id);
    expect(sprintActive(row!)).toBe(true);
    const view = toSprintView(row!, { closed: 1, total: 4 }, ["AndresL230"]);
    expect(view).toMatchObject({ label: "Round trip", due: "2026-08-01", active: true, members: ["AndresL230"] });
    expect(view.progress).toEqual({ closed: 1, total: 4, pct: 25 });
  });
});

describe("0025: the progress cache followed the table", () => {
  it("sprint_progress is keyed by sprint_id and its FK targets sprints", async () => {
    const fks = await all<{ table: string; from: string; to: string }>(env.DB, `PRAGMA foreign_key_list(sprint_progress)`);
    expect(fks.map((f) => `${f.from}→${f.table}.${f.to}`)).toEqual(["sprint_id→sprints.id"]);
  });

  it("the cache round-trips through upsertProgress/getProgress on the renamed table", async () => {
    const id = await seedLegacyRow("Cached", "in_progress");
    await upsertProgress(systemCtx(), id, 2, 5, "event");
    expect((await getProgress(systemCtx())).get(id)).toMatchObject({ sprint_id: id, closed: 2, total: 5, source: "event" });

    // Absolute overwrite — the last write wins, no row duplication.
    await upsertProgress(systemCtx(), id, 4, 5, "recompute");
    const rows = await all(env.DB, `SELECT * FROM sprint_progress WHERE sprint_id = ?`, id);
    expect(rows).toHaveLength(1);
    // The cache surfaces as `issues` on the read DTO; `progress` is the sprint's
    // tickets, and this legacy row has none.
    const view = await get_plan(systemCtx()).then((v) => v.sprints.find((s) => s.id === id)!);
    expect(view.issues).toEqual({ closed: 4, total: 5 });
    expect(view.progress).toEqual({ closed: 0, total: 0, pct: 0 });
  });

  it("a cache row cannot point at a sprint that does not exist (the FK bites)", async () => {
    await expect(upsertProgress(systemCtx(), 999999, 1, 1, "event")).rejects.toThrow();
  });
});

describe("0025: roadmap_fts is re-keyed to sprint:<id>", () => {
  it("inserting a sprint writes a 'sprint:' ref and never the retired one", async () => {
    const id = await seedLegacyRow("Quokka Sprint", "upcoming");
    const refs = (await all<{ ref: string }>(env.DB, `SELECT ref FROM roadmap_fts`)).map((r) => r.ref);
    expect(refs).toContain(`sprint:${id}`);
    // RETIRED NAME, asserted absent — the literal is the point of the assertion.
    expect(refs.some((r) => r.startsWith("milestone:"))).toBe(false);
  });

  it("the AFTER UPDATE trigger re-indexes title and summary; AFTER DELETE removes the row", async () => {
    const id = await seedLegacyRow("Before", "upcoming");
    await run(env.DB, `UPDATE sprints SET title = 'Aardvark', summary = 'wombat summary' WHERE id = ?`, id);

    const hits = await all<{ ref: string; title: string; body: string }>(
      env.DB,
      `SELECT ref, title, body FROM roadmap_fts WHERE roadmap_fts MATCH 'aardvark OR wombat'`
    );
    expect(hits.map((h) => h.ref)).toEqual([`sprint:${id}`]);
    expect(hits[0].title).toBe("Aardvark");
    expect(hits[0].body).toContain("wombat summary");   // summary is indexed (new in 0025)

    await run(env.DB, `DELETE FROM sprints WHERE id = ?`, id);
    expect(await all(env.DB, `SELECT ref FROM roadmap_fts WHERE ref = ?`, `sprint:${id}`)).toHaveLength(0);
  });
});

describe("0025: the proposal queue is gone from the database", () => {
  it("the retired proposals table is absent from sqlite_master", async () => {
    // RETIRED NAME, asserted absent — the literal is the point of the assertion.
    const rows = await all<{ name: string }>(
      env.DB,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'milestone_proposals'`
    );
    expect(rows).toHaveLength(0);
  });

  it("its HTTP surface is gone too — the proposal + old complete routes 404", async () => {
    const cookie = await cookieFor("andres");
    // RETIRED PATHS, asserted 404 — the literals are the point of the assertion.
    const gone: [string, string][] = [
      ["GET", "/milestone-proposals"],
      ["POST", "/milestone-proposals/1/promote"],
      ["POST", "/milestone-proposals/1/reject"],
      ["POST", "/milestones/1/complete"],
    ];
    for (const [method, path] of gone) {
      const res = await app.request(path, { method, headers: { cookie } }, env);
      expect([404, 405]).toContain(res.status);
    }
  });
});

describe("0025: sprint_resources", () => {
  it("exists, references sprints, and CHECKs its kind vocabulary", async () => {
    const id = await seedLegacyRow("With resources", "in_progress");
    await run(
      env.DB,
      `INSERT INTO sprint_resources (sprint_id, url, kind, label, meta) VALUES (?, 'https://figma.com/file/x', 'figma', 'X', 'FIGMA · DESIGN')`,
      id
    );
    const rows = await all<{ sprint_id: number; kind: string; label: string }>(env.DB, `SELECT * FROM sprint_resources`);
    expect(rows).toEqual([expect.objectContaining({ sprint_id: id, kind: "figma", label: "X" })]);

    await expect(
      run(env.DB, `INSERT INTO sprint_resources (sprint_id, url, kind, label, meta) VALUES (?, 'u', 'notion', 'l', 'm')`, id)
    ).rejects.toThrow();
    await expect(
      run(env.DB, `INSERT INTO sprint_resources (sprint_id, url, kind, label, meta) VALUES (999999, 'u', 'plain', 'l', 'm')`)
    ).rejects.toThrow();
  });

  it("the harness truncation clears sprints and sprint_resources (FK-safe order)", async () => {
    const id = await seedLegacyRow("Truncated", "upcoming");
    await run(env.DB, `INSERT INTO sprint_resources (sprint_id, url, kind, label, meta) VALUES (?, 'u', 'plain', 'l', 'm')`, id);
    await upsertProgress(systemCtx(), id, 1, 1, "event");

    const { RESET_STATEMENTS } = await import("../scripts/seed/reset.mjs");
    await env.DB.exec(RESET_STATEMENTS.join("; ") + ";");

    expect(await all(env.DB, `SELECT * FROM sprints`)).toHaveLength(0);
    expect(await all(env.DB, `SELECT * FROM sprint_resources`)).toHaveLength(0);
    expect(await all(env.DB, `SELECT * FROM sprint_progress`)).toHaveLength(0);
    // The AFTER DELETE trigger cascaded the sprints DELETE into the index.
    expect(await all(env.DB, `SELECT ref FROM roadmap_fts WHERE ref LIKE 'sprint:%'`)).toHaveLength(0);
  });
});
