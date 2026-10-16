// Every SELECT over the repo capture tables. D1 only — nothing here may fetch.
// An async reader AWAITS its statement (`return await all(…)`), never hands its promise back: the Repo
// dashboard starts these side by side, and a statement that fails at once (a binding that throws on
// `prepare`) must be settled by THIS function, not left to a promise the runtime reports as unhandled
// before the caller's handler is attached (`data-layer.md` › Round trips).
import { type TenantContext, all, first, fanOut, ph } from "../data/sql";
import { getSnapshot } from "./store";
import type { RepoEventKind, RepoEventRow, RepoPrRow, RepoReviewRow, RepoRunRow } from "./types";

/** The columns a `pr` reader needs — never `raw`, and never the columns no PR
 *  reader touches. Shared by `prStatesAsOf` / `recentPrRows` so both stay
 *  narrow the same way. */
const PR_ROW_COLS = "number, state, ref, sha, actor_login, title, url, occurred_at";

/** Has a row of `kind` EVER been captured? With `provenance`, only a row from
 *  that source counts — for the one claim a polled row cannot support: the
 *  reconcile's `reviews` arm sees the 30 most recently updated OPEN PRs and
 *  their last 10 reviews, so it can never say someone reviewed NOTHING; only
 *  the webhook, complete going forward once subscribed, can. */
export async function hasCaptured(ctx: TenantContext, kind: RepoEventKind, provenance?: "webhook" | "backfill"): Promise<boolean> {
  return provenance
    ? (await first<{ n: number }>(ctx, `SELECT 1 AS n FROM repo_events WHERE org_id = ? AND kind = ? AND provenance = ? LIMIT 1`, ctx.orgId, kind, provenance)) !== null
    : (await first<{ n: number }>(ctx, `SELECT 1 AS n FROM repo_events WHERE org_id = ? AND kind = ? LIMIT 1`, ctx.orgId, kind)) !== null;
}

/** When capture of `kind` began recording (the earliest `recorded_at`, NOT
 *  `occurred_at` — a backfilled row's occurred_at can predate capture
 *  entirely). `SELECT MIN(...)` always returns a row, so an empty table
 *  comes back as `{ at: null }`, not no row — normalize that to `null`. Used
 *  to decide whether a week-over-week delta is real or an artifact of when
 *  capture started. */
export async function recordingSince(ctx: TenantContext, kind: RepoEventKind): Promise<string | null> {
  const row = await first<{ at: string | null }>(ctx, `SELECT MIN(recorded_at) AS at FROM repo_events WHERE org_id = ? AND kind = ?`, ctx.orgId, kind);
  return row?.at ?? null;
}

/** The latest `pr` row per PR number as of a moment — a PR's state THEN. Long-
 *  open PRs must still resolve correctly, so this is NEVER time-bound; only
 *  its columns are narrowed. */
export async function prStatesAsOf(ctx: TenantContext, asOfIso: string): Promise<RepoPrRow[]> {
  return await all<RepoPrRow>(ctx,
    `SELECT ${PR_ROW_COLS} FROM (
       SELECT ${PR_ROW_COLS}, ROW_NUMBER() OVER (PARTITION BY number ORDER BY occurred_at DESC, id DESC) AS rn
         FROM repo_events WHERE org_id = ? AND kind = 'pr' AND occurred_at <= ?
     ) WHERE rn = 1`, ctx.orgId, asOfIso);
}

/** The latest `pr` row per PR number, most-recently-touched first — bounded to
 *  the last 90 days: a PR nobody touched in that long need not appear in a
 *  "recent" list (unlike `prStatesAsOf`, which must stay correct for a
 *  long-open PR). */
export async function recentPrRows(ctx: TenantContext, limit: number, sinceIso: string): Promise<RepoPrRow[]> {
  // Three levels: the innermost computes `rn` (its ORDER BY may reach `id` on
  // the base table); the middle filters to the latest row per PR and orders/
  // limits by it (so `id` must still be a selected column there); the outer
  // finally drops `id`, leaving exactly the narrow row type.
  return await all<RepoPrRow>(ctx,
    `SELECT ${PR_ROW_COLS} FROM (
       SELECT id, ${PR_ROW_COLS} FROM (
         SELECT id, ${PR_ROW_COLS}, ROW_NUMBER() OVER (PARTITION BY number ORDER BY occurred_at DESC, id DESC) AS rn
           FROM repo_events WHERE org_id = ? AND kind = 'pr' AND occurred_at > ?
       ) WHERE rn = 1 ORDER BY occurred_at DESC, id DESC LIMIT ?
     )`, ctx.orgId, sinceIso, limit);
}

export async function commitsByDay(ctx: TenantContext, sinceIso: string): Promise<Map<string, number>> {
  const rows = await all<{ day: string; n: number }>(ctx,
    `SELECT substr(occurred_at, 1, 10) AS day, SUM(COALESCE(count, 0)) AS n
       FROM repo_events WHERE org_id = ? AND kind = 'push' AND occurred_at > ? GROUP BY day`, ctx.orgId, sinceIso);
  return new Map(rows.map((r) => [r.day, r.n]));
}

export async function pushRowsSince(ctx: TenantContext, sinceIso: string): Promise<RepoEventRow[]> {
  return await all<RepoEventRow>(ctx,
    `SELECT * FROM repo_events WHERE org_id = ? AND kind = 'push' AND occurred_at > ? ORDER BY occurred_at DESC, id DESC`, ctx.orgId, sinceIso);
}

// ── checks, workflow runs, reviews (Task 7's capture) ────────────────────────
//
// Every read below is BATCHED on purpose. The dashboard renders N environments
// and a page of PRs; a per-row or per-environment query would cost dozens of D1
// round-trips on the render path. Each function here is ONE statement whatever
// N is. (Deploys are not read here: every part's deploys are its hosting
// provider's, `hosting_deploys` — `hostingReads` in ./store.ts.)

/** Only these run conclusions are decisive — a cancelled or skipped run says
 *  nothing about whether CI is healthy, so it is not in the denominator. */
const DECISIVE = ["success", "failure", "timed_out"];

/** A check conclusion that is a failure (see `checkState`). */
const FAIL_STATES = ["failure", "error", "timed_out"];

/** The head sha of each branch — the newer of two sources, never a third query
 *  per branch:
 *
 *  1. the latest captured `push` row for that branch (what the webhook saw), and
 *  2. the `env_heads` snapshot `reconcileRepo` writes (`{ [branch]: sha }`),
 *     which exists so a branch pushed rarely (production) still has a head for
 *     "CI on head" to key checks off.
 *
 *  The snapshot wins only when it is NEWER than that branch's latest push (or
 *  when no push was ever captured for it) — a Sync is a point-in-time read, and
 *  a push that landed after it is the better answer. Two D1 statements whatever
 *  the branch count, side by side (one round trip's wait). */
export async function branchHeads(ctx: TenantContext, branches: string[]): Promise<Map<string, string>> {
  const refs = [...new Set(branches.filter(Boolean))];
  if (!refs.length) return new Map();
  const [rows, snap] = await Promise.all([
    fanOut<{ ref: string; sha: string; at: string }>(ctx, refs, (p) =>
      `SELECT ref, sha, at FROM (
         SELECT ref, sha, occurred_at AS at, ROW_NUMBER() OVER (PARTITION BY ref ORDER BY occurred_at DESC, id DESC) AS rn
           FROM repo_events WHERE org_id = ? AND kind = 'push' AND ref IN (${p})
       ) WHERE rn = 1 AND sha IS NOT NULL`, [ctx.orgId]),
    getSnapshot<Record<string, unknown>>(ctx, "env_heads"),
  ]);
  const out = new Map(rows.map((r) => [r.ref, r.sha] as const));
  if (snap) {
    for (const ref of refs) {
      const sha = snap.data?.[ref];
      if (typeof sha !== "string" || !sha) continue;
      const push = rows.find((r) => r.ref === ref);
      // A PRECEDENCE decision (which of two facts about the SAME head wins),
      // not a window bound — so this must compare parsed instants, not raw ISO
      // strings. `occurred_at` is stored WITHOUT milliseconds
      // ("…T12:00:30Z") while `computed_at` comes from `new Date().toISOString()`
      // WITH them ("…T12:00:30.500Z"); within the same UTC second '.' < 'Z', so a
      // genuinely newer snapshot would lose a plain string compare.
      if (!push || Date.parse(snap.computedAt) > Date.parse(push.at)) out.set(ref, sha);
    }
  }
  return out;
}

/** The LATEST state of every check on each of these commits (a re-run
 *  supersedes its earlier result), keyed by sha. One query for every sha the
 *  render needs — the environment heads and the listed PRs' heads together. */
export async function latestChecks(ctx: TenantContext, shas: string[]): Promise<Map<string, { name: string; state: string }[]>> {
  const ids = [...new Set(shas.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await fanOut<{ sha: string; name: string; state: string }>(ctx, ids, (p) =>
    `SELECT sha, name, state FROM (
       SELECT sha, name, state, ROW_NUMBER() OVER (PARTITION BY sha, name ORDER BY occurred_at DESC, id DESC) AS rn
         FROM repo_events WHERE org_id = ? AND kind = 'check' AND sha IN (${p}) AND name IS NOT NULL AND state IS NOT NULL
     ) WHERE rn = 1 ORDER BY name`, [ctx.orgId]);
  const out = new Map<string, { name: string; state: string }[]>();
  for (const r of rows) out.set(r.sha, [...(out.get(r.sha) ?? []), { name: r.name, state: r.state }]);
  return out;
}

/** One commit's checks as a single verdict — null when nothing is captured for
 *  it, so the PR list's checks column renders nothing rather than a guess.
 *
 *  `failure` / `error` / `timed_out` are a fail, `pending` is still running,
 *  and everything else — `success`, `neutral`, `skipped` (nothing happened),
 *  and the abandoned bucket (`cancelled` / `stale` / `action_required`) — is
 *  NOT a failing check. This column has only pass/fail/run, and "abandoned" is
 *  not a statement about the code under review, so it reads as "nothing
 *  failing". */
export function checkState(checks: { state: string }[] | undefined): "pass" | "fail" | "run" | null {
  if (!checks?.length) return null;
  if (checks.some((c) => FAIL_STATES.includes(c.state))) return "fail";
  if (checks.some((c) => c.state === "pending")) return "run";
  return "pass";
}

/** PRs whose latest review per reviewer includes an approval and no standing
 *  change request. One query for the whole page of PRs. */
export async function approvedPrs(ctx: TenantContext, numbers: number[]): Promise<Set<number>> {
  const ids = [...new Set(numbers.filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Set();
  const rows = await fanOut<{ number: number; state: string }>(ctx, ids, (p) =>
    `SELECT number, state FROM (
       SELECT number, state, ROW_NUMBER() OVER (PARTITION BY number, actor_login ORDER BY occurred_at DESC, id DESC) AS rn
         FROM repo_events WHERE org_id = ? AND kind = 'review' AND state IN ('approved', 'changes_requested', 'dismissed')
          AND number IN (${p})
     ) WHERE rn = 1`, [ctx.orgId]);
  const blocked = new Set(rows.filter((r) => r.state === "changes_requested").map((r) => r.number));
  return new Set(rows.filter((r) => r.state === "approved" && !blocked.has(r.number)).map((r) => r.number));
}

/** The most recent failed workflow runs in the window. */
export async function ciFailureRows(ctx: TenantContext, sinceIso: string, limit: number): Promise<RepoRunRow[]> {
  return await all<RepoRunRow>(ctx,
    `SELECT name, ref, title, url, occurred_at FROM repo_events
      WHERE org_id = ? AND kind = 'run' AND state IN ('failure', 'timed_out') AND occurred_at > ?
      ORDER BY occurred_at DESC, id DESC LIMIT ?`, ctx.orgId, sinceIso, limit);
}

/** Failed/timed-out runs that still have no job title, newest first — the
 *  backlog `reconcileRepo` drains a capped slice of on each Sync. Bounded to a
 *  window so an ancient unlabellable run cannot block the queue forever. */
export async function untitledFailedRuns(ctx: TenantContext, sinceIso: string, limit: number): Promise<{ number: number; semantic_key: string }[]> {
  return all<{ number: number; semantic_key: string }>(ctx,
    `SELECT number, semantic_key FROM repo_events
      WHERE org_id = ? AND kind = 'run' AND state IN ('failure', 'timed_out') AND title IS NULL AND number IS NOT NULL
        AND occurred_at > ?
      ORDER BY occurred_at DESC, id DESC LIMIT ?`, ctx.orgId, sinceIso, limit);
}

/** Failure rate (%) per UTC day for the last 7 calendar days, oldest first,
 *  plus the rate over exactly those SAME seven buckets. Cancelled/skipped runs
 *  are not decisive (see the policy at `foldResult`). The window starts at the
 *  oldest bucket's UTC midnight — a rolling 7×24h bound would pull in rows from
 *  a partial eighth day that belong to no bar, so the headline rate and the
 *  sparkline would describe different windows. */
export async function ciDailyRates(ctx: TenantContext, now: number): Promise<{ days: number[]; rate: number }> {
  const day = (i: number) => new Date(now - i * 86_400_000).toISOString().slice(0, 10);
  const since = `${day(6)}T00:00:00.000Z`;
  const rows = await all<{ day: string; state: string; n: number }>(ctx,
    `SELECT substr(occurred_at, 1, 10) AS day, state, COUNT(*) AS n FROM repo_events
      WHERE org_id = ? AND kind = 'run' AND occurred_at >= ? AND state IN (${ph(DECISIVE.length)}) GROUP BY day, state`,
    ctx.orgId, since, ...DECISIVE);
  let bad = 0, total = 0;
  const days: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const of = rows.filter((r) => r.day === day(i));
    const t = of.reduce((n, r) => n + r.n, 0);
    const b = of.filter((r) => r.state !== "success").reduce((n, r) => n + r.n, 0);
    bad += b; total += t;
    days.push(t ? Math.round((b / t) * 1000) / 10 : 0);
  }
  return { days, rate: total ? Math.round((bad / total) * 1000) / 10 : 0 };
}

export async function reviewRowsSince(ctx: TenantContext, sinceIso: string): Promise<RepoReviewRow[]> {
  return await all<RepoReviewRow>(ctx,
    `SELECT number, state, actor_login, url, occurred_at FROM repo_events
      WHERE org_id = ? AND kind = 'review' AND occurred_at > ? ORDER BY occurred_at DESC, id DESC`, ctx.orgId, sinceIso);
}

/** Workflow runs captured in each of the last two weeks (by `occurred_at`) — the Overview's "CI runs" figure.
 *  ONE statement. */
export async function runCounts(ctx: TenantContext, weekAgoIso: string, twoWeeksAgoIso: string): Promise<{ thisWeek: number; lastWeek: number }> {
  const row = await first<{ this_week: number | null; last_week: number | null }>(ctx,
    `SELECT SUM(CASE WHEN occurred_at > ? THEN 1 ELSE 0 END) AS this_week,
            SUM(CASE WHEN occurred_at > ? AND occurred_at <= ? THEN 1 ELSE 0 END) AS last_week
       FROM repo_events WHERE org_id = ? AND kind = 'run' AND occurred_at > ?`,
    weekAgoIso, twoWeeksAgoIso, weekAgoIso, ctx.orgId, twoWeeksAgoIso);
  return { thisWeek: row?.this_week ?? 0, lastWeek: row?.last_week ?? 0 };
}
