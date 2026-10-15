// The Repo Overview's facts (repo setups, Phase B) — the D1 side: the deploy read the facts assemble parts and
// previews from, the week's deploy counts, the serving commit of every part (what the reconcile's facts arms
// compare against), and the shapes of the three snapshots those arms store (`not_shipped`, `out_of_step`,
// `drift_chain`). Tenant statements only — nothing here fetches or reads a secret.
import type { FactsCommitGroup, FactsDriftStep, FactsOutOfStep } from "@shared/repo-facts-core";
import { all, type TenantContext } from "../data/sql";

/** A production part's PREVIEWS are its `target = 'preview'` rows; a part that has ONLY preview rows (a staging
 *  environment that is the previews of main) reads them as its deploys — the rule `hostingReads` (./store.ts)
 *  keeps. `target IS NULL` (a GitHub-sourced deploy, a Netlify deploy with no context) is never a preview. */
const IS_PREVIEW_OF_PRODUCTION = (alias: string, orgParam = "?") => `(${alias}.target = 'preview' AND EXISTS (
    SELECT 1 FROM hosting_deploys h2 WHERE h2.org_id = ${orgParam} AND h2.env = ${alias}.env AND h2.part = ${alias}.part
      AND h2.provider = ${alias}.provider AND (h2.target IS NULL OR h2.target <> 'preview')))`;

const COLS = (a: string) => `${a}.env, ${a}.part, ${a}.provider, ${a}.deploy_id AS id, ${a}.state, ${a}.target, ${a}.sha, ${a}.sha_source,
  ${a}.branch, ${a}.message, ${a}.actor AS by_login, ${a}.created_at AS at, ${a}.ready_at, ${a}.url, ${a}.inspect_url, ${a}.reason,
  ${a}.rolled_back_from, ${a}.source, ${a}.recorded_at`;

export interface FactsDeployRow {
  src: "prod" | "serving" | "preview";
  env: string; part: string; provider: string;
  id: string; state: string; target: string | null; sha: string | null; sha_source: string | null; branch: string | null;
  message: string | null; by_login: string | null; at: string; ready_at: string | null; url: string | null; inspect_url: string | null;
  reason: string | null; rolled_back_from: string | null; source: string; recorded_at: string;
}

/** How many of a part's newest production deploys the facts read: the 20 settled the history keeps, plus room
 *  for in-flight ones ahead of them. */
export const FACTS_DEPLOYS_PER_PART = 25;
/** A preview branch's newest deploys read — enough for its fail streak. */
export const FACTS_PREVIEWS_PER_BRANCH = 20;

/**
 * ONE statement, three arms, every (env, part, provider) of the org — the caller keeps the CURRENT provider's:
 *   prod     the newest `FACTS_DEPLOYS_PER_PART` production deploys (any age — `hosting_deploys` is pruned at 180 days);
 *   serving  the newest `ready` production deploy, however old (it may lie past the 25);
 *   preview  a production part's preview deploys created at or after `previewSinceIso`, the newest
 *            `FACTS_PREVIEWS_PER_BRANCH` per branch.
 * Newest first within each arm.
 */
export async function factsDeploys(ctx: TenantContext, previewSinceIso: string): Promise<FactsDeployRow[]> {
  return all<FactsDeployRow>(ctx,
    `SELECT 'prod' AS src, * FROM (
       SELECT ${COLS("h")}, ROW_NUMBER() OVER (PARTITION BY h.env, h.part, h.provider ORDER BY h.created_at DESC, h.id DESC) AS rn
         FROM hosting_deploys h WHERE h.org_id = ? AND NOT COALESCE(${IS_PREVIEW_OF_PRODUCTION("h")}, 0)
     ) WHERE rn <= ?
     UNION ALL
     SELECT 'serving', * FROM (
       SELECT ${COLS("s")}, ROW_NUMBER() OVER (PARTITION BY s.env, s.part, s.provider ORDER BY s.created_at DESC, s.id DESC) AS rn
         FROM hosting_deploys s WHERE s.org_id = ? AND s.state = 'ready' AND NOT COALESCE(${IS_PREVIEW_OF_PRODUCTION("s")}, 0)
     ) WHERE rn = 1
     UNION ALL
     SELECT 'preview', * FROM (
       SELECT ${COLS("p")}, ROW_NUMBER() OVER (PARTITION BY p.env, p.part, p.provider, p.branch ORDER BY p.created_at DESC, p.id DESC) AS rn
         FROM hosting_deploys p WHERE p.org_id = ? AND p.created_at >= ? AND p.branch IS NOT NULL AND ${IS_PREVIEW_OF_PRODUCTION("p")}
     ) WHERE rn <= ?
     ORDER BY at DESC`,
    ctx.orgId, ctx.orgId, FACTS_DEPLOYS_PER_PART, ctx.orgId, ctx.orgId, ctx.orgId, previewSinceIso, ctx.orgId, FACTS_PREVIEWS_PER_BRANCH);
}

/** The week's production deploys per (env, part, provider): settled ones created in each of the last two weeks,
 *  and when deploy capture of the part BEGAN (`MIN(recorded_at)` — a poll lists a host's recent deploys, so a
 *  row's own `created_at` can predate capture). ONE statement. */
export interface DeployWeekRow { env: string; part: string; provider: string; this_ready: number; this_error: number; last_ready: number; last_error: number; since: string | null }
export async function deployWeekCounts(ctx: TenantContext, weekAgoIso: string, twoWeeksAgoIso: string): Promise<DeployWeekRow[]> {
  return all<DeployWeekRow>(ctx,
    `SELECT h.env, h.part, h.provider,
            SUM(CASE WHEN h.created_at > ? AND h.state = 'ready' THEN 1 ELSE 0 END) AS this_ready,
            SUM(CASE WHEN h.created_at > ? AND h.state = 'error' THEN 1 ELSE 0 END) AS this_error,
            SUM(CASE WHEN h.created_at > ? AND h.created_at <= ? AND h.state = 'ready' THEN 1 ELSE 0 END) AS last_ready,
            SUM(CASE WHEN h.created_at > ? AND h.created_at <= ? AND h.state = 'error' THEN 1 ELSE 0 END) AS last_error,
            MIN(h.recorded_at) AS since
       FROM hosting_deploys h WHERE h.org_id = ? AND NOT COALESCE(${IS_PREVIEW_OF_PRODUCTION("h")}, 0)
      GROUP BY h.env, h.part, h.provider`,
    weekAgoIso, weekAgoIso, twoWeeksAgoIso, weekAgoIso, twoWeeksAgoIso, weekAgoIso, ctx.orgId, ctx.orgId);
}

/** Every part's serving commit — its newest `ready` production deploy with a sha, of the part's CURRENT provider
 *  (the caller matches the provider). What the facts arms compare against. ONE statement. */
export interface ServingRow { env: string; part: string; provider: string; sha: string | null; at: string }
export async function servingShas(ctx: TenantContext): Promise<ServingRow[]> {
  return all<ServingRow>(ctx,
    `SELECT env, part, provider, sha, at FROM (
       SELECT s.env, s.part, s.provider, s.sha, COALESCE(s.ready_at, s.created_at) AS at,
              ROW_NUMBER() OVER (PARTITION BY s.env, s.part, s.provider ORDER BY s.created_at DESC, s.id DESC) AS rn
         FROM hosting_deploys s WHERE s.org_id = ? AND s.state = 'ready' AND NOT COALESCE(${IS_PREVIEW_OF_PRODUCTION("s")}, 0)
     ) WHERE rn = 1`, ctx.orgId, ctx.orgId);
}

// ── the snapshots the reconcile's facts arms store (repo_snapshots kinds) ────

/** `not_shipped`: per part (`<env>/<app>`), what its environment's branch has that its serving commit lacks. */
export interface NotShippedEntry {
  env: string; app: string;
  /** The serving sha the compare started from — the read uses the entry only while the part still serves it. */
  servingSha: string;
  branch: string;
  /** The branch head when it was computed (from `branchHeads`), or null when none was known. */
  head: string | null;
  count: number | null;
  oldestAt: string | null;
  groups: FactsCommitGroup[];
  computedAt: string;
  /** Phase E: the full shas of the kept commits whose paths were UNKNOWN (in a repository with two or more apps) —
   *  the arm computes the part again, at no GitHub cost to find out, once one of them has paths. Absent = none. */
  unknown?: string[];
}
export interface NotShippedSnapshot { parts: Record<string, NotShippedEntry> }
export const notShippedKey = (env: string, app: string): string => `${env}/${app}`;

/** `out_of_step`: per environment, the serving shas it was computed for (by app) and the rows. */
export interface OutOfStepEntry { shas: Record<string, string>; rows: FactsOutOfStep[]; computedAt: string }
export interface OutOfStepSnapshot { envs: Record<string, OutOfStepEntry> }

/** `drift_chain`: one step per ADJACENT pair of environments whose branches differ, in promotion order. */
export interface DriftChainSnapshot { steps: FactsDriftStep[] }
