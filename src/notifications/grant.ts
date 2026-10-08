// The grant notice: one transactional message when a person is granted an organization of their own BY
// E-MAIL (0044_plans, src/plans/grants.ts). Modelled on the invitation (./invite.ts): it names who
// granted it and the plan, and its only link is the site root — never a token, never a grant id. The
// grant is matched to the person's provider-verified address when they sign in.
//
// It belongs to no org (none exists yet), so it goes through the platform's delivery
// (`platformDeliveryFor`): the platform's own From, and in local mode the global bodies table.
import type { Env } from "../env";
import { type PlatformContext, run, nowIso } from "../data/platform-sql";
import { escapeHtml } from "./html";
import { EMAIL_COLORS as C, EMAIL_FONT, FONTS_HREF, EMAIL_STYLE, EMAIL_WIDTH, EMAIL_SPACE as SP, emailBanner } from "./assemble";
import { platformDeliveryFor } from "./resend";
import { inviteSignInUrl } from "./invite";
import { getPerson } from "../auth/persons";
import { giftLengthWords } from "@shared/plans";

export interface GrantEmailInput {
  /** Who granted it, as a display name; null for a grant nobody made by hand (billing). */
  granterName: string | null;
  planName: string;
  planDescription: string;
  email: string;
  signInUrl: string;
  host: string;
  /** The grant is a PURCHASE's (src/billing/fulfil.ts): it says the payment went through, not that something was given. */
  paid?: boolean;
  /** A GIFT (0048_plan_gifts): the organization is free for this many days from the day it is set up. */
  giftDays?: number | null;
}

export function renderGrantEmail(o: GrantEmailInput): { subject: string; html: string; text: string } {
  const subject = o.paid ? "Your Trov organization is ready to set up" : "You can set up an organization on Trov";
  const lede = o.paid ? "Your organization is ready." : "An organization of your own.";
  const what = o.paid
    ? `Your payment for Trov's ${o.planName} plan went through. Sign in, choose your organization's name and address, and it is yours: you are its owner. Stripe sends the receipt.`
    : `${o.granterName ? `${o.granterName} has` : "You have been"} given ${o.granterName ? "you " : ""}an organization on Trov's ${o.planName} plan. Sign in with this address, choose its name and address, and it is yours: you are its owner.${o.giftDays ? ` It is free for ${giftLengthWords(o.giftDays)} from the day you set it up; after that it moves to the Free plan, and nothing is deleted.` : ""}`;
  const plan = `${o.planName}: ${o.planDescription}`;
  const about = "Trov is a team's shared memory: what everyone is working on, the docs and decisions behind it, and what ships next.";
  const forWhom = `This is for ${o.email}. If you weren't expecting it, you can ignore this email.`;
  const p = `${EMAIL_FONT.sans}font-size:14px;line-height:20px;color:${C.fg70};padding:0 0 12px 0;`;
  const headline = `${EMAIL_FONT.sans}font-size:26px;line-height:32px;font-weight:600;letter-spacing:-0.02em;color:${C.fg};padding:0 0 ${SP.m}px 0;`;
  const button = `display:inline-block;${EMAIL_FONT.sans}font-size:14px;line-height:20px;font-weight:600;color:#ffffff;background-color:${C.accent};text-decoration:none;padding:10px 18px;border-radius:9px;`;
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title><link href="${FONTS_HREF}" rel="stylesheet"></head>` +
    `<body style="margin:0;padding:0;background-color:${C.ground};">` +
    `<table ${EMAIL_STYLE.table} style="background-color:${C.ground};"><tr><td align="center" style="padding:36px 16px;">` +
    `<table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:${EMAIL_WIDTH}px;max-width:100%;background-color:${C.bg};border:1px solid ${C.border};border-radius:13px;">` +
    emailBanner() +
    `<tr><td style="padding:${SP.xl}px 28px 0 28px;"><div style="${headline}">${escapeHtml(lede)}</div>` +
    `<div style="${p}color:${C.fg};">Hi,</div>` +
    `<div style="${p}">${escapeHtml(what)}</div>` +
    `<div style="${p}">${escapeHtml(plan)}</div>` +
    `<div style="${EMAIL_FONT.sans}font-size:13px;line-height:20px;color:${C.fg55};padding:0 0 ${SP.l}px 0;">${about}</div>` +
    `<div style="text-align:center;padding:0 0 ${SP.l}px 0;"><a href="${escapeHtml(o.signInUrl)}" style="${button}">Sign in to Trov</a></div>` +
    `<div style="${EMAIL_FONT.sans}font-size:12.5px;line-height:20px;color:${C.fg55};padding-bottom:24px;">This is for <span style="${EMAIL_FONT.sans}font-weight:500;color:${C.fg70};">${escapeHtml(o.email)}</span>. If you weren't expecting it, you can ignore this email.</div></td></tr>` +
    `<tr><td style="padding:16px 28px;border-top:1px solid ${C.border};${EMAIL_FONT.sans}font-size:12px;line-height:20px;color:${C.fg40};">Sent by Trov &middot; ${escapeHtml(o.host)}</td></tr>` +
    `</table></td></tr></table></body></html>`;
  const text = [
    subject, "=".repeat(subject.length), "",
    lede, "",
    "Hi,", "",
    what, "",
    plan, "",
    about, "",
    "Sign in to Trov:", "",
    `  ${o.signInUrl}`, "",
    forWhom,
    `Sent by Trov — ${o.host}`, "",
  ].join("\n");
  return { subject, html, text };
}

export interface GrantMailOutcome { status: "sent" | "failed"; at: string; error: string | null }

/**
 * Send one grant notice and record the outcome on the grant's row. Never throws: the grant is already
 * written, and the person finds it when they sign in whether or not the mail arrived.
 */
export async function sendGrantNotice(env: Env, p: PlatformContext, o: { grantId: number; email: string; granterHandle: string | null; planName: string; planDescription: string; origin: string; fetchImpl?: typeof fetch; paid?: boolean; giftDays?: number | null }): Promise<GrantMailOutcome> {
  const at = nowIso();
  let result: GrantMailOutcome;
  try {
    const granter = o.granterHandle ? await getPerson(p, o.granterHandle) : null;
    const msg = renderGrantEmail({
      granterName: o.granterHandle ? granter?.name ?? o.granterHandle : null, planName: o.planName, planDescription: o.planDescription, email: o.email,
      signInUrl: inviteSignInUrl(o.origin), host: o.origin.replace(/^https?:\/\//, "") || "trov", paid: o.paid, giftDays: o.giftDays,
    });
    await platformDeliveryFor(p, env, { fetchImpl: o.fetchImpl }).send({ idempotencyKey: `grant:${o.grantId}:${at}`, userId: o.email, to: o.email, subject: msg.subject, html: msg.html, text: msg.text });
    result = { status: "sent", at, error: null };
  } catch (e) {
    result = { status: "failed", at, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) };
  }
  await run(p, `UPDATE org_grants SET mail_status = ?, mail_at = ?, mail_error = ? WHERE id = ?`, result.status, result.at, result.error, o.grantId).catch(() => undefined);
  return result;
}
