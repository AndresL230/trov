// The Repo dashboard DTO — shared by the Worker (`src/tools/repo.ts`) and the web
// build (`web/src/repo.ts`). Zod-free on purpose: the SPA imports REPO_TABS as a
// VALUE, and the browser bundle never drags zod in (see the `*-core.ts` rule).
//
// Every section travels as a `RepoSection<T>` so the screen can tell "nothing
// happened" (`empty`) from "Canopy has no capture path for this yet"
// (`not_connected`). The projection is D1-only; anything it cannot read from D1
// is `not_connected`, never guessed.

import type { PersonColor } from "./rows";

export const REPO_TABS = [
  ["overview", "Overview"],
  ["code", "Code"],
  ["ci", "CI & Deploys"],
  ["usage", "Usage"],
  ["planning", "Team & Planning"],
] as const;
export type RepoTab = (typeof REPO_TABS)[number][0];
export const isRepoTab = (v: string): v is RepoTab => REPO_TABS.some(([k]) => k === v);

export const REPO_RANGES = ["24h", "7d", "30d"] as const;
export type RepoRange = (typeof REPO_RANGES)[number];

export type RepoSection<T> =
  | { status: "ok"; data: T }
  | { status: "empty" }
  | { status: "not_connected" };

/** Status colors carry meaning only: good = green, warn = amber, bad = red. */
export type RepoTone = "neutral" | "good" | "warn" | "bad";

/** A GitHub login, resolved to a person when the github identity is mapped. */
export interface RepoPerson {
  login: string;
  handle: string | null;
  name: string | null;
  color: PersonColor | null;
}

// ── Overview ────────────────────────────────────────────────────────────────
/** An environment ships TWO deployables: a Railway backend and a Cloudflare
 *  frontend. They move independently, so each half carries its own sha. */
export type RepoPartName = "backend" | "frontend";
export interface RepoEnvPart {
  part: RepoPartName;
  host: "Railway" | "Cloudflare";
  /** Null = no deploy captured for this half yet — never a guessed sha. */
  sha: string | null;
  deployedAt: string | null;
  /** The human who pushed that sha; the deploying bot when no push was captured. */
  deployedBy: string | null;
  result: "ok" | "fail" | "cancel" | "running" | null;
}
export interface RepoEnv {
  /** The configured env key the capture is stored under ("staging"). */
  key: string;
  name: string;
  /** e.g. "production" beside `main`. */
  note: string | null;
  tone: RepoTone;
  pill: string;
  parts: RepoEnvPart[];
  /** "All 8 checks passing" | "1 of 8 checks failing — e2e". */
  ci: string;
  ciTone: RepoTone;
  url: string;
}
export interface RepoDriftCommit { sha: string; msg: string; at: string }
export interface RepoDriftGroup {
  /** "#482", or the two non-PR buckets "PUSH" / "BEHIND". */
  tag: string;
  kind: "pr" | "push" | "behind";
  title: string;
  meta: string;
  commits: RepoDriftCommit[];
}
export interface RepoDrift { head: string; base: string; ahead: number; behind: number; groups: RepoDriftGroup[] }
export interface RepoStat { label: string; value: number; delta: number; tone: RepoTone }
export interface RepoHealth { env: string; url: string; up: boolean; ms: number }

// ── Code ────────────────────────────────────────────────────────────────────
export interface RepoCodeStat { label: string; value: number; sub: string; tone: RepoTone }
export interface RepoBars { title: string; note: string; days: { date: string; count: number }[] }
export type RepoPrState = "draft" | "review" | "approved" | "merged" | "closed";
export interface RepoPr {
  number: number;
  title: string;
  url: string;
  author: RepoPerson;
  /** The head branch when known, else `→ <base>` from the captured base ref. */
  branch: string | null;
  state: RepoPrState;
  /** Absent when no check data is captured — the column then renders nothing. */
  checks: "pass" | "fail" | "run" | null;
  at: string;
}
/** The PR list (`rows`, at most 8 — the latest state per PR touched in 90 days,
 *  merged/closed included) and the REAL open-PR count beside it. `openCount` is
 *  the Overview's "Open PRs" figure (one definition: every PR whose latest
 *  captured state is draft/review), published only once the `prs_reconciled`
 *  marker exists; `null` before that = unknown, never 0 — and `rows` is then
 *  the merged/closed list from `events`. Never count open PRs from `rows`. */
export interface RepoPrList { rows: RepoPr[]; openCount: number | null }
export interface RepoBranch { name: string; at: string; ahead: number; behind: number; stale: boolean }
/** `head` is the branch every row's ahead/behind was compared against (the
 *  first configured environment's branch). It is a stored snapshot, so one
 *  written before `head` was recorded lacks it — the screen then shows the
 *  counts with no "vs …" rather than guess a branch name. */
export interface RepoBranches { active: number; stale: number; head?: string; rows: RepoBranch[] }

// ── CI & Deploys ────────────────────────────────────────────────────────────
export interface RepoDeploy { sha: string; at: string; by: string; result: "ok" | "fail" | "cancel" }
/** One dot strip: the last deploys of ONE half of ONE environment. */
export interface RepoDeployRow { env: string; part: RepoPartName; label: string; deploys: RepoDeploy[] }
export interface RepoCiFailure { workflow: string; branch: string; job: string; at: string; url: string }
/** `rate`/`trend` are the SEVEN-day picture, so they are published only once run
 *  capture had been recording for the whole week — before that a "0.0%" day is
 *  just a day capture was not running, not a green day. `rate: null` (and an
 *  empty `trend`) means "not enough capture yet"; `rows` are the failures
 *  themselves, facts, and are always listed. */
export interface RepoCiFailures {
  /** A PERCENTAGE (3.5 = 3.5%), one decimal. */
  rate: number | null;
  trend: number[];
  /** The newest failures only — capped (5). */
  rows: RepoCiFailure[];
  /** Every failed/timed-out run in the same 7-day window as `rows` — the count
   *  to show, since `rows` is capped. */
  total: number;
}
/** `delta` is `""` until the window holds ≥2 points whose first and last are
 *  ≥7 days apart (see `windowDelta` in `src/tools/repo.ts`) — a single
 *  reading, or two readings less than a week apart, cannot support a trend
 *  claim. `""` renders no delta text (and no sparkline at all below 2 points —
 *  see `sparkPoints`/`spark` in `web/src/repo.ts`); `value`/`trend` still show. */
export interface RepoTrend { value: string; trend: number[]; delta: string; tone: RepoTone; note: string }
export type RepoActivityKind = "push" | "merge" | "deploy" | "issue" | "close" | "release" | "review";
export interface RepoActivity {
  kind: RepoActivityKind;
  /** Null when the capture does not say who acted (an issue closing, a PR merging). */
  actor: RepoPerson | null;
  text: string;
  url: string | null;
  at: string;
}

// ── Usage ───────────────────────────────────────────────────────────────────
// Requests/errors come from Cloudflare analytics, active users from the target
// app's own metrics endpoint — different sources that connect independently,
// so each metric travels as its own nullable value: `null` = nothing to show
// for THAT metric in this range, never a guessed number next to its live
// neighbours. A `null` alone does not say WHY — never connected, no point in
// this range, a poll that stopped, a reading gone stale — so `seen` travels
// beside it: whether that environment's source has reported AT ALL inside the
// render's one 30-day read. `null` + seen = connected and quiet ("no recent
// reading"); `null` + not seen = "not connected". The same for every range.
export interface RepoUsageMetric { value: string; trend: number[]; tone: RepoTone }
export interface RepoUsageEnv {
  name: string;
  host: string;
  requests: RepoUsageMetric | null;
  /** Follows `seen.requests` — it is derived from the same Cloudflare series. */
  errorRate: RepoUsageMetric | null;
  users: RepoUsageMetric | null;
  seen: { requests: boolean; users: boolean };
}
export interface RepoCfRow { env: string; label: string; value: string }
export interface RepoHosting { env: string; cpu: string; memory: string }

// ── Usage › Product metrics ─────────────────────────────────────────────────
// What the target app reports about ITSELF (contract:
// docs/superpowers/specs/2026-09-21-sapling-product-metrics.md): `counts` are
// windowed — one figure per range, picked by the tab's 24h / 7d / 30d selector —
// and `totals` are point-in-time, so they ignore it. Canopy is generic over
// keys: label, group and formatting are decided by the Worker
// (src/repo/product.ts) and travel here, so the browser needs no registry.
// A figure is `null` when that metric's latest reading is over 3 hours old
// ("no recent reading"); a key never reported is simply absent. `raw` is the
// exact integer behind a compacted `value`. `trend` is the 00:00 UTC readings
// (the `24h` window for a count) of the last 30 days, oldest first, a missed
// midnight ABSENT — the same line whatever the range.
export interface RepoProductCount {
  key: string;
  label: string;
  values: Record<RepoRange, string | null>;
  raw: Record<RepoRange, number | null>;
  trend: number[];
  note?: string;
}
export interface RepoProductTotal { key: string; label: string; value: string | null; raw: number | null; trend: number[]; note?: string }
export interface RepoProductGroup { id: string; title: string; metrics: RepoProductCount[] }
/** Every configured environment is listed, in config order — one that has
 *  reported nothing has no groups and no totals. */
export interface RepoProductEnv { name: string; groups: RepoProductGroup[]; totals: RepoProductTotal[] }
export type RepoProduct = RepoProductEnv[];

// ── Team & Planning ─────────────────────────────────────────────────────────
export interface RepoSprint {
  id: number;
  label: string;
  due: string | null;
  closed: number;
  total: number;
  pct: number;
}
/** The design's P · M · R: pushes, merged PRs, reviews — this week. `reviews`
 *  is `null` until a `review` row has ever been captured (no capture path
 *  exists yet) — never a guessed 0. */
export interface RepoContributor { person: RepoPerson; pushes: number; merged: number; reviews: number | null }
export interface RepoLabels { total: number; rows: { name: string; count: number }[] }
/** `delta`/`since` are `null`/`""` until the window holds ≥2 points whose
 *  first and last are ≥7 days apart (see `windowDelta` in `src/tools/repo.ts`)
 *  — a single reading, or two readings a day apart, cannot support a trend
 *  claim. `null` renders no delta and no "since" text, count/trend still show. */
export interface RepoTodos { count: number; delta: number | null; since: string; trend: number[] }

export interface RepoDashboard {
  /** `GITHUB_REPO`, e.g. "SaplingLearn/sapling". */
  repo: string;
  generatedAt: string;
  /** True when a D1 read failed and the sections fell back to `empty`. */
  degraded: boolean;
  /** True only for the client-side sample set — never sent by the Worker. */
  sample?: boolean;

  environments: RepoSection<RepoEnv[]>;
  drift: RepoSection<RepoDrift>;
  stats: RepoSection<RepoStat[]>;
  health: RepoSection<RepoHealth[]>;

  codeStats: RepoSection<RepoCodeStat[]>;
  bars: RepoSection<RepoBars>;
  prs: RepoSection<RepoPrList>;
  branches: RepoSection<RepoBranches>;

  deploys: RepoSection<RepoDeployRow[]>;
  ciFailures: RepoSection<RepoCiFailures>;
  coverage: RepoSection<RepoTrend>;
  bundle: RepoSection<RepoTrend>;
  activity: RepoSection<RepoActivity[]>;

  usage: RepoSection<Record<RepoRange, RepoUsageEnv[]>>;
  cloudflare: RepoSection<Record<RepoRange, RepoCfRow[]>>;
  hosting: RepoSection<RepoHosting[]>;
  product: RepoSection<RepoProduct>;

  sprint: RepoSection<RepoSprint>;
  contributors: RepoSection<RepoContributor[]>;
  labels: RepoSection<RepoLabels>;
  todos: RepoSection<RepoTodos>;
}

// ── Which section belongs to which tab — ONE mapping, two readers ────────────
/** Every key of `RepoDashboard` that is a section (not the header fields). */
export type RepoSectionName = {
  [K in keyof RepoDashboard]-?: RepoDashboard[K] extends RepoSection<unknown> ? K : never;
}[keyof RepoDashboard];

/** The sections each tab shows, in screen order. Read by the screen
 *  (`web/src/repo.ts`, the "not connected" footer) and by the MCP
 *  `get_repo_dashboard` tool's `tab` filter (`src/tools/repo-agent.ts`), so an
 *  agent asking for a tab gets exactly what a person sees on it. */
export const REPO_TAB_SECTIONS = {
  overview: ["environments", "drift", "stats", "health"],
  code: ["codeStats", "bars", "prs", "branches"],
  ci: ["deploys", "ciFailures", "coverage", "bundle", "activity"],
  usage: ["usage", "cloudflare", "hosting", "product"],
  planning: ["sprint", "contributors", "labels", "todos"],
} as const satisfies Record<RepoTab, readonly RepoSectionName[]>;

/** Compile-time: a section added to `RepoDashboard` must be given a tab above. */
type AssertTrue<T extends true> = T;
export type RepoSectionsAllMapped = AssertTrue<
  [RepoSectionName] extends [(typeof REPO_TAB_SECTIONS)[RepoTab][number]] ? true : false
>;

// ── "Poll usage now" (POST /admin/poll-usage) — TYPES ONLY, nothing the SPA bundles ──
/** One environment's outcome from one hourly usage poller. `written` = NEW
 *  `repo_metrics` rows — `0` on `ok` means those hours were already stored, and
 *  a `failed` may still be non-zero when part of a body was storable. `detail`
 *  is the poller's scrubbed, truncated message: a failure reason (`failed`),
 *  what is not configured (`skipped`), or — on `ok` — the product keys the poll
 *  dropped, by name. Never a token, a header or an id. */
export interface PollOutcome {
  env: string; status: "ok" | "failed" | "skipped"; written: number; detail?: string;
  /** Health pings only — which of the environment's two deployables the target is. */
  part?: "frontend" | "backend";
}
/** Per source; `"not_configured"` = that source's secret(s) are absent. */
export type UsagePollSource = PollOutcome[] | "not_configured";
export interface UsagePollResult { cloudflare: UsagePollSource; railway: UsagePollSource; sapling: UsagePollSource }

// ── "Poll now" (POST /admin/poll) — health, usage and GitHub, on demand. TYPES ONLY ──
/** `reconcileRepo`'s own result: `failed` holds ARM NAMES (`"deployments"`,
 *  `"runs"`, …) or one fixed phrase — never an error message, never a secret. */
export interface RepoRefreshGithub { written: number; unchanged: number; failed: string[] }
/** `UsagePollResult`'s three sources plus the two the usage poll never ran.
 *  `health` is one `PollOutcome` per TARGET (two per environment, `part` set):
 *  `ok` = up, `failed` = down with a few fixed words (`timeout` / `HTTP 503` /
 *  `unreachable`), `written` = new `repo_metrics` rows; `"not_configured"` = no
 *  environment in `REPO_ENVIRONMENTS`. `github` is `"not_configured"` without
 *  `GITHUB_SERVICE_TOKEN` + `GITHUB_REPO`. */
export interface RepoRefreshResult extends UsagePollResult {
  health: UsagePollSource;
  github: RepoRefreshGithub | "not_configured";
}
