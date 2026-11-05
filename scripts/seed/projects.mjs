// The team scenario's Projects (0086_projects; docs/architecture/projects.md, local-dev.md): the prototype's five
// projects in SaplingLearn, with refs that really exist in the seed — the rich layer's sprints, tickets, docs and
// artifacts (team-rich.mjs / team-content.mjs) and the AI showcase's hosting sprint, tickets and Ask threads
// (ai-showcase.mjs), so it runs AFTER the showcase (scenarios.mjs `teamShowcase`). Idempotent: it deletes and rewrites
// only what it owns — projects 7901–7905 and their pins and members — and moves four of AndresL230's showcase threads
// into "Hosting providers".
//
//   Hosting providers        server  #525cc3  members  AndresL230 (owner), Jose (editor), Jack (viewer)
//   Teacher dashboard pilot  chart   #a84a68  org      meilin (owner), AndresL230 and Luke (editors)
//   Gradebook export rework  book    #2f7d57  members  Jose (owner), AndresL230 (editor), Jack (viewer)
//   Exam week incident       shield  #b4562c  private  AndresL230
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

export const HOSTING_INSTRUCTIONS = "Hosting is mostly built. Focus on what blocks the Hosting sprint.\nPrefer Deploys and environments over old chats.\nFile new tickets in the Hosting sprint and assign them to @Jose-Gael-Cruz-Lopez unless I say otherwise.";

export function projectStatements(now = new Date()) {
  const c = makeClock(now);
  const s = [
    `UPDATE chat_threads SET project_id = NULL WHERE org_id = ${O} AND ${BLOCK("project_id")}`,
    `UPDATE artifact_pages SET project_id = NULL WHERE org_id = ${O} AND ${BLOCK("project_id")}`,
    `DELETE FROM project_pins WHERE org_id = ${O} AND ${BLOCK("project_id")}`,
    `DELETE FROM project_members WHERE org_id = ${O} AND ${BLOCK("project_id")}`,
    `DELETE FROM projects WHERE org_id = ${O} AND ${BLOCK("id")}`,
  ];
  const project = (id, row) => s.push(insert("projects", { id, org_id: ORG, description: "", instructions: "", archived_at: null, archived_by: null, deleted_at: null, ...row }));
  const member = (id, handle, role, by, days) => s.push(insert("project_members", { org_id: ORG, project_id: id, handle, role, added_by: by, added_at: c.days(days) }));
  let pinId = 7900;
  const pin = (id, ref, by, days) => s.push(insert("project_pins", { id: ++pinId, org_id: ORG, project_id: id, ref, added_by: by, added_at: c.days(days) }));

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

  // ── Exam week incident (private) ──
  const E = PROJECT_IDS.exam;
  project(E, { slug: "exam-week-incident", name: "Exam week incident", description: "My notes on the pool exhaustion, before the write-up.",
    icon: "shield", color: "#b4562c", visibility: "private", owner: ME, created_at: c.days(16), updated_at: c.days(6) });
  pin(E, "doc:sapling-incident-exam-week", ME, 16);
  pin(E, "artifact:exam-week-pool-timeline", ME, 15);

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
  ["Projects › Hosting providers' pins", `SELECT COUNT(*) AS n FROM project_pins WHERE org_id = ${O} AND project_id = ${PROJECT_IDS.hosting}`, 13],
  ["Projects › threads in Hosting providers", `SELECT COUNT(*) AS n FROM chat_threads WHERE org_id = ${O} AND project_id = ${PROJECT_IDS.hosting}`, 4],
];
