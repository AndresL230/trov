// The public site as the Worker answers for it (src/site.ts, docs/architecture/web-ui.md › The public
// pages, for crawlers): robots.txt and sitemap.xml before any session check; `/` as the prerendered
// landing signed out and the app shell (never indexed) with a session; one address per page (www and
// plain http redirect for good); `X-Robots-Tag: noindex` on everything else the Worker serves; and a
// real 404 for an address no route answers — while a REAL cookie route still answers 401 signed out.
import { describe, it, expect } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { app, isAppRoute } from "../src/routes";
import { AI_TRAINING_CRAWLERS, ROBOTS_DISALLOW, SEARCH_CRAWLERS, TRAINING_CRAWLERS, robotsTxt, sitemapXml } from "../src/site";
import { APP_SHELL_PATH, DOCS_HOME, DOCS_PAGES, NOT_FOUND_PAGE, SITE_ORIGIN, SITE_PAGES, SITE_PAGE_SEGMENTS, siteUrl } from "@shared/site-pages";
import { apiErrorHint } from "@shared/error-hints";
import { ORG_SLUG_RE, RESERVED_ORG_SLUGS } from "@shared/orgs";
import { cookieFor } from "./helpers/persons";
import wranglerToml from "../wrangler.toml?raw";

const LANDING = `<!doctype html><title>landing</title><link rel="canonical" href="${SITE_ORIGIN}/" /><div id="app">Shared memory for your team</div>`;
const SHELL = `<!doctype html><title>Trov</title><meta name="robots" content="noindex" /><div id="app"></div>`;
const NOT_FOUND = "<!doctype html><title>Page not found · Trov</title><h1>Page not found</h1>";

/** An env whose assets binding serves the three built pages by path, and records what it was asked. */
function site(over: Partial<typeof env> = {}): { env: typeof env; asked: { path: string; headers: Headers }[] } {
  const asked: { path: string; headers: Headers }[] = [];
  const ASSETS = {
    fetch: async (req: Request) => {
      const path = new URL(req.url).pathname;
      asked.push({ path, headers: req.headers });
      const html = path === "/" ? LANDING : path === APP_SHELL_PATH ? SHELL : path === NOT_FOUND_PAGE.path ? NOT_FOUND : null;
      return html === null ? new Response("nope", { status: 404 }) : new Response(html, { headers: { "content-type": "text/html", etag: '"abc"' } });
    },
  } as unknown as Fetcher;
  return { env: { ...env, ASSETS, ...over }, asked };
}
const fetchAt = (url: string, e: typeof env, init: RequestInit = {}) => worker.fetch(new Request(url, init), e, createExecutionContext());
const get = (path: string, e: typeof env, init: RequestInit = {}) => fetchAt(`https://trov.test${path}`, e, init);

describe("robots.txt and sitemap.xml", () => {
  it("are public, before any session check, with their content types", async () => {
    const s = site();
    const robots = await get("/robots.txt", s.env);
    expect(robots.status).toBe(200);
    expect(robots.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(robots.headers.get("x-robots-tag")).toBeNull();
    const body = await robots.text();
    expect(body).toBe(robotsTxt());
    expect(body).toContain("User-agent: *\n");
    for (const p of ROBOTS_DISALLOW) expect(body).toContain(`\nDisallow: ${p}\n`);
    expect(body).toContain(`\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`);

    const map = await get("/sitemap.xml", s.env);
    expect(map.status).toBe(200);
    expect(map.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await map.text()).toBe(sitemapXml());
    expect((await get("/robots.txt", s.env, { method: "HEAD" })).status).toBe(200);
    expect(s.asked).toEqual([]);
  });

  it("the sitemap lists every indexed page of the one list by its canonical URL, and nothing else", () => {
    const xml = sitemapXml();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(SITE_PAGES.filter((p) => p.indexed).map((p) => siteUrl(p.path)));
    expect(locs).toEqual([
      "https://trov.dev/", "https://trov.dev/pricing", "https://trov.dev/terms", "https://trov.dev/privacy", "https://trov.dev/refunds",
      "https://trov.dev/docs/setup", "https://trov.dev/docs/connect", "https://trov.dev/docs/concepts", "https://trov.dev/docs/mcp-tools", "https://trov.dev/docs/changelog",
    ]);
    expect(xml).not.toContain(NOT_FOUND_PAGE.path);
  });

  it("robots.txt asks crawlers to skip only routes the Worker answers, and never a public page", () => {
    const routes = app.routes.map((r) => r.path);
    const handledInIndex = ["/mcp", "/webhook/", "/u/"]; // src/index.ts, before the app
    for (const p of ROBOTS_DISALLOW) expect(handledInIndex.includes(p) || routes.some((r) => r.startsWith(p)), p).toBe(true);
    for (const page of SITE_PAGES) for (const p of ROBOTS_DISALLOW) expect(page.path.startsWith(p), `${page.path} vs ${p}`).toBe(false);
    // the app's pages stay crawlable, so a crawler can see their noindex (and that they are not the home page)
    for (const page of ["/acme/", "/platform", "/billing/done", "/billing/checkout"]) for (const p of ROBOTS_DISALLOW) expect(page.startsWith(p), `${page} vs ${p}`).toBe(false);
    // the built files a crawler needs to render a page are never disallowed
    for (const p of ROBOTS_DISALLOW) for (const asset of ["/assets/", "/og/", "/favicon.svg"]) expect(asset.startsWith(p)).toBe(false);
  });

  it("the canonical origin is the deployment's PUBLIC_ORIGIN, and `/` reaches the Worker first", () => {
    const vars = wranglerToml.slice(wranglerToml.indexOf("[vars]"), wranglerToml.indexOf("[observability]"));
    expect(/^PUBLIC_ORIGIN = "([^"]+)"$/m.exec(vars)?.[1]).toBe(SITE_ORIGIN);
    expect(wranglerToml).toMatch(/^\[assets\][\s\S]*?^run_worker_first = \["\/"\]$/m);
  });
});

// ── robots.txt, read the way crawlers read it ──────────────────────────────────
/** RFC 9309 groups: consecutive User-agent lines open a group, its rules follow; comments and blank
 *  lines end nothing. */
function robotsGroups(txt: string): { agents: string[]; rules: string[] }[] {
  const groups: { agents: string[]; rules: string[] }[] = [];
  let open = false;
  for (const raw of txt.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const at = line.indexOf(":");
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (key === "user-agent") {
      if (!open) groups.push({ agents: [], rules: [] });
      groups[groups.length - 1].agents.push(value);
      open = true;
    } else {
      if (key === "allow" || key === "disallow") groups[groups.length - 1].rules.push(`${key === "allow" ? "Allow" : "Disallow"}: ${value}`);
      open = false;
    }
  }
  return groups;
}
/** Which group a crawler obeys: the one naming it, else `*` (case-insensitive product token). */
const groupFor = (groups: ReturnType<typeof robotsGroups>, agent: string) =>
  groups.find((g) => g.agents.some((a) => a.toLowerCase() === agent.toLowerCase())) ?? groups.find((g) => g.agents.includes("*"))!;
/** Google's reading (the longest matching rule wins, Allow on a tie) and Python's urllib.robotparser's
 *  (the first matching rule wins): a well-ordered group answers the same under both. */
function allowed(rules: string[], path: string, how: "longest" | "first"): boolean {
  const hits = rules.map((r) => { const [k, v] = r.split(": "); return { allow: k === "Allow", v }; }).filter((r) => r.v !== "" && path.startsWith(r.v));
  if (!hits.length) return true;
  if (how === "first") return hits[0].allow;
  const best = Math.max(...hits.map((h) => h.v.length));
  return hits.some((h) => h.v.length === best && h.allow);
}

describe("robots.txt: AI search and assistants by name, training crawlers behind one switch", () => {
  const disallow = ROBOTS_DISALLOW.map((p) => `Disallow: ${p}`);

  it("every named group repeats the `*` group's rules (a crawler that matches a name ignores `*`), then allows the rest", () => {
    const groups = robotsGroups(robotsTxt());
    expect(groups[0]).toEqual({ agents: ["*"], rules: disallow });
    for (const g of groups.slice(1)) expect(g.rules, g.agents.join(", ")).toEqual([...disallow, "Allow: /"]);
    // each crawler is named once, so which group it obeys is never a guess
    const named = groups.slice(1).flatMap((g) => g.agents.map((a) => a.toLowerCase()));
    expect(new Set(named).size).toBe(named.length);
  });

  it("names the AI search, assistant and search-engine crawlers asked for, and the training ones", () => {
    const groups = robotsGroups(robotsTxt());
    const named = groups.flatMap((g) => g.agents);
    for (const a of ["OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "Perplexity-User", "Claude-SearchBot", "Claude-User", "Googlebot", "Bingbot"]) expect(named, a).toContain(a);
    for (const a of ["GPTBot", "ClaudeBot", "Google-Extended", "CCBot", "Applebot-Extended"]) expect(named, a).toContain(a);
    expect(SEARCH_CRAWLERS.flatMap((g) => g.agents)).not.toEqual(expect.arrayContaining(TRAINING_CRAWLERS.flatMap((g) => g.agents)));
  });

  it("each crawler, by its real user-agent string, may read every public page and the text files, and not the API", () => {
    const groups = robotsGroups(robotsTxt());
    const pages = [...SITE_PAGES.filter((p) => p.indexed).map((p) => p.path), ...SITE_PAGES.flatMap((p) => (p.markdown ? [p.markdown] : [])), "/llms.txt", "/llms-full.txt", "/og/home.png"];
    for (const [ua, token] of [
      ["OAI-SearchBot/1.0; +https://openai.com/searchbot", "OAI-SearchBot"],
      ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", "ChatGPT-User"],
      ["PerplexityBot/1.0", "PerplexityBot"], ["Claude-SearchBot/1.0", "Claude-SearchBot"], ["Claude-User/1.0", "Claude-User"],
      ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Googlebot"], ["GPTBot/1.1", "GPTBot"], ["ClaudeBot/1.0", "ClaudeBot"],
    ] as const) {
      expect(ua).toContain(token);
      const { rules } = groupFor(groups, token);
      for (const how of ["longest", "first"] as const) {
        for (const p of pages) expect(allowed(rules, p, how), `${token} ${how} ${p}`).toBe(true);
        for (const p of ["/api/orgs", "/mcp", "/auth/me", "/oauth/authorize"]) expect(allowed(rules, p, how), `${token} ${how} ${p}`).toBe(false);
      }
    }
  });

  it("training crawlers: allowed by default (as they were through `*`); ONE switch shuts them out and nothing else", () => {
    expect(AI_TRAINING_CRAWLERS).toBe("allow");
    expect(robotsTxt()).toBe(robotsTxt("allow"));
    const off = robotsGroups(robotsTxt("disallow"));
    for (const t of TRAINING_CRAWLERS.flatMap((g) => g.agents)) expect(groupFor(off, t).rules, t).toEqual(["Disallow: /"]);
    for (const s of SEARCH_CRAWLERS.flatMap((g) => g.agents)) expect(groupFor(off, s).rules, s).toEqual([...disallow, "Allow: /"]);
    expect(groupFor(off, "SomeOtherBot").rules).toEqual(disallow);
    expect(robotsTxt("disallow")).toContain('AI_TRAINING_CRAWLERS = "disallow"');
  });

  it("points crawlers at the docs and the language-model index", () => {
    expect(robotsTxt()).toContain(`# Docs for people and agents: ${siteUrl(DOCS_HOME)} (an index for language models: ${siteUrl("/llms.txt")}).`);
  });
});

describe("the docs' address: /docs is the app's cookie route, so a browser that types it is sent to the first page", () => {
  it("/docs/ for anyone, and /docs for a signed-out browser, go to the first docs page (302: it depends on who asks)", async () => {
    for (const [path, init] of [["/docs/", {}], ["/docs/", { headers: { cookie: "session=x" } }], ["/docs", { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } }]] as const) {
      const s = site();
      const res = await get(path, s.env, init as RequestInit);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe(DOCS_HOME);
      expect(res.headers.get("vary"), path).toBe("Cookie, Accept");
      expect(s.asked, path).toEqual([]);
    }
    expect(DOCS_HOME).toBe(DOCS_PAGES[0].path);
  });

  it("the route itself is untouched: a fetch (no text/html) gets its 401, with a hint; signed in, its JSON", async () => {
    const res = await get("/docs", site().env, { headers: { accept: "*/*" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", hint: apiErrorHint(401, "unauthorized") });
    const cookie = await cookieFor("AndresL230");
    const signedIn = await get("/docs", site().env, { headers: { cookie, accept: "text/html" } });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("content-type")).toContain("application/json");
  });
});

describe("`/`: the landing page signed out, the app shell with a session", () => {
  it("signed out — whatever the query — is the landing page, indexable, varying on the cookie", async () => {
    for (const q of ["", "?ref=hn", "?utm_source=x&utm_medium=y", "?contact=1", "?start=team"]) {
      const s = site();
      const res = await get(`/${q}`, s.env);
      expect(res.status, q).toBe(200);
      expect(await res.text(), q).toBe(LANDING);
      expect(res.headers.get("x-robots-tag"), q).toBeNull();
      expect(res.headers.get("vary"), q).toContain("Cookie");
      expect(s.asked.map((a) => a.path), q).toEqual(["/"]);
    }
  });

  it("with a session (or a sign-up in progress, a refused sign-in, or the local DEV_LOGIN) is the app shell — never indexed", async () => {
    const cookie = await cookieFor("AndresL230");
    for (const [name, path, init, over] of [
      ["session", "/", { headers: { cookie } }, {}],
      ["session among others", "/", { headers: { cookie: `theme=x; ${cookie}; other=1` } }, {}],
      ["onboard", "/", { headers: { cookie: "onboard=sealed" } }, {}],
      ["denied", "/?denied=1", {}, {}],
      ["DEV_LOGIN", "/", {}, { DEV_LOGIN: "AndresL230" }],
    ] as const) {
      const s = site(over as Partial<typeof env>);
      const res = await get(path, s.env, init as RequestInit);
      expect(res.status, name).toBe(200);
      expect(await res.text(), name).toBe(SHELL);
      expect(res.headers.get("x-robots-tag"), name).toBe("noindex");
      expect(res.headers.get("vary"), name).toContain("Cookie");
      expect(s.asked.map((a) => a.path), name).toEqual([APP_SHELL_PATH]);
    }
    // a cookie that merely ENDS in "session" is not one
    const s = site();
    expect(await (await get("/", s.env, { headers: { cookie: "mysession=1" } })).text()).toBe(LANDING);
  });

  it("no other address serves the landing page: every app page is the shell, with noindex", async () => {
    for (const path of ["/acme/", "/acme", "/platform", "/platform/", "/billing/done?session_id=cs_1", "/billing/checkout?plan=team"]) {
      const s = site();
      const res = await get(path, s.env);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe(SHELL);
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex");
      expect(s.asked.map((a) => a.path), path).toEqual([APP_SHELL_PATH]);
    }
  });
});

describe("one address per page", () => {
  it("www and plain http on the public host are redirected for good, path and query kept; GET / HEAD only", async () => {
    const s = site();
    for (const [from, to] of [
      ["https://www.trov.test/", "https://trov.test/"],
      ["https://www.trov.test/pricing?ref=x", "https://trov.test/pricing?ref=x"],
      ["http://trov.test/", "https://trov.test/"],
      ["http://trov.test/terms", "https://trov.test/terms"],
      ["http://www.trov.test/privacy", "https://trov.test/privacy"],
    ]) {
      const res = await fetchAt(from, s.env);
      expect(res.status, from).toBe(301);
      expect(res.headers.get("location"), from).toBe(to);
    }
    expect((await fetchAt("https://www.trov.test/", s.env, { method: "HEAD" })).status).toBe(301);
    expect((await fetchAt("https://www.trov.test/webhook/stripe", s.env, { method: "POST", body: "{}" })).status).not.toBe(301);
    expect(s.asked).toEqual([]);
  });

  it("a plain-http PUBLIC_ORIGIN (local dev on localhost) is served as it is, never sent to https", async () => {
    const s = site({ PUBLIC_ORIGIN: "http://localhost:8787" });
    for (const url of ["http://localhost:8787/", "http://localhost:8787/pricing", "http://localhost:8787/acme/"]) {
      expect((await fetchAt(url, s.env)).status, url).not.toBe(301);
    }
  });

  it("another host (a Preview's workers.dev address) is never indexed, the landing page included; loopback answers as production", async () => {
    for (const path of ["/", "/robots.txt", "/sitemap.xml", "/acme/"]) {
      const res = await fetchAt(`https://abc123-trov.someone.workers.dev${path}`, site().env);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex");
    }
    for (const origin of ["http://localhost:8787", "http://127.0.0.1:8787"]) {
      const res = await fetchAt(`${origin}/`, site().env);
      expect(res.status, origin).toBe(200);
      expect(await res.text()).toBe(LANDING);
      expect(res.headers.get("x-robots-tag"), origin).toBeNull();
    }
  });
});

describe("noindex on everything else the Worker serves", () => {
  it("the API, sign-in, OAuth, MCP and the signed links carry X-Robots-Tag: noindex — JSON and redirects too", async () => {
    for (const [path, status] of [
      ["/api/orgs", 401], ["/api/o/acme/docs", 401], ["/docs", 401], ["/auth/me", 401], ["/auth/login", 302],
      ["/oauth/authorize", 400], ["/mcp", 401], ["/u/not-a-token", 404], ["/o/acme/", 301], ["/billing/start?plan=team", 503 /* billing is off in the pool */],
      ["/.well-known/oauth-authorization-server", 200],
    ] as const) {
      const res = await get(path, site().env);
      expect(res.status, path).toBe(status);
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex");
    }
  });
});

describe("an address no route answers is a 404 — a real cookie route is still 401", () => {
  it("is the built not-found page, status 404 and noindex, asked fresh (never the visitor's conditional headers)", async () => {
    for (const path of ["/does/not/exist", "/acme/anything/else", "/help", "/guide", "/webhook/github", "/index.php", "/.env", "/robots.txt/x"]) {
      const s = site();
      const res = await get(path, s.env, { headers: { "if-none-match": '"abc"' } });
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex");
      expect(res.headers.get("etag"), path).toBeNull();
      expect(await res.text(), path).toBe(NOT_FOUND);
      expect(s.asked.map((a) => a.path), path).toEqual([NOT_FOUND_PAGE.path]);
      expect(s.asked[0].headers.get("if-none-match"), path).toBeNull();
    }
    const head = await get("/no/where", site().env, { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
  });

  it("is JSON under /api and for any method but GET / HEAD; without a built page, a plain one", async () => {
    for (const [path, method] of [["/api/nope", "GET"], ["/api", "GET"], ["/api/o/acme/nope", "GET"], ["/acme/", "POST"], ["/no/where", "POST"], ["/ingest", "PUT"]] as const) {
      const res = await get(path, site().env, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex");
      // …with what to do about it (src/error-hints.ts): the code and status unchanged.
      expect(await res.json(), path).toEqual({ error: "not_found", hint: apiErrorHint(404, "not_found") });
    }
    const none = { ...env, ASSETS: { fetch: async () => new Response("nope", { status: 404 }) } as unknown as Fetcher };
    const bare = await get("/no/where", none);
    expect(bare.status).toBe(404);
    expect(await bare.text()).toContain("Page not found");
  });

  it("a real cookie route, unauthenticated, is still the session gate's 401 — by its own method", async () => {
    for (const [path, method] of [["/api/orgs", "GET"], ["/auth/me", "GET"], ["/docs", "GET"], ["/docs", "HEAD"], ["/ingest", "POST"], ["/api/o/acme/tickets", "GET"], ["/feed", "GET"]] as const) {
      const res = await get(path, site().env, { method, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    // …and signed in, it answers.
    const cookie = await cookieFor("AndresL230");
    expect((await get("/api/orgs", site().env, { headers: { cookie } })).status).toBe(200);
  });

  it("isAppRoute: every handler matches by its method; middleware wildcards make nothing known", () => {
    expect(isAppRoute("GET", "/does/not/exist")).toBe(false);
    expect(isAppRoute("GET", "/api/o/acme/nope")).toBe(false); // `/api/o/:slug/*` is the tenant GATE, not a route
    expect(isAppRoute("GET", "/auth/nope")).toBe(false); // `/auth/*` is middleware too
    expect(isAppRoute("GET", "/ingest")).toBe(false);
    expect(isAppRoute("POST", "/ingest")).toBe(true);
    expect(isAppRoute("HEAD", "/docs")).toBe(true);
    expect(isAppRoute("OPTIONS", "/oauth/token")).toBe(true); // the CORS preflight
    let checked = 0;
    for (const r of app.routes) {
      if (r.method === "ALL" || r.path.includes("{")) continue;
      const sample = r.path.replace(/:[^/]+/g, "x1").replace(/\*/g, "x");
      expect(isAppRoute(r.method, sample), `${r.method} ${r.path}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(250);
  });
});

describe("no organization can take a public page's address", () => {
  it("every page of the site's list, the app shell and every directory of web/public is a reserved slug", () => {
    // A file at the root keeps its extension in its address (/favicon.svg), which no slug can be; a
    // directory (/guide/…, /og/…) and a built page (/pricing) take the bare name.
    const publicDir = Object.keys(import.meta.glob("../web/public/*/**")).map((k) => k.replace("../web/public/", "").split("/")[0]);
    expect(publicDir).toContain("guide");
    const taken = new Set([...SITE_PAGE_SEGMENTS, APP_SHELL_PATH.slice(1), ...publicDir, "og"]);
    const missing = [...taken].filter((s) => ORG_SLUG_RE.test(s) && !RESERVED_ORG_SLUGS.includes(s));
    expect(missing, "add these to RESERVED_ORG_SLUGS (shared/orgs.ts)").toEqual([]);
    expect(RESERVED_ORG_SLUGS).toEqual(expect.arrayContaining(["og", "404", "app", "pricing", "terms", "privacy"]));
  });
});
