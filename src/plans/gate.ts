// The plan gate on the TENANT surface (docs/architecture/plans.md): the limits counted over an org's
// own tables — repositories, environments, stored artifact bytes, a person's agent connections — and
// the Plan block every member reads. Seats (platform-owned tables) are in ./state.ts.
//
// ONE entry point for a write path: `requirePlan(ctx, limit, adding)`. It reads the org's plan and its
// current use and throws `PlanLimitError` when shared/plans.ts `planRefusal` says no.
import { type TenantContext, first } from "../data/sql";
import { LIMIT_KEYS, overLimits, planDef, resolveEntitlements, type LimitKey, type OrgPlanView } from "@shared/plans";
import { PLAN_COLS, assertWithinPlan, planOf, type OrgPlan, type OrgPlanRow } from "./state";

/** The limits this file counts (everything but seats). */
export type TenantLimit = Exclude<LimitKey, "seats">;

/** The org's plan, read through the caller's context (`orgs` is global: the row is the context's own org). */
export async function planFor(ctx: TenantContext): Promise<OrgPlan> {
  return planOf(await first<OrgPlanRow>(ctx, `SELECT ${PLAN_COLS} FROM orgs WHERE id = ?`, ctx.orgId));
}

// What counts toward each limit — the ONE definition (plans.md repeats it in words).
const count = async (ctx: TenantContext, sql: string, ...params: unknown[]): Promise<number> => (await first<{ n: number }>(ctx, sql, ...params))?.n ?? 0;
const USE: Record<TenantLimit, (ctx: TenantContext) => Promise<number>> = {
  repositories: (ctx) => count(ctx, `SELECT COUNT(*) AS n FROM org_repos WHERE org_id = ?`, ctx.orgId),
  environments: (ctx) => count(ctx, `SELECT COUNT(*) AS n FROM org_environments WHERE org_id = ?`, ctx.orgId),
  // Every stored version of every page, deleted pages included (their bytes are still held).
  artifact_bytes: (ctx) => count(ctx, `SELECT COALESCE(SUM(size_bytes), 0) AS n FROM artifact_versions WHERE org_id = ?`, ctx.orgId),
  // PER PERSON: the caller's own live MCP tokens and connected apps INTO this org.
  agent_connections: (ctx) => count(ctx,
    `SELECT (SELECT COUNT(*) FROM mcp_tokens WHERE org_id = ?1 AND person = ?2 COLLATE NOCASE AND revoked = 0)
          + (SELECT COUNT(*) FROM oauth_grants WHERE org_id = ?1 AND person = ?2 COLLATE NOCASE AND revoked_at IS NULL) AS n`, ctx.orgId, ctx.userId),
};

export const limitUse = (ctx: TenantContext, limit: TenantLimit): Promise<number> => USE[limit](ctx);

/**
 * THE enforcement call of a tenant write path: may `ctx`'s org add `adding` more of `limit` now?
 * Throws `PlanLimitError` (HTTP 402 / MCP `plan_limit`) when it may not. `adding` is 1 for a counted
 * thing and the byte size for `artifact_bytes`.
 */
export async function requirePlan(ctx: TenantContext, limit: TenantLimit, adding = 1): Promise<void> {
  const [state, used] = await Promise.all([planFor(ctx), limitUse(ctx, limit)]);
  assertWithinPlan(state, limit, used, adding);
}

/** `GET /api/o/:slug/plan` — any member: the plan, what it includes, and the org's use of each limit. */
export async function orgPlanView(ctx: TenantContext): Promise<OrgPlanView> {
  const [state, seats, repositories, environments, artifact_bytes, agent_connections] = await Promise.all([
    planFor(ctx),
    first<{ members: number; pending: number }>(ctx,
      `SELECT (SELECT COUNT(*) FROM memberships WHERE org_id = ?1) AS members,
              (SELECT COUNT(*) FROM org_invites WHERE org_id = ?1 AND status = 'pending') AS pending`, ctx.orgId),
    limitUse(ctx, "repositories"), limitUse(ctx, "environments"), limitUse(ctx, "artifact_bytes"), limitUse(ctx, "agent_connections"),
  ]);
  const def = planDef(state.plan);
  const entitlements = resolveEntitlements(state.plan, state.overrides);
  const split = { members: seats?.members ?? 0, pending: seats?.pending ?? 0 };
  const usage = { seats: split.members + split.pending, repositories, environments, artifact_bytes, agent_connections };
  return {
    plan: def.id, name: def.name, description: def.description, status: state.status, source: state.source, period_end: state.period_end,
    entitlements, overridden: LIMIT_KEYS.filter((k) => k in state.overrides), usage, seats: split, over: overLimits(entitlements, usage),
  };
}
