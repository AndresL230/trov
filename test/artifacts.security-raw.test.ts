// Artifacts — bytes on the wire, end to end (issue #52 · Track E):
// 7. raw-route headers per kind; 8. the R2 streaming round trip; 9. upload tokens;
// 10. the SSRF guard behind POST /api/artifacts/fetch.
// Everything goes through `worker.fetch` (src/index.ts). The URL fetch's outbound
// `fetch` is the global one, stubbed with vi.spyOn — the network is never touched.

import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run } from "../src/db";
import { mintToken } from "../src/auth/tokens";
import { ARTIFACT_UPLOAD_TTL_MS } from "@shared/artifacts";
import {
  NOT_FOUND, cookieFor, createBinary, createText, get, jsonInit, mcpCall, put, sha256Hex, uniqueBytes, uploadUrl, wf,
} from "./helpers/artifacts";

const ME = "raw-author";
const YOU = "raw-teammate";

// The spec's CSPs, spelled out literally (not imported) so a drift in src/ fails here.
const CSP_ACTIVE =
  "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
  "style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; " +
  "img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts";
const CSP_PASSIVE = "default-src 'none'; frame-ancestors 'self'";

const lockedDown = (res: Response, csp: string, label: string) => {
  expect(res.headers.get("x-frame-options"), label).toBe("SAMEORIGIN");
  expect(res.headers.get("x-content-type-options"), label).toBe("nosniff");
  expect(res.headers.get("cache-control"), label).toBe("private");
  expect(res.headers.get("content-security-policy"), label).toBe(csp);
};

// ── 7. raw headers per kind ──────────────────────────────────────────────────

describe("7 · raw route headers, per kind", () => {
  it("every kind: CSP, frame / sniff / cache lock-down, content type, inline vs attachment, <slug>-v<n>.<ext>, height script only in inline html", async () => {
    const me = await cookieFor(ME);
    const bodyish = "</body>"; // a text kind containing </body> must NOT get the script
    await createText(me, { title: "K html", kind: "html", area: "ui", content: "<html><body><p>x</p></body></html>" });
    await createText(me, { title: "K md", kind: "markdown", content: `# md ${bodyish}` });
    await createText(me, { title: "K svg", kind: "svg", area: "ui", content: `<svg xmlns="http://www.w3.org/2000/svg"><script>1</script>${bodyish}</svg>` });
    await createText(me, { title: "K mmd", kind: "mermaid", content: `graph TD; A-->B %% ${bodyish}` });
    const png = uniqueBytes("raw-png"), pdf = uniqueBytes("raw-pdf"), bin = uniqueBytes("raw-file");
    await createBinary(me, { title: "K img", kind: "image", area: "ui" }, { bytes: png, name: "a.png", type: "image/png" });
    await createBinary(me, { title: "K pdf", kind: "pdf", area: "api" }, { bytes: pdf, name: "a.pdf", type: "application/pdf" });
    await createBinary(me, { title: "K file", kind: "file", area: "data" }, { bytes: bin, name: "dump.csv", type: "text/csv" });

    const table: [slug: string, csp: string, type: string, ext: string, inline: boolean][] = [
      ["k-html", CSP_ACTIVE, "text/html; charset=utf-8", "html", true],
      ["k-md", CSP_ACTIVE, "text/markdown; charset=utf-8", "md", true],
      ["k-svg", CSP_ACTIVE, "image/svg+xml", "svg", true],
      ["k-mmd", CSP_ACTIVE, "text/plain; charset=utf-8", "mmd", true],
      ["k-img", CSP_PASSIVE, "image/png", "png", true],
      ["k-pdf", CSP_PASSIVE, "application/pdf", "pdf", true],
      ["k-file", CSP_PASSIVE, "text/csv", "csv", false],
    ];
    for (const [slug, csp, type, ext, inline] of table) {
      for (const path of [`/raw/a/${slug}`, `/raw/a/${slug}@v1`, `/raw/a/${slug}/v1`]) {
        const res = await get(path, me);
        expect(res.status, path).toBe(200);
        lockedDown(res, csp, path);
        expect(res.headers.get("content-type"), path).toBe(type);
        expect(res.headers.get("content-disposition"), path).toBe(`${inline ? "inline" : "attachment"}; filename="${slug}-v1.${ext}"`);
        const text = await res.text();
        expect(text.includes("canopy:height"), path).toBe(slug === "k-html");
      }
      const dl = await get(`/raw/a/${slug}?download=1`, me);
      lockedDown(dl, csp, `${slug} download`);
      expect(dl.headers.get("content-disposition")).toBe(`attachment; filename="${slug}-v1.${ext}"`);
      expect(await dl.text()).not.toContain("canopy:height");
    }
    // The SPA frames a pdf WITHOUT a sandbox (Chrome draws no PDF in one), so a "pdf"
    // must never be served as anything a browser would run: an upload declaring
    // text/html with script-bearing bytes is still application/pdf + nosniff + the
    // passive CSP.
    await createBinary(me, { title: "K evil pdf", kind: "pdf", area: "api" }, { bytes: new TextEncoder().encode("<html><script>alert(1)</script></html>"), name: "x.html", type: "text/html" });
    const evil = await get("/raw/a/k-evil-pdf", me);
    expect(evil.status).toBe(200);
    lockedDown(evil, CSP_PASSIVE, "evil pdf");
    expect(evil.headers.get("content-type")).toBe("application/pdf");
    // the download of html is the stored bytes, untouched
    expect(await (await get("/raw/a/k-html?download=1", me)).text()).toBe("<html><body><p>x</p></body></html>");
    // a later version's download name carries its number
    await wf("/api/artifacts/k-md/versions", jsonInit("POST", { content: "# v2" }, me));
    expect((await get("/raw/a/k-md@v2?download=1", me)).headers.get("content-disposition")).toBe(`attachment; filename="k-md-v2.md"`);
    expect((await get("/raw/a/k-md?download=1", me)).headers.get("content-disposition")).toBe(`attachment; filename="k-md-v2.md"`);
  });

  it("html and svg opened TOP-LEVEL are sandboxed by the CSP itself (opaque origin — never Canopy's)", async () => {
    // The SPA frames html with sandbox="allow-scripts", but "Open in new tab" and a pasted
    // raw URL navigate to it directly; only a CSP `sandbox` keeps its script off our origin.
    const me = await cookieFor(ME);
    await createText(me, { title: "Top html", kind: "html", area: "ui", content: "<script>fetch('/api/artifacts')</script>" });
    await createText(me, { title: "Top svg", kind: "svg", area: "ui", content: `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>` });
    for (const slug of ["top-html", "top-svg"]) {
      const csp = (await get(`/raw/a/${slug}`, me)).headers.get("content-security-policy")!;
      const sandbox = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("sandbox"));
      expect(sandbox, slug).toBeDefined();
      expect(sandbox).not.toContain("allow-same-origin");
      expect(sandbox).not.toContain("allow-top-navigation");
      expect(sandbox).not.toContain("allow-popups");
    }
  });

  it("401 (no session, or a bearer) and 404 carry the passive lock-down too", async () => {
    const me = await cookieFor(ME);
    await createText(me, { title: "Hidden", visibility: "private" });
    const { raw } = await mintToken(env.DB, ME);
    for (const [label, init] of [["none", {}], ["bearer", { headers: { authorization: `Bearer ${raw}` } }]] as const) {
      const res = await wf("/raw/a/hidden", init);
      expect(res.status, label).toBe(401);
      lockedDown(res, CSP_PASSIVE, label);
    }
    const you = await cookieFor(YOU);
    for (const path of ["/raw/a/hidden", "/raw/a/nope", "/raw/a/hidden@v1?download=1", "/raw/a/Not%20A%20Slug"]) {
      const res = await get(path, you);
      expect(res.status, path).toBe(404);
      lockedDown(res, CSP_PASSIVE, path);
      expect(res.headers.get("content-disposition")).toBeNull();
      expect(await res.text()).toBe(NOT_FOUND);
    }
  });
});

// ── 8. R2 streaming ──────────────────────────────────────────────────────────

describe("8 · R2 streaming round trip", () => {
  it("upload-url → PUT bytes → raw GET returns identical bytes + the stored type; the object is artifacts/<sha256>", async () => {
    const me = await cookieFor(ME);
    const bytes = uniqueBytes("r2-roundtrip", 256 * 1024 + 7);
    for (let i = 64; i < bytes.byteLength; i++) bytes[i] = (i * 31) & 0xff;
    const sha = await sha256Hex(bytes);
    const t = await uploadUrl(me, { kind: "image", size_bytes: bytes.byteLength, sha256: sha, content_type: "image/webp", filename: "shot.webp", title: "Streamed", area: "ui", summary: "up" });
    expect(t.status).toBe(201);
    // stream the body in several chunks
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) { for (let o = 0; o < bytes.byteLength; o += 50_000) ctl.enqueue(bytes.slice(o, o + 50_000)); ctl.close(); },
    });
    const res = await put(t.path!, stream, { "content-length": String(bytes.byteLength) });
    expect(res.status).toBe(200);
    const landed = (await res.json()) as { page: { version: { sha256: string; content_type: string; size_bytes: number } } };
    expect(landed.page.version).toMatchObject({ sha256: sha, content_type: "image/webp", size_bytes: bytes.byteLength });

    const raw = await get("/raw/a/streamed", me);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("image/webp");
    expect(raw.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytes);

    const obj = await env.ARTIFACTS_BUCKET.get(`artifacts/${sha}`);
    expect(obj).not.toBeNull();
    expect(obj!.size).toBe(bytes.byteLength);
    expect(obj!.httpMetadata?.contentType).toBe("image/webp");
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(bytes);
    const row = await first<{ r2_key: string; content: string | null }>(env.DB, `SELECT r2_key, content FROM artifact_versions`);
    expect(row).toEqual({ r2_key: `artifacts/${sha}`, content: null });
    // a teammate reads the same bytes
    const you = await cookieFor(YOU);
    expect(new Uint8Array(await (await get("/raw/a/streamed@v1", you)).arrayBuffer())).toEqual(bytes);
  });

  it("a refused (wrong-hash) PUT never creates the object at the declared key", async () => {
    const me = await cookieFor(ME);
    const bytes = uniqueBytes("r2-refused");
    const sha = await sha256Hex(bytes);
    const t = await uploadUrl(me, { kind: "file", size_bytes: bytes.byteLength, sha256: sha, title: "Refused", area: "data" });
    const wrong = bytes.slice();
    wrong[wrong.byteLength - 1] ^= 0xff;
    expect((await put(t.path!, wrong)).status).toBe(400);
    expect(await env.ARTIFACTS_BUCKET.head(`artifacts/${sha}`)).toBeNull();
    expect(await env.ARTIFACTS_BUCKET.head(`artifacts/${await sha256Hex(wrong)}`)).toBeNull();
  });
});

// ── 9. upload tokens ─────────────────────────────────────────────────────────

describe("9 · upload tokens", () => {
  async function ticket(cookie: string, bytes: Uint8Array, o: Record<string, unknown> = {}) {
    const t = await uploadUrl(cookie, { kind: "file", size_bytes: bytes.byteLength, sha256: await sha256Hex(bytes), title: "Tok", area: "data", ...o });
    expect(t.status, t.text).toBe(201);
    return t;
  }

  it("single use: the second PUT is 410 and writes nothing", async () => {
    const me = await cookieFor(ME);
    const b = uniqueBytes("tok-single");
    const t = await ticket(me, b);
    expect((await put(t.path!, b)).status).toBe(200);
    const again = await put(t.path!, b);
    expect(again.status).toBe(410);
    expect(await again.json()).toMatchObject({ error: "gone" });
    expect(await all(env.DB, `SELECT version_no FROM artifact_versions`)).toEqual([{ version_no: 1 }]);
  });

  it("expiry: the TTL is 5 minutes; an expired token is 410 (and so is a token past expiry that failed once)", async () => {
    const me = await cookieFor(ME);
    const b = uniqueBytes("tok-expiry");
    const t = await ticket(me, b);
    const row = (await first<{ expires_at: string; created_at: string }>(env.DB, `SELECT expires_at, created_at FROM artifact_upload_tokens`))!;
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(ARTIFACT_UPLOAD_TTL_MS);
    expect(Date.parse(t.dto.expires_at)).toBe(Date.parse(row.expires_at));
    await run(env.DB, `UPDATE artifact_upload_tokens SET expires_at = ?`, new Date(Date.now() - 1000).toISOString());
    const res = await put(t.path!, b);
    expect(res.status).toBe(410);
    expect(await all(env.DB, `SELECT id FROM artifact_versions`)).toEqual([]);
    // the page never materialises
    expect((await get("/api/artifacts/tok", me)).status).toBe(404);
  });

  it("wrong length (short, long) or wrong hash → 400, and the SAME token still lands the right bytes before expiry", async () => {
    const me = await cookieFor(ME);
    const b = uniqueBytes("tok-retry", 4096);
    const t = await ticket(me, b);
    const wrong = b.slice(); wrong[100] ^= 1;
    const long = new Uint8Array(b.byteLength + 1); long.set(b);
    for (const [label, body] of [["short", b.slice(0, 10)], ["long", long], ["wrong hash", wrong], ["empty", new Uint8Array(0)]] as const) {
      const r = await put(t.path!, body);
      expect(r.status, label).toBe(400);
      expect(await r.json()).toMatchObject({ error: "bad_request" });
    }
    expect(await all(env.DB, `SELECT id FROM artifact_versions`)).toEqual([]);
    const ok = await put(t.path!, b);
    expect(ok.status).toBe(200);
    expect((await put(t.path!, b)).status).toBe(410);
  });

  it("the token acts as its principal only: a cookie on the PUT is ignored, and the principal's visibility is re-checked at the PUT", async () => {
    const me = await cookieFor(ME);
    const you = await cookieFor(YOU);
    // YOU versions ME's org page; the PUT carries ME's cookie — the version is still YOU's
    const b1 = uniqueBytes("tok-bound-1");
    await createBinary(me, { title: "Bound", kind: "file", area: "data" }, { bytes: b1, name: "a.bin", type: "application/octet-stream" });
    const b2 = uniqueBytes("tok-bound-2");
    const t2 = await ticket(you, b2, { slug: "bound" });
    expect((await put(t2.path!, b2, { cookie: me })).status).toBe(200);
    expect((await all<{ created_by: string }>(env.DB, `SELECT created_by FROM artifact_versions ORDER BY version_no`)).map((r) => r.created_by)).toEqual([ME, YOU]);

    // YOU mints again; ME then makes the page private → YOU's token no longer reaches it
    const b3 = uniqueBytes("tok-bound-3");
    const t3 = await ticket(you, b3, { slug: "bound" });
    expect((await wf("/api/artifacts/bound", jsonInit("PATCH", { visibility: "private" }, me))).status).toBe(200);
    const denied = await put(t3.path!, b3);
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe(NOT_FOUND);
    expect(await all(env.DB, `SELECT version_no FROM artifact_versions`)).toHaveLength(2);
    // …and it stays consumed (a later un-private does not revive it)
    await wf("/api/artifacts/bound", jsonInit("PATCH", { visibility: "org" }, me));
    expect((await put(t3.path!, b3)).status).toBe(410);

    // ME's own private page: ME's token works
    const b4 = uniqueBytes("tok-bound-4");
    const t4 = await ticket(me, b4, { title: "Mine private", visibility: "private" });
    expect((await put(t4.path!, b4)).status).toBe(200);
    expect((await get("/api/artifacts/mine-private", you)).status).toBe(404);
  });

  it("the token is never returned bare: not in upload-url, the MCP result, the PUT result, or any error; only its hash is stored", async () => {
    const me = await cookieFor(ME);
    const b = uniqueBytes("tok-bare");
    const t = await ticket(me, b);
    const token = t.path!.split("/").pop()!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(t.dto).sort()).toEqual(["expires_at", "id", "slug", "upload_url"]);
    expect(t.text.split(token).length - 1).toBe(1); // once, inside upload_url
    expect(t.dto.upload_url).toBe(`https://canopy.test/api/artifacts/upload/${token}`);

    const m = await mcpCall(ME, "upload_asset", { title: "Mcp tok", kind: "pdf", area: "api", repo: "", visibility: "org", size_bytes: 3, sha256: "9".repeat(64) });
    expect(Object.keys(m.body).sort()).toEqual(["expires_at", "id", "slug", "upload_url", "url", "warnings"]);
    const mTok = m.body.upload_url.split("/").pop();
    expect(m.text.split(mTok).length - 1).toBe(1);

    const stored = await all<{ token_hash: string }>(env.DB, `SELECT token_hash FROM artifact_upload_tokens`);
    expect(stored).toHaveLength(2);
    for (const s of stored) {
      expect(s.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect([token, mTok]).not.toContain(s.token_hash);
    }
    expect(stored.map((s) => s.token_hash).sort()).toEqual([await sha256Hex(token), await sha256Hex(mTok)].sort());

    const bodies: string[] = [];
    bodies.push(await (await put(t.path!, b.slice(0, 2))).text()); // 400
    bodies.push(await (await put(t.path!, b)).text());             // 200
    bodies.push(await (await put(t.path!, b)).text());             // 410
    bodies.push(await (await wf(t.path!, { method: "GET" })).text()); // 405
    for (const body of bodies) expect(body).not.toContain(token);
    // the page detail never carries it either
    expect(await (await get("/api/artifacts/tok", me)).text()).not.toContain(token);
  });

  it("any method but PUT on a token path is 405 Allow: PUT, and touches nothing", async () => {
    const me = await cookieFor(ME);
    const b = uniqueBytes("tok-405");
    const t = await ticket(me, b);
    for (const method of ["GET", "POST", "DELETE", "PATCH", "HEAD"]) {
      const r = await wf(t.path!, { method, headers: { cookie: me } });
      expect(r.status, method).toBe(405);
      expect(r.headers.get("allow")).toBe("PUT");
    }
    expect((await put(t.path!, b)).status).toBe(200);
  });

  it("an unknown token is the one 404; a malformed one too", async () => {
    for (const tok of ["A".repeat(43), "short", "x".repeat(200)]) {
      const r = await put(`/api/artifacts/upload/${tok}`, "abc");
      expect(r.status, tok).toBe(404);
      expect(await r.text()).toBe(NOT_FOUND);
    }
  });
});

// ── 10. SSRF guard ───────────────────────────────────────────────────────────

describe("10 · SSRF guard (POST /api/artifacts/fetch through the Worker, outbound fetch stubbed)", () => {
  afterEach(() => vi.restoreAllMocks());

  type Handler = (url: string) => Response;
  function stubFetch(h: Handler) {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      return h(url);
    });
    return calls;
  }
  const doc = () => new Response("# ok", { headers: { "content-type": "text/markdown" } });
  const fetchUrl = async (url: string) => wf("/api/artifacts/fetch", jsonInit("POST", { url }, await cookieFor(ME)));

  it.each([
    "http://example.com/a.md",
    "https://localhost/a.md",
    "https://127.0.0.1/a.md",
    "https://10.0.0.8/a.md",
    "https://10.255.255.255/",
    "https://172.16.0.1/",
    "https://172.20.1.1/",
    "https://172.31.255.254/",
    "https://192.168.0.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/",
    "https://[fc00::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://0.0.0.0/",
    "https://user@example.com/a.md",
    "https://user:pass@example.com/a.md",
  ])("refuses %s with 400, before any outbound request", async (url) => {
    const calls = stubFetch(doc);
    const res = await fetchUrl(url);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request" });
    expect(calls).toEqual([]);
  });

  it("a redirect hop to a private IP is refused before it is fetched", async () => {
    for (const target of ["https://169.254.169.254/latest", "https://10.0.0.1/", "https://[::1]/x", "http://example.com/plain"]) {
      vi.restoreAllMocks();
      const calls = stubFetch((u) => (u === "https://example.com/start" ? new Response(null, { status: 302, headers: { location: target } }) : doc()));
      const res = await fetchUrl("https://example.com/start");
      expect(res.status, target).toBe(400);
      expect(calls, target).toEqual(["https://example.com/start"]);
    }
  });

  it("more than 3 redirects is refused; exactly 3 is followed", async () => {
    const hop = (u: string) => {
      const n = Number(/hop(\d+)/.exec(u)?.[1] ?? 0);
      return new Response(null, { status: 301, headers: { location: `https://example.com/hop${n + 1}` } });
    };
    const calls = stubFetch(hop);
    const res = await fetchUrl("https://example.com/hop0");
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(4);

    vi.restoreAllMocks();
    const calls3 = stubFetch((u) => (/hop3$/.test(u) ? doc() : hop(u)));
    const ok = await fetchUrl("https://example.com/hop0");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ url: "https://example.com/hop3", kind: "markdown" });
    expect(calls3).toHaveLength(4);
  });

  it("an allowed https text URL comes back as the DTO, fetched with redirect: manual, and nothing is stored", async () => {
    const seen: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", { headers: { "content-type": "image/svg+xml" } });
    });
    const res = await fetchUrl("https://example.com/logo.svg");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: "https://example.com/logo.svg", content: "<svg xmlns='http://www.w3.org/2000/svg'/>", content_type: "image/svg+xml", size_bytes: 41, kind: "svg",
    });
    expect(seen[0].redirect).toBe("manual");
    expect(await all(env.DB, `SELECT id FROM artifact_pages`)).toEqual([]);
  });

  it("the fetch route is session-only: a bearer alone is 401 and never fetches", async () => {
    await cookieFor(ME); // seeds the person the token belongs to
    const calls = stubFetch(doc);
    const { raw } = await mintToken(env.DB, ME);
    const res = await wf("/api/artifacts/fetch", jsonInit("POST", { url: "https://example.com/a.md" }, undefined, { authorization: `Bearer ${raw}` }));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });
});
