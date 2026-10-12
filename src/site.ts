// The public site, as the Worker answers for it (docs/architecture/web-ui.md › The public pages, for
// crawlers). The assets binding serves every built file BEFORE this Worker runs — /pricing, /terms,
// /privacy, the scripts, the images — except `/`, which wrangler.toml sends here first
// (`run_worker_first`). So this module answers:
//   • /robots.txt and /sitemap.xml, before any session check (the sitemap is SITE_PAGES' indexed pages);
//   • `/`: the prerendered landing page to a visitor with no session, and the app shell to one with
//     (`Vary: Cookie`), so a signed-in person never sees the landing before their organization;
//   • the 404 page, for an address nothing answers (src/index.ts decides that);
//   • one address per page: `www.` and plain http are redirected for good to the public origin;
//   • `X-Robots-Tag: noindex` on everything else the Worker serves — the app shell, the API, sign-in,
//     MCP, the webhooks, the signed links — and, on a host that is not PUBLIC_ORIGIN's (a Preview's
//     workers.dev address), on everything. No session is read here: a cookie's presence is a hint for
//     which public page to send, never an authorization, so this is not a fourth auth class.
import { APP_SHELL_PATH, NOT_FOUND_PAGE, SITE_ORIGIN, SITE_PAGES, siteUrl } from "@shared/site-pages";
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

export function robotsTxt(): string {
  return [
    `# ${SITE_ORIGIN.replace("https://", "")}: the public pages are in the sitemap. Everything else is the app,`,
    "# which answers with `X-Robots-Tag: noindex`; the paths below are its API, sign-in and token endpoints.",
    "User-agent: *",
    ...ROBOTS_DISALLOW.map((p) => `Disallow: ${p}`),
    "",
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
