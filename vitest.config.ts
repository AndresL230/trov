import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";

// A THROWAWAY RSA key for the GitHub App tests, made fresh on every run and never written anywhere: the
// private half as GitHub issues it (PKCS#1 PEM) and as PKCS#8, the public half as a JWK to verify with.
const testAppKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.join(import.meta.dirname, "shared"),
    },
  },
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.toml" },
      // No remote bindings: capture-time summaries go to Gemini over a plain
      // fetch() (not a Cloudflare binding), and GEMINI_API_KEY is BLANKED in the
      // bindings below (a local `.dev.vars` would otherwise leak it into the pool),
      // so both summarizer construction sites resolve to null → the excerpt
      // fallback. Summarizer behavior is exercised via dependency-injected stubs
      // (and a stubbed fetchImpl), never the network — the suite stays green and
      // hermetic (real D1 via Miniflare, no remote session).
      remoteBindings: false,
      miniflare: {
        // exposed to tests as env.TEST_MIGRATIONS; applied in the setup file
        // A second, EMPTY database for the multitenancy migration tests (test/migrations.multitenancy.test.ts):
        // they build a 0036 + 0041 database with data, apply the organizations migration and its rollback, and
        // compare — never touching DB, which the setup file has already migrated. DB is restated so this list
        // cannot drop it.
        d1Databases: { DB: "80386dc4-deef-461d-932a-0670d22ddf83", MT_DB: "multitenancy-migration-test" },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(import.meta.dirname, "migrations")
          ),
          // The generated rollback (scripts/mt/build-rollback.py — one file), split into statements the same way.
          MT_ROLLBACK: await readD1Migrations(path.join(import.meta.dirname, "scripts", "mt", "rollback")),
          COOKIE_SECRET: "test-cookie-secret",
          GITHUB_CLIENT_ID: "test-client-id",
          GITHUB_CLIENT_SECRET: "test-client-secret",
          GOOGLE_CLIENT_ID: "test-google-client-id",
          GOOGLE_CLIENT_SECRET: "test-google-secret",
          GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
          // The GitHub App (src/github-app/): configured in the pool, with the throwaway key above. No org has
          // an installation unless a test binds one, so nothing reads GitHub through it by default.
          GITHUB_APP_ID: "424242",
          GITHUB_APP_SLUG: "trov-test",
          GITHUB_APP_WEBHOOK_SECRET: "test-app-webhook-secret",
          GITHUB_APP_PRIVATE_KEY: testAppKey.privateKey.export({ type: "pkcs1", format: "pem" }) as string,
          TEST_GITHUB_APP_PKCS8: testAppKey.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
          TEST_GITHUB_APP_PUBLIC_JWK: JSON.stringify(testAppKey.publicKey.export({ format: "jwk" })),
          // SaplingLearn's repository and environments as they were when they lived in wrangler.toml [vars].
          // The Worker reads neither any more (`org_repos` / `org_environments`); the one-org suites copy
          // them into its rows (test/helpers/org-config.ts `syncOrgConfig`).
          GITHUB_REPO: "SaplingLearn/sapling",
          REPO_ENVIRONMENTS: "[{\"key\":\"staging\",\"label\":\"staging\",\"note\":\"main\",\"branch\":\"main\",\"railwayEnv\":\"Sapling / staging\",\"worker\":\"frontend-staging\",\"workerCheck\":\"Workers Builds: frontend-staging\",\"frontendUrl\":\"https://staging.saplinglearn.com\",\"apiUrl\":\"https://api.staging.saplinglearn.com\",\"healthPath\":\"/api/health\",\"railwayEnvironmentId\":\"76bb36e5-cf12-4b1e-b47f-d276a56c3b85\",\"railwayServiceId\":\"c67bfc38-32a9-41a7-9440-f033d255af30\"},{\"key\":\"production\",\"label\":\"production\",\"note\":\"production\",\"branch\":\"production\",\"railwayEnv\":\"Sapling / production\",\"worker\":\"frontend\",\"workerCheck\":\"Workers Builds: frontend\",\"frontendUrl\":\"https://saplinglearn.com\",\"apiUrl\":\"https://api.saplinglearn.com\",\"healthPath\":\"/api/health\",\"railwayEnvironmentId\":\"dd058398-45bc-4c7d-80b1-12d46e3f28fb\",\"railwayServiceId\":\"c67bfc38-32a9-41a7-9440-f033d255af30\"}]",
          DEV_LOGIN: "", // override .dev.vars: tests exercise REAL auth, never the dev bypass
          NOTIFICATIONS_MODE: "", // override wrangler.toml [vars]: tests always run email in LOCAL mode
          // The pool loads `.dev.vars` through the wrangler config, so every secret
          // a developer keeps there would reach the tests — and each of these makes
          // the code under test resolve a REAL network client (Gemini summaries,
          // GitHub service reads, Resend, the Cloudflare / Railway / Sapling
          // pollers). Blanked here so the POOL default is "unset": the suite stays
          // hermetic and fixture text never leaves the machine. A test that needs
          // one passes its own value through a per-test env object.
          GEMINI_API_KEY: "",
          GITHUB_SERVICE_TOKEN: "",
          RESEND_API_KEY: "",
          CF_ANALYTICS_TOKEN: "",
          CF_ANALYTICS_ACCOUNT_ID: "",
          RAILWAY_TOKEN_STAGING: "",
          RAILWAY_TOKEN_PRODUCTION: "",
          SAPLING_METRICS_TOKEN: "",
          PUBLIC_ORIGIN: "https://trov.test",
          // A FIXED key-encryption key (32 bytes, base64) for per-org secrets (src/data/secrets.ts), so the
          // suite never depends on a developer's `.dev.vars`; TROV_KEK_PREVIOUS is blanked for the same reason.
          TROV_KEK: "dGVzdC1rZWstMDEyMzQ1Njc4OWFiY2RlZi10cm92ISE=",
          TROV_KEK_PREVIOUS: "",
          // Billing (src/billing/): OFF in the pool — blanked like the keys above, so a developer's
          // `.dev.vars` never reaches Stripe from a test. A billing test passes its own env object, with a
          // fake key and a stubbed `fetch`.
          STRIPE_SECRET_KEY: "",
          STRIPE_WEBHOOK_SECRET: "",
          STRIPE_PRICE_PERSONAL: "",
          STRIPE_PRICE_TEAM: "",
          STRIPE_PRICE_PERSONAL_YEARLY: "",
          STRIPE_PRICE_TEAM_YEARLY: "",
          STRIPE_TEST_API_BASE: "",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // Only this checkout's suite: a git worktree parked under .claude/worktrees
    // carries its own copy of test/ and must not be discovered from here.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/.wrangler/**"],
    // Vitest stubs every CSS import to "" unless it is listed here; the app stylesheet is
    // listed so a test can read it as text (`trov.css?raw` — the corners layer is pinned).
    css: { include: [/web\/src\/trov\.css/] },
  },
});
