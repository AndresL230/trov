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

/** The nav entries that own a sub-page list — only Docs now. Roadmap, Tickets, Maintenance
 *  and Repo have none: their switches are on the screen itself (Roadmap's Narrative /
 *  Timeline, removed from the rail 2026-09-26; Tickets' Board / Table and Submit a ticket,
 *  removed 2026-09-27; Maintenance's Unplaced / Identity / People and Repo's Overview /
 *  Code / CI / Usage / Planning — each a tab bar heading the page body — removed
 *  2026-09-27). A stored `trov.navOpen` naming a retired group is simply not read back
 *  (main.ts). */
export const NAV_GROUPS = ["docs"] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];
export type NavOpen = Record<NavGroup, boolean>;
export const NAV_CLOSED: NavOpen = { docs: false };

/** The nav entry a screen lights up (a ticket lights Tickets, a sprint lights Roadmap). */
export type NavKey = "mywork" | "tickets" | "roadmap" | "handoffs" | "repo" | "feed" | "docs" | "artifacts" | "prompts" | "review" | "maintenance" | "guide" | "releases" | "org";
const NAV_OF: Record<string, NavKey> = {
  mywork: "mywork", feed: "feed", docs: "docs", roadmap: "roadmap", sprint: "roadmap", repo: "repo",
  review: "review", maintenance: "maintenance", guide: "guide", releases: "releases",
  tickets: "tickets", ticketdetail: "tickets", newticket: "tickets",
  artifacts: "artifacts", artifactnew: "artifacts", artifact: "artifacts",
  handoffs: "handoffs", handoff: "handoffs", newhandoff: "handoffs",
  prompts: "prompts", prompt: "prompts", promptedit: "prompts",
  newdoc: "docs",
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
  docSpace: string;
  docSpaces: { key: string; label: string }[];
  counts: { review: number; maintenance: number; tickets: number; handoffs: number; prompts: number };
  me: { handle: string; name: string | null; color: PersonColor; avatar_url?: string | null } | null;
  displayName: string;
  logo: string;
}

const ICON = (paths: string): string =>
  `<svg class="cnpy-nav-ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${paths}</svg>`;

const ICONS: Record<NavKey | "search" | "collapse", string> = {
  mywork: ICON(`<path d="M3 12 12 3l9 9"></path><path d="M5 10v10h14V10"></path><path d="M9 20v-6h6v6"></path>`),
  tickets: ICON(`<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"></path><path d="M13 5v2M13 11v2M13 17v2"></path>`),
  roadmap: ICON(`<path d="M5 21V4"></path><path d="M5 4.5C7 3 9 3 12 4.5s5 1.5 7 0V13c-2 1.5-4 1.5-7 0s-5-1.5-7 0"></path>`),
  handoffs: ICON(`<path d="M22 2 11 13"></path><path d="M22 2 15 22l-4-9-9-4z"></path>`),
  prompts: ICON(`<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"></path><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"></path>`),
  repo: ICON(`<path d="M6 3v12"></path><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path>`),
  feed: ICON(`<path d="M4 5h16"></path><path d="M4 12h16"></path><path d="M4 19h10"></path>`),
  docs: ICON(`<path d="M6 3h7l5 5v13H6z"></path><path d="M13 3v5h5"></path><path d="M9 13h6"></path><path d="M9 17h6"></path>`),
  artifacts: ICON(`<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18"></path><path d="M7 13.5h6"></path><path d="M7 16.5h9"></path>`),
  review: ICON(`<rect x="4" y="4" width="16" height="16" rx="3"></rect><path d="m9 12.5 2 2 4-5"></path>`),
  maintenance: ICON(`<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>`),
  guide: ICON(`<path d="M2 4h7a3 3 0 0 1 3 3v14a2.5 2.5 0 0 0-2.5-2.5H2z"></path><path d="M22 4h-7a3 3 0 0 0-3 3v14a2.5 2.5 0 0 1 2.5-2.5H22z"></path>`),
  // A sparkle: what's new.
  releases: ICON(`<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"></path><path d="M19 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"></path>`),
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

/** The sub-page a group is currently showing, or null (e.g. a ticket's detail). */
function activeSub(p: SidebarProps, g: NavGroup): string | null {
  switch (g) {
    case "docs": return p.screen === "docs" ? p.docSpace : null;
  }
}

function subPages(p: SidebarProps, g: NavGroup): { key: string; label: string }[] {
  switch (g) {
    case "docs": return p.docSpaces;
  }
}

/** Section header. Collapsed, trov.css folds it into the design's hairline divider. */
const section = (label: string, first = false): string =>
  `<div class="cnpy-sec${first ? " is-first" : ""}"><span class="cnpy-lbl">${esc(label)}</span></div>`;

export function sidebarView(p: SidebarProps): string {
  const current = navKeyOf(p.screen);

  /** Every count is the SAME badge (one pill style, one collapsed-rail dot): a number
   *  beside an entry always means "this many things are waiting there". */
  const item = (key: NavKey, act: string, label: string, count = 0): string => {
    const group = (NAV_GROUPS as readonly string[]).includes(key) ? (key as NavGroup) : null;
    const on = current === key;
    const open = group ? p.navOpen[group] : false;
    // Always emitted; `data-n="0"` hides both the count and the collapsed-rail dot.
    const marks = `<span class="cnpy-lbl cnpy-badge" data-n="${count}">${count}</span><span class="cnpy-dot" data-n="${count}"></span>`;
    const chevron = group
      ? `<button data-act="navToggle" data-arg="${group}" class="cnpy-chev" aria-label="${open ? "Hide" : "Show"} ${attr(label)} pages" aria-expanded="${open}" tabindex="${p.collapsed ? -1 : 0}">${CHEVRON}</button>`
      : "";
    const sub = group
      ? `<div class="cnpy-sub" data-open="${open ? "1" : "0"}"><div class="cnpy-sub-clip"><div class="cnpy-sub-list">${subPages(p, group).map((s) => {
          const here = activeSub(p, group) === s.key;
          return `<button data-act="navSub" data-arg="${attr(`${group}:${s.key}`)}" class="cnpy-sub-i${here ? " is-active" : ""}"${here ? ' aria-current="page"' : ""} tabindex="${open && !p.collapsed ? 0 : -1}">${esc(s.label)}</button>`;
        }).join("")}</div></div></div>`
      : "";
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
    <nav class="cnpy-navlist" aria-label="Primary">
      <div class="cnpy-searchwrap" data-tip="Search">
        <div data-act="sideSearchFocus" class="cnpy-search${p.screen === "search" ? " is-active" : ""}">
          ${ICONS.search}
          <input data-act="sideSearch" data-field="sideSearch" class="cnpy-lbl cnpy-search-in" placeholder="Search Trov" aria-label="Search Trov" autocomplete="off" spellcheck="false" tabindex="${p.collapsed ? -1 : 0}" />
          <kbd class="cnpy-lbl cnpy-kbd">${isMac() ? "⌘K" : "Ctrl K"}</kbd>
        </div>
      </div>
      ${section("Workspace", true)}
      ${item("mywork", "goMyWork", "My Work")}
      ${item("tickets", "goTickets", "Tickets", c.tickets)}
      ${item("roadmap", "goRoadmap", "Roadmap")}
      ${item("handoffs", "goHandoffs", "Handoffs", c.handoffs)}
      ${section("Monitor")}
      ${item("repo", "goRepo", "Repo")}
      ${item("feed", "goFeed", "Feed")}
      ${section("Knowledge")}
      ${item("docs", "goDocs", "Docs")}
      ${item("artifacts", "goArtifacts", "Artifacts")}
      ${item("prompts", "goPrompts", "Prompt Library", c.prompts)}
      ${section("Triage")}
      ${item("review", "goReview", "Review", c.review)}
      ${item("maintenance", "goMaintenance", "Maintenance", c.maintenance)}
      ${section("Organization")}
      ${item("org", "orgGo", "Org settings")}
      ${section("Help")}
      ${item("guide", "goGuide", "Get Started")}
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
