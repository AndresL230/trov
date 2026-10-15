// Ask Trov — the screen's shell (FOUNDATION; inventory §1, ask-trov.dc.html L106–1003). Pure markup.
//
//   askScreenView(app)   the page under the header: thread list | conversation + composer | inspector
//   askHeader(app)       the header's pieces: the threads toggle, "Trov" (a button: a new thread), "› title"
//   inspectorFrame(v)    the inspector's frame (Back, type word, "from …" trail, Open in page, Close, the resize
//                        edge, the phone sheet) around ask-inspector.ts's `inspectorBody`
//   askOverlays(app)     the root-level overlays: the hover card and the ⌘J panel (over any screen)
//
// STRUCTURE IS STABLE: the three columns are ALWAYS emitted and shown / hidden by attribute, so morph.ts never
// swaps the conversation (and the composer's focus, caret and scroll) when the list or the inspector comes and
// goes. The page is `data-morph="ask"` (render.ts), so a keystroke or a streamed word patches it in place.

import { esc, attr } from "./ui";
import type { AppState } from "./render";
import { askView, convoOf, inspectorRef, type AskView } from "./ask-state";
import { askLayout } from "./ask-layout";
import { askIcon } from "./ask-icons";
import { hoverCard, refShort, refTypeWord, viewOf, refFallbackText } from "./ask-refs";
import { threadsView } from "./ask-threads";
import { conversationView, emptyView } from "./ask-conversation";
import { composerView } from "./ask-composer";
import { inspectorBody } from "./ask-inspector";
import { cmdjOverlay } from "./ask-cmdj";
import { threadsDrawer } from "./ask-phone";
import { closingAttr } from "./ask-motion";

/** The inspector's frame for the conversation in `v.where` ("" when it is closed or belongs to the other one). */
export function inspectorFrame(v: AskView): string {
  const ins = v.ui.inspector;
  const ref = inspectorRef(v.ui);
  if (!ref || ins.where !== v.where) return "";
  const view = viewOf(v.look, ref);
  const trail = ins.stack.slice(0, ins.idx).map((r) => { const x = viewOf(v.look, r); return x ? refShort(x) : refFallbackText(r); });
  const typeWord = view ? refTypeWord(view) : "";
  const sheet = v.app.phone;
  // Opening slides it in from its edge (the column under it makes room smoothly); closing is `data-closing`
  // (ask-motion.ts rule 3); `data-dragging` drops the width transition while the edge follows the pointer.
  return `<aside class="ask-insp-frame" aria-label="Inspector" data-sheet="${sheet ? "1" : "0"}" data-where="${v.where}" data-dragging="${ins.dragging ? "1" : "0"}"${closingAttr(v.ui.closing, "inspector")} style="${sheet ? "" : `width:${ins.width}px;--ask-insp-w:${ins.width}px`}">
    ${sheet ? `<div class="ask-insp-grab" aria-hidden="true"><span></span></div>` : `<div class="ask-insp-resize" data-ask-resize role="separator" aria-orientation="vertical" aria-label="Resize inspector" aria-valuemin="380" aria-valuemax="720" aria-valuenow="${ins.width}" tabindex="0"></div>`}
    <div class="ask-insp-head">
      <button type="button" class="ask-iconbtn" data-act="askShBack" aria-label="Back"${ins.idx > 0 ? "" : " disabled"}>${askIcon("back", 15, null, 2)}</button>
      <div class="ask-insp-crumb"><span class="ask-insp-type">${esc(typeWord)}</span>${trail.length ? `<span class="ask-insp-from">from ${esc(trail.join(" › "))}</span>` : ""}</div>
      <button type="button" class="ask-iconbtn" data-act="askShPage" aria-label="Open in page"${view?.href ? "" : " disabled"}>${askIcon("external", 14, null, 2)}</button>
      <button type="button" class="ask-iconbtn" data-act="askShClose" aria-label="Close inspector">${askIcon("close", 13, null, 2.2)}</button>
    </div>
    <div class="ask-insp-body" data-morph-key="insp:${attr(ref)}">${inspectorBody(v, ref)}</div>
  </aside>`;
}

/** The Ask page (the screen body under the app's header). */
export function askScreenView(app: AppState): string {
  const v = askView(app, "page");
  const ui = v.ui;
  const lay = askLayout({ vw: ui.vw, phone: app.phone, threadsForced: ui.threadsForced, inspectorOpen: inspectorRef(ui) !== null && ui.inspector.where === "page" });
  const convo = convoOf(v);
  const empty = convo.messages.length === 0 && convo.status !== "loading";
  // The thread list is ALWAYS emitted on a desktop and slides shut by its width (`data-threads`, a CSS transition),
  // `inert` while shut; on a phone it is the drawer instead. The conversation's contents are keyed by the
  // conversation (`uid`), so a new or another thread enters once and a streamed word only patches.
  const shut = lay.threads !== "column";
  return `<div class="ask-screen" data-ask-root data-threads="${lay.threads}" data-insp="${lay.inspector}" data-empty="${empty ? "1" : "0"}">
    <aside class="ask-threads" aria-label="Threads"${shut ? ` inert aria-hidden="true"` : ""}>${app.phone ? "" : threadsView(v)}</aside>
    <section class="ask-conv" aria-label="Conversation" data-ask-drop="page">
      <div class="ask-scroll" data-ask-scroll="page">${empty ? emptyView(v) : conversationView(v)}</div>
      ${composerView(v)}
    </section>
    <div class="ask-insp-slot">${lay.inspector === "closed" ? "" : inspectorFrame(v)}</div>
    <div class="ask-drawer-slot">${threadsDrawer(v)}</div>
  </div>`;
}

export interface AskHeaderParts { lead: string; title: string; crumb: string }
/** The header on the Ask screen: the threads toggle (desktop), "Trov" — a button that starts a new thread — and
 *  "› <thread title>" once a thread is open or named. */
export function askHeader(app: AppState): AskHeaderParts {
  const ui = app.ask;
  const c = ui.page;
  const title = c.title || c.thread?.title || (c.messages[0]?.role === "user" ? c.messages[0].text.slice(0, 48) : "");
  const lay = askLayout({ vw: ui.vw, phone: app.phone, threadsForced: ui.threadsForced, inspectorOpen: inspectorRef(ui) !== null && ui.inspector.where === "page" });
  const shown = lay.threads === "column";
  const lead = app.phone ? "" : `<button type="button" class="ask-iconbtn ask-th-toggle" data-act="askShThreads" aria-label="${shown ? "Hide threads" : "Show threads"}" aria-pressed="${shown}" data-tip="${shown ? "Hide threads" : "Show threads"}">${askIcon("panel", 16)}</button>`;
  return {
    lead,
    title: `<h1 class="ask-h1"><button type="button" data-act="askShNew" class="ask-h1-b${title ? " is-parent" : ""}">Trov</button></h1>`,
    crumb: title ? `<span class="ask-crumb"><span class="ask-crumb-sep">›</span><span class="ask-crumb-t">${esc(title)}</span></span>` : "",
  };
}

/** The overlays Ask puts at the app's root: the hover card (any screen with chips) and the ⌘J panel. */
export function askOverlays(app: AppState): string {
  if (app.view !== "app") return "";
  const ui = app.ask;
  const v = askView(app, "page");
  const hv = ui.hover ? viewOf(v.look, ui.hover.ref) : null;
  const card = ui.hover && hv ? `<div data-overlay="ask-hc" class="ask-hc-layer"${closingAttr(ui.closing, "hover")}>${hoverCard(hv, v.look, ui.hover.at)}</div>` : "";
  return `${card}${cmdjOverlay(app)}`;
}
