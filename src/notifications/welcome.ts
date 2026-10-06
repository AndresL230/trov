// The welcome email: one transactional message when a person joins an org for the
// FIRST time — accepting an invitation, creating an org, or being named its owner
// (src/orgs/mail.ts `welcomeFirstJoin`) — through the same delivery gate as the
// digests. Like the invite it is NOT a NotificationKind — no cadence, prefs, or window.
//
// It is sent AS that org (its sender name, its outbox), names it, and links into it.
// The address is one a sign-in provider VERIFIED for the person, never the editable
// notification address. There is no outcome column: a failure here is a missed
// courtesy, not a broken join, and the join must not care.
import type { Env } from "../env";
import { type TenantContext, nowIso } from "../data/sql";
import { escapeHtml } from "./html";
import { EMAIL_COLORS as C, EMAIL_FONT, FONTS_HREF, EMAIL_STYLE, EMAIL_WIDTH, EMAIL_SPACE as SP, emailBanner } from "./assemble";
import { deliveryFor } from "./resend";
import { loadSettings } from "./cron";

/** Get Started — the screen a fresh sign-in already lands on, so the mail and the
 *  app agree on where a new person begins. */
export function welcomeUrl(origin: string, orgSlug: string): string {
  return `${origin}/o/${orgSlug}/#guide`;
}

export function renderWelcomeEmail(o: { name: string | null; handle: string; orgName: string; orgSlug: string; origin: string; host: string }): { subject: string; html: string; text: string } {
  const subject = `Welcome to ${o.orgName} on Trov`;
  const hi = o.name ? `Hi ${escapeHtml(o.name)},` : "Hi,";
  const p = `${EMAIL_FONT.sans}font-size:14px;line-height:20px;color:${C.fg70};padding:0 0 12px 0;`;
  const headline = `${EMAIL_FONT.sans}font-size:26px;line-height:32px;font-weight:600;letter-spacing:-0.02em;color:${C.fg};padding:0 0 ${SP.m}px 0;`;
  const lede = "You're in.";
  const joined = `You have joined ${o.orgName}.`;
  const about = "Trov is a team's shared memory: what everyone is working on, the docs and decisions behind it, and what ships next.";
  const settings = `${o.origin}/o/${o.orgSlug}/#settings`;
  const start = welcomeUrl(o.origin, o.orgSlug);
  const button = `display:inline-block;${EMAIL_FONT.sans}font-size:14px;line-height:20px;font-weight:600;color:#ffffff;background-color:${C.accent};text-decoration:none;padding:10px 18px;border-radius:9px;`;
  const handleStyle = `${EMAIL_FONT.sans}font-weight:500;color:${C.fg};`;
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title><link href="${FONTS_HREF}" rel="stylesheet"></head>` +
    `<body style="margin:0;padding:0;background-color:${C.ground};">` +
    `<table ${EMAIL_STYLE.table} style="background-color:${C.ground};"><tr><td align="center" style="padding:36px 16px;">` +
    `<table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:${EMAIL_WIDTH}px;max-width:100%;background-color:${C.bg};border:1px solid ${C.border};border-radius:13px;">` +
    emailBanner() +
    `<tr><td style="padding:${SP.xl}px 28px 0 28px;"><div style="${headline}">${lede}</div>` +
    `<div style="${p}color:${C.fg};">${hi}</div>` +
    `<div style="${p}">${escapeHtml(joined)} Your handle is <span style="${handleStyle}">@${escapeHtml(o.handle)}</span> — that is how the team sees you on tickets, docs and decisions.</div>` +
    `<div style="${EMAIL_FONT.sans}font-size:13px;line-height:20px;color:${C.fg55};padding:0 0 ${SP.l}px 0;">${about}</div>` +
    `<div style="text-align:center;padding:0 0 ${SP.l}px 0;"><a href="${escapeHtml(start)}" style="${button}">Open Get Started</a></div>` +
    `<div style="${EMAIL_FONT.sans}font-size:12.5px;line-height:20px;color:${C.fg55};padding-bottom:24px;">Your handle, name and colour are yours to change, and email digests are off until you pick a cadence — both live in <a href="${escapeHtml(settings)}" style="color:${C.fg70};">Settings</a>.</div></td></tr>` +
    `<tr><td style="padding:16px 28px;border-top:1px solid ${C.border};${EMAIL_FONT.sans}font-size:12px;line-height:20px;color:${C.fg40};">Sent by Trov &middot; ${escapeHtml(o.host)}</td></tr>` +
    `</table></td></tr></table></body></html>`;
  const text = [
    subject, "=".repeat(subject.length), "",
    lede, "",
    o.name ? `Hi ${o.name},` : "Hi,", "",
    `${joined} Your handle is @${o.handle} — that is how the team sees you on tickets, docs and decisions.`, "",
    about, "",
    "Open Get Started:", "",
    `  ${start}`, "",
    `Your handle, name and colour are yours to change, and email digests are off until you pick a cadence — both live in Settings: ${settings}`,
    `Sent by Trov — ${o.host}`, "",
  ].join("\n");
  return { subject, html, text };
}

/**
 * Send it. Never throws: a delivery failure (or a misconfigured mode) is caught
 * and returned, because the caller has just written a membership and the person must
 * get in whatever the mailer does. `ctx` is the org joined, whose mail settings
 * (and, in local mode, bodies table) the message goes out under.
 */
export async function sendWelcome(env: Env, ctx: TenantContext, o: { email: string; name: string | null; handle: string; orgName: string; orgSlug: string; origin: string; fetchImpl?: typeof fetch }): Promise<{ status: "sent" | "failed"; id: string | null; error: string | null }> {
  try {
    const settings = await loadSettings(ctx);
    const msg = renderWelcomeEmail({
      name: o.name, handle: o.handle, orgName: o.orgName, orgSlug: o.orgSlug, origin: o.origin,
      host: o.origin.replace(/^https?:\/\//, "") || "trov",
    });
    const delivery = deliveryFor(ctx, env, { from: settings.from_address, fetchImpl: o.fetchImpl });
    const r = await delivery.send({ idempotencyKey: `welcome:${o.handle}:${nowIso()}`, userId: o.handle, to: o.email, subject: msg.subject, html: msg.html, text: msg.text });
    return { status: "sent", id: r.id, error: null };
  } catch (e) {
    return { status: "failed", id: null, error: e instanceof Error ? e.message : String(e) };
  }
}
