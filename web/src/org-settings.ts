// Org settings — the ONE place an org is administered from (canopy-multitenancy.md §5.3,
// §8.7): six tabs under one screen, `#org[/<tab>]`.
//   INTEGRATIONS  — the org's credentials (web/src/integrations.ts). Admin+ only.
//   REPOSITORIES  — connected repos, one primary.
//   ENVIRONMENTS  — the environments the Repo dashboard reports on, in drift order.
//   MEMBERS       — the people directory: org roles, titles, removal, invites by GitHub login
//                   or email, and (admins) the unmatched logins to map to a person
//                   (web/src/identity.ts — Maintenance › Identity until 2026-10-06).
//   NOTIFICATIONS — the e-mail digests: which exist and their default cadence, the send hour,
//                   timezone and sender name, preview and test send, the outbox
//                   (web/src/notifications.ts — under Maintenance › People until then). Admin+ only.
//   GENERAL       — the org's name; its slug, read-only.
// A member who is not an admin sees what the API lets them read: no Integrations and no
// Notifications tab, and the other four read-only. Above the tabs an admin of a new org gets a setup checklist,
// each item derived from live data, gone once all four are done.
//
// Purely presentational: props in, markup out (the app's idiom — template strings, inline
// styles over the trov.css tokens, `data-act` / `data-arg` dispatched in main.ts to
// web/src/org-actions.ts). Every act here starts with `org`.
//
// "The current org" is ONE function, `currentOrg`: the org the page's path names.

import { planBlock, inviteGate, seatsLead } from "./org-plan";
import type { OrgPlanView } from "@shared/plans";
import { esc, attr, relTime, surface } from "./ui";
import {
  O_LABEL, O_FIELD, O_HELP, O_ERR, YOU, accentBtn, quietBtn, dangerLink, goLink, orgHead, orgEmpty, orgBanner, loadingNote, failedNote,
  sliceNote, roleChip, roleOption, roleAtLeast, sameHandle, textField, tabLead, leadFlag, openRow, chip, type OrgSlice,
} from "./org-ui";
export { roleAtLeast };
export type { OrgSlice };
import { tabBar, tabPanelAttrs } from "./tabs";
import { segmented } from "./segmented";
import { dropdown, dropdownMenu, initialDropdownUi, type DropdownProps, type DropdownUi } from "./dropdown";
import { personChip, handleTag } from "./people";
import { confirmModal } from "./confirm";
import { ROLE_MAX, RESPONSIBILITIES_MAX } from "@shared/people";
import { ORG_NAME_MAX, INVITE_NAME_MAX, GITHUB_LOGIN_RE, INVITE_EMAIL_RE, type MyOrg, type MyOrgsResponse, type OrgInvite, type OrgMember, type OrgRole, type OrgSettings } from "@shared/orgs";
import type { IntegrationDTO, IntegrationKind, IntegrationsListDTO, OrgAuditDTO, OrgEnvironmentDTO, OrgRepoDTO } from "@shared/integrations";
import { integrationsTab, secretFormModal, integrationLabel, SECRET_DELETE_EFFECT, type SecretFormState, type TestState } from "./integrations";
import { identitySection, type IdentityProps } from "./identity";
import { notificationsAdminSections, notifDropdowns, type NotifAdminProps } from "./notifications";
import { orgLogoSection, initialOrgLogoUi, type OrgLogoUi } from "./org-logo";

// ── state ────────────────────────────────────────────────────────────────────

export type OrgTab = "integrations" | "repos" | "environments" | "members" | "notifications" | "general";
export const ORG_TABS: readonly OrgTab[] = ["integrations", "repos", "environments", "members", "notifications", "general"];
export const isOrgTab = (v: unknown): v is OrgTab => typeof v === "string" && (ORG_TABS as readonly string[]).includes(v);
const TAB_LABEL: Record<OrgTab, string> = { integrations: "Integrations", repos: "Repositories", environments: "Environments", members: "Members", notifications: "Notifications", general: "General" };
/** The tabs only an admin or an owner may open (their APIs are admin+). */
const ADMIN_TABS: readonly OrgTab[] = ["integrations", "notifications"];

const idle = <T>(data: T): OrgSlice<T> => ({ status: "idle", data });

/** The environment fields an admin edits (the DTO's, as text; `key` only when adding). */
export const ENV_TEXT_FIELDS = ["label", "note", "branch", "frontend_url", "api_url", "health_path", "railway_env", "worker", "worker_check", "railway_environment_id", "railway_service_id"] as const;
export type EnvField = (typeof ENV_TEXT_FIELDS)[number];
export interface EnvDraft {
  /** null = adding a new environment (its key is `keyDraft`). */
  key: string | null;
  keyDraft: string;
  fields: Record<EnvField, string>;
  advanced: boolean;
  saving: boolean;
  error: string | null;
  /** The field a refusal is about (`key`, or one of the DTO's), so the message sits beside it. */
  errorField: string | null;
}
export const blankEnvFields = (): Record<EnvField, string> => ({
  label: "", note: "", branch: "", frontend_url: "", api_url: "", health_path: "/",
  railway_env: "", worker: "", worker_check: "", railway_environment_id: "", railway_service_id: "",
});
export const envFieldsOf = (e: OrgEnvironmentDTO): Record<EnvField, string> => ({
  label: e.label, note: e.note ?? "", branch: e.branch, frontend_url: e.frontend_url, api_url: e.api_url, health_path: e.health_path,
  railway_env: e.railway_env, worker: e.worker, worker_check: e.worker_check,
  railway_environment_id: e.railway_environment_id ?? "", railway_service_id: e.railway_service_id ?? "",
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
 *  `<kind>:<scope>`, a member's handle, or "" for the key. */
export interface OrgConfirm { what: "repo" | "env" | "secret" | "member" | "key"; arg: string; busy: boolean }

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
}

export function initialOrgUi(): OrgUi {
  return {
    tab: "integrations", slug: null,
    settings: idle(null), members: idle([]), invites: idle([]), repos: idle([]), envs: idle([]), integrations: idle(null), audit: idle([]), plan: idle(null),
    nameDraft: null, nameSaving: false, nameError: null, logo: initialOrgLogoUi(),
    memberEdit: null, inviteBy: "github", inviteDraft: "", inviteName: "", inviteRole: "member", inviteBusy: false, inviteError: null, mailBusy: null,
    repoDraft: "", repoBusy: false, repoError: null,
    envEdit: null, envBusy: false,
    secretForm: null, tests: {}, auditOpen: false, openRows: [], confirm: null,
  };
}

/** THE current org: the one the page's path names (`state.orgSlug`, from `/o/<slug>/`), with MY role
 *  in it. `GET /api/orgs` is the fresher source (a rename, a role change); `/auth/me`'s copy answers
 *  until it lands, so nothing waits on a second request to know who is an admin. */
export function currentOrg(s: { orgSlug: string | null; myOrgs: { data: MyOrgsResponse | null }; me: { orgs: readonly MyOrg[] } | null }): MyOrg | null {
  if (!s.orgSlug) return null;
  return s.myOrgs.data?.orgs.find((o) => o.slug === s.orgSlug) ?? s.me?.orgs.find((o) => o.slug === s.orgSlug) ?? null;
}
/** The tabs a role may open: Integrations and Notifications are admin+ (their APIs are). */
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
}

// ── setup checklist ──────────────────────────────────────────────────────────

export interface SetupStep { key: "repo" | "env" | "token" | "team"; title: string; why: string; tab: OrgTab; go: string; done: boolean }

/**
 * A new org's four first steps, each read off live data — or null while any of that data
 * has not arrived (a checklist that flickers to "all done" and back helps nobody). The
 * GitHub token counts as set when the platform's legacy credential answers for it.
 */
export function setupSteps(ui: OrgUi): SetupStep[] | null {
  if (ui.repos.status !== "ok" || ui.envs.status !== "ok" || ui.members.status !== "ok" || ui.invites.status !== "ok" || ui.integrations.status !== "ok" || !ui.integrations.data) return null;
  const token = ui.integrations.data.integrations.find((i) => i.kind === "github_token");
  // A one-person plan has no team to invite: the step would never be done, so it is not asked.
  const solo = ui.plan.data?.entitlements.seats === 1;
  const steps: SetupStep[] = [
    { key: "repo", title: "Connect a repository", why: "Trov reads its deployments, checks, pull requests and issues.", tab: "repos", go: "Open Repositories", done: ui.repos.data.length > 0 },
    { key: "env", title: "Add an environment", why: "The Repo dashboard reports on each one: staging, production.", tab: "environments", go: "Open Environments", done: ui.envs.data.length > 0 },
    { key: "token", title: "Set the GitHub token", why: "Without it Trov cannot read the repository.", tab: "integrations", go: "Open Integrations", done: !!token && (token.configured || token.legacy_fallback) },
    { key: "team", title: "Invite your team", why: "By GitHub login or email; they join when they accept.", tab: "members", go: "Open Members", done: ui.members.data.length > 1 || ui.invites.data.some((i) => i.status === "pending") },
  ];
  return solo ? steps.filter((s) => s.key !== "team") : steps;
}

const STEP_DONE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12.5 2.5 2.5 4.5-5"></path></svg>`;
const STEP_TODO = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="2" aria-hidden="true" style="flex:none"><circle cx="12" cy="12" r="9"></circle></svg>`;

/** The checklist above the tabs — admins only, and only until every step is done. ONE line:
 *  what it is and how far along, then the four steps; a step still to do is a button to the tab
 *  where it is done (why it matters is its tooltip — the tab itself says the rest). */
export function setupChecklist(org: MyOrg, ui: OrgUi): string {
  if (!roleAtLeast(org.role, "admin")) return "";
  const steps = setupSteps(ui);
  if (!steps || steps.every((s) => s.done)) return "";
  const done = steps.filter((s) => s.done).length;
  const items = steps.map((s) => s.done
    ? `<li><span class="cnpy-setup-step" data-step="${s.key}" data-done="1">${STEP_DONE}<span>${esc(s.title)}</span><span class="cnpy-sr">: done</span></span></li>`
    : `<li><button type="button" data-act="orgTab" data-arg="${attr(s.tab)}" data-field="${attr(`orgStep:${s.key}`)}" data-step="${s.key}" data-done="0" title="${attr(s.why)}" aria-label="${attr(`${s.title}: to do. ${s.go}`)}" class="cnpy-setup-step" style="border-radius:8px">${STEP_TODO}<span>${esc(s.title)}</span></button></li>`).join("");
  return `<section${surface("", { cls: "cnpy-setup" })} data-org-setup aria-labelledby="org-setup-t">
    <div style="min-width:0">
      <h2 id="org-setup-t" style="margin:0;font-size:13.5px;font-weight:600;letter-spacing:-0.005em;overflow-wrap:anywhere">Finish setting up ${esc(org.name)}</h2>
      <div style="font-size:12px;color:var(--fg-55);margin-top:1px">${done} of ${steps.length} done</div>
    </div>
    <ol class="cnpy-setup-steps">${items}</ol>
  </section>`;
}

// ── GENERAL ──────────────────────────────────────────────────────────────────

export function generalTab(org: MyOrg, ui: OrgUi): string {
  const s = ui.settings;
  if (!s.data) return sliceNote(s, "the org's settings", false);
  const canEdit = s.data.can_edit;
  const stored = s.data.org.name;
  const draft = ui.nameDraft ?? stored;
  const changed = draft.trim() !== stored && draft.trim().length > 0;
  const nameRow = canEdit
    ? `${textField({ id: "org-name", label: "Name", act: "orgNameDraft", field: "orgName", value: draft, max: ORG_NAME_MAX, enter: "orgNameSave", error: ui.nameError, help: "Changing it does not change the slug or any link." })}
       <div style="display:flex;gap:8px;margin-top:14px">${accentBtn(ui.nameSaving ? "Saving…" : "Save name", "orgNameSave", { disabled: !changed || ui.nameSaving, busy: ui.nameSaving })}${ui.nameDraft !== null && !ui.nameSaving ? quietBtn("Cancel", "orgNameCancel") : ""}</div>`
    : `<div style="${O_LABEL}">Name</div><div style="font-size:14px;margin-top:7px;overflow-wrap:anywhere">${esc(stored)}</div>`;
  return `${tabLead(`Created ${esc(relTime(s.data.org.created_at))} by <strong>${esc(s.data.org.created_by)}</strong> &middot; you are ${org.role === "member" ? "a" : "an"} ${roleChip(org.role)} here${canEdit ? "" : ". Only an admin or an owner can rename the org."}`)}
    <div class="cnpy-org-narrow">
    <section${surface("padding:18px 20px")}>
      ${orgLogoSection({ name: stored, logo: s.data.org.logo, canEdit, ui: ui.logo, repo: ui.repos.data.find((r) => r.is_primary)?.repo_full_name ?? null })}
      ${nameRow}
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
        <div style="${O_LABEL}">Slug</div>
        <div style="margin-top:7px"><code style="font-family:var(--code);font-size:12.5px;color:var(--fg);overflow-wrap:anywhere">${esc(s.data.org.slug)}</code></div>
        <div style="${O_HELP}">The org's permanent address in links and in the API. It cannot be changed.</div>
      </div>
    </section>
    ${planBlock(ui.plan, org.role)}
  </div>`;
}

// ── REPOSITORIES ─────────────────────────────────────────────────────────────

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const repoDraftOk = (v: string): boolean => REPO_RE.test(v.trim());

const READ_ONLY = " You can read this; an admin or an owner can change it.";
const LIST = "overflow:hidden;list-style:none;margin:0;padding:0";

export function reposTab(org: MyOrg, ui: OrgUi): string {
  const admin = roleAtLeast(org.role, "admin");
  const repos = ui.repos.data;
  const note = sliceNote(ui.repos, "repositories", repos.length > 0 || ui.repos.status === "ok");
  if (note) return note;
  // The tab's primary action: the name, and Add. The field's rule is its placeholder and its
  // tooltip; a refusal is said under the lead.
  const add = admin ? `<div class="cnpy-org-addbar">
      <input id="org-repo" data-act="orgRepoDraft" data-field="orgRepo" data-enter="orgRepoAdd" value="${attr(ui.repoDraft)}" placeholder="owner/repo" aria-label="Repository to add, as owner/repo" title="The name as it appears on GitHub, for example acme/web" autocomplete="off" autocapitalize="off" spellcheck="false"${ui.repoError ? ' aria-invalid="true" aria-describedby="org-repo-e"' : ""} class="cnpy-input" style="${O_FIELD};height:32px;width:220px;flex:1 1 180px;font-size:13px;${ui.repoError ? "border-color:var(--red);" : ""}" />
      ${accentBtn(ui.repoBusy ? "Adding…" : "Add repository", "orgRepoAdd", { disabled: !repoDraftOk(ui.repoDraft) || ui.repoBusy, busy: ui.repoBusy })}
    </div>` : "";
  const err = ui.repoError ? `<div id="org-repo-e" role="alert" style="${O_ERR};margin:-14px 0 20px">${esc(ui.repoError)}</div>` : "";
  const primary = repos.find((r) => r.is_primary);
  const unsigned = admin ? repos.filter((r) => !r.webhook_secret_configured).length : 0;
  const lead = tabLead(repos.length === 0
    ? `No repository connected.${admin ? " The first one you add becomes the primary." : READ_ONLY}`
    : `<strong>${repos.length}</strong> ${repos.length === 1 ? "repository" : "repositories"}${primary ? ` &middot; primary <code title="The Repo dashboard, Sync GitHub and drift read the primary repository">${esc(primary.repo_full_name)}</code>` : ""}${unsigned ? ` &middot; ${leadFlag(`${unsigned} without a webhook secret`, "amber")}` : ""}.${admin ? "" : READ_ONLY}`, add);
  if (repos.length === 0) {
    return `${lead}${err}${orgEmpty("No repository connected", admin ? "Add the repository your team ships from. Trov reads its deployments, checks, pull requests and issues." : "An admin has not connected a repository yet.")}`;
  }
  const rows = repos.map((r) => {
    const id = r.id ?? "";
    // The primary can only be removed last (the API's `primary_repo`): say so instead of offering a button that fails.
    const locked = r.is_primary && repos.length > 1;
    const hook = admin && r.webhook_url ? `<div style="margin-top:10px">
        <span style="${O_LABEL};font-size:10px">Webhook URL</span>
        <code class="cnpy-org-code">${esc(r.webhook_url)}</code>
        <span style="display:block;font-size:12px;color:var(--fg-40)">${r.webhook_secret_configured ? "The payload URL of this repository's GitHub webhook. Deliveries are checked against the secret set in Integrations." : "Deliveries to this URL are rejected until its webhook secret is set in Integrations. Set the secret first, then add the webhook on GitHub."}</span>
      </div>` : "";
    const actions = admin ? `<div class="cnpy-xrow-acts">
        ${r.is_primary ? "" : quietBtn("Make primary", "orgRepoPrimary", { arg: r.repo_full_name, disabled: ui.repoBusy, label: `Make ${r.repo_full_name} the primary repository` })}
        ${r.webhook_secret_configured ? "" : quietBtn("Set its webhook secret", "orgTab", { arg: "integrations" })}
        ${dangerLink("Remove", "orgConfirm", { arg: `repo:${id}`, disabled: locked, label: `Remove ${r.repo_full_name}`, field: `orgConfirm:repo:${id}`, title: locked ? "Make another repository the primary first" : undefined })}
      </div>` : "";
    const key = `repo:${r.repo_full_name}`;
    return openRow({
      key, open: ui.openRows.includes(key), act: "orgRowToggle", label: `${r.repo_full_name}${r.is_primary ? ", primary" : ""}`,
      head: `<span>${esc(r.repo_full_name)}</span>${r.is_primary ? chip("Primary", "var(--accent)") : ""}`,
      meta: admin ? `Webhook secret ${r.webhook_secret_configured ? "set" : "not set"}` : `Added ${esc(relTime(r.created_at))}`,
      body: `<div>Added ${esc(relTime(r.created_at))} by ${esc(r.created_by)}.${locked && admin ? " To remove it, make another repository the primary first." : ""}</div>${hook}${actions}`,
      attrs: ` data-org-repo="${attr(r.repo_full_name)}"`,
    });
  }).join("");
  return `${lead}${err}
    ${orgHead("Connected", "", repos.length)}
    <ul${surface(LIST)}>${rows}</ul>`;
}

// ── ENVIRONMENTS ─────────────────────────────────────────────────────────────

const originOf = (url: string): string => { try { return new URL(url).origin; } catch { return ""; } };
/** Would saving this draft point the API URL at another host — which deletes the metrics token? */
export function apiUrlMoves(current: OrgEnvironmentDTO | null, draftApiUrl: string): boolean {
  return !!current && !!current.api_url && originOf(current.api_url) !== originOf(draftApiUrl.trim());
}
const ENV_KEY_RE = /^[a-z0-9_-]{1,32}$/;
export const envDraftOk = (d: EnvDraft): boolean =>
  (d.key !== null || ENV_KEY_RE.test(d.keyDraft.trim())) && d.fields.label.trim() !== "" && d.fields.branch.trim() !== "" && !/\s/.test(d.fields.branch.trim());

const ENV_META: Record<EnvField, { label: string; help: string; placeholder?: string; max: number; required?: boolean }> = {
  label: { label: "Label", help: "The name on its dashboard card.", placeholder: "Staging", max: 60, required: true },
  branch: { label: "Branch", help: "The git branch this environment deploys from.", placeholder: "main", max: 255, required: true },
  note: { label: "Note", help: "Optional. A short line shown beside the label.", max: 120 },
  frontend_url: { label: "Frontend URL", help: "Where the app is served. https only, no query string.", placeholder: "https://staging.example.com", max: 500 },
  api_url: { label: "API URL", help: "Your backend's base URL. Health checks and app metrics are read from it.", placeholder: "https://api.staging.example.com", max: 500 },
  health_path: { label: "Health path", help: "Added to the API URL for the health ping. Starts with /.", placeholder: "/api/health", max: 200 },
  railway_env: { label: "GitHub deployment environment", help: "The environment name on this environment's GitHub deployments, for example “Acme / staging”.", max: 200 },
  worker: { label: "Cloudflare Worker", help: "The frontend Worker's script name, for requests and error rate.", max: 200 },
  worker_check: { label: "Workers Builds check", help: "The check run Workers Builds posts, for example “Workers Builds: frontend-staging”.", max: 200 },
  railway_environment_id: { label: "Railway environment ID", help: "Needed with the Railway project token for CPU and memory.", max: 100 },
  railway_service_id: { label: "Railway service ID", help: "The backend service inside that Railway environment.", max: 100 },
};
/** A field's name as the form shows it (`key` is the new environment's Key). */
export const envFieldLabel = (field: string): string | null =>
  field === "key" ? "Key" : (ENV_META as Record<string, { label: string } | undefined>)[field]?.label ?? null;
const ENV_BASIC: EnvField[] = ["label", "branch", "note"];
const ENV_URLS: EnvField[] = ["frontend_url", "api_url", "health_path"];
const ENV_ADVANCED: EnvField[] = ["railway_env", "worker", "worker_check", "railway_environment_id", "railway_service_id"];

/** The add / edit form. `current` is the stored environment (null when adding); `metricsSet`
 *  whether its app metrics token is stored — what an API URL change would delete. */
export function envForm(d: EnvDraft, current: OrgEnvironmentDTO | null, metricsSet: boolean, framed = true): string {
  const adding = d.key === null;
  const f = (k: EnvField) => {
    const m = ENV_META[k];
    return textField({ id: `org-env-${k}`, label: m.label, act: "orgEnvField", arg: k, field: `orgEnv:${k}`, value: d.fields[k], help: esc(m.help), placeholder: m.placeholder, max: m.max, required: m.required, disabled: d.saving, error: d.errorField === k ? d.error : null });
  };
  const moves = apiUrlMoves(current, d.fields.api_url);
  const warn = moves ? `<div style="margin-top:12px">${orgBanner(
    metricsSet ? "Saving this deletes the app metrics token" : "Changing the API host clears the app metrics token",
    `The token is only ever sent to the API URL it was saved for, so pointing <strong style="font-weight:600">${esc(d.fields.label || d.key || "this environment")}</strong> at another host removes it. ${metricsSet ? "After saving, set a new one in Integrations." : "None is stored right now, so nothing is lost."}`,
  )}</div>` : "";
  const general = d.error && (d.errorField === null || !(d.errorField === "key" || (ENV_TEXT_FIELDS as readonly string[]).includes(d.errorField)));
  const advErr = !!d.errorField && (ENV_ADVANCED as string[]).includes(d.errorField);
  const open = d.advanced || advErr;
  return `<section${framed ? surface("padding:18px 20px;margin-bottom:24px") : ` style="padding:4px 0 2px"`} data-org-envform aria-labelledby="org-envform-t">
    <h3 id="org-envform-t" style="margin:0 0 14px;font-size:13.5px;font-weight:600">${adding ? "Add an environment" : `Edit ${esc(current?.label ?? d.key ?? "")}`}</h3>
    <div class="cnpy-org-grid">
      ${adding ? textField({ id: "org-env-key", label: "Key", act: "orgEnvKey", field: "orgEnvKey", value: d.keyDraft, help: "Its permanent id: lowercase letters, digits, - or _. For example <code style=\"font-family:var(--code)\">staging</code>.", placeholder: "staging", max: 32, required: true, disabled: d.saving, error: d.errorField === "key" ? d.error : null }) : ""}
      ${ENV_BASIC.map(f).join("")}
    </div>
    <div style="${O_LABEL};margin-top:20px">Where it runs</div>
    <div class="cnpy-org-grid" style="margin-top:10px">${ENV_URLS.map(f).join("")}</div>
    ${warn}
    <button type="button" data-act="orgEnvAdvanced" data-field="orgEnvAdvanced" aria-expanded="${open}" aria-controls="org-env-adv" class="cnpy-mutelink" style="display:inline-flex;align-items:center;gap:6px;margin-top:18px;padding:4px 0;font-size:12.5px;font-weight:500;color:var(--fg-55);text-align:left"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true" style="transform:${open ? "rotate(90deg)" : "none"};transition:transform .15s ease"><path d="M9 6l6 6-6 6"></path></svg>Advanced: GitHub, Cloudflare and Railway names</button>
    <div id="org-env-adv"${open ? "" : " hidden"}>
      <div style="${O_HELP};margin:4px 0 12px">Only needed for the dashboard cards that read these services. Leave any of them empty to skip that card.</div>
      <div class="cnpy-org-grid">${ENV_ADVANCED.map(f).join("")}</div>
    </div>
    ${general ? `<div role="alert" style="${O_ERR};margin-top:14px">${esc(d.error ?? "")}</div>` : ""}
    <div class="cnpy-xrow-acts" style="margin-top:18px">
      ${accentBtn(d.saving ? "Saving…" : adding ? "Add environment" : moves && metricsSet ? "Save and delete token" : "Save changes", "orgEnvSave", { disabled: !envDraftOk(d) || d.saving, busy: d.saving })}
      ${quietBtn("Cancel", "orgEnvCancel", { disabled: d.saving })}
      ${current ? dangerLink("Delete environment", "orgConfirm", { arg: `env:${current.key}`, disabled: d.saving, label: `Delete ${current.label}`, field: `orgConfirm:env:${current.key}` }) : ""}
    </div>
  </section>`;
}

const ARROW = (up: boolean) => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${up ? "M12 19V5M6 11l6-6 6 6" : "M12 5v14M6 13l6 6 6-6"}"></path></svg>`;
const moveBtn = (up: boolean, e: OrgEnvironmentDTO, off: boolean): string =>
  `<button type="button" data-act="orgEnvMove" data-arg="${attr(`${e.key}:${up ? "up" : "down"}`)}" data-field="${attr(`orgEnvMove:${e.key}:${up ? "up" : "down"}`)}" aria-label="Move ${attr(e.label)} ${up ? "up" : "down"}" title="Move ${up ? "up" : "down"}"${off ? " disabled" : ""} class="${off ? "cnpy-org-off" : "cnpy-iconbtn"}" style="width:30px;height:30px;display:grid;place-items:center;border-radius:7px;border:1px solid var(--border);color:${off ? "var(--fg-40)" : "var(--fg-55)"}">${ARROW(up)}</button>`;

export function environmentsTab(org: MyOrg, ui: OrgUi): string {
  const admin = roleAtLeast(org.role, "admin");
  const envs = ui.envs.data;
  const note = sliceNote(ui.envs, "environments", envs.length > 0 || ui.envs.status === "ok");
  if (note) return note;
  const stored = (kind: IntegrationKind, key: string): boolean =>
    !!ui.integrations.data?.integrations.some((i) => i.kind === kind && i.scope === key && i.configured);
  const edit = ui.envEdit;
  const adding = edit && edit.key === null ? envForm(edit, null, false) : "";
  const addBtn = admin ? accentBtn("Add environment", "orgEnvNew", { field: "orgEnvNew", disabled: !!edit }) : "";
  if (envs.length === 0) {
    return `${tabLead(`No environments yet.${admin ? " Add the places your app runs, such as staging and production." : READ_ONLY}`, addBtn)}${adding || orgEmpty("No environments yet", admin ? "The Repo dashboard reports on each one you add." : "An admin has not added an environment yet.")}`;
  }
  const lead = tabLead(`<strong>${envs.length}</strong> ${envs.length === 1 ? "environment" : "environments"}${envs.length > 1 ? ` &middot; drift is measured from <strong>${esc(envs[0].label)}</strong> (the head, first) to <strong>${esc(envs[envs.length - 1].label)}</strong> (the base, last)` : ""}.${admin ? "" : READ_ONLY}`, addBtn);
  const rows = envs.map((e, i) => {
    const editing = edit && edit.key === e.key;
    const role = envs.length > 1 ? (i === 0 ? "Drift head" : i === envs.length - 1 ? "Drift base" : "") : "";
    const facts = [
      `<span>Branch <code style="font-family:var(--code);color:var(--fg-70)">${esc(e.branch)}</code></span>`,
      e.frontend_url ? `<span style="overflow-wrap:anywhere">${esc(e.frontend_url)}</span>` : "",
      e.api_url ? `<span style="overflow-wrap:anywhere">API ${esc(e.api_url)}${esc(e.health_path === "/" ? "" : e.health_path)}</span>` : `<span>No API URL</span>`,
    ].filter(Boolean).join("");
    const actions = admin ? `<div class="cnpy-org-actions" style="align-items:center">
        ${moveBtn(true, e, i === 0 || ui.envBusy || !!edit)}${moveBtn(false, e, i === envs.length - 1 || ui.envBusy || !!edit)}
        ${quietBtn(editing ? "Editing" : "Edit", "orgEnvEdit", { arg: e.key, disabled: !!edit, label: `Edit ${e.label}`, field: `orgEnvEdit:${e.key}` })}
      </div>` : "";
    return `<li style="border-bottom:1px solid var(--border);margin-bottom:-1px">
      <div class="cnpy-org-row" style="border-bottom:0;margin-bottom:0;align-items:center">
        <span aria-hidden="true" style="flex:none;width:22px;height:22px;display:grid;place-items:center;border-radius:6px;background:var(--hover);font-family:var(--label);font-size:11px;font-weight:600;color:var(--fg-55)">${i + 1}</span>
        <div style="flex:1 1 260px;min-width:0">
          <div style="display:flex;align-items:center;gap:6px 9px;flex-wrap:wrap">
            <span style="font-size:13.5px;font-weight:600;overflow-wrap:anywhere">${esc(e.label)}</span>
            ${role ? chip(role, "var(--fg-55)") : ""}
            <code style="font-family:var(--code);font-size:11.5px;color:var(--fg-40)">${esc(e.key)}</code>
            ${e.note ? `<span style="font-size:12px;color:var(--fg-40)">${esc(e.note)}</span>` : ""}
          </div>
          <div style="display:flex;gap:2px 14px;flex-wrap:wrap;margin-top:2px;font-size:12px;color:var(--fg-40)">${facts}</div>
        </div>
        ${actions}
      </div>
      ${editing && edit ? `<div style="padding:4px 16px 16px;border-top:1px solid var(--border)">${envForm(edit, e, stored("metrics_endpoint", e.key), false)}</div>` : ""}
    </li>`;
  }).join("");
  return `${lead}${adding}
    ${orgHead("In drift order", admin ? goLink("Set their tokens in Integrations", "orgTab", "integrations") : "", envs.length)}
    <ol${surface(LIST)}>${rows}</ol>`;
}

// ── MEMBERS ──────────────────────────────────────────────────────────────────

/** Is the invite draft a GitHub login / an email address? (The server validates again.) */
export function inviteDraftOk(by: "github" | "email", draft: string): boolean {
  const v = draft.trim().replace(/^@/, "");
  return by === "github" ? GITHUB_LOGIN_RE.test(v) : INVITE_EMAIL_RE.test(v);
}
/** Why the only owner cannot be demoted or removed — the API's `last_owner`, as a sentence. */
export const lastOwnerSentence = (name: string): string =>
  `${name} is the only owner. Make someone else an owner first, then try again.`;

/** The role an invite grants: member or admin (an owner is made from a member, in the editor). */
export const inviteRoleDropdown = (ui: Pick<OrgUi, "inviteRole">): DropdownProps => ({
  id: "org-invite-role", act: "orgInviteRole", value: ui.inviteRole, ariaLabel: "Role the invite grants",
  options: [roleOption("member", "As member"), roleOption("admin", "As admin")],
});
/** A member's org role, in their editor. Only an owner grants or revokes Owner; an admin editing
 *  an owner cannot change the role at all (and nobody can mid-save) — then it is disabled. */
export function memberRoleDropdown(m: Pick<OrgMember, "role">, d: Pick<MemberDraft, "role" | "saving">, viewer: OrgRole): DropdownProps {
  const owner = viewer === "owner";
  const roles: OrgRole[] = owner || m.role === "owner" ? ["owner", "admin", "member"] : ["admin", "member"];
  return {
    id: "org-member-role", act: "orgMemberRole", value: d.role, labelledBy: "org-member-role-l",
    options: roles.map((r) => roleOption(r)), disabled: (m.role === "owner" && !owner) || d.saving,
  };
}

function memberEditor(m: OrgMember, d: MemberDraft, viewer: OrgRole, soleOwner: boolean, dd: DropdownUi): string {
  const owner = viewer === "owner";
  const name = m.name ?? m.handle;
  const changed = d.role !== m.role || d.title.trim() !== (m.title ?? "") || d.responsibilities.trim() !== (m.responsibilities ?? "");
  const roleHelp = m.role === "owner" && !owner ? "Only an owner can change an owner's role."
    : soleOwner ? `${esc(name)} is the only owner. Make someone else an owner before changing this.`
    : owner ? "Owners manage owners and the encryption key. Admins manage members, repositories, environments and integrations."
    : "Admins manage members, repositories, environments and integrations. Only an owner can make someone an owner.";
  return `<div class="cnpy-org-editor" role="group" aria-label="Edit ${attr(name)}">
    <div class="cnpy-org-grid">
      <div class="cnpy-org-field">
        <div id="org-member-role-l" style="${O_LABEL}">Org role</div>
        <div style="margin-top:7px">${dropdown(memberRoleDropdown(m, d, viewer), dd)}</div>
        <div style="${O_HELP}">${roleHelp}</div>
      </div>
      ${textField({ id: "org-member-title", label: "Title", act: "orgMemberTitle", field: "orgMemberTitle", value: d.title, max: ROLE_MAX, placeholder: "e.g. Backend engineer", help: "Shown on their person card.", disabled: d.saving, enter: "orgMemberSave" })}
    </div>
    <div class="cnpy-org-field" style="margin-top:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px"><label for="org-member-resp" style="${O_LABEL}">Responsibilities</label><span style="font-size:11.5px;color:var(--fg-40)">${d.responsibilities.length} / ${RESPONSIBILITIES_MAX}</span></div>
      <textarea id="org-member-resp" data-act="orgMemberResp" data-field="orgMemberResp" maxlength="${RESPONSIBILITIES_MAX}" rows="3" placeholder="What they own, and what should be assigned to them"${d.saving ? " disabled" : ""} aria-describedby="org-member-resp-h" class="cnpy-input" style="${O_FIELD};height:84px;margin-top:7px;padding:9px 11px;line-height:1.55;resize:vertical">${esc(d.responsibilities)}</textarea>
      <div id="org-member-resp-h" style="${O_HELP}">Never shown in the app, not even to them. Agents read it when deciding whom to assign work.</div>
    </div>
    ${d.error ? `<div role="alert" style="${O_ERR};margin-top:12px">${esc(d.error)}</div>` : ""}
    <div class="cnpy-xrow-acts" style="margin-top:16px">
      ${accentBtn(d.saving ? "Saving…" : "Save", "orgMemberSave", { disabled: !changed || d.saving, busy: d.saving })}
      ${quietBtn("Cancel", "orgMemberCancel", { disabled: d.saving })}
      ${dangerLink("Remove from org", "orgConfirm", { arg: `member:${m.handle}`, disabled: d.saving || soleOwner || (m.role === "owner" && !owner), field: `orgConfirm:member:${m.handle}`, title: soleOwner ? "The only owner cannot be removed" : undefined })}
    </div>
  </div>`;
}

/** What happened to an invite's e-mail, as one short phrase for its row (and whether it needs attention). */
export function inviteMailNote(i: OrgInvite): { text: string; bad: boolean } {
  if (i.github_login) return { text: "No email: they see it when they sign in", bad: false };
  if (i.mail_status === "sent") return { text: `Email sent ${i.mail_at ? relTime(i.mail_at) : ""}`.trim(), bad: false };
  if (i.mail_status === "failed") return { text: `Email not sent${i.mail_at ? ` (tried ${relTime(i.mail_at)})` : ""}`, bad: true };
  return { text: "No email sent yet", bad: false };
}

/** Members › Unmatched logins: only for an admin, and only while a login waits (or one was
 *  discarded and can be restored) — empty is its normal state, and then it is not there. */
export function unmatchedLogins(admin: boolean, identity: IdentityProps | null | undefined): string {
  if (!admin || !identity) return "";
  const body = identitySection(identity);
  if (identity.groups.length === 0) {
    return identity.status === "error" ? `<section data-org-identity>${failedNote("the unmatched logins")}</section>`
      : body ? `<section data-org-identity="discarded" aria-label="Discarded logins">${body}</section>` : "";
  }
  return `<section data-org-identity aria-labelledby="org-identity-t">
      ${orgHead("Unmatched logins", "GitHub logins in captured activity that belong to no one yet", identity.groups.length, "org-identity-t")}
      ${body}
    </section>`;
}

export function membersTab(org: MyOrg, ui: OrgUi, me: string, identity: IdentityProps | null = null, dd: DropdownUi = initialDropdownUi()): string {
  const admin = roleAtLeast(org.role, "admin");
  const members = ui.members.data;
  const note = sliceNote(ui.members, "members", members.length > 0);
  if (note) return note;
  const owners = members.filter((m) => m.role === "owner").length;
  const canSend = inviteDraftOk(ui.inviteBy, ui.inviteDraft) && !ui.inviteBusy;
  // The plan's seats (org-plan.ts): a one-person plan offers no invitation at all; with every
  // seat in use the form gives way to the sentence the server would answer with.
  const gate = inviteGate(ui.plan.data, org.role);
  // Inviting is this tab's primary action (its one accent button): one line of controls in
  // one surface, with what happens next said once, under them.
  const invite = !admin || gate.kind === "solo" ? ""
    : gate.kind !== "open" ? `<section aria-labelledby="org-invite-t" data-invite-gate="${gate.kind}">
      ${orgHead("Invite someone", "", null, "org-invite-t")}
      <div${surface("padding:14px 16px")}><p role="status" style="margin:0;font-size:13px;line-height:1.55;color:var(--fg-70)">${esc(gate.sentence)}${gate.kind === "full" ? " Removing a member or revoking a pending invite frees a seat." : ""}</p></div>
    </section>`
    : `<section aria-labelledby="org-invite-t">
      ${orgHead("Invite someone", "", null, "org-invite-t")}
      <div${surface("padding:14px 16px")}>
        <div class="cnpy-org-invite">
          ${segmented({ id: "org-invite-by", ariaLabel: "Invite by", act: "orgInviteBy", value: ui.inviteBy, size: "sm", inertOn: true, options: [{ value: "github", label: "GitHub login" }, { value: "email", label: "Email" }] })}
          <input id="org-invite" data-act="orgInviteDraft" data-field="orgInvite" data-enter="orgInviteSend" value="${attr(ui.inviteDraft)}" placeholder="${ui.inviteBy === "github" ? "octocat" : "name@example.com"}" aria-label="${ui.inviteBy === "github" ? "GitHub login to invite" : "Email address to invite"}"${ui.inviteBy === "email" ? ' type="email" inputmode="email"' : ""} autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="org-invite-h${ui.inviteError ? " org-invite-e" : ""}"${ui.inviteError ? ' aria-invalid="true"' : ""} class="cnpy-input" style="${O_FIELD};flex:1 1 200px;width:auto;min-width:0;${ui.inviteError ? "border-color:var(--red);" : ""}" />
          ${ui.inviteBy === "email" ? `<input id="org-invite-name" data-act="orgInviteName" data-field="orgInviteName" data-enter="orgInviteSend" value="${attr(ui.inviteName)}" maxlength="${INVITE_NAME_MAX}" placeholder="Their name (optional)" aria-label="Their name, for the email's greeting (optional)" autocomplete="off" class="cnpy-input" style="${O_FIELD};flex:1 1 160px;width:auto;min-width:0" />` : ""}
          ${dropdown(inviteRoleDropdown(ui), dd)}
          ${accentBtn(ui.inviteBusy ? "Inviting…" : "Invite", "orgInviteSend", { disabled: !canSend, busy: ui.inviteBusy, extra: "height:36px" })}
        </div>
        ${ui.inviteError ? `<div id="org-invite-e" role="alert" style="${O_ERR}">${esc(ui.inviteError)}</div>` : ""}
        <div id="org-invite-h" style="${O_HELP};margin-top:9px">${ui.inviteBy === "email"
          ? "Trov emails them the invitation. They join when they sign in with that address and accept. A Google account can only sign in once it is invited."
          : "They see the invitation the next time they sign in with that GitHub account, and join when they accept. No email is sent: tell them it is waiting."}</div>
      </div>
    </section>`;

  const rows = members.map((m) => {
    const d = admin && ui.memberEdit && sameHandle(ui.memberEdit.handle, m.handle) ? ui.memberEdit : null;
    const name = m.name ?? m.handle;
    return `<li style="border-bottom:1px solid var(--border);margin-bottom:-1px${d ? ";background:var(--hover)" : ""}">
      <div class="cnpy-org-row" style="border-bottom:0;margin-bottom:0;align-items:center;padding-top:10px;padding-bottom:10px">
        <button type="button" data-act="openPerson" data-arg="${attr(m.handle)}" class="cnpy-maint-person" aria-label="Open ${attr(name)}'s card" style="flex:1 1 150px;min-width:0;display:flex;align-items:center;gap:12px;text-align:left;padding:0">${personChip(m, 28, m.handle)}<span style="flex:1;min-width:0;line-height:1.3"><span style="display:block;font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span><span style="display:flex;align-items:center;gap:8px;min-width:0">${handleTag(m, m.handle, 11.5)}${m.title ? `<span style="font-size:12px;color:var(--fg-40);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">&middot; ${esc(m.title)}</span>` : ""}</span></span></button>
        <div class="cnpy-org-actions is-inline" style="align-items:center;flex-wrap:nowrap">
          ${sameHandle(m.handle, me) ? YOU : ""}
          ${roleChip(m.role)}
          ${admin ? quietBtn(d ? "Close" : "Edit", d ? "orgMemberCancel" : "orgMemberEdit", { arg: m.handle, label: `${d ? "Close the editor for" : "Edit"} ${name}`, field: `orgMemberEdit:${m.handle}` }) : ""}
        </div>
      </div>
      ${d ? memberEditor(m, d, org.role, m.role === "owner" && owners <= 1, dd) : ""}
    </li>`;
  }).join("");

  const pending = admin ? ui.invites.data.filter((i) => i.status === "pending") : [];
  const inviteRows = pending.map((i) => {
    const who = i.github_login ? `@${i.github_login}` : i.email ?? "";
    const mail = inviteMailNote(i);
    return `<li class="cnpy-org-row" style="align-items:center;padding-top:10px;padding-bottom:10px">
      <div aria-hidden="true" style="width:28px;height:28px;border-radius:50%;border:1px dashed var(--border-strong);display:grid;place-items:center;color:var(--fg-40);font-size:12px;flex:none">?</div>
      <div style="flex:1 1 200px;min-width:0;line-height:1.35">
        <div style="font-size:13.5px;font-weight:600;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${i.name ? `${esc(i.name)} <span style="font-weight:400;color:var(--fg-55)">&middot; ${esc(who)}</span>` : esc(who)}</div>
        <div style="font-size:12px;color:var(--fg-40);overflow-wrap:anywhere">Invited ${esc(relTime(i.created_at))} by ${esc(i.invited_by)} &middot; <span data-invite-mail="${i.mail_status ?? "none"}" style="color:${mail.bad ? "var(--red)" : "inherit"}">${esc(mail.text)}${mail.bad && i.mail_error ? `: ${esc(i.mail_error)}` : ""}</span></div>
      </div>
      <div class="cnpy-org-actions" style="align-items:center">
        ${roleChip(i.role)}
        ${i.email ? quietBtn(ui.mailBusy === i.id ? "Sending…" : "Resend email", "orgInviteMail", { arg: String(i.id), disabled: ui.mailBusy !== null, busy: ui.mailBusy === i.id, label: `Email the invitation to ${who} again` }) : ""}
        ${dangerLink("Revoke", "orgInviteRevoke", { arg: String(i.id), label: `Revoke the invite for ${who}` })}
      </div>
    </li>`;
  }).join("");
  // Pending invites are a section only while someone IS waiting (or the read has not answered).
  const invitesBlock = !admin ? ""
    : pending.length ? `${orgHead("Pending invites", "", pending.length)}<ul${surface(LIST)}>${inviteRows}</ul>`
    : ui.invites.status === "error" ? `${orgHead("Pending invites")}${failedNote("invites")}`
    : ui.invites.status !== "ok" ? `${orgHead("Pending invites")}${loadingNote("invites")}`
    : "";

  const waiting = admin ? identity?.groups.length ?? 0 : 0;
  const seats = seatsLead(ui.plan.data);
  // A one-person plan: the tab says so (an admin also reads which plan allows invitations, and who changes it).
  const solo = gate.kind === "solo" ? ` <span data-plan-solo>${esc(admin ? gate.sentence : `${gate.sentence.split(". ")[0]}.`)}</span>` : "";
  const lead = tabLead(`${seats ? `${seats} &middot; ` : ""}<strong>${members.length}</strong> ${members.length === 1 ? "member" : "members"}${admin ? ` &middot; ${pending.length ? `<strong>${pending.length}</strong> ${pending.length === 1 ? "invite" : "invites"} pending` : "no invite pending"}` : ""}${waiting ? ` &middot; ${leadFlag(`${waiting} ${waiting === 1 ? "login" : "logins"} to match`, "amber")}` : ""}.${solo}${admin ? "" : READ_ONLY}`);
  const logins = unmatchedLogins(admin, identity);
  return `${lead}${waiting ? logins : ""}${invite}
    ${orgHead("Members", admin ? "Owners manage owners and the encryption key; admins everything else here" : "", members.length)}
    <ul${surface(LIST)}>${rows}</ul>
    ${invitesBlock}
    ${waiting ? "" : logins ? `<div style="margin-top:18px">${logins}</div>` : ""}`;
}

// ── NOTIFICATIONS ────────────────────────────────────────────────────────────

export function notificationsTab(org: MyOrg, notif: NotifAdminProps | null | undefined, dd: DropdownUi = initialDropdownUi()): string {
  if (!roleAtLeast(org.role, "admin") || !notif) return orgEmpty("Admins only", "The org's e-mail digests are set by an admin or an owner. Your own preferences are in Settings.");
  return notificationsAdminSections({ ...notif, dd });
}

// ── dropdowns ────────────────────────────────────────────────────────────────

/** Every dropdown on the tab that is showing, with the props its trigger was rendered from —
 *  what `orgOverlays` renders the open one's menu from (dropdown.ts). */
export function orgDropdowns(p: OrgSettingsProps): DropdownProps[] {
  if (!p.org || !roleAtLeast(p.org.role, "admin")) return [];
  const tab = effectiveOrgTab(p.ui.tab, p.org.role);
  if (tab === "notifications") return p.notif ? notifDropdowns(p.notif) : [];
  if (tab !== "members" || !p.ui.members.data.length) return [];
  const d = p.ui.memberEdit;
  const m = d ? p.ui.members.data.find((x) => sameHandle(x.handle, d.handle)) : undefined;
  return [inviteRoleDropdown(p.ui), ...(d && m ? [memberRoleDropdown(m, d, p.org.role)] : [])];
}

// ── confirmation modal ───────────────────────────────────────────────────────

const quote = (s: string) => `“${s}”`;

/** The words of the open confirmation: what is removed, and what stops working. Pure — exported for the tests. */
export function orgConfirmCopy(c: OrgConfirm, org: MyOrg, ui: OrgUi): { title: string; body: string; confirmLabel: string; busyLabel: string } | null {
  const list = ui.integrations.data?.integrations ?? [];
  if (c.what === "repo") {
    const r = ui.repos.data.find((x) => x.id === c.arg);
    if (!r) return null;
    return {
      title: `Remove ${r.repo_full_name}?`,
      body: `${org.name} stops tracking this repository. ${r.webhook_secret_configured ? "Its webhook secret is removed too, so deliveries signed with it are rejected." : "Its webhook secret, if one is set later, is removed with it."} What Trov already recorded from it stays.`,
      confirmLabel: "Remove repository", busyLabel: "Removing…",
    };
  }
  if (c.what === "env") {
    const e = ui.envs.data.find((x) => x.key === c.arg);
    if (!e) return null;
    const secrets = list.filter((i) => i.scope_type === "environment" && i.scope === e.key && i.configured).map((i) => i.label);
    return {
      title: `Delete the ${quote(e.label)} environment?`,
      body: `The Repo dashboard stops reporting on it. ${secrets.length ? `${secrets.length === 1 ? "This secret is" : "These secrets are"} deleted with it and cannot be recovered: ${secrets.join(", ")}.` : "No secrets are stored for it."}`,
      confirmLabel: "Delete environment", busyLabel: "Deleting…",
    };
  }
  if (c.what === "secret") {
    const i = list.find((x) => `${x.kind}:${x.scope}` === c.arg);
    if (!i) return null;
    return {
      title: `Delete the ${integrationLabel(i)}?`,
      body: `${i.expected ? SECRET_DELETE_EFFECT[i.kind] : "Nothing uses it any more: its environment or repository is gone."} The stored value is erased and cannot be recovered.`,
      confirmLabel: "Delete secret", busyLabel: "Deleting…",
    };
  }
  if (c.what === "member") {
    const m = ui.members.data.find((x) => sameHandle(x.handle, c.arg));
    if (!m) return null;
    return {
      title: `Remove ${m.name ?? m.handle} from ${org.name}?`,
      body: "They lose access to this org at once, and their MCP tokens and connected apps for it are revoked. Everything they wrote stays.",
      confirmLabel: "Remove member", busyLabel: "Removing…",
    };
  }
  const n = list.filter((i) => i.configured).length;
  return {
    title: "Rotate the encryption key?",
    body: `Trov makes a new key for ${org.name} and re-encrypts ${n === 1 ? "the 1 stored secret" : `all ${n} stored secrets`} with it. Your integrations keep working, and no value is shown or changed.`,
    confirmLabel: "Rotate key", busyLabel: "Rotating…",
  };
}

/** The root-level overlays of Org settings: the confirmation modal, or the secret form — and
 *  the open dropdown's menu, if one is open. */
export function orgOverlays(p: OrgSettingsProps): string {
  if (!p.org) return "";
  const ui = p.ui;
  const menu = p.dd?.open ? dropdownMenu(orgDropdowns(p), p.dd) : "";
  if (ui.confirm) {
    const copy = orgConfirmCopy(ui.confirm, p.org, ui);
    if (copy) return menu + confirmModal({ id: "org-confirm", ...copy, confirmAct: "orgConfirmGo", cancelAct: "orgConfirmCancel", busy: ui.confirm.busy });
  }
  if (ui.secretForm && roleAtLeast(p.org.role, "admin")) {
    const f = ui.secretForm;
    const i = ui.integrations.data?.integrations.find((x) => x.kind === f.kind && x.scope === f.scope);
    if (i) return menu + secretFormModal(i, f);
  }
  return menu;
}

// ── the screen ───────────────────────────────────────────────────────────────

/** The tab bar. Two tabs carry a count of what needs an admin there: integrations with an error,
 *  and (Members) logins waiting to be matched — `logins` is 0 for anyone who is not an admin. */
export function orgTabBar(tab: OrgTab, role: OrgRole | null, ui: OrgUi, logins = 0): string {
  const todo = ui.integrations.data ? ui.integrations.data.integrations.filter((i) => i.expected && (i.last_error !== null)).length : 0;
  const badge = (n: number, title: string) => `<span class="cnpy-badge" data-n="${n}" title="${attr(title)}">${n}</span>`;
  return tabBar({
    id: "org-tab", ariaLabel: "Org settings sections", act: "orgTab", value: tab,
    tabs: orgTabsFor(role).map((t) => ({
      value: t, label: TAB_LABEL[t],
      trail: t === "integrations" ? badge(todo, `${todo} with an error`) : t === "members" ? badge(logins, `${logins} ${logins === 1 ? "login" : "logins"} to match`) : "",
    })),
  });
}

/** Org settings, whole: the setup checklist (admins, until done), the tab bar, the tab — each tab
 *  opening with its lead line (org-ui.ts `tabLead`), never an intro paragraph. */
export function orgSettingsView(p: OrgSettingsProps): string {
  const shell = (inner: string) => `<div data-screen-label="Org settings" class="cnpy-org" style="width:100%;max-width:1180px;margin:0 auto;padding:18px clamp(20px,2.6vw,46px) 100px;box-sizing:border-box">${inner}</div>`;
  if (!p.org) {
    if (p.orgsStatus === "error") return shell(failedNote("your orgs"));
    if (p.orgsStatus === "ok") return shell(orgEmpty("This organization isn't open", "Pick an organization from the switcher at the top of the sidebar."));
    return shell(loadingNote("your org"));
  }
  const tab = effectiveOrgTab(p.ui.tab, p.org.role);
  const body = tab === "integrations" ? integrationsTab(p.org, p.ui)
    : tab === "repos" ? reposTab(p.org, p.ui)
    : tab === "environments" ? environmentsTab(p.org, p.ui)
    : tab === "members" ? membersTab(p.org, p.ui, p.me, p.identity ?? null, p.dd)
    : tab === "notifications" ? notificationsTab(p.org, p.notif, p.dd)
    : generalTab(p.org, p.ui);
  const logins = roleAtLeast(p.org.role, "admin") ? p.identity?.groups.length ?? 0 : 0;
  // The checklist's slot is always there (empty once setup is done), so the tab bar under it is
  // the same child of the page on every paint — the page is patched in place (morph.ts).
  return shell(`<div data-setup-slot>${setupChecklist(p.org, p.ui)}</div>
    ${orgTabBar(tab, p.org.role, p.ui, logins)}
    <div${tabPanelAttrs("org-tab", tab)} style="padding-top:18px">${body}</div>`);
}
