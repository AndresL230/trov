// Ask Trov — the diagram block (`show_diagram`): what waits on what, drawn as a real diagram.
//
// THE DATA is the server's `AskDiagram` (nodes + edges [from, to]: `to` waits on `from`); nothing here asks the server
// anything. `layoutDiagram` lays any acyclic graph out in layers (a node's layer = its longest path from a root), puts a
// dummy slot where an edge skips a layer (so a line never crosses a card), orders each layer to cut crossings
// (barycentres, two sweeps) and places each node on a lane at the mean of its neighbours (half-lane steps), so a
// branch sits as parallel lanes and a lone parent centres on its children. A cycle or a broken edge is a list.
//
// THE DRAWING (`diagramFigure`, the thread's and the inspector's bigger copy alike) is ONE set of nodes — an `<ol>` in
// topological order, so the DOM is the diagram's text equivalent — absolutely placed by three coordinate sets carried
// as custom properties, one per mode, and picked by the figure's own width (a container query, trov.css › Ask diagram):
//
//   lr    left → right: layers are columns, lanes rows; when (layers + gaps) × 112px fits (`data-l`)
//   tb    top → bottom: layers are rows, lanes columns; the default, while every lane gets ≥ 120px (`data-s`)
//   list  a vertical timeline (a rail, a dot per node) when even that can't fit; always for a cycle, and a rail-less
//         list for nodes with no edges at all (`data-shape="set"`)
//
// The connectors are one SVG per graph mode, `preserveAspectRatio="none"` over the same unit grid the nodes use (so
// they meet the cards at any width) with `vector-effect: non-scaling-stroke` (so a line stays 1.5px and crisp); every
// incoming edge meets its card at one point, under one arrowhead the card draws itself. A root (a node nothing waits
// before, when the graph has edges) is the blocker, and is emphasised. Nodes rise and the edges wipe in once, on
// insertion (a rerender keeps the elements), never under reduced motion.

import { esc, attr } from "./ui";
import type { AskView } from "./ask-state";
import { viewOf, refTypeWord, refStatusMark, repoFactsOf, repoCiMark } from "./ask-refs";
import { askIcon, REF_ICON } from "./ask-icons";
import type { AskDiagram, RefView } from "@shared/ai-ask-core";

type DNode = AskDiagram["nodes"][number];

/** The geometry (px and unit ratios) — trov.css reads the card heights from `--nh` / `--nhs`, the rest is emitted. */
export const DG = {
  /** A card's height: left → right (narrow cards, a title of up to three lines); top → bottom and the list (wide). */
  nodeH: 100, nodeHs: 84,
  /** Left → right: the gap between lanes (px), and between layers as a share of a column. */
  lrLaneGap: 14, lrGap: 0.36,
  /** Top → bottom: the gap between layers (px), and between lanes as a share of a lane. */
  tbGap: 34, tbLaneGap: 0.12,
  /** The list: the gap between rows (px). */
  listGap: 8,
  /** The widest a card grows (so a short diagram is centred, not stretched): left → right, top → bottom. */
  lrMax: 208, tbMax: 248, listMax: 560,
  /** The narrowest a card may get before the mode gives way (trov.css's container queries are these, pinned by a test):
   *  left → right needs a column this wide, top → bottom a lane this wide; below both, the list. */
  lrMin: 112, tbMin: 120,
} as const;

export interface DiagramLayout {
  /** chain: one line a → b → c; graph: any other acyclic graph; set: nodes, no edges; list: a cycle or a broken edge. */
  shape: "chain" | "graph" | "set" | "list";
  /** The nodes in topological order (the DOM's order). */
  order: DNode[];
  /** Number of layers; the widest lane position (half steps). */
  layers: number;
  span: number;
  /** Per node id: its layer and lane. */
  at: Map<string, { layer: number; lane: number }>;
  /** Per node id: the ids it waits on. */
  preds: Map<string, string[]>;
  /** The roots of a graph with edges (the blockers). */
  roots: Set<string>;
  /** Each edge as its slots from source to target (dummy slots between): layer and lane of each. */
  routes: { layer: number; lane: number }[][];
}

/** The nodes in chain order when the edges make one simple chain (a → b → c), else null (anything else). */
export function chainOrder(d: Pick<AskDiagram, "nodes" | "edges">): AskDiagram["nodes"] | null {
  if (d.nodes.length < 2 || d.edges.length !== d.nodes.length - 1) return d.nodes.length === 1 && !d.edges.length ? d.nodes : null;
  const next = new Map<string, string>();
  const into = new Set<string>();
  for (const [a, b] of d.edges) {
    if (next.has(a) || into.has(b) || a === b) return null;
    next.set(a, b);
    into.add(b);
  }
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  let at = d.nodes.find((n) => !into.has(n.id))?.id;
  const out: AskDiagram["nodes"] = [];
  while (at !== undefined && out.length <= d.nodes.length) {
    const n = byId.get(at);
    if (!n) return null;
    out.push(n);
    at = next.get(at);
  }
  return out.length === d.nodes.length ? out : null;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Lay a diagram out (see the header). Pure; the tests pin it. */
export function layoutDiagram(d: Pick<AskDiagram, "nodes" | "edges">): DiagramLayout {
  const nodes = d.nodes;
  const ids = new Set(nodes.map((n) => n.id));
  const preds = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const empty = (shape: DiagramLayout["shape"]): DiagramLayout => ({
    shape, order: nodes, layers: 1, span: Math.max(0, nodes.length - 1), preds, roots: new Set(), routes: [],
    at: new Map(nodes.map((n, i) => [n.id, { layer: 0, lane: i }])),
  });
  if (ids.size !== nodes.length) return empty("list");
  const seen = new Set<string>();
  const edges: [string, string][] = [];
  for (const [a, b] of d.edges) {
    if (!ids.has(a) || !ids.has(b) || a === b) return empty("list");
    if (seen.has(`${a}\n${b}`)) continue;
    seen.add(`${a}\n${b}`);
    edges.push([a, b]);
    preds.get(b)!.push(a);
  }
  if (!edges.length) return nodes.length > 1 ? empty("set") : { ...empty("chain"), span: 0 };

  // Kahn's order, stable by the model's order; whatever is left over sits on a cycle.
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const succs = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const [a, b] of edges) succs.get(a)!.push(b);
  const indeg = new Map(nodes.map((n) => [n.id, preds.get(n.id)!.length]));
  const ready = nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
  const topo: string[] = [];
  while (ready.length) {
    ready.sort((x, y) => index.get(x)! - index.get(y)!);
    const id = ready.shift()!;
    topo.push(id);
    for (const s of succs.get(id)!) {
      indeg.set(s, indeg.get(s)! - 1);
      if (!indeg.get(s)) ready.push(s);
    }
  }
  if (topo.length !== nodes.length) return empty("list");

  const layerOf = new Map<string, number>();
  for (const id of topo) layerOf.set(id, Math.max(-1, ...preds.get(id)!.map((p) => layerOf.get(p)!)) + 1);
  const layers = Math.max(...layerOf.values()) + 1;

  // Slots: the nodes, plus a dummy for each layer an edge skips. Each edge is a path of slot keys.
  const slotLayer = new Map<string, number>(layerOf);
  const up = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const down = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const paths: string[][] = [];
  const link = (a: string, b: string) => { down.get(a)!.push(b); up.get(b)!.push(a); };
  edges.forEach(([a, b], e) => {
    const path = [a];
    for (let l = layerOf.get(a)! + 1; l < layerOf.get(b)!; l++) {
      const k = `\u0000${e}:${l}`;
      slotLayer.set(k, l);
      up.set(k, []);
      down.set(k, []);
      link(path[path.length - 1], k);
      path.push(k);
    }
    link(path[path.length - 1], b);
    path.push(b);
    paths.push(path);
  });
  const rows: string[][] = Array.from({ length: layers }, () => []);
  for (const id of topo) rows[layerOf.get(id)!].push(id);
  for (const [k, l] of slotLayer) if (k.startsWith("\u0000")) rows[l].push(k);

  // Order within a layer: barycentres of the neighbours' indices, down then up, twice, then down once more.
  const idx = new Map<string, number>();
  const reindex = () => rows.forEach((r) => r.forEach((k, i) => idx.set(k, i)));
  reindex();
  const sweep = (l: number, by: Map<string, string[]>) => {
    const bc = new Map(rows[l].map((k) => {
      const ns = by.get(k)!;
      return [k, ns.length ? mean(ns.map((n) => idx.get(n)!)) : idx.get(k)!] as const;
    }));
    rows[l].sort((x, y) => bc.get(x)! - bc.get(y)! || idx.get(x)! - idx.get(y)!);
    rows[l].forEach((k, i) => idx.set(k, i));
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let l = 1; l < layers; l++) sweep(l, up);
    for (let l = layers - 2; l >= 0; l--) sweep(l, down);
  }
  for (let l = 1; l < layers; l++) sweep(l, up);

  // Lanes: centred at first, then each slot pulled to the mean of its neighbours (both sides; a dummy's pull counts
  // triple, so a long edge runs straight), keeping its layer's order a lane apart — the closest such positions are
  // pool-adjacent-violators on `want - index` — sweeping down and up until it settles; then half steps.
  const lane = new Map<string, number>();
  for (const r of rows) r.forEach((k, i) => lane.set(k, i - (r.length - 1) / 2));
  const place = (r: string[]) => {
    const pool: { v: number; w: number; n: number }[] = [];
    r.forEach((k, i) => {
      const ns = [...up.get(k)!, ...down.get(k)!];
      const want = ns.length ? mean(ns.map((n) => lane.get(n)!)) : lane.get(k)!;
      pool.push({ v: want - i, w: k.startsWith("\u0000") ? 3 : 1, n: 1 });
      while (pool.length > 1 && pool[pool.length - 2].v > pool[pool.length - 1].v) {
        const b = pool.pop()!, a = pool.pop()!;
        pool.push({ v: (a.v * a.w + b.v * b.w) / (a.w + b.w), w: a.w + b.w, n: a.n + b.n });
      }
    });
    let i = 0;
    for (const b of pool) for (let j = 0; j < b.n; j++, i++) lane.set(r[i], b.v + i);
  };
  for (let pass = 0; pass < 8; pass++) {
    for (let l = 0; l < layers; l++) place(rows[l]);
    for (let l = layers - 1; l >= 0; l--) place(rows[l]);
  }
  for (const [k, v] of lane) lane.set(k, Math.round(v * 2) / 2);
  const lo = Math.min(...lane.values());
  for (const [k, v] of lane) lane.set(k, v - lo);
  const span = Math.max(...lane.values());

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const at = new Map(nodes.map((n) => [n.id, { layer: layerOf.get(n.id)!, lane: lane.get(n.id)! }]));
  const chain = chainOrder(d);
  return {
    shape: chain ? "chain" : "graph",
    order: chain ?? topo.map((id) => byId.get(id)!),
    layers, span, at, preds,
    roots: new Set(nodes.filter((n) => !preds.get(n.id)!.length).map((n) => n.id)),
    routes: paths.map((p) => p.map((k) => ({ layer: slotLayer.get(k)!, lane: lane.get(k)! }))),
  };
}

// ── geometry ─────────────────────────────────────────────────────────────────

const r2 = (n: number): string => String(Math.round(n * 100) / 100);
const lrUnits = (layers: number): number => layers + (layers - 1) * DG.lrGap;
const tbUnits = (span: number): number => span * (1 + DG.tbLaneGap) + 1;

/** The connectors in one mode, as one path per edge in that mode's unit grid (x in hundredths of a column/lane). */
function edgePaths(L: DiagramLayout, mode: "lr" | "tb"): string {
  const H = DG.nodeH, Hs = DG.nodeHs;
  return L.routes.map((route) => {
    let d = "";
    route.forEach((s, i) => {
      if (mode === "lr") {
        const x0 = s.layer * (1 + DG.lrGap) * 100;
        const y = s.lane * (H + DG.lrLaneGap) + H / 2;
        if (i === 0) { d += `M${r2(x0 + 100)} ${r2(y)}`; return; }
        const p = route[i - 1];
        const px = p.layer * (1 + DG.lrGap) * 100 + 100;
        const py = p.lane * (H + DG.lrLaneGap) + H / 2;
        const g = (x0 - px) / 2;
        d += ` C${r2(px + g)} ${r2(py)} ${r2(x0 - g)} ${r2(y)} ${r2(x0)} ${r2(y)}`;
        if (i < route.length - 1) d += ` L${r2(x0 + 100)} ${r2(y)}`;   // a dummy: straight across its column
      } else {
        const x = (s.lane * (1 + DG.tbLaneGap) + 0.5) * 100;
        const y0 = s.layer * (Hs + DG.tbGap);
        if (i === 0) { d += `M${r2(x)} ${r2(y0 + Hs)}`; return; }
        const p = route[i - 1];
        const px = (p.lane * (1 + DG.tbLaneGap) + 0.5) * 100;
        const py = p.layer * (Hs + DG.tbGap) + Hs;
        const g = (y0 - py) / 2;
        d += ` C${r2(px)} ${r2(py + g)} ${r2(x)} ${r2(y0 - g)} ${r2(x)} ${r2(y0)}`;
        if (i < route.length - 1) d += ` L${r2(x)} ${r2(y0 + Hs)}`;
      }
    });
    return `<path d="${d}"></path>`;
  }).join("");
}

// ── the cards ────────────────────────────────────────────────────────────────

/** An item's state as a mark: a repository's is its CI — the head environment's checks (QA-5) — anything else its
 *  RefStatus. */
function statusOf(view: RefView | null, size: number): string {
  if (!view) return "";
  if (view.type === "repo") return repoCiMark(repoFactsOf(view), size);
  return view.status ? refStatusMark(view.status, size) : "";
}

const NUMBERED = new Set(["ticket", "pr", "handoff"]);

/** A card's kind line ("Ticket #87", "PR #176", the model's own word for a node with no item) and its title. */
export function nodeWords(n: DNode, view: RefView | null): { kind: string; title: string } {
  let kind = n.eyebrow ?? (view ? refTypeWord(view) : "");
  let title = n.label;
  if (view && view.num != null && NUMBERED.has(view.type)) {
    // A numbered item is its type and number ("Ticket #87"): the model's eyebrow there is often its state ("In
    // progress"), which the mark already says.
    const num = `#${view.num}`;
    kind = `${view.type === "pr" ? "PR" : refTypeWord(view)} ${num}`;
    title = title.replace(new RegExp(`^\\s*${num}\\b[\\s:·—-]*`), "") || title;
  }
  return { kind, title };
}

/** The diagram (see the header). A node with a ref opens its item; the inspector draws the same figure, bigger. */
export function diagramFigure(v: Pick<AskView, "look">, d: AskDiagram): string {
  const L = layoutDiagram(d);
  const H = DG.nodeH, Hs = DG.nodeHs;
  const graph = L.shape === "chain" || L.shape === "graph";
  const wu = lrUnits(L.layers);
  const wt = tbUnits(L.span);
  const lh = L.span * (H + DG.lrLaneGap) + H;
  const th = (L.layers - 1) * (Hs + DG.tbGap) + Hs;
  const sh = L.order.length * (Hs + DG.listGap) - DG.listGap;
  const labelOf = new Map(d.nodes.map((n) => [n.id, n.label]));
  const vars = [
    `--nh:${H}`, `--nhs:${Hs}`, `--lh:${lh}`, `--th:${th}`, `--sh:${sh}`,
    `--lm:${r2(wu * DG.lrMax)}`, `--tm:${r2(wt * DG.tbMax)}`, `--sm:${DG.listMax}`,
  ].join(";");

  const items = L.order.map((n, i) => {
    const view = n.view ?? (n.ref ? viewOf(v.look, n.ref) : null);
    const { kind, title } = nodeWords(n, view);
    const st = statusOf(view, 11.5);
    const p = L.at.get(n.id)!;
    const pos = [
      `--lx:${r2((p.layer * (1 + DG.lrGap)) / wu * 100)}`, `--lw:${r2(100 / wu)}`, `--ly:${r2(p.lane * (H + DG.lrLaneGap))}`,
      `--tx:${r2((p.lane * (1 + DG.tbLaneGap)) / wt * 100)}`, `--tw:${r2(100 / wt)}`, `--ty:${r2(p.layer * (Hs + DG.tbGap))}`,
      `--sy:${i * (Hs + DG.listGap)}`, `animation-delay:${graph ? p.layer * 90 : i * 50}ms`,
    ].join(";");
    const icon = view ? askIcon(REF_ICON[view.type], 12, null, 2) : "";
    const inner = `<span class="ask-dg-k">${icon}<span class="ask-dg-kw">${esc(kind)}</span></span>`
      + `<span class="ask-dg-t"${title.length > 54 ? ` data-mtip="${attr(n.label)}"` : ""}>${esc(title)}</span>`
      + (st ? `<span class="ask-dg-st">${st}</span>` : "");
    const ps = L.preds.get(n.id) ?? [];
    const waits = ps.length ? `<span class="ask-dg-sr">Waits on ${esc(ps.map((x) => labelOf.get(x) ?? x).join(", "))}.</span>` : "";
    const card = n.ref && view
      ? `<button type="button" class="ask-dg-c" data-act="askShOpen" data-arg="${attr(n.ref)}">${inner}${waits}</button>`
      : `<div class="ask-dg-c">${inner}${waits}</div>`;
    const root = graph && L.roots.has(n.id);
    return `<li class="ask-dg-n${root ? " is-root" : ""}" style="${pos}">`
      + `${ps.length && graph ? `<span class="ask-dg-ah" aria-hidden="true"></span>` : ""}<span class="ask-dg-dot" aria-hidden="true"></span>${card}</li>`;
  }).join("");

  const svg = (mode: "lr" | "tb", w: number, h: number) =>
    `<svg class="ask-dg-e ask-dg-e--${mode}" viewBox="0 0 ${r2(w * 100)} ${h}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${edgePaths(L, mode)}</svg>`;
  const edges = graph ? svg("lr", wu, lh) + svg("tb", wt, th) : "";
  const rail = L.shape === "set" ? "" : `<span class="ask-dg-rail" aria-hidden="true"></span>`;
  const aria = `${d.title}${graph ? `, ${L.order.length} steps` : ""}`;

  return `<figure class="ask-fig" data-fig="diagram" data-shape="${L.shape}">
    <figcaption class="ask-fig-cap"><span class="ask-fig-t">${esc(d.title)}</span>${d.caption ? `<span class="ask-fig-s">${esc(d.caption)}</span>` : ""}</figcaption>
    <div class="ask-dg-wrap"><div class="ask-dg" data-shape="${L.shape}" data-l="${L.layers}" data-s="${Math.round(L.span * 2)}" style="${vars}">${edges}${rail}<ol class="ask-dg-ol" aria-label="${attr(aria)}">${items}</ol></div></div>
  </figure>`;
}
