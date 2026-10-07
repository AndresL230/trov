import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { all, first, run } from "./helpers/db";
import type { TicketDetail } from "@shared/tickets";
import { cookieFor } from "./helpers/persons";
import { addOrgRepo } from "./helpers/org-config";

// A bare issue ref (`#214`) resolves against the ORG's primary repository — there is no default one —
// so the suite's org has SaplingLearn's connected, as 0042_organizations seeds it in production.
beforeEach(async () => { await addOrgRepo("SaplingLearn/sapling"); });

// POST /tickets/:id/delete — a HARD delete of a NATIVE ticket, any signed-in member.
// A ticket mirrored from a GitHub issue is refused (403) and left exactly as it was.

const post = (path: string, cookie: string, body?: unknown) =>
  app.request(
    path,
    { method: "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    env
  );

async function createTicket(cookie: string, body: Record<string, unknown>): Promise<TicketDetail> {
  const res = await post("/tickets", cookie, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { ticket: TicketDetail }).ticket;
}

const count = async (sql: string, ...args: unknown[]) => (await first<{ n: number }>(env.DB, sql, ...args))!.n;

describe("POST /tickets/:id/delete", () => {
  it("deletes a native ticket with its assignees, links, comments and history; sub-tickets are detached", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "Remove me", body: "searchable-zebra", assignees: ["andres"], link: "#214" });
    const kid = await createTicket(cookie, { title: "Sub-ticket" });
    expect((await post(`/tickets/${t.id}/parent`, cookie, { child_id: kid.id })).status).toBe(200);
    expect((await post(`/tickets/${t.id}/comment`, cookie, { body: "a comment" })).status).toBe(200);
    expect((await post(`/tickets/${t.id}/status`, cookie, { to: "in_progress" })).status).toBe(200);

    // Someone else — not the requester — can delete it: tickets are the team's.
    const res = await post(`/tickets/${t.id}/delete`, await cookieFor("meilin"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: t.id, title: "Remove me", detached: 1 });

    expect(await count(`SELECT COUNT(*) AS n FROM tickets WHERE id = ?`, t.id)).toBe(0);
    for (const table of ["ticket_assignees", "ticket_links", "ticket_comments", "ticket_events"]) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${table} WHERE ticket_id = ?`, t.id), table).toBe(0);
    }
    expect(await count(`SELECT COUNT(*) AS n FROM tickets_fts WHERE tickets_fts MATCH 'zebra'`)).toBe(0);
    expect((await first<{ parent_id: number | null }>(env.DB, `SELECT parent_id FROM tickets WHERE id = ?`, kid.id))?.parent_id).toBeNull();
    expect((await app.request(`/tickets/${t.id}`, { headers: { cookie } }, env)).status).toBe(404);

    // The number is never reissued.
    const next = await createTicket(cookie, { title: "Next" });
    expect(next.id).toBeGreaterThan(kid.id);
  });

  it("deletes a resolved ticket too", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "Done already" });
    expect((await post(`/tickets/${t.id}/status`, cookie, { to: "done" })).status).toBe(200);
    expect((await post(`/tickets/${t.id}/delete`, cookie)).status).toBe(200);
    expect(await count(`SELECT COUNT(*) AS n FROM tickets WHERE id = ?`, t.id)).toBe(0);
  });

  it("refuses a ticket mirrored from a GitHub issue with 403 and deletes nothing", async () => {
    const cookie = await cookieFor("andres");
    const t = await createTicket(cookie, { title: "Mirrored", link: "#666" });
    await run(env.DB, `UPDATE tickets SET source = 'github', source_ref = 'SaplingLearn/sapling#666' WHERE id = ?`, t.id);
    const before = await all(env.DB, `SELECT * FROM ticket_events WHERE ticket_id = ?`, t.id);

    const res = await post(`/tickets/${t.id}/delete`, cookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("GitHub issue");
    expect(await count(`SELECT COUNT(*) AS n FROM tickets WHERE id = ?`, t.id)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM ticket_links WHERE ticket_id = ?`, t.id)).toBe(1);
    expect(await all(env.DB, `SELECT * FROM ticket_events WHERE ticket_id = ?`, t.id)).toEqual(before);
  });

  it("404s an unknown ticket and 400s a non-integer id", async () => {
    const cookie = await cookieFor("andres");
    expect((await post(`/tickets/9999/delete`, cookie)).status).toBe(404);
    expect((await post(`/tickets/abc/delete`, cookie)).status).toBe(400);
  });
});
