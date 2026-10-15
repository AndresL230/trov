// Ask Trov — the ⌘J panel (inventory §8, scenario `cmdj`; ask-trov.dc.html L284–297, L1196–1197, L1803–1812).
//
// A 420px panel on the right over ANY page (full screen on a phone) above a scrim: its header (the Trov mark, "Ask
// Trov", the shortcut, "Open as thread", Close), the panel's own conversation (`AskUi.panel`) and the composer part's
// `ComposerUi` in panel form (`composerView` with `where: "panel"` — the composer draws its "Ask first" switch label,
// the context line and the placeholder from that). The page's item is the context (`pageRef`): opening the panel on
// another item starts a fresh panel thread with that item as its context chip, which the first send carries as the
// thread's `context_ref` (`origin: "panel"`, src/ai/ask/routes.ts) — a normal thread, listed like any other. "Open as
// thread" moves the conversation (and the draft, and an open inspector) to the Ask screen at `#ask/<id>`. The
// inspector opens to the panel's LEFT. The Tickets page's ONE change is `cmdjHeaderButton` ("Ask about this ⌘J").
//
// Painting: the panel is a ROOT-LEVEL `data-overlay` ("ask-panel"), and the pages it opens over are not
// `data-morph`ed — a full rerender per keystroke or streamed word would rebuild the page behind it
// (web-ui.md › A dialog that opens over ANY screen). So while Ask is not the screen, the controller's paint goes
// through `cmdjRepaint`, which morphs Ask's own overlays in place (and inserts / removes them) and never touches
// the page; anything else (the Ask screen, another route) is a normal rerender.
//
// Keys: ⌘J (Ctrl+J off a Mac) opens and closes it on any page and focuses the Ask screen's composer there
// (`isCmdjKey`; never with Shift / Alt — the browsers' DevTools — nor while another modal is up). Escape closes one
// layer at a time through ask-escape.ts; the panel's own inspector closes before the panel (it was opened from it).
// Tab stays inside the panel while it is open; closing hands focus back to what opened it.
//
// Motion (ask-motion.ts rule 3, trov.css `Ask: cmdj`): the panel slides in from the right over a fading scrim and
// slides back out through `ctx.exit("cmdj", …)` + `data-closing`; its inspector slides out from behind it and back,
// and rides out with the panel when the whole layer closes. All of it is off under reduced motion.

import type { AppState } from "./render";
import type { AskCtx, AskPart } from "./ask-state";
import { askView, inspectorRef } from "./ask-state";
import { askIcon, trovMark } from "./ask-icons";
import { conversationView, emptyView } from "./ask-conversation";
import { composerFocus, composerView, initialComposerUi } from "./ask-composer";
import { askOverlays, inspectorFrame } from "./ask-screen";
import { closingAttr } from "./ask-motion";
import { morph } from "./morph";
import { syncSegments } from "./segmented";

export interface CmdjUi {
  open: boolean;
  /** The page's item the panel is about (`ticket:14`), or null. */
  contextRef: string | null;
}
export const initialCmdjUi = (): CmdjUi => ({ open: false, contextRef: null });

/** The item the current page is about — what the panel takes as its context. */
export function pageRef(app: AppState): string | null {
  if (app.screen === "ticketdetail" && app.ticketId !== null) return `ticket:${app.ticketId}`;
  if (app.screen === "sprint" && app.sprintId !== null) return `sprint:${app.sprintId}`;
  if (app.screen === "handoff" && app.handoffId) return `handoff:${app.handoffId}`;
  if (app.screen === "artifact" && app.artRoute.slug) return `artifact:${app.artRoute.slug}`;
  return null;
}

// ── the shortcut ─────────────────────────────────────────────────────────────

/** A Mac (or an iPad / iPhone with a keyboard): ⌘ is the shortcut's modifier there, Ctrl everywhere else. */
export const isMacLike = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform ?? "");
/** The shortcut as the person's keyboard spells it (the sidebar's "⌘K" / "Ctrl K"). */
export const cmdjKeyLabel = (mac: boolean = isMacLike()): string => (mac ? "⌘J" : "Ctrl J");

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">;
/** Is this keydown the panel's shortcut? ⌘J on a Mac, Ctrl+J elsewhere — never with Shift or Alt (⌘⌥J, Ctrl+Shift+J
 *  open the browser's DevTools), never mid-composition (an IME owns the keys). A non-Latin layout's J key counts
 *  by its position; a Latin layout's by its letter (Dvorak's KeyJ is H, and Ctrl+H is the browser's History). */
export function isCmdjKey(e: KeyLike, mac: boolean = isMacLike()): boolean {
  if (e.altKey || e.shiftKey || e.isComposing) return false;
  const latin = e.key.length === 1 && /[a-z]/i.test(e.key);
  if (latin ? e.key.toLowerCase() !== "j" : e.code !== "KeyJ") return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Another modal is up (a confirmation, the support dialog, the lightbox, …): ⌘J is left to it and the browser. */
export function otherModalOpen(doc: Pick<Document, "querySelectorAll">): boolean {
  return Array.from(doc.querySelectorAll('[aria-modal="true"]')).some((el) => !el.closest('[data-overlay="ask-panel"]'));
}

// ── the markup ──────────────────────────────────────────────────────────────

/** The panel is on screen: open, and not on the Ask screen (where ⌘J focuses the page's own composer). */
export const panelShown = (app: Pick<AppState, "ask" | "screen" | "view">): boolean => app.ask.cmdj.open && app.screen !== "ask" && app.view === "app";

export function cmdjOverlay(app: AppState): string {
  if (!panelShown(app)) return "";
  const v = askView(app, "panel");
  const convo = v.ui.panel;
  const empty = convo.messages.length === 0 && convo.status !== "loading";
  // The inspector the panel opened (to its left; a full-height sheet on a phone). Emitted BEFORE the panel, so the
  // panel paints over it and it slides out from behind it.
  const insp = v.ui.inspector.where === "panel" ? inspectorFrame(v) : "";
  return `<div data-overlay="ask-panel" class="ask-panel-layer"${closingAttr(app.ask.closing, "cmdj")}>
    <div class="ask-scrim" data-act="askCjClose" aria-hidden="true"></div>
    ${insp}
    <section class="ask-panel" role="dialog" aria-modal="true" aria-labelledby="ask-panel-t" data-ask-drop="panel">
      <div class="ask-panel-head">
        ${trovMark(12)}<span class="ask-panel-t" id="ask-panel-t">Ask Trov</span><kbd class="ask-kbd">${cmdjKeyLabel()}</kbd>
        <span class="ask-panel-gap"></span>
        <button type="button" class="ask-ghostbtn" data-act="askCjOpenThread">Open as thread${askIcon("openNew", 12, null, 2)}</button>
        <button type="button" class="ask-iconbtn" data-act="askCjClose" aria-label="Close" data-tip="Close (Esc)">${askIcon("close", 13, null, 2.2)}</button>
      </div>
      <div class="ask-scroll" data-ask-scroll="panel">${empty ? emptyView(v) : conversationView(v)}</div>
      ${composerView(v)}
    </section>
  </div>`;
}

/** The Tickets page header's "Ask about this ⌘J" — the ONE change to that page ("" anywhere else). */
export function cmdjHeaderButton(app: AppState): string {
  if (app.screen !== "ticketdetail") return "";
  const mac = isMacLike();
  return `<button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="askCjOpen" aria-haspopup="dialog" aria-expanded="${panelShown(app)}" aria-keyshortcuts="${mac ? "Meta+J" : "Control+J"}">${askIcon("ask", 14)}Ask about this<kbd class="ask-kbd">${cmdjKeyLabel(mac)}</kbd></button>`;
}

// ── painting over any page ───────────────────────────────────────────────────

const ASK_OVERLAYS = ["ask-hc", "ask-panel"] as const;

/** Repaint Ask's root overlays alone (the hover card, the panel) when Ask is not the screen: morph each in place,
 *  insert the new, remove the gone. False when a full rerender is needed instead (the Ask screen, another view,
 *  a page on screen that is not the one this state draws, no theme root yet). */
export function cmdjRepaint(mount: HTMLElement, app: AppState): boolean {
  if (app.view !== "app" || app.screen === "ask" || typeof document === "undefined") return false;
  const root = mount.firstElementChild;
  if (!root || root.getAttribute("data-screen") !== app.screen || !root.hasAttribute("data-cnpy-theme")) return false;
  const tpl = document.createElement("template");
  tpl.innerHTML = askOverlays(app);           // Ask is never projected by a preview (preview.ts)
  for (const key of ASK_OVERLAYS) {
    const live = root.querySelector<HTMLElement>(`:scope > [data-overlay="${key}"]`);
    const next = tpl.content.querySelector<HTMLElement>(`[data-overlay="${key}"]`);
    if (live && next) morph(live, next);
    else if (next) root.appendChild(next);
    else live?.remove();
  }
  // The page's opener ("Ask about this") says whether its dialog is up; the page itself is not repainted.
  for (const b of Array.from(root.querySelectorAll('[data-act="askCjOpen"]'))) b.setAttribute("aria-expanded", String(panelShown(app)));
  syncSegments(mount);
  return true;
}

// ── opening and closing ─────────────────────────────────────────────────────

/** What had focus when the panel opened — it gets focus back when the panel closes. */
let opener: HTMLElement | null = null;
const raf2 = (f: () => void): void => {
  if (typeof requestAnimationFrame !== "function") { setTimeout(f, 32); return; }
  requestAnimationFrame(() => requestAnimationFrame(f));
};

/** Open the panel about the current page's item (a fresh panel thread when the item changed). */
export function openPanel(ctx: AskCtx): void {
  const ui = ctx.ui.cmdj;
  ctx.cancelExit("cmdj");                            // reopened while it slides out: it stays
  if (typeof document !== "undefined") {
    // (Reopened while it slides out, focus is still inside it: the first opener stays.)
    const a = document.activeElement;
    if (a instanceof HTMLElement && a !== document.body && !a.closest('[data-overlay="ask-panel"]')) opener = a;
  }
  raf2(() => { if (typeof document !== "undefined" && panelShown(ctx.app)) composerFocus(document, "panel"); });
  if (ui.open) { ctx.paint(); return; }
  const ref = pageRef(ctx.app);
  // Another page's item: a fresh panel thread about it (the same item reopens the same conversation).
  if (ref !== ui.contextRef) { ctx.newThread("panel"); ctx.ui.composer.panel.context = ref ? [ref] : []; }
  ui.open = true; ui.contextRef = ref;
  if (ref) ctx.want([ref]);
  ctx.paint();
}

/** ⌘J away from the Ask screen (the controller's shortcut): open, or close. */
export function cmdjToggle(ctx: AskCtx): void {
  if (ctx.ui.cmdj.open && !ctx.ui.closing.cmdj) closePanel(ctx);
  else openPanel(ctx);
}

/** Close the panel with its exit (and the inspector it opened, with it); focus goes back to what opened it. */
export function closePanel(ctx: AskCtx): void {
  if (!ctx.ui.cmdj.open) return;
  ctx.exit("cmdj", () => {
    ctx.ui.cmdj.open = false;
    if (ctx.ui.inspector.where === "panel") ctx.ui.inspector = { ...ctx.ui.inspector, stack: [], idx: -1 };
    const back = opener;
    opener = null;
    if (back) raf2(() => { if (back.isConnected) back.focus(); });
  });
}

/** "Open as thread": the panel's conversation, its draft and an open inspector move to the Ask screen. The panel's
 *  thread is a normal thread, so it opens at `#ask/<id>` (a history entry: Back returns to the page). Before the
 *  first answer names a thread there is nothing stored: the Ask screen opens a new thread with the draft. */
export function openAsThread(ctx: AskCtx): void {
  const id = ctx.ui.panel.threadId;
  const draft = ctx.ui.composer.panel;
  const panelInspector = ctx.ui.inspector.where === "panel" && inspectorRef(ctx.ui) !== null;
  ctx.cancelExit("cmdj");
  ctx.ui.cmdj.open = false;
  ctx.ui.cmdj.contextRef = null;                     // the next ⌘J here starts a fresh panel thread
  opener = null;
  if (id !== null) {
    if (typeof history !== "undefined" && typeof location !== "undefined" && location.hash !== `#ask/${id}`) history.pushState(null, "", `#ask/${id}`);
    ctx.openThread(id);
  } else {
    ctx.newThread("page");
  }
  ctx.ui.composer.page = { ...draft, forced: ctx.ui.composer.page.forced };
  ctx.ui.composer.panel = { ...initialComposerUi(), forced: draft.forced };
  if (panelInspector) ctx.ui.inspector = { ...ctx.ui.inspector, where: "page" };
  ctx.paint();
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab stays inside the panel (and the inspector beside it) while it is open. */
function trapTab(e: KeyboardEvent): boolean {
  if (typeof document === "undefined") return false;
  const layer = document.querySelector<HTMLElement>('[data-overlay="ask-panel"]');
  if (!layer || layer.hasAttribute("data-closing")) return false;
  const items = Array.from(layer.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest("[inert]") && el.getClientRects().length > 0);
  if (!items.length) return false;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const last = items.length - 1;
  if (at >= 0 && !(e.shiftKey && at === 0) && !(!e.shiftKey && at === last)) return false;
  e.preventDefault();
  items[at < 0 ? (e.shiftKey ? last : 0) : e.shiftKey ? last : 0].focus();
  return true;
}

export const cmdjPart: AskPart = {
  code: "Cj",
  act(ctx, name) {
    if (name === "askCjOpen") { openPanel(ctx); return; }
    if (name === "askCjClose") { closePanel(ctx); return; }
    if (name === "askCjOpenThread") { openAsThread(ctx); return; }
  },
  // The panel's inspector was opened from it, so it is the topmost of the two: Escape closes it first (the
  // controller's `inspector` layer), then the panel.
  escape: [{
    layer: "cmdj",
    isOpen: (ctx) => panelShown(ctx.app) && !ctx.ui.closing.cmdj && !(ctx.ui.inspector.where === "panel" && inspectorRef(ctx.ui) !== null),
    close: (ctx) => closePanel(ctx),
  }],
  onKeyDown(ctx, e) {
    if (e.key !== "Tab" || !panelShown(ctx.app)) return false;
    return trapTab(e);
  },
};
