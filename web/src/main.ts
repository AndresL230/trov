// App entry: holds the single in-memory state, mounts the UI, dispatches DOM
// events to state changes, and loads real data per screen from the cookie-gated
// routes via ./api. Wiring proceeds screen by screen (Phase 2); unwired screens
// still render their Phase-1 mock until their task lands.

import "./trov.css";
import { migrateBrowserStorage } from "./storage-migrate";
import { openLightbox, closeLightbox } from "./lightbox";
import { syncSegments } from "./segmented";
import { syncTabBars, onTabBarKey } from "./tabs";
import { syncFavicon } from "./favicon";
import { MW_REPO_TABS, type MwRepoTab } from "./mywork";
import {
  render, initialState, railCollapsed, spaceLabel, HAPPENINGS_LIMIT, firstDocForSpace, docReaderHtml, browserConnectCommand, PLUGIN_INSTALL, viewerIsAdmin,
  FEED_FILTER_CATS, type AppState, type Screen, type FeedFilterCat, type ToastAction,
} from "./render";
import {
  getFeed, getFeedStats, listDocs, listDocMeta, getDoc, search, quickSearch, getRoadmap, getMyDashboard, getRepoDashboard,
  completeSprint, deleteSprint,
  listStagedProposals, listAdrs, promoteDoc, rejectDoc, ratifyAdr, rejectAdr,
  listNeedsTriage, listIdentityTasks, assignTriage, discardTriage, mapIdentity, discardIdentity, restoreIdentity, type AssignTarget,
  getMe, logout, adminBackfill, adminPoll, isRateLimited, rateLimitText,
  getOnboardPrefill, checkHandle, submitOnboard,
  getNotificationPrefs, putNotificationPrefs, getNotificationPolicy, putNotificationPolicy,
  getNotificationSettings, putNotificationSettings, listNotificationOutbox, testSendNotification, type PrefsWrite,
  listOAuthGrants, revokeOAuthGrant,
  listPersons, updateMe, unlinkIdentity, renameHandle,
  getPersonProfile, uploadAvatar, removeAvatar,
  getMyOrgs, getOrgMe, listMcpTokens, revokeMcpToken, setApiOrg, setOrgLostHandler, tenantHref,
  listTickets, getTicket, getTicketBadge, createTicket, transitionTicket, moveTicket, toggleTicketAssignee,
  addTicketLink, editTicket, removeTicketLink, deleteTicket, setTicketSprint, setTicketParent, addTicketComment, listSprints,
  getSprint, createSprint, setSprintActive, addSprintResource,
  type TicketDetail,
  listArtifacts, getArtifact, getArtifactDiff, createArtifact, patchArtifact, ratifyArtifact, deleteArtifact, restoreArtifact, addArtifactLink, addArtifactVersion, fetchArtifactUrl,
  listHandoffs, getHandoff, listPrompts, getPrompt, getPromptVersions,
  createHandoff, claimHandoff, expireHandoff, savePrompt, setPromptTags, publishPrompt, deletePrompt, restorePrompt, proposeDoc,
  Unauthorized, NotFound, ApiError,
} from "./api";
import { handoffAsPrompt, blankHandoff, docDraftFromHandoff, type NewHandoffDraft } from "./handoffs";
import { normalizeTags, type HandoffView } from "@shared/handoffs";
import { selectedUnplacedId, MAINT_TABS, type MaintTab } from "./maintenance";
import { ASSIGN_OPTIONS } from "./triage-map";
import { draftFromPrompt, blankPromptDraft, slugify, tagOptions } from "./prompts";
import { blankDoc, defaultSection } from "./newdoc";
import { SPRINT_URGENCIES, SPRINT_DOMAINS, sprintDatesProblem, sprintDatesLabel, type SprintUrgency, type SprintDomain } from "@shared/sprints-core";
import type { SprintDetail } from "@shared/sprints";
import { parseHash, hashForRoute, sameRoute, type Route } from "./hash";
import { mountLandingMotion, unmountLandingMotion } from "./landing-motion";
import {
  TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUS_LABEL, TICKET_STATUSES, canTransition, placeInColumn,
  type TicketCategory, type TicketPriority, type TicketStatus,
} from "@shared/tickets-core";
import { decodeReviewId } from "./triage-map";
import { QUEUE_FILTER_CATS, type QueueFilterCat } from "./tickets";
import { initialOnboard, markAvatarFailed, AVATAR_IMG_CLASS } from "./people";
import { prepareAvatar } from "./avatar";
import { mentionTokenAt, mentionCandidates, applyMention, caretLine, COMMENT_BOX } from "./mentions";
import { PERSON_COLORS, type PersonColor } from "@shared/rows";
import { captureScroll, restoreScroll } from "./scroll";
import { paint } from "./morph";
import { createQuickSearch, type QuickPick } from "./quicksearch";
import { SENDER_NAME_HELP, senderNamePart, senderNameProblem } from "@shared/sender";
import { createPlatform } from "./platform-actions";
import { PLATFORM_PATH, isPlatformPath } from "./platform";
import { NAV_GROUPS, navGroupOf, type NavGroup } from "./sidebar";
import { formatCount, repoPollFor, repoUpdatedLabel } from "./repo";
import { isRepoTab, REPO_RANGES, type RepoRange } from "@shared/repo";
import {
  artifactsAct, artAcceptFile, artAcceptNvFile, renderPendingMermaid, setArtFrameHeight, detailKey, diffKey, initialArtCreate, ART_ROUTE_NONE, ART_FILTER_KEYS,
  type ArtScreen, type ArtEffect, type ArtWrite, type ArtRoute, type ArtFilterKey, type ArtFile,
} from "./artifacts";
import { kindForFilename, isBinaryKind } from "@shared/artifacts-core";
import { confirmKeyAction } from "./confirm";
import { createOrgController } from "./org-actions";
import { createOrgsController } from "./org-picker-actions";
import { initialOrgsUi } from "./org-picker";
import { LAST_ORG_KEY, RETURN_HASH_KEY, RETURN_ORG_KEY, orgBase, orgHref, orgSlugFromPath, resolveLanding } from "./org-context";
import { setPrimaryRepo } from "./github";
import type { MyOrgsResponse } from "@shared/orgs";

const root = document.getElementById("app");
if (!root) throw new Error("Trov: #app mount point missing");
const mount = root;

const state: AppState = initialState();

// The sidebar's "search everything" dropdown. Its node lives on <body>, outside the
// mount, so rerender() never touches it; rerender() calls `qs.sync()` to re-anchor it.
const qs = createQuickSearch({
  fetch: (q, signal) => quickSearch(q, signal),
  pick: quickPick,
  theme: () => resolvedTheme(),
  railCollapsed: () => railCollapsed(state), // on a phone the drawer is the full, expanded rail
});

// Org settings (web/src/org-actions.ts): every `org…` act, its loads, and the secret form's draft.
const orgCtl = createOrgController({
  state, mount, rerender: () => rerender(), flash: (m, ms) => flash(m, ms), unauth: (e) => unauth(e), confirmOut: (then) => confirmOut(then),
  reloadOrgs: () => loadMyOrgs(), leaveOrg: () => showPicker(null),
});
// Organizations as a person meets them (web/src/org-picker-actions.ts): the switcher's menu, the
// picker, the create dialog — every `orgs…` act. Opening an org is a page load.
const orgsCtl = createOrgsController({
  state, mount, rerender: () => rerender(), flash: (m, ms) => flash(m, ms), unauth: (e) => unauth(e),
  reloadOrgs: () => loadMyOrgs(), go: (url) => { window.location.assign(url); }, openSettings: () => orgCtl.act("orgGo", null, null),
});

// ── persisted client prefs (theme + sidebar only; not backend state) ─────────
migrateBrowserStorage(); // canopy.* → trov.* (the rename) before the first read
try {
  const t = localStorage.getItem("trov.theme");
  if (t === "dark" || t === "light" || t === "system") state.theme = t;
  else if (t === "midnight") state.theme = "dark"; // Midnight was retired (2026-09-26) — its closest theme
  const fv = localStorage.getItem("trov.feedView");
  if (fv === "reading" || fv === "agents") state.feedView = fv;
  const pv = localStorage.getItem("trov.promptView");
  if (pv === "raw" || pv === "rendered") state.promptView = pv;
  const c = localStorage.getItem("trov.collapsed");
  if (c) state.collapsed = c === "1";
  const open = JSON.parse(localStorage.getItem("trov.navOpen") ?? "{}") as Record<string, unknown>;
  // Only live groups are read, so a retired one's key (tickets, maintenance, repo) is ignored.
  for (const g of NAV_GROUPS) if (typeof open[g] === "boolean") state.navOpen[g] = open[g] as boolean;
} catch { /* localStorage unavailable, or a hand-edited value */ }

if (window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  state.systemDark = mq.matches;
  const onChange = (ev: MediaQueryListEvent) => { state.systemDark = ev.matches; rerender(); };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else mq.addListener(onChange);

  // Below this width the full rail would starve the screen, so it renders collapsed
  // (the person's own `collapsed` preference is untouched and returns with the room).
  const narrow = window.matchMedia("(max-width: 900px)");
  state.narrow = narrow.matches;
  const onNarrow = (ev: MediaQueryListEvent) => { state.narrow = ev.matches; rerender(); };
  if (narrow.addEventListener) narrow.addEventListener("change", onNarrow);
  else narrow.addListener(onNarrow);

  // At phone width even the collapsed rail starves the screen: it leaves the layout and
  // opens as a drawer from the header's menu button (trov.css `[data-phone="1"]`).
  const phone = window.matchMedia("(max-width: 640px)");
  state.phone = phone.matches;
  const onPhone = (ev: MediaQueryListEvent) => { state.phone = ev.matches; state.drawer = false; rerender(); };
  if (phone.addEventListener) phone.addEventListener("change", onPhone);
  else phone.addListener(onPhone);
}

// ── render with focus/caret + main-pane scroll preservation ──────────────────
// ── screen-enter motion ──────────────────────────────────────────────────────
// A screen's entrance (trov.css `[data-enter]`) plays when WHAT IS ON SCREEN
// changes — a new route, or its data arriving — never on the other rerenders (a
// keystroke, a hover, a badge landing), which would replay it endlessly.
// rerender() swaps <main> wholesale, so a rerender DURING an entrance would cut
// it short; instead the clock keeps running and the fresh DOM joins the animation
// where the old one left off, via a negative animation-delay (`--enter-t`).
const ENTER_MS = 900;
let enterKey = "";
let enterAt = 0;
let enterTimer: ReturnType<typeof setTimeout> | null = null;

/** Whether the screen's main read has landed — its arrival is an entrance too. */
function screenSettled(): boolean {
  const ok = (l: { status: string }) => l.status === "ok" || l.status === "error";
  switch (state.screen) {
    case "mywork": return ok(state.mywork);
    case "feed": return ok(state.feed);
    case "docs": return ok(state.docsList);
    case "roadmap": return ok(state.roadmap);
    case "tickets": return ok(state.tickets);
    case "ticketdetail": return ok(state.ticketDetail);
    case "sprint": return ok(state.sprintDetail);
    case "repo": return state.repo.data !== null || state.repo.status === "error";
    // A background refresh (after a write) keeps its data, so it never replays the entrance.
    case "artifacts": return state.art.list.data !== null || ok(state.art.list);
    case "artifactnew": return true;
    case "artifact": {
      const r = state.artRoute;
      const d = r.slug ? state.art.details[detailKey(r.slug, r.diff ? null : r.v)] : undefined;
      return !!d && (d.data !== null || d.status === "ok" || d.status === "error" || d.status === "missing");
    }
    // These four refetch on every visit and paint what they already hold meanwhile,
    // so "landed" means "has something to show" (like the Repo dashboard) — else the
    // cached paint plays the entrance and the refresh landing plays it a second time.
    case "handoffs": return ok(state.handoffs) || state.handoffs.data.length > 0;
    case "handoff": return ok(state.handoffDetail) || state.handoffDetail.data !== null;
    case "prompts": return ok(state.promptList) || state.promptList.data.length > 0;
    case "prompt": return ok(state.promptDetail) || state.promptDetail.data !== null;
    default: return true; // search re-queries per keystroke; the rest load nothing
  }
}

function markEnter(): void {
  const root = mount.firstElementChild as HTMLElement | null;
  if (!root || state.view !== "app") return;
  const settled = screenSettled();
  // An in-page view switch (the header's segmented switch — Roadmap Narrative/Timeline, a
  // release's Release/Patch notes — or a page's tab bar, Maintenance's and Repo's tabs) is not
  // a new page: key the entrance on the route WITHOUT it, so flipping the switch swaps the
  // content in place instead of replaying the screen (and the tab bar's underline slides unbroken).
  const key = `${hashForRoute({ ...currentRoute(), roadmapTab: undefined, releasePage: undefined, maintTab: undefined, repoTab: undefined })}|${state.repoSample ? "s" : ""}|${settled ? 1 : 0}`;
  const now = performance.now();
  // A still-loading paint does not enter: the entrance plays ONCE, when the screen's
  // read lands. Playing it for the loading paint too made every first visit (and every
  // visit to an empty list) enter twice — the "double click" flash.
  if (!settled) {
    enterKey = key;
    enterAt = now - ENTER_MS;
    root.removeAttribute("data-enter");
    return;
  }
  if (key !== enterKey) { enterKey = key; enterAt = now; }
  const elapsed = now - enterAt;
  if (elapsed >= ENTER_MS) return;
  root.setAttribute("data-enter", "1");
  root.style.setProperty("--enter-t", `${-Math.round(elapsed)}ms`);
  if (elapsed === 0) countUp(root);
  // Drop the flag once the entrance is over: a filled animation keeps its element a
  // stacking context, and nothing should depend on one that is no longer moving.
  if (enterTimer !== null) clearTimeout(enterTimer);
  enterTimer = setTimeout(() => {
    enterTimer = null;
    const live = mount.firstElementChild as HTMLElement | null;
    live?.removeAttribute("data-enter");
    live?.style.removeProperty("--enter-t");
  }, ENTER_MS - elapsed + 50);
}

/** Stat figures count up to their value on entrance (`data-count`). */
function countUp(root: HTMLElement): void {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const key = enterKey;
  const els = Array.from(root.querySelectorAll<HTMLElement>("[data-count]"));
  if (!els.length) return;
  // A compacted or dollar figure ("1.4K", "$29.61") counts up in its own format
  // (`data-count-fmt`) and LANDS on the text it was rendered with — the Worker's
  // string, never a re-derivation of it.
  const finals = els.map((el) => el.textContent ?? "");
  const start = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / 600);
    const eased = 1 - Math.pow(1 - k, 3);
    // A rerender replaces these nodes; the new ones already carry the final value.
    els.forEach((el, i) => { if (el.isConnected) el.textContent = k >= 1 ? finals[i] : formatCount(Number(el.dataset.count) * eased, el.dataset.countFmt); });
    if (k < 1 && key === enterKey) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** One-shot: a selector to re-animate after the next paint (a range switch, a panel opening). */
let pendingFlash: string | null = null;

let lastNavGroup: NavGroup | null = null;
/** The route the phone drawer was last seen on (rerender closes it when this changes). */
let drawerRoute = "";
/** The group the app opened on its own (so it may close it again). */
let autoOpened: NavGroup | null = null;

function rerender(): void {
  // A board drag holds the DOM: swapping <main> would drop the card mid-drag.
  // The held paint runs when the drag ends (clearBoardDrag).
  if (boardDrag) { rerenderHeld = true; return; }
  // The phone drawer closes whenever the route changes (a nav row, a search, Back).
  const drawerKey = state.view === "app" ? hashForRoute(currentRoute()) : state.view;
  if (drawerKey !== drawerRoute) { drawerRoute = drawerKey; state.drawer = false; }
  // The "Poll now" result is session-only and belongs to the Repo screen: leaving
  // it (any route, or signing out) clears it, and an in-flight poll's answer is
  // then dropped on arrival (runRepoPoll checks it is still the one polling).
  // Switching between the Repo TABS keeps it — the strip renders on all five.
  state.repoPoll = repoPollFor(state.repoPoll, state.view === "app" && state.screen === "repo");
  // The queue's filter menu left open never survives leaving the queue.
  if (state.screen !== "tickets") state.qFilterOpen = false;
  if (state.screen !== "feed") state.feedFilterOpen = false;
  if (state.screen !== "settings") state.avatarMenu = false;
  // Entering a group's pages opens its sub-page list, and leaving folds it again —
  // unless the person opened or closed it by hand, which sticks (and is what persists).
  const group = state.view === "app" ? navGroupOf(state.screen) : null;
  if (group !== lastNavGroup) {
    if (autoOpened && autoOpened !== group) { state.navOpen[autoOpened] = false; autoOpened = null; }
    if (group && !state.navOpen[group]) { state.navOpen[group] = true; autoOpened = group; }
    lastNavGroup = group;
  }
  const active = document.activeElement as HTMLElement | null;
  const field = active?.getAttribute?.("data-field") ?? null;
  let selStart = 0;
  let selEnd = 0;
  let fieldScroll = 0;
  // Textareas carry a caret too (the new-ticket description, the comment box),
  // so they are captured/restored exactly like inputs — and their own scroll, so
  // typing deep in a long one (the New version editor) doesn't jump it to the top.
  if (field && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
    selStart = active.selectionStart ?? 0;
    selEnd = active.selectionEnd ?? 0;
    fieldScroll = active.scrollTop;
  }
  // A scroll box that holds the focused field and names itself `data-scroll-keep` (a dialog's
  // body) keeps its position across the swap too.
  const keepBox = field ? active?.closest?.<HTMLElement>("[data-scroll-keep]") ?? null : null;
  const keepName = keepBox?.getAttribute("data-scroll-keep") ?? null;
  const keepTop = keepBox?.scrollTop ?? 0;
  // The swap below discards the main scroll pane; keep its position when the
  // screen is unchanged so a button low on a long screen doesn't jump to the top.
  const scroll = captureScroll(mount, state.screen);
  paint(mount, render(state));
  syncSegments(mount);
  syncTabBars(mount);
  qs.sync();   // the search dropdown lives outside the mount: re-anchor and re-theme it
  // The tab icon follows the app's resolved theme (a no-op until it changes).
  syncFavicon(resolvedTheme(), mount.querySelector("[data-cnpy-theme]"));
  restoreScroll(mount, scroll, state.screen);
  markEnter();
  orgCtl.afterPaint();
  if (pendingFlash) {
    for (const el of Array.from(mount.querySelectorAll(pendingFlash))) el.classList.add("cnpy-flash");
    pendingFlash = null;
  }
  const onLanding = state.view === "auth" ? state.authStep === "login" : state.screen === "site";
  if (onLanding) mountLandingMotion(mount, state.landingSeen);
  else unmountLandingMotion();
  if (field) {
    const el = mount.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${field}"]`);
    // The sidebar is patched in place, so its search box never lost focus or caret.
    if (el && el !== document.activeElement) {
      el.focus();
      try { el.setSelectionRange(selStart, selEnd); } catch { /* non-text input */ }
      el.scrollTop = fieldScroll;
    }
    if (keepName) {
      const box = mount.querySelector<HTMLElement>(`[data-scroll-keep="${keepName}"]`);
      if (box) box.scrollTop = keepTop;
    }
  }
  // Deferred scroll-to-heading: fires once the reader for the target doc has
  // rendered (may be a later rerender if the doc was still loading). Cleared on
  // hit. The scroll itself waits a frame so layout settles after the innerHTML
  // swap — scrollIntoView called synchronously after it is a no-op.
  if (state.pendingScrollId) {
    const target = mount.querySelector<HTMLElement>(`.cnpy-md [id="${cssEscape(state.pendingScrollId)}"]`);
    if (target) {
      state.pendingScrollId = null;
      // Instant, not smooth: smooth scrollIntoView is a silent no-op on this
      // nested overflow container, and instant is the right call after navigation.
      requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
    }
  }
  updateActiveHeading();
  updateGuideToc();
  renderPendingMermaid(mount);
  // Reflect the current route in the URL hash so a reload restores it. The ticket
  // and sprint screens carry an id, so this is hashForRoute, not `#${screen}`.
  if (state.view === "app" || state.view === "platform") {
    const want = hashForRoute(currentRoute());
    if (location.hash !== want) history.replaceState(null, "", want);
  }
}

// Back/forward or a manually edited hash → switch screens.
window.addEventListener("hashchange", () => {
  closeLightbox(); // Back/Forward under an open figure: it belongs to the old route
  if (state.view === "platform") { enterPlatform(location.hash); return; }
  if (state.view !== "app") return;
  const r = parseHash(location.hash);
  const cur = currentRoute();
  if (sameRoute(r, cur)) return;
  applyRoute(r);
  loadForScreen(r.screen);
});

// Minimal CSS.escape shim for id selectors (heading ids are already slug-safe).
function cssEscape(v: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&");
}

// ── docs scrollspy: highlight the outline item for the section in view ────────
// Nearest scrollable ancestor of the reader body (the pane that actually scrolls).
function readerScroller(): HTMLElement | null {
  const md = mount.querySelector(".cnpy-md");
  for (let n = md?.parentElement; n; n = n.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n as HTMLElement;
  }
  return null;
}

// Mark the outline entry for the heading currently at the top of the reader as
// current. Direct DOM (no rerender) so it stays cheap while scrolling.
function updateActiveHeading(): void {
  if (state.screen !== "docs" || !state.docSlug) return;
  const reader = readerScroller();
  if (!reader) return;
  const heads = [...reader.querySelectorAll<HTMLElement>(".cnpy-md h2[id], .cnpy-md h3[id]")];
  if (!heads.length) return;
  const top = reader.getBoundingClientRect().top;
  let activeId = heads[0].id;
  for (const h of heads) {
    if (h.getBoundingClientRect().top - top <= 96) activeId = h.id;
    else break;
  }
  // At the bottom the last section can't reach the top — force it current.
  if (reader.scrollTop + reader.clientHeight >= reader.scrollHeight - 4) activeId = heads[heads.length - 1].id;
  const want = `${state.docSlug}::${activeId}`;
  for (const item of mount.querySelectorAll<HTMLElement>(".cnpy-outline-item")) {
    item.classList.toggle("is-current", item.getAttribute("data-arg") === want);
  }
}

// Get Started's table of contents: the same spy over the guide's headings. The
// current row is the last anchor at or above the top of #cnpy-main; a sub-row also
// lights its section. Direct DOM, like the docs spy.
function updateGuideToc(): void {
  if (state.screen !== "guide") return;
  const pane = document.getElementById("cnpy-main");
  const heads = [...mount.querySelectorAll<HTMLElement>(".cnpy-guide-anchor[id]")];
  if (!pane || !heads.length) return;
  const top = pane.getBoundingClientRect().top;
  let active = heads[0].id;
  for (const h of heads) {
    if (h.getBoundingClientRect().top - top <= 96) active = h.id;
    else break;
  }
  if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4) active = heads[heads.length - 1].id;
  const items = [...mount.querySelectorAll<HTMLElement>(".cnpy-guide-toc [data-arg]")];
  const hit = items.find((b) => b.getAttribute("data-arg") === active);
  // A sub-row's section is the nearest section row above it.
  let section: HTMLElement | undefined;
  if (hit) for (const b of items) { if (b.classList.contains("cnpy-guide-toc-sec")) section = b; if (b === hit) break; }
  for (const b of items) b.classList.toggle("is-current", b === hit || b === section);
}

// One capture-phase listener survives every rerender (scroll doesn't bubble, so
// capture catches the reader pane); rAF-throttled.
let spyScheduled = false;
mount.addEventListener("scroll", () => {
  if (spyScheduled) return;
  spyScheduled = true;
  requestAnimationFrame(() => { spyScheduled = false; updateActiveHeading(); updateGuideToc(); });
}, true);

function resolvedTheme(): "dark" | "light" {
  return state.theme === "system" ? (state.systemDark ? "dark" : "light") : state.theme;
}
function persist(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}
// Only what the person chose persists — a list the app opened by itself is not a preference.
function persistNavOpen(): void {
  persist("trov.navOpen", JSON.stringify(autoOpened ? { ...state.navOpen, [autoOpened]: false } : state.navOpen));
}

// ── screen ↔ URL hash (so a reload stays on the current page) ─────────────────
// Parsing/serializing lives in ./hash as pure functions (unit-tested); this
// module is the only one that touches `location`.
function currentRoute(): Route {
  const r: Route = { screen: state.screen, ticketId: state.ticketId, sprintId: state.sprintId };
  if (state.screen === "repo") r.repoTab = state.repoTab;
  if (state.screen === "roadmap") r.roadmapTab = state.roadmapTab;
  if (state.screen === "releases" && state.releaseVersion) { r.releaseVersion = state.releaseVersion; r.releasePage = state.releasePage; }
  if (state.screen === "artifact") r.art = state.artRoute;
  if (state.screen === "handoff" && state.handoffId) r.handoffId = state.handoffId;
  if (state.screen === "prompt" && state.promptSlug) r.promptSlug = state.promptSlug;
  if (state.screen === "promptedit") {
    r.promptMode = state.promptMode;
    if (state.promptMode !== "new" && state.promptSlug) r.promptSlug = state.promptSlug;
  }
  if (state.screen === "maintenance") r.maintTab = state.maintTab;
  if (state.screen === "platform") r.platTab = state.plat.tab;
  if (state.screen === "platformorg" && state.plat.orgSlug) r.platOrg = state.plat.orgSlug;
  if (state.screen === "org") r.orgTab = state.org.tab;
  return r;
}
function applyRoute(r: Route): void {
  if (r.ticketId !== state.ticketId) { state.tdDeleteArm = false; state.tdDeleteBusy = false; }   // a confirm never carries to another ticket
  state.screen = r.screen;
  state.ticketId = r.ticketId;
  state.sprintId = r.sprintId;
  if (r.repoTab) state.repoTab = r.repoTab;
  if (r.roadmapTab) state.roadmapTab = r.roadmapTab;
  if (r.screen === "releases") {
    // What's new keeps one screen for the grid and every release page, so moving between
    // them (a card, Back, the newer/older links) starts the new page at its top.
    const v = r.releaseVersion ?? null, page = r.releasePage ?? "notes";
    if (v !== state.releaseVersion || page !== state.releasePage) document.getElementById("cnpy-main")?.scrollTo(0, 0);
    state.releaseVersion = v; state.releasePage = page;
  }
  state.artRoute = r.art ?? ART_ROUTE_NONE;
  // A route change closes the artifact viewer's menus and dialogs (the design's onHash).
  state.art.verMenu = false; state.art.dotMenu = false; state.art.ratifyOpen = false; state.art.attachOpen = false;
  if (!state.art.deleteBusy) state.art.deleteArm = false;
  if (r.handoffId) state.handoffId = r.handoffId;
  if (r.promptSlug) state.promptSlug = r.promptSlug;
  if (r.promptMode) state.promptMode = r.promptMode;
  if (r.maintTab) state.maintTab = r.maintTab;
  if (r.platTab) state.plat.tab = r.platTab;
  if (r.platOrg) state.plat.orgSlug = r.platOrg;
  if (r.orgTab) state.org.tab = r.orgTab;
}

// Kick off the data load for a screen (mirrors the go* dispatch cases).
function loadForScreen(screen: Screen): void {
  switch (screen) {
    case "feed": loadFeedIfNeeded(); loadFeedStats(); break;
    case "docs": loadDocsIfNeeded(); break;
    case "roadmap": loadRoadmapIfNeeded(); loadRoadmapFeed(); break;
    case "review": loadProposalsIfNeeded(); loadDraftAdrsIfNeeded(); break;
    case "maintenance": loadNeedsTriageIfNeeded(); loadIdentityTasksIfNeeded(); loadFeedIfNeeded(); loadNotifAdminIfNeeded(); break;
    case "handoffs": loadHandoffs(); break;
    case "handoff": if (state.handoffId) openHandoff(state.handoffId); else rerender(); break;
    case "newhandoff": state.nh = blankHandoff(primaryRepoName()); loadPersons(); break;
    case "prompts": loadPrompts(); break;
    case "prompt": if (state.promptSlug) openPrompt(state.promptSlug); else rerender(); break;
    case "promptedit": openEditor(state.promptMode, state.promptSlug); break;
    case "newdoc": startNewDoc(); break;
    case "search": loadSearchIfNeeded(); break;
    case "mywork": loadMyWorkIfNeeded(); break;
    case "repo": loadRepoIfNeeded(); break;
    case "artifacts": case "artifactnew": case "artifact": loadArtifactsIfNeeded(); break;
    case "settings": loadGrantsIfNeeded(); loadNotifPrefsIfNeeded(); break;
    case "unsubscribe": runUnsubscribe(); break;
    case "platform": case "platformorg": platform.load(); break;
    case "org": orgCtl.load(); break;
    // The queue's sprint group headers and the form/rail menus all read `sprints`.
    case "tickets": loadSprintsIfNeeded(); loadTicketsIfNeeded(); break;
    case "newticket": loadSprintsIfNeeded(); rerender(); break;
    case "ticketdetail":
      loadSprintsIfNeeded();
      loadTicketsIfNeeded();                       // the sub-ticket candidate list
      if (state.ticketId !== null) loadTicketDetail(state.ticketId);
      else rerender();
      break;
    case "sprint":
      loadSprintsIfNeeded();
      if (state.sprintId !== null) loadSprintDetail(state.sprintId);
      else rerender();
      break;
    default: rerender(); break; // guide — no data load
  }
}

// ── Handoffs + Prompt Library loaders (reads only; their writes are not built) ──
function loadHandoffs(): void {
  state.handoffs = { status: "loading", data: state.handoffs.data };
  rerender();
  listHandoffs("mine")
    .then((data) => { state.handoffs = { status: "ok", data }; rerender(); })
    .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } state.handoffs = { status: "error", data: state.handoffs.data, error: String(e) }; rerender(); });
}
function openHandoff(id: number): void {
  state.handoffId = id;
  state.handoffExpireArm = false;
  state.handoffPromptOpen = false;
  // Keep the row the inbox already holds on screen while the fresh read lands.
  const known = state.handoffs.data.find((h) => h.id === id) ?? null;
  state.handoffDetail = { status: "loading", data: known };
  rerender();
  getHandoff(id)
    .then((h) => { if (state.handoffId !== id) return; state.handoffDetail = { status: "ok", data: h }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (state.handoffId !== id) return;
      const missing = e instanceof ApiError && e.status === 404;
      state.handoffDetail = { status: missing ? "ok" : "error", data: null, error: String(e) };
      rerender();
    });
}
function loadPrompts(): void {
  state.promptList = { status: "loading", data: state.promptList.data };
  rerender();
  listPrompts()
    .then((data) => { state.promptList = { status: "ok", data }; rerender(); })
    .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } state.promptList = { status: "error", data: state.promptList.data, error: String(e) }; rerender(); });
}
function openPrompt(slug: string): void {
  state.promptSlug = slug;
  state.promptDiffV = null; state.promptTagMenu = false; state.promptTagDraft = ""; state.promptExpanded = false;
  state.promptDeleteArm = false; state.promptDeleteBusy = false;
  const same = state.promptDetail.data?.prompt.slug === slug;
  state.promptDetail = { status: "loading", data: same ? state.promptDetail.data : null };
  rerender();
  Promise.all([getPrompt(slug), getPromptVersions(slug)])
    .then(([prompt, versions]) => { if (state.promptSlug !== slug) return; state.promptDetail = { status: "ok", data: { prompt, versions } }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (state.promptSlug !== slug) return;
      const missing = e instanceof ApiError && e.status === 404;
      state.promptDetail = { status: missing ? "ok" : "error", data: null, error: String(e) };
      rerender();
    });
}
/** The editor: blank for a new prompt, else seeded from the prompt it edits (or versions). */
function openEditor(mode: "new" | "edit" | "version", slug: string | null): void {
  state.promptMode = mode;
  if (state.promptList.status === "idle") loadPrompts(); // the slug-taken check reads the library
  if (mode === "new" || !slug) { state.promptMode = "new"; state.promptEd = blankPromptDraft(); rerender(); return; }
  state.promptSlug = slug;
  const have = state.promptDetail.data?.prompt.slug === slug ? state.promptDetail.data.prompt : null;
  if (have) { state.promptEd = draftFromPrompt(have, mode); rerender(); return; }
  state.promptEd = null;
  rerender();
  getPrompt(slug)
    .then((p) => { if (state.screen !== "promptedit" || state.promptSlug !== slug) return; state.promptEd = draftFromPrompt(p, mode); rerender(); })
    .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } flash("Couldn't load that prompt"); state.screen = "prompts"; loadPrompts(); });
}
function startNewDoc(): void {
  state.nd = blankDoc(state.docSpace, ""); // the view defaults the section once the space's docs are known
  if (state.docsList.status === "idle") loadDocs(); else rerender();
}
/** The org's primary repository as `owner/repo` ("" when none is connected, or not known yet). */
const primaryRepoName = (): string => state.orgMe.data?.repos.primary ?? "";

// ── the org on screen ────────────────────────────────────────────────────────
// `GET /api/orgs` — the ONE loader of `state.myOrgs` (Org settings, the switcher, the picker and
// the Platform area all read it). It also keeps `me.orgs` and the superadmin flag current, so a
// role change or a rename made elsewhere shows up without a reload. Single-flight.
let orgsLoad: Promise<MyOrgsResponse | null> | null = null;
function loadMyOrgs(): Promise<MyOrgsResponse | null> {
  if (orgsLoad) return orgsLoad;
  state.myOrgs = { status: "loading", data: state.myOrgs.data };
  orgsLoad = getMyOrgs()
    .then((data): MyOrgsResponse | null => {
      state.myOrgs = { status: "ok", data };
      state.plat.superadmin = data.superadmin === true;
      if (state.me) { state.me.orgs = data.orgs; state.me.superadmin = data.superadmin; state.me.pending_invites = data.invites.length; }
      // The org on screen is no longer mine (removed, or it was suspended): the picker.
      if (state.view === "app" && state.orgSlug && !data.orgs.some((o) => o.slug === state.orgSlug)) showPicker(state.orgSlug);
      else rerender();
      return data;
    })
    .catch((e): null => {
      if (e instanceof Unauthorized) { unauth(e); return null; }
      state.myOrgs = { status: "error", data: state.myOrgs.data, error: e instanceof Error ? e.message : String(e) };
      rerender();
      return null;
    })
    .finally(() => { orgsLoad = null; });
  return orgsLoad;
}

/** `GET /api/o/<slug>/me`: my role here and the org's repositories — what every GitHub link,
 *  the artifact repo list and a handoff's default repo are built from. */
function loadOrgMe(): void {
  const slug = state.orgSlug;
  if (!slug) return;
  state.orgMe = { status: "loading", data: state.orgMe.data };
  getOrgMe(slug)
    .then((data) => {
      if (state.orgSlug !== slug) return;
      state.orgMe = { status: "ok", data };
      setPrimaryRepo(data.repos.primary);
      // Forms opened before this landed pick the repo up now, unless something was typed.
      if (!state.art.c.repo) state.art.c.repo = data.repos.all[0] ?? "";
      if (!state.nh.repo) state.nh.repo = data.repos.primary ?? "";
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (state.orgSlug !== slug) return;
      if (e instanceof ApiError && e.status === 404) { showPicker(slug); return; }
      state.orgMe = { status: "error", data: state.orgMe.data, error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}

/** The org picker: no org is open. `lost` = the org that was asked for is not this person's
 *  (removed from it, suspended, or a wrong link) — the picker says so in one sentence. */
function showPicker(lost: string | null): void {
  setApiOrg(null);
  setPrimaryRepo(null);
  try { if (lost && localStorage.getItem(LAST_ORG_KEY) === lost) localStorage.removeItem(LAST_ORG_KEY); } catch { /* ignore */ }
  state.view = "orgs";
  state.orgSlug = null;
  state.drawer = false;
  state.orgsUi = { ...initialOrgsUi(), lost };
  if (state.me && lost) state.me.orgs = state.me.orgs.filter((o) => o.slug !== lost);
  // The hash stays: opening an org from here lands on what the link was for.
  if (location.pathname !== "/") history.replaceState(null, "", `/${location.hash}`);
  void loadMyOrgs();
  rerender();
  window.scrollTo(0, 0);
}
// A tenant request answered 404 and the membership gate confirmed it (api.ts): same place.
setOrgLostHandler((slug) => { if (state.view === "app" && state.orgSlug === slug) showPicker(slug); });

/**
 * The Platform area at `/platform/` — outside any org, so a superadmin who belongs to none reaches it
 * (platform.ts `platformPage`). No org is open: nothing here asks a tenant route. Any hash that is not
 * one of Platform's own (`#platform`, `#platform/usage`, `#platform/orgs/<slug>`) is its first tab.
 */
function enterPlatform(hash: string): void {
  setApiOrg(null);
  setPrimaryRepo(null);
  state.orgSlug = null;
  state.drawer = false;
  state.view = "platform";
  const r = parseHash(hash);
  applyRoute(r.screen === "platform" || r.screen === "platformorg" ? r : { ...r, screen: "platform", platTab: "orgs" });
  if (!isPlatformPath(location.pathname)) history.replaceState(null, "", `${PLATFORM_PATH}${hashForRoute(currentRoute())}`);
  platform.load();
}

/** Open an org: every request from here on is its (`/api/o/<slug>/…`), the address bar says
 *  `/o/<slug>/` with the hash route after it, and this browser remembers it as last used. */
function enterOrg(slug: string, hash: string): void {
  const link = new URLSearchParams(location.search).get("link");
  state.orgSlug = slug;
  setApiOrg(slug);
  try { localStorage.setItem(LAST_ORG_KEY, slug); } catch { /* ignore */ }
  const want = orgHref(slug, hash);
  if (`${location.pathname}${location.search}${location.hash}` !== want) history.replaceState(null, "", want);
  state.view = "app";
  // Restore the route from the URL hash (reload stays put, including
  // #tickets/<id> and #sprints/<id>) instead of always My Work.
  applyRoute(parseHash(hash));
  loadOrgMe();
  void loadMyOrgs();
  loadForScreen(state.screen);
  // A conflicting Link redirect lands here directly (full page load to
  // /?link=conflict#settings), not through the goSettings dispatch case.
  checkLinkConflict(link);
  // Boot-time loads for the sidebar triage badges — the counts must be
  // right on every screen, not just after visiting Review/Maintenance.
  // Guarded: the screen's own loader (My Work, Review) may have just started
  // these — a second unconditional call would fetch each twice.
  if (state.proposals.status === "idle") loadProposals();
  if (state.draftAdrs.status === "idle") loadDraftAdrs();
  loadNeedsTriage();
  loadIdentityTasks();
  // The Tickets badge shows on every screen too — unassigned + open, org-wide.
  loadTicketBadge();
  // Handoffs (pending for me) and the Prompt Library (staged) badges.
  if (state.handoffs.status === "idle") loadHandoffs();
  if (state.promptList.status === "idle") loadPrompts();
  // The persons directory backs every colored chip (sidebar, feed, docs,
  // Settings › Profile, Maintenance › People) — load it on every screen too.
  loadPersons();
}
/** A write's failure as a toast: the server's `{ error }` (a 409's "handoff is claimed"), else a fallback. */
function writeErr(e: unknown, fallback: string): void {
  if (e instanceof Unauthorized) { unauth(e); return; }
  flash(e instanceof ApiError && e.message && !/^\d+$/.test(e.message) ? e.message : fallback);
}
/** A handoff write landed: show it, and refresh the inbox (the sidebar badge reads it). */
function applyHandoff(h: HandoffView, msg: string): void {
  state.handoffId = h.id;
  state.handoffDetail = { status: "ok", data: h };
  state.handoffExpireArm = false;
  loadHandoffs();
  flash(msg);
}
/** A prompt write landed: reload the detail + versions and the library (the badge reads it). */
function afterPromptWrite(slug: string, msg: string): void {
  loadPrompts();
  state.screen = "prompt";
  openPrompt(slug);
  flash(msg);
}
/** Replace a prompt's tag list (the detail rail's add / remove). */
function writePromptTags(tags: string[]): void {
  const p = state.promptDetail.data?.prompt;
  if (!p) return;
  setPromptTags(p.slug, normalizeTags(tags))
    .then((np) => {
      if (state.promptDetail.data?.prompt.slug === np.slug) state.promptDetail = { status: "ok", data: { ...state.promptDetail.data, prompt: np } };
      loadPrompts();
    })
    .catch((e) => writeErr(e, "Couldn't change the tags"));
}

// ── per-screen data loaders ──────────────────────────────────────────────────
function loadFeed(): void {
  state.feed = { status: "loading", data: state.feed.data };
  rerender();
  const author = state.feedAuthor !== "all" ? state.feedAuthor : undefined;
  const tags = state.feedTag !== "all" ? [state.feedTag] : undefined;
  getFeed({ author, tags })
    .then((rows) => {
      state.feed = { status: "ok", data: rows };
      // Capture the author chip set only from the unfiltered view, so filtering doesn't shrink it.
      if (!author && !tags) state.feedAuthors = [...new Set(rows.map((r) => r.author))];
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.feed = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadFeedIfNeeded(): void {
  if (state.feed.status === "idle") loadFeed();
  else rerender();
}

/**
 * The Feed aside's "This week": its OWN read over the whole team's last 7 local days
 * (`GET /feed/stats`), refreshed on every entry to the Feed — never on a filter change,
 * since the numbers are unfiltered. What is on screen stays while it refreshes; a failed
 * read says so rather than showing old numbers as current. The seq guard lets only the
 * newest request commit.
 */
let feedStatsSeq = 0;
function loadFeedStats(): void {
  const seq = ++feedStatsSeq;
  state.feedStats = { status: "loading", data: state.feedStats.data };
  getFeedStats(7)
    .then((data) => {
      if (seq !== feedStatsSeq) return;
      state.feedStats = { status: "ok", data };
      rerender();
    })
    .catch((e) => {
      if (seq !== feedStatsSeq) return;
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.feedStats = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}

function loadMyWork(): void {
  state.mywork = { status: "loading", data: state.mywork.data };
  rerender();
  getMyDashboard()
    .then((data) => {
      state.mywork = { status: "ok", data };
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.mywork = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
/** Your sessions: MY two latest feed entries — My Work's own read, so the Feed
 *  screen's author/tag filters (which shape `state.feed`) never reach it. */
function loadMwSessions(): void {
  const me = state.me?.handle;
  if (!me) return;
  state.mwSessions = { status: "loading", data: state.mwSessions.data };
  getFeed({ author: me, limit: 2 })
    .then((rows) => { state.mwSessions = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      state.mwSessions = { status: "error", data: state.mwSessions.data, error: String(e) };
      rerender();
    });
}
/** Docs you own: the doc list WITHOUT bodies — never `loadDocs`, which also opens
 *  the Docs screen's first doc (its body + every version) and picks `docSlug`. */
function loadMwDocs(): void {
  state.mwDocs = { status: "loading", data: state.mwDocs.data };
  listDocMeta()
    .then((rows) => { state.mwDocs = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      state.mwDocs = { status: "error", data: state.mwDocs.data, error: String(e) };
      rerender();
    });
}
/** My Work reads its own DTO plus the slices its tiles and rail are built on —
 *  each loaded only when idle, so a screen already visited costs nothing. */
function loadMyWorkIfNeeded(): void {
  if (state.mywork.status === "idle") loadMyWork();
  loadProposalsIfNeeded(); loadDraftAdrsIfNeeded();
  loadSprintsIfNeeded(); // a ticket's due date is its sprint's
  if (state.mwSessions.status === "idle") loadMwSessions();
  if (state.handoffs.status === "idle") loadHandoffs();
  if (state.repo.status === "idle") loadRepo();
  if (state.mwDocs.status === "idle") loadMwDocs();
  loadArtifactList();
  rerender();
}

// ── Repo dashboard ───────────────────────────────────────────────────────────
// A refresh keeps the last payload on screen (the header says "refreshing…");
// only a first load shows skeletons.
function loadRepo(): void {
  state.repo = { status: "loading", data: state.repo.data };
  rerender();
  const sample = state.repoSample;
  const read = sample ? import("./repo-sample").then((m) => m.repoSample()) : getRepoDashboard();
  read
    .then((data) => {
      if (sample !== state.repoSample) return; // switched source mid-flight — the newer load wins
      state.repo = { status: "ok", data };
      state.repoFetchedAt = Date.now();
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.repo = { status: "error", data: state.repo.data, error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
// "Poll now" (admins, the Repo top bar — every tab): refresh the sources the
// dashboard shows (health pings, the usage pollers, the GitHub reconcile), then
// re-read the dashboard so whatever they wrote is on screen, with the per-source
// outcomes in a strip at the top of whichever tab is open — it survives a tab
// switch and is cleared on leaving the Repo screen (`rerender`). Never in sample
// mode — that never touches the Worker. A second click while one is in flight
// does nothing. A 409 (another refresh holds the lock) and a failed request
// (network / 403 / 502) are each one line in the same strip; no alert(), no
// flash(). The reload keeps the payload on screen, so the entrance key does not
// change and the screen entrance is NOT replayed — only the strip flashes
// (`pendingFlash`, off under reduced motion).
async function runRepoPoll(): Promise<void> {
  if (!viewerIsAdmin(state) || state.repoSample || state.repoPoll?.status === "polling") return;
  state.repoPoll = { status: "polling" };
  rerender();
  try {
    const result = await adminPoll();
    if (state.repoPoll?.status !== "polling") return; // left the screen (or went to sample data) meanwhile
    state.repoPoll = { status: "done", result };
    pendingFlash = ".repo-poll-strip";
    loadRepo(); // rerenders now (the strip, "refreshing…") and again when the fresh projection lands
  } catch (e) {
    if (e instanceof Unauthorized) { state.repoPoll = null; state.view = "auth"; state.authStep = "login"; rerender(); return; }
    if (state.repoPoll?.status !== "polling") return;
    state.repoPoll = { status: e instanceof ApiError && e.status === 409 ? "busy" : "error" };
    pendingFlash = ".repo-poll-strip";
    rerender();
  }
}
function loadRepoIfNeeded(): void {
  if (state.repo.status === "idle") loadRepo();
  else rerender();
}
// "updated 4m ago" ticks in place — a text write, not a rerender of the screen.
setInterval(() => {
  if (state.view !== "app" || state.screen !== "repo") return;
  const el = mount.querySelector("[data-repo-updated]");
  if (el) el.textContent = repoUpdatedLabel({ repo: state.repo, fetchedAt: state.repoFetchedAt });
}, 30_000);

// ── email notifications ──────────────────────────────────────────────────────
function loadNotifPrefs(): void {
  state.notifPrefs = { status: "loading", data: state.notifPrefs.data };
  rerender();
  getNotificationPrefs()
    .then((data) => { state.notifPrefs = { status: "ok", data }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.notifPrefs = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
// Settings › MCP access › Connected apps. No rerender of its own on entry: every caller
// follows with loadNotifPrefsIfNeeded, which does.
function loadGrants(): void {
  state.grants = { status: "loading", data: state.grants.data };
  listOAuthGrants()
    .then((data) => { state.grants = { status: "ok", data }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.grants = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadGrantsIfNeeded(): void {
  if (state.grants.status === "idle") loadGrants();
  if (state.mcpTokens.status === "idle") loadMcpTokens();
}
// Settings › MCP access › Access tokens: mine, for the org on screen.
function loadMcpTokens(): void {
  state.mcpTokens = { status: "loading", data: state.mcpTokens.data };
  listMcpTokens()
    .then((data) => { state.mcpTokens = { status: "ok", data }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      state.mcpTokens = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadNotifPrefsIfNeeded(): void {
  if (state.notifPrefs.status === "idle") loadNotifPrefs();
  else rerender();
}
/** One prefs write, then the server's fresh view replaces the slice. */
function writePrefs(body: PrefsWrite, done: string | null): void {
  putNotificationPrefs(body)
    .then((data) => { state.notifPrefs = { status: "ok", data }; if (done) flash(done); rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      flash(refusalText(e, "Could not save email settings"), isRateLimited(e) ? 7000 : 2200);
    });
}
function loadNotifAdmin(): void {
  if (!viewerIsAdmin(state)) return;
  state.notifPolicy = { status: "loading", data: state.notifPolicy.data };
  state.notifSettings = { status: "loading", data: state.notifSettings.data };
  state.notifOutbox = { status: "loading", data: state.notifOutbox.data };
  rerender();
  const unauth = (e: unknown) => { if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); } };
  getNotificationPolicy()
    .then(({ kinds }) => { state.notifPolicy = { status: "ok", data: kinds }; rerender(); })
    .catch((e) => { unauth(e); state.notifPolicy = { status: "error", data: [], error: String(e) }; rerender(); });
  getNotificationSettings()
    .then((data) => { state.notifSettings = { status: "ok", data }; rerender(); })
    .catch((e) => { unauth(e); state.notifSettings = { status: "error", data: null, error: String(e) }; rerender(); });
  listNotificationOutbox()
    .then(({ rows }) => { state.notifOutbox = { status: "ok", data: rows }; rerender(); })
    .catch((e) => { unauth(e); state.notifOutbox = { status: "error", data: [], error: String(e) }; rerender(); });
}
function loadNotifAdminIfNeeded(): void {
  if (viewerIsAdmin(state) && state.notifPolicy.status === "idle") loadNotifAdmin();
  else rerender();
}
function writeSettings(body: Parameters<typeof putNotificationSettings>[0], done: string): void {
  putNotificationSettings(body)
    .then((data) => { state.notifSettings = { status: "ok", data }; state.fromDraft = null; state.fromError = null; flash(done); rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      // A sender name the server refused (it checks again — shared/sender.ts): said under the field, not as a code.
      if ("from_address" in body && e instanceof ApiError && e.status === 400) state.fromError = "That sender name can't be used. Use letters, digits, spaces and . & ' + _ - only, without \"trov\".";
      else flash(refusalText(e, "Could not save schedule"), isRateLimited(e) ? 7000 : 2200);
      rerender();
    });
}
/**
 * The #unsubscribe screen (the footer link's GET /u/<token> redirects here):
 * flips email_unsubscribed through the cookie-gated prefs route, then shows
 * the confirmation. A Settings "preview" shows the same screen without a flip.
 */
function runUnsubscribe(): void {
  if (state.unsub.preview) { rerender(); return; }
  state.unsub = { pending: true, error: null, preview: false };
  rerender();
  putNotificationPrefs({ unsubscribed: true })
    .then((data) => { state.notifPrefs = { status: "ok", data }; state.unsub = { pending: false, error: null, preview: false }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.unsub = { pending: false, error: e instanceof ApiError ? e.message : "Something went wrong.", preview: false };
      rerender();
    });
}

function loadDoc(slug: string): void {
  state.docDetail = { status: "loading", data: null };
  rerender();
  getDoc(slug)
    .then((result) => {
      state.docDetail = { status: "ok", data: result };
      state.docSpace = result.doc.space;
      state.docOutlineOpen[result.doc.slug] = true;
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (e instanceof NotFound) { state.docDetail = { status: "ok", data: null }; rerender(); return; }
      state.docDetail = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}

// Open a doc clicked in the tree: animate its outline like the chevron does
// (mutate the live tree, no rerender that would kill the transition) and stream
// the doc into the reader pane in place.
function openDocInTree(slug: string): void {
  applyTreeActive(slug);
  state.docSlug = slug;
  state.showHistory = false;
  state.docOutlineOpen[slug] = true;
  state.docDetail = { status: "loading", data: null };
  refreshReaderPane();
  getDoc(slug)
    .then((result) => {
      state.docDetail = { status: "ok", data: result };
      state.docSpace = result.doc.space;
      refreshReaderPane();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (e instanceof NotFound) { state.docDetail = { status: "ok", data: null }; refreshReaderPane(); return; }
      state.docDetail = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      refreshReaderPane();
    });
}

// Open/close one outline by flipping .is-open — the stylesheet grid-rows transition
// animates it. Outlines are independent (no accordion): opening one never collapses
// another, so only a single fr transition ever runs at a time (two overlapping wedge).
function setOutlineOpen(el: Element | null, open: boolean): void {
  (el as HTMLElement | null)?.classList.toggle("is-open", open);
}

// Flip a doc's outline open/closed in place (chevron + row both use this). No
// navigation, no rerender — just the animated toggle and the open-set update.
/** Narrow screens: picking a page (or a heading) in the page list shows the reader again.
 *  In place — the reader pane itself updates in place, without a rerender. */
function closeDocsTree(): void {
  state.docsTree = false;
  const box = mount.querySelector(".cnpy-docs");
  box?.setAttribute("data-tree", "0");
  const btn = box?.querySelector<HTMLElement>('[data-act="docsTree"]');
  if (btn) { btn.setAttribute("aria-expanded", "false"); btn.lastChild!.textContent = `${spaceLabel(state.docSpace)} pages`; }
}

function toggleOutlineFor(slug: string): void {
  const esc = cssEscape(slug);
  const open = !state.docOutlineOpen[slug];
  if (open) state.docOutlineOpen[slug] = true; else delete state.docOutlineOpen[slug];
  mount.querySelector(`.cnpy-treechev[data-arg="${esc}"]`)?.classList.toggle("is-open", open);
  setOutlineOpen(mount.querySelector(`.cnpy-outline[data-outline="${esc}"]`), open);
  if (open) updateActiveHeading();
}

// Reflect the newly-active doc in the tree without a rerender: move .is-active and
// open this doc's outline (animated). Any other open outlines are left as they are.
function applyTreeActive(slug: string): void {
  const esc = cssEscape(slug);
  mount.querySelectorAll(".cnpy-tree.is-active").forEach((b) => b.classList.remove("is-active"));
  mount.querySelector(`.cnpy-tree[data-act="openDoc"][data-arg="${esc}"]`)?.classList.add("is-active");
  const tgt = mount.querySelector(`.cnpy-outline[data-outline="${esc}"]`);
  if (tgt && !tgt.classList.contains("is-open")) {
    mount.querySelector(`.cnpy-treechev[data-arg="${esc}"]`)?.classList.add("is-open");
    setOutlineOpen(tgt, true);
  }
}

// Update only the reader pane, leaving the tree (and its in-flight animation)
// untouched. Falls back to a full rerender if the pane isn't mounted.
function refreshReaderPane(): void {
  const pane = document.getElementById("cnpy-reader");
  if (!pane) { rerender(); return; }
  pane.innerHTML = docReaderHtml(state);
  if (state.pendingScrollId) {
    const target = pane.querySelector<HTMLElement>(`.cnpy-md [id="${cssEscape(state.pendingScrollId)}"]`);
    if (target) { state.pendingScrollId = null; requestAnimationFrame(() => target.scrollIntoView({ block: "start" })); }
  }
  updateActiveHeading();
}

function loadDocs(): void {
  state.docsList = { status: "loading", data: state.docsList.data };
  rerender();
  listDocs()
    .then((docs) => {
      state.docsList = { status: "ok", data: docs };
      const first = firstDocForSpace(docs, state.docSpace) ?? docs[0];
      if (state.docSlug === null && first) {
        state.docSlug = first.slug;
        state.docSpace = first.space;
        state.docOutlineOpen[first.slug] = true;
        loadDoc(first.slug);
      } else {
        rerender();
      }
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.docsList = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}

function loadDocsIfNeeded(): void {
  if (state.docsList.status === "idle") loadDocs();
  else rerender();
}

let searchDebounce: ReturnType<typeof setTimeout> | null = null;

const EMPTY_QUERY_RESULT = { primary: [], pointers: [], meta: { engine: "fts5" as const, total: 0 } };

function loadSearch(): void {
  state.searchResults = { status: "loading", data: state.searchResults.data };
  rerender();
  search(state.searchQuery)
    .then((result) => {
      state.searchResults = { status: "ok", data: result };
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.searchResults = { status: "error", data: EMPTY_QUERY_RESULT, error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}

function loadSearchIfNeeded(): void {
  if (state.searchResults.status === "idle") loadSearch();
  else rerender();
}

/** The Search screen, on `q` — the dropdown's "all results". */
function openSearchScreen(q: string): void {
  state.searchQuery = q;
  state.screen = "search";
  loadSearch();
}

/** A dropdown pick: the existing acts that open the thing, in order. */
function quickPick(p: QuickPick): void {
  if (p.kind === "search") { openSearchScreen(p.q); return; }
  for (const [act, arg] of p.steps) dispatch(act, arg, null);
}

function loadRoadmap(): void {
  state.roadmap = { status: "loading", data: state.roadmap.data };
  rerender();
  getRoadmap()
    .then((planView) => {
      state.roadmap = { status: "ok", data: planView };
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.roadmap = {
        status: "error",
        data: { narrative: "", version: 0, updated_at: null, updated_by: null, sprints: [] },
        error: e instanceof Error ? e.message : String(e),
      };
      rerender();
    });
}

function loadRoadmapIfNeeded(): void {
  if (state.roadmap.status === "idle") loadRoadmap();
  else rerender();
}

/**
 * Roadmap › Recent happenings: its OWN unfiltered read of the newest
 * HAPPENINGS_LIMIT feed entries, refreshed on every entry to the Roadmap — never
 * the Feed screen's slice, which carries that screen's author/tag filter. What is
 * already shown stays on screen while it refreshes; the seq guard lets only the
 * newest request commit.
 */
let roadmapFeedSeq = 0;
function loadRoadmapFeed(): void {
  const seq = ++roadmapFeedSeq;
  state.roadmapFeed = { status: "loading", data: state.roadmapFeed.data };
  rerender();
  getFeed({ limit: HAPPENINGS_LIMIT })
    .then((rows) => {
      if (seq !== roadmapFeedSeq) return;
      state.roadmapFeed = { status: "ok", data: rows };
      rerender();
    })
    .catch((e) => {
      if (seq !== roadmapFeedSeq) return;
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.roadmapFeed = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}

// Write-completion handlers refetch the triage slices directly (not via
// IfNeeded), so two loads of the same slice can overlap; the seq guard lets
// only the newest in-flight request commit, so a slow earlier response can't
// overwrite fresher data.
let proposalsSeq = 0;
function loadProposals(): void {
  const seq = ++proposalsSeq;
  state.proposals = { status: "loading", data: state.proposals.data };
  rerender();
  listStagedProposals()
    .then((rows) => { if (seq !== proposalsSeq) return; state.proposals = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== proposalsSeq) return;
      state.proposals = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadProposalsIfNeeded(): void {
  if (state.proposals.status === "idle" || state.proposals.status === "error") loadProposals();
  else rerender();
}

let draftAdrsSeq = 0;
function loadDraftAdrs(): void {
  const seq = ++draftAdrsSeq;
  state.draftAdrs = { status: "loading", data: state.draftAdrs.data };
  rerender();
  listAdrs("draft")
    .then((rows) => { if (seq !== draftAdrsSeq) return; state.draftAdrs = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== draftAdrsSeq) return;
      state.draftAdrs = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadDraftAdrsIfNeeded(): void {
  if (state.draftAdrs.status === "idle" || state.draftAdrs.status === "error") loadDraftAdrs();
  else rerender();
}

let needsTriageSeq = 0;
function loadNeedsTriage(): void {
  const seq = ++needsTriageSeq;
  state.needsTriage = { status: "loading", data: state.needsTriage.data };
  rerender();
  listNeedsTriage()
    .then((rows) => { if (seq !== needsTriageSeq) return; state.needsTriage = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== needsTriageSeq) return;
      state.needsTriage = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadNeedsTriageIfNeeded(): void {
  if (state.needsTriage.status === "idle" || state.needsTriage.status === "error") loadNeedsTriage();
  else rerender();
}

let identityTasksSeq = 0;
function loadIdentityTasks(): void {
  const seq = ++identityTasksSeq;
  state.identityTasks = { status: "loading", data: state.identityTasks.data };
  rerender();
  listIdentityTasks()
    .then((r) => {
      if (seq !== identityTasksSeq) return;
      state.identityTasks = { status: "ok", data: r.tasks };
      state.identityDiscarded = r.discarded;
      if (r.discarded.length === 0) state.identityShowDiscarded = false;
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== identityTasksSeq) return;
      state.identityTasks = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadIdentityTasksIfNeeded(): void {
  if (state.identityTasks.status === "idle" || state.identityTasks.status === "error") loadIdentityTasks();
  else rerender();
}

// ── tickets + sprints ────────────────────────────────────────────────────────
// The queue list is server-filtered, so every filter change refetches. Writes
// refetch it too (never locally patch a row — the server is the shape of truth),
// hence the seq guard: a slow earlier response must not overwrite a fresher one.
let ticketsSeq = 0;
/** The queue has landed at least once this session. */
let ticketsLanded = false;
function loadTickets(): void {
  const seq = ++ticketsSeq;
  // Every filter change, drag and write REFETCHES the queue. Once it has landed, a
  // refetch keeps the board on screen as it is and swaps the rows in when they
  // arrive: flipping to "loading" made the screen unsettled, so the landing replayed
  // the whole entrance (and an empty result showed "Loading the queue…") — every
  // move read as a page reload.
  if (!ticketsLanded) state.tickets = { status: "loading", data: state.tickets.data };
  rerender();
  listTickets({ seg: state.qSeg, assignee: state.qAssignee, category: state.qCategory })
    .then((rows) => { if (seq !== ticketsSeq) return; state.tickets = { status: "ok", data: rows }; ticketsLanded = true; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== ticketsSeq) return;
      state.tickets = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadTicketsIfNeeded(): void {
  if (state.tickets.status === "idle" || state.tickets.status === "error") loadTickets();
  else rerender();
}

let ticketDetailSeq = 0;
function loadTicketDetail(id: number): void {
  const seq = ++ticketDetailSeq;
  // Keep the current ticket on screen while it refreshes; clear it when opening a different one.
  const keep = state.ticketDetail.data?.id === id ? state.ticketDetail.data : null;
  state.ticketDetail = { status: "loading", data: keep };
  loadTicketArtifacts(id);            // the Artifacts block under Linked work
  rerender();
  getTicket(id)
    .then((t) => { if (seq !== ticketDetailSeq) return; state.ticketDetail = { status: "ok", data: t }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== ticketDetailSeq) return;
      // A deleted/unknown id is "no such ticket", not a failure to load.
      if (e instanceof ApiError && e.status === 404) { state.ticketDetail = { status: "ok", data: null }; rerender(); return; }
      state.ticketDetail = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}

/** The sidebar badge — loaded at boot (it shows on EVERY screen) and after every
 *  ticket write. A failure leaves the previous count rather than flashing 0. */
function loadTicketBadge(): void {
  getTicketBadge()
    .then((count) => { state.ticketBadge = count; rerender(); })
    .catch((e) => { if (e instanceof Unauthorized) unauth(e); });
}

let sprintsSeq = 0;
function loadSprints(): void {
  const seq = ++sprintsSeq;
  state.sprints = { status: "loading", data: state.sprints.data };
  listSprints()
    .then((rows) => { if (seq !== sprintsSeq) return; state.sprints = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== sprintsSeq) return;
      state.sprints = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
/** Unlike the other IfNeeded loaders this one never rerenders on a hit — its
 *  callers are already rerendering for their own screen. */
function loadSprintsIfNeeded(): void {
  if (state.sprints.status === "idle" || state.sprints.status === "error") loadSprints();
}

let sprintDetailSeq = 0;
function loadSprintDetail(id: number): void {
  const seq = ++sprintDetailSeq;
  // Keep the sprint on screen while it refreshes; clear it when opening another.
  const keep = state.sprintDetail.data?.id === id ? state.sprintDetail.data : null;
  if (!keep) state.sprintDeleteArmed = false;       // a confirm never carries to another sprint
  state.sprintDetail = { status: "loading", data: keep };
  rerender();
  getSprint(id)
    .then((sp) => { if (seq !== sprintDetailSeq) return; state.sprintDetail = { status: "ok", data: sp }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== sprintDetailSeq) return;
      // A deleted/unknown id is "no such sprint", not a failure to load.
      if (e instanceof ApiError && e.status === 404) { state.sprintDetail = { status: "ok", data: null }; rerender(); return; }
      state.sprintDetail = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}

function sprintErr(e: unknown): void {
  if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
  flash(e instanceof ApiError ? e.message : "Could not update the sprint");
}

/** Display name (first name only where the design shows one) for a stored handle. */
function personName(handle: string): string {
  return state.persons.data.find((p) => p.handle.toLowerCase() === handle.toLowerCase())?.name || handle;
}
const personFirstName = (handle: string): string => personName(handle).split(" ")[0];

/**
 * Claim the ticket-detail slice for a write that is about to go out, and return
 * the sequence number to hand back to `applyTicketWrite`.
 *
 * Assignment is a no-confirm immediate toggle (design call #7), so two clicks
 * inside one round-trip window are expected: "Assign to X" then the X remove
 * button. Both writes are correct server-side, but without a guard whichever
 * RESPONSE lands last wins the screen — and the rail can end up showing X
 * assigned over a database that says otherwise, until the user leaves and
 * re-enters the ticket. Bumping the same counter `loadTicketDetail` uses means
 * the newest write (or load) owns the slice and every earlier response is
 * dropped.
 */
const claimTicketDetail = (): number => ++ticketDetailSeq;

/** Every ticket write answers with the fresh detail: adopt it (unless a newer
 *  write/load has since claimed the slice — see `claimTicketDetail`), toast,
 *  refresh the badge, and refetch the queue when it is already on screen / cached. */
function applyTicketWrite(t: TicketDetail, msg: string, seq: number): void {
  if (seq === ticketDetailSeq) state.ticketDetail = { status: "ok", data: t };
  loadTicketBadge();
  if (state.tickets.status !== "idle") loadTickets();
  flash(msg);
}
function ticketErr(e: unknown): void {
  if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
  flash(e instanceof ApiError ? e.message : "Could not update the ticket");
}

// ── auth-expired transition (shared by every loader/write below) ────────────
function unauth(e: unknown): void {
  if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); }
}

// A Link attempt that didn't cleanly attach redirects the whole page to
// /?link=conflict#settings or /?link=already#settings (see src/auth: the identity
// belongs to someone else, vs. the caller already has one of this provider). Surface
// it once, then strip the query param so a reload/re-visit doesn't repeat it.
function checkLinkConflict(link: string | null = new URLSearchParams(location.search).get("link")): void {
  if (link === "conflict") {
    flash("That account is already linked to someone else");
    history.replaceState(null, "", `${orgBase(state.orgSlug)}#settings`);
  } else if (link === "already") {
    flash("You already have that sign-in method linked");
    history.replaceState(null, "", `${orgBase(state.orgSlug)}#settings`);
  }
}

// ── persons directory (Settings › Profile, Maintenance › People) ──
let personsSeq = 0;
function loadPersons(): void {
  const seq = ++personsSeq;
  state.persons = { status: "loading", data: state.persons.data };
  listPersons()
    .then((rows) => { if (seq !== personsSeq) return; state.persons = { status: "ok", data: rows }; rerender(); })
    .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } if (seq !== personsSeq) return; state.persons = { status: "error", data: state.persons.data, error: String(e) }; rerender(); });
}
function refreshMe(): void {
  getMe().then((me) => { state.me = me; state.displayName = me.name ?? me.handle; rerender(); }).catch(() => undefined);
}

// ── The person card (a click on a name), and Settings › Profile's photo ──
let personSeq = 0;
/** Open the person card for `handle`: it paints at once from the directory, and the detail
 *  read (joined, GitHub, admin) fills in when it lands. A failed read leaves the card as is. */
function openPersonCard(handle: string): void {
  const seq = ++personSeq;
  state.personCard = handle;
  const same = state.personDetail.data?.handle.toLowerCase() === handle.toLowerCase();
  state.personDetail = { status: "loading", data: same ? state.personDetail.data : null };
  if (!state.persons.data.length) loadPersons();
  rerender();
  mount.querySelector<HTMLElement>("[data-person-card]")?.focus();
  getPersonProfile(handle)
    .then((pr) => { if (seq !== personSeq) return; state.personDetail = { status: "ok", data: pr }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== personSeq) return;
      state.personDetail = { status: e instanceof NotFound ? "ok" : "error", data: null, error: errMsg(e) };
      rerender();
    });
}
/** Close Settings › MCP access's by-hand setup modal; focus goes back to the link that opened it. */
function closeMcpSetup(): void {
  state.mcpSetup = false;
  rerender();
  mount.querySelector<HTMLElement>("[data-mcp-setup-trigger]")?.focus();
}
/** My photo changed (uploaded or removed): every chip reads `me` or the directory. */
function setMyAvatar(url: string | null): void {
  state.avatarBusy = null;
  if (state.me) state.me.avatar_url = url;
  loadPersons();
}
/** The picked photo: downsized to a square in the browser (avatar.ts), then uploaded. */
function uploadAvatarFile(file: File | undefined | null): void {
  if (!file || state.avatarBusy) return;
  state.avatarBusy = "upload";
  rerender();
  prepareAvatar(file)
    .then(({ blob, filename }) => uploadAvatar(blob, filename))
    .then((r) => { setMyAvatar(r.avatar_url); flash("Photo updated"); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      state.avatarBusy = null;
      if (isRateLimited(e)) flash(rateLimitText(e) ?? "", 7000);
      else if (e instanceof ApiError) flash(e.status === 413 ? "That photo is too large." : /^\d+$/.test(e.message) ? "Couldn't upload the photo" : e.message);
      else flash(errMsg(e));
    });
}

// ── Artifacts (/api/artifacts; the screens are artifacts.ts) ─────────────────
// Each read is its own slice: the library list (loaded unfiltered — the filter
// popover counts every option), one detail per `slug@v`, one diff per pair, the
// artifacts linked to a ticket, and every ticket for the attach dialog (the queue's
// `state.tickets` follows the queue's filter, so it can't back that list). A
// refresh keeps the slice's data on screen; only a first load shows "Loading…".
const artSeq = new Map<string, number>();
const nextArtSeq = (k: string): number => { const n = (artSeq.get(k) ?? 0) + 1; artSeq.set(k, n); return n; };
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A refused write as a toast: the per-person limit's one sentence (api.ts `rateLimitText`), else the server's code. */
const refusalText = (e: unknown, fallback: string): string => rateLimitText(e) ?? (e instanceof ApiError ? e.message : fallback);

function loadArtifactList(force = false): void {
  const cur = state.art.list;
  if (!force && (cur.status === "ok" || cur.status === "loading")) return;
  const seq = nextArtSeq("list");
  state.art.list = { status: "loading", data: cur.data };
  listArtifacts()
    .then((rows) => { if (seq !== artSeq.get("list")) return; state.art.list = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== artSeq.get("list")) return;
      state.art.list = { status: "error", data: state.art.list.data, error: errMsg(e) };
      rerender();
    });
}
function loadArtifactDetail(slug: string, v: number | null, force = false): void {
  const key = detailKey(slug, v);
  const cur = state.art.details[key];
  if (!force && cur && cur.status !== "idle" && cur.status !== "error") return;
  const seq = nextArtSeq(`d:${key}`);
  state.art.details[key] = { status: "loading", data: cur?.data ?? null };
  getArtifact(slug, v)
    .then((d) => { if (seq !== artSeq.get(`d:${key}`)) return; state.art.details[key] = { status: "ok", data: d }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== artSeq.get(`d:${key}`)) return;
      state.art.details[key] = e instanceof NotFound ? { status: "missing", data: null } : { status: "error", data: null, error: errMsg(e) };
      rerender();
    });
}
function loadArtifactDiff(slug: string, a: number, b: number, force = false): void {
  const key = diffKey(slug, a, b);
  const cur = state.art.diffs[key];
  if (!force && cur && cur.status !== "idle" && cur.status !== "error") return;
  const seq = nextArtSeq(`x:${key}`);
  state.art.diffs[key] = { status: "loading", data: cur?.data ?? null };
  getArtifactDiff(slug, a, b)
    .then((d) => { if (seq !== artSeq.get(`x:${key}`)) return; state.art.diffs[key] = { status: "ok", data: d }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== artSeq.get(`x:${key}`)) return;
      state.art.diffs[key] = { status: e instanceof NotFound ? "missing" : "error", data: null, error: errMsg(e) };
      rerender();
    });
}
/** The ticket detail's Artifacts block: `GET /api/artifacts?ticket=<id>`. */
function loadTicketArtifacts(id: number): void {
  const seq = nextArtSeq(`t:${id}`);
  const cur = state.art.ticketArts[id];
  state.art.ticketArts[id] = { status: "loading", data: cur?.data ?? null };
  listArtifacts({ ticket: id })
    .then((rows) => { if (seq !== artSeq.get(`t:${id}`)) return; state.art.ticketArts[id] = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== artSeq.get(`t:${id}`)) return;
      state.art.ticketArts[id] = { status: "error", data: state.art.ticketArts[id]?.data ?? null, error: errMsg(e) };
      rerender();
    });
}
/** Every ticket (seg=all) — the attach dialog's list and the library's ticket search. */
function loadAttachTickets(): void {
  const cur = state.art.attachTickets;
  if (cur.status === "ok" || cur.status === "loading") return;
  const seq = nextArtSeq("tix");
  state.art.attachTickets = { status: "loading", data: cur.data };
  listTickets({ seg: "all" })
    .then((rows) => {
      if (seq !== artSeq.get("tix")) return;
      state.art.attachTickets = { status: "ok", data: rows.map((t) => ({ id: t.id, title: t.title, status: t.status })) };
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== artSeq.get("tix")) return;
      state.art.attachTickets = { status: "error", data: state.art.attachTickets.data, error: errMsg(e) };
      rerender();
    });
}
/** Load what the current Artifacts screen reads. `fresh` refetches (keeping what is
 *  on screen) — used on navigation and after a write; a plain rerender never refetches. */
function loadArtifactsIfNeeded(fresh = false): void {
  const r = state.artRoute;
  if (state.screen === "artifacts") { loadArtifactList(fresh); loadSprintsIfNeeded(); loadAttachTickets(); }
  else if (state.screen === "artifactnew") loadSprintsIfNeeded();
  else if (state.screen === "artifact" && r.slug) {
    loadSprintsIfNeeded();
    loadAttachTickets();
    if (r.diff) {
      loadArtifactDetail(r.slug, null, fresh);
      if (r.diff.a !== r.diff.b) loadArtifactDiff(r.slug, r.diff.a, r.diff.b, fresh);
    } else loadArtifactDetail(r.slug, r.v, fresh);
  }
  rerender();
}
function goArt(screen: ArtScreen, route: ArtRoute = ART_ROUTE_NONE): void {
  state.screen = screen;
  state.artRoute = route;
  state.art.verMenu = false; state.art.dotMenu = false; state.art.ratifyOpen = false; state.art.attachOpen = false; state.art.filterOpen = false;
  state.art.nv = null;
  if (!state.art.deleteBusy) state.art.deleteArm = false;
  loadArtifactsIfNeeded(true);
  document.getElementById("cnpy-main")?.scrollTo(0, 0);
}
/** After a write to `slug`: drop its other cached versions and diffs, refetch what
 *  is on screen (keeping it visible), and let the list / ticket blocks reload. */
function refreshArt(slug: string): void {
  const r = state.artRoute;
  const keep = r.slug === slug ? detailKey(slug, r.diff ? null : r.v) : null;
  for (const k of Object.keys(state.art.details)) if (k.startsWith(`${slug}@`) && k !== keep) delete state.art.details[k];
  for (const k of Object.keys(state.art.diffs)) if (k.startsWith(`${slug}:`)) delete state.art.diffs[k];
  state.art.ticketArts = {};
  if (state.art.list.status !== "idle") loadArtifactList(true);
  if (state.screen === "artifact" && r.slug === slug) loadArtifactsIfNeeded(true);
  else rerender();
}
function runArtWrite(w: ArtWrite): void {
  const c = state.art.c;
  if (w.op === "fetchUrl") {
    fetchArtifactUrl(w.url)
      .then((dto) => {
        c.fetching = false;
        if (c.url.trim() !== w.url) { rerender(); return; } // the URL changed while fetching
        c.urlFetched = { text: dto.content };
        if (dto.kind) c.kind = dto.kind;
        rerender();
      })
      .catch((e) => {
        if (e instanceof Unauthorized) { unauth(e); return; }
        c.fetching = false;
        c.urlErr = e instanceof ApiError ? `Couldn't fetch that page (${e.message}).` : "Couldn't fetch that page.";
        rerender();
      });
    rerender();
    return;
  }
  if (w.op === "create") {
    const body = w.file ? { file: w.file, filename: w.filename ?? "upload" } : { content: w.content ?? "" };
    createArtifact(w.fields, body)
      .then(async (d) => {
        // Links are posted one by one after the page exists; a refused one is named, never fatal.
        let failed = 0;
        for (const l of w.links) {
          try { await addArtifactLink(d.slug, l.target_type, l.target_ref); } catch (e) { if (e instanceof Unauthorized) throw e; failed++; }
        }
        state.art.c = { ...initialArtCreate(primaryRepoName()), repo: c.repo, area: c.area, vis: c.vis };
        state.art.ticketArts = {};
        if (state.art.list.status !== "idle") state.art.list = { status: "idle", data: state.art.list.data };
        goArt("artifact", { slug: d.slug, v: null, diff: null });
        flash(failed ? `Uploaded v1 · ${failed} link${failed === 1 ? "" : "s"} couldn't be added` : "Uploaded v1");
      })
      .catch((e) => {
        if (e instanceof Unauthorized) { unauth(e); return; }
        state.art.c.submitting = false;
        flash(e instanceof ApiError ? `Upload failed: ${e.message}` : "Upload failed");
      });
    rerender();
    return;
  }
  if (w.op === "version") {
    addArtifactVersion(w.slug, w.body)
      .then((res) => {
        const r = res as { unchanged?: boolean; version_no?: number };
        state.art.nv = null;
        // Land on the latest (the new version): refreshArt drops every other cached version and
        // refetches the one the route names, keeping the old body on screen until it lands.
        state.artRoute = { slug: w.slug, v: null, diff: null };
        refreshArt(w.slug);
        flash(r.unchanged ? "No change: identical to the latest version" : `Saved v${r.version_no ?? ""}`.trim());
      })
      .catch((e) => {
        if (e instanceof Unauthorized) { unauth(e); return; }
        if (state.art.nv) state.art.nv.submitting = false;
        if (e instanceof NotFound) { state.art.nv = null; refreshArt(w.slug); flash("This artifact isn't available anymore"); return; }
        flash(e instanceof ApiError ? `Couldn't save the version (${e.message})` : "Couldn't save the version");
      });
    rerender();
    return;
  }
  // Delete (author / admin only — the server re-checks): the in-app confirm already ran;
  // back to the library with a "Deleted “…” · Undo" toast whose Undo restores it.
  if (w.op === "delete") {
    deleteArtifact(w.slug)
      .then((r) => {
        state.art.deleteArm = false; state.art.deleteBusy = false;
        for (const k of Object.keys(state.art.details)) if (k.startsWith(`${r.slug}@`)) delete state.art.details[k];
        for (const k of Object.keys(state.art.diffs)) if (k.startsWith(`${r.slug}:`)) delete state.art.diffs[k];
        state.art.ticketArts = {};
        state.art.list = { status: "idle", data: (state.art.list.data ?? []).filter((x) => x.slug !== r.slug) };
        goArt("artifacts", ART_ROUTE_NONE);
        flash(`Deleted “${r.title}”`, UNDO_TOAST_MS, { label: "Undo", act: "artRestore", arg: r.slug });
      })
      .catch((e) => {
        state.art.deleteArm = false; state.art.deleteBusy = false;
        if (e instanceof Unauthorized) { unauth(e); return; }
        if (e instanceof NotFound) { refreshArt(w.slug); flash("This artifact isn't available anymore"); return; }
        writeErr(e, "Couldn't delete the artifact");
      });
    rerender();
    return;
  }
  if (w.op === "restore") {
    state.toast = null; state.toastAction = null;
    restoreArtifact(w.slug)
      .then((d) => {
        state.art.ticketArts = {};
        if (state.art.list.status !== "idle" || state.screen === "artifacts") loadArtifactList(true);
        flash(`Restored “${d.title}”`);
      })
      .catch((e) => writeErr(e, "Couldn't restore the artifact"));
    rerender();
    return;
  }
  state.art.busy = true;
  rerender();
  const req = w.op === "patch" ? patchArtifact(w.slug, w.body)
    : w.op === "ratify" ? ratifyArtifact(w.slug, w.version)
      : addArtifactLink(w.slug, w.target_type, w.target_ref);
  req
    .then(() => {
      state.art.busy = false;
      if (w.op === "ratify") state.art.ratifyOpen = false;
      if (w.op === "link") { state.art.attachOpen = false; state.art.attachPick = null; }
      refreshArt(w.slug);
      flash(w.flash, "flashMs" in w ? w.flashMs : undefined);
    })
    .catch((e) => {
      state.art.busy = false;
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (e instanceof NotFound) { state.art.ratifyOpen = false; state.art.attachOpen = false; refreshArt(w.slug); flash("This artifact isn't available anymore"); return; }
      flash(e instanceof ApiError ? `Couldn't update the artifact (${e.message})` : "Couldn't update the artifact");
    });
}
/** Carry out what the Artifacts reducer could not do itself. */
function runArtEffect(fx: ArtEffect): void {
  // The attach dialog lists every ticket; fetch them the first time it opens.
  if (state.art.attachOpen) loadAttachTickets();
  if (!fx) { rerender(); return; }
  if ("nav" in fx) { goArt(fx.nav.screen, fx.nav.route); return; }
  if ("flash" in fx) { flash(fx.flash); return; }
  if ("write" in fx) { runArtWrite(fx.write); return; }
  if ("retry" in fx) { loadArtifactsIfNeeded(true); return; }
  // The delete confirm: focus Cancel when it opens, the trigger (the … button) when it closes.
  if ("focus" in fx) { rerender(); mount.querySelector<HTMLElement>(fx.focus)?.focus(); return; }
  if ("copy" in fx) {
    navigator.clipboard?.writeText(fx.copy.text).catch(() => undefined);
    flash(fx.copy.flash);
    return;
  }
  // Open in new tab / Download raw both go to the raw route (it sets the headers).
  if ("openUrl" in fx) window.open(fx.openUrl, "_blank", "noopener");
  else if ("download" in fx) {
    const el = document.createElement("a");
    el.href = fx.download.url; el.download = fx.download.name; el.rel = "noopener";
    document.body.appendChild(el); el.click(); el.remove();
  }
  rerender();
}
/** A picked or dropped file for the new-artifact form, or (`"nv"`) the viewer's New
 *  version dialog. The kind follows the extension (kindForFilename): a binary kind
 *  keeps the File for the multipart upload; a text kind is read as text (past 3 MB
 *  only the first 200 KB — enough to preview; the cap check uses the file's real
 *  size, so it can't be sent). The dialog's page kind is fixed, and
 *  artAcceptNvFile refuses a file from the other side of it. */
function readArtFile(file: File | undefined | null, target: "create" | "nv" = "create"): void {
  if (!file) return;
  const accept = (f: ArtFile) => {
    if (target === "create") artAcceptFile(state.art, f);
    else {
      const d = state.art.details[detailKey(state.artRoute.slug ?? "", state.artRoute.v)]?.data;
      if (d) artAcceptNvFile(state.art, d.kind, f);
    }
    rerender();
  };
  if (isBinaryKind(kindForFilename(file.name))) {
    accept({ name: file.name, size: file.size, text: null, blob: file });
    return;
  }
  const r = new FileReader();
  r.onload = () => accept({ name: file.name, size: file.size, text: String(r.result ?? ""), blob: null });
  r.readAsText(file.size > 3 * 1024 * 1024 ? file.slice(0, 200 * 1024) : file);
}
// A framed HTML artifact reports its height (the raw route injects the script):
// ONE listener, matched to the frame by `e.source`, resizes the box directly —
// no rerender (which would rebuild, and so reload, the frame).
window.addEventListener("message", (e) => {
  const data = e.data as { type?: unknown; height?: unknown } | null;
  if (!data || typeof data !== "object" || data.type !== "trov:height") return;
  const h = Number(data.height);
  if (!Number.isFinite(h) || h <= 0) return;
  for (const frame of Array.from(mount.querySelectorAll<HTMLIFrameElement>(".art-frame iframe"))) {
    if (!e.source || e.source !== frame.contentWindow) continue;
    const box = frame.parentElement;
    if (box) box.style.height = `${setArtFrameHeight(box.dataset.artKey ?? "", h)}px`;
  }
});

/** A toast. `action` puts one button on it (a delete's "Undo"); a newer flash replaces both. */
function flash(msg: string, ms = 2200, action: ToastAction | null = null): void {
  const at = Date.now();
  state.toast = msg;
  state.toastAction = action;
  state.toastAt = at;
  state.toastMs = ms;
  rerender();
  // Only clear the toast this call put up — a newer flash keeps its own full time.
  setTimeout(() => { if (state.toastAt === at) { state.toast = null; state.toastAction = null; rerender(); } }, ms);
}
/** How long a toast carrying an Undo stays up — long enough to read it and reach the button. */
const UNDO_TOAST_MS = 8000;
/** The confirmation modal's exit (trov.css `.cnpy-cmodal[data-closing]`), then `then` — which
 *  closes it in state. Instant under prefers-reduced-motion or when no modal is open. */
const CONFIRM_OUT_MS = 140;
function confirmOut(then: () => void): void {
  const layer = mount.querySelector<HTMLElement>("[data-confirm-layer]");
  if (layer?.hasAttribute("data-closing")) return; // already on its way out
  if (!layer || matchMedia("(prefers-reduced-motion: reduce)").matches) { then(); return; }
  layer.setAttribute("data-closing", "");
  setTimeout(then, CONFIRM_OUT_MS);
}

// ── Platform (superadmin): its loads and acts live in platform-actions.ts ────
const platform = createPlatform({
  state, mount, rerender, flash, unauth, confirmOut, reloadOrgs: () => loadMyOrgs(),
  // Not a superadmin after all (a stale #platform link): My Work, as for any unknown hash.
  // On the standalone page there is no My Work to fall back to: the picker.
  leave: () => { if (state.view === "platform") { showPicker(null); return; } state.screen = "mywork"; loadForScreen("mywork"); },
});

// Drives a (possibly multi-batch) Sync GitHub run: the backend caps AI calls
// per invocation (src/tools/backfill.ts's summaryBudgetExhausted), so this
// keeps calling adminBackfill(batch, of) while a budget was exhausted, updating
// state.backfillSync after every batch — both PR and issue counts are
// absolute snapshots from the response, not accumulated here, so the modal's
// progress bars always reflect real server-side state. MAX_BACKFILL_BATCHES
// is a client-side backstop against spinning forever if summaries never
// converge (e.g. every AI call keeps falling back to excerpt) — the batch/of
// pair we send lets the server reconcile on the batch that hits this cap too.
const MAX_BACKFILL_BATCHES = 10;

async function runAdminBackfillLoop(): Promise<void> {
  let summarizedSoFar = 0;
  let batchesSoFar = 0;
  let last: Awaited<ReturnType<typeof adminBackfill>> | null = null;
  try {
    do {
      batchesSoFar++;
      // 1-based batch number + the cap, so the server can reconcile on the
      // batch that hits MAX_BACKFILL_BATCHES even while still exhausted (it
      // has no other way to see this client-side loop counter).
      last = await adminBackfill(batchesSoFar, MAX_BACKFILL_BATCHES);
      summarizedSoFar += last.summarized;
      state.backfillSync = {
        phase: "progress",
        prSummarizedCount: last.prSummarizedCount,
        prsTotal: last.prs,
        issueSummarizedCount: last.issueSummarizedCount,
        issuesTotal: last.issuesToSummarize,
      };
      rerender();
    } while (last.summaryBudgetExhausted && batchesSoFar < MAX_BACKFILL_BATCHES);

    state.backfillSync = null;
    const more = last.summaryBudgetExhausted ? " — more remain, click Sync again" : "";
    flash(`Synced: ${last.captured} captured, ${last.unchanged} unchanged, ${summarizedSoFar} summaries updated${more}`);
    loadMyWork();
  } catch (e) {
    state.backfillSync = null;
    if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
    // 503 `service token or repo not configured`: THIS org has no repository or no GitHub token yet — a setup step, not a failure.
    if (e instanceof ApiError && e.status === 503 && /not configured/i.test(e.message)) {
      flash("This organization has no repository or GitHub token yet, so there is nothing to sync.", 9000, { label: "Open Org settings", act: "orgGo", arg: "integrations" });
    } else flash(e instanceof ApiError ? e.message : "Sync failed");
    rerender();
  }
}

// Copy text to the clipboard. Prefers the async Clipboard API (available on
// localhost + https); falls back to a hidden-textarea execCommand for older or
// non-secure contexts. Resolves to whether the copy succeeded.
function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ── onboarding: debounced, sequence-guarded handle availability check ────────
let handleCheckTimer: number | null = null;
let handleCheckSeq = 0;
function scheduleHandleCheck(): void {
  if (handleCheckTimer !== null) clearTimeout(handleCheckTimer);
  const seq = ++handleCheckSeq;
  const h = state.onboard.handle;
  if (!h) return;
  handleCheckTimer = window.setTimeout(() => {
    checkHandle(h)
      .then((r) => { if (seq !== handleCheckSeq) return; state.onboard.check = r.available ? "available" : (r.reason ?? "invalid"); rerender(); })
      // The check is limited per person: say when it can be asked again, rather than going quiet.
      .catch((e) => { if (seq !== handleCheckSeq) return; state.onboard.check = "idle"; if (isRateLimited(e)) state.onboard.error = rateLimitText(e); rerender(); });
  }, 250);
}

// ── Settings › Profile: debounced, sequence-guarded rename-target check ──────
// Mirrors scheduleHandleCheck above (same debounce + sequence-guard shape),
// targeting the rename draft instead of the onboarding handle.
let renameCheckTimer: number | null = null;
let renameCheckSeq = 0;
function scheduleRenameCheck(): void {
  if (renameCheckTimer !== null) clearTimeout(renameCheckTimer);
  const seq = ++renameCheckSeq;
  const h = state.handleDraft;
  if (!h) return;
  renameCheckTimer = window.setTimeout(() => {
    checkHandle(h)
      .then((r) => { if (seq !== renameCheckSeq) return; state.handleCheck = r.available ? "available" : (r.reason ?? "invalid"); rerender(); })
      .catch((e) => { if (seq !== renameCheckSeq) return; state.handleCheck = "idle"; if (isRateLimited(e)) flash(rateLimitText(e) ?? "", 7000); else rerender(); });
  }, 250);
}

// ── action dispatch ──────────────────────────────────────────────────────────
// `caret` is the text cursor of the field that produced the event (the input
// delegate passes `selectionStart` for inputs/textareas). Only the @mention
// picker needs it; every other case ignores it.
function dispatch(act: string, arg: string | null, value: string | null, caret: number | null = null): void {
  switch (act) {
    // auth state navigation (how the screens become reachable)
    case "signIn":
      // Return-to: the hash never reaches the server, so stash it for the boot
      // after /auth/callback lands on "/" (an email deep link survives sign-in).
      // Not #site: that IS the landing page, and returning to it strands them outside the app.
      // The org they were on (`/o/<slug>/`) is stashed the same way: the callback lands on "/".
      try {
        if (location.hash && location.hash !== "#site") sessionStorage.setItem(RETURN_HASH_KEY, location.hash);
        const from = orgSlugFromPath(location.pathname);
        if (from) sessionStorage.setItem(RETURN_ORG_KEY, from);
      } catch { /* ignore */ }
      window.location.href = "/auth/login";
      return;
    case "signInGoogle":
      try {
        if (location.hash && location.hash !== "#site") sessionStorage.setItem(RETURN_HASH_KEY, location.hash);
        const from = orgSlugFromPath(location.pathname);
        if (from) sessionStorage.setItem(RETURN_ORG_KEY, from);
      } catch { /* ignore */ }
      window.location.href = "/auth/google/login";
      return;
    case "signInGoogleSwitch": window.location.href = "/auth/google/login?prompt=select_account"; return;
    case "onbHandle": {
      state.onboard.handle = (value ?? "").trim();
      state.onboard.check = state.onboard.handle ? "checking" : "idle";
      scheduleHandleCheck();
      rerender();
      return;
    }
    case "onbName": state.onboard.name = value ?? ""; rerender(); return;
    case "onbColor": if (arg && (PERSON_COLORS as readonly string[]).includes(arg)) state.onboard.color = arg as PersonColor; break;
    case "onbSubmit": {
      const o = state.onboard;
      if (o.check !== "available" || o.submitting) return;
      o.submitting = true; o.error = null; rerender();
      submitOnboard({ handle: o.handle, name: o.name.trim() || null, color: o.color })
        // A brand-new person lands on Get Started, not My Work: the projection is
        // empty on day one, and this is the one moment they are guaranteed to be
        // new. The boot path restores the route from the hash, so #guide is all
        // it takes. Every later sign-in goes wherever their hash points.
        // Signed up from an MCP client's authorize link → back to the consent screen
        // (a same-origin path the Worker built); otherwise Get Started, as before.
        .then((r) => { window.location.href = r.redirect?.startsWith("/oauth/authorize?") ? r.redirect : "/#guide"; })
        .catch((e) => {
          o.submitting = false;
          if (e instanceof ApiError && e.message === "handle_taken") { o.check = "taken"; }
          else if (e instanceof ApiError && e.message === "invite_revoked") { o.error = "This invite was revoked. Ask an admin to invite you again."; }
          else if (e instanceof Unauthorized) { o.error = "This sign-in expired. Start again."; }
          else { o.error = "Couldn't finish sign-up. Try again."; }
          rerender();
        });
      return;
    }
    // Landing page (signed out): the Sign in dialog, and in-page jumps. The jumps
    // scroll instead of setting location.hash — the hash is the route and the
    // sign-in return-to, and must survive a browse of the landing page.
    case "openSignIn":
      state.signInOpen = true;
      rerender();
      mount.querySelector<HTMLElement>('[role="dialog"] [data-act="signIn"]')?.focus();
      return;
    case "closeSignIn": state.signInOpen = false; break;
    // The landing's "Get started": signed in, straight to the guide; signed out, the
    // guide becomes the sign-in return-to (replaceState: no hashchange, no route) and
    // the Sign in dialog opens.
    case "siteGuide":
      if (state.me) {
        state.siteReturn = null;
        const guide = parseHash("#guide");
        applyRoute(guide);
        loadForScreen(guide.screen);
        window.scrollTo(0, 0);
        return;
      }
      history.replaceState(null, "", `${location.pathname}#guide`);
      dispatch("openSignIn", null, null);
      return;
    case "siteJump": {
      const behavior: ScrollBehavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      if (arg === "top") window.scrollTo({ top: 0, behavior });
      else document.getElementById(`site-${arg}`)?.scrollIntoView({ behavior, block: "start" });
      return;
    }
    case "backToLogin":
      state.authStep = "login";
      history.replaceState({}, "", "/");
      break;
    case "signOut": {
      // A deliberate exit lands on the bare landing page: drop the route hash, or the
      // URL stays /#settings and the next sign-in would treat it as a return-to.
      const leave = () => {
        setApiOrg(null);
        state.orgSlug = null; state.orgsUi = initialOrgsUi();
        state.view = "auth"; state.authStep = "login";
        history.replaceState(null, "", "/");
        rerender();
        window.scrollTo(0, 0);
      };
      logout().then(() => { state.me = null; leave(); }).catch(leave);
      return;
    }

    // The sidebar logo reopens the landing page (#site); its nav button comes back to
    // wherever the logo was clicked from (My Work after a reload straight onto #site).
    case "goSite":
      state.siteReturn = currentRoute();
      state.screen = "site";
      rerender();
      window.scrollTo(0, 0);
      return;
    case "siteBack": {
      const back = state.siteReturn ?? parseHash("");
      state.siteReturn = null;
      applyRoute(back);
      loadForScreen(back.screen);
      return;
    }

    // primary navigation
    case "goMyWork": state.screen = "mywork"; loadMyWorkIfNeeded(); return;
    case "mwRepoTab":
      if (!(MW_REPO_TABS as readonly string[]).includes(arg ?? "") || arg === state.mwRepoTab) return;
      state.mwRepoTab = arg as MwRepoTab;
      pendingFlash = ".mw-repo-swap";
      break;
    // Tickets for you › "N more in the queue": the queue, filtered to my tickets.
    case "mwAllTickets":
      state.screen = "tickets"; state.ticketId = null;
      state.qAssignee = "me"; state.qPerson = "";
      loadSprintsIfNeeded(); loadTickets();
      return;
    case "mwMore":
      if (arg !== "tickets") return;
      state.mwExpanded = { ...state.mwExpanded, [arg]: !state.mwExpanded[arg] };
      break;
    case "mwOpenReview":
      if (!arg) return;
      state.reviewSel = arg;
      state.screen = "review";
      loadProposalsIfNeeded(); loadDraftAdrsIfNeeded();
      return;
    case "goArtifacts": goArt("artifacts"); return;
    case "fmToggle": case "fmClose": case "fmCat": filterMenuAct(act, arg); return;

    // ── Repo dashboard ───────────────────────────────────────────────────────
    // `arg` = the tab to land on (quick search's "Repo › …" entries); none = Overview.
    case "goRepo": state.screen = "repo"; state.repoTab = arg && isRepoTab(arg) ? arg : "overview"; loadRepoIfNeeded(); return;
    // The page's tab bar: the one dashboard payload covers every tab, so a switch is ONE
    // rerender with nothing to load — goRepo's load would rebuild the bar and cut its slide.
    // The entrance is not replayed (markEnter), so the new tab's content flashes in instead:
    // a short rise, and its sparklines / fills / bars grow again.
    case "setRepoTab": {
      const tab = arg ?? "";
      if (!isRepoTab(tab) || tab === state.repoTab) return;
      state.repoTab = tab;
      pendingFlash = ".repo-panel > :not(.repo-poll-strip)";
      break;
    }
    case "repoRefresh": if (state.repo.status !== "loading") loadRepo(); return;
    case "repoRange":
      if (!(REPO_RANGES as readonly string[]).includes(arg ?? "") || arg === state.repoRange) return;
      state.repoRange = arg as RepoRange;
      pendingFlash = ".repo-swap";
      break;
    case "repoProductEnv":
      // Session-only, like the range. Only the Product body cross-fades — never the whole screen.
      if (!arg || arg === state.repoProductEnv) return;
      state.repoProductEnv = arg;
      pendingFlash = ".repo-pswap";
      break;
    case "repoToggleDrift":
      state.repoDriftOpen = !state.repoDriftOpen;
      if (state.repoDriftOpen) pendingFlash = ".repo-drift";
      break;
    case "repoPollNow": runRepoPoll(); return;
    case "repoPollDismiss": state.repoPoll = null; break;
    case "repoSampleOn":
    case "repoSampleOff":
      state.repoSample = act === "repoSampleOn";
      state.repoPoll = null; // a poll result describes the LIVE sources, not the sample set
      state.repo = { status: "idle", data: null };
      state.repoDriftOpen = false;
      loadRepo();
      return;

    // ── sidebar: sub-page lists + the search box ─────────────────────────────
    case "navToggle": {
      const g = NAV_GROUPS.find((k) => k === arg);
      if (!g) return;
      state.navOpen[g] = !state.navOpen[g];
      if (autoOpened === g) autoOpened = null;   // a hand on the chevron makes it theirs
      persistNavOpen();
      break;
    }
    case "navSub": {
      // `<group>:<page>` — each page is an existing destination, reached in one click.
      const [g, page = ""] = (arg ?? "").split(":");
      if (g === "docs") { state.screen = "docs"; dispatch("setDocSpace", page, null); loadDocsIfNeeded(); return; }
      return;
    }
    // Uncontrolled: the box holds its own text; each keystroke feeds the search
    // dropdown (web/src/quicksearch.ts), which patches only its own panel — never a rerender.
    case "sideSearch": {
      const box = mount.querySelector<HTMLInputElement>('[data-field="sideSearch"]');
      if (box) qs.input(box, value ?? "");
      return;
    }
    case "sideSearchFocus": {
      // A collapsed (or narrow) rail has no box to type in: ⌘K / the icon open the
      // centered command palette instead.
      if (state.collapsed || state.narrow) { qs.openPalette(); return; }
      mount.querySelector<HTMLInputElement>('[data-field="sideSearch"]')?.focus();
      return;
    }
    case "goFeed": state.screen = "feed"; loadFeedIfNeeded(); loadFeedStats(); return;

    // ── The person card: a click on anyone's name (the rail, the Feed, quick search,
    // Maintenance › People) opens it over the page; the backdrop, × and Escape close it.
    case "openPerson": if (!arg) return; openPersonCard(arg); return;
    case "personCardClose": state.personCard = null; break;
    case "goDocs": state.screen = "docs"; loadDocsIfNeeded(); return;
    case "goRoadmap": state.screen = "roadmap"; state.sprintId = null; loadRoadmapIfNeeded(); loadRoadmapFeed(); return;

    // ── Tickets: navigation ──────────────────────────────────────────────────
    case "goTickets": state.screen = "tickets"; state.ticketId = null; loadSprintsIfNeeded(); loadTicketsIfNeeded(); return;
    case "newTicket":
      state.screen = "newticket";
      state.fTitle = ""; state.fCat = null; state.fPrio = "normal";
      state.fDesc = ""; state.fAsgs = []; state.fLink = ""; state.fSpr = null;
      state.sprMenu = false;          // the form's sprint picker shares the rail's flag
      loadSprintsIfNeeded();
      break;
    // The header breadcrumb's back button — one act, resolved against the screen
    // it was clicked from (the design's single `back` handler).
    case "ticketsBack":
      if (state.screen === "sprint") { state.screen = "roadmap"; state.sprintId = null; loadRoadmapIfNeeded(); loadRoadmapFeed(); return; }
      state.screen = "tickets"; state.ticketId = null; loadSprintsIfNeeded(); loadTicketsIfNeeded(); return;
    // Also the act the Search screen's ticket cards have emitted since Phase 2.
    case "openTicket": {
      const id = Number(arg);
      if (!Number.isInteger(id)) return;
      state.screen = "ticketdetail";
      state.ticketId = id;
      state.commentDraft = ""; state.mention = null; state.commentHeight = null; state.linkDraft = "";
      state.lkOpen = false; state.asgMenu = false; state.sprMenu = false; state.relMenu = false; state.lkMenu = null; state.stMenu = null;
      state.tdEdit = null; state.tdDeleteArm = false; state.tdDeleteBusy = false;
      loadSprintsIfNeeded();
      loadTicketsIfNeeded();          // backs the sub-ticket candidate menu
      loadTicketDetail(id);
      return;
    }
    case "openSprint": {
      const id = Number(arg);
      if (!Number.isInteger(id)) return;
      state.screen = "sprint";
      state.sprintId = id;
      state.linkDraft = "";           // the rail's "Add a URL…" box shares this draft
      loadSprintsIfNeeded();
      loadSprintDetail(id);
      return;
    }

    // ── Roadmap: the New sprint panel (design 156–197) ───────────────────────
    case "nsToggle": state.nsOpen = !state.nsOpen; state.nsError = null; break;
    case "nsField":
      if (arg === "start" || arg === "due") {
        // A native date field is NOT rerendered under the person: Chrome fires `input`
        // per segment once the date is whole (typing a year's digits one by one), and a
        // swap would throw the caret back to the first segment. Store the value, and
        // clear a shown refusal in place — it is re-checked on Create.
        if (arg === "start") state.nsStart = value ?? ""; else state.nsDue = value ?? "";
        if (state.nsError) {
          state.nsError = null;
          const err = mount.querySelector<HTMLElement>("[data-ns-error]");
          if (err) { err.textContent = ""; err.style.display = "none"; }
          for (const f of Array.from(mount.querySelectorAll<HTMLInputElement>('input[data-act="nsField"][type="date"]'))) {
            f.style.borderColor = ""; f.removeAttribute("aria-invalid"); f.removeAttribute("aria-describedby");
          }
        }
        return;
      }
      if (arg === "name") state.nsName = value ?? "";
      else if (arg === "desc") state.nsDesc = value ?? "";
      else return;
      break;                          // rerenders: "Create sprint" arms on a non-empty name
    case "nsUrg":
      if (arg && (SPRINT_URGENCIES as readonly string[]).includes(arg)) state.nsUrg = arg as SprintUrgency;
      break;
    case "nsLead":
      if (!arg) return;
      state.nsLead = state.nsLead === arg ? null : arg;   // single choice, click again to clear
      break;
    case "nsDom":
      if (!arg || !(SPRINT_DOMAINS as readonly string[]).includes(arg)) return;
      state.nsDom = state.nsDom === arg ? null : (arg as SprintDomain);
      break;
    case "nsCreate": {
      const label = state.nsName.trim();
      if (!label) return;             // the button is inert, but guard the dispatch too
      // The ONE sprint-date rule (shared/sprints-core), checked here before the POST —
      // the server applies the same one, and its 400 lands in the same place.
      const start = state.nsStart.trim() || null;
      const due = state.nsDue.trim() || null;
      const dateProblem = sprintDatesProblem({ start, due });
      // (The rule's "— nothing was written." tail is for API callers; the form never sent anything.)
      if (dateProblem) { state.nsError = dateProblem.replace(/ — nothing was written\.$/, "."); rerender(); return; }
      state.nsError = null;
      createSprint({
        label,
        summary: state.nsDesc.trim() || null,
        urgency: state.nsUrg,
        start,
        due,
        lead: state.nsLead,
        domain: state.nsDom,
      })
        .then((sp) => {
          state.nsOpen = false;
          state.nsName = ""; state.nsStart = ""; state.nsDesc = ""; state.nsError = null;
          state.nsUrg = "normal"; state.nsDue = ""; state.nsLead = null; state.nsDom = null;
          loadSprints();              // the queue's group headers + the form's chips read this
          loadRoadmap();              // the new card belongs on the timeline immediately
          flash(`${sp.label} created — it's on the Roadmap now`);
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          // A date refusal from the server reads under the dates, like the client's own.
          if (e instanceof ApiError && e.status === 400 && /\b(start|due)\b/.test(e.message)) { state.nsError = e.message; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not create the sprint");
        });
      return;
    }

    // ── Sprint screen ────────────────────────────────────────────────────────
    case "sprintActive": {
      const id = state.sprintId;
      if (id === null || (arg !== "0" && arg !== "1")) return;
      const active = arg === "1";
      setSprintActive(id, active)
        .then((sp) => {
          loadSprintDetail(id);
          loadSprints();
          if (state.roadmap.status !== "idle") loadRoadmap();
          flash(active ? `${sp.label} is active` : `${sp.label} is no longer active`);
        })
        .catch(sprintErr);
      return;
    }
    case "sprintDeleteArm": state.sprintDeleteArmed = true; rerender(); return;
    case "sprintDeleteCancel": state.sprintDeleteArmed = false; rerender(); return;
    case "sprintDelete": {
      const id = state.sprintId;
      if (id === null) return;
      deleteSprint(id)
        .then((r) => {
          state.sprintDeleteArmed = false;
          state.sprintDetail = { status: "idle", data: null };
          state.sprintId = null;
          state.screen = "roadmap";
          loadRoadmap();
          loadSprints();
          if (state.tickets.status !== "idle") loadTickets();
          flash(r.moved > 0
            ? `${r.label} deleted — ${r.moved} ticket${r.moved === 1 ? "" : "s"} moved to the backlog`
            : `${r.label} deleted`);
        })
        .catch(sprintErr);
      return;
    }
    case "sprintResourceDraft": state.linkDraft = value ?? ""; return;   // echoes live
    case "sprintResourceAdd": {
      const id = state.sprintId;
      const raws = splitLinks(state.linkDraft);
      if (id === null || !raws.length) return;
      raws.reduce<Promise<SprintDetail | null>>((prev, raw) => prev.then(() => addSprintResource(id, raw)), Promise.resolve(null))
        .then((sp) => {
          if (!sp) return;
          state.linkDraft = "";
          state.sprintDetail = { status: "ok", data: sp };
          // The server parses the raw input, so the toast names the STORED label.
          const last = raws[raws.length - 1];
          const added = sp.resources.find((r) => r.url === last) ?? sp.resources[sp.resources.length - 1];
          flash(raws.length > 1 ? `${raws.length} resources added` : added ? `Resource added: ${added.label}` : "Resource added");
        })
        .catch(sprintErr);
      return;
    }

    // ── Tickets: the queue's filters + view toggle (every filter refetches) ──
    case "queueSeg":
      if (arg === "open" || arg === "closed" || arg === "all") { state.qSeg = arg; loadTickets(); }
      return;
    // The queue's filter menu (tickets.ts `queueFilterMenu`, the shared filter-menu
    // registry opens/closes it): Assignee and Category refetch — the server filters
    // them — Priority, Sprint and the search box narrow the loaded rows.
    case "queueAssignee": {
      const v = arg ?? value ?? "";
      // "@<handle>" = one person: fetch everyone's (`anyone`), narrow client-side.
      if (v.startsWith("@") && v.length > 1) {
        state.qPerson = v.slice(1);
        if (state.qAssignee !== "anyone") { state.qAssignee = "anyone"; loadTickets(); return; }
        break;
      }
      if (v === "anyone" || v === "me" || v === "unassigned") {
        state.qPerson = "";
        if (state.qAssignee !== v) { state.qAssignee = v; loadTickets(); return; }
      }
      break;
    }
    case "queueCategory": {
      const v = arg ?? value ?? "all";
      if (v !== "all" && !(TICKET_CATEGORIES as readonly string[]).includes(v)) break;
      state.qCategory = v as TicketCategory | "all";
      loadTickets();
      break;
    }
    case "queuePriority":
      if (arg === "all" || (TICKET_PRIORITIES as readonly string[]).includes(arg ?? "")) state.qPrio = arg as TicketPriority | "all";
      break;
    case "queueSprint": if (arg) state.qSprint = arg; break;
    case "queueFilterClear": {
      const refetch = state.qAssignee !== "anyone" || state.qCategory !== "all";
      state.qAssignee = "anyone"; state.qCategory = "all"; state.qPrio = "all"; state.qSprint = "all"; state.qPerson = "";
      if (refetch) { loadTickets(); return; }
      break;
    }
    case "queueQ": state.qQ = value ?? ""; break;
    case "queueClearQ": state.qQ = ""; break;
    // A board card dropped on another column (the drag listeners below): the
    // SAME transition the detail screen's status menu sends. The card moves at
    // once — the refetch that follows replaces it with the server's truth, and a
    // refused move (the server's 409) snaps it back.
    case "queueDrop": {
      // `<id>:<status>:<after id or "">` — the card and the slot it was dropped
      // into. It lands there at once, placed by the SAME `placeInColumn` the Worker
      // uses; the refetch that follows replaces it with the server's truth, and a
      // refused move (the server's 409) puts it back.
      const [idStr, to, afterStr] = (arg ?? "").split(":");
      const id = Number(idStr);
      const afterId = afterStr ? Number(afterStr) : null;
      const t = state.tickets.data.find((r) => r.id === id);
      if (!t || !(TICKET_STATUSES as readonly string[]).includes(to)) return;
      const next = to as TicketStatus;
      if (next !== t.status && !canTransition(t.status, next)) return;
      const column = state.tickets.data.filter((r) => r.status === next && r.id !== id);
      const { rank, renumber } = placeInColumn(column, afterId);
      state.tickets = {
        ...state.tickets,
        data: state.tickets.data.map((r) =>
          r.id === id ? { ...r, status: next, board_rank: rank } : renumber?.has(r.id) ? { ...r, board_rank: renumber.get(r.id) as number } : r),
      };
      rerender();
      moveTicket(id, next, afterId)
        .then(() => { loadTickets(); loadTicketBadge(); if (next !== t.status) flash(`#${id} moved to ${TICKET_STATUS_LABEL[next]}`); })
        .catch((e) => { ticketErr(e); loadTickets(); });
      return;
    }
    case "queueTable": state.qView = "table"; break;
    case "queueBoard": state.qView = "board"; break;

    // ── Tickets: the new-ticket form ─────────────────────────────────────────
    case "ntTitle": state.fTitle = value ?? ""; break;   // rerenders: Submit arms on a non-empty title
    case "ntDescription": state.fDesc = value ?? ""; return;   // echoes live; nothing renders off it
    case "ntLink": state.fLink = value ?? ""; return;
    case "ntCategory":
      if (arg && (TICKET_CATEGORIES as readonly string[]).includes(arg)) state.fCat = arg as TicketCategory;
      break;
    case "ntPriority":
      if (arg && (TICKET_PRIORITIES as readonly string[]).includes(arg)) state.fPrio = arg as TicketPriority;
      break;
    // The form picks a sprint through the SAME menu as the ticket detail rail,
    // so it toggles the same open flag and closes on a pick.
    case "ntSprintMenu": state.sprMenu = !state.sprMenu; break;
    case "ntSprint":
      state.fSpr = arg ? Number(arg) : null;                         // "" = Backlog
      state.sprMenu = false;
      break;
    case "ntAssignee":
      if (arg === null) return;
      if (arg === "") state.fAsgs = [];                              // the "Unassigned" chip clears
      else state.fAsgs = state.fAsgs.includes(arg) ? state.fAsgs.filter((h) => h !== arg) : [...state.fAsgs, arg];
      break;
    case "ntSubmit": {
      const title = state.fTitle.trim();
      if (!title) return;                                            // the button is inert, but guard the dispatch too
      const link = state.fLink.trim();
      const assigned = state.fAsgs.map(personFirstName);
      createTicket({
        title,
        body: state.fDesc.trim(),
        category: state.fCat ?? "other",                             // no chip picked = `other`
        priority: state.fPrio,
        assignees: [...state.fAsgs],
        sprint_id: state.fSpr,
        ...(link ? { link } : {}),
      })
        .then(() => {
          state.fTitle = ""; state.fCat = null; state.fPrio = "normal";
          state.fDesc = ""; state.fAsgs = []; state.fLink = ""; state.fSpr = null;
          state.screen = "tickets"; state.ticketId = null;
          loadTickets();
          loadTicketBadge();
          flash(assigned.length
            ? `Ticket submitted — assigned to ${assigned.join(", ")}`
            : "Ticket submitted — it's in the queue for triage");
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not submit the ticket");
        });
      return;
    }

    // ── Tickets: the detail screen ───────────────────────────────────────────
    // The status control (the rail's STATUS row): the pill opens its menu, a row
    // sets the status. Opening it closes the assignee/sprint/relation menus.
    case "ticketStatusMenu":
      state.stMenu = state.stMenu ? null : "rail";
      state.asgMenu = false; state.sprMenu = false; state.relMenu = false; state.lkMenu = null;
      break;
    case "ticketStatus": {
      const id = state.ticketId;
      state.stMenu = null;
      if (id === null || !arg || !(TICKET_STATUSES as readonly string[]).includes(arg)) return;
      const to = arg as TicketStatus;
      const label = TICKET_STATUS_LABEL[to];
      const seq = claimTicketDetail();
      transitionTicket(id, to).then((t) => applyTicketWrite(t, `Status: ${label}`, seq)).catch(ticketErr);
      return;
    }
    case "ticketAsgMenu": state.asgMenu = !state.asgMenu; state.sprMenu = false; state.relMenu = false; state.lkMenu = null; state.stMenu = null; break;
    case "ticketSprintMenu": state.sprMenu = !state.sprMenu; state.asgMenu = false; state.relMenu = false; state.lkMenu = null; state.stMenu = null; break;
    case "ticketRelMenu": state.relMenu = !state.relMenu; state.asgMenu = false; state.sprMenu = false; state.lkMenu = null; state.stMenu = null; break;
    case "closeTicketMenus": state.asgMenu = false; state.sprMenu = false; state.relMenu = false; state.lkMenu = null; state.stMenu = null; break;
    // Assignment is immediate and reversible — no confirm step (design call #7).
    case "ticketAsgAdd": {
      const id = state.ticketId;
      if (id === null || !arg) return;
      state.asgMenu = false;
      const seq = claimTicketDetail();
      toggleTicketAssignee(id, arg, true).then((t) => applyTicketWrite(t, `Assigned to ${personName(arg)}`, seq)).catch(ticketErr);
      return;
    }
    case "ticketAsgRemove": {
      const id = state.ticketId;
      if (id === null || !arg) return;
      const seq = claimTicketDetail();
      toggleTicketAssignee(id, arg, false).then((t) => applyTicketWrite(t, `${personName(arg)} removed`, seq)).catch(ticketErr);
      return;
    }
    case "ticketSprintSet": {
      const id = state.ticketId;
      if (id === null) return;
      state.sprMenu = false;
      const sprintId = arg ? Number(arg) : null;
      if ((state.ticketDetail.data?.sprint?.id ?? null) === sprintId) break;   // already there — just close the menu
      const label = sprintId === null ? null : state.sprints.data.find((sp) => sp.id === sprintId)?.label ?? "";
      const seq = claimTicketDetail();
      setTicketSprint(id, sprintId)
        .then((t) => applyTicketWrite(t, label === null ? "Moved to Backlog" : `Moved to ${label}`, seq))
        .catch(ticketErr);
      return;
    }
    case "ticketRelAdd": {
      const id = state.ticketId;
      const child = Number(arg);
      if (id === null || !Number.isInteger(child)) return;
      state.relMenu = false;
      const seq = claimTicketDetail();
      setTicketParent(id, child)
        .then((t) => applyTicketWrite(t, "Added as sub-ticket — this ticket is now its parent", seq))
        .catch(ticketErr);
      return;
    }
    // Delete (a NATIVE ticket only — a mirrored one has no button, and the server
    // 403s it): the confirmation modal (Delete focused, so Enter confirms), then back
    // to the queue. A hard delete, so there is no Undo.
    case "ticketDeleteArm":
      if (state.ticketDetail.data?.source !== "canopy") return;
      state.tdDeleteArm = true;
      rerender();
      mount.querySelector<HTMLElement>("[data-confirm-focus]")?.focus();
      return;
    case "ticketDeleteCancel": {
      if (!state.tdDeleteArm || state.tdDeleteBusy) return;
      confirmOut(() => {
        state.tdDeleteArm = false;
        rerender();
        mount.querySelector<HTMLElement>("[data-confirm-trigger]")?.focus();
      });
      return;
    }
    case "ticketDelete": {
      const d = state.ticketDetail.data;
      if (!d || !state.tdDeleteArm || state.tdDeleteBusy) return;
      state.tdDeleteBusy = true;
      rerender();
      deleteTicket(d.id)
        .then((r) => {
          state.tdDeleteArm = false; state.tdDeleteBusy = false;
          state.ticketDetail = { status: "idle", data: null };
          state.tickets = { ...state.tickets, data: state.tickets.data.filter((x) => x.id !== r.id) };
          state.screen = "tickets"; state.ticketId = null;
          loadTickets();
          loadTicketBadge();
          flash(`Deleted #${r.id} “${r.title}”`);
        })
        .catch((e) => { state.tdDeleteBusy = false; state.tdDeleteArm = false; ticketErr(e); });
      return;
    }
    // The title/description editor (POST /tickets/:id/edit). A mirrored ticket's
    // title and body are Trov's after import, so it edits those too.
    case "ticketEdit": {
      const d = state.ticketDetail.data;
      if (!d) return;
      state.tdEdit = { title: d.title, body: d.body };
      break;
    }
    case "ticketEditTitle": if (state.tdEdit) state.tdEdit.title = value ?? ""; break;   // rerenders: Save arms on a non-empty title
    case "ticketEditBody": if (state.tdEdit) state.tdEdit.body = value ?? ""; return;   // echoes live
    case "ticketEditCancel": state.tdEdit = null; break;
    case "ticketEditSave": {
      const id = state.ticketId;
      const draft = state.tdEdit;
      const d = state.ticketDetail.data;
      if (id === null || !draft || !d || !draft.title.trim()) return;
      const patch: { title?: string; body?: string } = {};
      if (draft.title.trim() !== d.title) patch.title = draft.title.trim();
      if (draft.body !== d.body) patch.body = draft.body;
      if (patch.title === undefined && patch.body === undefined) { state.tdEdit = null; break; }
      const seq = claimTicketDetail();
      editTicket(id, patch)
        .then((t) => { state.tdEdit = null; applyTicketWrite(t, "Ticket updated", seq); })
        .catch(ticketErr);
      return;
    }
    case "ticketLinkToggle": state.lkOpen = !state.lkOpen; break;
    case "ticketLinkDraft": state.linkDraft = value ?? ""; return;   // echoes live
    case "ticketLinkAdd": {
      const id = state.ticketId;
      const raws = splitLinks(state.linkDraft);
      if (id === null || !raws.length) return;
      const seq = claimTicketDetail();
      // Several links pasted at once go in one after another; the field stays open
      // (and focused) so the next paste links too.
      raws.reduce<Promise<TicketDetail | null>>((prev, raw) => prev.then(() => addTicketLink(id, raw)), Promise.resolve(null))
        .then((t) => {
          if (!t) return;
          state.linkDraft = "";
          state.lkOpen = true;
          // The server parses the raw input, so the toast names the STORED label.
          const added = t.links[t.links.length - 1];
          applyTicketWrite(t, raws.length > 1 ? `Linked ${raws.length} items` : added ? `Linked: ${added.label}` : "Linked", seq);
        })
        .catch(ticketErr);
      return;
    }
    // A linked-work chip's ⋯ menu (Linear's pattern): the ⋯ toggles it, a
    // right-click on the chip opens it; it holds Copy link and Remove link.
    case "ticketLinkMenu":
    case "ticketLinkMenuOpen": {
      const linkId = Number(arg);
      if (!Number.isInteger(linkId)) return;
      state.lkMenu = act === "ticketLinkMenu" && state.lkMenu === linkId ? null : linkId;
      state.asgMenu = false; state.sprMenu = false; state.relMenu = false; state.stMenu = null;
      break;
    }
    case "ticketLinkCopy": {
      const url = state.ticketDetail.data?.links.find((l) => l.id === Number(arg))?.url;
      state.lkMenu = null;
      if (url) copyToClipboard(url).then((ok) => flash(ok ? "Link copied" : "Couldn't copy the link"));
      break;
    }
    case "ticketLinkRemove": {
      const id = state.ticketId;
      const linkId = Number(arg);
      state.lkMenu = null;
      if (id === null || !Number.isInteger(linkId)) break;
      const label = state.ticketDetail.data?.links.find((l) => l.id === linkId)?.label;
      const seq = claimTicketDetail();
      removeTicketLink(id, linkId).then((t) => applyTicketWrite(t, label ? `Removed link: ${label}` : "Link removed", seq)).catch(ticketErr);
      return;
    }
    case "ticketComment": {
      // rerenders: Post arms on non-empty, and the @mention picker opens/closes
      // purely as a function of where the caret now sits in the new text.
      state.commentDraft = value ?? "";
      const at = caret ?? state.commentDraft.length;
      const tok = mentionTokenAt(state.commentDraft, at);
      // Every keystroke re-aims at the top row: the list just changed under it.
      // `line` is the caret's line — the picker hangs under THAT line, so it
      // follows the writer down a multi-line draft.
      state.mention = tok
        ? { query: tok.query, start: tok.start, index: 0, line: caretLine(state.commentDraft, at) }
        : null;
      break;
    }
    // Committing a candidate — from a click on a row or Enter/Tab on the
    // textarea. The token's end is derivable from the token itself
    // (`@` + query), so this never has to read the live caret back.
    case "mentionPick": {
      const m = state.mention;
      if (!m || !arg) return;
      const next = applyMention(state.commentDraft, m.start, m.start + 1 + m.query.length, arg);
      state.commentDraft = next.text;
      state.mention = null;
      rerender();
      // rerender() restores focus + the OLD caret by data-field; put the caret
      // after the inserted "@handle " instead, so typing continues the sentence.
      const box = mount.querySelector<HTMLTextAreaElement>('[data-field="ticketComment"]');
      if (box) {
        box.focus();
        try { box.setSelectionRange(next.caret, next.caret); } catch { /* not a text field */ }
      }
      return;
    }
    case "ticketCommentPost": {
      const id = state.ticketId;
      const body = state.commentDraft.trim();
      if (id === null || !body) return;
      const seq = claimTicketDetail();
      addTicketComment(id, body)
        .then((t) => { state.commentDraft = ""; state.mention = null; state.commentHeight = null; applyTicketWrite(t, "Comment posted", seq); })
        .catch(ticketErr);
      return;
    }

    // The Roadmap's tab bar: both tabs read the roadmap already loaded, so a switch is ONE
    // rerender and nothing to load — the underline slides unbroken. `roadmapTimeline` is
    // quick search's "Roadmap › Timeline" step (after goRoadmap).
    case "setRoadmapTab":
      if (arg !== "narrative" && arg !== "timeline") return;
      state.roadmapTab = arg;
      break;
    case "roadmapTimeline": state.roadmapTab = "timeline"; break;
    case "goReview": state.screen = "review"; loadProposalsIfNeeded(); loadDraftAdrsIfNeeded(); return;
    case "goMaintenance":
      state.screen = "maintenance";
      state.maintTab = arg === "identity" || arg === "people" ? arg : "unplaced";
      state.maintDiscardArm = false;
      loadNeedsTriageIfNeeded(); loadIdentityTasksIfNeeded(); loadFeedIfNeeded(); loadNotifAdminIfNeeded();
      return;
    // The page's tab bar: entering Maintenance already loaded every tab, so a switch is ONE
    // rerender — goMaintenance's several would each rebuild the bar and cut its slide.
    case "setMaintTab":
      if (!(MAINT_TABS as readonly string[]).includes(arg ?? "")) return;
      state.maintTab = arg as MaintTab;
      state.maintDiscardArm = false;
      break;
    case "goSearch": state.screen = "search"; loadSearchIfNeeded(); return;
    case "goSettings": state.screen = "settings"; state.personCard = null; state.mcpSetup = false; state.unsub.preview = false; state.grantRevokeArm = null; loadGrantsIfNeeded(); loadNotifPrefsIfNeeded(); checkLinkConflict(); return;
    case "goGuide": state.screen = "guide"; break;
    // Help › What's new (static data, nothing to load). `arg` "patches" opens Patch notes.
    case "goReleases": state.screen = "releases"; state.releaseVersion = null; state.releasePage = "notes"; document.getElementById("cnpy-main")?.scrollTo(0, 0); break;
    // One release's page (arg = its slug, "0.14" / "unreleased"), and its notes / patches switch.
    case "openRelease": if (!arg) return; state.screen = "releases"; state.releaseVersion = arg.toLowerCase(); state.releasePage = "notes"; document.getElementById("cnpy-main")?.scrollTo(0, 0); break;
    case "releasePage": state.releasePage = arg === "patches" ? "patches" : "notes"; document.getElementById("cnpy-main")?.scrollTo(0, 0); break;
    // A change count on a release's notes (At a glance): open its patch notes at that group.
    case "releaseGroup": {
      state.releasePage = "patches";
      rerender();
      const pane = document.getElementById("cnpy-main");
      const target = arg ? document.getElementById(`relgroup-${arg}`) : null;
      if (pane) pane.scrollTop = target ? Math.max(0, target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 24) : 0;
      return;
    }

    // chrome: theme + sidebar
    // The phone drawer (the rail at phone width). It closes on its own on navigation —
    // see the drawer listeners below dispatch.
    case "openDrawer": state.drawer = true; railTip(null); break;
    case "closeDrawer": state.drawer = false; break;
    case "toggleCollapse":
      state.collapsed = !state.collapsed;
      persist("trov.collapsed", state.collapsed ? "1" : "0");
      railTip(null);
      break;
    case "cycleTheme": {
      // header button flips between the two concrete themes; settings can also pick "system".
      const next = resolvedTheme() === "light" ? "dark" : "light";
      state.theme = next;
      persist("trov.theme", next);
      break;
    }
    case "setTheme":
      if (arg === "dark" || arg === "light" || arg === "system") {
        state.theme = arg;
        persist("trov.theme", arg);
      }
      break;

    // feed filters
    case "setFeedView":
      if (arg !== "reading" && arg !== "agents") return;
      state.feedView = arg;
      persist("trov.feedView", arg);
      break;
    case "setAuthor": state.feedAuthor = arg ?? "all"; loadFeed(); return;
    case "setTag": state.feedTag = arg ?? value ?? "all"; loadFeed(); return;
    case "setRange": state.feedRange = arg ?? value ?? "all"; break;
    case "feedFilterClear": {
      const refetch = state.feedAuthor !== "all" || state.feedTag !== "all";
      state.feedAuthor = "all"; state.feedTag = "all"; state.feedRange = "all";
      if (refetch) { loadFeed(); return; }
      break;
    }

    // ── Review (wired: real proposals + draft ADR reads, real verdict writes) ──
    case "reviewSelect": if (arg) state.reviewSel = arg; break;
    case "reviewBack": state.reviewSel = null; break;   // narrow: back to the list pane
    case "reviewFilter":
      if (arg === "all" || arg === "proposal" || arg === "decision") state.reviewFilter = arg;
      break;
    case "reviewDiffView":
      if (arg === "unified" || arg === "split" || arg === "rendered") state.reviewDiffView = arg;
      break;
    case "reviewAccept":
    case "reviewReject": {
      if (!arg) return;
      const ref = decodeReviewId(arg);
      if (!ref) return;
      const accept = act === "reviewAccept";
      const op = ref.kind === "doc"
        ? (accept ? promoteDoc(ref.slug, ref.version) : rejectDoc(ref.slug, ref.version))
        : (accept ? ratifyAdr(ref.id) : rejectAdr(ref.id));
      op.then(() => {
          state.reviewSel = null; // fall back to the first visible item
          flash(accept
            ? (ref.kind === "adr" ? "Ratified — the decision is now accepted" : "Promoted — the proposal is live; previous version kept")
            : "Rejected — parked, nothing changed");
          // Refetch the affected list — never locally decrement (badge drift is worse).
          if (ref.kind === "doc") loadProposals();
          else loadDraftAdrs();
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Action failed");
        });
      return;
    }

    // docs navigation. Clicking the whole row toggles the outline like the chevron:
    // if it's the doc you're already reading, collapse/expand its outline; otherwise
    // navigate to it (which opens its outline).
    case "docsTree": state.docsTree = !state.docsTree; break;
    case "openDoc":
      if (arg) {
        if (state.docsTree && arg !== state.docSlug) closeDocsTree();
        if (arg === state.docSlug) toggleOutlineFor(arg);
        else openDocInTree(arg);
      }
      return;
    case "openDocFrom":
      if (arg) { state.screen = "docs"; state.docSlug = arg; state.showHistory = false; state.docOutlineOpen[arg] = true; loadDocsIfNeeded(); loadDoc(arg); }
      return;
    case "setDocSpace": {
      if (!arg || arg === state.docSpace) return;
      state.docSpace = arg;
      state.showHistory = false;
      const first = firstDocForSpace(state.docsList.data, arg);
      if (first) { state.docSlug = first.slug; state.docOutlineOpen[first.slug] = true; loadDoc(first.slug); }
      else { state.docSlug = null; state.docDetail = { status: "ok", data: null }; rerender(); }
      return;
    }
    case "toggleHistory": state.showHistory = !state.showHistory; break;
    // Expand/collapse a page's in-page outline without navigating to it (the chevron).
    case "toggleOutline":
      if (arg) toggleOutlineFor(arg);
      return;
    // Jump to a heading; arg is `${slug}::${headingId}`. Opens the doc first if
    // it isn't the one showing, then scrolls once its reader has rendered.
    case "scrollToHeading": {
      if (!arg) return;
      const sep = arg.indexOf("::");
      const slug = sep < 0 ? arg : arg.slice(0, sep);
      const headingId = sep < 0 ? "" : arg.slice(sep + 2);
      if (state.docsTree) closeDocsTree();
      if (state.docSlug !== slug) {
        state.pendingScrollId = headingId;
        openDocInTree(slug); // loads into the pane; refreshReaderPane scrolls once ready
      } else {
        // same doc — scroll in place, no rerender (keeps the tree animation intact)
        const target = document.getElementById("cnpy-reader")?.querySelector<HTMLElement>(`.cnpy-md [id="${cssEscape(headingId)}"]`);
        if (target) requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
      }
      return;
    }

    // Get Started's table of contents: scroll #cnpy-main to the heading, no rerender
    // (the hash is the route, so these are buttons, not #anchors).
    case "guideJump": {
      const pane = document.getElementById("cnpy-main");
      const target = arg ? document.getElementById(arg) : null;
      if (!pane || !target) return;
      const top = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 24;
      const behavior: ScrollBehavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      pane.scrollTo({ top: Math.max(0, top), behavior });
      return;
    }

    // An uploaded doc image (Docs reader, Review's Rendered view), expanded: its alt
    // text is the title. arg is the sha256 (DOC_IMAGE_PATH_RE in shared/doc-images).
    case "docImgZoom": {
      if (!arg || !/^[0-9a-f]{64}$/.test(arg)) return;
      const img = mount.querySelector<HTMLImageElement>(`[data-act="docImgZoom"][data-arg="${arg}"] img`);
      const alt = img?.getAttribute("alt")?.trim() ?? "";
      openLightbox({ src: tenantHref(`/img/${arg}`), alt: alt || "Image", title: alt || "Image" });
      return;
    }

    // A guide figure, expanded: title = its caption's bold lead, caption = the rest.
    case "guideZoom": {
      const btn = arg ? mount.querySelector<HTMLElement>(`[data-act="guideZoom"][data-arg="${cssEscape(arg)}"]`) : null;
      const img = btn?.querySelector("img");
      if (!btn || !img) return;
      const cap = btn.closest("figure")?.querySelector("figcaption");
      const title = cap?.querySelector("strong")?.textContent?.trim() || "Screenshot";
      const rest = cap ? cap.innerHTML.replace(/^\s*<strong[^>]*>[\s\S]*?<\/strong>\s*:?\s*/, "") : "";
      openLightbox({ src: img.getAttribute("src") ?? "", alt: cap?.textContent?.trim() ?? title, title, captionHtml: rest });
      return;
    }

    // search
    case "setSearch":
      state.searchQuery = value ?? "";
      if (searchDebounce !== null) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => { searchDebounce = null; loadSearch(); }, 250);
      rerender();
      return;
    case "setSearchType":
      if (arg === "all" || arg === "doc" || arg === "feed" || arg === "decision" || arg === "artifact") state.searchType = arg;
      break;

    // settings — display name echoes live; everything else is Phase 2
    case "setDisplayName": state.displayName = value ?? ""; break;

    case "confirmSprint": {
      if (!arg) return;
      completeSprint(Number(arg))
        .then(() => { flash("Sprint marked done"); loadRoadmap(); })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not complete sprint");
        });
      return;
    }
    // ADMIN action (My Work): trigger the server-side GitHub backfill, then
    // refresh My Work so newly-captured PRs/issues surface in the two lists.
    case "adminBackfill": {
      if (state.backfillSync) return; // already syncing — button is disabled, but guard duplicate dispatch too
      state.backfillSync = { phase: "starting" }; // no real counts until the first batch resolves — the modal shows an inventory-taking line, never "0 of 0"
      rerender();
      runAdminBackfillLoop();
      return;
    }
    // ── Handoffs ─────────────────────────────────────────────────────────────
    case "goHandoffs": state.screen = "handoffs"; state.handoffId = null; loadHandoffs(); return;
    case "newHandoff": state.screen = "newhandoff"; state.nh = blankHandoff(primaryRepoName()); rerender(); return;
    case "openHandoff": { const id = Number(arg); if (!Number.isInteger(id) || id <= 0) return; state.screen = "handoff"; openHandoff(id); return; }
    case "mwHandoffCopy": {
      // My Work › Queued handoffs: the same "Copy as prompt" text as the handoff screen,
      // from the inbox row already on hand — so the write stays inside the click.
      const h = state.handoffs.data.find((x) => x.id === Number(arg));
      if (!h) return;
      copyToClipboard(handoffAsPrompt(h)).then((ok) => flash(ok ? "Copied as prompt" : "Couldn't reach the clipboard"));
      return;
    }
    case "handoffCopy": {
      const h = state.handoffDetail.data;
      if (!h || h.id !== Number(arg)) return;
      copyToClipboard(handoffAsPrompt(h)).then((ok) => flash(ok ? "Copied as prompt" : "Couldn't reach the clipboard"));
      return;
    }
    case "handoffClaim": {
      const h = state.handoffDetail.data;
      if (!h || h.id !== Number(arg)) return;
      const session = "sess_web_" + Math.random().toString(36).slice(2, 10).toUpperCase();
      claimHandoff(h.id, session)
        .then((nh) => copyToClipboard(handoffAsPrompt(nh)).then((ok) =>
          applyHandoff(nh, ok ? `Claimed #${nh.id} · copied as prompt` : `Claimed #${nh.id} — couldn't reach the clipboard`)))
        .catch((e) => { writeErr(e, "Couldn't claim this handoff"); openHandoff(h.id); loadHandoffs(); });
      return;
    }
    case "handoffPromote": {
      const h = state.handoffDetail.data;
      if (!h || h.id !== Number(arg)) return;
      const d = docDraftFromHandoff(h);
      state.screen = "newdoc";
      state.nd = { ...blankDoc("technical", "reference"), ...d, from: h.id };
      if (state.docsList.status === "idle") loadDocs(); else rerender();
      return;
    }
    case "handoffPromptCopy": {
      const h = state.handoffDetail.data;
      if (!h?.prompt) return;
      copyToClipboard(h.prompt.body).then((ok) => flash(ok ? "Prompt copied" : "Couldn't reach the clipboard"));
      return;
    }
    case "handoffPromptOpen": state.handoffPromptOpen = true; break;
    case "handoffPromptClose": state.handoffPromptOpen = false; break;
    case "handoffExpire":
      if (!state.handoffExpireArm) { state.handoffExpireArm = true; break; }
      state.handoffExpireArm = false;
      {
        const id = Number(arg);
        if (!Number.isInteger(id)) return;
        expireHandoff(id)
          .then((nh) => applyHandoff(nh, `Handoff #${nh.id} expired`))
          .catch((e) => { writeErr(e, "Couldn't expire this handoff"); openHandoff(id); loadHandoffs(); });
      }
      return;
    case "nhField": {
      const k = arg as keyof NewHandoffDraft | null;
      if (!k || !(k in state.nh) || k === "ctxOpen") return;
      (state.nh as unknown as Record<string, string>)[k] = value ?? "";
      // Only the body drives other markup (the "Shows in the list as" line, Send's state).
      if (k === "body") rerender();
      return;
    }
    case "nhRecipient": if (arg) state.nh.recipient = arg; break;
    case "nhCtxToggle": state.nh.ctxOpen = !state.nh.ctxOpen; break;
    case "nhSend": {
      const n = state.nh;
      if (!n.body.trim()) return;
      const lines = (t: string) => t.split("\n").map((x) => x.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
      createHandoff({
        recipient: n.recipient,
        body: n.body,
        prompt: n.promptBody.trim() ? { title: n.promptTitle.trim() || "Prompt", body: n.promptBody } : null,
        context: { repo: n.repo.trim(), branch: n.branch.trim(), task: n.task.trim(), done: lines(n.done), next: lines(n.next), files: lines(n.files) },
      })
        .then((h) => { state.screen = "handoff"; state.nh = blankHandoff(primaryRepoName()); applyHandoff(h, `Handoff sent · #${h.id}`); })
        .catch((e) => writeErr(e, "Couldn't send the handoff"));
      return;
    }

    // ── Prompt Library ───────────────────────────────────────────────────────
    case "goPrompts": state.screen = "prompts"; state.promptFilterOpen = false; loadPrompts(); return;
    case "newPrompt": state.screen = "promptedit"; openEditor("new", null); return;
    case "openPrompt": if (!arg) return; state.screen = "prompt"; openPrompt(arg); return;
    case "promptQuery": state.promptQ = value ?? ""; break;
    // The filter menu itself (open / close / category) is the shared filter-menu registry.
    case "promptTag": state.promptTag = arg || null; break;
    case "promptSort": state.promptSort = arg === "updated_asc" ? "updated_asc" : "updated_desc"; break;
    case "promptResetFilters": state.promptTag = null; state.promptSort = "updated_desc"; break;
    case "promptClearFilters": state.promptQ = ""; state.promptTag = null; break;
    case "promptDiff": {
      const v = Number(arg);
      state.promptDiffV = arg && Number.isInteger(v) ? v : null;
      if (state.promptDiffV !== null) {
        const m = document.getElementById("cnpy-main");
        if (m && m.scrollTop > 120) m.scrollTo({ top: 0, behavior: "smooth" });
      }
      break;
    }
    case "promptCopy": {
      const body = state.promptDetail.data?.prompt.body;
      if (!body) return;
      copyToClipboard(body).then((ok) => flash(ok ? "Prompt copied" : "Couldn't reach the clipboard"));
      return;
    }
    case "promptExpand": state.promptExpanded = true; break;
    case "promptBoxView":
      if (arg !== "raw" && arg !== "rendered") return;
      state.promptView = arg;
      persist("trov.promptView", arg);
      break;
    case "promptExpandClose": state.promptExpanded = false; break;
    case "promptTagMenu": state.promptTagMenu = !state.promptTagMenu; state.promptTagDraft = ""; break;
    case "promptTagDraft": state.promptTagDraft = value ?? ""; break;
    case "promptTagAdd":
    case "promptTagRemove": {
      const p = state.promptDetail.data?.prompt;
      state.promptTagMenu = false; state.promptTagDraft = "";
      if (!p || !arg) return;
      writePromptTags(act === "promptTagAdd" ? [...p.tags, arg] : p.tags.filter((t) => t !== arg));
      break;
    }
    case "promptPublish": {
      const p = state.promptDetail.data?.prompt;
      const v = Number(arg);
      if (!p || !Number.isInteger(v)) return;
      publishPrompt(p.slug, v)
        .then((np) => afterPromptWrite(np.slug, `Published v${v}`))
        .catch((e) => { writeErr(e, "Couldn't publish"); openPrompt(p.slug); });
      return;
    }
    // Delete (author / admin only — the server re-checks): the confirmation modal (Delete
    // focused, so Enter confirms), then back to the library with a "Deleted “…” · Undo"
    // toast whose Undo restores it.
    case "promptDeleteArm":
      state.promptDeleteArm = true;
      rerender();
      mount.querySelector<HTMLElement>("[data-confirm-focus]")?.focus();
      return;
    case "promptDeleteCancel": {
      if (!state.promptDeleteArm || state.promptDeleteBusy) return;
      confirmOut(() => {
        state.promptDeleteArm = false;
        rerender();
        mount.querySelector<HTMLElement>("[data-confirm-trigger]")?.focus();
      });
      return;
    }
    case "promptDelete": {
      const p = state.promptDetail.data?.prompt;
      if (!p || !state.promptDeleteArm || state.promptDeleteBusy) return;
      state.promptDeleteBusy = true;
      rerender();
      deletePrompt(p.slug)
        .then((r) => {
          state.promptDeleteArm = false; state.promptDeleteBusy = false;
          state.promptDetail = { status: "idle", data: null };
          state.promptSlug = null;
          state.promptList = { ...state.promptList, data: state.promptList.data.filter((x) => x.slug !== r.slug) };
          state.screen = "prompts";
          loadPrompts();
          flash(`Deleted “${r.title}”`, UNDO_TOAST_MS, { label: "Undo", act: "promptRestore", arg: r.slug });
        })
        .catch((e) => { state.promptDeleteBusy = false; state.promptDeleteArm = false; writeErr(e, "Couldn't delete the prompt"); });
      return;
    }
    case "promptRestore": {
      if (!arg) return;
      state.toast = null; state.toastAction = null;
      restorePrompt(arg)
        .then((np) => { loadPrompts(); flash(`Restored “${np.title}”`); })
        .catch((e) => writeErr(e, "Couldn't restore the prompt"));
      rerender();
      return;
    }
    case "promptEdit": if (!arg) return; state.screen = "promptedit"; openEditor("edit", arg); return;
    case "promptNewVersion": if (!arg) return; state.screen = "promptedit"; openEditor("version", arg); return;
    // The editor's fields. Title drives the slug until the slug is edited by hand.
    case "edTitle": {
      const ed = state.promptEd; if (!ed) return;
      ed.title = value ?? "";
      if (!ed.slugTouched) ed.slug = slugify(ed.title);
      break;
    }
    case "edSlug": { const ed = state.promptEd; if (!ed) return; ed.slug = (value ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-"); ed.slugTouched = true; break; }
    case "edResetSlug": { const ed = state.promptEd; if (!ed) return; ed.slug = slugify(ed.title); ed.slugTouched = false; break; }
    case "edBody": { const ed = state.promptEd; if (!ed) return; ed.body = value ?? ""; break; }
    case "edSummary": { const ed = state.promptEd; if (!ed) return; ed.summary = value ?? ""; return; }
    case "edTagDraft": {
      const ed = state.promptEd; if (!ed) return;
      const v = value ?? "";
      if (/[,\s]$/.test(v)) { addEdTag(v); break; }
      ed.tagDraft = v;
      return;
    }
    case "edTagAdd": if (arg) addEdTag(arg); break;
    case "edTagRemove": { const ed = state.promptEd; if (!ed || !arg) return; ed.tags = ed.tags.filter((t) => t !== arg); break; }
    case "edStatus": { const ed = state.promptEd; if (!ed) return; if (arg === "draft" || arg === "staged" || arg === "published") ed.status = arg; break; }
    case "edCancel": {
      const base = state.promptEd?.baseSlug;
      if (base) { state.screen = "prompt"; openPrompt(base); return; }
      dispatch("goPrompts", null, null);
      return;
    }
    case "edSave": {
      const ed = state.promptEd;
      if (!ed || !ed.title.trim() || !ed.body.trim() || !ed.slug) return;
      savePrompt({ base_slug: ed.baseSlug, slug: ed.slug, title: ed.title.trim(), tags: normalizeTags(ed.tags), body: ed.body, status: ed.status, summary: ed.summary.trim() || undefined })
        .then((p) => { state.promptEd = null; afterPromptWrite(p.slug, `Saved v${p.version}`); })
        .catch((e) => writeErr(e, "Couldn't save the prompt"));
      return;
    }

    // ── Docs › New doc — stages a version-1 proposal through the gate ─────────
    case "newDoc": state.screen = "newdoc"; startNewDoc(); return;
    case "ndField": {
      if (arg !== "title" && arg !== "body" && arg !== "summary") return;
      state.nd[arg] = value ?? "";
      if (arg !== "summary") rerender(); // title / body arm "Stage for review"
      return;
    }
    case "ndSpace": {
      if (!arg) return;
      if (arg === state.nd.space) return;
      state.nd.space = arg;
      state.nd.section = ""; // back to the new space's default
      break;
    }
    case "ndSection": if (arg) state.nd.section = arg; break;
    case "ndSubmit": {
      const d = state.nd;
      if (!d.title.trim() || !d.body.trim()) return;
      const section = d.section || defaultSection(ASSIGN_OPTIONS.sections);
      proposeDoc({ title: d.title.trim(), section, space: d.space, body: d.body, summary: d.summary.trim() || undefined })
        .then(() => {
          state.nd = blankDoc(state.docSpace, "");
          state.screen = "review";
          loadProposals();
          loadDraftAdrsIfNeeded();
          flash(`Staged for review in ${section}`);
        })
        .catch((e) => writeErr(e, "Couldn't stage the doc"));
      return;
    }

    // ── Maintenance › Unplaced: the list selects; the picks belong to the item on screen ──
    case "maintSelect":
      if (!arg) return;
      state.assignOpen = arg; state.assignKind = null; state.assignSection = null; state.assignSpace = null; state.assignTags = [];
      state.maintDiscardArm = false;
      break;
    case "identityCancel": state.mapConfirm = null; break;

    // ── Maintenance (mock-driven until the backend reads land — no writes) ───
    case "maintAssignToggle": {
      if (!arg) return;
      state.assignOpen = state.assignOpen === arg ? null : arg;
      state.assignKind = null;
      state.assignSection = null;
      state.assignSpace = null;
      state.assignTags = [];
      break;
    }
    case "maintAssignKind":
      if (arg === "doc" || arg === "adr" || arg === "feed") {
        state.assignOpen = selectedUnplacedId(state.needsTriage.data.map((r) => ({ id: String(r.id) })), state.assignOpen);
        state.maintDiscardArm = false;
        state.assignKind = arg;
        state.assignSection = null;
        state.assignSpace = null;
        state.assignTags = [];
      }
      break;
    case "maintAssignSection": if (arg) state.assignSection = arg; break;
    case "maintAssignSpace": if (arg) state.assignSpace = state.assignSpace === arg ? null : arg; break;
    case "maintAssignTag":
      if (arg) state.assignTags = state.assignTags.includes(arg) ? state.assignTags.filter((t) => t !== arg) : [...state.assignTags, arg];
      break;
    case "maintFile": {
      if (!arg || state.assignOpen !== arg || !state.assignKind) return;
      if (state.assignKind === "doc" && !state.assignSection) return;
      const id = Number(arg);
      if (!Number.isInteger(id)) return;
      const kind = state.assignKind;
      const target: AssignTarget = { type: kind };
      if (kind === "doc") {
        target.section = state.assignSection ?? undefined;
        target.space = state.assignSpace === "technical" || state.assignSpace === "product" ? state.assignSpace : undefined;
      }
      if (kind === "feed") target.tags = state.assignTags;
      assignTriage(id, target)
        .then(() => {
          state.assignOpen = null; state.assignKind = null; state.assignSection = null; state.assignSpace = null; state.assignTags = [];
          flash("Filed — placed through the gate and resolved");
          loadNeedsTriage();
          if (kind === "doc") loadProposals();   // an assigned doc lands as a staged proposal
          if (kind === "adr") loadDraftAdrs();   // an assigned decision lands as a draft
          if (kind === "feed") loadFeed();   // a filed feed entry lands live on the Feed screen
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          // e.g. "cannot assign a free-form triage item; discard it instead" — verbatim from the gate
          flash(e instanceof ApiError ? e.message : "Could not file this item");
        });
      return;
    }
    case "maintDiscard": {
      if (!arg) return;
      const id = Number(arg);
      if (!Number.isInteger(id)) return;
      if (!state.maintDiscardArm) { state.maintDiscardArm = true; break; } // step 1: arm; the second click discards
      state.maintDiscardArm = false;
      if (state.assignOpen === arg) { state.assignOpen = null; state.assignKind = null; state.assignSection = null; state.assignSpace = null; state.assignTags = []; }
      discardTriage(id)
        .then(() => { flash("Discarded — parked, nothing changed"); loadNeedsTriage(); })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not discard");
        });
      return;
    }
    case "identityPick": {
      if (!arg) return;
      const sep = arg.indexOf(":");
      if (sep < 0) return;
      const login = arg.slice(0, sep);
      state.mapPicks = { ...state.mapPicks, [login]: arg.slice(sep + 1) };
      if (state.mapConfirm === login) state.mapConfirm = null; // changing the pick re-arms the confirm
      break;
    }
    case "identityMap": {
      if (!arg) return;
      const person = state.mapPicks[arg];
      if (!person) return;                                              // no auto-select: a person must be picked
      if (state.mapConfirm !== arg) { state.mapConfirm = arg; break; }  // step 1: show the concrete effect
      state.mapConfirm = null;
      mapIdentity(arg, person)
        .then(() => {
          flash(`Mapped — ${arg} → ${person}; their captured activity is now attributed`);
          loadIdentityTasks();
          loadPersons();
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not map login");
        });
      return;
    }
    // Discard is undoable, so no confirm step: the toast carries the Undo.
    case "identityDiscard": {
      if (!arg) return;
      if (state.mapConfirm === arg) state.mapConfirm = null;
      discardIdentity(arg)
        .then(() => {
          loadIdentityTasks();
          flash(`Discarded @${arg}`, UNDO_TOAST_MS, { label: "Undo", act: "identityRestore", arg });
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not discard login");
        });
      return;
    }
    case "identityRestore": {
      if (!arg) return;
      state.toast = null; state.toastAction = null;
      restoreIdentity(arg)
        .then(() => { loadIdentityTasks(); flash(`Restored @${arg}`); })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not restore login");
        });
      rerender();
      return;
    }
    case "identityToggleDiscarded": state.identityShowDiscarded = !state.identityShowDiscarded; break;
    // ── Settings › Email notifications ───────────────────────────────────────
    case "emailStartEdit": state.emailEditing = true; state.emailDraft = state.notifPrefs.data?.email ?? ""; break;
    case "emailCancel": state.emailEditing = false; state.emailDraft = ""; break;
    case "setEmailDraft": state.emailDraft = value ?? ""; return; // echoes live; no rerender needed
    case "emailSave": {
      const v = state.emailDraft.trim();
      state.emailEditing = false;
      writePrefs({ email: v }, v ? "Digest address saved" : "Address removed — digests paused");
      return;
    }
    case "setKindCadence": {
      const [kind, cadence] = (arg ?? "").split(":");
      const row = state.notifPrefs.data?.kinds.find((k) => k.id === kind);
      if (!row || (cadence !== "daily" && cadence !== "weekly" && cadence !== "off")) return;
      // Picking the org default is a reset (design: no override row is kept for it).
      writePrefs({ prefs: { [kind]: cadence === row.orgDefault ? null : cadence } }, null);
      return;
    }
    case "resetKind": if (arg) writePrefs({ prefs: { [arg]: null } }, "Reset to org default"); return;
    case "toggleAllOff": {
      const next = !(state.notifPrefs.data?.unsubscribed ?? false);
      writePrefs({ unsubscribed: next }, next ? "Email is off" : "Email is back on");
      return;
    }
    case "previewUnsub": state.unsub = { pending: false, error: null, preview: true }; state.screen = "unsubscribe"; break;
    case "unsubGoSettings": state.screen = "settings"; state.unsub = { pending: false, error: null, preview: false }; loadGrantsIfNeeded(); loadNotifPrefsIfNeeded(); return;

    // ── Maintenance › Notifications (admin) ──────────────────────────────────
    case "policyToggle": {
      const row = state.notifPolicy.data.find((k) => k.id === arg);
      if (!row) return;
      putNotificationPolicy({ kind: row.id, enabled: !row.enabled })
        .then(({ kinds }) => { state.notifPolicy = { status: "ok", data: kinds }; flash(row.enabled ? `${row.label} turned off org-wide` : `${row.label} turned on`); rerender(); })
        .catch((e) => flash(e instanceof ApiError ? e.message : "Could not update policy"));
      return;
    }
    case "policyCadence": {
      if (!arg || (value !== "daily" && value !== "weekly" && value !== "off")) return;
      putNotificationPolicy({ kind: arg, default_cadence: value })
        .then(({ kinds }) => { state.notifPolicy = { status: "ok", data: kinds }; flash("Default cadence saved"); rerender(); })
        .catch((e) => flash(e instanceof ApiError ? e.message : "Could not update policy"));
      return;
    }
    case "schedHour": { const h = Number(value); if (Number.isInteger(h)) writeSettings({ send_hour: h }, "Send hour saved"); return; }
    case "schedTz": if (value) writeSettings({ timezone: value }, "Timezone saved"); return;
    case "schedFrom": state.fromDraft = value ?? ""; state.fromError = null; return; // live echo; commits on change (blur/enter)
    case "schedFromCommit": {
      // A sender NAME only: the address is the platform's (shared/sender.ts). Checked here with the Worker's own rule.
      const v = (value ?? "").trim().replace(/\s+/g, " ");
      const stored = senderNamePart(state.notifSettings.data?.from_address ?? "");
      if (!v || v === stored) { state.fromDraft = null; state.fromError = null; break; }
      const problem = senderNameProblem(v);
      if (problem) { state.fromDraft = v; state.fromError = SENDER_NAME_HELP[problem]; break; }
      writeSettings({ from_address: v }, "Sender name saved");
      return;
    }
    case "outboxToggle": state.outboxExpanded = state.outboxExpanded === arg ? null : arg; break;
    case "testSend": {
      if (arg !== "daily" && arg !== "weekly") return;
      const cadence = arg;
      flash(`Sending ${cadence} test…`);
      // Real data first; if nothing renders, fall back to the sample digest so the layout is still checked.
      testSendNotification(cadence)
        .catch((e) => (e instanceof ApiError && /nothing to render/i.test(e.message) ? testSendNotification(cadence, true) : Promise.reject(e)))
        .then((r) => {
          flash(r.ok ? `Test ${cadence} sent to ${r.to}${r.mode === "local" ? " (local mode: see outbox bodies)" : ""}` : `Test send ${r.status}: ${r.error ?? "unknown error"}`);
          listNotificationOutbox().then(({ rows }) => { state.notifOutbox = { status: "ok", data: rows }; rerender(); }).catch(() => undefined);
        })
        .catch((e) => flash(refusalText(e, "Could not send test"), isRateLimited(e) ? 7000 : 2200));
      return;
    }

    // ── Settings ─────────────────────────────────────────────────────────────
    // MCP access is OAuth only: the steps, Connected apps, and a folded by-hand command.
    // Revoke is two clicks: the first arms the row, the second revokes.
    case "revokeTokenArm": state.tokenRevokeArm = Number(arg); break;
    case "revokeTokenCancel": state.tokenRevokeArm = null; break;
    case "revokeToken": {
      const id = Number(arg);
      revokeMcpToken(id)
        .then(() => {
          state.mcpTokens = { status: "ok", data: state.mcpTokens.data.filter((t) => t.id !== id) };
          state.tokenRevokeArm = null;
          flash("Token revoked");
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { unauth(e); return; }
          state.tokenRevokeArm = null;
          flash("Couldn't revoke the token. Try again.");
          loadMcpTokens();
        });
      return;
    }
    case "revokeGrantArm": state.grantRevokeArm = Number(arg); break;
    case "revokeGrantCancel": state.grantRevokeArm = null; break;
    case "revokeGrant": {
      const id = Number(arg);
      revokeOAuthGrant(id)
        .then(() => {
          state.grants = { status: "ok", data: state.grants.data.filter((g) => g.id !== id) };
          state.grantRevokeArm = null;
          flash("App disconnected");
          rerender();
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not disconnect the app");
        });
      return;
    }
    // Connected apps opens to every row, or folds back to the first few.
    case "mcpShowAll": state.grantsAll = !state.grantsAll; break;
    // The by-hand setup is a modal, so the MCP tile never changes height: focus goes into
    // the dialog on open, and back to its link on close (the backdrop, the ×, or Escape).
    case "mcpSetupOpen":
      state.mcpSetup = true;
      rerender();
      mount.querySelector<HTMLElement>("[data-mcp-setup]")?.focus();
      return;
    case "mcpSetupClose": closeMcpSetup(); return;
    case "copyPluginInstall":
      copyToClipboard(PLUGIN_INSTALL).then((ok) => flash(ok ? "Commands copied" : "Couldn't copy the commands"));
      return;
    case "copyBrowserConnect":
      copyToClipboard(browserConnectCommand()).then((ok) => flash(ok ? "Command copied" : "Couldn't copy the command"));
      return;

    // ── Settings › Profile (display name, color, link/unlink) ───────────────
    case "saveProfile": {
      const name = state.displayName.trim() || null;
      updateMe({ name }).then((r) => { if (state.me) state.me.name = r.name; flash("Profile saved"); rerender(); })
        .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } flash("Couldn't save profile"); });
      return;
    }
    // ── Settings › Profile: the photo ────────────────────────────────────────
    // The avatar opens its menu (not while a write is in flight); focus moves to the first row.
    case "avatarMenu":
      if (state.avatarBusy) return;
      state.avatarMenu = !state.avatarMenu;
      if (state.avatarMenu) pendingFlash = ".cnpy-avmenu";
      rerender();
      if (state.avatarMenu) mount.querySelector<HTMLElement>('[data-avatar-menu] [role="menuitem"]')?.focus();
      return;
    case "avatarMenuClose": state.avatarMenu = false; break;
    // Close the menu FIRST, then click the fresh input: the paint swaps <main>, and a
    // `change` on a detached input never reaches the mount's listener.
    case "avatarPick":
      if (state.avatarBusy) return;
      state.avatarMenu = false;
      rerender();
      mount.querySelector<HTMLInputElement>("[data-avatar-file]")?.click();
      return;
    case "avatarRemove":
      if (state.avatarBusy) return;
      state.avatarMenu = false;
      state.avatarBusy = "remove";
      rerender();
      mount.querySelector<HTMLElement>(".cnpy-avbtn")?.focus();
      removeAvatar()
        .then((r) => { setMyAvatar(r.avatar_url); flash("Photo removed"); })
        .catch((e) => { state.avatarBusy = null; writeErr(e, "Couldn't remove the photo"); });
      return;
    case "setMyColor": {
      if (!arg || !state.me || !(PERSON_COLORS as readonly string[]).includes(arg)) return;
      const color = arg as PersonColor;
      updateMe({ color }).then(() => { if (state.me) state.me.color = color; loadPersons(); rerender(); })
        .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } flash("Couldn't save color"); });
      return;
    }
    case "linkProvider": window.location.href = arg === "google" ? "/auth/google/login?link=1" : "/auth/login?link=1"; return;
    case "unlinkProvider": {
      if (arg !== "github" && arg !== "google") return;
      unlinkIdentity(arg).then(() => { flash(`${arg === "google" ? "Google" : "GitHub"} unlinked`); refreshMe(); })
        .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } flash(e instanceof ApiError && e.message === "last_identity" ? "You need at least one sign-in method" : "Couldn't unlink"); });
      return;
    }

    // ── Settings › Profile: self-service handle rename ───────────────────────
    case "handleEdit":
      state.handleEdit = true;
      state.handleDraft = state.me?.handle ?? "";
      state.handleCheck = "idle";
      break;
    case "handleCancel":
      state.handleEdit = false;
      state.handleDraft = "";
      state.handleCheck = "idle";
      break;
    case "handleDraft": {
      const draft = (value ?? "").trim();
      state.handleDraft = draft;
      const current = state.me?.handle ?? "";
      if (draft.toLowerCase() === current.toLowerCase()) { state.handleCheck = "same"; }
      else { state.handleCheck = draft ? "checking" : "idle"; scheduleRenameCheck(); }
      break;
    }
    case "handleSave": {
      if (state.handleCheck !== "available") return;
      const draft = state.handleDraft;
      renameHandle(draft)
        .then((r) => {
          if (state.me) state.me.handle = r.handle;
          state.handleEdit = false;
          state.handleDraft = "";
          state.handleCheck = "idle";
          flash(`Handle changed to @${r.handle}`);
          loadPersons();
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { unauth(e); return; }
          if (e instanceof ApiError && e.message === "handle_taken") { state.handleCheck = "taken"; rerender(); return; }
          flash("Couldn't change handle");
        });
      return;
    }

    default:
      // Every Platform (superadmin) act goes to its controller, platform-actions.ts.
      if (act.startsWith("plat")) { platform.act(act, arg, value); return; }
      // Every Org settings act goes to its controller (org-actions.ts), which rerenders itself.
      // `orgs…` (the switcher, the picker, the create dialog) before `org…` (Org settings).
      if (act.startsWith("orgs")) { orgsCtl.act(act, arg, value); return; }
      if (act.startsWith("org")) { orgCtl.act(act, arg, value); return; }
      // Every Artifacts act goes to the one reducer in artifacts.ts.
      if (act.startsWith("art")) {
        const screen = state.screen === "artifacts" || state.screen === "artifactnew" || state.screen === "artifact" ? state.screen : null;
        const run = () => runArtEffect(artifactsAct(state.art, { screen, route: state.artRoute, me: state.me?.handle ?? "", admin: viewerIsAdmin(state), host: `${location.origin}${orgBase(state.orgSlug).replace(/\/$/, "")}`, sprints: state.sprints.data.map((x) => ({ id: x.id, label: x.label, dates: sprintDatesLabel(x), active: x.active })) }, act, arg, value));
        // The delete confirm plays its exit before it closes (Escape, the backdrop, Cancel).
        if (act === "artDeleteCancel" && state.art.deleteArm && !state.art.deleteBusy) confirmOut(run);
        else run();
      }
      return;
  }
  rerender();
}

// Clicks drive buttons; selects/inputs are handled by change/input so their
// native interaction (dropdown open, typing) is preserved. Anchors keep their
// default behavior (open the GitHub link in a new tab).
// ── filter menus (web/src/filter-menu.ts): hover, animated open/close, in-place category switch ──
//
// Each menu is a registry entry over its screen's own state. Open plays the entrance
// once (`state.fmOpening` is read by the ONE paint that opens it). Close plays a short
// exit on the live popover, THEN flips the state and rerenders. Switching category
// never rerenders: every category's options are already in the DOM, so the switch
// flips `hidden`, slides the highlight and plays the new panel's options in — the
// popover survives, which is what lets any of that animate.
interface FilterMenuSpec { isOpen: () => boolean; setOpen: (v: boolean) => void; cat: () => string; setCat: (k: string) => boolean }
const FILTER_MENUS: Record<string, FilterMenuSpec> = {
  art: {
    isOpen: () => state.art.filterOpen, setOpen: (v) => { state.art.filterOpen = v; }, cat: () => state.art.filterCat,
    setCat: (k) => { if (!(ART_FILTER_KEYS as readonly string[]).includes(k)) return false; state.art.filterCat = k as ArtFilterKey; return true; },
  },
  prompt: {
    isOpen: () => state.promptFilterOpen, setOpen: (v) => { state.promptFilterOpen = v; }, cat: () => state.promptFilterCat,
    setCat: (k) => { if (k !== "tag" && k !== "sort") return false; state.promptFilterCat = k; return true; },
  },
  feed: {
    isOpen: () => state.feedFilterOpen, setOpen: (v) => { state.feedFilterOpen = v; }, cat: () => state.feedFilterCat,
    setCat: (k) => { if (!(FEED_FILTER_CATS as readonly string[]).includes(k)) return false; state.feedFilterCat = k as FeedFilterCat; return true; },
  },
  queue: {
    isOpen: () => state.qFilterOpen, setOpen: (v) => { state.qFilterOpen = v; }, cat: () => state.qFilterCat,
    setCat: (k) => { if (!(QUEUE_FILTER_CATS as readonly string[]).includes(k)) return false; state.qFilterCat = k as QueueFilterCat; return true; },
  },
};
const FM_CLOSE_MS = 130;
let fmClosing: string | null = null;
let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;
const HOVER_INTENT_MS = 60;
let hoverIntentTimer: ReturnType<typeof setTimeout> | null = null;
/** When a hover last opened a menu — a click on its trigger right after is the same
 *  intent ("open"), not a toggle that would shut what the hover just opened. */
let hoverOpenedAt = 0;
const cancelHoverClose = () => { if (hoverCloseTimer !== null) { clearTimeout(hoverCloseTimer); hoverCloseTimer = null; } };
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const livePopover = (id: string) => mount.querySelector<HTMLElement>(`[data-fm-pop="${id}"]`);

function openFilterMenu(id: string): void {
  const spec = FILTER_MENUS[id];
  if (!spec) return;
  cancelHoverClose();
  if (fmClosing === id) {           // re-entered while it was fading out: keep it
    fmClosing = null;
    livePopover(id)?.classList.remove("is-closing");
    return;
  }
  if (spec.isOpen()) return;
  spec.setOpen(true);
  state.fmOpening = id;
  rerender();
  state.fmOpening = null;
}
function closeFilterMenu(id: string): void {
  const spec = FILTER_MENUS[id];
  if (!spec || !spec.isOpen() || fmClosing === id) return;
  cancelHoverClose();
  const finish = () => { fmClosing = null; spec.setOpen(false); rerender(); };
  const pop = livePopover(id);
  if (!pop || reducedMotion()) { finish(); return; }
  fmClosing = id;
  pop.classList.remove("is-opening");
  pop.classList.add("is-closing");
  setTimeout(() => { if (fmClosing === id) finish(); }, FM_CLOSE_MS);
}
function switchFilterCat(id: string, key: string): void {
  const spec = FILTER_MENUS[id];
  if (!spec) return;
  const prev = spec.cat();
  if (key === prev || !spec.setCat(key)) return;
  const pop = livePopover(id);
  if (!pop) { rerender(); return; }
  const rows = Array.from(pop.querySelectorAll<HTMLElement>("[data-fm-cat]"));
  const from = rows.findIndex((r) => r.dataset.fmCat === prev);
  const to = rows.findIndex((r) => r.dataset.fmCat === key);
  for (const r of rows) r.classList.toggle("is-on", r.dataset.fmCat === key);
  pop.querySelector<HTMLElement>(".fm-ind")?.style.setProperty("--ci", String(Math.max(0, to)));
  pop.classList.remove("is-opening");
  for (const panel of Array.from(pop.querySelectorAll<HTMLElement>("[data-fm-panel]"))) {
    const on = panel.dataset.fmPanel === key;
    panel.hidden = !on;
    panel.classList.remove("is-switching");
    if (on) {
      panel.dataset.dir = to < from ? "up" : "down";
      void panel.offsetWidth;        // restart the options' entrance
      panel.classList.add("is-switching");
      if (panel.parentElement) panel.parentElement.scrollTop = 0;
    }
  }
}
/** The filter menu's acts (clicks, and `data-hover="fmCat"` rows). */
function filterMenuAct(act: string, arg: string | null): void {
  if (!arg) return;
  if (act === "fmToggle") {
    const spec = FILTER_MENUS[arg];
    if (!spec) return;
    if (spec.isOpen() && fmClosing !== arg) {
      if (performance.now() - hoverOpenedAt < 1000) return;
      closeFilterMenu(arg);
    } else openFilterMenu(arg);
    return;
  }
  if (act === "fmClose") { closeFilterMenu(arg); return; }
  if (act === "fmCat") {
    const i = arg.indexOf(":");
    if (i > 0) switchFilterCat(arg.slice(0, i), arg.slice(i + 1));
  }
}

// Hover (a MOUSE pointer only — a touch tap must not open, then toggle shut).
// `data-hover-menu="<id>"` wraps the trigger and its popover: entering opens it,
// leaving closes it 200 ms later (re-entering cancels) — the design's
// onMouseEnter / onMouseLeave. `data-hover="<act>"` rows dispatch on hover.
mount.addEventListener("pointerover", (e) => {
  if (e.pointerType !== "mouse") return;
  const target = e.target as Element;
  const menu = target.closest<HTMLElement>("[data-hover-menu]");
  const id = menu?.dataset.hoverMenu ?? "";
  if (FILTER_MENUS[id]) {
    cancelHoverClose();
    if (!FILTER_MENUS[id].isOpen() || fmClosing === id) { hoverOpenedAt = performance.now(); openFilterMenu(id); }
  }
  // Hover intent: a row acts only once the pointer RESTS on it (~60 ms), so sweeping
  // across the categories toward the options doesn't flip through every one on the way.
  const row = target.closest<HTMLElement>("[data-hover]");
  if (hoverIntentTimer !== null) { clearTimeout(hoverIntentTimer); hoverIntentTimer = null; }
  if (row) {
    const act = row.dataset.hover ?? "";
    const arg = row.dataset.arg ?? null;
    hoverIntentTimer = setTimeout(() => { hoverIntentTimer = null; dispatch(act, arg, null); }, HOVER_INTENT_MS);
  }
});
mount.addEventListener("pointerout", (e) => {
  if (e.pointerType !== "mouse") return;
  const menu = (e.target as Element).closest<HTMLElement>("[data-hover-menu]");
  const id = menu?.dataset.hoverMenu ?? "";
  if (!FILTER_MENUS[id]) return;
  const to = e.relatedTarget as Element | null;
  if (to && to.closest?.(`[data-hover-menu="${id}"]`)) return;   // moving between its own children
  cancelHoverClose();
  hoverCloseTimer = setTimeout(() => { hoverCloseTimer = null; closeFilterMenu(id); }, 200);
});
// `data-hover-blur` (the ticket queue's search + Filter pair): once a MOUSE leaves
// it, it lets go — the search box drops its focus (and so its selected outline),
// keeping whatever was typed. The filter menu inside closes on its own hover rule.
mount.addEventListener("pointerout", (e) => {
  if (e.pointerType !== "mouse") return;
  const box = (e.target as Element).closest<HTMLElement>("[data-hover-blur]");
  if (!box) return;
  const to = e.relatedTarget as Element | null;
  if (to && box.contains(to)) return;
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && box.contains(focused)) focused.blur();
});
// A switch's option widths (and a tab bar's tab widths) change with the viewport and once
// the web fonts land: re-place every indicator where it sits, without a slide.
const syncIndicators = () => { syncSegments(mount, { instant: true }); syncTabBars(mount, { instant: true }); };
window.addEventListener("resize", syncIndicators);
void document.fonts?.ready.then(syncIndicators);
// A tab bar's keyboard: ←/→ step between its tabs, Home/End jump (./tabs `onTabBarKey`).
mount.addEventListener("keydown", onTabBarKey);
// Escape closes an open filter menu.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const [id, spec] of Object.entries(FILTER_MENUS)) if (spec.isOpen()) closeFilterMenu(id);
});

mount.addEventListener("click", (e) => {
  const target = e.target as Element;
  // Textareas carry data-act too (the description / comment drafts); clicking
  // into one must place the caret, not dispatch the act with a null value.
  if (target.closest("input, select, textarea, a[href]")) return;
  const el = target.closest<HTMLElement>("[data-act]");
  if (!el) return;
  dispatch(el.dataset.act ?? "", el.dataset.arg ?? null, null);
});

// The phone drawer closes once a row in it is picked — even the page already shown —
// but not for the rows that only change the drawer itself (a sub-page chevron, the search).
mount.addEventListener("click", (e) => {
  if (!state.drawer) return;
  const el = (e.target as Element).closest<HTMLElement>(".cnpy-aside [data-act]");
  const act = el?.dataset.act;
  if (!act || act === "navToggle" || act === "sideSearchFocus" || act === "sideSearch" || act === "orgsMenu") return;
  state.drawer = false;
  rerender();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !state.drawer) return;
  state.drawer = false;
  rerender();
  mount.querySelector<HTMLElement>(".cnpy-menubtn")?.focus();
});

// Right-click on an element that carries `data-ctx` opens ITS menu instead of
// the browser's (a linked-work chip → its Copy / Remove menu).
mount.addEventListener("contextmenu", (e) => {
  const el = (e.target as Element).closest<HTMLElement>("[data-ctx]");
  if (!el) return;
  e.preventDefault();
  dispatch(el.dataset.ctx ?? "", el.dataset.arg ?? null, null);
});

mount.addEventListener("change", (e) => {
  const el = e.target as HTMLElement;
  if (el instanceof HTMLSelectElement && el.dataset.act) {
    dispatch(el.dataset.act, el.dataset.arg ?? null, el.value);
  }
  // Text inputs that save on commit (blur / Enter) dispatch "<act>Commit".
  if (el instanceof HTMLInputElement && el.dataset.act && el.dataset.commit) {
    dispatch(`${el.dataset.act}Commit`, el.dataset.arg ?? null, el.value);
  }
});

// ── the ticket board's drag (tickets.ts `boardCard` / `boardView`) ───────────
// POINTER-driven, not HTML5 drag-and-drop: the browser's native drag image is a
// shrunken, translucent snapshot the page cannot size. Instead:
//  • the card lifts out — a full-size clone (`.cnpy-tghost`), held straight, follows the pointer,
//    and the card itself is replaced by a SLOT (`.cnpy-tslot`) the same height;
//  • the slot follows the pointer through the columns, and the cards around it
//    slide apart to make room (FLIP: measure, move the slot, animate each card
//    from where it was) — the gap is exactly where the card will land;
//  • on release the clone glides into the slot, then the move is written
//    (`queueDrop` → `move_ticket`, which saves the position).
// A press becomes a drag only past DRAG_SLOP px, so a click still opens the
// ticket, and the click a real drag's release fires is swallowed. The columns
// themselves are NOT highlighted (the owner's call): the slot says where the card
// goes. Every column takes the card — any status may move to any other.
// Rerenders are held for the whole drag (the DOM IS the drag state).
// Mouse and pen only: on touch a press on the board must still scroll it.
const DRAG_SLOP = 5;
const SLIDE_MS = 160;
let boardDrag: { id: number; from: TicketStatus } | null = null;
let rerenderHeld = false;
interface BoardPress {
  card: HTMLElement; id: number; from: TicketStatus; x: number; y: number;
  dx: number; dy: number; ghost: HTMLElement | null; slot: HTMLElement | null;
  /** Where the card started: its list and the visible card after it. */
  homeList: HTMLElement | null; homeNext: HTMLElement | null;
  settling: boolean;
}
let boardPress: BoardPress | null = null;
let swallowClick = false;
const listOf = (col: Element) => col.querySelector<HTMLElement>(".cnpy-stagger");
/** The cards that take part in a column's layout (not the lifted one). */
const liveCards = (list: Element | null) =>
  list ? Array.from(list.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("cnpy-tcard") && !el.classList.contains("is-lifted")) : [];
/** The first live card after `el` in its list (null = the end). */
function nextLive(el: Element): HTMLElement | null {
  for (let n = el.nextElementSibling; n; n = n.nextElementSibling) {
    if (n instanceof HTMLElement && n.classList.contains("cnpy-tcard") && !n.classList.contains("is-lifted")) return n;
  }
  return null;
}
function prevLive(el: Element): HTMLElement | null {
  for (let n = el.previousElementSibling; n; n = n.previousElementSibling) {
    if (n instanceof HTMLElement && n.classList.contains("cnpy-tcard") && !n.classList.contains("is-lifted")) return n;
  }
  return null;
}
/** Move the slot to `list` before `ref` (null = the end), sliding every card
 *  it displaces from where it was to where it lands. */
function moveSlot(slot: HTMLElement, list: HTMLElement, ref: HTMLElement | null): void {
  if (slot.parentElement === list && nextLive(slot) === ref) return;
  const lists = new Set<HTMLElement>([list]);
  if (slot.parentElement instanceof HTMLElement) lists.add(slot.parentElement);
  const cards = [...lists].flatMap((l) => liveCards(l));
  const before = new Map(cards.map((c) => [c, c.getBoundingClientRect().top]));
  list.insertBefore(slot, ref);
  if (reducedMotion()) return;
  for (const c of cards) {
    const dy = (before.get(c) ?? 0) - c.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) continue;
    c.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: SLIDE_MS, easing: "cubic-bezier(.2,.7,.2,1)" });
  }
  slot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SLIDE_MS });
}
function clearBoardDrag(): void {
  const p = boardPress;
  p?.slot?.remove();
  p?.card.classList.remove("is-lifted");
  document.querySelector(".cnpy-tghost")?.remove();
  document.documentElement.classList.remove("cnpy-grabbing");
  boardPress = null;
  boardDrag = null;
  if (rerenderHeld) { rerenderHeld = false; rerender(); }
}
function startBoardDrag(p: BoardPress): void {
  const r = p.card.getBoundingClientRect();
  p.dx = p.x - r.left;
  p.dy = p.y - r.top;
  const ghost = p.card.cloneNode(true) as HTMLElement;
  ghost.classList.add("cnpy-tghost");
  ghost.removeAttribute("data-act");
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.width = `${r.width}px`;
  ghost.style.height = `${r.height}px`;
  ghost.style.left = `${r.left}px`;
  ghost.style.top = `${r.top}px`;
  // Inside the app's theme root, so the card's colors resolve exactly as on the board.
  (mount.firstElementChild ?? document.body).appendChild(ghost);
  p.ghost = ghost;
  const slot = document.createElement("div");
  slot.className = "cnpy-tslot";
  slot.style.height = `${r.height}px`;
  p.homeList = p.card.parentElement;
  p.homeNext = nextLive(p.card);
  p.card.parentElement?.insertBefore(slot, p.card);
  p.card.classList.add("is-lifted");
  p.slot = slot;
  boardDrag = { id: p.id, from: p.from };
  document.documentElement.classList.add("cnpy-grabbing");
}
mount.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.pointerType === "touch") return;
  const card = (e.target as Element | null)?.closest?.<HTMLElement>("[data-tdrag]");
  if (!card || boardPress) return;
  boardPress = {
    card, id: Number(card.dataset.tdrag), from: card.dataset.status as TicketStatus,
    x: e.clientX, y: e.clientY, dx: 0, dy: 0, ghost: null, slot: null, homeList: null, homeNext: null, settling: false,
  };
});
document.addEventListener("pointermove", (e) => {
  const p = boardPress;
  if (!p || p.settling) return;
  if (!p.ghost) {
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_SLOP) return;
    startBoardDrag(p);
  }
  e.preventDefault();                                   // no text selection mid-drag
  const { ghost, slot } = p;
  if (!ghost || !slot || !boardDrag) return;
  ghost.style.left = `${e.clientX - p.dx}px`;
  ghost.style.top = `${e.clientY - p.dy}px`;
  const col = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-tdrop]") ?? null;
  const list = col ? listOf(col) : null;
  if (list) {
    // The slot goes before the first card whose middle is below the pointer.
    const ref = liveCards(list).find((c) => { const b = c.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; }) ?? null;
    moveSlot(slot, list, ref);
  }
});
function endBoardDrag(commit: boolean): void {
  const p = boardPress;
  if (!p || p.settling) return;
  if (!p.ghost || !p.slot || !boardDrag) { boardPress = null; return; }   // a plain click: let it open the ticket
  swallowClick = true;                                  // the click this release fires is not an "open"
  setTimeout(() => { swallowClick = false; }, 0);
  const { id, from } = boardDrag;
  const slot = p.slot;
  const to = (slot.closest<HTMLElement>("[data-tdrop]")?.dataset.tdrop ?? from) as TicketStatus;
  const after = prevLive(slot);
  const unmoved = to === from && slot.parentElement === p.homeList && nextLive(slot) === p.homeNext;
  const finish = () => {
    clearBoardDrag();
    if (!commit) return;
    if (!unmoved) dispatch("queueDrop", `${id}:${to}:${after?.dataset.arg ?? ""}`, null);
  };
  if (!commit || reducedMotion()) { finish(); return; }
  // Glide the lifted card into its slot, then commit.
  p.settling = true;
  const s = slot.getBoundingClientRect();
  const g = p.ghost.getBoundingClientRect();
  const anim = p.ghost.animate(
    [{ transform: "none" }, { transform: `translate(${s.left - g.left}px, ${s.top - g.top}px)`, boxShadow: "none" }],
    { duration: 150, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" }
  );
  anim.onfinish = finish;
  anim.oncancel = finish;
}
document.addEventListener("pointerup", () => endBoardDrag(true));
document.addEventListener("pointercancel", () => endBoardDrag(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && boardPress?.ghost) endBoardDrag(false); });
mount.addEventListener("click", (e) => {
  if (!swallowClick) return;
  swallowClick = false;
  e.stopPropagation();
  e.preventDefault();
}, true);

// Settings › Profile's photo menu: Escape closes it and hands focus back to the avatar;
// ↑/↓ (and Home/End) move between its rows. Tab leaves it, like the other menus.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !state.avatarMenu || state.view !== "app") return;
  state.avatarMenu = false;
  rerender();
  mount.querySelector<HTMLElement>(".cnpy-avbtn")?.focus();
});
mount.addEventListener("keydown", (e) => {
  const menu = (e.target as Element | null)?.closest?.<HTMLElement>("[data-avatar-menu]");
  if (!menu || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
    : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
});
// Settings › Profile's photo picker (a hidden input the menu's "Upload photo" row clicks).
mount.addEventListener("change", (e) => {
  const el = e.target as HTMLElement;
  if (!(el instanceof HTMLInputElement) || el.type !== "file" || !el.hasAttribute("data-avatar-file")) return;
  uploadAvatarFile(el.files?.[0]);
  el.value = ""; // picking the same file again still fires `change`
});
// An avatar photo that fails to load (a revoked provider picture, a removed upload) drops out
// and leaves the initials under it — and stays out across rerenders (people.ts records it).
// `error` doesn't bubble, so ONE capture-phase listener on the document covers the app, the
// sidebar and the search panel on <body>.
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains(AVATAR_IMG_CLASS)) return;
  markAvatarFailed(img.getAttribute("src") ?? "");
  img.remove();
}, true);

// The new-artifact form's and the New version dialog's file picker and drop zone (a file has
// no string value to dispatch). `data-art-file="nv"` / `data-art-drop="nv"` mark the dialog's.
const artFileTarget = (el: Element, attrName: string): "create" | "nv" => (el.getAttribute(attrName) === "nv" ? "nv" : "create");
mount.addEventListener("change", (e) => {
  const el = e.target as HTMLElement;
  if (el instanceof HTMLInputElement && el.type === "file" && el.hasAttribute("data-art-file")) readArtFile(el.files?.[0], artFileTarget(el, "data-art-file"));
});
mount.addEventListener("dragover", (e) => {
  if ((e.target as Element | null)?.closest?.("[data-art-drop]")) e.preventDefault();
});
mount.addEventListener("drop", (e) => {
  const zone = (e.target as Element | null)?.closest?.("[data-art-drop]");
  if (!zone) return;
  e.preventDefault();
  readArtFile(e.dataTransfer?.files[0], artFileTarget(zone, "data-art-drop"));
});
// Enter in an input that names a `data-enter` act dispatches it (the artifact form's Link field).
mount.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const el = (e.target as Element | null)?.closest?.<HTMLInputElement>("input[data-enter]");
  if (!el) return;
  e.preventDefault();
  dispatch(el.dataset.enter ?? "", null, null);
});

mount.addEventListener("input", (e) => {
  const el = e.target as HTMLElement;
  if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.dataset.act) {
    // The caret rides along: "ticketComment" needs it to decide whether the
    // cursor is inside an @mention token. Every other case ignores it.
    dispatch(el.dataset.act, el.dataset.arg ?? null, el.value, el.selectionStart);
  }
});

// ── @mention picker: keyboard + the mousedown/blur race ──────────────────────
//
// A mousedown on a picker row would blur the textarea, and the focusout below
// closes the picker — which removes the row before its `click` ever fires. So
// rows preventDefault on mousedown: focus never leaves the textarea, no blur
// happens, and the row's click reaches the EXISTING click delegate normally.
mount.addEventListener("mousedown", (e) => {
  if ((e.target as Element | null)?.closest?.('[data-act="mentionPick"]')) e.preventDefault();
});

// Clicking genuinely elsewhere closes the picker. `focusout` (not `blur`,
// which doesn't bubble) so one listener on the mount covers the textarea.
mount.addEventListener("focusout", (e) => {
  if (!state.mention) return;
  if (!(e.target as Element | null)?.closest?.('[data-field="ticketComment"]')) return;
  // rerender() swaps the whole mount's innerHTML and re-focuses the textarea,
  // which some browsers surface as a focusout. Settle a tick first and close
  // only if focus really left the box — otherwise an arrow key would close
  // the very picker it was moving through.
  setTimeout(() => {
    if (!state.mention) return;
    if (document.activeElement?.closest('[data-field="ticketComment"]')) return;
    state.mention = null;
    rerender();
  }, 0);
});

// ── comment box: the bottom-left resize grip ─────────────────────────────────
//
// The textarea sets `resize:none` — the native handle writes its height INLINE
// on the element, and the very next keystroke's rerender() swaps the whole
// mount's innerHTML, so a native resize survived exactly one character. This
// drag puts the height in `state.commentHeight` instead, where it outlives the
// swap, and moves the affordance to the corner the Comment button vacated.
// (`commentGrip` has no dispatch case on purpose: the click it also fires falls
// through to `default: return`, a no-op.)
mount.addEventListener("pointerdown", (e) => {
  if (!(e.target as Element | null)?.closest?.('[data-act="commentGrip"]')) return;
  const box = mount.querySelector<HTMLTextAreaElement>('[data-field="ticketComment"]');
  if (!box) return;
  e.preventDefault();                       // no text selection while dragging
  const startY = e.clientY;
  const startHeight = box.getBoundingClientRect().height;
  const move = (ev: PointerEvent) => {
    const h = Math.max(COMMENT_BOX.minHeight, Math.round(startHeight + (ev.clientY - startY)));
    state.commentHeight = h;
    // Paint it straight onto the live element: a rerender per pointermove would
    // rebuild the screen (and steal the caret) dozens of times a second.
    box.style.height = `${h}px`;
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
});

// Arrow/Enter/Tab/Escape belong to the picker ONLY while it is open — with it
// closed, Enter keeps the textarea's normal newline and Tab still moves focus.
mount.addEventListener("keydown", (e) => {
  const m = state.mention;
  if (!m) return;
  if (!(e.target as Element | null)?.closest?.('[data-field="ticketComment"]')) return;
  const cands = mentionCandidates(state.persons.data, m.query);
  if (!cands.length) return;
  const n = cands.length;
  switch (e.key) {
    case "ArrowDown": e.preventDefault(); state.mention = { ...m, index: (m.index + 1) % n }; rerender(); break;
    case "ArrowUp": e.preventDefault(); state.mention = { ...m, index: (m.index - 1 + n) % n }; rerender(); break;
    case "Enter":
    case "Tab": {
      e.preventDefault();
      const pick = cands[((m.index % n) + n) % n];
      if (pick) dispatch("mentionPick", pick.handle, null);
      break;
    }
    case "Escape": e.preventDefault(); state.mention = null; rerender(); break;
    default: break;
  }
});

// ── link fields: Enter adds, and a paste that is a link adds on its own ───────
// The ticket's Linked work field and the sprint's Resources field. The server
// parses (and refuses) the raw text; this only decides whether a paste LOOKS like
// links, so pasting a half-typed note never fires a write.
const LINK_FIELDS: Record<string, string> = { ticketLinkDraft: "ticketLinkAdd", "sprint-resource": "sprintResourceAdd" };
/** Whitespace-separated pieces of a link field's text. */
function splitLinks(text: string): string[] {
  return text.split(/\s+/).map((x) => x.trim()).filter(Boolean);
}
const looksLikeLinks = (text: string): boolean => {
  const parts = splitLinks(text);
  return parts.length > 0 && parts.every((x) => /^https?:\/\/\S+$/i.test(x) || /^#?\d+$/.test(x));
};
const linkFieldAct = (el: EventTarget | null): { input: HTMLInputElement; act: string } | null => {
  const input = (el as Element | null)?.closest?.<HTMLInputElement>("input[data-field]");
  const act = input ? LINK_FIELDS[input.dataset.field ?? ""] : undefined;
  return input && act ? { input, act } : null;
};
mount.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  const f = linkFieldAct(e.target);
  if (!f || !f.input.value.trim()) return;
  e.preventDefault();
  dispatch(f.act, null, null);
});
mount.addEventListener("paste", (e) => {
  const f = linkFieldAct(e.target);
  if (!f) return;
  // Let the paste land in the field (and its input event update the draft) first.
  setTimeout(() => { if (looksLikeLinks(f.input.value)) dispatch(f.act, null, null); }, 0);
});

/** Add a typed tag to the prompt editor's draft (lowercase, a–z 0–9 and "-"). */
function addEdTag(raw: string): void {
  const ed = state.promptEd;
  if (!ed) return;
  const t = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (t && !ed.tags.includes(t)) ed.tags = [...ed.tags, t];
  ed.tagDraft = "";
}

// ── prompt tag fields: Enter adds, Backspace on an empty draft drops the last, Escape closes ──
mount.addEventListener("keydown", (e) => {
  const field = (e.target as HTMLElement | null)?.dataset?.field;
  if (field === "edTagDraft" && state.promptEd) {
    if (e.key === "Enter") { e.preventDefault(); addEdTag(state.promptEd.tagDraft); rerender(); }
    else if (e.key === "Backspace" && !state.promptEd.tagDraft && state.promptEd.tags.length) { state.promptEd.tags = state.promptEd.tags.slice(0, -1); rerender(); }
    return;
  }
  if (field === "promptTagDraft") {
    if (e.key === "Escape") { state.promptTagMenu = false; state.promptTagDraft = ""; rerender(); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const p = state.promptDetail.data?.prompt;
    const first = p ? tagOptions(p.tags, state.promptList.data.flatMap((x) => x.tags), state.promptTagDraft)[0] : undefined;
    if (first) dispatch("promptTagAdd", first.tag, null);
  }
});
// Escape closes the expanded handoff prompt (the filter menus close in their own listener).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || state.view !== "app") return;
  if (state.personCard) { state.personCard = null; rerender(); }
  else if (state.mcpSetup) closeMcpSetup();
  else if (state.handoffPromptOpen) { state.handoffPromptOpen = false; rerender(); }
  else if (state.promptExpanded) { state.promptExpanded = false; rerender(); }
});

// ── the confirmation modal (web/src/confirm.ts): ONE keyboard contract for every
// `[data-confirm-dialog]` — the prompt page's and the artifact viewer's delete. Capture
// phase, so no other Escape / Enter handler also acts while it is open.
//   Enter  — confirms. On the focused Delete button the browser's own click does it; on
//            anything else (the dialog, the page after focus fell out) it is dispatched
//            here. Enter on a focused Cancel still cancels (its own click).
//   Escape — cancels (focus goes back to the trigger).
//   Tab    — trapped inside the dialog.
// While the write runs (`data-busy`) every key is swallowed, so a held or repeated Enter
// never deletes twice — the reducers' busy guards say the same.
document.addEventListener("keydown", (e) => {
  if (state.view !== "app" && state.view !== "platform") return;
  const dlg = mount.querySelector<HTMLElement>("[data-confirm-dialog]");
  if (!dlg) return;
  const t = e.target instanceof HTMLButtonElement ? e.target : null;
  const what = confirmKeyAction(e.key, { onDialogButton: !!t && dlg.contains(t) && !t.disabled, busy: dlg.hasAttribute("data-busy"), repeat: e.repeat });
  if (what === null || what === "native") return;
  e.preventDefault(); e.stopImmediatePropagation();
  const arg = dlg.getAttribute("data-arg");
  if (what === "confirm") dispatch(dlg.getAttribute("data-confirm-act") ?? "", arg, null);
  else if (what === "cancel") dispatch(dlg.getAttribute("data-confirm-cancel") ?? "", arg, null);
  else if (what === "trap") {
    const items = Array.from(dlg.querySelectorAll<HTMLElement>("button:not([disabled])"));
    if (!items.length) { dlg.focus(); return; }
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (e.shiftKey ? items.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  }
}, true);

// ── sidebar: ⌘K / Ctrl+K, the search box, and the collapsed-rail tooltip ──────
document.addEventListener("keydown", (e) => {
  if (state.view !== "app" || e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  e.preventDefault();
  dispatch("sideSearchFocus", null, null);
});
mount.addEventListener("keydown", (e) => {
  const box = (e.target as Element | null)?.closest?.<HTMLInputElement>('[data-field="sideSearch"]');
  if (!box) return;
  // ↑/↓ move, Enter opens (the Search screen when there is nothing to pick), Tab or
  // ⌘Enter = all results, Esc closes and clears.
  if (qs.key(e, box)) { e.preventDefault(); e.stopPropagation(); }
});
mount.addEventListener("focusin", (e) => {
  const box = (e.target as Element | null)?.closest?.<HTMLInputElement>('[data-field="sideSearch"]');
  if (box) qs.focus(box);
});

// The rail's labels are gone when it is collapsed, so each row names itself in a
// tooltip. It is positioned here rather than in CSS because the nav list scrolls,
// and a scroll container clips anything that hangs outside it.
function railTip(row: HTMLElement | null): void {
  const tip = mount.querySelector<HTMLElement>(".cnpy-tip");
  if (!tip) return;
  if (!row || !railCollapsed(state)) { tip.removeAttribute("data-on"); return; }
  const r = row.getBoundingClientRect();
  tip.textContent = row.dataset.tip ?? "";
  tip.style.top = `${Math.round(r.top + r.height / 2)}px`;
  tip.setAttribute("data-on", "1");
}
mount.addEventListener("mouseover", (e) => railTip((e.target as Element | null)?.closest?.<HTMLElement>(".cnpy-aside [data-tip]") ?? null));
mount.addEventListener("focusin", (e) => railTip((e.target as Element | null)?.closest?.<HTMLElement>(".cnpy-aside [data-tip]") ?? null));
mount.addEventListener("focusout", () => railTip(null));
mount.addEventListener("mouseleave", () => railTip(null));

// Escape closes the landing page's sign-in dialog, wherever focus is.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !state.signInOpen || state.view !== "auth") return;
  state.signInOpen = false;
  rerender();
});

// ── boot: detect session via /auth/me ────────────────────────────────────────
const params = new URLSearchParams(location.search);
if (params.get("denied") === "1") {
  // A GitHub sign-in that was refused (/auth/callback): the login belongs to another GitHub account.
  state.view = "auth";
  state.authStep = "nonmember";
  rerender();
} else if (params.get("denied") === "invite") {
  // Google account not invited (or unverified email): /auth/google/callback redirected here
  state.view = "auth";
  state.authStep = "notinvited";
  state.deniedEmail = params.get("email");
  rerender();
} else if (location.hash === "#onboard") {
  // Fresh Google/GitHub sign-in with no existing person: the sealed `onboard`
  // cookie is set, and /auth/onboard reads it. A signed-in reload on #onboard
  // with no (or an expired) cookie falls back to the login card — #onboard is
  // never a Screen, so screenFromHash() would never route here on its own.
  state.view = "auth";
  state.authStep = "verifying";
  rerender();
  getOnboardPrefill()
    .then((p) => {
      state.onboard = { ...initialOnboard(), prefill: p, handle: p.suggested_handle, name: p.name ?? "", check: "checking" };
      state.authStep = "onboard";
      scheduleHandleCheck();
      rerender();
    })
    .catch(() => {
      state.authStep = "login";
      history.replaceState(null, "", "/");
      rerender();
    });
} else {
  // Show "verifying" while we check if a session cookie exists
  state.view = "auth";
  state.authStep = "verifying";
  rerender();
  getMe()
    .then((me) => {
      state.me = me;
      state.displayName = me.name ?? me.handle;
      // The Platform entry and its screens hang on this; `GET /api/orgs` confirms it.
      state.plat.superadmin = me.superadmin === true;
      // Return-to after sign-in (see "signIn"): the stashed hash and org, once.
      let back: string | null = null, backOrg: string | null = null, last: string | null = null;
      try {
        back = sessionStorage.getItem(RETURN_HASH_KEY);
        backOrg = sessionStorage.getItem(RETURN_ORG_KEY);
        sessionStorage.removeItem(RETURN_HASH_KEY);
        sessionStorage.removeItem(RETURN_ORG_KEY);
      } catch { /* ignore */ }
      try { last = localStorage.getItem(LAST_ORG_KEY); } catch { /* ignore */ }
      const hash = back ?? location.hash;
      // Where this load lands (org-context.ts): the org in the path; else, from `/` (an old
      // deep link, an e-mail link), the person's only org or the one last opened here; else
      // the picker — with the hash kept, so opening an org still lands on what the link was for.
      // `/platform/`: the superadmin's area, whatever orgs they are in (or none). Anyone else falls through to the picker.
      // So does a `#platform…` link opened at `/` by a superadmin with no org to open it in.
      if (me.superadmin === true && (isPlatformPath(location.pathname) || (me.orgs.length === 0 && /^#platform(?:\/|$)/.test(hash)))) { void loadMyOrgs(); enterPlatform(hash); return; }
      const land = resolveLanding({ pathSlug: orgSlugFromPath(location.pathname), orgs: me.orgs, lastUsed: last, returnOrg: backOrg });
      if (land.kind === "org") { enterOrg(land.slug, hash); return; }
      if (back && back !== location.hash) history.replaceState(null, "", `${location.pathname}${back}`);
      showPicker(land.lost);
    })
    .catch(() => {
      // Unauthorized or any error → show login
      state.view = "auth";
      state.authStep = "login";
      rerender();
    });
}
