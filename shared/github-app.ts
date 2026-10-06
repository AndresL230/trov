// The wire shapes of the GitHub App (issue #95; docs/superpowers/specs/2026-10-06-github-app-design.md):
// Org settings › Repositories' "GitHub App" panel and its routes under `/api/o/:slug/github` (src/github-app/).
// Zod-free and value-light, so the SPA may import it. Nothing here ever carries a credential: the App's private
// key, its webhook secret, its client secret, an installation token and a person's GitHub user token never
// leave the Worker.

/** How a repository is connected: by the GitHub App (an installation token + the App webhook), or the
 *  0037 way (a pasted `github_token` + its own `/webhook/github/:hookId` secret). */
export type RepoConnection = "app" | "token";

/** One repository an installation can see (`github_installation_repos`), and whether the org has connected it. */
export interface GithubInstallationRepoDTO {
  repo_id: number;                    // GitHub's repository id
  full_name: string;                  // 'owner/repo'
  private: boolean;
  /** The `org_repos.id` when this repo is connected to the org, else null. */
  org_repo_id: string | null;
  is_primary: boolean;
}

/** One installation bound to the org (`github_installations`). */
export interface GithubInstallationDTO {
  installation_id: number;
  account_login: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
  suspended_at: string | null;
  connected_by: string;               // a handle
  connected_at: string;
  last_delivery_at: string | null;
  repos_synced_at: string | null;
  /** Where an admin changes which repositories the installation covers, on GitHub. */
  manage_url: string;
  repos: GithubInstallationRepoDTO[];
}

/** `GET /api/o/:slug/github` (admin). */
export interface GithubAppStateDTO {
  /** false: the platform has not registered the App (its secrets are absent) — the page keeps the token +
   *  webhook path and shows no Install button. */
  configured: boolean;
  /** The App's public page, `https://github.com/apps/<slug>`; null when not configured. */
  app_url: string | null;
  installations: GithubInstallationDTO[];
  /** true when the org's PRIMARY repository is connected through the App — the org is "on the App", and the
   *  GitHub token / webhook-secret rows leave Org settings › Integrations (unless one is still stored). */
  primary_on_app: boolean;
}

/** `POST /api/o/:slug/github/install` (admin) → where the browser goes next. */
export interface GithubInstallStartDTO {
  url: string;                        // https://github.com/apps/<slug>/installations/new?state=<nonce>
}

/** The `#org/repos` notice the setup callback lands on (`?github=<outcome>` on the redirect). The callback's
 *  refusals render a server page instead; these are the outcomes that return to the app. */
export const GITHUB_INSTALL_OUTCOMES = ["connected", "requested"] as const;
export type GithubInstallOutcome = (typeof GITHUB_INSTALL_OUTCOMES)[number];

/** Where an installation's repository selection is managed on GitHub. */
export function installationManageUrl(i: { installation_id: number; account_type: "User" | "Organization"; account_login: string }): string {
  return i.account_type === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(i.account_login)}/settings/installations/${i.installation_id}`
    : `https://github.com/settings/installations/${i.installation_id}`;
}
