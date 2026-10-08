// The org's GitHub App connection as Org settings shows it (`GET /api/o/:slug/github`, and inside
// `GET …/integrations`). Metadata only: an account name, timestamps, a scrubbed last error.
import type { GithubAppStatusDTO, GithubInstallationDTO } from "@shared/github-app";
import { hasRole } from "../data/context";
import type { TenantContext } from "../data/sql";
import type { Env } from "../env";
import { orgPrimaryRepo } from "../repo/config";
import { appConfigured, manageUrl } from "./api";
import { latestInstallation, type InstallationRow } from "./store";

const installationDTO = (row: InstallationRow, admin: boolean): GithubInstallationDTO => ({
  installation_id: admin ? row.installation_id : null,
  account_login: row.account_login,
  account_type: row.account_type,
  repository_selection: row.repository_selection,
  connected_by: row.connected_by,
  connected_at: row.connected_at,
  suspended_at: row.suspended_at,
  last_used_at: row.last_used_at,
  last_error: admin ? row.last_error : null,
  manage_url: admin ? manageUrl(row) : null,
});

/** The org's connection as the page shows it. `mismatch` says the App is on an account that does not own
 *  the primary repository — otherwise that repository just reads "manual", with no hint why. `lost` is the last binding when it ended from GitHub's
 *  side and nothing has replaced it — never after a Disconnect, which the admin asked for. */
export async function githubAppStatus(ctx: TenantContext, env: Env): Promise<GithubAppStatusDTO> {
  const admin = hasRole(ctx, "admin");
  const latest = await latestInstallation(ctx);
  const live = latest && latest.removed_at === null ? latest : null;
  const lost = latest && latest.removed_at !== null && latest.removed_reason !== null && latest.removed_reason !== "disconnected"
    ? { account_login: latest.account_login, reason: latest.removed_reason, at: latest.removed_at } : null;
  return { configured: appConfigured(env), installation: live ? installationDTO(live, admin) : null, lost, mismatch: live ? await accountMismatch(ctx, live) : null };
}

/** The installation's account when it does NOT own the org's primary repository — the one repository
 *  Trov captures, which the App then cannot answer for (`credential.ts` `covers`). Names only, D1 only. */
export async function accountMismatch(ctx: TenantContext, live: Pick<InstallationRow, "account_login">): Promise<{ account_login: string; repo_full_name: string } | null> {
  const repo = (await orgPrimaryRepo(ctx))?.repo ?? null;
  if (!repo || repo.split("/")[0]?.toLowerCase() === live.account_login.toLowerCase()) return null;
  return { account_login: live.account_login, repo_full_name: repo };
}
