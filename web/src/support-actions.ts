// The support form's controller (web/src/support.ts holds the view). Every `support…` act main.ts
// dispatches lands here — from the app (the header's bug button, Settings › Contact support, the org
// picker's link) and, signed out, from the site's footer (Contact): the same dialog in its anonymous
// setting, sent to the public route.
//
// PAINTING. Opening and closing are an ordinary `rerender()`. Everything that happens INSIDE the open
// dialog — a keystroke, the kind switch, the send's busy / failed / sent states — repaints the dialog
// ALONE: `repaint()` renders it again and patches the live `data-overlay` element in place (morph.ts
// `morph`). The dialog opens over any screen, and most screens are rebuilt wholesale by `rerender()`;
// a rerender per keystroke would rebuild the page behind the form on every letter
// (docs/architecture/web-ui.md › "A repaint REBUILDS a page"). State stays the one source of truth, so
// a rerender caused by anything else (a read landing) paints the same dialog.

import { ApiError, Unauthorized, rateLimitText, submitSupport, submitSupportPublic } from "./api";
import { morph } from "./morph";
import { syncSegments } from "./segmented";
import { initialSupport, supportDialog, supportProblem, type SupportContext, type SupportDraft } from "./support";
import { SUPPORT_FALLBACK_EMAIL, SUPPORT_HONEYPOT, isSupportKind, type SupportKind } from "@shared/support-core";

export interface SupportHost {
  state: { support: SupportDraft };
  mount: HTMLElement;
  rerender(): void;
  unauth(e: unknown): void;
  /** Is somebody signed in? If not, the dialog is the site's Contact form (an email field, the public route). */
  signedIn(): boolean;
  /** What is attached, read NOW: the route on screen, the org the person is in, the version, the browser. */
  context(): SupportContext;
}

/** What a failed send says. What the person wrote is never touched: only this sentence changes. */
export function supportFailure(e: unknown, anonymous = false): string {
  const code = e instanceof ApiError ? e.message : "";
  // The day's cap on signed-out reports is spent: the form cannot take it, the address can.
  if (code === "support_closed") return `We can't take messages through this form right now. Email ${SUPPORT_FALLBACK_EMAIL} instead. What you wrote is still here to copy.`;
  if (code === "too_fast") return "That was quick. Give it a moment, then send again.";
  const limited = rateLimitText(e);
  if (limited) return anonymous ? `${limited.replace("for this", "for messages from this form")} Or email ${SUPPORT_FALLBACK_EMAIL}.` : limited.replace("for this", "for messages to support");
  if (e instanceof ApiError && e.status === 400) return anonymous ? "That couldn't be accepted. Check the email address, shorten the message if it is long, and try again." : "That message couldn't be accepted. Shorten it and try again.";
  return "Your message wasn't sent. Check your connection and try again. What you wrote is still here.";
}

export function createSupport(h: SupportHost) {
  const { mount } = h;
  const s = (): SupportDraft => h.state.support;
  const focus = (sel: string): void => { mount.querySelector<HTMLElement>(sel)?.focus(); };
  /** The entry that opened the dialog (the header's button, Settings', the footer's): focus goes back there on close. */
  let openerKind: string | null = null;
  /** The trigger a click just landed on (capture phase: before main.ts dispatches its act). */
  let clicked: string | null = null;
  mount.addEventListener("click", (e) => {
    clicked = (e.target as Element | null)?.closest?.("[data-support-trigger]")?.getAttribute("data-support-trigger") ?? null;
  }, true);

  /** Patch the open dialog in place; nothing else on the page is touched. */
  function repaint(): void {
    const live = mount.querySelector<HTMLElement>('[data-overlay="support"]');
    const html = supportDialog(s());
    if (!live || !html) { h.rerender(); return; }
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    const next = tpl.content.firstElementChild;
    if (!next) return;
    morph(live, next);
    syncSegments(mount); // the kind switch's fill slides to the option just picked
  }

  function open(kind: SupportKind): void {
    const d = s();
    if (d.busy) return;
    // The opener: the focused trigger, else the one just clicked (a click does not focus a button in
    // every browser).
    const active = document.activeElement;
    openerKind = (active instanceof HTMLElement ? active.getAttribute("data-support-trigger") : null) ?? clicked;
    clicked = null;
    // A draft left behind by Escape is still there; only what was SENT starts over.
    if (d.sent) Object.assign(d, initialSupport());
    d.open = true; d.kind = kind; d.error = null; d.context = h.context();
    d.anonymous = !h.signedIn(); d.openedAt = Date.now();
    h.rerender();
    focus(d.anonymous && !d.email ? "#support-email" : "#support-subject");
  }

  function close(): void {
    const d = s();
    if (!d.open || d.busy) return;
    if (d.sent) Object.assign(d, initialSupport());
    d.open = false; d.error = null;
    h.rerender();
    // The opener may have been replaced by a paint since: find it again by its hook.
    (mount.querySelector<HTMLElement>(`[data-support-trigger="${openerKind ?? ""}"]`) ?? mount.querySelector<HTMLElement>("[data-support-trigger]"))?.focus();
    openerKind = null;
  }

  function send(): void {
    const d = s();
    if (!d.open || d.busy || d.sent) return;
    const problem = supportProblem(d);
    if (problem) { d.error = problem; repaint(); focus(d.anonymous && problem.includes("email") ? "#support-email" : "#support-message"); return; }
    const anon = d.anonymous;
    // The honeypot is uncontrolled: whatever is in it now is sent, and the Worker drops a body that has any.
    const trap = anon ? mount.querySelector<HTMLInputElement>(`#support-${SUPPORT_HONEYPOT}`)?.value ?? "" : "";
    d.busy = true; d.error = null;
    repaint();
    const c = d.context;
    const sending: Promise<{ reply_to: string | null }> = anon
      ? submitSupportPublic({ email: d.email.trim(), kind: d.kind, subject: d.subject.trim(), message: d.message.trim(), page: c.route || null, website: trap, elapsed_ms: Date.now() - d.openedAt })
      : submitSupport({ kind: d.kind, subject: d.subject.trim(), message: d.message.trim(), route: c.route || null, org: c.org, app_version: c.version || null, user_agent: c.userAgent || null });
    sending
      .then((r) => {
        const cur = s();
        cur.busy = false; cur.error = null; cur.subject = ""; cur.message = ""; cur.sent = { replyTo: r.reply_to };
        if (!cur.open) return;
        repaint();
        focus("[data-support-focus]");
      })
      .catch((e) => {
        const cur = s();
        cur.busy = false;
        if (!anon && e instanceof Unauthorized) { cur.open = false; h.unauth(e); return; }
        cur.error = supportFailure(e, anon);
        if (!cur.open) return;
        repaint();
        focus("#support-message");
      });
  }

  /** Every `support…` act. */
  function act(name: string, arg: string | null, value: string | null): void {
    const d = s();
    switch (name) {
      case "supportOpen": open(isSupportKind(arg) ? arg : "question"); return;
      case "supportClose": close(); return;
      case "supportKind":
        if (!d.open || d.busy || d.sent || !isSupportKind(arg)) return;
        d.kind = arg;
        break;
      case "supportEmail": if (!d.open || d.busy) return; d.email = value ?? ""; d.error = null; break;
      case "supportSubject": if (!d.open || d.busy) return; d.subject = value ?? ""; break;
      case "supportMessage":
        if (!d.open || d.busy) return;
        d.message = value ?? "";
        d.error = null; // they are fixing it
        break;
      case "supportSend": send(); return;
      case "supportAgain":
        if (!d.open || d.busy) return;
        Object.assign(d, initialSupport(), { open: true, kind: d.kind, anonymous: d.anonymous, email: d.email, context: h.context(), openedAt: Date.now() });
        repaint();
        focus("#support-subject");
        return;
      default: return;
    }
    repaint();
  }

  // The dialog's keyboard: Escape closes it (not mid-send), ⌘/Ctrl+Enter sends, Tab stays inside it.
  document.addEventListener("keydown", (e) => {
    if (!s().open) return;
    const dlg = mount.querySelector<HTMLElement>("[data-support-dialog]");
    if (!dlg) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.repeat) { e.preventDefault(); send(); return; }
    if (e.key !== "Tab") return;
    // The honeypot (`tabindex="-1"`) is never a stop.
    const items = Array.from(dlg.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]), a[href]'));
    if (!items.length) { e.preventDefault(); dlg.focus(); return; }
    const at = items.indexOf(document.activeElement as HTMLElement);
    const last = items.length - 1;
    if (at < 0 || (e.shiftKey && at === 0) || (!e.shiftKey && at === last)) { e.preventDefault(); items[e.shiftKey ? last : 0].focus(); }
  });

  return { act, open, close };
}
