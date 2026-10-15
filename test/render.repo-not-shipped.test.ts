/**
 * Repo › Overview — not shipped (web/src/repo-not-shipped.ts), from the design's scenarios as `RepoFacts`:
 * which entry the block draws (one deployed app → its production entry; several → the one with the most
 * commits waiting, when they are listed), "<app> is up to date in Production" at 0, nothing for an unknown
 * count, and its groups behind the header's disclosure (key `ns:<app>><env>`).
 */
import { describe, it, expect } from "vitest";
import { repoScenario, SCENARIO_KEYS, SCENARIO_VARIANTS, type ScenarioKey } from "../web/src/repo-sample";
import { notShippedBlock, notShippedEntry, notShippedKey } from "../web/src/repo-not-shipped";
import { layoutOf } from "@shared/repo-layout-core";
import { layoutInputOf, narrowFacts, REPO_WIDE, type RepoFacts } from "@shared/repo-facts-core";
import type { OverviewCtx } from "../web/src/repo-overview-ctx";
import { attr } from "../web/src/ui";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const facts = (k: ScenarioKey, v = "", app: string | null = null): RepoFacts => repoScenario(k, v, { now: NOW, app });
const ctx = (f: RepoFacts, open: string[] = []): OverviewCtx =>
  ({ now: NOW, admin: false, sample: false, persons: [], layout: layoutOf(layoutInputOf(f)), open: new Set(open) });
const draw = (f: RepoFacts, open: string[] = []): string => notShippedBlock(f, ctx(f, open));
const text = (h: string): string => h.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("notShippedEntry — which entry the block draws", () => {
  it("one deployed app: its production entry (B failed / trouble); none when it has none (B calm)", () => {
    expect(notShippedEntry(facts("B", "failed"))?.app).toBe("trov");
    expect(notShippedEntry(facts("B", "trouble"))?.count).toBe(2);
    expect(notShippedEntry(facts("B"))).toBeNull();
    for (const k of ["A", "C", "D", "H", "I", "J", "K", "L", "M"] as const) expect(notShippedEntry(facts(k)), k).toBeNull();
  });

  it("several apps: the most commits waiting, and only with its commits listed — E's web; none for F and G", () => {
    expect(notShippedEntry(facts("E"))?.app).toBe("web");
    expect(notShippedEntry(facts("F"))).toBeNull();
    expect(notShippedEntry(facts("G", "after"))).toBeNull();
    expect(notShippedEntry(facts("G", "signals"))).toBeNull();
  });

  it("an unknown count is never drawn (G before Railway is connected)", () => {
    expect(notShippedEntry(facts("G"))).toBeNull();
    expect(notShippedEntry(facts("G", "", "notifier"))).toBeNull();
  });

  it("narrowed to one app: that app's entry, whatever its count", () => {
    expect(notShippedEntry(facts("E", "", "docs"))?.count).toBe(0);
    expect(notShippedEntry(facts("E", "", "api"))?.count).toBe(1);
    expect(notShippedEntry(facts("G", "after", "notifier"))?.count).toBe(5);
    expect(notShippedEntry(narrowFacts(facts("E"), REPO_WIDE))).toBeNull();
  });
});

describe("notShippedBlock — the block", () => {
  it("B failed: what is waiting, how old, closed behind its header until its key is open", () => {
    const f = facts("B", "failed");
    const key = "ns:trov>production";
    expect(notShippedKey(f.notShipped[0])).toBe(key);
    const h = draw(f);
    expect(text(h).startsWith("Not shipped 1 commit on trov not in Production oldest 12m ago")).toBe(true);
    expect(h).toContain(`data-act="repoOpen" data-arg="${attr(key)}" aria-expanded="false"`);
    expect(h).toContain('data-open="0"');
    const open = draw(f, [key]);
    expect(open).toContain('data-open="1"');
    expect(text(open)).toContain("#320 Repo: read deploy signals per target andres · merged 14m ago e07b3a2 Read deploy signals per target 14m");
  });

  it("E: the web app's four commits, grouped by pull request and direct pushes", () => {
    const t = text(draw(facts("E"), ["ns:web>production"]));
    expect(t).toContain("4 commits on web not in Production oldest 2d ago");
    expect(t).toContain("#651 Checkout: saved addresses tom-h · merged 2d ago");
    expect(t).toContain("#648 web: lazy-load the product gallery ana-r · merged 2d ago");
    expect(t).toContain("Pushed 1 commit pushed straight to main dev-raj f4b7d21 fix: typo in the cart drawer 2d");
  });

  it("at 0: “docs is up to date in Production”; with a count but no commits listed: the count alone, no disclosure", () => {
    const docs = text(draw(facts("E", "", "docs")));
    expect(docs).toBe("Not shipped docs is up to date in Production Everything merged is deployed.");
    const api = draw(facts("E", "", "api"));
    expect(text(api)).toBe("Not shipped 1 commit on api not in Production oldest 25m ago");
    expect(api).not.toContain("data-act=");
  });

  it("nothing for an unknown count, no entry, or Repo-wide only — never “up to date” for an unknown", () => {
    expect(draw(facts("G"))).toBe("");
    expect(draw(facts("G", "", "gateway"))).toBe("");
    expect(draw(facts("B"))).toBe("");
    expect(draw(facts("F"))).toBe("");
    expect(draw(narrowFacts(facts("B", "failed"), REPO_WIDE))).toBe("");
  });

  it("every scenario: nothing undefined, never “up to date” where the count is not 0", () => {
    for (const k of SCENARIO_KEYS) for (const v of SCENARIO_VARIANTS[k]) {
      const f = facts(k, v);
      const h = draw(f, f.notShipped.map(notShippedKey));
      expect(h, `${k}/${v}`).not.toMatch(/undefined|NaN|\[object|null/);
      if (h.includes("up to date")) expect(notShippedEntry(f)?.count, `${k}/${v}`).toBe(0);
    }
  });
});
