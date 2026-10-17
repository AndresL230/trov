/**
 * Ask Trov's shell (FOUNDATION): the route, the Trov row in the sidebar, the three columns and their
 * breakpoints, the Escape stack's order, and the motion hooks every part inherits (web/src/ask-motion.ts:
 * entrances of new keyed children only, exits through state, height tweens, all off under reduced motion).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
import { render, initialState, type AppState } from "../web/src/render";
import { sidebarView, navKeyOf, NAV_CLOSED } from "../web/src/sidebar";
import { parseHash, hashForRoute, pageKey } from "../web/src/hash";
import { askLayout, clampInspector, layoutBucket } from "../web/src/ask-layout";
import { ESC_LAYERS, closeTop, topLayer, type EscEntry } from "../web/src/ask-escape";
import { ASK_BOTTOM_SLACK, askEnterNew, askFollowBottom, askGlideDock, askHoldScroll, askKeepScroll, askTweenHeights, closingAttr, stickAfterScroll, tweenStart } from "../web/src/ask-motion";
import { createReplayApi, replayFromLocation, replayPlan, replayQuestionFiles, replayRoute } from "../web/src/ask-replay";
import type { AskReplayIndex } from "../web/src/ask-api";
import { setApiOrg } from "../web/src/api";
import { emptyConvo } from "../web/src/ask-stream";
import { threadsPart } from "../web/src/ask-threads";
import type { AskCtx } from "../web/src/ask-state";
import { askThreadsFixture, askRefFixtures, askStateFixture, askTranscript, askTranscriptSse } from "@shared/ai-fixtures";
import css from "../web/src/trov.css?raw";

const NOW = new Date("2026-10-15T12:00:00Z");
const ME = { handle: "andres", name: "Andres Lopez", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "owner" as const }], superadmin: false, pending_invites: 0 };
function askState(over: (s: AppState) => void = () => undefined): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "ask"; s.orgSlug = "saplinglearn";
  (s as { me: unknown }).me = ME;
  s.ask.vw = 1440;
  s.ask.state = { status: "ok", data: askStateFixture("pro", NOW) };
  s.ask.threads = { status: "ok", data: askThreadsFixture(NOW) };
  s.ask.refViews = askRefFixtures(NOW);
  over(s);
  return s;
}

describe("route — #ask and #ask/<id>", () => {
  it("parses and writes back both, and nothing else under #ask", () => {
    expect(parseHash("#ask")).toEqual({ screen: "ask", ticketId: null, sprintId: null });
    expect(parseHash("#ask/12")).toMatchObject({ screen: "ask", askThread: 12 });
    expect(parseHash("#ask/abc").screen).toBe("mywork");
    expect(parseHash("#ask/1/2").screen).toBe("mywork");
    expect(hashForRoute(parseHash("#ask"))).toBe("#ask");
    expect(hashForRoute(parseHash("#ask/12"))).toBe("#ask/12");
  });
  it("a thread is not a page: opening one (or naming a new one) never replays the screen's entrance", () => {
    expect(pageKey(parseHash("#ask/12"))).toBe(pageKey(parseHash("#ask")));
    expect(pageKey(parseHash("#ask/12"))).toBe(pageKey(parseHash("#ask/40")));
  });
});

describe("sidebar — the Trov row", () => {
  const props = { collapsed: false, navOpen: { ...NAV_CLOSED }, qView: "table" as const, roadmapTab: "timeline" as const, docSpace: "technical", docSpaces: [],
    counts: { review: 0, maintenance: 0, tickets: 0, handoffs: 0, prompts: 0 }, me: null, displayName: "", logo: "" };
  it("sits in Workspace right after My Work, lit on the Ask screen", () => {
    const html = sidebarView({ ...props, screen: "ask" });
    const acts = [...html.matchAll(/data-act="(go[A-Za-z]+)"/g)].map((m) => m[1]);
    expect(acts.indexOf("goAsk")).toBe(acts.indexOf("goMyWork") + 1);
    expect(navKeyOf("ask")).toBe("ask");
    expect(html).toMatch(/data-act="goAsk"[^>]*>[\s\S]*?Trov/);
  });
});

describe("layout — the three columns' rules", () => {
  it("thread list 260px under its breakpoints; the header toggle overrides; a phone has neither column", () => {
    expect(askLayout({ vw: 1440, phone: false, threadsForced: null, inspectorOpen: false })).toEqual({ threads: "column", inspector: "closed" });
    expect(askLayout({ vw: 1179, phone: false, threadsForced: null, inspectorOpen: false }).threads).toBe("hidden");
    expect(askLayout({ vw: 1600, phone: false, threadsForced: null, inspectorOpen: true })).toEqual({ threads: "hidden", inspector: "column" });
    expect(askLayout({ vw: 1640, phone: false, threadsForced: null, inspectorOpen: true }).threads).toBe("column");
    expect(askLayout({ vw: 1000, phone: false, threadsForced: true, inspectorOpen: false }).threads).toBe("column");
    expect(askLayout({ vw: 1440, phone: false, threadsForced: false, inspectorOpen: false }).threads).toBe("hidden");
    expect(askLayout({ vw: 390, phone: true, threadsForced: true, inspectorOpen: true })).toEqual({ threads: "hidden", inspector: "sheet" });
  });
  it("the inspector resizes between 380 and 720; a resize repaints only across a breakpoint", () => {
    expect(clampInspector(100)).toBe(380);
    expect(clampInspector(900)).toBe(720);
    expect(clampInspector(512.4)).toBe(512);
    expect(layoutBucket(1179)).not.toBe(layoutBucket(1180));
    expect(layoutBucket(1300)).toBe(layoutBucket(1600));
  });
});

describe("the screen — renders end to end with the parts' stubs", () => {
  it("a new thread: the header reads 'Ask Trov' (plain text), the three columns, the starters and the composer", () => {
    const html = render(askState());
    expect(html).toContain(`data-morph="ask"`);
    // AU-OWNER-3: "Ask Trov" is a title, not a button; New thread is the threads column's.
    expect(html).toMatch(/<h1 class="ask-h1"><span class="ask-h1-t">Ask Trov<\/span><\/h1>/);
    expect(html).not.toMatch(/<h1 class="ask-h1"><button/);
    expect(html).toContain(`class="ask-screen"`);
    expect(html).toMatch(/<aside class="ask-threads" aria-label="Threads">/);
    expect(html).toContain(`data-ask-scroll="page"`);
    expect(html).toContain(`data-ask-input="page"`);
    expect(html).toContain("Ask anything about your team's work");
    expect(html).toContain(`class="ask-insp-slot"></div>`);
    // The thread list: grouped, keyed rows that enter once (ask-motion.ts rule 2).
    expect(html).toMatch(/<div class="ask-th-list" data-morph-list data-ask-enter="rise"><div class="ask-th" data-morph-key="th:\d+">/);
    expect(html).toContain(">Pinned<");
  });

  it("the thread list stays in the DOM when it is shut (it slides by its width), inert", () => {
    const html = render(askState((s) => { s.ask.vw = 1000; }));
    expect(html).toContain(`data-threads="hidden"`);
    expect(html).toMatch(/<aside class="ask-threads" aria-label="Threads" inert aria-hidden="true"><div class="ask-threads-in">/);
  });

  // AU-OWNER-3: no panel toggle in the header. "Hide threads" sits on the threads column's New thread row; when the
  // list is shut, "Threads ›" at the conversation's leading edge brings it back (focusable only then). Same state
  // (`threadsForced`), same automatic hiding.
  it("AU-OWNER-3: Hide threads beside New thread; Threads › at the conversation's edge while the list is shut", () => {
    const open = render(askState());
    const header = open.slice(open.indexOf('<header class="cnpy-hdr"'), open.indexOf("</header>"));
    expect(header).not.toContain(`data-act="askShThreads"`);
    expect(header).toContain("Ask Trov");
    expect(open).toMatch(/<div class="ask-th-newrow">\s*<button type="button" class="ask-th-new" data-act="askShNew">[\s\S]*?New thread<\/button>\s*<button type="button" class="ask-th-hide" data-act="askShThreads" aria-label="Hide threads" data-tip="Hide threads">/);
    expect(open).toMatch(/<button type="button" class="ask-th-show" data-act="askShThreads" aria-label="Show threads" data-tip="Show threads" tabindex="-1" aria-hidden="true">Threads/);
    const shut = render(askState((s) => { s.ask.threadsForced = false; }));
    expect(shut).toContain(`data-threads="hidden"`);
    expect(shut).toMatch(/<button type="button" class="ask-th-show" data-act="askShThreads" aria-label="Show threads" data-tip="Show threads">Threads/);
    // It fades in (the app's clock) and nothing moves under reduced motion.
    expect(css).toMatch(/\.ask-screen\[data-threads="hidden"\] \.ask-th-show \{ opacity:1; visibility:visible;/);
    expect(css).toMatch(/\.ask-th-show, \.ask-th-hide \{ transition:none !important; \}/);
    // A phone keeps its drawer: neither control.
    const phone = render(askState((s) => { s.phone = true; s.ask.vw = 360; }));
    expect(phone).not.toContain(`class="ask-th-show"`);
    expect(phone).not.toContain(`class="ask-th-hide"`);
  });

  it("a thread being read is a skeleton inside the conversation's own column, keyed by the conversation", () => {
    const html = render(askState((s) => { s.ask.page = { ...emptyConvo(), uid: "c9", threadId: 3, status: "loading" }; }));
    expect(html).toContain(`<div class="ask-col" data-morph-key="cv:c9"><div data-morph-key="sk">`);
    expect(html).toContain(`aria-busy="true"`);
    expect(html).not.toContain("Ask anything about your team's work");
  });

  it("an open item: the inspector's frame carries its width for the slide, and data-closing while it leaves", () => {
    const open = (closing: boolean) => render(askState((s) => {
      s.ask.inspector = { ...s.ask.inspector, stack: ["ticket:14"], idx: 0 };
      if (closing) s.ask.closing = { inspector: true };
    }));
    expect(open(false)).toMatch(/<aside class="ask-insp-frame"[^>]*data-dragging="0" style="width:480px;--ask-insp-w:480px">/);
    expect(open(true)).toMatch(/<aside class="ask-insp-frame"[^>]*data-closing="1"/);
    // Under 1640px the list makes room for it.
    expect(open(false)).toContain(`data-threads="hidden"`);
  });

  it("the hover card is a root overlay keyed by its ref (another chip's card pops in again)", () => {
    const html = render(askState((s) => { s.ask.hover = { ref: "ticket:14", at: { x: 10, y: 10 } }; }));
    expect(html).toMatch(/data-overlay="ask-hc"[^>]*>\s*<div class="ask-hc"[^>]*data-morph-key="hc:ticket:14"/);
    expect(render(askState((s) => { s.ask.hover = { ref: "ticket:14", at: { x: 10, y: 10 } }; s.ask.closing = { hover: true }; })))
      .toMatch(/data-overlay="ask-hc" class="ask-hc-layer" data-closing="1"/);
  });

  it("the ⌘J panel is a root overlay over another screen, and the Tickets page gains Ask about this", () => {
    const html = render(askState((s) => { s.screen = "ticketdetail"; s.ticketId = 14; s.ask.cmdj = { open: true, contextRef: "ticket:14" }; }));
    expect(html).toContain(`data-overlay="ask-panel"`);
    expect(html).toContain(`data-act="askCjOpen"`);
    expect(html).toContain(`data-ask-input="panel"`);
  });
});

describe("Escape — one layer at a time, in the design's order", () => {
  it("picker → menu → hover card → ⌘J → inspector", () => {
    expect([...ESC_LAYERS]).toEqual(["picker", "menu", "hovercard", "cmdj", "inspector"]);
    const open = new Set(["inspector", "menu", "hovercard"]);
    const closed: string[] = [];
    const entries: EscEntry<null>[] = ESC_LAYERS.map((layer) => ({ layer, isOpen: () => open.has(layer), close: () => { open.delete(layer); closed.push(layer); } }));
    expect(topLayer(entries, null)).toBe("menu");
    while (closeTop(entries, null)) { /* one per Escape */ }
    expect(closed).toEqual(["menu", "hovercard", "inspector"]);
  });
});

describe("the thread list — a row's ⋯ takes the time's place", () => {
  // e2e AU-24 search: on a search hit the ⋯ (shown on hover / while its menu is open) sat ON the time ("Tue" drawn
  // through the button): the rule that hides the time left hits out. The design hides it on every row (L239).
  it("hides the time on hover and while the menu is open, search hits included", () => {
    expect(css).not.toMatch(/:not\(\.ask-th-b--hit\)\s*\.ask-th-at/);
    expect(css).toMatch(/\.ask-th-in:hover \.ask-th-at,\s*\.ask-th\.is-menu \.ask-th-at\s*\{\s*opacity:\s*0/);
  });
});

describe("Ask's borderless fields leave the focus ring to their box", () => {
  // e2e AU-24 composer:busy / AU-14: a focused composer drew TWO rings — the box's (the design's accent ring) and the
  // app-wide field ring on the borderless textarea inside it; the thread search box likewise. Like .cnpy-search-in,
  // they are left out of the field rule and their box draws the focus.
  it("excludes .ask-input and the thread search input from the app-wide field ring", () => {
    const rule = css.split("\n").find((l) => l.includes(":focus-visible { border-color:var(--focus) !important; box-shadow:0 0 0 1px var(--focus)") && l.includes("textarea):not("))!;
    expect(rule).toContain(".ask-input");
    expect(rule).toContain(".ask-th-q");
    expect(render(askState())).toMatch(/<input class="ask-th-q"/);
    // …and the boxes keep the app's focus contrast (web-ui.md › focus rings): a --focus edge.
    expect(css).toMatch(/\.ask-box:focus-within \{ border-color:var\(--focus\)/);
    expect(css).toMatch(/\.ask-th-search:focus-within \{ border-color:var\(--focus\)/);
  });
});

describe("the thread menu by keyboard", () => {
  // e2e EV-AU-live-K: Enter on a row's ⋯ opened the menu but left focus on ⋯ — ↑↓ did nothing, and only Tab reached
  // Rename. Like the composer's mode menu: opening focuses the first item, ↑↓ move (wrapping), Escape returns to ⋯.
  type El = { name: string; focused: boolean; focus(): void; closest(sel: string): El | null; parentElement: El | null; querySelectorAll(sel: string): El[]; querySelector(sel: string): El | null };
  function fakeMenu() {
    let current: El | null = null;
    const mk = (name: string): El => ({ name, focused: false, focus() { if (current) current.focused = false; this.focused = true; current = this; }, closest: () => null, parentElement: null, querySelectorAll: () => [], querySelector: () => null });
    const menu = mk("menu");
    const items = ["Rename", "Pin", "Export", "Delete"].map(mk);
    for (const it of items) { it.parentElement = menu; it.closest = (sel: string) => (sel.includes("menuitem") ? it : null); }
    menu.querySelectorAll = () => items;
    const more = mk("more");
    const mount = { querySelector: (sel: string) => (sel.includes("menuitem") ? items[0] : sel.includes("askThMore") ? more : null) };
    return { items, more, mount, focused: () => current?.name ?? null };
  }
  it("opening focuses the first item; ↑↓ move and wrap; Escape hands focus back to ⋯", () => {
    const s = askState();
    const ctx = { ui: s.ask, paint() {}, exit: (_k: string, apply: () => void) => apply(), cancelExit() {} } as unknown as AskCtx;
    const m = fakeMenu();
    threadsPart.act!(ctx, "askThMore", "7", null);
    threadsPart.afterPaint!(ctx, m.mount as unknown as HTMLElement);
    expect(m.focused()).toBe("Rename");
    const key = (k: string) => threadsPart.onKeyDown!(ctx, { key: k, target: m.items.find((i) => i.focused), preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent);
    expect(key("ArrowDown")).toBe(true); expect(m.focused()).toBe("Pin");
    key("ArrowUp"); key("ArrowUp"); expect(m.focused()).toBe("Delete");
    threadsPart.escape![0].close(ctx);
    threadsPart.afterPaint!(ctx, m.mount as unknown as HTMLElement);
    expect(s.ask.threadMenu).toBeNull();
    expect(m.focused()).toBe("more");
  });
});

describe("QA-2: thread Delete asks first (confirmModal), then deletes", () => {
  it("Delete opens the app's confirm at the root; Cancel deletes nothing; Delete deletes and the row leaves", async () => {
    const s = askState();
    const t = s.ask.threads.data[0];
    const deleted: number[] = [];
    const flashes: string[] = [];
    const ctx = {
      ui: s.ask, app: s, replay: false, paint() {}, exit: (_k: string, apply: () => void) => apply(), cancelExit() {}, newThread() {}, reloadThreads() {},
      flash: (m: string) => { flashes.push(m); }, fail() {},
      api: { deleteThread: async (id: number) => { deleted.push(id); } },
    } as unknown as AskCtx;
    threadsPart.act!(ctx, "askThDelete", String(t.id), null);
    expect(deleted).toEqual([]);
    expect(s.ask.threadDelete).toEqual({ id: t.id, title: t.title, shared: !!t.shared, who: null });
    const root = render(s);
    expect(root).toMatch(/data-overlay="confirm-ask-th-delete"[\s\S]*role="alertdialog"/);
    expect(root).toContain(`Delete “${t.title}”?`);
    expect(root).toContain("The conversation and the files attached to it are deleted for good.");
    expect(root).toMatch(new RegExp(`data-confirm-act="askThDeleteGo" data-confirm-cancel="askThDeleteCancel" data-arg="${t.id}"`));
    // Closing plays the confirm's own exit (`data-closing` on its layer) before it goes.
    s.ask.closing = { thdel: true };
    expect(render(s)).toMatch(/data-overlay="confirm-ask-th-delete" data-confirm-layer data-confirm-tone="danger" class="cnpy-cmodal" data-closing/);
    s.ask.closing = {};
    threadsPart.act!(ctx, "askThDeleteCancel", String(t.id), null);
    expect(s.ask.threadDelete).toBeNull();
    expect(deleted).toEqual([]);
    expect(render(s)).not.toContain("ask-th-delete");
    threadsPart.act!(ctx, "askThDelete", String(t.id), null);
    threadsPart.act!(ctx, "askThDeleteGo", String(t.id), null);
    await new Promise((r) => setTimeout(r, 0));
    expect(deleted).toEqual([t.id]);
    expect(s.ask.threadDelete).toBeNull();
    expect(s.ask.threads.data.some((x) => x.id === t.id)).toBe(false);
    expect(flashes.at(-1)).toBe(`Deleted ${t.title}`);
  });
});

describe("the empty conversation — centred as the design draws it", () => {
  // e2e AU-2 (`live`): the design puts a flexible spacer UNDER the composer while the conversation is empty
  // (ask-trov.dc.html L770 `flex:1 1 0;min-height:24px`), so the mark, the heading, the starters and the composer sit
  // in the middle of the column; the app had none, and drew the whole block at the bottom of the page.
  it("has the spacer under the composer while empty, and none once there are messages", () => {
    const empty = render(askState());
    expect(empty).toMatch(/data-ask-composer="page"[\s\S]*class="ask-empty-tail"/);
    const busy = render(askState((s) => { s.ask.page = { ...emptyConvo(), uid: "c9", threadId: 3, status: "loading" }; }));
    expect(busy).not.toContain("ask-empty-tail");
    expect(css).toMatch(/\.ask-empty-tail\s*\{[^}]*flex:\s*1 1 0/);
  });

  // AU-OWNER-1 (the owner, on the af26ce3c preview): the empty screen must START centred — heading, starters and the
  // composer in the middle of the column (design `live`) — and the composer docks at the foot once the first
  // question is sent, gliding there (rule 8); re-opening an empty thread centres it again.
  it("AU-OWNER-1: centred while empty (the spacer under a 'center' composer), docked with messages", () => {
    const empty = render(askState());
    expect(empty).toMatch(/data-ask-composer="page" data-ask-dock="center"/);
    expect(empty).toMatch(/data-ask-dock="center"[\s\S]*class="ask-empty-tail"/);
    const docked = render(askState((s) => {
      s.ask.page = { ...emptyConvo(), uid: "c7", threadId: 3, status: "ok", messages: [{ role: "user", key: "q1", id: 1, text: "hi", context: [], attachments: [], command: null }] as typeof s.ask.page.messages };
    }));
    expect(docked).toMatch(/data-ask-composer="page" data-ask-dock="dock"/);
    expect(docked).not.toContain("ask-empty-tail");
    const again = render(askState((s) => { s.ask.page = { ...emptyConvo(), uid: "c8" }; }));
    expect(again).toMatch(/data-ask-dock="center"/);
  });

  it("AU-OWNER-1: the composer glides between its places when data-ask-dock flips — never under reduced motion, never on a plain repaint", () => {
    const calls: { frames: Keyframe[] }[] = [];
    let top = 400, at = "center";
    const el = { getAttribute: () => at, getBoundingClientRect: () => ({ top }), animate: (frames: Keyframe[]) => { calls.push({ frames }); return {}; } };
    const root = { querySelectorAll: () => [el] } as unknown as ParentNode;
    expect(askGlideDock(root, false)).toBe(0);          // first paint: remembered only
    top = 380; expect(askGlideDock(root, false)).toBe(0); // a repaint that moves it (the box grows): no glide
    at = "dock"; top = 760;
    expect(askGlideDock(root, false)).toBe(1);
    expect(calls[0].frames[0]).toEqual({ transform: "translateY(-380px)" });
    at = "center"; top = 400;
    expect(askGlideDock(root, true)).toBe(0);          // reduced motion: it just moves
  });
});

describe("the dev replay — the recipe's flags", () => {
  it("reads ?askReplay and ?askSpeed, and every design scenario has a plan", () => {
    expect(replayFromLocation("?askReplay=answer&askSpeed=4")).toEqual({ scenario: "answer", speed: 4 });
    expect(replayFromLocation("?askReplay=composer:autoOff")).toEqual({ scenario: "composer:autoOff", speed: 1 });
    expect(replayFromLocation("?askReplay=%3Cx%3E")).toBeNull();
    expect(replayFromLocation("")).toBeNull();
    expect(replayPlan("answer").play).toEqual(["answer"]);
    expect(replayPlan("cmdj").where).toBe("panel");
    expect(replayPlan("live").play).toEqual([]);
    expect(replayRoute("What's blocking the hosting work?")).toBe("answer");
  });

  // e2e AU-24 streaming: the transcript is recorded mid-answer (no `done`); the route ends the HTTP stream there, and
  // the client took that end as a failed turn ("Something went wrong.") instead of the design's held answer
  // (busy, the soft cursor, Stop). The replay holds it until Stop aborts the request.
  // e2e AU-24 answer: the diagram's "CI on main" node (a repo ref) drew "Unknown" — the transcript's repo view has no
  // facts; the index's (filled from the Overview's sample) does. The replay draws the index's view.
  it("gives a transcript's repo views the index's facts (the diagram's CI node is not 'Unknown')", async () => {
    vi.stubGlobal("fetch", async () => new Response(askTranscriptSse(askTranscript("answer", NOW)), { headers: { "content-type": "text/event-stream" } }));
    setApiOrg("saplinglearn");
    try {
      const refs = askRefFixtures(NOW);
      const repo = Object.values(refs).find((v) => v.type === "repo")!;
      const facts = { sample: true };
      const index = { scenarios: [], questions: {}, state: { pro: askStateFixture("pro", NOW), free: askStateFixture("free", NOW) }, settings: {}, threads: [], search: { q: "", hits: [] },
        refs: { ...refs, [repo.ref]: { ...repo, extra: { ...repo.extra, facts } } } } as unknown as AskReplayIndex;
      const api = createReplayApi(index, replayPlan("answer"), 0);
      const nodes: { ref?: string | null; view?: { extra: Record<string, unknown> } | null }[] = [];
      await api.ask({ text: "x", mode: "smart", auto: false, context: [], attachments: [] }, { onEvent: (e) => { if (e.event === "block" && e.data.kind === "diagram") nodes.push(...e.data.diagram.nodes); } });
      const ci = nodes.find((n) => n.ref === repo.ref);
      expect(ci?.view?.extra.facts).toEqual(facts);
    } finally {
      vi.unstubAllGlobals();
      setApiOrg(null);
    }
  });

  // e2e AU-24 streaming / answer: the design's question carries its file (ci-failure.png, an image card above the
  // bubble); the replay sent only the text and the context chip, dropping the scenario's attachments.
  it("sends a scenario question's files with it (the question's file card)", () => {
    const files = replayQuestionFiles({ text: "x", context: [], attachments: [{ title: "ci-failure.png", kind: "image", size: 421_888 }] });
    expect(files).toEqual([expect.objectContaining({ title: "ci-failure.png", kind: "image", size: 421_888, contentType: "image/png" })]);
    expect(replayQuestionFiles(null)).toEqual([]);
  });

  it("holds a transcript that ends mid-answer until Stop aborts it", async () => {
    const sse = askTranscriptSse(askTranscript("streaming", NOW));
    vi.stubGlobal("fetch", async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    setApiOrg("saplinglearn");
    try {
      const index = { scenarios: [], questions: {}, state: { pro: askStateFixture("pro", NOW), free: askStateFixture("free", NOW) }, settings: {}, threads: [], search: { q: "", hits: [] }, refs: {} } as unknown as AskReplayIndex;
      const api = createReplayApi(index, replayPlan("streaming"), 0);
      const ctl = new AbortController();
      const seen: string[] = [];
      let settled: "pending" | "resolved" | "aborted" = "pending";
      const run = api.ask({ text: "x", mode: "smart", auto: false, context: [], attachments: [] }, { signal: ctl.signal, onEvent: (e) => seen.push(e.event) })
        .then(() => { settled = "resolved"; }, (e: unknown) => { settled = e instanceof Error && e.name === "AbortError" ? "aborted" : "resolved"; });
      await new Promise((r) => setTimeout(r, 50));
      expect(seen.at(-1)).toBe("text");
      expect(seen).not.toContain("done");
      expect(settled).toBe("pending");
      ctl.abort();
      await run;
      expect(settled).toBe("aborted");
    } finally {
      vi.unstubAllGlobals();
      setApiOrg(null);
    }
  });
});

// ── motion ──────────────────────────────────────────────────────────────────

/** Just enough DOM for the motion hooks: elements with keys, children, attributes, a height and animate(). */
class El {
  attrs: Record<string, string>;
  children: El[] = [];
  anims: unknown[] = [];
  offsetHeight = 0;
  constructor(attrs: Record<string, string> = {}, kids: El[] = []) { this.attrs = attrs; this.children = kids; }
  getAttribute(n: string): string | null { return n in this.attrs ? this.attrs[n] : null; }
  animate(frames: unknown, opts: unknown): void { this.anims.push([frames, opts]); }
  querySelectorAll(sel: string): El[] {
    const attr = sel.slice(1, -1);
    const out: El[] = [];
    const walk = (e: El) => { for (const c of e.children) { if (c.getAttribute(attr) !== null) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

describe("motion — the hooks every part inherits (web/src/ask-motion.ts)", () => {
  it("a keyed list's first paint animates nothing; later only the NEW keys enter, once", () => {
    const row = (k: string) => new El({ "data-morph-key": k });
    const a = row("th:1"), b = row("th:2");
    const list = new El({ "data-ask-enter": "rise", "data-morph-list": "" }, [a, b]);
    const root = new El({}, [list]);
    expect(askEnterNew(root as unknown as ParentNode, false)).toBe(0);
    const c = row("th:3");
    list.children = [c, a, b];
    expect(askEnterNew(root as unknown as ParentNode, false)).toBe(1);
    expect(c.anims.length).toBe(1);
    expect(a.anims.length + b.anims.length).toBe(0);
    // A repaint with the same keys replays nothing.
    expect(askEnterNew(root as unknown as ParentNode, false)).toBe(0);
    // Reduced motion: nothing moves, but the keys are still learned.
    list.children = [row("th:4"), c, a, b];
    expect(askEnterNew(root as unknown as ParentNode, true)).toBe(0);
    expect(askEnterNew(root as unknown as ParentNode, false)).toBe(0);
  });

  it("a swapped card tweens its height from the last paint's; not under reduced motion", () => {
    const card = new El({ "data-ask-tween": "" });
    const root = new El({}, [card]);
    card.offsetHeight = 120;
    expect(askTweenHeights(root as unknown as ParentNode, false)).toBe(0);
    card.offsetHeight = 34;
    expect(askTweenHeights(root as unknown as ParentNode, false)).toBe(1);
    card.offsetHeight = 120;
    expect(askTweenHeights(root as unknown as ParentNode, true)).toBe(0);
  });

  it("a height glide clips its height only (overflow-y:clip) — hidden would stop a first child's margin collapsing; X would cut the left overhang", () => {
    const card = new El({ "data-ask-tween": "" });
    card.offsetHeight = 40;
    askTweenHeights(new El({}, [card]) as unknown as ParentNode, false);
    card.offsetHeight = 90;
    askTweenHeights(new El({}, [card]) as unknown as ParentNode, false);
    const [frames] = card.anims[0] as [Keyframe[], unknown];
    expect(frames.map((f) => f.overflowY)).toEqual(["clip", "clip"]);
    expect(frames.every((f) => f.overflow === undefined && f.overflowX === undefined)).toBe(true);
  });

  it("a glide's start (rule 4): the same target is no new glide; a new one starts where the eye is", () => {
    expect(tweenStart(undefined, 48, null)).toBe(null);          // a first paint
    expect(tweenStart(357, 48, null)).toBe(357);                 // the card swapped for its line
    expect(tweenStart(48, 48, 200)).toBe(null);                  // a paint mid-glide, same target: it keeps running
    expect(tweenStart(48, 49, 200)).toBe(null);                  // sub-2px: a rounding, not a change
    expect(tweenStart(48, 357, 120)).toBe(120);                  // a new target mid-glide: from where it is now
    expect(tweenStart(48, 357, 356)).toBe(null);                 // …already there
  });

  it("a paint mid-glide (Confirm's own paints, every streamed word) never starts a glide back from the glide's own height", () => {
    // A height animation sets the element's offsetHeight: mid-glide it reads the glide's height, not the content's.
    class Anim {
      playState: "running" | "idle" = "running";
      currentTime = 0;
      constructor(public from: number, public to: number) {}
      cancel(): void { this.playState = "idle"; }
      at(): number | null { return this.playState === "running" && this.currentTime < 240 ? this.from + (this.to - this.from) * (this.currentTime / 240) : null; }
    }
    class TEl {
      natural = 0;
      anims: Anim[] = [];
      constructor(public attrs: Record<string, string> = {}, public children: TEl[] = []) {}
      get offsetHeight(): number { const a = this.anims[this.anims.length - 1]; return a?.at() ?? this.natural; }
      getAttribute(n: string): string | null { return n in this.attrs ? this.attrs[n] : null; }
      animate(frames: { height: string }[]): Anim { const a = new Anim(parseFloat(frames[0].height), parseFloat(frames[1].height)); this.anims.push(a); return a; }
      querySelectorAll(): TEl[] { return this.children; }
    }
    const card = new TEl({ "data-ask-tween": "" });
    const root = new TEl({}, [card]) as unknown as ParentNode;
    card.natural = 357;
    expect(askTweenHeights(root, false)).toBe(0);
    card.natural = 48;                                             // Confirm: the card becomes its done line
    expect(askTweenHeights(root, false)).toBe(1);
    const glide = card.anims[0];
    expect([glide.from, glide.to]).toEqual([357, 48]);
    glide.currentTime = 10;                                        // the Confirm's second paint, 10ms in
    expect(askTweenHeights(root, false)).toBe(0);
    glide.currentTime = 120;                                       // a streamed word, half way
    expect(askTweenHeights(root, false)).toBe(0);
    expect(card.anims.length).toBe(1);
    expect(glide.playState).toBe("running");                       // left alone…
    expect(glide.currentTime).toBe(120);                           // …where it was (stepped past its end only to measure)
    // The content changes again mid-glide (Edit opens): one new glide, from the height on screen.
    card.natural = 300;
    expect(askTweenHeights(root, false)).toBe(1);
    expect(glide.playState).toBe("idle");
    expect([card.anims[1].from, card.anims[1].to]).toEqual([202.5, 300]);
  });

  it("a paint's measuring layout never moves a conversation up (askHoldScroll → askKeepScroll)", () => {
    const sc = Object.assign(new El({ "data-ask-scroll": "page" }), { scrollTop: 143 });
    const root = new El({}, [sc]) as unknown as ParentNode;
    askHoldScroll(root);
    sc.scrollTop = 0;                                              // the swapped card measured short: clamped
    expect(askKeepScroll(root)).toBe(1);
    expect(sc.scrollTop).toBe(143);
    askHoldScroll(root);
    sc.scrollTop = 400;                                            // a paint that moves it DOWN is left alone
    expect(askKeepScroll(root)).toBe(0);
    expect(sc.scrollTop).toBe(400);
    sc.scrollTop = 10;                                             // nothing held (no paint): nothing put back
    expect(askKeepScroll(root)).toBe(0);
    expect(sc.scrollTop).toBe(10);
  });

  it("the bottom (rule 7): only scrolling UP lets go; reaching the bottom holds on; the pins' own scrolls never let go", () => {
    const at = (top: number, height = 2000, client = 600) => ({ top, height, client });
    // At the bottom (a pin, or a glide clamping the top down as the conversation shrinks): held.
    expect(stickAfterScroll(false, 1400, at(1400))).toBe(true);
    expect(stickAfterScroll(true, 1400, at(1350, 1950))).toBe(true);
    expect(stickAfterScroll(true, 1400, at(1400 - ASK_BOTTOM_SLACK + 1, 2000))).toBe(true);
    // The person scrolled up, even a little: let go (the old 60px slack yanked a short scroll back down).
    expect(stickAfterScroll(true, 1400, at(1370))).toBe(false);
    // A pin's own scroll event, read while a glide under it still holds the conversation taller: it went DOWN, so
    // it keeps holding — the old rule read "290px from the bottom" there and let go for the rest of the answer.
    expect(stickAfterScroll(true, 1110, at(1400, 2290))).toBe(true);
    // Scrolling down without reaching the bottom changes nothing.
    expect(stickAfterScroll(false, 900, at(1000))).toBe(false);
  });

  it("the bottom (rule 7): moves a scroller only when the conversation says so — a jump, or (reduced motion) the ease at once", () => {
    const sc = Object.assign(new El({ "data-ask-scroll": "page" }), { scrollTop: 0, scrollHeight: 1800 });
    const root = new El({}, [sc]);
    // Nothing the conversation did (a person opened Wrong? or the sources): the view stays, the rows push down.
    expect(askFollowBottom(root as unknown as ParentNode, () => null, () => true, true)).toBe(0);
    expect(sc.scrollTop).toBe(0);
    expect(askFollowBottom(root as unknown as ParentNode, () => "jump", () => true, false)).toBe(1);
    expect(sc.scrollTop).toBe(1800);
    sc.scrollTop = 0;
    expect(askFollowBottom(root as unknown as ParentNode, () => "ease", () => true, true)).toBe(1);
    expect(sc.scrollTop).toBe(1800);
  });

  it("an exit is an attribute the renderer emits from state", () => {
    expect(closingAttr({ inspector: true }, "inspector")).toBe(` data-closing="1"`);
    expect(closingAttr({}, "inspector")).toBe("");
  });

  // Every Ask rule that animates or transitions is switched off by the one reduced-motion block: its base class
  // is listed there with `!important`, which beats every variant (`[data-closing]`, `[data-sheet]`).
  const ask = css.slice(css.indexOf("/* ══ Ask Trov"), css.indexOf("/* ── the site on a phone")).replace(/\/\*[\s\S]*?\*\//g, "");
  const reduce = ask.slice(ask.indexOf("@media (prefers-reduced-motion: reduce)"));
  const reduceSel = new Set(reduce.slice(0, reduce.indexOf("\n}\n")).split(/[{},]/).map((x) => x.trim()));
  const baseClass = (sel: string): string => (sel.trim().split(/\s+/).pop()!.match(/^\.[a-z][\w-]*(\.[a-z][\w-]*)?(::[a-z-]+)?/)?.[0] ?? "");
  it.each(["animation", "transition"] as const)("every Ask %s is off under prefers-reduced-motion", (prop) => {
    const body = ask.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, "");
    // A colour or border easing on hover is not motion (the app keeps those); anything that MOVES or resizes is.
    const moves = (b: string) => prop === "animation" || /transition:[^;]*\b(width|height|grid-template-rows|transform|margin|opacity|top|left|right)\b/.test(b);
    const rules = [...body.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, , b]) => new RegExp(`(^|;|\\s)${prop}:(?!\\s*none)`).test(b) && moves(b));
    expect(rules.length).toBeGreaterThan(prop === "animation" ? 10 : 2);
    for (const [, sels] of rules) {
      for (const sel of sels.split(",")) {
        if (/prefers-reduced-motion/.test(sel)) continue;
        const cls = baseClass(sel);
        if (!cls.startsWith(".ask-")) continue;
        expect(reduceSel.has(cls) || [...reduceSel].some((r) => r.endsWith(cls)), `${sel.trim()}: ${prop} not off under reduced motion`).toBe(true);
      }
    }
  });
});

// ── a repository (#186): the Overview's facts, its verdict and its marks ─────
import { repoScenario, SCENARIO_KEYS, SCENARIO_VARIANTS } from "../web/src/repo-sample";
import { envVerdict, VERDICT } from "../web/src/repo-verdict";
import { stateMark } from "../web/src/marks";
import { hoverCard, repoFactsOf, repoMark, repoVerdicts } from "../web/src/ask-refs";
import { askRepoFacts, type RefView } from "@shared/ai-ask-core";

describe("a repo ref — RepoFacts, the Overview's verdict, stateMark (#186)", () => {
  const view = (facts: unknown): RefView => ({ ref: "repo:AndresL230/trov", type: "repo", title: "AndresL230/trov", status: null, href: "#repo", extra: { facts } });
  const look = { views: {}, persons: [] };

  it.each(SCENARIO_KEYS.flatMap((k) => SCENARIO_VARIANTS[k].map((v) => [k, v] as const)))("scenario %s/%s: every environment's mark is the Overview's", (k, variant) => {
    const facts = askRepoFacts(repoScenario(k, variant, { now: NOW.getTime() }));
    const v = view(facts);
    expect(repoFactsOf(v)).toEqual(facts);
    const rows = repoVerdicts(facts);
    expect(rows.map((r) => r.verdict)).toEqual([...facts.envs].sort((a, b) => a.position - b.position).map((e) => envVerdict(facts, e.key)));
    for (const { verdict, env } of rows) {
      // Healthy only when the branch head's checks PASS; otherwise never Healthy.
      if (verdict.key === "healthy") expect(facts.ci.find((c) => c.env === env.key)?.state).toBe("pass");
    }
    const card = hoverCard(v, look, { x: 0, y: 0 });
    for (const { env, verdict } of rows.slice(0, 3)) {
      expect(card).toContain(esc(env.name));
      expect(card).toContain(stateMark(verdict.word, verdict.tone, verdict.shape, 12, verdict.tip));
    }
    // No provider id stands in for a host, and no part history beyond the newest deploy rides along.
    expect(facts.parts.every((p) => p.history.length <= 1)).toBe(true);
  });

  it("no facts is Unknown — never Healthy, never zero", () => {
    expect(repoMark(null)).toBe(stateMark(VERDICT.unknown.word, VERDICT.unknown.tone, VERDICT.unknown.shape, 12.5, VERDICT.unknown.tip));
    const card = hoverCard(view(null), look, { x: 0, y: 0 });
    expect(card).toContain("Unknown");
    expect(card).toContain("Trov has no reading of this repository yet.");
    expect(card).not.toContain("Healthy");
  });
});

function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
