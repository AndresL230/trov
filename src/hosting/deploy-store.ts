// `hosting_deploys` WRITES, shared by the two writers of a deploy: the hosting poll (./poll.ts — a provider's
// deploys, `source = 'provider'`) and the GitHub capture (./github-deploys.ts — a `github` part's deploys,
// `source = 'github'`). Computed, direct writes (invariant 1): no gate, no author.
//
// This module reads no secret and imports nothing that does, so the webhook's capture (src/webhook.ts, which
// is reachable from src/mcp.ts) may call it.
import type { DeployState, DeployTarget } from "@shared/hosting";
import { batch, stmt, type Stmt, type TenantContext } from "../data/sql";
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
 * ONE batch of upserts, keyed `(org_id, env, part, provider, deploy_id)`. A deploy's state moves (building →
 * ready), so a row is UPDATED — but only when something actually changed (the `WHERE`), so a re-poll of a
 * settled deploy writes nothing and `meta.changes` counts new OR changed rows only. A later poll that no
 * longer reports a field (a message, a URL, a reason) never erases one already known (`COALESCE`); the
 * creation instant and the first `recorded_at` are kept. A sha the source reports is `sha_source =
 * 'provider'` — it replaces a JOINED one (src/hosting/sha-join.ts), never the other way round.
 * Returns the ids of the rows that were new or changed. ≤ 50 statements — one D1 batch, one transaction.
 */
export async function upsertDeploys(
  ctx: TenantContext, part: DeployRef, deploys: readonly CleanDeploy[], now: number, source: "provider" | "github" = "provider",
): Promise<string[]> {
  if (!deploys.length) return [];
  const at = iso(now);
  const stmts: Stmt[] = deploys.map((d) => stmt(ctx,
    `INSERT INTO hosting_deploys (org_id, env, part, provider, deploy_id, state, target, sha, branch, message, actor, url, inspect_url,
                                  created_at, ready_at, recorded_at, updated_at, source, reason, sha_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, env, part, provider, deploy_id) DO UPDATE SET
       state = excluded.state,
       target = COALESCE(excluded.target, hosting_deploys.target),
       sha = COALESCE(excluded.sha, hosting_deploys.sha),
       sha_source = CASE WHEN excluded.sha IS NOT NULL THEN 'provider' ELSE hosting_deploys.sha_source END,
       branch = COALESCE(excluded.branch, hosting_deploys.branch),
       message = COALESCE(excluded.message, hosting_deploys.message),
       actor = COALESCE(excluded.actor, hosting_deploys.actor),
       url = COALESCE(excluded.url, hosting_deploys.url),
       inspect_url = COALESCE(excluded.inspect_url, hosting_deploys.inspect_url),
       ready_at = COALESCE(excluded.ready_at, hosting_deploys.ready_at),
       reason = COALESCE(excluded.reason, hosting_deploys.reason),
       updated_at = excluded.updated_at
     WHERE hosting_deploys.state IS NOT excluded.state
        OR (excluded.target IS NOT NULL AND hosting_deploys.target IS NOT excluded.target)
        OR (excluded.sha IS NOT NULL AND (hosting_deploys.sha IS NOT excluded.sha OR hosting_deploys.sha_source IS NOT 'provider'))
        OR (excluded.branch IS NOT NULL AND hosting_deploys.branch IS NOT excluded.branch)
        OR (excluded.message IS NOT NULL AND hosting_deploys.message IS NOT excluded.message)
        OR (excluded.actor IS NOT NULL AND hosting_deploys.actor IS NOT excluded.actor)
        OR (excluded.url IS NOT NULL AND hosting_deploys.url IS NOT excluded.url)
        OR (excluded.inspect_url IS NOT NULL AND hosting_deploys.inspect_url IS NOT excluded.inspect_url)
        OR (excluded.ready_at IS NOT NULL AND hosting_deploys.ready_at IS NOT excluded.ready_at)
        OR (excluded.reason IS NOT NULL AND hosting_deploys.reason IS NOT excluded.reason)`,
    ctx.orgId, part.env, part.key, part.provider, d.id, d.state, d.target, d.sha, d.branch, d.message, d.by, d.url, d.inspectUrl,
    d.createdAt, d.readyAt, at, at, source, d.reason ? d.reason.slice(0, REASON_STORED_MAX) : null, d.sha ? "provider" : null));
  const changed: string[] = [];
  const results = await batch(ctx, stmts);
  results.forEach((res, i) => { if (res.meta.changes > 0) changed.push(deploys[i].id); });
  return changed;
}
