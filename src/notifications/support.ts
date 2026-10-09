// The support notice: one transactional message to the platform's OPERATOR for every bug report or
// support message (0049_support_reports; docs/architecture/support.md). Modelled on the grant notice
// (./grant.ts): it belongs to no org, so it goes through the platform's delivery (`platformDeliveryFor`
// — the platform's own From; in local mode the global bodies table) and its outcome is recorded on the
// report's own row.
//
// The recipient is the var `SUPPORT_NOTIFY_EMAIL`; with none set nothing is sent and the outcome is
// `skipped` (the report is stored either way). `Reply-To` is the reporter's provider-VERIFIED address,
// so the operator's reply answers them. Everything a person typed is HTML-escaped, the subject is one
// line, and the provider key is scrubbed out of a failure BEFORE it is cut.
import type { Env } from "../env";
import { type PlatformContext, nowIso } from "../data/platform-sql";
import { escapeHtml } from "./html";
import { EMAIL_COLORS as C, EMAIL_FONT, FONTS_HREF, EMAIL_STYLE, EMAIL_SPACE as SP, emailBanner, emailCardOpen, EMAIL_CARD_CLOSE, EMAIL_MOBILE_CSS } from "./assemble";
import { platformDeliveryFor } from "./resend";
import { scrubbedMessage } from "../repo/github";
import { recordReportMail } from "../platform/support";
import { SUPPORT_KIND_LABEL, supportMailSubject, type SupportKind, type SupportMailStatus } from "@shared/support";

/** Where Platform › Support shows one report — outside any org, so the link needs no membership. */
export const supportReportUrl = (origin: string, id: number): string => `${origin}/platform/#platform/support/${id}`;

export interface SupportEmailInput {
  id: number;
  kind: SupportKind;
  subject: string;
  message: string;
  /** The signed-in sender (with their provider-VERIFIED address), or null for a report sent signed out. */
  reporter: { handle: string; name: string | null; email: string | null } | null;
  /** Signed out only: the address typed. UNVERIFIED — and attacker-controlled text, like everything else typed. */
  contactEmail?: string | null;
  org: { slug: string; name: string | null } | null;
  route: string | null;
  appVersion: string | null;
  userAgent: string | null;
  reportUrl: string;
  host: string;
}

export function renderSupportEmail(o: SupportEmailInput): { subject: string; html: string; text: string } {
  const subject = supportMailSubject(o.kind, o.subject);
  const anon = o.reporter === null;
  const replyTo = anon ? o.contactEmail ?? null : o.reporter!.email;
  const who = anon ? "Signed out" : `${o.reporter!.name ?? o.reporter!.handle} (@${o.reporter!.handle})`;
  const whoShort = anon ? "the sender" : o.reporter!.name ?? `@${o.reporter!.handle}`;
  const org = o.org ? `${o.org.name ?? o.org.slug} (${o.org.slug})` : anon ? "None: sent from the public site" : "None: sent from outside an organization";
  const rows: [label: string, value: string][] = anon
    ? [
      ["From", `Signed out · ${replyTo ?? "no address"} (unverified, as typed)`],
      ["Page", o.route ?? "Not given"],
      ["Browser", o.userAgent ?? "Not given"],
    ]
    : [
      ["From", replyTo ? `${who} · ${replyTo}` : `${who} · no verified email on file`],
      ["Organization", org],
      ["Screen", o.route ?? "Not given"],
      ["Version", o.appVersion ?? "Not given"],
      ["Browser", o.userAgent ?? "Not given"],
    ];
  const label = `${EMAIL_FONT.label}font-size:10.5px;line-height:16px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${C.fg40};white-space:nowrap;padding:0 14px 8px 0;vertical-align:top;`;
  const value = `${EMAIL_FONT.sans}font-size:13px;line-height:20px;color:${C.fg70};padding:0 0 8px 0;vertical-align:top;word-break:break-word;`;
  const button = `display:inline-block;${EMAIL_FONT.sans}font-size:14px;line-height:20px;font-weight:600;color:#ffffff;background-color:${C.accent};text-decoration:none;padding:10px 18px;border-radius:9px;`;
  const reply = replyTo
    ? `Reply to this email to answer ${escapeHtml(whoShort)} at <span style="${EMAIL_FONT.sans}font-weight:500;color:${C.fg70};">${escapeHtml(replyTo)}</span>${anon ? " — an address typed into the public form, which nobody verified" : ""}.`
    : `No provider-verified address is on file for ${escapeHtml(whoShort)}, so a reply to this email reaches nobody.`;
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title><link href="${FONTS_HREF}" rel="stylesheet"><style>${EMAIL_MOBILE_CSS}</style></head>` +
    `<body style="margin:0;padding:0;background-color:${C.ground};">` +
    `<table ${EMAIL_STYLE.table} style="background-color:${C.ground};"><tr><td align="center" class="tm-pad" style="padding:36px 16px;">` +
    emailCardOpen() +
    emailBanner({ eyebrow: escapeHtml(SUPPORT_KIND_LABEL[o.kind]), title: escapeHtml(o.subject), lede: `Report #${o.id} &middot; ${escapeHtml(who)}` }) +
    `<tr><td style="padding:${SP.xl}px 28px 0 28px;">` +
    `<div data-support-message style="${EMAIL_FONT.sans}font-size:14px;line-height:22px;color:${C.fg};white-space:pre-wrap;word-break:break-word;padding:0 0 ${SP.l}px 0;">${escapeHtml(o.message)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${C.border};"><tr><td style="padding:${SP.m}px 0 ${SP.s}px 0;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0">${rows.map(([l, v]) => `<tr><td style="${label}">${escapeHtml(l)}</td><td style="${value}">${escapeHtml(v)}</td></tr>`).join("")}</table>` +
    `</td></tr></table>` +
    `<div style="text-align:center;padding:${SP.s}px 0 ${SP.l}px 0;"><a href="${escapeHtml(o.reportUrl)}" style="${button}">Open in Platform</a></div>` +
    `<div style="${EMAIL_FONT.sans}font-size:12.5px;line-height:20px;color:${C.fg55};padding-bottom:24px;">${reply}</div></td></tr>` +
    `<tr><td style="padding:16px 28px;border-top:1px solid ${C.border};${EMAIL_FONT.sans}font-size:12px;line-height:20px;color:${C.fg40};">Sent by Trov &middot; ${escapeHtml(o.host)}</td></tr>` +
    EMAIL_CARD_CLOSE + `</td></tr></table></body></html>`;
  const text = [
    subject, "=".repeat(Math.min(subject.length, 72)), "",
    o.message, "",
    ...rows.map(([l, v]) => `${l}: ${v}`), "",
    "Open in Platform:", "",
    `  ${o.reportUrl}`, "",
    replyTo ? `Reply to this email to answer ${replyTo}${anon ? " (unverified, as typed)" : ""}.` : `No verified address is on file for ${whoShort}.`,
    `Sent by Trov — ${o.host}`, "",
  ].join("\n");
  return { subject, html, text };
}

export interface SupportMailOutcome { status: SupportMailStatus; at: string; error: string | null }

export interface SendSupportInput extends Omit<SupportEmailInput, "reportUrl" | "host"> {
  origin: string;
  fetchImpl?: typeof fetch;
}

/**
 * Mail one report to the operator and record the outcome on its row. NEVER throws: the report is
 * already stored and is in Platform › Support whether or not the mail left — a delivery failure, a
 * misconfigured mode or a failed write of the outcome must not fail the submission.
 */
export async function sendSupportNotice(env: Env, p: PlatformContext, o: SendSupportInput): Promise<SupportMailOutcome> {
  const at = nowIso();
  const to = (env.SUPPORT_NOTIFY_EMAIL ?? "").trim();
  let result: SupportMailOutcome;
  if (!to) {
    result = { status: "skipped", at, error: null };
  } else {
    try {
      const { origin, fetchImpl, ...report } = o;
      const msg = renderSupportEmail({ ...report, reportUrl: supportReportUrl(origin, o.id), host: origin.replace(/^https?:\/\//, "") || "trov" });
      await platformDeliveryFor(p, env, { fetchImpl }).send({
        idempotencyKey: `support:${o.id}:${at}`, userId: to, to, subject: msg.subject, html: msg.html, text: msg.text,
        // Reply-To is the ONLY place a typed address is ever used: Trov itself sends nothing to it.
        ...((o.reporter ? o.reporter.email : o.contactEmail) ? { replyTo: (o.reporter ? o.reporter.email : o.contactEmail)! } : {}),
      });
      result = { status: "sent", at, error: null };
    } catch (e) {
      // Scrub BEFORE the cut: a provider error may quote the request, and so the key, back.
      result = { status: "failed", at, error: scrubbedMessage(e, env.RESEND_API_KEY ?? "").slice(0, 500) };
    }
  }
  await recordReportMail(p, o.id, result).catch(() => undefined);
  return result;
}
