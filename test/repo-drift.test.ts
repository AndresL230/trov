import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { refreshDrift } from "../src/repo/github";
import { getSnapshot } from "../src/repo/store";
import { ingestRepoEvent } from "../src/consumer";
import type { RepoDrift } from "@shared/repo";
import { ENVS } from "./helpers/repo";

const c = (sha: string, message: string, date: string, login = "AndresL230") => ({ sha, commit: { message, committer: { date } }, author: { login } });

describe("refreshDrift", () => {
  it("groups ahead commits by squash-merge PR number, keeps direct pushes and the behind side apart", async () => {
    await ingestRepoEvent(systemCtx(), { semantic_key: "gh:prs:482:opened:x", kind: "pr", number: 482, state: "merged", title: "Batch D1 reads in usage rollup", actor_login: "lpcooper-arch", raw: "{}", provenance: "webhook", occurred_at: "2026-09-20T08:00:00Z" });
    const fetchImpl = (async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.endsWith("/compare/production...main")) return new Response(JSON.stringify({ ahead_by: 3, behind_by: 1, commits: [
        c("c91d2aeXXXX", "rollup: batch D1 reads (#482)", "2026-09-20T09:00:00Z", "lpcooper-arch"),
        c("b02f1cdXXXX", "fix window math (#482)", "2026-09-20T09:30:00Z", "lpcooper-arch"),
        c("7f92b45XXXX", "docs: note D1 batch limits", "2026-09-20T07:00:00Z"),
      ] }), { status: 200 });
      if (url.endsWith("/compare/main...production")) return new Response(JSON.stringify({ ahead_by: 1, behind_by: 3, commits: [c("2f19c3aXXXX", "hotfix: clamp digest window", "2026-09-20T06:00:00Z")] }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await refreshDrift(systemCtx(), { token: "t", repo: "o/r", fetchImpl }, ENVS);
    const snap = await getSnapshot<RepoDrift>(systemCtx(), "drift");
    expect(snap?.data).toMatchObject({ head: "main", base: "production", ahead: 3, behind: 1 });
    expect(snap?.data.groups.map((g) => [g.tag, g.kind, g.title, g.commits.length])).toEqual([
      ["#482", "pr", "Batch D1 reads in usage rollup", 2],
      ["PUSH", "push", "Direct pushes to main", 1],
      ["BEHIND", "behind", "Only on production — not yet on main", 1],
    ]);
    expect(snap?.data.groups[0].commits[0]).toEqual({ sha: "b02f1cd", msg: "fix window math (#482)", at: "2026-09-20T09:30:00Z" });
    expect(snap?.data.groups[0].meta).toBe("lpcooper-arch · 2 commits");
  });

  // F2: the PR-title lookup binds one parameter PER PR NUMBER, and GitHub's
  // compare returns up to 250 commits — past D1's 100-bound-parameter ceiling
  // the whole statement throws `too many SQL variables` and the snapshot is
  // lost. It must fan out (src/db.ts `fanOut`) like every sibling read.
  it("chunks the PR-title lookup over more than 100 squash merges in one compare", async () => {
    const numbers = Array.from({ length: 120 }, (_, i) => 100 + i);
    await ingestRepoEvent(systemCtx(), { semantic_key: "gh:prs:219:opened:x", kind: "pr", number: 219, state: "merged", title: "The hundred-and-twentieth", actor_login: "meilin", raw: "{}", provenance: "webhook", occurred_at: "2026-09-20T08:00:00Z" });
    const commits = numbers.map((n, i) => c(`sha${n}`, `change ${n} (#${n})`, new Date(Date.parse("2026-09-20T00:00:00Z") + i * 60_000).toISOString()));
    const fetchImpl = (async (u: RequestInfo | URL) => {
      if (String(u).endsWith("/compare/production...main")) return new Response(JSON.stringify({ ahead_by: commits.length, behind_by: 0, commits }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await refreshDrift(systemCtx(), { token: "t", repo: "o/r", fetchImpl }, ENVS);
    const snap = await getSnapshot<RepoDrift>(systemCtx(), "drift");
    expect(snap?.data.groups).toHaveLength(120);
    // Groups are newest PR number first, and the one PR Trov knows about
    // carries its captured title/author — proof every chunk was queried.
    expect(snap?.data.groups[0]).toMatchObject({ tag: "#219", title: "The hundred-and-twentieth", meta: "meilin · 1 commit" });
    expect(snap?.data.groups[119]).toMatchObject({ tag: "#100", title: "change 100 (#100)" });
  });

  it("keeps the previous snapshot when GitHub fails", async () => {
    const fetchImpl = (async () => new Response("no", { status: 500 })) as typeof fetch;
    await expect(refreshDrift(systemCtx(), { token: "t", repo: "o/r", fetchImpl }, ENVS)).resolves.toBeUndefined();
    expect(await getSnapshot(systemCtx(), "drift")).toBeNull();
  });

  it("keeps a PREVIOUSLY-WRITTEN snapshot standing when a later refresh fails", async () => {
    const ok = (async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.endsWith("/compare/production...main")) return new Response(JSON.stringify({ ahead_by: 1, behind_by: 0, commits: [c("aaaa111", "direct push", "2026-09-20T09:00:00Z")] }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    await refreshDrift(systemCtx(), { token: "t", repo: "o/r", fetchImpl: ok }, ENVS);
    const before = await getSnapshot<RepoDrift>(systemCtx(), "drift");
    expect(before).not.toBeNull();

    const failing = (async () => new Response("no", { status: 500 })) as typeof fetch;
    await expect(refreshDrift(systemCtx(), { token: "t", repo: "o/r", fetchImpl: failing }, ENVS)).resolves.toBeUndefined();
    expect(await getSnapshot<RepoDrift>(systemCtx(), "drift")).toEqual(before);
  });
});
