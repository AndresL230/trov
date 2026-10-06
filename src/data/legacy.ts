// TRANSITIONAL — the cut-over entry points. The data layer itself is org-explicit (every statement
// binds `ctx.orgId`); what is left here is the ONE place that still names an org: the entry points
// that cannot resolve theirs yet. Each caller is marked `// MT:`; Phases 4 and 5b replace them.
import type { Env } from "../env";
import { platform, systemTenant, type PlatformContext, type SystemActor, type TenantContext } from "./context";
import { run, nowIso } from "./platform-sql";

/** Org #1 (0037): every pre-multitenancy row belongs to it, and so does every org-less entry point. */
export const SAPLINGLEARN_ORG_ID = "org_saplinglearn";

/**
 * The single org every org-less entry point acts on until it can name one: the GitHub webhook (Phase
 * 5b resolves the org from `org_repos`), the crons (5b enumerates `orgs` by rotation, §8.3), and the
 * token-authenticated artifact upload (the token row will carry its org). Each caller is marked `MT:`.
 */
export function legacySystemTenant(env: Env, actor: SystemActor): TenantContext {
  return systemTenant(platform(env, actor), SAPLINGLEARN_ORG_ID, actor);
}

/**
 * A person onboarded during the cut-over joins the legacy org, as 0037 did for everyone before them:
 * until org invites exist (Phase 4), signing in IS joining SaplingLearn, and the alias resolver
 * (`resolveSoleTenant`) needs that one membership. Idempotent. Phase 4 deletes this.
 */
export async function joinLegacyOrg(p: PlatformContext, handle: string): Promise<void> {
  await run(p, `INSERT OR IGNORE INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, ?, 'member', ?, ?)`,
    SAPLINGLEARN_ORG_ID, handle, nowIso(), handle);
}
