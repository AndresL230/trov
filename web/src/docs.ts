// ── The public docs pages: one Markdown text, rendered ──────────────────────
// docs/architecture/web-ui.md › Docs for people and agents. A docs page's HTML is its Markdown
// (web/src/docs-content.ts `docsMarkdown`) RENDERED — never a second copy of its words — so `/docs/<page>`
// and `/docs/<page>.md` cannot drift. The text's shape: `# <title>`, the lede paragraph, optionally a few
// more paragraphs (the intro), then `## ` sections; the title and lede go in the banner, the intro opens
// the reading column, every section is a `.site-legal-sec` (the docs borrow the
// legal pages' layout: banner, contents rail, reading column), and the contents list is the `## `
// headings. The text is Trov's own, but it is still treated as text: any raw HTML in it is ESCAPED, never
// passed through (a tool's description says `<slug>`, and must show it).
//
// PURE: the build prerenders it (site-prerender.ts) and a test reads it. The page's script
// (web/src/docs-page.ts) only switches the theme, copies a code block and follows the contents — it never
// re-renders, so the client bundle carries none of the docs' text.

import { Marked, type Token, type Tokens } from "marked";
import { DOCS_PAGES, siteUrl, LLMS_TXT, type SitePage } from "@shared/site-pages";
import { trovMark } from "@shared/mark";
import { esc, attr } from "./ui";
import { siteFooter, siteMark } from "./site-chrome";

const escHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The slug a heading is linked by: lower case, letters, digits and `_` (a tool's name is its own anchor:
 *  /docs/mcp-tools#get_ticket), dashes between. */
export function headingId(text: string): string {
  return text.toLowerCase().replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/g, "").replace(/[^a-z0-9_]+/g, "-").replace(/^-|-$/g, "") || "section";
}

/** Code blocks and headings by their language and slug, links that leave the site in a new tab, and raw
 *  HTML as text. A fresh instance: the SPA's own renderer (markdown.ts) is configured globally. */
function docsMarked(ids: Map<string, number>): Marked {
  const md = new Marked({ gfm: true, breaks: false });
  md.use({
    renderer: {
      heading(this: { parser: { parseInline(t: Token[]): string } }, { tokens, depth, text }: Tokens.Heading) {
        const base = headingId(text);
        const n = ids.get(base) ?? 0;
        ids.set(base, n + 1);
        const id = n ? `${base}-${n + 1}` : base;
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        const label = (lang ?? "").trim().split(/\s+/)[0] || "text";
        return `<div class="site-docs-code" style="border-radius:10px"><div class="site-docs-code-h"><span>${escHtml(label)}</span><button type="button" data-docs-copy class="site-docs-copy" style="border-radius:6px">Copy</button></div><pre><code>${escHtml(text)}</code></pre></div>\n`;
      },
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escHtml(text);
      },
      link(this: { parser: { parseInline(t: Token[]): string } }, { href, title, tokens }: Tokens.Link) {
        // The Markdown links the site absolutely (it must stand on its own); the page links it by path, so
        // a Preview or `wrangler dev` stays on its own host. Anything else opens in a new tab.
        const site = siteUrl("/");
        const own = href.startsWith(site) ? `/${href.slice(site.length)}` : href;
        const out = /^https?:\/\//.test(own);
        return `<a href="${escHtml(own)}"${title ? ` title="${escHtml(title)}"` : ""}${out ? ' target="_blank" rel="noopener"' : ""}>${this.parser.parseInline(tokens)}</a>`;
      },
      table(this: { parser: { parseInline(t: Token[]): string } }, token: Tokens.Table) {
        const cell = (c: Tokens.TableCell, tag: "th" | "td") => `<${tag}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        return `<div class="site-docs-table"><table><thead><tr>${token.header.map((c) => cell(c, "th")).join("")}</tr></thead><tbody>${token.rows.map((r) => `<tr>${r.map((c) => cell(c, "td")).join("")}</tr>`).join("")}</tbody></table></div>\n`;
      },
    },
  });
  return md;
}

export interface DocsParts {
  title: string;
  /** The lede, as Markdown (one paragraph). */
  lede: string;
  /** What comes between the lede and the first section, rendered ("" for none). */
  intro: string;
  /** Every `## ` section: its heading and its blocks. */
  sections: { id: string; title: string; html: string }[];
}

/** A page's Markdown, split as the page shows it. Throws on a text that does not have the docs' shape. */
export function renderDocs(markdown: string): DocsParts {
  const ids = new Map<string, number>();
  const md = docsMarked(ids);
  const tokens = md.lexer(markdown);
  const blocks = tokens.filter((t) => t.type !== "space");
  const [h1, lede] = blocks;
  if (h1?.type !== "heading" || (h1 as Tokens.Heading).depth !== 1) throw new Error("docs: a page starts with `# <title>`");
  if (lede?.type !== "paragraph") throw new Error("docs: the title is followed by the lede, one paragraph");
  const intro: Token[] = [];
  const sections: { title: string; tokens: Token[] }[] = [];
  for (const t of blocks.slice(2)) {
    if (t.type === "heading" && (t as Tokens.Heading).depth === 2) sections.push({ title: (t as Tokens.Heading).text, tokens: [t] });
    else if (sections.length) sections[sections.length - 1].tokens.push(t);
    else if (t.type === "heading") throw new Error("docs: the first heading after the lede is a `## ` section");
    else intro.push(t);
  }
  const parse = (list: Token[]): string => md.parser(Object.assign(list, { links: (tokens as Token[] & { links: object }).links }) as Token[]);
  return {
    title: (h1 as Tokens.Heading).text,
    lede: (lede as Tokens.Paragraph).text,
    intro: intro.length ? parse(intro) : "",
    sections: sections.map((s) => {
      const html = parse(s.tokens);
      const id = /^<h2 id="([^"]+)"/.exec(html)?.[1] ?? headingId(s.title);
      return { id, title: s.title, html };
    }),
  };
}

/** Inline Markdown (the lede, a heading's text) as HTML, with raw HTML escaped. */
export function inlineMarkdown(text: string): string {
  return docsMarked(new Map()).parseInline(text, { async: false }) as string;
}

const SUN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"></path></svg>`;
const MOON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path></svg>`;
const CHEV = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>`;
const BANNER_ART = `<span class="site-banner-art" aria-hidden="true">${trovMark(100, "currentColor")}</span>`;

/** The whole docs page. Both theme icons are always emitted (the script flips which shows), so the markup
 *  never changes after the build. */
export function docsView(page: SitePage, markdown: string): string {
  const doc = renderDocs(markdown);
  const tab = (p: SitePage): string => p.key === page.key
    ? `<span class="site-legal-tab" aria-current="page" style="border-radius:8px">${esc(p.nav ?? p.title)}</span>`
    : `<a href="${attr(p.path)}" class="site-legal-tab" style="border-radius:8px">${esc(p.nav ?? p.title)}</a>`;
  const toc = doc.sections.map((s) => `<li><a href="#${s.id}" data-docs-toc="${s.id}"><span>${inlineMarkdown(s.title)}</span></a></li>`).join("");
  const sections = doc.sections.map((s) => `<section id="${s.id}" class="site-legal-sec">${s.html.replace(/^<h2 id="[^"]+">/, "<h2>")}</section>`).join("");
  return `<div class="cnpy-site site-docs">
    <nav class="site-nav" style="position:sticky;top:0;z-index:50;background:color-mix(in srgb, var(--bg) 86%, transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)">
      <div class="site-navin" style="max-width:1120px;margin:0 auto;padding:0 24px;height:60px;display:flex;align-items:center;gap:28px">
        <a href="/" aria-label="Trov home" style="display:flex;align-items:center;gap:9px;color:var(--fg);text-decoration:none">
          ${siteMark(20)}
          <span style="font-size:16.5px;font-weight:650;letter-spacing:-0.01em">Trov</span>
        </a>
        <div style="margin-left:auto;display:flex;align-items:center;gap:10px">
          <a href="/pricing" class="site-navlink site-hide-sm">Pricing</a>
          <button type="button" data-docs-theme title="Toggle theme" aria-label="Toggle theme" class="site-iconbtn" style="border:1px solid var(--border)"><span class="site-docs-sun">${SUN}</span><span class="site-docs-moon">${MOON}</span></button>
          <a href="/" class="cnpy-accentbtn" style="padding:7px 16px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:13.5px;font-weight:600;white-space:nowrap;text-decoration:none">Open Trov</a>
        </div>
      </div>
    </nav>
    <header class="site-hero">
      <div class="site-banner site-legal-band" style="border-radius:16px">
        ${BANNER_ART}
        <div class="site-legal-band-in">
          <nav class="site-legal-tabs site-docs-tabs" aria-label="Docs">${DOCS_PAGES.map(tab).join("")}</nav>
          <h1 class="site-legal-h">${inlineMarkdown(doc.title)}</h1>
          <p class="site-legal-lede">${inlineMarkdown(doc.lede)}</p>
          <div class="site-legal-date site-docs-alt">${page.markdown ? `<a href="${attr(page.markdown)}">This page as Markdown</a> · ` : ""}<a href="${LLMS_TXT}">All docs for language models</a></div>
        </div>
      </div>
    </header>
    <main class="site-legal">
      <aside class="site-legal-side">
        <nav aria-label="Contents" class="site-legal-toc" data-open="0"><div class="site-legal-toc-h">On this page</div><button type="button" data-docs-tocb aria-expanded="false" aria-controls="site-docs-toc-list" class="site-legal-tocb"><span class="site-legal-toc-h">On this page</span><span class="site-legal-tocb-n">${doc.sections.length} sections</span>${CHEV}</button><div class="site-legal-tocw"><ol id="site-docs-toc-list">${toc}</ol></div></nav>
      </aside>
      <article class="site-legal-text site-docs-text">
        ${doc.intro ? `<div class="site-legal-sec site-docs-intro">${doc.intro}</div>` : ""}${sections}
      </article>
    </main>
    ${siteFooter()}
  </div>`;
}
