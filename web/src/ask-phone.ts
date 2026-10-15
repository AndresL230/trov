// Ask Trov — the phone (SEAM: a sibling agent replaces this stub; inventory §10, scenarios `phone`,
// `phone-plus`, `phone-insp`).
//
// TODO(phone): build to the design at 390px — the header's Open threads + New thread (40×40), the thread list
// as a DRAWER over a scrim (`min(300px, 100% - 48px)`), the composer's controls under ONE "+" menu (Attach,
// Mention, Run a command; Mode (Pro) and "Changes in this thread" as `segmented()`) with the meta line "Smart ·
// Asks first", and the inspector as a full-height sheet with a grab handle (the shell gives the frame
// `data-sheet="1"`; you own how it looks and moves). Edit always visible on the last question; no block toolbar.
// The app already has a phone NAV drawer (render.ts menu button): keep it; the threads drawer is Ask's own.
//
// THE INTERFACE (keep it; the shell calls these):
//   PhoneUi / initialPhoneUi()       your state, at `AppState.ask.phone`
//   phoneHeaderControls(app)         the header's right-hand buttons on a phone ("" on a desktop)
//   threadsDrawer(v)                 the thread list as a drawer (the shell's `threadsView` inside)
//   phonePart                        your acts (`askPh…`), the "menu" Escape layer for the drawer and the + menu
// CSS: your block in trov.css is `/* ── Ask: phone ── */`.

import type { AppState } from "./render";
import type { AskPart, AskView } from "./ask-state";
import { askIcon } from "./ask-icons";
import { threadsView } from "./ask-threads";
import { closingAttr } from "./ask-motion";

export interface PhoneUi {
  /** The thread list's drawer is open. */
  drawer: boolean;
  /** The composer's + menu is open. */
  plus: boolean;
}
export const initialPhoneUi = (): PhoneUi => ({ drawer: false, plus: false });

export function phoneHeaderControls(app: AppState): string {
  if (!app.phone || app.screen !== "ask") return "";
  return `<button type="button" class="ask-iconbtn ask-iconbtn--40" data-act="askPhDrawer" aria-label="Open threads">${askIcon("menu", 18)}</button>
    <button type="button" class="ask-iconbtn ask-iconbtn--40 ask-iconbtn--outline" data-act="askShNew" aria-label="New thread">${askIcon("plus", 16, null, 1.9)}</button>`;
}

export function threadsDrawer(v: AskView): string {
  if (!v.app.phone || !v.ui.phone.drawer) return "";
  // MOTION: slides in from the left over a fading scrim (on insertion); closes through `ctx.exit("drawer")`.
  return `<div class="ask-drawer-layer"${closingAttr(v.ui.closing, "drawer")}><div class="ask-drawer-scrim" data-act="askPhDrawerClose" aria-hidden="true"></div><div class="ask-drawer">${threadsView(v)}</div></div>`;
}

export const phonePart: AskPart = {
  code: "Ph",
  act(ctx, name) {
    if (name === "askPhDrawer") { ctx.ui.phone.drawer = true; ctx.paint(); return; }
    if (name === "askPhDrawerClose") { ctx.exit("drawer", () => { ctx.ui.phone.drawer = false; }); return; }
    if (name === "askPhPlus") { ctx.ui.phone.plus = !ctx.ui.phone.plus; ctx.paint(); return; }
  },
  escape: [
    { layer: "menu", isOpen: (ctx) => ctx.ui.phone.plus, close: (ctx) => { ctx.ui.phone.plus = false; ctx.paint(); } },
    { layer: "menu", isOpen: (ctx) => ctx.ui.phone.drawer, close: (ctx) => ctx.exit("drawer", () => { ctx.ui.phone.drawer = false; }) },
  ],
};
