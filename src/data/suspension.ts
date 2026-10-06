// Is this org suspended? (0043, canopy-multitenancy.md §5.4.) Asked by every tenant resolver — the two
// gates in ./gate.ts and the bearer resolver in ./bearer.ts — AFTER the membership check, so a
// suspended org answers exactly like one the caller is not in. A primary-key read.
import { first, type PlatformContext } from "./platform-sql";

export async function orgSuspended(p: PlatformContext, orgId: string): Promise<boolean> {
  const row = await first<{ suspended_at: string | null }>(p, `SELECT suspended_at FROM orgs WHERE id = ?`, orgId);
  return !row || row.suspended_at !== null;
}
