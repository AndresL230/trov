// Ask Trov — the controller (FOUNDATION). main.ts creates ONE (`createAskController`) and hands it:
//   • every `ask…` act            → `act()`, routed by the act's two-letter part code (ask-state.ts)
//   • the screen's arrival         → `enter(threadId)` (loadForScreen "ask")
//   • every paint                  → `afterPaint()`
// and it wires its own DOM listeners (keys, paste, drop, hover cards, the inspector's resize edge, ⌘J, Escape,
// the window's width). It owns the reads, the streams (one per conversation, with Stop), the ref views (one
// batched peek for what is not known yet), the inspector stack and the hover card; the PARTS own the rest.
// Nothing here renders; nothing on a render path fetches.

import type { AppState } from "./render";
import { askApi, AskApiError, isAbort, isUnauthorized, type AskApi } from "./ask-api";
import {
  emptyConvo, convoFromDetail, foldAskEvent, foldThreadEvent, newTurn, stopTurn, failTurn, turnLive, withLastTurn, withQuestionId,
  type AskConvo, type AskMsg,
} from "./ask-stream";
import { initialComposerUi, composerFocus, composerPart } from "./ask-composer";
import { conversationPart } from "./ask-conversation";
import { inspectorPart } from "./ask-inspector";
import { actionsPart } from "./ask-actions";
import { cmdjPart, cmdjRepaint, cmdjToggle, isCmdjKey, otherModalOpen } from "./ask-cmdj";
import { phonePart, closeDrawer } from "./ask-phone";
import { threadsPart } from "./ask-threads";
import { closeTop, type EscEntry } from "./ask-escape";
import { askLayout, clampInspector, layoutBucket } from "./ask-layout";
import { HOVER_CARD, placeHoverCard, refsInText, viewOf } from "./ask-refs";
import { ASK_FX, askEnterNew, askGlideDock, askTweenHeights, reducedMotion } from "./ask-motion";
import { createReplayApi, loadReplayIndex, replayFromLocation, replayPlan, replayQuestionFiles } from "./ask-replay";
import { inspectorRef, type AskCtx, type AskPart, type AskSendInput, type AskWhere } from "./ask-state";
import { AskPacer, type PaceClock } from "./ask-pace";
import { ASK_PEEK_MAX, ASK_DEFAULT_MODE, parseAskRef, type AskEvent, type RefView } from "@shared/ai-ask-core";

export interface AskHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  flash(msg: string, ms?: number): void;
  unauth(e: unknown): void;
  /** Read the page's address (the replay flag). Injected so a test can set it. */
  search?(): string;
  /** Refetch the Tickets queue if it is already loaded (main.ts `loadTickets`): an Ask write the queue shows changed. */
  refreshTickets?(): void;
}

export interface AskController {
  /** Run one `ask…` act; false when it is not Ask's. */
  act(name: string, arg: string | null, value: string | null): boolean;
  /** The Ask screen came up (a route, the sidebar row): load what it needs; `threadId` from `#ask/<id>`. */
  enter(threadId: number | null): void;
  afterPaint(): void;
  /** The context parts get (tests drive parts through it). */
  readonly ctx: AskCtx;
}

/** Every part, in Escape order of no importance (ask-escape.ts orders the layers). Add a part HERE once. */
export const PARTS: readonly AskPart[] = [conversationPart, composerPart, inspectorPart, actionsPart, cmdjPart, phonePart, threadsPart];

export function createAskController(host: AskHost): AskController {
  const s = host.state;
  const ui = () => s.ask;
  let api: AskApi = askApi;
  const streams: Partial<Record<AskWhere, AbortController>> = {};

  // ── painting: many calls, one frame ──────────────────────────────────────
  let paintQueued = false;
  const raf = (f: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => f()) : setTimeout(f, 16));
  function paint(): void {
    if (paintQueued) return;
    paintQueued = true;
    // Away from the Ask screen only Ask's root overlays (the ⌘J panel, the hover card) change: they repaint alone,
    // so the page behind is never rebuilt per keystroke or streamed word (ask-cmdj.ts `cmdjRepaint`).
    raf(() => { paintQueued = false; if (cmdjRepaint(host.mount, s)) after(); else host.rerender(); });
  }

  /** The answer's pace (ask-pace.ts) runs on the page's frames; none without a window (tests) or under reduced motion
   *  (the words show as they arrive). A hidden tab, where frames stop, gets them at once. */
  function paceClock(): PaceClock | null {
    if (typeof window === "undefined" || typeof requestAnimationFrame !== "function" || reducedMotion()) return null;
    const hidden = () => typeof document !== "undefined" && document.hidden;
    return { now: () => performance.now(), frame: (f) => { if (hidden()) setTimeout(f, 0); else requestAnimationFrame(() => f()); }, instant: hidden };
  }

  function fail(e: unknown, fallback: string): void {
    if (isAbort(e)) return;
    if (isUnauthorized(e)) { host.unauth(e); return; }
    host.flash(e instanceof AskApiError && e.message && e.message !== e.code ? e.message : fallback);
  }

  // ── exits (ask-motion.ts rule 3): flag → paint (CSS animates out) → apply → paint ──
  const exits = new Map<string, ReturnType<typeof setTimeout>>();
  function exit(key: string, apply: () => void, ms: number = ASK_FX.exit): void {
    if (exits.has(key)) return;
    if (reducedMotion() || typeof window === "undefined") { apply(); paint(); return; }
    ui().closing = { ...ui().closing, [key]: true };
    paint();
    exits.set(key, setTimeout(() => {
      exits.delete(key);
      const { [key]: _gone, ...rest } = ui().closing;
      ui().closing = rest;
      apply();
      paint();
    }, ms));
  }
  function cancelExit(key: string): void {
    const t = exits.get(key);
    if (t) { clearTimeout(t); exits.delete(key); }
    if (ui().closing[key]) { const { [key]: _gone, ...rest } = ui().closing; ui().closing = rest; }
  }

  // ── ref views: one batched peek for what is not known ────────────────────
  const pending = new Set<string>();
  let peekTimer: ReturnType<typeof setTimeout> | null = null;
  function prime(views: readonly RefView[]): void {
    if (!views.length) return;
    const next = { ...ui().refViews };
    for (const v of views) next[v.ref] = v;
    ui().refViews = next;
  }
  function want(refs: readonly string[]): void {
    for (const r of refs) if (!(r in ui().refViews) && !pending.has(r)) pending.add(r);
    if (!pending.size || peekTimer) return;
    peekTimer = setTimeout(() => {
      peekTimer = null;
      const batch = [...pending].slice(0, ASK_PEEK_MAX);
      batch.forEach((r) => pending.delete(r));
      api.peek(batch)
        .then((items) => { const next = { ...ui().refViews }; for (const it of items) next[it.ref] = it; ui().refViews = next; paint(); })
        .catch(() => undefined)
        .finally(() => { if (pending.size) want([]); });
    }, 30);
  }
  /** Every RefView an event carries goes straight into the store. */
  function primeFromEvent(e: AskEvent): void {
    if (e.event === "done") prime(e.data.cites);
    else if (e.event === "block") {
      const b = e.data;
      if (b.kind === "items") prime(b.items);
      else if (b.kind === "diagram") prime(b.diagram.nodes.flatMap((n) => (n.view ? [n.view] : [])));
    } else if (e.event === "action" && e.data.preview.item) prime([e.data.preview.item]);
    else if (e.event === "activity" && e.data.state === "done" && e.data.results?.length) want(e.data.results);
  }

  // ── the conversations ────────────────────────────────────────────────────
  const setConvo = (where: AskWhere, c: AskConvo) => { ui()[where] = c; };
  let seq = 0;

  async function run(input: AskSendInput): Promise<void> {
    const where = input.where ?? "page";
    let c = ui()[where];
    if (c.busy) return;
    const st = ui().state.data;
    const mode = input.mode ?? c.thread?.mode ?? st?.defaultMode ?? ASK_DEFAULT_MODE;
    const auto = input.auto ?? c.thread?.auto ?? false;
    // Edit-and-resend drops the question and everything after it; regenerate drops the answer only.
    let messages: AskMsg[] = c.messages;
    let ask = true;
    if (input.replaceFrom !== undefined) {
      const i = messages.findIndex((m) => (m.role === "user" ? m.id : m.turn.messageId) === input.replaceFrom);
      if (i >= 0) { ask = messages[i].role === "user"; messages = messages.slice(0, i); }
    }
    const key = `k${++seq}`;
    const q: AskMsg[] = ask ? [{ role: "user", key: `q${key}`, id: null, text: input.text, context: input.context ?? [], attachments: input.files ?? [], command: input.command ?? null }] : [];
    c = { ...c, messages: [...messages, ...q, { role: "assistant", key: `a${key}`, turn: newTurn(mode) }], busy: true, status: c.status === "idle" ? "ok" : c.status };
    setConvo(where, c);
    ui().conversation.stick = true;
    want(input.context ?? []);
    paint();
    const ctl = new AbortController();
    streams[where] = ctl;
    const wasNew = c.threadId === null;
    let textSeen = "";
    const deliver = (e: AskEvent) => {
      if (streams[where] !== ctl) return;
      if (e.event === "thread") setConvo(where, foldThreadEvent(ui()[where], e.data));
      else if (e.event === "done") setConvo(where, withLastTurn(withQuestionId(ui()[where], e.data.questionId), (t) => foldAskEvent(t, e, Date.now())));
      else setConvo(where, withLastTurn(ui()[where], (t) => foldAskEvent(t, e, Date.now())));
      primeFromEvent(e);
      if (e.event === "text") { textSeen += e.data.delta; if (/\]\]/.test(e.data.delta)) want(refsInText(textSeen)); }
      for (const p of PARTS) p.onEvent?.(ctx, where, e);
      paint();
    };
    // The answer's words go out at a reading pace (ask-pace.ts): a burst the model held back arrives as a stream.
    // Stop (or anything that aborts) delivers what was received at once.
    const clock = paceClock();
    const pacer = clock ? new AskPacer(deliver, clock) : AskPacer.passthrough(deliver);
    ctl.signal.addEventListener("abort", () => pacer.flush(), { once: true });
    try {
      await api.ask({
        threadId: c.threadId, text: input.text, command: input.command, mode, auto, context: input.context ?? [], attachments: input.attachments ?? [],
        replaceFrom: input.replaceFrom, origin: where === "panel" ? "panel" : undefined,
      }, { signal: ctl.signal, onEvent: (e) => { if (streams[where] === ctl) pacer.push(e); } });
      // The stream is over; its last words (and `done`) are still going out — Send stays Stop until they have.
      pacer.close();
      await pacer.idle();
      if (streams[where] === ctl) setConvo(where, withLastTurn(ui()[where], (t) => failTurn(t)));
    } catch (e) {
      pacer.flush();
      if (isAbort(e) || ctl.signal.aborted) setConvo(where, withLastTurn(ui()[where], stopTurn));
      else if (isUnauthorized(e)) { host.unauth(e); }
      else {
        const message = e instanceof AskApiError ? e.message : "Something went wrong.";
        const code = e instanceof AskApiError ? e.code : "failed";
        setConvo(where, withLastTurn(ui()[where], (t) => (turnLive(t) ? { ...t, error: { code, message } } : t)));
      }
    } finally {
      if (streams[where] === ctl) { delete streams[where]; setConvo(where, { ...ui()[where], busy: false }); }
      paint();
      if (wasNew || where === "page") reloadThreads();
    }
  }

  function stop(where: AskWhere = "page"): void {
    const ctl = streams[where];
    const id = ui()[where].threadId;
    if (!ctl) return;
    ctl.abort();
    if (id) api.stopThread(id).catch(() => undefined);
  }

  function reloadThreads(): void {
    if (ui().threads.status === "idle") ui().threads = { status: "loading", data: [] };
    api.listThreads().then((data) => { ui().threads = { status: "ok", data }; }).catch((e) => {
      if (isUnauthorized(e)) host.unauth(e);
      else ui().threads = { ...ui().threads, status: ui().threads.data.length ? "ok" : "error" };
    }).finally(paint);
  }

  function newThread(where: AskWhere = "page"): void {
    if (streams[where]) streams[where]!.abort();
    delete streams[where];
    setConvo(where, emptyConvo());
    ui().composer[where] = { ...initialComposerUi(), forced: ui().composer[where].forced };
    if (ui().inspector.where === where) ui().inspector = { ...ui().inspector, stack: [], idx: -1 };
    if (where === "page") { s.screen = "ask"; closeDrawer(ctx); }
    paint();
    raf(() => composerFocus(host.mount, where));
  }

  function openThread(id: number): void {
    s.screen = "ask";
    closeDrawer(ctx);                                 // the phone drawer slides out (its exit), the thread opens under it
    if (ui().panel.threadId === id) {                 // ⌘J's "Open as thread": the panel's conversation moves over
      setConvo("page", ui().panel);
      setConvo("panel", emptyConvo());
      paint();
      return;
    }
    if (ui().page.threadId === id && ui().page.status !== "error") { paint(); return; }
    stop("page");
    setConvo("page", { ...emptyConvo(), threadId: id, status: "loading" });
    ui().inspector = { ...ui().inspector, stack: [], idx: -1 };
    paint();
    api.getThread(id).then((d) => {
      if (ui().page.threadId !== id) return;
      setConvo("page", { ...convoFromDetail(d), uid: ui().page.uid });    // the column stays; the skeleton settles
      for (const m of d.messages) { prime(m.cites); want(m.context); }
    }).catch((e) => {
      if (ui().page.threadId !== id) return;
      setConvo("page", { ...ui().page, status: "error" });
      fail(e, "Couldn't open this thread.");
    }).finally(paint);
  }

  function openRef(ref: string, where: AskWhere = s.screen === "ask" ? "page" : "panel"): void {
    const ins = ui().inspector;
    const stack = ins.where === where ? ins.stack : [];
    const idx = ins.where === where ? ins.idx : -1;
    cancelExit("inspector");                          // reopened while closing: it stays
    if (idx < 0) ui().threadsForced = null;          // the layout hides the list under 1640px while it is open
    if (stack[idx] !== ref) ui().inspector = { ...ins, where, stack: [...stack.slice(0, idx + 1), ref], idx: idx + 1 };
    else ui().inspector = { ...ins, where };
    cancelExit("hover");
    ui().hover = null;
    if (parseAskRef(ref)) want([ref]);            // an `askcv:` item has no view to peek (ask-cvref.ts)
    paint();
  }
  function closeInspector(): void {
    if (inspectorRef(ui()) === null) return;
    exit("inspector", () => { ui().inspector = { ...ui().inspector, stack: [], idx: -1 }; });
  }

  const ctx: AskCtx = {
    get app() { return s; },
    get ui() { return s.ask; },
    get api() { return api; },
    get replay() { return s.ask.replay !== null; },
    look: () => ({ views: ui().refViews, persons: s.persons.data }),
    paint, flash: (m, ms) => host.flash(m, ms), fail, want,
    refreshTickets: () => host.refreshTickets?.(),
    send: (input) => { void run(input); },
    stop, openRef, closeInspector, newThread, openThread, reloadThreads, exit, cancelExit,
  };

  // ── the shell's own acts (`askSh…`) ──────────────────────────────────────
  /** AU-OWNER-3: after Hide threads / Threads ›, the next paint focuses the other control. */
  let focusThreadsCtl: "show" | "hide" | null = null;
  function shellAct(name: string, arg: string | null): void {
    switch (name) {
      case "askShNew": newThread("page"); return;
      case "askShOpen": if (arg) openRef(arg); return;
      case "askShBack": { const ins = ui().inspector; if (ins.idx > 0) { ui().inspector = { ...ins, idx: ins.idx - 1 }; paint(); } return; }
      case "askShClose": closeInspector(); return;
      case "askShThreads": {
        const shown = askLayout({ vw: ui().vw, phone: s.phone, threadsForced: ui().threadsForced, inspectorOpen: inspectorRef(ui()) !== null && ui().inspector.where === "page" }).threads === "column";
        ui().threadsForced = !shown;
        // Keyboard: focus moves to the control that undoes it (the one pressed is now hidden / inert).
        focusThreadsCtl = shown ? "show" : "hide";
        paint();
        return;
      }
      case "askShPage": {
        const ref = inspectorRef(ui());
        const v = ref ? viewOf(ctx.look(), ref) : null;
        if (!v?.href) return;
        if (v.href.startsWith("#")) { ui().cmdj.open = false; location.hash = v.href; }
        else window.open(v.href, "_blank", "noopener");
        return;
      }
    }
  }

  // ── DOM: keys, paste, drop, hover cards, the resize edge, the width ──────
  /** The hover card leaves with its fade (a short exit), unless the pointer comes back to it. */
  const hideCard = (): void => exit("hover", () => { ui().hover = null; }, 120);
  const escEntries: EscEntry<AskCtx>[] = [
    ...PARTS.flatMap((p) => p.escape ?? []),
    { layer: "hovercard", isOpen: () => ui().hover !== null, close: () => hideCard() },
    { layer: "inspector", isOpen: () => inspectorRef(ui()) !== null && (s.screen === "ask" || ui().cmdj.open), close: () => closeInspector() },
  ];
  const askOnScreen = () => s.view === "app" && (s.screen === "ask" || ui().cmdj.open);

  if (typeof document !== "undefined") {
    document.addEventListener("keydown", (e) => {
      if (s.view !== "app") return;
      if (isCmdjKey(e) && !otherModalOpen(document)) {
        e.preventDefault();
        if (e.repeat) return;
        if (s.screen === "ask") composerFocus(host.mount, "page");
        else cmdjToggle(ctx);                       // opening focuses the panel's composer (ask-cmdj.ts)
        return;
      }
      if (e.key === "Escape" && askOnScreen() && closeTop(escEntries, ctx)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    const route = <E extends Event>(hook: "onKeyDown" | "onPaste" | "onDragOver" | "onDragLeave" | "onDrop" | "onChange") => (e: E) => {
      if (!askOnScreen()) return;
      for (const p of PARTS) { const f = p[hook] as ((c: AskCtx, ev: E) => boolean) | undefined; if (f?.(ctx, e)) return; }
    };
    host.mount.addEventListener("keydown", route<KeyboardEvent>("onKeyDown"));
    host.mount.addEventListener("paste", route<ClipboardEvent>("onPaste"));
    host.mount.addEventListener("dragover", route<DragEvent>("onDragOver"));
    host.mount.addEventListener("dragleave", route<DragEvent>("onDragLeave"));
    host.mount.addEventListener("drop", route<DragEvent>("onDrop"));
    host.mount.addEventListener("focusout", route<FocusEvent>("onChange"));

    // The hover card: 320ms over (or focus on) a chip; it leaves 140ms after the pointer, unless it went INTO the card.
    let hcTimer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => { if (hcTimer) { clearTimeout(hcTimer); hcTimer = null; } };
    const showFor = (el: HTMLElement) => {
      const ref = el.dataset.askRef ?? "";
      clear();
      if (ui().hover?.ref === ref) { cancelExit("hover"); paint(); return; }     // back on the same chip: it stays
      hcTimer = setTimeout(() => {
        if (!el.isConnected || !viewOf(ctx.look(), ref)) return;
        const r = el.getBoundingClientRect();
        cancelExit("hover");
        ui().hover = { ref, at: placeHoverCard(r, window.innerWidth, window.innerHeight) };
        paint();
      }, HOVER_CARD.delayMs);
    };
    const hideSoon = () => { clear(); hcTimer = setTimeout(() => { if (ui().hover) hideCard(); }, HOVER_CARD.leaveMs); };
    host.mount.addEventListener("pointerover", (e) => {
      if (e.pointerType === "touch") return;
      const t = e.target as Element | null;
      if (t?.closest?.(".ask-hc")) { clear(); cancelExit("hover"); return; }
      const chip = t?.closest?.<HTMLElement>("[data-ask-ref]");
      if (chip && host.mount.contains(chip)) showFor(chip);
    });
    host.mount.addEventListener("pointerout", (e) => {
      const from = (e.target as Element | null)?.closest?.("[data-ask-ref], .ask-hc");
      const to = (e.relatedTarget as Element | null)?.closest?.("[data-ask-ref], .ask-hc");
      if (from && from !== to) { if (ui().hover || hcTimer) hideSoon(); }
    });
    host.mount.addEventListener("focusin", (e) => { const chip = (e.target as Element | null)?.closest?.<HTMLElement>("[data-ask-ref]"); if (chip) showFor(chip); });
    host.mount.addEventListener("focusout", (e) => { if ((e.target as Element | null)?.closest?.("[data-ask-ref]")) hideSoon(); });

    // The inspector's edge: drag (pointer) or ←/→ (keyboard) between 380 and 720.
    host.mount.addEventListener("pointerdown", (e) => {
      const edge = (e.target as Element | null)?.closest?.<HTMLElement>("[data-ask-resize]");
      if (!edge || e.button !== 0) return;
      e.preventDefault();
      const frame = edge.closest<HTMLElement>(".ask-insp-frame");
      const x0 = e.clientX, w0 = ui().inspector.width;
      ui().inspector = { ...ui().inspector, dragging: true };     // no width transition while it follows the pointer
      paint();
      const move = (ev: PointerEvent) => {
        const w = clampInspector(w0 + (x0 - ev.clientX));
        ui().inspector = { ...ui().inspector, width: w };
        if (frame) frame.style.width = `${w}px`;     // live, without a repaint per pixel
      };
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); ui().inspector = { ...ui().inspector, dragging: false }; paint(); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    host.mount.addEventListener("keydown", (e) => {
      if (!(e.target as Element | null)?.closest?.("[data-ask-resize]") || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      ui().inspector = { ...ui().inspector, width: clampInspector(ui().inspector.width + (e.key === "ArrowLeft" ? 16 : -16)) };
      paint();
    });

    window.addEventListener("resize", () => {
      const vw = window.innerWidth;
      const was = layoutBucket(ui().vw);
      ui().vw = vw;
      if (ui().hover) ui().hover = null;
      if (layoutBucket(vw) !== was && askOnScreen()) paint();
    });
  }

  // ── arrival ──────────────────────────────────────────────────────────────
  // The replay flag is read ONCE, when the controller is made (main.ts module load): the boot rewrites the
  // address to the org's canonical href (`?askReplay` would be gone by the time the Ask screen enters).
  const bootReplay = replayFromLocation(host.search ? host.search() : typeof location !== "undefined" ? location.search : "");
  let replayStarted = false;
  async function startReplay(r: { scenario: string; speed: number }): Promise<void> {
    replayStarted = true;
    ui().replay = r;
    try {
      const index = await loadReplayIndex();
      const plan = replayPlan(r.scenario);
      api = createReplayApi(index, plan, r.speed);
      prime(Object.values(index.refs));
      ui().state = { status: "ok", data: await api.getState() };
      ui().threads = { status: "ok", data: await api.listThreads() };
      plan.setup?.(ctx);
      if (ui().threadQ) ui().hits = { status: "ok", data: await api.searchThreads(ui().threadQ) };
      paint();
      for (const sc of plan.play) {
        const q = index.questions[sc] ?? { text: "What's blocking the hosting work?", context: [], attachments: [] };
        await run({ text: q.text, where: plan.where, context: q.context, files: replayQuestionFiles(index.questions[sc]) });
      }
      plan.after?.(ctx);
      paint();
    } catch (e) {
      host.flash(e instanceof AskApiError && e.status === 404
        ? "The Ask replay is off here: it needs wrangler dev with LOCAL_AI_PREVIEW and no live Stripe key."
        : "Couldn't start the Ask replay.", 6000);
      ui().replay = null;
      api = askApi;
      load();
    }
  }

  function load(): void {
    if (ui().state.status !== "ok") {
      ui().state = { status: "loading", data: ui().state.data };
      api.getState().then((data) => { ui().state = { status: "ok", data }; }).catch((e) => {
        ui().state = { status: "error", data: null };
        fail(e, "Couldn't read Ask Trov's state.");
      }).finally(paint);
    }
    reloadThreads();
  }

  function enter(threadId: number | null): void {
    const r = bootReplay;
    if (r && !replayStarted) { void startReplay(r); if (threadId) openThread(threadId); paint(); return; }
    if (!ui().replay) load();
    if (threadId !== null && threadId !== ui().page.threadId) openThread(threadId);
    paint();
  }

  function after(): void {
    // The ⌘J scenario plays over another page (`?askReplay=cmdj#tickets/14`): the Ask screen never enters there.
    if (bootReplay && !replayStarted && s.view === "app" && replayPlan(bootReplay.scenario).where === "panel") void startReplay(bootReplay);
    if (!askOnScreen()) return;
    for (const p of PARTS) p.afterPaint?.(ctx, host.mount);
    if (focusThreadsCtl) { const which = focusThreadsCtl; focusThreadsCtl = null; host.mount.querySelector<HTMLElement>(which === "show" ? ".ask-th-show" : ".ask-th-hide")?.focus(); }
    // Motion (ask-motion.ts): new rows / messages / parts enter once; swapped cards tween their height.
    askEnterNew(host.mount);
    askTweenHeights(host.mount);
    askGlideDock(host.mount);
    // The ⌘J panel on any page: make sure its state is read once.
    if (ui().cmdj.open && ui().state.status === "idle" && !ui().replay) load();
  }

  return {
    ctx,
    act(name, arg, value) {
      if (!name.startsWith("ask")) return false;
      const code = name.slice(3, 5);
      if (code === "Sh") { shellAct(name, arg); return true; }
      const part = PARTS.find((p) => p.code === code);
      if (!part?.act) return false;
      part.act(ctx, name, arg, value);
      return true;
    },
    enter,
    afterPaint: () => after(),
  };
}
