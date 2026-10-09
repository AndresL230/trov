// Two renderings of the SAME block (a paragraph, a heading, a list item, a table cell), merged into
// one: the new rendering, with the words it adds wrapped in `<ins>` and the words it drops put back,
// struck, in a `<del>`. This is what lets Review's Rendered view (review-rendered.ts) show an edit
// INSIDE a block — "admins" struck and "CI only" marked in the one cell that changed — instead of
// the whole old block followed by the whole new one.
//
// Trust boundary. Both inputs are `renderMarkdown` OUTPUT (already sanitized), and this module must
// not turn inert markup into live markup. Two rules hold that:
//
//   1. A TAG IS ONE TOKEN, quoted attribute values and all. The tokenizer reads `<a title="a > b">`
//      as one tag — a `>` inside a quoted value does not end it. (Cut there, and a wrapper written
//      "between tokens" would land INSIDE the attribute: its own quotes would close the value and
//      let the rest of that value be parsed as elements.) Anything the tokenizer cannot account for
//      — a `<` that opens nothing, a tag that never closes — and the merge is refused (null): the
//      caller shows the two renderings whole.
//   2. Only TEXT tokens are wrapped, in two constant wrappers; every tag kept is a tag of the NEW
//      rendering, in its own order; no tag of the old rendering is kept. So the result is the new
//      rendering plus struck text between its tags: `withoutMarks(merged) === newHtml`.
//
// Pure: no DOM.

import { diffSeq } from "./diff";

export const INS_OPEN = `<ins class="cnpy-rv-w">`;
export const DEL_OPEN = `<del class="cnpy-rv-w">`;

/** A comment, a whole tag (quoted attribute values included), a word, or a run of whitespace. */
const TOKEN = /<!--[\s\S]*?-->|<\/?[A-Za-z](?:[^>"']|"[^"]*"|'[^']*')*>|[^\s<]+|\s+/g;
const isMarkup = (t: string): boolean => t.charCodeAt(0) === 60; // "<"
const isComment = (t: string): boolean => t.startsWith("<!--");
const blank = (t: string): boolean => t.trim() === "";

/** `html` as tokens — or null when they do not add back up to it (a stray `<`, an unclosed tag). */
export function htmlTokens(html: string): string[] | null {
  const toks = html.match(TOKEN) ?? [];
  return toks.join("") === html ? toks : null;
}

const tagName = (t: string): string => /^<\/?([A-Za-z][A-Za-z0-9]*)/.exec(t)?.[1].toLowerCase() ?? "";
const isOpen = (t: string, name: string): boolean => isMarkup(t) && !isComment(t) && t[1] !== "/" && tagName(t) === name;
const isClose = (t: string, name: string): boolean => t.startsWith("</") && tagName(t) === name;

/** More than this share of the words changed: the two are not one sentence edited but two different
 *  ones, and a word-by-word merge of unrelated text is noise. The caller shows both whole. */
const TOO_DIFFERENT = 0.6;

/**
 * `newHtml` with what it adds marked and what `oldHtml` had and it does not put back, struck.
 * null when either cannot be tokenized safely, or the two share too little to be one text edited.
 */
export function mergeInline(oldHtml: string, newHtml: string): string | null {
  if (oldHtml === newHtml) return newHtml;
  const a = htmlTokens(oldHtml), b = htmlTokens(newHtml);
  if (!a || !b) return null;
  const ops = diffSeq(a, b);
  let kept = 0, changed = 0;
  for (const op of ops) {
    const tok = op.t === "add" ? b[op.b] : a[op.a];
    if (isMarkup(tok) || blank(tok)) continue;
    if (op.t === "ctx") kept++; else changed++;
  }
  if (kept === 0 || (kept < 2 && changed > 1) || changed / (kept * 2 + changed) > TOO_DIFFERENT) return null;
  let out = "";
  let open: "ins" | "del" | null = null;
  const close = () => { if (open) { out += `</${open}>`; open = null; } };
  const text = (kind: "ins" | "del", tok: string) => {
    if (open !== kind) { close(); out += kind === "ins" ? INS_OPEN : DEL_OPEN; open = kind; }
    out += tok;
  };
  for (const op of ops) {
    if (op.t === "ctx") { close(); out += b[op.b]; continue; }
    if (op.t === "add") {
      const tok = b[op.b];
      if (isMarkup(tok)) { close(); out += tok; } else text("ins", tok);
      continue;
    }
    const tok = a[op.a];
    if (!isMarkup(tok)) text("del", tok);   // an old TAG is dropped: the structure is the new rendering's
  }
  close();
  // "added words" read as one mark, not a mark per word: the unchanged space between two added
  // words moves inside. (Not done for struck text: that space is the new rendering's and stays.)
  return out.replace(/<\/ins>(\s+)<ins class="cnpy-rv-w">/g, "$1");
}

/** `mergeInline`'s result with the marks taken back out: struck text removed, added text unwrapped. */
export function withoutMarks(merged: string): string {
  return merged.replace(/<del class="cnpy-rv-w">[^<]*<\/del>/g, "").replace(/<ins class="cnpy-rv-w">/g, "").replace(/<\/ins>/g, "");
}

/** The top-level `<name>…</name>` elements of a fragment: for each, the token range of what is
 *  inside it. null when the fragment cannot be tokenized or its `name` tags do not pair up flat. */
function spans(toks: string[], name: string): [number, number][] | null {
  const out: [number, number][] = [];
  let from = -1;
  for (let i = 0; i < toks.length; i++) {
    if (isOpen(toks[i], name)) { if (from >= 0) return null; from = i + 1; }
    else if (isClose(toks[i], name)) { if (from < 0) return null; out.push([from, i]); from = -1; }
  }
  return from < 0 ? out : null;
}

/** What is inside each `<name>` element of `html`, in order (`td` of a row, `li` of a flat list). */
export function innersOf(html: string, name: string): string[] | null {
  const toks = htmlTokens(html);
  const at = toks && spans(toks, name);
  return toks && at ? at.map(([s, e]) => toks.slice(s, e).join("")) : null;
}

/** `html` with the inside of its k-th `<name>` element replaced by `fn(inside, k)`. */
export function mapInners(html: string, name: string, fn: (inner: string, k: number) => string): string | null {
  const toks = htmlTokens(html);
  const at = toks && spans(toks, name);
  if (!toks || !at) return null;
  let out = "", pos = 0;
  at.forEach(([s, e], k) => { out += toks.slice(pos, s).join("") + fn(toks.slice(s, e).join(""), k); pos = e; });
  return out + toks.slice(pos).join("");
}

/** A whole inline content replaced by another (two unrelated texts): the old struck, then the new
 *  marked. null unless both tokenize, so a wrapper can never be written into a broken tag. */
export function replaced(oldInner: string, newInner: string): string | null {
  const a = htmlTokens(oldInner), b = htmlTokens(newInner);
  if (!a || !b) return null;
  const wrap = (toks: string[], open: string, end: string) => {
    let out = "", on = false;
    for (const t of toks) {
      if (isMarkup(t)) { if (on) { out += end; on = false; } if (open === INS_OPEN) out += t; continue; }   // old tags are dropped
      if (!on) { out += open; on = true; }
      out += t;
    }
    return on ? out + end : out;
  };
  const was = wrap(a, DEL_OPEN, "</del>");
  return `${was}${was && !/\s$/.test(was) ? " " : ""}${wrap(b, INS_OPEN, "</ins>")}`;
}

/** One rendered element standing alone (around it only whitespace and comments): `names` says which
 *  elements count. Its opening tag, what is inside, its closing tag, and what stood around it. */
export function soleElement(html: string, names: RegExp): { before: string; open: string; inner: string; close: string; after: string; name: string } | null {
  const toks = htmlTokens(html);
  if (!toks) return null;
  let s = 0, e = toks.length - 1;
  while (s <= e && (blank(toks[s]) || isComment(toks[s]))) s++;
  while (e >= s && (blank(toks[e]) || isComment(toks[e]))) e--;
  if (e <= s) return null;
  const name = tagName(toks[s]);
  if (!names.test(name) || !isOpen(toks[s], name) || !isClose(toks[e], name)) return null;
  for (let i = s + 1; i < e; i++) if (isOpen(toks[i], name) || isClose(toks[i], name)) return null;
  return { before: toks.slice(0, s).join(""), open: toks[s], inner: toks.slice(s + 1, e).join(""), close: toks[e], after: toks.slice(e + 1).join(""), name };
}
