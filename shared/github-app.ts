// The wire shapes of the GitHub App connection (docs/architecture/github-app.md; routes in
// src/github-app/routes.ts). Types and the small vocabularies only — never a token, never key material.

export type GithubAccountType = "User" | "Organization";
export type GithubRepoSelection = "all" | "selected";
/** Why a binding ended: disconnected in Trov, uninstalled on GitHub, or GitHub no longer knows it. */
export type GithubRemovedReason = "disconnected" | "uninstalled" | "not_found";

/** The org's LIVE installation, as Org settings shows it. */
export interface GithubInstallationDTO {
  /** GitHub's installation id. null for a viewer who is not an admin. */
  installation_id: number | null;
  account_login: string;
  account_type: GithubAccountType;
  repository_selection: GithubRepoSelection;
  connected_by: string;
  connected_at: string;
  /** Suspended on GitHub: nothing can be read through it until that is lifted there. */
  suspended_at: string | null;
  last_used_at: string | null;
  /** Scrubbed, ≤ 300 characters; null after a success. Admins only (null otherwise). */
  last_error: string | null;
  /** The installation's settings page on GitHub ("Manage on GitHub"). Admins only. */
  manage_url: string | null;
}

/** `GET /api/o/:slug/github`. */
export interface GithubAppStatusDTO {
  /** The deployment has the App's slug, id and private key: "Connect with GitHub" can work at all. */
  configured: boolean;
  /** The org's live installation, or null. */
  installation: GithubInstallationDTO | null;
  /** The last binding that ended WITHOUT the org asking (uninstalled on GitHub, or gone), while nothing
   *  replaced it — what the screen explains. null once reconnected, and after a Disconnect. */
  lost: { account_login: string; reason: Exclude<GithubRemovedReason, "disconnected">; at: string } | null;
  /** The live installation is on an account that does NOT own the org's primary repository, so nothing
   *  is read from that repository through the App (an installation answers only for its own account's
   *  repositories). null when there is no installation, no primary repository, or the account owns it. */
  mismatch: { account_login: string; repo_full_name: string } | null;
}

/** One repository the installation can see (`GET /api/o/:slug/github/repositories`). */
export interface GithubRepoOptionDTO {
  full_name: string;
  private: boolean;
  /** Already one of the org's connected repositories. */
  tracked: boolean;
  is_primary: boolean;
}

export interface GithubReposDTO {
  repositories: GithubRepoOptionDTO[];
  /** GitHub's own count; more than `repositories.length` when the list was cut (see `GITHUB_REPO_LIST_MAX`). */
  total: number;
  truncated: boolean;
}

/** How many of an installation's repositories the picker lists (five pages of 100). */
export const GITHUB_REPO_LIST_MAX = 500;

/**
 * What `/auth/callback` says after an install return — the `github` query value on the page it redirects
 * to (`/o/<slug>/?github=<code>#org/repos`). The SPA turns each into one sentence (web/src/github-app.ts).
 */
export const GITHUB_CONNECT_OUTCOMES = [
  "connected",          // bound; the Repositories tab now lists the installation's repositories
  "requested",          // setup_action=request: waiting for a GitHub organization owner; nothing connected
  "unlinked",           // an install / update arrived that Trov did not start: nothing connected
  "expired",            // our state cookie was missing, expired, or did not match
  "wrong_person",       // the signed-in person is not the one who started
  "not_admin",          // no longer an admin of the org
  "wrong_account",      // the GitHub account is not this person's linked GitHub identity
  "not_yours",          // the installation is not one this GitHub account can reach
  "partial_access",     // this GitHub account cannot read every repository the installation covers (`missing=` how many)
  "too_many_repos",     // the installation covers more repositories than the check reads (1,000): select some on GitHub
  "taken",              // the installation is connected to another Trov organization
  "suspended",          // the installation is suspended on GitHub; nothing connected
  "none_found",         // linking an existing installation: this account can reach none
  "choose",             // linking an existing installation: several to choose from (`accounts=`)
  "not_configured",     // the deployment has no App configured
  "github_failed",      // GitHub did not answer; nothing connected
] as const;
export type GithubConnectOutcome = (typeof GITHUB_CONNECT_OUTCOMES)[number];
export const isGithubConnectOutcome = (v: unknown): v is GithubConnectOutcome =>
  typeof v === "string" && (GITHUB_CONNECT_OUTCOMES as readonly string[]).includes(v);
