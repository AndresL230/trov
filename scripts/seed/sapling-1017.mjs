// The 10-17 staging epic in ONE account: SaplingLearn, signed in as AndresL230 (its owner). Where the feature seeds
// (docs-library.mjs, ask-sharing.mjs) write test- orgs and test- people for the browser tests, this writes what the
// epic looks like for a real team, in the dev seed's own org — so one sign-in shows all of it:
//
//   1. the dev seed's `team` scenario (`scripts/seed-dev.mjs --scenario team`): SaplingLearn rewritten whole
//   2. the agent links (`scripts/seed/agent-links.mjs`): Relay › Links, five live links of Andres's, Ask threads
//      6401–6407 (6406 shared with meilin)
//   3. THIS layer, below: the Docs Library and Ask conversations teammates shared with Andres
//
// THE LIBRARY (0076_10_17_staging › 0081–0084). Seven live spaces, so the sidebar shows the first five A to Z (Design,
// Engineering, Onboarding, Product, Research) and Security and Support are in the Library only — Customize sidebar
// picks; one archived space (Old wiki). The team's pages are filed into a tree (its 12 "technical" pages, a space no
// row names, go to Engineering), and new pages fill the rest:
//   Engineering   Architecture › Infrastructure › Deploys and environments › Rollbacks › Database rollback checklist
//                 (5 levels, the most); Decision records › the five ADRs; Incidents › the exam-week incident
//   Product       Product specs › Teacher dashboard, Offline study mode; an ARCHIVED page (Grading rubric, 2025)
//   Design        the brand guide › Color and type; Component library
//   Onboarding    three pages from a finished import (onboarding-handbook.zip)
//   Research      Teacher interviews (live) + a PARTIAL import (research-notes.zip) whose pages wait in Review
//   Security      Threat model (v2 live, an agent's v3 waiting: "Change pending review"), access reviews, reporting
//   Support       the support playbook › refunds, teacher escalations
// with page history (several versions), tags, [[links]] and their backlinks (doc_links), and space owners. Andres's
// own sidebar is the default (no library_prefs row): Customize it, pin or hide cards on Library home.
//
// ASK SHARING (0076_ask_sharing, 0077_ask_people_sharing): meilin's thread shared with Andres to continue, Darkest-
// Teddy's shared with him to read, Jose's shared with the whole org, and one of Andres's shared with the org.
//
// LOCAL D1 ONLY: it refuses --remote, and every step it runs refuses it too. Idempotent (step 1 rewrites SaplingLearn,
// so every run starts from the same rows). Ids it owns: threads 6601–6609, their messages 66001–66099, imports
// 6601–6609. Run it in the folder whose `wrangler dev` you browse; the server may stay up.
//
// usage: node scripts/seed/sapling-1017.mjs [--server http://localhost:8787]   # every step, then the checks
//        node scripts/seed/sapling-1017.mjs --layer                             # only step 3 (on a seeded D1)
//        node scripts/seed/sapling-1017.mjs --check                             # only the checks
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { targetsRemote } from "./build.mjs";
import { insert, makeClock } from "./team-rich.mjs";

const argv = process.argv.slice(2);
if (targetsRemote(argv)) {
  console.error("sapling-1017 seed: refusing --remote. This seed only ever targets LOCAL D1.");
  process.exit(1);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const ENV = { ...process.env, npm_config_loglevel: "error" };
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };

const ORG = "org_saplinglearn";
const ME = "AndresL230", JOSE = "Jose-Gael-Cruz-Lopez", TEDDY = "Darkest-Teddy", LUKE = "lpcooper-arch", MEI = "meilin", SANA = "sanaok";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const IMP = { onboarding: 6601, research: 6602 };

// ── the Library ──────────────────────────────────────────────────────────────────────────────────────────────────
/** A page: its docs row and its versions. versions: [version, status, by, daysAgo, summary, body, extra?]. */
function page(s, c, d) {
  const promoted = d.versions.filter((v) => v[1] === "promoted").at(-1) ?? null;
  s.push(insert("docs", {
    org_id: ORG, slug: d.slug, section: d.section ?? "reference", space: d.space, title: d.title,
    body: promoted ? promoted[5] : "", current_version: promoted ? promoted[0] : 0,
    updated_at: c.days(promoted ? promoted[3] : d.versions[0][3]), updated_by: promoted ? promoted[2] : d.versions[0][2],
    owner: d.owner ?? d.versions[0][2], parent_slug: d.parent ?? null, tree_rank: d.rank ?? null,
    archived_at: d.archived ? c.days(d.archived.days) : null, archived_by: d.archived ? d.archived.by : null,
  }));
  for (const [version, status, by, days, summary, body, extra = {}] of d.versions) {
    s.push(insert("doc_versions", {
      org_id: ORG, slug: d.slug, version, body, summary, status, confidence: "high", created_at: c.days(days), created_by: by,
      content_hash: sha256(body), base_version: version > 1 ? version - 1 : null, change_kind: version === 1 ? "create" : "edit", low_confidence: 0,
      parent_slug: extra.parent_slug ?? null, import_id: extra.import_id ?? null, import_path: extra.import_path ?? null,
    }));
  }
}
/** A live page with one approved version. */
const live = (slug, title, space, parent, rank, by, days, body, o = {}) => ({
  slug, title, space, parent, rank, owner: o.owner ?? by, section: o.section,
  versions: [[1, "promoted", by, days, o.summary ?? "First version", body, o.extra ?? {}]],
});

/** Where the team scenario's pages go: [slug, space, parent, rank]. */
const FILED = [
  ["sapling-architecture", "engineering", null, 1024],
  ["sapling-infrastructure", "engineering", "sapling-architecture", 1024],
  ["sapling-deploys", "engineering", "sapling-infrastructure", 1024],
  ["sapling-caching", "engineering", "sapling-architecture", 2048],
  ["sapling-backend-ai", "engineering", "sapling-architecture", 3072],
  ["sapling-knowledge-graph", "engineering", "sapling-backend-ai", 1024],
  ["sapling-spaced-repetition", "engineering", "sapling-backend-ai", 2048],
  ["sapling-document-pipeline", "engineering", "sapling-architecture", 4096],
  ["sapling-engineering-style-guide", "engineering", null, 2048],
  ["sapling-adr-pydantic-ai", "engineering", "sl-decisions", 1024],
  ["sapling-adr-sse-protocol", "engineering", "sl-decisions", 2048],
  ["sapling-adr-drop-orchestrator", "engineering", "sl-decisions", 3072],
  ["sapling-adr-model-routing", "engineering", "sl-decisions", 4096],
  ["sapling-adr-durable-execution", "engineering", "sl-decisions", 5120],
  ["sapling-incident-exam-week", "engineering", "sl-incidents", 1024],
  ["sapling-gradebook-export", "engineering", null, 5120],
  ["sapling-overview", "product", null, 1024],
  ["sapling-roadmap", "product", null, 2048],
  ["sapling-teacher-dashboard", "product", "sl-specs", 1024],
  ["sapling-offline-mode", "product", "sl-specs", 2048],
  ["sapling-brand-style-guide", "design", null, 1024],
  ["sapling-support-playbook", "support", null, 1024],
];

export function libraryStatements(c) {
  const s = [];
  // A rerun of this layer alone (--layer) starts from the team scenario's Library: what this layer adds goes first.
  s.push(`DELETE FROM doc_links WHERE org_id = '${ORG}' AND (from_slug LIKE 'sl-%' OR to_slug LIKE 'sl-%')`);
  s.push(`DELETE FROM entry_tags WHERE org_id = '${ORG}' AND entry_type = 'doc' AND entry_id LIKE 'sl-%'`);
  s.push(`DELETE FROM doc_versions WHERE org_id = '${ORG}' AND slug LIKE 'sl-%'`);
  s.push(`DELETE FROM docs WHERE org_id = '${ORG}' AND slug LIKE 'sl-%'`);
  s.push(`DELETE FROM doc_imports WHERE org_id = '${ORG}' AND id BETWEEN 6601 AND 6609`);
  s.push(`DELETE FROM doc_space_owners WHERE org_id = '${ORG}'`);
  s.push(`DELETE FROM doc_spaces WHERE org_id = '${ORG}' AND slug NOT IN ('design', 'engineering', 'product')`);
  s.push(`DELETE FROM library_prefs WHERE org_id = '${ORG}' AND handle = '${ME}'`);

  // Spaces: the three starters get descriptions; four more live, one archived. The Library reads them A to Z.
  const desc = (slug, d) => s.push(`UPDATE doc_spaces SET description = ${lit(d)} WHERE org_id = '${ORG}' AND slug = '${slug}'`);
  desc("design", "The brand, the components and how we review design work.");
  desc("engineering", "How Sapling is built, deployed and kept up. Start with Architecture.");
  desc("product", "What we're building for students and teachers, and why.");
  const sp = (slug, name, icon, color, rank, description, by, days, archived = null) => s.push(insert("doc_spaces", {
    org_id: ORG, slug, name, icon, color, description, sort_rank: rank, archived_at: archived ? c.days(archived) : null,
    archived_by: archived ? ME : null, created_at: c.days(days), created_by: by,
  }));
  sp("onboarding", "Onboarding", "users", "#966800", 4096, "Your first week at Sapling: accounts, setup and who to ask.", ME, 30);
  sp("research", "Research", "flask", "#7a4f8f", 5120, "Interviews, surveys and what we learned from teachers and students.", MEI, 28);
  sp("security", "Security", "shield", "#b4562c", 6144, "Threat model, access reviews and how to report a problem.", LUKE, 26);
  sp("support", "Support", "megaphone", "#2467af", 7168, "How we answer teachers, students and schools.", SANA, 24);
  sp("old-wiki", "Old wiki", "book", "#607a29", 8192, "The Notion wiki before the Library. Kept for its links.", ME, 60, 6);
  const own = (space, handle) => s.push(insert("doc_space_owners", { org_id: ORG, space_slug: space, handle, added_at: c.days(20), added_by: ME }));
  own("design", MEI); own("engineering", JOSE); own("engineering", TEDDY); own("onboarding", ME); own("product", ME); own("product", MEI);
  own("research", MEI); own("security", LUKE); own("support", SANA);

  // The team's pages, filed (their versions stay as the team scenario wrote them).
  for (const [slug, space, parent, rank] of FILED) {
    s.push(`UPDATE docs SET space = '${space}', parent_slug = ${lit(parent)}, tree_rank = ${rank} WHERE org_id = '${ORG}' AND slug = '${slug}'`);
  }

  const E = "engineering", P = "product", D = "design", O = "onboarding", R = "research", S = "security", SU = "support";
  const pages = [
    // Engineering: the 5-level chain under Deploys and environments, and two grouping pages.
    live("sl-rollbacks", "Rollbacks", E, "sapling-deploys", 1024, TEDDY, 9,
      "# Rollbacks\n\nWhen a deploy goes wrong, roll back first and debug second.\n\n## The web app\n\nRedeploy the previous build from Vercel's deployments list. It takes about a minute.\n\n## The API\n\nRailway keeps the last ten images. Promote the one before the bad deploy, then check `/health`.\n\n## The database\n\nNever roll a migration back by hand. Follow the [[sl-db-rollback]], and read [[sapling-deploys]] for how environments are wired.\n"),
    { slug: "sl-db-rollback", title: "Database rollback checklist", space: E, parent: "sl-rollbacks", rank: 1024, owner: TEDDY,
      versions: [
        [1, "promoted", TEDDY, 12, "First version", "# Database rollback checklist\n\n1. Stop the workers.\n2. Restore the snapshot.\n3. Start the workers.\n"],
        [2, "promoted", JOSE, 5, "Added the read-only step and the exam-week lesson",
          "# Database rollback checklist\n\nThe steps we follow when a migration has to come back out. Two people, always: one runs it, one reads it aloud.\n\n## Before\n\n1. Put the API in read-only mode (`MAINTENANCE=read-only`).\n2. Stop the OCR and grading workers so nothing writes mid-restore.\n3. Take a fresh snapshot, even though you are about to restore an older one.\n\n## Restore\n\n1. Restore the last snapshot from before the migration.\n2. Run the migration's down script only if the snapshot is older than a day.\n3. Check row counts on `students`, `classes` and `submissions` against the dashboard.\n\n## After\n\n1. Start the workers, then leave read-only mode.\n2. Post in #incidents with what you restored and why.\n\n> In exam week the pool ran out mid-restore: see [[sapling-incident-exam-week]]. Raise the pool size first.\n"],
      ] },
    live("sl-decisions", "Decision records", E, null, 3072, JOSE, 40,
      "# Decision records\n\nEvery decision that is hard to undo gets a short record: the context, what we chose, and what we gave up. The records live under this page, newest last.\n"),
    live("sl-incidents", "Incidents", E, null, 4096, TEDDY, 35,
      "# Incidents\n\nOne page per incident: what happened, the timeline, and what we changed. Blameless, always.\n"),
    // Product: a grouping page, and an archived page.
    live("sl-specs", "Product specs", P, null, 3072, MEI, 25,
      "# Product specs\n\nOne page per feature we're building: the problem, who it's for, and how we'll know it worked.\n"),
    { slug: "sl-grading-rubric-2025", title: "Grading rubric (2025)", space: P, parent: "sl-specs", rank: 3072, owner: MEI, archived: { days: 3, by: MEI },
      versions: [[1, "promoted", MEI, 70, "First version", "# Grading rubric (2025)\n\nThe four-level rubric we used before the teacher dashboard. Replaced by the dashboard's mastery levels.\n"]] },
    // Design.
    live("sl-color-type", "Color and type", D, "sapling-brand-style-guide", 1024, MEI, 15,
      "# Color and type\n\nSapling green (`#2f7d57`) is for progress, never for errors. Body text is 15px Inter; headings are 600 weight.\n\nThe full voice and tone guide is the [[sapling-brand-style-guide]].\n"),
    live("sl-components", "Component library", D, null, 2048, MEI, 11,
      "# Component library\n\nButtons, cards, the streak badge and the quiz card. Every component has a light and a dark version, and a reduced-motion one.\n"),
    // Onboarding: a finished import.
    live("sl-first-week", "Your first week", O, null, 1024, ME, 4,
      "# Your first week\n\nWelcome to Sapling. By Friday you should have shipped one small change.\n\n## Day one\n\nGet your accounts: see [[sl-accounts]].\n\n## Day two\n\nSet up your machine with [[sl-local-setup]], then read the [[sapling-engineering-style-guide]].\n\n## The rest of the week\n\nPick a ticket labelled *good first issue* and pair with whoever owns it.\n",
      { summary: "Imported from onboarding/first-week.md", extra: { import_id: IMP.onboarding, import_path: "onboarding/first-week.md" } }),
    live("sl-accounts", "Accounts and access", O, "sl-first-week", 1024, ME, 4,
      "# Accounts and access\n\nYou need GitHub (the SaplingLearn org), Google Workspace, Vercel, Railway and Supabase. Ask Andres for the first two; the rest come from your team lead.\n",
      { summary: "Imported from onboarding/accounts.md", extra: { import_id: IMP.onboarding, import_path: "onboarding/accounts.md" } }),
    live("sl-local-setup", "Local setup", O, "sl-first-week", 2048, ME, 4,
      "# Local setup\n\nInstall Node 20, pnpm 9 and Python 3.12. Clone the repo, copy `.env.example` to `.env`, then run `pnpm dev`.\n",
      { summary: "Imported from onboarding/local-setup.md", extra: { import_id: IMP.onboarding, import_path: "onboarding/local-setup.md" } }),
    // Research: a live page with an import's new version waiting, and the import's new pages waiting.
    { slug: "sl-teacher-interviews", title: "Teacher interviews, fall 2026", space: R, parent: null, rank: 1024, owner: MEI,
      versions: [
        [1, "promoted", MEI, 18, "First version", "# Teacher interviews, fall 2026\n\nTwelve teachers across four schools. Notes per school below.\n"],
        [2, "staged", MEI, 0.4, "Imported from research/teacher-interviews.md",
          "# Teacher interviews, fall 2026\n\nTwelve teachers across four schools.\n\n## What we heard\n\n- Teachers open the class overview first, every morning.\n- Nobody uses the export; they screenshot the chart.\n- Streaks matter more to students than teachers expected.\n",
          { import_id: IMP.research, import_path: "research/teacher-interviews.md" }],
      ] },
    { slug: "sl-study-habits", title: "Study habits survey", space: R, parent: null, rank: 2048, owner: MEI,
      versions: [[1, "staged", MEI, 0.4, "Imported from research/study-habits.md",
        "# Study habits survey\n\n412 students answered. Most study between 9 and 11 pm, on their phones.\n",
        { import_id: IMP.research, import_path: "research/study-habits.md" }]] },
    { slug: "sl-exam-week-diary", title: "Exam week diary study", space: R, parent: "sl-study-habits", rank: 1024, owner: MEI,
      versions: [[1, "staged", MEI, 0.4, "Imported from research/exam-week-diary.md",
        "# Exam week diary study\n\nEight students kept a diary for a week. Every one of them crammed the night before.\n",
        { import_id: IMP.research, import_path: "research/exam-week-diary.md", parent_slug: "sl-study-habits" }]] },
    // Security: history, and an agent's change waiting.
    { slug: "sl-threat-model", title: "Threat model", space: S, parent: null, rank: 1024, owner: LUKE,
      versions: [
        [1, "promoted", LUKE, 45, "First version", "# Threat model\n\nWhat we protect: student work and grades.\n"],
        [2, "promoted", LUKE, 10, "Added the attackers and the uploads section",
          "# Threat model\n\nWhat we protect, from whom, and how.\n\n## What we protect\n\n- Student work, grades and messages.\n- Teachers' class rosters.\n\n## Who we protect it from\n\n- Someone outside a school guessing a class code.\n- A student trying to see another student's grades.\n\n## Uploads\n\nEvery upload is scanned and stored privately; links expire after an hour. Access is reviewed every quarter: see [[sl-access-reviews]]. Where it runs: [[sapling-infrastructure]].\n"],
        [3, "staged", TEDDY, 0.2, "Class codes: added rate limiting after the collision report",
          "# Threat model\n\nWhat we protect, from whom, and how.\n\n## What we protect\n\n- Student work, grades and messages.\n- Teachers' class rosters.\n\n## Who we protect it from\n\n- Someone outside a school guessing a class code. Joins are now limited to 10 a minute per address.\n- A student trying to see another student's grades.\n\n## Uploads\n\nEvery upload is scanned and stored privately; links expire after an hour. Access is reviewed every quarter: see [[sl-access-reviews]]. Where it runs: [[sapling-infrastructure]].\n"],
      ] },
    live("sl-access-reviews", "Quarterly access reviews", S, null, 2048, LUKE, 21,
      "# Quarterly access reviews\n\nEvery quarter, each tool's admin list is checked against the team. Anyone who left loses access the same day.\n"),
    live("sl-report-a-problem", "Reporting a security problem", S, null, 3072, LUKE, 30,
      "# Reporting a security problem\n\nEmail security@sapling.example or post in #security. Don't open a public issue.\n"),
    // Support.
    live("sl-refunds", "Refunds and billing questions", SU, "sapling-support-playbook", 1024, SANA, 8,
      "# Refunds and billing questions\n\nSchools pay by invoice; families pay by card. Refund within 30 days, no questions. Anything older goes to Andres.\n"),
    live("sl-teacher-escalations", "Escalating a teacher's report", SU, "sapling-support-playbook", 2048, SANA, 6,
      "# Escalating a teacher's report\n\nA wrong grade or a missing submission is urgent: file a ticket tagged *teachers* and page the on-call engineer.\n"),
    // The archived space keeps two pages, readable by link.
    live("sl-old-wiki-home", "Old wiki home", "old-wiki", null, 1024, ME, 90, "# Old wiki home\n\nEverything here moved to the Library.\n"),
    live("sl-old-wiki-deploys", "How we deployed (2025)", "old-wiki", "sl-old-wiki-home", 1024, ME, 90, "# How we deployed (2025)\n\nBy hand, from a laptop. Don't.\n"),
  ];
  for (const d of pages) page(s, c, d);

  // [[links]] in the live pages, and the team's own: what promote writes (doc_links), so backlinks show.
  const links = [
    ["sl-rollbacks", "sl-db-rollback"], ["sl-rollbacks", "sapling-deploys"], ["sl-db-rollback", "sapling-incident-exam-week"],
    ["sl-color-type", "sapling-brand-style-guide"], ["sl-first-week", "sl-accounts"], ["sl-first-week", "sl-local-setup"],
    ["sl-first-week", "sapling-engineering-style-guide"], ["sl-threat-model", "sl-access-reviews"], ["sl-threat-model", "sapling-infrastructure"],
  ];
  for (const [from_slug, to_slug] of links) s.push(insert("doc_links", { org_id: ORG, from_slug, to_slug }));

  // Tags (the org's own list): the doc page's side panel and the tag pages. A team page keeps its own tags too.
  const tags = [
    ["sl-threat-model", "auth"], ["sl-threat-model", "infra"], ["sapling-deploys", "infra"], ["sl-db-rollback", "data"],
    ["sl-db-rollback", "incident"], ["sl-db-rollback", "infra"], ["sl-rollbacks", "infra"], ["sapling-incident-exam-week", "incident"],
    ["sl-teacher-interviews", "teachers"], ["sapling-teacher-dashboard", "teachers"], ["sapling-teacher-dashboard", "ui"],
    ["sl-components", "ui"], ["sl-color-type", "ui"], ["sapling-architecture", "architecture"], ["sapling-backend-ai", "agents"],
  ];
  for (const [entry_id, tag] of tags) s.push(insert("entry_tags", { org_id: ORG, tag, entry_type: "doc", entry_id }, "INSERT OR IGNORE"));

  // Imports history: the onboarding handbook (done, approved since) and the research notes (partial, waiting in Review).
  const manifest = (size, count) => JSON.stringify({ file_size: size, file_count: count, files: [], choices: {}, writes: [], links: [], images: [] });
  const run = (id, status, by, days, file, space, counts, failures, size, count) => s.push(insert("doc_imports", {
    id, org_id: ORG, space_slug: space, parent_slug: null, file_name: file, started_by: by, started_at: c.days(days),
    updated_at: c.days(days - 0.001), ended_at: c.days(days - 0.002), status, counts: JSON.stringify(counts), failures: JSON.stringify(failures),
    total: counts.pages ?? 0, manifest: manifest(size, count), images: "[]",
  }));
  run(IMP.onboarding, "done", ME, 4.01, "onboarding-handbook.zip", O, { pages: 3, new_pages: 3, staged: 3, staged_new: 3 }, [], 48_000, 3);
  run(IMP.research, "partial", MEI, 0.41, "research-notes.zip", R,
    { pages: 4, new_pages: 2, versions: 1, skipped_files: 2, staged: 3, staged_new: 2, staged_versions: 1 },
    [{ path: "research/raw/interview-audio.m4a", code: "not_markdown" }, { path: "research/.DS_Store", code: "hidden" }], 2_600_000, 5);
  return s;
}

// ── Ask: conversations shared with Andres ────────────────────────────────────────────────────────────────────────
export function askStatements(c) {
  const s = [];
  const THREADS = "id BETWEEN 6601 AND 6609";
  s.push(`DELETE FROM chat_thread_people WHERE org_id = '${ORG}' AND thread_id BETWEEN 6601 AND 6609`);
  s.push(`DELETE FROM chat_messages WHERE org_id = '${ORG}' AND thread_id BETWEEN 6601 AND 6609`);
  s.push(`DELETE FROM chat_threads WHERE org_id = '${ORG}' AND ${THREADS}`);
  let msg = 66001;
  /** One thread: [asker, question, answer] turns; share: { org?: true, people?: [[handle, access]] }. */
  const thread = (id, owner, title, days, turns, share) => {
    s.push(insert("chat_threads", {
      id, org_id: ORG, handle: owner, title, mode: "smart", origin: "page", pinned: 0, auto_mode: 0, draft: "", turn: turns.length,
      shared_at: share.org ? c.days(days - 0.01) : null, created_at: c.days(days), updated_at: c.days(days - 0.02 * turns.length),
    }));
    turns.forEach(([asker, question, answer], i) => {
      const t = days - 0.02 * i;
      s.push(insert("chat_messages", { id: msg++, org_id: ORG, thread_id: id, role: "user", mode: "smart", asked_by: asker, created_at: c.days(t),
        content_json: JSON.stringify({ text: question, command: null, context: [], refs: [], attached: [] }), cites_json: "[]", attachments_json: "[]" }));
      s.push(insert("chat_messages", { id: msg++, org_id: ORG, thread_id: id, role: "assistant", mode: "smart", asked_by: asker, model: "claude-sonnet-5-5", units: 1, created_at: c.days(t - 0.005),
        content_json: JSON.stringify({ text: answer, refs: [], blocks: [], activity: [], followups: [], thinking: null, parts: [{ kind: "text", md: answer }] }), cites_json: "[]" }));
    });
    for (const [handle, access] of share.people ?? []) s.push(insert("chat_thread_people", { org_id: ORG, thread_id: id, handle, access, shared_at: c.days(days - 0.01) }));
  };
  thread(6601, MEI, "Which charts do teachers open first?", 1.2, [
    [MEI, "From the teacher interviews, which parts of the dashboard do teachers open first, and which do they ignore?",
      "Across the twelve interviews, the class overview is the first thing teachers open — usually every morning before class. The mastery chart comes second, mostly on Fridays. The export button was mentioned once, and only to say they screenshot the chart instead.\n\nSo the overview is the screen to make fast, and the export can wait."],
    [MEI, "Draft three changes to the overview based on that.",
      "1. **Lead with who needs help today**: the three students whose mastery dropped most this week, before the class average.\n2. **Show the streak column** — students care about it more than teachers expected, and teachers use it to start conversations.\n3. **Make the chart shareable as an image**, since that is what teachers already do with screenshots."],
  ], { people: [[ME, "continue"]] });
  thread(6602, TEDDY, "Rollback plan for the gradebook migration", 2.5, [
    [TEDDY, "If the gradebook export migration goes wrong on Thursday, what is the rollback plan?",
      "Follow the database rollback checklist: put the API in read-only mode, stop the OCR and grading workers, restore the snapshot from before the migration, check the row counts on students, classes and submissions, then bring the workers back and leave read-only mode.\n\nThe one change since exam week: raise the connection pool size before you start, because the restore ran out of connections last time."],
  ], { people: [[ME, "read"]] });
  thread(6603, JOSE, "Why the OCR queue backs up in exam week", 3.1, [
    [JOSE, "Why does the OCR queue back up every exam week?",
      "Uploads triple in the two days before an exam, almost all of them scanned PDFs, which take about four times longer than photos. The queue has two workers and no autoscaling, so the backlog grows faster than it drains.\n\nThe incident page from last term shows the same pattern, plus the database pool running out at the same time."],
  ], { org: true });
  thread(6604, ME, "Onboarding checklist for the two new engineers", 0.6, [
    [ME, "Two engineers start Monday. Turn our onboarding pages into a checklist for their first week.",
      "**Monday** — GitHub and Google Workspace accounts (Andres), then Vercel, Railway and Supabase (team lead).\n**Tuesday** — local setup: Node 20, pnpm 9, Python 3.12, then `pnpm dev`; read the engineering style guide.\n**Wednesday to Friday** — pick a *good first issue*, pair with its owner, and ship it by Friday."],
  ], { org: true });
  return s;
}

// ── running it ───────────────────────────────────────────────────────────────────────────────────────────────────
function d1File(statements, label) {
  const file = join(mkdtempSync(join(tmpdir(), "sapling-1017-")), "seed.sql");
  writeFileSync(file, statements.join(";\n") + ";\n");
  execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", `--file=${file}`], { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit"], env: ENV });
  console.log(`  ${label}: ${statements.length} statements`);
}
function d1Query(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", sql], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"], env: ENV }).toString();
  return JSON.parse(out)[0].results;
}

const O = `org_id = '${ORG}'`;
const CHECKS = [
  ["seven live spaces and one archived", `SELECT COUNT(*) AS n FROM doc_spaces WHERE ${O} AND archived_at IS NULL`, 7],
  ["Old wiki is archived", `SELECT COUNT(*) AS n FROM doc_spaces WHERE ${O} AND slug = 'old-wiki' AND archived_at IS NOT NULL`, 1],
  ["no page sits in a space no row names (the old 'technical')", `SELECT COUNT(*) AS n FROM docs d WHERE d.${O} AND NOT EXISTS (SELECT 1 FROM doc_spaces s WHERE s.org_id = d.org_id AND s.slug = d.space)`, 0],
  ["the deepest page is 5 levels down", `WITH RECURSIVE up(slug, parent, depth) AS (SELECT slug, parent_slug, 0 FROM docs WHERE ${O} AND slug = 'sl-db-rollback' UNION ALL SELECT d.slug, d.parent_slug, depth + 1 FROM docs d JOIN up ON d.slug = up.parent AND d.${O}) SELECT MAX(depth) + 1 AS n FROM up`, 5],
  ["the five ADRs are under Decision records", `SELECT COUNT(*) AS n FROM docs WHERE ${O} AND parent_slug = 'sl-decisions'`, 5],
  ["an archived page in Product", `SELECT COUNT(*) AS n FROM docs WHERE ${O} AND space = 'product' AND archived_at IS NOT NULL`, 1],
  ["changes waiting in Review (the agent's Threat model v3 + the research import's three)", `SELECT COUNT(*) AS n FROM doc_versions WHERE ${O} AND slug LIKE 'sl-%' AND status = 'staged'`, 4],
  ["two import runs (done, partial)", `SELECT COUNT(*) AS n FROM doc_imports WHERE ${O} AND id IN (6601, 6602)`, 2],
  ["backlinks: pages with links in", `SELECT COUNT(DISTINCT to_slug) AS n FROM doc_links WHERE ${O} AND (from_slug LIKE 'sl-%')`, 9],
  ["tagged pages (this layer's)", `SELECT COUNT(DISTINCT entry_id) AS n FROM entry_tags WHERE ${O} AND entry_type = 'doc' AND entry_id IN ('sl-threat-model', 'sapling-deploys', 'sl-db-rollback', 'sl-rollbacks', 'sapling-incident-exam-week', 'sl-teacher-interviews', 'sapling-teacher-dashboard', 'sl-components', 'sl-color-type', 'sapling-architecture', 'sapling-backend-ai')`, 11],
  ["Andres's sidebar is the default (no prefs row)", `SELECT COUNT(*) AS n FROM library_prefs WHERE ${O} AND handle = '${ME}'`, 0],
  ["threads shared with Andres by name (this layer)", `SELECT COUNT(*) AS n FROM chat_thread_people WHERE ${O} AND handle = '${ME}' AND thread_id BETWEEN 6601 AND 6609`, 2],
  ["threads shared with the org (this layer)", `SELECT COUNT(*) AS n FROM chat_threads WHERE ${O} AND id BETWEEN 6601 AND 6609 AND shared_at IS NOT NULL`, 2],
  ["agent links for Andres (the agent-links seed)", `SELECT COUNT(*) AS n FROM agent_links WHERE ${O} AND (requester = '${ME}' OR recipient = '${ME}')`, null],
];
function check() {
  let bad = 0;
  for (const [label, sql, want] of CHECKS) {
    const n = d1Query(sql)[0]?.n;
    const ok = want === null ? n > 0 : n === want;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${n}${ok || want === null ? "" : ` (want ${want})`}`);
  }
  return bad;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = makeClock();
  if (!argv.includes("--check")) {
    if (!argv.includes("--layer")) {
      const server = arg("--server", "http://localhost:8787");
      console.log("1. the dev seed's team scenario (SaplingLearn, rewritten whole)");
      execFileSync("node", [join(ROOT, "scripts", "seed-dev.mjs"), "--scenario", "team", "--server", server], { stdio: "inherit", env: ENV });
      console.log("2. the agent links");
      execFileSync("node", [join(HERE, "agent-links.mjs")], { stdio: "inherit", env: ENV });
    }
    console.log("3. the Library and the shared conversations");
    d1File(libraryStatements(c), "the Library");
    d1File(askStatements(c), "Ask sharing");
  }
  console.log("checks:");
  const bad = check();
  console.log(bad ? `\n${bad} check(s) failed.` : `\nAll ${CHECKS.length} checks hold. Sign in: http://localhost:8787/auth/dev/as?handle=${ME}&org=saplinglearn`);
  process.exit(bad ? 1 : 0);
}
