/**
 * Repo setups, Phase E — the App menu narrows Code and CI (`getRepoDashboard(…, { app })`, src/tools/repo-scope.ts),
 * and not shipped's watch-path filter is real now that commits have paths (src/repo/facts-compute.ts). Real D1,
 * GitHub stubbed at the Response level. A two-app repository (web at apps/web, api at apps/api/**) plus a Package
 * (packages/ui, used by web — from the repo scan's workspace graph):
 *   - Code under an app: its PRs (directly, or via a Package it uses), the "touches" wire per PR, tiles over what it
 *     touches — `null` while one PR's files were never read; "Repo-wide only" = touching no app;
 *   - unknown is never guessed: a PR whose files were never read is listed under All apps only (touches: null);
 *   - CI: failures by app (the run's head commit's files, or its workflow file named by a `github` part), unknown →
 *     All apps only; the deploy strips carry their environment and host for the per-app grouping;
 *   - the App menu's open-PR counts and a Package's users in the facts;
 *   - GUARD — watch-path filtering: not shipped keeps an app's own commits, and a commit with unknown paths stays
 *     IN (counted, flagged) — never dropped.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { REPO_WIDE } from "@shared/repo-facts-core";
import type { RepoCodeStat, RepoPrList, RepoCiFailures, RepoDeployRow } from "@shared/repo";
import { getRepoDashboard } from "../src/tools/repo";
import { ingestPrFiles, ingestRepoEvent, ingestCommitPaths } from "../src/consumer";
import { putSnapshot, getSnapshot } from "../src/repo/store";
import { computeNotShipped } from "../src/repo/facts-compute";
import type { NotShippedSnapshot } from "../src/repo/facts-store";
import { ENVS, seedOrgRepoConfig } from "./helpers/repo";
import { addPart } from "./helpers/dashboard-hosting";
import { ORG_A, systemCtx } from "./helpers/tenant";

const REPO = "SaplingLearn/sapling";
const NOW = Date.parse("2026-10-15T12:00:00Z");
const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString();
const sha = (n: number) => n.toString(16).padStart(40, "c");
const data = <T>(s: { status: string; data?: T }): T => { expect(s.status).toBe("ok"); return s.data as T; };

async function seedApps(): Promise<void> {
  await seedOrgRepoConfig(env.DB, ORG_A, REPO);
  await env.DB.prepare(`UPDATE repo_apps SET folder = 'apps/web', watch = '["apps/web"]', label = 'web' WHERE org_id = ? AND key = 'frontend'`).bind(ORG_A).run();
  await env.DB.prepare(`UPDATE repo_apps SET folder = 'apps/api', watch = '["apps/api/**"]', label = 'api' WHERE org_id = ? AND key = 'backend'`).bind(ORG_A).run();
  await env.DB.prepare(`INSERT INTO repo_apps (org_id, key, repo, label, folder, kind, watch, source, position, created_at, created_by, updated_at, updated_by)
    VALUES (?, 'ui', ?, 'ui', 'packages/ui', 'Package', '["packages/ui"]', 'suggested', 2, ?, 't', ?, 't')`).bind(ORG_A, REPO, ago(0), ago(0)).run();
  await env.DB.prepare(`INSERT INTO repo_app_suggestions (org_id, repo, id, key, folder, kind, provider, evidence, parts, used_by, state, created_at)
    VALUES (?, ?, 's-ui', 'ui', 'packages/ui', 'Package', NULL, '[]', '[]', '["apps/web"]', 'accepted', ?)`).bind(ORG_A, REPO, ago(10)).run();
  for (const e of ["staging", "production"]) {
    await addPart(ORG_A, e, "frontend", "cloudflare", "web");
    await addPart(ORG_A, e, "backend", "github", "service", { workflow: ".github/workflows/deploy-api.yml" }, 1);
  }
  await putSnapshot(systemCtx(ORG_A), "prs_reconciled", { at: ago(1) }, ago(1));
}

const pr = (number: number, state: string, mins: number, headSha = `h${number}`) => ingestRepoEvent(systemCtx(ORG_A), {
  semantic_key: `gh:prs:${number}:${state}`, kind: "pr", number, state, sha: headSha, ref: `b${number}`, title: `PR ${number}`,
  actor_login: "ana-r", raw: "{}", provenance: "webhook", occurred_at: ago(mins),
});
const files = (number: number, paths: string[], complete = true) =>
  ingestPrFiles(systemCtx(ORG_A), { repo: REPO, number, headSha: `h${number}`, files: paths, complete });

/** 1 web · 2 api · 3 only packages/ui (web uses it) · 4 never read · 5 README only · 6 web and api */
async function seedPrs(): Promise<void> {
  for (const [n, m] of [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 60]] as const) await pr(n, "review", m);
  await files(1, ["apps/web/a.ts"]);
  await files(2, ["apps/api/b.ts"]);
  await files(3, ["packages/ui/button.tsx"]);
  await files(5, ["README.md"]);
  await files(6, ["apps/web/c.ts", "apps/api/d.ts"]);
}

const dash = (app: string | null) => getRepoDashboard(systemCtx(ORG_A), REPO, NOW, ENVS, undefined, { app });
const nums = (l: RepoPrList) => l.rows.map((r) => r.number).sort((a, b) => a - b);

describe("Code under the App menu", () => {
  it("All apps: every PR says which apps it touches — a PR never read says nothing (null)", async () => {
    await seedApps(); await seedPrs();
    const list = data((await dash(null)).prs);
    expect(nums(list)).toEqual([1, 2, 3, 4, 5, 6]);
    const by = Object.fromEntries(list.rows.map((r) => [r.number, { touches: r.touches, packages: r.packages }]));
    expect(by[1]).toEqual({ touches: ["frontend"], packages: [] });
    expect(by[3]).toEqual({ touches: [], packages: ["ui"] });
    expect(by[4]).toEqual({ touches: null, packages: [] });
    expect(by[5]).toEqual({ touches: [], packages: [] });
    expect(by[6]).toEqual({ touches: ["frontend", "backend"], packages: [] });
  });

  it("one app: its PRs — directly or via a Package it uses — never the unread one; its Open PRs tile unknown while one is unread", async () => {
    await seedApps(); await seedPrs();
    const web = await dash("frontend");
    expect(nums(data(web.prs))).toEqual([1, 3, 6]);
    expect(nums(data((await dash("backend")).prs))).toEqual([2, 6]);
    const tiles = data(web.codeStats);
    expect(tiles[0]).toEqual<RepoCodeStat>({ label: "Open PRs", value: null, sub: "1 pull request not read yet", tone: "neutral" });
    expect(data(web.prs).openCount).toBeNull();
    // the App menu's counts are unknown too, until #4 is read
    expect(web.facts!.allApps.map((a) => [a.key, a.openPrs])).toEqual([["frontend", null], ["backend", null], ["ui", null]]);
    expect(web.facts!.allApps.find((a) => a.key === "ui")!.usedBy).toEqual(["frontend"]);

    await files(4, ["apps/api/e.ts"]);
    const again = await dash("frontend");
    expect(data(again.codeStats)[0]).toEqual<RepoCodeStat>({ label: "Open PRs", value: 3, sub: "3 awaiting review", tone: "neutral" });
    expect(again.facts!.allApps.map((a) => [a.key, a.openPrs])).toEqual([["frontend", 3], ["backend", 3], ["ui", 1]]);
  });

  it("Repo-wide only: the PRs that touch no app and no package", async () => {
    await seedApps(); await seedPrs();
    expect(nums(data((await dash(REPO_WIDE)).prs))).toEqual([5]);
  });

  it("a PR list cut at its page cap counts where it hits, and is unknown where it does not", async () => {
    await seedApps();
    await pr(8, "review", 5);
    await files(8, ["apps/web/x.ts"], false);
    expect(nums(data((await dash("frontend")).prs))).toEqual([8]);
    expect(data((await dash("backend")).codeStats)[0].value).toBeNull(); // might touch api in the files not read
    expect(nums(data((await dash(REPO_WIDE)).prs))).toEqual([]);
  });

  it("commits: the week's commits touching the app from their own files; one with paths unknown makes the figure unknown", async () => {
    await seedApps();
    const push = (after: string, commits: { id: string; author: string }[], mins: number) => ingestRepoEvent(systemCtx(ORG_A), {
      semantic_key: `gh:push:${after}:main`, kind: "push", ref: "main", sha: after, count: commits.length, actor_login: "ana-r",
      raw: JSON.stringify({ before: null, forced: false, commits: commits.map((c) => ({ ...c, distinct: true, subject: "s", at: ago(mins) })) }),
      provenance: "webhook", occurred_at: ago(mins),
    });
    await push(sha(2), [{ id: sha(1), author: "ana-r" }, { id: sha(2), author: "kenji-m" }], 60);
    await ingestCommitPaths(systemCtx(ORG_A), REPO, [
      { sha: sha(1), path: "apps/web/a.ts", scope: "commit", at: ago(61) }, { sha: sha(2), path: "apps/api/b.ts", scope: "commit", at: ago(60) },
    ]);
    const web = data((await dash("frontend")).codeStats);
    expect(web.find((t) => t.label === "Commits this week")).toMatchObject({ value: 1 });
    expect(web.find((t) => t.label === "Contributors")).toMatchObject({ value: 1 });
    const bars = data((await dash("frontend")).bars);
    expect(bars.note).toBe("1 commit · touching web");
    // a commit nobody has the files of
    await push(sha(3), [{ id: sha(3), author: "tom-h" }], 30);
    const after = data((await dash("frontend")).codeStats).find((t) => t.label === "Commits this week")!;
    expect(after).toMatchObject({ value: null, sub: "1 commit with paths unknown" });
    expect(data((await dash("frontend")).bars).note).toBe("1 commit · touching web · 1 with paths unknown");
  });
});

describe("CI under the App menu", () => {
  const run = (n: number, headSha: string | null, state: string, mins: number, path = ".github/workflows/ci.yml") => ingestRepoEvent(systemCtx(ORG_A), {
    semantic_key: `gh:run:${n}:1`, kind: "run", number: n, name: path.split("/").pop()!, ref: "main", sha: headSha, state,
    url: `https://github.com/x/actions/runs/${n}`, raw: JSON.stringify({ event: "push", started_at: ago(mins), path }), provenance: "webhook", occurred_at: ago(mins),
  });

  it("failures by app: by the head commit's files or the workflow a part names; unknown → All apps only", async () => {
    await seedApps();
    await ingestCommitPaths(systemCtx(ORG_A), REPO, [{ sha: sha(10), path: "apps/web/a.ts", scope: "commit", at: ago(30) }]);
    await ingestCommitPaths(systemCtx(ORG_A), REPO, [{ sha: sha(11), path: "apps/api/b.ts", scope: "push", at: ago(20) }]);
    await run(1, sha(10), "failure", 30);              // web, exactly
    await run(2, sha(11), "failure", 20);              // api, from its push's files (approx)
    await run(3, sha(12), "failure", 10);              // unknown head commit
    await run(4, null, "timed_out", 5, ".github/workflows/deploy-api.yml"); // named by the api part's workflow

    const all = data((await dash(null)).ciFailures) as RepoCiFailures;
    expect(all.total).toBe(4);
    expect(all.rows.map((r) => [r.url.split("/").pop(), r.apps, r.approx ?? false])).toEqual([
      ["4", ["backend"], false], ["3", null, false], ["2", ["backend"], true], ["1", ["frontend"], false],
    ]);
    const web = data((await dash("frontend")).ciFailures);
    expect(web.rows.map((r) => r.url.split("/").pop())).toEqual(["1"]);
    expect(web.total).toBe(1);
    const api = data((await dash("backend")).ciFailures);
    expect(api.rows.map((r) => r.url.split("/").pop())).toEqual(["4", "2"]);
    expect(data((await dash(REPO_WIDE)).ciFailures).rows).toEqual([]);
  });

  it("the deploy strips carry their environment and host (grouped per app on screen); narrowed, that app's only", async () => {
    await seedApps();
    await env.DB.prepare(`INSERT INTO hosting_deploys (org_id, env, part, provider, deploy_id, state, target, sha, created_at, ready_at, recorded_at, updated_at, sha_source)
      VALUES (?, 'production', 'frontend', 'cloudflare', 'd1', 'ready', 'production', 'abc1234', ?, ?, ?, ?, 'provider')`).bind(ORG_A, ago(60), ago(60), ago(60), ago(60)).run();
    const rows = data((await dash(null)).deploys) as RepoDeployRow[];
    expect(rows).toEqual([expect.objectContaining({ env: "production", part: "frontend", envLabel: "production", host: "Cloudflare Workers" })]);
    expect((await dash("backend")).deploys.status).not.toBe("ok");
  });
});

// ── GUARD: watch-path filtering ──────────────────────────────────────────────

describe("not shipped — the watch-path filter (GUARD)", () => {
  const c = (s: string, message: string, mins: number) => ({ sha: s, commit: { message, committer: { date: ago(mins) } }, author: { login: "ana-r" } });
  const SERV = "f0f0f0f0f0f0";
  it("keeps an app's own commits; a commit with unknown paths stays in, counted and flagged — never dropped", async () => {
    await seedApps();
    await env.DB.prepare(`INSERT INTO hosting_deploys (org_id, env, part, provider, deploy_id, state, target, sha, created_at, ready_at, recorded_at, updated_at, sha_source)
      VALUES (?, 'staging', 'frontend', 'cloudflare', 'd1', 'ready', 'production', ?, ?, ?, ?, ?, 'provider')`).bind(ORG_A, SERV, ago(600), ago(600), ago(600), ago(600)).run();
    await ingestCommitPaths(systemCtx(ORG_A), REPO, [
      { sha: sha(21), path: "apps/web/checkout.ts", scope: "commit", at: ago(300) },
      { sha: sha(22), path: "apps/api/limit.ts", scope: "commit", at: ago(200) },
    ]);
    const routes: Record<string, unknown> = {
      [`/compare/${SERV}...main`]: { ahead_by: 3, behind_by: 0, commits: [c(sha(21), "web: checkout (#41)", 300), c(sha(22), "api: limit (#42)", 200), c(sha(23), "tweak", 100)] },
    };
    const fetchImpl = (async (u: RequestInfo | URL) => {
      const path = String(u).replace(`https://api.github.com/repos/${REPO}`, "");
      return new Response(JSON.stringify(routes[path] ?? []), { status: path in routes ? 200 : 404 });
    }) as typeof fetch;
    await computeNotShipped(systemCtx(ORG_A), { token: "t", repo: REPO, fetchImpl }, [ENVS[0]], { left: 6 }, NOW);
    const e = (await getSnapshot<NotShippedSnapshot>(systemCtx(ORG_A), "not_shipped"))!.data.parts["staging/frontend"];
    // web's own commit and the unknown one; api's commit filtered out
    expect(e.count).toBe(2);
    expect(e.groups.map((g) => [g.kind, g.pr, g.commits.map((x) => x.sha), g.pathsUnknown ?? 0])).toEqual([
      ["pr", 41, [sha(21).slice(0, 7)], 0],
      ["direct", null, [sha(23).slice(0, 7)], 1],
    ]);
    expect(e.unknown).toEqual([sha(23)]);
    // once the unknown commit has paths, the next run computes the part again (no head change needed) and drops it
    await ingestCommitPaths(systemCtx(ORG_A), REPO, [{ sha: sha(23), path: "apps/api/x.ts", scope: "commit", at: ago(100) }]);
    await computeNotShipped(systemCtx(ORG_A), { token: "t", repo: REPO, fetchImpl }, [ENVS[0]], { left: 6 }, NOW + 1);
    const again = (await getSnapshot<NotShippedSnapshot>(systemCtx(ORG_A), "not_shipped"))!.data.parts["staging/frontend"];
    expect(again.count).toBe(1);
    expect(again.unknown).toBeUndefined();
  });
});
