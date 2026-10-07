import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { refreshBranches } from "../src/repo/github";
import { getSnapshot } from "../src/repo/store";
import type { RepoBranches } from "@shared/repo";
import { ENVS } from "./helpers/repo";

import { systemCtx } from "./helpers/tenant";
const NOW = Date.parse("2026-09-20T12:00:00Z");
const node = (name: string, date: string, aheadBy: number, behindBy: number) => ({ name, target: { committedDate: date }, compare: { aheadBy, behindBy } });

describe("refreshBranches", () => {
  it("pages refs over ghGraphql, inverts compare, flags stale, and leaves the environment branches out", async () => {
    const pages = [
      { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [node("main", "2026-09-20T09:00:00Z", 0, 0), node("feature/usage-rollup", "2026-09-20T11:36:00Z", 0, 4)] },
      { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node("spike/edge-cache", "2026-09-04T00:00:00Z", 31, 7), node("production", "2026-09-18T00:00:00Z", 5, 1)] },
    ];
    let call = 0;
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
      expect(String(u)).toBe("https://api.github.com/graphql");
      expect(JSON.parse(String(init?.body)).variables).toMatchObject({ owner: "o", name: "r", head: "main" });
      return new Response(JSON.stringify({ data: { repository: { refs: pages[call++] } } }), { status: 200 });
    }) as typeof fetch;

    await refreshBranches(systemCtx(), { token: "t", repo: "o/r", fetchImpl }, ENVS, NOW);
    const snap = (await getSnapshot<RepoBranches>(systemCtx(), "branches"))!.data;
    // P5-8: the snapshot NAMES the branch its ahead/behind were compared against,
    // so the screen never has to assume it was `main`.
    expect(snap).toMatchObject({ active: 1, stale: 1, head: "main" });
    expect(snap.rows).toEqual([
      { name: "feature/usage-rollup", at: "2026-09-20T11:36:00Z", ahead: 4, behind: 0, stale: false },
      { name: "spike/edge-cache", at: "2026-09-04T00:00:00Z", ahead: 7, behind: 31, stale: true },
    ]);
  });

  // Fix round 1, Finding 2: `rows` (and so `stale`) is newest-first, so a bare
  // `.slice(0, 3)` over the stale-and-unmerged set picked the three LEAST
  // stale — the opposite of "worth deleting". This pins the fix: the three
  // OLDEST stale-and-unmerged branches are kept, listed oldest-first (the
  // most overdue branch leads the trailing group).
  it("keeps the three OLDEST stale-and-unmerged branches, oldest first, after the fresh ones", async () => {
    const staleAhead = (name: string, date: string) => node(name, date, 0, 2); // post-invert: ahead 2, behind 0
    const pages = [{
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        node("fresh/a", "2026-09-19T00:00:00Z", 0, 1),
        staleAhead("stale/e-newest", "2026-08-25T00:00:00Z"),
        staleAhead("stale/d", "2026-08-20T00:00:00Z"),
        staleAhead("stale/c", "2026-08-15T00:00:00Z"),
        staleAhead("stale/b", "2026-08-10T00:00:00Z"),
        staleAhead("stale/a-oldest", "2026-08-01T00:00:00Z"),
      ],
    }];
    let call = 0;
    const fetchImpl = (async () => new Response(JSON.stringify({ data: { repository: { refs: pages[call++] } } }), { status: 200 })) as typeof fetch;

    await refreshBranches(systemCtx(), { token: "t", repo: "o/r", fetchImpl }, ENVS, NOW);
    const snap = (await getSnapshot<RepoBranches>(systemCtx(), "branches"))!.data;
    expect(snap).toMatchObject({ active: 1, stale: 5 });
    expect(snap.rows).toEqual([
      { name: "fresh/a", at: "2026-09-19T00:00:00Z", ahead: 1, behind: 0, stale: false },
      { name: "stale/a-oldest", at: "2026-08-01T00:00:00Z", ahead: 2, behind: 0, stale: true },
      { name: "stale/b", at: "2026-08-10T00:00:00Z", ahead: 2, behind: 0, stale: true },
      { name: "stale/c", at: "2026-08-15T00:00:00Z", ahead: 2, behind: 0, stale: true },
    ]);
  });

  // M11: the fresh slice reserved room for `Math.min(3, stale.length)` rows but
  // appended only the stale-and-UNMERGED ones, so a repo whose stale branches
  // are all merged lost a fresh row for nothing. Reserve by what is appended.
  it("fills all eight rows when the stale branches are merged and nothing trails", async () => {
    const fresh = (i: number) => node(`fresh/${i}`, new Date(NOW - i * 60_000).toISOString(), 0, 1);
    const pages = [{
      pageInfo: { hasNextPage: false, endCursor: null },
      // 9 fresh branches, plus one stale-but-MERGED branch (ahead 0 after the invert).
      nodes: [...Array.from({ length: 9 }, (_, i) => fresh(i + 1)), node("stale/merged", "2026-08-01T00:00:00Z", 4, 0)],
    }];
    let call = 0;
    const fetchImpl = (async () => new Response(JSON.stringify({ data: { repository: { refs: pages[call++] } } }), { status: 200 })) as typeof fetch;

    await refreshBranches(systemCtx(), { token: "t", repo: "o/r", fetchImpl }, ENVS, NOW);
    const snap = (await getSnapshot<RepoBranches>(systemCtx(), "branches"))!.data;
    expect(snap).toMatchObject({ active: 9, stale: 1 });
    expect(snap.rows.map((r) => r.name)).toEqual(["fresh/1", "fresh/2", "fresh/3", "fresh/4", "fresh/5", "fresh/6", "fresh/7", "fresh/8"]);
  });

  // M10: 5 pages is a ceiling, not a target — a repo past it would silently
  // report a partial branch list as if it were the whole one. Throw instead, so
  it("records the FIRST configured environment's branch as head — whatever it is called — and `main` with none configured", async () => {
    const refs = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)).variables.head as string);
      return new Response(JSON.stringify({ data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node("feature/x", "2026-09-19T00:00:00Z", 0, 1)] } } } }), { status: 200 });
    }) as typeof fetch;
    const seen: string[] = [];
    await refreshBranches(systemCtx(), { token: "t", repo: "o/r", fetchImpl: refs }, [{ ...ENVS[0], branch: "develop" }, ENVS[1]], NOW);
    expect((await getSnapshot<RepoBranches>(systemCtx(), "branches"))!.data.head).toBe("develop");
    await refreshBranches(systemCtx(), { token: "t", repo: "o/r", fetchImpl: refs }, [], NOW);
    expect((await getSnapshot<RepoBranches>(systemCtx(), "branches"))!.data.head).toBe("main");
    expect(seen).toEqual(["develop", "main"]); // the recorded head IS the one the compare was asked for
  });

  // the arm lands in reconcileRepo's `failed[]` and the last good snapshot stands.
  it("throws rather than under-reporting when the refs still have a next page after the last one", async () => {
    await refreshBranches(systemCtx(), { token: "t", repo: "o/r", fetchImpl: (async () => new Response(JSON.stringify({ data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node("feature/x", "2026-09-19T00:00:00Z", 0, 1)] } } } }), { status: 200 })) as typeof fetch }, ENVS, NOW);
    const before = await getSnapshot<RepoBranches>(systemCtx(), "branches");

    let pages = 0;
    const endless = (async () => {
      pages++;
      return new Response(JSON.stringify({ data: { repository: { refs: { pageInfo: { hasNextPage: true, endCursor: `c${pages}` }, nodes: [node(`feature/p${pages}`, "2026-09-19T00:00:00Z", 0, 1)] } } } }), { status: 200 });
    }) as typeof fetch;
    await expect(refreshBranches(systemCtx(), { token: "t", repo: "o/r", fetchImpl: endless }, ENVS, NOW)).resolves.toBeUndefined();
    expect(pages).toBe(5); // the ceiling still bounds the requests
    expect(await getSnapshot<RepoBranches>(systemCtx(), "branches")).toEqual(before);
  });

  it("keeps the previous snapshot when the refs query fails, and never throws", async () => {
    await refreshBranches(systemCtx(), { token: "t", repo: "o/r", fetchImpl: (async () => new Response(JSON.stringify({ data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node("feature/x", "2026-09-19T00:00:00Z", 0, 1)] } } } }), { status: 200 })) as typeof fetch }, ENVS, NOW);
    const before = await getSnapshot<RepoBranches>(systemCtx(), "branches");
    expect(before).not.toBeNull();

    const fetchImpl = (async () => new Response("no", { status: 500 })) as typeof fetch;
    await expect(refreshBranches(systemCtx(), { token: "t", repo: "o/r", fetchImpl }, ENVS, NOW)).resolves.toBeUndefined();
    const after = await getSnapshot<RepoBranches>(systemCtx(), "branches");
    expect(after).toEqual(before);
  });
});
