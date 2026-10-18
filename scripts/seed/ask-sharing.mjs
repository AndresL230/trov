#!/usr/bin/env node
// The ASK SHARING seed: one named fixture per state of sharing an Ask conversation (0076_ask_sharing,
// 0077_ask_people_sharing; docs/architecture/ask.md › Sharing a conversation) — for the browser test in
// docs/testing/ask-sharing-test-log.md and for anyone trying the feature by hand. Local D1 only: it refuses --remote.
//
//   cd <the folder wrangler dev serves from> && node scripts/seed/ask-sharing.mjs [--print]
//   then sign in as anyone below:  npm run dev:as -- test-collab
//
// RUN IT AFTER `npm run seed` (it needs SaplingLearn, Northwind and Day One). IDEMPOTENT: every run first deletes what
// it owns — the `test-` people below with their memberships, every Ask row of a thread a `test-` person owns or one in
// its id block (97000–97999), every artifact a `test-` person authored, their "Wrong?" rows — then writes it again.
//
// THE PEOPLE (all `test-`, all @example.com):
//   test-owner          SaplingLearn member — owns every SaplingLearn fixture thread
//   test-collab         SaplingLearn member — named "Can continue" on several
//   test-reader         SaplingLearn member — named "Can read"
//   test-member         SaplingLearn member — named nowhere: sees what is shared with the org only
//   test-p01…test-p50   SaplingLearn members — the 50 people of `test-at-cap` (the most one thread may name)
//   test-outsider       Northwind member only — owns a Northwind thread shared with Northwind
//   test-removed-owner  a person whose SaplingLearn membership is gone — owns a thread still marked shared
//   test-empty          Day One member only — nothing anywhere
//
// THE FIXTURES (threads, by title):
//   test-private            test-owner's, shared with nobody
//   test-org-only           shared with SaplingLearn; the owner's file (private) and a proposed card
//   test-people-only        test-collab Can continue, test-reader Can read; the owner's turn, then test-collab's
//                           (with test-collab's own file and proposed card) — the last turn is test-collab's
//   test-both               SaplingLearn + test-reader read + test-collab continue; test-collab's turn, then the
//                           owner's (with a proposed card) — the last turn is the owner's
//   test-removed-owner      test-removed-owner's, shared with SaplingLearn and test-collab continue → nobody reaches it
//   test-unicode 🚀 …       a long unicode title and question, test-collab continue
//   test-<img …>            HTML in the title and the question (an onerror that would log XSS-FIRED), shared with the org
//   test-at-cap             named test-p01…test-p50, Can read (ASK_SHARE_PEOPLE_MAX)
//   test-other-org          Northwind, test-outsider's, shared with Northwind
import { createHash } from "node:crypto";
import { targetsRemote } from "./build.mjs";

const SL = "org_saplinglearn";
const NW = "org_dev_northwind";
const DAYONE = "org_dev_dayone";
const T0 = "2026-10-15T09:00:00.000Z";
const at = (min) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const sha = (s) => createHash("sha256").update(s).digest("hex");
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(typeof v === "object" ? JSON.stringify(v) : v).replace(/'/g, "''")}'`);
const insert = (table, row) => `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")})`;

export const PEOPLE = [
  ["test-owner", "Test Owner", SL], ["test-collab", "Test Collab", SL], ["test-reader", "Test Reader", SL], ["test-member", "Test Member", SL],
  ...Array.from({ length: 50 }, (_, i) => [`test-p${String(i + 1).padStart(2, "0")}`, `Test Person ${i + 1}`, SL]),
  ["test-outsider", "Test Outsider", NW], ["test-removed-owner", "Test Removed Owner", null], ["test-empty", "Test Empty", DAYONE],
];

const OWNED = `handle LIKE 'test-%'`;
const BLOCK = (col) => `${col} BETWEEN 97000 AND 97999`;
const THREADS = `(SELECT id FROM chat_threads WHERE ${OWNED} OR ${BLOCK("id")})`;
const PAGES = `(SELECT id FROM artifact_pages WHERE author_id LIKE 'test-%' OR ${BLOCK("id")})`;

/** Everything the seed owns, gone (children first). */
export function resetStatements() {
  return [
    `DELETE FROM chat_thread_people WHERE thread_id IN ${THREADS} OR handle LIKE 'test-%'`,
    `DELETE FROM chat_actions WHERE thread_id IN ${THREADS}`,
    `DELETE FROM chat_artifacts WHERE thread_id IN ${THREADS} OR artifact_id IN ${PAGES}`,
    `DELETE FROM chat_messages WHERE thread_id IN ${THREADS}`,
    `DELETE FROM chat_threads WHERE ${OWNED} OR ${BLOCK("id")}`,
    `DELETE FROM person_ask_settings WHERE ${OWNED}`,
    `DELETE FROM artifact_upload_tokens WHERE page_id IN ${PAGES}`,
    `DELETE FROM artifact_links WHERE page_id IN ${PAGES}`,
    `DELETE FROM artifacts_fts WHERE CAST(page_id AS INTEGER) IN ${PAGES}`,
    `DELETE FROM artifact_versions WHERE page_id IN ${PAGES}`,
    `DELETE FROM artifact_pages WHERE id IN ${PAGES}`,
    `DELETE FROM ai_feedback WHERE ${OWNED}`,
    `DELETE FROM sessions WHERE person LIKE 'test-%'`,
    `DELETE FROM memberships WHERE user_id LIKE 'test-%'`,
    `DELETE FROM persons WHERE handle LIKE 'test-%'`,
  ];
}

/** A private markdown attachment of `author` (stored inline, no R2), and its chip. */
function attachment(s, id, author, title, body, min) {
  s.push(insert("artifact_pages", { id, org_id: SL, slug: `test-att-${id}`, title, kind: "markdown", area: "data", repo: "", author_id: author, status: "draft", visibility: "private", current_version: 1, created_at: at(min), updated_at: at(min) }));
  s.push(insert("artifact_versions", { id, org_id: SL, page_id: id, version_no: 1, summary: "Attached in Ask", content: body, size_bytes: body.length, content_type: "text/markdown", sha256: sha(body), filename: title, created_by: author, created_at: at(min) }));
  return { id, slug: `test-att-${id}`, title, kind: "text", contentType: "text/markdown", size: body.length, sha256: sha(body) };
}

export function seedStatements() {
  const s = [];
  for (const [handle, name, org] of PEOPLE) {
    s.push(insert("persons", { handle, name, color: "stone", email: `${handle}@example.com`, created_at: T0, onboarded_at: T0 }));
    if (org) s.push(insert("memberships", { org_id: org, user_id: handle, role: "member", created_at: T0, created_by: "test-seed" }));
  }
  let msg = 97101, act = 97001, link = 97001;
  /** One thread with its turns: [asker, question, answer, { file?, card?: "proposed" | "expired" }]. */
  const thread = (id, org, owner, title, turns, share = {}) => {
    s.push(insert("chat_threads", {
      id, org_id: org, handle: owner, title, mode: "smart", origin: "page", pinned: 0, auto_mode: 0, draft: "", turn: turns.length,
      shared_at: share.org ? at(5) : null, created_at: at(0), updated_at: at(10 * turns.length),
    }));
    turns.forEach(([asker, question, answer, extra = {}], i) => {
      const qid = msg++, aid = msg++;
      const files = extra.file ? [extra.file] : [];
      s.push(insert("chat_messages", { id: qid, org_id: org, thread_id: id, role: "user", mode: "smart", asked_by: asker, created_at: at(10 * i + 1),
        content_json: { text: question, command: null, context: [], refs: [], attached: files.map((f) => ({ id: link, title: f.title })) }, cites_json: [], attachments_json: files.map((f) => ({ ...f, id: link })) }));
      for (const f of files) s.push(insert("chat_artifacts", { id: link++, org_id: org, thread_id: id, artifact_id: f.id, role: "attachment", message_id: qid, created_at: at(10 * i + 1) }));
      const card = extra.card ? act++ : null;
      s.push(insert("chat_messages", { id: aid, org_id: org, thread_id: id, role: "assistant", mode: "smart", asked_by: asker, model: "test-model", units: 1, created_at: at(10 * i + 2),
        content_json: { text: answer, refs: [], blocks: [], activity: [], followups: [], thinking: null, parts: [{ kind: "text", md: answer }, ...(card ? [{ kind: "action", id: card }] : [])] }, cites_json: [] }));
      if (card) {
        s.push(insert("chat_actions", { id: card, org_id: org, thread_id: id, message_id: aid, turn: i + 1, tool: "create_ticket", kind: "ticket", group_id: `${id}-${i + 1}-1`, tool_use_id: `test-${card}`,
          args_json: { title: `test-card ${card}` }, preview_json: { title: `Create ticket "test-card ${card}"`, lines: [], item: null }, state: extra.card, asked_by: asker, created_at: at(10 * i + 2) }));
      }
    });
    for (const [handle, access] of share.people ?? []) s.push(insert("chat_thread_people", { org_id: org, thread_id: id, handle, access, shared_at: at(6) }));
  };
  const ownerFile = attachment(s, 97001, "test-owner", "test-owner-notes.md", "# test-owner notes\n\nOnly the owner may read this.", 0);
  const collabFile = attachment(s, 97002, "test-collab", "test-collab-notes.md", "# test-collab notes\n\nOnly test-collab may read this.", 0);
  thread(97001, SL, "test-owner", "test-private", [["test-owner", "test-private question", "test-private answer"]]);
  thread(97002, SL, "test-owner", "test-org-only", [["test-owner", "test-org-only question", "test-org-only answer", { file: ownerFile, card: "proposed" }]], { org: true });
  thread(97003, SL, "test-owner", "test-people-only", [
    ["test-owner", "test-people-only owner question", "test-people-only owner answer", { card: "expired" }],
    ["test-collab", "test-people-only collab question", "test-people-only collab answer", { file: collabFile, card: "proposed" }],
  ], { people: [["test-collab", "continue"], ["test-reader", "read"]] });
  thread(97004, SL, "test-owner", "test-both", [
    ["test-collab", "test-both collab question", "test-both collab answer", { card: "expired" }],
    ["test-owner", "test-both owner question", "test-both owner answer", { card: "proposed" }],
  ], { org: true, people: [["test-reader", "read"], ["test-collab", "continue"]] });
  thread(97005, SL, "test-removed-owner", "test-removed-owner", [["test-removed-owner", "test-removed question", "test-removed answer"]], { org: true, people: [["test-collab", "continue"]] });
  thread(97006, SL, "test-owner", "test-unicode 🚀 Ünïcödé — a very long title that keeps going well past the width of any thread row", [
    ["test-owner", "test-unicode: 日本語のテキスト، النص العربي, emoji 👩‍💻🧪, and a very-long-unbroken-word-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "test-unicode answer ✅"],
  ], { people: [["test-collab", "continue"]] });
  thread(97007, SL, "test-owner", `test-<img src=x onerror="console.error('XSS-FIRED')">`, [
    ["test-owner", `test-html <img src=x onerror="console.error('XSS-FIRED-Q')"> <script>console.error('XSS-FIRED-S')</script> **not bold**`, "test-html answer"],
  ], { org: true });
  thread(97008, SL, "test-owner", "test-at-cap", [["test-owner", "test-at-cap question", "test-at-cap answer"]],
    { people: Array.from({ length: 50 }, (_, i) => [`test-p${String(i + 1).padStart(2, "0")}`, "read"]) });
  thread(97009, NW, "test-outsider", "test-other-org", [["test-outsider", "test-other-org question", "test-other-org answer"]], { org: true });
  return s;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const argv = process.argv.slice(2);
  if (targetsRemote(argv)) {
    console.error("ask-sharing: refusing --remote. This seed only ever targets LOCAL D1.");
    process.exit(1);
  }
  const statements = [...resetStatements(), ...seedStatements()];
  if (argv.includes("--print")) { console.log(statements.join(";\n") + ";"); process.exit(0); }
  const file = join(mkdtempSync(join(tmpdir(), "ask-sharing-")), "seed.sql");
  writeFileSync(file, statements.join(";\n") + ";\n");
  const ENV = { ...process.env, npm_config_loglevel: "error" };
  execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", `--file=${file}`], { stdio: ["ignore", "ignore", "inherit"], env: ENV });
  console.log(`ask-sharing: ${PEOPLE.length} people and 9 threads written to the local D1. Sign in: npm run dev:as -- test-collab`);
}
