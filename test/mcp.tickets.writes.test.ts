import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { all, first, run, nowIso } from "../src/db";
import { create_ticket, transition_ticket } from "../src/tools/tickets";
import { mirrorIssue } from "../src/tools/ticket-mirror";
import { getMyWork } from "../src/tools/mywork";
import type { TicketDetail } from "@shared/tickets";
import type { TicketRow } from "@shared/rows";
import { seedPerson } from "./helpers/persons";
import { bearerCtx, systemCtx, platformCtx } from "./helpers/tenant";

// Phase 2: the ticket WRITE tools, driven through the REAL registered closures
// over an in-memory transport — never the writers directly, so a missing or
// renamed registration is a failure rather than a green.
//
// The property this file exists for: an agent writes only inside its principal's
// own lane, and a refusal writes NOTHING. ADMIN_LOGINS binds only "admin-user"
// (vitest.config.ts), so andres/beatrix are plain principals.

const ISSUE_214 = "https://github.com/SaplingLearn/sapling/issues/214";

async function withClient<T>(handle: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx(handle));
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

/** A successful call's payload. Fails loudly if the tool actually errored. */
function ok<T>(r: { text: string; isError?: boolean }): T {
  expect(r.isError, r.text).toBeFalsy();
  return JSON.parse(r.text) as T;
}

/** A refusal's `{ error, code }`. Fails loudly if the tool actually succeeded. */
function failed(r: { text: string; isError?: boolean }): { error: string; code?: string } {
  expect(r.isError, `expected a refusal, got: ${r.text}`).toBe(true);
  return JSON.parse(r.text) as { error: string; code?: string };
}

async function seedSprint(title: string): Promise<number> {
  const now = nowIso();
  const res = await run(
    env.DB,
    `INSERT INTO sprints (title, target_date, status, created_at, created_by, updated_at) VALUES (?, '2026-09-01', 'upcoming', ?, 'andres', ?)`,
    title, now, now
  );
  return res.meta.last_row_id as number;
}

async function ticketFor(requester: string, assignees: string[], title = "a ticket"): Promise<number> {
  for (const h of [requester, ...assignees]) await seedPerson(h);
  return create_ticket(systemCtx(), { title, body: "", category: "other", priority: "normal", assignees }, requester);
}

/** Everything a ticket write could touch — for the untouched-on-refusal assertions. */
async function snapshot(id: number) {
  return {
    row: await first<TicketRow>(env.DB, `SELECT * FROM tickets WHERE id = ?`, id),
    events: await all(env.DB, `SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id`, id),
    comments: await all(env.DB, `SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY id`, id),
    links: await all(env.DB, `SELECT * FROM ticket_links WHERE ticket_id = ? ORDER BY id`, id),
    assignees: await all(env.DB, `SELECT * FROM ticket_assignees WHERE ticket_id = ? ORDER BY login`, id),
  };
}

describe("the lane rule over MCP", () => {
  it("refuses EVERY scoped verb for a non-assignee, and writes nothing", async () => {
    const id = await ticketFor("andres", ["andres"], "andres's ticket");
    const other = await ticketFor("andres", ["andres"], "andres's other ticket");
    const sprint = await seedSprint("Sprint A");
    await seedPerson("beatrix");

    // The whole scoped surface, in one table — a verb added without a scope
    // assertion shows up here as a passing write, which fails the expectations.
    const calls: Array<[string, Record<string, unknown>]> = [
      ["transition_ticket", { id, to: "in_progress" }],
      ["add_ticket_comment", { id, body: "let me help" }],
      ["add_ticket_link", { id, raw: ISSUE_214 }],
      ["set_ticket_sprint", { id, sprint_id: sprint }],
      ["set_ticket_parent", { id, child_id: other }],
    ];

    for (const [name, args] of calls) {
      const before = await snapshot(id);
      const err = failed(await callTool("beatrix", name, args));
      expect(err.code, name).toBe("forbidden");
      expect(err.error, name).toMatch(/not assigned to you/i);
      expect(await snapshot(id), name).toEqual(before);
    }
  });

  it("an unknown ticket id is not_found, never forbidden", async () => {
    await seedPerson("beatrix");
    const err = failed(await callTool("beatrix", "transition_ticket", { id: 99_999, to: "in_progress" }));
    // A `forbidden` here would let a non-assignee probe which ids exist.
    expect(err.code).toBe("not_found");
  });

  it("lets an assignee do everything the ticket screen offers — done included", async () => {
    const id = await ticketFor("andres", ["andres"]);
    const sprint = await seedSprint("Sprint B");

    const started = ok<TicketDetail>(await callTool("andres", "transition_ticket", { id, to: "in_progress" }));
    expect(started.status).toBe("in_progress");

    const commented = ok<TicketDetail>(await callTool("andres", "add_ticket_comment", { id, body: "picked this up" }));
    expect(commented.comments.at(-1)!.body).toBe("picked this up");
    expect(commented.comments.at(-1)!.author).toBe("andres");

    const linked = ok<TicketDetail>(await callTool("andres", "add_ticket_link", { id, raw: "#214" }));
    expect(linked.links.at(-1)!.url).toBe(ISSUE_214);

    const homed = ok<TicketDetail>(await callTool("andres", "set_ticket_sprint", { id, sprint_id: sprint }));
    expect(homed.sprint!.id).toBe(sprint);

    // D1: the bearer token IS the person, so the resolving move is inside the lane.
    const done = ok<TicketDetail>(await callTool("andres", "transition_ticket", { id, to: "done" }));
    expect(done.status).toBe("done");
    // Attributed to the person, with nothing marking it agent-written (D4).
    expect(done.events.map((e) => e.to_status)).toEqual(["submitted", "in_progress", "done"]);
    expect(done.events.every((e) => e.actor === "andres")).toBe(true);
  });

  it("returns the WHOLE ticket from every write, like the cookie routes", async () => {
    const id = await ticketFor("andres", ["andres"]);
    const detail = ok<TicketDetail>(await callTool("andres", "transition_ticket", { id, to: "in_progress" }));
    for (const k of ["assignees", "links", "comments", "events", "parent", "children", "sprint"]) {
      expect(detail, k).toHaveProperty(k);
    }
  });
});

describe("create_ticket — the one unscoped write", () => {
  it("files for any principal, with the BEARER as requester", async () => {
    await seedPerson("beatrix");
    const t = ok<TicketDetail>(await callTool("beatrix", "create_ticket", {
      title: "CSV export drops the header row",
      body: "Repro: export any report.",
      category: "bug",
      priority: "high",
      // A client-supplied writer is advisory and ignored, exactly as with /ingest.
      requester: "andres",
    }));
    expect(t.requester).toBe("beatrix");
    expect(t.status).toBe("submitted");
    expect(t.category).toBe("bug");
    // The opening history row is written by the same writer the web uses.
    expect(t.events).toHaveLength(1);
    expect(t.events[0].from_status).toBeNull();
  });

  it("assigns at filing — and filing for someone else does NOT put the agent in the lane", async () => {
    await seedPerson("andres");
    await seedPerson("meilin");
    const t = ok<TicketDetail>(await callTool("andres", "create_ticket", {
      title: "VPN access for the new starter",
      category: "access",
      assignees: ["meilin"],
    }));
    expect(t.assignees).toEqual(["meilin"]);

    const names = await withClient("andres", async (c) => (await c.listTools()).tools.map((x) => x.name));
    expect(names).not.toContain("toggle_assignee");
    // …and having filed it for someone else, the agent is NOT in its own lane.
    const err = failed(await callTool("andres", "transition_ticket", { id: t.id, to: "in_progress" }));
    expect(err.code).toBe("forbidden");
  });

  it("rejects an unknown assignee handle without leaving a half-built ticket", async () => {
    await seedPerson("andres");
    const before = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM tickets`);
    const err = failed(await callTool("andres", "create_ticket", { title: "bad handle", assignees: ["nobody-at-all"] }));
    expect(err.code).toBe("bad_request");
    // Validation happens BEFORE the first insert — D1 has no transaction here.
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM tickets`))!.n).toBe(before!.n);
  });
});

describe("the shared rules still bite over MCP", () => {
  it("an illegal transition is a conflict that writes nothing", async () => {
    const id = await ticketFor("andres", ["andres"]);
    const before = await snapshot(id);
    // submitted → submitted is not in the one shared table (tickets-core.ts) —
    // every status may go anywhere ELSE, so a no-op move is the only illegal one.
    const err = failed(await callTool("andres", "transition_ticket", { id, to: "submitted" }));
    expect(err.code).toBe("conflict");
    expect(await snapshot(id)).toEqual(before);
  });

  it("a resolved ticket moves back", async () => {
    const id = await ticketFor("andres", ["andres"]);
    ok(await callTool("andres", "transition_ticket", { id, to: "in_progress" }));
    ok(await callTool("andres", "transition_ticket", { id, to: "declined" }));
    ok(await callTool("andres", "transition_ticket", { id, to: "submitted" }));
  });

  it("an unusable link is bad_request", async () => {
    const id = await ticketFor("andres", ["andres"]);
    // A non-http scheme is never dereferenced into an issue URL.
    expect(failed(await callTool("andres", "add_ticket_link", { id, raw: "javascript:alert(1)" })).code).toBe("bad_request");
  });

  it("an unknown sprint is not_found, and the ticket is untouched", async () => {
    const id = await ticketFor("andres", ["andres"]);
    const before = await snapshot(id);
    expect(failed(await callTool("andres", "set_ticket_sprint", { id, sprint_id: 4242 })).code).toBe("not_found");
    expect(await snapshot(id)).toEqual(before);
  });

  it("all four nesting rejections fire", async () => {
    const parent = await ticketFor("andres", ["andres"], "parent");
    const child = await ticketFor("andres", ["andres"], "child");
    const grandchild = await ticketFor("andres", ["andres"], "grandchild");
    const closed = await ticketFor("andres", ["andres"], "closed");

    ok(await callTool("andres", "set_ticket_parent", { id: parent, child_id: child }));

    // 1. the parent itself has a parent → that would be level two
    expect(failed(await callTool("andres", "set_ticket_parent", { id: child, child_id: grandchild })).code).toBe("conflict");
    // 2. the child already has a parent
    const other = await ticketFor("andres", ["andres"], "other parent");
    expect(failed(await callTool("andres", "set_ticket_parent", { id: other, child_id: child })).code).toBe("conflict");
    // 3. the child is closed
    ok(await callTool("andres", "transition_ticket", { id: closed, to: "in_progress" }));
    ok(await callTool("andres", "transition_ticket", { id: closed, to: "done" }));
    expect(failed(await callTool("andres", "set_ticket_parent", { id: other, child_id: closed })).code).toBe("conflict");
    // 4. the child has sub-tickets of its own
    expect(failed(await callTool("andres", "set_ticket_parent", { id: other, child_id: parent })).code).toBe("conflict");
    // …and the degenerate self-parent.
    expect(failed(await callTool("andres", "set_ticket_parent", { id: other, child_id: other })).code).toBe("conflict");
  });

  it("set_ticket_parent needs the lane on BOTH tickets", async () => {
    const parent = await ticketFor("andres", ["andres"], "andres's parent");
    const child = await ticketFor("andres", ["beatrix"], "beatrix's child");
    expect(failed(await callTool("andres", "set_ticket_parent", { id: parent, child_id: child })).code).toBe("forbidden");
    expect(failed(await callTool("beatrix", "set_ticket_parent", { id: parent, child_id: child })).code).toBe("forbidden");
  });
});

describe("D6 — an admin may re-home any ticket, and nothing more", () => {
  it("moves a ticket the admin is not assigned to", async () => {
    await seedPerson("admin-user");
    const id = await ticketFor("andres", ["andres"], "andres's ticket");
    const sprint = await seedSprint("Sprint C");
    const moved = ok<TicketDetail>(await callTool("admin-user", "set_ticket_sprint", { id, sprint_id: sprint }));
    expect(moved.sprint!.id).toBe(sprint);
  });

  it("does NOT let the admin resolve, comment on, link or re-parent that ticket", async () => {
    await seedPerson("admin-user");
    const id = await ticketFor("andres", ["andres"], "andres's ticket");
    const other = await ticketFor("andres", ["andres"], "another");
    for (const [name, args] of [
      ["transition_ticket", { id, to: "in_progress" }],
      ["add_ticket_comment", { id, body: "closing this" }],
      ["add_ticket_link", { id, raw: ISSUE_214 }],
      ["set_ticket_parent", { id, child_id: other }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(failed(await callTool("admin-user", name, args)).code, name).toBe("forbidden");
    }
  });

  it("is admin-only — a non-admin cannot re-home someone else's ticket", async () => {
    const id = await ticketFor("andres", ["andres"]);
    const sprint = await seedSprint("Sprint D");
    await seedPerson("beatrix");
    expect(failed(await callTool("beatrix", "set_ticket_sprint", { id, sprint_id: sprint })).code).toBe("forbidden");
  });
});

describe("assign_ticket — issue #90: admin, requester or current assignee", () => {
  it("adds and removes one assignee, returns the whole ticket, and never changes status", async () => {
    const id = await ticketFor("andres", ["andres"]);
    await seedPerson("beatrix");

    const added = ok<TicketDetail>(await callTool("andres", "assign_ticket", { id, login: "beatrix", on: true }));
    expect(added.assignees.sort()).toEqual(["andres", "beatrix"]);
    // Matches the web picker exactly: assigning a submitted ticket does not start it.
    expect(added.status).toBe("submitted");
    expect(added).toHaveProperty("events");

    const removed = ok<TicketDetail>(await callTool("andres", "assign_ticket", { id, login: "beatrix", on: false }));
    expect(removed.assignees).toEqual(["andres"]);
    expect(removed.status).toBe("submitted");
    // No history row: ticket_events audits status moves only — the opening row is all there is.
    expect(removed.events).toHaveLength(1);
  });

  it("is idempotent in BOTH directions — a no-op writes nothing, not even updated_at", async () => {
    const id = await ticketFor("andres", ["andres", "beatrix"]);
    await seedPerson("meilin");

    const before = await snapshot(id);
    // Already assigned (a case variant of the handle, even) → success, nothing written.
    expect(ok<TicketDetail>(await callTool("andres", "assign_ticket", { id, login: "Beatrix", on: true })).assignees.sort()).toEqual(["andres", "beatrix"]);
    expect(await snapshot(id)).toEqual(before);
    // Not assigned → removing succeeds, nothing written.
    expect(ok<TicketDetail>(await callTool("andres", "assign_ticket", { id, login: "meilin", on: false })).assignees.sort()).toEqual(["andres", "beatrix"]);
    expect(await snapshot(id)).toEqual(before);
  });

  it("an unknown handle is bad_request — on the no-op path too — and writes nothing", async () => {
    const id = await ticketFor("andres", ["andres"]);
    const before = await snapshot(id);
    expect(failed(await callTool("andres", "assign_ticket", { id, login: "nobody-at-all", on: true })).code).toBe("bad_request");
    expect(failed(await callTool("andres", "assign_ticket", { id, login: "nobody-at-all", on: false })).code).toBe("bad_request");
    expect(await snapshot(id)).toEqual(before);
  });

  it("refuses a RESERVED handle — github-webhook has a persons row but is not a person", async () => {
    const id = await ticketFor("andres", ["andres"]);
    const before = await snapshot(id);
    expect(failed(await callTool("andres", "assign_ticket", { id, login: "github-webhook", on: true })).code).toBe("bad_request");
    expect(await snapshot(id)).toEqual(before);
  });

  it("an unknown ticket is not_found BEFORE scope — never forbidden", async () => {
    await seedPerson("beatrix");
    const err = failed(await callTool("beatrix", "assign_ticket", { id: 99_999, login: "beatrix", on: true }));
    expect(err.code).toBe("not_found");
  });

  it("an ADMIN may assign on any ticket", async () => {
    await seedPerson("admin-user");
    const id = await ticketFor("andres", ["andres"], "andres's ticket");
    await seedPerson("meilin");
    const t = ok<TicketDetail>(await callTool("admin-user", "assign_ticket", { id, login: "meilin", on: true }));
    expect(t.assignees.sort()).toEqual(["andres", "meilin"]);
  });

  it("the REQUESTER may route their own ticket, even with nobody on it", async () => {
    const id = await ticketFor("beatrix", [], "beatrix filed this");
    await seedPerson("meilin");
    const t = ok<TicketDetail>(await callTool("beatrix", "assign_ticket", { id, login: "meilin", on: true }));
    expect(t.assignees).toEqual(["meilin"]);
    // …and hand it back: the requester's right does not depend on being an assignee.
    expect(ok<TicketDetail>(await callTool("beatrix", "assign_ticket", { id, login: "meilin", on: false })).assignees).toEqual([]);
  });

  it("a CURRENT ASSIGNEE may hand the ticket on — and removing themselves leaves their lane", async () => {
    const id = await ticketFor("andres", ["beatrix"], "beatrix's ticket");
    await seedPerson("meilin");
    ok(await callTool("beatrix", "assign_ticket", { id, login: "meilin", on: true }));
    const t = ok<TicketDetail>(await callTool("beatrix", "assign_ticket", { id, login: "beatrix", on: false }));
    expect(t.assignees).toEqual(["meilin"]);
    expect(failed(await callTool("beatrix", "transition_ticket", { id, to: "in_progress" })).code).toBe("forbidden");
  });

  it("an unrelated principal is forbidden — even to add themselves — and the ticket is byte-identical after", async () => {
    const id = await ticketFor("andres", ["beatrix"], "not meilin's");
    await seedPerson("meilin");
    const before = await snapshot(id);
    for (const args of [
      { id, login: "meilin", on: true },
      { id, login: "beatrix", on: false },
      { id, login: "andres", on: true },
    ]) {
      const err = failed(await callTool("meilin", "assign_ticket", args));
      expect(err.code).toBe("forbidden");
      expect(err.error).toMatch(/admin, its requester or one of its assignees/i);
      expect(await snapshot(id)).toEqual(before);
    }
  });

  it("assigns a ticket MIRRORED from a GitHub issue, and it lands in that person's My Work", async () => {
    await seedPerson("admin-user");
    await seedPerson("meilin", { github: false }); // a Google-only teammate GitHub cannot reach
    // An unmapped author files as the system person, with nobody on it.
    expect(await mirrorIssue(systemCtx(), platformCtx(), "SaplingLearn/sapling", {
      action: "opened",
      repository: { full_name: "SaplingLearn/sapling" },
      issue: {
        number: 901, title: "[P2] Beta onboarding copy", body: "", html_url: "https://github.com/SaplingLearn/sapling/issues/901",
        state: "open", state_reason: null, updated_at: "2026-09-27T10:00:00Z", user: { login: "someone-unmapped" },
        assignees: [], labels: [], milestone: null,
      },
    })).toBe("created");
    const mirrored = await first<{ id: number; requester: string }>(env.DB, `SELECT id, requester FROM tickets WHERE source_ref = ?`, "SaplingLearn/sapling#901");
    expect(mirrored!.requester).toBe("github-webhook");
    const id = mirrored!.id;

    // Nobody is on it and its requester is the system person, so only an admin may route it.
    expect(failed(await callTool("meilin", "assign_ticket", { id, login: "meilin", on: true })).code).toBe("forbidden");
    const t = ok<TicketDetail>(await callTool("admin-user", "assign_ticket", { id, login: "meilin", on: true }));
    expect(t.source).toBe("github");
    expect(t.assignees).toEqual(["meilin"]);
    expect(t.status).toBe("submitted");

    const mw = await getMyWork(systemCtx(), "meilin");
    expect(mw.tickets.map((x) => x.id)).toContain(id);
    expect(mw.ticketsTotal).toBe(1);
  });

  it("leaves a resolved ticket resolved", async () => {
    const id = await ticketFor("andres", ["andres"]);
    await transition_ticket(systemCtx(), id, "done", "andres");
    await seedPerson("beatrix");
    expect(ok<TicketDetail>(await callTool("andres", "assign_ticket", { id, login: "beatrix", on: true })).status).toBe("done");
  });
});
