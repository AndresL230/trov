/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// Augment Cloudflare.Env so that env.DB and env.TEST_MIGRATIONS are typed
// in cloudflare:test (env is typed as Cloudflare.Env in @cloudflare/vitest-pool-workers v0.16+)
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ASSETS: Fetcher;
      ARTIFACTS_BUCKET: R2Bucket;
      TEST_MIGRATIONS: D1Migration[];
      MT_DB: D1Database;
      MT_ROLLBACK: D1Migration[];
      COOKIE_SECRET: string;
      GITHUB_CLIENT_ID: string;
      GITHUB_CLIENT_SECRET: string;
      GOOGLE_CLIENT_ID?: string;
      GOOGLE_CLIENT_SECRET?: string;
      GITHUB_WEBHOOK_SECRET?: string;
      GITHUB_REPO?: string;
      GITHUB_SERVICE_TOKEN?: string;
      GEMINI_API_KEY?: string;
      RESEND_API_KEY?: string;
      PUBLIC_ORIGIN?: string;
      NOTIFICATIONS_MODE?: "local" | "resend";
      REPO_ENVIRONMENTS?: string;
      CF_ANALYTICS_TOKEN?: string;
      CF_ANALYTICS_ACCOUNT_ID?: string;
      RAILWAY_TOKEN_STAGING?: string;
      RAILWAY_TOKEN_PRODUCTION?: string;
      SAPLING_METRICS_TOKEN?: string;
      TROV_KEK?: string;
      TROV_KEK_PREVIOUS?: string;
    }
  }
}
