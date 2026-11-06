// ONE ranking of an environment's verdict — the Repo Overview's environment pills and cards (web/src/repo-verdict.ts
// `envVerdict`, over `RepoFacts`) and the dashboard's served `RepoEnv.pill` (src/tools/repo.ts — what My Work's
// Deploys tile, MCP and a payload without facts read) both rank with THIS function, so the two can no longer
// disagree. Each caller derives the signals from what it holds; the order is decided here only:
//
//   a fresh health reading says it is down           → down       (the site being unreachable is the headline)
//   every part reports nothing yet (no deploy)       → unknown
//   a part's newest production deploy failed         → failing
//   an app serves an older commit than another here  → outOfStep
//   checks fail on the environment's branch head     → degraded
//   checks PASS on the branch head                   → healthy
//   otherwise (no checks captured, or still running) → live       — never Healthy on unknown checks
//
// Zod-free and import-free (the `*-core.ts` rule): the SPA imports it as a value.

export type EnvVerdictKey = "healthy" | "live" | "degraded" | "failing" | "down" | "unknown" | "outOfStep";

export interface EnvVerdictSignals {
  /** A fresh (not stale) health reading says a part / the environment cannot be reached. */
  down: boolean;
  /** No part of the environment has reported a deploy (an environment with no part counts). */
  allUnknown: boolean;
  /** A part's newest production deploy failed. */
  failing: boolean;
  /** An app here serves an older commit than another app here (false where the caller does not read it). */
  outOfStep: boolean;
  /** The branch head's checks: `pass` (all settled, none failing), `fail` (one failing), else null. */
  ci: "pass" | "fail" | null;
}

export function envVerdictKey(s: EnvVerdictSignals): EnvVerdictKey {
  if (s.down) return "down";
  if (s.allUnknown) return "unknown";
  if (s.failing) return "failing";
  if (s.outOfStep) return "outOfStep";
  if (s.ci === "fail") return "degraded";
  return s.ci === "pass" ? "healthy" : "live";
}

/** The verdict as `RepoEnv.pill` (upper case on the wire) — and its tone. */
export const ENV_PILL: Readonly<Record<EnvVerdictKey, string>> = {
  healthy: "HEALTHY", live: "LIVE", degraded: "DEGRADED", failing: "FAILING", down: "DOWN", unknown: "UNKNOWN", outOfStep: "OUT OF STEP",
};
export const ENV_PILL_TONE: Readonly<Record<EnvVerdictKey, "good" | "warn" | "bad" | "neutral">> = {
  healthy: "good", live: "good", degraded: "warn", outOfStep: "warn", failing: "bad", down: "bad", unknown: "neutral",
};
