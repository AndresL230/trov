// Org settings › Repositories — the GitHub App panel (issue #95,
// docs/superpowers/specs/2026-10-06-github-app-design.md §10). Shown to an admin, above the
// repository list, only when the platform has registered the App (`configured`); otherwise the tab
// is exactly what it was — a pasted token and a webhook per repository.
//
//   no installation — ONE accent "Install on GitHub" (the tab's only accent: the add bar's button
//                     goes quiet while this one is shown). It asks the Worker for GitHub's install
//                     URL and leaves the page; GitHub sends the browser back to
//                     `#org/repos?github=connected|requested` (`githubInstallNotice`).
//   installations   — per installation: the account, how many repositories it covers, a
//                     suspended badge, the last delivery, Refresh / Manage on GitHub / Disconnect,
//                     and its repositories, each with Connect, Make primary, or a Connected /
//                     Primary chip. "Install on another account" is the section head's quiet aside.
//
// Pure: props in, markup out. Its own acts start with `orgGithub` (org-actions.ts runs them); Make
// primary, Disconnect and Show all reuse the page's `orgRepoPrimary`, `orgConfirm` (`github:<id>`) and
// `orgRowToggle`. The list is read from D1 by the Worker, never from GitHub at render. Nothing here
// carries a credential, and a link out goes only to https://github.com/.

import { esc, attr, relTime, surface } from "./ui";
import { quietBtn, accentBtn, dangerLink, orgHead, failedNote, chip, roleAtLeast } from "./org-ui";
import { GITHUB_INSTALL_OUTCOMES, type GithubAppStateDTO, type GithubInstallationDTO, type GithubInstallationRepoDTO, type GithubInstallOutcome } from "@shared/github-app";
import type { MyOrg } from "@shared/orgs";
import type { OrgUi } from "./org-settings";

// ── the install landing ──────────────────────────────────────────────────────

/** The toast each landing outcome flashes (the callback's refusals are server pages, never here). */
export const GITHUB_NOTICE: Record<GithubInstallOutcome, { text: string; ms: number }> = {
  connected: { text: "GitHub App connected", ms: 4000 },
  requested: { text: "Install requested — an owner of the GitHub account must approve it", ms: 7000 },
};

/** The notice the install callback's landing carries (`#org/repos?github=connected`), or null: pass
 *  the hash's query (hash.ts `splitHashQuery(hash).query` — taken there, so this module needs no
 *  import of the router). Pure: main.ts flashes it once and writes the hash back without its query,
 *  so a reload is quiet. */
export function githubInstallNotice(query: URLSearchParams): (typeof GITHUB_NOTICE)[GithubInstallOutcome] & { outcome: GithubInstallOutcome } | null {
  const v = query.get("github");
  const outcome = (GITHUB_INSTALL_OUTCOMES as readonly string[]).includes(v ?? "") ? (v as GithubInstallOutcome) : null;
  return outcome ? { outcome, ...GITHUB_NOTICE[outcome] } : null;
}

// ── vocabulary ───────────────────────────────────────────────────────────────

/** The App state, once read and only when the App is registered — else null (the tab is unchanged). */
export function githubApp(ui: Pick<OrgUi, "github">): GithubAppStateDTO | null {
  return ui.github.status === "ok" && ui.github.data?.configured ? ui.github.data : null;
}

/** "All repositories" / "3 selected repositories". */
export function selectionText(i: Pick<GithubInstallationDTO, "repository_selection" | "repos">): string {
  if (i.repository_selection === "all") return "All repositories";
  const n = i.repos.length;
  return `${n} selected ${n === 1 ? "repository" : "repositories"}`;
}

/** "Last delivery 5m ago" / "No deliveries yet". */
export const deliveryText = (i: Pick<GithubInstallationDTO, "last_delivery_at">): string =>
  i.last_delivery_at ? `Last delivery ${relTime(i.last_delivery_at)}` : "No deliveries yet";

const ACCOUNT_WORD: Record<GithubInstallationDTO["account_type"], string> = { Organization: "Organization", User: "Personal account" };

/** An installation's repositories in the order the panel lists them: the primary, then the connected
 *  ones, then the rest — each group by name. */
export function orderedRepos(repos: readonly GithubInstallationRepoDTO[]): GithubInstallationRepoDTO[] {
  const rank = (r: GithubInstallationRepoDTO) => (r.is_primary ? 0 : r.org_repo_id ? 1 : 2);
  return [...repos].sort((a, b) => rank(a) - rank(b) || a.full_name.toLowerCase().localeCompare(b.full_name.toLowerCase()));
}
/** How many repositories an installation lists before "Show all". */
export const GH_REPO_SHORT = 8;
/** The `openRows` key that shows an installation's whole list. */
export const ghAllKey = (id: number): string => `ghrepos:${id}`;

/** The one place a "Manage on GitHub" link may point: GitHub itself (the Worker builds it). */
const safeGithubUrl = (u: string | null | undefined): string | null => (u && /^https:\/\/github\.com\//.test(u) ? u : null);

// ── markup ───────────────────────────────────────────────────────────────────

const EXT = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"></path><path d="M20 4 10 14"></path><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"></path></svg>`;
/** A link out to GitHub, at a quiet button's weight; it opens a new tab. */
function ghLink(text: string, href: string, label: string): string {
  return `<a href="${attr(href)}" target="_blank" rel="noopener noreferrer" aria-label="${attr(`${label} (opens GitHub in a new tab)`)}" class="cnpy-ghostbtn cnpy-org-ghlink" style="height:32px;padding:0 13px;border-radius:8px;font-size:12.5px;font-weight:500;white-space:nowrap;border:1px solid var(--border);color:var(--fg-70);background:transparent;display:inline-flex;align-items:center;gap:6px;text-decoration:none">${esc(text)}${EXT}</a>`;
}
const PRIVATE = `<span title="A private repository on GitHub" style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.05em;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:1px 6px;flex:none">private</span>`;

function repoRow(r: GithubInstallationRepoDTO, ui: OrgUi): string {
  const busy = ui.repoBusy;
  const mine = ui.repoPending === r.full_name;
  const action = r.is_primary ? chip("Primary", "var(--accent)")
    : r.org_repo_id ? `${chip("Connected", "var(--green)")}${quietBtn(mine ? "Saving…" : "Make primary", "orgRepoPrimary", { arg: r.full_name, disabled: busy, busy: mine, label: `Make ${r.full_name} the primary repository`, field: `orgGithubPrimary:${r.full_name}` })}`
    : quietBtn(mine ? "Connecting…" : "Connect", "orgGithubConnect", { arg: r.full_name, disabled: busy, busy: mine, label: `Connect ${r.full_name}`, field: `orgGithubConnect:${r.full_name}` });
  return `<li class="cnpy-org-row" data-gh-repo="${attr(r.full_name)}" data-state="${r.is_primary ? "primary" : r.org_repo_id ? "connected" : "available"}" style="align-items:center;padding-top:9px;padding-bottom:9px;padding-left:38px">
    <div style="flex:1 1 220px;min-width:0;display:flex;align-items:center;gap:6px 9px;flex-wrap:wrap">
      <span style="font-size:13px;font-weight:500;overflow-wrap:anywhere">${esc(r.full_name)}</span>${r.private ? PRIVATE : ""}
    </div>
    <div class="cnpy-org-actions is-inline" style="align-items:center">${action}</div>
  </li>`;
}

function installationBlock(i: GithubInstallationDTO, ui: OrgUi): string {
  const id = i.installation_id;
  const refreshing = ui.githubBusy === `refresh:${id}`;
  const all = ui.openRows.includes(ghAllKey(id));
  const repos = orderedRepos(i.repos);
  const shown = all || repos.length <= GH_REPO_SHORT ? repos : repos.slice(0, GH_REPO_SHORT);
  const manage = safeGithubUrl(i.manage_url);
  const facts = [
    selectionText(i),
    deliveryText(i),
    `Connected by ${i.connected_by}${i.connected_at ? ` ${relTime(i.connected_at)}` : ""}`,
  ].map((f) => `<span>${esc(f)}</span>`).join("");
  const suspended = i.suspended_at
    ? `<div data-gh-suspended style="font-size:12px;line-height:1.5;color:var(--fg-70);margin-top:6px">Suspended on GitHub ${esc(relTime(i.suspended_at))}. Trov reads these repositories with the GitHub token, if one is set, until an owner of ${esc(i.account_login)} unsuspends it.</div>` : "";
  const list = repos.length === 0
    ? `<div style="padding:4px 16px 14px 38px;font-size:12.5px;color:var(--fg-55)">No repository is selected for Trov. Choose some on GitHub, then Refresh.</div>`
    : `<ul aria-label="${attr(`Repositories ${i.account_login} gives Trov`)}" style="list-style:none;margin:0;padding:0">${shown.map((r) => repoRow(r, ui)).join("")}</ul>
      ${repos.length > GH_REPO_SHORT ? `<div style="padding:4px 16px 12px 38px"><button type="button" data-act="orgRowToggle" data-arg="${attr(ghAllKey(id))}" data-field="${attr(`row:${ghAllKey(id)}`)}" aria-expanded="${all}" class="cnpy-mutelink" style="padding:4px 0;font-size:12.5px;font-weight:500;color:var(--fg-55)">${all ? "Show fewer" : `Show all ${repos.length}`}</button></div>` : ""}`;
  return `<li data-gh-installation="${id}" style="border-bottom:1px solid var(--border);margin-bottom:-1px">
    <div class="cnpy-org-row" style="border-bottom:0;margin-bottom:0;align-items:center">
      <div style="flex:1 1 260px;min-width:0">
        <div style="display:flex;align-items:center;gap:6px 9px;flex-wrap:wrap">
          <span style="font-size:13.5px;font-weight:600;overflow-wrap:anywhere">${esc(i.account_login)}</span>
          ${chip(ACCOUNT_WORD[i.account_type] ?? i.account_type, "var(--fg-55)")}
          ${i.suspended_at ? chip("Suspended", "var(--amber)") : ""}
        </div>
        <div style="display:flex;gap:2px 14px;flex-wrap:wrap;margin-top:2px;font-size:12px;color:var(--fg-40)">${facts}</div>
        ${suspended}
      </div>
      <div class="cnpy-org-actions" style="align-items:center">
        ${quietBtn(refreshing ? "Refreshing…" : "Refresh", "orgGithubRefresh", { arg: String(id), disabled: ui.githubBusy !== null, busy: refreshing, label: `Refresh the repositories of ${i.account_login}`, field: `orgGithubRefresh:${id}` })}
        ${manage ? ghLink("Manage on GitHub", manage, `Manage ${i.account_login}'s installation on GitHub`) : ""}
        ${dangerLink("Disconnect", "orgConfirm", { arg: `github:${id}`, label: `Disconnect ${i.account_login}`, field: `orgConfirm:github:${id}` })}
      </div>
    </div>
    ${list}
  </li>`;
}

/** The panel, or "" — for a member, or while the App is not registered (or not read yet). */
export function githubPanel(org: MyOrg, ui: OrgUi): string {
  if (!roleAtLeast(org.role, "admin")) return "";
  if (ui.github.status === "error" && !ui.github.data) {
    return `<section data-org-github="failed">${orgHead("GitHub App", "", null)}${failedNote("the GitHub App", "orgGithubLoad")}</section>`;
  }
  const app = githubApp(ui);
  if (!app) return "";
  const opening = ui.githubBusy === "install";
  const appUrl = safeGithubUrl(app.app_url);
  const appName = appUrl ? `<a href="${attr(appUrl)}" target="_blank" rel="noopener noreferrer" class="cnpy-org-ghlink" style="color:var(--fg);font-weight:600;text-decoration:underline;text-decoration-color:var(--border-strong);text-underline-offset:2px">the Trov GitHub App</a>` : "the Trov GitHub App";
  if (app.installations.length === 0) {
    return `<section aria-labelledby="org-gh-t" data-org-github="none">
      ${orgHead("GitHub App", "", null, "org-gh-t")}
      <div${surface("padding:16px 18px")}>
        <div class="cnpy-org-row" style="padding:0;border-bottom:0;margin-bottom:0;align-items:center">
          <p style="flex:1 1 320px;min-width:0;margin:0;font-size:12.5px;line-height:1.55;color:var(--fg-55)">Install ${appName} on the account that owns your repositories, then connect them here. Trov reads them with short-lived, read-only tokens: no token to paste, no webhook to set up.</p>
          <div class="cnpy-org-actions" style="align-items:center">${accentBtn(opening ? "Opening GitHub…" : "Install on GitHub", "orgGithubInstall", { disabled: opening, busy: opening, field: "orgGithubInstall" })}</div>
        </div>
      </div>
    </section>`;
  }
  const another = `<button type="button" data-act="orgGithubInstall" data-field="orgGithubInstallMore"${opening ? ' disabled aria-busy="true"' : ""} class="cnpy-mutelink cnpy-org-link" style="padding:0;font-size:12px;font-weight:500;color:var(--fg-55);text-align:right">${opening ? "Opening GitHub…" : "Install on another account"}</button>`;
  return `<section aria-labelledby="org-gh-t" data-org-github="installed">
    ${orgHead("GitHub App", another, app.installations.length, "org-gh-t")}
    <ul${surface("overflow:hidden;list-style:none;margin:0;padding:0")}>${app.installations.map((i) => installationBlock(i, ui)).join("")}</ul>
  </section>`;
}

/** The Disconnect confirmation's words, or null when the installation is gone from state. */
export function githubConfirmCopy(arg: string, ui: Pick<OrgUi, "github">): { title: string; body: string; confirmLabel: string; busyLabel: string } | null {
  const i = ui.github.data?.installations.find((x) => String(x.installation_id) === arg);
  if (!i) return null;
  const n = i.repos.filter((r) => r.org_repo_id).length;
  const stays = n === 0 ? "None of its repositories is connected."
    : `${n === 1 ? "Its connected repository stays" : `Its ${n} connected repositories stay`}, read with a GitHub token and webhook ${n === 1 ? "secret" : "secrets"} you set in Integrations.`;
  return {
    title: `Disconnect ${i.account_login}?`,
    body: `Trov forgets this installation. ${stays} The App stays installed on GitHub: uninstall it there too.`,
    confirmLabel: "Disconnect", busyLabel: "Disconnecting…",
  };
}
