// An environment's verdict on the Repo Overview — the design's `verdictFor` (repo-data.js) over `RepoFacts`.
// STAND-IN written by Phase C3 so the Production card can import it: C1 owns this module and its real version
// replaces this one at merge. Same signature: `envVerdict(f, envKey)`.
//
// The order is the design's: every part unknown → Unknown; a health check with no answer → Down; a failed
// deploy → Failing; an app serving an older commit than another here → Out of step; failing checks on the
// branch head → Degraded; else Healthy. A verdict is a mark (`kindMark`), never a pill.
import type { RepoFacts } from "@shared/repo-facts-core";
import type { StateKind } from "./marks";

export type VerdictKey = "healthy" | "degraded" | "failing" | "down" | "unknown" | "outOfStep";
export interface Verdict { key: VerdictKey; word: string; kind: StateKind; tip: string }

export const VERDICT: Record<VerdictKey, Verdict> = {
  healthy: { key: "healthy", word: "Healthy", kind: "good", tip: "Checks pass on the branch head and every app here is live." },
  degraded: { key: "degraded", word: "Degraded", kind: "warn", tip: "Checks are failing on the branch head." },
  failing: { key: "failing", word: "Failing", kind: "bad", tip: "A deploy here failed." },
  down: { key: "down", word: "Down", kind: "stopped", tip: "Its health check gets no answer." },
  unknown: { key: "unknown", word: "Unknown", kind: "waiting", tip: "Trov has not seen a deploy here yet." },
  outOfStep: { key: "outOfStep", word: "Out of step", kind: "warn", tip: "Apps in this environment run different commits." },
};

export function envVerdict(f: RepoFacts, envKey: string): Verdict {
  const parts = f.parts.filter((p) => p.env === envKey);
  if (parts.every((p) => !p.serving && !p.latest)) return VERDICT.unknown;
  if (parts.some((p) => p.health && !p.health.up && !p.health.stale)) return VERDICT.down;
  if (parts.some((p) => p.latest?.state === "error")) return VERDICT.failing;
  if (f.outOfStep.some((o) => o.env === envKey)) return VERDICT.outOfStep;
  if (f.ci.find((c) => c.env === envKey)?.state === "fail") return VERDICT.degraded;
  return VERDICT.healthy;
}
