import type { SprintRow, SprintProgressRow } from "@shared/rows";
import { type TenantContext, all, run, nowIso } from "../data/sql";
import { progressFromIssueEvent } from "../webhook";
import { isIssueGone } from "./issue-gone";

const GH_API = "application/vnd.github+json";
const USER_AGENT = "trov";

/**
 * Live progress for a sprint's `github_ref`, computed from GitHub. `ref` is JSON:
 * a number (the number of an issue GROUP on GitHub) or an array of issue numbers.
 * Never throws — returns null on parse failure, a non-OK response (expired/revoked
 * token, missing resource), or any error, so the recompute degrades gracefully.
 * `fetchImpl` is injectable for tests (the pool has no exported fetch mock).
 */
export async function fetchGithubRefProgress(opts: {
  token: string;
  repo: string;
  ref: string;
  fetchImpl?: typeof fetch;
}): Promise<{ closed: number; total: number } | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${opts.token}`, accept: GH_API, "user-agent": USER_AGENT };

  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.ref);
  } catch {
    return null;
  }

  try {
    if (Array.isArray(parsed)) {
      let closed = 0;
      let total = 0;
      for (const n of parsed) {
        const res = await doFetch(`https://api.github.com/repos/${opts.repo}/issues/${n}`, { headers });
        if (!res.ok) {
          // Token/auth-level failure → the whole sprint's progress is unknown.
          if (res.status === 401 || res.status === 403) return null;
          // A single missing/inaccessible issue (e.g. 404) → skip it; keep counting the rest.
          continue;
        }
        const data = (await res.json()) as { state?: string };
        if (data.state === "closed") closed++;
        total++;
      }
      return { closed, total };
    }
    if (typeof parsed === "number") {
      // GitHub's own REST path — not Trov vocabulary.
      const res = await doFetch(`https://api.github.com/repos/${opts.repo}/milestones/${parsed}`, { headers });
      if (!res.ok) return null;
      const data = (await res.json()) as { open_issues?: number; closed_issues?: number };
      const closed = data.closed_issues ?? 0;
      return { closed, total: (data.open_issues ?? 0) + closed };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Absolute overwrite of one sprint's cached progress. `closed`/`total` are
 * always the FULL current counts (never deltas), so replays and out-of-order
 * writes are all safe — the last write simply wins. The cache is keyed by the
 * sprint's (global) id, so the overwrite is confined to this org's own row.
 */
export async function upsertProgress(
  ctx: TenantContext,
  sprintId: number,
  closed: number,
  total: number,
  source: "event" | "recompute"
): Promise<void> {
  await run(
    ctx,
    `INSERT INTO sprint_progress (org_id, sprint_id, closed, total, source, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(sprint_id) DO UPDATE SET
       closed = excluded.closed,
       total = excluded.total,
       source = excluded.source,
       computed_at = excluded.computed_at
     WHERE sprint_progress.org_id = excluded.org_id`,
    ctx.orgId,
    sprintId,
    closed,
    total,
    source,
    nowIso()
  );
}

/** The full progress cache, keyed by sprint id. */
export async function getProgress(ctx: TenantContext): Promise<Map<number, SprintProgressRow>> {
  const rows = await all<SprintProgressRow>(ctx, `SELECT * FROM sprint_progress WHERE org_id = ?`, ctx.orgId);
  return new Map(rows.map((r) => [r.sprint_id, r]));
}

// Latest-snapshot SQL: for a set of issue numbers, the most-recently-captured
// 'issue' event per ref_number (occurred_at DESC, id DESC as the tiebreak).
function latestIssueSnapshotSql(count: number): string {
  const placeholders = Array(count).fill("?").join(", ");
  return `
    SELECT ref_number, raw FROM (
      SELECT ref_number, raw, ROW_NUMBER() OVER (PARTITION BY ref_number ORDER BY occurred_at DESC, id DESC) rn
      FROM events WHERE org_id = ? AND event_type = 'issue' AND ref_number IN (${placeholders})
    ) WHERE rn = 1
  `;
}

/**
 * The webhook-side write: derive this issue event's implication for every
 * sprint it can affect, and upsert an absolute progress row for each.
 *
 * (a) Group-number ref: progressFromIssueEvent(payload) reads the counts of the
 *     GitHub issue group this issue belongs to (open + closed = total) —
 *     authoritative, no query needed.
 * (b) Array ref: for every sprint whose github_ref is a JSON array containing
 *     this event's issue number, recount from the LATEST captured snapshot of
 *     each array member (total = array length; closed = how many of those
 *     latest snapshots have state:"closed").
 *
 * Never throws on a malformed payload — both branches simply no-op.
 */
export async function applyEventProgress(ctx: TenantContext, payload: unknown): Promise<void> {
  const derived = progressFromIssueEvent(payload);
  if (derived) {
    const matches = await all<SprintRow>(
      ctx,
      `SELECT * FROM sprints WHERE org_id = ? AND github_ref = ?`,
      ctx.orgId,
      JSON.stringify(derived.groupNumber)   // the GitHub issue-group number
    );
    for (const sp of matches) {
      await upsertProgress(ctx, sp.id, derived.closed, derived.total, "event");
    }
  }

  const issueNumber =
    payload !== null && typeof payload === "object"
      ? (payload as { issue?: { number?: number } }).issue?.number
      : undefined;
  if (typeof issueNumber !== "number") return;

  const candidates = await all<SprintRow>(ctx, `SELECT * FROM sprints WHERE org_id = ? AND github_ref IS NOT NULL`, ctx.orgId);
  for (const sp of candidates) {
    let ref: unknown;
    try {
      ref = JSON.parse(sp.github_ref!);
    } catch {
      continue;
    }
    if (!Array.isArray(ref) || !ref.includes(issueNumber)) continue;

    const rows = ref.length > 0
      ? await all<{ ref_number: number; raw: string }>(ctx, latestIssueSnapshotSql(ref.length), ctx.orgId, ...ref)
      : [];
    let closed = 0;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.raw) as { action?: string; issue?: { state?: string } };
        // A deleted / transferred issue has left the repo — resolved, for the
        // sprint's purposes, even though its snapshot still reads "open".
        if (parsed.issue?.state === "closed" || isIssueGone(parsed.action)) closed++;
      } catch {
        // malformed snapshot — treat as not-closed rather than throw
      }
    }
    await upsertProgress(ctx, sp.id, closed, ref.length, "event");
  }
}

/**
 * Scheduled backstop: recompute every sprint-with-a-github_ref's progress live
 * from GitHub and overwrite the cache with source:'recompute'. A sprint whose
 * fetch fails (expired token, GitHub outage, …) is left with its existing cache
 * row untouched — this never wipes progress, and never 500s.
 */
export async function recomputeAllProgress(
  ctx: TenantContext,
  opts: { token: string; repo: string; fetchImpl?: typeof fetch }
): Promise<{ updated: number }> {
  const sprints = await all<SprintRow>(ctx, `SELECT * FROM sprints WHERE org_id = ? AND github_ref IS NOT NULL`, ctx.orgId);
  let updated = 0;
  for (const sp of sprints) {
    const progress = await fetchGithubRefProgress({
      token: opts.token,
      repo: opts.repo,
      ref: sp.github_ref!,
      fetchImpl: opts.fetchImpl,
    });
    if (progress) {
      await upsertProgress(ctx, sp.id, progress.closed, progress.total, "recompute");
      updated++;
    }
  }
  return { updated };
}
