// The retry job (canopy-email.md §4): re-attempts `failed` outbox rows, and
// `pending` rows whose claim (or latest attempt, `attempted_at`) is older than
// PENDING_LEASE_MINUTES — a run that died before it recorded an outcome (the
// Worker was killed mid-send). A row is
// re-rendered for its original window (recomputed from the cadence and the
// row's created_at) over the kinds it was claimed with, then sent; sent /
// skipped rows and a pending row still inside its lease are never touched.
// Bounded to rows younger than RETRY_MAX_AGE so a permanently failing row does
// not retry forever. A send that actually reached the provider before the row
// died is not sent twice: the row's idempotency key goes to Resend as its
// `Idempotency-Key` (resend.ts).
import type { NotificationOutboxRow } from "@shared/rows";
import { type TenantContext, all, nowIso, run } from "../data/sql";
import { type PlatformContext, first as platformFirst } from "../data/platform-sql";
import { getKind } from "./registry";
import { computeWindow } from "./window";
import { deliverRow, type DeliverOptions } from "./run";
import { loadSettings } from "./cron";
import { loadOnlyWhenNeeded } from "./resolve";

const RETRY_LIMIT = 20;
const RETRY_MAX_AGE_HOURS = 48;
/** A `pending` row older than this is a dead claim. A scheduled run lives at most 15 minutes; twice that is safe. */
export const PENDING_LEASE_MINUTES = 30;

export interface RetryReport { retried: number; sent: number; skipped: number; failed: number; }

interface Recipient { github_login: string; email: string | null; email_unsubscribed: number; }

export async function retryFailed(ctx: TenantContext, p: PlatformContext, opts: DeliverOptions): Promise<RetryReport> {
  const report: RetryReport = { retried: 0, sent: 0, skipped: 0, failed: 0 };
  const settings = await loadSettings(ctx);
  const rows = await all<NotificationOutboxRow>(
    ctx,
    `SELECT * FROM notification_outbox
      WHERE org_id = ? AND datetime(created_at) >= datetime('now', ?)
        AND (status = 'failed' OR (status = 'pending' AND datetime(COALESCE(attempted_at, created_at)) < datetime('now', ?)))
      ORDER BY created_at DESC LIMIT ${RETRY_LIMIT}`,
    ctx.orgId,
    `-${RETRY_MAX_AGE_HOURS} hours`,
    `-${PENDING_LEASE_MINUTES} minutes`
  );
  for (const row of rows) {
    // Eligibility is re-checked: an unsubscribe, a cleared address or a lost
    // membership since the original run is a hard gate here too.
    const who = await platformFirst<Recipient>(
      p,
      `SELECT p.handle AS github_login, p.email, p.email_unsubscribed
         FROM persons p JOIN memberships m ON p.handle = m.user_id AND m.org_id = ?
        WHERE p.handle = ?`,
      ctx.orgId,
      row.user_id
    );
    if (!who || !who.email || who.email_unsubscribed !== 0) continue;
    // Take the row — a compare-and-set on what was read: failed → pending, or a dead pending claim re-leased — and stamp
    // the attempt (`attempted_at`, 0088), so a second retry running beside this one skips it, and so the lease counts
    // from THIS attempt: if it dies too, the next retry past the lease finds the row again.
    const took = await run(ctx,
      `UPDATE notification_outbox SET status = 'pending', attempted_at = ?
        WHERE idempotency_key = ? AND org_id = ? AND status = ? AND attempted_at IS ?`,
      nowIso(), row.idempotency_key, ctx.orgId, row.status, row.attempted_at ?? null);
    if ((took.meta.changes ?? 0) === 0) continue;
    report.retried++;
    const window = computeWindow(row.cadence, new Date(row.created_at), settings.timezone);
    const kinds = (JSON.parse(row.kinds) as string[]).map(getKind).filter((k): k is NonNullable<typeof k> => !!k);
    const onlyWhenNeeded = await loadOnlyWhenNeeded(ctx, who.github_login);
    const outcome = await deliverRow(ctx, { key: row.idempotency_key, login: who.github_login, email: who.email, kinds, window, timeZone: settings.timezone, onlyWhenNeeded }, opts);
    report[outcome]++;
  }
  return report;
}
