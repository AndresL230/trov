export type RepoEventKind = "push" | "pr" | "review" | "deploy" | "check" | "run";
export type RepoPart = "backend" | "frontend";

/** One captured repo fact on its way into the gate. Optional = NULL in D1. */
export interface RepoEvent {
  semantic_key: string;
  kind: RepoEventKind;
  ref?: string | null;
  sha?: string | null;
  number?: number | null;
  env?: string | null;
  part?: RepoPart | null;
  state?: string | null;
  name?: string | null;
  actor_login?: string | null;
  title?: string | null;
  url?: string | null;
  count?: number | null;
  raw: string;
  provenance: "webhook" | "backfill";
  occurred_at: string;
}

export interface RepoEventRow {
  id: number; semantic_key: string; kind: RepoEventKind;
  ref: string | null; sha: string | null; number: number | null; env: string | null; part: RepoPart | null;
  state: string | null; name: string | null; actor_login: string | null; title: string | null; url: string | null;
  count: number | null; raw: string; provenance: "webhook" | "backfill"; occurred_at: string; recorded_at: string;
}

/** The `pr` row, narrowed to what `getRepoDashboard` (src/tools/repo.ts) actually
 *  reads off `prStatesAsOf` / `recentPrRows` — never `raw` (the payload slice),
 *  and never the columns no PR reader touches (`env`, `part`, `name`,
 *  `count`, `provenance`, `recorded_at`, `id`). `sha` is the PR's HEAD sha —
 *  what the check-run capture is keyed on, so the list can show check state. */
export interface RepoPrRow {
  number: number | null;
  state: string | null;
  ref: string | null;
  sha: string | null;
  actor_login: string | null;
  title: string | null;
  url: string | null;
  occurred_at: string;
}

/** A `run` row narrowed to what the CI-failure list renders. */
export interface RepoRunRow {
  name: string | null;
  ref: string | null;
  title: string | null;
  url: string | null;
  occurred_at: string;
}

/** A `review` row narrowed to what the feed and the contributor tally read. */
export interface RepoReviewRow {
  number: number | null;
  state: string | null;
  actor_login: string | null;
  url: string | null;
  occurred_at: string;
}

export interface RepoMetric { metric: string; env: string; part: string; value: number; at: string }

/** The `repo_snapshots` kind recording what the LEGACY Cloudflare analytics poll
 *  (removed with 0056_hosting_providers — nothing writes it any more; a Cloudflare part's
 *  coverage is now its `hosting_poll_state` row) had LOOKED AT, per environment: `{ [envKey]: { from, to } }`
 *  — ONE contiguous covered interval, both ends hour floors, `to` EXCLUSIVE
 *  (covered through 11:00 means the 10:00 bucket is the last one a poll has
 *  seen). Cloudflare returns no row for a quiet hour, so this is what entitles
 *  the projection (src/tools/repo.ts) to draw a missing hour as 0 — and an
 *  INTERVAL rather than one high-water bound, because a bound cannot say that a
 *  stretch in the middle (a poll outage longer than the window) was never seen. */
export const CF_POLLED = "cf_polled";
export interface CfCovered { from: string; to: string }
export type CfPolled = Record<string, CfCovered>;
/** How many COMPLETE hours one Cloudflare poll asks for — and so how much a
 *  legacy marker (below) is known to have covered. */
export const CF_POLL_HOURS = 3;

/** One environment's `cf_polled` entry as instants, or null when it says
 *  nothing usable. The shape before intervals was a single ISO string (the
 *  exclusive bound) and still sits in databases written by that code: it reads
 *  as `{ from: bound − 3h, to: bound }` — the one poll window that certainly
 *  produced it; whatever lay before that is not known to be contiguous. Pure. */
export function cfCovered(v: unknown): { from: number; to: number } | null {
  if (typeof v === "string") {
    const to = Date.parse(v);
    return Number.isFinite(to) ? { from: to - CF_POLL_HOURS * 3_600_000, to } : null;
  }
  if (!v || typeof v !== "object") return null;
  const { from, to } = v as { from?: unknown; to?: unknown };
  const f = typeof from === "string" ? Date.parse(from) : NaN;
  const t = typeof to === "string" ? Date.parse(to) : NaN;
  return Number.isFinite(f) && Number.isFinite(t) && f <= t ? { from: f, to: t } : null;
}
