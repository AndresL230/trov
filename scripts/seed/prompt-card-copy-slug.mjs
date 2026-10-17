#!/usr/bin/env node
// Fixtures for the Prompt Library card's copy-slug button and the hitArea pointer fix (e2e log:
// docs/testing/prompt-card-copy-slug-test-log.md). A LAYER over the dev seed (`npm run dev` / `npm run seed`
// first): it writes only `test-copy-*` prompts in SaplingLearn, deleting every `test-copy-*` row first, so it is
// idempotent and each run starts clean. LOCAL D1 only (scripts/seed/local-d1.mjs); `--remote` is refused.
//
//   node scripts/seed/prompt-card-copy-slug.mjs            # write the fixtures, then print the check
//   node scripts/seed/prompt-card-copy-slug.mjs --check    # only print the check
//   node scripts/seed/prompt-card-copy-slug.mjs --clean    # remove the fixtures
//   node scripts/seed/prompt-card-copy-slug.mjs --persist-to=<other checkout>/.wrangler/state
//                                                          # the same, into ANOTHER checkout's local D1 (the e2e
//                                                          # baseline server's), still local only
//
// Fixtures (SaplingLearn, /saplinglearn/#prompts; sign in with `npm run dev:as -- <handle>`):
//   prompt-published   test-copy-published   published v2 (meilin)
//   prompt-staged      test-copy-staged      staged v1 (an agent's save, Jose)
//   prompt-draft       test-copy-draft       draft v1 (AndresL230)
//   prompt-long-slug   a 60-character slug (the slugify cap) with a long title — wrapping at 360px
//   prompt-hostile     test-copy-hostile     a title with HTML, quotes, an ampersand and emoji — escaping
//   prompt-deleted     test-copy-deleted     soft-deleted — must NOT draw a card (nor a copy button)
// States the dev seed already holds, verified by --check:
//   library-many       SaplingLearn's own prompts (12) + these
//   library-empty      Day One Labs (/dayone/, robin-vale): no prompts at all
//   review-some        SaplingLearn: staged doc proposals / draft ADRs → Feed › Waiting on review rows
//   review-none        Day One Labs: nothing waiting on review
// Roles (SaplingLearn): AndresL230 owner, Jose-Gael-Cruz-Lopez admin, meilin member.
import { localD1 } from "./local-d1.mjs";

if (process.argv.includes("--remote")) { console.error("prompt-card-copy-slug: local only — refusing --remote"); process.exit(2); }

const ORG = "org_saplinglearn";
const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const LONG = "test-copy-long-slug-for-the-narrow-card-wrap-check-0123456789".slice(0, 60);
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

/** [slug, title, tags, author, versions: [version, status, author, daysAgo, body][], deleted?] */
const FIXTURES = [
  ["test-copy-published", "Test copy: published prompt", ["ui"], "meilin", [[1, "published", "meilin", 6, "First body."], [2, "published", "meilin", 1, "Second body for {{target}}."]]],
  ["test-copy-staged", "Test copy: staged by an agent", ["api"], "Jose-Gael-Cruz-Lopez", [[1, "staged", "Jose-Gael-Cruz-Lopez", 0.2, "Staged body."]]],
  ["test-copy-draft", "Test copy: draft", [], "AndresL230", [[1, "draft", "AndresL230", 0.5, "Draft body."]]],
  [LONG, "Test copy: a long title that has to wrap over two or three lines on a phone-width card", ["infra", "data"], "meilin", [[1, "published", "meilin", 3, "Long body."]]],
  ["test-copy-hostile", `Test <b>bold</b> & "quotes" 'single' 🚀 ünïcödé <img src=x onerror=alert(1)>`, ["ui"], "AndresL230", [[1, "published", "AndresL230", 2, "Hostile body <script>alert(1)</script>"]]],
  ["test-copy-deleted", "Test copy: deleted prompt", [], "AndresL230", [[1, "published", "AndresL230", 4, "Deleted body."]], true],
];

function statements() {
  const s = [
    `DELETE FROM prompt_versions WHERE org_id = '${ORG}' AND slug LIKE 'test-copy-%'`,
    `DELETE FROM prompts WHERE org_id = '${ORG}' AND slug LIKE 'test-copy-%'`,
  ];
  for (const [slug, title, tags, author, versions, deleted] of FIXTURES) {
    const last = versions.at(-1);
    s.push(`INSERT INTO prompts (org_id, slug, title, description, tags, author, current_version, created_at, updated_at, use_count, last_used_at, deleted_at, deleted_by)
      VALUES ('${ORG}', ${q(slug)}, ${q(title)}, '', ${q(JSON.stringify(tags))}, ${q(author)}, ${last[0]}, ${q(iso(versions[0][3]))}, ${q(iso(last[3]))}, 0, NULL, ${deleted ? q(iso(0.1)) : "NULL"}, ${deleted ? q(author) : "NULL"})`);
    for (const [v, status, by, days, body] of versions) {
      s.push(`INSERT INTO prompt_versions (org_id, slug, version, status, author, summary, body, created_at)
        VALUES ('${ORG}', ${q(slug)}, ${v}, ${q(status)}, ${q(by)}, '', ${q(body)}, ${q(iso(days))})`);
    }
  }
  return s;
}

const persistArg = process.argv.find((a) => a.startsWith("--persist-to="));
const db = localD1({ persistTo: persistArg ? persistArg.slice("--persist-to=".length) : null });
if (process.argv.includes("--clean")) {
  db.apply("prompt-card-copy-slug: clean", statements().slice(0, 2));
} else if (!process.argv.includes("--check")) {
  db.apply("prompt-card-copy-slug", statements());
}

const [mine, saplingLive, dayonePrompts, sapReview, dayReview, roles] = db.query([
  `SELECT slug, current_version, deleted_at IS NOT NULL AS deleted, (SELECT status FROM prompt_versions v WHERE v.org_id = p.org_id AND v.slug = p.slug AND v.version = p.current_version) AS status FROM prompts p WHERE org_id = '${ORG}' AND slug LIKE 'test-copy-%' ORDER BY slug`,
  `SELECT COUNT(*) AS n FROM prompts WHERE org_id = '${ORG}' AND deleted_at IS NULL`,
  `SELECT COUNT(*) AS n FROM prompts WHERE org_id = 'org_dev_dayone'`,
  `SELECT (SELECT COUNT(*) FROM doc_versions WHERE org_id = '${ORG}' AND status = 'staged') AS proposals, (SELECT COUNT(*) FROM adrs WHERE org_id = '${ORG}' AND status = 'draft') AS draft_adrs`,
  `SELECT (SELECT COUNT(*) FROM doc_versions WHERE org_id = 'org_dev_dayone' AND status = 'staged') AS proposals, (SELECT COUNT(*) FROM adrs WHERE org_id = 'org_dev_dayone' AND status = 'draft') AS draft_adrs`,
  `SELECT user_id AS handle, role FROM memberships WHERE org_id = '${ORG}' AND user_id IN ('AndresL230', 'Jose-Gael-Cruz-Lopez', 'meilin') ORDER BY user_id`,
]);
console.log("\nprompt-card-copy-slug fixtures (SaplingLearn):");
for (const r of mine) console.log(`  ${r.slug.padEnd(62)} v${r.current_version} ${r.status}${r.deleted ? " (deleted)" : ""}`);
console.log(`  library-many:  ${saplingLive[0].n} live prompts in SaplingLearn`);
console.log(`  library-empty: ${dayonePrompts[0].n} prompts in Day One Labs`);
console.log(`  review-some:   SaplingLearn ${sapReview[0].proposals} staged proposals, ${sapReview[0].draft_adrs} draft ADRs`);
console.log(`  review-none:   Day One Labs ${dayReview[0].proposals} staged proposals, ${dayReview[0].draft_adrs} draft ADRs`);
console.log(`  roles:         ${roles.map((r) => `${r.handle}=${r.role}`).join(", ")}`);
