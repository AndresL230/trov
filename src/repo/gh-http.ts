// The GitHub REST / GraphQL helpers every repo-capture reader uses (moved out of ./github.ts unchanged, which
// re-exports them). NEVER on the render path: called from the webhook, reconcile, the cron and the pollers.

export interface GhOpts { token: string; repo: string; fetchImpl?: typeof fetch }

/** What this module LOGS for a failed GitHub read: the error's MESSAGE with the
 *  service token scrubbed — never the Error object. A thrown fetch, or a
 *  GraphQL `errors` body, may quote the request (and so the `authorization`
 *  header) back, and `ghGraphql` puts that body's message in what it throws.
 *  The result objects never needed this: `failed` holds arm NAMES only. */
export const scrubbedMessage = (e: unknown, token: string): string => {
  const message = e instanceof Error ? e.message : String(e);
  return token ? message.split(token).join("[redacted]") : message;
};
/** Every GitHub read is bounded, like every poller's fetch: an un-timed call
 *  let ONE hung connection hold a reconcile (and the refresh lock, and the
 *  admin's spinner) for as long as the platform allowed. A timeout is a thrown
 *  `TimeoutError`, so it surfaces exactly like any other failed read — in
 *  `reconcileRepo`, as that arm's name in `failed[]`. */
const GH_TIMEOUT_MS = 15_000;
const HEADERS = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "trov-worker" });

export async function ghJson<T>(opts: GhOpts, path: string): Promise<T> {
  const res = await (opts.fetchImpl ?? fetch)(`https://api.github.com/repos/${opts.repo}${path}`, { headers: HEADERS(opts.token), signal: AbortSignal.timeout(GH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`github ${res.status} ${path}`);
  return (await res.json()) as T;
}

/** `ghJson`, where a 404 is an ANSWER (`null`), not a failure — a ref with
 *  nothing posted on it, or one that does not exist yet. Every other non-2xx
 *  still throws. */
export async function ghJsonOrNull<T>(opts: GhOpts, path: string): Promise<T | null> {
  const res = await (opts.fetchImpl ?? fetch)(`https://api.github.com/repos/${opts.repo}${path}`, { headers: HEADERS(opts.token), signal: AbortSignal.timeout(GH_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github ${res.status} ${path}`);
  return (await res.json()) as T;
}

/** The GraphQL sibling of `ghJson`: same auth/user-agent, POSTed to the v4
 *  endpoint. GraphQL answers 200 with an `errors` array on a bad query or a
 *  missing repo, so a non-2xx is NOT the only failure — both throw, and the
 *  caller's `safely` arm turns either into a named entry in `failed`. */
export async function ghGraphql<T>(opts: GhOpts, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await (opts.fetchImpl ?? fetch)(`https://api.github.com/graphql`, {
    method: "POST",
    headers: { ...HEADERS(opts.token), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(GH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`github graphql ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message?: string }[] };
  if (body.errors?.length) throw new Error(`github graphql: ${body.errors.map((e) => e?.message ?? "error").join("; ")}`);
  return (body.data ?? ({} as T)) as T;
}

