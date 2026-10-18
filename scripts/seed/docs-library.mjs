#!/usr/bin/env node
// Local-only seed for the Docs Library end-to-end test (docs/testing/docs-library-test-log.md; area doc
// docs/architecture/docs-library.md). It writes FOUR orgs of its own, so it never touches SaplingLearn or the dev
// scenarios: every run wipes each of them whole (every table with an org_id column, children first, read from the
// live schema — the dev scenarios' own wipe) and writes them again, stamped against NOW. Idempotent; run it before a
// session and after any case that writes. LOCAL D1 only: it refuses --remote and every wrangler call is --local.
//
// It also (re)generates the import fixtures — zips and loose Markdown files — under scripts/seed/fixtures/docs-library/
// (deterministic bytes; committed — except the 1 MB test-huge.md, generated only — so a person can drop them into the
// browser without running anything).
//
// Everything is made up: `test-` handles, example.com addresses, `test-` slugs, `trov_mcp_test_…` tokens that only
// this local D1 knows.
//
// ── Orgs and people ─────────────────────────────────────────────────────────────────────────────────────────────
//   test-docs            org_test_docslib        the main org, Enterprise (no plan limit in the way)
//   test-docs-one        org_test_docslib_one    ONE space (Engineering) and an import in progress (the lock)
//   test-docs-nospaces   org_test_docslib_none   NO spaces at all
//   test-docs-other      org_test_docslib_other  another org: same slugs as test-docs, its own pages and import
//
//   test-dl-admin       Ada Test-Admin      owner of test-docs, test-docs-one, test-docs-nospaces   (role: admin+)
//   test-dl-member      Max Test-Member     member of test-docs, test-docs-one, test-docs-nospaces  (role: member)
//   test-dl-spaceowner  Olu Test-Owner      member of test-docs; OWNER of the Engineering and Design spaces
//   test-dl-agentuser   Pia Test-Agent      member of test-docs; the person whose agent wrote the agent proposals
//   test-dl-outsider    Otto Test-Outsider  owner of test-docs-other ONLY (another org's member)
//   Sign in as any of them: http://localhost:<port>/auth/dev/as?handle=<handle> (docs/architecture/local-dev.md).
//
// ── Named fixtures (the data states the matrix uses; `--list` prints this) ──────────────────────────────────────
//   spaces-many          test-docs: 6 live spaces (Engineering, Product, Design, Security, a 40-char name, Onboarding)
//   space-empty          test-docs › Security: 0 pages, owner test-dl-admin
//   space-no-desc        test-docs › Product: no description, no owner
//   space-long           test-docs › test-long-space: a 40-character name + a 140-character description
//   space-archived       test-docs › Old Wiki (old-wiki): archived, 2 live pages readable by link
//   space-archived-clash test-docs › design-old: archived, NAMED "Design" like the live one → restore is name_taken
//   spaces-one           test-docs-one: Engineering only (3 pages)
//   spaces-none          test-docs-nospaces: no space, no page
//   tree-deep-5          Engineering › Platform … 5 levels (depth 0–4, the MAX), long titles at level 5; the on-call
//                        checklist (an agent's staged v2) beside the deepest page, under Regional failover
//   tree-unranked        Engineering › Runbooks: 2 unranked children + 1 ranked (ranked first, then A to Z)
//   tree-orphan          test-orphan: parent_slug names no page → drawn at the top level
//   tree-loop            test-loop-a ↔ test-loop-b: a stored loop → both at the top level
//   tree-cross-parent    test-crossparent (Engineering) whose parent is a Product page → top level
//   tree-many            Product › Release notes: 24 children (a long All pages list)
//   page-live            test-authentication: live v3 (v2 rejected), children, links out, backlinks in
//   page-pending         test-rate-limits: live v1 + an agent's staged v2 ("Change pending review")
//   page-staged          test-first-change: never approved, an agent's v1 ("Not yet approved")
//   page-imported-staged test-imp-first-week: never approved, from import 6302 (Imported from …)
//   page-links           test-links: [[good]], [[good|label]], [[broken]], links in code (not links), a cross-space
//                        link, a link to a staged page and to a page of the archived space; doc_links rows written
//   page-archived        test-old-runbook: ARCHIVED (by test-dl-spaceowner) from Engineering › Runbooks; its child
//                        test-old-runbook-step moved up to Runbooks; a person's staged v2 hidden from Review while
//                        archived; test-links-archived links to it ([[…]] reads "Archived"). Space home › Archived pages
//   page-unbackfilled    test-unbackfilled: live, body has [[test-architecture]], NO doc_links row (the cron backfill)
//   page-xss             test-xss: HTML in the title and body (<img onerror>, <script>, javascript: link)
//   page-unicode         test-unicode: accents, CJK and an emoji in the title and body
//   proposal-parent      test-moves-on-promote: live at the top level + staged v2 asking for parent test-runbooks
//   proposal-badparent   test-badparent-on-promote: staged v2 asking for a parent that would be too deep
//   imports-history      test-docs: runs 6301 done, 6302 partial (3 skipped files, pages waiting), 6303 done (one .md),
//                        6304 failed, 6305 abandoned (cancelled), 6306 running-but-stale (reads abandoned)
//   import-running       test-docs-one: run 6308 running (heartbeat 12 h in the FUTURE, so it holds the lock all session)
//   review-import-group  import 6302's waiting pages: 3 new pages + a new version of test-local-setup + test-deploys
//                        (import v2 with an AGENT's v3 on top → Approve all / Reject all leave it alone)
//   review-agent-group   the agent's staged versions (rate limits, first change, importing md, the failover checklist)
//   triage-space         2 Unplaced doc proposals: unknown space `test-nowhere`, archived space `old-wiki`
//   mcp-tokens           bearer tokens: test-dl-member in test-docs, test-dl-outsider in test-docs-other (below)
//   other-org            test-docs-other: its own test-getting-started (same slug), test-other-secret, import 6309
//
// MCP (local only):  Authorization: Bearer trov_mcp_test_docslib_member_000000000000000000000000
//                    Authorization: Bearer trov_mcp_test_docslib_outsider_0000000000000000000000
//
// usage: node scripts/seed/docs-library.mjs            # files + every fixture, then the check list
//        node scripts/seed/docs-library.mjs --files    # only (re)write the import fixture files
//        node scripts/seed/docs-library.mjs --check    # only run the check list
//        node scripts/seed/docs-library.mjs --list     # print the fixtures
// Run it in the folder whose `wrangler dev` you browse (its .wrangler/state); the dev server may stay up.
import { createHash } from "node:crypto";
import { deflateRawSync, crc32 } from "node:zlib";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { targetsRemote } from "./build.mjs";
import { localD1 } from "./local-d1.mjs";
import { insert, makeClock } from "./team-rich.mjs";
import { ORG_TABLES_SQL, orgTablesInOrder, orgWipeStatements, orgStatements, personStatements } from "./scenarios.mjs";

const argv = process.argv.slice(2);
if (targetsRemote(argv)) {
  console.error("docs-library seed: refusing --remote. This seed only ever targets LOCAL D1.");
  process.exit(1);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures", "docs-library");

if (argv.includes("--list")) {
  const text = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const a = text.indexOf("// ── Named fixtures");
  const b = text.indexOf("// MCP (local only)");
  console.log(text.slice(a, b).replace(/^\/\/ ?/gm, ""));
  process.exit(0);
}

const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/** A run's stored plan in the shape the Worker reads (src/imports/runs.ts `Manifest`): a run the seed made never planned
 *  a page, so a finish or a cancel on it reads an empty plan — never a missing one. */
const manifest = (fileSize, fileCount) => JSON.stringify({ file_size: fileSize, file_count: fileCount, files: [], choices: {}, writes: [], links: [], images: [] });

// ── ids and handles ─────────────────────────────────────────────────────────────────────────────────────────────
const MAIN = "org_test_docslib", ONE = "org_test_docslib_one", NONE = "org_test_docslib_none", OTHER = "org_test_docslib_other";
const ORGS = [MAIN, ONE, NONE, OTHER];
const ADMIN = "test-dl-admin", MEMBER = "test-dl-member", SOWNER = "test-dl-spaceowner", AGENT = "test-dl-agentuser", OUTSIDER = "test-dl-outsider";
const PEOPLE = [
  { handle: ADMIN, name: "Ada Test-Admin", color: "plum", email: "test-dl-admin@example.com", role: "Test admin" },
  { handle: MEMBER, name: "Max Test-Member", color: "sky", email: "test-dl-member@example.com", role: "Test member" },
  { handle: SOWNER, name: "Olu Test-Owner", color: "fern", email: "test-dl-spaceowner@example.com", role: "Test space owner" },
  { handle: AGENT, name: "Pia Test-Agent", color: "slate", email: "test-dl-agentuser@example.com", role: "Test agent user" },
  { handle: OUTSIDER, name: "Otto Test-Outsider", color: "rust", email: "test-dl-outsider@example.com", role: "Test outsider" },
];
/** Import run ids (fixed, so doc_versions.import_id can point at them). This seed owns 6300–6319. */
const IMP = { done: 6301, partial: 6302, oneMd: 6303, failed: 6304, cancelled: 6305, stale: 6306, running: 6308, other: 6309 };
export const TOKENS = {
  member: "trov_mcp_test_docslib_member_000000000000000000000000",
  outsider: "trov_mcp_test_docslib_outsider_0000000000000000000000",
};

// ── the import fixture files ────────────────────────────────────────────────────────────────────────────────────
// A tiny zip writer (local headers + central directory + end record; stored or deflated). `opts.flags` / `opts.method`
// force a header value (encrypted, an unsupported method); the damaged ones are made by cutting a good zip.
function zip(entries, opts = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "", "utf8");
    const dir = e.name.endsWith("/");
    const method = dir ? 0 : (opts.method ?? e.method ?? 8);
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = dir ? 0 : crc32(data);
    const flags = (opts.flags ?? 0) | 0x0800; // bit 11: the name is UTF-8
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(dir ? 0x10 : 0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}
/** A real 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** name → bytes. Each is the input of one or more import cases (the matrix's `zip` dimension). */
export function fixtureFiles() {
  const f = {};
  // test-handbook.zip — the VALID zip with every planner rule in it: a top-level folder (→ ONE top-level page),
  // README merged into its folder's page, name.md beside name/ merged, a folder with no .md (→ a plain page),
  // 3 levels, an attachments folder (images), a folder holding only an image, relative .md links (matched and not),
  // a [[…]] inside code, 3 titles that exist in test-docs › Engineering (Local setup, Deploys, Paging and escalation),
  // a file with no heading (title from the file name), unicode, and the design's 3 skipped files.
  f["test-handbook.zip"] = zip([
    { name: "handbook/" },
    { name: "handbook/README.md", data: "# Engineering handbook\n\nWelcome. Start with [Local setup](onboarding/local-setup.md), read [the glossary](glossary.md) and [a file that is not here](nowhere/missing.md).\n\n![The deploy flow](attachments/flow.png)\n\nInline code is left alone: `[[not-a-link]]`.\n" },
    { name: "handbook/onboarding.md", data: "# Onboarding\n\nWhere a new engineer starts.\n" },
    { name: "handbook/onboarding/first-week.md", data: "# Your first week\n\nDay one: [accounts](accounts.md). Then [Deploys](../operations/deploys.md).\n" },
    { name: "handbook/onboarding/local-setup.md", data: "# Local setup\n\nInstall Node 20 and pnpm 9.\n\nRun pnpm setup to create your local database.\n" },
    { name: "handbook/onboarding/accounts.md", data: "# Accounts and access\n\nAsk for GitHub and Cloudflare access.\n" },
    { name: "handbook/practices/code-review.md", data: "# Code review\n\nEvery change gets one review.\n" },
    { name: "handbook/practices/testing.md", data: "# Testing ✅ ünïcödé 日本語\n\nRun the suite before you push. 🚀\n" },
    { name: "handbook/operations/deploys.md", data: "# Deploys\n\nA merge to main deploys.\n" },
    { name: "handbook/operations/paging.md", data: "# Paging and escalation\n\nPage the on-call engineer first.\n" },
    { name: "handbook/operations/runbooks/rollback.md", data: "# Rolling back a bad deploy\n\nRevert, then redeploy. See [Deploys](../deploys.md).\n" },
    { name: "handbook/glossary.md", data: "Terms we use, with no heading on purpose (the title comes from the file name).\n" },
    { name: "handbook/code.md", data: "# Code sample\n\n```js\nconst x = \"[[not-a-link-either]]\";\n```\n\nBack to [the handbook](README.md).\n" },
    { name: "handbook/attachments/flow.png", data: PNG },
    { name: "handbook/images-only/diagram.png", data: PNG },
    { name: "handbook/design/logo.sketch", data: "not markdown" },
    { name: "handbook/notes/.DS_Store", data: "\u0000\u0001junk" },
    { name: "handbook/drafts/empty.md", data: "" },
  ]);
  // test-two-folders.zip — two top-level folders and a loose top-level file: three top-level pages, never spaces.
  f["test-two-folders.zip"] = zip([
    { name: "alpha/intro.md", data: "# Alpha intro\n\nFirst folder.\n" },
    { name: "beta/intro.md", data: "# Beta intro\n\nSecond folder.\n" },
    { name: "loose.md", data: "# A loose page\n\nAt the top of the zip.\n" },
  ]);
  // test-stored.zip — entries STORED (method 0), not deflated.
  f["test-stored.zip"] = zip([{ name: "stored/page.md", data: "# Stored page\n\nNot compressed.\n" }], { method: 0 });
  // test-damaged-truncated.zip — a good zip cut in half (no end record): "damaged or unsupported".
  const good = zip([{ name: "a.md", data: "# A\n\n" + "text ".repeat(400) }, { name: "b.md", data: "# B\n\nmore\n" }]);
  f["test-damaged-truncated.zip"] = good.subarray(0, Math.floor(good.length / 2));
  // test-damaged-crc.zip — one byte of the data flipped: the CRC no longer matches.
  const bad = Buffer.from(zip([{ name: "a.md", data: "# A\n\nhello world\n" }], { method: 0 }));
  bad[30 + "a.md".length + 3] ^= 0xff;
  f["test-damaged-crc.zip"] = bad;
  // test-encrypted.zip — the encrypted flag set (bit 0); test-unsupported-method.zip — method 12 (bzip2).
  f["test-encrypted.zip"] = zip([{ name: "secret.md", data: "# Secret\n" }], { flags: 1, method: 0 });
  f["test-unsupported-method.zip"] = zip([{ name: "bz.md", data: "# Bz\n" }], { method: 12 });
  // test-over-500-files.zip — 501 small Markdown files (the 500-file cap).
  f["test-over-500-files.zip"] = zip(Array.from({ length: 501 }, (_, i) => ({ name: `many/page-${String(i).padStart(3, "0")}.md`, data: `# Page ${i}\n` })));
  // test-exactly-500-files.zip — 500 files: AT the cap (allowed).
  f["test-exactly-500-files.zip"] = zip(Array.from({ length: 500 }, (_, i) => ({ name: `cap/page-${String(i).padStart(3, "0")}.md`, data: `# Cap page ${i}\n\nBody.\n` })));
  // test-over-50mb.zip — 60 files of 900 KB (each under the 1 MB page cap; 52.7 MB unpacked): the total cap.
  const filler = "# Big\n\n" + "lorem ipsum ".repeat(Math.floor((900 * 1024 - 8) / 12));
  f["test-over-50mb.zip"] = zip(Array.from({ length: 60 }, (_, i) => ({ name: `big/part-${i}.md`, data: filler })));
  // test-no-markdown.zip — only an image and a text file.
  f["test-no-markdown.zip"] = zip([{ name: "pics/a.png", data: PNG }, { name: "notes.txt", data: "plain text" }]);
  // test-traversal.zip — unsafe paths (parent, absolute, a backslash climb) beside one good page.
  f["test-traversal.zip"] = zip([
    { name: "../evil.md", data: "# Evil parent\n" },
    { name: "/abs.md", data: "# Absolute\n" },
    { name: "a/../../b.md", data: "# Climb\n" },
    { name: "..\\win.md", data: "# Backslash climb\n" },
    { name: "ok/good.md", data: "# The good page\n\nOnly this one is imported.\n" },
  ]);
  // test-too-deep.zip — Markdown in 5 folders (a folder is a level: d1 … d5 are levels 1–5, deep.md would be 6)
  // beside a shallow page; test-exactly-5-levels.zip — Markdown in 4 folders: level 5, AT the cap (allowed).
  const dirs = (n) => Array.from({ length: n }, (_, i) => `d${i + 1}`).join("/");
  f["test-too-deep.zip"] = zip([{ name: `${dirs(5)}/deep.md`, data: "# Too deep\n" }, { name: "shallow.md", data: "# Shallow\n" }]);
  f["test-exactly-5-levels.zip"] = zip([{ name: `${dirs(4)}/at-cap.md`, data: "# At the cap\n\nThe deepest an import may go.\n" }]);
  // test-big-page.zip — one Markdown file over 1 MB beside a small one.
  f["test-big-page.zip"] = zip([{ name: "huge.md", data: "# Huge\n\n" + "x".repeat(1024 * 1024 + 10) }, { name: "small.md", data: "# Small\n" }]);
  // test-images.zip — a real PNG, a "PNG" that is text (sniffed: not an image), an 11 MB image (over the 10 MB cap).
  f["test-images.zip"] = zip([
    { name: "pics.md", data: "# Pictures\n\n![ok](img/ok.png)\n\n![fake](img/fake.png)\n\n![huge](img/huge.png)\n" },
    { name: "img/ok.png", data: PNG },
    { name: "img/fake.png", data: "this is not a png" },
    { name: "img/huge.png", data: Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(11 * 1024 * 1024)]) },
  ]);
  // test-duplicate.zip — two files that become the same page (a.md and a.markdown).
  f["test-duplicate.zip"] = zip([{ name: "a.md", data: "# A from md\n" }, { name: "a.markdown", data: "# A from markdown\n" }]);
  // Loose files (several Markdown files at once, the drop-to-import cases, the bad-file cases).
  f["test-single.md"] = Buffer.from("# Test single page\n\nIt links to [[test-architecture]] and to [[test-no-such-page]].\n");
  f["test-second.md"] = Buffer.from("# Test second page\n\nA second loose file.\n");
  f["test-local-setup.md"] = Buffer.from("# Local setup\n\nA loose file whose title already exists in Engineering.\n");
  f["test-empty.md"] = Buffer.from("");
  f["test-not-utf8.md"] = Buffer.from([0x23, 0x20, 0x54, 0x65, 0x73, 0x74, 0x0a, 0xff, 0xfe, 0xfa, 0x80, 0x0a]);
  f["test-xss.md"] = Buffer.from("# <img src=x onerror=alert('test-xss-title')> XSS title\n\n<script>alert('test-xss-body')</script>\n\n[click me](javascript:alert('test-xss-link'))\n\n<iframe src=\"https://example.com\"></iframe>\n");
  f["test-huge.md"] = Buffer.from("# Huge loose\n\n" + "y".repeat(1024 * 1024 + 10));
  f["test-notes.txt"] = Buffer.from("plain text, not Markdown\n");
  f["test-report.pdf"] = Buffer.from("%PDF-1.4\n% test-not-a-real-pdf\n");
  return f;
}

function writeFixtureFiles() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const files = fixtureFiles();
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(FIXTURE_DIR, name), bytes);
  console.log(`  import fixtures: ${Object.keys(files).length} files in ${FIXTURE_DIR}`);
}

// ── the rows ────────────────────────────────────────────────────────────────────────────────────────────────────
/** A page: its docs row and its versions. versions: [version, status, by, daysAgo, summary, body, extra?]. */
function page(s, c, org, d) {
  const promoted = d.versions.filter((v) => v[1] === "promoted").at(-1) ?? null;
  const live = promoted ? promoted[0] : 0;
  s.push(insert("docs", {
    org_id: org, slug: d.slug, section: d.section ?? "reference", space: d.space, title: d.title,
    body: promoted ? promoted[5] : "", current_version: live,
    updated_at: c.days(promoted ? promoted[3] : d.versions[0][3]), updated_by: promoted ? promoted[2] : d.versions[0][2],
    owner: d.owner ?? d.versions[0][2], parent_slug: d.parent ?? null, tree_rank: d.rank ?? null,
    archived_at: d.archived ? c.days(d.archived.days) : null, archived_by: d.archived ? d.archived.by : null,
  }));
  for (const [version, status, by, days, summary, body, extra = {}] of d.versions) {
    s.push(insert("doc_versions", {
      org_id: org, slug: d.slug, version, body, summary, status, confidence: "high", created_at: c.days(days), created_by: by,
      content_hash: sha256(body), base_version: version > 1 ? version - 1 : null, change_kind: version === 1 ? "create" : "edit", low_confidence: 0,
      parent_slug: extra.parent_slug ?? null, import_id: extra.import_id ?? null, import_path: extra.import_path ?? null,
    }));
  }
}
/** A live page with one approved version. */
const live = (slug, title, space, parent, body, o = {}) => ({
  slug, title, space, parent, rank: o.rank ?? null, section: o.section, owner: o.owner,
  versions: [[1, "promoted", o.by ?? ADMIN, o.days ?? 20, "First version", body ?? `# ${title}\n\nA test page.\n`]],
});

function mainOrg(c) {
  const s = [];
  const O = q(MAIN);
  // Spaces: the three starters (orgStatements wrote them) get descriptions and owners; three more are live; two archived.
  s.push(`UPDATE doc_spaces SET description = 'test- How we build, run and fix things. New here? Start with Getting started.' WHERE org_id = ${O} AND slug = 'engineering'`);
  s.push(`UPDATE doc_spaces SET description = 'test- Principles, components and how we review design work.' WHERE org_id = ${O} AND slug = 'design'`);
  const sp = (slug, name, icon, color, rank, description, extra = {}) => s.push(insert("doc_spaces", {
    org_id: MAIN, slug, name, icon, color, description, sort_rank: rank, archived_at: extra.archived ? c.days(extra.archived) : null,
    archived_by: extra.archived ? ADMIN : null, created_at: c.days(40), created_by: ADMIN,
  }));
  sp("security", "Security", "shield", "#b4562c", 4096, "Threat models, security reviews and how to report a problem.");
  sp("test-long-space", "Test space with a name of forty letters.", "book", "#7a4f8f", 5120,
    "test- The longest description a space may have: one hundred and forty characters, so the header and the cards show how it wraps in two lines");
  sp("onboarding", "Onboarding", "users", "#966800", 6144, "test- Help someone new find their feet.");
  sp("old-wiki", "Old Wiki", "book", "#2467af", 7168, "test- The wiki before the Library. Archived.", { archived: 5 });
  sp("design-old", "Design", "pen", "#607a29", 8192, "test- An archived space named like a live one (restore → name_taken).", { archived: 9 });
  const own = (space, handle) => s.push(insert("doc_space_owners", { org_id: MAIN, space_slug: space, handle, added_at: c.days(30), added_by: ADMIN }));
  own("engineering", SOWNER); own("engineering", ADMIN); own("design", SOWNER); own("security", ADMIN);

  const E = "engineering", P = "product", D = "design";
  const pages = [
    live("test-getting-started", "Getting started", E, null, "# Getting started\n\nSet up your machine, learn the repository and ship a first change.\n", { rank: 1024 }),
    live("test-local-setup", "Local setup", E, "test-getting-started", "# Local setup\n\nInstall Node 18 and pnpm.\n", { rank: 1024 }),
    live("test-repo-layout", "Repository layout", E, "test-getting-started", undefined, { rank: 2048 }),
    { slug: "test-first-change", title: "Your first change", space: E, parent: "test-getting-started", rank: 3072,
      versions: [[1, "staged", AGENT, 0.1, "Drafted by an agent", "# Your first change\n\nPick a small ticket, branch, test, open a PR.\n"]] },
    live("test-architecture", "Architecture", E, null, "# Architecture\n\nHow the web app, the API and the data model fit together.\n\n## Web app\n\nSee [[test-web-app]].\n\n## API\n\nSee [[test-api]].\n", { rank: 2048 }),
    live("test-web-app", "Web app", E, "test-architecture", undefined, { rank: 1024 }),
    live("test-sidebar-nav", "Sidebar and navigation", E, "test-web-app"),
    live("test-api", "API", E, "test-architecture", undefined, { rank: 2048 }),
    { slug: "test-authentication", title: "Authentication", space: E, parent: "test-api", rank: 1024, owner: SOWNER,
      versions: [
        [1, "promoted", SOWNER, 60, "Moved here from the old wiki", "# Authentication\n\nv1 body.\n"],
        [2, "rejected", AGENT, 30, "A change someone rejected", "# Authentication\n\nrejected body.\n"],
        [3, "promoted", ADMIN, 3, "Added the steps for rotating keys",
          "# Authentication\n\nHow a person signs in, and how an agent gets a token.\n\n## How sign-in works\n\n1. GitHub or Google.\n2. A session cookie.\n\n### Sessions\n\nA session lasts 30 days.\n\n## Tokens for agents\n\nSee [[test-agent-tokens]] and [[test-sso|single sign-on]].\n\n```sh\ncurl -H 'Authorization: Bearer …' http://localhost/mcp\n```\n\n## Rotating keys\n\n> Rotate every 90 days.\n"],
      ] },
    live("test-sso", "Single sign-on", E, "test-authentication"),
    live("test-agent-tokens", "Tokens for agents", E, "test-authentication"),
    { slug: "test-rate-limits", title: "Rate limits", space: E, parent: "test-api", rank: 2048,
      versions: [[1, "promoted", SOWNER, 14, "First version", "# Rate limits\n\n100 requests a minute.\n"], [2, "staged", AGENT, 0.03, "Clarified the burst limit", "# Rate limits\n\n100 requests a minute, bursts of 20.\n"]] },
    live("test-error-codes", "Error codes", E, "test-api", undefined, { rank: 3072 }),
    live("test-data-model", "Data model", E, "test-architecture", undefined, { rank: 3072 }),
    live("test-runbooks", "Runbooks", E, null, undefined, { rank: 3072 }),
    // tree-unranked: two unranked children (drawn A to Z after the ranked one).
    live("test-paging", "Paging and escalation", E, "test-runbooks"),
    { slug: "test-deploys", title: "Deploys", space: E, parent: "test-runbooks",
      versions: [
        [1, "promoted", SOWNER, 12, "First version", "# Deploys\n\nA merge to main deploys.\n"],
        [2, "staged", ADMIN, 0.05, "Imported from test-handbook-v2.zip", "# Deploys\n\nA merge to main deploys. (from the import)\n", { import_id: IMP.partial, import_path: "handbook/operations/deploys.md" }],
        [3, "staged", AGENT, 0.02, "An agent's change on top of the import's", "# Deploys\n\nA merge to main deploys. (the agent's)\n"],
      ] },
    live("test-incident-review", "Writing an incident review", E, "test-runbooks", undefined, { rank: 512 }),
    live("test-adrs", "Decision records", E, null, undefined, { rank: 4096, section: "decisions" }),
    live("test-adr-012", "ADR-012: Docs live in spaces", E, "test-adrs", undefined, { section: "decisions" }),
    // page-links
    live("test-links", "Links and backlinks test", E, null,
      "# Links and backlinks test\n\nA good link: [[test-authentication]]. With a label: [[test-rate-limits|the rate limits]].\n\nBroken: [[test-no-such-page]].\n\nIn code: `[[test-in-code]]` is not a link.\n\n```md\n[[test-in-fence]]\n```\n\nCross-space: [[test-pricing]]. To a page never approved: [[test-first-change]]. To the archived space: [[test-old-wiki-home]].\n",
      { rank: 5120 }),
    live("test-unbackfilled", "Links not yet backfilled", E, null, "# Links not yet backfilled\n\nPoints at [[test-architecture]] but has no doc_links row until the cron runs.\n", { rank: 6144 }),
    live("test-xss", "<img src=x onerror=alert('test-xss-title')> Injection test", E, null,
      "# Injection test\n\n<script>alert('test-xss-body')</script>\n\n<img src=x onerror=alert('test-xss-img')>\n\n[click me](javascript:alert('test-xss-link'))\n", { rank: 7168 }),
    live("test-unicode", "Ünïcödé — 日本語のページ 🚀 test", E, null, "# Ünïcödé\n\nÇa marche. 日本語。 Emoji 🚀✅.\n", { rank: 8192 }),
    // tree-orphan / tree-loop / tree-cross-parent
    live("test-orphan", "Orphan page (its parent is gone)", E, "test-gone-parent"),
    live("test-loop-a", "Loop A (parent is Loop B)", E, "test-loop-b"),
    live("test-loop-b", "Loop B (parent is Loop A)", E, "test-loop-a"),
    live("test-crossparent", "Parent in another space", E, "test-pricing"),
    // proposal-parent / proposal-badparent
    { slug: "test-moves-on-promote", title: "Moves on promote", space: E, parent: null, rank: 9216,
      versions: [[1, "promoted", ADMIN, 10, "First version", "# Moves on promote\n\nv1.\n"], [2, "staged", AGENT, 0.04, "Asks to go under Runbooks", "# Moves on promote\n\nv2.\n", { parent_slug: "test-runbooks" }]] },
    { slug: "test-badparent-on-promote", title: "Bad parent on promote", space: E, parent: null, rank: 10240,
      versions: [[1, "promoted", ADMIN, 10, "First version", "# Bad parent on promote\n\nv1.\n"], [2, "staged", AGENT, 0.04, "Asks for a parent at level 5", "# Bad parent on promote\n\nv2.\n", { parent_slug: "test-deep-4" }]] },
  ];
  // tree-deep-5: depth 0 … 4 (5 levels, the most a page may have — the owner's ruling). The last is the deepest page.
  const deep = [
    "Platform", "Infrastructure", "Networking", "Regional failover",
    "Failing over the edge load balancers when a whole region stops answering health checks",
  ];
  deep.forEach((title, i) => pages.push(live(`test-deep-${i}`, title, E, i === 0 ? null : `test-deep-${i - 1}`, `# ${title}\n\nLevel ${i + 1}.\n`, { rank: i === 0 ? 11264 : null })));
  // The on-call checklist (review-agent-group: an agent's staged v2) sits beside the deepest page, at level 5.
  const checklist = "Checklist for the on-call engineer during a regional failover, including who to tell and when";
  pages.push({ slug: "test-failover-checklist", title: checklist, space: E, parent: "test-deep-3",
    versions: [[1, "promoted", SOWNER, 8, "First version", `# ${checklist}\n\nLevel 5.\n`], [2, "staged", AGENT, 0.06, "Added who to tell", `# ${checklist}\n\nLevel 5. Tell #incidents.\n`]] });
  // Imported (staged) pages of import 6302 (review-import-group): a parent page and two under it, plus a new version of
  // test-local-setup.
  const imp = (slug, title, parent, path) => ({ slug, title, space: E, parent, owner: ADMIN,
    versions: [[1, "staged", ADMIN, 0.05, `Imported from ${path}`, `# ${title}\n\nImported.\n`, { import_id: IMP.partial, import_path: path }]] });
  pages.push(imp("test-imp-onboarding", "Onboarding (imported)", "test-getting-started", "handbook/onboarding.md"));
  pages.push(imp("test-imp-first-week", "Your first week", "test-imp-onboarding", "handbook/onboarding/first-week.md"));
  pages.push(imp("test-imp-accounts", "Accounts and access", "test-imp-onboarding", "handbook/onboarding/accounts.md"));
  // Product
  pages.push(live("test-roadmap-principles", "Roadmap principles", P, null, undefined, { rank: 1024, section: "context" }));
  pages.push(live("test-pricing", "Pricing and plans", P, null, "# Pricing and plans\n\nPlans, limits and how we price new features.\n", { rank: 2048, section: "context" }));
  pages.push(live("test-plan-limits", "Plan limits", P, "test-pricing"));
  pages.push(live("test-briefs", "Product briefs", P, null, undefined, { rank: 3072, section: "context" }));
  pages.push({ slug: "test-importing-md", title: "Importing Markdown", space: P, parent: "test-briefs", section: "context",
    versions: [[1, "promoted", ADMIN, 9, "First version", "# Importing Markdown\n\nv1.\n"], [2, "staged", AGENT, 0.07, "Added the caps", "# Importing Markdown\n\nUp to 500 files or 50 MB.\n"]] });
  pages.push(live("test-release-notes", "Release notes", P, null, undefined, { rank: 4096 }));
  for (let i = 1; i <= 24; i++) pages.push(live(`test-release-${String(i).padStart(2, "0")}`, `Test release note ${String(i).padStart(2, "0")}`, P, "test-release-notes", undefined, { days: 30 - i, by: i % 2 ? ADMIN : MEMBER }));
  // Design
  pages.push(live("test-design-principles", "Design principles", D, null, undefined, { rank: 1024 }));
  pages.push(live("test-components", "Components", D, null, undefined, { rank: 2048 }));
  for (const [slug, title] of [["test-segmented", "Segmented switch"], ["test-tab-bar", "Tab bar"], ["test-empty-states", "Empty states"]]) pages.push(live(slug, title, D, "test-components"));
  // The long space, Onboarding, the archived Old Wiki
  pages.push(live("test-long-space-page", "Test page in the long space", "test-long-space", null));
  pages.push(live("test-welcome", "Welcome", "onboarding", null));
  pages.push(live("test-old-wiki-home", "Old wiki home", "old-wiki", null, "# Old wiki home\n\nReadable by link while the space is archived.\n"));
  pages.push(live("test-old-wiki-page", "Old wiki page", "old-wiki", "test-old-wiki-home"));
  // Pages of the DONE import 6301 (approved since): live, their version tagged with the import.
  for (const [slug, title, path] of [["test-imp-done-a", "Imported and approved A", "a.md"], ["test-imp-done-b", "Imported and approved B", "b.md"]]) {
    pages.push({ slug, title, space: E, parent: "test-runbooks", versions: [[1, "promoted", ADMIN, 0.08, `Imported from ${path}`, `# ${title}\n\nApproved.\n`, { import_id: IMP.done, import_path: path }]] });
  }
  // page-archived (0083_doc_archive): Runbooks › "Old on-call runbook", archived by the space's owner. Its old place
  // (parent_slug) is kept for Restore; its child moved up to Runbooks when it was archived; a person's staged v2 waits,
  // hidden from Review while it is archived; a live page links to it (the link reads "Archived").
  pages.push({ slug: "test-old-runbook", title: "Old on-call runbook", space: E, parent: "test-runbooks", rank: 4096, owner: SOWNER,
    archived: { days: 2, by: SOWNER },
    versions: [[1, "promoted", SOWNER, 40, "First version", "# Old on-call runbook\n\nThe pager rota before we moved to the new tool.\n"],
      [2, "staged", MEMBER, 3, "Updated the rota", "# Old on-call runbook\n\nThe pager rota, updated.\n"]] });
  pages.push(live("test-old-runbook-step", "Old runbook: first step", E, "test-runbooks", "# Old runbook: first step\n\nIt was under the old runbook; archiving moved it up a level.\n", { rank: 4608 }));
  pages.push(live("test-links-archived", "Links to an archived page", E, null, "# Links to an archived page\n\nThe old runbook was [[test-old-runbook]]. With a label: [[test-old-runbook|the old rota]].\n", { rank: 11264 }));
  pages.push({ slug: "test-imp-release-oct", title: "Release notes: October", space: P, parent: "test-release-notes",
    versions: [[1, "promoted", MEMBER, 1, "Imported from test-release-notes-october.md", "# Release notes: October\n\nShipped.\n", { import_id: IMP.oneMd, import_path: "test-release-notes-october.md" }]] });
  for (const d of pages) page(s, c, MAIN, d);
  // The new version of test-local-setup (an import's, on a live page).
  s.push(insert("doc_versions", { org_id: MAIN, slug: "test-local-setup", version: 2, body: "# Local setup\n\nInstall Node 20 and pnpm 9.\n", summary: "Imported from handbook/onboarding/local-setup.md",
    status: "staged", confidence: "high", created_at: c.days(0.05), created_by: ADMIN, content_hash: sha256("ls2"), base_version: 1, change_kind: "edit", low_confidence: 0,
    parent_slug: null, import_id: IMP.partial, import_path: "handbook/onboarding/local-setup.md" }));

  // doc_links for the LIVE pages that link (what promote writes); test-unbackfilled is left without.
  const links = [["test-architecture", "test-web-app"], ["test-architecture", "test-api"], ["test-authentication", "test-agent-tokens"], ["test-authentication", "test-sso"],
    ["test-links", "test-authentication"], ["test-links", "test-rate-limits"], ["test-links", "test-no-such-page"], ["test-links", "test-pricing"],
    ["test-links", "test-first-change"], ["test-links", "test-old-wiki-home"], ["test-links-archived", "test-old-runbook"]];
  for (const [from_slug, to_slug] of links) s.push(insert("doc_links", { org_id: MAIN, from_slug, to_slug }));

  // Import runs (imports-history). Their start times follow their ids, as real ones do (an id is given at the start),
  // so "newest first" by id and by start agree: 6301 (0.1 day ago) … 6306 (0.02).
  const run = (id, status, by, startedDays, file, space, parent, counts, failures, extra = {}) => s.push(insert("doc_imports", {
    id, org_id: MAIN, space_slug: space, parent_slug: parent, file_name: file, started_by: by, started_at: c.days(startedDays),
    updated_at: extra.updated ?? c.days(startedDays - 0.001), ended_at: status === "running" ? null : c.days(startedDays - 0.002), status,
    counts: JSON.stringify(counts), failures: JSON.stringify(failures), total: counts.pages ?? 0,
    manifest: manifest(extra.size ?? null, extra.count ?? 0), images: "[]",
  }));
  run(IMP.done, "done", ADMIN, 0.1, "test-handbook.zip", E, "test-runbooks", { pages: 2, new_pages: 2, staged: 2, staged_new: 2 }, [], { size: 2_400_000, count: 2 });
  run(IMP.partial, "partial", ADMIN, 0.06, "test-handbook-v2.zip", E, "test-getting-started",
    { pages: 5, new_pages: 3, versions: 2, skipped_files: 3, staged: 5, staged_new: 3, staged_versions: 2 },
    [{ path: "handbook/design/logo.sketch", code: "not_markdown" }, { path: "handbook/notes/.DS_Store", code: "hidden" }, { path: "handbook/drafts/empty.md", code: "empty" }], { size: 3_100_000, count: 8 });
  run(IMP.oneMd, "done", MEMBER, 0.05, "test-release-notes-october.md", P, "test-release-notes", { pages: 1, new_pages: 1, staged: 1, staged_new: 1 }, [], { size: 14_000, count: 1 });
  run(IMP.failed, "failed", MEMBER, 0.04, "test-product-wiki.zip", P, null, { pages: 2, new_pages: 2, failed: 2 },
    [{ path: "wiki/a.md", code: "not_utf8" }, { path: "wiki/b.md", code: "failed" }], { size: 41_000_000, count: 2 });
  run(IMP.cancelled, "abandoned", SOWNER, 0.03, "test-cancelled.zip", D, null, { pages: 4, new_pages: 4 }, [{ path: null, code: "cancelled" }], { size: 880_000, count: 4 });
  run(IMP.stale, "running", MEMBER, 0.02, "test-stale-run.zip", E, null, { pages: 3, new_pages: 3 }, [], { size: 12_000, count: 3, updated: c.days(10 / 1440) });

  // triage-space: proposals the gate sent to Unplaced for their space.
  const tri = (id, space, reason, d) => s.push(insert("needs_triage", { id, org_id: MAIN, resolved: 0, created_at: c.days(d), source_author: AGENT, reason,
    raw: JSON.stringify({ slug: `test-triaged-${space}`, section: "reference", space, title: `Triaged page for ${space}`, body: `# Triaged page for ${space}\n\nNamed the space ${space}.\n`, change_summary: "test", confidence: "high" }) }));
  tri(6311, "test-nowhere", "unknown space: test-nowhere", 0.2);
  tri(6312, "old-wiki", "archived space: old-wiki", 0.3);

  s.push(insert("mcp_tokens", { person: MEMBER, org_id: MAIN, token_hash: sha256(TOKENS.member), token_hint: TOKENS.member.slice(-4), created_at: c.days(1), revoked: 0 }));
  return s;
}

function oneOrg(c) {
  const s = [`DELETE FROM doc_spaces WHERE org_id = ${q(ONE)} AND slug <> 'engineering'`];
  for (const d of [
    live("test-one-home", "One-space home", "engineering", null, undefined, { rank: 1024 }),
    live("test-one-child-a", "One-space child A", "engineering", "test-one-home"),
    live("test-one-child-b", "One-space child B", "engineering", "test-one-home"),
  ]) page(s, c, ONE, d);
  s.push(insert("doc_imports", {
    id: IMP.running, org_id: ONE, space_slug: "engineering", parent_slug: null, file_name: "test-running.zip", started_by: MEMBER,
    started_at: c.days(0.01), updated_at: new Date(c.t + 12 * 3600_000).toISOString(), ended_at: null, status: "running",
    counts: JSON.stringify({ pages: 40, new_pages: 40, staged: 12, staged_new: 12 }), failures: "[]", total: 40,
    manifest: manifest(3_100_000, 52), images: "[]",
  }));
  return s;
}

function noneOrg() {
  return [`DELETE FROM doc_spaces WHERE org_id = ${q(NONE)}`];
}

function otherOrg(c) {
  const s = [];
  for (const d of [
    live("test-getting-started", "Other org's Getting started", "engineering", null, "# Other org's Getting started\n\ntest- This page belongs to test-docs-other.\n", { by: OUTSIDER }),
    live("test-other-secret", "Other org secret page", "engineering", null, "# Other org secret page\n\ntest- Nobody outside test-docs-other may read this.\n", { by: OUTSIDER }),
  ]) page(s, c, OTHER, d);
  s.push(insert("doc_imports", {
    id: IMP.other, org_id: OTHER, space_slug: "engineering", parent_slug: null, file_name: "test-other-org.zip", started_by: OUTSIDER,
    started_at: c.days(2), updated_at: c.days(2), ended_at: c.days(2), status: "done", counts: JSON.stringify({ pages: 1, new_pages: 1, staged: 1, staged_new: 1 }),
    failures: "[]", total: 1, manifest: manifest(9_000, 1), images: "[]",
  }));
  s.push(insert("mcp_tokens", { person: OUTSIDER, org_id: OTHER, token_hash: sha256(TOKENS.outsider), token_hint: TOKENS.outsider.slice(-4), created_at: c.days(1), revoked: 0 }));
  return s;
}

export function docsLibraryStatements(now = new Date()) {
  const c = makeClock(now);
  const at = c.days(45);
  const s = [];
  for (const p of PEOPLE) s.push(...personStatements(p, at));
  s.push(...orgStatements({ id: MAIN, slug: "test-docs", name: "Test Docs Library", owner: ADMIN, plan: ["enterprise", "granted", {}],
    members: [[ADMIN, "owner", "Test admin"], [MEMBER, "member", null], [SOWNER, "member", null], [AGENT, "member", null]] }, at));
  s.push(...orgStatements({ id: ONE, slug: "test-docs-one", name: "Test Docs One Space", owner: ADMIN, plan: ["enterprise", "granted", {}],
    members: [[ADMIN, "owner", null], [MEMBER, "member", null]] }, at));
  s.push(...orgStatements({ id: NONE, slug: "test-docs-nospaces", name: "Test Docs No Spaces", owner: ADMIN, plan: ["enterprise", "granted", {}],
    members: [[ADMIN, "owner", null], [MEMBER, "member", null]] }, at));
  s.push(...orgStatements({ id: OTHER, slug: "test-docs-other", name: "Test Docs Other Org", owner: OUTSIDER, plan: ["enterprise", "granted", {}],
    members: [[OUTSIDER, "owner", null]] }, at));
  s.push(...mainOrg(c), ...oneOrg(c), ...noneOrg(), ...otherOrg(c));
  // page-unbackfilled: let the daily cron's one-pass backfill run again (a local, global cursor).
  s.push(`INSERT INTO cron_cursor (job, last_key, updated_at) VALUES ('doc_links_backfill', '', ${q(now.toISOString())}) ON CONFLICT(job) DO UPDATE SET last_key = '', updated_at = excluded.updated_at`);
  return s;
}

// ── the check list (each fixture's rows, read back) ─────────────────────────────────────────────────────────────
const M = q(MAIN);
export const CHECKS = [
  ["spaces-many: live spaces in test-docs", `SELECT COUNT(*) AS n FROM doc_spaces WHERE org_id = ${M} AND archived_at IS NULL`, 6],
  ["space-archived + space-archived-clash: archived spaces", `SELECT COUNT(*) AS n FROM doc_spaces WHERE org_id = ${M} AND archived_at IS NOT NULL`, 2],
  ["space-empty: pages in Security", `SELECT COUNT(*) AS n FROM docs WHERE org_id = ${M} AND space = 'security'`, 0],
  ["space-no-desc: Product description is empty and it has no owner", `SELECT COUNT(*) AS n FROM doc_spaces s WHERE s.org_id = ${M} AND s.slug = 'product' AND s.description = '' AND NOT EXISTS (SELECT 1 FROM doc_space_owners o WHERE o.org_id = s.org_id AND o.space_slug = s.slug)`, 1],
  ["space-long: the 40-character name", `SELECT COUNT(*) AS n FROM doc_spaces WHERE org_id = ${M} AND length(name) = 40 AND length(description) = 140`, 1],
  ["space owners: test-dl-spaceowner owns Engineering and Design", `SELECT COUNT(*) AS n FROM doc_space_owners WHERE org_id = ${M} AND handle = '${SOWNER}'`, 2],
  ["spaces-one: test-docs-one spaces", `SELECT COUNT(*) AS n FROM doc_spaces WHERE org_id = ${q(ONE)}`, 1],
  ["spaces-none: test-docs-nospaces spaces", `SELECT COUNT(*) AS n FROM doc_spaces WHERE org_id = ${q(NONE)}`, 0],
  ["tree-deep-5: pages in the deep chain", `SELECT COUNT(*) AS n FROM docs WHERE org_id = ${M} AND slug LIKE 'test-deep-%'`, 5],
  ["tree-deep-5: the level-5 page's parent", `SELECT COUNT(*) AS n FROM docs WHERE org_id = ${M} AND slug = 'test-deep-4' AND parent_slug = 'test-deep-3'`, 1],
  ["tree-deep-5: the checklist at level 5 with a staged v2", `SELECT COUNT(*) AS n FROM doc_versions v JOIN docs d ON d.org_id = v.org_id AND d.slug = v.slug WHERE v.org_id = ${M} AND v.slug = 'test-failover-checklist' AND v.status = 'staged' AND d.parent_slug = 'test-deep-3'`, 1],
  ["tree-deep-5: no page deeper than the cap", `WITH RECURSIVE t(slug, depth) AS (SELECT slug, 0 FROM docs WHERE org_id = ${M} AND slug = 'test-deep-0' UNION ALL SELECT d.slug, t.depth + 1 FROM docs d JOIN t ON d.parent_slug = t.slug WHERE d.org_id = ${M}) SELECT COUNT(*) AS n FROM t WHERE depth > 4`, 0],
  ["tree-unranked: unranked children of Runbooks", `SELECT COUNT(*) AS n FROM docs WHERE org_id = ${M} AND parent_slug = 'test-runbooks' AND tree_rank IS NULL AND slug IN ('test-paging','test-deploys')`, 2],
  ["tree-orphan: parent is no page", `SELECT COUNT(*) AS n FROM docs d WHERE d.org_id = ${M} AND d.slug = 'test-orphan' AND NOT EXISTS (SELECT 1 FROM docs p WHERE p.org_id = d.org_id AND p.slug = d.parent_slug)`, 1],
  ["tree-loop: two pages that are each other's parent", `SELECT COUNT(*) AS n FROM docs WHERE org_id = ${M} AND slug IN ('test-loop-a','test-loop-b') AND parent_slug IN ('test-loop-a','test-loop-b')`, 2],
  ["tree-cross-parent: parent in Product", `SELECT COUNT(*) AS n FROM docs d JOIN docs p ON p.org_id = d.org_id AND p.slug = d.parent_slug WHERE d.org_id = ${M} AND d.slug = 'test-crossparent' AND p.space = 'product'`, 1],
  ["tree-many: children of Release notes", `SELECT COUNT(*) AS n FROM docs WHERE org_id = ${M} AND parent_slug = 'test-release-notes'`, 25],
  ["page-live: test-authentication is live at v3 with a rejected v2", `SELECT COUNT(*) AS n FROM docs d WHERE d.org_id = ${M} AND d.slug = 'test-authentication' AND d.current_version = 3 AND EXISTS (SELECT 1 FROM doc_versions v WHERE v.org_id = d.org_id AND v.slug = d.slug AND v.version = 2 AND v.status = 'rejected')`, 1],
  ["page-pending: test-rate-limits live v1 + staged v2", `SELECT COUNT(*) AS n FROM docs d JOIN doc_versions v ON v.org_id = d.org_id AND v.slug = d.slug WHERE d.org_id = ${M} AND d.slug = 'test-rate-limits' AND d.current_version = 1 AND v.version = 2 AND v.status = 'staged'`, 1],
  ["page-staged: test-first-change never approved", `SELECT COUNT(*) AS n FROM docs WHERE org_id = ${M} AND slug = 'test-first-change' AND current_version = 0`, 1],
  ["page-imported-staged: staged pages of import 6302 (3 new + 2 versions)", `SELECT COUNT(*) AS n FROM doc_versions WHERE org_id = ${M} AND import_id = ${IMP.partial} AND status = 'staged'`, 5],
  ["page-links: doc_links rows from test-links (one broken)", `SELECT COUNT(*) AS n FROM doc_links WHERE org_id = ${M} AND from_slug = 'test-links'`, 6],
  ["page-links: the broken link's target is no page", `SELECT COUNT(*) AS n FROM doc_links l WHERE l.org_id = ${M} AND NOT EXISTS (SELECT 1 FROM docs d WHERE d.org_id = l.org_id AND d.slug = l.to_slug)`, 1],
  ["page-archived: test-old-runbook archived by the space owner, its old place kept", `SELECT COUNT(*) AS n FROM docs WHERE org_id = ${M} AND slug = 'test-old-runbook' AND archived_at IS NOT NULL AND archived_by = '${SOWNER}' AND parent_slug = 'test-runbooks'`, 1],
  ["page-archived: its child moved up to Runbooks", `SELECT COUNT(*) AS n FROM docs WHERE org_id = ${M} AND slug = 'test-old-runbook-step' AND parent_slug = 'test-runbooks' AND archived_at IS NULL`, 1],
  ["page-archived: a live page links to it", `SELECT COUNT(*) AS n FROM doc_links WHERE org_id = ${M} AND from_slug = 'test-links-archived' AND to_slug = 'test-old-runbook'`, 1],
  ["page-archived: its staged v2 waits, hidden from Review", `SELECT COUNT(*) AS n FROM doc_versions WHERE org_id = ${M} AND slug = 'test-old-runbook' AND version = 2 AND status = 'staged'`, 1],
  ["page-archived: the only archived page", `SELECT COUNT(*) AS n FROM docs WHERE org_id IN (${ORGS.map(q).join(", ")}) AND archived_at IS NOT NULL`, 1],
  ["page-unbackfilled: no doc_links row yet", `SELECT COUNT(*) AS n FROM doc_links WHERE org_id = ${M} AND from_slug = 'test-unbackfilled'`, 0],
  ["page-unbackfilled: the backfill cursor is reset", `SELECT COUNT(*) AS n FROM cron_cursor WHERE job = 'doc_links_backfill' AND last_key = ''`, 1],
  ["page-xss / page-unicode", `SELECT COUNT(*) AS n FROM docs WHERE org_id = ${M} AND slug IN ('test-xss','test-unicode') AND current_version = 1`, 2],
  ["proposal-parent / badparent: staged versions asking for a parent", `SELECT COUNT(*) AS n FROM doc_versions WHERE org_id = ${M} AND status = 'staged' AND parent_slug IS NOT NULL`, 2],
  ["imports-history: runs in test-docs", `SELECT COUNT(*) AS n FROM doc_imports WHERE org_id = ${M}`, 6],
  ["imports-history: start times follow the ids (no run started after a newer id)", `SELECT COUNT(*) AS n FROM doc_imports a JOIN doc_imports b ON b.org_id = a.org_id AND b.id > a.id WHERE a.org_id = ${M} AND b.started_at <= a.started_at`, 0],
  ["imports-history: one of each stored status (done ×2, partial, failed, abandoned, running-stale)", `SELECT COUNT(DISTINCT status) AS n FROM doc_imports WHERE org_id = ${M}`, 5],
  ["import-running: test-docs-one holds a live running run", `SELECT COUNT(*) AS n FROM doc_imports WHERE org_id = ${q(ONE)} AND status = 'running' AND updated_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`, 1],
  ["import-plans: every seeded run stores a plan the Worker can read (a writes list)", `SELECT COUNT(*) AS n FROM doc_imports WHERE org_id IN (${ORGS.map(q).join(", ")}) AND json_type(manifest, '$.writes') IS NOT 'array'`, 0],
  ["review-import-group: test-deploys has an import v2 under an agent's v3", `SELECT COUNT(*) AS n FROM doc_versions WHERE org_id = ${M} AND slug = 'test-deploys' AND status = 'staged'`, 2],
  ["review-agent-group: the agent's staged versions", `SELECT COUNT(*) AS n FROM doc_versions WHERE org_id = ${M} AND status = 'staged' AND created_by = '${AGENT}'`, 7],
  ["triage-space: Unplaced doc proposals for a space", `SELECT COUNT(*) AS n FROM needs_triage WHERE org_id = ${M} AND resolved = 0`, 2],
  ["mcp-tokens: the two test tokens", `SELECT COUNT(*) AS n FROM mcp_tokens WHERE token_hash IN ('${sha256(TOKENS.member)}','${sha256(TOKENS.outsider)}')`, 2],
  ["other-org: same slug in another org", `SELECT COUNT(*) AS n FROM docs WHERE slug = 'test-getting-started' AND org_id IN (${M}, ${q(OTHER)})`, 2],
  ["memberships: test-dl-outsider only in test-docs-other", `SELECT COUNT(*) AS n FROM memberships WHERE user_id = '${OUTSIDER}'`, 1],
];

async function check(db) {
  const rows = await db.query(CHECKS.map(([, sql]) => sql));
  let bad = 0;
  console.log("\ndocs-library fixtures, read back:");
  CHECKS.forEach(([label, , want], i) => {
    const got = rows[i]?.[0]?.n;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok      " : "MISMATCH"}  ${label}: ${got}${ok ? "" : ` (want ${want})`}`);
  });
  if (bad) { console.error(`\n${bad} fixture check(s) failed.`); process.exitCode = 1; }
  else console.log(`\nAll ${CHECKS.length} checks hold. Open http://localhost:<port>/test-docs/#library — sign in via /auth/dev/as?handle=test-dl-admin`);
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (argv.includes("--files")) { writeFixtureFiles(); process.exit(0); }
  const db = localD1();
  if (!argv.includes("--check")) {
    writeFixtureFiles();
    const tables = orgTablesInOrder(db.query(ORG_TABLES_SQL)[0]);
    db.apply("docs-library: wipe the four test orgs", ORGS.flatMap((o) => orgWipeStatements(o, tables)));
    db.apply("docs-library: rows", docsLibraryStatements(new Date()));
  }
  await check({ query: async (sqls) => db.query(sqls) });
}
