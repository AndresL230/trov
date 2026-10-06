// TRANSITIONAL — Multitenancy Phase 3 scaffolding, the mirror image of `legacyDb` (./legacy.ts).
import type { Env } from "../env";
import type { TenantContext } from "./context";
import { legacySystemTenant } from "./legacy";

/**
 * DELETE AT THE END OF PHASE 3. For a module that is NOT ported yet (it still holds a `db: DB`) and
 * calls one that is: a system context on the legacy org over that handle. Porting the caller turns
 * each `fn(legacyCtx(db), …)` into `fn(ctx, …)`; when `grep -rn legacyCtx src` is empty, this goes.
 */
export const legacyCtx = (db: D1Database): TenantContext => legacySystemTenant({ DB: db } as Env, "system");
