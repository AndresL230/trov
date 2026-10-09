// The invite email: one transactional message per invite (create or resend),
// through the same delivery gate as the digests. Not a NotificationKind — no
// cadence, prefs, or window. The outcome lands on the `org_invites` row (0042_organizations).
//
// It names the inviting ORG and the inviter, says what role accepting grants, and links to the site
// root — never a token, never an invite id: the invitation is matched to the person's provider-verified
// address when they sign in, and accepted there.
import type { Env } from "../env";
import { type TenantContext, nowIso } from "../data/sql";
import { type PlatformContext, run as platformRun } from "../data/platform-sql";
import { escapeHtml } from "./html";
import { EMAIL_COLORS as C, EMAIL_FONT, FONTS_HREF, EMAIL_STYLE, EMAIL_SPACE as SP, emailBanner, emailCardOpen, EMAIL_CARD_CLOSE, EMAIL_MOBILE_CSS } from "./assemble";
import { deliveryFor } from "./resend";
import { loadSettings } from "./cron";
import { getPerson } from "../auth/persons";
import type { InviteMailStatus, OrgRole } from "@shared/orgs";

/**
 * The invite lands on Trov's own sign-in screen (the site root), not a provider's account chooser:
 * the invitee signs in with GitHub or Google themselves and finds the invitation waiting. The email
 * names the address the invite is for, since the app cannot prefill it from here.
 */
export function inviteSignInUrl(origin: string): string {
  return `${origin}/`;
}

export interface InviteEmailInput {
  inviteeName: string | null;
  inviterName: string;
  /** The org's display name, as its admin wrote it. */
  orgName: string;
  /** What accepting grants. `owner` is the superadmin's "you have been made the owner" wording. */
  role: OrgRole;
  email: string;
  signInUrl: string;
  host: string;
}

const ROLE_PHRASE: Record<OrgRole, string> = { owner: "its owner", admin: "an admin", member: "a member" };

export function renderInviteEmail(o: InviteEmailInput): { subject: string; html: string; text: string } {
  const owner = o.role === "owner";
  const subject = owner ? `You have been made the owner of ${o.orgName} on Trov` : `${o.inviterName} invited you to ${o.orgName} on Trov`;
  const greeting = o.inviteeName ? `Hi ${o.inviteeName},` : "Hi,";
  const lede = owner ? `${o.orgName} is yours to set up.` : `You're invited to ${o.orgName} on Trov.`;
  const what = owner
    ? `${o.inviterName} added ${o.orgName} to Trov and named you ${ROLE_PHRASE.owner}. Sign in with this address and accept the invitation to connect your repository and invite your team.`
    : `${o.inviterName} invited you to join ${o.orgName} as ${ROLE_PHRASE[o.role]}. Sign in with this address and accept the invitation to get started.`;
  const about = "Trov is a team's shared memory: what everyone is working on, the docs and decisions behind it, and what ships next.";
  const forWhom = `This invitation is for ${o.email}. If you weren't expecting it, you can ignore this email.`;
  const p = `${EMAIL_FONT.sans}font-size:14px;line-height:20px;color:${C.fg70};padding:0 0 12px 0;`;
  const button = `display:inline-block;${EMAIL_FONT.sans}font-size:14px;line-height:20px;font-weight:600;color:#ffffff;background-color:${C.accent};text-decoration:none;padding:10px 18px;border-radius:9px;`;
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title><link href="${FONTS_HREF}" rel="stylesheet"><style>${EMAIL_MOBILE_CSS}</style></head>` +
    `<body style="margin:0;padding:0;background-color:${C.ground};">` +
    `<table ${EMAIL_STYLE.table} style="background-color:${C.ground};"><tr><td align="center" class="tm-pad" style="padding:36px 16px;">` +
    emailCardOpen() +
    emailBanner({ eyebrow: owner ? "Your organization" : "Invitation", title: escapeHtml(lede) }) +
    `<tr><td style="padding:${SP.xl}px 28px 0 28px;">` +
    `<div style="${p}color:${C.fg};">${escapeHtml(greeting)}</div>` +
    `<div style="${p}">${escapeHtml(what)}</div>` +
    `<div style="${EMAIL_FONT.sans}font-size:13px;line-height:20px;color:${C.fg55};padding:0 0 ${SP.l}px 0;">${about}</div>` +
    `<div style="text-align:center;padding:0 0 ${SP.l}px 0;"><a href="${escapeHtml(o.signInUrl)}" style="${button}">Sign in to Trov</a></div>` +
    `<div style="${EMAIL_FONT.sans}font-size:12.5px;line-height:20px;color:${C.fg55};padding-bottom:24px;">This invitation is for <span style="${EMAIL_FONT.sans}font-weight:500;color:${C.fg70};">${escapeHtml(o.email)}</span>. If you weren't expecting it, you can ignore this email.</div></td></tr>` +
    `<tr><td style="padding:16px 28px;border-top:1px solid ${C.border};${EMAIL_FONT.sans}font-size:12px;line-height:20px;color:${C.fg40};">Sent by Trov &middot; ${escapeHtml(o.host)}</td></tr>` +
    EMAIL_CARD_CLOSE + `</td></tr></table></body></html>`;
  const text = [
    subject, "=".repeat(subject.length), "",
    lede, "",
    greeting, "",
    what, "",
    about, "",
    "Sign in to Trov:", "",
    `  ${o.signInUrl}`, "",
    forWhom,
    `Sent by Trov — ${o.host}`, "",
  ].join("\n");
  return { subject, html, text };
}

export interface InviteMailOutcome { status: InviteMailStatus; at: string; id: string | null; error: string | null }

export interface SendInviteInput {
  /** The `org_invites` row the outcome is recorded on. */
  inviteId: number;
  email: string;
  inviteeName: string | null;
  inviterHandle: string;
  orgName: string;
  role: OrgRole;
  origin: string;
  fetchImpl?: typeof fetch;
}

/**
 * Send one invitation and record the outcome on its row. Never throws: a delivery failure (or a
 * misconfigured mode) is the `failed` outcome, because the invite itself is already written — the
 * person still sees it when they sign in, and an admin can send the mail again.
 * `ctx` is the inviting org (its sender name; in local mode, its bodies table); `p` reads the inviter.
 */
export async function sendInvite(env: Env, ctx: TenantContext, p: PlatformContext, o: SendInviteInput): Promise<InviteMailOutcome> {
  const at = nowIso();
  let result: InviteMailOutcome;
  try {
    const [inviter, settings] = await Promise.all([getPerson(p, o.inviterHandle), loadSettings(ctx)]);
    const msg = renderInviteEmail({
      inviteeName: o.inviteeName, inviterName: inviter?.name ?? o.inviterHandle, orgName: o.orgName, role: o.role, email: o.email,
      signInUrl: inviteSignInUrl(o.origin), host: o.origin.replace(/^https?:\/\//, "") || "trov",
    });
    const delivery = deliveryFor(ctx, env, { from: settings.from_address, fetchImpl: o.fetchImpl });
    const r = await delivery.send({ idempotencyKey: `invite:${o.inviteId}:${at}`, userId: o.email, to: o.email, subject: msg.subject, html: msg.html, text: msg.text });
    result = { status: "sent", at, id: r.id, error: null };
  } catch (e) {
    result = { status: "failed", at, id: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) };
  }
  // Scoped by the org as well as the id, so a mismatched pair can never stamp another org's invite.
  await platformRun(p, `UPDATE org_invites SET mail_status = ?, mail_at = ?, mail_error = ? WHERE id = ? AND org_id = ?`,
    result.status, result.at, result.error, o.inviteId, ctx.orgId).catch(() => undefined);
  return result;
}
