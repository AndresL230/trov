// The Repo Overview's layout rules: which opener a repository's facts get, and the tabs it has. Moved
// UNCHANGED from the design's data module (`trovData`, docs/superpowers/specs/repo-setups-design/repo-data.js:
// `RULES`, `decide`, `TABS` and `buildScreen`'s group-by override) — test/repo-layout.test.ts runs the design's
// own module beside this one over every scenario. Zod-free: the SPA draws from it and MCP `get_repo_dashboard`
// returns it, so the same facts always draw the same screen on both. Nothing is chosen at view time.

import type { RepoTab } from "./repo";

export type LayoutRule = "found" | "unseen" | "release" | "production" | "chain" | "envCards" | "appsTable";

export interface LayoutRuleInfo { id: string; name: string; opener: string; when: string }

export const RULES: Record<LayoutRule, LayoutRuleInfo> = {
  found: { id: "R1", name: "Found apps", opener: "Found-apps card, then today’s pull requests, CI and figures", when: "No app accepted yet, and the scan found at least one" },
  unseen: { id: "R2", name: "Nothing recognised", opener: "“Trov does not see deploys” card with what it does see, then pull requests, CI and figures", when: "No app accepted, and the scan found nothing" },
  release: { id: "R3", name: "Release block", opener: "Latest release, what has merged since, release cadence", when: "Apps exist, and none has a target (packages only)" },
  production: { id: "R4", name: "Production card", opener: "One Production card with its last 20 deploys, then the Previews list", when: "One app with a target, one named environment" },
  chain: { id: "R5", name: "Promotion chain", opener: "Environment cards in promotion order, one row each, with drift between each step", when: "One app with a target, two or more named environments" },
  envCards: { id: "R6", name: "Environment cards", opener: "Environment cards with a row per app, and drift when environments ship from different branches", when: "2 or 3 apps with targets, all in the same environments" },
  appsTable: { id: "R7", name: "Apps table", opener: "A row per app; columns Production, then Previews (or the other environment), then Not shipped", when: "4 or more apps with targets, or apps whose environments differ" },
};

/** What the rules read — the facts' apps, environments and targets (parts) by name, and what the scan found.
 *  `layoutInputOf` (shared/repo-facts-core.ts) projects `RepoFacts` onto it. */
export interface LayoutInput {
  apps?: readonly { name: string; kind: string }[];
  envs?: readonly { name: string }[];
  targets?: readonly { app: string; env: string }[];
  found?: { apps: readonly unknown[] } | null;
}

export function decide(s: LayoutInput): LayoutRule {
  const apps = s.apps || [];
  if (!apps.length) return (s.found && s.found.apps.length) ? "found" : "unseen";
  const dep = apps.filter((a) => a.kind !== "Package" && envsOf(s, a.name).length);
  if (!dep.length) return "release";
  const sets = dep.map((a) => envsOf(s, a.name).join("|"));
  const same = sets.every((x) => x === sets[0]);
  if (dep.length === 1) return envsOf(s, dep[0].name).length <= 1 ? "production" : "chain";
  if (dep.length <= 3 && same) return "envCards";
  return "appsTable";
}
const envsOf = (s: LayoutInput, app: string): string[] =>
  (s.envs || []).map((e) => e.name).filter((e) => (s.targets || []).some((t) => t.app === app && t.env === e));

export const TABS = (s: LayoutInput): [RepoTab, string][] => (decide(s) === "release"
  ? [["overview", "Overview"], ["code", "Code"], ["ci", "CI"], ["planning", "Planning"]]
  : [["overview", "Overview"], ["code", "Code"], ["ci", "CI & deploys"], ["usage", "Usage"], ["planning", "Planning"]]);

/** Group by: environment cards or the apps table, for a repository that could draw either. */
export type GroupBy = "env" | "app";
export const GROUP_BY: readonly GroupBy[] = ["env", "app"];
export const isGroupBy = (v: unknown): v is GroupBy => v === "env" || v === "app";

export interface RepoLayout {
  /** What the facts decide. */
  rule: LayoutRule;
  /** What is drawn: the rule, unless Group by overrides it. */
  opener: LayoutRule;
  /** Two or more deployed apps in two or more environments — the only case Group by is offered. */
  canGroup: boolean;
  /** The Group by the switch shows as pressed. */
  group: GroupBy;
  tabs: [RepoTab, string][];
}

/** The rule, the group-by override (`buildScreen` in the design, unchanged) and the tabs. `group` is the
 *  viewer's session choice, else the admin's default (`repo_settings.overview_group`), else none. */
export function layoutOf(s: LayoutInput, group?: GroupBy | null): RepoLayout {
  const rule = decide(s);
  const dep = (s.apps || []).filter((a) => a.kind !== "Package" && envsOf(s, a.name).length);
  const canGroup = dep.length >= 2 && (s.envs || []).length >= 2;
  let opener: LayoutRule = rule;
  if (canGroup && group === "app") opener = "appsTable";
  if (canGroup && group === "env") opener = "envCards";
  return { rule, opener, canGroup, group: opener === "appsTable" ? "app" : "env", tabs: TABS(s) };
}
