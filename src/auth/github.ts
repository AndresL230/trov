import type { Env } from "../env";

const USER_AGENT = "trov";
const GH_API = "application/vnd.github+json";

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  // user:email: the teammate email is seeded from GET /user/emails at first login
  // (canopy-email.md §7) — the profile email is unreliable (private / noreply). No
  // `read:org`: sign-in is not tied to any GitHub org's membership (§5.1).
  u.searchParams.set("scope", "read:user user:email");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/** Exchange an authorization code (+ PKCE verifier) for an access token; null on failure. */
export async function exchangeCode(opts: {
  env: Env;
  code: string;
  redirectUri: string;
  verifier: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({
      client_id: opts.env.GITHUB_CLIENT_ID,
      client_secret: opts.env.GITHUB_CLIENT_SECRET,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.verifier,
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}

/** The authenticated user's login + name + avatar_url, and `id` — the account's immutable numeric id (as a
 *  string), which outlives a rename of the login (0045); null on failure. */
export async function getUser(token: string, fetchImpl: typeof fetch = fetch): Promise<{ id: string | null; login: string; name: string | null; avatar_url: string | null } | null> {
  const res = await fetchImpl("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: GH_API, "user-agent": USER_AGENT },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { id?: number | string; login?: string; name?: string | null; avatar_url?: string | null };
  const id = typeof data.id === "number" || typeof data.id === "string" ? String(data.id) : null;
  return data.login ? { id, login: data.login, name: data.name ?? null, avatar_url: data.avatar_url ?? null } : null;
}

/**
 * The user's primary, verified GitHub address from GET /user/emails (needs the
 * user:email scope — this is how a PRIVATE profile email is still reachable).
 * null when none qualifies or the call fails; fetchImpl is injectable for tests.
 */
export async function getPrimaryEmail(token: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const res = await fetchImpl("https://api.github.com/user/emails", {
    headers: { authorization: `Bearer ${token}`, accept: GH_API, "user-agent": USER_AGENT },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { email?: string; primary?: boolean; verified?: boolean }[];
  const hit = Array.isArray(data) ? data.find((e) => e.primary === true && e.verified === true && e.email) : undefined;
  return hit?.email ?? null;
}
