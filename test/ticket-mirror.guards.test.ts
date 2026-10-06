import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { app } from "../src/routes";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { all, first } from "./helpers/db";
import { mirrorIssue } from "../src/tools/ticket-mirror";
import { create_ticket } from "../src/tools/tickets";
import type { TicketDetail } from "@shared/tickets";
import { cookieFor } from "./helpers/persons";
import { bearerCtx, systemCtx, platformCtx } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";

// A bare issue ref (`#214`) resolves against the ORG's primary repository — there is no default one —
// so the suite's org has SaplingLearn's connected, as 0037 seeds it in production.
beforeEach(async () => { await addOrgRepo("SaplingLearn/sapling"); });

// Phase 3 (0032): the lock and what stays writable on a mirrored ticket. The
// owner's ruling: ONLY the source link is locked. Title, body, status (under the
// normal table), assignees, sprint, parent, comments and extra links are all
// Trov's. Every assertion reads rows.

const REPO = "SaplingLearn/sapling";

async function mirrored(number = 214, o: { assignees?: string[] } = {}): Promise<number> {
  await mirrorIssue(systemCtx(), platformCtx(), REPO, {
    action: "opened",
    repository: { full_name: REPO },
    issue: {
      number, title: "[P2] Mirrored issue", body: "from GitHub", html_url: `https://github.com/${REPO}/issues/${number}`,
      state: "open", state_reason: null, updated_at: "2026-09-20T10:00:00Z", user: { login: "AndresL230" },
      assignees: (o.assignees ?? []).map((login) => ({ login })), labels: [],
    },
  });
  const t = await first<{ id: number }>(env.DB, `SELECT id FROM tickets WHERE source_ref = ?`, `${REPO}#${number}`);
  return t!.id;
}

const post = (path: string, cookie: string, body?: unknown) =>
  app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
const get = (path: string, cookie: string) => app.request(path, { headers: { cookie } }, env);
const linksOf = (id: number) => all<{ id: number; url: string; locked: number }>(env.DB, `SELECT id, url, locked FROM ticket_links WHERE ticket_id = ? ORDER BY id`, id);

async function callTool(handle: string, name: string, args: Record<string, unknown> = {}) {
  const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx(handle));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: res.content[0].text, isError: res.isError };
  } finally {
    await client.close();
    await server.close();
  }
}
async function toolNames(handle: string): Promise<string[]> {
  const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx(handle));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try { return (await client.listTools()).tools.map((t) => t.name); } finally { await client.close(); await server.close(); }
}

describe("the lock — the source link can never be removed", () => {
  it("removing the locked link via the route is a 403 and the row stays; an unlocked extra link on the same ticket still removes", async () => {
    const cookie = await cookieFor("meilin", { github: false });
    const id = await mirrored();
    expect((await post(`/tickets/${id}/links`, cookie, { raw: "https://www.figma.com/file/abc/Checkout" })).status).toBe(200);
    const [locked, extra] = await linksOf(id);
    expect(locked.locked).toBe(1);
    expect(extra.locked).toBe(0);

    const refused = await post(`/tickets/${id}/links/${locked.id}/remove`, cookie);
    expect(refused.status).toBe(403);
    expect(await linksOf(id)).toHaveLength(2);

    const removed = await post(`/tickets/${id}/links/${extra.id}/remove`, cookie);
    expect(removed.status).toBe(200);
    expect((await linksOf(id)).map((l) => l.id)).toEqual([locked.id]);
  });

  it("an unlocked link on a NATIVE ticket removes exactly as before", async () => {
    const cookie = await cookieFor("meilin", { github: false });
    const id = await create_ticket(systemCtx(), { title: "native", body: "", category: "other", priority: "normal", assignees: [], link: "#12" }, "meilin");
    const [l] = await linksOf(id);
    expect((await post(`/tickets/${id}/links/${l.id}/remove`, cookie)).status).toBe(200);
    expect(await linksOf(id)).toHaveLength(0);
  });

  it("MCP has no path to it: there is no link-removal tool at all", async () => {
    const names = await toolNames("meilin");
    expect(names.filter((n) => /remove|delete/.test(n) && /link/.test(n))).toEqual([]);
  });
});

describe("what stays writable on a mirrored ticket", () => {
  it("route: edit title/body, transition, toggle an assignee, sprint, comment — all 200", async () => {
    const cookie = await cookieFor("meilin", { github: false });
    const id = await mirrored();

    const edited = await post(`/tickets/${id}/edit`, cookie, { title: "Trov title", body: "Trov notes" });
    expect(edited.status).toBe(200);
    expect(await post(`/tickets/${id}/status`, cookie, { to: "in_progress" })).toHaveProperty("status", 200);
    expect(await post(`/tickets/${id}/assignees`, cookie, { login: "lpcooper-arch", on: true })).toHaveProperty("status", 200);
    expect(await post(`/tickets/${id}/comment`, cookie, { body: "hi" })).toHaveProperty("status", 200);

    const t = await first<{ title: string; body: string; status: string }>(env.DB, `SELECT title, body, status FROM tickets WHERE id = ?`, id);
    expect(t).toEqual({ title: "Trov title", body: "Trov notes", status: "in_progress" });
    expect(await all(env.DB, `SELECT login FROM ticket_assignees WHERE ticket_id = ?`, id)).toEqual([{ login: "lpcooper-arch" }]);
  });

  it("MCP: an assignee may edit and transition a mirrored ticket; a non-assignee is forbidden and nothing is written", async () => {
    const id = await mirrored(300, { assignees: ["Darkest-Teddy"] });
    const outsider = await callTool("lpcooper-arch", "edit_ticket", { id, title: "nope" });
    expect(outsider.isError).toBe(true);
    expect(JSON.parse(outsider.text).code).toBe("forbidden");

    const ok = await callTool("Darkest-Teddy", "edit_ticket", { id, body: "agent notes" });
    expect(ok.isError, ok.text).toBeFalsy();
    const moved = await callTool("Darkest-Teddy", "transition_ticket", { id, to: "done" });
    expect(moved.isError, moved.text).toBeFalsy();
    expect(await first(env.DB, `SELECT title, body, status FROM tickets WHERE id = ?`, id))
      .toEqual({ title: "Mirrored issue", body: "agent notes", status: "done" });
  });

  it("edit_ticket on a NATIVE ticket works too; an empty patch or a blank title is a 400 that writes nothing", async () => {
    const cookie = await cookieFor("meilin", { github: false });
    const id = await create_ticket(systemCtx(), { title: "Native", body: "b", category: "other", priority: "normal", assignees: [] }, "meilin");
    expect((await post(`/tickets/${id}/edit`, cookie, { title: "Renamed" })).status).toBe(200);
    expect((await post(`/tickets/${id}/edit`, cookie, {})).status).toBe(400);
    expect((await post(`/tickets/${id}/edit`, cookie, { title: "   " })).status).toBe(400);
    expect(await first(env.DB, `SELECT title, body FROM tickets WHERE id = ?`, id)).toEqual({ title: "Renamed", body: "b" });
    // The FTS index follows the edit.
    expect(await all(env.DB, `SELECT ticket_id FROM tickets_fts WHERE tickets_fts MATCH 'Renamed'`)).toEqual([{ ticket_id: String(id) }]);
  });
});

describe("the github-webhook system person", () => {
  it("is never listed and never assignable", async () => {
    const cookie = await cookieFor("meilin", { github: false });
    const persons = (await (await get("/persons", cookie)).json()) as { persons: { handle: string }[] };
    expect(persons.persons.map((p) => p.handle)).not.toContain("github-webhook");

    const id = await mirrored();
    expect((await post(`/tickets/${id}/assignees`, cookie, { login: "github-webhook", on: true })).status).toBe(400);
    expect(await all(env.DB, `SELECT login FROM ticket_assignees WHERE ticket_id = ?`, id)).toEqual([]);
  });
});

describe("the DTOs carry the source", () => {
  it("GET /tickets/:id and the queue expose source, source_ref and each link's locked flag", async () => {
    const cookie = await cookieFor("meilin", { github: false });
    const id = await mirrored();
    const d = (await (await get(`/tickets/${id}`, cookie)).json()) as TicketDetail;
    expect(d).toMatchObject({ source: "github", source_ref: `${REPO}#214`, source_author: "AndresL230" });
    expect(d.links.map((l) => l.locked)).toEqual([1]);

    const q = (await (await get(`/tickets?seg=all`, cookie)).json()) as { tickets: { id: number; source: string; source_ref: string | null }[] };
    expect(q.tickets.find((t) => t.id === id)).toMatchObject({ source: "github", source_ref: `${REPO}#214` });
  });
});
