#!/usr/bin/env node
// Local-only seed for the agent-links end-to-end test (docs/testing/agent-links-test-log.md; the feature is
// docs/architecture/handoffs-prompts.md › Agent links and ask.md › Agent links). Applied ON TOP of the dev seed
// (`node scripts/seed-dev.mjs`), to LOCAL D1 only: it refuses --remote, and its one wrangler path is `localD1`
// (`wrangler d1 execute DB --local`).
//
//   node scripts/seed/agent-links.mjs [--persist-to <dir>] [--list]
//
// IDEMPOTENT. It owns, in SaplingLearn (org_saplinglearn) only:
//   • agent links numbered 11 and up (row ids 6411–6430 for its own; any link numbered ≥ 11 that a test run made
//     is removed too, with its notes, so a rerun starts from the same live-link counts), and their notes
//     (ids 6400–6499, plus every note on a link numbered ≥ 11);
//   • Ask threads 6401–6409, their messages 64001–64099, cards 6401–6409 and shares by name.
// The team scenario's own links 1–3 (team-rich.mjs, ids 7001–7003) are left as they are. Every run deletes what it
// owns and writes it again, stamped against NOW (a draft lasts an hour: rerun before testing one).
//
// The people are the team scenario's (made-up `priya-n` / `omar-h` included); nothing here names a real address, key
// or service. The sessions are obviously fake (`e2e-…`), and an Ask side's session is `ask-thread-<id>`.
//
// What it gives AndresL230 (the main viewer) — exactly FIVE live links, the cap (#1, #12, #14, #15, #16), so Send on
// the draft #11 is refused until one ends:
//   #11 draft      Andres → Jose, PR #231, Andres's coding session bound            (Send / Cancel at once; the cap)
//   #12 requested  Andres → meilin, branch feat/rate-limit                          (Cancel request → confirmModal)
//   #13 requested  Jose → meilin, ticket #23                                        (meilin: Accept; Andres: outsider)
//   #14 open       priya-n → Andres, ticket #41; priya's web chat; Andres's side unbound (join hint), an agent note
//                  and a person note from priya
//   #15 open       Andres ↔ Andres (a self-link), PR #185: first session = Ask thread 6401, second unbound; a person
//                  note from the second side waiting for the thread (the thread-list mark)
//   #16 open       Andres → omar-h, branch feat/stream-export: Andres's side = Ask thread 6403, Omar's = his Ask
//                  thread 6402; two Ask notes from Omar waiting for 6403, one delivered from Andres's
//   #17 declined   Andres → Jose        #18 cancelled  Andres → sanaok        #19 expired  Jose → Andres
//   #20 open       sanaok → priya-n: sanaok's coding side has written its 20 notes (the per-side cap, as sanaok)
//   #21 open       meilin → Jose, ticket #23: meilin's side = Ask thread 6406 (Andres's, shared with her to
//                  continue); one note from Jose's agent waiting for HER side (her line, never Andres's)
// Ask threads (Andres's unless said): 6401 self-link side · 6402 Omar's · 6403 #16's side (+ a send_link_note card) ·
//   6404 a request_link card to meilin and one to himself (a self-link) · 6405 an answer citing [[link:1]] ·
//   6406 shared with meilin ("Can continue"), her turn proposing a request_link card to Jose · 6407 Auto on, a
//   join_link card for #14 WAITING (Confirm-only, even on Auto).
import { targetsRemote } from "./build.mjs";

if (targetsRemote(process.argv.slice(2))) {
  console.error("agent-links seed: refusing --remote. This seed only ever targets LOCAL D1.");
  process.exit(1);
}

const ORG = "org_saplinglearn";
const ME = "AndresL230", JOSE = "Jose-Gael-Cruz-Lopez", MEI = "meilin", SANA = "sanaok", PRIYA = "priya-n", OMAR = "omar-h";
const REPO = "SaplingLearn/sapling";
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const FIRST_NUMBER = 11;

const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
/** A row → INSERT. null → NULL, number → as is, an object/array → JSON text, anything else → quoted. */
export function insert(table, row) {
  const cols = Object.keys(row);
  const vals = cols.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    if (typeof v === "object") return q(JSON.stringify(v));
    return q(v);
  });
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${vals.join(", ")})`;
}

export function deleteStatements() {
  const O = q(ORG);
  return [
    `DELETE FROM agent_link_notes WHERE org_id = ${O} AND (id BETWEEN 6400 AND 6499 OR link_number >= ${FIRST_NUMBER})`,
    `DELETE FROM agent_links WHERE org_id = ${O} AND (id BETWEEN 6411 AND 6430 OR number >= ${FIRST_NUMBER})`,
    `DELETE FROM chat_actions WHERE org_id = ${O} AND (id BETWEEN 6401 AND 6409 OR thread_id BETWEEN 6401 AND 6409)`,
    `DELETE FROM chat_messages WHERE org_id = ${O} AND (id BETWEEN 64001 AND 64099 OR thread_id BETWEEN 6401 AND 6409)`,
    `DELETE FROM chat_thread_people WHERE org_id = ${O} AND thread_id BETWEEN 6401 AND 6409`,
    `DELETE FROM chat_threads WHERE org_id = ${O} AND id BETWEEN 6401 AND 6409`,
  ];
}

/** The fixtures, stamped against `now`. */
export function agentLinksStatements(now = new Date()) {
  const t = now.getTime();
  const ago = (ms) => new Date(t - ms).toISOString();
  const ahead = (ms) => new Date(t + ms).toISOString();
  const s = [];

  // ── links ──
  const link = (n, row) => insert("agent_links", {
    id: 6400 + n, org_id: ORG, number: n, repo: null,
    requester_kind: null, requester_agent_session: null, requester_branch: null,
    recipient_kind: null, recipient_agent_session: null, recipient_branch: null,
    sent_at: null, decided_at: null, closed_at: null, closed_by: null, close_reason: null,
    requester_seen_at: null, recipient_seen_at: null, ...row,
  });
  const opened = (createdAgo, decidedAgo) => ({ created_at: ago(createdAgo), sent_at: ago(createdAgo - MIN), decided_at: ago(decidedAgo), expires_at: new Date(t - decidedAgo + 7 * DAY).toISOString() });

  s.push(link(11, {
    state: "draft", repo: REPO, topic_kind: "pr", topic_ref: "231", reason: "My topic grid reads the mastery API you are reshaping in PR #231.",
    requester: ME, requester_kind: "code", requester_agent_session: "e2e-andres-draft", requester_branch: "feat/topic-grid", requester_seen_at: ago(10 * MIN),
    recipient: JOSE, created_at: ago(10 * MIN), expires_at: ahead(50 * MIN),
  }));
  s.push(link(12, {
    state: "requested", repo: REPO, topic_kind: "branch", topic_ref: "feat/rate-limit", reason: "The class-code lookup will sit behind your rate limit; worth a line while both land.",
    requester: ME, recipient: MEI, created_at: ago(2 * HOUR), sent_at: ago(2 * HOUR), expires_at: ahead(22 * HOUR),
  }));
  s.push(link(13, {
    state: "requested", topic_kind: "ticket", topic_ref: "23", reason: "Class-code collisions: my fix and your teacher view both touch the lookup.",
    requester: JOSE, recipient: MEI, created_at: ago(40 * MIN), sent_at: ago(40 * MIN), expires_at: ahead(23 * HOUR),
  }));
  s.push(link(14, {
    state: "open", topic_kind: "ticket", topic_ref: "41", reason: "Planning the study-screen copy in a web chat while you change the deck endpoints.",
    requester: PRIYA, requester_kind: "chat", requester_agent_session: "e2e-priya-chat", requester_seen_at: ago(30 * MIN),
    recipient: ME, ...opened(3 * HOUR, 2 * HOUR),
  }));
  s.push(link(15, {
    state: "open", repo: REPO, topic_kind: "pr", topic_ref: "185", reason: "My Ask thread follows PR #185 while my coding session finishes it.",
    requester: ME, requester_kind: "ask", requester_agent_session: "ask-thread-6401", requester_seen_at: ago(50 * MIN),
    recipient: ME, ...opened(HOUR, HOUR),
  }));
  s.push(link(16, {
    state: "open", repo: REPO, topic_kind: "branch", topic_ref: "feat/stream-export", reason: "Omar is testing the export job while I change its progress events.",
    requester: ME, requester_kind: "ask", requester_agent_session: "ask-thread-6403", requester_seen_at: ago(2 * HOUR),
    recipient: OMAR, recipient_kind: "ask", recipient_agent_session: "ask-thread-6402", recipient_seen_at: ago(20 * MIN),
    ...opened(5 * HOUR, 4 * HOUR),
  }));
  s.push(link(17, {
    state: "declined", topic_kind: "person", topic_ref: JOSE, reason: "Both of us were in the auth middleware.",
    requester: ME, recipient: JOSE, created_at: ago(DAY + 2 * HOUR), sent_at: ago(DAY + 2 * HOUR), decided_at: ago(DAY), closed_at: ago(DAY), expires_at: ago(2 * HOUR),
  }));
  s.push(link(18, {
    state: "cancelled", topic_kind: "person", topic_ref: SANA, reason: "Seed data for the gradebook export.",
    requester: ME, recipient: SANA, created_at: ago(2 * DAY + HOUR), sent_at: ago(2 * DAY + HOUR), closed_at: ago(2 * DAY), expires_at: ago(DAY + HOUR),
  }));
  s.push(link(19, {
    state: "expired", repo: REPO, topic_kind: "pr", topic_ref: "219", reason: "The streak counters moved; your cache reads them.",
    requester: JOSE, recipient: ME, created_at: ago(3 * DAY), sent_at: ago(3 * DAY), expires_at: ago(2 * DAY), closed_at: ago(2 * DAY),
  }));
  s.push(link(20, {
    state: "open", topic_kind: "person", topic_ref: PRIYA, reason: "The roster import screens and the CSV parser change together.",
    requester: SANA, requester_kind: "code", requester_agent_session: "e2e-sana-code", requester_branch: "fix/roster-csv", requester_seen_at: ago(10 * MIN),
    recipient: PRIYA, ...opened(6 * HOUR, 6 * HOUR),
  }));
  s.push(link(21, {
    state: "open", topic_kind: "ticket", topic_ref: "23", reason: "Mei follows the class-code fix from the shared Ask thread.",
    requester: MEI, requester_kind: "ask", requester_agent_session: "ask-thread-6406", requester_seen_at: ago(HOUR),
    recipient: JOSE, recipient_kind: "code", recipient_agent_session: "e2e-jose-code", recipient_branch: "fix/class-code-collisions", recipient_seen_at: ago(15 * MIN),
    ...opened(2 * HOUR, 90 * MIN),
  }));

  // ── notes ── [id, link, side, author, kind, session, body, minutes ago, delivered minutes ago | null]
  const notes = [
    [6401, 14, "requester", PRIYA, "agent", "e2e-priya-chat", "Renaming the deck screen's empty state copy; nothing in the endpoints changes on my side.", 100, null],
    [6402, 14, "requester", PRIYA, "person", null, "I'll be on the copy until Friday.", 60, null],
    [6403, 15, "recipient", ME, "person", null, "The coding session pushed the last fix for #185; CI is running.", 20, null],
    [6404, 16, "recipient", OMAR, "ask", "ask-thread-6402", "The export job passes on staging with 40k rows.", 90, null],
    [6405, 16, "recipient", OMAR, "ask", "ask-thread-6402", "Progress events arrive every 2 s; the last one is the 100% one.", 45, null],
    [6406, 16, "requester", ME, "ask", "ask-thread-6403", "Changing the progress event's shape to { done, total } tonight.", 200, 180],
    [6407, 21, "recipient", JOSE, "agent", "e2e-jose-code", "Merged the collision fix; the lookup now retries once on a duplicate code.", 30, null],
  ];
  for (let i = 0; i < 20; i++) notes.push([6420 + i, 20, "requester", SANA, "agent", "e2e-sana-code", `Roster CSV parser, change ${i + 1} of 20: trailing columns are dropped.`, 300 - i * 10, 200 - i * 10]);
  for (const [id, n, side, author, kind, session, body, m, d] of notes) {
    s.push(insert("agent_link_notes", { id, org_id: ORG, link_number: n, side, author, author_kind: kind, author_agent_session: session, body, created_at: ago(m * MIN), delivered_at: d === null ? null : ago(d * MIN) }));
  }
  s.push(`INSERT INTO org_counters (org_id, name, value) VALUES (${q(ORG)}, 'link', (SELECT COALESCE(MAX(number), 0) FROM agent_links WHERE org_id = ${q(ORG)})) ON CONFLICT(org_id, name) DO UPDATE SET value = MAX(org_counters.value, excluded.value)`);

  // ── Ask threads ──
  let msg = 64001;
  const thread = (id, handle, title, at, extra = {}) => s.push(insert("chat_threads", {
    id, org_id: ORG, handle, title, mode: "smart", origin: "page", context_ref: null, pinned: 0, auto_mode: 0, draft: "", summary: "", summary_through: 0,
    turn: 1, stop_requested: 0, created_at: at, updated_at: at, pending: 0, shared_at: null, ...extra,
  }));
  const question = (threadId, text, at, askedBy = null) => s.push(insert("chat_messages", {
    id: msg++, org_id: ORG, thread_id: threadId, role: "user", mode: "smart", content_json: { text, command: null, context: [], refs: [], attached: [] },
    cites_json: [], attachments_json: [], model: null, units: 0, created_at: at, asked_by: askedBy,
  }));
  /** An answer: its text, then cards ({ id, tool, args, preview, state }), with optional cites. */
  const answer = (threadId, turn, text, at, { cards = [], cites = [], refs = [], askedBy = null } = {}) => {
    const id = msg++;
    const parts = [{ kind: "text", md: text }, ...cards.map((c) => ({ kind: "action", id: c.id }))];
    s.push(insert("chat_messages", {
      id, org_id: ORG, thread_id: threadId, role: "assistant", mode: "smart",
      content_json: { text, refs, blocks: [], activity: [], followups: [], thinking: null, parts },
      cites_json: cites, attachments_json: [], model: "claude-sonnet-4-5", tokens_in: 1200, tokens_out: 180, tokens_cached: 0, units: 1, stopped: 0, created_at: at, asked_by: askedBy,
    }));
    for (const c of cards) {
      s.push(insert("chat_actions", {
        id: c.id, org_id: ORG, thread_id: threadId, message_id: id, turn, tool: c.tool, kind: "handoff", group_id: `${threadId}-${turn}-${c.id}`,
        tool_use_id: `toolu_e2e_links_${c.id}`, args_json: c.args, preview_json: c.preview, state: c.state ?? "proposed", result_json: null, undo_json: null,
        created_at: at, decided_at: null, asked_by: askedBy,
      }));
    }
  };
  const line = (label, value) => ({ label, value });
  const linkView = (n, title, extra) => ({ ref: `link:${n}`, type: "link", num: n, title, status: null, owner: extra.owner, updated: extra.updated, href: `#links/${n}`, extra: extra.extra });

  thread(6401, ME, "E2E: my two sessions on PR #185", ago(HOUR));
  question(6401, "Open a link with my coding session on PR #185.", ago(HOUR + MIN));
  answer(6401, 1, "Link #15 is open with this thread as one side. Your coding session joins the other side when you tell it to.", ago(HOUR));

  thread(6402, OMAR, "E2E: Omar's export check", ago(20 * MIN));
  question(6402, "Join link 16 from here.", ago(4 * HOUR));
  answer(6402, 1, "This thread is now Omar's side of link #16.", ago(4 * HOUR));

  thread(6403, ME, "E2E: export job with Omar", ago(2 * HOUR));
  question(6403, "Tell Omar's side the progress event changes tonight.", ago(2 * HOUR + MIN));
  answer(6403, 1, "Here is the note for link #16. It goes to Omar's side once you confirm it.", ago(2 * HOUR), {
    cards: [{ id: 6401, tool: "send_link_note", args: { id: 16, body: "The progress event's new shape ships tonight: { done, total }." },
      preview: { title: "Note on link #16", lines: [line("To", `@${OMAR}'s side`), line("Note", "The progress event's new shape ships tonight: { done, total }.")], item: null } }],
  });

  thread(6404, ME, "E2E: link me with Mei about the rate limit", ago(30 * MIN), { turn: 2 });
  question(6404, "Ask Mei for a link about the rate limit.", ago(35 * MIN));
  answer(6404, 1, "Here is the request. It is sent only when you confirm it.", ago(34 * MIN), {
    cards: [{ id: 6402, tool: "request_link", args: { target: { person: MEI }, reason: "The class-code lookup will sit behind the rate limit." },
      preview: { title: `Link request to @${MEI}`, lines: [line("With", `@${MEI}`), line("Reason", "The class-code lookup will sit behind the rate limit."),
        line("What it does", `Confirm sends it. @${MEI} accepts or declines it in Trov; once open, their agent's notes reach this thread.`)], item: null } }],
  });
  question(6404, "And open one with my own coding session.", ago(31 * MIN));
  answer(6404, 2, "Here is a link with your other session. It opens as soon as you confirm it.", ago(30 * MIN), {
    cards: [{ id: 6403, tool: "request_link", args: { target: { person: ME }, reason: "This thread follows my coding session on the topic grid." },
      preview: { title: "Open a link with your other session", lines: [line("With", "You (another session of yours)"), line("Reason", "This thread follows my coding session on the topic grid."),
        line("What it does", "Confirm opens it at once, with this thread as one side.")], item: null } }],
  });

  const l1 = linkView(1, `Link with @${JOSE} on PR #231`, { owner: JOSE, updated: ago(6 * HOUR), extra: { with: JOSE, self: false, topic: "PR #231", reason: "Both of us are changing the mastery query this week.", state: "open" } });
  thread(6405, ME, "E2E: what is link #1 about", ago(15 * MIN));
  question(6405, "What is my link with Jose about?", ago(16 * MIN));
  answer(6405, 1, "Your open link with Jose is [[link:1]]: both of you are changing the mastery query this week, and his agent said it is renaming `mastery_score` to `score`.", ago(15 * MIN), { cites: [l1], refs: ["link:1"] });

  thread(6406, ME, "E2E: shared with Mei, the class-code lookup", ago(25 * MIN), { turn: 2 });
  s.push(insert("chat_thread_people", { org_id: ORG, thread_id: 6406, handle: MEI, access: "continue", shared_at: ago(3 * HOUR) }));
  question(6406, "Where does the class-code collision fix stand?", ago(3 * HOUR), ME);
  answer(6406, 1, "Jose's fix is in testing; Omar verified the main path.", ago(3 * HOUR), { askedBy: ME });
  question(6406, "Ask Jose for a link so his agent tells me when the lookup changes.", ago(26 * MIN), MEI);
  answer(6406, 2, "Here is the request to Jose. It is sent only when you confirm it.", ago(25 * MIN), { askedBy: MEI,
    cards: [{ id: 6404, tool: "request_link", args: { target: { person: JOSE }, reason: "Tell me when the class-code lookup changes." },
      preview: { title: `Link request to @${JOSE}`, lines: [line("With", `@${JOSE}`), line("Reason", "Tell me when the class-code lookup changes."),
        line("What it does", `Confirm sends it. @${JOSE} accepts or declines it in Trov; once open, their agent's notes reach this thread.`)], item: null } }],
  });

  thread(6407, ME, "E2E: Auto thread joins link #14", ago(5 * MIN), { auto_mode: 1 });
  question(6407, "Join link 14 from this thread.", ago(6 * MIN));
  answer(6407, 1, "Joining link #14 waits for you, even on Auto.", ago(5 * MIN), {
    cards: [{ id: 6405, tool: "join_link", args: { id: 14 }, state: "waiting",
      preview: { title: "Join link #14 from this thread", lines: [line("With", `@${PRIYA}`), line("About", "ticket #41"),
        line("What it does", "Notes from the other side reach this thread at the start of your next question, and this thread can leave notes for their agent.")], item: null } }],
  });
  return s;
}

/** What should hold after a run: [what, sql, expected]. */
export const CHECKS = [
  ["links 11–21", `SELECT COUNT(*) AS n FROM agent_links WHERE org_id = '${ORG}' AND number BETWEEN 11 AND 21`, 11],
  ["Andres's live links (the cap)", `SELECT COUNT(*) AS n FROM agent_links WHERE org_id = '${ORG}' AND ((requester = '${ME}' AND state IN ('requested','open')) OR (recipient = '${ME}' AND state = 'open'))`, 5],
  ["sanaok's notes on #20", `SELECT COUNT(*) AS n FROM agent_link_notes WHERE org_id = '${ORG}' AND link_number = 20 AND side = 'requester'`, 20],
  ["Ask threads", `SELECT COUNT(*) AS n FROM chat_threads WHERE org_id = '${ORG}' AND id BETWEEN 6401 AND 6409`, 7],
  ["link cards", `SELECT COUNT(*) AS n FROM chat_actions WHERE org_id = '${ORG}' AND id BETWEEN 6401 AND 6409`, 5],
];

async function main() {
  const { localD1 } = await import("./local-d1.mjs");
  const argv = process.argv.slice(2);
  if (argv.includes("--list")) {
    console.log("agent-links seed: links #11–#21, Ask threads 6401–6407 in SaplingLearn (see this file's header).");
    return;
  }
  const i = argv.indexOf("--persist-to");
  const db = localD1({ persistTo: i >= 0 ? argv[i + 1] : null });
  const [tables] = db.query(["SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('agent_links', 'chat_thread_people')"]);
  if (tables.length < 2) {
    console.error("agent-links seed: this local D1 lacks agent_links or chat_thread_people — apply the migrations first (npx wrangler d1 migrations apply DB --local).");
    process.exit(1);
  }
  db.apply("agent links", [...deleteStatements(), ...agentLinksStatements()]);
  const results = db.query(CHECKS.map(([, sql]) => sql));
  let ok = true;
  CHECKS.forEach(([what, , want], k) => {
    const got = Number(results[k]?.[0]?.n ?? 0);
    if (got !== want) ok = false;
    console.log(`  ${got === want ? "ok " : "BAD"} ${what}: ${got}${got === want ? "" : ` (want ${want})`}`);
  });
  if (!ok) process.exit(1);
  console.log("agent-links seed: done. Sign in: /auth/dev/as?handle=AndresL230 (or meilin, sanaok, …), then #links.");
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
