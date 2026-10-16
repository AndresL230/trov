// The owner's rulings on Ask Trov (2026-10-16, PR #178's open questions), server side — one describe per ruling id.
// docs/architecture/ask.md carries each rule; the ids are the owner list's (Q57 confirm-time rights, Q55 the
// waiting note, …).
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { create_ticket } from "../src/tools/tickets";
import { createPage, patchPage } from "../src/tools/artifacts";
import { deleteAccount } from "../src/deletion/person";
import { sweepPendingAskAttachments, ASK_PENDING_TTL_MS } from "../src/deletion/ask-pending";
import { askExportName } from "@shared/ai-ask-core";
import { all, first, run } from "./helpers/db";
import { FIXTURE_ADMIN, cookieFor } from "./helpers/persons";
import { ORG_A, platformCtx, tenantCtx } from "./helpers/tenant";
import { BASE, KEYED, ask, call, eventsOf, fakeModel, threadOf, withAsk, type StreamBlock } from "./helpers/ask";

const ME = "ask-rulings";
const final = "\n<trov-meta>{\"title\": \"Rulings\", \"followups\": []}</trov-meta>";
const answer = (text = "Done."): StreamBlock[] => [{ type: "text", text: `${text}${final}` }];
const setRole = (handle: string, role: "owner" | "admin" | "member") =>
  run(env.DB, `UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?`, role, ORG_A, handle);
const unassign = (n: number, login: string) =>
  run(env.DB, `DELETE FROM ticket_assignees WHERE org_id = ? AND login = ? AND ticket_id = (SELECT id FROM tickets WHERE org_id = ? AND number = ?)`, ORG_A, login, ORG_A, n);
const titleOf = async (n: number) => (await first<{ title: string }>(env.DB, `SELECT title FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, n))?.title;
async function ticketFor(title: string, assignees: string[]): Promise<number> {
  return create_ticket(await tenantCtx("AndresL230"), { title, body: "b", category: "other", priority: "normal", assignees }, "AndresL230");
}
/** One card from one scripted tool call, made by `cookie`. */
async function cardFrom(cookie: string, tool: string, input: unknown) {
  const model = fakeModel([[{ type: "tool_use", name: tool, input }], answer()]);
  const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "do it" }));
  return { card: eventsOf(r.events, "action")[0], model, events: r.events };
}
const confirm = (cookie: string, id: number) => call("POST", `${BASE}/ask/actions/${id}/confirm`, cookie, {});

describe("Q57: Confirm re-checks the confirmer's rights NOW — a card never carries the proposer's", () => {
  it("admin-only (update_plan): a card made as an admin does not run once the person is a member", async () => {
    const cookie = await cookieFor(FIXTURE_ADMIN);
    const { card } = await cardFrom(cookie, "update_plan", { narrative: "Now: Q57 plan.", sprints: [] });
    expect(card).toMatchObject({ tool: "update_plan", state: "proposed" });
    await setRole(FIXTURE_ADMIN, "member");
    try {
      const r = await confirm(cookie, card.id);
      expect(r.status).toBe(200);
      expect(r.json.results[0]).toMatchObject({ id: card.id, state: "failed", result: { code: "forbidden" } });
      const plan = await first<{ narrative: string }>(env.DB, `SELECT narrative FROM plan WHERE org_id = ?`, ORG_A);
      expect(plan?.narrative ?? "").not.toContain("Q57 plan");
    } finally {
      await setRole(FIXTURE_ADMIN, "admin");
    }
  });

  it("admin-only: a member's model naming update_plan (never offered to them) makes no card at all", async () => {
    const cookie = await cookieFor(ME);
    const { card, model } = await cardFrom(cookie, "update_plan", { narrative: "Now: member plan.", sprints: [] });
    expect(card).toBeUndefined();
    const result = (model.sent[1].messages.at(-1)!.content as { is_error?: boolean; content: string }[])[0];
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content).code).toBe("unknown_tool"); // not in the catalog this person is offered
  });

  it("the ticket lane (invariant 6): taken off the ticket after the card was made, Confirm is refused and nothing changes", async () => {
    const cookie = await cookieFor(ME);
    const n = await ticketFor("Lane at confirm", [ME]);
    const { card } = await cardFrom(cookie, "edit_ticket", { id: n, title: "Renamed after leaving" });
    expect(card).toMatchObject({ tool: "edit_ticket", state: "proposed" });
    await unassign(n, ME);
    const r = await confirm(cookie, card.id);
    expect(r.json.results[0]).toMatchObject({ state: "failed", result: { code: "forbidden" } });
    expect(await titleOf(n)).toBe("Lane at confirm");
  });

  it("a status move in the lane: refused once the person is off the ticket", async () => {
    const cookie = await cookieFor(ME);
    const n = await ticketFor("Move at confirm", [ME]);
    const { card } = await cardFrom(cookie, "transition_ticket", { id: n, to: "in_progress" });
    await unassign(n, ME);
    expect((await confirm(cookie, card.id)).json.results[0]).toMatchObject({ state: "failed", result: { code: "forbidden" } });
    expect((await first<{ status: string }>(env.DB, `SELECT status FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, n))?.status).not.toBe("in_progress");
  });

  it("the admin exception (set_ticket_sprint off the lane) is the role held at Confirm, not at the card", async () => {
    const cookie = await cookieFor(FIXTURE_ADMIN);
    const n = await ticketFor("Sprint at confirm", []);
    await run(env.DB, `INSERT INTO sprints (id, org_id, title, target_date, status, created_at, created_by) VALUES (5701, ?, 'Q57 sprint', '2026-11-20', 'upcoming', '2026-10-01T00:00:00Z', 'AndresL230')`, ORG_A);
    const { card } = await cardFrom(cookie, "set_ticket_sprint", { id: n, sprint_id: 5701 });
    expect(card).toMatchObject({ tool: "set_ticket_sprint", state: "proposed" });
    await setRole(FIXTURE_ADMIN, "member");
    try {
      expect((await confirm(cookie, card.id)).json.results[0]).toMatchObject({ state: "failed", result: { code: "forbidden" } });
      expect((await first<{ s: number | null }>(env.DB, `SELECT sprint_id AS s FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, n))?.s).toBeNull();
    } finally {
      await setRole(FIXTURE_ADMIN, "admin");
    }
  });

  it("the assignment rule: an assignee who left the ticket can no longer (re)assign it", async () => {
    const cookie = await cookieFor(ME);
    await cookieFor("q57-other");
    const n = await ticketFor("Assign at confirm", [ME]);
    const { card } = await cardFrom(cookie, "assign_ticket", { id: n, login: "q57-other", on: true });
    expect(card).toMatchObject({ tool: "assign_ticket", state: "proposed" });
    await unassign(n, ME);
    expect((await confirm(cookie, card.id)).json.results[0]).toMatchObject({ state: "failed", result: { code: "forbidden" } });
    const on = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ticket_assignees WHERE org_id = ? AND login = 'q57-other'`, ORG_A);
    expect(on?.n).toBe(0);
  });

  it("a card whose rights still hold runs as before", async () => {
    const cookie = await cookieFor(ME);
    const n = await ticketFor("Still mine", [ME]);
    const { card } = await cardFrom(cookie, "edit_ticket", { id: n, title: "Still mine, renamed" });
    expect((await confirm(cookie, card.id)).json.results[0]).toMatchObject({ state: "confirmed" });
    expect(await titleOf(n)).toBe("Still mine, renamed");
  });
});

describe("Q55: a waiting card keeps its note across a reload", () => {
  it("the thread read gives a waiting card the note it streamed with; a proposed card none", async () => {
    const cookie = await cookieFor(FIXTURE_ADMIN);
    await run(env.DB, `UPDATE orgs SET ai_chat_auto = 1 WHERE id = ?`, ORG_A);
    const model = fakeModel([[
      { type: "tool_use", name: "update_plan", input: { narrative: "Now: waiting note.", sprints: [] } },
      ...Array.from({ length: 6 }, (_, i) => ({ type: "tool_use" as const, name: "create_ticket", input: { title: `Q55 cap ${i}` } })),
    ], answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "all", auto: true }));
    const streamed = eventsOf(r.events, "action").map((a) => [a.id, a.note]);
    expect(streamed).toHaveLength(2); // update_plan (Confirm-only) and the 6th ticket (past the cap)
    const tid = eventsOf(r.events, "thread")[0].id;
    const read = await call("GET", `${BASE}/ask/threads/${tid}`, cookie);
    const stored = (read.json.messages as { actions: { id: number; note: string | null; state: string }[] }[]).flatMap((m) => m.actions);
    for (const [id, note] of streamed) expect(stored.find((a) => a.id === id)?.note).toBe(note);
    expect(stored.filter((a) => a.state === "auto").every((a) => a.note === null)).toBe(true);
  });
});

describe("Q53: a panel thread's context_ref is the first item the person can SEE", () => {
  it("a hidden first context item never enters the thread: not its context_ref, not the question", async () => {
    const cookie = await cookieFor(ME);
    const n = await ticketFor("Visible context", []);
    // Another person's PRIVATE artifact: hidden from ME.
    const priv = await createPage(await tenantCtx("AndresL230"), { title: "Private notes", kind: "markdown", area: "data", repo: "", visibility: "private", content: "# x", summary: "s" }, "AndresL230");
    const model = fakeModel([answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "about these", origin: "panel", context: [`artifact:${priv.slug}`, `ticket:${n}`] }));
    const th = eventsOf(r.events, "thread")[0];
    expect(th.contextRef).toBe(`ticket:${n}`);
    const row = await first<{ context_ref: string | null }>(env.DB, `SELECT context_ref FROM chat_threads WHERE id = ?`, th.id);
    expect(row?.context_ref).toBe(`ticket:${n}`);
    const read = await call("GET", `${BASE}/ask/threads/${th.id}`, cookie);
    expect(read.json.thread.contextRef).toBe(`ticket:${n}`);
    expect(read.json.messages[0].context).toEqual([`ticket:${n}`]);
    expect(JSON.stringify(read.json)).not.toContain(priv.slug);
  });

  it("only hidden items: no context_ref at all", async () => {
    const cookie = await cookieFor(ME);
    const priv = await createPage(await tenantCtx("AndresL230"), { title: "Private 2", kind: "markdown", area: "data", repo: "", visibility: "private", content: "# y", summary: "s" }, "AndresL230");
    const r = await withAsk({ fetchImpl: fakeModel([answer()]).fetchImpl }, () => ask(cookie, { text: "about it", origin: "panel", context: [`artifact:${priv.slug}`] }));
    expect(eventsOf(r.events, "thread")[0].contextRef).toBeNull();
  });
});

describe("Q52: Auto asked for in an org with Auto off runs asking first, and the thread event says so", () => {
  it("auto:true with the org's Auto off: the write is a card, and `thread` carries autoOff", async () => {
    const cookie = await cookieFor(ME);
    await run(env.DB, `UPDATE orgs SET ai_chat_auto = 0 WHERE id = ?`, ORG_A);
    const model = fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Q52 ticket" } }], answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "file it", auto: true }));
    expect(eventsOf(r.events, "thread")[0]).toMatchObject({ auto: false, autoOff: true });
    expect(eventsOf(r.events, "action")[0]).toMatchObject({ state: "proposed" });
    expect(eventsOf(r.events, "action_result")).toEqual([]);
  });

  it("Auto on: no autoOff", async () => {
    const cookie = await cookieFor(ME);
    await run(env.DB, `UPDATE orgs SET ai_chat_auto = 1 WHERE id = ?`, ORG_A);
    const r = await withAsk({ fetchImpl: fakeModel([answer()]).fetchImpl }, () => ask(cookie, { text: "hi", auto: true }));
    const th = eventsOf(r.events, "thread")[0];
    expect(th.auto).toBe(true);
    expect("autoOff" in th).toBe(false);
  });
});

describe("Q51: a search's result line is the streamed wording, stored too", () => {
  it("one hit is \"1 result\" on the stream AND on reload; none is \"No results\"", async () => {
    const cookie = await cookieFor(ME);
    await ticketFor("Zanzibarqux unique", [ME]);
    const one = await ask(cookie, { text: "Zanzibarqux", command: "search" });
    expect(eventsOf(one.events, "activity").find((a) => a.state === "done")?.resultLine).toBe("1 result");
    const t1 = await call("GET", `${BASE}/ask/threads/${eventsOf(one.events, "thread")[0].id}`, cookie);
    expect(t1.json.messages.at(-1).activity[0].resultLine).toBe("1 result");
    const none = await ask(cookie, { text: "nothingmatchesthisxyz", command: "search" });
    const t0 = await call("GET", `${BASE}/ask/threads/${eventsOf(none.events, "thread")[0].id}`, cookie);
    expect(t0.json.messages.at(-1).activity[0].resultLine).toBe("No results");
  });
});

describe("Q56: export names transliterate; ask-trov only when nothing is left", () => {
  it("askExportName", () => {
    expect(askExportName("Résumé of the café crème")).toBe("Resume-of-the-cafe-creme");
    expect(askExportName("Straße und Ærø")).toBe("Strasse-und-AEro");
    expect(askExportName("<img src=x onerror=alert(1)>")).toBe("img-srcx-onerroralert1");
    expect(askExportName("日本語のスレッド")).toBe("ask-trov");
    expect(askExportName("")).toBe("ask-trov");
    expect(askExportName(null)).toBe("ask-trov");
    expect(askExportName("x".repeat(80))).toHaveLength(60);
  });

  it("the route's content-disposition uses it", async () => {
    const cookie = await cookieFor(ME);
    const tid = await threadOf(cookie);
    await call("PATCH", `${BASE}/ask/threads/${tid}`, cookie, { title: "Café plan" });
    const res = await app.request(`${BASE}/ask/threads/${tid}/export`, { headers: { cookie } }, KEYED);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="Cafe-plan.md"`);
  });
});

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n + 1, n + 2, n + 3]);
async function upload(cookie: string, files: { name: string; bytes: Uint8Array }[], threadId?: number) {
  const form = new FormData();
  for (const f of files) form.append("file", new File([f.bytes], f.name, { type: "image/png" }));
  if (threadId) form.append("threadId", String(threadId));
  const res = await app.request(`${BASE}/ask/attachments`, { method: "POST", headers: { cookie }, body: form }, KEYED);
  return { status: res.status, json: await res.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("Q59: Ask's 402 bodies are the app's one plan refusal", () => {
  it("an upload past the org's artifact storage: 402 with limit / used / cap / plan / status / message", async () => {
    const cookie = await cookieFor(ME);
    await run(env.DB, `UPDATE orgs SET plan_overrides = '{"artifact_bytes":4}' WHERE id = ?`, ORG_A);
    try {
      const r = await upload(cookie, [{ name: "big.png", bytes: png(1) }]);
      expect(r.status).toBe(402);
      expect(r.json).toMatchObject({ error: "plan_limit", limit: "artifact_bytes", cap: 4, used: expect.any(Number), plan: expect.any(String), status: expect.any(String), message: expect.any(String) });
    } finally {
      await run(env.DB, `UPDATE orgs SET plan_overrides = '{}' WHERE id = ?`, ORG_A);
    }
  });

  it("Save as artifact past the storage: the same body", async () => {
    const cookie = await cookieFor(ME);
    const r1 = await withAsk({ fetchImpl: fakeModel([answer("A long enough answer to save.")]).fetchImpl }, () => ask(cookie, { text: "hi" }));
    const tid = eventsOf(r1.events, "thread")[0].id;
    await run(env.DB, `UPDATE orgs SET plan_overrides = '{"artifact_bytes":4}' WHERE id = ?`, ORG_A);
    try {
      const r = await call("POST", `${BASE}/ask/threads/${tid}/save`, cookie, { title: "Saved", kind: "markdown", visibility: "private" });
      expect(r.status).toBe(402);
      expect(r.json).toMatchObject({ error: "plan_limit", limit: "artifact_bytes", cap: 4, used: expect.any(Number) });
    } finally {
      await run(env.DB, `UPDATE orgs SET plan_overrides = '{}' WHERE id = ?`, ORG_A);
    }
  });
});

describe("Q60: an upload with no thread is PENDING — bound on send, swept after 24 h", () => {
  const holderOf = (handle: string) => first<{ id: number }>(env.DB, `SELECT id FROM chat_threads WHERE org_id = ? AND handle = ? AND pending = 1`, ORG_A, handle);
  const pageBySlug = (slug: string) => first<{ id: number; visibility: string }>(env.DB, `SELECT id, visibility FROM artifact_pages WHERE org_id = ? AND slug = ?`, ORG_A, slug);

  it("no visible thread is made: the list, search and the thread routes never show the holder", async () => {
    const cookie = await cookieFor(ME);
    const up = await upload(cookie, [{ name: "a.png", bytes: png(10) }]);
    expect(up.status).toBe(200);
    expect(up.json.threadId).toBeNull();
    const holder = await holderOf(ME);
    expect(holder).not.toBeNull();
    expect((await call("GET", `${BASE}/ask/threads`, cookie)).json.threads).toEqual([]);
    expect((await call("GET", `${BASE}/ask/threads/${holder!.id}`, cookie)).status).toBe(404);
    expect((await call("PATCH", `${BASE}/ask/threads/${holder!.id}`, cookie, { title: "x" })).status).toBe(404);
    expect((await call("DELETE", `${BASE}/ask/threads/${holder!.id}`, cookie)).status).toBe(404);
    // Nor can a question be sent into it.
    expect((await ask(cookie, { threadId: holder!.id, text: "hi" })).status).toBe(404);
  });

  it("sending binds what the question names to its new thread; the rest stays pending", async () => {
    const cookie = await cookieFor(ME);
    const [a] = (await upload(cookie, [{ name: "a.png", bytes: png(20) }])).json.attachments;
    const [b] = (await upload(cookie, [{ name: "b.png", bytes: png(30) }])).json.attachments; // its own request
    const model = fakeModel([answer("Seen.")]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "look", attachments: [a.id] }));
    const tid = eventsOf(r.events, "thread")[0].id;
    const read = await call("GET", `${BASE}/ask/threads/${tid}`, cookie);
    expect(read.json.messages[0].attachments.map((x: { id: number }) => x.id)).toEqual([a.id]);
    const links = await all<{ id: number; thread_id: number; message_id: number | null }>(env.DB, `SELECT id, thread_id, message_id FROM chat_artifacts WHERE org_id = ? ORDER BY id`, ORG_A);
    expect(links.find((l) => l.id === a.id)).toMatchObject({ thread_id: tid });
    expect(links.find((l) => l.id === a.id)!.message_id).not.toBeNull();
    expect(links.find((l) => l.id === b.id)).toMatchObject({ thread_id: (await holderOf(ME))!.id, message_id: null });
    // Only one visible thread.
    expect((await call("GET", `${BASE}/ask/threads`, cookie)).json.threads.map((t: { id: number }) => t.id)).toEqual([tid]);
  });

  it("another person's pending upload is never bound to my thread", async () => {
    const mine = await cookieFor(ME);
    const theirs = await cookieFor("q60-other");
    const [x] = (await upload(theirs, [{ name: "x.png", bytes: png(40) }])).json.attachments;
    const r = await withAsk({ fetchImpl: fakeModel([answer()]).fetchImpl }, () => ask(mine, { text: "steal", attachments: [x.id] }));
    const read = await call("GET", `${BASE}/ask/threads/${eventsOf(r.events, "thread")[0].id}`, mine);
    expect(read.json.messages[0].attachments).toEqual([]);
    expect((await first<{ thread_id: number }>(env.DB, `SELECT thread_id FROM chat_artifacts WHERE id = ?`, x.id))!.thread_id).toBe((await holderOf("q60-other"))!.id);
  });

  it("the hourly sweep deletes what was never sent past 24 h (rows and bytes), keeps a newer one, keeps a published file's artifact, and drops an empty holder", async () => {
    const cookie = await cookieFor(ME);
    const [old, published] = (await upload(cookie, [{ name: "old.png", bytes: png(50) }, { name: "pub.png", bytes: png(60) }])).json.attachments;
    await run(env.DB, `UPDATE chat_artifacts SET created_at = '2026-01-01T00:00:00.000Z' WHERE id IN (?, ?)`, old.id, published.id);
    await patchPage(await tenantCtx(ME), published.slug, { visibility: "org" }, ME);
    const [fresh] = (await upload(cookie, [{ name: "fresh.png", bytes: png(70) }])).json.attachments;
    const now = Date.parse("2026-01-02T01:00:00.000Z") + ASK_PENDING_TTL_MS; // the fresh one is "now"
    await run(env.DB, `UPDATE chat_artifacts SET created_at = ? WHERE id = ?`, new Date(now - 3_600_000).toISOString(), fresh.id);
    const out = await sweepPendingAskAttachments(platformCtx(), env.ARTIFACTS_BUCKET, now);
    expect(out).toMatchObject({ deleted: 1, unlinked: 1 });
    expect(await pageBySlug(old.slug)).toBeNull();
    expect(await env.ARTIFACTS_BUCKET.head(`artifacts/${old.sha256}`)).toBeNull();
    expect(await pageBySlug(published.slug)).toMatchObject({ visibility: "org" });
    expect(await pageBySlug(fresh.slug)).not.toBeNull();
    expect(await holderOf(ME)).not.toBeNull(); // still holds the fresh one
    // A day later the fresh one goes too, and with nothing left on it the holder goes.
    await run(env.DB, `UPDATE chat_threads SET created_at = '2026-01-01T00:00:00.000Z' WHERE org_id = ? AND pending = 1`, ORG_A);
    const later = await sweepPendingAskAttachments(platformCtx(), env.ARTIFACTS_BUCKET, now + ASK_PENDING_TTL_MS);
    expect(later).toMatchObject({ deleted: 1, holders: 1 });
    expect(await holderOf(ME)).toBeNull();
  });

  it("deleting the account deletes the pending files and the holder (invariant 11)", async () => {
    const cookie = await cookieFor("q60-gone");
    const [p] = (await upload(cookie, [{ name: "p.png", bytes: png(80) }])).json.attachments;
    await deleteAccount(env as unknown as Env, platformCtx(), "q60-gone", { by: "self", actor: "q60-gone" });
    expect(await pageBySlug(p.slug)).toBeNull();
    expect(await all(env.DB, `SELECT id FROM chat_threads WHERE org_id = ? AND pending = 1`, ORG_A)).toEqual([]);
    expect(await env.ARTIFACTS_BUCKET.head(`artifacts/${p.sha256}`)).toBeNull();
  });
});
