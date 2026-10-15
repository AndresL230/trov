// Ask Trov — a conversation-held item as an inspector ref (the conversation part's; pure, no imports).
//
// "Open in inspector" on a rich block (a chart, the theme strip, a diagram, a table) and a question's attached file
// open something the SERVER has no ref for: it lives in the conversation on screen. They go on the inspector's stack
// as a local ref, `askcv:<where>:<message key>:<kind>:<n>` — never sent to peek (the conversation primes it as
// hidden, so `want` skips it) or to `GET /ask/item` (the inspector draws it from `cvItem` in ask-conversation.ts).
//   chart / themes / diagram / items   n = the block's index in its answer (`AskShownPart.index`)
//   table                              n = `<part>.<table>` (the text part, then the table inside it)
//   upload                             n = the attachment's id, on the question's key

export type CvRefKind = "chart" | "themes" | "diagram" | "items" | "table" | "upload";
const KINDS: readonly CvRefKind[] = ["chart", "themes", "diagram", "items", "table", "upload"];
export const CV_REF = "askcv:";

export const cvRef = (where: "page" | "panel", key: string, kind: CvRefKind, n: string | number): string => `${CV_REF}${where}:${key}:${kind}:${n}`;
export const isCvRef = (ref: string): boolean => ref.startsWith(CV_REF);

export function parseCvRef(ref: string): { where: "page" | "panel"; key: string; kind: CvRefKind; n: string } | null {
  if (!isCvRef(ref)) return null;
  const [where, key, kind, n] = ref.slice(CV_REF.length).split(":");
  if ((where !== "page" && where !== "panel") || !key || !(KINDS as readonly string[]).includes(kind) || n === undefined || n === "") return null;
  return { where, key, kind: kind as CvRefKind, n };
}

/** The inspector's type word for one (the design's: Chart, Upload; a diagram and a table name themselves). */
export function cvRefWord(ref: string): string {
  switch (parseCvRef(ref)?.kind) {
    case "chart": case "themes": return "Chart";
    case "diagram": return "Diagram";
    case "items": return "Items";
    case "table": return "Table";
    case "upload": return "Upload";
    default: return "";
  }
}
