/**
 * Ask Trov's composer (web/src/ask-composer.ts; inventory §5): every `composer:*` scenario rendered from the
 * fixtures (shared/ai-fixtures.ts › Ask Trov), and the composer's acts driven through a stub `AskCtx` — the
 * input, Enter / Shift+Enter, attaching (upload on attach, the size / kind / count limits from `ask/state`), the
 * @ picker and the / commands with their keyboard paths, the mode menu and the Auto switch (per thread), Stop,
 * the blocks, drafts per thread, the ⌘J panel and the phone. Every limit and flag comes from `ask/state`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
import { render, initialState, type AppState } from "../web/src/render";
import { askView, type AskCtx, type AskSendInput, type AskWhere } from "../web/src/ask-state";
import { emptyConvo, newTurn } from "../web/src/ask-stream";
import type { AskApi, AskRefHit } from "../web/src/ask-api";
import { quickHitsToRefs } from "../web/src/ask-api";
import { replayPlan } from "../web/src/ask-replay";
import { phonePart } from "../web/src/ask-phone";
import {
  composerView, composerPart, composerReplaySetup, composerMode, composerAuto, composerBlock, canSend, parseCommand, usageLine, modeHint,
  kindsPhrase, atRows, addFiles, typeText, pick, sendFrom, initialComposerUi, COMPOSER_STATES,
} from "../web/src/ask-composer";
import { askRefFixtures, askStateFixture, askThreadsFixture } from "@shared/ai-fixtures";
import type { AskState, AskThreadSummary } from "@shared/ai-ask-core";

const NOW = new Date("2026-10-15T12:00:00Z");
const ME = { handle: "andres", name: "Andres Lopez", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "owner" as const }], superadmin: false, pending_invites: 0 };

function askState(plan: "pro" | "free" = "pro", over: (s: AppState) => void = () => undefined): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "ask"; s.orgSlug = "saplinglearn";
  (s as { me: unknown }).me = ME;
  s.ask.vw = 1440;
  s.ask.state = { status: "ok", data: askStateFixture(plan, NOW) };
  s.ask.threads = { status: "ok", data: askThreadsFixture(NOW) };
  s.ask.refViews = askRefFixtures(NOW);
  over(s);
  return s;
}
const withState = (s: AppState, f: (st: AskState) => AskState) => { s.ask.state = { status: "ok", data: f(s.ask.state.data!) }; };
const html = (s: AppState, where: AskWhere = "page") => composerView(askView(s, where));

interface TestCtx extends AskCtx { sent: AskSendInput[]; stopped: AskWhere[]; patches: [number, unknown][]; uploads: { names: string[]; threadId: number | null | undefined }[]; searches: string[] }
function makeCtx(s: AppState, api: Partial<AskApi> = {}): TestCtx {
  const sent: AskSendInput[] = [], stopped: AskWhere[] = [], patches: [number, unknown][] = [], uploads: TestCtx["uploads"] = [], searches: string[] = [];
  const base: Partial<AskApi> = {
    patchThread: async (id, p) => { patches.push([id, p]); return askThreadsFixture(NOW)[0]; },
    uploadAttachments: async (files, threadId) => {
      uploads.push({ names: files.map((f) => f.name), threadId });
      return { threadId: threadId ?? 77, attachments: files.map((f, i) => ({ id: 500 + i, slug: `a-${i}`, title: f.name, kind: "text" as const, contentType: f.type, size: f.size, sha256: "" })) };
    },
    searchRefs: async (q) => { searches.push(q); return [] as AskRefHit[]; },
  };
  const ctx = {
    get app() { return s; }, get ui() { return s.ask; }, api: { ...base, ...api } as AskApi, replay: false,
    look: () => ({ views: s.ask.refViews, persons: s.persons.data }),
    paint: () => undefined, flash: () => undefined, fail: () => undefined, want: () => undefined,
    send: (i: AskSendInput) => { sent.push(i); }, stop: (w?: AskWhere) => { stopped.push(w ?? "page"); },
    openRef: () => undefined, closeInspector: () => undefined, newThread: () => undefined, openThread: () => undefined, reloadThreads: () => undefined,
    exit: (_k: string, apply: () => void) => apply(), cancelExit: () => undefined,
    sent, stopped, patches, uploads, searches,
  };
  return ctx as TestCtx;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const file = (name: string, size: number, type: string) => new File([new Uint8Array(Math.min(size, 16))], name, { type });
/** A File whose size reads as `size` (no need to allocate it). */
const bigFile = (name: string, size: number, type: string) => { const f = file(name, 16, type); Object.defineProperty(f, "size", { value: size }); return f; };
const key = (k: string, el: { value: string; where?: AskWhere }, mods: Partial<KeyboardEvent> = {}) => {
  const ta = { value: el.value, dataset: { askInput: el.where ?? "page" } };
  const e = { key: k, shiftKey: false, isComposing: false, preventDefault: vi.fn(), ...mods, target: { closest: (sel: string) => (sel === "[data-ask-input]" ? ta : null) } };
  return { e: e as unknown as KeyboardEvent, prevented: () => (e.preventDefault as ReturnType<typeof vi.fn>).mock.calls.length > 0 };
};

describe("the box — a new thread on Pro", () => {
  it("the input, the toolbar (attach, mention, commands), the mode menu, the Auto switch and Send", () => {
    const h = html(askState());
    expect(h).toContain(`data-ask-input="page"`);
    expect(h).toContain(`placeholder="Ask about tickets, docs, PRs or sprints"`);
    expect(h).toContain(`aria-label="Message Ask Trov"`);
    expect(h).toMatch(/data-act="askCoAttach"[^>]*aria-label="Attach files" data-mtip="Attach files, or drop and paste them"/);
    expect(h).toMatch(/data-act="askCoAt"[^>]*data-mtip="Mention a ticket, doc, PR or person"/);
    expect(h).toContain(`data-act="askCoSlash"`);
    expect(h).toMatch(/aria-haspopup="menu" aria-expanded="false" aria-label="Mode: Smart">Smart/);
    expect(h).toContain(`aria-label="Changes in this thread"`);
    expect(h).toContain(">Ask before changes<");
    expect(h).toContain(">Auto<");
    expect(h).toContain("Enter to send · Shift+Enter for a new line");
    expect(h).toContain("Answers come from what you can see in Trov, with sources. Trov asks before it changes anything.");
    // Nothing to send yet: Send is dimmed (aria-disabled), not a Stop.
    expect(h).toMatch(/class="ask-send" data-morph-key="send" data-act="askCoSend"[^>]*aria-disabled="true"/);
    // A thread with messages asks for a follow-up; no disclaimer.
    const later = html(askState("pro", (s) => { s.ask.page = { ...emptyConvo(), messages: [{ role: "user", key: "q1", id: 1, text: "hi", context: [], attachments: [], command: null }] }; }));
    expect(later).toContain(`placeholder="Ask a follow-up"`);
    expect(later).not.toContain("Answers come from what you can see");
  });

  it("every conditional piece sits in a keyed list, so the box (its focus and caret) is never replaced", () => {
    const h = html(askState());
    expect(h).toMatch(/<div class="ask-composer" data-ask-composer="page" data-morph-list>/);
    expect(h).toMatch(/<div class="ask-co-in" data-morph-key="in" data-morph-list>/);
    expect(h).toMatch(/<div class="ask-box" data-morph-key="box" data-morph-list><div class="ask-co-chips" data-morph-key="chips" data-morph-list data-ask-enter="pop"><\/div><textarea[^>]*data-morph-key="ta"/);
  });

  it("Enter sends (mode and switch as shown, words trimmed); Shift+Enter and IME composition do not", () => {
    const s = askState();
    const ctx = makeCtx(s);
    typeText(ctx, "page", "  What's blocking the hosting work?  ");
    expect(composerPart.onKeyDown!(ctx, key("Enter", { value: s.ask.composer.page.text }, { shiftKey: true }).e)).toBe(false);
    expect(composerPart.onKeyDown!(ctx, key("Enter", { value: s.ask.composer.page.text }, { isComposing: true }).e)).toBe(false);
    expect(ctx.sent).toEqual([]);
    const k = key("Enter", { value: s.ask.composer.page.text });
    expect(composerPart.onKeyDown!(ctx, k.e)).toBe(true);
    expect(k.prevented()).toBe(true);
    expect(ctx.sent).toEqual([{ text: "What's blocking the hosting work?", where: "page", command: undefined, context: [], attachments: [], files: [], mode: "smart", auto: false }]);
    expect(s.ask.composer.page.text).toBe("");
  });
});

describe("composer:busy — Send is Stop", () => {
  it("while the answer streams, Send becomes Stop (aborts through ctx.stop) and the box says Trov is answering", () => {
    const s = askState("pro", (st) => { st.ask.page = { ...emptyConvo(), busy: true, messages: [{ role: "user", key: "q1", id: null, text: "x", context: [], attachments: [], command: null }, { role: "assistant", key: "a1", turn: newTurn("smart") }] }; });
    const h = html(s);
    expect(h).toMatch(/class="ask-send is-busy" data-morph-key="send" data-act="askCoStop" data-arg="page" aria-label="Stop answering"/);
    expect(h).toContain(`placeholder="Trov is answering…"`);
    const ctx = makeCtx(s);
    composerPart.act!(ctx, "askCoStop", "page", null);
    expect(ctx.stopped).toEqual(["page"]);
    // Enter while it answers sends nothing.
    s.ask.composer.page.text = "more";
    composerPart.onKeyDown!(ctx, key("Enter", { value: "more" }).e);
    expect(ctx.sent).toEqual([]);
    // The replay's forced state shows the same.
    expect(html(askState("pro", (st) => { st.ask.composer.page.forced = "busy"; }))).toContain(`data-act="askCoStop"`);
  });
});

describe("composer:quota and composer:off — the blocks", () => {
  it("used up on Free: the design's card with Upgrade to Pro (Pro's number from the plan table)", () => {
    const s = askState("free", (st) => withState(st, (x) => ({ ...x, allowance: { ...x.allowance, used: 50 } })));
    const h = html(s);
    expect(h).toContain("You've used this month's questions.");
    expect(h).toContain("Resets Nov 1. Pro includes 300 a month, plus Thinking mode.");
    expect(h).toMatch(/data-act="orgGo" data-arg="general">Upgrade to Pro</);
    expect(h).not.toContain(`data-ask-input`);
    expect(composerBlock(askView(s))).toBe("quota");
  });
  it("used up on Pro: when it resets, no upsell; a `capped` error from the stream blocks too", () => {
    const pro = askState("pro", (st) => withState(st, (x) => ({ ...x, allowance: { ...x.allowance, used: 1500 } })));
    expect(html(pro)).toContain("Resets Nov 1.");
    expect(html(pro)).not.toContain("Upgrade to Pro");
    const capped = askState("pro", (st) => { st.ask.page = { ...emptyConvo(), messages: [{ role: "assistant", key: "a", turn: { ...newTurn("smart"), error: { code: "capped", message: "" } } }] }; });
    expect(composerBlock(askView(capped))).toBe("quota");
  });
  it("off for the org: the off card (from `enabled`, or an `off` error)", () => {
    const h = html(askState("pro", (st) => withState(st, (x) => ({ ...x, enabled: false }))));
    expect(h).toContain("Ask Trov is off for this org.");
    expect(h).toContain("An admin can turn it on in Org settings › AI.");
    expect(h).not.toContain(`data-ask-input`);
    const err = askState("pro", (st) => { st.ask.page = { ...emptyConvo(), messages: [{ role: "assistant", key: "a", turn: { ...newTurn("smart"), error: { code: "off", message: "" } } }] }; });
    expect(composerBlock(askView(err))).toBe("off");
  });
  it("a blocked composer sends nothing", () => {
    const s = askState("pro", (st) => withState(st, (x) => ({ ...x, enabled: false })));
    s.ask.composer.page.text = "hello";
    const ctx = makeCtx(s);
    sendFrom(ctx, "page");
    expect(ctx.sent).toEqual([]);
  });
});

describe("composer:free and composer:low — the usage line, the switcher", () => {
  it("Free: no mode switcher (one mode), every question in Smart, and what is left once under a fifth", () => {
    const s = askState("free");
    const h = html(s);
    expect(h).not.toContain(`data-act="askCoModeMenu"`);
    expect(h).toContain("9 of 50 questions left this month · Resets Nov 1");
    expect(composerMode(askView(s))).toBe("smart");
  });
  it("Pro: the line only while `allowance.low`; its numbers are the state's", () => {
    expect(html(askState("pro"))).not.toContain("questions left this month");
    const low = askState("pro", (st) => withState(st, (x) => ({ ...x, allowance: { ...x.allowance, used: 1459, low: true } })));
    expect(html(low)).toContain("41 of 1500 questions left this month · Resets Nov 1");
    expect(usageLine({ ...askStateFixture("pro", NOW), allowance: { used: 1, cap: null, resetsAt: "", low: true } })).toBeNull();
  });
});

describe("the mode menu (Pro) — from ask/state, per thread", () => {
  it("lists the state's modes with their hints; Thinking's says it counts as 5 questions", () => {
    const s = askState("pro", (st) => { st.ask.composer.page.modeMenu = true; });
    const h = html(s);
    expect(h).toMatch(/class="ask-co-menu" role="menu" aria-label="Mode" data-morph-key="mm" data-co-menu>/);
    expect(h.match(/role="menuitemradio"/g)?.length).toBe(3);
    expect(h).toMatch(/aria-checked="true"[^>]*data-arg="page\|smart"/);
    expect(h).toContain("Works through harder questions first. Slower. Counts as 5 questions.");
    expect(modeHint({ id: "thinking", label: "Thinking", hint: "Works hard.", countsAs: 5 })).toBe("Works hard. Counts as 5 questions.");
  });
  it("picking a mode keeps it for this thread (PATCH mode) and sends in it; another thread uses its own", () => {
    const s = askState();
    s.ask.page = { ...emptyConvo(), threadId: 4, thread: { ...askThreadsFixture(NOW)[3], mode: "fast" } };
    const ctx = makeCtx(s);
    expect(composerMode(askView(s))).toBe("fast");
    composerPart.act!(ctx, "askCoModeMenu", "page", null);
    expect(s.ask.composer.page.modeMenu).toBe(true);
    composerPart.act!(ctx, "askCoMode", "page|thinking", null);
    expect(s.ask.composer.page.modeMenu).toBe(false);
    expect(ctx.patches).toContainEqual([4, { mode: "thinking" }]);
    typeText(ctx, "page", "why?");
    sendFrom(ctx, "page");
    expect(ctx.sent[0].mode).toBe("thinking");
  });
  it("a mode the plan does not offer is never sent (Free asks in Smart whatever the thread says)", () => {
    const s = askState("free");
    s.ask.page = { ...emptyConvo(), threadId: 4, thread: { ...askThreadsFixture(NOW)[3], mode: "thinking" } };
    s.ask.composer.page.mode = "fast";
    expect(composerMode(askView(s))).toBe("smart");
    const ctx = makeCtx(s);
    composerPart.act!(ctx, "askCoMode", "page|thinking", null);
    expect(s.ask.composer.page.mode).toBe("fast"); // not offered: ignored
  });
});

describe("composer:autoOff — the Ask before changes / Auto switch", () => {
  it("Auto on: sent as the thread's switch, kept per thread", () => {
    const s = askState();
    s.ask.page = { ...emptyConvo(), threadId: 3, thread: askThreadsFixture(NOW)[2] };
    const ctx = makeCtx(s);
    composerPart.act!(ctx, "askCoAuto", "page|on", null);
    expect(composerAuto(askView(s))).toBe(true);
    expect(ctx.patches).toContainEqual([3, { auto: true }]);
    expect(html(s)).toMatch(/class="cnpy-seg-btn is-on"[^>]*aria-pressed="true"[^>]*>Auto</);
  });
  it("an admin turned Auto off: the switch is disabled with its tip, and Auto is never sent", () => {
    const s = askState("pro", (st) => withState(st, (x) => ({ ...x, autoAllowed: false })));
    const h = html(s);
    expect(h).toMatch(/class="ask-co-auto is-off" data-morph-key="auto" aria-disabled="true" data-mtip="An admin turned off Auto for this org. Trov asks before every change.">/);
    expect(h.match(/class="cnpy-seg-btn[^"]*" disabled/g)?.length).toBe(2);
    s.ask.composer.page.auto = true;
    s.ask.page = { ...emptyConvo(), threadId: 3, thread: { ...askThreadsFixture(NOW)[2], auto: true } };
    const ctx = makeCtx(s);
    composerPart.act!(ctx, "askCoAuto", "page|on", null);
    expect(ctx.patches).toEqual([]);
    typeText(ctx, "page", "file a ticket");
    sendFrom(ctx, "page");
    expect(ctx.sent[0].auto).toBe(false);
  });
  it("Auto says it never covers Publish", () => {
    expect(html(askState())).toContain(`title="Trov makes changes without asking first. Publishing a doc always waits for you."`);
  });
});

describe("attaching — upload on attach, limits from ask/state", () => {
  it("uploads at once (a new thread: the upload makes it, and the question goes there), then sends the ids", async () => {
    const s = askState();
    const ctx = makeCtx(s);
    addFiles(ctx, "page", [bigFile("deploys-october.csv", 18432, "text/csv"), bigFile("netlify-api.pdf", 1258291, "application/pdf")]);
    expect(ctx.uploads).toEqual([{ names: ["deploys-october.csv", "netlify-api.pdf"], threadId: null }]);
    expect(s.ask.composer.page.files.map((f) => f.state)).toEqual(["uploading", "uploading"]);
    expect(html(s)).toContain(">Uploading<");
    expect(canSend(askView(s))).toBe(false);
    await flush();
    expect(s.ask.composer.page.files.map((f) => f.state)).toEqual(["ready", "ready"]);
    expect(s.ask.page.threadId).toBe(77);
    const h = html(s);
    expect(h).toContain("2 files");
    expect(h).toMatch(/class="ask-co-chip" data-morph-key="f:u\d+"><span class="ask-co-ico"[^>]*>.*?<\/span><span class="ask-co-chip-t"><span class="ask-co-chip-n">deploys-october.csv<\/span><span class="ask-co-chip-m">18 KB<\/span>/);
    expect(h).toContain(`aria-label="Remove netlify-api.pdf"`);
    // Words-free: the files alone are a question.
    sendFrom(ctx, "page");
    expect(ctx.sent[0]).toMatchObject({ text: "", attachments: [500, 501] });
    expect(ctx.sent[0].files?.map((f) => f.title)).toEqual(["deploys-october.csv", "netlify-api.pdf"]);
    expect(s.ask.composer.page.files).toEqual([]);
  });

  it("composer:tooLarge — over `attach.maxBytes`: a red chip and the note, never uploaded (the cap is the state's)", () => {
    const s = askState();
    const ctx = makeCtx(s);
    addFiles(ctx, "page", [bigFile("standup-recording.mov", 84934656, "video/quicktime")]);
    expect(ctx.uploads).toEqual([]);
    const h = html(s);
    expect(h).toMatch(/class="ask-co-chip is-bad"[^>]*>.*?standup-recording.mov<\/span><span class="ask-co-chip-m">Too large</);
    expect(h).toContain("<b>standup-recording.mov</b> is too large. Files can be up to 10 MB.");
    // Another cap from the server: the note follows it.
    const s5 = askState("pro", (st) => withState(st, (x) => ({ ...x, attach: { ...x.attach, maxBytes: 5 * 1048576 } })));
    const c5 = makeCtx(s5);
    addFiles(c5, "page", [bigFile("shot.png", 6 * 1048576, "image/png")]);
    expect(c5.uploads).toEqual([]);
    expect(html(s5)).toContain("Files can be up to 5 MB.");
    // Removing the chip clears the note.
    composerPart.act!(ctx, "askCoRemove", `page|f:${s.ask.composer.page.files[0].key}`, null);
    expect(html(s)).not.toContain("is too large");
  });

  it("the kinds and the count are the state's", () => {
    const s = askState("pro", (st) => withState(st, (x) => ({ ...x, attach: { ...x.attach, maxFiles: 2, kinds: ["image"] } })));
    const ctx = makeCtx(s);
    addFiles(ctx, "page", [file("notes.md", 10, "text/markdown")]);
    expect(ctx.uploads).toEqual([]);
    expect(html(s)).toContain("<b>notes.md</b> can't be attached. Images only.");
    addFiles(ctx, "page", [file("a.png", 10, "image/png"), file("b.png", 10, "image/png"), file("c.png", 10, "image/png")]);
    expect(ctx.uploads[0].names).toEqual(["a.png", "b.png"]);
    expect(html(s)).toContain("<b>c.png</b> was not attached. A message can carry up to 2 files.");
    expect(kindsPhrase(["image", "pdf", "text"])).toBe("Images, PDFs and text files");
  });

  it("composer:error — a failed upload: the note, and Try again re-sends the same files", async () => {
    const s = askState();
    let fail = true;
    const ctx = makeCtx(s, {
      uploadAttachments: async (files, threadId) => {
        if (fail) throw new Error("network");
        return { threadId: threadId ?? 9, attachments: files.map((f, i) => ({ id: 600 + i, slug: "x", title: f.name, kind: "image" as const, contentType: f.type, size: f.size, sha256: "" })) };
      },
    });
    addFiles(ctx, "page", [file("ci-failure.png", 421888, "image/png")]);
    await flush();
    let h = html(s);
    expect(h).toMatch(/class="ask-co-note" data-morph-key="err" role="alert">.*Something went wrong\. <button type="button" class="ask-co-link" data-act="askCoRetry" data-arg="page">Try again<\/button>/);
    expect(h).toContain(">Not attached<");
    fail = false;
    composerPart.act!(ctx, "askCoRetry", "page", null);
    await flush();
    h = html(s);
    expect(h).not.toContain("Something went wrong");
    expect(s.ask.composer.page.attachments.map((a) => a.id)).toEqual([600]);
  });

  it("paste attaches the clipboard's files; composer:drag shows the overlay, a drop attaches", () => {
    const s = askState();
    const ctx = makeCtx(s);
    const ta = { dataset: { askInput: "page" } };
    const prevent = vi.fn();
    const handled = composerPart.onPaste!(ctx, { target: { closest: () => ta }, clipboardData: { files: [file("pasted.png", 10, "image/png")] }, preventDefault: prevent } as unknown as ClipboardEvent);
    expect(handled).toBe(true);
    expect(prevent).toHaveBeenCalled();
    expect(ctx.uploads[0].names).toEqual(["pasted.png"]);

    const zone = { getAttribute: (n: string) => (n === "data-ask-drop" ? "page" : null), contains: () => false };
    const dt = { types: ["Files"], files: [file("drop.txt", 10, "text/plain")], dropEffect: "" };
    const ev = (extra: object = {}) => ({ target: { closest: () => zone }, dataTransfer: dt, preventDefault: vi.fn(), relatedTarget: null, ...extra }) as unknown as DragEvent;
    expect(composerPart.onDragOver!(ctx, ev())).toBe(true);
    const h = html(s);
    expect(h).toMatch(/<div class="ask-co-drop" data-morph-key="drop" aria-hidden="true"><div class="ask-co-drop-in">.*Drop files to attach.*Images, PDFs and text files, up to 10 MB each/);
    expect(composerPart.onDrop!(ctx, ev())).toBe(true);
    expect(s.ask.composer.page.drag).toBe(false);
    expect(ctx.uploads[1].names).toEqual(["drop.txt"]);
    // A drag that leaves the conversation takes the overlay away (with its fade: ctx.exit).
    composerPart.onDragOver!(ctx, ev());
    expect(composerPart.onDragLeave!(ctx, ev())).toBe(true);
    expect(s.ask.composer.page.drag).toBe(false);
  });
});

describe("composer:files — chips and the context line", () => {
  it("file chips (a thumb box, the size) and the context chip; 'About ticket #14 · 3 files' with its clear", () => {
    const s = askState();
    const ctx = makeCtx(s);
    composerReplaySetup(ctx, "page", "files");
    const h = html(s);
    expect(h).toContain(`<div class="ask-co-ctx" data-morph-key="ctx">`);
    expect(h).toContain("About ticket #14 · 3 files");
    expect(h).toContain(`data-act="askCoClear" data-arg="page" aria-label="Remove all context"`);
    for (const n of ["ci-failure.png", "deploys-october.csv", "netlify-api.pdf"]) expect(h).toContain(`aria-label="Remove ${n}"`);
    expect(h).toMatch(/data-morph-key="c:ticket:14">.*?<span class="ask-co-chip-n">#14<\/span><span class="ask-co-chip-m">Ticket<\/span>/);
    expect(h).toContain(">412 KB<");
    sendFrom(ctx, "page");
    expect(ctx.sent[0]).toMatchObject({ text: "Why does this fail only on main?", context: ["ticket:14"], attachments: [901, 902, 903] });
  });
  it("two refs: 'About ticket #14 and 1 more'; clear removes every chip", () => {
    const s = askState("pro", (st) => { st.ask.composer.page.context = ["ticket:14", "pr:176"]; });
    expect(html(s)).toContain("About ticket #14 and 1 more");
    const ctx = makeCtx(s);
    composerPart.act!(ctx, "askCoClear", "page", null);
    expect(s.ask.composer.page.context).toEqual([]);
    expect(html(s)).not.toContain(`class="ask-co-ctx"`);
  });
  it("a chip leaving pops out on data-closing (ctx.exit), as does every chip under Remove all", () => {
    const s = askState("pro", (st) => { st.ask.composer.page.context = ["ticket:14"]; st.ask.closing = { "co:page:c:ticket:14": true }; });
    expect(html(s)).toMatch(/data-morph-key="c:ticket:14" data-closing="1">/);
    const all = askState("pro", (st) => { st.ask.composer.page.context = ["ticket:14"]; st.ask.closing = { "co:page:*": true }; });
    expect(html(all)).toMatch(/data-morph-key="c:ticket:14" data-closing="1">/);
  });
});

describe("composer:at — the @ picker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("opens on @, searches the quick search from two characters, groups by type, and ↑↓ / Enter pick", async () => {
    const s = askState();
    const hits: AskRefHit[] = [
      { ref: "person:maya", type: "person", title: "Maya Chen", status: null },
      { ref: "pr:176", type: "pr", title: "Netlify connect step for guided setup", status: "In review" },
      { ref: "ticket:14", type: "ticket", title: "Guided repository setup", status: "In progress" },
    ];
    const ctx = makeCtx(s, { searchRefs: async (q) => { ctx.searches.push(q); return hits; } });
    typeText(ctx, "page", "What changed in @n");
    expect(s.ask.composer.page.picker).toMatchObject({ kind: "@", q: "n", at: 16 });
    expect(ctx.searches).toEqual([]);                    // one character: the items Trov already shows
    typeText(ctx, "page", "What changed in @net");
    await vi.advanceTimersByTimeAsync(150);
    expect(ctx.searches).toEqual(["net"]);
    // Grouped in the design's order: Tickets, Pull requests, People.
    expect(atRows(s.ask.composer.page.picker!).map((h) => h.ref)).toEqual(["ticket:14", "pr:176", "person:maya"]);
    const h = html(s);
    expect(h).toMatch(/class="ask-co-pick" role="listbox" id="ask-co-pick-page" aria-label="Mention an item" data-morph-key="pick:@" data-co-menu>/);
    expect(h.indexOf(">Tickets<")).toBeLessThan(h.indexOf(">Pull requests<"));
    expect(h.indexOf(">Pull requests<")).toBeLessThan(h.indexOf(">People<"));
    expect(h).toContain("#14 Guided repository setup");
    expect(h).toContain("↑↓ to move</span><span>Enter to pick</span><span>Esc to close");
    expect(h).toContain(`aria-controls="ask-co-pick-page" aria-expanded="true"`);
    // ↓ moves (and wraps), Enter picks: the item becomes a context chip and "@net" leaves the words.
    composerPart.onKeyDown!(ctx, key("ArrowDown", { value: s.ask.composer.page.text }).e);
    expect(s.ask.composer.page.picker!.sel).toBe(1);
    composerPart.onKeyDown!(ctx, key("ArrowUp", { value: s.ask.composer.page.text }).e);
    composerPart.onKeyDown!(ctx, key("ArrowUp", { value: s.ask.composer.page.text }).e);
    expect(s.ask.composer.page.picker!.sel).toBe(2);
    const k = key("Enter", { value: s.ask.composer.page.text });
    composerPart.onKeyDown!(ctx, k.e);
    expect(ctx.sent).toEqual([]);                       // Enter picked, it did not send
    expect(s.ask.composer.page.context).toEqual(["person:maya"]);
    expect(s.ask.composer.page.text).toBe("What changed in ");
    expect(s.ask.composer.page.picker).toBeNull();
  });
  it("nothing found: the design's line; the mention button opens it; Escape closes it (the picker layer first)", () => {
    const s = askState();
    const ctx = makeCtx(s);
    s.ask.refViews = {};
    composerPart.act!(ctx, "askCoAt", "page", null);
    expect(s.ask.composer.page.text).toBe("@");
    s.ask.composer.page.picker = { ...s.ask.composer.page.picker!, q: "zzz", hits: [] };
    expect(html(s)).toContain("Nothing matches “zzz”.");
    const esc = composerPart.escape!.find((e) => e.layer === "picker")!;
    expect(esc.isOpen(ctx)).toBe(true);
    esc.close(ctx);
    expect(s.ask.composer.page.picker).toBeNull();
  });
  it("the quick search's hits become refs (a sprint's id, no roadmap entry)", () => {
    expect(quickHitsToRefs({ q: "x", groups: [
      { type: "ticket", hits: [{ type: "ticket", id: "14", title: "Guided", snippet: null, status: "In progress", by: null, at: null }] },
      { type: "sprint", hits: [{ type: "sprint", id: "sprint:7", title: "Hosting", snippet: null, status: null, by: null, at: null }, { type: "sprint", id: "plan", title: "Roadmap", snippet: null, status: null, by: null, at: null }] },
      { type: "person", hits: [{ type: "person", id: "maya", title: "Maya Chen", snippet: null, status: null, by: null, at: null }] },
    ] } as never).map((h) => h.ref)).toEqual(["ticket:14", "sprint:7", "person:maya"]);
  });
});

describe("composer:slash — the / commands", () => {
  it("lists the five commands with the design's hints; picking fills '/cmd ' and the send carries `command`", () => {
    const s = askState();
    const ctx = makeCtx(s);
    composerPart.act!(ctx, "askCoSlash", "page", null);
    const h = html(s);
    expect(h).toMatch(/aria-label="Commands" data-morph-key="pick:\/" data-co-menu>/);
    for (const [c, hint] of [["ticket", "Draft a new ticket"], ["handoff", "Draft a handoff for an agent session"], ["search", "Search Trov for a phrase"], ["summarize", "Summarize an item or this thread"], ["brief", "Write a status brief for the team"]]) {
      expect(h).toContain(`<span class="ask-co-cmd">/${c}</span><span class="ask-co-row-c">${hint}</span>`);
    }
    typeText(ctx, "page", "/s");
    expect(html(s).match(/class="ask-co-cmd"/g)?.length).toBe(2);
    pick(ctx, "page", 0);
    expect(s.ask.composer.page.text).toBe("/search ");
    typeText(ctx, "page", "/search netlify flake");
    sendFrom(ctx, "page");
    expect(ctx.sent[0]).toMatchObject({ command: "search", text: "netlify flake" });
    expect(parseCommand("/brief")).toEqual({ command: "brief", text: "" });
    expect(parseCommand("/nope hi")).toEqual({ command: undefined, text: "/nope hi" });
  });
});

describe("drafts — kept per thread", () => {
  it("typing keeps the words on the thread; switching away and back brings them back, with each thread's own mode; a stored draft loads", () => {
    vi.useFakeTimers();
    try {
      const th = askThreadsFixture(NOW);
      const s = askState();
      s.ask.page = { ...emptyConvo(), uid: "t3", threadId: 3, thread: th[2], status: "ok" };
      const ctx = makeCtx(s);
      const mount = { querySelector: () => null, addEventListener: () => undefined } as unknown as HTMLElement;
      const paint = () => composerPart.afterPaint!(ctx, mount);
      paint();                                                       // binds the composer to thread 3
      typeText(ctx, "page", "half a question");
      s.ask.composer.page.mode = "thinking";
      vi.advanceTimersByTime(800);
      expect(ctx.patches).toContainEqual([3, { draft: "half a question" }]);
      // Another thread, read from the server with a stored draft: its words, its own mode.
      composerReplaySetup(ctx, "page", "files");                     // files uploaded to thread 3…
      s.ask.composer.page.text = "half a question";
      s.ask.page = { ...emptyConvo(), uid: "t5", threadId: 5, thread: { ...th[4], draft: "from yesterday" } as AskThreadSummary, status: "ok" };
      paint();
      expect(s.ask.composer.page.text).toBe("from yesterday");
      expect(s.ask.composer.page.mode).toBeNull();
      expect(s.ask.composer.page.files).toEqual([]);                 // …do not follow to thread 5
      expect(s.ask.composer.page.attachments).toEqual([]);
      // Back to thread 3: what was being typed.
      s.ask.page = { ...emptyConvo(), uid: "t3b", threadId: 3, thread: th[2], status: "ok" };
      paint();
      expect(s.ask.composer.page.text).toBe("half a question");
      // A thread still being read: its stored draft lands once it is in.
      s.ask.page = { ...emptyConvo(), uid: "t6", threadId: 6, status: "loading" };
      paint();
      expect(s.ask.composer.page.text).toBe("");
      s.ask.page = { ...s.ask.page, status: "ok", thread: { ...th[5], draft: "stored" } as AskThreadSummary };
      paint();
      expect(s.ask.composer.page.text).toBe("stored");
      // A new thread being named (null → its id) keeps what is typed.
      s.ask.page = { ...emptyConvo(), uid: "c-new" };
      paint();
      typeText(ctx, "page", "typing while it answers");
      s.ask.page = { ...s.ask.page, threadId: 40 };
      paint();
      expect(s.ask.composer.page.text).toBe("typing while it answers");
      // Sending clears the thread's stored draft.
      s.ask.page = { ...emptyConvo(), uid: "t3c", threadId: 3, thread: th[2], status: "ok" };
      paint();
      ctx.patches.length = 0;
      sendFrom(ctx, "page");
      expect(ctx.patches).toContainEqual([3, { draft: "" }]);
    } finally { vi.useRealTimers(); }
  });
});

describe("the ⌘J panel's composer", () => {
  it("its placeholder names the page's item, the switch says 'Ask first', the context line names the item, and the context stays after a send", () => {
    const s = askState("pro", (st) => { st.screen = "ticketdetail"; st.ticketId = 14; st.ask.cmdj = { open: true, contextRef: "ticket:14" }; st.ask.composer.panel.context = ["ticket:14"]; });
    const h = html(s, "panel");
    expect(h).toContain(`placeholder="Ask about this ticket…"`);
    expect(h).toContain(">Ask first<");
    expect(h).toContain("About ticket #14: Guided repository setup");
    expect(h).not.toContain("Answers come from what you can see");
    const ctx = makeCtx(s);
    typeText(ctx, "panel", "What's left before this can close?");
    sendFrom(ctx, "panel");
    expect(ctx.sent[0]).toMatchObject({ where: "panel", context: ["ticket:14"] });
    expect(s.ask.composer.panel.context).toEqual(["ticket:14"]);
    // It renders inside the ⌘J overlay over the Tickets page.
    expect(render(s)).toMatch(/data-overlay="ask-panel"[\s\S]*data-ask-composer="panel"/);
  });
});

describe("the phone — ONE + menu (the phone part's) driving the composer's own controls", () => {
  it("the phone's bar sits in the box (+, 'Smart · Asks first', Send); its menu holds Attach, Mention, Run a command, Mode, Changes", () => {
    const s = askState("pro", (st) => { st.phone = true; });
    const h = html(s);
    expect(h).toMatch(/<div class="ask-ph-host" data-morph-key="bar"><div class="ask-ph-bar">/);
    expect(h).toMatch(/class="ask-ph-plusbtn" data-act="askPhPlus" data-arg="page" aria-label="More options" aria-expanded="false"/);
    expect(h).toContain(">Smart · Asks first<");
    expect(h).not.toContain("Enter to send");
    expect(h).not.toContain(`data-act="askCoAttach" data-arg="page" aria-label="Attach files"`);
    expect(h).not.toContain("ask-co-plus");
    // The phone's Attach clicks THIS input; its Mode / Changes write ComposerUi.mode / .auto through the setters.
    expect(h).toMatch(/data-ask-composer="page"[\s\S]*<input type="file"/);
    s.ask.phone.plus = true;
    const open = html(s);
    for (const t of ["Attach a file or photo", "Mention a ticket, doc or person", "Run a command", ">Mode<", ">Changes in this thread<", ">Ask before changes<"]) expect(open).toContain(t);
    expect(open.match(/class="ask-ph-plus"/g)).toHaveLength(1);
    expect(html(askState("free", (st) => { st.phone = true; }))).toContain(">Asks first<");
    // A composer row closes the menu.
    const ctx = makeCtx(s);
    composerPart.act!(ctx, "askCoSlash", "page", null);
    expect(s.ask.phone.plus).toBe(false);
  });

  it("the phone menu's Mode and Changes go through the composer's setters (its state, and the thread's PATCH)", () => {
    const s = askState("pro", (st) => { st.phone = true; st.ask.page = { ...st.ask.page, threadId: 7 }; });
    const ctx = makeCtx(s);
    phonePart.act!(ctx, "askPhMode", "page:thinking", null);
    phonePart.act!(ctx, "askPhAuto", "page:auto", null);
    expect(s.ask.composer.page.mode).toBe("thinking");
    expect(s.ask.composer.page.auto).toBe(true);
    expect(ctx.patches).toEqual([[7, { mode: "thinking" }], [7, { auto: true }]]);
  });
});

describe("the dev replay — every composer:<state> has its setup", () => {
  it("each state sets its forced flag; quota is a Free org at its cap; at / slash / tooLarge / drag / error fill the box", () => {
    for (const st of COMPOSER_STATES) {
      const s = askState(replayPlan(`composer:${st}`).plan);
      const ctx = makeCtx(s);
      replayPlan(`composer:${st}`).setup!(ctx);
      expect(s.ask.composer.page.forced).toBe(st);
    }
    expect(replayPlan("composer:quota").plan).toBe("free");
    const s = askState();
    const ctx = makeCtx(s);
    composerReplaySetup(ctx, "page", "tooLarge");
    expect(html(s)).toContain("<b>standup-recording.mov</b> is too large. Files can be up to 10 MB.");
    const d = askState(); composerReplaySetup(makeCtx(d), "page", "drag");
    expect(html(d)).toContain("Drop files to attach");
    const e = askState(); composerReplaySetup(makeCtx(e), "page", "error");
    expect(html(e)).toContain("Something went wrong.");
    const sl = askState(); composerReplaySetup(makeCtx(sl), "page", "slash");
    expect(html(sl)).toContain(`data-morph-key="pick:/"`);
    expect(initialComposerUi().forced).toBeNull();
  });
});
