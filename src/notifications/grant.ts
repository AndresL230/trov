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
import { EMAIL_COLORS as C, EMAIL_FONT, EMAIL_STYLE, EMAIL_SPACE as SP, emailHead, emailBanner, emailFooter, emailCardOpen, EMAIL_CARD_CLOSE } from "./assemble";
import { platformDeliveryFor } from "./resend";
import { inviteSignInUrl } from "./invite";
import { getPerson } from "../auth/persons";
import { giftLengthWords } from "@shared/plans";
import { PRICING, formatPrice } from "@shared/pricing";
import { REFUNDS_PATH, TERMS_PATH } from "@shared/legal-core";

/** A paid confirmation's renewal and cancellation terms (the owner's policy, /refunds): it renews by itself,
 *  when, at what, until when, and how to stop it. Plain text. */
export function paidTermsText(planName: string): string {
  const price = PRICING.team.price;
  return `${planName} renews automatically each month, on the day of the month you subscribed${price ? `, at ${formatPrice(price)} per seat plus any applicable tax` : ""}, until you cancel. `
    + `An owner can cancel any time in Trov, from Billing (Org settings › General › Plan › Cancel plan, or Manage billing): ${planName} stays active until the end of the period already paid, and there are no refunds for partial periods, except where the law requires one. `
    + `Seats, the card and invoices are in Manage billing too.`;
}

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
  // A purchase's renewal and cancellation terms, with the policy and the Terms one click away (absolute:
  // this is mail). The org is not named yet, so Billing is described, not linked.
  let origin = `https://${o.host}`;
  try { origin = new URL(o.signInUrl).origin; } catch { /* keep the host */ }
  const terms = o.paid ? paidTermsText(o.planName) : "";
  const termsLinks = o.paid ? { refunds: `${origin}${REFUNDS_PATH}`, terms: `${origin}${TERMS_PATH}` } : null;
  // Transactional: it answers a grant or a purchase, so it goes out whatever the address's unsubscribe
  // says, and carries no unsubscribe link — the footer says why it came (shared/email-unsubscribe.ts).
  const why = `You're getting this because ${o.paid ? `this address paid for Trov's ${o.planName} plan` : o.granterName ? `${o.granterName} gave this address an organization on Trov` : "this address was given an organization on Trov"}: a one-off email, not a mailing list.`;
  const p = `${EMAIL_FONT.sans}font-size:14px;line-height:20px;color:${C.fg70};padding:0 0 12px 0;`;
  const button = `display:inline-block;${EMAIL_FONT.sans}font-size:14px;line-height:20px;font-weight:600;color:#ffffff;background-color:${C.accent};text-decoration:none;padding:10px 18px;border-radius:9px;`;
  const html =
    emailHead(subject) +
    `<body style="margin:0;padding:0;background-color:${C.ground};">` +
    `<table ${EMAIL_STYLE.table} style="background-color:${C.ground};"><tr><td align="center" class="tm-pad" style="padding:36px 16px;">` +
    emailCardOpen() +
    emailBanner({ eyebrow: "Your organization", title: escapeHtml(lede) }) +
    `<tr><td style="padding:${SP.xl}px 28px 0 28px;">` +
    `<div style="${p}color:${C.fg};">Hi,</div>` +
    `<div style="${p}">${escapeHtml(what)}</div>` +
    `<div style="${p}">${escapeHtml(plan)}</div>` +
    (termsLinks ? `<div data-paid-terms style="${p}">${escapeHtml(terms)} <a href="${escapeHtml(termsLinks.refunds)}" style="color:${C.accentText};">Refund and cancellation policy</a> · <a href="${escapeHtml(termsLinks.terms)}" style="color:${C.accentText};">Terms</a></div>` : "") +
    `<div style="${EMAIL_FONT.sans}font-size:13px;line-height:20px;color:${C.fg55};padding:0 0 ${SP.l}px 0;">${about}</div>` +
    `<div style="text-align:center;padding:0 0 ${SP.l}px 0;"><a href="${escapeHtml(o.signInUrl)}" style="${button}">Sign in to Trov</a></div>` +
    `<div style="${EMAIL_FONT.sans}font-size:12.5px;line-height:20px;color:${C.fg55};padding-bottom:24px;">This is for <span style="${EMAIL_FONT.sans}font-weight:500;color:${C.fg70};">${escapeHtml(o.email)}</span>. If you weren't expecting it, you can ignore this email.</div></td></tr>` +
    emailFooter({ why: escapeHtml(why), host: o.host }) +
    EMAIL_CARD_CLOSE + `</td></tr></table></body></html>`;
  const text = [
    subject, "=".repeat(subject.length), "",
    lede, "",
    "Hi,", "",
    what, "",
    plan, "",
    ...(termsLinks ? [terms, "", `Refund and cancellation policy: ${termsLinks.refunds}`, `Terms: ${termsLinks.terms}`, ""] : []),
    about, "",
    "Sign in to Trov:", "",
    `  ${o.signInUrl}`, "",
    forWhom, "",
    why,
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
