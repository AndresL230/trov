// Agent access to artifacts (issue #52 · Track F): the signed download URL that
// artifact_get mints for every kind, the token-authenticated GET that serves it
// (src/artifacts/download.ts, dispatched from src/index.ts before the session gate),
// and the artifact_list MCP tool. MCP calls drive the REAL registered closures; the
// download goes through the real Worker fetch entry, against real D1 + local R2.

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker from "../src/index";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { consumeUploadToken, patchPage, sha256Hex } from "../src/tools/artifacts";
import { create_ticket } from "../src/tools/tickets";
import { hmacSeal } from "../src/auth/crypto";
import {
  DOWNLOAD_CSP, attachmentDisposition, handleArtifactDownload, isDownloadRequest, mintDownloadToken, verifyDownloadToken,
} from "../src/artifacts/download";
import { ARTIFACT_DOWNLOAD_TTL_MS } from "@shared/artifacts";
import { seedPerson } from "./helpers/persons";

const ME = "dl-author";
const YOU = "dl-teammate";
const ORIGIN = "https://trov.test";
const SECRET = "test-cookie-secret"; // COOKIE_SECRET in vitest.config.ts

type ToolRes = { content: Array<{ type: string; text: string }>; isError?: boolean };
const ctx = { waitUntil() {}, passThroughException() {} } as unknown as ExecutionContext;

async function call(handle: string, name: string, args: Record<string, unknown>): Promise<{ body: any; isError: boolean; text: string }> {
  await seedPerson(handle);
  const server = buildTrovMcpServer(env as unknown as Env, { handle });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const res = (await client.callTool({ name, arguments: args })) as ToolRes;
    return { body: JSON.parse(res.content[0].text), isError: !!res.isError, text: res.content[0].text };
  } finally {
    await client.close();
    await server.close();
  }
}

/** GET an absolute URL through the real Worker entry (no cookie, no bearer). */
const fetchUrl = (url: string, init: RequestInit = {}) => worker.fetch(new Request(url, init), env as unknown as Env, ctx);

const hex = async (buf: ArrayBuffer) => sha256Hex(new Uint8Array(buf));

async function textPage(handle: string, o: Record<string, unknown> = {}) {
  const r = await call(handle, "upload_asset", {
    title: "Checkout page", kind: "html", area: "ui", repo: "", visibility: "org",
    content: "<!doctype html><html><body><h1>Checkout — ünïcode ✓</h1><script>1</script></body></html>", ...o,
  });
  expect(r.isError).toBe(false);
  return r.body as { slug: string; id: number };
}

async function binaryPage(handle: string, bytes: Uint8Array, o: Record<string, unknown> = {}) {
  const sha = await sha256Hex(bytes);
  const r = await call(handle, "upload_asset", {
    title: "Logo", kind: "image", area: "ui", repo: "", visibility: "org",
    size_bytes: bytes.byteLength, sha256: sha, filename: "logo.png", ...o,
  });
  expect(r.isError).toBe(false);
  const token = String(r.body.upload_url).split("/").pop()!;
  await consumeUploadToken(env.DB, env.ARTIFACTS_BUCKET, token, new Response(bytes).body!);
  return { slug: r.body.slug as string, sha };
}

/** PNG-ish bytes including every high byte (not valid UTF-8), unique per call. */
function pngBytes(tag: string): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const all = Array.from({ length: 256 }, (_, i) => i);
  const t = [...new TextEncoder().encode(tag)];
  return new Uint8Array([...head, ...all, ...t, ...all.reverse()]);
}

// ── artifact_get's download fields ───────────────────────────────────────────

describe("artifact_get → download_url", () => {
  it("text kind: absolute signed URL; the GET returns the exact stored bytes; sha256 and size_bytes match", async () => {
    const { slug } = await textPage(ME);
    const g = await call(YOU, "artifact_get", { slug });
    expect(g.body.download_url).toMatch(new RegExp(`^${ORIGIN}/api/artifacts/download/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$`));
    const ttl = Date.parse(g.body.download_expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60_000);
    expect(ttl).toBeLessThanOrEqual(ARTIFACT_DOWNLOAD_TTL_MS);
    expect(g.body.download_filename).toBe(`${slug}-v1.html`);
    expect(g.body.sha256).toBe(g.body.version.sha256);

    const res = await fetchUrl(g.body.download_url);
    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(g.body.size_bytes);
    expect(await hex(buf)).toBe(g.body.sha256);
    // byte-exact: the stored content, no height script injected
    expect(new TextDecoder().decode(buf)).toBe(g.body.content);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("binary kind: the stored bytes from R2, byte for byte, named by the stored filename", async () => {
    const bytes = pngBytes("track-f-roundtrip");
    const { slug, sha } = await binaryPage(ME, bytes);
    const g = await call(YOU, "artifact_get", { slug });
    expect(g.body.content).toBeNull();
    expect(g.body.sha256).toBe(sha);
    expect(g.body.size_bytes).toBe(bytes.byteLength);
    expect(g.body.download_filename).toBe("logo.png");

    const res = await fetchUrl(g.body.download_url);
    expect(res.status).toBe(200);
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got).toEqual(bytes);
    expect(await sha256Hex(got)).toBe(sha);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="logo.png"`);
  });

  it("an older version: the URL, sha256 and size_bytes are THAT version's", async () => {
    const { slug } = await textPage(ME, { content: "<p>one</p>" });
    await call(ME, "artifact_update", { slug, content: "<p>two, longer</p>", summary: "v2" });
    const g = await call(ME, "artifact_get", { slug: `${slug}@v1` });
    expect(g.body.size_bytes).toBe(10);
    expect(g.body.download_filename).toBe(`${slug}-v1.html`);
    const res = await fetchUrl(g.body.download_url);
    expect(await res.text()).toBe("<p>one</p>");
  });

  it("the response is locked down: attachment, nosniff, no-store, sandbox CSP; HEAD sends no body", async () => {
    const { slug } = await textPage(ME);
    const g = await call(ME, "artifact_get", { slug });
    const res = await fetchUrl(g.body.download_url);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${slug}-v1.html"`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-security-policy")).toBe(DOWNLOAD_CSP);
    expect(DOWNLOAD_CSP).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
    const head = await fetchUrl(g.body.download_url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const post = await fetchUrl(g.body.download_url, { method: "POST" });
    expect(post.status).toBe(405);
  });

  it("reusable within its TTL (a download is not state-changing)", async () => {
    const { slug } = await textPage(ME);
    const g = await call(ME, "artifact_get", { slug });
    for (let i = 0; i < 3; i++) expect((await fetchUrl(g.body.download_url)).status).toBe(200);
  });

  it("no COOKIE_SECRET → download_url is null (fails closed), the rest of the read is unchanged", async () => {
    const { slug } = await textPage(ME);
    await seedPerson(ME);
    const server = buildTrovMcpServer({ ...(env as unknown as Env), COOKIE_SECRET: "" }, { handle: ME });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const res = (await client.callTool({ name: "artifact_get", arguments: { slug } })) as ToolRes;
    await client.close();
    const body = JSON.parse(res.content[0].text);
    expect(body.download_url).toBeNull();
    expect(body.content).toContain("Checkout");
  });
});

// ── the token ────────────────────────────────────────────────────────────────

describe("the download token", () => {
  it("expired → 410 gone (after the signature verifies); within the TTL → 200", async () => {
    const { slug } = await textPage(ME);
    const g = await call(ME, "artifact_get", { slug });
    const url = g.body.download_url as string;
    const req = () => new Request(url);
    const later = Date.now() + ARTIFACT_DOWNLOAD_TTL_MS + 1000;
    const res = await handleArtifactDownload(req(), env as unknown as Env, later);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "gone" });
    expect(res.headers.get("content-security-policy")).toBe(DOWNLOAD_CSP);
    expect((await handleArtifactDownload(req(), env as unknown as Env, Date.now() + ARTIFACT_DOWNLOAD_TTL_MS - 5000)).status).toBe(200);
  });

  it("tampered claims, a forged signature, another key, and junk are the one not_found — never saying which part failed", async () => {
    const { slug, id } = await textPage(ME);
    const g = await call(ME, "artifact_get", { slug });
    const token = String(g.body.download_url).split("/").pop()!;
    const [body, sig] = token.split(".");
    const claims = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    const reencode = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const flippedSig = sig.slice(0, -2) + (sig.at(-2) === "A" ? "B" : "A") + sig.at(-1);
    const otherKey = (await mintDownloadToken("some-other-secret", { handle: ME, page_id: id, version_no: 1 })).token;
    // A value sealed with COOKIE_SECRET itself (how session cookies are signed) must not pass:
    // the download key is DERIVED from it with a purpose label.
    const cookieSealed = await hmacSeal(body, SECRET);
    const variants = [
      `${reencode({ ...claims, h: YOU })}.${sig}`, // who
      `${reencode({ ...claims, v: 2 })}.${sig}`, // which version
      `${reencode({ ...claims, e: claims.e + 3_600_000 })}.${sig}`, // extend the expiry
      `${body}.${flippedSig}`,
      otherKey,
      cookieSealed,
    ];
    const missing = await fetchUrl(`${ORIGIN}/api/artifacts/download/${reencode({ h: ME, p: 999999, v: 1, e: Date.now() + 60_000 })}.${sig}`);
    const expected = await missing.text();
    expect(missing.status).toBe(404);
    expect(expected).toBe(JSON.stringify({ error: "not_found" }));
    for (const t of variants) {
      const res = await fetchUrl(`${ORIGIN}/api/artifacts/download/${t}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(expected);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect((await verifyDownloadToken(SECRET, "garbage", Date.now())).ok).toBe(false);
  });

  it("another principal cannot get a URL for a private page, and the URL is bound to its principal", async () => {
    const { slug } = await textPage(ME, { title: "Secret plan", visibility: "private" });
    const theirs = await call(YOU, "artifact_get", { slug });
    expect(theirs.body).toEqual({ error: "not_found", code: "not_found" });
    const mine = await call(ME, "artifact_get", { slug });
    expect((await fetchUrl(mine.body.download_url)).status).toBe(200);
  });

  it("RE-CHECKS visibility at download time: made private after minting → the identical not_found 404", async () => {
    const { slug, id } = await textPage(ME, { title: "Soon private" });
    const g = await call(YOU, "artifact_get", { slug });
    expect((await fetchUrl(g.body.download_url)).status).toBe(200);
    await patchPage(env.DB, slug, { visibility: "private" }, ME);
    const res = await fetchUrl(g.body.download_url);
    expect(res.status).toBe(404);
    const bogus = await fetchUrl(`${ORIGIN}/api/artifacts/download/${(await mintDownloadToken("nope", { handle: YOU, page_id: id, version_no: 1 })).token}`);
    expect(await res.text()).toBe(await bogus.text());
    // the author's own URL still works
    const mine = await call(ME, "artifact_get", { slug });
    expect((await fetchUrl(mine.body.download_url)).status).toBe(200);
  });

  it("dispatch: only a token-shaped path is the download route; a page slugged `download` still reads through the app", async () => {
    const t = (await mintDownloadToken(SECRET, { handle: ME, page_id: 1, version_no: 1 })).token;
    expect(isDownloadRequest(`/api/artifacts/download/${t}`)).toBe(true);
    expect(isDownloadRequest(`/api/artifacts/download/v1`)).toBe(false);
    expect(isDownloadRequest(`/api/artifacts/download`)).toBe(false);
    // not token-shaped → falls through to the session-gated app (401 without a cookie)
    expect((await fetchUrl(`${ORIGIN}/api/artifacts/download/v1`)).status).toBe(401);
  });

  it("Content-Disposition: a non-ASCII filename gets an ASCII fallback plus filename*", () => {
    expect(attachmentDisposition("plan.pdf")).toBe(`attachment; filename="plan.pdf"`);
    expect(attachmentDisposition("plán ✓.pdf")).toBe(`attachment; filename="pl_n _.pdf"; filename*=UTF-8''pl%C3%A1n%20%E2%9C%93.pdf`);
  });
});

// ── artifact_list ────────────────────────────────────────────────────────────

describe("artifact_list", () => {
  it("lists what the principal can see, newest first, with absolute urls — never another person's private page or a pending upload", async () => {
    await textPage(ME, { title: "Org page", content: "<p>a</p>" });
    await textPage(ME, { title: "My private page", content: "<p>b</p>", visibility: "private" });
    await textPage(YOU, { title: "Their private page", content: "<p>c</p>", visibility: "private" });
    // a pending binary page (no PUT yet)
    await call(ME, "upload_asset", { title: "Pending", kind: "pdf", area: "infra", repo: "", visibility: "org", size_bytes: 3, sha256: "a".repeat(64) });

    const mine = await call(ME, "artifact_list", {});
    expect(mine.isError).toBe(false);
    expect(mine.body.artifacts.map((a: any) => a.slug).sort()).toEqual(["my-private-page", "org-page"]);
    const org = mine.body.artifacts.find((a: any) => a.slug === "org-page");
    expect(org).toEqual({
      slug: "org-page", title: "Org page", kind: "html", status: "draft", version: 1, updated_at: expect.any(String),
      url: `${ORIGIN}/#artifacts/org-page`, area: "ui", author: ME, visibility: "org",
    });
    expect(mine.body.total).toBe(2);
    expect(mine.body.truncated).toBe(false);

    const theirs = await call(YOU, "artifact_list", {});
    expect(theirs.body.artifacts.map((a: any) => a.slug).sort()).toEqual(["org-page", "their-private-page"]);
  });

  it("filters: q, kind, status, author, ticket; limit truncates", async () => {
    await seedPerson(ME);
    const ticket = await create_ticket(env.DB, { title: "T", body: "", category: "other", priority: "normal", assignees: [] }, ME);
    await textPage(ME, { title: "Checkout flow", content: "<p>zebra</p>", links: [{ target_type: "ticket", target_ref: String(ticket) }] });
    await call(ME, "upload_asset", { title: "Notes", kind: "markdown", area: "api", repo: "", visibility: "org", content: "# notes" });
    await binaryPage(YOU, pngBytes("track-f-list"), { title: "Badge" });
    await call(ME, "artifact_update", { slug: "notes", content: "# notes v2", summary: "v2" }); // → published

    const slugs = async (args: Record<string, unknown>) => (await call(ME, "artifact_list", args)).body.artifacts.map((a: any) => a.slug).sort();
    expect(await slugs({ q: "zebra" })).toEqual(["checkout-flow"]);
    expect(await slugs({ kind: "image" })).toEqual(["badge"]);
    expect(await slugs({ status: "published" })).toEqual(["notes"]);
    expect(await slugs({ author: YOU })).toEqual(["badge"]);
    expect(await slugs({ ticket })).toEqual(["checkout-flow"]);
    expect(await slugs({ ticket: `#${ticket}` })).toEqual(["checkout-flow"]);
    const one = await call(ME, "artifact_list", { limit: 1 });
    expect(one.body.artifacts).toHaveLength(1);
    expect(one.body.total).toBe(3);
    expect(one.body.truncated).toBe(true);
    expect(one.body.artifacts[0].slug).toBe("notes"); // newest version first
    // an unknown kind is refused by the tool's input schema
    await seedPerson(ME);
    const server = buildTrovMcpServer(env as unknown as Env, { handle: ME });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const bad = (await client.callTool({ name: "artifact_list", arguments: { kind: "exe" } })) as ToolRes;
    await client.close();
    expect(bad.isError).toBe(true);
  });

  it("is registered for every principal", async () => {
    await seedPerson(YOU);
    const server = buildTrovMcpServer(env as unknown as Env, { handle: YOU });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    expect(names).toEqual(expect.arrayContaining(["artifact_list", "artifact_get", "upload_asset", "artifact_update"]));
  });
});
