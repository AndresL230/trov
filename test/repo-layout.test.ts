// shared/repo-layout-core.ts is the design's own layout rules, moved unchanged: this runs the design's data
// module (docs/superpowers/specs/repo-setups-design/repo-data.js) beside it over every scenario, variant, Group by
// and App narrowing it draws, and asserts the same rule, opener, Group by and tabs.
import { describe, expect, it } from "vitest";
import { decide, layoutOf, RULES, TABS, type LayoutInput } from "@shared/repo-layout-core";
// @ts-expect-error — the design's module is plain JS with no declarations; it is read here as the reference.
import * as design from "../docs/superpowers/specs/repo-setups-design/repo-data.js";

interface DesignScreen { s: LayoutInput & { apps: { name: string; kind: string }[] }; ruleKey: string; opener: string; canGroup: boolean; group: string; tabs: { value: string; label: string }[] }
const buildScreen = design.buildScreen as (o: Record<string, unknown>) => DesignScreen;

const VARIANTS: Record<string, string[]> = { A: ["", "outOfStep", "trouble"], B: ["", "failed", "trouble"], G: ["", "after"], N: ["", "trov"] };
const SCENARIOS = "ABCDEFGHIJKLMN".split("");

// The design's view model throws for G/after (ledger in Staging is "building" with no previous deploy, and its
// row reads `prev.sha`) — a slip in the design's sample data, not in the rules. G's calm variant has the same
// apps, environments and targets, so the rule is still covered there.
const DESIGN_DATA_SLIPS = new Set(["G/after"]);

const cases = SCENARIOS.flatMap((scenario) => (VARIANTS[scenario] ?? [""]).filter((v) => !DESIGN_DATA_SLIPS.has(`${scenario}/${v}`)).flatMap((variant) => {
  const apps = buildScreen({ scenario, variant }).s.apps.map((a) => a.name);
  return [undefined, ...apps, "__repo"].flatMap((app) => [undefined, "env", "app"].map((group) => ({ scenario, variant, app, group })));
}));

describe("the layout core is the design's rules, unchanged", () => {
  it("RULES carry the design's ids, names and wording", () => {
    expect(RULES).toEqual(design.RULES);
  });

  it.each(cases)("$scenario/$variant app=$app group=$group", (o) => {
    const v = buildScreen(o);
    const layout = layoutOf(v.s, o.group as "env" | "app" | undefined);
    expect(decide(v.s)).toBe(v.ruleKey);
    expect(layout.rule).toBe(v.ruleKey);
    expect(layout.opener).toBe(v.opener);
    expect(layout.canGroup).toBe(v.canGroup);
    expect(layout.group).toBe(v.group);
    expect(layout.tabs.map(([value, label]) => ({ value, label }))).toEqual(v.tabs.map(({ value, label }) => ({ value, label })));
    expect(TABS(v.s)).toEqual((design.TABS as (s: unknown) => unknown)(v.s));
  });

  it("only the known design-data slip throws in the design's own view model", () => {
    expect(() => buildScreen({ scenario: "G", variant: "after" })).toThrow();
  });

  it("every rule is reached by some scenario", () => {
    const seen = new Set(cases.map((o) => buildScreen(o).ruleKey));
    expect([...seen].sort()).toEqual(Object.keys(RULES).sort());
  });
});
