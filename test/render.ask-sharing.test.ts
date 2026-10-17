/**
 * Ask Trov — sharing a conversation with the org (0076_ask_sharing; docs/architecture/ask.md › Sharing a
 * conversation), on the screen: the thread menu's "Share with <org>" (asking first through `confirmModal`, with what
 * stays private — the attached files) and "Stop sharing"; the owner's shared mark; "Shared in <org>" with each
 * owner's picture and name; and someone else's shared conversation drawn READ-ONLY — whose it is (a clickable person)
 * in the composer's place, no Edit / Regenerate / Save / Wrong? / follow-ups / Try again, cards as lines with no
 * Confirm or Undo, the owner's files by name only.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
import { render, initialState, type AppState } from "../web/src/render";
import { askView, readOnly, type AskCtx, type AskSendInput } from "../web/src/ask-state";
import { conversationView, conversationPart } from "../web/src/ask-conversation";
import { composerView, composerPart } from "../web/src/ask-composer";
import { threadsView, threadsPart, threadShareModal } from "../web/src/ask-threads";
import { askHeader } from "../web/src/ask-screen";
import { convoFromDetail } from "../web/src/ask-stream";
import { askRefFixtures, askStateFixture, askThreadsFixture } from "@shared/ai-fixtures";
import type { AskAction, AskMessage, AskThreadDetail, AskThreadSummary } from "@shared/ai-ask-core";
import type { PersonSummary } from "@shared/people";
import css from "../web/src/trov.css?raw";

const NOW = new Date("2026-10-15T12:00:00Z");
const AT = "2026-10-15T11:00:00Z";
const ME = { handle: "andres", name: "Andres Lopez", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "owner" as const }], superadmin: false, pending_invites: 0 };
const PERSONS: PersonSummary[] = [
  { handle: "andres", name: "Andres Lopez", color: "moss", avatar_url: null, role: null },
  { handle: "meilin", name: "Mei Lin", color: "sky", avatar_url: "/api/avatars/meilin.png", role: null },
];

function base(): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "ask"; s.orgSlug = "saplinglearn";
  (s as { me: unknown }).me = ME;
  s.persons = { status: "ok", data: PERSONS } as AppState["persons"];
  s.ask.vw = 1440;
  s.ask.state = { status: "ok", data: askStateFixture("pro", NOW) };
  s.ask.threads = { status: "ok", data: askThreadsFixture(NOW) };
  s.ask.refViews = askRefFixtures(NOW);
  return s;
}

const card = (over: Partial<AskAction>): AskAction => ({
  id: 11, groupId: null, tool: "create_ticket", kind: "ticket", state: "proposed",
  preview: { title: "New ticket", lines: [{ label: "Title", value: "Shared card" }], item: null },
  fields: { title: "Shared card", category: "bug", priority: "normal", assignee: null }, editable: ["title"], note: null, result: null, ref: null, undo: false,
  createdAt: AT, decidedAt: null, ...over,
});
const msg = (over: Partial<AskMessage>): AskMessage => ({
  id: 1, role: "user", mode: "smart", text: "", command: null, context: [], blocks: [], activity: [], followups: [], thinking: null, cites: [],
  attachments: [], actions: [], stopped: false, model: null, units: 0, createdAt: AT, ...over,
});

/** One exchange: a question with a file, an answer with a not-found's tries, a proposed card, a done one with Undo, follow-ups. */
function detail(thread: Partial<AskThreadSummary>): AskThreadDetail {
  return {
    thread: {
      id: 42, title: "Release blockers", pinned: false, mode: "smart", auto: false, origin: "page", contextRef: null, hasDraft: false, group: "today",
      createdAt: AT, updatedAt: AT, draft: "", ...thread,
    },
    messages: [
      msg({ id: 1, role: "user", text: "What is blocking the release?", attachments: [{ id: 5, slug: thread.viewer ? "" : "notes-md", title: "notes.md", kind: "text", contentType: "text/markdown", size: 2048, sha256: "" }] }),
      msg({
        id: 2, role: "assistant", text: "Two things block it.", followups: ["And then?"], model: "claude-sonnet-5-5", units: 1,
        blocks: [{ kind: "not_found", notFound: { query: "billing", tries: ["Ask about the sprint"], searched: [] } }],
        actions: [card({}), card({ id: 12, state: "confirmed", ref: "ticket:14", undo: !thread.viewer, editable: [], decidedAt: AT, result: { id: 14 } })],
      }),
    ],
  };
}

/** The Ask page with this thread open. */
function opened(thread: Partial<AskThreadSummary>): AppState {
  const s = base();
  s.ask.page = { ...convoFromDetail(detail(thread)), uid: "c1" };
  return s;
}
const VIEWER = { viewer: true, owner: "meilin", shared: true } as const;

describe("someone else's shared conversation reads read-only", () => {
  it("no Edit, Regenerate, Save, Wrong?, follow-ups or tries to send — Copy and the sources stay", () => {
    const s = opened(VIEWER);
    expect(readOnly(askView(s))).toBe(true);
    const html = conversationView(askView(s));
    expect(html).toContain("What is blocking the release?");
    expect(html).toContain("Two things block it.");
    for (const act of ["askCvEdit", "askCvRegen", "askAcSaveForm", "askAcWrong", "askCvSend", "askCvRetry", "askAcConfirm", "askAcCancel", "askAcUndo", "askAcText", "askAcField", "askAcPick"]) {
      expect(html, act).not.toContain(`data-act="${act}"`);
    }
    expect(html).toContain(`data-act="askCvCopy"`);
    // The not-found's tries are words, not buttons.
    expect(html).toMatch(/<span class="ask-nf-try is-static">[\s\S]*?Ask about the sprint/);
  });

  it("a proposed card is a line that waits for its owner; a done one has no Undo", () => {
    const html = conversationView(askView(opened(VIEWER)));
    expect(html).toContain("Proposed: ");
    expect(html).toContain("Waiting for Mei Lin to confirm it.");
    expect(html).not.toContain("ask-act-btns");
    expect(html).toMatch(/class="ask-line"[\s\S]*?data-act="askShOpen" data-arg="ticket:14"/);
    // The owner sees the same card as a card, with its pair and Undo.
    const own = conversationView(askView(opened({ shared: true })));
    expect(own).toContain(`data-act="askAcConfirm"`);
    expect(own).toContain(`data-act="askAcUndo"`);
    expect(own).toContain(`data-act="askCvEdit"`);
  });

  it("the owner's file is its name and size, marked Private — never a control, never a preview", () => {
    const html = conversationView(askView(opened(VIEWER)));
    expect(html).toMatch(/<span class="ask-co-chip ask-q-chip is-closed" data-mtip="Private to Mei Lin: you can see its name, not what is in it\.">/);
    expect(html).toContain("notes.md");
    expect(html).toContain("2 KB · Private");
    expect(html).not.toMatch(/data-act="askCvOpen" data-arg="askcv:page:m1:upload/);
    // The owner's own chip opens the file.
    expect(conversationView(askView(opened({ shared: true })))).toMatch(/data-act="askCvOpen" data-arg="askcv:page:m1:upload:5"/);
  });

  it("the composer's place says whose it is — their picture and name open their card — and that only they continue it", () => {
    const s = opened(VIEWER);
    const bar = composerView(askView(s));
    expect(bar).toContain("ask-composer--shared");
    expect(bar).toMatch(/<button data-act="openPerson" data-arg="meilin" class="cnpy-personchip"[\s\S]*?\/api\/avatars\/meilin\.png[\s\S]*?Mei Lin/);
    expect(bar).toContain("shared this conversation with SaplingLearn. Only Mei Lin can continue it.");
    expect(bar).not.toContain("data-ask-input");
    expect(bar).not.toContain("ask-co-file");
    const page = render(s);
    expect(page).toContain("ask-composer--shared");
    expect(page).not.toContain(`data-ask-input="page"`);
    // Never a button inside a button: the person is the bar's only control.
    expect(bar.match(/<button/g)?.length).toBe(1);
    expect(css).toMatch(/\.ask-ro \{[^}]*display:flex/);
  });

  it("the header says it is shared, and by whom; the owner's says it too, and a private thread says nothing", () => {
    const viewer = askHeader(opened(VIEWER)).crumb;
    expect(viewer).toContain("Release blockers");
    expect(viewer).toMatch(/data-mtip="Mei Lin shared this with SaplingLearn\. Everyone there can read it; only Mei Lin can continue it\."[^>]*>[\s\S]*?Shared/);
    expect(askHeader(opened({ shared: true })).crumb).toContain("Shared with SaplingLearn: everyone there can read it. Only you can continue it.");
    expect(askHeader(opened({ shared: false })).crumb).not.toContain("Shared");
  });

  it("acts that would ask again do nothing there; a dropped file is not taken", () => {
    const s = opened(VIEWER);
    const sent: AskSendInput[] = [];
    const ctx = { ui: s.ask, app: s, paint() {}, send: (i: AskSendInput) => { sent.push(i); }, exit: (_k: string, apply: () => void) => apply(), cancelExit() {} } as unknown as AskCtx;
    conversationPart.act!(ctx, "askCvSend", "And then?", null);
    conversationPart.act!(ctx, "askCvRegen", "page:m2", null);
    conversationPart.act!(ctx, "askCvRetry", "page:m2", null);
    conversationPart.act!(ctx, "askCvEdit", "page:m1", null);
    expect(sent).toEqual([]);
    expect(s.ask.conversation.editing).toBeNull();
    const zone = { getAttribute: (n: string) => (n === "data-ask-drop" ? "page" : null), contains: () => true };
    const drop = { target: { closest: () => zone }, dataTransfer: { types: ["Files"], files: [] }, preventDefault() {} } as unknown as DragEvent;
    expect(composerPart.onDrop!(ctx, drop)).toBe(false);
    expect(composerPart.onDragOver!(ctx, drop)).toBe(false);
    // On the owner's own (shared) thread the same drag is taken.
    const own = opened({ shared: true });
    const octx = { ...ctx, ui: own.ask, app: own } as unknown as AskCtx;
    expect(composerPart.onDragOver!(octx, drop)).toBe(true);
  });
});

describe("the thread list: share, stop sharing, and Shared in <org>", () => {
  it("the owner's ⋯ menu offers Share with <org>, or Stop sharing once it is; a shared row carries the quiet mark", () => {
    const s = base();
    const [a, b] = s.ask.threads.data;
    s.ask.threads.data = s.ask.threads.data.map((t) => (t.id === b.id ? { ...t, shared: true } : t));
    s.ask.threadMenu = a.id;
    const html = threadsView(askView(s));
    expect(html).toMatch(new RegExp(`data-act="askThShare" data-arg="${a.id}"[^>]*>[\\s\\S]*?Share with SaplingLearn`));
    s.ask.threadMenu = b.id;
    expect(threadsView(askView(s))).toMatch(new RegExp(`data-act="askThUnshare" data-arg="${b.id}"[^>]*>[\\s\\S]*?Stop sharing`));
    // The mark: a glyph named "Shared", its tooltip what it means — not a pill, not a word in caps.
    const row = threadsView(askView(s)).split(`data-morph-key="th:${b.id}"`)[1].split(`data-morph-key="th:`)[0];
    expect(row).toMatch(/<span class="ask-th-mark"><svg[^>]*role="img" aria-label="Shared"[^>]*data-mtip="Shared with SaplingLearn: everyone there can read it\. Only you can continue it\."/);
    const other = threadsView(askView(s)).split(`data-morph-key="th:${a.id}"`)[1].split(`data-morph-key="th:`)[0];
    expect(other).not.toContain("ask-th-mark");
  });

  it("Shared in <org> lists others' conversations: title, time, the owner's picture and name — one button, no menu", () => {
    const s = base();
    expect(threadsView(askView(s))).not.toContain("Shared in");
    s.ask.shared = { status: "ok", data: [{ ...detail(VIEWER).thread, id: 77, title: "Release blockers" }] };
    s.ask.page = { ...s.ask.page, threadId: 77 };
    const html = threadsView(askView(s));
    expect(html).toContain(`<div class="ask-th-head ask-th-head--shared">Shared in SaplingLearn</div>`);
    const row = html.split(`data-morph-key="sh:77"`)[1];
    expect(row).toMatch(/^[^]*?<button type="button" class="ask-th-b ask-th-b--hit ask-th-b--shared is-on" data-act="askThOpen" data-arg="77" aria-current="page" aria-label="Release blockers, shared by Mei Lin">/);
    expect(row).toContain("/api/avatars/meilin.png");
    expect(row).toContain(`<span class="ask-th-owner-n">Mei Lin</span>`);
    expect(row).not.toContain("askThMore");
    expect(row.split("</button>")[0]).not.toMatch(/<button[\s\S]*<button/);
  });

  it("Share asks first (what members read, what stays private), Cancel writes nothing, Share writes it; Stop sharing writes at once", async () => {
    const s = base();
    const t = s.ask.threads.data[0];
    const patched: [number, unknown][] = [];
    const flashes: string[] = [];
    const ctx = {
      ui: s.ask, app: s, replay: false, paint() {}, exit: (_k: string, apply: () => void) => apply(), cancelExit() {}, reloadThreads() {},
      flash: (m: string) => { flashes.push(m); }, fail() {},
      api: { patchThread: async (id: number, p: unknown) => { patched.push([id, p]); return { ...t, shared: true }; } },
    } as unknown as AskCtx;
    threadsPart.act!(ctx, "askThShare", String(t.id), null);
    expect(s.ask.threadShare).toEqual({ id: t.id, title: t.title });
    const root = render(s);
    expect(root).toMatch(/data-overlay="confirm-ask-th-share" data-confirm-layer data-confirm-tone="neutral"[\s\S]*role="alertdialog"/);
    expect(root).toContain(`Share “${t.title}” with SaplingLearn?`);
    expect(root).toContain("Everyone in SaplingLearn can open it and read the whole conversation");
    expect(root).toContain("Files you attached stay private: members see each file&#39;s name, not what is in it.");
    expect(root).toMatch(new RegExp(`data-confirm-act="askThShareGo" data-confirm-cancel="askThShareCancel" data-arg="${t.id}"`));
    expect(threadShareModal({ threadShare: null, closing: {} }, "SaplingLearn")).toBe("");
    threadsPart.act!(ctx, "askThShareCancel", String(t.id), null);
    expect(s.ask.threadShare).toBeNull();
    expect(patched).toEqual([]);
    threadsPart.act!(ctx, "askThShare", String(t.id), null);
    threadsPart.act!(ctx, "askThShareGo", String(t.id), null);
    await new Promise((r) => setTimeout(r, 0));
    expect(patched).toEqual([[t.id, { shared: true }]]);
    expect(s.ask.threadShare).toBeNull();
    expect(s.ask.threads.data.find((x) => x.id === t.id)?.shared).toBe(true);
    expect(flashes.at(-1)).toBe("Shared with SaplingLearn");
    threadsPart.act!(ctx, "askThUnshare", String(t.id), null);
    await new Promise((r) => setTimeout(r, 0));
    expect(patched.at(-1)).toEqual([t.id, { shared: false }]);
    expect(s.ask.threads.data.find((x) => x.id === t.id)?.shared).toBe(false);
    expect(flashes.at(-1)).toBe("Stopped sharing. Only you can read it now.");
  });
});
