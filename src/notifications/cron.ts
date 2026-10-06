// Cron gating (canopy-email.md §4). The two triggers are static UTC hourly
// expressions in wrangler.toml; the schedule itself (send_hour + timezone)
// lives in notification_settings and is read at fire time. A trigger "is due"
// only when the org-local hour equals send_hour on the right weekday.
import type { RunCadence } from "@shared/notifications";
import type { NotificationSettingsRow } from "@shared/rows";
import { type DB, first } from "../db";
import type { Env } from "../env";
import { localDate } from "./window";
import { runDigest, type RunReport } from "./run";
import { retryFailed, type RetryReport } from "./retry";
import { deliveryFor } from "./resend";
import { unsubscribeUrl } from "./unsubscribe";
import { LEGACY_ORG_ID } from "../legacy-org";

export const DAILY_CRON = "0 * * * *";     // hourly, every day — gated to Mon–Fri local
export const WEEKLY_CRON = "0 * * * SUN,MON";  // hourly Sun+Mon UTC — gated to Monday local

export const DEFAULT_SETTINGS: NotificationSettingsRow = {
  org_id: LEGACY_ORG_ID, send_hour: 8, timezone: "America/New_York", from_address: "Trov <canopy@canopy.saplinglearn.com>",
};

export function dueCadence(cron: string, now: Date, settings: Pick<NotificationSettingsRow, "send_hour" | "timezone">): RunCadence | null {
  const local = localDate(now, settings.timezone);
  if (local.hour !== settings.send_hour) return null;
  if (cron === DAILY_CRON && local.weekday >= 1 && local.weekday <= 5) return "daily";
  if (cron === WEEKLY_CRON && local.weekday === 1) return "weekly";
  return null;
}

export async function loadSettings(db: DB): Promise<NotificationSettingsRow> {
  return (await first<NotificationSettingsRow>(db, `SELECT * FROM notification_settings WHERE org_id = ?`, LEGACY_ORG_ID)) ?? DEFAULT_SETTINGS;
}

/**
 * Entry point for the two notification triggers. Runs the due cadence (if
 * any), then — on the hourly daily trigger — the retry job for failed rows.
 */
export async function handleNotificationCron(env: Env, cron: string, now: Date): Promise<{ run: RunReport | null; retry: RetryReport | null }> {
  const settings = await loadSettings(env.DB);
  const origin = env.PUBLIC_ORIGIN ?? "";
  const cadence = dueCadence(cron, now, settings);
  const opts = {
    delivery: deliveryFor(env, { from: settings.from_address }),
    origin,
    unsubscribeUrl: (login: string) => unsubscribeUrl(origin, login, env.COOKIE_SECRET),
  };
  const run = cadence ? await runDigest(env.DB, cadence, now, opts) : null;
  const retry = cron === DAILY_CRON ? await retryFailed(env.DB, opts) : null;
  return { run, retry };
}
