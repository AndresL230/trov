// The artifact MCP surface (issue #52 · Track C). Every test drives the REAL
// registered closures (buildTrovMcpServer over an in-memory transport), never the
// adapter functions directly — so a missing/renamed registration is a failure.

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { all, run, nowIso } from "../src/db";
import { consumeUploadToken, createPage, sha256Hex, mintUploadToken } from "../src/tools/artifacts";
import { create_ticket } from "../src/tools/tickets";
import { seedPerson, cookieFor } from "./helpers/persons";
import { app } from "../src/routes";
import { ARTIFACT_INLINE_MAX } from "@shared/artifacts";
import { bearerCtx, systemCtx } from "./helpers/tenant";

const ME = "arti-author";
const YOU = "arti-teammate";
const ADMIN = "admin-user"; // the one ADMIN_LOGINS handle in vitest.config.ts
const ORIGIN = "https://trov.test"; // PUBLIC_ORIGIN in vitest.config.ts

type ToolRes = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function withClient<T>(handle: string, fn: (c: Client) => Promise<T>, e: Env = env as unknown as Env, origin?: string): Promise<T> {
  await seedPerson(handle);
  const server = buildTrovMcpServer(e, await bearerCtx(handle), { origin });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function call(handle: string, name: string, args: Record<string, unknown>): Promise<{ body: any; isError: boolean; text: string }> {
  return withClient(handle, async (c) => {
    const res = (await c.callTool({ name, arguments: args })) as ToolRes;
    return { body: JSON.parse(res.content[0].text), isError: !!res.isError, text: res.content[0].text };
  });
}

const textArgs = (o: Record<string, unknown> = {}) => ({
  title: "Auth flow", kind: "markdown", content: "# Auth\n\nThe session cookie flow.", area: "auth", repo: "", visibility: "org", ...o,
});

async function seedTicket(title = "Fix login", requester = ME): Promise<number> {
  await seedPerson(requester);
  return create_ticket(systemCtx(), { title, body: "", category: "other", priority: "normal", assignees: [] }, requester);
}

// ── registration ─────────────────────────────────────────────────────────────

describe("registration", () => {
  it("registers upload_asset / artifact_update / artifact_get for every principal, and NO ratify tool for anyone", async () => {
    for (const who of [ME, ADMIN]) {
      const names = await withClient(who, async (c) => (await c.listTools()).tools.map((t) => t.name));
      expect(names).toEqual(expect.arrayContaining(["upload_asset", "artifact_update", "artifact_get"]));
      expect(names.filter((n) => /ratif/i.test(n))).toEqual([]);
    }
  });

  it("calling a ratify tool by name is an error and ratifies nothing", async () => {
    const c = await call(ME, "upload_asset", textArgs());
    await call(ME, "artifact_update", { slug: c.body.slug, content: "# v2", summary: "v2" }); // published
    for (const name of ["artifact_ratify", "ratify_artifact", "artifact-ratify"]) {
      const r = await withClient(ME, async (cl) => {
        try {
          return (await cl.callTool({ name, arguments: { slug: c.body.slug, version: 2 } })) as ToolRes;
        } catch (e) {
          return { content: [{ type: "text", text: String(e) }], isError: true };
        }
      });
      expect(r.isError).toBe(true);
    }
    const g = await call(ME, "artifact_get", { slug: c.body.slug });
    expect(g.body.status).toBe("published");
    expect(g.body.ratified_version).toBeNull();
  });
});

// ── text create / update / get ───────────────────────────────────────────────

describe("text artifacts", () => {
  it("upload_asset → { id, slug, url, version, warnings } with an absolute SPA url, authored by the bearer", async () => {
    const r = await call(ME, "upload_asset", textArgs({ summary: "first cut" }));
    expect(r.isError).toBe(false);
    expect(r.body).toEqual({ id: expect.any(Number), slug: "auth-flow", url: `${ORIGIN}/#artifacts/auth-flow`, version: 1, warnings: [] });
    const g = await call(YOU, "artifact_get", { slug: "auth-flow" });
    expect(g.body.author_id).toBe(ME);
    expect(g.body.status).toBe("draft");
    expect(g.body.content).toBe("# Auth\n\nThe session cookie flow.");
    expect(g.body.raw_url).toBe(`${ORIGIN}/raw/a/auth-flow@v1`);
    expect(g.body.url).toBe(`${ORIGIN}/#artifacts/auth-flow`);
    expect(g.body.warnings).toEqual([]);
  });

  it("falls back to the request origin when PUBLIC_ORIGIN is unset", async () => {
    const e = { ...(env as unknown as Env), PUBLIC_ORIGIN: undefined };
    const r = await withClient(ME, async (c) => JSON.parse(((await c.callTool({ name: "upload_asset", arguments: textArgs() })) as ToolRes).content[0].text), e, "https://req.example");
    expect(r.url).toBe("https://req.example/#artifacts/auth-flow");
  });

  it("a text create rejects binary fields and a missing content", async () => {
    const a = await call(ME, "upload_asset", textArgs({ sha256: "a".repeat(64), size_bytes: 3 }));
    expect(a.isError).toBe(true);
    expect(a.body.code).toBe("bad_request");
    const { content: _c, ...noContent } = textArgs();
    const b = await call(ME, "upload_asset", noContent);
    expect(b.body.code).toBe("bad_request");
    expect(await all(env.DB, `SELECT id FROM artifact_pages`)).toEqual([]);
  });

  it("artifact_update: full content, then an exact-once old_str/new_str edit; a teammate may version an org page", async () => {
    await call(ME, "upload_asset", textArgs({ content: "alpha beta gamma" }));
    const v2 = await call(YOU, "artifact_update", { slug: "auth-flow", content: "alpha beta gamma delta", summary: "add delta" });
    expect(v2.body).toEqual({ id: expect.any(Number), slug: "auth-flow", url: `${ORIGIN}/#artifacts/auth-flow`, version: 2, unchanged: false, warnings: [] });
    const v3 = await call(ME, "artifact_update", { slug: "auth-flow", old_str: "beta", new_str: "BETA", summary: "caps" });
    expect(v3.body.version).toBe(3);
    const g = await call(ME, "artifact_get", { slug: "auth-flow" });
    expect(g.body.content).toBe("alpha BETA gamma delta");
    expect(g.body.status).toBe("published");
    expect(g.body.versions.map((v: { created_by: string }) => v.created_by)).toEqual([ME, YOU, ME]);
  });

  it("identical content is a no-op: unchanged, same version", async () => {
    await call(ME, "upload_asset", textArgs({ content: "same" }));
    const r = await call(ME, "artifact_update", { slug: "auth-flow", content: "same", summary: "noop" });
    expect(r.body.unchanged).toBe(true);
    expect(r.body.version).toBe(1);
  });

  it("old_str rules: absent, repeated, empty, content + old_str together, old_str without new_str — all bad_request, nothing written", async () => {
    await call(ME, "upload_asset", textArgs({ content: "one two two" }));
    const cases: Record<string, unknown>[] = [
      { old_str: "three", new_str: "x" },
      { old_str: "two", new_str: "x" },
      { old_str: "", new_str: "x" },
      { content: "x", old_str: "one", new_str: "y" },
      { old_str: "one" },
      {},
    ];
    for (const c of cases) {
      const r = await call(ME, "artifact_update", { slug: "auth-flow", summary: "s", ...c });
      expect(r.isError, JSON.stringify(c)).toBe(true);
      expect(r.body.code, JSON.stringify(c)).toBe("bad_request");
    }
    expect((await call(ME, "artifact_get", { slug: "auth-flow" })).body.current_version).toBe(1);
  });

  it("text update refuses binary fields", async () => {
    await call(ME, "upload_asset", textArgs());
    const r = await call(ME, "artifact_update", { slug: "auth-flow", summary: "s", size_bytes: 3, sha256: "a".repeat(64) });
    expect(r.body.code).toBe("bad_request");
  });

  it("artifact_get addresses versions as slug@v1, slug/v1 or version: 1; a disagreeing pair is bad_request; out of range is not_found", async () => {
    await call(ME, "upload_asset", textArgs({ content: "v1 body" }));
    await call(ME, "artifact_update", { slug: "auth-flow", content: "v2 body", summary: "v2" });
    for (const args of [{ slug: "auth-flow@v1" }, { slug: "auth-flow/v1" }, { slug: "auth-flow", version: 1 }, { slug: "auth-flow@v1", version: 1 }]) {
      const g = await call(ME, "artifact_get", args);
      expect(g.body.content, JSON.stringify(args)).toBe("v1 body");
      expect(g.body.version.version_no).toBe(1);
      expect(g.body.raw_url).toBe(`${ORIGIN}/raw/a/auth-flow@v1`);
    }
    expect((await call(ME, "artifact_get", { slug: "auth-flow" })).body.content).toBe("v2 body");
    expect((await call(ME, "artifact_get", { slug: "auth-flow@v1", version: 2 })).body.code).toBe("bad_request");
    expect((await call(ME, "artifact_get", { slug: "auth-flow@v9" })).text).toBe(JSON.stringify({ error: "not_found", code: "not_found" }));
  });

  it("a text cap breach is too_large", async () => {
    const r = await call(ME, "upload_asset", textArgs({ content: "x".repeat(750 * 1024 + 1) }));
    expect(r.body.code).toBe("too_large");
  });
});

// ── inline threshold (ARTIFACT_INLINE_MAX) ───────────────────────────────────

describe("artifact_get / query — big text is not inlined", () => {
  const big = "# Big\n\n" + "yak ".repeat(ARTIFACT_INLINE_MAX / 4); // > ARTIFACT_INLINE_MAX bytes
  const atMax = "a".repeat(ARTIFACT_INLINE_MAX); // exactly the threshold: still inlined

  it("omits a text body over 64 KB by default, keeping download_url / sha256 / size_bytes", async () => {
    await call(ME, "upload_asset", textArgs({ title: "Big spec", content: big }));
    const g = await call(ME, "artifact_get", { slug: "big-spec" });
    expect(g.isError).toBe(false);
    expect(g.body.content).toBeNull();
    expect(g.body.content_omitted).toBe(true);
    expect(g.body.size_bytes).toBe(new TextEncoder().encode(big).length);
    expect(g.body.sha256).toBe(await sha256Hex(new TextEncoder().encode(big)));
    expect(g.body.download_url).toMatch(/^https:\/\/trov\.test\/api\/artifacts\/download\//);
    expect(g.text.length).toBeLessThan(ARTIFACT_INLINE_MAX);
  });

  it("inlines a body of exactly 64 KB, and a big one with include_content: true", async () => {
    await call(ME, "upload_asset", textArgs({ title: "At max", content: atMax }));
    const small = await call(ME, "artifact_get", { slug: "at-max" });
    expect(small.body.content).toBe(atMax);
    expect(small.body.content_omitted).toBe(false);

    await call(ME, "upload_asset", textArgs({ title: "Big spec", content: big }));
    const full = await call(ME, "artifact_get", { slug: "big-spec", include_content: true });
    expect(full.body.content).toBe(big);
    expect(full.body.content_omitted).toBe(false);
  });

  it("an omitted body still carries warnings computed over the full text", async () => {
    const html = `<html><body>${"<p>filler</p>".repeat(ARTIFACT_INLINE_MAX / 10)}<script>window.claude.complete("x")</script></body></html>`;
    await call(ME, "upload_asset", textArgs({ title: "Big page", kind: "html", content: html }));
    const g = await call(ME, "artifact_get", { slug: "big-page" });
    expect(g.body.content_omitted).toBe(true);
    expect(g.body.warnings).toHaveLength(1);
    expect(g.body.warnings[0]).toContain("window.claude");
  });

  it("query's assembled body is a pointer line over the threshold, the text under it", async () => {
    await call(ME, "upload_asset", textArgs({ title: "Gnu big", content: "gnu " + big }));
    await call(ME, "upload_asset", textArgs({ title: "Gnu small", content: "gnu small body" }));
    const r = await call(ME, "query", { q: "gnu", types: ["artifact"] });
    const byId = Object.fromEntries(r.body.primary.map((h: { id: string; body: string }) => [h.id, h.body]));
    const size = new TextEncoder().encode("gnu " + big).length;
    expect(byId["gnu-big"]).toContain(`(markdown · ${size} bytes — too large to inline; read it with artifact_get)`);
    expect(byId["gnu-big"]).not.toContain("yak yak");
    expect(byId["gnu-small"]).toContain("gnu small body");
  });
});

// ── warnings ─────────────────────────────────────────────────────────────────

describe("CLAUDE_ONLY_MARKERS warnings — warn, never reject", () => {
  it("create, update and get all carry a warning per marker, and the write still lands", async () => {
    const html = `<html><body><script>window.claude.complete("x"); fetch("https://api.anthropic.com/v1")</script></body></html>`;
    const c = await call(ME, "upload_asset", textArgs({ kind: "html", content: html }));
    expect(c.isError).toBe(false);
    expect(c.body.version).toBe(1);
    expect(c.body.warnings).toHaveLength(2);
    expect(c.body.warnings.join(" ")).toContain("window.claude");
    expect(c.body.warnings.join(" ")).toContain("api.anthropic.com");

    const u = await call(ME, "artifact_update", { slug: "auth-flow", old_str: "window.claude.complete", new_str: "window.storage.get", summary: "s" });
    expect(u.body.version).toBe(2);
    expect(u.body.warnings.join(" ")).toContain("window.storage");
    expect(u.body.warnings.join(" ")).not.toContain("window.claude`");

    const g = await call(YOU, "artifact_get", { slug: "auth-flow" });
    expect(g.body.warnings).toHaveLength(2);

    const clean = await call(ME, "artifact_update", { slug: "auth-flow", content: "<p>plain</p>", summary: "clean" });
    expect(clean.body.warnings).toEqual([]);
  });

  it("a bundled Claude Design export warns to flatten it, and the write still lands", async () => {
    const bundled = `<html><body><script>/* loader */</script><script type="__bundler/manifest">{}</script></body></html>`;
    const c = await call(ME, "upload_asset", textArgs({ title: "Restyle", kind: "html", content: bundled }));
    expect(c.isError).toBe(false);
    expect(c.body.version).toBe(1);
    expect(c.body.warnings).toHaveLength(1);
    expect(c.body.warnings[0]).toContain("bundled Claude Design export");
    expect(c.body.warnings[0]).toContain("flatten");

    const flat = await call(ME, "artifact_update", { slug: "restyle", content: "<html><body><script>render()</script></body></html>", summary: "flattened" });
    expect(flat.body.warnings).toEqual([]);
  });
});

// ── binary ───────────────────────────────────────────────────────────────────

describe("binary artifacts — the upload_url flow", () => {
  const PDF = new TextEncoder().encode("%PDF-1.4 track-c mcp test " + "z".repeat(40));

  it("upload_asset (pdf) → an absolute single-use upload_url; the page is invisible until the PUT lands", async () => {
    const sha = await sha256Hex(PDF);
    const r = await call(ME, "upload_asset", { title: "Threat model", kind: "pdf", area: "infra", repo: "", visibility: "org", size_bytes: PDF.byteLength, sha256: sha, filename: "tm.pdf", summary: "first" });
    expect(r.isError).toBe(false);
    expect(Object.keys(r.body).sort()).toEqual(["expires_at", "id", "slug", "upload_url", "url", "warnings"]);
    expect(r.body.slug).toBe("threat-model");
    expect(r.body.upload_url).toMatch(/^https:\/\/trov\.test\/api\/artifacts\/upload\/[A-Za-z0-9_-]{43}$/);
    expect(r.body.warnings).toEqual([]);
    const ttl = Date.parse(r.body.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);

    // version 0: not_found to everyone, author included — byte-identical to a missing slug
    const pending = await call(ME, "artifact_get", { slug: "threat-model" });
    const missing = await call(ME, "artifact_get", { slug: "no-such-page" });
    expect(pending.text).toBe(missing.text);

    // the minted token is the real one: land the bytes the way Track B's PUT does
    const token = r.body.upload_url.split("/").pop();
    await consumeUploadToken(env.DB, env.ARTIFACTS_BUCKET, token, new Response(PDF).body!);
    const g = await call(YOU, "artifact_get", { slug: "threat-model" });
    expect(g.body.kind).toBe("pdf");
    expect(g.body.content).toBeNull();
    expect(g.body.raw_url).toBe(`${ORIGIN}/raw/a/threat-model@v1`);
    expect(g.body.version.sha256).toBe(sha);
    expect(g.body.warnings).toEqual([]);
  });

  it("a binary create needs size_bytes + sha256 and refuses inline content", async () => {
    const base = { title: "Img", kind: "image", area: "ui", repo: "", visibility: "org" };
    expect((await call(ME, "upload_asset", base)).body.code).toBe("bad_request");
    expect((await call(ME, "upload_asset", { ...base, content: "x", size_bytes: 1, sha256: "a".repeat(64) })).body.code).toBe("bad_request");
    expect((await call(ME, "upload_asset", { ...base, size_bytes: 1, sha256: "nothex" })).body.code).toBe("bad_request");
    expect((await call(ME, "upload_asset", { ...base, size_bytes: 1, sha256: "a".repeat(64), content_type: "image/tiff" })).body.code).toBe("bad_request");
    expect(await all(env.DB, `SELECT id FROM artifact_pages`)).toEqual([]);
  });

  it("artifact_update on a binary page → upload_url; text inputs are refused", async () => {
    await createPage(env.DB, { title: "Logo", kind: "image", area: "ui", bytes: new TextEncoder().encode("PNG-track-c-1"), content_type: "image/png" }, ME, env.ARTIFACTS_BUCKET);
    const noType = await call(YOU, "artifact_update", { slug: "logo", size_bytes: 13, sha256: "b".repeat(64), summary: "v2" });
    expect(noType.body.code).toBe("bad_request"); // an image needs a type (or a filename to infer it from)
    const r = await call(YOU, "artifact_update", { slug: "logo", size_bytes: 13, sha256: "b".repeat(64), filename: "logo-v2.png", summary: "v2" });
    expect(r.body.upload_url).toMatch(/^https:\/\/trov\.test\/api\/artifacts\/upload\//);
    expect((await call(YOU, "artifact_update", { slug: "logo", content: "x", summary: "s" })).body.code).toBe("bad_request");
    expect((await call(YOU, "artifact_update", { slug: "logo", summary: "s" })).body.code).toBe("bad_request");
  });

  it("the author may re-mint an upload for their own pending page; anyone else gets not_found", async () => {
    await mintUploadToken(env.DB, { kind: "file", size_bytes: 4, sha256: "c".repeat(64), title: "Dump", area: "data" }, ME);
    const mine = await call(ME, "artifact_update", { slug: "dump", size_bytes: 4, sha256: "c".repeat(64), summary: "retry" });
    expect(mine.body.upload_url).toBeTruthy();
    const theirs = await call(YOU, "artifact_update", { slug: "dump", size_bytes: 4, sha256: "c".repeat(64), summary: "x" });
    expect(theirs.text).toBe(JSON.stringify({ error: "not_found", code: "not_found" }));
  });
});

// ── private / missing parity ─────────────────────────────────────────────────

describe("private and missing are the same not_found", () => {
  it("get / update on another person's private page read exactly like a missing slug; the author sees it", async () => {
    await call(ME, "upload_asset", textArgs({ title: "Secret plan", visibility: "private" }));
    const NF = JSON.stringify({ error: "not_found", code: "not_found" });
    for (const [name, args] of [
      ["artifact_get", { slug: "secret-plan" }],
      ["artifact_get", { slug: "secret-plan@v1" }],
      ["artifact_update", { slug: "secret-plan", content: "x", summary: "s" }],
      ["artifact_update", { slug: "secret-plan", size_bytes: 1, sha256: "a".repeat(64), summary: "s" }],
    ] as const) {
      const priv = await call(YOU, name, args);
      const miss = await call(YOU, name, { ...args, slug: "nope-nope" });
      expect(priv.isError).toBe(true);
      expect(priv.text).toBe(NF);
      expect(miss.text).toBe(NF);
    }
    expect((await call(YOU, "artifact_get", { slug: "BAD SLUG!" })).text).toBe(NF);
    expect((await call(ME, "artifact_get", { slug: "secret-plan" })).body.visibility).toBe("private");
  });
});

// ── query ────────────────────────────────────────────────────────────────────

describe("query — the artifact type", () => {
  it("finds artifacts by default (id = slug), flags draft vs live, and states Status · v<n> first", async () => {
    await call(ME, "upload_asset", textArgs({ title: "Zebra rollout", content: "zebra stripes everywhere" }));
    await call(ME, "upload_asset", textArgs({ title: "Zebra retro", content: "zebra v1" }));
    await call(ME, "artifact_update", { slug: "zebra-retro", content: "zebra v2", summary: "v2" });
    const r = await call(ME, "query", { q: "zebra" });
    const hits = [...r.body.primary, ...r.body.pointers].filter((h: { type: string }) => h.type === "artifact");
    const byId = Object.fromEntries(hits.map((h: { id: string; authority: string }) => [h.id, h]));
    expect(byId["zebra-rollout"].authority).toBe("draft");
    expect(byId["zebra-retro"].authority).toBe("live");
    const retro = r.body.primary.find((h: { id: string }) => h.id === "zebra-retro");
    expect(retro.body.split("\n")[0]).toBe("Status: published · v2");
    expect(retro.body).toContain("zebra v2");
    expect(retro.current_version).toBe(2);
  });

  it("ratified reads live with Status: ratified", async () => {
    await call(ME, "upload_asset", textArgs({ title: "Quokka spec", content: "quokka" }));
    await call(ME, "artifact_update", { slug: "quokka-spec", content: "quokka 2", summary: "v2" });
    await run(env.DB, `UPDATE artifact_pages SET status='ratified', ratified_version=2, ratified_by=?, ratified_at=? WHERE slug='quokka-spec'`, ME, nowIso());
    const r = await call(YOU, "query", { q: "quokka", types: ["artifact"] });
    expect(r.body.primary).toHaveLength(1);
    expect(r.body.primary[0].authority).toBe("live");
    expect(r.body.primary[0].body.split("\n")[0]).toBe("Status: ratified · v2");
  });

  it("a private artifact reaches only its author — in search and in browse", async () => {
    await call(ME, "upload_asset", textArgs({ title: "Walrus notes", content: "walrus", visibility: "private" }));
    const mine = await call(ME, "query", { q: "walrus", types: ["artifact"] });
    expect(mine.body.primary.map((h: { id: string }) => h.id)).toEqual(["walrus-notes"]);
    const theirs = await call(YOU, "query", { q: "walrus", types: ["artifact"] });
    expect(theirs.body.primary).toEqual([]);
    expect(theirs.body.pointers).toEqual([]);
    const browseMine = await call(ME, "query", { types: ["artifact"] });
    expect(browseMine.body.primary.map((h: { id: string }) => h.id)).toEqual(["walrus-notes"]);
    const browseTheirs = await call(YOU, "query", { types: ["artifact"] });
    expect(browseTheirs.body.primary).toEqual([]);
  });

  it("GET /search threads the session principal, and drops drafts (include_staged false)", async () => {
    await call(ME, "upload_asset", textArgs({ title: "Heron plan", content: "heron", visibility: "private" }));
    await call(ME, "artifact_update", { slug: "heron-plan", content: "heron 2", summary: "v2" }); // published, still private
    await call(ME, "upload_asset", textArgs({ title: "Heron draft", content: "heron draft" })); // org, draft
    const search = async (who: string) => {
      const res = await app.request("/search?q=heron&types=artifact", { headers: { cookie: await cookieFor(who) } }, env);
      expect(res.status).toBe(200);
      return ((await res.json()) as { result: { primary: { id: string }[]; pointers: { id: string }[] } }).result;
    };
    const mine = await search(ME);
    expect([...mine.primary, ...mine.pointers].map((h) => h.id)).toEqual(["heron-plan"]);
    const theirs = await search(YOU);
    expect([...theirs.primary, ...theirs.pointers]).toEqual([]);
  });

  it("section/space filters are doc-only, so artifacts drop out", async () => {
    await call(ME, "upload_asset", textArgs({ title: "Ibis", content: "ibis" }));
    const r = await call(ME, "query", { q: "ibis", section: "reference" });
    expect([...r.body.primary, ...r.body.pointers].filter((h: { type: string }) => h.type === "artifact")).toEqual([]);
  });
});

// ── get_ticket artifacts ─────────────────────────────────────────────────────

describe("get_ticket — linked artifacts the principal can see", () => {
  it("lists linked pages as {slug, title, kind, status, version}; a private one only for its author", async () => {
    const tid = await seedTicket();
    await call(ME, "upload_asset", textArgs({ title: "Login diagram", kind: "mermaid", content: "graph TD; A-->B", links: [{ target_type: "ticket", target_ref: String(tid) }] }));
    await call(ME, "upload_asset", textArgs({ title: "Login scratch", visibility: "private", links: [{ target_type: "ticket", target_ref: `#${tid}` }] }));
    await call(ME, "upload_asset", textArgs({ title: "Unrelated" }));
    const mine = await call(ME, "get_ticket", { id: tid });
    expect(mine.body.artifacts.map((a: { slug: string }) => a.slug).sort()).toEqual(["login-diagram", "login-scratch"]);
    const theirs = await call(YOU, "get_ticket", { id: tid });
    expect(theirs.body.artifacts).toEqual([{ slug: "login-diagram", title: "Login diagram", kind: "mermaid", status: "draft", version: 1 }]);
    expect(theirs.body.id).toBe(tid);
  });
});

// ── record_session / /ingest artifact_links ──────────────────────────────────

describe("artifact_links on the session batch", () => {
  const payload = (id: string, links: unknown[]) => ({
    session: { id, author: "spoofed", ended_at: "2026-09-23T00:00:00Z", skill_version: "2.0" },
    artifact_links: links,
  });

  it("record_session links AFTER the batch, as the principal, reporting linked / not_found / error per link", async () => {
    const tid = await seedTicket();
    await call(ME, "upload_asset", textArgs({ title: "Session output", repo: "SaplingLearn/sapling" }));
    await call(YOU, "upload_asset", textArgs({ title: "Their secret", visibility: "private" }));
    const r = await call(ME, "record_session", {
      ...payload(crypto.randomUUID(), [
        { slug: "session-output", target_type: "ticket", target_ref: String(tid) },
        { slug: "session-output", target_type: "pr", target_ref: "#42" },
        { slug: "their-secret", target_type: "ticket", target_ref: String(tid) },
        { slug: "no-such-page", target_type: "ticket", target_ref: String(tid) },
        { slug: "session-output", target_type: "ticket", target_ref: "999999" },
      ]),
      feed_entries: [{ summary: "Shipped: x", body: "b", tags: ["infra"], artifacts: {} }],
    });
    expect(r.isError).toBe(false);
    expect(r.body.feed.written).toBe(1); // the batch itself still reconciled
    expect(r.body.artifact_links.map((o: { outcome: string }) => o.outcome)).toEqual(["linked", "linked", "not_found", "not_found", "error"]);
    expect(r.body.artifact_links[4].error).toMatch(/no such ticket/);
    const links = await all<{ target_type: string; target_ref: string; created_by: string }>(env.DB,
      `SELECT l.target_type, l.target_ref, l.created_by FROM artifact_links l JOIN artifact_pages p ON p.id = l.page_id ORDER BY l.target_type`);
    expect(links).toEqual([
      { target_type: "pr", target_ref: "SaplingLearn/sapling#42", created_by: ME },
      { target_type: "ticket", target_ref: String(tid), created_by: ME },
    ]);
    // the ticket read now surfaces it
    expect((await call(ME, "get_ticket", { id: tid })).body.artifacts.map((a: { slug: string }) => a.slug)).toEqual(["session-output"]);
  });

  it("a replay of the same session re-links nothing new (idempotent) and the key is absent when no links were sent", async () => {
    const tid = await seedTicket();
    await call(ME, "upload_asset", textArgs({ title: "Replay me" }));
    const p = payload(crypto.randomUUID(), [{ slug: "replay-me", target_type: "ticket", target_ref: String(tid) }]);
    await call(ME, "record_session", p);
    const again = await call(ME, "record_session", p);
    expect(again.body.artifact_links[0].outcome).toBe("linked");
    expect(await all(env.DB, `SELECT page_id FROM artifact_links`)).toHaveLength(1);
    const none = await call(ME, "record_session", payload(crypto.randomUUID(), []));
    expect(none.body.artifact_links).toBeUndefined();
  });

  it("/ingest applies artifact_links identically, under the session principal", async () => {
    const tid = await seedTicket();
    await call(ME, "upload_asset", textArgs({ title: "Ingest link" }));
    await call(ME, "upload_asset", textArgs({ title: "Mine only", visibility: "private" }));
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await cookieFor(YOU) },
      body: JSON.stringify(payload(crypto.randomUUID(), [
        { slug: "ingest-link", target_type: "ticket", target_ref: String(tid) },
        { slug: "mine-only", target_type: "ticket", target_ref: String(tid) },
      ])),
    }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { artifact_links: { outcome: string }[] } };
    expect(body.result.artifact_links.map((o) => o.outcome)).toEqual(["linked", "not_found"]);
    const rows = await all<{ created_by: string }>(env.DB, `SELECT created_by FROM artifact_links`);
    expect(rows).toEqual([{ created_by: YOU }]);
  });
});
