/**
 * Repo › Overview — the Previews list (web/src/repo-previews.ts), drawn from the design's scenarios as
 * RepoFacts at a fixed `now`: one row per open PR's preview, a live one unmarked, failed / building marked,
 * the failing streak in words, links only to https and never in sample mode, and nothing for a repository
 * that has no previews.
 */
import { describe, it, expect } from "vitest";
import { previewsBlock, failingSince } from "../web/src/repo-previews";
import { repoScenario, type ScenarioKey } from "../web/src/repo-sample";
import type { OverviewCtx } from "../web/src/repo-overview-ctx";
import type { PersonSummary } from "../web/src/api";
import { layoutInputOf, REPO_WIDE, type RepoFacts } from "@shared/repo-facts-core";
import { layoutOf } from "@shared/repo-layout-core";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const sc = (k: ScenarioKey, v = "", app: string | null = null): RepoFacts => repoScenario(k, v, { now: NOW, app });
const ctx = (f: RepoFacts, o: Partial<OverviewCtx> = {}): OverviewCtx =>
  ({ now: NOW, admin: false, sample: true, persons: [], layout: layoutOf(layoutInputOf(f)), open: new Set(), ...o });
const draw = (f: RepoFacts, o: Partial<OverviewCtx> = {}): string => previewsBlock(f, ctx(f, o));
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** One preview's row by its PR number. */
const rowOf = (html: string, pr: number): string => {
  const at = html.indexOf(`data-pr="${pr}"`);
  expect(at, `row #${pr}`).toBeGreaterThan(-1);
  const end = html.indexOf('class="repo-pv-row"', at);
  return html.slice(at, end === -1 ? undefined : end);
};

describe("the Previews list", () => {
  it("B: two open previews — a live one with no mark, a failed one marked Failed with no link", () => {
    const html = draw(sc("B"));
    expect(text(html)).toContain("Previews · 2 open");
    expect(text(html)).toContain("one per open pull request");
    const live = text(rowOf(html, 318));
    expect(live).toContain("Repo screen: apps and targets #318 · repo-apps");
    expect(live).not.toMatch(/Failed|Building|Live/);
    expect(live).toContain("40m");
    const failed = text(rowOf(html, 316));
    expect(failed).toContain("Failed");
    expect(failed).not.toContain("repo-apps.trov.workers.dev");
    // A single failure is not a streak.
    expect(failed).not.toContain("Failing for");
  });

  it("B trouble: the failing streak in words, from failStreak and failingSince", () => {
    const f = sc("B", "trouble");
    expect(text(rowOf(draw(f), 316))).toContain("Failing for 3 days, last 4 builds");
    expect(failingSince(f.previews.find((p) => p.pr === 316)!, NOW)).toBe("Failing for 3 days, last 4 builds");
  });

  it("C: six open, one building (its shape blinks), one failed; a live preview's address shows", () => {
    const html = draw(sc("C"));
    expect(text(html)).toContain("Previews · 6 open");
    expect(rowOf(html, 86)).toContain('class="repo-blink"');
    expect(text(rowOf(html, 86))).toContain("Building");
    expect(text(rowOf(html, 83))).toContain("Failed");
    expect(text(rowOf(html, 88))).toContain("deploy-preview-88--acme-site.netlify.app");
  });

  it("links out only on live data, only to https, and never for a preview that is not live", () => {
    expect(draw(sc("C"))).not.toContain("<a ");
    const live = draw(sc("C"), { sample: false });
    expect(live).toContain('<a href="https://deploy-preview-88--acme-site.netlify.app" target="_blank" rel="noopener"');
    expect(rowOf(live, 86)).not.toContain("<a ");
    expect(rowOf(live, 83)).not.toContain("<a ");
    const f = sc("C");
    const bad = { ...f, previews: f.previews.map((p) => ({ ...p, url: p.url ? p.url.replace("https://", "http://") : null })) };
    expect(draw(bad, { sample: false })).not.toContain('href="http://');
  });

  it("empty: an app with previews and no open PR says so", () => {
    const f = { ...sc("D"), previews: [] };
    expect(text(draw(f))).toContain("Previews · 0 open");
    expect(text(draw(f))).toContain("No open pull requests, so no previews.");
  });

  it("draws nothing for a repository with no previews (never \"no previews\" for a thing it does not have)", () => {
    for (const k of ["A", "G", "H", "I", "J", "L", "M"] as const) expect(draw(sc(k)), k).toBe("");
    expect(draw(sc("B", "", REPO_WIDE))).toBe("");
  });

  it("narrowed by the App menu: E's web shows only web's previews", () => {
    const f = sc("E", "", "web");
    expect(f.previews.every((p) => p.app === "web")).toBe(true);
    expect(text(draw(f))).toContain("Previews · 3 open");
    expect(text(draw(sc("E", "", "jobs")))).toBe("");
  });

  it("who opened it goes through people.ts: a card on live data, a plain chip in sample mode", () => {
    const andres = { handle: "andres", name: "Andres Lopez", color: "moss", avatar_url: null } as unknown as PersonSummary;
    expect(draw(sc("B"), { sample: false, persons: [andres] })).toContain('data-act="openPerson" data-arg="andres"');
    expect(draw(sc("B"), { persons: [andres] })).not.toContain("openPerson");
    expect(text(draw(sc("B")))).not.toMatch(/not connected/i);
  });
});
