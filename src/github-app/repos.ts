// The repositories an org's installation can see (`GET /installation/repositories`) — what Org settings ›
// Repositories offers instead of a typed `owner/repo`. Read with an installation token (so this module
// resolves a credential: never reachable from src/mcp.ts), cached per isolate for a minute, and used to
// keep `org_repos.connection` / `access_lost_at` in step (./store.ts `syncRepoAccess`).
import { GITHUB_REPO_LIST_MAX } from "@shared/github-app";
import type { TenantContext } from "../data/sql";
import type { Env } from "../env";
import { listInstallationRepos, type InstallationRepo } from "./api";
import { resolveGithubCredential } from "./credential";
import { syncRepoAccess } from "./store";

export interface VisibleRepos { repositories: InstallationRepo[]; total: number; truncated: boolean }
export type VisibleReposResult = { ok: true; list: VisibleRepos } | { ok: false; reason: "not_connected" | "github_failed"; status?: number };

/** How long a list is reused. Short: a repository added to the installation on GitHub should show up
 *  on the next look, and the App's webhook (`installation_repositories`) drops the entry at once. */
export const REPO_LIST_TTL_MS = 60_000;
const cache = new Map<number, { at: number; list: VisibleRepos }>();

export function forgetRepoList(installationId: number): void { cache.delete(installationId); }
/** Tests only. */
export function clearRepoLists(): void { cache.clear(); }

/**
 * The live installation's repositories, through its own token (`appOnly`: the stored token is never
 * what answers "what can the installation see"). A complete list also re-marks the org's connected
 * repositories — reachable through the App, or no longer.
 */
export async function visibleRepos(ctx: TenantContext, env: Env, opts: { fetchImpl?: typeof fetch; refresh?: boolean; now?: number } = {}): Promise<VisibleReposResult> {
  const now = opts.now ?? Date.now();
  const gh = await resolveGithubCredential(ctx, env, { appOnly: true, fetchImpl: opts.fetchImpl, now });
  if (!gh || !gh.installation) return { ok: false, reason: "not_connected" };
  const id = gh.installation.installation_id;
  const held = cache.get(id);
  if (held && !opts.refresh && now - held.at < REPO_LIST_TTL_MS) return { ok: true, list: held.list };
  const res = await listInstallationRepos(gh.token.reveal(), gh.fetch(opts.fetchImpl), GITHUB_REPO_LIST_MAX);
  if (!res.ok) {
    await gh.recordOutcome({ ok: false, message: `list the installation's repositories: github ${res.status || "request failed"}`, revealed: gh.token }, now);
    return { ok: false, reason: "github_failed", status: res.status };
  }
  const list: VisibleRepos = { repositories: res.repositories, total: res.total, truncated: res.truncated };
  cache.set(id, { at: now, list });
  await gh.recordOutcome({ ok: true }, now);
  // A cut list cannot say a repository is gone — only a complete one re-marks.
  if (!list.truncated) await syncRepoAccess(ctx, { visible: list.repositories.map((r) => r.full_name) }).catch(() => undefined);
  return { ok: true, list };
}
