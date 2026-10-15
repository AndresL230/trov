// Ask Trov — the ⌘J panel (SEAM: a sibling agent replaces this stub; inventory §8, scenario `cmdj`).
//
// TODO(cmdj): build to the design — the 420px panel on the right over ANY page (full screen on a phone) with a
// scrim, its header (the Trov mark, "Ask Trov", ⌘J, "Open as thread", Close), the page's item as the context
// ("About ticket #14: Guided repository setup"), the switch's short label "Ask first", the inspector opening to
// the panel's LEFT, and the Tickets page's header button "Ask about this ⌘J" (the ONE change to the Tickets
// page — `cmdjHeaderButton`, which render.ts's header shows on a ticket). The panel's thread is a normal
// thread (`origin: "panel"`, `contextRef`); "Open as thread" → `#ask/<id>`.
//
// It opens over any screen, so it is a ROOT-LEVEL `data-overlay` ("ask-panel"): morph.ts patches it in place,
// and the page behind is never rebuilt by typing in it (web-ui.md › A dialog that opens over ANY screen).
//
// THE INTERFACE (keep it; render.ts and the controller call these):
//   CmdjUi / initialCmdjUi()       your state, at `AppState.ask.cmdj`
//   cmdjOverlay(app)               the overlay (""), when closed
//   cmdjHeaderButton(app)          the Tickets page header's "Ask about this ⌘J" ("" elsewhere)
//   cmdjToggle(ctx)                ⌘J away from the Ask screen (the controller's shortcut)
//   cmdjPart                       your acts (`askCj…`), the "cmdj" Escape layer
// CSS: your block in trov.css is `/* ── Ask: cmdj ── */`.

import type { AppState } from "./render";
import type { AskCtx, AskPart } from "./ask-state";
import { askView } from "./ask-state";
import { askIcon, trovMark } from "./ask-icons";
import { conversationView, emptyView } from "./ask-conversation";
import { composerView } from "./ask-composer";
import { inspectorFrame } from "./ask-screen";

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

export function cmdjOverlay(app: AppState): string {
  const ui = app.ask.cmdj;
  if (!ui.open || app.screen === "ask" || app.view !== "app") return "";
  const v = askView(app, "panel");
  const convo = v.ui.panel;
  const insp = v.ui.inspector.where === "panel" ? inspectorFrame(v) : "";
  return `<div data-overlay="ask-panel" class="ask-panel-layer">
    <div class="ask-scrim" data-act="askCjClose" aria-hidden="true"></div>
    ${insp}
    <section class="ask-panel" role="dialog" aria-label="Ask Trov">
      <div class="ask-panel-head">${trovMark(12)}<span class="ask-panel-t">Ask Trov</span><kbd class="ask-kbd">⌘J</kbd><span style="flex:1"></span>
        ${convo.threadId ? `<button type="button" class="ask-ghostbtn" data-act="askCjOpenThread">Open as thread${askIcon("openNew", 12, null, 2)}</button>` : ""}
        <button type="button" class="ask-iconbtn" data-act="askCjClose" aria-label="Close">${askIcon("close", 13, null, 2.2)}</button>
      </div>
      <div class="ask-scroll" data-ask-scroll="panel">${convo.messages.length ? conversationView(v) : emptyView(v)}</div>
      ${composerView(v)}
    </section>
  </div>`;
}

export function cmdjHeaderButton(app: AppState): string {
  if (app.screen !== "ticketdetail") return "";
  return `<button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="askCjOpen">${askIcon("ask", 14)}Ask about this<kbd class="ask-kbd">⌘J</kbd></button>`;
}

export function cmdjToggle(ctx: AskCtx): void {
  const ui = ctx.ui.cmdj;
  if (ui.open) { ui.open = false; ctx.paint(); return; }
  const ref = pageRef(ctx.app);
  // Another page's item: a fresh panel thread about it.
  if (ref !== ui.contextRef) { ctx.newThread("panel"); ctx.ui.composer.panel.context = ref ? [ref] : []; }
  ui.open = true; ui.contextRef = ref;
  if (ref) ctx.want([ref]);
  ctx.paint();
}

export const cmdjPart: AskPart = {
  code: "Cj",
  act(ctx, name) {
    if (name === "askCjOpen") { if (!ctx.ui.cmdj.open) cmdjToggle(ctx); return; }
    if (name === "askCjClose") { ctx.ui.cmdj.open = false; if (ctx.ui.inspector.where === "panel") ctx.closeInspector(); ctx.paint(); return; }
    if (name === "askCjOpenThread") {
      const id = ctx.ui.panel.threadId;
      ctx.ui.cmdj.open = false;
      if (id) ctx.openThread(id);
      return;
    }
  },
  escape: [{ layer: "cmdj", isOpen: (ctx) => ctx.ui.cmdj.open && ctx.app.screen !== "ask", close: (ctx) => { ctx.ui.cmdj.open = false; ctx.paint(); } }],
};

