import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { all, first, run } from "./helpers/db";
import { sprintProgress, sprintIssueCounts } from "../src/tools/sprints";
import { upsertProgress } from "../src/tools/progress";
import type { SprintDetail, SprintView } from "@shared/sprints";
import type { TicketDetail } from "@shared/tickets";
import { cookieFor, seedPerson } from "./helpers/persons";

import { systemCtx } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";

// A bare issue ref (`#214`) resolves against the ORG's primary repository — there is no default one —
// so the suite's org has SaplingLearn's connected, as 0042_organizations seeds it in production.
beforeEach(async () => { await addOrgRepo("SaplingLearn/sapling"); });
// ── harness (the Phase 2 route-test idiom: real routes, real cookies, real D1) ─

const post = (path: string, cookie: string, body?: unknown) =>
  app.request(
    path,
    { method: "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    env
  );
const get = (path: string, cookie: string) => app.request(path, { headers: { cookie } }, env);
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

interface SprintEnvelope { ok: true; sprint: SprintView }
interface SprintDetailEnvelope { ok: true; sprint: SprintDetail }
interface TicketEnvelope { ok: true; ticket: TicketDetail }

/** Create a sprint through the REAL route. */
async function createSprint(cookie: string, body: Record<string, unknown>): Promise<SprintView> {
  const res = await post("/sprints", cookie, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<SprintEnvelope>(res)).sprint;
}

/** File a ticket through the REAL route. */
async function createTicket(cookie: string, body: Record<string, unknown>): Promise<TicketDetail> {
  const res = await post("/tickets", cookie, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<TicketEnvelope>(res)).ticket;
}

/** Move a ticket to a status through the REAL route (one legal hop at a time). */
async function moveTo(cookie: string, id: number, to: string): Promise<void> {
  const res = await post(`/tickets/${id}/status`, cookie, { to });
  expect(res.status, await res.clone().text()).toBe(200);
}

/** Pin a ticket's updated_at so the roots/children ORDER is asserted, not observed. */
const pin = (id: number, at: string) => run(env.DB, `UPDATE tickets SET updated_at = ? WHERE id = ?`, at, id);

const detailOf = async (cookie: string, id: number): Promise<SprintDetail> => {
  const res = await get(`/sprints/${id}`, cookie);
  expect(res.status, await res.clone().text()).toBe(200);
  return json<SprintDetail>(res);
};

// ── the pure progress rule (§C.8) ────────────────────────────────────────────

describe("sprintProgress (pure) — TICKETS ONLY", () => {
  it("is the ticket counts, verbatim", () => {
    expect(sprintProgress({ ticketsTotal: 4, ticketsClosed: 1 })).toEqual({ closed: 1, total: 4, pct: 25 });
  });

  it("takes no cache input at all — the GitHub half is a separate field", () => {
    // Typed out of existence: `cache` is no longer a key of SprintProgressInput,
    // so even if a caller smuggled one in, it changes nothing.
    const smuggled = { ticketsTotal: 4, ticketsClosed: 1, cache: { closed: 2, total: 3 } } as unknown as Parameters<typeof sprintProgress>[0];
    expect(sprintProgress(smuggled)).toEqual({ closed: 1, total: 4, pct: 25 });
    expect(sprintIssueCounts).toBeTypeOf("function");
  });

  it("neither — 0/0 with pct 0, never NaN", () => {
    expect(sprintProgress({ ticketsTotal: 0, ticketsClosed: 0 })).toEqual({ closed: 0, total: 0, pct: 0 });
  });

  it("pct is rounded, and a sprint whose every ticket is resolved reads exactly 100", () => {
    expect(sprintProgress({ ticketsTotal: 3, ticketsClosed: 1 }).pct).toBe(33);
    expect(sprintProgress({ ticketsTotal: 3, ticketsClosed: 2 }).pct).toBe(67);
    expect(sprintProgress({ ticketsTotal: 2, ticketsClosed: 2 })).toEqual({ closed: 2, total: 2, pct: 100 });
  });
});

describe("sprintIssueCounts (pure) — the GitHub half", () => {
  it("passes the cache row's closed/total through, and is null without one", () => {
    expect(sprintIssueCounts({ sprint_id: 1, closed: 2, total: 3, source: "event", computed_at: "2026-09-01T00:00:00Z" })).toEqual({ closed: 2, total: 3 });
    expect(sprintIssueCounts(undefined)).toBeNull();
    expect(sprintIssueCounts(null)).toBeNull();
  });
});

// ── progress through the live routes ─────────────────────────────────────────

describe("GET /sprints — tickets-only progress, issues as their own field", () => {
  it("tickets only: closed counts done AND declined; open tickets never count", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Ticket queue" });

    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await createTicket(cookie, { title: `t${i}`, sprint_id: sp.id })).id);
    await moveTo(cookie, ids[0], "in_progress");
    await moveTo(cookie, ids[0], "done");
    await moveTo(cookie, ids[1], "declined");
    await moveTo(cookie, ids[2], "in_progress"); // open — must NOT count as closed

    const { sprints } = await json<{ sprints: SprintView[] }>(await get("/sprints", cookie));
    expect(sprints.find((s) => s.id === sp.id)!.progress).toEqual({ closed: 2, total: 4, pct: 50 });
  });

  it("issues only: the cache row NEVER enters the bar — progress 0/0, issues 2/3", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Token rotation" });
    await upsertProgress(systemCtx(), sp.id, 2, 3, "event");

    const { sprints } = await json<{ sprints: SprintView[] }>(await get("/sprints", cookie));
    const v = sprints.find((s) => s.id === sp.id)!;
    expect(v.progress).toEqual({ closed: 0, total: 0, pct: 0 });
    expect(v.issues).toEqual({ closed: 2, total: 3 });
  });

  it("both: the two halves stay SEPARATE — they never add", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Both" });
    await upsertProgress(systemCtx(), sp.id, 2, 3, "event");

    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await createTicket(cookie, { title: `t${i}`, sprint_id: sp.id })).id);
    await moveTo(cookie, ids[0], "in_progress");
    await moveTo(cookie, ids[0], "done");
    await moveTo(cookie, ids[1], "declined");

    const { sprints } = await json<{ sprints: SprintView[] }>(await get("/sprints", cookie));
    const v = sprints.find((s) => s.id === sp.id)!;
    // 2 of 4 TICKETS resolved — the 2/3 issues are reported beside them, not inside.
    expect(v.progress).toEqual({ closed: 2, total: 4, pct: 50 });
    expect(v.issues).toEqual({ closed: 2, total: 3 });
  });

  it("neither: a sprint with no tickets and no cache row reads 0/0 with issues null", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Empty" });
    const { sprints } = await json<{ sprints: SprintView[] }>(await get("/sprints", cookie));
    const v = sprints.find((s) => s.id === sp.id)!;
    expect(v.progress).toEqual({ closed: 0, total: 0, pct: 0 });
    expect(v.issues).toBeNull();
  });

  it("GET /sprints/:id carries the same split", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Detail split" });
    await upsertProgress(systemCtx(), sp.id, 1, 5, "event");
    const t = await createTicket(cookie, { title: "one", sprint_id: sp.id });
    await moveTo(cookie, t.id, "in_progress");
    await moveTo(cookie, t.id, "done");

    const d = await detailOf(cookie, sp.id);
    expect(d.progress).toEqual({ closed: 1, total: 1, pct: 100 });
    expect(d.issues).toEqual({ closed: 1, total: 5 });
  });

  it("a ticket moved OUT of the sprint stops counting toward it", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Leaky" });
    const t = await createTicket(cookie, { title: "moves away", sprint_id: sp.id });

    let list = await json<{ sprints: SprintView[] }>(await get("/sprints", cookie));
    expect(list.sprints.find((s) => s.id === sp.id)!.progress.total).toBe(1);

    await post(`/tickets/${t.id}/sprint`, cookie, { sprint_id: null });
    list = await json<{ sprints: SprintView[] }>(await get("/sprints", cookie));
    expect(list.sprints.find((s) => s.id === sp.id)!.progress).toEqual({ closed: 0, total: 0, pct: 0 });
  });

  it("members are the distinct assignee handles over the sprint's tickets", async () => {
    const cookie = await cookieFor("andres");
    await cookieFor("beatrix");
    await cookieFor("cyrus");
    const sp = await createSprint(cookie, { label: "Staffed" });
    const other = await createSprint(cookie, { label: "Elsewhere" });

    await createTicket(cookie, { title: "a", sprint_id: sp.id, assignees: ["beatrix", "andres"] });
    await createTicket(cookie, { title: "b", sprint_id: sp.id, assignees: ["beatrix"] }); // dedupes
    await createTicket(cookie, { title: "c", sprint_id: other.id, assignees: ["cyrus"] });
    await createTicket(cookie, { title: "d", sprint_id: sp.id });                          // unassigned

    const { sprints } = await json<{ sprints: SprintView[] }>(await get("/sprints", cookie));
    expect(sprints.find((s) => s.id === sp.id)!.members).toEqual(["andres", "beatrix"]);
    expect(sprints.find((s) => s.id === other.id)!.members).toEqual(["cyrus"]);
  });

  it("orders by due date, with unscheduled sprints LAST", async () => {
    const cookie = await cookieFor("andres");
    const late = await createSprint(cookie, { label: "Late", due: "2026-12-01" });
    const none = await createSprint(cookie, { label: "Unscheduled" });
    const early = await createSprint(cookie, { label: "Early", due: "2026-01-01" });

    const { sprints } = await json<{ sprints: SprintView[] }>(await get("/sprints", cookie));
    expect(sprints.map((s) => s.id)).toEqual([early.id, late.id, none.id]);
  });
});

// ── GET /sprints/:id — roots then children, resources deduped ────────────────

describe("GET /sprints/:id", () => {
  it("orders tickets roots-then-children: an in-sprint child sits directly under its root at depth 1", async () => {
    const cookie = await cookieFor("andres");
    const a = await createSprint(cookie, { label: "Sprint A" });
    const b = await createSprint(cookie, { label: "Sprint B" });

    const parent = await createTicket(cookie, { title: "Parent", sprint_id: a.id });
    const child1 = await createTicket(cookie, { title: "Child one", sprint_id: a.id });
    const child2 = await createTicket(cookie, { title: "Child two", sprint_id: a.id });
    const loner = await createTicket(cookie, { title: "Loner", sprint_id: a.id });

    // A parent that lives in ANOTHER sprint, with its child pulled into sprint A.
    const outsider = await createTicket(cookie, { title: "Outside parent", sprint_id: b.id });
    const orphan = await createTicket(cookie, { title: "Child of an outsider", sprint_id: a.id });

    expect((await post(`/tickets/${parent.id}/parent`, cookie, { child_id: child1.id })).status).toBe(200);
    expect((await post(`/tickets/${parent.id}/parent`, cookie, { child_id: child2.id })).status).toBe(200);
    expect((await post(`/tickets/${outsider.id}/parent`, cookie, { child_id: orphan.id })).status).toBe(200);

    // Pin the sort key AFTER the wiring (set_ticket_parent bumps updated_at).
    await pin(orphan.id, "2026-08-12T00:00:00Z");
    await pin(loner.id, "2026-08-11T00:00:00Z");
    await pin(parent.id, "2026-08-10T00:00:00Z");
    await pin(child1.id, "2026-08-09T00:00:00Z");
    await pin(child2.id, "2026-08-08T00:00:00Z");

    const detail = await detailOf(cookie, a.id);
    // Roots by updated_at DESC; each root's in-sprint children immediately after it.
    expect(detail.tickets.map((t) => [t.title, t.depth])).toEqual([
      ["Child of an outsider", 0], // parent is in sprint B → renders as a ROOT here
      ["Loner", 0],
      ["Parent", 0],
      ["Child one", 1],
      ["Child two", 1],
    ]);
    // The orphan really does have a parent — it is just not in this sprint.
    expect(detail.tickets.find((t) => t.title === "Child of an outsider")!.parent_id).toBe(outsider.id);

    // …and the same child does NOT appear in sprint B (only its parent does).
    const other = await detailOf(cookie, b.id);
    expect(other.tickets.map((t) => [t.title, t.depth])).toEqual([["Outside parent", 0]]);
  });

  it("sprint membership NEVER cascades: moving a parent leaves its children where they are", async () => {
    const cookie = await cookieFor("andres");
    const a = await createSprint(cookie, { label: "Sprint A" });
    const b = await createSprint(cookie, { label: "Sprint B" });

    const parent = await createTicket(cookie, { title: "Parent", sprint_id: a.id });
    const child = await createTicket(cookie, { title: "Child", sprint_id: a.id });
    expect((await post(`/tickets/${parent.id}/parent`, cookie, { child_id: child.id })).status).toBe(200);

    // Linking a child did NOT touch its sprint (both were already in A).
    const sprintOf = async (id: number) =>
      (await first<{ sprint_id: number | null }>(env.DB, `SELECT sprint_id FROM tickets WHERE id = ?`, id))!.sprint_id;
    expect(await sprintOf(child.id)).toBe(a.id);

    // Move the PARENT to sprint B. The child stays in A — there is no cascade.
    expect((await post(`/tickets/${parent.id}/sprint`, cookie, { sprint_id: b.id })).status).toBe(200);
    expect(await sprintOf(parent.id)).toBe(b.id);
    expect(await sprintOf(child.id), "the child does not follow its parent").toBe(a.id);

    // Move the parent to the BACKLOG. Still no cascade.
    expect((await post(`/tickets/${parent.id}/sprint`, cookie, { sprint_id: null })).status).toBe(200);
    expect(await sprintOf(parent.id)).toBeNull();
    expect(await sprintOf(child.id)).toBe(a.id);

    // The sprint screens agree: A lists the orphaned child as a ROOT (its parent
    // is invisible here), B lists only the parent.
    expect((await detailOf(cookie, a.id)).tickets.map((t) => [t.title, t.depth])).toEqual([["Child", 0]]);
    expect((await detailOf(cookie, b.id)).tickets).toEqual([]);
  });

  it("linking a child NEVER pulls it into its parent's sprint, and no DB trigger does it either", async () => {
    const cookie = await cookieFor("andres");
    const a = await createSprint(cookie, { label: "Sprint A" });
    const parent = await createTicket(cookie, { title: "Parent in A", sprint_id: a.id });
    const child = await createTicket(cookie, { title: "Backlog child" }); // no sprint

    expect((await post(`/tickets/${parent.id}/parent`, cookie, { child_id: child.id })).status).toBe(200);
    const row = (await first<{ sprint_id: number | null; parent_id: number | null }>(
      env.DB, `SELECT sprint_id, parent_id FROM tickets WHERE id = ?`, child.id
    ))!;
    expect(row.parent_id).toBe(parent.id);
    expect(row.sprint_id, "set_ticket_parent never writes sprint_id").toBeNull();

    // And the schema carries no trigger that could do it behind the routes' back:
    // the only triggers on `tickets` are 0024's three FTS ones.
    const triggers = await all<{ name: string; sql: string }>(
      env.DB, `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'tickets'`
    );
    // tickets_number_ai (0042_organizations) allocates the per-org display number — it touches no sprint either.
    expect(triggers.map((t) => t.name).sort()).toEqual(["tickets_fts_ad", "tickets_fts_ai", "tickets_fts_au", "tickets_number_ai"]);
    expect(triggers.every((t) => !/sprint_id/i.test(t.sql))).toBe(true);
  });

  it("dedupes resources by url — sprint_resources first, a ticket link with the same url drops out", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Resourced" });
    const t = await createTicket(cookie, { title: "Work", sprint_id: sp.id });

    // The SAME issue, attached in both places, plus one unique link on each side.
    const shared = "https://github.com/SaplingLearn/sapling/issues/214";
    expect((await post(`/sprints/${sp.id}/resources`, cookie, { raw: shared })).status).toBe(200);
    expect((await post(`/sprints/${sp.id}/resources`, cookie, { raw: "https://www.figma.com/design/sprint-brief" })).status).toBe(200);
    expect((await post(`/tickets/${t.id}/links`, cookie, { raw: shared })).status).toBe(200);
    expect((await post(`/tickets/${t.id}/links`, cookie, { raw: "https://example.com/rfc" })).status).toBe(200);

    const detail = await detailOf(cookie, sp.id);
    expect(detail.resources.map((r) => r.url)).toEqual([
      shared,                                              // the SPRINT's copy wins (first)
      "https://www.figma.com/design/sprint-brief",
      "https://example.com/rfc",
    ]);
    expect(detail.resources.filter((r) => r.url === shared)).toHaveLength(1);
    expect(detail.resources.map((r) => r.kind)).toEqual(["github", "figma", "plain"]);
    // Both rows still exist in storage — the dedupe is a READ-side rule.
    expect(await all(env.DB, `SELECT * FROM sprint_resources WHERE sprint_id = ?`, sp.id)).toHaveLength(2);
    expect(await all(env.DB, `SELECT * FROM ticket_links WHERE ticket_id = ?`, t.id)).toHaveLength(2);
  });

  it("carries the same tickets-only progress, separate issues, and members as the list", async () => {
    const cookie = await cookieFor("andres");
    await cookieFor("beatrix");
    const sp = await createSprint(cookie, { label: "Detail" });
    await upsertProgress(systemCtx(), sp.id, 1, 2, "event");
    const t = await createTicket(cookie, { title: "one", sprint_id: sp.id, assignees: ["beatrix"] });
    await moveTo(cookie, t.id, "declined");

    const detail = await detailOf(cookie, sp.id);
    // ONE ticket, declined = resolved → 1/1. The 1/2 cached issues stay separate.
    expect(detail.progress).toEqual({ closed: 1, total: 1, pct: 100 });
    expect(detail.issues).toEqual({ closed: 1, total: 2 });
    expect(detail.members).toEqual(["beatrix"]);
    expect(detail.label).toBe("Detail");

    // The list surface agrees, field for field.
    const { sprints } = await json<{ sprints: SprintView[] }>(await get("/sprints", cookie));
    const listed = sprints.find((x) => x.id === sp.id)!;
    expect(listed.progress).toEqual(detail.progress);
    expect(listed.issues).toEqual(detail.issues);
  });

  it("404s on an unknown sprint", async () => {
    const cookie = await cookieFor("andres");
    const res = await get("/sprints/9999", cookie);
    expect(res.status).toBe(404);
  });
});

// ── POST /sprints ────────────────────────────────────────────────────────────

describe("POST /sprints", () => {
  it("creates an INACTIVE, UNSCHEDULED sprint: status upcoming, phase 'Unscheduled', due null", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "New sprint" });

    expect(sp.label).toBe("New sprint");
    expect(sp.status).toBe("upcoming");
    expect(sp.active).toBe(false);
    expect(sp.phase).toBe("Unscheduled");
    expect(sp.due).toBeNull();
    expect(sp.urgency).toBe("normal");
    expect(sp.lead).toBeNull();
    expect(sp.domain).toBeNull();
    expect(sp.created_by).toBe("andres");
    expect(sp.progress).toEqual({ closed: 0, total: 0, pct: 0 });
    expect(sp.members).toEqual([]);

    // The column is NOT NULL, so "unscheduled" is stored as the empty string and
    // surfaces as `due: null` — one sentinel, documented in create_sprint.
    const row = await first<{ target_date: string; status: string }>(env.DB, `SELECT target_date, status FROM sprints WHERE id = ?`, sp.id);
    expect(row).toEqual({ target_date: "", status: "upcoming" });
  });

  it("stores every panel field the design collects", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, {
      label: "Ticket queue",
      summary: "One queue the whole org files into.",
      description: "**Tickets** are D1 rows.",
      dates: "Sep 16 – Sep 30",
      due: "2026-09-30",
      urgency: "high",
      lead: "andres",
      domain: "tickets",
      phase: "Now",
    });
    expect(sp).toMatchObject({
      label: "Ticket queue",
      summary: "One queue the whole org files into.",
      description: "**Tickets** are D1 rows.",
      dates: "Sep 16 – Sep 30",
      due: "2026-09-30",
      urgency: "high",
      lead: "andres",
      domain: "tickets",
      phase: "Now",
      status: "upcoming",
      active: false,
    });
  });

  it("the new sprint is immediately on GET /roadmap (one read model)", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "On the roadmap" });
    const plan = await json<{ sprints: SprintView[] }>(await get("/roadmap", cookie));
    expect(plan.sprints.map((s) => s.id)).toContain(sp.id);
  });

  it("400s on a missing label, a bad urgency and a bad domain — and writes nothing", async () => {
    const cookie = await cookieFor("andres");
    for (const body of [
      {},
      { label: "" },
      { label: "X", urgency: "urgent" },
      { label: "X", domain: "banana" },
    ]) {
      const res = await post("/sprints", cookie, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json<{ error: string; issues: unknown[] }>(res)).issues.length).toBeGreaterThan(0);
    }
    expect(await all(env.DB, `SELECT * FROM sprints`)).toHaveLength(0);
  });
});

// ── POST /sprints/:id/active ─────────────────────────────────────────────────

describe("POST /sprints/:id/active", () => {
  it("toggles both ways: true → in_progress (active), false → upcoming", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Toggle" });

    const on = (await json<SprintEnvelope>(await post(`/sprints/${sp.id}/active`, cookie, { active: true }))).sprint;
    expect(on.status).toBe("in_progress");
    expect(on.active).toBe(true);

    const off = (await json<SprintEnvelope>(await post(`/sprints/${sp.id}/active`, cookie, { active: false }))).sprint;
    expect(off.status).toBe("upcoming");
    expect(off.active).toBe(false);

    expect((await first<{ status: string }>(env.DB, `SELECT status FROM sprints WHERE id = ?`, sp.id))!.status).toBe("upcoming");
  });

  it("active:false on a DONE sprint is a no-op — clearing active never un-finishes it", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Shipped" });
    await post(`/sprints/${sp.id}/complete`, cookie);

    const res = await post(`/sprints/${sp.id}/active`, cookie, { active: false });
    expect(res.status).toBe(200);
    const back = (await json<SprintEnvelope>(res)).sprint;
    expect(back.status).toBe("done");
    expect(back.active).toBe(false);
    expect((await first<{ status: string }>(env.DB, `SELECT status FROM sprints WHERE id = ?`, sp.id))!.status).toBe("done");
  });

  it("active:true on a DONE sprint re-opens it to in_progress (an admin un-shipping)", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Reopened" });
    await post(`/sprints/${sp.id}/complete`, cookie);

    const back = (await json<SprintEnvelope>(await post(`/sprints/${sp.id}/active`, cookie, { active: true }))).sprint;
    expect(back.status).toBe("in_progress");
    expect(back.active).toBe(true);
  });

  it("404s on an unknown sprint; 400s on a payload without `active`", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Guarded" });
    expect((await post(`/sprints/9999/active`, cookie, { active: true })).status).toBe(404);
    expect((await post(`/sprints/${sp.id}/active`, cookie, {})).status).toBe(400);
    expect((await post(`/sprints/${sp.id}/active`, cookie, { active: "yes" })).status).toBe(400);
    expect((await first<{ status: string }>(env.DB, `SELECT status FROM sprints WHERE id = ?`, sp.id))!.status).toBe("upcoming");
  });
});

// ── POST /sprints/:id/resources ──────────────────────────────────────────────

describe("POST /sprints/:id/resources", () => {
  it("parses a bare issue reference with the SHARED parser (#214 → the sapling issue url)", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Linked" });

    const res = await post(`/sprints/${sp.id}/resources`, cookie, { raw: "#214" });
    expect(res.status).toBe(200);
    const detail = (await json<SprintDetailEnvelope>(res)).sprint;
    expect(detail.resources).toEqual([
      { url: "https://github.com/SaplingLearn/sapling/issues/214", kind: "github", label: "sapling #214", meta: "GITHUB · ISSUE" },
    ]);
    // The write response IS the detail DTO — one round-trip repaints the screen.
    expect(detail.tickets).toEqual([]);
  });

  it("is idempotent on the same url — one stored row, one rendered resource", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Twice" });
    await post(`/sprints/${sp.id}/resources`, cookie, { raw: "#214" });
    await post(`/sprints/${sp.id}/resources`, cookie, { raw: "https://github.com/SaplingLearn/sapling/issues/214" });

    expect(await all(env.DB, `SELECT * FROM sprint_resources WHERE sprint_id = ?`, sp.id)).toHaveLength(1);
    expect((await detailOf(cookie, sp.id)).resources).toHaveLength(1);
  });

  it("400s on an unusable raw and stores nothing; 404s on an unknown sprint", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Guarded" });

    const bad = await post(`/sprints/${sp.id}/resources`, cookie, { raw: "javascript:alert(1)" });
    expect(bad.status).toBe(400);
    expect((await json<{ error: string }>(bad)).error).toContain("unusable link");

    expect((await post(`/sprints/${sp.id}/resources`, cookie, { raw: "   " })).status).toBe(400);
    expect((await post(`/sprints/${sp.id}/resources`, cookie, { raw: "" })).status).toBe(400);   // schema min(1)
    expect((await post(`/sprints/${sp.id}/resources`, cookie, {})).status).toBe(400);
    expect((await post(`/sprints/9999/resources`, cookie, { raw: "#1" })).status).toBe(404);

    expect(await all(env.DB, `SELECT * FROM sprint_resources`)).toHaveLength(0);
  });
});

// ── the 401 sweep (every sprint surface is session-cookie only) ──────────────

describe("sprint routes 401 without a session", () => {
  it("refuses every read and every write, and changes nothing", async () => {
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Guarded" });
    const jsonHeaders = { "content-type": "application/json" };

    const calls: Array<[string, RequestInit]> = [
      ["/sprints", {}],
      [`/sprints/${sp.id}`, {}],
      ["/sprints", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ label: "Sneaky" }) }],
      [`/sprints/${sp.id}/active`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ active: true }) }],
      [`/sprints/${sp.id}/resources`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ raw: "#1" }) }],
      [`/sprints/${sp.id}/complete`, { method: "POST" }],
    ];
    for (const [path, init] of calls) {
      const res = await app.request(path, init, env);
      expect(res.status, path).toBe(401);
    }

    expect(await all(env.DB, `SELECT * FROM sprints`)).toHaveLength(1);
    expect(await all(env.DB, `SELECT * FROM sprint_resources`)).toHaveLength(0);
    expect((await first<{ status: string }>(env.DB, `SELECT status FROM sprints WHERE id = ?`, sp.id))!.status).toBe("upcoming");
  });
});

// ── D1's 100-bound-parameter ceiling ─────────────────────────────────────────

/** Seed `n` tickets into one sprint in ONE D1 batch (130 route calls is too slow). */
async function seedBulkTickets(n: number, sprintId: number): Promise<number[]> {
  const sql = `INSERT INTO tickets (title, body, category, priority, status, requester, sprint_id, created_at, updated_at)
               VALUES (?, '', 'other', 'normal', 'submitted', 'andres', ?, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')`;
  await env.DB.batch(Array.from({ length: n }, (_, i) => env.DB.prepare(sql).bind(`Bulk ticket ${i}`, sprintId)));
  return (await all<{ id: number }>(env.DB, `SELECT id FROM tickets WHERE sprint_id = ? ORDER BY id ASC`, sprintId)).map((r) => r.id);
}

describe("GET /sprints/:id past 100 tickets", () => {
  // get_sprint fans the ticket-links and assignee queries out over every ticket
  // id in the sprint. D1 caps a statement at 100 BOUND PARAMETERS, so a single
  // `ticket_id IN (?, ?, …)` throws `too many SQL variables` and takes the whole
  // sprint screen down once a sprint holds its 101st ticket.
  it("returns all 130 tickets, with the links and assignees of a ticket past the first chunk", async () => {
    const cookie = await cookieFor("andres");
    await seedPerson("meilin");
    const sp = await createSprint(cookie, { label: "Big sprint" });
    const ids = await seedBulkTickets(130, sp.id);
    expect(ids).toHaveLength(130);

    // One shared updated_at → the sort (updated_at DESC, id DESC) puts the LOWEST
    // id last, so `marked` is ticket 130 of 130: deep past chunk one.
    const marked = ids[0];
    expect((await post(`/tickets/${marked}/links`, cookie, { raw: "https://example.com/rfc" })).status).toBe(200);
    expect((await post(`/tickets/${marked}/assignees`, cookie, { login: "meilin", on: true })).status).toBe(200);
    await pin(marked, "2020-01-01T00:00:00Z"); // those writes bumped updated_at — put it back at the bottom

    const detail = await detailOf(cookie, sp.id);
    expect(detail.tickets).toHaveLength(130);
    expect(detail.progress).toEqual({ closed: 0, total: 130, pct: 0 });

    const last = detail.tickets[detail.tickets.length - 1];
    expect(last.id).toBe(marked);                       // it really is past the first chunk
    expect(last.assignees).toEqual(["meilin"]);
    expect(detail.resources.map((r) => r.url)).toEqual(["https://example.com/rfc"]);
    expect(detail.members).toEqual(["meilin"]);
    // …and a first-chunk ticket still reads as unassigned, so the merge didn't smear.
    expect(detail.tickets[0].assignees).toEqual([]);
  });
});

// ── POST /sprints/:id/delete — any member, tickets move to the backlog ───────

describe("POST /sprints/:id/delete", () => {
  it("a NON-admin member deletes a sprint; its tickets land in the backlog and it leaves the roadmap", async () => {
    await seedPerson("andres");
    const cookie = await cookieFor("andres");
    const sp = await createSprint(cookie, { label: "Doomed" });
    const t = await createTicket(cookie, { title: "keep me", sprint_id: sp.id });

    const res = await post(`/sprints/${sp.id}/delete`, cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await json(res)).toEqual({ ok: true, id: sp.id, label: "Doomed", moved: 1 });

    expect((await get(`/sprints/${sp.id}`, cookie)).status).toBe(404);
    const ticket = await first<{ sprint_id: number | null }>(env.DB, `SELECT sprint_id FROM tickets WHERE id = ?`, t.id);
    expect(ticket!.sprint_id).toBeNull();
    const roadmap = await json<{ sprints: SprintView[] }>(await get("/roadmap", cookie));
    expect(roadmap.sprints.map((s) => s.id)).not.toContain(sp.id);
  });

  it("404s on an unknown sprint, 400s on a non-integer id, 401s without a session", async () => {
    await seedPerson("andres");
    const cookie = await cookieFor("andres");
    expect((await post(`/sprints/4242/delete`, cookie)).status).toBe(404);
    expect((await post(`/sprints/abc/delete`, cookie)).status).toBe(400);
    expect((await post(`/sprints/1/delete`, "")).status).toBe(401);
  });
});
