/**
 * Repo setups, Phase E — which files a commit and a pull request touched (0073_commit_paths), with GitHub stubbed at
 * the Response level and every row asserted in real D1:
 *   - a push's own `added / modified / removed` → exact `commit` rows, through the gate (a redelivery writes nothing);
 *   - a push the payload cut short (20 commits, or the head commit's lists missing / over the cap) → ONE compare,
 *     its files stored as the PUSH's under the head commit (`push`, `push_partial` at the compare's cap) — and no
 *     compare at all when the head commit was listed whole (its exact rows are never mixed with a push's);
 *   - PR files: ≤ 3 pages of 100, only for a repository with two or more apps, skipped when already read for the
 *     PR's head, the gate's content-hash dedupe; reconcile's `pr_files` arm open-first, inside its allowance, and
 *     never for a PR merged more than 14 days ago;
 *   - retention: 100 days.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { captureDelivery } from "../src/webhook";
import { ingestPrFiles, ingestRepoEvent } from "../src/consumer";
import { commitPathsFromPush, commitPathsFor, PUSH_PAYLOAD_COMMIT_CAP, PATHS_PER_COMMIT_CAP } from "../src/repo/commit-paths";
import { commitPathsOnPush } from "../src/repo/path-capture";
import { fetchPrFiles, prFilesOnDelivery, reconcilePrFiles, PR_FILES_PAGES, PR_FILES_REQUESTS } from "../src/repo/pr-files";
import { prFilesFor } from "../src/repo/pr-files-store";
import { pruneRepoCapture } from "../src/platform/sweeps";
import { all } from "./helpers/db";
import { ORG_A, platformCtx, systemCtx } from "./helpers/tenant";
import { seedOrgRepoConfig } from "./helpers/repo";

const REPO = "SaplingLearn/sapling";
const NOW = Date.parse("2026-10-15T12:00:00Z");
const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString();
const sha = (n: number) => n.toString(16).padStart(40, "a");
const BEFORE = sha(9999);

const commit = (n: number, files: { added?: string[]; modified?: string[]; removed?: string[] } | null) => ({
  id: sha(n), distinct: true, message: `commit ${n}`, timestamp: ago(100 - n), author: { username: "ana-r" },
  ...(files ? { added: files.added ?? [], modified: files.modified ?? [], removed: files.removed ?? [] } : {}),
});
const push = (commits: ReturnType<typeof commit>[], after = commits[commits.length - 1]?.id ?? sha(1)) => ({
  ref: "refs/heads/main", before: BEFORE, after, deleted: false, forced: false, compare: "https://x",
  repository: { pushed_at: Math.floor(NOW / 1000) }, sender: { login: "ana-r" }, commits, head_commit: commits[commits.length - 1] ?? null,
});

/** A fake api.github.com: path → body; every call recorded. */
function github(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = (async (u: RequestInfo | URL) => {
    const path = String(u).replace(`https://api.github.com/repos/${REPO}`, "");
    calls.push(path);
    return path in routes ? new Response(JSON.stringify(routes[path]), { status: 200 }) : new Response("[]", { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls, gh: async () => ({ token: "t", repo: REPO, fetchImpl }) };
}

const rows = () => all<{ sha: string; path: string; scope: string }>(env.DB, `SELECT sha, path, scope FROM commit_paths WHERE org_id = ? ORDER BY sha, path`, ORG_A);

describe("commit paths from a push", () => {
  it("stores each listed commit's own files exactly, through the gate — a redelivery writes nothing", async () => {
    const p = push([commit(1, { added: ["apps/web/a.ts"], modified: ["README.md"] }), commit(2, { removed: ["apps/api/b.ts"] })]);
    const d = commitPathsFromPush(p)!;
    expect(d.needsCompare).toBe(false);
    expect(d.headListed).toBe(true);
    const g = github({});
    const first = await commitPathsOnPush(systemCtx(ORG_A), REPO, p, g.gh);
    expect(first).toEqual({ written: 3, unchanged: 0, compared: false });
    expect(await rows()).toEqual([
      { sha: sha(1), path: "README.md", scope: "commit" }, { sha: sha(1), path: "apps/web/a.ts", scope: "commit" },
      { sha: sha(2), path: "apps/api/b.ts", scope: "commit" },
    ]);
    expect((await commitPathsOnPush(systemCtx(ORG_A), REPO, p, g.gh)).written).toBe(0);
    expect(g.calls).toEqual([]); // nothing was cut short: no compare
  });

  it("the webhook stores them on a push delivery, without changing the delivery's counts", async () => {
    const p = push([commit(1, { added: ["apps/web/a.ts"] })]);
    const res = await captureDelivery(systemCtx(ORG_A, "github-webhook"), env as unknown as Env, { repo: REPO, githubToken: async () => null }, "push", JSON.stringify(p));
    expect(((await res.json()) as { repo: unknown }).repo).toEqual({ captured: 1, unchanged: 0 });
    expect(await rows()).toEqual([{ sha: sha(1), path: "apps/web/a.ts", scope: "commit" }]);
  });

  it("a head commit whose lists were cut short → ONE compare, its files the PUSH's (marked), the listed commits still exact", async () => {
    const huge = Array.from({ length: PATHS_PER_COMMIT_CAP }, (_, i) => `apps/web/f${i}.ts`);
    const p = push([commit(1, { added: ["apps/api/x.ts"] }), commit(2, { added: huge })]);
    const d = commitPathsFromPush(p)!;
    expect(d).toMatchObject({ needsCompare: true, headListed: false });
    const g = github({ [`/compare/${BEFORE}...${sha(2)}`]: { files: [{ filename: "apps/api/x.ts" }, { filename: "apps/web/f1.ts" }] } });
    const out = await commitPathsOnPush(systemCtx(ORG_A), REPO, p, g.gh);
    expect(out.compared).toBe(true);
    expect(g.calls).toEqual([`/compare/${BEFORE}...${sha(2)}`]);
    expect(await rows()).toEqual([
      { sha: sha(1), path: "apps/api/x.ts", scope: "commit" },
      { sha: sha(2), path: "apps/api/x.ts", scope: "push" }, { sha: sha(2), path: "apps/web/f1.ts", scope: "push" },
    ]);
    // a filter reading commits never takes a push's rows as the head commit's own
    const known = await commitPathsFor(systemCtx(ORG_A), REPO, [sha(1), sha(2)]);
    expect([...known.keys()]).toEqual([sha(1)]);
    // the CI's head-commit attribution may, and sees how precise they are
    expect((await commitPathsFor(systemCtx(ORG_A), REPO, [sha(2)], true)).get(sha(2))).toMatchObject({ scope: "push" });
  });

  it("a compare at its own 300-file cap is `push_partial`; a payload of 20 commits with the head listed asks nothing", async () => {
    const p = push([commit(1, null)]);
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` }));
    const g = github({ [`/compare/${BEFORE}...${sha(1)}`]: { files } });
    await commitPathsOnPush(systemCtx(ORG_A), REPO, p, g.gh);
    expect(new Set((await rows()).map((r) => r.scope))).toEqual(new Set(["push_partial"]));

    const twenty = Array.from({ length: PUSH_PAYLOAD_COMMIT_CAP }, (_, i) => commit(100 + i, { added: [`apps/web/${i}.ts`] }));
    const d = commitPathsFromPush(push(twenty))!;
    expect(d).toMatchObject({ needsCompare: true, headListed: true }); // cut short, but the head is exact
    const g2 = github({});
    await commitPathsOnPush(systemCtx(ORG_A), REPO, push(twenty), g2.gh);
    expect(g2.calls).toEqual([]); // nothing a compare could attribute more precisely
  });

  it("a new branch's push (no `before`) never compares: its unlisted commits stay unknown", async () => {
    const p = { ...push([commit(1, null)]), before: "0".repeat(40) };
    expect(commitPathsFromPush(p)!.needsCompare).toBe(false);
    const g = github({});
    await commitPathsOnPush(systemCtx(ORG_A), REPO, p, g.gh);
    expect(g.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("is pruned after 100 days", async () => {
    await env.DB.prepare(`INSERT INTO commit_paths (org_id, repo, sha, path, scope, at) VALUES (?, ?, ?, 'old.ts', 'commit', ?), (?, ?, ?, 'new.ts', 'commit', ?)`)
      .bind(ORG_A, REPO, sha(1), ago(101 * 1440), ORG_A, REPO, sha(2), ago(10)).run();
    await ingestPrFiles(systemCtx(ORG_A), { repo: REPO, number: 7, headSha: "h", files: ["a.ts"], complete: true });
    await env.DB.prepare(`UPDATE pr_file_reads SET fetched_at = ? WHERE org_id = ?`).bind(ago(101 * 1440), ORG_A).run();
    await pruneRepoCapture(platformCtx(), NOW);
    expect((await rows()).map((r) => r.path)).toEqual(["new.ts"]);
    expect(await all(env.DB, `SELECT * FROM pr_files WHERE org_id = ?`, ORG_A)).toEqual([]);
    expect(await all(env.DB, `SELECT * FROM pr_file_reads WHERE org_id = ?`, ORG_A)).toEqual([]);
  });
});

// ── PR files ─────────────────────────────────────────────────────────────────

const page = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ filename: `apps/web/p${from + i}.ts` }));
async function twoApps(): Promise<void> {
  await seedOrgRepoConfig(env.DB, ORG_A, REPO); // the seed already has two apps (frontend, backend)
}
async function oneApp(): Promise<void> {
  await seedOrgRepoConfig(env.DB, ORG_A, REPO);
  await env.DB.prepare(`DELETE FROM repo_apps WHERE org_id = ? AND key = 'backend'`).bind(ORG_A).run();
}
const prDelivery = (number: number, action: string, headSha: string, merged = false) =>
  ({ action, pull_request: { number, merged, state: action === "closed" ? "closed" : "open", head: { sha: headSha, ref: "b" }, updated_at: ago(5), title: "t", user: { login: "ana-r" } } });
const openPr = (number: number, headSha: string, mins: number, state = "review") => ingestRepoEvent(systemCtx(ORG_A), {
  semantic_key: `gh:prs:${number}:${state}:${mins}`, kind: "pr", number, state, sha: headSha, ref: `b${number}`, title: `PR ${number}`,
  actor_login: "ana-r", raw: "{}", provenance: "webhook", occurred_at: ago(mins),
});

describe("PR files", () => {
  it("reads at most 3 pages of 100 — a short page ends it; three full pages are an incomplete list", async () => {
    const g = github({
      "/pulls/5/files?per_page=100&page=1": page(100), "/pulls/5/files?per_page=100&page=2": page(40, 100),
      "/pulls/6/files?per_page=100&page=1": page(100), "/pulls/6/files?per_page=100&page=2": page(100, 100), "/pulls/6/files?per_page=100&page=3": page(100, 200),
    });
    const opts = await g.gh();
    expect(await fetchPrFiles(opts, 5)).toMatchObject({ complete: true, requests: 2 });
    const six = await fetchPrFiles(opts, 6);
    expect(six).toMatchObject({ complete: false, requests: PR_FILES_PAGES });
    expect(six.files).toHaveLength(300);
    expect(g.calls.filter((c) => c.includes("/pulls/6/"))).toHaveLength(3); // never a 4th page
  });

  it("only for a repository with two or more apps; skipped without a request once read for the PR's head", async () => {
    await oneApp();
    const g = github({ "/pulls/9/files?per_page=100&page=1": page(2) });
    expect(await prFilesOnDelivery(systemCtx(ORG_A), g.gh, REPO, prDelivery(9, "opened", "h1"))).toBe("skipped");
    expect(g.calls).toEqual([]);

    await env.DB.prepare(`INSERT INTO repo_apps (org_id, key, repo, label, folder, kind, watch, source, position, created_at, created_by, updated_at, updated_by)
      VALUES (?, 'docs', ?, 'Docs', 'apps/docs', 'Site', '["apps/docs"]', 'manual', 2, ?, 't', ?, 't')`).bind(ORG_A, REPO, ago(0), ago(0)).run();
    expect(await prFilesOnDelivery(systemCtx(ORG_A), g.gh, REPO, prDelivery(9, "opened", "h1"))).toBe("read");
    expect((await prFilesFor(systemCtx(ORG_A), REPO, [9])).get(9)).toEqual({ headSha: "h1", complete: true, paths: ["apps/web/p0.ts", "apps/web/p1.ts"] });
    // the same head again (a redelivery, the merge): no request
    expect(await prFilesOnDelivery(systemCtx(ORG_A), g.gh, REPO, prDelivery(9, "closed", "h1", true))).toBe("skipped");
    // closed without merging: nothing to read
    expect(await prFilesOnDelivery(systemCtx(ORG_A), g.gh, REPO, prDelivery(9, "closed", "h2", false))).toBe("skipped");
    expect(g.calls).toHaveLength(1);
  });

  it("the gate: the same list again writes nothing but the head; a new list replaces the PR's rows whole", async () => {
    const ctx = systemCtx(ORG_A);
    expect((await ingestPrFiles(ctx, { repo: REPO, number: 3, headSha: "a", files: ["x", "y"], complete: true })).outcome).toBe("written");
    expect((await ingestPrFiles(ctx, { repo: REPO, number: 3, headSha: "b", files: ["y", "x"], complete: true })).outcome).toBe("unchanged");
    expect((await prFilesFor(ctx, REPO, [3])).get(3)).toEqual({ headSha: "b", complete: true, paths: ["x", "y"] });
    expect((await ingestPrFiles(ctx, { repo: REPO, number: 3, headSha: "c", files: ["z"], complete: true })).outcome).toBe("written");
    expect((await prFilesFor(ctx, REPO, [3])).get(3)?.paths).toEqual(["z"]);
  });

  it("reconcile's arm: open PRs first, then merged in 14 days, newest first, a PR started only while 3 pages fit — none merged earlier", async () => {
    await twoApps();
    for (const [n, mins] of [[11, 10], [12, 20], [13, 30], [14, 40]] as const) await openPr(n, `h${n}`, mins);
    await openPr(21, "h21", 60, "merged");
    await openPr(22, "h22", 15 * 1440, "merged"); // merged 15 days ago: never read
    const g = github({});
    const r = await reconcilePrFiles(systemCtx(ORG_A), await g.gh(), NOW, PR_FILES_REQUESTS);
    // empty file lists answer on page 1: one request each, so the allowance (9) fits all five candidates
    expect(g.calls.map((c) => c.split("/")[2])).toEqual(["11", "12", "13", "14", "21"]);
    expect(r).toMatchObject({ written: 5, requests: 5 });
    // read for their heads: a second run reads nothing
    const g2 = github({});
    expect((await reconcilePrFiles(systemCtx(ORG_A), await g2.gh(), NOW, PR_FILES_REQUESTS)).requests).toBe(0);
    expect(g2.calls).toEqual([]);
    // a moved head is read again; with every page full, 9 requests are three PRs and no more
    for (const n of [11, 12, 13, 14]) await openPr(n, `h${n}b`, 5);
    const full: Record<string, unknown> = {};
    for (const n of [11, 12, 13, 14]) for (const pg of [1, 2, 3]) full[`/pulls/${n}/files?per_page=100&page=${pg}`] = page(100);
    const g3 = github(full);
    const r3 = await reconcilePrFiles(systemCtx(ORG_A), await g3.gh(), NOW, PR_FILES_REQUESTS);
    expect(r3.requests).toBe(9);
    expect(g3.calls).toHaveLength(9);
  });

  it("nothing at all for a repository with one app", async () => {
    await oneApp();
    await openPr(11, "h11", 10);
    const g = github({});
    expect(await reconcilePrFiles(systemCtx(ORG_A), await g.gh(), NOW)).toEqual({ written: 0, unchanged: 0, requests: 0 });
    expect(g.calls).toEqual([]);
  });
});
