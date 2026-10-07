// The underline tab bar — page-level navigation between a screen's SECTIONS
// (Org settings' Integrations / Repositories / …, the Repo dashboard's, the Roadmap's): a row of text tabs on a full-width
// hairline, the picked tab marked by a 2px accent underline that sits ON the hairline.
// The hairline is the line between the tabs and the page's content. It is not
// `segmented()`: that picks a VALUE or a view inside a page (a range, Board/Table);
// this moves between the page's own sections, so it heads the page body, not the header.
//
// Motion: the underline is ONE indicator (`.cnpy-tabs-ind`) that slides to the picked tab,
// by the same FLIP as `syncSegments` — `rerender()` swaps <main>, so `syncTabBars` (run
// after every paint) remembers each bar's indicator box by its `id` and plays the slide
// from the old box to the new one. Until it runs (first paint), the picked tab draws its
// own underline, so the markup is right with no script at all. A bar new to the screen
// does not slide in. Off under prefers-reduced-motion. On a page that is patched in place
// (morph.ts `data-morph`: Org settings, Platform) the bar is the SAME element across the
// switch; its indicator is `data-keep`, so a later paint mid-slide leaves the slide running.
//
// Semantics: role="tablist" / "tab" with aria-selected and a roving tabindex (the picked
// tab is the one Tab stop); `tabPanelAttrs` labels the panel by its tab. ←/→ move between
// tabs and Home/End jump (`onTabBarKey`, wired once in main.ts); a move activates the tab
// it lands on (switching a tab is one rerender, nothing to load), and rerender restores
// focus to it by its `data-field`.
//
// Pure markup plus `tabKeyTarget`; `syncTabBars` and `onTabBarKey` are the only DOM code,
// the styles live in trov.css.

import { esc, attr } from "./ui";

export interface TabItem {
  value: string;
  /** Plain text (escaped here). */
  label: string;
  /** Pre-rendered markup after the label (a count badge, a dot). */
  trail?: string;
}

export interface TabBarProps {
  /** Stable name — the slide animates between two renders of the same id; also the
   *  prefix of each tab's and the panel's element id. */
  id: string;
  ariaLabel: string;
  value: string;
  /** The `data-act` each tab dispatches (with `data-arg` = its value). The picked tab
   *  carries none, so re-pressing it replays nothing. */
  act: string;
  tabs: TabItem[];
}

const tabId = (bar: string, value: string) => `${bar}-${value}`;
const panelId = (bar: string) => `${bar}-panel`;

export function tabBar(p: TabBarProps): string {
  const tabs = p.tabs.map((t) => {
    const on = t.value === p.value;
    return `<button type="button" role="tab" id="${attr(tabId(p.id, t.value))}" class="cnpy-tab${on ? " is-on" : ""}"${on ? "" : ` data-act="${attr(p.act)}" data-arg="${attr(t.value)}"`} aria-selected="${on}" aria-controls="${attr(panelId(p.id))}" tabindex="${on ? 0 : -1}" data-field="tab:${attr(p.id)}:${attr(t.value)}">${esc(t.label)}${t.trail ?? ""}</button>`;
  }).join("");
  return `<div class="cnpy-tabs" data-tabs="${attr(p.id)}" data-morph-key="tabs:${attr(p.id)}" role="tablist" aria-label="${attr(p.ariaLabel)}"><span class="cnpy-tabs-ind" aria-hidden="true" data-keep></span>${tabs}</div>`;
}

/** The attributes of the element the bar controls: the tab panel, labelled by the picked tab.
 *  `data-morph-key` names WHICH tab's panel it is, so a page patched in place (morph.ts) replaces
 *  the panel on a tab switch instead of patching one tab's body into another's. */
export function tabPanelAttrs(bar: string, value: string): string {
  return ` role="tabpanel" id="${attr(panelId(bar))}" aria-labelledby="${attr(tabId(bar, value))}" data-morph-key="${attr(`${panelId(bar)}:${value}`)}"`;
}

/** Where a key moves focus from tab `at` of `count`: ←/→ step (wrapping), Home/End jump;
 *  null = not a tab key. */
export function tabKeyTarget(key: string, at: number, count: number): number | null {
  if (count < 1 || at < 0 || at >= count) return null;
  if (key === "ArrowRight") return (at + 1) % count;
  if (key === "ArrowLeft") return (at - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** The bar's keyboard: move to the target tab and activate it (its click dispatches the act). */
export function onTabBarKey(e: KeyboardEvent): void {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const tab = (e.target as Element | null)?.closest?.<HTMLElement>('.cnpy-tabs > [role="tab"]');
  const bar = tab?.parentElement;
  if (!tab || !bar) return;
  const tabs = Array.from(bar.querySelectorAll<HTMLElement>(':scope > [role="tab"]'));
  const to = tabKeyTarget(e.key, tabs.indexOf(tab), tabs.length);
  if (to === null) return;
  e.preventDefault();
  if (tabs[to] === tab) return;
  tabs[to].focus();
  tabs[to].click();
}

interface Box { x: number; w: number }
const boxes = new Map<string, Box>();
/** Each bar's horizontal scroll (a phone-width bar scrolls): the swap resets it to 0. */
const scrolls = new Map<string, number>();
/** The bars already listening for their own scroll (a patched bar outlives many paints). */
const watched = new WeakSet<HTMLElement>();

/** Place every bar's underline under its picked tab, sliding from where the same bar's
 *  underline was on the previous paint. Call after each paint. */
export function syncTabBars(root: ParentNode, opts: { instant?: boolean } = {}): void {
  const reduced = typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const seen = new Set<string>();
  for (const bar of Array.from(root.querySelectorAll<HTMLElement>(".cnpy-tabs[data-tabs]"))) {
    const id = bar.dataset.tabs ?? "";
    const ind = bar.querySelector<HTMLElement>(":scope > .cnpy-tabs-ind");
    const on = bar.querySelector<HTMLElement>(":scope > .cnpy-tab.is-on");
    if (!ind || !on || !on.offsetWidth) { bar.classList.remove("is-live"); continue; }   // hidden, or nothing picked
    seen.add(id);
    // Put a scrolled bar back where it was, then keep the picked tab in view.
    const left = scrolls.get(id) ?? 0;
    if (bar.scrollWidth > bar.clientWidth) {
      const min = on.offsetLeft + on.offsetWidth - bar.clientWidth;
      bar.scrollLeft = Math.min(Math.max(left, min), on.offsetLeft);
    }
    scrolls.set(id, bar.scrollLeft);
    if (!watched.has(bar)) {
      watched.add(bar);
      bar.addEventListener("scroll", () => scrolls.set(id, bar.scrollLeft), { passive: true });
    }
    const next: Box = { x: on.offsetLeft, w: on.offsetWidth };
    const place = (b: Box) => {
      ind.style.transform = `translateX(${b.x}px)`;
      ind.style.width = `${b.w}px`;
    };
    const prev = boxes.get(id);
    const moved = prev && (prev.x !== next.x || prev.w !== next.w);
    if (moved && !reduced && !opts.instant) {
      ind.classList.remove("is-sliding");
      place(prev);
      bar.classList.add("is-live");
      void ind.offsetWidth;            // commit the old box before the transition starts
      ind.classList.add("is-sliding");
      place(next);
    } else {
      place(next);
      bar.classList.add("is-live");
    }
    boxes.set(id, next);
  }
  // A bar that left the screen starts fresh when it comes back — no slide on entry.
  for (const id of Array.from(boxes.keys())) if (!seen.has(id)) { boxes.delete(id); scrolls.delete(id); }
}
