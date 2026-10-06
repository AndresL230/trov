import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { first } from "./helpers/db";
import { create_sprint } from "../src/tools/sprints";
import { create_ticket } from "../src/tools/tickets";
import { TicketCreate } from "@shared/tickets";
import { SprintCreate, type SprintDetail, type SprintView } from "@shared/sprints";
import type { SprintRow } from "@shared/rows";
import { seedPerson } from "./helpers/persons";
import { bearerCtx, systemCtx } from "./helpers/tenant";

// The FIVE sprint write tools, driven through the REAL registered closures.
// They are open to EVERY principal, matching the web (every sprint route sits
// under sessionGate with no adminGate). Only update_plan stays admin-only.
// Only "admin-user" is bound as an org admin (see withClient).

const ADMIN = "admin-user";
const SPRINT_WRITE_TOOLS = [
  "create_sprint", "set_sprint_active", "complete_sprint", "add_sprint_resource", "delete_sprint",
] as const;

async function withClient<T>(handle: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx(handle, handle === "admin-user" ? "admin" : undefined));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function callTool(handle: string, name: string, args: Record<string, unknown> = {}) {
  return withClient(handle, async (client) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { text: res.content[0].text, isError: res.isError };
  });
}

function ok<T>(r: { text: string; isError?: boolean }): T {
  expect(r.isError, r.text).toBeFalsy();
  return JSON.parse(r.text) as T;
}
function failed(r: { text: string; isError?: boolean }) {
  expect(r.isError, `expected a refusal, got: ${r.text}`).toBe(true);
  return JSON.parse(r.text) as { error: string; code?: string };
}

const seedSprint = (label: string, due = "2026-09-01") =>
  create_sprint(systemCtx(), SprintCreate.parse({ label, due }), ADMIN);

describe("the sprint write surface is open to every member", () => {
  it("registers all five for an admin", async () => {
    await seedPerson(ADMIN);
    const names = await withClient(ADMIN, async (c) => (await c.listTools()).tools.map((t) => t.name));
    for (const t of SPRINT_WRITE_TOOLS) expect(names).toContain(t);
  });

  it("registers all five for a non-admin too — but not update_plan", async () => {
    await seedPerson("andres");
    const names = await withClient("andres", async (c) => (await c.listTools()).tools.map((t) => t.name));
    for (const t of SPRINT_WRITE_TOOLS) expect(names).toContain(t);
    expect(names).not.toContain("update_plan");
  });

  it("a non-admin can create and complete a sprint", async () => {
    await seedPerson("beatrix");
    const sp = ok<SprintView>(await callTool("beatrix", "create_sprint", { label: "Member-made" }));
    const done = ok<SprintView>(await callTool("beatrix", "complete_sprint", { id: sp.id }));
    expect(done.status).toBe("done");
  });
});

describe("create_sprint", () => {
  it("lands inactive and unscheduled when no due date is given", async () => {
    await seedPerson(ADMIN);
    const sp = ok<SprintView>(await callTool(ADMIN, "create_sprint", { label: "Q4 notifications" }));
    expect(sp.label).toBe("Q4 notifications");
    expect(sp.status).toBe("upcoming");
    expect(sp.active).toBe(false);
    expect(sp.phase).toBe("Unscheduled");
    // target_date is NOT NULL, so '' is stored and the DTO surfaces it as null.
    expect(sp.due).toBeNull();
  });

  it("speaks the DTO vocabulary, and the columns follow", async () => {
    await seedPerson(ADMIN);
    const sp = ok<SprintView>(await callTool(ADMIN, "create_sprint", {
      label: "Search polish", due: "2026-11-01", summary: "bm25 tuning", urgency: "high", lead: ADMIN, domain: "search",
    }));
    expect(sp.due).toBe("2026-11-01");
    expect(sp.urgency).toBe("high");
    expect(sp.domain).toBe("search");
    // row.title ↔ view.label, row.target_date ↔ view.due — the seam holds.
    const row = await first<SprintRow>(env.DB, `SELECT * FROM sprints WHERE id = ?`, sp.id);
    expect(row!.title).toBe("Search polish");
    expect(row!.target_date).toBe("2026-11-01");
  });
});

describe("set_sprint_active", () => {
  it("maps true → in_progress and false → upcoming", async () => {
    await seedPerson(ADMIN);
    const seeded = await seedSprint("Queue cleanup");
    const on = ok<SprintView>(await callTool(ADMIN, "set_sprint_active", { id: seeded.id, active: true }));
    expect(on.status).toBe("in_progress");
    expect(on.active).toBe(true);
    const off = ok<SprintView>(await callTool(ADMIN, "set_sprint_active", { id: seeded.id, active: false }));
    expect(off.status).toBe("upcoming");
    expect(off.active).toBe(false);
  });

  it("clearing active on a DONE sprint is a no-op; setting it re-opens", async () => {
    await seedPerson(ADMIN);
    const seeded = await seedSprint("Finished work");
    ok(await callTool(ADMIN, "complete_sprint", { id: seeded.id }));

    // false must never un-finish a sprint.
    const noop = ok<SprintView>(await callTool(ADMIN, "set_sprint_active", { id: seeded.id, active: false }));
    expect(noop.status).toBe("done");
    // true re-opens one that turned out not to be finished.
    const reopened = ok<SprintView>(await callTool(ADMIN, "set_sprint_active", { id: seeded.id, active: true }));
    expect(reopened.status).toBe("in_progress");
  });
});

describe("complete_sprint", () => {
  it("flips a live sprint to done", async () => {
    await seedPerson(ADMIN);
    const seeded = await seedSprint("Shipped");
    const done = ok<SprintRow>(await callTool(ADMIN, "complete_sprint", { id: seeded.id }));
    expect(done.status).toBe("done");
    expect((await first<SprintRow>(env.DB, `SELECT * FROM sprints WHERE id = ?`, seeded.id))!.status).toBe("done");
  });

  it("two concurrent completions: exactly one wins, the other conflicts", async () => {
    await seedPerson(ADMIN);
    const seeded = await seedSprint("Contested");

    // The guard is in the UPDATE's WHERE, not a prior read, so the loser cannot
    // slip through the window between a status check and the write. Without that,
    // both callers report success for the one sprint.
    const [a, b] = await Promise.all([
      callTool(ADMIN, "complete_sprint", { id: seeded.id }),
      callTool(ADMIN, "complete_sprint", { id: seeded.id }),
    ]);
    const outcomes = [a, b].map((r) => (r.isError ? "conflict" : "ok"));
    expect(outcomes.sort()).toEqual(["conflict", "ok"]);

    const loser = [a, b].find((r) => r.isError)!;
    expect(failed(loser).code).toBe("conflict");
    // …and the sprint is done exactly once, whichever call won.
    expect((await first<SprintRow>(env.DB, `SELECT * FROM sprints WHERE id = ?`, seeded.id))!.status).toBe("done");
  });

  it("answers in the DTO vocabulary, like its three neighbours", async () => {
    // The seam (shared/sprints.ts): the DB keeps its column names, every DTO
    // speaks the product's words. An agent is told to read the new state back
    // off the write response, so a writer that answers with a raw row hands it
    // `label: undefined` and no `active` at all — and this is the one tool of
    // the four that used to. Asserted against a sibling so the two cannot drift.
    await seedPerson(ADMIN);
    const seeded = await seedSprint("Speaks the DTO");
    const done = ok<SprintView>(await callTool(ADMIN, "complete_sprint", { id: seeded.id }));

    expect(done.label).toBe("Speaks the DTO");
    expect(done.due).toBe("2026-09-01");
    expect(done.status).toBe("done");
    expect(done.active).toBe(false);
    expect(done).not.toHaveProperty("title");
    expect(done).not.toHaveProperty("target_date");

    const reopened = ok<SprintView>(await callTool(ADMIN, "set_sprint_active", { id: seeded.id, active: true }));
    expect(Object.keys(done).sort()).toEqual(Object.keys(reopened).sort());
  });

  it("refuses an unknown sprint and a second completion, with TYPED codes", async () => {
    await seedPerson(ADMIN);
    // The two refusals are different answers for an agent — retry with a real id,
    // versus nothing left to do — so they must not both arrive as a bare message.
    const unknown = failed(await callTool(ADMIN, "complete_sprint", { id: 4242 }));
    expect(unknown.error).toMatch(/no such sprint/i);
    expect(unknown.code).toBe("not_found");

    const seeded = await seedSprint("Once");
    ok(await callTool(ADMIN, "complete_sprint", { id: seeded.id }));
    const again = failed(await callTool(ADMIN, "complete_sprint", { id: seeded.id }));
    expect(again.error).toMatch(/already done/i);
    expect(again.code).toBe("conflict");
  });
});

describe("add_sprint_resource", () => {
  it("parses through the SHARED link parser and is idempotent on url", async () => {
    await seedPerson(ADMIN);
    const seeded = await seedSprint("With resources");
    const one = ok<SprintDetail>(await callTool(ADMIN, "add_sprint_resource", { id: seeded.id, raw: "#214" }));
    expect(one.resources.map((r) => r.url)).toContain("https://github.com/SaplingLearn/sapling/issues/214");
    expect(one.resources.find((r) => r.url.endsWith("/214"))!.label).toBe("sapling #214");

    const twice = ok<SprintDetail>(await callTool(ADMIN, "add_sprint_resource", { id: seeded.id, raw: "214" }));
    expect(twice.resources.filter((r) => r.url.endsWith("/214"))).toHaveLength(1);
  });

  it("refuses an unusable link and an unknown sprint", async () => {
    await seedPerson(ADMIN);
    const seeded = await seedSprint("Strict");
    expect(failed(await callTool(ADMIN, "add_sprint_resource", { id: seeded.id, raw: "javascript:alert(1)" })).code).toBe("bad_request");
    expect(failed(await callTool(ADMIN, "add_sprint_resource", { id: 4242, raw: "#1" })).code).toBe("not_found");
  });
});

describe("delete_sprint", () => {
  it("hard-deletes the sprint, its resources and progress cache; its tickets move to the backlog", async () => {
    await seedPerson("andres");
    const seeded = await seedSprint("Doomed");
    ok(await callTool("andres", "add_sprint_resource", { id: seeded.id, raw: "#214" }));
    await env.DB.prepare(`INSERT INTO sprint_progress (sprint_id, closed, total, source, computed_at) VALUES (?, 1, 2, 'event', '2026-09-01T00:00:00.000Z')`).bind(seeded.id).run();
    const t1 = await create_ticket(systemCtx(), TicketCreate.parse({ title: "one", sprint_id: seeded.id }), "andres");
    const t2 = await create_ticket(systemCtx(), TicketCreate.parse({ title: "two", sprint_id: seeded.id }), "andres");

    const res = ok<{ id: number; label: string; moved: number }>(await callTool("andres", "delete_sprint", { id: seeded.id }));
    expect(res).toEqual({ id: seeded.id, label: "Doomed", moved: 2 });

    expect(await first(env.DB, `SELECT id FROM sprints WHERE id = ?`, seeded.id)).toBeNull();
    expect(await first(env.DB, `SELECT id FROM sprint_resources WHERE sprint_id = ?`, seeded.id)).toBeNull();
    expect(await first(env.DB, `SELECT sprint_id FROM sprint_progress WHERE sprint_id = ?`, seeded.id)).toBeNull();
    expect(await first(env.DB, `SELECT ref FROM roadmap_fts WHERE ref = ?`, `sprint:${seeded.id}`)).toBeNull();
    for (const id of [t1, t2]) {
      const row = await first<{ sprint_id: number | null }>(env.DB, `SELECT sprint_id FROM tickets WHERE id = ?`, id);
      expect(row).not.toBeNull();
      expect(row!.sprint_id).toBeNull();
    }
  });

  it("leaves every other sprint and its tickets alone", async () => {
    await seedPerson("andres");
    const doomed = await seedSprint("Doomed");
    const kept = await seedSprint("Kept");
    const t = await create_ticket(systemCtx(), TicketCreate.parse({ title: "stays", sprint_id: kept.id }), "andres");
    ok(await callTool("andres", "delete_sprint", { id: doomed.id }));
    expect(await first(env.DB, `SELECT id FROM sprints WHERE id = ?`, kept.id)).not.toBeNull();
    const row = await first<{ sprint_id: number | null }>(env.DB, `SELECT sprint_id FROM tickets WHERE id = ?`, t);
    expect(row!.sprint_id).toBe(kept.id);
  });

  it("refuses an unknown sprint as not_found", async () => {
    await seedPerson("andres");
    expect(failed(await callTool("andres", "delete_sprint", { id: 4242 })).code).toBe("not_found");
  });
});
