// The dropdown — THE one component for "pick one of a short, fixed list" where a segmented
// switch has no room (a role, a cadence, an hour). Never a native <select>: that opens the
// operating system's own popup, which is not in the app's style and cannot animate.
//
// Two pieces of markup, both pure:
//  • `dropdown(p, ui)` — the TRIGGER: a button at a field's height showing the current choice
//    and a caret (`aria-haspopup="listbox"`, `aria-expanded`).
//  • `dropdownMenu(list, ui)` — the open one's MENU, rendered at the app ROOT as a `data-overlay`
//    (like the org switcher's menu), so no `overflow:hidden` ancestor can clip it and morph.ts
//    keeps it — and its focus — across rerenders. A `role="listbox"` of `.cnpy-menurow` options,
//    the current one check-marked; an option may carry a one-line `hint`.
// A screen renders the trigger where the control sits and passes the SAME props to
// `dropdownMenu` among its root overlays.
//
// Motion, by the filter menu's rules (filter-menu.ts): the entrance (`cnpy-lkpop`, from the
// trigger's corner) plays ONLY on the paint that opens it (`ui.opening`), so a later rerender
// never replays it; EVERY close — a pick, Escape, a click outside, Tab — goes through
// `ui.closing` (`data-closing` plays the exit) before the state flips. Off under
// prefers-reduced-motion.
//
// `createDropdowns` is the only DOM code: it opens and closes, places the menu against its
// trigger after every paint (under it, or above when there is no room; never off screen), and
// owns the keyboard. A pick is dispatched as the dropdown's own act with the option as `value`
// — exactly what a <select>'s `change` dispatched. The styles live in trov.css.

import { esc, attr } from "./ui";

export interface DropdownOption {
  value: string;
  /** Plain text (escaped here). */
  label: string;
  /** The trigger's text while this is picked, when it differs from the row's ("As member"). */
  shown?: string;
  /** One short line under the label: what picking it means. */
  hint?: string;
}

export interface DropdownProps {
  /** Unique on the page: the trigger's DOM id and `data-field`, and its name in `DropdownUi`. */
  id: string;
  /** The `data-act` a pick dispatches, with the option's value as `value` (and `arg`). */
  act: string;
  arg?: string;
  value: string;
  options: DropdownOption[];
  /** What the control is, when no visible label names it. */
  ariaLabel?: string;
  /** The id of its visible label (an element, not a <label for>: a click there must not open it). */
  labelledBy?: string;
  /** Shown but not pickable: dimmed, no act, never opens. */
  disabled?: boolean;
  /** md = a form field (36px), sm = inline in a row (30px). */
  size?: "md" | "sm";
  /** Stretch across the parent (a form field). */
  fill?: boolean;
}

/** Which dropdown is open — ONE at a time, app-wide (`state.dd`). */
export interface DropdownUi {
  /** The open dropdown's id. */
  open: string | null;
  /** This paint opens it: play the entrance. Cleared right after that paint. */
  opening: boolean;
  /** It is on its way out: the exit plays, then `open` clears. */
  closing: boolean;
}
export const initialDropdownUi = (): DropdownUi => ({ open: null, opening: false, closing: false });

/** The exit's length (trov.css `cnpy-dd-out`), after which the menu leaves the DOM. */
export const DD_CLOSE_MS = 120;

const CARET = `<svg class="cnpy-dd-caret" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>`;
const CHECK = `<svg class="cnpy-dd-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>`;

const isOpen = (p: DropdownProps, ui: DropdownUi): boolean => !p.disabled && ui.open === p.id;

/** The trigger. Disabled it is a really disabled button: no act, not a way into a menu. */
export function dropdown(p: DropdownProps, ui: DropdownUi): string {
  const cur = p.options.find((o) => o.value === p.value);
  const text = cur ? cur.shown ?? cur.label : "";
  // Expanded only while it is really open: on its way out the trigger is already at rest.
  const open = isOpen(p, ui) && !ui.closing;
  const name = p.labelledBy ? ` aria-labelledby="${attr(`${p.labelledBy} ${p.id}`)}"` : p.ariaLabel ? ` aria-label="${attr(`${p.ariaLabel}: ${text}`)}"` : "";
  const cls = `cnpy-dd${p.size === "sm" ? " is-sm" : ""}${p.fill ? " is-fill" : ""}${open ? " is-open" : ""}`;
  return `<button type="button" id="${attr(p.id)}" data-field="${attr(p.id)}" data-dd="${attr(p.id)}"${p.disabled ? " disabled" : ` data-act="ddToggle" data-arg="${attr(p.id)}"`} class="${cls}" style="border-radius:8px" aria-haspopup="listbox" aria-expanded="${open}"${open ? ` aria-controls="${attr(`${p.id}-menu`)}"` : ""}${name}><span class="cnpy-dd-v">${esc(text)}</span>${CARET}</button>`;
}

/** The open dropdown's menu among `list` (a screen's dropdowns), as a root-level overlay — or "". */
export function dropdownMenu(list: readonly DropdownProps[], ui: DropdownUi): string {
  const p = list.find((x) => isOpen(x, ui));
  if (!p) return "";
  const name = p.labelledBy ? ` aria-labelledby="${attr(p.labelledBy)}"` : p.ariaLabel ? ` aria-label="${attr(p.ariaLabel)}"` : "";
  const rows = p.options.map((o) => {
    const on = o.value === p.value;
    return `<button type="button" role="option" aria-selected="${on}" tabindex="-1" data-act="ddPick" data-arg="${attr(o.value)}" data-dd-opt class="cnpy-menurow cnpy-dd-opt${on ? " is-on" : ""}" style="border-radius:7px">
        <span class="cnpy-dd-optt"><span class="cnpy-dd-optl">${esc(o.label)}</span>${o.hint ? `<span class="cnpy-dd-opth">${esc(o.hint)}</span>` : ""}</span>${CHECK}
      </button>`;
  }).join("");
  return `<div data-overlay="dd-${attr(p.id)}" class="cnpy-dd-layer"${ui.closing ? " data-closing" : ""}>
    <div data-act="ddClose" class="cnpy-dd-back" aria-hidden="true"></div>
    <div id="${attr(`${p.id}-menu`)}" role="listbox"${name} tabindex="-1" data-dd-pop="${attr(p.id)}" data-dd-act="${attr(p.act)}"${p.arg !== undefined ? ` data-dd-arg="${attr(p.arg)}"` : ""} data-dd-value="${attr(p.value)}" class="cnpy-dd-pop cnpy-scroll${ui.opening ? " is-opening" : ""}" style="border-radius:11px">${rows}</div>
  </div>`;
}

// ── the controller ───────────────────────────────────────────────────────────

export interface DropdownHost {
  state: { dd: DropdownUi };
  mount: HTMLElement;
  rerender(): void;
  /** main.ts's one dispatcher: a pick is the dropdown's own act, with the option as `value`. */
  dispatch(act: string, arg: string | null, value: string | null): void;
}

export interface Dropdowns {
  /** `ddToggle` (arg = the dropdown's id), `ddPick` (arg = the option's value), `ddClose`. */
  act(act: string, arg: string | null): void;
  /** After every paint: place the open menu against its trigger; drop one whose trigger is gone. */
  afterPaint(): void;
}

/** Gap between the trigger and its menu, and the menu's margin from the viewport's edges. */
const GAP = 6;
const EDGE = 8;
/** A long list (the 24 hours) scrolls past this — the sprint picker's cap (trov.css sets the same). */
const MAX_HEIGHT = 298;

export function createDropdowns(h: DropdownHost): Dropdowns {
  const { mount } = h;
  const ui = (): DropdownUi => h.state.dd;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const reducedMotion = (): boolean => typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const triggerOf = (id: string) => mount.querySelector<HTMLElement>(`[data-dd="${id}"]`);
  const popOf = (id: string) => mount.querySelector<HTMLElement>(`[data-dd-pop="${id}"]`);
  const stop = (): void => { if (timer !== null) { clearTimeout(timer); timer = null; } };

  function open(id: string): void {
    const u = ui();
    if (u.open === id && !u.closing) return;
    stop();
    u.open = id; u.closing = false; u.opening = true;
    h.rerender();
    u.opening = false;
    // Onto the current choice (or the first row): the arrows move from there.
    const pop = popOf(id);
    (pop?.querySelector<HTMLElement>('[aria-selected="true"]') ?? pop?.querySelector<HTMLElement>("[data-dd-opt]"))?.focus();
  }

  /** The state flips only here, once the exit has played. */
  function finish(): void {
    stop();
    const u = ui();
    if (!u.open) return;
    u.open = null; u.opening = false; u.closing = false;
    h.rerender();
  }

  /** EVERY way out: mark it closing (the exit plays), hand focus back to the trigger, then
   *  finish. `then` (a pick's dispatch) runs first, so the new value shows as the menu leaves. */
  function close(then?: () => void): void {
    const u = ui();
    const id = u.open;
    if (!id || u.closing) return;
    u.closing = true; u.opening = false;
    then?.();
    h.rerender();
    triggerOf(id)?.focus();
    if (reducedMotion()) finish();
    else timer = setTimeout(finish, DD_CLOSE_MS);
  }

  function act(name: string, arg: string | null): void {
    const u = ui();
    if (name === "ddToggle") {
      if (!arg) return;
      if (u.open === arg && !u.closing) close(); else open(arg);
      return;
    }
    if (name === "ddClose") { close(); return; }
    if (name !== "ddPick" || !u.open || u.closing || arg === null) return;
    const pop = popOf(u.open);
    const pick = pop?.dataset.ddAct;
    if (!pop || !pick) { close(); return; }
    // Re-picking the current choice changes nothing: it only closes.
    close(pop.dataset.ddValue === arg ? undefined : () => h.dispatch(pick, pop.dataset.ddArg ?? null, arg));
  }

  /** Under the trigger, left edges aligned; above it when it does not fit below and there is
   *  more room there; pulled in from the viewport's edges. `offset*` sizes, so the entrance's
   *  scale does not skew them. */
  function place(): void {
    const id = ui().open;
    if (!id) return;
    const t = triggerOf(id), pop = popOf(id);
    if (!t || !pop) return;
    const r = t.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const s = pop.style;
    const scrolled = pop.scrollTop;
    s.minWidth = `${Math.round(r.width)}px`;
    s.maxHeight = "";
    const w = pop.offsetWidth, height = pop.offsetHeight;
    const below = vh - r.bottom - GAP - EDGE, above = r.top - GAP - EDGE;
    const up = height > below && above > below;
    s.maxHeight = `${Math.max(96, Math.min(MAX_HEIGHT, Math.floor(up ? above : below)))}px`;
    // A menu wider than its trigger hangs from the trigger's right edge in the right half of
    // the window, so it opens toward the page, not off its card.
    const right = r.left + w > vw - EDGE || (w > r.width + 1 && r.left + r.width / 2 > vw / 2);
    const left = Math.round(Math.max(EDGE, Math.min(right ? r.right - w : r.left, vw - EDGE - w)));
    s.left = `${left}px`;
    s.top = up ? "auto" : `${Math.round(r.bottom + GAP)}px`;
    s.bottom = up ? `${Math.round(vh - r.top + GAP)}px` : "auto";
    pop.dataset.side = up ? "up" : "down";
    // The corner it grows from is the one nearest the trigger, wherever the edges pushed it.
    pop.dataset.align = r.left + r.width / 2 > left + w / 2 + 1 ? "right" : "left";
    pop.scrollTop = scrolled;
  }

  function afterPaint(): void {
    const u = ui();
    if (!u.open) return;
    const t = triggerOf(u.open), pop = popOf(u.open);
    if (t && pop) { place(); return; }
    // Its trigger left the screen (a tab switch, an editor closing, another page) or went
    // disabled under it: the menu goes with it, at once.
    stop();
    u.open = null; u.opening = false; u.closing = false;
    if (pop) { pop.closest("[data-overlay]")?.remove(); h.rerender(); }
  }

  // The keyboard. Closed: ↓ / ↑ on a trigger open it (Enter / Space are the button's own
  // click). Open: ↑ / ↓ / Home / End move, a letter jumps to the next option starting with it,
  // Enter / Space pick (the focused option's own click), Escape closes onto the trigger, and
  // Tab closes and moves on from the trigger.
  document.addEventListener("keydown", (e) => {
    const u = ui();
    if (!u.open || u.closing) {
      if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = (e.target as Element | null)?.closest?.<HTMLElement>("[data-dd]:not([disabled])");
      if (!t?.dataset.dd) return;
      e.preventDefault();
      open(t.dataset.dd);
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "Tab") { close(); return; }
    const pop = popOf(u.open);
    if (!pop) return;
    const items = Array.from(pop.querySelectorAll<HTMLElement>("[data-dd-opt]"));
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : at < 0 ? (e.key === "ArrowDown" ? 0 : items.length - 1) : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next].focus();
      return;
    }
    if (e.key.length !== 1 || e.key === " " || e.altKey || e.ctrlKey || e.metaKey) return;
    const letter = e.key.toLowerCase();
    for (let i = 1; i <= items.length; i++) {
      const item = items[(Math.max(at, -1) + i + items.length) % items.length];
      if ((item.querySelector(".cnpy-dd-optl")?.textContent ?? "").trim().toLowerCase().startsWith(letter)) { e.preventDefault(); item.focus(); return; }
    }
  }, true);
  // The menu is fixed to the viewport: follow its trigger when the page scrolls or resizes.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("scroll", (e) => { if (!(e.target instanceof Element && e.target.closest("[data-dd-pop]"))) place(); }, true);
    window.addEventListener("resize", place);
  }

  return { act, afterPaint };
}
