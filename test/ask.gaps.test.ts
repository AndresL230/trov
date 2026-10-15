// Ask Trov — the contract gaps the frontend build found, closed on the server (the integrator's tests; ask.md):
// a thread's draft is cleared when a send is accepted; `ask/state` carries Pro's questions per seat; an uploaded
// attachment removed before it was ever sent is hard-deleted through src/deletion/ (and one never sent goes with its
// thread); the question's stored id is streamed; an answer keeps its parts in the order they streamed.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { create_ticket } from "../src/tools/tickets";
import { create_sprint } from "../src/tools/sprints";
import { get_sprint } from "../src/tools/reads";
import { promote_doc } from "../src/tools/writes";
import { ingestDocProposal } from "../src/consumer";
import { tenantCtx } from "./helpers/tenant";
import { PLANS } from "@shared/plans";
import { AskStateSchema, AskThreadDetailSchema } from "@shared/ai-ask";
import { all, first, run } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A } from "./helpers/tenant";
import { BASE, KEYED, ask, call, eventsOf, fakeModel, withAsk } from "./helpers/ask";

const ME = "ask-gaps";
const final = (title = "Gaps") => `\n<trov-meta>{"title": "${title}", "followups": []}</trov-meta>`;
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n + 1, n + 2, n + 3]);
const inR2 = async (sha: string) => (await env.ARTIFACTS_BUCKET.head(`artifacts/${sha}`)) !== null;

interface Att { id: number; slug: string; sha256: string }
async function upload(cookie: string, n: number, threadId?: number): Promise<{ threadId: number; attachments: Att[] }> {
  const form = new FormData();
  form.append("file", new File([png(n)], `shot-${n}.png`, { type: "image/png" }));
  if (threadId) form.append("threadId", String(threadId));
  const res = await app.request(`${BASE}/ask/attachments`, { method: "POST", headers: { cookie }, body: form }, KEYED);
  expect(res.status).toBe(200);
  return res.json();
}
const pageRows = async (slug: string) => (await all(env.DB, `SELECT id FROM artifact_pages WHERE org_id = ? AND slug = ?`, ORG_A, slug)).length;

describe("draft — cleared when a send is accepted", () => {
  it("a thread's kept words go once a question is sent from it", async () => {
    const cookie = await cookieFor(ME);
    const model = fakeModel([[{ type: "text", text: `One.${final()}` }], [{ type: "text", text: `Two.${final()}` }]]);
    const r1 = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "First" }));
    const id = eventsOf(r1.events, "thread")[0].id;
    await call("PATCH", `${BASE}/ask/threads/${id}`, cookie, { draft: "half a thought" });
    expect(AskThreadDetailSchema.parse((await call("GET", `${BASE}/ask/threads/${id}`, cookie)).json).thread.draft).toBe("half a thought");
    await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { threadId: id, text: "half a thought, finished" }));
    const after = AskThreadDetailSchema.parse((await call("GET", `${BASE}/ask/threads/${id}`, cookie)).json).thread;
    expect(after.draft).toBe("");
    expect(after.hasDraft).toBe(false);
  });
});

describe("ask/state — the upsell's number comes from the server", () => {
  it("proPerSeat is Pro's questions per seat from the one plan table", async () => {
    const st = AskStateSchema.parse((await call("GET", `${BASE}/ask/state`, await cookieFor(ME))).json);
    expect(st.proPerSeat).toBe(PLANS.team.entitlements.ai_chat);
    expect(PLANS.team.perSeat).toContain("ai_chat");
  });
});

describe("an attachment removed before it was sent — a hard delete through src/deletion/", () => {
  it("deletes its page, versions and link in one go and frees its bytes; nothing of another person's moves", async () => {
    const cookie = await cookieFor(ME);
    const up = await upload(cookie, 40);
    const [a] = up.attachments;
    expect(await inR2(a.sha256)).toBe(true);
    // Another person cannot remove it.
    expect((await call("DELETE", `${BASE}/ask/attachments/${a.id}`, await cookieFor("ask-gaps-stranger"))).status).toBe(404);
    expect(await pageRows(a.slug)).toBe(1);
    const r = await call("DELETE", `${BASE}/ask/attachments/${a.id}`, cookie);
    expect(r.status).toBe(200);
    expect(await pageRows(a.slug)).toBe(0);
    expect(await all(env.DB, `SELECT id FROM chat_artifacts WHERE org_id = ? AND id = ?`, ORG_A, a.id)).toEqual([]);
    expect(await all(env.DB, `SELECT id FROM artifact_versions WHERE org_id = ? AND r2_key = ?`, ORG_A, `artifacts/${a.sha256}`)).toEqual([]);
    expect(await inR2(a.sha256)).toBe(false);
    // Gone: a second call is a 404.
    expect((await call("DELETE", `${BASE}/ask/attachments/${a.id}`, cookie)).status).toBe(404);
  });

  it("one already sent with a question is refused (409 sent) and stays whole", async () => {
    const cookie = await cookieFor(ME);
    const up = await upload(cookie, 50);
    const [a] = up.attachments;
    await withAsk({ fetchImpl: fakeModel([[{ type: "text", text: `Seen.${final()}` }]]).fetchImpl }, () => ask(cookie, { threadId: up.threadId, text: "Look", attachments: [a.id] }));
    const r = await call("DELETE", `${BASE}/ask/attachments/${a.id}`, cookie);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("sent");
    expect(await pageRows(a.slug)).toBe(1);
    expect(await inR2(a.sha256)).toBe(true);
  });

  it("one published to the org is refused (409 published)", async () => {
    const cookie = await cookieFor(ME);
    const [a] = (await upload(cookie, 60)).attachments;
    await env.DB.prepare(`UPDATE artifact_pages SET visibility = 'org' WHERE org_id = ? AND slug = ?`).bind(ORG_A, a.slug).run();
    const r = await call("DELETE", `${BASE}/ask/attachments/${a.id}`, cookie);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("published");
    expect(await pageRows(a.slug)).toBe(1);
  });

  it("deleting its thread takes a never-sent attachment with it (deleteAskThread)", async () => {
    const cookie = await cookieFor(ME);
    const up = await upload(cookie, 70);
    const [a] = up.attachments;
    const link = await first<{ message_id: number | null }>(env.DB, `SELECT message_id FROM chat_artifacts WHERE org_id = ? AND id = ?`, ORG_A, a.id);
    expect(link?.message_id).toBeNull();
    expect((await call("DELETE", `${BASE}/ask/threads/${up.threadId}`, cookie)).status).toBe(200);
    expect(await pageRows(a.slug)).toBe(0);
    expect(await inR2(a.sha256)).toBe(false);
  });
});

describe("the stream names the question; a stored answer keeps its streamed order", () => {
  it("done carries questionId (the stored question), and GET /ask/threads/:id returns the parts as they streamed", async () => {
    const cookie = await cookieFor(ME);
    const n = await create_ticket(await tenantCtx("AndresL230"), { title: "Order me", body: "", category: "bug", priority: "high", assignees: [ME] }, "AndresL230");
    const model = fakeModel([
      [{ type: "text", text: "Before the card." }, { type: "tool_use", name: "get_ticket", input: { id: n } }],
      [{ type: "tool_use", name: "show_items", input: { refs: [`ticket:${n}`] } }],
      [{ type: "text", text: `After the card.${final("Order")}` }],
    ]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "Show me the ticket" }));
    const streamed = r.events.filter((e) => e.event === "text" || e.event === "block").map((e) => e.event);
    expect(streamed[0]).toBe("text");
    expect(streamed).toContain("block");
    expect(streamed.at(-1)).toBe("text");
    const done = eventsOf(r.events, "done")[0];
    const id = eventsOf(r.events, "thread")[0].id;
    const detail = AskThreadDetailSchema.parse((await call("GET", `${BASE}/ask/threads/${id}`, cookie)).json);
    const [q, a] = detail.messages;
    expect(done.questionId).toBe(q.id);
    expect(q.role).toBe("user");
    expect(a.id).toBe(done.messageId);
    expect(a.parts?.map((p) => p.kind)).toEqual(["text", "block", "text"]);
    expect(a.parts?.[1]).toEqual({ kind: "block", index: 0 });
    expect(a.blocks[0].kind).toBe("items");
    expect(a.parts?.[0]).toMatchObject({ kind: "text", md: expect.stringContaining("Before the card.") });
    expect(a.parts?.[2]).toMatchObject({ kind: "text", md: expect.stringContaining("After the card.") });
  });
});

describe("save_artifact from a follow-up saves the answer the person meant", () => {
  const LONG = `The hosting work waits on the connect test. ${"It fails on main since the status marks changed, and the fix is small. ".repeat(4)}`;
  async function twoTurns(cookie: string, save: Record<string, unknown>, auto = false) {
    const model = fakeModel([
      [{ type: "text", text: `${LONG}${final("Hosting")}` }],
      [{ type: "tool_use", name: "save_artifact", input: save }],
      [{ type: "text", text: `Done.${final("Hosting")}` }],
    ]);
    const r1 = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "What's blocking hosting?" }));
    const threadId = eventsOf(r1.events, "thread")[0].id;
    const first = eventsOf(r1.events, "done")[0].messageId;
    const r2 = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { threadId, text: "save this as a doc", auto }));
    return { threadId, first, second: eventsOf(r2.events, "done")[0].messageId, r2 };
  }

  it("the Save form names the EARLIER answer by default (the follow-up's own reply is one line)", async () => {
    const cookie = await cookieFor(ME);
    const t = await twoTurns(cookie, {});
    const form = eventsOf(t.r2.events, "block").find((b) => b.kind === "save_form");
    expect(form).toBeTruthy();
    const detail = AskThreadDetailSchema.parse((await call("GET", `${BASE}/ask/threads/${t.threadId}`, cookie)).json);
    const stored = detail.messages.find((m) => m.id === t.second)!.blocks.find((b) => b.kind === "save_form");
    expect(stored?.kind === "save_form" && stored.form.messageId).toBe(t.first);
  });

  it("which: \"this\" saves the follow-up's own answer", async () => {
    const cookie = await cookieFor(ME);
    const t = await twoTurns(cookie, { which: "this" });
    const detail = AskThreadDetailSchema.parse((await call("GET", `${BASE}/ask/threads/${t.threadId}`, cookie)).json);
    const stored = detail.messages.find((m) => m.id === t.second)!.blocks.find((b) => b.kind === "save_form");
    expect(stored?.kind === "save_form" && stored.form.messageId).toBe(t.second);
  });

  it("in Auto, scope answer saves the earlier answer's words, not \"Done.\"", async () => {
    const cookie = await cookieFor(ME);
    const t = await twoTurns(cookie, {}, true);
    const saved = eventsOf(t.r2.events, "artifact_saved")[0];
    const page = await first<{ id: number }>(env.DB, `SELECT id FROM artifact_pages WHERE org_id = ? AND slug = ?`, ORG_A, saved.slug);
    const body = (await first<{ content: string }>(env.DB, `SELECT content FROM artifact_versions WHERE page_id = ? AND org_id = ?`, page!.id, ORG_A))!.content;
    expect(body).toContain("The hosting work waits on the connect test.");
    // The Auto card names its write in the stream itself.
    const card = eventsOf(t.r2.events, "action_result").find((x) => x.state === "auto");
    expect(card).toMatchObject({ tool: "save_artifact", kind: "other" });
  });
});

describe("the inspector's reads (/ask/item) — the server's own projections, never client math", () => {
  const item = async (cookie: string, ref: string) => (await call("GET", `${BASE}/ask/item/${encodeURIComponent(ref)}`, cookie)).json;

  it("a sprint carries the server's forecast — the one the Roadmap shows", async () => {
    const cookie = await cookieFor(ME);
    const ctx = await tenantCtx("AndresL230");
    const sp = await create_sprint(ctx, { label: "Forecast sprint", urgency: "normal", start: "2026-01-05", due: "2099-01-30" }, "AndresL230");
    await env.DB.prepare(`UPDATE sprints SET status = 'in_progress' WHERE org_id = ? AND id = ?`).bind(ORG_A, sp.id).run();
    for (const [title, status] of [["One", "done"], ["Two", "in_progress"], ["Three", "submitted"]] as const) {
      const n = await create_ticket(ctx, { title, body: "", category: "bug", priority: "normal", assignees: [] }, "AndresL230");
      await env.DB.prepare(`UPDATE tickets SET sprint_id = ?, status = ? WHERE org_id = ? AND number = ?`).bind(sp.id, status, ORG_A, n).run();
    }
    const d = await item(cookie, `sprint:${sp.id}`);
    const server = (await get_sprint(ctx, sp.id))!.forecast;
    expect(server).not.toBeNull();
    expect(d.detail.sprint.forecast).toEqual(server);
  });

  it("a doc with a change waiting in Review: the STAGED body beside the live one", async () => {
    const cookie = await cookieFor(ME);
    const ctx = await tenantCtx("AndresL230");
    await ingestDocProposal(ctx, { slug: "staged-doc", section: "reference", title: "Staged doc", body: "# Staged doc\n\nThe live words.", change_summary: "new", confidence: "high" }, "AndresL230");
    await promote_doc(ctx, "staged-doc", 1, "AndresL230");
    await ingestDocProposal(ctx, { slug: "staged-doc", section: "reference", title: "Staged doc", body: "# Staged doc\n\nThe words waiting in Review.", change_summary: "edit", confidence: "high", base_version: 1 }, "AndresL230");
    const d = await item(cookie, "doc:staged-doc");
    expect(d.detail.body).toContain("The live words.");
    expect(d.detail.staged).toMatchObject({ version: 2 });
    expect(d.detail.staged.body).toContain("The words waiting in Review.");
  });

  it("a feed entry Trov wrote says so (ai.origin, model) with Sift's importance and its tags; no column leaks", async () => {
    const cookie = await cookieFor(ME);
    const res = await env.DB.prepare(`INSERT INTO feed (org_id, author, summary, brief, body, created_at, origin, model, importance) VALUES (?, 'trov', 'Weekly summary', 'What shipped', 'Body', ?, 'ai', 'claude-x', 'notable') RETURNING id`)
      .bind(ORG_A, "2026-10-15T09:00:00Z").first<{ id: number }>();
    const d = await item(cookie, `feed:${res!.id}`);
    expect(d.detail.entry.ai).toMatchObject({ origin: "ai", model: "claude-x" });
    expect(d.detail.entry.importance).toBe("notable");
    expect(Array.isArray(d.detail.entry.tags)).toBe(true);
    expect("origin" in d.detail.entry).toBe(false);
  });

  it("a pull request's changed files come from what capture stored; its line counts are stored nowhere, so null", async () => {
    const cookie = await cookieFor(ME);
    await run(env.DB, `INSERT INTO repo_events (org_id, repo, semantic_key, kind, ref, sha, number, state, actor_login, title, url, raw, provenance, occurred_at, recorded_at)
      VALUES (?, 'acme/files', 'gh:prs:77:opened', 'pr', 'feat/x', 'sha77', 77, 'review', 'AndresL230', 'Files PR', 'https://github.com/acme/files/pull/77', '{}', 'webhook', ?, ?)`, ORG_A, "2026-10-15T08:00:00Z", "2026-10-15T08:00:00Z");
    for (const path of ["a.ts", "b.ts", "c.ts"]) await run(env.DB, `INSERT INTO pr_files (org_id, repo, number, path) VALUES (?, 'acme/files', 77, ?)`, ORG_A, path);
    await run(env.DB, `INSERT INTO pr_file_reads (org_id, repo, number, head_sha, complete, content_hash, fetched_at) VALUES (?, 'acme/files', 77, 'sha77', 1, 'h', ?)`, ORG_A, "2026-10-15T08:01:00Z");
    const d = await item(cookie, "pr:77");
    expect(d.detail).toMatchObject({ files: 3, filesComplete: true, additions: null, deletions: null });
    expect(d.detail.filePaths.sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});
