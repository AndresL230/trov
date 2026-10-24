// An org's repo / environment rows, for tests of the background entry points (cron, webhook, backfill).
//
// Those entry points read their configuration from `org_repos` / `org_environments` (multitenancy
// Phase 5b), and the per-test reset empties both tables. The suites written when the app was ONE org
// describe their setup the way production did then — `GITHUB_REPO` and `REPO_ENVIRONMENTS` on the Env, and its
// credentials as Worker secrets — so the wrappers at the bottom do for a test what migration 0042_organizations and
// SaplingLearn's admin did for production: copy those two vars into SaplingLearn's rows and store each credential var
// as the org's own secret (Org settings › Integrations), then call the real entry point for that org. A suite keeps its call
// sites and only changes where it imports the function from; that those suites still pass unchanged is
// the proof that SaplingLearn's behaviour did not move.
import { env } from "cloudflare:test";
import type { Env } from "../../src/env";
import type { RepoEnvConfig } from "../../src/repo/config";
import * as cron from "../../src/repo/cron";
import { runBackfill as realBackfill } from "../../src/tools/backfill";
import { handleGithubWebhook as realWebhook } from "../../src/github-hook";
import { ORG_A, systemCtx, tenantCtx } from "./tenant";
import { batch } from "../../src/data/sql";
import { secretPutStmts, setIntegrationConfig } from "../../src/data/secrets";

const AT = "2026-10-06T00:00:00.000Z";

const REQUIRED = ["key", "label", "branch", "frontendUrl", "apiUrl", "healthPath"] as const;

/** Parse the old `REPO_ENVIRONMENTS` var (what 0042_organizations copied into `org_environments`).
 *  Absent or malformed → []. Only these suites still describe a setup that way. */
export function repoEnvironments(env: { REPO_ENVIRONMENTS?: string }): RepoEnvConfig[] {
  if (!env.REPO_ENVIRONMENTS) return [];
  try {
    const parsed = JSON.parse(env.REPO_ENVIRONMENTS) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is RepoEnvConfig =>
      !!e && typeof e === "object" && REQUIRED.every((k) => typeof (e as Record<string, unknown>)[k] === "string"))
      .map((e) => ({
        key: e.key, label: e.label, note: e.note ?? null, branch: e.branch,
        frontendUrl: e.frontendUrl, apiUrl: e.apiUrl, healthPath: e.healthPath,
      }));
  } catch { return []; }
}

/** Replace `orgId`'s environments with `envs`, in order (position = index). */
export async function setOrgEnvironments(envs: RepoEnvConfig[], orgId: string = ORG_A): Promise<void> {
  await env.DB.prepare(`DELETE FROM org_environments WHERE org_id = ?`).bind(orgId).run();
  for (const [i, c] of envs.entries()) {
    await env.DB.prepare(
      `INSERT INTO org_environments (org_id, key, position, label, note, branch, frontend_url, api_url, health_path, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test')`,
    ).bind(orgId, c.key, i, c.label, c.note ?? null, c.branch, c.frontendUrl, c.apiUrl, c.healthPath, AT, AT).run();
  }
}

export interface RepoRowOpts { id?: string; primary?: boolean }

/** Add a repo row to `orgId`; returns its id (the webhook path id and the `github_webhook` scope). */
export async function addOrgRepo(repo: string, orgId: string = ORG_A, o: RepoRowOpts = {}): Promise<string> {
  const id = o.id ?? `hook_${orgId}_${repo.replace(/[^A-Za-z0-9]/g, "_")}`.slice(0, 64);
  await env.DB.prepare(
    `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, created_at, created_by) VALUES (?, ?, ?, ?, ?, 'test')`,
  ).bind(id, orgId, repo, o.primary === false ? 0 : 1, AT).run();
  return id;
}

/** SaplingLearn's hook id, as 0042_organizations seeds it. */
export const SAPLING_HOOK = "hook_saplinglearn_sapling";

/** The old one-org setup a suite may still describe on its Env: the two config vars and SaplingLearn's
 *  credentials, as Worker secrets were named before organizations. */
export interface LegacyOrgVars {
  GITHUB_REPO?: string; REPO_ENVIRONMENTS?: string;
  GITHUB_SERVICE_TOKEN?: string; GITHUB_WEBHOOK_SECRET?: string;
  CF_ANALYTICS_TOKEN?: string; CF_ANALYTICS_ACCOUNT_ID?: string; SAPLING_METRICS_TOKEN?: string;
}
export type LegacyEnv = Env & LegacyOrgVars;

/**
 * What 0042_organizations and SaplingLearn's admin did, from `e`: `GITHUB_REPO` → its primary repo row,
 * `REPO_ENVIRONMENTS` → its environments, and each credential var that is set → the org's stored secret for
 * it (a var that is absent or empty stores nothing; a secret a test stored itself is left alone). Always
 * through the pool's own D1 — `e` may carry a broken one on purpose. Returns `e`.
 */
export async function syncOrgConfig<E extends Env>(e: E = env as unknown as E): Promise<E> {
  const v = e as E & LegacyOrgVars;
  await env.DB.prepare(`DELETE FROM org_repos WHERE org_id = ?`).bind(ORG_A).run();
  if (v.GITHUB_REPO) await addOrgRepo(v.GITHUB_REPO, ORG_A, { id: SAPLING_HOOK });
  const envs = repoEnvironments(v);
  await setOrgEnvironments(envs, ORG_A);
  const owner = await tenantCtx("AndresL230", undefined, { env: env as unknown as Env });
  const put = async (kind: Parameters<typeof secretPutStmts>[1], scope: string, value: string | undefined) => {
    if (value) await batch(owner, await secretPutStmts(owner, kind, scope, value));
  };
  await put("github_token", "", v.GITHUB_SERVICE_TOKEN);
  if (v.GITHUB_REPO) await put("github_webhook", SAPLING_HOOK, v.GITHUB_WEBHOOK_SECRET);
  await put("cloudflare_analytics", "", v.CF_ANALYTICS_TOKEN);
  if (v.CF_ANALYTICS_ACCOUNT_ID) await setIntegrationConfig(owner, "cloudflare_analytics", "", { account_id: v.CF_ANALYTICS_ACCOUNT_ID });
  for (const c of envs) await put("metrics_endpoint", c.key, v.SAPLING_METRICS_TOKEN);
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

/** A delivery to SaplingLearn's repo hook (`/webhook/github/<SAPLING_HOOK>`), signed with its stored secret. */
export async function handleGithubWebhook(request: Request, e: Env, opts?: Omit<Parameters<typeof realWebhook>[2], "hookId">): Promise<Response> {
  return realWebhook(request, await syncOrgConfig(e), { ...opts, hookId: SAPLING_HOOK });
}
