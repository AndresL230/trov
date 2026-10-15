// An organization's per-repository settings for the Repo screen (`repo_settings`, 0071_repo_settings): today one,
// the Overview's default Group by. A TENANT module: every statement names `org_id = ?`, bound from the caller's
// context (test/data-layer.static.test.ts). Written only through the admin cookie route (src/repo/settings-routes.ts),
// audited as `repo.settings` in the same batch; read by the Overview's facts read as `facts.groupDefault`.
import type { RepoSettingsDTO } from "@shared/repo";
import { isGroupBy, type GroupBy } from "@shared/repo-layout-core";
import { batch, first, nowIso, stmt, type TenantContext } from "./sql";

/** The repository as the org has it connected (`org_repos.repo_full_name`, its spelling), or null when the org
 *  does not have it — a setting is only ever read or written for one of the org's own repositories. */
export async function orgRepoName(ctx: TenantContext, repo: string): Promise<string | null> {
  const row = await first<{ repo_full_name: string }>(ctx,
    `SELECT repo_full_name FROM org_repos WHERE org_id = ? AND repo_full_name = ? COLLATE NOCASE`, ctx.orgId, repo);
  return row?.repo_full_name ?? null;
}

const EMPTY = (repo: string): RepoSettingsDTO => ({ repo, overview_group: null, updated_at: null, updated_by: null });

/** A repository's settings — every field null when no admin has set one, or the org does not have the repository. */
export async function readRepoSettings(ctx: TenantContext, repo: string): Promise<RepoSettingsDTO> {
  const row = await first<{ repo: string; overview_group: string | null; updated_at: string; updated_by: string }>(ctx,
    `SELECT s.repo, s.overview_group, s.updated_at, s.updated_by FROM repo_settings s
       JOIN org_repos r ON r.org_id = s.org_id AND r.repo_full_name = s.repo
      WHERE s.org_id = ? AND s.repo = ? COLLATE NOCASE`, ctx.orgId, repo);
  if (!row) return EMPTY(repo);
  return { repo: row.repo, overview_group: isGroupBy(row.overview_group) ? row.overview_group : null, updated_at: row.updated_at, updated_by: row.updated_by };
}

/** Set a repository's default Group by (null clears it), as `ctx.userId`, audited in the same batch. The caller
 *  has checked the role and that `repo` is the org's (`orgRepoName`, whose spelling it passes). */
export async function setRepoOverviewGroup(ctx: TenantContext, repo: string, group: GroupBy | null, at: string = nowIso()): Promise<RepoSettingsDTO> {
  const before = await readRepoSettings(ctx, repo);
  await batch(ctx, [
    stmt(ctx, `INSERT INTO repo_settings (org_id, repo, overview_group, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (org_id, repo) DO UPDATE SET overview_group = excluded.overview_group, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ctx.orgId, repo, group, at, ctx.userId),
    stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, 'repo.settings', ?, ?, ?)`,
      ctx.orgId, ctx.userId, repo, JSON.stringify({ overview_group: group, was: before.overview_group }), at),
  ]);
  return { repo, overview_group: group, updated_at: at, updated_by: ctx.userId };
}
