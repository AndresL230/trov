/**
 * Repo › Overview, rules R1 and R2 (web/src/repo-found.ts): the found-apps card for scenario L (just connected)
 * and the "Trov does not see deploys" card for scenario M (nothing recognised), at a fixed `now`. Accept /
 * Ignore are an admin's, carry the suggestion's id and are disabled in sample mode; unknown counts read "—".
 */
import { describe, it, expect } from "vitest";
import { foundBlock, unseenBlock, unseenSees } from "../web/src/repo-found";
import { repoScenario, REPO_SCENARIOS, SCENARIO_KEYS, type ScenarioKey } from "../web/src/repo-sample";
import type { OverviewCtx } from "../web/src/repo-overview-ctx";
import { layoutInputOf, REPO_WIDE, type RepoFacts } from "@shared/repo-facts-core";
import { layoutOf } from "@shared/repo-layout-core";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const sc = (k: ScenarioKey, v = "", app: string | null = null): RepoFacts => repoScenario(k, v, { now: NOW, app });
const ctx = (f: RepoFacts, o: Partial<OverviewCtx> = {}): OverviewCtx =>
  ({ now: NOW, admin: false, sample: true, persons: [], layout: layoutOf(layoutInputOf(f)), open: new Set(), ...o });
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("the found-apps card (R1) — scenario L", () => {
  const f = sc("L");
  const draw = (o: Partial<OverviewCtx> = {}): string => foundBlock(f, ctx(f, o));

  it("opens on the found rule and names what the scan found, with the file that gave each away", () => {
    expect(ctx(f).layout.opener).toBe("found");
    const t = text(draw());
    expect(t).toContain("Trov found 3 apps in acme/new-thing");
    expect(t).toMatch(/apps\/web Site Vercel from apps\/web\/vercel\.json/);
    expect(t).toMatch(/apps\/worker Worker Cloudflare from apps\/worker\/wrangler\.toml/);
    expect(t).toMatch(/packages\/shared Package no host from packages\/shared\/package\.json/);
    expect((draw().match(/aria-label="Suggested"/g) ?? []).length).toBe(3);
  });

  it("the deploy names GitHub has seen, with their counts", () => {
    const t = text(draw());
    expect(t).toContain("Deploys seen");
    expect(t).toContain("Production – new-thing-web · Vercel, 12 times");
    expect(t).toContain("Preview – new-thing-web · Vercel, 41 times");
  });

  it("an admin gets Accept / Ignore per app (the suggestion's id) and the way to Org settings › Repositories", () => {
    const live = draw({ admin: true, sample: false });
    for (const id of ["apps/web", "apps/worker", "packages/shared"]) {
      expect(live).toContain(`data-act="repoFoundAccept" data-arg="${id}"`);
      expect(live).toContain(`data-act="repoFoundIgnore" data-arg="${id}"`);
    }
    expect(live).not.toMatch(/data-act="repoFound\w+"[^>]*disabled/);
    expect(live).toContain('data-act="orgGo" data-arg="repos"');
    expect(text(live)).toContain("Review in Org settings › Repositories");
    expect(text(live)).toContain("Nothing changes until you accept them.");
  });

  it("in sample mode the writes are drawn disabled and say why", () => {
    const sample = draw({ admin: true });
    expect((sample.match(/data-act="repoFound(Accept|Ignore)"[^>]*disabled title="Sample data: nothing is changed\."/g) ?? []).length).toBe(6);
  });

  it("a member sees no button, and is told an admin decides", () => {
    const html = draw();
    expect(html).not.toContain("repoFoundAccept");
    expect(html).not.toContain("orgGo");
    expect(text(html)).toContain("Nothing changes until an admin accepts them in Org settings.");
  });

  it("draws nothing when the scan found nothing (M), for an accepted repository, and for Repo-wide only", () => {
    expect(foundBlock(sc("M"), ctx(sc("M")))).toBe("");
    expect(foundBlock(sc("B"), ctx(sc("B")))).toBe("");
    expect(foundBlock(sc("L", "", REPO_WIDE), ctx(sc("L", "", REPO_WIDE)))).toBe("");
  });

  it("never says \"not connected\"", () => { expect(text(draw({ admin: true }))).not.toMatch(/not connected/i); });
});

describe("the unseen card (R2) — scenario M", () => {
  const f = sc("M");
  const draw = (o: Partial<OverviewCtx> = {}): string => unseenBlock(f, ctx(f, o));

  it("opens on the unseen rule and says what it looked for", () => {
    expect(ctx(f).layout.opener).toBe("unseen");
    const t = text(draw());
    expect(t).toContain("Trov does not see deploys for this repository");
    expect(t).toContain("It looked for vercel.json, netlify.toml, wrangler.toml, fly.toml, render.yaml, railway.json and Dockerfile, and found none. No host has reported a deploy to GitHub in 30 days. Everything else on this page works without one.");
  });

  it("what it DOES see: tags, pull requests, CI workflows, GitHub deployments", () => {
    const t = text(draw());
    expect(t).toContain("Tags 14 tags; the latest is v1.8.0, 6 days ago");
    expect(t).toContain("Pull requests 4 open, 9 merged this month");
    expect(t).toContain("CI eas-build.yml and test.yml");
    expect(t).toContain("GitHub deployments None reported in 30 days");
  });

  it("the latest tags, each with who and when", () => {
    const html = draw();
    expect((html.match(/class="repo-unseen-tag"/g) ?? []).length).toBe(4);
    expect(text(html)).toMatch(/v1\.8\.0 by ana-r 6d v1\.7\.2 by tom-h 19d/);
  });

  it("an admin can add an app by hand (Org settings › Repositories); a member cannot", () => {
    const admin = draw({ admin: true });
    expect(text(admin)).toContain("Add an app by hand");
    expect(admin).toContain('data-act="orgGo" data-arg="repos"');
    expect(draw()).not.toContain("Add an app by hand");
  });

  it("unknown counts read \"—\", never 0", () => {
    const u = { ...f.unseen!, prs: { open: null, mergedThisMonth: null } };
    expect(unseenSees(u, NOW)[1]).toEqual(["Pull requests", "— open, — merged this month"]);
    // Tags are unknown (null) until the capture keeps them (Phase F): "—", and no Latest tags list.
    const noTags = { ...f.unseen!, tags: null };
    expect(unseenSees(noTags, NOW)[0]).toEqual(["Tags", "—"]);
    expect(text(unseenBlock({ ...f, unseen: noTags }, ctx(f)))).not.toMatch(/Latest tags/);
  });

  it("draws nothing where something was found (L) or apps exist", () => {
    expect(unseenBlock(sc("L"), ctx(sc("L")))).toBe("");
    expect(unseenBlock(sc("B"), ctx(sc("B")))).toBe("");
  });

  it("never says \"not connected\" — for any scenario that opens on R1 or R2", () => {
    for (const k of SCENARIO_KEYS) for (const v of REPO_SCENARIOS[k].variants) {
      const g = sc(k, v);
      const x = ctx(g, { admin: true });
      if (x.layout.opener === "found") expect(text(foundBlock(g, x))).not.toMatch(/not connected/i);
      if (x.layout.opener === "unseen") expect(text(unseenBlock(g, x))).not.toMatch(/not connected/i);
    }
  });
});
