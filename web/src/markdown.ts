import { tenantHref, apiOrgSlug } from "./api";
import { repoUrl } from "./github";
import { createLru } from "./lru";
import { slugifyHeading } from "./outline";
import { DOC_IMAGE_PATH_RE } from "@shared/doc-images";
import { markdownLib, markdownMissed } from "./markdown-load";
import { esc } from "./ui";
import { skeleton, skLines } from "./skeleton";

// marked + DOMPurify are their own chunk (markdown-lib.ts, loaded by markdown-load.ts; web-ui.md › The app's
// bundles). Until it is in, a body draws a placeholder — a block is a few skeleton lines (invisible for
// SKEL_DELAY_MS, so a chunk that lands in time is never seen), an inline summary its text, escaped — and
// the chunk's arrival repaints. A placeholder is never cached.

/** A string's short, stable name: the placeholder's skeleton key (unique per body on a screen). */
function bodyKey(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `md-${(h >>> 0).toString(36)}`;
}

const blockPending = (body: string): string => {
  markdownMissed();
  return skeleton(bodyKey(body ?? ""), "Loading…", skLines(["100%", "94%", "62%"], 14.5, 1.7));
};

// Memoized (web-ui.md › Markdown is rendered once per body): every paint rebuilds the whole app's
// markup, and marked + DOMPurify + `enhance` per doc, per paint, was the slowest part of a paint on
// Docs and Review. The output depends on the body and on two pieces of page state — the org's main
// repository (`repoUrl()`, which bare `#12` refs link to) and the org on screen (`tenantHref`, which
// doc images are pointed at) — so all three are the key. The values are strings: nothing can
// mutate a cached result. Inline summaries (a feed row each) get their own, larger cache, so a long
// feed does not push every doc body out.
const blockCache = createLru<string>(100);
const inlineCache = createLru<string>(300);
const cacheKey = (text: string): string => `${repoUrl() ?? ""}\u0000${apiOrgSlug() ?? ""}\u0000${text ?? ""}`;

/**
 * Render a markdown doc body to sanitized HTML for innerHTML. Doc bodies are agent-written
 * and reach the DOM via template-string innerHTML, so every body passes through DOMPurify —
 * marked turns the markdown into HTML and DOMPurify strips any embedded <script>/event-handler
 * before it is inserted. This is the one place raw HTML enters the docs reader.
 */
export function renderMarkdown(body: string): string {
  const key = cacheKey(body);
  const hit = blockCache.get(key);
  if (hit !== undefined) return hit;
  const lib = markdownLib();
  if (!lib) return blockPending(body);
  const html = lib.marked.parse(body ?? "", { async: false }) as string;
  const clean = lib.DOMPurify.sanitize(html);
  const out = enhance(clean);
  blockCache.set(key, out);
  return out;
}

/**
 * Inline-only markdown for a ONE-LINE field (a feed entry's summary): emphasis, code spans,
 * links and issue refs — never block elements, so a leading `#` or `1.` cannot turn a headline
 * into a heading or a list. Same trust boundary as `renderMarkdown`: marked, then DOMPurify.
 */
export function renderMarkdownInline(text: string): string {
  const key = cacheKey(text);
  const hit = inlineCache.get(key);
  if (hit !== undefined) return hit;
  const lib = markdownLib();
  if (!lib) { markdownMissed(); return esc(text ?? ""); }
  const html = lib.marked.parseInline(text ?? "", { async: false }) as string;
  const out = lib.DOMPurify.sanitize(html);
  inlineCache.set(key, out);
  return out;
}

/**
 * Sanitize an uploaded SVG artifact for inline display in the app origin. An SVG can
 * carry <script>, event handlers and javascript: links; DOMPurify's svg + svgFilters
 * profiles keep the drawing and drop all of that. The Artifacts viewer inlines an
 * SVG ONLY through this (render tests mock this module).
 */
export function sanitizeSvg(src: string): string {
  const lib = markdownLib();
  if (!lib) return blockPending(src);
  return lib.DOMPurify.sanitize(src ?? "", { USE_PROFILES: { svg: true, svgFilters: true } }) as string;
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
