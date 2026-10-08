// The SPA lives at /<slug>/: the Worker answers a GET for /<slug> or /<slug>/ — a valid org slug that
// is not reserved — with the app shell, fetched from the assets binding by name
// (canopy-multitenancy.md §11), never with a session gate's 401. The old /o/<slug>/… redirects there.
import { describe, it, expect } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { app } from "../src/routes";
import { ORG_SLUG_RE, RESERVED_ORG_SLUGS } from "@shared/orgs";

function withAssets(handler: (path: string) => Response): { env: typeof env; asked: string[] } {
  const asked: string[] = [];
  const ASSETS = { fetch: async (req: Request) => { const p = new URL(req.url).pathname; asked.push(p); return handler(p); } } as unknown as Fetcher;
  return { env: { ...env, ASSETS }, asked };
}
const shell = () => new Response("<!doctype html><div id=\"app\"></div>", { status: 200, headers: { "content-type": "text/html" } });
const get = (path: string, e: typeof env, method = "GET") => worker.fetch(new Request(`https://trov.test${path}`, { method }), e, createExecutionContext());

describe("GET /<slug>/ is the SPA shell", () => {
  it("answers /<slug>/ and /<slug> with index.html, signed out — and nothing deeper", async () => {
    for (const path of ["/acme/", "/acme", "/Acme/", "/saplinglearn/?github=connected"]) {
      const a = withAssets(shell);
      const res = await get(path, a.env);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain('id="app"');
      expect(a.asked).toEqual(["/index.html"]);
    }
    const a = withAssets(shell);
    expect((await get("/acme/anything/else", a.env)).status).toBe(401); // not a page: the route lives in the hash
    expect(a.asked).toEqual([]);
  });

  it("the old address /o/<slug>/… redirects for good to /<slug>/, keeping the query; a bad slug does not", async () => {
    const a = withAssets(shell);
    for (const [from, to] of [["/o/acme/", "/acme/"], ["/o/acme", "/acme/"], ["/o/Acme/anything/else", "/acme/"], ["/o/acme/?github=connected", "/acme/?github=connected"]]) {
      const res = await get(from, a.env);
      expect(res.status, from).toBe(301);
      expect(res.headers.get("location"), from).toBe(`https://trov.test${to}`);
    }
    expect((await get("/o/", a.env)).status).toBe(401);
    expect((await get("/o/api/", a.env)).status).toBe(401); // a reserved name was never an org
    expect((await get("/o/acme/", a.env, "POST")).status).toBe(401);
    expect(a.asked).toEqual([]);
  });

  it("an org can never shadow a route: every first path segment the app answers on is a reserved slug", async () => {
    const missing = new Set<string>();
    for (const r of app.routes) {
      const first = r.path.split("/")[1] ?? "";
      if (ORG_SLUG_RE.test(first) && !RESERVED_ORG_SLUGS.includes(first)) missing.add(first);
    }
    expect([...missing].sort(), "add these to RESERVED_ORG_SLUGS (shared/orgs.ts)").toEqual([]);
    // …so a reserved first segment still reaches the app (here: its session gate), never the shell.
    const a = withAssets(shell);
    for (const path of ["/feed", "/docs", "/roadmap", "/search", "/tickets", "/me", "/sync", "/repo", "/api", "/auth", "/billing"]) expect((await get(path, a.env)).status, path).not.toBe(200);
    expect(a.asked).toEqual([]);
  });

  it("answers /platform (the superadmin's area, outside any org) with the same shell — and nothing that merely starts with it", async () => {
    for (const path of ["/platform", "/platform/", "/platform/anything"]) {
      const a = withAssets(shell);
      const res = await get(path, a.env);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain('id="app"');
      expect(a.asked).toEqual(["/index.html"]);
    }
    const a = withAssets(shell);
    expect((await get("/platform/", a.env, "POST")).status).toBe(401);
    expect((await get("/api/platform/orgs", a.env)).status).toBe(401); // the data stays behind the session (and the superadmin check)
    expect(a.asked).toEqual([]);
  });

  it("follows the assets binding's own redirect of /index.html, so the URL in the browser stays", async () => {
    const a = withAssets((p) => (p === "/index.html" ? new Response(null, { status: 307, headers: { location: "/" } }) : shell()));
    const res = await get("/acme/", a.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(a.asked).toEqual(["/index.html", "/"]);
  });

  it("is GET / HEAD only: a POST there and the org API still meet the session gate", async () => {
    const a = withAssets(shell);
    expect((await get("/acme/", a.env, "POST")).status).toBe(401);
    expect((await get("/api/o/acme/me", a.env)).status).toBe(401);
    expect((await get("/orgs", a.env)).status).toBe(401);
    expect(a.asked).toEqual([]);
    expect((await get("/acme/", a.env, "HEAD")).status).toBe(200);
  });
});
