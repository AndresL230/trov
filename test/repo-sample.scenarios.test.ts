// The design's scenarios A–N as `RepoFacts` (web/src/repo-sample.ts): every fixture, variant, App narrowing and
// Group by gets the same rule, opener and Group by from the shared layout core (`layoutOf(layoutInputOf(facts))`)
// as the design's own `buildScreen` (docs/superpowers/specs/repo-setups-design/repo-data.js) — and the fixtures
// keep the facts' own rules: unknown is null, never 0, and every part names an app and an environment it has.
import { describe, expect, it } from "vitest";
import { layoutInputOf, narrowFacts, REPO_WIDE, type RepoFacts } from "@shared/repo-facts-core";
import { layoutOf, type GroupBy } from "@shared/repo-layout-core";
import { repoScenario, REPO_SCENARIOS, SCENARIO_KEYS, SCENARIO_TITLES, SCENARIO_VARIANTS, type ScenarioKey } from "../web/src/repo-sample";
// @ts-expect-error — the design's module is plain JS with no declarations; it is read here as the reference.
import * as design from "../docs/superpowers/specs/repo-setups-design/repo-data.js";

interface DesignScreen {
  s: {
    apps: { name: string; kind: string }[]; envs: { name: string }[]; targets: { app: string; env: string }[];
    week?: [string, number | null, number | null, boolean?][]; notShippedByApp?: Record<string, [number | null, string?]>;
  };
  ruleKey: string; opener: string; canGroup: boolean; group: string;
}
const buildScreen = design.buildScreen as (o: Record<string, unknown>) => DesignScreen;

const NOW = Date.parse("2026-10-15T12:00:00Z");
const GROUPS: (GroupBy | undefined)[] = [undefined, "env", "app"];

// The design has no G `signals` variant (Trov's one copy change: GitHub signals exist, Railway is not connected),
// and its view model throws for G/after (a building deploy with no previous one — a slip in its sample data). Both
// have G's calm apps, environments and targets, so the design's G screen is their reference for the layout.
const designOf = (scenario: ScenarioKey, variant: string): [string, string] =>
  scenario === "G" && variant !== "" ? ["G", ""] : [scenario, variant];

const cases = SCENARIO_KEYS.flatMap((scenario) => SCENARIO_VARIANTS[scenario].flatMap((variant) => {
  const [ds, dv] = designOf(scenario, variant);
  const apps = buildScreen({ scenario: ds, variant: dv }).s.apps.map((a) => a.name);
  // REPO_WIDE is left out: the design draws the whole repository for it (its `narrow()` returns the scenario
  // unchanged); Trov draws no app rows — see "Repo-wide only" below.
  return [undefined, ...apps].flatMap((app) => GROUPS.map((group) => ({ scenario, variant, app, group, label: `${scenario}/${variant || "calm"} app=${app ?? "all"} group=${group ?? "-"}` })));
}));

const designWeekKey: Record<string, string> = {
  "Merged PRs": "mergedPrs", Deploys: "deploys", "Failed deploys": "failedDeploys", "Open PRs": "openPrs", Commits: "commits", Releases: "releases", "CI runs": "ciRuns",
};

describe("the sample scenarios draw the design's screens", () => {
  it("titles and variants are the design's (plus G signals)", () => {
    expect(SCENARIO_TITLES).toEqual(design.SCENARIO_TITLES);
    expect(Object.keys(REPO_SCENARIOS)).toEqual([...SCENARIO_KEYS]);
    for (const k of SCENARIO_KEYS) expect(REPO_SCENARIOS[k]).toEqual({ title: SCENARIO_TITLES[k], variants: SCENARIO_VARIANTS[k] });
    expect(SCENARIO_VARIANTS.G).toEqual(["", "signals", "after"]);
  });

  it.each(cases)("$label", ({ scenario, variant, app, group }) => {
    const [ds, dv] = designOf(scenario, variant);
    const v = buildScreen({ scenario: ds, variant: dv, app, group });
    const facts = repoScenario(scenario, variant, { now: NOW, app });
    const layout = layoutOf(layoutInputOf(facts), group);
    expect({ rule: layout.rule, opener: layout.opener, canGroup: layout.canGroup, group: layout.group })
      .toEqual({ rule: v.ruleKey, opener: v.opener, canGroup: v.canGroup, group: v.group });
    // the same apps, environments and targets the design's rules read
    expect(facts.apps.map((a) => [a.key, a.kind])).toEqual(v.s.apps.map((a) => [a.name, a.kind]));
    expect(facts.parts.map((p) => `${p.app}@${p.env}`).sort()).toEqual(v.s.targets.map((t) => `${t.app}@${t.env.toLowerCase()}`).sort());
    const designEnvs = v.s.envs.map((e) => e.name).filter((e) => v.s.targets.some((t) => t.env === e));
    expect(facts.envs.map((e) => e.name)).toEqual(designEnvs);
  });

  it("G/after (which the design's view model cannot draw) is still an apps table", () => {
    const f = repoScenario("G", "after", { now: NOW });
    expect(layoutOf(layoutInputOf(f)).rule).toBe("appsTable");
    expect(layoutOf(layoutInputOf(f), "env").opener).toBe("envCards");
    const ledger = f.parts.find((p) => p.app === "ledger" && p.env === "staging");
    expect(ledger?.latest?.state).toBe("building");
    expect(ledger?.serving).toBeNull();
  });
});

const everyFixture = (): { name: string; facts: RepoFacts; full: RepoFacts }[] => SCENARIO_KEYS.flatMap((k) => SCENARIO_VARIANTS[k].flatMap((v) => {
  const full = repoScenario(k, v, { now: NOW });
  return [null, ...full.allApps.map((a) => a.key), REPO_WIDE].map((app) => ({ name: `${k}/${v || "calm"} app=${app ?? "all"}`, facts: narrowFacts(full, app), full }));
}));

describe("the sample facts keep the facts' rules", () => {
  it("every week figure the design leaves unknown is null, never 0, and the rest are the design's", () => {
    for (const k of SCENARIO_KEYS) for (const v of SCENARIO_VARIANTS[k]) {
      if (k === "G" && v !== "") continue; // compared below
      const designWeek = buildScreen({ scenario: k, variant: v }).s.week ?? [];
      const facts = repoScenario(k, v, { now: NOW });
      expect(facts.week, `${k}/${v}`).toEqual(designWeek.map(([label, value, delta]) => ({ key: designWeekKey[label], value, delta })));
    }
    const calm = repoScenario("G", "", { now: NOW }).week;
    expect(calm.filter((w) => w.value === null).map((w) => w.key)).toEqual(["deploys", "failedDeploys"]);
    expect(calm.filter((w) => w.value === null).every((w) => w.delta === null)).toBe(true);
    for (const v of ["signals", "after"]) {
      expect(repoScenario("G", v, { now: NOW }).week.find((w) => w.key === "deploys")).toEqual({ key: "deploys", value: 14, delta: 2 });
    }
    expect(repoScenario("L", "", { now: NOW }).week.every((w) => w.delta === null && w.value !== null)).toBe(true);
  });

  it("an unknown not-shipped count is null, never 0 (G before anything reports)", () => {
    const g = repoScenario("G", "", { now: NOW });
    expect(g.notShipped.map((n) => n.count)).toEqual([null, null, null, null]);
    expect(g.notShipped.every((n) => n.oldestAt === null)).toBe(true);
    const designNs = buildScreen({ scenario: "E" }).s.notShippedByApp ?? {};
    expect(Object.fromEntries(repoScenario("E", "", { now: NOW }).notShipped.map((n) => [n.app, n.count]))).toEqual(Object.fromEntries(Object.entries(designNs).map(([a, [c]]) => [a, c])));
  });

  it("G before anything reports: parts with no deploys, not connected, and the connect card asks for deploys", () => {
    const g = repoScenario("G", "", { now: NOW });
    expect(g.parts).toHaveLength(8);
    for (const p of g.parts) {
      expect(p).toMatchObject({ serving: null, latest: null, history: [], reportsDeploys: true, connection: "not_connected", viaGithub: false });
    }
    expect(g.connect).toEqual({ provider: "railway", need: "deploys", apps: ["gateway", "ledger", "notifier", "settle"] });
    const s = repoScenario("G", "signals", { now: NOW });
    expect(s.connect).toEqual({ provider: "railway", need: "metrics", apps: ["gateway", "ledger", "notifier", "settle"] });
    expect(s.parts.every((p) => p.viaGithub && p.connection === "not_connected")).toBe(true);
    expect(s.parts.filter((p) => p.serving).every((p) => p.serving?.source === "github")).toBe(true);
    expect(repoScenario("G", "after", { now: NOW }).connect).toBeNull();
  });

  it("every part, attention item, preview and not-shipped row names an app and an environment the facts have", () => {
    for (const { name, facts } of everyFixture()) {
      const apps = new Set(facts.apps.map((a) => a.key)), envs = new Set(facts.envs.map((e) => e.key)), all = new Set(facts.allApps.map((a) => a.key));
      for (const p of facts.parts) {
        expect(apps.has(p.app), `${name}: part app ${p.app}`).toBe(true);
        expect(envs.has(p.env), `${name}: part env ${p.env}`).toBe(true);
      }
      for (const a of facts.attention) if (a.app !== null) expect(apps.has(a.app), `${name}: attention app ${a.app}`).toBe(true);
      for (const x of [...facts.previews, ...facts.notShipped, ...facts.outOfStep]) expect(apps.has(x.app), `${name}: ${x.app}`).toBe(true);
      for (const x of [...facts.notShipped, ...facts.outOfStep]) expect(envs.has(x.env), `${name}: env ${x.env}`).toBe(true);
      for (const a of facts.apps) expect(all.has(a.key)).toBe(true);
      // every environment drawn has a part of the apps in view
      for (const e of facts.envs) expect(facts.parts.some((p) => p.env === e.key), `${name}: env ${e.key} has no part`).toBe(true);
    }
  });

  it("deploys: serving is ready, latest is never the serving one, history is settled and oldest first", () => {
    for (const { name, facts } of everyFixture()) for (const p of facts.parts) {
      if (p.serving) expect(p.serving.state, name).toBe("ready");
      if (p.latest) expect(p.latest, name).not.toBe(p.serving);
      expect(p.history.length).toBeLessThanOrEqual(20);
      expect(p.history.every((d) => d.state === "ready" || d.state === "error" || d.state === "canceled"), name).toBe(true);
      const times = p.history.map((d) => Date.parse(d.createdAt));
      expect(times, name).toEqual([...times].sort((a, b) => a - b));
      for (const d of [p.serving, p.latest, ...p.history]) if (d) expect(Date.parse(d.createdAt)).toBeLessThanOrEqual(NOW);
    }
  });

  it("B, C and D carry their 20-deploy strips; B's failed, rolled-back and building deploys are the design's", () => {
    for (const k of ["B", "C", "D"] as const) expect(repoScenario(k, "", { now: NOW }).parts[0].history).toHaveLength(20);
    const failed = repoScenario("B", "failed", { now: NOW }).parts[0];
    expect(failed.serving?.sha).toBe("c41e7d9");
    expect(failed.latest).toMatchObject({ sha: "e07b3a2", state: "error", reason: "Build failed in Workers Builds: tsc found 2 errors" });
    const tr = repoScenario("B", "trouble", { now: NOW }).parts[0];
    expect(tr.serving).toMatchObject({ sha: "c41e7d9", rolledBackFrom: "e07b3a2" });
    expect(tr.latest).toMatchObject({ sha: "f19ad20", state: "building" });
    expect(tr.history).toHaveLength(19); // + the building one = the design's 20
    const p316 = repoScenario("B", "trouble", { now: NOW }).previews.find((p) => p.pr === 316);
    expect(p316).toMatchObject({ state: "error", failStreak: 4, failingSince: new Date(NOW - 3 * 86_400_000).toISOString() });
  });

  it("health: down is up=false, a stale reading is stale with its age", () => {
    const a = repoScenario("A", "trouble", { now: NOW });
    expect(a.parts.find((p) => p.app === "web" && p.env === "production")?.health).toMatchObject({ up: false, ms: null, stale: false });
    expect(a.parts.find((p) => p.app === "api" && p.env === "staging")?.health).toMatchObject({ stale: true, at: new Date(NOW - 34 * 60_000).toISOString() });
    expect(repoScenario("A", "outOfStep", { now: NOW }).outOfStep).toEqual([{ env: "production", app: "api", sha: "71f0e3a", of: "web", ofSha: "b4c21de", behindBy: 3 }]);
  });

  it("H's Cloud Run app is GitHub-deployment parts on its workflow; Fly.io's deploys come via GitHub", () => {
    const h = repoScenario("H", "", { now: NOW });
    const n = h.parts.filter((p) => p.app === "normalizer");
    expect(n.every((p) => (p.provider as string) === "github" && p.via === "deploy-normalizer.yml" && p.host === "GitHub deployments")).toBe(true);
    const c = h.parts.filter((p) => p.app === "collector");
    expect(c.every((p) => p.provider === "fly" && p.viaGithub && p.via === "deploy-collector.yml")).toBe(true);
  });
});

describe("narrowFacts: the App menu", () => {
  it("an app key keeps only that app's rows, all apps in the menu, and its environments", () => {
    const e = repoScenario("E", "", { now: NOW });
    const api = narrowFacts(e, "api");
    expect(api.app).toBe("api");
    expect(api.apps.map((a) => a.key)).toEqual(["api"]);
    expect(api.allApps).toEqual(e.allApps);
    expect(api.parts.every((p) => p.app === "api")).toBe(true);
    expect(api.previews.every((p) => p.app === "api") && api.previews.length === 1).toBe(true);
    expect(api.notShipped.map((n) => n.app)).toEqual(["api"]);
    expect(api.attention.map((a) => a.kind)).toEqual(["failed"]);
    expect(narrowFacts(e, "web").attention.map((a) => a.kind)).toEqual(["waiting"]);
    expect(narrowFacts(e, "ui")).toMatchObject({ apps: [{ key: "ui" }], parts: [], envs: [] });
    expect(narrowFacts(repoScenario("G", "", { now: NOW }), "ledger").connect).toEqual({ provider: "railway", need: "deploys", apps: ["ledger"] });
  });

  it("Repo-wide only: no app rows, the PR / CI-level facts stay, found and unseen null", () => {
    const j = repoScenario("J", "", { now: NOW });
    const r = narrowFacts(j, REPO_WIDE);
    expect(r).toMatchObject({ app: REPO_WIDE, apps: [], envs: [], parts: [], previews: [], notShipped: [], outOfStep: [], connect: null, found: null, unseen: null });
    expect(r.allApps).toEqual(j.allApps);
    expect(r.drift).toEqual(j.drift);
    expect(r.ci).toEqual(j.ci);
    expect(r.week).toEqual(j.week);
    expect(r.attention.map((a) => a.kind)).toEqual(["degraded"]); // the branch's CI item has no app
    expect(narrowFacts(repoScenario("I", "", { now: NOW }), REPO_WIDE).release).not.toBeNull();
  });

  it("null and an unknown key leave the facts as they are", () => {
    const a = repoScenario("A", "", { now: NOW });
    expect(narrowFacts(a, null)).toBe(a);
    expect(narrowFacts(a, "nope")).toBe(a);
  });
});
