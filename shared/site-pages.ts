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

/** The canonical origin: every canonical link, og:url, og:image and sitemap entry. It is wrangler.toml's
 *  PUBLIC_ORIGIN (test/site.test.ts pins the two together). */
export const SITE_ORIGIN = "https://trov.dev";
export const SITE_NAME = "Trov";

/** How a page is built (web/src/site-prerender.ts): its mount, its boot script and its renderer. */
export type SitePageKind = "landing" | "pricing" | "legal" | "not-found";

export interface SitePage {
  /** Unique: the Vite input's name. For a `legal` page it is also the document's key in `LEGAL_DOCS`. */
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
    key: "pricing", path: "/pricing", kind: "pricing", indexed: true, structuredData: true,
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
export const SITE_PAGE_SEGMENTS: readonly string[] = SITE_PAGES.map((p) => p.path.split("/")[1] ?? "").filter((s) => s !== "");
/** The page the Worker serves for an unknown address. */
export const NOT_FOUND_PAGE: SitePage = SITE_PAGES.find((p) => p.kind === "not-found") as SitePage;
/** The app shell (web/app.html): its clean path, which the assets binding answers without a redirect. */
export const APP_SHELL_PATH = "/app";

// ── what the assets binding is told (the build writes both files into web/dist) ──

/** `_redirects`: every other spelling of an indexed page goes, for good (301), to its one URL — the file
 *  name (`/pricing.html`), a trailing slash (`/pricing/`), `/index` and `/index.html` for `/` — where the
 *  binding's own html handling would answer with a TEMPORARY 307. These rules run before the binding looks
 *  for a file; the query string is kept. The binding takes relative rules only, so `www.` and plain http
 *  are the Worker's for what it serves (src/site.ts `canonicalRedirect`, `/` included) and the zone's for
 *  the files (a Redirect Rule and "Always Use HTTPS" in the Cloudflare dashboard: HANDOFF.md). */
export function assetRedirects(): string {
  const rules: string[] = [];
  for (const p of SITE_PAGES.filter((pg) => pg.indexed)) {
    const from = p.path === "/" ? ["/index", "/index.html"] : [`${p.path}.html`, `${p.path}/`];
    for (const f of from) rules.push(`${f} ${p.path} 301`);
  }
  return `# Written by the build from shared/site-pages.ts (assetRedirects): do not edit.\n${rules.join("\n")}\n`;
}

/** `_headers`: `noindex` on the static files nobody should find in a search — the app shell and the
 *  not-found page when asked for by their own path (each also says so in a meta tag), and EVERY file on a
 *  workers.dev address (a Preview, `<version>-trov.<account>.workers.dev`, or production's own workers.dev
 *  alias): the site is SITE_ORIGIN. The Worker says the same for what it serves (src/site.ts). */
export function assetHeaders(): string {
  const noindex = (rule: string) => `${rule}\n  X-Robots-Tag: noindex`;
  return [
    "# Written by the build from shared/site-pages.ts (assetHeaders): do not edit.",
    noindex("https://:version.:account.workers.dev/*"),
    noindex(APP_SHELL_PATH),
    ...SITE_PAGES.filter((p) => !p.indexed).map((p) => noindex(p.path)),
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

/** Everything a page's `<head>` says about it, in the order a reader expects: title, description, robots,
 *  canonical, Open Graph, Twitter, structured data. An unindexed page gets `noindex` and nothing to share. */
export function siteHead(page: SitePage): string {
  const tags = [`<title>${escAttr(page.title)}</title>`, `<meta name="description" content="${escAttr(page.description)}" />`];
  if (!page.indexed) return [...tags, `<meta name="robots" content="noindex" />`].join("\n    ");
  const url = siteUrl(page.path);
  tags.push(
    `<link rel="canonical" href="${url}" />`,
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
  // `<` is escaped inside the JSON so no string in it can close the script element.
  if (page.structuredData) tags.push(`<script type="application/ld+json">${JSON.stringify(softwareApplicationLd()).replace(/</g, "\\u003c")}</script>`);
  return tags.join("\n    ");
}
