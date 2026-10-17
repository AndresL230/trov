/**
 * Ask Trov — sharing a conversation (0076 / 0077_ask_sharing; docs/architecture/ask.md › Sharing a conversation), on
 * the screen: the thread menu's "Share…" (the Share dialog: everyone in the org can read it, and people by name, each
 * "Can read" or "Can continue") and "Stop sharing"; the owner's shared mark; "Shared with you" and "Organization" with
 * each owner's picture and name; someone else's conversation drawn READ-ONLY for read access — whose it is (a
 * clickable person) in the composer's place, no Edit / Regenerate / Save / Wrong? / follow-ups / Try again, cards as
 * lines with no Confirm or Undo, the owner's files by name only — and, for "Can continue", the composer back with
 * every turn its own asker's: Edit, Regenerate, Save, Wrong?, cards only on the person's own turns, anyone else's
 * file closed (the owner's to a collaborator, a collaborator's to the owner).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
import { render, initialState, type AppState } from "../web/src/render";
import { askView, readOnly, type AskCtx, type AskSendInput } from "../web/src/ask-state";
import { conversationView, conversationPart } from "../web/src/ask-conversation";
import { composerView, composerPart } from "../web/src/ask-composer";
import { threadsView, threadsPart, threadShareModal, threadDeleteModal, shareDropdowns } from "../web/src/ask-threads";
import { actionDropdowns } from "../web/src/ask-actions";
import { askHeader } from "../web/src/ask-screen";
import { convoFromDetail } from "../web/src/ask-stream";
import { askRefFixtures, askStateFixture, askThreadsFixture } from "@shared/ai-fixtures";
import type { AskAction, AskMessage, AskThreadDetail, AskThreadPatch, AskThreadSummary } from "@shared/ai-ask-core";
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
const VIEWER = { viewer: true, owner: "meilin", shared: true, access: "read", direct: false } as const;
const CONTINUE = { viewer: true, owner: "meilin", shared: false, access: "continue", direct: true } as const;

/** A thread with a second turn after the fixture's exchange, asked by `by` (with a file and a proposed card). */
function twoAskers(thread: Partial<AskThreadSummary>, first: string, by: string): AppState {
  const d = detail(thread);
  d.messages = d.messages.map((m) => ({ ...m, askedBy: first }));
  d.messages.push(
    msg({ id: 3, role: "user", text: "Who owns it?", askedBy: by, attachments: [{ id: 6, slug: by === "andres" ? "log-txt" : "", title: "log.txt", kind: "text", contentType: "text/plain", size: 1024, sha256: "" }] }),
    msg({ id: 4, role: "assistant", text: "Mei Lin does.", askedBy: by, model: "claude-sonnet-5-5", units: 1, followups: ["What next?"], actions: [card({ id: 21 }), card({ id: 22, state: "confirmed", ref: "ticket:15", undo: false, editable: [], decidedAt: AT, result: { id: 15 } })] }),
  );
  const s = base();
  s.ask.page = { ...convoFromDetail(d), uid: "c1" };
  return s;
}
/** The markup of one message (`m<id>`), cut from the conversation. */
const part = (html: string, key: string): string => html.split(`data-morph-key="${key}"`)[1]?.split(/data-morph-key="[qa]:m\d+"/)[0] ?? "";

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
    expect(bar).toContain("shared this conversation with SaplingLearn. You can read it, not continue it.");
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
    expect(viewer).toMatch(/data-mtip="Mei Lin shared this with SaplingLearn\. Everyone there can read it\."[^>]*>[\s\S]*?Shared/);
    expect(askHeader(opened({ ...VIEWER, direct: true })).crumb).toContain("Mei Lin shared this with you. You can read it.");
    expect(askHeader(opened(CONTINUE)).crumb).toContain("Mei Lin shared this with you. You can read it and continue it.");
    expect(askHeader(opened({ shared: true })).crumb).toContain(`data-mtip="Shared with SaplingLearn."`);
    expect(askHeader(opened({ shared: false, people: [{ handle: "meilin", access: "continue" }] })).crumb).toContain(`data-mtip="Shared with Mei Lin."`);
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

describe("shared with a person by name: Can continue gives them the composer, and every turn is its asker's", () => {
  it("a person who can continue gets the box and a note whose it is; their own turn has Edit and Regenerate, the owner's does not", () => {
    const s = twoAskers(CONTINUE, "meilin", "andres");
    const v = askView(s);
    expect(readOnly(v)).toBe(false);
    const bar = composerView(v);
    expect(bar).toContain(`data-ask-input="page"`);
    expect(bar).not.toContain("ask-composer--shared");
    expect(bar).toMatch(/class="ask-co-note ask-co-shared"[\s\S]*?data-act="openPerson" data-arg="meilin"[\s\S]*?shared this with you\. You can continue it: your questions are asked as you\./);
    const html = conversationView(v);
    const mine = part(html, "a:m4"), theirs = part(html, "a:m2");
    expect(part(html, "q:m3")).toContain(`data-act="askCvEdit"`);
    expect(mine).toContain(`data-act="askCvRegen"`);
    expect(mine).toContain(`data-act="askAcSaveForm"`);
    expect(mine).toContain(`data-act="askAcWrong"`);
    expect(mine).toContain(`data-act="askAcConfirm"`);
    for (const act of ["askCvRegen", "askAcSaveForm", "askAcWrong", "askAcConfirm", "askAcUndo"]) expect(theirs, act).not.toContain(`data-act="${act}"`);
    expect(theirs).toContain("Waiting for Mei Lin to confirm it.");
    // Follow-ups: the person may ask on.
    expect(mine).toContain(`data-act="askCvSend" data-arg="What next?"`);
    // Two people asked: each question says who — "You", or the other's picture and name (a clickable person).
    expect(part(html, "q:m3")).toContain(`<div class="ask-q-who">You</div>`);
    expect(part(html, "q:m1")).toMatch(/<div class="ask-q-who"><button data-act="openPerson" data-arg="meilin"/);
    // Their own file opens; the owner's stays closed.
    expect(part(html, "q:m3")).toMatch(/data-act="askCvOpen" data-arg="askcv:page:m3:upload:6"/);
    expect(part(html, "q:m1")).toContain("Private to Mei Lin");
  });

  it("the owner's last turn in a conversation shared with you is not yours to edit or regenerate", () => {
    const s = twoAskers(CONTINUE, "andres", "meilin");
    const html = conversationView(askView(s));
    expect(part(html, "q:m3")).not.toContain(`data-act="askCvEdit"`);
    expect(part(html, "a:m4")).not.toContain(`data-act="askCvRegen"`);
    const sent: AskSendInput[] = [];
    const ctx = { ui: s.ask, app: s, paint() {}, send: (i: AskSendInput) => { sent.push(i); }, exit: (_k: string, apply: () => void) => apply(), cancelExit() {} } as unknown as AskCtx;
    conversationPart.act!(ctx, "askCvRegen", "page:m4", null);
    conversationPart.act!(ctx, "askCvEdit", "page:m3", null);
    expect(sent).toEqual([]);
    expect(s.ask.conversation.editing).toBeNull();
  });

  it("read access by name: no composer, and the line says it was shared with you", () => {
    const bar = composerView(askView(opened({ ...VIEWER, direct: true })));
    expect(bar).toContain("ask-composer--shared");
    expect(bar).toContain("shared this conversation with you. You can read it, not continue it.");
    expect(bar).not.toContain("data-ask-input");
  });

  it("the owner reads a collaborator's turn as it was answered: no Edit, Regenerate or Undo, their file closed, their card waits for them", () => {
    const s = twoAskers({ shared: false, people: [{ handle: "meilin", access: "continue" }] }, "andres", "meilin");
    const html = conversationView(askView(s));
    expect(part(html, "q:m3")).not.toContain(`data-act="askCvEdit"`);
    expect(part(html, "q:m3")).toMatch(/<span class="ask-co-chip ask-q-chip is-closed" data-mtip="Private to Mei Lin: you can see its name, not what is in it\.">/);
    const theirs = part(html, "a:m4");
    for (const act of ["askCvRegen", "askAcSaveForm", "askAcWrong", "askAcConfirm", "askAcUndo", "askCvRetry"]) expect(theirs, act).not.toContain(`data-act="${act}"`);
    expect(theirs).toContain("Waiting for Mei Lin to confirm it.");
    // The owner's own turn keeps its card, its Undo and its file.
    const own = part(html, "a:m2");
    expect(own).toContain(`data-act="askAcConfirm"`);
    expect(part(html, "q:m1")).toMatch(/data-act="askCvOpen" data-arg="askcv:page:m1:upload:5"/);
    // The owner still asks on: their composer, no note.
    const bar = composerView(askView(s));
    expect(bar).toContain(`data-ask-input="page"`);
    expect(bar).not.toContain("ask-co-shared");
    // A card waiting on someone else never puts its dropdowns among the root overlays.
    expect(actionDropdowns(s).some((d) => d.id.includes("21"))).toBe(false);
  });

  it("a collaborator who deleted their account reads as Deleted user — never their deleted-… handle (e2e C59)", () => {
    const gone = "deleted-hav45t72pi";
    const s = twoAskers({ shared: false }, "andres", gone);
    const html = conversationView(askView(s));
    expect(html).not.toContain(gone);
    expect(part(html, "q:m3")).toContain("Deleted user");
    expect(part(html, "q:m3")).toContain(`data-mtip="Private to Deleted user: you can see its name, not what is in it."`);
    expect(part(html, "a:m4")).toContain("Waiting for Deleted user to confirm it.");
  });

  it("a thread with one asker shows no who-asked line", () => {
    expect(conversationView(askView(opened({ shared: true })))).not.toContain("ask-q-who");
  });
});

describe("the thread list: Share…, Stop sharing, Shared with you and Organization", () => {
  it("the owner's ⋯ menu offers Share…, and Stop sharing once shared with anyone; the mark's tooltip says with whom", () => {
    const s = base();
    const [a, b, c] = s.ask.threads.data;
    s.ask.threads.data = s.ask.threads.data.map((t) => (t.id === b.id ? { ...t, shared: true, people: [{ handle: "meilin", access: "read" as const }] }
      : t.id === c.id ? { ...t, people: [{ handle: "meilin", access: "continue" as const }] } : t));
    s.ask.threadMenu = a.id;
    const html = threadsView(askView(s));
    expect(html).toMatch(new RegExp(`data-act="askThShare" data-arg="${a.id}"[^>]*>[\\s\\S]*?Share…`));
    expect(html).not.toContain(`data-act="askThUnshare" data-arg="${a.id}"`);
    for (const id of [b.id, c.id]) {
      s.ask.threadMenu = id;
      expect(threadsView(askView(s))).toMatch(new RegExp(`data-act="askThUnshare" data-arg="${id}"[^>]*>[\\s\\S]*?Stop sharing`));
    }
    s.ask.threadMenu = null;
    const rowOf = (id: number) => threadsView(askView(s)).split(`data-morph-key="th:${id}"`)[1].split(`data-morph-key="th:`)[0];
    expect(rowOf(b.id)).toMatch(/<span class="ask-th-mark"><svg[^>]*role="img" aria-label="Shared"[^>]*data-mtip="Shared with SaplingLearn and 1 person\."/);
    expect(rowOf(c.id)).toContain(`data-mtip="Shared with Mei Lin."`);
    expect(rowOf(a.id)).not.toContain("ask-th-mark");
  });

  it("others' conversations: Shared with you (by name, Can continue said in words), then Organization; one button per row, no menu", () => {
    const s = base();
    expect(threadsView(askView(s))).not.toContain("ask-th-head--shared");
    const t = detail(VIEWER).thread;
    s.ask.shared = { status: "ok", data: [
      { ...t, id: 77, title: "Release blockers", direct: false, access: "read" },
      { ...t, id: 78, title: "Billing plan", direct: true, access: "continue", shared: true },
      { ...t, id: 79, title: "Deploy notes", direct: true, access: "read" },
    ] };
    s.ask.page = { ...s.ask.page, threadId: 77 };
    const html = threadsView(askView(s));
    const you = html.split(`<div class="ask-th-head ask-th-head--shared">Shared with you</div>`)[1]?.split("ask-th-head--shared")[0] ?? "";
    const org = html.split(`<div class="ask-th-head ask-th-head--shared">Organization</div>`)[1] ?? "";
    expect(html.indexOf("Shared with you")).toBeLessThan(html.indexOf(">Organization<"));
    expect(you).toContain(`data-morph-key="sh:78"`);
    expect(you).toContain(`data-morph-key="sh:79"`);
    expect(you).not.toContain(`data-morph-key="sh:77"`);
    expect(org).toContain(`data-morph-key="sh:77"`);
    expect(org).not.toContain(`data-morph-key="sh:78"`);
    const row = (id: number) => html.split(`data-morph-key="sh:${id}"`)[1].split(`data-morph-key="sh:`)[0];
    expect(row(78)).toContain(`<span class="ask-th-can">· Can continue</span>`);
    expect(row(78)).toContain(`aria-label="Billing plan, shared by Mei Lin, you can continue it"`);
    expect(row(79)).not.toContain("ask-th-can");
    expect(row(77)).toMatch(/^[^]*?<button type="button" class="ask-th-b ask-th-b--hit ask-th-b--shared is-on" data-act="askThOpen" data-arg="77" aria-current="page" aria-label="Release blockers, shared by Mei Lin">/);
    expect(row(77)).toContain("/api/avatars/meilin.png");
    expect(row(77)).toContain(`<span class="ask-th-owner-n">Mei Lin</span>`);
    expect(row(77)).not.toContain("askThMore");
    expect(row(77).split("</button>")[0]).not.toMatch(/<button[\s\S]*<button/);
  });

  function shareCtx(s: AppState) {
    const patched: [number, AskThreadPatch][] = [];
    const flashes: string[] = [];
    const ctx = {
      ui: s.ask, app: s, replay: false, paint() {}, exit: (_k: string, apply: () => void) => apply(), cancelExit() {}, reloadThreads() {},
      flash: (m: string) => { flashes.push(m); }, fail() {},
      api: { patchThread: async (id: number, p: AskThreadPatch) => { patched.push([id, p]); const { people: _was, ...t } = s.ask.threads.data.find((x) => x.id === id)!; return { ...t, shared: p.shared, ...(p.people?.length ? { people: p.people } : {}) }; } },
    } as unknown as AskCtx;
    return { ctx, patched, flashes };
  }

  it("on a phone, Share… from the threads drawer closes the drawer, so the dialog is not left under it (e2e C24)", () => {
    const s = base();
    s.ask.phone.drawer = true;
    const t = s.ask.threads.data[0];
    const { ctx } = shareCtx(s);
    threadsPart.act!(ctx, "askThShare", String(t.id), null);
    expect(s.ask.threadShare?.id).toBe(t.id);
    expect(s.ask.phone.drawer).toBe(false);
  });

  it("Share… opens the dialog — the org's switch, people with what they may do, Add a person, what stays private; Cancel writes nothing", () => {
    const s = base();
    const t = s.ask.threads.data[0];
    const { ctx, patched } = shareCtx(s);
    threadsPart.act!(ctx, "askThShare", String(t.id), null);
    expect(s.ask.threadShare).toEqual({ id: t.id, title: t.title, org: false, people: [], tab: "org", busy: false, error: null });
    const root = render(s);
    expect(root).toMatch(/data-overlay="ask-th-share" class="cnpy-cmodal"[\s\S]*?role="dialog" aria-modal="true" aria-labelledby="ask-th-share-t"/);
    expect(root).toContain(`Share “${t.title}”`);
    expect(root).toContain(`aria-label="Everyone in SaplingLearn"`);
    expect(root).toMatch(/data-seg="ask-share-org"[\s\S]*?class="cnpy-seg-btn is-on"[^>]*>No access/);
    // It opens on Share with org; Share with a teammate opens the bigger half — the people and Add a person.
    expect(root).toMatch(/data-seg="ask-share-tab"[\s\S]*?class="cnpy-seg-btn is-on"[^>]*>Share with org/);
    expect(root).toContain(`data-tab="org"`);
    expect(root).not.toContain(`data-dd="ask-share-add"`);
    expect(root).toContain("Files stay private to whoever attached them");
    threadsPart.act!(ctx, "askThShareTab", `${t.id}|people`, null);
    expect(s.ask.threadShare?.tab).toBe("people");
    const people = render(s);
    expect(people).toContain(`data-tab="people"`);
    expect(people).toMatch(/data-dd="ask-share-add"[\s\S]*?<span class="cnpy-dd-v is-placeholder">Add a person<\/span>/);
    expect(people).not.toContain(`data-seg="ask-share-org"`);
    expect(root).not.toContain("<select");
    // Add a person offers the org's members but never the owner.
    const add = shareDropdowns(s).find((d) => d.id === "ask-share-add")!;
    expect(add.options.map((o) => o.value)).toEqual(["meilin"]);
    threadsPart.act!(ctx, "askThShareOrg", `${t.id}|read`, null);
    threadsPart.act!(ctx, "askThShareAdd", String(t.id), "meilin");
    expect(s.ask.threadShare?.org).toBe(true);
    expect(s.ask.threadShare?.people).toEqual([{ handle: "meilin", access: "read" }]);
    expect(render(s)).toMatch(/data-dd="ask-share-p-meilin"[\s\S]*?Can read/);
    expect(shareDropdowns(s).find((d) => d.id === "ask-share-add")!.options).toEqual([]);
    threadsPart.act!(ctx, "askThShareCancel", String(t.id), null);
    expect(s.ask.threadShare).toBeNull();
    expect(patched).toEqual([]);
  });

  it("Save writes who can open it in ONE patch — the org and the whole people list — then the row; Remove takes a person off", async () => {
    const s = base();
    const t = s.ask.threads.data[0];
    const { ctx, patched, flashes } = shareCtx(s);
    threadsPart.act!(ctx, "askThShare", String(t.id), null);
    threadsPart.act!(ctx, "askThShareAdd", String(t.id), "meilin");
    threadsPart.act!(ctx, "askThSharePerson", "meilin", "continue");
    expect(s.ask.threadShare?.people).toEqual([{ handle: "meilin", access: "continue" }]);
    threadsPart.act!(ctx, "askThShareOrg", `${t.id}|read`, null);
    threadsPart.act!(ctx, "askThShareGo", String(t.id), null);
    await new Promise((r) => setTimeout(r, 0));
    expect(patched).toEqual([[t.id, { shared: true, people: [{ handle: "meilin", access: "continue" }] }]]);
    expect(s.ask.threadShare).toBeNull();
    expect(s.ask.threads.data.find((x) => x.id === t.id)).toMatchObject({ shared: true, people: [{ handle: "meilin", access: "continue" }] });
    expect(flashes.at(-1)).toBe("Shared with SaplingLearn and 1 person");
    // Reopened, it shows what is shared; Remove takes the person off, and Save sends the shorter list.
    threadsPart.act!(ctx, "askThShare", String(t.id), null);
    expect(s.ask.threadShare).toMatchObject({ org: true, people: [{ handle: "meilin", access: "continue" }] });
    threadsPart.act!(ctx, "askThSharePerson", "meilin", "remove");
    threadsPart.act!(ctx, "askThShareOrg", `${t.id}|off`, null);
    threadsPart.act!(ctx, "askThShareGo", String(t.id), null);
    await new Promise((r) => setTimeout(r, 0));
    expect(patched.at(-1)).toEqual([t.id, { shared: false, people: [] }]);
    expect(flashes.at(-1)).toBe("Only you can read it now.");
    expect(s.ask.threads.data.find((x) => x.id === t.id)?.people).toBeUndefined();
  });

  it("a refused Save keeps the dialog open with why; Stop sharing clears the org and everyone by name at once", async () => {
    const s = base();
    const t = s.ask.threads.data[0];
    const { ctx, patched, flashes } = shareCtx(s);
    s.ask.threads.data = s.ask.threads.data.map((x) => (x.id === t.id ? { ...x, shared: true, people: [{ handle: "meilin", access: "read" as const }] } : x));
    const bad = { ...ctx, api: { patchThread: async () => { throw new Error("nope"); } } } as unknown as AskCtx;
    threadsPart.act!(bad, "askThShare", String(t.id), null);
    threadsPart.act!(bad, "askThShareGo", String(t.id), null);
    expect(s.ask.threadShare?.busy).toBe(true);
    expect(render(s)).toContain("Saving…");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.ask.threadShare).toMatchObject({ busy: false, error: "Couldn't save who can see it. Try again." });
    expect(render(s)).toMatch(/<div role="alert" class="ask-share-err">Couldn&#39;t save who can see it\. Try again\.<\/div>/);
    threadsPart.act!(ctx, "askThShareCancel", String(t.id), null);
    threadsPart.act!(ctx, "askThUnshare", String(t.id), null);
    await new Promise((r) => setTimeout(r, 0));
    expect(patched.at(-1)).toEqual([t.id, { shared: false, people: [] }]);
    expect(s.ask.threads.data.find((x) => x.id === t.id)).toMatchObject({ shared: false });
    expect(s.ask.threads.data.find((x) => x.id === t.id)?.people).toBeUndefined();
    expect(flashes.at(-1)).toBe("Stopped sharing. Only you can read it now.");
  });

  it("Escape closes a dropdown open in the dialog first, then the dialog", () => {
    const s = base();
    const t = s.ask.threads.data[0];
    const { ctx } = shareCtx(s);
    threadsPart.act!(ctx, "askThShare", String(t.id), null);
    const layer = threadsPart.escape!.find((e) => e.isOpen(ctx))!;
    s.dd = { open: "ask-share-add", opening: false, closing: false };
    layer.close(ctx);
    expect(s.dd.open).toBeNull();
    expect(s.ask.threadShare).not.toBeNull();
    layer.close(ctx);
    expect(s.ask.threadShare).toBeNull();
  });

  it("Delete on a shared conversation says it goes for everyone it is shared with; a private one does not", () => {
    const shared = threadDeleteModal({ threadDelete: { id: 7, title: "Deploys", shared: true }, closing: {} }, "SaplingLearn");
    expect(shared).toContain("It is shared with SaplingLearn, so it goes for everyone there too.");
    const people = threadDeleteModal({ threadDelete: { id: 7, title: "Deploys", shared: false, who: "Mei Lin" }, closing: {} }, "SaplingLearn");
    expect(people).toContain("It is shared with Mei Lin, so it goes for them too.");
    const own = threadDeleteModal({ threadDelete: { id: 7, title: "Deploys", shared: false }, closing: {} }, "SaplingLearn");
    expect(own).toContain("The conversation and the files attached to it are deleted for good. A file");
    expect(own).not.toContain("shared with");
    expect(threadShareModal(base())).toBe("");
  });
});
