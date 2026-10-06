// TRANSITIONAL — Multitenancy Phase 3 scaffolding. Nothing here outlives the cut-over.
import type { Env } from "../env";
import { LEGACY_ORG_ID } from "../legacy-org";
import { d1Of, platform, systemTenant, type PlatformContext, type SystemActor, type TenantContext } from "./context";
import { run } from "./platform-sql";
import { nowIso } from "../db";

/**
 * DELETE AT THE END OF PHASE 3. The escape hatch for a module that is not ported yet: it keeps its
 * `db: DB` signature and its caller passes `legacyDb(ctx)`. Porting a module turns each
 * `fn(legacyDb(ctx), …)` into `fn(ctx, …)`; when `grep -rn legacyDb src` is empty, this goes.
 */
export const legacyDb = (ctx: TenantContext | PlatformContext): D1Database => d1Of(ctx);

/**
 * The single org every org-less entry point acts on until it can name one: the GitHub webhook (Phase
 * 5b resolves the org from `org_repos`), the crons (5b enumerates `orgs` by rotation, §8.3), and the
 * token-authenticated artifact upload (the token row will carry its org). Each caller is marked `MT:`.
 */
export function legacySystemTenant(env: Env, actor: SystemActor): TenantContext {
  return systemTenant(platform(env, actor), LEGACY_ORG_ID, actor);
}

/**
 * A person onboarded during the cut-over joins the legacy org, as 0037 did for everyone before them:
 * until org invites exist (Phase 4), signing in IS joining SaplingLearn, and the alias resolver
 * (`resolveSoleTenant`) needs that one membership. Idempotent. Phase 4 deletes this.
 */
export async function joinLegacyOrg(p: PlatformContext, handle: string): Promise<void> {
  await run(p, `INSERT OR IGNORE INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, ?, 'member', ?, ?)`,
    LEGACY_ORG_ID, handle, nowIso(), handle);
}
