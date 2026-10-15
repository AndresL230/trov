// The signed unsubscribe link (canopy-email.md §7) — the single exception to the no-token rule, because
// the only action the token can perform is setting email_unsubscribed = 1 for the handle it names. It is
// HMAC-SHA256 over the handle with COOKIE_SECRET (hmacSeal: `handle.sig`), never expires by design, and
// carries nothing else. It is the List-Unsubscribe target AND the footer link of every notification mail
// (the digests, the welcome); `handleUnsubscribe` answers it, from src/index.ts before the session gate.
import type { Env } from "../env";
import { hmacSeal, hmacUnseal } from "../auth/crypto";
import { platform } from "../data/context";
import { first, run } from "../data/platform-sql";
import { ROBOTS_TAG } from "../site";
import { scrubbedMessage } from "../repo/github";
import { unsubscribePage, unsubscribeInvalidPage, unsubscribeUnavailablePage } from "./unsubscribe-page";

const NS = "unsub"; // domain-separates the signature from session cookies

/** The path every unsubscribe link lives under. */
export const UNSUBSCRIBE_PREFIX = "/u/";
/** On a POST, marks the confirm page's own form (answered with a redirect back to the page); a POST
 *  without it is a mail client's RFC 8058 one-click (answered with JSON, as it always was). */
export const CONFIRM_PARAM = "confirm";

export async function unsubscribeToken(login: string, secret: string): Promise<string> {
  return hmacSeal(login, `${NS}:${secret}`);
}

/** The login the token was issued for, or null if malformed/tampered/foreign. */
export async function verifyUnsubscribeToken(token: string, secret: string): Promise<string | null> {
  return hmacUnseal(token, `${NS}:${secret}`);
}

export async function unsubscribeUrl(origin: string, login: string, secret: string): Promise<string> {
  return `${origin}${UNSUBSCRIBE_PREFIX}${await unsubscribeToken(login, secret)}`;
}

/** The page's headers: nothing may load (it needs nothing), nothing may frame it (the button), the token
 *  in its URL never leaves in a Referer, and it is never stored or indexed. */
const PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "X-Robots-Tag": ROBOTS_TAG,
};
const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * `/u/<token>`, with no session — the signed token is the whole authority, and the person it names is
 * the only one it can touch, whoever (if anyone) is signed in in this browser.
 *   • GET / HEAD: a page that says who the link is for and what unsubscribing stops, with a button.
 *     It CHANGES NOTHING: mail scanners and link previews fetch every link in a message.
 *   • POST (RFC 8058 one-click: what `List-Unsubscribe-Post` mail clients send): sets the flag; JSON.
 *   • POST `?confirm=1` (the page's button): sets the flag, then 303 back to the page, which now says so.
 * A token that does not verify writes nothing: the page says the link does not work (404), a POST is 401.
 */
export async function handleUnsubscribe(request: Request, env: Env, url: URL): Promise<Response> {
  const token = url.pathname.slice(UNSUBSCRIBE_PREFIX.length);
  const login = await verifyUnsubscribeToken(token, env.COOKIE_SECRET);
  const method = request.method;
  const page = (html: string, status: number) => new Response(method === "HEAD" ? null : html, { status, headers: PAGE_HEADERS });

  if (method === "GET" || method === "HEAD") {
    if (!login) return page(unsubscribeInvalidPage(), 404);
    try {
      const person = await first<{ handle: string; name: string | null; email: string | null; email_unsubscribed: number }>(
        platform(env, login), `SELECT handle, name, email, email_unsubscribed FROM persons WHERE handle = ?`, login);
      if (!person) return page(unsubscribeInvalidPage(), 404);
      return page(unsubscribePage({
        person: { handle: person.handle, name: person.name, email: person.email, unsubscribed: person.email_unsubscribed === 1 },
        action: `${UNSUBSCRIBE_PREFIX}${token}?${CONFIRM_PARAM}=1`,
      }), 200);
    } catch (e) {
      console.error("unsubscribe page", scrubbedMessage(e, env.COOKIE_SECRET).slice(0, 300));
      return page(unsubscribeUnavailablePage(), 503);
    }
  }

  if (method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD, POST" } });
  const fromPage = url.searchParams.has(CONFIRM_PARAM);
  if (!login) return fromPage ? page(unsubscribeInvalidPage(), 401) : json({ error: "unauthorized" }, 401);
  try {
    await run(platform(env, login), `UPDATE persons SET email_unsubscribed = 1 WHERE handle = ?`, login);
  } catch (e) {
    console.error("unsubscribe", scrubbedMessage(e, env.COOKIE_SECRET).slice(0, 300));
    return fromPage ? page(unsubscribeUnavailablePage(), 503) : json({ error: "temporarily_unavailable" }, 503);
  }
  if (fromPage) return new Response(null, { status: 303, headers: { Location: `${UNSUBSCRIBE_PREFIX}${token}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": ROBOTS_TAG } });
  return json({ ok: true }, 200);
}
