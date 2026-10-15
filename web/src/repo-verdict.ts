// An environment's verdict on the Repo Overview — ONE function for the header's environment pills (repo-header.ts)
// and the environment cards (repo-env-cards.ts), so the two can never disagree. The design's `verdictFor`
// (docs/superpowers/specs/repo-setups-design/repo-data.js), read from `RepoFacts` instead of the design's targets:
//
//   every part of the environment reports nothing yet        → Unknown   (ring)
//   a part's health check gets no answer (a fresh reading)   → Down      (square)
//   a part's newest production deploy failed                 → Failing   (diamond)
//   an app serves an older commit than another app here      → Out of step (triangle)
//   checks fail on the environment's branch head             → Degraded  (triangle)
//   checks PASS on the branch head                           → Healthy   (dot)
//   no checks captured (or still running), the parts live    → Live      (dot) — never Healthy on unknown checks
//                                                              (repo-dashboard.md: a landed deploy with no checks
//                                                              captured is not Healthy; master ruling, Phase C)
//
// The marks are marks.ts kinds (`kindMark` / `STATE_KIND`): the design's MARKS map onto them one to one — healthy
// = good, live = good, degraded / out of step = warn, failing = bad, down = stopped, unknown = waiting. A stale health reading is
// never read as up or down (it is "no recent reading", repo-facts-core.ts `FactsHealth.stale`).
import type { FactsCi, FactsPart, RepoFacts } from "@shared/repo-facts-core";
import type { StateKind } from "./marks";

export type VerdictKey = "healthy" | "live" | "degraded" | "failing" | "down" | "unknown" | "outOfStep";

export interface EnvVerdict {
  key: VerdictKey;
  /** The mark's word ("Healthy"). */
  word: string;
  kind: StateKind;
  /** What it means — the mark's `data-mtip` (the design's MARKS tips). */
  tip: string;
}

export const VERDICT: Record<VerdictKey, Omit<EnvVerdict, "key">> = {
  healthy: { word: "Healthy", kind: "good", tip: "Checks pass on the branch head and every app here is live." },
  live: { word: "Live", kind: "good", tip: "Serving traffic." },
  degraded: { word: "Degraded", kind: "warn", tip: "Checks are failing on the branch head." },
  failing: { word: "Failing", kind: "bad", tip: "A deploy here failed." },
  down: { word: "Down", kind: "stopped", tip: "Its health check gets no answer." },
  unknown: { word: "Unknown", kind: "waiting", tip: "Trov has not seen a deploy here yet." },
  outOfStep: { word: "Out of step", kind: "warn", tip: "Apps in this environment run different commits." },
};

/** A part Trov has seen nothing from: no serving deploy, none in flight, no history (the design's `unknown: true`). */
export const partUnknown = (p: FactsPart): boolean => !p.serving && !p.latest && p.history.length === 0;
/** A fresh health reading that says it is down (a stale one says nothing). */
export const partDown = (p: FactsPart): boolean => !!p.health && !p.health.up && !p.health.stale;
/** Its newest production deploy failed (`latest` is only ever the newest when it is not the serving one). */
export const partFailed = (p: FactsPart): boolean => p.latest?.state === "error";

const of = (key: VerdictKey): EnvVerdict => ({ key, ...VERDICT[key] });

/** The verdict of environment `envKey` over the parts in view. An environment with no part in view is Unknown. */
export function envVerdict(f: Pick<RepoFacts, "parts" | "outOfStep" | "ci">, envKey: string): EnvVerdict {
  const parts = f.parts.filter((p) => p.env === envKey);
  if (parts.every(partUnknown)) return of("unknown");
  if (parts.some(partDown)) return of("down");
  if (parts.some(partFailed)) return of("failing");
  if (f.outOfStep.some((o) => o.env === envKey && parts.some((p) => p.app === o.app))) return of("outOfStep");
  const ci = f.ci.find((c) => c.env === envKey)?.state ?? null;
  if (ci === "fail") return of("degraded");
  return of(ci === "pass" ? "healthy" : "live");
}

/** An environment's CI line ("All 14 checks passing on 3e9a1f2", "2 of 9 checks failing on e07b3a2", "Checks running
 *  on f19ad20", "deploy-normalizer.yml running on 4e1a9c7") and its tone — THE wording, for the environment cards,
 *  the Production card and anywhere else a branch head's checks are said. null when no checks are captured; a
 *  count the facts do not have is never printed (a running set has no total yet). */
export function ciLine(c: FactsCi | undefined): { tone: "good" | "bad" | "warn"; text: string } | null {
  if (!c || c.state === null) return null;
  const on = c.sha ? ` on ${c.sha.slice(0, 7)}` : "";
  const checks = (n: number): string => `${n} ${n === 1 ? "check" : "checks"}`;
  if (c.state === "pass") return { tone: "good", text: c.total !== null ? `All ${checks(c.total)} passing${on}` : `Checks passing${on}` };
  if (c.state === "fail") {
    return { tone: "bad", text: c.failing !== null && c.total !== null ? `${c.failing} of ${checks(c.total)} failing${on}` : c.failing !== null ? `${checks(c.failing)} failing${on}` : `Checks failing${on}` };
  }
  return { tone: "warn", text: c.total === null && c.names[0] ? `${c.names[0]} running${on}` : `Checks running${on}` };
}
