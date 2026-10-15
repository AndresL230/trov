// `trov_docs` (docs/architecture/ask.md): Trov's OWN public docs, for "how do I…" questions about Trov itself.
// Read from the prerendered `/llms-full.txt` the web build writes beside the site (web/src/llms.ts — every docs
// page and the pricing page, as Markdown), through the Worker's own ASSETS binding: no network, no web search.
// The file is split into its pages and their `##` sections, and the best few sections for the question come back.
import type { Env } from "../../env";
import { LLMS_FULL_TXT } from "@shared/site-pages";

/** How much of the docs one call returns. */
const DOCS_RESULT_MAX = 12_000;
const SECTIONS_MAX = 4;

export interface DocsSection { source: string; heading: string; text: string }

/** Where the docs text comes from: the ASSETS file in production; a test hands its own. */
export type DocsSource = () => Promise<string | null>;

export const assetsDocs = (env: Pick<Env, "ASSETS">): DocsSource => async () => {
  try {
    const res = await env.ASSETS.fetch(new Request(`https://assets.invalid${LLMS_FULL_TXT}`));
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
};

/** Split llms-full.txt into sections: each `Source: <url>` page, cut again at its `## ` headings. */
export function docsSections(full: string): DocsSection[] {
  const out: DocsSection[] = [];
  const pages = full.split(/\n(?=Source: )/);
  for (const page of pages) {
    const m = /^Source: (\S+)/.exec(page);
    if (!m) continue;
    const body = page.slice(m[0].length);
    const parts = body.split(/\n(?=## )/);
    let title = (/^#\s+(.+)$/m.exec(body)?.[1] ?? m[1]).trim();
    for (const part of parts) {
      const h = /^## (.+)$/m.exec(part)?.[1]?.trim();
      const text = part.trim();
      if (!text) continue;
      out.push({ source: m[1], heading: h ? `${title} › ${h}` : title, text });
      if (!h) title = (/^#\s+(.+)$/m.exec(part)?.[1] ?? title).trim();
    }
  }
  return out;
}

const terms = (q: string): string[] => [...new Set(q.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [])].filter((t) => !STOP.has(t));
const STOP = new Set(["the", "and", "for", "how", "what", "does", "can", "with", "trov", "you", "your", "are", "this", "that", "into", "from", "when", "who", "why", "where", "use", "get"]);

/** The best sections for `q` (by how many of its words each holds, a heading match counting double). */
export function searchDocs(full: string, q: string): { sections: DocsSection[]; total: number } {
  const all = docsSections(full);
  const want = terms(q);
  const scored = all
    .map((s) => {
      const body = s.text.toLowerCase();
      const head = s.heading.toLowerCase();
      const score = want.reduce((n, t) => n + (body.includes(t) ? 1 : 0) + (head.includes(t) ? 2 : 0), 0);
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const sections: DocsSection[] = [];
  let size = 0;
  for (const { s } of scored.slice(0, SECTIONS_MAX)) {
    const text = s.text.length > DOCS_RESULT_MAX - size ? `${s.text.slice(0, Math.max(0, DOCS_RESULT_MAX - size))}\n… (truncated)` : s.text;
    sections.push({ ...s, text });
    size += text.length;
    if (size >= DOCS_RESULT_MAX) break;
  }
  return { sections, total: all.length };
}
