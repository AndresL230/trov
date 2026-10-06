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
  GITHUB_WEBHOOK_SECRET?: string; // LEGACY: SaplingLearn's fallback for the old /webhook/github hook (src/data/secrets.ts `resolveCredential`); Phase 7 deletes it
  GITHUB_REPO?: string;   // LEGACY: read by nothing — an org's repo is its `org_repos` row (0037 copied this one); Phase 7 deletes it
  DEV_LOGIN?: string;     // LOCAL DEV ONLY (set in .dev.vars): bypass OAuth, act as this seeded user. Never set in prod.
  GEMINI_API_KEY?: string; // Google Gemini key for capture-time PR/issue summaries (REST generateContent); absent → excerpt fallback.
  GITHUB_SERVICE_TOKEN?: string; // LEGACY: SaplingLearn's `github_token` fallback until its admin stores one (`resolveCredential`); no other org ever reads it
  PUBLIC_ORIGIN?: string; // absolute origin for links in email (deep links, unsubscribe); absent → relative links
  NOTIFICATIONS_MODE?: "local" | "resend"; // delivery gate; absent → local (bodies to the dev table, Resend never called)
  RESEND_API_KEY?: string; // Resend API key; required only when NOTIFICATIONS_MODE = "resend"
  REPO_ENVIRONMENTS?: string; // LEGACY: read by nothing — environments are `org_environments` rows (0037 copied this one); Phase 7 deletes it
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
  // The GitHub App (issue #95; docs/superpowers/specs/2026-10-06-github-app-design.md) — PLATFORM secrets, set with
  // `wrangler secret put`, one App for every org. ALL SIX present = the App is configured (src/github-app/config.ts
  // `githubAppConfig`); any one absent → it is not, the install button is hidden and every org stays on its pasted
  // token + per-repo webhook. None of them is ever logged, returned or stored in D1.
  GITHUB_APP_ID?: string;             // the App's numeric id — the App JWT's `iss`
  GITHUB_APP_SLUG?: string;           // the App's URL name: https://github.com/apps/<slug>
  GITHUB_APP_CLIENT_ID?: string;      // the App's OAuth client id (the install flow's account check)
  GITHUB_APP_CLIENT_SECRET?: string;  // the App's OAuth client secret
  GITHUB_APP_PRIVATE_KEY?: string;    // the App's private key, PEM (PKCS#1 as GitHub issues it, or PKCS#8); `\n` escapes are accepted
  GITHUB_APP_WEBHOOK_SECRET?: string; // the App webhook's HMAC secret (`POST /webhook/github-app`)
}
