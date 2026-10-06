// THE GitHub credential (spec §6): what every job that reads a repository authenticates with. An attached,
// unsuspended installation → a fresh ONE-HOUR installation token, scoped to that one repository and to read;
// otherwise the pasted `github_token` (the org's stored secret, or SaplingLearn's env fallback —
// `resolveCredential`). A failed mint falls back to the pasted token too: during a cut-over the old path
// keeps working, and a broken App costs nothing that worked before it.
//
// This module mints and decrypts, so NOTHING REACHABLE FROM src/mcp.ts MAY IMPORT IT (test/secrets.mcp.test.ts
// walks the import graph). The callers — src/repo/cron.ts, src/tools/backfill.ts, src/github-hook.ts — reveal
// the token and hand the plain string down to src/repo/github.ts / src/webhook.ts, which MCP can reach.
import type { Env } from "../env";
import type { TenantContext } from "../data/context";
import { resolveCredential, scrub, SecretAccessError, type Secret } from "../data/secrets";
import { mintInstallationToken, type TokenPermissions } from "./client";
import { appSecrets, githubAppConfig } from "./config";
import { repoInstallation } from "./installations";

/**
 * The repository permissions a job's installation token is minted with — READ, and only what the readers
 * call (src/repo/github.ts, src/tools/backfill.ts, src/tools/progress.ts): commits / compare / branches
 * (contents), PR lists and reviews (pull_requests), issues, deployments, check runs (checks), workflow runs
 * and jobs (actions), commit statuses (statuses), and metadata, which every token carries. Asking for one
 * the installation was not granted is GitHub's 422 — a failed mint, so the pasted token answers.
 */
export const JOB_PERMISSIONS: TokenPermissions = {
  metadata: "read", contents: "read", pull_requests: "read", issues: "read",
  deployments: "read", checks: "read", actions: "read", statuses: "read",
};

/** Where the token came from. `pasted` is the org's stored `github_token` (or SaplingLearn's fallback) —
 *  the only kind with an integration row for a caller to mark used or record an error on. */
export type GithubTokenSource = "installation" | "pasted";
export interface GithubCredential { token: Secret; source: GithubTokenSource }

export interface ResolveOpts {
  /** The cron passes its counting budget fetch: a mint is ONE subrequest of the unit's spend. */
  fetchImpl?: typeof fetch;
  /** The JWT's clock. */
  now?: number;
}

/**
 * `resolveGithubToken`, saying which path answered — for the callers that keep the pasted token's
 * bookkeeping (`markSecretUsed` / `recordSecretOutcome` only when it was the pasted token that was used).
 *
 *   1. A bearer (MCP) context or a plain member is refused with `SecretAccessError` — `getSecret`'s rule —
 *      before anything is read.
 *   2. The App configured AND `repo` attached to an installation that is not suspended → mint for
 *      `repositories: [<repo name>]` with `JOB_PERMISSIONS`. A failure is logged as ONE line, scrubbed of
 *      every App secret (the client's message already is), and falls through.
 *   3. `resolveCredential(ctx, env, "github_token", "")` — or null when there is none.
 */
export async function githubCredential(ctx: TenantContext, env: Env, repo: { id: string; repo: string }, opts: ResolveOpts = {}): Promise<GithubCredential | null> {
  if (ctx.via === "bearer" || ctx.role === "member") throw new SecretAccessError();
  const cfg = githubAppConfig(env);
  const name = repo.repo.slice(repo.repo.indexOf("/") + 1);
  if (cfg && name) {
    const inst = await repoInstallation(ctx, repo.id);
    if (inst && inst.suspended_at === null) {
      try {
        const { token } = await mintInstallationToken(cfg, inst.installation_id, { repositories: [name], permissions: JOB_PERMISSIONS },
          { fetchImpl: opts.fetchImpl, now: opts.now });
        return { token, source: "installation" };
      } catch (e) {
        console.error("github app: installation token failed, using the pasted token",
          scrub(e instanceof Error ? e.message : String(e), appSecrets(cfg)), `org=${ctx.orgId}`);
      }
    }
  }
  const pasted = await resolveCredential(ctx, env, "github_token", "");
  return pasted ? { token: pasted, source: "pasted" } : null;
}

/**
 * The ONE GitHub credential every job uses (spec §6): an installation token for an attached repository,
 * else the pasted token, else null. See `githubCredential` for the order and the refusals.
 */
export async function resolveGithubToken(ctx: TenantContext, env: Env, repo: { id: string; repo: string }, opts?: ResolveOpts): Promise<Secret | null> {
  return (await githubCredential(ctx, env, repo, opts))?.token ?? null;
}
