/**
 * `decide()` parity between the SPA and MCP (repo setups, the guard): the same facts give the same layout over
 * MCP `get_repo_dashboard` (src/tools/repo-agent.ts `shapeRepoDashboard`, which returns `layout` beside `facts`) as
 * on the screen (web/src/repo.ts `factsView` — `layoutOf(layoutInputOf(facts), group ?? facts.groupDefault)`), for
 * every design scenario × variant × App narrowing × admin default Group by. The MCP view's own `facts` also
 * decide that layout again (shaping them never drops what the rules read).
 */
import { describe, expect, it } from "vitest";
import { layoutInputOf, type RepoFacts } from "@shared/repo-facts-core";
import { layoutOf, type GroupBy } from "@shared/repo-layout-core";
import type { RepoDashboard } from "@shared/repo";
import { repoSample, repoScenario, SCENARIO_KEYS, SCENARIO_VARIANTS } from "../web/src/repo-sample";
import { factsView } from "../web/src/repo";
import { shapeRepoDashboard } from "../src/tools/repo-agent-view";

const NOW = Date.parse("2026-10-15T12:00:00Z");

/** What the screen draws for a payload, through its own function (no session Group by: the admin's default rules). */
const spaLayout = (dash: RepoDashboard) =>
  factsView({ repo: { status: "ready", data: dash } as never, app: dash.facts!.app, group: null, noRepo: false, sample: false } as never)!.layout;

const cases = SCENARIO_KEYS.flatMap((scenario) => SCENARIO_VARIANTS[scenario].flatMap((variant) => {
  const apps = repoScenario(scenario, variant, { now: NOW }).allApps.map((a) => a.key);
  return [null, ...apps, "__repo"].flatMap((app) => ([null, "env", "app"] as (GroupBy | null)[]).map((groupDefault) => ({
    scenario, variant, app, groupDefault, label: `${scenario}/${variant || "calm"} app=${app ?? "all"} default=${groupDefault ?? "-"}`,
  })));
}));

describe("decide() parity — SPA and MCP draw the same layout from the same facts", () => {
  it.each(cases)("$label", ({ scenario, variant, app, groupDefault }) => {
    const facts: RepoFacts = { ...repoScenario(scenario, variant, { now: NOW, app }), groupDefault };
    const dash: RepoDashboard = { ...repoSample(NOW), sample: undefined, facts };
    for (const tab of [undefined, "overview"] as const) {
      for (const includeTrends of [false, true]) {
        const view = shapeRepoDashboard(dash, { tab, includeTrends });
        expect(view.layout).toEqual(spaLayout(dash));
        expect(view.layout).toEqual(layoutOf(layoutInputOf(view.facts as RepoFacts), (view.facts as RepoFacts).groupDefault));
      }
    }
    // the other tabs carry neither
    expect(shapeRepoDashboard(dash, { tab: "code" })).not.toHaveProperty("layout");
  });
});
