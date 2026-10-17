// Org settings — the ONE place an org is administered from (canopy-multitenancy.md §5.3,
// §8.7): seven tabs under one screen, `#org[/<tab>]`.
//   INTEGRATIONS  — the org's credentials (web/src/integrations.ts). Admin+ only.
//   REPOSITORIES  — connected repos, one primary; an admin opens a repository's Apps from its row
//                   (`#org/repos/<owner>/<name>`, web/src/repo-apps.ts — repo setups, Phase D2).
//   ENVIRONMENTS  — the environments the Repo dashboard reports on, in drift order.
//   HOSTING       — which host runs each part of each environment, and the org's connection to
//                   each host (web/src/hosting.ts). Admin+ only.
//   MEMBERS       — the people directory: org roles, titles, removal, invites by GitHub login
//                   or email, and (admins) the unmatched logins to map to a person
//                   (web/src/identity.ts — Maintenance › Identity until 2026-10-06).
//   TAGS          — the org's ONE tag list (web/src/tags.ts): every member reads it; an admin adds,
//                   renames, merges and retires, and settles what agents suggested.
//   NOTIFICATIONS — the e-mail digests: which exist and their default cadence, the send hour,
//                   timezone and sender name, preview and test send, the outbox
//                   (web/src/notifications.ts — under Maintenance › People until then). Admin+ only.
//   AI            — the switch for what Trov writes, this month's AI runs, what is sent to Anthropic
//                   (web/src/org-ai.ts). Everyone reads it; an admin or an owner flips the switch.
//   GENERAL       — the org's name; its slug, read-only.
// A member who is not an admin sees what the API lets them read: no Integrations, no Hosting and no
// Notifications tab, and the other four read-only. Above the tabs an admin of a new org gets a setup checklist,
// each item derived from live data, gone once all four are done.
//
// Purely presentational: props in, markup out (the app's idiom — template strings, inline
// styles over the trov.css tokens, `data-act` / `data-arg` dispatched in main.ts to
// web/src/org-actions.ts). Every act here starts with `org`.
//
// "The current org" is ONE function, `currentOrg`: the org the page's path names.

import { planBlock, inviteGate, seatsLead } from "./org-plan";
import { isSoloPlan } from "@shared/plans";
import { esc, attr, relTime, surface } from "./ui";
import {
  O_LABEL, O_FIELD, O_HELP, O_ERR, YOU, accentBtn, quietBtn, dangerLink, goLink, orgHead, orgEmpty, orgBanner, loadingNote, failedNote,
  sliceNote, roleWord, ROLE_WORD, roleOption, roleAtLeast, sameHandle, textField, tabLead, leadFlag, openRow, type OrgSlice,
} from "./org-ui";
import { kindMark } from "./marks";
import { tagsTab, tagConfirmModal, tagAddModal, initialTagsUi } from "./tags";
export { roleAtLeast };
export type { OrgSlice };
import { tabBar, tabPanelAttrs } from "./tabs";
import { dropdown, dropdownMenu, initialDropdownUi, type DropdownProps, type DropdownUi } from "./dropdown";
import { personChip, handleTag } from "./people";
import { confirmModal } from "./confirm";
import { orgDeleteModal, orgDeleteTile } from "./deletion";
import { ROLE_MAX, RESPONSIBILITIES_MAX } from "@shared/people";
import { ORG_NAME_MAX, type MyOrg, type OrgMember, type OrgRole } from "@shared/orgs";
import type { IntegrationDTO, IntegrationKind, OrgEnvironmentDTO, OrgRepoDTO } from "@shared/integrations";
import { integrationsTab, secretFormModal, integrationLabel, SECRET_DELETE_EFFECT } from "./integrations";
import { identitySection, type IdentityProps } from "./identity";
import { notificationsAdminSections, notifDropdowns, type NotifAdminProps } from "./notifications";
import { orgLogoSection } from "./org-logo";
import { NOT_CONFIGURED_LINE, appLeadPhrase, connectLink, connectNotice, existingLink, githubAppRow, githubLink, lostBanner, mismatchBanner, repoPicker, suspendedBanner } from "./github-app";
import { disconnectConfirmCopy, hostingData, hostingDropdowns, hostingOverlay, hostingPartRow, hostingTab, hostingTodo, leftoversConfirmCopy, partConfirmCopy } from "./hosting";
import { onIntegrationsTab } from "./integrations";
import { githubInstallHref } from "./api";
import { aiTab } from "./org-ai";
import { appRemoveCopy, repoAppsDropdowns, repoAppsPage } from "./repo-apps";
// The state (OrgUi and its first value), the tabs and the current org are org-core.ts; the invite form
// (Members' and the first-run setup's) is org-invite.ts — both in the app's first download. This module
// is the lazy Org settings chunk (org-lazy.ts) and re-exports them unchanged.
export {
  ORG_TABS, isOrgTab, ENV_TEXT_FIELDS, blankEnvFields, envFieldsOf, initialOrgUi, currentOrg, orgTabsFor, effectiveOrgTab, githubOf,
  type OrgTab, type EnvField, type EnvDraft, type MemberDraft, type OrgConfirm, type OrgUi, type OrgSettingsProps,
} from "./org-core";
import {
  ENV_TEXT_FIELDS, orgTabsFor, effectiveOrgTab, githubOf,
  type OrgTab, type EnvDraft, type EnvField, type MemberDraft, type OrgConfirm, type OrgUi, type OrgSettingsProps,
} from "./org-core";
export { inviteDraftOk, inviteRoleDropdown, inviteMailNote, inviteSection } from "./org-invite";
import { inviteRoleDropdown, inviteMailNote, inviteSection } from "./org-invite";
const TAB_LABEL: Record<OrgTab, string> = { integrations: "Integrations", repos: "Repositories", environments: "Environments", hosting: "Hosting", members: "Members", tags: "Tags", notifications: "Notifications", ai: "AI", general: "General" };

// ── setup checklist ──────────────────────────────────────────────────────────

export interface SetupStep { key: "repo" | "env" | "token" | "team"; title: string; why: string; tab: OrgTab; go: string; done: boolean }

/**
 * A new org's four first steps, each read off live data — or null while any of that data
 * has not arrived (a checklist that flickers to "all done" and back helps nobody). GitHub
 * counts as connected through the App's installation, a stored token, or the platform's
 * legacy credential answering for it.
 */
export function setupSteps(ui: OrgUi): SetupStep[] | null {
  if (ui.repos.status !== "ok" || ui.envs.status !== "ok" || ui.members.status !== "ok" || ui.invites.status !== "ok" || ui.integrations.status !== "ok" || !ui.integrations.data) return null;
  const token = ui.integrations.data.integrations.find((i) => i.kind === "github_token");
  // A one-person plan has no team to invite: the step would never be done, so it is not asked. (A Pro
  // org that bought one seat is not one: it invites by adding a seat.)
  const solo = ui.plan.data?.entitlements.seats === 1 && isSoloPlan(ui.plan.data.plan);
  // GitHub is connected by the App's installation or, by hand, by a token (the fallback).
  const app = githubOf(ui);
  const offered = app?.configured === true;
  const connected = !!app?.installation || (!!token && (token.configured || token.legacy_fallback));
  const repos = ui.repos.data.length > 0;
  // There is NO separate GitHub or token step: connecting a repository is the GitHub step, done once a
  // repository is connected AND GitHub can be read. Where the App is offered that is installing it (no token);
  // on a Trov with no App (self-hosted) it is the repository plus the token — the step leads to Integrations
  // for the token once the repository is there.
  const repoStep: SetupStep = offered
    ? { key: "repo", title: "Connect a repository", why: "Install the Trov App on GitHub and pick the repository: Trov reads its deployments, checks, pull requests and issues.", tab: "repos", go: "Open Repositories", done: repos && connected }
    : repos && !connected
      ? { key: "repo", title: "Connect a repository", why: "Set the GitHub token so Trov can read the repository.", tab: "integrations", go: "Open Integrations", done: false }
      : { key: "repo", title: "Connect a repository", why: "Add the repository and set a GitHub token: Trov reads its deployments, checks, pull requests and issues.", tab: "repos", go: "Open Repositories", done: repos && connected };
  const steps: SetupStep[] = [
    repoStep,
    { key: "env", title: "Add an environment", why: "The Repo dashboard reports on each one: staging, production.", tab: "environments", go: "Open Environments", done: ui.envs.data.length > 0 },
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
      <div style="font-size:12px;color:var(--fg-55);margin-top:1px">${done} of ${steps.length} done &middot; <button type="button" data-act="welcomeOpen" data-field="welcomeOpen" data-org-setup-guided class="cnpy-mutelink" style="padding:0;font-size:12px;font-weight:500;color:var(--accent)">Open the guided setup</button></div>
    </div>
    <ol class="cnpy-setup-steps">${items}</ol>
  </section>`;
}

// ── GENERAL ──────────────────────────────────────────────────────────────────

/** General is a bento inside the tab's width (trov.css `.cnpy-org-gen`, the Settings bento's tiles):
 *  image + name | slug | plan on the first row, the plan's limits across the page under them. It
 *  folds by the room the tab has (a container query): two columns, then one. DOM order is the
 *  folded order. */
export function generalTab(org: MyOrg, ui: OrgUi): string {
  const s = ui.settings;
  if (!s.data) return sliceNote(s, "the org's settings", false, { form: true });
  const canEdit = s.data.can_edit;
  const stored = s.data.org.name;
  const draft = ui.nameDraft ?? stored;
  const changed = draft.trim() !== stored && draft.trim().length > 0;
  const nameRow = canEdit
    ? `${textField({ id: "org-name", label: "Name", act: "orgNameDraft", field: "orgName", value: draft, max: ORG_NAME_MAX, enter: "orgNameSave", error: ui.nameError, help: "Changing it does not change the slug or any link." })}
       <div style="display:flex;gap:8px;margin-top:14px">${accentBtn(ui.nameSaving ? "Saving…" : "Save name", "orgNameSave", { disabled: !changed || ui.nameSaving, busy: ui.nameSaving })}${ui.nameDraft !== null && !ui.nameSaving ? quietBtn("Cancel", "orgNameCancel") : ""}</div>`
    : `<div style="${O_LABEL}">Name</div><div style="font-size:14px;margin-top:7px;overflow-wrap:anywhere">${esc(stored)}</div>`;
  return `${tabLead(`Created ${esc(relTime(s.data.org.created_at))} by <strong>${esc(s.data.org.created_by)}</strong> &middot; you are ${org.role === "member" ? "a" : "an"} <strong>${ROLE_WORD[org.role].toLowerCase()}</strong> here${canEdit ? "" : ". Only an admin or an owner can rename the org."}`)}
    <div class="cnpy-org-gen-wrap"><div class="cnpy-org-gen${canEdit ? "" : " cnpy-org-gen--read"}">
    <section${surface("", { cls: "cnpy-tile cnpy-org-gen-id" })} aria-label="Image and name">
      ${orgLogoSection({ name: stored, logo: s.data.org.logo, canEdit, ui: ui.logo, repo: ui.repos.data.find((r) => r.is_primary)?.repo_full_name ?? null })}
      ${nameRow}
    </section>
    <section${surface("", { cls: "cnpy-tile cnpy-org-gen-slug" })} aria-label="Slug">
      <div style="${O_LABEL}">Slug</div>
      <div style="margin-top:7px"><code style="font-family:var(--code);font-size:12.5px;color:var(--fg);overflow-wrap:anywhere">${esc(s.data.org.slug)}</code></div>
      <div class="cnpy-tile-foot" style="${O_HELP};margin-top:auto;padding-top:12px">The org's permanent address in links and in the API. It cannot be changed.</div>
    </section>
    ${planBlock(ui.plan, org.role, ui.billing)}
    ${org.role === "owner" ? orgDeleteTile(org, ui.del) : ""}
  </div></div>`;
}

// ── REPOSITORIES ─────────────────────────────────────────────────────────────

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const repoDraftOk = (v: string): boolean => REPO_RE.test(v.trim());

const READ_ONLY = " You can read this; an admin or an owner can change it.";
const LIST = "overflow:hidden;list-style:none;margin:0;padding:0";

/** The by-name add: the name, and Add. `accent` only where it is the tab's primary action (no App). */
function repoAddBar(ui: OrgUi, accent: boolean): string {
  const btn = accent ? accentBtn : quietBtn;
  return `<div class="cnpy-org-addbar">
      <input id="org-repo" data-act="orgRepoDraft" data-field="orgRepo" data-enter="orgRepoAdd" value="${attr(ui.repoDraft)}" placeholder="owner/repo" aria-label="Repository to add, as owner/repo" title="The name as it appears on GitHub, for example acme/web" autocomplete="off" autocapitalize="off" spellcheck="false"${ui.repoError ? ' aria-invalid="true" aria-describedby="org-repo-e"' : ""} class="cnpy-input" style="${O_FIELD};height:32px;width:220px;flex:1 1 180px;font-size:13px;${ui.repoError ? "border-color:var(--red);" : ""}" />
      ${btn(ui.repoBusy ? "Adding…" : "Add repository", "orgRepoAdd", { disabled: !repoDraftOk(ui.repoDraft) || ui.repoBusy, busy: ui.repoBusy })}
    </div>`;
}

/**
 * Repositories. How an org connects GitHub decides the tab's ONE primary action:
 *   the App is not set up on this Trov → add a repository by name (as before the App existed);
 *   the App is offered, not connected  → Connect with GitHub; by name is the quiet alternative;
 *   connected                          → pick from what the installation can see (quiet Track buttons).
 */
export function reposTab(org: MyOrg, ui: OrgUi): string {
  const admin = roleAtLeast(org.role, "admin");
  const repos = ui.repos.data;
  const app = githubOf(ui);
  const appKnown = app !== null || ui.github.status === "error";
  const note = sliceNote(ui.repos, "repositories", repos.length > 0 || ui.repos.status === "ok", { rows: 2 });
  if (note) return note;
  // Whether the App is offered decides the tab's primary action: wait for it rather than flash the wrong one.
  if (!appKnown) return loadingNote("repositories");
  const inst = app?.installation ?? null;
  const offered = app?.configured === true;
  const live = !!inst && !inst.suspended_at;
  const err = ui.repoError ? `<div id="org-repo-e" role="alert" style="${O_ERR};margin:8px 0 0">${esc(ui.repoError)}</div>` : "";
  const primary = repos.find((r) => r.is_primary);
  const viaApp = (r: OrgRepoDTO): boolean => !!inst && r.connection === "app";
  // A missing webhook secret is worth flagging only on the by-hand path: where the App is offered and
  // no token is set, the next step is Connect with GitHub, not a webhook.
  const token = ui.integrations.data?.integrations.find((i) => i.kind === "github_token");
  const byHand = !offered || (!!token && (token.configured || token.legacy_fallback));
  const unsigned = admin && byHand ? repos.filter((r) => !viaApp(r) && !r.webhook_secret_configured).length : 0;
  const lost = inst ? repos.filter((r) => viaApp(r) && r.access_lost).length : 0;

  const action = !admin ? ""
    : inst ? (inst.manage_url ? githubLink("Manage on GitHub", inst.manage_url, `Manage the Trov App on ${inst.account_login}, on GitHub`) : "")
    : offered ? connectLink(org.slug)
    : repoAddBar(ui, true);
  const none = inst ? `Connected to GitHub ${appLeadPhrase(inst)}. No repository is tracked yet${admin ? ": pick one below. The first becomes the primary" : ""}.`
    : `No repository connected.${admin ? (offered ? " Connect GitHub to choose from your repositories." : " The first one you add becomes the primary.") : READ_ONLY}`;
  const lead = tabLead(repos.length === 0 ? none
    : `<strong>${repos.length}</strong> ${repos.length === 1 ? "repository" : "repositories"}${primary ? ` &middot; primary <code title="The Repo dashboard, Sync GitHub and drift read the primary repository">${esc(primary.repo_full_name)}</code>` : ""}${inst ? ` &middot; ${appLeadPhrase(inst)}` : ""}${lost ? ` &middot; ${leadFlag(`${lost} no longer visible to the App`, "amber")}` : ""}${unsigned && !inst ? ` &middot; ${leadFlag(`${unsigned} without a webhook secret`, "amber")}` : ""}.${admin ? "" : READ_ONLY}`, action);

  const rows = repos.map((r) => {
    const id = r.id ?? "";
    const through = viaApp(r);
    // The primary can only be removed last (the API's `primary_repo`): say so instead of offering a button that fails.
    const locked = r.is_primary && repos.length > 1;
    const hook = admin && r.webhook_url && !through ? `<div style="margin-top:10px">
        <span style="${O_LABEL};font-size:10px">Webhook URL</span>
        <code class="cnpy-org-code">${esc(r.webhook_url)}</code>
        <span style="display:block;font-size:12px;color:var(--fg-40)">${r.webhook_secret_configured ? "The payload URL of this repository's GitHub webhook. Deliveries are checked against the secret set in Integrations." : "Deliveries to this URL are rejected until its webhook secret is set in Integrations. Set the secret first, then add the webhook on GitHub."}</span>
      </div>` : "";
    const how = through
      ? r.access_lost
        ? `<div data-org-repo-lost style="margin-top:6px;color:var(--fg-70)">The Trov App on ${esc(inst?.account_login ?? "GitHub")} can no longer see this repository, so nothing new is read from it. Give the App access to it again on GitHub${admin ? ", or remove it here" : ""}.</div>`
        : `<div style="margin-top:6px">Read through the GitHub App: it needs no token and no webhook of its own.</div>`
      : inst ? `<div style="margin-top:6px">Outside the account the GitHub App is installed on, so it is read with the GitHub token and its own webhook.</div>` : "";
    const capture = r.is_primary ? "" : `<div style="margin-top:6px">Events are captured for the primary repository only. This one resolves links and can be made the primary.</div>`;
    const actions = admin ? `<div class="cnpy-xrow-acts">
        ${r.is_primary ? "" : quietBtn("Make primary", "orgRepoPrimary", { arg: r.repo_full_name, disabled: ui.repoBusy, label: `Make ${r.repo_full_name} the primary repository` })}
        ${through || r.webhook_secret_configured ? "" : quietBtn("Set its webhook secret", "orgTab", { arg: "integrations" })}
        ${dangerLink("Remove", "orgConfirm", { arg: `repo:${id}`, disabled: locked, label: `Remove ${r.repo_full_name}`, field: `orgConfirm:repo:${id}`, title: locked ? "Make another repository the primary first" : undefined })}
      </div>` : "";
    const key = `repo:${r.repo_full_name}`;
    return openRow({
      key, open: ui.openRows.includes(key), act: "orgRowToggle", label: `${r.repo_full_name}${r.is_primary ? ", primary" : ""}${through && r.access_lost ? ", no longer visible to the App" : ""}`,
      // What the repository ships — its apps and their parts — is set up on its own page (admins).
      action: admin ? quietBtn("Apps", "orgAppsGo", { arg: `repo:${r.repo_full_name}`, field: `orgAppsRepo:${r.repo_full_name}`, label: `The apps of ${r.repo_full_name}` }) : undefined,
      head: `<span>${esc(r.repo_full_name)}</span>${r.is_primary ? `<span style="font-size:12px;font-weight:500;color:var(--fg-55)">Primary</span>` : ""}${through && r.access_lost ? kindMark("No longer visible", "warn", 12, "The GitHub App can no longer see this repository.") : ""}`,
      meta: !admin ? `Added ${esc(relTime(r.created_at))}` : through ? (r.access_lost ? "Not visible to the App" : "Through the GitHub App") : `Webhook secret ${r.webhook_secret_configured ? "set" : "not set"}`,
      body: `<div>Added ${esc(relTime(r.created_at))} by ${esc(r.created_by)}.${locked && admin ? " To remove it, make another repository the primary first." : ""}</div>${how}${capture}${hook}${actions}`,
      attrs: ` data-org-repo="${attr(r.repo_full_name)}" data-connection="${through ? "app" : "manual"}"`,
    });
  }).join("");

  const connected = repos.length
    ? `${orgHead("Connected", "", repos.length)}<ul${surface(LIST)}>${rows}</ul>`
    : inst ? ""
    : orgEmpty("No repository connected", admin ? (offered ? "Connect GitHub and pick the repository your team ships from. Trov reads its deployments, checks, pull requests and issues." : "Add the repository your team ships from. Trov reads its deployments, checks, pull requests and issues.") : "An admin has not connected a repository yet.", "", 2);
  const picker = admin && inst && live ? repoPicker(ui.githubRepos, inst.account_login, {
    filter: ui.githubFilter, busy: ui.githubBusy,
    ...(inst.repo_access === "selected" ? { selected: { by: inst.connected_by, href: githubInstallHref(org.slug, { existing: true, account: inst.account_login }) } } : {}),
  }) : "";
  const appRow = inst ? `<section aria-labelledby="org-gh-conn" data-org-group="github-app">
      ${orgHead("Connection", "", null, "org-gh-conn")}
      <ul${surface(LIST)}>${githubAppRow(inst, { open: ui.openRows.includes("github-app"), admin, tracked: repos.filter(viaApp).length, test: ui.tests.github_app, busy: ui.confirm?.what === "github" })}</ul>
    </section>` : "";
  // By name: the tab's primary where the App is not offered (it is in the lead); otherwise the
  // quiet alternative, behind a disclosure — for a repository the App cannot see.
  const manualOpen = ui.openRows.includes("repo-manual") || !!ui.repoError;
  const manual = !admin ? ""
    : !offered ? `${err}${app ? `<div data-org-github-off style="${O_HELP};margin:-12px 0 20px">${esc(NOT_CONFIGURED_LINE)}</div>` : ""}`
    : `<div style="margin-top:22px" data-org-repo-manual>
        <button type="button" data-act="orgRowToggle" data-arg="repo-manual" data-field="row:repo-manual" aria-expanded="${manualOpen}" aria-controls="org-repo-manual" class="cnpy-mutelink" style="display:inline-flex;align-items:center;gap:6px;padding:4px 0;font-size:12.5px;font-weight:500;color:var(--fg-55);text-align:left"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true" style="transform:${manualOpen ? "rotate(90deg)" : "none"};transition:transform .15s ease"><path d="M9 6l6 6-6 6"></path></svg>Add a repository by name instead</button>
        <div id="org-repo-manual"${manualOpen ? "" : " hidden"} style="padding-top:8px">
          ${repoAddBar(ui, false)}${err}
          <div style="${O_HELP}">For a repository the GitHub App cannot see. It is read with the GitHub token, and needs its own webhook: both are set in Integrations.</div>
        </div>
      </div>`;
  const already = admin && offered && !inst ? `<div style="font-size:12.5px;color:var(--fg-55);margin:-12px 0 20px">Already installed the Trov App on GitHub? ${existingLink(org.slug, "Link the existing installation")}</div>` : "";
  return `${connectNotice(ui.githubNotice, org.slug, org.name)}${lostBanner(app, admin)}${suspendedBanner(inst)}${mismatchBanner(app, admin, org.slug)}${lead}${offered ? "" : manual}${already}
    ${connected}
    ${picker}
    ${appRow}
    ${offered ? manual : ""}`;
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
};
/** A field's name as the form shows it (`key` is the new environment's Key). */
export const envFieldLabel = (field: string): string | null =>
  field === "key" ? "Key" : (ENV_META as Record<string, { label: string } | undefined>)[field]?.label ?? null;
const ENV_BASIC: EnvField[] = ["label", "branch", "note"];
const ENV_URLS: EnvField[] = ["frontend_url", "api_url", "health_path"];

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
    `The token is only ever sent to the API URL it was saved for, so pointing <strong style="font-weight:600">${esc(d.fields.label || d.key || "this environment")}</strong> at another host removes it. ${metricsSet ? "After saving, set a new one in one of its parts, on Hosting." : "None is stored right now, so nothing is lost."}`,
  )}</div>` : "";
  const general = d.error && (d.errorField === null || !(d.errorField === "key" || (ENV_TEXT_FIELDS as readonly string[]).includes(d.errorField)));
  return `<section${framed ? surface("padding:18px 20px;margin-bottom:24px") : ` style="padding:4px 0 2px"`} data-org-envform aria-labelledby="org-envform-t">
    <h3 id="org-envform-t" style="margin:0 0 14px;font-size:13.5px;font-weight:600">${adding ? "Add an environment" : `Edit ${esc(current?.label ?? d.key ?? "")}`}</h3>
    <div class="cnpy-org-grid">
      ${adding ? textField({ id: "org-env-key", label: "Key", act: "orgEnvKey", field: "orgEnvKey", value: d.keyDraft, help: "Its permanent id: lowercase letters, digits, - or _. For example <code style=\"font-family:var(--code)\">staging</code>.", placeholder: "staging", max: 32, required: true, disabled: d.saving, error: d.errorField === "key" ? d.error : null }) : ""}
      ${ENV_BASIC.map(f).join("")}
    </div>
    <div style="${O_LABEL};margin-top:20px">Where it runs</div>
    <div class="cnpy-org-grid" style="margin-top:10px">${ENV_URLS.map(f).join("")}</div>
    ${warn}
    <div style="${O_HELP};margin-top:14px" data-org-env-hosting>What runs it — a Cloudflare Worker, a Railway service, a Vercel project — and its app metrics token are set in ${goLink("Hosting", "orgTab", "hosting")}.</div>
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
  const note = sliceNote(ui.envs, "environments", envs.length > 0 || ui.envs.status === "ok", { rows: 2 });
  if (note) return note;
  const stored = (kind: IntegrationKind, key: string): boolean =>
    !!ui.integrations.data?.integrations.some((i) => i.kind === kind && i.scope === key && i.configured);
  const edit = ui.envEdit;
  const adding = edit && edit.key === null ? envForm(edit, null, false) : "";
  const addBtn = admin ? accentBtn("Add environment", "orgEnvNew", { field: "orgEnvNew", disabled: !!edit }) : "";
  if (envs.length === 0) {
    return `${tabLead(`No environments yet.${admin ? " Add the places your app runs, such as staging and production." : READ_ONLY}`, addBtn)}${adding || orgEmpty("No environments yet", admin ? "The Repo dashboard reports on each one you add." : "An admin has not added an environment yet.", "", 2)}`;
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
            ${role ? `<span style="font-size:12px;color:var(--fg-55)">${esc(role)}</span>` : ""}
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
    ${orgHead("In drift order", admin ? goLink("What each one runs is set per app in Repositories", "orgTab", "repos") : "", envs.length)}
    <ol${surface(LIST)}>${rows}</ol>`;
}

// ── MEMBERS ──────────────────────────────────────────────────────────────────

/** Why the only owner cannot be demoted or removed — the API's `last_owner`, as a sentence. */
export const lastOwnerSentence = (name: string): string =>
  `${name} is the only owner. Make someone else an owner first, then try again.`;

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
  const note = sliceNote(ui.members, "members", members.length > 0, { rows: 4, avatar: 28, trail: 84 });
  if (note) return note;
  const owners = members.filter((m) => m.role === "owner").length;
  const gate = inviteGate(ui.plan.data, org.role);
  // Inviting is this tab's primary action (its one accent button).
  const invite = inviteSection(org, ui, dd);

  // The members are a TABLE: each fact in its own column, in the same place on every row — who, their
  // handle, their title, when they joined, their role — so the list is scanned down a column instead of
  // read across a run-on line. (A list in the DOM; the columns are one grid shared by head and rows.)
  const joined = (iso: string): string => {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? "&mdash;" : esc(t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }));
  };
  const head = `<div class="cnpy-mem-row cnpy-mem-head${admin ? "" : " is-ro"}" aria-hidden="true"><span>Member</span><span>Handle</span><span>Title</span><span class="cnpy-mem-joined">Joined</span><span>Role</span>${admin ? "<span></span>" : ""}</div>`;
  const rows = members.map((m) => {
    const d = admin && ui.memberEdit && sameHandle(ui.memberEdit.handle, m.handle) ? ui.memberEdit : null;
    const name = m.name ?? m.handle;
    return `<li style="border-bottom:1px solid var(--border);margin-bottom:-1px${d ? ";background:var(--hover)" : ""}">
      <div class="cnpy-mem-row${admin ? "" : " is-ro"}" data-member="${attr(m.handle)}">
        <button type="button" data-act="openPerson" data-arg="${attr(m.handle)}" class="cnpy-maint-person cnpy-mem-who" aria-label="Open ${attr(name)}'s card" style="min-width:0;display:flex;align-items:center;gap:12px;text-align:left;padding:0">${personChip(m, 28, m.handle)}<span style="flex:0 1 auto;min-width:0;font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>${sameHandle(m.handle, me) ? YOU : ""}</button>
        <span class="cnpy-mem-handle">${handleTag(m, m.handle, 12)}</span>
        <span class="cnpy-mem-title"${m.title ? "" : ' data-empty="1"'}>${m.title ? esc(m.title) : "&mdash;"}</span>
        <span class="cnpy-mem-joined">${joined(m.joined_at)}</span>
        <span class="cnpy-mem-role">${roleWord(m.role)}</span>
        ${admin ? `<span class="cnpy-mem-act">${quietBtn(d ? "Close" : "Edit", d ? "orgMemberCancel" : "orgMemberEdit", { arg: m.handle, label: `${d ? "Close the editor for" : "Edit"} ${name}`, field: `orgMemberEdit:${m.handle}` })}</span>` : ""}
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
        ${roleWord(i.role)}
        ${i.email ? quietBtn(ui.mailBusy === i.id ? "Sending…" : "Resend email", "orgInviteMail", { arg: String(i.id), disabled: ui.mailBusy !== null, busy: ui.mailBusy === i.id, label: `Email the invitation to ${who} again` }) : ""}
        ${dangerLink("Revoke", "orgInviteRevoke", { arg: String(i.id), label: `Revoke the invite for ${who}` })}
      </div>
    </li>`;
  }).join("");
  // Pending invites are a section only while someone IS waiting (or the read has not answered).
  const invitesBlock = !admin ? ""
    : pending.length ? `${orgHead("Pending invites", "", pending.length)}<ul${surface(LIST)}>${inviteRows}</ul>`
    : ui.invites.status === "error" ? `${orgHead("Pending invites")}${failedNote("invites")}`
    : ui.invites.status !== "ok" ? `${orgHead("Pending invites")}${loadingNote("invites", { rows: 2 })}`
    : "";

  const waiting = admin ? identity?.groups.length ?? 0 : 0;
  const seats = seatsLead(ui.plan.data);
  // A one-person plan: the tab says so (an admin also reads which plan allows invitations, and who changes it).
  const solo = gate.kind === "solo" ? ` <span data-plan-solo>${esc(admin ? gate.sentence : `${gate.sentence.split(". ")[0]}.`)}</span>` : "";
  const lead = tabLead(`${seats ? `${seats} &middot; ` : ""}<strong>${members.length}</strong> ${members.length === 1 ? "member" : "members"}${admin ? ` &middot; ${pending.length ? `<strong>${pending.length}</strong> ${pending.length === 1 ? "invite" : "invites"} pending` : "no invite pending"}` : ""}${waiting ? ` &middot; ${leadFlag(`${waiting} ${waiting === 1 ? "login" : "logins"} to match`, "amber")}` : ""}.${solo}${admin ? "" : READ_ONLY}`);
  const logins = unmatchedLogins(admin, identity);
  return `${lead}${waiting ? logins : ""}${invite}
    ${orgHead("Members", admin ? "Owners manage owners and the encryption key; admins everything else here" : "", members.length)}
    <div${surface("overflow:hidden")} data-members-table>${head}<ul style="list-style:none;margin:0;padding:0">${rows}</ul></div>
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
  if (p.org && effectiveOrgTab(p.ui.tab, p.org.role) === "tags") return []; // its picks are row menus (web/src/tags.ts)
  if (!p.org || !roleAtLeast(p.org.role, "admin")) return [];
  const tab = effectiveOrgTab(p.ui.tab, p.org.role);
  if (tab === "notifications") return p.notif ? notifDropdowns(p.notif) : [];
  if (tab === "hosting") return hostingDropdowns(p.ui.hosting);
  // A repository's Apps: its pickers, and the part editor's host picker when the editor is open over it.
  if (tab === "repos") return p.ui.repoPage ? [...repoAppsDropdowns(p.ui.repoPage, p.ui.apps), ...hostingDropdowns(p.ui.hosting)] : [];
  if (tab !== "members" || !p.ui.members.data.length) return [];
  const d = p.ui.memberEdit;
  const m = d ? p.ui.members.data.find((x) => sameHandle(x.handle, d.handle)) : undefined;
  return [inviteRoleDropdown(p.ui), ...(d && m ? [memberRoleDropdown(m, d, p.org.role)] : [])];
}

// ── confirmation modal ───────────────────────────────────────────────────────

const quote = (s: string) => `“${s}”`;

/** The words of the open confirmation: what is removed, and what stops working. Pure — exported for the tests. */
export function orgConfirmCopy(c: OrgConfirm, org: MyOrg, ui: OrgUi): { title: string; body: string; confirmLabel: string; busyLabel: string; detail?: string } | null {
  const list = ui.integrations.data?.integrations ?? [];
  if (c.what === "app") return appRemoveCopy(ui.apps, c.arg);
  if (c.what === "part" || c.what === "hosting" || c.what === "leftovers") {
    const d = hostingData(ui.hosting);
    return d ? (c.what === "part" ? partConfirmCopy(d, c.arg) : c.what === "leftovers" ? leftoversConfirmCopy(d, c.arg) : disconnectConfirmCopy(d, c.arg, org.name)) : null;
  }
  if (c.what === "repo") {
    const r = ui.repos.data.find((x) => x.id === c.arg);
    if (!r) return null;
    return {
      title: `Remove ${r.repo_full_name}?`,
      body: `${org.name} stops tracking this repository. ${r.webhook_secret_configured ? "Its webhook secret is removed too, so deliveries signed with it are rejected." : "Its webhook secret, if one is set later, is removed with it."} What Trov already recorded from it stays.`,
      confirmLabel: "Remove repository", busyLabel: "Removing…",
    };
  }
  if (c.what === "github") {
    const i = githubOf(ui)?.installation;
    if (!i) return null;
    const n = ui.repos.data.length;
    return {
      title: `Disconnect GitHub from ${org.name}?`,
      body: `Trov stops reading through the installation on ${i.account_login} and ignores the events it sends. The Trov App stays installed on GitHub until you uninstall it there. ${n === 0 ? "No repository is tracked." : `${n === 1 ? "Your repository stays connected: it is read with the GitHub token if one is set, and otherwise stops updating." : `Your ${n} repositories stay connected: they are read with the GitHub token if one is set, and otherwise stop updating.`}`}`,
      confirmLabel: "Disconnect", busyLabel: "Disconnecting…",
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
  if (p.tags?.ui.confirm && roleAtLeast(p.org.role, "admin")) return menu + tagConfirmModal(p.tags.ui.confirm, p.tags.list.data);
  if (p.tags?.ui.addOpen && roleAtLeast(p.org.role, "admin")) return menu + tagAddModal(p.tags.ui, p.tags.list.data);
  if (ui.confirm) {
    const copy = orgConfirmCopy(ui.confirm, p.org, ui);
    if (copy) return menu + confirmModal({ id: "org-confirm", ...copy, confirmAct: "orgConfirmGo", cancelAct: "orgConfirmCancel", busy: ui.confirm.busy });
  }
  if (ui.secretForm && roleAtLeast(p.org.role, "admin")) {
    const f = ui.secretForm;
    const i = ui.integrations.data?.integrations.find((x) => x.kind === f.kind && x.scope === f.scope);
    if (i) return menu + secretFormModal(i, f);
  }
  if (ui.del.open && p.org.role === "owner") return menu + orgDeleteModal(ui.del);
  if (roleAtLeast(p.org.role, "admin") && effectiveOrgTab(ui.tab, p.org.role) === "hosting") return menu + hostingOverlay(ui.hosting, p.dd);
  // A repository's Apps opens #185's part editor (prefilled with the app key) over the page.
  if (roleAtLeast(p.org.role, "admin") && effectiveOrgTab(ui.tab, p.org.role) === "repos" && ui.repoPage) return menu + hostingOverlay(ui.hosting, p.dd);
  return menu;
}

// ── the screen ───────────────────────────────────────────────────────────────

/** The tab bar. Three tabs carry a count of what needs an admin there: integrations with an error,
 *  (Hosting) connections with an error or ended on the provider's side, and (Members) logins
 *  waiting to be matched — `logins` is 0 for anyone who is not an admin. */
export function orgTabBar(tab: OrgTab, role: OrgRole | null, ui: OrgUi, logins = 0): string {
  // An org on the App does not need its token / webhook-secret rows: an old error on one is not a to-do.
  const inst = githubOf(ui)?.installation ?? null;
  const manual = (i: IntegrationDTO): boolean => i.kind === "github_token" || i.kind === "github_webhook";
  // Hosting credentials and app metrics tokens live on Hosting now: their errors are its badge's (`hostingTodo`).
  const todo = (ui.integrations.data ? ui.integrations.data.integrations.filter((i) => onIntegrationsTab(i) && i.expected && i.last_error !== null && !(inst && manual(i))).length : 0)
    + (inst && (inst.suspended_at || inst.last_error) ? 1 : 0);
  const badge = (n: number, title: string) => `<span class="cnpy-badge" data-n="${n}" title="${attr(title)}">${n}</span>`;
  return tabBar({
    id: "org-tab", ariaLabel: "Org settings sections", act: "orgTab", value: tab,
    tabs: orgTabsFor(role).map((t) => ({
      value: t, label: TAB_LABEL[t],
      trail: t === "integrations" ? badge(todo, `${todo} with an error`)
        : t === "hosting" ? ((n) => badge(n, `${n} ${n === 1 ? "connection needs" : "connections need"} attention`))(hostingTodo(ui.hosting))
        : t === "members" ? badge(logins, `${logins} ${logins === 1 ? "login" : "logins"} to match`) : "",
    })),
  });
}

/** Org settings, whole: the setup checklist (admins, until done), the tab bar, the tab — each tab
 *  opening with its lead line (org-ui.ts `tabLead`), never an intro paragraph. */
export function orgSettingsView(p: OrgSettingsProps): string {
  // Members (a table) grows on a big screen with --frame-dash (1180px up to a ~2100px window, like every other tab);
  // `data-org-wide` lets the header line up with it (trov.css › Big screens).
  const shell = (inner: string, wide = false) => `<div data-screen-label="Org settings" class="cnpy-org"${wide ? " data-org-wide" : ""} style="width:100%;max-width:${wide ? "var(--frame-dash)" : "1180px"};margin:0 auto;padding:18px clamp(20px,2.6 * var(--vw),46px) 100px;box-sizing:border-box">${inner}</div>`;
  if (!p.org) {
    if (p.orgsStatus === "error") return shell(failedNote("your orgs"));
    if (p.orgsStatus === "ok") return shell(orgEmpty("This organization isn't open", "Pick an organization from the switcher at the top of the sidebar."));
    return shell(loadingNote("your org", { form: true }));
  }
  const tab = effectiveOrgTab(p.ui.tab, p.org.role);
  const body = tab === "integrations" ? integrationsTab(p.org, p.ui)
    : tab === "repos" ? (p.ui.repoPage && roleAtLeast(p.org.role, "admin") ? repoAppsPage(p.ui.repoPage, p.ui.apps, p.dd, (env, key) => hostingPartRow(p.org as MyOrg, p.ui, env, key)) : reposTab(p.org, p.ui))
    : tab === "environments" ? environmentsTab(p.org, p.ui)
    : tab === "hosting" ? hostingTab(p.org, p.ui, p.dd)
    : tab === "members" ? membersTab(p.org, p.ui, p.me, p.identity ?? null, p.dd)
    : tab === "tags" ? tagsTab(p.org, { list: p.tags?.list ?? { status: "loading", data: null }, ui: p.tags?.ui ?? initialTagsUi(), dd: p.dd })
    : tab === "notifications" ? notificationsTab(p.org, p.notif, p.dd)
    : tab === "ai" ? aiTab(p.org, p.ui.ai, p.ui.aiSaving)
    : generalTab(p.org, p.ui);
  const logins = roleAtLeast(p.org.role, "admin") ? p.identity?.groups.length ?? 0 : 0;
  // The checklist's slot is always there (empty once setup is done), so the tab bar under it is
  // the same child of the page on every paint — the page is patched in place (morph.ts).
  return shell(`<div data-setup-slot>${setupChecklist(p.org, p.ui)}</div>
    ${orgTabBar(tab, p.org.role, p.ui, logins)}
    <div${tabPanelAttrs("org-tab", tab)} style="padding-top:18px">${body}</div>`, tab === "members");
}
