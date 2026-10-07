/** `id` is GitHub's immutable numeric account id (0042_organizations); omitted = the API returns none, as before. */
export interface FakeGithubUser { login: string; name?: string | null; avatar_url?: string | null; id?: number }

/**
 * A fake GitHub fetch for exercising the /auth/callback route end-to-end (token
 * exchange, user, primary-email) without the network. Injected as
 * `buildAuthApp({ fetchImpl })`. /user/emails returns
 * an empty list (no primary email) unless overridden via `emails`.
 */
export function fakeGithubFetch(
  user: FakeGithubUser = { login: "newdev", name: "New Dev", avatar_url: null },
  emails: { email: string; primary: boolean; verified: boolean }[] = [],
): typeof fetch {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://github.com/login/oauth/access_token")) return json({ access_token: "t" });
    if (url === "https://api.github.com/user") return json({ ...(user.id === undefined ? {} : { id: user.id }), login: user.login, name: user.name ?? null, avatar_url: user.avatar_url ?? null });
    if (url === "https://api.github.com/user/emails") return json(emails);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
