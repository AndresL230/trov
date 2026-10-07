// An org's repo / environment rows, for tests of the background entry points (cron, webhook, backfill).
//
// Those entry points read their configuration from `org_repos` / `org_environments` (multitenancy
// Phase 5b), and the per-test reset empties both tables. The suites written when the app was ONE org
// describe their setup the way production did then — `GITHUB_REPO` and `REPO_ENVIRONMENTS` on the Env
// — so the wrappers at the bottom do for a test what migration 0042_organizations did for production: copy those two
// vars into SaplingLearn's rows, then call the real entry point for that org. A suite keeps its call
// sites and only changes where it imports the function from; that those suites still pass unchanged is
// the proof that SaplingLearn's behaviour did not move.
import { env } from "cloudflare:test";
import type { Env } from "../../src/env";
import { repoEnvironments, type RepoEnvConfig } from "../../src/repo/config";
import * as cron from "../../src/repo/cron";
import { runBackfill as realBackfill } from "../../src/tools/backfill";
import { handleGithubWebhook as realWebhook } from "../../src/github-hook";
import { ORG_A, systemCtx } from "./tenant";

const AT = "2026-10-06T00:00:00.000Z";

/** Replace `orgId`'s environments with `envs`, in order (position = index). */
export async function setOrgEnvironments(envs: RepoEnvConfig[], orgId: string = ORG_A): Promise<void> {
  await env.DB.prepare(`DELETE FROM org_environments WHERE org_id = ?`).bind(orgId).run();
  for (const [i, c] of envs.entries()) {
    await env.DB.prepare(
      `INSERT INTO org_environments (org_id, key, position, label, note, branch, railway_env, worker, worker_check, frontend_url, api_url,
         health_path, railway_environment_id, railway_service_id, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test')`,
    ).bind(orgId, c.key, i, c.label, c.note ?? null, c.branch, c.railwayEnv, c.worker, c.workerCheck, c.frontendUrl, c.apiUrl,
      c.healthPath, c.railwayEnvironmentId ?? null, c.railwayServiceId ?? null, AT, AT).run();
  }
}

export interface RepoRowOpts { id?: string; primary?: boolean; legacyHook?: boolean }

/** Add a repo row to `orgId`; returns its id (the webhook path id and the `github_webhook` scope). */
export async function addOrgRepo(repo: string, orgId: string = ORG_A, o: RepoRowOpts = {}): Promise<string> {
  const id = o.id ?? `hook_${orgId}_${repo.replace(/[^A-Za-z0-9]/g, "_")}`.slice(0, 64);
  await env.DB.prepare(
    `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, 'test')`,
  ).bind(id, orgId, repo, o.primary === false ? 0 : 1, o.legacyHook ? 1 : 0, AT).run();
  return id;
}

/** SaplingLearn's hook id, as 0042_organizations seeds it. */
export const SAPLING_HOOK = "hook_saplinglearn_sapling";

/**
 * What 0042_organizations did for SaplingLearn, from `e`: `GITHUB_REPO` → its primary repo row (flagged
 * `legacy_hook`, like production's), `REPO_ENVIRONMENTS` → its environments. Always through the pool's
 * own D1 — `e` may carry a broken one on purpose. Returns `e`.
 */
export async function syncOrgConfig<E extends Env>(e: E = env as unknown as E): Promise<E> {
  await env.DB.prepare(`DELETE FROM org_repos WHERE org_id = ?`).bind(ORG_A).run();
  if (e.GITHUB_REPO) await addOrgRepo(e.GITHUB_REPO, ORG_A, { id: SAPLING_HOOK, legacyHook: true });
  await setOrgEnvironments(repoEnvironments(e), ORG_A);
  return e;
}

// ── the pre-multitenancy call shapes, for SaplingLearn ───────────────────────

const sapling = (e: Env) => systemCtx(ORG_A, "system", e);

export async function handleRepoCron(e: Env, scheduledTime: number, fetchImpl?: typeof fetch): Promise<void> {
  return cron.handleRepoCron(await syncOrgConfig(e), scheduledTime, fetchImpl);
}

export async function runUsagePolls(e: Env, now: number, fetchImpl?: typeof fetch) {
  return cron.runUsagePolls(await syncOrgConfig(e), sapling(e), now, fetchImpl);
}

type Reconcile = Parameters<typeof cron.runRepoRefresh>[4];
export async function runRepoRefresh(e: Env, now: number, fetchImpl?: typeof fetch, reconcile?: Reconcile) {
  return cron.runRepoRefresh(await syncOrgConfig(e), sapling(e), now, fetchImpl, reconcile);
}

export async function runLockedRepoRefresh(
  e: Env, by: string, now: number, fetchImpl?: typeof fetch, refresh?: (e: Env, now: number, fetchImpl?: typeof fetch) => Promise<cron.RepoRefreshResult>,
) {
  return cron.runLockedRepoRefresh(await syncOrgConfig(e), sapling(e), by, now, fetchImpl,
    refresh ? (e2, _ctx, now2, f2) => refresh(e2, now2, f2) : undefined);
}

export async function runBackfill(e: Env, principalLogin: string, opts?: Parameters<typeof realBackfill>[3]) {
  return realBackfill(await syncOrgConfig(e), sapling(e), principalLogin, opts);
}

/** A delivery to the LEGACY `/webhook/github` — the URL SaplingLearn's GitHub webhook points at. */
export async function handleGithubWebhook(request: Request, e: Env, opts?: Parameters<typeof realWebhook>[2]): Promise<Response> {
  return realWebhook(request, await syncOrgConfig(e), opts);
}
