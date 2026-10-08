// "Sign in, then come back here": the one other thing — besides an MCP client's authorize request
// (./oauth-routes.ts `oauth_pending`) — a sign-in can have been started FOR. Today that is a purchase:
// a signed-out visitor who pressed "Choose Pro" on the pricing page (src/billing/routes.ts).
//
// A sealed, HttpOnly, 10-minute cookie holding a PATH. It is never a URL a visitor supplied: the setter
// is handed a path the Worker built from validated parameters, and both ends check it against
// `ALLOWED`, so the cookie cannot become an open redirect even if the seal were forged. The sign-in
// tail (./routes.ts, through `takeOAuthPending`) takes it once and clears it.
import type { Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "./principal";
import { hmacSeal, hmacUnseal, b64uEncode, b64uDecode } from "./crypto";
import { PURCHASABLE_PLANS } from "@shared/billing";

export const RETURN_TO_COOKIE = "return_to";
const RETURN_TO_TTL_S = 600;

/** Every path a sign-in may return to. Exact shapes, no wildcards over a host or a scheme. */
const ALLOWED: RegExp[] = [new RegExp(`^/billing/start\\?plan=(?:${PURCHASABLE_PLANS.join("|")})(?:&interval=(?:month|year))?$`)];
export const isReturnPath = (path: string): boolean => ALLOWED.some((re) => re.test(path));

const seal = (secret: string): string => `return-to:${secret}`;

/** Remember `path` across the sign-in (and onboarding) that follows. A path that is not allowed is not stored. */
export async function setReturnTo(c: Context<AppEnv>, path: string, nowMs: number = Date.now()): Promise<void> {
  if (!isReturnPath(path)) return;
  const value = b64uEncode(JSON.stringify({ to: path, exp: nowMs + RETURN_TO_TTL_S * 1000 }));
  setCookie(c, RETURN_TO_COOKIE, await hmacSeal(value, seal(c.env.COOKIE_SECRET)), { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: RETURN_TO_TTL_S });
}

/** Where the person was going, or null. Always clears the cookie; a tampered, expired or malformed one is null. */
export async function takeReturnTo(c: Context<AppEnv>, nowMs: number = Date.now()): Promise<string | null> {
  const sealed = getCookie(c, RETURN_TO_COOKIE);
  if (!sealed) return null;
  deleteCookie(c, RETURN_TO_COOKIE, { path: "/" });
  const v = await hmacUnseal(sealed, seal(c.env.COOKIE_SECRET));
  if (!v) return null;
  try {
    const o = JSON.parse(b64uDecode(v)) as { to?: unknown; exp?: unknown };
    return typeof o.to === "string" && typeof o.exp === "number" && o.exp > nowMs && isReturnPath(o.to) ? o.to : null;
  } catch { return null; }
}
