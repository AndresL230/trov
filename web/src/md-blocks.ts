// A markdown body cut into its top-level BLOCKS (a heading, a paragraph, a whole table, a whole
// list, a fenced code block, …) by marked's own lexer — the same parser the reader's renderer
// (markdown.ts `renderMarkdown`) runs, so a block here is exactly what renders as one element there.
//
// This is what lets Review's Rendered view compare two versions of a doc block by block and still
// hand each block to the ONE renderer. Cutting a body by LINES instead (what that view did until
// 0.26) can never render it: a table, a list or a code fence only exists across several lines.
//
// Pure: no DOM, nothing rendered, nothing sanitized here — a block's `raw` is markdown SOURCE and
// must reach the page only through `renderMarkdown`.

import { marked, type Tokens } from "marked";

export interface MdBlock {
  /** marked's token type: "heading", "paragraph", "table", "list", "code", "blockquote", "html", "hr", … */
  type: string;
  /** The block's markdown source, without the blank lines after it. */
  raw: string;
  /** A table's source lines: `head` is the header row and its `| --- |` delimiter, `rows` the body. */
  table?: { head: string; rows: string[] };
  /** A list's items as source, each with its own marker. */
  list?: { ordered: boolean; start: number; loose: boolean; items: string[] };
}

export interface MdBlocks {
  blocks: MdBlock[];
  /** The body's link reference definitions (`[id]: https://…`), to append to a block rendered alone
   *  so its `[text][id]` links still resolve. Empty when the body has none. */
  defs: string;
}

export function markdownBlocks(body: string): MdBlocks {
  const blocks: MdBlock[] = [];
  const defs: string[] = [];
  for (const tok of marked.lexer(body ?? "")) {
    if (tok.type === "space") continue;
    const raw = tok.raw.replace(/\s+$/, "");
    if (tok.type === "def") { defs.push(raw); continue; }
    const block: MdBlock = { type: tok.type, raw };
    if (tok.type === "table") {
      const lines = raw.split("\n");
      block.table = { head: lines.slice(0, 2).join("\n"), rows: lines.slice(2).map((l) => l.trim()) };
    } else if (tok.type === "list") {
      const list = tok as Tokens.List;
      block.list = { ordered: list.ordered, start: typeof list.start === "number" ? list.start : 1, loose: list.loose, items: list.items.map((it) => it.raw.replace(/\s+$/, "")) };
    }
    blocks.push(block);
  }
  return { blocks, defs: defs.join("\n") };
}
