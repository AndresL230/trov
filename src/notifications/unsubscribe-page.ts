// The page behind an email's Unsubscribe link (`GET /u/<token>`, src/notifications/unsubscribe.ts). Pure
// string templates; every dynamic value is escaped.
//
// A GET changes nothing: mail scanners and link previews fetch every link in a message, so the page only
// says WHO the link is for and WHAT unsubscribing stops, and a button POSTs the token back. There is no
// sign-in: the signed token names the person, and the only thing it can do is set their flag.
//
// It loads nothing from anywhere — no web font, no image, no script — so opening it tells no third
// party the reader's address, and its CSP (src/notifications/unsubscribe.ts) allows nothing else. It
// wears the OAuth pages' card (src/auth/oauth-pages.ts) in a system font: the purple banner, then the body.
import { trovMark } from "@shared/mark";
import { STILL_SENT_SENTENCE, UNSUBSCRIBE_STOPS } from "@shared/email-unsubscribe";
import { ROBOTS_TAG } from "../site";
import { escapeHtml as esc } from "./html";

/** Where finer control lives: Settings › Email notifications, behind sign-in (the app keeps the hash
 *  across it, and opens the person's organization). */
export const SETTINGS_PATH = "/#settings";

export interface UnsubscribeTarget {
  handle: string;
  name: string | null;
  /** The digest address on file (`persons.email`), shown masked. */
  email: string | null;
  unsubscribed: boolean;
}

/** `j•••@example.com`: enough for a person to recognise their address, not enough to read it off a
 *  forwarded mail. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 1 ? "•••" : `${email[0]}•••${email.slice(at)}`;
}

const CSS = `
:root{color-scheme:light;--bg:#f6f6f7;--card:#ffffff;--fg:#16161a;--fg-70:#4f4f58;--fg-55:#6e6e78;--border:rgba(20,20,30,.08);--border-strong:rgba(20,20,30,.15);--hover:rgba(20,20,30,.04);--accent:#5e6ad2;--accent-fg:#fff;--accent-soft:rgba(94,106,210,.12)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.card{width:min(440px,100%);border-radius:5.6px;overflow:hidden;background:var(--card);box-shadow:0 0 0 1px rgba(20,22,60,.07),0 1px 2px rgba(20,22,60,.04),0 12px 40px -12px rgba(20,22,60,.18)}
.card>:not(.head){margin-left:28px;margin-right:28px}
.card>:last-child{margin-bottom:26px}
.head{display:flex;flex-direction:column;align-items:flex-start;gap:16px;padding:24px 28px 26px;color:#fff;background:linear-gradient(135deg,#6c75d8 0%,#5a64cc 48%,#454fb2 100%)}
.brand{display:flex;align-items:center;gap:9px;font-size:16px;font-weight:600;letter-spacing:-.01em}
.title{font-size:23px;font-weight:600;letter-spacing:-.02em;line-height:1.2}
.who{margin-top:22px;padding:12px 14px;border:1px solid var(--border);border-radius:4px;background:var(--hover)}
.who-label{font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-55)}
.who-name{margin-top:3px;font-size:15px;font-weight:600;overflow-wrap:anywhere}
.who-handle{font-weight:500;color:var(--fg-70)}
.who-sub{margin-top:2px;font-size:12.5px;color:var(--fg-55);overflow-wrap:anywhere}
p{margin:16px 0 0;font-size:14px;line-height:1.55;color:var(--fg-70)}
.head+p{margin-top:22px}
p.sm{margin-top:10px;font-size:12.5px;color:var(--fg-55)}
form{margin-top:22px}
.btn{display:block;width:100%;padding:12px 16px;border-radius:3.6px;font:inherit;font-size:14px;font-weight:600;cursor:pointer;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg)}
.btn:hover{filter:brightness(1.06)}
.btn:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
a{color:var(--accent)}
.foot{padding:13px 28px;border-top:1px solid var(--border);background:rgba(20,20,30,.045);font-size:12.5px;line-height:1.5;color:var(--fg-55)}
.card>.foot:last-child{margin:22px 0 0}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="${ROBOTS_TAG}"><meta name="referrer" content="no-referrer">`
    + `<title>${esc(title)} · Trov</title><style>${CSS}</style></head><body><main class="card">${body}</main></body></html>`;
}

const head = (title: string): string =>
  `<div class="head"><span class="brand">${trovMark(18, "#fff")}Trov</span><span class="title">${esc(title)}</span></div>`;

function who(t: UnsubscribeTarget): string {
  const name = t.name ? `${esc(t.name)} <span class="who-handle">@${esc(t.handle)}</span>` : `@${esc(t.handle)}`;
  const address = t.email ? `<div class="who-sub">Digests go to ${esc(maskEmail(t.email))}</div>` : "";
  return `<div class="who"><div class="who-label">This link is for</div><div class="who-name">${name}</div>${address}</div>`;
}

const settingsLink = (text: string): string => `<a href="${SETTINGS_PATH}">${esc(text)}</a>`;

/**
 * The page a GET shows. Not yet unsubscribed: who, what it stops, what still arrives, and the button —
 * a form that POSTs to `action` (the same token). Already unsubscribed: the same facts, no button.
 */
export function unsubscribePage(o: { person: UnsubscribeTarget; action: string }): string {
  const p = o.person;
  if (p.unsubscribed) {
    return shell("You're unsubscribed", head("You're unsubscribed")
      + who(p)
      + `<p>Trov sends no email digests to @${esc(p.handle)}, in any organization.</p>`
      + `<p class="sm">${esc(STILL_SENT_SENTENCE)}</p>`
      + `<div class="foot">Changed your mind? Sign in and turn email back on in ${settingsLink("Settings")}.</div>`);
  }
  return shell("Unsubscribe from Trov email", head("Unsubscribe from Trov email?")
    + who(p)
    + `<p>${esc(UNSUBSCRIBE_STOPS)}</p>`
    + `<p class="sm">${esc(STILL_SENT_SENTENCE)}</p>`
    + `<form method="post" action="${esc(o.action)}"><button type="submit" class="btn">Unsubscribe</button></form>`
    + `<div class="foot">Want only some digests, or weekly instead of daily? Sign in and choose in ${settingsLink("Settings")}.</div>`);
}

/** A token that does not verify, or names nobody (a handle since renamed). Says nothing about whom. */
export function unsubscribeInvalidPage(): string {
  return shell("Link not valid", head("This link doesn't work")
    + `<p>It may have been cut short when it was copied, or the account it was for has changed its handle.</p>`
    + `<div class="foot">Sign in to stop or change Trov email in ${settingsLink("Settings")}.</div>`);
}

/** The store could not be read or written: nothing changed, try again. */
export function unsubscribeUnavailablePage(): string {
  return shell("Try again", head("Something went wrong")
    + `<p>Nothing was changed. Please try the link again in a minute.</p>`
    + `<div class="foot">You can also stop or change Trov email in ${settingsLink("Settings")}.</div>`);
}
