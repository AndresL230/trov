// The environments the dashboard reports on. Configuration, not capture: which
// branch deploys where is a fact about the team's setup that no webhook states.
import { all, first, type TenantContext } from "../data/sql";

export interface RepoEnvConfig {
  key: string;            // stable id stored on rows: "staging" | "production"
  label: string;          // card title
  note: string | null;    // the branch, shown beside the label
  branch: string;         // the git branch this environment deploys from
  railwayEnv: string;     // GitHub deployment `environment`, e.g. "Sapling / staging"
  worker: string;         // Cloudflare Worker script name
  workerCheck: string;    // the check run Workers Builds posts, e.g. "Workers Builds: frontend-staging"
  frontendUrl: string;
  apiUrl: string;
  healthPath: string;     // appended to apiUrl
  railwayEnvironmentId?: string;
  railwayServiceId?: string;
}

const REQUIRED = ["key", "label", "branch", "railwayEnv", "worker", "workerCheck", "frontendUrl", "apiUrl", "healthPath"] as const;

/** Parse `REPO_ENVIRONMENTS`. Absent or malformed → [].
 *  LEGACY: the var is what 0037 copied into `org_environments`. Nothing in src/ calls this any more —
 *  every reader uses `orgEnvironments` — only the SaplingLearn-era suites do, to seed those rows
 *  (test/helpers/org-config.ts). Phase 7 deletes it with the var. */
export function repoEnvironments(env: { REPO_ENVIRONMENTS?: string }): RepoEnvConfig[] {
  if (!env.REPO_ENVIRONMENTS) return [];
  try {
    const parsed = JSON.parse(env.REPO_ENVIRONMENTS) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is RepoEnvConfig =>
      !!e && typeof e === "object" && REQUIRED.every((k) => typeof (e as Record<string, unknown>)[k] === "string"))
      .map((e) => ({ ...e, note: e.note ?? null }));
  } catch { return []; }
}

// ── the org's own configuration (canopy-multitenancy.md §9, D16) ─────────────
// What `GITHUB_REPO` and `REPO_ENVIRONMENTS` were, read from the org's rows (0037 seeded SaplingLearn's
// from those two vars). Every background job reads its repo and environments through these; nothing in
// the cron, the webhook or the backfill reads the vars any more.

interface EnvRow {
  key: string; label: string; note: string | null; branch: string; railway_env: string; worker: string; worker_check: string;
  frontend_url: string; api_url: string; health_path: string; railway_environment_id: string | null; railway_service_id: string | null;
}
const ENV_COLS = `key, label, note, branch, railway_env, worker, worker_check, frontend_url, api_url, health_path, railway_environment_id, railway_service_id`;
const toConfig = (r: EnvRow): RepoEnvConfig => ({
  key: r.key, label: r.label, note: r.note ?? null, branch: r.branch, railwayEnv: r.railway_env, worker: r.worker, workerCheck: r.worker_check,
  frontendUrl: r.frontend_url, apiUrl: r.api_url, healthPath: r.health_path,
  ...(r.railway_environment_id ? { railwayEnvironmentId: r.railway_environment_id } : {}),
  ...(r.railway_service_id ? { railwayServiceId: r.railway_service_id } : {}),
});

/** The org's environments in `position` order — ORDER MATTERS, as it did in the var: [0] is the drift
 *  head and the `canopy/*` status branch, the last one the drift base. None → []. */
export async function orgEnvironments(ctx: TenantContext): Promise<RepoEnvConfig[]> {
  return (await all<EnvRow>(ctx, `SELECT ${ENV_COLS} FROM org_environments WHERE org_id = ? ORDER BY position`, ctx.orgId)).map(toConfig);
}

/** One environment by key, or null (deleted since the dispatcher listed it). */
export async function orgEnvironment(ctx: TenantContext, key: string): Promise<RepoEnvConfig | null> {
  const row = await first<EnvRow>(ctx, `SELECT ${ENV_COLS} FROM org_environments WHERE org_id = ? AND key = ?`, ctx.orgId, key);
  return row ? toConfig(row) : null;
}

/** The org's PRIMARY repository — the one the dashboard, the ticket mirror, sprint progress and the
 *  reconcile read (one per org, C-11). `id` is its webhook path id and its `github_webhook` scope. */
export async function orgPrimaryRepo(ctx: TenantContext): Promise<{ id: string; repo: string } | null> {
  const row = await first<{ id: string; repo_full_name: string }>(ctx, `SELECT id, repo_full_name FROM org_repos WHERE org_id = ? AND is_primary = 1`, ctx.orgId);
  return row ? { id: row.id, repo: row.repo_full_name } : null;
}
