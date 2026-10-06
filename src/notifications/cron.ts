// Cron gating (canopy-email.md §4). The two triggers are static UTC hourly
// expressions in wrangler.toml; the schedule itself (send_hour + timezone)
// lives in notification_settings and is read at fire time. A trigger "is due"
// only when the org-local hour equals send_hour on the right weekday.
import type { RunCadence } from "@shared/notifications";
import type { NotificationSettingsRow } from "@shared/rows";
import { type TenantContext, first } from "../data/sql";
import type { Env } from "../env";
import { platform } from "../data/context";
import { legacySystemTenant } from "../data/legacy";
import { localDate } from "./window";
import { runDigest, type RunReport } from "./run";
import { retryFailed, type RetryReport } from "./retry";
import { deliveryFor } from "./resend";
import { unsubscribeUrl } from "./unsubscribe";

export const DAILY_CRON = "0 * * * *";     // hourly, every day — gated to Mon–Fri local
export const WEEKLY_CRON = "0 * * * SUN,MON";  // hourly Sun+Mon UTC — gated to Monday local

/** What an org with no settings row runs on. */
export const DEFAULT_SETTINGS: Omit<NotificationSettingsRow, "org_id"> = {
  send_hour: 8, timezone: "America/New_York", from_address: "Trov <hello@trov.dev>",
};

export function dueCadence(cron: string, now: Date, settings: Pick<NotificationSettingsRow, "send_hour" | "timezone">): RunCadence | null {
  const local = localDate(now, settings.timezone);
  if (local.hour !== settings.send_hour) return null;
  if (cron === DAILY_CRON && local.weekday >= 1 && local.weekday <= 5) return "daily";
  if (cron === WEEKLY_CRON && local.weekday === 1) return "weekly";
  return null;
}

export async function loadSettings(ctx: TenantContext): Promise<NotificationSettingsRow> {
  return (await first<NotificationSettingsRow>(ctx, `SELECT * FROM notification_settings WHERE org_id = ?`, ctx.orgId))
    ?? { org_id: ctx.orgId, ...DEFAULT_SETTINGS };
}

/**
 * Entry point for the two notification triggers. Runs the due cadence (if
 * any), then — on the hourly daily trigger — the retry job for failed rows.
 */
export async function handleNotificationCron(env: Env, cron: string, now: Date): Promise<{ run: RunReport | null; retry: RetryReport | null }> {
  // MT: one digest run, one org — the legacy org, as system. Phase 5b runs it per org, each on its own
  // send_hour + timezone (§8.4).
  const ctx = legacySystemTenant(env, "system");
  const p = platform(env, "system");
  const settings = await loadSettings(ctx);
  const origin = env.PUBLIC_ORIGIN ?? "";
  const cadence = dueCadence(cron, now, settings);
  const opts = {
    delivery: deliveryFor(ctx, env, { from: settings.from_address }),
    origin,
    unsubscribeUrl: (login: string) => unsubscribeUrl(origin, login, env.COOKIE_SECRET),
  };
  const run = cadence ? await runDigest(ctx, p, cadence, now, opts) : null;
  const retry = cron === DAILY_CRON ? await retryFailed(ctx, p, opts) : null;
  return { run, retry };
}
