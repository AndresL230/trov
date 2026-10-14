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

// ── Repo › Planning › "Where the work went" ─────────────────────────────────
export const AI_THEME_RANGES = ["8w", "quarter"] as const;
export type AiThemeRange = (typeof AI_THEME_RANGES)[number];
export const AI_THEME_RANGE_LABELS: Record<AiThemeRange, string> = { "8w": "8 weeks", quarter: "Quarter" };
/** Weeks per range (UTC Monday weeks, oldest first). */
export const AI_THEME_RANGE_WEEKS: Record<AiThemeRange, number> = { "8w": 8, quarter: 13 };

/** The `--p-*` palette keys a lane may use (web/src/trov.css; `ink` is a text colour, not a lane). */
export const AI_THEME_COLORS = ["moss", "fern", "sky", "slate", "plum", "rose", "rust", "ochre", "clay", "stone"] as const;
export type AiThemeColor = (typeof AI_THEME_COLORS)[number];

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

/** `RepoDashboard.themes?` is `Record<AiThemeRange, AiThemes>`: the screen's 8 weeks / Quarter
 *  switch changes ranges client-side. On `empty`, lanes and weeks are []. */
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
export const AI_ITEM_TYPES = ["brief", "repo_state", "feed", "themes", "suggestion"] as const;
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
} as const;

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
  settings: "/ai/settings",                       // GET → AiSettings; PUT { enabled } (admin) → AiSettings
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

/** One line of "What is sent to Anthropic". Grows as features land; today only summaries. */
export interface AiSendLine { what: string; for: string }
export const AI_SENDS: readonly AiSendLine[] = [
  { what: "Pull request and issue titles and descriptions (up to 8,000 characters each)", for: "Summaries" },
];
/** Never sent, whatever lands. */
export const AI_NEVER_SENT = "Source code, diffs, secrets, integration keys, and anything from another organization.";

export interface AiSettings {
  /** `orgs.ai_automation`. */
  enabled: boolean;
  /** The caller is an admin: the switch is theirs to change. Members see its state. */
  canEdit: boolean;
  eligibility: AiEligibility;
  /** This calendar month (UTC) against the plan's `ai_runs`; `cap` null = unlimited. */
  runs: { used: number; cap: number | null; resumesOn: string | null };
  sends: AiSendLine[];
  neverSent: string;
}

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
}
