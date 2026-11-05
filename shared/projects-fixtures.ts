// Projects — fixtures, one per state the screen draws (docs/superpowers/specs/2026-11-05-projects.md › The screen ›
// States): the four SaplingLearn projects of the Claude Design canvas "Trov Projects" plus an archived one, an empty
// project, Free at the project cap (as its owner and as a member), a viewer, a hidden pin, an archived project. Typed
// with the contract (shared/projects-core.ts) so a change there breaks them; the web render tests
// (test/render.projects*.test.ts) draw every screen from them. Zod-free and value-only: nothing in the app imports it.

import type { ProjectArtifact, ProjectDetail, ProjectList, ProjectMember, ProjectPin, ProjectSummary } from "./projects-core";
import type { AskThreadSummary, RefView } from "./ai-ask-core";

/** "Now" for every fixture: the canvas's evening of Nov 5, 2026. */
export const PROJECT_FIXTURE_NOW = "2026-11-05T22:30:00Z";

/** The people the fixtures name (the dev seed's SaplingLearn). */
export const PROJECT_FIXTURE_PEOPLE = [
  { handle: "AndresL230", name: "Andres", color: "moss", avatar_url: null, role: null },
  { handle: "Jose-Gael-Cruz-Lopez", name: "Jose", color: "sky", avatar_url: null, role: null },
  { handle: "jack-he", name: "Jack", color: "plum", avatar_url: null, role: null },
  { handle: "meilin", name: "Meilin Zhao", color: "rose", avatar_url: null, role: null },
  { handle: "luke-cooper", name: "Luke", color: "fern", avatar_url: null, role: null },
] as const;

const summary = (over: Partial<ProjectSummary> & Pick<ProjectSummary, "slug" | "name">): ProjectSummary => ({
  description: "", icon: "server", color: "#525cc3", visibility: "members", owner: "AndresL230", access: "owner",
  people: ["AndresL230"], memberCount: 1, chats: 0, pins: 0, artifacts: 0, updatedAt: PROJECT_FIXTURE_NOW, archivedAt: null, archivedBy: null,
  ...over,
});

export const PROJECT_HOSTING = summary({
  slug: "hosting-providers", name: "Hosting providers", icon: "server", color: "#525cc3", visibility: "members",
  description: "Vercel, Render, Netlify and Fly.io behind one interface, and the Railway failures in the way of shipping it.",
  owner: "AndresL230", access: "owner", people: ["AndresL230", "Jose-Gael-Cruz-Lopez", "jack-he"], memberCount: 3,
  chats: 4, pins: 9, artifacts: 2, updatedAt: "2026-11-05T22:25:00Z",
});
export const PROJECT_PILOT = summary({
  slug: "teacher-dashboard-pilot", name: "Teacher dashboard pilot", icon: "chart", color: "#a84a68", visibility: "org",
  description: "Feedback from the 12 pilot schools and what changes before the spring rollout.",
  owner: "meilin", access: "editor", people: ["meilin", "AndresL230", "luke-cooper"], memberCount: 3,
  chats: 2, pins: 2, artifacts: 1, updatedAt: "2026-11-01T18:00:00Z",
});
export const PROJECT_GRADEBOOK = summary({
  slug: "gradebook-export-rework", name: "Gradebook export rework", icon: "book", color: "#2f7d57", visibility: "members",
  description: "Whole-school exports: the job queue, progress, and the export that comes back empty.",
  owner: "Jose-Gael-Cruz-Lopez", access: "editor", people: ["Jose-Gael-Cruz-Lopez", "AndresL230"], memberCount: 2,
  chats: 1, pins: 2, artifacts: 1, updatedAt: "2026-10-23T15:00:00Z",
});
export const PROJECT_INCIDENT = summary({
  slug: "exam-week-incident", name: "Exam week incident", icon: "shield", color: "#b4562c", visibility: "private",
  description: "What happened with the Supabase pool during exam week, and the follow-ups.",
  owner: "AndresL230", access: "owner", people: ["AndresL230"], memberCount: 1,
  chats: 1, pins: 1, artifacts: 1, updatedAt: "2026-10-18T11:00:00Z",
});
export const PROJECT_STREAK = summary({
  slug: "streak-features", name: "Streak features", icon: "rocket", color: "#966800", visibility: "members",
  description: "Daily streaks and the reminders that go with them.",
  owner: "luke-cooper", access: "editor", people: ["luke-cooper", "AndresL230"], memberCount: 2,
  chats: 3, pins: 5, artifacts: 0, updatedAt: "2026-10-12T10:00:00Z", archivedAt: "2026-10-12T10:00:00Z", archivedBy: "luke-cooper",
});

/** The list as Andres reads it on Pro: four live projects, one archived, no cap. */
export const PROJECT_LIST: ProjectList = {
  projects: [PROJECT_HOSTING, PROJECT_PILOT, PROJECT_GRADEBOOK, PROJECT_INCIDENT],
  archived: [PROJECT_STREAK],
  limit: { used: 4, cap: null },
};
/** An organization with no project yet. */
export const PROJECT_LIST_EMPTY: ProjectList = { projects: [], archived: [], limit: { used: 0, cap: 2 } };
/** Free at the project cap: two live projects of two. */
export const PROJECT_LIST_FREE_CAP: ProjectList = {
  projects: [PROJECT_HOSTING, { ...PROJECT_GRADEBOOK }],
  archived: [],
  limit: { used: 2, cap: 2 },
};

// ── one project's page ──

const view = (ref: string, over: Partial<RefView> & Pick<RefView, "type" | "title">): RefView =>
  ({ ref, status: null, href: null, extra: {}, ...over });
const pin = (v: RefView | { ref: string; hidden: true }, at = "2026-11-04T10:00:00Z", by = "AndresL230"): ProjectPin =>
  ({ ref: v.ref, view: v, addedBy: by, addedAt: at });

export const PIN_SPRINT_HOSTING = pin(view("sprint:12", { type: "sprint", title: "Hosting", status: { mark: "half", tone: "accent", word: "Active", tip: "In progress: Nov 2 – 14." }, href: "#sprints/12", extra: { start: "2026-11-02", due: "2026-11-14", progress: { done: 6, total: 9 } } }));
export const PIN_TICKET_87 = pin(view("ticket:87", { type: "ticket", num: 87, title: "Production backend deploy fails on Railway", status: { mark: "half", tone: "accent", word: "In progress", tip: "Someone is working on it." }, href: "#tickets/87", owner: "Jose-Gael-Cruz-Lopez" }));
export const PIN_TICKET_89 = pin(view("ticket:89", { type: "ticket", num: 89, title: "Fly.io: one part per region", status: { mark: "most", tone: "amber", word: "Testing", tip: "Built; being checked." }, href: "#tickets/89" }));
export const PIN_TICKET_88 = pin(view("ticket:88", { type: "ticket", num: 88, title: "Render: poll deploys every 10 minutes", status: { mark: "todo", tone: "muted", word: "Triage", tip: "Waiting to be picked up." }, href: "#tickets/88" }));
export const PIN_TICKET_84 = pin(view("ticket:84", { type: "ticket", num: 84, title: "Connect hosting providers", status: { mark: "done", tone: "accent", word: "Done", tip: "Finished." }, href: "#tickets/84" }));
export const PIN_PR_185 = pin(view("pr:185", { type: "pr", num: 185, title: "Hosting providers behind one interface", status: { mark: "check", tone: "accent", word: "Merged", tip: "Merged into main." }, href: "https://github.com/SaplingLearn/sapling/pull/185" }));
export const PIN_DOC_DEPLOYS = pin(view("doc:deploys", { type: "doc", title: "Deploys and environments", status: null, href: "#doc/deploys" }));
export const PIN_REPO = pin(view("repo:SaplingLearn/sapling", { type: "repo", title: "SaplingLearn/sapling", status: null, href: "#repo", extra: { facts: null } }));
export const PIN_FILE_LOG = pin(view("artifact:railway-build-log", { type: "artifact", title: "railway-build-log.png", status: { mark: "dot", tone: "muted", word: "Private", tip: "Only you can see it." }, href: "#artifacts/railway-build-log", extra: { kind: "image", visibility: "private", version: 1, status: "draft" } }));
/** A pin the reader can't see: drawn as "An item you don't have access to", left out of answers. */
export const PIN_HIDDEN: ProjectPin = pin({ ref: "doc:security-review", hidden: true }, "2026-11-03T09:00:00Z", "jack-he");

const thread = (id: number, title: string, at: string, over: Partial<AskThreadSummary> = {}): AskThreadSummary => ({
  id, title, pinned: false, mode: "smart", auto: false, origin: "page", contextRef: null, hasDraft: false, group: "today",
  createdAt: at, updatedAt: at, project: { slug: "hosting-providers", name: "Hosting providers", icon: "server", color: "#525cc3" }, ...over,
});
export const HOSTING_CHATS: AskThreadSummary[] = [
  thread(301, "Where hosting stands this week", "2026-11-05T22:20:00Z", { pinned: true, group: "pinned" }),
  thread(302, "What changed in PR #185", "2026-11-05T21:26:00Z"),
  thread(303, "Why the Production backend deploy failed", "2026-11-05T20:41:00Z"),
  thread(290, "File the hosting review follow-ups", "2026-11-01T12:00:00Z", { group: "week", viewer: true, owner: "Jose-Gael-Cruz-Lopez", direct: false, access: "read", shared: true }),
];

const art = (slug: string, title: string, over: Partial<ProjectArtifact> = {}): ProjectArtifact => ({
  slug, title, kind: "markdown", visibility: "private", author: "AndresL230", updatedAt: "2026-11-05T22:25:00Z", threadId: null, preview: null, ...over,
});
export const HOSTING_ARTIFACTS: ProjectArtifact[] = [
  art("where-hosting-stands-nov-5", "Where hosting stands this week, Nov 5", { threadId: 301, preview: "Hosting is mostly built: PR 185 put Vercel, Render, Netlify and Fly.io behind one interface.\nWhat holds the sprint back is narrow." }),
  art("railway-build-log", "railway-build-log.png", { kind: "image", updatedAt: "2026-11-05T20:30:00Z", preview: null }),
];

const members = (...m: [string, ProjectMember["role"]][]): ProjectMember[] => m.map(([handle, role]) => ({ handle, role, addedAt: role === "owner" ? null : "2026-10-30T10:00:00Z" }));

export const HOSTING_INSTRUCTIONS = "Hosting is mostly built. Focus on what blocks the Hosting sprint.\nPrefer Deploys and environments over old chats.\nFile new tickets in the Hosting sprint and assign them to @jose unless I say otherwise.";

/** Hosting providers as its owner reads it: every pin type, a hidden pin, chats (one shared), two artifacts. */
export const HOSTING_DETAIL: ProjectDetail = {
  project: { ...PROJECT_HOSTING, pins: 10, instructions: HOSTING_INSTRUCTIONS },
  members: members(["AndresL230", "owner"], ["Jose-Gael-Cruz-Lopez", "editor"], ["jack-he", "viewer"]),
  pins: [PIN_SPRINT_HOSTING, PIN_TICKET_87, PIN_TICKET_89, PIN_TICKET_88, PIN_TICKET_84, PIN_PR_185, PIN_DOC_DEPLOYS, PIN_REPO, PIN_FILE_LOG, PIN_HIDDEN],
  chats: HOSTING_CHATS,
  artifacts: HOSTING_ARTIFACTS,
  pinLimit: { used: 10, cap: 200 },
};

/** A project just made: no chats, no pins, no artifacts, no instructions. */
export const EMPTY_DETAIL: ProjectDetail = {
  project: { ...summary({ slug: "spring-rollout", name: "Spring rollout", icon: "rocket", color: "#2467af", visibility: "members" }), instructions: "" },
  members: members(["AndresL230", "owner"]),
  pins: [], chats: [], artifacts: [],
  pinLimit: { used: 0, cap: 20 },
};

/** Teacher dashboard pilot as a VIEWER reads it (an org project, someone else's). */
export const VIEWER_DETAIL: ProjectDetail = {
  project: { ...PROJECT_PILOT, access: "viewer", instructions: "Answer briefly. Link the ticket or doc you used." },
  members: members(["meilin", "owner"], ["luke-cooper", "editor"]),
  pins: [
    pin(view("doc:teacher-dashboard", { type: "doc", title: "Teacher dashboard", status: { mark: "ring", tone: "amber", word: "Change pending review", tip: "A change waits in Review." }, href: "#doc/teacher-dashboard" }), "2026-10-31T10:00:00Z", "meilin"),
    pin(view("ticket:20", { type: "ticket", num: 20, title: "Flag students who haven’t studied in 7 days", status: { mark: "most", tone: "amber", word: "Testing", tip: "Built; being checked." }, href: "#tickets/20" }), "2026-10-31T10:00:00Z", "meilin"),
  ],
  chats: [thread(280, "What did teachers ask for most?", "2026-10-31T16:00:00Z", { group: "earlier", viewer: true, owner: "meilin", direct: false, access: "read", shared: true, project: { slug: "teacher-dashboard-pilot", name: "Teacher dashboard pilot", icon: "chart", color: "#a84a68" } })],
  artifacts: [art("pilot-feedback-week-2", "Teacher dashboard: pilot feedback, week 2", { kind: "ui", visibility: "org", author: "meilin", updatedAt: "2026-11-01T18:00:00Z", preview: "What worked\nThe topic grid: teachers finally see which topic the whole class is stuck on." })],
  pinLimit: { used: 2, cap: 200 },
};

/** Streak features, archived: read-only, with Restore. */
export const ARCHIVED_DETAIL: ProjectDetail = {
  project: { ...PROJECT_STREAK, instructions: "Keep answers about streaks short." },
  members: members(["luke-cooper", "owner"], ["AndresL230", "editor"]),
  pins: [PIN_TICKET_84],
  chats: [],
  artifacts: [],
  pinLimit: { used: 1, cap: 200 },
};
