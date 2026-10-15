// The words the Phase C card jobs send to Jev and the EVIDENCE their suggestions carry (docs/architecture/ai.md ›
// The kinds). Pure: no D1, no network. Jev writes no text, so a suggestion's reason is never the model's — it is
// built here from the item's OWN words (a window around a word that matched, a phrase two items share, a field the
// agent sent), the pattern Sift already uses (`evidenceOf`, src/tools/tag-fit.ts).
import { excerptOf } from "../../tools/tag-fit";

export { excerptOf };

/** Words that carry no meaning for matching two texts. */
const STOP = new Set([
  "a", "an", "and", "or", "the", "of", "for", "to", "in", "on", "with", "what", "how", "is", "are", "it", "its", "by", "from", "at", "as",
  "be", "that", "this", "when", "then", "than", "into", "can", "not", "but", "has", "have", "was", "were", "will", "would", "should", "could",
  "there", "their", "they", "them", "these", "those", "which", "who", "one", "all", "any", "each", "also", "just", "only", "more", "most",
  "use", "uses", "used", "using", "get", "gets", "via", "per", "out", "now", "new", "our", "your", "you", "we", "i", "so", "if", "do", "does",
]);

/** The meaningful words of a text, lowercased, in order, without repeats. */
export function significantWords(text: string, min = 3): string[] {
  const words = excerptOf(text, 4000).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => w.length >= min && !STOP.has(w) && !/^\d+$/.test(w)))];
}

/** A safe FTS5 MATCH expression: up to `max` of the text's meaningful words, each quoted (so nothing in the text is
 *  ever FTS syntax), ANY of them. null when nothing is left. */
export function anyWordsMatch(text: string, max = 8): string | null {
  const terms = significantWords(text).slice(0, max);
  return terms.length ? terms.map((t) => `"${t}"`).join(" OR ") : null;
}

/** A crude stem, so "looping" and "loops" meet: the word less a common ending. */
const stem = (w: string): string => w.replace(/(ings?|ed|es|s|ly)$/, "") || w;

/** The meaningful words two texts share (by stem), in the order the first one says them. */
export function sharedWords(a: string, b: string, max = 3): string[] {
  const bs = new Set(significantWords(b, 4).map(stem));
  return significantWords(a, 4).filter((w) => bs.has(stem(w))).slice(0, max);
}

/** “a”, “b” and “c”. */
export function quoteList(words: readonly string[]): string {
  const q = words.map((w) => `“${w}”`);
  return q.length <= 1 ? q.join("") : `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
}

/** The words around the first match of `re` in `text` (one cleaned line), at most `radius` characters each side,
 *  marked with … where it was cut. null when nothing matches. */
export function windowAround(text: string, re: RegExp, radius = 40): string | null {
  const t = excerptOf(text, 4000);
  const m = t.match(re);
  if (!m || m.index === undefined) return null;
  const from = Math.max(0, m.index - radius);
  const to = Math.min(t.length, m.index + m[0].length + radius);
  // Cut at word edges, so a window never starts or ends inside a word.
  let s = t.slice(from, to);
  if (from > 0) s = s.replace(/^\S*\s/, "");
  if (to < t.length) s = s.replace(/\s\S*$/, "");
  return `${from > 0 ? "…" : ""}${s.trim()}${to < t.length ? "…" : ""}`;
}

/** A text, quoted and cut to `max` characters. "" when it has no words. */
export function quoted(text: string | null | undefined, max = 90): string {
  const t = excerptOf(text ?? "", 4000);
  if (!t) return "";
  return `“${t.length > max ? `${t.slice(0, max).replace(/\s\S*$/, "")}…` : t}”`;
}

/** An FTS snippet as evidence: its words, cleaned, or null when it says nothing. */
export function snippetEvidence(snippet: string | null | undefined, max = 140): string | null {
  const s = excerptOf((snippet ?? "").replace(/…/g, " … "), max).replace(/\s*…\s*/g, "…").replace(/^…+|…+$/g, "").trim();
  return s.replace(/[^\p{L}\p{N}]/gu, "").length >= 3 ? `“…${s}…”` : null;
}
