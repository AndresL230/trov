// ── The site's menu (under 900px): opening, closing, keys, focus ─────────────
// landing.ts draws the menu (`menuSheet`, a root-level `data-overlay="sitemenu"`) from
// `state.siteMenu`; this module is everything around that render. Under 900px the nav's section
// links, GitHub, the theme toggle and Sign in leave the bar, and the menu button opens them as a
// sheet: along the bottom edge on a phone (the app's rule for every modal), a card under the button
// on a tablet.
//
//   • open  — the page's scroll is locked (the width its scrollbar took is handed back as padding,
//             as the tour's dialog does), focus goes to the first section link.
//   • close — the scroll is unlocked AT ONCE (a section link scrolls the page while the sheet is
//             still leaving), the sheet plays its exit (`data-closing`, MENU_EXIT_MS = `--fx-fast`)
//             and is then removed; focus returns to the menu button. `instant` skips the exit: the
//             sign-in sheet is about to stand where the menu was.
//   • keys  — Esc closes, Tab stays inside.
//   • a window grown past 900px has no menu button: the menu closes.
//
// The page behind is `data-morph="landing"`, so every repaint here patches it: nothing is rebuilt
// and no reveal replays. Motion is the site's one clock (`--fx-*`, trov.css) and off under reduced motion.

import { FX_EXIT_MS, trapIndex } from "./site-feature-core";

/** Exit animation length. MUST match `--fx-fast` in trov.css (the tour dialog's own exit). */
export const MENU_EXIT_MS = FX_EXIT_MS;
/** The widest window that has a menu button. MUST match the `max-width:900px` rules in trov.css. */
export const MENU_MAX_WIDTH = 900;

export interface MenuDeps {
  mount: HTMLElement;
  get(): boolean;
  set(open: boolean): void;
  rerender(): void;
}

export function createMenuCtl(d: MenuDeps) {
  let closing = 0;
  let unlock: (() => void) | null = null;
  const overlay = () => d.mount.querySelector<HTMLElement>('[data-overlay="sitemenu"]');
  const button = () => d.mount.querySelector<HTMLElement>('[data-act="openSiteMenu"]');
  const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const lock = (): void => {
    if (unlock) return;
    const root = document.documentElement;
    const [o, p] = [root.style.overflow, root.style.paddingRight];
    const bar = innerWidth - root.clientWidth;
    root.style.overflow = "hidden";
    if (bar > 0) root.style.paddingRight = `${bar}px`;
    unlock = () => { root.style.overflow = o; root.style.paddingRight = p; unlock = null; };
  };

  function open(): void {
    if (d.get()) return;
    clearTimeout(closing);
    closing = 0;
    lock();
    d.set(true);
    d.rerender();
    overlay()?.querySelector<HTMLElement>(".site-menu-link")?.focus({ preventScroll: true });
  }

  /** `instant`: no exit (another sheet takes its place). `refocus`: hand focus back to the menu button. */
  function close(opts: { instant?: boolean; refocus?: boolean } = {}): void {
    if (!d.get()) return;
    const hide = () => {
      closing = 0;
      if (!d.get()) return;
      d.set(false);
      d.rerender();
      if (opts.refocus !== false) button()?.focus({ preventScroll: true });
    };
    unlock?.();
    clearTimeout(closing);
    if (opts.instant || reduced()) { hide(); return; }
    overlay()?.setAttribute("data-closing", "");
    // A timer, not animationend: an animation that never runs (a hidden tab) emits no event.
    closing = window.setTimeout(hide, MENU_EXIT_MS);
  }

  /** Document keydown while the menu is open: Esc closes, Tab stays inside. */
  function onKey(e: KeyboardEvent): void {
    if (!d.get()) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    const sheet = overlay()?.querySelector<HTMLElement>(".site-menu-sheet");
    if (e.key !== "Tab" || !sheet) return;
    const list = Array.from(sheet.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]"));
    const to = list[trapIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey)];
    if (!to) return;
    e.preventDefault();
    to.focus();
  }

  /** The window was resized: past the last width with a menu button, the menu has nothing to belong to. */
  function onResize(): void {
    if (d.get() && innerWidth > MENU_MAX_WIDTH) close({ instant: true, refocus: false });
  }

  return { open, close, onKey, onResize };
}
