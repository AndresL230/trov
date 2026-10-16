// The doc outline's rule lives in shared/doc-outline.ts: the server builds each doc's outline for
// `GET /docs` (the Docs tree draws `doc.outline` as it arrives), and the reader's heading ids
// (markdown.ts) come from the same slugifyHeading + de-dup, so a tree link always resolves.
export { slugifyHeading, type OutlineItem } from "@shared/doc-outline";
