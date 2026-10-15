/**
 * Repo › Overview, rule R3 — the release block (web/src/repo-release.ts), drawn from scenario I (a package with
 * releases only) at a fixed `now`: the latest tag, what merged since it, the waiting list (a feature only where
 * the facts say so), the cadence strip and the gaps sentence — all derived, none typed.
 */
import { describe, it, expect } from "vitest";
import { releaseBlock, gapsSentence, releaseGaps, featureLine, shortDate } from "../web/src/repo-release";
import { repoScenario, REPO_SCENARIOS, SCENARIO_KEYS, type ScenarioKey } from "../web/src/repo-sample";
import type { OverviewCtx } from "../web/src/repo-overview-ctx";
import { layoutInputOf, REPO_WIDE, type RepoFacts } from "@shared/repo-facts-core";
import { layoutOf } from "@shared/repo-layout-core";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const sc = (k: ScenarioKey, v = "", app: string | null = null): RepoFacts => repoScenario(k, v, { now: NOW, app });
const ctx = (f: RepoFacts, o: Partial<OverviewCtx> = {}): OverviewCtx =>
  ({ now: NOW, admin: false, sample: true, persons: [], layout: layoutOf(layoutInputOf(f)), open: new Set(), ...o });
const draw = (f: RepoFacts, o: Partial<OverviewCtx> = {}): string => releaseBlock(f, ctx(f, o));
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("the release block — scenario I", () => {
  const f = sc("I");

  it("opens on the release rule", () => { expect(ctx(f).layout.opener).toBe("release"); });

  it("the latest tag, its age in words, its date and who cut it, and its notes", () => {
    const t = text(draw(f));
    expect(t).toContain("Latest release");
    expect(t).toContain("v2.4.0 9 days ago · 6 Oct · by meilin");
    expect(t).toContain("Select gains async options and a loading state.");
  });

  it("what merged since: 18 commits and 5 pull requests, the two features by name, five merged rows", () => {
    const html = draw(f);
    const t = text(html);
    expect(t).toContain("Since v2.4.0 18 commits 5 pull requests");
    expect(t).toContain("Two features are waiting to ship: DatePicker range mode and Toast stacking and swipe to dismiss.");
    expect((html.match(/class="repo-rel-pr"/g) ?? []).length).toBe(5);
    expect((html.match(/aria-label="Merged"/g) ?? []).length).toBe(5);
    // "feature" only where the facts say feature: true (#231, #228).
    expect((t.match(/ · feature/g) ?? []).length).toBe(2);
    expect(t).toMatch(/feat: DatePicker range mode #231 · ana-r · feature merged 2d ago/);
    expect(t).toMatch(/fix: Menu keeps scroll position on reopen #230 · dev-raj merged 3d ago/);
  });

  it("the cadence strip: one tick per release positioned by age, the latest marked", () => {
    const html = draw(f);
    expect((html.match(/class="repo-rel-tick/g) ?? []).length).toBe(6);
    expect(html).toMatch(/class="repo-rel-tick is-last" data-tag="v2\.4\.0" style="position:absolute;top:0;left:91\.00%/);
    expect(html).toMatch(/data-tag="v2\.1\.0" style="position:absolute;top:0;left:9\.00%/);
    expect(text(html)).toContain("last 100 days");
  });

  it("the gaps sentence is derived from the cadence, newest first", () => {
    expect(releaseGaps(f.release!)).toEqual([14, 12, 21, 14, 21]);
    expect(text(draw(f))).toContain("v2.4.0 shipped 9 days ago. The gaps before it were 14, 12, 21, 14 and 21 days.");
  });

  it("never says \"not connected\", and links out to nothing in sample mode", () => {
    expect(text(draw(f))).not.toMatch(/not connected/i);
    expect(draw(f)).not.toContain("<a ");
    const live = draw(f, { sample: false });
    expect(live).toContain('<a href="https://github.com/acme/ui-kit/releases/tag/v2.4.0"');
    expect(live).toContain('<a href="https://github.com/acme/ui-kit/releases"');
  });
});

describe("the release block — unknown and edge cases", () => {
  it("unknown counts read \"—\", never 0", () => {
    const f = sc("I");
    const g = { ...f, release: { ...f.release!, since: { commits: null, prs: null } } };
    const t = text(draw(g));
    expect(t).toContain("Since v2.4.0 — commits — pull requests");
    expect(t).not.toMatch(/\b0 commits\b/);
  });

  it("no feature waiting: the plain lead; nothing waiting: no lead at all", () => {
    const r = sc("I").release!;
    expect(featureLine({ ...r, waiting: r.waiting.filter((w) => !w.feature) })).toBe("Merged since the last release:");
    expect(featureLine({ ...r, waiting: [] })).toBe("");
    expect(featureLine({ ...r, waiting: r.waiting.slice(0, 1) })).toBe("One feature is waiting to ship: DatePicker range mode.");
  });

  it("one gap, and no earlier release", () => {
    const r = sc("I").release!;
    expect(gapsSentence({ ...r, cadence: r.cadence.slice(-1) })).toBe("The gap before it was 14 days.");
    expect(gapsSentence({ ...r, cadence: [] })).toBe("Trov has seen no release before it.");
  });

  it("no release captured yet: says so, invents nothing", () => {
    const t = text(draw({ ...sc("I"), release: null }));
    expect(t).toContain("Trov has not seen a release of this repository yet.");
    expect(t).not.toMatch(/\d/);
  });

  it("a date in another year carries the year", () => {
    expect(shortDate("2025-12-30T10:00:00.000Z", NOW)).toBe("30 Dec 2025");
    expect(shortDate("2026-10-06T12:00:00.000Z", NOW)).toBe("6 Oct");
  });

  it("is the opener only for I; the App menu's Repo-wide narrowing keeps the repository's release", () => {
    for (const k of SCENARIO_KEYS) for (const v of REPO_SCENARIOS[k].variants) {
      if (ctx(sc(k, v)).layout.opener === "release") expect(k).toBe("I");
    }
    expect(sc("I", "", REPO_WIDE).release?.tag).toBe("v2.4.0");
  });
});
