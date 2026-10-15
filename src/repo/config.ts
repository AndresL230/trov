// The environments the dashboard reports on. Configuration, not capture: which
// branch deploys where is a fact about the team's setup that no webhook states.
import { all, first, type TenantContext } from "../data/sql";

export interface RepoEnvConfig {
  key: string;            // stable id stored on rows: "staging" | "production"
  label: string;          // card title
  note: string | null;    // the branch, shown beside the label
  branch: string;         // the git branch this environment deploys from
  frontendUrl: string;
  apiUrl: string;
  healthPath: string;     // appended to apiUrl
}
// What hosts an environment (a Cloudflare Worker, a Railway service, a Vercel project, …) is not here:
// those are its PARTS (`org_environment_parts`, src/hosting/parts.ts), read by the hosting providers.

const REQUIRED = ["key", "label", "branch", "frontendUrl", "apiUrl", "healthPath"] as const;

/** Parse `REPO_ENVIRONMENTS`. Absent or malformed → [].
 *  LEGACY: the var is what 0042_organizations copied into `org_environments`. Nothing in src/ calls this any more —
 *  every reader uses `orgEnvironments` — only the SaplingLearn-era suites do, to seed those rows
 *  (test/helpers/org-config.ts). Phase 7 deletes it with the var. */
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

// ── the org's own configuration (canopy-multitenancy.md §9, D16) ─────────────
// What `GITHUB_REPO` and `REPO_ENVIRONMENTS` were, read from the org's rows (0042_organizations seeded SaplingLearn's
// from those two vars). Every background job reads its repo and environments through these; nothing in
// the cron, the webhook or the backfill reads the vars any more.

interface EnvRow {
  key: string; label: string; note: string | null; branch: string; frontend_url: string; api_url: string; health_path: string;
}
const ENV_COLS = `key, label, note, branch, frontend_url, api_url, health_path`;
const toConfig = (r: EnvRow): RepoEnvConfig => ({
  key: r.key, label: r.label, note: r.note ?? null, branch: r.branch,
  frontendUrl: r.frontend_url, apiUrl: r.api_url, healthPath: r.health_path,
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

/** The org's repositories, the primary first — what `GET /repo/dashboard?repo=` and MCP `get_repo_dashboard`'s
 *  `repo` are checked against. */
export async function orgRepoNames(ctx: TenantContext): Promise<string[]> {
  return (await all<{ repo_full_name: string }>(ctx,
    `SELECT repo_full_name FROM org_repos WHERE org_id = ? ORDER BY is_primary DESC, created_at, id`, ctx.orgId)).map((r) => r.repo_full_name);
}

/** The repository a dashboard read asks for: `asked` (any case) when the org has it, the primary when nothing is
 *  asked ('' with none), and `null` when it names one the org does not have. */
export async function dashboardRepo(ctx: TenantContext, asked: string | undefined | null): Promise<string | null> {
  if (asked === undefined || asked === null || asked === "") return (await orgPrimaryRepo(ctx))?.repo ?? "";
  const want = asked.trim().toLowerCase();
  return (await orgRepoNames(ctx)).find((r) => r.toLowerCase() === want) ?? null;
}
