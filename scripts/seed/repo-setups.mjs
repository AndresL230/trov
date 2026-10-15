#!/usr/bin/env node
// Local-only seed for the repo-setups end-to-end test (docs/testing/repo-setups-test-log.md). Applied ON TOP of
// `node scripts/seed-dev.mjs`, to LOCAL D1 only (it refuses --remote). Idempotent: every run deletes the rows it owns
// and writes them again, stamped relative to NOW — run it right before a session, since a health reading older than
// 30 minutes reads as stale by design.
//
// Fixtures (all data obviously fake: test- prefixes, example.com / example.test URLs, made-up shas):
//   sapling-live   org_saplinglearn — repo SaplingLearn/sapling; Staging (main) + Production (production); apps
//                  frontend (Worker, Cloudflare) and backend (Service, Railway) in both; deploys incl. a failed
//                  Production backend deploy with a reason and a rolled-back Production frontend deploy; a preview on
//                  an open PR; fresh health; passing checks; Cloudflare connected org-wide; Railway NOT connected,
//                  with two old per-environment project tokens (leftovers). Owner AndresL230, member meilin.
//   new-org-found  org_b (Acme) — repo acme/new-thing, no environment, no app; a scan with 3 pending suggestions and a
//                  seen Vercel deployment name → the Overview opens on the found-apps card (R1). AndresL230 is admin.
//   unseen-org     org_test_unseen ("Test Unseen", slug test-unseen) — repo acme/mobile, a scan that found nothing,
//                  tags read → the "Trov does not see deploys" card (R2). AndresL230 is owner.
//
// The secrets are DUMMY rows (metadata only — never a real token, never decryptable): Trov reads only their
// presence / scope for status, so nothing here may be "tested" against a real host.
//
// usage: node scripts/seed-dev.mjs && node scripts/seed/repo-setups.mjs
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { targetsRemote } from "./build.mjs";

if (targetsRemote(process.argv.slice(2))) {
  console.error("repo-setups seed: refusing --remote. This seed only ever targets LOCAL D1.");
  process.exit(1);
}

// `--base`: the same fixtures on `main` before this build (the baseline screenshots) — only the tables and columns
// main has (no repo_apps / scans / suggestions / releases / commit paths / repo_settings, no deploy provenance).
const BASE = process.argv.includes("--base");
const NEW_TABLES = new Set(["repo_apps", "repo_settings", "repo_scans", "repo_app_suggestions", "releases", "commit_paths", "pr_files", "pr_file_reads"]);
const NEW_DEPLOY_COLS = ["source", "reason", "sha_source", "rolled_back_from"];

const NOW = Date.now();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const ago = (ms) => new Date(NOW - ms).toISOString();
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const row = (table, obj) => {
  if (BASE && table === "hosting_deploys") obj = Object.fromEntries(Object.entries(obj).filter(([k]) => !NEW_DEPLOY_COLS.includes(k)));
  return `INSERT INTO ${table} (${Object.keys(obj).join(", ")}) VALUES (${Object.values(obj).map(q).join(", ")})`;
};

const SAP = "org_saplinglearn", ACME = "org_b", UNSEEN = "org_test_unseen";
const S_REPO = "SaplingLearn/sapling", A_REPO = "acme/new-thing", U_REPO = "acme/mobile";
const sha = (n) => (n.repeat(40)).slice(0, 40);
const SHA = { a: "3e9a1f2" + sha("a").slice(7), b: "b4c21de" + sha("b").slice(7), c: "c41e7d9" + sha("c").slice(7), d: "d94ea08" + sha("d").slice(7), e: "e07b3a2" + sha("e").slice(7), f: "71f0e3a" + sha("f").slice(7) };

const s = [];
// ── clean what this seed owns ───────────────────────────────────────────────────────────────────────────────────
for (const org of [SAP, ACME, UNSEEN]) {
  for (const t of ["hosting_deploys", "hosting_poll_state", "org_environment_parts", "repo_apps", "repo_settings", "repo_scans",
    "repo_app_suggestions", "releases", "commit_paths", "pr_files", "pr_file_reads", "repo_snapshots", "org_hosting_connections"]) s.push(`DELETE FROM ${t} WHERE org_id = ${q(org)}`);
  s.push(`DELETE FROM repo_events WHERE org_id = ${q(org)} AND semantic_key LIKE 'test-e2e:%'`);
  s.push(`DELETE FROM repo_metrics WHERE org_id = ${q(org)} AND (metric LIKE 'health_%' OR metric LIKE 'hx_%')`);
  s.push(`DELETE FROM org_secrets WHERE org_id = ${q(org)} AND kind IN ('cloudflare_analytics','railway','vercel','render','netlify','fly')`);
  s.push(`DELETE FROM org_environments WHERE org_id = ${q(org)}`);
  s.push(`DELETE FROM org_repos WHERE org_id = ${q(org)}`);
}
s.push(`DELETE FROM memberships WHERE org_id = ${q(UNSEEN)}`);
s.push(`DELETE FROM memberships WHERE org_id = ${q(ACME)} AND user_id = 'AndresL230'`);

// ── orgs, memberships, keys ─────────────────────────────────────────────────────────────────────────────────────
// The org row stays across runs (other tables point at it); only its content is reset.
s.push(row("orgs", { id: UNSEEN, slug: "test-unseen", name: "Test Unseen", created_at: ago(2 * DAY), created_by: "AndresL230", plan: "enterprise" }).replace(/^INSERT INTO/, "INSERT OR IGNORE INTO"));
s.push(row("memberships", { org_id: UNSEEN, user_id: "AndresL230", role: "owner", title: null, responsibilities: null, created_at: ago(2 * DAY), created_by: "AndresL230" }));
s.push(row("memberships", { org_id: ACME, user_id: "AndresL230", role: "admin", title: null, responsibilities: null, created_at: ago(2 * DAY), created_by: "sanaok" }));
for (const org of [SAP, ACME, UNSEEN]) s.push(`INSERT OR IGNORE INTO org_keys (org_id, key_version, wrapped_key, wrap_iv, kek_fingerprint, created_at) VALUES (${q(org)}, 1, 'test-not-a-key', 'test-iv', 'test-e2e', ${q(ago(DAY))})`);

// ── repositories ────────────────────────────────────────────────────────────────────────────────────────────────
s.push(row("org_repos", { id: "hook_test_sapling", org_id: SAP, repo_full_name: S_REPO, is_primary: 1, legacy_hook: 0, created_at: ago(30 * DAY), created_by: "AndresL230" }));
s.push(row("org_repos", { id: "hook_test_acme", org_id: ACME, repo_full_name: A_REPO, is_primary: 1, legacy_hook: 0, created_at: ago(DAY), created_by: "sanaok" }));
s.push(row("org_repos", { id: "hook_test_unseen", org_id: UNSEEN, repo_full_name: U_REPO, is_primary: 1, legacy_hook: 0, created_at: ago(DAY), created_by: "AndresL230" }));

// ── sapling-live: environments, apps, parts ─────────────────────────────────────────────────────────────────────
const env = (key, position, label, branch, fe, api) => row("org_environments", { org_id: SAP, key, position, label, note: null, branch, frontend_url: fe, api_url: api, health_path: "/health", created_at: ago(30 * DAY), updated_at: ago(30 * DAY), updated_by: "AndresL230" });
s.push(env("staging", 0, "Staging", "main", "https://staging.example.test", "https://api.staging.example.test"));
s.push(env("production", 1, "Production", "production", "https://app.example.test", "https://api.example.test"));
const app = (key, label, kind, position) => row("repo_apps", { org_id: SAP, key, repo: S_REPO, label, folder: "/", kind, watch: '["/"]', release_signal: null, source: "migrated", position, created_at: ago(DAY), created_by: "migration", updated_at: ago(DAY), updated_by: "migration" });
s.push(app("frontend", "Frontend", "Worker", 0), app("backend", "Backend", "Service", 1));
const part = (env_key, part_key, position, label, role, provider, settings) => row("org_environment_parts", { org_id: SAP, env_key, part_key, position, label, role, provider, settings: JSON.stringify(settings), created_at: ago(DAY), updated_at: ago(DAY), updated_by: "AndresL230" });
s.push(part("staging", "frontend", 0, "Frontend", "web", "cloudflare", { worker: "test-sapling-staging" }));
s.push(part("staging", "backend", 1, "Backend", "service", "railway", { project_id: "test-project", environment_id: "test-env-staging", service_id: "test-service" }));
s.push(part("production", "frontend", 0, "Frontend", "web", "cloudflare", { worker: "test-sapling" }));
s.push(part("production", "backend", 1, "Backend", "service", "railway", { project_id: "test-project", environment_id: "test-env-production", service_id: "test-service" }));

// ── sapling-live: deploys ───────────────────────────────────────────────────────────────────────────────────────
let did = 0;
const deploy = (o) => row("hosting_deploys", {
  org_id: SAP, env: o.env, part: o.part, provider: o.provider, deploy_id: `test-${++did}`, state: o.state, target: o.target ?? "production",
  sha: o.sha ?? null, branch: o.branch ?? null, message: o.message ?? null, actor: o.by ?? null, url: o.url ?? null, inspect_url: o.log ?? null,
  created_at: ago(o.at), ready_at: o.state === "ready" ? ago(o.at - 90_000) : null, recorded_at: ago(o.at), updated_at: ago(o.at),
  source: "provider", reason: o.reason ?? null, sha_source: o.sha ? "provider" : null, rolled_back_from: o.rolledBackFrom ?? null,
});
// Staging: both apps on 3e9a1f2.
for (let i = 9; i >= 1; i--) s.push(deploy({ env: "staging", part: "frontend", provider: "cloudflare", state: "ready", sha: i === 1 ? SHA.a : sha(String(i)), branch: "main", by: "dev-raj", at: (i * 5 + 21) * MIN, message: `test: staging deploy ${i}` }));
s.push(deploy({ env: "staging", part: "backend", provider: "railway", state: "ready", sha: SHA.d, branch: "main", by: "dev-raj", at: 21 * HOUR }));
s.push(deploy({ env: "staging", part: "backend", provider: "railway", state: "ready", sha: SHA.a, branch: "main", by: "dev-raj", at: 28 * MIN }));
// Production frontend: e07b3a2 shipped, then a rollback to c41e7d9.
s.push(deploy({ env: "production", part: "frontend", provider: "cloudflare", state: "ready", sha: SHA.c, branch: "production", by: "andres", at: 2 * DAY }));
s.push(deploy({ env: "production", part: "frontend", provider: "cloudflare", state: "ready", sha: SHA.e, branch: "production", by: "andres", at: 40 * MIN }));
s.push(deploy({ env: "production", part: "frontend", provider: "cloudflare", state: "ready", sha: SHA.c, branch: "production", by: "andres", at: 8 * MIN, rolledBackFrom: SHA.e }));
// Production backend: b4c21de serving, then a failed deploy with a reason.
s.push(deploy({ env: "production", part: "backend", provider: "railway", state: "ready", sha: SHA.b, branch: "production", by: "jose-a", at: 2 * HOUR }));
s.push(deploy({ env: "production", part: "backend", provider: "railway", state: "error", sha: SHA.f, branch: "production", by: "meilin", at: 12 * MIN, reason: "Build failed: test-e2e tsc found 2 errors", log: "https://example.test/test-logs/1" }));
// A preview of the frontend on the open PR's branch.
s.push(deploy({ env: "production", part: "frontend", provider: "cloudflare", state: "ready", target: "preview", sha: sha("9"), branch: "test-repo-apps", by: "andres", at: 40 * MIN, url: "https://test-repo-apps.example.test" }));
// Poll state: every part polled a few minutes ago.
for (const [e, p, prov] of [["staging", "frontend", "cloudflare"], ["staging", "backend", "railway"], ["production", "frontend", "cloudflare"], ["production", "backend", "railway"]]) {
  const ok = prov === "cloudflare";
  s.push(row("hosting_poll_state", { org_id: SAP, env: e, part: p, provider: prov, polled_at: ago(5 * MIN), status: ok ? "ok" : "skipped", detail: ok ? null : "no credential", last_ok_at: ok ? ago(5 * MIN) : null, covered_from: ok ? ago(3 * HOUR + 40 * MIN) : null, covered_to: ok ? ago(40 * MIN) : null, unavailable: "[]" }));
}

// ── sapling-live: health (fresh), checks, PRs ───────────────────────────────────────────────────────────────────
const tick = new Date(Math.floor((NOW - 3 * MIN) / (10 * MIN)) * 10 * MIN).toISOString();
for (const [e, p, up, ms] of [["staging", "frontend", 1, 142], ["staging", "backend", 1, 88], ["production", "frontend", 1, 131], ["production", "backend", 1, 94]]) {
  s.push(row("repo_metrics", { org_id: SAP, metric: "health_up", env: e, part: p, value: up, at: tick }));
  s.push(row("repo_metrics", { org_id: SAP, metric: "health_ms", env: e, part: p, value: ms, at: tick }));
}
let ev = 0;
const event = (o) => row("repo_events", { org_id: SAP, repo: "", semantic_key: `test-e2e:${++ev}`, kind: o.kind, ref: o.ref ?? null, sha: o.sha ?? null, number: o.number ?? null, env: null, part: null, state: o.state ?? null, name: o.name ?? null, actor_login: o.by ?? null, title: o.title ?? null, url: o.url ?? null, count: o.count ?? null, raw: JSON.stringify(o.raw ?? {}), provenance: "webhook", occurred_at: ago(o.at), recorded_at: ago(o.at) });
for (const [branch, head] of [["main", SHA.a], ["production", SHA.c]]) {
  s.push(event({ kind: "push", ref: branch, sha: head, by: "dev-raj", count: 1, at: 30 * MIN, raw: { before: sha("0") } }));
  for (let i = 0; i < 3; i++) s.push(event({ kind: "check", ref: branch, sha: head, number: 9000 + ev, name: `test-check-${i}`, state: "success", at: 25 * MIN, raw: { app: "github-actions", status: "completed" } }));
}
s.push(event({ kind: "pr", number: 318, state: "review", ref: "test-repo-apps", sha: sha("9"), by: "AndresL230", title: "test: Repo screen apps and targets", url: "https://example.test/pr/318", at: 40 * MIN, raw: { action: "opened", base: "main", draft: false, labels: [] } }));
s.push(event({ kind: "pr", number: 314, state: "merged", ref: "test-quiz-timer", sha: sha("8"), by: "dev-raj", title: "test: Quiz timer drifts when the tab is hidden", url: "https://example.test/pr/314", at: DAY, raw: { action: "closed", base: "main", draft: false, labels: [] } }));
// Signals for the Apps tab's deploy-signal picker (A13): a Vercel deployment and a deploy workflow seen recently,
// and one deployment last seen 40 days ago that must NOT be offered (the picker's window is 30 days).
for (let i = 0; i < 3; i++) s.push(event({ kind: "deploy", sha: SHA.a, ref: SHA.a, number: 8100 + i, state: "success", name: "Production – sapling-docs", by: "vercel[bot]", title: "Deployment has completed", url: "https://example.test/vercel/docs", at: (i + 1) * 5 * HOUR, raw: { signal: "deployment", environment: "Production – sapling-docs" } }));
s.push(event({ kind: "run", ref: "main", sha: SHA.a, number: 8200, state: "success", name: "Deploy docs", by: "dev-raj", url: "https://example.test/runs/8200", count: 1, at: 3 * HOUR, raw: { event: "push", path: ".github/workflows/deploy-docs.yml" } }));
s.push(event({ kind: "deploy", sha: SHA.d, ref: SHA.d, number: 8300, state: "success", name: "Preview – stale-thing", by: "vercel[bot]", title: "Deployment has completed", url: "https://example.test/vercel/stale", at: 40 * DAY, raw: { signal: "deployment", environment: "Preview – stale-thing" } }));
s.push(row("repo_snapshots", { org_id: SAP, kind: "env_heads", json: JSON.stringify({ main: SHA.a, production: SHA.c }), computed_at: ago(20 * MIN) }));

// ── sapling-live: credentials (DUMMY metadata) ──────────────────────────────────────────────────────────────────
const secret = (org, kind, scope, last4) => row("org_secrets", { org_id: org, kind, scope, ciphertext: "test-not-a-secret", iv: "test-iv", key_version: 1, hint_last4: last4, created_by: "AndresL230", created_at: ago(20 * DAY), rotated_at: null, last_used_at: null, last_error: null });
s.push(secret(SAP, "cloudflare_analytics", "", "c0f1"));
s.push(secret(SAP, "railway", "staging", "5024"), secret(SAP, "railway", "production", "51b1"));

// ── new-org-found: a scan with 3 pending suggestions and a seen Vercel deployment ────────────────────────────────
const LOOKED = ["vercel.json", "netlify.toml", "wrangler.toml", "fly.toml", "render.yaml", "railway.json", "Dockerfile"];
s.push(row("repo_scans", { org_id: ACME, repo: A_REPO, tree_sha: sha("1"), scanned_at: ago(30 * MIN), looked: JSON.stringify(LOOKED), error: null }));
const sug = (id, key, folder, kind, provider, evidence, parts, used_by = []) => row("repo_app_suggestions", { org_id: ACME, repo: A_REPO, id, key, folder, kind, provider, evidence: JSON.stringify(evidence), parts: JSON.stringify(parts), used_by: JSON.stringify(used_by), state: "pending", decided_at: null, decided_by: null, created_at: ago(30 * MIN) });
s.push(sug("sg_00000000000000000a01", "web", "apps/web", "Site", "vercel", [{ kind: "file", text: "from apps/web/vercel.json" }, { kind: "signal", text: "GitHub deployment “Production – new-thing-web” seen 12 times", signal: { kind: "deployment", name: "Production – new-thing-web" } }], []));
s.push(sug("sg_00000000000000000a02", "worker", "apps/worker", "Worker", "cloudflare", [{ kind: "file", text: "from apps/worker/wrangler.toml · Worker test-new-thing-worker" }], []));
s.push(sug("sg_00000000000000000a03", "shared", "packages/shared", "Package", null, [{ kind: "workspace", text: "from packages/shared/package.json · used by apps/web and apps/worker" }], [], ["apps/web", "apps/worker"]));
for (let i = 0; i < 12; i++) s.push(row("repo_events", { org_id: ACME, repo: "", semantic_key: `test-e2e:acme:${i}`, kind: "deploy", ref: sha("2"), sha: sha("2"), number: 7000 + i, env: null, part: null, state: "success", name: "Production – new-thing-web", actor_login: "vercel[bot]", title: "Deployment has completed", url: "https://example.test/vercel/1", count: null, raw: JSON.stringify({ signal: "deployment", environment: "Production – new-thing-web", environment_url: "https://new-thing-web.example.test" }), provenance: "webhook", occurred_at: ago((i + 1) * 6 * HOUR), recorded_at: ago((i + 1) * 6 * HOUR) }));

// ── unseen-org: a scan that found nothing; tags read ────────────────────────────────────────────────────────────
s.push(row("repo_scans", { org_id: UNSEEN, repo: U_REPO, tree_sha: sha("3"), scanned_at: ago(20 * MIN), looked: JSON.stringify(LOOKED), error: null }));
for (const [tag, d, by] of [["v1.8.0", 6, "ana-r"], ["v1.7.2", 19, "tom-h"], ["v1.7.1", 27, "tom-h"], ["v1.7.0", 41, "ana-r"]]) {
  s.push(row("releases", { org_id: UNSEEN, repo: U_REPO, tag, name: null, published_at: ago(d * DAY), author: by, notes: null, is_prerelease: 0, is_draft: 0, sha: sha("4"), source: "tag", content_hash: `test-${tag}`, captured_at: ago(d * DAY) }));
}
s.push(row("repo_snapshots", { org_id: UNSEEN, kind: "releases_reconciled", json: JSON.stringify({ repo: U_REPO }), computed_at: ago(20 * MIN) }));

// ── apply, a few statements at a time (the local execute refuses one huge file) ────────────────────────────────
const touchesNew = (sql) => [...NEW_TABLES].some((t) => new RegExp(`\\b(INTO|FROM) ${t}\\b`).test(sql));
if (BASE) s.splice(0, s.length, ...s.filter((x) => !touchesNew(x)));
const CHUNK = 8;
const file = join(mkdtempSync(join(tmpdir(), "trov-repo-setups-seed-")), "seed.sql");
console.log(`repo-setups seed: applying ${s.length} statements to LOCAL D1…`);
for (let i = 0; i < s.length; i += CHUNK) {
  writeFileSync(file, s.slice(i, i + CHUNK).map((x) => x + ";").join("\n"), "utf8");
  execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", `--file=${file}`], { stdio: ["ignore", "ignore", "inherit"] });
}
console.log("repo-setups seed: done — fixtures sapling-live (org saplinglearn), new-org-found (acme), unseen-org (test-unseen). DEV_LOGIN=AndresL230 (owner/admin of all three) or meilin (member of saplinglearn).");
