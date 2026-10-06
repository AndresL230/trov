import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { all, first, run, nowIso } from "./helpers/db";
import type { TicketDetail, TicketListItem, TicketStatus } from "@shared/tickets";
import { TICKET_STATUSES, TICKET_TRANSITIONS, boardOrder } from "@shared/tickets";
import { cookieFor, seedPerson } from "./helpers/persons";
import { addOrgRepo } from "./helpers/org-config";

// A bare issue ref (`#214`) resolves against the ORG's primary repository — there is no default one —
// so the suite's org has SaplingLearn's connected, as 0037 seeds it in production.
beforeEach(async () => { await addOrgRepo("SaplingLearn/sapling"); });

// ── harness ──────────────────────────────────────────────────────────────────

const post = (path: string, cookie: string, body?: unknown) =>
  app.request(
    path,
    { method: "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    env
  );
const get = (path: string, cookie: string) => app.request(path, { headers: { cookie } }, env);
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

interface WriteEnvelope { ok: true; ticket: TicketDetail }

/** File a ticket through the REAL route and return its detail DTO. */
async function createTicket(cookie: string, body: Record<string, unknown>): Promise<TicketDetail> {
  const res = await post("/tickets", cookie, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<WriteEnvelope>(res)).ticket;
}

/** A live sprint to move tickets into (0025 renamed the table; nothing else needs it here). */
async function seedSprint(title: string): Promise<number> {
  const now = nowIso();
  const res = await run(
    env.DB,
    `INSERT INTO sprints (title, target_date, status, created_at, created_by, updated_at) VALUES (?, '2026-09-01', 'in_progress', ?, 'andres', ?)`,
    title, now, now
  );
  return res.meta.last_row_id as number;
}

const eventsOf = (id: number) =>
  all<{ actor: string; from_status: string | null; to_status: string }>(
    env.DB, `SELECT actor, from_status, to_status FROM ticket_events WHERE ticket_id = ? ORDER BY id ASC`, id
  );

/** Force a ticket into a status WITHOUT the route, so the transition tests can
 *  start from each of the four statuses without depending on the route under test. */
const forceStatus = (id: number, status: TicketStatus) =>
  run(env.DB, `UPDATE tickets SET status = ? WHERE id = ?`, status, id);

// ── POST /tickets ────────────────────────────────────────────────────────────

describe("POST /tickets", () => {
  it("creates a ticket with the defaults, the opening event row, and requester = the principal", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "Gradebook export is empty" });

    expect(t.title).toBe("Gradebook export is empty");
    expect(t.body).toBe("");
    expect(t.category).toBe("other");
    expect(t.priority).toBe("normal");
    expect(t.status).toBe("submitted");
    expect(t.requester).toBe("andres");
    expect(t.parent_id).toBeNull();
    expect(t.sprint_id).toBeNull();
    expect(t.assignees).toEqual([]);
    expect(t.links).toEqual([]);
    expect(t.comments).toEqual([]);
    expect(t.children).toEqual([]);
    expect(t.parent).toBeNull();
    expect(t.sprint).toBeNull();

    // The OPENING history row: from_status NULL → 'submitted' ("opened this ticket").
    expect(t.events.length).toBe(1);
    expect(t.events[0]).toMatchObject({ actor: "andres", from_status: null, to_status: "submitted" });
  });

  it("IGNORES a client-supplied requester — the author is always the authenticated principal", async () => {
    const cookie = await cookieFor("andres");
    await seedPerson("someone-else");
    const t = await createTicket(cookie, { title: "Spoofed", requester: "someone-else", author: "someone-else" });
    expect(t.requester).toBe("andres");
    expect(t.events[0].actor).toBe("andres");
  });

  it("stores body, category, priority, assignees, sprint and a parsed link", async () => {
    const cookie = await cookieFor("andres");
    await seedPerson("meilin");
    const sprint = await seedSprint("Token rotation");

    const t = await createTicket(cookie, {
      title: "Add a lesson duration field",
      body: "Teachers keep planning lessons that run long.",
      category: "request",
      priority: "high",
      assignees: ["meilin", "andres"],
      sprint_id: sprint,
      link: "#214",
    });

    expect(t.body).toBe("Teachers keep planning lessons that run long.");
    expect(t.category).toBe("request");
    expect(t.priority).toBe("high");
    expect(t.assignees).toEqual(["andres", "meilin"]); // sorted by handle
    expect(t.sprint).toEqual({ id: sprint, label: "Token rotation" });
    // The bare issue ref went through the SHARED parser, not a second copy of it.
    expect(t.links.length).toBe(1);
    expect(t.links[0]).toMatchObject({
      url: "https://github.com/SaplingLearn/sapling/issues/214",
      kind: "github",
      label: "sapling #214",
      meta: "GITHUB · ISSUE",
      created_by: "andres",
    });
  });

  it("400s on a missing/empty title and writes nothing", async () => {
    const cookie = await cookieFor("andres");
    for (const body of [{}, { title: "" }, { title: "ok", category: "not-a-category" }]) {
      const res = await post("/tickets", cookie, body);
      expect(res.status).toBe(400);
      expect(await json<{ error: string; issues: unknown[] }>(res)).toMatchObject({ error: "invalid payload" });
    }
    expect((await all(env.DB, `SELECT id FROM tickets`)).length).toBe(0);
  });

  it("400s on an unknown assignee handle and 404s on an unknown sprint — no half-built ticket", async () => {
    const cookie = await cookieFor("andres");

    const badAsg = await post("/tickets", cookie, { title: "T", assignees: ["ghost"] });
    expect(badAsg.status).toBe(400);

    const badSprint = await post("/tickets", cookie, { title: "T", sprint_id: 9999 });
    expect(badSprint.status).toBe(404);

    // Validation runs BEFORE the first insert, so nothing landed.
    expect((await all(env.DB, `SELECT id FROM tickets`)).length).toBe(0);
  });

  it("400s on a link that must never be dereferenced (javascript:) and writes nothing", async () => {
    const cookie = await cookieFor("andres");
    const res = await post("/tickets", cookie, { title: "T", link: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    expect((await all(env.DB, `SELECT id FROM tickets`)).length).toBe(0);
  });
});

// ── GET /tickets (the queue) ─────────────────────────────────────────────────

describe("GET /tickets", () => {
  /** Five tickets spanning every status, category and assignment shape. */
  async function seedQueue(cookie: string) {
    await seedPerson("meilin");
    const sprint = await seedSprint("Structured summaries");

    const submittedUnassigned = await createTicket(cookie, { title: "Report builder times out", category: "bug" });
    const inProgressMine = await createTicket(cookie, { title: "SSO login loops", category: "bug", assignees: ["andres"], sprint_id: sprint });
    const inProgressOther = await createTicket(cookie, { title: "Lesson duration field", category: "request", assignees: ["meilin"] });
    const done = await createTicket(cookie, { title: "Digest arrived twice", category: "question", assignees: ["meilin"] });
    const declined = await createTicket(cookie, { title: "Bulk-archive classrooms", category: "request" });

    await forceStatus(inProgressMine.id, "in_progress");
    await forceStatus(inProgressOther.id, "in_progress");
    await forceStatus(done.id, "done");
    await forceStatus(declined.id, "declined");
    return { submittedUnassigned, inProgressMine, inProgressOther, done, declined, sprint };
  }

  const list = async (cookie: string, qs = ""): Promise<TicketListItem[]> =>
    (await json<{ tickets: TicketListItem[] }>(await get(`/tickets${qs}`, cookie))).tickets;

  it("seg: open = submitted + in_progress, closed = done + declined, all = everything", async () => {
    const cookie = await cookieFor("andres");
    const q = await seedQueue(cookie);

    const open = await list(cookie, "?seg=open");
    expect(new Set(open.map((t) => t.id))).toEqual(new Set([q.submittedUnassigned.id, q.inProgressMine.id, q.inProgressOther.id]));

    const closed = await list(cookie, "?seg=closed");
    expect(new Set(closed.map((t) => t.id))).toEqual(new Set([q.done.id, q.declined.id]));

    expect((await list(cookie, "?seg=all")).length).toBe(5);
    // Absent seg defaults to open.
    expect((await list(cookie)).length).toBe(3);
  });

  it("assignee: me resolves to the principal; unassigned means zero assignees; anyone is everything", async () => {
    const cookie = await cookieFor("andres");
    const q = await seedQueue(cookie);

    const mine = await list(cookie, "?seg=all&assignee=me");
    expect(mine.map((t) => t.id)).toEqual([q.inProgressMine.id]);

    const unassigned = await list(cookie, "?seg=all&assignee=unassigned");
    expect(new Set(unassigned.map((t) => t.id))).toEqual(new Set([q.submittedUnassigned.id, q.declined.id]));

    expect((await list(cookie, "?seg=all&assignee=anyone")).length).toBe(5);

    // `me` is the SIGNED-IN person, not a query arg: a different principal sees their own.
    const otherCookie = await cookieFor("meilin");
    const hers = await list(otherCookie, "?seg=all&assignee=me");
    expect(new Set(hers.map((t) => t.id))).toEqual(new Set([q.inProgressOther.id, q.done.id]));
  });

  it("category filters; 'all' and absent do not", async () => {
    const cookie = await cookieFor("andres");
    await seedQueue(cookie);
    expect((await list(cookie, "?seg=all&category=bug")).every((t) => t.category === "bug")).toBe(true);
    expect((await list(cookie, "?seg=all&category=bug")).length).toBe(2);
    expect((await list(cookie, "?seg=all&category=all")).length).toBe(5);
    expect((await list(cookie, "?seg=all")).length).toBe(5);
  });

  it("400s an out-of-vocab seg / assignee / category rather than silently ignoring it", async () => {
    const cookie = await cookieFor("andres");
    expect((await get("/tickets?seg=sideways", cookie)).status).toBe(400);
    expect((await get("/tickets?assignee=everyone", cookie)).status).toBe(400);
    expect((await get("/tickets?category=urgent", cookie)).status).toBe(400);
  });

  it("sorts updated_at DESC and carries assignees / link_count / sub_count / sprint_label per row", async () => {
    const cookie = await cookieFor("andres");
    await seedPerson("meilin");
    const sprint = await seedSprint("Roadmap reads itself");

    const parent = await createTicket(cookie, { title: "Parent ticket", sprint_id: sprint, assignees: ["meilin"], link: "#1" });
    const child = await createTicket(cookie, { title: "Child ticket" });
    const lonely = await createTicket(cookie, { title: "Lonely ticket" });

    await post(`/tickets/${parent.id}/links`, cookie, { raw: "https://www.figma.com/design/planner-duration" });
    await post(`/tickets/${parent.id}/parent`, cookie, { child_id: child.id });

    // Pin updated_at so the ORDER BY is asserted, not the clock. The ids ascend
    // parent < child < lonely, so an id-ordered (or unordered) list fails here.
    for (const [id, ts] of [[lonely.id, "2026-01-01T00:00:00.000Z"], [child.id, "2026-02-01T00:00:00.000Z"], [parent.id, "2026-03-01T00:00:00.000Z"]] as const) {
      await run(env.DB, `UPDATE tickets SET updated_at = ? WHERE id = ?`, ts, id);
    }

    const rows = await list(cookie, "?seg=all");
    expect(rows.map((t) => t.id)).toEqual([parent.id, child.id, lonely.id]);

    const p = rows.find((t) => t.id === parent.id)!;
    expect(p.assignees).toEqual(["meilin"]);
    expect(p.link_count).toBe(2);
    expect(p.sub_count).toBe(1);
    expect(p.sprint_label).toBe("Roadmap reads itself");

    const c = rows.find((t) => t.id === child.id)!;
    expect(c.sub_count).toBe(0);
    expect(c.link_count).toBe(0);
    expect(c.sprint_label).toBeNull();
    expect(c.parent_id).toBe(parent.id);
  });

  it("returns an empty list (not an error) when nothing matches", async () => {
    const cookie = await cookieFor("andres");
    expect(await list(cookie, "?seg=all")).toEqual([]);
  });
});

// ── GET /tickets/:id and GET /tickets/badge ──────────────────────────────────

describe("GET /tickets/:id", () => {
  it("returns the full detail DTO: assignees, links, comments, events, parent, children, sprint", async () => {
    const cookie = await cookieFor("andres");
    await seedPerson("meilin");
    const sprint = await seedSprint("Token rotation");

    const parent = await createTicket(cookie, { title: "Planner work", sprint_id: sprint, assignees: ["meilin"], link: "#214" });
    const child = await createTicket(cookie, { title: "Staging access" });
    await post(`/tickets/${parent.id}/parent`, cookie, { child_id: child.id });
    await post(`/tickets/${parent.id}/comment`, cookie, { body: "Started on this." });
    await post(`/tickets/${parent.id}/status`, cookie, { to: "in_progress" });

    const res = await get(`/tickets/${parent.id}`, cookie);
    expect(res.status).toBe(200);
    const t = await json<TicketDetail>(res);

    expect(t.id).toBe(parent.id);
    expect(t.status).toBe("in_progress");
    expect(t.assignees).toEqual(["meilin"]);
    expect(t.links.map((l) => l.label)).toEqual(["sapling #214"]);
    expect(t.comments.map((cm) => ({ author: cm.author, body: cm.body }))).toEqual([{ author: "andres", body: "Started on this." }]);
    expect(t.events.map((e) => [e.from_status, e.to_status])).toEqual([[null, "submitted"], ["submitted", "in_progress"]]);
    expect(t.parent).toBeNull();
    expect(t.children).toEqual([{ id: child.id, title: "Staging access", status: "submitted" }]);
    expect(t.sprint).toEqual({ id: sprint, label: "Token rotation" });

    // …and the child's view of the same relationship.
    const c = await json<TicketDetail>(await get(`/tickets/${child.id}`, cookie));
    expect(c.parent).toEqual({ id: parent.id, title: "Planner work", status: "in_progress" });
    expect(c.children).toEqual([]);
  });

  it("404s an unknown id, 400s a non-numeric one", async () => {
    const cookie = await cookieFor("andres");
    expect((await get("/tickets/9999", cookie)).status).toBe(404);
    expect((await get("/tickets/not-a-number", cookie)).status).toBe(400);
  });
});

describe("GET /tickets/badge", () => {
  it("counts unassigned OPEN tickets only, and is routed before /tickets/:id", async () => {
    const cookie = await cookieFor("andres");
    await seedPerson("meilin");

    const badge = async () => (await json<{ count: number }>(await get("/tickets/badge", cookie))).count;
    expect(await badge()).toBe(0);

    const a = await createTicket(cookie, { title: "Unassigned submitted" });
    const b = await createTicket(cookie, { title: "Unassigned, will be in progress" });
    const assigned = await createTicket(cookie, { title: "Assigned submitted", assignees: ["meilin"] });
    const willClose = await createTicket(cookie, { title: "Unassigned, will be declined" });
    expect(await badge()).toBe(3); // a + b + willClose; `assigned` has an assignee

    await post(`/tickets/${b.id}/status`, cookie, { to: "in_progress" });
    expect(await badge(), "in_progress is still open, so it still counts").toBe(3);

    await post(`/tickets/${willClose.id}/status`, cookie, { to: "declined" });
    expect(await badge(), "declined leaves the badge").toBe(2);

    await post(`/tickets/${a.id}/assignees`, cookie, { login: "meilin", on: true });
    expect(await badge(), "assigning leaves the badge").toBe(1);

    await post(`/tickets/${assigned.id}/assignees`, cookie, { login: "meilin", on: false });
    expect(await badge(), "unassigning brings it back").toBe(2);
  });
});

// ── POST /tickets/:id/move (a board drop: status + saved position) ──────────

const columnOrder = async (cookie: string, status: TicketStatus): Promise<number[]> => {
  const res = await get("/tickets?seg=all", cookie);
  const rows = (await json<{ tickets: TicketListItem[] }>(res)).tickets.filter((t) => t.status === status);
  return rows.sort(boardOrder).map((t) => t.id);
};

describe("POST /tickets/:id/move", () => {
  it("moves Triage straight to Testing at the dropped spot, and records the history row", async () => {
    const cookie = await cookieFor("andres");
    const a = await createTicket(cookie, { title: "A" });
    const b = await createTicket(cookie, { title: "B" });
    const c = await createTicket(cookie, { title: "C" });
    await post(`/tickets/${a.id}/move`, cookie, { to: "testing", after_id: null });
    await post(`/tickets/${b.id}/move`, cookie, { to: "testing", after_id: a.id });
    const res = await post(`/tickets/${c.id}/move`, cookie, { to: "testing", after_id: a.id });   // between A and B
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await json<WriteEnvelope>(res)).ticket.status).toBe("testing");
    expect(await columnOrder(cookie, "testing")).toEqual([a.id, c.id, b.id]);
    expect((await eventsOf(c.id)).at(-1)).toEqual({ actor: "andres", from_status: "submitted", to_status: "testing" });
  });

  it("reorders within a column without a history row", async () => {
    const cookie = await cookieFor("andres");
    const a = await createTicket(cookie, { title: "A" });
    const b = await createTicket(cookie, { title: "B" });
    // Unpositioned: newest first → [b, a]. Drop b after a.
    expect(await columnOrder(cookie, "submitted")).toEqual([b.id, a.id]);
    await post(`/tickets/${b.id}/move`, cookie, { to: "submitted", after_id: a.id });
    expect(await columnOrder(cookie, "submitted")).toEqual([a.id, b.id]);
    expect(await eventsOf(b.id)).toHaveLength(1);                     // just the opening row
  });

  it("moves a resolved ticket back out of Done, with a history row", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "Closed" });
    await forceStatus(t.id, "done");
    const res = await post(`/tickets/${t.id}/move`, cookie, { to: "testing", after_id: null });
    expect(res.status).toBe(200);
    const row = await first<{ status: string }>(env.DB, `SELECT status FROM tickets WHERE id = ?`, t.id);
    expect(row).toEqual({ status: "testing" });
    const events = await eventsOf(t.id);
    expect(events[events.length - 1]).toEqual({ actor: "andres", from_status: "done", to_status: "testing" });
  });

  it("a status-menu move clears the saved position — the card goes to the top of its new column", async () => {
    const cookie = await cookieFor("andres");
    const a = await createTicket(cookie, { title: "A" });
    const b = await createTicket(cookie, { title: "B" });
    await post(`/tickets/${a.id}/move`, cookie, { to: "in_progress", after_id: null });
    await post(`/tickets/${b.id}/move`, cookie, { to: "in_progress", after_id: a.id });
    await post(`/tickets/${b.id}/status`, cookie, { to: "testing" });
    await post(`/tickets/${b.id}/status`, cookie, { to: "in_progress" });
    expect(await columnOrder(cookie, "in_progress")).toEqual([b.id, a.id]);
    expect((await first<{ r: number | null }>(env.DB, `SELECT board_rank AS r FROM tickets WHERE id = ?`, b.id))?.r).toBeNull();
  });

  it("rejects a malformed body with 400", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "X" });
    expect((await post(`/tickets/${t.id}/move`, cookie, { to: "limbo", after_id: null })).status).toBe(400);
    expect((await post(`/tickets/${t.id}/move`, cookie, { to: "testing" })).status).toBe(400);
  });
});

// ── POST /tickets/:id/status (the transition table, over the wire) ───────────

describe("POST /tickets/:id/status", () => {
  it("drives EVERY legal move: 200, a history row, and updated_at bumped", async () => {
    const cookie = await cookieFor("andres");

    const legal: Array<[TicketStatus, TicketStatus]> = [];
    for (const from of TICKET_STATUSES) for (const to of TICKET_TRANSITIONS[from]) legal.push([from, to]);
    // Every status → each of the other four.
    expect(legal.length).toBe(20);

    for (const [from, to] of legal) {
      const t = await createTicket(cookie, { title: `${from} to ${to}` });
      await forceStatus(t.id, from);
      const before = await first<{ updated_at: string }>(env.DB, `SELECT updated_at FROM tickets WHERE id = ?`, t.id);
      const eventsBefore = (await eventsOf(t.id)).length;

      const res = await post(`/tickets/${t.id}/status`, cookie, { to });
      expect(res.status, `${from} → ${to} should be legal`).toBe(200);
      expect((await json<WriteEnvelope>(res)).ticket.status).toBe(to);

      const row = await first<{ status: string; updated_at: string }>(env.DB, `SELECT status, updated_at FROM tickets WHERE id = ?`, t.id);
      expect(row!.status).toBe(to);
      expect(row!.updated_at >= before!.updated_at).toBe(true);

      const events = await eventsOf(t.id);
      expect(events.length).toBe(eventsBefore + 1);
      expect(events[events.length - 1]).toEqual({ actor: "andres", from_status: from, to_status: to });
    }
  });

  it("409s EVERY illegal move (at least one per status) and writes NOTHING", async () => {
    const cookie = await cookieFor("andres");

    const illegal: Array<[TicketStatus, TicketStatus]> = [];
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        if (!TICKET_TRANSITIONS[from].includes(to)) illegal.push([from, to]);
      }
    }
    // 25 pairs minus the 20 legal ones: each status to itself, and nothing else.
    expect(illegal.length).toBe(5);
    for (const [from, to] of illegal) expect(from).toBe(to);
    for (const status of TICKET_STATUSES) expect(illegal.some(([f]) => f === status)).toBe(true);

    for (const [from, to] of illegal) {
      const t = await createTicket(cookie, { title: `${from} to ${to}` });
      await forceStatus(t.id, from);
      const eventsBefore = await eventsOf(t.id);

      const res = await post(`/tickets/${t.id}/status`, cookie, { to });
      expect(res.status, `${from} → ${to} must be refused`).toBe(409);
      expect((await json<{ error: string }>(res)).error).toContain("illegal transition");

      // The status did not move and NO history row was appended.
      const row = await first<{ status: string }>(env.DB, `SELECT status FROM tickets WHERE id = ?`, t.id);
      expect(row!.status).toBe(from);
      expect(await eventsOf(t.id)).toEqual(eventsBefore);
    }
  });

  it("400s an out-of-vocab target, 404s an unknown ticket", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "T" });
    expect((await post(`/tickets/${t.id}/status`, cookie, { to: "archived" })).status).toBe(400);
    expect((await post(`/tickets/${t.id}/status`, cookie, {})).status).toBe(400);
    expect((await post(`/tickets/9999/status`, cookie, { to: "in_progress" })).status).toBe(404);
  });
});

// ── POST /tickets/:id/assignees ──────────────────────────────────────────────

describe("POST /tickets/:id/assignees", () => {
  it("is idempotent: on twice → one row, off twice → zero rows", async () => {
    const cookie = await cookieFor("andres");
    await seedPerson("meilin");
    const t = await createTicket(cookie, { title: "Toggle me" });

    const rows = () => all<{ login: string }>(env.DB, `SELECT login FROM ticket_assignees WHERE ticket_id = ?`, t.id);
    const toggle = (on: boolean) => post(`/tickets/${t.id}/assignees`, cookie, { login: "meilin", on });

    expect((await rows()).length).toBe(0);

    expect((await toggle(true)).status).toBe(200);
    expect((await rows()).length).toBe(1);
    expect((await toggle(true)).status).toBe(200);
    expect((await rows()).length, "on twice must still be one row").toBe(1);

    expect((await toggle(false)).status).toBe(200);
    expect((await rows()).length).toBe(0);
    expect((await toggle(false)).status).toBe(200);
    expect((await rows()).length, "off twice must still be zero rows").toBe(0);
  });

  it("returns the fresh detail, bumps updated_at, and supports many assignees per ticket", async () => {
    const cookie = await cookieFor("andres");
    await seedPerson("meilin");
    const t = await createTicket(cookie, { title: "Many hands" });
    const before = (await first<{ updated_at: string }>(env.DB, `SELECT updated_at FROM tickets WHERE id = ?`, t.id))!.updated_at;

    await post(`/tickets/${t.id}/assignees`, cookie, { login: "meilin", on: true });
    const res = await post(`/tickets/${t.id}/assignees`, cookie, { login: "andres", on: true });
    expect((await json<WriteEnvelope>(res)).ticket.assignees).toEqual(["andres", "meilin"]);

    const after = (await first<{ updated_at: string }>(env.DB, `SELECT updated_at FROM tickets WHERE id = ?`, t.id))!.updated_at;
    expect(after >= before).toBe(true);
  });

  it("400s a login that is not an existing person, 404s an unknown ticket, 400s a bad body", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "T" });

    const ghost = await post(`/tickets/${t.id}/assignees`, cookie, { login: "ghost", on: true });
    expect(ghost.status).toBe(400);
    expect((await json<{ error: string }>(ghost)).error).toContain("no such person");
    expect((await all(env.DB, `SELECT * FROM ticket_assignees`)).length).toBe(0);

    expect((await post(`/tickets/${t.id}/assignees`, cookie, { login: "andres" })).status).toBe(400);
    expect((await post(`/tickets/9999/assignees`, cookie, { login: "andres", on: true })).status).toBe(404);
  });
});

// ── POST /tickets/:id/links ──────────────────────────────────────────────────

describe("POST /tickets/:id/links", () => {
  it("parses each link shape through the shared parser and stores url/kind/label/meta", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "Linked work" });

    const cases: Array<[string, { url: string; kind: string; label: string; meta: string }]> = [
      ["#214", { url: "https://github.com/SaplingLearn/sapling/issues/214", kind: "github", label: "sapling #214", meta: "GITHUB · ISSUE" }],
      ["https://github.com/SaplingLearn/sapling/pull/158", { url: "https://github.com/SaplingLearn/sapling/pull/158", kind: "github", label: "sapling #158", meta: "GITHUB · PULL REQUEST" }],
      ["https://www.figma.com/design/planner-duration", { url: "https://www.figma.com/design/planner-duration", kind: "figma", label: "Planner duration", meta: "FIGMA · DESIGN" }],
      ["https://ai.google.dev/gemini-api/docs", { url: "https://ai.google.dev/gemini-api/docs", kind: "plain", label: "ai.google.dev", meta: "LINK" }],
    ];

    for (const [raw, expected] of cases) {
      const res = await post(`/tickets/${t.id}/links`, cookie, { raw });
      expect(res.status, raw).toBe(200);
      const links = (await json<WriteEnvelope>(res)).ticket.links;
      expect(links[links.length - 1]).toMatchObject({ ...expected, created_by: "andres" });
    }
    expect((await json<WriteEnvelope>(await post(`/tickets/${t.id}/links`, cookie, { raw: "#1" }))).ticket.links.length).toBe(5);
  });

  it("400s an unusable link, 400s an empty raw, 404s an unknown ticket — nothing stored", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "T" });

    expect((await post(`/tickets/${t.id}/links`, cookie, { raw: "javascript:alert(1)" })).status).toBe(400);
    expect((await post(`/tickets/${t.id}/links`, cookie, { raw: "" })).status).toBe(400);
    expect((await post(`/tickets/9999/links`, cookie, { raw: "#1" })).status).toBe(404);
    expect((await all(env.DB, `SELECT * FROM ticket_links`)).length).toBe(0);
  });
});

// ── POST /tickets/:id/links/:linkId/remove ───────────────────────────────────

describe("POST /tickets/:id/links/:linkId/remove", () => {
  it("deletes that one link, keeps the others, and bumps updated_at", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "Linked work" });
    await post(`/tickets/${t.id}/links`, cookie, { raw: "#214" });
    const both = (await json<WriteEnvelope>(await post(`/tickets/${t.id}/links`, cookie, { raw: "#215" }))).ticket;
    const [first, second] = both.links;

    const res = await post(`/tickets/${t.id}/links/${first.id}/remove`, cookie, {});
    expect(res.status).toBe(200);
    const after = (await json<WriteEnvelope>(res)).ticket;
    expect(after.links.map((l) => l.id)).toEqual([second.id]);
    expect(after.updated_at >= both.updated_at).toBe(true);
    expect((await all(env.DB, `SELECT id FROM ticket_links`)).length).toBe(1);
  });

  it("404s an unknown link, another ticket's link and an unknown ticket; 400s a non-integer id — nothing deleted", async () => {
    const cookie = await cookieFor("andres");
    const a = await createTicket(cookie, { title: "A" });
    const b = await createTicket(cookie, { title: "B" });
    const onB = (await json<WriteEnvelope>(await post(`/tickets/${b.id}/links`, cookie, { raw: "#214" }))).ticket.links[0];

    expect((await post(`/tickets/${a.id}/links/${onB.id}/remove`, cookie, {})).status).toBe(404);
    expect((await post(`/tickets/${a.id}/links/9999/remove`, cookie, {})).status).toBe(404);
    expect((await post(`/tickets/9999/links/${onB.id}/remove`, cookie, {})).status).toBe(404);
    expect((await post(`/tickets/${a.id}/links/x/remove`, cookie, {})).status).toBe(400);
    expect((await all(env.DB, `SELECT id FROM ticket_links`)).length).toBe(1);
  });
});

// ── POST /tickets/:id/sprint ─────────────────────────────────────────────────

describe("POST /tickets/:id/sprint", () => {
  it("sets a sprint, moves between sprints, and unsets back to the backlog", async () => {
    const cookie = await cookieFor("andres");
    const one = await seedSprint("Sprint one");
    const two = await seedSprint("Sprint two");
    const t = await createTicket(cookie, { title: "Movable" });

    let res = await post(`/tickets/${t.id}/sprint`, cookie, { sprint_id: one });
    expect(res.status).toBe(200);
    expect((await json<WriteEnvelope>(res)).ticket.sprint).toEqual({ id: one, label: "Sprint one" });

    res = await post(`/tickets/${t.id}/sprint`, cookie, { sprint_id: two });
    expect((await json<WriteEnvelope>(res)).ticket.sprint).toEqual({ id: two, label: "Sprint two" });

    res = await post(`/tickets/${t.id}/sprint`, cookie, { sprint_id: null });
    expect((await json<WriteEnvelope>(res)).ticket.sprint).toBeNull();
    expect((await first<{ sprint_id: number | null }>(env.DB, `SELECT sprint_id FROM tickets WHERE id = ?`, t.id))!.sprint_id).toBeNull();
  });

  it("404s an unknown sprint id (the column is a soft ref — the route is the check) and leaves the ticket alone", async () => {
    const cookie = await cookieFor("andres");
    const sprint = await seedSprint("Real sprint");
    const t = await createTicket(cookie, { title: "Movable", sprint_id: sprint });

    const res = await post(`/tickets/${t.id}/sprint`, cookie, { sprint_id: 4242 });
    expect(res.status).toBe(404);
    expect((await first<{ sprint_id: number | null }>(env.DB, `SELECT sprint_id FROM tickets WHERE id = ?`, t.id))!.sprint_id).toBe(sprint);

    expect((await post(`/tickets/${t.id}/sprint`, cookie, {})).status).toBe(400);
    expect((await post(`/tickets/9999/sprint`, cookie, { sprint_id: null })).status).toBe(404);
  });
});

// ── POST /tickets/:id/parent (one level of nesting) ──────────────────────────

describe("POST /tickets/:id/parent", () => {
  it("nests a child under a parent and both sides of the DTO see it", async () => {
    const cookie = await cookieFor("andres");
    const parent = await createTicket(cookie, { title: "Parent" });
    const child = await createTicket(cookie, { title: "Child" });

    const res = await post(`/tickets/${parent.id}/parent`, cookie, { child_id: child.id });
    expect(res.status).toBe(200);
    expect((await json<WriteEnvelope>(res)).ticket.children).toEqual([{ id: child.id, title: "Child", status: "submitted" }]);

    const c = await json<TicketDetail>(await get(`/tickets/${child.id}`, cookie));
    expect(c.parent_id).toBe(parent.id);
    expect(c.parent).toEqual({ id: parent.id, title: "Parent", status: "submitted" });
  });

  it("refuses each of the four nesting rules individually with 409, leaving the DB untouched", async () => {
    const cookie = await cookieFor("andres");

    // A snapshot of every parent_id in the store, to prove a rejection wrote nothing.
    const parentIds = () => all<{ id: number; parent_id: number | null; updated_at: string }>(
      env.DB, `SELECT id, parent_id, updated_at FROM tickets ORDER BY id`
    );

    // 1. the would-be PARENT already has a parent → that would be level two
    const root = await createTicket(cookie, { title: "Root" });
    const mid = await createTicket(cookie, { title: "Mid" });
    const leaf = await createTicket(cookie, { title: "Leaf" });
    expect((await post(`/tickets/${root.id}/parent`, cookie, { child_id: mid.id })).status).toBe(200);

    let before = await parentIds();
    let res = await post(`/tickets/${mid.id}/parent`, cookie, { child_id: leaf.id });
    expect(res.status, "a ticket with a parent cannot itself become a parent").toBe(409);
    expect((await json<{ error: string }>(res)).error).toContain("nest one level");
    expect(await parentIds()).toEqual(before);

    // 2. the CHILD already has a parent
    const other = await createTicket(cookie, { title: "Other root" });
    before = await parentIds();
    res = await post(`/tickets/${other.id}/parent`, cookie, { child_id: mid.id });
    expect(res.status, "a ticket that already has a parent cannot be re-nested").toBe(409);
    expect((await json<{ error: string }>(res)).error).toContain("already has a parent");
    expect(await parentIds()).toEqual(before);

    // 3. the CHILD is closed (done or declined)
    for (const status of ["done", "declined"] as const) {
      const closed = await createTicket(cookie, { title: `Closed ${status}` });
      await forceStatus(closed.id, status);
      before = await parentIds();
      res = await post(`/tickets/${other.id}/parent`, cookie, { child_id: closed.id });
      expect(res.status, `a ${status} ticket cannot be nested`).toBe(409);
      expect((await json<{ error: string }>(res)).error).toContain("closed");
      expect(await parentIds()).toEqual(before);
    }

    // 4. the CHILD has children of its own
    before = await parentIds();
    res = await post(`/tickets/${other.id}/parent`, cookie, { child_id: root.id });
    expect(res.status, "a ticket with sub-tickets cannot be nested").toBe(409);
    expect((await json<{ error: string }>(res)).error).toContain("sub-tickets of its own");
    expect(await parentIds()).toEqual(before);

    // …and the degenerate self-parent.
    before = await parentIds();
    res = await post(`/tickets/${other.id}/parent`, cookie, { child_id: other.id });
    expect(res.status).toBe(409);
    expect((await json<{ error: string }>(res)).error).toContain("its own sub-ticket");
    expect(await parentIds()).toEqual(before);
  });

  it("404s an unknown parent or child, 400s a bad body", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "T" });
    expect((await post(`/tickets/9999/parent`, cookie, { child_id: t.id })).status).toBe(404);
    expect((await post(`/tickets/${t.id}/parent`, cookie, { child_id: 9999 })).status).toBe(404);
    expect((await post(`/tickets/${t.id}/parent`, cookie, {})).status).toBe(400);
    expect((await post(`/tickets/${t.id}/parent`, cookie, { child_id: "abc" })).status).toBe(400);
  });
});

// ── POST /tickets/:id/comment ────────────────────────────────────────────────

describe("POST /tickets/:id/comment", () => {
  it("appends a trimmed comment authored by the principal and bumps updated_at", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "Talk to me" });
    const before = (await first<{ updated_at: string }>(env.DB, `SELECT updated_at FROM tickets WHERE id = ?`, t.id))!.updated_at;

    const res = await post(`/tickets/${t.id}/comment`, cookie, { body: "  Reproduced — fix in progress.  ", author: "someone-else" });
    expect(res.status).toBe(200);
    const detail = (await json<WriteEnvelope>(res)).ticket;
    expect(detail.comments.length).toBe(1);
    expect(detail.comments[0].body).toBe("Reproduced — fix in progress.");
    expect(detail.comments[0].author, "the author is the principal, never the body").toBe("andres");

    const after = (await first<{ updated_at: string }>(env.DB, `SELECT updated_at FROM tickets WHERE id = ?`, t.id))!.updated_at;
    expect(after >= before).toBe(true);

    // A second comment appends in time order.
    await post(`/tickets/${t.id}/comment`, cookie, { body: "Shipped." });
    const all2 = await json<TicketDetail>(await get(`/tickets/${t.id}`, cookie));
    expect(all2.comments.map((cm) => cm.body)).toEqual(["Reproduced — fix in progress.", "Shipped."]);
  });

  it("400s an empty or whitespace-only body, 404s an unknown ticket, and stores nothing", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "T" });
    expect((await post(`/tickets/${t.id}/comment`, cookie, { body: "" })).status).toBe(400);
    expect((await post(`/tickets/${t.id}/comment`, cookie, { body: "   " })).status).toBe(400);
    expect((await post(`/tickets/${t.id}/comment`, cookie, {})).status).toBe(400);
    expect((await post(`/tickets/9999/comment`, cookie, { body: "hi" })).status).toBe(404);
    expect((await all(env.DB, `SELECT * FROM ticket_comments`)).length).toBe(0);
  });
});

// ── tickets are NOT feed items ───────────────────────────────────────────────

describe("tickets never write to the feed", () => {
  it("create + transition + comment (and the rest of the writes) leave `feed` empty", async () => {
    const cookie = await cookieFor("andres");
    await seedPerson("meilin");
    const sprintId = await seedSprint("Ticket queue");

    expect((await all(env.DB, `SELECT id FROM feed`)).length, "feed starts empty").toBe(0);

    // Every ticket write surface, in one pass.
    const t = await createTicket(cookie, { title: "Gradebook export is empty", body: "It downloads 0 rows." });
    expect((await post(`/tickets/${t.id}/status`, cookie, { to: "in_progress" })).status).toBe(200);
    expect((await post(`/tickets/${t.id}/comment`, cookie, { body: "Reproduced." })).status).toBe(200);
    expect((await post(`/tickets/${t.id}/assignees`, cookie, { login: "meilin", on: true })).status).toBe(200);
    expect((await post(`/tickets/${t.id}/sprint`, cookie, { sprint_id: sprintId })).status).toBe(200);
    expect((await post(`/tickets/${t.id}/links`, cookie, { raw: "https://github.com/SaplingLearn/sapling/issues/7" })).status).toBe(200);
    const child = await createTicket(cookie, { title: "Sub" });
    expect((await post(`/tickets/${t.id}/parent`, cookie, { child_id: child.id })).status).toBe(200);
    expect((await post(`/tickets/${t.id}/status`, cookie, { to: "done" })).status).toBe(200);

    // The ticket rows are all there…
    expect((await all(env.DB, `SELECT id FROM tickets`)).length).toBe(2);
    expect((await all(env.DB, `SELECT id FROM ticket_comments`)).length).toBe(1);
    expect((await all(env.DB, `SELECT id FROM ticket_events`)).length).toBeGreaterThan(1);
    // …and not one of them produced a feed entry. Tickets are their own surface.
    expect((await all(env.DB, `SELECT id FROM feed`)).length, "no ticket action writes to `feed`").toBe(0);
  });

  it("creating a sprint and flipping it active writes no feed row either", async () => {
    const cookie = await cookieFor("andres");
    const res = await post("/sprints", cookie, { label: "Sprint 12", dates: "SEP 8 – 19" });
    expect(res.status, await res.clone().text()).toBe(200);
    const id = (await json<{ sprint: { id: number } }>(res)).sprint.id;
    expect((await post(`/sprints/${id}/active`, cookie, { active: true })).status).toBe(200);
    expect((await all(env.DB, `SELECT id FROM feed`)).length).toBe(0);
  });
});

// ── the gate: every ticket route is session-cookie only ──────────────────────

describe("tickets: 401 without a session cookie", () => {
  it("every one of the eleven routes fails closed", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "Exists" });

    const unauthed: Array<[string, RequestInit]> = [
      ["/tickets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) }],
      ["/tickets", {}],
      ["/tickets/badge", {}],
      [`/tickets/${t.id}`, {}],
      [`/tickets/${t.id}/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "in_progress" }) }],
      [`/tickets/${t.id}/assignees`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "andres", on: true }) }],
      [`/tickets/${t.id}/links`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw: "#1" }) }],
      [`/tickets/${t.id}/links/1/remove`, { method: "POST" }],
      [`/tickets/${t.id}/sprint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sprint_id: null }) }],
      [`/tickets/${t.id}/parent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ child_id: 1 }) }],
      [`/tickets/${t.id}/comment`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "hi" }) }],
    ];
    expect(unauthed.length).toBe(11);

    for (const [path, init] of unauthed) {
      const res = await app.request(path, init, env);
      expect(res.status, `${init.method ?? "GET"} ${path} must be gated`).toBe(401);
    }

    // …and nothing leaked through: the store is exactly as the seeded ticket left it.
    expect((await all(env.DB, `SELECT id FROM tickets`)).length).toBe(1);
    expect((await all(env.DB, `SELECT * FROM ticket_comments`)).length).toBe(0);
    expect((await all(env.DB, `SELECT * FROM ticket_links`)).length).toBe(0);
    expect((await all(env.DB, `SELECT * FROM ticket_assignees`)).length).toBe(0);
  });
});

// ── D1's 100-bound-parameter ceiling (the queue outgrows it) ──────────────────

/** Seed `n` tickets in ONE D1 batch — 130 sequential inserts is too slow to be a test. */
async function seedBulkTickets(n: number, sprintId: number | null = null): Promise<number[]> {
  const now = "2026-05-01T00:00:00Z";
  const sql = `INSERT INTO tickets (title, body, category, priority, status, requester, sprint_id, created_at, updated_at)
               VALUES (?, '', 'other', 'normal', 'submitted', 'andres', ?, ?, ?)`;
  await env.DB.batch(
    Array.from({ length: n }, (_, i) => env.DB.prepare(sql).bind(`Bulk ticket ${i}`, sprintId, now, now))
  );
  return (await all<{ id: number }>(env.DB, `SELECT id FROM tickets ORDER BY id ASC`)).map((r) => r.id);
}

describe("GET /tickets past 100 rows", () => {
  // list_tickets fans four grouped queries out over the matching ticket ids
  // (assignees, link counts, sub counts, sprint labels). D1 caps a statement at
  // 100 BOUND PARAMETERS, and the queue has no LIMIT and no pagination, so a
  // single `IN (?, ?, …)` takes the whole surface down with
  // `D1_ERROR: too many SQL variables` the moment the org files its 101st ticket.
  it("returns all 130 rows, with the per-row aggregates right on a row past the first chunk", async () => {
    const cookie = await cookieFor("andres");
    await seedPerson("meilin");
    const sprintId = await seedSprint("Ticket queue");
    const ids = await seedBulkTickets(130);
    expect(ids).toHaveLength(130);

    // Every row shares one `updated_at`, so the sort (updated_at DESC, id DESC)
    // puts the LOWEST id last: `marked` is row 130 of 130, deep past chunk one.
    const marked = ids[0];
    const child = ids[1];
    expect((await post(`/tickets/${marked}/assignees`, cookie, { login: "meilin", on: true })).status).toBe(200);
    expect((await post(`/tickets/${marked}/links`, cookie, { raw: "#214" })).status).toBe(200);
    expect((await post(`/tickets/${marked}/parent`, cookie, { child_id: child })).status).toBe(200);
    expect((await post(`/tickets/${marked}/sprint`, cookie, { sprint_id: sprintId })).status).toBe(200);
    // Those writes bumped updated_at; put the two rows back at the BOTTOM of the
    // queue so the assertions below are about the last chunk, not the first.
    await run(env.DB, `UPDATE tickets SET updated_at = '2020-01-01T00:00:00Z' WHERE id IN (?, ?)`, marked, child);

    const res = await get("/tickets?seg=all", cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const rows = (await json<{ tickets: TicketListItem[] }>(res)).tickets;
    expect(rows).toHaveLength(130);

    const last = rows[rows.length - 1];
    expect(last.id).toBe(marked);                 // it really is past the first chunk
    expect(last.assignees).toEqual(["meilin"]);
    expect(last.link_count).toBe(1);
    expect(last.sub_count).toBe(1);
    expect(last.sprint_label).toBe("Ticket queue");
    // …and a first-chunk row still reads as empty, so the merge didn't smear.
    expect(rows[0].assignees).toEqual([]);
    expect(rows[0].link_count).toBe(0);
    expect(rows[0].sprint_label).toBeNull();
  });

  it("holds for a filtered segment too — `seg=open` hits the same fan-out", async () => {
    const cookie = await cookieFor("andres");
    await seedBulkTickets(130);
    const res = await get("/tickets?seg=open", cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await json<{ tickets: TicketListItem[] }>(res)).tickets).toHaveLength(130);
  });
});
