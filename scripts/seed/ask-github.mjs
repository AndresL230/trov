#!/usr/bin/env node
// Local-only seed for Ask Trov's GitHub lookups' end-to-end test (docs/testing/ask-github-tools-test-log.md;
// docs/architecture/ask.md › GitHub). Applied ON TOP of `npm run seed` (it needs the team and pro scenarios), to LOCAL
// D1 only (it refuses --remote). Idempotent: every run deletes the rows it owns, the test people's Ask threads included,
// and writes them again — so it is also the reset between cases.
//
// Fixtures (all fake: test- prefixes, example.com addresses, the stand-in's made-up repositories):
//   sap-repos        org_saplinglearn — connected SaplingLearn/sapling (primary; added only when the team scenario has
//                    none) and test-e2e/docs-site (second). The GitHub lookups switch per --github (default on), the AI
//                    switch per --ai (default on).
//   other-org-repo   org_dev_northwind keeps its own northwind-academy/portal — another org's repository.
//   test-gh-admin    admin of SaplingLearn, GitHub-linked (login test-gh-admin)         — the stand-in: read
//   test-gh-reader   member, GitHub-linked (test-gh-reader)                             — read
//   test-gh-noaccess member, GitHub-linked (test-gh-noaccess)                           — none
//   test-gh-checkfail member, GitHub-linked (test-gh-checkfail)                         — the check answers 500
//   test-gh-slow     member, GitHub-linked (test-gh-slow)                               — the check never answers in time
//   test-gh-unlinked member, Google only (no GitHub identity)
//
// The GitHub credential is the dev Worker's `GITHUB_SERVICE_TOKEN` (SaplingLearn's legacy fallback in
// `resolveGithubCredential`) — set it in .dev.vars to a FAKE value; GitHub and Anthropic are the loopback stand-in
// scripts/dev/ask-github-stub.mjs (`LOCAL_UPSTREAM`). Nothing here reaches a network.
//
// usage: npm run seed && node scripts/seed/ask-github.mjs [--github on|off] [--ai on|off] [--persist-to <dir>]
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { targetsRemote } from "./build.mjs";

const argv = process.argv.slice(2);
if (targetsRemote(argv)) {
  console.error("ask-github seed: refusing --remote. This seed only ever targets LOCAL D1.");
  process.exit(1);
}
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? dflt : dflt; };
const GITHUB_ON = arg("--github", "on") !== "off";
const AI_ON = arg("--ai", "on") !== "off";
const persistTo = arg("--persist-to", null);

const SAP = "org_saplinglearn";
const NOW = new Date().toISOString();
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const row = (table, obj, verb = "INSERT") => `${verb} INTO ${table} (${Object.keys(obj).join(", ")}) VALUES (${Object.values(obj).map(q).join(", ")})`;

/** [handle, name, color, role, github login or null] */
export const PEOPLE = [
  ["test-gh-admin", "Test GH Admin", "sky", "admin", "test-gh-admin"],
  ["test-gh-reader", "Test GH Reader", "fern", "member", "test-gh-reader"],
  ["test-gh-noaccess", "Test GH No Access", "rust", "member", "test-gh-noaccess"],
  ["test-gh-checkfail", "Test GH Check Fails", "plum", "member", "test-gh-checkfail"],
  ["test-gh-slow", "Test GH Slow Check", "ochre", "member", "test-gh-slow"],
  ["test-gh-unlinked", "Test GH Unlinked", "rose", "member", null],
];

const s = [];
// ── clean what this seed owns ───────────────────────────────────────────────────────────────────────────────────
const THREADS = `SELECT id FROM chat_threads WHERE org_id = ${q(SAP)} AND handle LIKE 'test-gh-%'`;
s.push(`DELETE FROM chat_actions WHERE org_id = ${q(SAP)} AND thread_id IN (${THREADS})`);
s.push(`DELETE FROM chat_artifacts WHERE org_id = ${q(SAP)} AND thread_id IN (${THREADS})`);
s.push(`DELETE FROM chat_thread_people WHERE org_id = ${q(SAP)} AND (thread_id IN (${THREADS}) OR handle LIKE 'test-gh-%')`); // shares of, and to, the test people
s.push(`DELETE FROM chat_messages WHERE org_id = ${q(SAP)} AND thread_id IN (${THREADS})`);
s.push(`DELETE FROM chat_threads WHERE org_id = ${q(SAP)} AND handle LIKE 'test-gh-%'`);
s.push(`DELETE FROM person_ask_settings WHERE handle LIKE 'test-gh-%'`);
s.push(`DELETE FROM org_usage_daily WHERE org_id = ${q(SAP)} AND actor LIKE 'test-gh-%'`);
s.push(`DELETE FROM org_admin_audit WHERE org_id = ${q(SAP)} AND actor LIKE 'test-gh-%'`);
s.push(`DELETE FROM sessions WHERE person LIKE 'test-gh-%'`);
s.push(`DELETE FROM memberships WHERE user_id LIKE 'test-gh-%'`);
s.push(`DELETE FROM identities WHERE person LIKE 'test-gh-%'`);
s.push(`DELETE FROM persons WHERE handle LIKE 'test-gh-%'`);
s.push(`DELETE FROM org_repos WHERE org_id = ${q(SAP)} AND id LIKE 'hook_test_gh_%'`);

// ── write ───────────────────────────────────────────────────────────────────────────────────────────────────────
for (const [handle, name, color, role, login] of PEOPLE) {
  s.push(row("persons", { handle, name, color, avatar_url: null, email: `${handle}@example.com`, email_unsubscribed: 0, created_at: NOW, onboarded_at: NOW }));
  s.push(login
    ? row("identities", { provider: "github", subject: login, label: login, person: handle, linked_at: NOW, linked_by: "seed", verified_email: null })
    : row("identities", { provider: "google", subject: `google-sub-${handle}`, label: `${handle}@example.com`, person: handle, linked_at: NOW, linked_by: "seed", verified_email: `${handle}@example.com` }));
  s.push(row("memberships", { org_id: SAP, user_id: handle, role, title: null, responsibilities: null, created_at: NOW, created_by: "test-gh-admin" }));
}
// The primary: the team scenario's when it has one, else this one.
s.push(`INSERT OR IGNORE INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by) SELECT 'hook_test_gh_primary', ${q(SAP)}, 'SaplingLearn/sapling', ` +
  `CASE WHEN EXISTS (SELECT 1 FROM org_repos WHERE org_id = ${q(SAP)} AND is_primary = 1) THEN 0 ELSE 1 END, 0, ${q(NOW)}, 'test-gh-admin'`);
s.push(row("org_repos", { id: "hook_test_gh_docs", org_id: SAP, repo_full_name: "test-e2e/docs-site", is_primary: 0, legacy_hook: 0, created_at: NOW, created_by: "test-gh-admin" }, "INSERT OR IGNORE"));
s.push(`UPDATE orgs SET ai_chat_github = ${GITHUB_ON ? 1 : 0}, ai_automation = ${AI_ON ? 1 : 0}, ai_chat_auto = 1 WHERE id = ${q(SAP)}`);

const dir = mkdtempSync(join(tmpdir(), "ask-github-seed-"));
const file = join(dir, "seed.sql");
writeFileSync(file, s.map((x) => `${x};`).join("\n"));
execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", ...(persistTo ? [`--persist-to=${persistTo}`] : []), `--file=${file}`], { stdio: ["ignore", "ignore", "inherit"] });
console.log(`ask-github seed: ${PEOPLE.length} people, 2 connected repositories; GitHub lookups ${GITHUB_ON ? "on" : "off"}, AI ${AI_ON ? "on" : "off"}.`);
