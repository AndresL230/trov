// The public site's pages — THE ONE LIST. A page here is readable signed out, at the root of the origin,
// and everything that has to know about it reads it from here:
//   • the build (web/site-build.ts): one Vite input per page, its HTML PRERENDERED from the page's `kind`
//     (web/src/site-prerender.ts) with the head tags below — so it has its content with no script;
//   • the Worker (src/site.ts): /sitemap.xml lists every `indexed` page;
//   • shared/orgs.ts: its first path segment is a reserved organization slug, so no org can shadow it.
// ADDING A PUBLIC PAGE is one entry here plus its content: a `kind` that renders it. A new legal document
// (a refund policy) is a `legal` entry whose `key` is its key in web/src/legal.ts `LEGAL_DOCS`.
// docs/architecture/web-ui.md › The public pages, for crawlers.
//
// Zod-free, and nothing from web/: the Worker imports it. Every sentence is one the page itself says
// (test/site-pages.test.ts holds the descriptions to the rendered pages), and every price comes from
// shared/plans.ts + shared/pricing.ts, as on the pricing page.
import { OFFERED_PLAN_IDS, PLANS, seatsPhrase, type PlanId } from "./plans";
import { PRICE_CURRENCY, PRICING, formatPrice } from "./pricing";
import { isPurchasablePlan } from "./billing";
import { NOTICES_PATH, SOURCE_PATH, sourceUrl } from "./legal-core";

/** The canonical origin: every canonical link, og:url, og:image and sitemap entry. It is wrangler.toml's
 *  PUBLIC_ORIGIN (test/site.test.ts pins the two together). */
export const SITE_ORIGIN = "https://trov.dev";
export const SITE_NAME = "Trov";

/** How a page is built (web/src/site-prerender.ts): its mount, its boot script and its renderer. */
export type SitePageKind = "landing" | "pricing" | "legal" | "docs" | "not-found";

export interface SitePage {
  /** Unique: the Vite input's name. For a `legal` page it is also the document's key in `LEGAL_DOCS`; for a
   *  `docs` page, its key in web/src/docs-content.ts `DOCS`. */
  key: string;
  /** "/" or "/<name>". The assets binding serves it from `<name>.html` (`index.html` for "/"). */
  path: string;
  kind: SitePageKind;
  /** The whole `<title>`. */
  title: string;
  /** The meta description, and og/twitter description: a sentence the page itself says. */
  description: string;
  /** Listed in /sitemap.xml, with a canonical link, Open Graph and Twitter tags. false: `noindex`, none of those. */
  indexed: boolean;
  /** The 1200 × 630 Open Graph image: a path under web/public (made by scripts/og/render.mjs), and its alt text. */
  image?: { path: string; alt: string };
  /** Carries the SoftwareApplication JSON-LD (`softwareApplicationLd`): the product and its prices. */
  structuredData?: boolean;
  /** The page as Markdown (a path the build writes beside it), linked from its head as
   *  `<link rel="alternate" type="text/markdown">` and listed in /llms.txt. */
  markdown?: string;
  /** A `docs` page: its short name in the docs' own tabs ("Setup"). */
  nav?: string;
}

/** The hero's lede on the landing page (web/src/landing.ts `hero`), word for word. */
const HOME_DESCRIPTION = "Agents load what your team already decided, record what actually shipped, and wait for a person to approve anything that becomes official.";

/** Each offered plan in a few words, from the plan and price tables: "Free for up to 3 people", "Pro at
 *  $10 per seat / month", "Enterprise with custom pricing". */
function planPhrase(id: PlanId): string {
  const def = PLANS[id];
  const price = PRICING[id];
  if (price.price === 0) return `${def.name} for ${seatsPhrase(def.entitlements.seats)}`;
  if (price.price === null) return `${def.name} with ${price.selfServe ? "pricing to be announced" : "custom pricing"}`;
  return `${def.name} at ${formatPrice(price.price)} ${price.per}`;
}
const listed = (parts: string[]): string => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`);
const PLANS_PHRASE = listed(OFFERED_PLAN_IDS.map(planPhrase));

export const SITE_PAGES: readonly SitePage[] = [
  {
    key: "index", path: "/", kind: "landing", indexed: true, structuredData: true,
    title: `${SITE_NAME} · Shared memory for your team and its coding agents`,
    description: HOME_DESCRIPTION,
    image: { path: "/og/home.png", alt: `${SITE_NAME}: shared memory for your team and its coding agents.` },
  },
  {
    key: "pricing", path: "/pricing", kind: "pricing", indexed: true, structuredData: true, markdown: "/pricing.md",
    title: `Pricing · ${SITE_NAME}`,
    description: `${PLANS_PHRASE}. Every plan is all of ${SITE_NAME}.`,
    image: { path: "/og/pricing.png", alt: `${SITE_NAME} pricing: ${PLANS_PHRASE}.` },
  },
  {
    key: "terms", path: "/terms", kind: "legal", indexed: true,
    title: `Terms of Service · ${SITE_NAME}`,
    description: "These terms cover your use of Trov, the shared context store for teams and their coding agents.",
    image: { path: "/og/terms.png", alt: `${SITE_NAME} Terms of Service` },
  },
  {
    key: "privacy", path: "/privacy", kind: "legal", indexed: true,
    title: `Privacy Policy · ${SITE_NAME}`,
    description: "This policy explains what Trov collects, why, who processes it, how long it is kept and what you can ask for.",
    image: { path: "/og/privacy.png", alt: `${SITE_NAME} Privacy Policy` },
  },
  {
    key: "refunds", path: "/refunds", kind: "legal", indexed: true,
    title: `Refund and Cancellation Policy · ${SITE_NAME}`,
    description: "This policy explains how to cancel a paid Trov plan, what happens when you do, and when a payment is refunded.",
    image: { path: "/og/refunds.png", alt: `${SITE_NAME} Refund and Cancellation Policy` },
  },
  // The public docs (web/src/docs-content.ts): each page is ONE Markdown text — served as-is at `markdown`
  // and rendered to the HTML page — so the two cannot say different things. Under /docs/<page>: `/docs`
  // itself is the app's cookie route (the old alias of an organization's docs list), so there is no page
  // AT /docs; src/site.ts sends a browser that types it, signed out, to the first one (DOCS_HOME).
  // The description is each page's own lede.
  {
    key: "docs-setup", path: "/docs/setup", kind: "docs", indexed: true, markdown: "/docs/setup.md", nav: "Setup",
    title: `Set up Trov · ${SITE_NAME} docs`,
    description: "Sign in, create an organization, connect GitHub and connect your coding agent: everything from a new account to a first session.",
    image: { path: "/og/docs-setup.png", alt: `${SITE_NAME} docs: set up Trov.` },
  },
  {
    key: "docs-connect", path: "/docs/connect", kind: "docs", indexed: true, markdown: "/docs/connect.md", nav: "Connect a client",
    title: `Connect an MCP client · ${SITE_NAME} docs`,
    description: "Trov is a remote MCP server at https://trov.dev/mcp. Setup to copy for Claude Code, Claude Desktop, Cursor, VS Code, Codex, Windsurf and any other client.",
    image: { path: "/og/docs-connect.png", alt: `${SITE_NAME} docs: connect an MCP client.` },
  },
  {
    key: "docs-concepts", path: "/docs/concepts", kind: "docs", indexed: true, markdown: "/docs/concepts.md", nav: "Concepts",
    title: `Concepts · ${SITE_NAME} docs`,
    description: "Agents propose and people decide: how Trov keeps what agents read trustworthy, and what live, staged, unpromoted and draft mean.",
    image: { path: "/og/docs-concepts.png", alt: `${SITE_NAME} docs: concepts.` },
  },
  {
    key: "docs-mcp-tools", path: "/docs/mcp-tools", kind: "docs", indexed: true, markdown: "/docs/mcp-tools.md", nav: "MCP tools",
    title: `MCP tools reference · ${SITE_NAME} docs`,
    description: "Every tool Trov's MCP server gives an agent, generated from the server's own registrations: what each does, its arguments, and its errors.",
    image: { path: "/og/docs-mcp-tools.png", alt: `${SITE_NAME} docs: MCP tools reference.` },
  },
  {
    key: "docs-changelog", path: "/docs/changelog", kind: "docs", indexed: true, markdown: "/docs/changelog.md", nav: "Changelog",
    title: `Changelog · ${SITE_NAME} docs`,
    description: "What changed in Trov, release by release, newest first.",
    image: { path: "/og/docs-changelog.png", alt: `${SITE_NAME} docs: changelog.` },
  },
  // The page the Worker answers an unknown address with, status 404 (src/site.ts `notFound`). Built like
  // the others; never listed, never indexed.
  {
    key: "404", path: "/404", kind: "not-found", indexed: false,
    title: `Page not found · ${SITE_NAME}`,
    description: "There is no page at this address.",
  },
];

/** The page's absolute, canonical URL. */
export const siteUrl = (path: string): string => `${SITE_ORIGIN}${path}`;
/** The built file the assets binding serves the page from: `index.html` for "/", else `<name>.html`. */
export const sitePageFile = (page: Pick<SitePage, "path">): string => (page.path === "/" ? "index.html" : `${page.path.slice(1)}.html`);
/** The first path segment each page takes at the root ("" for "/") — reserved as org slugs (shared/orgs.ts). */
export const SITE_PAGE_SEGMENTS: readonly string[] = [...new Set(SITE_PAGES.map((p) => p.path.split("/")[1] ?? "").filter((s) => s !== ""))];
/** The page the Worker serves for an unknown address. */
export const NOT_FOUND_PAGE: SitePage = SITE_PAGES.find((p) => p.kind === "not-found") as SitePage;
/** The docs pages, in their tabs' order. */
export const DOCS_PAGES: readonly SitePage[] = SITE_PAGES.filter((p) => p.kind === "docs");
/** A public page's path, by its key: a link to a page is never a typed address. */
export function pagePath(key: string): string {
  const p = SITE_PAGES.find((x) => x.key === key);
  if (!p) throw new Error(`site-pages: no page "${key}"`);
  return p.path;
}
/** Where the docs start (src/site.ts sends `/docs/` there). */
export const DOCS_HOME: string = DOCS_PAGES[0].path;
/** The text files the build writes beside the pages: every page's Markdown, and the index for language
 *  models (llms.txt, llms-full.txt — https://llmstxt.org). Each is served by the assets binding, before
 *  the Worker, with its own type (`assetHeaders`). */
export const LLMS_TXT = "/llms.txt";
export const LLMS_FULL_TXT = "/llms-full.txt";
export const MARKDOWN_PAGES: readonly SitePage[] = SITE_PAGES.filter((p) => p.markdown);
/** The app shell (web/app.html): its clean path, which the assets binding answers without a redirect. */
export const APP_SHELL_PATH = "/app";

// ── what the assets binding is told (the build writes both files into web/dist) ──

/** `_redirects`: every other spelling of an indexed page goes, for good (301), to its one URL — the file
 *  name (`/pricing.html`), a trailing slash (`/pricing/`), `/index` and `/index.html` for `/` — where the
 *  binding's own html handling would answer with a TEMPORARY 307. These rules run before the binding looks
 *  for a file; the query string is kept. The binding takes relative rules only, so `www.` and plain http
 *  are the Worker's for what it serves (src/site.ts `canonicalRedirect`, `/` included) and the zone's for
 *  the files (a Redirect Rule and "Always Use HTTPS" in the Cloudflare dashboard: HANDOFF.md). */
export function assetRedirects(commit: string | null = null): string {
  const rules: string[] = [];
  for (const p of SITE_PAGES.filter((pg) => pg.indexed)) {
    const from = p.path === "/" ? ["/index", "/index.html"] : [`${p.path}.html`, `${p.path}/`];
    for (const f of from) rules.push(`${f} ${p.path} 301`);
  }
  rules.push(sourceRedirect(commit));
  return `# Written by the build from shared/site-pages.ts (assetRedirects): do not edit.\n${rules.join("\n")}\n`;
}

/** AGPL-3.0 §13: `/source` (shared/legal-core.ts `SOURCE_PATH`, which every surface links) goes to the source
 *  of THIS deployment — the commit Workers Builds built (`WORKERS_CI_COMMIT_SHA`, read by web/site-build.ts),
 *  or the repository when the build did not know it (a local build). A 302: the next deploy points it
 *  elsewhere, so no browser may cache it. */
export function sourceRedirect(commit: string | null = null): string {
  return `${SOURCE_PATH} ${sourceUrl(commit)} 302`;
}

/** `_headers`: `noindex` on the static files nobody should find in a search — the app shell and the
 *  not-found page when asked for by their own path (each also says so in a meta tag), and EVERY file on a
 *  workers.dev address (a Preview, `<version>-trov.<account>.workers.dev`, or production's own workers.dev
 *  alias): the site is SITE_ORIGIN. The Worker says the same for what it serves (src/site.ts).
 *  And the text files' types, said outright (UTF-8 — the binding's guess for `.md` names no charset): a
 *  page's Markdown is `text/markdown` with an HTTP `Link` naming the HTML page as canonical, so a search
 *  engine indexes the page and not its source; llms.txt and llms-full.txt are `text/plain`.
 *  And how long a browser keeps a file: Vite's `/assets/*` carry a content hash in their name, so a new build
 *  names new files and the old ones may be kept for good (`immutable`, a year); the Guide's screenshots
 *  (`/guide/*`) have stable names and are kept a week. Every OTHER file — the pages, the app shell, the
 *  fonts' stable copies, the text files — keeps the binding's default: revalidated by ETag on each use, so a
 *  deploy is seen at once. No other rule here names Cache-Control, and a path matching several rules gets
 *  the headers of all of them (a header two rules both set would be joined with a comma): ASSET_CACHE is
 *  the only place it is said. */
export const ASSET_CACHE: readonly (readonly [rule: string, cacheControl: string])[] = [
  ["/assets/*", "public, max-age=31536000, immutable"],
  ["/guide/*", "public, max-age=604800"],
];
export function assetHeaders(): string {
  const noindex = (rule: string) => `${rule}\n  X-Robots-Tag: noindex`;
  return [
    "# Written by the build from shared/site-pages.ts (assetHeaders): do not edit.",
    ...ASSET_CACHE.map(([rule, value]) => `${rule}\n  Cache-Control: ${value}`),
    noindex("https://:version.:account.workers.dev/*"),
    noindex(APP_SHELL_PATH),
    ...SITE_PAGES.filter((p) => !p.indexed).map((p) => noindex(p.path)),
    ...MARKDOWN_PAGES.map((p) => `${p.markdown}\n  Content-Type: text/markdown; charset=utf-8\n  Link: <${siteUrl(p.path)}>; rel="canonical"`),
    ...[LLMS_TXT, LLMS_FULL_TXT, NOTICES_PATH].map((f) => `${f}\n  Content-Type: text/plain; charset=utf-8`),
    "",
  ].join("\n");
}

// ── head tags ────────────────────────────────────────────────────────────────

const escAttr = (v: string): string => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** One plan as a schema.org Offer. A plan billing sells is bought per seat, monthly (`price`) and, when it
 *  has one, yearly (`yearly`): each is a UnitPriceSpecification whose unit text is the pricing page's own. */
function offer(id: PlanId): Record<string, unknown> {
  const def = PLANS[id];
  const price = PRICING[id];
  const base: Record<string, unknown> = {
    "@type": "Offer", name: def.name, description: def.description,
    price: price.price, priceCurrency: PRICE_CURRENCY, url: siteUrl("/pricing"),
  };
  if (!price.price || !isPurchasablePlan(id)) return base;
  const unit = (amount: number, per: string, months: number) => ({
    "@type": "UnitPriceSpecification", price: amount, priceCurrency: PRICE_CURRENCY, unitText: per,
    referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitText: "seat" },
    billingDuration: `P${months}M`,
  });
  const specs = [unit(price.price, price.per, 1), ...(price.yearly !== null ? [unit(price.yearly, price.yearlyPer, 12)] : [])];
  return { ...base, priceSpecification: specs.length === 1 ? specs[0] : specs };
}

/** The product as schema.org SoftwareApplication, with an Offer for every offered plan that has a price
 *  (Free, Pro). A plan without one (Enterprise: custom) is left out — an Offer must state a price. No
 *  rating or review: Trov has none to state. */
export function softwareApplicationLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    url: siteUrl("/"),
    description: HOME_DESCRIPTION,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    offers: OFFERED_PLAN_IDS.filter((id) => PRICING[id].price !== null).map(offer),
  };
}

/** A visible list of questions as schema.org FAQPage — on the ONE page that shows them all (the landing;
 *  /pricing repeats some, unmarked, as the guidelines ask). `a` is the answer's own HTML, as shown. */
export function faqPageLd(questions: readonly { q: string; a: string }[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: questions.map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })),
  };
}

/** Structured data for the head: `<` is escaped inside the JSON so no string in it can close the script. */
export const ldScript = (ld: Record<string, unknown>): string => `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`;

/** Everything a page's `<head>` says about it, in the order a reader expects: title, description, robots,
 *  canonical, its Markdown, Open Graph, Twitter, structured data. An unindexed page gets `noindex` and
 *  nothing to share. `ld`: more structured data the page's own content makes (the landing's FAQPage). */
export function siteHead(page: SitePage, extra: { ld?: readonly Record<string, unknown>[] } = {}): string {
  const tags = [`<title>${escAttr(page.title)}</title>`, `<meta name="description" content="${escAttr(page.description)}" />`];
  if (!page.indexed) return [...tags, `<meta name="robots" content="noindex" />`].join("\n    ");
  const url = siteUrl(page.path);
  tags.push(
    `<link rel="canonical" href="${url}" />`,
    ...(page.markdown ? [`<link rel="alternate" type="text/markdown" href="${siteUrl(page.markdown)}" />`] : []),
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${escAttr(page.title)}" />`,
    `<meta property="og:description" content="${escAttr(page.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
  );
  if (page.image) {
    const img = siteUrl(page.image.path);
    tags.push(
      `<meta property="og:image" content="${img}" />`,
      `<meta property="og:image:type" content="image/png" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta property="og:image:alt" content="${escAttr(page.image.alt)}" />`,
    );
  }
  tags.push(
    `<meta name="twitter:card" content="${page.image ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${escAttr(page.title)}" />`,
    `<meta name="twitter:description" content="${escAttr(page.description)}" />`,
  );
  if (page.image) tags.push(`<meta name="twitter:image" content="${siteUrl(page.image.path)}" />`, `<meta name="twitter:image:alt" content="${escAttr(page.image.alt)}" />`);
  if (page.structuredData) tags.push(ldScript(softwareApplicationLd()));
  for (const ld of extra.ld ?? []) tags.push(ldScript(ld));
  return tags.join("\n    ");
}
