// The ONE test both local stand-ins pass before they are honoured (`.dev.vars.example` lists them):
//   • `LOCAL_UPSTREAM`       — GitHub and Gemini during a Sync (src/sync/local-upstream.ts);
//   • `STRIPE_TEST_API_BASE` — Stripe's API (src/billing/config.ts).
// A stand-in is a server on THIS machine, so its value must be plain http on a loopback host, and it
// is never honoured beside a live key: a Worker that holds one is, or is talking to, production.
// (A deployed Worker cannot reach loopback at all; these rules do not rely on that.)
//
// Pure: no fetch, no D1, and no environment is read here — the Stripe key itself is read in ONE module
// (src/billing/config.ts, which asks `isLiveStripeKey` about it: `holdsLiveKey`, `billingConfig`).
// Anything may import this file.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** The ORIGIN of `value` when it is an `http://127.0.0.1[:port]` or `http://localhost[:port]` URL —
 *  any path on it is dropped — else null (unset, not a URL, https, any other host). */
export function loopbackOrigin(value: string | undefined | null): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname) ? u.origin : null;
  } catch {
    return null;
  }
}

/** A Stripe key that moves real money (`sk_live_…`, or a restricted `rk_live_…`) — the one credential
 *  of Trov's whose own form says it is live. */
export const isLiveStripeKey = (key: string | undefined | null): boolean => typeof key === "string" && /^(sk|rk)_live_/.test(key.trim());
