// The AI contracts, value half: zod-free, so the SPA can import the constants and the
// types without pulling zod into the browser bundle. `shared/ai.ts` holds the zod
// schemas for the same shapes and re-exports everything here — `@shared/ai` is the one
// import path on the server, `@shared/ai-core` on the web.
//
// What is DECIDED here: the shapes the four screens render (My Work's brief, Repo ›
// Overview's State, Feed entries written by Trov, Repo › Planning's "Where the work
// went"), the AI settings / suggestion / feedback wire, and the allowance vocabulary.
// What is NOT: which events make the model run, or what it writes. No producer exists
// yet (docs/superpowers/specs/2026-10-14-ai-base.md), so production reads omit every
// field below; only `LOCAL_AI_PREVIEW` under `wrangler dev` fills them, from
// `shared/ai-fixtures.ts`.
//
// OFF IS NOT A STATE. A screen whose org has the switch off, or a deployment with no
// key, gets NO field at all (or a `not_connected` section where the read already uses
// `RepoSection`) — never `state: "off"`. A present field is always one of AI_STATES.

/** The model every kind runs on today (src/ai/client.ts `providerFor`). */
export const AI_MODEL = "claude-haiku-5-5";

/** What a written item can say about itself. `capped` keeps the LAST written content
 *  (when there is one) and adds `resumesOn`. */
export const AI_STATES = ["ready", "empty", "capped"] as const;
export type AiState = (typeof AI_STATES)[number];

/** Every written DTO carries these. `generatedAt` / `model` are null when nothing has been
 *  written yet (always on `empty`; on `capped` when the cap came before the first write).
 *  `resumesOn` is the first day of next month (`YYYY-MM-DD`), set only on `capped`.
 *  `upgrade` is true when the capped org is on Free: the screen adds "Upgrade to Pro". */
export interface AiMeta {
  state: AiState;
  generatedAt: string | null;
  model: string | null;
  resumesOn: string | null;
  upgrade: boolean;
}

/** One source a written line links to. The SERVER builds `label` and `href` from rows it
 *  read (a PR's number and URL, a ticket's `#N` and app route…); the model only ever names
 *  a `ref` that was in its input. `href` is an absolute URL (GitHub) or an in-app hash
 *  route (`#tickets/14`); null when the source has no page. */
export interface AiCite {
  ref: string;          // "pr:173", "issue:12", "ticket:14", "handoff:3", "run:4812", "sha:65b9f1f", "branch:feat/x", "feed:107"
  label: string;        // "#173", "CI run 4812", "feat/hosting-screens", "handoff #3"
  href: string | null;
}

/** A written sentence and what it was written from. */
export interface AiLine {
  text: string;
  cites: AiCite[];
}

/** The reserved system person Trov's own writing is recorded as (`RESERVED_HANDLES` in src/auth/persons.ts; its
 *  `persons` row arrives with `0061_ai_digests`): the author of AI feed entries and doc-drift proposals — the one
 *  exception to "the author is the authenticated principal" (ingestion-gate.md). */
export const TROV_SYSTEM_HANDLE = "trov";

// ── My Work › "Your brief" ──────────────────────────────────────────────────
/** What a Next row is; picks its state mark (Failing = red dot, Handoff = arrow, a ticket
 *  shows its `#N`, a sprint ticket due soon = the due mark). */
export const AI_NEXT_KINDS = ["failing", "handoff", "ticket", "due"] as const;
export type AiNextKind = (typeof AI_NEXT_KINDS)[number];

export interface AiBriefNextItem {
  /** The real item this row is (one of the items the server offered the model). */
  ref: string;
  kind: AiNextKind;
  /** The item's own title, from its row — never model text. */
  title: string;
  /** The model's one muted line: why this is next. */
  why: string;
  /** `cites[0]` is the item itself: the row's title links to its `href`. */
  cites: AiCite[];
}

/** `GET /me/dashboard` → `brief?`, and `get_my_work` → `brief?`. On `empty`, `now` and
 *  `recently` are null and `next.items` is []. On `capped`, they hold the last brief, if any. */
export interface AiBrief extends AiMeta {
  now: AiLine | null;
  recently: AiLine | null;
  next: { items: AiBriefNextItem[] };
}

// ── Repo › Overview › "State" ───────────────────────────────────────────────
/** `RepoDashboard.state?`. Each list is at most AI_LIST_MAX long. `eventCount` is counted
 *  by the server ("Written by Trov from 6 events"); null when unknown, never a guessed 0. */
export interface AiRepoState extends AiMeta {
  headline: string | null;
  shipped: AiLine[];
  inFlight: AiLine[];
  attention: AiLine[];
  eventCount: number | null;
}
export const AI_LIST_MAX = 5;

// ── Feed: entries written by Trov ───────────────────────────────────────────
export const AI_ORIGINS = ["agent", "ai"] as const;
export type AiOrigin = (typeof AI_ORIGINS)[number];

/** `FeedRow.ai?`. An entry with no `ai` is an agent's, as every entry is today. An entry
 *  written by Trov has `origin: "ai"`, its author is the system handle, and `subject` is
 *  the person it was written for ("Trov for <subject>"). `sources` are the first cites
 *  shown ("From #173, 65b9f1f, a1c04e2"); `moreCount` the rest ("and 2 more"). No `state`:
 *  an entry exists or it does not. */
export interface AiFeedMeta {
  origin: AiOrigin;
  subject: string | null;
  sources: AiCite[];
  moreCount: number;
  generatedAt: string | null;
  model: string | null;
}
/** How many sources an entry shows before "and N more". */
export const AI_FEED_SOURCES_SHOWN = 3;

// ── feed.importance (Phase C; 0060_ai_importance) ───────────────────────────
/** How much a feed entry or a merged PR matters, as Sift rated it (`feed.importance`, `pr_summaries.importance`):
 *  a COMPUTED fact, not a suggestion. Absent on a read = unknown (never rated, or Sift was unsure) — never a guessed
 *  `routine`. The Feed marks `notable` and `breaking` only; `routine` and absent draw nothing. */
export const FEED_IMPORTANCES = ["routine", "notable", "breaking"] as const;
export type FeedImportance = (typeof FEED_IMPORTANCES)[number];
export const isFeedImportance = (v: unknown): v is FeedImportance => typeof v === "string" && (FEED_IMPORTANCES as readonly string[]).includes(v);

// ── Repo › Planning › "Where the work went" ─────────────────────────────────
export const AI_THEME_RANGES = ["8w", "quarter"] as const;
export type AiThemeRange = (typeof AI_THEME_RANGES)[number];
export const AI_THEME_RANGE_LABELS: Record<AiThemeRange, string> = { "8w": "8 weeks", quarter: "Quarter" };
/** Weeks per range (UTC Monday weeks, oldest first). */
export const AI_THEME_RANGE_WEEKS: Record<AiThemeRange, number> = { "8w": 8, quarter: 13 };

/** The `--p-*` palette keys a lane may use (web/src/trov.css; `ink` is a text colour, not a lane). */
export const AI_THEME_COLORS = ["moss", "fern", "sky", "slate", "plum", "rose", "rust", "ochre", "clay", "stone"] as const;
export type AiThemeColor = (typeof AI_THEME_COLORS)[number];

/** A theme name's longest (the accept handler's check, and the Rename field's maxlength). */
export const AI_THEME_NAME_MAX = 40;

export const AI_THEME_STATUSES = ["proposed", "active"] as const;
export type AiThemeStatus = (typeof AI_THEME_STATUSES)[number];

export interface AiThemeLane {
  id: string;
  name: string;
  colorKey: AiThemeColor;
  description: string;
  /** Merged PRs per week, aligned with `AiThemes.weeks`; counted by the server. 0 = no band. */
  counts: number[];
  /** The lane's PRs, shown under the chart when the lane is selected. */
  prs: AiCite[];
  status: AiThemeStatus;
  /** The open suggestion behind a PROPOSED lane: Accept / Rename / Remove act on it through the
   *  suggestion routes. Null on an active lane. */
  suggestionId: number | null;
}

/** `RepoDashboard.themes?` is `Partial<Record<AiThemeRange, AiThemes>>`: the screen's 8 weeks / Quarter
 *  switch changes ranges client-side; a range the person marked "Wrong?" is left out (for them only). On `empty`, lanes and weeks are []. */
export interface AiThemes extends AiMeta {
  caption: string | null;
  /** "from N pull requests" — counted by the server; null when unknown. */
  prCount: number | null;
  range: AiThemeRange;
  /** Each week's Monday, `YYYY-MM-DD`, oldest first. */
  weeks: string[];
  lanes: AiThemeLane[];
}

// ── Suggestions (#156/#157) and "Wrong?" feedback (#158) ────────────────────
export const AI_SUGGESTION_STATES = ["open", "accepted", "dismissed", "superseded"] as const;
export type AiSuggestionState = (typeof AI_SUGGESTION_STATES)[number];

/** A suggestion as a screen shows it: "Suggested: <label>, because <reason>". A suggestion
 *  with no reason is never sent. `value` is the kind's own shape (the accept handler reads it). */
export interface AiSuggestion {
  id: number;
  itemType: string;
  itemRef: string;
  kind: string;
  value: unknown;
  label: string;
  reason: string;
  confidence: number | null;
  cites: AiCite[];
  state: AiSuggestionState;
}

/** What "Wrong?" can be pressed on. */
export const AI_ITEM_TYPES = ["brief", "repo_state", "feed", "themes", "suggestion", "sprint_note", "plan_drift"] as const;
export type AiItemType = (typeof AI_ITEM_TYPES)[number];

/** The `itemRef` "Wrong?" sends for each item type — ONE definition for the screen that sends it and
 *  the reads that hide what a person flagged. A written item is identified by what it is about and
 *  when it was written, so flagging one version never hides the next. */
export const aiItemRef = {
  brief: (generatedAt: string): string => generatedAt,
  repoState: (repo: string, generatedAt: string): string => `${repo}@${generatedAt}`,
  themes: (repo: string, range: AiThemeRange, generatedAt: string): string => `${repo}:${range}@${generatedAt}`,
  feed: (id: number): string => String(id),
  suggestion: (id: number): string => String(id),
  sprintNote: (sprintId: number, generatedAt: string): string => `${sprintId}@${generatedAt}`,
  planDrift: (generatedAt: string): string => generatedAt,
} as const;

// ── Roadmap (Phase D, Feature E): sprint notes, plan drift, and two suggestions ─────────────────────
/** One written line on the Roadmap (`org_insights`, 0065): the words, their checked sources, and when and by
 *  which model they were written. Only ever present while the org's switch is on (absent otherwise). */
export interface AiRoadmapLine {
  text: string;
  cites: AiCite[];
  generatedAt: string;
  model: string | null;
}
/** `SprintView.note?` — one line per ACTIVE sprint ("Two of five done; the other three wait on hosting"). */
export type AiSprintNote = AiRoadmapLine;
/** A theme's share of the merged pull requests in the drift's window, COUNTED BY THE SERVER, and whether any
 *  active sprint holds work of that theme. */
export interface AiThemeShare { themeId: string; theme: string; pct: number; inSprint: boolean }
/** `PlanView.drift?` — "The last two weeks went mostly to Billing, which isn't in any sprint". Every number in
 *  `text` is one of the numbers in `shares` / `windowDays`: the model is given them and may use no other. */
export interface AiPlanDrift extends AiRoadmapLine {
  windowDays: number;
  shares: AiThemeShare[];
}
/** How many days a drift describes, and how long the Roadmap shows it after it was written. */
export const AI_DRIFT_WINDOW_DAYS = 14;

/** The Roadmap's suggestion kinds (`ai_suggestions.kind`, item `roadmap` / `org`): an admin accepts them, and
 *  accepting runs the existing writers as that admin. */
export const AI_ROADMAP_SUGGESTION_KINDS = ["sprint_draft", "plan_narrative"] as const;
export type AiRoadmapSuggestionKind = (typeof AI_ROADMAP_SUGGESTION_KINDS)[number];
/** The item every Roadmap suggestion is about: the organization's plan. */
export const AI_ROADMAP_ITEM = { itemType: "roadmap", itemRef: "org" } as const;
/** A sprint draft's value: 2–4 sprints, each a name, a one-line goal, and backlog tickets by their NUMBER. */
export interface AiSprintDraftValue { sprints: { name: string; goal: string; tickets: number[] }[] }
/** A proposed plan narrative (at most `PLAN_NARRATIVE_MAX` characters). */
export interface AiPlanNarrativeValue { narrative: string }

/** `POST /ai/feedback` — hides the item for the person who pressed it; never edits the record. */
export interface AiFeedbackBody {
  itemType: AiItemType;
  itemRef: string;
  kind: string;
  model: string | null;
  promptVersion: string | null;
}

/** `POST /ai/suggestions/:id/accept` — `value` replaces the suggested value (Rename). */
export interface AiAcceptBody { value?: unknown }

/** Refusal codes the suggestion routes answer with (`{ error }`): `not_found` 404, `not_open` and
 *  `not_available` 409 (no accept handler is registered for the suggestion's kind yet — every kind,
 *  today), `forbidden` 403, `invalid` 400 (a body the schema refuses). */
export const AI_SUGGESTION_ERRORS = ["not_found", "not_open", "not_available", "forbidden", "invalid"] as const;
export type AiSuggestionError = (typeof AI_SUGGESTION_ERRORS)[number];

/** Tenant routes (cookie only, under `/api/o/:slug`). */
export const AI_ROUTES = {
  settings: "/ai/settings",                       // GET → AiSettings; PUT AiSettingsPut (admin) → AiSettings
  accept: (id: number) => `/ai/suggestions/${id}/accept`,   // POST AiAcceptBody
  dismiss: (id: number) => `/ai/suggestions/${id}/dismiss`, // POST {}
  feedback: "/ai/feedback",                       // POST AiFeedbackBody
} as const;

/** The first day of next month (UTC), `YYYY-MM-DD` — when a capped monthly allowance resumes. */
export function nextMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

// ── Org settings › AI ───────────────────────────────────────────────────────
export const AI_ELIGIBILITY = ["ok", "off", "no_key", "capped"] as const;
export type AiEligibility = (typeof AI_ELIGIBILITY)[number];

/** Who receives what Trov sends — the providers BY THEIR LEGAL NAMES (what the Privacy Policy names). A
 *  screen calls TypeSafe AI's model "Sift", never by its own name. */
export const AI_PROVIDER_NAMES = ["Anthropic", "TypeSafe AI"] as const;
export type AiProviderLabel = (typeof AI_PROVIDER_NAMES)[number];

/** One line of "What is sent": to whom, what, and for which feature. Grows as features land. */
export interface AiSendLine { provider: AiProviderLabel; what: string; for: string }
//   One line per AI row of the Privacy Policy's service-provider table (web/src/legal.ts › sharing), in its words,
//   shortened — test/render.ai.test.ts holds the two to the same count. The Ask Trov, filter, notes and sorting
//   lines follow passages still marked DRAFT there; change both together.
export const AI_SENDS: readonly AiSendLine[] = [
  { provider: "Anthropic", what: "Pull request and issue titles and descriptions (up to 8,000 characters each)", for: "Summaries" },
  {
    provider: "Anthropic",
    what: "The question and the conversation so far, the person's handle and role and what they said about how to answer them, the items Ask Trov reads to answer (only ones that person can see), and any file they attach",
    for: "Ask Trov",
  },
  {
    provider: "Anthropic",
    what: "What a person types in a filter, with the organization's members' handles and names and its sprints' titles or its tags",
    for: "Filters typed in plain words",
  },
  {
    provider: "Anthropic",
    what: "The organization's name, tags, active themes, sprints and plan, and what is being written from: the summaries Trov already made, commit messages and pull request titles, check and deploy results, tickets, handoffs and feed entries, and a doc with the entries that may disagree with it",
    for: "Notes, briefs, the weekly email's highlights and suggestions",
  },
  {
    provider: "TypeSafe AI",
    what: "A tag's name and description, and the title and first 400 characters of each feed entry, doc or decision that may fit it (code and anything shaped like a credential removed)",
    for: "Sift",
  },
  {
    provider: "TypeSafe AI",
    what: "One item at a time (a ticket, feed entry, pull request summary, doc proposal or unplaced item) as its title and a short excerpt, code and anything shaped like a credential removed, with the choices it is judged against; and, to decide whether something is worth writing about, commit messages, pull request titles and what changed in a repository",
    for: "Sorting and checking items",
  },
];
/** Never sent, whatever lands — except a file a person attaches to Ask Trov, which is sent as it is (owner ruling
 *  2026-10-15; the Privacy Policy says the same, web/src/legal.ts › Privacy 4). */
export const AI_NEVER_SENT = "Source code (unless you attach a file to Ask), diffs, secrets, integration keys, and anything from another organization.";

/** The four AI allowances Org settings › AI shows, by their `LimitKey` (shared/plans.ts), in order:
 *  capture-time summaries (Anthropic), what the AI pass writes (Anthropic), Sift's checks (TypeSafe AI),
 *  and Ask Trov (Anthropic, questions). */
export const AI_ALLOWANCE_KEYS = ["ai_summaries", "ai_runs", "jev_checks", "ai_chat"] as const;
export type AiAllowanceKey = (typeof AI_ALLOWANCE_KEYS)[number];

/** One allowance this calendar month (UTC): `cap` null = unlimited (Pro's `ai_chat` is already its seats ×
 *  the per-seat amount); `resumesOn` (`YYYY-MM-DD`, the 1st of next month) only when it is used up. */
export interface AiAllowanceUse { used: number; cap: number | null; resumesOn: string | null }

export interface AiSettings {
  /** `orgs.ai_automation` — the switch every AI feature (Sift included) sits under. */
  enabled: boolean;
  /** The caller is an admin: the switches are theirs to change. Members see their state. */
  canEdit: boolean;
  eligibility: AiEligibility;
  /** This month's use of each AI allowance. */
  allowances: Record<AiAllowanceKey, AiAllowanceUse>;
  /** `orgs.ai_chat_auto` (0058) — whether Ask Trov's Auto mode (writes run without a Confirm, with Undo)
   *  may be used in this organization. */
  chatAuto: boolean;
  sends: AiSendLine[];
  neverSent: string;
}

/** `PUT /ai/settings` (admin+): either switch, or both. */
export interface AiSettingsPut { enabled?: boolean; chatAuto?: boolean }

// ── Platform › Usage ────────────────────────────────────────────────────────
/** `OrgUsage.ai?` / `PlatformUsageResponse.ai?`: AI runs and tokens in the window
 *  (`org_usage_daily`, metrics `ai_run:*`, `ai_run_failed:*`, `ai_run_capped:*`, `ai_tokens_*`). */
export interface AiUsage {
  runs: number;
  failed: number;
  capped: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** TypeSafe AI's side (Phase B: token metrics per provider) — Jev requests (`ai_suggest`: Sift's and the AI
   *  pass's, what `jev_checks` counts) and their tokens (`ai_jev_tokens_in` / `_out`). Optional: a read from before
   *  them (and the preview fixtures) leaves them out, and the screen then draws exactly what it did. */
  jevChecks?: number;
  jevTokensIn?: number;
  jevTokensOut?: number;
}

// ── The router's scopes and their debounce (docs/architecture/ai.md › Scopes and debounce) ──────────
/** What a write can make stale (`ai_dirty.scope`, 0058). A scope's KEY says which one: `card` → `pr:173`,
 *  `ticket:14`, `feed:<id>`, `proposal:doc:<slug>:<version>` / `proposal:adr:<id>`, `unplaced:<id>`,
 *  `tagfit:doc:<slug>` / `tagfit:artifact:<slug>`; `session` → `<repo>:<login>`; `person` → a handle; `repo`,
 *  `theme_window`, `theme_backfill` → `owner/repo`; `sprint` → a sprint id; `org` → ''; `doc_drift` → a doc's slug
 *  (`artifact:<slug>` for an artifact); `digest` → `week:<YYYY-Www>:<send instant>` (`weekScopeKey`, the weekly
 *  e-mail's "This week", Phase E). */
export const AI_SCOPES = ["session", "card", "person", "repo", "org", "sprint", "theme_window", "theme_backfill", "doc_drift", "digest"] as const;
export type AiScope = (typeof AI_SCOPES)[number];
export const isAiScope = (v: unknown): v is AiScope => typeof v === "string" && (AI_SCOPES as readonly string[]).includes(v);

/** THE PASS ORDER: each org's due scopes run in these stages, first to last — sessions, cards, briefs, repo
 *  state, the org rollup, themes, doc drift, the weekly e-mail's highlights — so a later stage reads what an earlier
 *  one just wrote. */
export const AI_PASS_STAGES: readonly (readonly AiScope[])[] = [
  ["session"], ["card"], ["person"], ["repo"], ["org", "sprint"], ["theme_window", "theme_backfill"], ["doc_drift"], ["digest"],
];

/** The `digest` scope's key for one weekly e-mail: its window id and the instant it is sent (the window's end). The
 *  key carries the end so the job reads the SAME window when it submits and again when it collects the answer. */
export const weekScopeKey = (weekId: string, sendAt: Date): string => `week:${weekId}:${sendAt.toISOString()}`;
/** The parts of a `digest` key, or null (a key from elsewhere, or a malformed one). */
export function parseWeekScopeKey(key: string): { weekId: string; end: Date } | null {
  const m = /^week:(\d{4}-W\d{2}):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/.exec(key);
  if (!m) return null;
  const end = new Date(m[2]);
  return Number.isFinite(end.getTime()) ? { weekId: m[1], end } : null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The plan ids that get the short debounce (Pro is `team`, shared/plans.ts); every other plan — Free, Personal,
 *  an unknown id — gets the long one. Kept as strings so this file needs nothing from shared/plans.ts. */
const SHORT_DEBOUNCE_PLANS: readonly string[] = ["team", "enterprise"];

/**
 * How long a scope waits after it went stale before the pass runs it (the decided table, Phase B):
 *
 *   | scope            | Pro / Enterprise                          | Free / Personal |
 *   | `session`        | closes 45 min after its LAST event        | same            |
 *   | `card`           | next tick (0)                             | next tick (0)   |
 *   | `person`         | 30 min                                    | 2 h             |
 *   | `repo`           | 60 min — a breaking change skips it       | 6 h             |
 *   | `org`, `sprint`  | 6 h                                       | 24 h            |
 *   | `theme_window`   | daily                                     | weekly          |
 *   | `doc_drift`      | weekly                                    | monthly (30 d)  |
 *   | `theme_backfill` | next tick (0) — not in the table: it is the accept's own follow-up, through the Batch API |
 *   | `digest`         | next tick (0) — Phase E: marked once, hours before the weekly send, through the Batch API |
 *
 * `urgent` (`ai_dirty.urgent`, set by the caller that marks): a BREAKING change on a `repo` skips the wait on Pro
 * and Enterprise only (the table's own parenthesis); the digest PRE-WARM on a `person` skips it on every plan (the
 * brief must be ready for the send). On any other scope it changes nothing. The wait counts from `dirty_since`
 * (the FIRST mark since the last run), except a session's, which counts from its last mark (`debounceFrom`).
 */
export function debounceMs(scope: AiScope, plan: string, opts: { urgent?: boolean } = {}): number {
  const short = SHORT_DEBOUNCE_PLANS.includes(plan);
  switch (scope) {
    case "session": return 45 * MINUTE;
    case "card": case "theme_backfill": case "digest": return 0;
    case "person": return opts.urgent ? 0 : short ? 30 * MINUTE : 2 * HOUR;
    case "repo": return opts.urgent && short ? 0 : short ? HOUR : 6 * HOUR;
    case "org": case "sprint": return short ? 6 * HOUR : DAY;
    case "theme_window": return short ? DAY : 7 * DAY;
    case "doc_drift": return short ? 7 * DAY : 30 * DAY;
  }
}

/** Which mark a scope's debounce counts from: a session's LAST event (`marked_at`); every other scope's FIRST
 *  mark since its last run (`dirty_since`), so a steady trickle of marks cannot hold it back forever. */
export const debounceFrom = (scope: AiScope): "last" | "first" => (scope === "session" ? "last" : "first");
