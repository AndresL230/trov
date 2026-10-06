// TRANSITIONAL — Multitenancy Phase 3 scaffolding, deleted with src/data/legacy.ts.
import type { Env } from "../env";
import type { TenantContext } from "./context";
import { legacySystemTenant } from "./legacy";

/**
 * DELETE AT THE END OF PHASE 3. `legacyDb`'s mirror image: an UNPORTED module (still `db: DB`) that
 * calls a PORTED one has no context to hand over, so it passes `legacyCtxOf(db)` — a system context
 * on the legacy org, which is what that caller read and wrote before. Porting the caller turns each
 * `fn(legacyCtxOf(db), …)` into `fn(ctx, …)`; when `grep -rn legacyCtxOf src` is empty, this goes.
 */
export const legacyCtxOf = (db: D1Database): TenantContext => legacySystemTenant({ DB: db } as Env, "system");
