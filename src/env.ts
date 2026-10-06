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
  GITHUB_WEBHOOK_SECRET?: string; // HMAC key for the /webhook/github third auth class; absent → the surface 401s
  GITHUB_REPO?: string;   // "owner/repo" for live roadmap progress; absent → sprints without progress
  DEV_LOGIN?: string;     // LOCAL DEV ONLY (set in .dev.vars): bypass OAuth, act as this seeded user. Never set in prod.
  GEMINI_API_KEY?: string; // Google Gemini key for capture-time PR/issue summaries (REST generateContent); absent → excerpt fallback.
  GITHUB_SERVICE_TOKEN?: string; // app-level token for the scheduled progress-cache recompute backstop; absent → scheduled() no-ops
  PUBLIC_ORIGIN?: string; // absolute origin for links in email (deep links, unsubscribe); absent → relative links
  NOTIFICATIONS_MODE?: "local" | "resend"; // delivery gate; absent → local (bodies to the dev table, Resend never called)
  RESEND_API_KEY?: string; // Resend API key; required only when NOTIFICATIONS_MODE = "resend"
  REPO_ENVIRONMENTS?: string; // JSON RepoEnvConfig[] (src/repo/config.ts): which branch deploys to which environment, and its URLs
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
}
