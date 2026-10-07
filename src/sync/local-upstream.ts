// LOCAL DEVELOPMENT ONLY: a stand-in for GitHub and Gemini, so a Sync can be driven end to end in a
// browser against `wrangler dev` without either service (docs/architecture/sync.md › Trying it locally).
//
// `LOCAL_UPSTREAM` (a `.dev.vars` value, never a deployed secret) names a server on THIS machine. It is
// honoured only when it is plain http on a loopback host — anything else, including any https URL, is
// ignored — and never while the Worker holds a live Stripe key (`holdsLiveKey`; with
// src/platform/loopback.ts it is the test `STRIPE_TEST_API_BASE` passes too). A deployed Worker cannot reach loopback at all, so production behaves as if it were
// unset whatever it holds. With it set, a request Sync makes to `api.github.com` goes to
// `<base>/github/…` and one to `generativelanguage.googleapis.com` to `<base>/gemini/…`; every other
// request is untouched.
import type { Env } from "../env";
import { holdsLiveKey, type LiveKeyEnv } from "../billing/config";
import { loopbackOrigin } from "../platform/loopback";

const STAND_IN: Record<string, string> = { "api.github.com": "github", "generativelanguage.googleapis.com": "gemini" };

/** The rewriting fetch, or undefined when `LOCAL_UPSTREAM` is unset, is not a loopback http URL, or
 *  the deployment holds a live key. */
export function localUpstreamFetch(env: Pick<Env, "LOCAL_UPSTREAM"> & LiveKeyEnv): typeof fetch | undefined {
  const origin = loopbackOrigin(env.LOCAL_UPSTREAM);
  if (!origin || holdsLiveKey(env)) return undefined;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const prefix = STAND_IN[url.hostname];
    return prefix ? fetch(`${origin}/${prefix}${url.pathname}${url.search}`, init) : fetch(input, init);
  }) as typeof fetch;
}
