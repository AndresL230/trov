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

