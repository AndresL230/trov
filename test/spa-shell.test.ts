// The SPA lives at /o/<slug>/ (Phase 6): the Worker answers any GET under /o/ with the app shell,
// fetched from the assets binding by name (canopy-multitenancy.md §11), never with a session gate's 401.
import { describe, it, expect } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../src/index";

function withAssets(handler: (path: string) => Response): { env: typeof env; asked: string[] } {
  const asked: string[] = [];
  const ASSETS = { fetch: async (req: Request) => { const p = new URL(req.url).pathname; asked.push(p); return handler(p); } } as unknown as Fetcher;
  return { env: { ...env, ASSETS }, asked };
}
const shell = () => new Response("<!doctype html><div id=\"app\"></div>", { status: 200, headers: { "content-type": "text/html" } });
const get = (path: string, e: typeof env, method = "GET") => worker.fetch(new Request(`https://trov.test${path}`, { method }), e, createExecutionContext());

describe("GET /o/* is the SPA shell", () => {
  it("answers /o/<slug>/ and any deeper path with index.html, signed out", async () => {
    for (const path of ["/o/acme/", "/o/acme", "/o/acme/anything/else", "/o/"]) {
      const a = withAssets(shell);
      const res = await get(path, a.env);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain('id="app"');
      expect(a.asked).toEqual(["/index.html"]);
    }
  });

  it("follows the assets binding's own redirect of /index.html, so the URL in the browser stays", async () => {
    const a = withAssets((p) => (p === "/index.html" ? new Response(null, { status: 307, headers: { location: "/" } }) : shell()));
    const res = await get("/o/acme/", a.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(a.asked).toEqual(["/index.html", "/"]);
  });

  it("is GET / HEAD only, and only under /o/: a POST there and the org API still meet the session gate", async () => {
    const a = withAssets(shell);
    expect((await get("/o/acme/", a.env, "POST")).status).toBe(401);
    expect((await get("/api/o/acme/me", a.env)).status).toBe(401);
    expect((await get("/orgs", a.env)).status).toBe(401);
    expect(a.asked).toEqual([]);
    expect((await get("/o/acme/", a.env, "HEAD")).status).toBe(200);
  });
});
