// Doc images (spec: docs/superpowers/specs/2026-09-24-doc-images-design.md): an agent
// uploads an image through MCP `upload_asset` with destination "doc", PUTs the bytes to
// the SAME upload route artifacts use, and references it in a doc as
// `![alt](/img/<sha256>)`; the doc gate refuses a body whose image is not uploaded, or
// that uses any other image source; GET /img/<sha> serves the bytes to a signed-in
// member. MCP calls drive the REAL registered closures; the PUT and /img go through the
// real Worker entry, against real D1 + local R2.

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker from "../src/index";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { all, first } from "../src/db";
import { sha256Hex } from "../src/tools/artifacts";
import { route_triage, assign_triage } from "../src/tools/writes";
import { recordBatch } from "../src/consumer";
import { scanDocImages, docImageKey } from "@shared/doc-images";
import { IngestPayload } from "@shared/contract";
import { seedPerson, cookieFor } from "./helpers/persons";
import { bearerCtx } from "./helpers/tenant";

const ME = "img-author";
const ORIGIN = "https://trov.test"; // PUBLIC_ORIGIN in vitest.config.ts
type ToolRes = { content: Array<{ type: string; text: string }>; isError?: boolean };
const ctx = { waitUntil() {}, passThroughException() {} } as unknown as ExecutionContext;

async function call(name: string, args: Record<string, unknown>, handle = ME): Promise<{ body: any; isError: boolean }> {
  await seedPerson(handle);
  const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx(handle));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const res = (await client.callTool({ name, arguments: args })) as ToolRes;
    return { body: JSON.parse(res.content[0].text), isError: !!res.isError };
  } finally {
    await client.close();
    await server.close();
  }
}

const fetchWorker = (path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), env as unknown as Env, ctx);

/** A distinct fake PNG per seed; the server stores bytes, it does not sniff them. */
function png(seed: string): Uint8Array {
  return new TextEncoder().encode(`\x89PNG\r\n\x1a\n-${seed}-${"x".repeat(64)}`);
}

async function declare(bytes: Uint8Array, o: Record<string, unknown> = {}) {
  return call("upload_asset", { destination: "doc", sha256: await sha256Hex(bytes), size_bytes: bytes.length, content_type: "image/png", ...o });
}

/** Declare + PUT; returns the /img ref. */
async function upload(bytes: Uint8Array): Promise<string> {
  const d = await declare(bytes);
  expect(d.isError).toBe(false);
  if (!d.body.uploaded) {
    const r = await worker.fetch(new Request(d.body.upload_url, { method: "PUT", body: bytes }), env as unknown as Env, ctx);
    expect(r.status).toBe(200);
  }
  return d.body.ref;
}

const doc = (slug: string, body: string) => ({
  slug, section: "reference", title: slug, body, change_summary: "test", confidence: "high" as const,
});

// ── the pure scan ────────────────────────────────────────────────────────────

describe("scanDocImages", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);

  it("finds markdown, <angle>, raw <img> and reference-style images, deduped in order", () => {
    const body = `![one](/img/${A})\n![two](</img/${B}> "t")\n<img alt="x" src="/img/${A}">\n![three][r]\n\n[r]: https://evil.example/p.png`;
    expect(scanDocImages(body)).toEqual({ shas: [A, B], others: ["https://evil.example/p.png"] });
  });

  it("flags every non-/img source: external URLs, data URIs, other paths, a sha with an extension", () => {
    const body = `![a](https://x.io/a.png) ![b](data:image/png;base64,AA) ![c](/raw/a/foo) ![d](/img/${A}.png) <img src='//cdn.x/y.gif'>`;
    expect(scanDocImages(body).others).toEqual(["https://x.io/a.png", "data:image/png;base64,AA", "/raw/a/foo", `/img/${A}.png`, "//cdn.x/y.gif"]);
  });

  it("ignores images inside fenced blocks and inline code — a doc may EXPLAIN image syntax", () => {
    const body = "Use `![alt](https://x.io/a.png)` like this:\n\n```md\n![alt](https://x.io/b.png)\n<img src=\"https://x.io/c.png\">\n```\n\n~~~\n![](https://x.io/d.png)\n~~~";
    expect(scanDocImages(body)).toEqual({ shas: [], others: [] });
  });

  it("a link (no !) is not an image", () => {
    expect(scanDocImages("[the spec](https://x.io/spec.png)")).toEqual({ shas: [], others: [] });
  });
});

// ── upload_asset, destination "doc" ──────────────────────────────────────────

describe("upload_asset destination doc", () => {
  it("mints an absolute upload URL on the artifact route, the ref, and a ready markdown line", async () => {
    const bytes = png("mint");
    const d = await declare(bytes);
    expect(d.isError).toBe(false);
    const sha = await sha256Hex(bytes);
    expect(d.body).toMatchObject({ destination: "doc", ref: `/img/${sha}`, sha256: sha, uploaded: false, warnings: [] });
    expect(d.body.upload_url).toMatch(/^https:\/\/trov\.test\/api\/artifacts\/upload\/[A-Za-z0-9_-]{43}$/);
    expect(d.body.markdown).toBe(`![<describe the image>](/img/${sha})`);
    // Nothing is stored until the PUT lands — and no artifact page was made.
    expect(await first(env.DB, `SELECT 1 AS x FROM doc_images WHERE sha256 = ?`, sha)).toBeNull();
    expect(await all(env.DB, `SELECT id FROM artifact_pages`)).toEqual([]);
  });

  it("the PUT stores the bytes in R2 at doc-images/<sha> and records the row", async () => {
    const bytes = png("put");
    const ref = await upload(bytes);
    const sha = await sha256Hex(bytes);
    expect(ref).toBe(`/img/${sha}`);
    const row = await first<{ content_type: string; size_bytes: number; uploaded_by: string }>(env.DB, `SELECT * FROM doc_images WHERE sha256 = ?`, sha);
    expect(row).toMatchObject({ content_type: "image/png", size_bytes: bytes.length, uploaded_by: ME });
    const obj = await env.ARTIFACTS_BUCKET.get(docImageKey(sha));
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(bytes);
  });

  it("an image already stored needs no PUT: uploaded true, no token minted", async () => {
    const bytes = png("dedupe");
    await upload(bytes);
    const before = await all(env.DB, `SELECT token_hash FROM doc_image_upload_tokens`);
    const again = await declare(bytes);
    expect(again.body).toMatchObject({ uploaded: true, ref: `/img/${await sha256Hex(bytes)}` });
    expect(again.body.upload_url).toBeUndefined();
    expect(await all(env.DB, `SELECT token_hash FROM doc_image_upload_tokens`)).toEqual(before);
  });

  it("refuses non-image types, oversize files, a bad sha, a non-image kind and artifact page fields", async () => {
    const bytes = png("refuse");
    const sha = await sha256Hex(bytes);
    for (const [args, msg] of [
      [{ content_type: "image/svg+xml" }, /content_type must be one of/],
      [{ content_type: "application/pdf" }, /content_type must be one of/],
      [{ size_bytes: 10 * 1024 * 1024 + 1 }, /at most/],
      [{ sha256: "abc" }, /64 hex/],
      [{ kind: "pdf" }, /kind must be \\"image\\"/],
      [{ title: "A screenshot" }, /title are for artifact pages/],
      [{ area: "ui", visibility: "org" }, /area, visibility are for artifact pages/],
    ] as const) {
      const base: Record<string, unknown> = { destination: "doc", sha256: sha, size_bytes: bytes.length, content_type: "image/png" };
      const r = await call("upload_asset", Object.assign(base, args));
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(JSON.stringify(r.body)).toMatch(msg);
    }
    expect(await all(env.DB, `SELECT 1 FROM doc_image_upload_tokens`)).toEqual([]);
  });

  it("a PUT whose bytes do not match is 400 and the same token still works; a used token is 410", async () => {
    const bytes = png("retry");
    const d = await declare(bytes);
    const url = d.body.upload_url as string;
    const wrong = await worker.fetch(new Request(url, { method: "PUT", body: png("other") }), env as unknown as Env, ctx);
    expect(wrong.status).toBe(400);
    const ok = await worker.fetch(new Request(url, { method: "PUT", body: bytes }), env as unknown as Env, ctx);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ref: `/img/${await sha256Hex(bytes)}` });
    const reused = await worker.fetch(new Request(url, { method: "PUT", body: bytes }), env as unknown as Env, ctx);
    expect(reused.status).toBe(410);
  });

  it("the default destination is still an artifact, and it still needs its page fields", async () => {
    const r = await call("upload_asset", { kind: "markdown", content: "# hi" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.body)).toMatch(/an artifact needs title, area, repo, visibility/);
    const ok = await call("upload_asset", { title: "Notes", kind: "markdown", content: "# hi", area: "ui", repo: "", visibility: "org" });
    expect(ok.isError).toBe(false);
    expect(ok.body.slug).toBe("notes");
  });

  it("the old name is gone: there is one upload tool", async () => {
    await seedPerson(ME);
    const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx(ME));
    const client = new Client({ name: "test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    await server.close();
    expect(names).toContain("upload_asset");
    expect(names).not.toContain("artifact_create");
  });
});

// ── the gate ─────────────────────────────────────────────────────────────────

describe("the doc gate's image rule", () => {
  it("propose_doc_update refuses a not-yet-uploaded /img ref, naming it, and stages nothing", async () => {
    const sha = "c".repeat(64);
    const r = await call("propose_doc_update", doc("with-missing", `# Flow\n\n![flow](/img/${sha})`));
    expect(r.body).toMatchObject({ outcome: "refused", slug: "with-missing" });
    expect(r.body.reason).toContain(`/img/${sha}`);
    expect(await all(env.DB, `SELECT 1 FROM doc_versions WHERE slug = 'with-missing'`)).toEqual([]);
    expect(await all(env.DB, `SELECT 1 FROM needs_triage`)).toEqual([]);
  });

  it("refuses an external image and a data URI", async () => {
    for (const src of ["https://tracker.example/pixel.png", "data:image/png;base64,iVBOR"]) {
      const r = await call("propose_doc_update", doc("with-external", `![x](${src})`));
      expect(r.body.outcome).toBe("refused");
      expect(r.body.reason).toMatch(/must be uploaded to Trov/);
    }
  });

  it("stages a body whose images are all uploaded", async () => {
    const ref = await upload(png("stage"));
    const r = await call("propose_doc_update", doc("with-image", `# Deploy\n\n![The deploy flow](${ref})\n\nText.`));
    expect(r.body).toMatchObject({ outcome: "written", status: "staged", change_kind: "new" });
    const v = await first<{ body: string }>(env.DB, `SELECT body FROM doc_versions WHERE slug = 'with-image'`);
    expect(v!.body).toContain(ref);
  });

  it("a body with no images is unaffected, and code samples of image syntax pass", async () => {
    const r = await call("propose_doc_update", doc("explains-images", "Write `![alt](https://x.io/a.png)` like so."));
    expect(r.body.outcome).toBe("written");
  });

  it("record_session lists a refused doc with its reason, does not ledger it, and a resend after the upload stages it", async () => {
    const bytes = png("batch");
    const sha = await sha256Hex(bytes);
    const payload = IngestPayload.parse({
      session: { id: crypto.randomUUID(), author: ME, ended_at: new Date().toISOString(), skill_version: "test" },
      feed_entries: [], adr_drafts: [], needs_triage: [],
      doc_proposals: [doc("batched", `![shot](/img/${sha})`), doc("plain", "no images")],
    });
    const first1 = await recordBatch(env.DB, payload, { handle: ME });
    expect(first1.docs).toEqual({ staged: 1, unchanged: 0, triaged: 0 });
    expect(first1.refused).toEqual([{ slug: "batched", reason: expect.stringContaining(`/img/${sha}`) }]);

    await upload(bytes);
    const again = await recordBatch(env.DB, payload, { handle: ME });
    expect(again.docs).toEqual({ staged: 1, unchanged: 1, triaged: 0 }); // "plain" replays; "batched" stages now
    expect(again.refused).toBeUndefined();
  });

  it("a batch with no images reads exactly as before (no `refused` key)", async () => {
    const r = await recordBatch(env.DB, IngestPayload.parse({
      session: { id: crypto.randomUUID(), author: ME, ended_at: new Date().toISOString(), skill_version: "test" },
      doc_proposals: [doc("text-only", "hello")],
    }), { handle: ME });
    expect("refused" in r).toBe(false);
  });

  it("placing a triage item as a doc re-runs the rule and refuses a dangling image", async () => {
    await seedPerson(ME);
    const id = await route_triage(env.DB, { raw: doc("from-triage", `![x](/img/${"d".repeat(64)})`), reason: "test" });
    await expect(assign_triage(env.DB, id, ME, { type: "doc", section: "reference" })).rejects.toThrow(/could not place doc: .*not uploaded yet/);
  });

  it("a person's New doc (POST /api/docs/propose) gets the refusal as a 400", async () => {
    const cookie = await cookieFor(ME);
    const r = await fetchWorker("/api/docs/propose", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Pictured", section: "reference", space: "technical", body: "![x](https://x.io/a.png)" }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/must be uploaded to Trov/);
  });
});

// ── GET /img/<sha> ───────────────────────────────────────────────────────────

describe("GET /img/<sha>", () => {
  it("serves the exact bytes to a signed-in member, locked down and cached as immutable", async () => {
    const bytes = png("serve");
    const ref = await upload(bytes);
    const r = await fetchWorker(ref, { headers: { cookie: await cookieFor("img-reader") } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect(r.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
  });

  it("is 401 without a session, and 404 for an unknown or malformed sha", async () => {
    const ref = await upload(png("auth"));
    expect((await fetchWorker(ref)).status).toBe(401);
    const cookie = await cookieFor("img-reader");
    expect((await fetchWorker(`/img/${"e".repeat(64)}`, { headers: { cookie } })).status).toBe(404);
    expect((await fetchWorker(`/img/not-a-sha`, { headers: { cookie } })).status).toBe(404);
  });
});
