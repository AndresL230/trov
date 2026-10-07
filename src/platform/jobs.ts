// The platform's view of BACKGROUND work (canopy-multitenancy.md §8.3, §8.5): which orgs there are to
// run a job for, which org a webhook delivery belongs to, and where each job's rotation stands. These
// are the only cross-org reads a background entry point makes — they return ids and a repo name, never
// content and never a secret — and everything after them runs as ONE org's system tenant. The reads of
// `org_repos` / `org_environments` / `org_github_installations` are declared in
// test/data-layer.static.test.ts (PLATFORM_ALLOW).
//
// A SUSPENDED org (0042_organizations) is absent from every list here: its crons do not run and its hooks read as
// unknown, exactly as it resolves for no member (src/data/context.ts).
import type { Env } from "../env";
import { platform, systemTenant, type PlatformContext, type TenantContext } from "../data/context";
import { all, first, nowIso, run } from "../data/platform-sql";

/** Every org that is not suspended, by id — the digest cron's list. */
export async function listActiveOrgIds(p: PlatformContext): Promise<string[]> {
  return (await all<{ id: string }>(p, `SELECT id FROM orgs WHERE suspended_at IS NULL ORDER BY id`)).map((r) => r.id);
}

export interface EnvUnit { org_id: string; key: string }

/** One row per (org, environment) of every active org, each org's in `position` order: the units of
 *  the `health` and `usage` jobs. An org with no environment contributes nothing — it costs the cron
 *  no statement of its own. */
export function listEnvUnits(p: PlatformContext): Promise<EnvUnit[]> {
  return all<EnvUnit>(p,
    `SELECT e.org_id, e.key FROM org_environments e JOIN orgs o ON o.id = e.org_id
      WHERE o.suspended_at IS NULL ORDER BY e.org_id, e.position`);
}

export interface RepoUnit { org_id: string; envs: number }

/** One row per active org that has a PRIMARY repo: the units of the `progress` and `reconcile` jobs.
 *  `envs` is the org's environment count — what the reconcile's subrequest cost is sized by. */
export function listRepoUnits(p: PlatformContext): Promise<RepoUnit[]> {
  return all<RepoUnit>(p,
    `SELECT r.org_id, (SELECT COUNT(*) FROM org_environments e WHERE e.org_id = r.org_id) AS envs
       FROM org_repos r JOIN orgs o ON o.id = r.org_id
      WHERE r.is_primary = 1 AND o.suspended_at IS NULL ORDER BY r.org_id`);
}

export interface HookRepo { id: string; org_id: string; repo_full_name: string; is_primary: number }
const HOOK_COLS = `r.id, r.org_id, r.repo_full_name, r.is_primary`;

/** The repo a per-org webhook URL names (`/webhook/github/<org_repos.id>`), or null. */
export function hookRepo(p: PlatformContext, hookId: string): Promise<HookRepo | null> {
  return first<HookRepo>(p,
    `SELECT ${HOOK_COLS} FROM org_repos r JOIN orgs o ON o.id = r.org_id WHERE r.id = ? AND o.suspended_at IS NULL`, hookId);
}

/** The ONE repo the old `/webhook/github` still delivers to (`legacy_hook = 1` — SaplingLearn's, 0042_organizations),
 *  or null. The cleanup phase deletes the route, the flag and this. */
export function legacyHookRepo(p: PlatformContext): Promise<HookRepo | null> {
  return first<HookRepo>(p,
    `SELECT ${HOOK_COLS} FROM org_repos r JOIN orgs o ON o.id = r.org_id
      WHERE r.legacy_hook = 1 AND o.suspended_at IS NULL ORDER BY r.created_at, r.id LIMIT 1`);
}

// ── the GitHub App: which org an installation is connected to (0043_github_app) ──

export interface InstallationOrg { org_id: string; org_slug: string; org_suspended: number }

/**
 * The org a LIVE binding of GitHub installation `installationId` belongs to, or null — the App
 * webhook's and the connect callback's lookup, before any org is known. It returns the org and whether
 * it is suspended, nothing else: the binding itself is then read as that org's tenant
 * (src/github-app/store.ts). A suspended org's binding IS returned (flagged): the connect flow must
 * still see that the installation is taken, and an uninstall on GitHub must still end it — a delivery
 * to CAPTURE is dropped by the caller.
 */
export function installationOrg(p: PlatformContext, installationId: number): Promise<InstallationOrg | null> {
  return first<InstallationOrg>(p,
    `SELECT i.org_id, o.slug AS org_slug, (o.suspended_at IS NOT NULL) AS org_suspended
       FROM org_github_installations i JOIN orgs o ON o.id = i.org_id
      WHERE i.installation_id = ? AND i.removed_at IS NULL`, installationId);
}

// ── the rotation cursor (`cron_cursor`, 0042_organizations) ──────────────────

/** The key of the last unit `job` served before it ran out of budget; `''` = it served them all. */
export async function readCursor(p: PlatformContext, job: string): Promise<string> {
  return (await first<{ last_key: string }>(p, `SELECT last_key FROM cron_cursor WHERE job = ?`, job))?.last_key ?? "";
}

export async function writeCursor(p: PlatformContext, job: string, lastKey: string): Promise<void> {
  await run(p,
    `INSERT INTO cron_cursor (job, last_key, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(job) DO UPDATE SET last_key = excluded.last_key, updated_at = excluded.updated_at`, job, lastKey, nowIso());
}

// ── the system tenant a job runs as ──────────────────────────────────────────

/** Thrown when a background job is asked to run for an MCP context: a job reads the org's
 *  credentials, and no bearer path may reach one (D14). */
export class JobAccessError extends Error {
  constructor() { super("background jobs are not available to a bearer context"); this.name = "JobAccessError"; }
}

/**
 * The context a background job runs as: the SYSTEM tenant of `ctx`'s org. The cron and the webhook
 * already hold one; an admin's on-demand run (Poll now, Sync GitHub) arrives with the admin's session
 * context and runs the SAME job, as system, for that admin's org — the route's own gate decides who
 * may ask. A bearer context is refused outright.
 */
export function jobTenant(env: Env, ctx: TenantContext): TenantContext {
  if (ctx.via === "bearer") throw new JobAccessError();
  return ctx.via === "system" ? ctx : systemTenant(platform(env, "system"), ctx.orgId, "system");
}
