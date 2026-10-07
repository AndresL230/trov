import type { Env } from "../env";
import type { PrSummaryRow, IssueSummaryRow } from "@shared/rows";
import { first } from "../data/sql";
import { platform, type TenantContext } from "../data/context";
import { resolveGithubCredential } from "../github-app/credential";
import { jobTenant } from "../platform/jobs";
import { orgPrimaryRepo } from "../repo/config";
import { ingestEvent } from "../consumer";
import { mirrorIssue } from "./ticket-mirror";
import { eventsFromDelivery } from "../webhook";
import { type Summarizer, type PrSummary, type IssueSummary, storePrSummary, storeIssueSummary } from "./summarize";
import { applyEventProgress } from "./progress";
import { orgSummarizers, type OrgSummarizersOpts, type SummaryAllowance } from "../plans/summaries";
import { SYNC_SUMMARIES_PER_BATCH, type SyncFailure, type SyncPhase } from "@shared/sync";

// Admin-triggered server-side GitHub backfill. Unlike scripts/backfill-events.mjs
// (which signs synthetic webhook deliveries with the webhook secret), this runs
// INSIDE the Worker with the org's `github_token` — the same credential the scheduled()
// progress recompute uses — so it fetches GitHub REST directly, no webhook secret.
//
// It reconstructs the SAME deliveries the webhook would have received, reuses the
// PURE eventsFromDelivery() derivation (never duplicated here), post-maps each
// event's provenance to "backfill", and writes through the ONE gate fn ingestEvent
// — but with the ADMIN principal as the writer (an authenticated identity), not
// the fixed "github-webhook" string. Downstream projections (PR summaries, issue
// progress) mirror handleGithubWebhook, hung off newly-written events only.

const GH_API = "application/vnd.github+json";
const USER_AGENT = "trov";

// A long unbroken run of sequential AI calls has been observed to hit a hard
// wall partway through (many successes, then every subsequent call fails
// instantly) — a rate limit or per-request ceiling, not a code defect. Cap
// how many summarizer calls one invocation makes, and pace them, so a single
// Sync stays comfortably under whatever that limit is; a backlog beyond the
// cap is picked up by the next Sync click (the model≠excerpt-and-structured
// skip-check already makes that safe — nothing already summarized is redone).
//
// Kept small (5) so each /admin/backfill returns quickly and the browser sees
// progress between batches rather than one long stall — the frontend auto-loops
// up to MAX_BACKFILL_BATCHES (web/src/main.ts). Even in the pathological case
// where every call times out (GEMINI_TIMEOUT_MS), a batch is bounded to
// ~5 × timeout and still completes via the excerpt fallback.
const SUMMARY_BATCH_LIMIT = SYNC_SUMMARIES_PER_BATCH; // 5 — shared with the Sync panel, which says how many a run attempts
const SUMMARY_CALL_DELAY_MS = 500;

/** Where a batch stands (shared/sync.ts `SyncPhase`): `total` is null while GitHub is still being
 *  listed — the count is not known until the last page. Reporting only; it changes nothing. */
export interface BackfillProgress { phase: Extract<SyncPhase, "reading_prs" | "reading_issues" | "saving_issues" | "saving_prs">; done: number | null; total: number | null }
const PROGRESS_INTERVAL_MS = 1000;

/** What one batch did beyond the counts above — the run report's raw material (src/sync/runs.ts). */
export interface BackfillDetail {
  capturedPrs: number;
  capturedIssues: number;
  ticketsCreated: number;
  ticketsUpdated: number;
  /** Summaries written / attempts that fell back to the excerpt / items given an excerpt because
   *  nothing could be attempted (no key, the monthly allowance, an ended plan). */
  summariesWritten: number;
  summariesFailed: number;
  summariesSkipped: number;
}
const NO_DETAIL: BackfillDetail = { capturedPrs: 0, capturedIssues: 0, ticketsCreated: 0, ticketsUpdated: 0, summariesWritten: 0, summariesFailed: 0, summariesSkipped: 0 };

/** A Sync is (possibly) several batches (web/src/main.ts's `runAdminBackfillLoop`
 *  re-POSTs `/admin/backfill` up to MAX_BACKFILL_BATCHES times while the
 *  summary budget stays exhausted). The repo-capture reconcile is expensive
 *  (~250 no-op statements on an already-reconciled repo) and idempotent, so it
 *  belongs on the batch that ENDS the loop, not every one. That is either the
 *  batch whose result says the summary budget was NOT exhausted (the normal
 *  case), OR — since the server has no other way to see the client's loop
 *  counter — the batch the CLIENT reports as having reached its own cap
 *  (`batch >= of`) while still exhausted, so a Sync that hits
 *  MAX_BACKFILL_BATCHES without ever clearing the budget still reconciles once.
 *  `batch`/`of` are caller-supplied and may be absent or malformed (an older
 *  client, a hand-rolled request) — treated as "unknown", never as "final". */
export function isFinalBackfillBatch(
  result: Pick<BackfillResult, "summaryBudgetExhausted">,
  batch?: number,
  of?: number
): boolean {
  if (!result.summaryBudgetExhausted) return true;
  return typeof batch === "number" && Number.isFinite(batch) && typeof of === "number" && Number.isFinite(of) && batch >= of;
}

export interface BackfillResult extends BackfillDetail {
  ok: boolean;
  error?: string;
  /** Why nothing ran, as a code (never upstream text) — present exactly when `ok` is false. */
  failure?: SyncFailure;
  /** Items still without a real summary when the batch ended. */
  summariesPending?: number;
  /** The org's summaries allowance as this batch left it. */
  allowance?: SummaryAllowance;
  captured: number;
  unchanged: number;
  summarized: number;
  summaryBudgetExhausted: boolean;
  /** How many of `prs` already have a real (non-excerpt) summary — the "X of Y" the frontend shows. */
  prSummarizedCount: number;
  /** How many assigned issues already have a real (non-excerpt) summary. */
  issueSummarizedCount: number;
  prs: number;
  issues: number;
  /** Denominator: assigned issues found this run — the "X of Y" the frontend shows. */
  issuesToSummarize: number;
}

// Minimal typed views over the GitHub REST list items — only the fields the
// delivery synthesizers below read are modeled; everything else is ignored.
interface GhUserLite {
  login: string;
}
/** GitHub's issue GROUP object (its own `milestone` payload key). */
interface GhGroupLite {
  number: number;
  title?: string | null;
  due_on?: string | null;
  open_issues?: number;
  closed_issues?: number;
}
interface GhPrListItem {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  merged_at: string | null;
  closed_at: string | null;
  updated_at: string;
  user: GhUserLite;
  milestone?: GhGroupLite | null; // GitHub's own key — not Trov vocabulary
  base?: { ref: string } | null;
}
interface GhIssueListItem {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  state_reason?: string | null;
  updated_at: string;
  user: GhUserLite;
  assignees?: GhUserLite[];
  assignee?: GhUserLite | null;
  labels?: (string | { name: string })[];
  milestone?: GhGroupLite | null; // GitHub's own key — not Trov vocabulary
  pull_request?: unknown; // present only when the "issue" is really a PR
}

// The `rel="next"` URL from a GitHub Link header, or null when there is no next page.
function nextLink(res: Response): string | null {
  const link = res.headers.get("link");
  const next = link?.split(",").find((part) => part.includes('rel="next"'));
  return next ? (next.match(/<([^>]+)>/)?.[1] ?? null) : null;
}

// Synthesize the delivery bodies eventsFromDelivery reads — SAME raw slice shapes
// as scripts/backfill-events.mjs (test/fixtures/*.json). PR list items carry no
// `merged` boolean (that's single-PR-fetch only), so derive it from merged_at.
function prClosedDelivery(pr: GhPrListItem) {
  return {
    action: "closed",
    number: pr.number,
    pull_request: {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      html_url: pr.html_url,
      merged: pr.merged_at != null,
      merged_at: pr.merged_at,
      closed_at: pr.closed_at,
      user: { login: pr.user.login },
      base: pr.base ? { ref: pr.base.ref } : null,
      // GitHub's own key — not Trov vocabulary (the raw snapshot mirrors it).
      milestone: pr.milestone
        ? { number: pr.milestone.number, open_issues: pr.milestone.open_issues, closed_issues: pr.milestone.closed_issues }
        : null,
    },
  };
}

function issueDelivery(issue: GhIssueListItem, repo: string) {
  const assignee = issue.assignees?.[0] ?? issue.assignee ?? null;
  const action = assignee ? "assigned" : "opened";
  return {
    action,
    // A list item carries no `repository` object; the delivery the webhook gets
    // does, and the ticket mirror scopes on it — so the reconstruction adds it.
    repository: { full_name: repo },
    ...(assignee ? { assignee: { login: assignee.login } } : {}),
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      html_url: issue.html_url,
      state: issue.state,
      state_reason: issue.state_reason ?? null,
      updated_at: issue.updated_at,
      user: { login: issue.user.login },
      assignees: (issue.assignees ?? []).map((a) => ({ login: a.login })),
      labels: issue.labels ?? [],
      // GitHub's own key — not Trov vocabulary (the raw snapshot mirrors it).
      milestone: issue.milestone
        ? {
            number: issue.milestone.number,
            title: issue.milestone.title ?? null,
            due_on: issue.milestone.due_on ?? null,
            open_issues: issue.milestone.open_issues,
            closed_issues: issue.milestone.closed_issues,
          }
        : null,
    },
  };
}

export async function runBackfill(
  env: Env,
  caller: TenantContext,
  principalLogin: string,
  opts?: {
    fetchImpl?: typeof fetch;
    summarizer?: Summarizer<PrSummary> | null;
    issueSummarizer?: Summarizer<IssueSummary> | null;
    summaryBatchLimit?: number;
    summaryCallDelayMs?: number;
    /** The org summarizer's Gemini call (its fetch, stubbed in tests) and the clock its month is read from. */
    gemini?: OrgSummarizersOpts["gemini"];
    now?: Date;
    /** Told where the batch stands: at every phase change, and at most once a second inside one. */
    onProgress?: (p: BackfillProgress) => void | Promise<void>;
  }
): Promise<BackfillResult> {
  // Reporting only — a listener that throws never costs the sync.
  let lastTick = 0;
  const report = async (phase: BackfillProgress["phase"], done: number | null, total: number | null, force = true): Promise<void> => {
    if (!opts?.onProgress || (!force && Date.now() - lastTick < PROGRESS_INTERVAL_MS)) return;
    lastTick = Date.now();
    try { await opts.onProgress({ phase, done, total }); } catch { /* reporting only */ }
  };
  // The backfill replays GitHub into the CALLER's org, as system — the webhook's own context
  // (`jobTenant`; the route's gate decides who may ask, and a bearer context is refused).
  const ctx = jobTenant(env, caller);
  // Nothing-ran failure envelope. The route turns this into a 503 whose error
  // reaches the admin's toast — a Sync that can't reach GitHub must say so, not
  // report zeros as if the repo were empty.
  const failed = (error: string, failure: SyncFailure): BackfillResult => ({
    ok: false,
    error,
    failure,
    ...NO_DETAIL,
    captured: 0,
    unchanged: 0,
    summarized: 0,
    summaryBudgetExhausted: false,
    prSummarizedCount: 0,
    issueSummarizedCount: 0,
    prs: 0,
    issues: 0,
    issuesToSummarize: 0,
  });

  // The org's PRIMARY repo and its GitHub credential (src/github-app/credential.ts: its App
  // installation's token, else its stored `github_token`; for SaplingLearn, until its admin connects
  // either, the legacy GITHUB_SERVICE_TOKEN — src/data/secrets.ts). This module is not
  // reachable from src/mcp.ts, so it may resolve one. A secret that cannot be read is "not configured".
  const repo = (await orgPrimaryRepo(ctx))?.repo;
  const gh = repo ? await resolveGithubCredential(ctx, env, { repo, fetchImpl: opts?.fetchImpl }).catch(() => null) : null;
  const token = gh?.token.reveal();
  if (!gh || !token || !repo) return failed("service token or repo not configured", { code: "not_configured" });
  await gh.markUsed();

  const doFetch = gh.fetch(opts?.fetchImpl) ?? fetch;
  // THE summarizer choice for this org (src/plans/summaries.ts: the platform key, the plan's monthly
  // allowance, every call counted against the admin who pressed Sync), read once for the batch and
  // asked per item — it turns null the moment the allowance is spent. An explicit `opts` summarizer
  // (null included) is a test's own and bypasses it.
  const sums = await orgSummarizers(env, ctx, { actor: principalLogin, gemini: opts?.gemini, now: opts?.now });
  const prSummarizer = (): Summarizer<PrSummary> | null => (opts?.summarizer !== undefined ? opts.summarizer : sums.pr());
  const issueSummarizerNow = (): Summarizer<IssueSummary> | null => (opts?.issueSummarizer !== undefined ? opts.issueSummarizer : sums.issue());
  const summaryBatchLimit = opts?.summaryBatchLimit ?? SUMMARY_BATCH_LIMIT;
  const summaryCallDelayMs = opts?.summaryCallDelayMs ?? SUMMARY_CALL_DELAY_MS;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: GH_API,
    "user-agent": USER_AGENT,
    "x-github-api-version": "2022-11-28",
  };

  // (a) All closed PRs, fully paginated — full history, not just recent
  //     activity, so a Sync also surfaces PRs merged before this route existed.
  const prList: GhPrListItem[] = [];
  await report("reading_prs", 0, null);
  {
    let url: string | null = `https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;
    while (url) {
      const res: Response = await doFetch(url, { headers });
      // Fail the whole run, loud: a 401/403/404 here (a dead or under-scoped
      // token) would otherwise read as "0 PRs" — fake success.
      // Both lists are fetched before any ingestion, so nothing is half-written.
      if (!res.ok) return failed(`GitHub ${res.status} listing closed PRs (check the org's GitHub connection)`, { code: "list_prs", status: res.status, via: gh.source });
      const page = (await res.json()) as GhPrListItem[];
      prList.push(...page);
      url = nextLink(res);
      await report("reading_prs", prList.length, null, false); // the total is not known until the last page
    }
  }

  // (b) All open issues, paginated. The issues endpoint also returns PRs — those
  //     carry a `pull_request` field and are not our surface, so skip them.
  const issueList: GhIssueListItem[] = [];
  await report("reading_issues", 0, null);
  {
    let url: string | null = `https://api.github.com/repos/${repo}/issues?state=open&per_page=100`;
    while (url) {
      const res: Response = await doFetch(url, { headers });
      if (!res.ok) return failed(`GitHub ${res.status} listing open issues (check the org's GitHub connection)`, { code: "list_issues", status: res.status, via: gh.source });
      const page = (await res.json()) as GhIssueListItem[];
      for (const issue of page) {
        if (issue.pull_request) continue;
        issueList.push(issue);
      }
      url = nextLink(res);
      await report("reading_issues", issueList.length, null, false);
    }
  }

  let captured = 0;
  let unchanged = 0;
  let summarized = 0;
  let summaryBudgetExhausted = false;
  // What this batch did, for the run's report (shared/sync.ts `SyncCounts`).
  const d = { ...NO_DETAIL };
  const skip = async (kind: "pr" | "issue", explicit: boolean): Promise<void> => {
    d.summariesSkipped++;
    if (!explicit) await sums.skipped(kind);
  };
  // Running counts of PRs / issues that end this call with a real (non-excerpt,
  // structured) summary — either already had one, or got one just now. Paired
  // with prList.length / issuesToSummarize, these are the "X of Y" progress the
  // frontend shows across a multi-batch sync.
  let prSummarizedCount = 0;
  let issueSummarizedCount = 0;
  let issuesToSummarize = 0; // denominator: assigned issues found this run

  // Issues are summarized BEFORE PRs. The AI-call budget is shared per invocation,
  // so ordering is what decides who gets starved when there's a backlog: the To-do
  // surface (open assigned issues) is the more time-sensitive glance, and — because
  // issues are far fewer than PRs — it clears well before the sustained-load AI
  // rate-limit wall the long PR run can hit. PRs (Previous activity) take whatever
  // budget remains and finish across follow-up Sync batches (the frontend auto-loops).
  await report("saving_issues", 0, issueList.length);
  for (const [i, issue] of issueList.entries()) {
    if (i) await report("saving_issues", i, issueList.length, false);
    const payload = issueDelivery(issue, repo);
    const isAssigned = payload.action === "assigned";

    // The ticket mirror, through the SAME function as the webhook. OPEN issues
    // only (the list is already state=open; the check keeps it true whatever the
    // query says) — a closed issue enters Trov only by a real delivery. Best
    // effort, like the webhook's: a mirror failure never costs the capture.
    if (issue.state === "open") {
      try {
        const mirrored = await mirrorIssue(ctx, platform(env, "system"), repo, payload);
        if (mirrored === "created") d.ticketsCreated++;
        else if (mirrored === "updated") d.ticketsUpdated++;
      } catch (e) {
        console.error("ticket mirror failed (backfill)", issue.number, e instanceof Error ? e.message : String(e));
      }
    }
    if (isAssigned) issuesToSummarize++;

    for (const base of eventsFromDelivery("issues", payload)) {
      const ev = { ...base, provenance: "backfill" as const };
      const res = await ingestEvent(ctx, platform(env, principalLogin), ev, principalLogin);
      if (res.outcome === "written") {
        captured++;
        d.capturedIssues++;
        // Mirror handleGithubWebhook's progress seam for newly-written issues.
        await applyEventProgress(ctx, payload);
      } else {
        unchanged++;
      }

      if (!isAssigned) continue; // unassigned issues never appear in anyone's to-do

      const existing = await first<IssueSummaryRow>(
        ctx,
        `SELECT model, title FROM issue_summaries WHERE org_id = ? AND issue_number = ?`,
        ctx.orgId, issue.number
      );
      const alreadySummarized = existing !== null && existing.model !== "excerpt" && existing.title !== null;
      if (alreadySummarized) {
        issueSummarizedCount++;
        continue;
      }

      // No summarizer: nothing can be attempted, so nothing is spent from the batch
      // budget and nothing is paced — a Sync with no summarizer is ONE batch, not
      // ten that each rewrite five excerpt rows. An item with no row yet gets its
      // excerpt row once; one that already has it waits for a later Sync.
      const issueSummarizer = issueSummarizerNow();
      if (!issueSummarizer) {
        if (existing === null) {
          await storeIssueSummary(ctx, null, { issue_number: issue.number, title: issue.title, body: issue.body ?? "" });
          await skip("issue", opts?.issueSummarizer !== undefined);
        }
        continue;
      }

      // Shares the SAME summarized/summaryBatchLimit budget as the PR loop
      // below — not a separate allowance. See Global Constraints.
      if (summarized >= summaryBatchLimit) {
        summaryBudgetExhausted = true;
        continue;
      }

      const stored = await storeIssueSummary(ctx, issueSummarizer, {
        issue_number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
      });
      summarized++;
      // storeIssueSummary can still fall back to excerpt if the AI call failed —
      // only count it toward "done" if it actually got a real, structured summary.
      if (stored.model !== "excerpt" && stored.title !== null) { issueSummarizedCount++; d.summariesWritten++; } else d.summariesFailed++;

      if (summarized < summaryBatchLimit && summaryCallDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, summaryCallDelayMs));
      }
    }
  }

  await report("saving_prs", 0, prList.length);
  for (const [i, pr] of prList.entries()) {
    if (i) await report("saving_prs", i, prList.length, false);
    const payload = prClosedDelivery(pr);
    for (const base of eventsFromDelivery("pull_request", payload)) {
      const ev = { ...base, provenance: "backfill" as const };
      const res = await ingestEvent(ctx, platform(env, principalLogin), ev, principalLogin);
      if (res.outcome === "written") {
        captured++;
        d.capturedPrs++;
      } else {
        unchanged++;
      }

      // (Re)summarize unless it already has a real summary — decoupled from the
      // event-capture outcome so a Sync also migrates PRs that fell back to the
      // excerpt summary, not just brand-new ones.
      const existing = await first<PrSummaryRow>(
        ctx,
        `SELECT model, title FROM pr_summaries WHERE org_id = ? AND semantic_key = ?`,
        ctx.orgId, ev.semantic_key
      );
      // "Done" = a real (non-excerpt) summary that is ALSO structured — title
      // doubles as the structured-generation marker (0018), so prose-era rows
      // regenerate exactly once under the shared budget.
      const alreadySummarized = existing !== null && existing.model !== "excerpt" && existing.title !== null;
      if (alreadySummarized) {
        prSummarizedCount++;
        continue;
      }

      const parsed = JSON.parse(ev.raw) as { pr: { number: number; title: string; body: string | null } };
      // No summarizer: the marker row once, outside the budget (see the issue loop).
      const summarizer = prSummarizer();
      if (!summarizer) {
        if (existing === null) {
          await storePrSummary(ctx, null, { semantic_key: ev.semantic_key, pr_number: parsed.pr.number, title: parsed.pr.title, body: parsed.pr.body ?? "" });
          await skip("pr", opts?.summarizer !== undefined);
        }
        continue;
      }

      if (summarized >= summaryBatchLimit) {
        summaryBudgetExhausted = true;
        continue;
      }

      const stored = await storePrSummary(ctx, summarizer, {
        semantic_key: ev.semantic_key,
        pr_number: parsed.pr.number,
        title: parsed.pr.title,
        body: parsed.pr.body ?? "",
      });
      summarized++;
      // storePrSummary can still fall back to excerpt if the AI call failed —
      // only count it toward "done" if it actually got a real, structured summary.
      if (stored.model !== "excerpt" && stored.title !== null) { prSummarizedCount++; d.summariesWritten++; } else d.summariesFailed++;

      // Pace summarizer calls so one invocation doesn't burst past whatever
      // limit caused the wall above — skip the trailing delay once the batch
      // is done, nothing follows it.
      if (summarized < summaryBatchLimit && summaryCallDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, summaryCallDelayMs));
      }
    }
  }

  return {
    ok: true,
    captured,
    unchanged,
    summarized,
    summaryBudgetExhausted,
    prSummarizedCount,
    issueSummarizedCount,
    prs: prList.length,
    issues: issueList.length,
    issuesToSummarize,
    ...d,
    summariesPending: prList.length - prSummarizedCount + (issuesToSummarize - issueSummarizedCount),
    allowance: sums.allowance(),
  };
}
