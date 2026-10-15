// Ask Trov's write cards (src/ai/ask/actions.ts and the confirm / cancel / undo routes; docs/architecture/ask.md
// › Write cards): no write runs without Confirm unless Auto is on and allowed; the 5-write Auto cap; never in Auto
// for update_plan and a Publish; Publish only for someone who may promote; editable fields re-validated; groups;
// Undo refuses when the item changed since; a card is never confirmed twice and expires with its turn.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { create_ticket, edit_ticket } from "../src/tools/tickets";
import { ingestDocProposal } from "../src/consumer";
import { WRITES, mayPromote } from "../src/ai/ask/actions";
import type { AskToolCtx } from "../src/ai/ask/context";
import { all, first, run } from "./helpers/db";
import { FIXTURE_ADMIN, cookieFor } from "./helpers/persons";
import { ORG_A, bearerCtx, tenantCtx } from "./helpers/tenant";
import { BASE, KEYED, ask, call, eventsOf, fakeModel, withAsk, type StreamBlock } from "./helpers/ask";

const ME = "ask-writer";
const final = "\n<trov-meta>{\"title\": \"Cards\", \"followups\": []}</trov-meta>";
const answer = (text = "Done."): StreamBlock[] => [{ type: "text", text: `${text}${final}` }];
const tickets = (title: string) => all<{ number: number; requester: string; status: string }>(env.DB, `SELECT number, requester, status FROM tickets WHERE org_id = ? AND title = ?`, ORG_A, title);
async function myTicket(title: string): Promise<number> {
  return create_ticket(await tenantCtx("AndresL230"), { title, body: "b", category: "other", priority: "normal", assignees: [ME] }, "AndresL230");
}
const setAuto = (on: boolean) => run(env.DB, `UPDATE orgs SET ai_chat_auto = ? WHERE id = ?`, on ? 1 : 0, ORG_A);

describe("no write runs without Confirm (unless Auto is on and allowed)", () => {
  it("a write becomes a PROPOSED card with a server-built preview; nothing is written until Confirm, which writes AS the person — once", async () => {
    const cookie = await cookieFor(ME);
    const model = fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Card-made ticket", priority: "high", assignees: [ME] } }], answer("A card.")]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "file it" }));
    const card = eventsOf(r.events, "action")[0];
    expect(card).toMatchObject({ tool: "create_ticket", kind: "ticket", state: "proposed", editable: ["title", "category", "priority", "assignee"],
      fields: { title: "Card-made ticket", priority: "high", assignee: ME } });
    expect(card.preview.title).toBe("New ticket");
    expect(card.preview.lines).toContainEqual({ label: "Assignee", value: `@${ME}` });
    // The model was told it did NOT run.
    expect((model.sent[1].messages.at(-1)!.content as { content: string }[])[0].content).toMatch(/^NOT run/);
    expect(await tickets("Card-made ticket")).toEqual([]);

    const ok = await call("POST", `${BASE}/ask/actions/${card.id}/confirm`, cookie, {});
    expect(ok.status).toBe(200);
    expect(ok.json.results[0]).toMatchObject({ id: card.id, state: "confirmed", undo: true });
    const made = await tickets("Card-made ticket");
    expect(made).toHaveLength(1);
    expect(made[0].requester).toBe(ME); // the author is the cookie person
    expect(ok.json.results[0].ref).toBe(`ticket:${made[0].number}`);
    // e2e AU-9: the thread read gives the decided card the same ref, so a reloaded done line still says
    // "Created ticket #N" and links it (it said "Created ticket #null" / "Created the ticket").
    const tid = eventsOf(r.events, "thread")[0].id;
    const read = await call("GET", `${BASE}/ask/threads/${tid}`, cookie);
    const stored = (read.json.messages as { actions: { id: number; ref: string | null }[] }[]).flatMap((m) => m.actions).find((x) => x.id === card.id);
    expect(stored?.ref).toBe(`ticket:${made[0].number}`);
    // Never twice.
    const again = await call("POST", `${BASE}/ask/actions/${card.id}/confirm`, cookie, {});
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("already");
    expect(await tickets("Card-made ticket")).toHaveLength(1);
  });

  it("two Confirms racing for one card: exactly one runs it (the one guarded claim)", async () => {
    const cookie = await cookieFor(ME);
    const model = fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Raced ticket" } }], answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "file it" }));
    const card = eventsOf(r.events, "action")[0];
    const both = await Promise.all([1, 2, 3].map(() => call("POST", `${BASE}/ask/actions/${card.id}/confirm`, cookie, {})));
    expect(both.map((x) => x.status).sort()).toEqual([200, 409, 409]);
    expect(await tickets("Raced ticket")).toHaveLength(1);
  });

  it("Cancel drops it; a cancelled card cannot be confirmed; a card EXPIRES with its turn", async () => {
    const cookie = await cookieFor(ME);
    const model = fakeModel([
      [{ type: "tool_use", name: "create_ticket", input: { title: "Cancel me" } }, { type: "tool_use", name: "create_ticket", input: { title: "Let me expire" } }],
      answer(), answer("Next turn."),
    ]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "two" }));
    const [a, b] = eventsOf(r.events, "action");
    expect(a.groupId).toBe(b.groupId); // consecutive calls to the same tool: one group
    const cancel = await call("POST", `${BASE}/ask/actions/${a.id}/cancel`, cookie, { only: true });
    expect(cancel.json.results).toEqual([expect.objectContaining({ id: a.id, state: "cancelled" })]);
    expect((await call("POST", `${BASE}/ask/actions/${a.id}/confirm`, cookie, {})).status).toBe(409);
    // The next message starts a new turn: the other card expires.
    await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { threadId: eventsOf(r.events, "thread")[0].id, text: "and?" }));
    const late = await call("POST", `${BASE}/ask/actions/${b.id}/confirm`, cookie, {});
    expect(late.status).toBe(409);
    expect(late.json.error).toBe("expired");
    expect(await tickets("Let me expire")).toEqual([]);
    expect(await tickets("Cancel me")).toEqual([]);
  });

  it("Confirm takes EDITED fields — only the editable ones — re-validates them and rebuilds the card", async () => {
    const cookie = await cookieFor(ME);
    const model = fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Draft title" } }], answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "file" }));
    const card = eventsOf(r.events, "action")[0];
    const notEditable = await call("POST", `${BASE}/ask/actions/${card.id}/confirm`, cookie, { args: { body: "sneaky" } });
    expect(notEditable.status).toBe(400);
    const badValue = await call("POST", `${BASE}/ask/actions/${card.id}/confirm`, cookie, { args: { priority: "urgent" } });
    expect(badValue.status).toBe(400);
    const ok = await call("POST", `${BASE}/ask/actions/${card.id}/confirm`, cookie, { args: { title: "Edited title", category: "bug", assignee: ME } });
    expect(ok.json.results[0].state).toBe("confirmed");
    const row = await first<{ category: string; requester: string }>(env.DB, `SELECT category, requester FROM tickets WHERE org_id = ? AND title = 'Edited title'`, ORG_A);
    expect(row).toEqual({ category: "bug", requester: ME });
    const stored = await first<{ args_json: string; preview_json: string }>(env.DB, `SELECT args_json, preview_json FROM chat_actions WHERE id = ?`, card.id);
    expect(JSON.parse(stored!.args_json).title).toBe("Edited title");
    expect(JSON.parse(stored!.preview_json).lines).toContainEqual({ label: "Title", value: "Edited title" });
  });

  it("a write outside the person's lane makes no card: the writer's own refusal goes back to the model", async () => {
    const cookie = await cookieFor(ME);
    const notMine = await create_ticket(await tenantCtx("AndresL230"), { title: "Not mine", body: "", category: "other", priority: "normal", assignees: [] }, "AndresL230");
    const model = fakeModel([[{ type: "tool_use", name: "edit_ticket", input: { id: notMine, title: "Hijacked" } }], answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "rename it" }));
    expect(eventsOf(r.events, "action")).toEqual([]);
    const result = (model.sent[1].messages.at(-1)!.content as { is_error?: boolean; content: string }[])[0];
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content).code).toBe("forbidden");
  });
});

describe("Auto mode", () => {
  it("runs a write at once (state auto, Undo offered) — but only while the org allows Auto; off, it is a card", async () => {
    const cookie = await cookieFor(ME);
    const model = fakeModel([
      [{ type: "tool_use", name: "create_ticket", input: { title: "Auto one" } }], answer(),
      [{ type: "tool_use", name: "create_ticket", input: { title: "Auto off" } }], answer(),
    ]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "file", auto: true }));
    expect(eventsOf(r.events, "thread")[0].auto).toBe(true);
    expect(eventsOf(r.events, "action")).toEqual([]);
    expect(eventsOf(r.events, "action_result")[0]).toMatchObject({ state: "auto", undo: true });
    expect(await tickets("Auto one")).toHaveLength(1);
    // An admin turned Auto off for the org: the same request makes a card.
    await setAuto(false);
    const off = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "file", auto: true }));
    expect(eventsOf(off.events, "thread")[0].auto).toBe(false);
    expect(eventsOf(off.events, "action")[0].state).toBe("proposed");
    expect(await tickets("Auto off")).toEqual([]);
    const patch = await call("PATCH", `${BASE}/ask/threads/${eventsOf(off.events, "thread")[0].id}`, cookie, { auto: true });
    expect(patch.status).toBe(409);
    expect(patch.json.error).toBe("auto_off");
  });

  it("at most 5 writes run per answer: the 6th WAITS for Confirm, with the note", async () => {
    const cookie = await cookieFor(ME);
    const calls: StreamBlock[] = Array.from({ length: 6 }, (_, i) => ({ type: "tool_use" as const, name: "create_ticket", input: { title: `Cap ${i + 1}` } }));
    const model = fakeModel([calls, answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "six", auto: true }));
    expect(eventsOf(r.events, "action_result").filter((x) => x.state === "auto")).toHaveLength(5);
    const waiting = eventsOf(r.events, "action");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ state: "waiting", note: "Auto runs up to 5 changes per answer." });
    expect(await tickets("Cap 6")).toEqual([]);
    expect(await tickets("Cap 5")).toHaveLength(1);
    // It waits for Confirm, and Confirm runs it.
    expect((await call("POST", `${BASE}/ask/actions/${waiting[0].id}/confirm`, cookie, { only: true })).json.results[0].state).toBe("confirmed");
    expect(await tickets("Cap 6")).toHaveLength(1);
  });

  it("never runs update_plan or a Publish — they wait, and a Publish does not count toward the cap", async () => {
    const cookie = await cookieFor(FIXTURE_ADMIN);
    await ingestDocProposal(await tenantCtx("AndresL230"), { slug: "auto-doc", section: "reference", title: "Auto doc", body: "# Auto\n\nv1", change_summary: "new", confidence: "high" }, "AndresL230");
    const calls: StreamBlock[] = [
      { type: "tool_use", name: "update_plan", input: { narrative: "Now: hosting.", sprints: [] } },
      { type: "tool_use", name: "publish_doc", input: { slug: "auto-doc" } },
      ...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use" as const, name: "create_ticket", input: { title: `Plan cap ${i}` } })),
    ];
    const model = fakeModel([calls, answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "all of it", auto: true }));
    const cards = eventsOf(r.events, "action");
    expect(cards.map((c) => [c.tool, c.state, c.note])).toEqual([
      ["update_plan", "waiting", "Changing the roadmap plan waits for you, even on Auto."],
      ["publish_doc", "waiting", "Publishing waits for you, even on Auto."],
    ]);
    expect(eventsOf(r.events, "action_result").filter((x) => x.state === "auto")).toHaveLength(5);
    expect((await first<{ c: number }>(env.DB, `SELECT current_version AS c FROM docs WHERE org_id = ? AND slug = 'auto-doc'`, ORG_A))?.c ?? 0).toBe(0); // still unpublished
  });

  it("moving a ticket to Done is an ordinary write in Ask: Auto runs it", async () => {
    const cookie = await cookieFor(ME);
    const n = await myTicket("Done by auto");
    const model = fakeModel([[{ type: "tool_use", name: "transition_ticket", input: { id: n, to: "done" } }], answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "close it", auto: true }));
    expect(eventsOf(r.events, "action_result")[0]).toMatchObject({ state: "auto", ref: `ticket:${n}` });
    expect((await tickets("Done by auto"))[0].status).toBe("done");
  });
});

describe("Publish a staged doc", () => {
  it("Confirm calls the web promote path as the person: the staged version goes live", async () => {
    const cookie = await cookieFor(ME);
    await ingestDocProposal(await tenantCtx("AndresL230"), { slug: "pub-doc", section: "reference", title: "Pub doc", body: "# Pub\n\nlive soon", change_summary: "new", confidence: "high" }, "AndresL230");
    const model = fakeModel([[{ type: "tool_use", name: "publish_doc", input: { slug: "pub-doc" } }], answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "publish it" }));
    const card = eventsOf(r.events, "action")[0];
    expect(card).toMatchObject({ tool: "publish_doc", kind: "publish", state: "proposed", preview: { canPublish: true } });
    const ok = await call("POST", `${BASE}/ask/actions/${card.id}/confirm`, cookie, {});
    expect(ok.json.results[0].state).toBe("confirmed");
    const doc = await first<{ current_version: number; updated_by: string }>(env.DB, `SELECT current_version, updated_by FROM docs WHERE org_id = ? AND slug = 'pub-doc'`, ORG_A);
    expect(doc).toEqual({ current_version: 1, updated_by: ME });
  });

  it("only someone who may promote: a context that may not (a bearer) is refused, and its card says Open in Review", async () => {
    const ctx = await bearerCtx("AndresL230");
    expect(mayPromote(ctx)).toBe(false);
    expect(mayPromote(await tenantCtx(ME))).toBe(true);
    await ingestDocProposal(await tenantCtx("AndresL230"), { slug: "no-pub", section: "reference", title: "No pub", body: "# x\n\ny", change_summary: "new", confidence: "high" }, "AndresL230");
    const tc = { env: KEYED, ctx, handle: "AndresL230", orgSlug: "saplinglearn", origin: "http://x", threadId: 0, docs: async () => null, now: () => new Date(), searched: new Map() } as AskToolCtx;
    expect((await WRITES.publish_doc.preview(tc, { slug: "no-pub" })).canPublish).toBe(false);
    await expect(WRITES.publish_doc.run(tc, { slug: "no-pub" })).rejects.toMatchObject({ code: "forbidden" });
    expect((await first<{ c: number }>(env.DB, `SELECT current_version AS c FROM docs WHERE org_id = ? AND slug = 'no-pub'`, ORG_A))?.c ?? 0).toBe(0);
  });
});

describe("Undo", () => {
  it("writes the previous value back — and refuses when someone changed the item since", async () => {
    const cookie = await cookieFor(ME);
    const n = await myTicket("Undo me");
    const model = fakeModel([
      [{ type: "tool_use", name: "transition_ticket", input: { id: n, to: "testing" } }], answer(),
      [{ type: "tool_use", name: "edit_ticket", input: { id: n, title: "Undo me, renamed" } }], answer(),
    ]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "move it", auto: true }));
    const moved = eventsOf(r.events, "action_result")[0];
    const undo = await call("POST", `${BASE}/ask/actions/${moved.id}/undo`, cookie, {});
    expect(undo.json.results[0]).toMatchObject({ state: "undone" });
    expect((await first<{ status: string }>(env.DB, `SELECT status FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, n))!.status).toBe("submitted");
    expect((await call("POST", `${BASE}/ask/actions/${moved.id}/undo`, cookie, {})).json.error).toBe("no_undo");

    const r2 = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { threadId: eventsOf(r.events, "thread")[0].id, text: "rename", auto: true }));
    const renamed = eventsOf(r2.events, "action_result")[0];
    // Someone else edits the ticket afterwards.
    await new Promise((res) => setTimeout(res, 5));
    await edit_ticket(await tenantCtx("AndresL230"), n, { body: "changed by someone else" }, "AndresL230");
    const refused = await call("POST", `${BASE}/ask/actions/${renamed.id}/undo`, cookie, {});
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: "changed", message: "Changed since. Undo it by hand.", ref: `ticket:${n}` });
    expect((await first<{ title: string }>(env.DB, `SELECT title FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, n))!.title).toBe("Undo me, renamed");
    // Undo is still offered (nothing was undone).
    expect((await first<{ state: string }>(env.DB, `SELECT state FROM chat_actions WHERE id = ?`, renamed.id))!.state).toBe("auto");
  });

  it("one Undo reverses a group: created tickets are declined, with \"Undone in Trov\"", async () => {
    const cookie = await cookieFor(ME);
    const model = fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Group A" } }, { type: "tool_use", name: "create_ticket", input: { title: "Group B" } }], answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "two", auto: true }));
    const [a, b] = eventsOf(r.events, "action_result");
    expect(a.groupId).toBe(b.groupId);
    const undo = await call("POST", `${BASE}/ask/actions/${a.id}/undo`, cookie, {});
    expect(undo.json.results.map((x: { state: string }) => x.state)).toEqual(["undone", "undone"]);
    for (const t of ["Group A", "Group B"]) {
      const row = (await tickets(t))[0];
      expect(row.status).toBe("declined");
      const comment = await first<{ body: string }>(env.DB, `SELECT c.body FROM ticket_comments c JOIN tickets t ON t.id = c.ticket_id AND t.org_id = c.org_id WHERE t.org_id = ? AND t.number = ?`, ORG_A, row.number);
      expect(comment!.body).toBe("Undone in Trov");
    }
  });

  it("a sent handoff is expired; a staged prompt version is dropped", async () => {
    const cookie = await cookieFor(ME);
    const model = fakeModel([[
      { type: "tool_use", name: "send_handoff", input: { body: "Fix the test\n\nIt fails on main.", context: { task: "Fix the test" } } },
      { type: "tool_use", name: "save_prompt", input: { slug: "ask-undo-prompt", title: "Undo prompt", body: "Do it." } },
    ], answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "both", auto: true }));
    const [h, p] = eventsOf(r.events, "action_result");
    expect(h.ref).toMatch(/^handoff:\d+$/);
    expect((await call("POST", `${BASE}/ask/actions/${h.id}/undo`, cookie, {})).json.results[0].state).toBe("undone");
    expect((await first<{ status: string }>(env.DB, `SELECT status FROM handoffs WHERE org_id = ? AND number = ?`, ORG_A, Number(h.ref.split(":")[1])))!.status).toBe("expired");
    expect((await call("POST", `${BASE}/ask/actions/${p.id}/undo`, cookie, {})).json.results[0].state).toBe("undone");
    expect((await first<{ deleted_at: string | null }>(env.DB, `SELECT deleted_at FROM prompts WHERE org_id = ? AND slug = 'ask-undo-prompt'`, ORG_A))!.deleted_at).not.toBeNull();
  });
});

describe("Save as artifact", () => {
  it("save_artifact shows a Save form (no model-written content); Save writes a PRIVATE artifact from the stored answer, linked to the thread and the cited tickets", async () => {
    const cookie = await cookieFor(ME);
    const n = await myTicket("Cited in a saved answer");
    const model = fakeModel([
      [{ type: "tool_use", name: "get_ticket", input: { id: n } }, { type: "tool_use", name: "save_artifact", input: { title: "Saved answer", kind: "html" } }],
      answer(`Status of [[ticket:${n}]].`),
    ]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "save this as a doc" }));
    const form = eventsOf(r.events, "block").find((b) => b.kind === "save_form");
    expect(form.form).toMatchObject({ title: "Saved answer", kind: "html", visibility: "private", saved: null });
    const threadId = eventsOf(r.events, "thread")[0].id;
    const messageId = eventsOf(r.events, "done")[0].messageId;
    // The stored form names its answer.
    const detail = await call("GET", `${BASE}/ask/threads/${threadId}`, cookie);
    expect(detail.json.messages[1].blocks.find((b: { kind: string }) => b.kind === "save_form").form.messageId).toBe(messageId);
    const saved = await call("POST", `${BASE}/ask/threads/${threadId}/save`, cookie, { messageId, title: "Saved answer", kind: "html", visibility: "private" });
    expect(saved.status).toBe(200);
    const page = await first<{ id: number; visibility: string; kind: string; author_id: string }>(env.DB, `SELECT id, visibility, kind, author_id FROM artifact_pages WHERE org_id = ? AND slug = ?`, ORG_A, saved.json.slug);
    expect(page).toMatchObject({ visibility: "private", kind: "html", author_id: ME });
    const body = (await first<{ content: string }>(env.DB, `SELECT content FROM artifact_versions WHERE page_id = ? AND org_id = ?`, page!.id, ORG_A))!.content;
    expect(body).toContain(`Cited in a saved answer`);
    expect(body).not.toContain("<script");
    expect(await first(env.DB, `SELECT 1 AS x FROM artifact_links WHERE page_id = ? AND org_id = ? AND target_type = 'ticket' AND target_ref = ?`, page!.id, ORG_A, String(n))).not.toBeNull();
    expect(await first(env.DB, `SELECT 1 AS x FROM chat_artifacts WHERE org_id = ? AND thread_id = ? AND artifact_id = ? AND role = 'saved'`, ORG_A, threadId, page!.id)).not.toBeNull();
  });

  it("in Auto it saves the answer as private at once — a card with Undo, which deletes the private draft", async () => {
    const cookie = await cookieFor(ME);
    const model = fakeModel([[{ type: "tool_use", name: "save_artifact", input: {} }], answer("Saving it.")]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "save this", auto: true }));
    const saved = eventsOf(r.events, "artifact_saved")[0];
    expect(saved).toMatchObject({ visibility: "private" });
    const card = eventsOf(r.events, "action_result").find((x) => x.state === "auto");
    expect(card.ref).toBe(`artifact:${saved.slug}`);
    expect((await call("POST", `${BASE}/ask/actions/${card.id}/undo`, cookie, {})).json.results[0].state).toBe("undone");
    expect((await first<{ deleted_at: string | null }>(env.DB, `SELECT deleted_at FROM artifact_pages WHERE org_id = ? AND slug = ?`, ORG_A, saved.slug))!.deleted_at).not.toBeNull();
  });
});
