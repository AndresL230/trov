import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { all, first } from "../src/db";
import { ingestRepoEvent } from "../src/consumer";
import { reconcileRepo } from "../src/repo/github";
import { getSnapshot } from "../src/repo/store";
import type { RepoEventRow } from "../src/repo/types";
import { ENVS, fakeGithub } from "./helpers/repo";

const NOW = Date.parse("2026-09-20T12:00:00Z");

const openPr = { number: 482, title: "Batch D1 reads", html_url: "https://github.com/o/r/pull/482", state: "open", draft: false, merged_at: null, updated_at: "2026-09-20T09:10:00Z", user: { login: "lpcooper-arch" }, head: { ref: "feature/usage-rollup", sha: "c91d2ae" }, base: { ref: "main" } };
const commit = { sha: "f00d", commit: { message: "old work\n\nbody", committer: { date: "2026-09-10T08:00:00Z" } }, author: { login: "AndresL230" } };

/** The live shape of the deployments GraphQL response (verified against the
 *  target repo): UPPERCASE states, a Bot creator whose login has no `[bot]`
 *  suffix, `databaseId` = the REST/webhook `deployment.id`, no status ids. */
const deployNode = (over: Record<string, unknown> = {}) => ({
  databaseId: 7001, commitOid: "becdbac", environment: "Sapling / staging", createdAt: "2026-09-20T09:04:47Z",
  creator: { login: "railway-app", __typename: "Bot" },
  statuses: { nodes: [
    { state: "SUCCESS", createdAt: "2026-09-20T09:05:34Z", logUrl: "https://railway.com/l" },
    { state: "IN_PROGRESS", createdAt: "2026-09-20T09:04:47Z", logUrl: null },
  ] },
  ...over,
});
const deployments = (...nodes: unknown[]) => ({ data: { repository: { deployments: { nodes } } } });

describe("reconcileRepo — deployments, workflow runs and env-head checks", () => {
  it("backfills Railway deployments with their statuses, recent runs, and env-head checks", async () => {
    const gh = fakeGithub({
      graphql: deployments(deployNode()),
      "/actions/runs?": { workflow_runs: [{ id: 99, name: "CI", head_branch: "main", head_sha: "becdbac", status: "completed", conclusion: "success", run_attempt: 1, event: "push", html_url: "https://github.com/o/r/actions/runs/99", updated_at: "2026-09-20T09:10:00Z", run_started_at: "2026-09-20T09:05:00Z", actor: { login: "AndresL230" } }] },
      "/commits/main/check-runs": { check_runs: [{ id: 5001, name: "Workers Builds: frontend-staging", status: "completed", conclusion: "success", head_sha: "becdbac", details_url: "https://dash", started_at: "2026-09-20T09:05:00Z", completed_at: "2026-09-20T09:06:32Z", app: { slug: "cloudflare-workers-and-pages" }, check_suite: { head_branch: "main" } }] },
    });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    const kinds = await all<{ kind: string; n: number }>(env.DB, `SELECT kind, COUNT(*) AS n FROM repo_events GROUP BY kind ORDER BY kind`);
    expect(kinds).toEqual([{ kind: "check", n: 1 }, { kind: "deploy", n: 2 }, { kind: "run", n: 1 }]);
    // The check-runs list omits check_suite.head_branch reliably only per-ref: the branch we ASKED for is the branch.
    expect(await all(env.DB, `SELECT env, part FROM repo_events WHERE kind = 'check'`)).toEqual([{ env: "staging", part: "frontend" }]);
    // One GraphQL request replaces the old 1 + 20 REST deployment calls; a
    // second GraphQL request is Task 12's branches refs query (both env's
    // request the same URL, routed by query text — see fakeGithub above); a
    // third is the PR-reviews query.
    expect(gh.calls.filter((c) => c.endsWith("/graphql")).length).toBe(3);
    expect(gh.calls.some((c) => c.includes("/deployments"))).toBe(false);
  });

  it("lowercases the GraphQL states and re-suffixes a Bot creator so backfill and webhook rows agree", async () => {
    const gh = fakeGithub({ graphql: deployments(deployNode()) });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    const rows = await all<RepoEventRow>(env.DB, `SELECT * FROM repo_events WHERE kind = 'deploy' ORDER BY occurred_at`);
    expect(rows.map((r) => [r.semantic_key, r.state, r.env, r.part, r.actor_login, r.sha, r.provenance])).toEqual([
      ["gh:deploy:7001:in_progress", "in_progress", "staging", "backend", "railway-app[bot]", "becdbac", "backfill"],
      ["gh:deploy:7001:success", "success", "staging", "backend", "railway-app[bot]", "becdbac", "backfill"],
    ]);
    // GraphQL statuses have no numeric id — `raw` records that honestly.
    expect(JSON.parse(rows[1].raw).status_id).toBeNull();
  });

  it("asks GraphQL only for the configured environments, so a preview deployment can never appear", async () => {
    const gh = fakeGithub({ graphql: deployments(deployNode({ databaseId: 8002, environment: "Sapling / pr-91" })) });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(gh.graphql[0].variables).toEqual({ owner: "o", name: "r", envs: ["Sapling / staging", "Sapling / production"] });
    expect(await all(env.DB, `SELECT * FROM repo_events WHERE kind = 'deploy'`)).toEqual([]);
  });

  it("skips the deployments request entirely when no environment is configured — but the branches refs query still runs", async () => {
    const gh = fakeGithub({});
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, [], NOW);
    // `deployments` genuinely cannot filter without environment names, so it
    // stays gated; `branches` degrades fine with envs: [] (see the dedicated
    // test below), so a refs query is legitimate here — only the deployments
    // query must be absent.
    expect(gh.graphql.some((c) => c.query.includes("deployments("))).toBe(false);
    expect(gh.graphql.some((c) => c.query.includes("refs(refPrefix"))).toBe(true);
  });

  // Fix round 1, Finding 1: `computeBranches` degrades correctly with no
  // environments configured — empty exclusion set, "main" as the compare
  // head (the same fallback the `commits` arm above uses) — so unlike
  // `deployments`, the `branches` arm runs UNCONDITIONALLY.
  it("writes a branches snapshot compared against main with nothing excluded when no environment is configured", async () => {
    const gh = fakeGithub({
      refsGraphql: { data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { name: "feature/x", target: { committedDate: "2026-09-19T00:00:00Z" }, compare: { aheadBy: 0, behindBy: 2 } },
      ] } } } },
    });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, [], NOW);
    const call = gh.graphql.find((c) => c.query.includes("refs(refPrefix"));
    expect(call?.variables).toMatchObject({ owner: "o", name: "r", head: "main" });
    const snap = await getSnapshot(env.DB, "branches");
    expect(snap?.data).toEqual({ active: 1, stale: 0, head: "main", rows: [{ name: "feature/x", at: "2026-09-19T00:00:00Z", ahead: 2, behind: 0, stale: false }] });
  });

  it("an errors body writes nothing, does not throw, and names the arm in `failed`", async () => {
    const gh = fakeGithub({ graphql: { data: { repository: null }, errors: [{ message: "Could not resolve to a Repository" }] } });
    const res = await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(await all(env.DB, `SELECT * FROM repo_events WHERE kind = 'deploy'`)).toEqual([]);
    expect(res.failed).toContain("deployments");
  });

  it("survives a GraphQL body with no nodes at all", async () => {
    const gh = fakeGithub({ graphql: { data: {} } });
    const res = await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(res.failed).not.toContain("deployments");
    expect(await all(env.DB, `SELECT * FROM repo_events WHERE kind = 'deploy'`)).toEqual([]);
  });

  it("records each configured environment branch's head as an env_heads snapshot, not a synthetic push row", async () => {
    const gh = fakeGithub({
      "/commits?sha=main&per_page=1": [{ sha: "mainhead0000001", commit: { message: "ship it", committer: { date: "2026-09-20T10:00:00Z" } }, author: { login: "AndresL230" } }],
      "/commits?sha=production&per_page=1": [{ sha: "prodhead1234567", commit: { message: "release cut", committer: { date: "2026-09-19T10:00:00Z" } }, author: { login: "AndresL230" } }],
    });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    const snap = await getSnapshot<Record<string, string>>(env.DB, "env_heads");
    expect(snap!.data).toEqual({ main: "mainhead0000001", production: "prodhead1234567" });
    expect(snap!.computedAt).toBe(new Date(NOW).toISOString());
    // A synthetic count-1 push row would shadow the real push that follows it.
    expect(await all(env.DB, `SELECT * FROM repo_events WHERE kind = 'push' AND ref IN ('main','production')`)).toEqual([]);
  });

  it("tags a Workers Builds check for the environment whose workerCheck matches, even when two branches share a head", async () => {
    // Both configured branches point at the SAME commit, so BOTH check runs come
    // back on the first branch we ask about. The production build must not be
    // tagged (and permanently frozen as `unchanged`) with staging's branch.
    const head = { sha: "shared00", commit: { message: "same head", committer: { date: "2026-09-20T10:00:00Z" } }, author: { login: "AndresL230" } };
    const check = (id: number, name: string) => ({ id, name, status: "completed", conclusion: "success", head_sha: "shared00", details_url: "https://dash", started_at: "2026-09-20T09:05:00Z", completed_at: "2026-09-20T09:06:32Z", app: { slug: "cloudflare-workers-and-pages" } });
    const runs = { check_runs: [check(5001, "Workers Builds: frontend-staging"), check(5002, "Workers Builds: frontend")] };
    const gh = fakeGithub({
      "/commits?sha=main&per_page=1": [head], "/commits?sha=production&per_page=1": [head],
      "/commits/main/check-runs": runs, "/commits/production/check-runs": runs,
    });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(await all(env.DB, `SELECT number, env, part, ref FROM repo_events WHERE kind = 'check' ORDER BY number`)).toEqual([
      { number: 5001, env: "staging", part: "frontend", ref: "main" },
      { number: 5002, env: "production", part: "frontend", ref: "production" },
    ]);
  });

  it("enriches a backfilled failing or timed-out run with its failing job title, capped at 5 lookups", async () => {
    const runs = Array.from({ length: 7 }, (_, i) => ({
      id: 9000 + i, name: `CI ${i}`, head_branch: "main", head_sha: `sha${i}`, status: "completed",
      conclusion: i % 2 === 0 ? "failure" : "timed_out", run_attempt: 1, event: "push",
      html_url: `https://github.com/o/r/actions/runs/${9000 + i}`, updated_at: "2026-09-20T09:10:00Z",
      run_started_at: "2026-09-20T09:05:00Z", actor: { login: "AndresL230" },
    }));
    const gh = fakeGithub({
      "/actions/runs?": { workflow_runs: runs },
      "/jobs": { jobs: [{ name: "e2e", conclusion: "failure", steps: [{ name: "run suite", conclusion: "failure" }] }] },
    });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    const jobCalls = gh.calls.filter((c) => c.includes("/jobs"));
    expect(jobCalls.length).toBe(5);
    const titled = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM repo_events WHERE kind = 'run' AND title IS NOT NULL`);
    expect(titled[0].n).toBe(5);
  });

  // M9: the job-title pass reads the BACKLOG of untitled failed runs, not just
  // the rows this Sync happened to write — so a first Sync's leftovers drain
  // over later Syncs instead of staying nameless forever.
  it("labels a failed run left untitled by an earlier Sync, even though this Sync writes nothing new", async () => {
    await ingestRepoEvent(systemCtx(), { semantic_key: "gh:run:77:1", kind: "run", number: 77, name: "CI", state: "failure", raw: "{}", provenance: "webhook", occurred_at: "2026-09-19T09:00:00Z" });
    const gh = fakeGithub({ "/jobs": { jobs: [{ name: "e2e", conclusion: "failure", steps: [{ name: "run suite", conclusion: "failure" }] }] } });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(await first(env.DB, `SELECT title FROM repo_events WHERE semantic_key = 'gh:run:77:1'`)).toEqual({ title: "e2e · run suite" });
  });

  it("never looks up a run outside the last 7 days, or one that already has a title", async () => {
    await ingestRepoEvent(systemCtx(), { semantic_key: "gh:run:70:1", kind: "run", number: 70, state: "failure", raw: "{}", provenance: "webhook", occurred_at: "2026-09-01T09:00:00Z" });
    await ingestRepoEvent(systemCtx(), { semantic_key: "gh:run:71:1", kind: "run", number: 71, state: "failure", title: "e2e", raw: "{}", provenance: "webhook", occurred_at: "2026-09-19T09:00:00Z" });
    const gh = fakeGithub({});
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(gh.calls.filter((c) => c.includes("/jobs")).length).toBe(0);
  });
});

describe("reconcileRepo", () => {
  it("backfills open PRs and older commits through the gate, idempotently", async () => {
    // Keyed to the pre-capture WINDOW call specifically (`&since=`) so it does not
    // also answer the per-environment-head commit fetch (`&per_page=1`, no `since`)
    // the env_heads snapshot is built from — those are separate, unmocked here.
    const gh = fakeGithub({ "/pulls?state=open": [openPr], "/pulls?state=closed": [], "/commits?sha=main&since=": [commit] });
    const firstRun = await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(firstRun).toEqual({ written: 2, unchanged: 0, failed: [] });
    const again = await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(again).toEqual({ written: 0, unchanged: 2, failed: [] });

    const rows = await all<RepoEventRow>(env.DB, `SELECT * FROM repo_events ORDER BY kind`);
    expect(rows.map((r) => [r.kind, r.provenance])).toEqual([["pr", "backfill"], ["push", "backfill"]]);
    expect(rows[0]).toMatchObject({ number: 482, state: "review", ref: "feature/usage-rollup" });
    expect(rows[1]).toMatchObject({ ref: "main", sha: "f00d", count: 1, title: "old work", actor_login: "AndresL230" });
  });

  it("sends the service token and never throws on a failing list, naming every arm that threw", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    const res = await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl }, ENVS, NOW);
    expect(res).toEqual({ written: 0, unchanged: 0, failed: ["open_prs", "closed_prs", "commits", "deployments", "runs", "env_heads", "checks", "statuses", "reviews", "branches", "drift"] });
    expect(calls.length).toBeGreaterThan(0);
    for (const init of calls) {
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer t");
    }
  });

  // Task 11 carry-over: `refreshDrift` (and now `refreshBranches`) swallow their
  // OWN errors so the webhook and cron callers never throw — but that used to
  // mean a failing drift compare inside `reconcileRepo` was invisible in
  // `failed`. Both are now split into a throwing inner function
  // (`computeDrift` / `computeBranches`) that `reconcileRepo`'s `safely` arms
  // call directly, so a failure lands in `failed` AND the previously stored
  // snapshot is left standing (never clobbered by a failed refresh).
  it("names 'drift' and 'branches' in `failed` on a later failure, without disturbing the snapshots a clean run wrote", async () => {
    const goodGh = fakeGithub({
      refsGraphql: { data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { name: "feature/x", target: { committedDate: "2026-09-19T00:00:00Z" }, compare: { aheadBy: 0, behindBy: 1 } },
      ] } } } },
      "/compare/production...main": { ahead_by: 1, behind_by: 0, commits: [{ sha: "aaa1111bbb", commit: { message: "direct push", committer: { date: "2026-09-20T09:00:00Z" } }, author: { login: "AndresL230" } }] },
    });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: goodGh.fetchImpl }, ENVS, NOW);
    const driftBefore = await getSnapshot(env.DB, "drift");
    const branchesBefore = await getSnapshot(env.DB, "branches");
    expect(driftBefore).not.toBeNull();
    expect(branchesBefore).not.toBeNull();

    // A blanket 500 (the same shape as the "never throws" test above) fails
    // every arm, drift and branches included.
    const failingFetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const res = await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: failingFetch }, ENVS, NOW);
    expect(res.failed).toEqual(expect.arrayContaining(["drift", "branches"]));
    expect(await getSnapshot(env.DB, "drift")).toEqual(driftBefore);
    expect(await getSnapshot(env.DB, "branches")).toEqual(branchesBefore);
  });

  // The subrequest budget: `reconcileRepo` shares one Cloudflare invocation (50
  // subrequests on the free plan) with runBackfill's ~13. Counted from the code:
  // 2 PR lists + 1 pre-capture commit window + 1 GraphQL deployments + 1 run
  // list + ≤5 job lookups + 2 per environment (head commit, head checks) +
  // 1 GraphQL branches refs page + 2 drift compares (ahead, then behind —
  // worst case, both sides non-empty).
  it("stays inside its share of the 50-subrequest budget", async () => {
    const runs = Array.from({ length: 7 }, (_, i) => ({
      id: 9000 + i, name: `CI ${i}`, head_branch: "main", head_sha: `sha${i}`, status: "completed",
      conclusion: "failure", run_attempt: 1, event: "push", html_url: `https://github.com/o/r/actions/runs/${9000 + i}`,
      updated_at: "2026-09-20T09:10:00Z", run_started_at: "2026-09-20T09:05:00Z", actor: { login: "AndresL230" },
    }));
    const compareCommit = { sha: "abc1234def", commit: { message: "msg", committer: { date: "2026-09-20T09:00:00Z" } }, author: { login: "AndresL230" } };
    const gh = fakeGithub({
      "/pulls?state=open": [openPr], "/pulls?state=closed": [openPr], "/commits?sha=main&since=": [commit],
      graphql: deployments(...Array.from({ length: 20 }, (_, i) => deployNode({ databaseId: 7000 + i, commitOid: `sha${i}` }))),
      "/actions/runs?": { workflow_runs: runs },
      "/jobs": { jobs: [{ name: "e2e", conclusion: "failure", steps: [] }] },
      "/commits?sha=main&per_page=1": [commit], "/commits?sha=production&per_page=1": [commit],
      "check-runs": { check_runs: [] },
      "/compare/production...main": { ahead_by: 1, behind_by: 1, commits: [compareCommit] },
      "/compare/main...production": { ahead_by: 1, behind_by: 1, commits: [compareCommit] },
    });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(gh.calls.length).toBe(19); // 5 + 5 job lookups + 2 environments × 2 + 1 status list + 1 reviews query + 1 branches refs page + 2 drift compares
  });
});

// F1: the `prs_reconciled` completeness marker. `prCaptured` in
// src/tools/repo.ts gates on this snapshot, not on "any pr row exists" — a
// lone webhook delivery must not make the Overview claim a complete open-PR
// count.
describe("reconcileRepo — the prs_reconciled completeness marker", () => {
  it("writes the marker once the open-PR list is fetched and ingested without throwing", async () => {
    const gh = fakeGithub({ "/pulls?state=open": [openPr], "/pulls?state=closed": [], "/commits?": [] });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    const marker = await getSnapshot<{ at: string }>(env.DB, "prs_reconciled");
    expect(marker).not.toBeNull();
    expect(marker!.data.at).toBe(new Date(NOW).toISOString());
  });

  it("writes the marker even for a repo with zero open PRs — a marker, not a backfill row, earns it", async () => {
    const gh = fakeGithub({ "/pulls?state=open": [], "/pulls?state=closed": [], "/commits?": [] });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(await getSnapshot(env.DB, "prs_reconciled")).not.toBeNull();
  });

  it("does NOT write the marker when the open-PR fetch itself fails", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("/pulls?state=open") ? new Response("nope", { status: 500 }) : new Response("[]", { status: 200 });
    }) as typeof fetch;
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl }, ENVS, NOW);
    expect(await getSnapshot(env.DB, "prs_reconciled")).toBeNull();
  });
});
