// `hosting_deploys` WRITES, shared by the two writers of a deploy: the hosting poll (./poll.ts — a provider's
// deploys, `source = 'provider'`) and the GitHub capture (./github-deploys.ts — a `github` part's deploys,
// `source = 'github'`). Computed, direct writes (invariant 1): no gate, no author.
//
// This module reads no secret and imports nothing that does, so the webhook's capture (src/webhook.ts, which
// is reachable from src/mcp.ts) may call it.
import type { DeployState, DeployTarget } from "@shared/hosting";
import { all, batch, stmt, type Stmt, type TenantContext } from "../data/sql";
import { iso } from "./http";

/** A deploy as it is stored — every string checked, scrubbed and capped, every instant normalised. */
export interface CleanDeploy {
  id: string; state: DeployState; target: DeployTarget; sha: string | null; branch: string | null; message: string | null;
  by: string | null; createdAt: string; readyAt: string | null; url: string | null; inspectUrl: string | null;
  /** A scrubbed failure reason, ≤ 140 characters — only for a deploy that failed (`error`), else null. */
  reason: string | null;
}

/** The longest failure reason stored (0070's CHECK). */
export const REASON_STORED_MAX = 140;

export interface DeployRef { env: string; key: string; provider: string }

/**
 * A deploy's state only moves FORWARD: queued (0) < building (1) < a terminal state (2: ready, error, canceled).
 * Signals arrive out of order — a poll and a webhook, a redelivery, a late `queued` status after `success` — so a
 * signal of a LOWER rank than the stored state is ignored (its other fields still fold in), and a terminal deploy
 * never goes back to queued or building. One terminal state may replace another (the provider's later word).
 */
export const DEPLOY_STATE_RANK: Readonly<Record<DeployState, number>> = { queued: 0, building: 1, ready: 2, error: 2, canceled: 2 };
const rankSql = (col: string): string => `(CASE ${col} WHEN 'queued' THEN 0 WHEN 'building' THEN 1 ELSE 2 END)`;
/** The state a write may set: the signal's when it does not rank below the stored one. */
const MAY_MOVE = `${rankSql("excluded.state")} >= ${rankSql("hosting_deploys.state")}`;

export interface DeployWrites {
  /** The deploys that were new or changed. */
  changed: string[];
  /** The deploys this write made ready, or whose commit it changed while ready — what the rollback check is for.
   *  A ready deploy re-reported (a URL, a message) is not in it, so the check runs once per deploy and commit. */
  readyChanged: string[];
}

/**
 * ONE batch of upserts, keyed `(org_id, env, part, provider, deploy_id)`. A deploy's state moves (building →
 * ready), so a row is UPDATED — but only when something actually changed (the `WHERE`), so a re-poll of a
 * settled deploy writes nothing and `meta.changes` counts new OR changed rows only. The state never moves
 * backwards (`DEPLOY_STATE_RANK`). A later poll that no longer reports a field (a message, a URL, a reason)
 * never erases one already known (`COALESCE`); the creation instant and the first `recorded_at` are kept, and `ready_at` moves only with the state. A sha
 * the source reports is `sha_source = 'provider'` — it replaces a JOINED one (src/hosting/sha-join.ts), never
 * the other way round. ≤ 50 statements — one D1 batch, one transaction.
 */
export async function upsertDeployWrites(
  ctx: TenantContext, part: DeployRef, deploys: readonly CleanDeploy[], now: number, source: "provider" | "github" = "provider",
): Promise<DeployWrites> {
  if (!deploys.length) return { changed: [], readyChanged: [] };
  const at = iso(now);
  // What the rows were before this write — only to tell which deploys this write made ready (`readyChanged`).
  const before = new Map((await all<{ deploy_id: string; state: DeployState; sha: string | null }>(ctx,
    `SELECT deploy_id, state, sha FROM hosting_deploys WHERE org_id = ? AND env = ? AND part = ? AND provider = ?
        AND deploy_id IN (${deploys.map(() => "?").join(", ")})`,
    ctx.orgId, part.env, part.key, part.provider, ...deploys.map((d) => d.id))).map((r) => [r.deploy_id, r]));
  const stmts: Stmt[] = deploys.map((d) => stmt(ctx,
    `INSERT INTO hosting_deploys (org_id, env, part, provider, deploy_id, state, target, sha, branch, message, actor, url, inspect_url,
                                  created_at, ready_at, recorded_at, updated_at, source, reason, sha_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, env, part, provider, deploy_id) DO UPDATE SET
       state = CASE WHEN ${MAY_MOVE} THEN excluded.state ELSE hosting_deploys.state END,
       target = COALESCE(excluded.target, hosting_deploys.target),
       sha = COALESCE(excluded.sha, hosting_deploys.sha),
       sha_source = CASE WHEN excluded.sha IS NOT NULL THEN 'provider' ELSE hosting_deploys.sha_source END,
       branch = COALESCE(excluded.branch, hosting_deploys.branch),
       message = COALESCE(excluded.message, hosting_deploys.message),
       actor = COALESCE(excluded.actor, hosting_deploys.actor),
       url = COALESCE(excluded.url, hosting_deploys.url),
       inspect_url = COALESCE(excluded.inspect_url, hosting_deploys.inspect_url),
       ready_at = CASE WHEN ${MAY_MOVE} THEN COALESCE(excluded.ready_at, hosting_deploys.ready_at) ELSE hosting_deploys.ready_at END,
       reason = COALESCE(excluded.reason, hosting_deploys.reason),
       updated_at = excluded.updated_at
     WHERE (${MAY_MOVE} AND hosting_deploys.state IS NOT excluded.state)
        OR (excluded.target IS NOT NULL AND hosting_deploys.target IS NOT excluded.target)
        OR (excluded.sha IS NOT NULL AND (hosting_deploys.sha IS NOT excluded.sha OR hosting_deploys.sha_source IS NOT 'provider'))
        OR (excluded.branch IS NOT NULL AND hosting_deploys.branch IS NOT excluded.branch)
        OR (excluded.message IS NOT NULL AND hosting_deploys.message IS NOT excluded.message)
        OR (excluded.actor IS NOT NULL AND hosting_deploys.actor IS NOT excluded.actor)
        OR (excluded.url IS NOT NULL AND hosting_deploys.url IS NOT excluded.url)
        OR (excluded.inspect_url IS NOT NULL AND hosting_deploys.inspect_url IS NOT excluded.inspect_url)
        OR (${MAY_MOVE} AND excluded.ready_at IS NOT NULL AND hosting_deploys.ready_at IS NOT excluded.ready_at)
        OR (excluded.reason IS NOT NULL AND hosting_deploys.reason IS NOT excluded.reason)`,
    ctx.orgId, part.env, part.key, part.provider, d.id, d.state, d.target, d.sha, d.branch, d.message, d.by, d.url, d.inspectUrl,
    d.createdAt, d.readyAt, at, at, source, d.reason ? d.reason.slice(0, REASON_STORED_MAX) : null, d.sha ? "provider" : null));
  const changed: string[] = [];
  const readyChanged: string[] = [];
  const results = await batch(ctx, stmts);
  results.forEach((res, i) => {
    if (!(res.meta.changes > 0)) return;
    const d = deploys[i];
    changed.push(d.id);
    const was = before.get(d.id);
    const state = was && DEPLOY_STATE_RANK[d.state] < DEPLOY_STATE_RANK[was.state] ? was.state : d.state;
    if (state === "ready" && (!was || was.state !== "ready" || (d.sha !== null && d.sha !== was.sha))) readyChanged.push(d.id);
  });
  return { changed, readyChanged };
}

/** `upsertDeployWrites`, for a caller that needs only the ids of the deploys that were new or changed. */
export async function upsertDeploys(
  ctx: TenantContext, part: DeployRef, deploys: readonly CleanDeploy[], now: number, source: "provider" | "github" = "provider",
): Promise<string[]> {
  return (await upsertDeployWrites(ctx, part, deploys, now, source)).changed;
}
