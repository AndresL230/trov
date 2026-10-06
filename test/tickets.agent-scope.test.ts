import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { all, first, run, nowIso } from "./helpers/db";
import { TicketError, create_ticket } from "../src/tools/tickets";
import {
  assertTicketWritable,
  agentTransitionTicket, agentAddTicketComment, agentAddTicketLink,
  agentSetTicketSprint, agentSetTicketParent,
} from "../src/tools/tickets-agent";
import type { TicketRow } from "@shared/rows";
import { seedPerson } from "./helpers/persons";

import { systemCtx } from "./helpers/tenant";
// Phase 1: the SCOPE PRIMITIVE, unit level. An agent writes only inside its
// principal's own lane — the bearer must already be an assignee of the ticket.
// The MCP-level pass over the same rule is test/mcp.tickets.writes.test.ts; this
// file proves the rule itself, including the property that matters most: a
// REFUSAL WRITES NOTHING.
//
// ADMIN_LOGINS binds only "admin-user" (vitest.config.ts), so andres/beatrix are
// plain principals and admin-user is the D6 exception's subject.

const ENV = env as unknown as Env;
const ISSUE_214 = "https://github.com/SaplingLearn/sapling/issues/214";

async function seedSprint(title: string): Promise<number> {
  const now = nowIso();
  const res = await run(
    env.DB,
    `INSERT INTO sprints (title, target_date, status, created_at, created_by, updated_at) VALUES (?, '2026-09-01', 'upcoming', ?, 'andres', ?)`,
    title, now, now
  );
  return res.meta.last_row_id as number;
}

/** A ticket filed by `requester`, assigned to `assignees`. */
async function ticketFor(requester: string, assignees: string[], title = "a ticket"): Promise<number> {
  for (const a of [requester, ...assignees]) await seedPerson(a);
  return create_ticket(
    systemCtx(),
    { title, body: "", category: "other", priority: "normal", assignees },
    requester
  );
}

/** Everything a write could possibly touch, for the untouched-on-refusal assertions. */
async function snapshot(id: number) {
  return {
    row: await first<TicketRow>(env.DB, `SELECT * FROM tickets WHERE id = ?`, id),
    events: await all(env.DB, `SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id`, id),
    comments: await all(env.DB, `SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY id`, id),
    links: await all(env.DB, `SELECT * FROM ticket_links WHERE ticket_id = ? ORDER BY id`, id),
    assignees: await all(env.DB, `SELECT * FROM ticket_assignees WHERE ticket_id = ? ORDER BY login`, id),
  };
}

/** Assert `fn` refuses with `code` AND leaves every row behind the ticket identical. */
async function refusesAndWritesNothing(id: number, code: string, fn: () => Promise<unknown>): Promise<TicketError> {
  const before = await snapshot(id);
  const err = await fn().then(
    () => { throw new Error("expected a refusal, but the write succeeded"); },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(TicketError);
  expect((err as TicketError).code).toBe(code);
  expect(await snapshot(id)).toEqual(before);
  return err as TicketError;
}

describe("assertTicketWritable — the lane rule", () => {
  it("permits an assignee and refuses a non-assignee", async () => {
    const id = await ticketFor("andres", ["andres"]);
    await seedPerson("beatrix");

    await expect(assertTicketWritable(systemCtx(), ENV, id, "andres", "transition_ticket")).resolves.toBeUndefined();

    const err = await assertTicketWritable(systemCtx(), ENV, id, "beatrix", "transition_ticket").catch((e) => e);
    expect(err).toBeInstanceOf(TicketError);
    expect(err.code).toBe("forbidden");
    // The message points at the remedy: a person assigns, in the web UI.
    expect(err.message).toMatch(/not assigned to you/i);
  });

  it("404 BEFORE 403 — an unknown id is not_found even for a non-assignee", async () => {
    await seedPerson("beatrix");
    const err = await assertTicketWritable(systemCtx(), ENV, 99_999, "beatrix", "transition_ticket").catch((e) => e);
    expect(err).toBeInstanceOf(TicketError);
    // A `forbidden` here would make the scope check an existence oracle.
    expect(err.code).toBe("not_found");
  });

  it("matches handles COLLATE NOCASE, like persons.handle", async () => {
    const id = await ticketFor("andres", ["andres"]);
    await expect(assertTicketWritable(systemCtx(), ENV, id, "Andres", "add_ticket_comment")).resolves.toBeUndefined();
    await expect(assertTicketWritable(systemCtx(), ENV, id, "ANDRES", "add_ticket_comment")).resolves.toBeUndefined();
  });

  it("an unassigned ticket is nobody's lane", async () => {
    const id = await ticketFor("andres", []);
    const err = await assertTicketWritable(systemCtx(), ENV, id, "andres", "transition_ticket").catch((e) => e);
    // Even the REQUESTER is refused: the lane is assignment, not authorship.
    expect(err.code).toBe("forbidden");
  });
});

describe("every refusal leaves D1 untouched", () => {
  it("refuses each scoped verb for a non-assignee and writes nothing", async () => {
    const id = await ticketFor("andres", ["andres"], "not beatrix's");
    const other = await ticketFor("andres", ["andres"], "also not beatrix's");
    const sprint = await seedSprint("Sprint A");
    await seedPerson("beatrix");

    await refusesAndWritesNothing(id, "forbidden", () => agentTransitionTicket(systemCtx(), ENV, id, "in_progress", "beatrix"));
    await refusesAndWritesNothing(id, "forbidden", () => agentAddTicketComment(systemCtx(), ENV, id, "hello", "beatrix"));
    await refusesAndWritesNothing(id, "forbidden", () => agentAddTicketLink(systemCtx(), ENV, id, ISSUE_214, "beatrix"));
    await refusesAndWritesNothing(id, "forbidden", () => agentSetTicketSprint(systemCtx(), ENV, id, sprint, "beatrix"));
    await refusesAndWritesNothing(id, "forbidden", () => agentSetTicketParent(systemCtx(), ENV, id, other, "beatrix"));
  });

  it("an assignee's ILLEGAL move is still a conflict that writes nothing", async () => {
    const id = await ticketFor("andres", ["andres"]);
    // submitted → submitted is not in the table; the shared rule still bites on this path.
    await refusesAndWritesNothing(id, "conflict", () => agentTransitionTicket(systemCtx(), ENV, id, "submitted", "andres"));
  });
});

describe("the six wrappers inside the lane", () => {
  it("an assignee may do everything the ticket screen offers — done included", async () => {
    const id = await ticketFor("andres", ["andres"]);
    const sprint = await seedSprint("Sprint B");

    await agentTransitionTicket(systemCtx(), ENV, id, "in_progress", "andres");
    await agentAddTicketComment(systemCtx(), ENV, id, "picked this up", "andres");
    await agentAddTicketLink(systemCtx(), ENV, id, ISSUE_214, "andres");
    await agentSetTicketSprint(systemCtx(), ENV, id, sprint, "andres");
    // D1: the bearer token IS the person, so the resolving move is in the lane.
    await agentTransitionTicket(systemCtx(), ENV, id, "done", "andres");

    const row = await first<TicketRow>(env.DB, `SELECT * FROM tickets WHERE id = ?`, id);
    expect(row!.status).toBe("done");
    expect(row!.sprint_id).toBe(sprint);
    const events = await all<{ to_status: string; actor: string }>(
      env.DB, `SELECT to_status, actor FROM ticket_events WHERE ticket_id = ? ORDER BY id`, id
    );
    // opening + in_progress + done, every one attributed to the person (no provenance — D4).
    expect(events.map((e) => e.to_status)).toEqual(["submitted", "in_progress", "done"]);
    expect(events.every((e) => e.actor === "andres")).toBe(true);
  });
});

describe("set_ticket_parent needs the lane on BOTH ids", () => {
  it("refuses when the actor is an assignee of only one of the two", async () => {
    const parent = await ticketFor("andres", ["andres"], "parent");
    const child = await ticketFor("andres", ["beatrix"], "child");

    // andres owns the parent but not the child — the child's row is what changes.
    await refusesAndWritesNothing(child, "forbidden", () => agentSetTicketParent(systemCtx(), ENV, parent, child, "andres"));
    // beatrix owns the child but not the parent — the parent's updated_at changes too.
    await refusesAndWritesNothing(parent, "forbidden", () => agentSetTicketParent(systemCtx(), ENV, parent, child, "beatrix"));
  });

  it("permits it when the actor owns both, subject to the existing nesting rules", async () => {
    const parent = await ticketFor("andres", ["andres"], "parent");
    const child = await ticketFor("andres", ["andres"], "child");
    await agentSetTicketParent(systemCtx(), ENV, parent, child, "andres");
    const row = await first<TicketRow>(env.DB, `SELECT * FROM tickets WHERE id = ?`, child);
    expect(row!.parent_id).toBe(parent);

    // …and the one-level rule still fires on this path, as a conflict.
    const grandchild = await ticketFor("andres", ["andres"], "grandchild");
    await refusesAndWritesNothing(grandchild, "conflict", () => agentSetTicketParent(systemCtx(), ENV, child, grandchild, "andres"));
  });
});

describe("D6 — the admin's set_ticket_sprint exception", () => {
  it("lets an admin re-home a ticket they are not assigned to", async () => {
    await seedPerson("admin-user");
    const id = await ticketFor("andres", ["andres"], "someone else's");
    const sprint = await seedSprint("Sprint C");

    await agentSetTicketSprint(systemCtx(), ENV, id, sprint, "admin-user");
    const row = await first<TicketRow>(env.DB, `SELECT * FROM tickets WHERE id = ?`, id);
    expect(row!.sprint_id).toBe(sprint);
  });

  it("does NOT spread to any other verb", async () => {
    await seedPerson("admin-user");
    const id = await ticketFor("andres", ["andres"], "someone else's");
    const other = await ticketFor("andres", ["andres"], "another");

    await refusesAndWritesNothing(id, "forbidden", () => agentTransitionTicket(systemCtx(), ENV, id, "in_progress", "admin-user"));
    await refusesAndWritesNothing(id, "forbidden", () => agentAddTicketComment(systemCtx(), ENV, id, "hi", "admin-user"));
    await refusesAndWritesNothing(id, "forbidden", () => agentAddTicketLink(systemCtx(), ENV, id, ISSUE_214, "admin-user"));
    await refusesAndWritesNothing(id, "forbidden", () => agentSetTicketParent(systemCtx(), ENV, id, other, "admin-user"));
  });

  it("is admin-only — a non-admin still cannot re-home a ticket outside their lane", async () => {
    const id = await ticketFor("andres", ["andres"]);
    const sprint = await seedSprint("Sprint D");
    await seedPerson("beatrix");
    await refusesAndWritesNothing(id, "forbidden", () => agentSetTicketSprint(systemCtx(), ENV, id, sprint, "beatrix"));
  });
});
