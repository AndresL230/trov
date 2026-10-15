// Cron gating (canopy-email.md §4). The two triggers are static UTC hourly
// expressions in wrangler.toml; the schedule itself (send_hour + timezone)
// lives in notification_settings and is read at fire time. A trigger "is due"
// only when the org-local hour equals send_hour on the right weekday.
//
// The cron runs for EVERY active org (canopy-multitenancy.md §8.4): each on its own
// send_hour + timezone, with its own policy, members and content. A person in two
// orgs gets one digest per org; the unsubscribe is global (one click stops all mail).
import { orgAppBase } from "../tools/org-links";
import type { RunCadence } from "@shared/notifications";
import type { NotificationSettingsRow } from "@shared/rows";
import { type TenantContext, first } from "../data/sql";
import type { Env } from "../env";
import { platform, systemTenant, type PlatformContext } from "../data/context";
import { listActiveOrgIds } from "../platform/jobs";
import { ensureNotificationPolicySeeded } from "./policy";
import { computeWindow, localDate } from "./window";
import { weekScopeKey } from "@shared/ai-core";
import { loadPolicies } from "./resolve";
import { digestRecipients, runDigest, type RunReport } from "./run";
import { routeAi } from "../tools/ai-route";
import { retryFailed, type RetryReport } from "./retry";
import { PLATFORM_FROM, deliveryFor } from "./resend";
import { unsubscribeUrl } from "./unsubscribe";

export const DAILY_CRON = "0 * * * *";     // hourly, every day — gated to Mon–Fri local
export const WEEKLY_CRON = "0 * * * SUN,MON";  // hourly Sun+Mon UTC — gated to Monday local

/** What an org with no settings row runs on. */
export const DEFAULT_SETTINGS: Omit<NotificationSettingsRow, "org_id"> = {
  send_hour: 8, timezone: "America/New_York", from_address: PLATFORM_FROM,
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

export interface OrgNotificationReport { run: RunReport | null; retry: RetryReport | null }

/**
 * ONE org's share of a notification trigger: the due cadence (if any, by THIS org's settings), then —
 * on the hourly daily trigger — the retry job for its failed rows. Seeds the org's policy rows for
 * any registry kind it has none for yet (memoized per isolate; never overwrites).
 */
export async function runOrgNotifications(env: Env, ctx: TenantContext, p: PlatformContext, cron: string, now: Date): Promise<OrgNotificationReport> {
  await ensureNotificationPolicySeeded(ctx).catch(() => undefined);
  const settings = await loadSettings(ctx);
  const origin = env.PUBLIC_ORIGIN ?? "";
  const cadence = dueCadence(cron, now, settings);
  const opts = {
    delivery: deliveryFor(ctx, env, { from: settings.from_address }),
    origin,
    appBase: origin ? await orgAppBase(ctx, origin) : undefined,
    unsubscribeUrl: (login: string) => unsubscribeUrl(origin, login, env.COOKIE_SECRET),
  };
  const run = cadence ? await runDigest(ctx, p, cadence, now, opts) : null;
  const retry = cron === DAILY_CRON ? await retryFailed(ctx, p, opts) : null;
  return { run, retry };
}

/** How far ahead the pre-warm looks: one repo tick. */
export const PREWARM_AHEAD_MS = 10 * 60_000;
/** How long before an org's WEEKLY send its "This week" is marked (Phase E): the Batch API answers on a later tick,
 *  usually within the hour; three hours leaves room. A week whose answer is not back by the send has no highlights. */
export const WEEK_HIGHLIGHTS_LEAD_MS = 3 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

/**
 * THE BRIEF PRE-WARM (docs/architecture/ai.md › The router; notifications.md): run by the repo tick ONE TICK BEFORE
 * the hour (`:50`, src/repo/cron.ts), before the AI pass. For every active org whose digest (daily or weekly) is due
 * at the coming hour by ITS settings, each recipient's `person:<handle>` scope is marked URGENT — it skips the
 * debounce, so the pass that follows writes the brief the digest leads with. Rows only (the router); no model, no
 * mail. Returns how many people were marked. One org's failure is logged with its id and never stops the next.
 */
export async function prewarmDigests(env: Env, now: Date): Promise<number> {
  const p = platform(env, "system");
  const soon = new Date(now.getTime() + PREWARM_AHEAD_MS);
  // The weekly send WEEK_HIGHLIGHTS_LEAD_MS after the coming hour: its "This week" is marked now (one scope per org per
  // week), so the AI pass submits it on this tick and collects it before the send.
  const weekSoon = new Date(soon.getTime() + WEEK_HIGHLIGHTS_LEAD_MS);
  let marked = 0;
  for (const orgId of await listActiveOrgIds(p)) {
    try {
      const ctx = systemTenant(p, orgId, "system");
      const settings = await loadSettings(ctx);
      if (dueCadence(WEEKLY_CRON, weekSoon, settings) && (await weekRecapOn(ctx)) && (await digestRecipients(p, orgId)).length) {
        const sendAt = new Date(Math.floor(weekSoon.getTime() / HOUR_MS) * HOUR_MS);
        await routeAi(ctx, { type: "digest_week", key: weekScopeKey(computeWindow("weekly", sendAt, settings.timezone).id, sendAt) });
      }
      if (!dueCadence(DAILY_CRON, soon, settings) && !dueCadence(WEEKLY_CRON, soon, settings)) continue;
      for (const handle of await digestRecipients(p, orgId)) {
        await routeAi(ctx, { type: "digest_prewarm", handle });
        marked++;
      }
    } catch (e) {
      console.error("digest prewarm", e instanceof Error ? e.name : "error", `org=${orgId}`);
    }
  }
  return marked;
}

/** Is the org's "This week" kind on (its policy row, or the registry default when it has none yet)? */
async function weekRecapOn(ctx: TenantContext): Promise<boolean> {
  const policy = (await loadPolicies(ctx)).get("week_recap");
  return !policy || (policy.enabled === 1 && policy.default_cadence !== "off");
}

/**
 * Entry point for the two notification triggers:`runOrgNotifications` for every active
 * (non-suspended) org, in id order, each in its own guarded arm — one org's failure (a bad timezone, a
 * renderer that throws, Resend refusing) is logged with its org id and never stops the next. The
 * outbox key carries the org, so a re-fired trigger is harmless per org. Returns each org's report by id.
 */
export async function handleNotificationCron(env: Env, cron: string, now: Date): Promise<Record<string, OrgNotificationReport>> {
  const p = platform(env, "system");
  const reports: Record<string, OrgNotificationReport> = {};
  for (const orgId of await listActiveOrgIds(p)) {
    try {
      reports[orgId] = await runOrgNotifications(env, systemTenant(p, orgId, "system"), p, cron, now);
    } catch (e) {
      console.error("notification cron", e instanceof Error ? e.message : String(e), `org=${orgId}`);
    }
  }
  return reports;
}
