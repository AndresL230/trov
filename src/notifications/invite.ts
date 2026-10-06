// The invite email: one transactional message per invite (create or resend),
// through the same delivery gate as the digests. Not a NotificationKind — no
// cadence, prefs, or window. The outcome lands on the invite row.
import type { Env } from "../env";
import { type TenantContext, nowIso } from "../data/sql";
import type { PlatformContext } from "../data/platform-sql";
import { legacyDb } from "../data/legacy";
import { escapeHtml } from "./html";
import { EMAIL_COLORS as C, EMAIL_FONT, FONTS_HREF, EMAIL_STYLE, EMAIL_WIDTH, EMAIL_SPACE as SP, emailBanner } from "./assemble";
import { deliveryFor } from "./resend";
import { loadSettings } from "./cron";
import { getPerson } from "../auth/persons";
import { recordInviteEmail } from "../auth/invites";

/**
 * The invite lands on Trov's own sign-in screen, not Google's account chooser:
 * the invitee sees what they are joining and presses "Continue with Google"
 * themselves. The email still names the address the invite is for, since the
 * app cannot prefill it from here.
 */
export function inviteSignInUrl(origin: string): string {
  return `${origin}/`;
}

export function renderInviteEmail(o: { inviteeName: string | null; inviterName: string; email: string; signInUrl: string; host: string }): { subject: string; html: string; text: string } {
  const subject = `${o.inviterName} invited you to Trov`;
  const hi = o.inviteeName ? `Hi ${escapeHtml(o.inviteeName)},` : "Hi,";
  const p = `${EMAIL_FONT.sans}font-size:14px;line-height:20px;color:${C.fg70};padding:0 0 12px 0;`;
  const headline = `${EMAIL_FONT.sans}font-size:26px;line-height:32px;font-weight:600;letter-spacing:-0.02em;color:${C.fg};padding:0 0 ${SP.m}px 0;`;
  const lede = "You're invited to the Sapling team's shared workspace.";
  const about = "Trov is the team's shared memory: what everyone is working on, the docs and decisions behind it, and what ships next.";
  const button = `display:inline-block;${EMAIL_FONT.sans}font-size:14px;line-height:20px;font-weight:600;color:#ffffff;background-color:${C.accent};text-decoration:none;padding:10px 18px;border-radius:9px;`;
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title><link href="${FONTS_HREF}" rel="stylesheet"></head>` +
    `<body style="margin:0;padding:0;background-color:${C.ground};">` +
    `<table ${EMAIL_STYLE.table} style="background-color:${C.ground};"><tr><td align="center" style="padding:36px 16px;">` +
    `<table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:${EMAIL_WIDTH}px;max-width:100%;background-color:${C.bg};border:1px solid ${C.border};border-radius:13px;">` +
    emailBanner() +
    `<tr><td style="padding:${SP.xl}px 28px 0 28px;"><div style="${headline}">${lede}</div>` +
    `<div style="${p}color:${C.fg};">${hi}</div>` +
    `<div style="${p}">${escapeHtml(o.inviterName)} invited you. Sign in with this Google address to pick your handle and get started.</div>` +
    `<div style="${EMAIL_FONT.sans}font-size:13px;line-height:20px;color:${C.fg55};padding:0 0 ${SP.l}px 0;">${about}</div>` +
    `<div style="text-align:center;padding:0 0 ${SP.l}px 0;"><a href="${escapeHtml(o.signInUrl)}" style="${button}">Sign in with Google</a></div>` +
    `<div style="${EMAIL_FONT.sans}font-size:12.5px;line-height:20px;color:${C.fg55};padding-bottom:24px;">This invite is for <span style="${EMAIL_FONT.sans}font-weight:500;color:${C.fg70};">${escapeHtml(o.email)}</span>. If you weren't expecting it, you can ignore this email.</div></td></tr>` +
    `<tr><td style="padding:16px 28px;border-top:1px solid ${C.border};${EMAIL_FONT.sans}font-size:12px;line-height:20px;color:${C.fg40};">Sent by Trov &middot; ${escapeHtml(o.host)}</td></tr>` +
    `</table></td></tr></table></body></html>`;
  const text = [
    subject, "=".repeat(subject.length), "",
    lede, "",
    o.inviteeName ? `Hi ${o.inviteeName},` : "Hi,", "",
    `${o.inviterName} invited you.`, "",
    about, "",
    "Sign in with this Google address to pick your handle and get started:", "",
    `  ${o.signInUrl}`, "",
    `This invite is for ${o.email}. If you weren't expecting it, you can ignore this email.`,
    `Sent by Trov — ${o.host}`, "",
  ].join("\n");
  return { subject, html, text };
}

/** `ctx` is the inviting org (its mail settings); `p` reads the inviter and records the outcome on the invite. */
export async function sendInvite(env: Env, ctx: TenantContext, p: PlatformContext, o: { email: string; inviteeName: string | null; inviterHandle: string; origin: string; fetchImpl?: typeof fetch }): Promise<{ status: "sent" | "failed"; id: string | null; error: string | null }> {
  const inviter = await getPerson(legacyDb(p), o.inviterHandle);
  const settings = await loadSettings(ctx);
  const msg = renderInviteEmail({
    inviteeName: o.inviteeName, inviterName: inviter?.name ?? o.inviterHandle, email: o.email,
    signInUrl: inviteSignInUrl(o.origin), host: o.origin.replace(/^https?:\/\//, "") || "trov",
  });
  let result: { status: "sent" | "failed"; id: string | null; error: string | null };
  try {
    const delivery = deliveryFor(ctx, env, { from: settings.from_address, fetchImpl: o.fetchImpl });
    const r = await delivery.send({ idempotencyKey: `invite:${o.email}:${nowIso()}`, userId: o.email, to: o.email, subject: msg.subject, html: msg.html, text: msg.text });
    result = { status: "sent", id: r.id, error: null };
  } catch (e) {
    result = { status: "failed", id: null, error: e instanceof Error ? e.message : String(e) };
  }
  await recordInviteEmail(legacyDb(p), o.email, { id: result.id, error: result.error });
  return result;
}
