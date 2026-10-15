/**
 * Repo › Overview — the environment cards (web/src/repo-env-cards.ts) and the environment verdict
 * (web/src/repo-verdict.ts), drawn from the design's scenarios as `RepoFacts` (web/src/repo-sample.ts) at a
 * fixed `now`: the right verdicts, shas, ages, reasons, the CI line from the head's checks, unknown drawn as
 * unknown, nothing "not connected" for a host the repository has, and the App menu's narrowing.
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import { repoScenario, SCENARIO_KEYS, SCENARIO_VARIANTS, type ScenarioKey } from "../web/src/repo-sample";
import { envCardsBlock, ciLine } from "../web/src/repo-env-cards";
import { envVerdict } from "../web/src/repo-verdict";
import { layoutOf } from "@shared/repo-layout-core";
import { layoutInputOf, narrowFacts, REPO_WIDE, type RepoFacts } from "@shared/repo-facts-core";
import type { OverviewCtx } from "../web/src/repo-overview-ctx";
import type { PersonSummary } from "../web/src/api";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const facts = (k: ScenarioKey, v = "", app: string | null = null): RepoFacts => repoScenario(k, v, { now: NOW, app });
const ctx = (f: RepoFacts, over: Partial<OverviewCtx> = {}): OverviewCtx =>
  ({ now: NOW, admin: false, sample: false, persons: [], layout: layoutOf(layoutInputOf(f)), open: new Set(), ...over });
const draw = (f: RepoFacts, over: Partial<OverviewCtx> = {}): string => envCardsBlock(f, ctx(f, over));
/** Visible words only: tags out, entities decoded, whitespace collapsed. */
const text = (h: string): string => h.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&middot;/g, "·").replace(/\s+/g, " ").trim();
/** One card's markup. */
const card = (h: string, env: string): string => {
  const a = h.indexOf(`data-env="${env}"`);
  expect(a, env).toBeGreaterThan(-1);
  const b = h.indexOf("</section>", a);
  return h.slice(a, b);
};
/** One row's markup. */
const row = (h: string, part: string): string => {
  const a = h.indexOf(`data-part="${part}"`);
  expect(a, part).toBeGreaterThan(-1);
  const b = h.indexOf('class="repo-envrow"', a + 10);
  const c = h.indexOf("</section>", a);
  return h.slice(a, b > -1 && b < c ? b : c);
};
/** The verdict word at the top right of a card. */
const verdictOf = (h: string, env: string): string => {
  const c = card(h, env);
  const a = c.indexOf("data-verdict=");
  return text(c.slice(c.indexOf(">", a) + 1, c.indexOf('class="repo-envrow"') > -1 ? c.indexOf('class="repo-envrow"') : undefined).split("</span></span>")[0]);
};

describe("envVerdict — the design's verdictFor, from the facts", () => {
  it("down > failing > out of step > degraded > healthy; every part unknown → unknown", () => {
    expect(envVerdict(facts("A"), "staging")).toBe("healthy");
    expect(envVerdict(facts("A"), "production")).toBe("healthy");
    expect(envVerdict(facts("A", "outOfStep"), "production")).toBe("outOfStep");
    expect(envVerdict(facts("A", "trouble"), "production")).toBe("down");
    // A stale reading is neither up nor down, and a build in flight is not a failure.
    expect(envVerdict(facts("A", "trouble"), "staging")).toBe("healthy");
    expect(envVerdict(facts("B", "failed"), "production")).toBe("failing");
    expect(envVerdict(facts("B", "trouble"), "production")).toBe("healthy");
    expect(envVerdict(facts("E"), "production")).toBe("failing");
    expect(envVerdict(facts("J"), "dev")).toBe("degraded");
    expect(envVerdict(facts("J"), "staging")).toBe("healthy");
    expect(envVerdict(facts("G"), "production")).toBe("unknown");
    expect(envVerdict(facts("G"), "staging")).toBe("unknown");
    expect(envVerdict(facts("G", "signals"), "staging")).toBe("healthy");
  });

  it("down wins over a failed deploy in the same environment", () => {
    const f = structuredClone(facts("A", "trouble"));
    const api = f.parts.find((p) => p.app === "api" && p.env === "production")!;
    api.latest = { ...api.serving!, id: "x", state: "error", sha: "deadbee", readyAt: null };
    expect(envVerdict(f, "production")).toBe("down");
  });
});

describe("ciLine — the head's checks in words", () => {
  it("passing, failing, running (a running set has no total: the first running check's name)", () => {
    expect(ciLine({ env: "s", sha: "3e9a1f2", state: "pass", total: 14, failing: 0, names: [] })?.text).toBe("All 14 checks passing on 3e9a1f2");
    expect(ciLine({ env: "s", sha: "e07b3a2", state: "fail", total: 9, failing: 2, names: [] })?.text).toBe("2 of 9 checks failing on e07b3a2");
    expect(ciLine({ env: "s", sha: "f19ad20", state: "running", total: null, failing: null, names: [] })?.text).toBe("Checks running on f19ad20");
    expect(ciLine({ env: "s", sha: "4e1a9c7", state: "running", total: null, failing: null, names: ["deploy-normalizer.yml"] })?.text).toBe("deploy-normalizer.yml running on 4e1a9c7");
    // Unknown counts are never drawn as 0.
    expect(ciLine({ env: "s", sha: "abc1234", state: "fail", total: null, failing: null, names: [] })?.text).toBe("Checks failing on abc1234");
    expect(ciLine({ env: "s", sha: null, state: "pass", total: null, failing: null, names: [] })?.text).toBe("Checks passing");
    expect(ciLine({ env: "s", sha: "abc1234", state: null, total: null, failing: null, names: [] })).toBeNull();
    expect(ciLine(undefined)).toBeNull();
  });
});

describe("envCardsBlock — the cards", () => {
  it("A: a card per environment in promotion order, a row per app in the apps' order, shas, ages, who, host, URL, ms and CI", () => {
    const h = draw(facts("A"));
    expect([...h.matchAll(/data-env="([^"]+)"/g)].map((m) => m[1])).toEqual(["staging", "production"]);
    expect([...card(h, "staging").matchAll(/data-part="([^"]+)"/g)].map((m) => m[1])).toEqual(["web/staging", "api/staging"]);
    expect(text(card(h, "staging"))).toContain("Staging from main");
    expect(text(row(h, "web/staging"))).toContain("3e9a1f2 26m ago · by dev-raj · Cloudflare Workers staging.tutor.acme.com ↗ 142 ms");
    expect(text(row(h, "api/production"))).toContain("b4c21de 2h ago · by jose-a · Railway api.tutor.acme.com ↗ 94 ms");
    expect(text(card(h, "staging"))).toContain("CI on head ✓ All 14 checks passing on 3e9a1f2");
    expect(verdictOf(h, "staging")).toBe("Healthy");
    expect(verdictOf(h, "production")).toBe("Healthy");
    expect(h).toContain('href="https://tutor.acme.com"');
    expect(h).toContain('target="_blank" rel="noopener"');
    // Two environments get the wider card.
    expect(h).toContain("--card-min:340px");
  });

  it("A out of step: the flag on the app that is behind, and the verdict", () => {
    const h = draw(facts("A", "outOfStep"));
    expect(verdictOf(h, "production")).toBe("Out of step");
    expect(text(row(h, "api/production"))).toContain("71f0e3a 2d ago · by meilin · Railway 3 commits behind web");
    expect(text(row(h, "web/production"))).not.toContain("behind");
  });

  it("A trouble: down says for how long, a build says what serves meanwhile, a stale reading says how old it is", () => {
    const h = draw(facts("A", "trouble"));
    expect(verdictOf(h, "production")).toBe("Down");
    const web = text(row(h, "web/production"));
    expect(web).toContain("No answer from tutor.acme.com for 6m");
    expect(web).toContain("Down");
    expect(web).not.toMatch(/\d+ ms/);
    const api = text(row(h, "api/staging"));
    expect(api).toContain("3e9a1f2 2m ago · by dev-raj · Railway Building d94ea08 is serving until it finishes.");
    expect(api).toContain("Reading 34m old");
    expect(row(h, "api/staging")).toContain("repo-kit-pulse");
  });

  it("B failed: the failed sha, its age and reason, and the commit still serving; the failing CI line", () => {
    const h = draw(facts("B", "failed"));
    expect(verdictOf(h, "production")).toBe("Failing");
    expect(text(row(h, "trov/production"))).toContain("c41e7d9 1d ago · by andres · Cloudflare Workers e07b3a2 failed 12m ago · Build failed in Workers Builds: tsc found 2 errors. c41e7d9 is still serving.");
    expect(text(card(h, "production"))).toContain("CI on head ✕ 2 of 9 checks failing on e07b3a2");
  });

  it("B trouble: the rollback line beside the build in flight; a running check set has no total", () => {
    const h = draw(facts("B", "trouble"));
    const r = text(row(h, "trov/production"));
    expect(r).toContain("f19ad20 2m ago · by andres · Cloudflare Workers Building c41e7d9 is serving until it finishes.");
    expect(r).toContain("Rolled back from e07b3a2 by andres 8m ago.");
    expect(text(card(h, "production"))).toContain("Checks running on f19ad20");
    expect(card(h, "production")).toContain('class="repo-gdot"');
  });

  it("H: a workflow-deployed app says its host via the workflow; the running check is named", () => {
    const h = draw(facts("H"));
    expect(text(row(h, "collector/staging"))).toContain("4e1a9c7 1h ago · by kenji-m · Fly.io via deploy-collector.yml");
    expect(text(row(h, "normalizer/staging"))).toContain("Building 0b72d3e is serving until it finishes.");
    expect(text(card(h, "staging"))).toContain("deploy-normalizer.yml running on 4e1a9c7");
  });

  it("G with Railway not connected: every row Unknown and says why; no sha, no 0, no “not connected”", () => {
    const h = draw(facts("G"));
    expect(verdictOf(h, "production")).toBe("Unknown");
    expect(verdictOf(h, "staging")).toBe("Unknown");
    expect(h.match(/Railway does not report deploys to GitHub/g)).toHaveLength(8);
    expect(h).not.toContain("font-family:var(--label);font-size:12.5px;color:var(--fg);background:var(--hover)");
    expect(text(h)).not.toMatch(/\b0 ms\b|ago/);
    expect(text(h)).not.toMatch(/not connected/i);
  });

  it("G with GitHub signals: deploys read via GitHub; a build with nothing serving says nothing it does not know", () => {
    const h = draw(facts("G", "signals"));
    expect(text(row(h, "gateway/production"))).toContain("6d0b3f9 1d ago · by sanaok · Railway via GitHub");
    const ledger = text(row(h, "ledger/staging"));
    expect(ledger).toContain("a24e81c 3h ago · by dev-raj · Railway via GitHub Building");
    expect(ledger).not.toContain("serving");
    expect(text(draw(facts("G", "after")))).not.toContain("via GitHub");
  });

  it("J: three environments in promotion order get the narrower card; Dev is degraded by its failing check", () => {
    const h = draw(facts("J"));
    expect([...h.matchAll(/data-env="([^"]+)"/g)].map((m) => m[1])).toEqual(["dev", "staging", "production"]);
    expect(h).toContain("--card-min:300px");
    expect(verdictOf(h, "dev")).toBe("Degraded");
    expect(text(card(h, "dev"))).toContain("CI on head ✕ 1 of 11 checks failing on 7aa3c90");
  });

  it("every scenario: nothing undefined, never “not connected” for a host it has, unknown never drawn as 0", () => {
    for (const k of SCENARIO_KEYS) for (const v of SCENARIO_VARIANTS[k]) {
      const h = draw(facts(k, v));
      expect(h, `${k}/${v}`).not.toMatch(/undefined|NaN|\[object|null/);
      expect(text(h), `${k}/${v}`).not.toMatch(/not connected/i);
      expect(text(h), `${k}/${v}`).not.toMatch(/\b0 ms\b|\b0 of\b/);
      if (!facts(k, v).envs.length) expect(h, `${k}/${v}`).toBe("");
    }
  });

  it("narrowed by the App menu: only that app's rows; Repo-wide only draws no card", () => {
    const h = draw(facts("A", "", "api"));
    expect([...h.matchAll(/data-part="([^"]+)"/g)].map((m) => m[1])).toEqual(["api/staging", "api/production"]);
    expect(envCardsBlock(narrowFacts(facts("A"), REPO_WIDE), ctx(facts("A")))).toBe("");
    const e = draw(facts("E", "", "jobs"));
    expect([...e.matchAll(/data-part="([^"]+)"/g)].map((m) => m[1])).toEqual(["jobs/production"]);
    expect(verdictOf(e, "production")).toBe("Healthy");
  });

  it("sample mode links nowhere; a person in the org is the button to their card, never in sample mode", () => {
    const f = facts("A");
    expect(draw(f, { sample: true })).not.toContain("<a ");
    const persons = [{ handle: "dev-raj", name: "Dev Raj", color: "plum", avatar_url: null }] as unknown as PersonSummary[];
    expect(draw(f, { persons })).toContain('data-act="openPerson" data-arg="dev-raj"');
    expect(draw(f, { persons, sample: true })).not.toContain('data-act="openPerson"');
  });

  it("its CSS: a section in trov.css, the building pulse still under reduced motion", () => {
    expect(css).toContain("/* ── repo-env-cards (web/src/repo-env-cards.ts)");
    expect(css).toContain("/* ── repo-block-kit (web/src/repo-block-kit.ts)");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.repo-kit-pulse svg \{ animation:none !important; \}/);
  });
});
