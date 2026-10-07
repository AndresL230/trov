import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "node:path";

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
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(import.meta.dirname, "migrations")
          ),
          COOKIE_SECRET: "test-cookie-secret",
          GITHUB_CLIENT_ID: "test-client-id",
          GITHUB_CLIENT_SECRET: "test-client-secret",
          GOOGLE_CLIENT_ID: "test-google-client-id",
          GOOGLE_CLIENT_SECRET: "test-google-secret",
          GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
          ADMIN_LOGINS: "admin-user", // the admin allowlist the admin-gated route + isAdmin() test against
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
