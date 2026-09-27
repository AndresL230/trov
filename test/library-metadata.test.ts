// 0035_library_and_sprint_dates (PART A): doc ownership, artifact published_at, prompt usage — the three
// data sources behind My Work's "library" strip. Writers, reads, the migration's
// backfill UPDATEs (run again here against rows with the new columns blanked) and the
// handle rename.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { app } from "../src/routes";
import { buildCanopyMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { all, first, run } from "../src/db";
import { propose_doc_update, promote_doc } from "../src/tools/writes";
import { ingestDocProposal } from "../src/consumer";
import { renamePerson } from "../src/auth/persons";
import { createPage, addTextVersion, patchPage, setStatus, ratify, getPage, listPages } from "../src/tools/artifacts";
import { listPrompts } from "../src/tools/prompts";
import { cookieFor, seedPerson } from "./helpers/persons";
import { buildSeedStatements } from "../scripts/seed/build.mjs";
import prompts from "../fixtures/dev/prompts.json";
import combined from "../migrations/0035_library_and_sprint_dates.sql?raw";
/** PART A of the consolidated migration — the library-metadata half. */
const migration = combined.split("-- ═══ PART B")[0];
import type { DocRow } from "../shared/rows";
import type { PromptDetail, PromptSummary } from "../shared/handoffs";

/** The migration's backfill UPDATE statements, re-run against the current rows. */
async function runBackfill(): Promise<void> {
  const updates = migration.replace(/^--.*$/gm, "").match(/^UPDATE[\s\S]*?;$/gm) ?? [];
  expect(updates.length).toBe(2);
  for (const u of updates) await env.DB.prepare(u).run();
}

const get = async (path: string, who = "AndresL230") => app.request(path, { headers: { cookie: await cookieFor(who) } }, env);
const post = async (path: string, who = "AndresL230", body: unknown = {}) =>
  app.request(path, { method: "POST", headers: { cookie: await cookieFor(who), "content-type": "application/json" }, body: JSON.stringify(body) }, env);

const docProposal = (slug: string, body: string) =>
  ({ slug, section: "reference", title: "T", body, change_summary: "s", confidence: "high" as const });

// ── 1. docs.owner ────────────────────────────────────────────────────────────

describe("docs.owner", () => {
  it("is the proposer of the first version, and survives later edits and promotions", async () => {
    await propose_doc_update(env.DB, docProposal("owned-doc", "v1"), "meilin");
    await promote_doc(env.DB, "owned-doc", 1, "AndresL230");
    await propose_doc_update(env.DB, docProposal("owned-doc", "v2"), "sanaok");
    await promote_doc(env.DB, "owned-doc", 2, "Darkest-Teddy");
    const row = await first<{ owner: string; updated_by: string }>(env.DB, `SELECT owner, updated_by FROM docs WHERE slug = 'owned-doc'`);
    expect(row).toEqual({ owner: "meilin", updated_by: "Darkest-Teddy" });
  });

  it("the gate (ingestDocProposal) stamps the authenticated principal, and every docs read returns it", async () => {
    const r = await ingestDocProposal(env.DB, docProposal("gated-doc", "hello"), "sanaok");
    expect(r.outcome).toBe("written");
    await ingestDocProposal(env.DB, docProposal("gated-doc", "hello, edited"), "meilin");
    const one = (await (await get("/doc/gated-doc")).json()) as { doc: DocRow };
    expect(one.doc.owner).toBe("sanaok");
    const list = (await (await get("/docs")).json()) as { docs: DocRow[] };
    expect(list.docs.find((d) => d.slug === "gated-doc")?.owner).toBe("sanaok");
    const meta = (await (await get("/docs?fields=meta")).json()) as { docs: Array<{ slug: string; owner: string | null; body?: string }> };
    const m = meta.docs.find((d) => d.slug === "gated-doc");
    expect(m?.owner).toBe("sanaok");
    expect(m?.body).toBeUndefined();
  });

  it("the web's POST /api/docs/propose owns the doc as the signed-in person", async () => {
    const res = await post("/api/docs/propose", "meilin", { title: "Web doc", section: "reference", space: "technical", body: "b" });
    expect(res.status).toBe(200);
    expect((await first<{ owner: string }>(env.DB, `SELECT owner FROM docs WHERE slug = 'web-doc'`))?.owner).toBe("meilin");
  });

  it("backfill: the earliest version's author; no versions → updated_by", async () => {
    await run(env.DB, `INSERT INTO docs (slug, section, title, body, current_version, updated_at, updated_by) VALUES ('old-doc', 'reference', 'Old', 'b', 2, '2026-01-02', 'promoter')`);
    await run(env.DB, `INSERT INTO doc_versions (slug, version, body, status, created_at, created_by) VALUES ('old-doc', 2, 'b2', 'promoted', '2026-01-02', 'second')`);
    await run(env.DB, `INSERT INTO doc_versions (slug, version, body, status, created_at, created_by) VALUES ('old-doc', 1, 'b1', 'promoted', '2026-01-01', 'first')`);
    await run(env.DB, `INSERT INTO docs (slug, section, title, body, current_version, updated_at, updated_by) VALUES ('bare-doc', 'reference', 'Bare', 'b', 0, '2026-01-01', 'lonely')`);
    await propose_doc_update(env.DB, docProposal("kept-doc", "b"), "meilin");
    await runBackfill();
    const owners = await all<{ slug: string; owner: string }>(env.DB, `SELECT slug, owner FROM docs ORDER BY slug`);
    expect(owners).toEqual([
      { slug: "bare-doc", owner: "lonely" },
      { slug: "kept-doc", owner: "meilin" }, // already set → untouched
      { slug: "old-doc", owner: "first" },
    ]);
  });

  it("a handle rename rewrites it", async () => {
    await seedPerson("old-owner");
    await propose_doc_update(env.DB, docProposal("renamed-doc", "b"), "old-owner");
    expect(await renamePerson(env.DB, "old-owner", "new-owner")).toEqual({ ok: true });
    expect((await first<{ owner: string }>(env.DB, `SELECT owner FROM docs WHERE slug = 'renamed-doc'`))?.owner).toBe("new-owner");
  });
});

// ── 2. artifact_pages.published_at ───────────────────────────────────────────

describe("artifact_pages.published_at", () => {
  const mk = (title = "Auth flow", visibility: "org" | "private" = "org") =>
    createPage(env.DB, { title, kind: "markdown", content: "# v1", area: "auth", visibility }, "AndresL230");
  const stamp = async (slug: string) => (await first<{ published_at: string | null }>(env.DB, `SELECT published_at FROM artifact_pages WHERE slug = ?`, slug))!.published_at;
  const setStamp = (slug: string, v: string | null) => run(env.DB, `UPDATE artifact_pages SET published_at = ? WHERE slug = ?`, v, slug);

  it("create is a draft with no stamp; publishing stamps it and the DTOs carry it", async () => {
    const a = await mk();
    expect(a.status).toBe("draft");
    expect(a.published_at).toBeNull();
    const pub = await setStatus(env.DB, a.slug, "published", "AndresL230");
    expect(pub.published_at).toEqual(expect.any(String));
    expect((await listPages(env.DB, {}, "AndresL230")).find((p) => p.slug === a.slug)?.published_at).toBe(pub.published_at);
  });

  it("re-publishing an already-published page and ratifying keep the stamp", async () => {
    const a = await mk();
    await setStatus(env.DB, a.slug, "published", "AndresL230");
    await setStamp(a.slug, "2026-01-01T00:00:00.000Z");
    await setStatus(env.DB, a.slug, "published", "AndresL230");
    await patchPage(env.DB, a.slug, { title: "Renamed" }, "AndresL230");
    expect(await stamp(a.slug)).toBe("2026-01-01T00:00:00.000Z");
    const r = await ratify(env.DB, a.slug, 1, "AndresL230");
    expect(r.published_at).toBe("2026-01-01T00:00:00.000Z");
    // un-ratify back to published keeps it too
    await setStatus(env.DB, a.slug, "published", "AndresL230");
    expect(await stamp(a.slug)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("a later version re-stamps (it auto-publishes); → draft clears it", async () => {
    const a = await mk();
    await setStatus(env.DB, a.slug, "published", "AndresL230");
    await setStamp(a.slug, "2026-01-01T00:00:00.000Z");
    const v2 = await addTextVersion(env.DB, a.slug, { content: "# v2" }, "AndresL230");
    expect(v2.page.status).toBe("published");
    expect(v2.page.published_at).toBe(v2.page.version.created_at);
    const draft = await setStatus(env.DB, a.slug, "draft", "AndresL230");
    expect(draft.published_at).toBeNull();
    // a new version on a draft publishes it again, stamped
    const v3 = await addTextVersion(env.DB, a.slug, { content: "# v3" }, "AndresL230");
    expect(v3.page.published_at).toBe(v3.page.version.created_at);
    // an unchanged (same sha) version writes nothing
    await setStamp(a.slug, "2026-02-02T00:00:00.000Z");
    const same = await addTextVersion(env.DB, a.slug, { content: "# v3" }, "AndresL230");
    expect(same.unchanged).toBe(true);
    expect(await stamp(a.slug)).toBe("2026-02-02T00:00:00.000Z");
  });

  it("private → org on a draft publishes it, stamped", async () => {
    const a = await mk("Secret", "private");
    const pub = await patchPage(env.DB, a.slug, { visibility: "org" }, "AndresL230");
    expect(pub.status).toBe("published");
    expect(pub.published_at).toEqual(expect.any(String));
  });

  it("the HTTP detail returns it", async () => {
    const a = await mk();
    await setStatus(env.DB, a.slug, "published", "AndresL230");
    const body = (await (await get(`/api/artifacts/${a.slug}`)).json()) as { published_at?: string | null; artifact?: { published_at: string | null } };
    const dto = body.artifact ?? body;
    expect(dto.published_at).toBe(await stamp(a.slug));
  });

  it("backfill: published / ratified pages get the current version's created_at; drafts stay null", async () => {
    const draft = await mk("Draft one");
    const pub = await mk("Published one");
    await setStatus(env.DB, pub.slug, "published", "AndresL230");
    await addTextVersion(env.DB, pub.slug, { content: "# two" }, "AndresL230");
    const rat = await mk("Ratified one");
    await setStatus(env.DB, rat.slug, "published", "AndresL230");
    await ratify(env.DB, rat.slug, 1, "AndresL230");
    await run(env.DB, `UPDATE artifact_pages SET published_at = NULL`);
    await run(env.DB, `UPDATE artifact_versions SET created_at = '2026-03-0' || version_no || 'T00:00:00.000Z'`);
    await runBackfill();
    expect(await stamp(draft.slug)).toBeNull();
    expect(await stamp(pub.slug)).toBe("2026-03-02T00:00:00.000Z");
    expect(await stamp(rat.slug)).toBe("2026-03-01T00:00:00.000Z");
    expect((await getPage(env.DB, rat.slug, null, "AndresL230")).published_at).toBe("2026-03-01T00:00:00.000Z");
  });
});

// ── 3. prompts.use_count / last_used_at ──────────────────────────────────────

describe("prompt usage", () => {
  beforeEach(async () => {
    for (const stmt of buildSeedStatements({ prompts })) await env.DB.prepare(stmt).run();
  });

  async function mcp(handle: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    const server = buildCanopyMcpServer({ ...(env as unknown as Env), PUBLIC_ORIGIN: "https://canopy.example/" } as Env, { handle });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
      return { text: res.content[0].text, isError: res.isError };
    } finally {
      await client.close();
      await server.close();
    }
  }
  const usage = (slug: string) => first<{ use_count: number; last_used_at: string | null; updated_at: string }>(
    env.DB, `SELECT use_count, last_used_at, updated_at FROM prompts WHERE slug = ?`, slug);

  it("starts at 0 / null, exposed on the list and the detail", async () => {
    const list = (await (await get("/api/prompts")).json()) as { prompts: PromptSummary[] };
    expect(list.prompts.every((p) => p.use_count === 0 && p.last_used_at === null)).toBe(true);
    const one = (await (await get("/api/prompts/adr-draft")).json()) as { prompt: PromptDetail };
    expect(one.prompt.use_count).toBe(0);
    expect(one.prompt.last_used_at).toBeNull();
  });

  it("MCP get_prompt counts each call once, for any principal, without touching updated_at or search", async () => {
    const before = await usage("sse-endpoint-review");
    const r1 = JSON.parse((await mcp("meilin", "get_prompt", { slug: "sse-endpoint-review" })).text) as PromptDetail;
    expect(r1.use_count).toBe(1);
    await mcp("AndresL230", "get_prompt", { slug: "sse-endpoint-review", vars: { endpoint: "/x" } });
    const after = await usage("sse-endpoint-review");
    expect(after?.use_count).toBe(2);
    expect(after?.last_used_at).toEqual(expect.any(String));
    expect(after?.updated_at).toBe(before?.updated_at);
    expect((await listPrompts(env.DB, { q: "heartbeat" })).map((p) => p.slug)).toEqual(["sse-endpoint-review"]);
    // unknown slug: an error, nothing written
    const miss = await mcp("AndresL230", "get_prompt", { slug: "no-such-prompt" });
    expect(miss.isError).toBe(true);
    expect((await first<{ n: number }>(env.DB, `SELECT SUM(use_count) AS n FROM prompts`))?.n).toBe(2);
  });

  it("POST /api/prompts/:slug/used counts one use per request; unknown slug is a 404", async () => {
    const r = await post("/api/prompts/adr-draft/used");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; use_count: number; last_used_at: string };
    expect(body.ok).toBe(true);
    expect(body.use_count).toBe(1);
    await post("/api/prompts/adr-draft/used", "meilin");
    expect((await usage("adr-draft"))?.use_count).toBe(2);
    const miss = await post("/api/prompts/no-such-prompt/used");
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ error: "not found" });
  });

  it("GET /api/prompts?sort=used lists the most used first", async () => {
    for (let i = 0; i < 3; i++) await post("/api/prompts/lesson-mdx-lint/used");
    await post("/api/prompts/adr-draft/used");
    await post("/api/prompts/ocr-failure-triage/used");
    await run(env.DB, `UPDATE prompts SET last_used_at = '2026-01-01T00:00:00.000Z' WHERE slug = 'ocr-failure-triage'`);
    const list = (await (await get("/api/prompts?sort=used")).json()) as { prompts: PromptSummary[] };
    const slugs = list.prompts.map((p) => p.slug);
    expect(slugs.slice(0, 3)).toEqual(["lesson-mdx-lint", "adr-draft", "ocr-failure-triage"]); // tie on 1 → the more recent use first
    expect(slugs.length).toBe(8);
    // never-used ones follow, most recently updated first
    const rest = list.prompts.slice(3);
    expect(rest.map((p) => p.updated_at)).toEqual([...rest.map((p) => p.updated_at)].sort().reverse());
    // an unknown sort falls back to recency
    const dflt = (await (await get("/api/prompts?sort=bogus")).json()) as { prompts: PromptSummary[] };
    expect(dflt.prompts.map((p) => p.slug)).toEqual((await listPrompts(env.DB)).map((p) => p.slug));
  });
});
