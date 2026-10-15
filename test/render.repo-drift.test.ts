/**
 * Repo › Overview — drift between environments (web/src/repo-drift.ts), from the design's scenarios as
 * `RepoFacts`: one strip for one step, the chain form for three or more environments, each step a disclosure
 * keyed `drift:<from>><to>` opened through `x.open`, its PR / direct-push groups and their commits.
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import { repoScenario, SCENARIO_KEYS, SCENARIO_VARIANTS, type ScenarioKey } from "../web/src/repo-sample";
import { driftBlock, driftKey } from "../web/src/repo-drift";
import { layoutOf } from "@shared/repo-layout-core";
import { layoutInputOf, narrowFacts, REPO_WIDE, type RepoFacts } from "@shared/repo-facts-core";
import type { OverviewCtx } from "../web/src/repo-overview-ctx";
import { attr } from "../web/src/ui";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const facts = (k: ScenarioKey, v = "", app: string | null = null): RepoFacts => repoScenario(k, v, { now: NOW, app });
const ctx = (f: RepoFacts, open: string[] = []): OverviewCtx =>
  ({ now: NOW, admin: false, sample: false, persons: [], layout: layoutOf(layoutInputOf(f)), open: new Set(open) });
const draw = (f: RepoFacts, open: string[] = []): string => driftBlock(f, ctx(f, open));
/** A key as it stands in an attribute (`>` escaped; the browser hands the act the key itself). */
const a = (key: string): string => attr(key);
const text = (h: string): string => h.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** What a step's disclosure holds (its panel). */
const stepPanel = (h: string, key: string): { open: string; body: string } => {
  const i = h.indexOf(`data-step="${a(key)}"`);
  expect(i, key).toBeGreaterThan(-1);
  const open = h.slice(i).match(/data-open="(\d)"/)![1];
  const next = h.indexOf("data-step=", i + 10);
  return { open, body: h.slice(i, next > -1 ? next : undefined) };
};

describe("driftBlock — one step", () => {
  it("A: “main is 9 commits ahead of production”, closed until its key is open", () => {
    const f = facts("A");
    const key = "drift:staging>production";
    expect(driftKey(f.drift[0])).toBe(key);
    const h = draw(f);
    expect(h).toContain('data-drift="single"');
    expect(text(h).startsWith("main is 9 commits ahead of production")).toBe(true);
    expect(h).toContain(`data-act="repoOpen" data-arg="${a(key)}" aria-expanded="false"`);
    expect(stepPanel(h, key).open).toBe("0");
    // The panel is always emitted (a stable structure for the morph); it is shown by data-open.
    expect(h).toContain("Tutor sessions resume from the last message");
  });

  it("A opened: each PR with who and when, its commits with their age; direct pushes as Pushed", () => {
    const h = draw(facts("A"), ["drift:staging>production"]);
    expect(h).toContain('aria-expanded="true"');
    const { open, body } = stepPanel(h, "drift:staging>production");
    expect(open).toBe("1");
    const t = text(body);
    expect(t).toContain("#214 Tutor sessions resume from the last message meilin · merged 5h ago");
    expect(t).toContain("3e9a1f2 Resume tutor session from last message id 5h");
    expect(t).toContain("#212 Quiz timer drifts when the tab is hidden dev-raj · merged 1d ago");
    expect(t).toContain("Pushed 2 commits pushed straight to main kenji-m , tom-h");
    expect(t).toContain("c2b94f0 docs: staging seed notes 2d");
    expect(t).not.toContain("merged into");
  });

  it("one commit is “1 commit”; commits behind are said too", () => {
    const f = structuredClone(facts("K"));
    f.drift[0].ahead = 1;
    expect(text(draw(f))).toContain("main is 1 commit ahead of production");
    f.drift[0].behind = 2;
    expect(text(draw(f))).toContain("main is 1 commit ahead, 2 behind of production");
  });

  it("H and K draw their one step; scenarios with no drift draw nothing", () => {
    expect(text(draw(facts("H")))).toContain("main is 3 commits ahead of production");
    expect(text(draw(facts("K")))).toContain("main is 3 commits ahead of production");
    for (const k of ["B", "C", "D", "E", "F", "G", "I", "L", "M"] as const) expect(draw(facts(k)), k).toBe("");
  });
});

describe("driftBlock — the chain (three or more environments)", () => {
  it("J: each branch, a button per step with how far ahead, nothing open until a step's key is", () => {
    const h = draw(facts("J"));
    expect(h).toContain('data-drift="chain"');
    expect(text(h).startsWith("develop 6 ahead main 14 ahead release")).toBe(true);
    expect(h).toContain(`data-arg="${a("drift:dev>staging")}" aria-expanded="false"`);
    expect(h).toContain(`data-arg="${a("drift:staging>production")}" aria-expanded="false"`);
    expect(h).toContain('aria-label="develop is 6 commits ahead of main"');
    expect(stepPanel(h, "drift:dev>staging").open).toBe("0");
    expect(stepPanel(h, "drift:staging>production").open).toBe("0");
  });

  it("J opened: the step says which it is, PRs say which branch they merged into, the rest of a step is counted", () => {
    const h = draw(facts("J"), ["drift:dev>staging", "drift:staging>production"]);
    expect(h).toContain('class="repo-driftstep is-open"');
    const one = stepPanel(h, "drift:dev>staging");
    expect(one.open).toBe("1");
    expect(text(one.body)).toContain("On develop , not yet on main");
    expect(text(one.body)).toContain("#305 Batch writes in the outbox relay dev-raj · merged into develop 18m ago");
    const two = text(stepPanel(h, "drift:staging>production").body);
    expect(two).toContain("On main , not yet on release");
    expect(two).toContain("#298 Tenant export endpoint meilin · merged into main 1d ago");
    // The design's "+ 6 PRs — 13 more commits": a group with no commits returned, only a count.
    expect(two).toContain("More 13 more commits since c90b5d2");
    expect(two).not.toContain("Pushed");
  });
});

describe("driftBlock — narrowing and copy", () => {
  it("drift is the repository's: it stays when the App menu narrows, and for Repo-wide only", () => {
    expect(text(draw(facts("A", "", "web")))).toContain("main is 9 commits ahead of production");
    expect(text(draw(narrowFacts(facts("A"), REPO_WIDE)))).toContain("main is 9 commits ahead of production");
  });

  it("a step with nothing listed says so rather than drawing an empty list", () => {
    const f = structuredClone(facts("K"));
    f.drift[0].groups = [];
    expect(text(draw(f, ["drift:staging>production"]))).toContain("3 commits on main; Trov has not listed them yet.");
  });

  it("every scenario: nothing undefined", () => {
    for (const k of SCENARIO_KEYS) for (const v of SCENARIO_VARIANTS[k]) {
      const f = facts(k, v);
      const h = draw(f, f.drift.map(driftKey));
      expect(h, `${k}/${v}`).not.toMatch(/undefined|NaN|\[object|null/);
    }
  });

  it("its CSS: the chain's step button, its radius in the corners block, no transition under reduced motion", () => {
    expect(css).toContain("/* ── repo-drift (web/src/repo-drift.ts)");
    expect(css).toContain("[data-cnpy-theme] .repo-driftstep { border-radius:calc(7px * var(--corner-scale)) !important; }");
    expect(css).toMatch(/\.repo-driftstep, \.repo-appsrow \{ transition:none !important; \}/);
  });
});
