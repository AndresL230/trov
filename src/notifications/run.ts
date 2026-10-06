// The run assembler (canopy-email.md §4), for ONE org. Per eligible member: resolve every
// registry kind, keep the ones matching the run cadence, claim the outbox row
// FIRST (the idempotency key is the unique constraint — a conflict means this
// window already ran for them), render, drop nulls, then skip or send.
import type { NotificationKind, RunCadence, Section, Window } from "@shared/notifications";
import { type TenantContext, run, nowIso } from "../data/sql";
import { type PlatformContext, all as platformAll } from "../data/platform-sql";
import { REGISTRY } from "./registry";
import { loadPolicies, loadPrefs, resolveWith } from "./resolve";
import { computeWindow } from "./window";
import { assembleMessage } from "./assemble";
import type { Delivery } from "./delivery";
import { loadSettings } from "./cron";

export interface DeliverOptions {
  delivery: Delivery;
  origin?: string; // absolute prefix for deep links
  /** The https one-click unsubscribe target for a login; defaults to the Settings deep link. */
  unsubscribeUrl?: (login: string) => Promise<string>;
}

export interface RunOptions extends DeliverOptions {
  registry?: readonly NotificationKind<TenantContext>[];
}

export interface RunReport {
  window: Window;
  eligible: number;
  alreadyRan: number;
  sent: number;
  skipped: number;
  failed: number;
}

interface Recipient { github_login: string; email: string; }

async function setStatus(ctx: TenantContext, key: string, patch: { status: string; kinds?: string[]; resend_id?: string | null; error?: string | null; sent_at?: string | null }): Promise<void> {
  await run(
    ctx,
    `UPDATE notification_outbox SET status = ?, kinds = COALESCE(?, kinds), resend_id = ?, error = ?, sent_at = ?
      WHERE idempotency_key = ? AND org_id = ?`,
    patch.status,
    patch.kinds ? JSON.stringify(patch.kinds) : null,
    patch.resend_id ?? null,
    patch.error ?? null,
    patch.sent_at ?? null,
    key,
    ctx.orgId
  );
}

export interface ClaimedRow {
  key: string;
  login: string;
  email: string;
  kinds: readonly NotificationKind<TenantContext>[];
  window: Window;
  timeZone: string;
}

/** Render every kind for a login/window and drop nulls. Pure read; throws on a renderer error. */
export async function renderSections(ctx: TenantContext, login: string, kinds: readonly NotificationKind<TenantContext>[], window: Window): Promise<{ sections: Section[]; rendered: string[] }> {
  const sections: Section[] = [];
  const rendered: string[] = [];
  for (const k of kinds) {
    const s = await k.render(ctx, login, window);
    if (s) {
      sections.push(s);
      rendered.push(k.id);
    }
  }
  return { sections, rendered };
}

/** Assemble the one message for a login from already-rendered sections. */
export async function buildMessage(sections: Section[], row: Pick<ClaimedRow, "login" | "window" | "timeZone">, opts: DeliverOptions) {
  const origin = opts.origin ?? "";
  const unsubscribeUrl = opts.unsubscribeUrl ? await opts.unsubscribeUrl(row.login) : `${origin}/#settings`;
  return { unsubscribeUrl, ...assembleMessage({ sections, window: row.window, timeZone: row.timeZone, origin, login: row.login, unsubscribeUrl }) };
}

/**
 * Render the claimed kinds for one outbox row, drop nulls, then skip or send,
 * recording the outcome on the row. Shared by the run, the retry job and the
 * admin test send. `presetSections` skips rendering (the sample preview).
 */
export async function deliverRow(ctx: TenantContext, row: ClaimedRow, opts: DeliverOptions, presetSections?: Section[]): Promise<"sent" | "skipped" | "failed"> {
  let sections: Section[];
  let rendered: string[];
  try {
    if (presetSections) {
      sections = presetSections;
      rendered = row.kinds.map((k) => k.id);
    } else {
      ({ sections, rendered } = await renderSections(ctx, row.login, row.kinds, row.window));
    }
  } catch (e) {
    await setStatus(ctx, row.key, { status: "failed", error: `render: ${String((e as Error)?.message ?? e)}` });
    return "failed";
  }

  if (sections.length === 0) {
    await setStatus(ctx, row.key, { status: "skipped", kinds: [] });
    return "skipped";
  }

  const { unsubscribeUrl, ...msg } = await buildMessage(sections, row, opts);
  try {
    const { id } = await opts.delivery.send({ idempotencyKey: row.key, userId: row.login, to: row.email, unsubscribeUrl, ...msg });
    await setStatus(ctx, row.key, { status: "sent", kinds: rendered, resend_id: id, sent_at: nowIso() });
    return "sent";
  } catch (e) {
    await setStatus(ctx, row.key, { status: "failed", kinds: rendered, error: `send: ${String((e as Error)?.message ?? e)}` });
    return "failed";
  }
}

/** The outbox key for one (org, person, cadence, window): the claim that makes a window run once. */
export const outboxKey = (ctx: TenantContext, login: string, cadence: string, windowId: string): string =>
  `${ctx.orgId}:${login}:${cadence}:${windowId}`;

/**
 * `p` reads the people: the org's MEMBERS with an address on file who have not unsubscribed (the
 * unsubscribe is global — one click stops every org's mail). Everything else is `ctx`'s org.
 */
export async function runDigest(ctx: TenantContext, p: PlatformContext, cadence: RunCadence, now: Date, opts: RunOptions): Promise<RunReport> {
  const registry = opts.registry ?? REGISTRY;
  const settings = await loadSettings(ctx);
  const timeZone = settings.timezone;
  const window = computeWindow(cadence, now, timeZone);
  const report: RunReport = { window, eligible: 0, alreadyRan: 0, sent: 0, skipped: 0, failed: 0 };

  const policies = await loadPolicies(ctx);
  // Eligibility is a hard gate above resolution: a member, an address on file, not unsubscribed.
  const recipients = await platformAll<Recipient>(
    p,
    `SELECT p.handle AS github_login, p.email
       FROM persons p JOIN memberships m ON p.handle = m.user_id AND m.org_id = ?
      WHERE p.email IS NOT NULL AND p.email != '' AND p.email_unsubscribed = 0 ORDER BY p.handle`,
    ctx.orgId
  );

  for (const who of recipients) {
    report.eligible++;
    const prefs = await loadPrefs(ctx, who.github_login);
    const selected = registry.filter((k) => resolveWith(k, policies.get(k.id), prefs.get(k.id)) === cadence);

    const key = outboxKey(ctx, who.github_login, cadence, window.id);
    const claim = await run(
      ctx,
      `INSERT OR IGNORE INTO notification_outbox (org_id, idempotency_key, user_id, cadence, window_id, kinds, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ctx.orgId,
      key,
      who.github_login,
      cadence,
      window.id,
      JSON.stringify(selected.map((k) => k.id)),
      nowIso()
    );
    if ((claim.meta.changes ?? 0) === 0) {
      report.alreadyRan++;
      continue;
    }

    const outcome = await deliverRow(ctx, { key, login: who.github_login, email: who.email, kinds: selected, window, timeZone }, opts);
    report[outcome]++;
  }
  return report;
}
