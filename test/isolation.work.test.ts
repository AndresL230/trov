/**
 * Cross-tenant isolation — the work and notification modules (canopy-multitenancy.md §10.2).
 * Two orgs (SaplingLearn = A, Acme = B) hold tickets, sprints, a plan and notification state; every
 * row written under one is invisible and unmodifiable from the other, a cross-org edge is refused as
 * not-found, and each org numbers its tickets from its own counter.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { all, first, run } from "./helpers/db";
import type { Env } from "../src/env";
import { TicketCreate } from "@shared/tickets";
import { SprintCreate } from "@shared/sprints";
import type { NotificationKind } from "@shared/notifications";
import type { NotificationOutboxRow } from "@shared/rows";
import type { TenantContext } from "../src/data/sql";
import {
  TicketError, create_ticket, transition_ticket, move_ticket, toggle_assignee, add_ticket_link, remove_ticket_link,
  edit_ticket, set_ticket_sprint, set_ticket_parent, add_ticket_comment, delete_ticket,
} from "../src/tools/tickets";
import { assertTicketWritable, assertTicketAssignable, agentAssignTicket } from "../src/tools/tickets-agent";
import { get_ticket } from "../src/tools/reads";
import {
  SprintError, create_sprint, list_sprints, get_sprint, set_sprint_active, complete_sprint, delete_sprint,
  add_sprint_resource, ticketCountsBySprint,
} from "../src/tools/sprints";
import { upsertProgress, getProgress, applyEventProgress } from "../src/tools/progress";
import { write_plan, get_plan } from "../src/tools/plan";
import { getMyWork, listAssignedTickets, countAssignedTickets, list_events } from "../src/tools/mywork";
import { mirrorIssue } from "../src/tools/ticket-mirror";
import { seedNotificationPolicy } from "../src/notifications/policy";
import { loadPolicies, loadPrefs, resolveCadence } from "../src/notifications/resolve";
import { loadSettings } from "../src/notifications/cron";
import { runDigest } from "../src/notifications/run";
import { retryFailed } from "../src/notifications/retry";
import { localDelivery } from "../src/notifications/delivery";
import { seedPerson, cookieFor } from "./helpers/persons";
import { systemCtx, platformCtx, ensureMember, ORG_A, ORG_B } from "./helpers/tenant";

const A = systemCtx();
const B = systemCtx(ORG_B);
const e = env as unknown as Env;

const ticket = (o: Partial<TicketCreate> & { title: string }) => TicketCreate.parse(o);
const sprint = (label: string) => SprintCreate.parse({ label });
// A writer takes and returns a ticket's per-org NUMBER; the row id is what the child tables and
// `parent_id` hold. `rowId` reads one from the other, for the raw assertions below.
const rowId = async (org: string, number: number) => (await first<{ id: number }>(env.DB, `SELECT id FROM tickets WHERE org_id = ? AND number = ?`, org, number))!.id;
const rowOf = <T>(org: string, number: number, cols = "*") => first<T>(env.DB, `SELECT ${cols} FROM tickets WHERE org_id = ? AND number = ?`, org, number);
const orgOf = async (table: string, where: string, ...binds: unknown[]) =>
  (await all<{ org_id: string }>(env.DB, `SELECT org_id FROM ${table} WHERE ${where}`, ...binds)).map((r) => r.org_id);
const count = async (table: string, org: string) =>
  (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`, org))!.n;

/** The rejection every cross-org reach must be: the other org's id reads as not found. */
const notFound = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (x: unknown) => x);
  expect(err).toBeInstanceOf(Error);
  expect((err as TicketError | SprintError).code).toBe("not_found");
};

beforeEach(async () => {
  await seedPerson("alice");                       // A only
  await ensureMember("bob", "member", ORG_B);      // B only
  await seedPerson("carol");                       // both
  await ensureMember("carol", "member", ORG_B);
});

describe("tickets", () => {
  it("each org numbers its tickets from its own counter — and that number is what a writer returns; the row id stays the internal key", async () => {
    const a1 = await create_ticket(A, ticket({ title: "A one" }), "alice");
    const b1 = await create_ticket(B, ticket({ title: "B one" }), "bob");
    const a2 = await create_ticket(A, ticket({ title: "A two" }), "alice");
    const b2 = await create_ticket(B, ticket({ title: "B two" }), "bob");
    expect([a1, a2]).toEqual([1, 2]);
    expect([b1, b2]).toEqual([1, 2]);
    // Four rows, four row ids — never handed out.
    expect(new Set([await rowId(ORG_A, 1), await rowId(ORG_B, 1), await rowId(ORG_A, 2), await rowId(ORG_B, 2)]).size).toBe(4);
    expect(await rowId(ORG_B, 2)).not.toBe(2); // B's #2 is not row 2 (that is B's #1): number and row id really differ here
    // The same number names a different ticket in each org.
    expect((await get_ticket(A, 1))!.title).toBe("A one");
    expect((await get_ticket(B, 1))!.title).toBe("B one");
    expect((await get_ticket(B, 2))!.title).toBe("B two");
    // A deleted number is not reissued, in the org that lost it only.
    expect((await delete_ticket(B, b2)).id).toBe(2);
    expect(await create_ticket(B, ticket({ title: "B three" }), "bob")).toBe(3);
    expect(await create_ticket(A, ticket({ title: "A three" }), "alice")).toBe(3);
    expect(await get_ticket(B, 2)).toBeNull();
    expect((await get_ticket(A, 2))!.title).toBe("A two"); // A's #2 was never B's to delete
  });

  it("a ticket and all its children are written under the writer's org", async () => {
    await create_ticket(A, ticket({ title: "A filler" }), "alice"); // so B's number is not its row id
    const b = await create_ticket(B, ticket({ title: "B", assignees: ["bob"], link: "https://example.com/spec" }), "bob");
    await add_ticket_comment(B, b, "hello", "bob");
    await transition_ticket(B, b, "in_progress", "bob");
    const row = await rowId(ORG_B, b);
    expect(row).not.toBe(b);
    for (const table of ["ticket_assignees", "ticket_links", "ticket_comments", "ticket_events"]) {
      const orgs = await orgOf(table, `ticket_id = ?`, row);
      expect(orgs.length).toBeGreaterThan(0);
      expect(new Set(orgs)).toEqual(new Set([ORG_B]));
    }
    // Nothing landed on A's #1 (the same NUMBER): it has its own opening row and nothing else.
    const aRow = await rowId(ORG_A, 1);
    for (const [table, n] of [["ticket_assignees", 0], ["ticket_links", 0], ["ticket_comments", 0], ["ticket_events", 1]] as const) {
      expect((await orgOf(table, `ticket_id = ?`, aRow)).length, table).toBe(n);
    }
    expect(await orgOf("tickets", `id = ?`, row)).toEqual([ORG_B]);
  });

  it("no writer reaches another org's ticket, and the refusal writes nothing", async () => {
    const b = await create_ticket(B, ticket({ title: "B", assignees: ["bob"], link: "https://example.com/spec" }), "bob");
    const link = (await first<{ id: number }>(env.DB, `SELECT id FROM ticket_links WHERE org_id = ?`, ORG_B))!.id;
    const snapshot = async () => ({
      row: await rowOf(ORG_B, b),
      assignees: await count("ticket_assignees", ORG_B),
      links: await count("ticket_links", ORG_B),
      comments: await count("ticket_comments", ORG_B),
      events: await count("ticket_events", ORG_B),
    });
    const before = await snapshot();

    await notFound(transition_ticket(A, b, "in_progress", "alice"));
    await notFound(move_ticket(A, b, "in_progress", null, "alice"));
    await notFound(toggle_assignee(A, b, "alice", true));
    await notFound(toggle_assignee(A, b, "bob", false));
    await notFound(add_ticket_link(A, b, "https://example.com/x", "alice"));
    await notFound(remove_ticket_link(A, b, link));
    await notFound(edit_ticket(A, b, { title: "taken" }, "alice"));
    await notFound(set_ticket_sprint(A, b, null));
    await notFound(add_ticket_comment(A, b, "hi", "alice"));
    await notFound(delete_ticket(A, b));
    // The MCP lane: bob IS an assignee, but not in A — 404 before any scope answer.
    await notFound(assertTicketWritable(A, e, b, "bob", "edit_ticket"));
    await notFound(assertTicketAssignable(A, e, b, "bob"));
    await notFound(agentAssignTicket(A, e, b, "alice", true, "bob"));

    expect(await snapshot()).toEqual(before);
    for (const table of ["tickets", "ticket_assignees", "ticket_links", "ticket_comments", "ticket_events"]) {
      expect(await count(table, ORG_A)).toBe(0);
    }
  });

  it("a link id from another org's ticket cannot be removed through one's own ticket", async () => {
    const a = await create_ticket(A, ticket({ title: "A" }), "alice");
    const b = await create_ticket(B, ticket({ title: "B", link: "https://example.com/spec" }), "bob");
    expect([a, b]).toEqual([1, 1]); // the same number in each org
    const link = (await first<{ id: number }>(env.DB, `SELECT id FROM ticket_links WHERE org_id = ?`, ORG_B))!.id;
    await notFound(remove_ticket_link(A, a, link));
    expect(await count("ticket_links", ORG_B)).toBe(1);
  });

  it("there is no cross-org edge to ask for: a number names one's own ticket or nothing; another org's sprint is not found", async () => {
    const a = await create_ticket(A, ticket({ title: "A parent" }), "alice");            // A #1
    await create_ticket(B, ticket({ title: "B one" }), "bob");                           // B #1
    const b = await create_ticket(B, ticket({ title: "B child" }), "bob");               // B #2 — no such number in A
    const aSprint = (await create_sprint(A, sprint("A sprint"), "alice")).id;

    await notFound(set_ticket_parent(A, a, b));   // A has no #2: B's ticket cannot be adopted
    await notFound(set_ticket_parent(A, b, a));
    await notFound(set_ticket_sprint(B, b, aSprint));
    await notFound(create_ticket(B, ticket({ title: "B in A's sprint", sprint_id: aSprint }), "bob"));
    // The same numbers inside B nest B's own tickets — and touch nothing of A's.
    await set_ticket_parent(B, 1, b);
    expect(await rowOf(ORG_B, b, "parent_id, sprint_id")).toEqual({ parent_id: await rowId(ORG_B, 1), sprint_id: null });
    expect(await rowOf(ORG_A, a, "parent_id, sprint_id")).toEqual({ parent_id: null, sprint_id: null });
    expect((await get_ticket(B, b))!.parent).toMatchObject({ id: 1, title: "B one" }); // the parent ref is B's NUMBER 1
    expect((await get_ticket(B, b))!.parent_id).toBe(1);
    expect(await count("tickets", ORG_B)).toBe(2);
  });

  it("a board drop reorders one org's column only, and names the card it lands after by number", async () => {
    const a1 = await create_ticket(A, ticket({ title: "A1" }), "alice");
    const a2 = await create_ticket(A, ticket({ title: "A2" }), "alice");
    const b1 = await create_ticket(B, ticket({ title: "B1" }), "bob");
    const rank = async (org: string, n: number) => (await rowOf<{ board_rank: number | null }>(org, n, "board_rank"))!.board_rank;
    await run(env.DB, `UPDATE tickets SET board_rank = 1 WHERE id IN (?, ?)`, await rowId(ORG_A, a2), await rowId(ORG_B, b1));
    // Dropping right after a2 collides with the next rank, so the column is renumbered — A's column.
    await run(env.DB, `UPDATE tickets SET board_rank = 2 WHERE id = ?`, await rowId(ORG_A, a1));
    const a3 = await create_ticket(A, ticket({ title: "A3" }), "alice");
    await move_ticket(A, a3, "submitted", a2, "alice");
    expect(await rank(ORG_B, b1)).toBe(1);                       // B's column was never renumbered
    expect(await rank(ORG_A, a3)).toBeGreaterThan((await rank(ORG_A, a2))!); // right after A2…
    expect(await rank(ORG_A, a3)).toBeLessThan((await rank(ORG_A, a1))!);    // …and before A1
    await move_ticket(A, a3, "submitted", 99, "alice"); // no such card in this column: lands on top
    expect(await rank(ORG_A, a3)).toBeLessThan((await rank(ORG_A, a2))!);
    expect(await rank(ORG_B, b1)).toBe(1);
    // The same drop in B moves B's card, by B's numbers.
    const b2 = await create_ticket(B, ticket({ title: "B2" }), "bob");
    await move_ticket(B, b2, "submitted", b1, "bob");
    expect(await rank(ORG_B, b2)).toBeGreaterThan((await rank(ORG_B, b1))!);
  });

  it("sub-tickets detach only inside the org when a parent is deleted", async () => {
    const aParent = await create_ticket(A, ticket({ title: "A parent" }), "alice");
    const aChild = await create_ticket(A, ticket({ title: "A child" }), "alice");
    await set_ticket_parent(A, aParent, aChild);
    const bParent = await create_ticket(B, ticket({ title: "B parent" }), "bob");
    const bChild = await create_ticket(B, ticket({ title: "B child" }), "bob");
    await set_ticket_parent(B, bParent, bChild);
    expect([aParent, aChild, bParent, bChild]).toEqual([1, 2, 1, 2]);

    expect((await delete_ticket(A, aParent)).detached).toBe(1);
    expect((await rowOf<{ parent_id: number | null }>(ORG_A, aChild, "parent_id"))!.parent_id).toBeNull();
    expect((await rowOf<{ parent_id: number | null }>(ORG_B, bChild, "parent_id"))!.parent_id).toBe(await rowId(ORG_B, bParent));
    expect((await get_ticket(B, bChild))!.parent_id).toBe(1); // …which the wire shows as B's number
    expect(await get_ticket(B, bParent)).not.toBeNull();
  });

  it("a bare issue ref resolves against the org's OWN primary repository — and with none connected it is refused, never pointed at another org's", async () => {
    await run(env.DB, `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, created_at, created_by) VALUES ('hook_a_app', ?, 'a-org/app', 1, 't', 'test')`, ORG_A);
    const a = await create_ticket(A, ticket({ title: "A", link: "#214" }), "alice");
    expect((await get_ticket(A, a))!.links.map((l) => l.url)).toEqual(["https://github.com/a-org/app/issues/214"]);
    // B has connected nothing: no default repository, and certainly not A's.
    const refused = await create_ticket(B, ticket({ title: "B", link: "#214" }), "bob").then(() => null, (x: unknown) => x);
    expect(refused).toMatchObject({ code: "bad_request", message: expect.stringContaining("connect one in Org settings › Repositories") });
    expect(await count("tickets", ORG_B)).toBe(0); // refused before the first insert
    const b = await create_ticket(B, ticket({ title: "B" }), "bob");
    await expect(add_ticket_link(B, b, "214", "bob")).rejects.toMatchObject({ code: "bad_request" });
    const bSprint = (await create_sprint(B, sprint("B sprint"), "bob")).id;
    await expect(add_sprint_resource(B, bSprint, "#7")).rejects.toMatchObject({ code: "bad_request" });
    // A full URL needs no repository.
    await add_ticket_link(B, b, "https://github.com/b-org/site/pull/3", "bob");
    expect((await get_ticket(B, b))!.links.map((l) => l.label)).toEqual(["site #3"]);
    expect(await all(env.DB, `SELECT url FROM ticket_links WHERE org_id = ? AND url LIKE '%a-org%'`, ORG_B)).toEqual([]);
  });

  it("the GitHub mirror keys an issue per org", async () => {
    const payload = {
      action: "opened",
      repository: { full_name: "o/r" },
      issue: { number: 5, title: "Mirrored", body: "", html_url: "https://github.com/o/r/issues/5", state: "open", updated_at: "2026-09-10T15:00:00Z", user: { login: "ghost" }, assignees: [], labels: [] },
    };
    expect(await mirrorIssue(A, platformCtx(), "o/r", payload)).toBe("created");
    expect(await mirrorIssue(B, platformCtx(), "o/r", payload)).toBe("created");
    expect(await mirrorIssue(B, platformCtx(), "o/r", payload)).toBe("unchanged");
    expect(await count("tickets", ORG_A)).toBe(1);
    expect(await count("tickets", ORG_B)).toBe(1);
    for (const table of ["ticket_links", "ticket_events"]) {
      expect(await count(table, ORG_A)).toBe(1);
      expect(await count(table, ORG_B)).toBe(1);
    }
    // A closing delivery to B leaves A's ticket open.
    await mirrorIssue(B, platformCtx(), "o/r", { ...payload, action: "closed", issue: { ...payload.issue, state: "closed", state_reason: "completed", updated_at: "2026-09-11T15:00:00Z" } });
    expect((await all<{ org_id: string; status: string }>(env.DB, `SELECT org_id, status FROM tickets ORDER BY org_id`)).map((t) => `${t.org_id}:${t.status}`))
      .toEqual([`${ORG_B}:done`, `${ORG_A}:submitted`]);
  });
});

describe("sprints", () => {
  it("a sprint, its resources and its progress are one org's", async () => {
    const a = (await create_sprint(A, sprint("A sprint"), "alice")).id;
    const b = (await create_sprint(B, sprint("B sprint"), "bob")).id;
    await add_sprint_resource(B, b, "https://example.com/b");
    await create_ticket(B, ticket({ title: "B in sprint", assignees: ["bob"], sprint_id: b }), "bob");
    await upsertProgress(B, b, 1, 2, "event");

    expect((await list_sprints(A)).map((s) => s.id)).toEqual([a]);
    expect((await list_sprints(B)).map((s) => s.id)).toEqual([b]);
    expect(await get_sprint(A, b)).toBeNull();
    const detail = (await get_sprint(B, b))!;
    expect(detail.tickets).toHaveLength(1);
    expect(detail.resources.map((r) => r.url)).toEqual(["https://example.com/b"]);
    expect(detail.members).toEqual(["bob"]);
    expect(detail.issues).toEqual({ closed: 1, total: 2 });

    expect([...(await ticketCountsBySprint(A)).keys()]).toEqual([]);
    expect([...(await ticketCountsBySprint(A, [a, b])).keys()]).toEqual([]);
    expect([...(await ticketCountsBySprint(B, [a, b])).keys()]).toEqual([b]);
    expect([...(await getProgress(A)).keys()]).toEqual([]);
    expect([...(await getProgress(B)).keys()]).toEqual([b]);
    expect(await orgOf("sprint_resources", `sprint_id = ?`, b)).toEqual([ORG_B]);
    expect(await orgOf("sprint_progress", `sprint_id = ?`, b)).toEqual([ORG_B]);
  });

  it("no writer reaches another org's sprint, and the refusal writes nothing", async () => {
    const b = (await create_sprint(B, sprint("B sprint"), "bob")).id;
    const bTicket = await create_ticket(B, ticket({ title: "B in sprint", sprint_id: b }), "bob");
    await upsertProgress(B, b, 1, 2, "event");

    await notFound(set_sprint_active(A, b, true));
    await notFound(complete_sprint(A, b));
    await notFound(add_sprint_resource(A, b, "https://example.com/a"));
    await notFound(delete_sprint(A, b));
    // The progress cache is keyed by sprint id alone: another org's write must not land on B's row.
    await upsertProgress(A, b, 9, 9, "recompute");

    expect(await first(env.DB, `SELECT status FROM sprints WHERE id = ?`, b)).toEqual({ status: "upcoming" });
    expect(await count("sprint_resources", ORG_B)).toBe(0);
    expect(await first(env.DB, `SELECT org_id, closed, total, source FROM sprint_progress WHERE sprint_id = ?`, b))
      .toEqual({ org_id: ORG_B, closed: 1, total: 2, source: "event" });
    expect((await first<{ sprint_id: number | null }>(env.DB, `SELECT sprint_id FROM tickets WHERE id = ?`, bTicket))!.sprint_id).toBe(b);
  });

  it("an issue event moves only its own org's sprint progress", async () => {
    await write_plan(A, { narrative: "", sprints: [{ label: "A", due: "", status: "upcoming", github_ref: [7] }] }, "alice");
    await write_plan(B, { narrative: "", sprints: [{ label: "B", due: "", status: "upcoming", github_ref: [7] }] }, "bob");
    await run(env.DB, `INSERT INTO events (org_id, repo, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
                       VALUES (?, 'o/r', 'gh:issue:7:closed:t', 'issue', 7, 'x', ?, 'webhook', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z', 'github-webhook')`,
      ORG_A, JSON.stringify({ action: "closed", issue: { number: 7, state: "closed" } }));

    await applyEventProgress(A, { action: "closed", issue: { number: 7, state: "closed" } });
    expect([...(await getProgress(A)).values()].map((p) => [p.closed, p.total])).toEqual([[1, 1]]);
    expect((await getProgress(B)).size).toBe(0);

    // B has captured no snapshot of issue 7: its count reads its OWN events, not A's.
    await applyEventProgress(B, { action: "closed", issue: { number: 7, state: "closed" } });
    expect([...(await getProgress(B)).values()].map((p) => [p.closed, p.total])).toEqual([[0, 1]]);
  });
});

// From the mutation spot check: these predicates survived while the two orgs never shared a group number,
// and while no plan write named another org's sprint.
describe("shared GitHub group numbers and foreign sprint ids", () => {
  it("a group-number event moves only its own org's sprint, though both orgs claim that number", async () => {
    await write_plan(A, { narrative: "", sprints: [{ label: "A", due: "", status: "upcoming", github_ref: 3 }] }, "alice");
    await write_plan(B, { narrative: "", sprints: [{ label: "B", due: "", status: "upcoming", github_ref: 3 }] }, "bob");
    const payload = { action: "closed", issue: { number: 41, state: "closed", milestone: { number: 3, open_issues: 1, closed_issues: 4 } } };
    await applyEventProgress(A, payload);
    expect([...(await getProgress(A)).values()].map((p) => [p.closed, p.total])).toEqual([[4, 5]]);
    expect((await getProgress(B)).size).toBe(0);
    expect(await count("sprint_progress", ORG_B)).toBe(0);
  });

  it("a plan write cannot edit another org's sprint by naming its id", async () => {
    const b = (await create_sprint(B, sprint("B sprint"), "bob")).id;
    await expect(write_plan(A, { narrative: "x", sprints: [{ id: b, label: "Hijacked", due: "", status: "done" }] }, "alice")).rejects.toThrow(`no such sprint: ${b}`);
    expect(await first(env.DB, `SELECT org_id, title, status FROM sprints WHERE id = ?`, b)).toMatchObject({ org_id: ORG_B, title: "B sprint" });
    expect(await count("sprints", ORG_A)).toBe(0);
  });

  it("My Work is a MEMBER's: a person who is only in B has no projection in A — not even their name", async () => {
    await run(env.DB, `INSERT OR IGNORE INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('github', 'bob-gh', 'bob-gh', 'bob', 't', 'seed')`);
    await run(env.DB, `INSERT INTO events (org_id, repo, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
                       VALUES (?, 'o/r', 'gh:pr:9:merged', 'pr_merged', 9, 'bob-gh', ?, 'webhook', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z', 'github-webhook')`,
      ORG_A, JSON.stringify({ action: "closed", pr: { number: 9, title: "PR 9", html_url: "https://github.com/o/r/pull/9", merged: true, merged_at: "2026-09-10T00:00:00Z", user: { login: "bob-gh" } } }));
    const inA = await getMyWork(A, "bob");
    expect(inA).toMatchObject({ person: null, previousActivity: [], todo: [], tickets: [], degraded: false });
    // Once bob joins A, the same event is his there.
    await ensureMember("bob", "member", ORG_A);
    const joined = await getMyWork(A, "bob");
    expect(joined).toMatchObject({ degraded: false, person: "bob" });
    expect(joined.previousActivity.length).toBe(1);
  });
});

describe("My Work when both orgs captured the same PR key and claim the same group number", () => {
  it("a PR card carries THIS org's summary, and an issue THIS org's sprint", async () => {
    await run(env.DB, `INSERT OR IGNORE INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('github', 'carol-gh', 'carol-gh', 'carol', 't', 'seed')`);
    await write_plan(B, { narrative: "", sprints: [{ label: "B sprint", due: "", status: "upcoming", github_ref: 5 }] }, "bob"); // B first: the lower sprint id
    await write_plan(A, { narrative: "", sprints: [{ label: "A sprint", due: "", status: "upcoming", github_ref: 5 }] }, "alice");
    const pr = JSON.stringify({ action: "closed", pr: { number: 9, title: "PR 9", html_url: "https://github.com/o/r/pull/9", merged: true, merged_at: "2026-09-10T00:00:00Z", user: { login: "carol-gh" } } });
    const issue = JSON.stringify({ action: "assigned", issue: { number: 12, title: "Issue 12", html_url: "https://github.com/o/r/issues/12", state: "open", updated_at: "2026-09-10T00:00:00Z",
      user: { login: "carol-gh" }, assignees: [{ login: "carol-gh" }], labels: [], milestone: { number: 5, title: "GH group", open_issues: 1, closed_issues: 0 } } });
    for (const [org, title] of [[ORG_B, "B's summary"], [ORG_A, "A's summary"]] as const) {
      await run(env.DB, `INSERT INTO events (org_id, repo, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
                         VALUES (?, 'o/r', 'gh:pr:9:merged', 'pr_merged', 9, 'carol-gh', ?, 'webhook', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z', 'github-webhook'),
                                (?, 'o/r', 'gh:issue:12:assigned:t', 'issue', 12, 'carol-gh', ?, 'webhook', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z', 'github-webhook')`, org, pr, org, issue);
      await run(env.DB, `INSERT INTO pr_summaries (org_id, repo, semantic_key, pr_number, model, created_at, title, what, why, impact) VALUES (?, 'o/r', 'gh:pr:9:merged', 9, 'm', 't', ?, 'w', 'y', 'i')`, org, title);
    }
    for (const [ctx, summary, label] of [[A, "A's summary", "A sprint"], [B, "B's summary", "B sprint"]] as const) {
      const mine = await getMyWork(ctx, "carol");
      expect(mine.degraded).toBe(false);
      expect(mine.previousActivity.map((p) => [p.number, p.displayTitle])).toEqual([[9, summary]]);
      expect(mine.todo.map((t) => [t.number, t.sprint?.title])).toEqual([[12, label]]);
    }
  });
});

describe("the plan", () => {
  it("each org has its own narrative, versions and sprints", async () => {
    await write_plan(A, { narrative: "A's plan", sprints: [{ label: "A sprint", due: "", status: "upcoming" }] }, "alice");
    const b = await write_plan(B, { narrative: "B's plan", sprints: [{ label: "B sprint", due: "", status: "in_progress" }] }, "bob");
    expect(b.version).toBe(1);
    expect(b.sprints.map((s) => s.title)).toEqual(["B sprint"]);

    const planA = await get_plan(A);
    const planB = await get_plan(B);
    expect([planA.narrative, planA.version, planA.sprints.map((s) => s.label)]).toEqual(["A's plan", 1, ["A sprint"]]);
    expect([planB.narrative, planB.version, planB.sprints.map((s) => s.label)]).toEqual(["B's plan", 1, ["B sprint"]]);
    expect(await all(env.DB, `SELECT org_id, version FROM plan_versions ORDER BY org_id`)).toEqual([
      { org_id: ORG_B, version: 1 }, { org_id: ORG_A, version: 1 },
    ]);
    expect(JSON.parse((await first<{ sprints_json: string }>(env.DB, `SELECT sprints_json FROM plan_versions WHERE org_id = ?`, ORG_A))!.sprints_json)).toHaveLength(1);
  });

  it("a plan write cannot name another org's sprint, and writes nothing when it tries", async () => {
    const b = (await create_sprint(B, sprint("B sprint"), "bob")).id;
    await expect(write_plan(A, { narrative: "stolen", sprints: [{ id: b, label: "renamed", due: "", status: "done" }] }, "alice"))
      .rejects.toThrow(/no such sprint/);
    expect(await first(env.DB, `SELECT title, status FROM sprints WHERE id = ?`, b)).toEqual({ title: "B sprint", status: "upcoming" });
    expect((await get_plan(A)).version).toBe(0);
    expect(await count("plan_versions", ORG_A)).toBe(0);
  });
});

describe("a sprint's lead is a member of the sprint's org", () => {
  it("create_sprint: a non-member, another org's member, an unknown and a reserved handle are bad_request and write nothing; a member is stored by canonical handle", async () => {
    for (const lead of ["bob" /* B only */, "nobody-at-all", "github-webhook"]) {
      await expect(create_sprint(A, SprintCreate.parse({ label: `led by ${lead}`, lead }), "alice")).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(await count("sprints", ORG_A)).toBe(0);
    expect((await create_sprint(A, SprintCreate.parse({ label: "A's", lead: "@ALICE" }), "alice")).lead).toBe("alice");
    expect((await create_sprint(B, SprintCreate.parse({ label: "B's", lead: "bob" }), "bob")).lead).toBe("bob");
    expect((await create_sprint(B, SprintCreate.parse({ label: "B's, nobody leading", lead: "  " }), "bob")).lead).toBeNull();
    expect((await create_sprint(B, SprintCreate.parse({ label: "B's, no lead given" }), "bob")).lead).toBeNull();
    await expect(create_sprint(B, SprintCreate.parse({ label: "B's, led from A", lead: "alice" }), "bob")).rejects.toMatchObject({ code: "bad_request" });
  });

  it("the plan write checks every lead before it writes anything: one bad lead refuses the whole plan", async () => {
    const before = await get_plan(A);
    await expect(write_plan(A, { narrative: "n", sprints: [
      { label: "ok", due: "2026-12-01", status: "upcoming", lead: "alice" },
      { label: "not ours", due: "2026-12-02", status: "upcoming", lead: "bob" },
    ] }, "alice")).rejects.toMatchObject({ code: "bad_request" });
    expect(await count("sprints", ORG_A)).toBe(0);
    expect((await get_plan(A)).narrative).toBe(before.narrative);
    const { sprints } = await write_plan(A, { narrative: "n", sprints: [{ label: "ok", due: "2026-12-01", status: "upcoming", lead: "Alice" }] }, "alice");
    expect(sprints.map((s) => s.lead)).toEqual(["alice"]);
    // Omitted = unchanged, null = cleared, a non-member = refused with the stored lead left alone.
    const id = sprints[0].id;
    await write_plan(A, { narrative: "n", sprints: [{ id, label: "ok", due: "2026-12-01", status: "upcoming" }] }, "alice");
    expect((await first<{ lead: string | null }>(env.DB, `SELECT lead FROM sprints WHERE id = ?`, id))!.lead).toBe("alice");
    await expect(write_plan(A, { narrative: "n", sprints: [{ id, label: "ok", due: "2026-12-01", status: "upcoming", lead: "bob" }] }, "alice")).rejects.toMatchObject({ code: "bad_request" });
    expect((await first<{ lead: string | null }>(env.DB, `SELECT lead FROM sprints WHERE id = ?`, id))!.lead).toBe("alice");
    await write_plan(A, { narrative: "n", sprints: [{ id, label: "ok", due: "2026-12-01", status: "upcoming", lead: null }] }, "alice");
    expect((await first<{ lead: string | null }>(env.DB, `SELECT lead FROM sprints WHERE id = ?`, id))!.lead).toBeNull();
  });

  it("over HTTP a lead who is not a member is a 400 that names the handle, and no sprint is created", async () => {
    const r = await app.request("/api/o/saplinglearn/sprints", { method: "POST", headers: { cookie: await cookieFor("alice"), "content-type": "application/json" }, body: JSON.stringify({ label: "x", lead: "bob" }) }, env);
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toContain("bob");
    expect(await count("sprints", ORG_A)).toBe(0);
  });
});

describe("My Work", () => {
  it("lists the caller's assignments in this org only, with the per-org number", async () => {
    const a = await create_ticket(A, ticket({ title: "Carol in A", assignees: ["carol"] }), "alice");
    await create_ticket(B, ticket({ title: "Filler" }), "bob");
    const bSprint = (await create_sprint(B, sprint("B sprint"), "bob")).id;
    const b = await create_ticket(B, ticket({ title: "Carol in B", assignees: ["carol"], sprint_id: bSprint }), "bob");

    const inA = await getMyWork(A, "carol");
    const inB = await getMyWork(B, "carol");
    // `create_ticket` returns — and My Work lists — the per-org NUMBER: A's first, B's second (never the row id).
    expect([a, b]).toEqual([1, 2]);
    expect(inA.tickets.map((t) => [t.id, t.title])).toEqual([[1, "Carol in A"]]);
    expect(inB.tickets.map((t) => [t.id, t.title, t.sprint?.label])).toEqual([[2, "Carol in B", "B sprint"]]);
    expect([inA.ticketsTotal, inB.ticketsTotal]).toEqual([1, 1]);
    expect(await listAssignedTickets(A, "bob", { sources: "all" })).toEqual([]);
    expect(await countAssignedTickets(B, "carol", "all")).toBe(1);
  });

  it("the captured-event log is one org's", async () => {
    for (const org of [ORG_A, ORG_B]) {
      await run(env.DB, `INSERT INTO events (org_id, repo, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
                         VALUES (?, 'o/r', ?, 'pr_merged', 1, 'carol', '{}', 'webhook', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z', 'github-webhook')`,
        org, `gh:pr:1:merged:${org}`);
    }
    expect((await list_events(A)).map((ev) => ev.semantic_key)).toEqual([`gh:pr:1:merged:${ORG_A}`]);
    expect((await list_events(B, { subject: "carol" })).map((ev) => ev.semantic_key)).toEqual([`gh:pr:1:merged:${ORG_B}`]);
  });
});

describe("notifications", () => {
  const FRI = new Date("2026-09-11T12:00:00.000Z");
  const always: NotificationKind<TenantContext> = {
    id: "always", label: "Always", description: "x", defaultCadence: "daily", allowedCadences: ["daily", "off"],
    render: async (ctx) => ({ heading: "Always", summary: `for ${ctx.orgId}`, html: `<p>${ctx.orgId}</p>`, text: ctx.orgId, deepLink: "/#x", linkLabel: "X" }),
  };
  const outbox = () => all<NotificationOutboxRow & { org_id: string }>(env.DB, `SELECT * FROM notification_outbox ORDER BY idempotency_key`);
  const email = (handle: string, address: string | null) => run(env.DB, `UPDATE persons SET email = ?, email_unsubscribed = 0 WHERE handle = ?`, address, handle);

  it("policy, settings and prefs are read and seeded per org", async () => {
    expect((await seedNotificationPolicy(B)).inserted.length).toBeGreaterThan(0);
    expect((await loadPolicies(A)).size).toBe(0);
    expect((await loadPolicies(B)).size).toBeGreaterThan(0);
    await run(env.DB, `UPDATE notification_policy SET enabled = 0 WHERE org_id = ? AND kind = 'ticketq'`, ORG_B);
    expect(await resolveCadence(B, "carol", "ticketq")).toBe("off");
    expect(await resolveCadence(A, "carol", "ticketq")).toBe("daily");

    await run(env.DB, `INSERT INTO notification_prefs (org_id, user_id, kind, cadence, updated_at) VALUES (?, 'carol', 'my_work', 'weekly', 't')`, ORG_B);
    expect([...(await loadPrefs(B, "carol"))]).toEqual([["my_work", "weekly"]]);
    expect((await loadPrefs(A, "carol")).size).toBe(0);

    await run(env.DB, `INSERT INTO notification_settings (org_id, send_hour, timezone, from_address) VALUES (?, 17, 'Europe/Madrid', 'Acme <a@acme.test>')`, ORG_B);
    expect(await loadSettings(B)).toEqual({ org_id: ORG_B, send_hour: 17, timezone: "Europe/Madrid", from_address: "Acme <a@acme.test>" });
    expect(await loadSettings(A)).toMatchObject({ org_id: ORG_A, send_hour: 8, timezone: "America/New_York" });
  });

  it("an org with no settings row runs on the defaults, under its own id", async () => {
    expect(await loadSettings(B)).toMatchObject({ org_id: ORG_B, send_hour: 8, timezone: "America/New_York" });
  });

  it("the settings, policy, prefs and outbox routes write and read the caller's org", async () => {
    // An admin whose ONE org is B.
    const cookie = await cookieFor("admin-user", { member: false, email: "admin@acme.test" });
    await ensureMember("admin-user", "admin", ORG_B);
    const put = (path: string, body: unknown) =>
      app.request(`/api/notifications/${path}`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, env);

    expect((await put("settings", { send_hour: 5 })).status).toBe(200);
    expect((await put("policy", { kind: "ticketq", enabled: false })).status).toBe(200);
    expect((await put("prefs", { prefs: { my_work: "weekly" } })).status).toBe(200);

    expect(await all(env.DB, `SELECT org_id, send_hour FROM notification_settings ORDER BY org_id`)).toEqual([
      { org_id: ORG_B, send_hour: 5 }, { org_id: ORG_A, send_hour: 8 },
    ]);
    expect(await all(env.DB, `SELECT org_id, kind, enabled FROM notification_policy`)).toEqual([{ org_id: ORG_B, kind: "ticketq", enabled: 0 }]);
    expect(await all(env.DB, `SELECT org_id, user_id, kind, cadence FROM notification_prefs`)).toEqual([
      { org_id: ORG_B, user_id: "admin-user", kind: "my_work", cadence: "weekly" },
    ]);

    // A's outbox row is not in B's admin list, and B's prefs reset does not touch A's pref row.
    await run(env.DB, `INSERT INTO notification_outbox (org_id, idempotency_key, user_id, cadence, window_id, kinds, status, created_at) VALUES (?, 'a-row', 'alice', 'daily', 'w', '[]', 'sent', 't')`, ORG_A);
    await run(env.DB, `INSERT INTO notification_outbox (org_id, idempotency_key, user_id, cadence, window_id, kinds, status, created_at) VALUES (?, 'b-row', 'bob', 'daily', 'w', '[]', 'sent', 't')`, ORG_B);
    const listed = (await (await app.request("/api/notifications/outbox", { headers: { cookie } }, env)).json()) as { rows: NotificationOutboxRow[] };
    expect(listed.rows.map((r) => r.idempotency_key)).toEqual(["b-row"]);

    await run(env.DB, `INSERT INTO notification_prefs (org_id, user_id, kind, cadence, updated_at) VALUES (?, 'admin-user', 'my_work', 'daily', 't')`, ORG_A);
    expect((await put("prefs", { prefs: { my_work: null } })).status).toBe(200);
    expect(await all(env.DB, `SELECT org_id, cadence FROM notification_prefs`)).toEqual([{ org_id: ORG_A, cadence: "daily" }]);
  });

  it("a digest run mails one org's members, keyed and stored under that org", async () => {
    await email("alice", "alice@a.test");
    await email("bob", "bob@b.test");
    await email("carol", "carol@both.test");

    const reportB = await runDigest(B, platformCtx(), "daily", FRI, { delivery: localDelivery(B), registry: [always] });
    expect(reportB).toMatchObject({ eligible: 2, sent: 2 });
    let rows = await outbox();
    expect(rows.map((r) => [r.org_id, r.idempotency_key])).toEqual([
      [ORG_B, `${ORG_B}:bob:daily:2026-09-11`], [ORG_B, `${ORG_B}:carol:daily:2026-09-11`],
    ]);

    // The same window in A: carol, a member of both, gets one digest per org; the re-run in B adds nothing.
    const reportA = await runDigest(A, platformCtx(), "daily", FRI, { delivery: localDelivery(A), registry: [always] });
    expect(reportA.sent).toBe(reportA.eligible);
    expect((await runDigest(B, platformCtx(), "daily", FRI, { delivery: localDelivery(B), registry: [always] })).alreadyRan).toBe(2);
    rows = await outbox();
    expect(rows.filter((r) => r.user_id === "carol").map((r) => r.org_id).sort()).toEqual([ORG_B, ORG_A].sort());
    expect(rows.some((r) => r.org_id === ORG_A && r.user_id === "bob")).toBe(false);
    expect(rows.some((r) => r.org_id === ORG_B && r.user_id === "alice")).toBe(false);

    const bodies = await all<{ org_id: string; idempotency_key: string; text: string }>(env.DB, `SELECT org_id, idempotency_key, text FROM notification_outbox_bodies`);
    expect(bodies).toHaveLength(rows.length);
    for (const body of bodies) {
      expect(body.idempotency_key.startsWith(`${body.org_id}:`)).toBe(true);
      expect(body.text).toContain(body.org_id);
    }
  });

  it("an org's prefs and policy decide only its own digest", async () => {
    await email("carol", "carol@both.test");
    await run(env.DB, `INSERT INTO notification_prefs (org_id, user_id, kind, cadence, updated_at) VALUES (?, 'carol', 'always', 'off', 't')`, ORG_A);
    await runDigest(A, platformCtx(), "daily", FRI, { delivery: localDelivery(A), registry: [always] });
    await runDigest(B, platformCtx(), "daily", FRI, { delivery: localDelivery(B), registry: [always] });
    const carol = (await outbox()).filter((r) => r.user_id === "carol");
    expect(carol.map((r) => [r.org_id, r.status]).sort()).toEqual([[ORG_B, "sent"], [ORG_A, "skipped"]].sort());
  });

  it("the retry job re-sends only its own org's failed rows", async () => {
    await email("carol", "carol@both.test");
    for (const org of [ORG_A, ORG_B]) {
      await run(env.DB, `INSERT INTO notification_outbox (org_id, idempotency_key, user_id, cadence, window_id, kinds, status, error, created_at)
                         VALUES (?, ?, 'carol', 'daily', '2026-09-11', '[]', 'failed', 'send: boom', ?)`, org, `${org}:carol:daily:2026-09-11`, new Date().toISOString());
    }
    const report = await retryFailed(A, platformCtx(), { delivery: localDelivery(A), origin: "" });
    expect(report.retried).toBe(1);
    expect((await outbox()).map((r) => [r.org_id, r.status]).sort()).toEqual([[ORG_B, "failed"], [ORG_A, "skipped"]].sort());

    // A person who has left the org is not retried there.
    await run(env.DB, `DELETE FROM memberships WHERE org_id = ? AND user_id = 'carol'`, ORG_B);
    expect((await retryFailed(B, platformCtx(), { delivery: localDelivery(B), origin: "" })).retried).toBe(0);
  });

  it("the unsubscribe is global: one flag stops every org's digest", async () => {
    await email("carol", "carol@both.test");
    await run(env.DB, `UPDATE persons SET email_unsubscribed = 1 WHERE handle = 'carol'`);
    await runDigest(A, platformCtx(), "daily", FRI, { delivery: localDelivery(A), registry: [always] });
    await runDigest(B, platformCtx(), "daily", FRI, { delivery: localDelivery(B), registry: [always] });
    expect((await outbox()).filter((r) => r.user_id === "carol")).toEqual([]);
  });
});
