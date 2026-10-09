// Loading skeletons — ONE helper for every screen that waits on a read.
//
// A skeleton is the shape of the content that is coming: the same containers,
// paddings and line boxes, with muted bars where the text will be. So when the
// read lands nothing moves — the bars are replaced by words in the same boxes —
// and the swap reads as content filling in, not as the page re-rendering.
//
// Rules (docs/architecture/web-ui.md › Loading skeletons):
//   • A skeleton is for "not loaded yet" ONLY. Loaded-and-empty keeps its empty
//     state; a failed read keeps its error; a refetch keeps the content on screen.
//   • Compose screens from the primitives here — never hand-roll the markup.
//   • `skeleton(key, label, …)` is the wrapper: `aria-busy` on the region, the
//     bars `aria-hidden`, and `label` (the old "Loading…" line) kept for screen
//     readers. `key` names the region; it must be unique on the screen.
//   • Motion lives in trov.css (`.cnpy-skel`): the bars stay invisible for the
//     first 150 ms (a fast read never shows one), then fade in and pulse; all of
//     it is off under `prefers-reduced-motion`. `syncSkeletons` (called after
//     every paint) keeps that clock running across rerenders and gives the
//     content that replaces a skeleton one short fade (`.cnpy-settle`).
//
// Everything above `syncSkeletons` is pure string building (render tests run
// without a DOM).
import { surface } from "./ui";

const px = (v: number | string): string => (typeof v === "number" ? `${v}px` : v);
const sty = (extra: string): string => (extra ? `;${extra}` : "");

/** One muted bar. `w` is px or any CSS width; `h` px. */
export function skBar(w: number | string = "100%", h = 10, extra = ""): string {
  return `<span class="cnpy-sk" style="width:${px(w)};height:${h}px${sty(extra)}"></span>`;
}

/** A solid block: an avatar, a thumbnail, a chip, a button — `w` × `h`. */
export function skBox(w: number | string, h: number | string, extra = ""): string {
  return `<span class="cnpy-sk" style="width:${px(w)};height:${px(h)}${sty(extra)}"></span>`;
}

/** One line of text set at `fs`px / `lh`: reserves that line's exact box (so the
 *  real line lands in the same place) with a bar the height of its letters. */
export function skLine(w: number | string = "100%", fs = 13, lh = 1.5, extra = ""): string {
  const box = Math.round(fs * lh);
  const bar = Math.max(6, Math.round(fs * 0.72));
  return `<span class="cnpy-skl" style="height:${box}px${sty(extra)}">${skBar(w, bar)}</span>`;
}

/** A paragraph: one `skLine` per width. */
export function skLines(widths: readonly (number | string)[], fs = 13, lh = 1.5): string {
  return widths.map((w) => skLine(w, fs, lh)).join("");
}

/** A row: an optional leading block, a column of lines, an optional trailing block. */
export function skRow(o: { lead?: string; body: string; trail?: string; style?: string; gap?: number; align?: string }): string {
  return `<div class="cnpy-skrow" style="gap:${o.gap ?? 12}px;align-items:${o.align ?? "flex-start"}${sty(o.style ?? "")}">${o.lead ?? ""}<span class="cnpy-skcol">${o.body}</span>${o.trail ?? ""}</div>`;
}

/** `n` copies of a row (the index varies a width so a list does not read as a barcode). */
export function skList(n: number, row: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => row(i)).join("");
}

/** A surface card (the app's own `.cnpy-surface`) holding skeleton content. */
export function skCard(inner: string, style = "", cls = ""): string {
  return `<div${surface(style, cls ? { cls } : {})}>${inner}</div>`;
}

/** Cycle through a few widths by index. */
export const skW = (i: number, widths: readonly (number | string)[] = ["72%", "58%", "84%", "64%", "76%"]): number | string =>
  widths[i % widths.length];

/**
 * The wrapper every skeleton sits in. `key` names the region (unique per screen);
 * `label` is TRUSTED markup — the loading line a screen reader hears (and the text
 * the old "Loading…" notice showed); `style` is the wrapper's own layout.
 */
export function skeleton(key: string, label: string, inner: string, style = ""): string {
  return `<div class="cnpy-skel" data-skel="${key}" aria-busy="true"${style ? ` style="${style}"` : ""}><span class="cnpy-sr" role="status">${label}</span><div class="cnpy-skel-in" aria-hidden="true">${inner}</div></div>`;
}

// ── composites shared by several screens ─────────────────────────────────────

/** A generic list row: avatar, a title line and a meta line, a trailing stamp. */
export function skItemRow(i: number, o: { avatar?: number; pad?: string; border?: boolean; trail?: number; fs?: number } = {}): string {
  const fs = o.fs ?? 14;
  return skRow({
    lead: o.avatar ? skBox(o.avatar, o.avatar) : "",
    body: `${skLine(skW(i), fs, 1.4)}${skLine(skW(i + 2, ["38%", "46%", "30%", "42%"]), 12.5, 1.5)}`,
    trail: o.trail ? skBar(o.trail, 9, "margin-top:6px") : "",
    style: `padding:${o.pad ?? "10px 16px"}${o.border === false ? "" : ";border-top:1px solid var(--border)"}`,
  });
}

/** A region key from free text ("the org's settings" → "the-org-s-settings"). */
export const skKey = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** A settings-style list while its read is out: `n` hairline-separated rows (an optional
 *  avatar, a name over a detail line, an optional trailing control). */
export function skRows(key: string, label: string, n = 3, o: { avatar?: number; trail?: number; pad?: string } = {}): string {
  return skeleton(key, label, skList(n, (i) => skRow({
    lead: o.avatar ? skBox(o.avatar, o.avatar) : "",
    body: `${skLine(skW(i, ["38%", "52%", "30%", "46%"]), 13.5, 1.4)}${skLine(skW(i + 1, ["58%", "44%", "66%"]), 12, 1.5)}`,
    trail: o.trail ? skBox(o.trail, 28) : "",
    align: "center",
    style: `padding:${o.pad ?? "12px 0"}${i ? ";border-top:1px solid var(--border)" : ""}`,
  })));
}

/** A settings form while its read is out: `n` fields, each a label over an input's box. */
export function skForm(key: string, label: string, n = 3): string {
  return skeleton(key, label, skList(n, (i) => `<div style="margin-top:${i ? 18 : 6}px">${skLine(skW(i, [96, 132, 84]), 12, 1.5)}<div style="margin-top:6px">${skBox("min(420px,100%)", 36)}</div><div style="margin-top:6px">${skLine(skW(i, ["46%", "38%", "52%"]), 12, 1.5)}</div></div>`));
}

/** A table: `rows` rows of bars laid on `cols` (a CSS grid-template-columns), a hairline between rows. */
export function skTable(rows: number, cols: string, cells: number, o: { pad?: string; h?: number; head?: boolean } = {}): string {
  const line = (i: number, head: boolean): string =>
    `<div style="display:grid;grid-template-columns:${cols};gap:14px;align-items:center;height:${head ? 34 : o.h ?? 44}px;padding:${o.pad ?? "0 16px"}${!head && (i > 0 || o.head) ? ";border-top:1px solid var(--border)" : ""}">${
      Array.from({ length: cells }, (_, c) => skBar(head ? "44%" : skW(i + c, ["70%", "52%", "82%", "60%"]), head ? 8 : 10)).join("")}</div>`;
  return `${o.head ? line(0, true) : ""}${skList(rows, (i) => line(i, false))}`;
}

/** A page of prose: a title, a byline, then paragraphs (a doc, an artifact, a ticket body). */
export function skProse(paras = 3): string {
  const para = (i: number) => `<div style="margin-top:${i ? 18 : 0}px">${skLines(["100%", "96%", "91%", skW(i, ["62%", "48%", "74%"])], 14.5, 1.75)}</div>`;
  return skList(paras, para);
}

/** A single item's page: a title and byline (with the header's action buttons), then
 *  the body in a card — and, with `rail`, a properties column beside it. Used by the
 *  pages that open ONE thing (a handoff, a prompt, an artifact). */
export function skDetail(o: { rail?: number; paras?: number; actions?: number } = {}): string {
  const head = `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px">
      <div style="flex:1;min-width:0">${skLine("52%", 22, 1.3)}<div style="margin-top:8px">${skLine(240, 12.5, 1.5)}</div></div>
      <div style="display:flex;gap:8px;flex:none">${skList(o.actions ?? 2, (i) => skBox(i ? 96 : 118, 32))}</div>
    </div>`;
  const body = skCard(`${skBar(110, 8)}<div style="margin-top:18px">${skProse(o.paras ?? 3)}</div>`, "padding:22px 26px 26px;margin-top:24px");
  if (!o.rail) return `${head}${body}`;
  const prop = (i: number) => `<div style="display:grid;grid-template-columns:76px 1fr;gap:10px;align-items:center;height:30px">${skBar(48, 8)}${skBar(skW(i, [96, 64, 120, 80]), 10)}</div>`;
  return `${head}<div style="display:grid;grid-template-columns:minmax(0,1fr) ${o.rail}px;gap:28px;align-items:start"><div style="min-width:0">${body}</div><div style="margin-top:24px">${skBar(70, 8, "margin-bottom:12px")}${skList(5, prop)}</div></div>`;
}

// ── after-paint: keep the clock, fade the landing ────────────────────────────
// rerender() swaps <main> wholesale, so a skeleton's CSS animation would restart
// on every unrelated rerender (and its 150 ms delay with it). Each region's clock
// is kept here by `key`, and handed to the fresh DOM as a negative delay
// (`--skel-t`), exactly as the screen entrance does with `--enter-t`.
// When a region's skeleton is gone from the paint, what stands in its place (and
// after it, in the same container) gets ONE short fade (`.cnpy-settle`) — and only if the skeleton had actually been
// visible; a read that beat the 150 ms never showed one, so there is nothing to
// fade from.

/** How long a skeleton stays invisible (trov.css `.cnpy-skel-in`'s delay must match). */
export const SKEL_DELAY_MS = 150;
/** The landing fade's length (trov.css `.cnpy-settle`). */
export const SETTLE_MS = 240;

interface Seen { at: number; path: number[] }
let scopeKey = "";
const seen = new Map<string, Seen>();
let settles: { path: number[]; at: number }[] = [];

/** Child-index path from `root` down to `el` (null when `el` is not inside it). */
function pathOf(root: Element, el: Element): number[] | null {
  const path: number[] = [];
  let cur: Element | null = el;
  while (cur && cur !== root) {
    const parent: Element | null = cur.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, cur));
    cur = parent;
  }
  return cur === root ? path : null;
}

function resolve(root: Element, path: number[]): Element | null {
  let cur: Element | null = root;
  for (const i of path) { cur = cur?.children[i] ?? null; if (!cur) return null; }
  return cur;
}

/**
 * Run after every paint. `scope` names the page on screen (the route): a change of
 * page forgets every clock and pending fade, so nothing carries over to a new screen.
 */
export function syncSkeletons(mount: HTMLElement, scope: string, now: number = performance.now()): void {
  if (scope !== scopeKey) { scopeKey = scope; seen.clear(); settles = []; }
  const live = new Set<string>();
  for (const el of Array.from(mount.querySelectorAll<HTMLElement>("[data-skel]"))) {
    // A skeleton inside an `inert` region is a PICTURE of the app (the first-run backdrop, render.ts),
    // not a read in flight: it has no clock to keep and nothing will replace it. Giving it one made the
    // backdrop vanish and fade back in on every step of the guided setup (each step is a new scope).
    if (el.closest("[inert]")) continue;
    const key = el.getAttribute("data-skel") ?? "";
    live.add(key);
    const s = seen.get(key) ?? { at: now, path: [] };
    s.path = pathOf(mount, el) ?? [];
    seen.set(key, s);
    el.style.setProperty("--skel-t", `${-Math.round(now - s.at)}ms`);
  }
  const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  for (const [key, s] of Array.from(seen)) {
    if (live.has(key)) continue;
    seen.delete(key);
    if (!reduced && s.path.length && now - s.at >= SKEL_DELAY_MS) settles.push({ path: s.path, at: now });
  }
  settles = settles.filter((st) => now - st.at < SETTLE_MS);
  for (const st of settles) {
    // What now stands where the skeleton was: the element in its place and the siblings
    // after it (content often lands as several blocks — a summary line, then the rows).
    // The chrome BEFORE it (a tile's header, a box's title) was already there and stays put.
    const parent = resolve(mount, st.path.slice(0, -1));
    if (!parent) continue;
    const from = Math.min(st.path[st.path.length - 1], Math.max(0, parent.children.length - 1));
    for (const el of Array.from(parent.children).slice(from)) {
      if (!(el instanceof HTMLElement) || el.hasAttribute("data-skel")) continue;
      el.classList.add("cnpy-settle");
      el.style.setProperty("--settle-t", `${-Math.round(now - st.at)}ms`);
    }
  }
}
