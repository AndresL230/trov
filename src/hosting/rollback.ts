// Rollback detection (repo setups, Phase A). When a part's newest `ready` deploy serves a DIFFERENT sha than the
// ready deploy before it, ONE GitHub `compare` (previous...new) says which way it moved: GitHub answers
// `status: "behind"` — the new sha is an ancestor of the previous one, so the part went BACK — and the deploy
// gets `rolled_back_from` = the previous sha. `ahead` (a normal ship), `identical` and `diverged` set nothing.
//
// Off the render path (invariant 7): it runs in the deploy WRITERS — the hosting poll (./poll.ts, the cron and
// Poll now) and the GitHub capture (./github-deploys.ts, the webhook) — never in a read. The GitHub token is the
// org's, resolved by the caller through `resolveGithubCredential` and handed down as a lazy `gh()`, so this
// module imports nothing that reads a secret and the webhook's capture may call it. A preview, a deploy that is
// not `ready`, one without a sha, the part's first ready deploy, the same sha again, no GitHub credential and a
// failed compare all set nothing (never a guess). The compare is counted in the hosting job's cost
// (`ROLLBACK_COMPARE_COST`, ./poll.ts `providerPollCost`).
import { first, run, type TenantContext } from "../data/sql";
import { ghJsonOrNull, type GhOpts } from "../repo/github";

/** The fetches one rollback check can make: ONE compare. */
export const ROLLBACK_COMPARE_COST = 1;

const SHA = /^[0-9a-f]{7,64}$/;

export interface RollbackRef { env: string; key: string; provider: string }
export type RollbackOutcome = "rolled_back" | "forward" | "skipped";

interface Row { deploy_id: string; state: string; target: string | null; sha: string | null; created_at: string; rolled_back_from: string | null }

/**
 * Check ONE deploy (by its provider deploy id) against the part's previous ready deploy. At most one GitHub
 * request. Never throws for GitHub's answer: a failed compare is `skipped` (logged by the caller's own catch
 * only if the D1 write fails).
 */
export async function checkRollback(
  ctx: TenantContext, part: RollbackRef, deployId: string, gh: () => Promise<GhOpts | null>,
): Promise<RollbackOutcome> {
  const d = await first<Row>(ctx,
    `SELECT deploy_id, state, target, sha, created_at, rolled_back_from FROM hosting_deploys
      WHERE org_id = ? AND env = ? AND part = ? AND provider = ? AND deploy_id = ?`,
    ctx.orgId, part.env, part.key, part.provider, deployId);
  if (!d || d.state !== "ready" || d.target === "preview" || !d.sha || !SHA.test(d.sha) || d.rolled_back_from) return "skipped";
  const prev = await first<Row>(ctx,
    `SELECT deploy_id, state, target, sha, created_at, rolled_back_from FROM hosting_deploys
      WHERE org_id = ? AND env = ? AND part = ? AND provider = ? AND state = 'ready' AND sha IS NOT NULL
        AND (target IS NULL OR target <> 'preview') AND created_at < ?
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    ctx.orgId, part.env, part.key, part.provider, d.created_at);
  if (!prev?.sha || !SHA.test(prev.sha) || prev.sha === d.sha) return "skipped";
  let opts: GhOpts | null;
  try { opts = await gh(); } catch { return "skipped"; }
  if (!opts) return "skipped";
  let cmp: { status?: unknown } | null;
  try {
    cmp = await ghJsonOrNull<{ status?: unknown }>(opts, `/compare/${prev.sha}...${d.sha}?per_page=1`);
  } catch {
    return "skipped"; // GitHub refused or timed out: no answer, so no claim
  }
  if (cmp?.status !== "behind") return cmp ? "forward" : "skipped";
  await run(ctx,
    `UPDATE hosting_deploys SET rolled_back_from = ? WHERE org_id = ? AND env = ? AND part = ? AND provider = ? AND deploy_id = ? AND rolled_back_from IS NULL`,
    prev.sha, ctx.orgId, part.env, part.key, part.provider, d.deploy_id);
  return "rolled_back";
}

/**
 * The deploy a poll should check after it stored `changed`: the part's NEWEST non-preview ready deploy, only
 * when THIS write created or changed it (so a quiet re-poll costs no compare). null = nothing to check.
 */
export async function newestReadyChanged(ctx: TenantContext, part: RollbackRef, changed: readonly string[]): Promise<string | null> {
  if (!changed.length) return null;
  const newest = await first<{ deploy_id: string }>(ctx,
    `SELECT deploy_id FROM hosting_deploys
      WHERE org_id = ? AND env = ? AND part = ? AND provider = ? AND state = 'ready' AND (target IS NULL OR target <> 'preview')
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    ctx.orgId, part.env, part.key, part.provider);
  return newest && changed.includes(newest.deploy_id) ? newest.deploy_id : null;
}
