import { marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { repoUrl } from "./github";
import { tenantHref } from "./api";
import { slugifyHeading } from "./outline";
import { issueRefStart, matchIssueRef } from "./issue-ref";
import { DOC_IMAGE_PATH_RE } from "@shared/doc-images";

marked.setOptions({ gfm: true, breaks: false });

// Auto-link GitHub issue/PR refs in prose — bare `#123` (this org's main repo) and
// `owner/repo#123` (that repo; see issue-ref.ts). Runs as an inline extension, so
// it skips code spans/blocks (tokenized separately) and its output is still DOMPurify-sanitized.
marked.use({
  extensions: [
    {
      name: "issueRef",
      level: "inline",
      start(src: string) {
        return issueRefStart(src);
      },
      tokenizer(src: string) {
        // No repository connected: `owner/repo#12` still links (it names its repo); a bare `#12` stays text.
        const ref = matchIssueRef(src, repoUrl());
        if (ref) return { type: "issueRef", raw: ref.raw, href: ref.href, text: ref.text } as Tokens.Generic;
        return undefined;
      },
      renderer(token) {
        // `href` is built from a strict owner/repo#N match and `text` is that same
        // match — no quotes or angle brackets can occur — and the result still
        // passes through DOMPurify with everything else.
        const { href, text } = token as unknown as { href: string; text: string };
        return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
      },
    },
  ],
});

/**
 * Render a markdown doc body to sanitized HTML for innerHTML. Doc bodies are agent-written
 * and reach the DOM via template-string innerHTML, so every body passes through DOMPurify —
 * marked turns the markdown into HTML and DOMPurify strips any embedded <script>/event-handler
 * before it is inserted. This is the one place raw HTML enters the docs reader.
 */
export function renderMarkdown(body: string): string {
  const html = marked.parse(body ?? "", { async: false }) as string;
  const clean = DOMPurify.sanitize(html);
  return enhance(clean);
}

/**
 * Inline-only markdown for a ONE-LINE field (a feed entry's summary): emphasis, code spans,
 * links and issue refs — never block elements, so a leading `#` or `1.` cannot turn a headline
 * into a heading or a list. Same trust boundary as `renderMarkdown`: marked, then DOMPurify.
 */
export function renderMarkdownInline(text: string): string {
  const html = marked.parseInline(text ?? "", { async: false }) as string;
  return DOMPurify.sanitize(html);
}

/**
 * Sanitize an uploaded SVG artifact for inline display in the app origin. An SVG can
 * carry <script>, event handlers and javascript: links; DOMPurify's svg + svgFilters
 * profiles keep the drawing and drop all of that. The Artifacts viewer inlines an
 * SVG ONLY through this (render tests mock this module).
 */
export function sanitizeSvg(src: string): string {
  return DOMPurify.sanitize(src ?? "", { USE_PROFILES: { svg: true, svgFilters: true } }) as string;
}

/**
 * Progressive-enhancement pass over the already-sanitized HTML, done in a detached
 * <template> (never re-inserts unsanitized markup):
 *  • wrap each fenced code block in a `.cnpy-code` panel, tagged with its language;
 *  • wrap each table in a `.cnpy-md-tablewrap` so wide tables scroll instead of
 *    overflowing the reader column;
 *  • wrap each uploaded doc image (`/img/<sha256>`) in a zoom button that opens the
 *    lightbox (main.ts `docImgZoom`), lazy-loaded. Any other image source is left as
 *    sanitized — the doc gate refuses them, so none reach a proposal made since.
 * Browser-only — the reader is the sole caller at runtime; render tests mock this module.
 */
function enhance(clean: string): string {
  if (typeof document === "undefined") return clean;
  const tpl = document.createElement("template");
  tpl.innerHTML = clean;

  // Anchor ids on every heading (document order, de-duped) so the tree outline
  // can scroll to them. slugifyHeading + this de-dup mirror extractOutline().
  const seen = new Map<string, number>();
  tpl.content.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    let id = slugifyHeading(h.textContent ?? "") || "section";
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n}`;
    if (!h.id) h.id = id;
  });

  tpl.content.querySelectorAll("pre").forEach((pre) => {
    const wrap = document.createElement("div");
    wrap.className = "cnpy-code";
    const lang = /language-([A-Za-z0-9+#._-]+)/.exec(pre.querySelector("code")?.className ?? "")?.[1];
    if (lang) {
      const tag = document.createElement("div");
      tag.className = "cnpy-code-lang";
      tag.textContent = lang;
      wrap.appendChild(tag);
    }
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
  });

  tpl.content.querySelectorAll("img").forEach((img) => {
    const m = DOC_IMAGE_PATH_RE.exec(img.getAttribute("src") ?? "");
    if (!m) return;
    // A doc names its image `/img/<sha>`; the bytes are the ORG's, behind its membership gate.
    img.setAttribute("src", tenantHref(`/img/${m[1]}`));
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cnpy-md-img";
    btn.setAttribute("data-act", "docImgZoom");
    btn.setAttribute("data-arg", m[1]);
    btn.setAttribute("aria-label", `Expand image${img.alt ? `: ${img.alt}` : ""}`);
    img.replaceWith(btn);
    btn.appendChild(img);
  });

  tpl.content.querySelectorAll("table").forEach((table) => {
    const wrap = document.createElement("div");
    wrap.className = "cnpy-md-tablewrap";
    table.replaceWith(wrap);
    wrap.appendChild(table);
  });

  return tpl.innerHTML;
}
