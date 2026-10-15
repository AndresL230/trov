// An environment's verdict on the Repo Overview — the design's `verdictFor` (repo-setups-design/repo-data.js),
// read from `RepoFacts` alone. One function, so the header's environment pills and the environment cards can
// never disagree. In order: every part unknown (no deploy seen) → unknown; a health check gets no answer → down;
// a deploy failed → failing; apps run different commits → out of step; checks fail on the branch head →
// degraded; else healthy. A stale health reading is neither up nor down, so it never makes an environment down.
import type { RepoFacts } from "@shared/repo-facts-core";

export type EnvVerdict = "healthy" | "degraded" | "failing" | "down" | "unknown" | "outOfStep";

export function envVerdict(f: RepoFacts, envKey: string): EnvVerdict {
  const parts = f.parts.filter((p) => p.env === envKey);
  if (parts.every((p) => !p.serving && !p.latest)) return "unknown";
  if (parts.some((p) => p.health !== null && !p.health.stale && !p.health.up)) return "down";
  if (parts.some((p) => p.latest?.state === "error")) return "failing";
  if (f.outOfStep.some((o) => o.env === envKey)) return "outOfStep";
  if (f.ci.find((c) => c.env === envKey)?.state === "fail") return "degraded";
  return "healthy";
}
