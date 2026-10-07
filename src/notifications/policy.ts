// notification_policy seeding (canopy-email.md §2): one row per registry kind,
// inserted only when missing, never overwritten — an admin's change to
// default_cadence / enabled outlives every deploy. The rows are per org.
import { type TenantContext, run, nowIso } from "../data/sql";
import { REGISTRY } from "./registry";

export async function seedNotificationPolicy(ctx: TenantContext): Promise<{ inserted: string[] }> {
  const now = nowIso();
  const inserted: string[] = [];
  for (const k of REGISTRY) {
    const res = await run(
      ctx,
      `INSERT OR IGNORE INTO notification_policy (org_id, kind, default_cadence, enabled, updated_at, updated_by)
       VALUES (?, ?, ?, 1, ?, 'registry')`,
      ctx.orgId,
      k.id,
      k.defaultCadence,
      now
    );
    if ((res.meta.changes ?? 0) > 0) inserted.push(k.id);
  }
  return { inserted };
}

// "Runs on startup": a Worker has no boot hook, so this is memoized per isolate
// and awaited from the entry points. One INSERT OR IGNORE per kind per org per
// isolate lifetime; a failure clears that org's memo so the next request retries.
const seeded = new Map<string, Promise<void>>();
export function ensureNotificationPolicySeeded(ctx: TenantContext): Promise<void> {
  let memo = seeded.get(ctx.orgId);
  if (!memo) {
    memo = seedNotificationPolicy(ctx)
      .then(() => undefined)
      .catch((e) => {
        seeded.delete(ctx.orgId);
        throw e;
      });
    seeded.set(ctx.orgId, memo);
  }
  return memo;
}
