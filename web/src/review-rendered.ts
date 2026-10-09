// Review › Rendered: the proposed document as it will read once promoted, with what the proposal
// adds marked as added and what it removes shown struck.
//
// It is the Docs reader's rendering, not a second one: every piece of markdown goes through
// `renderMarkdown` (markdown.ts — marked, then DOMPurify, then the reader's code-block / table /
// doc-image pass) and sits in the reader's `.cnpy-md` styles. This module only decides WHICH
// source each call gets:
//
//   • a NEW doc (nothing live): the whole body, one call, one quiet "new document" line — tinting
//     every block of a doc that is all new says nothing;
//   • an EDIT: both bodies are cut into top-level blocks (md-blocks.ts — marked's own lexer), the
//     blocks are compared (diff.ts `diffSeq`), and each block is rendered on its own inside an
//     `<ins>` (added) or `<del>` (removed) when it changed. A table whose header stayed is compared
//     row by row and rendered as ONE table with its changed rows marked; a list item by item.
//     And where a block was EDITED rather than replaced — a paragraph or heading reworded, a table
//     row with one cell changed, a list item touched — the two renderings are merged word by word
//     (html-words.ts): one block, the new words marked and the dropped ones struck inside it.
//
// Trust boundary: a doc body is agent-proposed. Nothing here interpolates body text into the page
// — the only strings this module writes around `renderMarkdown`'s output are its own constant
// tags, and the edits it makes to that output insert constants only: a class on a table row, and
// html-words.ts's two word wrappers, which re-order sanitized tokens and never keep an old tag.

import { renderMarkdown } from "./markdown";
import { markdownBlocks, type MdBlock } from "./md-blocks";
import { diffSeq } from "./diff";
import { innersOf, mapInners, mergeInline, replaced, soleElement } from "./html-words";
import { surface } from "./ui";

type Change = "add" | "del";

export const RENDERED_NEW_NOTE = "New document. Nothing is live under this name yet: this is how it reads once promoted.";
export const RENDERED_SAME_NOTE = "Nothing changes in how this document reads: the edit is whitespace or formatting in the source only.";

/** A changed block: `<ins>` / `<del>` are block boxes here (trov.css `.cnpy-rv-blk`). `mix` is a
 *  block EDITED in place: a plain box with a rule in its margin, the words inside carry the marks. */
function mark(html: string, change: Change | "mix"): string {
  const tag = change === "add" ? "ins" : change === "del" ? "del" : "div";
  return `<${tag} class="cnpy-rv-blk" data-chg="${change}">${html}</${tag}>`;
}

/** A paragraph (or heading) reworded: ONE block, the edit marked word by word. null when the two
 *  are not the same kind of block, or share too little to be one text edited. */
function mergedBlock(o: MdBlock, n: MdBlock, oDefs: string, nDefs: string, seen: Set<Change>): string | null {
  const a = soleElement(md(o.raw, oDefs), /^(p|h[1-6])$/), b = soleElement(md(n.raw, nDefs), /^(p|h[1-6])$/);
  if (!a || !b || a.name !== b.name) return null;
  const inner = mergeInline(a.inner, b.inner);
  if (inner === null) return null;
  seen.add("add"); seen.add("del");
  return mark(`${b.before}${b.open}${inner}${b.close}${b.after}`, "mix");
}

/** Two renderings of a table row (`<td>…</td>…</tr>`), as the new row with each cell's edit marked. */
function mergedRow(oldPart: string, newPart: string): string | null {
  const was = innersOf(oldPart, "td"), now = innersOf(newPart, "td");
  if (!was || !now || was.length === 0 || was.length !== now.length) return null;
  let ok = true;
  const out = mapInners(newPart, "td", (inner, k) => {
    if (was[k] === inner) return inner;
    const cell = mergeInline(was[k], inner) ?? replaced(was[k], inner);
    if (cell === null) ok = false;
    return cell ?? inner;
  });
  return ok ? out : null;
}

/** One block (or a few source lines of one) through the reader's renderer. */
function md(source: string, defs: string): string {
  return renderMarkdown(defs ? `${source}\n\n${defs}` : source);
}

/** Two versions of a table with the same header, as ONE table: unchanged rows plain, a removed
 *  row struck, an added row tinted. null when it cannot be done safely (the header changed, or the
 *  rendered rows do not count up to the source rows) — the caller then shows both tables whole. */
function mergedTable(o: MdBlock, n: MdBlock, defs: string, seen: Set<Change>): string | null {
  if (!o.table || !n.table || o.table.head !== n.table.head) return null;
  const a = o.table.rows, b = n.table.rows;
  const rows = diffSeq(a, b).map((op) => (op.t === "add" ? { t: op.t, raw: b[op.b] } : { t: op.t, raw: a[op.a] }));
  const html = md([n.table.head, ...rows.map((r) => r.raw)].join("\n"), defs);
  const at = html.indexOf("<tbody>");
  if (at < 0) return null;
  const parts = html.slice(at).split("<tr>");
  if (parts.length - 1 !== rows.length) return null;
  for (const r of rows) if (r.t !== "ctx") seen.add(r.t);
  // Removed rows followed by added ones in the same place: a removed row and an added row that still
  // share a cell are ONE row, edited — shown once, its changed cells marked inside. (Rows that share
  // nothing stay a row removed and a row added; with as many of each, they pair off in order.)
  const edited = new Map<number, string>(), gone = new Set<number>();
  const cellsAt = (r: number) => innersOf(parts[r + 1], "td");
  for (let i = 0; i < rows.length;) {
    if (rows[i].t !== "del") { i++; continue; }
    let d = i; while (d < rows.length && rows[d].t === "del") d++;
    let e = d; while (e < rows.length && rows[e].t === "add") e++;
    for (let x = i; x < d; x++) {
      const was = cellsAt(x);
      let best = -1, score = 0;
      for (let y = d; y < e; y++) {
        if (edited.has(y)) continue;
        const now = cellsAt(y);
        const same = was && now && was.length === now.length ? was.filter((c, k) => c === now[k]).length : 0;
        if (same > score) { best = y; score = same; }
      }
      if (best < 0 && e - d === d - i && !edited.has(d + (x - i))) best = d + (x - i);
      const row = best < 0 ? null : mergedRow(parts[x + 1], parts[best + 1]);
      if (row !== null) { gone.add(x); edited.set(best, row); }
    }
    i = e;
  }
  return html.slice(0, at) + parts.map((p, i) => {
    if (i === 0) return p;
    if (gone.has(i - 1)) return "";
    const row = edited.get(i - 1);
    if (row !== undefined) return `<tr class="cnpy-rv-row-chg">${row}`;
    const t = rows[i - 1].t;
    return `${t === "ctx" ? "<tr>" : `<tr class="cnpy-rv-row-${t}">`}${p}`;
  }).join("");
}

/** A run of removed items and the run of as many added ones after it, as ONE run with each item's
 *  edit marked. null when an item has a list inside it, or any pair is not one text edited. */
function mergedItems(oldHtml: string, newHtml: string, count: number): string | null {
  const was = innersOf(oldHtml, "li"), now = innersOf(newHtml, "li");   // null for a nested list
  if (!was || !now || was.length !== count || now.length !== count) return null;
  let ok = true;
  const out = mapInners(newHtml, "li", (inner, k) => {
    const merged = mergeInline(was[k], inner);
    if (merged === null) ok = false;
    return merged ?? inner;
  });
  return ok ? out : null;
}

/** Two versions of a list, item by item: each run of unchanged / added / removed items is its own
 *  list (an ordered run starts at the number it has in the proposed doc). */
function mergedList(o: MdBlock, n: MdBlock, defs: string, seen: Set<Change>): string | null {
  if (!o.list || !n.list || o.list.ordered !== n.list.ordered) return null;
  const a = o.list.items, b = n.list.items;
  const runs: { t: "ctx" | Change; items: string[]; at: number }[] = [];
  let num = n.list.start;
  for (const op of diffSeq(a, b)) {
    const raw = op.t === "add" ? b[op.b] : a[op.a];
    const last = runs[runs.length - 1];
    if (last && last.t === op.t) last.items.push(raw);
    else runs.push({ t: op.t, items: [raw], at: num });
    if (op.t !== "del") num++;
  }
  const sep = n.list.loose ? "\n\n" : "\n";
  const html = runs.map((run) => {
    const items = [...run.items];
    // An ordered run that is in the proposed doc starts at its number there.
    if (n.list!.ordered && run.t !== "del") items[0] = items[0].replace(/^(\s*)\d+([.)])/, `$1${run.at}$2`);
    return md(items.join(sep), defs);
  });
  let out = "";
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i], after = runs[i + 1];
    if (run.t === "ctx") { out += html[i]; continue; }
    seen.add(run.t);
    // Removed items followed by as many added ones: those items edited, marked inside each.
    if (run.t === "del" && after?.t === "add" && after.items.length === run.items.length) {
      const merged = mergedItems(html[i], html[i + 1], run.items.length);
      if (merged !== null) { seen.add("add"); out += mark(merged, "mix"); i++; continue; }
    }
    out += mark(html[i], run.t);
  }
  return `<div class="cnpy-rv-list">${out}</div>`;
}

/** The blocks of an edit, in reading order, changed ones marked. */
function editBlocks(live: string, proposed: string, seen: Set<Change>): string {
  const o = markdownBlocks(live), n = markdownBlocks(proposed);
  const ops = diffSeq(o.blocks.map((b) => b.raw), n.blocks.map((b) => b.raw));
  const plain = (b: MdBlock, defs: string, change: Change) => { seen.add(change); return mark(md(b.raw, defs), change); };
  let out = "";
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.t === "ctx") { out += md(n.blocks[op.b].raw, n.defs); i++; continue; }
    // One hunk: everything between two unchanged blocks.
    const dels: MdBlock[] = [], adds: MdBlock[] = [];
    for (; i < ops.length && ops[i].t !== "ctx"; i++) {
      const x = ops[i];
      if (x.t === "del") dels.push(o.blocks[x.a]); else if (x.t === "add") adds.push(n.blocks[x.b]);
    }
    // A removed table and an added one (a list and a list) in the same hunk are the same thing, edited.
    const was = new Map<MdBlock, MdBlock>();
    // So are a removed paragraph (heading) and an added one, when they read as one text reworded.
    for (const type of ["table", "list", "paragraph", "heading"]) {
      const d = dels.filter((b) => b.type === type), a = adds.filter((b) => b.type === type);
      for (let k = 0; k < Math.min(d.length, a.length); k++) was.set(a[k], d[k]);
    }
    const merged = new Map<MdBlock, string>();
    for (const [a, d] of was) {
      const html = a.type === "table" ? mergedTable(d, a, n.defs, seen)
        : a.type === "list" ? mergedList(d, a, n.defs, seen)
        : mergedBlock(d, a, o.defs, n.defs, seen);
      if (html !== null) merged.set(a, html);
    }
    // Reading order: a merged table / list stands where it does in BOTH docs, so what was removed
    // before it stays before it and what was added after it stays after it; around those anchors,
    // a removed block comes before the added one that replaces it.
    const becomes = new Map<MdBlock, MdBlock>();
    for (const [a, d] of was) if (merged.has(a)) becomes.set(d, a);
    let next = 0;
    const addsUpTo = (end: number) => { for (; next < end; next++) out += merged.get(adds[next]) ?? plain(adds[next], n.defs, "add"); };
    for (const d of dels) {
      const a = becomes.get(d);
      if (a) addsUpTo(adds.indexOf(a) + 1);
      else out += plain(d, o.defs, "del");
    }
    addsUpTo(adds.length);
  }
  return out;
}

const SWATCH = "display:inline-block;width:8px;height:8px;margin-right:6px;vertical-align:baseline";
const NOTE = "font-size:11.5px;color:var(--fg-40)";

let memo: { key: string; html: string } | null = null;

/**
 * The Rendered view of a proposal: `proposed` as the reader will show it, marked against `live`.
 * `isNew` = nothing is live (the doc's first version): rendered whole, unmarked, under one note.
 */
export function renderedDoc(live: string, proposed: string, isNew: boolean): string {
  const key = `${isNew ? "n" : "e"}\u0000${live}\u0000${proposed}`;
  if (memo?.key === key) return memo.html;   // a repaint of the same proposal renders nothing again
  let body: string;
  let foot: string;
  if (isNew) {
    body = renderMarkdown(proposed);
    foot = "";
  } else {
    const seen = new Set<Change>();
    body = editBlocks(live, proposed, seen);
    // The legend names only what is on the page.
    const items = [
      seen.has("add") ? `<span><span class="cnpy-rv-sw" style="${SWATCH};background:var(--green)"></span>added in this proposal</span>` : "",
      seen.has("del") ? `<span><span class="cnpy-rv-sw" style="${SWATCH};background:var(--red)"></span>removed (struck)</span>` : "",
      body.includes('data-chg="mix"') || body.includes("cnpy-rv-row-chg") ? `<span><span class="cnpy-rv-sw" style="${SWATCH};background:var(--amber)"></span>edited in place</span>` : "",
    ].join("");
    foot = `<div class="cnpy-rv-legend" style="display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:22px;padding-top:14px;border-top:1px solid var(--border);${NOTE}">${items || `<span>${RENDERED_SAME_NOTE}</span>`}</div>`;
  }
  const head = isNew ? `<div class="cnpy-rv-newnote" style="${NOTE};margin-bottom:18px;padding-bottom:12px;border-bottom:1px solid var(--border)">${RENDERED_NEW_NOTE}</div>` : "";
  const html = `<div${surface("padding:24px 28px 26px")}>${head}<div class="cnpy-md cnpy-rv-md">${body}</div>${foot}</div>`;
  memo = { key, html };
  return html;
}
