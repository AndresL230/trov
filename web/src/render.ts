// Faithful static port of Canopy.dc.html — markup + inline styles transcribed
// from the dc-runtime template (lines 53–731), with `sc-for` resolved to
// `.map().join('')`, `sc-if` to ternaries, and `onClick="{{ fn }}"` to
// `data-act` / `data-arg` attributes dispatched in main.ts.

import { trovMark } from "@shared/mark";
import type { Me, StagedProposal, IdentityTask, DiscardedIdentity, PersonSummary, PersonProfile } from "./api";
import type { FeedRow, DocRow, DocMetaRow, DocListRow, DocVersionMetaRow, AdrRow, NeedsTriageRow, PersonColor, OAuthGrantSummary, McpTokenSummary } from "@shared/rows";
import type { QueryResult, QueryPrimary, QueryPointer, SprintView, SprintDetail, PlanView } from "./api";
import type { TicketListItem, TicketDetail, TicketSeg, TicketAssigneeFilter, TicketCategory } from "./api";
import type { TicketPriority } from "@shared/tickets";
import type { SidebarBadges } from "@shared/badges";
import { queueView, newTicketView, ticketDetailView, ticketDetailSkeleton, ticketDeleteModal, type StatusMenuAnchor, type QueueFilterCat } from "./tickets";
import { agentMark, aiMark, authorityMark, importanceMark, markShape, stateMark, tagWords } from "./marks";
import { sprintCard, newSprintPanel, sprintScreen, sprintSkeleton, nextSprintId, rmRising } from "./sprints";
import { sprintDueState, sprintDatesLabel, parsePlanNarrative } from "@shared/sprints-core";
import { roadmapTimeline, timelineShapes } from "./timeline";
import type { SprintUrgency, SprintDomain } from "@shared/sprints";
import { initialOnboard, onboardView, personChip, personLink, personAvatarLink, handleTag, handleLink, swatches, type OnboardState } from "./people";
import { skipLink } from "./site-chrome";
import { LEGAL_LINKS, NOTICES_PATH, consentHtml } from "@shared/legal-core";
import { personCardModal } from "./profile";
import { AVATAR_TYPES } from "@shared/people";
import type { DashboardData, MyWorkTicket } from "@shared/dashboard";
import type { FeedStats } from "@shared/feed-stats";
import {
  myWorkLayout, mwSpans, ticketsTile, reviewTile, sessionsTile, repoTile, libraryStrip, libraryTiles, handoffsForMe, briefTile,
  type MwLoad, type MwSession, type MwHandoff, type MwLibrary, type MwRepoTab, type MwDue,
} from "./mywork";
import type { TagListDTO, TagPageDTO } from "@shared/tags-core";
import { tagPageView, itemTagsRow, itemTagDropdown, initialTagsUi, type TagsUi } from "./tags";
import { filterMenu, filterMenuBackdrop, type FilterMenuProps } from "./filter-menu";
import { segmented } from "./segmented";
import { tabBar, tabPanelAttrs } from "./tabs";
import type { ReleasePage } from "./releases";
import { releasesView, releaseCrumb } from "./releases-lazy";
import { supportDialog, initialSupport, type SupportDraft } from "./support";
import { accountDeleteModal, accountDeleteTile, initialDeleteUi, type DeleteUi } from "./deletion";
import type { AccountDeletionPreview } from "@shared/deletion-core";
import { trovSettingsTiles, initialTrovPrefs, type TrovPrefsUi } from "./ask-settings";
import { renderMarkdown, renderMarkdownInline } from "./markdown";
import { repoUrl } from "./github";
import { esc, attr, initialsOf, relTime, surface, asideColumns, asideHead, asideNote, hitArea, HITBOX } from "./ui";
// The landing is its own chunk in the app (landing-lazy.ts); the signed-out page `/` boots it alone (landing-page.ts).
import { landingView } from "./landing-lazy";
import { emptyLayout, CONNECT_AGENT, skeleton, skBar, skBox, skLine, skLines, skList, skCard, skW, skProse } from "./skeleton";
import { reviewView, reviewGroups, type ReviewFilter, type ReviewProps, type DiffViewMode, type ReviewVerdict } from "./review";
import { importWizardView, importsHistoryView, initialImportUi, driverActive, type ImportUi } from "./import";
import { confirmModal } from "./confirm";
import type { ImportRunView } from "@shared/docs-import-core";
import { maintenanceView, maintenanceSkeleton, unplacedSpaceDropdown, effectivePicks, type MaintenanceProps, type AssignKind, type UnplacedVerdict } from "./maintenance";
import type { IdentityProps } from "./identity";
import { linksView, linkDetailView, linkCancelModal, NO_LINK_BOXES, type LinkBoxes, type LinkStart } from "./links";
import { relayView } from "./relay";
import { brandBanner } from "./brand-banner";
import type { AskState } from "@shared/ai-ask-core";
import type { LinkDetail, LinkSideName } from "@shared/links";
import { LINK_LIVE_MAX } from "@shared/links";
import { handoffsView, handoffDetailView, newHandoffView, handoffPromptModal, blankHandoff, type NewHandoffDraft } from "./handoffs";
import type { PromptView } from "./prompt-box";
import { promptLibraryView, promptDetailView, promptEditorView, promptPageModal, promptDeleteModal, type PromptFilterCat, type PromptDraft } from "./prompts";
import { newDocView, blankDoc, newDocSpaceDropdown, type NewDocDraft } from "./newdoc";
import { docsPane } from "./docs-pane";
import { docPageView, docHistoryDialog, type DocPageData } from "./doc-page";
import { libraryHomeView, spaceHomeView, spaceDialog, ownersDialog, archiveDialog, archivePageDialog, customizeSidebarDialog, initialLibraryUi, type LibraryUi, type SpaceTab } from "./library";
import { DEFAULT_SPACE, sidebarSpaces, type LibraryDTO, type SpaceHomeDTO, type SpaceDTO, type LibraryPageDTO } from "@shared/docs-core";
import type { HandoffView, HandoffReadingItem, PromptSummary, PromptDetail, PromptVersion, PromptSort } from "@shared/handoffs";
import { firstLine } from "@shared/handoffs";
import { emailNotificationsSection, switchBtn, type NotifAdminProps } from "./notifications";
import type { PrefsView, PolicyKindView, NotificationOutboxRow, NotificationSettingsRow } from "./api";
import { sidebarView, NAV_CLOSED, type NavOpen } from "./sidebar";
// The Repo screen is its own chunk (repo-lazy.ts draws a skeleton until it is in).
import { repoView, repoControls, repoCrumb, repoDropdowns, repoAttentionOverlay } from "./repo-lazy";
import type { RepoProps } from "./repo";
import type { RepoPollState } from "./repo-core";
import type { GroupBy } from "@shared/repo-layout-core";
import type { ScenarioKey } from "./repo-sample-keys";
// Artifacts is its own chunk (artifacts-lazy.ts draws a skeleton until it is in); its state is artifacts-state.ts.
import { artifactsView, artifactsHeader, artifactsDialogs } from "./artifacts-lazy";
import {
  ticketArtifactsBlock, initialArtUi, ART_ROUTE_NONE,
  type ArtUi, type ArtRoute, type ArtScreen, type ArtProps,
} from "./artifacts-state";
import type { RepoDashboard, RepoScreenTab, RepoRange } from "@shared/repo";
// Platform is its own chunk (platform-lazy.ts draws a skeleton until it is in); its state is platform-core.ts.
import { platformView, platformOrgView, platformDialogs, platformPage } from "./platform-lazy";
import { platformHeaderControls, platformCrumb, initialPlat, type PlatState } from "./platform-core";
import { reviewItemsFromReads, reviewHeadsFromReads, ASSIGN_OPTIONS, unplacedFromRow, identityFromTask, discardedFromRow, peopleFromPersons } from "./triage-map";
// Org settings (org-settings.ts / integrations.ts): the screen, its root overlays and its state.
import { dropdown, dropdownMenu, initialDropdownUi, type DropdownProps, type DropdownUi } from "./dropdown";
// Org settings is its own chunk (org-lazy.ts draws a skeleton until it is in); its state is org-core.ts.
import { orgSettingsView, orgOverlays } from "./org-lazy";
import { initialOrgUi, currentOrg, type OrgUi, type OrgSettingsProps } from "./org-core";
import { settingsPlanTile, settingsLimitsTile, settingsOrgsTile } from "./settings-plan";
import type { MyOrg, MyOrgsResponse, OrgMeResponse } from "@shared/orgs";
// Organizations as a person meets them (org-picker.ts): the switcher, the picker, the create dialog.
import { orgSwitcherButton, orgMenu, orgPickerView, createOrgModal, initialOrgsUi, type OrgsUi } from "./org-picker";
import { billingDonePage, type BillingDoneUi } from "./billing";
import { billingCheckoutPage, type BillingCheckoutUi } from "./billing-checkout";
import { isOrgAdmin } from "./org-context";
import { PLUGIN_INSTALL, browserConnectCommand, connectSteps, copyBox, mcpCode, mcpEndpoint, mcpStrong, otherClientsLink, CONNECTION_NOTE } from "./mcp-connect";
import { welcomeView, welcomeOverlays, initialWelcomeUi, type WelcomeProps, type WelcomeUi } from "./welcome";
import { initialSyncUi, syncOverlay, syncRepoLabel, syncSlot, type SyncProps, type SyncUi } from "./sync";
import { previewBanner, previewState, type PreviewMode } from "./preview";
import { aiItemRef } from "@shared/ai-core";
import { initialAiUi, aiIsHidden, aiFeedTip, aiFromLine, aiWrongBtn, aiRatingWrongBtn, aiFeedback, aiHiddenKey, aiLeavingT, aiLeave, aiLeaving, AI_NOTE_LEAVING, AI_EXIT_MS, type AiUi } from "./ai-ui";
import { planNarrativeBox, roadmapTrovButton, roadmapTrovCount, roadmapTrovDialog } from "./roadmap-ai";
import { aiFilterLine, aiFilterMenuTop, initialAiFilterUi, type AiFilterUi } from "./ai-filter";
import { initialAskUi, type AskUi } from "./ask-state";
import { askScreenView, askHeader, askOverlays } from "./ask-screen";
import { actionDropdowns } from "./ask-actions";
import { phoneHeaderControls } from "./ask-phone";
import { cmdjHeaderButton } from "./ask-cmdj";
import { appRoot, railCollapsed, resolvedTheme, toastBlock, type ToastAction } from "./app-root";

// A docs "space" is one of the org's own spaces (the Docs Library, 0081_docs_library): its slug.
export type DocSpace = string;

export type Screen =
  | "mywork" | "feed" | "docs" | "roadmap" | "review" | "maintenance" | "search" | "settings" | "guide"
  // One tag's page (`#tags/<name>`): everything that carries it. A child of Org settings › Tags.
  | "tag"
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
  // Relay (Workspace): its Overview (`#relay`, relay.ts, the first tab the sidebar opens); Handoffs: the inbox, one
  // handoff, the new-handoff form.
  | "relay" | "handoffs" | "handoff" | "newhandoff"
  // Relay › Links (the screen's second tab, `#links`) and one agent link's page (`#links/<n>`, web/src/links.ts).
  | "links" | "link"
  // Prompt Library (Knowledge): the library, one prompt, the editor (new / edit / new version).
  | "prompts" | "prompt" | "promptedit"
  // The Docs Library: its home (`#library`), a space's home (`#library/<space>`); a doc (`#doc/<slug>`, the
  // screen `docs`, the reader) and New page (`#docs/new`, the screen `newdoc`) sit under it too.
  | "library" | "space"
  | "newdoc"
  // The Markdown import wizard (`#import`) and Imports history (`#imports`): web/src/import.ts.
  | "import" | "imports"
  // Help › What's new: the release grid, and each release's notes / patch notes (releases.ts, static data).
  | "releases"
  // Org settings: one screen, five tabs (`#org[/<tab>]`, web/src/org-settings.ts).
  | "org"
  // The guided first-run setup: a full page, no sidebar (`#welcome[/<step>]`, web/src/welcome.ts).
  | "welcome"
  // Ask Trov (Workspace › Trov): threads, the conversation, the inspector (`#ask[/<thread id>]`, web/src/ask-*.ts).
  | "ask";

/** Async data slice: a screen's fetched payload plus its load status. */
export interface Loadable<T> {
  status: "idle" | "loading" | "ok" | "error" | "unauth";
  data: T;
  error?: string;
}

export interface AppState {
  /** `orgs` = signed in, but no org is open: the org picker (`/`, with no org or several). */
  /** `platform` = the superadmin's Platform area at `/platform/`, outside any org (platform.ts `platformPage`). */
  view: "auth" | "app" | "orgs" | "platform";
  /** `nonmember` = a GitHub sign-in that was refused; `unverified` = a Google account whose address Google has not verified. */
  authStep: "login" | "verifying" | "nonmember" | "unverified" | "onboard";
  /** The landing page's sign-in dialog (authStep "login" only). */
  signInOpen: boolean;
  /** Which button opened it (landing.ts `SignInMode`): the dialog's title and foot follow. */
  signInMode: "signin" | "signup";
  /** The plan picked in the dialog's Get started side. */
  signInPlan: "free" | "team";
  /** The landing tour's feature open in its dialog (web/src/site-feature.ts), or none. */
  siteFeature: import("./site-feature-core").FeatureState | null;
  /** The landing's menu, which its nav offers under 900px (web/src/site-menu.ts), is open. */
  siteMenu: boolean;
  /** Landing reveal keys that already played (landing-motion.ts records them). */
  landingSeen: Set<string>;
  /** Where "Back to the app" on the #site landing returns to (the route the logo was clicked from). */
  siteReturn: import("./hash").Route | null;
  deniedEmail: string | null;
  onboard: OnboardState;
  persons: Loadable<PersonSummary[]>;
  me: Me | null;
  /** The org on screen: the slug in the page's path (`/<slug>/`). null on the picker. */
  orgSlug: string | null;
  /** `GET /api/o/<slug>/me`: my role and title there, and the org's connected repositories. */
  orgMe: Loadable<OrgMeResponse | null>;
  /** The switcher's menu, the picker and the create-organization dialog (org-picker.ts). */
  orgsUi: OrgsUi;
  /** Help › Report a bug / Contact support: the dialog and its draft (support.ts). */
  support: SupportDraft;
  /** The guided first-run setup (welcome.ts): its step, and the by-hand disclosure. */
  welcome: WelcomeUi;
  /** Ask Trov: the screen's reads, its two conversations (the page's and the ⌘J panel's) and every part's state
   *  (web/src/ask-state.ts). The ⌘J panel opens over any screen, so this lives for the whole session. */
  ask: AskUi;
  /** `/billing/done`: the waiting room a buyer lands in after Stripe Checkout (billing.ts). null everywhere else. */
  billingDone: BillingDoneUi | null;
  /** The payment page (`/billing/checkout`, embedded checkout): set at boot from the URL, else null. */
  billingCheckout: BillingCheckoutUi | null;
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
  repoTab: RepoScreenTab;
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
  /** The repository the Repo screen reads (`#repo?repo=…`); null = the org's primary. */
  repoSlug: string | null;
  /** The App menu's narrowing (`#repo?app=…`): an app key, `REPO_WIDE`, or null for all apps. */
  repoApp: string | null;
  /** Group by, this session (null = the admin's default, `facts.groupDefault`). */
  repoGroup: GroupBy | null;
  /** Group by was flipped this session — an admin is offered "Make this the default". */
  repoGroupFlipped: boolean;
  /** "Preview with sample data": which of the design's scenarios (A–N) and variant it draws. Session-only. */
  repoScenario: { key: ScenarioKey; variant: string };
  /** Overview disclosures opened this session (`repoOpen`), keyed by each block. */
  repoOpen: ReadonlySet<string>;
  /** Roadmap › Narrative: the Trov button's dialog (the suggestions and the drift, roadmap-ai.ts) is open. */
  rmTrovOpen: boolean;
  /** Roadmap › Narrative: what an accepted suggestion just changed, rising in once the re-read landed (`at`, ms) — the
   *  narrative's box, and the sprint cards a draft created (ai-actions.ts; `RM_RISE_MS`). Null otherwise. */
  rmRise: { at: number; narrative: boolean; sprints: number[] } | null;
  /** Repo › Overview: Needs attention's dialog is open (repo-attention.ts). */
  repoAttentionOpen: boolean;
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
  /** The Docs Library (`GET /spaces`): the live spaces (the sidebar's Library group, the reader's breadcrumb, the
   *  space pickers), Library home's lists. Read once per org at boot, again after every space write. */
  library: Loadable<LibraryDTO | null>;
  /** The open space's home (`GET /spaces/:slug`). */
  spaceHome: Loadable<SpaceHomeDTO | null>;
  /** The space whose home is open (`#library/<space>`). */
  spaceSlug: string | null;
  /** Its tab (in state, not the route: a switch never replays the page's entrance). */
  spaceTab: SpaceTab;
  /** The Library screens' dialogs and the description edited in place (library.ts). */
  libUi: LibraryUi;
  /** The import wizard and Imports history's own state, and the run this tab drives (import.ts; the files' text stays
   *  in import-actions.ts). */
  imp: ImportUi;
  /** Imports history (`GET /imports`), newest first. */
  importRuns: Loadable<ImportRunView[]>;
  /** The doc page's read (`GET /doc/:slug`): the doc, its versions without their bodies, its tags, and `page` — its
   *  place in the tree, its links both ways and the rail (doc-page.ts). */
  docDetail: Loadable<DocPageData | null>;
  /** The organization's tag list (`GET /api/tags`): the Feed's filter, the Unplaced picker, a doc's
   *  Tags row and Org settings › Tags all draw from it. Read once per org, again after a write. */
  tags: Loadable<TagListDTO | null>;
  /** The tag screens' own state (web/src/tags.ts). */
  tagsUi: TagsUi;
  /** The tag whose page is open (`#tags/<name>`). */
  tagName: string | null;
  tagPage: Loadable<TagPageDTO | null>;
  docSlug: string | null;
  /** Narrow screens only: the docs pane (the page tree) is showing instead of the page. */
  docsTree: boolean;
  /** The space of the last doc opened (the pane's space on a doc page until its read lands). */
  docSpace: DocSpace;
  /** The docs pane: pages the person opened (true) or closed (false); one not named is open when it is above the page
   *  being read (docs-pane.ts `expandedSet`). */
  treeOpen: Record<string, boolean>;
  /** The pane row whose "…" menu is open. */
  treeMenu: string | null;
  roadmapTab: "narrative" | "timeline";
  /** Help › What's new: the release shown (`#releases/<v>`), or null for the grid (`#releases`). */
  releaseVersion: string | null;
  /** Which of that release's two pages (`#releases/<v>` / `#releases/<v>/patches`). */
  releasePage: ReleasePage;
  roadmap: Loadable<PlanView>;
  /** Roadmap › Recent happenings: its OWN unfiltered read of the newest
   *  HAPPENINGS_LIMIT feed entries — never the Feed screen's (filterable) slice. */
  roadmapFeed: Loadable<FeedRow[]>;
  // Triage surfaces (Review + Unplaced) and the logins to match — four Loadable slices, one per
  // list read; each surface's counts/props derive straight from these.
  proposals: Loadable<StagedProposal[]>;
  draftAdrs: Loadable<AdrRow[]>;
  needsTriage: Loadable<NeedsTriageRow[]>;
  identityTasks: Loadable<IdentityTask[]>;
  /** Discarded logins Undo can still restore — rides the identity-tasks read. */
  identityDiscarded: DiscardedIdentity[];
  /** Org settings › Members › Unmatched logins: the "N discarded" list is open. */
  identityShowDiscarded: boolean;
  reviewFilter: ReviewFilter;
  reviewSel: string | null;
  reviewDiffView: DiffViewMode;
  /** Review items a verdict was just given to, by id (main.ts `reviewAccept` / `reviewReject`).
   *  `gone: false` — the card is on screen, wearing its verdict and collapsing; `gone: true` — it
   *  has left the list and the write or the refetch that confirms it is still out. Either way the
   *  item is out of the queue's counts. A failed write deletes the entry, and the card is back. */
  reviewLeaving: Record<string, { verdict: ReviewVerdict; gone: boolean }>;
  /** Review's import groups opened with "Review one by one", by import id. */
  reviewGroupsOpen: Record<string, boolean>;
  /** The most pages each import group has held this session (its "‹d› of ‹N› reviewed"). */
  reviewGroupTotals: Record<string, number>;
  /** Every page each Review group has held this session, in its order (main.ts noteGroupTotals). */
  reviewGroupPages: Record<string, string[]>;
  /** The import group whose Reject all asks first (`confirmModal`). */
  reviewGroupReject: { id: string; busy: boolean } | null;
  assignOpen: string | null;
  assignKind: AssignKind | null;
  assignSection: string | null;
  assignSpace: string | null;
  assignTags: string[];
  /** Unplaced items just placed or discarded, still on screen while their card leaves (web-ui.md › A row leaving a
   *  list). Only HIDES rows of `needsTriage`; the refetch replaces the read and the entry is dropped. */
  unplacedLeaving: Record<string, { verdict: UnplacedVerdict; gone: boolean }>;
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
  /** Settings › MCP access: the connection whose scope (mode, organizations) is open in the dialog. */
  grantScope: number | null;
  /** How the dialog's last change went (saving / saved / refused). */
  grantScopeNote: GrantScopeNote | null;
  /** Connected apps opened past its first MCP_LIST_CAP rows by "Show all". */
  grantsAll: boolean;
  /** Settings › MCP access: MY personal access tokens for the org on screen (older setups; revoke only). */
  mcpTokens: Loadable<McpTokenSummary[]>;
  /** Relay › Overview: Ask's on/off for the org (`GET /ask/state`'s enabled and eligibility), for Your connections. */
  relayAsk: Loadable<{ enabled: boolean; eligibility: AskState["eligibility"] } | null>;
  tokenRevokeArm: number | null;
  /** Settings › MCP access's "Set it up without the plugin" modal is open (`mcpSetupModal`, at the app root). */
  mcpSetup: boolean;
  // Settings › Profile: the handle rename editor.
  handleEdit: boolean;
  handleDraft: string;
  handleCheck: "idle" | "checking" | "available" | "invalid" | "reserved" | "taken" | "same";
  /** Settings › Delete account (deletion.ts, deletion-actions.ts): what it would do, and its confirmation. */
  acctDelete: DeleteUi<AccountDeletionPreview>;
  /** Settings › Trov (ask-settings.ts): my Ask instructions and default mode in the org on screen. */
  trovPrefs: TrovPrefsUi;
  // Email notifications (Settings) — the user's resolved prefs + the address edit form.
  notifPrefs: Loadable<PrefsView | null>;
  emailEditing: boolean;
  emailDraft: string;
  // Email notifications (Org settings › Notifications, admin) — policy / schedule / recent outbox.
  notifPolicy: Loadable<PolicyKindView[]>;
  notifSettings: Loadable<NotificationSettingsRow | null>;
  notifOutbox: Loadable<NotificationOutboxRow[]>;
  outboxExpanded: string | null;
  fromDraft: string | null;
  /** Why the typed sender name was refused (shared/sender.ts `SENDER_NAME_HELP`, or the server's answer). */
  fromError: string | null;
  confirmedSprints: Record<string, boolean>;
  // ── Tickets (Phase 5) ──────────────────────────────────────────────────────
  /** The queue list for the CURRENT filters (the server applies seg/assignee/category). */
  tickets: Loadable<TicketListItem[]>;
  ticketDetail: Loadable<TicketDetail | null>;
  /** The ticket the detail screen is showing (from `#tickets/<id>`). */
  ticketId: number | null;
  /** Unassigned + open, org-wide — the sidebar badge AND the queue's footer count. */
  ticketBadge: number;
  /** The sidebar's counts before their lists are read: `GET /badges` at boot, and each list writes its
   *  own count here when it lands, so a list's reload never flashes 0. A list that has answered (`ok`)
   *  counts itself — `badgeCount` is the one place that picks. */
  badges: Partial<SidebarBadges>;
  qSeg: TicketSeg;
  /** Cards a refetch found DECLINED while a view that hides declined was up (main.ts
   *  `leaveDeclined`): each as it was shown and when its exit began — drawn leaving for
   *  `AI_EXIT_MS`, then dropped. Never under reduced motion. */
  qLeaving: { row: TicketListItem; at: number }[];
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
  /** The reading list (#167) the last claim in this session returned, for that handoff only. Not
   *  stored on the server and never recomputed on a read, so a reload drops it. */
  /** `at`: when an in-page claim drew it (Date.now()) — the list rises in once from then (handoffs.ts `readingListBlock`). */
  handoffReading: { id: number; items: HandoffReadingItem[] | null; at?: number } | null;
  nh: NewHandoffDraft;
  // ── Relay › Links (web/src/links.ts) ──────────────────────────────────────
  /** The Links tab's four boxes (`GET /links?box=…`). */
  links: Loadable<LinkBoxes>;
  linkDetail: Loadable<LinkDetail | null>;
  linkId: number | null;
  /** The composer's unsent note, for the link it was typed on. */
  linkNote: { id: number; text: string } | null;
  /** On a self-link, which of my two sides a note is written from (links.ts `noteSide`). */
  linkNoteSide: LinkSideName;
  /** A person step or a note in flight on the link's page. */
  linkBusy: boolean;
  /** Relay › Links' "Start a link" card: its draft while it is open, else null. */
  linkStart: LinkStart | null;
  /** Relay › Links: whether the past links show all (else the latest ten). */
  linksPastAll: boolean;
  /** Which link's Cancel request is being confirmed (a card on the Links tab arms it; the link page uses linkId). */
  linkCancelId: number | null;
  /** Cancel on a SENT request: its confirm modal is open (and `linkCancelBusy` while the write runs). */
  linkCancelArm: boolean;
  linkCancelBusy: boolean;
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
  // ── Docs › New doc / Unplaced ──────────────────────────────────────
  nd: NewDocDraft;
  // ── Platform (superadmin): everything its screens hold (platform.ts) ───────
  plat: PlatState;
  /** The filter menu (web/src/filter-menu.ts) the NEXT paint opens — its entrance plays once, then main.ts clears this. */
  fmOpening: string | null;
  /** The open dropdown (web/src/dropdown.ts) — one at a time, app-wide. */
  dd: DropdownUi;
  toast: string | null;
  /** One button on the toast (a delete's "Undo") — dispatched like any `data-act`. */
  toastAction: ToastAction | null;
  /** When the toast went up and how long it stays (ms) — a rerender joins its fade where it left off. */
  toastAt: number;
  toastMs: number;
  /** Sync GitHub (web/src/sync.ts): the panel, `GET /sync`'s answer, the run this tab drives, its result. */
  sync: SyncUi;
  // ── The person card (profile.ts), Settings › Profile's photo ──
  /** The person card open over the page (a click on a name); null = closed. */
  personCard: string | null;
  /** That person's `GET /api/people/:handle` (joined, GitHub, admin) — the card paints without it. */
  personDetail: Loadable<PersonProfile | null>;
  /** A photo upload or removal in flight. */
  avatarBusy: "upload" | "remove" | null;
  /** Settings › Profile: the photo menu the avatar opens (upload / change / remove). */
  avatarMenu: boolean;
  // ── Org settings (web/src/org-settings.ts) ─────────────────────────────────
  /** `GET /api/orgs`, loaded ONCE at boot (main.ts `loadMyOrgs`): my orgs (with my role in each), my
   *  invitations, whether I may create one, the superadmin flag. Org settings, the switcher, the
   *  picker and the Platform area all read this one slice. */
  myOrgs: Loadable<MyOrgsResponse | null>;
  /** Org settings' own state. It never holds a secret's value (org-actions.ts). */
  org: OrgUi;
  /** The state preview (`?preview=empty` / `?preview=loading`, web/src/preview.ts): every screen
   *  paints its empty layout or its loading skeleton instead of its data. null = off. */
  preview: PreviewMode | null;
  /** The AI screens (ai-ui.ts): what "Wrong?" hid, the Feed's Source, the themes' range and lane. */
  ai: AiUi;
  /** The plain-language filter in the Filter menus of Tickets, the Feed and Artifacts (ai-filter.ts; #162). */
  aiFilter: AiFilterUi;
}

/** Project the app state onto the Sync GitHub control and panel (sync.ts never sees AppState). */
export function syncPropsOf(s: AppState, now: number = Date.now()): SyncProps {
  return { ui: s.sync, admin: viewerIsAdmin(s), me: s.me?.handle ?? null, home: s.screen === "mywork", now };
}

export function initialState(): AppState {
  return {
    view: "auth", authStep: "login", signInOpen: false, signInMode: "signin", signInPlan: "free", siteFeature: null, siteMenu: false, landingSeen: new Set(), siteReturn: null,
    deniedEmail: null,
    onboard: initialOnboard(),
    persons: { status: "idle", data: [] },
    me: null,
    orgSlug: null,
    orgMe: { status: "idle", data: null },
    orgsUi: initialOrgsUi(),
    support: initialSupport(),
    welcome: initialWelcomeUi(),
    ask: initialAskUi(),
    billingDone: null,
    billingCheckout: null,
    screen: "mywork",
    theme: "light", systemDark: true,
    collapsed: false,
    narrow: false,
    phone: false,
    drawer: false,
    navOpen: { ...NAV_CLOSED },
    repo: { status: "idle", data: null },
    repoTab: "overview", repoRange: "7d", repoProductEnv: null, repoDriftOpen: false, repoFetchedAt: null, repoSample: false, repoPoll: null,
    repoSlug: null, repoApp: null, repoGroup: null, repoGroupFlipped: false, repoScenario: { key: "A", variant: "" }, repoOpen: new Set<string>(), repoAttentionOpen: false, rmTrovOpen: false, rmRise: null,
    feedView: "reading", feedFilterOpen: false, feedFilterCat: "author", feedAuthor: "all", feedTag: "all", feedRange: "all",
    feed: { status: "idle", data: [] },
    mywork: { status: "idle", data: null },
    mwRepoTab: "prs",
    mwExpanded: {},
    mwSessions: { status: "idle", data: [] },
    mwDocs: { status: "idle", data: [] },
    feedAuthors: [],
    feedStats: { status: "idle", data: null },
    library: { status: "idle", data: null },
    spaceHome: { status: "idle", data: null },
    spaceSlug: null,
    spaceTab: "overview",
    libUi: initialLibraryUi(),
    imp: initialImportUi(),
    importRuns: { status: "idle", data: [] },
    docDetail: { status: "idle", data: null },
    tags: { status: "idle", data: null },
    tagsUi: initialTagsUi(),
    tagName: null,
    tagPage: { status: "idle", data: null },
    docSlug: null,
    docsTree: false,
    docSpace: DEFAULT_SPACE,
    treeOpen: {},
    treeMenu: null,
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
    reviewFilter: "all", reviewSel: null, reviewDiffView: "unified", reviewLeaving: {}, reviewGroupsOpen: {}, reviewGroupTotals: {}, reviewGroupPages: {}, reviewGroupReject: null,
    assignOpen: null, assignKind: null, assignSection: null, assignSpace: null, assignTags: [], unplacedLeaving: {},
    mapConfirm: null,
    mapPicks: {},
    showHistory: false,
    searchQuery: "token", searchType: "all",
    searchResults: { status: "idle", data: { primary: [], pointers: [], meta: { engine: "fts5", total: 0 } } },
    displayName: "",
    grants: { status: "idle", data: [] },
    grantRevokeArm: null,
    grantScope: null,
    grantScopeNote: null,
    mcpSetup: false,
    grantsAll: false,
    mcpTokens: { status: "idle", data: [] },
    relayAsk: { status: "idle", data: null },
    tokenRevokeArm: null,
    handleEdit: false,
    handleDraft: "",
    handleCheck: "idle",
    acctDelete: initialDeleteUi<AccountDeletionPreview>(),
    trovPrefs: initialTrovPrefs(),
    notifPrefs: { status: "idle", data: null },
    emailEditing: false,
    emailDraft: "",
    notifPolicy: { status: "idle", data: [] },
    notifSettings: { status: "idle", data: null },
    notifOutbox: { status: "idle", data: [] },
    outboxExpanded: null,
    fromDraft: null,
    fromError: null,
    confirmedSprints: {},
    // Tickets — defaults transcribed from the design's `state` block: the queue
    // opens on Open / Any assignee / All categories in the Table view, and the
    // new-ticket form opens empty (no category → `other`, Normal, Backlog,
    // Unassigned).
    tickets: { status: "idle", data: [] },
    ticketDetail: { status: "idle", data: null },
    ticketId: null,
    ticketBadge: 0,
    badges: {},
    qSeg: "all", qLeaving: [], qAssignee: "anyone", qCategory: "all", qView: "board",
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
    handoffId: null, handoffExpireArm: false, handoffPromptOpen: false, handoffReading: null,
    nh: blankHandoff(),
    links: { status: "idle", data: NO_LINK_BOXES },
    linkDetail: { status: "idle", data: null },
    linkId: null, linkNote: null, linkNoteSide: "requester", linkBusy: false, linkStart: null, linksPastAll: false, linkCancelId: null, linkCancelArm: false, linkCancelBusy: false,
    promptList: { status: "idle", data: [] },
    promptQ: "", promptTag: null, promptSort: "updated_desc", promptFilterOpen: false, promptFilterCat: "tag",
    promptSlug: null,
    promptDetail: { status: "idle", data: null },
    promptDiffV: null, promptTagMenu: false, promptTagDraft: "", promptDeleteArm: false, promptDeleteBusy: false, promptExpanded: false, promptView: "raw",
    promptMode: "new", promptEd: null,
    nd: blankDoc(DEFAULT_SPACE),
    plat: initialPlat(),
    fmOpening: null,
    dd: initialDropdownUi(),
    toast: null,
    toastAction: null,
    toastAt: 0,
    toastMs: 0,
    sync: initialSyncUi(),
    personCard: null,
    personDetail: { status: "idle", data: null },
    avatarBusy: null,
    avatarMenu: false,
    myOrgs: { status: "idle", data: null },
    org: initialOrgUi(),
    preview: null,
    ai: initialAiUi(),
    aiFilter: initialAiFilterUi(),
  };
}

// ── triage surface data (real reads — the mapping layer lives in triage-map.ts) ──
export function reviewProps(s: AppState): ReviewProps {
  const leaving: Record<string, ReviewVerdict> = {};
  for (const [id, l] of Object.entries(s.reviewLeaving)) if (!l.gone) leaving[id] = l.verdict;
  return {
    // A card that has finished leaving is not in the list, even while the read still holds it.
    items: reviewItemsFromReads(s.proposals.data, s.draftAdrs.data).filter((it) => !s.reviewLeaving[it.id]?.gone).map((it) => {
      const p = personFor(s, it.agent);
      return p ? { ...it, agentColor: p.color, agentAvatar: p.avatar_url, agentHandle: p.handle, agentName: p.name } : it;
    }),
    leaving,
    groupsOpen: s.reviewGroupsOpen,
    groupTotals: s.reviewGroupTotals,
    groupPages: s.reviewGroupPages,
    spaceNames: Object.fromEntries([...liveSpaces(s), ...(s.library.data?.archived ?? [])].map((sp) => [sp.slug, sp.name])),
    people: s.persons.data,
    filter: s.reviewFilter,
    selectedId: s.reviewSel,
    diffView: s.reviewDiffView,
    aiUi: s.ai,
  };
}

export function maintenanceProps(s: AppState): MaintenanceProps {
  const leaving: Record<string, UnplacedVerdict> = {};
  for (const [id, l] of Object.entries(s.unplacedLeaving)) if (!l.gone) leaving[id] = l.verdict;
  return {
    // A card whose exit is over is gone from the list until the refetch lands (it only hides the read).
    unplaced: s.needsTriage.data.filter((r) => !s.unplacedLeaving[String(r.id)]?.gone).map(unplacedFromRow),
    leaving,
    // Feed tags a person may pick: the org's live list.
    assign: { ...ASSIGN_OPTIONS, tags: (s.tags.data?.tags ?? []).filter((t) => !t.retired).map((t) => ({ name: t.name, color: t.color })), spaces: liveSpaces(s).map((sp) => ({ key: sp.slug, label: sp.name })) },
    assignOpen: s.assignOpen,
    assignKind: s.assignKind,
    assignSection: s.assignSection,
    assignSpace: s.assignSpace,
    assignTags: s.assignTags,
    people: peopleFromPersons(s.persons.data),
    aiUi: s.ai,
    dd: s.dd,
  };
}

/** Unplaced's one dropdown (the Space picker past four spaces), with the item on screen's effective space checked. */
function unplacedDropdowns(s: AppState): DropdownProps[] {
  const p = maintenanceProps(s);
  const waiting = p.unplaced.filter((u) => !p.leaving?.[u.id]);
  const sel = waiting.find((u) => u.id === p.assignOpen) ?? waiting[0];
  return sel ? [unplacedSpaceDropdown(p.assign, effectivePicks(sel, p, sel.id === p.assignOpen).space)] : [];
}

/** The Library's Imports badge: imports in progress — the badges read's (or Imports history's) count, and at least
 *  the one this tab is running. */
export function importsBadge(s: Pick<AppState, "badges" | "imp" | "importRuns">): number {
  const listed = s.importRuns.status === "ok" ? s.importRuns.data.filter((r) => r.status === "running").length : s.badges.imports ?? 0;
  return Math.max(listed, driverActive(s.imp.run) ? 1 : 0);
}

/** Review › a group's Reject all asks first (the design's copy: an import's, or an agent's). */
function reviewGroupRejectModal(s: AppState, r: { id: string; busy: boolean }): string {
  const g = reviewGroups(reviewProps(s).items).get(r.id);
  if (!g) return "";
  const k = g.items.filter((it) => !s.reviewLeaving[it.id]).length;
  const space = spaceName(s, g.space);
  const pages = `${k} ${k === 1 ? "page" : "pages"}`;
  return confirmModal({
    id: "rv-group-reject", title: `Reject ${pages} from ${g.file}?`,
    body: g.kind === "agent" ? "The agent's changes are thrown away. The live pages stay as they are."
      : `They won't be added to ${space}. The import stays in Imports, so you can run it again later.`,
    confirmAct: "reviewGroupRejectGo", cancelAct: "reviewGroupRejectClose", arg: r.id, busy: r.busy,
    confirmLabel: `Reject ${pages}`, busyLabel: "Rejecting…",
  });
}

/** Sidebar counts for the two triage entries: Review's two reads, and the Unplaced queue (the
 *  key is still `maintenance`). Unmatched logins are NOT in it — they wait in Org settings. */
/** A sidebar count: its list's own once the list has answered, else the last count known for it
 *  (`s.badges`), else the list as it stands (empty before anything is read). */
function badgeCount<T>(s: Pick<AppState, "badges">, key: keyof SidebarBadges, list: Loadable<T[]>, count: (rows: T[]) => number): number {
  return list.status === "ok" ? count(list.data) : s.badges[key] ?? count(list.data);
}
const length = <T>(rows: T[]): number => rows.length;
export const stagedPrompts = (rows: readonly { status: string }[]): number => rows.filter((p) => p.status === "staged").length;

export function triageCounts(s: AppState): { review: number; maintenance: number } {
  // An item a verdict was just given to is not waiting any more: the badge drops with the card,
  // not when the refetch lands. It is derived, never stored — a failed write deletes the entry in
  // `reviewLeaving` and the count is back; the refetch then replaces the reads it is derived from.
  const left = reviewHeadsFromReads(s.proposals.data, s.draftAdrs.data).filter((it) => s.reviewLeaving[it.id]).length;
  return {
    review: badgeCount(s, "proposals", s.proposals, length) + badgeCount(s, "decisions", s.draftAdrs, length) - left,
    // The same for Unplaced: an item placed or discarded drops from the badge with its card.
    maintenance: badgeCount(s, "unplaced", s.needsTriage, length) - s.needsTriage.data.filter((r) => s.unplacedLeaving[String(r.id)]).length,
  };
}

/** How many logins wait to be matched to a person — an ADMIN's count (Org settings › Members,
 *  and the org switcher that leads there). 0 for everyone else: they cannot act on it. */
export function identityCount(s: AppState): number {
  return viewerIsAdmin(s) ? badgeCount(s, "logins", s.identityTasks, length) : 0;
}

/** Sidebar count for Handoffs: pending handoffs left for ME — `handoffsForMe`, the
 *  ONE definition My Work's Your sessions tile counts too. */
export function handoffBadge(s: AppState): number {
  return handoffOnlyBadge(s) + linkBadge(s);
}
/** The handoffs half: pending handoffs left for me. Links stay OUT of `handoffsForMe` (My Work counts it). */
export function handoffOnlyBadge(s: AppState): number {
  return badgeCount(s, "handoffs", s.handoffs, (rows) => handoffsForMe(rows, s.me?.handle ?? "").length);
}
/** The links half: link requests waiting for me (the Links tab's Waiting for you box, `GET /badges` `links`). */
export function linkBadge(s: AppState): number {
  return s.links.status === "ok" ? s.links.data.waiting.length : s.badges.links ?? s.links.data.waiting.length;
}


/** The org on screen with MY role in it — `currentOrg` is the one place that picks it. */
export const viewerOrg = (s: Pick<AppState, "orgSlug" | "myOrgs" | "me">): MyOrg | null => currentOrg(s);
/** Admin means admin or owner of the org on screen. Every admin-only control reads this. */
export const viewerIsAdmin = (s: Pick<AppState, "orgSlug" | "myOrgs" | "me">): boolean => isOrgAdmin(currentOrg(s));

const PLUS_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"></path></svg>`;

// ── helpers ──────────────────────────────────────────────────────────────────
const resolved = (s: AppState): "dark" | "light" => resolvedTheme(s);
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
  // A bare number or sha belongs to the org's primary repository; with none connected the chip
  // still names it, as text (`href: ""`), rather than link to a repository that is not the org's.
  const repo = repoUrl();
  const out: { kind: string; label: string; href: string }[] = [];
  for (const pr of a.prs ?? []) {
    const num = prNumber(pr);
    out.push({ kind: "PR", label: `#${num}`, href: isUrl(String(pr)) ? String(pr) : repo ? `${repo}/pull/${num}` : "" });
  }
  for (const c of a.commits ?? []) {
    const sha = commitSha(c);
    out.push({ kind: "commit", label: sha.slice(0, 7), href: isUrl(String(c)) ? String(c) : repo ? `${repo}/commit/${sha}` : "" });
  }
  for (const i of a.issues ?? []) out.push({ kind: "issue", label: `#${i}`, href: repo ? `${repo}/issues/${i}` : "" });
  return out;
}
/** A linked GitHub chip (issue / PR / commit / issue group). */
function ghChip(c: { kind: string; label: string; href: string }): string {
  if (!c.href) return `<span title="No repository is connected to this organization" style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;padding:3px 8px;color:var(--fg-55)"><span style="color:var(--fg-40)">${esc(c.kind)}</span><span style="font-family:var(--label);font-weight:500">${esc(c.label)}</span></span>`;
  return `<a href="${c.href}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;padding:3px 8px;text-decoration:none;color:var(--fg-70)"><span style="color:var(--fg-40)">${esc(c.kind)}</span><span style="font-family:var(--label);font-weight:500">${esc(c.label)}</span></a>`;
}
/** GitHub links for a sprint's github_ref. The bare number IS the number of an
 *  issue GROUP on GitHub, hence the "group" chip kind and the URL below. */
function sprintRefChips(github_ref: string | null): { kind: string; label: string; href: string }[] {
  if (!github_ref) return [];
  try {
    const p = JSON.parse(github_ref);
    // The path segment is GitHub's own — not Trov vocabulary.
    const repo = repoUrl();
    if (typeof p === "number") return [{ kind: "group", label: `#${p}`, href: repo ? `${repo}/milestone/${p}` : "" }];
    if (Array.isArray(p)) return p.map((n) => ({ kind: "issue", label: `#${n}`, href: repo ? `${repo}/issues/${n}` : "" }));
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
  if (s.authStep === "login") return landingView({ dark: resolved(s) !== "light", signInOpen: s.signInOpen, signInMode: s.signInMode, signInPlan: s.signInPlan, seen: s.landingSeen, feature: s.siteFeature, menuOpen: s.siteMenu });
  // Onboarding is a form: `data-morph` patches it in place per keystroke (morph.ts `paint`) instead of
  // rebuilding the card and the backdrop behind it. The other auth cards have nothing to type in.
  // The page's main landmark (a div with the role: the onboarding card's backdrop is the app's own markup,
  // `<main>` included, inert and hidden from assistive tech — a second `<main>` element may not wrap it).
  return `<div role="main" class="cnpy-authwrap"${s.authStep === "onboard" ? ' data-morph="onboard"' : ""} style="min-height:calc(100 * var(--vh));display:flex;align-items:center;justify-content:center;padding:32px">
    ${s.authStep === "nonmember" ? nonmemberCard() : ""}
    ${s.authStep === "unverified" ? unverifiedCard(s.deniedEmail) : ""}
    ${s.authStep === "verifying" ? verifyingCard() : ""}
    ${s.authStep === "onboard" ? onboardView(s.onboard, firstRunBackdrop()) : ""}
  </div>`;
}

const DENIED_SEAL = `<div class="cnpy-seal" style="width:52px;height:52px;border-radius:50%;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55)">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>
      </div>`;

/** A GitHub sign-in that was refused. Any GitHub account can sign in, so this is the one case left:
 *  the login belongs to a Trov account, but under a different GitHub account id (the login was
 *  renamed or re-registered) — and Trov will not hand that account to whoever holds the name now. */
function nonmemberCard(): string {
  return `<div style="width:400px;max-width:100%">
    <div${surface("padding:34px;display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center", { cls: "cnpy-authcard" })}>
      ${DENIED_SEAL}
      <div>
        <div style="font-size:18px;font-weight:600;letter-spacing:-0.01em">That GitHub account couldn't sign in.</div>
        <div style="font-size:13.5px;color:var(--fg-55);margin-top:8px;line-height:1.55">Its login already belongs to a Trov account that was created from a different GitHub account, so Trov won't open it for this one. If you renamed your GitHub account, sign in with the one you used before, or write to <a href="mailto:hello@trov.dev" style="color:var(--fg-70)">hello@trov.dev</a>.</div>
      </div>
      <button data-act="backToLogin" class="cnpy-outlinebtn" style="width:100%;padding:11px 16px;border-radius:9px;border:1px solid var(--border-strong);font-size:13.5px;font-weight:500">Back to sign in</button>
    </div>
  </div>`;
}

/** A Google account whose address Google has not verified — the one Google sign-in Trov refuses:
 *  a sign-in is matched to a person by that address, so an unverified one is never trusted. */
function unverifiedCard(email: string | null): string {
  return `<div style="width:400px;max-width:100%">
    <div${surface("padding:34px;display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center", { cls: "cnpy-authcard" })}>
      ${DENIED_SEAL}
      <div>
        <div style="font-size:18px;font-weight:600;letter-spacing:-0.01em">Google hasn't verified this address yet.</div>
        <div style="font-size:13.5px;color:var(--fg-55);margin-top:8px;line-height:1.55">Trov signs you in by the address Google confirms, and Google reports <span style="font-family:var(--label);font-size:12.5px;overflow-wrap:anywhere">${esc(email ?? "this address")}</span> as not verified. Verify it with Google and sign in again, or use another account.</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:9px 14px 9px 9px;border:1px solid var(--border);border-radius:999px;max-width:100%">
        <div class="cnpy-av cnpy-av-anon" style="width:26px;height:26px;flex:none;border-radius:50%;${AVATAR};font-size:10px;font-weight:600;color:var(--fg-70)">${esc(initialsOf(email ?? "?"))}</div>
        <div style="text-align:left;line-height:1.25;min-width:0"><div style="font-size:12.5px;font-weight:500">Signed in with Google as</div><div style="font-size:11.5px;color:var(--fg-55);font-family:var(--label);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(email ?? "unknown")}</div></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;width:100%">
        <button data-act="signIn" class="cnpy-accentbtn" style="width:100%;padding:11px 16px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:13.5px;font-weight:600">Sign in with GitHub</button>
        <button data-act="signInGoogleSwitch" class="cnpy-outlinebtn" style="width:100%;padding:11px 16px;border-radius:9px;border:1px solid var(--border-strong);font-size:13.5px;font-weight:500">Try a different Google account</button>
      </div>
      <p class="cnpy-consent" data-consent style="margin:0;font-size:12px;line-height:1.5;color:var(--fg-55)">${consentHtml()}</p>
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
      Signing you in&hellip;
    </div>
  </div>`;
}

// ── app shell ────────────────────────────────────────────────────────────────
/** The rail is collapsed when the person collapsed it OR the viewport forces it. On a phone
 *  it is neither: it is the full rail, in a drawer (trov.css `[data-phone="1"]`). */
// The rail renders collapsed below 900px (app-root.ts).
export { railCollapsed };

function sidebar(s: AppState): string {
  const counts = triageCounts(s);
  return sidebarView({
    screen: s.screen,
    collapsed: railCollapsed(s),
    navOpen: s.navOpen,
    qView: s.qView,
    roadmapTab: s.roadmapTab,
    librarySpace: paneSpaceSlug(s) ?? s.docSpace,
    spaces: sidebarSpaces(liveSpaces(s), s.library.data?.prefs).map((sp) => ({ key: sp.slug, label: sp.name, icon: sp.icon, color: sp.color })),
    spacesLoaded: s.library.status === "ok" && s.library.data !== null,
    canAdmin: viewerIsAdmin(s),
    // Tickets: unassigned ACTIVE tickets — a "nobody has this" signal (design call #2).
    counts: { review: counts.review, maintenance: counts.maintenance, tickets: s.ticketBadge, handoffs: handoffBadge(s), prompts: badgeCount(s, "prompts", s.promptList, stagedPrompts), imports: importsBadge(s) },
    me: s.me ? { handle: s.me.handle, name: s.me.name, color: s.me.color, avatar_url: s.me.avatar_url } : null,
    displayName: s.displayName,
    logo: logo(24),
    orgSwitcher: orgSwitcherButton({ org: viewerOrg(s), open: s.orgsUi.menu, invites: s.myOrgs.data?.invites.length ?? s.me?.pending_invites ?? 0, logins: identityCount(s), collapsed: railCollapsed(s) }),
    orgActive: s.screen === "org" || s.screen === "tag",
  });
}

/** A doc page's whole trail in the header, after "Library": its space and every page above it as links back, then the
 *  page itself (the only breadcrumb on the page — the article has none). Null until the doc's read is in (the
 *  header then names the space, as before). */
function docTrail(s: AppState): string | null {
  const d = s.docDetail.data;
  if (!d || (s.docSlug !== null && d.doc.slug !== s.docSlug)) return null;
  const sep = `<span aria-hidden="true" style="color:var(--fg-40);font-size:15px;flex:none">›</span>`;
  const link = (act: string, arg: string, label: string) =>
    `<button type="button" data-act="${act}" data-arg="${attr(arg)}" class="cnpy-hdr-crumb" style="font-size:15px;font-weight:600;letter-spacing:-0.01em;padding:0;color:var(--fg-55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;max-width:220px">${esc(label)}</button>`;
  const parts = [
    link("libOpenSpace", d.doc.space, spaceName(s, d.doc.space)),
    ...(d.page?.ancestors ?? []).map((a) => link("openDoc", a.slug, a.title)),
    `<span aria-current="page" style="font-size:15px;font-weight:600;letter-spacing:-0.01em;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">${esc(d.doc.title)}</span>`,
  ];
  return `<nav aria-label="Breadcrumb" style="display:inline-flex;align-items:center;gap:10px;min-width:0">${sep}${parts.join(sep)}</nav>`;
}

/** The "›" crumb text for the three child screens (empty on a top-level screen). */
function headerCrumb(s: AppState): string {
  if (s.screen === "releases") return releaseCrumb(s.releaseVersion, s.releasePage);
  if (s.screen === "newticket") return "New ticket";
  if (s.screen === "handoff") return s.handoffDetail.data ? firstLine(s.handoffDetail.data.body) : "";
  if (s.screen === "handoffs") return "Handoffs";
  if (s.screen === "links") return "Links";
  if (s.screen === "newhandoff") return "New handoff";
  if (s.screen === "link") {
    const l = s.linkDetail.data;
    return l ? `Link #${l.id}` : s.linkId ? `Link #${s.linkId}` : "";
  }
  if (s.screen === "prompt") return s.promptDetail.data?.prompt.title ?? "";
  if (s.screen === "promptedit") {
    const ed = s.promptEd;
    if (!ed) return "";
    return ed.mode === "new" ? "New prompt" : `${ed.mode === "edit" ? "Edit" : "New version"} · ${ed.title}`;
  }
  if (s.screen === "newdoc") return "New page";
  if (s.screen === "import") return "Import";
  if (s.screen === "imports") return "Imports";
  if (s.screen === "space") return s.spaceHome.data?.space.slug === s.spaceSlug ? s.spaceHome.data.space.name : spaceName(s, s.spaceSlug ?? "");
  if (s.screen === "docs") return spaceName(s, paneSpaceSlug(s) ?? s.docSpace);
  if (s.screen === "tag") return s.tagName ?? "";
  if (s.screen === "platformorg") return platformCrumb(s.plat);
  if (s.screen === "ticketdetail") return s.ticketDetail.data?.title ?? "";
  if (s.screen === "sprint") {
    return s.sprintDetail.data?.label ?? s.sprints.data.find((sp) => sp.id === s.sprintId)?.label ?? "";
  }
  return "";
}

function header(s: AppState): string {
  const titles: Record<Screen, string> = {
    mywork: "My Work", feed: "Feed", docs: "Library", library: "Library", space: "Library", roadmap: "Roadmap", review: "Review",
    maintenance: "Unplaced", search: "Search", settings: "Settings", guide: "Guide",
    site: "Trov", welcome: "Guided setup",
    // The three ticket screens all sit under Tickets; a sprint sits under Roadmap.
    tickets: "Tickets", ticketdetail: "Tickets", newticket: "Tickets", sprint: "Roadmap",
    repo: "Repo",
    artifacts: "Artifacts", artifactnew: "Artifacts", artifact: "Artifacts",
    // Relay is the landing page (relay.ts); Handoffs and Links are its pages, each the parent of its own items.
    relay: "Relay", handoffs: "Relay", handoff: "Handoffs", newhandoff: "Handoffs", links: "Relay", link: "Links",
    prompts: "Prompt Library", prompt: "Prompt Library", promptedit: "Prompt Library",
    newdoc: "Library", import: "Library", imports: "Library",
    releases: "What's new",
    platform: "Platform", platformorg: "Platform",
    org: "Org settings", tag: "Tags",
    ask: "Trov",
  };
  // dark = "show the moon icon".
  const dark = resolved(s) !== "light";

  // Feed chrome: ONE Filter menu (author · tag · time — the shared filter-menu, no
  // search box), then the For reading / For agents switch at the header's far right.
  const feedViewSwitch = s.screen === "feed" ? segmented({
    id: "feed-view", ariaLabel: "Feed view", act: "setFeedView", value: s.feedView, inertOn: true,
    options: [{ value: "reading", label: "For reading" }, { value: "agents", label: "For agents" }],
  }) : "";
  // The Source switch (All / Agents / Trov) sits beside it — only once a loaded entry carries `ai`.
  const feedSourceSwitch = s.screen === "feed" && feedHasAi(s) ? feedSourceSeg(s) : "";
  const feedMenu = s.screen === "feed" ? feedFilterMenu(s) : null;
  const feedControls = feedMenu
    ? `<div style="position:relative;display:flex;align-items:stretch;height:32px">${filterMenuBackdrop(feedMenu)}${filterMenu(feedMenu)}</div>`
    : "";

  // `sizeAs`: another label the same slot shows on a sibling tab, laid invisibly in the same grid cell, so the button
  // is as wide as the longer one and the header's icons beside it stay put between Relay's two pages.
  const accentNew = (act: string, label: string, sizeAs?: string) =>
    `<button data-act="${act}" class="cnpy-accentbtn" style="display:flex;align-items:center;gap:7px;padding:7px 14px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;white-space:nowrap;transition:filter .12s ease">${PLUS_ICON}${sizeAs
      ? `<span style="display:grid;justify-items:center"><span style="grid-area:1/1">${label}</span><span aria-hidden="true" style="grid-area:1/1;visibility:hidden">${sizeAs}</span></span>`
      : label}</button>`;
  const newControls = s.screen === "handoffs" ? accentNew("newHandoff", "New handoff", "Start a link") : s.screen === "links" ? accentNew("linkStartOpen", "Start a link", "New handoff") : s.screen === "prompts" ? accentNew("newPrompt", "New prompt") : "";

  // The Roadmap header: New sprint (it opens the panel at the top of whichever tab is
  // showing). Narrative / Timeline are the tab bar heading the page body (`roadmapTabBar`).
  const roadmapControls = s.screen === "roadmap" ? accentNew("nsToggle", "New sprint") : "";
  // The import screen: its history is one step away here (the sidebar has no Imports row).
  const importControls = s.screen === "import"
    ? `<button data-act="goImports" class="cnpy-outlinebtn" style="display:flex;align-items:center;gap:7px;padding:7px 13px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap">Imports history</button>`
    : "";

  // Sync GitHub (web/src/sync.ts): the button that opens the Sync panel. On My Work for an admin
  // (and, once a sync has run, a quiet "Synced 12m ago" for everyone else); on EVERY screen while
  // a run is in progress or its result has not been dismissed. The slot is always emitted.
  const myworkControls = syncSlot(syncPropsOf(s));

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
  // Report a bug: the theme toggle's twin, beside it on every screen the header shows on. It opens the
  // support dialog on Bug (support.ts) over the screen on show; at phone width it takes the header's
  // 40px icon-button size with the rest (`.cnpy-hdr-r > .cnpy-iconbtn`).
  const bugBtn = `<button data-act="supportOpen" data-arg="bug" data-support-trigger="bug" title="Report a bug" aria-label="Report a bug" aria-haspopup="dialog" class="cnpy-iconbtn" style="width:32px;height:32px;border-radius:8px;border:1px solid var(--border);display:grid;place-items:center;color:var(--fg-55)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="7" width="8" height="12" rx="4"></rect><path d="M12 12v7"></path><path d="M9.5 7.5a2.5 2.5 0 0 1 5 0"></path><path d="M4 13h4M16 13h4M5 7l3.2 2.6M19 7l-3.2 2.6M5 20l3.2-2.8M19 20l-3.2-2.8"></path></svg>
    </button>`;

  // Breadcrumb (the design's titleBtnSt / crumbSt): on a CHILD screen the title
  // becomes a back button to its parent and a "›" crumb names the child.
  // `ticketsBack` resolves to Tickets, or Roadmap from a sprint (one act, like
  // the design's single `back` handler).
  const child = s.screen === "ticketdetail" || s.screen === "newticket" || s.screen === "sprint"
    || s.screen === "handoffs" || s.screen === "links" || s.screen === "handoff" || s.screen === "newhandoff" || s.screen === "link" || s.screen === "prompt" || s.screen === "promptedit" || s.screen === "newdoc"
    || s.screen === "space" || s.screen === "docs" || s.screen === "import" || s.screen === "imports"
    || (s.screen === "releases" && s.releaseVersion !== null) || s.screen === "platformorg" || s.screen === "tag";
  // The act the title's back button fires: each child screen returns to its own parent.
  const backAct = s.screen === "handoffs" || s.screen === "links" ? "goRelay"
    : s.screen === "handoff" || s.screen === "newhandoff" ? "goHandoffs"
    : s.screen === "link" ? "goLinks"
    : s.screen === "prompt" ? "goPrompts"
    : s.screen === "promptedit" ? "edCancel"
    : s.screen === "newdoc" || s.screen === "space" || s.screen === "docs" || s.screen === "import" || s.screen === "imports" ? "goLibrary"
    : s.screen === "releases" ? "goReleases"
    : s.screen === "platformorg" ? "platGo"
    : s.screen === "tag" ? "tagsGo"
    : "ticketsBack";
  const trail = s.screen === "docs" ? docTrail(s) : null;
  const crumb = s.screen === "repo" ? repoCrumb(repoProps(s)) : trail ? trail : child
    // The crumb is set like the title before it (15px, semibold) — the page you are on, in full strength; the
    // title is the quieter link back.
    ? `<span style="display:inline-flex;align-items:center;gap:10px;min-width:0"><span style="color:var(--fg-40);font-size:15px">›</span><span style="font-size:15px;font-weight:600;letter-spacing:-0.01em;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">${esc(headerCrumb(s))}</span></span>`
    : "";
  const title = child
    ? `<h1 style="font-size:15px;font-weight:600;letter-spacing:-0.01em;margin:0;white-space:nowrap;flex:none"><button data-act="${backAct}" style="font-size:15px;font-weight:600;letter-spacing:-0.01em;padding:0;color:var(--fg-55);cursor:pointer">${titles[s.screen]}</button></h1>`
    : `<h1 style="font-size:15px;font-weight:600;letter-spacing:-0.01em;margin:0">${titles[s.screen]}</h1>`;

  // The Artifacts screens draw their own title + crumbs (a diff has two crumbs).
  const art = isArtScreen(s.screen) ? artifactsHeader(artProps(s, s.screen)) : null;

  // The phone drawer's toggle: always emitted, shown only at phone width (trov.css
  // `.cnpy-menubtn`), where the header also wraps its controls under the title (`.cnpy-hdr`).
  const menuBtn = `<button data-act="openDrawer" class="cnpy-menubtn cnpy-iconbtn" aria-label="Open navigation" aria-expanded="${s.drawer}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg></button>`;

  // Ask Trov draws its own title ("Ask Trov", plain text — AU-OWNER-3), crumb (the thread) and, on a phone, the
  // threads drawer and New thread (ask-screen.ts / ask-phone.ts). The Tickets page gains "Ask about this ⌘J".
  const ask = s.screen === "ask" ? askHeader(s) : null;
  const askControls = s.screen === "ask" ? phoneHeaderControls(s) : cmdjHeaderButton(s);

  return `<header class="cnpy-hdr" style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 var(--hdr-pr, 24px) 0 var(--hdr-pl, 24px);min-height:57px;border-bottom:1px solid var(--border);flex:none">
    <div class="cnpy-hdr-l" style="display:flex;align-items:center;gap:12px;min-width:0">
      ${menuBtn}${ask ? `${ask.lead}${ask.title}` : art ? art.title : title}
      ${ask ? ask.crumb : art ? art.crumb : crumb}
    </div>
    <div class="cnpy-hdr-r" style="display:flex;align-items:center;gap:8px;flex:none">
      ${askControls}${newControls}${feedControls}${roadmapControls}${importControls}${queueControls}${myworkControls}${s.screen === "repo" ? repoControls(repoProps(s)) : ""}${art ? art.controls : ""}${platformHeaderControls(s.plat, s.screen)}${feedSourceSwitch}${feedViewSwitch}${bugBtn}${themeBtn}
    </div>
  </header>`;
}

// ── feed ─────────────────────────────────────────────────────────────────────
/** The Feed page: the entries (`inner`) beside the sticky aside — This week + Waiting on
 *  review — in the Roadmap Narrative's two columns (ui.ts `asideColumns`). */
function wrapFeed(s: AppState, inner: string, history = true): string {
  return asideColumns(`${aiFilterLine("feed", s.aiFilter, s.ai)}${inner}
    ${history ? `<div style="text-align:center;padding:18px 0;font-size:11.5px;color:var(--fg-40);font-family:var(--label)">&mdash; start of recorded history &mdash;</div>` : ""}`, feedAside(s), undefined, { frame: "var(--frame-feed)", cls: "cnpy-feed-page" });
}

/** An aside box's rows while its read is out: a title line and a meta line per row,
 *  in the box's own row padding (so the rows land where the bars were). */
const asideRowShapes = (n: number): string =>
  skList(n, (i) => `<div style="padding:9px 18px;border-top:1px solid var(--border)">${skLine(skW(i), 13, 1.45)}<div style="margin-top:3px">${skLine(skW(i + 1, ["44%", "52%", "38%"]), 12, 1.5)}</div></div>`);
function asideRowsSkeleton(key: string, label: string, n: number): string {
  return skeleton(key, label, asideRowShapes(n));
}
/** An aside box that has loaded and holds nothing: its sentence where the first row goes, then
 *  the rows it will have, drawn empty (skeleton.ts `emptyLayout`). `shapes` are the box's own rows. */
function asideEmpty(key: string, text: string, shapes: string): string {
  return emptyLayout(key, { text, plain: true, shapes, sayStyle: "padding:12px 18px 14px;border-top:1px solid var(--border)" });
}

/** One Feed card as a shape — avatar, title, a two-line brief, the byline — for the loading
 *  skeleton and the empty layout. */
const feedCardShape = (i: number): string => skCard(`<div style="display:flex;align-items:flex-start;gap:12px">
      ${skBox(30, 30, "margin-top:1px")}
      <div style="flex:1;min-width:0">${skLine(skW(i), 14, 1.5)}<div style="margin-top:5px">${skLines(["100%", skW(i + 1, ["64%", "82%", "46%"])], 13.5, 1.6)}</div><div style="margin-top:12px">${skLine(170, 12, 1.5)}</div></div>
    </div>`, "padding:16px 18px;margin-bottom:12px");
/** The Feed's cards while its first read is out. */
function feedSkeleton(): string {
  return skeleton("feed", "Loading feed&hellip;", skList(5, feedCardShape));
}
/** The Feed's empty sentence: nothing is made here by hand — an entry lands when an agent records a
 *  session (the Guide: "a timeline of everything that shipped, from people and agents alike"). */
export const FEED_EMPTY = "Nothing has been recorded yet. This is the timeline of everything that ships: an entry lands when your agent records a session.";

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
  // The seven day bars as shapes — the loading skeleton's and the empty layout's.
  const weekBars = `<div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;padding:0 18px 14px">${skList(7, () => `<span style="display:flex;flex-direction:column;align-items:center;gap:5px">${skBox("100%", 36)}${skBar(8, 10)}</span>`)}</div>`;
  if (!d) {
    if (st.status === "error") return wrap(asideNote("Couldn't load this week's numbers."));
    // The figure, the seven day bars and one chip group — the box's own blocks.
    return wrap(skeleton("feed-week", "Loading&hellip;", `<div style="display:flex;align-items:center;gap:8px;padding:0 18px 12px">${skBox(34, 24)}${skBar(120, 9)}</div>
      ${weekBars}
      <div style="padding:10px 18px 12px;border-top:1px solid var(--border)">${skBar(60, 8, "margin:4px 0 11px")}<div style="display:flex;gap:6px">${skBox(74, 24)}${skBox(58, 24)}${skBox(86, 24)}</div></div>`));
  }
  // A true zero for the whole window: the seven day bars, drawn empty.
  if (d.total === 0) return wrap(asideEmpty("feed-week", "Nothing recorded in the last 7 days.", `<div style="padding-top:2px">${weekBars}</div>`));

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
 * Review queue, from the proposals + draft ADR slices (the Feed loads them), as the cheap no-diff
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
  if (load === "pending") return wrap(asideRowsSkeleton("feed-review", "Loading&hellip;", 2));
  if (items.length === 0) return wrap(asideEmpty("feed-review", "Nothing waiting on review.", asideRowShapes(2)));

  const proposals = items.filter((i) => i.kind === "proposal").length;
  const decisions = items.length - proposals;
  const split = [proposals ? plural(proposals, "proposal") : "", decisions ? plural(decisions, "decision") : ""].filter(Boolean).join(", ");
  const count = `<div style="font-size:13px;color:var(--fg-55);padding:0 18px 10px;margin-top:-2px"><span style="color:var(--fg);font-weight:500;font-variant-numeric:tabular-nums">${items.length}</span> waiting · ${split}</div>`;
  // `hitArea` rows: the proposer's handle opens their person card, the rest the review item.
  const rows = items.slice(0, FEED_REVIEW_LIMIT).map((it) => `<div class="mw-row ${HITBOX}" style="display:block;width:100%;text-align:left;padding:9px 18px;border-top:1px solid var(--border);font-size:13px">
      <span style="display:block;color:var(--fg);font-weight:500;line-height:1.45;overflow-wrap:anywhere">${esc(it.title)}</span>
      <span style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:3px;font-size:12px;color:var(--fg-40)">
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
    align: "right", ariaLabel: "Filter the feed", standalone: true, top: aiFilterMenuTop("feed", s.aiFilter),
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
        // The ORG's own list (a retired tag still filters: entries keep it), plus the one picked,
        // so a filter set from a tag's page shows even before the list has loaded.
        options: [["all", "All tags"] as [string, string], ...feedTagNames(s).map((t): [string, string] => [t, t])]
          .map(([v, l]) => ({ v, l, act: "setTag", arg: v })),
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

/** The tags the Feed can be filtered by: the org's list, in its order — and the picked one, whatever it is. */
export function feedTagNames(s: Pick<AppState, "tags" | "feedTag">): string[] {
  const names = (s.tags.data?.tags ?? []).map((t) => t.name);
  return s.feedTag !== "all" && !names.includes(s.feedTag) ? [...names, s.feedTag] : names;
}

/** The "For reading" line under the title: the entry's brief, plain text. An entry
 *  written without one (older plugin, not yet backfilled) shows the title alone. */
function feedBrief(brief: string | null): string {
  if (!brief || !brief.trim()) return "";
  return `<div class="cnpy-feed-brief" style="font-size:13.5px;color:var(--fg-70);line-height:1.6;margin-top:5px">${esc(brief)}</div>`;
}

/** Sift's rating in a byline (`feed.importance`): a dot and the mark for notable or breaking; NOTHING for routine or an
 *  unrated entry, so a row without one is exactly what it was. After the mark, "Wrong?" (Q34): feedback for the evals
 *  only — the rating is a computed fact, never edited, dismissed or hidden. */
function feedImportance(s: AppState, e: FeedRow): string {
  const m = importanceMark(e.importance);
  if (!m) return "";
  const body = aiFeedback("importance", aiItemRef.importance(e.id), "feed.importance", null);
  const wrong = aiRatingWrongBtn(body, s.ai.ratedWrong.includes(aiHiddenKey("importance", body.itemRef)));
  return `<span style="font-size:12px;color:var(--fg-40)">&middot;</span><span data-importance="${e.importance}" style="display:inline-flex;align-items:center;gap:2px">${m}${wrong}</span>`;
}

/** A feed entry's `@author`: a link to their person card when the author is a known person. */
function feedAuthorTag(s: AppState, author: string): string {
  return handleLink(personFor(s, author), author);
}

// ── the Feed's entries written by Trov (ai-ui.ts) ────────────────────────────
/** An entry Trov wrote. One with `ai.origin === "agent"` (or no `ai`) is an agent's, as before. */
const isTrovEntry = (e: FeedRow): e is FeedRow & { ai: NonNullable<FeedRow["ai"]> } => e.ai?.origin === "ai";
/** Any loaded entry carries `ai`: only then are the Source switch and the note drawn. */
export const feedHasAi = (s: AppState): boolean => s.feed.data.some((e) => e.ai !== undefined);
const feedNoteSeen = (s: AppState): boolean => !!s.me && s.ai.noteSeen.some((h) => h.toLowerCase() === s.me!.handle.toLowerCase());
/** The rows on screen: the time filter, then the Source switch, then whatever "Wrong?" hid — an entry
 *  still LEAVING (ai-ui.ts › Leaving) stays until its exit is over. */
export function feedShown(s: AppState, now = Date.now()): FeedRow[] {
  const rows = feedRows(s, now);
  if (!feedHasAi(s)) return rows;
  const src = s.ai.feedSource;
  return rows.filter((e) => (src === "trov" ? isTrovEntry(e) : src === "agents" ? !isTrovEntry(e) : true)
    && !(isTrovEntry(e) && aiIsHidden(s.ai, "feed", aiItemRef.feed(e.id)) && aiLeavingT(s.ai, aiHiddenKey("feed", aiItemRef.feed(e.id)), now) === null));
}
function feedSourceSeg(s: AppState): string {
  return segmented({
    id: "feed-source", ariaLabel: "Source", act: "aiFeedSource", value: s.ai.feedSource, inertOn: true,
    options: [{ value: "all", label: "All" }, { value: "agents", label: "Agents" }, { value: "trov", label: "Trov" }],
  });
}
/** Source = Trov with no entry Trov wrote on the page (Q27). */
export const FEED_NO_TROV = "No Trov entries in this view.";
/** Said once, above the first entry Trov wrote, until this person presses "Got it". */
export const FEED_AI_NOTE = "Trov now writes entries from your commits, about 45 minutes after your last push. Your agents can stick to decisions and findings.";
function feedAiNote(): string {
  return `<aside aria-label="New" class="cnpy-ai-note" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 22%,transparent);border-radius:10px;padding:12px 16px;margin-bottom:12px">
      <p style="margin:0;flex:1 1 320px;font-size:13.5px;line-height:1.55">${esc(FEED_AI_NOTE)} <button type="button" data-act="orgGo" data-arg="ai" class="cnpy-mutelink" style="padding:0;font:inherit;font-weight:500;color:var(--accent)">AI settings</button></p>
      <button type="button" data-act="aiNoteGotIt" class="cnpy-ghostbtn" style="font-size:13px;font-weight:500;border:1px solid var(--border-strong);background:var(--surface);border-radius:6px;padding:5px 12px;min-height:32px">Got it</button>
    </aside>`;
}
/** An entry Trov wrote: the AI mark as its avatar, "Trov" as the name, "for <subject>", and the
 *  sources it was written from with "Wrong?" under the brief. */
function feedTrovCard(s: AppState, e: FeedRow & { ai: NonNullable<FeedRow["ai"]> }): string {
  const a = e.ai;
  const tip = aiFeedTip(a.sources, a.moreCount);
  const avatar = `<span aria-hidden="true" class="cnpy-ai-av" style="width:30px;height:30px;border-radius:7px;background:var(--accent-soft);display:inline-flex;align-items:center;justify-content:center;flex:none">${aiMark(15)}</span>`;
  const subject = a.subject ? `<span data-mtip="${attr(tip)}" style="font-size:12px;color:var(--fg-55)">for ${handleLink(personFor(s, a.subject), a.subject)}</span>` : `<span data-mtip="${attr(tip)}" style="font-size:12px;color:var(--fg-55)">written by Trov</span>`;
  const from = aiFromLine(a.sources, a.moreCount);
  return `<div${surface("padding:16px 18px;margin-bottom:12px", { cls: "cnpy-ai-entry" })} data-ai="feed" data-feed-id="${e.id}">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="margin-top:1px">${avatar}</div>
        <div style="flex:1;min-width:0">
          <div class="cnpy-md-inline" style="font-size:14px;font-weight:500;line-height:1.5;letter-spacing:-0.005em">${renderMarkdownInline(e.summary)}</div>
          ${s.feedView === "reading" ? feedBrief(e.brief) : feedBody(e.body) || feedBrief(e.brief)}
          <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px">
            <span style="font-size:12px;font-weight:600;color:var(--fg)">Trov</span>
            ${subject}
            <span style="font-size:12px;color:var(--fg-40)">&middot;</span>
            <span style="font-size:12px;color:var(--fg-40)">${relTime(e.created_at)}</span>${feedImportance(s, e)}
          </div>
          <div style="display:flex;align-items:center;flex-wrap:wrap;justify-content:space-between;gap:10px;margin-top:11px;padding-top:11px;border-top:1px solid var(--border);font-size:12.5px;color:var(--fg-55)">
            ${from || "<span></span>"}${aiWrongBtn(aiFeedback("feed", aiItemRef.feed(e.id), "feed", a.model), 12.5)}
          </div>
        </div>
      </div>
    </div>`;
}

function feedView(s: AppState): string {
  if ((s.feed.status === "loading" || s.feed.status === "idle") && s.feed.data.length === 0) return wrapFeed(s, feedSkeleton());
  if (s.feed.status === "error") return wrapFeed(s, notice("Couldn't load the feed."));

  // Entries written by Trov (`ai.origin === "ai"`) get their own byline and footer; the Source switch
  // and "Wrong?" narrow what is shown; the one-time note sits above the first of them on screen.
  const now = Date.now();
  const shown = feedShown(s, now);
  // "Got it" and "Wrong?" take the note and an entry out with the one exit (ai-ui.ts › Leaving).
  const noteT = aiLeavingT(s.ai, AI_NOTE_LEAVING, now);
  // With the switch off (or no key) the note would be untrue: not drawn; the entries keep their mark (Q29).
  const noteAt = feedHasAi(s) && !s.ai.feedAiOff && (!feedNoteSeen(s) || noteT !== null) ? shown.findIndex(isTrovEntry) : -1;
  const cards = shown.map((e, i) => {
    const note = i === noteAt ? (noteT === null ? feedAiNote() : aiLeave(feedAiNote(), noteT)) : "";
    if (isTrovEntry(e)) {
      const t = aiLeavingT(s.ai, aiHiddenKey("feed", aiItemRef.feed(e.id)), now);
      return note + (t === null ? feedTrovCard(s, e) : aiLeave(feedTrovCard(s, e), t));
    }
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
            ${agentMark()}
            <span style="font-size:12px;color:var(--fg-40)">&middot;</span>
            <span style="font-size:12px;color:var(--fg-40)">${relTime(e.created_at)}</span>
            ${e.tags && e.tags.length ? `<span style="font-size:12px;color:var(--fg-40)">&middot;</span>${tagWords(e.tags)}` : ""}${feedImportance(s, e)}
            <div style="flex:1"></div>
          </div>
          ${artifactRow}
        </div>
      </div>
    </div>`;
  }).join("");

  // The feed answered with nothing and no filter is narrowing it: the cards, drawn empty.
  // (Author and tag are server-side filters, the time range a client-side one.)
  if (s.feed.status === "ok" && s.feed.data.length === 0 && s.feedAuthor === "all" && s.feedTag === "all") {
    return wrapFeed(s, emptyLayout("feed", { text: FEED_EMPTY, action: CONNECT_AGENT, sayStyle: "margin-bottom:12px", shapes: skList(3, feedCardShape) }), false);
  }
  // Source = Trov over a page with no entry Trov wrote says so, not "match this filter" (Q27).
  const empty = s.feed.status === "ok" && shown.length === 0
    ? notice(feedHasAi(s) && s.ai.feedSource === "trov" ? FEED_NO_TROV : "No entries match this filter.") : "";
  return wrapFeed(s, `<div class="cnpy-stagger">${cards}</div>${empty}`);
}

// ── the Docs Library: the docs pane, a doc page, a space's home, New page (docs-library.md › The screens) ──
// A doc's space is one of the org's own (the Library's): the pane lists that space's page tree, and the breadcrumb
// names the space by the Library's name for it.
/** The org's live spaces, in the Library's order ([] until the read lands). */
export const liveSpaces = (s: Pick<AppState, "library">): SpaceDTO[] => s.library.data?.spaces ?? [];
/** A space's name: the Library's, else the slug as written (a space the read does not list — archived, or not in yet). */
export function spaceName(s: Pick<AppState, "library">, slug: string): string {
  const sp = liveSpaces(s).find((x) => x.slug === slug) ?? s.library.data?.archived.find((x) => x.slug === slug);
  return sp ? sp.name : slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : slug;
}

/** The space whose tree the docs pane shows: the open space's home, the doc's own space, New page's target. */
export function paneSpaceSlug(s: AppState): string | null {
  if (s.screen === "space") return s.spaceSlug;
  if (s.screen === "newdoc") return s.nd.space || null;
  if (s.screen === "docs") {
    const d = s.docDetail.data;
    if (d && (s.docSlug === null || d.doc.slug === s.docSlug)) return d.doc.space;
    if (s.docSlug === null) return s.spaceHome.data?.space.slug ?? s.docSpace;
    return s.docSpace;
  }
  return null;
}
/** A space as the Library (or the open home's read) has it. */
function spaceDTOOf(s: AppState, slug: string | null): SpaceDTO | null {
  if (!slug) return null;
  if (s.spaceHome.data?.space.slug === slug) return s.spaceHome.data.space;
  return liveSpaces(s).find((x) => x.slug === slug) ?? s.library.data?.archived.find((x) => x.slug === slug) ?? null;
}
/** The pages of the pane's space, when the read that holds them is in (`GET /spaces/:slug`, kept in `spaceHome`). */
export function panePages(s: AppState): LibraryPageDTO[] | null {
  const slug = paneSpaceSlug(s);
  const h = s.spaceHome.data;
  return slug && h && h.space.slug === slug ? h.pages : null;
}

/**
 * The Library's frame for a space's home, a doc page and New page: the docs pane (252px, the space's page tree)
 * beside the content, which scrolls on its own (`#cnpy-libmain`). The frame is the same element on all three screens
 * of a space (the page's `data-morph` is `lib:<space>`), so the pane — its rows, its open chevrons, its scroll — is
 * patched, never rebuilt; the content is keyed per screen (`key`), so another screen or doc replaces it whole. The pane
 * shows only once the org has a space (or while the Library is still being read). Narrow screens show the pane OR the
 * content (`docsTree`, the bar's Pages button).
 */
function libraryFrame(s: AppState, content: string, key: string): string {
  const slug = paneSpaceSlug(s);
  const space = spaceDTOOf(s, slug);
  const libPending = s.library.status === "idle" || (s.library.status === "loading" && !s.library.data);
  // A space the read says is not there (`#library/<unknown>`): no tree to show, so no pane — never one "loading" forever.
  const noSuchSpace = s.screen === "space" && space === null && s.spaceHome.status === "ok" && s.spaceHome.data === null;
  const showPane = !noSuchSpace && (libPending || liveSpaces(s).length > 0 || space !== null);
  if (!showPane) return `<div class="cnpy-libframe is-solo"><div id="cnpy-libmain" class="cnpy-libmain cnpy-scroll" data-morph-key="${attr(key)}">${content}</div></div>`;
  const pages = panePages(s);
  const h = s.spaceHome;
  const pane = docsPane({
    space, pages,
    error: pages === null && h.status === "error" && (h.data === null || h.data.space.slug !== slug),
    activeSlug: s.screen === "docs" ? s.docSlug : null,
    open: s.treeOpen,
    menu: s.treeMenu,
    canArchive: h.data?.space.slug === slug && h.data.can_archive === true,
  });
  const label = space ? `${space.name} pages` : "Pages";
  return `<div class="cnpy-libframe" data-tree="${s.docsTree ? "1" : "0"}">
    <div class="cnpy-docs-bar"><button type="button" data-act="docsTree" class="cnpy-outlinebtn" aria-expanded="${s.docsTree}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h13"></path></svg>${s.docsTree ? "Back to the page" : esc(label)}</button></div>
    ${pane}
    <div id="cnpy-libmain" class="cnpy-libmain cnpy-scroll" data-morph-key="${attr(key)}">${content}</div>
  </div>`;
}

/** A doc page (`#doc/<slug>`) in the frame. With no doc picked, the page drawn empty with New page in the space. */
function docScreen(s: AppState): string {
  const slug = paneSpaceSlug(s);
  const d = s.docDetail.data;
  // An archived page reads read-only (0083_doc_archive): no Tags row to edit.
  const tagsRow = d && (s.docSlug === null || d.doc.slug === s.docSlug) && !d.page?.archived
    ? itemTagsRow({ tags: d.tags ?? [], list: s.tags.data?.tags ?? null, busy: s.tagsUi.itemBusy, dd: s.dd, bare: true })
    : "";
  // No doc named (the tree is open with nothing picked): the page is empty once the tree is in, a skeleton before.
  const detail = s.docSlug === null && panePages(s) === null ? { status: "loading", data: null } : s.docDetail;
  const content = docPageView({
    slug: s.docSlug, detail, space: spaceDTOOf(s, d?.doc.space ?? slug), emptySpace: slug && spaceDTOOf(s, slug)?.archived !== true ? slug : null,
    persons: s.persons.data, showHistory: s.showHistory, tagsRow,
  });
  return libraryFrame(s, content, `doc:${s.docSlug ?? ""}`);
}

/** A space's home, around the pure view: a failed read keeps its error, an unknown space says so. */
function spaceScreen(s: AppState): string {
  const h = s.spaceHome;
  const mine = h.data !== null && h.data.space.slug === s.spaceSlug;
  if (h.status === "error" && !mine) return libraryFrame(s, notice("Couldn't load this space."), "space");
  if (h.status === "ok" && h.data === null) return libraryFrame(s, notice("There is no space here. It may have been renamed, or the link is wrong."), "space");
  return libraryFrame(s, spaceHomeView({ slug: s.spaceSlug, home: h, tab: s.spaceTab, admin: viewerIsAdmin(s), persons: s.persons.data, descDraft: s.libUi.desc, restoring: s.libUi.pageRestoring, headMenu: s.libUi.headMenu }), "space");
}
/** New page in the frame: the pane shows the space it will go in. */
function newDocScreen(s: AppState): string {
  return libraryFrame(s, newDocView({ draft: s.nd, spaces: liveSpaces(s), pages: panePages(s), sections: ASSIGN_OPTIONS.sections, dd: s.dd, admin: viewerIsAdmin(s) }), "newdoc");
}
/** The space on screen (a space's home), when its read is in. */
const openSpaceDTO = (s: AppState): SpaceDTO | null => (s.spaceHome.data && s.spaceHome.data.space.slug === s.spaceSlug ? s.spaceHome.data.space : null);
/** The Library screens' dialogs — root-level overlays of a page that is patched in place (`data-morph`). */
function libraryOverlays(s: AppState): string {
  const ui = s.libUi;
  const spaces = liveSpaces(s);
  const sp = openSpaceDTO(s);
  const out: string[] = [];
  if (ui.space && viewerIsAdmin(s)) {
    out.push(spaceDialog(ui.space, spaces));
  }
  if (ui.owners && sp && s.screen === "space") out.push(ownersDialog(sp, ui.owners, s.persons.data));
  if (ui.archive && sp && s.screen === "space" && viewerIsAdmin(s)) out.push(archiveDialog(sp, ui.archive));
  if (ui.pageArchive && (s.screen === "space" || s.screen === "docs" || s.screen === "newdoc")) out.push(archivePageDialog(ui.pageArchive));
  // A doc's History, in a dialog over the page.
  const dd = s.docDetail.data;
  if (s.screen === "docs" && s.showHistory && dd && (s.docSlug === null || dd.doc.slug === s.docSlug)) out.push(docHistoryDialog(dd.versions, dd.doc, s.persons.data));
  return out.join("");
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
/** One sprint card as a shape (its title and badge, two lines about it, the progress bar) —
 *  the Roadmap's loading skeleton and its empty layout. */
const sprintCardShape = (i: number): string => skCard(`<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">${skLine(skW(i, ["46%", "58%", "38%"]), 15, 1.4)}${skBox(64, 20)}</div>
      <div style="margin-top:6px">${skLines(["92%", skW(i, ["54%", "70%"])], 13, 1.55)}</div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:11px">${skBar("100%", 5, "flex:1")}${skBar(46, 8)}</div>`, "padding:16px 18px;margin-bottom:10px");
/** The Roadmap's empty sentences (the Guide › Roadmap and sprints). */
export const ROADMAP_EMPTY = {
  sprints: "No sprints yet. A sprint gathers tickets toward a due date; its card here shows its lead, its due date and how many of its tickets are closed.",
  narrative: "No plan narrative yet. An admin writes it with the update-plan skill, and it reads here above the sprints.",
} as const;

function roadmapSprintGroups(s: AppState): string {
  const sprints = s.roadmap.data.sprints;
  // No sprint at all: the group a new sprint lands in (Upcoming — it is created unscheduled and
  // inactive), its heading in a neutral tone, and its cards drawn empty.
  if (sprints.length === 0) {
    return `<div style="display:flex;align-items:center;gap:9px;margin:28px 0 12px"><span style="font-size:11px;font-weight:600;font-family:var(--label);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40)">Sprints</span><div style="flex:1;height:1px;background:var(--border)"></div></div>${
      emptyLayout("roadmap-sprints", { text: ROADMAP_EMPTY.sprints, action: { label: "New sprint", act: "nsToggle" }, sayStyle: "margin-bottom:10px", shapes: skList(2, sprintCardShape) })}`;
  }
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
      : `${sectionHeading(heading, color)}<div class="cnpy-stagger">${items.map((sp) => sprintCard(sp, s.persons.data, { done: isDone(sp), nextUp: sp.id === nextId, now, ai: s.ai, riseT: s.rmRise?.sprints.includes(sp.id) ? now - s.rmRise.at : null })).join("")}</div>`;

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

/** The Roadmap while the plan's first read is out — in the page frame, under the real tab
 *  bar, of whichever tab is open: the narrative card and sprint cards beside the aside's
 *  two boxes, or the Timeline's rows. */
function roadmapSkeleton(s: AppState): string {
  const label = "Loading roadmap&hellip;";
  if (s.roadmapTab !== "narrative") {
    return `<div class="cnpy-scroll cnpy-cols-page" style="max-width:1200px;margin:0 auto;padding:var(--cols-pad-top) 32px 80px">
    ${roadmapTabBar(s)}<div${tabPanelAttrs("roadmap-tab", s.roadmapTab)} style="padding-top:20px">${roadmapNewSprint(s)}${skeleton("roadmap-timeline", label, timelineShapes(6))}</div>
  </div>`;
  }
  const sprint = sprintCardShape;
  const main = `${roadmapNewSprint(s)}${skeleton("roadmap", label, `${skCard(`${skLine(104, 12, 1.5)}<div style="margin-top:8px">${skLines(["100%", "94%", "62%"], 14.5, 1.7)}</div>`, `${RM_CARD};padding:18px 20px`)}
      <div style="display:flex;align-items:center;gap:9px;margin:28px 0 12px">${skBox(7, 7)}${skLine(84, 11, 1.5)}</div>${skList(2, sprint)}
      <div style="display:flex;align-items:center;gap:9px;margin:28px 0 12px">${skBox(7, 7)}${skLine(70, 11, 1.5)}</div>${skList(2, (i) => sprint(i + 2))}`)}`;
  const aside = `<section${surface(`${RM_CARD};padding:16px 18px`, { cls: "cnpy-rise" })} data-screen-label="Roadmap · Now">${skeleton("roadmap-now", label, `${skLine(40, 11.5, 1.5)}<div style="margin-top:6px">${skLine("62%", 15, 1.4)}</div><div style="margin-top:2px">${skLine("44%", 12.5, 1.5)}</div>${skBar("100%", 4, "margin-top:12px")}`)}</section>${roadmapHappenings(s)}`;
  return asideColumns(main, aside, { bar: roadmapTabBar(s), panel: tabPanelAttrs("roadmap-tab", s.roadmapTab) });
}

function roadmapView(s: AppState): string {
  if ((s.roadmap.status === "loading" || s.roadmap.status === "idle") && s.roadmap.data.sprints.length === 0 && !s.roadmap.data.narrative) {
    return roadmapSkeleton(s);
  }
  if (s.roadmap.status === "error") {
    return `<div class="cnpy-scroll" style="max-width:820px;margin:0 auto;padding:32px 40px 100px">${notice("Couldn't load the roadmap.")}</div>`;
  }
  if (s.roadmapTab === "narrative") return roadmapDigest(s);
  return roadmapTimelineTab(s);
}

/**
 * The ADMIN-AUTHORED plan narrative — the Roadmap's "What's happening" card. The narrative is three parts, Now /
 * Next / Later, enforced at write (shared/sprints-core › the plan narrative's shape), so the card draws a STRUCTURED
 * box: three rows (`.rm-nnl`), each its label in the card's label face beside its text, hairlines between them.
 * An OLDER free-text narrative that does not parse is drawn as before — plain markdown (legacy fallback). Every
 * piece of narrative text goes ONLY through markdownFn — it is DB-sourced prose, so it must be sanitized the same
 * way doc bodies are (real callers pass renderMarkdown, i.e. DOMPurify); it is never additionally esc()'d (that would
 * double-encode markdownFn's own escaping/output). Empty narrative → the existing dashed-card empty-state hint.
 * `riseT`: ms since an accepted narrative landed (`AppState.rmRise`) — the box rises in (`rmRising`).
 */
export function planNarrativeBlock(narrative: string, markdownFn: (body: string) => string, trov = "", riseT: number | null = null): string {
  const rise = rmRising(riseT);
  const riseCls = rise ? " cnpy-flash" : "";
  const riseStyle = rise ? ` style="animation-delay:-${Math.round(riseT!)}ms"` : "";
  const parts = narrative.trim() ? parsePlanNarrative(narrative) : null;
  const body = parts
    ? planNarrativeBox(parts, markdownFn, { cls: riseCls, attrs: riseStyle })
    : narrative.trim()
      ? `<div class="cnpy-md${riseCls}"${riseStyle}>${markdownFn(narrative)}</div>`
      : emptyLayout("roadmap-narrative", { text: ROADMAP_EMPTY.narrative, plain: true, sayStyle: "margin-bottom:10px", shapes: skLines(["100%", "94%", "62%"], 14.5, 1.7) });
  return `<section${surface(`${RM_CARD};padding:18px 20px`, { cls: "cnpy-rise rm-narrative" })}>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 8px;min-height:22px"><div style="font-size:12px;font-weight:500;color:var(--fg-40)">What's happening</div>${trov}</div>
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
  // Trov's suggestions and drift (./roadmap-ai.ts) are not in the flow (the owner's call): the narrative card's Trov
  // button opens them in a dialog (`rmTrovOpen`, drawn with the overlays). "" when there are none.
  const d = s.roadmap.data;
  const trov = roadmapTrovButton(roadmapTrovCount(d.suggestions, d.drift, s.ai));
  // What an Accept just changed rises in (`rmRise`, set by ai-actions.ts once the Roadmap's re-read landed).
  const riseT = s.rmRise ? Date.now() - s.rmRise.at : null;
  return asideColumns(`${roadmapNewSprint(s)}${planNarrativeBlock(d.narrative, renderMarkdown, trov, s.rmRise?.narrative ? riseT : null)}${roadmapSprintGroups(s)}`, roadmapAside(s),
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

  return `${now}${roadmapHappenings(s)}`;
}

/** The Narrative aside's second box, "Recent happenings" (the live feed, with GitHub chips).
 *  Its OWN unfiltered read (s.roadmapFeed), so a Feed-screen author/tag filter never narrows
 *  it, and a failed read says so instead of "no activity". */
const happeningShapes = (n: number): string =>
  skList(n, (i) => `<div style="display:grid;grid-template-columns:44px minmax(0,1fr);gap:10px;padding:9px 18px;border-top:1px solid var(--border)">${skLine(26, 12, 1.6)}<span style="display:block;min-width:0">${skLines(["100%", skW(i, ["58%", "74%", "40%", "66%"])], 13, 1.5)}</span></div>`);
function roadmapHappenings(s: AppState): string {
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
      : feed.status === "ok" ? asideEmpty("roadmap-happenings", "No recent activity yet.", happeningShapes(2))
      : skeleton("roadmap-happenings", "Loading&hellip;", happeningShapes(HAPPENINGS_LIMIT))}
  </section>`;
  return happenings;
}

// ── search ───────────────────────────────────────────────────────────────────
// The ticket icon is the sidebar family's ticket glyph (a stub with a notch),
// drawn at the same 24-viewBox scale as the rest of this map.
const SEARCH_TYPE_ICON: Record<string, string> = { feed: "M4 5h16M4 12h16M4 19h10", doc: "M6 3h7l5 5v13H6z", decision: "M9 12l2 2 4-4", sprint: "M5 3v18M5 4h11l-2 3 2 3H5", artifact: "M3 4h18v16H3zM3 9h18M7 13.5h6M7 16.5h9" };
// The "sprint" type covers the plan narrative + the sprints, so its badge keeps
// reading "Roadmap" — the screen it navigates to.
const SEARCH_TYPE_LABEL: Record<string, string> = { doc: "Doc", feed: "Feed", decision: "Decision", sprint: "Roadmap", artifact: "Artifact" };

// A hit's kind as its icon and word, and its authority as a mark only when it is not live
// (`authorityMark`, marks.ts: /search is live-only, so a person normally sees no mark at all).
function searchTypeLabel(type: string): string {
  const label = SEARCH_TYPE_LABEL[type] ?? type;
  const icon = SEARCH_TYPE_ICON[type] ?? SEARCH_TYPE_ICON["doc"];
  return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--fg-55);white-space:nowrap"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="${icon}"></path></svg>${esc(label)}</span>`;
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
  const inner = `<div style="display:flex;align-items:center;gap:12px;margin-bottom:7px;flex-wrap:wrap">${searchTypeLabel(r.type)}${authorityMark(r.authority)}</div>
    <div style="font-size:14.5px;font-weight:500;letter-spacing:-0.01em;margin-bottom:6px">${esc(r.title)}</div>
    <div style="font-size:13px;line-height:1.6;color:var(--fg-55)">${highlight(preview, sq)}${r.body.length > 280 ? "…" : ""}</div>`;
  const act = searchOpenAttr(r.type, r.id);
  return act
    ? `<button ${act}${surface("display:block;width:100%;text-align:left;padding:16px 18px;margin-bottom:10px;cursor:pointer", { hover: true })}>${inner}</button>`
    : `<div${surface("display:block;width:100%;text-align:left;padding:16px 18px;margin-bottom:10px")}>${inner}</div>`;
}

function pointerRow(r: QueryPointer, sq: string): string {
  const inner = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap"><span style="font-size:13px;font-weight:500;letter-spacing:-0.01em">${esc(r.title)}</span>${searchTypeLabel(r.type)}${authorityMark(r.authority)}</div>
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
  // A re-query (every keystroke is one) keeps the results on screen until the new ones
  // land; only a search with nothing to show yet gets the skeleton.
  if (s.searchResults.status === "loading" && primary.length === 0 && pointers.length === 0) {
    body = skeleton("search", "Searching&hellip;", skList(4, (i) => skCard(`<div style="display:flex;align-items:center;gap:8px">${skBox(46, 18)}${skLine(skW(i, ["52%", "38%", "64%", "46%"]), 14.5, 1.5, "flex:1")}</div><div style="margin-top:8px">${skLines(["100%", skW(i + 1)], 13, 1.6)}</div>`, "padding:16px 18px;margin-bottom:12px")));
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
/** What each Guide screenshot shows (web/public/guide/<name>-<theme>[-1720].webp), as its text alternative. Generic
 *  on purpose: the screen, not what one capture holds — the captures will be retaken. */
export const GUIDE_ALT: Record<string, string> = {
  mywork: "The My Work screen: your open tickets, what needs your review, and recent activity",
  docs: "The Docs screen: the library tree beside an open document",
  feed: "The Feed: a timeline of what people and agents shipped",
  tickets: "The Tickets screen as a table, grouped by sprint",
  board: "The ticket board, one column per status",
  ticket: "A ticket opened: its description, status, assignees and comments",
  roadmap: "The Roadmap's narrative: the plan beside its sprint cards",
  timeline: "The Roadmap's timeline: each sprint as a bar on a calendar",
  sprint: "A sprint opened: its tickets and progress",
  handoffs: "Relay: handoffs left for the next session, and links between sessions",
  artifacts: "The Artifacts library",
  artifact: "An artifact opened in the viewer",
  prompts: "The Prompt Library",
  review: "The Review screen: staged proposals waiting for a person's verdict",
  maintenance: "The Unplaced screen: entries waiting to be placed or discarded",
  repo: "The Repo dashboard: environments, deploys and CI",
  "repo-usage": "The Repo dashboard's usage view",
  search: "Search results across docs, tickets and the feed",
  quicksearch: "Quick search, open over the app",
  settings: "The Settings screen",
  releases: "The What's new screen",
};
export const guideAlt = (name: string): string => GUIDE_ALT[name] ?? "A screenshot of Trov";
/** The column-sized capture's width: twice the guide column's 860 px. scripts/guide-images.mjs
 *  (`GUIDE_COLUMN_W`) writes `<name>-<theme>-1720.webp` beside the full 2560-wide `<name>-<theme>.webp`. */
const GUIDE_SHOT_W = 1720;
/** One Guide figure's image: the column-sized WebP, the full one offered for a 3× screen, decoded off the
 *  main thread; `data-full` is what the lightbox opens (main.ts `guideZoom`). */
export function guideImg(name: string, theme: string): string {
  const base = `/guide/${name}-${theme}`;
  return `<img src="${base}-${GUIDE_SHOT_W}.webp" srcset="${base}-${GUIDE_SHOT_W}.webp ${GUIDE_SHOT_W}w, ${base}.webp 2560w" sizes="(max-width: 860px) 100vw, 860px" data-full="${base}.webp" alt="${attr(guideAlt(name))}" loading="lazy" decoding="async" width="2560" height="1600" />`;
}

/** The Guide's opening, in its banner. */
const GUIDE_LEDE = `Trov is the team's shared memory: docs, decisions, the roadmap, the ticket queue, and a running record of what shipped, open to people and to their coding agents alike. It has one rule: <strong>agents only ever stage changes, and a person confirms the ones that matter</strong>. That keeps what Trov says trustworthy no matter how many agents write to it.`;

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
  // Each figure's text alternative says which screen it shows, in general terms (`GUIDE_ALT`: the captures
  // will be retaken, so it never describes what one capture happens to hold); the button's name repeats it.
  const gFig = (name: string, cap: string) => `<figure style="margin:18px 0 4px">
      <button data-act="guideZoom" data-arg="${name}" class="cnpy-guide-shot" aria-label="${attr(`Expand screenshot: ${guideAlt(name)}`)}">
        ${guideImg(name, th)}
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

    <p style="${gP}">This page is the reference: the skills your agent uses every session, how a change goes from staged to settled, a tour of every screen, how accounts and agent connections work, and troubleshooting.</p>
    ${viewerOrg(s) ? `<div${surface("display:flex;align-items:center;gap:10px 16px;flex-wrap:wrap;padding:14px 16px;margin:0 0 6px")} data-guide-setup>
      <div style="flex:1 1 260px;min-width:0"><div style="font-size:13.5px;font-weight:600">Still setting up?</div><div style="font-size:12.5px;line-height:1.5;color:var(--fg-55);margin-top:1px">The guided setup takes ${esc(viewerOrg(s)!.name)} one step at a time${viewerIsAdmin(s) ? ": a repository, your coding agent, your team" : ": your coding agent, then where things live"}.</div></div>
      <button type="button" data-act="welcomeOpen" data-field="guideWelcomeOpen" class="cnpy-ghostbtn" style="height:32px;padding:0 13px;border-radius:8px;font-size:12.5px;font-weight:500;white-space:nowrap;border:1px solid var(--border);color:var(--fg);background:transparent">Open the guided setup</button>
    </div>` : ""}

    ${sec("Every session", "Orient, work, record", "The skills")}
    <p style="${gP}">The plugin's skills are how your agent keeps Trov current. Three of them form a loop you'll use every session, ${gStrong("orient → work → record")}:</p>
    <ul style="${gList}">
      <li>${gStrong("trov")}: the overview. It explains the whole system and every tool. Ask about it when you're unsure where something lives.</li>
      <li>${gStrong("load-context")}: ${gStrong("runs on its own")} before your agent works on an area the team already knows about, and always before it proposes a doc change. It reads what Trov has, checks what's settled and what's only proposed, and at the start of a session shows your My Work and any handoffs waiting for you. It never writes.</li>
      <li>${gStrong("record-session")}: ${gStrong("only when you ask")} ("record this session"). It checks what actually shipped with ${gCode("git")} and ${gCode("gh")}, reads back the docs it touched, and stages one batch of updates: feed entries, doc changes, and decisions. Repeats are dropped; something it isn't sure of is staged flagged "Low confidence", or left out and mentioned to you.</li>
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
    <p style="${gP}">The ${gStrong("Library")} is split into spaces your team defines, like ${gStrong("Engineering")}, ${gStrong("Product")} and ${gStrong("Design")}, and a space's pages form a tree beside the page you are reading: drag a page onto another to put it inside, or above or below one to reorder them. A page links to another with ${gCode("[[its-slug]]")}, and each page lists the pages that link to it. ${gStrong("History")} keeps every earlier version. ${gStrong("New page")} starts one from a template and sends it to Review.</p>
    ${gFig("docs", `${gEm("Docs")}: a space's page tree beside the page, its contents in the rail, and a banner pointing to a change awaiting review.`)}
    <p style="${gP};margin-top:14px">${gStrong("Search")} is the box at the top of the sidebar (${gCode("⌘K")}, or ${gCode("Ctrl K")} on Windows and Linux). Type and pause: a dropdown jumps straight to a ticket, doc, decision, sprint, artifact, prompt, handoff, person, or screen. Press ${gCode("Tab")} for the full ${gStrong("Search")} screen, which ranks docs, decisions, the feed, the roadmap, and artifacts. Both show only settled content. Your agent's ${gCode("query")} tool also sees tickets and pending proposals, each labelled, so it can tell settled context from a draft.</p>
    ${gFig("quicksearch", `${gEm("Search everything")}: matches grouped by type as you type, with a jump to the full results.`)}
    ${gFig("search", `${gEm("Search")}: ranked results across every type, with your query highlighted.`)}

    ${sub("How agent writes are staged")}
    <p style="${gP}">When an agent proposes a doc change or drafts a decision (an ADR), it becomes a ${gStrong("staged")} version. The live doc stays untouched until a person promotes the change. Each proposal is labelled ${gStrong("new")}, ${gStrong("edit")}, or ${gStrong("rewrite")}, and an edit written against an out-of-date version is flagged. Sending the same content twice changes nothing, so re-running a session doesn't pile up noise. Docs can include images too: your agent uploads each image to Trov first and then references it, and a proposal that points at an image that isn't uploaded (or at one elsewhere on the web) is refused. Click any image to see it full size. No agent tool can promote, ratify, or reject anything. Those buttons only exist here, in the web app.</p>

    ${sub("Review: promote, ratify, or reject")}
    <p style="${gP}">${gStrong("Triage › Review")} is one queue for everything awaiting a decision. A doc proposal shows as a diff against the live version (unified, side by side, or rendered). ${gStrong("Promote")} makes it live; ${gStrong("Reject")} sets it aside. A drafted decision shows the proposed record: ${gStrong("Ratify")} or ${gStrong("Reject")} it. Nothing is deleted either way, and the sidebar count shows what's waiting.</p>
    ${gFig("review", `${gEm("Review")}: the queue on the left and the selected proposal's diff on the right.`)}
    <p style="${gP};margin-top:14px">${gStrong("Triage › Unplaced")} holds the few things an agent couldn't place (Trov now refuses or flags most of them instead), and empty is its normal state. Place an item where it belongs or ${gStrong("Discard")} it (you can undo a discard).</p>
    ${gFig("maintenance", `${gEm("Unplaced")}: the queue, waiting to be routed or discarded.`)}
    <p style="${gP};margin-top:14px">Running the organization itself is in one place: ${gStrong("Org settings")}, from the switcher at the top of the sidebar. ${gStrong("Members")} is the people directory. Admins also invite people there, set roles and titles, and match an unrecognized GitHub login to a person. ${gStrong("Notifications")} is where admins set the email digests: which exist, when they send, and what went out. Your own digest preferences stay in ${gStrong("Settings")}.</p>

    ${sec("Tour", "Every screen, top to bottom", "Tour")}
    <p style="${gP}">The sidebar groups screens into ${gStrong("Workspace")}, ${gStrong("Monitor")}, ${gStrong("Knowledge")}, ${gStrong("Triage")}, and ${gStrong("Help")} (this guide and What's new). A chevron opens a screen's sub-pages, ${gStrong("Collapse")} folds the rail to icons, and every screen has its own address (${gCode("#tickets/7")}, ${gCode("#artifacts")}) you can send to a teammate. On a phone the sidebar opens as a drawer.</p>

    ${sub("My Work")}
    <p style="${gP}">Trov opens here. ${gStrong("Tickets for you")}: your open tickets, with their sprint and when it is due. ${gStrong("Needs your review")}: what agents staged, with Promote, Ratify and Reject right there. ${gStrong("Your sessions")}: what you recorded lately and the handoffs waiting for you. ${gStrong("Repo")}: pull requests, CI and deploys at a glance. Under them, the docs you own, artifacts published this week, and handoffs queued for you, each with ${gStrong("Copy")} to paste it into a fresh session as a prompt. It reads only what Trov has already captured, so it loads instantly. Admins also get ${gStrong("Sync GitHub")} in the header: it opens a panel that says what a sync reads and writes, shows its progress pass by pass, and keeps the result until you dismiss it.</p>
    ${gFig("mywork", `${gEm("My Work")}: your tickets, the review queue, your sessions, and the repo at a glance.`)}

    ${sub("Tickets")}
    <p style="${gP}">The team's request queue. Anyone can file a bug, request, question, or access ask with ${gStrong("Submit a ticket")}. The ${gStrong("Board")} is the default view, one column per status: ${gStrong("Triage")}, ${gStrong("In progress")}, ${gStrong("Testing")}, and ${gStrong("Done")}. Declined tickets are left out of ${gStrong("All")}; pick ${gStrong("Closed")} to see them in their own ${gStrong("Declined")} column. Drag a card to change its status or its place in a column. An open ticket can move to any column, and Testing is optional. ${gStrong("Table")} lists the same tickets grouped by sprint (no sprint means ${gStrong("Backlog")}). Both have a search box and a ${gStrong("Filter")} menu.</p>
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

    ${sub("Relay")}
    <p style="${gP}">A handoff is a note from one session to the next: the task, what's done, what's next, the files that matter, and optionally a ready-to-run prompt. Your agent leaves one with the ${gStrong("handoff")} skill, addressed to you, a teammate, or anyone. At the start of your next session, load-context lists the ones waiting and claims only the one you pick. Unclaimed handoffs expire after 7 days. The sidebar count is what's waiting for you.</p>
    <p style="${gP};margin-top:14px">${gStrong("Links")} let two sessions whose work overlaps leave each other short notes: two of yours (a coding agent, a web chat, an Ask thread), or yours and a teammate's. A link is one-to-one and short-lived. A person starts every link: one between your own sessions opens at once, and a teammate accepts or declines one you send. A note reaches the other side when it next checks: a Claude Code agent with the plugin at each prompt and after each commit or push, a chat when you ask. When the work lands, either side closes the link, and its thread stays readable. You can have at most ${LINK_LIVE_MAX} links sent or open at a time.</p>
    ${gFig("handoffs", `${gEm("Relay")}: a landing page with a card for each half and the agents you have connected. Handoffs lists pending ones first, then claimed and expired history; Links lists requests waiting for you, open links, yours and closed ones.`)}

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

    ${sec("Reference", "Accounts and organizations", "Accounts")}
    <ul style="${gList}">
      <li>${gStrong("One account, either sign-in.")} Signing in with GitHub or with Google creates your account the first time. ${gStrong("Settings › Account")} links the other one, and then either signs you in.</li>
      <li>${gStrong("Handle and color.")} You picked them when you signed up; both can be changed in ${gStrong("Settings › Profile")}. The handle is how work is attributed to you everywhere.</li>
      <li>${gStrong("Organizations.")} Everything in Trov belongs to one. You join by accepting an invitation, or create a Free one of your own (one at a time). The switcher at the top of the sidebar shows the one you're in and takes you to the others; each has its own docs, tickets, roadmap and feed.</li>
      <li>${gStrong("A repository needs GitHub.")} Connecting one is approved on GitHub, so an owner or admin who signed up with Google links a GitHub account first (the guided setup offers it).</li>
    </ul>

    ${sec("Reference", "Connecting a coding agent", "Connect an agent")}
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
    <p style="${gP}">${gStrong("Claude on the web and Claude Desktop")} take Trov as a custom connector: in Claude's Settings › Connectors, choose ${gStrong("Add custom connector")} and enter that address. A chat is in no repository, so on the Allow page pick ${gStrong("Manual")} and the organizations it may use. There are no skills there: ask in words (“what's on my plate in Trov?”). ${otherClientsLink()}</p>
    ${gFig("settings", `${gEm("Settings")}: profile, sign-in methods, MCP access, appearance, and email digests.`)}

    ${sec("Troubleshooting", "When something doesn't work", "Troubleshooting")}
    <ul style="${gList}">
      <li>${gStrong("You signed in and see no organization.")} Ask an admin of your team's organization to invite your GitHub login or email from ${gStrong("Org settings › Members")}; the invitation appears the next time you open Trov. Or create a Free organization yourself: one you own at a time.</li>
      <li>${gStrong("Google sign-in says the address isn't verified.")} Trov signs you in by the address Google confirms. Verify it with Google and sign in again, or sign in with GitHub.</li>
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
  // The brand banner the site's pages open with (brand-banner.ts — the owner's call): the title and what Trov is.
  const banner = brandBanner({ title: "How Trov works", titleId: "guide-top", titleCls: "cnpy-guide-anchor", lede: GUIDE_LEDE });
  return `<div class="cnpy-guide-page" style="max-width:1180px;margin:0 auto;padding:28px 40px 120px">
    ${banner}
    <div class="cnpy-guide" style="display:flex;gap:56px;align-items:flex-start;margin-top:44px">
    ${rail}
    ${body}
    </div>
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

/** Settings › Profile: photo, display name, handle and color (the title is set by an org admin in Org settings › Members).
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
  return `<section class="cnpy-tile cnpy-surface cnpy-set-profile">
    <div style="${SECTION_LABEL}">Profile</div>
    <div style="display:flex;align-items:flex-start;gap:14px">
      ${photo}
      <div style="flex:1;min-width:0">
        <label style="${FIELD_LABEL}">Display name</label>
        <div class="cnpy-set-name" style="display:flex;gap:10px">
          <input data-act="setDisplayName" data-field="displayName" value="${attr(s.displayName)}" class="cnpy-input" style="flex:1;min-width:0;height:40px;padding:0 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:14px;outline:none" />
          <button data-act="saveProfile" class="cnpy-accentbtn" style="padding:0 16px;height:40px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:13.5px;font-weight:600">Save</button>
        </div>
        ${handleRow}
      </div>
    </div>
    <div class="cnpy-tile-foot" style="padding-top:20px"><div id="set-color-l" style="${FIELD_LABEL}">Your color</div>${swatches("setMyColor", me?.color ?? "stone", true, "set-color-l")}</div>
  </section>`;
}

/** Settings › Account: the sign-in methods — GitHub and Google, each linked or not, with Link /
 *  Unlink (the last identity can't be unlinked, and its button says why). Who is signed in, and
 *  Sign out, are the Session tile's (`sessionSection`).
 *  Pure over AppState — exported for the pure render test. */
export function accountSection(s: AppState): string {
  const me = s.me;
  const last = (me?.identities.length ?? 0) <= 1;
  const provRow = (p: "github" | "google", label: string) => {
    const id = me?.identities.find((i) => i.provider === p);
    const btn = id
      ? `<button data-act="unlinkProvider" data-arg="${p}" class="cnpy-ghostbtn" ${last ? `disabled title="Link another sign-in method before unlinking this one" ` : ""}style="font-size:12px;color:var(--fg-40);padding:4px 10px;border-radius:6px;border:1px solid var(--border);${last ? "opacity:.45;cursor:default" : ""}">Unlink</button>`
      : `<button data-act="linkProvider" data-arg="${p}" class="cnpy-ghostbtn" style="font-size:12px;color:var(--fg-70);padding:4px 10px;border-radius:6px;border:1px solid var(--border-strong)">Link ${label}</button>`;
    return `<div data-provider="${p}" style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--border)"><div style="line-height:1.25;min-width:0"><b style="font-size:13.5px;font-weight:600;display:block">${label}</b><span style="font-family:var(--label);font-size:11.5px;color:${id ? "var(--fg-55)" : "var(--fg-40)"};overflow-wrap:anywhere">${id ? esc(id.label) : "not linked"}</span></div>${btn}</div>`;
  };
  return `<section class="cnpy-tile cnpy-surface cnpy-set-account">
    <div style="${SECTION_LABEL}">Account</div>
    <div style="font-size:13px;font-weight:500;margin-bottom:8px">Sign-in methods <span style="font-weight:400;color:var(--fg-40)">· keep one linked</span></div>
    ${provRow("github", "GitHub")}${provRow("google", "Google")}
    <div class="cnpy-tile-foot" style="padding-top:12px;border-top:1px solid var(--border);font-size:11.5px;line-height:1.5;color:var(--fg-40)">${last ? "Your only way in. Link the other one before unlinking it." : "Either one signs you in to the same account."}</div>
  </section>`;
}

/** Settings › Help: Contact support — the way to write to the people who run Trov (support.ts opens on
 *  Question). A slim tile on a row of its own; its button is the dialog's opener, so focus returns to it. */
export function helpSection(): string {
  return `<section class="cnpy-tile cnpy-surface cnpy-set-help">
    <div style="${SECTION_LABEL}">Help</div>
    <div class="cnpy-set-who">
      <div style="flex:1 1 260px;min-width:0">
        <div style="font-size:13.5px;font-weight:500;line-height:1.35">Contact support</div>
        <div style="font-size:12.5px;line-height:1.5;color:var(--fg-55);margin-top:3px">A question about your account, your organization or how Trov works, or feedback for us. We read every message and reply by email. To report something broken, use the bug button at the top right of any screen.</div>
      </div>
      <button data-act="supportOpen" data-arg="question" data-support-trigger="question" data-field="supportOpen:question" aria-haspopup="dialog" class="cnpy-ghostbtn" style="flex:none;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:13px;font-weight:600;color:var(--fg)">Contact support</button>
    </div>
    ${legalLinksRow()}
  </section>`;
}

/** The legal pages, the source of the version running (AGPL-3.0 §13: `/source`, the deployed commit) and the
 *  third-party notices — in Settings › Help and on Help › What's new. Static pages, so they open beside the app. */
export function legalLinksRow(): string {
  const links = [...LEGAL_LINKS, { label: "Third-party notices", path: NOTICES_PATH }]
    .map((l) => `<a href="${l.path}" target="_blank" rel="noopener" class="cnpy-mutelink" style="color:var(--fg-55)">${esc(l.label)}</a>`)
    .join(`<span aria-hidden="true"> · </span>`);
  return `<nav class="cnpy-legal-links" aria-label="Legal and source" data-legal-links style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);font-size:12px;line-height:1.7;color:var(--fg-40)">${links}</nav>`;
}

/** Settings › Session: who is signed in on this browser, and SIGN OUT — a labelled button with its
 *  icon, in a tile of its own at the top right of the page (last on a phone), never a quiet link.
 *  Pure over AppState — exported for the pure render test. */
export function sessionSection(s: AppState): string {
  const me = s.me;
  const org = currentOrg(s);
  // (How many organizations, and each one's plan, is the Organizations tile's to say.)
  const memberLine = org ? `${org.role === "member" ? "Member" : org.role === "owner" ? "Owner" : "Admin"} of ${org.name}` : "Signed in";
  const icon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="m16 17 5-5-5-5"></path><path d="M21 12H9"></path></svg>`;
  return `<section class="cnpy-tile cnpy-surface cnpy-set-session">
    <div style="${SECTION_LABEL}">Session</div>
    <div data-account-who class="cnpy-set-who">
      <div style="flex:1 1 150px;min-width:0">
        <div style="font-size:13.5px;font-weight:500;line-height:1.35;overflow-wrap:anywhere">Signed in as ${me ? handleLink({ handle: me.handle, name: me.name, color: me.color }, me.handle, 13) : ""}</div>
        <div style="display:flex;align-items:baseline;gap:6px;font-size:11.5px;line-height:1.4;color:var(--green);margin-top:4px"><span style="flex:none;width:6px;height:6px;border-radius:50%;background:var(--green);transform:translateY(-1px)"></span><span style="min-width:0;overflow-wrap:anywhere">${esc(memberLine)}</span></div>
      </div>
      <button data-act="signOut" class="cnpy-signout" style="flex:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:13px;font-weight:600;color:var(--fg)">${icon}Sign out</button>
    </div>
  </section>`;
}

// The commands and the three sign-in steps live in mcp-connect.ts (the wizard shows them too).
export { PLUGIN_INSTALL, browserConnectCommand };

/** How many Connected apps rows Settings › MCP access shows before its "Show all N". */
export const MCP_LIST_CAP = 3;

/** MY organizations, for a connection's organization toggles: the fresh list when it is loaded, else sign-in's. */
const myOrgsOf = (s: Partial<Pick<AppState, "myOrgs" | "me">>): readonly MyOrg[] => s.myOrgs?.data?.orgs ?? s.me?.orgs ?? [];

/** How a connection is scoped, as the chip beside its name: "Follows the repository", or a manual
 *  one's current organization (and how many more it may use). */
export function grantScopeChip(gr: OAuthGrantSummary, orgSlug: string | null): string {
  const chip = "flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:500;line-height:17px;padding:0 7px;border-radius:5px;border:1px solid var(--border)";
  if (gr.mode === "repo") {
    return `<span data-grant-mode="repo" title="It works in whichever of your organizations has the repository the agent is in connected" style="${chip};color:var(--fg-55)">Follows the repository</span>`;
  }
  if (!gr.org) {
    return `<span data-grant-mode="manual" data-grant-org="" title="Its current organization is no longer available to you: pick another" style="${chip};color:var(--red)">No organization</span>`;
  }
  const more = gr.orgs.length - 1;
  return `<span data-grant-mode="manual" data-grant-org="${attr(gr.org.slug)}" title="${attr(more > 0 ? `This connection is working in ${gr.org.name}, and may use ${more} more` : `This connection reaches ${gr.org.name} only`)}" style="${chip};color:${gr.org.slug === orgSlug ? "var(--fg-70)" : "var(--fg-55)"}">${esc(gr.org.name)}${more > 0 ? ` +${more}` : ""}</span>`;
}

/** The "works in" dropdown of the connection being changed (its menu is a root overlay). */
export function grantCurrentDropdown(gr: OAuthGrantSummary): DropdownProps {
  return {
    id: `grant-current-${gr.id}`, act: "grantCurrent", arg: String(gr.id), value: gr.org?.slug ?? "", size: "sm",
    ariaLabel: "Working in", options: gr.orgs.map((o) => ({ value: o.slug, label: o.name, hint: o.slug })),
  };
}
/** Settings' dropdowns: the one in the open scope dialog, when its connection is a manual one. */
export function grantDropdowns(s: Pick<AppState, "grants" | "grantScope">): DropdownProps[] {
  const gr = s.grants.data.find((x) => x.id === s.grantScope);
  return gr && gr.mode === "manual" ? [grantCurrentDropdown(gr)] : [];
}

/** What the dialog says under its switch: what the chosen mode does, in one sentence. */
export const GRANT_MODE_SENTENCE: Record<OAuthGrantSummary["mode"], string> = {
  repo: "It works in whichever of your organizations has the repository the agent is in connected. Anywhere else it reads and writes nothing.",
  manual: "It works in the organizations you turn on, one at a time. The agent can switch among them on its own; only you can add one.",
};

/** How the last change in the dialog went: saving, saved, or refused — `org` pins a refusal to that
 *  organization's row (a plan limit is that organization's), otherwise it is said at the foot. */
export interface GrantScopeNote { kind: "saving" | "saved" | "error"; text: string; org?: string }

/**
 * Settings › MCP access: ONE connection's scope, as a dialog (a root-level `data-overlay` in the
 * confirmation modal's shell — a centered card, a bottom sheet at phone width) opened by the row's
 * "Change organization…". It holds the mode switch with what the chosen mode does; for Manual, the
 * organization it is working in (a dropdown, whose menu is its own overlay above this one) and a switch
 * per organization of mine; for Follow the repository, my organizations and the rule that picks one.
 * Every change saves as it is made — there is no Save — and `note` says how the last one went, here.
 * "" when no connection is open (or the open one is gone). Exported for the pure render test.
 */
export function grantScopeDialog(s: Pick<AppState, "grants" | "grantScope"> & Partial<Pick<AppState, "grantScopeNote" | "myOrgs" | "me" | "dd">>): string {
  const gr = s.grants.data.find((x) => x.id === s.grantScope);
  if (!gr) return "";
  const mine = myOrgsOf(s);
  const dd = s.dd ?? initialDropdownUi();
  const n = s.grantScopeNote ?? null;
  const busy = n?.kind === "saving";
  const small = "font-size:12.5px;line-height:1.55;color:var(--fg-55)";
  const label = "font-size:12.5px;font-weight:600;color:var(--fg-70)";
  const mode = segmented({
    id: `grant-mode-${gr.id}`, ariaLabel: "How this connection picks an organization", value: gr.mode, act: "grantMode", size: "sm", inertOn: true, fill: true,
    options: [{ value: "repo", label: "Follow the repository", arg: `${gr.id}:repo` }, { value: "manual", label: "Manual", arg: `${gr.id}:manual` }],
  });
  const body = gr.mode === "repo"
    ? `<div data-grant-follow style="display:flex;flex-direction:column;gap:6px">
         <span style="${label}">Your organizations</span>
         ${mine.length
           ? `<ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px">${mine.map((o) => `<li data-grant-reach="${attr(o.slug)}" style="font-size:13px;color:var(--fg);overflow-wrap:anywhere">${esc(o.name)}</li>`).join("")}</ul>`
           : `<span style="${small}">You are not in an organization yet.</span>`}
         <span style="${small}">Each call uses the one that has the repository the agent is in connected (Org settings &rsaquo; Repositories).${gr.orgs.length ? ` Used so far in ${gr.orgs.map((o) => esc(o.name)).join(", ")}.` : ""}</span>
       </div>`
    : `<div style="display:flex;flex-direction:column;gap:6px">
         <span id="grant-current-l-${gr.id}" style="${label}">Working in</span>
         ${gr.orgs.length ? dropdown({ ...grantCurrentDropdown(gr), fill: true, disabled: busy }, dd) : ""}
         ${gr.org ? "" : `<span data-grant-noorg role="alert" style="font-size:12.5px;line-height:1.5;color:var(--red)">The organization it was working in is no longer available to you, so it reads and writes nothing. Pick one.</span>`}
       </div>
       <div style="display:flex;flex-direction:column;gap:8px">
         <span style="${label}">It may use</span>
         ${mine.map((o) => {
           const on = gr.orgs.some((x) => x.slug === o.slug);
           const refused = n?.kind === "error" && n.org === o.slug ? `<div data-grant-refused="${attr(o.slug)}" role="alert" style="margin:2px 0 0 46px;font-size:12px;line-height:1.5;color:var(--red)">${esc(n.text)}</div>` : "";
           return `<div data-grant-allow="${attr(o.slug)}"><div style="display:flex;align-items:center;gap:10px;min-width:0">${switchBtn("grantOrgToggle", `${gr.id}:${o.slug}:${on ? "off" : "on"}`, on).replace("<button ", `<button aria-label="${attr(`${o.name}: this connection may use it`)}"${busy ? " disabled" : ""} `)}<span style="min-width:0;font-size:13px;color:var(--fg);overflow-wrap:anywhere">${esc(o.name)}</span>${gr.org?.slug === o.slug ? `<span style="flex:none;font-size:11px;color:var(--fg-40)">working here</span>` : ""}</div>${refused}</div>`;
         }).join("")}
       </div>`;
  const tone = n?.kind === "error" ? "var(--red)" : n?.kind === "saved" ? "var(--green)" : "var(--fg-55)";
  const status = `<div data-grant-status="${n?.kind ?? "idle"}" role="status" aria-live="polite" style="flex:1;min-width:0;font-size:12.5px;line-height:1.5;color:${tone}">${n && !(n.kind === "error" && n.org) ? esc(n.text) : n?.kind === "error" ? "That change was not saved." : "Changes save as you make them."}</div>`;
  const close = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;
  return `<div data-overlay="grant-scope" class="cnpy-cmodal">
    <div data-act="grantScopeClose" class="cnpy-cmodal-back" aria-hidden="true"></div>
    <div class="cnpy-cmodal-wrap">
      <div id="grant-scope" role="dialog" aria-modal="true" aria-labelledby="grant-scope-t" aria-describedby="grant-scope-d" tabindex="-1" data-grant-scope="${gr.id}"${busy ? ` aria-busy="true"` : ""} class="cnpy-surface cnpy-cmodal-box cnpy-scroll" style="position:relative;width:min(460px, 100%);max-height:calc(100 * var(--vh) - 32px);overflow-y:auto">
        <button type="button" data-act="grantScopeClose" aria-label="Close" title="Close" class="cnpy-iconbtn" style="position:absolute;top:12px;right:12px;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;color:var(--fg-40)">${close}</button>
        <div id="grant-scope-t" style="padding-right:32px;font-size:16px;font-weight:600;letter-spacing:-0.01em;overflow-wrap:anywhere">${esc(gr.client_name)} &middot; how it picks an organization</div>
        <div style="display:flex;flex-direction:column;gap:16px;margin-top:14px">
          <div style="display:flex;flex-direction:column;gap:8px">${mode}<p id="grant-scope-d" data-grant-mode-says="${gr.mode}" style="margin:0;${small}">${GRANT_MODE_SENTENCE[gr.mode]}</p></div>
          ${body}
        </div>
        <div class="cnpy-cmodal-btns" style="display:flex;align-items:center;gap:12px;margin-top:18px">${status}<button type="button" data-act="grantScopeClose" data-grant-done class="cnpy-confirm-go" style="flex:none;padding:8px 18px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:13px;font-weight:600">Done</button></div>
      </div>
    </div>
  </div>`;
}

/** Settings › MCP access › Connected apps: a heading with its count, then one hairline row
 *  per OAuth connection — the app's self-reported name, when it connected and was last
 *  used, and a two-click Revoke — the first MCP_LIST_CAP until "Show all"; or one quiet
 *  line while it loads, when it is empty and when the read failed. No fixed height and no
 *  inner scroller: the list is as tall as what it shows, and "Show all" is how it grows. */
export function grantListBody(s: Pick<AppState, "grants" | "grantRevokeArm"> & Partial<Pick<AppState, "grantsAll" | "orgSlug">>): string {
  const g = s.grants;
  const n = g.status === "error" ? 0 : g.data.length;
  const count = n ? `<span style="flex:none;font-family:var(--label);font-size:11px;line-height:17px;color:var(--fg-55);background:var(--hover);border-radius:999px;padding:0 7px">${n}</span>` : "";
  const head = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="font-size:13px;font-weight:600">Connected apps</span>${count}</div>`;
  const wrap = (inner: string) => `<div class="cnpy-mcp-list" data-list="grants">${head}${inner}</div>`;
  if (!n && g.status !== "ok" && g.status !== "error") {
    // One app's row (name over its last-used line, the Revoke button) — the usual list.
    return wrap(skeleton("grants", "Loading connected apps&hellip;", `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--border)"><span class="cnpy-skcol">${skLine("46%", 13, 1.35)}${skLine("62%", 12, 1.35)}</span>${skBox(62, 26)}</div>`));
  }
  if (!n) {
    const note = g.status === "error" ? `Couldn't load connected apps${g.error ? ` &mdash; ${esc(g.error)}` : ""}.`
      : g.status !== "ok" ? "Loading connected apps&hellip;"
      : "No apps connected yet. Once you approve Claude Code in the browser, it shows up here with how it picks an organization. If you approved one and it isn't here, check which account the Allow page was signed in as.";
    return wrap(`<div style="padding:10px 0;border-top:1px solid var(--border);font-size:12.5px;line-height:1.5;color:var(--fg-40)">${note}</div>`);
  }
  const btn = "flex:none;padding:4px 10px;border-radius:6px;font-size:12px";
  const all = !!s.grantsAll;
  const rows = (all ? g.data : g.data.slice(0, MCP_LIST_CAP)).map((gr) => {
    const armed = s.grantRevokeArm === gr.id;
    const actions = armed
      ? `<button data-act="revokeGrant" data-arg="${gr.id}" class="cnpy-revoke" style="${btn};font-weight:600;color:var(--red);border:1px solid var(--red)">Disconnect</button>
         <button data-act="revokeGrantCancel" class="cnpy-ghostbtn" style="${btn};color:var(--fg-55);border:1px solid var(--border)">Keep</button>`
      : `<button data-act="grantScopeOpen" data-arg="${gr.id}" data-grant-change="${gr.id}" aria-haspopup="dialog" class="cnpy-ghostbtn" style="${btn};color:var(--fg-70);border:1px solid var(--border-strong)">Change organization&hellip;</button>
         <button data-act="revokeGrantArm" data-arg="${gr.id}" class="cnpy-revoke" style="${btn};color:var(--fg-55);border:1px solid var(--border)">Revoke</button>`;
    return `<div data-grant="${gr.id}" style="padding:8px 0;border-top:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end">
      <div style="flex:1 1 180px;min-width:0;line-height:1.35">
        <span style="display:flex;align-items:center;gap:7px;min-width:0"><span style="font-size:13px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">${esc(gr.client_name)}</span>${grantScopeChip(gr, s.orgSlug ?? null)}</span>
        <span style="display:block;font-size:11.5px;color:var(--fg-40)">${armed ? "The app is signed out the moment you disconnect it." : `Connected ${esc(relTime(gr.created_at))} &middot; ${gr.last_used_at ? `last used ${esc(relTime(gr.last_used_at))}` : "never used"}`}</span>
      </div>
      ${actions}
      </div>
    </div>`;
  }).join("");
  const more = n > MCP_LIST_CAP
    ? `<button data-act="mcpShowAll" aria-expanded="${all}" class="cnpy-mutelink" style="display:block;width:100%;text-align:left;padding:9px 0 1px;border-top:1px solid var(--border);font-size:12px;font-weight:500;color:var(--fg-55)">${all ? "Show fewer" : `Show all ${n}`}</button>`
    : "";
  return wrap(rows + more);
}

/** Settings › MCP access › Access tokens: MY personal tokens for the org on screen — the older,
 *  pasted-token setups (Codex, CI). Trov no longer mints them here (sign in through the browser
 *  instead), so the list only exists to see and revoke what is still out there: it renders nothing
 *  when there are none. A token works in the ONE org it was made for, and the heading says which. */
export function tokenListBody(s: Pick<AppState, "mcpTokens" | "tokenRevokeArm">, orgName: string): string {
  const rows = s.mcpTokens.data;
  if (!rows.length) return "";
  const btn = "flex:none;padding:4px 10px;border-radius:6px;font-size:12px";
  return `<div class="cnpy-mcp-list" data-list="tokens" style="margin-top:16px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="font-size:13px;font-weight:600;min-width:0;overflow-wrap:anywhere">Access tokens for ${esc(orgName || "this organization")}</span><span style="flex:none;font-family:var(--label);font-size:11px;line-height:17px;color:var(--fg-55);background:var(--hover);border-radius:999px;padding:0 7px">${rows.length}</span></div>
    ${rows.map((t) => {
      const armed = s.tokenRevokeArm === t.id;
      const actions = armed
        ? `<button data-act="revokeToken" data-arg="${t.id}" class="cnpy-revoke" style="${btn};font-weight:600;color:var(--red);border:1px solid var(--red)">Revoke</button>
           <button data-act="revokeTokenCancel" class="cnpy-ghostbtn" style="${btn};color:var(--fg-55);border:1px solid var(--border)">Keep</button>`
        : `<button data-act="revokeTokenArm" data-arg="${t.id}" class="cnpy-revoke" aria-label="Revoke the token${t.hint ? ` starting ${attr(t.hint)}` : ""}" style="${btn};color:var(--fg-55);border:1px solid var(--border)">Revoke</button>`;
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--border)">
        <div style="flex:1;min-width:0;line-height:1.35">
          <span style="display:block;font-family:var(--code);font-size:12px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.hint ? `${esc(t.hint)}&hellip;` : "Access token"}</span>
          <span style="display:block;font-size:11.5px;color:var(--fg-40)">${armed ? "Whatever uses this token stops working at once." : `Created ${esc(relTime(t.created_at))} &middot; ${t.last_used_at ? `last used ${esc(relTime(t.last_used_at))}` : "never used"}`}</span>
        </div>
        ${actions}
      </div>`;
    }).join("")}
    <div style="padding-top:8px;border-top:1px solid var(--border);font-size:11.5px;line-height:1.5;color:var(--fg-40)">A token reaches this organization only. Trov no longer creates tokens here: connect through the browser instead.</div>
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
export function mcpAccessSection(s: Pick<AppState, "grants" | "grantRevokeArm" | "grantsAll"> & Partial<Pick<AppState, "mcpTokens" | "tokenRevokeArm" | "orgSlug" | "grantScope" | "myOrgs" | "me" | "dd">>, orgName = ""): string {
  return `<section class="cnpy-tile cnpy-surface cnpy-set-mcp">
    <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;column-gap:12px;row-gap:2px;margin-bottom:14px">
      <div style="${SECTION_LABEL};margin-bottom:0">MCP access</div>
      <button data-act="mcpSetupOpen" data-mcp-setup-trigger aria-haspopup="dialog" class="cnpy-mutelink" style="padding:0;font-size:12px;font-weight:500;color:var(--fg-55)">Set it up without the plugin &rarr;</button>
    </div>
    <div style="font-size:13px;line-height:1.5;color:var(--fg-55)">Sign Claude Code in with your browser; it acts as you, in one of your organizations at a time.${s.me?.handle ? ` <span data-mcp-account>Connections you approve as <strong style="font-weight:600;color:var(--fg-70)">@${esc(s.me.handle)}</strong> show up here.</span>` : ""}</div>
    <div class="cnpy-mcp-body">
      <div style="min-width:0;display:flex;flex-direction:column;gap:12px">
      ${connectSteps(orgName)}
      <div data-mcp-one-org style="font-size:12px;line-height:1.55;color:var(--fg-40);min-width:0">${CONNECTION_NOTE} Not using Claude Code? ${otherClientsLink()}</div>
      </div>
      <div style="min-width:0">
      ${grantListBody(s)}
      ${s.mcpTokens ? tokenListBody({ mcpTokens: s.mcpTokens, tokenRevokeArm: s.tokenRevokeArm ?? null }, orgName) : ""}
      </div>
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
        <p style="margin:12px 0 0;font-size:13px;line-height:1.55;color:var(--fg-70)">Then run ${mcpCode("/mcp")}, choose ${mcpStrong("trov")}, then ${mcpStrong("Authenticate")}. In the browser, choose how the connection picks an organization and click ${mcpStrong("Allow")}. A connection reaches that one organization.</p>
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
    // "System" needs its one line of explanation only when asked: it is the card's tooltip, so the
    // tile is exactly as tall as its three cards (it sits under Session, beside Profile and Account).
    return `<button data-act="setTheme" data-arg="${k}" class="cnpy-themecard" aria-pressed="${sel}"${k === "system" ? ` title="Follows your operating system's appearance"` : ""} style="${style}">${icon}<span style="font-size:13px;font-weight:500;line-height:18px">${label}</span></button>`;
  }).join("");

  // ONE bento grid on twelve columns (trov.css), each tile about as tall as what it holds:
  //   Profile | Account | Session over Appearance
  //   Plan | Limits
  //   Organizations
  //   MCP access
  //   Trov: How Trov should answer you | Default mode, then What Trov can see (ask-settings.ts)
  //   Email notifications
  // DOM order is the folded order — who I am, then the plan, then the rest, Sign out last —
  // and the wide layout places each tile by name, so the narrower ones need no reordering.
  const org = viewerOrg(s);
  const plan = { org, plan: s.org.slug === org?.slug ? s.org.plan : { status: "idle" as const, data: null }, billing: s.org.billing };
  return `<div class="cnpy-set-wrap"><div class="cnpy-set">
    ${profileSection(s)}

    ${accountSection(s)}

    ${settingsPlanTile(plan)}

    ${settingsLimitsTile(plan)}

    ${settingsOrgsTile({ orgs: s.myOrgs.data, mine: s.me?.orgs ?? [], status: s.myOrgs.status, current: s.orgSlug })}

    ${mcpAccessSection(s, org?.name ?? "")}

    ${trovSettingsTiles(s.trovPrefs, s.orgSlug)}

    <section class="cnpy-tile cnpy-surface cnpy-set-appear">
      <div style="${SECTION_LABEL}">Appearance</div>
      <div class="cnpy-set-themes">${themeCards}</div>
    </section>

    ${emailNotificationsSection({
      prefs: s.notifPrefs.data,
      loading: s.notifPrefs.status === "idle" || s.notifPrefs.status === "loading",
      error: s.notifPrefs.error ?? null,
      emailEditing: s.emailEditing,
      emailDraft: s.emailDraft,
    })}

    ${helpSection()}

    ${accountDeleteTile(s.acctDelete)}

    ${sessionSection(s)}

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
    .map((e) => ({ id: e.id, summaryHtml: renderMarkdownInline(e.summary), brief: e.brief, at: e.created_at, trov: e.ai?.origin === "ai" }));
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

  // The design's composition: Tickets and Needs your review lead at 7/5; Your sessions and
  // Repo follow; the library closes. EVERY tile is always shown — one with nothing in it
  // draws its rows empty (mywork.ts `tileEmpty`), so a new organization sees the whole
  // screen, and a tile never appears or leaves when a count crosses zero. A CLEAR review
  // queue (loaded, empty) steps out of the lead pair to sit beside Repo:
  // Tickets 7 | Sessions 5, then Repo 7 | Needs your review 5.
  // Your brief (written by Trov) is a tile of its own, ONLY when the dashboard carries one and this
  // person has not pressed "Wrong?" on it. With it the bento is laid out by AREA (trov.css
  // `.mw-bento-brief`): Brief on the left beside Needs your review over Docs you own; Your sessions beside Tickets
  // for you; Repo wide beside Queued handoffs.
  const reviewClear = reviewLoad === "ok" && reviewItems.length === 0;
  // "Wrong?" on it: the tile leaves by the AI kit's one exit IN its slot (`aiLeaving`), and only then does the bento
  // take its other layout (ai-actions.ts fades that one in).
  const briefKey = d?.brief ? aiHiddenKey("brief", aiItemRef.brief(d.brief.generatedAt ?? "brief")) : "";
  const brief = d?.brief && (!s.ai.hidden.includes(briefKey) || aiLeavingT(s.ai, briefKey) !== null) ? d.brief : null;
  const strips = brief ? [] : ["library"];
  const order = brief
    // In the visual order: Brief beside Needs your review over Docs you own (the owner, 2026-10-16: a short tile
    // there keeps the brief its own height); Your sessions beside Tickets for you; Repo beside Queued handoffs.
    // A phone reorders by CSS (trov.css `.mw-bento-brief` at 700px).
    ? ["brief", "review", "docs", "sessions", "tickets", "repo", "handoffs"]
    : reviewClear ? ["tickets", "sessions", "repo", "review"] : ["tickets", "review", "sessions", "repo"];
  // With the brief, the areas place every tile; the spans only matter below the phone breakpoint (all 12).
  const span: Record<string, number> = brief
    ? Object.fromEntries(order.map((k) => [k, 12]))
    : reviewClear
      ? { tickets: 7, sessions: 5, repo: 7, review: 5, library: 12 }
      : mwSpans(order, strips);
  const libTiles = brief ? libraryTiles(library) : null;
  const tile: Record<string, () => string> = {
    // Beside the brief, Needs your review and Tickets for you hold two rows each in fixed boxes (BR-OWNER-2).
    tickets: () => ticketsTile({ load: dLoad, rows: tickets, total: ticketsTotal, expanded: s.mwExpanded.tickets }, degraded, span.tickets, dueOf, !!brief),
    review: () => reviewTile(reviewItems, reviewLoad, span.review, !!brief),
    sessions: () => sessionsTile(sessions, feedLoad, waiting, span.sessions),
    repo: () => repoTile(s.repo.data, mwLoad(s.repo.status, !!s.repo.data), s.mwRepoTab, span.repo, { noRepo: s.orgMe.status === "ok" && !s.orgMe.data?.repos.primary, admin: viewerIsAdmin(s) }),
    library: () => libraryStrip(library, span.library),
    docs: () => libTiles?.docs ?? "",
    handoffs: () => libTiles?.handoffs ?? "",
    brief: () => (brief ? aiLeaving(s.ai, briefKey, briefTile(brief, false, span.brief)) : ""),
  };

  return myWorkLayout({
    greeting: `${greetingFor()}, ${esc(s.displayName || s.me?.name || s.me?.handle || "there")}`,
    date: esc(today),
    stat: esc(stat),
    tiles: [...order, ...strips].map((k) => tile[k]()),
    ...(brief ? { bento: "brief" as const } : {}),
  });
}

/** A list slice that hasn't produced data yet (idle/loading with nothing cached). */
function slicePending(l: Loadable<unknown[]>): boolean {
  return (l.status === "idle" || l.status === "loading") && l.data.length === 0;
}

/** Review screen with slice-level loading/error states around the pure view. */
function reviewScreen(s: AppState): string {
  if (slicePending(s.proposals) && slicePending(s.draftAdrs)) return reviewView({ ...reviewProps(s), loading: true });
  if (s.proposals.status === "error" && s.draftAdrs.status === "error") return notice("Couldn't load the review queue.");
  const hint = s.proposals.status === "error" ? mwDegradedHint("Couldn't load doc/decision proposals.")
    : s.draftAdrs.status === "error" ? mwDegradedHint("Couldn't load draft ADRs.")
    : "";
  return `${hint}${reviewView(reviewProps(s))}`;
}

/** The Unplaced queue (the `maintenance` screen) with its slice's loading/error states around the pure view. */
function maintenanceScreen(s: AppState): string {
  if (slicePending(s.needsTriage)) return maintenanceSkeleton();
  if (s.needsTriage.status === "error" && s.needsTriage.data.length === 0) return notice("Couldn't load the Unplaced queue.");
  return maintenanceView(maintenanceProps(s), s.needsTriage.status === "error" ? mwDegradedHint("Couldn't load the triage queue.") : "");
}

// ── tickets ──────────────────────────────────────────────────────────────────
/** The queue screen with slice-level loading/error states around the pure view. */
function ticketsScreen(s: AppState): string {
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
    aiFilter: aiFilterLine("tickets", s.aiFilter, s.ai),
    aiFilterMenu: aiFilterMenuTop("tickets", s.aiFilter),
    // The first read is out: the toolbar is real, the columns / rows are skeletons.
    loading: slicePending(s.tickets),
    // Cards declined while this view was up, mid-exit (the AI kit's clock: `--leave-t`).
    leaving: s.qLeaving.map((l) => ({ row: l.row, t: Math.max(0, Date.now() - l.at) })).filter((l) => l.t < AI_EXIT_MS),
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
  if ((slice.status === "loading" || slice.status === "idle") && !slice.data) return ticketDetailSkeleton();
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
    aiUi: s.ai,
  });
}

/** The sprint screen with slice-level loading/error states around the pure view. */
function sprintScreenBody(s: AppState): string {
  const slice = s.sprintDetail;
  if ((slice.status === "loading" || slice.status === "idle") && !slice.data) return sprintSkeleton();
  if (slice.status === "error") return notice("Couldn't load this sprint.");
  if (!slice.data) return notice("That sprint doesn't exist.");
  return sprintScreen({ detail: slice.data, persons: s.persons.data, resourceDraft: s.linkDraft, deleteArmed: s.sprintDeleteArmed, ai: s.ai });
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
    case "ask": return askScreenView(s);
    case "feed": return feedView(s);
    case "docs": return docScreen(s);
    case "library": return libraryHomeView({ library: s.library, admin: viewerIsAdmin(s), persons: s.persons.data, restoring: s.libUi.restoring, cardMenu: s.libUi.cardMenu, showHidden: s.libUi.showHidden });
    case "space": return spaceScreen(s);
    case "roadmap": return roadmapView(s);
    case "review": return reviewScreen(s);
    case "maintenance": return maintenanceScreen(s);
    case "search": return searchView(s);
    case "settings": return settingsView(s);
    case "guide": return guideView(s);
    case "releases": return releasesView(s.releaseVersion, s.releasePage);
    case "tickets": return ticketsScreen(s);
    case "newticket": return newTicketScreen(s);
    case "ticketdetail": return ticketDetailScreen(s);
    case "sprint": return sprintScreenBody(s);
    case "repo": return repoView(repoProps(s));
    case "artifacts":
    case "artifactnew":
    case "artifact": return artifactsView(artProps(s, s.screen));
    case "relay": return relayView({ me: s.me?.handle ?? "", orgSlug: s.orgSlug ?? "", handoffs: s.handoffs, links: s.links, grants: s.grants, tokens: s.mcpTokens, ask: s.relayAsk });
    case "handoffs": return handoffsView({ status: s.handoffs.status, handoffs: s.handoffs.data, me: s.me?.handle ?? "", persons: s.persons.data });
    case "links": return linksView({ status: s.links.status, boxes: s.links.data, me: s.me?.handle ?? "", persons: s.persons.data, start: s.linkStart, pastAll: s.linksPastAll, busy: s.linkBusy });
    case "link": return linkDetailView({
      status: s.linkDetail.status, link: s.linkDetail.data, me: s.me?.handle ?? "", persons: s.persons.data,
      draft: s.linkNote && s.linkNote.id === s.linkId ? s.linkNote.text : "", busy: s.linkBusy, noteSide: s.linkNoteSide,
    });
    case "handoff": return handoffDetailView({ status: s.handoffDetail.status, handoff: s.handoffDetail.data, me: s.me?.handle ?? "", persons: s.persons.data, expireArm: s.handoffExpireArm, promptView: s.promptView, reading: s.handoffReading && s.handoffDetail.data && s.handoffReading.id === s.handoffDetail.data.id ? s.handoffReading.items : null, readingT: s.handoffReading?.at === undefined ? null : Date.now() - s.handoffReading.at });
    case "newhandoff": return newHandoffView({ draft: s.nh, me: s.me?.handle ?? "", persons: s.persons.data, primaryRepo: s.orgMe.data?.repos.primary ?? null });
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
    case "tag": return tagPageView({
      name: s.tagName, page: { ...s.tagPage, status: s.tagPage.status === "unauth" ? "error" : s.tagPage.status }, tab: s.tagsUi.pageTab, leaving: s.tagsUi.reviewLeaving, bump: s.tagsUi.bump,
      orgName: currentOrg(s)?.name ?? "this organization", who: (h) => handleLink(personFor(s, h), h),
      colorOf: (h) => personFor(s, h)?.color ?? null, tagColorOf: (n) => s.tags.data?.tags.find((t) => t.name === n)?.color ?? null,
    });
    case "newdoc": return newDocScreen(s);
    case "import": return importWizardView({ ui: s.imp, library: s.library, pages: s.imp.space && s.spaceHome.data?.space.slug === s.imp.space ? s.spaceHome.data.pages : null, admin: viewerIsAdmin(s) });
    case "imports": return importsHistoryView({ runs: { status: s.importRuns.status, data: s.importRuns.data }, ui: s.imp, persons: s.persons.data, me: s.me?.handle ?? null, admin: viewerIsAdmin(s), spaces: liveSpaces(s), driver: s.imp.run });
    case "org": return orgSettingsView(orgProps(s));
    default: return feedView(s);
  }
}

/** Project the app state onto the guided setup's props (welcome.ts): Org settings' reads, and MY
 *  agent connections — the two reads Settings › MCP access makes. */
export function welcomeProps(s: AppState): WelcomeProps {
  return { org: currentOrg(s), step: s.welcome.step, me: s.me, ui: s.org, grants: s.grants, tokens: s.mcpTokens, wel: s.welcome, dd: s.dd, backdrop: firstRunBackdrop(s) };
}

/** Project the app state onto Org settings' props. The current org is `currentOrg` — one place. */
function orgProps(s: AppState): OrgSettingsProps {
  const status = s.myOrgs.status === "unauth" ? "error" : s.myOrgs.status;
  // What an ADMIN administers beyond the org's own reads — both null for a member, who is
  // shown neither: the logins to match to a person (Members), and the e-mail digests (Notifications).
  const admin = viewerIsAdmin(s);
  const identity: IdentityProps | null = admin ? {
    status: s.identityTasks.status === "unauth" ? "error" : s.identityTasks.status,
    groups: s.identityTasks.data.map(identityFromTask),
    discarded: s.identityDiscarded.map(discardedFromRow),
    showDiscarded: s.identityShowDiscarded,
    people: peopleFromPersons(s.persons.data),
    mapPicks: s.mapPicks,
    mapConfirm: s.mapConfirm,
  } : null;
  const notif: NotifAdminProps | null = admin ? {
    policy: s.notifPolicy.data, settings: s.notifSettings.data, outbox: s.notifOutbox.data,
    outboxLoading: slicePending(s.notifOutbox),
    outboxExpanded: s.outboxExpanded, fromDraft: s.fromDraft, fromError: s.fromError,
  } : null;
  return { org: currentOrg(s), orgsStatus: currentOrg(s) ? "ok" : status, me: s.me?.handle ?? "", ui: s.org, identity, notif, dd: s.dd,
    tags: { list: { ...s.tags, status: s.tags.status === "unauth" ? "error" : s.tags.status }, ui: s.tagsUi } };
}

/** Project the app state onto the Repo dashboard's props (its components never see AppState). */
export function repoProps(s: AppState): RepoProps {
  return {
    tab: s.repoTab, range: s.repoRange, driftOpen: s.repoDriftOpen, repo: s.repo, fetchedAt: s.repoFetchedAt, sample: s.repoSample,
    admin: viewerIsAdmin(s), noRepo: s.orgMe.status === "ok" && !s.orgMe.data?.repos.primary, poll: s.repoPoll, productEnv: s.repoProductEnv, persons: s.persons.data,
    synced: syncRepoLabel(s.sync, Date.now()),
    ai: { ui: s.ai, admin: viewerIsAdmin(s), repo: s.repo.data?.repo ?? "" },
    app: s.repoApp, group: s.repoGroup, groupFlipped: s.repoGroupFlipped, phone: s.phone, scenario: s.repoSample ? s.repoScenario : undefined, dd: s.dd, open: s.repoOpen,
  };
}

/** Project the app state onto the Artifacts screens' props. */
function artProps(s: AppState, screen: ArtScreen): ArtProps {
  return {
    screen, route: s.artRoute, ui: s.art, me: s.me?.handle ?? "", admin: viewerIsAdmin(s), fmOpening: s.fmOpening,
    aiFilter: screen === "artifacts" ? aiFilterLine("artifacts", s.aiFilter, s.ai) : "",
    aiFilterMenu: screen === "artifacts" ? aiFilterMenuTop("artifacts", s.aiFilter) : "",
    orgName: viewerOrg(s)?.name ?? "", repos: s.orgMe.data?.repos.all ?? [],
    persons: s.persons.data, host: `${typeof location !== "undefined" ? location.host : "trov"}${s.orgSlug ? `/${s.orgSlug}` : ""}`,
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
  // Org settings and Platform are patched too: their tab bar is the same element across a tab
  // switch (its underline slides, focus stays on the tab), and only the panel under it is replaced.
  // Personal Settings too: it holds forms (name, handle, digest address), and a page rebuilt per
  // keystroke restarts everything in it (web-ui.md › A repaint REBUILDS a page).
  const morphKey = isArtScreen(s.screen) ? `${s.screen}:${JSON.stringify(s.screen === "artifact" ? s.artRoute : null)}`
    // Review too: its list is keyed (`data-morph-list`), so a filter or a verdict never rebuilds it —
    // a card can leave with an animation, and the two switches' indicators slide on the same element.
    // Unplaced the same: its queue is Review's keyed list, so a card placed or discarded leaves by the same exit.
    : s.screen === "org" || s.screen === "platform" || s.screen === "platformorg" || s.screen === "settings" || s.screen === "review" || s.screen === "maintenance" ? s.screen
    // A tag's page too, by tag (another tag is another page): its To review list is keyed, so a row can leave with
    // its animation, and the numbers tick in place instead of the page being rebuilt under them.
    : s.screen === "tag" ? `tag:${s.tagName ?? ""}`
    // A link's page, by link: its note composer must keep its focus and text while the count under it updates.
    : s.screen === "link" ? `link:${s.linkId ?? ""}`
    // The Links tab too: its "Start a link" card holds a form and a running line (link-line.ts) that a rebuild
    // would restart per keystroke.
    : s.screen === "links" ? "links"
    // Ask: a keystroke, a streamed word or a hover card never rebuilds the page (the composer keeps its caret,
    // the conversation its scroll, and nothing that already entered replays its entrance).
    : s.screen === "ask" ? "ask"
    // The Roadmap's Narrative tab too: Trov's suggestion cards are a keyed list, so one an Accept / Dismiss took
    // leaves with Review's exit, and a note or the drift collapses out the same way (roadmap-ai.ts › MOTION). The
    // Timeline tab is rebuilt as before (another key, so a tab switch replaces the page).
    : s.screen === "roadmap" && s.roadmapTab === "narrative" ? "roadmap:narrative"
    // The Library's home and a space's home hold dialogs with forms, a description edited in place and a tab bar:
    // patched in place. A space's home, a doc page and New page are ONE page per space (`lib:<space>`): the docs pane
    // beside them is patched across the three (its open chevrons, its scroll), and only the content is replaced.
    : s.screen === "library" ? "library"
    // The import wizard holds a form (a rename field per title that exists) and its steps are keyed parts
    // (`imp:<step>`); Imports history's rows are a keyed list (one opens in place).
    : s.screen === "import" ? "import" : s.screen === "imports" ? "imports"
    : s.screen === "space" || s.screen === "docs" || s.screen === "newdoc" ? `lib:${paneSpaceSlug(s) ?? ""}` : "";
  // The skip link is the shell's first child (a fixed chip, out of the flex row): past the sidebar and the
  // header, to the screen itself. morph.ts patches the aside and swaps <main>; it never touches this.
  return `<div class="cnpy-shell" style="display:flex;height:calc(100 * var(--vh));overflow:hidden">
    ${skipLink("cnpy-main")}
    ${sidebar(s)}
    <main${morphKey ? ` data-morph="${attr(morphKey)}"` : ""} style="flex:1;display:flex;flex-direction:column;min-width:0;background:var(--bg)">
      ${header(s)}
      <div id="cnpy-main" tabindex="-1" class="cnpy-scroll" style="flex:1;overflow-y:auto;min-height:0">${screenBody(s)}</div>
    </main>
    <div class="cnpy-scrim" data-act="closeDrawer" aria-hidden="true"></div>
  </div>`;
}

/** Behind a first-run card (onboarding, the org picker): the app itself — its real sidebar, header and
 *  My Work — in the state it is in before anything has loaded, so every region is its own skeleton.
 *  It is what the person is about to enter, held still: `inert`, hidden from assistive tech, and
 *  softened by `.cnpy-fr-bg`. Nothing in it is theirs yet, so nothing in it is data. */
function firstRunBackdrop(s?: AppState): string {
  // Inside an organization (the guided setup) it is the REAL My Work — this person's sidebar, org and
  // data, read while they are in the setup — so "Open Trov" removes the card and changes nothing else.
  // Before there is an organization (onboarding, the picker) there is nothing of theirs to show.
  const behind: AppState = s && s.view === "app" && s.orgSlug
    ? { ...s, screen: "mywork", personCard: null, drawer: false }
    : { ...initialState(), view: "app", screen: "mywork" };
  return `<div class="cnpy-fr-bg" aria-hidden="true" inert>${appView(behind)}</div>`;
}

// The toast and its one button are app-root.ts (the landing page draws them too).
export type { ToastAction } from "./app-root";

/** Whether the signed-in person may delete the open prompt: its author, or an admin (the server re-checks). */
export function canDeletePrompt(s: Pick<AppState, "me" | "promptDetail" | "orgSlug" | "myOrgs">): boolean {
  const p = s.promptDetail.data?.prompt;
  if (!p || !s.me) return false;
  return viewerIsAdmin(s) || s.me.handle.toLowerCase() === p.author.toLowerCase();
}

/** The state a paint draws: the real one, or — while a preview is on, inside an organization or
 *  the Platform area — its projection (preview.ts). Every renderer main.ts calls directly goes
 *  through this too, so no path paints real data under the preview's banner. */
export function shownState(s: AppState): AppState {
  return s.preview && (s.view === "app" || s.view === "platform") ? previewState(s, s.preview, initialState()) : s;
}

export function render(real: AppState): string {
  const s = shownState(real);
  return appRoot(s, `
    ${s.billingCheckout ? billingCheckoutPage(s.billingCheckout, firstRunBackdrop()) : s.billingDone ? billingDonePage(s.billingDone, firstRunBackdrop()) : s.view === "auth" ? authView(s) : s.view === "orgs" ? orgPickerView({ backdrop: firstRunBackdrop(), me: s.me, mine: s.me?.orgs ?? [], orgs: s.myOrgs.data, status: s.myOrgs.status, ui: s.orgsUi, hash: typeof location !== "undefined" ? location.hash : "", superadmin: s.plat.superadmin === true }) : s.view === "platform" ? platformPage(s.plat, s.screen, s.me?.handle ?? null, s.dd) : s.screen === "site" ? landingView({ dark: resolved(s) !== "light", signInOpen: false, signedIn: true, seen: s.landingSeen, feature: s.siteFeature, menuOpen: s.siteMenu }) : s.screen === "welcome" ? welcomeView(welcomeProps(s)) : appView(s)}
    ${s.toast ? toastBlock(s.toast, Math.max(0, Date.now() - s.toastAt), s.toastMs, s.toastAction) : ""}
    ${s.view === "app" ? syncOverlay(syncPropsOf(s)) : ""}
    ${askOverlays(s)}
    ${s.view === "app" && s.dd.open ? dropdownMenu(actionDropdowns(s), s.dd) : ""}
    ${s.view === "app" && isArtScreen(s.screen) ? artifactsDialogs(artProps(s, s.screen)) : ""}
    ${s.view === "app" && s.screen === "handoff" && s.handoffPromptOpen && s.handoffDetail.data ? handoffPromptModal(s.handoffDetail.data) : ""}
    ${s.view === "app" && s.personCard ? personCardFor(s, s.personCard) : ""}
    ${s.view === "app" || s.view === "platform" ? platformDialogs(s.plat, s.screen, s.dd) : ""}
    ${s.view === "app" ? orgMenu({ orgs: s.myOrgs.data, mine: s.me?.orgs ?? [], current: s.orgSlug, status: s.myOrgs.status, ui: s.orgsUi, superadmin: s.plat.superadmin === true, logins: identityCount(s) }) : ""}
    ${s.view !== "auth" && s.orgsUi.create ? createOrgModal(s.orgsUi.create) : ""}
    ${supportDialog(s.support)}
    ${s.view === "app" && s.screen === "settings" && s.mcpSetup ? mcpSetupModal() : ""}
    ${s.view === "app" && s.screen === "settings" ? accountDeleteModal(s.acctDelete) : ""}
    ${s.view === "app" && s.screen === "settings" ? grantScopeDialog(s) : ""}
    ${s.view === "app" && s.screen === "settings" && s.dd.open ? dropdownMenu(grantDropdowns(s), s.dd) : ""}
    ${s.view === "app" && s.screen === "org" ? orgOverlays(orgProps(s)) : ""}
    ${s.view === "app" && s.screen === "repo" && s.dd.open ? dropdownMenu(repoDropdowns(repoProps(s)), s.dd) : ""}
    ${s.view === "app" && s.screen === "docs" && s.dd.open && s.docDetail.data ? dropdownMenu([itemTagDropdown({ tags: s.docDetail.data.tags ?? [], list: s.tags.data?.tags ?? null, busy: s.tagsUi.itemBusy, bare: true })], s.dd) : ""}
    ${s.view === "app" && s.screen === "welcome" ? welcomeOverlays(welcomeProps(s)) : ""}
    ${s.view === "app" && (s.screen === "library" || s.screen === "space" || s.screen === "docs" || s.screen === "newdoc") ? libraryOverlays(s) : ""}${s.view === "app" && s.libUi.customize ? customizeSidebarDialog(s.libUi.customize, liveSpaces(s)) : ""}${s.view === "app" && s.screen === "review" && s.reviewGroupReject ? reviewGroupRejectModal(s, s.reviewGroupReject) : ""}${s.view === "app" && s.screen === "repo" && s.repoAttentionOpen ? repoAttentionOverlay(repoProps(s)) : ""}${s.view === "app" && s.screen === "roadmap" && s.rmTrovOpen && s.roadmap.data && roadmapTrovCount(s.roadmap.data.suggestions, s.roadmap.data.drift, s.ai).n ? roadmapTrovDialog(s.roadmap.data.suggestions, s.roadmap.data.drift, s.ai) : ""}
    ${s.view === "app" && s.screen === "newdoc" && s.dd.open ? dropdownMenu([newDocSpaceDropdown(s.nd, liveSpaces(s))], s.dd) : ""}${s.view === "app" && s.screen === "maintenance" && s.dd.open ? dropdownMenu(unplacedDropdowns(s), s.dd) : ""}
    ${s.view === "app" && s.screen === "prompt" && s.promptExpanded && s.promptDetail.data ? promptPageModal(s.promptDetail.data.prompt) : ""}
    ${s.view === "app" && s.screen === "link" && s.linkCancelArm && s.linkDetail.data ? linkCancelModal(s.linkDetail.data, s.linkCancelBusy) : ""}${s.view === "app" && s.screen === "links" && s.linkCancelArm ? ((l) => (l ? linkCancelModal(l, s.linkCancelBusy) : ""))([...s.links.data.mine, ...s.links.data.waiting].find((x) => x.id === s.linkCancelId)) : ""}${s.view === "app" && s.screen === "prompt" && s.promptDeleteArm && s.promptDetail.data && canDeletePrompt(s) ? promptDeleteModal(s.promptDetail.data.prompt, s.promptDetail.data.versions.length, s.promptDeleteBusy) : ""}
    ${s.view === "app" && s.screen === "ticketdetail" && s.tdDeleteArm && s.ticketDetail.data?.source === "canopy" ? ticketDeleteModal(s.ticketDetail.data, s.tdDeleteBusy) : ""}
    ${real.preview && s !== real ? previewBanner(real.preview) : ""}
  `);
}
