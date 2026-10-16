// Ask Trov's write cards END TO END: the REAL routes (src/ai/ask/routes.ts — POST /ask with a scripted model, the
// confirm / cancel / undo routes, save-form + save, wrong) feeding the REAL screen code (web/src/ask-actions.ts and
// the stream reducer, web/src/ask-stream.ts). What the person sees is folded from the events the route streamed, every
// button press goes to the route through the same AskApi interface the live client implements, and what comes back
// is drawn. The §4 guards, as the server enforces them and the screen shows them:
//   • Publish never runs in Auto — it streams as a WAITING card with its note, and only the person's Confirm runs it;
//   • Publish confirms only for someone who may promote (the cookie person, a member, here);
//   • Undo is refused when the item changed since — "Changed since. Undo it by hand." with a link;
//   • a replaced answer's cards expire — Confirm on one collapses it to its Expired line.
//
// This file is Worker code (tsconfig.worker.json), so it loads the SPA's modules at RUNTIME through a computed path
// (the type checker never follows it into web/src — the split test/ai.hookup.test.ts keeps); markdown is mocked as in
// the render tests (no DOM in the pool).
import { describe, it, expect, vi, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { create_ticket, edit_ticket } from "../src/tools/tickets";
import { ingestDocProposal } from "../src/consumer";
import { first } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A, tenantCtx } from "./helpers/tenant";
import { BASE, ask, call, eventsOf, fakeModel, withAsk, type AskEventRead, type StreamBlock } from "./helpers/ask";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Web {
  initialState(): any;
  askView(app: any, where?: string): any;
  actionGroupView(v: any, a: any, ids: number[]): string;
  saveFormView(v: any, a: any, block: any, index: number): string;
  confirmCards(ctx: any, ids: number[]): Promise<void>;
  cancelCards(ctx: any, ids: number[]): Promise<void>;
  undoCards(ctx: any, ids: number[]): Promise<void>;
  addSaveForm(ctx: any, answer: string, block?: number): Promise<void>;
  saveArtifact(ctx: any, fk: string): Promise<void>;
  markWrong(ctx: any, answer: string, reason: string): Promise<void>;
  foldAskEvent(t: any, e: any, now: number): any;
  foldThreadEvent(c: any, d: any): any;
  newTurn(mode: string): any;
  shownParts(t: any): any[];
  withLastTurn(c: any, f: (t: any) => any): any;
  AskApiError: new (status: number, code: string, message: string) => any;
  actionsPart: { onEvent?(ctx: any, where: string, e: any): void };
}
const WEB = "../web/src/";
const web = async (): Promise<Web> => ({
  ...(await import(/* @vite-ignore */ `${WEB}render`)),
  ...(await import(/* @vite-ignore */ `${WEB}ask-state`)),
  ...(await import(/* @vite-ignore */ `${WEB}ask-actions`)),
  ...(await import(/* @vite-ignore */ `${WEB}ask-stream`)),
  ...(await import(/* @vite-ignore */ `${WEB}ask-api`)),
}) as Web;

const ME = "ask-hookup";
const final = "\n<trov-meta>{\"title\": \"Cards\", \"followups\": []}</trov-meta>";
const answer = (text = "Done."): StreamBlock[] => [{ type: "text", text: `${text}${final}` }];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** The screen: an app state whose page conversation is what the route streamed, folded event by event with the
 *  actions part's own event hook run on each (as the controller does), over the real routes. */
async function screenFrom(w: Web, events: AskEventRead[], cookie: string) {
  const s = w.initialState();
  s.view = "app"; s.screen = "ask"; s.orgSlug = "saplinglearn";
  s.me = { handle: ME, name: "Ask Hookup", avatar_url: null, color: "moss", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" }], superadmin: false, pending_invites: 0 };
  s.ask.page = { uid: "c1", threadId: null, thread: null, title: "", status: "ok", busy: false,
    messages: [{ role: "user", key: "q1", id: null, text: "Q", context: [], attachments: [], command: null }, { role: "assistant", key: "a1", turn: w.newTurn("smart") }] };
  const { ctx, flashes } = ctxOf(s, apiFor(w, cookie));
  for (const e of events) {
    s.ask.page = e.event === "thread" ? w.foldThreadEvent(s.ask.page, e.data) : w.withLastTurn(s.ask.page, (t) => w.foldAskEvent(t, e, 0));
    w.actionsPart.onEvent?.(ctx, "page", e);   // (the actions part no longer needs the stream: an Auto result names its write)
  }
  await new Promise((r) => setTimeout(r, 50));
  return { s, ctx, flashes };
}
/** The same AskApi the live client is, over the real routes with this person's cookie. */
function apiFor(w: Web, cookie: string) {
  const req = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, `${BASE}${path}`, cookie, body);
    if (r.status >= 400) {
      const e = new w.AskApiError(r.status, r.json?.error ?? String(r.status), r.json?.message ?? r.json?.error ?? "");
      e.ref = typeof r.json?.ref === "string" ? r.json.ref : null;
      e.body = r.json ?? {};
      throw e;
    }
    return r.json;
  };
  return {
    getThread: (id: number) => req("GET", `/ask/threads/${id}`),
    confirmAction: (id: number, body: unknown = {}) => req("POST", `/ask/actions/${id}/confirm`, body),
    cancelAction: (id: number, body: unknown = {}) => req("POST", `/ask/actions/${id}/cancel`, body),
    undoAction: (id: number) => req("POST", `/ask/actions/${id}/undo`, {}),
    saveForm: (messageId: number, block?: number) => req("POST", `/ask/messages/${messageId}/save-form`, block === undefined ? {} : { block }),
    saveThread: (threadId: number, body: unknown) => req("POST", `/ask/threads/${threadId}/save`, body),
    markWrong: (messageId: number, reason: string) => req("POST", `/ask/messages/${messageId}/wrong`, { reason }),
  };
}
function ctxOf(s: any, api: unknown) {
  const flashes: string[] = [];
  const ctx = {
    get app() { return s; }, get ui() { return s.ask; }, api, replay: false,
    look: () => ({ views: s.ask.refViews, persons: s.persons.data }),
    paint: () => undefined, flash: (m: string) => { flashes.push(m); },
    fail: (e: any, fallback: string) => { flashes.push(e?.message && e.message !== e.code ? e.message : fallback); },
    want: () => undefined, send: () => undefined, stop: () => undefined, openRef: () => undefined, closeInspector: () => undefined,
    newThread: () => undefined, openThread: () => undefined, reloadThreads: () => undefined,
    exit: (_k: string, apply: () => void) => apply(), cancelExit: () => undefined,
  };
  return { ctx, flashes };
}
function lines(w: Web, s: any): string[] {
  const a = s.ask.page.messages.filter((m: any) => m.role === "assistant").pop();
  return w.shownParts(a.turn).flatMap((p: any) => (p.kind === "actions" ? [w.actionGroupView(w.askView(s), a, p.ids)] : []));
}
const ticketRow = (n: number) => first<{ title: string; status: string; priority: string }>(env.DB, `SELECT title, status, priority FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, n);

// The SPA's modules load once (a cold import under a loaded suite outlasts the 5s default), and the routes stream a whole
// turn per test: the same budget test/ai.hookup.test.ts gives its real-rows run.
beforeAll(async () => { await web(); }, 60_000);

describe("Ask's write cards, the real routes into the real screen", { timeout: 60_000 }, () => {
  it("a proposed card: fields edited in place → Confirm sends only the edited ones; the server writes them and the card becomes its done line", async () => {
    const w = await web();
    const cookie = await cookieFor(ME);
    const model = fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Hookup draft", priority: "high", assignees: [ME] } }], answer("A card.")]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "file it" }));
    const { s, ctx, flashes } = await screenFrom(w, r.events, cookie);
    const card = eventsOf(r.events, "action")[0];
    expect(text(lines(w, s)[0])).toMatch(/^New ticket Draft, not created yet Hookup draft .*Cancel Confirm$/);
    s.ask.actions.drafts[card.id] = { title: "Hookup, edited", priority: "low", category: "other" };
    await w.confirmCards(ctx, [card.id]);
    const made = Number(s.ask.page.messages[1].turn.actions[card.id].ref.split(":")[1]);
    expect(await ticketRow(made)).toMatchObject({ title: "Hookup, edited", priority: "low" });
    expect(text(lines(w, s)[0])).toBe(`Created ticket #${made} Just now Undo`);
    expect(flashes).toEqual([`Created ticket #${made}`]);
  });

  it("GUARD — Publish never runs in Auto: the route streams it as a WAITING card with its note; only the person's Confirm publishes", async () => {
    const w = await web();
    const cookie = await cookieFor(ME);
    await ingestDocProposal(await tenantCtx("AndresL230"), { slug: "hookup-doc", section: "reference", title: "Hookup doc", body: "# Hookup\n\n- one line", change_summary: "new", confidence: "high" }, "AndresL230");
    const model = fakeModel([[
      { type: "tool_use", name: "publish_doc", input: { slug: "hookup-doc" } },
      { type: "tool_use", name: "create_ticket", input: { title: "Auto made" } },
    ], answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "publish and file", auto: true }));
    const { s, ctx, flashes } = await screenFrom(w, r.events, cookie);
    const [pub, made] = lines(w, s);
    expect(text(pub)).toMatch(/^Publish doc Waiting for you .*Hookup doc/);
    expect(pub).toContain("Publishing waits for you, even on Auto.");
    expect(text(made)).toMatch(/^Created ticket #\d+ Just now Undo$/);
    expect((await first<{ c: number }>(env.DB, `SELECT current_version AS c FROM docs WHERE org_id = ? AND slug = 'hookup-doc'`, ORG_A))?.c ?? 0).toBe(0);
    // GUARD — only someone who may promote gets Confirm: the cookie person (a member) may, so the card offers it.
    const id = eventsOf(r.events, "action")[0].id;
    expect(pub).toContain(`data-act="askAcConfirm" data-arg="${id}"`);
    await w.confirmCards(ctx, [id]);
    expect((await first<{ c: number }>(env.DB, `SELECT current_version AS c FROM docs WHERE org_id = ? AND slug = 'hookup-doc'`, ORG_A))?.c).toBe(1);
    expect(text(lines(w, s)[0])).toBe("Published Hookup doc to the org Just now");
  });

  it("GUARD — Undo refused when the item changed since: the line says so, links the item, and nothing is undone", async () => {
    const w = await web();
    const cookie = await cookieFor(ME);
    const n = await create_ticket(await tenantCtx("AndresL230"), { title: "Hookup undo", body: "b", category: "other", priority: "normal", assignees: [ME] }, "AndresL230");
    const model = fakeModel([[{ type: "tool_use", name: "transition_ticket", input: { id: n, to: "testing" } }], answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "move it", auto: true }));
    const { s, ctx, flashes } = await screenFrom(w, r.events, cookie);
    expect(text(lines(w, s)[0])).toBe(`Moved ticket #${n} to Testing Just now Undo`);
    await new Promise((res) => setTimeout(res, 5));
    await edit_ticket(await tenantCtx("AndresL230"), n, { body: "someone else" }, "AndresL230");
    await w.undoCards(ctx, [eventsOf(r.events, "action_result")[0].id]);
    const line = lines(w, s)[0];
    expect(text(line)).toBe(`Moved ticket #${n} to Testing Changed since. Undo it by hand. Open ticket #${n}`);
    expect(line).toContain(`data-act="askShOpen" data-arg="ticket:${n}"`);
    expect(line).not.toContain("askAcUndo");
    expect((await ticketRow(n))?.status).toBe("testing");
    expect(flashes).toEqual([]);
  });

  it("an Undo that applies: the group is reversed and its line reads Undone", async () => {
    const w = await web();
    const cookie = await cookieFor(ME);
    const model = fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Hookup G1" } }, { type: "tool_use", name: "create_ticket", input: { title: "Hookup G2" } }], answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "two", auto: true }));
    const { s, ctx, flashes } = await screenFrom(w, r.events, cookie);
    const ids = eventsOf(r.events, "action_result").map((x: any) => x.id);
    const nums = eventsOf(r.events, "action_result").map((x: any) => x.ref.split(":")[1]);
    expect(text(lines(w, s)[0])).toBe(`Filed tickets #${nums[0]} and #${nums[1]} Just now Undo`);
    const refreshTickets = vi.fn();
    (ctx as any).refreshTickets = refreshTickets;
    await w.undoCards(ctx, ids);
    expect(text(lines(w, s)[0])).toBe(`Undone: filed tickets #${nums[0]} and #${nums[1]}`);
    expect((await ticketRow(Number(nums[0])))?.status).toBe("declined");
    expect(refreshTickets).toHaveBeenCalledTimes(1);     // an open Tickets board refetches: the declined cards leave it
  });

  it("GUARD — a replaced answer's cards expire: Confirm on one collapses it to its Expired line, nothing is written", async () => {
    const w = await web();
    const cookie = await cookieFor(ME);
    const model = fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Hookup replaced" } }], answer("A card."), answer("Another answer.")]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "file one" }));
    const { s, ctx, flashes } = await screenFrom(w, r.events, cookie);
    const threadId = eventsOf(r.events, "thread")[0].id;
    const answerId = eventsOf(r.events, "done")[0].messageId;
    await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { threadId, replaceFrom: answerId, text: "" }));
    const card = eventsOf(r.events, "action")[0];
    await w.confirmCards(ctx, [card.id]);
    expect(text(lines(w, s)[0])).toBe("Expired: new ticket This card expired with its turn. Ask again.");
    expect(flashes).toEqual(["This card expired with its turn. Ask again."]);
    expect(await first(env.DB, `SELECT number FROM tickets WHERE org_id = ? AND title = 'Hookup replaced'`, ORG_A)).toBeNull();
  });

  it("Cancel: the card becomes \"Cancelled: new ticket\" and the route will not run it", async () => {
    const w = await web();
    const cookie = await cookieFor(ME);
    const model = fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Hookup cancel" } }], answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "file one" }));
    const { s, ctx, flashes } = await screenFrom(w, r.events, cookie);
    const id = eventsOf(r.events, "action")[0].id;
    await w.cancelCards(ctx, [id]);
    expect(text(lines(w, s)[0])).toBe("Cancelled: new ticket");
    expect((await call("POST", `${BASE}/ask/actions/${id}/confirm`, cookie, {})).status).toBe(409);
  });

  it("Save as artifact from the footer: the route adds the form, Save writes the artifact, the form becomes its saved line", async () => {
    const w = await web();
    const cookie = await cookieFor(ME);
    const model = fakeModel([answer("Hosting is two tickets away.")]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "status?" }));
    const { s, ctx, flashes } = await screenFrom(w, r.events, cookie);
    await w.addSaveForm(ctx, "a1");
    const a = s.ask.page.messages[1];
    const part = w.shownParts(a.turn).find((p: any) => p.kind === "block" && p.block.kind === "save_form");
    expect(text(w.saveFormView(w.askView(s), a, part.block, part.index))).toMatch(/^Save as artifact Markdown HTML page Private Org Save/);
    s.ask.actions.forms[`a1|${part.index}`] = { title: "Hosting, from Ask", visibility: "private" };
    await w.saveArtifact(ctx, `a1|${part.index}`);
    const saved = w.shownParts(s.ask.page.messages[1].turn).find((p: any) => p.kind === "block" && p.block.kind === "save_form");
    expect(text(w.saveFormView(w.askView(s), s.ask.page.messages[1], saved.block, saved.index))).toBe("Saved as artifact: Hosting, from Ask · Private Open");
    expect(flashes).toEqual(["Saved to Artifacts"]);
    expect(await first(env.DB, `SELECT kind, visibility FROM artifact_pages WHERE org_id = ? AND slug = ?`, ORG_A, saved.block.form.saved.slug)).toMatchObject({ visibility: "private" });
  });

  it("Wrong?: the picked reason reaches the route with the answer's mode and cites; the toast says Review", async () => {
    const w = await web();
    const cookie = await cookieFor(ME);
    const model = fakeModel([answer("Something.")]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "anything" }));
    const { s, ctx, flashes } = await screenFrom(w, r.events, cookie);
    await w.markWrong(ctx, "a1", "missed");
    const row = await first<{ detail_json: string }>(env.DB, `SELECT detail_json FROM ai_feedback WHERE org_id = ? AND handle = ? AND item_type = 'ask' AND item_ref = ?`, ORG_A, ME, String(eventsOf(r.events, "done")[0].messageId));
    expect(JSON.parse(row!.detail_json)).toMatchObject({ reason: "missed", mode: "smart", cites: [] });
    expect(flashes).toEqual(["Thanks. The team can see this in Review."]);
  });
});
