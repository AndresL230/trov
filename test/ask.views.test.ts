// Ask Trov's ref views, threads and settings (src/ai/ask/refs.ts, routes.ts; docs/architecture/ask.md): `peek`
// hides what the person can't see; the inspector read; "Wrong?" and Review's "Flagged in Ask" (the reason only);
// the thread list, search, export; Settings › Trov; the composer's state; /search; ⌘J threads; deleting an account.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { create_ticket } from "../src/tools/tickets";
import { createPage } from "../src/tools/artifacts";
import { ingestDocProposal } from "../src/consumer";
import { deleteAccount } from "../src/deletion/person";
import { AskStateSchema, AskThreadDetailSchema, AskSearchHitSchema, RefViewSchema } from "@shared/ai-ask";
import { all, first, run } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A, platformCtx, tenantCtx } from "./helpers/tenant";
import { BASE, ask, call, eventsOf, fakeModel, withAsk } from "./helpers/ask";
import { addOrgRepo } from "./helpers/org-config";

const ME = "ask-viewer";
const final = (title = "Views") => `\n<trov-meta>{"title": "${title}", "followups": []}</trov-meta>`;

describe("peek and the inspector", () => {
  it("peek returns RefViews and hides what the person can't see — another's private artifact, an unknown id — the same way", async () => {
    const cookie = await cookieFor(ME);
    const n = await create_ticket(await tenantCtx("AndresL230"), { title: "Peek me", body: "", category: "bug", priority: "high", assignees: [ME] }, "AndresL230");
    const theirs = await createPage(await tenantCtx("AndresL230"), { title: "Their secret", kind: "markdown", area: "data", repo: "", visibility: "private", content: "x" }, "AndresL230");
    const org = await createPage(await tenantCtx("AndresL230"), { title: "Org page", kind: "markdown", area: "data", repo: "", visibility: "org", content: "y" }, "AndresL230");
    const r = await call("POST", `${BASE}/ask/peek`, cookie, { refs: [`ticket:${n}`, `artifact:${theirs.slug}`, `artifact:${org.slug}`, "ticket:9999", "person:AndresL230"] });
    expect(r.status).toBe(200);
    const [t, hidden, visible, unknown, person] = r.json.items;
    expect(RefViewSchema.parse(t)).toMatchObject({ type: "ticket", num: n, title: "Peek me", status: { word: "Triage", mark: "todo", tone: "muted" }, extra: { priority: "high", assignees: [ME] } });
    expect(hidden).toEqual({ ref: `artifact:${theirs.slug}`, hidden: true });
    expect(visible).toMatchObject({ type: "artifact", title: "Org page", status: { word: "Org" } });
    expect(unknown).toEqual({ ref: "ticket:9999", hidden: true });
    expect(person).toMatchObject({ ref: "person:andresl230", type: "person" });
    // The inspector read: the same rule.
    expect((await call("GET", `${BASE}/ask/item/${encodeURIComponent(`artifact:${theirs.slug}`)}`, cookie)).status).toBe(404);
    const item = await call("GET", `${BASE}/ask/item/${encodeURIComponent(`ticket:${n}`)}`, cookie);
    expect(item.json.view.ref).toBe(`ticket:${n}`);
    expect(item.json.detail.ticket.title).toBe("Peek me");
    // The owner sees their own private page.
    const own = await call("POST", `${BASE}/ask/peek`, await cookieFor("AndresL230"), { refs: [`artifact:${theirs.slug}`] });
    expect(own.json.items[0]).toMatchObject({ title: "Their secret", status: { word: "Private" } });
  });
});

describe("a repo ref (#186) — the Repo Overview's facts, never a state of Ask's own", () => {
  it("peek reads RepoFacts (the dashboard's projection): status null, nothing captured has nothing to call Healthy", async () => {
    await addOrgRepo("acme/peek-repo");
    const r = await call("POST", `${BASE}/ask/peek`, await cookieFor(ME), { refs: ["repo:acme/peek-repo", "repo:nobody/else"] });
    expect(r.status).toBe(200);
    const [repo, other] = r.json.items;
    expect(RefViewSchema.parse(repo)).toMatchObject({ ref: "repo:acme/peek-repo", type: "repo", title: "acme/peek-repo", status: null, href: "#repo" });
    const facts = repo.extra.facts;
    expect(facts.repo).toBe("acme/peek-repo");
    // Nothing deployed or captured yet: no part, so no environment to judge (the client draws Unknown), and no CI
    // state that could read as passing.
    expect(facts.parts).toEqual([]);
    expect(facts.envs).toEqual([]);
    expect(facts.ci.every((c: { state: string | null }) => c.state !== "pass")).toBe(true);
    expect(Object.keys(repo.extra)).toEqual(["facts"]);
    expect(other).toEqual({ ref: "repo:nobody/else", hidden: true });
  });
});

describe("\"Wrong?\" and Review's \"Flagged in Ask\"", () => {
  it("records the person's feedback with its detail; the first two reasons flag each cited item with the REASON ONLY", async () => {
    const cookie = await cookieFor(ME);
    await ingestDocProposal(await tenantCtx("AndresL230"), { slug: "flag-doc", section: "reference", title: "Flag doc", body: "# Flag\n\nbody", change_summary: "new", confidence: "high" }, "AndresL230");
    const model = fakeModel([
      [{ type: "tool_use", name: "query", input: { q: "flag" } }],
      [{ type: "text", text: `The secret question answer cites [[doc:flag-doc]].${final()}` }],
    ]);
    const QUESTION = "What does the confidential roadmap say?";
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: QUESTION }));
    const done = eventsOf(r.events, "done")[0];
    expect(done.cites.map((c: { ref: string }) => c.ref)).toEqual(["doc:flag-doc"]);
    expect((await call("POST", `${BASE}/ask/messages/${done.messageId}/wrong`, cookie, { reason: "source_wrong" })).status).toBe(200);
    expect((await call("POST", `${BASE}/ask/messages/${done.messageId}/wrong`, cookie, { reason: "source_wrong" })).status).toBe(200); // idempotent
    const fb = await first<{ item_type: string; detail_json: string }>(env.DB, `SELECT item_type, detail_json FROM ai_feedback WHERE org_id = ? AND handle = ?`, ORG_A, ME);
    expect(fb!.item_type).toBe("ask");
    expect(JSON.parse(fb!.detail_json)).toMatchObject({ reason: "source_wrong", mode: "smart", messageId: done.messageId, cites: ["doc:flag-doc"] });
    // The flag table has no column that could carry who asked or what was said.
    const cols = (await all<{ name: string }>(env.DB, `SELECT name FROM pragma_table_info('ask_flags')`)).map((c) => c.name).sort();
    expect(cols).toEqual(["created_at", "id", "item_ref", "org_id", "reason"]);
    expect(await all(env.DB, `SELECT item_ref, reason FROM ask_flags WHERE org_id = ?`, ORG_A)).toEqual([{ item_ref: "doc:flag-doc", reason: "source_wrong" }]);
    // Review shows it — the reason and a count, and nothing of the thread.
    const review = await call("GET", `${BASE}/proposals`, await cookieFor("AndresL230"));
    expect(review.json.askFlags).toEqual([{ ref: "doc:flag-doc", reason: "source_wrong", count: 1, lastAt: expect.any(String) }]);
    expect(review.text).not.toContain(QUESTION);
    expect(review.text).not.toContain("secret question answer");
    expect(review.text).not.toContain(ME);
    // "It missed something" flags nothing — even on an answer that cites the same doc.
    const r2 = await withAsk({ fetchImpl: fakeModel([[{ type: "text", text: `Again [[doc:flag-doc]].${final()}` }]]).fetchImpl },
      () => ask(cookie, { threadId: eventsOf(r.events, "thread")[0].id, text: "again" }));
    const done2 = eventsOf(r2.events, "done")[0];
    expect(done2.cites.map((c: { ref: string }) => c.ref)).toEqual(["doc:flag-doc"]);
    await call("POST", `${BASE}/ask/messages/${done2.messageId}/wrong`, cookie, { reason: "missed" });
    expect(await all(env.DB, `SELECT id FROM ask_flags WHERE org_id = ?`, ORG_A)).toHaveLength(1);
  });
});

describe("threads", () => {
  it("lists them grouped, searches the person's own (snippet offsets, match counts), renames, pins, keeps a draft, exports, deletes", async () => {
    const cookie = await cookieFor(ME);
    const model = fakeModel([[{ type: "text", text: `The netlify step is red. Netlify again.${final("Netlify")}` }], [{ type: "text", text: `Other.${final("Other")}` }]]);
    const r1 = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "Why does netlify fail?" }));
    await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "Something else" }));
    const id = eventsOf(r1.events, "thread")[0].id;
    const list = await call("GET", `${BASE}/ask/threads`, cookie);
    expect(list.json.threads.map((t: { title: string; group: string }) => [t.title, t.group])).toEqual([["Other", "today"], ["Netlify", "today"]]);
    const s = await call("GET", `${BASE}/ask/threads?q=netlify`, cookie);
    expect(s.json.hits).toHaveLength(1);
    const hit = AskSearchHitSchema.parse(s.json.hits[0]);
    expect(hit.thread.id).toBe(id);
    expect(hit.matchCount).toBe(2);
    const [a, b] = hit.snippet!.matches[0];
    expect(hit.snippet!.text.slice(a, b).toLowerCase()).toBe("netlify");
    // Another person's search never finds it.
    expect((await call("GET", `${BASE}/ask/threads?q=netlify`, await cookieFor("ask-stranger"))).json.hits).toEqual([]);
    await call("PATCH", `${BASE}/ask/threads/${id}`, cookie, { title: "Renamed", pinned: true, draft: "half a thought" });
    const detail = await call("GET", `${BASE}/ask/threads/${id}`, cookie);
    expect(AskThreadDetailSchema.parse(detail.json).thread).toMatchObject({ title: "Renamed", pinned: true, group: "pinned", draft: "half a thought", hasDraft: true });
    const md = await call("GET", `${BASE}/ask/threads/${id}/export`, cookie);
    expect(md.text).toMatch(/^# Renamed\n/);
    expect(md.text).toContain("Why does netlify fail?");
    expect((await call("DELETE", `${BASE}/ask/threads/${id}`, cookie)).status).toBe(200);
    expect(await all(env.DB, `SELECT id FROM chat_messages WHERE thread_id = ?`, id)).toEqual([]);
    expect(await all(env.DB, `SELECT rowid FROM chat_fts WHERE thread_id = ?`, String(id))).toEqual([]);
  });

  it("a ⌘J thread records its origin and the item it was opened on, and is listed like any other", async () => {
    const cookie = await cookieFor(ME);
    const n = await create_ticket(await tenantCtx("AndresL230"), { title: "Panel ticket", body: "", category: "other", priority: "normal", assignees: [] }, "AndresL230");
    const r = await withAsk({ fetchImpl: fakeModel([[{ type: "text", text: `ok${final()}` }]]).fetchImpl }, () => ask(cookie, { text: "What's left?", origin: "panel", context: [`ticket:${n}`] }));
    expect(eventsOf(r.events, "thread")[0]).toMatchObject({ origin: "panel", contextRef: `ticket:${n}` });
    expect((await call("GET", `${BASE}/ask/threads`, cookie)).json.threads[0]).toMatchObject({ origin: "panel", contextRef: `ticket:${n}` });
  });

  it("/search answers with item cards from Trov's own search — no model call, nothing counted", async () => {
    const cookie = await cookieFor(ME);
    await create_ticket(await tenantCtx("AndresL230"), { title: "Hosting connections", body: "", category: "other", priority: "normal", assignees: [] }, "AndresL230");
    const model = fakeModel([]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "hosting", command: "search" }));
    expect(model.sent).toHaveLength(0);
    const block = eventsOf(r.events, "block")[0];
    expect(block.kind).toBe("items");
    expect(block.items[0]).toMatchObject({ type: "ticket", title: "Hosting connections" });
    expect(await first(env.DB, `SELECT 1 AS x FROM org_usage_daily WHERE org_id = ? AND metric = 'ai_chat'`, ORG_A)).toBeNull();
  });
});

describe("the composer's state and Settings › Trov", () => {
  it("state carries every limit and flag the UI needs, and starters from the person's own work", async () => {
    const cookie = await cookieFor(ME);
    const n = await create_ticket(await tenantCtx("AndresL230"), { title: "Starter ticket", body: "", category: "other", priority: "high", assignees: [ME] }, "AndresL230");
    const s = await call("GET", `${BASE}/ask/state`, cookie);
    const state = AskStateSchema.parse(s.json);
    expect(state).toMatchObject({ enabled: true, plan: "enterprise", defaultMode: "smart", autoAllowed: true, attach: { maxFiles: 5, maxBytes: 10 * 1024 * 1024, kinds: ["image", "pdf", "text"] } });
    expect(state.modes.map((m) => [m.id, m.countsAs])).toEqual([["fast", 1], ["smart", 1], ["thinking", 5]]);
    expect(state.starters).toContain(`Summarize ticket #${n}`);
    expect(state.starters).toHaveLength(4);
  });

  it("instructions are at most 500 characters; the default mode is Pro's — Free can only have Smart", async () => {
    const cookie = await cookieFor(ME);
    expect((await call("PUT", `${BASE}/ask/settings`, cookie, { instructions: "x".repeat(501) })).status).toBe(400);
    const ok = await call("PUT", `${BASE}/ask/settings`, cookie, { instructions: "Keep it short.", defaultMode: "thinking" });
    expect(ok.json).toMatchObject({ instructions: "Keep it short.", defaultMode: "thinking" });
    await run(env.DB, `UPDATE orgs SET plan = 'free' WHERE id = ?`, ORG_A);
    expect((await call("PUT", `${BASE}/ask/settings`, cookie, { defaultMode: "fast" })).status).toBe(403);
    // The stored Pro default does not survive a plan without it.
    expect((await call("GET", `${BASE}/ask/settings`, cookie)).json).toMatchObject({ defaultMode: "smart", modes: ["smart"] });
  });
});

describe("deleting an account deletes the person's Ask rows", () => {
  it("threads, messages, cards, attachment links and settings go; another person's stay", async () => {
    const cookie = await cookieFor(ME);
    const other = await cookieFor("ask-keeper");
    const model = fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "x" } }], [{ type: "text", text: `ok${final()}` }], [{ type: "text", text: `kept${final()}` }]]);
    await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "mine" }));
    await withAsk({ fetchImpl: model.fetchImpl }, () => ask(other, { text: "theirs" }));
    await call("PUT", `${BASE}/ask/settings`, cookie, { instructions: "bye" });
    await deleteAccount(env as unknown as Env, platformCtx(), ME, { by: "self", actor: ME });
    expect(await all(env.DB, `SELECT id FROM chat_threads WHERE handle = ?`, ME)).toEqual([]);
    expect(await all(env.DB, `SELECT handle FROM person_ask_settings WHERE handle = ?`, ME)).toEqual([]);
    expect(await all(env.DB, `SELECT id FROM chat_actions`)).toEqual([]);
    expect(await all(env.DB, `SELECT id FROM chat_threads WHERE handle = 'ask-keeper'`)).toHaveLength(1);
    expect(await all(env.DB, `SELECT id FROM chat_messages`)).toHaveLength(2);
  });
});
