// The team scenario's Projects (0086_projects; docs/architecture/projects.md, local-dev.md): the prototype's five
// projects in SaplingLearn, with refs that really exist in the seed — the rich layer's sprints, tickets, docs and
// artifacts (team-rich.mjs / team-content.mjs) and the AI showcase's hosting sprint, tickets and Ask threads
// (ai-showcase.mjs), so it runs AFTER the showcase (scenarios.mjs `teamShowcase`). Idempotent: it deletes and rewrites
// only what it owns — projects 7901–7905 and their pins and members, Ask threads 7901–7904 (their messages and shares),
// artifact 7901 — and moves four of AndresL230's showcase threads into "Hosting providers".
//
//   Hosting providers        server  #525cc3  members  AndresL230 (owner), Jose (editor), Jack (viewer)
//                            + a Files pin: railway-build-log.png as the upload route leaves it (the org's, since the
//                              project is not private; the showcase's attached image, so only when the seed has it)
//   Teacher dashboard pilot  chart   #a84a68  org      meilin (owner), AndresL230 and Luke (editors)
//                            + meilin's thread, shared with the org and by name with her editors (Can continue), and
//                              AndresL230's own (private)
//   Gradebook export rework  book    #2f7d57  members  Jose (owner), AndresL230 (editor), Jack (viewer)
//                            + Jose's thread, shared with the org (Can read)
//   Exam week incident       shield  #b4562c  private  AndresL230
//                            + his own thread, never shared (a private project's threads are its owner's)
//   Streak features          rocket  #966800  members  AndresL230 (owner), Jose (viewer) — archived
//
// (The handle the prototype calls jack-he is the seed's Jack: `Darkest-Teddy`.)
import { ORG, insert, makeClock } from "./team-rich.mjs";
import { ME, JOSE, JACK, LUKE, MEI } from "./team-content.mjs";

export const PROJECT_IDS = { hosting: 7901, teacher: 7902, gradebook: 7903, exam: 7904, streak: 7905 };
/** The showcase threads of AndresL230's that are about hosting (ai-showcase.mjs `threadDefs`). */
export const HOSTING_THREADS = [9501, 9502, 9506, 9507];
const O = `'${ORG}'`;
const BLOCK = (col) => `${col} BETWEEN 7900 AND 7999`;
/** The Files pin's artifact (an upload into Hosting providers) and the showcase attachment whose bytes it is. */
const HOSTING_FILE = { id: 7901, slug: "railway-build-log-png-2", from: 9501 };
const SONNET = "claude-sonnet-5-5";

export const HOSTING_INSTRUCTIONS = "Hosting is mostly built. Focus on what blocks the Hosting sprint.\nPrefer Deploys and environments over old chats.\nFile new tickets in the Hosting sprint and assign them to @Jose-Gael-Cruz-Lopez unless I say otherwise.";

export function projectStatements(now = new Date()) {
  const c = makeClock(now);
  const s = [
    `UPDATE chat_threads SET project_id = NULL WHERE org_id = ${O} AND ${BLOCK("project_id")}`,
    `UPDATE artifact_pages SET project_id = NULL WHERE org_id = ${O} AND ${BLOCK("project_id")}`,
    `DELETE FROM chat_thread_people WHERE org_id = ${O} AND ${BLOCK("thread_id")}`,
    `DELETE FROM chat_messages WHERE org_id = ${O} AND ${BLOCK("thread_id")}`,
    `DELETE FROM chat_threads WHERE org_id = ${O} AND ${BLOCK("id")}`,
    `DELETE FROM artifact_versions WHERE org_id = ${O} AND page_id = ${HOSTING_FILE.id}`,
    `DELETE FROM artifact_pages WHERE org_id = ${O} AND id = ${HOSTING_FILE.id}`, // its trigger drops the search row
    `DELETE FROM project_pins WHERE org_id = ${O} AND ${BLOCK("project_id")}`,
    `DELETE FROM project_members WHERE org_id = ${O} AND ${BLOCK("project_id")}`,
    `DELETE FROM projects WHERE org_id = ${O} AND ${BLOCK("id")}`,
  ];
  const project = (id, row) => s.push(insert("projects", { id, org_id: ORG, description: "", instructions: "", archived_at: null, archived_by: null, deleted_at: null, ...row }));
  const member = (id, handle, role, by, days) => s.push(insert("project_members", { org_id: ORG, project_id: id, handle, role, added_by: by, added_at: c.days(days) }));
  let pinId = 7900;
  const pin = (id, ref, by, days) => s.push(insert("project_pins", { id: ++pinId, org_id: ORG, project_id: id, ref, added_by: by, added_at: c.days(days) }));
  // An Ask thread in a project, as the Ask route stores it: [days ago, question, answer] turns, no refs or cards.
  let msgId = 7900;
  const thread = (id, projectId, handle, title, turns, shared = {}) => {
    const last = turns.at(-1)[0];
    s.push(insert("chat_threads", { id, org_id: ORG, handle, title, mode: "smart", origin: "page", context_ref: null, pinned: 0, auto_mode: 0, draft: "", summary: "",
      summary_through: 0, turn: turns.length, stop_requested: 0, created_at: c.days(turns[0][0]), updated_at: c.days(last - 0.002), project_id: projectId,
      shared_at: shared.org ? c.days(last - 0.01) : null }));
    for (const [days, question, answer] of turns) {
      s.push(insert("chat_messages", { id: ++msgId, org_id: ORG, thread_id: id, role: "user", mode: "smart", content_json: { text: question, command: null, context: [], refs: [], attached: [] },
        cites_json: [], attachments_json: [], model: null, units: 0, created_at: c.days(days) }));
      s.push(insert("chat_messages", { id: ++msgId, org_id: ORG, thread_id: id, role: "assistant", mode: "smart",
        content_json: { text: answer, refs: [], blocks: [], activity: [], followups: [], thinking: null, parts: [{ kind: "text", md: answer }] },
        cites_json: [], attachments_json: [], model: SONNET, tokens_in: 2400 + answer.length, tokens_out: Math.ceil(answer.length / 4), tokens_cached: 0, units: 1, stopped: 0, created_at: c.days(days - 0.002) }));
    }
    for (const [who, access] of shared.people ?? []) s.push(insert("chat_thread_people", { org_id: ORG, thread_id: id, handle: who, access, shared_at: c.days(last - 0.01) }));
  };

  // ── Hosting providers ──
  const H = PROJECT_IDS.hosting;
  project(H, { slug: "hosting-providers", name: "Hosting providers", description: "Every host behind one interface, and what still blocks the rollout.",
    icon: "server", color: "#525cc3", visibility: "members", owner: ME, instructions: HOSTING_INSTRUCTIONS, created_at: c.days(9), updated_at: c.days(0.05) });
  member(H, JOSE, "editor", ME, 9);
  member(H, JACK, "viewer", ME, 8);
  pin(H, "sprint:9701", ME, 9); // the showcase's "Hosting providers rollout"
  pin(H, "repo:SaplingLearn/sapling", ME, 9);
  pin(H, "doc:sapling-deploys", ME, 8.5); // "Deploys and environments"
  for (const n of [38, 53, 72]) pin(H, `ticket:${n}`, ME, 8); // the rich layer's Railway tickets
  // The showcase's hosting tickets (Vercel, Render, Netlify, Fly.io, the Railway deploy): their numbers are the org's.
  s.push(`INSERT INTO project_pins (id, org_id, project_id, ref, added_by, added_at)
          SELECT 7920 + (id - 9800), org_id, ${H}, 'ticket:' || number, '${ME}', '${c.days(7)}' FROM tickets
           WHERE org_id = ${O} AND id BETWEEN 9801 AND 9807 AND sprint_id = 9701`);
  s.push(`UPDATE chat_threads SET project_id = ${H} WHERE org_id = ${O} AND handle = '${ME}' AND id IN (${HOSTING_THREADS.join(", ")})`);
  s.push(`UPDATE artifact_pages SET project_id = ${H} WHERE org_id = ${O} AND id = 9502`); // the answer saved from thread 9501
  // Files: railway-build-log.png uploaded into the project (src/tools/projects.ts `uploadIntoProject`): an artifact of
  // the uploader's through createPage — the ORG's, since the project is not private (a private one could not be pinned
  // here) — that is the project's and is pinned. Its bytes are the showcase's attached image: artifacts are stored by
  // content (`artifacts/<sha256>`), so the same file uploaded again is that R2 object; no image, no file.
  const F = HOSTING_FILE, at = c.days(0.09), summary = "Uploaded to Hosting providers";
  s.push(`INSERT INTO artifact_pages (id, org_id, slug, title, kind, area, repo, author_id, status, visibility, current_version, project_id, created_at, updated_at)
          SELECT ${F.id}, org_id, '${F.slug}', 'railway-build-log.png', 'image', 'data', '', '${ME}', 'draft', 'org', 1, ${H}, '${at}', '${at}' FROM artifact_versions
           WHERE org_id = ${O} AND page_id = ${F.from} AND version_no = 1`);
  s.push(`INSERT INTO artifact_versions (org_id, page_id, version_no, summary, content, r2_key, size_bytes, content_type, sha256, filename, created_by, created_at)
          SELECT org_id, ${F.id}, 1, '${summary}', NULL, r2_key, size_bytes, content_type, sha256, filename, '${ME}', '${at}' FROM artifact_versions
           WHERE org_id = ${O} AND page_id = ${F.from} AND version_no = 1`);
  s.push(`INSERT INTO artifacts_fts (page_id, title, description, body, org_id)
          SELECT '${F.id}', title, '${summary}', '', org_id FROM artifact_pages WHERE org_id = ${O} AND id = ${F.id}`);
  s.push(`INSERT INTO project_pins (id, org_id, project_id, ref, added_by, added_at)
          SELECT 7950, org_id, ${H}, 'artifact:' || slug, '${ME}', '${at}' FROM artifact_pages WHERE org_id = ${O} AND id = ${F.id}`);

  // ── Teacher dashboard pilot ──
  const T = PROJECT_IDS.teacher;
  project(T, { slug: "teacher-dashboard-pilot", name: "Teacher dashboard pilot", description: "The 12 pilot schools: what teachers say, and what we change for them.",
    icon: "chart", color: "#a84a68", visibility: "org", owner: MEI, instructions: "Quote teachers' own words when you can. Say which school a piece of feedback came from.",
    created_at: c.days(12), updated_at: c.days(1) });
  member(T, ME, "editor", MEI, 12);
  member(T, LUKE, "editor", MEI, 11);
  pin(T, "sprint:7003", MEI, 12);
  pin(T, "doc:sapling-teacher-dashboard", MEI, 12);
  pin(T, "artifact:teacher-dashboard-notes", MEI, 4);
  pin(T, "ticket:64", MEI, 3);
  s.push(`UPDATE artifact_pages SET project_id = ${T} WHERE org_id = ${O} AND slug = 'teacher-dashboard-notes'`);
  thread(7901, T, MEI, "What did teachers ask for most?", [[5, "What did the pilot teachers ask for most in the first two weeks?",
    "Three asks came up at most of the 12 schools:\n\n- **A class-wide view of where students are stuck.** Teachers want to see the topic the whole class is behind on, not one student at a time.\n- **A nudge for students who have gone quiet.** Several asked to be told when a student hasn't studied in a week.\n- **Exports that open in their gradebook.** The CSV export is the most-mentioned pain, mostly from the larger schools."],
    [4.98, "Which schools asked for the nudge?",
    "Northside Middle, Lakeview High and Cedar Park. Northside asked twice: one teacher wants it daily during exam season, weekly the rest of the term."]],
    { org: true, people: [[ME, "continue"], [LUKE, "continue"]] });
  thread(7902, T, ME, "Sort the pilot feedback by school", [[6, "Sort the pilot feedback by school, the schools with the most open items first.",
    "By school, the most open items first:\n\n- **Northside Middle** (4): the topic grid is slow for classes over 30, the quiet-student nudge, and two export problems.\n- **Lakeview High** (3): the nudge, and a way to hide archived classes.\n- **Cedar Park** (2): the nudge, and wording in the parent summary.\n\nThe other nine schools have one open item each, or none."]]);

  // ── Gradebook export rework ──
  const G = PROJECT_IDS.gradebook;
  project(G, { slug: "gradebook-export-rework", name: "Gradebook export rework", description: "Whole-school exports that finish, and CSVs that open in Excel.",
    icon: "book", color: "#2f7d57", visibility: "members", owner: JOSE, instructions: "The sprint is late. Lead with what is still open and who has it.",
    created_at: c.days(30), updated_at: c.days(2) });
  member(G, ME, "editor", JOSE, 30);
  member(G, JACK, "viewer", JOSE, 20);
  pin(G, "sprint:7002", JOSE, 30);
  pin(G, "doc:sapling-gradebook-export", JOSE, 29);
  pin(G, "artifact:export-job-sequence", JOSE, 12);
  pin(G, "ticket:38", JOSE, 10);
  s.push(`UPDATE artifact_pages SET project_id = ${G} WHERE org_id = ${O} AND slug = 'export-job-sequence'`);
  thread(7903, G, JOSE, "Why is the export empty for Northside?", [[13, "Why does the gradebook export come back empty for Northside?",
    "The job finishes but writes no rows. Northside's classes moved to the new term after the export was queued, and the job reads the class list it was queued with, so every class in it is the old term's and empty now.\n\nRe-running the export after the term change gives the full file. The fix is to read the class list when the job starts, not when it is queued."]],
    { org: true });

  // ── Exam week incident (private) ──
  const E = PROJECT_IDS.exam;
  project(E, { slug: "exam-week-incident", name: "Exam week incident", description: "My notes on the pool exhaustion, before the write-up.",
    icon: "shield", color: "#b4562c", visibility: "private", owner: ME, created_at: c.days(16), updated_at: c.days(6) });
  pin(E, "doc:sapling-incident-exam-week", ME, 16);
  pin(E, "artifact:exam-week-pool-timeline", ME, 15);
  thread(7904, E, ME, "Timeline of the pool incident", [[15.8, "Give me the timeline of the exam-week pool incident, minute by minute.",
    "Monday of exam week, in the team's time:\n\n- **09:02** Connections climb past 50 of the 60 Supabase allows.\n- **09:05** 60/60: the API returns 503s on the study and quiz routes.\n- **09:07** The alert fires; Jack picks it up.\n- **09:11** The transaction-pooler switch from `ops/pooler` goes to production.\n- **09:16** Connections drop to 22 and the errors stop.\n\n11 minutes of 503s, no data lost. The cause was the OCR workers opening a session per page: two of them held 30 idle connections each."]]);

  // ── Streak features (archived) ──
  const S = PROJECT_IDS.streak;
  project(S, { slug: "streak-features", name: "Streak features", description: "Streak freezes and the weekly goal. Shipped with spaced repetition v2.",
    icon: "rocket", color: "#966800", visibility: "members", owner: ME, created_at: c.days(50), updated_at: c.days(25), archived_at: c.days(25), archived_by: ME });
  member(S, JOSE, "viewer", ME, 50);
  pin(S, "sprint:7001", ME, 50);
  return s;
}

/** What the layer promises (the seed test checks them). */
export const PROJECT_CHECKS = [
  ["Projects › five, one archived", `SELECT COUNT(*) AS n FROM projects WHERE org_id = ${O} AND ${BLOCK("id")}`, 5],
  ["Projects › Hosting providers' pins (with its Files pin)", `SELECT COUNT(*) AS n FROM project_pins WHERE org_id = ${O} AND project_id = ${PROJECT_IDS.hosting}`, 14],
  ["Projects › Hosting providers' file, the org's", `SELECT COUNT(*) AS n FROM artifact_pages WHERE org_id = ${O} AND id = ${HOSTING_FILE.id} AND project_id = ${PROJECT_IDS.hosting} AND visibility = 'org'`, 1],
  ["Projects › threads in Hosting providers", `SELECT COUNT(*) AS n FROM chat_threads WHERE org_id = ${O} AND project_id = ${PROJECT_IDS.hosting}`, 4],
  ["Projects › threads in Teacher dashboard pilot", `SELECT COUNT(*) AS n FROM chat_threads WHERE org_id = ${O} AND project_id = ${PROJECT_IDS.teacher}`, 2],
  ["Projects › threads in Gradebook export rework", `SELECT COUNT(*) AS n FROM chat_threads WHERE org_id = ${O} AND project_id = ${PROJECT_IDS.gradebook}`, 1],
  ["Projects › threads in Exam week incident, its owner's", `SELECT COUNT(*) AS n FROM chat_threads WHERE org_id = ${O} AND project_id = ${PROJECT_IDS.exam} AND handle = '${ME}'`, 1],
  ["Projects › Exam week incident's threads shared with nobody", `SELECT COUNT(*) AS n FROM chat_threads t WHERE t.org_id = ${O} AND t.project_id = ${PROJECT_IDS.exam}
     AND (t.shared_at IS NOT NULL OR EXISTS (SELECT 1 FROM chat_thread_people p WHERE p.org_id = t.org_id AND p.thread_id = t.id))`, 0],
];
