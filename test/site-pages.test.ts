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
  APP_SHELL_PATH, DOCS_PAGES, LLMS_FULL_TXT, LLMS_TXT, NOT_FOUND_PAGE, SITE_ORIGIN, SITE_PAGES, assetHeaders, assetRedirects, faqPageLd,
  siteHead, sitePageFile, siteUrl, softwareApplicationLd, type SitePage,
} from "../shared/site-pages";
import { OFFERED_PLAN_IDS, PLANS } from "../shared/plans";
import { PRICE_CURRENCY, PRICING, formatPrice } from "../shared/pricing";
import { THEME_BOOT, appShellHtml, sitePageHtml, withThemeBoot } from "../web/src/site-prerender";
import { initialState, render } from "../web/src/render";
import { landingView } from "../web/src/landing";
import { pricingView } from "../web/src/pricing";
import { LEGAL_DOCS, legalView, type LegalKind } from "../web/src/legal";
import { NOT_FOUND_LEDE, notFoundView } from "../web/src/not-found";
import { AGENT_SNIPPET, CHAT_SECTION, CHAT_SNIPPET, MCP_URL, docsMarkdown, markdownFooter } from "../web/src/docs-content";
import { docsView, renderDocs } from "../web/src/docs";
import { mcpToolsMarkdown } from "../web/src/docs-tools";
import { changelogMarkdown, publicReleases } from "../web/src/docs-changelog";
import { RELEASES } from "../web/src/releases";
import { LLMS_SUMMARY, llmsFullTxt, llmsTxt, markdownPages } from "../web/src/llms";
import { landingQuestions, productQuestions } from "../web/src/site-questions";
import { pricingMarkdown, pricingQuestions } from "../web/src/pricing";
import { siteFiles } from "../web/src/site-prerender";
import { MCP_TOOLS, MCP_TOOL_NAMES } from "../shared/mcp-tools.generated";
import { MCP_TOOL_GROUPS, commonParams, groupProblems, isCommonParam, mcpToolCountPhrase, mcpToolCounts, toolParams, type McpToolDoc } from "../shared/mcp-tools-core";
import { MCP_ERROR_HINTS } from "../shared/error-hints";
import css from "../web/src/trov.css?raw";
import mainSrc from "../web/src/main.ts?raw";
import landingPageSrc from "../web/src/landing-page.ts?raw";
import { landingPageHtml } from "../web/src/landing-root";

const page = (path: string): SitePage => SITE_PAGES.find((p) => p.path === path) as SitePage;
const indexed = SITE_PAGES.filter((p) => p.indexed);
const attrOf = (html: string, re: RegExp): string[] => [...html.matchAll(re)].map((m) => m[1]);
const ldOf = (html: string): Record<string, unknown>[] =>
  attrOf(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g).map((j) => JSON.parse(j) as Record<string, unknown>);
const unesc = (s: string): string => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

describe("the one list", () => {
  it("holds /, /pricing, /terms, /privacy, /refunds, the five docs pages (indexed) and the 404 page (not), each key and path once", () => {
    expect(indexed.map((p) => p.path)).toEqual(["/", "/pricing", "/terms", "/privacy", "/refunds", "/docs/setup", "/docs/connect", "/docs/concepts", "/docs/mcp-tools", "/docs/changelog"]);
    expect(NOT_FOUND_PAGE.indexed).toBe(false);
    expect(new Set(SITE_PAGES.map((p) => p.key)).size).toBe(SITE_PAGES.length);
    expect(new Set(SITE_PAGES.map((p) => p.path)).size).toBe(SITE_PAGES.length);
    expect(SITE_PAGES.map(sitePageFile)).toEqual([
      "index.html", "pricing.html", "terms.html", "privacy.html", "refunds.html",
      "docs/setup.html", "docs/connect.html", "docs/concepts.html", "docs/mcp-tools.html", "docs/changelog.html", "404.html",
    ]);
    expect(SITE_ORIGIN).toBe("https://trov.dev");
  });

  it("every title and description is the page's own: unique, and each a sentence the page says", () => {
    expect(new Set(SITE_PAGES.map((p) => p.title)).size).toBe(SITE_PAGES.length);
    expect(new Set(SITE_PAGES.map((p) => p.description)).size).toBe(SITE_PAGES.length);
    for (const p of SITE_PAGES) expect(p.description.length, p.key).toBeLessThanOrEqual(160);
    // the hero's lede, word for word
    expect(landingView({ dark: false, signInOpen: false, seen: new Set() })).toContain(`<p class="site-st site-hero-lede" style="--d:520ms;">${page("/").description}</p>`);
    // the legal ledes, as each document opens
    for (const kind of ["terms", "privacy", "refunds"] as const) {
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
      // the page as Markdown, where it has one (docs and pricing), as an alternate of the canonical page
      expect(attrOf(head, /<link rel="alternate" type="text\/markdown" href="([^"]*)"/g), p.key).toEqual(p.markdown ? [siteUrl(p.markdown)] : []);
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
    // the built pages add only the landing's FAQPage (below)
    for (const p of SITE_PAGES) expect(ldOf(sitePageHtml(p)).map((x) => x["@type"]), p.key).toEqual(p.path === "/" ? ["SoftwareApplication", "FAQPage"] : p.path === "/pricing" ? ["SoftwareApplication"] : []);
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
      "/refunds": ["<h1 class=\"site-legal-h\">Refund and Cancellation Policy</h1>", "How to cancel</span>", "No refunds for partial periods."],
      "/404": ["Page not found", "Go to the home page"],
      "/docs/setup": ['<h1 class="site-legal-h">Set up Trov</h1>', "<h2>1. Sign in</h2>", "/plugin install trov@trov"],
      "/docs/connect": ["<h2>Cursor</h2>", "<h2>VS Code</h2>", "<h2>ChatGPT</h2>", "<h2>OpenAI Codex CLI</h2>", "<h2>Windsurf</h2>", "claude mcp add --transport http --scope user trov https://trov.dev/mcp"],
      "/docs/concepts": ["<h2>Live, staged, unpromoted, draft</h2>", "<code>staged_pending</code>"],
      "/docs/mcp-tools": ['<h3 id="query"><code>query</code></h3>', '<h3 id="update_plan"><code>update_plan</code></h3>', "<h2>Errors</h2>"],
      "/docs/changelog": ['<h1 class="site-legal-h">Changelog</h1>'],
    };
    const boot: Record<string, string | null> = {
      "/": "/src/landing-page.ts", "/pricing": "/src/pricing-page.ts", "/terms": "/src/legal-page.ts", "/privacy": "/src/legal-page.ts", "/refunds": "/src/legal-page.ts", "/404": null,
      ...Object.fromEntries(DOCS_PAGES.map((p) => [p.path, "/src/docs-page.ts"])),
    };
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
    // landing-page.ts (the page's own script): on that markup it paints the landing at once — no "Signing
    // you in…", no /auth/me, and none of the app's bundle (main.ts loads only for what the page hands it).
    expect(landingPageSrc).toContain(`!mount.querySelector(':scope > * > [data-morph="landing"]')`);
    expect(landingPageSrc).toContain('if (appOnly) void import("./main");');
    expect(landingPageSrc).not.toContain("getMe(");
    expect(landingPageSrc).not.toMatch(/^import[^;]*from "\.\/(main|render)"/m);
    // …and what it paints is the app's signed-out paint, tag for tag (landing-root.ts; whitespace aside).
    const tags = (s: string) => s.replace(/>\s+</g, "><").trim();
    expect(tags(landingPageHtml(initialState()))).toBe(tags(app));
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
      "/refunds.html /refunds 301", "/refunds/ /refunds 301",
      ...DOCS_PAGES.flatMap((p) => [`${p.path}.html ${p.path} 301`, `${p.path}/ ${p.path} 301`]),
      // AGPL-3.0 §13: the source link goes to the repository when the build knows no commit…
      "/source https://github.com/AndresL230/trov 302",
    ]);
    for (const r of rules) expect(r.startsWith("/"), r).toBe(true); // the binding skips an absolute source
    // …and to the deployed commit's tree when Workers Builds gives one (WORKERS_CI_COMMIT_SHA); junk is ignored.
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(assetRedirects(sha)).toContain(`\n/source https://github.com/AndresL230/trov/tree/${sha} 302\n`);
    expect(assetRedirects("not a sha; rm -rf")).toContain("\n/source https://github.com/AndresL230/trov 302\n");
  });

  it("_headers: noindex on the app shell, the 404 page, and everything on a workers.dev address", () => {
    const h = assetHeaders();
    for (const rule of ["https://:version.:account.workers.dev/*", APP_SHELL_PATH, NOT_FOUND_PAGE.path]) expect(h).toContain(`\n${rule}\n  X-Robots-Tag: noindex`);
    for (const p of indexed) expect(h).not.toContain(`\n${p.path}\n`);
  });

  it("_headers: hashed /assets/* are immutable for a year, /guide/* kept a week, and no other rule says Cache-Control", () => {
    const h = assetHeaders();
    expect(h).toContain("\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n");
    expect(h).toContain("\n/guide/*\n  Cache-Control: public, max-age=604800\n");
    // Read the file the way the binding does: a rule line, then its indented headers. A path matching several
    // rules gets every rule's headers (a header set twice is joined with a comma), so at most ONE rule may set
    // Cache-Control on any path — and none on a page, the app shell, the fonts or the text files.
    const rules: { pattern: string; headers: string[] }[] = [];
    for (const line of h.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("  ")) rules[rules.length - 1].headers.push(line.trim());
      else rules.push({ pattern: line, headers: [] });
    }
    const matches = (pattern: string, path: string): boolean => {
      const rel = pattern.replace(/^https:\/\/[^/]+/, ""); // a host rule's path (workers.dev: every path)
      return rel.endsWith("*") ? path.startsWith(rel.slice(0, -1)) : path === rel;
    };
    const cacheOf = (path: string): string[] =>
      rules.filter((r) => matches(r.pattern, path)).flatMap((r) => r.headers.filter((x) => x.startsWith("Cache-Control:")));
    expect(cacheOf("/assets/main-AbC123.js")).toEqual(["Cache-Control: public, max-age=31536000, immutable"]);
    expect(cacheOf("/assets/trov-9f8e7d.css")).toEqual(["Cache-Control: public, max-age=31536000, immutable"]);
    expect(cacheOf("/guide/board-dark-1720.webp")).toEqual(["Cache-Control: public, max-age=604800"]);
    for (const path of ["/", APP_SHELL_PATH, NOT_FOUND_PAGE.path, LLMS_TXT, LLMS_FULL_TXT, "/fonts/x.woff2", "/favicon.svg", ...SITE_PAGES.map((p) => p.path)])
      expect(cacheOf(path), path).toEqual([]);
    expect(rules.filter((r) => r.headers.some((x) => x.startsWith("Cache-Control:"))).map((r) => r.pattern)).toEqual(["/assets/*", "/guide/*"]);
  });

  it("_headers: each page's Markdown is UTF-8 text/markdown whose canonical is the page; llms.txt and llms-full.txt are UTF-8 text", () => {
    const h = assetHeaders();
    const md = SITE_PAGES.filter((p) => p.markdown);
    expect(md.map((p) => p.key)).toEqual(["pricing", ...DOCS_PAGES.map((p) => p.key)]);
    for (const p of md) expect(h, p.key).toContain(`\n${p.markdown}\n  Content-Type: text/markdown; charset=utf-8\n  Link: <${siteUrl(p.path)}>; rel="canonical"\n`);
    for (const f of [LLMS_TXT, LLMS_FULL_TXT]) expect(h).toContain(`\n${f}\n  Content-Type: text/plain; charset=utf-8\n`);
    // a text file is never noindexed by name (its canonical page is what gets indexed)
    expect(h).not.toMatch(/\.md\n {2}X-Robots-Tag/);
  });
});


// ── the docs: one Markdown text per page, rendered ───────────────────────────
const docsPage = (key: string): SitePage => DOCS_PAGES.find((p) => p.key === key) as SitePage;
const escText = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fences = (md: string): string[] => [...md.matchAll(/^```[a-z]*\n([\s\S]*?)\n```$/gm)].map((m) => m[1]);

describe("the docs pages: the HTML is the Markdown, rendered", () => {
  it("each page's Markdown has the docs' shape: its title, its description as the lede, then sections", () => {
    for (const p of DOCS_PAGES) {
      const md = docsMarkdown(p);
      const title = /^# (.+)\n\n/.exec(md)?.[1];
      expect(title, p.key).toBeTruthy();
      expect(p.title, p.key).toBe(`${title} · Trov docs`);
      expect(md.startsWith(`# ${title}\n\n${p.description}\n\n`), p.key).toBe(true);
      const doc = renderDocs(md);
      expect(doc.lede, p.key).toBe(p.description);
      expect(doc.sections.length, p.key).toBeGreaterThan(0);
    }
  });

  it("every heading and every code block of the Markdown is on the page, and the page says nothing the Markdown does not", () => {
    for (const p of DOCS_PAGES) {
      const md = docsMarkdown(p);
      const html = sitePageHtml(p);
      expect(html, p.key).toContain(docsView(p, md));
      const article = html.slice(html.indexOf('<article class="site-legal-text site-docs-text">'), html.indexOf("</article>"));
      const h2 = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]).filter((h) => !fences(md).some((f) => f.includes(`## ${h}`)));
      expect([...article.matchAll(/<h2>([\s\S]*?)<\/h2>/g)].length, p.key).toBe(h2.length);
      for (const h of h2) expect(html, `${p.key}: ${h}`).toMatch(new RegExp(`<a href="#[^"]+" data-docs-toc="[^"]+"><span>`));
      for (const code of fences(md)) expect(article, `${p.key}: ${code.slice(0, 40)}`).toContain(`<pre><code>${escText(code)}</code></pre>`);
      // the words: every paragraph's plain text (inline marks stripped) is in the page's text
      const text = article.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      for (const para of md.replace(/^```[a-z]*\n[\s\S]*?\n```$/gm, "").split(/\n\n/).slice(2)) {
        if (/^(```|#|\||- |\d\. |> )/.test(para)) continue;
        // outside code spans: a link is its text, emphasis is dropped; inside one, the text is as written
        const plain = para.split("`").map((seg, i) => (i % 2 ? seg : seg.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*/g, ""))).join("");
        expect(text, `${p.key}: ${plain.slice(0, 50)}`).toContain(plain);
      }
    }
  });

  it("the page is linked to its Markdown, which is the same text (plus where it lives)", () => {
    const files = siteFiles();
    for (const p of DOCS_PAGES) {
      expect(siteHead(p)).toContain(`<link rel="alternate" type="text/markdown" href="${siteUrl(p.markdown as string)}" />`);
      expect(files[(p.markdown as string).slice(1)], p.key).toBe(`${docsMarkdown(p).trim()}\n${markdownFooter(p)}`);
      expect(sitePageHtml(p)).toContain(`<a href="${p.markdown}">This page as Markdown</a>`);
    }
    expect(files["pricing.md"]).toBe(`${pricingMarkdown().trim()}\n${markdownFooter(page("/pricing"))}`);
    expect(Object.keys(files).sort()).toEqual([...DOCS_PAGES.map((p) => (p.markdown as string).slice(1)), "llms-full.txt", "llms.txt", "pricing.md"].sort());
  });

  it("raw HTML in the text is shown as text, never run; the site is linked by path, anything else in a new tab", () => {
    const doc = renderDocs("# T\n\nThe lede.\n\n## S\n\nA <script>alert(1)</script> and `<slug>`, [docs](https://trov.dev/docs/setup), [out](https://example.com).\n\n<img src=x onerror=alert(1)>");
    const html = doc.sections[0].html;
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<code>&lt;slug&gt;</code>");
    expect(html).toContain('<a href="/docs/setup">docs</a>');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener">out</a>');
    expect(() => renderDocs("No title\n\n## S")).toThrow();
  });

  it("the setup and connect pages give the real commands, endpoint and plan numbers — none typed twice", () => {
    const setup = docsMarkdown(docsPage("docs-setup"));
    const connect = docsMarkdown(docsPage("docs-connect"));
    expect(MCP_URL).toBe(`${SITE_ORIGIN}/mcp`);
    for (const md of [setup, connect]) expect(md).toContain("/plugin marketplace add AndresL230/trov\n/plugin install trov@trov");
    expect(connect).toContain(`claude mcp add --transport http --scope user trov ${MCP_URL}`);
    expect(setup).toContain(`Free is for up to ${PLANS.free.entitlements.seats} people; Pro is bought per seat, at ${formatPrice(PRICING.team.price as number)} ${PRICING.team.per}.`);
    // every client named, with its own config file and key
    for (const needle of ['"mcpServers"', ".cursor/mcp.json", ".vscode/mcp.json", '"servers"', '"type": "http"', "~/.codex/config.toml", "[mcp_servers.trov]", "bearer_token_env_var", "codex mcp login trov", "mcp_config.json", '"serverUrl"', "Add custom connector", "trov_mcp_"]) {
      expect(connect, needle).toContain(needle);
    }
    // the token path is said as it is: Settings no longer makes tokens
    expect(connect).toContain("Settings no longer creates tokens");
    // the agent's rules: orient, trust live, stage never confirm, record only when asked
    for (const needle of ["`query`", "`live`", "`record_session`", "Stage, never confirm", "only when asked", "`list_handoffs`"]) expect(AGENT_SNIPPET, needle).toContain(needle);
    expect(connect).toContain(AGENT_SNIPPET);
  });

  it("a chat with no repository has its own walkthrough and its own rules for the agent", () => {
    const setup = docsMarkdown(docsPage("docs-setup"));
    const connect = docsMarkdown(docsPage("docs-connect"));
    expect(connect).toContain(`## ${CHAT_SECTION}`);
    expect(setup).toContain(CHAT_SECTION);
    // the connector steps end on the check, and the section says what differs
    for (const needle of ["Add custom connector", "**manual** is already chosen", "`get_connection`", "`switch_org`", "Nothing reads `git`", "up to 1 MB"]) expect(connect, needle).toContain(needle);
    expect(connect).toContain(CHAT_SNIPPET);
    // the chat's rules never tell an agent to read a checkout it does not have
    expect(CHAT_SNIPPET).not.toContain("git remote");
    expect(CHAT_SNIPPET).not.toContain("on every Trov call");
    for (const needle of ["`get_connection`", "`switch_org`", "Never invent a repository", "`content_base64`", "`include_file`", "only when asked"]) expect(CHAT_SNIPPET, needle).toContain(needle);
    // and keep the rules that hold anywhere, word for word
    const shared = (md: string) => md.split("\n").filter((l) => /^- \*\*(Trust only|Stage, never confirm|Tickets: your lane)/.test(l));
    expect(shared(AGENT_SNIPPET)).toHaveLength(3);
    expect(shared(CHAT_SNIPPET)).toEqual(shared(AGENT_SNIPPET));
  });

  it("the concepts page names every authority flag a read returns", () => {
    const concepts = docsMarkdown(docsPage("docs-concepts"));
    for (const flag of ["live", "staged_pending", "unpromoted", "draft"]) expect(concepts, flag).toContain(`- \`${flag}\`:`);
  });
});

describe("the MCP tools reference is the server's own list", () => {
  const md = docsMarkdown(docsPage("docs-mcp-tools"));

  it("lists every registered tool under its group, with its description and arguments, word for word", () => {
    expect(groupProblems(MCP_TOOLS.map((t) => t.name))).toEqual({ ungrouped: [], unknown: [] });
    const common = commonParams(MCP_TOOLS);
    expect(common.map((c) => c.name)).toEqual(["repo", "org"]);
    for (const t of MCP_TOOLS) {
      expect(md, t.name).toContain(`### \`${t.name}\`\n\n${t.admin ? "**Admin only:**" : t.description}`);
      expect(md, t.name).toContain(t.description);
      for (const p of toolParams(t).filter((x) => !isCommonParam(t, x.name, common))) expect(md, `${t.name}.${p.name}`).toContain(`- \`${p.name}\` (${p.type}, ${p.required ? "required" : "optional"})`);
    }
    // in the groups' order
    const order = [...md.matchAll(/^### `([a-z_]+)`$/gm)].map((m) => m[1]);
    expect(order).toEqual(MCP_TOOL_GROUPS.flatMap((g) => g.tools));
  });

  it("says the server's own counts, and every error code with the hint the server sends", () => {
    const { everyone, adminOnly } = mcpToolCounts(MCP_TOOLS);
    expect([everyone, adminOnly]).toEqual([51, 1]);
    expect(md).toContain(`It gives **${everyone} tools** to every member, plus **${adminOnly}** to an organization's admins (${everyone + adminOnly} in all).`);
    for (const [code, hint] of Object.entries(MCP_ERROR_HINTS)) expect(md, code).toContain(`- \`${code}\`: ${hint}`);
  });

  it("is generated: a tool the server added would be on the page with nothing typed", () => {
    const extra: McpToolDoc = { name: "brand_new_tool", description: "Does a new thing.", admin: false, inputSchema: { type: "object", properties: { thing: { type: "string", description: "Which thing." } }, required: ["thing"] } };
    const out = mcpToolsMarkdown(docsPage("docs-mcp-tools"), [...MCP_TOOLS, extra]);
    expect(out).toContain(`It gives **${MCP_TOOLS.length} tools**`);
    // an ungrouped tool is not silently dropped from the count, and the group map is what places it
    expect(groupProblems([...MCP_TOOLS.map((t) => t.name), extra.name]).ungrouped).toEqual(["brand_new_tool"]);
  });

  it("the landing's MCP card counts and shows the same tools — no typed number", () => {
    expect(MCP_TOOL_NAMES).toEqual(MCP_TOOLS.map((t) => ({ name: t.name, admin: t.admin })));
    expect(mcpToolCountPhrase(MCP_TOOL_NAMES)).toBe("51 tools, plus 1 admin-only");
    const landing = landingView({ dark: false, signInOpen: false, seen: new Set() });
    expect(landing).toContain(`>${mcpToolCountPhrase(MCP_TOOL_NAMES)}</span>`);
    expect(landing).not.toContain("39 tools");
    for (const t of MCP_TOOL_NAMES) expect(landing, t.name).toMatch(new RegExp(`class="site-st st-pop" style="[^"]*">${t.name}</span>`));
    expect(landing).toContain('<a href="/docs/mcp-tools" class="site-agents-ref"');
    expect(landing).toContain('<a href="/docs/connect">Other clients, step by step</a>');
  });
});

describe("the changelog: the release notes, never the deploy steps or the patch log", () => {
  const md = docsMarkdown(docsPage("docs-changelog"));
  it("every shipped release, newest first, with its highlights and heads-up", () => {
    const shipped = publicReleases();
    expect(shipped.length).toBe(RELEASES.filter((r) => !r.unreleased).length);
    expect([...md.matchAll(/^## ([0-9.]+): /gm)].map((m) => m[1])).toEqual(shipped.map((r) => r.version));
    expect(md).not.toMatch(/\(versions /);
    for (const r of shipped) {
      // Just the date: the old pre-renumbering numbers (`formerly`) are the app's concern, not the changelog's.
      expect(md).toContain(`## ${r.version}: ${r.title}\n\nReleased ${r.date}. ${r.headline}`);
      for (const h of r.highlights) expect(md).toContain(`- ${h}`);
      for (const h of r.headsUp ?? []) expect(md).toContain(`- ${h}`);
    }
  });
  it("no ops line, no patch line, and nothing not yet deployed", () => {
    for (const r of RELEASES) {
      for (const line of [...(r.ops ?? []), ...r.patches.added, ...r.patches.changed, ...r.patches.fixed, ...r.patches.removed]) {
        if (r.highlights.includes(line) || (r.headsUp ?? []).includes(line)) continue;
        expect(md, line.slice(0, 60)).not.toContain(line);
      }
    }
    expect(md).not.toMatch(/Unreleased/);
    const draft = changelogMarkdown(docsPage("docs-changelog"), [{ version: "Unreleased", unreleased: true, date: "2099-01-01", title: "Not yet", headline: "h", highlights: ["secret"], patches: { added: [], changed: [], fixed: [], removed: [] } }]);
    expect(draft).not.toContain("Not yet");
  });
});

describe("/llms.txt and /llms-full.txt (llmstxt.org)", () => {
  it("llms.txt: the H1, a one-line summary, then sections of links to the Markdown, each with its one-line description", () => {
    const txt = llmsTxt();
    expect(txt.startsWith(`# Trov\n\n> ${LLMS_SUMMARY}\n\n`)).toBe(true);
    expect(LLMS_SUMMARY).not.toContain("\n");
    expect([...txt.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(["Docs", "Pricing", "Changelog", "Optional"]);
    for (const key of ["docs-setup", "docs-connect", "docs-concepts", "docs-mcp-tools", "pricing", "docs-changelog"]) {
      const p = SITE_PAGES.find((x) => x.key === key) as SitePage;
      expect(txt, key).toContain(`](${siteUrl(p.markdown as string)}): ${p.description}\n`);
    }
    for (const line of txt.split("\n").filter((l) => l.startsWith("- "))) expect(line).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)]+\): \S/);
    expect(txt).toContain(siteUrl(LLMS_FULL_TXT));
    expect(txt).toContain(MCP_URL);
  });

  it("llms-full.txt: the same head, then every Markdown page in full", () => {
    const full = llmsFullTxt();
    expect(full.startsWith(`# Trov\n\n> ${LLMS_SUMMARY}\n\n`)).toBe(true);
    for (const { page: p, markdown } of markdownPages()) expect(full, p.key).toContain(`Source: ${siteUrl(p.path)}\n\n${markdown.trim()}`);
    for (const t of MCP_TOOLS) expect(full, t.name).toContain(`### \`${t.name}\``);
    expect(siteFiles()[LLMS_TXT.slice(1)]).toBe(llmsTxt());
    expect(siteFiles()[LLMS_FULL_TXT.slice(1)]).toBe(full);
  });

  it("pricing.md is the pricing page's own tables and questions", () => {
    const md = pricingMarkdown();
    for (const id of OFFERED_PLAN_IDS) expect(md).toContain(`## ${PLANS[id].name}`);
    expect(md).toContain(`${formatPrice(PRICING.team.price as number)} ${PRICING.team.per}.`);
    for (const q of pricingQuestions(OFFERED_PLAN_IDS.map((id) => PLANS[id]), PRICING)) expect(md).toContain(`### ${q.q}`);
    expect(md).not.toMatch(/<a |<\/?p>/);
  });
});

describe("the landing's Questions are its FAQPage, and only there", () => {
  const visible = (html: string) => [...html.matchAll(/<details[^>]*><summary><h(\d)>([\s\S]*?)<\/h\1>[\s\S]*?<\/summary><div class="site-faq-a"><p>([\s\S]*?)<\/p><\/div><\/details>/g)].map((m) => ({ q: unesc(m[2]), a: m[3] }));

  it("the FAQPage JSON-LD is exactly the accordion the landing shows: the same questions and answers, in order", () => {
    const html = sitePageHtml(page("/"));
    const shown = visible(html);
    expect(shown.length).toBe(landingQuestions().length);
    expect(shown).toEqual(landingQuestions().map((x) => ({ q: unesc(x.q), a: x.a })));
    const faq = ldOf(html).find((x) => x["@type"] === "FAQPage") as Record<string, unknown>;
    expect(faq).toEqual(faqPageLd(landingQuestions()));
    const entities = faq.mainEntity as { name: string; acceptedAnswer: { text: string } }[];
    expect(entities.map((e) => unesc(e.name))).toEqual(shown.map((x) => x.q));
    expect(entities.map((e) => e.acceptedAnswer.text)).toEqual(shown.map((x) => x.a));
    // /pricing shows a part of the same list, and marks none of it up (one instance per site)
    expect(ldOf(sitePageHtml(page("/pricing"))).some((x) => x["@type"] === "FAQPage")).toBe(false);
  });

  it("answers what people ask: what it is, README / wiki, MCP clients, self-hosting, what Pro adds", () => {
    const qs = landingQuestions().map((x) => x.q);
    for (const q of ["What is Trov?", "How is it different from a README or a wiki?", "Does it work with Claude Code, Cursor and other MCP clients?", "Can we read the source, or run Trov ourselves?", "What does Pro add?"]) expect(qs, q).toContain(q);
    expect(qs.slice(0, productQuestions().length)).toEqual(productQuestions().map((x) => x.q));
    const clients = productQuestions()[2].a;
    expect(clients).toContain(`${SITE_ORIGIN}/mcp`);
    expect(clients).toContain('<a href="/docs/connect">');
    expect(clients).not.toMatch(/Windsurf|Zed|JetBrains/); // only clients whose sign-in Trov's OAuth server is known to accept
  });
});

describe("the home page's first words say what Trov is and who it is for", () => {
  it("the first text after the nav is the headline, then the one-sentence lede", () => {
    const app = render(initialState());
    const afterNav = app.slice(app.indexOf("</nav>"));
    const text = afterNav.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    expect(text.startsWith(`Shared memory for your team and its coding agents. ${page("/").description}`)).toBe(true);
  });
});
