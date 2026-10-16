// The CONTENT of the `team` scenario's rich layer (scripts/seed/team-rich.mjs): SaplingLearn — an ed-tech team
// building Sapling (a study app: an AI tutor over uploaded material, quizzes, spaced-repetition flashcards, streaks, a
// gradebook and, this quarter, a teacher dashboard) — as it looks on an ordinary Thursday. Pure data, no I/O: every
// time is RELATIVE ("days ago", negative = in the future), stamped against the clock when the seed runs, so the
// screens always read current. The rows are written by team-rich.mjs; this file only says what they are.
//
// People: the six of scripts/seed/reset.mjs (their handles, never logins) plus two made-up members this layer adds
// (`priya-n`, `omar-h`, example.com e-mail). Everything else here is invented and obviously so: no real secret, no
// real e-mail, no real customer.

export const ME = "AndresL230";
export const JOSE = "Jose-Gael-Cruz-Lopez";
export const LUKE = "lpcooper-arch";
export const JACK = "Darkest-Teddy";
export const MEI = "meilin";
export const SANA = "sanaok";
export const PRIYA = "priya-n";
export const OMAR = "omar-h";
export const REPO = "SaplingLearn/sapling";

/** The two members this layer adds (Google-only, like meilin and sanaok: no GitHub login to collide with an event). */
export const NEW_PEOPLE = [
  { handle: PRIYA, name: "Priya Natarajan", color: "clay", email: "priya@example.com", role: "Product designer", responsibilities: "Sapling's study and teacher screens: flows, the design system in Figma, usability sessions with pilot schools." },
  { handle: OMAR, name: "Omar Haddad", color: "slate", email: "omar@example.com", role: "QA engineer", responsibilities: "The e2e suite, release checks on staging, flaky-test triage, device testing (iOS Safari, low-end Android)." },
];

/** Roles this layer sets in the org (the canonical seed makes everyone but the owner a member). */
export const ROLES = { [JOSE]: "admin" };

/** A pending invitation (Org settings › Members), obviously fake. */
export const INVITES = [{ email: "new-hire@example.com", role: "member", invited_by: ME, days: 2, name: "Dana (data intern)" }];

/** Tags the team added to the six starters (Org settings › Tags). Ids are the layer's own. */
export const TAGS = [
  { id: 7001, name: "tutor", description: "The AI tutor, its retrieval and its answers", color: "sky", by: JOSE, days: 40 },
  { id: 7002, name: "teachers", description: "Anything a teacher sees: the dashboard, classes, the gradebook", color: "ochre", by: MEI, days: 38 },
  { id: 7003, name: "perf", description: "Latency, bundle size, cost per request", color: "rust", by: JACK, days: 33 },
  { id: 7004, name: "incident", description: "Something broke in production, and what we learned", color: "rose", by: JACK, days: 30 },
];

// ── sprints ───────────────────────────────────────────────────────────────────────────────────────────────────────
// start / due are DAYS FROM NOW (negative = past). Statuses are what a person set: one done, one current, one late
// (past its date and still in progress), one planned.
export const SPRINTS = [
  { key: "SR", id: 7001, title: "Spaced repetition v2", status: "done", start: -47, due: -26, urgency: "normal", lead: JOSE, domain: null,
    summary: "Cards come back when you are about to forget them.",
    description: "Move flashcard scheduling to SM-2 with a per-card ease factor, backfill existing decks, and let students cap new cards per day.",
    resources: [["https://www.figma.com/design/sapling-review-queue", "figma", "Review queue", "FIGMA · DESIGN"], ["https://github.com/SaplingLearn/sapling/pull/214", "github", "sapling #214", "GITHUB · PULL REQUEST"]] },
  { key: "GB", id: 7002, title: "Gradebook export rework", status: "in_progress", start: -33, due: -4, urgency: "high", lead: JOSE, domain: null,
    summary: "Whole-school exports that finish, and CSVs that open cleanly in Excel.",
    description: "Stream the gradebook CSV instead of building it in memory, run whole-school exports as a job with progress, and fix the export bugs teachers keep reporting.",
    resources: [["https://github.com/SaplingLearn/sapling/issues/231", "github", "sapling #231", "GITHUB · ISSUE"], ["https://docs.example.com/sapling/gradebook-export", "plain", "Export format notes", "DOCS.EXAMPLE.COM"]] },
  { key: "TD", id: 7003, title: "Teacher dashboard beta", status: "in_progress", start: -12, due: 9, urgency: "high", lead: LUKE, domain: null,
    summary: "Teachers at the 12 pilot schools see their class's mastery at a glance.",
    description: "A class overview with mastery per topic, students who have gone quiet, filters by topic and week, and the invite flow that gets teachers in with a class code.",
    resources: [["https://www.figma.com/design/sapling-teacher-dashboard", "figma", "Teacher dashboard", "FIGMA · DESIGN"], ["https://github.com/SaplingLearn/sapling/issues/240", "github", "sapling #240", "GITHUB · ISSUE"], ["https://docs.example.com/sapling/pilot-schools", "plain", "Pilot schools list", "DOCS.EXAMPLE.COM"]] },
  { key: "OF", id: 7004, title: "Offline study mode", status: "upcoming", start: 10, due: 41, urgency: "normal", lead: LUKE, domain: null,
    summary: "Review today's cards on the bus, sync when back online.",
    description: "Cache the day's review deck on the device, record results offline and sync them with clear conflict rules. iOS Safari first.",
    resources: [["https://www.figma.com/design/sapling-offline", "figma", "Offline states", "FIGMA · DESIGN"]] },
];

// ── tickets ───────────────────────────────────────────────────────────────────────────────────────────────────────
// [number, title, category, priority, requester, assignees, sprint key | null, moves, body, extra?]
// moves: [status, days ago, actor] — the first is the opening (submitted). extra: { parent, links, comments }.
// links: [url, kind, label, meta, days ago, by]; comments: [author, days ago, body].
const gh = (n, kind = "pull") => [`https://github.com/SaplingLearn/sapling/${kind}/${n}`, "github", `sapling #${n}`, kind === "pull" ? "GITHUB · PULL REQUEST" : "GITHUB · ISSUE"];
const fig = (slug, label) => [`https://www.figma.com/design/${slug}`, "figma", label, "FIGMA · DESIGN"];
const doc = (path, label) => [`https://docs.example.com/sapling/${path}`, "plain", label, "DOCS.EXAMPLE.COM"];
const L = (link, days, by) => [...link, days, by];

export const TICKETS = [
  // Spaced repetition v2 (done)
  [8, "Spaced repetition: schedule cards with SM-2 and a per-card ease", "request", "high", MEI, [JOSE], "SR",
    [["submitted", 50, MEI], ["in_progress", 46, JOSE], ["testing", 34, JOSE], ["done", 31, MEI]],
    "Students tell us the review queue feels random. Schedule each card with SM-2: an ease factor per card, the interval grown by it on a good answer and reset on a miss.\n\n- Grades 1–4 from the review screen\n- Ease starts at 2.5, never below 1.3\n- The queue is ordered by due date",
    { links: [L(gh(214), 31, JOSE), L(doc("spaced-repetition", "SM-2 notes"), 46, JOSE)],
      comments: [[JOSE, 45, "Going with plain SM-2 first; FSRS later if the retention curve says it's worth it."], [MEI, 33, "Tried it on my own deck for a week. The \"Again\" cards come back the same day, which is what I wanted."], [JOSE, 31, "Shipped in #214. Backfill for existing decks is #11."]] }],
  [9, "Review queue: show cards due today first, then overdue ones", "request", "normal", MEI, [LUKE], "SR",
    [["submitted", 49, MEI], ["in_progress", 41, LUKE], ["done", 36, LUKE]],
    "Overdue cards pile up after a weekend away and bury today's. Show today's first, then overdue, oldest first.",
    { parent: 8, links: [L(gh(217), 36, LUKE)] }],
  [10, "Flashcard flip animation stutters on low-end Android", "bug", "normal", SANA, [LUKE], "SR",
    [["submitted", 48, SANA], ["in_progress", 40, LUKE], ["done", 38, LUKE]],
    "Reported by three students on a Moto E. The card flip drops to a few frames a second.",
    { comments: [[LUKE, 39, "It was animating `box-shadow`. Switched to a transform on a pre-rendered shadow layer; 60 fps on the Moto E in BrowserStack."]] }],
  [11, "Backfill ease factors for existing decks", "request", "normal", JOSE, [JOSE], "SR",
    [["submitted", 44, JOSE], ["in_progress", 34, JOSE], ["done", 30, JOSE]],
    "Existing cards have no ease. Seed it from each card's review history so long-time users don't start over.",
    { parent: 8, links: [L(gh(219), 30, JOSE)] }],
  [12, "Card review endpoint returns 500 when a deck is empty", "bug", "high", SANA, [JOSE], "SR",
    [["submitted", 43, SANA], ["in_progress", 43, JOSE], ["done", 42, JOSE]],
    "`POST /api/review/next` 500s for a deck with no cards. Sentry: `IndexError: list index out of range` in `scheduler.next_card`.",
    { links: [L(gh(215), 42, JOSE)], comments: [[JOSE, 42, "Returns 204 now, and the screen shows the empty state. Added a test."]] }],
  [13, "Daily review reminder e-mail", "request", "low", MEI, [ME], "SR",
    [["submitted", 47, MEI], ["declined", 35, MEI]],
    "A morning e-mail with how many cards are due today.",
    { comments: [[MEI, 35, "Parking this: push notifications cover it on mobile, and the notifications rework next quarter will handle e-mail properly."]] }],
  [14, "Spaced repetition settings: cap new cards per day", "request", "normal", MEI, [LUKE], "SR",
    [["submitted", 46, MEI], ["in_progress", 37, LUKE], ["done", 33, LUKE]],
    "Default 20 new cards a day, adjustable from 5 to 100 in study settings.",
    { parent: 8, links: [L(gh(221), 33, LUKE), L(fig("sapling-review-queue", "Review settings"), 40, PRIYA)] }],
  [15, "Analytics: retention curve per deck", "request", "normal", MEI, [JOSE], "SR",
    [["submitted", 45, MEI], ["in_progress", 33, JOSE], ["done", 28, JOSE]],
    "A chart of the share of cards remembered after 1, 3, 7 and 30 days, per deck. We need it to judge SM-2 against the old scheduler.",
    { comments: [[JOSE, 28, "Day-7 retention went from 61% to 74% on decks older than a month. Numbers are in the feed entry."]] }],
  [16, "Keyboard shortcuts in review (1–4 to grade, space to flip)", "request", "low", PRIYA, [LUKE], "SR",
    [["submitted", 44, PRIYA], ["in_progress", 39, LUKE], ["done", 37, LUKE]],
    "Power users asked for it in the pilot survey. Show the shortcut hints on hover."],
  [17, "Load-test the review endpoint at 200 requests a second", "request", "normal", JACK, [JACK], "SR",
    [["submitted", 42, JACK], ["in_progress", 36, JACK], ["done", 32, JACK]],
    "Before exam season. k6 against staging, 10 minutes at 200 rps.",
    { comments: [[JACK, 32, "p95 140 ms at 200 rps, no errors. The Supabase pool peaked at 41 of 60 connections, which is closer than I'd like — see #63."]] }],

  // Gradebook export rework (late)
  [32, "Gradebook export rework: stream the CSV instead of building it in memory", "request", "high", MEI, [JOSE], "GB",
    [["submitted", 35, MEI], ["in_progress", 31, JOSE]],
    "Whole-school exports build the entire CSV in memory and die at Railway's 512 MB. Stream rows as they are read.\n\nFollows the old report in #1.",
    { links: [L(gh(231, "issues"), 35, MEI), L(doc("gradebook-export", "Export format notes"), 30, JOSE)],
      comments: [[JOSE, 30, "Streaming works for one class. A whole school still trips the 30 s request limit, so the big exports have to become a job (#33)."], [MEI, 6, "Northside needs term grades by Friday. Can we ship streaming for single classes now and the job after?"], [JOSE, 5, "Yes — single-class streaming is on staging, merging today."]] }],
  [33, "Export job queue with progress for whole-school exports", "request", "high", MEI, [JOSE], "GB",
    [["submitted", 31, JOSE], ["in_progress", 12, JOSE]],
    "Kick off the export, show progress, e-mail a download link when it's done. Links expire after 7 days.",
    { parent: 32, links: [L(gh(258), 3, JOSE)], comments: [[JOSE, 3, "PR is up. The worker writes chunks to R2 and stitches them; 40k rows in 18 s locally."]] }],
  [34, "Gradebook: weighted categories round to 2 decimals too early", "bug", "high", SANA, [JOSE], "GB",
    [["submitted", 29, SANA], ["in_progress", 27, JOSE], ["done", 24, JOSE]],
    "A teacher at Lakeview found a student at 89.99 who should be 90.00. We round each category before weighting.",
    { links: [L(gh(236), 24, JOSE)], comments: [[SANA, 24, "Confirmed with the teacher, the grade is right now. Thanks!"]] }],
  [35, "Excel opens exported CSVs with garbled accents", "bug", "normal", SANA, [LUKE], "GB",
    [["submitted", 27, SANA], ["in_progress", 22, LUKE], ["done", 20, LUKE]],
    "Names like \"José\" come out as \"JosÃ©\" in Excel on Windows.",
    { comments: [[LUKE, 20, "Added a UTF-8 BOM. Google Sheets and Numbers ignore it, Excel needs it."]] }],
  [36, "Export: add a late-submission column", "request", "low", SANA, [], "GB",
    [["submitted", 20, SANA]],
    "Two schools asked for it. A yes/no column per assignment."],
  [37, "Google Classroom grade sync (read-only)", "request", "normal", MEI, [], "GB",
    [["submitted", 18, MEI]],
    "Pull assignments and grades from Google Classroom so teachers don't enter them twice. Read-only to start.",
    { comments: [[JOSE, 9, "This won't fit in the sprint. Suggest moving it to next quarter once the export job is done."]] }],
  [38, "Gradebook export hits Railway's 30 s request timeout", "bug", "high", JACK, [JACK], "GB",
    [["submitted", 26, JACK], ["in_progress", 26, JACK], ["done", 25, JACK]],
    "Railway cuts requests at 30 s. Raise the proxy timeout for the export route while the job queue lands.",
    { comments: [[JACK, 25, "Timeout is 120 s on that route only. Temporary; remove when #33 ships."]] }],
  [39, "Teachers can't find the export button on mobile", "bug", "normal", SANA, [LUKE], "GB",
    [["submitted", 22, SANA], ["in_progress", 17, LUKE], ["done", 15, LUKE]],
    "It's behind the overflow menu at phone width and nobody opens it.",
    { links: [L(fig("sapling-gradebook-mobile", "Gradebook on mobile"), 18, PRIYA)] }],

  // Teacher dashboard beta (current)
  [18, "Teacher dashboard: class overview with mastery per topic", "request", "high", MEI, [LUKE], "TD",
    [["submitted", 20, MEI], ["in_progress", 11, LUKE]],
    "The pilot schools' first ask. One screen per class: each topic's average mastery, the students below 50%, and who hasn't studied this week.\n\nSub-tickets cover the API, the quiet-students flag, filters and the empty state.",
    { links: [L(fig("sapling-teacher-dashboard", "Teacher dashboard"), 19, PRIYA), L(gh(240, "issues"), 20, MEI)],
      comments: [[PRIYA, 18, "Designs are in Figma. The topic grid collapses to a list under 900 px."], [LUKE, 10, "Grid and list are on staging behind `teacher_dashboard`. Waiting on the mastery API for real numbers."], [MEI, 4, "Showed it to two teachers at Northside today. They want to sort by \"needs attention\" first."]] }],
  [19, "Mastery API: per-student topic scores for a class", "request", "high", MEI, [JOSE], "TD",
    [["submitted", 19, MEI], ["in_progress", 14, JOSE], ["testing", 9, JOSE], ["done", 7, MEI]],
    "`GET /api/classes/:id/mastery` — topics × students, each a 0–1 score from quiz results and review history, with the date it was last updated.",
    { parent: 18, links: [L(gh(245), 8, JOSE)], comments: [[JOSE, 9, "Under 200 ms for a 150-student class with the new index (#79)."]] }],
  [20, "Dashboard: flag students who haven't studied in 7 days", "request", "normal", MEI, [LUKE], "TD",
    [["submitted", 18, MEI], ["in_progress", 8, LUKE], ["testing", 2, LUKE]],
    "A \"quiet\" mark beside each student with no review or quiz in the last 7 days, and a filter for them.",
    { parent: 18, links: [L(gh(252), 2, LUKE)], comments: [[OMAR, 1, "Testing on staging. The flag ignores time zones — a student in Hawaii shows as quiet a day early. Writing it up."]] }],
  [21, "Dashboard empty state for a class with no activity yet", "request", "low", PRIYA, [LUKE], "TD",
    [["submitted", 17, PRIYA], ["in_progress", 9, LUKE], ["done", 6, LUKE]],
    "A new class shows an empty grid. Explain what will appear, and link to the class code so the teacher can invite students.",
    { parent: 18 }],
  [22, "Teacher invite flow: join a school with a class code", "request", "high", SANA, [ME], "TD",
    [["submitted", 16, SANA], ["in_progress", 10, ME]],
    "Teachers sign up, enter the 6-character code their school admin gave them, and land in their classes. No more manual invites from us.",
    { links: [L(fig("sapling-teacher-onboarding", "Teacher onboarding"), 15, PRIYA)], comments: [[SANA, 9, "11 of the 12 pilot schools have their codes. Westbrook is waiting on their IT department."]] }],
  [23, "Class codes collide across schools", "bug", "high", SANA, [ME], "TD",
    [["submitted", 6, SANA], ["in_progress", 5, ME], ["testing", 1, ME]],
    "A teacher at Lakeview joined a Northside class. Codes are unique per school, not globally.",
    { parent: 22, links: [L(gh(255), 1, ME)], comments: [[ME, 5, "Codes are now global and 8 characters. Existing codes keep working; collisions are resolved by the school the teacher's e-mail domain belongs to."], [OMAR, 0.3, "Verified on staging with the two schools' test accounts. One more check on the e-mail-domain fallback and I'll close it."]] }],
  [24, "Dashboard takes 6 s to load for classes over 150 students", "bug", "high", MEI, [JOSE], "TD",
    [["submitted", 8, MEI], ["in_progress", 6, JOSE]],
    "Northside's combined Year 10 class (162 students) takes about 6 s. Smaller classes are under a second.",
    { comments: [[JOSE, 5, "N+1 on topics. Batching it gets us to 1.4 s; the rest is the mastery query itself."], [JACK, 4, "The query plan does a sequential scan on review_events. #79 should fix it."]] }],
  [25, "Export a class's mastery as CSV", "request", "normal", MEI, [], "TD",
    [["submitted", 7, MEI]],
    "Teachers want to paste mastery into their own spreadsheets. Reuse the streaming exporter."],
  [26, "Design: dashboard filters (topic, week, student group)", "request", "normal", MEI, [PRIYA], "TD",
    [["submitted", 15, MEI], ["in_progress", 13, PRIYA], ["done", 9, PRIYA]],
    "Filters for topic, week and the teacher's own student groups.",
    { links: [L(fig("sapling-teacher-dashboard", "Dashboard filters"), 9, PRIYA)] }],
  [27, "Accessibility pass on the dashboard tables", "request", "normal", PRIYA, [LUKE], "TD",
    [["submitted", 9, PRIYA]],
    "Screen reader labels for the mastery cells, sortable headers announced, and colour never the only signal."],
  [28, "Onboarding checklist for the 12 pilot schools", "request", "normal", SANA, [SANA], "TD",
    [["submitted", 14, SANA], ["in_progress", 12, SANA]],
    "A shared checklist per school: codes sent, first class created, first teacher signed in, training call booked.",
    { comments: [[SANA, 3, "9 of 12 have a teacher signed in. Calls booked with the other three next week."]] }],
  [29, "Row-level security for teacher reads of student data", "request", "high", JOSE, [JOSE], "TD",
    [["submitted", 14, JOSE], ["in_progress", 13, JOSE], ["done", 10, ME]],
    "A teacher reads only the students in their own classes. Enforced in Postgres (RLS), not just the API.",
    { links: [L(gh(243), 10, JOSE)], comments: [[ME, 10, "Reviewed the policies with Jose. Merged."]] }],
  [30, "Dashboard: per-topic drill-down chart", "request", "normal", MEI, [LUKE], "TD",
    [["submitted", 6, MEI]],
    "Click a topic to see each student's score over the last 4 weeks."],
  [31, "QA: teacher dashboard regression suite", "request", "normal", OMAR, [OMAR], "TD",
    [["submitted", 11, OMAR], ["in_progress", 7, OMAR]],
    "Playwright specs for the dashboard: load, filters, quiet students, empty class, a 150-student class.",
    { comments: [[OMAR, 2, "12 specs green on staging. Still to do: the 150-student fixture."]] }],

  // Offline study mode (planned)
  [40, "Offline study mode: keep today's review deck on the device", "request", "high", MEI, [LUKE], "OF",
    [["submitted", 9, MEI]],
    "Students on long bus rides lose their streak. Keep today's due cards (and their images) on the device.",
    { links: [L(fig("sapling-offline", "Offline states"), 4, PRIYA)] }],
  [41, "Service worker for the study screens", "request", "normal", LUKE, [LUKE], "OF",
    [["submitted", 8, LUKE]],
    "Cache the shell and the review screen; network-first for everything else."],
  [42, "Sync review results when back online, with conflict rules", "request", "high", JOSE, [JOSE], "OF",
    [["submitted", 8, JOSE]],
    "A review done offline on two devices: last write wins per card, but the streak counts both days."],
  [43, "Design: offline indicator and sync state", "request", "normal", PRIYA, [PRIYA], "OF",
    [["submitted", 7, PRIYA]],
    "How the app says \"you're offline\", what's available, and when a sync finished or failed."],
  [44, "Storage budget: cap offline decks at 50 MB", "request", "normal", JACK, [], "OF",
    [["submitted", 7, JACK]],
    "Card images make decks big. Cap the cache and drop the oldest decks first."],
  [45, "Spike: IndexedDB or OPFS for card media?", "question", "normal", LUKE, [LUKE], "OF",
    [["submitted", 6, LUKE]],
    "OPFS is faster but Safari's support is recent. Time-box to two days."],
  [46, "Offline mode copy for students and parents", "request", "low", SANA, [SANA], "OF",
    [["submitted", 5, SANA]],
    "Help-centre article and the in-app explainer."],
  [47, "QA plan for offline mode on iOS Safari", "request", "normal", OMAR, [OMAR], "OF",
    [["submitted", 4, OMAR]],
    "Device matrix, airplane-mode scripts, and what counts as a pass."],

  // The rest of the queue
  [48, "Tutor answers cite the wrong page of an uploaded PDF", "bug", "high", SANA, [JOSE], null,
    [["submitted", 9, SANA], ["in_progress", 7, JOSE]],
    "Students click the citation and land two or three pages off. Happens with PDFs that have a cover page and roman-numeral front matter.",
    { comments: [[JOSE, 7, "We index by physical page but show the printed page label. Mapping labels at ingest; old uploads need a re-index."], [SANA, 2, "Another report from Westbrook today, same PDF type."]] }],
  [49, "Tutor: stream the first token in under 1.5 s", "request", "normal", JOSE, [JOSE], null,
    [["submitted", 21, JOSE], ["in_progress", 16, JOSE], ["testing", 3, JOSE]],
    "p50 time-to-first-token is 2.8 s. Start streaming before retrieval finishes re-ranking.",
    { links: [L(gh(250), 3, JOSE)], comments: [[JOSE, 3, "1.2 s p50 on staging with early streaming. Watching cost — re-ranking now runs on every request."]] }],
  [50, "Quiz generator repeats the same distractor across questions", "bug", "normal", SANA, [JOSE], null,
    [["submitted", 13, SANA], ["in_progress", 4, JOSE]],
    "In a 10-question quiz, \"mitochondria\" was a wrong answer in four questions."],
  [51, "Uploading a 200-page PDF times out at OCR", "bug", "high", SANA, [JACK], null,
    [["submitted", 30, SANA], ["in_progress", 29, JACK], ["done", 26, JACK]],
    "The OCR step runs in the request. Large scans time out and the upload is lost.",
    { links: [L(gh(229), 26, JACK)], comments: [[JACK, 26, "OCR runs on the worker queue now, pages in parallel. 200 pages in about 70 s."]] }],
  [52, "Knowledge graph: merge duplicate concepts across uploads", "request", "normal", JOSE, [], null,
    [["submitted", 19, JOSE]],
    "\"Photosynthesis\" from two textbooks becomes two concepts. Merge on embedding similarity above 0.92, with a review list."],
  [53, "Access: read access to Railway logs for Omar", "access", "normal", OMAR, [JACK], null,
    [["submitted", 24, OMAR], ["in_progress", 24, JACK], ["done", 23, JACK]],
    "For reproducing staging failures without asking.",
    { comments: [[JACK, 23, "Added as a viewer on the staging and production projects."]] }],
  [54, "Access: edit rights on the Figma team library for Priya", "access", "low", PRIYA, [MEI], null,
    [["submitted", 40, PRIYA], ["done", 39, MEI]], ""],
  [55, "Question: do we keep a student's uploads after their account is deleted?", "question", "normal", SANA, [ME], null,
    [["submitted", 16, SANA], ["in_progress", 15, ME], ["done", 14, ME]],
    "A parent asked. I'd like a one-line answer for the help centre.",
    { comments: [[ME, 14, "No: uploads, their embeddings and quiz history go with the account, within 30 days (backups roll off after that). Wrote it up in the Support playbook doc."]] }],
  [56, "Question: which model tier for free-plan students?", "question", "normal", MEI, [JOSE], null,
    [["submitted", 12, MEI], ["in_progress", 10, JOSE]],
    "Free students cost us more than paid ones per answer. Can the free plan use Flash-Lite without hurting quality?",
    { comments: [[JOSE, 10, "Running the tutor eval set on both. Flash-Lite is 0.6 points lower on correctness, 4× cheaper. Need Mei's call on whether that's acceptable."]] }],
  [57, "A parent account can see a sibling's progress", "bug", "high", SANA, [ME], null,
    [["submitted", 22, SANA], ["in_progress", 22, ME], ["done", 21, ME]],
    "A parent with two children linked sees both under either child's tab.",
    { links: [L(gh(234), 21, ME)], comments: [[ME, 21, "Fixed and deployed within the hour. The API was right; the client cached the first child's data under the parent id. No data left the family."]] }],
  [58, "Dark mode: mastery chart colours unreadable", "bug", "low", PRIYA, [], null,
    [["submitted", 5, PRIYA]],
    "The two lowest bands are near-black on the dark background."],
  [59, "Lazy-load the PDF viewer (−180 KB on first load)", "request", "normal", LUKE, [LUKE], null,
    [["submitted", 27, LUKE], ["in_progress", 25, LUKE], ["done", 23, LUKE]],
    "pdf.js is in the main bundle though most sessions never open a PDF.",
    { links: [L(gh(233), 23, LUKE)] }],
  [60, "Sentry noise: ResizeObserver loop errors", "bug", "low", JACK, [JACK], null,
    [["submitted", 25, JACK], ["declined", 24, JACK]],
    "Thousands a day, all benign.",
    { comments: [[JACK, 24, "Filtered in Sentry instead. Nothing to fix in the app."]] }],
  [61, "Rate-limit the tutor endpoint per student (20 a minute)", "request", "high", JOSE, [JOSE], null,
    [["submitted", 23, JOSE], ["in_progress", 22, JOSE], ["done", 19, JOSE]],
    "One student scripted 3,000 questions overnight. Limit per student, with a friendly message.",
    { links: [L(gh(238), 19, JOSE)] }],
  [62, "Streak resets at midnight UTC instead of the student's midnight", "bug", "high", SANA, [LUKE], null,
    [["submitted", 11, SANA], ["in_progress", 3, LUKE]],
    "Students on the west coast lose their streak at 5 pm. The most-reported bug this month (14 tickets in Intercom).",
    { comments: [[LUKE, 3, "Storing the student's time zone at sign-in; the streak job runs per zone now. Needs a backfill for existing students."]] }],
  [63, "Supabase connection pool exhausted during exam week", "bug", "high", JACK, [JACK], null,
    [["submitted", 18, JACK], ["in_progress", 18, JACK], ["done", 16, JACK]],
    "Monday 9:05: 60/60 connections, the API returned 503s for 11 minutes.",
    { links: [L(doc("incidents/exam-week-pool", "Incident write-up"), 16, JACK)], comments: [[JACK, 17, "Moved the API to the transaction pooler (port 6543) and capped each worker at 8. Write-up in Docs › Operations."]] }],
  [64, "Staging data for the teacher pilot demo", "request", "normal", MEI, [ME], null,
    [["submitted", 15, MEI], ["in_progress", 14, ME], ["done", 13, ME]],
    "A demo school with three classes and realistic (fake) students for Thursday's call.",
    { comments: [[ME, 13, "Demo school \"Maple Grove (demo)\" is on staging with 90 generated students. All names are fake."]] }],
  [65, "Remove the legacy v1 quiz endpoints", "request", "low", JOSE, [], null,
    [["submitted", 34, JOSE]],
    "No traffic in 30 days except our own health check."],
  [66, "Onboarding: skip the placement quiz for returning students", "request", "normal", MEI, [LUKE], null,
    [["submitted", 10, MEI]],
    "Students who come back after summer are asked the placement quiz again."],
  [67, "Translate the study screens into Spanish", "request", "normal", SANA, [], null,
    [["submitted", 26, SANA]],
    "Requested by two pilot schools with many Spanish-speaking families."],
  [68, "Bulk-import a class roster from CSV", "request", "normal", SANA, [ME], null,
    [["submitted", 17, SANA], ["in_progress", 8, ME], ["testing", 2, ME]],
    "Teachers paste a roster export from their SIS. Match on e-mail, create the rest.",
    { links: [L(gh(254), 2, ME)], comments: [[OMAR, 1, "Works with PowerSchool and Infinite Campus exports. A file with a trailing empty column fails — repro attached in the PR."]] }],
  [69, "Health check for the OCR worker", "request", "normal", JACK, [JACK], null,
    [["submitted", 14, JACK], ["in_progress", 6, JACK], ["testing", 1, JACK]],
    "`/health` on the worker reports queue depth and the age of the oldest job; alert above 10 minutes."],
  [70, "Flaky e2e: quiz timer test fails 1 run in 10", "bug", "normal", OMAR, [OMAR], null,
    [["submitted", 12, OMAR], ["in_progress", 5, OMAR]],
    "`quiz.spec.ts › timer stops at zero` fails intermittently on CI only.",
    { comments: [[OMAR, 5, "It depends on the tab being visible; CI's headless Chrome throttles timers. Switching the test to a fake clock."]] }],
  [71, "Upgrade Next.js to 16.1 and the OpenNext adapter", "request", "normal", LUKE, [LUKE], null,
    [["submitted", 13, LUKE]],
    "Fixes the streaming bug we patched around in the tutor."],
  [72, "Move secrets from Railway variables to the shared vault", "request", "normal", JACK, [JACK], null,
    [["submitted", 20, JACK]],
    "One place to rotate the Gemini and Supabase keys."],
  [73, "Question: can a teacher delete a student's upload?", "question", "low", SANA, [], null,
    [["submitted", 3, SANA]],
    "A teacher wants to remove an inappropriate file a student shared with the class."],
  [74, "Gemini cost spike: find what tripled spend on a Saturday", "bug", "high", JOSE, [JOSE], null,
    [["submitted", 12, JOSE], ["in_progress", 12, JOSE], ["done", 11, JOSE]],
    "Spend went from about $40 to $130 on one day.",
    { comments: [[JOSE, 11, "The scripted student from #61 (before the limit shipped) plus a retry loop on 429s. Retries are capped at 2 now."]] }],
  [75, "Landing page: pilot-school testimonials section", "request", "low", SANA, [PRIYA], null,
    [["submitted", 29, SANA], ["declined", 21, MEI]],
    "Quotes from three teachers.",
    { comments: [[MEI, 21, "The marketing site moved to its own repo and team. Filing it there instead."]] }],
  [76, "Push-notification permission prompt appears on first launch", "bug", "normal", PRIYA, [LUKE], null,
    [["submitted", 33, PRIYA], ["in_progress", 30, LUKE], ["done", 28, LUKE]],
    "Ask after the first completed review, not before the student has seen anything."],
  [77, "A student can submit a quiz twice by double-clicking", "bug", "normal", OMAR, [LUKE], null,
    [["submitted", 21, OMAR], ["in_progress", 20, LUKE], ["done", 19, LUKE]],
    "Two attempts are recorded and the second one scores zero.",
    { links: [L(gh(239), 19, LUKE)] }],
  [78, "Weekly progress e-mail for parents", "request", "normal", MEI, [], null,
    [["submitted", 14, MEI]],
    "Minutes studied, cards reviewed, the streak. Opt-in per parent."],
  [79, "Index review_events on (student_id, due_at)", "request", "normal", JOSE, [JOSE], null,
    [["submitted", 7, JOSE], ["in_progress", 6, JOSE], ["done", 5, JOSE]],
    "The dashboard and the review queue both scan by student and due date.",
    { links: [L(gh(249), 5, JOSE)], comments: [[JOSE, 5, "Mastery query 1.1 s → 90 ms for the 162-student class."]] }],
  [80, "Access: the support inbox in Intercom for Sana", "access", "low", SANA, [], null,
    [["submitted", 1, SANA]], "Read and reply on the student support inbox."],
];

// ── handoffs (numbers 1–10; the canonical dev seed starts at 11) ───────────────────────────────────────────────────
// [number, sender, recipient, status, created days ago, claimed days ago | null, claimed_by | null, body, context, prompt?]
export const HANDOFFS = [
  [1, JOSE, LUKE, "claimed", 24, 23.8, LUKE,
    "The mastery API shape is settled; the dashboard can build against it.\n\n`GET /api/classes/:id/mastery` returns topics × students with a 0–1 score and `updated_at`. A fake implementation is behind `MASTERY_FAKE=1` until the real query lands.",
    { branch: "feat/mastery-api", task: "Build the class overview against the mastery API", done: ["Agreed the response shape", "Fake implementation behind MASTERY_FAKE=1"], next: ["Topic grid from the fake data", "Swap to the real endpoint when #19 merges"], files: ["backend/routers/classes.py", "web/app/teacher/[classId]/page.tsx"] }],
  [2, JACK, "anyone", "expired", 21, null, null,
    "Staging's OCR worker leaks memory: about 40 MB an hour, restarts every ~10 hours. Heap snapshots are in the bucket under `debug/ocr-heap/`. I'm out until Monday.",
    { branch: "main", task: "Find the OCR worker memory leak", done: ["Two heap snapshots, 6 hours apart"], next: ["Diff the snapshots", "Check pdfium page handles are closed"], files: ["workers/ocr/main.py"] }],
  [3, ME, JACK, "claimed", 18, 17.9, JACK,
    "Exam week starts Monday. Can you watch the Supabase pool and have the transaction-pooler switch ready to go? The config change is drafted on `ops/pooler`.",
    { branch: "ops/pooler", task: "Be ready to move the API to the transaction pooler", done: ["Drafted the config change", "Load test at 200 rps passed"], next: ["Watch connections Monday 8–10 am", "Flip to port 6543 if above 50"], files: ["backend/db/connection.py", "railway.json"] }],
  [4, LUKE, OMAR, "claimed", 9, 8.5, OMAR,
    "Quiet-students flag is on staging. Edge cases worth testing: a student who only did a quiz, a student added this week, and time zones far from ours.",
    { branch: "feat/quiet-students", task: "Test the quiet-students flag", done: ["Flag + filter on staging"], next: ["Cover the three edge cases", "File what breaks"], files: ["web/app/teacher/[classId]/QuietMark.tsx"] }],
  [5, JOSE, ME, "expired", 15, null, null,
    "The free-plan model question (#56) needs the eval numbers side by side. I ran them; the notebook is in `evals/tier-compare.ipynb`. Can you turn it into a recommendation for Mei?",
    { branch: "evals/tier-compare", task: "Write up Flash vs Flash-Lite for the free plan", done: ["Ran the tutor eval on both tiers"], next: ["Summarize cost and quality", "Recommend a tier"], files: ["evals/tier-compare.ipynb"] }],
  [6, MEI, PRIYA, "claimed", 13, 12.7, PRIYA,
    "Teachers at Northside want to sort by \"needs attention\" first. Can you sketch how the grid sorts and what \"needs attention\" means (below 50% on any topic, or quiet)?",
    { branch: "", task: "Design the needs-attention sort", done: ["Collected the teachers' notes"], next: ["Define needs-attention", "Sketch the sorted grid"], files: [] }],
  [7, JOSE, "anyone", "pending", 1.2, null, null,
    "The export job (#33) is up as a PR. It needs a review from someone who knows R2 multipart uploads — the stitching step is the part I'm least sure of.",
    { branch: "feat/export-jobs", task: "Review the export job PR", done: ["Worker writes chunks to R2", "Progress endpoint", "E-mail with a 7-day link"], next: ["Review the multipart stitching", "Check link expiry"], files: ["backend/jobs/export.py", "backend/storage/r2.py"] },
    { title: "Review the gradebook export job", body: "You're reviewing the gradebook export job on `feat/export-jobs` (ticket #33).\n\nFocus on `backend/storage/r2.py`: chunks are uploaded as parts of an R2 multipart upload and completed in order. Check part ordering, the 5 MB minimum part size, and what happens when one part fails.\n\nRun `pytest backend/jobs/test_export.py` and the 40k-row fixture before approving." }],
  [8, LUKE, ME, "pending", 0.4, null, null,
    "Class-code collision fix (#23) is in testing. Omar verified the main path; the e-mail-domain fallback still needs a look before we close it.",
    { branch: "fix/class-code-collisions", task: "Check the e-mail-domain fallback for class codes", done: ["Global 8-character codes", "Old codes still resolve"], next: ["Test a teacher whose domain matches two schools", "Close #23"], files: ["backend/routers/schools.py"] }],
  [9, OMAR, LUKE, "pending", 0.9, null, null,
    "Roster import (#68) fails on a CSV with a trailing empty column. Repro file is attached to the PR; everything else passed.",
    { branch: "feat/roster-import", task: "Fix the trailing-column roster import bug", done: ["Tested PowerSchool and Infinite Campus exports"], next: ["Ignore empty trailing columns", "Re-run the import specs"], files: ["backend/importers/roster.py"] }],
  [10, SANA, MEI, "claimed", 6, 5.5, MEI,
    "Three pilot schools still have no teacher signed in. Their contacts and what I've tried are in the onboarding checklist doc.",
    { branch: "", task: "Follow up with the three quiet pilot schools", done: ["Two e-mails each", "Offered a training call"], next: ["Call the principals", "Decide whether to replace a school"], files: [] }],
];

// ── feed (ids 7001+) ───────────────────────────────────────────────────────────────────────────────────────────────
// [author, days ago, summary, body, tags, artifacts {prs, commits, issues}, importance?]
export const FEED = [
  [JOSE, 40.2, "Shipped: SM-2 scheduling for flashcards", "Cards are scheduled with SM-2 and a per-card ease factor. Existing decks are backfilled from their review history.", ["data", "api"], { prs: ["214", "219"], commits: ["4f1c2a9"], issues: [] }, "notable"],
  [LUKE, 39.5, "Finding: the flip animation was painting box-shadow every frame", "Low-end Android dropped to ~12 fps. A transform on a pre-rendered shadow layer holds 60 fps on a Moto E.", ["ui", "perf"], { prs: ["216"], commits: [], issues: [] }],
  [JACK, 36.1, "Status: load test of the review endpoint passed at 200 rps", "p95 140 ms, no errors over 10 minutes. The Supabase pool peaked at 41/60 — the next thing to watch.", ["infra", "perf"], { prs: [], commits: [], issues: [] }],
  [MEI, 35.4, "Decision: no daily reminder e-mail this quarter", "Push covers mobile; e-mail waits for the notifications rework. Closed #13.", ["teachers"], { prs: [], commits: [], issues: [] }],
  [JOSE, 33.3, "Finding: day-7 retention up from 61% to 74% with SM-2", "Measured on decks older than a month, 2,140 students. Day-30 retention moved less (48% → 53%).", ["data"], { prs: [], commits: [], issues: [] }, "notable"],
  [LUKE, 32.6, "Shipped: daily cap on new cards", "Students choose 5–100 new cards a day; default 20.", ["ui"], { prs: ["221"], commits: ["9ab03e1"], issues: [] }],
  [JOSE, 30.8, "Status: gradebook export streams for one class", "Rows are written as they're read. Whole-school exports still hit the 30 s limit — they need a job.", ["api", "teachers"], { prs: [], commits: ["c0d4e17", "77ab210"], issues: [] }],
  [JACK, 29.7, "Shipped: OCR runs on the worker queue", "Uploads no longer time out: pages are OCR'd in parallel off the request. 200 pages ≈ 70 s.", ["infra", "tutor"], { prs: ["229"], commits: [], issues: [] }],
  [SANA, 28.9, "Triage: five gradebook reports from pilot schools this week", "Rounding (#34), Excel accents (#35), the mobile export button (#39), and two asks for a late-submission column (#36).", ["teachers"], { prs: [], commits: [], issues: [] }],
  [JOSE, 26.2, "Decision: stream exports, and make whole-school exports a job", "A request can't build 40k rows in 30 s on Railway. Single-class exports stream; whole-school ones run as a job and e-mail a link.", ["architecture", "api"], { prs: [], commits: [], issues: [] }, "notable"],
  [JACK, 25.6, "Shipped: 120 s timeout on the export route (temporary)", "Until the export job lands. Every other route keeps 30 s.", ["infra"], { prs: [], commits: ["e1f9a04"], issues: [] }],
  [ME, 24.4, "Shipped: weighted grade rounding fixed", "Categories are weighted before rounding. A Lakeview student moved from 89.99 to 90.00.", ["teachers"], { prs: ["236"], commits: [], issues: [] }],
  [LUKE, 23.2, "Shipped: PDF viewer is lazy-loaded", "−180 KB on first load (gzip). The study screen's LCP on a mid phone: 2.9 s → 2.3 s.", ["ui", "perf"], { prs: ["233"], commits: [], issues: [] }],
  [ME, 21.6, "Incident: a parent could see a sibling's progress", "Client cache keyed by parent id, not child. Fixed and deployed in 52 minutes; the API never returned another family's data. Write-up in Docs.", ["incident", "auth"], { prs: ["234"], commits: [], issues: [] }, "breaking"],
  [JOSE, 19.4, "Shipped: per-student rate limit on the tutor", "20 questions a minute, with a friendly message. Stops scripted abuse like last Saturday's.", ["tutor", "api"], { prs: ["238"], commits: [], issues: [] }],
  [LUKE, 19.1, "Shipped: quiz submit is idempotent", "A double-click no longer records two attempts.", ["ui"], { prs: ["239"], commits: [], issues: [] }],
  [JACK, 18.2, "Incident: Supabase pool exhausted at 9:05 on exam Monday", "60/60 connections; 503s for 11 minutes. Moved to the transaction pooler and capped workers at 8. No data loss.", ["incident", "infra"], { prs: ["241"], commits: [], issues: [] }, "breaking"],
  [JACK, 17.3, "Finding: two workers held 30 idle connections each", "The OCR workers opened a session per page. They share a pool of 4 now.", ["infra", "data"], { prs: [], commits: ["5d1e8c3"], issues: [] }],
  [MEI, 16.5, "Status: teacher dashboard scoped for the beta", "Class overview, quiet students, filters, empty state; invite with a class code. Exports and drill-down wait.", ["teachers"], { prs: [], commits: [], issues: [] }],
  [PRIYA, 15.2, "Status: dashboard designs ready for review", "Grid at desktop, list under 900 px, filters for topic/week/group. Figma link on #18.", ["ui", "teachers"], { prs: [], commits: [], issues: [] }],
  [ME, 14.1, "Shipped: demo school on staging", "\"Maple Grove (demo)\" with 3 classes and 90 generated students for pilot calls.", ["teachers"], { prs: [], commits: ["0a8c7f2"], issues: [] }],
  [JOSE, 13.6, "Shipped: row-level security for teacher reads", "Postgres policies limit a teacher to their own classes' students, whatever the API asks.", ["auth", "data"], { prs: ["243"], commits: [], issues: [] }, "notable"],
  [JOSE, 11.4, "Finding: the Saturday Gemini spike was a retry loop", "429s were retried without a cap while one student scripted questions. Retries capped at 2.", ["tutor", "perf"], { prs: ["244"], commits: [], issues: [] }],
  [SANA, 10.8, "Triage: streak resets are this month's top support topic", "14 conversations in Intercom, all west-coast students. Filed as #62.", ["ui"], { prs: [], commits: [], issues: [] }],
  [LUKE, 10.2, "Status: topic grid on staging behind teacher_dashboard", "Real data once the mastery API merges.", ["ui", "teachers"], { prs: [], commits: ["a71b9d0", "1c2e4f6"], issues: [] }],
  [JOSE, 8.6, "Shipped: mastery API", "`GET /api/classes/:id/mastery`: topics × students, 0–1 scores. Under 200 ms for 150 students.", ["api", "teachers"], { prs: ["245"], commits: [], issues: [] }, "notable"],
  [JOSE, 7.1, "Decision: free-plan tutor stays on Flash for now", "Flash-Lite is 4× cheaper but 0.6 points lower on correctness in our eval. Revisit with the next eval set.", ["tutor"], { prs: [], commits: [], issues: [] }],
  [OMAR, 6.9, "Finding: quiz timer test is flaky because CI throttles hidden-tab timers", "Moving the spec to a fake clock.", ["ui"], { prs: [], commits: [], issues: [] }],
  [LUKE, 6.2, "Shipped: dashboard empty state", "A new class explains what will appear and shows the class code.", ["ui", "teachers"], { prs: ["247"], commits: [], issues: [] }],
  [JOSE, 5.3, "Shipped: review_events index", "Mastery query for the 162-student class: 1.1 s → 90 ms.", ["data", "perf"], { prs: ["249"], commits: [], issues: [] }],
  [ME, 4.8, "Status: class codes become global", "Codes collided across schools. Now 8 characters and unique everywhere; old codes keep working.", ["auth", "teachers"], { prs: [], commits: ["f3a90b1", "2be71c4"], issues: [] }],
  [JACK, 4.1, "Status: OCR worker health check", "Reports queue depth and the oldest job's age; alerts above 10 minutes. On staging.", ["infra"], { prs: ["251"], commits: [], issues: [] }],
  [MEI, 3.7, "Decision: Google Classroom sync moves to next quarter", "It doesn't fit the gradebook sprint, which is already late. Export job first.", ["teachers"], { prs: [], commits: [], issues: [] }],
  [JOSE, 3.2, "Status: tutor first token at 1.2 s on staging", "Streaming starts before re-ranking finishes. Watching cost for a week before production.", ["tutor", "perf"], { prs: ["250"], commits: [], issues: [] }],
  [JOSE, 2.9, "Status: export job PR is up", "Chunks to R2, stitched with a multipart upload, e-mailed link valid 7 days. Needs a reviewer (handoff #7).", ["api", "teachers"], { prs: ["258"], commits: [], issues: [] }],
  [LUKE, 2.3, "Status: quiet-students flag in testing", "Omar is covering time zones and new students.", ["ui", "teachers"], { prs: ["252"], commits: [], issues: [] }],
  [ME, 1.9, "Status: roster import in testing", "PowerSchool and Infinite Campus pass; a trailing empty column breaks it (handoff #9).", ["teachers", "data"], { prs: ["254"], commits: [], issues: [] }],
  [SANA, 1.6, "Triage: two more wrong-page citation reports", "Both PDFs with roman-numeral front matter. Added to #48.", ["tutor"], { prs: [], commits: [], issues: [] }],
  [OMAR, 0.9, "Finding: quiet flag is a day early for students far west of us", "We compare against our midnight, not the student's. Same root cause as the streak bug (#62).", ["teachers"], { prs: [], commits: [], issues: [] }],
  [JACK, 0.5, "Status: staging and production frontends on the same build", "Both on 3e9a1f2 after this morning's deploy. Production backend is still on the previous build.", ["infra"], { prs: [], commits: [], issues: [] }],
  [LUKE, 0.25, "Shipped: needs-attention sort on the dashboard", "Students below 50% on any topic, or quiet for 7 days, sort first.", ["ui", "teachers"], { prs: ["257"], commits: [], issues: [] }],
];

// ── decisions (ADR ids 7–10; the canonical dev seed has 1–6) ──────────────────────────────────────────────────────
// [id, title, status, created_by, days ago, context, decision, rationale, confidence]
export const ADRS = [
  [7, "Stream exports; run whole-school exports as a job", "ratified", JOSE, 26,
    "Whole-school gradebook exports build 40k rows in memory and exceed Railway's 512 MB and 30 s limits.",
    "Single-class exports stream rows as they're read. Whole-school exports run on the worker queue, write chunks to R2 and e-mail a link valid for 7 days.",
    "Streaming alone can't beat the request timeout for the largest schools, and a job gives teachers progress instead of a spinner.", "high"],
  [8, "Teachers' access to student data is enforced in Postgres", "ratified", JOSE, 14,
    "The dashboard reads student data across classes. An API bug could leak another class's students.",
    "Row-level security policies limit a teacher to the students in their own classes; the API connects with the teacher's role.",
    "Defence in depth: a mistake in one query can't expose another school.", "high"],
  [9, "Offline reviews: last write wins per card, streak counts every day studied", "draft", LUKE, 6,
    "Offline mode lets the same card be reviewed on two devices before either syncs.",
    "On sync, the most recent review of a card wins; the streak credits each local day with any review.",
    "Students care about the streak more than the exact interval; a lost review costs little.", "medium"],
  [10, "Free-plan tutor stays on Gemini Flash", "draft", JOSE, 7,
    "Free students cost more per answer than paid ones. Flash-Lite is 4× cheaper.",
    "Keep Flash for every plan this quarter; re-run the eval with the new question set next quarter.",
    "0.6 points lower correctness is visible to students in our eval; the saving is ~$300 a month.", "medium"],
];

// ── Unplaced (needs_triage ids 7001+) ─────────────────────────────────────────────────────────────────────────────
// [author, days ago, reason, raw (object → JSON, string as is)]
export const TRIAGE = [
  [JACK, 2.2, "unknown section: postmortems", { slug: "sapling-exam-week-pool", section: "postmortems", title: "Exam week: connection pool", confidence: "high", change_summary: "Postmortem for the exam-week pool exhaustion", body: "# Exam week: connection pool\n\n**What happened** At 9:05 on Monday the API used all 60 Supabase connections and returned 503s for 11 minutes.\n\n**Why** Each OCR worker opened a session per page; two workers held 30 idle connections each.\n\n**Fix** Transaction pooler (port 6543), 8 connections per worker, a shared pool of 4 for OCR.\n\n**Follow-ups** Alert at 45 connections (#69)." }],
  [LUKE, 4.5, "Ambiguous: a how-to and an unmade decision about caching. Needs a human to choose.", "Service worker: cache the app shell and the review screen; network-first for API calls. Should card images be cache-first with a 50 MB cap, or stale-while-revalidate? Leaning cache-first."],
  [JOSE, 8.3, "low confidence: the agent wasn't sure this is a decision rather than a status", "We'll keep Gemini Flash for free students until the next eval set; Flash-Lite saves ~$300/month but loses 0.6 points on correctness."],
  [SANA, 0.7, "unknown section: help-centre", { slug: "sapling-help-offline", section: "help-centre", title: "Studying offline", confidence: "medium", change_summary: "Draft help article for offline mode", body: "# Studying offline\n\nSapling keeps today's review cards on your phone, so you can study without a connection. Your answers sync the next time you're online, and your streak still counts." }],
];

// ── prompts (the Prompt Library) ──────────────────────────────────────────────────────────────────────────────────
// { slug, title, description, tags, author, use_count, last_used_days, versions: [[version, status, author, days ago, summary, body]] }
export const PROMPTS = [
  { slug: "teacher-feedback-digest", title: "Digest teacher feedback from the pilot", description: "Turns a week of pilot-school notes into themes, quotes and tickets to file.", tags: ["teachers"], author: MEI, use_count: 9, last_used_days: 1.5,
    versions: [[1, "published", MEI, 20, "First version", "Read the pilot notes in {{notes_file}}.\n\nGroup them into at most five themes. For each: one sentence, two short quotes with the school's name, and whether an existing ticket covers it (search Trov tickets first).\n\nEnd with the tickets to file — title, category, priority — and nothing else."],
      [2, "published", MEI, 6, "Ask for existing tickets first", "Read the pilot notes in {{notes_file}}.\n\nFirst search Trov for tickets about each note (`list_tickets` with a query). Then group the notes into at most five themes. For each: one sentence, two short quotes with the school's name, and the ticket that covers it, if any.\n\nEnd with the tickets to file — title, category, priority — only for themes no ticket covers."]] },
  { slug: "incident-writeup", title: "Write up a production incident", description: "A blameless write-up from the timeline: what happened, why, what changed, follow-ups.", tags: ["incident", "infra"], author: JACK, use_count: 4, last_used_days: 16,
    versions: [[1, "published", JACK, 30, "From the exam-week write-up", "Write a blameless incident report for {{incident}}.\n\nSections: **What happened** (times in the team's zone), **Impact** (who, how long, any data at risk), **Why** (the chain of causes, not a person), **What changed**, **Follow-ups** (each a ticket number or 'to file').\n\nKeep it under 300 words. Record it to the feed as `Incident:` and propose it as a doc in Operations."]] },
  { slug: "tutor-eval-run", title: "Run the tutor eval and compare", description: "Runs the tutor eval set on two configurations and reports cost and quality side by side.", tags: ["tutor"], author: JOSE, use_count: 6, last_used_days: 7,
    versions: [[1, "published", JOSE, 15, "First version", "Run `python -m backend.evals.tutor --config {{config_a}}` and the same with `{{config_b}}`.\n\nReport a table: correctness, citation accuracy, p50 latency, cost per 1,000 answers. Call out any question where the two disagree on correctness, with both answers.\n\nDon't change prompts or code."],
      [2, "staged", JOSE, 2, "Add citation page accuracy", "Run `python -m backend.evals.tutor --config {{config_a}}` and the same with `{{config_b}}`.\n\nReport a table: correctness, citation accuracy, citation PAGE accuracy (the page label the student sees), p50 latency, cost per 1,000 answers. Call out disagreements with both answers.\n\nDon't change prompts or code."]] },
  { slug: "playwright-spec-from-ticket", title: "Write a Playwright spec from a ticket", description: "Reads a ticket's acceptance notes and writes a focused e2e spec with fixtures.", tags: ["ui"], author: OMAR, use_count: 3, last_used_days: 4,
    versions: [[1, "draft", OMAR, 4, "Draft", "Read ticket {{ticket}} with `get_ticket`. Write one Playwright spec in `e2e/` that covers its acceptance notes, using the fixtures in `e2e/fixtures/`. Use a fake clock for anything with time. No sleeps."]] },
];

// ── artifacts (ids 7001+) ─────────────────────────────────────────────────────────────────────────────────────────
// fixtures/dev/artifacts.json (the Guide's four samples) are written as they are, plus these.
// { slug, title, kind, area, author, status, days, content, summary, links: [[type, ref]] }
export const EXTRA_ARTIFACTS = [
  { slug: "export-job-sequence", title: "Gradebook export job: sequence", kind: "mermaid", area: "api", author: JOSE, status: "published", days: 12, summary: "How a whole-school export runs.",
    links: [["ticket", "33"], ["sprint", String(7002)]],
    content: "sequenceDiagram\n  participant T as Teacher\n  participant API\n  participant Q as Worker queue\n  participant R2\n  T->>API: POST /exports (school)\n  API->>Q: enqueue job\n  API-->>T: 202 + job id\n  loop each 5,000 rows\n    Q->>R2: upload part\n  end\n  Q->>R2: complete multipart\n  Q-->>T: e-mail link (7 days)\n" },
  { slug: "teacher-dashboard-notes", title: "Teacher dashboard: pilot feedback, week 2", kind: "markdown", area: "ui", author: MEI, status: "published", days: 4, summary: "What teachers at Northside and Lakeview said.",
    links: [["ticket", "18"], ["sprint", String(7003)]],
    content: "# Teacher dashboard — pilot feedback, week 2\n\n## What worked\n- The topic grid: \"I finally see which topic the whole class is stuck on.\" (Northside, Year 10)\n- Quiet students: two teachers used it to message students the same day.\n\n## What didn't\n- Sorting. Everyone wanted *needs attention* first (now #18's sort).\n- Load time on the 162-student class (fixed by #79).\n\n## Asked for\n1. CSV of mastery (#25)\n2. Drill-down per topic (#30)\n3. Google Classroom sync (moved to next quarter)\n" },
  { slug: "mastery-score-explainer", title: "How the mastery score is computed", kind: "svg", area: "data", author: JOSE, status: "ratified", days: 9, summary: "Quiz results and review history, weighted by recency.",
    links: [["ticket", "19"]],
    content: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 520 180\" font-family=\"system-ui,sans-serif\" font-size=\"13\"><rect width=\"520\" height=\"180\" fill=\"#f7f5ef\"/><rect x=\"20\" y=\"30\" width=\"140\" height=\"50\" rx=\"8\" fill=\"#fff\" stroke=\"#c9c2b4\"/><text x=\"90\" y=\"60\" text-anchor=\"middle\">Quiz results ×0.6</text><rect x=\"20\" y=\"100\" width=\"140\" height=\"50\" rx=\"8\" fill=\"#fff\" stroke=\"#c9c2b4\"/><text x=\"90\" y=\"130\" text-anchor=\"middle\">Review recall ×0.4</text><path d=\"M160 55 L230 90 M160 125 L230 90\" stroke=\"#8a8273\" fill=\"none\"/><rect x=\"230\" y=\"65\" width=\"130\" height=\"50\" rx=\"8\" fill=\"#fff\" stroke=\"#c9c2b4\"/><text x=\"295\" y=\"95\" text-anchor=\"middle\">Recency decay</text><path d=\"M360 90 L410 90\" stroke=\"#8a8273\"/><rect x=\"410\" y=\"65\" width=\"90\" height=\"50\" rx=\"8\" fill=\"#3b6e4f\"/><text x=\"455\" y=\"95\" text-anchor=\"middle\" fill=\"#fff\">0–1 score</text></svg>" },
  { slug: "exam-week-pool-timeline", title: "Exam week pool incident: timeline", kind: "markdown", area: "infra", author: JACK, status: "draft", days: 17, summary: "Minute by minute.",
    links: [["ticket", "63"]],
    content: "# Exam week pool incident — timeline\n\n| Time | What |\n|---|---|\n| 09:02 | Connections climb past 50 |\n| 09:05 | 60/60, API returns 503 |\n| 09:07 | Alert fires; Jack on it |\n| 09:11 | Pooler switch (`ops/pooler`) deployed to production |\n| 09:16 | Connections at 22, errors stop |\n\nTotal impact: 11 minutes of 503s on study and quiz routes.\n" },
];

// ── docs (the layer's own slugs; sections it registers) ─────────────────────────────────────────────────────────────
// { slug, section, space, title, owner, versions: [[version, status, author, days ago, summary, body, change_kind?]] }
// The doc row carries the newest PROMOTED version; a staged one is a proposal waiting in Review.
const DASH_V1 = `# Teacher dashboard

A teacher's view of their classes: who is learning what, and who needs help.

## Who it's for
Teachers at the 12 pilot schools. One teacher, several classes, 20–160 students each.

## What it shows
- **Topic grid** — each topic's average mastery for the class (0–100%).
- **Students below 50%** on any topic.
- **Quiet students** — no review or quiz in the last 7 days.

## Out of scope for the beta
Exports, per-topic drill-down, Google Classroom.
`;
const DASH_V2 = DASH_V1.replace("## Out of scope for the beta", `## Filters
Topic, week, and the teacher's own student groups. Filters stay in the URL so a teacher can bookmark a view.

## Out of scope for the beta`);
const DASH_V3 = DASH_V2.replace("- **Quiet students** — no review or quiz in the last 7 days.", "- **Quiet students** — no review or quiz in the last 7 days, in the student's own time zone.\n- **Needs attention first** — the grid sorts students below 50% or quiet to the top.");
const DASH_V4 = DASH_V3.replace("## Out of scope for the beta\nExports, per-topic drill-down, Google Classroom.", "## Out of scope for the beta\nPer-topic drill-down and Google Classroom (next quarter).\n\n## Exports\nA class's mastery downloads as CSV through the streaming exporter.");

const EXPORT_V1 = `# Gradebook export

## Formats
CSV (UTF-8 with a BOM, so Excel reads accents) and XLSX.

## How it runs
- **One class**: streamed — rows are written as they are read, nothing is held in memory.
- **A whole school**: a job on the worker queue. It writes 5,000-row chunks to R2, completes a multipart upload, and e-mails the teacher a link valid for 7 days.

## Columns
Student, e-mail, each assignment's score, each category's weighted average, the final grade. Weights apply before rounding (2 decimals).

## Limits
Railway cuts a request at 30 s; the export route allows 120 s until the job ships (#38).
`;
const EXPORT_V2 = EXPORT_V1.replace("## Limits", "## Progress\n`GET /api/exports/:id` returns `queued`, `running` (rows done / total) or `ready` with the link.\n\n## Limits");
const EXPORT_V3 = EXPORT_V2.replace("Railway cuts a request at 30 s; the export route allows 120 s until the job ships (#38).", "Whole-school exports run as a job, so no request outlives Railway's 30 s. The temporary 120 s timeout on the export route is removed.");

const DEPLOY_V1 = `# Deploys and environments

| | Staging | Production |
|---|---|---|
| Branch | \`main\` | \`production\` |
| Frontend | Cloudflare Worker \`sapling-staging\` | Cloudflare Worker \`sapling\` |
| Backend | Railway service \`api\` (staging) | Railway service \`api\` (production) |

## Shipping
1. Merge to \`main\`: staging deploys both apps.
2. Check staging (the e2e suite runs on every push).
3. Fast-forward \`production\` to the tested commit.

## When a deploy fails
A failed build leaves the previous deploy serving. Fix forward on \`main\`.
`;
const DEPLOY_V2 = DEPLOY_V1.replace("## When a deploy fails", "## Rolling back\nFrontend: Cloudflare › Workers › sapling › Deployments › roll back. Backend: Railway › Deployments › the last good one › Redeploy.\n\n## When a deploy fails");
const DEPLOY_V3 = DEPLOY_V2 + "\n## Health\nEach app answers `/health`; Trov reads it every 10 minutes and shows it on Repo › Overview.\n";

const SR_V1 = `# Spaced repetition (SM-2)

Each card has an **ease** (start 2.5, never below 1.3) and an **interval** in days.

| Grade | Effect |
|---|---|
| 1 Again | interval → 1, ease −0.2 |
| 2 Hard | interval × 1.2, ease −0.15 |
| 3 Good | interval × ease |
| 4 Easy | interval × ease × 1.3, ease +0.15 |

The review queue shows cards due today first, then overdue ones (oldest first). New cards are capped per day (default 20).
`;
const SR_V2 = SR_V1 + "\n## Results\nDay-7 retention rose from 61% to 74% on decks older than a month (2,140 students). Day-30: 48% → 53%.\n";

const SUPPORT_V1 = `# Support playbook

## Where requests come from
Intercom (students and parents), e-mail from pilot-school teachers, and the in-app bug form.

## What we answer ourselves
- Streak questions — check the student's time zone first.
- Wrong-page citations — ask for the PDF; file it on #48.
- Grade questions — check the category weights before anything else.

## What becomes a ticket
Anything a second person reports, anything about grades, and anything about privacy (high priority, assign Andres).
`;
const SUPPORT_V2 = SUPPORT_V1 + "\n## Data deletion\nDeleting an account removes its uploads, embeddings and quiz history within 30 days (backups roll off after that).\n";
const SUPPORT_V3 = SUPPORT_V2.replace("Intercom (students and parents)", "Intercom (students and parents — the shared support inbox)");

const OFFLINE_V1 = `# Offline study mode

Students review today's cards without a connection; results sync when they're back online.

## Scope
- Today's due cards and their images, cached on the device (max 50 MB).
- Reviews recorded offline, synced later.
- iOS Safari and Android Chrome.

## Open questions
- IndexedDB or OPFS for card media (#45).
- What a student sees when a sync conflicts.
`;
const OFFLINE_V2 = OFFLINE_V1.replace("- What a student sees when a sync conflicts.", "- What a student sees when a sync conflicts: nothing, unless a card's interval changed — then a one-line note on the next review.");

const INCIDENT_V1 = `# Incident: Supabase pool exhausted (exam week)

**When** Monday of exam week, 09:05–09:16 (11 minutes).

**Impact** Study and quiz routes returned 503. No data lost; reviews submitted during the window were retried by the app.

**Why** OCR workers opened a database session per page. Two busy workers held 30 idle connections each, and the API's own pool needed the rest.

**What changed**
- The API uses Supabase's transaction pooler (port 6543).
- Each worker is capped at 8 connections; OCR shares a pool of 4.

**Follow-ups** An alert at 45 connections; the OCR health check (#69).
`;

export const DOCS = [
  { slug: "sapling-teacher-dashboard", section: "Product Specs", space: "product", title: "Teacher dashboard", owner: MEI,
    versions: [[1, "promoted", MEI, 19, "First spec for the beta", DASH_V1], [2, "promoted", PRIYA, 12, "Filters", DASH_V2, "edit"], [3, "promoted", MEI, 3, "Time zones and the needs-attention sort", DASH_V3, "edit"], [4, "staged", LUKE, 0.6, "Exports are in the beta after all", DASH_V4, "edit"]] },
  { slug: "sapling-gradebook-export", section: "Architecture", space: "technical", title: "Gradebook export", owner: JOSE,
    versions: [[1, "promoted", JOSE, 25, "How exports run", EXPORT_V1], [2, "promoted", JOSE, 11, "Progress endpoint", EXPORT_V2, "edit"], [3, "staged", JOSE, 2.8, "The export job replaces the long timeout", EXPORT_V3, "edit"]] },
  { slug: "sapling-deploys", section: "Operations", space: "technical", title: "Deploys and environments", owner: JACK,
    versions: [[1, "promoted", JACK, 34, "Staging and production", DEPLOY_V1], [2, "promoted", ME, 21, "Rolling back", DEPLOY_V2, "edit"], [3, "promoted", JACK, 8, "Health checks", DEPLOY_V3, "edit"]] },
  { slug: "sapling-spaced-repetition", section: "AI & Learning Engine", space: "technical", title: "Spaced repetition (SM-2)", owner: JOSE,
    versions: [[1, "promoted", JOSE, 42, "The scheduler", SR_V1], [2, "promoted", JOSE, 32, "Retention results", SR_V2, "edit"]] },
  { slug: "sapling-support-playbook", section: "Overview", space: "product", title: "Support playbook", owner: SANA,
    versions: [[1, "promoted", SANA, 28, "First version", SUPPORT_V1], [2, "promoted", ME, 14, "Data deletion answer", SUPPORT_V2, "edit"], [3, "rejected", SANA, 9, "Name the inbox", SUPPORT_V3, "edit"]] },
  { slug: "sapling-offline-mode", section: "Product Specs", space: "product", title: "Offline study mode", owner: MEI,
    versions: [[1, "promoted", MEI, 8, "Draft spec", OFFLINE_V1], [2, "staged", PRIYA, 1.3, "What a sync conflict looks like", OFFLINE_V2, "edit"]] },
  { slug: "sapling-incident-exam-week", section: "Operations", space: "technical", title: "Incident: Supabase pool exhausted (exam week)", owner: JACK,
    versions: [[1, "promoted", JACK, 16, "Write-up", INCIDENT_V1]] },
];
/** Sections the layer's docs need (docs.section → sections.name). */
export const SECTIONS = [["Product Specs", "What we're building and why, before and while we build it"], ["Operations", "Deploys, environments, incidents"]];

// ── the roadmap narrative (plan version 2) ──────────────────────────────────────────────────────────────────────────
export const NARRATIVE = `## Sapling this quarter

Sapling helps students learn from their own material: upload notes or a textbook, then study with the tutor, quizzes and flashcards that come back when you're about to forget them. This quarter we put it in front of teachers.

**Now** the **teacher dashboard beta** for the 12 pilot schools — mastery per topic, quiet students, a class code to join — and finishing the **gradebook export rework**, which is late: whole-school exports become a job.

**Next** **offline study mode**, so a bus ride doesn't cost a streak, and the tutor's citations pointing at the right page.

**Later** Google Classroom sync, Spanish, and a weekly progress e-mail for parents.`;

// ── the repository (Repo screen) ──────────────────────────────────────────────────────────────────────────────────
// Merged PRs over twelve weeks: [number, author login, days ago, title, what, why, impact, importance?]
export const PRS_MERGED = [
  [206, JOSE, 80, "Quiz generator: Pydantic AI agent with typed output", "The quiz generator returns typed questions through a Pydantic AI agent.", "Free-text parsing failed on ~4% of quizzes.", "Fewer broken quizzes; one schema for all question types."],
  [207, LUKE, 77, "Study screen: card stack with swipe gestures", "Cards can be swiped left/right on touch screens.", "Students on phones asked for it.", "Faster reviews on mobile."],
  [208, JACK, 74, "CI: run the e2e suite on every push to main", "Playwright runs against staging after each deploy.", "Regressions reached production twice.", "A failing e2e run blocks the production fast-forward."],
  [209, JOSE, 70, "RAG: re-rank retrieved chunks with a cross-encoder", "Retrieved chunks are re-ranked before the tutor answers.", "Answers cited loosely related pages.", "Better citations; +80 ms per answer."],
  [210, ME, 66, "Auth: Google sign-in for teachers", "Teachers sign in with their school Google account.", "Pilot schools use Google Workspace.", "No new passwords for teachers."],
  [211, LUKE, 63, "Streak widget on the home screen", "The streak and today's goal show on the home screen.", "Students forgot their streak until they lost it.", "Daily active students up in the first week."],
  [212, JOSE, 59, "Uploads: chunk PDFs by heading, not by page", "PDF text is split at headings before embedding.", "Page splits cut explanations in half.", "More complete tutor answers."],
  [213, JACK, 56, "Observability: request ids across frontend and API", "Every request carries an id from the browser to the API logs.", "Debugging a student report took hours.", "One id finds a request's whole path."],
  [214, JOSE, 40, "Spaced repetition: SM-2 scheduler", "Cards are scheduled with SM-2 and a per-card ease.", "The old fixed intervals felt random.", "Day-7 retention 61% → 74%."],
  [215, JOSE, 42, "Review: empty deck returns 204, not 500", "`/api/review/next` handles an empty deck.", "A 500 for new students with no cards.", "The empty state shows instead of an error."],
  [216, LUKE, 39, "Flashcards: animate a transform, not box-shadow", "The flip animates a transform over a pre-rendered shadow.", "12 fps on low-end Android.", "60 fps on a Moto E."],
  [217, LUKE, 36, "Review queue: today's cards before overdue", "The queue orders today's due cards first.", "Overdue piles buried today's cards.", "Students finish today's reviews more often."],
  [219, JOSE, 30, "Backfill ease factors from review history", "Existing cards get an ease from their history.", "Long-time users would have started over.", "No reset for existing decks."],
  [221, LUKE, 33, "Study settings: daily cap on new cards", "Students choose 5–100 new cards per day.", "Too many new cards overwhelmed beginners.", "Default 20; adjustable."],
  [222, JACK, 31, "k6 load test for the review endpoint", "A k6 script runs 200 rps against staging.", "Exam season traffic.", "Baseline: p95 140 ms."],
  [224, JOSE, 28, "Analytics: retention curve per deck", "Deck pages show retention after 1, 3, 7 and 30 days.", "To judge SM-2 against the old scheduler.", "The SM-2 win is measurable."],
  [229, JACK, 26, "OCR on the worker queue", "OCR runs in a background worker, pages in parallel.", "Large uploads timed out.", "200 pages in about 70 s."],
  [230, JOSE, 27, "Gradebook: stream single-class CSV exports", "Rows stream as they're read.", "Exports ran out of memory.", "Constant memory for any class size."],
  [233, LUKE, 23, "Lazy-load the PDF viewer", "pdf.js loads on first use.", "It was in the main bundle.", "−180 KB on first load."],
  [234, ME, 21, "Parent view: key the cache by child", "The client caches per child, not per parent.", "A parent saw a sibling's progress.", "Each child's data stays under their own tab."],
  [235, LUKE, 20, "Gradebook export: UTF-8 BOM for Excel", "CSV files start with a BOM.", "Excel garbled accented names.", "Names read correctly in Excel."],
  [236, JOSE, 24, "Gradebook: weight categories before rounding", "Rounding happens once, at the end.", "Grades were off by 0.01.", "Correct final grades."],
  [238, JOSE, 19, "Tutor: 20 questions a minute per student", "A per-student rate limit with a friendly message.", "A scripted student sent 3,000 questions.", "Predictable cost."],
  [239, LUKE, 19, "Quiz submit is idempotent", "A second submit returns the first attempt.", "Double-clicks recorded two attempts.", "No zero-score duplicates."],
  [241, JACK, 17, "API: Supabase transaction pooler", "The API connects through the transaction pooler.", "The pool ran out on exam Monday.", "Headroom for 3× the connections."],
  [242, LUKE, 15, "Gradebook: export button visible on mobile", "The export action is a button, not in the overflow menu.", "Teachers couldn't find it.", "Exports from phones."],
  [243, JOSE, 10, "Row-level security for teacher reads", "Postgres policies limit teachers to their classes.", "Defence in depth for student data.", "An API bug can't leak another class."],
  [244, JOSE, 11, "Gemini client: cap retries at 2", "429s are retried at most twice, with backoff.", "A retry loop tripled a day's spend.", "Bounded cost under rate limits."],
  [245, JOSE, 8, "Mastery API", "`GET /api/classes/:id/mastery`.", "The teacher dashboard needs scores.", "Under 200 ms for 150 students."],
  [247, LUKE, 6, "Teacher dashboard: empty state", "A new class explains what will appear.", "An empty grid confused teachers.", "Teachers invite students right away."],
  [248, PRIYA, 9, "Design tokens: dashboard colour scale", "A 5-step mastery scale that works in both themes.", "The old scale failed contrast in dark mode.", "Readable mastery colours."],
  [249, JOSE, 5, "Index review_events (student_id, due_at)", "A composite index for queue and mastery reads.", "Sequential scans on large classes.", "1.1 s → 90 ms."],
  [251, JACK, 3, "OCR worker /health", "Queue depth and the oldest job's age.", "Stuck jobs went unnoticed.", "An alert above 10 minutes."],
  [253, ME, 4, "Class codes: global and 8 characters", "Codes are unique across schools.", "Codes collided across schools.", "Teachers land in the right class."],
  [256, OMAR, 2, "e2e: quiz timer spec uses a fake clock", "The timer spec no longer depends on real time.", "1 in 10 CI runs failed.", "A stable suite."],
  [257, LUKE, 0.3, "Dashboard: needs-attention sort", "Students below 50% or quiet sort first.", "Teachers asked for it in the pilot.", "The students who need help are at the top."],
];
/** Open PRs: [number, author, days opened, state ('review' | 'draft' | 'open' | 'changes'), title, branch]. */
export const PRS_OPEN = [
  [250, JOSE, 4, "review", "Tutor: stream before re-ranking finishes", "feat/early-stream"],
  [252, LUKE, 3, "review", "Teacher dashboard: quiet-students flag", "feat/quiet-students"],
  [254, ME, 3, "changes", "Roster import from CSV", "feat/roster-import"],
  [255, ME, 1.2, "review", "Class codes: e-mail-domain fallback", "fix/class-code-collisions"],
  [258, JOSE, 2.9, "review", "Gradebook export job", "feat/export-jobs"],
  [259, LUKE, 1, "draft", "Offline: service worker for the study shell", "spike/offline-sw"],
  [260, JACK, 0.6, "open", "Alert at 45 Supabase connections", "ops/pool-alert"],
];
/** Releases (tags on production). [tag, days ago, author, notes]. */
export const RELEASES = [
  ["v2.14.0", 52, JACK, "Request ids end to end; streak widget."],
  ["v2.15.0", 38, JACK, "SM-2 scheduling; faster flashcards on Android."],
  ["v2.16.0", 24, JACK, "OCR on the worker queue; lazy PDF viewer; gradebook fixes."],
  ["v2.16.1", 21, ME, "Parent view fix."],
  ["v2.17.0", 9, JACK, "Row-level security for teachers; mastery API; rate limit on the tutor."],
  ["v2.18.0", 1, JACK, "Teacher dashboard beta (flagged); global class codes; review_events index."],
];
