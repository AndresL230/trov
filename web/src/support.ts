// The support form — ONE dialog for writing to the people who run Trov (docs/architecture/support.md),
// in two settings:
//
//   SIGNED IN   opened by the bug button in the app header (on Bug), Contact support in Settings and the
//               org picker's link (on Question). A switch picks the kind, then a short subject and the
//               message; a read-only block says exactly what is attached — the screen, the organization,
//               the app version and the browser — and that nothing else is.
//   SIGNED OUT  (`anonymous`) opened by Contact in the site's footer, in the sign-in dialog's plain card.
//               The same form, plus the one thing nothing else can tell us: an email address to reply
//               to. It says plainly what is sent — what was typed, the page, the browser — and links the
//               Privacy Policy. It carries a honeypot field no person sees or reaches.
//
// After sending it says so, and where a reply will go; a failure keeps the text.
//
// Purely presentational: state in, markup out. The dialog is a root-level `data-overlay`, and its
// structure is STABLE while the form is up — the error and the counter are always emitted, shown by
// attribute — because support-actions.ts patches THIS element alone on a keystroke (morph.ts `morph`),
// so typing here never repaints the page behind, whatever screen that is.

import {
  SUPPORT_KINDS, SUPPORT_KIND_LABEL, SUPPORT_MESSAGE_MAX, SUPPORT_SUBJECT_MAX, SUPPORT_EMAIL_MAX, SUPPORT_HONEYPOT, isSupportEmail,
  type SupportKind,
} from "@shared/support-core";
import { esc, attr } from "./ui";
import { segmented } from "./segmented";

/** What is sent with the message — captured when the dialog opens, shown, and sent exactly as shown. */
export interface SupportContext {
  /** The screen: the route hash (`#tickets/7`). Signed out, the page: its path and hash (`/pricing`). */
  route: string;
  /** The organization's slug, or null outside one. */
  org: string | null;
  /** The app version (the top release). Not sent signed out. */
  version: string;
  userAgent: string;
}

export interface SupportDraft {
  open: boolean;
  /** Signed out: the site's Contact form — an email field, the public route, the plain card. */
  anonymous: boolean;
  kind: SupportKind;
  /** Signed out only: where to reply. */
  email: string;
  subject: string;
  message: string;
  context: SupportContext;
  /** When the form opened (ms): the public route refuses one sent sooner than a person can type it. */
  openedAt: number;
  busy: boolean;
  /** Why the last send failed, as a sentence. The text above it is kept. */
  error: string | null;
  /** Set once it was sent: where a reply will go (null = no verified address on file). */
  sent: { replyTo: string | null } | null;
}

export const blankContext = (): SupportContext => ({ route: "", org: null, version: "", userAgent: "" });
export const initialSupport = (): SupportDraft =>
  ({ open: false, anonymous: false, kind: "bug", email: "", subject: "", message: "", context: blankContext(), openedAt: 0, busy: false, error: null, sent: null });

/** Each kind's words: the dialog's title, what to write, and the send button. */
export const SUPPORT_COPY: Record<SupportKind, { title: string; lede: string; placeholder: string; send: string }> = {
  bug: { title: "Report a bug", lede: "Something broke or looks wrong. Tell us what you did and what happened.", placeholder: "What did you do, what did you expect, and what happened instead?", send: "Send report" },
  question: { title: "Contact support", lede: "Ask us anything about your account, your organization or how Trov works.", placeholder: "What are you trying to do?", send: "Send message" },
  feedback: { title: "Send feedback", lede: "Tell us what would make Trov better for you and your team.", placeholder: "What should change, or what is working well?", send: "Send feedback" },
};
/** Signed out, a question is not about "your account": the visitor may not have one. */
const ANON_QUESTION_LEDE = "Ask us anything about Trov, its plans or your account. We reply by email.";

/** The signed-in entries: the header's bug button opens on Bug, Settings' and the picker's on Question. */
export const SUPPORT_ENTRIES: readonly { kind: SupportKind; label: string }[] = [
  { kind: "bug", label: "Report a bug" },
  { kind: "question", label: "Contact support" },
];

/** What stops a send before it is tried (the Worker re-checks every one). */
export function supportProblem(d: Pick<SupportDraft, "subject" | "message"> & Partial<Pick<SupportDraft, "anonymous" | "email">>): string | null {
  if (d.anonymous && !isSupportEmail((d.email ?? "").trim())) return (d.email ?? "").trim() ? "Enter an email address, like name@example.com." : "Enter your email address, so we can reply.";
  if (!d.message.trim()) return "Write a message first.";
  if (d.message.trim().length > SUPPORT_MESSAGE_MAX) return `Keep the message to ${SUPPORT_MESSAGE_MAX.toLocaleString("en-US")} characters or fewer.`;
  if (d.subject.trim().length > SUPPORT_SUBJECT_MAX) return `Keep the subject to ${SUPPORT_SUBJECT_MAX} characters or fewer.`;
  return null;
}

/** The confirmation, in the dialog: it was sent, it will be read, and where a reply goes. */
export function supportSentSentence(replyTo: string | null, anonymous = false): string {
  if (anonymous) return replyTo ? `Sent. We'll reply to ${replyTo}.` : "Sent. We read every one.";
  return replyTo
    ? `Sent. We read every one; replies come to ${replyTo}.`
    : "Sent. We read every one. Your account has no verified email address on file, so we can't reply by email.";
}

/** The counter appears only near the cap (the last tenth), so it never nags a short message. */
export const supportCounter = (message: string): string => {
  const n = message.length;
  return n >= SUPPORT_MESSAGE_MAX * 0.9 ? `${n.toLocaleString("en-US")} / ${SUPPORT_MESSAGE_MAX.toLocaleString("en-US")}` : "";
};

const LABEL = "display:block;font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);margin-bottom:7px";
const FIELD = "display:block;width:100%;box-sizing:border-box;padding:0 12px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:13.5px;font-family:var(--sans);outline:none";
const BTN = "height:38px;padding:0 16px;border-radius:8px;font-size:12.5px;font-weight:600;white-space:nowrap";
const OPTIONAL = `<span style="text-transform:none;letter-spacing:0;font-weight:500">(optional)</span>`;
const CLOSE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;
const CHECK = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:1px"><path d="M20 6 9 17l-5-5"></path></svg>`;

/** The read-only block: what is attached, and that nothing else is. Signed in: four values. Signed
 *  out (`anonymous`): the page and the browser, said with what was typed, and the Privacy Policy. */
export function supportAttached(c: SupportContext, anonymous = false): string {
  const row = (label: string, value: string, mono = false) =>
    `<div class="cnpy-support-ctx-r"><dt>${label}</dt><dd${mono ? ` style="font-family:var(--code);font-size:11.5px"` : ""}>${esc(value)}</dd></div>`;
  const rows = anonymous
    ? `${row("Page", c.route || "/", true)}${row("Browser", c.userAgent || "Unknown")}`
    : `${row("Screen", c.route || "None", !!c.route)}
        ${row("Organization", c.org ?? "None: you are not inside an organization", !!c.org)}
        ${row("Version", c.version || "Unknown")}
        ${row("Browser", c.userAgent || "Unknown")}`;
  const foot = anonymous
    ? `We receive what you typed above, the page you were on and your browser. Nothing else. Your email address is used only to reply to you. <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>`
    : "Nothing else is attached: no page content, and nothing from your organization.";
  return `<div id="support-ctx" data-support-context role="group" aria-labelledby="support-ctx-l" class="cnpy-support-ctx" style="border:1px solid var(--border);border-radius:9px;padding:11px 14px">
      <div id="support-ctx-l" style="${LABEL};margin-bottom:8px">Sent with your message</div>
      <dl>
        ${rows}
      </dl>
      <div style="font-size:11.5px;line-height:1.5;color:var(--fg-40);margin-top:8px">${foot}</div>
    </div>`;
}

/** The dialog, or "" while it is closed. */
export function supportDialog(d: SupportDraft): string {
  if (!d.open) return "";
  const anon = d.anonymous;
  const copy = anon && d.kind === "question" ? { ...SUPPORT_COPY.question, lede: ANON_QUESTION_LEDE } : SUPPORT_COPY[d.kind];
  const dlg = `id="support-dlg" role="dialog" aria-modal="true" aria-labelledby="support-t" aria-describedby="support-d" tabindex="-1" data-support-dialog data-scroll-keep="support"${d.busy ? ` data-busy aria-busy="true"` : ""}`;
  const key = (k: string) => `support:${anon ? "anon:" : ""}${k}`;
  // Two cards, one form: the app's modal signed in; signed out, the site's sign-in card (its backdrop,
  // its entrance, its reduced-motion rule), wide enough for a message.
  const shell = (k: string, inner: string) => anon
    ? `<div data-overlay="support" data-support-layer data-support-anon>
    <div data-act="supportClose" class="site-signin-back"></div>
    <div class="site-signin-wrap">
      <div ${dlg} class="site-signin-card site-contact-card cnpy-scroll" style="border-radius:14px">
        <button type="button" data-act="supportClose" title="Close" aria-label="Close" class="site-signin-x"${d.busy ? " disabled" : ""} style="border-radius:8px">${CLOSE}</button>
        <div data-morph-key="${key(k)}">${inner}</div>
      </div>
    </div>
  </div>`
    : `<div data-overlay="support" data-support-layer class="cnpy-cmodal">
    <div data-act="supportClose" class="cnpy-cmodal-back" aria-hidden="true"></div>
    <div class="cnpy-cmodal-wrap">
      <div ${dlg} class="cnpy-surface cnpy-cmodal-box cnpy-scroll" style="position:relative;width:min(520px, 100%);max-height:calc(100vh - 32px);overflow-y:auto">
        <button type="button" data-act="supportClose" aria-label="Close" title="Close" class="cnpy-iconbtn"${d.busy ? " disabled" : ""} style="position:absolute;top:12px;right:12px;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;color:var(--fg-40)">${CLOSE}</button>
        <div data-morph-key="${key(k)}">${inner}</div>
      </div>
    </div>
  </div>`;

  if (d.sent) {
    return shell("sent", `<div id="support-t" style="padding-right:32px;font-size:16px;font-weight:600;letter-spacing:-0.01em">Thank you</div>
      <p id="support-d" role="status" data-support-sent style="display:flex;align-items:flex-start;gap:9px;margin:10px 0 0;font-size:13.5px;line-height:1.55;color:var(--fg-70);overflow-wrap:anywhere">${CHECK}<span>${esc(supportSentSentence(d.sent.replyTo, anon))}</span></p>
      <div class="cnpy-cmodal-btns" style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px">
        <button type="button" data-act="supportAgain" class="cnpy-outlinebtn" style="${BTN};border:1px solid var(--border-strong);font-weight:500;color:var(--fg-70)">Send another</button>
        <button type="button" data-act="supportClose" data-support-focus class="cnpy-accentbtn" style="${BTN};border:1px solid transparent;background:var(--accent);color:var(--accent-fg)">Done</button>
      </div>`);
  }

  const off = d.busy ? " disabled" : "";
  const ready = !d.busy && d.message.trim() !== "" && (!anon || d.email.trim() !== "");
  const counter = supportCounter(d.message);
  const over = d.message.trim().length > SUPPORT_MESSAGE_MAX;
  // Signed out only: who to answer — and the honeypot, a field named like one a script fills in. It is
  // off screen, out of the tab order and hidden from assistive technology; the Worker drops a body that
  // fills it. Uncontrolled: support-actions.ts reads it from the DOM when sending.
  const who = anon ? `<div style="margin-top:14px">
        <label for="support-email" style="${LABEL}">Your email</label>
        <input id="support-email" type="email" inputmode="email" data-act="supportEmail" data-field="supportEmail" value="${attr(d.email)}" maxlength="${SUPPORT_EMAIL_MAX}" placeholder="name@example.com" autocomplete="email" autocapitalize="off" spellcheck="false" required aria-required="true"${off} class="cnpy-input" style="${FIELD};height:38px" />
      </div>
      <div class="cnpy-support-hp" aria-hidden="true"><label for="support-${SUPPORT_HONEYPOT}">Website</label><input id="support-${SUPPORT_HONEYPOT}" name="${SUPPORT_HONEYPOT}" type="text" tabindex="-1" autocomplete="off" value="" /></div>` : "";
  return shell("form", `<div id="support-t" style="padding-right:32px;font-size:16px;font-weight:600;letter-spacing:-0.01em">${esc(copy.title)}</div>
      <p id="support-d" style="margin:6px 0 0;font-size:13px;line-height:1.55;color:var(--fg-55)">${esc(copy.lede)}</p>
      ${who}
      <div style="margin-top:16px">
        ${segmented({ id: "support-kind", ariaLabel: "What this is", act: "supportKind", value: d.kind, size: "sm", fill: true, inertOn: true, options: SUPPORT_KINDS.map((k) => ({ value: k, label: SUPPORT_KIND_LABEL[k], locked: d.busy })) })}
      </div>
      <div style="margin-top:14px">
        <label for="support-subject" style="${LABEL}">Subject ${OPTIONAL}</label>
        <input id="support-subject" data-act="supportSubject" data-field="supportSubject" value="${attr(d.subject)}" maxlength="${SUPPORT_SUBJECT_MAX}" placeholder="A short summary" autocomplete="off"${off} class="cnpy-input" style="${FIELD};height:38px" />
      </div>
      <div style="margin-top:14px">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px">
          <label for="support-message" style="${LABEL}">Message</label>
          <span data-support-counter aria-live="polite" style="font-size:11.5px;font-variant-numeric:tabular-nums;color:${over ? "var(--red)" : "var(--fg-40)"}">${esc(counter)}</span>
        </div>
        <textarea id="support-message" data-act="supportMessage" data-field="supportMessage" rows="6" maxlength="${SUPPORT_MESSAGE_MAX}" placeholder="${attr(copy.placeholder)}" required aria-required="true" aria-describedby="support-ctx support-err"${off} class="cnpy-input cnpy-scroll" style="${FIELD};min-height:${anon ? 108 : 132}px;max-height:40vh;padding:10px 12px;line-height:1.55;resize:vertical">${esc(d.message)}</textarea>
      </div>
      <div style="margin-top:14px">${supportAttached(d.context, anon)}</div>
      <div id="support-err" data-support-error role="alert"${d.error ? "" : " hidden"} style="font-size:12.5px;line-height:1.5;color:var(--red);margin-top:12px">${esc(d.error ?? "")}</div>
      <div class="cnpy-cmodal-btns" style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
        <button type="button" data-act="supportClose" class="cnpy-outlinebtn"${off} style="${BTN};border:1px solid var(--border-strong);font-weight:500;color:var(--fg-70)">Cancel</button>
        <button type="button" data-act="supportSend" data-support-send${ready ? ` class="cnpy-accentbtn"` : " disabled"}${d.busy ? ' aria-busy="true"' : ""} style="${BTN};${ready || d.busy ? "border:1px solid transparent;background:var(--accent);color:var(--accent-fg)" : "border:1px solid var(--border);background:transparent;color:var(--fg-40)"}">${esc(d.busy ? "Sending…" : copy.send)}</button>
      </div>`);
}
