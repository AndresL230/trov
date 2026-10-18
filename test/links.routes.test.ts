// Agent links' cookie routes (src/routes.ts, tenantApi): the PERSON steps — start, send, accept, decline, cancel,
// close, a person's note — and the reads behind the Links tab. The rules are src/tools/links.ts's (test/links.test.ts);
// what is held here is the route's own part: the actor is always the session's person (never a body field), the box
// is validated, a LinkError is its status and `{ error: <code>, message }`, a 429 carries its retry, a failed read
// degrades, and one org never sees another's link. Real D1 over the reset seed.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { requestLink } from "../src/tools/links";
import { LIMITS } from "../src/platform/limits";
import { LINK_NOTES_PER_SIDE, type LinkDetail, type LinkView } from "@shared/links";
import type { SidebarBadges } from "@shared/badges";
import { cookieFor } from "./helpers/persons";
import { all, first, run } from "./helpers/db";
import { ensureMember, tenantCtx, ORG_A, ORG_B } from "./helpers/tenant";

const A = "AndresL230", J = "Jose-Gael-Cruz-Lopez", L = "lpcooper-arch", T = "Darkest-Teddy";

/** A cookie request as `who`, under `/api/o/<slug>` (SaplingLearn unless named). */
async function call(who: string, method: "GET" | "POST", path: string, body?: unknown, slug = "saplinglearn"): Promise<Response> {
  const headers: Record<string, string> = { cookie: await cookieFor(who) };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.request(`/api/o/${slug}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env);
}
const get = (who: string, path: string, slug?: string) => call(who, "GET", path, undefined, slug);
const post = (who: string, path: string, body: unknown = {}, slug?: string) => call(who, "POST", path, body, slug);

async function ok<T>(res: Response | Promise<Response>): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json()) as T;
}
async function refused(res: Response | Promise<Response>, status: number, error: string): Promise<Record<string, unknown>> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  const b = (await r.json()) as Record<string, unknown>;
  expect(b.error).toBe(error);
  return b;
}

const linkOf = async (res: Response | Promise<Response>) => (await ok<{ link: LinkView }>(res)).link;
const detailOf = async (res: Response | Promise<Response>) => (await ok<{ link: LinkDetail }>(res)).link;
const listOf = async (who: string, box: string, slug?: string) => (await ok<{ links: LinkView[] }>(get(who, `/links?box=${box}`, slug))).links;

/** A person's request from the web, `from` → `to`. */
const start = async (from: string, to: string, reason = "touching auth") => linkOf(post(from, "/links", { target: { person: to }, reason }));
/** An agent's draft (MCP `request_link`), for the Send step. */
const draft = async (from: string, to: string) =>
  (await requestLink(await tenantCtx(from), from, { target: { person: to }, reason: "touching auth", session: `s-${from}` }, { via: "mcp", origin: "https://trov.dev" })).link;
/** An open link `from` → `to`. */
const opened = async (from: string, to: string) => {
  const l = await start(from, to);
  return from === to ? l : linkOf(post(to, `/links/${l.id}/accept`));
};
const stateOf = async (id: number, orgId = ORG_A) =>
  (await first<{ state: string }>(env.DB, `SELECT state FROM agent_links WHERE org_id = ? AND number = ?`, orgId, id))?.state;

describe("the link routes — the whole life, on its happy path", () => {
  it("start → waiting for the recipient → accept → a note each → close; each box and the detail follow", async () => {
    const l = await start(J, L);
    expect(l).toMatchObject({ id: 1, state: "requested", self: false, topic: { kind: "person", ref: L }, reason: "touching auth",
      requester: { handle: J, session: null }, recipient: { handle: L, session: null } });
    expect((await listOf(J, "mine")).map((x) => x.id)).toEqual([1]);
    expect((await listOf(L, "waiting")).map((x) => x.id)).toEqual([1]);
    expect(await listOf(J, "waiting")).toEqual([]);

    expect(await linkOf(post(L, "/links/1/accept"))).toMatchObject({ id: 1, state: "open" });
    expect((await listOf(J, "open")).map((x) => x.id)).toEqual([1]);
    expect((await listOf(L, "unbound")).map((x) => x.id)).toEqual([1]); // no session joined yet

    const afterJ = await detailOf(post(J, "/links/1/notes", { body: "renaming authSession tonight" }));
    expect(afterJ.notes).toMatchObject([{ side: "requester", author: J, author_kind: "person", body: "renaming authSession tonight", delivered_at: null }]);
    const afterL = await detailOf(post(L, "/links/1/notes", { body: "fine by me" }));
    expect(afterL.notes.map((n) => [n.side, n.author])).toEqual([["requester", J], ["recipient", L]]);
    expect(await detailOf(get(J, "/links/1"))).toEqual(afterL);

    expect(await linkOf(post(J, "/links/1/close", { reason: "merged" }))).toMatchObject({ state: "closed", closed_by: J, close_reason: "merged" });
    expect(await listOf(L, "open")).toEqual([]);
    expect((await listOf(L, "closed")).map((x) => x.id)).toEqual([1]);
  });

  it("decline and cancel end a request; a reason on close is optional", async () => {
    const a = await start(J, L);
    expect(await linkOf(post(L, `/links/${a.id}/decline`))).toMatchObject({ state: "declined" });
    const b = await start(J, L);
    expect(await linkOf(post(J, `/links/${b.id}/cancel`))).toMatchObject({ state: "cancelled" });
    const c = await opened(J, L);
    expect(await linkOf(post(L, `/links/${c.id}/close`))).toMatchObject({ state: "closed", closed_by: L, close_reason: null });
  });

  it("an agent's draft is sent by its person: requested — and a self-link opens on Send, one person, one click", async () => {
    const d = await draft(J, L);
    expect(d.state).toBe("draft");
    expect(await linkOf(post(J, `/links/${d.id}/send`))).toMatchObject({ state: "requested" });
    const self = await draft(L, L);
    expect(await linkOf(post(L, `/links/${self.id}/send`))).toMatchObject({ state: "open", self: true });
    // …and a person starting one to themself from the web opens it at once.
    expect(await start(T, T)).toMatchObject({ state: "open", self: true });
  });
});

describe("only the right person moves a link", () => {
  it("the requester sends and cancels; the recipient accepts and declines; anyone else is refused, nothing written", async () => {
    const d = await draft(J, L);
    await refused(post(L, `/links/${d.id}/send`), 403, "forbidden");
    await refused(post(T, `/links/${d.id}/send`), 403, "forbidden");
    await refused(post(L, `/links/${d.id}/cancel`), 403, "forbidden");
    expect(await stateOf(d.id)).toBe("draft");

    const r = await start(J, L);
    const b = await refused(post(J, `/links/${r.id}/accept`), 403, "forbidden");
    expect(b.message).toBe("only the person the link is for can accept it");
    await refused(post(T, `/links/${r.id}/accept`), 403, "forbidden");
    await refused(post(J, `/links/${r.id}/decline`), 403, "forbidden");
    await refused(post(L, `/links/${r.id}/cancel`), 403, "forbidden");
    expect(await stateOf(r.id)).toBe("requested");

    // the wrong state is a 409; an unknown number, or a malformed one, a 404
    await refused(post(J, `/links/${r.id}/send`), 409, "conflict");
    await refused(post(J, `/links/${r.id}/close`), 409, "conflict");
    await refused(post(L, "/links/99/accept"), 404, "not_found");
    await refused(post(L, "/links/abc/accept"), 404, "not_found");
    await refused(post(L, "/links/0/accept"), 404, "not_found");

    // an outsider cannot read it, nor close or write on an open one
    await refused(get(T, `/links/${r.id}`), 404, "not_found");
    await post(L, `/links/${r.id}/accept`);
    await refused(post(T, `/links/${r.id}/close`), 403, "forbidden");
    await refused(post(T, `/links/${r.id}/notes`, { body: "hi" }), 403, "forbidden");
    expect(await stateOf(r.id)).toBe("open");
  });
});

describe("the actor is the session's person — never the body's", () => {
  it("author fields in a body are ignored on start, close and a note", async () => {
    const l = await linkOf(post(J, "/links", { target: { person: L }, reason: "r", requester: T, author: T, actor: T, recipient: A }));
    expect(l.requester.handle).toBe(J);
    expect(l.recipient.handle).toBe(L);
    await post(L, `/links/${l.id}/accept`, { recipient: T, actor: T });
    expect(await stateOf(l.id)).toBe("open");

    const d = await detailOf(post(J, `/links/${l.id}/notes`, { body: "mine", author: T, author_kind: "agent", session: "s-forged", actor: T }));
    expect(d.notes).toMatchObject([{ author: J, author_kind: "person", side: "requester" }]);
    expect(await first(env.DB, `SELECT author_agent_session FROM agent_link_notes WHERE org_id = ?`, ORG_A)).toEqual({ author_agent_session: null });

    expect(await linkOf(post(J, `/links/${l.id}/close`, { closed_by: T, actor: T, session: "ask-thread-1" }))).toMatchObject({ state: "closed", closed_by: J });
  });
});

describe("input", () => {
  it("an unknown box is a 400; no box is the open ones", async () => {
    const b = await refused(get(J, "/links?box=everything"), 400, "bad_request");
    expect(b.message).toContain("everything");
    await refused(get(J, "/links?box="), 400, "bad_request");
    const o = await opened(J, L);
    expect((await ok<{ links: LinkView[] }>(get(J, "/links"))).links.map((x) => x.id)).toEqual([o.id]);
  });

  it("a bad start is a 400 with the schema's words; a person outside the org is not_member; nothing is written", async () => {
    expect((await refused(post(J, "/links", { target: { person: L }, reason: "x".repeat(281) }), 400, "bad_request")).message).toContain("reason");
    expect((await refused(post(J, "/links", { target: { person: L, pr: 3 }, reason: "r" }), 400, "bad_request")).message).toContain("exactly one");
    await refused(call(J, "POST", "/links"), 400, "bad_request");
    await refused(post(J, "/links", { target: { person: "nobody-here" }, reason: "r" }), 404, "not_member");
    await refused(post(J, "/links", { target: { pr: 4242 }, reason: "r" }), 404, "not_found");
    expect(await first(env.DB, `SELECT COUNT(*) AS n FROM agent_links`)).toEqual({ n: 0 });
  });

  it("the why is optional: left out or blank, the link starts with no reason (stored as \"\")", async () => {
    const none = await post(J, "/links", { target: { person: L } });
    expect(none.status).toBe(200);
    const blank = await post(J, "/links", { target: { person: "meilin" }, reason: "   " });
    expect(blank.status).toBe(200);
    expect(await all(env.DB, `SELECT reason FROM agent_links ORDER BY number`)).toEqual([{ reason: "" }, { reason: "" }]);
  });

  it("a note is 1–1,000 characters, on an open link only", async () => {
    const r = await start(J, L);
    await refused(post(J, `/links/${r.id}/notes`, { body: "early" }), 409, "conflict");
    await post(L, `/links/${r.id}/accept`);
    await refused(post(J, `/links/${r.id}/notes`, { body: "   " }), 400, "bad_request");
    await refused(post(J, `/links/${r.id}/notes`, { body: "x".repeat(1001) }), 400, "bad_request");
    await refused(post(J, `/links/${r.id}/notes`, {}), 400, "bad_request");
    expect(await first(env.DB, `SELECT COUNT(*) AS n FROM agent_link_notes`)).toEqual({ n: 0 });
  });

  it("signed out is a 401", async () => {
    expect((await app.request("/api/o/saplinglearn/links?box=open", {}, env)).status).toBe(401);
    expect((await app.request("/api/o/saplinglearn/links", { method: "POST" }, env)).status).toBe(401);
  });
});

describe("a person's notes", () => {
  it("go on the writer's own side; on a self-link the requester's, or the side named", async () => {
    const o = await opened(J, L);
    expect((await detailOf(post(L, `/links/${o.id}/notes`, { body: "from the page" }))).notes.map((n) => n.side)).toEqual(["recipient"]);
    // a side that is not the writer's is refused
    await refused(post(L, `/links/${o.id}/notes`, { body: "as Jose", side: "requester" }), 403, "forbidden");

    const self = await start(T, T);
    const d = await detailOf(post(T, `/links/${self.id}/notes`, { body: "a" }));
    expect(d.notes.map((n) => n.side)).toEqual(["requester"]);
    expect((await detailOf(post(T, `/links/${self.id}/notes`, { body: "b", side: "recipient" }))).notes.map((n) => n.side)).toEqual(["requester", "recipient"]);
  });

  it(`count against the ${LINK_NOTES_PER_SIDE}-per-side cap — a 429; the other side keeps its own`, async () => {
    const o = await opened(J, L);
    for (let i = 0; i < LINK_NOTES_PER_SIDE; i++) {
      await run(env.DB, `INSERT INTO agent_link_notes (org_id, link_number, side, author, author_kind, author_agent_session, body, created_at)
                         VALUES (?, ?, 'requester', ?, 'agent', 's', ?, '2026-10-17T00:00:00Z')`, ORG_A, o.id, J, `n${i}`);
    }
    const b = await refused(post(J, `/links/${o.id}/notes`, { body: "one more" }), 429, "limit");
    expect(b.message).toBe(`at most ${LINK_NOTES_PER_SIDE} notes per side on a link`);
    expect(b.retry_after).toBeUndefined();
    expect((await detailOf(post(L, `/links/${o.id}/notes`, { body: "mine" }))).notes).toHaveLength(LINK_NOTES_PER_SIDE + 1);
  });

  it("take the hourly link_note allowance; past it a 429 carries retry_after and the header", async () => {
    const o = await opened(L, J); // Luke is not the seed's superadmin, so the allowance applies
    await post(L, `/links/${o.id}/notes`, { body: "first" });
    await run(env.DB, `UPDATE abuse_counters SET count = ? WHERE subject = ? AND action = 'link_note'`, LIMITS.link_note.max, L);
    const res = await post(L, `/links/${o.id}/notes`, { body: "over" });
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    const b = await refused(res, 429, "limit");
    expect(b.retry_after).toBeGreaterThan(0);
    expect(Number(res.headers.get("retry-after"))).toBe(b.retry_after);
    expect(await first(env.DB, `SELECT COUNT(*) AS n FROM agent_link_notes WHERE author = ?`, L)).toEqual({ n: 1 });
  });
});

describe("one org never sees another's link", () => {
  it("a number in org_b is not visible, nor movable, from SaplingLearn; a non-member reaches nothing in org_b", async () => {
    await ensureMember(A, "owner", ORG_B);
    await ensureMember("bea", "member", ORG_B);
    const b = await linkOf(post(A, "/links", { target: { person: "bea" }, reason: "r" }, "acme"));
    expect(b.id).toBe(1);
    expect(await first(env.DB, `SELECT org_id FROM agent_links WHERE number = 1`)).toEqual({ org_id: ORG_B });

    await refused(get(A, "/links/1"), 404, "not_found");
    await refused(post(A, "/links/1/cancel"), 404, "not_found");
    await refused(post(A, "/links/1/close"), 404, "not_found");
    await refused(post(A, "/links/1/notes", { body: "x" }), 404, "not_found");
    expect(await listOf(A, "mine")).toEqual([]);
    expect(await listOf(A, "mine", "acme")).toHaveLength(1);
    expect(await stateOf(1, ORG_B)).toBe("requested");

    // Jose is not in org_b: the tenant gate's 404, before any link is read
    await refused(get(J, "/links/1", "acme"), 404, "not_found");
    await refused(post(J, "/links/1/accept", {}, "acme"), 404, "not_found");
    // the same number in SaplingLearn is SaplingLearn's own link
    const mine = await start(J, L);
    expect(mine.id).toBe(1);
    await refused(get(A, "/links/1"), 404, "not_found"); // …and Andres is not one of its people
  });
});

describe("the badge", () => {
  it("counts the requests waiting for me — the waiting box's length — and drops one once I accept it", async () => {
    const badge = async (who: string) => (await ok<SidebarBadges>(get(who, "/badges"))).links;
    await start(J, L);
    const second = await start(T, L);
    await start(L, J); // sent by me: not mine to answer
    await start(L, L); // a self-link opens on Send: it never waits
    expect(await badge(L)).toBe(2);
    expect(await badge(L)).toBe((await listOf(L, "waiting")).length);
    await post(L, `/links/${second.id}/accept`);
    expect(await badge(L)).toBe(1);
    expect(await badge(J)).toBe(1);
  });
});

// E2E P-23 (docs/testing/agent-links-test-log.md): the web read carried the OTHER side's session id — an agent's own
// session, or an Ask side's thread id ("the other side's thread is theirs, and its id never reaches this viewer").
describe("a link's other side keeps its session id to itself on the web", () => {
  it("the detail, the boxes and each step's answer null the other side's session; the reader's own side keeps it", async () => {
    const d = await draft(J, L);
    expect(d.requester.session).toBe(`s-${J}`);
    expect((await linkOf(post(J, `/links/${d.id}/send`))).requester.session).toBe(`s-${J}`);
    const accepted = await linkOf(post(L, `/links/${d.id}/accept`));
    expect(accepted.requester).toMatchObject({ handle: J, kind: "chat", session: null });
    expect((await detailOf(get(L, `/links/${d.id}`))).requester).toMatchObject({ kind: "chat", session: null });
    expect((await detailOf(get(J, `/links/${d.id}`))).requester.session).toBe(`s-${J}`);
    expect((await listOf(L, "open"))[0].requester.session).toBeNull();
    expect((await listOf(J, "open"))[0].requester.session).toBe(`s-${J}`);
    expect((await detailOf(post(L, `/links/${d.id}/notes`, { body: "noted" }))).requester.session).toBeNull();
    expect((await linkOf(post(L, `/links/${d.id}/close`))).requester.session).toBeNull();
  });

  it("a self-link's two sides are both the reader's: both keep their session", async () => {
    const d = await draft(J, J);
    const l = await linkOf(post(J, `/links/${d.id}/send`));
    expect(l).toMatchObject({ state: "open", self: true, requester: { session: `s-${J}` } });
  });
});

describe("the list's thread preview (the Links tab's cards and history)", () => {
  it("each listed link carries its newest note, its note count and how many wait for the reader's own session", async () => {
    const l = await opened(J, L);
    expect((await listOf(J, "open"))[0].preview).toEqual({ last: null, notes: 0, waiting: 0 });
    await detailOf(post(J, `/links/${l.id}/notes`, { body: "Renaming authSession tonight." }));
    await detailOf(post(L, `/links/${l.id}/notes`, { body: `First line of a long note ${"x".repeat(200)}\nsecond line` }));
    const mine = (await listOf(J, "open"))[0].preview!;
    expect(mine.notes).toBe(2);
    expect(mine.waiting).toBe(1); // L's note waits for J's side; J's own does not count for J
    expect(mine.last).toMatchObject({ side: "recipient", author: L, author_kind: "person" });
    expect(mine.last!.excerpt.length).toBeLessThanOrEqual(140);
    expect(mine.last!.excerpt.endsWith("…")).toBe(true);
    expect(mine.last!.excerpt).not.toContain("second line");
    expect(JSON.stringify(mine)).not.toMatch(/session/); // a handle and a kind, never a session id
    expect((await listOf(L, "open"))[0].preview).toMatchObject({ notes: 2, waiting: 1 });
    // Once delivered, nothing waits.
    await run(env.DB, `UPDATE agent_link_notes SET delivered_at = ? WHERE org_id = ? AND link_number = ?`, new Date().toISOString(), ORG_A, l.id);
    expect((await listOf(J, "open"))[0].preview!.waiting).toBe(0);
  });

  it("a self-link: every undelivered note waits for one of the reader's sessions; the closed box carries previews too", async () => {
    const self = await start(J, J);
    await detailOf(post(J, `/links/${self.id}/notes`, { body: "from the first session" }));
    await detailOf(post(J, `/links/${self.id}/notes`, { body: "from the second", side: "recipient" }));
    expect((await listOf(J, "open")).find((x) => x.id === self.id)!.preview).toMatchObject({ notes: 2, waiting: 2 });
    await linkOf(post(J, `/links/${self.id}/close`, { reason: "done" }));
    expect((await listOf(J, "closed")).find((x) => x.id === self.id)!.preview).toMatchObject({ notes: 2, last: { excerpt: "from the second" } });
  });
});
