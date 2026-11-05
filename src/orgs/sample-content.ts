// The CONTENT of the Sample workspace (src/orgs/sample.ts; organizations.md › 1e): a small, made-up team building
// Habitloop, a habit-tracking app — NOT Trov. Pure data, no I/O: every time is RELATIVE (`days` ago; negative = in the
// future), stamped against the clock when the workspace is created, so a fresh one always reads current. Everything is
// authored by the person the workspace is for (there are no made-up persons: tickets, memberships and the rest
// reference `persons(handle)`), so sample.ts writes their handle wherever an author goes. Tags are the six STARTERS only.

export const SAMPLE_REPO = "habitloop-example/habitloop";
export const SAMPLE_ORG_NAME = "Sample workspace";

// ── docs ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Five pages over the three starter spaces. `[[slug]]` links are written to `doc_links` as a promote would. Each
// version is promoted (live); the architecture page has a second version in its history.
export interface SampleDoc {
  slug: string; space: "engineering" | "product" | "design"; section: "reference" | "context";
  title: string; tags: string[];
  /** Oldest first; the last is live. [days ago, summary, body]. */
  versions: Array<[number, string, string]>;
}

export const DOCS: SampleDoc[] = [
  {
    slug: "habitloop-architecture", space: "engineering", section: "reference", title: "Architecture overview", tags: ["architecture"],
    versions: [
      [24, "First outline", `# Architecture overview

Habitloop is a mobile app (React Native) with a small API (Node, Postgres).

- The app keeps every habit and check-in in SQLite on the device.
- The API stores the same data per account and serves the web dashboard.
`],
      [6, "Add sync and the reminder service", `# Architecture overview

Habitloop is a mobile app (React Native) with a small API (Node, Postgres) and one background worker.

## Pieces

- **App** — every habit and check-in lives in SQLite on the device first, so the app works offline.
- **API** — the account's copy in Postgres, the web dashboard's reads, sign-in (see the auth decision).
- **Worker** — sends reminders at each person's local time; see [[habitloop-reminders]].

## Data flow

A check-in is written on the device, then pushed by the sync loop described in [[habitloop-sync-protocol]].
The server never rewrites a check-in; it only merges.

## Environments

\`staging\` deploys every merge to main; \`production\` is promoted from staging by hand.
`],
    ],
  },
  {
    slug: "habitloop-sync-protocol", space: "engineering", section: "reference", title: "Offline sync protocol", tags: ["api", "data"],
    versions: [[13, "Document the sync loop", `# Offline sync protocol

Each device keeps an outbox of changes and a \`last_synced\` cursor.

1. Push: send the outbox in order; the server answers with the accepted ids.
2. Pull: ask for everything changed since \`last_synced\`.
3. Merge: a check-in is keyed by (habit, local day), so two devices checking in on the same day merge into one.

Conflicts on a habit's settings go to the newest edit. Deletes are tombstones kept for 30 days.

See [[habitloop-architecture]] for where this fits.
`]],
  },
  {
    slug: "habitloop-streaks", space: "product", section: "context", title: "How streaks work", tags: ["data"],
    versions: [[18, "Write down the streak rules", `# How streaks work

A streak is the number of consecutive scheduled days a habit was checked in.

- Days a habit is not scheduled (a weekdays-only habit on Saturday) neither count nor break it.
- A day is the person's **local** day — see the decision on local days.
- One **freeze** a week keeps a streak alive over a missed day. Freezes don't stack.

When a streak is about to break, the evening reminder says so ([[habitloop-reminders]]).
`]],
  },
  {
    slug: "habitloop-reminders", space: "product", section: "context", title: "Reminder notifications", tags: ["ui"],
    versions: [[9, "Reminder rules for the widgets sprint", `# Reminder notifications

- Each habit can have one reminder time, in the person's time zone.
- At most three reminders an hour; the rest are folded into one ("3 habits left today").
- An evening nudge at 20:00 only when a streak would break tonight.
- Quiet hours (22:00–07:00 by default) are never crossed.

Open questions: should the widget count as a reminder? Tracked in the current sprint.
`]],
  },
  {
    slug: "habitloop-design-system", space: "design", section: "reference", title: "Design system basics", tags: ["ui"],
    versions: [[15, "Colours, type and the check-in button", `# Design system basics

- **Type** — one family, two weights. Habit names are 17pt semibold.
- **Colour** — each habit picks one of eight colours; the check-in ring uses it at full strength, the card at 12%.
- **Check-in button** — the whole card is the target; a long press opens the day's note.
- **Motion** — the ring fills over 300ms; nothing moves when Reduce Motion is on.
`]],
  },
];

// ── decisions (ADRs) ─────────────────────────────────────────────────────────────────────────────────────────────
// [title, status, days ago, context, decision, rationale]
export const ADRS: Array<[string, "ratified" | "draft", number, string, string, string]> = [
  ["Sign in with passkeys and email magic links — no passwords", "ratified", 26,
    "Password resets were a third of support mail in the beta, and most people sign in on one phone.",
    "Accounts sign in with a passkey on the device, or a one-time email link as the fallback. There are no passwords. Sessions last 90 days and are revoked from Settings › Devices.",
    "Passkeys remove resets and phishing; the email link covers new devices and older phones. Two paths instead of three keeps the auth code small."],
  ["Keep check-ins in SQLite on the device first", "ratified", 21,
    "People check in on the subway and on flights; a spinner on the check-in button loses them.",
    "The device is the first writer: every check-in goes to local SQLite and syncs later through the outbox.",
    "Offline is the normal case for this app, not the edge case. The server merges; it never blocks a check-in."],
  ["A streak day is the person's local calendar day", "draft", 3,
    "Travellers saw streaks break when they crossed time zones, because days were counted in UTC.",
    "Count a check-in toward the local day of the device that recorded it, and store that day alongside the timestamp.",
    "It matches what people expect when they look at the calendar. Open: what happens when someone flies east past midnight."],
];

// ── sprints ──────────────────────────────────────────────────────────────────────────────────────────────────────
// start / due are days FROM now (negative = past). One done, one in progress (the active one).
export const SPRINTS = [
  { key: "streaks", title: "Streaks v2", status: "done" as const, start: -30, due: -16, urgency: "normal" as const,
    summary: "Streaks that survive a missed day and a time-zone change.",
    description: "Weekly freezes, local-day counting and the streak history screen." },
  { key: "reminders", title: "Reminders & widgets", status: "in_progress" as const, start: -9, due: 5, urgency: "high" as const,
    summary: "Reminders people don't swipe away, and a home-screen widget.",
    description: "Per-habit reminder times, the evening streak nudge, quiet hours, and the iOS and Android widgets." },
];

// ── tickets ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Every ticket is assigned to the person, so the lane-scoped MCP writes work on all of them.
// moves: [status, days ago] — the first is the opening (submitted).
export interface SampleTicket {
  n: number; title: string; category: "bug" | "request" | "question" | "access" | "other"; priority: "low" | "normal" | "high";
  sprint: "streaks" | "reminders" | null; parent?: number;
  moves: Array<[string, number]>; body: string;
  comments?: Array<[number, string]>;
}

export const TICKETS: SampleTicket[] = [
  // Streaks v2 (done)
  { n: 1, title: "Weekly streak freeze", category: "request", priority: "high", sprint: "streaks",
    moves: [["submitted", 31], ["in_progress", 28], ["done", 19]],
    body: "Let one missed day a week keep a streak alive. Freezes don't stack; the history shows a frozen day differently." },
  { n: 2, title: "Streak breaks after crossing time zones", category: "bug", priority: "high", sprint: "streaks",
    moves: [["submitted", 27], ["in_progress", 25], ["testing", 20], ["done", 17]],
    body: "A check-in at 23:30 in New York counts as tomorrow in UTC. Count the device's local day instead.",
    comments: [[24, "Reproduced on staging by moving the simulator to Tokyo. Fix is to store the local day with each check-in."]] },
  { n: 3, title: "Streak history screen", category: "request", priority: "normal", sprint: "streaks",
    moves: [["submitted", 29], ["in_progress", 22], ["done", 16]],
    body: "A month calendar per habit: checked, frozen and missed days." },
  // Reminders & widgets (active)
  { n: 4, title: "Per-habit reminder time", category: "request", priority: "high", sprint: "reminders",
    moves: [["submitted", 9], ["in_progress", 8], ["testing", 2]],
    body: "Each habit can have one reminder time in the person's time zone. Fold more than three an hour into one notification.",
    comments: [[2, "On staging now. Needs a pass on Android 14's exact-alarm permission before it ships."]] },
  { n: 5, title: "Evening nudge when a streak would break", category: "request", priority: "normal", sprint: "reminders",
    moves: [["submitted", 9], ["in_progress", 4]],
    body: "At 20:00 local, if a scheduled habit has no check-in and its streak is above three days, send one nudge." },
  { n: 6, title: "Quiet hours setting", category: "request", priority: "normal", sprint: "reminders",
    moves: [["submitted", 8]],
    body: "Default 22:00–07:00. Nothing is sent inside quiet hours; a reminder due then is dropped, not delayed." },
  { n: 7, title: "iOS home-screen widget", category: "request", priority: "high", sprint: "reminders",
    moves: [["submitted", 8], ["in_progress", 5]],
    body: "A small and a medium widget showing today's habits; tapping one checks it in without opening the app." },
  { n: 8, title: "Widget: refresh after a check-in from the app", category: "bug", priority: "normal", sprint: "reminders", parent: 7,
    moves: [["submitted", 3], ["in_progress", 1]],
    body: "The widget keeps showing the habit as open until the next timeline refresh. Reload the timeline after every check-in." },
  { n: 9, title: "Android widget", category: "request", priority: "normal", sprint: "reminders",
    moves: [["submitted", 8]],
    body: "The same as the iOS widget, with Glance. Start once the iOS one is in testing." },
  { n: 10, title: "Reminder fires twice after changing its time", category: "bug", priority: "high", sprint: "reminders",
    moves: [["submitted", 2], ["in_progress", 1]],
    body: "Changing a reminder from 08:00 to 08:30 leaves the 08:00 one scheduled. Cancel the old notification before scheduling the new one.",
    comments: [[1, "Happens only when the app was killed between the two edits — the cancel runs on the next launch, too late."]] },
  { n: 11, title: "Should the widget count as a reminder?", category: "question", priority: "low", sprint: "reminders",
    moves: [["submitted", 6], ["declined", 4]],
    body: "If someone has the widget on their home screen, do we still send the habit's reminder?" },
  { n: 12, title: "Export my check-ins as CSV", category: "request", priority: "low", sprint: null,
    moves: [["submitted", 5]],
    body: "Settings › Data › Export: every habit and check-in, one row per check-in." },
];

// ── feed ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// What agents recorded over the last two weeks: [days ago, summary, body, tags, importance].
export const FEED: Array<[number, string, string, string[], "notable" | "breaking" | null]> = [
  [13, "Documented the offline sync protocol",
    "Wrote the push / pull / merge loop down as a reference page. A check-in is keyed by (habit, local day), so duplicates from two devices merge.", ["api", "data"], null],
  [11, "Streak time-zone bug: root cause was UTC day counting",
    "Check-ins after 20:00 in the Americas landed on the next UTC day. Fixed by storing the device's local day with each check-in; backfilled from the stored offset.", ["data"], "notable"],
  [9, "Started the Reminders & widgets sprint",
    "Scope: per-habit reminder times, the evening nudge, quiet hours, and the iOS and Android widgets. iOS widget first.", ["ui"], null],
  [6, "Architecture page now covers the reminder worker",
    "Added the worker and the sync loop to the architecture overview, with links to the sync and reminder pages.", ["architecture", "infra"], null],
  [4, "Reminder scheduling moved to the device",
    "Local notifications are scheduled on the device from the reminder times; the server only sends the evening nudge. Saves a push round-trip and works offline.", ["infra", "ui"], "notable"],
  [2, "Per-habit reminders are on staging",
    "Staging build has per-habit reminder times. Android 14 needs the exact-alarm permission prompt before it can ship.", ["ui"], null],
  [1, "Found the double-reminder bug",
    "Changing a reminder's time while the app is killed leaves the old notification scheduled. Cancel-then-schedule has to happen in the same launch.", ["ui"], "notable"],
];

// ── handoff ──────────────────────────────────────────────────────────────────────────────────────────────────────
export const HANDOFF = {
  hoursAgo: 3,
  body: `Finish the double-reminder fix (#10)

The cancel of the old notification runs one launch too late when the app was killed between two edits. I moved the cancel into the same transaction as the schedule on iOS; Android still schedules first.`,
  context: {
    repo: SAMPLE_REPO, branch: "fix/double-reminder", task: "Fix the reminder that fires twice after its time changes (#10)",
    done: ["Reproduced on both platforms", "iOS: cancel and schedule in one step"],
    next: ["Android: cancel before scheduling in ReminderScheduler", "Add a test that kills the app between two edits", "Move #10 to testing"],
    files: ["app/reminders/scheduler.ts", "android/app/src/main/java/com/habitloop/ReminderScheduler.kt"],
  },
};

// ── prompts ──────────────────────────────────────────────────────────────────────────────────────────────────────
export const PROMPTS = [
  { slug: "review-a-migration", title: "Review a database migration", description: "What to check before a migration on the habits database ships.",
    tags: ["data"], days: 12,
    body: `Review the migration in this branch before it ships.

- Does it run on a database with a year of check-ins in under a minute?
- Is every new column nullable or defaulted, so the old app version keeps working?
- Is there a rollback, and does it lose data?
- Does the sync protocol still merge rows written before and after it?

Answer with a short list: what blocks the merge, what is worth a follow-up.` },
  { slug: "write-release-notes", title: "Write release notes", description: "Short store release notes from the merged pull requests.",
    tags: ["ui"], days: 7,
    body: `Write release notes for Habitloop {{version}} for the {{store}}.

Read the pull requests merged since {{previous_version}}. Keep it under 80 words, in plain words a person checking
in on their phone would care about. Lead with the biggest change; leave out refactors and CI changes.` },
];

// ── the roadmap ──────────────────────────────────────────────────────────────────────────────────────────────────
/** The narrative's three parts (shared/sprints-core.ts `composePlanNarrative` stores them, as `update_plan` does). */
export const NARRATIVE = {
  now: "Reminders & widgets: per-habit reminder times, the evening streak nudge, quiet hours, then the iOS and Android home-screen widgets.",
  next: "Sharing: share a streak with a friend, and an accountability partner who sees your week.",
  later: "Paid plans and a watch app, once people come back every day without being reminded. Not a social feed.",
};

// ── the repository (the Repo dashboard reads stored rows only) ──────────────────────────────────────────────────
/** Environments: [key, label, branch, web url, note]. */
export const ENVIRONMENTS: Array<[string, string, string, string, string]> = [
  ["staging", "Staging", "main", "https://staging.habitloop.example.com", "Every merge to main"],
  ["production", "Production", "production", "https://app.habitloop.example.com", "Promoted from staging by hand"],
];

/** Merged pull requests: [number, author login, days ago, title]. */
export const PRS_MERGED: Array<[number, string, number, string]> = [
  [41, "habitloop-dev", 6.2, "Architecture: reminder worker"],
  [42, "habitloop-dev", 4.1, "Schedule reminders on the device"],
  [43, "habitloop-dev", 2.3, "Per-habit reminder time"],
  [45, "habitloop-dev", 0.8, "Widget: reload timeline after check-in"],
];
/** Open pull requests: [number, author login, days ago, title, branch, draft]. */
export const PRS_OPEN: Array<[number, string, number, string, string, boolean]> = [
  [46, "habitloop-dev", 1.1, "Fix double reminder after a time change", "fix/double-reminder", false],
  [47, "habitloop-dev", 0.4, "iOS widget: medium size", "feat/ios-widget-medium", true],
];

/** Deploys: [env, days ago, state, PR number it shipped, reason]. Newest last. */
export const DEPLOYS: Array<[string, number, "ready" | "error", number, string | null]> = [
  ["production", 6.0, "ready", 41, null],
  ["staging", 4.0, "ready", 42, null],
  ["staging", 2.2, "error", 43, "Build failed: TypeScript found 1 error"],
  ["staging", 2.1, "ready", 43, null],
  ["production", 1.9, "ready", 43, null],
  ["staging", 0.7, "ready", 45, null],
];

/** CI runs over the past week: [days ago, workflow, state, failed job]. */
export const RUNS: Array<[number, string, "success" | "failure" | "cancelled", string | null]> = [
  [6.3, "CI", "success", null], [6.1, "CI", "success", null], [5.0, "e2e", "success", null], [4.2, "CI", "success", null],
  [3.0, "e2e", "failure", "e2e (ios)"], [2.4, "CI", "failure", "typecheck"], [2.2, "CI", "success", null],
  [1.2, "CI", "success", null], [0.9, "e2e", "cancelled", null], [0.5, "CI", "success", null],
];
