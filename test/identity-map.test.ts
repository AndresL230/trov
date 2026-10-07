import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { platformCtx, systemCtx } from "./helpers/tenant";
import { all, first } from "./helpers/db";
import { ingestEvent } from "../src/consumer";
import { map_identity } from "../src/tools/writes";
import { seedPerson } from "./helpers/persons";
import type { IdentityTaskRow, IdentityRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

const ev = (over: Partial<CapturedEvent> = {}): CapturedEvent => ({
  semantic_key: "gh:pr:7:merged", event_type: "pr_merged", ref_number: 7, subject_login: "mystery-dev",
  raw: JSON.stringify({ pr: { number: 7, title: "t", body: "b" } }), provenance: "webhook", occurred_at: "2026-07-01T10:00:00Z", ...over,
});

// Phase 4 (§5.3, C-1): the map writes the ORG's attribution (`org_login_map`), never the global `identities`.
describe("map_identity — the org attribution map's human write path", () => {
  it("links the login to an existing person and soft-resolves the task", async () => {
    await seedPerson("casey");
    await ingestEvent(systemCtx(), platformCtx(), ev(), "github-webhook");
    const res = await map_identity(systemCtx(), platformCtx(), "mystery-dev", "casey", "andres");
    expect(res).toEqual({ login: "mystery-dev", person: "casey", status: "resolved" });
    const id = await first<{ person: string; mapped_by: string; org_id: string }>(env.DB, `SELECT * FROM org_login_map WHERE github_login = 'mystery-dev'`);
    expect(id?.person).toBe("casey");
    expect(id?.mapped_by).toBe("andres");
    expect(id?.org_id).toBe("org_saplinglearn");
    expect(await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE provider = 'github' AND subject = 'mystery-dev'`)).toBeNull();
    const task = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`);
    expect(task?.status).toBe("resolved");
    expect(task?.resolved_by).toBe("andres");
  });
  it("double-map is idempotent-safe: the first mapping stands", async () => {
    await seedPerson("casey"); await seedPerson("other");
    await ingestEvent(systemCtx(), platformCtx(), ev(), "github-webhook");
    await map_identity(systemCtx(), platformCtx(), "mystery-dev", "casey", "andres");
    const second = await map_identity(systemCtx(), platformCtx(), "mystery-dev", "other", "jose");
    expect(second).toEqual({ login: "mystery-dev", person: "casey", status: "resolved" });
    expect(await all(env.DB, `SELECT person FROM org_login_map WHERE github_login = 'mystery-dev'`)).toEqual([{ person: "casey" }]);
  });
  it("throws on a login with no identity task, and on an unknown person", async () => {
    await expect(map_identity(systemCtx(), platformCtx(), "nobody-here", "casey", "andres")).rejects.toThrow("no such identity task: nobody-here");
    await ingestEvent(systemCtx(), platformCtx(), ev(), "github-webhook");
    await expect(map_identity(systemCtx(), platformCtx(), "mystery-dev", "ghost", "andres")).rejects.toThrow("no such person: ghost");
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'mystery-dev'`)).toBeNull();
  });
  it("a login already linked never raises a task", async () => {
    await ingestEvent(systemCtx(), platformCtx(), ev({ subject_login: "AndresL230", semantic_key: "gh:pr:8:merged", ref_number: 8 }), "github-webhook");
    expect(await first(env.DB, `SELECT 1 AS x FROM identity_tasks WHERE login = 'AndresL230'`)).toBeNull();
  });
  it("a login already linked (stale/unresolved task pointing at an existing identity) rejects cleanly, no second row", async () => {
    await seedPerson("casey", { github: false });
    await env.DB.prepare(
      `INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('github', 'mystery-dev', 'mystery-dev', 'casey', '2026-01-01T00:00:00Z', 'seed')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO identity_tasks (login, first_seen, status) VALUES ('mystery-dev', '2026-01-01T00:00:00Z', 'pending')`
    ).run();
    await seedPerson("other");
    await expect(map_identity(systemCtx(), platformCtx(), "mystery-dev", "other", "andres")).rejects.toThrow("login already linked to casey");
    expect((await all(env.DB, `SELECT * FROM identities WHERE subject = 'mystery-dev'`)).length).toBe(1);
  });
});
