// The sealed OAuth transaction every GitHub / Google round trip carries: a random `state`, a PKCE
// verifier and what the round trip is FOR, HMAC-sealed into a short-lived HttpOnly cookie. ./routes.ts
// opens it in the callback; the GitHub App's connect flow (src/github-app/connect.ts) starts one too.
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import type { AppEnv } from "./principal";
import { pkce, randomToken, hmacSeal } from "./crypto";

export const OAUTH_TX_COOKIE = "oauth_tx";

/**
 * The OAuth callback URL for this request. GitHub/Google require an https callback for
 * public hosts (http is only valid for localhost), so we force https for everything
 * except local dev. Without this, a request that reached the Worker over http (e.g.
 * before an edge http->https upgrade, or a bare-hostname browser navigation) would emit
 * an http redirect_uri that the provider rejects. The same value is used for the
 * authorize redirect and the token exchange, so they always match.
 */
export function callbackUrl(reqUrl: string, provider: "github" | "google" = "github"): string {
  const u = new URL(reqUrl);
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  const scheme = isLocal ? u.protocol.replace(/:$/, "") : "https";
  return `${scheme}://${u.host}${provider === "google" ? "/auth/google/callback" : "/auth/callback"}`;
}

/** What the round trip is for: sign in, link a second provider to the signed-in person, or — GitHub
 *  only — find the GitHub App installation an org admin wants to connect (`connect`). */
export type TxMode = "signin" | "link" | "connect";

export async function beginTx(c: Context<AppEnv>, mode: TxMode): Promise<{ state: string; challenge: string }> {
  const state = randomToken(16);
  const { verifier, challenge } = await pkce();
  const sealed = await hmacSeal(`${state}.${verifier}.${mode}`, c.env.COOKIE_SECRET);
  setCookie(c, OAUTH_TX_COOKIE, sealed, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
  return { state, challenge };
}
