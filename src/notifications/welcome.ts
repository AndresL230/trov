// The welcome email: one message when a person joins an org for the FIRST time — accepting an
// invitation, creating an org, or being named its owner (src/orgs/mail.ts `welcomeFirstJoin`) — through
// the same delivery gate as the digests. It is NOT a NotificationKind — no cadence, prefs, or window — but
// it IS a notification, not transactional mail: it carries the unsubscribe link (footer and
// List-Unsubscribe header), and a person who has unsubscribed is not sent one (`welcomeFirstJoin`). It is
// also where a new member learns that digests are ON, so it says when they come, as the org has them.
//
// It is sent AS that org (its sender name, its outbox), names it, and links into it.
// The address is one a sign-in provider VERIFIED for the person, never the editable
// notification address. There is no outcome column: a failure here is a missed
// courtesy, not a broken join, and the join must not care.
import type { Env } from "../env";
import { type TenantContext, nowIso } from "../data/sql";
import { escapeHtml } from "./html";
import { EMAIL_COLORS as C, EMAIL_FONT, EMAIL_STYLE, EMAIL_SPACE as SP, emailHead, emailBanner, emailFooter, emailCardOpen, EMAIL_CARD_CLOSE } from "./assemble";
import { deliveryFor } from "./resend";
import { loadSettings } from "./cron";
import { REGISTRY } from "./registry";
import { loadPolicies, resolveWith } from "./resolve";
import { unsubscribeUrl } from "./unsubscribe";
import { scrubbedMessage } from "../repo/github";

/** The guided setup — the screen a person lands on when they create or join an organization, so the
 *  mail and the app agree on where a new person begins (an owner's four steps or a member's two; the
 *  page picks by role). The Guide (`#guide`) is the reference it links on to. */
export function welcomeUrl(origin: string, orgSlug: string): string {
  return `${origin}/${orgSlug}/#welcome`;
}

/** The digests a NEW member of an org gets: which cadences any digest resolves to under the org's policy
 *  (a new member has no prefs of their own yet), and the org's send hour and timezone. */
export interface WelcomeDigests { daily: boolean; weekly: boolean; sendHour: number; timeZone: string }

export async function welcomeDigests(ctx: TenantContext): Promise<WelcomeDigests> {
  const [settings, policies] = await Promise.all([loadSettings(ctx), loadPolicies(ctx)]);
  const cadences = REGISTRY.map((k) => resolveWith(k, policies.get(k.id), undefined));
  return { daily: cadences.includes("daily"), weekly: cadences.includes("weekly"), sendHour: settings.send_hour, timeZone: settings.timezone };
}

/** One sentence: are digests on, and when do they come (src/notifications/cron.ts `dueCadence`: daily on
 *  weekdays, weekly on Mondays, at the org's send hour; a digest with nothing to say is not sent). */
export function digestSentence(d: WelcomeDigests, orgName: string): string {
  const at = `${String(d.sendHour).padStart(2, "0")}:00 (${d.timeZone})`;
  if (d.daily && d.weekly) return `Email digests are on: Trov emails you one each weekday at ${at} when there is something for you, and a weekly one on Mondays.`;
  if (d.daily) return `Email digests are on: Trov emails you one each weekday at ${at} when there is something for you.`;
  if (d.weekly) return `Email digests are on: Trov emails you one each Monday at ${at} when there is something for you.`;
  return `Email digests are off in ${orgName} for now: its admin has turned them off.`;
}

export interface WelcomeEmailInput {
  name: string | null;
  handle: string;
  orgName: string;
  orgSlug: string;
  origin: string;
  host: string;
  digests: WelcomeDigests;
  /** The person's signed unsubscribe link (src/notifications/unsubscribe.ts): the footer's, and the header's. */
  unsubscribeUrl: string;
}

export function renderWelcomeEmail(o: WelcomeEmailInput): { subject: string; html: string; text: string } {
  const subject = `Welcome to ${o.orgName} on Trov`;
  const hi = o.name ? `Hi ${escapeHtml(o.name)},` : "Hi,";
  const p = `${EMAIL_FONT.sans}font-size:14px;line-height:20px;color:${C.fg70};padding:0 0 12px 0;`;
  const lede = "You're in.";
  const joined = `You have joined ${o.orgName}.`;
  const about = "Trov is a team's shared memory: what everyone is working on, the docs and decisions behind it, and what ships next.";
  const settings = `${o.origin}/${o.orgSlug}/#settings`;
  const start = welcomeUrl(o.origin, o.orgSlug);
  const digests = digestSentence(o.digests, o.orgName);
  const why = `You're getting this because you joined ${o.orgName} on Trov.`;
  const button = `display:inline-block;${EMAIL_FONT.sans}font-size:14px;line-height:20px;font-weight:600;color:#ffffff;background-color:${C.accent};text-decoration:none;padding:10px 18px;border-radius:9px;`;
  const handleStyle = `${EMAIL_FONT.sans}font-weight:500;color:${C.fg};`;
  const html =
    emailHead(subject) +
    `<body style="margin:0;padding:0;background-color:${C.ground};">` +
    `<table ${EMAIL_STYLE.table} style="background-color:${C.ground};"><tr><td align="center" class="tm-pad" style="padding:36px 16px;">` +
    emailCardOpen() +
    emailBanner({ eyebrow: "Welcome", title: lede }) +
    `<tr><td style="padding:${SP.xl}px 28px 0 28px;">` +
    `<div style="${p}color:${C.fg};">${hi}</div>` +
    `<div style="${p}">${escapeHtml(joined)} Your handle is <span style="${handleStyle}">@${escapeHtml(o.handle)}</span> — that is how the team sees you on tickets, docs and decisions.</div>` +
    `<div style="${EMAIL_FONT.sans}font-size:13px;line-height:20px;color:${C.fg55};padding:0 0 ${SP.l}px 0;">${about}</div>` +
    `<div style="text-align:center;padding:0 0 ${SP.l}px 0;"><a href="${escapeHtml(start)}" style="${button}">Open the guided setup</a></div>` +
    `<div data-digests style="${EMAIL_FONT.sans}font-size:12.5px;line-height:20px;color:${C.fg55};padding-bottom:24px;">${escapeHtml(digests)} To change how often, or to stop them, go to <a href="${escapeHtml(settings)}" style="color:${C.fg70};">Settings</a>, where your handle, name and colour are yours to change too.</div></td></tr>` +
    emailFooter({ why: escapeHtml(why), host: o.host, unsubscribeUrl: o.unsubscribeUrl }) +
    EMAIL_CARD_CLOSE + `</td></tr></table></body></html>`;
  const text = [
    subject, "=".repeat(subject.length), "",
    lede, "",
    o.name ? `Hi ${o.name},` : "Hi,", "",
    `${joined} Your handle is @${o.handle} — that is how the team sees you on tickets, docs and decisions.`, "",
    about, "",
    "Open the guided setup:", "",
    `  ${start}`, "",
    `${digests} To change how often, or to stop them, go to Settings, where your handle, name and colour are yours to change too: ${settings}`, "",
    why,
    `Unsubscribe: ${o.unsubscribeUrl}`,
    `Sent by Trov — ${o.host}`, "",
  ].join("\n");
  return { subject, html, text };
}

/**
 * Send it. Never throws: a delivery failure (or a misconfigured mode) is caught
 * and returned, because the caller has just written a membership and the person must
 * get in whatever the mailer does. `ctx` is the org joined, whose mail settings, digest
 * policy (and, in local mode, bodies table) the message goes out under. `handle` is the
 * person's stored handle: the unsubscribe link names it. The caller has already checked
 * that the person has not unsubscribed (`welcomeFirstJoin`).
 */
export async function sendWelcome(env: Env, ctx: TenantContext, o: { email: string; name: string | null; handle: string; orgName: string; orgSlug: string; origin: string; fetchImpl?: typeof fetch }): Promise<{ status: "sent" | "failed"; id: string | null; error: string | null }> {
  try {
    const [settings, digests, unsub] = await Promise.all([loadSettings(ctx), welcomeDigests(ctx), unsubscribeUrl(o.origin, o.handle, env.COOKIE_SECRET)]);
    const msg = renderWelcomeEmail({
      name: o.name, handle: o.handle, orgName: o.orgName, orgSlug: o.orgSlug, origin: o.origin,
      host: o.origin.replace(/^https?:\/\//, "") || "trov", digests, unsubscribeUrl: unsub,
    });
    const delivery = deliveryFor(ctx, env, { from: settings.from_address, fetchImpl: o.fetchImpl });
    const r = await delivery.send({ idempotencyKey: `welcome:${o.handle}:${nowIso()}`, userId: o.handle, to: o.email, subject: msg.subject, html: msg.html, text: msg.text, unsubscribeUrl: unsub });
    return { status: "sent", id: r.id, error: null };
  } catch (e) {
    return { status: "failed", id: null, error: scrubbedMessage(e, env.RESEND_API_KEY ?? "") };
  }
}
