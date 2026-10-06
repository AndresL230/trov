import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { TicketCreate, type TicketDetail, type TicketListItem } from "@shared/tickets";
import { SprintCreate, type SprintDetail, type SprintView } from "@shared/sprints";
import {
  create_ticket,
  transition_ticket,
  add_ticket_link,
  add_ticket_comment,
  set_ticket_parent,
} from "../src/tools/tickets";
import { create_sprint, set_sprint_active, add_sprint_resource } from "../src/tools/sprints";
import { upsertProgress } from "../src/tools/progress";
import { seedPerson } from "./helpers/persons";

// The ticket/sprint MCP READ surface. Every test here drives the REAL registered
// closures over an in-memory transport (the same ones production builds per
// request), never the read functions directly — so a missing/renamed registration
// is a failure, not a green.
const READ_TOOLS = ["list_tickets", "get_ticket", "list_sprints", "get_sprint"] as const;

// The ticket WRITE surface, for EVERY principal — scoped at call time to the
// bearer's own lane rather than withheld from the tools/list (the scope depends on
// the ticket, which a listing cannot know). Behavior: test/mcp.tickets.writes.test.ts.
const WRITE_TOOLS = [
  "create_ticket",
  "edit_ticket",
  "transition_ticket",
  "add_ticket_comment",
  "add_ticket_link",
  "set_ticket_sprint",
  "set_ticket_parent",
  "assign_ticket",
] as const;

// The sprint writes: open to EVERY principal, like the web's sprint routes.
// Only update_plan stays admin-only. Behavior: test/mcp.sprints.writes.test.ts.
const SPRINT_WRITE_TOOLS = [
  "create_sprint", "set_sprint_active", "complete_sprint", "add_sprint_resource", "delete_sprint",
] as const;

// The web writer's own name never reaches MCP: assignment over MCP is
// `assign_ticket`, scoped by its own rule in tickets-agent.ts (issue #90), not an
// unscoped pass-through of the cookie route's `toggle_assignee`.
const BANNED_WRITE_TOOLS = ["toggle_assignee"] as const;

// ADMIN_LOGINS binds ONLY "admin-user" in vitest.config.ts, so every handle used
// below is a plain, non-admin principal.
const ISSUE_214 = "https://github.com/SaplingLearn/sapling/issues/214";
const FIGMA_URL = "https://www.figma.com/file/abc/Queue-board";

async function withClient<T>(handle: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = buildTrovMcpServer(env as unknown as Env, { handle });
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

async function callTool(
  handle: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ text: string; isError?: boolean }> {
  return withClient(handle, async (client) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { text: res.content[0].text, isError: res.isError };
  });
}

const body = <T>(r: { text: string }): T => JSON.parse(r.text) as T;

async function toolNames(handle: string): Promise<string[]> {
  return withClient(handle, async (client) => (await client.listTools()).tools.map((t) => t.name));
}

async function toolDescriptions(handle: string): Promise<Map<string, string>> {
  return withClient(handle, async (client) =>
    new Map((await client.listTools()).tools.map((t) => [t.name, t.description ?? ""]))
  );
}

interface Queue {
  sprintA: number;
  sprintB: number;
  loginBug: number;
  loginChild: number;
  csvDone: number;
  vpn: number;
  declined: number;
  question: number;
}

/**
 * A real seeded queue: two sprints, six tickets across every status/category we
 * filter on, one parent/child pair, one link that is ALSO a sprint resource
 * (the dedupe case), and a progress cache on sprint A (the GitHub half).
 */
async function seedQueue(): Promise<Queue> {
  for (const h of ["andres", "beatrix", "meilin"]) await seedPerson(h);

  const a = await create_sprint(env.DB, SprintCreate.parse({ label: "Queue cleanup", due: "2026-08-01", phase: "Now" }), "andres");
  const b = await create_sprint(env.DB, SprintCreate.parse({ label: "Search polish", due: "2026-09-01" }), "andres");
  await set_sprint_active(env.DB, a.id, true);

  const loginBug = await create_ticket(
    env.DB,
    TicketCreate.parse({ title: "Login page throws on submit", body: "500 on the POST", category: "bug", assignees: ["andres"], sprint_id: a.id }),
    "meilin"
  );
  const loginChild = await create_ticket(
    env.DB,
    TicketCreate.parse({ title: "Add a regression test", category: "other", sprint_id: a.id }),
    "meilin"
  );
  const csvDone = await create_ticket(
    env.DB,
    TicketCreate.parse({ title: "Export the roster as CSV", category: "request", assignees: ["beatrix"], sprint_id: a.id }),
    "meilin"
  );
  const vpn = await create_ticket(
    env.DB,
    TicketCreate.parse({ title: "VPN access for the new hire", category: "access" }),
    "meilin"
  );
  const declined = await create_ticket(
    env.DB,
    TicketCreate.parse({ title: "Rewrite everything in Rust", category: "other", assignees: ["andres"] }),
    "meilin"
  );
  const question = await create_ticket(
    env.DB,
    TicketCreate.parse({ title: "How do I rotate my MCP token", category: "question", assignees: ["beatrix"], sprint_id: b.id }),
    "meilin"
  );

  await set_ticket_parent(env.DB, loginBug, loginChild);
  await add_ticket_link(env.DB, loginBug, "#214", "andres");
  await add_ticket_comment(env.DB, loginBug, "Reproduced on staging.", "andres");

  await transition_ticket(env.DB, csvDone, "in_progress", "beatrix");
  await transition_ticket(env.DB, csvDone, "done", "beatrix");
  await transition_ticket(env.DB, declined, "declined", "andres");

  // Sprint A owns the same issue url its ticket links (first wins, one row out),
  // plus a design file of its own.
  await add_sprint_resource(env.DB, a.id, "#214");
  await add_sprint_resource(env.DB, a.id, FIGMA_URL);

  // The GitHub half of sprint A's progress (event-derived cache): 1 of 2 issues.
  await upsertProgress(env.DB, a.id, 1, 2, "event");

  return { sprintA: a.id, sprintB: b.id, loginBug, loginChild, csvDone, vpn, declined, question };
}

describe("the MCP ticket/sprint surface", () => {
  it("tools/list carries exactly the reads + the eight scoped ticket writes, and NOT toggle_assignee", async () => {
    const names = await toolNames("andres");
    for (const t of READ_TOOLS) expect(names).toContain(t);
    for (const t of WRITE_TOOLS) expect(names).toContain(t);
    for (const banned of BANNED_WRITE_TOOLS) expect(names).not.toContain(banned);
    // "exactly these": nothing else on the tickets/sprints surface exists for a
    // non-admin. Kept exhaustive on purpose — this list IS the surface's contract.
    expect(names.filter((n) => /ticket|sprint/.test(n)).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS, ...SPRINT_WRITE_TOOLS].sort());
  });

  it("a NON-ADMIN sees every read, every ticket write and every sprint write — but not update_plan", async () => {
    const names = await toolNames("beatrix");
    // beatrix is genuinely non-admin: the admin-only plan write is absent for her.
    expect(names).not.toContain("update_plan");
    for (const t of READ_TOOLS) expect(names).toContain(t);
    for (const t of WRITE_TOOLS) expect(names).toContain(t);
    for (const t of SPRINT_WRITE_TOOLS) expect(names).toContain(t);
  });

  it("an ADMIN gets update_plan on top, and no extra TICKET tool", async () => {
    const names = await toolNames("admin-user");
    for (const t of SPRINT_WRITE_TOOLS) expect(names).toContain(t);
    expect(names).toContain("update_plan");
    // The admin's ticket surface is the same as everyone's: the D6 exception is a
    // call-time scope relaxation on set_ticket_sprint, NOT an extra tool.
    expect(names.filter((n) => /ticket/.test(n)).sort()).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS].filter((n) => /ticket/.test(n)).sort()
    );
    for (const banned of BANNED_WRITE_TOOLS) expect(names).not.toContain(banned);
  });

  it("descriptions state the read/write split: reads unscoped, writes scoped to your lane", async () => {
    const desc = await toolDescriptions("andres");
    for (const t of READ_TOOLS) expect(desc.get(t) ?? "").toMatch(/read-only/i);
    // ADR-007, amended: a ticket may be sourced from a GitHub issue, but is never the issue itself.
    expect(desc.get("list_tickets")!).toMatch(/sourced from a GitHub issue, but is never the issue itself/i);
    expect(desc.get("list_tickets")!).not.toMatch(/never GitHub issues/i);
    // The stale "there is no MCP write path" claim must be gone from every one.
    for (const t of READ_TOOLS) expect(desc.get(t)!).not.toMatch(/no MCP write path|human-only/i);

    // Every scoped write says so; create_ticket says it is the exception.
    for (const t of WRITE_TOOLS.filter((n) => n !== "create_ticket")) {
      expect(desc.get(t)!, t).toMatch(/scoped/i);
    }
    expect(desc.get("create_ticket")!).toMatch(/unscoped/i);
    // …and where assignment goes after filing (issue #90).
    expect(desc.get("create_ticket")!).toMatch(/assign_ticket/);
    expect(desc.get("create_ticket")!).not.toMatch(/assignment is web-only|only place an agent can assign/i);
    // assign_ticket states its own rule, its idempotency, that status stays put, and where handles come from.
    const assign = desc.get("assign_ticket")!;
    expect(assign).toMatch(/admin/i);
    expect(assign).toMatch(/requester/i);
    expect(assign).toMatch(/idempotent/i);
    expect(assign).toMatch(/never changes status/i);
    expect(assign).toMatch(/list_people/);
    // Sprint writes are named as admin-only in the sprint READ descriptions, so a
    // non-admin agent learns why it cannot see them.
    expect(desc.get("list_sprints")!).toMatch(/admin-only/i);
  });
});

describe("registered MCP list_tickets tool", () => {
  it("defaults to seg 'open' — done and declined tickets are absent until you ask for them", async () => {
    const q = await seedQueue();

    const open = body<TicketListItem[]>(await callTool("andres", "list_tickets", {}));
    const openIds = open.map((t) => t.id);
    expect(openIds).toContain(q.loginBug);
    expect(openIds).toContain(q.vpn);
    expect(openIds).not.toContain(q.csvDone); // done
    expect(openIds).not.toContain(q.declined); // declined
    expect(open.every((t) => t.status === "submitted" || t.status === "in_progress")).toBe(true);

    // seg:'all' DOES carry them — so the default is a real filter, not an empty table.
    const all = body<TicketListItem[]>(await callTool("andres", "list_tickets", { seg: "all" }));
    expect(all.map((t) => t.id)).toEqual(expect.arrayContaining([q.csvDone, q.declined]));
    expect(all).toHaveLength(6);

    const closed = body<TicketListItem[]>(await callTool("andres", "list_tickets", { seg: "closed" }));
    expect(closed.map((t) => t.id).sort()).toEqual([q.csvDone, q.declined].sort());
  });

  it("each row carries its assignees, link count, sub count and sprint label", async () => {
    const q = await seedQueue();
    const rows = body<TicketListItem[]>(await callTool("andres", "list_tickets", { seg: "all" }));
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(q.loginBug)).toMatchObject({
      assignees: ["andres"],
      link_count: 1,
      sub_count: 1,
      sprint_label: "Queue cleanup",
      requester: "meilin",
    });
    expect(byId.get(q.loginChild)).toMatchObject({ assignees: [], link_count: 0, sub_count: 0, sprint_label: "Queue cleanup" });
    expect(byId.get(q.vpn)).toMatchObject({ assignees: [], sprint_label: null });
    expect(byId.get(q.question)!.sprint_label).toBe("Search polish");
  });

  it("assignee:'me' resolves to the principal the SERVER was built for, not a client argument", async () => {
    const q = await seedQueue();

    const mine = body<TicketListItem[]>(await callTool("andres", "list_tickets", { assignee: "me", seg: "all" }));
    const hers = body<TicketListItem[]>(await callTool("beatrix", "list_tickets", { assignee: "me", seg: "all" }));

    expect(mine.map((t) => t.id).sort()).toEqual([q.loginBug, q.declined].sort());
    expect(hers.map((t) => t.id).sort()).toEqual([q.csvDone, q.question].sort());
    expect(mine.every((t) => t.assignees.includes("andres"))).toBe(true);
    expect(hers.every((t) => t.assignees.includes("beatrix"))).toBe(true);
    // Two principals, two different answers — `me` cannot be a constant.
    expect(mine.map((t) => t.id).sort()).not.toEqual(hers.map((t) => t.id).sort());

    // A principal with nothing assigned gets an empty list, never everyone's.
    expect(body<TicketListItem[]>(await callTool("meilin", "list_tickets", { assignee: "me", seg: "all" }))).toEqual([]);

    const unassigned = body<TicketListItem[]>(await callTool("andres", "list_tickets", { assignee: "unassigned" }));
    expect(unassigned.map((t) => t.id).sort()).toEqual([q.loginChild, q.vpn].sort());
  });

  it("filters by category, and rejects a category outside the vocabulary", async () => {
    const q = await seedQueue();

    expect(body<TicketListItem[]>(await callTool("andres", "list_tickets", { category: "bug" })).map((t) => t.id)).toEqual([q.loginBug]);
    expect(body<TicketListItem[]>(await callTool("andres", "list_tickets", { category: "access" })).map((t) => t.id)).toEqual([q.vpn]);
    expect(body<TicketListItem[]>(await callTool("andres", "list_tickets", { category: "question" })).map((t) => t.id)).toEqual([q.question]);
    // seg and category compose.
    expect(
      body<TicketListItem[]>(await callTool("andres", "list_tickets", { category: "request", seg: "closed" })).map((t) => t.id)
    ).toEqual([q.csvDone]);

    const bad = await callTool("andres", "list_tickets", { category: "chore" });
    expect(bad.isError).toBeTruthy();
  });
});

describe("registered MCP get_ticket tool", () => {
  it("returns the whole TicketDetail — assignees, links, comments, events, parent, children, sprint", async () => {
    const q = await seedQueue();

    const t = body<TicketDetail>(await callTool("andres", "get_ticket", { id: q.loginBug }));
    expect(t.id).toBe(q.loginBug);
    expect(t.title).toBe("Login page throws on submit");
    expect(t.status).toBe("submitted");
    expect(t.category).toBe("bug");
    expect(t.requester).toBe("meilin");
    expect(t.assignees).toEqual(["andres"]);
    expect(t.links.map((l) => [l.url, l.kind])).toEqual([[ISSUE_214, "github"]]);
    expect(t.comments.map((c) => [c.author, c.body])).toEqual([["andres", "Reproduced on staging."]]);
    // The opening history row: nothing → submitted.
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ actor: "meilin", from_status: null, to_status: "submitted" });
    expect(t.parent).toBeNull();
    expect(t.children.map((c) => c.id)).toEqual([q.loginChild]);
    expect(t.sprint).toEqual({ id: q.sprintA, label: "Queue cleanup" });

    // The child sees its parent from the other side.
    const child = body<TicketDetail>(await callTool("andres", "get_ticket", { id: q.loginChild }));
    expect(child.parent).toMatchObject({ id: q.loginBug, title: "Login page throws on submit", status: "submitted" });
    expect(child.children).toEqual([]);

    // A transitioned ticket carries its whole history, in order.
    const done = body<TicketDetail>(await callTool("beatrix", "get_ticket", { id: q.csvDone }));
    expect(done.events.map((e) => [e.from_status, e.to_status])).toEqual([
      [null, "submitted"],
      ["submitted", "in_progress"],
      ["in_progress", "done"],
    ]);
  });

  it("an unknown id is an error result — { error } text with isError set", async () => {
    await seedQueue();
    const res = await callTool("andres", "get_ticket", { id: 999_999 });
    expect(res.isError).toBeTruthy();
    const err = body<{ error: string }>(res);
    expect(typeof err.error).toBe("string");
    expect(err.error).toContain("no such ticket");
  });
});

describe("registered MCP list_sprints tool", () => {
  it("carries TICKETS-ONLY progress, the cached issue counts as their own field, and the real member list", async () => {
    const q = await seedQueue();
    const sprints = body<SprintView[]>(await callTool("andres", "list_sprints", {}));
    expect(sprints).toHaveLength(2);

    const a = sprints.find((s) => s.id === q.sprintA)!;
    expect(a.label).toBe("Queue cleanup"); // title → label
    expect(a.due).toBe("2026-08-01"); // target_date → due
    expect(a.active).toBe(true);
    // 3 tickets, 1 of them done → 1/3. The 1/2 issue cache is reported BESIDE it,
    // never folded in (the old combined number was 2/5).
    expect(a.progress).toEqual({ closed: 1, total: 3, pct: 33 });
    expect(a.issues).toEqual({ closed: 1, total: 2 });
    expect(a.members).toEqual(["andres", "beatrix"]);

    const b = sprints.find((s) => s.id === q.sprintB)!;
    expect(b.active).toBe(false);
    // Tickets only, no cache at all → issues is null.
    expect(b.progress).toEqual({ closed: 0, total: 1, pct: 0 });
    expect(b.issues).toBeNull();
    expect(b.members).toEqual(["beatrix"]);
  });
});

describe("registered MCP get_sprint tool", () => {
  it("orders tickets roots-then-children and dedupes resources by url", async () => {
    const q = await seedQueue();
    const sp = body<SprintDetail>(await callTool("andres", "get_sprint", { id: q.sprintA }));

    expect(sp.label).toBe("Queue cleanup");
    expect(sp.progress).toEqual({ closed: 1, total: 3, pct: 33 });
    expect(sp.issues).toEqual({ closed: 1, total: 2 });
    expect(sp.members).toEqual(["andres", "beatrix"]);

    // Only the sprint's own tickets, and the sub-ticket sits DIRECTLY under its root.
    expect(sp.tickets.map((t) => t.id).sort()).toEqual([q.loginBug, q.loginChild, q.csvDone].sort());
    const rootIdx = sp.tickets.findIndex((t) => t.id === q.loginBug);
    expect(sp.tickets[rootIdx].depth).toBe(0);
    expect(sp.tickets[rootIdx + 1]).toMatchObject({ id: q.loginChild, depth: 1 });
    expect(sp.tickets.filter((t) => t.depth === 1).map((t) => t.id)).toEqual([q.loginChild]);

    // The issue url is on BOTH the sprint and one of its tickets — it shows once,
    // as the sprint's own resource (sprint resources first, first occurrence wins).
    expect(sp.resources.map((r) => r.url)).toEqual([ISSUE_214, FIGMA_URL]);
    expect(sp.resources.map((r) => r.kind)).toEqual(["github", "figma"]);

    // The other sprint lists only its own ticket, and no resources.
    const other = body<SprintDetail>(await callTool("andres", "get_sprint", { id: q.sprintB }));
    expect(other.tickets.map((t) => t.id)).toEqual([q.question]);
    expect(other.resources).toEqual([]);
  });

  it("an unknown id is an error result — { error } text with isError set", async () => {
    await seedQueue();
    const res = await callTool("andres", "get_sprint", { id: 999_999 });
    expect(res.isError).toBeTruthy();
    const err = body<{ error: string }>(res);
    expect(typeof err.error).toBe("string");
    expect(err.error).toContain("no such sprint");
  });
});
