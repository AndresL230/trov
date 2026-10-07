/**
 * Per-org ticket and handoff NUMBERS are the ids a person or an agent sees and types
 * (canopy-multitenancy.md §12 Q2; src/tools/tickets.ts › a ticket's two ids).
 *
 * THE RULE under test: the wire's `id` of a ticket and of a handoff IS its per-org number — in every
 * route param, request body, response, MCP argument and result, search hit and artifact link ref. The
 * global row id never leaves the server.
 *
 * To make a confusion of the two impossible to miss, every test here starts by filling a THIRD org with
 * rows, so that in orgs A and B a row id is never equal to its number, and the two orgs then file
 * INTERLEAVED — so "number n used as a row id" would name another ticket, usually of the other org.
 * Everything goes through the real entry points: the Hono app (cookie) and `/mcp` (bearer).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { cookieFor } from "./helpers/persons";
import { ensureMember, mintTokenFor, ORG_A, ORG_B } from "./helpers/tenant";
import { wf } from "./helpers/artifacts";
import { all, first, run } from "./helpers/db";
import type { TicketDetail, TicketListItem } from "@shared/tickets";
import type { SprintDetail } from "@shared/sprints";
import type { HandoffView } from "@shared/handoffs";
import type { DashboardData } from "@shared/dashboard";

const SLUG = { [ORG_A]: "saplinglearn", [ORG_B]: "acme" } as const;
type Org = typeof ORG_A | typeof ORG_B;
const FILL = "org_fill";
const T = "2026-10-01T00:00:00.000Z";

let cookie: string;       // "pat": a member of both orgs
let tokens: Record<Org, string>;

beforeEach(async () => {
  cookie = await cookieFor("pat");
  await ensureMember("pat", "admin", ORG_B);
  await run(env.DB, `UPDATE memberships SET role = 'admin' WHERE user_id = 'pat'`);
  // The third org: seven tickets and five handoffs, so no row id below equals a number.
  await run(env.DB, `INSERT INTO orgs (id, slug, name, created_at, created_by) VALUES (?, 'fill', 'Fill', ?, 'test')`, FILL, T);
  for (let i = 0; i < 7; i++) await run(env.DB, `INSERT INTO tickets (org_id, title, requester, created_at, updated_at) VALUES (?, ?, 'pat', ?, ?)`, FILL, `filler ${i}`, T, T);
  for (let i = 0; i < 5; i++) await run(env.DB, `INSERT INTO handoffs (org_id, sender, recipient, body, created_at, expires_at) VALUES (?, 'pat', 'anyone', 'filler', ?, '2099-01-01T00:00:00Z')`, FILL, T);
  tokens = { [ORG_A]: (await mintTokenFor("pat", ORG_A)).raw, [ORG_B]: (await mintTokenFor("pat", ORG_B)).raw };
});

async function http<T = any>(org: Org, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(`/api/o/${SLUG[org]}${path}`, {
    method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
  return { status: res.status, json: (await res.json().catch(() => null)) as T };
}
const file = async (org: Org, title: string, extra: Record<string, unknown> = {}) =>
  (await http<{ ticket: TicketDetail }>(org, "POST", "/tickets", { title, ...extra })).json.ticket;
const detail = async (org: Org, n: number) => (await http<TicketDetail>(org, "GET", `/tickets/${n}`)).json;
/** The stored row behind (org, number) — the only place a test may look at a row id. */
const row = <R = Record<string, unknown>>(org: string, n: number, cols = "*") => first<R>(env.DB, `SELECT ${cols} FROM tickets WHERE org_id = ? AND number = ?`, org, n);
const rowId = async (org: string, n: number) => (await row<{ id: number }>(org, n, "id"))!.id;

let rpc = 0;
async function mcp(org: Org, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; body: any; isError: boolean }> {
  const res = await wf("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${tokens[org]}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  const data = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("") : raw;
  const msg = JSON.parse(data);
  if (msg.error) return { text: JSON.stringify(msg.error), body: msg.error, isError: true };
  const text = msg.result.content[0].text as string;
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { text, body, isError: !!msg.result.isError };
}

/** A1, B1, B2, A2, B3, A3 — interleaved, so in each org numbers run 1, 2, 3 while row ids do not. */
async function sixTickets(): Promise<void> {
  for (const [org, title] of [[ORG_A, "A one"], [ORG_B, "B one"], [ORG_B, "B two"], [ORG_A, "A two"], [ORG_B, "B three"], [ORG_A, "A three"]] as const) {
    await file(org, title);
  }
}

describe("tickets over HTTP", () => {
  it("two orgs each file three tickets and each sees 1, 2, 3 — the response's id is the number, and no row id appears", async () => {
    const got: Record<string, number[]> = { [ORG_A]: [], [ORG_B]: [] };
    for (const org of [ORG_A, ORG_B, ORG_B, ORG_A, ORG_B, ORG_A] as const) got[org].push((await file(org, `${org} ticket`)).id);
    expect(got).toEqual({ [ORG_A]: [1, 2, 3], [ORG_B]: [1, 2, 3] });
    for (const org of [ORG_A, ORG_B] as const) {
      const list = (await http<{ tickets: TicketListItem[] }>(org, "GET", "/tickets?seg=all")).json.tickets;
      expect(list.map((t) => t.id).sort()).toEqual([1, 2, 3]);
      const rowIds = (await all<{ id: number }>(env.DB, `SELECT id FROM tickets WHERE org_id = ?`, org)).map((r) => r.id);
      expect(rowIds.every((id) => id > 7)).toBe(true);                       // …while the rows sit past the filler
      for (const t of list) expect(JSON.stringify(t)).not.toMatch(new RegExp(`"(id|parent_id|ticket_id)":(${rowIds.join("|")})\\b`));
      expect(Object.keys(list[0])).not.toContain("number");                  // one id on the wire, not two
    }
  });

  it("org B's #1 never resolves to org A's row: the same number is a different ticket in each org, and an unknown number is 404", async () => {
    await sixTickets();
    expect([(await detail(ORG_A, 1)).title, (await detail(ORG_B, 1)).title]).toEqual(["A one", "B one"]);
    expect([(await detail(ORG_A, 3)).title, (await detail(ORG_B, 3)).title]).toEqual(["A three", "B three"]);
    for (const org of [ORG_A, ORG_B] as const) {
      expect((await http(org, "GET", "/tickets/4")).status).toBe(404);
      // A row id is not an address: B's #1 sits at some row id > 7, and asking for THAT number finds nothing.
      expect((await http(org, "GET", `/tickets/${await rowId(org, 1)}`)).status).toBe(404);
    }
  });

  it("every write addresses the ticket by number and changes that org's row only", async () => {
    await sixTickets();
    const before = await all(env.DB, `SELECT * FROM tickets WHERE org_id = ? ORDER BY number`, ORG_A);
    const B2 = await rowId(ORG_B, 2);

    expect((await http(ORG_B, "POST", "/tickets/2/edit", { title: "B two, edited" })).status).toBe(200);
    expect((await http(ORG_B, "POST", "/tickets/2/status", { to: "in_progress" })).status).toBe(200);
    const commented = await http<{ ticket: TicketDetail }>(ORG_B, "POST", "/tickets/2/comment", { body: "on B two" });
    const assigned = await http<{ ticket: TicketDetail }>(ORG_B, "POST", "/tickets/2/assignees", { login: "pat", on: true });
    const linked = await http<{ ticket: TicketDetail }>(ORG_B, "POST", "/tickets/2/links", { raw: "https://example.com/spec" });
    for (const r of [commented, assigned, linked]) { expect(r.status).toBe(200); expect(r.json.ticket.id).toBe(2); }

    const d = await detail(ORG_B, 2);
    expect(d).toMatchObject({ id: 2, title: "B two, edited", status: "in_progress", assignees: ["pat"] });
    // Every sub-row names its ticket by NUMBER…
    expect(d.comments.map((c) => [c.ticket_id, c.body])).toEqual([[2, "on B two"]]);
    expect(d.links.map((l) => l.ticket_id)).toEqual([2]);
    expect(d.events.map((e) => [e.ticket_id, e.to_status])).toEqual([[2, "submitted"], [2, "in_progress"]]);
    // …while the rows hang off the row id.
    for (const table of ["ticket_comments", "ticket_links", "ticket_assignees"]) {
      expect(await all(env.DB, `SELECT ticket_id, org_id FROM ${table}`), table).toEqual([{ ticket_id: B2, org_id: ORG_B }]);
    }
    // Removing the link, by its own id, through the ticket's number.
    expect((await http(ORG_B, "POST", `/tickets/1/links/${d.links[0].id}/remove`)).status).toBe(404); // not on #1
    expect((await http(ORG_B, "POST", `/tickets/2/links/${d.links[0].id}/remove`)).status).toBe(200);

    // A's #2 — the same number — was never touched.
    expect(await all(env.DB, `SELECT * FROM tickets WHERE org_id = ? ORDER BY number`, ORG_A)).toEqual(before);
    expect((await detail(ORG_A, 2)).title).toBe("A two");
  });

  it("parent / sub-ticket by number: the refs that come back are numbers, on the list, the detail and the parent", async () => {
    await sixTickets();
    const nested = await http<{ ticket: TicketDetail }>(ORG_B, "POST", "/tickets/3/parent", { child_id: 1 });
    expect(nested.status).toBe(200);
    expect(nested.json.ticket).toMatchObject({ id: 3, children: [{ id: 1, title: "B one" }] });
    expect(await detail(ORG_B, 1)).toMatchObject({ id: 1, parent_id: 3, parent: { id: 3, title: "B three" } });
    const list = (await http<{ tickets: TicketListItem[] }>(ORG_B, "GET", "/tickets?seg=all")).json.tickets;
    expect(list.find((t) => t.id === 1)!.parent_id).toBe(3);
    expect(list.find((t) => t.id === 3)!.sub_count).toBe(1);
    // Stored: the parent's ROW id.
    expect((await row<{ parent_id: number }>(ORG_B, 1, "parent_id"))!.parent_id).toBe(await rowId(ORG_B, 3));
    // A's tickets with the same numbers are not nested.
    expect(await detail(ORG_A, 1)).toMatchObject({ parent_id: null, parent: null });
    expect((await detail(ORG_A, 3)).children).toEqual([]);
    // A number that is not this org's is 404, and nothing is written.
    expect((await http(ORG_B, "POST", "/tickets/2/parent", { child_id: 9 })).status).toBe(404);
    expect((await http(ORG_B, "POST", "/tickets/9/parent", { child_id: 2 })).status).toBe(404);
    // Deleting the parent detaches its sub-ticket and answers with the NUMBER.
    const gone = await http<{ ok: true; id: number; detached: number }>(ORG_B, "POST", "/tickets/3/delete");
    expect([gone.status, gone.json.id, gone.json.detached]).toEqual([200, 3, 1]);
    expect((await http(ORG_B, "GET", "/tickets/3")).status).toBe(404);
    expect((await detail(ORG_A, 3)).title).toBe("A three"); // A's #3 is still there
    expect((await file(ORG_B, "B four")).id).toBe(4);        // a deleted number is not reissued
  });

  it("sprint membership by ticket number: the sprint's ticket list carries numbers and parent numbers", async () => {
    await sixTickets();
    const sprint = (await http<{ sprint: { id: number } }>(ORG_B, "POST", "/sprints", { label: "B sprint" })).json.sprint.id;
    await http(ORG_B, "POST", "/tickets/2/parent", { child_id: 3 });
    for (const n of [2, 3]) expect((await http(ORG_B, "POST", `/tickets/${n}/sprint`, { sprint_id: sprint })).status).toBe(200);
    const d = (await http<SprintDetail>(ORG_B, "GET", `/sprints/${sprint}`)).json;
    expect(d.tickets.map((t) => [t.id, t.parent_id, t.depth, t.title])).toEqual([[2, null, 0, "B two"], [3, 2, 1, "B three"]]);
    expect((await detail(ORG_B, 2)).sprint).toEqual({ id: sprint, label: "B sprint" });
    expect((await detail(ORG_A, 2)).sprint).toBeNull();
    // A ticket filed straight into the sprint gets the next number.
    expect((await file(ORG_B, "B four", { sprint_id: sprint })).id).toBe(4);
  });

  it("a board drop names the card it lands after by number", async () => {
    await sixTickets();
    const moved = await http(ORG_B, "POST", "/tickets/3/move", { to: "in_progress", after_id: null });
    expect(moved.status).toBe(200);
    expect((await http(ORG_B, "POST", "/tickets/1/move", { to: "in_progress", after_id: 3 })).status).toBe(200);
    const rank = async (org: string, n: number) => (await row<{ board_rank: number | null; status: string }>(org, n, "board_rank, status"))!;
    expect((await rank(ORG_B, 1)).status).toBe("in_progress");
    expect((await rank(ORG_B, 1)).board_rank!).toBeGreaterThan((await rank(ORG_B, 3)).board_rank!);
    expect(await rank(ORG_A, 1)).toEqual({ board_rank: null, status: "submitted" });
    expect(await rank(ORG_A, 3)).toEqual({ board_rank: null, status: "submitted" });
  });

  it("My Work and quick search speak numbers: `#2` finds this org's #2", async () => {
    await sixTickets();
    await http(ORG_B, "POST", "/tickets/2/assignees", { login: "pat", on: true });
    await http(ORG_A, "POST", "/tickets/3/assignees", { login: "pat", on: true });
    const mine = async (org: Org) => (await http<DashboardData>(org, "GET", "/me/dashboard")).json.tickets.map((t) => [t.id, t.title]);
    expect(await mine(ORG_B)).toEqual([[2, "B two"]]);
    expect(await mine(ORG_A)).toEqual([[3, "A three"]]);
    const hits = async (org: Org, q: string) => {
      const r = (await http<{ result: { groups: { type: string; hits: { id: string; title: string }[] }[] } }>(org, "GET", `/search/quick?q=${encodeURIComponent(q)}`)).json;
      return (r.result.groups.find((g) => g.type === "ticket")?.hits ?? []).map((h) => [h.id, h.title]);
    };
    expect(await hits(ORG_B, "#2")).toEqual([["2", "B two"]]);
    expect(await hits(ORG_A, "#2")).toEqual([["2", "A two"]]);
    expect(await hits(ORG_B, "three")).toEqual([["3", "B three"]]);   // a text hit's id is the number too
    expect(await hits(ORG_B, `#${await rowId(ORG_B, 2)}`)).toEqual([]); // a row id finds nothing
  });

  it("an artifact's link to a ticket is the ticket's number, resolved inside the org", async () => {
    await sixTickets();
    const make = (org: Org) => http<{ slug: string; links: { target_type: string; target_ref: string; label: string | null }[] }>(org, "POST", "/artifacts", {
      title: "Spec", kind: "markdown", area: "api", content: "# spec", links: [{ target_type: "ticket", target_ref: "#3" }],
    });
    const b = await make(ORG_B);
    expect(b.status).toBe(201);
    expect(b.json.links).toEqual([expect.objectContaining({ target_type: "ticket", target_ref: "3", label: "B three" })]);
    expect((await make(ORG_A)).json.links).toEqual([expect.objectContaining({ target_ref: "3", label: "A three" })]);
    const listed = (await http<{ artifacts: { slug: string; ticket_ids: number[] }[] }>(ORG_B, "GET", "/artifacts?ticket=3")).json.artifacts;
    expect(listed.map((a) => [a.slug, a.ticket_ids])).toEqual([[b.json.slug, [3]]]);
    expect((await http<{ artifacts: unknown[] }>(ORG_B, "GET", "/artifacts?ticket=1")).json.artifacts).toEqual([]);
    // No such number in this org: refused, nothing linked.
    expect((await http(ORG_B, "POST", `/artifacts/${b.json.slug}/links`, { target_type: "ticket", target_ref: "9" })).status).toBe(400);
    // Deleting B's #3 drops B's link and leaves A's link to A's #3.
    expect((await http(ORG_B, "POST", "/tickets/3/delete")).status).toBe(200);
    expect(await all(env.DB, `SELECT org_id, target_ref FROM artifact_links WHERE target_type = 'ticket'`)).toEqual([{ org_id: ORG_A, target_ref: "3" }]);
  });
});

describe("handoffs over HTTP", () => {
  const leave = async (org: Org, body: string) => (await http<{ handoff: HandoffView }>(org, "POST", "/handoffs", { body })).json.handoff;

  it("two orgs each leave handoffs and each sees 1, 2, 3; a number resolves inside its org only", async () => {
    const got: Record<string, number[]> = { [ORG_A]: [], [ORG_B]: [] };
    for (const org of [ORG_B, ORG_A, ORG_B, ORG_A, ORG_A, ORG_B] as const) got[org].push((await leave(org, `${org} handoff ${got[org].length + 1}`)).id);
    expect(got).toEqual({ [ORG_A]: [1, 2, 3], [ORG_B]: [1, 2, 3] });
    const one = async (org: Org, n: number) => (await http<{ handoff: HandoffView }>(org, "GET", `/handoffs/${n}`));
    expect((await one(ORG_A, 2)).json.handoff).toMatchObject({ id: 2, body: `${ORG_A} handoff 2` });
    expect((await one(ORG_B, 2)).json.handoff).toMatchObject({ id: 2, body: `${ORG_B} handoff 2` });
    expect((await one(ORG_B, 4)).status).toBe(404);
    const listed = (await http<{ handoffs: HandoffView[] }>(ORG_B, "GET", "/handoffs?box=sent")).json.handoffs;
    expect(listed.map((h) => h.id).sort()).toEqual([1, 2, 3]);
    expect((await all<{ id: number }>(env.DB, `SELECT id FROM handoffs WHERE org_id IN (?, ?)`, ORG_A, ORG_B)).every((r) => r.id > 5)).toBe(true);
    // The feed line names the handoff by its number.
    expect((await all<{ summary: string }>(env.DB, `SELECT summary FROM feed WHERE org_id = ? ORDER BY id`, ORG_B)).map((f) => /#(\d+)/.exec(f.summary)![1])).toEqual(["1", "2", "3"]);
  });

  it("claim and expire by number change that org's handoff only", async () => {
    await leave(ORG_A, "A one"); await leave(ORG_B, "B one"); await leave(ORG_B, "B two");
    const claimed = await http<{ handoff: HandoffView }>(ORG_B, "POST", "/handoffs/1/claim", { session: "s1" });
    expect([claimed.status, claimed.json.handoff.id, claimed.json.handoff.body, claimed.json.handoff.status]).toEqual([200, 1, "B one", "claimed"]);
    const expired = await http<{ handoff: HandoffView }>(ORG_B, "POST", "/handoffs/2/expire");
    expect([expired.status, expired.json.handoff.id, expired.json.handoff.status]).toEqual([200, 2, "expired"]);
    expect(await all(env.DB, `SELECT org_id, number, status FROM handoffs WHERE org_id IN (?, ?) ORDER BY org_id, number`, ORG_A, ORG_B)).toEqual([
      { org_id: ORG_B, number: 1, status: "claimed" }, { org_id: ORG_B, number: 2, status: "expired" }, { org_id: ORG_A, number: 1, status: "pending" },
    ]);
    expect((await http(ORG_A, "POST", "/handoffs/2/claim", { session: "s2" })).status).toBe(404); // A has no #2
    const hits = (await http<{ result: { groups: { type: string; hits: { id: string; title: string }[] }[] } }>(ORG_A, "GET", "/search/quick?q=%231")).json;
    expect((hits.result.groups.find((g) => g.type === "handoff")?.hits ?? []).map((h) => [h.id, h.title])).toEqual([["1", "A one"]]);
  });
});

describe("over MCP — the token's org", () => {
  it("tickets: create returns 1, 2, 3 per org; every tool takes and returns the number", async () => {
    const made: Record<string, number[]> = { [ORG_A]: [], [ORG_B]: [] };
    for (const org of [ORG_A, ORG_B, ORG_B, ORG_A, ORG_B] as const) {
      const r = await mcp(org, "create_ticket", { title: `${org} t${made[org].length + 1}`, assignees: ["pat"] });
      expect(r.isError, r.text).toBe(false);
      made[org].push(r.body.id);
    }
    expect(made).toEqual({ [ORG_A]: [1, 2], [ORG_B]: [1, 2, 3] });
    expect((await mcp(ORG_B, "list_tickets", { seg: "all" })).body.map((t: { id: number }) => t.id).sort()).toEqual([1, 2, 3]);
    expect((await mcp(ORG_B, "get_ticket", { id: 2 })).body).toMatchObject({ id: 2, title: `${ORG_B} t2` });
    expect((await mcp(ORG_A, "get_ticket", { id: 2 })).body).toMatchObject({ id: 2, title: `${ORG_A} t2` });
    expect((await mcp(ORG_A, "get_ticket", { id: 3 })).isError).toBe(true); // A has no #3
    expect((await mcp(ORG_B, "get_ticket", { id: await rowId(ORG_B, 2) })).isError).toBe(true); // a row id is not an address

    const before = await all(env.DB, `SELECT * FROM tickets WHERE org_id = ? ORDER BY number`, ORG_A);
    expect((await mcp(ORG_B, "transition_ticket", { id: 3, to: "in_progress" })).body).toMatchObject({ id: 3, status: "in_progress" });
    expect((await mcp(ORG_B, "edit_ticket", { id: 3, title: "renamed" })).body).toMatchObject({ id: 3, title: "renamed" });
    const commented = (await mcp(ORG_B, "add_ticket_comment", { id: 3, body: "from an agent" })).body;
    expect(commented.comments.map((c: { ticket_id: number }) => c.ticket_id)).toEqual([3]);
    expect((await mcp(ORG_B, "add_ticket_link", { id: 3, raw: "https://example.com/x" })).body.links).toHaveLength(1);
    const parented = (await mcp(ORG_B, "set_ticket_parent", { id: 3, child_id: 1 })).body;
    expect(parented).toMatchObject({ id: 3, children: [{ id: 1 }] });
    expect((await mcp(ORG_B, "get_ticket", { id: 1 })).body).toMatchObject({ parent_id: 3, parent: { id: 3 } });
    const sprint = (await mcp(ORG_B, "create_sprint", { label: "s" })).body.id as number;
    expect((await mcp(ORG_B, "set_ticket_sprint", { id: 2, sprint_id: sprint })).body).toMatchObject({ id: 2, sprint: { id: sprint } });
    expect((await mcp(ORG_B, "get_sprint", { id: sprint })).body.tickets.map((t: { id: number }) => t.id)).toEqual([2]);
    await ensureMember("quinn", "member", ORG_B);
    expect((await mcp(ORG_B, "assign_ticket", { id: 2, login: "quinn", on: true })).body.assignees).toEqual(["pat", "quinn"]);
    expect((await mcp(ORG_B, "get_my_work", {})).body.tickets.map((t: { id: number }) => t.id).sort()).toEqual([1, 2, 3]);
    // Nothing of A moved, though A has tickets with the same numbers.
    expect(await all(env.DB, `SELECT * FROM tickets WHERE org_id = ? ORDER BY number`, ORG_A)).toEqual(before);
    // The lane is drawn on the numbered ticket: quinn is on #2 only.
    const quinn = (await mintTokenFor("quinn", ORG_B)).raw;
    tokens = { ...tokens, [ORG_B]: quinn };
    expect((await mcp(ORG_B, "add_ticket_comment", { id: 2, body: "mine" })).isError).toBe(false);
    expect((await mcp(ORG_B, "add_ticket_comment", { id: 3, body: "not mine" })).text).toContain("forbidden");
    expect((await mcp(ORG_B, "add_ticket_comment", { id: 9, body: "nothing there" })).text).toContain("not_found");
  });

  it("an artifact linked to a ticket over MCP is linked by number, and get_ticket lists it", async () => {
    await sixTickets();
    const up = await mcp(ORG_B, "upload_asset", { title: "Agent spec", kind: "markdown", area: "api", repo: "", visibility: "org", content: "# x", links: [{ target_type: "ticket", target_ref: "2" }] });
    expect(up.isError, up.text).toBe(false);
    expect((await mcp(ORG_B, "get_ticket", { id: 2 })).body.artifacts.map((a: { slug: string }) => a.slug)).toEqual([up.body.slug]);
    expect((await mcp(ORG_A, "get_ticket", { id: 2 })).body.artifacts).toEqual([]);
    expect((await mcp(ORG_B, "artifact_list", { ticket: 2 })).body.artifacts.map((a: { slug: string }) => a.slug)).toEqual([up.body.slug]);
    expect((await mcp(ORG_B, "artifact_list", { ticket: 1 })).body.artifacts).toEqual([]);
  });

  it("handoffs: send returns the number, and get / claim / expire take it", async () => {
    const a1 = (await mcp(ORG_A, "send_handoff", { body: "A's first" })).body;
    const b1 = (await mcp(ORG_B, "send_handoff", { body: "B's first" })).body;
    const b2 = (await mcp(ORG_B, "send_handoff", { body: "B's second" })).body;
    expect([a1.id, b1.id, b2.id]).toEqual([1, 1, 2]);
    expect((await mcp(ORG_B, "get_handoff", { id: 1 })).body).toMatchObject({ id: 1, body: "B's first" });
    expect((await mcp(ORG_A, "get_handoff", { id: 1 })).body).toMatchObject({ id: 1, body: "A's first" });
    expect((await mcp(ORG_A, "get_handoff", { id: 2 })).isError).toBe(true);
    expect((await mcp(ORG_B, "list_handoffs", { box: "sent" })).body.map((h: { id: number }) => h.id).sort()).toEqual([1, 2]);
    const claimed = await mcp(ORG_B, "claim_handoff", { id: 2, session: "s" });
    expect(claimed.text).toContain("# Handoff #2 — claimed");
    expect(claimed.text).toContain("B's second");
    expect((await mcp(ORG_B, "expire_handoff", { id: 1 })).isError).toBe(false);
    expect(await all(env.DB, `SELECT org_id, number, status FROM handoffs WHERE org_id IN (?, ?) ORDER BY org_id, number`, ORG_A, ORG_B)).toEqual([
      { org_id: ORG_B, number: 1, status: "expired" }, { org_id: ORG_B, number: 2, status: "claimed" }, { org_id: ORG_A, number: 1, status: "pending" },
    ]);
  });
});

// ── links in tool results name the token's org (src/tools/org-links.ts) ──────
describe("MCP tool results link into the token's org: <origin>/o/<slug>/#…", () => {
  const ORIGIN = "https://trov.test"; // vitest.config.ts PUBLIC_ORIGIN

  it("a handoff's url is the org's app address with the handoff's number", async () => {
    const a = (await mcp(ORG_A, "send_handoff", { body: "from A" })).body;
    const b = (await mcp(ORG_B, "send_handoff", { body: "from B" })).body;
    expect(a).toEqual({ id: 1, url: `${ORIGIN}/o/saplinglearn/#handoffs/1` });
    expect(b).toEqual({ id: 1, url: `${ORIGIN}/o/acme/#handoffs/1` });
  });

  it("an artifact's page url and raw_url are under the org — and the raw_url really serves that org's bytes", async () => {
    const up = async (org: Org, content: string) => (await mcp(org, "upload_asset", { title: "Linked page", kind: "html", area: "ui", repo: "", visibility: "org", content })).body;
    const a = await up(ORG_A, "<p>bytes of A</p>");
    const b = await up(ORG_B, "<p>bytes of B</p>");
    expect([a.slug, b.slug]).toEqual(["linked-page", "linked-page"]); // the same slug in each org
    expect(a.url).toBe(`${ORIGIN}/o/saplinglearn/#artifacts/linked-page`);
    expect(b.url).toBe(`${ORIGIN}/o/acme/#artifacts/linked-page`);
    const got = (await mcp(ORG_B, "artifact_get", { slug: "linked-page" })).body;
    expect(got.url).toBe(`${ORIGIN}/o/acme/#artifacts/linked-page`);
    expect(got.raw_url).toBe(`${ORIGIN}/api/o/acme/raw/a/linked-page@v1`);
    expect((await mcp(ORG_B, "artifact_list", {})).body.artifacts.map((x: { url: string }) => x.url)).toEqual([`${ORIGIN}/o/acme/#artifacts/linked-page`]);
    const revised = (await mcp(ORG_B, "artifact_update", { slug: "linked-page", summary: "v2", content: "<p>bytes of B, v2</p>" })).body;
    expect(revised.url).toBe(`${ORIGIN}/o/acme/#artifacts/linked-page`);
    // A person opens the link in a browser (session cookie): B's bytes, never A's.
    const raw = await app.request(new URL(got.raw_url).pathname, { headers: { cookie } }, env);
    expect(raw.status).toBe(200);
    const text = await raw.text();
    expect(text).toContain("bytes of B");
    expect(text).not.toContain("bytes of A");
    // No result of either org carries a bare `<origin>/#…` or `<origin>/raw/a/…` link any more.
    for (const r of [a, b, got, revised]) expect(JSON.stringify(r)).not.toMatch(/trov\.test\/(#|raw\/a\/)/);
  });
});
