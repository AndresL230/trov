#!/usr/bin/env node
// The 10-17 batch's end-to-end seed (docs/testing/10-17-batch-test-log.md): every feature seed of the batch, in the
// one order that keeps them from undoing each other, then one check query per fixture. LOCAL D1 / R2 ONLY — it
// refuses --remote, and every step it runs refuses it too. Idempotent: the dev seed rewrites every scenario whole and
// each layer deletes the rows it owns before writing them, so a run is also the reset between cases.
//
//   1. the dev seed, every scenario (`scripts/seed-dev.mjs`)             team (SaplingLearn), dayone, pro, …
//   2. dark-accent-purple's people (its `statements()`, without its own `--scenario team` reseed, which step 1 did)
//   3. prompt-card-copy-slug's `test-copy-*` prompts
//   4. ask-github's people, repositories and switches (`--github on|off`, `--ai on|off`, default on / on)
//   5. artifact-inspector-width's `test-aiw-*` pages and threads — it asks the RUNNING Worker to build the chips, so
//      a dev server signed in as AndresL230 (DEV_LOGIN) must be up: `--server <origin>` (default :8851). With
//      `--no-server`, step 5 is skipped (the D1-only reset, e.g. between G cases).
//
// usage: node scripts/seed/10-17-batch.mjs [--server http://localhost:8851] [--github on|off] [--ai on|off] [--no-server]
//        node scripts/seed/10-17-batch.mjs --check      # only the checks
import { execFileSync } from "node:child_process";
import { targetsRemote } from "./build.mjs";
import { localD1 } from "./local-d1.mjs";
import { statements as darkStatements, FIXTURES as DARK_FIXTURES } from "./dark-accent-purple.mjs";

const argv = process.argv.slice(2);
if (targetsRemote(argv)) {
  console.error("10-17-batch seed: refusing --remote. This seed only ever targets LOCAL D1.");
  process.exit(1);
}
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const SERVER = arg("--server", "http://localhost:8851");
const GITHUB = arg("--github", "on");
const AI = arg("--ai", "on");
const node = (...args) => execFileSync("node", args, { stdio: "inherit" });

const SAP = "org_saplinglearn";
/** [fixture, query, want] — each the row count the fixture must have. */
const CHECKS = [
  ["org-team (SaplingLearn) with its owner", `SELECT COUNT(*) AS n FROM memberships WHERE org_id = '${SAP}' AND user_id = 'AndresL230' AND role = 'owner'`, 1],
  ["org-dayone (empty org)", "SELECT COUNT(*) AS n FROM orgs WHERE slug = 'dayone'", 1],
  ["member meilin", `SELECT COUNT(*) AS n FROM memberships WHERE org_id = '${SAP}' AND user_id = 'meilin' AND role = 'member'`, 1],
  ["sync run with a coded failure (Z32)", `SELECT COUNT(*) AS n FROM sync_runs WHERE org_id = '${SAP}' AND status = 'partial' AND failures LIKE '%"code":"reconcile:deployments"%'`, 1],
  ...DARK_FIXTURES.filter((f) => f.check).map((f) => [`dark: ${f.name}`, f.check[0], f.check[1]]),
  ["prompt-card: 5 live test-copy prompts", `SELECT COUNT(*) AS n FROM prompts WHERE org_id = '${SAP}' AND slug LIKE 'test-copy-%' AND deleted_at IS NULL`, 5],
  ["ask-github: 6 test-gh people in SaplingLearn", `SELECT COUNT(*) AS n FROM memberships WHERE org_id = '${SAP}' AND user_id LIKE 'test-gh-%'`, 6],
  ["ask-github: 5 GitHub-linked", "SELECT COUNT(*) AS n FROM identities WHERE provider = 'github' AND person LIKE 'test-gh-%'", 5],
  ["ask-github: the second repository", `SELECT COUNT(*) AS n FROM org_repos WHERE org_id = '${SAP}' AND repo_full_name = 'test-e2e/docs-site'`, 1],
  [`ask-github: lookups ${GITHUB}, AI ${AI}`, `SELECT COUNT(*) AS n FROM orgs WHERE id = '${SAP}' AND ai_chat_github = ${GITHUB === "off" ? 0 : 1} AND ai_automation = ${AI === "off" ? 0 : 1}`, 1],
  ["another org's repository (northwind)", "SELECT COUNT(*) AS n FROM org_repos WHERE repo_full_name = 'northwind-academy/portal'", 1],
];
const SERVER_CHECKS = [
  ["artifact-inspector-width: 11 test-aiw pages", `SELECT COUNT(*) AS n FROM artifact_pages WHERE org_id = '${SAP}' AND slug LIKE 'test-aiw-%'`, 11],
  ["artifact-inspector-width: threads 9401–9403", `SELECT COUNT(*) AS n FROM chat_threads WHERE org_id = '${SAP}' AND id IN (9401, 9402, 9403)`, 3],
];

function check() {
  const list = argv.includes("--no-server") ? CHECKS : [...CHECKS, ...SERVER_CHECKS];
  const rows = localD1({ quiet: true }).query(list.map((c) => c[1]));
  let bad = 0;
  list.forEach(([name, , want], i) => {
    const n = rows[i]?.[0]?.n;
    if (n !== want) bad++;
    console.log(`  ${n === want ? "ok  " : "FAIL"} ${name}: ${n} (want ${want})`);
  });
  if (bad) process.exit(1);
}

if (!argv.includes("--check")) {
  node("scripts/seed-dev.mjs");
  localD1().apply("dark-accent-purple fixtures", darkStatements());
  node("scripts/seed/prompt-card-copy-slug.mjs");
  node("scripts/seed/ask-github.mjs", "--github", GITHUB, "--ai", AI);
  if (!argv.includes("--no-server")) node("scripts/seed/artifact-inspector-width.mjs", "--server", SERVER);
}
check();
