/**
 * Ask Trov — the ⌘J panel (web/src/ask-cmdj.ts; inventory §8, scenario `cmdj`, ask-trov.dc.html L284–297, L1811–1830).
 * The panel over another page from the `cmdj` transcript, the Tickets page's one change, the shortcut (⌘J / Ctrl+J,
 * never DevTools' chords, never over another modal), Escape's order with the panel's own inspector, Open as thread,
 * the thread contract (`origin: "panel"`, the page's item as the first context ref → `context_ref`) through the real
 * client, and the motion (the slide in / out through `ctx.exit` + `data-closing`, all off under reduced motion).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
// The real Ask client over a stubbed transport: `POST /ask` streams the recorded `cmdj` transcript.
const calls: { path: string; body: unknown }[] = [];
vi.mock("../web/src/api", async (orig) => {
  const real = await orig<typeof import("../web/src/api")>();
  const { askTranscript, askTranscriptSse, askStateFixture, askThreadsFixture } = await import("@shared/ai-fixtures");
  const now = new Date("2026-10-15T12:00:00Z");
  return {
    ...real,
    apiFetch: async (path: string, init: RequestInit = {}) => {
      calls.push({ path, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      if (path === "/ask") return new Response(askTranscriptSse(askTranscript("cmdj", now)), { headers: { "content-type": "text/event-stream" } });
      if (path === "/ask/state") return Response.json(askStateFixture("pro", now));
      if (path === "/ask/threads") return Response.json({ threads: askThreadsFixture(now) });
      if (path === "/ask/peek") return Response.json({ items: [] });
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  };
});

import { render, initialState, type AppState } from "../web/src/render";
import { cmdjOverlay, cmdjHeaderButton, cmdjPart, cmdjToggle, closePanel, openAsThread, openPanel, pageRef, panelShown, isCmdjKey, otherModalOpen, cmdjKeyLabel } from "../web/src/ask-cmdj";
import { createAskController } from "../web/src/ask-controller";
import { replayPlan } from "../web/src/ask-replay";
import { topLayer, type EscEntry } from "../web/src/ask-escape";
import { emptyConvo, foldAskEvent, foldThreadEvent, newTurn, withLastTurn, type AskConvo } from "../web/src/ask-stream";
import { initialComposerUi } from "../web/src/ask-composer";
import { inspectorRef, type AskCtx } from "../web/src/ask-state";
import { askRefFixtures, askStateFixture, askThreadsFixture, askTranscript, ASK_SCENARIO_QUESTION } from "@shared/ai-fixtures";
import type { AskEvent } from "@shared/ai-ask-core";
import css from "../web/src/trov.css?raw";

const NOW = new Date("2026-10-15T12:00:00Z");
const ME = { handle: "andres", name: "Andres Lopez", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "owner" as const }], superadmin: false, pending_invites: 0 };

/** A signed-in app on ticket #14 (the scenario's page), with Ask's reads in. */
function ticketState(over: (s: AppState) => void = () => undefined): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "ticketdetail"; s.ticketId = 14; s.orgSlug = "saplinglearn";
  (s as { me: unknown }).me = ME;
  s.ask.vw = 1440;
  s.ask.state = { status: "ok", data: askStateFixture("pro", NOW) };
  s.ask.threads = { status: "ok", data: askThreadsFixture(NOW) };
  s.ask.refViews = askRefFixtures(NOW);
  over(s);
  return s;
}

/** The `cmdj` transcript folded into the panel's conversation, as the controller folds a live stream. */
function cmdjConvo(): AskConvo {
  const q = ASK_SCENARIO_QUESTION.cmdj!;
  let c: AskConvo = {
    ...emptyConvo(), status: "ok",
    messages: [
      { role: "user", key: "q1", id: null, text: q.text, context: q.context, attachments: [], command: null },
      { role: "assistant", key: "a1", turn: newTurn("smart") },
    ],
  };
  for (const { event: e } of askTranscript("cmdj", NOW)) {
    c = e.event === "thread" ? foldThreadEvent(c, e.data) : withLastTurn(c, (t) => foldAskEvent(t, e as AskEvent, 0));
  }
  return c;
}

/** A context a part can be driven through, recording what it asked the controller for. */
function fakeCtx(app: AppState) {
  const log: string[] = [];
  const ctx: AskCtx = {
    get app() { return app; },
    get ui() { return app.ask; },
    api: {} as AskCtx["api"],
    replay: false,
    look: () => ({ views: app.ask.refViews, persons: [] }),
    paint: () => { log.push("paint"); },
    flash: () => undefined, fail: () => undefined,
    want: (refs) => { log.push(`want:${refs.join(",")}`); },
    send: () => undefined, stop: () => undefined,
    openRef: (ref, where = "panel") => { app.ask.inspector = { ...app.ask.inspector, where, stack: [...app.ask.inspector.stack, ref], idx: app.ask.inspector.idx + 1 }; },
    closeInspector: () => { app.ask.inspector = { ...app.ask.inspector, stack: [], idx: -1 }; },
    newThread: (where = "page") => { log.push(`new:${where}`); app.ask[where] = emptyConvo(); app.ask.composer[where] = initialComposerUi(); if (where === "page") app.screen = "ask"; },
    openThread: (id) => { log.push(`open:${id}`); app.screen = "ask"; if (app.ask.panel.threadId === id) { app.ask.page = app.ask.panel; app.ask.panel = emptyConvo(); } },
    reloadThreads: () => undefined,
    // No window here: an exit applies at once (as under reduced motion), but say that it ran through exit().
    exit: (key, apply) => { log.push(`exit:${key}`); apply(); },
    cancelExit: (key) => { log.push(`keep:${key}`); },
  };
  return { ctx, log };
}

describe("the panel over another page (scenario `cmdj`)", () => {
  const app = ticketState((s) => { s.ask.cmdj = { open: true, contextRef: "ticket:14" }; s.ask.panel = cmdjConvo(); s.ask.composer.panel.context = ["ticket:14"]; });
  const html = render(app);
  const panel = cmdjOverlay(app);

  it("is a root overlay with a scrim, a 420px dialog and its header — the page behind is the ticket's", () => {
    expect(html).toContain(`data-screen="ticketdetail"`);
    expect(html).toContain(panel.trim().slice(0, 60));
    expect(panel).toMatch(/^<div data-overlay="ask-panel" class="ask-panel-layer">/);
    expect(panel).toContain(`<div class="ask-scrim" data-act="askCjClose" aria-hidden="true"></div>`);
    expect(panel).toMatch(/<section class="ask-panel" role="dialog" aria-modal="true" aria-labelledby="ask-panel-t" data-ask-drop="panel">/);
    expect(panel).toMatch(/<span class="ask-panel-t" id="ask-panel-t">Ask Trov<\/span><kbd class="ask-kbd">Ctrl J<\/kbd>/);
    expect(panel).toMatch(/data-act="askCjOpenThread">Open as thread<svg/);
    expect(panel).toMatch(/data-act="askCjClose" aria-label="Close"/);
    expect(css).toMatch(/\.ask-panel \{[^}]*width:420px;/);
    expect(css).toMatch(/\[data-phone="1"\] \.ask-panel \{ width:100%;/);
  });

  it("holds its own conversation (the transcript's answer) and the composer in panel form, with the page's item as context", () => {
    expect(panel).toContain(`data-ask-scroll="panel"`);
    expect(panel).toContain("s left before this can close?");
    expect(panel).toContain("Two of three sub-tickets are open.");
    expect(panel).toContain(`data-ask-input="panel"`);
    expect(panel).not.toContain(`data-ask-input="page"`);
    expect(app.ask.composer.panel.context).toEqual(["ticket:14"]);
    expect(pageRef(app)).toBe("ticket:14");
  });

  it("the inspector it opens sits to its LEFT, emitted before the panel (it slides out from behind it)", () => {
    const withInsp = ticketState((s) => { s.ask.cmdj = { open: true, contextRef: "ticket:14" }; s.ask.inspector = { ...s.ask.inspector, where: "panel", stack: ["pr:176"], idx: 0 }; });
    const out = cmdjOverlay(withInsp);
    expect(out.indexOf(`class="ask-insp-frame"`)).toBeGreaterThan(out.indexOf("ask-scrim"));
    expect(out.indexOf(`class="ask-insp-frame"`)).toBeLessThan(out.indexOf(`class="ask-panel"`));
    expect(out).toMatch(/<aside class="ask-insp-frame"[^>]*data-sheet="0" data-where="panel"/);
    expect(css).toMatch(/\.ask-panel-layer > \.ask-insp-frame\[data-sheet="0"\] \{[^}]*right:420px;[^}]*z-index:1;/);
    // The page's own inspector is not drawn in the panel.
    const pageInsp = ticketState((s) => { s.ask.cmdj = { open: true, contextRef: null }; s.ask.inspector = { ...s.ask.inspector, where: "page", stack: ["pr:176"], idx: 0 }; });
    expect(cmdjOverlay(pageInsp)).not.toContain("ask-insp-frame");
  });

  it("is never drawn on the Ask screen itself, closed, or signed out", () => {
    expect(cmdjOverlay(ticketState((s) => { s.ask.cmdj = { open: true, contextRef: null }; s.screen = "ask"; }))).toBe("");
    expect(cmdjOverlay(ticketState())).toBe("");
    expect(cmdjOverlay(ticketState((s) => { s.ask.cmdj = { open: true, contextRef: null }; s.view = "auth"; }))).toBe("");
  });
});

describe("the Tickets page's one change — Ask about this ⌘J", () => {
  it("is in a ticket's header only, says its shortcut and whether its dialog is up", () => {
    const btn = cmdjHeaderButton(ticketState());
    expect(btn).toMatch(/^<button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="askCjOpen" aria-haspopup="dialog" aria-expanded="false" aria-keyshortcuts="Control\+J">/);
    expect(btn).toMatch(/Ask about this<kbd class="ask-kbd">Ctrl J<\/kbd><\/button>$/);
    expect(cmdjHeaderButton(ticketState((s) => { s.ask.cmdj = { open: true, contextRef: "ticket:14" }; }))).toContain(`aria-expanded="true"`);
    expect(render(ticketState())).toContain(`data-act="askCjOpen"`);
    for (const screen of ["tickets", "mywork", "feed", "sprint", "ask"] as const) expect(cmdjHeaderButton(ticketState((s) => { s.screen = screen; }))).toBe("");
  });
  it("names the shortcut the way the keyboard does: ⌘J on a Mac, Ctrl J elsewhere", () => {
    expect(cmdjKeyLabel(true)).toBe("⌘J");
    expect(cmdjKeyLabel(false)).toBe("Ctrl J");
  });
});

describe("the shortcut — ⌘J on a Mac, Ctrl+J elsewhere, never a chord the browser or the app already uses", () => {
  const k = (o: Partial<KeyboardEvent>) => ({ key: "j", code: "KeyJ", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...o });
  it("Mac: ⌘J (and ⌘⇧… / ⌥ / Ctrl are not it)", () => {
    expect(isCmdjKey(k({ metaKey: true }), true)).toBe(true);
    expect(isCmdjKey(k({ metaKey: true, key: "J" }), true)).toBe(true);
    expect(isCmdjKey(k({ ctrlKey: true }), true)).toBe(false);
    expect(isCmdjKey(k({ metaKey: true, altKey: true }), true)).toBe(false);     // ⌥⌘J: the console
    expect(isCmdjKey(k({ metaKey: true, shiftKey: true }), true)).toBe(false);   // ⌘⇧J: downloads
    expect(isCmdjKey(k({ metaKey: true, ctrlKey: true }), true)).toBe(false);
  });
  it("elsewhere: Ctrl+J (Ctrl+Shift+J is DevTools; the Windows key is not it)", () => {
    expect(isCmdjKey(k({ ctrlKey: true }), false)).toBe(true);
    expect(isCmdjKey(k({ metaKey: true }), false)).toBe(false);
    expect(isCmdjKey(k({ ctrlKey: true, shiftKey: true, key: "J" }), false)).toBe(false);
    expect(isCmdjKey(k({ ctrlKey: true, altKey: true }), false)).toBe(false);
  });
  it("by letter on a Latin layout, by position on another; never mid-composition", () => {
    expect(isCmdjKey(k({ ctrlKey: true, key: "h", code: "KeyJ" }), false)).toBe(false);   // Dvorak: Ctrl+H is History
    expect(isCmdjKey(k({ ctrlKey: true, key: "j", code: "KeyC" }), false)).toBe(true);
    expect(isCmdjKey(k({ ctrlKey: true, key: "о", code: "KeyJ" }), false)).toBe(true);   // Russian ЙЦУКЕН
    expect(isCmdjKey(k({ ctrlKey: true, isComposing: true }), false)).toBe(false);
    expect(isCmdjKey(k({ ctrlKey: true, key: "k" }), false)).toBe(false);
  });
  it("is left alone while another modal is up (a confirmation, the support dialog, the lightbox), not for the panel itself", () => {
    const el = (inPanel: boolean) => ({ closest: (sel: string) => (inPanel && sel.includes("ask-panel") ? {} : null) });
    const doc = (els: unknown[]) => ({ querySelectorAll: () => els }) as unknown as Document;
    expect(otherModalOpen(doc([]))).toBe(false);
    expect(otherModalOpen(doc([el(true)]))).toBe(false);
    expect(otherModalOpen(doc([el(false)]))).toBe(true);
    expect(otherModalOpen(doc([el(true), el(false)]))).toBe(true);
  });
});

describe("opening, closing and Open as thread (through AskCtx)", () => {
  it("opens about the page's item: a fresh panel thread with it as the context chip; the same item reopens the same conversation", () => {
    const app = ticketState();
    const { ctx, log } = fakeCtx(app);
    openPanel(ctx);
    expect(app.ask.cmdj).toEqual({ open: true, contextRef: "ticket:14" });
    expect(app.ask.composer.panel.context).toEqual(["ticket:14"]);
    expect(log).toContain("new:panel");
    expect(log).toContain("want:ticket:14");
    expect(panelShown(app)).toBe(true);
    // A question was asked; ⌘J closes it (through the exit) and ⌘J on the same ticket brings the same conversation back.
    app.ask.panel = cmdjConvo();
    cmdjToggle(ctx);
    expect(log).toContain("exit:cmdj");
    expect(app.ask.cmdj.open).toBe(false);
    log.length = 0;
    cmdjToggle(ctx);
    expect(log).not.toContain("new:panel");
    expect(app.ask.panel.threadId).toBe(10);
    // Another ticket: a fresh thread about it.
    closePanel(ctx);
    app.ticketId = 21;
    openPanel(ctx);
    expect(log).toContain("new:panel");
    expect(app.ask.cmdj.contextRef).toBe("ticket:21");
    expect(app.ask.composer.panel.context).toEqual(["ticket:21"]);
  });

  it("a page with no item opens an empty panel with no context", () => {
    const app = ticketState((s) => { s.screen = "mywork"; s.ticketId = null; });
    const { ctx } = fakeCtx(app);
    openPanel(ctx);
    expect(app.ask.cmdj).toEqual({ open: true, contextRef: null });
    expect(app.ask.composer.panel.context).toEqual([]);
  });

  it("closing takes the inspector it opened with it; reopening while it slides out keeps it", () => {
    const app = ticketState((s) => { s.ask.cmdj = { open: true, contextRef: "ticket:14" }; s.ask.inspector = { ...s.ask.inspector, where: "panel", stack: ["pr:176"], idx: 0 }; });
    const { ctx, log } = fakeCtx(app);
    closePanel(ctx);
    expect(app.ask.cmdj.open).toBe(false);
    expect(inspectorRef(app.ask)).toBeNull();
    app.ask.cmdj.open = true; app.ask.closing = { cmdj: true };
    cmdjToggle(ctx);                                     // ⌘J while it leaves: it comes back
    expect(log).toContain("keep:cmdj");
    expect(app.ask.cmdj.open).toBe(true);
  });

  it("Open as thread: the conversation, the draft and the open inspector move to the Ask screen; the next ⌘J starts fresh", () => {
    const app = ticketState((s) => {
      s.ask.cmdj = { open: true, contextRef: "ticket:14" };
      s.ask.panel = cmdjConvo();
      s.ask.composer.panel = { ...initialComposerUi(), text: "and the sprint?", context: ["ticket:14"] };
      s.ask.inspector = { ...s.ask.inspector, where: "panel", stack: ["pr:176"], idx: 0 };
    });
    const { ctx, log } = fakeCtx(app);
    cmdjPart.act!(ctx, "askCjOpenThread", null, null);
    expect(log).toContain("open:10");
    expect(app.screen).toBe("ask");
    expect(app.ask.page.threadId).toBe(10);
    expect(app.ask.panel.messages).toEqual([]);
    expect(app.ask.cmdj).toEqual({ open: false, contextRef: null });
    expect(app.ask.composer.page.text).toBe("and the sprint?");
    expect(app.ask.composer.panel.text).toBe("");
    expect(app.ask.inspector.where).toBe("page");
    expect(inspectorRef(app.ask)).toBe("pr:176");
  });

  it("Open as thread before anything is stored: a new thread on the Ask screen with the draft", () => {
    const app = ticketState((s) => { s.ask.cmdj = { open: true, contextRef: "ticket:14" }; s.ask.composer.panel = { ...initialComposerUi(), text: "half a question", context: ["ticket:14"] }; });
    const { ctx, log } = fakeCtx(app);
    openAsThread(ctx);
    expect(log).toContain("new:page");
    expect(app.screen).toBe("ask");
    expect(app.ask.composer.page).toMatchObject({ text: "half a question", context: ["ticket:14"] });
  });
});

describe("Escape — one layer at a time", () => {
  // The controller's own inspector entry (ask-controller.ts `escEntries`), beside the panel's.
  const entries = (): EscEntry<AskCtx>[] => [
    ...cmdjPart.escape!,
    { layer: "inspector", isOpen: (c) => inspectorRef(c.ui) !== null && (c.app.screen === "ask" || c.ui.cmdj.open), close: (c) => c.closeInspector() },
  ];
  it("the panel's inspector closes first (it was opened from the panel), then the panel", () => {
    const app = ticketState((s) => { s.ask.cmdj = { open: true, contextRef: "ticket:14" }; s.ask.inspector = { ...s.ask.inspector, where: "panel", stack: ["pr:176"], idx: 0 }; });
    const { ctx } = fakeCtx(app);
    expect(topLayer(entries(), ctx)).toBe("inspector");
    ctx.closeInspector();
    expect(topLayer(entries(), ctx)).toBe("cmdj");
    closePanel(ctx);
    expect(topLayer(entries(), ctx)).toBeNull();
  });
  it("on the Ask screen the panel is no layer at all", () => {
    const app = ticketState((s) => { s.ask.cmdj = { open: true, contextRef: null }; s.screen = "ask"; });
    expect(topLayer(cmdjPart.escape!, fakeCtx(app).ctx)).toBeNull();
  });
});

describe("the thread contract — a normal thread with origin panel and the page's item as its context_ref", () => {
  beforeEach(() => { calls.length = 0; });
  it("the panel's send goes to POST /ask with origin panel and the item first in context; the stream's thread names it", async () => {
    const app = ticketState();
    let paints = 0;
    const ctl = createAskController({ state: app, mount: { querySelector: () => null } as unknown as HTMLElement, rerender: () => { paints++; }, flash: () => undefined, unauth: () => undefined, search: () => "" });
    openPanel(ctl.ctx);
    const q = ASK_SCENARIO_QUESTION.cmdj!;
    ctl.ctx.send({ text: q.text, where: "panel", context: app.ask.composer.panel.context });
    await vi.waitFor(() => expect(app.ask.panel.busy).toBe(false), { timeout: 3000 });
    const sent = calls.find((c) => c.path === "/ask")!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ threadId: null, text: q.text, origin: "panel", context: ["ticket:14"] });
    // The page's conversation is untouched; the panel's is thread 10, `origin: panel`, `contextRef: ticket:14`.
    expect(app.ask.page.messages).toEqual([]);
    expect(app.ask.panel.threadId).toBe(10);
    expect(app.ask.panel.thread).toMatchObject({ origin: "panel", contextRef: "ticket:14" });
    const a = app.ask.panel.messages[1];
    expect(a.role === "assistant" && a.turn.done).toBeTruthy();
    expect(paints).toBeGreaterThan(0);
    // It is listed like any other thread: the list is read again once the new thread exists.
    expect(calls.filter((c) => c.path === "/ask/threads").length).toBeGreaterThan(0);
  });
  it("the dev replay `?askReplay=cmdj#tickets/14` opens the panel over the ticket with the ticket as its context", () => {
    const plan = replayPlan("cmdj");
    expect(plan).toMatchObject({ where: "panel", play: ["cmdj"] });
    const app = ticketState();
    plan.setup!(fakeCtx(app).ctx);
    expect(app.ask.cmdj).toEqual({ open: true, contextRef: "ticket:14" });
    expect(app.ask.composer.panel.context).toEqual(["ticket:14"]);
    expect(cmdjOverlay(app)).toContain(`data-overlay="ask-panel"`);
  });
  it("the recorded transcript's thread event is a panel thread about ticket #14 (the fixture the replay plays)", () => {
    const t = askTranscript("cmdj", NOW)[0].event;
    expect(t.event).toBe("thread");
    expect(t.data).toMatchObject({ origin: "panel", contextRef: "ticket:14" });
  });
});

describe("motion — the slide in and out, the inspector beside it; all off under reduced motion", () => {
  it("closing is data-closing on the layer (from ctx.exit's flag), and the keyframes run the panel, scrim and inspector out", () => {
    const closing = cmdjOverlay(ticketState((s) => { s.ask.cmdj = { open: true, contextRef: null }; s.ask.closing = { cmdj: true }; }));
    expect(closing).toMatch(/^<div data-overlay="ask-panel" class="ask-panel-layer" data-closing="1">/);
    expect(css).toMatch(/\.ask-panel \{[^}]*animation:ask-panel-in /);
    expect(css).toMatch(/\.ask-panel-layer\[data-closing\] \.ask-panel \{ animation:ask-panel-out /);
    expect(css).toMatch(/\.ask-panel-layer\[data-closing\] \.ask-scrim \{ animation:ask-fade-out /);
    expect(css).toMatch(/\.ask-panel-layer > \.ask-insp-frame\[data-sheet="0"\] \{[^}]*animation:ask-cj-insp-in /);
    expect(css).toMatch(/\.ask-panel-layer > \.ask-insp-frame\[data-sheet="0"\]\[data-closing\] \{ animation:ask-cj-insp-out /);
    expect(css).toMatch(/\.ask-panel-layer\[data-closing\] > \.ask-insp-frame\[data-sheet="0"\] \{ animation:ask-cj-insp-away /);
  });
  it("the reduced-motion switch names the panel, the scrim and the inspector frame", () => {
    const ask = css.slice(css.indexOf("/* ── Ask: motion ──"), css.indexOf("/* ── Ask: threads ──"));
    const reduce = ask.slice(ask.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const sel of [".ask-panel,", ".ask-scrim,", ".ask-insp-frame,", ".ask-panel-layer[data-closing] .ask-panel,"]) expect(reduce).toContain(sel);
  });
});
