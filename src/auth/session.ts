import type { Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { type PlatformContext, first, run } from "../data/platform-sql";
import { randomToken, hmacSeal, hmacUnseal } from "./crypto";

/** Exported for `/` alone (src/site.ts), which serves the app shell instead of the landing page to a
 *  request that CARRIES one — a hint, never a check: the cookie is verified only here, below. */
export const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(p: PlatformContext, handle: string): Promise<{ id: string; expiresAt: string }> {
  const id = randomToken(32);
  const now = Date.now();
  const created_at = new Date(now).toISOString();
  const expires_at = new Date(now + SESSION_TTL_MS).toISOString();
  await run(p, `INSERT INTO sessions (id, person, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    id, handle, created_at, expires_at);
  return { id, expiresAt: expires_at };
}

export async function getSessionUser(p: PlatformContext, id: string): Promise<string | null> {
  const row = await first<{ person: string; expires_at: string }>(
    p, `SELECT person, expires_at FROM sessions WHERE id = ?`, id);
  if (!row) return null;
  if (!sessionLive(row.expires_at)) return null;
  return row.person;
}

/** A session row is good until its `expires_at` — the ONE expiry rule, for `getSessionUser` and for the
 *  session gate's merged read on `/api/o/:slug/*` (src/data/context.ts `resolveSessionTenant`). */
// (Written as "not expired" rather than "> now", exactly as the check it was lifted from.)
export const sessionLive = (expiresAt: string): boolean => !(new Date(expiresAt).getTime() <= Date.now());

export async function deleteSession(p: PlatformContext, id: string): Promise<void> {
  await run(p, `DELETE FROM sessions WHERE id = ?`, id);
}

export async function setSessionCookie(c: Context, id: string, secret: string): Promise<void> {
  setCookie(c, SESSION_COOKIE, await hmacSeal(id, secret), {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function readSessionCookie(c: Context, secret: string): Promise<string | null> {
  const sealed = getCookie(c, SESSION_COOKIE);
  return sealed ? hmacUnseal(sealed, secret) : null;
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
