/**
 * The email's Unsubscribe link, `/u/<token>` (src/notifications/unsubscribe.ts), answered from src/index.ts
 * before the session gate — the one signed-token exception for mail:
 *   • a GET (the footer link, and every mail scanner's prefetch) is a page and CHANGES NOTHING;
 *   • the page's button (POST `?confirm=1`) unsubscribes exactly the person the token names, whoever is
 *     signed in in that browser, then 303s back to the page;
 *   • the RFC 8058 one-click POST mail clients send is unchanged: 200 `{ ok: true }`;
 *   • a bad or forged token is refused and writes nothing.
 * Assertions are on responses AND on the persons rows.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { hmacSeal } from "../src/auth/crypto";
import { unsubscribeToken, verifyUnsubscribeToken } from "../src/notifications/unsubscribe";
import { maskEmail } from "../src/notifications/unsubscribe-page";
import { STILL_SENT_SENTENCE } from "@shared/email-unsubscribe";
import { all, first, run } from "./helpers/db";
import { cookieFor, seedPerson } from "./helpers/persons";
import type { Env } from "../src/env";

const SECRET = "test-cookie-secret";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const wenv = env as unknown as Env;
const at = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://trov.example${path}`, init), wenv, ctx);
const ONE_CLICK: RequestInit = { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } };
const confirm = (cookie?: string): RequestInit => ({ method: "POST", body: "", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) } });
const flag = async (handle: string) => (await first<{ u: number }>(env.DB, `SELECT email_unsubscribed AS u FROM persons WHERE handle = ?`, handle))!.u;
/** Everything a click could have changed: every person's row and every pref. */
const snapshot = async () => JSON.stringify([await all(env.DB, `SELECT * FROM persons ORDER BY handle`), await all(env.DB, `SELECT * FROM notification_prefs ORDER BY user_id, kind`)]);
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

async function una(): Promise<string> {
  await seedPerson("una", { name: "Una Ames", email: "una@example.com" });
  await run(env.DB, `INSERT INTO notification_prefs (org_id, user_id, kind, cadence, updated_at) VALUES ('org_saplinglearn', 'una', 'my_work', 'weekly', 'x')`);
  return unsubscribeToken("una", SECRET);
}

describe("GET /u/<token> — a page that changes nothing", () => {
  it("names the token's person and what unsubscribing stops, with a button that POSTs the token; nothing is written, for a scanner's prefetch or a repeat", async () => {
    const token = await una();
    const before = await snapshot();
    for (let i = 0; i < 3; i++) {
      const res = await at(`/u/${token}`);
      expect(res.status).toBe(200);
      const page = await res.text();
      expect(page).toContain("Unsubscribe from Trov email?");
      expect(page).toContain("Una Ames");
      expect(page).toContain("@una");
      expect(page).toContain(maskEmail("una@example.com"));
      expect(maskEmail("una@example.com")).toBe("u•••@example.com");
      expect(page).not.toContain("una@example.com"); // masked: a forwarded mail's link does not read the address off
      expect(page).toContain(html(STILL_SENT_SENTENCE));
      expect(page).toMatch(new RegExp(`<form method="post" action="/u/${escRe(token)}\\?confirm=1"><button type="submit"[^>]*>Unsubscribe</button></form>`));
      expect(page).toContain('href="/#settings"'); // finer control, behind sign-in
    }
    const head = await at(`/u/${token}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(await snapshot()).toBe(before);
    expect(await flag("una")).toBe(0);
  });

  it("is noindex, unframeable, uncached, sends no Referer and loads nothing from anywhere", async () => {
    const res = await at(`/u/${await una()}`);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    const page = await res.text();
    expect(page).toContain('<meta name="robots" content="noindex">');
    expect(page).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|<link\b|<script\b|<img\b|@import|@font-face/i);
  });

  it("shows the token's person, never the person signed in in this browser", async () => {
    const token = await una();
    const cookie = await cookieFor("vic", { name: "Vic Viewer", email: "vic@example.com" });
    const res = await at(`/u/${token}`, { headers: { cookie } });
    const page = await res.text();
    expect(page).toContain("@una");
    expect(page).not.toMatch(/Vic Viewer|@vic|vic@example/);
    expect(await flag("una")).toBe(0);
    expect(await flag("vic")).toBe(0);
  });

  it("an already-unsubscribed person sees that, with no button and the way back in Settings", async () => {
    const token = await una();
    await run(env.DB, `UPDATE persons SET email_unsubscribed = 1 WHERE handle = 'una'`);
    const page = await (await at(`/u/${token}`)).text();
    expect(page).toContain("You&#39;re unsubscribed");
    expect(page).not.toContain("<form");
    expect(page).toContain('href="/#settings"');
  });
});

describe("POST /u/<token>?confirm=1 — the page's button", () => {
  it("unsubscribes exactly the token's person, even with a different person signed in, then 303s back to the page", async () => {
    const token = await una();
    const cookie = await cookieFor("vic", { name: "Vic Viewer", email: "vic@example.com" });
    await seedPerson("wes", { email: "wes@example.com" });
    const res = await at(`/u/${token}?confirm=1`, confirm(cookie));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/u/${token}`);
    expect(await flag("una")).toBe(1);
    expect(await flag("vic")).toBe(0); // the signed-in person is untouched
    expect(await flag("wes")).toBe(0);
    // Only the flag: the address and the prefs survive (turning email back on restores them).
    expect(await first(env.DB, `SELECT email FROM persons WHERE handle = 'una'`)).toEqual({ email: "una@example.com" });
    expect(await all(env.DB, `SELECT kind, cadence FROM notification_prefs WHERE user_id = 'una'`)).toEqual([{ kind: "my_work", cadence: "weekly" }]);
    // The page it returns to now says so.
    const page = await (await at(res.headers.get("location")!)).text();
    expect(page).toContain("You&#39;re unsubscribed");
  });
});

describe("POST /u/<token> — the RFC 8058 one-click, unchanged", () => {
  it("sets the flag and answers 200 { ok: true } as JSON, idempotently, with no session", async () => {
    const token = await una();
    for (let i = 0; i < 2; i++) {
      const res = await at(`/u/${token}`, ONE_CLICK);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toEqual({ ok: true });
      expect(await flag("una")).toBe(1);
    }
  });
});

describe("a bad or forged token is refused and writes nothing", () => {
  it("wrong secret, another key's signature, a swapped handle, garbage, nothing: a 404 page on GET, 401 on either POST", async () => {
    await una();
    await seedPerson("vic", { email: "vic@example.com" });
    const real = await unsubscribeToken("una", SECRET);
    const forged = [
      await unsubscribeToken("una", "wrong-secret"),            // signed with another secret
      await hmacSeal("una", SECRET),                            // the right secret, without the unsubscribe namespace (a session-style seal)
      `vic.${real.slice(real.indexOf(".") + 1)}`,               // una's signature on vic's handle
      `${real}x`,                                               // tampered signature
      "not-a-token",
      "",
    ];
    const before = await snapshot();
    for (const t of forged) {
      expect(await verifyUnsubscribeToken(t, SECRET), t).toBeNull();
      const get = await at(`/u/${t}`);
      expect(get.status, t).toBe(404);
      expect(get.headers.get("x-robots-tag"), t).toBe("noindex");
      const page = await get.text();
      expect(page, t).toContain("This link doesn&#39;t work");
      expect(page, t).not.toContain("<form");
      expect((await at(`/u/${t}?confirm=1`, confirm())).status, t).toBe(401);
      const oneClick = await at(`/u/${t}`, ONE_CLICK);
      expect(oneClick.status, t).toBe(401);
      expect(await oneClick.json(), t).toEqual({ error: "unauthorized" });
    }
    expect(await snapshot()).toBe(before);
    expect(await flag("una")).toBe(0);
    expect(await flag("vic")).toBe(0);
  });

  it("a genuine token for a handle nobody holds (renamed since) is the same not-valid page", async () => {
    const res = await at(`/u/${await unsubscribeToken("ghost", SECRET)}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("This link doesn&#39;t work");
  });

  it("any other method is 405 and writes nothing", async () => {
    const token = await una();
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await at(`/u/${token}`, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD, POST");
    }
    expect(await flag("una")).toBe(0);
  });
});
