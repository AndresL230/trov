// The artifacts HTTP surface (issue #52 · Track B): the JSON API under /api/artifacts,
// the raw route /raw/a/*, the token upload PUT (dispatched in src/index.ts), and the
// SSRF-guarded URL fetch — driven through the real app on Miniflare D1 + local R2.

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { app } from "../src/routes";
import worker from "../src/index";
import { run, nowIso } from "./helpers/db";
import { sessionGate, type AppEnv } from "../src/auth/principal";
import { sha256Hex } from "../src/tools/artifacts";
import { createArtifactsApp } from "../src/artifacts/routes";
import { RAW_CSP_ACTIVE, RAW_CSP_PASSIVE, HEIGHT_SCRIPT, injectHeightScript } from "../src/artifacts/raw";
import { checkFetchUrl, expandIpv6, fetchArtifactUrl, FetchUrlError, inferFetchedKind } from "../src/artifacts/fetch-url";
import { ARTIFACT_BINARY_CAP, ARTIFACT_TEXT_CAP, type ArtifactDetailDTO } from "@shared/artifacts";
import { cookieFor } from "./helpers/persons";
import { platformCtx, mintTokenFor, ORG_A } from "./helpers/tenant";

const ME = "AndresL230";
const YOU = "Jose-Gael-Cruz-Lopez";
const ORIGIN = "https://trov.test";

const req = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init, env);
const json = (method: string, body: unknown, cookie: string, extra: Record<string, string> = {}): RequestInit => ({
  method, headers: { cookie, "content-type": "application/json", ...extra }, body: JSON.stringify(body),
});
const ctx = { waitUntil() {}, passThroughException() {} } as unknown as ExecutionContext;
const workerFetch = (url: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${url}`, init), env, ctx);
const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);

async function create(cookie: string, o: Record<string, unknown> = {}): Promise<ArtifactDetailDTO> {
  const res = await req("/api/artifacts", json("POST", { title: "Auth flow", kind: "markdown", area: "auth", content: "# Auth\n\nhello", ...o }, cookie));
  expect(res.status).toBe(201);
  return res.json();
}

function multipart(fields: Record<string, string>, file?: { bytes: Uint8Array; name: string; type: string }): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (file) fd.set("file", new File([file.bytes], file.name, { type: file.type }));
  return fd;
}

async function seedTicket(title = "Fix login"): Promise<number> {
  const now = nowIso();
  const r = await run(env.DB, `INSERT INTO tickets (title, requester, status, created_at, updated_at) VALUES (?, 'meilin', 'in_progress', ?, ?)`, title, now, now);
  return r.meta.last_row_id as number;
}

// ── auth ─────────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("every route is session-gated (401), and a bearer token does not count", async () => {
    const { raw } = await mintTokenFor(ME);
    for (const [method, path] of [
      ["GET", "/api/artifacts"], ["GET", "/api/artifacts/x"], ["POST", "/api/artifacts"], ["PATCH", "/api/artifacts/x"],
      ["POST", "/api/artifacts/x/versions"], ["GET", "/api/artifacts/x/diff?a=1&b=1"], ["POST", "/api/artifacts/x/links"],
      ["POST", "/api/artifacts/x/links/remove"], ["POST", "/api/artifacts/x/ratify"], ["POST", "/api/artifacts/fetch"],
      ["POST", "/api/artifacts/upload-url"], ["GET", "/raw/a/x"],
    ] as const) {
      expect((await req(path, { method })).status, `${method} ${path}`).toBe(401);
      expect((await req(path, { method, headers: { authorization: `Bearer ${raw}` } })).status, `${method} ${path} bearer`).toBe(401);
    }
  });

  it("the raw route's lock-down headers are on the gate's 401 too", async () => {
    const res = await req("/raw/a/x");
    expect(res.status).toBe(401);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("content-security-policy")).toBe(RAW_CSP_PASSIVE);
  });
});

// ── create / list / get ──────────────────────────────────────────────────────

describe("create, list, get", () => {
  it("creates a text page (201, v1 draft) and reads it back by every version spelling", async () => {
    const cookie = await cookieFor(ME);
    const page = await create(cookie, { summary: "first cut", repo: "SaplingLearn/sapling" });
    expect(page).toMatchObject({ slug: "auth-flow", kind: "markdown", status: "draft", current_version: 1, author_id: ME, content: "# Auth\n\nhello", raw_url: "/raw/a/auth-flow@v1" });
    for (const path of ["/api/artifacts/auth-flow", "/api/artifacts/auth-flow?v=1", "/api/artifacts/auth-flow@v1", "/api/artifacts/auth-flow/v1"]) {
      const res = await req(path, { headers: { cookie } });
      expect(res.status, path).toBe(200);
      expect(((await res.json()) as ArtifactDetailDTO).version.version_no).toBe(1);
    }
    expect((await req("/api/artifacts/auth-flow?v=abc", { headers: { cookie } })).status).toBe(400);
    expect((await req("/api/artifacts/auth-flow@v1?v=2", { headers: { cookie } })).status).toBe(400);
  });

  it("lists with filters, newest first", async () => {
    const me = await cookieFor(ME);
    const you = await cookieFor(YOU);
    await create(me, { title: "Token rotation", area: "auth" });
    await create(you, { title: "Deploy map", kind: "mermaid", area: "infra", content: "graph TD; A-->B" });
    const list = async (qs: string) => ((await (await req(`/api/artifacts${qs}`, { headers: { cookie: me } })).json()) as { artifacts: { slug: string }[] }).artifacts.map((a) => a.slug);
    expect(await list("")).toEqual(["deploy-map", "token-rotation"]);
    expect(await list("?area=infra")).toEqual(["deploy-map"]);
    expect(await list("?kind=markdown")).toEqual(["token-rotation"]);
    expect(await list(`?author=${YOU.toLowerCase()}`)).toEqual(["deploy-map"]);
    expect(await list("?q=rotation")).toEqual(["token-rotation"]);
    expect(await list("?status=published")).toEqual([]);
    expect(await list("?area=all")).toHaveLength(2);
  });

  it("refuses malformed bodies with 400 (never 500)", async () => {
    const cookie = await cookieFor(ME);
    const bad = await req("/api/artifacts", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{nope" });
    expect(bad.status).toBe(400);
    const noArea = await req("/api/artifacts", json("POST", { title: "x", kind: "markdown", content: "y" }, cookie));
    expect(noArea.status).toBe(400);
    expect(((await noArea.json()) as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
    // A binary kind cannot be created from JSON.
    expect((await req("/api/artifacts", json("POST", { title: "x", kind: "pdf", area: "api", content: "y" }, cookie))).status).toBe(400);
    // Over the text cap → 413 from the repository.
    const huge = await req("/api/artifacts", json("POST", { title: "Big", kind: "markdown", area: "api", content: "a".repeat(ARTIFACT_TEXT_CAP + 1) }, cookie));
    expect(huge.status).toBe(413);
    // A text kind over multipart → 400.
    const mp = await req("/api/artifacts", { method: "POST", headers: { cookie }, body: multipart({ title: "x", kind: "html", area: "ui" }, { bytes: bytesOf("<p>"), name: "a.html", type: "text/html" }) });
    expect(mp.status).toBe(400);
  });
});

// ── 404 parity ───────────────────────────────────────────────────────────────

describe("404 parity", () => {
  it("missing, private-to-someone-else, version-0 and out-of-range are byte-identical on every route", async () => {
    const me = await cookieFor(ME);
    const you = await cookieFor(YOU);
    await create(you, { title: "Secret", visibility: "private" });
    await create(you, { title: "Public" });
    const pending = await req("/api/artifacts/upload-url", json("POST", { kind: "pdf", size_bytes: 10, sha256: "a".repeat(64), title: "Pending", area: "api" }, me));
    expect(pending.status).toBe(201);
    // The pending page is invisible even to its own author through the API.
    const cases = ["no-such-page", "secret", "pending", "public@v9", "Not A Slug"];
    const bodies = new Set<string>();
    for (const ref of cases) {
      const slug = ref.split("@")[0];
      const probes: [string, RequestInit][] = [
        [`/api/artifacts/${encodeURIComponent(ref)}`, { headers: { cookie: me } }],
        [`/raw/a/${encodeURIComponent(ref)}`, { headers: { cookie: me } }],
      ];
      if (!ref.includes("@")) {
        probes.push(
          [`/api/artifacts/${encodeURIComponent(slug)}`, json("PATCH", { title: "x" }, me)],
          [`/api/artifacts/${encodeURIComponent(slug)}/versions`, json("POST", { content: "x" }, me)],
          [`/api/artifacts/${encodeURIComponent(slug)}/diff?a=1&b=1`, { headers: { cookie: me } }],
          [`/api/artifacts/${encodeURIComponent(slug)}/links`, json("POST", { target_type: "pr", target_ref: "o/r#1" }, me)],
          [`/api/artifacts/${encodeURIComponent(slug)}/links/remove`, json("POST", { target_type: "pr", target_ref: "o/r#1" }, me)],
          [`/api/artifacts/${encodeURIComponent(slug)}/ratify`, json("POST", { version: 1 }, me)],
        );
      }
      for (const [path, init] of probes) {
        const res = await req(path, init);
        expect(res.status, path).toBe(404);
        bodies.add(await res.text());
      }
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: "not_found" })]);
    // …and the author of the private page does see it.
    expect((await req("/api/artifacts/secret", { headers: { cookie: you } })).status).toBe(200);
  });
});

// ── writes ───────────────────────────────────────────────────────────────────

describe("patch, versions, diff, links", () => {
  it("PATCH: fields by any reader, private by the author only, unknown keys refused", async () => {
    const me = await cookieFor(ME);
    const you = await cookieFor(YOU);
    await create(me);
    const r1 = await req("/api/artifacts/auth-flow", json("PATCH", { title: "Auth flow v2", area: "api", status: "published" }, you));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ slug: "auth-flow", title: "Auth flow v2", area: "api", status: "published" });
    expect((await req("/api/artifacts/auth-flow", json("PATCH", { visibility: "private" }, you))).status).toBe(403);
    expect((await req("/api/artifacts/auth-flow", json("PATCH", { visibility: "private" }, me))).status).toBe(200);
    expect((await req("/api/artifacts/auth-flow", json("PATCH", { status: "ratified" }, me))).status).toBe(400);
    expect((await req("/api/artifacts/auth-flow", json("PATCH", { slug: "x" }, me))).status).toBe(400);
  });

  it("versions: content (201), identical (200 unchanged), old_str/new_str, refusals; diff", async () => {
    const me = await cookieFor(ME);
    await create(me);
    const v2 = await req("/api/artifacts/auth-flow/versions", json("POST", { content: "# Auth\n\nhello again", summary: "again" }, me));
    expect(v2.status).toBe(201);
    expect(await v2.json()).toMatchObject({ unchanged: false, version_no: 2, page: { status: "published", current_version: 2 } });
    const same = await req("/api/artifacts/auth-flow/versions", json("POST", { content: "# Auth\n\nhello again" }, me));
    expect(same.status).toBe(200);
    expect(await same.json()).toMatchObject({ unchanged: true, version_no: 2 });
    const v3 = await req("/api/artifacts/auth-flow/versions", json("POST", { old_str: "again", new_str: "world", summary: "edit" }, me));
    expect(v3.status).toBe(201);
    expect(((await v3.json()) as { page: ArtifactDetailDTO }).page.content).toBe("# Auth\n\nhello world");
    expect((await req("/api/artifacts/auth-flow/versions", json("POST", { old_str: "absent", new_str: "x" }, me))).status).toBe(400);
    expect((await req("/api/artifacts/auth-flow/versions", json("POST", { content: "x", old_str: "y", new_str: "z" }, me))).status).toBe(400);
    const mp = await req("/api/artifacts/auth-flow/versions", { method: "POST", headers: { cookie: me }, body: multipart({}, { bytes: bytesOf("x"), name: "a.png", type: "image/png" }) });
    expect(mp.status).toBe(400);

    const diff = await req("/api/artifacts/auth-flow/diff?a=1&b=3", { headers: { cookie: me } });
    expect(diff.status).toBe(200);
    expect(await diff.json()).toMatchObject({ kind: "markdown", a: { version_no: 1, content: "# Auth\n\nhello", raw_url: "/raw/a/auth-flow@v1" }, b: { version_no: 3, content: "# Auth\n\nhello world" } });
    expect((await req("/api/artifacts/auth-flow/diff?a=1", { headers: { cookie: me } })).status).toBe(400);
    expect((await req("/api/artifacts/auth-flow/diff?a=0&b=1", { headers: { cookie: me } })).status).toBe(400);
    expect((await req("/api/artifacts/auth-flow/diff?a=1&b=9", { headers: { cookie: me } })).status).toBe(404);
  });

  it("links: add (idempotent), remove, and a missing ticket is 400", async () => {
    const me = await cookieFor(ME);
    const t = await seedTicket();
    await create(me, { repo: "SaplingLearn/sapling" });
    const add = await req("/api/artifacts/auth-flow/links", json("POST", { target_type: "ticket", target_ref: `#${t}` }, me));
    expect(add.status).toBe(200);
    expect(await add.json()).toMatchObject({ ticket_ids: [t], links: [{ target_type: "ticket", target_ref: String(t), label: "Fix login", meta: "in_progress" }] });
    await req("/api/artifacts/auth-flow/links", json("POST", { target_type: "ticket", target_ref: String(t) }, me));
    const pr = await req("/api/artifacts/auth-flow/links", json("POST", { target_type: "pr", target_ref: "#12" }, me));
    expect(((await pr.json()) as ArtifactDetailDTO).links.map((l) => l.target_ref)).toEqual([String(t), "SaplingLearn/sapling#12"]);
    expect((await req("/api/artifacts/auth-flow/links", json("POST", { target_type: "ticket", target_ref: "99999" }, me))).status).toBe(400);
    expect((await req("/api/artifacts/auth-flow/links", json("POST", { target_type: "bogus", target_ref: "1" }, me))).status).toBe(400);
    const rm = await req("/api/artifacts/auth-flow/links/remove", json("POST", { target_type: "ticket", target_ref: String(t) }, me));
    expect(((await rm.json()) as ArtifactDetailDTO).ticket_ids).toEqual([]);
    // Filter the library by ticket.
    await req("/api/artifacts/auth-flow/links", json("POST", { target_type: "ticket", target_ref: String(t) }, me));
    const listed = (await (await req(`/api/artifacts?ticket=${t}`, { headers: { cookie: me } })).json()) as { artifacts: { slug: string }[] };
    expect(listed.artifacts.map((a) => a.slug)).toEqual(["auth-flow"]);
  });
});

// ── ratify ───────────────────────────────────────────────────────────────────

describe("ratify — the session-only confirm gate", () => {
  it("draft → 409; not the latest → 409; the latest published → 200; any Authorization header → 403", async () => {
    const me = await cookieFor(ME);
    const you = await cookieFor(YOU);
    await create(me);
    expect((await req("/api/artifacts/auth-flow/ratify", json("POST", { version: 1 }, you))).status).toBe(409);
    await req("/api/artifacts/auth-flow/versions", json("POST", { content: "v2" }, me));
    expect((await req("/api/artifacts/auth-flow/ratify", json("POST", { version: 1 }, you))).status).toBe(409);
    expect((await req("/api/artifacts/auth-flow/ratify", json("POST", {}, you))).status).toBe(400);
    const { raw } = await mintTokenFor(YOU);
    const withBearer = await req("/api/artifacts/auth-flow/ratify", json("POST", { version: 2 }, you, { authorization: `Bearer ${raw}` }));
    expect(withBearer.status).toBe(403);
    const ok = await req("/api/artifacts/auth-flow/ratify", json("POST", { version: 2 }, you));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "ratified", ratified_version: 2, ratified_by: YOU });
    expect((await req("/api/artifacts/auth-flow/ratify", json("POST", { version: 2 }, you))).status).toBe(409);
  });
});

// ── raw ──────────────────────────────────────────────────────────────────────

describe("raw route", () => {
  const common = (res: Response) => {
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private");
  };

  it("html: active CSP, inline, the height script before </body> — but not in a download", async () => {
    const me = await cookieFor(ME);
    await create(me, { title: "Login mock", kind: "html", area: "ui", content: "<html><body><p>hi</p></body></html>" });
    for (const path of ["/raw/a/login-mock", "/raw/a/login-mock@v1", "/raw/a/login-mock/v1"]) {
      const res = await req(path, { headers: { cookie: me } });
      expect(res.status, path).toBe(200);
      common(res);
      expect(res.headers.get("content-security-policy")).toBe(RAW_CSP_ACTIVE);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("content-disposition")).toBe(`inline; filename="login-mock-v1.html"`);
      expect(await res.text()).toBe(`<html><body><p>hi</p>${HEIGHT_SCRIPT}</body></html>`);
    }
    const dl = await req("/raw/a/login-mock?download=1", { headers: { cookie: me } });
    expect(dl.headers.get("content-disposition")).toBe(`attachment; filename="login-mock-v1.html"`);
    expect(await dl.text()).toBe("<html><body><p>hi</p></body></html>");
    expect(HEIGHT_SCRIPT).toContain("trov:height");
    expect(HEIGHT_SCRIPT).toContain("ResizeObserver");
    expect(injectHeightScript("<p>no body</p>")).toBe(`<p>no body</p>${HEIGHT_SCRIPT}`);
    expect(injectHeightScript("<body>a</BODY >b</body>")).toBe(`<body>a</BODY >b${HEIGHT_SCRIPT}</body>`);
  });

  it("markdown / mermaid / svg: their content types, active CSP, no height script", async () => {
    const me = await cookieFor(ME);
    await create(me, { title: "Notes", content: "# notes</body>" });
    await create(me, { title: "Flow", kind: "mermaid", content: "graph TD; A-->B" });
    await create(me, { title: "Logo", kind: "svg", area: "ui", content: `<svg xmlns="http://www.w3.org/2000/svg"></svg>` });
    for (const [slug, ct, ext] of [["notes", "text/markdown; charset=utf-8", "md"], ["flow", "text/plain; charset=utf-8", "mmd"], ["logo", "image/svg+xml", "svg"]]) {
      const res = await req(`/raw/a/${slug}`, { headers: { cookie: me } });
      common(res);
      expect(res.headers.get("content-type")).toBe(ct);
      expect(res.headers.get("content-security-policy")).toBe(RAW_CSP_ACTIVE);
      expect(res.headers.get("content-disposition")).toBe(`inline; filename="${slug}-v1.${ext}"`);
      expect(await res.text()).not.toContain("trov:height");
    }
  });

  it("binary kinds via multipart: image/pdf inline, file attachment, passive CSP, bytes from R2", async () => {
    const me = await cookieFor(ME);
    const png = bytesOf("\x89PNG http-test-image");
    const res = await req("/api/artifacts", { method: "POST", headers: { cookie: me }, body: multipart({ title: "Screenshot", kind: "image", area: "ui", summary: "shot" }, { bytes: png, name: "shot.png", type: "image/png" }) });
    expect(res.status).toBe(201);
    const page = (await res.json()) as ArtifactDetailDTO;
    expect(page).toMatchObject({ slug: "screenshot", kind: "image", content: null, version: { content_type: "image/png", size_bytes: png.byteLength, sha256: await sha256Hex(png) } });
    const raw = await req("/raw/a/screenshot", { headers: { cookie: me } });
    common(raw);
    expect(raw.headers.get("content-security-policy")).toBe(RAW_CSP_PASSIVE);
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect(raw.headers.get("content-disposition")).toBe(`inline; filename="screenshot-v1.png"`);
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(png);
    const dl = await req("/raw/a/screenshot@v1?download=1", { headers: { cookie: me } });
    expect(dl.headers.get("content-disposition")).toBe(`attachment; filename="screenshot-v1.png"`);
    await dl.arrayBuffer();

    const pdf = bytesOf("%PDF-1.7 http-test-pdf");
    await req("/api/artifacts", { method: "POST", headers: { cookie: me }, body: multipart({ title: "Spec", kind: "pdf", area: "api" }, { bytes: pdf, name: "spec.pdf", type: "application/pdf" }) });
    const rp = await req("/raw/a/spec", { headers: { cookie: me } });
    expect(rp.headers.get("content-type")).toBe("application/pdf");
    expect(rp.headers.get("content-disposition")).toBe(`inline; filename="spec-v1.pdf"`);
    expect(rp.headers.get("content-security-policy")).toBe(RAW_CSP_PASSIVE);
    await rp.arrayBuffer();

    // A `file` declaring text/html is stored inert and always downloads.
    const f = bytesOf("<script>alert(1)</script> http-test-file");
    await req("/api/artifacts", { method: "POST", headers: { cookie: me }, body: multipart({ title: "Dump", kind: "file", area: "data" }, { bytes: f, name: "dump.tar.gz", type: "text/html" }) });
    const rf = await req("/raw/a/dump", { headers: { cookie: me } });
    expect(rf.headers.get("content-type")).toBe("application/octet-stream");
    expect(rf.headers.get("content-disposition")).toBe(`attachment; filename="dump-v1.gz"`);
    expect(rf.headers.get("content-security-policy")).toBe(RAW_CSP_PASSIVE);
    await rf.arrayBuffer();

    // A binary version over multipart.
    const png2 = bytesOf("\x89PNG http-test-image-2");
    const v2 = await req("/api/artifacts/screenshot/versions", { method: "POST", headers: { cookie: me }, body: multipart({ summary: "retake" }, { bytes: png2, name: "shot2.png", type: "image/png" }) });
    expect(v2.status).toBe(201);
    expect(await v2.json()).toMatchObject({ version_no: 2, page: { status: "published" } });
    const r2 = await req("/raw/a/screenshot", { headers: { cookie: me } });
    expect(new Uint8Array(await r2.arrayBuffer())).toEqual(png2);
    // The JSON text path on a binary page is 400.
    expect((await req("/api/artifacts/screenshot/versions", json("POST", { content: "x" }, me))).status).toBe(400);
  });

  it("multipart refusals: no file (400), empty (400), a declared length over the cap (413), bad links (400)", async () => {
    const me = await cookieFor(ME);
    expect((await req("/api/artifacts", { method: "POST", headers: { cookie: me }, body: multipart({ title: "x", kind: "pdf", area: "api" }) })).status).toBe(400);
    expect((await req("/api/artifacts", { method: "POST", headers: { cookie: me }, body: multipart({ title: "x", kind: "pdf", area: "api" }, { bytes: new Uint8Array(0), name: "a.pdf", type: "application/pdf" }) })).status).toBe(400);
    expect((await req("/api/artifacts", { method: "POST", headers: { cookie: me }, body: multipart({ title: "x", kind: "pdf", area: "api", links: "{nope" }, { bytes: bytesOf("%PDF"), name: "a.pdf", type: "application/pdf" }) })).status).toBe(400);
    const big = await req("/api/artifacts", {
      method: "POST",
      headers: { cookie: me, "content-type": "multipart/form-data; boundary=x", "content-length": String(ARTIFACT_BINARY_CAP + 2 * 1024 * 1024) },
      body: "--x--",
    });
    expect(big.status).toBe(413);
  });
});

// ── upload URL + PUT ─────────────────────────────────────────────────────────

describe("upload-url + the token PUT", () => {
  it("mints an absolute URL, the PUT streams into R2 without a session, and the token is single use", async () => {
    const me = await cookieFor(ME);
    const pdf = bytesOf("%PDF-1.7 http-upload-roundtrip");
    const mint = await req("/api/artifacts/upload-url", json("POST", { kind: "pdf", size_bytes: pdf.byteLength, sha256: await sha256Hex(pdf), filename: "rt.pdf", title: "Round trip", area: "api", summary: "up" }, me));
    expect(mint.status).toBe(201);
    const t = (await mint.json()) as { id: number; slug: string; upload_url: string; expires_at: string; token?: string };
    expect(t.slug).toBe("round-trip");
    expect(t.token).toBeUndefined();
    expect(t.upload_url).toMatch(/^https:\/\/trov\.test\/api\/artifacts\/upload\/[A-Za-z0-9_-]{43}$/);
    const path = new URL(t.upload_url).pathname;

    // Other methods on the token path: 405.
    const get = await workerFetch(path);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("PUT");

    const put = await workerFetch(path, { method: "PUT", body: pdf });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ unchanged: false, version_no: 1, page: { slug: "round-trip", kind: "pdf", status: "draft", author_id: ME } });
    const raw = await req("/raw/a/round-trip", { headers: { cookie: me } });
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(pdf);

    const again = await workerFetch(path, { method: "PUT", body: pdf });
    expect(again.status).toBe(410);
    expect(await again.json()).toMatchObject({ error: "gone" });
  });

  it("a new version of an existing page by slug; wrong size → 400 then retry; expiry → 410; unknown → 404; over the cap → 413", async () => {
    const me = await cookieFor(ME);
    const png = bytesOf("\x89PNG http-upload-v1");
    await req("/api/artifacts", { method: "POST", headers: { cookie: me }, body: multipart({ title: "Pic", kind: "image", area: "ui" }, { bytes: png, name: "pic.png", type: "image/png" }) });
    const png2 = bytesOf("\x89PNG http-upload-v2-bytes");
    const mint = await req("/api/artifacts/upload-url", json("POST", { slug: "pic", kind: "image", size_bytes: png2.byteLength, sha256: await sha256Hex(png2), content_type: "image/png" }, me));
    expect(mint.status).toBe(201);
    const path = new URL(((await mint.json()) as { upload_url: string }).upload_url).pathname;
    expect((await workerFetch(path, { method: "PUT", body: png2.slice(0, 4) })).status).toBe(400);
    const ok = await workerFetch(path, { method: "PUT", body: png2 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ version_no: 2 });

    // Kind mismatch at mint → 400; a bad sha → 400 with issues.
    expect((await req("/api/artifacts/upload-url", json("POST", { slug: "pic", kind: "pdf", size_bytes: 3, sha256: "b".repeat(64) }, me))).status).toBe(400);
    expect((await req("/api/artifacts/upload-url", json("POST", { slug: "pic", kind: "image", size_bytes: 3, sha256: "zz" }, me))).status).toBe(400);

    const m2 = await req("/api/artifacts/upload-url", json("POST", { slug: "pic", kind: "image", size_bytes: 3, sha256: "c".repeat(64), content_type: "image/png" }, me));
    const p2 = new URL(((await m2.json()) as { upload_url: string }).upload_url).pathname;
    await run(env.DB, `UPDATE artifact_upload_tokens SET expires_at = '2020-01-01T00:00:00.000Z'`);
    expect((await workerFetch(p2, { method: "PUT", body: "abc" })).status).toBe(410);

    const unknown = await workerFetch(`/api/artifacts/upload/${"A".repeat(43)}`, { method: "PUT", body: "abc" });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe(JSON.stringify({ error: "not_found" }));

    const big = await workerFetch(`/api/artifacts/upload/${"B".repeat(43)}`, { method: "PUT", body: "abc", headers: { "content-length": String(ARTIFACT_BINARY_CAP + 1) } });
    expect(big.status).toBe(413);
  });

  it("a non-PUT on a non-token path under /upload/ falls through to the app (a page slugged `upload`)", async () => {
    const me = await cookieFor(ME);
    await create(me, { title: "Upload" });
    const res = await workerFetch("/api/artifacts/upload/v1", { headers: { cookie: me } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ slug: "upload", version: { version_no: 1 } });
  });
});

// ── fetch URL (SSRF guard) ───────────────────────────────────────────────────

describe("SSRF guard", () => {
  it.each([
    "http://example.com/a.md",
    "ftp://example.com/a",
    "https://user:pw@example.com/",
    "https://localhost/",
    "https://api.localhost/",
    "https://printer.local/",
    "https://db.internal/",
    "https://127.0.0.1/",
    "https://127.9.9.9/",
    "https://2130706433/",       // decimal 127.0.0.1
    "https://0x7f.0.0.1/",       // hex
    "https://0.0.0.0/",
    "https://10.1.2.3/",
    "https://172.16.0.1/",
    "https://172.31.255.255/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/",
    "https://100.127.255.255/",
    "https://224.0.0.1/",
    "https://255.255.255.255/",
    "https://[::1]/",
    "https://[::]/",
    "https://[fc00::1]/",
    "https://[fd12:3456::1]/",
    "https://[fe80::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:a9fe:a9fe]/",
    "https://[64:ff9b::a00:1]/",
    "https://localhost./",
  ])("refuses %s", (u) => {
    expect(() => checkFetchUrl(u)).toThrow(FetchUrlError);
  });

  it.each([
    "https://example.com/a.md",
    "https://raw.githubusercontent.com/o/r/main/README.md",
    "https://8.8.8.8/",
    "https://172.32.0.1/",
    "https://100.128.0.1/",
    "https://[2606:4700::1111]/",
    "https://example.com:8443/x",
  ])("allows %s", (u) => {
    expect(checkFetchUrl(u).protocol).toBe("https:");
  });

  it("expands IPv6 literals", () => {
    expect(expandIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(expandIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(expandIpv6("1::2::3")).toBeNull();
    expect(expandIpv6("example.com")).toBeNull();
  });

  it("infers the kind from the content type, then the extension", () => {
    const u = (s: string) => new URL(s);
    expect(inferFetchedKind("text/html; charset=utf-8", u("https://x/a"))).toBe("html");
    expect(inferFetchedKind("image/svg+xml", u("https://x/a"))).toBe("svg");
    expect(inferFetchedKind("text/markdown", u("https://x/a"))).toBe("markdown");
    expect(inferFetchedKind("text/plain", u("https://x/a/README.md"))).toBe("markdown");
    expect(inferFetchedKind("text/plain", u("https://x/flow.mmd"))).toBe("mermaid");
    expect(inferFetchedKind("text/plain", u("https://x/notes.txt"))).toBeNull();
    expect(inferFetchedKind("text/plain", u("https://x/pic.png"))).toBeNull();
  });
});

describe("fetchArtifactUrl", () => {
  type Stub = (url: string, init?: RequestInit) => Response | Promise<Response>;
  const stub = (fn: Stub) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return fn(url, init);
    }) as typeof fetch;
    return { f, calls };
  };

  it("returns the text with its kind, never following a redirect itself", async () => {
    const { f, calls } = stub(() => new Response("# Hi", { headers: { "content-type": "text/markdown; charset=utf-8" } }));
    expect(await fetchArtifactUrl("https://example.com/a", f)).toEqual({
      url: "https://example.com/a", content: "# Hi", content_type: "text/markdown; charset=utf-8", size_bytes: 4, kind: "markdown",
    });
    expect(calls[0].init?.redirect).toBe("manual");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("re-checks every redirect hop: a hop to a private address is refused before it is fetched", async () => {
    const { f, calls } = stub((url) =>
      url === "https://example.com/a"
        ? new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } })
        : new Response("secret", { headers: { "content-type": "text/plain" } }));
    await expect(fetchArtifactUrl("https://example.com/a", f)).rejects.toMatchObject({ code: "bad_request" });
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/a"]);
  });

  it("follows up to 3 public hops (relative Locations resolved), refuses a 4th", async () => {
    const hop = (n: number) => new Response(null, { status: 301, headers: { location: `/hop${n}` } });
    const three = stub((url) => {
      const n = Number(/hop(\d)/.exec(url)?.[1] ?? 0);
      return n < 3 ? hop(n + 1) : new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
    });
    expect(await fetchArtifactUrl("https://example.com/start", three.f)).toMatchObject({ url: "https://example.com/hop3", kind: "svg" });
    const four = stub((url) => hop(Number(/hop(\d)/.exec(url)?.[1] ?? 0) + 1));
    await expect(fetchArtifactUrl("https://example.com/start", four.f)).rejects.toMatchObject({ code: "bad_request" });
    expect(four.calls).toHaveLength(4);
  });

  it("caps the read at ARTIFACT_TEXT_CAP (750 KB) (declared or streamed) → too_large", async () => {
    const declared = stub(() => new Response("x", { headers: { "content-type": "text/plain", "content-length": String(ARTIFACT_TEXT_CAP + 1) } }));
    await expect(fetchArtifactUrl("https://example.com/a", declared.f)).rejects.toMatchObject({ code: "too_large", status: 413 });
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(ctl) { pulled++; ctl.enqueue(new Uint8Array(64 * 1024)); },
    });
    const streamed = stub(() => new Response(endless, { headers: { "content-type": "text/plain" } }));
    await expect(fetchArtifactUrl("https://example.com/a", streamed.f)).rejects.toMatchObject({ code: "too_large" });
    expect(pulled).toBeLessThan(20);
    const exact = stub(() => new Response("a".repeat(ARTIFACT_TEXT_CAP), { headers: { "content-type": "text/plain" } }));
    expect((await fetchArtifactUrl("https://example.com/a", exact.f)).size_bytes).toBe(ARTIFACT_TEXT_CAP);
  });

  it("refuses non-text types (400); upstream errors and timeouts are 502", async () => {
    await expect(fetchArtifactUrl("https://example.com/a.png", stub(() => new Response("x", { headers: { "content-type": "image/png" } })).f)).rejects.toMatchObject({ code: "bad_request" });
    await expect(fetchArtifactUrl("https://example.com/a", stub(() => new Response(bytesOf("x"))).f)).rejects.toMatchObject({ code: "bad_request" });
    await expect(fetchArtifactUrl("https://example.com/a", stub(() => new Response("no", { status: 500, headers: { "content-type": "text/plain" } })).f)).rejects.toMatchObject({ code: "bad_gateway", status: 502 });
    await expect(fetchArtifactUrl("https://example.com/a", stub(() => { throw new DOMException("t", "TimeoutError"); }).f)).rejects.toMatchObject({ code: "bad_gateway", message: "the fetch timed out" });
  });

  it("POST /api/artifacts/fetch: JSON in, the DTO out, statuses mapped; nothing stored", async () => {
    const me = await cookieFor(ME);
    const { f } = stub(() => new Response("<p>hi</p>", { headers: { "content-type": "text/html" } }));
    const mini = new Hono<AppEnv>();
    mini.use("*", sessionGate);
    mini.route("/api/artifacts", createArtifactsApp({ fetchImpl: f }));
    const call = (body: unknown) => mini.request(`${ORIGIN}/api/artifacts/fetch`, json("POST", body, me), env);
    const ok = await call({ url: "https://example.com/mock.html" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ content: "<p>hi</p>", kind: "html", size_bytes: 9 });
    expect((await call({ url: "https://10.0.0.1/" })).status).toBe(400);
    expect((await call({ url: "not a url" })).status).toBe(400);
    expect((await call({})).status).toBe(400);
    // The production app refuses non-https before any fetch is attempted.
    expect((await req("/api/artifacts/fetch", json("POST", { url: "http://example.com/" }, me))).status).toBe(400);
    const list = (await (await req("/api/artifacts", { headers: { cookie: me } })).json()) as { artifacts: unknown[] };
    expect(list.artifacts).toEqual([]);
  });
});
