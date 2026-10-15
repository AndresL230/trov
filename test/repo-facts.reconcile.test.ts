/**
 * The facts arms of `reconcileRepo` (src/repo/facts-compute.ts), with GitHub stubbed at the Response level:
 *   - drift_chain: one step per ADJACENT pair of environments, and the `drift` section's snapshot from its last step;
 *   - not_shipped: `<serving sha>...<branch>` per part, grouped by PR, GitHub's total as the count — and, in a
 *     repository with two or more apps, kept to the app's watch paths when the commits list their files;
 *   - out_of_step: one compare per lagging commit against the newest serving one;
 *   - incremental (nothing changed → no compare) and bounded (`FACTS_COMPARE_CAP`, `reconcileRequests`).
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { reconcileRepo, reconcileRequests, refreshDrift } from "../src/repo/github";
import { computeNotShipped, FACTS_COMPARE_CAP } from "../src/repo/facts-compute";
import { matchesWatch } from "../src/repo/watch";
import { getSnapshot } from "../src/repo/store";
import { ingestRepoEvent } from "../src/consumer";
import type { RepoDrift } from "@shared/repo";
import type { DriftChainSnapshot, NotShippedSnapshot, OutOfStepSnapshot } from "../src/repo/facts-store";
import type { RepoEnvConfig } from "../src/repo/config";
import { ENVS, seedOrgRepoConfig } from "./helpers/repo";
import { addPart } from "./helpers/dashboard-hosting";
import { ORG_A, systemCtx } from "./helpers/tenant";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString();
const DEV: RepoEnvConfig = { key: "dev", label: "dev", note: "develop", branch: "develop", frontendUrl: "", apiUrl: "", healthPath: "/" };
const ENVS3: RepoEnvConfig[] = [DEV, ...ENVS];
const REPO = "SaplingLearn/sapling";

const c = (sha: string, message: string, mins: number, login = "jose-a", files?: string[]) =>
  ({ sha, commit: { message, committer: { date: ago(mins) } }, author: { login }, ...(files ? { files: files.map((filename) => ({ filename })) } : {}) });

async function serving(envKey: string, part: string, provider: string, sha: string, mins: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO hosting_deploys (org_id, env, part, provider, deploy_id, state, target, sha, created_at, ready_at, recorded_at, updated_at, sha_source)
     VALUES (?, ?, ?, ?, ?, 'ready', 'production', ?, ?, ?, ?, ?, 'provider')`,
  ).bind(ORG_A, envKey, part, provider, `${envKey}-${part}-${sha}`, sha, ago(mins), ago(mins), ago(mins), ago(mins)).run();
}

/** A fake api.github.com: exact path → JSON body; every call recorded. Unknown paths: `[]` (the reconcile's other arms). */
function github(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = (async (u: RequestInfo | URL) => {
    const url = String(u);
    calls.push(url);
    if (url.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, pullRequests: { nodes: [] } } } }), { status: 200 });
    const path = url.replace(`https://api.github.com/repos/${REPO}`, "");
    if (path in routes) return new Response(JSON.stringify(routes[path]), { status: 200 });
    if (path.startsWith("/compare/")) return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls, compares: () => calls.filter((x) => x.includes("/compare/")).map((x) => x.replace(`https://api.github.com/repos/${REPO}`, "")) };
}

const S = { stg: "a1a1a1a1a1a1", fProd: "b2b2b2b2b2b2", bProd: "c3c3c3c3c3c3" };
const PROD_COMMITS = [
  c("1111111aaaa", "web: checkout (#41)", 3000, "ana-r", ["apps/web/checkout.ts"]),
  c("2222222bbbb", "api: rate limit (#42)", 2000, "kenji-m", ["apps/api/limit.ts"]),
  c("3333333cccc", "readme", 1000, "tom-h", ["README.md"]),
];
const ROUTES: Record<string, unknown> = {
  "/commits?sha=develop&per_page=1": [{ sha: "headdev" }],
  "/commits?sha=main&per_page=1": [{ sha: "headmain" }],
  "/commits?sha=production&per_page=1": [{ sha: "headprod" }],
  // the chain: dev → staging, staging → production (+ its behind side)
  "/compare/main...develop": { ahead_by: 1, behind_by: 0, commits: [c("dddd111", "dev only", 50)] },
  "/compare/production...main": { ahead_by: 2, behind_by: 1, commits: [c("eeee111", "feature (#7)", 300), c("eeee222", "tweak", 200)] },
  "/compare/main...production": { ahead_by: 1, behind_by: 2, commits: [c("ffff111", "hotfix", 400)] },
  // not shipped: staging's parts serve one commit; production's two
  [`/compare/${S.stg}...main`]: { ahead_by: 5, behind_by: 0, commits: [c("5555555", "a (#50)", 900), c("6666666", "b", 800)] },
  [`/compare/${S.fProd}...production`]: { ahead_by: 3, behind_by: 0, commits: PROD_COMMITS },
  [`/compare/${S.bProd}...production`]: { ahead_by: 3, behind_by: 0, commits: PROD_COMMITS },
  // out of step: backend's commit against frontend's (the newest serving)
  [`/compare/${S.bProd}...${S.fProd}`]: { status: "ahead", ahead_by: 4, behind_by: 0, commits: [] },
};

async function seed(): Promise<void> {
  await seedOrgRepoConfig(env.DB, ORG_A, REPO, ENVS3);
  for (const e of ["staging", "production"]) {
    await addPart(ORG_A, e, "frontend", "cloudflare", "web");
    await addPart(ORG_A, e, "backend", "railway", "service", {}, 1);
  }
  await serving("staging", "frontend", "cloudflare", S.stg, 100);
  await serving("staging", "backend", "railway", S.stg, 90);
  await serving("production", "frontend", "cloudflare", S.fProd, 60);
  await serving("production", "backend", "railway", S.bProd, 600);
  // two apps, each with its own watch paths (the seed's frontend / backend rows)
  await env.DB.prepare(`UPDATE repo_apps SET watch = '["apps/web"]' WHERE org_id = ? AND key = 'frontend'`).bind(ORG_A).run();
  await env.DB.prepare(`UPDATE repo_apps SET watch = '["apps/api/**"]' WHERE org_id = ? AND key = 'backend'`).bind(ORG_A).run();
  await ingestRepoEvent(systemCtx(ORG_A), { semantic_key: "gh:prs:41:m", kind: "pr", number: 41, state: "merged", title: "Checkout", actor_login: "ana-r", raw: "{}", provenance: "webhook", occurred_at: ago(2990) });
}

const opts = (fetchImpl: typeof fetch) => ({ token: "t", repo: REPO, fetchImpl });

describe("reconcile's facts arms", () => {
  it("store the promotion chain, the drift section from its last step, not shipped and out of step — within the bound", async () => {
    await seed();
    const gh = github(ROUTES);
    const res = await reconcileRepo(systemCtx(ORG_A), opts(gh.fetchImpl), ENVS3, NOW);
    expect(res.failed).toEqual([]);
    expect(gh.calls.length).toBeLessThanOrEqual(reconcileRequests(3));

    const chain = (await getSnapshot<DriftChainSnapshot>(systemCtx(ORG_A), "drift_chain"))!.data;
    expect(chain.steps.map((s) => [s.fromEnv, s.toEnv, s.from, s.to, s.ahead, s.behind])).toEqual([
      ["dev", "staging", "develop", "main", 1, 0],
      ["staging", "production", "main", "production", 2, 1],
    ]);
    expect(chain.steps[1].groups.map((g) => [g.kind, g.pr, g.commits.length])).toEqual([["pr", 7, 1], ["direct", null, 1]]);
    // the drift section: the last step, with its behind side — head main, base production, as before
    const drift = (await getSnapshot<RepoDrift>(systemCtx(ORG_A), "drift"))!.data;
    expect(drift).toMatchObject({ head: "main", base: "production", ahead: 2, behind: 1 });
    expect(drift.groups.map((g) => g.tag)).toEqual(["#7", "PUSH", "BEHIND"]);

    const ns = (await getSnapshot<NotShippedSnapshot>(systemCtx(ORG_A), "not_shipped"))!.data.parts;
    expect(Object.keys(ns).sort()).toEqual(["production/backend", "production/frontend", "staging/backend", "staging/frontend"]);
    // staging: the compare's commits list no files → unfiltered, GitHub's own total
    expect(ns["staging/frontend"]).toMatchObject({ servingSha: S.stg, branch: "main", head: "headmain", count: 5, oldestAt: ago(900) });
    expect(ns["staging/frontend"].groups.map((g) => [g.kind, g.pr])).toEqual([["pr", 50], ["direct", null]]);
    // production: every commit lists its files and the repository has two apps → each app's own commits
    expect(ns["production/frontend"]).toMatchObject({ count: 1, oldestAt: ago(3000) });
    expect(ns["production/frontend"].groups).toEqual([{ kind: "pr", pr: 41, title: "Checkout", by: ["ana-r"], mergedAt: ago(2990), commits: [{ sha: "1111111", msg: "web: checkout (#41)", at: ago(3000) }], more: 0 }]);
    expect(ns["production/backend"]).toMatchObject({ count: 1, oldestAt: ago(2000) });
    expect(ns["production/backend"].groups.map((g) => g.pr)).toEqual([42]);

    const oos = (await getSnapshot<OutOfStepSnapshot>(systemCtx(ORG_A), "out_of_step"))!.data.envs;
    expect(oos.production.rows).toEqual([{ env: "production", app: "backend", sha: S.bProd, of: "frontend", ofSha: S.fProd, behindBy: 4 }]);
    expect(oos.staging.rows).toEqual([]); // one commit for both apps: in step, no compare
    expect(gh.compares().filter((x) => x.includes(`${S.bProd}...${S.fProd}`))).toHaveLength(1);
  });

  it("is incremental: nothing changed → not one facts compare the second time; a new serving commit → that part only", async () => {
    await seed();
    await reconcileRepo(systemCtx(ORG_A), opts(github(ROUTES).fetchImpl), ENVS3, NOW);
    const again = github(ROUTES);
    await reconcileRepo(systemCtx(ORG_A), opts(again.fetchImpl), ENVS3, NOW + 60_000);
    expect(again.compares().filter((x) => !["/compare/main...develop", "/compare/production...main", "/compare/main...production"].includes(x))).toEqual([]);

    await serving("production", "frontend", "cloudflare", "9e9e9e9e9e9e", 1);
    const third = github({ ...ROUTES, "/compare/9e9e9e9e9e9e...production": { ahead_by: 0, behind_by: 0, commits: [] },
      [`/compare/${S.bProd}...9e9e9e9e9e9e`]: { status: "ahead", ahead_by: 6, behind_by: 0, commits: [] } });
    await reconcileRepo(systemCtx(ORG_A), opts(third.fetchImpl), ENVS3, NOW + 120_000);
    expect(third.compares().filter((x) => !x.startsWith("/compare/main...") && !x.startsWith("/compare/production...main")).sort())
      .toEqual(["/compare/9e9e9e9e9e9e...production", `/compare/${S.bProd}...9e9e9e9e9e9e`]);
    const ns = (await getSnapshot<NotShippedSnapshot>(systemCtx(ORG_A), "not_shipped"))!.data.parts;
    expect(ns["production/frontend"]).toMatchObject({ servingSha: "9e9e9e9e9e9e", count: 0, oldestAt: null, groups: [] });
  });

  it("is bounded: past the budget the rest wait (never computed first) and the next run takes them", async () => {
    await seed();
    const gh = github(ROUTES);
    const budget = { left: 2 };
    await computeNotShipped(systemCtx(ORG_A), opts(gh.fetchImpl), ENVS3, budget, NOW);
    expect(gh.compares()).toHaveLength(2);
    expect(budget.left).toBe(0);
    expect(Object.keys((await getSnapshot<NotShippedSnapshot>(systemCtx(ORG_A), "not_shipped"))!.data.parts)).toHaveLength(2);
    const next = github(ROUTES);
    await computeNotShipped(systemCtx(ORG_A), opts(next.fetchImpl), ENVS3, { left: FACTS_COMPARE_CAP }, NOW + 1);
    expect(Object.keys((await getSnapshot<NotShippedSnapshot>(systemCtx(ORG_A), "not_shipped"))!.data.parts)).toHaveLength(4);
    // no branch head is known here (no reconcile ran), so every part is due again — never-computed ones first, within the cap
    expect(next.compares().length).toBeLessThanOrEqual(4);
  });

  it("the cost: 16 + 2N + max(2, N) + 6", () => {
    expect(reconcileRequests(2)).toBe(28);
    expect(reconcileRequests(3)).toBe(16 + 6 + 3 + 6);
    expect(FACTS_COMPARE_CAP).toBe(6);
  });

  it("a failed compare names the arm, keeps what was computed, and the last good entries stand", async () => {
    await seed();
    await reconcileRepo(systemCtx(ORG_A), opts(github(ROUTES).fetchImpl), ENVS3, NOW);
    const before = (await getSnapshot<NotShippedSnapshot>(systemCtx(ORG_A), "not_shipped"))!.data.parts["production/backend"];
    await serving("production", "backend", "railway", "7a7a7a7a7a7a", 1); // no route for its compares → 404
    const res = await reconcileRepo(systemCtx(ORG_A), opts(github(ROUTES).fetchImpl), ENVS3, NOW + 60_000);
    expect(res.failed).toEqual(expect.arrayContaining(["not_shipped", "out_of_step"]));
    const after = (await getSnapshot<NotShippedSnapshot>(systemCtx(ORG_A), "not_shipped"))!.data.parts;
    expect(after["production/backend"]).toEqual(before); // the old entry (for the old sha) — the read nulls it now
    expect(after["production/frontend"].count).toBe(1);
  });

  it("on a push (refreshDrift): the chain, and not shipped only for the pushed branch's parts", async () => {
    await seed();
    const gh = github(ROUTES);
    await refreshDrift(systemCtx(ORG_A), opts(gh.fetchImpl), ENVS3, "main", NOW);
    expect(gh.compares()).toEqual(expect.arrayContaining(["/compare/main...develop", "/compare/production...main", `/compare/${S.stg}...main`]));
    expect(gh.compares().some((x) => x.endsWith("...production") && x !== "/compare/main...production")).toBe(false);
    const ns = (await getSnapshot<NotShippedSnapshot>(systemCtx(ORG_A), "not_shipped"))!.data.parts;
    expect(Object.keys(ns).sort()).toEqual(["staging/backend", "staging/frontend"]);
    expect((await getSnapshot<OutOfStepSnapshot>(systemCtx(ORG_A), "out_of_step"))!.data.envs.production.rows).toHaveLength(1);
  });
});

describe("one app: every commit counts", () => {
  it("leaves the commits unfiltered even when they list files", async () => {
    await seed();
    await env.DB.prepare(`UPDATE repo_apps SET kind = 'Package' WHERE org_id = ? AND key = 'backend'`).bind(ORG_A).run();
    await reconcileRepo(systemCtx(ORG_A), opts(github(ROUTES).fetchImpl), ENVS3, NOW);
    const ns = (await getSnapshot<NotShippedSnapshot>(systemCtx(ORG_A), "not_shipped"))!.data.parts;
    expect(ns["production/frontend"].count).toBe(3);
    expect(ns["production/backend"]).toBeUndefined(); // a Package has no parts of its own
  });
});

describe("watch paths (src/repo/watch.ts)", () => {
  it("a folder is itself and everything under it; * is one segment, ** any; the root is everything", () => {
    expect(matchesWatch("apps/web/x.ts", ["apps/web"])).toBe(true);
    expect(matchesWatch("apps/webby/x.ts", ["apps/web"])).toBe(false);
    expect(matchesWatch("/apps/web/", ["/apps/web/"])).toBe(true);
    expect(matchesWatch("apps/api/src/a.ts", ["apps/*/src"])).toBe(true);
    expect(matchesWatch("apps/api/lib/src/a.ts", ["apps/*/src"])).toBe(false);
    expect(matchesWatch("apps/api/lib/src/a.ts", ["apps/**/src"])).toBe(true);
    expect(matchesWatch("apps/xsrc/a.ts", ["apps/**/src"])).toBe(false);
    expect(matchesWatch("README.md", ["/"])).toBe(true);
    expect(matchesWatch("README.md", ["apps/web", "packages/ui"])).toBe(false);
  });
});
