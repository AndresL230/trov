// Sharing an Ask Trov conversation with PEOPLE by name (0077_ask_people_sharing; docs/architecture/ask.md › Sharing a
// conversation): the owner names members of the org, each `read` or `continue`. A named person finds it under "Shared
// with you" (`direct`), the org's other members — when it is also shared with the org — under "Organization". A
// `continue` person asks follow-ups in it AS THEMSELVES; every turn is its asker's (only they edit, regenerate, save,
// flag or decide its cards), and the thread's settings, sharing, export and deletion stay the owner's.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { deleteAccount } from "../src/deletion/person";
import { AskThreadDetailSchema, AskThreadSummarySchema } from "@shared/ai-ask";
import { all, first } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember, platformCtx } from "./helpers/tenant";
import { BASE, KEYED, ask, call, eventsOf, fakeModel, withAsk } from "./helpers/ask";

const OWNER = "ask-owner2";
const READER = "ask-named-reader";
const COLLAB = "ask-collab";
const OTHER = "ask-other-member";
const final = (title = "Plan") => `\n<trov-meta>{"title": "${title}", "followups": ["And then?"]}</trov-meta>`;

/** One answered turn by `cookie` (a `create_ticket` card left proposed) in a new thread, or in `threadId`. */
async function turn(cookie: string, text: string, threadId?: number) {
  const model = fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: `Card for ${text}` } }], [{ type: "text", text: `Answer to ${text}.${final()}` }]]);
  const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text, ...(threadId ? { threadId } : {}) }));
  return {
    status: r.status,
    id: eventsOf(r.events, "thread")[0]?.id as number,
    cardId: eventsOf(r.events, "action")[0]?.id as number,
    messageId: eventsOf(r.events, "done")[0]?.messageId as number,
    questionId: eventsOf(r.events, "done")[0]?.questionId as number,
    sent: model.sent,
  };
}

async function setup() {
  const owner = await cookieFor(OWNER);
  const reader = await cookieFor(READER);
  const collab = await cookieFor(COLLAB);
  const other = await cookieFor(OTHER);
  const t = await turn(owner, "What is the plan?");
  await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { mode: "fast", draft: "owner's unsent words" });
  const shared = await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { people: [{ handle: READER, access: "read" }, { handle: COLLAB, access: "continue" }] });
  expect(shared.status).toBe(200);
  return { owner, reader, collab, other, t };
}

describe("sharing with people by name", () => {
  it("the owner names people; each finds it under Shared with you with what they may do; nobody else sees it", async () => {
    const { owner, reader, collab, other, t } = await setup();
    const mine = await call("GET", `${BASE}/ask/threads`, owner);
    expect(AskThreadSummarySchema.parse(mine.json.threads.find((x: { id: number }) => x.id === t.id))).toMatchObject({
      shared: false, people: [{ handle: READER, access: "read" }, { handle: COLLAB, access: "continue" }],
    });
    const r = (await call("GET", `${BASE}/ask/shared`, reader)).json.threads;
    expect(r).toHaveLength(1);
    expect(AskThreadSummarySchema.parse(r[0])).toMatchObject({ id: t.id, owner: OWNER, viewer: true, access: "read", direct: true, shared: false });
    expect(r[0].people).toBeUndefined();
    expect((await call("GET", `${BASE}/ask/shared`, collab)).json.threads[0]).toMatchObject({ id: t.id, access: "continue", direct: true });
    // Not named, not shared with the org: the one 404, and nothing listed.
    expect((await call("GET", `${BASE}/ask/shared`, other)).json.threads).toEqual([]);
    expect((await call("GET", `${BASE}/ask/threads/${t.id}`, other))).toMatchObject({ status: 404, json: { error: "not_found" } });
    // Shared with the org too: the other member finds it under Organization; the named people still under Shared
    // with you, once.
    await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { shared: true });
    expect((await call("GET", `${BASE}/ask/shared`, other)).json.threads).toEqual([expect.objectContaining({ id: t.id, access: "read", direct: false, shared: true })]);
    expect((await call("GET", `${BASE}/ask/shared`, reader)).json.threads).toEqual([expect.objectContaining({ id: t.id, access: "read", direct: true })]);
    // A named reader's detail: whose it is, what they may do, none of the owner's settings.
    const d = AskThreadDetailSchema.parse((await call("GET", `${BASE}/ask/threads/${t.id}`, reader)).json);
    expect(d.thread).toMatchObject({ viewer: true, owner: OWNER, access: "read", direct: true, draft: "" });
    expect(d.messages.every((m) => m.askedBy === OWNER)).toBe(true);
  });

  it("the share list is checked whole: a non-member, the owner, a duplicate or another org's member writes nothing", async () => {
    const { owner, t } = await setup();
    await cookieFor("ask-elsewhere", { member: false });
    await ensureMember("ask-elsewhere", "member", ORG_B);
    for (const people of [
      [{ handle: "nobody-here", access: "read" }],
      [{ handle: OWNER, access: "continue" }],
      [{ handle: READER, access: "read" }, { handle: READER.toUpperCase(), access: "continue" }],
      [{ handle: "ask-elsewhere", access: "read" }],
    ]) {
      const r = await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { people, title: "Renamed" });
      expect(r.status, JSON.stringify(people)).toBe(400);
    }
    expect(await all(env.DB, `SELECT handle, access FROM chat_thread_people WHERE thread_id = ? ORDER BY handle`, t.id))
      .toEqual([{ handle: COLLAB, access: "continue" }, { handle: READER, access: "read" }]);
    expect((await first<{ title: string }>(env.DB, `SELECT title FROM chat_threads WHERE id = ?`, t.id))!.title).toBe("Plan");
    // A handle in another spelling is stored as the member's own.
    await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { people: [{ handle: READER.toUpperCase(), access: "continue" }] });
    expect(await all(env.DB, `SELECT handle, access FROM chat_thread_people WHERE thread_id = ?`, t.id)).toEqual([{ handle: READER, access: "continue" }]);
  });

  it("a person who can continue asks as themselves: their turn, the owner's settings untouched, earlier questions said to be the owner's", async () => {
    const { owner, collab, t } = await setup();
    const c = await turn(collab, "Can I add a step?", t.id);
    expect(c.status).toBe(200);
    expect(c.id).toBe(t.id);
    // The model is told whose the earlier question was.
    const history = JSON.stringify(c.sent[0].messages);
    expect(history).toContain(`(Asked by @${OWNER}, not the person asking now.) What is the plan?`);
    expect(history).not.toContain("(Asked by @ask-collab");
    // Stored as theirs; the thread's mode and the owner's draft are the owner's still.
    expect(await all(env.DB, `SELECT role, asked_by FROM chat_messages WHERE thread_id = ? AND asked_by IS NOT NULL AND asked_by = ? ORDER BY id`, t.id, COLLAB))
      .toEqual([{ role: "user", asked_by: COLLAB }, { role: "assistant", asked_by: COLLAB }]);
    expect((await first(env.DB, `SELECT mode, draft FROM chat_threads WHERE id = ?`, t.id))).toEqual({ mode: "fast", draft: "owner's unsent words" });
    expect((await first<{ asked_by: string }>(env.DB, `SELECT asked_by FROM chat_actions WHERE id = ?`, c.cardId))!.asked_by).toBe(COLLAB);
    // It stays in their Shared with you, never their own list.
    expect((await call("GET", `${BASE}/ask/threads`, collab)).json.threads).toEqual([]);
    // Each reads the other's turn as the other's: who asked it, and its card is not theirs to decide.
    const asOwner = AskThreadDetailSchema.parse((await call("GET", `${BASE}/ask/threads/${t.id}`, owner)).json);
    expect(asOwner.messages.map((m) => [m.role, m.askedBy])).toEqual([["user", OWNER], ["assistant", OWNER], ["user", COLLAB], ["assistant", COLLAB]]);
    expect(asOwner.messages[3].actions[0]).toMatchObject({ state: "proposed", editable: [], undo: false });
    const asCollab = AskThreadDetailSchema.parse((await call("GET", `${BASE}/ask/threads/${t.id}`, collab)).json);
    expect(asCollab.thread).toMatchObject({ access: "continue", viewer: true });
    expect(asCollab.messages[3].actions[0].editable.length).toBeGreaterThan(0);
  });

  it("every turn is its asker's: edit, regenerate, cards, save and Wrong? only on your own; settings, sharing, export and delete only the owner's", async () => {
    const { owner, collab, t } = await setup();
    // The owner's own turn is the last: the collaborator can't regenerate it (and the owner's card expires with it
    // once a new turn starts, so decide on the collaborator's).
    const nope = await withAsk({ fetchImpl: fakeModel([]).fetchImpl }, () => ask(collab, { threadId: t.id, text: "", replaceFrom: t.messageId }));
    expect(nope.status).toBe(403);
    expect((await call("POST", `${BASE}/ask/actions/${t.cardId}/confirm`, collab, {})).status).toBe(404);
    expect((await call("POST", `${BASE}/ask/messages/${t.messageId}/wrong`, collab, { reason: "missed" })).status).toBe(404);
    expect((await call("POST", `${BASE}/ask/messages/${t.messageId}/save-form`, collab, {})).status).toBe(404);
    expect((await call("POST", `${BASE}/ask/threads/${t.id}/save`, collab, { messageId: t.messageId })).status).toBe(404);

    const c = await turn(collab, "Add a step", t.id);
    // Now the collaborator's turn is the last: the OWNER can't regenerate it or decide its card.
    const ownerRegen = await withAsk({ fetchImpl: fakeModel([]).fetchImpl }, () => ask(owner, { threadId: t.id, text: "", replaceFrom: c.messageId }));
    expect(ownerRegen.status).toBe(403);
    expect((await call("POST", `${BASE}/ask/actions/${c.cardId}/cancel`, owner, {})).status).toBe(404);
    // The collaborator decides their own card, flags and saves their own answer.
    expect((await call("POST", `${BASE}/ask/actions/${c.cardId}/cancel`, collab, {})).status).toBe(200);
    expect((await call("POST", `${BASE}/ask/messages/${c.messageId}/wrong`, collab, { reason: "missed" })).status).toBe(200);
    expect((await call("POST", `${BASE}/ask/messages/${c.messageId}/save-form`, collab, {})).status).toBe(200);
    const saved = await call("POST", `${BASE}/ask/threads/${t.id}/save`, collab, { messageId: c.messageId, title: "My step" });
    expect(saved.status).toBe(200);
    expect((await first<{ author_id: string }>(env.DB, `SELECT author_id FROM artifact_pages WHERE slug = ?`, saved.json.slug))!.author_id).toBe(COLLAB);
    // Regenerating their own last answer works.
    const regen = await withAsk({ fetchImpl: fakeModel([[{ type: "text", text: `Again.${final()}` }]]).fetchImpl }, () => ask(collab, { threadId: t.id, text: "", replaceFrom: c.messageId }));
    expect(regen.status).toBe(200);
    expect(eventsOf(regen.events, "done")).toHaveLength(1);
    // Stop is theirs too; everything that is the thread's is the owner's alone.
    expect((await call("POST", `${BASE}/ask/threads/${t.id}/stop`, collab, {})).status).toBe(200);
    for (const [method, path, body] of [
      ["PATCH", `/ask/threads/${t.id}`, { title: "Mine now" }],
      ["PATCH", `/ask/threads/${t.id}`, { people: [] }],
      ["PATCH", `/ask/threads/${t.id}`, { shared: true }],
      ["DELETE", `/ask/threads/${t.id}`, undefined],
      ["GET", `/ask/threads/${t.id}/export`, undefined],
      ["POST", `/ask/threads/${t.id}/save`, { title: "Whole thread" }],
    ] as const) {
      expect((await call(method, `${BASE}${path}`, collab, body)).status, `${method} ${path}`).toBe(404);
    }
    expect(await all(env.DB, `SELECT handle FROM chat_thread_people WHERE thread_id = ?`, t.id)).toHaveLength(2);
  });

  it("a named reader can't continue; taking a person off, or making them a reader, ends what they could do at once", async () => {
    const { owner, reader, collab, t } = await setup();
    expect((await turn(reader, "hijack", t.id)).status).toBe(404);
    await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { people: [{ handle: COLLAB, access: "read" }] });
    expect((await turn(collab, "still me?", t.id)).status).toBe(404);
    expect((await call("GET", `${BASE}/ask/threads/${t.id}`, collab)).json.thread).toMatchObject({ access: "read" });
    expect((await call("GET", `${BASE}/ask/threads/${t.id}`, reader)).status).toBe(404);
    await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { people: [] });
    expect((await call("GET", `${BASE}/ask/threads/${t.id}`, collab)).status).toBe(404);
    expect((await call("GET", `${BASE}/ask/shared`, collab)).json.threads).toEqual([]);
    // The owner removed from the org: nobody reads it, by name either.
    await call("PATCH", `${BASE}/ask/threads/${t.id}`, owner, { people: [{ handle: COLLAB, access: "continue" }] });
    await env.DB.prepare(`DELETE FROM memberships WHERE org_id = ? AND user_id = ?`).bind(ORG_A, OWNER).run();
    expect((await call("GET", `${BASE}/ask/threads/${t.id}`, collab)).status).toBe(404);
    expect((await call("GET", `${BASE}/ask/shared`, collab)).json.threads).toEqual([]);
  });

  it("files stay their uploader's: a collaborator's file is name-only to the owner, and nobody sends someone else's", async () => {
    const { owner, collab, t } = await setup();
    const upload = async (cookie: string, name: string) => {
      const form = new FormData();
      form.append("file", new File([`# ${name}\n\nprivate words`], name, { type: "text/markdown" }));
      form.append("threadId", String(t.id));
      const res = await app.request(`${BASE}/ask/attachments`, { method: "POST", headers: { cookie }, body: form }, KEYED);
      return { status: res.status, body: await res.json() as { attachments: { id: number; slug: string }[] } };
    };
    const ownersFile = (await upload(owner, "owner.md")).body.attachments[0];
    const up = await upload(collab, "collab.md");
    expect(up.status).toBe(200);
    const mine = up.body.attachments[0];
    // The owner's unsent upload is not the collaborator's to send: only their own goes with their question.
    const model = fakeModel([[{ type: "text", text: `Read.${final()}` }]]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(collab, { threadId: t.id, text: "Read mine", attachments: [mine.id, ownersFile.id] }));
    expect(r.status).toBe(200);
    expect(JSON.stringify(model.sent[0].messages)).not.toContain("owner.md");
    expect((await first<{ message_id: number | null }>(env.DB, `SELECT message_id FROM chat_artifacts WHERE id = ?`, ownersFile.id))!.message_id).toBeNull();
    const asOwner = AskThreadDetailSchema.parse((await call("GET", `${BASE}/ask/threads/${t.id}`, owner)).json);
    const q = asOwner.messages.find((m) => m.text === "Read mine")!;
    expect(q.attachments).toEqual([expect.objectContaining({ title: "collab.md", slug: "", sha256: "" })]);
    const asCollab = AskThreadDetailSchema.parse((await call("GET", `${BASE}/ask/threads/${t.id}`, collab)).json);
    expect(asCollab.messages.find((m) => m.text === "Read mine")!.attachments[0].slug).toBe(mine.slug);
    // The collaborator removes their own unsent upload; never the owner's.
    const again = (await upload(collab, "draft.md")).body.attachments[0];
    expect((await call("DELETE", `${BASE}/ask/attachments/${again.id}`, collab)).status).toBe(200);
    expect((await call("DELETE", `${BASE}/ask/attachments/${ownersFile.id}`, collab)).status).toBe(404);
  });
});

describe("deleting, with people named", () => {
  it("the owner's Delete takes the shares; a collaborator's file stays theirs, private", async () => {
    const { owner, collab, t } = await setup();
    const form = new FormData();
    form.append("file", new File(["mine"], "collab.md", { type: "text/markdown" }));
    form.append("threadId", String(t.id));
    const up = await (await app.request(`${BASE}/ask/attachments`, { method: "POST", headers: { cookie: collab }, body: form }, KEYED)).json() as { attachments: { id: number; slug: string }[] };
    await withAsk({ fetchImpl: fakeModel([[{ type: "text", text: `Ok.${final()}` }]]).fetchImpl }, () => ask(collab, { threadId: t.id, text: "Here", attachments: [up.attachments[0].id] }));
    expect((await call("DELETE", `${BASE}/ask/threads/${t.id}`, owner)).status).toBe(200);
    expect(await all(env.DB, `SELECT handle FROM chat_thread_people WHERE thread_id = ?`, t.id)).toEqual([]);
    expect((await call("GET", `${BASE}/ask/shared`, collab)).json.threads).toEqual([]);
    expect(await all(env.DB, `SELECT author_id, visibility FROM artifact_pages WHERE slug = ?`, up.attachments[0].slug)).toEqual([{ author_id: COLLAB, visibility: "private" }]);
  });

  it("deleting a collaborator's ACCOUNT: their shares and files go, their turns stay under the tombstone", async () => {
    const { owner, collab, t } = await setup();
    const form = new FormData();
    form.append("file", new File(["mine"], "collab.md", { type: "text/markdown" }));
    form.append("threadId", String(t.id));
    const up = await (await app.request(`${BASE}/ask/attachments`, { method: "POST", headers: { cookie: collab }, body: form }, KEYED)).json() as { attachments: { id: number; slug: string }[] };
    await withAsk({ fetchImpl: fakeModel([[{ type: "text", text: `Ok.${final()}` }]]).fetchImpl }, () => ask(collab, { threadId: t.id, text: "Here", attachments: [up.attachments[0].id] }));
    const { tombstone } = await deleteAccount(env as unknown as Env, platformCtx(), COLLAB, { by: "self", actor: COLLAB });
    expect(await all(env.DB, `SELECT handle FROM chat_thread_people WHERE handle = ? OR handle = ?`, COLLAB, tombstone)).toEqual([]);
    expect(await all(env.DB, `SELECT id FROM artifact_pages WHERE slug = ?`, up.attachments[0].slug)).toEqual([]);
    expect(await all(env.DB, `SELECT id FROM chat_artifacts WHERE thread_id = ?`, t.id)).toEqual([]);
    expect(await all(env.DB, `SELECT asked_by FROM chat_messages WHERE thread_id = ? AND asked_by IS NOT NULL AND asked_by <> ? ORDER BY id`, t.id, OWNER))
      .toEqual([{ asked_by: tombstone }, { asked_by: tombstone }]);
    // The owner's conversation is whole.
    const d = AskThreadDetailSchema.parse((await call("GET", `${BASE}/ask/threads/${t.id}`, owner)).json);
    expect(d.messages.map((m) => m.text)).toEqual(["What is the plan?", "Answer to What is the plan?.", "Here", "Ok."]);
  });

  it("deleting the owner's ACCOUNT takes every share of their threads", async () => {
    const { t } = await setup();
    await deleteAccount(env as unknown as Env, platformCtx(), OWNER, { by: "self", actor: OWNER });
    expect(await all(env.DB, `SELECT handle FROM chat_thread_people WHERE thread_id = ?`, t.id)).toEqual([]);
  });
});
