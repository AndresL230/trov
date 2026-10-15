/**
 * Repo setups, Phase E — the Code and CI tabs under the App menu, drawn (web/src/repo.ts, web/src/repo-scope.ts).
 * Scenario E (acme/storefront: web, api, docs, jobs and the ui package) narrowed as the Worker narrows — the
 * sample's `sampleScopes`, shaped like the design's `CODE_E_API` / `CI_E` (repo-data.js):
 *   - All apps: each PR's "touches" cell ("api, web, docs" · "via packages/ui"); a PR whose files were never read has
 *     an empty cell; failures name their apps; the deploy strips group per app with their host;
 *   - E: api — the scope line ("Pull requests that touch apps/api/**") with Show all apps, api's PRs only (#653,
 *     never read, is not among them), "via" only where api is reached through a package alone, api's failures;
 *   - a tile the Worker could not narrow (`value: null`) reads "—", never 0;
 *   - a not-shipped group with commits of unknown paths says so.
 */
import { describe, it, expect } from "vitest";
import { repoView, type RepoProps } from "../web/src/repo";
import { repoSample, repoScenario, repoScenarioScopes } from "../web/src/repo-sample";
import { scopeSentence, touchLines } from "../web/src/repo-scope";
import { commitGroups } from "../web/src/repo-block-kit";
import type { RepoDashboard } from "@shared/repo";
import { REPO_WIDE } from "@shared/repo-facts-core";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const data = (): RepoDashboard => ({ ...repoSample(NOW), facts: repoScenario("E", "", { now: NOW }), ...repoScenarioScopes("E", "", { now: NOW }) });
const props = (over: Partial<RepoProps> = {}): RepoProps => ({
  tab: "code", range: "7d", driftOpen: false, repo: { status: "ok", data: data() }, fetchedAt: NOW, sample: true, admin: false, poll: null, productEnv: null, now: NOW, ...over,
});
const rowOf = (html: string, n: number): string => {
  const at = html.indexOf(`#${n}`);
  expect(at, `#${n}`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<a ", at), html.indexOf("</a>", at));
};

describe("Code under the App menu (scenario E)", () => {
  it("All apps: every PR's touches cell — apps it reaches, then the packages it goes through; unknown is blank", () => {
    const html = repoView(props());
    expect(html).not.toContain("data-repo-scope-line");
    expect(rowOf(html, 636)).toContain("api, web, docs");
    expect(rowOf(html, 636)).toContain("via packages/ui");
    expect(rowOf(html, 639)).toContain("api, jobs");
    expect(rowOf(html, 653)).toContain(`data-touch="unknown"`);
    expect(rowOf(html, 653)).not.toContain("Repo-wide");
  });

  it("E: api — the design's CODE_E_API: the scope line, api's PRs only, its tiles", () => {
    const html = repoView(props({ app: "api" }));
    expect(html).toContain("Pull requests that touch apps/api/**");
    expect(html).toContain(`data-act="repoPickApp" data-arg="__all"`);
    expect(html).toContain("Show all apps");
    for (const n of [642, 639, 644, 636, 633, 630]) expect(html).toContain(`#${n}`);
    for (const n of [653, 650, 647, 640, 645, 651]) expect(html).not.toContain(`#${n}`);
    // api touches #636 itself, so no "via" under api
    expect(rowOf(html, 636)).not.toContain("via packages/ui");
    expect(html).toMatch(/Open PRs[\s\S]*data-count="3"/);
    expect(html).toContain(`data-count="24"`); // api's commits this week (the design's CODE_E_API)
    expect(html).toContain("touching api");
  });

  it("E: web — a PR that reaches web only through packages/ui says \"via packages/ui\"", () => {
    const html = repoView(props({ app: "web" }));
    expect(html).toContain("Pull requests that touch apps/web/** or packages/ui/**");
    expect(rowOf(html, 640)).toContain("via packages/ui");
    expect(rowOf(html, 651)).not.toContain("via ");
  });

  it("Repo-wide only: the PRs outside every app", () => {
    const html = repoView(props({ app: REPO_WIDE }));
    expect(html).toContain("Pull requests and commits that touch no app");
    expect(html).toContain("#645");
    expect(html).not.toContain("#642");
  });

  it("a tile the Worker could not narrow reads —, never 0", () => {
    const d = data();
    const over = { ...d, sampleScopes: undefined, codeStats: { status: "ok" as const, data: [{ label: "Open PRs", value: null, sub: "1 pull request not read yet", tone: "neutral" as const }] } };
    const html = repoView(props({ app: "api", sample: false, repo: { status: "ok", data: over } }));
    expect(html).toContain("data-unknown");
    expect(html).toContain("1 pull request not read yet");
    expect(html).not.toMatch(/data-count="0"/);
  });
});

describe("CI under the App menu (scenario E)", () => {
  it("All apps: the design's CI_E — strips per app with the host, failures with their apps", () => {
    const html = repoView(props({ tab: "ci" }));
    expect(html).toContain("Deploy history — last 10 per app");
    for (const a of ["web", "api", "docs", "jobs"]) expect(html).toContain(`data-deploy-app="${a}"`);
    expect(html).toContain("Fly.io via deploy-jobs.yml");
    expect(html).toContain("Cloudflare Pages");
    expect(html.match(/data-fail-apps/g)).toHaveLength(3);
    expect(html).toContain("· api");
    expect(html).toContain("· web");
  });

  it("E: api — its strip and its two failures; no app label on rows already narrowed", () => {
    const html = repoView(props({ tab: "ci", app: "api" }));
    expect(html).toContain("CI runs whose workflow or head commit touches apps/api/**");
    expect(html).toContain(`data-deploy-app="api"`);
    expect(html).not.toContain(`data-deploy-app="web"`);
    expect(html).toContain("api › build");
    expect(html).toContain("Render build");
    expect(html).not.toContain("web › e2e");
    expect(html).not.toContain("data-fail-apps");
    expect(html).toContain("6.3%");
  });
});

describe("the wording rules", () => {
  it("touches / via from app keys; a PR never read has no lines", () => {
    const f = repoScenario("E", "", { now: NOW });
    expect(touchLines(f, { touches: null, packages: [] }, null)).toBeNull();
    expect(touchLines(f, { touches: [], packages: ["ui"] }, null)).toEqual({ touches: "web, docs", via: "via packages/ui" });
    expect(touchLines(f, { touches: [], packages: ["ui"] }, "web")).toEqual({ touches: "web, docs", via: "via packages/ui" });
    expect(touchLines(f, { touches: ["web"], packages: ["ui"] }, "web")).toEqual({ touches: "web, docs", via: "" });
    expect(scopeSentence(f, "jobs", "code")).toBe("Pull requests that touch apps/jobs/**");
  });

  it("a not-shipped group with commits of unknown paths says so", () => {
    const html = commitGroups([{ kind: "direct", pr: null, title: "Direct pushes to main", by: [], mergedAt: null, commits: [{ sha: "abc1234", msg: "m", at: new Date(NOW).toISOString() }], more: 0, pathsUnknown: 1 }],
      { now: NOW, admin: false, sample: true, persons: [], open: new Set() } as never);
    expect(html).toContain("data-paths-unknown");
    expect(html).toContain("paths unknown");
  });
});
