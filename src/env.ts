import type { Database } from "./data/context";

export interface Env {
  DB: Database; // reached only through a context (src/data/) — test/data-layer.static.test.ts

  ASSETS: Fetcher;
  ARTIFACTS_BUCKET: R2Bucket; // binary artifact bytes at `artifacts/<sha256>` (src/tools/artifacts.ts)
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID?: string;     // Google OAuth client (second session-class provider); absent → /auth/google/login 503s
  GOOGLE_CLIENT_SECRET?: string; // Google OAuth client secret
  COOKIE_SECRET: string;
  // The GitHub App (docs/architecture/github-app.md). GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET above are the SAME
  // App's — it signs people in as well. The three secrets and the one var below are what let an org connect its
  // repositories by installing it. Missing any of slug / id / key → Org settings offers only the pasted-token
  // path and says the App is not configured on this deployment; nothing 500s.
  GITHUB_APP_ID?: string;             // SECRET — the App's numeric id (the JWT's `iss`)
  GITHUB_APP_PRIVATE_KEY?: string;    // SECRET — the whole .pem GitHub generated (PKCS#1; a PKCS#8 PEM works too). Signs the App JWT; never logged
  GITHUB_APP_WEBHOOK_SECRET?: string; // SECRET — verifies deliveries to POST /webhook/github/app. Absent → every delivery there is the bare 401
  GITHUB_APP_SLUG?: string;           // VAR (wrangler.toml) — the App's URL name: https://github.com/apps/<slug>/installations/new
  GITHUB_WEBHOOK_SECRET?: string; // LEGACY: SaplingLearn's fallback for the old /webhook/github hook (src/data/secrets.ts `resolveCredential`); Phase 7 deletes it
  GITHUB_REPO?: string;   // LEGACY: read by nothing — an org's repo is its `org_repos` row (0042_organizations copied this one); Phase 7 deletes it
  DEV_LOGIN?: string;     // LOCAL DEV ONLY (set in .dev.vars): bypass OAuth, act as this seeded user. Never set in prod.
  GEMINI_API_KEY?: string; // Google Gemini key for capture-time PR/issue summaries (REST generateContent); absent → excerpt fallback.
  LOCAL_UPSTREAM?: string; // LOCAL DEV ONLY (.dev.vars): a loopback http stand-in for GitHub + Gemini during a Sync (src/sync/local-upstream.ts). Ignored unless http://127.0.0.1 or http://localhost, and always beside a live Stripe key (src/platform/loopback.ts).
  GITHUB_SERVICE_TOKEN?: string; // LEGACY: SaplingLearn's `github_token` fallback until its admin stores one (`resolveCredential`); no other org ever reads it
  PUBLIC_ORIGIN?: string; // absolute origin for links in email (deep links, unsubscribe); absent → relative links
  NOTIFICATIONS_MODE?: "local" | "resend"; // delivery gate; absent → local (bodies to the dev table, Resend never called)
  RESEND_API_KEY?: string; // Resend API key; required only when NOTIFICATIONS_MODE = "resend"
  REPO_ENVIRONMENTS?: string; // LEGACY: read by nothing — environments are `org_environments` rows (0042_organizations copied this one); Phase 7 deletes it
  // The five below are LEGACY too: SaplingLearn's fallback credentials (`resolveCredential`), each read only until its
  // admin stores that integration on Org settings › Integrations, and never for another org. What each one is:
  // Both SECRETS, and both needed: absent either → the hourly Cloudflare analytics poll (src/repo/poll.ts) is skipped
  // and the Usage tab's requests/error-rate + Cloudflare panel stay not_connected. Deliberately NOT named
  // CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — those are the names the wrangler CLI authenticates with.
  CF_ANALYTICS_TOKEN?: string;      // Cloudflare API token with Account Analytics: Read
  CF_ANALYTICS_ACCOUNT_ID?: string; // the Cloudflare account tag the frontend Workers live under
  // SECRETS — Railway PROJECT tokens, ONE PER ENVIRONMENT (a project token is bound to a single environment of a
  // single project), named `RAILWAY_TOKEN_<cfg.key upper-cased>` and sent as `Project-Access-Token`, never as a
  // bearer. Absent → the hourly Railway poll (src/repo/poll.ts) skips THAT environment; absent both → it is not
  // called and the hosting block stays not_connected. Railway has no read-only scope: these are NOT read-only.
  // A third environment needs only its secret (src/repo/cron.ts looks the name up) — plus a line here for the type.
  RAILWAY_TOKEN_STAGING?: string;
  RAILWAY_TOKEN_PRODUCTION?: string;
  // SECRET — the bearer token Sapling's own `GET {apiUrl}/api/internal/metrics` expects (the contract:
  // docs/superpowers/specs/2026-09-20-sapling-metrics-endpoint.md). ONE value for every environment, sent only to
  // an https `apiUrl` and never across a redirect. Absent/empty → the hourly active-users poll (src/repo/poll.ts)
  // is not called and the Usage tab's Active users stays "not connected".
  SAPLING_METRICS_TOKEN?: string;
  // SECRET — the key-encryption key for per-org integration secrets (src/data/secrets.ts; canopy-multitenancy.md
  // §8.7.1): 32 random bytes, base64 (`openssl rand -base64 32`). It wraps each org's data key and never encrypts
  // a credential itself. Absent or malformed → every secret read and write fails closed (the Integrations API
  // answers 503 `secrets_unavailable`); nothing is ever stored in plaintext instead. LOSING IT loses every org's
  // stored credentials. TROV_KEK_PREVIOUS is set only during a KEK rotation: the old key, picked by fingerprint.
  TROV_KEK?: string;
  TROV_KEK_PREVIOUS?: string;
  // BILLING — Stripe (docs/architecture/billing.md; src/billing/config.ts is the only reader). Two SECRETS and the
  // price ids as VARS (wrangler.toml). Absent the key or the webhook secret → billing is off: every billing route
  // answers 503 `billing_unavailable`, the purchase buttons say so, and nothing else in the app changes. A plan
  // with no price id is not purchasable. Test mode or live mode is whichever key is set (`sk_test_…` / `sk_live_…`).
  STRIPE_SECRET_KEY?: string;     // SECRET — sent only as the bearer of a request to api.stripe.com (src/billing/stripe.ts); never logged
  STRIPE_WEBHOOK_SECRET?: string; // SECRET — the `whsec_…` of the endpoint POST /webhook/stripe; absent → every delivery there is the bare 401
  STRIPE_PRICE_TEAM?: string;            // VAR — the Stripe Price id (`price_…`) of ONE SEAT of Trov Pro (plan id `team`), monthly
  STRIPE_PRICE_TEAM_YEARLY?: string;     // VAR — optional yearly per-seat price; Pro is offered on the intervals it has a price for
  // LOCAL / TEST ONLY: a stand-in for api.stripe.com. Honoured ONLY for a loopback http origin (127.0.0.1 /
  // localhost) and ONLY with a key that is not a live one, so production — where it is unset, and where a
  // Worker cannot reach loopback anyway — always talks to api.stripe.com.
  STRIPE_TEST_API_BASE?: string;
}
