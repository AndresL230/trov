// Faithful static port of Canopy.dc.html — markup + inline styles transcribed
// from the dc-runtime template (lines 53–731), with `sc-for` resolved to
// `.map().join('')`, `sc-if` to ternaries, and `onClick="{{ fn }}"` to
// `data-act` / `data-arg` attributes dispatched in main.ts.

import { trovMark } from "@shared/mark";
import type { Me, StagedProposal, IdentityTask, DiscardedIdentity, PersonSummary, PersonProfile, InviteRow } from "./api";
import type { FeedRow, DocRow, DocMetaRow, DocVersionRow, AdrRow, NeedsTriageRow, PersonColor, OAuthGrantSummary } from "@shared/rows";
import type { QueryResult, QueryPrimary, QueryPointer, Authority, SprintView, SprintDetail, PlanView } from "./api";
import type { TicketListItem, TicketDetail, TicketSeg, TicketAssigneeFilter, TicketCategory } from "./api";
import type { TicketPriority } from "@shared/tickets";
import { queueView, newTicketView, ticketDetailView, ticketDeleteModal, ticketPill, priorityChip, type StatusMenuAnchor, type QueueFilterCat } from "./tickets";
import { sprintCard, newSprintPanel, sprintScreen, nextSprintId } from "./sprints";
import { sprintDueState, sprintDatesLabel } from "@shared/sprints-core";
import { roadmapTimeline } from "./timeline";
import type { SprintUrgency, SprintDomain } from "@shared/sprints";
import { initialOnboard, onboardView, personChip, personLink, personAvatarLink, handleTag, handleLink, swatches, type OnboardState } from "./people";
import { personCardModal } from "./profile";
import { AVATAR_TYPES } from "@shared/people";
import type { DashboardData, MyWorkTicket } from "@shared/dashboard";
import type { FeedStats } from "@shared/feed-stats";
import {
  myWorkLayout, mwSpans, ticketsTile, reviewTile, sessionsTile, repoTile, libraryStrip, handoffsForMe,
  type MwLoad, type MwSession, type MwHandoff, type MwLibrary, type MwRepoTab, type MwDue,
} from "./mywork";
import { TAGS } from "@shared/vocabulary";
import { filterMenu, filterMenuBackdrop, type FilterMenuProps } from "./filter-menu";
import { segmented } from "./segmented";
import { tabBar, tabPanelAttrs } from "./tabs";
import { releasesScreen, findRelease, type ReleasePage } from "./releases";
import { renderMarkdown, renderMarkdownInline } from "./markdown";
import { extractOutline } from "./outline";
import { REPO_URL } from "./github";
import { esc, attr, initialsOf, relTime, surface, asideColumns, asideHead, asideNote, hitArea, HITBOX } from "./ui";
import { landingView } from "./landing";
import { reviewView, type ReviewFilter, type ReviewProps, type DiffViewMode } from "./review";
import { maintenanceView, peopleSection, type MaintenanceProps, type AssignKind, type MaintTab, type PersonEditDraft } from "./maintenance";
import { handoffsView, handoffDetailView, newHandoffView, handoffPromptModal, blankHandoff, type NewHandoffDraft } from "./handoffs";
import type { PromptView } from "./prompt-box";
import { promptLibraryView, promptDetailView, promptEditorView, promptPageModal, promptDeleteModal, type PromptFilterCat, type PromptDraft } from "./prompts";
import { newDocView, blankDoc, type NewDocDraft } from "./newdoc";
import type { HandoffView, PromptSummary, PromptDetail, PromptVersion, PromptSort } from "@shared/handoffs";
import { firstLine } from "@shared/handoffs";
import { emailNotificationsSection, notificationsMaintenanceSections, unsubscribeView } from "./notifications";
import type { PrefsView, PolicyKindView, NotificationOutboxRow, NotificationSettingsRow } from "./api";
import { sidebarView, NAV_CLOSED, type NavOpen } from "./sidebar";
import { repoView, repoControls, repoCrumb, type RepoProps, type RepoPollState } from "./repo";
import {
  artifactsView, artifactsHeader, artifactsDialogs, ticketArtifactsBlock, initialArtUi, ART_ROUTE_NONE,
  type ArtUi, type ArtRoute, type ArtScreen, type ArtProps,
} from "./artifacts";
import type { RepoDashboard, RepoTab, RepoRange } from "@shared/repo";
import { platformView, platformOrgView, platformDialogs, platformHeaderControls, platformCrumb, initialPlat, type PlatState } from "./platform";
import { reviewItemsFromReads, reviewHeadsFromReads, ASSIGN_OPTIONS, unplacedFromRow, identityFromTask, discardedFromRow, peopleFromPersons } from "./triage-map";

// A docs "space" is a free-form top-level grouping shown as a toggle (e.g.
// Technical | Product). Values come from the data, not a fixed union.
export type DocSpace = string;

export type Screen =
  | "mywork" | "feed" | "docs" | "roadmap" | "review" | "maintenance" | "search" | "settings" | "guide" | "unsubscribe"
  // The landing page reopened from inside the app (sidebar logo). Full-screen, no chrome.
  | "site"
  // Tickets (Phase 5): the queue, one ticket, the new-ticket form, and a sprint.
  // `sprint` is a Roadmap child — the sidebar highlights Roadmap while it is open.
  | "tickets" | "ticketdetail" | "newticket" | "sprint"
  // The Repo dashboard (Monitor › Repo): five tabs under one screen, `#repo/<tab>`.
  | "repo"
  // Artifacts (Knowledge › Artifacts): the library, the new-artifact form, and one
  // artifact (its viewer, or its version diff), over /api/artifacts (artifacts.ts).
  | "artifacts" | "artifactnew" | "artifact"
  // Platform (superadmin only): the tabbed area, and one organization's page.
  | "platform" | "platformorg"
  // Handoffs (Workspace): the inbox, one handoff, the new-handoff form.
  | "handoffs" | "handoff" | "newhandoff"
  // Prompt Library (Knowledge): the library, one prompt, the editor (new / edit / new version).
  | "prompts" | "prompt" | "promptedit"
  // Docs › New doc.
  | "newdoc"
  // Help › What's new: the release grid, and each release's notes / patch notes (releases.ts, static data).
  | "releases";

/** Async data slice: a screen's fetched payload plus its load status. */
export interface Loadable<T> {
  status: "idle" | "loading" | "ok" | "error" | "unauth";
  data: T;
  error?: string;
}

export interface AppState {
  view: "auth" | "app";
  authStep: "login" | "verifying" | "nonmember" | "notinvited" | "onboard";
  /** The landing page's sign-in dialog (authStep "login" only). */
  signInOpen: boolean;
  /** Landing reveal keys that already played (landing-motion.ts records them). */
  landingSeen: Set<string>;
  /** Where "Back to the app" on the #site landing returns to (the route the logo was clicked from). */
  siteReturn: import("./hash").Route | null;
  deniedEmail: string | null;
  onboard: OnboardState;
  persons: Loadable<PersonSummary[]>;
  invites: Loadable<InviteRow[]>;
  inviteDraft: string;
  me: Me | null;
  mywork: Loadable<DashboardData | null>;
  /** My Work › Repo tile: which view is showing. Session-only. */
  mwRepoTab: MwRepoTab;
  /** My Work list tiles the person expanded past MW_ROWS. Session-only. */
  mwExpanded: Record<string, boolean>;
  /** My Work › Your sessions: MY latest feed entries — its own read, never `feed`
   *  (which carries the Feed screen's author/tag filters). */
  mwSessions: Loadable<FeedRow[]>;
  /** My Work › Docs you own: every doc WITHOUT its body (`/docs?fields=meta`), so
   *  My Work never pulls every doc's text nor opens the Docs screen's first doc. */
  mwDocs: Loadable<DocMetaRow[]>;
  screen: Screen;
  theme: "dark" | "light" | "system";
  systemDark: boolean;
  collapsed: boolean;
  /** The viewport is too narrow for the full rail — it renders collapsed regardless of `collapsed`. */
  narrow: boolean;
  /** A phone-width viewport (≤ 640px): the rail leaves the layout and becomes a drawer. */
  phone: boolean;
  /** The phone drawer is open (never persisted; closes on navigation, backdrop tap or Esc). */
  drawer: boolean;
  /** Which sidebar entries have their sub-page list open (persisted; a group opens itself on entry). */
  navOpen: NavOpen;
  // ── Repo dashboard ─────────────────────────────────────────────────────────
  repo: Loadable<RepoDashboard | null>;
  repoTab: RepoTab;
  repoRange: RepoRange;
  /** Usage › Product: the environment picked this session (null = the default one). */
  repoProductEnv: string | null;
  repoDriftOpen: boolean;
  /** When `repo` last loaded (ms) — the header's "updated Xm ago". */
  repoFetchedAt: number | null;
  /** Showing the built-in sample set instead of the Worker's projection. Session-only. */
  repoSample: boolean;
  /** The admin's last "Poll now" on the Usage tab. Session-only, never persisted; cleared on leaving the Repo screen. */
  repoPoll: RepoPollState | null;
  /** The Feed's lens: "reading" = title + brief (for people), "agents" = the full body. Saved per browser. */
  feedView: FeedView;
  feedAuthor: string;
  feedFilterOpen: boolean;
  feedFilterCat: FeedFilterCat;
  feedTag: string;
  feedRange: string;
  feed: Loadable<FeedRow[]>;
  feedAuthors: string[];
  /** The Feed aside's "This week" (`GET /feed/stats`): the WHOLE team's last 7 days,
   *  unfiltered — refreshed on each entry to the Feed, never by a filter change. */
  feedStats: Loadable<FeedStats | null>;
  docsList: Loadable<DocRow[]>;
  docDetail: Loadable<{ doc: DocRow; versions: DocVersionRow[] } | null>;
  docSlug: string | null;
  /** Narrow screens only: the Docs page list is showing instead of the reader. */
  docsTree: boolean;
  docSpace: DocSpace;
  /** Docs-tree pages whose outline (in-page headings) is expanded, keyed by slug. */
  docOutlineOpen: Record<string, boolean>;
  /** Heading id to scroll the reader to after the next render, then cleared. */
  pendingScrollId: string | null;
  roadmapTab: "narrative" | "timeline";
  /** Help › What's new: the release shown (`#releases/<v>`), or null for the grid (`#releases`). */
  releaseVersion: string | null;
  /** Which of that release's two pages (`#releases/<v>` / `#releases/<v>/patches`). */
  releasePage: ReleasePage;
  roadmap: Loadable<PlanView>;
  /** Roadmap › Recent happenings: its OWN unfiltered read of the newest
   *  HAPPENINGS_LIMIT feed entries — never the Feed screen's (filterable) slice. */
  roadmapFeed: Loadable<FeedRow[]>;
  // Triage surfaces (Review + Maintenance) — four Loadable slices, one per
  // list read; each surface's counts/props derive straight from these.
  proposals: Loadable<StagedProposal[]>;
  draftAdrs: Loadable<AdrRow[]>;
  needsTriage: Loadable<NeedsTriageRow[]>;
  identityTasks: Loadable<IdentityTask[]>;
  /** Discarded logins Undo can still restore — rides the identity-tasks read. */
  identityDiscarded: DiscardedIdentity[];
  /** Maintenance › Identity's "N discarded" list is open. */
  identityShowDiscarded: boolean;
  reviewFilter: ReviewFilter;
  reviewSel: string | null;
  reviewDiffView: DiffViewMode;
  assignOpen: string | null;
  assignKind: AssignKind | null;
  assignSection: string | null;
  assignSpace: string | null;
  assignTags: string[];
  mapConfirm: string | null;
  mapPicks: Record<string, string>;
  showHistory: boolean;
  searchQuery: string;
  searchType: "all" | "doc" | "feed" | "decision" | "artifact";
  searchResults: Loadable<QueryResult>;
  displayName: string;
  /** Settings › MCP access › Connected apps: the caller's OAuth connections. */
  grants: Loadable<OAuthGrantSummary[]>;
  /** The connection whose Revoke was clicked once — the second click is the one that revokes. */
  grantRevokeArm: number | null;
  /** Connected apps opened past its first MCP_LIST_CAP rows by "Show all". */
  grantsAll: boolean;
  /** Settings › MCP access's "Set it up without the plugin" modal is open (`mcpSetupModal`, at the app root). */
  mcpSetup: boolean;
  // Settings › Profile: the handle rename editor.
  handleEdit: boolean;
  handleDraft: string;
  handleCheck: "idle" | "checking" | "available" | "invalid" | "reserved" | "taken" | "same";
  // Email notifications (Settings) — the user's resolved prefs + the address edit form.
  notifPrefs: Loadable<PrefsView | null>;
  emailEditing: boolean;
  emailDraft: string;
  // Email notifications (Maintenance, admin) — policy / schedule / recent outbox.
  notifPolicy: Loadable<PolicyKindView[]>;
  notifSettings: Loadable<NotificationSettingsRow | null>;
  notifOutbox: Loadable<NotificationOutboxRow[]>;
  outboxExpanded: string | null;
  fromDraft: string | null;
  /** The #unsubscribe screen: the flip in flight, its error, or a Settings preview (no flip). */
  unsub: { pending: boolean; error: string | null; preview: boolean };
  confirmedSprints: Record<string, boolean>;
  // ── Tickets (Phase 5) ──────────────────────────────────────────────────────
  /** The queue list for the CURRENT filters (the server applies seg/assignee/category). */
  tickets: Loadable<TicketListItem[]>;
  ticketDetail: Loadable<TicketDetail | null>;
  /** The ticket the detail screen is showing (from `#tickets/<id>`). */
  ticketId: number | null;
  /** Unassigned + open, org-wide — the sidebar badge AND the queue's footer count. */
  ticketBadge: number;
  qSeg: TicketSeg;
  qAssignee: TicketAssigneeFilter;
  qCategory: TicketCategory | "all";
  qView: "table" | "board";
  /** The queue's open filter dropdown (null = none). */
  qQ: string;
  qPrio: "all" | TicketPriority;
  /** "all", "backlog", or a sprint id. */
  qSprint: string;
  /** One assignee's tickets (a handle, "" = none) — client-side, over an `anyone` fetch. */
  qPerson: string;
  qFilterOpen: boolean;
  qFilterCat: QueueFilterCat;
  // New-ticket form fields (the design's f* state).
  fTitle: string;
  /** null = nothing picked, which files as `other`. */
  fCat: TicketCategory | null;
  fPrio: TicketPriority;
  fDesc: string;
  fAsgs: string[];
  fLink: string;
  /** null = Backlog. */
  fSpr: number | null;
  // Ticket-detail-only UI state (drafts + which popover is open).
  commentDraft: string;
  /**
   * The open @mention picker over the comment box: the token being typed
   * (`start` is the index of its `@` in `commentDraft`), the active row, and
   * the caret's 0-based line, which is what the picker hangs under.
   * null = closed. Reset whenever the detail changes or a comment posts.
   */
  mention: { query: string; start: number; index: number; line: number } | null;
  /** The comment box's height after a grip drag (null = the resting height).
   *  It lives in state because `rerender()` replaces the textarea element on
   *  every keystroke, which would throw a DOM-only height away. */
  commentHeight: number | null;
  linkDraft: string;
  lkOpen: boolean;
  /** The ticket detail's title/description editor drafts; null = not editing. */
  tdEdit: { title: string; body: string } | null;
  /** The ticket page's delete confirm is open / its write is in flight. */
  tdDeleteArm: boolean;
  tdDeleteBusy: boolean;
  asgMenu: boolean;
  sprMenu: boolean;
  relMenu: boolean;
  /** The linked-work chip whose ⋯ menu is open (a link id; null = none). */
  lkMenu: number | null;
  /** Which of the ticket's two status controls has its menu open (null = neither). */
  stMenu: StatusMenuAnchor | null;
  /** Sprints back the queue's group headers and the ticket form's/rail's menus. */
  sprints: Loadable<SprintView[]>;
  /** The sprint screen's payload. */
  sprintDetail: Loadable<SprintDetail | null>;
  sprintId: number | null;
  /** The sprint screen's inline delete confirm is showing. */
  sprintDeleteArmed: boolean;
  // The Roadmap Narrative tab's New sprint panel (the design's ns* state). `label` is
  // the only required field, so `nsName` is what arms "Create sprint".
  nsOpen: boolean;
  nsName: string;
  /** The Start / Due date fields: "" or YYYY-MM-DD (native `<input type="date">`). */
  nsStart: string;
  nsDesc: string;
  nsUrg: SprintUrgency;
  nsDue: string;
  nsLead: string | null;
  nsDom: SprintDomain | null;
  /** The sprint-date refusal shown under the dates (`sprintDatesProblem`, or the server's 400), or null. */
  nsError: string | null;
  // ── Artifacts (artifacts.ts) ─────────────────────────────────────────────
  /** The artifact the `artifact` screen shows (slug, version, diff pair). */
  artRoute: ArtRoute;
  /** The artifact reads (list, details, diffs, per-ticket), library filters, menus, dialogs, the create form. */
  art: ArtUi;
  // ── Handoffs (UI-first: reads are real, writes are not built yet) ──────────
  handoffs: Loadable<HandoffView[]>;
  handoffDetail: Loadable<HandoffView | null>;
  handoffId: number | null;
  /** Expire was clicked once — the second click is the one that would expire. */
  handoffExpireArm: boolean;
  /** The handoff's prompt, expanded over the page. */
  handoffPromptOpen: boolean;
  nh: NewHandoffDraft;
  // ── Prompt Library ─────────────────────────────────────────────────────────
  /** The whole library; the search / tag / sort filter runs client-side over it. */
  promptList: Loadable<PromptSummary[]>;
  promptQ: string;
  promptTag: string | null;
  promptSort: PromptSort;
  promptFilterOpen: boolean;
  promptFilterCat: PromptFilterCat;
  promptSlug: string | null;
  promptDetail: Loadable<{ prompt: PromptDetail; versions: PromptVersion[] } | null>;
  /** The version whose diff replaces the body (null = the body). */
  promptDiffV: number | null;
  promptTagMenu: boolean;
  promptTagDraft: string;
  /** The prompt page's "Delete prompt" confirm is open / its request is in flight. */
  promptDeleteArm: boolean;
  promptDeleteBusy: boolean;
  /** The prompt page's body, expanded over the page (the shared prompt modal). */
  promptExpanded: boolean;
  /** Raw markdown or rendered, for every prompt box (a handoff's and a library prompt's). */
  promptView: PromptView;
  promptMode: "new" | "edit" | "version";
  promptEd: PromptDraft | null;
  // ── Docs › New doc / Maintenance tabs ──────────────────────────────────────
  nd: NewDocDraft;
  maintTab: MaintTab;
  maintDiscardArm: boolean;
  // ── Platform (superadmin): everything its screens hold (platform.ts) ───────
  plat: PlatState;
  /** The filter menu (web/src/filter-menu.ts) the NEXT paint opens — its entrance plays once, then main.ts clears this. */
  fmOpening: string | null;
  toast: string | null;
  /** One button on the toast (a delete's "Undo") — dispatched like any `data-act`. */
  toastAction: ToastAction | null;
  /** When the toast went up and how long it stays (ms) — a rerender joins its fade where it left off. */
  toastAt: number;
  toastMs: number;
  /** ADMIN Sync GitHub progress — null when idle; present while a (possibly
   *  multi-batch) sync is running, tracking cumulative counts across batches. */
  backfillSync: BackfillSyncState | null;
  // ── The person card (profile.ts), Maintenance › People's role editor, Settings › Profile's photo ──
  /** The person card open over the page (a click on a name); null = closed. */
  personCard: string | null;
  /** That person's `GET /api/people/:handle` (joined, GitHub, admin) — the card paints without it. */
  personDetail: Loadable<PersonProfile | null>;
  /** Maintenance › People: the admin's open role + responsibilities editor (one person;
   *  `draft` null while that person's profile read is in flight, `base` what it returned);
   *  null = closed. */
  personEdit: { handle: string; draft: PersonEditDraft | null; base: PersonEditDraft | null } | null;
  /** The editor just closed (or replaced by another person's), rendered collapsing under its
   *  row until its exit is over; always null under prefers-reduced-motion. */
  personEditOut: { handle: string; draft: PersonEditDraft | null; base: PersonEditDraft | null } | null;
  personSaving: boolean;
  /** A photo upload or removal in flight. */
  avatarBusy: "upload" | "remove" | null;
  /** Settings › Profile: the photo menu the avatar opens (upload / change / remove). */
  avatarMenu: boolean;
}

/** Sync GitHub modal state: "starting" from the click until the first batch
 *  resolves (the server is paginating GitHub + ingesting — there are no real
 *  counts yet, and rendering "0 of 0" reads as a broken sync), then "progress"
 *  with absolute counts snapshotted from the most recent batch response. */
export type BackfillSyncState =
  | { phase: "starting" }
  | { phase: "progress"; prSummarizedCount: number; prsTotal: number; issueSummarizedCount: number; issuesTotal: number };

export function initialState(): AppState {
  return {
    view: "auth", authStep: "login", signInOpen: false, landingSeen: new Set(), siteReturn: null,
    deniedEmail: null,
    onboard: initialOnboard(),
    persons: { status: "idle", data: [] },
    invites: { status: "idle", data: [] },
    inviteDraft: "",
    me: null,
    screen: "mywork",
    theme: "light", systemDark: true,
    collapsed: false,
    narrow: false,
    phone: false,
    drawer: false,
    navOpen: { ...NAV_CLOSED },
    repo: { status: "idle", data: null },
    repoTab: "overview", repoRange: "7d", repoProductEnv: null, repoDriftOpen: false, repoFetchedAt: null, repoSample: false, repoPoll: null,
    feedView: "reading", feedFilterOpen: false, feedFilterCat: "author", feedAuthor: "all", feedTag: "all", feedRange: "all",
    feed: { status: "idle", data: [] },
    mywork: { status: "idle", data: null },
    mwRepoTab: "prs",
    mwExpanded: {},
    mwSessions: { status: "idle", data: [] },
    mwDocs: { status: "idle", data: [] },
    feedAuthors: [],
    feedStats: { status: "idle", data: null },
    docsList: { status: "idle", data: [] },
    docDetail: { status: "idle", data: null },
    docSlug: null,
    docsTree: false,
    docSpace: "technical",
    docOutlineOpen: {},
    pendingScrollId: null,
    roadmapTab: "narrative", // the Roadmap opens on Narrative (the combined narrative + sprints + aside)
    releaseVersion: null,
    releasePage: "notes",
    roadmap: { status: "idle", data: { narrative: "", version: 0, updated_at: null, updated_by: null, sprints: [] } },
    roadmapFeed: { status: "idle", data: [] },
    proposals: { status: "idle", data: [] },
    draftAdrs: { status: "idle", data: [] },
    needsTriage: { status: "idle", data: [] },
    identityTasks: { status: "idle", data: [] },
    identityDiscarded: [], identityShowDiscarded: false,
    reviewFilter: "all", reviewSel: null, reviewDiffView: "unified",
    assignOpen: null, assignKind: null, assignSection: null, assignSpace: null, assignTags: [],
    mapConfirm: null,
    mapPicks: {},
    showHistory: false,
    searchQuery: "token", searchType: "all",
    searchResults: { status: "idle", data: { primary: [], pointers: [], meta: { engine: "fts5", total: 0 } } },
    displayName: "",
    grants: { status: "idle", data: [] },
    grantRevokeArm: null,
    mcpSetup: false,
    grantsAll: false,
    handleEdit: false,
    handleDraft: "",
    handleCheck: "idle",
    notifPrefs: { status: "idle", data: null },
    emailEditing: false,
    emailDraft: "",
    notifPolicy: { status: "idle", data: [] },
    notifSettings: { status: "idle", data: null },
    notifOutbox: { status: "idle", data: [] },
    outboxExpanded: null,
    fromDraft: null,
    unsub: { pending: false, error: null, preview: false },
    confirmedSprints: {},
    // Tickets — defaults transcribed from the design's `state` block: the queue
    // opens on Open / Any assignee / All categories in the Table view, and the
    // new-ticket form opens empty (no category → `other`, Normal, Backlog,
    // Unassigned).
    tickets: { status: "idle", data: [] },
    ticketDetail: { status: "idle", data: null },
    ticketId: null,
    ticketBadge: 0,
    qSeg: "all", qAssignee: "anyone", qCategory: "all", qView: "board",
    qQ: "", qPrio: "all", qSprint: "all", qPerson: "", qFilterOpen: false, qFilterCat: "assignee",
    fTitle: "", fCat: null, fPrio: "normal", fDesc: "", fAsgs: [], fLink: "", fSpr: null,
    commentDraft: "", mention: null, commentHeight: null, linkDraft: "",
    lkOpen: false, tdEdit: null, tdDeleteArm: false, tdDeleteBusy: false, asgMenu: false, sprMenu: false, relMenu: false, lkMenu: null, stMenu: null,
    sprints: { status: "idle", data: [] },
    sprintDetail: { status: "idle", data: null },
    sprintId: null,
    sprintDeleteArmed: false,
    nsOpen: false, nsName: "", nsStart: "", nsDesc: "", nsUrg: "normal", nsDue: "", nsLead: null, nsDom: null, nsError: null,
    artRoute: ART_ROUTE_NONE,
    art: initialArtUi(),
    handoffs: { status: "idle", data: [] },
    handoffDetail: { status: "idle", data: null },
    handoffId: null, handoffExpireArm: false, handoffPromptOpen: false,
    nh: blankHandoff(),
    promptList: { status: "idle", data: [] },
    promptQ: "", promptTag: null, promptSort: "updated_desc", promptFilterOpen: false, promptFilterCat: "tag",
    promptSlug: null,
    promptDetail: { status: "idle", data: null },
    promptDiffV: null, promptTagMenu: false, promptTagDraft: "", promptDeleteArm: false, promptDeleteBusy: false, promptExpanded: false, promptView: "raw",
    promptMode: "new", promptEd: null,
    nd: blankDoc("technical", ""),
    maintTab: "unplaced", maintDiscardArm: false,
    plat: initialPlat(),
    fmOpening: null,
    toast: null,
    toastAction: null,
    toastAt: 0,
    toastMs: 0,
    backfillSync: null,
    personCard: null,
    personDetail: { status: "idle", data: null },
    personEdit: null,
    personEditOut: null,
    personSaving: false,
    avatarBusy: null,
    avatarMenu: false,
  };
}

// ── triage surface data (real reads — the mapping layer lives in triage-map.ts) ──
export function reviewProps(s: AppState): ReviewProps {
  return {
    items: reviewItemsFromReads(s.proposals.data, s.draftAdrs.data).map((it) => {
      const p = personFor(s, it.agent);
      return p ? { ...it, agentColor: p.color, agentAvatar: p.avatar_url, agentHandle: p.handle, agentName: p.name } : it;
    }),
    filter: s.reviewFilter,
    selectedId: s.reviewSel,
    diffView: s.reviewDiffView,
  };
}

export function maintenanceProps(s: AppState): MaintenanceProps {
  return {
    tab: s.maintTab,
    discardArm: s.maintDiscardArm,
    unplaced: s.needsTriage.data.map(unplacedFromRow),
    assign: ASSIGN_OPTIONS,
    assignOpen: s.assignOpen,
    assignKind: s.assignKind,
    assignSection: s.assignSection,
    assignSpace: s.assignSpace,
    assignTags: s.assignTags,
    identity: s.identityTasks.data.map(identityFromTask),
    discarded: s.identityDiscarded.map(discardedFromRow),
    showDiscarded: s.identityShowDiscarded,
    people: peopleFromPersons(s.persons.data),
    mapPicks: s.mapPicks,
    mapConfirm: s.mapConfirm,
  };
}

/** Sidebar counts for the two triage entries — the lengths of the four list reads. */
export function triageCounts(s: AppState): { review: number; maintenance: number } {
  return {
    review: s.proposals.data.length + s.draftAdrs.data.length,
    maintenance: s.needsTriage.data.length + s.identityTasks.data.length,
  };
}

/** Sidebar count for Handoffs: pending handoffs left for ME — `handoffsForMe`, the
 *  ONE definition My Work's Your sessions tile counts too. */
export function handoffBadge(s: AppState): number {
  return handoffsForMe(s.handoffs.data, s.me?.handle ?? "").length;
}

const PLUS_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"></path></svg>`;

// ── helpers ──────────────────────────────────────────────────────────────────
function resolved(s: AppState): "dark" | "light" {
  return s.theme === "system" ? (s.systemDark ? "dark" : "light") : s.theme;
}
// esc / attr live in ./ui (shared with the componentized surfaces).
// Defense-in-depth: external URLs from captured payloads must be http(s) — never javascript:/data:/etc.
const safeUrl = (u: string): string => (/^https?:\/\//i.test(u) ? u : "#");
const AVATAR = "border:1px solid var(--border-strong);background:color-mix(in srgb,var(--fg) 7%,transparent);display:grid;place-items:center";
/** Look up a captured login (feed author, doc updated_by) in the persons directory
 *  for its color/avatar — case-insensitive, since GitHub logins are case-preserving
 *  but case-insensitive for matching. null when unmapped (personChip falls back to initials). */
function personFor(s: AppState, handle: string): PersonSummary | null {
  return s.persons.data.find((p) => p.handle.toLowerCase() === handle.toLowerCase()) ?? null;
}

function logo(size: number): string {
  return trovMark(size);
}

// ── real-data helpers (authors are github logins; no curated display map) ─────
/** A PR artifact may arrive bare ("14"), as "#14", or as a full pull URL (".../pull/14"). */
function prNumber(ref: string): string {
  const s = String(ref);
  const m = s.match(/\/pull\/(\d+)/) ?? s.match(/^#?(\d+)$/);
  return m ? m[1] : s;
}
/** A commit artifact may arrive as a bare SHA or a full commit URL; extract the SHA (href keeps it whole). */
function commitSha(ref: string): string {
  const s = String(ref);
  const m = s.match(/\/commit\/([0-9a-f]+)/i) ?? s.match(/\b([0-9a-f]{7,40})\b/i);
  return m ? m[1] : s;
}
/** Parse the feed row's artifacts JSON ({prs,commits,issues}) into render-ready chips. */
function feedArtifacts(json: string | null): { kind: string; label: string; href: string }[] {
  if (!json) return [];
  let a: { prs?: string[]; commits?: string[]; issues?: number[] };
  try { a = JSON.parse(json); } catch { return []; }
  const isUrl = (v: string) => /^https?:\/\//i.test(v);
  const out: { kind: string; label: string; href: string }[] = [];
  for (const pr of a.prs ?? []) {
    const num = prNumber(pr);
    out.push({ kind: "PR", label: `#${num}`, href: isUrl(String(pr)) ? String(pr) : `${REPO_URL}/pull/${num}` });
  }
  for (const c of a.commits ?? []) {
    const sha = commitSha(c);
    out.push({ kind: "commit", label: sha.slice(0, 7), href: isUrl(String(c)) ? String(c) : `${REPO_URL}/commit/${sha}` });
  }
  for (const i of a.issues ?? []) out.push({ kind: "issue", label: `#${i}`, href: `${REPO_URL}/issues/${i}` });
  return out;
}
/** A linked GitHub chip (issue / PR / commit / issue group). */
function ghChip(c: { kind: string; label: string; href: string }): string {
  return `<a href="${c.href}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;padding:3px 8px;text-decoration:none;color:var(--fg-70)"><span style="color:var(--fg-40)">${esc(c.kind)}</span><span style="font-family:var(--label);font-weight:500">${esc(c.label)}</span></a>`;
}
/** GitHub links for a sprint's github_ref. The bare number IS the number of an
 *  issue GROUP on GitHub, hence the "group" chip kind and the URL below. */
function sprintRefChips(github_ref: string | null): { kind: string; label: string; href: string }[] {
  if (!github_ref) return [];
  try {
    const p = JSON.parse(github_ref);
    // The path segment is GitHub's own — not Trov vocabulary.
    if (typeof p === "number") return [{ kind: "group", label: `#${p}`, href: `${REPO_URL}/milestone/${p}` }];
    if (Array.isArray(p)) return p.map((n) => ({ kind: "issue", label: `#${n}`, href: `${REPO_URL}/issues/${n}` }));
  } catch { /* malformed ref → no chips */ }
  return [];
}
/** Centered muted notice reused for loading / error states (no layout change). */
function notice(text: string): string {
  return `<div style="text-align:center;padding:60px;color:var(--fg-40);font-size:13px">${text}</div>`;
}

// ── auth states ──────────────────────────────────────────────────────────────
function authView(s: AppState): string {
  // Signed out → the landing page; its Sign in opens the provider dialog.
  if (s.authStep === "login") return landingView({ dark: resolved(s) !== "light", signInOpen: s.signInOpen, seen: s.landingSeen });
  return `<div class="cnpy-authwrap" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px">
    ${s.authStep === "nonmember" ? nonmemberCard() : ""}
    ${s.authStep === "notinvited" ? notInvitedCard(s.deniedEmail) : ""}
    ${s.authStep === "verifying" ? verifyingCard() : ""}
    ${s.authStep === "onboard" ? onboardView(s.onboard) : ""}
  </div>`;
}

function nonmemberCard(): string {
  return `<div style="width:400px;max-width:100%">
    <div${surface("padding:34px;display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center", { cls: "cnpy-authcard" })}>
      <div class="cnpy-seal" style="width:52px;height:52px;border-radius:50%;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55)">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>
      </div>
      <div>
        <div style="font-size:18px;font-weight:600;letter-spacing:-0.01em">Trov is limited to the Sapling team.</div>
        <div style="font-size:13.5px;color:var(--fg-55);margin-top:8px;line-height:1.55">Your GitHub account isn't a member of the <span style="font-family:var(--label);font-size:12.5px">SaplingLearn</span> organization, so there's nothing here for you yet.</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:9px 14px 9px 9px;border:1px solid var(--border);border-radius:999px">
        <div class="cnpy-av cnpy-av-anon" style="width:26px;height:26px;border-radius:50%;${AVATAR};font-size:10px;font-weight:600;color:var(--fg-70)">OS</div>
        <div style="text-align:left;line-height:1.25;white-space:nowrap"><div style="font-size:12.5px;font-weight:500">Signed in as</div><div style="font-size:11.5px;color:var(--fg-55);font-family:var(--label)">octo-stranger</div></div>
      </div>
      <button data-act="backToLogin" class="cnpy-outlinebtn" style="width:100%;padding:11px 16px;border-radius:9px;border:1px solid var(--border-strong);font-size:13.5px;font-weight:500">Sign out &amp; switch account</button>
    </div>
  </div>`;
}

function notInvitedCard(email: string | null): string {
  return `<div style="width:400px;max-width:100%">
    <div${surface("padding:34px;display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center", { cls: "cnpy-authcard" })}>
      <div class="cnpy-seal" style="width:52px;height:52px;border-radius:50%;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55)">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>
      </div>
      <div>
        <div style="font-size:18px;font-weight:600;letter-spacing:-0.01em">This Google account hasn't been invited yet.</div>
        <div style="font-size:13.5px;color:var(--fg-55);margin-top:8px;line-height:1.55">Trov is limited to the Sapling team. Ask an admin to invite <span style="font-family:var(--label);font-size:12.5px">${esc(email ?? "your address")}</span>, then sign in again.</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:9px 14px 9px 9px;border:1px solid var(--border);border-radius:999px">
        <div class="cnpy-av cnpy-av-anon" style="width:26px;height:26px;border-radius:50%;${AVATAR};font-size:10px;font-weight:600;color:var(--fg-70)">${esc(initialsOf(email ?? "?"))}</div>
        <div style="text-align:left;line-height:1.25;white-space:nowrap"><div style="font-size:12.5px;font-weight:500">Signed in with Google as</div><div style="font-size:11.5px;color:var(--fg-55);font-family:var(--label)">${esc(email ?? "unknown")}</div></div>
      </div>
      <button data-act="signInGoogleSwitch" class="cnpy-outlinebtn" style="width:100%;padding:11px 16px;border-radius:9px;border:1px solid var(--border-strong);font-size:13.5px;font-weight:500">Try a different account</button>
    </div>
  </div>`;
}

function verifyingCard(): string {
  return `<div style="display:flex;flex-direction:column;align-items:center;gap:22px">
    <div style="display:flex;align-items:center;gap:11px;opacity:.95">
      ${logo(28)}
      <span style="font-size:23px;font-weight:600;letter-spacing:-0.02em">Trov</span>
    </div>
    <div style="display:flex;align-items:center;gap:11px;color:var(--fg-55);font-size:13px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4" style="animation:cnpy-spin .8s linear infinite"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"></path></svg>
      Verifying Sapling membership&hellip;
    </div>
  </div>`;
}

// ── app shell ────────────────────────────────────────────────────────────────
/** The rail is collapsed when the person collapsed it OR the viewport forces it. On a phone
 *  it is neither: it is the full rail, in a drawer (trov.css `[data-phone="1"]`). */
export const railCollapsed = (s: AppState): boolean => !s.phone && (s.collapsed || s.narrow);

function sidebar(s: AppState): string {
  const counts = triageCounts(s);
  return sidebarView({
    screen: s.screen,
    collapsed: railCollapsed(s),
    navOpen: s.navOpen,
    qView: s.qView,
    roadmapTab: s.roadmapTab,
    docSpace: s.docSpace,
    docSpaces: DOC_SPACES.map((k) => ({ key: k, label: spaceLabel(k) })),
    // Tickets: unassigned ACTIVE tickets — a "nobody has this" signal (design call #2).
    counts: { review: counts.review, maintenance: counts.maintenance, tickets: s.ticketBadge, handoffs: handoffBadge(s), prompts: s.promptList.data.filter((p) => p.status === "staged").length },
    me: s.me ? { handle: s.me.handle, name: s.me.name, color: s.me.color, avatar_url: s.me.avatar_url } : null,
    displayName: s.displayName,
    logo: logo(24),
    superadmin: s.plat.superadmin === true,
  });
}

/** The "›" crumb text for the three child screens (empty on a top-level screen). */
function headerCrumb(s: AppState): string {
  if (s.screen === "releases") {
    const r = s.releaseVersion ? findRelease(s.releaseVersion) : null;
    const name = r ? (r.unreleased ? "Unreleased" : `v${r.version}`) : (s.releaseVersion ?? "");
    return s.releasePage === "patches" ? `${name} · Patch notes` : name;
  }
  if (s.screen === "newticket") return "New ticket";
  if (s.screen === "handoff") return s.handoffDetail.data ? firstLine(s.handoffDetail.data.body) : "";
  if (s.screen === "newhandoff") return "New handoff";
  if (s.screen === "prompt") return s.promptDetail.data?.prompt.title ?? "";
  if (s.screen === "promptedit") {
    const ed = s.promptEd;
    if (!ed) return "";
    return ed.mode === "new" ? "New prompt" : `${ed.mode === "edit" ? "Edit" : "New version"} · ${ed.title}`;
  }
  if (s.screen === "newdoc") return "New doc";
  if (s.screen === "platformorg") return platformCrumb(s.plat);
  if (s.screen === "ticketdetail") return s.ticketDetail.data?.title ?? "";
  if (s.screen === "sprint") {
    return s.sprintDetail.data?.label ?? s.sprints.data.find((sp) => sp.id === s.sprintId)?.label ?? "";
  }
  return "";
}

function header(s: AppState): string {
  const titles: Record<Screen, string> = {
    mywork: "My Work", feed: "Feed", docs: "Docs", roadmap: "Roadmap", review: "Review",
    maintenance: "Maintenance", search: "Search", settings: "Settings", guide: "Get Started",
    unsubscribe: "Unsubscribe", site: "Trov",
    // The three ticket screens all sit under Tickets; a sprint sits under Roadmap.
    tickets: "Tickets", ticketdetail: "Tickets", newticket: "Tickets", sprint: "Roadmap",
    repo: "Repo",
    artifacts: "Artifacts", artifactnew: "Artifacts", artifact: "Artifacts",
    handoffs: "Handoffs", handoff: "Handoffs", newhandoff: "Handoffs",
    prompts: "Prompt Library", prompt: "Prompt Library", promptedit: "Prompt Library",
    newdoc: "Docs",
    releases: "What's new",
    platform: "Platform", platformorg: "Platform",
  };
  // dark = "show the moon icon".
  const dark = resolved(s) !== "light";

  // Feed chrome: ONE Filter menu (author · tag · time — the shared filter-menu, no
  // search box), then the For reading / For agents switch at the header's far right.
  const feedViewSwitch = s.screen === "feed" ? segmented({
    id: "feed-view", ariaLabel: "Feed view", act: "setFeedView", value: s.feedView, inertOn: true,
    options: [{ value: "reading", label: "For reading" }, { value: "agents", label: "For agents" }],
  }) : "";
  const feedMenu = s.screen === "feed" ? feedFilterMenu(s) : null;
  const feedControls = feedMenu
    ? `<div style="position:relative;display:flex;align-items:stretch;height:32px">${filterMenuBackdrop(feedMenu)}${filterMenu(feedMenu)}</div>`
    : "";

  // The Technical / Product space is picked from the sidebar's Docs sub-pages, so the
  // header carries only New doc (it had a second copy of the same switcher).
  const docsControls = s.screen === "docs"
    ? `<button data-act="newDoc" class="cnpy-outlinebtn" style="display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap">${PLUS_ICON}New doc</button>`
    : "";
  const accentNew = (act: string, label: string) =>
    `<button data-act="${act}" class="cnpy-accentbtn" style="display:flex;align-items:center;gap:7px;padding:7px 14px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;white-space:nowrap;transition:filter .12s ease">${PLUS_ICON}${label}</button>`;
  const newControls = s.screen === "handoffs" ? accentNew("newHandoff", "New handoff") : s.screen === "prompts" ? accentNew("newPrompt", "New prompt") : "";

  // The Roadmap header: New sprint (it opens the panel at the top of whichever tab is
  // showing). Narrative / Timeline are the tab bar heading the page body (`roadmapTabBar`).
  const roadmapControls = s.screen === "roadmap" ? accentNew("nsToggle", "New sprint") : "";

  // ADMIN-only, My Work screen: trigger the server-side GitHub backfill. Rendered
  // only when /auth/me returned admin:true (outline button, promote-class action).
  // While s.backfillSync is set, the button is disabled (progress itself shows
  // in the modal below — see backfillSyncModal) — a sync can span multiple
  // batched requests (src/tools/backfill.ts caps AI calls per invocation),
  // driven by main.ts.
  const syncing = s.backfillSync !== null;
  const myworkControls = s.screen === "mywork" && s.me?.admin
    ? `<button data-act="adminBackfill" title="${syncing ? "Sync in progress" : "Fetch all GitHub PRs + issues"}" class="cnpy-outlinebtn" ${syncing ? "disabled" : ""} style="display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);${syncing ? "opacity:.65;cursor:default" : ""}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ${syncing ? 'style="animation:cnpy-spin .8s linear infinite"' : ""}><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>
      ${syncing ? "Syncing&hellip;" : "Sync GitHub"}
    </button>` : "";

  // Queue chrome (the `tickets` screen only): the Table / Board toggle in the
  // Roadmap tab idiom, plus the header's submit button.
  const queueControls = s.screen === "tickets" ? `${segmented({
    id: "queue-view", ariaLabel: "Queue view", act: "", value: s.qView,
    options: [
      { value: "board", label: "Board", act: "queueBoard", arg: "", icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="6" height="16" rx="1.5"></rect><rect x="14" y="4" width="6" height="10" rx="1.5"></rect></svg>` },
      { value: "table", label: "Table", act: "queueTable", arg: "", icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>` },
    ],
  })}
    <button data-act="newTicket" class="cnpy-accentbtn" style="display:flex;align-items:center;gap:7px;padding:7px 14px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;white-space:nowrap;transition:filter .12s ease"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"></path></svg>Submit a ticket</button>` : "";

  const themeBtn = `<button data-act="cycleTheme" title="Toggle theme" class="cnpy-iconbtn" style="width:32px;height:32px;border-radius:8px;border:1px solid var(--border);display:grid;place-items:center;color:var(--fg-55)">
      ${dark
        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path></svg>`
        : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"></path></svg>`}
    </button>`;

  // Breadcrumb (the design's titleBtnSt / crumbSt): on a CHILD screen the title
  // becomes a back button to its parent and a "›" crumb names the child.
  // `ticketsBack` resolves to Tickets, or Roadmap from a sprint (one act, like
  // the design's single `back` handler).
  const child = s.screen === "ticketdetail" || s.screen === "newticket" || s.screen === "sprint"
    || s.screen === "handoff" || s.screen === "newhandoff" || s.screen === "prompt" || s.screen === "promptedit" || s.screen === "newdoc"
    || (s.screen === "releases" && s.releaseVersion !== null) || s.screen === "platformorg";
  // The act the title's back button fires: each child screen returns to its own parent.
  const backAct = s.screen === "handoff" || s.screen === "newhandoff" ? "goHandoffs"
    : s.screen === "prompt" ? "goPrompts"
    : s.screen === "promptedit" ? "edCancel"
    : s.screen === "newdoc" ? "goDocs"
    : s.screen === "releases" ? "goReleases"
    : s.screen === "platformorg" ? "platGo"
    : "ticketsBack";
  const crumb = s.screen === "repo" ? repoCrumb(repoProps(s)) : child
    ? `<span style="display:inline-flex;align-items:center;gap:10px;min-width:0"><span style="color:var(--fg-40);font-size:13px">›</span><span style="font-size:13px;font-weight:500;color:var(--fg-70);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">${esc(headerCrumb(s))}</span></span>`
    : "";
  const title = child
    ? `<h1 style="font-size:15px;font-weight:600;letter-spacing:-0.01em;margin:0;white-space:nowrap;flex:none"><button data-act="${backAct}" style="font-size:15px;font-weight:600;letter-spacing:-0.01em;padding:0;color:var(--fg-55);cursor:pointer">${titles[s.screen]}</button></h1>`
    : `<h1 style="font-size:15px;font-weight:600;letter-spacing:-0.01em;margin:0">${titles[s.screen]}</h1>`;

  // The Artifacts screens draw their own title + crumbs (a diff has two crumbs).
  const art = isArtScreen(s.screen) ? artifactsHeader(artProps(s, s.screen)) : null;

  // The phone drawer's toggle: always emitted, shown only at phone width (trov.css
  // `.cnpy-menubtn`), where the header also wraps its controls under the title (`.cnpy-hdr`).
  const menuBtn = `<button data-act="openDrawer" class="cnpy-menubtn cnpy-iconbtn" aria-label="Open navigation" aria-expanded="${s.drawer}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg></button>`;

  return `<header class="cnpy-hdr" style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 24px;min-height:57px;border-bottom:1px solid var(--border);flex:none">
    <div class="cnpy-hdr-l" style="display:flex;align-items:center;gap:12px;min-width:0">
      ${menuBtn}${art ? art.title : title}
      ${art ? art.crumb : crumb}
    </div>
    <div class="cnpy-hdr-r" style="display:flex;align-items:center;gap:8px;flex:none">
      ${newControls}${feedControls}${docsControls}${roadmapControls}${queueControls}${myworkControls}${s.screen === "repo" ? repoControls(repoProps(s)) : ""}${art ? art.controls : ""}${platformHeaderControls(s.plat, s.screen)}${feedViewSwitch}${themeBtn}
    </div>
  </header>`;
}

// ── feed ─────────────────────────────────────────────────────────────────────
/** The Feed page: the entries (`inner`) beside the sticky aside — This week + Waiting on
 *  review — in the Roadmap Narrative's two columns (ui.ts `asideColumns`). */
function wrapFeed(s: AppState, inner: string): string {
  return asideColumns(`${inner}
    <div style="text-align:center;padding:18px 0;font-size:11.5px;color:var(--fg-40);font-family:var(--label)">&mdash; start of recorded history &mdash;</div>`, feedAside(s));
}

function feedAside(s: AppState): string {
  return `${feedWeekBox(s)}${feedReviewBox(s)}`;
}

const WEEKDAY_1 = ["S", "M", "T", "W", "T", "F", "S"];
const WEEKDAY_3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A chip in the This week box: it applies the Feed's OWN filter (the Filter menu's
 *  setTag / setAuthor acts); pressing the active one clears that filter. */
function feedStatChip(act: "setTag" | "setAuthor", value: string, active: boolean, label: string, count: number, lead = ""): string {
  const tone = active
    ? "border:1px solid var(--accent);color:var(--accent);background:var(--accent-soft)"
    : "border:1px solid var(--border);color:var(--fg-70)";
  return `<button data-act="${act}" data-arg="${attr(active ? "all" : value)}" aria-pressed="${active}" class="cnpy-issuechip" style="display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 8px;border-radius:6px;font-size:12px;${tone}">${lead}<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap${act === "setTag" ? ";font-family:var(--label)" : ""}">${esc(label)}</span><span style="color:var(--fg-40);font-variant-numeric:tabular-nums">${count}</span></button>`;
}

/**
 * Box 1, "This week": the feed's pulse over the last 7 days — its own server read
 * (`GET /feed/stats`, the whole team, unfiltered, in the viewer's local days), never
 * the Feed's loaded page. A zero day is a true zero (the count covers the whole window),
 * so it is drawn as an empty bar. Tag and author chips apply the Feed's filter.
 */
function feedWeekBox(s: AppState): string {
  const st = s.feedStats;
  const d = st.data;
  const hasWeek = FEED_RANGES.some(([v]) => v === "7d");
  const head = asideHead("This week", hasWeek ? { act: "setRange", arg: "7d", label: "Everything this week" } : undefined);
  const sub = `<div style="font-size:12.5px;color:var(--fg-40);padding:0 18px 10px;margin-top:-4px">Whole team, last 7 days</div>`;
  const wrap = (body: string) => `<section${surface(`${RM_CARD};overflow:hidden`, { cls: "cnpy-rise" })} data-screen-label="Feed · This week">${head}${sub}${body}</section>`;
  if (!d) {
    return wrap(asideNote(st.status === "error" ? "Couldn't load this week's numbers." : "Loading&hellip;"));
  }
  if (d.total === 0) return wrap(asideNote("Nothing recorded in the last 7 days."));

  const max = Math.max(...d.days.map((x) => x.count));
  const bars = d.days.map((x, i) => {
    const at = new Date(`${x.date}T00:00:00Z`);
    const today = i === d.days.length - 1;
    const tip = `${WEEKDAY_3[at.getUTCDay()]} ${at.getUTCDate()} ${MONTH_3[at.getUTCMonth()]} · ${plural(x.count, "entry", "entries")}`;
    const fill = x.count > 0
      ? `<span style="display:block;width:100%;height:${Math.max(8, Math.round((x.count / max) * 100))}%;background:var(--accent);border-radius:2px"></span>`
      : "";
    return `<span title="${attr(tip)}" data-day="${attr(x.date)}" data-n="${x.count}" style="display:flex;flex-direction:column;align-items:stretch;gap:5px;min-width:0">
      <span style="display:flex;align-items:flex-end;height:36px;background:var(--hover);border-radius:2px;overflow:hidden">${fill}</span>
      <span style="text-align:center;font-size:10.5px;line-height:1;color:${today ? "var(--fg-70)" : "var(--fg-40)"};font-weight:${today ? 600 : 400}">${WEEKDAY_1[at.getUTCDay()]}</span>
    </span>`;
  }).join("");
  const chart = `<div role="img" aria-label="${attr(`Entries per day, oldest first: ${d.days.map((x) => x.count).join(", ")}`)}" style="display:grid;grid-template-columns:repeat(${d.days.length},minmax(0,1fr));gap:6px;padding:0 18px 14px">${bars}</div>`;
  const headline = `<div style="display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;padding:0 18px 12px">
    <span style="font-size:24px;font-weight:500;letter-spacing:-0.02em;line-height:1;font-variant-numeric:tabular-nums">${d.total}</span>
    <span style="font-size:13px;color:var(--fg-55)">${d.total === 1 ? "entry" : "entries"} · ${plural(d.people, "person", "people")}</span>
  </div>`;
  const group = (label: string, chips: string) => chips
    ? `<div style="padding:10px 18px 12px;border-top:1px solid var(--border)">
        <div style="font-size:11.5px;font-weight:500;color:var(--fg-40);margin-bottom:7px">${label}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${chips}</div>
      </div>`
    : "";
  const tags = d.topTags.map((t) => feedStatChip("setTag", t.tag, s.feedTag === t.tag, t.tag, t.count)).join("");
  const people = d.topAuthors.map((a) => feedStatChip("setAuthor", a.author, s.feedAuthor === a.author, `@${a.author}`, a.count, personChip(personFor(s, a.author), 16, a.author))).join("");
  return wrap(`${headline}${chart}${group("Top tags", tags)}${group("Most active", people)}`);
}

/**
 * Box 2, "Waiting on review": what sessions staged that no one has confirmed — the
 * Review queue, from the boot-loaded proposals + draft ADR slices, as the cheap no-diff
 * heads (`reviewHeadsFromReads`). Each row opens the Review screen on that item (My
 * Work's `mwOpenReview`). Data on hand wins over a refetch (mwLoad), a failed slice is
 * never papered over as "nothing waiting".
 */
/** How many queued items the Feed's "Waiting on review" box lists (newest first). */
export const FEED_REVIEW_LIMIT = 5;

function feedReviewBox(s: AppState): string {
  const items = reviewHeadsFromReads(s.proposals.data, s.draftAdrs.data);
  const pLoad = mwLoad(s.proposals.status, s.proposals.data.length > 0);
  const aLoad = mwLoad(s.draftAdrs.status, s.draftAdrs.data.length > 0);
  const load: MwLoad = pLoad === "error" || aLoad === "error" ? "error"
    : (pLoad === "ok" && aLoad === "ok") || items.length > 0 ? "ok" : "pending";
  const head = asideHead("Waiting on review", { act: "goReview", label: "Review" });
  const wrap = (body: string) => `<section${surface(`${RM_CARD};overflow:hidden`, { cls: "cnpy-rise" })} data-screen-label="Feed · Waiting on review">${head}${body}</section>`;
  if (load === "error") return wrap(asideNote("Couldn't load the review queue."));
  if (load === "pending") return wrap(asideNote("Loading&hellip;"));
  if (items.length === 0) return wrap(asideNote("Nothing waiting on review."));

  const proposals = items.filter((i) => i.kind === "proposal").length;
  const decisions = items.length - proposals;
  const split = [proposals ? plural(proposals, "proposal") : "", decisions ? plural(decisions, "decision") : ""].filter(Boolean).join(", ");
  const count = `<div style="font-size:13px;color:var(--fg-55);padding:0 18px 10px;margin-top:-2px"><span style="color:var(--fg);font-weight:500;font-variant-numeric:tabular-nums">${items.length}</span> waiting · ${split}</div>`;
  // `hitArea` rows: the proposer's handle opens their person card, the rest the review item.
  const rows = items.slice(0, FEED_REVIEW_LIMIT).map((it) => `<div class="mw-row ${HITBOX}" style="display:block;width:100%;text-align:left;padding:9px 18px;border-top:1px solid var(--border);font-size:13px">
      <span style="display:block;color:var(--fg);font-weight:500;line-height:1.45;overflow-wrap:anywhere">${esc(it.title)}</span>
      <span style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:3px;font-size:12px;color:var(--fg-40)">
        <span style="width:7px;height:7px;border-radius:50%;background:${it.badgeColor};flex:none"></span>
        <span style="color:var(--fg-55)">${it.kind === "decision" ? "Decision" : "Proposal"}</span>
        <span>·</span>${handleLink(personFor(s, it.agent), it.agent, 11.5)}
        <span>·</span><span style="white-space:nowrap">${esc(it.time)}</span>
      </span>
      ${hitArea("mwOpenReview", it.id, it.title)}
    </div>`).join("");
  return wrap(`${count}${rows}`);
}

/** A feed entry's body is agent-written markdown (lists, code, links, bold), so it goes through
 *  `renderMarkdown` — marked + DOMPurify, the same pipeline as a doc or a ticket body — and is
 *  NEVER additionally esc()'d. `.cnpy-feed-body` scales the doc typography down to a card's and
 *  keeps a typed single line break inside a paragraph. The summary is one line: inline-only. */
function feedBody(body: string | null): string {
  if (!body || !body.trim()) return "";
  return `<div class="cnpy-md cnpy-feed-body" style="font-size:13px;color:var(--fg-55);line-height:1.6;margin-top:6px">${renderMarkdown(body)}</div>`;
}

export type FeedView = "reading" | "agents";
export type FeedFilterCat = "author" | "tag" | "range";
export const FEED_FILTER_CATS: readonly FeedFilterCat[] = ["author", "tag", "range"];
const FEED_RANGES: [string, string][] = [["all", "All time"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"]];
const RANGE_MS: Record<string, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000 };

/** Author and tag filter server-side (a refetch); the time range narrows the loaded rows. */
export function feedRows(s: AppState, now = Date.now()): FeedRow[] {
  const span = RANGE_MS[s.feedRange];
  return span ? s.feed.data.filter((e) => now - Date.parse(e.created_at) <= span) : s.feed.data;
}

/** The Feed's Filter menu. Counts only on Time — the one group narrowed client-side,
 *  counted over what the server returned; author/tag counts would lie once filtered. */
function feedFilterMenu(s: AppState): FilterMenuProps {
  const shown = feedRows(s).length;
  const active = (s.feedAuthor !== "all" ? 1 : 0) + (s.feedTag !== "all" ? 1 : 0) + (s.feedRange !== "all" ? 1 : 0);
  const now = Date.now();
  return {
    id: "feed", open: s.feedFilterOpen, opening: s.fmOpening === "feed", cat: s.feedFilterCat, activeCount: active,
    showLabel: `Show ${shown} ${shown === 1 ? "entry" : "entries"}`, clearAct: "feedFilterClear",
    align: "right", ariaLabel: "Filter the feed", standalone: true,
    groups: [
      {
        key: "author", label: "Author", value: s.feedAuthor, none: "all",
        options: [
          { v: "all", l: "Everyone", act: "setAuthor", arg: "all" },
          ...s.feedAuthors.map((a) => ({ v: a, l: `@${a}`, act: "setAuthor", arg: a, lead: personChip(personFor(s, a), 18, a) })),
        ],
      },
      {
        key: "tag", label: "Tag", value: s.feedTag, none: "all",
        options: [["all", "All tags"] as [string, string], ...TAGS.map((t): [string, string] => [t, t])]
          .map(([v, l]) => ({ v, l, act: "setTag", arg: v, mono: v !== "all" })),
      },
      {
        key: "range", label: "Time", value: s.feedRange, none: "all",
        options: FEED_RANGES.map(([v, l]) => ({
          v, l, act: "setRange", arg: v,
          n: RANGE_MS[v] ? s.feed.data.filter((e) => now - Date.parse(e.created_at) <= RANGE_MS[v]).length : s.feed.data.length,
        })),
      },
    ],
  };
}

/** The "For reading" line under the title: the entry's brief, plain text. An entry
 *  written without one (older plugin, not yet backfilled) shows the title alone. */
function feedBrief(brief: string | null): string {
  if (!brief || !brief.trim()) return "";
  return `<div class="cnpy-feed-brief" style="font-size:13.5px;color:var(--fg-70);line-height:1.6;margin-top:5px">${esc(brief)}</div>`;
}

/** A feed entry's `@author`: a link to their person card when the author is a known person. */
function feedAuthorTag(s: AppState, author: string): string {
  return handleLink(personFor(s, author), author);
}

function feedView(s: AppState): string {
  if (s.feed.status === "loading" && s.feed.data.length === 0) return wrapFeed(s, notice("Loading feed&hellip;"));
  if (s.feed.status === "error") return wrapFeed(s, notice("Couldn't load the feed."));

  const cards = feedRows(s).map((e) => {
    const artifacts = feedArtifacts(e.artifacts);
    const artifactRow = artifacts.length
      ? `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin-top:11px;padding-top:11px;border-top:1px solid var(--border)">
          ${artifacts.map((ar) => `<a href="${ar.href}" target="_blank" class="cnpy-issuechip" style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;padding:3px 8px;text-decoration:none;color:var(--fg-70)"><span style="color:var(--fg-40)">${esc(ar.kind)}</span><span style="font-family:var(--label);font-weight:500">${esc(ar.label)}</span></a>`).join("")}
        </div>`
      : "";
    return `<div${surface("padding:16px 18px;margin-bottom:12px", { hover: true })}>
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="margin-top:1px">${personAvatarLink(personFor(s, e.author), e.author, 30)}</div>
        <div style="flex:1;min-width:0">
          <div class="cnpy-md-inline" style="font-size:14px;font-weight:500;line-height:1.5;letter-spacing:-0.005em">${renderMarkdownInline(e.summary)}</div>
          ${s.feedView === "reading" ? feedBrief(e.brief) : feedBody(e.body)}
          <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px">
            <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--fg-55)">${feedAuthorTag(s, e.author)}</div>
            <span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:1px 5px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="16" height="11" rx="2"></rect><path d="M12 8V4M8 13h.01M16 13h.01"></path></svg>agent</span>
            <span style="font-size:12px;color:var(--fg-40)">&middot;</span>
            <span style="font-size:12px;color:var(--fg-40)">${relTime(e.created_at)}</span>
            <div style="flex:1"></div>
          </div>
          ${artifactRow}
        </div>
      </div>
    </div>`;
  }).join("");

  const empty = s.feed.status === "ok" && feedRows(s).length === 0 ? notice("No entries match this filter.") : "";
  return wrapFeed(s, `<div class="cnpy-stagger">${cards}</div>${empty}`);
}

// ── docs ─────────────────────────────────────────────────────────────────────
// Preferred display order for section groups within a space; anything not listed
// falls to the end (alphabetical). Case-insensitive match against doc.section.
const DOC_SECTION_ORDER = [
  "Overview", "Architecture", "AI & Learning Engine", "Engineering Guide", "Decisions",
  "Roadmap", "Brand & Marketing", "reference", "context", "decisions",
];
const sectionRank = (sec: string): number => {
  const i = DOC_SECTION_ORDER.findIndex((x) => x.toLowerCase() === sec.toLowerCase());
  return i < 0 ? DOC_SECTION_ORDER.length : i;
};

// The Docs space toggle is a FIXED two-tab set, in this order — the tabs are NOT
// derived from the data, so a stray/foreign `space` value can never add or change
// a tab. New docs are constrained to these values at the write boundary too.
export const DOC_SPACES = ["technical", "product"] as const;
export const spaceLabel = (k: string): string => (k ? k.charAt(0).toUpperCase() + k.slice(1) : k);

/** First doc of a space in tree display order (section rank, then title) — the
 *  page opened by default when the docs list loads or the space toggles. */
export function firstDocForSpace(docs: DocRow[], space: string): DocRow | undefined {
  return docs
    .filter((d) => d.space === space)
    .sort((a, b) => sectionRank(a.section) - sectionRank(b.section) || a.title.localeCompare(b.title))[0];
}

// One tree row: the page button (opens the doc) with a chevron that toggles its
// in-page outline, plus the outline itself (scroll-to-heading links) when open.
function docTreeRow(s: AppState, doc: DocRow): string {
  const active = doc.slug === s.docSlug;
  const outline = extractOutline(doc.body);
  const open = !!s.docOutlineOpen[doc.slug];
  const chevron = outline.length
    ? `<span class="cnpy-treechev${open ? " is-open" : ""}" data-act="toggleOutline" data-arg="${attr(doc.slug)}" role="button" aria-expanded="${open ? "true" : "false"}" aria-label="Toggle outline"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"></path></svg></span>`
    : `<span class="cnpy-treechev is-empty"></span>`;
  const page = `<button data-act="openDoc" data-arg="${attr(doc.slug)}" class="cnpy-tree${active ? " is-active" : ""}">${chevron}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(doc.title)}</span></button>`;
  const outlineHtml = outline.length
    ? `<div class="cnpy-outline${open ? " is-open" : ""}" data-outline="${attr(doc.slug)}"><div class="cnpy-outline-inner">${outline.map((h) =>
        `<button data-act="scrollToHeading" data-arg="${attr(doc.slug + "::" + h.id)}" class="cnpy-outline-item${h.level >= 3 ? " lvl3" : ""}"><span>${esc(h.text)}</span></button>`).join("")}</div></div>`
    : "";
  return page + outlineHtml;
}

function docsView(s: AppState): string {
  // ── tree (left pane) ────────────────────────────────────────────────────────
  let treeHtml: string;
  if (s.docsList.status === "loading" && s.docsList.data.length === 0) {
    treeHtml = notice("Loading…");
  } else if (s.docsList.status === "error") {
    treeHtml = notice("Couldn't load docs.");
  } else {
    // Filter to the toggled space (Technical | Product), then group by section.
    // Sections are static labels; each page expands to its own headings.
    const spaceDocs = s.docsList.data.filter((d) => d.space === s.docSpace);
    if (spaceDocs.length === 0) {
      treeHtml = notice(`No ${spaceLabel(s.docSpace)} docs yet.`);
    } else {
      const grouped = new Map<string, DocRow[]>();
      for (const doc of spaceDocs) {
        if (!grouped.has(doc.section)) grouped.set(doc.section, []);
        grouped.get(doc.section)!.push(doc);
      }
      const sections = [...grouped.keys()].sort((a, b) => sectionRank(a) - sectionRank(b) || a.localeCompare(b));
      treeHtml = sections.map((sec) => {
        const rows = grouped.get(sec)!.map((doc) => docTreeRow(s, doc)).join("");
        return `<div style="margin-bottom:16px">
        <div class="cnpy-treesec">${esc(sec)}</div>
        <div style="display:flex;flex-direction:column;gap:1px">${rows}</div>
      </div>`;
      }).join("");
    }
  }

  // ── reader (right pane) ─────────────────────────────────────────────────────
  const readerHtml = docReaderHtml(s);

  // Narrow (trov.css `.cnpy-docs`): the page list and the reader take turns; the bar's
  // Pages button swaps them (hidden on a wide screen, where both panes show).
  return `<div class="cnpy-docs" data-tree="${s.docsTree ? "1" : "0"}" style="display:flex;height:100%">
    <div class="cnpy-docs-bar"><button data-act="docsTree" class="cnpy-outlinebtn" aria-expanded="${s.docsTree}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h13"></path></svg>${s.docsTree ? "Back to the page" : `${esc(spaceLabel(s.docSpace))} pages`}</button></div>
    <div class="cnpy-scroll cnpy-docs-tree" style="width:252px;flex:none;border-right:1px solid var(--border);overflow-y:auto;padding:18px 12px">${treeHtml}</div>
    <div id="cnpy-reader" class="cnpy-scroll" style="flex:1;overflow-y:auto;min-width:0">${readerHtml}</div>
  </div>`;
}

/** The reader pane's inner HTML. Extracted so main.ts can load a doc into the
 *  pane in place (updating only #cnpy-reader) without rerendering the tree —
 *  a tree rerender swaps in fresh outline elements and kills their transition. */
export function docReaderHtml(s: AppState): string {
  const dd = s.docDetail;

  if (dd.status === "loading" || (dd.status === "idle" && s.docSlug !== null)) {
    return notice("Loading…");
  } else if (dd.status === "error") {
    return notice("Couldn't load this doc.");
  } else if (dd.data === null) {
    return notice(s.docSlug === null ? "Select a doc from the tree." : "Doc not found.");
  } else if (dd.status === "ok" && dd.data !== null) {
    const { doc, versions } = dd.data;
    const hasStaged = versions.some((v) => v.status === "staged" && v.version > doc.current_version);

    const stagedBanner = hasStaged ? `<div${surface("display:flex;align-items:center;gap:14px;padding:12px 14px;margin-bottom:26px")}>
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:600;font-family:var(--label);letter-spacing:.04em;color:var(--amber);border:1px solid color-mix(in srgb,var(--amber) 45%,transparent);background:color-mix(in srgb,var(--amber) 12%,transparent);border-radius:5px;padding:3px 7px;flex:none">STAGED</span>
      <div style="flex:1;font-size:12.5px;color:var(--fg-70);line-height:1.45">You're viewing the <strong style="font-weight:600;color:var(--fg)">promoted</strong> version. A newer proposal is awaiting review.</div>
      <button data-act="goReview" class="cnpy-link" style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:500;color:var(--accent);white-space:nowrap;flex:none">Review proposal<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"></path></svg></button>
    </div>` : "";

    const history = s.showHistory ? `<div${surface("padding:6px;margin-top:18px")}>
      ${versions.map((v) => `<div style="display:flex;align-items:center;gap:12px;padding:9px 11px;border-radius:7px">
        <span style="font-family:var(--label);font-size:12px;font-weight:600;color:var(--fg);width:26px">v${v.version}</span>
        <span style="flex:1;font-size:12.5px;color:var(--fg-70)">${esc(v.summary ?? "")}</span>
        <span style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--fg-40)">${personLink(personFor(s, v.created_by), v.created_by, 16, { html: handleTag(personFor(s, v.created_by), v.created_by, 11) }, "", 6)} · ${relTime(v.created_at)}</span>
        ${v.version === doc.current_version ? `<span style="font-size:9.5px;font-weight:600;font-family:var(--label);color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);background:var(--accent-soft);border-radius:4px;padding:2px 6px">PROMOTED</span>` : ""}
      </div>`).join("")}
    </div>` : "";

    return `<div class="cnpy-docpage" style="max-width:1080px;margin:0 auto;padding:34px 52px 120px">
    ${stagedBanner}
    <div style="font-family:var(--label);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.11em;color:var(--fg-40);margin-bottom:11px">${esc(spaceLabel(doc.space))} <span style="color:var(--border-strong);margin:0 2px">/</span> ${esc(doc.section)}</div>
    <h1 style="font-size:29px;font-weight:650;letter-spacing:-0.022em;line-height:1.16;margin:0">${esc(doc.title)}</h1>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:15px;padding-bottom:17px;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--fg-55)">
        ${personAvatarLink(doc.updated_by ? personFor(s, doc.updated_by) : null, doc.updated_by ?? "?", 24)}
        <span>Updated by ${doc.updated_by ? handleLink(personFor(s, doc.updated_by), doc.updated_by) : ""} · ${relTime(doc.updated_at)}</span>
      </div>
      <button data-act="toggleHistory" class="cnpy-ghostbtn" style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;color:var(--fg-70);border:1px solid var(--border);border-radius:7px;padding:5px 11px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v6h6"></path><path d="M3.5 9a9 9 0 1 0 2.3-3.3L3 9"></path><path d="M12 8v4l3 2"></path></svg>Version history</button>
    </div>
    ${history}
    <div class="cnpy-md" style="margin-top:28px">${renderMarkdown(doc.body)}</div>
  </div>`;
  }
  return notice("Select a doc from the tree.");
}

// ── roadmap ──────────────────────────────────────────────────────────────────
interface EnrichedSprint {
  id: number; title: string; about: string; github_ref: string | null; phase: string | null;
  closed: number | null; total: number | null; done: boolean; ready: boolean; overdue: boolean;
  pct: number; tgt: number; badge: { label: string; color: string; soft?: boolean };
  dateLabel: string; isNext: boolean;
  /** The GitHub half, straight off `SprintView.issues` — the Narrative spotlight
   *  is the ONLY place it renders, and null means the sprint has no cache row. */
  issues: { closed: number; total: number } | null;
}

function roadmapEnriched(sprints: SprintView[], confirmedSprints: Record<string, boolean>, now: number = Date.now()): { list: EnrichedSprint[]; doneCount: number; overdueCount: number } {
  const fmt = (iso: string) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const badgeFor = (st: string): { label: string; color: string; soft?: boolean } => {
    if (st === "done") return { label: "Done", color: "var(--green)", soft: true };
    if (st === "in_progress") return { label: "In progress", color: "var(--amber)" };
    return { label: "Upcoming", color: "var(--blue)" };
  };

  const enriched = sprints.map((sp) => {
    const confirmed = !!confirmedSprints[String(sp.id)];
    const done = sp.status === "done" || confirmed;
    // SprintView.progress is TICKETS ONLY and always present, reading 0/0 when a
    // sprint holds no tickets — so `total === 0` means no bar, and never "ready
    // to complete". The GitHub issue counts never enter this: a sprint is ready
    // when its own tickets are resolved.
    const counted = sp.progress.total > 0;
    const closed = counted ? sp.progress.closed : null;
    const total = counted ? sp.progress.total : null;
    const ready = !done && counted && sp.progress.closed >= sp.progress.total;
    // An unscheduled sprint (due: null) is never overdue and never "next up".
    // Overdue from the calendar day AFTER the due date — the ONE rule (shared/sprints-core).
    const tgt = sp.due ? new Date(sp.due + "T12:00:00").getTime() : Infinity;
    const overdue = !done && !ready && !!sprintDueState(sp.due, now)?.overdue;
    return {
      id: sp.id, title: sp.label, about: sp.description ?? "", github_ref: sp.github_ref, phase: sp.phase,
      closed, total, done, ready, overdue, pct: counted ? sp.progress.pct : 0, tgt,
      badge: badgeFor(done ? "done" : sp.status), dateLabel: sp.due ? fmt(sp.due) : "No target date",
      isNext: false, issues: sp.issues,
    };
  });

  // THE next sprint — one, never every card not yet running (./sprints `nextSprintId`).
  const nextId = nextSprintId(sprints, confirmedSprints, now);
  enriched.forEach((m) => { m.isNext = m.id === nextId; });

  return {
    list: enriched,
    doneCount: enriched.filter((m) => m.done).length,
    overdueCount: enriched.filter((m) => m.overdue).length,
  };
}

/**
 * The sprint groups on the Roadmap's Narrative tab — In Progress (active) /
 * Upcoming / Done (§C.6). Every card is `sprintCard` from ./sprints — the ONE
 * place a sprint is painted, so the card and the Sprint screen can never drift.
 */
function roadmapSprintGroups(s: AppState): string {
  const sprints = s.roadmap.data.sprints;
  const isDone = (sp: SprintView) => sp.status === "done" || !!s.confirmedSprints[String(sp.id)];

  const inProgress = sprints.filter((sp) => !isDone(sp) && sp.active);
  const upcoming = sprints.filter((sp) => !isDone(sp) && !sp.active);
  const done = sprints.filter(isDone);
  const now = Date.now();
  const nextId = nextSprintId(sprints, s.confirmedSprints, now);

  const sectionHeading = (label: string, color: string): string =>
    `<div style="display:flex;align-items:center;gap:9px;margin:28px 0 12px"><span style="width:7px;height:7px;border-radius:50%;flex:none;background:${color}"></span><span style="font-size:11px;font-weight:600;font-family:var(--label);text-transform:uppercase;letter-spacing:.1em;color:${color}">${label}</span><div style="flex:1;height:1px;background:var(--border)"></div></div>`;

  const renderGroup = (items: SprintView[], heading: string, color: string): string =>
    items.length === 0
      ? ""
      : `${sectionHeading(heading, color)}<div class="cnpy-stagger">${items.map((sp) => sprintCard(sp, s.persons.data, { done: isDone(sp), nextUp: sp.id === nextId, now })).join("")}</div>`;

  return `${renderGroup(inProgress, "In Progress", "var(--amber)")}
    ${renderGroup(upcoming, "Upcoming", "var(--blue)")}
    ${renderGroup(done, "Done", "var(--green)")}`;
}

/**
 * The tab bar heading the Roadmap's page body (tabs.ts): Narrative · Timeline, the
 * Timeline tab carrying a red dot while any sprint is overdue. It opens BOTH tabs in the
 * same page frame (asideColumns' — max-width 1200px, `--cols-pad-top`, 32px sides), so a
 * switch slides the underline instead of moving the bar; the panel follows its line.
 */
function roadmapTabBar(s: AppState): string {
  const { overdueCount } = roadmapEnriched(s.roadmap.data.sprints, s.confirmedSprints);
  return tabBar({
    id: "roadmap-tab", ariaLabel: "Roadmap sections", act: "setRoadmapTab", value: s.roadmapTab,
    tabs: [
      { value: "narrative", label: "Narrative" },
      { value: "timeline", label: "Timeline",
        trail: overdueCount ? `<span style="width:6px;height:6px;border-radius:50%;background:var(--red);margin-left:1px"></span>` : "" },
    ],
  });
}

/**
 * The Roadmap's Timeline tab: the sprints on a calendar (./timeline — a Gantt
 * graph, bars from start to due, filled by ticket progress, a today line), full
 * width in the Roadmap's page frame, under the tab bar. No aside here: Now + Recent
 * happenings belong to the Narrative tab alone.
 */
function roadmapTimelineTab(s: AppState): string {
  return `<div class="cnpy-scroll cnpy-cols-page" style="max-width:1200px;margin:0 auto;padding:var(--cols-pad-top) 32px 80px">
    ${roadmapTabBar(s)}<div${tabPanelAttrs("roadmap-tab", s.roadmapTab)} style="padding-top:20px">${roadmapNewSprint(s)}${roadmapTimeline({
    sprints: s.roadmap.data.sprints, confirmed: s.confirmedSprints, persons: s.persons.data, now: Date.now(),
  })}</div>
  </div>`;
}

function roadmapView(s: AppState): string {
  if (s.roadmap.status === "loading" && s.roadmap.data.sprints.length === 0) {
    return `<div class="cnpy-scroll" style="max-width:820px;margin:0 auto;padding:32px 40px 100px">${notice("Loading roadmap&hellip;")}</div>`;
  }
  if (s.roadmap.status === "error") {
    return `<div class="cnpy-scroll" style="max-width:820px;margin:0 auto;padding:32px 40px 100px">${notice("Couldn't load the roadmap.")}</div>`;
  }
  if (s.roadmapTab === "narrative") return roadmapDigest(s);
  return roadmapTimelineTab(s);
}

/**
 * The ADMIN-AUTHORED plan narrative (written via the update-plan skill), rendered as markdown
 * inside the digest card idiom (label-face "Narrative" label + h1, matching the rest of the app's
 * section chrome). The narrative is the ONLY thing here that goes through markdownFn — it is
 * DB-sourced prose, so it must be sanitized the same way doc bodies are (real callers pass
 * renderMarkdown, i.e. DOMPurify); it is never additionally esc()'d (that would double-encode
 * markdownFn's own escaping/output). Empty narrative → the existing dashed-card empty-state hint.
 */
export function planNarrativeBlock(narrative: string, markdownFn: (body: string) => string): string {
  const body = narrative.trim()
    ? `<div class="cnpy-md">${markdownFn(narrative)}</div>`
    : `<div style="border:1px dashed var(--border-strong);border-radius:10px;padding:16px 18px;color:var(--fg-55);font-size:13.5px;line-height:1.6">No plan narrative yet — write one with the update-plan skill</div>`;
  return `<section${surface(`${RM_CARD};padding:18px 20px`, { cls: "cnpy-rise" })}>
    <div style="font-size:12px;font-weight:500;color:var(--fg-40);margin:0 0 8px">What's happening</div>
    ${body}
  </section>`;
}

/** A Roadmap card's own layout; the look is the shared surface (ui.ts `surface()`). */
const RM_CARD = "min-width:0";

/**
 * The New sprint form, at the top of the main column on BOTH Roadmap tabs. The
 * button that opens it is in the Roadmap header (`roadmapControls`, act
 * `nsToggle`); the panel renders nothing unless `s.nsOpen`. `POST /sprints`
 * creates the sprint unscheduled and inactive, so it lands in Upcoming (and
 * under the Timeline's "Unscheduled" until it gets a due date).
 */
function roadmapNewSprint(s: AppState): string {
  const panel = newSprintPanel({
    open: s.nsOpen, name: s.nsName, start: s.nsStart, desc: s.nsDesc,
    urgency: s.nsUrg, due: s.nsDue, lead: s.nsLead, domain: s.nsDom, error: s.nsError,
  }, s.persons.data);
  // The panel carries its own 14px top margin for sitting under a header row; at
  // the top of the column it is pulled flush and given room below instead.
  return panel ? `<div style="margin:-14px 0 18px">${panel}</div>` : "";
}

/**
 * Roadmap › Narrative, in the design's two columns (ui.ts `asideColumns`, shared with
 * the Feed): the admin narrative, then the sprint groups, on the left; on the right a
 * sticky aside with two boxes — "Now" (the sprint getting the attention, its
 * tickets-only bar and GitHub links) and "Recent happenings" (the live feed, with its
 * GitHub chips). The tab bar heads the page, the columns sit in its panel. The Timeline
 * tab has no aside.
 */
function roadmapDigest(s: AppState): string {
  return asideColumns(`${roadmapNewSprint(s)}${planNarrativeBlock(s.roadmap.data.narrative, renderMarkdown)}${roadmapSprintGroups(s)}`, roadmapAside(s),
    { bar: roadmapTabBar(s), panel: tabPanelAttrs("roadmap-tab", s.roadmapTab) });
}

/** How many feed entries the Roadmap's "Recent happenings" box shows (and main.ts reads). */
export const HAPPENINGS_LIMIT = 4;
/** How many GitHub chips one Recent happenings row shows before a "+N". */
export const HAPPENINGS_CHIP_CAP = 3;

/**
 * The Narrative tab's aside: "Now" (the sprint getting the attention —
 * its tickets-only bar, and the ONE place the cached GitHub issue counts render,
 * beside the chips that link those issues) and "Recent happenings" (the live
 * feed, with its GitHub chips).
 */
function roadmapAside(s: AppState): string {
  const { list } = roadmapEnriched(s.roadmap.data.sprints, s.confirmedSprints);
  const inProgress = list.filter((m) => !m.done && m.badge.label === "In progress");
  // What's "getting the attention" = something actively in progress first; only fall back
  // to the next upcoming goal when nothing is underway.
  const focus = inProgress[0] ?? list.find((m) => m.isNext) ?? list.find((m) => !m.done);

  const nowLabel = `<div style="display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:500;color:var(--fg-40)"><span style="width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none"></span>Now</div>`;
  const now = focus ? (() => {
    const barColor = focus.done ? "var(--green)" : focus.overdue ? "var(--red)" : "var(--accent)";
    const count = focus.total !== null && focus.closed !== null ? ` · ${focus.closed}/${focus.total} closed` : "";
    const bar = focus.total !== null
      ? `<div style="height:4px;border-radius:2px;background:var(--hover);overflow:hidden;margin-top:12px"><div style="height:100%;width:${focus.pct}%;background:${barColor};border-radius:2px"></div></div>`
      : "";
    const chips = sprintRefChips(focus.github_ref);
    // The GitHub half of a sprint lives HERE and nowhere else: the cached issue
    // counts, beside the chips that link the issues themselves. Nothing renders
    // when the sprint has no cache row.
    const issueCount = focus.issues
      ? `<span style="font-size:11.5px;color:var(--fg-55);font-family:var(--label);white-space:nowrap;flex:none">${focus.issues.closed}/${focus.issues.total} issues closed</span>`
      : "";
    return `<section${surface(`${RM_CARD};padding:16px 18px`, { cls: "cnpy-rise" })} data-screen-label="Roadmap · Now">
      ${nowLabel}
      <button data-act="openSprint" data-arg="${focus.id}" class="mw-more" style="display:block;text-align:left;padding:0;font-size:15px;font-weight:500;margin-top:6px;letter-spacing:-0.01em;color:var(--fg)">${esc(focus.title)}</button>
      <div style="font-size:12.5px;color:${focus.overdue ? "var(--red)" : "var(--fg-40)"};margin-top:2px">${esc(focus.dateLabel)}${count}</div>
      ${bar}
      ${focus.about ? `<div class="cnpy-md rm-now-about">${renderMarkdown(focus.about)}</div>` : ""}
      ${chips.length || issueCount ? `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:12px">${chips.map(ghChip).join("")}${issueCount}</div>` : ""}
    </section>`;
  })() : `<section${surface(`${RM_CARD};padding:16px 18px`, { cls: "cnpy-rise" })} data-screen-label="Roadmap · Now">${nowLabel}<div style="font-size:13px;color:var(--fg-40);margin-top:6px">No sprint in progress.</div></section>`;

  // ── Recent happenings (the live feed, with GitHub chips) ──
  // Its OWN unfiltered read (s.roadmapFeed), so a Feed-screen author/tag filter
  // never narrows it, and a failed read says so instead of "no activity".
  const feed = s.roadmapFeed;
  const entries = feed.data.slice(0, HAPPENINGS_LIMIT);
  const rows = entries.map((e) => {
    const chips = feedArtifacts(e.artifacts);
    // At most HAPPENINGS_CHIP_CAP chips, then a quiet "+N" naming the rest — a long
    // chip list wrapped into two or three rows and crammed the box.
    const shown = chips.slice(0, HAPPENINGS_CHIP_CAP);
    const rest = chips.slice(HAPPENINGS_CHIP_CAP);
    const more = rest.length
      ? `<span title="${attr(rest.map((c) => `${c.kind} ${c.label}`).join(", "))}" style="display:inline-flex;align-items:center;font-size:11.5px;color:var(--fg-40);padding:3px 2px">+${rest.length}</span>`
      : "";
    return `<div style="display:grid;grid-template-columns:44px minmax(0,1fr);gap:10px;padding:9px 18px;border-top:1px solid var(--border);font-size:13px">
      <span style="font-size:12px;color:var(--fg-40);padding-top:1px;white-space:nowrap">${relTime(e.created_at).replace(/ ago$/, "")}</span>
      <span style="color:var(--fg-70);line-height:1.5;min-width:0;overflow-wrap:anywhere">${handleLink(personFor(s, e.author), e.author, 11.5)} <span class="cnpy-md-inline">${renderMarkdownInline(e.summary)}</span>${chips.length ? `<span style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${shown.map(ghChip).join("")}${more}</span>` : ""}</span>
    </div>`;
  }).join("");
  const happenings = `<section${surface(`${RM_CARD};overflow:hidden`, { cls: "cnpy-rise" })} data-screen-label="Roadmap · Recent happenings">
    ${asideHead("Recent happenings", { act: "goFeed", label: "Feed" })}
    ${feed.status === "error" ? asideNote("Couldn't load recent activity.")
      : entries.length > 0 ? rows
      : feed.status === "ok" ? asideNote("No recent activity yet.")
      : asideNote("Loading&hellip;")}
  </section>`;

  return `${now}${happenings}`;
}

// ── search ───────────────────────────────────────────────────────────────────
// The ticket icon is the sidebar family's ticket glyph (a stub with a notch),
// drawn at the same 24-viewBox scale as the rest of this map.
const SEARCH_TYPE_ICON: Record<string, string> = { feed: "M4 5h16M4 12h16M4 19h10", doc: "M6 3h7l5 5v13H6z", decision: "M9 12l2 2 4-4", sprint: "M5 3v18M5 4h11l-2 3 2 3H5", artifact: "M3 4h18v16H3zM3 9h18M7 13.5h6M7 16.5h9" };
// The "sprint" type covers the plan narrative + the sprints, so its badge keeps
// reading "Roadmap" — the screen it navigates to.
const SEARCH_TYPE_LABEL: Record<string, string> = { doc: "Doc", feed: "Feed", decision: "Decision", sprint: "Roadmap", artifact: "Artifact" };

// Authority → badge. /search is live-only, so humans normally see LIVE / PENDING;
// the others are mapped for completeness. Reuses the status badge styling.
function authorityBadge(a: Authority): string {
  const map: Record<Authority, { label: string; color: string }> = {
    live: { label: "LIVE", color: "var(--green)" },
    staged_pending: { label: "PENDING", color: "var(--amber)" },
    unpromoted: { label: "UNPROMOTED", color: "var(--amber)" },
    draft: { label: "DRAFT", color: "var(--blue)" },
  };
  const { label, color } = map[a];
  return `<span style="font-size:9.5px;font-weight:600;font-family:var(--label);letter-spacing:.03em;color:${color};border:1px solid color-mix(in srgb,${color} 45%,transparent);background:color-mix(in srgb,${color} 12%,transparent);border-radius:5px;padding:2px 6px;white-space:nowrap">${label}</span>`;
}

function searchTypeBadge(type: string): string {
  const color = type === "decision" ? "var(--blue)" : type === "feed" ? "var(--fg-70)" : "var(--accent)";
  const border = type === "decision" ? "color-mix(in srgb,var(--blue) 45%,transparent)" : type === "feed" ? "var(--border-strong)" : "color-mix(in srgb,var(--accent) 45%,transparent)";
  const label = SEARCH_TYPE_LABEL[type] ?? type;
  const icon = SEARCH_TYPE_ICON[type] ?? SEARCH_TYPE_ICON["doc"];
  return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:600;font-family:var(--label);letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:5px;color:${color};border:1px solid ${border}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="${icon}"></path></svg>${label}</span>`;
}

// Highlight the active query term inside a body of text.
function highlight(text: string, sq: string): string {
  if (!sq) return esc(text);
  const idx = text.toLowerCase().indexOf(sq);
  if (idx < 0) return esc(text);
  const pre = text.slice(0, idx), mid = text.slice(idx, idx + sq.length), post = text.slice(idx + sq.length);
  return `${esc(pre)}<span style="background:var(--accent-soft);color:var(--accent);border-radius:3px;padding:0 3px;font-weight:500">${esc(mid)}</span>${esc(post)}`;
}

// G3: decisions are NOT navigable (no detail route). doc → openDocFrom, feed → goFeed,
// sprint → goRoadmap (the Roadmap screen — sprints have no standalone detail route
// yet, so this navigates to the screen that lists them, same idiom as goFeed).
// There is no ticket case: tickets are NOT in the /search fan-out at all.
function searchOpenAttr(type: string, id: string): string | null {
  if (type === "decision") return null;
  if (type === "feed") return `data-act="goFeed"`;
  if (type === "sprint") return `data-act="goRoadmap"`;
  // An artifact hit's id is its slug → the artifact viewer (#artifacts/<slug>).
  if (type === "artifact") return `data-act="artOpen" data-arg="${attr(id)}"`;
  return `data-act="openDocFrom" data-arg="${attr(id)}"`;
}

function primaryCard(r: QueryPrimary, sq: string): string {
  const preview = r.body.replace(/\s+/g, " ").trim().slice(0, 280);
  const inner = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:9px;flex-wrap:wrap">${searchTypeBadge(r.type)}${authorityBadge(r.authority)}</div>
    <div style="font-size:14.5px;font-weight:500;letter-spacing:-0.01em;margin-bottom:6px">${esc(r.title)}</div>
    <div style="font-size:13px;line-height:1.6;color:var(--fg-55)">${highlight(preview, sq)}${r.body.length > 280 ? "…" : ""}</div>`;
  const act = searchOpenAttr(r.type, r.id);
  return act
    ? `<button ${act}${surface("display:block;width:100%;text-align:left;padding:16px 18px;margin-bottom:10px;cursor:pointer", { hover: true })}>${inner}</button>`
    : `<div${surface("display:block;width:100%;text-align:left;padding:16px 18px;margin-bottom:10px")}>${inner}</div>`;
}

function pointerRow(r: QueryPointer, sq: string): string {
  const inner = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">${searchTypeBadge(r.type)}${authorityBadge(r.authority)}<span style="font-size:13px;font-weight:500;letter-spacing:-0.01em">${esc(r.title)}</span></div>
    <div style="font-size:12.5px;line-height:1.55;color:var(--fg-55)">${highlight(r.snippet, sq)}</div>`;
  const act = searchOpenAttr(r.type, r.id);
  return act
    ? `<button ${act}${surface("display:block;width:100%;text-align:left;padding:11px 14px;margin-bottom:8px;cursor:pointer", { hover: true })}>${inner}</button>`
    : `<div${surface("display:block;width:100%;text-align:left;padding:11px 14px;margin-bottom:8px")}>${inner}</div>`;
}

function searchView(s: AppState): string {
  const result = s.searchResults.data;
  // Client-side filter by type (no refetch — the full set is already fetched).
  const keep = (t: string) => s.searchType === "all" || s.searchType === t;
  const primary = result.primary.filter((r) => keep(r.type));
  const pointers = result.pointers.filter((r) => keep(r.type));

  const sq = (s.searchQuery || "").trim().toLowerCase();

  // No "Tickets" chip: tickets never appear in search results, so a filter for
  // them would only ever show an empty list.
  const typeChips = [["all", "All"], ["doc", "Docs"], ["feed", "Feed"], ["decision", "Decisions"], ["artifact", "Artifacts"]].map(([k, label]) => {
    const sel = s.searchType === k;
    const style = `padding:6px 13px;border-radius:8px;font-size:13px;font-weight:500;border:1px solid ${sel ? "var(--accent)" : "var(--border)"};color:${sel ? "var(--accent)" : "var(--fg-55)"};background:${sel ? "var(--accent-soft)" : "transparent"};transition:all .12s ease`;
    return `<button data-act="setSearchType" data-arg="${k}" style="${style}">${label}</button>`;
  }).join("");

  let body: string;
  if (s.searchResults.status === "loading") {
    body = notice("Searching&hellip;");
  } else if (s.searchResults.status === "ok" && primary.length === 0 && pointers.length === 0) {
    body = notice("No results for that query.");
  } else {
    const primaryBlock = primary.length
      ? `<div class="cnpy-stagger">${primary.map((r) => primaryCard(r, sq)).join("")}</div>`
      : "";
    const pointerBlock = pointers.length
      ? `<div style="margin-top:22px">
           <div style="font-size:11px;font-weight:600;font-family:var(--label);letter-spacing:.06em;text-transform:uppercase;color:var(--fg-40);margin-bottom:10px">More pointers</div>
           ${pointers.map((r) => pointerRow(r, sq)).join("")}
         </div>`
      : "";
    body = `${primaryBlock}${pointerBlock}`;
  }

  const count = primary.length + pointers.length;
  return `<div style="max-width:780px;margin:0 auto;padding:32px 24px 100px">
    <div style="display:flex;align-items:center;gap:11px;border:1px solid var(--border-strong);border-radius:12px;padding:0 16px;height:52px;margin-bottom:18px">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none;color:var(--fg-40)"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path></svg>
      <input data-act="setSearch" data-field="search" value="${attr(s.searchQuery)}" placeholder="Search the store — feed, docs, decisions" style="flex:1;border:none;outline:none;background:transparent;color:var(--fg);font-size:16px" />
      <kbd style="font-family:var(--label);font-size:11px;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:2px 6px">⌘K</kbd>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:7px">${typeChips}</div>
      <span style="font-size:12.5px;color:var(--fg-40);font-family:var(--label)">${count} results</span>
    </div>
    ${body}
  </div>`;
}

// ── get started / guide ──────────────────────────────────────────────────────
function guideView(s: AppState): string {
  // Screenshots are captured per theme (dark/light) by scripts/capture-guide.mjs;
  // pick the variant that matches the viewer's active theme so the figures never clash
  // with the surrounding page.
  const th = resolved(s);
  const gP = "font-size:14.5px;line-height:1.8;color:var(--fg-70);margin:0 0 4px";
  const gH2 = "font-size:22px;font-weight:600;letter-spacing:-0.02em;margin:8px 0 10px";
  const gH3 = "font-size:17px;font-weight:600;letter-spacing:-0.01em;margin:34px 0 10px";
  const gEyebrow = "font-family:var(--label);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.11em;color:var(--fg-40);margin:52px 0 2px";
  const gList = "font-size:14.5px;line-height:1.8;color:var(--fg-70);margin:10px 0 0;padding-left:22px";
  const gStrong = (t: string) => `<strong style="color:var(--fg);font-weight:600">${t}</strong>`;
  const gEm = (t: string) => `<strong style="color:var(--fg-55)">${t}</strong>`;
  const gCode = (t: string) => `<code style="font-family:var(--code);font-size:13px">${t}</code>`;
  // width/height reserve each figure's box (every capture is 2560×1600) so a lazy
  // image loading mid-jump can't push the table-of-contents target down the page.
  // Each figure is a button that opens it in the lightbox (web/src/lightbox.ts),
  // titled and captioned from its own figcaption.
  const gFig = (name: string, cap: string) => `<figure style="margin:18px 0 4px">
      <button data-act="guideZoom" data-arg="${name}" class="cnpy-guide-shot" aria-label="Expand screenshot">
        <img src="/guide/${name}-${th}.png" alt="" loading="lazy" width="2560" height="1600" />
      </button>
      <figcaption style="font-size:12px;color:var(--fg-40);margin-top:8px">${cap}</figcaption>
    </figure>`;
  // The table of contents is built from the headings as they render, so it can
  // never drift from the page: sec() / sub() emit a heading AND record it.
  const toc: { id: string; label: string; subs: { id: string; label: string }[] }[] = [];
  const gid = (t: string) => `guide-${t.toLowerCase().replace(/&amp;/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const sec = (eyebrow: string, title: string, label: string) => {
    const id = gid(label);
    toc.push({ id, label, subs: [] });
    return `<div id="${id}" class="cnpy-guide-anchor" style="${gEyebrow}">${eyebrow}</div>
    <h2 style="${gH2}">${title}</h2>`;
  };
  const sub = (title: string) => {
    const id = gid(`${toc[toc.length - 1]?.label ?? ""} ${title}`);
    toc[toc.length - 1]?.subs.push({ id, label: title });
    return `<h3 id="${id}" class="cnpy-guide-anchor" style="${gH3}">${title}</h3>`;
  };
  const gPre = (body: string) => `<pre style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow-x:auto;margin:12px 0 0"><code style="font-family:var(--code);font-size:12.5px;line-height:1.6;color:var(--fg-70)">${body}</code></pre>`;
  const body = `<div style="flex:1;min-width:0;max-width:860px">
    <h1 id="guide-top" class="cnpy-guide-anchor" style="font-size:30px;font-weight:650;letter-spacing:-0.025em;margin:0 0 14px">Get Started</h1>
    <p style="font-size:16px;line-height:1.8;color:var(--fg-70);margin:0 0 14px">Trov is the team's shared memory: docs, decisions, the roadmap, the ticket queue, and a running record of what shipped, open to people and to their coding agents alike. It has one rule: ${gStrong("agents only ever stage changes, and a person confirms the ones that matter")}. That keeps what Trov says trustworthy no matter how many agents write to it.</p>
    <p style="${gP}">This page takes you from zero to productive in order: sign in, connect your agent, learn the skills, then the everyday workflows and a tour of every screen. Troubleshooting is at the end.</p>

    ${sec("Step 1", "Sign in", "Sign in")}
    <ul style="${gList}">
      <li>${gStrong("Engineers sign in with GitHub.")} You need to be an ${gStrong("active")} member of the ${gStrong("SaplingLearn")} GitHub org, so accept the org invite first. A pending invite is not enough.</li>
      <li>${gStrong("Everyone else signs in with Google")}, once an admin has invited that exact address from ${gStrong("Maintenance › People")}.</li>
      <li>The first time, you pick a ${gStrong("handle")} and a ${gStrong("color")}. The handle starts as your GitHub login, and you can change it later in Settings.</li>
      <li>Want both? ${gStrong("Settings › Account")} links the second provider, and then either one signs you in.</li>
    </ul>

    ${sec("Step 2", "Connect your coding agent", "Connect your agent")}
    <p style="${gP}">Your agent talks to Trov over the ${gStrong("Model Context Protocol")} (MCP). You connect it by signing in to Trov in your browser, once. It acts as you: it sees what you see, and what it writes is recorded as yours.</p>

    ${sub("Claude Code: install the plugin")}
    <p style="${gP}">The plugin wires up the MCP server and installs every skill below. Three steps, the same ones ${gStrong("Settings › MCP access")} shows:</p>
    <ol style="${gList}">
      <li>In Claude Code, install the plugin:
        ${gPre(PLUGIN_INSTALL)}</li>
      <li>Run ${gCode("/mcp")}, pick ${gStrong("trov")} and choose ${gStrong("Authenticate")}.</li>
      <li>Your browser opens Trov: sign in if asked, then click ${gStrong("Allow")}. The connection is listed in ${gStrong("Settings › MCP access")} under ${gStrong("Connected apps")}, where ${gStrong("Revoke")} disconnects it immediately.</li>
    </ol>
    <p style="${gP}">Not using the plugin? Open ${gStrong("Set it up without the plugin")} in ${gStrong("Settings › MCP access")} for the command that adds the server by hand. Run it, then do steps 2 and 3. Don't do both, or you'll have two Trov servers.</p>

    ${sub("Other agents")}
    <p style="${gP}">Any MCP client that can sign in through the browser (OAuth) connects to the same address, ${gCode(esc(mcpEndpoint()))}, and shows up under ${gStrong("Connected apps")} once you approve it. Trov no longer creates access tokens in Settings; a token you already set up (for Codex or CI) keeps working.</p>
    ${gFig("settings", `${gEm("Settings")}: profile, sign-in methods, MCP access, appearance, and email digests.`)}

    ${sec("Step 3", "Learn the skills", "Learn the skills")}
    <p style="${gP}">The plugin's skills are how your agent keeps Trov current. Three of them form a loop you'll use every session, ${gStrong("orient → work → record")}:</p>
    <ul style="${gList}">
      <li>${gStrong("trov")}: the overview. It explains the whole system and every tool. Ask about it when you're unsure where something lives.</li>
      <li>${gStrong("load-context")}: ${gStrong("runs on its own")} before your agent works on an area the team already knows about, and always before it proposes a doc change. It reads what Trov has, checks what's settled and what's only proposed, and at the start of a session shows your My Work and any handoffs waiting for you. It never writes.</li>
      <li>${gStrong("record-session")}: ${gStrong("only when you ask")} ("record this session"). It checks what actually shipped with ${gCode("git")} and ${gCode("gh")}, reads back the docs it touched, and stages one batch of updates: feed entries, doc changes, and decisions. Repeats are dropped, and anything it can't place goes to Maintenance.</li>
    </ul>
    <p style="${gP};margin-top:12px">The rest cover one surface each:</p>
    <ul style="${gList}">
      <li>${gStrong("tickets")} (when you ask): works the ticket queue. It checks the ticket is yours to change, shows a one-line diff, makes one change, and reports the result.</li>
      <li>${gStrong("my-work")}: answers "what's on my plate?" from your My Work.</li>
      <li>${gStrong("handoff")} (when you ask): leaves a handoff for your next session or a teammate.</li>
      <li>${gStrong("prompts")}: finds and fills a prompt from the team's Prompt Library.</li>
      <li>${gStrong("artifacts")}: finds, downloads, and publishes artifacts, and links them to tickets and sprints.</li>
      <li>${gStrong("read-plan")} and ${gStrong("update-plan")} (admins): read the roadmap against what shipped, and push a reshaped plan.</li>
    </ul>

    ${sec("How it works", "Read, propose, confirm", "How it works")}

    ${sub("Reading")}
    <p style="${gP}">The ${gStrong("Docs")} library is split into ${gStrong("Technical")} and ${gStrong("Product")} spaces, each grouped into sections like ${gStrong("Architecture")} and ${gStrong("Decisions")}. Opening a doc expands its heading outline in the tree, and ${gStrong("Version history")} keeps every earlier version. ${gStrong("New doc")} lets you propose one yourself.</p>
    ${gFig("docs", `${gEm("Docs")}: the open doc's outline in the tree, and a banner pointing to a proposal awaiting review.`)}
    <p style="${gP};margin-top:14px">${gStrong("Search")} is the box at the top of the sidebar (${gCode("⌘K")}, or ${gCode("Ctrl K")} on Windows and Linux). Type and pause: a dropdown jumps straight to a ticket, doc, decision, sprint, artifact, prompt, handoff, person, or screen. Press ${gCode("Tab")} for the full ${gStrong("Search")} screen, which ranks docs, decisions, the feed, the roadmap, and artifacts. Both show only settled content. Your agent's ${gCode("query")} tool also sees tickets and pending proposals, each labelled, so it can tell settled context from a draft.</p>
    ${gFig("quicksearch", `${gEm("Search everything")}: matches grouped by type as you type, with a jump to the full results.`)}
    ${gFig("search", `${gEm("Search")}: ranked results across every type, with your query highlighted.`)}

    ${sub("How agent writes are staged")}
    <p style="${gP}">When an agent proposes a doc change or drafts a decision (an ADR), it becomes a ${gStrong("staged")} version. The live doc stays untouched until a person promotes the change. Each proposal is labelled ${gStrong("new")}, ${gStrong("edit")}, or ${gStrong("rewrite")}, and an edit written against an out-of-date version is flagged. Sending the same content twice changes nothing, so re-running a session doesn't pile up noise. Docs can include images too: your agent uploads each image to Trov first and then references it, and a proposal that points at an image that isn't uploaded (or at one elsewhere on the web) is refused. Click any image to see it full size. No agent tool can promote, ratify, or reject anything. Those buttons only exist here, in the web app.</p>

    ${sub("Review: promote, ratify, or reject")}
    <p style="${gP}">${gStrong("Triage › Review")} is one queue for everything awaiting a decision. A doc proposal shows as a diff against the live version (unified, side by side, or rendered). ${gStrong("Promote")} makes it live; ${gStrong("Reject")} sets it aside. A drafted decision shows the proposed record: ${gStrong("Ratify")} or ${gStrong("Reject")} it. Nothing is deleted either way, and the sidebar count shows what's waiting.</p>
    ${gFig("review", `${gEm("Review")}: the queue on the left and the selected proposal's diff on the right.`)}
    <p style="${gP};margin-top:14px">${gStrong("Maintenance")} is occasional housekeeping, and empty is its normal state. ${gStrong("Unplaced")} holds anything an agent couldn't confidently place: route it where it belongs or ${gStrong("Discard")} it. ${gStrong("Identity")} matches unrecognized GitHub logins to people. Admins also see ${gStrong("People")}, for invites and email digest settings.</p>
    ${gFig("maintenance", `${gEm("Maintenance")}: the Unplaced queue, waiting to be routed or discarded.`)}

    ${sec("Tour", "Every screen, top to bottom", "Tour")}
    <p style="${gP}">The sidebar groups screens into ${gStrong("Workspace")}, ${gStrong("Monitor")}, ${gStrong("Knowledge")}, ${gStrong("Triage")}, and ${gStrong("Help")} (this guide and What's new). A chevron opens a screen's sub-pages, ${gStrong("Collapse")} folds the rail to icons, and every screen has its own address (${gCode("#tickets/7")}, ${gCode("#artifacts")}) you can send to a teammate. On a phone the sidebar opens as a drawer.</p>

    ${sub("My Work")}
    <p style="${gP}">Trov opens here. ${gStrong("Tickets for you")}: your open tickets, with their sprint and when it is due. ${gStrong("Needs your review")}: what agents staged, with Promote, Ratify and Reject right there. ${gStrong("Your sessions")}: what you recorded lately and the handoffs waiting for you. ${gStrong("Repo")}: pull requests, CI and deploys at a glance. Under them, the docs you own, artifacts published this week, and handoffs queued for you, each with ${gStrong("Copy")} to paste it into a fresh session as a prompt. It reads only what Trov has already captured, so it loads instantly.</p>
    ${gFig("mywork", `${gEm("My Work")}: your tickets, the review queue, your sessions, and the repo at a glance.`)}

    ${sub("Tickets")}
    <p style="${gP}">The team's request queue. Anyone can file a bug, request, question, or access ask with ${gStrong("Submit a ticket")}. The ${gStrong("Board")} is the default view, one column per status: ${gStrong("Triage")}, ${gStrong("In progress")}, ${gStrong("Testing")}, ${gStrong("Done")}, and ${gStrong("Declined")}. Drag a card to change its status or its place in a column. An open ticket can move to any column, and Testing is optional. ${gStrong("Table")} lists the same tickets grouped by sprint (no sprint means ${gStrong("Backlog")}). Both have a search box and a ${gStrong("Filter")} menu.</p>
    ${gFig("board", `${gEm("Board")}: a column per status, in the order people dragged them.`)}
    ${gFig("tickets", `${gEm("Table")}: the same tickets grouped by sprint.`)}
    <p style="${gP};margin-top:14px">Issues in the product's GitHub repo also show up as tickets, each with a locked link back to its issue. Closing or reopening the issue closes or reopens its ticket; everything else about it is edited in Trov. Apart from that, only a person closes a ticket: a merged PR never does.</p>
    <p style="${gP};margin-top:14px">A ticket's page holds its thread (comments with ${gCode("@mentions")}, next to every status change), its assignees and sprint, one level of sub-tickets, and ${gStrong("Linked work")}: paste a GitHub or Figma URL, or a bare ${gCode("#123")}. Artifacts linked to the ticket show here too. Your agent can file tickets, and on tickets ${gStrong("assigned to you")} it can move status, comment, link, set the sprint, or nest. It can't change who a ticket is assigned to.</p>
    ${gFig("ticket", `${gEm("A ticket")}: description, linked work, and thread, with status, assignees, and sprint alongside.`)}

    ${sub("Roadmap and sprints")}
    <p style="${gP}">${gStrong("Narrative")} reads the plan and its sprint cards, beside what's in progress now and the latest from the feed. ${gStrong("Timeline")} puts the sprints on a calendar: each bar runs from a sprint's start to its due date, overdue ones are marked, and a click opens it. ${gStrong("New sprint")} is in the header. Each sprint shows its urgency, due date, domain, lead, and a progress bar that counts that sprint's tickets closed (done or declined) out of its total, plus any GitHub issues it tracks. A sprint's own page lists its tickets, assignees, and resources. When everything in it is closed, the page offers to complete it. That's always a person's call. ${gStrong("Delete sprint")} sends its tickets back to the backlog.</p>
    ${gFig("roadmap", `${gEm("Roadmap › Narrative")}: the plan and its sprints, with what's happening now alongside.`)}
    ${gFig("timeline", `${gEm("Roadmap › Timeline")}: sprints on the calendar, filled by their done tickets.`)}
    ${gFig("sprint", `${gEm("A sprint")}: its tickets, progress, properties, assignees, and resources.`)}

    ${sub("Handoffs")}
    <p style="${gP}">A handoff is a note from one session to the next: the task, what's done, what's next, the files that matter, and optionally a ready-to-run prompt. Your agent leaves one with the ${gStrong("handoff")} skill, addressed to you, a teammate, or anyone. At the start of your next session, load-context lists the ones waiting and claims only the one you pick. Unclaimed handoffs expire after 7 days. The sidebar count is what's waiting for you.</p>
    ${gFig("handoffs", `${gEm("Handoffs")}: pending ones first, then claimed and expired history.`)}

    ${sub("Repo")}
    <p style="${gP}">A dashboard over the product repo in five tabs: ${gStrong("Overview")} (each environment's deploys, checks, health, and drift), ${gStrong("Code")}, ${gStrong("CI &amp; Deploys")}, ${gStrong("Usage")}, and ${gStrong("Team &amp; Planning")}. It reads only what Trov has captured from the GitHub webhook and scheduled polls. A section with nothing yet reads ${gStrong("not connected")} and names what it's waiting on, never a made-up zero. ${gStrong("Preview with sample data")} shows the full layout with labelled placeholder numbers. Admins also get ${gStrong("Poll now")}.</p>
    ${gFig("repo", `${gEm("Repo › Overview")} (sample data): both environments with deploys, checks, and health.`)}
    ${gFig("repo-usage", `${gEm("Repo › Usage")} (sample data): traffic, errors, active users, and product metrics.`)}

    ${sub("Feed")}
    <p style="${gP}">A timeline of everything that shipped, from people and agents alike. ${gStrong("For reading")} (the default) shows each entry's title and a short brief in plain words; ${gStrong("For agents")} shows the full record. Each entry links to its PR, commit, or issue and says whether an agent wrote it. Alongside: this week's activity and what's waiting on review. ${gStrong("Filter")} by author, tag, or time.</p>
    ${gFig("feed", `${gEm("Feed")}: every change with its brief and its PR, commit, and issue links.`)}

    ${sub("Artifacts")}
    <p style="${gP}">An artifact is a page an agent or person made: an HTML design, a markdown report, an SVG or mermaid diagram, an image, a PDF, or a file. Trov stores every version and links it to the ticket or sprint it came from. ${gStrong("New artifact")} takes pasted source, an upload, or a URL. A new artifact starts as a ${gStrong("draft")}; ${gStrong("Published")} shares it; ${gStrong("Ratify")} is a person's sign-off on the latest version, and only a person can give it. ${gStrong("Compare versions")} diffs any two. Flip its ${gStrong("Org")} switch to ${gStrong("Private")} to keep one to yourself.</p>
    ${gFig("artifacts", `${gEm("Artifacts")}: every page with a live preview, its author, and its area.`)}
    ${gFig("artifact", `${gEm("An artifact")}: the latest version, ratified, with its status and version picker.`)}

    ${sub("Prompt Library")}
    <p style="${gP}">The team's reusable prompts, each with a slug, tags, and ${gCode("{{variables}}")} for the parts that change. Every save is a new version. When your agent saves one, it lands as ${gStrong("staged")}, and a person publishes it from the prompt's page. The sidebar count is the staged ones. Ask your agent to "run the ${gCode("&lt;slug&gt;")} prompt" and the ${gStrong("prompts")} skill fills it in, asking you for anything it can't fill.</p>
    ${gFig("prompts", `${gEm("Prompt Library")}: published, staged, and draft prompts with their tags and versions.`)}

    ${sub("Settings")}
    <p style="${gP}">Click your name at the bottom of the sidebar. ${gStrong("Profile")} sets your name, handle, and color. ${gStrong("Account")} links GitHub and Google. ${gStrong("MCP access")} is where agents connect: the browser sign-in steps and the apps you have connected. ${gStrong("Appearance")} switches between Light, Dark, and System. ${gStrong("Email notifications")} sets each digest (your work, the review queue, roadmap changes, the ticket queue) to daily, weekly, or off.</p>

    ${sub("What's new")}
    <p style="${gP}">Every release of Trov, newest first. Open one for its notes, or switch to ${gStrong("Patch notes")} for the full list of changes with links to the pull requests.</p>
    ${gFig("releases", `${gEm("What's new")}: one card per release.`)}

    ${sec("Troubleshooting", "When something doesn't work", "Troubleshooting")}
    <ul style="${gList}">
      <li>${gStrong("GitHub sign-in says you're not a member.")} Accept the SaplingLearn org invite on GitHub, then sign in again.</li>
      <li>${gStrong("Google sign-in says you're not invited.")} Ask an admin to invite the exact address you signed in with.</li>
      <li>${gStrong("Trov shows as needing authentication in Claude Code.")} Run ${gCode("/mcp")}, pick ${gStrong("trov")} and choose ${gStrong("Authenticate")}. If the browser says Trov doesn't recognise the app, choose ${gStrong("Clear authentication")} first, then Authenticate again. A connection you revoked in Settings needs the same.</li>
      <li>${gStrong("An agent set up with an older access token (Codex, CI) gets 401 Unauthorized.")} The token is missing, mistyped, or revoked. Check that ${gCode("echo $TROV_MCP_TOKEN")} prints it in the terminal you launch the agent from; if you set it in one shell's profile (say ${gCode("~/.zshrc")}) but run another (say fish), that shell never sees it. Settings no longer creates tokens, so if the agent can sign in through the browser, reconnect it that way instead.</li>
      <li>${gStrong("The Trov server doesn't appear in /mcp.")} Restart Claude Code after installing the plugin. Run ${gCode("/plugin")} to check that ${gCode("trov")} is installed and enabled.</li>
      <li>${gStrong("The plugin is out of date.")} Run ${gCode("/plugin marketplace update trov")}, then restart.</li>
      <li>${gStrong("Your agent sees every tool twice.")} It's connected both through the plugin and through a manual setup. Remove one: ${gCode("claude mcp remove trov")} drops the manual one.</li>
      <li>${gStrong("Your agent can't change a ticket.")} Agents can only change tickets assigned to you. Assign yourself in the web app first.</li>
      <li>${gStrong("An agent's change isn't live.")} That's by design: it's waiting in ${gStrong("Review")} for a person to promote it.</li>
      <li>${gStrong("A Repo section reads not connected.")} Nothing has been captured for it yet. The section names what it's waiting on.</li>
    </ul>
  </div>`;
  // Buttons, not #anchors: the hash is the route (guideJump scrolls in place).
  const item = (id: string, label: string, cls: string) =>
    `<button data-act="guideJump" data-arg="${id}" class="${cls}"><span>${label}</span></button>`;
  const rail = `<nav class="cnpy-guide-toc" aria-label="On this page">
      <div class="cnpy-guide-toc-h">On this page</div>
      ${item("guide-top", "Introduction", "cnpy-guide-toc-sec")}
      ${toc.map((t) => `${item(t.id, t.label, "cnpy-guide-toc-sec")}${t.subs.length ? `<div class="cnpy-guide-toc-subs">${t.subs.map((x) => item(x.id, x.label, "cnpy-outline-item")).join("")}</div>` : ""}`).join("")}
    </nav>`;
  return `<div class="cnpy-guide" style="display:flex;gap:56px;max-width:1180px;margin:0 auto;padding:52px 40px 120px;align-items:flex-start">
    ${rail}
    ${body}
  </div>`;
}

// ── settings ─────────────────────────────────────────────────────────────────
const SECTION_LABEL = "font-size:11px;font-weight:600;font-family:var(--label);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40);margin-bottom:14px";

/** Handle-check status wording, shared with onboarding's STATUS map (people.ts) —
 *  "same" (draft equals the current handle) and "idle" both render blank. */
function handleStatusText(check: AppState["handleCheck"]): { text: string; color: string } {
  switch (check) {
    case "checking": return { text: "checking…", color: "var(--fg-40)" };
    case "available": return { text: "available", color: "var(--green)" };
    case "invalid": return { text: "invalid", color: "var(--red)" };
    case "reserved": return { text: "reserved", color: "var(--red)" };
    case "taken": return { text: "taken", color: "var(--red)" };
    default: return { text: "", color: "var(--fg-40)" }; // idle, same
  }
}


/** An uploaded photo (served by the Worker at `/avatar/<sha>`) — not the provider's picture. */
export const isUploadedAvatar = (url: string | null | undefined): boolean => !!url && url.startsWith("/avatar/");

/** Settings › Profile: photo, display name, handle and color (role is admin-set in Maintenance › People).
 *  Pure over AppState — exported for the pure render test. */
export function profileSection(s: AppState): string {
  const me = s.me;
  const handle = me?.handle ?? "";
  const handleRow = s.handleEdit ? (() => {
    const st = handleStatusText(s.handleCheck);
    const canSave = s.handleCheck === "available" && s.handleDraft.trim().toLowerCase() !== handle.toLowerCase();
    return `<div style="margin-top:8px">
      <div style="display:flex;align-items:center;border:1px solid var(--border-strong);border-radius:9px;background:var(--bg);overflow:hidden;max-width:280px">
        <span style="font-family:var(--sans);font-size:13px;color:var(--fg-40);padding-left:10px">@</span>
        <input data-act="handleDraft" data-field="handleDraft" value="${attr(s.handleDraft)}" autocomplete="off" spellcheck="false" maxlength="24" class="cnpy-input" style="flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--fg);font-size:13px;padding:9px 4px;font-family:var(--sans)" />
        <span style="font-family:var(--label);font-size:11px;padding:0 10px;white-space:nowrap;color:${st.color}">${esc(st.text)}</span>
      </div>
      <div style="font-size:11.5px;color:var(--fg-40);margin-top:8px;line-height:1.5">Every entry you've written is re-attributed to the new handle. Links to the old one stop working.</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button data-act="handleSave" class="cnpy-accentbtn" ${canSave ? "" : "disabled "}style="padding:0 14px;height:32px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;${canSave ? "" : "opacity:.45;cursor:default"}">Save</button>
        <button data-act="handleCancel" class="cnpy-ghostbtn" style="padding:0 14px;height:32px;border-radius:8px;border:1px solid var(--border);font-size:12.5px;color:var(--fg-55)">Cancel</button>
      </div>
    </div>`;
  })() : `<div style="font-size:12px;color:var(--fg-40);margin-top:8px">Handle ${me ? handleTag({ handle, color: me.color }, handle, 12) : handleTag(null, handle, 12)} <button data-act="handleEdit" class="cnpy-mutelink" style="font-size:11.5px;color:var(--fg-55);text-decoration:underline;text-underline-offset:2px;margin-left:6px">Change</button></div>`;
  // The avatar spans the label + the 40px field exactly: 16px line + 8px gap + 40px = 64px.
  const FIELD_LABEL = "display:block;font-size:13px;line-height:16px;font-weight:500;margin-bottom:8px";
  // The photo: the avatar IS the control. It opens a small menu — Upload (Change, over an
  // uploaded one), Remove only over an UPLOADED one, and the accepted types as a footnote —
  // over a hidden file input (main.ts downsizes the pick to a 512px square before it is
  // sent). A veil with a camera says so on hover / focus / while open; while a write is in
  // flight a spinner sits in its place and the menu won't open (aria-disabled, so the
  // button keeps its focus — the reducer ignores the click).
  const busy = s.avatarBusy;
  const uploaded = isUploadedAvatar(me?.avatar_url);
  const open = s.avatarMenu && !busy;
  const row = "display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap";
  const menu = open ? `<div data-act="avatarMenuClose" style="position:fixed;inset:0;z-index:29"></div>
      <div role="menu" aria-label="Profile photo" data-avatar-menu class="cnpy-avmenu" style="position:absolute;top:calc(100% + 6px);left:0;z-index:30;width:212px;background:var(--bg);border:1px solid var(--border-strong);border-radius:11px;padding:5px;box-shadow:0 14px 38px rgba(0,0,0,.38)">
        <button role="menuitem" data-act="avatarPick" class="cnpy-menurow" style="${row};color:var(--fg-70)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m17 8-5-5-5 5"></path><path d="M12 3v12"></path></svg>${uploaded ? "Change photo" : "Upload photo"}</button>
        ${uploaded ? `<button role="menuitem" data-act="avatarRemove" class="cnpy-menurow" style="${row};color:var(--red)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"></path></svg>Remove photo</button>` : ""}
        <div style="height:1px;background:var(--border);margin:5px 4px"></div>
        <div style="padding:4px 10px 5px;font-size:11px;line-height:1.45;color:var(--fg-40)">Square crop · PNG, JPEG, WebP, GIF</div>
      </div>` : "";
  const camera = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"></path><circle cx="12" cy="13" r="3"></circle></svg>`;
  const spinner = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true" style="animation:cnpy-spin .8s linear infinite"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"></path></svg>`;
  const label = busy === "upload" ? "Uploading photo…" : busy === "remove" ? "Removing photo…" : "Profile photo options";
  const photo = `<div style="position:relative;flex:none">
      <input type="file" data-avatar-file accept="${attr(AVATAR_TYPES.join(","))}" hidden tabindex="-1" aria-hidden="true" />
      <button data-act="avatarMenu" class="cnpy-avbtn${busy ? " is-busy" : ""}" aria-label="${label}" aria-haspopup="menu" aria-expanded="${open ? "true" : "false"}"${busy ? ' aria-disabled="true" aria-busy="true"' : ""} style="position:relative;display:block;padding:0;border-radius:50%;overflow:hidden">
        ${personChip(me ? { handle, name: s.displayName || me.name, color: me.color, avatar_url: me.avatar_url } : null, 64, handle || "?")}
        <span class="cnpy-avbtn-veil" aria-hidden="true">${busy ? spinner : camera}</span>
      </button>
      <span class="cnpy-avbtn-badge" aria-hidden="true" style="border-radius:50%"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"></path><circle cx="12" cy="13" r="3"></circle></svg></span>
      ${menu}
    </div>`;
  return `<section class="cnpy-tile cnpy-surface">
    <div style="${SECTION_LABEL}">Profile</div>
    <div style="display:flex;align-items:flex-start;gap:14px">
      ${photo}
      <div style="flex:1;min-width:0">
        <label style="${FIELD_LABEL}">Display name</label>
        <div style="display:flex;gap:10px">
          <input data-act="setDisplayName" data-field="displayName" value="${attr(s.displayName)}" class="cnpy-input" style="flex:1;min-width:0;height:40px;padding:0 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:14px;outline:none" />
          <button data-act="saveProfile" class="cnpy-accentbtn" style="padding:0 16px;height:40px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:13.5px;font-weight:600">Save</button>
        </div>
        ${handleRow}
      </div>
    </div>
    <div class="cnpy-tile-foot" style="padding-top:20px"><label style="${FIELD_LABEL}">Your color</label>${swatches("setMyColor", me?.color ?? "stone", true)}</div>
  </section>`;
}

/** Settings › Account: who you are signed in as (no avatar — Profile, beside it, already
 *  shows it), Sign out, and — pinned to the tile's foot, so a stretched tile reads as
 *  top and bottom rather than a gap under its content — the sign-in methods
 *  (link/unlink per provider — the last identity can't be unlinked).
 *  Pure over AppState — exported for the pure render test. */
export function accountSection(s: AppState): string {
  const me = s.me;
  const last = (me?.identities.length ?? 0) <= 1;
  const viaGithub = me?.identities.some((i) => i.provider === "github") ?? false;
  const provRow = (p: "github" | "google", label: string) => {
    const id = me?.identities.find((i) => i.provider === p);
    const btn = id
      ? `<button data-act="unlinkProvider" data-arg="${p}" class="cnpy-ghostbtn" ${last ? "disabled " : ""}style="font-size:12px;color:var(--fg-40);padding:4px 10px;border-radius:6px;border:1px solid var(--border);${last ? "opacity:.45;cursor:default" : ""}">Unlink</button>`
      : `<button data-act="linkProvider" data-arg="${p}" class="cnpy-ghostbtn" style="font-size:12px;color:var(--fg-70);padding:4px 10px;border-radius:6px;border:1px solid var(--border-strong)">Link ${label}</button>`;
    return `<div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--border)"><div style="line-height:1.25"><b style="font-size:13.5px;font-weight:600;display:block">${label}</b><span style="font-family:var(--label);font-size:11.5px;color:${id ? "var(--fg-55)" : "var(--fg-40)"}">${id ? esc(id.label) : "not linked"}</span></div>${btn}</div>`;
  };
  return `<section class="cnpy-tile cnpy-surface">
    <div style="${SECTION_LABEL}">Account</div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div style="min-width:0">
        <div style="font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Signed in as ${me ? handleLink({ handle: me.handle, name: me.name, color: me.color }, me.handle, 13) : ""}</div>
        <div style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--green);margin-top:4px"><span style="flex:none;width:6px;height:6px;border-radius:50%;background:var(--green)"></span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${viaGithub ? `Member of <b>${esc(me?.org ?? "")}</b>` : "Signed in with Google"}</span></div>
      </div>
      <button data-act="signOut" class="cnpy-signout" style="flex:none;padding:7px 13px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500">Sign out</button>
    </div>
    <div class="cnpy-tile-foot" style="padding-top:18px">
      <div style="font-size:13px;font-weight:500;margin-bottom:8px">Sign-in methods <span style="font-weight:400;color:var(--fg-40)">· keep one linked</span></div>
      ${provRow("github", "GitHub")}${provRow("google", "Google")}
    </div>
  </section>`;
}

/** This Trov's own MCP endpoint — the origin the SPA is served from, so a local
 *  `wrangler dev` hands out a local URL and prod hands out prod's. */
const mcpEndpoint = (): string =>
  `${typeof location !== "undefined" && location.origin ? location.origin : "https://canopy.saplinglearn.com"}/mcp`;

/** The two Claude Code commands that install the Trov plugin — Settings › MCP access
 *  and the Get Started guide both show exactly this. */
export const PLUGIN_INSTALL = `/plugin marketplace add AndresL230/trov
/plugin install trov@trov`;

/** How many Connected apps rows Settings › MCP access shows before its "Show all N". */
export const MCP_LIST_CAP = 3;

/** Settings › MCP access › Connected apps: a heading with its count, then one hairline row
 *  per OAuth connection — the app's self-reported name, when it connected and was last
 *  used, and a two-click Revoke — the first MCP_LIST_CAP until "Show all"; or one quiet
 *  line while it loads, when it is empty and when the read failed. No fixed height and no
 *  inner scroller: the list is as tall as what it shows, and "Show all" is how it grows. */
export function grantListBody(s: Pick<AppState, "grants" | "grantRevokeArm"> & Partial<Pick<AppState, "grantsAll">>): string {
  const g = s.grants;
  const n = g.status === "error" ? 0 : g.data.length;
  const count = n ? `<span style="flex:none;font-family:var(--label);font-size:11px;line-height:17px;color:var(--fg-55);background:var(--hover);border-radius:999px;padding:0 7px">${n}</span>` : "";
  const head = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="font-size:13px;font-weight:600">Connected apps</span>${count}</div>`;
  const wrap = (inner: string) => `<div class="cnpy-mcp-list" data-list="grants">${head}${inner}</div>`;
  if (!n) {
    const note = g.status === "error" ? `Couldn't load connected apps${g.error ? ` &mdash; ${esc(g.error)}` : ""}.`
      : g.status !== "ok" ? "Loading connected apps&hellip;"
      : "No apps connected yet. Once you approve Claude Code in the browser, it shows up here.";
    return wrap(`<div style="padding:10px 0;border-top:1px solid var(--border);font-size:12.5px;line-height:1.5;color:var(--fg-40)">${note}</div>`);
  }
  const btn = "flex:none;padding:4px 10px;border-radius:6px;font-size:12px";
  const all = !!s.grantsAll;
  const rows = (all ? g.data : g.data.slice(0, MCP_LIST_CAP)).map((gr) => {
    const armed = s.grantRevokeArm === gr.id;
    const actions = armed
      ? `<button data-act="revokeGrant" data-arg="${gr.id}" class="cnpy-revoke" style="${btn};font-weight:600;color:var(--red);border:1px solid var(--red)">Disconnect</button>
         <button data-act="revokeGrantCancel" class="cnpy-ghostbtn" style="${btn};color:var(--fg-55);border:1px solid var(--border)">Keep</button>`
      : `<button data-act="revokeGrantArm" data-arg="${gr.id}" class="cnpy-revoke" style="${btn};color:var(--fg-55);border:1px solid var(--border)">Revoke</button>`;
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--border)">
      <div style="flex:1;min-width:0;line-height:1.35">
        <span style="display:block;font-size:13px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(gr.client_name)}</span>
        <span style="display:block;font-size:11.5px;color:var(--fg-40)">${armed ? "The app is signed out the moment you disconnect it." : `Connected ${esc(relTime(gr.created_at))} &middot; ${gr.last_used_at ? `last used ${esc(relTime(gr.last_used_at))}` : "never used"}`}</span>
      </div>
      ${actions}
    </div>`;
  }).join("");
  const more = n > MCP_LIST_CAP
    ? `<button data-act="mcpShowAll" aria-expanded="${all}" class="cnpy-mutelink" style="display:block;width:100%;text-align:left;padding:9px 0 1px;border-top:1px solid var(--border);font-size:12px;font-weight:500;color:var(--fg-55)">${all ? "Show fewer" : `Show all ${n}`}</button>`
    : "";
  return wrap(rows + more);
}

/** The by-hand setup: the server with no header — Claude Code then signs in through the
 *  browser on `/mcp` → Authenticate, exactly as the plugin does. Mints nothing. */
export function browserConnectCommand(url: string = mcpEndpoint()): string {
  return `claude mcp add --transport http --scope user trov ${url}`;
}

const mcpCode = (t: string) => `<code style="font-family:var(--code);font-size:11.5px;color:var(--fg)">${t}</code>`;
const mcpStrong = (t: string) => `<strong style="font-weight:600;color:var(--fg)">${t}</strong>`;
/** A command with a small Copy icon in its corner, so the text keeps the box's full width —
 *  the MCP tile's install commands and the by-hand setup modal's `claude mcp add`. */
function copyBox(text: string, act: string, label: string): string {
  return `<div style="position:relative;margin-top:7px;background:var(--hover);border:1px solid var(--border);border-radius:8px;padding:7px 36px 7px 11px">
        <pre style="margin:0;font-family:var(--code);font-size:11.5px;line-height:1.6;color:var(--fg);white-space:pre-wrap;overflow-wrap:anywhere">${esc(text)}</pre>
        <button data-act="${act}" class="cnpy-copybtn" title="Copy" aria-label="${label}" style="position:absolute;top:5px;right:5px;display:grid;place-items:center;width:26px;height:26px;border-radius:6px;border:1px solid var(--border-strong);background:var(--bg);color:var(--fg-55)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg></button>
      </div>`;
}

/**
 * Settings › MCP access — OAuth only: Trov no longer mints tokens here (the token routes
 * stay, so a token already in use keeps working). Beside the heading, a quiet link to the
 * by-hand `claude mcp add` for anyone not using the plugin — it opens a MODAL
 * (`mcpSetupModal`), so using it never changes the tile's height. Then, top to bottom: what
 * it is in one line; the browser sign-in as three numbered steps (install the plugin,
 * `/mcp` → Authenticate, approve in the browser); Connected apps, where that sign-in lands.
 * Pure over AppState — exported for the pure render test.
 */
export function mcpAccessSection(s: Pick<AppState, "grants" | "grantRevokeArm" | "grantsAll">): string {
  // The steps read in order on their own — no number badges (the owner's call, 2026-09-27).
  const step = (body: string) => `<li style="min-width:0;font-size:13px;line-height:1.55;color:var(--fg-70)">${body}</li>`;
  return `<section class="cnpy-tile cnpy-surface cnpy-set-mcp">
    <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;column-gap:12px;row-gap:2px;margin-bottom:14px">
      <div style="${SECTION_LABEL};margin-bottom:0">MCP access</div>
      <button data-act="mcpSetupOpen" data-mcp-setup-trigger aria-haspopup="dialog" class="cnpy-mutelink" style="padding:0;font-size:12px;font-weight:500;color:var(--fg-55)">Set it up without the plugin &rarr;</button>
    </div>
    <div style="font-size:13px;line-height:1.5;color:var(--fg-55)">Sign Claude Code in with your browser; it acts as you.</div>
    <div class="cnpy-mcp-body">
      <ol aria-label="Connect Claude Code" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px;min-width:0">
        ${step(`Install the Trov plugin in Claude Code:${copyBox(PLUGIN_INSTALL, "copyPluginInstall", "Copy the install commands")}`)}
        ${step(`Run ${mcpCode("/mcp")}, choose ${mcpStrong("trov")}, then ${mcpStrong("Authenticate")}.`)}
        ${step(`Your browser opens Trov. Click ${mcpStrong("Allow")} and you're connected &mdash; it shows up under Connected apps.`)}
      </ol>
      ${grantListBody(s)}
    </div>
  </section>`;
}

/** Settings › MCP access's by-hand setup, as a modal in the confirmation modal's shell
 *  (`.cnpy-cmodal` — a dimmed backdrop, a centered card, a bottom sheet at phone width),
 *  rendered at the app ROOT as a `data-overlay` so morph keeps it across rerenders. The
 *  backdrop, the × and Escape close it. Exported for the pure render test. */
export function mcpSetupModal(url: string = mcpEndpoint()): string {
  const close = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;
  return `<div data-overlay="mcp-setup" class="cnpy-cmodal">
    <div data-act="mcpSetupClose" class="cnpy-cmodal-back" aria-hidden="true"></div>
    <div class="cnpy-cmodal-wrap">
      <div id="mcp-setup" role="dialog" aria-modal="true" aria-labelledby="mcp-setup-t" aria-describedby="mcp-setup-d" tabindex="-1" data-mcp-setup class="cnpy-surface cnpy-cmodal-box" style="position:relative;width:min(480px, 100%)">
        <button data-act="mcpSetupClose" aria-label="Close" title="Close" class="cnpy-iconbtn" style="position:absolute;top:12px;right:12px;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;color:var(--fg-40)">${close}</button>
        <div id="mcp-setup-t" style="padding-right:32px;font-size:16px;font-weight:600;letter-spacing:-0.01em">Set it up without the plugin</div>
        <p id="mcp-setup-d" style="margin:6px 0 0;font-size:13px;line-height:1.55;color:var(--fg-55)">Add the Trov server to Claude Code by hand &mdash; skip this if you installed the plugin, or you'll have two Trov servers.</p>
        ${copyBox(browserConnectCommand(url), "copyBrowserConnect", "Copy the command")}
        <p style="margin:12px 0 0;font-size:13px;line-height:1.55;color:var(--fg-70)">Then run ${mcpCode("/mcp")}, choose ${mcpStrong("trov")}, then ${mcpStrong("Authenticate")}, and click ${mcpStrong("Allow")} in the browser.</p>
      </div>
    </div>
  </div>`;
}
function settingsView(s: AppState): string {
  const themeCards = [
    ["light", "Light"],
    ["dark", "Dark"],
    ["system", "System"],
  ].map(([k, label]) => {
    const sel = s.theme === k;
    // Layout (flex, gap, padding, the narrow stacked form) is trov.css's `.cnpy-themecard`,
    // so its container query can restack it; only the radius and the picked colours are inline.
    const style = `border-radius:11px;border:1px solid ${sel ? "var(--accent)" : "var(--border)"};background:${sel ? "var(--accent-soft)" : "transparent"};color:${sel ? "var(--accent)" : "var(--fg-70)"}`;
    const icon = k === "light"
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"></path></svg>`
      : k === "dark"
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>`;
    return `<button data-act="setTheme" data-arg="${k}" class="cnpy-themecard" aria-pressed="${sel}" style="${style}">${icon}<span style="font-size:13px;font-weight:500;line-height:18px">${label}</span></button>`;
  }).join("");

  // ONE bento grid (trov.css), every tile stretched to its grid area so every edge lines
  // up: Profile | Account | MCP access (spanning two rows), Appearance under the first two,
  // Email notifications at full width. DOM order is the folded order — Profile, Account,
  // Appearance, then MCP access — so the narrower layouts need no reordering.
  return `<div class="cnpy-set-wrap"><div class="cnpy-set">
    ${profileSection(s)}

    ${accountSection(s)}

    <section class="cnpy-tile cnpy-surface cnpy-set-appear">
      <div style="${SECTION_LABEL}">Appearance</div>
      <div class="cnpy-set-themes">${themeCards}</div>
      <div style="font-size:11.5px;color:var(--fg-40);margin-top:10px">System follows your operating system's appearance.</div>
    </section>

    ${mcpAccessSection(s)}

    ${emailNotificationsSection({
      prefs: s.notifPrefs.data,
      loading: s.notifPrefs.status === "idle" || s.notifPrefs.status === "loading",
      error: s.notifPrefs.error ?? null,
      emailEditing: s.emailEditing,
      emailDraft: s.emailDraft,
    })}

  </div></div>`;
}

// ── my work (personal dashboard) ──────────────────────────────────────────────
// The layout lives in ./mywork (the Claude Design bento); this composes its
// props from the slices the app
// already reads. main.ts's loadForScreen("mywork") starts every one of them.
function greetingFor(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
/** Muted single-line hint for a degraded (D1 projection unavailable) section (existing idiom). */
function mwDegradedHint(text: string): string {
  return `<div style="font-size:13px;color:var(--fg-40);padding:2px 0">${text}</div>`;
}
/** A slice's readiness for a tile: data on hand counts as ready even mid-refresh. */
function mwLoad(status: string, hasData: boolean): MwLoad {
  if (status === "ok") return "ok";
  if (status === "error" || status === "missing") return hasData ? "ok" : "error";
  return hasData ? "ok" : "pending";
}

function myWorkView(s: AppState): string {
  const slice = s.mywork;
  const wrap = (inner: string) => `<div class="cnpy-scroll" style="max-width:1320px;margin:0 auto;padding:28px 32px 80px">${inner}</div>`;
  if (slice.status === "error" && !slice.data) return wrap(notice("Couldn't load your dashboard."));
  const d = slice.data;
  const dLoad: MwLoad = d ? "ok" : "pending";
  const degraded = d?.degraded ?? false;
  const me = (s.me?.handle ?? "").toLowerCase();

  // Needs review: the Review screen's own queue, as one-line heads (no diff — the
  // tile never shows one, and this runs on every paint). Each slice follows the
  // mwLoad rule (data on hand = ok), so a refetch after a verdict never blanks the
  // tile to "Loading…" or moves it; items on hand win over the other slice still
  // loading, but a failed slice is never papered over.
  const reviewItems = reviewHeadsFromReads(s.proposals.data, s.draftAdrs.data);
  const pLoad = mwLoad(s.proposals.status, s.proposals.data.length > 0);
  const aLoad = mwLoad(s.draftAdrs.status, s.draftAdrs.data.length > 0);
  const reviewLoad: MwLoad = pLoad === "error" || aLoad === "error" ? "error"
    : (pLoad === "ok" && aLoad === "ok") || reviewItems.length > 0 ? "ok" : "pending";

  // Your sessions: MY latest feed entries (My Work's own read), and the handoffs
  // waiting on me — the sidebar badge's definition, `handoffsForMe`.
  const feedLoad = mwLoad(s.mwSessions.status, s.mwSessions.data.length > 0);
  const sessions: MwSession[] = s.mwSessions.data
    .slice(0, 2)
    .map((e) => ({ id: e.id, summaryHtml: renderMarkdownInline(e.summary), brief: e.brief, at: e.created_at }));
  const handoffLoad = mwLoad(s.handoffs.status, s.handoffs.data.length > 0);
  const waiting: MwHandoff[] = handoffsForMe(s.handoffs.data, me)
    .map((h) => ({ id: h.id, title: firstLine(h.body) || `Handoff #${h.id}`, at: h.created_at }));

  // The library strip: docs you own, artifacts published this week, and the queued
  // handoffs (the same `handoffsForMe` set as the badge).
  const monthAgo = Date.now() - 30 * 86_400_000;
  const weekAgo = Date.now() - 7 * 86_400_000;
  const ts = (iso: string | null) => (iso ? Date.parse(iso) : NaN);
  // "Docs you own" = docs.owner (0035: the author of the first version, kept through later
  // edits and promotions), never-promoted stubs excluded.
  const myDocs = s.mwDocs.data.filter((x) => x.current_version > 0 && (x.owner ?? "").toLowerCase() === me);
  const staleDocs = myDocs
    .filter((x) => !(ts(x.updated_at) >= monthAgo))
    .sort((a, b) => (ts(a.updated_at) || 0) - (ts(b.updated_at) || 0))
    .map((x) => x.title);
  // "Published this week" reads artifact_pages.published_at (0035: when the current published
  // content went live; null for drafts), not the version date.
  const published = (s.art.list.data ?? []).filter((a) => a.published_at !== null);
  const latestArt = [...published].sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""))[0] ?? null;
  const library: MwLibrary = {
    docs: { load: mwLoad(s.mwDocs.status, s.mwDocs.data.length > 0), total: myDocs.length, stale: staleDocs },
    artifacts: { load: mwLoad(s.art.list.status, (s.art.list.data ?? []).length > 0), publishedThisWeek: published.filter((a) => ts(a.published_at) >= weekAgo).length, latest: latestArt ? { slug: latestArt.slug, title: latestArt.title, at: latestArt.published_at ?? latestArt.updated_at } : null },
    handoffs: { load: handoffLoad, count: waiting.length, newest: [...waiting].sort((a, b) => b.at.localeCompare(a.at))[0] ?? null },
  };

  // A ticket's due date is its sprint's; "this week" = within the next 7 days; before today = overdue.
  const sprintDue = new Map(s.sprints.data.map((sp) => [sp.id, sp.due]));
  const dueOf = (t: MyWorkTicket): MwDue | null => {
    const due = t.sprint ? sprintDue.get(t.sprint.id) : null;
    // The ONE due-date rule (shared/sprints-core): due all of that day, overdue from the next.
    const st = due ? sprintDueState(due, Date.now()) : null;
    if (!due || !st) return null;
    return { label: new Date(`${due.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }), soon: st.soon, overdue: st.overdue };
  };

  const tickets = d?.tickets ?? [];
  // The uncapped count (the list is capped); never below what is on hand.
  const ticketsTotal = Math.max(d?.ticketsTotal ?? 0, tickets.length);
  // The stat line claims only what has landed: a slice still loading or failed
  // contributes nothing, and "nothing is waiting on you" needs EVERY slice read ok.
  const ticketsKnown = dLoad === "ok" && !degraded;
  const stat = [
    ticketsKnown && ticketsTotal ? `${ticketsTotal} ticket${ticketsTotal === 1 ? "" : "s"} open` : "",
    reviewLoad === "ok" && reviewItems.length ? `${reviewItems.length} to review` : "",
    handoffLoad === "ok" && waiting.length ? `${waiting.length} handoff${waiting.length === 1 ? "" : "s"} waiting` : "",
  ].filter(Boolean).join(", ")
    || (ticketsKnown && reviewLoad === "ok" && handoffLoad === "ok" ? "nothing is waiting on you" : "");
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  // The design's composition: Tickets (only when you have some) and Needs your
  // review lead at 7/5; Your sessions and Repo follow; the library closes. A CLEAR
  // review queue (loaded, empty) is always shown — never dropped — but steps out of
  // the lead pair to sit beside Repo: Tickets 7 | Sessions 5 (or Sessions alone), then
  // Repo 7 | Needs your review 5.
  const hasTickets = dLoad !== "ok" || degraded || tickets.length > 0;
  const reviewClear = reviewLoad === "ok" && reviewItems.length === 0;
  const strips = ["library"];
  const order = reviewClear
    ? [hasTickets ? "tickets" : "", "sessions", "repo", "review"].filter(Boolean)
    : [hasTickets ? "tickets" : "", "review", "sessions", "repo"].filter(Boolean);
  const span = reviewClear
    ? { ...(hasTickets ? { tickets: 7, sessions: 5 } : { sessions: 12 }), repo: 7, review: 5, library: 12 }
    : mwSpans(order, strips);
  const tile: Record<string, () => string> = {
    tickets: () => ticketsTile({ load: dLoad, rows: tickets, total: ticketsTotal, expanded: s.mwExpanded.tickets }, degraded, span.tickets, dueOf),
    review: () => reviewTile(reviewItems, reviewLoad, span.review),
    sessions: () => sessionsTile(sessions, feedLoad, waiting, span.sessions),
    repo: () => repoTile(s.repo.data, mwLoad(s.repo.status, !!s.repo.data), s.mwRepoTab, span.repo),
    library: () => libraryStrip(library, span.library),
  };

  return myWorkLayout({
    greeting: `${greetingFor()}, ${esc(s.displayName || s.me?.name || s.me?.handle || "there")}`,
    dateLine: stat ? `${esc(today)} · ${esc(stat)}` : esc(today),
    tiles: [...order, ...strips].map((k) => tile[k]()),
  });
}

/** A list slice that hasn't produced data yet (idle/loading with nothing cached). */
function slicePending(l: Loadable<unknown[]>): boolean {
  return (l.status === "idle" || l.status === "loading") && l.data.length === 0;
}

/** Review screen with slice-level loading/error states around the pure view. */
function reviewScreen(s: AppState): string {
  if (slicePending(s.proposals) && slicePending(s.draftAdrs)) return notice("Loading review queue&hellip;");
  if (s.proposals.status === "error" && s.draftAdrs.status === "error") return notice("Couldn't load the review queue.");
  const hint = s.proposals.status === "error" ? mwDegradedHint("Couldn't load doc/decision proposals.")
    : s.draftAdrs.status === "error" ? mwDegradedHint("Couldn't load draft ADRs.")
    : "";
  return `${hint}${reviewView(reviewProps(s))}`;
}

/** Maintenance screen with slice-level loading/error states around the pure view. */
function maintenanceScreen(s: AppState): string {
  if (slicePending(s.needsTriage) && slicePending(s.identityTasks)) return notice("Loading maintenance&hellip;");
  if (s.needsTriage.status === "error" && s.identityTasks.status === "error") return notice("Couldn't load maintenance.");
  const hint = s.maintTab === "unplaced" && s.needsTriage.status === "error" ? mwDegradedHint("Couldn't load the triage queue.")
    : s.maintTab === "identity" && s.identityTasks.status === "error" ? mwDegradedHint("Couldn't load identity tasks.")
    : "";
  // People: the directory for everyone; invites (and the admin-only email
  // notification sections that used to close the single column) for admins.
  const admin = s.me?.admin === true;
  const people = s.maintTab !== "people" ? "" : peopleSection({
    persons: s.persons.data,
    invites: admin ? s.invites.data : [],
    inviteDraft: s.inviteDraft,
    loading: s.persons.status === "loading" || (admin && s.invites.status === "loading"),
    error: admin ? (s.invites.error ?? null) : null,
    me: s.me?.handle ?? null,
    canInvite: admin,
    edit: admin && s.personEdit ? { ...s.personEdit, saving: s.personSaving } : null,
    editOut: admin && s.personEditOut ? { ...s.personEditOut, saving: false } : null,
  }) + (admin
    ? notificationsMaintenanceSections({
        policy: s.notifPolicy.data,
        settings: s.notifSettings.data,
        outbox: s.notifOutbox.data,
        outboxExpanded: s.outboxExpanded,
        fromDraft: s.fromDraft,
      })
    : "");
  return maintenanceView(maintenanceProps(s), people, hint);
}

// ── tickets ──────────────────────────────────────────────────────────────────
/** The queue screen with slice-level loading/error states around the pure view. */
function ticketsScreen(s: AppState): string {
  if (slicePending(s.tickets)) return notice("Loading the queue&hellip;");
  if (s.tickets.status === "error") return notice("Couldn't load the ticket queue.");
  // The sprints slice is a SEPARATE fetch: when it fails the queue still renders
  // (every ticket falls into BACKLOG — `queueGroups` never drops one), but say so
  // rather than letting the grouping look like a filter bug.
  const hint = s.sprints.status === "error" ? mwDegradedHint("Couldn't load sprints — grouping by sprint is unavailable.") : "";
  return hint + queueView({
    tickets: s.tickets.data,
    sprints: s.sprints.data,
    persons: s.persons.data,
    seg: s.qSeg,
    assignee: s.qAssignee,
    category: s.qCategory,
    view: s.qView,
    unassignedCount: s.ticketBadge,
    q: s.qQ,
    priority: s.qPrio,
    sprint: s.qSprint,
    person: s.qPerson,
    filterOpen: s.qFilterOpen,
    filterCat: s.qFilterCat,
    fmOpening: s.fmOpening,
  });
}

function newTicketScreen(s: AppState): string {
  return newTicketView({
    title: s.fTitle,
    category: s.fCat,
    priority: s.fPrio,
    description: s.fDesc,
    assignees: s.fAsgs,
    link: s.fLink,
    sprintId: s.fSpr,
    sprints: s.sprints.data,
    persons: s.persons.data,
    sprMenu: s.sprMenu,
  });
}

function ticketDetailScreen(s: AppState): string {
  const slice = s.ticketDetail;
  if (slice.status === "loading" && !slice.data) return notice("Loading the ticket&hellip;");
  if (slice.status === "error") return notice("Couldn't load this ticket.");
  if (!slice.data) return notice("That ticket doesn't exist.");
  return ticketDetailView({
    ticket: slice.data,
    allTickets: s.tickets.data,
    sprints: s.sprints.data,
    persons: s.persons.data,
    commentDraft: s.commentDraft,
    mention: s.mention,
    commentHeight: s.commentHeight,
    linkDraft: s.linkDraft,
    linkOpen: s.lkOpen,
    asgMenu: s.asgMenu,
    sprMenu: s.sprMenu,
    relMenu: s.relMenu,
    lkMenu: s.lkMenu,
    stMenu: s.stMenu,
    artifactsBlock: ticketArtifactsBlock(s.art.ticketArts[slice.data.id]),
    edit: s.tdEdit,
    deleteArm: s.tdDeleteArm,
  });
}

/** The sprint screen with slice-level loading/error states around the pure view. */
function sprintScreenBody(s: AppState): string {
  const slice = s.sprintDetail;
  if ((slice.status === "loading" || slice.status === "idle") && !slice.data) return notice("Loading the sprint&hellip;");
  if (slice.status === "error") return notice("Couldn't load this sprint.");
  if (!slice.data) return notice("That sprint doesn't exist.");
  return sprintScreen({ detail: slice.data, persons: s.persons.data, resourceDraft: s.linkDraft, deleteArmed: s.sprintDeleteArmed });
}

/** The person card for `handle`: painted from the `GET /persons` summary, completed by the
 *  detail read once it lands (and from the detail alone if the directory hasn't loaded). */
function personCardFor(s: AppState, handle: string): string {
  const h = handle.toLowerCase();
  const detail = s.personDetail.data && s.personDetail.data.handle.toLowerCase() === h ? s.personDetail.data : null;
  const person = s.persons.data.find((x) => x.handle.toLowerCase() === h) ?? detail
    ?? { handle, name: null, color: "stone" as const, avatar_url: null, role: null };
  return personCardModal({ person, detail, self: h === (s.me?.handle ?? "").toLowerCase() });
}

// ── root ─────────────────────────────────────────────────────────────────────
function screenBody(s: AppState): string {
  switch (s.screen) {
    case "mywork": return myWorkView(s);
    case "feed": return feedView(s);
    case "docs": return docsView(s);
    case "roadmap": return roadmapView(s);
    case "review": return reviewScreen(s);
    case "maintenance": return maintenanceScreen(s);
    case "search": return searchView(s);
    case "settings": return settingsView(s);
    case "guide": return guideView(s);
    case "releases": return releasesScreen(s.releaseVersion, s.releasePage);
    case "tickets": return ticketsScreen(s);
    case "newticket": return newTicketScreen(s);
    case "ticketdetail": return ticketDetailScreen(s);
    case "sprint": return sprintScreenBody(s);
    case "repo": return repoView(repoProps(s));
    case "artifacts":
    case "artifactnew":
    case "artifact": return artifactsView(artProps(s, s.screen));
    case "handoffs": return handoffsView({ status: s.handoffs.status, handoffs: s.handoffs.data, me: s.me?.handle ?? "", persons: s.persons.data });
    case "handoff": return handoffDetailView({ status: s.handoffDetail.status, handoff: s.handoffDetail.data, me: s.me?.handle ?? "", persons: s.persons.data, expireArm: s.handoffExpireArm, promptView: s.promptView });
    case "newhandoff": return newHandoffView({ draft: s.nh, me: s.me?.handle ?? "", persons: s.persons.data });
    case "prompts": return promptLibraryView({ status: s.promptList.status, prompts: s.promptList.data, q: s.promptQ, tag: s.promptTag, sort: s.promptSort, filterOpen: s.promptFilterOpen, filterCat: s.promptFilterCat, fmOpening: s.fmOpening, persons: s.persons.data });
    case "prompt": return promptDetailView({
      status: s.promptDetail.status, prompt: s.promptDetail.data?.prompt ?? null, versions: s.promptDetail.data?.versions ?? [],
      persons: s.persons.data, knownTags: [...new Set(s.promptList.data.flatMap((p) => p.tags))],
      diffVersion: s.promptDiffV, tagMenu: s.promptTagMenu, tagDraft: s.promptTagDraft, promptView: s.promptView,
      canDelete: canDeletePrompt(s), deleteArm: s.promptDeleteArm, deleteBusy: s.promptDeleteBusy,
    });
    case "promptedit": return promptEditorView({ draft: s.promptEd, takenSlugs: s.promptList.data.map((p) => p.slug) });
    case "platform": return platformView(s.plat, s.me?.handle ?? null);
    case "platformorg": return platformOrgView(s.plat);
    case "newdoc": return newDocView({ draft: s.nd, spaces: DOC_SPACES.map((k) => ({ key: k, label: spaceLabel(k) })), sections: ASSIGN_OPTIONS.sections });
    default: return feedView(s);
  }
}

/** Project the app state onto the Repo dashboard's props (its components never see AppState). */
function repoProps(s: AppState): RepoProps {
  return {
    tab: s.repoTab, range: s.repoRange, driftOpen: s.repoDriftOpen, repo: s.repo, fetchedAt: s.repoFetchedAt, sample: s.repoSample,
    admin: s.me?.admin === true, poll: s.repoPoll, productEnv: s.repoProductEnv, persons: s.persons.data,
  };
}

/** Project the app state onto the Artifacts screens' props. */
function artProps(s: AppState, screen: ArtScreen): ArtProps {
  return {
    screen, route: s.artRoute, ui: s.art, me: s.me?.handle ?? "", admin: s.me?.admin === true, fmOpening: s.fmOpening,
    persons: s.persons.data, host: typeof location !== "undefined" ? location.host : "trov",
    theme: resolved(s),
    // Every ticket (the attach dialog's own read); the queue's filtered list until it lands.
    tickets: s.art.attachTickets.data ?? s.tickets.data.map((t) => ({ id: t.id, title: t.title, status: t.status })),
    sprints: s.sprints.data.map((x) => ({ id: x.id, label: x.label, dates: sprintDatesLabel(x), active: x.active })),
  };
}
const isArtScreen = (screen: Screen): screen is ArtScreen => screen === "artifacts" || screen === "artifactnew" || screen === "artifact";

// `.cnpy-shell` is the seam web/src/morph.ts looks for: inside it the <aside> is
// patched in place (so its transitions run) and <main> is swapped — or, on the
// Artifacts screens, patched too while the SAME view stays up (`data-morph` = the
// screen + its route): their previews are iframes, and a swapped iframe reloads.
function appView(s: AppState): string {
  const morphKey = isArtScreen(s.screen) ? `${s.screen}:${JSON.stringify(s.screen === "artifact" ? s.artRoute : null)}` : "";
  return `<div class="cnpy-shell" style="display:flex;height:100vh;overflow:hidden">
    ${sidebar(s)}
    <main${morphKey ? ` data-morph="${attr(morphKey)}"` : ""} style="flex:1;display:flex;flex-direction:column;min-width:0;background:var(--bg)">
      ${header(s)}
      <div id="cnpy-main" class="cnpy-scroll" style="flex:1;overflow-y:auto;min-height:0">${screenBody(s)}</div>
    </main>
    <div class="cnpy-scrim" data-act="closeDrawer" aria-hidden="true"></div>
  </div>`;
}

// The toast pops in, then fades out over its last 400ms. Both delays are offset by the time
// already elapsed (negative = joined mid-way), so a rerender while it is up never replays the pop.
// Centered with auto margins, not translateX(-50%): cnpy-pop animates `transform` to none.
const TOAST_FADE_MS = 400;
/** A toast's one button: `Undo` on a delete. Dispatched like any `data-act`. */
export interface ToastAction { label: string; act: string; arg: string }
/** Whether the signed-in person may delete the open prompt: its author, or an admin (the server re-checks). */
export function canDeletePrompt(s: Pick<AppState, "me" | "promptDetail">): boolean {
  const p = s.promptDetail.data?.prompt;
  if (!p || !s.me) return false;
  return s.me.admin || s.me.handle.toLowerCase() === p.author.toLowerCase();
}
function toastBlock(msg: string, elapsed: number, ms: number, action: ToastAction | null = null): string {
  return `<div class="cnpy-toast" role="status" aria-live="polite" style="position:fixed;bottom:22px;left:0;right:0;margin:0 auto;width:max-content;max-width:min(520px,calc(100vw - 32px));z-index:50;display:flex;align-items:flex-start;gap:9px;padding:10px 16px;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg);box-shadow:0 8px 30px rgba(0,0,0,.35);font-size:13px;line-height:1.45;animation-delay:${-elapsed}ms,${ms - TOAST_FADE_MS - elapsed}ms">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4" style="flex:none;margin-top:2px"><path d="M20 6 9 17l-5-5"></path></svg><span>${esc(msg)}</span>${action ? `<span aria-hidden="true" style="color:var(--fg-40)">·</span><button type="button" data-act="${attr(action.act)}" data-arg="${attr(action.arg)}" class="cnpy-toast-act" style="font-size:13px;font-weight:600;color:var(--accent);white-space:nowrap">${esc(action.label)}</button>` : ""}
  </div>`;
}

// Centered modal shown for the duration of an admin Sync GitHub run (possibly
// several batched requests — src/tools/backfill.ts caps AI calls per
// invocation, shared across PRs and issues). Both counts are absolute
// snapshots from the most recent batch, not accumulated client-side, so the
// bars always reflect real server-side state.
function backfillSyncModal(sync: BackfillSyncState): string {
  const bar = (label: string, count: number, total: number) => {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return `
      <div style="font-size:12.5px;color:var(--fg-55);margin:0 0 6px">${count} of ${total} ${label}</div>
      <div style="height:8px;border-radius:999px;background:var(--hover);overflow:hidden;margin-bottom:14px">
        <div style="height:100%;width:${pct}%;background:var(--accent);border-radius:999px;transition:width .3s ease"></div>
      </div>`;
  };
  const body = sync.phase === "starting"
    ? `<div style="font-size:12.5px;color:var(--fg-55);line-height:1.6">Contacting GitHub — taking inventory of PRs and issues&hellip;</div>`
    : `${bar("PRs summarized", sync.prSummarizedCount, sync.prsTotal)}
      ${bar("issues summarized", sync.issueSummarizedCount, sync.issuesTotal)}`;
  return `<div style="position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)">
    <div${surface("width:360px;max-width:calc(100vw - 32px);border-color:var(--border-strong);padding:28px 30px;box-shadow:0 20px 60px rgba(0,0,0,.45);text-align:center")}>
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="animation:cnpy-spin .8s linear infinite;margin-bottom:14px"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>
      <div style="font-size:15px;font-weight:600;margin-bottom:14px">Syncing GitHub</div>
      ${body}
    </div>
  </div>`;
}

export function render(s: AppState): string {
  const themeAttr = resolved(s);
  return `<div data-cnpy-theme="${themeAttr}" data-screen="${s.screen}" data-collapsed="${railCollapsed(s) ? "1" : "0"}" data-narrow="${s.narrow ? "1" : "0"}" data-phone="${s.phone ? "1" : "0"}" data-drawer="${s.phone && s.drawer ? "1" : "0"}" data-author="${s.feedAuthor}" style="background:var(--bg);color:var(--fg);min-height:100vh;font-family:'Geist',system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased">
    ${s.view === "auth" ? authView(s) : s.screen === "site" ? landingView({ dark: resolved(s) !== "light", signInOpen: false, signedIn: true, seen: s.landingSeen }) : s.screen === "unsubscribe" ? unsubscribeView({ email: s.notifPrefs.data?.email ?? s.me?.handle ?? null, pending: s.unsub.pending, error: s.unsub.error }) : appView(s)}
    ${s.toast ? toastBlock(s.toast, Math.max(0, Date.now() - s.toastAt), s.toastMs, s.toastAction) : ""}
    ${s.backfillSync ? backfillSyncModal(s.backfillSync) : ""}
    ${s.view === "app" && isArtScreen(s.screen) ? artifactsDialogs(artProps(s, s.screen)) : ""}
    ${s.view === "app" && s.screen === "handoff" && s.handoffPromptOpen && s.handoffDetail.data ? handoffPromptModal(s.handoffDetail.data) : ""}
    ${s.view === "app" && s.personCard ? personCardFor(s, s.personCard) : ""}
    ${s.view === "app" ? platformDialogs(s.plat, s.screen) : ""}
    ${s.view === "app" && s.screen === "settings" && s.mcpSetup ? mcpSetupModal() : ""}
    ${s.view === "app" && s.screen === "prompt" && s.promptExpanded && s.promptDetail.data ? promptPageModal(s.promptDetail.data.prompt) : ""}
    ${s.view === "app" && s.screen === "prompt" && s.promptDeleteArm && s.promptDetail.data && canDeletePrompt(s) ? promptDeleteModal(s.promptDetail.data.prompt, s.promptDetail.data.versions.length, s.promptDeleteBusy) : ""}
    ${s.view === "app" && s.screen === "ticketdetail" && s.tdDeleteArm && s.ticketDetail.data?.source === "canopy" ? ticketDeleteModal(s.ticketDetail.data, s.tdDeleteBusy) : ""}
  </div>`;
}
