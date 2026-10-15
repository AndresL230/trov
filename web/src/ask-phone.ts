// Ask Trov — the phone (inventory §10, scenarios `phone`, `phone-plus`, `phone-insp`; ask-trov.dc.html L111–118,
// L679–691, L748–756, L787, L1008, L1794, L1808, L1830). At phone width (main.ts `state.phone`, ≤ 640px):
//
//   • the header's right side: Open threads + New thread (44×44; the app's own nav button stays on the left, so
//     Open threads draws the threads glyph, not a second hamburger); the bug and theme buttons leave (the design)
//   • the thread list as a DRAWER from the left over a scrim (`min(300px, 100% - 48px)`): a modal dialog — focus
//     moves in, Tab stays in, Escape / the scrim / Close / picking a thread close it, focus comes back
//   • the composer's controls under ONE "+" menu (Attach a file or photo, Mention a ticket, doc or person, Run a
//     command; Mode (Pro) and Changes in this thread as `segmented()`), with the meta line "Smart · Asks first"
//     beside the + and a 44×44 Send / Stop — the composer calls `phoneComposerBar(v)` in place of its toolbar
//   • the inspector as a full-height SHEET (the shell's frame carries `data-sheet="1"` and the grab handle; this
//     part owns how it looks and moves, and its focus: in on open, Tab stays in, back on close)
//
// Every touch target here is at least 44px (the design draws 40 / 34: the build's floor is 44).
//
// THE INTERFACE (the shell and the composer call these):
//   PhoneUi / initialPhoneUi()       this part's state, at `AppState.ask.phone`
//   phoneHeaderControls(app)         the header's right-hand buttons on a phone ("" on a desktop)
//   threadsDrawer(v)                 the thread list as a drawer (the shell's `threadsView` inside)
//   phoneComposerBar(v)              the composer's bottom row on a phone (+, meta, Send) and the + menu ("" on a desktop)
//   closeDrawer(ctx)                 close the drawer through its exit (the shell calls it on New thread / a thread pick)
//   phonePart                        the acts (`askPh…`), the "menu" Escape layer (drawer, + menu), focus, the trap
// The + menu drives the COMPOSER's own controls, never copies of them: Attach clicks the composer's file input
// (any `input[type=file]` inside `[data-ask-composer="<where>"]`), Mention / Run a command type "@" / "/" into
// its box (a real `input` event, so its picker opens as if typed), Mode / Changes write `ComposerUi.mode / .auto`.
// MOTION (ask-motion.ts): the drawer slides from the left over a fading scrim, the sheet slides up, the + menu pops
// (and its + turns 45°) — each closes through `ctx.exit` ("drawer", "plus", the shell's "inspector"), all of it off
// under reduced motion. CSS: `/* ── Ask: phone ── */` in trov.css.

import { esc } from "./ui";
import type { AppState } from "./render";
import type { AskCtx, AskPart, AskView, AskWhere } from "./ask-state";
import { askIcon } from "./ask-icons";
import { threadsView } from "./ask-threads";
import { closingAttr } from "./ask-motion";
import { segmented } from "./segmented";
import type { AskMode } from "@shared/ai-ask-core";

export interface PhoneUi {
  /** The thread list's drawer is open. */
  drawer: boolean;
  /** The composer's + menu is open … */
  plus: boolean;
  /** … under this conversation's composer (the Ask page's, or the ⌘J panel's — full screen on a phone). */
  plusAt: AskWhere;
}
export const initialPhoneUi = (): PhoneUi => ({ drawer: false, plus: false, plusAt: "page" });

/** "An admin turned off Auto" (the design's tooltip; on a phone it is a line under the switch — nothing hovers). */
export const AUTO_OFF_NOTE = "An admin turned off Auto for this org. Trov asks before every change.";

export function phoneHeaderControls(app: AppState): string {
  if (!app.phone || app.screen !== "ask") return "";
  const open = app.ask.phone.drawer;
  return `<button type="button" class="ask-ph-hbtn" data-act="askPhDrawer" aria-label="Open threads" aria-haspopup="dialog" aria-expanded="${open}" aria-controls="ask-ph-drawer">${askIcon("phThreads", 19)}</button>
    <button type="button" class="ask-ph-hbtn ask-ph-hbtn--outline" data-act="askShNew" aria-label="New thread">${askIcon("plus", 16, null, 1.9)}</button>`;
}

export function threadsDrawer(v: AskView): string {
  if (!v.app.phone || !v.ui.phone.drawer) return "";
  // A modal dialog: the scrim takes a tap (aria-hidden — Close is the named way out), focus is moved in and kept
  // in by `phonePart` (afterPaint / onKeyDown). Slides in on insertion; leaves through `ctx.exit("drawer")`.
  return `<div class="ask-drawer-layer"${closingAttr(v.ui.closing, "drawer")}>
    <div class="ask-drawer-scrim" data-act="askPhDrawerClose" aria-hidden="true"></div>
    <div class="ask-drawer" id="ask-ph-drawer" role="dialog" aria-modal="true" aria-labelledby="ask-ph-drawer-t" data-ask-trap="drawer">
      <div class="ask-drawer-head"><h2 class="ask-drawer-t" id="ask-ph-drawer-t">Threads</h2><button type="button" class="ask-ph-hbtn" data-act="askPhDrawerClose" aria-label="Close threads">${askIcon("close", 14, null, 2.2)}</button></div>
      ${threadsView(v)}
    </div>
  </div>`;
}

// ── the composer's controls on a phone ───────────────────────────────────────

/** The mode the next question uses here: picked in the composer, else the thread's, else the person's default. */
function modeOf(v: AskView): AskMode | null {
  const st = v.ui.state.data;
  return v.ui.composer[v.where].mode ?? v.ui[v.where].thread?.mode ?? st?.defaultMode ?? null;
}
/** Auto here: picked in the composer, else the thread's; never when an admin turned Auto off. */
function autoOf(v: AskView): boolean {
  if (v.ui.state.data && !v.ui.state.data.autoAllowed) return false;
  return v.ui.composer[v.where].auto ?? v.ui[v.where].thread?.auto ?? false;
}
/** More than one mode on offer (Free and Personal have Smart only, and no switcher). */
const switchable = (v: AskView): boolean => (v.ui.state.data?.modes.length ?? 0) > 1;

/** The meta line beside the +: "Smart · Asks first" (Pro), "Asks first" / "Auto" (Free). */
export function phoneMeta(v: AskView): string {
  const auto = autoOf(v) ? "Auto" : "Asks first";
  if (!switchable(v)) return auto;
  const m = modeOf(v);
  const label = v.ui.state.data?.modes.find((x) => x.id === m)?.label;
  return label ? `${label} · ${auto}` : auto;
}

function plusMenu(v: AskView): string {
  const w = v.where;
  const st = v.ui.state.data;
  const mode = modeOf(v);
  const hint = st?.modes.find((x) => x.id === mode)?.hint ?? "";
  const autoOk = st ? st.autoAllowed : true;
  const auto = autoOf(v);
  const modeGroup = switchable(v) && st ? `<div class="ask-ph-group" role="group" aria-labelledby="ask-ph-mode-${w}">
      <div class="ask-ph-label" id="ask-ph-mode-${w}">Mode</div>
      ${segmented({ id: `ph-mode-${w}`, ariaLabel: "Mode", value: mode ?? "", act: "askPhMode", fill: true, className: "ask-ph-seg", inertOn: true,
        options: st.modes.map((m) => ({ value: m.id, label: m.label, arg: `${w}:${m.id}` })) })}
      ${hint ? `<div class="ask-ph-hint">${esc(hint)}</div>` : ""}
    </div>` : "";
  return `<div class="ask-ph-plus" id="ask-ph-plus-${w}" role="group" aria-label="More options" data-ask-plus="${w}"${closingAttr(v.ui.closing, "plus")}>
    <button type="button" class="ask-ph-row" data-act="askPhAttach" data-arg="${w}">${askIcon("phAttach", 17)}Attach a file or photo</button>
    <button type="button" class="ask-ph-row" data-act="askPhMention" data-arg="${w}">${askIcon("phAt", 17)}Mention a ticket, doc or person</button>
    <button type="button" class="ask-ph-row" data-act="askPhCommand" data-arg="${w}">${askIcon("cmd", 17)}Run a command</button>
    <div class="ask-ph-sep" role="separator"></div>
    ${modeGroup}
    <div class="ask-ph-group${autoOk ? "" : " is-off"}" role="group" aria-labelledby="ask-ph-auto-${w}">
      <div class="ask-ph-label" id="ask-ph-auto-${w}">Changes in this thread</div>
      ${segmented({ id: `ph-auto-${w}`, ariaLabel: "Changes in this thread", value: auto ? "auto" : "ask", act: "askPhAuto", fill: true, className: "ask-ph-seg", inertOn: true,
        options: [{ value: "ask", label: "Ask before changes", arg: `${w}:ask`, locked: !autoOk }, { value: "auto", label: "Auto", arg: `${w}:auto`, locked: !autoOk }] })}
      ${autoOk ? "" : `<div class="ask-ph-hint">${esc(AUTO_OFF_NOTE)}</div>`}
    </div>
  </div>`;
}

/** The composer's bottom row on a phone — the +, the meta line, Send / Stop — and the + menu above the box.
 *  The composer renders it INSIDE its box in place of the desktop toolbar ("" off a phone). The menu is
 *  positioned against `.ask-composer` (relative on a phone, trov.css). */
export function phoneComposerBar(v: AskView): string {
  if (!v.app.phone) return "";
  const w = v.where;
  const ui = v.ui.composer[w];
  const busy = v.ui[w].busy || ui.forced === "busy";
  const can = !busy && ui.text.trim().length > 0;
  const open = v.ui.phone.plus && v.ui.phone.plusAt === w;
  return `<div class="ask-ph-bar">
      <button type="button" class="ask-ph-plusbtn" data-act="askPhPlus" data-arg="${w}" aria-label="More options" aria-expanded="${open}" aria-controls="ask-ph-plus-${w}">${askIcon("plus", 18, null, 2)}</button>
      <span class="ask-ph-meta">${esc(phoneMeta(v))}</span>
      <button type="button" class="ask-ph-send${busy ? " is-busy" : can ? " is-on" : ""}" data-act="${busy ? "askCoStop" : "askCoSend"}" data-arg="${w}" aria-label="${busy ? "Stop answering" : "Send"}">${busy
        ? `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor"></rect></svg>`
        : askIcon("send", 18, null, 2.2)}</button>
    </div>${open ? plusMenu(v) : ""}`;
}

// ── acts, focus, the trap ────────────────────────────────────────────────────

/** Close the drawer through its exit (the slide out), if it is open. */
export function closeDrawer(ctx: AskCtx): void {
  if (!ctx.ui.phone.drawer) return;
  ctx.exit("drawer", () => { ctx.ui.phone.drawer = false; });
}
function closePlus(ctx: AskCtx): void {
  if (!ctx.ui.phone.plus) return;
  ctx.exit("plus", () => { ctx.ui.phone.plus = false; });
}

const whereOf = (arg: string | null): AskWhere => (arg?.startsWith("panel") ? "panel" : "page");
const doc = (): Document | null => (typeof document === "undefined" ? null : document);

/** Type `text` into the composer's box the way a person would (a real `input` event, so the composer's own
 *  handling — its @ / slash picker — runs), caret at the end. Falls back to the state when the box is gone. */
function typeInto(ctx: AskCtx, where: AskWhere, next: (cur: string) => string): void {
  const el = doc()?.querySelector<HTMLTextAreaElement>(`[data-ask-input="${where}"]`);
  const cur = el ? el.value : ctx.ui.composer[where].text;
  const val = next(cur);
  if (!el) { ctx.ui.composer[where].text = val; ctx.paint(); return; }
  el.value = val;
  el.focus();
  el.setSelectionRange(val.length, val.length);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function focusables(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest("[inert]") && el.getClientRects().length > 0);
}
/** The modal surface that holds focus right now: the drawer, else the inspector sheet. */
function trapRoot(mount: ParentNode): HTMLElement | null {
  return mount.querySelector<HTMLElement>(".ask-drawer-layer:not([data-closing]) .ask-drawer")
    ?? mount.querySelector<HTMLElement>('.ask-insp-frame[data-sheet="1"]:not([data-closing])');
}

let was = { drawer: false, plus: false, sheet: false };
let sheetReturn: HTMLElement | null = null;
let listening = false;
/** Tests: forget what the last paint showed. */
export const resetPhoneFocus = (): void => { was = { drawer: false, plus: false, sheet: false }; sheetReturn = null; };

const idle = (d: Document): boolean => !d.activeElement || d.activeElement === d.body || !d.activeElement.isConnected;

export const phonePart: AskPart = {
  code: "Ph",
  act(ctx, name, arg) {
    const where = whereOf(arg);
    switch (name) {
      case "askPhDrawer": ctx.cancelExit("drawer"); closePlus(ctx); ctx.ui.phone.drawer = true; ctx.paint(); return;
      case "askPhDrawerClose": closeDrawer(ctx); return;
      case "askPhPlus":
        if (ctx.ui.phone.plus && ctx.ui.phone.plusAt === where) { closePlus(ctx); return; }
        ctx.cancelExit("plus");
        ctx.ui.phone.plus = true; ctx.ui.phone.plusAt = where; ctx.paint(); return;
      case "askPhAttach": {
        // Synchronously, inside the tap: a file picker opens only from a person's gesture.
        const input = doc()?.querySelector<HTMLInputElement>(`[data-ask-composer="${where}"] input[type="file"]`);
        closePlus(ctx);
        if (input) input.click();
        else ctx.flash("Couldn't open the file picker. Drop or paste the file instead.");
        return;
      }
      case "askPhMention": closePlus(ctx); typeInto(ctx, where, (t) => t + (t && !/\s$/.test(t) ? " @" : "@")); return;
      case "askPhCommand": closePlus(ctx); typeInto(ctx, where, () => "/"); return;
      case "askPhMode": {
        const m = (arg ?? "").split(":")[1] as AskMode | undefined;
        if (!m || !ctx.ui.state.data?.modes.some((x) => x.id === m)) return;
        ctx.ui.composer[where].mode = m; ctx.paint(); return;
      }
      case "askPhAuto": {
        if (ctx.ui.state.data && !ctx.ui.state.data.autoAllowed) return;
        ctx.ui.composer[where].auto = (arg ?? "").endsWith(":auto"); ctx.paint(); return;
      }
    }
  },
  afterPaint(ctx, mount) {
    const d = doc();
    if (!d) return;
    if (!listening) {
      listening = true;
      // A tap outside the + menu closes it (the + itself toggles it).
      d.addEventListener("pointerdown", (e) => {
        if (!ctx.ui.phone.plus) return;
        const t = e.target as Element | null;
        if (t?.closest?.(".ask-ph-plus, .ask-ph-plusbtn")) return;
        closePlus(ctx);
      }, true);
    }
    // Back on a desktop: nothing of the phone's stays open.
    if (!ctx.app.phone && (ctx.ui.phone.drawer || ctx.ui.phone.plus)) { ctx.ui.phone.drawer = false; ctx.ui.phone.plus = false; ctx.paint(); }

    const drawer = !!mount.querySelector(".ask-drawer-layer:not([data-closing])");
    const plus = !!mount.querySelector(".ask-ph-plus:not([data-closing])");
    const sheetEl = mount.querySelector<HTMLElement>('.ask-insp-frame[data-sheet="1"]:not([data-closing])');
    const sheet = !!sheetEl;
    if (drawer && !was.drawer) focusables(mount.querySelector(".ask-drawer")!)[0]?.focus();
    if (!ctx.ui.phone.drawer && was.drawer && idle(d)) mount.querySelector<HTMLElement>('[data-act="askPhDrawer"]')?.focus();
    if (plus && !was.plus) mount.querySelector<HTMLElement>(".ask-ph-plus .ask-ph-row")?.focus({ preventScroll: true });
    if (!ctx.ui.phone.plus && was.plus && idle(d)) mount.querySelector<HTMLElement>(`[data-act="askPhPlus"][data-arg="${ctx.ui.phone.plusAt}"]`)?.focus();
    if (sheet && !was.sheet) {
      sheetReturn = d.activeElement instanceof HTMLElement && d.activeElement !== d.body ? d.activeElement : null;
      sheetEl!.querySelector<HTMLElement>('[data-act="askShClose"]')?.focus({ preventScroll: true });
    }
    if (!sheet && was.sheet && !mount.querySelector('.ask-insp-frame[data-sheet="1"]') && idle(d)) {
      (sheetReturn?.isConnected ? sheetReturn : mount.querySelector<HTMLElement>("[data-ask-input]"))?.focus({ preventScroll: true });
      sheetReturn = null;
    }
    // A closing surface still counts as shown until it is gone (its focus comes back once, after the exit).
    was = {
      drawer: drawer || (was.drawer && ctx.ui.phone.drawer),
      plus: plus || (was.plus && ctx.ui.phone.plus),
      sheet: sheet || (was.sheet && !!mount.querySelector('.ask-insp-frame[data-sheet="1"]')),
    };
  },
  onKeyDown(ctx, e) {
    if (e.key !== "Tab" || !ctx.app.phone) return false;
    const d = doc();
    const root = d && trapRoot(d);
    if (!d || !root) return false;
    const items = focusables(root);
    if (!items.length) return false;
    const at = items.indexOf(d.activeElement as HTMLElement);
    const next = at < 0 ? (e.shiftKey ? items[items.length - 1] : items[0])
      : e.shiftKey && at === 0 ? items[items.length - 1]
      : !e.shiftKey && at === items.length - 1 ? items[0]
      : null;
    if (!next) return false;         // inside, not at an end: the browser moves focus
    e.preventDefault();
    next.focus();
    return true;
  },
  escape: [
    { layer: "menu", isOpen: (ctx) => ctx.ui.phone.plus, close: (ctx) => closePlus(ctx) },
    // A thread's ⋯ menu (or its rename box) inside the drawer goes first: one Escape, one thing.
    { layer: "menu", isOpen: (ctx) => ctx.ui.phone.drawer && ctx.ui.threadMenu === null && ctx.ui.renaming === null, close: (ctx) => closeDrawer(ctx) },
  ],
};
