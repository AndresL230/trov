// Prompt soft delete (0035 PART C): POST /api/prompts/:slug/delete + /restore.
// The author or an admin deletes; the prompt leaves EVERY read (library, detail,
// versions, /search/quick, MCP search_prompts / get_prompt, prompts_fts) while its
// versions stay in D1; its slug stays reserved (409); restore brings it all back; a
// rename rewrites deleted_by; there is no MCP delete.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { app } from "../src/routes";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { all, first } from "../src/db";
import { savePrompt, deletePrompt, recordPromptUse, PromptSaveInput } from "../src/tools/prompts";
import { renamePerson } from "../src/auth/persons";
import { cookieFor, seedPerson } from "./helpers/persons";
import type { PromptDetail, PromptSummary } from "../shared/handoffs";
import type { QuickSearchResult } from "@shared/quick-search";
import { bearerCtx } from "./helpers/tenant";

const AUTHOR = "pauthor";
const OTHER = "pother";
const ADMIN = "admin-user"; // ADMIN_LOGINS in vitest.config.ts
const SLUG = "zebra-review";

beforeEach(async () => {
  for (const h of [AUTHOR, OTHER, ADMIN]) await seedPerson(h);
  await savePrompt(env.DB, AUTHOR, PromptSaveInput.parse({ slug: SLUG, title: "Zebra review", body: "Review the zebra {{thing}}.", status: "published", description: "Stripes" }), "human");
  await savePrompt(env.DB, AUTHOR, PromptSaveInput.parse({ slug: SLUG, title: "Zebra review", body: "Review the zebra {{thing}} twice.", status: "published" }), "human");
});

async function req(method: string, path: string, who: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method, headers: { cookie: await cookieFor(who), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
}
const del = (who: string, slug = SLUG) => req("POST", `/api/prompts/${slug}/delete`, who, {});
const restore = (who: string, slug = SLUG) => req("POST", `/api/prompts/${slug}/restore`, who, {});

async function mcp(handle: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError?: boolean }> {
  const server = buildTrovMcpServer({ ...(env as unknown as Env), PUBLIC_ORIGIN: "https://trov.example/" } as Env, await bearerCtx(handle));
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

/** Every surface a prompt can be read on — true where it shows. */
async function visibility(slug = SLUG): Promise<Record<string, boolean>> {
  const list = (await (await req("GET", "/api/prompts", OTHER)).json()) as { prompts: PromptSummary[] };
  const listQ = (await (await req("GET", "/api/prompts?q=zebra", OTHER)).json()) as { prompts: PromptSummary[] };
  const detail = await req("GET", `/api/prompts/${slug}`, OTHER);
  const versions = await req("GET", `/api/prompts/${slug}/versions`, OTHER);
  const quick = (await (await req("GET", "/search/quick?q=zebra", OTHER)).json()) as { result: QuickSearchResult };
  const search = JSON.parse((await mcp(OTHER, "search_prompts", { q: "zebra" })).text) as { slug: string }[];
  const searchAll = JSON.parse((await mcp(OTHER, "search_prompts", {})).text) as { slug: string }[];
  const get = await mcp(OTHER, "get_prompt", { slug });
  const fts = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM prompts_fts WHERE slug = ?`, slug);
  return {
    list: list.prompts.some((p) => p.slug === slug),
    listQ: listQ.prompts.some((p) => p.slug === slug),
    detail: detail.status === 200,
    versions: versions.status === 200,
    quick: (quick.result.groups.find((g) => g.type === "prompt")?.hits ?? []).some((h) => h.id === slug),
    mcpSearch: search.some((p) => p.slug === slug),
    mcpSearchAll: searchAll.some((p) => p.slug === slug),
    mcpGet: !get.isError,
    fts: fts!.n > 0,
  };
}
const everywhere = (v: boolean) => ({ list: v, listQ: v, detail: v, versions: v, quick: v, mcpSearch: v, mcpSearchAll: v, mcpGet: v, fts: v });

describe("POST /api/prompts/:slug/delete", () => {
  it("the author deletes: gone from every read, versions kept in D1, the delete stamped", async () => {
    expect(await visibility()).toEqual(everywhere(true));
    const res = await del(AUTHOR);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slug: SLUG, title: "Zebra review" });

    expect(await visibility()).toEqual(everywhere(false));
    expect((await (await req("GET", `/api/prompts/${SLUG}`, OTHER)).json())).toEqual({ error: "not found" }); // same as unknown
    expect((await (await req("GET", `/api/prompts/no-such-prompt`, OTHER)).json())).toEqual({ error: "not found" });
    expect(JSON.parse((await mcp(OTHER, "get_prompt", { slug: SLUG })).text)).toMatchObject({ code: "not_found" });

    const row = await first<{ deleted_at: string | null; deleted_by: string | null; use_count: number }>(env.DB, `SELECT deleted_at, deleted_by, use_count FROM prompts WHERE slug = ?`, SLUG);
    expect(row!.deleted_by).toBe(AUTHOR);
    expect(row!.deleted_at).toMatch(/^\d{4}-/);
    expect(row!.use_count).toBe(1); // the get_prompt BEFORE the delete counted; the one after did not
    expect((await all(env.DB, `SELECT version FROM prompt_versions WHERE slug = ? ORDER BY version`, SLUG)).length).toBe(2);
  });

  it("a deleted prompt takes no writes: tags, publish, use, a second delete — all not found", async () => {
    await del(AUTHOR);
    expect((await req("POST", `/api/prompts/${SLUG}/tags`, AUTHOR, { tags: ["ui"] })).status).toBe(404);
    expect((await req("POST", `/api/prompts/${SLUG}/publish`, AUTHOR, { version: 2 })).status).toBe(404);
    expect((await req("POST", `/api/prompts/${SLUG}/used`, AUTHOR, {})).status).toBe(404);
    expect(await recordPromptUse(env.DB, SLUG)).toBe(false);
    expect((await del(AUTHOR)).status).toBe(404);
  });

  it("anyone else is 403 and nothing is written", async () => {
    const res = await del(OTHER);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/author or an admin/);
    expect(await first(env.DB, `SELECT deleted_at, deleted_by FROM prompts WHERE slug = ?`, SLUG)).toEqual({ deleted_at: null, deleted_by: null });
    expect(await visibility()).toEqual(everywhere(true));
  });

  it("an admin may delete someone else's prompt", async () => {
    expect((await del(ADMIN)).status).toBe(200);
    expect((await first<{ deleted_by: string }>(env.DB, `SELECT deleted_by FROM prompts WHERE slug = ?`, SLUG))!.deleted_by).toBe(ADMIN);
  });

  it("the author check is case-insensitive, like every handle", async () => {
    await expect(deletePrompt(env.DB, SLUG, AUTHOR.toUpperCase(), false)).resolves.toEqual({ slug: SLUG, title: "Zebra review" });
  });

  it("an unknown slug is 404", async () => {
    expect((await del(AUTHOR, "no-such-prompt")).status).toBe(404);
  });

  it("is never an MCP tool — no agent can delete or restore a prompt", async () => {
    const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx(ADMIN));
    const client = new Client({ name: "test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close(); await server.close();
    expect(names).toContain("save_prompt");
    expect(names.filter((n) => /delete|restore|remove/.test(n) && /prompt/.test(n))).toEqual([]);
  });
});

describe("POST /api/prompts/:slug/restore", () => {
  it("brings it back everywhere, exactly as it was", async () => {
    const before = (await (await req("GET", `/api/prompts/${SLUG}`, OTHER)).json()) as { prompt: PromptDetail };
    await del(AUTHOR);
    const res = await restore(AUTHOR);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; prompt: PromptDetail };
    expect(body.prompt.slug).toBe(SLUG);
    expect(await visibility()).toEqual(everywhere(true));
    const after = (await (await req("GET", `/api/prompts/${SLUG}`, OTHER)).json()) as { prompt: PromptDetail };
    expect({ ...after.prompt, use_count: 0, last_used_at: null }).toEqual({ ...before.prompt, use_count: 0, last_used_at: null });
    expect(await first(env.DB, `SELECT deleted_at, deleted_by FROM prompts WHERE slug = ?`, SLUG)).toEqual({ deleted_at: null, deleted_by: null });
  });

  it("the same people as delete: another member is 403, an admin may", async () => {
    await del(AUTHOR);
    expect((await restore(OTHER)).status).toBe(403);
    expect((await first<{ deleted_by: string }>(env.DB, `SELECT deleted_by FROM prompts WHERE slug = ?`, SLUG))!.deleted_by).toBe(AUTHOR);
    expect((await restore(ADMIN)).status).toBe(200);
  });

  it("a live prompt is 409 not deleted; an unknown one 404", async () => {
    const res = await restore(AUTHOR);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "prompt is not deleted" });
    expect((await restore(AUTHOR, "no-such-prompt")).status).toBe(404);
  });
});

describe("a deleted prompt's slug stays reserved", () => {
  const save = (who: string, body: Record<string, unknown>) => req("POST", "/api/prompts", who, body);

  it("a new prompt with that slug is a 409 that names the fix — nothing written", async () => {
    await del(AUTHOR);
    const res = await save(OTHER, { slug: SLUG, title: "New zebra", body: "Something else." });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(`slug ${SLUG} belongs to a deleted prompt — restore it instead of reusing the slug`);
    expect((await all(env.DB, `SELECT version FROM prompt_versions WHERE slug = ?`, SLUG)).length).toBe(2);
    expect((await first<{ title: string }>(env.DB, `SELECT title FROM prompts WHERE slug = ?`, SLUG))!.title).toBe("Zebra review");
  });

  it("so is renaming another prompt onto it, and an agent's save_prompt", async () => {
    await savePrompt(env.DB, OTHER, PromptSaveInput.parse({ slug: "other-one", title: "Other", body: "b" }), "human");
    await del(AUTHOR);
    const rn = await save(OTHER, { slug: SLUG, base_slug: "other-one", title: "Other", body: "b2" });
    expect(rn.status).toBe(409);
    expect(((await rn.json()) as { error: string }).error).toMatch(/deleted prompt/);
    const agent = await mcp(OTHER, "save_prompt", { slug: SLUG, title: "T", body: "b" });
    expect(agent.isError).toBe(true);
    expect(agent.text).toMatch(/deleted prompt/);
    expect((await all(env.DB, `SELECT version FROM prompt_versions WHERE slug = ?`, SLUG)).length).toBe(2);
  });

  it("after a restore the slug is the prompt's again — a save appends a version", async () => {
    await del(AUTHOR);
    await restore(AUTHOR);
    expect((await save(AUTHOR, { slug: SLUG, title: "Zebra review", body: "v3" })).status).toBe(200);
    expect((await all(env.DB, `SELECT version FROM prompt_versions WHERE slug = ?`, SLUG)).length).toBe(3);
  });
});

describe("a handle rename rewrites deleted_by", () => {
  it("deleted_by follows the person", async () => {
    await del(AUTHOR);
    expect(await renamePerson(env.DB, AUTHOR, "pauthor-renamed")).toEqual({ ok: true });
    expect(await first(env.DB, `SELECT author, deleted_by FROM prompts WHERE slug = ?`, SLUG)).toEqual({ author: "pauthor-renamed", deleted_by: "pauthor-renamed" });
    expect((await restore("pauthor-renamed")).status).toBe(200);
  });
});
