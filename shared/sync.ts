// Sync GitHub, as the Worker reports it and the SPA shows it (docs/architecture/sync.md). Zod-free and
// dependency-free: the SPA imports the constants and the sentence builders as VALUES.
//
// A sync is a RUN of one or more BATCHES. The browser drives it: it POSTs `/admin/backfill` once per
// batch, and the Worker reports where the run stands — in each answer, and (for anyone else, or after
// a reload) at `GET /sync`. Every sentence a screen shows about a sync is built here, from the run.

/** The most batches one run makes (the client's loop bound; the Worker enforces the same number). */
export const SYNC_MAX_BATCHES = 10;
/** The most AI summaries one batch attempts (src/tools/backfill.ts paces them). */
export const SYNC_SUMMARIES_PER_BATCH = 5;
/** So one click attempts at most this many summaries, however large the backlog. */
export const SYNC_SUMMARIES_PER_RUN = SYNC_MAX_BATCHES * SYNC_SUMMARIES_PER_BATCH;
/** A running run that has reported nothing for this long did not finish (the tab was closed, the
 *  request died): it stops holding the lock and reads as `abandoned`. Same length, and the same
 *  reasoning, as the Repo refresh lock (src/repo/cron.ts `REFRESH_LOCK_MS`). */
export const SYNC_STALE_MS = 180_000;
/** Finished runs older than this are deleted by the retention sweep. The owner's to tune. */
export const SYNC_RUN_RETENTION_DAYS = 90;

// ── a run ────────────────────────────────────────────────────────────────────

/** What a batch is doing, in the order it does it. `reconcile` happens on a run's LAST batch only. */
export const SYNC_PHASES = ["starting", "reading_prs", "reading_issues", "saving_issues", "saving_prs", "reconcile", "done"] as const;
export type SyncPhase = (typeof SYNC_PHASES)[number];

/** `ok` — finished, nothing failed. `partial` — finished, but a part of the closing refresh failed.
 *  `failed` — stopped: GitHub could not be read. `abandoned` — never reported an end. */
export type SyncRunStatus = "running" | "ok" | "partial" | "failed" | "abandoned";

/** Running totals of one run. Everything is cumulative across its batches except the two `_seen`
 *  figures and `summaries_pending`, which are the latest batch's reading. */
export interface SyncCounts {
  /** Closed pull requests / open issues GitHub listed. */
  prs_seen: number;
  issues_seen: number;
  /** Closed pull requests captured for the first time. */
  prs_new: number;
  /** Open issues that are new, or changed since they were last captured. */
  issues_changed: number;
  /** Tickets the issue mirror created / updated. */
  tickets_created: number;
  tickets_updated: number;
  /** AI summaries written. */
  summaries_written: number;
  /** Summaries attempted that failed: the item shows an excerpt and the next sync tries again. */
  summaries_failed: number;
  /** Items stored with an excerpt because no summary could be attempted (the monthly allowance is
   *  used up, the plan has ended, or summaries are off on this deployment). */
  summaries_skipped: number;
  /** Items still waiting for a summary when the latest batch ended. */
  summaries_pending: number;
  /** Rows the closing refresh (deployments, CI, branches, drift) wrote; null = it has not run. */
  repo_written: number | null;
}

export const zeroSyncCounts = (): SyncCounts => ({
  prs_seen: 0, issues_seen: 0, prs_new: 0, issues_changed: 0, tickets_created: 0, tickets_updated: 0,
  summaries_written: 0, summaries_failed: 0, summaries_skipped: 0, summaries_pending: 0, repo_written: null,
});

/** One thing that failed, from a FIXED vocabulary — never upstream text. `status` is GitHub's HTTP
 *  status where there was one. */
export interface SyncFailure {
  /** `not_configured` · `list_prs` · `list_issues` · `unexpected` · `reconcile:<arm>` · `reconcile:unexpected`. */
  code: string;
  status?: number;
}

export interface SyncRunView {
  id: number;
  /** The repository it read, `owner/repo`. */
  repo: string;
  /** The person who started it (a handle). */
  by: string;
  started_at: string;
  /** The last time the run reported anything. */
  updated_at: string;
  ended_at: string | null;
  status: SyncRunStatus;
  /** The batch under way (1-based), or the last one made. */
  batch: number;
  /** How many batches the run is expected to take; null until the first one has counted the backlog. */
  batches: number | null;
  phase: SyncPhase;
  /** Items done within the phase, and of how many — `total` null where no total is known. */
  done: number | null;
  total: number | null;
  counts: SyncCounts;
  failures: SyncFailure[];
  /** When the previous finished sync ended (for "Nothing new since …"); null = there was none. */
  previous_at: string | null;
}

// ── the status every member reads (GET /sync) ────────────────────────────────

/** Why nobody can start a sync right now; null = one can be started (by an admin). */
export type SyncBlock = "no_repo" | "no_token" | "running";

/** `off` — this deployment has no summaries key. `ended` — the org's plan has ended. */
export type SummariesStatus = "off" | "on" | "capped" | "ended";

export interface SyncSummariesView {
  status: SummariesStatus;
  /** Summaries attempted this calendar month (UTC). */
  used: number;
  /** The plan's monthly allowance; null = unlimited. */
  cap: number | null;
  /** `cap - used`, never below 0; null = unlimited. */
  remaining: number | null;
  /** Items stored with an excerpt that a sync would try to summarize (an upper estimate). */
  pending: number;
  /** The most one run attempts (`SYNC_SUMMARIES_PER_RUN`). */
  per_run: number;
}

export interface SyncStatusView {
  /** The org's primary repository, or null when none is connected. */
  repo: string | null;
  /** The caller may start a sync (an admin or owner) — whether or not one can start right now. */
  admin: boolean;
  blocked: SyncBlock | null;
  /** The run in progress, or null. */
  running: SyncRunView | null;
  /** The latest run that is no longer running, or null. */
  last: SyncRunView | null;
  summaries: SyncSummariesView;
  /** When deployments, CI, branches and drift were last refreshed — by a sync, by Poll now, or by the
   *  scheduled refresh; null = never. */
  refreshed_at: string | null;
}

/** What `POST /admin/backfill` answers when a run is already in progress (HTTP 409). */
export interface SyncBusy { error: "sync_running"; run: SyncRunView }

// ── words ────────────────────────────────────────────────────────────────────

/** What a phase is doing, as the panel says it. */
export const SYNC_PHASE_LABEL: Record<SyncPhase, string> = {
  starting: "Starting",
  reading_prs: "Reading pull requests",
  reading_issues: "Reading issues",
  saving_issues: "Saving issues and tickets",
  saving_prs: "Saving pull requests and summaries",
  reconcile: "Checking deployments and CI",
  done: "Finishing",
};

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** How many summaries a sync started now would attempt: the backlog, bounded by one run's maximum and
 *  by what is left this month. 0 when summaries are off, used up or ended. */
export function summariesExpected(s: SyncSummariesView): number {
  if (s.status !== "on") return 0;
  return Math.max(0, Math.min(s.pending, s.per_run, s.remaining ?? Infinity));
}

/** "Syncing 3 of 8" — the header button while a run is in progress. */
export function syncCompactLabel(run: Pick<SyncRunView, "batch" | "batches">): string {
  return run.batches && run.batch >= 1 ? `Syncing ${Math.min(run.batch, run.batches)} of ${run.batches}` : "Syncing";
}

/** The parts of a finished run that changed something, each a phrase — [] when nothing did. */
export function syncChanges(c: SyncCounts): string[] {
  const out: string[] = [];
  if (c.prs_new) out.push(plural(c.prs_new, "new pull request", "new pull requests"));
  if (c.issues_changed) out.push(plural(c.issues_changed, "issue updated", "issues updated"));
  if (c.tickets_created) out.push(plural(c.tickets_created, "ticket created", "tickets created"));
  if (c.tickets_updated) out.push(plural(c.tickets_updated, "ticket updated", "tickets updated"));
  if (c.summaries_written) out.push(plural(c.summaries_written, "summary written", "summaries written"));
  const excerpts = c.summaries_failed + c.summaries_skipped;
  if (excerpts) out.push(`${excerpts.toLocaleString("en-US")} shown as ${excerpts === 1 ? "an excerpt" : "excerpts"}`);
  if (c.repo_written) out.push("deployments and CI refreshed");
  return out;
}

/** A finished run changed nothing: no new item, no summary, nothing written by the closing refresh. */
export const syncNothingNew = (run: Pick<SyncRunView, "counts">): boolean => syncChanges(run.counts).length === 0;

/** "1m 12s", "8s" — how long a run took (or has been running, given `until`). */
export function syncDuration(run: Pick<SyncRunView, "started_at" | "ended_at">, until?: number): string {
  const end = run.ended_at ? Date.parse(run.ended_at) : (until ?? Date.now());
  const s = Math.max(0, Math.round((end - Date.parse(run.started_at)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

// The closing refresh's arms (src/repo/github.ts `reconcileRepo`), as what a person would call them.
const ARM_NAME: Record<string, string> = {
  open_prs: "open pull requests", closed_prs: "recently closed pull requests", commits: "recent commits",
  deployments: "deployments", runs: "workflow runs", job_titles: "failed job names", env_heads: "each environment's latest commit",
  checks: "check runs", statuses: "commit statuses", reviews: "pull request reviews", branches: "branches", drift: "branch drift",
};
const TOKEN_FIX = "Check that the GitHub token in Org settings › Integrations can read this repository, then sync again.";

/** One failure as two plain sentences: what did not happen, and what to do about it. Built from the
 *  code alone — nothing an upstream wrote can reach the screen. */
export function syncFailureText(f: SyncFailure, repo: string): { what: string; fix: string } {
  if (f.code === "list_prs" || f.code === "list_issues") {
    const thing = f.code === "list_prs" ? "pull requests" : "issues";
    const what = f.status === 401 || f.status === 403 ? `Could not read ${thing}: GitHub refused the token (${f.status}).`
      : f.status === 404 ? `Could not read ${thing}: GitHub found no ${repo} this token can see (404).`
      : `Could not read ${thing}: GitHub answered ${f.status ?? "with an error"}.`;
    return { what: `${what} Nothing was written.`, fix: f.status === 401 || f.status === 403 || f.status === 404 ? TOKEN_FIX : "Try again in a few minutes." };
  }
  if (f.code === "not_configured") return { what: "This organization has no repository or GitHub token to sync with.", fix: "Connect one in Org settings › Repositories and Integrations." };
  if (f.code.startsWith("reconcile:")) {
    const arm = f.code.slice("reconcile:".length);
    if (arm === "unexpected") return { what: "Could not refresh deployments and CI.", fix: "Pull requests and issues were synced. Try again in a few minutes." };
    return { what: `Could not read ${ARM_NAME[arm] ?? "part of the repository"} from GitHub.`, fix: `Everything else finished. ${TOKEN_FIX}` };
  }
  return { what: "The sync stopped before it finished.", fix: "Whatever it had saved is kept. Try again in a few minutes." };
}

/** Why nothing can run, and where to fix it (`tab` is an Org settings tab). */
export function syncBlockText(block: SyncBlock, running: SyncRunView | null): { what: string; tab: "repositories" | "integrations" | null; link: string | null } {
  if (block === "no_repo") return { what: "No repository is connected to this organization yet.", tab: "repositories", link: "Connect one in Org settings › Repositories" };
  if (block === "no_token") return { what: "There is no GitHub token to read the repository with.", tab: "integrations", link: "Add one in Org settings › Integrations" };
  return { what: running ? `@${running.by} started a sync that is still running.` : "A sync is already running.", tab: null, link: null };
}
