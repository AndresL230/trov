/**
 * Ask Trov — where the parts meet (the integrator's tests): the conversation draws the actions part's buttons with
 * the actions part's argument format, so a footer Save, a block's Save and Wrong? reach the right answer and block.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
import { render, initialState, type AppState } from "../web/src/render";
import { actionsPart } from "../web/src/ask-actions";
import { composerPart } from "../web/src/ask-composer";
import { inspectorBody } from "../web/src/ask-inspector";
import { askView } from "../web/src/ask-state";
import type { RefView } from "@shared/ai-ask-core";
import { convoFromDetail, storedParts, withQuestionId } from "../web/src/ask-stream";
import { SseParser, askEventOf } from "../web/src/ask-sse";
import { emptyConvo, foldAskEvent, foldThreadEvent, newTurn, withLastTurn, type AskConvo } from "../web/src/ask-stream";
import type { AskApi } from "../web/src/ask-api";
import type { AskCtx } from "../web/src/ask-state";
import { askRefFixtures, askStateFixture, askThreadsFixture } from "@shared/ai-fixtures";
import answerSse from "../docs/superpowers/specs/ask-transcripts/answer.sse?raw";

const NOW = new Date("2026-10-15T12:00:00Z");
const ME = { handle: "andres", name: "Andres Lopez", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "owner" as const }], superadmin: false, pending_invites: 0 };

function answered(): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "ask"; s.orgSlug = "saplinglearn";
  (s as { me: unknown }).me = ME;
  s.ask.vw = 1440;
  s.ask.state = { status: "ok", data: askStateFixture("pro", NOW) };
  s.ask.threads = { status: "ok", data: askThreadsFixture(NOW) };
  s.ask.refViews = askRefFixtures(NOW);
  const p = new SseParser();
  let c: AskConvo = { ...emptyConvo(), messages: [{ role: "user", key: "q1", id: 4, text: "What's blocking the hosting work?", context: [], attachments: [], command: null }, { role: "assistant", key: "a1", turn: newTurn("smart") }] };
  for (const m of [...p.push(answerSse), ...p.flush()]) {
    const e = askEventOf(m)!;
    c = e.event === "thread" ? foldThreadEvent(c, e.data) : withLastTurn(c, (t) => foldAskEvent(t, e, 0));
  }
  s.ask.page = c;
  return s;
}

function ctxOf(s: AppState, api: Partial<AskApi>): AskCtx {
  return {
    get app() { return s; }, get ui() { return s.ask; }, api: api as AskApi, replay: false,
    look: () => ({ views: s.ask.refViews, persons: s.persons.data }), paint: () => undefined, flash: () => undefined, fail: () => undefined,
    want: () => undefined, send: () => undefined, stop: () => undefined, openRef: () => undefined, closeInspector: () => undefined,
    newThread: () => undefined, openThread: () => undefined, reloadThreads: () => undefined, exit: (_k, apply) => { apply(); }, cancelExit: () => undefined,
  } as AskCtx;
}
const argsOf = (html: string, act: string): string[] => [...html.matchAll(new RegExp(`data-act="${act}" data-arg="([^"]*)"`, "g"))].map((m) => m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"'));

describe("Save as artifact and Wrong? — the conversation speaks the actions part's format", () => {
  it("the footer's Save asks for the whole answer's form, a block's Save for that block's", async () => {
    const s = answered();
    const messageId = s.ask.page.messages[1].role === "assistant" ? s.ask.page.messages[1].turn.messageId : null;
    expect(messageId).not.toBeNull();
    const saves = argsOf(render(s), "askAcSaveForm");
    // One per rich block, then the footer's.
    expect(saves).toContain("a1");
    const blocks = saves.filter((a) => a.startsWith("a1|"));
    expect(blocks.length).toBeGreaterThan(0);
    const asked: [number, number | undefined][] = [];
    const api = { saveForm: async (id: number, block?: number) => { asked.push([id, block]); return { block: { kind: "save_form" as const, form: { messageId: id, block: block ?? null, title: "T", kind: "html" as const, visibility: "private" as const, saved: null } }, index: 0 }; } };
    actionsPart.act!(ctxOf(s, api), "askAcSaveForm", "a1", null);
    await new Promise((r) => setTimeout(r, 0));
    const t = answered();
    actionsPart.act!(ctxOf(t, api), "askAcSaveForm", blocks[0], null);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([[messageId, undefined], [messageId, Number(blocks[0].split("|")[1])]]);
  });

  it("Wrong? toggles the answer's reasons row, and the footer button says it is open", () => {
    const s = answered();
    const [arg] = argsOf(render(s), "askAcWrong");
    expect(arg).toBe("a1");
    actionsPart.act!(ctxOf(s, {}), "askAcWrong", arg, null);
    expect(s.ask.actions.wrongOpen.a1).toBe(true);
    expect(render(s)).toMatch(/data-act="askAcWrong" data-arg="a1" aria-expanded="true"/);
  });
});

describe("the composer's contract gaps, closed", () => {
  it("a thread's stored draft is kept on the conversation explicitly (AskConvo.draft), not riding on the thread", () => {
    const t = askThreadsFixture(NOW)[0];
    const c = convoFromDetail({ thread: { ...t, draft: "half a thought" }, messages: [] });
    expect(c.draft).toBe("half a thought");
    expect("draft" in (c.thread as object)).toBe(false);
    expect(convoFromDetail({ thread: t, messages: [] }).draft).toBe("");
  });

  it("the quota upsell reads Pro's per-seat number from ask/state, not the client's plans", () => {
    const s = answered();
    s.ask.state = { status: "ok", data: { ...askStateFixture("free", NOW), allowance: { used: 50, cap: 50, resetsAt: "2026-11-01T00:00:00Z", low: true }, proPerSeat: 123 } };
    expect(render(s)).toContain("Pro includes 123 a month");
  });

  it("removing an uploaded chip deletes the attachment on the server; a chip still uploading asks nothing", () => {
    const s = answered();
    const att = { id: 77, slug: "shot-png", title: "shot.png", kind: "image" as const, contentType: "image/png", size: 10, sha256: "x" };
    s.ask.composer.page = { ...s.ask.composer.page, files: [
      { key: "k1", name: "shot.png", size: 10, kind: "image", state: "ready", att, preview: null },
      { key: "k2", name: "big.png", size: 10, kind: "image", state: "uploading", att: null, preview: null },
    ], attachments: [att] };
    const deleted: number[] = [];
    const ctx = ctxOf(s, { deleteAttachment: async (id: number) => { deleted.push(id); } });
    composerPart.act!(ctx, "askCoRemove", "page|f:k1", null);
    composerPart.act!(ctx, "askCoRemove", "page|f:k2", null);
    expect(deleted).toEqual([77]);
    expect(s.ask.composer.page.files).toEqual([]);
    expect(s.ask.composer.page.attachments).toEqual([]);
  });
});

describe("the conversation's contract gaps, closed", () => {
  it("done.questionId gives the streamed question its stored id (Edit needs no read first)", () => {
    const c = answered().ask.page;
    const q = { ...c, messages: c.messages.map((m) => (m.role === "user" ? { ...m, id: null } : m)) };
    const after = withQuestionId(q, 41);
    expect(after.messages[0].role === "user" && after.messages[0].id).toBe(41);
    expect(withQuestionId(q, undefined)).toBe(q);
  });

  it("a stored answer is drawn in its streamed order; a block added later (a save form) follows; an old row is text, blocks, cards", () => {
    const chart = { kind: "not_found" as const, notFound: { query: "x", tries: [], searched: [] } };
    const form = { kind: "save_form" as const, form: { messageId: 2, block: null, title: "T", kind: "html" as const, visibility: "private" as const, saved: null } };
    const m = { text: "Before. After.", blocks: [chart, form], actions: [],
      parts: [{ kind: "text" as const, md: "Before. " }, { kind: "block" as const, index: 0 }, { kind: "text" as const, md: "After." }] };
    expect(storedParts(m as never).map((p) => p.kind === "block" ? `block:${p.block.kind}` : p.kind)).toEqual(["text", "block:not_found", "text", "block:save_form"]);
    expect(storedParts({ ...m, parts: undefined } as never).map((p) => p.kind === "block" ? `block:${p.block.kind}` : p.kind)).toEqual(["text", "block:not_found", "block:save_form"]);
  });
});

describe("the inspector's contract gaps, closed (it draws the server's projections)", () => {
  const withItem = (ref: string, view: RefView, detail: Record<string, unknown>) => {
    const s = answered();
    s.ask.refViews = { ...s.ask.refViews, [ref]: view };
    s.ask.inspector = { ...s.ask.inspector, stack: [ref], idx: 0 };
    s.ask.inspectorUi.items[ref] = { status: "ok", data: { view, detail } };
    return inspectorBody(askView(s, "page"), ref).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  };

  it("a staged doc's excerpt is the staged body", () => {
    const view: RefView = { ref: "doc:d", type: "doc", title: "D", status: { mark: "ring", tone: "amber", word: "Staged, not approved", tip: "" }, href: null, extra: { staged: true } };
    const t = withItem("doc:d", view, { body: "The live words.", staged: { version: 2, body: "The words waiting in Review." }, versions: [{ version: 1, status: "promoted" }, { version: 2, status: "staged" }] });
    expect(t).toContain("The words waiting in Review.");
    expect(t).not.toContain("The live words.");
  });

  it("a feed entry Trov wrote is Trov's by its ai origin, with Sift's importance", () => {
    const view: RefView = { ref: "feed:9", type: "feed", title: "Weekly", status: null, href: null, extra: {} };
    const t = withItem("feed:9", view, { entry: { author: "someone", summary: "Weekly", brief: null, body: null, artifacts: null, created_at: "2026-10-15T09:00:00Z", ai: { origin: "ai", subject: null, sources: [], moreCount: 0, generatedAt: null, model: "m" }, importance: "breaking", tags: ["hosting"] } });
    expect(t).toContain("Trov");
    expect(t).toContain("Breaking");
    expect(t).toContain("hosting");
  });

  it("a pull request's files: the count when complete, N+ when the read stopped short; no line counts drawn", () => {
    const view: RefView = { ref: "pr:5", type: "pr", num: 5, title: "P", status: null, href: null, extra: {} };
    expect(withItem("pr:5", view, { files: 3, filePaths: ["a", "b", "c"], filesComplete: true, additions: null, deletions: null, linkedTo: [] })).toContain("3 files");
    const partial = withItem("pr:5", view, { files: null, filePaths: ["a", "b"], filesComplete: false, additions: null, deletions: null, linkedTo: [] });
    expect(partial).toContain("2+ files");
    expect(partial).not.toMatch(/\+\d+ −/);
  });
});
