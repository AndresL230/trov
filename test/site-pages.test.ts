/**
 * The public site's pages (shared/site-pages.ts — THE one list) and what the build makes of them
 * (web/src/site-prerender.ts): every page arrives with its words and its own head tags before any script
 * runs, the copy in those tags is what the page itself says, the prices come from the plan and price
 * tables, the app shell can never pass for the home page, and the landing's prerender is EXACTLY what
 * main.ts paints signed out (so its first paint morphs it in place). docs/architecture/web-ui.md › The
 * public pages, for crawlers.
 */
import { describe, it, expect } from "vitest";
import {
  APP_SHELL_PATH, NOT_FOUND_PAGE, SITE_ORIGIN, SITE_PAGES, assetHeaders, assetRedirects, siteHead, sitePageFile, siteUrl,
  softwareApplicationLd, type SitePage,
} from "../shared/site-pages";
import { OFFERED_PLAN_IDS, PLANS } from "../shared/plans";
import { PRICE_CURRENCY, PRICING, formatPrice } from "../shared/pricing";
import { THEME_BOOT, appShellHtml, sitePageHtml, withThemeBoot } from "../web/src/site-prerender";
import { initialState, render } from "../web/src/render";
import { landingView } from "../web/src/landing";
import { pricingView } from "../web/src/pricing";
import { LEGAL_DOCS, legalView, type LegalKind } from "../web/src/legal";
import { NOT_FOUND_LEDE, notFoundView } from "../web/src/not-found";
import css from "../web/src/trov.css?raw";
import mainSrc from "../web/src/main.ts?raw";

const page = (path: string): SitePage => SITE_PAGES.find((p) => p.path === path) as SitePage;
const indexed = SITE_PAGES.filter((p) => p.indexed);
const attrOf = (html: string, re: RegExp): string[] => [...html.matchAll(re)].map((m) => m[1]);
const ldOf = (html: string): Record<string, unknown>[] =>
  attrOf(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g).map((j) => JSON.parse(j) as Record<string, unknown>);
const unesc = (s: string): string => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

describe("the one list", () => {
  it("holds /, /pricing, /terms, /privacy (indexed) and the 404 page (not), each key and path once", () => {
    expect(indexed.map((p) => p.path)).toEqual(["/", "/pricing", "/terms", "/privacy"]);
    expect(NOT_FOUND_PAGE.indexed).toBe(false);
    expect(new Set(SITE_PAGES.map((p) => p.key)).size).toBe(SITE_PAGES.length);
    expect(new Set(SITE_PAGES.map((p) => p.path)).size).toBe(SITE_PAGES.length);
    expect(SITE_PAGES.map(sitePageFile)).toEqual(["index.html", "pricing.html", "terms.html", "privacy.html", "404.html"]);
    expect(SITE_ORIGIN).toBe("https://trov.dev");
  });

  it("every title and description is the page's own: unique, and each a sentence the page says", () => {
    expect(new Set(SITE_PAGES.map((p) => p.title)).size).toBe(SITE_PAGES.length);
    expect(new Set(SITE_PAGES.map((p) => p.description)).size).toBe(SITE_PAGES.length);
    for (const p of SITE_PAGES) expect(p.description.length, p.key).toBeLessThanOrEqual(160);
    // the hero's lede, word for word
    expect(landingView({ dark: false, signInOpen: false, seen: new Set() })).toContain(`<p class="site-st site-hero-lede" style="--d:520ms;">${page("/").description}</p>`);
    // the legal ledes, as each document opens
    for (const kind of ["terms", "privacy"] as const) {
      const p = page(`/${kind}`);
      expect(p.title).toBe(`${LEGAL_DOCS[kind].title} · Trov`);
      expect(LEGAL_DOCS[kind].lede.startsWith(p.description.replace(/\.$/, ""))).toBe(true);
    }
    expect(NOT_FOUND_LEDE.startsWith(NOT_FOUND_PAGE.description)).toBe(true);
  });

  it("the pricing description is the plan and price tables, as the pricing page shows them", () => {
    const d = page("/pricing").description;
    const html = pricingView(false);
    expect(d).toBe(`Free for up to ${PLANS.free.entitlements.seats} people, Pro at ${formatPrice(PRICING.team.price as number)} ${PRICING.team.per}, and Enterprise with custom pricing. Every plan is all of Trov.`);
    expect(d).toBe("Free for up to 3 people, Pro at $10 per seat / month, and Enterprise with custom pricing. Every plan is all of Trov.");
    for (const id of OFFERED_PLAN_IDS) expect(html).toContain(PLANS[id].name);
    expect(html).toContain(`<span class="site-plan-amt">${formatPrice(PRICING.team.price as number)}</span> <span class="site-plan-per">${PRICING.team.per}</span>`);
    expect(html).toContain("Custom pricing");
    expect(html).toContain("Every plan is all of Trov.");
    expect(d).not.toMatch(/Personal|Team\b/); // the legacy plan, and Pro's old name
  });
});

describe("head tags", () => {
  it("every indexed page: title, description, a self-referencing absolute canonical, Open Graph and Twitter", () => {
    for (const p of indexed) {
      const head = siteHead(p);
      const url = siteUrl(p.path);
      expect(attrOf(head, /<title>([^<]*)<\/title>/g), p.key).toEqual([p.title]);
      expect(attrOf(head, /<meta name="description" content="([^"]*)"/g).map(unesc), p.key).toEqual([p.description]);
      expect(attrOf(head, /<link rel="canonical" href="([^"]*)"/g), p.key).toEqual([url]);
      expect(url.startsWith("https://trov.dev/")).toBe(true);
      const og = (prop: string) => attrOf(head, new RegExp(`<meta property="og:${prop}" content="([^"]*)"`, "g")).map(unesc);
      const tw = (name: string) => attrOf(head, new RegExp(`<meta name="twitter:${name}" content="([^"]*)"`, "g")).map(unesc);
      expect(og("type")).toEqual(["website"]);
      expect(og("site_name")).toEqual(["Trov"]);
      expect(og("title")).toEqual([p.title]);
      expect(og("description")).toEqual([p.description]);
      expect(og("url")).toEqual([url]);
      expect(og("image")).toEqual([siteUrl(`/og/${p.key === "index" ? "home" : p.key}.png`)]);
      expect(og("image:width")).toEqual(["1200"]);
      expect(og("image:height")).toEqual(["630"]);
      expect(og("image:alt")[0].length).toBeGreaterThan(10);
      expect(tw("card")).toEqual(["summary_large_image"]);
      expect(tw("title")).toEqual([p.title]);
      expect(tw("description")).toEqual([p.description]);
      expect(tw("image")).toEqual(og("image"));
      expect(head).not.toContain("noindex");
    }
  });

  it("the 404 page: noindex, and nothing to share or to call canonical", () => {
    const head = siteHead(NOT_FOUND_PAGE);
    expect(head).toContain('<meta name="robots" content="noindex" />');
    expect(head).not.toMatch(/canonical|og:|twitter:|ld\+json/);
  });

  it("SoftwareApplication JSON-LD on / and /pricing only: Free and Pro from the tables, per seat per month; Enterprise (no price) left out", () => {
    for (const p of SITE_PAGES) expect(ldOf(siteHead(p)).length, p.key).toBe(p.path === "/" || p.path === "/pricing" ? 1 : 0);
    const ld = ldOf(siteHead(page("/")))[0];
    expect(ld).toEqual(softwareApplicationLd());
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("SoftwareApplication");
    expect(ld.url).toBe("https://trov.dev/");
    const offers = ld.offers as Record<string, unknown>[];
    expect(offers.map((o) => o.name)).toEqual(["Free", "Pro"]);
    expect(offers[0]).toMatchObject({ "@type": "Offer", price: 0, priceCurrency: PRICE_CURRENCY });
    expect(offers[0].priceSpecification).toBeUndefined();
    expect(offers[1]).toMatchObject({
      "@type": "Offer", price: PRICING.team.price, priceCurrency: "USD",
      priceSpecification: {
        "@type": "UnitPriceSpecification", price: 10, priceCurrency: "USD", unitText: "per seat / month",
        referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitText: "seat" }, billingDuration: "P1M",
      },
    });
    expect(JSON.stringify(ld)).not.toMatch(/Enterprise|aggregateRating|review/);
  });
});

describe("the built documents", () => {
  it("each public page carries its words, its head and the script that boots it — and one canonical", () => {
    const words: Record<string, string[]> = {
      "/": ['<h1 class="site-hero-h"><span class="site-st st-word" style="--d:80ms;">Shared</span>', "Agents load what your team already decided", "Agents propose, people decide.", "Orient, work, record.", "One product, three sizes."],
      "/pricing": ["One product, three sizes.", ">Choose Pro</a>", "What counts as a seat?"],
      "/terms": ["<h1 class=\"site-legal-h\">Terms of Service</h1>", "The service</span>"],
      "/privacy": ["<h1 class=\"site-legal-h\">Privacy Policy</h1>", "What we collect</span>"],
      "/404": ["Page not found", "Go to the home page"],
    };
    const boot: Record<string, string | null> = { "/": "/src/main.ts", "/pricing": "/src/pricing-page.ts", "/terms": "/src/legal-page.ts", "/privacy": "/src/legal-page.ts", "/404": null };
    for (const p of SITE_PAGES) {
      const html = sitePageHtml(p);
      expect(html.startsWith("<!doctype html>\n<html lang=\"en\">"), p.key).toBe(true);
      expect(html, p.key).toContain(siteHead(p));
      expect(html.match(/rel="canonical"/g)?.length ?? 0, p.key).toBe(p.indexed ? 1 : 0);
      for (const w of words[p.path]) expect(html, `${p.key}: ${w}`).toContain(w);
      const src = boot[p.path];
      if (src) expect(html, p.key).toContain(`<script type="module" src="${src}"></script>`);
      else expect(html, p.key).not.toContain('type="module"');
      expect(html.split(THEME_BOOT).length - 1, p.key).toBe(1);
    }
    expect(sitePageHtml(page("/terms"))).toContain('<div id="legal" data-doc="terms">');
    expect(sitePageHtml(NOT_FOUND_PAGE)).toContain('<link rel="stylesheet" href="/src/trov.css" />');
  });

  it("the landing is EXACTLY main.ts's signed-out paint (plus the theme boot), so the boot morphs it in place", () => {
    const html = sitePageHtml(page("/"));
    const app = render(initialState());
    expect(html).toContain(`<div id="app">${withThemeBoot(app)}</div>`);
    expect(app).toContain('data-morph="landing"');
    // main.ts: on that markup it paints the landing at once — no "Signing you in…", no /auth/me
    expect(mainSrc).toContain(`} else if (mount.querySelector(':scope > * > [data-morph="landing"]')) {`);
    const branch = mainSrc.slice(mainSrc.indexOf(`} else if (mount.querySelector(':scope > * > [data-morph="landing"]')) {`), mainSrc.indexOf("} else {\n  // Show \"verifying\""));
    expect(branch).toContain("showSignedOut();");
    expect(branch).not.toContain("getMe(");
  });

  it("the hero's words are on the page from the first paint: settled, never waiting on the script", () => {
    const app = render(initialState());
    expect(app).toContain('<div class="site-rv rv-static site-hero-in is-done">');
    expect(app).not.toContain('data-rv="hero-copy"');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    // their rise is CSS alone, and moves nothing but the transform
    expect(rules).toContain(".site-hero-in .site-st { animation:site-rise var(--fx-slow) var(--fx-ease) var(--d, 0ms) backwards; }");
    expect(rules).toContain("@keyframes site-rise { from { translate:var(--from); } }");
    // with no script at all, every other reveal shows settled
    expect(rules).toMatch(/@media \(scripting: none\) \{\s*\.site-rv, \.site-st \{ opacity:1 !important;/);
  });

  it("the theme boot is each root's first child, and paints the page in the stored theme before it is parsed", () => {
    expect(withThemeBoot('<div data-cnpy-theme="light" style="x"><p>a</p></div>')).toBe(`<div data-cnpy-theme="light" style="x">${THEME_BOOT}<p>a</p></div>`);
    expect(() => withThemeBoot("<p>a</p>")).toThrow();
    for (const key of ['localStorage.getItem("trov.theme")', 'localStorage.getItem("canopy.theme")', '"midnight"', "prefers-color-scheme: dark", 'setAttribute("data-cnpy-theme","dark")', "#1c1a16", "#f6f6f7"]) expect(THEME_BOOT).toContain(key);
  });

  it("the app shell can never pass for the home page: noindex, no canonical, no share tags, no landing words", () => {
    const shell = appShellHtml();
    expect(shell).toContain('<meta name="robots" content="noindex" />');
    expect(shell).toContain('<div id="app"></div>');
    expect(shell).toContain('<script type="module" src="/src/main.ts"></script>');
    expect(shell).toContain("<title>Trov</title>");
    expect(shell).not.toMatch(/canonical|og:|twitter:|ld\+json|meta name="description"/);
    expect(shell).not.toMatch(/Agents load what your team|site-hero/);
    expect(shell).not.toBe(sitePageHtml(page("/")));
  });

  it("the legal pages are their documents' renders, and every legal page has its document", () => {
    for (const p of SITE_PAGES.filter((x) => x.kind === "legal")) {
      const doc = LEGAL_DOCS[p.key as LegalKind];
      expect(doc, p.key).toBeDefined();
      expect(sitePageHtml(p)).toContain(legalView(doc, false));
    }
    expect(sitePageHtml(page("/pricing"))).toContain(pricingView(false));
    expect(sitePageHtml(NOT_FOUND_PAGE)).toContain(notFoundView());
  });
});

describe("what the assets binding is told", () => {
  it("_redirects: every other spelling of an indexed page goes to its one URL for good (301) — relative rules only", () => {
    const rules = assetRedirects().split("\n").filter((l) => l && !l.startsWith("#"));
    expect(rules).toEqual([
      "/index / 301", "/index.html / 301",
      "/pricing.html /pricing 301", "/pricing/ /pricing 301",
      "/terms.html /terms 301", "/terms/ /terms 301",
      "/privacy.html /privacy 301", "/privacy/ /privacy 301",
    ]);
    for (const r of rules) expect(r.startsWith("/"), r).toBe(true); // the binding skips an absolute source
  });

  it("_headers: noindex on the app shell, the 404 page, and everything on a workers.dev address", () => {
    const h = assetHeaders();
    for (const rule of ["https://:version.:account.workers.dev/*", APP_SHELL_PATH, NOT_FOUND_PAGE.path]) expect(h).toContain(`\n${rule}\n  X-Robots-Tag: noindex`);
    for (const p of indexed) expect(h).not.toContain(`\n${p.path}\n`);
  });
});
