// The GitHub App in Org settings (docs/architecture/github-app.md) — what Repositories and
// Integrations show about an org's installation: the sentence after a return from GitHub, the
// "Connect with GitHub" link, the installation's one row, and the repositories it can see.
//
// Pure: props in, markup out, in the page's one idiom (org-ui.ts — lead, eyebrow sections, rows
// that open, one accent action per view, destructive actions as quiet text). Connecting is a
// NAVIGATION, not a request: the accent action is a real link to the org's own start route, which
// answers with a redirect to GitHub. Acts are dispatched in main.ts to org-actions.ts.

import { esc, attr, relTime, surface } from "./ui";
import { O_FIELD, O_HELP, chip, dangerLink, failedNote, leadFlag, loadingNote, openRow, orgBanner, orgHead, quietBtn, type OrgSlice } from "./org-ui";
import { githubInstallHref } from "./api";
import type { GithubAppStatusDTO, GithubConnectOutcome, GithubInstallationDTO, GithubRepoOptionDTO, GithubReposDTO } from "@shared/github-app";
import type { TestState } from "./integrations";

/** What came back from GitHub (`?github=<outcome>` on the page the callback redirects to). */
export interface GithubNotice { outcome: GithubConnectOutcome; accounts: string[]; /** `partial_access`: how many repositories the account cannot read. */ missing?: number }

const LIST = "overflow:hidden;list-style:none;margin:0;padding:0";
const EXT = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none"><path d="M14 4h6v6"></path><path d="M20 4 10 14"></path><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"></path></svg>`;
const LINK_BTN = "display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 13px;border-radius:8px;font-size:12.5px;white-space:nowrap;text-decoration:none;box-sizing:border-box";

/** The accent action as a link: it LEAVES for GitHub (the start route redirects there). */
export function connectLink(slug: string, text = "Connect with GitHub", field = "orgGithubConnect"): string {
  return `<a href="${attr(githubInstallHref(slug))}" data-field="${attr(field)}" data-org-github-connect class="cnpy-accentbtn" style="${LINK_BTN};font-weight:600;background:var(--accent);color:var(--accent-fg);border:1px solid transparent">${esc(text)}</a>`;
}
/** A quiet link out to GitHub (the installation's own settings page), in a new tab. */
export function githubLink(text: string, href: string, label?: string): string {
  return `<a href="${attr(href)}" target="_blank" rel="noopener"${label ? ` aria-label="${attr(label)}"` : ""} class="cnpy-ghostbtn" style="${LINK_BTN};font-weight:500;border:1px solid var(--border);color:var(--fg-70)">${esc(text)}${EXT}</a>`;
}
/** Link an installation that already exists (the App was installed from GitHub's side, or Trov was
 *  disconnected and the App left in place): an authorization, then GitHub's own list. */
export function existingLink(slug: string, text: string, account?: string): string {
  return `<a href="${attr(githubInstallHref(slug, { existing: true, account }))}" class="cnpy-mutelink cnpy-org-link" style="font-size:12.5px;font-weight:500;color:var(--fg-55);text-decoration:underline;text-underline-offset:3px">${esc(text)}</a>`;
}

// ── the sentence after a return from GitHub ──────────────────────────────────

export interface NoticeCopy { tone: "ok" | "amber" | "red"; title: string; body: string }

/** Each outcome of `/auth/callback` as words: what happened, and what to do next. Pure. */
export function connectNoticeCopy(n: GithubNotice, orgName: string): NoticeCopy {
  const org = esc(orgName);
  switch (n.outcome) {
    case "connected": return { tone: "ok", title: "GitHub is connected.", body: `The Trov App on GitHub now answers for ${org}: no token to paste, no webhook to add.` };
    case "requested": return { tone: "amber", title: "Waiting for approval on GitHub.", body: `An owner of that GitHub organization has to approve the Trov App before it can be installed. Nothing is connected to ${org} yet. Once it is approved, come back here and choose Connect with GitHub.` };
    case "unlinked": return { tone: "amber", title: "The Trov App changed on GitHub, but nothing is connected here.", body: `An installation is only connected to ${org} when an admin starts from this page. Choose Connect with GitHub, or link the installation that already exists.` };
    case "expired": return { tone: "amber", title: "That took too long, or was not started here.", body: "Trov could not match the return from GitHub to a request from this browser, so nothing was connected. Start again from this page. If the App is already installed, link the existing installation." };
    case "wrong_person": return { tone: "red", title: "Nothing was connected.", body: "The person signed in to Trov when GitHub returned is not the one who started. Start again from this page." };
    case "not_admin": return { tone: "red", title: "Nothing was connected.", body: `Only an admin or an owner of ${org} can connect GitHub.` };
    case "wrong_account": return { tone: "red", title: "Nothing was connected.", body: "The GitHub account that approved this is not the one linked to your Trov account. Sign in to GitHub as your own account, or link it in Settings, then try again." };
    case "not_yours": return { tone: "red", title: "Nothing was connected.", body: "GitHub does not list that installation among the ones your account can reach." };
    case "partial_access": return { tone: "red", title: "Nothing was connected.", body: `Your GitHub account cannot read ${n.missing ? `${n.missing} of the ${n.missing === 1 ? "repository" : "repositories"}` : "every repository"} that installation covers. Ask an owner of the GitHub account to connect it, or limit the App to repositories you can read.` };
    case "too_many_repos": return { tone: "red", title: "Nothing was connected.", body: "That installation covers more than 1,000 repositories, which is more than Trov checks before connecting one. On GitHub, open the Trov App's settings for that account, choose Only select repositories, pick the ones Trov should read, then connect again." };
    case "taken": return { tone: "red", title: "Nothing was connected.", body: "That installation is already connected to another Trov organization. It can belong to one at a time: disconnect it there first." };
    case "already_connected": return { tone: "red", title: "Nothing was connected.", body: `${org} is already connected to another GitHub account. Disconnect that one first: an organization connects one account at a time.` };
    case "suspended": return { tone: "amber", title: "Nothing was connected.", body: "That installation is suspended on GitHub. Unsuspend it there, then connect again." };
    case "none_found": return { tone: "amber", title: "No installation found.", body: "Your GitHub account cannot reach any installation of the Trov App. Choose Connect with GitHub to install it." };
    case "choose": return { tone: "amber", title: "Which GitHub account?", body: "Your GitHub account can reach more than one installation of the Trov App. Choose the one to connect." };
    case "not_configured": return { tone: "amber", title: "The GitHub App is not set up on this Trov.", body: "Whoever runs this Trov has not configured it, or GitHub refused its credentials. You can still connect a repository by name with a token." };
    case "github_failed": return { tone: "red", title: "GitHub did not answer.", body: "Nothing was connected. Try again in a minute." };
  }
}

const NOTICE_ICON: Record<NoticeCopy["tone"], string> = {
  ok: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:2px"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12.5 2.5 2.5 4.5-5"></path></svg>`,
  amber: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:2px"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>`,
  red: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" style="flex:none;margin-top:2px"><path d="M12 8v5"></path><path d="M12 16.5h.01"></path><circle cx="12" cy="12" r="9"></circle></svg>`,
};
const TONE_VAR: Record<NoticeCopy["tone"], string> = { ok: "var(--green)", amber: "var(--amber)", red: "var(--red)" };

/** The notice across the Repositories tab, dismissible. Several installations to choose from are
 *  offered as links, each of which runs the authorization again for that account. */
export function connectNotice(n: GithubNotice | null, slug: string, orgName: string): string {
  if (!n) return "";
  const c = connectNoticeCopy(n, orgName);
  const tone = TONE_VAR[c.tone];
  const choices = n.outcome === "choose" && n.accounts.length
    ? `<div style="display:flex;gap:6px 14px;flex-wrap:wrap;margin-top:8px">${n.accounts.map((a) => existingLink(slug, a, a)).join("")}</div>` : "";
  const again = n.outcome === "expired" || n.outcome === "unlinked"
    ? `<div style="margin-top:8px">${existingLink(slug, "Link the existing installation")}</div>` : "";
  return `<div role="${c.tone === "red" ? "alert" : "status"}" data-org-github-notice="${attr(n.outcome)}" style="border:1px solid color-mix(in srgb,${tone} 45%,transparent);background:color-mix(in srgb,${tone} 9%,transparent);border-radius:10px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start;margin:0 0 20px">
    ${NOTICE_ICON[c.tone]}
    <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600;color:var(--fg)">${esc(c.title)}</div><div style="font-size:12.5px;line-height:1.55;color:var(--fg-70);margin-top:2px">${c.body}</div>${choices}${again}</div>
    <button type="button" data-act="orgGithubNoticeClose" data-field="orgGithubNoticeClose" aria-label="Dismiss" title="Dismiss" class="cnpy-iconbtn" style="flex:none;width:26px;height:26px;display:grid;place-items:center;border-radius:7px;color:var(--fg-40)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg></button>
  </div>`;
}

/** The binding ended from GitHub's side and nothing replaced it — said until it is reconnected. */
export function lostBanner(status: GithubAppStatusDTO | null, admin: boolean): string {
  const lost = status?.lost;
  if (!lost || status?.installation) return "";
  const why = lost.reason === "uninstalled" ? `The Trov App was uninstalled from <strong style="font-weight:600">${esc(lost.account_login)}</strong> on GitHub ${esc(relTime(lost.at))}.`
    : `GitHub no longer has the Trov App installed on <strong style="font-weight:600">${esc(lost.account_login)}</strong> (noticed ${esc(relTime(lost.at))}).`;
  return `<div style="margin-bottom:20px" data-org-github-lost>${orgBanner("GitHub is no longer connected", `${why} The repositories below stay connected, and are read with the GitHub token if one is set.${admin ? " Connect again to go back to the App." : ""}`)}</div>`;
}

/** A suspended installation: nothing is read through it until GitHub lifts it. */
export function suspendedBanner(i: GithubInstallationDTO | null): string {
  if (!i?.suspended_at) return "";
  return `<div style="margin-bottom:20px" data-org-github-suspended>${orgBanner("The GitHub App is suspended", `The installation on <strong style="font-weight:600">${esc(i.account_login)}</strong> was suspended on GitHub ${esc(relTime(i.suspended_at))}, so Trov cannot read through it. Unsuspend it on GitHub, then choose Test connection.`)}</div>`;
}

// ── the installation's one row ───────────────────────────────────────────────

export function installationStatus(i: GithubInstallationDTO): { word: string; tone: string } {
  if (i.suspended_at) return { word: "Suspended", tone: "var(--amber)" };
  if (i.last_error) return { word: "Error", tone: "var(--red)" };
  return { word: "Connected", tone: "var(--green)" };
}

const OK_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:2px"><path d="M20 6 9 17l-5-5"></path></svg>`;
const FAIL_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" style="flex:none;margin-top:2px"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;
const box = (tone: string) => `border:1px solid color-mix(in srgb,${tone} 40%,transparent);background:color-mix(in srgb,${tone} 7%,transparent);border-radius:8px;padding:9px 11px;display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.5;color:var(--fg-70)`;

export interface AppRowOpts { open: boolean; admin: boolean; tracked: number; test?: TestState; busy?: boolean }

/**
 * "GitHub App · installed on <account> · N repositories · connected by @x" — the ONE row an org on
 * the App has for GitHub. Its always-visible action is Test connection (a real read through an
 * installation token); behind it: what the App is, Manage on GitHub, and Disconnect as quiet text.
 */
export function githubAppRow(i: GithubInstallationDTO, o: AppRowOpts): string {
  const st = installationStatus(i);
  const running = o.test?.status === "running";
  const answer = o.test && o.test.status === "done"
    ? `<div role="status" aria-live="polite" data-org-test="${o.test.ok ? "ok" : "failed"}" style="${box(o.test.ok ? "var(--green)" : "var(--red)")};margin-top:10px">${o.test.ok ? OK_ICON : FAIL_ICON}<div style="min-width:0;overflow-wrap:anywhere"><strong style="font-weight:600;color:var(--fg)">${o.test.ok ? "Connection works." : "Test failed."}</strong> ${esc(o.test.detail)}</div></div>` : "";
  // A suspension is said by the chip and the tab's banner; its token error would only repeat it.
  const error = i.last_error && !i.suspended_at
    ? `<div data-org-lasterror style="${box("var(--red)")}">${FAIL_ICON}<div style="min-width:0;overflow-wrap:anywhere"><strong style="font-weight:600;color:var(--fg)">Last error.</strong> ${esc(i.last_error)}</div></div>` : "";
  const scope = i.repository_selection === "all" ? `every repository of ${i.account_login}` : `the repositories selected for it on ${i.account_login}`;
  const actions = o.admin ? `<div class="cnpy-xrow-acts">
      ${i.manage_url ? githubLink("Manage on GitHub", i.manage_url, `Manage the Trov App on ${i.account_login}, on GitHub`) : ""}
      ${dangerLink("Disconnect", "orgConfirm", { arg: "github:", disabled: o.busy, label: `Disconnect the GitHub App on ${i.account_login}`, field: "orgConfirm:github:" })}
    </div>` : "";
  return openRow({
    key: "github-app", open: o.open, act: "orgRowToggle", label: `GitHub App on ${i.account_login}, ${st.word.toLowerCase()}`,
    head: `<span>GitHub App <span style="font-weight:500;color:var(--fg-55)">&middot; ${esc(i.account_login)}</span></span>${chip(st.word, st.tone)}`,
    meta: `${o.tracked === 0 ? "No repository tracked yet" : `${o.tracked} ${o.tracked === 1 ? "repository" : "repositories"}`} &middot; connected by ${esc(i.connected_by)}`,
    action: o.admin ? quietBtn(running ? "Testing…" : "Test connection", "orgGithubTest", { disabled: running, busy: running, label: "Test the GitHub App connection", field: "orgGithubTest" }) : "",
    always: error || answer ? `${error}${answer}` : "",
    body: `<div style="max-width:680px">The Trov App is installed on the GitHub ${i.account_type === "Organization" ? "organization" : "account"} <strong style="font-weight:600;color:var(--fg)">${esc(i.account_login)}</strong> and can read ${esc(scope)}. Trov reads through it with tokens GitHub issues for an hour at a time, and GitHub delivers events to Trov itself: no token to paste, no webhook to add.</div>
      <div style="font-size:12px;color:var(--fg-40);margin-top:6px">Connected by ${esc(i.connected_by)} ${esc(relTime(i.connected_at))} &middot; ${i.last_used_at ? `last used ${esc(relTime(i.last_used_at))}` : "not used yet"}</div>
      <div style="font-size:12px;color:var(--fg-40);margin-top:6px">Events are captured for the primary repository. Other tracked repositories are listed, and resolve links, but are not captured yet.</div>
      ${actions}`,
    attrs: ` data-org-github-app="${st.word.toLowerCase()}"`,
  });
}

// ── the repositories the installation can see ────────────────────────────────

export interface PickerOpts { filter: string; busy: string | null }
/** Above this many, the list gets a filter. */
export const PICKER_FILTER_FROM = 9;

/** The installation's repositories that are not tracked yet: a name and ONE quiet action each. */
export function repoPicker(slice: OrgSlice<GithubReposDTO | null>, account: string, o: PickerOpts): string {
  const head = (n: number | null, hint = "") => orgHead(`On ${account}`, hint, n, "org-gh-avail");
  if (!slice.data) {
    if (slice.status === "error") return `${head(null)}${failedNote("the repositories on GitHub", "orgGithubReposReload")}`;
    return `${head(null)}${loadingNote("the repositories the App can see")}`;
  }
  const all = slice.data.repositories.filter((r) => !r.tracked);
  const q = o.filter.trim().toLowerCase();
  const shown = q ? all.filter((r) => r.full_name.toLowerCase().includes(q)) : all;
  const filter = all.length >= PICKER_FILTER_FROM
    ? `<input id="org-gh-filter" data-act="orgGithubFilter" data-field="orgGithubFilter" value="${attr(o.filter)}" placeholder="Filter repositories" aria-label="Filter the repositories on ${attr(account)}" autocomplete="off" autocapitalize="off" spellcheck="false" class="cnpy-input" style="${O_FIELD};height:32px;max-width:320px;font-size:13px;margin-bottom:10px" />` : "";
  const refresh = `<button type="button" data-act="orgGithubReposReload" data-field="orgGithubReposReload" class="cnpy-mutelink" style="padding:0;font-size:11.5px;font-weight:500;color:var(--fg-55)" title="Ask GitHub again">Refresh</button>`;
  if (all.length === 0) {
    return `<section aria-labelledby="org-gh-avail" data-org-github-picker="empty">${head(0, refresh)}
      <div style="${O_HELP};margin-top:0">Every repository the App can see is tracked. To add more, give the App access to them on GitHub (Manage on GitHub), then refresh.</div></section>`;
  }
  const row = (r: GithubRepoOptionDTO): string => {
    const busy = o.busy === r.full_name;
    return `<li class="cnpy-org-row" style="align-items:center;padding-top:9px;padding-bottom:9px" data-org-github-repo="${attr(r.full_name)}">
      <div style="flex:1 1 200px;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-size:13.5px;font-weight:500;overflow-wrap:anywhere">${esc(r.full_name)}</span>${r.private ? chip("Private", "var(--fg-55)") : ""}</div>
      <div class="cnpy-org-actions is-inline" style="align-items:center">${quietBtn(busy ? "Adding…" : "Track", "orgGithubTrack", { arg: r.full_name, disabled: o.busy !== null, busy, label: `Track ${r.full_name}`, field: `orgGithubTrack:${r.full_name}` })}</div>
    </li>`;
  };
  const cut = slice.data.truncated ? `<div style="${O_HELP}">Showing the first ${slice.data.repositories.length} of ${slice.data.total}. To track one that is not listed, add it by name below.</div>` : "";
  return `<section aria-labelledby="org-gh-avail" data-org-github-picker>
    ${head(all.length, refresh)}
    ${filter}
    ${shown.length ? `<ul${surface(LIST)}>${shown.map(row).join("")}</ul>` : `<div style="${O_HELP};margin-top:0">No repository matches “${esc(o.filter.trim())}”.</div>`}
    ${cut}
  </section>`;
}

/** Integrations' and the lead's short phrase for an org on the App. */
export const appLeadPhrase = (i: GithubInstallationDTO): string =>
  i.suspended_at ? leadFlag(`GitHub App on ${i.account_login} is suspended`, "amber")
    : `through the GitHub App on <strong>${esc(i.account_login)}</strong>`;

/** The one line said where the App cannot be offered at all. */
export const NOT_CONFIGURED_LINE = "The GitHub App is not configured on this Trov, so a repository is connected by name and read with a GitHub token.";
