/**
 * Ask Trov — the diagram block (web/src/ask-diagram.ts; docs/architecture/ask.md › Rich blocks): the layout (layers,
 * lanes, dummy slots for a skipped layer, the list for a loop), the drawing (one `<ol>` of nodes in topological order
 * with three coordinate sets, an SVG of connectors per graph mode, an arrowhead per incoming card, the root
 * emphasised, every node with an item opening it) and the CSS that picks the mode by the figure's width.
 */
import { describe, it, expect } from "vitest";
import { DG, chainOrder, diagramFigure, layoutDiagram, nodeWords } from "../web/src/ask-diagram";
import { askRefFixtures } from "@shared/ai-fixtures";
import type { AskDiagram } from "@shared/ai-ask-core";
import css from "../web/src/trov.css?raw";

const NOW = new Date("2026-10-15T12:00:00Z");
const R = askRefFixtures(NOW);
const look = { look: { views: R, persons: [] } } as unknown as Parameters<typeof diagramFigure>[0];
const n = (id: string, ref: string | null = null, label = id): AskDiagram["nodes"][number] => ({ id, label, eyebrow: null, ref, view: ref ? R[ref] : null });
const dia = (nodes: AskDiagram["nodes"], edges: [string, string][]): AskDiagram => ({ title: "What waits on what", caption: null, nodes, edges, layout: "list" });

describe("layoutDiagram — layers, lanes, slots", () => {
  it("a chain is one lane, a layer per node, in order", () => {
    const L = layoutDiagram({ nodes: [n("c"), n("a"), n("b")], edges: [["a", "b"], ["b", "c"]] });
    expect(L.shape).toBe("chain");
    expect(L.order.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(L.layers).toBe(3);
    expect(L.span).toBe(0);
    expect([...L.roots]).toEqual(["a"]);
  });

  it("a fan-out puts the children on parallel lanes and centres the parent on them", () => {
    const L = layoutDiagram({ nodes: [n("pr"), n("t14"), n("t18"), n("doc")], edges: [["pr", "t14"], ["pr", "t18"], ["t18", "doc"]] });
    expect(L.shape).toBe("graph");
    expect(L.at.get("pr")).toEqual({ layer: 0, lane: 0.5 });
    expect(L.at.get("t14")).toEqual({ layer: 1, lane: 0 });
    expect(L.at.get("t18")).toEqual({ layer: 1, lane: 1 });
    expect(L.at.get("doc")).toEqual({ layer: 2, lane: 1 });   // straight on from its parent
    expect(L.span).toBe(1);
  });

  it("an edge that skips layers routes through an empty slot of its own — never across a card", () => {
    const L = layoutDiagram({
      nodes: ["ci", "h12", "pr", "t14", "t18", "t29", "sprint"].map((id) => n(id)),
      edges: [["ci", "pr"], ["pr", "t14"], ["pr", "t18"], ["h12", "t18"], ["t14", "sprint"], ["t18", "sprint"], ["t29", "sprint"]],
    });
    expect(L.layers).toBe(4);
    const long = L.routes.find((r) => r.length === 4)!;   // t29 (layer 0) → sprint (layer 3)
    expect(long.map((s) => s.layer)).toEqual([0, 1, 2, 3]);
    const slots = L.routes.flatMap((r) => r).map((s) => `${s.layer}:${s.lane}`);
    const cards = [...L.at.values()].map((p) => `${p.layer}:${p.lane}`);
    expect(new Set(cards).size).toBe(cards.length);
    for (const r of L.routes) for (const s of r.slice(1, -1)) expect(cards).not.toContain(`${s.layer}:${s.lane}`);
    // a layer's slots are a lane apart
    for (let l = 0; l < L.layers; l++) {
      const lanes = [...new Set(slots.filter((k) => k.startsWith(`${l}:`)))].map((k) => Number(k.split(":")[1])).sort((a, b) => a - b);
      for (let i = 1; i < lanes.length; i++) expect(lanes[i] - lanes[i - 1]).toBeGreaterThanOrEqual(1);
    }
  });

  it("a loop or an edge to nowhere is a list; nodes with no edges are a set; one node is a chain", () => {
    expect(layoutDiagram({ nodes: [n("a"), n("b")], edges: [["a", "b"], ["b", "a"]] }).shape).toBe("list");
    expect(layoutDiagram({ nodes: [n("a"), n("b")], edges: [["a", "zz"]] }).shape).toBe("list");
    expect(layoutDiagram({ nodes: [n("a"), n("b")], edges: [] }).shape).toBe("set");
    expect(layoutDiagram({ nodes: [n("a")], edges: [] }).shape).toBe("chain");
    expect(chainOrder({ nodes: [n("a"), n("b"), n("c")], edges: [["a", "b"], ["a", "c"]] })).toBeNull();
  });
});

describe("diagramFigure — the drawing", () => {
  const chain = diagramFigure(look, dia([n("ci", "repo:AndresL230/trov", "netlify-connect.test"), n("pr", "pr:176", "#176 Netlify connect step"), n("t14", "ticket:14", "#14 Guided repository setup"), n("x", null, "The release")],
    [["ci", "pr"], ["pr", "t14"], ["t14", "x"]]));

  it("carries what the container queries pick a direction by: its layers and its lanes", () => {
    expect(chain).toMatch(/<div class="ask-dg" data-shape="chain" data-l="4" data-s="0" style="--nh:100;--nhs:84;/);
    const graph = diagramFigure(look, dia([n("a"), n("b"), n("c")], [["a", "b"], ["a", "c"]]));
    expect(graph).toMatch(/data-shape="graph" data-l="2" data-s="2"/);
  });

  it("draws a connector per edge in both directions, scaled with the cards and crisp (non-scaling stroke)", () => {
    for (const mode of ["lr", "tb"]) {
      const svg = chain.match(new RegExp(`<svg class="ask-dg-e ask-dg-e--${mode}"[^>]*>([\\s\\S]*?)</svg>`));
      expect(svg, mode).not.toBeNull();
      expect(svg![0]).toContain(`preserveAspectRatio="none" aria-hidden="true"`);
      expect(svg![1].match(/<path d="M[^"]+"><\/path>/g)?.length).toBe(3);
    }
    expect(css).toMatch(/\.ask-dg-e path \{ vector-effect:non-scaling-stroke; \}/);
    // an arrowhead on each card something points into, none on the root
    expect(chain.match(/class="ask-dg-ah"/g)?.length).toBe(3);
  });

  it("every node with an item opens it; one without is plain; the root is emphasised", () => {
    expect(chain).toMatch(/<button type="button" class="ask-dg-c" data-act="askShOpen" data-arg="pr:176">/);
    expect(chain).toMatch(/<button type="button" class="ask-dg-c" data-act="askShOpen" data-arg="ticket:14">/);
    expect(chain).toMatch(/<div class="ask-dg-c"><span class="ask-dg-k"><span class="ask-dg-kw"><\/span><\/span><span class="ask-dg-t">The release<\/span>/);
    expect(chain.match(/class="ask-dg-n is-root"/g)?.length).toBe(1);
    expect(chain).toMatch(/<li class="ask-dg-n is-root"[^>]*>(?:(?!<\/li>)[\s\S])*data-arg="repo:AndresL230\/trov"/);
  });

  it("has a text equivalent: an ordered list in flow order, each step saying what it waits on", () => {
    expect(chain).toContain(`<ol class="ask-dg-ol" aria-label="What waits on what, 4 steps">`);
    expect(chain).toContain(`<span class="ask-dg-sr">Waits on #176 Netlify connect step.</span>`);
    const ids = [...chain.matchAll(/data-arg="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["repo:AndresL230/trov", "pr:176", "ticket:14"]);
  });

  it("a card's kind line carries the number; the title drops the repeat", () => {
    expect(nodeWords(n("t14", "ticket:14", "#14 Guided repository setup"), R["ticket:14"])).toEqual({ kind: "Ticket #14", title: "Guided repository setup" });
    expect(nodeWords({ ...n("pr", "pr:176", "#176 Netlify connect step"), eyebrow: "Pull request" }, R["pr:176"])).toEqual({ kind: "PR #176", title: "Netlify connect step" });
    expect(nodeWords({ ...n("t", "ticket:18", "Hosting connections"), eyebrow: "In progress" }, R["ticket:18"])).toEqual({ kind: "Ticket #18", title: "Hosting connections" });
    expect(nodeWords({ ...n("c", null, "2 tsc errors"), eyebrow: "Cause" }, null)).toEqual({ kind: "Cause", title: "2 tsc errors" });
    expect(nodeWords({ ...n("s", "sprint:7", "Hosting"), eyebrow: "Sprint" }, R["sprint:7"])).toEqual({ kind: "Sprint", title: "Hosting" });
  });

  it("a loop is the list (a rail, a dot each, no connectors); a set has no rail", () => {
    const loop = diagramFigure(look, dia([n("a"), n("b")], [["a", "b"], ["b", "a"]]));
    expect(loop).toMatch(/data-shape="list"/);
    expect(loop).toContain(`<span class="ask-dg-rail" aria-hidden="true"></span>`);
    expect(loop).not.toContain("ask-dg-e--");
    const set = diagramFigure(look, dia([n("a"), n("b")], []));
    expect(set).toMatch(/data-shape="set"/);
    expect(set).not.toContain("ask-dg-rail");
  });
});

describe("the CSS — direction by width, the narrow fallback, motion, corners", () => {
  const block = css.slice(css.indexOf("/* ── Ask diagram"), css.indexOf(".ask-nf-h {"));

  it("is a size container; top → bottom by default", () => {
    expect(block).toContain(".ask-dg-wrap { container:ask-dg / inline-size; }");
    expect(block).toMatch(/\.ask-dg \{ --lr:0; --tb:1; --ls:0;/);
  });

  it("turns left → right once its layers fit at the minimum column width (one rule per layer count)", () => {
    for (let l = 2; l <= 8; l++) {
      const w = Math.round((l + (l - 1) * DG.lrGap) * DG.lrMin * 100) / 100;
      expect(block, `l=${l}`).toContain(`@container ask-dg (width >= ${w}px) { .ask-dg[data-l="${l}"] { --lr:1; --tb:0; --ls:0; } }`);
    }
    expect(block).toContain(`.ask-dg[data-l="1"] { --lr:1; --tb:0; }`);
  });

  it("falls back to the list once its lanes get narrower than the minimum lane (one rule per half-lane span)", () => {
    for (let s = 1; s <= 14; s++) {
      const w = Math.round(((s / 2) * (1 + DG.tbLaneGap) + 1) * DG.tbMin * 100) / 100;
      expect(block, `s=${s}`).toContain(`@container ask-dg (width < ${w}px) { .ask-dg[data-s="${s}"] { --tb:0; --ls:1; } }`);
    }
    // the list rules come before the left → right ones (a diagram that fits sideways is never a list)
    expect(block.indexOf(`[data-s="1"]`)).toBeLessThan(block.indexOf(`[data-l="2"] { --lr:1`));
    expect(block).toContain(`.ask-fig .ask-dg[data-shape="list"], .ask-fig .ask-dg[data-shape="set"] { --lr:0; --tb:0; --ls:1; }`);
  });

  it("nodes rise and edges wipe in once, never under reduced motion; its radii are in the corners block", () => {
    const reduce = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)", css.indexOf("/* ══ Ask Trov")));
    expect(reduce.slice(0, reduce.indexOf("\n}\n"))).toContain(".ask-dg-n, .ask-dg-e--lr, .ask-dg-e--tb { animation:none !important; }");
    expect(css).toContain("[data-cnpy-theme] .ask-dg-c { border-radius:calc(8px * var(--corner-scale)) !important; }");
    expect(css).toContain("[data-cnpy-theme] .ask-dg-dot { border-radius:50% !important; }");
  });
});

// QA-5 (the owner, 2026-10-16): a repository node is CI — the design's "CI on main" node shows the checks
// ("Failing"), never the deploy verdict ("Live").
import { repoScenario, SCENARIO_KEYS, SCENARIO_VARIANTS } from "../web/src/repo-sample";
import { askRepoFacts, type RefView } from "@shared/ai-ask-core";
import { repoCiMark, repoHeadEnv } from "../web/src/ask-refs";
import { stateMark } from "../web/src/marks";
import { VERDICT } from "../web/src/repo-verdict";

describe("QA-5: a repo node in a diagram shows its CI state", () => {
  const NOW2 = new Date("2026-10-15T12:00:00Z");
  const repoView = (facts: unknown): RefView => ({ ref: "repo:AndresL230/trov", type: "repo", title: "AndresL230/trov", status: null, href: "#repo", extra: { facts } });
  const node = (view: RefView) => diagramFigure({ look: { views: { [view.ref]: view }, persons: [] } } as unknown as Parameters<typeof diagramFigure>[0],
    dia([{ ...n("ci", view.ref, "CI on main"), view }, n("x", null, "Release")], [["ci", "x"]]));
  const all = SCENARIO_KEYS.flatMap((k) => SCENARIO_VARIANTS[k].map((v) => askRepoFacts(repoScenario(k, v, { now: NOW2.getTime() }))));
  const withState = (st: "fail" | "pass" | "running") => all.find((f) => { const h = repoHeadEnv(f); return h && f.ci.find((c) => c.env === h.key)?.state === st; });

  it("failing checks on the head: Checks failing (the red diamond), with the line in its tooltip", () => {
    const f = withState("fail");
    expect(f).toBeTruthy();
    const h = node(repoView(f));
    expect(h).toContain("Checks failing");
    expect(h).toContain(repoCiMark(f!, 11.5));
    expect(h).not.toMatch(/>(Live|Healthy)</);
  });
  it("passing and running use the same vocabulary", () => {
    for (const [st, word] of [["pass", "Checks passing"], ["running", "Checks running"]] as const) {
      const f = withState(st);
      if (f) expect(node(repoView(f))).toContain(word);
    }
  });
  it("no checks captured, or no facts: Unknown — never guessed", () => {
    expect(repoCiMark(null)).toBe(stateMark(VERDICT.unknown.word, VERDICT.unknown.tone, VERDICT.unknown.shape, 12.5, "Trov has no reading of this repository yet."));
    expect(node(repoView(null))).toContain("Unknown");
  });
});
