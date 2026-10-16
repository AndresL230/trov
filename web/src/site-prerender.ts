// ── The public pages, prerendered ────────────────────────────────────────────
// docs/architecture/web-ui.md › The public pages, for crawlers. The build (web/site-build.ts) asks this
// module for the WHOLE HTML document of every page of shared/site-pages.ts, and of the app shell, and
// writes them as Vite's inputs — there is no .html file to keep in step. So a public page arrives with
// its words, its <title> and its head tags (shared/site-pages.ts `siteHead`) before any script runs.
//
// PURE, and the markup is the boot script's own: the landing is `render(initialState())` — exactly what
// main.ts paints signed out, so its first paint MORPHS this markup in place (morph.ts, the page is
// `data-morph="landing"`) and nothing flashes; /pricing and the legal pages are `siteRoot(…)` of the same
// render their boot script paints. The landing's hero copy is rendered settled (its first words never
// wait on the script); its other reveals are prerendered hidden, as the script renders them (it plays
// them as they scroll in), and with scripting off trov.css `@media (scripting: none)` shows them settled.
//
// Prerendered in the light theme. THEME_BOOT, an inline script that is the root's first child, turns the
// root dark — and `<html>` behind it — before the page below it is even parsed when the visitor's stored
// theme is dark, so a dark visitor never sees a light page first; the boot script's first paint drops it.
import { LLMS_FULL_TXT, LLMS_TXT, faqPageLd, siteHead, type SitePage } from "@shared/site-pages";
import { initialState, render } from "./render";
import { landingChunk } from "./landing-lazy";
import * as landingModule from "./landing";
import { pricingView } from "./pricing";
import { LEGAL_DOCS, legalView, type LegalKind } from "./legal";
import { notFoundView } from "./not-found";
import { PAGE_BG, siteRoot } from "./site-chrome";
import { docsView } from "./docs";
import { docsMarkdown, markdownFooter } from "./docs-content";
import { landingQuestions } from "./site-questions";
import { llmsFullTxt, llmsTxt, markdownPages } from "./llms";

/** The stored theme, read as main.ts / pricing-page.ts / legal-page.ts read it (`trov.theme`, or the
 *  pre-rename `canopy.theme`; Midnight is Dark; System follows the OS). It paints `<html>` in that theme's
 *  background and, as a root's first child, turns the root dark; in the app shell's <head> it does the
 *  first only (the shell's root is main.ts's to paint). */
export const THEME_BOOT = `<script>(function(){var d=false;try{var t=localStorage.getItem("trov.theme")||localStorage.getItem("canopy.theme");d=t==="dark"||t==="midnight"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches)}catch(e){}document.documentElement.style.background=d?"${PAGE_BG.dark}":"${PAGE_BG.light}";var r=document.currentScript&&document.currentScript.parentNode;if(d&&r&&r!==document.head)r.setAttribute("data-cnpy-theme","dark")})()</script>`;

/** `root` (one element's markup) with THEME_BOOT as its first child. */
export function withThemeBoot(root: string): string {
  const open = /^\s*<div\b[^>]*>/.exec(root);
  if (!open) throw new Error("site-prerender: a page's root must be one <div>");
  return `${open[0]}${THEME_BOOT}${root.slice(open[0].length)}`;
}

// The landing is a lazy chunk in the app (landing-lazy.ts): the build draws it, so it hands the module in.
landingChunk.set(landingModule);

interface DocumentParts {
  /** The page's own head tags (title, description, …). */
  head: string;
  body: string;
  /** The module that boots the page (Vite bundles it and adds its CSS); none for a page with no script. */
  script?: string;
  /** Anything else for the head — the stylesheet of a page with no script. */
  extraHead?: string;
}

/** The one font file every page preloads: Geist's latin subset, self-hosted (trov.css `@font-face`). Vite
 *  rewrites this href to the same hashed `/assets/` file the stylesheet's `url()` resolves to, so the preload
 *  and the face are one download. `crossorigin` because a font is always fetched in CORS mode — without it
 *  the preload would not match and the file would be fetched twice. */
export const FONT_PRELOAD = `<link rel="preload" href="/src/fonts/geist-latin.woff2" as="font" type="font/woff2" crossorigin />`;

// The head every page shares. viewport-fit=cover: the app draws edge to edge on a notched phone and keeps
// its own content clear with env(safe-area-inset-*) (trov.css, the phone rules). favicon.ico is for
// browsers without SVG favicons (Safari); the SVG, listed last, wins everywhere else — before JS runs it
// follows prefers-color-scheme, and once the app paints web/src/favicon.ts repoints it at the app's theme.
// Type comes from Trov's own origin (FONT_PRELOAD): no page asks a third party for anything.
function documentHtml(d: DocumentParts): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    ${d.head}
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    ${FONT_PRELOAD}${d.extraHead ? `\n    ${d.extraHead}` : ""}
  </head>
  <body>
    ${d.body}${d.script ? `\n    <script type="module" src="${d.script}"></script>` : ""}
  </body>
</html>
`;
}

/** The markup each kind of page is mounted with, prerendered, and the script that takes it over. */
function pageBody(page: SitePage): Pick<DocumentParts, "body" | "script" | "extraHead"> {
  switch (page.kind) {
    case "landing":
      // The signed-out app's markup (the landing, light, nothing open), booted by the landing's own script
      // (landing-page.ts), which paints exactly this — the app's bundle is not on this page.
      return { body: `<div id="app">${withThemeBoot(render(initialState()))}</div>`, script: "/src/landing-page.ts" };
    case "pricing":
      return { body: `<div id="pricing">${withThemeBoot(siteRoot("light", pricingView(false)))}</div>`, script: "/src/pricing-page.ts" };
    case "legal": {
      const doc = LEGAL_DOCS[page.key as LegalKind];
      if (!doc) throw new Error(`site-prerender: no legal document "${page.key}" in web/src/legal.ts LEGAL_DOCS`);
      return { body: `<div id="legal" data-doc="${doc.kind}">${withThemeBoot(siteRoot("light", legalView(doc, false)))}</div>`, script: "/src/legal-page.ts" };
    }
    case "docs":
      // Complete as built: its script (docs-page.ts) switches the theme and copies code, and repaints nothing.
      return { body: withThemeBoot(siteRoot("light", docsView(page, docsMarkdown(page)))), script: "/src/docs-page.ts" };
    case "not-found":
      return { body: withThemeBoot(siteRoot("light", notFoundView())), extraHead: `<link rel="stylesheet" href="/src/trov.css" />` };
  }
}

/** Structured data a page's own content makes, beside its head's: the landing's questions as FAQPage —
 *  the very list its Questions accordion shows (site-questions.ts `landingQuestions`). */
function pageLd(page: SitePage): Record<string, unknown>[] {
  return page.kind === "landing" ? [faqPageLd(landingQuestions())] : [];
}

/** The whole HTML document of a public page. */
export function sitePageHtml(page: SitePage): string {
  return documentHtml({ head: siteHead(page, { ld: pageLd(page) }), ...pageBody(page) });
}

/** The text files beside the pages, by their path in the build (no leading slash): each page's Markdown
 *  (a docs page's is the very text its HTML was rendered from), /llms.txt and /llms-full.txt. */
export function siteFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const { page, markdown } of markdownPages()) {
    if (!page.markdown) throw new Error(`site-prerender: ${page.key} has Markdown but no \`markdown\` path`);
    files[page.markdown.slice(1)] = `${markdown.trim()}\n${markdownFooter(page)}`;
  }
  files[LLMS_TXT.slice(1)] = llmsTxt();
  files[LLMS_FULL_TXT.slice(1)] = llmsFullTxt();
  return files;
}

/** The app shell (web/app.html): every org page, /platform, /billing/done and /billing/checkout, and `/`
 *  for a visitor with a session (src/site.ts). Empty until main.ts paints; never indexed. */
export function appShellHtml(): string {
  return documentHtml({ head: `<title>Trov</title>\n    <meta name="robots" content="noindex" />\n    ${THEME_BOOT}`, body: `<div id="app"></div>`, script: "/src/main.ts" });
}
