/**
 * Repo › Overview — the apps table (web/src/repo-apps-table.ts), from the design's scenarios as `RepoFacts`:
 * a row per non-Package app sorted worst first (failed, building, waiting, unknown, live), the production
 * column, Previews or the other environment, Not shipped — "Unknown" for an unknown count, never "Up to date" —
 * then the packages.
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import { repoScenario, SCENARIO_KEYS, SCENARIO_VARIANTS, type ScenarioKey } from "../web/src/repo-sample";
import { appsTableBlock, productionEnv } from "../web/src/repo-apps-table";
import { layoutOf } from "@shared/repo-layout-core";
import { layoutInputOf, type RepoFacts } from "@shared/repo-facts-core";
import type { OverviewCtx } from "../web/src/repo-overview-ctx";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const facts = (k: ScenarioKey, v = "", app: string | null = null): RepoFacts => repoScenario(k, v, { now: NOW, app });
const ctx = (f: RepoFacts): OverviewCtx => ({ now: NOW, admin: false, sample: false, persons: [], layout: layoutOf(layoutInputOf(f), "app"), open: new Set() });
const draw = (f: RepoFacts): string => appsTableBlock(f, ctx(f));
const text = (h: string): string => h.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const order = (h: string): string[] => [...h.matchAll(/class="repo-appsrow[^"]*" data-app="([^"]+)" data-rank="(\d)"/g)].map((m) => `${m[1]}:${m[2]}`);
/** One app's row (or package row). */
const row = (h: string, app: string): string => {
  const a = h.indexOf(`data-app="${app}"`);
  expect(a, app).toBeGreaterThan(-1);
  const b = h.indexOf('role="row"', a);
  return h.slice(a, b > -1 ? b : undefined);
};
const head = (h: string): string => { const a = h.indexOf(">", h.indexOf("repo-appshead")) + 1; return text(h.slice(a, h.indexOf("</div>", a))); };

describe("appsTableBlock — E, a Turborepo with five apps", () => {
  const h = draw(facts("E"));

  it("worst first: the failed deploy, then the app with commits waiting, then the live ones in the apps' order", () => {
    expect(order(h)).toEqual(["api:0", "web:2", "docs:4", "jobs:4"]);
    expect(head(h)).toBe("App Production Previews Not shipped");
  });

  it("the production column: the failed sha and its age, what still serves; else the serving sha, age and URL or workflow", () => {
    expect(text(row(h, "api"))).toContain("api apps/api Service · Render 2b8e6c4 3d ago 7f3a9d0 failed 25m ago 2b8e6c4 still serving");
    expect(h).toContain('class="repo-appsrow is-failed" data-app="api"');
    expect(text(row(h, "web"))).toContain("web apps/web Site · Vercel 9c4e2b1 2d ago storefront.acme.com");
    expect(text(row(h, "jobs"))).toContain("jobs apps/jobs Job · Fly.io via deploy-jobs.yml e5b2f19 1d ago via deploy-jobs.yml");
  });

  it("Previews: how many are open and a shape each (up to four); an app with no preview target says so", () => {
    expect(text(row(h, "web"))).toContain("3 open");
    expect(row(h, "web").match(/aria-label="(Live|Building|Failed)"/g)).toEqual(['aria-label="Live"', 'aria-label="Live"', 'aria-label="Building"']);
    expect(text(row(h, "docs"))).toContain("1 open");
    expect(text(row(h, "jobs"))).toContain("No preview target");
  });

  it("Not shipped: commits and the oldest, or Up to date at 0", () => {
    expect(text(row(h, "web"))).toContain("4 commits oldest 2d");
    expect(text(row(h, "api"))).toContain("1 commit oldest 25m");
    expect(text(row(h, "docs"))).toContain("Up to date");
  });

  it("the packages: not deployed on their own, shipped inside the apps that use them", () => {
    expect(text(h)).toContain("Packages 1 no deploys; they ship inside the apps that use them");
    expect(text(row(h, "ui"))).toContain("ui packages/ui Not deployed on its own; ships inside web, docs.");
    expect(order(h)).not.toContain("ui:4");
  });
});

describe("appsTableBlock — the other scenarios", () => {
  it("F: both failures first, then the build in flight with what serves until it finishes; 12 rows and 2 packages", () => {
    const h = draw(facts("F"));
    const o = order(h);
    expect(o.slice(0, 3)).toEqual(["checkout:0", "search:0", "admin:1"]);
    expect(o).toHaveLength(12);
    expect(o.slice(3).every((r) => r.endsWith(":4"))).toBe(true);
    expect(text(row(h, "admin"))).toContain("7c19e5a 3m ago Building 2d91c08 serving until it finishes");
    expect(text(row(h, "search"))).toContain("No preview target 1 commit oldest 52m");
    expect(text(row(h, "tokens"))).toContain("ships inside web, admin, docs, status.");
  });

  it("G with Railway not connected: the other environment as the second column, every cell Unknown, never Up to date", () => {
    const h = draw(facts("G"));
    expect(head(h)).toBe("App Production Staging Not shipped");
    expect(order(h)).toEqual(["gateway:3", "ledger:3", "notifier:3", "settle:3"]);
    for (const app of ["gateway", "ledger", "notifier", "settle"]) {
      const t = text(row(h, app));
      expect(t.match(/Unknown/g), app).toHaveLength(3);
      expect(t).not.toContain("Up to date");
      expect(t).not.toMatch(/ago/);
    }
    expect(text(h)).not.toMatch(/not connected/i);
  });

  it("G after Railway connects: the other environment's sha and age, Building in flight; more than two commits waiting ranks as waiting", () => {
    const h = draw(facts("G", "after"));
    expect(order(h)).toEqual(["gateway:2", "ledger:2", "notifier:2", "settle:2"]);
    expect(text(row(h, "ledger"))).toContain("6d0b3f9 1d ago a24e81c 3h ago Building 3 commits oldest 3h");
    expect(text(row(h, "notifier"))).toContain("f13c9a7 6d ago a24e81c 3h ago 5 commits oldest 6d");
    expect(text(draw(facts("G", "signals")))).toContain("Service · Railway via GitHub");
  });

  it("A grouped by app: Production then Staging; no not-shipped entry is Unknown, never Up to date", () => {
    const h = draw(facts("A"));
    expect(head(h)).toBe("App Production Staging Not shipped");
    expect(order(h)).toEqual(["web:4", "api:4"]);
    expect(text(row(h, "api"))).toContain("api api Service · Railway b4c21de 2h ago api.tutor.acme.com 3e9a1f2 28m ago Unknown");
    expect(text(h)).not.toContain("Up to date");
  });

  it("an unknown count is Unknown; the production column is the environment called Production, else the last", () => {
    const f = structuredClone(facts("E"));
    f.notShipped.find((n) => n.app === "docs")!.count = null;
    expect(text(row(draw(f), "docs"))).toContain("Unknown");
    expect(text(row(draw(f), "docs"))).not.toContain("Up to date");
    expect(productionEnv(facts("J").envs)?.key).toBe("production");
    expect(productionEnv(facts("G").envs)?.key).toBe("production");
    expect(productionEnv([{ key: "dev", name: "Dev", branch: "develop", position: 0 }, { key: "live", name: "Live", branch: "main", position: 1 }])?.key).toBe("live");
    expect(productionEnv([])).toBeNull();
  });

  it("narrowed by the App menu: that app's row alone", () => {
    expect(order(draw(facts("E", "", "web")))).toEqual(["web:2"]);
    expect(order(draw(facts("F", "", "search")))).toEqual(["search:0"]);
  });

  it("every scenario: nothing undefined, never “not connected”", () => {
    for (const k of SCENARIO_KEYS) for (const v of SCENARIO_VARIANTS[k]) {
      const h = draw(facts(k, v));
      expect(h, `${k}/${v}`).not.toMatch(/undefined|NaN|\[object|null/);
      expect(text(h), `${k}/${v}`).not.toMatch(/not connected/i);
    }
  });

  it("its CSS: a section in trov.css; the table scrolls sideways inside its own box", () => {
    expect(css).toContain("/* ── repo-apps-table (web/src/repo-apps-table.ts)");
    expect(css).toContain(".repo-appstable-scroll { overflow-x:auto;");
    expect(css).toContain(".repo-appstable-in { min-width:820px; }");
  });
});
