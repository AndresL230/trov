// Sharing an Ask Trov conversation with the org (0076_ask_sharing; docs/architecture/ask.md › Sharing a conversation):
// the OWNER shares (and stops sharing) through the cookie PATCH; any LIVE member of the SAME org then reads it
// read-only — listed by `GET /ask/shared` — and nobody else: another org, a non-member, a private thread, a removed
// owner's, an unknown id are the one 404. Only the owner continues, renames, pins, exports, saves or deletes it, and
// decides its cards. What the stored answer resolved for the owner is resolved again for the reader (an item only the
// owner can see never shows), and the owner's PRIVATE attachments show by name only.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { create_ticket } from "../src/tools/tickets";
import { createPage } from "../src/tools/artifacts";
import { resolveViews } from "../src/ai/ask/refs";
import { deleteAccount } from "../src/deletion/person";
import { AskThreadDetailSchema, AskThreadSummarySchema } from "@shared/ai-ask";
import { all, first, run } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember, platformCtx, tenantCtx } from "./helpers/tenant";
import { BASE, KEYED, ask, call, eventsOf, fakeModel, threadOf, withAsk } from "./helpers/ask";

const OWNER = "ask-sharer";
const READER = "ask-reader";
const final = (title = "Shared") => `\n<trov-meta>{"title": "${title}", "followups": ["And then?"]}</trov-meta>`;

/** A thread of OWNER's with one answered question (a `create_ticket` card left proposed), and its ids. */
async function ownersThread(cookie: string, text = "What is the plan?") {
  const model = fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Shared card" } }], [{ type: "text", text: `The plan is simple.${final()}` }]]);
  const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text }));
  return {
    id: eventsOf(r.events, "thread")[0].id as number,
    cardId: eventsOf(r.events, "action")[0].id as number,
    messageId: eventsOf(r.events, "done")[0].messageId as number,
  };
}

describe("sharing a conversation with the org", () => {
  it("the owner shares it; another member finds it under Shared and reads it read-only — whose it is, none of the owner's settings", async () => {
    const owner = await cookieFor(OWNER);
    const reader = await cookieFor(READER);
    const t = await ownersThread(owner);
    await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { pinned: true, draft: "my unsent words" });
    // Private until shared: the reader can neither list nor open it.
    expect((await call("GET", `${BASE}/ask/shared`, reader)).json.threads).toEqual([]);
    const before = await call("GET", `${BASE}/ask/threads/${t.id}`, reader);
    expect(before.status).toBe(404);
    expect(before.json).toEqual({ error: "not_found" });

    const shared = await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { shared: true });
    expect(shared.status).toBe(200);
    expect(AskThreadSummarySchema.parse(shared.json.thread)).toMatchObject({ id: t.id, shared: true, pinned: true });
    expect((await first<{ shared_at: string | null }>(env.DB, `SELECT shared_at FROM chat_threads WHERE id = ?`, t.id))!.shared_at).not.toBeNull();
    // The owner's own list says so; the owner's Shared list is other people's only.
    expect((await call("GET", `${BASE}/ask/threads`, owner)).json.threads.find((x: { id: number }) => x.id === t.id)).toMatchObject({ shared: true });
    expect((await call("GET", `${BASE}/ask/shared`, owner)).json.threads).toEqual([]);

    const list = await call("GET", `${BASE}/ask/shared`, reader);
    expect(list.status).toBe(200);
    expect(list.json.threads).toHaveLength(1);
    expect(AskThreadSummarySchema.parse(list.json.threads[0])).toMatchObject({ id: t.id, title: "Shared", owner: OWNER, viewer: true, shared: true, pinned: false, hasDraft: false });

    const read = await call("GET", `${BASE}/ask/threads/${t.id}`, reader);
    expect(read.status).toBe(200);
    const d = AskThreadDetailSchema.parse(read.json);
    expect(d.thread).toMatchObject({ id: t.id, owner: OWNER, viewer: true, shared: true, draft: "", pinned: false, auto: false });
    expect(d.messages.map((m) => [m.role, m.text])).toEqual([["user", "What is the plan?"], ["assistant", "The plan is simple."]]);
    // Its proposed card shows, but it can't be decided from here.
    expect(d.messages[1].actions).toHaveLength(1);
    expect(d.messages[1].actions[0]).toMatchObject({ state: "proposed", editable: [], undo: false });
    expect(read.text).not.toContain("my unsent words");
    // The owner still reads their own, with their own settings.
    expect((await call("GET", `${BASE}/ask/threads/${t.id}`, owner)).json.thread).toMatchObject({ draft: "my unsent words", pinned: true, shared: true });
    expect((await call("GET", `${BASE}/ask/threads/${t.id}`, owner)).json.thread.viewer).toBeUndefined();
  });

  it("a reader can't continue, rename, pin, share, stop, export, save, flag, decide or delete it — each the same 404, nothing written", async () => {
    const owner = await cookieFor(OWNER);
    const reader = await cookieFor(READER);
    const t = await ownersThread(owner);
    await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { shared: true });
    const nf = { error: "not_found" };
    const continued = await withAsk({ fetchImpl: fakeModel([]).fetchImpl }, () => ask(reader, { threadId: t.id, text: "hijack" }));
    expect(continued.status).toBe(404);
    for (const [method, path, body] of [
      ["PATCH", `/ask/threads/${t.id}`, { title: "Mine now" }],
      ["PATCH", `/ask/threads/${t.id}`, { shared: false }],
      ["PATCH", `/ask/threads/${t.id}`, { pinned: true }],
      ["DELETE", `/ask/threads/${t.id}`, undefined],
      ["POST", `/ask/threads/${t.id}/stop`, {}],
      ["GET", `/ask/threads/${t.id}/export`, undefined],
      ["POST", `/ask/threads/${t.id}/save`, { title: "Copy" }],
      ["POST", `/ask/messages/${t.messageId}/save-form`, {}],
      ["POST", `/ask/messages/${t.messageId}/wrong`, { reason: "missed" }],
      ["POST", `/ask/actions/${t.cardId}/confirm`, {}],
      ["POST", `/ask/actions/${t.cardId}/cancel`, {}],
      ["POST", `/ask/actions/${t.cardId}/undo`, {}],
    ] as const) {
      const r = await call(method, `${BASE}${path}`, reader, body);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json, `${method} ${path}`).toEqual(nf);
    }
    // An upload into it is refused the same way.
    const form = new FormData();
    form.append("file", new File(["x"], "x.txt", { type: "text/plain" }));
    form.append("threadId", String(t.id));
    expect((await app.request(`${BASE}/ask/attachments`, { method: "POST", headers: { cookie: reader }, body: form }, KEYED)).status).toBe(404);
    // Nothing changed: the title, the share, the card, the messages, no feedback, no artifact.
    expect(await first(env.DB, `SELECT title, pinned, shared_at IS NOT NULL AS shared FROM chat_threads WHERE id = ?`, t.id)).toEqual({ title: "Shared", pinned: 0, shared: 1 });
    expect((await first<{ state: string }>(env.DB, `SELECT state FROM chat_actions WHERE id = ?`, t.cardId))!.state).toBe("proposed");
    expect(await all(env.DB, `SELECT id FROM chat_messages WHERE thread_id = ?`, t.id)).toHaveLength(2);
    expect(await all(env.DB, `SELECT id FROM ai_feedback WHERE handle = ?`, READER)).toEqual([]);
    expect(await all(env.DB, `SELECT id FROM artifact_pages WHERE author_id = ?`, READER)).toEqual([]);
    // A bearer is refused outright, as on every Ask route: sharing is never an agent's step.
    expect((await call("GET", `${BASE}/ask/shared`, reader, undefined, KEYED, { authorization: "Bearer trov_mcp_x" })).status).toBe(403);
  });

  it("stop sharing: the reader's list and link go at once; sharing again keeps the first share's time", async () => {
    const owner = await cookieFor(OWNER);
    const reader = await cookieFor(READER);
    const t = await ownersThread(owner);
    await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { shared: true });
    const at = (await first<{ shared_at: string }>(env.DB, `SELECT shared_at FROM chat_threads WHERE id = ?`, t.id))!.shared_at;
    await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { shared: true });
    expect((await first<{ shared_at: string }>(env.DB, `SELECT shared_at FROM chat_threads WHERE id = ?`, t.id))!.shared_at).toBe(at);
    const off = await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { shared: false });
    expect(off.json.thread).toMatchObject({ shared: false });
    expect((await call("GET", `${BASE}/ask/threads/${t.id}`, reader)).status).toBe(404);
    expect((await call("GET", `${BASE}/ask/shared`, reader)).json.threads).toEqual([]);
  });

  it("another org, a person in no org, a removed owner, an unknown id, a pending holder: never readable, never listed", async () => {
    const owner = await cookieFor(OWNER);
    const t = await ownersThread(owner);
    await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { shared: true });
    // A member of ANOTHER org only: its routes never see the thread, and SaplingLearn's refuse them.
    const outsider = await cookieFor("ask-outsider", { member: false });
    await ensureMember("ask-outsider", "member", ORG_B);
    expect((await call("GET", `/api/o/acme/ask/threads/${t.id}`, outsider)).status).toBe(404);
    expect((await call("GET", `/api/o/acme/ask/shared`, outsider)).json.threads).toEqual([]);
    expect((await call("GET", `${BASE}/ask/threads/${t.id}`, outsider)).status).not.toBe(200);
    expect((await call("GET", `${BASE}/ask/shared`, outsider)).status).not.toBe(200);
    // The OWNER, in another org they also belong to: the thread is SaplingLearn's alone.
    await ensureMember(OWNER, "member", ORG_B);
    expect((await call("GET", `/api/o/acme/ask/threads/${t.id}`, owner)).status).toBe(404);
    // A person in no org at all.
    const nobody = await cookieFor("ask-nobody", { member: false });
    expect((await call("GET", `${BASE}/ask/threads/${t.id}`, nobody)).status).not.toBe(200);
    // An unknown id reads exactly like a private one.
    const reader = await cookieFor(READER);
    expect(await call("GET", `${BASE}/ask/threads/987654`, reader)).toMatchObject({ status: 404, json: { error: "not_found" } });
    // The owner's hidden holder of pending files (0068) can't be shared: no route opens it.
    const form = new FormData();
    form.append("file", new File(["x"], "x.txt", { type: "text/plain" }));
    await app.request(`${BASE}/ask/attachments`, { method: "POST", headers: { cookie: owner }, body: form }, KEYED);
    const holder = (await first<{ id: number }>(env.DB, `SELECT id FROM chat_threads WHERE org_id = ? AND handle = ? AND pending = 1`, ORG_A, OWNER))!.id;
    expect((await call("PATCH", `${BASE}/ask/threads/${holder}`, owner, { shared: true })).status).toBe(404);
    await run(env.DB, `UPDATE chat_threads SET shared_at = '2026-10-17T00:00:00Z' WHERE id = ?`, holder);
    expect((await call("GET", `${BASE}/ask/threads/${holder}`, reader)).status).toBe(404);
    expect((await call("GET", `${BASE}/ask/shared`, reader)).json.threads.map((x: { id: number }) => x.id)).toEqual([t.id]);
    // The owner removed from the org: they could no longer stop sharing it, so nobody reads it.
    await run(env.DB, `DELETE FROM memberships WHERE org_id = ? AND user_id = ?`, ORG_A, OWNER);
    expect((await call("GET", `${BASE}/ask/threads/${t.id}`, reader)).status).toBe(404);
    expect((await call("GET", `${BASE}/ask/shared`, reader)).json.threads).toEqual([]);
  });

  it("what only the owner can see stays theirs: a private artifact's view drops out, attachments show by name only", async () => {
    const owner = await cookieFor(OWNER);
    const reader = await cookieFor(READER);
    const octx = await tenantCtx(OWNER);
    const secret = await createPage(octx, { title: "Owner secret plan", kind: "markdown", area: "data", repo: "", visibility: "private", content: "x" }, OWNER);
    const n = await create_ticket(octx, { title: "Everyone sees this", body: "", category: "bug", priority: "normal", assignees: [] }, OWNER);
    const threadId = await threadOf(owner);
    // A file the owner attached (a PRIVATE artifact), sent with a question.
    const form = new FormData();
    form.append("file", new File(["# Notes\n\nthe private notes"], "notes.md", { type: "text/markdown" }));
    form.append("threadId", String(threadId));
    const up = await (await app.request(`${BASE}/ask/attachments`, { method: "POST", headers: { cookie: owner }, body: form }, KEYED)).json() as { attachments: { id: number; slug: string }[] };
    const file = up.attachments[0];
    const model = fakeModel([[{ type: "text", text: `Read it.${final()}` }]]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(owner, { threadId, text: "Read my notes", attachments: [file.id] }));
    const messageId = eventsOf(r.events, "done")[0].messageId as number;
    // The stored answer cites the owner's private page and a ticket (as the OWNER resolved them).
    const views = await resolveViews(octx, OWNER, [`artifact:${secret.slug}`, `ticket:${n}`]);
    const cited = [views.get(`artifact:${secret.slug}`)!, views.get(`ticket:${n}`)!];
    expect(cited[0].title).toBe("Owner secret plan");
    const content = JSON.parse((await first<{ content_json: string }>(env.DB, `SELECT content_json FROM chat_messages WHERE id = ?`, messageId))!.content_json);
    content.blocks = [{ kind: "items", items: cited }];
    content.activity = [{ step: 1, tool: "search", icon: "search", label: "Searched", results: cited.map((v) => v.ref), resultLine: "2 results" }];
    await run(env.DB, `UPDATE chat_messages SET cites_json = ?, content_json = ? WHERE id = ?`, JSON.stringify(cited), JSON.stringify(content), messageId);
    await call("PATCH", `${BASE}/ask/threads/${threadId}`, owner, { shared: true });

    const read = await call("GET", `${BASE}/ask/threads/${threadId}`, reader);
    expect(read.status).toBe(200);
    const d = AskThreadDetailSchema.parse(read.json);
    const q = d.messages.find((m) => m.text === "Read my notes")!;
    const a = d.messages.find((m) => m.id === messageId)!;
    expect(a.cites.map((c) => c.ref)).toEqual([`ticket:${n}`]);
    expect(a.blocks).toEqual([{ kind: "items", items: [expect.objectContaining({ ref: `ticket:${n}` })] }]);
    expect(a.activity[0].results).toEqual([`ticket:${n}`]);
    // The file: its name, kind and size — never its address, hash or preview.
    expect(q.attachments).toEqual([expect.objectContaining({ title: "notes.md", kind: "text", slug: "", sha256: "" })]);
    expect(q.attachments[0].thumbUrl).toBeUndefined();
    expect(read.text).not.toContain("Owner secret plan");
    expect(read.text).not.toContain(secret.slug);
    expect(read.text).not.toContain(file.slug);
    // Opening either stays the private artifact's own rule: the reader gets the one "hidden".
    expect((await call("GET", `${BASE}/ask/item/${encodeURIComponent(`artifact:${file.slug}`)}`, reader)).status).toBe(404);
    expect((await call("POST", `${BASE}/ask/peek`, reader, { refs: [`artifact:${secret.slug}`] })).json.items[0]).toEqual({ ref: `artifact:${secret.slug}`, hidden: true });
    // The owner's own read keeps everything.
    const mine = AskThreadDetailSchema.parse((await call("GET", `${BASE}/ask/threads/${threadId}`, owner)).json);
    expect(mine.messages.find((m) => m.id === messageId)!.cites.map((c) => c.ref)).toEqual([`artifact:${secret.slug}`, `ticket:${n}`]);
    expect(mine.messages.find((m) => m.text === "Read my notes")!.attachments[0].slug).toBe(file.slug);
  });
});

describe("deleting a shared conversation", () => {
  it("the owner's Delete deletes it for everyone (rows and the private attachment)", async () => {
    const owner = await cookieFor(OWNER);
    const reader = await cookieFor(READER);
    const threadId = await threadOf(owner);
    const form = new FormData();
    form.append("file", new File(["notes"], "notes.md", { type: "text/markdown" }));
    form.append("threadId", String(threadId));
    await app.request(`${BASE}/ask/attachments`, { method: "POST", headers: { cookie: owner }, body: form }, KEYED);
    await call("PATCH", `${BASE}/ask/threads/${threadId}`, owner, { shared: true });
    expect((await call("GET", `${BASE}/ask/threads/${threadId}`, reader)).status).toBe(200);
    expect((await call("DELETE", `${BASE}/ask/threads/${threadId}`, owner)).status).toBe(200);
    expect((await call("GET", `${BASE}/ask/threads/${threadId}`, reader)).status).toBe(404);
    expect((await call("GET", `${BASE}/ask/shared`, reader)).json.threads).toEqual([]);
    expect(await all(env.DB, `SELECT id FROM chat_threads WHERE id = ?`, threadId)).toEqual([]);
    expect(await all(env.DB, `SELECT id FROM chat_artifacts WHERE thread_id = ?`, threadId)).toEqual([]);
    expect(await all(env.DB, `SELECT id FROM artifact_pages WHERE org_id = ? AND author_id = ? AND visibility = 'private'`, ORG_A, OWNER)).toEqual([]);
  });

  it("deleting the owner's ACCOUNT takes their shared conversations with it", async () => {
    const owner = await cookieFor(OWNER);
    const reader = await cookieFor(READER);
    const t = await ownersThread(owner);
    await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { shared: true });
    await deleteAccount(env as unknown as Env, platformCtx(), OWNER, { by: "self", actor: OWNER });
    expect(await all(env.DB, `SELECT id FROM chat_threads WHERE id = ?`, t.id)).toEqual([]);
    expect((await call("GET", `${BASE}/ask/threads/${t.id}`, reader)).status).toBe(404);
    expect((await call("GET", `${BASE}/ask/shared`, reader)).json.threads).toEqual([]);
  });
});
