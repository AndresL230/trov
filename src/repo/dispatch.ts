// The ROTATION dispatcher behind the repo cron (canopy-multitenancy.md §8.3, D17 as amended by Q4).
// A job is a list of UNITS — one per (org, environment) or one per org — and one invocation serves as
// many as its budget allows, in a stable order, starting AFTER the unit the previous invocation
// stopped at (`cron_cursor`). While every unit fits in one invocation the cursor stays `''` and is
// never written; once orgs × environments outgrow the budget each tick serves the next slice, so no
// org starves. No Queues: this is the deferred seam's stand-in, and a unit runner is shaped so a
// queue consumer can later call it unchanged (one message = one unit).
import type { PlatformContext } from "../data/context";
import { readCursor, writeCursor } from "../platform/jobs";

/**
 * Outbound `fetch`es one cron invocation may make (D1 does not count). Workers Paid allows 1,000 per
 * invocation; the rest is headroom for a health ping that follows a redirect and for a job whose cost
 * is an estimate (`progress`). The free plan's cap is 50 — see `SUBREQUEST_CAP` in ./cron.ts, which
 * the on-demand "Poll now" still honours for ONE org.
 */
export const CRON_SUBREQUEST_BUDGET = 900;
/** Wall clock one invocation may spend serving units: every fetch is bounded (8–15 s) but units run
 *  one after another, and the next tick is ten minutes away. */
export const CRON_WALL_BUDGET_MS = 8 * 60_000;

export interface Unit {
  /** Stable, unique within its job, and what the cursor stores: `<org id>` or `<org id>/<env key>`. */
  key: string;
  orgId: string;
  /** Worst-case subrequests — what must still fit in the budget for the unit to START. */
  cost: number;
}

/** What one invocation has spent. `fetch` is the counting fetch every unit must use. */
export interface Budget {
  readonly limit: number;
  readonly wallMs: number;
  readonly started: number;
  spent: number;
  readonly fetch: typeof fetch;
}

export function newBudget(fetchImpl: typeof fetch = fetch, limit: number = CRON_SUBREQUEST_BUDGET, wallMs: number = CRON_WALL_BUDGET_MS): Budget {
  const budget: Budget = {
    limit, wallMs, started: Date.now(), spent: 0,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      budget.spent++;
      return fetchImpl(input, init);
    }) as typeof fetch,
  };
  return budget;
}

/** `units` in the order given (the lister's — stable from tick to tick), rotated to start AFTER the
 *  unit keyed `lastKey`. A cursor naming a unit that no longer exists (an environment or org removed
 *  since) starts from the top: one repeated slice, never a skipped one. */
export function rotated<U extends Unit>(units: readonly U[], lastKey: string): U[] {
  const at = lastKey ? units.findIndex((u) => u.key === lastKey) : -1;
  return at < 0 ? [...units] : [...units.slice(at + 1), ...units.slice(0, at + 1)];
}

export interface Served { served: string[]; deferred: number }

/**
 * Serve `job`'s units by rotation. A unit starts only while its worst case still fits under `cap`
 * (a share of the invocation's budget) and the wall-clock budget is not spent; the first one that
 * does not fit ends the job for this invocation and the cursor records the last unit served.
 * `runUnit` is expected to be TOTAL (it logs its own failures, scrubbed); if it throws all the same,
 * only the error's NAME is logged here — this function knows no credential to scrub a message with —
 * and the loop moves on. One unit's failure never stops another, and nothing throws out of here.
 */
export async function serveJob<U extends Unit>(
  p: PlatformContext, job: string, units: readonly U[], budget: Budget, cap: number, runUnit: (unit: U) => Promise<void>,
): Promise<Served> {
  if (units.length === 0) return { served: [], deferred: 0 }; // nothing configured anywhere: not even a cursor read
  const cursor = await readCursor(p, job);
  const order = rotated(units, cursor);
  const served: string[] = [];
  for (const unit of order) {
    if (budget.spent + unit.cost > cap || Date.now() - budget.started > budget.wallMs) break;
    try {
      await runUnit(unit);
    } catch (e) {
      console.error("repo cron", job, e instanceof Error ? e.name : "error", `org=${unit.orgId}`);
    }
    served.push(unit.key);
  }
  const deferred = order.length - served.length;
  // All served → nothing is pending and the next invocation starts from the top. Otherwise it resumes
  // after the last unit served; with none served (the budget was already spent) the cursor stands.
  const next = deferred === 0 ? "" : served.length ? served[served.length - 1] : cursor;
  if (next !== cursor) await writeCursor(p, job, next);
  if (deferred) console.warn("repo cron", job, `served ${served.length} of ${order.length} units; the rest resume next tick`);
  return { served, deferred };
}
