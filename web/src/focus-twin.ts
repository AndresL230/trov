// ── A focused button across a repaint ───────────────────────────────────────
// rerender() swaps <main> wholesale on most screens (morph.ts), so whatever had focus in it is gone. A focused FIELD
// is put back by its `data-field` (main.ts); a focused BUTTON is put back by its twin in the new page: the element
// with the same `data-act` and `data-arg`. Without it, pressing a button whose action only repaints the same screen
// (a copy button's toast) dropped focus on <body>, and the next Tab started over at the top of the page.

/** A CSS string literal for an attribute value: quotes and backslashes escaped, so no arg can break out. */
const cssString = (v: string): string => `"${v.replace(/["\\]/g, "\\$&").replace(/\n/g, "\\a ")}"`;

/** The selector of a button's twin in a freshly rendered page — its `data-act` and its `data-arg` (an act without
 *  an arg matches only a twin without one). Null when the element has no act to pair on. Pure. */
export function twinSelector(a: { act: string | null; arg: string | null }): string | null {
  if (!a.act) return null;
  const act = `[data-act=${cssString(a.act)}]`;
  return a.arg === null ? `${act}:not([data-arg])` : `${act}[data-arg=${cssString(a.arg)}]`;
}
