#!/usr/bin/env node
// The dark-accent-purple end-to-end seed (docs/testing/dark-accent-purple-test-log.md: its "state" column names the
// fixtures below). The change is colour only, so the data states are WHO is looking and WHICH page they can reach;
// the theme states (stored dark, stored system + an OS in dark, light, nothing stored) are set in the browser, not here.
//
// LOCAL D1 ONLY — it refuses --remote outright, like scripts/seed-dev.mjs.
//
//   node scripts/seed/dark-accent-purple.mjs          # reseed: the `team` scenario, then the fixtures below
//   node scripts/seed/dark-accent-purple.mjs --list   # print the fixtures, touch nothing
//
// IDEMPOTENT: every run rewrites the `team` scenario whole (scripts/seed-dev.mjs --scenario team) and deletes, then
// writes again, every `test-dark-*` row. Run it in the folder whose `.wrangler/state` the dev server serves.
//
// SIGNING IN AS A FIXTURE PERSON. Each person has a session row `test-session-<handle>`. With DEV_LOGIN UNSET in
// .dev.vars (it overrides every cookie), forge the cookie with `node scripts/dev-cookie.mjs test-session-<handle>`
// and set it on the dev server's origin. No cookie = signed out.
import { execFileSync } from "node:child_process";
import { targetsRemote } from "./build.mjs";
import { localD1 } from "./local-d1.mjs";

const ORG = "org_saplinglearn";
const q = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const insert = (table, row) => `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")})`;

/** The people: handle, colour, the org role (null = a member of no org). */
const PEOPLE = [
  { handle: "test-dark-member", name: "test-Dark Member", color: "plum", role: "member" },
  { handle: "test-dark-moss", name: "test-Dark Moss", color: "moss", role: "member" },
  { handle: "test-dark-noorg", name: "test-Dark No Org", color: "sky", role: null },
];
/** A slug that is nobody's org: opening /<slug>/ shows the org picker (the first-run banner) with "lost". */
export const LOST_SLUG = "test-dark-gone";

export const FIXTURES = [
  { name: "org-team", what: "SaplingLearn (the dev seed's `team` scenario): every screen populated; AndresL230 is its owner (colour moss)",
    check: [`SELECT COUNT(*) AS n FROM memberships WHERE org_id = '${ORG}' AND user_id = 'AndresL230' AND role = 'owner'`, 1] },
  { name: "person-owner-moss", what: "AndresL230, owner of SaplingLearn, colour moss (the old dark accent's hex); session test-session-AndresL230",
    check: ["SELECT COUNT(*) AS n FROM sessions WHERE id = 'test-session-AndresL230'", 1] },
  { name: "person-member", what: "test-dark-member, a member of SaplingLearn, colour plum; session test-session-test-dark-member",
    check: [`SELECT COUNT(*) AS n FROM memberships WHERE org_id = '${ORG}' AND user_id = 'test-dark-member' AND role = 'member'`, 1] },
  { name: "person-member-moss", what: "test-dark-moss, a member of SaplingLearn whose colour is moss",
    check: ["SELECT COUNT(*) AS n FROM persons WHERE handle = 'test-dark-moss' AND color = 'moss'", 1] },
  { name: "person-no-org", what: "test-dark-noorg, signed in, a member of no org: the org picker's bannered card",
    check: ["SELECT COUNT(*) AS n FROM memberships WHERE user_id = 'test-dark-noorg'", 0] },
  { name: "org-lost", what: `/${LOST_SLUG}/ is nobody's org: the picker opens with a "not yours" line`,
    check: [`SELECT COUNT(*) AS n FROM orgs WHERE slug = '${LOST_SLUG}'`, 0] },
  { name: "signed-out", what: "no cookie: the landing page, pricing, the legal pages and the sign-in dialog", check: null },
];

export function statements(now = new Date()) {
  const iso = now.toISOString();
  const ahead = new Date(now.getTime() + 30 * 86_400_000).toISOString();
  const handles = [...PEOPLE.map((p) => p.handle)];
  const list = handles.map(q).join(", ");
  const s = [
    `DELETE FROM sessions WHERE id LIKE 'test-session-%' AND (person IN (${list}) OR person = 'AndresL230')`,
    `DELETE FROM memberships WHERE user_id IN (${list})`,
    `DELETE FROM identities WHERE person IN (${list})`,
    `DELETE FROM persons WHERE handle IN (${list})`,
    `DELETE FROM orgs WHERE slug = ${q(LOST_SLUG)}`,
  ];
  for (const p of PEOPLE) {
    s.push(insert("persons", { handle: p.handle, name: p.name, color: p.color, email: `${p.handle}@example.com`, email_unsubscribed: 0, created_at: iso, onboarded_at: iso, role: null }));
    s.push(insert("identities", { provider: "google", subject: `google-sub-${p.handle}`, label: `${p.handle}@example.com`, person: p.handle, linked_at: iso, linked_by: "seed", verified_email: `${p.handle}@example.com` }));
    if (p.role) s.push(insert("memberships", { org_id: ORG, user_id: p.handle, role: p.role, title: null, responsibilities: null, created_at: iso, created_by: "seed" }));
  }
  for (const h of [...handles, "AndresL230"]) s.push(insert("sessions", { id: `test-session-${h}`, person: h, created_at: iso, expires_at: ahead }));
  return s;
}

function main() {
  const argv = process.argv.slice(2);
  if (targetsRemote(argv)) {
    console.error("dark-accent-purple: refusing --remote. This seed only ever targets LOCAL D1.");
    process.exit(1);
  }
  if (argv.includes("--list")) {
    for (const f of FIXTURES) console.log(`  - ${f.name}: ${f.what}`);
    return;
  }
  execFileSync("node", ["scripts/seed-dev.mjs", "--scenario", "team"], { stdio: "inherit" });
  const db = localD1();
  db.apply("dark-accent-purple fixtures", statements());
  const checks = FIXTURES.filter((f) => f.check);
  const rows = db.query(checks.map((f) => f.check[0]));
  let bad = 0;
  checks.forEach((f, i) => {
    const n = rows[i]?.[0]?.n;
    const ok = n === f.check[1];
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${f.name}: ${n} (want ${f.check[1]})`);
  });
  if (bad) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
