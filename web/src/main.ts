// App entry: holds the single in-memory state, mounts the UI, dispatches DOM
// events to state changes, and loads real data per screen from the cookie-gated
// routes via ./api. Wiring proceeds screen by screen (Phase 2); unwired screens
// still render their Phase-1 mock until their task lands.

import "./trov.css";
import "./zoom-boot";      // first: the big-screen zoom (zoom.ts) is set before anything measures
import { installMarkTips } from "./tip";
import { migrateBrowserStorage } from "./storage-migrate";
import { openLightbox, closeLightbox } from "./lightbox";
import { syncSegments, onSegmentedKey } from "./segmented";
import { REVIEW_EXIT_MS, REVIEW_FILTERS, reviewGroups, groupKeyOf, inReviewFilter, type ReviewFilter, type ReviewVerdict, type ReviewView } from "./review";
import { createImportController } from "./import-actions";
import { installImportDrop, mainDropTarget } from "./import-drop";
import { syncTabBars, onTabBarKey } from "./tabs";
import { syncFavicon } from "./favicon";
import { MW_REPO_TABS, handoffsForMe, type MwRepoTab } from "./mywork";
import type { SidebarBadges } from "@shared/badges";
import {
  render, initialState, reviewProps, maintenanceProps, railCollapsed, spaceName, liveSpaces, paneSpaceSlug, HAPPENINGS_LIMIT, browserConnectCommand, PLUGIN_INSTALL, viewerIsAdmin, syncPropsOf, repoProps,
  FEED_FILTER_CATS, type AppState, type Screen, type FeedFilterCat, type ToastAction,
  stagedPrompts,
} from "./render";
import {
  getFeed, getHome, getOrgGithub, getFeedPage, getFeedStats, listDocMeta, getDoc, search, quickSearch, getRoadmap, getMyDashboard, getRepoDashboard, putRepoSettings,
  acceptRepoSuggestion, ignoreRepoSuggestion, undoRepoSuggestion,
  completeSprint, deleteSprint,
  listStagedProposals, listAdrs, promoteDoc, rejectDoc, ratifyAdr, rejectAdr, approveImport, rejectImport,
  listNeedsTriage, listIdentityTasks, assignTriage, discardTriage, restoreTriage, mapIdentity, discardIdentity, restoreIdentity, type AssignTarget,
  getMe, logout, adminPoll, isRateLimited, rateLimitText,
  getOnboardPrefill, checkHandle, submitOnboard,
  getNotificationPrefs, putNotificationPrefs, getNotificationPolicy, putNotificationPolicy,
  getNotificationSettings, putNotificationSettings, listNotificationOutbox, testSendNotification, type PrefsWrite,
  listOAuthGrants, revokeOAuthGrant, setOAuthGrantOrg, setOAuthGrantCurrent, setOAuthGrantMode, planLimitText,
  listPersons, updateMe, unlinkIdentity, renameHandle,
  getPersonProfile, uploadAvatar, removeAvatar,
  getMyOrgs, getOrgMe, listMcpTokens, revokeMcpToken, setApiOrg, setOrgLostHandler, tenantHref,
  listTickets, getTicket, getTicketBadge, getBadges, createTicket, transitionTicket, moveTicket, toggleTicketAssignee,
  addTicketLink, editTicket, removeTicketLink, deleteTicket, setTicketSprint, setTicketParent, addTicketComment, listSprints,
  getSprint, createSprint, setSprintActive, addSprintResource,
  type TicketDetail, type TicketListItem,
  listArtifacts, getArtifact, getArtifactDiff, createArtifact, patchArtifact, ratifyArtifact, deleteArtifact, restoreArtifact, addArtifactLink, addArtifactVersion, fetchArtifactUrl,
  listHandoffs, getHandoff, listPrompts, getPrompt, getPromptVersions,
  listLinks, getLink, linkStep, closeLinkWeb, addLinkNote, startLink,
  createHandoff, claimHandoff, expireHandoff, savePrompt, setPromptTags, publishPrompt, deletePrompt, restorePrompt,
  Unauthorized, NotFound, ApiError,
} from "./api";
import { handoffAsPrompt, blankHandoff, docDraftFromHandoff, type NewHandoffDraft } from "./handoffs";
import { linkJoinPhrase, blankLinkStart, linkStartTarget, linkStartReady, linkStartRefusal, type LinkStartKind } from "./links";
import { LINK_NOTE_MAX, type LinkView } from "@shared/links";
import { normalizeTags, type HandoffView } from "@shared/handoffs";
import { selectedUnplacedId, effectivePicks, UNPLACED_EXIT_MS, type UnplacedVerdict } from "./maintenance";
import { ASSIGN_OPTIONS } from "./triage-map";
import { draftFromPrompt, blankPromptDraft, slugify, tagOptions } from "./prompts";
import { createLibraryController } from "./library-actions";
import { createNewDocController } from "./newdoc-actions";
import { createTreeController } from "./tree-actions";
import { installTreeDrag, treeKeyTarget } from "./tree-drag";
import { installCustomizeDrag, slideRows } from "./customize-drag";
import { pointerDrag, dragging } from "./pointer-drag";
import { DEFAULT_SPACE } from "@shared/docs-core";
import { SPRINT_URGENCIES, SPRINT_DOMAINS, sprintDatesProblem, sprintDatesLabel, type SprintUrgency, type SprintDomain } from "@shared/sprints-core";
import type { SprintDetail } from "@shared/sprints";
import { parseHash, hashForRoute, sameRoute, pageKey, type Route } from "./hash";
import { mountLandingMotion, unmountLandingMotion } from "./landing-motion";
import { createLandingController } from "./landing-actions";
import { landingChunk } from "./landing-lazy";
import { initFaqAccordion } from "./site-faq";
import {
  TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUS_LABEL, TICKET_STATUSES, canTransition, placeInColumn,
  type TicketCategory, type TicketPriority, type TicketStatus,
} from "@shared/tickets-core";
import { decodeReviewId, reviewItemsFromReads } from "./triage-map";
import { QUEUE_FILTER_CATS, declinedLeavers, type QueueFilterCat } from "./tickets";
import { AI_EXIT_MS } from "./ai-ui";
import { initialOnboard, markAvatarFailed, AVATAR_IMG_CLASS } from "./people";
import { prepareAvatar } from "./avatar";
import { mentionTokenAt, mentionCandidates, applyMention, caretLine, COMMENT_BOX } from "./mentions";
import { PERSON_COLORS, type PersonColor, type OAuthGrantSummary } from "@shared/rows";
import { captureScroll, restoreScroll } from "./scroll";
import { paint } from "./morph";
import { followSkipLink, syncPageBackground } from "./site-chrome";
import { syncSkeletons } from "./skeleton";
import { parsePreview, previewSearch, withPreview, PREVIEW_BLOCKED, type PreviewMode } from "./preview";
import { setWriteBlock } from "./api";
import { isGroupBy } from "@shared/repo-layout-core";
import { REPO_WIDE } from "@shared/repo-facts-core";
import { REPO_SCENARIOS, isScenarioKey } from "./repo-sample-keys";
import { ALL_APPS } from "./repo-core";
import { twinSelector } from "./focus-twin";
import { createQuickSearch, type QuickPick, type QuickRow } from "./quicksearch";
import { homeDropRows, askAvailable as homeAskAvailable } from "./home-view";
import { SENDER_NAME_HELP, senderNamePart, senderNameProblem } from "@shared/sender";
import { platformChunk } from "./platform-lazy";
import type { LazyChunk } from "./lazy-chunk";
import { createTagsController } from "./tags-actions";
import { PLATFORM_PATH, isPlatformPath } from "./platform-core";
import { NAV_GROUPS, navGroupOf, type NavGroup } from "./sidebar";
import { formatCount, repoPollFor, repoUpdatedLabel } from "./repo-core";
import { repoChunk } from "./repo-lazy";
import { isRepoScreenTab, REPO_RANGES, type RepoRange } from "@shared/repo";
// Artifacts is its own chunk (artifacts-lazy.ts): the reducer and the file pickers run once it is in.
import {
  renderPendingMermaid, setArtFrameHeight, detailKey, diffKey, initialArtCreate, ART_ROUTE_NONE, ART_FILTER_KEYS,
  type ArtScreen, type ArtRoute, type ArtFilterKey, type ArtFile,
} from "./artifacts-state";
import type { ArtEffect, ArtWrite } from "./artifacts";
import { artifactsChunk } from "./artifacts-lazy";
import { kindForFilename, isBinaryKind } from "@shared/artifacts-core";
import { confirmKeyAction } from "./confirm";
import { createAiController, readNoteSeen } from "./ai-actions";
import { createAskController } from "./ask-controller";
import { createTrovPrefs } from "./ask-settings-actions";
import { createAiFilterController } from "./ai-filter-actions";
import type { AiFilterSnapshot } from "./ai-filter";
import type { AiFilterByScreen, AiFilterScreen, ArtifactsAiFilter, FeedAiFilter, TicketsAiFilter } from "@shared/ai-filter-core";
import { createOrgsController } from "./org-picker-actions";
import { createSupport } from "./support-actions";
import { createDeletion, DELETED_PARAM, DELETED_SENTENCE } from "./deletion-actions";
import { LATEST_RELEASE } from "./release-latest";
import { releasesLoaded, releasesFailed, loadReleases } from "./releases-lazy";
import { createWelcomeController, parseWelcomeReturn, welcomeReturnHash, WELCOME_RETURN_KEY } from "./welcome-actions";
import { FIRST_RUN_KEY, effectiveWelcomeStep, welcomeStepsFor } from "./welcome";
import { currentOrg, isOrgTab } from "./org-core";
import { roleAtLeast } from "./org-ui";
import { orgChunk } from "./org-lazy";
import { createSyncController } from "./sync-actions";
import { createDropdowns } from "./dropdown";
import { initialOrgsUi } from "./org-picker";
import { LAST_ORG_KEY, RETURN_HASH_KEY, RETURN_ORG_KEY, orgBase, orgHref, orgSlugFromPath, resolveLanding } from "./org-context";
import { SETUP_PARAM, initialBillingDone, startBillingDone } from "./billing";
import { morphStep } from "./transition";
import { BILLING_CHECKOUT_PATH, BILLING_DONE_PATH, PRICING_PATH, signInReturnPath } from "@shared/billing";
import { askBillingCheckout, getBillingStatus, getAskState } from "./api";
import { BILLING_MOUNT_ID, billingCheckoutHosted, initialBillingCheckout, startBillingCheckout, type BillingCheckoutHost } from "./billing-checkout";
import { loadStripeEmbedder } from "./stripe-js";
import { setPrimaryRepo } from "./github";
import { GITHUB_LOGIN_RE, type MyOrgsResponse } from "@shared/orgs";
import { isGithubConnectOutcome } from "@shared/github-app";
import { isHostingConnectOutcome, isHostingProvider } from "@shared/hosting";
import { createPaintQueue } from "./paint-queue";
import { onMarkdownLib, prefetchMarkdownLib } from "./markdown-load";
import { pointOf, rectOf } from "./zoom";
import { boardCardId, boardDropArg } from "./board-drop";

const root = document.getElementById("app");
if (!root) throw new Error("Trov: #app mount point missing");
const mount = root;

const state: AppState = initialState();

// When a paint runs (web/src/paint-queue.ts; web-ui.md › Paints: now, batched, or once a frame).
// `rerender()` paints NOW — its callers focus or measure right after it. `rerenderSoon()` is a read
// landing: every one that lands before the next frame shares one paint. `batchRender(fn)` folds the
// paints `fn` asks for into one, made before it returns (the boot, a screen's loaders).
const paints = createPaintQueue(() => paintApp());
function rerender(): void { paints.now(); }
function rerenderSoon(): void { paints.soon(); }
function batchRender<T>(fn: () => T): T { return paints.batch(fn); }
// marked + DOMPurify are their own chunk (markdown-load.ts): a body drawn before it is in is a
// placeholder, and its arrival repaints — a read landing, so it shares the next frame's paint.
onMarkdownLib(() => rerenderSoon());

// The state preview (web/src/preview.ts): `?preview=empty` / `?preview=loading`, read once here
// and kept in the address bar while it is on (a reload stays in it). While it is on api.ts
// refuses every write; the refusal is said as a toast AFTER the caller's own "couldn't save"
// (a timeout, so this is the one that stays).
function applyPreview(mode: PreviewMode | null): void {
  state.preview = mode;
  setWriteBlock(mode ? () => { setTimeout(() => flash(PREVIEW_BLOCKED, 4200), 0); } : null);
}
applyPreview(parsePreview(location.search));

// The sidebar's "search everything" dropdown. Its node lives on <body>, outside the
// mount, so rerender() never touches it; rerender() calls `qs.sync()` to re-anchor it.
const qs = createQuickSearch({
  fetch: (q, signal) => quickSearch(q, signal),
  pick: quickPick,
  theme: () => resolvedTheme(),
  railCollapsed: () => railCollapsed(state), // on a phone the drawer is the full, expanded rail
});

// Sync GitHub (web/src/sync-actions.ts): the panel, the batch loop and its polling — in module
// scope, so a run survives closing the panel and moving between screens.
const syncCtl = createSyncController({
  mount, ui: () => state.sync, props: () => syncPropsOf(state), inApp: () => state.view === "app",
  rerender: () => rerender(), unauth: (e) => unauth(e), reloadMyWork: () => loadMyWork(),
});

// Org settings (web/src/org-actions.ts): every `org…` act, its loads, and the secret form's draft.
// Its own chunk (org-lazy.ts): the controller is made when the chunk lands, and a load or an act asked
// for before then runs once it has (`withChunk`). Before it is made there is no form to tidy after a paint.
type OrgCtl = import("./org-actions").OrgController;
let orgCtlMade: OrgCtl | null = null;
function withOrgCtl(fn: (c: OrgCtl) => void): void {
  withChunk(orgChunk, (m) => {
    orgCtlMade ??= m.createOrgController({
      state, mount, rerender: () => rerender(), flash: (msg, ms, a) => flash(msg, ms, a ?? null), unauth: (e) => unauth(e), confirmOut: (then) => confirmOut(then),
      reloadOrgs: () => loadMyOrgs(), leaveOrg: () => showPicker(null),
    });
    fn(orgCtlMade);
  });
}
const orgCtl: OrgCtl = {
  act: (act, arg, value) => withOrgCtl((c) => c.act(act, arg, value)),
  load: () => withOrgCtl((c) => c.load()),
  loadPlan: () => withOrgCtl((c) => c.loadPlan()),
  afterPaint: () => { orgCtlMade?.afterPaint(); },
};
// The organization's tag list (web/src/tags-actions.ts): every `tag…` act, the list's read, a tag's page.
const tagsCtl = createTagsController({
  state, mount, rerender: () => rerender(), rerenderSoon: () => rerenderSoon(), flash: (m, ms) => flash(m, ms), unauth: (e) => unauth(e), confirmOut: (then) => confirmOut(then),
  search: (q) => { openSearchScreen(q); }, planChanged: () => orgCtl.loadPlan(), goList: () => dispatch("orgGo", "tags", null),
});
// The Docs Library (web/src/library-actions.ts): every `lib…` act, the Library's read, a space's home.
const libCtl = createLibraryController({
  state, mount, rerender: () => rerender(), rerenderSoon: () => rerenderSoon(), flash: (m, ms, a) => flash(m, ms, a ?? null), unauth: (e) => unauth(e), confirmOut: (then) => confirmOut(then),
  // Archive page / Restore (0083_doc_archive): Review's queue (when held) and the badges lose or regain its waiting
  // versions; the open doc page — the page itself, or one whose "Pages under" or links it was in — is read again.
  pageChanged: () => {
    if (state.proposals.status !== "idle") loadProposals();
    loadBadges();
  },
  treeChanged: () => { if (state.screen === "docs" && state.docSlug) loadDoc(state.docSlug); },
  openDoc: (slug) => dispatch("openDocFrom", slug, null),
  newPage: (space) => dispatch("newDoc", space || null, null),
  slide: (paint) => slideRows(mount, paint, reducedMotion()),
});
// The Markdown import (web/src/import-actions.ts): every `imp…` act — the wizard, the files read in the browser, the run
// (in module scope, so it keeps going on any screen) and Imports history.
const impCtl = createImportController({
  state, mount, rerender: () => rerender(), rerenderSoon: () => rerenderSoon(), flash: (m, ms, a) => flash(m, ms, a ?? null), unauth: (e) => unauth(e),
  ensureSpace: (slug) => libCtl.ensureSpace(slug),
  spaceName: (slug) => spaceName(state, slug),
  landed: (space) => {
    // What a run changed: Review's queue (when it is held), the Library's counts, the space's pages, the badges.
    if (state.proposals.status !== "idle") loadProposals();
    libCtl.load();
    const h = state.spaceHome;
    if (h.data?.space.slug === space) {
      if (state.screen === "space" || state.screen === "docs" || state.screen === "newdoc") libCtl.openSpace(space);
      else state.spaceHome = { status: "idle", data: h.data };
    }
    loadBadges();
  },
});
// Drop to import (web/src/import-drop.ts): files over a space's page or a sidebar space row open the wizard there.
installImportDrop({
  enabled: () => state.view === "app" && state.screen !== "import",
  mainSpace: () => {
    const slug = state.screen === "space" || state.screen === "docs" || state.screen === "newdoc" ? paneSpaceSlug(state) : null;
    return mainDropTarget(state.screen, slug && liveSpaces(state).some((x) => x.slug === slug) ? { slug, name: spaceName(state, slug) } : null);
  },
  spaceName: (slug) => (liveSpaces(state).some((x) => x.slug === slug) ? spaceName(state, slug) : null),
  drop: (files, space) => impCtl.dropTo(files, space),
  bad: (msg) => flash(msg, 4200),
});
// New page (web/src/newdoc-actions.ts): every `nd…` act — the template, where it goes, the fields, staging it.
const ndCtl = createNewDocController({
  state, mount, rerender: () => rerender(), flash: (m, ms) => flash(m, ms), unauth: (e) => unauth(e),
  ensureSpace: (slug) => libCtl.ensureSpace(slug),
  staged: (space, slug) => {
    // The new page, "Not yet approved": the pane's tree is read again (it shows there under its parent, which the
    // page being read opens) and Review's count with it.
    libCtl.openSpace(space);
    loadProposals();
    openDocPage(slug);
  },
  cancel: () => {
    const d = state.nd;
    if (d.parent) { openDocPage(d.parent); return; }
    if (d.space && liveSpaces(state).some((s) => s.slug === d.space)) libCtl.act("libOpenSpace", d.space, null);
    else dispatch("goLibrary", null, null);
  },
});
// The docs pane (web/src/tree-actions.ts): a page's children, its "…" menu, a page inside it, On this page, a move.
const treeCtl = createTreeController({
  state, mount, rerender: () => rerender(), flash: (m, ms, a) => flash(m, ms, a ?? null), unauth: (e) => unauth(e),
  newPage: (space, parent) => { state.screen = "newdoc"; ndCtl.start(space, parent); },
  reducedMotion: () => reducedMotion(),
  // The open doc page's children and breadcrumb come from its own read, not the pane's: read it again after a move.
  treeChanged: () => { if (state.screen === "docs" && state.docSlug) loadDoc(state.docSlug); },
});
// Trov's AI screens (web/src/ai-actions.ts): every `ai…` act — "Wrong?", the Feed's Source switch and
// note, the themes' range and lane, Accept / Rename / Remove on a suggestion.
const aiCtl = createAiController({
  state, mount, rerender: () => rerender(), flash: (m, ms) => flash(m, ms), unauth: (e) => unauth(e),
  flashNext: (sel) => { pendingFlash = sel; },
  reloadRepo: () => { if (!state.repoSample && state.repo.status !== "loading") loadRepo(); },
  // A decision went through and its exit is over (the controller waits for the last one, ai-ui.ts › Leaving): the
  // screen it was on reads what it changed — the ticket, Unplaced, Review, or the Roadmap (an accepted sprint draft or
  // narrative changed the plan; a dismissed card goes too). The Roadmap's read is handed back: once it lands, what the
  // Accept changed rises in (ai-actions.ts › THE ROADMAP'S DIALOG).
  decided: (id, how) => {
    if (state.screen === "ticketdetail" && state.ticketId !== null) loadTicketDetail(state.ticketId);
    else if (state.screen === "review" && state.reviewView === "unplaced") {
      // An accepted destination PLACED its item (the same gate as Place): the card leaves by the queue's exit, then
      // the read is taken again. Anything else re-reads at once.
      const row = how === "accept" ? state.needsTriage.data.find((r) => r.ai?.some((s) => s.id === id)) : undefined;
      if (row) unplacedVerdict(String(row.id), "placed", () => Promise.resolve(), () => loadProposals());
      else loadNeedsTriage();
    }
    else if (state.screen === "review") { loadProposals(); loadDraftAdrs(); }
    else if (state.screen === "roadmap") return loadRoadmap();
  },
  // The Roadmap's Trov dialog lost its last suggestion to a decision: it closes by its own exit, and focus goes back
  // to its button (or, with nothing left to count, to the page).
  closeRoadmapTrov: () => {
    if (!state.rmTrovOpen) return;
    confirmOut(() => {
      state.rmTrovOpen = false;
      rerender();
      (mount.querySelector<HTMLElement>(".rm-trov-btn") ?? mount.querySelector<HTMLElement>("#cnpy-main"))?.focus({ preventScroll: true });
    });
  },
});
// Ask Trov (web/src/ask-controller.ts): every `ask…` act, the screen's reads and streams, ⌘J over any page,
// the hover cards, the inspector's edge, and the dev replay (`?askReplay=<scenario>`).
const askCtl = createAskController({ state, mount, rerender: () => rerender(), flash: (m, ms) => flash(m, ms), unauth: (e) => unauth(e),
  refreshTickets: () => { if (state.tickets.status !== "idle") loadTickets(); } });
// The plain-language filter (web/src/ai-filter-actions.ts, #162): every `aiFilter…` act. Its answer is applied
// to each screen's OWN filter state here — the same fields the Filter menu, the switch and the search box set.
const aiFilterCtl = createAiFilterController({
  state, rerender: () => rerender(), unauth: (e) => unauth(e),
  role: () => currentOrg(state)?.role ?? null,
  snapshot: (screen) => aiFilterSnapshot(screen),
  apply: (screen, filter) => applyAiFilter(screen, filter),
  restore: (screen, snap) => restoreAiFilter(screen, snap),
  closeMenu: (screen) => closeFilterMenu(AI_FILTER_MENU[screen]),
  leave: (key) => aiCtl.leave(key),
  flash: (m) => flash(m),
  names: () => ({
    me: state.me?.handle ?? "",
    person: (h) => state.persons.data.find((p) => p.handle.toLowerCase() === h.toLowerCase())?.name || h,
    sprint: (id) => state.sprints.data.find((x) => String(x.id) === id)?.label ?? `Sprint #${id}`,
  }),
});
/** Each typed filter's Filter menu (its `FILTER_MENUS` id, below). */
const AI_FILTER_MENU: Record<AiFilterScreen, string> = { tickets: "queue", feed: "feed", artifacts: "art" };
/** One screen's filter state, as Undo puts it back. */
function aiFilterSnapshot(screen: AiFilterScreen): AiFilterSnapshot {
  if (screen === "tickets") return { qSeg: state.qSeg, qAssignee: state.qAssignee, qPerson: state.qPerson, qCategory: state.qCategory, qPrio: state.qPrio, qSprint: state.qSprint, qQ: state.qQ };
  if (screen === "feed") return { feedAuthor: state.feedAuthor, feedTag: state.feedTag, feedRange: state.feedRange };
  return { q: state.art.q, f: { ...state.art.f } };
}
/** Put a screen's filter state back, and reload what the server filters. */
function restoreAiFilter(screen: AiFilterScreen, snap: AiFilterSnapshot): void {
  if (screen === "tickets") { Object.assign(state, snap); loadTickets(); return; }
  if (screen === "feed") { Object.assign(state, snap); loadFeed(); return; }
  Object.assign(state.art, snap);
}
/** Set a screen's filters to EXACTLY the answer: a field it leaves out is "no filter" (what Clear all sets),
 *  so the screen shows what the sentence asked for and nothing left over from before. */
function applyAiFilter<S extends AiFilterScreen>(screen: S, filter: AiFilterByScreen[S]): void {
  if (screen === "tickets") {
    const f = filter as TicketsAiFilter;
    state.qSeg = f.status ?? "all";
    // One person is `anyone` fetched and narrowed here, as the menu's `@handle` does.
    state.qPerson = f.person ?? "";
    state.qAssignee = f.person ? "anyone" : f.assignee ?? "anyone";
    state.qCategory = f.category ?? "all";
    state.qPrio = f.priority ?? "all";
    state.qSprint = f.sprint ?? "all";
    state.qQ = f.text ?? "";
    loadTickets();
    return;
  }
  if (screen === "feed") {
    const f = filter as FeedAiFilter;
    state.feedAuthor = f.author ?? "all";
    state.feedTag = f.tag ?? "all";
    state.feedRange = f.range ?? "all";
    // The Author menu lists the authors of the unfiltered feed: the one picked is offered even when it is not.
    if (f.author && !state.feedAuthors.includes(f.author)) state.feedAuthors = [...state.feedAuthors, f.author];
    loadFeed();
    return;
  }
  const f = filter as ArtifactsAiFilter;
  state.art.q = f.text ?? "";
  state.art.f = { area: f.area ?? "all", kind: f.kind ?? "all", author: f.author ?? "all", status: f.status ?? "all", sprint: f.sprint ?? "all" };
}
// Organizations as a person meets them (web/src/org-picker-actions.ts): the switcher's menu, the
// picker, the create dialog — every `orgs…` act. Opening an org is a page load.
const orgsCtl = createOrgsController({
  state, mount, rerender: () => rerender(), flash: (m, ms) => flash(m, ms), unauth: (e) => unauth(e),
  reloadOrgs: () => loadMyOrgs(), go: (url) => { window.location.assign(url); }, openSettings: () => dispatch("orgGo", null, null),
  // A first run: the picker has held no org's data, so the org just created or joined is entered in
  // place and the card morphs into the guided setup — no page load, no flash of a blank page.
  enterNew: (org, hash) => {
    if (state.view !== "orgs" || enteredAnOrg || !state.me) return false;
    if (!state.me.orgs.some((o) => o.slug === org.slug)) state.me.orgs = [...state.me.orgs, org];
    if (state.myOrgs.data && !state.myOrgs.data.orgs.some((o) => o.slug === org.slug)) state.myOrgs.data = { ...state.myOrgs.data, orgs: [...state.myOrgs.data.orgs, org] };
    morphStep(() => { state.orgsUi = initialOrgsUi(); enterOrg(org.slug, hash); rerender(); });
    return true;
  },
});

// The guided first-run setup (web/src/welcome-actions.ts): every `welcome…` act, the agent step's
// re-check, and the note that brings a return from GitHub back to it.
const welcomeCtl = createWelcomeController({
  state, mount, rerender: () => rerender(), loadOrg: () => orgCtl.load(), loadHome: () => loadMyWorkIfNeeded(), loadConnections: () => loadGrantsIfNeeded(),
  reloadConnections: () => { loadGrants(); loadMcpTokens(); }, listGrants: () => listOAuthGrants(),
  unauth: (e) => unauth(e), go: (url) => { window.location.href = url; },
});

// The support form (web/src/support-actions.ts): every `support…` act. Signed in — the header's bug
// button, Settings › Contact support, the picker's link — what it attaches is read when the dialog
// opens: the route on screen, the org the person is in (none on the picker or the Platform page), the
// newest release and the browser, and nothing else. Signed out (the site's Contact) it is the same
// dialog in its anonymous setting: the page's path, the browser, and the address they type.
const supportCtl = createSupport({
  state, mount, rerender: () => rerender(), unauth: (e) => unauth(e),
  signedIn: () => state.view !== "auth",
  context: () => (state.view === "auth"
    ? { route: `${location.pathname}${location.hash}`, org: null, version: "", userAgent: navigator.userAgent }
    : { route: location.hash, org: state.view === "app" ? state.orgSlug : null, version: LATEST_RELEASE.version, userAgent: navigator.userAgent }),
});

// Deleting one's account (Settings) and an organization (Org settings › General, its owner) — web/src/deletion-actions.ts.
// A success is a page load: everything this page holds belonged to what was deleted.
const deletionCtl = createDeletion({
  state, mount, rerender: () => rerender(), unauth: (e) => unauth(e), confirmOut: (then) => confirmOut(then),
  leave: (href) => {
    try { if (state.orgSlug && localStorage.getItem(LAST_ORG_KEY) === state.orgSlug) localStorage.removeItem(LAST_ORG_KEY); } catch { /* ignore */ }
    location.replace(href);
  },
});

// Settings › Trov (ask-settings-actions.ts): my Ask instructions and default mode in the org on screen.
const trovPrefsCtl = createTrovPrefs({ state, rerender: () => rerender(), unauth: (e) => unauth(e), flash: (m, ms) => flash(m, ms) });

// The dropdowns (web/src/dropdown.ts): opening, closing (with its exit), the keyboard, and
// placing the open menu against its trigger. A pick is dispatched as the dropdown's own act.
const dropdowns = createDropdowns({ state, mount, rerender: () => rerender(), dispatch: (act, arg, value) => dispatch(act, arg, value) });

// ── persisted client prefs (theme + sidebar only; not backend state) ─────────
migrateBrowserStorage(); // canopy.* → trov.* (the rename) before the first read
initFaqAccordion();      // the Questions accordion on the landing page (site-faq.ts): one delegated listener
try {
  const t = localStorage.getItem("trov.theme");
  if (t === "dark" || t === "light" || t === "system") state.theme = t;
  else if (t === "midnight") state.theme = "dark"; // Midnight was retired (2026-09-26) — its closest theme
  state.ai.noteSeen = readNoteSeen();
  const fv = localStorage.getItem("trov.feedView");
  if (fv === "reading" || fv === "agents") state.feedView = fv;
  const pv = localStorage.getItem("trov.promptView");
  if (pv === "raw" || pv === "rendered") state.promptView = pv;
  const c = localStorage.getItem("trov.collapsed");
  if (c) state.collapsed = c === "1";
  const open = JSON.parse(localStorage.getItem("trov.navOpen") ?? "{}") as Record<string, unknown>;
  // Only live groups are read, so a retired one's key (tickets, maintenance, repo) is ignored. The Library was
  // Docs: a stored `docs` is read as `library` until the next write replaces it.
  if (typeof open.library !== "boolean" && typeof open.docs === "boolean") open.library = open.docs;
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
// A screen's entrance (trov.css `[data-enter]`) plays when the ROUTE changes —
// never on the other rerenders (a keystroke, a hover, a badge or a read landing),
// which would replay it endlessly.
// rerender() swaps <main> wholesale, so a rerender DURING an entrance would cut
// it short; instead the clock keeps running and the fresh DOM joins the animation
// where the old one left off, via a negative animation-delay (`--enter-t`).
const ENTER_MS = 900;
let enterKey = "";
let enterAt = 0;
let enterTimer: ReturnType<typeof setTimeout> | null = null;
/** The next page is one the person was already looking at (My Work behind the guided setup's card):
 *  it does not enter. Consumed by the next `markEnter`. */
let skipEnterOnce = false;

function markEnter(): void {
  const root = mount.firstElementChild as HTMLElement | null;
  if (!root || state.view !== "app") return;
  // An in-page view switch (the header's segmented switch — Roadmap Narrative/Timeline, a
  // release's Release/Patch notes — or a page's tab bar: Roadmap's, Repo's, Org settings'
  // and Platform's tabs) is not a new page: key the entrance on the route WITHOUT it (hash.ts
  // `pageKey`), so flipping the switch swaps the content in place instead of replaying the
  // screen (and the tab bar's underline slides unbroken).
  // The entrance belongs to the ROUTE, never to a read: it plays once, when the page opens —
  // over the loading skeleton if the data is still out — and a read landing later fills the
  // skeleton's boxes with one short fade (skeleton.ts `syncSkeletons`), not a second
  // staggered entrance. A read that lands inside the entrance simply joins it (`--enter-t`).
  const key = `${pageKey(currentRoute())}|${state.repoSample ? "s" : ""}`;
  const now = performance.now();
  if (skipEnterOnce) { skipEnterOnce = false; enterKey = key; enterAt = now - ENTER_MS; }
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

/** Review's detail pane after a paint — in either view (the queue, Unplaced: the same pane): a different item starts at its top (the pane is
 *  the same element now, so it would keep the last item's scroll), and a verdict button that had focus — and went with
 *  its item — gives it to the same button of the item now on screen, so Enter, Enter, Enter works down a queue (an
 *  Unplaced item that cannot be placed yet takes it on its Discard). */
let reviewShown: string | null = null;
function syncReviewDetail(focusAct: string | null): void {
  const body = state.view === "app" && state.screen === "review" ? mount.querySelector<HTMLElement>(".cnpy-rv-body[data-morph-key]") : null;
  const key = body?.getAttribute("data-morph-key") ?? null;
  if (key !== reviewShown) {
    reviewShown = key;
    const pane = body?.closest<HTMLElement>(".cnpy-rv-detail");
    if (pane) pane.scrollTop = 0;
  }
  // The verdict buttons are in the body's head (a decision) or in the page pane's footer beside it (a group's page).
  const detail = body?.closest<HTMLElement>(".cnpy-rv-detail") ?? null;
  if (body && detail && (focusAct === "reviewAccept" || focusAct === "reviewReject" || focusAct === "maintFile" || focusAct === "maintDiscard") && !detail.contains(document.activeElement)) {
    (detail.querySelector<HTMLElement>(`:is(.cnpy-rv-head, .cnpy-rvp-foot) [data-act="${focusAct}"]`)
      ?? (focusAct === "maintFile" ? detail.querySelector<HTMLElement>(`.cnpy-rvp-foot [data-act="maintDiscard"]`) : null))?.focus({ preventScroll: true });
  }
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

// ── lazy chunks (lazy-chunk.ts; web-ui.md › The app's bundles) ───────────────
// A screen whose module is its own chunk draws its skeleton until the chunk is in. `withChunk` starts
// (or joins) the load and, once it lands, runs what was waiting for it — a controller's first read,
// an act — and repaints, all in ONE paint (`batchRender`). A paint that needs a chunk calls it with no
// `fn`; a chunk that failed is then not retried in a loop (its screen says to reload), but an act asked
// for again tries again.
const chunkWaiters = new Map<LazyChunk<unknown>, ((m: unknown) => void)[]>();
function withChunk<M>(chunk: LazyChunk<M>, fn?: (m: M) => void): void {
  const ready = chunk.get();
  if (ready) { fn?.(ready); return; }
  if (chunk.failed() && !fn) return;
  const key = chunk as LazyChunk<unknown>;
  const waiting = chunkWaiters.get(key);
  if (waiting) { if (fn) waiting.push(fn as (m: unknown) => void); return; }
  chunkWaiters.set(key, fn ? [fn as (m: unknown) => void] : []);
  chunk.load().then(
    (m) => {
      const fns = chunkWaiters.get(key) ?? [];
      chunkWaiters.delete(key);
      batchRender(() => { for (const f of fns) f(m); rerenderSoon(); });
    },
    () => { chunkWaiters.delete(key); rerenderSoon(); },
  );
}

let releasesWanted = false;
function wantReleases(): void {
  if (releasesWanted) return;
  releasesWanted = true;
  loadReleases().catch(() => undefined).finally(() => { releasesWanted = false; rerenderSoon(); });
}

/** The paint itself — reached only through the paint queue (`rerender`, `rerenderSoon`, `batchRender`). */
function paintApp(): void {
  // A drag (the board's cards, the docs pane's pages — pointer-drag.ts) holds the DOM: swapping <main> would drop the
  // row mid-drag. The held paint runs when the drag ends.
  if (dragging()) { rerenderHeld = true; return; }
  // Repo › Summary exists only while the live read carries Trov's state (repo.ts `repoSummaryShown`, in the lazy Repo
  // chunk — until it is in, the screen is its skeleton and the chunk's arrival paints again): a read that lands
  // without it (AI off, nothing written, a failed read), sample data, or the end of its "Wrong?" exit moves the
  // screen — and the address — to the Overview, which flashes in like a tab switch.
  const repoMod = repoChunk.get();
  if (repoMod && state.view === "app" && state.screen === "repo" && state.repoTab === "summary" && !repoMod.repoSummaryShown(repoProps(state))) {
    state.repoTab = "overview";
    if (state.repo.data) pendingFlash = ".repo-panel > :not(.repo-poll-strip)";
  }
  // Help › What's new renders from its own chunk (releases-lazy.ts): a paint on the screen without
  // it draws the skeleton and starts the load, and its arrival paints again.
  if (state.view === "app" && state.screen === "releases" && !releasesLoaded() && !releasesFailed()) wantReleases();
  // The landing is its own chunk in the app (the signed-out page `/` boots it alone, landing-page.ts):
  // a signed-out paint, or the landing reopened by the sidebar logo, starts the load.
  if (state.view === "auth" ? state.authStep === "login" : state.view === "app" && state.screen === "site") withChunk(landingChunk);
  // Org settings is its own chunk: painting it without it starts the load.
  if (state.view === "app" && state.screen === "org") withChunk(orgChunk);
  // The Repo screen is its own chunk: painting it without it starts the load.
  if (state.view === "app" && state.screen === "repo") withChunk(repoChunk);
  // Artifacts' screens are their own chunk: painting one without it starts the load.
  if (state.view === "app" && (state.screen === "artifacts" || state.screen === "artifactnew" || state.screen === "artifact")) withChunk(artifactsChunk);
  // Platform's screens are their own chunk: painting one without it starts the load.
  if ((state.view === "platform" || state.view === "app") && (state.screen === "platform" || state.screen === "platformorg")) withChunk(platformChunk);
  // Signed in: the Markdown chunk starts loading beside the first reads (once).
  if (state.view === "app" || state.view === "platform") prefetchMarkdownLib();
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
  syncCtl.beforePaint(); // the Sync panel closes with the control it hangs from
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
  // A focused button (not a field) is put back on its twin after the swap (focus-twin.ts), on the same screen only.
  const focusAct = !field && active && mount.contains(active) ? active.getAttribute?.("data-act") ?? null : null;
  const twin = focusAct ? twinSelector({ act: focusAct, arg: active?.getAttribute?.("data-arg") ?? null }) : null;
  const screenBefore = mount.firstElementChild?.getAttribute("data-screen") ?? null;
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
  // Review: a verdict button that had focus hands it to the same button of the item that follows.
  const rvFocus = active?.closest?.(".cnpy-rv-head, .cnpy-rvp-foot") ? active.getAttribute("data-act") : null;
  askCtl.beforePaint();   // Ask's scrollers: a paint's measuring layout must not move them (ask-motion.ts askKeepScroll)
  aiFilterCtl.sync();     // a typed filter's line goes once its filters were changed by hand (ai-filter-actions.ts)
  paint(mount, render(state));
  syncReviewDetail(rvFocus);
  syncSegments(mount);
  syncTabBars(mount);
  qs.sync();   // the search dropdown lives outside the mount: re-anchor and re-theme it
  // The tab icon follows the app's resolved theme (a no-op until it changes).
  syncFavicon(resolvedTheme(), mount.querySelector("[data-cnpy-theme]"));
  // The page behind the app (an overscroll, the instant before a paint) in the app's theme: the build's
  // theme boot set it for the first paint (site-prerender.ts), and a theme change must not leave it behind.
  syncPageBackground(document.documentElement, resolvedTheme());
  restoreScroll(mount, scroll, state.screen);
  markEnter();
  // Loading skeletons: keep each region's clock across this swap, and fade in what replaced one.
  syncSkeletons(mount, state.view === "app" ? pageKey(currentRoute()) : state.view);
  orgCtl.afterPaint();
  dropdowns.afterPaint();
  welcomeCtl.afterPaint();
  syncCtl.afterPaint();
  askCtl.afterPaint();
  if (pendingFlash) {
    for (const el of Array.from(mount.querySelectorAll(pendingFlash))) el.classList.add("cnpy-flash");
    pendingFlash = null;
  }
  const onLanding = state.view === "auth" ? state.authStep === "login" : state.screen === "site";
  if (onLanding && landingChunk.get()) mountLandingMotion(mount, state.landingSeen);
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
  restoreTwinFocus(twin, screenBefore);
  updateActiveHeading();
  scrollActiveRow();
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
  if (sameRoute(r, cur)) {
    // Already there — but an old spelling of it (`#maintenance/people` while on Org settings ›
    // Members) should not stay in the address bar.
    const want = hashForRoute(cur);
    if (location.hash !== want) history.replaceState(null, "", want);
    return;
  }
  applyRoute(r);
  // Back / Forward between two tabs of Org settings: the page is already loaded, so the tab's
  // body swaps in place — exactly what clicking the tab does. (Every other screen's loader is
  // already a no-op once its data is in; Platform's reads only what the tab has not got yet.)
  if (r.screen === "org" && cur.screen === "org") { orgCtl.act("orgTab", r.orgTab ?? "integrations", "route"); return; }
  // Back / Forward between two steps of the guided setup: its reads are already in.
  if (r.screen === "welcome" && cur.screen === "welcome") { welcomeCtl.moved(); return; }
  // Back / Forward between Review's two views: the columns swap in place (one page), and flash in as the switch does.
  if (r.screen === "review" && cur.screen === "review") pendingFlash = REVIEW_VIEW_FLASH;
  // Back from a thread to the bare `#ask`: a new thread, as the header's "Trov" does.
  if (r.screen === "ask" && cur.screen === "ask" && !r.askThread) { askCtl.act("askShNew", null, null); return; }
  loadForScreen(r.screen);
});

/** After a repaint: when a focused button's page was swapped away and nothing else took focus, focus its twin (the
 *  same act + arg) on the SAME screen — never one on another screen, never over a dialog or menu that moved focus. */
function restoreTwinFocus(twin: string | null, screenBefore: string | null): void {
  if (!twin || mount.firstElementChild?.getAttribute("data-screen") !== screenBefore) return;
  const now = document.activeElement;
  if (now && now !== document.body && now.isConnected) return;
  mount.querySelector<HTMLElement>(twin)?.focus({ preventScroll: true });
}

// Minimal CSS.escape shim for id selectors (heading ids are already slug-safe).
function cssEscape(v: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&");
}

// ── the doc page's scroll-spy: the rail's On this page entry for the section in view ──
// The current heading is the last one whose top is within 120px of the top of the page's scroller (`#cnpy-libmain`);
// at the bottom the last one is current. Direct DOM (no repaint), so it stays cheap while scrolling.
/** The least a doc page must scroll for On this page to mark the section in view (CSS px of scroll range). */
const SPY_MIN_SCROLL = 160;
function updateActiveHeading(): void {
  if (state.screen !== "docs") return;
  const pane = mount.querySelector<HTMLElement>("#cnpy-libmain");
  const items = pane ? [...pane.querySelectorAll<HTMLElement>(".cnpy-toc-i[data-toc]")] : [];
  if (!pane || !items.length) return;
  const ids = new Set(items.map((b) => b.dataset.toc as string));
  const heads = [...pane.querySelectorAll<HTMLElement>(".cnpy-md h2[id], .cnpy-md h3[id], .cnpy-dpg-kh[id]")].filter((h) => ids.has(h.id));
  // Too short to follow: with fewer than two headings, or a page that scrolls less than SPY_MIN_SCROLL px, every
  // heading is already in view and the "current" one would only jump to the last — so nothing is marked.
  if (heads.length < 2 || pane.scrollHeight - pane.clientHeight < SPY_MIN_SCROLL) {
    for (const b of items) b.classList.remove("is-current");
    return;
  }
  const top = rectOf(pane).top;
  let active = heads[0].id;
  for (const h of heads) {
    if (rectOf(h).top - top <= 120) active = h.id;
    else break;
  }
  if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4) active = heads[heads.length - 1].id;
  for (const b of items) b.classList.toggle("is-current", b.dataset.toc === active);
}

// The docs pane keeps the page being read in view: when its row is out of the pane's view, the pane scrolls it to
// about 45% of its height (once per page opened, so a person scrolling the pane is never pulled back).
let paneScrolledFor: string | null = null;
function scrollActiveRow(): void {
  if (state.screen !== "docs" || !state.docSlug || paneScrolledFor === state.docSlug) return;
  const pane = mount.querySelector<HTMLElement>(".cnpy-dpane");
  const row = pane?.querySelector<HTMLElement>(".cnpy-dp-row.is-active");
  if (!pane || !row) return;
  paneScrolledFor = state.docSlug;
  const p = pane.getBoundingClientRect(), r = row.getBoundingClientRect();
  if (r.top >= p.top && r.bottom <= p.bottom) return;
  pane.scrollTop += r.top - p.top - p.height * 0.45;
}

// Get Started's table of contents: the same spy over the guide's headings. The
// current row is the last anchor at or above the top of #cnpy-main; a sub-row also
// lights its section. Direct DOM, like the docs spy.
function updateGuideToc(): void {
  if (state.screen !== "guide") return;
  const pane = document.getElementById("cnpy-main");
  const heads = [...mount.querySelectorAll<HTMLElement>(".cnpy-guide-anchor[id]")];
  if (!pane || !heads.length) return;
  const top = rectOf(pane).top;
  let active = heads[0].id;
  for (const h of heads) {
    if (rectOf(h).top - top <= 96) active = h.id;
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
  if (state.screen === "repo") {
    r.repoTab = state.repoTab;
    if (state.repoSlug) r.repoSlug = state.repoSlug;
    if (state.repoApp) r.repoApp = state.repoApp;
  }
  if (state.screen === "roadmap") r.roadmapTab = state.roadmapTab;
  if (state.screen === "review" && state.reviewView === "unplaced") r.reviewView = "unplaced";
  if (state.screen === "releases" && state.releaseVersion) { r.releaseVersion = state.releaseVersion; r.releasePage = state.releasePage; }
  if (state.screen === "artifact") r.art = state.artRoute;
  if (state.screen === "handoff" && state.handoffId) r.handoffId = state.handoffId;
  if (state.screen === "link" && state.linkId) r.linkId = state.linkId;
  if (state.screen === "prompt" && state.promptSlug) r.promptSlug = state.promptSlug;
  if (state.screen === "promptedit") {
    r.promptMode = state.promptMode;
    if (state.promptMode !== "new" && state.promptSlug) r.promptSlug = state.promptSlug;
  }
  if (state.screen === "platform") {
    r.platTab = state.plat.tab;
    if (state.plat.tab === "support" && state.plat.support.reportId !== null) r.platReport = state.plat.support.reportId;
  }
  if (state.screen === "platformorg" && state.plat.orgSlug) r.platOrg = state.plat.orgSlug;
  if (state.screen === "org") {
    r.orgTab = state.org.tab;
    if (state.org.tab === "repos" && state.org.repoPage) r.orgRepo = state.org.repoPage;
  }
  if (state.screen === "tag" && state.tagName) r.tagName = state.tagName;
  if (state.screen === "space" && state.spaceSlug) r.spaceSlug = state.spaceSlug;
  if (state.screen === "docs" && state.docSlug) r.docSlug = state.docSlug;
  if (state.screen === "import" && state.imp.space) r.importSpace = state.imp.space;
  if (state.screen === "ask" && state.ask.page.threadId !== null) r.askThread = state.ask.page.threadId;
  // The step ON SCREEN: a member who opens `#welcome` (the admin's first step) is on their own first.
  if (state.screen === "welcome") r.welcomeStep = effectiveWelcomeStep(state.welcome.step, welcomeStepsFor(currentOrg(state)?.role, state.org));
  return r;
}
function applyRoute(r: Route): void {
  if (r.ticketId !== state.ticketId) { state.tdDeleteArm = false; state.tdDeleteBusy = false; }   // a confirm never carries to another ticket
  state.screen = r.screen;
  state.ticketId = r.ticketId;
  state.sprintId = r.sprintId;
  if (r.repoTab) state.repoTab = r.repoTab;
  if (r.screen === "repo") {
    // The address scopes the Repo screen: another repository, or the App menu. A live read asks the Worker
    // again for a new scope (the sample narrows its facts at render time, so only a new repository reloads it).
    const slug = r.repoSlug ?? null, app = r.repoApp ?? null;
    const moved = slug !== state.repoSlug || (app !== state.repoApp && !state.repoSample);
    if (slug !== state.repoSlug) state.repoGroup = null;
    state.repoSlug = slug; state.repoApp = app;
    if (moved && state.repo.status !== "idle") state.repo = { status: "idle", data: state.repo.data };
  }
  if (r.roadmapTab) state.roadmapTab = r.roadmapTab;
  if (r.screen === "review") state.reviewView = r.reviewView ?? "queue";
  if (r.screen === "releases") {
    // What's new keeps one screen for the grid and every release page, so moving between
    // them (a card, Back, the newer/older links) starts the new page at its top.
    const v = r.releaseVersion ?? null, page = r.releasePage ?? "notes";
    if (v !== state.releaseVersion || page !== state.releasePage) document.getElementById("cnpy-main")?.scrollTo(0, 0);
    state.releaseVersion = v; state.releasePage = page;
  }
  state.artRoute = r.art ?? ART_ROUTE_NONE;
  state.repoAttentionOpen = false;   // Needs attention's dialog never outlives a route change
  state.rmTrovOpen = false;          // nor does the Roadmap's Trov dialog
  // A route change closes the artifact viewer's menus and dialogs (the design's onHash).
  state.art.verMenu = false; state.art.dotMenu = false; state.art.ratifyOpen = false; state.art.attachOpen = false;
  if (!state.art.deleteBusy) state.art.deleteArm = false;
  if (r.handoffId) state.handoffId = r.handoffId;
  // A link's confirm never carries to another link.
  if (r.linkId !== state.linkId) { state.linkCancelArm = false; state.linkCancelBusy = false; }
  if (r.linkId) state.linkId = r.linkId;
  if (r.promptSlug) state.promptSlug = r.promptSlug;
  if (r.promptMode) state.promptMode = r.promptMode;
  if (r.platTab) state.plat.tab = r.platTab;
  // Platform › Support: the report in the address (`#platform/support/<id>`), or the list.
  if (r.screen === "platform") state.plat.support.reportId = r.platTab === "support" ? r.platReport ?? null : null;
  if (r.platOrg) state.plat.orgSlug = r.platOrg;
  if (r.orgTab) state.org.tab = r.orgTab;
  // Org settings › Repositories: one repository's Apps page, or the list.
  if (r.screen === "org") state.org.repoPage = r.orgRepo ?? null;
  if (r.tagName) state.tagName = r.tagName;
  // The Library: another space starts on its Overview; another doc is read again (loadForScreen).
  if (r.screen === "space" && r.spaceSlug) {
    if (r.spaceSlug !== state.spaceSlug) { state.spaceTab = "overview"; state.libUi.desc = null; }
    state.spaceSlug = r.spaceSlug;
  }
  if (r.screen === "docs" && r.docSlug && r.docSlug !== state.docSlug) { state.docSlug = r.docSlug; state.showHistory = false; state.treeMenu = null; state.docDetail = { status: "idle", data: null }; }
  if (r.screen === "ask") askRoute = r.askThread ?? null;
  if (r.screen === "import") importRoute = r.importSpace ?? null;
  if (r.welcomeStep) { state.welcome.step = r.welcomeStep; state.welcome.byHand = false; }
}

/** The thread `#ask/<id>` named on arrival (applyRoute), handed to the Ask controller by loadForScreen. */
let askRoute: number | null = null;
/** The space `#import/<space>` named on arrival, handed to the import controller by loadForScreen. */
let importRoute: string | null = null;

// Kick off the data load for a screen (mirrors the go* dispatch cases). Batched: a screen that
// starts several reads (My Work starts eight) paints once, before this returns — not once per read.
function loadForScreen(screen: Screen): void {
  batchRender(() => startScreenLoads(screen));
}
function startScreenLoads(screen: Screen): void {
  switch (screen) {
    case "feed": loadFeedIfNeeded(); loadFeedStats(); loadFeedReview(); break;
    case "docs":
      if (state.docSlug && (state.docDetail.status === "idle" || state.docDetail.data?.doc.slug !== state.docSlug)) loadDoc(state.docSlug);
      else rerender();
      break;
    case "library": libCtl.load(); rerender(); break;
    case "space": libCtl.openSpace(state.spaceSlug); break;
    case "roadmap": loadRoadmapIfNeeded(); loadRoadmapFeed(); break;
    // Review reads both its views' queues, so the header's To review / Unplaced switch is one paint with nothing to load.
    case "review": loadProposalsIfNeeded(); loadDraftAdrsIfNeeded(); loadNeedsTriageIfNeeded(); break;
    case "relay": loadRelay(); break;
    case "handoffs": loadHandoffs(); break;
    case "handoff": if (state.handoffId) openHandoff(state.handoffId); else rerender(); break;
    case "newhandoff": state.nh = blankHandoff(primaryRepoName()); loadPersons(); break;
    case "links": loadLinks(); break;
    case "link": if (state.linkId) openLinkPage(state.linkId); else rerender(); break;
    case "prompts": loadPrompts(); break;
    case "prompt": if (state.promptSlug) openPrompt(state.promptSlug); else rerender(); break;
    case "promptedit": openEditor(state.promptMode, state.promptSlug); break;
    case "import": impCtl.enter(importRoute ?? state.imp.space); importRoute = null; break;
    case "imports": impCtl.loadHistory(); break;
    case "newdoc": ndCtl.start(liveSpaces(state).some((x) => x.slug === state.nd.space) ? state.nd.space : defaultSpaceSlug(), null); break;
    case "tag": if (state.tagName) tagsCtl.open(state.tagName); else rerender(); break;
    case "search": loadSearchIfNeeded(); break;
    case "home": loadHomeIfNeeded(); break;
    case "mywork": loadMyWorkIfNeeded(); break;
    case "repo": loadRepoIfNeeded(); break;
    case "artifacts": case "artifactnew": case "artifact": loadArtifactsIfNeeded(); break;
    case "settings": loadSettingsReads(); break;
    // Platform has one home, `/platform/` (the org menu links there): an old in-app `#platform…` link goes to it.
    case "platform": case "platformorg":
      if (state.view === "app") { location.replace(`${PLATFORM_PATH}${hashForRoute(currentRoute())}`); break; }
      platform.load(); break;
    case "org": loadOrgAdminExtras(); orgCtl.load(); break;
    case "welcome": welcomeCtl.enter(); break;
    case "ask": askCtl.enter(askRoute); askRoute = null; break;
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
    .then((data) => { state.handoffs = { status: "ok", data }; listed("handoffs", handoffsForMe(data, state.me?.handle ?? "").length); rerenderSoon(); })
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
    .then((h) => { if (state.handoffId !== id) return; state.handoffDetail = { status: "ok", data: h }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (state.handoffId !== id) return;
      const missing = e instanceof ApiError && e.status === 404;
      state.handoffDetail = { status: missing ? "ok" : "error", data: null, error: String(e) };
      rerenderSoon();
    });
}
// ── Relay › Links ─────────────────────────────────────────────────────────
/** The Links tab's four boxes, read together. Waiting-for-me is the sidebar's half of the Relay badge
 *  (`listed("links")`) — never folded into `handoffsForMe`, which My Work counts. */
function loadLinks(): void {
  state.links = { status: "loading", data: state.links.data };
  rerender();
  Promise.all([listLinks("waiting"), listLinks("open"), listLinks("mine"), listLinks("closed")])
    .then(([waiting, open, mine, closed]) => {
      state.links = { status: "ok", data: { waiting, open, mine, closed } };
      listed("links", waiting.length);
      rerenderSoon();
    })
    .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } state.links = { status: "error", data: state.links.data, error: String(e) }; rerender(); });
}
function openLinkPage(id: number): void {
  if (state.linkId !== id) { state.linkCancelArm = false; state.linkCancelBusy = false; state.linkNoteSide = "requester"; }
  state.linkId = id;
  state.linkBusy = false;
  // Keep what the tab already holds on screen (no notes yet) while the fresh read lands.
  const b = state.links.data;
  const known = state.linkDetail.data?.id === id ? state.linkDetail.data
    : [...b.waiting, ...b.open, ...b.mine, ...b.closed].find((l) => l.id === id) ?? null;
  state.linkDetail = { status: "loading", data: known ? { notes: [], ...known } : null };
  rerender();
  getLink(id)
    .then((l) => { if (state.linkId !== id) return; state.linkDetail = { status: "ok", data: l }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (state.linkId !== id) return;
      const missing = e instanceof ApiError && e.status === 404;
      state.linkDetail = { status: missing ? "ok" : "error", data: null, error: String(e) };
      rerenderSoon();
    });
}
/** A link refusal in words: the route's own sentence when it sent one (`{ error, message }`), else the fallback. */
function linkErr(e: unknown, fallback: string): void {
  if (e instanceof Unauthorized) { unauth(e); return; }
  const detail = e instanceof ApiError ? e.detail : null;
  flash(detail ? `${fallback}: ${detail}` : fallback, 4000);
}
/** A person step on the link's page: run it, show the link as it now stands, refresh the tab (and its badge). */
function runLinkStep(id: number, step: "send" | "accept" | "decline" | "cancel" | "close", done: (l: LinkView) => string, fallback: string): void {
  if (state.linkBusy) return;
  state.linkBusy = true;
  rerender();
  (step === "close" ? closeLinkWeb(id) : linkStep(id, step))
    .then((l) => {
      state.linkBusy = false;
      state.linkCancelArm = false; state.linkCancelBusy = false;
      if (state.linkId === id) state.linkDetail = { status: "ok", data: { ...l, notes: state.linkDetail.data?.notes ?? [] } };
      loadLinks();
      if (state.linkId === id) openLinkPage(id);
      flash(done(l));
    })
    .catch((e) => {
      state.linkBusy = false;
      state.linkCancelArm = false; state.linkCancelBusy = false;
      linkErr(e, fallback);
      // A refusal usually means the link moved elsewhere (cancelled, accepted, expired): re-read the page AND the
      // tab, so the boxes and the sidebar badge stop counting a request that is no longer waiting (E2E B-08).
      if (!(e instanceof Unauthorized)) loadLinks();
      if (state.linkId === id) openLinkPage(id);
    });
}
function loadPrompts(): void {
  state.promptList = { status: "loading", data: state.promptList.data };
  rerender();
  listPrompts()
    .then((data) => { state.promptList = { status: "ok", data }; listed("prompts", stagedPrompts(data)); rerenderSoon(); })
    .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } state.promptList = { status: "error", data: state.promptList.data, error: String(e) }; rerender(); });
}
function openPrompt(slug: string): void {
  state.promptSlug = slug;
  state.promptDiffV = null; state.promptTagMenu = false; state.promptTagDraft = ""; state.promptExpanded = false;
  state.promptDeleteArm = false; state.promptDeleteBusy = false;
  if (state.promptList.status === "idle") loadPrompts(); // the tag picker suggests the library's tags
  const same = state.promptDetail.data?.prompt.slug === slug;
  state.promptDetail = { status: "loading", data: same ? state.promptDetail.data : null };
  rerender();
  Promise.all([getPrompt(slug), getPromptVersions(slug)])
    .then(([prompt, versions]) => { if (state.promptSlug !== slug) return; state.promptDetail = { status: "ok", data: { prompt, versions } }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (state.promptSlug !== slug) return;
      const missing = e instanceof ApiError && e.status === 404;
      state.promptDetail = { status: missing ? "ok" : "error", data: null, error: String(e) };
      rerenderSoon();
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
    .then((p) => { if (state.screen !== "promptedit" || state.promptSlug !== slug) return; state.promptEd = draftFromPrompt(p, mode); rerenderSoon(); })
    .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } flash("Couldn't load that prompt"); state.screen = "prompts"; loadPrompts(); });
}
/** Where a new page goes when nothing says: the default space while it is live, else the Library's first. */
/** The space the docs pane shows when it is a live one (New page from a doc page goes there), else `fallback`. */
function paneSpaceOr(fallback: string): string {
  const slug = state.screen === "space" ? state.spaceSlug : state.screen === "docs" ? state.docDetail.data?.doc.space ?? state.docSpace : null;
  return slug && liveSpaces(state).some((x) => x.slug === slug) ? slug : fallback;
}
function defaultSpaceSlug(): string {
  const live = liveSpaces(state);
  return live.length === 0 || live.some((s) => s.slug === DEFAULT_SPACE) ? DEFAULT_SPACE : live[0].slug;
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
      else rerenderSoon();
      return data;
    })
    .catch((e): null => {
      if (e instanceof Unauthorized) { unauth(e); return null; }
      state.myOrgs = { status: "error", data: state.myOrgs.data, error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
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
      rerenderSoon();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (state.orgSlug !== slug) return;
      if (e instanceof ApiError && e.status === 404) { showPicker(slug); return; }
      state.orgMe = { status: "error", data: state.orgMe.data, error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
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
/** One first-run card giving way to the picker (transition.ts). The picker's list is read FIRST: morphing
 *  into a picker that is still loading lands on its short "Loading…" card, which then snaps to full height
 *  when the list arrives — the card is squeezed and then stretched. Loaded first, it morphs once, to its
 *  real size. (`loadMyOrgs` never rejects; on an error the picker says so itself.) */
function morphToPicker(before?: () => void): Promise<void> {
  return loadMyOrgs().then(() => { morphStep(() => { before?.(); showPicker(null); }); });
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
  if (!isPlatformPath(location.pathname)) history.replaceState(null, "", withPreview(`${PLATFORM_PATH}${hashForRoute(currentRoute())}`, state.preview));
  platform.load();
}

/** Open an org: every request from here on is its (`/api/o/<slug>/…`), the address bar says
 *  `/<slug>/` with the hash route after it, and this browser remembers it as last used. */
/** This page has entered an org (so it holds that org's data): a second one is opened by a page load. */
let enteredAnOrg = false;
/** Batched: the boot starts a dozen and a half reads here, and their "loading" paints are ONE paint,
 *  made before this returns (each read's landing is a `rerenderSoon`). */
function enterOrg(slug: string, hash: string): void {
  batchRender(() => enterOrgNow(slug, hash));
}
function enterOrgNow(slug: string, hash: string): void {
  enteredAnOrg = true;
  const query = new URLSearchParams(location.search);
  const link = query.get("link");
  // The return from GitHub after connecting the App (src/github-app/connect.ts): `/<slug>/?github=<outcome>#org/repos`.
  // Read once, here — the address bar is rewritten below, so a reload does not say it again.
  const github = query.get("github");
  if (isGithubConnectOutcome(github)) {
    state.org.githubNotice = { outcome: github, accounts: (query.get("accounts") ?? "").split(",").filter((a) => GITHUB_LOGIN_RE.test(a)).slice(0, 10) };
  }
  // The return from a hosting provider after Connect with Vercel / Netlify (src/hosting/connections.ts):
  // `/<slug>/?hosting=<outcome>&provider=<id>#org/hosting`, or `/?hosting=<outcome>` when the intent could
  // not be read (then the org this page lands in is where it says so). Read once, like `?github=`; the
  // notice belongs to Org settings › Hosting, so that is where the page opens.
  const hostingOutcome = query.get("hosting");
  const hostingReturn = isHostingConnectOutcome(hostingOutcome);
  if (hostingReturn) {
    const provider = query.get("provider");
    state.org.hosting.notice = { outcome: hostingOutcome, provider: isHostingProvider(provider) ? provider : null };
    hash = "#org/hosting";
  }
  // A return the guided setup itself sent away — to link a GitHub account, or to connect the GitHub
  // App — comes back to the setup, not to the screen the server names (welcome-actions.ts). Once.
  try {
    const note = parseWelcomeReturn(sessionStorage.getItem(WELCOME_RETURN_KEY));
    if (note) {
      sessionStorage.removeItem(WELCOME_RETURN_KEY);
      hash = welcomeReturnHash(note, { slug, hash, github: isGithubConnectOutcome(github), now: Date.now() }) ?? hash;
    }
  } catch { /* no storage: land where the URL says */ }
  state.orgSlug = slug;
  setApiOrg(slug);
  try { localStorage.setItem(LAST_ORG_KEY, slug); } catch { /* ignore */ }
  const want = withPreview(orgHref(slug, hash), state.preview);
  if (`${location.pathname}${location.search}${location.hash}` !== want) history.replaceState(null, "", want);
  state.view = "app";
  // Restore the route from the URL hash (reload stays put, including
  // #tickets/<id> and #sprints/<id>) instead of always My Work.
  applyRoute(parseHash(hash));
  // Hosting is an admin's tab: anyone else is told here, once, instead of on a tab they cannot open.
  if (hostingReturn && !roleAtLeast(currentOrg(state)?.role, "admin")) {
    state.org.hosting.notice = null;
    flash("Nothing was connected: only an admin or an owner of this organization can connect a host.", 7000);
  }
  loadOrgMe();
  // No `GET /api/orgs` here: /auth/me already brought my orgs, my role in each and the invites count —
  // all the rail and the switcher show. The full list (plans, grants, invites) is read where it is
  // used: the switcher's menu, the picker, Settings and a connection's scope dialog.
  syncCtl.load(); // a sync in progress shows in the header on every screen, also after a reload
  loadForScreen(state.screen);
  // A conflicting Link redirect lands here directly (full page load to
  // /?link=conflict#settings), not through the goSettings dispatch case.
  checkLinkConflict(link);
  // The sidebar's badges show on every screen: ONE read of their counts (Review, Unplaced, Tickets,
  // Handoffs, Prompts, and the admin's unmatched logins), not the seven lists they count. A screen
  // that needs a list (My Work, Review, …) loads it itself, and its count then replaces the badge's.
  loadBadges();
  // The persons directory backs every colored chip (sidebar, feed, docs,
  // Settings › Profile, Org settings › Members) — load it on every screen too.
  loadPersons();
  // The org's tag list backs the Feed's filter, the Unplaced picker, a doc's Tags row and Org settings › Tags.
  tagsCtl.load();
  // The Library's spaces back the sidebar's Library group on every screen (and the space pickers).
  if (state.library.status === "idle") libCtl.load();
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
  getFeedPage({ author, tags })
    .then(({ feed: rows, aiOff }) => {
      state.feed = { status: "ok", data: rows };
      state.ai.feedAiOff = aiOff;
      // Capture the author chip set only from the unfiltered view, so filtering doesn't shrink it.
      if (!author && !tags) state.feedAuthors = [...new Set(rows.map((r) => r.author))];
      rerenderSoon();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.feed = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
    });
}
function loadFeedIfNeeded(): void {
  aiFilterCtl.ensure(); // the plain-language filter's switch, once per org (no model)
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
      rerenderSoon();
    })
    .catch((e) => {
      if (seq !== feedStatsSeq) return;
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.feedStats = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
    });
}

function loadMyWork(): void {
  state.mywork = { status: "loading", data: state.mywork.data };
  rerender();
  getMyDashboard()
    .then((data) => {
      state.mywork = { status: "ok", data };
      rerenderSoon();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.mywork = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
    });
}
/** Your sessions: MY two latest feed entries, and the session digests Trov wrote about me (Q30) — My Work's own
 *  read, so the Feed screen's author/tag filters (which shape `state.feed`) never reach it. */
function loadMwSessions(): void {
  const me = state.me?.handle;
  if (!me) return;
  state.mwSessions = { status: "loading", data: state.mwSessions.data };
  getFeed({ author: me, about: true, limit: 2 })
    .then((rows) => { state.mwSessions = { status: "ok", data: rows }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      state.mwSessions = { status: "error", data: state.mwSessions.data, error: String(e) };
      rerenderSoon();
    });
}
/** Docs you own: the doc list WITHOUT bodies — never `loadDocs`, which also opens
 *  the Docs screen's first doc (its body + every version) and picks `docSlug`. */
function loadMwDocs(): void {
  state.mwDocs = { status: "loading", data: state.mwDocs.data };
  listDocMeta()
    .then((rows) => { state.mwDocs = { status: "ok", data: rows }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      state.mwDocs = { status: "error", data: state.mwDocs.data, error: String(e) };
      rerenderSoon();
    });
}

// ── Home (home.ts / home-view.ts) ────────────────────────────────────────────
// Home reads its own two (`GET /home`, the newest Feed entries) and the slices My Work already reads — each only when
// idle, so a screen already visited costs nothing.
function loadHomeData(): void {
  state.home.data = { status: "loading", data: state.home.data.data };
  getHome()
    .then((d) => { state.home.data = { status: "ok", data: d }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      state.home.data = { status: "error", data: state.home.data.data, error: String(e) };
      rerenderSoon();
    });
}
function loadHomeFeed(): void {
  state.home.feed = { status: "loading", data: state.home.feed.data };
  getFeed({ limit: 5 })
    .then((rows) => { state.home.feed = { status: "ok", data: rows }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      state.home.feed = { status: "error", data: state.home.feed.data, error: String(e) };
      rerenderSoon();
    });
}
function loadHomeGithub(): void {
  if (!state.orgSlug) return;
  state.home.github = { status: "loading", data: state.home.github.data };
  getOrgGithub(state.orgSlug)
    .then((g) => { state.home.github = { status: "ok", data: g }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      state.home.github = { status: "error", data: state.home.github.data, error: String(e) };
      rerenderSoon();
    });
}
/** Every read Home is built on, again: on each visit, and every HOME_REFRESH_MS while it is on screen (all D1 —
 *  nothing here reaches GitHub). Each loader keeps what it had on screen while it reads, so nothing blanks. */
const HOME_REFRESH_MS = 60_000;
let homeReadAt = 0;
function refreshHome(): void {
  homeReadAt = Date.now();
  loadHomeData(); loadHomeFeed(); loadHomeGithub();
  loadMyWork(); loadProposals(); loadDraftAdrs(); loadNeedsTriage();
  loadSprints(); loadHandoffs(); loadRepo(); loadBadges();
  if (state.relayAsk.status === "idle") loadRelayAsk();
}
function loadHomeIfNeeded(): void {
  refreshHome();
  rerender();
}
// While Home is on screen and the tab is visible: refresh quietly — not while the bar is in use (its dropdown would
// move under the keyboard), and at once when the tab comes back after a while away.
setInterval(() => {
  if (state.view !== "app" || state.screen !== "home" || document.visibilityState !== "visible" || state.home.focused) return;
  if (Date.now() - homeReadAt >= HOME_REFRESH_MS) refreshHome();
}, 10_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.view === "app" && state.screen === "home" && Date.now() - homeReadAt >= HOME_REFRESH_MS) refreshHome();
});
/** The bar's dropdown rows, in keyboard order (homePick runs one). */
let homeFlat: QuickRow[] = [];
let homeSearchT: ReturnType<typeof setTimeout> | undefined;
let homeAbort: AbortController | null = null;
function homeRows(): QuickRow[] { homeFlat = homeDropRows(state).flatMap((g) => g.rows); return homeFlat; }
/** Search as the person types: 120ms after a keystroke, the in-flight one aborted (quick search's own pace). */
function homeSearch(): void {
  clearTimeout(homeSearchT);
  homeAbort?.abort();
  const q = state.home.q.trim();
  if (state.home.mode !== "search" || q.length < 2) { state.home.results = null; return; }
  homeSearchT = setTimeout(() => {
    const ac = new AbortController(); homeAbort = ac;
    quickSearch(q, ac.signal, 6)
      .then((r) => { if (state.home.q.trim() !== q) return; state.home.results = r; state.home.active = 0; rerender(); })
      .catch(() => { /* aborted or failed: the dropdown keeps what it had */ });
  }, 120);
}
const homeAskOn = (): boolean => homeAskAvailable(state);
function homeFocusInput(): void {
  requestAnimationFrame(() => (mount.querySelector('[data-field="homeQ"]') as HTMLInputElement | null)?.focus());
}

/** My Work reads its own DTO plus the slices its tiles and rail are built on —
 *  each loaded only when idle, so a screen already visited costs nothing. */
function loadMyWorkIfNeeded(): void {
  syncCtl.load(); // "Last synced …", and a sync in progress
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
  // The sample carries the picked scenario's facts (unnarrowed: the App menu narrows them at render time, as
  // `narrowFacts` does on the server); the live read is scoped by the address's repository and app.
  const sc = state.repoScenario;
  const read = sample
    ? import("./repo-sample").then((m) => ({ ...m.repoSample(), facts: m.repoScenario(sc.key, sc.variant), ...m.repoScenarioUsage(sc.key, sc.variant), ...m.repoScenarioScopes(sc.key, sc.variant) }))
    : getRepoDashboard({ repo: state.repoSlug, app: state.repoApp });
  read
    .then((data) => {
      if (sample !== state.repoSample) return; // switched source mid-flight — the newer load wins
      state.repo = { status: "ok", data };
      state.repoFetchedAt = Date.now();
      rerenderSoon();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.repo = { status: "error", data: state.repo.data, error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
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
/** The sample switch moved (scenario or variant): swap the facts and the Usage tab's data (targets, extras, Product) in place —
 *  the other tabs keep the sample. */
function reloadSampleFacts(): void {
  const sc = state.repoScenario;
  void import("./repo-sample").then((m) => {
    if (!state.repoSample || state.repoScenario !== sc || !state.repo.data) return;
    state.repo = { status: "ok", data: { ...state.repo.data, facts: m.repoScenario(sc.key, sc.variant), ...m.repoScenarioUsage(sc.key, sc.variant), ...m.repoScenarioScopes(sc.key, sc.variant) } };
    pendingFlash = ".repo-panel > :not(.repo-poll-strip)";
    rerender();
  });
}
function loadRepoIfNeeded(): void {
  syncCtl.load(); // the header's "synced 12m ago by @…"
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
    .then((data) => { state.notifPrefs = { status: "ok", data }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.notifPrefs = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
    });
}
// Settings › MCP access › Connected apps. No rerender of its own on entry: every caller
// follows with loadNotifPrefsIfNeeded, which does.
function loadGrants(): void {
  state.grants = { status: "loading", data: state.grants.data };
  listOAuthGrants()
    .then((data) => { state.grants = { status: "ok", data }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.grants = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
    });
}
/** Everything personal Settings reads: my connections, my digest preferences, the plan of the org on
 *  screen (its Plan and Limits tiles) and my organizations again (each one's plan and my role in it). */
function loadSettingsReads(): void {
  loadGrantsIfNeeded();
  loadNotifPrefsIfNeeded();
  orgCtl.loadPlan();
  void loadMyOrgs();
  void deletionCtl.loadAccount(); // what Delete account would do, and anything in its way (deletion.ts)
  void trovPrefsCtl.load(); // Settings › Trov: my Ask instructions and default mode here (ask-settings.ts)
}
/** Why a change to a connection's scope was refused, in words (the route answers with a code). */
const GRANT_SCOPE_REFUSALS: Record<string, string> = {
  current_org: "That is the organization it is working in. Switch it to another one first.",
  last_org: "A connection needs at least one organization. Revoke it instead.",
  not_allowed: "Turn that organization on for this connection first.",
  not_manual: "This connection follows the repository. Change it to Manual to choose its organizations.",
  not_found: "That connection, or that organization, is no longer yours to change.",
};
/** The scope dialog's focusable controls, in order. */
const grantScopeItems = (dlg: HTMLElement): HTMLElement[] =>
  [...dlg.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((el) => el.offsetParent !== null);
/** Focus into the scope dialog: its first control that does something (the × is last in line). */
function focusGrantScope(): void {
  const dlg = mount.querySelector<HTMLElement>("#grant-scope");
  if (!dlg) return;
  (grantScopeItems(dlg).find((el) => el.dataset.act && el.dataset.act !== "grantScopeClose") ?? dlg).focus();
}
/** Close the scope dialog; focus goes back to the row's button that opened it. */
function closeGrantScope(): void {
  const id = state.grantScope;
  if (id === null) return;
  state.grantScope = null;
  state.grantScopeNote = null;
  rerender();
  mount.querySelector<HTMLElement>(`[data-grant-change="${id}"]`)?.focus();
}
/** Settings › MCP access: one change to a connection's scope, saved at once — the list (and so the open
 *  dialog) becomes the route's answer, and the dialog says saving / saved / why not. `org` is the
 *  organization the change was about: a refusal is shown on its row. */
function saveGrantScope(change: Promise<OAuthGrantSummary[]>, done: string, org?: string): void {
  // The control that was used, to give focus back once the dialog has been redrawn around it.
  const used = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("#grant-scope [data-act], #grant-scope [data-dd]");
  const again = used?.dataset.dd ? `[data-dd="${used.dataset.dd}"]` : org ? `[data-grant-allow="${org}"] button` : null;
  const refocus = (): void => {
    const dlg = mount.querySelector<HTMLElement>("#grant-scope");
    if (!dlg || dlg.contains(document.activeElement)) return;
    ((again ? dlg.querySelector<HTMLElement>(again) : null) ?? grantScopeItems(dlg)[0] ?? dlg).focus();
  };
  state.grantScopeNote = { kind: "saving", text: "Saving\u2026" };
  rerender();
  change
    .then((data) => { state.grants = { status: "ok", data }; state.grantScopeNote = { kind: "saved", text: done }; rerender(); refocus(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      // A plan refusal is the named organization's: say it as its owner is told it, when that is me.
      const role = org ? (state.myOrgs.data?.orgs ?? state.me?.orgs ?? []).find((o) => o.slug === org)?.role ?? null : null;
      const text = planLimitText(e, role) ?? (e instanceof ApiError ? GRANT_SCOPE_REFUSALS[e.message] : undefined) ?? "That could not be saved. Try again.";
      state.grantScopeNote = { kind: "error", text, ...(org ? { org } : {}) };
      rerender();
      refocus();
      loadGrants();
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
    .then((data) => { state.mcpTokens = { status: "ok", data }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      state.mcpTokens = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
    });
}
// Relay › Overview (relay.ts): both halves' lists for the cards' counts, and Your connections — the person's OAuth
// connections and access tokens (Settings › MCP access's reads) and Ask's on/off for the org.
function loadRelay(): void {
  loadHandoffs();
  loadLinks();
  loadGrants();
  loadMcpTokens();
  loadRelayAsk();
}
/** Ask's on/off for the org (`GET /ask/state`, slimmed): Relay's connections and Home's bar read it. */
function loadRelayAsk(): void {
  if (!state.orgSlug) return;
  state.relayAsk = { status: "loading", data: state.relayAsk.data };
  getAskState(state.orgSlug)
    .then((a) => { state.relayAsk = { status: "ok", data: { enabled: a.enabled, eligibility: a.eligibility } }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      state.relayAsk = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
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
    .then(({ kinds }) => { state.notifPolicy = { status: "ok", data: kinds }; rerenderSoon(); })
    .catch((e) => { unauth(e); state.notifPolicy = { status: "error", data: [], error: String(e) }; rerenderSoon(); });
  getNotificationSettings()
    .then((data) => { state.notifSettings = { status: "ok", data }; rerenderSoon(); })
    .catch((e) => { unauth(e); state.notifSettings = { status: "error", data: null, error: String(e) }; rerenderSoon(); });
  listNotificationOutbox()
    .then(({ rows }) => { state.notifOutbox = { status: "ok", data: rows }; rerenderSoon(); })
    .catch((e) => { unauth(e); state.notifOutbox = { status: "error", data: [], error: String(e) }; rerenderSoon(); });
}
/** What Org settings shows an ADMIN beyond the org controller's own reads: the e-mail digests
 *  (its Notifications tab) and the logins to match (Members). Both are no-ops once loaded, and
 *  entering the page reads them all, so no tab opens on "Loading…". */
function loadOrgAdminExtras(): void {
  if (!viewerIsAdmin(state)) return;
  if (state.notifPolicy.status === "idle" || state.notifPolicy.status === "error") loadNotifAdmin();
  if (state.identityTasks.status === "idle" || state.identityTasks.status === "error") loadIdentityTasks();
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
// The doc page (`#doc/<slug>`, doc-page.ts): its read (`GET /doc/:slug`, with its tree, links and rail) and its space's
// pages for the docs pane (`spaceHome`, read once per space — the Library controller's `ensureSpace`). The pane is
// patched in place across docs (render.ts `libraryFrame`), so no DOM is touched by hand here.
let docSeq = 0;
function loadDoc(slug: string): void {
  const seq = ++docSeq;
  const same = state.docDetail.data?.doc.slug === slug;
  state.docDetail = { status: "loading", data: same ? state.docDetail.data : null };
  // The pane shows the space the doc is expected in (the last doc's) while the doc's own read is out.
  if (!same && state.spaceHome.data === null) libCtl.ensureSpace(state.docSpace);
  rerender();
  getDoc(slug)
    .then((result) => {
      if (seq !== docSeq) return;
      state.docDetail = { status: "ok", data: result };
      state.docSpace = result.doc.space;
      libCtl.ensureSpace(result.doc.space);
      rerenderSoon();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== docSeq) return;
      if (e instanceof NotFound) { state.docDetail = { status: "ok", data: null }; rerenderSoon(); return; }
      state.docDetail = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
    });
}
/** Open a doc's page (from the pane, a card, a crumb, a backlink, or another screen). */
function openDocPage(slug: string): void {
  if (state.docSlug !== slug) state.showHistory = false;
  state.screen = "docs";
  state.docSlug = slug;
  state.treeMenu = null;
  state.docsTree = false;
  loadDoc(slug);
}

let searchDebounce: ReturnType<typeof setTimeout> | null = null;

const EMPTY_QUERY_RESULT = { primary: [], pointers: [], meta: { engine: "fts5" as const, total: 0 } };

function loadSearch(): void {
  state.searchResults = { status: "loading", data: state.searchResults.data };
  rerender();
  search(state.searchQuery)
    .then((result) => {
      state.searchResults = { status: "ok", data: result };
      rerenderSoon();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.searchResults = { status: "error", data: EMPTY_QUERY_RESULT, error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
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

/** Read the Roadmap; the promise settles once the read has landed in state (it never rejects). */
function loadRoadmap(): Promise<void> {
  state.roadmap = { status: "loading", data: state.roadmap.data };
  rerender();
  return getRoadmap()
    .then((planView) => {
      state.roadmap = { status: "ok", data: planView };
      rerenderSoon();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.roadmap = {
        status: "error",
        data: { narrative: "", version: 0, updated_at: null, updated_by: null, sprints: [] },
        error: e instanceof Error ? e.message : String(e),
      };
      rerenderSoon();
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
      rerenderSoon();
    })
    .catch((e) => {
      if (seq !== roadmapFeedSeq) return;
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.roadmapFeed = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
    });
}

// Write-completion handlers refetch the triage slices directly (not via
// IfNeeded), so two loads of the same slice can overlap; the seq guard lets
// only the newest in-flight request commit, so a slow earlier response can't
// overwrite fresher data.
let proposalsSeq = 0;
/** `after` runs when THIS read commits, before the paint (Review's verdicts settle there). */
function loadProposals(after?: () => void): void {
  const seq = ++proposalsSeq;
  state.proposals = { status: "loading", data: state.proposals.data };
  rerender();
  listStagedProposals()
    .then((rows) => { if (seq !== proposalsSeq) return; state.proposals = { status: "ok", data: rows }; listed("proposals", rows.length); noteGroupTotals(); after?.(); pruneReviewLeaving(); rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== proposalsSeq) return;
      state.proposals = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      after?.(); pruneReviewLeaving();
      rerenderSoon();
    });
}
/** The Feed's "Waiting on review" box lists Review's two reads — the boot no longer loads them
 *  (the sidebar counts come from GET /badges), so the Feed asks for them when they are not on hand. */
function loadFeedReview(): void {
  if (state.proposals.status === "idle") loadProposals();
  if (state.draftAdrs.status === "idle") loadDraftAdrs();
}
function loadProposalsIfNeeded(): void {
  if (state.proposals.status === "idle" || state.proposals.status === "error") loadProposals();
  else rerender();
}

let draftAdrsSeq = 0;
function loadDraftAdrs(after?: () => void): void {
  const seq = ++draftAdrsSeq;
  state.draftAdrs = { status: "loading", data: state.draftAdrs.data };
  rerender();
  listAdrs("draft")
    .then((rows) => { if (seq !== draftAdrsSeq) return; state.draftAdrs = { status: "ok", data: rows }; listed("decisions", rows.length); after?.(); pruneReviewLeaving(); rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== draftAdrsSeq) return;
      state.draftAdrs = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      after?.(); pruneReviewLeaving();
      rerenderSoon();
    });
}

// ── Review: a verdict's card leaves the list (web-ui.md › A row leaving a list) ──────────────
// The write is sent at once and the card is taken out optimistically: it wears its verdict, then
// collapses (trov.css `.cnpy-rv-row[data-verdict]`), the selection moves to the next card and the
// counts drop with it. Nothing here is a second source of truth — `state.reviewLeaving` only HIDES
// rows of the two reads; the refetch replaces the reads and the entry is dropped. A failed write
// deletes the entry, and the card, the counts and the selection are exactly what they were.
interface ReviewExit { kind: "doc" | "adr"; selBefore: string | null; selAfter: string | null; timer: ReturnType<typeof setTimeout> | null; ok: boolean }
const reviewExits = new Map<string, ReviewExit>();
/** A verdict landed for this kind: its list is refetched once no card is still leaving. */
const reviewRefetch = { doc: false, adr: false };

/** Refetch what the verdicts changed — held while a card is still collapsing, so a read that
 *  lands mid-exit never pulls a row out from under its own animation (and several verdicts in a
 *  row cost one refetch, not one each). */
function settleReview(): void {
  if (Object.values(state.reviewLeaving).some((l) => !l.gone)) return;
  for (const kind of ["doc", "adr"] as const) {
    if (!reviewRefetch[kind]) continue;
    reviewRefetch[kind] = false;
    // Every verdict of this kind the server has confirmed: once THIS read commits, the read is the truth.
    const done = [...reviewExits].filter(([, x]) => x.kind === kind && x.ok).map(([id]) => id);
    const after = () => { for (const id of done) { delete state.reviewLeaving[id]; reviewExits.delete(id); } };
    if (kind === "doc") loadProposals(after); else loadDraftAdrs(after);
  }
}
/** A confirmed verdict whose item no read holds any more has nothing left to hide. */
function pruneReviewLeaving(): void {
  const held = new Set([...state.proposals.data.map((p) => `doc:${p.slug}@${p.version}`), ...state.draftAdrs.data.map((a) => `adr:${a.id}`)]);
  for (const [id, x] of reviewExits) if (x.ok && state.reviewLeaving[id]?.gone && !held.has(id)) { delete state.reviewLeaving[id]; reviewExits.delete(id); }
}

function reviewVerdict(id: string, accept: boolean): void {
  const ref = decodeReviewId(id);
  if (!ref || state.reviewLeaving[id]) return;   // unknown, or already decided (a second click)
  const verdict: ReviewVerdict = accept ? (ref.kind === "adr" ? "ratified" : "promoted") : "rejected";
  // The selection follows to the next card still waiting (the one before, at the end of the list).
  // Only a selection made by hand is moved: with none, the view already shows the first one waiting.
  const selBefore = state.reviewSel;
  let selAfter = selBefore;
  const props = reviewProps(state);
  const item = props.items.find((it) => it.id === id);
  // A page of a group (an import's, an agent's): the next one of its group still waiting, wrapping (the group is its
  // own list).
  const key = item ? groupKeyOf(item) : null;
  const group = key !== null ? reviewGroups(props.items).get(key) ?? null : null;
  const groupLeft = group ? group.items.filter((it) => it.id !== id && !props.leaving?.[it.id]) : [];
  if (selBefore === id) {
    if (group) {
      const rows = group.items.filter((it) => it.id === id || !props.leaving?.[it.id]);
      const at = rows.findIndex((it) => it.id === id);
      selAfter = (rows[at + 1] ?? rows[0] ?? null)?.id ?? null;
      if (selAfter === id) selAfter = null;
    } else {
      const rows = props.items.filter((it) => inReviewFilter(it, props.filter) && groupKeyOf(it) === null && (it.id === id || !props.leaving?.[it.id]));
      const at = rows.findIndex((it) => it.id === id);
      selAfter = (rows[at + 1] ?? rows[at - 1] ?? null)?.id ?? null;
    }
  }
  state.reviewSel = selAfter;
  // The card is seen leaving only on Review, and only when motion is allowed; otherwise it is gone at once.
  const animate = state.screen === "review" && state.reviewView === "queue" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  state.reviewLeaving[id] = { verdict, gone: !animate };
  const exit: ReviewExit = { kind: ref.kind, selBefore, selAfter, timer: null, ok: false };
  reviewExits.set(id, exit);
  if (animate) exit.timer = setTimeout(() => {
    exit.timer = null;
    const l = state.reviewLeaving[id];
    if (l && !l.gone) { l.gone = true; rerender(); }
    settleReview();
  }, REVIEW_EXIT_MS);
  rerender();

  const op = ref.kind === "doc"
    ? (accept ? promoteDoc(ref.slug, ref.version) : rejectDoc(ref.slug, ref.version))
    : (accept ? ratifyAdr(ref.id) : rejectAdr(ref.id));
  op.then(() => {
      exit.ok = true;
      reviewRefetch[ref.kind] = true;
      flash(group && groupLeft.length === 0 ? `Every page from ${group.file} has been reviewed`
        : accept
        ? (ref.kind === "adr" ? "Ratified — the decision is now accepted" : "Promoted — the proposal is live; previous version kept")
        : "Rejected — parked, nothing changed");
      // Refetch the affected list — the read stays the truth (the counts are derived from it).
      settleReview();
    })
    .catch((e) => {
      // The write did not happen: the card is back where it was, with the selection it had.
      if (exit.timer !== null) clearTimeout(exit.timer);
      reviewExits.delete(id);
      delete state.reviewLeaving[id];
      if (state.reviewSel === exit.selAfter) state.reviewSel = exit.selBefore;
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      flash(e instanceof ApiError ? e.message : "Action failed");
      settleReview();
    });
}
/** Review › a group's Approve all / Reject all: the whole card wears the verdict and leaves by the queue's one exit,
 *  optimistically. An import's is `POST /imports/:id/approve-all` / `reject-all` (cookie-only; each call is bounded,
 *  so it is repeated while `remaining` > 0); an agent's is its pages' own promote / reject routes (cookie-only, the
 *  same as deciding each by hand), one page after another — oldest first, so a page's newest change goes live last.
 *  A failure before anything was decided puts the group back as it was; one part way through lets the refetch say
 *  what is left. */
const groupBusy = new Set<string>();
function reviewGroupVerdict(key: string, accept: boolean): void {
  const props = reviewProps(state);
  const g = reviewGroups(props.items).get(key);
  const items = g ? g.items.filter((it) => !state.reviewLeaving[it.id]) : [];
  if (!g || items.length === 0 || groupBusy.has(key)) return;
  groupBusy.add(key);
  const verdict: ReviewVerdict = accept ? "promoted" : "rejected";
  const selBefore = state.reviewSel;
  if (items.some((it) => it.id === selBefore)) state.reviewSel = null;
  const animate = state.screen === "review" && state.reviewView === "queue" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const exits: ReviewExit[] = [];
  for (const it of items) {
    state.reviewLeaving[it.id] = { verdict, gone: !animate };
    const x: ReviewExit = { kind: "doc", selBefore, selAfter: null, timer: null, ok: false };
    reviewExits.set(it.id, x);
    exits.push(x);
  }
  if (animate) exits[0].timer = setTimeout(() => {
    exits[0].timer = null;
    for (const it of items) { const l = state.reviewLeaving[it.id]; if (l && !l.gone) l.gone = true; }
    rerender();
    settleReview();
  }, REVIEW_EXIT_MS);
  rerender();
  let done = 0;
  type Answer = { space: string; space_name: string | null };
  const call = accept ? approveImport : rejectImport;
  const importLoop = (): Promise<Answer> => call(g.id).then((a) => { done += a.done; return a.remaining > 0 && a.done > 0 ? importLoop() : a; });
  const agentLoop = async (): Promise<Answer> => {
    for (const it of [...items].reverse()) {
      const ref = decodeReviewId(it.id);
      if (ref?.kind !== "doc") continue;
      await (accept ? promoteDoc(ref.slug, ref.version) : rejectDoc(ref.slug, ref.version));
      done++;
    }
    return { space: g.space, space_name: null };
  };
  (g.kind === "agent" ? agentLoop() : importLoop())
    .then((a) => {
      groupBusy.delete(key);
      for (const x of exits) x.ok = true;
      reviewRefetch.doc = true;
      const slug = a.space || g.space;
      const name = slug ? a.space_name ?? spaceName(state, slug) : null;
      const pages = `${done} ${done === 1 ? "page" : "pages"}`;
      const verb = done === 1 ? "is" : "are";
      flash(accept ? `${pages} ${verb} now live${name ? ` in ${name}` : ""}` : `${pages} rejected`, 6000, name ? { label: `Open ${name}`, act: "libOpenSpace", arg: slug } : null);
      if (accept) libCtl.load();
      loadBadges();
      settleReview();
    })
    .catch((e) => {
      groupBusy.delete(key);
      if (done > 0) { for (const x of exits) x.ok = true; reviewRefetch.doc = true; }
      else {
        if (exits[0].timer !== null) clearTimeout(exits[0].timer);
        for (const it of items) { reviewExits.delete(it.id); delete state.reviewLeaving[it.id]; }
        if (state.reviewSel === null) state.reviewSel = selBefore;
      }
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      flash(e instanceof ApiError ? (rateLimitText(e) ?? (done > 0 ? `${done} of the pages went through, then it stopped. Try again for the rest.` : "Couldn't do that. Try again.")) : "Couldn't do that. Check your connection and try again.", 5000);
      settleReview();
      rerender();
    });
}
/** The most pages each group has held this session (a group's "‹d› of ‹N› reviewed"), by `groupKeyOf`, and every
 *  page it has held in its order (a page's "Page i of N" keeps its place while others are decided and leave). */
function noteGroupTotals(): void {
  const totals = { ...state.reviewGroupTotals };
  const pages = { ...state.reviewGroupPages };
  for (const [key, g] of reviewGroups(reviewItemsFromReads(state.proposals.data, []))) {
    const had = pages[key] ?? [];
    const seen = new Set(had);
    pages[key] = [...had, ...g.items.map((it) => it.id).filter((id) => !seen.has(id))];
    totals[key] = Math.max(totals[key] ?? 0, g.items.length);
  }
  state.reviewGroupTotals = totals;
  state.reviewGroupPages = pages;
}
function loadDraftAdrsIfNeeded(): void {
  if (state.draftAdrs.status === "idle" || state.draftAdrs.status === "error") loadDraftAdrs();
  else rerender();
}

let needsTriageSeq = 0;
/** `after` runs when THIS read commits, before the paint (an Unplaced exit settles there). */
function loadNeedsTriage(after?: () => void): void {
  const seq = ++needsTriageSeq;
  state.needsTriage = { status: "loading", data: state.needsTriage.data };
  rerender();
  listNeedsTriage()
    .then((rows) => { if (seq !== needsTriageSeq) return; state.needsTriage = { status: "ok", data: rows }; listed("unplaced", rows.length); after?.(); pruneUnplacedLeaving(); rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== needsTriageSeq) return;
      state.needsTriage = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      after?.(); pruneUnplacedLeaving();
      rerenderSoon();
    });
}

// ── Unplaced: a card placed or discarded leaves the list (web-ui.md › A row leaving a list) ─────────────────────
// Review's exit, the same parts: the write goes out on the click, the card is taken out optimistically — it wears
// its verdict, then collapses (trov.css `.cnpy-rv-row[data-verdict]`) — the item on screen moves to the next one
// and the badge drops with it. `state.unplacedLeaving` only HIDES rows of the read; the refetch (held until no card
// is still collapsing) replaces the read and the entry is dropped. A failed write deletes the entry: the card, the
// count, the item on screen and the person's picks are back as they were, with the error.
interface UnplacedExit { selBefore: string | null; selAfter: string | null; picks: Pick<AppState, "assignKind" | "assignSection" | "assignSpace" | "assignTags">; timer: ReturnType<typeof setTimeout> | null; ok: boolean }
const unplacedExits = new Map<string, UnplacedExit>();
let unplacedRefetch = false;

function settleUnplaced(): void {
  if (Object.values(state.unplacedLeaving).some((l) => !l.gone) || !unplacedRefetch) return;
  unplacedRefetch = false;
  const done = [...unplacedExits].filter(([, x]) => x.ok).map(([id]) => id);
  loadNeedsTriage(() => { for (const id of done) { delete state.unplacedLeaving[id]; unplacedExits.delete(id); } });
}
/** A confirmed exit whose item the read no longer holds has nothing left to hide. */
function pruneUnplacedLeaving(): void {
  const held = new Set(state.needsTriage.data.map((r) => String(r.id)));
  for (const [id, x] of unplacedExits) if (x.ok && state.unplacedLeaving[id]?.gone && !held.has(id)) { delete state.unplacedLeaving[id]; unplacedExits.delete(id); }
}
const clearAssignPicks = (): void => { state.assignKind = null; state.assignSection = null; state.assignSpace = null; state.assignTags = []; };

/** What flashes in when Review's view changes in place: the list column's head and rows, and the reading pane's
 *  content (never the columns themselves, whose hairline must not move). The app's one-shot `.cnpy-flash`, off under
 *  reduced motion (trov.css). */
const REVIEW_VIEW_FLASH = ".cnpy-rv-lhead, .cnpy-rv-rows, .cnpy-rv-detail > :not(.cnpy-rv-back)";
/** Open Review on one of its views. From the other view it is the SAME page (`data-morph="review"`, one `pageKey`):
 *  the header — its switch's indicator sliding — is patched, only the two columns (keyed by the view) are replaced and
 *  flash in, and the page's entrance never replays. */
function showReview(view: ReviewView): void {
  if (state.screen === "review" && state.reviewView !== view) pendingFlash = REVIEW_VIEW_FLASH;
  state.screen = "review";
  state.reviewView = view;
  loadForScreen("review");
}

/** Place or discard an Unplaced item: `write` is the cookie route, `ok` what follows its success (a toast, the
 *  list the item landed in). */
function unplacedVerdict(id: string, verdict: UnplacedVerdict, write: () => Promise<unknown>, ok: () => void): void {
  if (state.unplacedLeaving[id]) return;   // already on its way out (a second click)
  const waiting = state.needsTriage.data.map((r) => String(r.id)).filter((x) => x === id || !state.unplacedLeaving[x]);
  // The item on screen moves to the next one still waiting (the one before, at the end). Only a pick made by hand is
  // moved: with none, the view already shows the first one waiting (and, on a phone, the list).
  const selBefore = state.assignOpen;
  let selAfter = selBefore;
  if (selBefore === id) {
    const at = waiting.indexOf(id);
    selAfter = waiting[at + 1] ?? waiting[at - 1] ?? null;
  }
  const picks = { assignKind: state.assignKind, assignSection: state.assignSection, assignSpace: state.assignSpace, assignTags: state.assignTags };
  const onScreen = unplacedOnScreen()?.id === id;
  state.assignOpen = selAfter;
  if (onScreen) clearAssignPicks();   // the picks were that item's
  // The card is seen leaving only on Unplaced, and only when motion is allowed; otherwise it is gone at once.
  const animate = state.screen === "review" && state.reviewView === "unplaced" && !reducedMotion();
  state.unplacedLeaving[id] = { verdict, gone: !animate };
  const exit: UnplacedExit = { selBefore, selAfter, picks, timer: null, ok: false };
  unplacedExits.set(id, exit);
  if (animate) exit.timer = setTimeout(() => {
    exit.timer = null;
    const l = state.unplacedLeaving[id];
    if (l && !l.gone) { l.gone = true; rerender(); }
    settleUnplaced();
  }, UNPLACED_EXIT_MS);
  rerender();   // a Place / Discard that had focus hands it to the next item's (syncReviewDetail)
  write()
    .then(() => { exit.ok = true; unplacedRefetch = true; ok(); settleUnplaced(); })
    .catch((e) => {
      // The write did not happen: the card is back where it was, with the item on screen and the picks it had.
      if (exit.timer !== null) clearTimeout(exit.timer);
      unplacedExits.delete(id);
      delete state.unplacedLeaving[id];
      if (state.assignOpen === exit.selAfter) { state.assignOpen = exit.selBefore; Object.assign(state, exit.picks); }
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      // e.g. "could not place doc: the space \"design\" is archived: use one of …" — the gate's words, verbatim.
      flash(e instanceof ApiError ? e.message : verdict === "placed" ? "Could not place this item" : "Could not discard");
      settleUnplaced();
    });
}
/** The item on screen, as the view draws it (the first waiting one when none is picked). */
function unplacedOnScreen(): { id: string; picked: boolean } | null {
  const waiting = state.needsTriage.data.map((r) => ({ id: String(r.id) })).filter((r) => !state.unplacedLeaving[r.id]);
  const id = selectedUnplacedId(waiting, state.assignOpen);
  return id ? { id, picked: id === state.assignOpen } : null;
}
/** A pick belongs to the item on screen: picking one names that item, so the next paint keeps it. */
function pinUnplaced(): void {
  const on = unplacedOnScreen();
  if (on && !on.picked) { state.assignOpen = on.id; clearAssignPicks(); }
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
      listed("logins", r.tasks.length);
      state.identityDiscarded = r.discarded;
      if (r.discarded.length === 0) state.identityShowDiscarded = false;
      rerenderSoon();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== identityTasksSeq) return;
      state.identityTasks = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
    });
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
    .then((rows) => {
      if (seq !== ticketsSeq) return;
      if (ticketsLanded) leaveDeclined(state.tickets.data, rows);
      state.tickets = { status: "ok", data: rows }; ticketsLanded = true; rerenderSoon();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== ticketsSeq) return;
      state.tickets = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
    });
}
/** A refetch found tickets DECLINED that the queue on screen was showing, in a view that hides
 *  declined (All, the default — tickets.ts `SEG_STATUSES`): each card leaves by the AI kit's one
 *  exit (ai-ui.ts › Leaving — Review's exit on a screen rebuilt per paint), drawn as it was shown
 *  for `AI_EXIT_MS`, then dropped. Every count already leaves it out. Only while the queue itself
 *  is on screen; gone at once under reduced motion. */
function leaveDeclined(prev: TicketListItem[], next: TicketListItem[]): void {
  if (state.screen !== "tickets") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const gone = declinedLeavers(prev, next, state.qSeg);
  if (gone.length === 0) return;
  const at = Date.now();
  const ids = new Set(gone.map((t) => t.id));
  state.qLeaving = [...state.qLeaving.filter((l) => !ids.has(l.row.id) && at - l.at < AI_EXIT_MS), ...gone.map((row) => ({ row, at }))];
  setTimeout(() => {
    const before = state.qLeaving.length;
    state.qLeaving = state.qLeaving.filter((l) => l.at !== at);
    if (state.qLeaving.length !== before) rerender();
  }, AI_EXIT_MS);
}
function loadTicketsIfNeeded(): void {
  aiFilterCtl.ensure(); // the plain-language filter's switch, once per org (no model)
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
    .then((t) => { if (seq !== ticketDetailSeq) return; state.ticketDetail = { status: "ok", data: t }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== ticketDetailSeq) return;
      // A deleted/unknown id is "no such ticket", not a failure to load.
      if (e instanceof ApiError && e.status === 404) { state.ticketDetail = { status: "ok", data: null }; rerenderSoon(); return; }
      state.ticketDetail = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
    });
}

/** The sidebar badge — loaded at boot (it shows on EVERY screen) and after every
 *  ticket write. A failure leaves the previous count rather than flashing 0. */
/** The counts that landed from their own list (or the ticket badge's read) since `GET /badges` was
 *  asked: a later-landing badges answer is older than these and must not overwrite them. */
const landed = new Set<keyof SidebarBadges>();
/** A list landed: its count is now the sidebar's, also while that list reloads. */
function listed(key: keyof SidebarBadges, n: number): void {
  state.badges = { ...state.badges, [key]: n };
  landed.add(key);
}
/** The boot's ONE read for the sidebar (src/tools/badges.ts), in place of the seven lists it counts.
 *  A failure leaves the badges as they are — each screen still loads its own list. */
function loadBadges(): void {
  landed.clear();
  getBadges()
    .then((b) => {
      const next = { ...state.badges };
      for (const k of Object.keys(b) as (keyof SidebarBadges)[]) if (!landed.has(k)) next[k] = b[k];
      state.badges = next;
      if (!landed.has("tickets")) state.ticketBadge = b.tickets;
      rerenderSoon();
    })
    .catch((e) => { if (e instanceof Unauthorized) unauth(e); });
}
function loadTicketBadge(): void {
  getTicketBadge()
    .then((count) => { state.ticketBadge = count; listed("tickets", count); rerenderSoon(); })
    .catch((e) => { if (e instanceof Unauthorized) unauth(e); });
}

let sprintsSeq = 0;
function loadSprints(): void {
  const seq = ++sprintsSeq;
  state.sprints = { status: "loading", data: state.sprints.data };
  listSprints()
    .then((rows) => { if (seq !== sprintsSeq) return; state.sprints = { status: "ok", data: rows }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== sprintsSeq) return;
      state.sprints = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
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
    .then((sp) => { if (seq !== sprintDetailSeq) return; state.sprintDetail = { status: "ok", data: sp }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== sprintDetailSeq) return;
      // A deleted/unknown id is "no such sprint", not a failure to load.
      if (e instanceof ApiError && e.status === 404) { state.sprintDetail = { status: "ok", data: null }; rerenderSoon(); return; }
      state.sprintDetail = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerenderSoon();
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
  // A write's answer is the bare detail: Trov's suggestions (`ai`, the cookie read's) stay until the next read.
  const prev = state.ticketDetail.data;
  if (prev?.ai && !t.ai && prev.id === t.id) t = { ...t, ai: prev.ai };
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

// ── persons directory (Settings › Profile, the person pickers) ──
let personsSeq = 0;
function loadPersons(): void {
  const seq = ++personsSeq;
  state.persons = { status: "loading", data: state.persons.data };
  listPersons()
    .then((rows) => { if (seq !== personsSeq) return; state.persons = { status: "ok", data: rows }; rerenderSoon(); })
    .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } if (seq !== personsSeq) return; state.persons = { status: "error", data: state.persons.data, error: String(e) }; rerender(); });
}
function refreshMe(): void {
  getMe().then((me) => { state.me = me; state.displayName = me.name ?? me.handle; rerenderSoon(); }).catch(() => undefined);
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
    .then((pr) => { if (seq !== personSeq) return; state.personDetail = { status: "ok", data: pr }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== personSeq) return;
      state.personDetail = { status: e instanceof NotFound ? "ok" : "error", data: null, error: errMsg(e) };
      rerenderSoon();
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
    .then((rows) => { if (seq !== artSeq.get("list")) return; state.art.list = { status: "ok", data: rows }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== artSeq.get("list")) return;
      state.art.list = { status: "error", data: state.art.list.data, error: errMsg(e) };
      rerenderSoon();
    });
}
function loadArtifactDetail(slug: string, v: number | null, force = false): void {
  const key = detailKey(slug, v);
  const cur = state.art.details[key];
  if (!force && cur && cur.status !== "idle" && cur.status !== "error") return;
  const seq = nextArtSeq(`d:${key}`);
  state.art.details[key] = { status: "loading", data: cur?.data ?? null };
  getArtifact(slug, v)
    .then((d) => { if (seq !== artSeq.get(`d:${key}`)) return; state.art.details[key] = { status: "ok", data: d }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== artSeq.get(`d:${key}`)) return;
      state.art.details[key] = e instanceof NotFound ? { status: "missing", data: null } : { status: "error", data: null, error: errMsg(e) };
      rerenderSoon();
    });
}
function loadArtifactDiff(slug: string, a: number, b: number, force = false): void {
  const key = diffKey(slug, a, b);
  const cur = state.art.diffs[key];
  if (!force && cur && cur.status !== "idle" && cur.status !== "error") return;
  const seq = nextArtSeq(`x:${key}`);
  state.art.diffs[key] = { status: "loading", data: cur?.data ?? null };
  getArtifactDiff(slug, a, b)
    .then((d) => { if (seq !== artSeq.get(`x:${key}`)) return; state.art.diffs[key] = { status: "ok", data: d }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== artSeq.get(`x:${key}`)) return;
      state.art.diffs[key] = { status: e instanceof NotFound ? "missing" : "error", data: null, error: errMsg(e) };
      rerenderSoon();
    });
}
/** The ticket detail's Artifacts block: `GET /api/artifacts?ticket=<id>`. */
function loadTicketArtifacts(id: number): void {
  const seq = nextArtSeq(`t:${id}`);
  const cur = state.art.ticketArts[id];
  state.art.ticketArts[id] = { status: "loading", data: cur?.data ?? null };
  listArtifacts({ ticket: id })
    .then((rows) => { if (seq !== artSeq.get(`t:${id}`)) return; state.art.ticketArts[id] = { status: "ok", data: rows }; rerenderSoon(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== artSeq.get(`t:${id}`)) return;
      state.art.ticketArts[id] = { status: "error", data: state.art.ticketArts[id]?.data ?? null, error: errMsg(e) };
      rerenderSoon();
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
      rerenderSoon();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { unauth(e); return; }
      if (seq !== artSeq.get("tix")) return;
      state.art.attachTickets = { status: "error", data: state.art.attachTickets.data, error: errMsg(e) };
      rerenderSoon();
    });
}
/** Load what the current Artifacts screen reads. `fresh` refetches (keeping what is
 *  on screen) — used on navigation and after a write; a plain rerender never refetches. */
function loadArtifactsIfNeeded(fresh = false): void {
  const r = state.artRoute;
  if (state.screen === "artifacts") { aiFilterCtl.ensure(); loadArtifactList(fresh); loadSprintsIfNeeded(); loadAttachTickets(); }
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
  const accept = (f: ArtFile) => withChunk(artifactsChunk, (art) => {
    if (target === "create") art.artAcceptFile(state.art, f);
    else {
      const d = state.art.details[detailKey(state.artRoute.slug ?? "", state.artRoute.v)]?.data;
      if (d) art.artAcceptNvFile(state.art, d.kind, f);
    }
    rerender();
  });
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
/** The found-apps card's accept / ignore toast: the 5 seconds of Org settings › Repositories › Apps. */
const FOUND_UNDO_MS = 5000;
/** The confirmation modal's exit (trov.css `.cnpy-cmodal[data-closing]`), then `then` — which
 *  closes it in state. Instant under prefers-reduced-motion or when no modal is open. */
const CONFIRM_OUT_MS = 140;
function confirmOut(then: () => void): void {
  const layer = mount.querySelector<HTMLElement>("[data-confirm-layer]");
  if (layer?.hasAttribute("data-closing")) return; // already on its way out
  if (!layer || matchMedia("(prefers-reduced-motion: reduce)").matches) { then(); return; }
  // `data-keep` too: a repaint while it leaves (the "Saved" toast a save puts up at once) would otherwise strip
  // `data-closing` — the dialog popped back in, then vanished. Morph leaves a kept layer alone until `then` closes it.
  layer.setAttribute("data-keep", "");
  layer.setAttribute("data-closing", "");
  setTimeout(then, CONFIRM_OUT_MS);
}

// ── Platform (superadmin): its loads and acts live in platform-actions.ts ────
// Its own chunk (platform-lazy.ts): the controller is made when the chunk lands, and a load or an
// act asked for before then runs once it has (`withChunk`).
type PlatformCtl = ReturnType<typeof import("./platform-actions").createPlatform>;
let platformCtl: PlatformCtl | null = null;
const platform = {
  run(fn: (c: PlatformCtl) => void): void {
    withChunk(platformChunk, (m) => {
      platformCtl ??= m.createPlatform({
        state, mount, rerender, flash, unauth, confirmOut, reloadOrgs: () => loadMyOrgs(),
        // Not a superadmin after all (a stale #platform link): My Work, as for any unknown hash.
        // On the standalone page there is no My Work to fall back to: the picker.
        leave: () => { if (state.view === "platform") { showPicker(null); return; } state.screen = "mywork"; loadForScreen("mywork"); },
      });
      fn(platformCtl);
    });
  },
  load(): void { platform.run((c) => c.load()); },
  act(act: string, arg: string | null, value: string | null): void { platform.run((c) => c.act(act, arg, value)); },
};


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
  // Editing an account that exists: the handle it already has is its own, not "taken".
  if (state.onboard.edit && h === state.onboard.edit.current) { state.onboard.check = "available"; return; }
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
  // The landing page's acts — Sign in, the tour, the menu, the jumps (landing-actions.ts, shared with the
  // signed-out page's own boot, landing-page.ts).
  if (landingCtl.act(act, arg)) return;
  switch (act) {
    // The state preview's banner: switch to the other state, or close it ("" = off). The flag
    // lives in the address bar, so it is rewritten there; nothing is loaded or sent.
    case "previewSet": {
      applyPreview(arg === "empty" || arg === "loading" ? arg : null);
      history.replaceState(null, "", `${location.pathname}${previewSearch(location.search, state.preview)}${location.hash}`);
      rerender();
      return;
    }
    // auth state navigation (how the screens become reachable)
    case "signInGoogleSwitch": window.location.href = "/auth/google/login?prompt=select_account"; return;
    case "onbHandle": {
      state.onboard.handle = (value ?? "").trim();
      state.onboard.check = state.onboard.handle ? "checking" : "idle";
      scheduleHandleCheck();
      rerender();
      return;
    }
    case "onbName": state.onboard.name = value ?? ""; rerender(); return;
    // The Terms / Privacy / age checkbox (people.ts): ticked by the person, never by default.
    case "onbAgree": state.onboard.agreed = value === "1"; rerender(); return;
    case "onbColor": if (arg && (PERSON_COLORS as readonly string[]).includes(arg)) state.onboard.color = arg as PersonColor; break;
    // Back from the welcome card to "how you'll appear": the account exists, so the card edits it.
    case "onbBack": {
      const me = state.me;
      if (!me) return;
      const id = me.identities[0];
      morphStep(() => {
        state.onboard = { ...initialOnboard(), prefill: id ? { provider: id.provider, label: id.label, email: null, name: me.name, avatar_url: null, suggested_handle: me.handle } : null,
          handle: me.handle, name: me.name ?? "", color: me.color, check: "available", edit: { current: me.handle } };
        state.view = "auth"; state.authStep = "onboard";
        rerender();
      });
      return;
    }
    case "onbSubmit": {
      const o = state.onboard;
      if (o.check !== "available" || o.submitting || (!o.edit && !o.agreed)) return;
      o.submitting = true; o.error = null; rerender();
      if (o.edit) {
        // Save what changed (the same writes Settings › Profile makes), then on to the welcome card.
        const me = state.me;
        const name = o.name.trim() || null;
        const profile = me && (name !== me.name || o.color !== me.color) ? updateMe({ name, color: o.color }) : Promise.resolve(null);
        profile
          .then(() => (o.handle !== o.edit!.current ? renameHandle(o.handle) : null))
          .then(() => getMe())
          .then((fresh) => { state.me = fresh; state.displayName = fresh.name ?? fresh.handle; return morphToPicker(); })
          .catch((e) => {
            o.submitting = false;
            if (e instanceof ApiError && e.message === "handle_taken") o.check = "taken";
            else if (e instanceof Unauthorized) o.error = "This sign-in expired. Start again.";
            else o.error = isRateLimited(e) ? rateLimitText(e) : "Couldn't save that. Try again.";
            rerender();
          });
        return;
      }
      submitOnboard({ handle: o.handle, name: o.name.trim() || null, color: o.color })
        // A brand-new person lands on Get Started, not My Work: the projection is
        // empty on day one, and this is the one moment they are guaranteed to be
        // new. The boot path restores the route from the hash, so #guide is all
        // it takes. Every later sign-in goes wherever their hash points.
        // Signed up FOR something → on to it, before any of the first run: an MCP client's authorize link
        // (back to the consent screen), or a purchase (on to checkout — a new buyer names their
        // organization after paying, not before). A same-origin path the Worker built and
        // `signInReturnPath` recognises; anything else is ignored. Otherwise the first run, as before.
        .then((r) => {
          const next = signInReturnPath(r.redirect);
          if (next) { window.location.href = next; return; }
          // No reload: read who we now are and morph this card into the next one (the org picker —
          // a new person is in no org). Anything unexpected falls back to a fresh page.
          getMe().then((me) => {
            if (me.orgs.length > 0 || me.superadmin === true) throw new Error("not a first run");
            // The guided setup that follows an organization is step 3 of this flow (welcome.ts).
            try { sessionStorage.setItem(FIRST_RUN_KEY, "1"); } catch { /* the count is simply not shown */ }
            state.welcome.firstRun = true;
            state.me = me;
            state.displayName = me.name ?? me.handle;
            state.plat.superadmin = false;
            history.replaceState(null, "", "/");
            return morphToPicker();
          }).catch(() => { window.location.hash = "#guide"; window.location.reload(); });
        })
        .catch((e) => {
          o.submitting = false;
          if (e instanceof ApiError && e.message === "handle_taken") { o.check = "taken"; }
          else if (e instanceof Unauthorized) { o.error = "This sign-in expired. Start again."; }
          else { o.error = "Couldn't finish sign-up. Try again."; }
          rerender();
        });
      return;
    }
    // After payment, "Set up your organization": on to the welcome card IN PLACE (the card morphs into
    // it), not by loading `/?setup=…`. Anything unexpected falls back to that page load.
    case "billingSetup": {
      const fallback = arg && arg.startsWith("/?") ? arg : "/";
      getMe().then((me) => {
        state.me = me;
        state.displayName = me.name ?? me.handle;
        state.plat.superadmin = me.superadmin === true;
        history.replaceState(null, "", "/");
        return morphToPicker(() => { state.billingDone = null; });
      }).catch(() => { location.assign(fallback); });
      return;
    }
    // The payment page's fallback (billing-checkout.ts): Stripe's hosted checkout, when its form would not open here.
    case "billingHosted": void billingCheckoutHosted(billingCheckoutHost); return;
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

    // primary navigation
    case "goHome":
      state.screen = "home"; state.home.headIdx++; state.home.attnOpen = false; loadHomeIfNeeded(); return;
    case "homeAttn": state.home.attnOpen = !state.home.attnOpen; state.home.focused = false; break;
    case "homeAttnClose": state.home.attnOpen = false; break;
    case "homeFocus":
      if (!state.home.focused) { state.home.focused = true; state.home.attnOpen = false; state.home.active = 0; rerender(); }
      homeFocusInput(); return;
    case "homeBlur": state.home.focused = false; break;
    case "homeQ":
      state.home.q = value ?? ""; state.home.focused = true; state.home.active = 0;
      homeSearch(); break;
    case "homeClear": state.home.q = ""; state.home.results = null; state.home.active = 0; rerender(); homeFocusInput(); return;
    case "homeMode":
      if (arg !== "search" && arg !== "ask") return;
      state.home.mode = arg; state.home.focused = true; state.home.active = 0; homeSearch(); rerender(); homeFocusInput(); return;
    case "homeRange":
      if (arg !== "7" && arg !== "30" && arg !== "90") return;
      state.home.range = arg; pendingFlash = ".hm-cards"; break;
    case "homeRetry": loadHomeData(); return;
    case "homePick": {
      const row = homeRows()[Number(arg)];
      if (!row) return;
      state.home.focused = false; state.home.q = ""; state.home.results = null;
      quickPick(row.pick); return;
    }
    // The bar's Ask: for now the question opens Ask Trov, sent (the inline answer replaces this).
    case "homeAsk": case "homeSubmit": {
      const q = (arg ?? state.home.q).trim();
      if (!q) { homeFocusInput(); return; }
      state.home.focused = false; state.home.q = "";
      dispatch("goAsk", null, null);
      setTimeout(() => dispatch("askCvSend", q, null), 0);
      return;
    }
    case "goRepoFor": if (!arg) return; state.repoSlug = arg; state.repoApp = null; state.screen = "repo"; state.repoTab = "overview"; loadRepo(); return;
    case "goRepoApp": {
      const [repo, app] = (arg ?? "").split("\n");
      if (!repo || !app) return;
      state.repoSlug = repo; state.repoApp = app; state.screen = "repo"; state.repoTab = "overview"; loadRepo(); return;
    }
    case "openReviewItem": if (!arg) return; state.reviewSel = arg; dispatch("goReview", null, null); return;
    case "goMyWork":
      // Out of the guided setup: My Work is already what stands behind the card (read while the person
      // was in the setup), so the card simply goes — a morph, and no page entrance replayed over a
      // screen that was in view the whole time.
      if (state.view === "app" && state.screen === "welcome") {
        loadMyWorkIfNeeded();
        morphStep(() => { state.screen = "mywork"; skipEnterOnce = true; rerender(); });
        return;
      }
      state.screen = "mywork"; loadMyWorkIfNeeded(); return;
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
    case "ddToggle": case "ddPick": case "ddClose": dropdowns.act(act, arg); return;

    // ── Repo dashboard ───────────────────────────────────────────────────────
    // `arg` = the tab to land on (quick search's "Repo › …" entries); none = Overview.
    case "goRepo": state.screen = "repo"; state.repoTab = arg && isRepoScreenTab(arg) ? arg : "overview"; loadRepoIfNeeded(); return;
    // The page's tab bar: the one dashboard payload covers every tab, so a switch is ONE
    // rerender with nothing to load — goRepo's load would rebuild the bar and cut its slide.
    // The entrance is not replayed (markEnter), so the new tab's content flashes in instead:
    // a short rise, and its sparklines / fills / bars grow again — and what Trov wrote (Summary's State card,
    // Planning › Where the work went above the panel, `.repo-ai`) with it.
    case "setRepoTab": {
      const tab = arg ?? "";
      if (!isRepoScreenTab(tab) || tab === state.repoTab) return;
      state.repoTab = tab;
      pendingFlash = ".repo-panel > :not(.repo-poll-strip), .repo-ai";
      break;
    }
    case "repoRefresh": if (state.repo.status !== "loading") loadRepo(); return;
    // The Repo screen's found-apps card (web/src/repo-found.ts): a suggestion accepted or ignored in place, with the
    // same toast and Undo as Org settings › Repositories › Apps, then the dashboard read again.
    case "repoFoundAccept": case "repoFoundIgnore": {
      const slug = state.orgSlug;
      const repo = state.repo.data?.repo;
      if (!arg || !slug || !repo || state.repo.data?.sample) return;
      const accepting = act === "repoFoundAccept";
      (accepting ? acceptRepoSuggestion(slug, repo, arg) : ignoreRepoSuggestion(slug, repo, arg))
        .then((r) => {
          const undo = r && typeof r === "object" ? r.undo : undefined;
          flash(accepting ? "Accepted. The Repo screen now shows it." : "Ignored. Scan again brings it back.", FOUND_UNDO_MS,
            undo ? { label: "Undo", act: "repoFoundUndo", arg: undo } : null);
          loadRepo();
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { unauth(e); return; }
          flash(e instanceof ApiError && e.message === "key_taken" ? "An app or a part already has that key. Add this one by hand under another name in Org settings › Repositories › Apps." : accepting ? "Couldn't accept it. Try again." : "Couldn't ignore it. Try again.", 6000);
        });
      return;
    }
    case "repoFoundUndo": {
      const slug = state.orgSlug;
      const repo = state.repo.data?.repo;
      if (!arg || !slug || !repo) return;
      undoRepoSuggestion(slug, repo, arg)
        .then(() => { flash("Undone."); loadRepo(); })
        .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } flash("Couldn't undo it.", 6000); loadRepo(); });
      return;
    }
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
    // Repo › Overview › Needs attention: its button opens the dialog; Done, ×, Escape or the backdrop close it, and
    // focus goes back to the button.
    // Roadmap › Narrative: the Trov button opens its suggestions and the drift in a dialog; Done, ×, Escape or the
    // backdrop close it, and focus goes back to the button.
    case "rmTrov":
      state.rmTrovOpen = !state.rmTrovOpen;
      rerender();
      if (state.rmTrovOpen) mount.querySelector<HTMLElement>("#rm-trov [data-confirm-focus]")?.focus();
      else mount.querySelector<HTMLElement>(".rm-trov-btn")?.focus();
      return;
    case "repoAttention":
      state.repoAttentionOpen = !state.repoAttentionOpen;
      rerender();
      if (state.repoAttentionOpen) mount.querySelector<HTMLElement>("#repo-attention [data-confirm-focus]")?.focus();
      else mount.querySelector<HTMLElement>('[data-act="repoAttention"].repo-att-btn')?.focus();
      return;
    case "repoToggleDrift":
      state.repoDriftOpen = !state.repoDriftOpen;
      if (state.repoDriftOpen) pendingFlash = ".repo-drift";
      break;
    case "repoPollNow": runRepoPoll(); return;
    case "repoPollDismiss": state.repoPoll = null; break;
    // ── the Overview from facts (repo-overview.ts, repo-header.ts) ──
    case "repoPickApp": {
      // The App menu: narrow every tab. The address carries it; a live read asks the Worker for that scope.
      const v = value ?? arg ?? "";
      const app = v === ALL_APPS || v === "" ? null : v;
      if (app === state.repoApp) return;
      if (app !== null && app !== REPO_WIDE && !(state.repo.data?.facts?.allApps ?? []).some((a) => a.key === app)) return;
      state.repoApp = app;
      if (!state.repoSample) { loadRepo(); return; }
      pendingFlash = ".repo-panel > :not(.repo-poll-strip)";
      break;
    }
    case "repoPickRepo": {
      const v = value ?? arg ?? "";
      if (!v || v === state.repo.data?.facts?.repo) return;
      state.repoApp = null; state.repoGroup = null; state.repoGroupFlipped = false; state.repoOpen = new Set();
      if (state.repoSample) {
        // The sample's repositories are its scenarios': show the scenario that repository is.
        void import("./repo-sample").then((m) => {
          const key = m.SCENARIO_KEYS.find((k) => m.repoScenario(k).repo === v);
          if (key) { state.repoScenario = { key, variant: "" }; reloadSampleFacts(); }
        });
        return;
      }
      state.repoSlug = v;
      loadRepo();
      return;
    }
    case "repoGroup": {
      // Group by, this session. An admin who leaves it on something other than the default is offered to save it.
      if (!isGroupBy(arg)) return;
      state.repoGroup = arg;
      state.repoGroupFlipped = true;
      pendingFlash = ".repo-panel > :not(.repo-poll-strip)";
      break;
    }
    case "repoGroupDefault": {
      const facts = state.repo.data?.facts;
      const group = state.repoGroup;
      if (!facts || !group || state.repoSample || !viewerIsAdmin(state) || !state.orgSlug) return;
      putRepoSettings(state.orgSlug, facts.repo, group).then((saved) => {
        const cur = state.repo.data;
        if (cur?.facts && cur.facts.repo === saved.repo) state.repo = { status: state.repo.status, data: { ...cur, facts: { ...cur.facts, groupDefault: saved.overview_group } } } as typeof state.repo;
        state.repoGroupFlipped = false;
        flash(`Group by ${group === "app" ? "app" : "environment"} is now the default for ${saved.repo}.`);
      }).catch((e) => {
        if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
        flash("Couldn't save the default. Try again.");
      });
      return;
    }
    case "repoScenario": {
      const v = value ?? arg ?? "";
      if (!isScenarioKey(v) || !state.repoSample || v === state.repoScenario.key) return;
      state.repoScenario = { key: v, variant: "" };
      state.repoApp = null; state.repoGroup = null; state.repoGroupFlipped = false; state.repoOpen = new Set();
      reloadSampleFacts();
      return;
    }
    case "repoVariant": {
      const v = value ?? arg ?? "";
      const sc = state.repoScenario;
      if (!state.repoSample || !REPO_SCENARIOS[sc.key].variants.includes(v) || v === sc.variant) return;
      state.repoScenario = { key: sc.key, variant: v };
      reloadSampleFacts();
      return;
    }
    case "repoOpen": {
      // A disclosure inside an Overview block (its key is the block's: `drift:staging>production`, …). Session-only.
      if (!arg) return;
      const open = new Set(state.repoOpen);
      if (open.has(arg)) open.delete(arg); else open.add(arg);
      state.repoOpen = open;
      break;
    }
    case "repoSeeWaiting": {
      // Needs attention › See what is waiting: the block that lists it (not shipped, else the opener's row).
      const el = mount.querySelector<HTMLElement>('[data-repo-block="notShipped"]:not(:empty), [data-repo-block="appsTable"]:not(:empty), [data-repo-block="envCards"]:not(:empty)');
      el?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      return;
    }
    case "repoSampleOn":
    case "repoSampleOff":
      state.repoSample = act === "repoSampleOn";
      state.repoApp = null; state.repoGroup = null; state.repoGroupFlipped = false; state.repoOpen = new Set();
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
      if (g === "library" && page) { libCtl.act("libOpenSpace", page, null); return; }
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
    case "goFeed": state.screen = "feed"; loadFeedIfNeeded(); loadFeedStats(); loadFeedReview(); return;

    // ── The person card: a click on anyone's name (the rail, the Feed, quick search,
    // Org settings › Members) opens it over the page; the backdrop, × and Escape close it.
    case "openPerson": if (!arg) return; openPersonCard(arg); return;
    case "personCardClose": state.personCard = null; break;
    // The Library's home (`goDocs` is its old name: My Work's "Docs you own", quick search).
    case "goLibrary": case "goDocs": state.screen = "library"; libCtl.load(); rerender(); return;
    // The Markdown import: the wizard (a space preset when there is one) and Imports history (import-actions.ts).
    case "goImport": state.libUi.headMenu = false; impCtl.open(arg || null); return;
    case "goImports": state.screen = "imports"; impCtl.loadHistory(); return;
    case "goRoadmap": state.screen = "roadmap"; state.sprintId = null; loadRoadmapIfNeeded(); loadRoadmapFeed(); return;

    // ── Tickets: navigation ──────────────────────────────────────────────────
    case "goAsk": state.screen = "ask"; askCtl.enter(null); return;
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
    // Review is ONE screen with two views (`state.reviewView`): its queue (`goReview`, `#review`) and Unplaced
    // (`goUnplaced`, `#review/unplaced` — quick search and Home land there). The header's To review / Unplaced switch
    // is `setReviewView`. Unplaced was Maintenance, whose Identity and People tabs moved into Org settings, which a
    // stale `goMaintenance identity|people` still reaches.
    case "goReview": showReview("queue"); return;
    case "goUnplaced": showReview("unplaced"); return;
    case "goMaintenance":
      if (arg === "identity" || arg === "people") { dispatch("orgGo", "members", null); return; }
      showReview("unplaced");
      return;
    case "setReviewView": if (arg === "queue" || arg === "unplaced") showReview(arg); return;
    case "goSearch": state.screen = "search"; loadSearchIfNeeded(); return;
    case "goSettings": state.screen = "settings"; state.personCard = null; state.mcpSetup = false; state.grantRevokeArm = null; state.grantScope = null; state.grantScopeNote = null; loadSettingsReads(); checkLinkConflict(); return;
    case "goGuide": state.screen = "guide"; break;
    // Help › What's new (its chunk is loaded by the paint: releases-lazy.ts). `arg` "patches" opens Patch notes.
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
      if (pane) pane.scrollTop = target ? Math.max(0, rectOf(target).top - rectOf(pane).top + pane.scrollTop - 24) : 0;
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
      if ((REVIEW_FILTERS as readonly string[]).includes(arg ?? "")) state.reviewFilter = arg as ReviewFilter;
      break;
    // A group of pages (review.ts `reviewGroups`: an import's, an agent's): open it page by page, or decide it whole.
    case "reviewGroupToggle": if (arg) state.reviewGroupsOpen = { ...state.reviewGroupsOpen, [arg]: !state.reviewGroupsOpen[arg] }; break;
    case "reviewGroupApprove": if (arg) reviewGroupVerdict(arg, true); return;
    // Reject all asks first: the dialog takes the focus (its red button), and closing it hands it back to Reject all.
    case "reviewGroupReject":
      if (!arg) return;
      state.reviewGroupReject = { id: arg, busy: false };
      rerender();
      mount.querySelector<HTMLElement>("[data-confirm-focus]")?.focus();
      return;
    case "reviewGroupRejectClose": {
      const id = state.reviewGroupReject?.id;
      if (!id || state.reviewGroupReject?.busy) return;
      confirmOut(() => {
        state.reviewGroupReject = null;
        rerender();
        mount.querySelector<HTMLElement>(`[data-act="reviewGroupReject"][data-arg="${CSS.escape(id)}"]`)?.focus();
      });
      return;
    }
    case "reviewGroupRejectGo": {
      const r = state.reviewGroupReject;
      if (!r) return;
      confirmOut(() => { state.reviewGroupReject = null; reviewGroupVerdict(r.id, false); });
      return;
    }
    case "reviewDiffView":
      if (arg === "unified" || arg === "split" || arg === "rendered") state.reviewDiffView = arg;
      break;
    case "reviewAccept":
    case "reviewReject":
      if (arg) reviewVerdict(arg, act === "reviewAccept");
      return;

    // The doc page and the docs pane: a row, a crumb, a card or a backlink opens a page (`openDoc`; from another
    // screen `openDocFrom`); the narrow screen's Pages button swaps the pane and the page.
    case "docsTree": state.docsTree = !state.docsTree; break;
    case "openDoc": case "openDocFrom": if (arg) openDocPage(arg); return;
    case "toggleHistory": state.showHistory = !state.showHistory; break;

    // Get Started's table of contents: scroll #cnpy-main to the heading, no rerender
    // (the hash is the route, so these are buttons, not #anchors).
    case "guideJump": {
      const pane = document.getElementById("cnpy-main");
      const target = arg ? document.getElementById(arg) : null;
      if (!pane || !target) return;
      const top = rectOf(target).top - rectOf(pane).top + pane.scrollTop - 24;   // CSS px, as scrollTop is
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
      // The full-size capture (`data-full`, render.ts `guideImg`), not the column-sized one on the page.
      openLightbox({ src: img.getAttribute("data-full") ?? img.getAttribute("src") ?? "", alt: cap?.textContent?.trim() ?? title, title, captionHtml: rest });
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
    // Sync GitHub (the header button, its panel, Sync now, Dismiss): sync-actions.ts.
    case "syncToggle": case "syncClose": case "syncReload": case "syncStart": case "syncDismiss": syncCtl.act(act); return;
    // ── Handoffs ─────────────────────────────────────────────────────────────
    case "goRelay": state.screen = "relay"; state.handoffId = null; state.linkId = null; loadRelay(); return;
    case "goHandoffs": state.screen = "handoffs"; state.handoffId = null; loadHandoffs(); return;
    // ── Relay › Links ─────────────────────────────────────────────────────
    case "goLinks": state.screen = "links"; state.linkId = null; loadLinks(); return;
    case "openLink": {
      const id = Number(arg);
      if (!Number.isInteger(id) || id <= 0) return;
      if (state.linkStart?.phase === "sent") state.linkStart = null; // its "Open link #n" — the card has done its job
      state.screen = "link"; openLinkPage(id); return;
    }
    // ── Start a link (links.ts `linkStartCard`): the header's button opens the card at the top of the Links tab ──
    case "linkStartOpen":
      if (state.screen !== "links") { state.screen = "links"; loadLinks(); }
      if (!state.linkStart || state.linkStart.phase === "sent") state.linkStart = blankLinkStart();
      rerender();
      mount.querySelector<HTMLElement>("[data-link-start]")?.scrollIntoView({ block: "nearest" });
      mount.querySelector<HTMLElement>('[data-link-start] [data-seg] [tabindex="0"]')?.focus();
      return;
    case "linkStartClose": state.linkStart = null; break;
    case "linksPastAll": state.linksPastAll = !state.linksPastAll; break;
    case "linkStartMode": {
      const d = state.linkStart;
      if (!d || d.phase === "sending" || !(arg === "self" || arg === "team")) return;
      state.linkStart = { ...d, mode: arg, phase: "edit", error: null };
      break;
    }
    case "linkStartKind": {
      const d = state.linkStart;
      if (!d || d.phase === "sending" || !(arg === "person" || arg === "pr" || arg === "branch" || arg === "ticket")) return;
      state.linkStart = { ...d, kind: arg as LinkStartKind, ref: d.kind === arg ? d.ref : "", phase: "edit", error: null };
      break;
    }
    case "linkStartPerson": {
      const d = state.linkStart;
      if (!d || d.phase === "sending" || !arg) return;
      state.linkStart = { ...d, person: d.person.toLowerCase() === arg.toLowerCase() ? "" : arg, phase: "edit", error: null };
      break;
    }
    case "linkStartField": {
      const d = state.linkStart;
      if (!d || d.phase === "sending" || (arg !== "ref" && arg !== "reason")) return;
      state.linkStart = { ...d, [arg]: arg === "reason" ? (value ?? "").slice(0, 280) : (value ?? "").slice(0, 200), phase: "edit", error: null };
      rerender(); // the Links tab is data-morph'ed: the field keeps its focus and caret while the line and count update
      return;
    }
    case "linkStartSend": {
      const d = state.linkStart;
      const me = state.me?.handle ?? "";
      const target = d ? linkStartTarget(d, me) : null;
      if (!d || !target || !linkStartReady(d, me)) return;
      const sending = { ...d, phase: "sending" as const, error: null };
      state.linkStart = sending;
      rerender();
      // The stream needs a moment to cross before the far orb lights: the answer waits for it (not under reduced motion).
      const t0 = performance.now();
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const after = (fn: () => void) => setTimeout(fn, still ? 0 : Math.max(0, 1150 - (performance.now() - t0)));
      startLink(target, d.reason.trim())
        .then((link) => after(() => {
          if (state.linkStart !== sending) return; // closed or edited meanwhile
          state.linkStart = { ...sending, phase: "sent", sent: link };
          loadLinks(); // the new link joins Yours (or Open, for a link with yourself)
        }))
        .catch((e) => {
          if (e instanceof Unauthorized) { unauth(e); return; }
          if (state.linkStart !== sending) return;
          const code = e instanceof ApiError ? e.message : null;
          state.linkStart = { ...sending, phase: "refused", error: linkStartRefusal(code, e instanceof ApiError ? e.detail : null) };
          rerender();
        });
      return;
    }
    case "linkSend": { const id = Number(arg); if (id > 0) runLinkStep(id, "send", (l) => (l.state === "open" ? `Link #${l.id} is open` : `Link #${l.id} sent`), "Couldn't send this link"); return; }
    case "linkAccept": { const id = Number(arg); if (id > 0) runLinkStep(id, "accept", (l) => `Link #${l.id} is open`, "Couldn't accept this link"); return; }
    case "linkDecline": { const id = Number(arg); if (id > 0) runLinkStep(id, "decline", (l) => `Link #${l.id} declined`, "Couldn't decline this link"); return; }
    case "linkCancel": { const id = Number(arg); if (id > 0) runLinkStep(id, "cancel", (l) => `Link #${l.id} cancelled`, "Couldn't cancel this link"); return; }
    case "linkClose": { const id = Number(arg); if (id > 0) runLinkStep(id, "close", (l) => `Link #${l.id} closed`, "Couldn't close this link"); return; }
    // Cancel on a SENT request asks first (links.ts `linkCancelModal`); a draft's Cancel acts at once (above).
    case "linkCancelArm":
      state.linkCancelArm = true;
      state.linkCancelId = Number(arg) || null; // a card's Cancel request names its link (the link page has linkId)
      rerender();
      mount.querySelector<HTMLElement>("[data-confirm-focus]")?.focus();
      return;
    case "linkCancelDismiss": {
      if (!state.linkCancelArm || state.linkCancelBusy) return;
      confirmOut(() => {
        state.linkCancelArm = false;
        rerender();
        const id = state.linkCancelId;
        (mount.querySelector<HTMLElement>(`[data-confirm-trigger][data-arg="${id}"]`) ?? mount.querySelector<HTMLElement>("[data-confirm-trigger]"))?.focus();
      });
      return;
    }
    case "linkCancelConfirm": {
      const id = Number(arg);
      if (!(id > 0) || !state.linkCancelArm || state.linkCancelBusy) return;
      state.linkCancelBusy = true;
      runLinkStep(id, "cancel", (l) => `Link request #${l.id} cancelled`, "Couldn't cancel this request");
      return;
    }
    case "linkNoteField": {
      const id = Number(arg);
      if (!(id > 0)) return;
      state.linkNote = { id, text: (value ?? "").slice(0, LINK_NOTE_MAX) };
      rerender(); // the count under the box (the page is data-morph'ed: the box keeps its focus and caret)
      return;
    }
    // A self-link's "Write as" switch: which of my two sessions the note is from.
    case "linkNoteSide": if (arg === "requester" || arg === "recipient") state.linkNoteSide = arg; break;
    case "linkNoteSend": {
      const id = Number(arg);
      const text = state.linkNote && state.linkNote.id === id ? state.linkNote.text.trim() : "";
      if (!(id > 0) || !text || state.linkBusy) return;
      state.linkBusy = true;
      rerender();
      const self = state.linkDetail.data?.id === id && state.linkDetail.data.self;
      addLinkNote(id, text, self ? state.linkNoteSide : undefined)
        .then((l) => {
          state.linkBusy = false;
          state.linkNote = null;
          if (state.linkId === id) state.linkDetail = { status: "ok", data: l };
          flash("Note sent");
          rerender();
        })
        .catch((e) => { state.linkBusy = false; linkErr(e, "Couldn't send the note"); rerender(); });
      return;
    }
    // "Open in Ask": a new Ask thread with "join Trov link #n" typed in its composer (the person sends it).
    case "linkJoinAsk": {
      const id = Number(arg);
      if (!(id > 0)) return;
      state.linkStart = null;
      state.screen = "ask";
      askCtl.enter(null);
      askCtl.act("askShNew", null, null);
      state.ask.composer.page = { ...state.ask.composer.page, text: linkJoinPhrase(id) };
      rerender();
      return;
    }
    case "linkJoinCopy": {
      const id = Number(arg);
      if (!(id > 0)) return;
      copyToClipboard(linkJoinPhrase(id)).then((ok) => flash(ok ? "Copied. Paste it to your agent" : "Couldn't reach the clipboard"));
      return;
    }
    case "newHandoff": state.screen = "newhandoff"; state.nh = blankHandoff(primaryRepoName()); rerender(); return;
    case "openHandoff": { const id = Number(arg); if (!Number.isInteger(id) || id <= 0) return; state.screen = "handoff"; openHandoff(id); return; }
    case "mwHandoffClaim": {
      // My Work › Queued handoffs: Claim & copy. The copy runs first, inside the click (the clipboard
      // needs the gesture), from the inbox row on hand — the same "Copy as prompt" text as the handoff
      // screen; then the claim, which is permanent and takes the handoff from everyone else.
      const h = state.handoffs.data.find((x) => x.id === Number(arg));
      if (!h) return;
      const copied = copyToClipboard(handoffAsPrompt(h));
      const session = "sess_web_" + Math.random().toString(36).slice(2, 10).toUpperCase();
      claimHandoff(h.id, session)
        .then((r) => { state.handoffReading = { id: r.handoff.id, items: r.reading_list }; return copied; })
        .then((ok) => { loadHandoffs(); flash(ok ? `Claimed #${h.id} · copied as prompt` : `Claimed #${h.id} — couldn't reach the clipboard`); })
        .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } writeErr(e, "Couldn't claim this handoff"); loadHandoffs(); });
      return;
    }
    case "handoffCopy": {
      const h = state.handoffDetail.data;
      if (!h || h.id !== Number(arg)) return;
      const reading = state.handoffReading && state.handoffReading.id === h.id ? state.handoffReading.items ?? [] : [];
      copyToClipboard(handoffAsPrompt(h, reading)).then((ok) => flash(ok ? "Copied as prompt" : "Couldn't reach the clipboard"));
      return;
    }
    case "handoffClaim": {
      const h = state.handoffDetail.data;
      if (!h || h.id !== Number(arg)) return;
      const session = "sess_web_" + Math.random().toString(36).slice(2, 10).toUpperCase();
      claimHandoff(h.id, session)
        .then(({ handoff: nh, reading_list }) => {
          // The claim's reading list (#167) shows on this page and rides along in the copied prompt.
          // `at`: the list rises in once from here (handoffs.ts `readingListBlock`); this page is rebuilt per repaint,
          // so each repaint inside the rise joins it where the last left off, and none after it replays it.
          state.handoffReading = { id: nh.id, items: reading_list, at: Date.now() };
          return copyToClipboard(handoffAsPrompt(nh, reading_list ?? [])).then((ok) =>
            applyHandoff(nh, ok ? `Claimed #${nh.id} · copied as prompt` : `Claimed #${nh.id} — couldn't reach the clipboard`));
        })
        .catch((e) => { writeErr(e, "Couldn't claim this handoff"); openHandoff(h.id); loadHandoffs(); });
      return;
    }
    case "handoffPromote": {
      const h = state.handoffDetail.data;
      if (!h || h.id !== Number(arg)) return;
      const d = docDraftFromHandoff(h);
      state.screen = "newdoc";
      ndCtl.prefill({ ...d, from: h.id, space: defaultSpaceSlug() });
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
    // A library card's copy button: the plain slug, for an agent's get_prompt. Copy only; the card's
    // hit area is a sibling, so this click never opens the prompt. Not a use (get_prompt counts that).
    case "promptCopySlug":
      if (!arg) return;
      copyToClipboard(arg).then((ok) => flash(ok ? `Slug copied · ${arg}` : "Couldn't reach the clipboard"));
      return;
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

    // ── Library › New page (newdoc-actions.ts) — stages a version-1 proposal through the gate ──
    // In the space it was opened from (a space's home or the pane's head passes it), at its top level; a pane row's
    // "+" opens it under that page (tree-actions.ts `treeNew`).
    case "newDoc": state.screen = "newdoc"; ndCtl.start(arg && liveSpaces(state).some((x) => x.slug === arg) ? arg : paneSpaceOr(defaultSpaceSlug()), null); return;

    // ── Unplaced: the list selects; the picks belong to the item on screen ──
    case "maintSelect":
      if (!arg) return;
      state.assignOpen = arg; clearAssignPicks();
      break;
    // Under a tablet's width: back from the item to the list.
    case "maintBack": state.assignOpen = null; clearAssignPicks(); break;
    case "identityCancel": state.mapConfirm = null; break;

    // "Place it as": a pick names the item on screen (so the next paint keeps it), and a new kind starts its
    // targets again from what the agent sent.
    case "maintAssignKind":
      if (arg === "doc" || arg === "adr" || arg === "feed") {
        pinUnplaced();
        state.assignKind = arg;
        state.assignSection = null;
        state.assignSpace = null;
        state.assignTags = [];
      }
      break;
    case "maintAssignSection": if (arg) { pinUnplaced(); state.assignSection = arg; } break;
    // A switch's option (arg) or, past four spaces, the dropdown's pick (value).
    case "maintAssignSpace": { const v = arg ?? value; if (v) { pinUnplaced(); state.assignSpace = v; } break; }
    case "maintAssignTag":
      if (arg) { pinUnplaced(); state.assignTags = state.assignTags.includes(arg) ? state.assignTags.filter((t) => t !== arg) : [...state.assignTags, arg]; }
      break;
    // Place: exactly what the panel shows (`effectivePicks` — the person's picks, else what the agent sent when it is
    // valid), through the SAME gate (`POST /needs-triage/:id/assign`). The card leaves at once; a refusal brings it
    // back with the gate's reason.
    case "maintFile": {
      if (!arg || state.unplacedLeaving[arg]) return;
      const on = unplacedOnScreen();
      const p = maintenanceProps(state);
      const it = p.unplaced.find((u) => u.id === arg);
      if (!it || !on || on.id !== arg) return;
      const e = effectivePicks(it, p, on.picked);
      if (!e.kind || (e.kind === "doc" && (!e.section || !e.space))) return;
      const id = Number(arg);
      if (!Number.isInteger(id)) return;
      const kind = e.kind;
      const target: AssignTarget = { type: kind };
      if (kind === "doc") { target.section = e.section ?? undefined; target.space = e.space ?? undefined; }
      // With no tag picked the item keeps the tags it came with that are on the org's list (the gate sorts them).
      if (kind === "feed" && e.tags.length) target.tags = e.tags;
      unplacedVerdict(arg, "placed", () => assignTriage(id, target), () => {
        flash(kind === "doc" ? "Placed — the proposal waits in Review" : kind === "adr" ? "Placed — the draft decision waits in Review" : "Placed — posted to the feed");
        if (kind === "doc") loadProposals();   // a placed doc lands as a staged proposal
        if (kind === "adr") loadDraftAdrs();   // a placed decision lands as a draft
        if (kind === "feed") loadFeed();       // a placed feed entry lands live on the Feed screen
      });
      return;
    }
    // Discard is soft and undoable, so no confirm step: the card leaves, and the toast carries the Undo.
    case "maintDiscard": {
      if (!arg) return;
      const id = Number(arg);
      if (!Number.isInteger(id)) return;
      unplacedVerdict(arg, "discarded", () => discardTriage(id), () => flash("Discarded", UNDO_TOAST_MS, { label: "Undo", act: "maintRestore", arg }));
      return;
    }
    case "maintRestore": {
      if (!arg) return;
      const id = Number(arg);
      if (!Number.isInteger(id)) return;
      state.toast = null; state.toastAction = null;
      restoreTriage(id)
        .then(() => {
          // Back in the queue, and on screen: nothing hides it any more.
          delete state.unplacedLeaving[arg]; unplacedExits.delete(arg);
          if (state.screen === "review" && state.reviewView === "unplaced") { state.assignOpen = arg; clearAssignPicks(); }
          flash("Back in Unplaced");
          loadNeedsTriage();
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not undo the discard");
        });
      rerender();
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
    case "toggleOnlyWhenNeeded": {
      if (state.notifPrefs.data?.unsubscribed) return; // dimmed with its reason while unsubscribed (notifications.ts)
      const next = !(state.notifPrefs.data?.onlyWhenNeeded ?? false);
      writePrefs({ onlyWhenNeeded: next }, next ? "Digests only when something needs you" : "Every digest again");
      return;
    }

    // ── Org settings › Notifications (admin) ─────────────────────────────────
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
    // A connection's scope (0051): opened under its row; every change is saved as it is made, and the
    // server answers with my connections as they now stand.
    // It opens as a DIALOG: focus goes to its first control, and back to the row's button on close
    // (Done, the ×, the backdrop or Escape).
    case "grantScopeOpen": {
      state.grantScope = Number(arg);
      state.grantScopeNote = null;
      state.grantRevokeArm = null;
      if (state.myOrgs.status === "idle") void loadMyOrgs();
      rerender();
      focusGrantScope();
      return;
    }
    case "grantScopeClose": closeGrantScope(); return;
    case "grantMode": {
      // arg = "<grant id>:<repo|manual>". Manual starts in the organization on screen (one of mine), and I add others after.
      const [rawId, mode] = (arg ?? "").split(":");
      const start = state.orgSlug ?? state.me?.orgs[0]?.slug;
      if (mode !== "repo" && (mode !== "manual" || !start)) return;
      saveGrantScope(setOAuthGrantMode(Number(rawId), mode, mode === "manual" ? start : undefined),
        mode === "repo" ? "Saved. It now follows the repository." : "Saved. It now works in the organizations you turn on.");
      return;
    }
    case "grantOrgToggle": {
      // arg = "<grant id>:<org slug>:<on|off>".
      const [rawId, slug, to] = (arg ?? "").split(":");
      if (!slug || (to !== "on" && to !== "off")) return;
      saveGrantScope(setOAuthGrantOrg(Number(rawId), slug, to === "on"), to === "on" ? "Saved. It may use that organization now." : "Saved. It can no longer use that organization.", slug);
      return;
    }
    case "grantCurrent": {
      if (!arg || !value) return;
      saveGrantScope(setOAuthGrantCurrent(Number(arg), value), "Saved. It is working there now.");
      return;
    }
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
      // The support form, signed in or out: its controller repaints the dialog alone (support-actions.ts).
      if (act.startsWith("support")) { supportCtl.act(act, arg, value); return; }
      // Settings › Trov (ask-settings-actions.ts).
      if (act.startsWith("trovSet")) { trovPrefsCtl.act(act, arg, value); return; }
      // Deleting one's account or an organization (deletion-actions.ts) — before `org…` below.
      if (act.startsWith("acctDel") || act.startsWith("orgDel")) { deletionCtl.act(act, arg, value); return; }
      // Every Org settings act goes to its controller (org-actions.ts), which rerenders itself.
      // `orgs…` (the switcher, the picker, the create dialog) before `org…` (Org settings).
      if (act.startsWith("welcome")) { welcomeCtl.act(act, arg); return; }
      // Ask Trov (ask-controller.ts routes each `ask<Part>…` act to its part), which repaints itself.
      if (act.startsWith("ask") && askCtl.act(act, arg, value)) return;
      // The org's tag list, a tag's page, a doc's Tags row (tags-actions.ts).
      if (act.startsWith("tag")) { tagsCtl.act(act, arg, value); return; }
      // The Docs Library: Library home, a space's home, the space dialogs (library-actions.ts).
      if (act.startsWith("lib")) { libCtl.act(act, arg, value); return; }
      if (act.startsWith("imp") && impCtl.act(act, arg, value)) return;
      if (act.startsWith("tree") || act === "docToc") { treeCtl.act(act, arg, value); return; }
      if (act.startsWith("nd") && ndCtl.act(act, arg, value)) return;
      if (act.startsWith("orgs")) { orgsCtl.act(act, arg, value); return; }
      if (act.startsWith("org")) {
        if (act === "orgGo") {
          loadOrgAdminExtras();
          // Org settings is its own chunk: until it is in, the screen opens at once on its skeleton
          // (what orgGo itself sets, org-actions.ts), and the act runs again — with its reads — once it lands.
          if (!orgChunk.get()) { state.screen = "org"; state.personCard = null; if (isOrgTab(arg)) state.org.tab = arg; state.org.repoPage = null; rerender(); }
        }
        orgCtl.act(act, arg, value);
        return;
      }
      // Every AI act (ai-actions.ts), which rerenders itself.
      if (act.startsWith("aiFilter")) { aiFilterCtl.act(act, arg, value); return; }
      if (act.startsWith("ai")) { aiCtl.act(act, arg, value); return; }
      // Every Artifacts act goes to the one reducer in artifacts.ts.
      if (act.startsWith("art")) {
        const screen = state.screen === "artifacts" || state.screen === "artifactnew" || state.screen === "artifact" ? state.screen : null;
        const run = () => withChunk(artifactsChunk, (art) => runArtEffect(art.artifactsAct(state.art, { screen, route: state.artRoute, me: state.me?.handle ?? "", admin: viewerIsAdmin(state), host: `${location.origin}${orgBase(state.orgSlug).replace(/\/$/, "")}`, sprints: state.sprints.data.map((x) => ({ id: x.id, label: x.label, dates: sprintDatesLabel(x), active: x.active })) }, act, arg, value)));
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
/** The close in progress is the hover's own (the pointer left): only that one is revived when the pointer comes back.
 *  A close that was asked for — Apply, Escape, the backdrop, the Filter button — runs to its end, even when the screen
 *  repaints under a pointer still resting on the fading popover (that fires a pointerover without a move). */
let fmClosingByHover = false;
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
  state.aiFilter.reveal = null;      // a menu always opens on its "Describe a filter" row, the field shut
  state.fmOpening = id;
  rerender();
  state.fmOpening = null;
}
/** `refocus`: the keyboard was in the menu (Escape) — focus goes back to its Filter button once it is shut. */
function closeFilterMenu(id: string, refocus = false, byHover = false): void {
  const spec = FILTER_MENUS[id];
  if (!spec || !spec.isOpen() || fmClosing === id) return;
  cancelHoverClose();
  const finish = () => {
    fmClosing = null; spec.setOpen(false); rerender();
    if (refocus) mount.querySelector<HTMLElement>(`[data-act="fmToggle"][data-arg="${id}"]`)?.focus({ preventScroll: true });
  };
  const pop = livePopover(id);
  if (!pop || reducedMotion()) { finish(); return; }
  fmClosing = id;
  fmClosingByHover = byHover;
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
    if (!FILTER_MENUS[id].isOpen() || (fmClosing === id && fmClosingByHover)) { hoverOpenedAt = performance.now(); openFilterMenu(id); }
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
  // Typing a filter in it (ai-filter.ts): the menu stays while its field has focus; Escape, the backdrop or
  // the Filter button close it.
  if (menu?.querySelector(".fm-ai")?.contains(document.activeElement)) return;
  cancelHoverClose();
  hoverCloseTimer = setTimeout(() => { hoverCloseTimer = null; closeFilterMenu(id, false, true); }, 200);
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
  // A filter being typed in the open Filter menu keeps its focus (the menu stays open for it, above).
  if (focused instanceof HTMLElement && box.contains(focused) && !focused.closest(".fm-ai")) focused.blur();
});
// A switch's option widths (and a tab bar's tab widths) change with the viewport and once
// the web fonts land: re-place every indicator where it sits, without a slide.
const syncIndicators = () => { syncSegments(mount, { instant: true }); syncTabBars(mount, { instant: true }); };
window.addEventListener("resize", syncIndicators);
void document.fonts?.ready.then(syncIndicators);
// A tab bar's keyboard: ←/→ step between its tabs, Home/End jump (./tabs `onTabBarKey`).
mount.addEventListener("keydown", onTabBarKey);
// A segmented switch's keyboard: ←/→ move focus between its options, Home/End jump
// (./segmented `onSegmentedKey`). On the document: a switch can sit in an overlay.
document.addEventListener("keydown", onSegmentedKey);
// Escape closes an open filter menu — and when the keyboard was in it (a row, the typed filter's field, or
// nowhere after a repaint), focus goes back to its Filter button.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const active = document.activeElement;
  for (const [id, spec] of Object.entries(FILTER_MENUS)) {
    if (!spec.isOpen()) continue;
    closeFilterMenu(id, !active || active === document.body || !!active.closest(`[data-hover-menu="${id}"]`));
  }
});
// ↓ / ↑ walk an open filter menu's rows — the typed filter's "Describe a filter" first, then the shown options,
// then the categories — from its Filter button, a row, or nowhere (a repaint drops focus). Enter on a row is its
// click; a text field keeps its own arrows.
document.addEventListener("keydown", (e) => {
  if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || e.ctrlKey || e.metaKey) return;
  const id = Object.keys(FILTER_MENUS).find((k) => FILTER_MENUS[k].isOpen() && fmClosing !== k);
  const wrap = id ? mount.querySelector<HTMLElement>(`[data-hover-menu="${id}"]`) : null;
  if (!wrap) return;
  const t = e.target instanceof Element ? e.target : null;
  if (t?.closest("input, textarea, select, [contenteditable]")) return;
  if (t && t !== document.body && !wrap.contains(t)) return;
  const rows = Array.from(wrap.querySelectorAll<HTMLElement>(".fm-pop .cnpy-menurow")).filter((r) => !r.closest("[hidden], [inert]"));
  if (!rows.length) return;
  e.preventDefault();
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = at < 0 ? (e.key === "ArrowDown" ? 0 : rows.length - 1) : (at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
  rows[next].focus({ preventScroll: false });
});

mount.addEventListener("click", (e) => {
  // The skip link (site-chrome.ts `skipLink`): focus the main content without writing the hash, which is
  // the app's route and the sign-in return-to.
  if (followSkipLink(e)) return;
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
// The press → drag → drop lifecycle (slop, the swallowed click, Escape, the held paints) is web/src/pointer-drag.ts,
// shared with the docs pane's tree (tree-drag.ts); what follows is what the BOARD draws and commits.
const SLIDE_MS = 160;
let rerenderHeld = false;
interface BoardPress {
  card: HTMLElement; id: number; from: TicketStatus; x: number; y: number;
  dx: number; dy: number; ghost: HTMLElement | null; slot: HTMLElement | null;
  /** Where the card started: its list and the visible card after it. */
  homeList: HTMLElement | null; homeNext: HTMLElement | null;
}
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
  const before = new Map(cards.map((c) => [c, rectOf(c).top]));     // CSS px (zoom.ts), as the translate is
  list.insertBefore(slot, ref);
  if (reducedMotion()) return;
  for (const c of cards) {
    const dy = (before.get(c) ?? 0) - rectOf(c).top;
    if (Math.abs(dy) < 0.5) continue;
    c.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: SLIDE_MS, easing: "cubic-bezier(.2,.7,.2,1)" });
  }
  slot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SLIDE_MS });
}
function clearBoardDrag(p: BoardPress): void {
  p.slot?.remove();
  p.card.classList.remove("is-lifted");
  document.querySelector(".cnpy-tghost")?.remove();
}
pointerDrag<BoardPress>(mount, {
  press(target, e) {
    const card = target.closest<HTMLElement>("[data-tdrag]");
    const id = boardCardId(card);
    if (!card || id === null) return null;
    return { card, id, from: card.dataset.status as TicketStatus, x: e.clientX, y: e.clientY, dx: 0, dy: 0, ghost: null, slot: null, homeList: null, homeNext: null };
  },
  // The ghost is placed in CSS px (zoom.ts): `rectOf` / `pointOf`, so under the big-screen zoom it stays under the
  // pointer. `p.x` / `p.y` stay raw client px — `elementFromPoint` wants those.
  begin(p) {
    const r = rectOf(p.card);
    const at = pointOf({ clientX: p.x, clientY: p.y });
    p.dx = at.x - r.left;
    p.dy = at.y - r.top;
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
  },
  over(p, e) {
    const { ghost, slot } = p;
    if (!ghost || !slot) return;
    const at = pointOf(e);
    ghost.style.left = `${at.x - p.dx}px`;
    ghost.style.top = `${at.y - p.dy}px`;
    const col = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-tdrop]") ?? null;
    const list = col ? listOf(col) : null;
    if (list) {
      // The slot goes before the first card whose middle is below the pointer.
      const ref = liveCards(list).find((c) => { const b = c.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; }) ?? null;
      moveSlot(slot, list, ref);
    }
  },
  drop(p, commit, done) {
    const slot = p.slot;
    if (!p.ghost || !slot) { clearBoardDrag(p); done(); return; }
    const to = (slot.closest<HTMLElement>("[data-tdrop]")?.dataset.tdrop ?? p.from) as TicketStatus;
    const after = prevLive(slot);
    const unmoved = to === p.from && slot.parentElement === p.homeList && nextLive(slot) === p.homeNext;
    const finish = () => {
      clearBoardDrag(p);
      done();
      if (commit && !unmoved) dispatch("queueDrop", boardDropArg(p.id, to, after), null);
    };
    if (!commit || reducedMotion()) { finish(); return; }
    // Glide the lifted card into its slot, then commit.
    const s = rectOf(slot);
    const g = rectOf(p.ghost);
    const anim = p.ghost.animate(
      [{ transform: "none" }, { transform: `translate(${s.left - g.left}px, ${s.top - g.top}px)`, boxShadow: "none" }],
      { duration: 150, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" }
    );
    anim.onfinish = finish;
    anim.oncancel = finish;
  },
}, () => { if (rerenderHeld) { rerenderHeld = false; rerender(); } });
// The docs pane's pages (tree-drag.ts): drag a row into, above or below another page of its space, or onto the
// pane's head for the top level — the same `planMove` the Worker runs, applied at once and posted (tree-actions.ts).
installTreeDrag(mount, {
  pages: () => treeCtl.pages(),
  spaceName: () => state.spaceHome.data?.space.name ?? "",
  commit: (slug, target) => treeCtl.move(slug, target),
});
// Customize sidebar's picked spaces: drag one into place (customize-drag.ts) — or Alt+↑ / Alt+↓ on a focused row.
installCustomizeDrag(mount, {
  commit: (order) => libCtl.act("libCustomizeOrder", order.join(","), null),
  cancel: () => rerender(),
  reducedMotion: () => reducedMotion(),
});
mount.addEventListener("keydown", (e) => {
  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  const row = (e.target as Element | null)?.closest?.<HTMLElement>("#lib-customize [data-cdrag]");
  if (!row) return;
  e.preventDefault();
  const slug = row.dataset.cdrag as string;
  libCtl.act(e.key === "ArrowUp" ? "libCustomizeUp" : "libCustomizeDown", slug, null);
  requestAnimationFrame(() => mount.querySelector<HTMLElement>(`#lib-customize [data-cdrag="${cssEscape(slug)}"]`)?.focus());
});
// …and the same moves from the keyboard: Alt+↑ / Alt+↓ / Alt+→ / Alt+← on a focused row (tree-drag.ts `treeKeyTarget`).
mount.addEventListener("keydown", (e) => {
  if (!e.altKey || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const row = (e.target as Element | null)?.closest?.<HTMLElement>(".cnpy-dpane [data-dtree]");
  const pages = treeCtl.pages();
  if (!row || !pages) return;
  const slug = row.dataset.dtree as string;
  const target = treeKeyTarget(pages, slug, e.key);
  e.preventDefault();
  if (!target) return;
  treeCtl.move(slug, target);
  requestAnimationFrame(() => mount.querySelector<HTMLElement>(`.cnpy-dpane [data-dtree="${cssEscape(slug)}"] > .cnpy-hit`)?.focus());
});
// A row's "…" menu closes on Escape or a click anywhere else.
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.treeMenu) { state.treeMenu = null; rerender(); } });
mount.addEventListener("click", (e) => {
  if (!state.treeMenu) return;
  const t = e.target as Element | null;
  if (t?.closest?.(".cnpy-dp-menu, [data-act=\"treeMenu\"]")) return;
  state.treeMenu = null;
  rerender();
}, true);
// …and so do a Library card's "…" menu (your own view: pin, sidebar, hide) and a space header's "…" menu; Escape
// gives focus back to the "…".
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const card = state.libUi.cardMenu;
  if (card) {
    state.libUi.cardMenu = null;
    rerender();
    mount.querySelector<HTMLElement>(`[data-act="libCardMenu"][data-arg="${cssEscape(card)}"]`)?.focus();
  } else if (state.libUi.headMenu) {
    state.libUi.headMenu = false;
    rerender();
    mount.querySelector<HTMLElement>('[data-act="libHeadMenu"]')?.focus();
  }
});
mount.addEventListener("click", (e) => {
  if (!state.libUi.cardMenu && !state.libUi.headMenu) return;
  const t = e.target as Element | null;
  if (t?.closest?.(".cnpy-lib-cardmenu, .cnpy-lib-headmenu, [data-act=\"libCardMenu\"], [data-act=\"libHeadMenu\"]")) return;
  state.libUi.cardMenu = null;
  state.libUi.headMenu = false;
  rerender();
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
  // The import wizard's Choose files: every file picked (the input is cleared, so the same file can be picked again).
  if (el instanceof HTMLInputElement && el.type === "file" && el.hasAttribute("data-imp-file")) { impCtl.addFiles(Array.from(el.files ?? [])); el.value = ""; }
});
mount.addEventListener("dragover", (e) => {
  if ((e.target as Element | null)?.closest?.("[data-art-drop]")) e.preventDefault();
  // The import wizard's Files step: its drop zone lights while files are over it.
  if ((e.target as Element | null)?.closest?.("[data-imp-drop]")) {
    e.preventDefault();
    if (!state.imp.dragOver) { state.imp.dragOver = true; rerender(); }
  }
});
mount.addEventListener("dragleave", (e) => {
  const zone = (e.target as Element | null)?.closest?.("[data-imp-drop]");
  if (zone && !zone.contains(e.relatedTarget as Node | null) && state.imp.dragOver) { state.imp.dragOver = false; rerender(); }
});
mount.addEventListener("drop", (e) => {
  const imp = (e.target as Element | null)?.closest?.("[data-imp-drop]");
  if (imp) {
    e.preventDefault();
    state.imp.dragOver = false;
    impCtl.addFiles(Array.from(e.dataTransfer?.files ?? []));
    return;
  }
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
    // A checkbox's value is whether it is ticked ("1" or ""), not its constant `value`.
    if (el instanceof HTMLInputElement && el.type === "checkbox") { dispatch(el.dataset.act, el.dataset.arg ?? null, el.checked ? "1" : ""); return; }
    // The caret rides along: "ticketComment" needs it to decide whether the
    // cursor is inside an @mention token. Every other case ignores it.
    dispatch(el.dataset.act, el.dataset.arg ?? null, el.value, el.selectionStart);
  }
});

// Home's bar: ↑ ↓ move through the dropdown, ↵ opens, Tab flips Search / Ask Trov, Esc closes.
mount.addEventListener("keydown", (e) => {
  const el = e.target as HTMLElement | null;
  if (!el?.closest?.('[data-field="homeQ"]') || state.screen !== "home") return;
  const n = homeRows().length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!n) return;
    state.home.focused = true;
    state.home.active = (Math.min(state.home.active, n - 1) + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    rerender();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (state.home.mode === "ask" && state.home.q.trim()) { dispatch("homeSubmit", null, null); return; }
    if (n) dispatch("homePick", String(Math.min(state.home.active, n - 1)), null);
  } else if (e.key === "Escape") {
    state.home.focused = false; (el as HTMLInputElement).blur(); rerender();
  } else if (e.key === "Tab" && !e.shiftKey && homeAskOn()) {
    e.preventDefault();
    dispatch("homeMode", state.home.mode === "ask" ? "search" : "ask", null);
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
  const startY = pointOf(e).y;              // CSS px (zoom.ts): the box follows the pointer 1:1 at any zoom
  const startHeight = rectOf(box).height;
  const move = (ev: PointerEvent) => {
    const h = Math.max(COMMENT_BOX.minHeight, Math.round(startHeight + (pointOf(ev).y - startY)));
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
// The scope dialog (Settings › MCP access) keeps Tab inside itself.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || state.grantScope === null || state.dd.open) return;
  const dlg = mount.querySelector<HTMLElement>("#grant-scope");
  if (!dlg) return;
  const items = grantScopeItems(dlg);
  if (!items.length) { e.preventDefault(); dlg.focus(); return; }
  const at = items.indexOf(document.activeElement as HTMLElement);
  const last = items.length - 1;
  if (at < 0 || (e.shiftKey && at === 0) || (!e.shiftKey && at === last)) { e.preventDefault(); items[e.shiftKey ? last : 0].focus(); }
});
// Escape closes the expanded handoff prompt (the filter menus close in their own listener).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || state.view !== "app") return;
  if (state.personCard) { state.personCard = null; rerender(); }
  else if (state.mcpSetup) closeMcpSetup();
  else if (state.grantScope !== null && !state.dd.open) closeGrantScope(); // an open menu closes first, on its own
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
  // A dropdown open over the dialog (Edit space's Position) owns its own keys (dropdown.ts).
  if (state.dd.open && (e.target as Element | null)?.closest?.("[data-dd-pop]")) return;
  const t = e.target instanceof HTMLButtonElement ? e.target : null;
  const what = confirmKeyAction(e.key, { onDialogButton: !!t && dlg.contains(t) && !t.disabled, busy: dlg.hasAttribute("data-busy"), repeat: e.repeat });
  if (what === null || what === "native") return;
  e.preventDefault(); e.stopImmediatePropagation();
  const arg = dlg.getAttribute("data-arg");
  if (what === "confirm") dispatch(dlg.getAttribute("data-confirm-act") ?? "", arg, null);
  else if (what === "cancel") dispatch(dlg.getAttribute("data-confirm-cancel") ?? "", arg, null);
  else if (what === "trap") {
    // Its buttons, and a deletion's typed confirmation field (confirm.ts `typed`).
    const items = Array.from(dlg.querySelectorAll<HTMLElement>("input:not([disabled]), textarea:not([disabled]), button:not([disabled])"));
    if (!items.length) { dlg.focus(); return; }
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (e.shiftKey ? items.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  }
}, true);

// ── a space's description, edited in place (library.ts): Enter saves, Esc cancels, leaving the field saves ──
mount.addEventListener("keydown", (e) => {
  if (!(e.target as Element | null)?.closest?.("[data-lib-desc]")) return;
  if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); dispatch("libDescSave", null, null); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dispatch("libDescCancel", null, null); }
});
mount.addEventListener("focusout", (e) => {
  if (!(e.target as Element | null)?.closest?.("[data-lib-desc]") || state.libUi.desc === null) return;
  dispatch("libDescSave", null, null);
});

// ── sidebar: ⌘K / Ctrl+K, the search box, and the collapsed-rail tooltip ──────
document.addEventListener("keydown", (e) => {
  if (state.view !== "app" || e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  e.preventDefault();
  // On Home the page's own bar is the search (the design's ⌘K hint sits in it).
  dispatch(state.screen === "home" ? "homeFocus" : "sideSearchFocus", null, null);
});
// Home's bar: focusing its field (a click, Tab) opens the dropdown and its focused look.
mount.addEventListener("focusin", (e) => {
  if (state.screen !== "home" || state.home.focused) return;
  if (!(e.target as Element | null)?.closest?.('[data-field="homeQ"]')) return;
  state.home.focused = true; state.home.attnOpen = false; state.home.active = 0; rerender();
});
// Home's Needs attention closes on Escape.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.screen === "home" && state.home.attnOpen) { state.home.attnOpen = false; rerender(); }
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
  const r = rectOf(row);                    // CSS px (zoom.ts), as the tip's top is
  tip.textContent = row.dataset.tip ?? "";
  tip.style.top = `${Math.round(r.top + r.height / 2)}px`;
  tip.setAttribute("data-on", "1");
}
mount.addEventListener("mouseover", (e) => railTip((e.target as Element | null)?.closest?.<HTMLElement>(".cnpy-aside [data-tip]") ?? null));
mount.addEventListener("focusin", (e) => railTip((e.target as Element | null)?.closest?.<HTMLElement>(".cnpy-aside [data-tip]") ?? null));
mount.addEventListener("focusout", () => railTip(null));
mount.addEventListener("mouseleave", () => railTip(null));

// A status mark's tooltip (`data-mtip`, marks.ts): one styled bubble on <body>, placed by tip.ts.
installMarkTips(mount);


// The landing page (landing-actions.ts): the Sign in dialog, the tour's dialog, the menu under 900px, the
// in-page jumps and their keyboard. Signed in (the landing reopened by the sidebar logo, `#site`), "Get
// started" opens the Guide and the nav's way back returns to where the logo was clicked from.
const landingCtl = createLandingController({
  state, mount, rerender: () => rerender(),
  guide: () => {
    state.siteReturn = null;
    const guide = parseHash("#guide");
    applyRoute(guide);
    loadForScreen(guide.screen);
    window.scrollTo(0, 0);
  },
  back: () => {
    const back = state.siteReturn ?? parseHash("");
    state.siteReturn = null;
    applyRoute(back);
    loadForScreen(back.screen);
  },
});

// The payment page (`/billing/checkout`, embedded checkout). Stripe.js is loaded from here and nowhere
// else, and only when that page asks for it (stripe-js.ts).
const billingCheckoutHost: BillingCheckoutHost = {
  get: () => state.billingCheckout,
  rerender: () => rerender(),
  ask: (s, req) => askBillingCheckout(s.org, req),
  stripe: (publishableKey) => loadStripeEmbedder(publishableKey),
  mountNode: () => document.getElementById(BILLING_MOUNT_ID),
  go: (href) => { location.replace(href); },
  setUrl: (href) => { history.replaceState(null, "", href); },
  preview: () => state.preview !== null,
};

// ── boot: detect session via /auth/me ────────────────────────────────────────
const params = new URLSearchParams(location.search);
if (params.get("denied") === "1") {
  // A GitHub sign-in that was refused (/auth/callback): the login belongs to another GitHub account.
  state.view = "auth";
  state.authStep = "nonmember";
  rerender();
} else if (params.get("denied") === "unverified") {
  // A Google account whose address Google has not verified: /auth/google/callback redirected here
  state.view = "auth";
  state.authStep = "unverified";
  state.deniedEmail = params.get("email");
  rerender();
} else if (location.pathname === BILLING_CHECKOUT_PATH) {
  // Embedded checkout (billing-checkout.ts): Stripe's form in Trov's own card. The page asks the Worker for
  // its session, which answers the signed-in buyer only; a URL that names no plan Trov sells is the plans.
  state.billingCheckout = initialBillingCheckout(params);
  if (!state.billingCheckout) location.replace(PRICING_PATH);
  else { rerender(); void startBillingCheckout(billingCheckoutHost); }
} else if (location.pathname === BILLING_DONE_PATH) {
  // Back from Stripe Checkout (billing.ts): the waiting room polls until the webhook has made the
  // buyer's grant, then sends them on to `/?setup=<grant>` — the picker, with that organization's form open.
  state.billingDone = initialBillingDone(params.get("session_id"));
  rerender();
  void startBillingDone({ get: () => state.billingDone, rerender, ask: getBillingStatus, go: (href) => { location.assign(href); } });
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
  // (The PRERENDERED landing page — `/` with no session cookie — is booted by its own script,
  // landing-page.ts, which hands the page to this one only for what it does not answer: `?denied=`,
  // `#onboard`, and a page without the prerendered markup.)
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
      // Sent here by an organization's deletion (deletion-actions.ts): say it happened, once, wherever this lands.
      if (params.get(DELETED_PARAM) === "org") {
        history.replaceState(null, "", `${location.pathname}${location.hash}`);
        flash(DELETED_SENTENCE.org, 6000);
      }
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
      // `/?contact=1` (the static pages' Contact link) for someone who IS signed in: the same form, as
      // that person, over wherever boot lands them — when it lands in place (opening an org by a page
      // load simply drops the parameter).
      if (params.get("contact") === "1" && location.pathname === "/") {
        history.replaceState(null, "", `/${location.hash}`);
        setTimeout(() => { if (state.view !== "auth" && !state.support.open) supportCtl.open("question"); }, 0);
      }
      if (me.superadmin === true && (isPlatformPath(location.pathname) || (me.orgs.length === 0 && /^#platform(?:\/|$)/.test(hash)))) { void loadMyOrgs(); enterPlatform(hash); return; }
      // Sent on from the waiting room (billing.ts `setupHref`): the picker — whatever orgs they are already
      // in — where the organization they just paid for is one of the things to do ("You can set up an
      // organization — Pro. Paid for just now."). Its form is NOT opened for them: it is their next step
      // to take, on a card that says the payment went through, not a dialog thrown over it.
      const setup = params.get(SETUP_PARAM);
      if (setup !== null && location.pathname === "/") {
        history.replaceState(null, "", "/");
        showPicker(null);
        return;
      }
      const land = resolveLanding({ pathSlug: orgSlugFromPath(location.pathname), orgs: me.orgs, lastUsed: last, returnOrg: backOrg });
      if (land.kind === "org") { enterOrg(land.slug, hash); return; }
      if (back && back !== location.hash) history.replaceState(null, "", `${location.pathname}${back}`);
      showPicker(land.lost);
    })
    .catch(() => showSignedOut()); // Unauthorized or any error → the landing page
}

/** Signed out: the landing page — with what a link to it asked for. */
function showSignedOut(): void {
  state.view = "auth";
  state.authStep = "login";
  // Sent here by the billing route (`/?start=team`: a signed-out buyer who has not picked a provider —
  // the pricing page's "Choose Pro"): Get started opens on that plan, so the two provider buttons
  // carry on to payment. The parameter is read once and leaves the address bar.
  if (params.get("start") === "team") {
    state.signInOpen = true; state.signInMode = "signup"; state.signInPlan = "team";
    history.replaceState(null, "", `/${location.hash}`);
  }
  rerender();
  // Sent here by deleting one's own account (deletion-actions.ts): signed out, on the site, told so once.
  if (params.get(DELETED_PARAM) === "account") {
    history.replaceState(null, "", "/");
    flash(DELETED_SENTENCE.account, 8000);
  }
  // Sent here by Contact in the footer of a static page (pricing, terms, privacy — site-chrome.ts
  // `CONTACT_HREF`): the Contact form opens over the landing page. Read once; it leaves the address bar.
  if (params.get("contact") === "1") {
    history.replaceState(null, "", `/${location.hash}`);
    supportCtl.open("question");
  }
}
