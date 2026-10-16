import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";
import { RESET_STATEMENTS } from "../scripts/seed/reset.mjs";

// Runs once per test worker before the suite. applyD1Migrations is idempotent.
// Schema + seeded vocabulary (sections, tags) are applied here and persist for
// all tests. Data tables are truncated before each test so every test starts
// with a clean slate — approximating per-test D1 isolation.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// src/index.ts imports src/mcp.ts DYNAMICALLY, on the first /mcp request (docs/architecture/env.md › Bundle).
// In this pool a dynamic import is fetched and evaluated through the module runner when it first runs — seconds,
// inside whichever test sends the file's first /mcp call, against its 5 s timeout. Loading it here, once per
// file and outside every test, is what the static import used to do.
await import("../src/mcp");

beforeEach(async () => {
  // The canonical data-table reset lives in scripts/seed/reset.mjs, shared by
  // this harness and the dev seed loader (FK-safe delete order + people
  // re-seed). Truncates all user-writable data tables, preserving vocabulary
  // tables (sections, tags) that were seeded by the migration.
  await env.DB.exec(RESET_STATEMENTS.join("; ") + ";");
});
