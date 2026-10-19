// The app sidebar — ported from the Claude Design `Canopy Repo Dashboard.dc.html`
// shell. Purely presentational: props in, markup out.
//
// ONE RULE shapes this file: the structure is STABLE. Every label, badge, chevron
// and sub-page list is always emitted, and the collapsed / closed / inactive
// states are expressed as attributes and classes that trov.css animates. The
// <aside> survives rerenders (web/src/morph.ts patches it in place), so a state
// change becomes an attribute flip on a living element — which is the only thing
// a CSS transition can run on. Emitting a node conditionally would swap it out
// from under its own animation.

import type { PersonColor } from "@shared/rows";
import { esc, attr } from "./ui";
import { personChip, handleTag } from "./people";
import { spaceTile } from "./library";

/** The Library group's Imports row (a clock with a back arrow) and its Import action (the upload arrow). */

/** The nav entries that own a sub-page list — only the Library now (its spaces). Roadmap, Tickets and Repo have
 *  none: their switches are on the screen itself (Roadmap's Narrative / Timeline, removed
 *  from the rail 2026-09-26; Tickets' Board / Table and Submit a ticket, removed 2026-09-27;
 *  Repo's Overview / Code / CI / Usage / Planning — a tab bar heading the page body —
 *  removed 2026-09-27). Unplaced (the `maintenance` key: it was Maintenance, with Identity and
 *  People tabs that moved into Org settings 2026-10-06) is one queue. The Library was Docs, with a
 *  fixed Technical / Product pair, until the spaces (2026-10): a stored `trov.navOpen` `docs` key is read
 *  as `library` (main.ts); any other retired group is simply not read back. */
export const NAV_GROUPS = ["library"] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];
export type NavOpen = Record<NavGroup, boolean>;
export const NAV_CLOSED: NavOpen = { library: false };

/** The nav entry a screen lights up (a ticket lights Tickets, a sprint lights Roadmap). */
export type NavKey = "home" | "mywork" | "ask" | "tickets" | "roadmap" | "handoffs" | "repo" | "feed" | "library" | "artifacts" | "prompts" | "review" | "maintenance" | "guide" | "releases" | "platform" | "org";
const NAV_OF: Record<string, NavKey> = {
  home: "home", mywork: "mywork", ask: "ask", feed: "feed", roadmap: "roadmap", sprint: "roadmap", repo: "repo",
  review: "review", maintenance: "maintenance", guide: "guide", releases: "releases",
  tickets: "tickets", ticketdetail: "tickets", newticket: "tickets",
  artifacts: "artifacts", artifactnew: "artifacts", artifact: "artifacts",
  relay: "handoffs", handoffs: "handoffs", handoff: "handoffs", newhandoff: "handoffs", links: "handoffs", link: "handoffs",
  prompts: "prompts", prompt: "prompts", promptedit: "prompts",
  // The Library: its home, a space's home, a doc (the reader), New page, the import wizard and Imports history.
  library: "library", space: "library", docs: "library", newdoc: "library", import: "library", imports: "library",
  platform: "platform", platformorg: "platform",
  org: "org",
};
export const navKeyOf = (screen: string): NavKey | null => NAV_OF[screen] ?? null;
/** The group whose sub-pages a screen belongs to, or null. */
export const navGroupOf = (screen: string): NavGroup | null => {
  const k = navKeyOf(screen);
  return k && (NAV_GROUPS as readonly string[]).includes(k) ? (k as NavGroup) : null;
};

export interface SidebarProps {
  screen: string;
  collapsed: boolean;
  navOpen: NavOpen;
  qView: "table" | "board";
  roadmapTab: "narrative" | "timeline";
  /** The space the screen is in (a space's home, a doc, New page), or null. */
  librarySpace: string | null;
  /** The spaces this person's sidebar shows (at most five): their own pick and order, else the first five in the
   *  Library's order (shared/docs-core.ts `sidebarSpaces`). */
  spaces: { key: string; label: string; icon: string; color: string }[];
  /** The spaces read has answered (so an empty list means "no spaces yet", not "not known yet"). */
  spacesLoaded: boolean;
  /** An admin of the org: the group ends with "+ New space". */
  canAdmin: boolean;
  /** `imports` — Markdown imports in progress (not drawn in the sidebar any more; absent = none). */
  counts: { review: number; maintenance: number; tickets: number; handoffs: number; prompts: number; imports?: number };
  me: { handle: string; name: string | null; color: PersonColor; avatar_url?: string | null } | null;
  displayName: string;
  logo: string;
  /** The org switcher's button (org-picker.ts `orgSwitcherButton`), under the logo. Its menu holds
   *  Org settings, so the rail has no Organization section of its own. */
  orgSwitcher?: string;
  /** Org settings is the screen showing: the switcher reads as the current place. */
  orgActive?: boolean;
}

const ICON = (paths: string): string =>
  `<svg class="cnpy-nav-ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS: Record<NavKey | "search" | "collapse", string> = {
  // The house is Home (the design `Trov Overview v2`); My Work, now a view of its own, is a briefcase.
  home: ICON(`<path d="M3 10.5 12 3l9 7.5"></path><path d="M5 9v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9"></path>`),
  mywork: ICON(`<rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path><path d="M3 12.5h18"></path>`),
  // A constellation: Ask Trov (the design's `askGraph`; ask-icons.ts holds the same path).
  ask: ICON(`<circle cx="12" cy="12" r="2.6"></circle><circle cx="5" cy="5.5" r="1.9"></circle><circle cx="19" cy="6.5" r="1.9"></circle><circle cx="17.5" cy="19" r="1.9"></circle><circle cx="5.5" cy="17.5" r="1.9"></circle><path d="M10 10.2 6.4 6.9M14.2 10.7l3.3-2.7M13.6 14.1l2.7 3.3M10 13.8l-3.1 2.4"></path>`),
  tickets: ICON(`<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"></path><path d="M13 5v2M13 11v2M13 17v2"></path>`),
  roadmap: ICON(`<path d="M5 21V4"></path><path d="M5 4.5C7 3 9 3 12 4.5s5 1.5 7 0V13c-2 1.5-4 1.5-7 0s-5-1.5-7 0"></path>`),
  handoffs: ICON(`<path d="M16 3l4 4-4 4"></path><path d="M20 7H4"></path><path d="M8 21l-4-4 4-4"></path><path d="M4 17h16"></path>`),
  prompts: ICON(`<path d="M16 18l6-6-6-6"></path><path d="M8 6l-6 6 6 6"></path>`),
  repo: ICON(`<path d="M6 3v12"></path><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path>`),
  feed: ICON(`<path d="M4 5h16"></path><path d="M4 12h16"></path><path d="M4 19h10"></path>`),
  library: ICON(`<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"></path><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"></path>`),
  artifacts: ICON(`<path d="M12 2 2 7l10 5 10-5-10-5z"></path><path d="M2 17l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path>`),
  review: ICON(`<rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="m9 12 2 2 4-4"></path>`),
  // An inbox tray: the Unplaced queue (the key is still `maintenance`).
  maintenance: ICON(`<path d="M22 12h-6l-2 3h-4l-2-3H2"></path><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>`),
  guide: ICON(`<circle cx="12" cy="12" r="9"></circle><path d="M9.5 9.5a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.4-2.5 2.4"></path><circle cx="12" cy="16.6" r=".4" fill="currentColor"></circle>`),
  // A sparkle: what's new.
  releases: ICON(`<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"></path><path d="M19 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"></path>`),
  // A globe: the whole platform, every organization.
  platform: ICON(`<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"></path>`),
  // A building: the org's own settings.
  org: ICON(`<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"></path><path d="M16 9h2a2 2 0 0 1 2 2v10"></path><path d="M2 21h20"></path><path d="M8 7h4M8 11h4M8 15h4"></path>`),
  search: `<svg class="cnpy-nav-ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path></svg>`,
  // Drawn in its "expanded" pose; trov.css mirrors it (scaleX(-1)) when collapsed,
  // which is exactly the design's second icon — so the swap is a flip, not a cut.
  collapse: ICON(`<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M9 4v16"></path><path d="M14.5 9.5 12 12l2.5 2.5"></path>`),
};

const GEAR = `<svg class="cnpy-lbl" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" style="flex:none" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

const CHEVRON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>`;

/** ⌘K on Apple hardware, Ctrl K elsewhere. Guarded: render also runs under vitest. */
const isMac = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform ?? "");

/** The sub-page a group is currently showing, or null (e.g. Library home). */
function activeSub(p: SidebarProps, g: NavGroup): string | null {
  switch (g) {
    case "library": return p.screen === "space" || p.screen === "docs" || p.screen === "newdoc" ? p.librarySpace : null;
  }
}

/** Section header. Collapsed, trov.css folds it into the design's hairline divider. */
const section = (label: string, first = false): string =>
  `<div class="cnpy-sec${first ? " is-first" : ""}"><span class="cnpy-lbl">${esc(label)}</span></div>`;

export function sidebarView(p: SidebarProps): string {
  const current = navKeyOf(p.screen);

  /** A group's sub-page list. The Library's: one row per space the person's sidebar shows (at most five; its tile
   *  and name; a file-drop target, §10), then — always emitted, shown by attribute — "No spaces yet" with one hollow
   *  row (the read answered with none). Nothing else: the Library row opens Library home, which holds Customize
   *  sidebar, New space and Import; a space's "…" menu and the import screen hold the rest. The space rows follow
   *  the DATA; nothing in the list comes and goes with a UI state. */
  const subList = (g: NavGroup, open: boolean): string => {
    const tab = `tabindex="${open && !p.collapsed ? 0 : -1}"`;
    const here = activeSub(p, g);
    const rows = p.spaces.map((s) => {
      const on = here === s.key;
      return `<button data-act="navSub" data-arg="${attr(`${g}:${s.key}`)}" class="cnpy-sub-i cnpy-sub-sp${on ? " is-active" : ""}"${on ? ' aria-current="page"' : ""} ${tab} data-drop-space="${attr(s.key)}">${spaceTile(s, 14)}<span class="cnpy-sub-n">${esc(s.label)}</span></button>`;
    }).join("");
    const none = `<div class="cnpy-sub-none"${p.spacesLoaded && p.spaces.length === 0 ? "" : " hidden"}>No spaces yet<div class="cnpy-sub-ghost" aria-hidden="true"><span></span><span></span></div></div>`;
    return `${rows}${none}`;
  };

  /** Every count is the SAME badge (one pill style, one collapsed-rail dot): a number
   *  beside an entry always means "this many things are waiting there". */
  const item = (key: NavKey, act: string, label: string, count = 0): string => {
    const group = (NAV_GROUPS as readonly string[]).includes(key) ? (key as NavGroup) : null;
    const on = current === key;
    const open = group ? p.navOpen[group] : false;
    // Always emitted; `data-n="0"` hides both the count and the collapsed-rail dot.
    const marks = `<span class="cnpy-lbl cnpy-badge" data-n="${count}">${count}</span><span class="cnpy-dot" data-n="${count}"></span>`;
    const chevron = group
      ? `<button data-act="navToggle" data-arg="${group}" class="cnpy-chev" aria-label="Show or hide spaces" aria-expanded="${open}" tabindex="${p.collapsed ? -1 : 0}">${CHEVRON}</button>`
      : "";
    const sub = group ? `<div class="cnpy-sub" data-open="${open ? "1" : "0"}"><div class="cnpy-sub-clip"><div class="cnpy-sub-list">${subList(group, open)}</div></div></div>` : "";
    return `<div class="cnpy-navrow n-${key}${on ? " is-active" : ""}" data-tip="${attr(label)}">
      <button data-act="${act}" class="cnpy-nav-i" aria-label="${attr(label)}"${on ? ' aria-current="page"' : ""}>${ICONS[key]}<span class="cnpy-lbl cnpy-nav-t">${esc(label)}</span>${marks}</button>${chevron}
    </div>${sub}`;
  };

  const c = p.counts;
  const chipPerson = p.me ? { handle: p.me.handle, name: p.displayName || p.me.name, color: p.me.color, avatar_url: p.me.avatar_url } : null;

  return `<aside class="cnpy-aside" data-screen-label="Sidebar">
    <div class="cnpy-logo">
      <button data-act="goSite" aria-label="About Trov" data-tip="About Trov" class="cnpy-logo-b">${p.logo}<span class="cnpy-lbl cnpy-logo-t">Trov</span></button>
    </div>
    <div class="cnpy-orgslot${p.orgActive ? " is-active" : ""}">${p.orgSwitcher ?? ""}</div>
    <nav class="cnpy-navlist" aria-label="Primary">
      <div class="cnpy-searchwrap" data-tip="Search">
        <div data-act="sideSearchFocus" class="cnpy-search${p.screen === "search" ? " is-active" : ""}">
          ${ICONS.search}
          <input data-act="sideSearch" data-field="sideSearch" class="cnpy-lbl cnpy-search-in" placeholder="Search Trov" aria-label="Search Trov" autocomplete="off" spellcheck="false" tabindex="${p.collapsed ? -1 : 0}" />
          <kbd class="cnpy-lbl cnpy-kbd">${isMac() ? "⌘K" : "Ctrl K"}</kbd>
        </div>
      </div>
      ${section("Workspace", true)}
      ${item("home", "goHome", "Home")}
      ${item("mywork", "goMyWork", "My Work")}
      ${item("ask", "goAsk", "Trov")}
      ${item("tickets", "goTickets", "Tickets", c.tickets)}
      ${item("roadmap", "goRoadmap", "Roadmap")}
      ${item("handoffs", "goRelay", "Relay", c.handoffs)}
      ${section("Monitor")}
      ${item("repo", "goRepo", "Repo")}
      ${item("feed", "goFeed", "Feed")}
      ${section("Knowledge")}
      ${item("library", "goLibrary", "Library")}
      ${item("artifacts", "goArtifacts", "Artifacts")}
      ${item("prompts", "goPrompts", "Prompt Library", c.prompts)}
      ${section("Triage")}
      ${item("review", "goReview", "Review", c.review)}
      ${item("maintenance", "goMaintenance", "Unplaced", c.maintenance)}
      ${section("Help")}
      ${item("guide", "goGuide", "Guide")}
      ${item("releases", "goReleases", "What's new")}
    </nav>
    <div class="cnpy-collapse" data-tip="Expand sidebar">
      <button data-act="toggleCollapse" class="cnpy-nav-i" aria-label="${p.collapsed ? "Expand sidebar" : "Collapse sidebar"}" aria-expanded="${!p.collapsed}">${ICONS.collapse}<span class="cnpy-lbl cnpy-nav-t">Collapse</span></button>
    </div>
    <div class="cnpy-ghost cnpy-lbl">agents produce · humans confirm</div>
    <div class="cnpy-foot" data-tip="Settings">
      <button data-act="goSettings" aria-label="Settings" class="cnpy-chip">
        ${personChip(chipPerson, 28, p.me?.handle ?? "?")}
        <div class="cnpy-lbl cnpy-chip-t"><div class="cnpy-chip-n">${esc(p.displayName || (p.me?.handle ?? ""))}</div><div class="cnpy-chip-h">${p.me ? handleTag({ handle: p.me.handle, color: p.me.color }, p.me.handle, 11) : handleTag(null, "", 11)}</div></div>
        ${GEAR}
      </button>
    </div>
    <div class="cnpy-tip" role="tooltip" data-keep></div>
  </aside>`;
}
