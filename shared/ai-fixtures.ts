// Sample DTOs for the four AI screens (and Org settings › AI's numbers), built from the mockup's sample data
// (docs/superpowers/specs/2026-10-14-ai-screens-mock.md). Read ONLY by the
// `LOCAL_AI_PREVIEW` path (src/ai/preview.ts, honoured under `wrangler dev` alone) and by
// tests — production never returns them. Zod-free, so render tests in `web/` can import
// them too. Every date is relative to `now`, so "12 min ago" stays true in a screenshot.

import type { FeedRow } from "./rows";
import {
  AI_ALLOWANCE_KEYS, AI_MODEL, AI_THEME_RANGE_WEEKS, nextMonthStart,
  type AiBrief, type AiRepoState, type AiThemes, type AiThemeLane, type AiThemeRange, type AiCite, type AiState,
  type AiAllowanceKey, type AiAllowanceUse, type AiSettings, type AiSuggestion,
  type AiSprintNote, type AiPlanDrift, type AiSprintDraftValue, type AiPlanNarrativeValue,
} from "./ai-core";
import type { AiFilterScreen } from "./ai-filter-core";
import {
  ASK_ATTACH_BYTES_MAX, ASK_ATTACH_FILES_MAX, ASK_MODES, ASK_STARTERS_FALLBACK,
  type AskEvent, type AskEventMap, type AskEventName, type AskSearchHit, type AskSettings, type AskState, type AskThreadSummary, type RefStatus, type RefView,
} from "./ai-ask-core";

export { nextMonthStart };

/** What `LOCAL_AI_PREVIEW` may be set to. `proposed` is the themes' proposed state; the other
 *  screens show `ready` under it. Anything else in the var is ignored (no preview). */
export const AI_PREVIEW_MODES = ["ready", "empty", "capped", "proposed"] as const;
export type AiPreviewMode = (typeof AI_PREVIEW_MODES)[number];
export const isAiPreviewMode = (v: unknown): v is AiPreviewMode =>
  typeof v === "string" && (AI_PREVIEW_MODES as readonly string[]).includes(v);

const REPO = "AndresL230/trov";
const gh = (path: string): string => `https://github.com/${REPO}/${path}`;
const pr = (n: number): AiCite => ({ ref: `pr:${n}`, label: `#${n}`, href: gh(`pull/${n}`) });
const sha = (s: string): AiCite => ({ ref: `sha:${s}`, label: s, href: gh(`commit/${s}`) });
const branch = (b: string): AiCite => ({ ref: `branch:${b}`, label: b, href: gh(`tree/${b}`) });
const run = (id: number): AiCite => ({ ref: `run:${id}`, label: `CI run ${id}`, href: gh(`actions/runs/${id}`) });
const handoff = (n: number): AiCite => ({ ref: `handoff:${n}`, label: `handoff #${n}`, href: `#handoffs/${n}` });
const ticket = (n: number): AiCite => ({ ref: `ticket:${n}`, label: `#${n}`, href: `#tickets/${n}` });

const ago = (now: Date, ms: number): string => new Date(now.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The Monday (UTC) of `now`'s week, minus `back` weeks, `YYYY-MM-DD`. */
function monday(now: Date, back: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow - back * 7);
  return d.toISOString().slice(0, 10);
}

function meta(state: AiState, now: Date, writtenAgo: number | null) {
  return {
    state,
    generatedAt: writtenAgo === null ? null : ago(now, writtenAgo),
    model: writtenAgo === null ? null : AI_MODEL,
    resumesOn: state === "capped" ? nextMonthStart(now) : null,
    upgrade: state === "capped",
  };
}

// ── My Work › Your brief ────────────────────────────────────────────────────
// The one shape (BR-OWNER-1, `AI_BRIEF_*`): one sentence each for Now and Recently, three Next items, short whys.
export function briefFixture(state: AiState, now: Date): AiBrief {
  if (state === "empty") return { ...meta("empty", now, null), now: null, recently: null, next: { items: [] } };
  const nowLine = {
    text: "You are partway through the hosting screens on feat/hosting-screens, and the last push failed CI on the Netlify connect test.",
    cites: [branch("feat/hosting-screens"), run(4812)],
  };
  if (state === "capped") return { ...meta("capped", now, 9 * DAY), now: nowLine, recently: null, next: { items: [] } };
  return {
    ...meta("ready", now, 12 * MIN),
    now: nowLine,
    recently: {
      text: "You shipped status marks across the app, site and digests, and release 0.30 with public docs and account deletion.",
      cites: [pr(173), pr(172), pr(171)],
    },
    next: {
      items: [
        { ref: "run:4812", kind: "failing", title: "Fix the Netlify connect test", why: "It blocks the hosting PR you are working on.", cites: [run(4812), branch("feat/hosting-screens")] },
        { ref: "handoff:3", kind: "handoff", title: "Performance plan for trov.dev", why: "Left for anyone yesterday. Nothing in it is built yet.", cites: [handoff(3)] },
        { ref: "ticket:14", kind: "ticket", title: "Guided repository setup", why: "Assigned to you. It builds on the hosting work.", cites: [ticket(14)] },
      ],
    },
  };
}

// ── Repo › Overview › State ─────────────────────────────────────────────────
export function repoStateFixture(state: AiState, now: Date): AiRepoState {
  const headline = "Release 0.30 is live; hosting screens are the open front, and main is green.";
  if (state === "empty") return { ...meta("empty", now, null), headline: null, shipped: [], inFlight: [], attention: [], eventCount: null };
  if (state === "capped") return { ...meta("capped", now, 9 * DAY), headline, shipped: [], inFlight: [], attention: [], eventCount: 6 };
  return {
    ...meta("ready", now, 2 * HOUR),
    headline,
    shipped: [
      { text: "Status marks replace status tags everywhere.", cites: [pr(173)] },
      { text: "Release 0.30: public docs, account deletion, compliance pass.", cites: [pr(172)] },
      { text: "Claude on the web connector; partial-access GitHub orgs.", cites: [pr(171)] },
    ],
    inFlight: [
      { text: "Hosting screens for Vercel and Netlify.", cites: [branch("feat/hosting-screens")] },
      { text: "Performance plan for trov.dev, waiting on an owner.", cites: [handoff(3)] },
    ],
    attention: [
      { text: "CI failing on the hosting branch since this morning.", cites: [{ ...run(4812), label: "run 4812" }] },
      { text: "28 open tickets, none in a sprint.", cites: [{ ref: "tickets", label: "Tickets", href: "#tickets" }] },
    ],
    eventCount: 6,
  };
}

// ── Feed: entries written by Trov ───────────────────────────────────────────
/** Two entries written by Trov, as `/feed` rows. Ids sit far above any real row's so the preview
 *  can merge them into a real feed without colliding. `author` is the system handle. */
export function feedFixtures(now: Date): FeedRow[] {
  return [
    {
      id: 990_001,
      author: "trov",
      summary: "Shipped: status marks replace status tags across the app",
      brief: "States now read the same everywhere, with a short word and a shape you can hover for what it means, so a glance at any screen tells you where things stand.",
      body: null,
      artifacts: JSON.stringify({ prs: ["173"], commits: ["65b9f1f", "a1c04e2"], issues: [] }),
      created_at: ago(now, 1 * HOUR),
      ai: {
        origin: "ai",
        subject: "andres",
        sources: [pr(173), sha("65b9f1f"), sha("a1c04e2")],
        moreCount: 2,
        generatedAt: ago(now, 1 * HOUR),
        model: AI_MODEL,
      },
    },
    {
      id: 990_002,
      author: "trov",
      summary: "Status: hosting screens are partway, CI is red",
      brief: "The Vercel and Netlify connect screens are drafted on a branch. The Netlify connect test fails, so nothing is merged yet.",
      body: null,
      artifacts: JSON.stringify({ prs: [], commits: [], issues: [] }),
      created_at: ago(now, 5 * HOUR),
      ai: {
        origin: "ai",
        subject: "andres",
        sources: [branch("feat/hosting-screens"), { ...run(4812), label: "run 4812" }],
        moreCount: 0,
        generatedAt: ago(now, 5 * HOUR),
        model: AI_MODEL,
      },
    },
  ];
}

// ── Repo › Planning › Where the work went ───────────────────────────────────
// The mock's six lanes. `w` is its relative weekly weight over the last 8 weeks (0 = no band);
// counts are `round(w * 6)`, and the Quarter range pads 5 earlier weeks from `early`.
const LANES: { id: string; name: string; colorKey: AiThemeLane["colorKey"]; w: number[]; early: number[]; description: string; prs: AiCite[] }[] = [
  { id: "multiorg", name: "Multi-org and GitHub App", colorKey: "sky", w: [0, 0, 0.2, 0.6, 0.9, 1, 0.7, 0.3], early: [0, 0, 0, 0, 0], description: "The move from one team to many organizations, the rename to Trov, and the GitHub App install flow.", prs: [{ ...pr(171), label: "#171 One GitHub account, several orgs" }, { ref: "pr:160", label: "Multi-org re-architecture", href: gh("pull/160") }, { ref: "pr:152", label: "GitHub App install flow", href: gh("pull/152") }] },
  { id: "tickets", name: "Tickets and sprints", colorKey: "fern", w: [0.3, 0.8, 1, 0.7, 0.3, 0.1, 0, 0], early: [0.2, 0.4, 0.6, 0.5, 0.3], description: "Tickets as their own records, sprints replacing milestones, and GitHub issues mirrored in.", prs: [{ ref: "pr:78", label: "Tickets and the board", href: gh("pull/78") }, { ref: "pr:75", label: "GitHub issues mirrored as tickets", href: gh("pull/75") }] },
  { id: "repo", name: "Repo dashboard", colorKey: "slate", w: [0.5, 0.6, 0.4, 0.6, 0.5, 0.3, 0.4, 0.2], early: [0.3, 0.5, 0.6, 0.4, 0.5], description: "Capture, health and metrics; hosting connections are the open thread.", prs: [{ ref: "pr:57", label: "Repo dashboard capture", href: gh("pull/57") }, { ref: "branch:feat/hosting-screens", label: "Hosting connections (in flight)", href: gh("tree/feat/hosting-screens") }] },
  { id: "billing", name: "Billing and plans", colorKey: "ochre", w: [0, 0, 0, 0, 0.2, 0.4, 0.8, 0.5], early: [0, 0, 0, 0, 0], description: "Per-seat Pro, Stripe Checkout and the embedded checkout.", prs: [{ ref: "pr:136", label: "#136 Embedded checkout", href: gh("pull/136") }, { ref: "pr:130", label: "Per-seat Pro plan", href: gh("pull/130") }] },
  { id: "site", name: "Public site and docs", colorKey: "plum", w: [0, 0, 0, 0, 0.1, 0.3, 0.6, 1], early: [0, 0.1, 0, 0, 0], description: "The crawlable site, public docs, legal pages and the mobile layout.", prs: [{ ...pr(172), label: "#172 Release 0.30: crawlable site, public docs" }, { ref: "pr:139", label: "#139 Mobile marketing site", href: gh("pull/139") }] },
  { id: "polish", name: "UI polish", colorKey: "rose", w: [0.2, 0.1, 0.2, 0.3, 0.2, 0.2, 0.5, 0.9], early: [0.3, 0.2, 0.4, 0.2, 0.1], description: "Status marks, the Review page and smaller fixes across screens.", prs: [{ ...pr(173), label: "#173 Status marks" }, { ref: "pr:138", label: "#138 Review page", href: gh("pull/138") }] },
];

/** The proposed themes' suggestion ids: one per lane from here (Q38: clear of the card samples' 901–908). */
const PREVIEW_THEME_ID = 910;

/** Every made-up suggestion id the preview draws (› Phase C below; Q38). An Accept / Dismiss on one of them, with no
 *  real row behind it, answers `{ ok: true, preview: true }` under the preview and changes nothing (Q5). */
export const AI_PREVIEW_SUGGESTION_IDS: readonly number[] = [901, 902, 903, 904, 905, 906, 907, 908, 910, 911, 912, 913, 914, 915, 9101, 9102];
export const isPreviewSuggestionId = (id: number): boolean => AI_PREVIEW_SUGGESTION_IDS.includes(id);

export function themesFixture(mode: AiPreviewMode, range: AiThemeRange, now: Date): AiThemes {
  const n = AI_THEME_RANGE_WEEKS[range];
  const weeks = Array.from({ length: n }, (_, i) => monday(now, n - 1 - i));
  if (mode === "empty") return { ...meta("empty", now, null), caption: null, prCount: null, range, weeks: [], lanes: [] };
  const proposed = mode === "proposed";
  const lanes: AiThemeLane[] = LANES.map((l, i) => {
    const weights = range === "8w" ? l.w : [...l.early, ...l.w];
    return {
      id: l.id, name: l.name, colorKey: l.colorKey, description: l.description, prs: l.prs,
      counts: weights.map((w) => Math.round(w * 6)),
      status: proposed ? "proposed" : "active",
      suggestionId: proposed ? PREVIEW_THEME_ID + i : null,
    };
  });
  const prCount = lanes.reduce((s, l) => s + l.counts.reduce((a, b) => a + b, 0), 0);
  const caption = "Since late August most of the work went to multi-org and the GitHub App. October turned to the public site, billing and polish; tickets went quiet after September.";
  const state: AiState = mode === "capped" ? "capped" : "ready";
  return { ...meta(state, now, state === "capped" ? 9 * DAY : 3 * HOUR), caption: proposed ? null : caption, prCount, range, weeks, lanes };
}

// ── Org settings › AI ───────────────────────────────────────────────────────
/** What the preview puts on `GET /ai/settings`: the eligibility and all four allowances, as a 5-seat Pro org
 *  would see them (Ask Trov: 300 questions per seat). The switches (`enabled`, `chatAuto`), who may change them and what
 *  is sent stay the org's real ones — the preview fills numbers, never a choice — and what is sent always names
 *  both providers. `ready` / `proposed`: partway through the month; `empty`: nothing used yet; `capped`:
 *  every allowance used up, each resuming on the 1st. */
export function aiSettingsFixture(mode: AiPreviewMode, now: Date): Pick<AiSettings, "eligibility" | "allowances"> {
  const caps: Record<AiAllowanceKey, number> = { ai_summaries: 3000, ai_runs: 2000, jev_checks: 10000, ai_chat: 300 * 5 };
  const used: Record<AiAllowanceKey, number> = mode === "empty" ? { ai_summaries: 0, ai_runs: 0, jev_checks: 0, ai_chat: 0 }
    : mode === "capped" ? caps
    : { ai_summaries: 212, ai_runs: 486, jev_checks: 1240, ai_chat: 1120 };
  const resumesOn = mode === "capped" ? nextMonthStart(now) : null;
  const allowances = Object.fromEntries(AI_ALLOWANCE_KEYS.map((k) => [k, { used: used[k], cap: caps[k], resumesOn }])) as Record<AiAllowanceKey, AiAllowanceUse>;
  return { eligibility: mode === "capped" ? "capped" : "ok", allowances };
}

/** Everything one preview mode puts on the reads. */
export function aiPreviewFixtures(mode: AiPreviewMode, now: Date = new Date()) {
  const state: AiState = mode === "proposed" ? "ready" : mode;
  return {
    brief: briefFixture(state, now),
    repoState: repoStateFixture(state, now),
    feed: feedFixtures(now),
    // Phase C: agent entries Sift rated notable / breaking (merged into `/feed` beside `feed`).
    feedImportance: feedImportanceFixtures(now),
    themes: { "8w": themesFixture(mode, "8w", now), quarter: themesFixture(mode, "quarter", now) } as Record<AiThemeRange, AiThemes>,
    settings: aiSettingsFixture(mode, now),
    roadmap: roadmapFixture(state, now),
  };
}

// ── The plain-language filter (#162) ────────────────────────────────────────
/** What the preview answers on `POST /ai/filter`, per screen, in the model's shape (`{ filter, unmatched }`). The
 *  route checks it exactly as it checks a model's answer (src/ai/filter.ts `resolveFilter`): "me" becomes the
 *  person asking, and a word in `unmatched` is shown only when the request typed it ("my overdue tickets").
 *  `empty` answers nothing (the screen's "couldn't turn that into a filter"); `capped` never gets here (the
 *  route answers the allowance's 402 first). */
export function aiFilterFixture(screen: AiFilterScreen, mode: AiPreviewMode): { filter: Record<string, string>; unmatched: string[] } | null {
  if (mode === "empty" || mode === "capped") return null;
  switch (screen) {
    case "tickets": return { filter: { status: "open", assignee: "me", priority: "high", category: "bug" }, unmatched: ["overdue"] };
    case "feed": return { filter: { author: "me", range: "7d" }, unmatched: ["about deploys"] };
    case "artifacts": return { filter: { status: "published", kind: "html", text: "checkout" }, unmatched: [] };
  }
}
// ── Ask Trov (#12 §2.20) ─────────────────────────────────────────────────────
// One recorded SSE transcript per design scenario (Andres's Claude Design file `Ask Trov.dc.html`), built from the
// design's own sample content, so the frontend can be built and screenshotted against the real event contract
// without a key: the dev-only replay route (`GET /api/o/:slug/ai/ask-replay/:scenario`, LOCAL_AI_PREVIEW only)
// streams any of them at real pacing. The design's org name is replaced ("Acme"); its people, repository and items
// are kept. Every event is checked against `AskEventSchemas` (test/ask.contract.test.ts).

/** The design's scenarios. `live`, `ticket` and `settings` stream nothing (they draw from the state, thread and
 *  settings fixtures below). */
export const ASK_SCENARIOS = [
  "live", "streaming", "thinking", "answer", "answer-pr", "actions-ask", "actions-auto", "artifact", "artifact-saved",
  "search", "notfound", "cmdj", "ticket", "settings", "phone", "phone-plus", "phone-insp",
] as const;
export type AskScenario = (typeof ASK_SCENARIOS)[number];
export const isAskScenario = (v: unknown): v is AskScenario => typeof v === "string" && (ASK_SCENARIOS as readonly string[]).includes(v);

/** One event of a transcript, and how long after the previous one it arrives (real pacing). */
export interface AskTranscriptStep { delayMs: number; event: AskEvent }

/** The org name the Ask fixtures use in place of the design's. */
export const ASK_FIXTURE_ORG = "Acme";
const ASK_REPO = "AndresL230/trov";
const rs = (mark: RefStatus["mark"], tone: RefStatus["tone"], word: string, tip: string): RefStatus => ({ mark, tone, word, tip });
const S = {
  inProgress: rs("half", "accent", "In progress", "In progress. Someone is working on it."),
  triage: rs("todo", "muted", "Triage", "Triage. Filed, and waiting for someone to pick it up or decline it."),
  testing: rs("most", "amber", "Testing", "Testing. Built, and being checked before it is done."),
  review: rs("ring", "blue", "In review", "Waiting on a review."),
  approved: rs("dot", "green", "Approved", "Approved, not merged yet."),
  merged: rs("check", "accent", "Merged", "Merged."),
  live: rs("dot", "green", "Live", "Promoted. This is the version agents read."),
  staged: rs("ring", "amber", "Staged, not approved", "An agent proposed this version. A person has not approved it yet."),
  late3: rs("warn", "amber", "3 days late", "At this pace the sprint finishes after its due date."),
  pending: rs("ring", "blue", "Pending", "Waiting for a session to claim it. Unclaimed handoffs expire after 7 days."),
  ciFailing: rs("diamond", "red", "CI failing", "Checks are failing on main."),
  private: rs("ring", "muted", "Private", "Only you can see it."),
};

/** The design's items, as the server's RefViews. */
export function askRefFixtures(now: Date): Record<string, RefView> {
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const H = 3_600_000, D = 24 * H;
  const t = (num: number, title: string, status: RefStatus, priority: string, assignees: string[], sprint: string | null, updated: string): RefView =>
    ({ ref: `ticket:${num}`, type: "ticket", num, title, status, owner: assignees[0] ?? null, updated, href: `#tickets/${num}`, extra: { priority, assignees, sprint } });
  const pr = (num: number, title: string, status: RefStatus, author: string, head: string, checks: [string, string][], updated: string): RefView =>
    ({ ref: `pr:${num}`, type: "pr", num, title, status, owner: author, updated, href: `https://github.com/${ASK_REPO}/pull/${num}`,
      extra: { author, head, base: "main", repo: ASK_REPO, checks: checks.map(([name, state]) => ({ name, state })) } });
  const pass = (n: string): [string, string] => [n, "success"];
  const people: [string, string, string, string[]][] = [
    ["andres", "Andres Lopez", "Founder. Hosting and the gate.", ["ticket:18", "ticket:29"]],
    ["maya", "Maya Chen", "Engineer. Guided setup.", ["ticket:14"]],
    ["priya", "Priya Natarajan", "Engineer. Board and status marks.", ["ticket:24"]],
    ["jon", "Jon Park", "Designer. Onboarding.", ["ticket:23"]],
  ];
  const views: RefView[] = [
    t(14, "Guided repository setup", S.inProgress, "high", ["maya", "andres"], "Hosting", ago(2 * H)),
    t(18, "Hosting connections: Netlify and Vercel", S.inProgress, "high", ["andres"], "Hosting", ago(5 * H)),
    t(19, "Reconnect expired hosting tokens", S.triage, "normal", [], "Hosting", ago(2 * D)),
    t(23, "Empty state when the org has no repositories", S.triage, "normal", ["jon"], "Hosting", ago(6 * D)),
    t(24, "Status marks on the board", S.testing, "normal", ["priya"], null, ago(2 * D)),
    t(29, "Fix the Netlify connect test on main", S.triage, "high", ["andres"], "Hosting", ago(60_000)),
    t(30, "Reconnect expired hosting tokens from Org settings", S.triage, "high", ["andres"], "Hosting", ago(60_000)),
    pr(176, "Netlify connect step for guided setup", S.review, "maya", "maya/netlify-connect", [pass("build"), pass("typecheck"), ["netlify-connect.test", "failure"], pass("lint")], ago(40 * 60_000)),
    pr(173, "Status marks replace pills", S.merged, "priya", "priya/status-marks", [pass("build"), pass("typecheck"), pass("test"), pass("lint")], ago(2 * D)),
    pr(171, "Guided setup: repository picker", S.merged, "maya", "maya/repo-picker", [pass("build"), pass("typecheck"), pass("test"), pass("lint")], ago(D)),
    pr(178, "Release 0.30", S.approved, "andres", "release/0.30", [pass("build"), pass("typecheck"), pass("test"), pass("lint")], ago(H)),
    { ref: "doc:hosting-connections", type: "doc", title: "Hosting connections", status: S.live, owner: "andres", updated: ago(3 * D), href: null,
      extra: { space: "engineering", version: 4, owner: "andres", excerpt: "An org connects a hosting account once, in Org settings › Integrations. Trov keeps the token encrypted and polls the provider for deploys every 10 minutes.", staged: false } },
    { ref: "doc:release-0-30-notes", type: "doc", title: "Release 0.30 notes", status: S.staged, owner: "priya", updated: ago(2 * H), href: null,
      extra: { space: "product", version: 2, owner: "priya", excerpt: "Status marks replace pills on every board, table and rail.", staged: true } },
    { ref: "doc:performance-plan", type: "doc", title: "Performance plan", status: S.live, owner: "andres", updated: ago(6 * D), href: null,
      extra: { space: "engineering", version: 3, owner: "andres", excerpt: "The Repo dashboard makes 38 D1 queries per load.", staged: false } },
    { ref: "sprint:7", type: "sprint", num: 7, title: "Hosting", status: S.late3, owner: "andres", updated: ago(H), href: "#sprints/7",
      extra: { start: "2026-10-05", due: "2026-10-30", progress: { closed: 7, total: 12 } } },
    { ref: "handoff:11", type: "handoff", num: 11, title: "Carry the performance plan forward", status: S.pending, owner: "andres", updated: ago(3 * H), href: "#handoffs/11",
      extra: { from: "andres", to: "anyone", task: "Pick up the performance plan where the last session stopped: batch the D1 reads in the usage rollup, then measure the Repo dashboard again." } },
    { ref: "handoff:12", type: "handoff", num: 12, title: "Fix the Netlify connect test on main", status: S.pending, owner: "andres", updated: ago(60_000), href: "#handoffs/12",
      extra: { from: "andres", to: "anyone", task: "Update netlify-connect.test.ts to assert on the new status marks, then re-run CI on main." } },
    { ref: "feed:41", type: "feed", num: 41, title: "Status marks replace pills", status: null, owner: "priya", updated: ago(2 * D), href: null,
      extra: { brief: "Every board, table and rail now shows state as a mark instead of a pill." } },
    // #186: a repo's state is its RepoFacts, drawn by the client (`status` null). The fixture carries none — the
    // dev replay fills `extra.facts` from the Repo Overview's own sample, scenario N / `trov` (B in trouble:
    // web/src/repo-sample.ts `repoScenario`), so Ask never keeps a sample repository of its own.
    { ref: `repo:${ASK_REPO}`, type: "repo", title: ASK_REPO, status: null, updated: ago(40 * 60_000), href: "#repo", extra: { facts: null } },
    { ref: "artifact:hosting-status-oct-15", type: "artifact", title: "Hosting status, Oct 15", status: S.private, owner: "andres", updated: now.toISOString(), href: "#artifacts/hosting-status-oct-15",
      extra: { kind: "html", visibility: "private", version: 1, status: "draft" } },
    ...people.map(([handle, name, role, working]): RefView => ({ ref: `person:${handle}`, type: "person", title: name, status: null, owner: handle, href: null, extra: { handle, role, workingOn: working } })),
  ];
  return Object.fromEntries(views.map((v) => [v.ref, v]));
}

/** `GET /ask/state` on Pro (all modes) and on Free (Smart only, no switcher; 9 of 50 questions left). */
export function askStateFixture(plan: "pro" | "free", now: Date): AskState {
  const modes = ASK_MODES.filter((m) => plan === "pro" || m.id === "smart").map((m) => ({ id: m.id, label: m.label, hint: m.hint, countsAs: m.countsAs, canSend: true }));
  return {
    enabled: true, eligibility: "ok", plan: plan === "pro" ? "team" : "free", modes, defaultMode: "smart",
    allowance: plan === "pro" ? { used: 412, cap: 1500, resetsAt: nextMonthStart(now), low: false } : { used: 41, cap: 50, resetsAt: nextMonthStart(now), low: true },
    autoAllowed: true,
    attach: { maxFiles: ASK_ATTACH_FILES_MAX, maxBytes: ASK_ATTACH_BYTES_MAX, kinds: ["image", "pdf", "text"] },
    starters: [...ASK_STARTERS_FALLBACK],
    proPerSeat: 300,
  };
}

export function askSettingsFixture(plan: "pro" | "free"): AskSettings {
  return { instructions: "", defaultMode: "smart", modes: plan === "pro" ? ["fast", "smart", "thinking"] : ["smart"] };
}

/** The design's thread list (two pinned, two today, four this week). */
export function askThreadsFixture(now: Date): AskThreadSummary[] {
  const at = (days: number, hh: number, mm: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days, hh, mm)).toISOString();
  const th = (id: number, title: string, updatedAt: string, group: AskThreadSummary["group"]): AskThreadSummary =>
    ({ id, title, pinned: group === "pinned", mode: "smart", auto: false, origin: "page", contextRef: null, hasDraft: false, group, createdAt: updatedAt, updatedAt });
  return [
    th(1, "Hosting status", at(0, 9, 41), "pinned"),
    th(2, "Release 0.30 checklist", at(3, 15, 0), "pinned"),
    th(3, "What shipped this week?", at(0, 10, 12), "today"),
    th(4, "Summarize ticket #14", at(0, 9, 5), "today"),
    th(5, "CI flake on netlify-connect", at(2, 11, 0), "week"),
    th(6, "Where did our time go in September?", at(2, 9, 0), "week"),
    th(7, "Draft a sprint goal for Hosting", at(3, 10, 0), "week"),
    th(8, "Performance plan handoff", at(4, 18, 0), "week"),
  ];
}

/** The design's thread search for "netlify": four threads, the match marked by offsets. */
export function askSearchFixture(now: Date): AskSearchHit[] {
  const threads = askThreadsFixture(now);
  const hit = (id: number, text: string, matchCount: number): AskSearchHit => {
    const at = text.toLowerCase().indexOf("netlify");
    return { thread: threads.find((x) => x.id === id)!, snippet: { text, matches: [[at, at + 7]] }, matchCount };
  };
  return [
    hit(3, "…The Netlify connect step is waiting on CI.", 1),
    hit(4, "…PR #176 adds the Netlify connect step and is red on one test.", 1),
    hit(5, "…Why does netlify-connect.test.ts fail only on main?", 3),
    hit(7, "…Any org can connect Netlify or Vercel and see its deploys in Trov.", 1),
  ];
}

// ── the transcripts ──────────────────────────────────────────────────────────

const ev = <K extends AskEventName>(event: K, data: AskEventMap[K], delayMs = 40): AskTranscriptStep => ({ delayMs, event: { event, data } as AskEvent });

/** Markdown streamed in small word chunks, as the model streams it. */
function words(md: string, delayMs = 35): AskTranscriptStep[] {
  return (md.match(/\S+\s*|\s+/g) ?? []).map((w) => ev("text", { delta: w }, delayMs));
}

const HOSTING_Q = "What's blocking the hosting work? This is what I see in CI.";

function hostingTurn(now: Date, mode: "smart" | "thinking"): AskTranscriptStep[] {
  const R = askRefFixtures(now);
  const steps: AskTranscriptStep[] = [
    ev("thread", { id: 1, title: "Hosting status", mode, auto: false, origin: "page", contextRef: null }, 0),
    ev("activity", { step: 1, tool: "query", icon: "search", label: "Searched docs for 'hosting'", state: "run" }, 120),
    ev("activity", { step: 1, state: "done", results: ["doc:hosting-connections", "doc:performance-plan", "doc:release-0-30-notes"], resultLine: "3 results" }, 600),
    ev("activity", { step: 2, tool: "get_ticket", icon: "tickets", label: "Read ticket #14", state: "run" }, 80),
    ev("activity", { step: 2, state: "done", results: ["ticket:14", "sprint:7", "person:maya", "person:andres"] }, 450),
    ev("activity", { step: 3, tool: "get_repo_dashboard", icon: "ci", label: `Checked CI on ${ASK_REPO}`, state: "run" }, 80),
    ev("activity", { step: 3, state: "done", results: [`repo:${ASK_REPO}`], resultLine: "1 result" }, 700),
    ev("activity", { step: 4, tool: "get_events", icon: "pr", label: "Read PR #176", state: "run" }, 80),
    ev("activity", { step: 4, state: "done", results: ["pr:176", "pr:173"] }, 500),
    ev("activity", { step: 5, tool: "get_sprint", icon: "sprint", label: "Looked at the Hosting sprint", state: "run" }, 80),
    ev("activity", { step: 5, state: "done", results: ["sprint:7", "ticket:18", "ticket:19"] }, 400),
  ];
  if (mode === "thinking") {
    steps.push(ev("thinking", { state: "run" }, 100));
    steps.push(ev("thinking", { state: "done", seconds: 14, summary: "Started from ticket #14 and its linked PRs. PR #176 is green except one test, so I traced that test back to the status-mark change in #173, then checked what else in the Hosting sprint waits on #176." }, 14_000));
  }
  steps.push(
    ...words("Most of the hosting work is moving. What blocks it is narrow: [[ticket:14]] waits on the Netlify connect step, and that step can't merge while one test fails on main.\n\n## What is blocking\n\n"),
    ...words("- The Netlify connect test fails on main since [[pr:173]] changed the status marks it checks.\n- [[person:andres]] owns the fix. It isn't filed as a ticket yet.\n- Token refresh in [[doc:hosting-connections]] is still described as automatic, which is no longer true.\n\n"),
    ...words("| Ticket | Status | Owner | Waiting on |\n| --- | --- | --- | --- |\n| [[ticket:14]] | [[ticket:14|status]] | Maya Chen | PR #176 |\n| [[ticket:18]] | [[ticket:18|status]] | Andres Lopez | PR #176 |\n| [[ticket:19]] | [[ticket:19|status]] | Unassigned | #18 |\n\n", 20),
    ev("activity", { step: 6, tool: "show_items", icon: "read", label: "Showed items", state: "run" }, 60),
    ev("block", { kind: "items", items: [R["ticket:14"], R["pr:176"], R["sprint:7"]] }, 120),
    ev("activity", { step: 6, state: "done", results: ["ticket:14", "pr:176", "sprint:7"] }, 20),
    ...words("## Pace\n\nMerged PRs hold at about six a week. Hosting took the largest share of the last eight weeks.\n\n"),
    ev("block", { kind: "chart", chart: {
      title: "Merged PRs by week", total: 48, unit: "merged pull requests", query: "merged_prs_by_week", params: { weeks: 8 },
      rows: ([["Aug 24", 4], ["Aug 31", 6], ["Sep 7", 5], ["Sep 14", 8], ["Sep 21", 7], ["Sep 28", 3], ["Oct 5", 9], ["Oct 12", 6]] as [string, number][]).map(([label, value]) => ({ label, value })),
    } }, 300),
    ev("block", { kind: "themes", themes: {
      title: "Where the time went, by theme", caption: "Share of merged PRs",
      weeks: ["Aug 24", "Aug 31", "Sep 7", "Sep 14", "Sep 21", "Sep 28", "Oct 5", "Oct 12"],
      lanes: [
        { theme: "Hosting", color: "sky", values: [0.2, 0.35, 0.5, 0.6, 0.7, 0.8, 0.9, 0.85] },
        { theme: "Repo setup", color: "moss", values: [0.6, 0.5, 0.4, 0.5, 0.6, 0.55, 0.4, 0.5] },
        { theme: "Status marks", color: "plum", values: [0, 0.1, 0.3, 0.7, 0.8, 0.6, 0.2, 0.1] },
        { theme: "Release 0.30", color: "ochre", values: [0, 0, 0, 0.1, 0.2, 0.3, 0.5, 0.7] },
      ],
    } }, 300),
    ev("block", { kind: "diagram", diagram: {
      title: "What waits on what", caption: "Each step waits on the one before it", layout: "chain",
      nodes: [
        { id: "ci", eyebrow: "CI on main", label: "netlify-connect.test", ref: `repo:${ASK_REPO}`, view: R[`repo:${ASK_REPO}`] },
        { id: "pr", eyebrow: "Pull request", label: "#176 Netlify connect step", ref: "pr:176", view: R["pr:176"] },
        { id: "t14", eyebrow: "Ticket", label: "#14 Guided repository setup", ref: "ticket:14", view: R["ticket:14"] },
        { id: "sprint", eyebrow: "Sprint", label: "Hosting, due Oct 30", ref: "sprint:7", view: R["sprint:7"] },
      ],
      edges: [["ci", "pr"], ["pr", "t14"], ["t14", "sprint"]],
    } }, 300),
    ...words("Fixing the test unblocks [[pr:176]], which closes most of [[ticket:14]]. Until then the sprint is forecast to finish 3 days late."),
    ev("followups", { items: ["File a ticket for the failing test", "Hand off the test fix to an agent", "What changed in PR #173?"] }, 200),
    ev("done", { messageId: 2, questionId: 1, cites: ["ticket:14", "pr:173", "person:andres", "doc:hosting-connections", "ticket:18", "ticket:19", "pr:176"].map((r) => R[r]), tokens: { in: 18_240, out: 1_310, cached: 14_902 } }, 40),
  );
  return steps;
}

/** The design holds the stream at token 58, mid second bullet ("…It isn't filed as a ticket"): no `done`. */
function streamingCut(steps: AskTranscriptStep[]): AskTranscriptStep[] {
  let tokens = 0;
  const out: AskTranscriptStep[] = [];
  for (const s of steps) {
    if (s.event.event === "text" && ++tokens > 58) break;
    out.push(s);
  }
  return out;
}

function actionsAskTurn(now: Date): AskTranscriptStep[] {
  const R = askRefFixtures(now);
  return [
    ev("thread", { id: 1, title: "Hosting status", mode: "smart", auto: false, origin: "page", contextRef: null }, 0),
    ev("activity", { step: 1, tool: "get_ticket", icon: "tickets", label: "Read ticket #18", state: "run" }, 100),
    ev("activity", { step: 1, state: "done", results: ["ticket:18", "ticket:19"] }, 400),
    ev("activity", { step: 2, tool: "get_doc", icon: "docs", label: "Read Hosting connections v4", state: "run" }, 80),
    ev("activity", { step: 2, state: "done", results: ["doc:hosting-connections"] }, 400),
    ...words("Here are the three changes. Nothing happens until you confirm each one."),
    ev("action", {
      id: 31, groupId: "1-4-1", tool: "create_ticket", kind: "ticket", state: "proposed", note: null,
      preview: { title: "New ticket", item: null, lines: [
        { label: "Title", value: "Reconnect expired hosting tokens from Org settings" },
        { label: "Description", value: "When a hosting token expires the connection stops without a sign. Show it as expired and offer Reconnect." },
        { label: "Category", value: "bug" }, { label: "Priority", value: "high" }, { label: "Assignee", value: "@andres" }, { label: "Sprint", value: "Hosting" },
      ] },
      fields: { title: "Reconnect expired hosting tokens from Org settings", body: "When a hosting token expires the connection stops without a sign. Show it as expired and offer Reconnect.", category: "bug", priority: "high", assignee: "andres", sprint_id: 7 },
      editable: ["title", "category", "priority", "assignee"],
    }, 300),
    ev("action", {
      id: 32, groupId: "1-4-2", tool: "send_handoff", kind: "handoff", state: "proposed", note: null,
      preview: { title: "New handoff", item: null, lines: [
        { label: "From", value: "@andres" }, { label: "To", value: "Anyone · any agent session can claim it" },
        { label: "Task", value: "Fix the Netlify connect test on main" },
        { label: "Done", value: "Traced the failure to the status-mark change in #173; Confirmed #176 is green except this test" },
        { label: "Next", value: "Update the test to assert on the new marks; Re-run CI on main; Ask Maya to rebase #176" },
        { label: "Files", value: "test/netlify-connect.test.ts, web/src/marks.ts" },
      ] },
      fields: { recipient: "anyone", task: "Fix the Netlify connect test on main", done: ["Traced the failure to the status-mark change in #173", "Confirmed #176 is green except this test"],
        next: ["Update the test to assert on the new marks", "Re-run CI on main", "Ask Maya to rebase #176"], files: ["test/netlify-connect.test.ts", "web/src/marks.ts"] },
      editable: ["recipient", "task"],
    }, 300),
    ev("action", {
      id: 33, groupId: "1-4-3", tool: "propose_doc_update", kind: "doc_edit", state: "proposed", note: null,
      preview: { title: "Doc edit: Hosting connections", item: R["doc:hosting-connections"], lines: [
        { label: "Doc", value: "Hosting connections" }, { label: "Version", value: "v4 → v5" }, { label: "Change", value: "Token refresh is manual for now" },
      ], hunks: [{ index: 0, heading: "## Tokens", before: "Trov refreshes hosting tokens automatically before they expire.",
        after: "Token refresh is manual for now. When a token expires, reconnect it in Org settings › Integrations." }] },
      fields: { slug: "hosting-connections", section: "architecture", title: null, change_summary: "Token refresh is manual for now" },
      editable: ["hunks"],
    }, 300),
    ev("done", { messageId: 4, questionId: 3, cites: [R["ticket:18"], R["doc:hosting-connections"], R["handoff:11"]], tokens: { in: 9_820, out: 640, cached: 8_100 } }, 40),
  ];
}

function actionsAutoTurn(now: Date): AskTranscriptStep[] {
  const R = askRefFixtures(now);
  const at = now.toISOString();
  return [
    ev("thread", { id: 1, title: "Hosting status", mode: "smart", auto: true, origin: "page", contextRef: null }, 0),
    ev("activity", { step: 1, tool: "get_handoff", icon: "handoffs", label: "Read handoff #11", state: "run" }, 100),
    ev("activity", { step: 1, state: "done", results: ["handoff:11"] }, 350),
    ev("activity", { step: 2, tool: "get_events", icon: "review", label: "Read the review on PR #178", state: "run" }, 80),
    ev("activity", { step: 2, state: "done", results: ["pr:178"] }, 400),
    ev("action_result", { id: 41, groupId: "1-6-1", tool: "send_handoff", kind: "handoff", preview: { title: "Send a handoff to anyone", lines: [{ label: "Task", value: "Fix the Netlify connect test on main" }], item: null }, state: "auto", result: { id: 11, recipient: "anyone", url: "#handoffs/11" }, ref: "handoff:11", undo: true, at }, 300),
    ev("action_result", { id: 42, groupId: "1-6-2", tool: "transition_ticket", kind: "move", preview: { title: "Move ticket #14 to In progress", lines: [{ label: "From", value: "Testing" }, { label: "To", value: "In progress" }], item: R["ticket:14"] }, state: "auto", result: { id: 14, status: "in_progress" }, ref: "ticket:14", undo: true, at }, 250),
    ev("action_result", { id: 43, groupId: "1-6-3", tool: "create_ticket", kind: "ticket", preview: { title: "Reconnect expired hosting tokens from Org settings", lines: [{ label: "Category", value: "Bug" }], item: null }, state: "auto", result: { id: 30, title: "Reconnect expired hosting tokens from Org settings" }, ref: "ticket:30", undo: true, at }, 250),
    ev("action_result", { id: 44, groupId: "1-6-3", tool: "create_ticket", kind: "ticket", preview: { title: "Remove the pill styles left in trov.css", lines: [{ label: "Category", value: "Chore" }], item: null }, state: "auto", result: { id: 31, title: "Remove the pill styles left in trov.css" }, ref: "ticket:31", undo: true, at }, 200),
    ev("action_result", { id: 45, groupId: "1-6-3", tool: "create_ticket", kind: "ticket", preview: { title: "Rename status helpers to marks", lines: [{ label: "Category", value: "Chore" }], item: null }, state: "auto", result: { id: 32, title: "Rename status helpers to marks" }, ref: "ticket:32", undo: true, at }, 200),
    ev("action", {
      id: 46, groupId: "1-6-4", tool: "publish_doc", kind: "publish", state: "waiting", note: "Publishing waits for you, even on Auto.",
      preview: { title: "Publish Release 0.30 notes", item: R["doc:release-0-30-notes"], canPublish: true, lines: [
        { label: "Version", value: "v2" }, { label: "Staged by", value: "@priya" },
        { label: "What it does", value: "Publishing makes v2 live for the org. Agents read it from then on." },
      ], hunks: [{ index: 0, heading: "## What is new in 0.30", before: "", after: "- Status marks replace pills on every board, table and rail.\n- Guided setup starts with a repository picker.\n- Vercel deploys show on the Repo dashboard." }] },
      fields: { slug: "release-0-30-notes", version: 2 }, editable: [],
    }, 300),
    ...words("Five changes ran on their own. The sixth waits for you."),
    ev("done", { messageId: 6, questionId: 5, cites: [R["handoff:11"], R["ticket:14"], R["pr:178"], R["doc:release-0-30-notes"]], tokens: { in: 11_400, out: 820, cached: 9_960 } }, 40),
  ];
}

function artifactTurn(saved: boolean): AskTranscriptStep[] {
  const out: AskTranscriptStep[] = [
    ev("thread", { id: 1, title: "Hosting status", mode: "smart", auto: false, origin: "page", contextRef: null }, 0),
    ev("activity", { step: 1, tool: "save_artifact", icon: "read", label: "Prepared a save form", state: "run" }, 100),
    ev("block", { kind: "save_form", form: { messageId: null, block: null, title: "Hosting status, Oct 15", kind: "html", visibility: "private", saved: null } }, 200),
    ev("activity", { step: 1, state: "done" }, 20),
    ...words("Here it is as an artifact. Change the title or who can see it, then save."),
    ev("done", { messageId: 8, questionId: 7, cites: [], tokens: { in: 21_300, out: 160, cached: 20_900 } }, 40),
  ];
  // After Save (`POST /ask/threads/:id/save`), the form becomes the saved line.
  if (saved) out.push(ev("artifact_saved", { slug: "hosting-status-oct-15", title: "Hosting status, Oct 15", visibility: "private", url: "#artifacts/hosting-status-oct-15" }, 900));
  return out;
}

function searchTurn(now: Date): AskTranscriptStep[] {
  const R = askRefFixtures(now);
  return [
    ev("thread", { id: 3, title: "What shipped this week?", mode: "smart", auto: false, origin: "page", contextRef: null }, 0),
    ev("activity", { step: 1, tool: "get_feed", icon: "feed", label: "Read the feed for Oct 9 – Oct 15", state: "run" }, 100),
    ev("activity", { step: 1, state: "done", results: ["feed:41"] }, 400),
    ev("activity", { step: 2, tool: "get_events", icon: "pr", label: `Checked merged PRs on ${ASK_REPO}`, state: "run" }, 80),
    ev("activity", { step: 2, state: "done", results: ["pr:173", "pr:171", "pr:178"], resultLine: "3 results" }, 500),
    ...words("Four things shipped this week, most of them on the board and in guided setup.\n\n- [[pr:173]] replaced pills with status marks on every board and table.\n- [[pr:171]] added the repository picker, the first step of [[ticket:14]].\n- Release notes for 0.30 are drafted in [[doc:release-0-30-notes]] and not approved yet.\n- [[handoff:11]] went out so an agent can pick up the performance plan.\n\n"),
    ev("block", { kind: "items", items: [R["pr:173"], R["pr:171"], R["doc:release-0-30-notes"]] }, 150),
    ...words("Nothing was reverted. [[person:priya]] merged 3 of the 7 PRs."),
    ev("followups", { items: ["What's still open for 0.30?", "Summarize PR #173", "What's blocking the hosting work?"] }, 150),
    ev("done", { messageId: 10, questionId: 9, cites: [R["pr:173"], R["pr:171"], R["ticket:14"], R["doc:release-0-30-notes"], R["handoff:11"], R["person:priya"]], tokens: { in: 7_200, out: 410, cached: 6_100 } }, 40),
  ];
}

function notFoundTurn(): AskTranscriptStep[] {
  const term = "the customer say about SSO pricing on the last call";
  return [
    ev("thread", { id: 9, title: "", mode: "smart", auto: false, origin: "page", contextRef: null }, 0),
    ev("activity", { step: 1, tool: "query", icon: "search", label: `Searched docs for '${term}'`, state: "run" }, 100),
    ev("activity", { step: 1, state: "done", resultLine: "No results" }, 500),
    ev("activity", { step: 2, tool: "list_tickets", icon: "tickets", label: "Searched tickets and comments", state: "run" }, 80),
    ev("activity", { step: 2, state: "done", resultLine: "No results" }, 450),
    ev("activity", { step: 3, tool: "get_feed", icon: "feed", label: "Searched the feed since Sep 1", state: "run" }, 80),
    ev("activity", { step: 3, state: "done", resultLine: "No results" }, 400),
    ev("activity", { step: 4, tool: "show_not_found", icon: "search", label: "Checked what was searched", state: "run" }, 60),
    ev("block", { kind: "not_found", notFound: {
      query: term, tries: ["What do our docs say about pricing?", "What's in the Release 0.30 notes?"],
      searched: [
        { area: "Docs", scope: "Engineering and Product, 24 docs" },
        { area: "Tickets and comments", scope: "31 tickets, 212 comments" },
        { area: "Feed", scope: "41 entries since Sep 1" },
        { area: "Artifacts", scope: "12 artifacts" },
      ],
    } }, 200),
    ev("activity", { step: 4, state: "done" }, 20),
    ev("thread", { id: 9, title: "SSO pricing on the last call", mode: "smart", auto: false, origin: "page", contextRef: null }, 40),
    ev("done", { messageId: 12, questionId: 11, cites: [], tokens: { in: 6_900, out: 120, cached: 5_800 } }, 40),
  ];
}

function cmdjTurn(now: Date): AskTranscriptStep[] {
  const R = askRefFixtures(now);
  return [
    ev("thread", { id: 10, title: "", mode: "smart", auto: false, origin: "panel", contextRef: "ticket:14" }, 0),
    ev("activity", { step: 1, tool: "get_ticket", icon: "tickets", label: "Read ticket #14", state: "run" }, 100),
    ev("activity", { step: 1, state: "done", results: ["ticket:14", "ticket:23", "person:jon"] }, 400),
    ev("activity", { step: 2, tool: "get_events", icon: "pr", label: "Read PR #176", state: "run" }, 80),
    ev("activity", { step: 2, state: "done", results: ["pr:176"] }, 400),
    ...words("Two of three sub-tickets are open. [[pr:176]] needs the connect test fixed first.\n\n- Fix the connect test on main. [[person:andres]] said today.\n- Merge [[pr:176]].\n- Write the empty state for #23 with [[person:jon]]."),
    ev("followups", { items: ["Draft a handoff for the connect test"] }, 150),
    ev("thread", { id: 10, title: "What's left on #14", mode: "smart", auto: false, origin: "panel", contextRef: "ticket:14" }, 30),
    ev("done", { messageId: 14, questionId: 13, cites: [R["pr:176"], R["person:andres"], R["person:jon"]], tokens: { in: 5_400, out: 260, cached: 4_300 } }, 40),
  ];
}

type ScenarioQuestion = { text: string; context: string[]; attachments: { title: string; kind: "image" | "pdf" | "text"; size: number }[] } | null;
const HOSTING: ScenarioQuestion = { text: HOSTING_Q, context: ["ticket:14"], attachments: [{ title: "ci-failure.png", kind: "image", size: 421_888 }] };

/** The question each scenario sends (what the composer shows above the answer). */
export const ASK_SCENARIO_QUESTION: Record<AskScenario, ScenarioQuestion> = {
  live: null, ticket: null, settings: null,
  streaming: HOSTING, thinking: HOSTING, answer: HOSTING, "answer-pr": HOSTING, phone: HOSTING, "phone-plus": HOSTING, "phone-insp": HOSTING,
  "actions-ask": { text: "Now draft the follow-ups: a ticket for reconnecting expired tokens, a handoff to fix the connect test, and a note in the hosting doc that token refresh is manual for now.", context: [], attachments: [] },
  "actions-auto": { text: "Hand the performance plan to whoever is free, put #14 back in progress, file the three cleanup tickets from the review, and publish the release notes.", context: [], attachments: [] },
  artifact: { text: "save this as a doc", context: [], attachments: [] },
  "artifact-saved": { text: "save this as a doc", context: [], attachments: [] },
  search: { text: "What shipped this week?", context: [], attachments: [] },
  notfound: { text: "What did the customer say about SSO pricing on the last call?", context: [], attachments: [] },
  cmdj: { text: "What's left before this can close?", context: ["ticket:14"], attachments: [] },
};

/** THE transcripts: what `POST /ask` streams for each design scenario (empty for the screens with no turn). */
export function askTranscript(scenario: AskScenario, now: Date = new Date()): AskTranscriptStep[] {
  switch (scenario) {
    case "live": case "ticket": case "settings": return [];
    case "streaming": return streamingCut(hostingTurn(now, "smart"));
    case "thinking": return hostingTurn(now, "thinking");
    case "answer": case "answer-pr": case "phone": case "phone-plus": case "phone-insp": return hostingTurn(now, "smart");
    case "actions-ask": return actionsAskTurn(now);
    case "actions-auto": return actionsAutoTurn(now);
    case "artifact": return artifactTurn(false);
    case "artifact-saved": return artifactTurn(true);
    case "search": return searchTurn(now);
    case "notfound": return notFoundTurn();
    case "cmdj": return cmdjTurn(now);
  }
}

/** A transcript as the SSE body `POST /ask` sends (`event:` + `data:` per message). */
export function askTranscriptSse(steps: readonly AskTranscriptStep[]): string {
  return steps.map((s) => `event: ${s.event.event}\ndata: ${JSON.stringify(s.event.data)}\n\n`).join("");
}

// ── feed.importance (Phase C) ───────────────────────────────────────────────
/** Two AGENT entries Sift rated, as `/feed` rows, so the Feed's notable and breaking marks show under `wrangler dev`
 *  (merged in beside `feedFixtures` by the preview: src/ai/preview.ts `previewFeedRows`). A routine or unrated entry
 *  draws no mark, so neither needs a sample. Ids sit far above any real row's, like the Trov entries'. */
export function feedImportanceFixtures(now: Date): FeedRow[] {
  return [
    {
      id: 990_101,
      author: "andres",
      summary: "Organization addresses move from /o/<slug>/ to /<slug>/",
      brief: "Every link to an organization changes. Old /o/ links redirect for now; update bookmarks and any agent config that names the old path.",
      body: null,
      artifacts: JSON.stringify({ prs: ["111"], commits: [], issues: [] }),
      created_at: ago(now, 3 * HOUR),
      tags: ["api"],
      importance: "breaking",
    },
    {
      id: 990_102,
      author: "andres",
      summary: "Tags of your own, sorted by Sift",
      brief: "Each organization now keeps its own tag list, and Sift tags existing feed entries, docs and decisions when a tag is added.",
      body: null,
      artifacts: JSON.stringify({ prs: ["179"], commits: [], issues: [] }),
      created_at: ago(now, 26 * HOUR),
      tags: ["ui"],
      importance: "notable",
    },
  ];
}

// ── Phase C: the card suggestions (the ticket detail, Unplaced, Review) ─────
// What `LOCAL_AI_PREVIEW` puts on three REAL reads (src/ai/attach.ts): an open ticket's detail gets a category, a
// priority and a possible duplicate; the first doc-shaped Unplaced item a destination; the first two staged
// proposals and the first two drafted decisions a risk. Ids are made up and EACH sample has its own (Q38: a shared id
// opened two "because…" at once): 901–903 the ticket, 904 Unplaced, 905–906 the proposals, 907–908 the drafted
// decisions, 910–915 the proposed themes, 9101–9102 the Roadmap's cards — no row has them, so nothing real changes.
// `empty` and `capped` show none (no suggestion is these screens' normal state).
const sugg = (o: Omit<AiSuggestion, "state" | "label"> & { label?: string }): AiSuggestion =>
  ({ state: "open", label: o.label ?? (typeof o.value === "string" ? o.value : JSON.stringify(o.value)), ...o });

/** The ticket card's three suggestions for ticket `n` (the duplicate names `other`, another ticket of the org). */
export function ticketSuggestionsFixture(mode: AiPreviewMode, n: number, other: { number: number; title: string } | null): AiSuggestion[] {
  if (mode === "empty" || mode === "capped") return [];
  const ref = String(n);
  const out: AiSuggestion[] = [
    sugg({ id: 901, itemType: "ticket", itemRef: ref, kind: "ticket.category", value: "bug", reason: "it says “…the login page is blank on Safari…”", confidence: 0.91, cites: [] }),
    sugg({ id: 902, itemType: "ticket", itemRef: ref, kind: "ticket.priority", value: "high", reason: "it says “…blocks everyone on the team from signing in…”", confidence: 0.83, cites: [] }),
  ];
  if (other && other.number !== n) {
    out.push(sugg({
      id: 903, itemType: "ticket", itemRef: ref, kind: "ticket.duplicate", value: { number: other.number, label: `#${other.number} ${other.title}` },
      label: `#${other.number} ${other.title}`, reason: "both mention “login”, “safari” and “blank”", confidence: 0.94,
      cites: [{ ref: `ticket:${other.number}`, label: `#${other.number}`, href: `#tickets/${other.number}` }],
    }));
  }
  return out;
}

/** An Unplaced item's suggested destination. */
export function unplacedSuggestionFixture(mode: AiPreviewMode, id: number): AiSuggestion | null {
  if (mode === "empty" || mode === "capped") return null;
  return sugg({
    id: 904, itemType: "unplaced", itemRef: String(id), kind: "unplaced.destination",
    value: { type: "doc", section: "reference", near: null, label: "reference" }, label: "reference",
    reason: "the agent filed it under “runbooks” (not a section); it reads “Deploy checklist”", confidence: 0.81, cites: [],
  });
}

/** Review items' risks, per list (the proposals and the drafted decisions are read apart): the first changes a
 *  decision, the second contradicts a doc. A drafted decision's ids follow the proposals' (907, 908). */
export function reviewRiskFixture(mode: AiPreviewMode, ref: string, index: number, list: "proposals" | "adrs" = "proposals"): AiSuggestion | null {
  if (mode === "empty" || mode === "capped" || index > 1) return null;
  const base = list === "adrs" ? 907 : 905;
  return index === 0
    ? sugg({
        id: base, itemType: "proposal", itemRef: ref, kind: "review.risk", value: { risk: "decision", label: "Changes a decision" }, label: "Changes a decision",
        reason: "it replaces “A session lasts 7 days.” with “A session lasts 30 days.”; the ratified decision “Short sessions” covers the same ground",
        confidence: 0.78, cites: [{ ref: "adr:3", label: "ADR-003", href: null }],
      })
    : sugg({
        id: base + 1, itemType: "proposal", itemRef: ref, kind: "review.risk", value: { risk: "contradicts", label: "Contradicts a doc" }, label: "Contradicts a doc",
        reason: "it decides “Use D1's FTS5.”; the live doc “Search” covers the same ground", confidence: 0.66, cites: [{ ref: "doc:search", label: "Search", href: null }],
      });
}

// ── Roadmap (Phase D): sprint notes, the drift line, an admin's suggestion cards ──────────────────────
/** What the preview puts on `GET /roadmap`: one note per ACTIVE sprint (in roadmap order — the preview hands
 *  them out to the active sprints it finds), the drift line, and the two open suggestions an ADMIN sees. `empty`
 *  is nothing written (every field absent); `capped` keeps what was last written. The suggestion ids are the
 *  preview's own: Accept on one answers as an unknown suggestion would. */
export interface AiRoadmapFixture { notes: AiSprintNote[]; drift: AiPlanDrift; suggestions: AiSuggestion[] }

export function roadmapFixture(state: AiState, now: Date): AiRoadmapFixture | null {
  if (state === "empty") return null;
  const at = ago(now, state === "capped" ? 6 * DAY : 4 * HOUR);
  const note = (text: string, cites: AiCite[]): AiSprintNote => ({ text, cites, generatedAt: at, model: AI_MODEL });
  const draft: AiSprintDraftValue = {
    sprints: [
      { name: "Hosting polish", goal: "Close out the hosting connect flow and its failing Netlify test.", tickets: [21, 24, 27, 30] },
      { name: "Billing follow-ups", goal: "Seat changes and the receipts page.", tickets: [22, 25, 29] },
      { name: "Docs and onboarding", goal: "The public docs gaps people asked about.", tickets: [23, 26, 28] },
    ],
  };
  const narrative: AiPlanNarrativeValue = {
    now: "Hosting connections and their deploy history.",
    next: "Billing follow-ups: seat changes and the receipts page.",
    later: "The public docs and onboarding.",
  };
  return {
    notes: [
      note("Two of five done; the other three wait on the Netlify connect test.", [ticket(21), ticket(24), pr(173)]),
      note("Seat changes landed; the receipts page has no owner yet.", [ticket(22), ticket(25)]),
    ],
    drift: {
      text: "The last two weeks went mostly to Billing and plans, which isn't in any sprint.",
      cites: [{ ref: "theme:billing", label: "Billing and plans", href: "#repo/planning" }],
      generatedAt: at, model: AI_MODEL, windowDays: 14,
      shares: [
        { themeId: "billing", theme: "Billing and plans", pct: 46, inSprint: false },
        { themeId: "repo", theme: "Repo dashboard", pct: 31, inSprint: true },
        { themeId: "polish", theme: "UI polish", pct: 23, inSprint: false },
      ],
    },
    suggestions: [
      {
        id: 9101, itemType: "roadmap", itemRef: "org", kind: "sprint_draft", value: draft, label: "3 sprints from 10 backlog tickets",
        reason: "ten open tickets sit outside any sprint and none is active; they group by what they touch.",
        confidence: null, cites: [ticket(21), ticket(22), ticket(23)], state: "open",
      },
      {
        id: 9102, itemType: "roadmap", itemRef: "org", kind: "plan_narrative", value: narrative, label: "a new plan narrative",
        reason: "the narrative still leads with tickets, and this week's work went to hosting and billing.",
        confidence: null, cites: [pr(173), ticket(22)], state: "open",
      },
    ],
  };
}
