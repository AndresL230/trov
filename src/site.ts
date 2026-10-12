// The public site, as the Worker answers for it (docs/architecture/web-ui.md › The public pages, for
// crawlers). The assets binding serves every built file BEFORE this Worker runs — /pricing, /terms,
// /privacy, the docs pages and their Markdown, /llms.txt, the scripts, the images — except `/`, which
// wrangler.toml sends here first (`run_worker_first`). So this module answers:
//   • /robots.txt and /sitemap.xml, before any session check (the sitemap is SITE_PAGES' indexed pages);
//   • `/`: the prerendered landing page to a visitor with no session, and the app shell to one with
//     (`Vary: Cookie`), so a signed-in person never sees the landing before their organization;
//   • `/docs/` and a browser's signed-out `/docs`: the first docs page (`/docs` itself stays the app's
//     cookie route — the old alias of an organization's docs list);
//   • the 404 page, for an address nothing answers (src/index.ts decides that);
//   • one address per page: `www.` and plain http are redirected for good to the public origin;
//   • `X-Robots-Tag: noindex` on everything else the Worker serves — the app shell, the API, sign-in,
//     MCP, the webhooks, the signed links — and, on a host that is not PUBLIC_ORIGIN's (a Preview's
//     workers.dev address), on everything. No session is read here: a cookie's presence is a hint for
//     which public page to send, never an authorization, so this is not a fourth auth class.
import { APP_SHELL_PATH, DOCS_HOME, NOT_FOUND_PAGE, SITE_ORIGIN, SITE_PAGES, siteUrl } from "@shared/site-pages";
import { SOURCE_PATH, sourceUrl } from "@shared/legal-core";
import { SESSION_COOKIE } from "./auth/session";
import { ONBOARD_COOKIE } from "./auth/onboard";
import type { Env } from "./env";

export const ROBOTS_TAG = "noindex";
export { APP_SHELL_PATH };

/** What robots.txt asks crawlers to skip: the API, sign-in and token endpoints and the session-gated
 *  bytes — nothing a page links to for a reader, and nothing that renders. The app's PAGES (`/<org>/`,
 *  `/platform`, `/billing/done`, `/billing/checkout`) are deliberately NOT here: a disallowed URL can still
 *  be indexed from a link, and a crawler that may not fetch it never sees its `noindex` — nor that it is no
 *  longer the home page's HTML (they used to be: the shell was index.html). They answer with the header
 *  instead. Each prefix is a route the Worker answers (test/site.test.ts). */
export const ROBOTS_DISALLOW: readonly string[] = [
  "/api/", "/auth/", "/oauth/", "/mcp", "/webhook/", "/u/", "/raw/", "/img/", "/avatar/", "/org-logo/",
];

// ── robots.txt: who may read what ────────────────────────────────────────────
// A crawler that matches a group BY NAME obeys only that group and ignores `User-agent: *` (RFC 9309
// §2.2.1). So every named group below repeats the same Disallow lines, then says `Allow: /` — Disallow
// first, for the parsers that take the first matching line rather than the longest. A group may name
// several user agents (one operator's crawlers share it).

/** AI TRAINING crawlers — the ONE switch. "allow" is today's behaviour (they were allowed through
 *  `User-agent: *`, and now by name with the same rules as everyone); "disallow" keeps them out of the
 *  whole site (`Disallow: /`) while search and assistants keep reading it. Change it here and deploy. */
export const AI_TRAINING_CRAWLERS: "allow" | "disallow" = "allow";

export interface CrawlerGroup { who: string; agents: readonly string[] }

/** Search engines, AI search and AI assistants fetching a page a person asked about: allowed, by name. */
export const SEARCH_CRAWLERS: readonly CrawlerGroup[] = [
  { who: "OpenAI: ChatGPT search, and pages a ChatGPT user asks for", agents: ["OAI-SearchBot", "ChatGPT-User"] },
  { who: "Anthropic: Claude's search, and pages a Claude user asks for", agents: ["Claude-SearchBot", "Claude-User"] },
  { who: "Perplexity: its search index, and pages a Perplexity user asks for", agents: ["PerplexityBot", "Perplexity-User"] },
  { who: "Google Search", agents: ["Googlebot"] },
  { who: "Microsoft Bing (and the search behind Copilot)", agents: ["Bingbot"] },
  { who: "Apple: Siri and Spotlight search", agents: ["Applebot"] },
  { who: "DuckDuckGo: DuckAssist answers", agents: ["DuckAssistBot"] },
];

/** Crawlers that collect pages to TRAIN models (each operator's search crawler above is a different
 *  agent, untouched by this list). Governed by AI_TRAINING_CRAWLERS. */
export const TRAINING_CRAWLERS: readonly CrawlerGroup[] = [
  { who: "OpenAI: model training", agents: ["GPTBot"] },
  { who: "Anthropic: model training", agents: ["ClaudeBot"] },
  { who: "Google: Gemini training (a robots.txt token only; Googlebot and Search are not affected)", agents: ["Google-Extended"] },
  { who: "Apple: model training (a robots.txt token only; Applebot and Siri are not affected)", agents: ["Applebot-Extended"] },
  { who: "Common Crawl: an open corpus many models are trained on", agents: ["CCBot"] },
];

const group = (agents: readonly string[], rules: readonly string[]): string[] => [...agents.map((a) => `User-agent: ${a}`), ...rules];

export function robotsTxt(training: "allow" | "disallow" = AI_TRAINING_CRAWLERS): string {
  const disallow = ROBOTS_DISALLOW.map((p) => `Disallow: ${p}`);
  const named = [...disallow, "Allow: /"];
  return [
    `# ${SITE_ORIGIN.replace("https://", "")}: the public pages are in the sitemap. Everything else is the app,`,
    "# which answers with `X-Robots-Tag: noindex`; the paths below are its API, sign-in and token endpoints.",
    `# Docs for people and agents: ${siteUrl(DOCS_HOME)} (an index for language models: ${siteUrl("/llms.txt")}).`,
    "# A crawler named in a group obeys only that group, so each group repeats the same rules.",
    "User-agent: *",
    ...disallow,
    "",
    "# Search engines, AI search and AI assistants: every public page.",
    ...SEARCH_CRAWLERS.flatMap((g) => [`# ${g.who}`, ...group(g.agents, named), ""]),
    training === "allow"
      ? "# AI training crawlers: ALLOWED, with the same rules as everyone (src/site.ts AI_TRAINING_CRAWLERS = \"allow\";\n# set it to \"disallow\" to keep them out of the whole site)."
      : "# AI training crawlers: NOT ALLOWED anywhere (src/site.ts AI_TRAINING_CRAWLERS = \"disallow\"; set it to \"allow\"\n# to let them read the public pages again). Search and assistants above are not affected.",
    ...TRAINING_CRAWLERS.flatMap((g) => [`# ${g.who}`, ...group(g.agents, training === "allow" ? named : ["Disallow: /"]), ""]),
    `Sitemap: ${siteUrl("/sitemap.xml")}`,
    "",
  ].join("\n");
}

export function sitemapXml(): string {
  const urls = SITE_PAGES.filter((p) => p.indexed).map((p) => `  <url><loc>${siteUrl(p.path)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The deployment's public host: PUBLIC_ORIGIN's (SITE_ORIGIN's without it). */
function publicHost(env: Pick<Env, "PUBLIC_ORIGIN">): string {
  try { if (env.PUBLIC_ORIGIN) return new URL(env.PUBLIC_ORIGIN).host; } catch { /* a malformed var: SITE_ORIGIN's */ }
  return new URL(SITE_ORIGIN).host;
}
/** Is this request on the deployment's own public host? A loopback host counts, so `wrangler dev`
 *  answers as production does. A Preview has PUBLIC_ORIGIN set to production's, so its own workers.dev
 *  address is not it. */
export function isCanonicalHost(url: URL, env: Pick<Env, "PUBLIC_ORIGIN">): boolean {
  return LOOPBACK.has(url.hostname) || url.host === publicHost(env);
}

/** One address per page: a GET / HEAD on `www.` + the public host, or in plain http on it, is sent for
 *  good to the same path and query on https and the public host. Everything else: null. This covers what
 *  the Worker serves (`/` included); the static files on www or plain http are the zone's to redirect
 *  (a Redirect Rule and "Always Use HTTPS": the assets binding's `_redirects` takes relative rules only). */
export function canonicalRedirect(request: Request, url: URL, env: Pick<Env, "PUBLIC_ORIGIN">): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const host = publicHost(env);
  if (url.host !== `www.${host}` && !(url.protocol === "http:" && url.host === host)) return null;
  return Response.redirect(`https://${host}${url.pathname}${url.search}`, 301);
}

/** The response with writable headers: a fetched or redirect Response's are immutable, so it is re-wrapped
 *  (the body streams through untouched). */
const writable = (res: Response): Response => new Response(res.body, res);

/** `X-Robots-Tag: noindex` on a response the Worker made. A WebSocket upgrade is left as it is. */
export function noindex(res: Response): Response {
  if (res.status === 101 || res.webSocket) return res;
  const out = writable(res);
  out.headers.set("X-Robots-Tag", ROBOTS_TAG);
  return out;
}

/** A built page from the assets binding, by name. Its html handling may answer `/x.html` with a redirect
 *  to `/x`; that one hop is followed here, so the browser's URL never changes. */
export async function assetPage(request: Request, env: Env, url: URL, path: string): Promise<Response> {
  const ask = (p: string) => env.ASSETS.fetch(new Request(new URL(p, url), { method: request.method, headers: request.headers }));
  const res = await ask(path);
  const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  return next ? ask(new URL(next, url).pathname) : res;
}

/** Is this request (probably) signed in — does it carry a session, or a sign-up in progress? Presence
 *  only, see the header. The local DEV_LOGIN bypass needs no cookie, so with it set every `/` is the app. */
export function carriesSession(request: Request, env: Pick<Env, "DEV_LOGIN">): boolean {
  if (env.DEV_LOGIN) return true;
  const cookie = request.headers.get("cookie") ?? "";
  return [SESSION_COOKIE, ONBOARD_COOKIE].some((name) => new RegExp(`(?:^|;)\\s*${name}=[^;]`).test(cookie));
}

/** Where someone typing the docs' address is sent: the first docs page. `/docs/` is no route at all; `/docs`
 *  is the app's cookie route (the old alias of an organization's docs list, JSON) — so only a BROWSER'S
 *  navigation there (it accepts text/html) with no session cookie is sent on. The SPA's own fetch, an old
 *  client and anyone signed in still reach the route and its 401 / JSON exactly as before. */
function docsEntry(request: Request, env: Pick<Env, "DEV_LOGIN">, url: URL): boolean {
  if (url.pathname === "/docs/") return true;
  return url.pathname === "/docs" && !carriesSession(request, env) && /\btext\/html\b/i.test(request.headers.get("accept") ?? "");
}

const text = (body: string, type: string, method: string): Response =>
  new Response(method === "HEAD" ? null : body, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=3600" } });

/**
 * The public answers that come before everything else, or null. GET / HEAD only:
 *   /robots.txt, /sitemap.xml, and `/` — the landing page signed out (indexable on the public host), the
 *   app shell with a session cookie or after a refused sign-in (`?denied=…`, a card the app draws).
 */
export async function sitePublic(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const canonical = isCanonicalHost(url, env);
  const tag = (res: Response) => (canonical ? res : noindex(res));
  if (url.pathname === "/robots.txt") return tag(text(robotsTxt(), "text/plain; charset=utf-8", request.method));
  if (url.pathname === "/sitemap.xml") return tag(text(sitemapXml(), "application/xml; charset=utf-8", request.method));
  if (docsEntry(request, env, url)) {
    const res = new Response(null, { status: 302, headers: { Location: DOCS_HOME, "Cache-Control": "no-store", Vary: "Cookie, Accept" } });
    return canonical ? res : noindex(res);
  }
  // `/source` (AGPL-3.0 §13): the assets binding's `_redirects` sends it to the deployed commit before this
  // Worker runs. Should that rule be missing, it still goes somewhere true — the repository.
  if (url.pathname === SOURCE_PATH) return noindex(new Response(null, { status: 302, headers: { Location: sourceUrl(null), "Cache-Control": "no-store" } }));
  if (url.pathname !== "/") return null;
  // Never the same HTML at two addresses: the shell is a different document (no landing, no canonical) and
  // is `noindex` here and at every other address it is served from.
  const app = carriesSession(request, env) || url.searchParams.has("denied");
  const res = writable(await assetPage(request, env, url, app ? APP_SHELL_PATH : "/"));
  res.headers.append("Vary", "Cookie");
  if (app || !canonical) res.headers.set("X-Robots-Tag", ROBOTS_TAG);
  return res;
}

/** The minimal page, should the built one be missing (a test's assets binding, a broken deploy). */
const FALLBACK_404 = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" /><title>Page not found · Trov</title></head><body style="font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 24px"><h1>Page not found</h1><p>There is no page at this address. <a href="/">Go to Trov</a>.</p></body></html>`;

/** An address nothing answers: 404, never indexed. A page for a person (GET / HEAD outside the API: the
 *  built not-found page), JSON for anything else. */
export async function notFound(request: Request, env: Env, url: URL): Promise<Response> {
  const headers = { "X-Robots-Tag": ROBOTS_TAG, "Cache-Control": "no-store" };
  const page = (request.method === "GET" || request.method === "HEAD") && url.pathname !== "/api" && !url.pathname.startsWith("/api/");
  if (!page) return Response.json({ error: "not_found" }, { status: 404, headers });
  // Asked fresh — never with the visitor's conditional headers, or a 304 would come back as an empty 404.
  const ask = (p: string) => env.ASSETS.fetch(new Request(new URL(p, url))).catch(() => null);
  let res = await ask(NOT_FOUND_PAGE.path);
  const next = res && res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  if (next) res = await ask(new URL(next, url).pathname);
  const body = res?.ok ? await res.text() : FALLBACK_404;
  return new Response(request.method === "HEAD" ? null : body, { status: 404, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
}
