// LOCAL DEVELOPMENT ONLY: a stand-in for GitHub and Gemini, so a Sync can be driven end to end in a
// browser against `wrangler dev` without either service (docs/architecture/sync.md › Trying it locally).
//
// `LOCAL_UPSTREAM` (a `.dev.vars` value, never a deployed secret) names a server on THIS machine. It is
// honoured only when it is plain http on a loopback host — anything else, including any https URL, is
// ignored — and a deployed Worker cannot reach loopback at all, so production behaves as if it were
// unset whatever it holds. With it set, a request Sync makes to `api.github.com` goes to
// `<base>/github/…` and one to `generativelanguage.googleapis.com` to `<base>/gemini/…`; every other
// request is untouched.
import type { Env } from "../env";

const STAND_IN: Record<string, string> = { "api.github.com": "github", "generativelanguage.googleapis.com": "gemini" };
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

/** The rewriting fetch, or undefined when `LOCAL_UPSTREAM` is unset or is not a loopback http URL. */
export function localUpstreamFetch(env: Pick<Env, "LOCAL_UPSTREAM">): typeof fetch | undefined {
  if (!env.LOCAL_UPSTREAM) return undefined;
  let base: URL;
  try { base = new URL(env.LOCAL_UPSTREAM); } catch { return undefined; }
  if (base.protocol !== "http:" || !LOOPBACK.has(base.hostname)) return undefined;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const prefix = STAND_IN[url.hostname];
    return prefix ? fetch(`${base.origin}/${prefix}${url.pathname}${url.search}`, init) : fetch(input, init);
  }) as typeof fetch;
}
