// Org settings' eager part (web-ui.md › The app's bundles): its STATE (`OrgUi`, held in AppState from the
// first paint, with the Hosting tab's and a repository's Apps page's first values), the tabs (hash.ts
// routes them), the current org and which tabs a role may open, and the GitHub App status the first-run
// setup reads. Everything else — the screen, its tabs and dialogs, and its controller (org-actions.ts,
// hosting-actions.ts, repo-apps-actions.ts) — is the lazy Org settings chunk (org-lazy.ts). org-settings.ts
// re-exports all of this, so its importers and the tests are unchanged.
import type { OrgPlanView } from "@shared/plans";
import type { OrgDeletionPreview } from "@shared/deletion-core";
import type { MyOrg, MyOrgsResponse, OrgInvite, OrgMember, OrgRole, OrgSettings } from "@shared/orgs";
import type { IntegrationsListDTO, OrgAuditDTO, OrgEnvironmentDTO, OrgRepoDTO } from "@shared/integrations";
import type { GithubAppStatusDTO, GithubReposDTO } from "@shared/github-app";
import { roleAtLeast, type OrgSlice } from "./org-ui";
import { initialOrgBillingUi, type OrgBillingUi } from "./org-plan";
import { initialOrgLogoUi, type OrgLogoUi } from "./org-logo";
import { initialDeleteUi, type DeleteUi } from "./deletion";
import type { DropdownUi } from "./dropdown";
import type { TagsTabProps } from "./tags";
import type { IdentityProps } from "./identity";
import type { NotifAdminProps } from "./notifications";
import type { SecretFormState, TestState } from "./integrations";
import type { GithubNotice } from "./github-app";
import type { HostingUi } from "./hosting";
import type { RepoAppsUi } from "./repo-apps";
import type { OrgRepoRoute } from "./hash";

// ── state ────────────────────────────────────────────────────────────────────

export type OrgTab = "integrations" | "repos" | "environments" | "hosting" | "members" | "tags" | "notifications" | "general";
export const ORG_TABS: readonly OrgTab[] = ["integrations", "repos", "environments", "hosting", "members", "tags", "notifications", "general"];
export const isOrgTab = (v: unknown): v is OrgTab => typeof v === "string" && (ORG_TABS as readonly string[]).includes(v);
/** The tabs only an admin or an owner may open (their APIs are admin+). */
const ADMIN_TABS: readonly OrgTab[] = ["integrations", "hosting", "notifications"];

const idle = <T>(data: T): OrgSlice<T> => ({ status: "idle", data });

/** The environment fields an admin edits (the DTO's, as text; `key` only when adding). */
export const ENV_TEXT_FIELDS = ["label", "note", "branch", "frontend_url", "api_url", "health_path"] as const;
export type EnvField = (typeof ENV_TEXT_FIELDS)[number];
export interface EnvDraft {
  /** null = adding a new environment (its key is `keyDraft`). */
  key: string | null;
  keyDraft: string;
  fields: Record<EnvField, string>;
  saving: boolean;
  error: string | null;
  /** The field a refusal is about (`key`, or one of the DTO's), so the message sits beside it. */
  errorField: string | null;
}
export const blankEnvFields = (): Record<EnvField, string> => ({
  label: "", note: "", branch: "", frontend_url: "", api_url: "", health_path: "/",
});
export const envFieldsOf = (e: OrgEnvironmentDTO): Record<EnvField, string> => ({
  label: e.label, note: e.note ?? "", branch: e.branch, frontend_url: e.frontend_url, api_url: e.api_url, health_path: e.health_path,
});

export interface MemberDraft {
  handle: string;
  role: OrgRole;
  title: string;
  responsibilities: string;
  saving: boolean;
  error: string | null;
}

/** What the open confirmation modal is about. `arg` = a repo id, an environment key,
 *  `<kind>:<scope>`, a member's handle, "" for the key — or, on Hosting, a part (`<env>/<part>`) to
 *  remove and a provider connection (`<provider>:<scope>`) to disconnect. */
export interface OrgConfirm { what: "repo" | "env" | "secret" | "member" | "key" | "github" | "part" | "hosting" | "leftovers" | "app"; arg: string; busy: boolean }

/** Everything Org settings keeps in AppState (`state.org`). It NEVER holds a secret's value:
 *  a credential being typed lives only in the input and in org-actions.ts's private draft. */
export interface OrgUi {
  tab: OrgTab;
  /** The slug the slices below were read for (a different current org reloads them). */
  slug: string | null;
  settings: OrgSlice<{ org: OrgSettings; can_edit: boolean } | null>;
  members: OrgSlice<OrgMember[]>;
  invites: OrgSlice<OrgInvite[]>;
  repos: OrgSlice<OrgRepoDTO[]>;
  envs: OrgSlice<OrgEnvironmentDTO[]>;
  integrations: OrgSlice<IntegrationsListDTO | null>;
  audit: OrgSlice<OrgAuditDTO[]>;
  /** The org's plan and its use of each limit (shared/plans.ts; org-plan.ts renders it). */
  plan: OrgSlice<OrgPlanView | null>;
  // General
  nameDraft: string | null;
  nameSaving: boolean;
  nameError: string | null;
  /** General's image control (org-logo.ts): its menu, a write in flight, the last refusal. */
  logo: OrgLogoUi;
  // Members
  memberEdit: MemberDraft | null;
  inviteBy: "github" | "email";
  inviteDraft: string;
  /** The invitee's name, for an e-mail invite's greeting (optional). */
  inviteName: string;
  inviteRole: "member" | "admin";
  inviteBusy: boolean;
  inviteError: string | null;
  /** The pending invite whose e-mail is being sent again (its id). */
  mailBusy: number | null;
  // Repositories
  repoDraft: string;
  repoBusy: boolean;
  repoError: string | null;
  /** The org's GitHub App connection (github-app.ts): read by every member, for both GitHub tabs. */
  github: OrgSlice<GithubAppStatusDTO | null>;
  /** The repositories the installation can see (admins, while one is live). */
  githubRepos: OrgSlice<GithubReposDTO | null>;
  /** What the return from GitHub said (`?github=` on the page it redirected to), until dismissed. */
  githubNotice: GithubNotice | null;
  githubFilter: string;
  /** The repository being tracked from the installation's list (its full name). */
  githubBusy: string | null;
  // Environments
  envEdit: EnvDraft | null;
  envBusy: boolean;
  // Integrations
  secretForm: SecretFormState | null;
  tests: Record<string, TestState>;
  auditOpen: boolean;
  /** The rows whose details are open (org-ui.ts `openRow`), by key: an integration's
   *  `<kind>:<scope>`, `key`, `history`, `repo:<id>`. */
  openRows: string[];
  confirm: OrgConfirm | null;
  /** General › Plan's billing actions (org-plan.ts, org-billing-actions.ts). */
  billing: OrgBillingUi;
  /** The Hosting tab (hosting.ts, hosting-actions.ts): its one read, the open dialog, tests in flight. */
  hosting: HostingUi;
  /** General › Delete organization (an owner's; deletion.ts, deletion-actions.ts). */
  del: DeleteUi<OrgDeletionPreview>;
  /** Repositories › one repository's page (its Apps, an app, Add an app), from the route; null = the list. */
  repoPage: OrgRepoRoute | null;
  /** That page's read and drafts (repo-apps.ts, repo-apps-actions.ts). */
  apps: RepoAppsUi;
}

export function initialOrgUi(): OrgUi {
  return {
    tab: "integrations", slug: null,
    settings: idle(null), members: idle([]), invites: idle([]), repos: idle([]), envs: idle([]), integrations: idle(null), audit: idle([]), plan: idle(null),
    nameDraft: null, nameSaving: false, nameError: null, logo: initialOrgLogoUi(),
    memberEdit: null, inviteBy: "github", inviteDraft: "", inviteName: "", inviteRole: "member", inviteBusy: false, inviteError: null, mailBusy: null,
    repoDraft: "", repoBusy: false, repoError: null,
    github: idle(null), githubRepos: idle(null), githubNotice: null, githubFilter: "", githubBusy: null,
    envEdit: null, envBusy: false,
    secretForm: null, tests: {}, auditOpen: false, openRows: [], confirm: null, billing: initialOrgBillingUi(),
    hosting: initialHostingUi(),
    del: initialDeleteUi<OrgDeletionPreview>(),
    repoPage: null, apps: initialRepoAppsUi(),
  };
}

/** THE current org: the one the page's path names (`state.orgSlug`, from `/<slug>/`), with MY role
 *  in it. `GET /api/orgs` is the fresher source (a rename, a role change); `/auth/me`'s copy answers
 *  until it lands, so nothing waits on a second request to know who is an admin. */
export function currentOrg(s: { orgSlug: string | null; myOrgs: { data: MyOrgsResponse | null }; me: { orgs: readonly MyOrg[] } | null }): MyOrg | null {
  if (!s.orgSlug) return null;
  return s.myOrgs.data?.orgs.find((o) => o.slug === s.orgSlug) ?? s.me?.orgs.find((o) => o.slug === s.orgSlug) ?? null;
}
/** The tabs a role may open: Integrations, Hosting and Notifications are admin+ (their APIs are). */
export const orgTabsFor = (role: OrgRole | null): OrgTab[] => ORG_TABS.filter((t) => !ADMIN_TABS.includes(t) || roleAtLeast(role, "admin"));
/** The tab on screen: the picked one, or — when the role may not open it — the first it may. */
export function effectiveOrgTab(tab: OrgTab, role: OrgRole | null): OrgTab {
  const tabs = orgTabsFor(role);
  return tabs.includes(tab) ? tab : tabs[0];
}

export interface OrgSettingsProps {
  org: MyOrg | null;
  /** `GET /api/orgs` has not answered / failed (no org to show yet). */
  orgsStatus: "idle" | "loading" | "ok" | "error";
  me: string;
  ui: OrgUi;
  /** Members › Unmatched logins (render.ts builds it for an admin; null = not shown). */
  identity?: IdentityProps | null;
  /** The Notifications tab's reads (admins; null = not shown). */
  notif?: NotifAdminProps | null;
  /** Which dropdown is open (dropdown.ts; `state.dd`). Omitted = none. */
  dd?: DropdownUi;
  /** The Tags tab's reads and state (web/src/tags.ts; every member). */
  tags?: Omit<TagsTabProps, "dd"> | null;
}

// The Hosting tab's and a repository's Apps page's first values (hosting.ts / repo-apps.ts re-export them).
export function initialHostingUi(): HostingUi {
  return {
    setup: { status: "idle", data: null }, sample: null, sampleStack: "vercel_render", sampleData: null, notice: null, part: null, connect: null, token: null, manage: null,
    tests: {}, doneOpen: false, dismissed: [],
  };
}

export function initialRepoAppsUi(): RepoAppsUi {
  return { repo: null, setup: { status: "idle", data: null }, draft: null, add: null, scanning: false, busy: [], removeParts: false };
}

/** The org's GitHub App connection, from whichever read has it: its own (`GET …/github`, every member)
 *  or the Integrations list's copy (admins). null until one has answered. */
export const githubOf = (ui: Pick<OrgUi, "github" | "integrations">): GithubAppStatusDTO | null =>
  ui.github.data ?? ui.integrations.data?.github_app ?? null;

