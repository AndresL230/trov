import { describe, it, expect } from "vitest";
import {
  MAX_DEPTH, RANK_STEP, treeOrder, buildTree, childrenOf, ancestorsOf, depthOf, subtreeHeight, descendantsOf,
  wouldCycle, flattenTree, planMove, applyMove, indentPx, placeAmong, type DocTreeNode,
} from "@shared/docs-tree-core";
import { placeInColumn, BOARD_RANK_STEP } from "@shared/tickets-core";

// The page tree's rules — pure, no D1. The Worker's move route and the docs pane's drop run the same
// planMove, so these cases are the contract for both.

const n = (slug: string, parent_slug: string | null, tree_rank: number | null, title = slug, space = "engineering"): DocTreeNode =>
  ({ slug, parent_slug, tree_rank, space, title });

// Engineering:
//   architecture (1024)
//     api (1024)
//       rate-limits (1024)
//       error-codes (2048)
//     data-model (2048)
//   runbooks (2048)
//     deploys (null, "Deploys")
//     on-call (null, "On-call")
//       paging (1024)
//   getting-started (null)
// Product: roadmap
const ENG: DocTreeNode[] = [
  n("architecture", null, 1024, "Architecture"),
  n("api", "architecture", 1024, "API"),
  n("rate-limits", "api", 1024, "Rate limits"),
  n("error-codes", "api", 2048, "Error codes"),
  n("data-model", "architecture", 2048, "Data model"),
  n("runbooks", null, 2048, "Runbooks"),
  n("on-call", "runbooks", null, "On-call"),
  n("deploys", "runbooks", null, "Deploys"),
  n("paging", "on-call", 1024, "Paging and escalation"),
  n("getting-started", null, null, "Getting started"),
  n("roadmap", null, 1024, "Roadmap", "product"),
];

describe("treeOrder / buildTree", () => {
  it("orders ranked pages by rank, then unranked A to Z by title, then slug", () => {
    const list = [n("c", null, null, "beta"), n("a", null, 2048), n("b", null, 1024), n("d", null, null, "Alpha"), n("e", null, null, "alpha")];
    expect([...list].sort(treeOrder).map((x) => x.slug)).toEqual(["b", "a", "d", "e", "c"]);
  });

  it("indexes children and per-space roots in tree order", () => {
    const t = buildTree(ENG);
    expect(childrenOf(t, null, "engineering").map((x) => x.slug)).toEqual(["architecture", "runbooks", "getting-started"]);
    expect(childrenOf(t, null, "product").map((x) => x.slug)).toEqual(["roadmap"]);
    expect(childrenOf(t, "runbooks", "engineering").map((x) => x.slug)).toEqual(["deploys", "on-call"]);
    expect(childrenOf(t, "deploys", "engineering")).toEqual([]);
  });

  it("puts a page with a dangling, cross-space or looping parent at its space's top level", () => {
    const t = buildTree([
      n("orphan", "gone", null),
      n("crosser", "roadmap", null),
      n("roadmap", null, 1, "Roadmap", "product"),
      n("loop-a", "loop-b", null), n("loop-b", "loop-a", null),
      n("self", "self", null),
    ]);
    expect(childrenOf(t, null, "engineering").map((x) => x.slug).sort()).toEqual(["crosser", "loop-a", "loop-b", "orphan", "self"]);
    expect(t.parentOf.get("crosser")).toBeNull();
    expect(depthOf(t, "loop-a")).toBe(0);
  });

  it("depth, ancestors, height, descendants", () => {
    const t = buildTree(ENG);
    expect(depthOf(t, "architecture")).toBe(0);
    expect(depthOf(t, "rate-limits")).toBe(2);
    expect(depthOf(t, "nope")).toBe(-1);
    expect(ancestorsOf(t, "rate-limits").map((x) => x.slug)).toEqual(["architecture", "api"]);
    expect(subtreeHeight(t, "architecture")).toBe(2);
    expect(subtreeHeight(t, "deploys")).toBe(0);
    expect(descendantsOf(t, "architecture").map((x) => x.slug)).toEqual(["api", "rate-limits", "error-codes", "data-model"]);
  });

  it("wouldCycle: the page itself or anything below it", () => {
    const t = buildTree(ENG);
    expect(wouldCycle(t, "architecture", "architecture")).toBe(true);
    expect(wouldCycle(t, "architecture", "rate-limits")).toBe(true);
    expect(wouldCycle(t, "api", "runbooks")).toBe(false);
    expect(wouldCycle(t, "api", null)).toBe(false);
  });

  it("flattens depth-first, honouring the expanded set", () => {
    const t = buildTree(ENG);
    expect(flattenTree(t, "engineering").map((r) => `${r.depth}:${r.node.slug}`)).toEqual([
      "0:architecture", "1:api", "2:rate-limits", "2:error-codes", "1:data-model",
      "0:runbooks", "1:deploys", "1:on-call", "2:paging", "0:getting-started",
    ]);
    const rows = flattenTree(t, "engineering", new Set(["runbooks"]));
    expect(rows.map((r) => r.node.slug)).toEqual(["architecture", "runbooks", "deploys", "on-call", "getting-started"]);
    expect(rows.find((r) => r.node.slug === "on-call")?.hasChildren).toBe(true);
  });
});

describe("planMove", () => {
  it("into: appends as the target's LAST child", () => {
    const p = planMove(ENG, "data-model", { kind: "into", ref: "api" });
    expect(p).toEqual({ ok: true, parent_slug: "api", tree_rank: 3072, renumber: null });
  });

  it("into an empty page gets the first step", () => {
    expect(planMove(ENG, "getting-started", { kind: "into", ref: "deploys" })).toEqual({ ok: true, parent_slug: "deploys", tree_rank: RANK_STEP, renumber: null });
  });

  it("before / after insert as a sibling of the target (the design's 'Error codes' above 'Rate limits')", () => {
    expect(planMove(ENG, "error-codes", { kind: "before", ref: "rate-limits" })).toEqual({ ok: true, parent_slug: "api", tree_rank: 0, renumber: null });
    expect(planMove(ENG, "rate-limits", { kind: "after", ref: "error-codes" })).toEqual({ ok: true, parent_slug: "api", tree_rank: 3072, renumber: null });
    expect(planMove(ENG, "paging", { kind: "after", ref: "api" })).toEqual({ ok: true, parent_slug: "architecture", tree_rank: 1536, renumber: null });
    expect(planMove(ENG, "paging", { kind: "before", ref: "data-model" })).toEqual({ ok: true, parent_slug: "architecture", tree_rank: 1536, renumber: null });
  });

  it("top: appends at the end of the space root, renumbering the visible order when a root is unranked", () => {
    const p = planMove(ENG, "paging", { kind: "top" });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.parent_slug).toBeNull();
    expect(Object.fromEntries(p.renumber!)).toEqual({ architecture: 1024, runbooks: 2048, "getting-started": 3072 });
    expect(p.tree_rank).toBe(4096);
  });

  it("renumbers unranked siblings in their visible (A to Z) order first", () => {
    const p = planMove(ENG, "getting-started", { kind: "after", ref: "deploys" });
    expect(p.ok && Object.fromEntries(p.renumber!)).toEqual({ deploys: 1024, "on-call": 2048 });
    expect(p.ok && p.tree_rank).toBe(1536);
  });

  it("a reorder among the same siblings ignores the moved page's own slot", () => {
    const nodes = [n("a", null, 1024), n("b", null, 2048), n("c", null, 3072)];
    expect(planMove(nodes, "a", { kind: "after", ref: "b" })).toEqual({ ok: true, parent_slug: null, tree_rank: 2560, renumber: null });
    expect(planMove(nodes, "c", { kind: "before", ref: "a" })).toEqual({ ok: true, parent_slug: null, tree_rank: 0, renumber: null });
    expect(planMove(nodes, "a", { kind: "top" })).toEqual({ ok: true, parent_slug: null, tree_rank: 4096, renumber: null });
  });

  it("refuses: not_found, self, other_space, cycle", () => {
    expect(planMove(ENG, "nope", { kind: "top" })).toEqual({ ok: false, reason: "not_found" });
    expect(planMove(ENG, "api", { kind: "into", ref: "nope" })).toEqual({ ok: false, reason: "not_found" });
    expect(planMove(ENG, "api", { kind: "into", ref: "api" })).toEqual({ ok: false, reason: "self" });
    expect(planMove(ENG, "api", { kind: "before", ref: "api" })).toEqual({ ok: false, reason: "self" });
    expect(planMove(ENG, "api", { kind: "into", ref: "roadmap" })).toEqual({ ok: false, reason: "other_space" });
    expect(planMove(ENG, "architecture", { kind: "into", ref: "rate-limits" })).toEqual({ ok: false, reason: "cycle" });
    expect(planMove(ENG, "architecture", { kind: "after", ref: "api" })).toEqual({ ok: false, reason: "cycle" });   // api's parent IS architecture
    expect(planMove(ENG, "architecture", { kind: "before", ref: "rate-limits" })).toEqual({ ok: false, reason: "cycle" });
  });

  it("too_deep checks the moved page's whole subtree against MAX_DEPTH", () => {
    expect(MAX_DEPTH).toBe(10);
    // a chain d0 … d9: ten levels, the limit
    const chain: DocTreeNode[] = Array.from({ length: MAX_DEPTH }, (_, i) => n(`d${i}`, i === 0 ? null : `d${i - 1}`, 1024));
    const loose = [n("leaf", null, 2048), n("pair", null, 3072), n("pair-kid", "pair", 1024)];
    const all = [...chain, ...loose];
    expect(planMove(all, "leaf", { kind: "into", ref: "d8" }).ok).toBe(true);        // depth 9: the last level
    expect(planMove(all, "leaf", { kind: "into", ref: "d9" })).toEqual({ ok: false, reason: "too_deep" });
    expect(planMove(all, "leaf", { kind: "after", ref: "d9" }).ok).toBe(true);       // a sibling of d9 is depth 9
    expect(planMove(all, "pair", { kind: "into", ref: "d7" }).ok).toBe(true);        // pair 8, kid 9
    expect(planMove(all, "pair", { kind: "into", ref: "d8" })).toEqual({ ok: false, reason: "too_deep" });
  });

  it("takes a prebuilt tree too, and applyMove writes the plan into the list", () => {
    const t = buildTree(ENG);
    const p = planMove(t, "getting-started", { kind: "after", ref: "deploys" });
    const next = applyMove(ENG, "getting-started", p);
    const t2 = buildTree(next);
    expect(childrenOf(t2, "runbooks", "engineering").map((x) => x.slug)).toEqual(["deploys", "getting-started", "on-call"]);
    expect(applyMove(ENG, "x", { ok: false, reason: "cycle" })).toEqual(ENG);
  });
});

describe("placeAmong (the shared rank math)", () => {
  it("matches placeInColumn, which now delegates to it", () => {
    expect(BOARD_RANK_STEP).toBe(RANK_STEP);
    const keys = [{ key: "a", rank: 1024 }, { key: "b", rank: 2048 }];
    expect(placeAmong(keys, "a")).toEqual({ rank: 1536, renumber: null });
    expect(placeAmong(keys, null).rank).toBe(0);
    expect(placeAmong(keys, "zz").rank).toBe(0);
    expect(placeAmong([], null)).toEqual({ rank: RANK_STEP, renumber: null });
    const k = (id: number, board_rank: number | null) => ({ id, board_rank, updated_at: "2026-09-01T00:00:00Z" });
    expect(placeInColumn([k(1, 1), k(2, 1 + 1e-9)], 1)).toEqual(placeAmong([{ key: 1, rank: 1 }, { key: 2, rank: 1 + 1e-9 }], 1));
  });

  it("renumbers in the given order when a key has no rank", () => {
    const { rank, renumber } = placeAmong([{ key: "x", rank: null }, { key: "y", rank: 5 }], "x");
    expect(Object.fromEntries(renumber!)).toEqual({ x: 1024, y: 2048 });
    expect(rank).toBe(1536);
  });
});

describe("indentPx", () => {
  it("steps 14px a level to level 4, then 9px", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(indentPx)).toEqual([0, 14, 28, 42, 56, 65, 74, 101]);
  });
});
