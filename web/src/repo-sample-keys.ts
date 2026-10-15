// The Repo Overview's sample scenarios by NAME — keys, titles and variants, no fixture data. The fixtures themselves
// are web/src/repo-sample.ts (loaded on demand, never in the main bundle), which re-exports these unchanged; the
// sample switch (repo.ts, the preview bar's Scenario and Variant dropdowns) reads them from here, the way
// hosting-keys.ts serves the Hosting preview's Flow × Stack switch.

export const SCENARIO_KEYS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"] as const;
export type ScenarioKey = (typeof SCENARIO_KEYS)[number];
export const isScenarioKey = (v: unknown): v is ScenarioKey => typeof v === "string" && (SCENARIO_KEYS as readonly string[]).includes(v);

/** The design's `SCENARIO_TITLES`, unchanged. */
export const SCENARIO_TITLES: Record<ScenarioKey, string> = {
  A: "Frontend and backend", B: "One Worker, main to production", C: "Static site with previews", D: "Full-stack on one host",
  E: "Turborepo, five apps", F: "Large monorepo, 14 apps", G: "Backend services only", H: "Containers by GitHub Actions",
  I: "Package with releases only", J: "Promotion chain", K: "One product, two repos", L: "Just connected", M: "Nothing recognised",
  N: "Trouble states",
};

/** The variants per scenario ('' = calm), for the switcher. The design's, plus G `signals`: GitHub signals exist,
 *  so the services' deploys arrive "via GitHub" and the card asks to connect Railway for CPU and memory only. */
export const SCENARIO_VARIANTS: Record<ScenarioKey, readonly string[]> = {
  A: ["", "outOfStep", "trouble"], B: ["", "failed", "trouble"], C: [""], D: [""], E: [""], F: [""], G: ["", "signals", "after"],
  H: [""], I: [""], J: [""], K: [""], L: [""], M: [""], N: ["", "trov"],
};

/** Every scenario with its title and variants, for the Overview's sample switch. */
export const REPO_SCENARIOS: Record<ScenarioKey, { title: string; variants: readonly string[] }> =
  Object.fromEntries(SCENARIO_KEYS.map((k) => [k, { title: SCENARIO_TITLES[k], variants: SCENARIO_VARIANTS[k] }])) as Record<ScenarioKey, { title: string; variants: readonly string[] }>;

/** A variant's name in the switch ('' is the calm one). */
export const VARIANT_LABEL: Record<string, string> = {
  "": "Calm", outOfStep: "Out of step", trouble: "Trouble", failed: "Failed deploy", signals: "Deploys via GitHub",
  after: "Host connected",
};
/** N is the trouble states of A ('') and B (`trov`), so its variants are named by the scenario they show. */
export const variantLabel = (key: ScenarioKey, v: string): string =>
  key === "N" ? (v === "trov" ? "One Worker (B)" : "Frontend and backend (A)") : VARIANT_LABEL[v] ?? v;
