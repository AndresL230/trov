/**
 * Repo › Overview, rule R4 — the Production card (web/src/repo-production.ts), drawn from the design's
 * scenarios as RepoFacts (web/src/repo-sample.ts) at a fixed `now`: the verdict, what is serving, the failed or
 * in-flight deploy, CI on the head, the last-20 strip and its sentence — and unknown drawn as unknown.
 */
import { describe, it, expect } from "vitest";
import { productionBlock, ciLine, stripText, stripOf } from "../web/src/repo-production";
import { envVerdict } from "../web/src/repo-verdict";
import { repoScenario, REPO_SCENARIOS, SCENARIO_KEYS, type ScenarioKey } from "../web/src/repo-sample";
import type { OverviewCtx } from "../web/src/repo-overview-ctx";
import type { PersonSummary } from "../web/src/api";
import { layoutInputOf, type RepoFacts, type FactsPart } from "@shared/repo-facts-core";
import { layoutOf } from "@shared/repo-layout-core";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const sc = (k: ScenarioKey, v = "", app: string | null = null): RepoFacts => repoScenario(k, v, { now: NOW, app });
const ctx = (f: RepoFacts, o: Partial<OverviewCtx> = {}): OverviewCtx =>
  ({ now: NOW, admin: false, sample: true, persons: [], layout: layoutOf(layoutInputOf(f)), open: new Set(), ...o });
const draw = (f: RepoFacts, o: Partial<OverviewCtx> = {}): string => productionBlock(f, ctx(f, o));
/** The text a reader sees: tags out, whitespace collapsed. */
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const withPart = (f: RepoFacts, patch: (p: FactsPart) => FactsPart): RepoFacts => ({ ...f, parts: f.parts.map(patch) });

describe("the Production card — scenario B (one Worker, main to production)", () => {
  it("calm: Healthy, c41e7d9 serving 41m ago by andres on Cloudflare Workers, the URL and its health, all checks passing", () => {
    const f = sc("B");
    expect(ctx(f).layout.opener).toBe("production");
    const t = text(draw(f));
    expect(t).toContain("Production from main · trov · Worker on Cloudflare Workers");
    expect(t).toContain("Healthy");
    expect(t).toMatch(/c41e7d9 41m ago · by andres · Cloudflare Workers/);
    expect(t).toContain("trov.dev 96 ms");
    expect(t).toContain("All 9 checks passing on c41e7d9");
    expect(t).toContain("Last 20 deploys · 19 live, 1 failed");
    expect(t).not.toContain("Last deploy ");
    expect(t).not.toContain("Next");
    expect((draw(f).match(/class="repo-prod-sq/g) ?? []).length).toBe(20);
  });

  it("failed: Failing, the failed block names the sha, its age, who, the reason, and what is still serving", () => {
    const f = sc("B", "failed");
    const html = draw(f);
    const t = text(html);
    expect(t).toContain("Failing");
    expect(t).toContain("e07b3a2 failed 12m ago");
    expect(t).toContain("by andres");
    expect(text(html.slice(html.indexOf("data-failed-why")))).toMatch(/^data-failed-why[^>]*> ?Build failed in Workers Builds: tsc found 2 errors\. c41e7d9 is still serving\./);
    expect(t).toContain("2 of 9 checks failing on e07b3a2");
    expect(t).toContain("Last 20 deploys · 18 live, 2 failed");
    // The serving row's line gives way to the failed block (the design's showLine).
    expect(t).not.toContain("is serving until it finishes");
  });

  it("trouble (and N trov): rolled back to c41e7d9, f19ad20 building next, checks running with no count", () => {
    for (const f of [sc("B", "trouble"), sc("N", "trov")]) {
      const html = draw(f);
      const t = text(html);
      expect(t).toContain("Rolled back");
      expect(t).toContain("Rolled back from e07b3a2 by andres 8m ago.");
      expect(t).toMatch(/Next f19ad20 Building started 2m ago/);
      expect(t).toContain("Checks running on f19ad20");
      expect(t).not.toMatch(/All \d+ checks/);
      expect(t).toContain("Last 20 deploys · 17 live, 1 failed, 1 rolled back, 1 building");
      expect(html).toContain('class="repo-prod-sq is-building is-last"');
      expect(html).toContain('class="repo-kit-pulse"');
      expect(t).toContain("Live"); // checks still running: Live — Healthy needs passing checks (master ruling)
    }
  });

  it("the strip is newest on the right: the last square is the in-flight deploy, ringed", () => {
    const f = sc("B", "trouble");
    const ds = stripOf(f.parts[0]);
    expect(ds).toHaveLength(20);
    expect(ds[19].sha).toBe("f19ad20");
    expect(ds[18].rolledBackFrom).toBe("e07b3a2");
    expect(stripText(ds)).toBe("Last 20 deploys · 17 live, 1 failed, 1 rolled back, 1 building");
  });
});

describe("the Production card — the other one-app, one-environment repositories", () => {
  it("C (Netlify) and D (Vercel) draw their own sha, host and checks", () => {
    expect(text(draw(sc("C")))).toMatch(/5f2c0e8 3h ago · by ana-r · Netlify.*acme\.com 48 ms.*All 4 checks passing on 5f2c0e8/);
    expect(text(draw(sc("D")))).toMatch(/8b31f6d 1h ago · by priya-k · Vercel.*dashboard\.acme\.com 211 ms.*All 6 checks passing on 8b31f6d/);
    expect(text(draw(sc("D")))).toContain("Last 20 deploys · 18 live, 2 failed");
  });

  it("narrowed by the App menu: E's api is one app in one environment — its failed deploy and reason", () => {
    const f = sc("E", "", "api");
    expect(ctx(f).layout.opener).toBe("production");
    const t = text(draw(f));
    expect(t).toContain("Production from main · api · Service on Render");
    expect(t).toContain("Failing");
    expect(t).toContain("7f3a9d0 failed 25m ago");
    expect(t).toContain("Render: build exited with status 1. 2b8e6c4 is still serving.");
    // E captures no checks for Production: unknown, never "All N passing".
    expect(t).toContain("No checks captured on the branch head yet");
    expect(t).not.toMatch(/checks passing/);
  });

  it("narrowed to F's admin: a deploy in flight is the Next row, and the serving one says it serves until it finishes", () => {
    const t = text(draw(sc("F", "", "admin")));
    expect(t).toMatch(/Next 7c19e5a Building started 3m ago/);
    expect(t).toContain("2d91c08 is serving until it finishes.");
  });

  it("narrowed to E's jobs: deploys via its workflow, no URL known — and never \"not connected\"", () => {
    const t = text(draw(sc("E", "", "jobs")));
    expect(t).toContain("Job on Fly.io via deploy-jobs.yml");
    expect(t).toContain("No public URL known");
    expect(t).not.toMatch(/not connected/i);
  });

  it("draws nothing where there is no deployed app (I: a package; L / M: no app)", () => {
    for (const k of ["I", "L", "M"] as const) expect(draw(sc(k))).toBe("");
  });

  it("never says \"not connected\" in any scenario, variant or narrowing that opens on the Production card", () => {
    let seen = 0;
    for (const k of SCENARIO_KEYS) for (const v of REPO_SCENARIOS[k].variants) {
      const full = sc(k, v);
      for (const app of [null, ...full.allApps.map((a) => a.key)]) {
        const f = sc(k, v, app);
        if (ctx(f).layout.opener !== "production") continue;
        seen++;
        expect(text(draw(f)), `${k}/${v}/${app}`).not.toMatch(/not connected/i);
        expect(draw(f), `${k}/${v}/${app}`).not.toContain("<a ");
      }
    }
    expect(seen).toBeGreaterThan(10);
  });
});

describe("the Production card — unknown is drawn as unknown", () => {
  it("a part with no deploy at all: Unknown, why, and no strip — never a zero", () => {
    const f = withPart(sc("B"), (p) => ({ ...p, serving: null, latest: null, history: [], connection: "not_connected", viaGithub: false, health: null }));
    const t = text(draw(f));
    expect(envVerdict(f, "production").word).toBe("Unknown");
    expect(t).toContain("Unknown");
    expect(t).toContain("Cloudflare Workers does not report deploys to GitHub");
    expect(t).toContain("No deploy seen yet.");
    expect(t).not.toMatch(/\b0 live\b/);
  });

  it("a connected host that has reported nothing yet says so (no \"does not report\")", () => {
    const f = withPart(sc("B"), (p) => ({ ...p, serving: null, latest: null, history: [] }));
    expect(text(draw(f))).toMatch(/Unknown No deploy seen yet\./);
  });

  it("a deploy with no sha reads \"no commit\", never a made-up one", () => {
    const f = withPart(sc("C"), (p) => ({ ...p, serving: { ...p.serving!, sha: null, shaSource: null } }));
    expect(text(draw(f))).toMatch(/Serving no commit 3h ago/);
  });

  it("a stale health reading shows its age and no figure; a down one shows Down and no answer", () => {
    const stale = withPart(sc("B"), (p) => ({ ...p, health: { ...p.health!, stale: true, at: new Date(NOW - 34 * 60_000).toISOString() } }));
    const ts = text(draw(stale));
    expect(ts).toContain("Reading 34m old");
    expect(ts).not.toContain("96 ms");
    const down = withPart(sc("B"), (p) => ({ ...p, health: { ...p.health!, up: false, ms: null } }));
    const td = text(draw(down));
    expect(td).toContain("Down");
    expect(td).toContain("No answer from trov.dev.");
    expect(envVerdict(down, "production").word).toBe("Down");
  });

  it("CI words: no count is printed when none is known", () => {
    expect(ciLine(undefined).text).toBe("No checks captured on the branch head yet");
    expect(ciLine({ env: "x", sha: "abcdef1234", state: "fail", total: null, failing: null, names: [] }).text).toBe("Checks failing on abcdef1");
    expect(ciLine({ env: "x", sha: "abcdef1", state: "running", total: null, failing: null, names: ["deploy-normalizer.yml"] }).text).toBe("deploy-normalizer.yml running on abcdef1");
    expect(ciLine({ env: "x", sha: "abcdef1", state: "pass", total: 1, failing: 0, names: [] }).text).toBe("1 check passing on abcdef1");
  });
});

describe("the Production card — links and people", () => {
  it("sample mode links out to nothing; live data links the https URL and the build log", () => {
    const f = withPart(sc("B", "failed"), (p) => ({ ...p, latest: { ...p.latest!, logUrl: "https://dash.cloudflare.com/build/1" } }));
    expect(draw(f)).not.toContain("<a ");
    const live = draw(f, { sample: false });
    expect(live).toContain('<a href="https://trov.dev" target="_blank" rel="noopener"');
    expect(live).toContain('<a href="https://dash.cloudflare.com/build/1"');
    // never a javascript: or plain-http URL
    const bad = draw(withPart(f, (p) => ({ ...p, url: "javascript:alert(1)", health: null, latest: { ...p.latest!, logUrl: "http://x.test" } })), { sample: false });
    expect(bad).not.toContain("javascript:");
    expect(bad).not.toContain('href="http://');
  });

  it("who deployed opens their person card on live data, and is plain text in sample mode", () => {
    const andres = { handle: "andres", name: "Andres Lopez", color: "moss", avatar_url: null } as unknown as PersonSummary;
    expect(draw(sc("B"), { sample: false, persons: [andres] })).toContain('data-act="openPerson" data-arg="andres"');
    expect(draw(sc("B"), { persons: [andres] })).not.toContain("openPerson");
  });
});
