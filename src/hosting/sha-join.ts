// The commit JOIN (repo setups, Phase A): every deploy has a commit, or says it doesn't. A provider that reports
// no sha for a deploy (Cloudflare without Workers Builds access, Fly.io, Railway when `meta` lacks it, a CLI
// deploy anywhere) gets one from GitHub — ONLY when exactly one candidate exists:
//
//   a candidate   a captured GitHub signal on the ENVIRONMENT'S BRANCH that FINISHED within the 10 minutes BEFORE
//                 the deploy was created: a completed check run (`check`, `ref` = the branch), a completed
//                 workflow run (`run`), a settled deployment status whose ref is the branch, or a settled commit
//                 status that lists the branch (`raw.branches`). Each carries a sha; the candidates are the
//                 DISTINCT shas.
//   one           → the deploy's sha, `sha_source = 'joined'`.
//   none, several → sha stays NULL (never a guess: two commits finishing CI in the window could be either).
//
// THE GUARD is `joinCandidate` (the one-candidate rule). App attribution is the environment's branch alone: which
// commit touched which app's paths arrives with `commit_paths` (Phase E).
//
// Runs after a poll stored its deploys (./poll.ts) — a computed, direct write of rows the capture stored (no
// call to GitHub, no secret); the tenant surface only.
import { all, run, type TenantContext } from "../data/sql";

/** How far before a deploy's creation a GitHub signal may have finished to count. */
export const JOIN_WINDOW_MS = 10 * 60_000;
/** At most this many null-sha deploys are joined per poll (a provider lists ≤ 20; the newest matter). */
export const JOIN_MAX_PER_POLL = 10;
/** A deploy older than this is not joined any more: its candidates would have been captured long since. */
export const JOIN_LOOKBACK_MS = 2 * 24 * 3_600_000;

export interface JoinRef { env: string; key: string; provider: string; branch: string }

/** THE ONE-CANDIDATE RULE: the sha to join, or null. PURE. */
export function joinCandidate(shas: readonly (string | null)[]): string | null {
  const distinct = [...new Set(shas.filter((s): s is string => typeof s === "string" && /^[0-9a-f]{7,64}$/i.test(s)).map((s) => s.toLowerCase()))];
  return distinct.length === 1 ? distinct[0] : null;
}

/** The candidate shas for a deploy created at `createdAt` on `branch` — one tenant statement over `repo_events`. */
export async function joinCandidates(ctx: TenantContext, branch: string, createdAt: string): Promise<string[]> {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created) || !branch) return [];
  const from = new Date(created - JOIN_WINDOW_MS).toISOString(), to = new Date(created).toISOString();
  // A string pre-filter a minute wider on each side (GitHub stamps `…Z` without milliseconds, ours carry them —
  // the strings sort apart at the boundary), then the exact instant comparison through julianday.
  const wideFrom = new Date(created - JOIN_WINDOW_MS - 60_000).toISOString(), wideTo = new Date(created + 60_000).toISOString();
  const rows = await all<{ sha: string | null }>(ctx,
    `SELECT DISTINCT lower(sha) AS sha FROM repo_events
      WHERE org_id = ? AND sha IS NOT NULL AND occurred_at >= ? AND occurred_at <= ?
        AND julianday(occurred_at) BETWEEN julianday(?) AND julianday(?)
        AND (
          (kind = 'check' AND state <> 'pending' AND ref = ?)
          OR (kind = 'run' AND ref = ?)
          OR (kind = 'deploy' AND json_extract(raw, '$.signal') = 'deployment' AND state IN ('success', 'failure', 'error') AND ref = ?)
          OR (kind = 'deploy' AND json_extract(raw, '$.signal') = 'status' AND state IN ('success', 'failure', 'error')
              AND EXISTS (SELECT 1 FROM json_each(repo_events.raw, '$.branches') b WHERE b.value = ?))
        )
      LIMIT 3`,
    ctx.orgId, wideFrom, wideTo, from, to, branch, branch, branch, branch);
  return rows.map((r) => r.sha).filter((s): s is string => !!s);
}

/**
 * Join the part's provider deploys that have NO sha (newest first, ≤ `JOIN_MAX_PER_POLL`, never a preview — a
 * preview builds another branch). Each gets a sha only by the one-candidate rule. Returns the ids joined.
 */
export async function joinShas(ctx: TenantContext, part: JoinRef, now: number = Date.now()): Promise<string[]> {
  if (!part.branch) return [];
  const open = await all<{ deploy_id: string; created_at: string }>(ctx,
    `SELECT deploy_id, created_at FROM hosting_deploys
      WHERE org_id = ? AND env = ? AND part = ? AND provider = ? AND sha IS NULL AND source = 'provider'
        AND (target IS NULL OR target <> 'preview') AND created_at >= ?
      ORDER BY created_at DESC LIMIT ?`,
    ctx.orgId, part.env, part.key, part.provider, new Date(now - JOIN_LOOKBACK_MS).toISOString(), JOIN_MAX_PER_POLL);
  const joined: string[] = [];
  for (const d of open) {
    const sha = joinCandidate(await joinCandidates(ctx, part.branch, d.created_at));
    if (!sha) continue;
    await run(ctx,
      `UPDATE hosting_deploys SET sha = ?, sha_source = 'joined' WHERE org_id = ? AND env = ? AND part = ? AND provider = ? AND deploy_id = ? AND sha IS NULL`,
      sha, ctx.orgId, part.env, part.key, part.provider, d.deploy_id);
    joined.push(d.deploy_id);
  }
  return joined;
}
