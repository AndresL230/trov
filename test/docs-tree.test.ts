// The Docs Library's page tree and links (0081_docs_library; docs/architecture/docs-library.md › The page tree):
// `POST /api/o/<org>/doc/:slug/move` (planMove server-side, the renumber in one batch, the refusals), a proposal's `parent_slug`
// (a new page at insert, an existing page on promote, an invalid one ignored with a note), the server-only import
// options, `doc_links` rebuilt on promote, and the doc read's `page` (ancestors, children, links, backlinks, rail).
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DocMoveResult, DocPageDTO } from "@shared/docs-core";
import { MAX_DEPTH } from "@shared/docs-tree-core";
import { ingestDocProposal } from "../src/consumer";
import { buildTrovMcpServer } from "../src/mcp";
import { promote_doc } from "../src/tools/writes";
import { all, first } from "./helpers/db";
import { call } from "./helpers/orgs";
import { cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, bearerCtx, ensureMember, mintTokenFor, systemCtx } from "./helpers/tenant";

const OWNER = "AndresL230";
const MEMBER = "lpcooper-arch";
const A = () => systemCtx(ORG_A);
const B = () => systemCtx(ORG_B);
const ledger = () => ({ sessionId: crypto.randomUUID(), itemIndex: 0 });
const doc = (slug: string, o: { space?: string; parent?: string; body?: string; title?: string } = {}) => ({
  slug, section: "reference", title: o.title ?? `${slug} title`, body: o.body ?? `${slug} body`, change_summary: "s", confidence: "high" as const,
  ...(o.space ? { space: o.space } : {}), ...(o.parent ? { parent_slug: o.parent } : {}),
});
/** Stage and promote a page (version 1, or the next one). */
async function live(slug: string, o: Parameters<typeof doc>[1] = {}, ctx = A()): Promise<void> {
  const r = await ingestDocProposal(ctx, doc(slug, o), OWNER, ledger());
  if (r.outcome !== "written") throw new Error(`not staged: ${slug} ${JSON.stringify(r)}`);
  await promote_doc(ctx, slug, r.version, OWNER);
}
const place = (slug: string, org = ORG_A) => first<{ parent_slug: string | null; tree_rank: number | null; space: string }>(env.DB, `SELECT parent_slug, tree_rank, space FROM docs WHERE org_id = ? AND slug = ?`, org, slug);
const move = async (cookie: string, slug: string, body: unknown) => call<DocMoveResult & { error?: string }>("POST", `/api/o/saplinglearn/doc/${slug}/move`, cookie, body);
const page = async (cookie: string, slug: string) => (await call<{ page: DocPageDTO }>("GET", `/api/o/saplinglearn/doc/${slug}`, cookie)).json.page;

describe("POST /api/o/:org/doc/:slug/move — the tree's rules, server-side", () => {
  it("into / before / after / top, with any signed-in member; the first drop into an unranked list renumbers it in one batch", async () => {
    const member = await cookieFor(MEMBER);
    for (const s of ["alpha", "bravo", "charlie", "delta"]) await live(s);
    // Into: alpha goes under bravo as its (only) child.
    const into = await move(member, "alpha", { target: "into", ref: "bravo" });
    expect(into.status).toBe(200);
    expect(into.json).toMatchObject({ ok: true, slug: "alpha", parent_slug: "bravo" });
    expect(await place("alpha")).toMatchObject({ parent_slug: "bravo" });
    // Before: delta goes before bravo at the top level; the top level had no ranks, so it is renumbered — every place is in the answer.
    const before = await move(member, "delta", { target: "before", ref: "bravo" });
    expect(before.status).toBe(200);
    const ranks = Object.fromEntries((await all<{ slug: string; tree_rank: number | null }>(env.DB, `SELECT slug, tree_rank FROM docs WHERE org_id = ? AND parent_slug IS NULL`, ORG_A)).map((r) => [r.slug, r.tree_rank]));
    expect(ranks.delta).not.toBeNull();
    expect(ranks.bravo).not.toBeNull();
    expect(ranks.charlie).not.toBeNull();
    expect(ranks.delta!).toBeLessThan(ranks.bravo!);
    expect(ranks.bravo!).toBeLessThan(ranks.charlie!);
    expect(before.json.places.map((p) => p.slug).sort()).toEqual(["bravo", "charlie", "delta"]);
    // After: charlie right after delta, between delta and bravo (no renumber now).
    const after = await move(member, "charlie", { target: "after", ref: "delta" });
    expect(after.json.places).toHaveLength(1);
    const c = (await place("charlie"))!.tree_rank!;
    expect(c).toBeGreaterThan(ranks.delta!);
    expect(c).toBeLessThan(ranks.bravo!);
    // Top: alpha back to the end of the top level.
    const top = await move(member, "alpha", { target: "top" });
    expect(top.json).toMatchObject({ parent_slug: null });
    expect((await place("alpha"))!.tree_rank!).toBeGreaterThan(ranks.bravo!);
    // A move is not an edit: updated_by is still the promoter.
    expect((await first<{ updated_by: string }>(env.DB, `SELECT updated_by FROM docs WHERE org_id = ? AND slug = 'alpha'`, ORG_A))?.updated_by).toBe(OWNER);
  });

  it("refuses a cycle, a page on itself, a tree too deep, another space, and an unknown page — writing nothing", async () => {
    const member = await cookieFor(MEMBER);
    await live("root");
    await live("kid", { parent: "root" });
    await live("prod-page", { space: "product" });
    const snapshot = async () => all(env.DB, `SELECT slug, parent_slug, tree_rank FROM docs WHERE org_id = ? ORDER BY slug`, ORG_A);
    const before = await snapshot();
    expect((await move(member, "root", { target: "into", ref: "kid" })).json).toMatchObject({ error: "cycle" });
    expect((await move(member, "root", { target: "into", ref: "kid" })).status).toBe(409);
    expect((await move(member, "root", { target: "before", ref: "root" })).json).toMatchObject({ error: "self" });
    expect((await move(member, "root", { target: "into", ref: "prod-page" })).json).toMatchObject({ error: "other_space" });
    expect((await move(member, "root", { target: "into", ref: "nope" })).status).toBe(404);
    expect((await move(member, "nope", { target: "top" })).status).toBe(404);
    expect((await move(member, "root", { target: "sideways" })).status).toBe(400);
    expect((await move(member, "root", { target: "into" })).status).toBe(400);
    expect(await snapshot()).toEqual(before);

    // Too deep: a chain of MAX_DEPTH levels; nothing more goes under its last page, and its root cannot go one deeper.
    let parent = "d0";
    await live("d0");
    for (let i = 1; i < MAX_DEPTH; i++) { await live(`d${i}`, { parent }); parent = `d${i}`; }
    expect((await place(`d${MAX_DEPTH - 1}`))?.parent_slug).toBe(`d${MAX_DEPTH - 2}`);
    await live("loose");
    expect((await move(member, "loose", { target: "into", ref: `d${MAX_DEPTH - 1}` })).json).toMatchObject({ error: "too_deep" });
    expect((await move(member, "d0", { target: "into", ref: "loose" })).json).toMatchObject({ error: "too_deep" });
  });

  it("a page stored deeper than MAX_DEPTH stays put and reads; it is refused only a move deeper, and takes no new child", async () => {
    const member = await cookieFor(MEMBER);
    // d0 … d5 through the gate (the limit), then deep and deep-sib put one level past it by hand (data from before the cap).
    await live("d0");
    for (let i = 1; i < MAX_DEPTH; i++) await live(`d${i}`, { parent: `d${i - 1}` });
    await live("deep");
    await live("deep-sib");
    await env.DB.prepare(`UPDATE docs SET parent_slug = ? WHERE org_id = ? AND slug IN ('deep', 'deep-sib')`).bind(`d${MAX_DEPTH - 1}`, ORG_A).run();
    // It reads: the doc page carries its whole breadcrumb, the space's read lists it under its parent.
    const pg = await page(member, "deep");
    expect(pg.ancestors.map((a) => a.slug)).toEqual(Array.from({ length: MAX_DEPTH }, (_, i) => `d${i}`));
    const home = await call<{ pages: { slug: string; parent_slug: string | null }[] }>("GET", "/api/o/saplinglearn/spaces/engineering", member);
    expect(home.json.pages.find((p) => p.slug === "deep")).toMatchObject({ parent_slug: `d${MAX_DEPTH - 1}` });
    // A reorder at its own depth and a move up are allowed; deeper is refused.
    expect((await move(member, "deep", { target: "after", ref: "deep-sib" })).status).toBe(200);
    expect((await move(member, "deep", { target: "into", ref: "deep-sib" })).json).toMatchObject({ error: "too_deep" });
    expect((await place("deep"))?.parent_slug).toBe(`d${MAX_DEPTH - 1}`);
    expect((await move(member, "deep-sib", { target: "into", ref: `d${MAX_DEPTH - 2}` })).status).toBe(200);
    // A new page asking for it (or for the deepest legal page) as its parent lands at the top level, with the note.
    const r = await ingestDocProposal(A(), doc("under-deep", { parent: "deep" }), OWNER, ledger());
    expect(r).toMatchObject({ outcome: "written", parent_ignored: { parent_slug: "deep", reason: "too_deep" } });
    const r2 = await ingestDocProposal(A(), doc("under-last", { parent: `d${MAX_DEPTH - 1}` }), OWNER, ledger());
    expect(r2).toMatchObject({ outcome: "written", parent_ignored: { reason: "too_deep" } });
    const r3 = await ingestDocProposal(A(), doc("under-fifth", { parent: `d${MAX_DEPTH - 2}` }), OWNER, ledger());
    expect(r3).not.toHaveProperty("parent_ignored");
    expect(await place("under-deep")).toMatchObject({ parent_slug: null });
  });

  it("an archived space's pages do not move; a bearer is refused; another org's page is not found", async () => {
    const member = await cookieFor(MEMBER);
    await live("p1");
    await live("p2");
    const { raw } = await mintTokenFor(MEMBER);
    expect((await call("POST", "/api/o/saplinglearn/doc/p1/move", member, { target: "into", ref: "p2" }, { headers: { authorization: `Bearer ${raw}` } })).status).toBe(403);
    await live("b-page", {}, B());
    expect((await move(member, "b-page", { target: "top" })).status).toBe(404);
    expect((await move(member, "p1", { target: "into", ref: "b-page" })).status).toBe(404);
    expect(await place("b-page", ORG_B)).toMatchObject({ parent_slug: null, tree_rank: null });
    await env.DB.prepare(`UPDATE doc_spaces SET archived_at = 't' WHERE org_id = ? AND slug = 'engineering'`).bind(ORG_A).run();
    expect((await move(member, "p1", { target: "into", ref: "p2" })).json).toMatchObject({ error: "archived" });
    expect((await place("p1"))?.parent_slug).toBeNull();
  });
});

describe("a proposal's parent_slug", () => {
  it("a NEW page takes a valid parent at insert (unpromoted, under it in the tree)", async () => {
    await live("guide");
    const r = await ingestDocProposal(A(), doc("guide-child", { parent: "guide" }), OWNER, ledger());
    expect(r).toMatchObject({ outcome: "written" });
    expect(r).not.toHaveProperty("parent_ignored");
    expect(await place("guide-child")).toMatchObject({ parent_slug: "guide" });
    expect((await first<{ parent_slug: string }>(env.DB, `SELECT parent_slug FROM doc_versions WHERE org_id = ? AND slug = 'guide-child'`, ORG_A))?.parent_slug).toBe("guide");
  });

  it("an invalid parent is ignored with a note — never triaged", async () => {
    await live("eng-root");
    await live("prod-root", { space: "product" });
    const missing = await ingestDocProposal(A(), doc("n1", { parent: "nope" }), OWNER, ledger());
    expect(missing).toMatchObject({ outcome: "written", parent_ignored: { parent_slug: "nope", reason: "not_found" } });
    const other = await ingestDocProposal(A(), doc("n2", { parent: "prod-root" }), OWNER, ledger());
    expect(other).toMatchObject({ outcome: "written", parent_ignored: { reason: "other_space" } });
    const self = await ingestDocProposal(A(), doc("eng-root", { parent: "eng-root", body: "edited" }), OWNER, ledger());
    expect(self).toMatchObject({ outcome: "written", parent_ignored: { reason: "self" } });
    expect(await place("n1")).toMatchObject({ parent_slug: null });
    expect(await all(env.DB, `SELECT id FROM needs_triage WHERE org_id = ?`, ORG_A)).toEqual([]);
  });

  it("an EXISTING page keeps its place until the version is promoted, then moves under the parent if it is still valid", async () => {
    await live("parent-a");
    await live("parent-b");
    await live("mover");
    const r = await ingestDocProposal(A(), doc("mover", { parent: "parent-a", body: "v2 body" }), OWNER, ledger());
    expect(r).toMatchObject({ outcome: "written", version: 2 });
    expect((await place("mover"))?.parent_slug).toBeNull();
    await promote_doc(A(), "mover", 2, OWNER);
    expect((await place("mover"))?.parent_slug).toBe("parent-a");

    // Asked for parent-b, but by promote time parent-b sits under mover: a cycle, so the tree is left as it is.
    const r3 = await ingestDocProposal(A(), doc("mover", { parent: "parent-b", body: "v3 body" }), OWNER, ledger());
    expect(r3).toMatchObject({ outcome: "written", version: 3 });
    const member = await cookieFor(MEMBER);
    expect((await move(member, "parent-b", { target: "into", ref: "mover" })).status).toBe(200);
    await promote_doc(A(), "mover", 3, OWNER);
    expect((await place("mover"))?.parent_slug).toBe("parent-a");
    expect((await first<{ body: string }>(env.DB, `SELECT body FROM docs WHERE org_id = ? AND slug = 'mover'`, ORG_A))?.body).toBe("v3 body");
  });

  it("POST …/docs/propose (New page) carries the parent, and says when it is ignored", async () => {
    const member = await cookieFor(MEMBER);
    await live("handbook");
    const ok = await call<{ ok: boolean; slug: string; parent_ignored?: unknown }>("POST", "/api/o/saplinglearn/docs/propose", member, { title: "On call", section: "reference", space: "engineering", body: "## When to use this\n", parent_slug: "handbook" });
    expect(ok.status).toBe(200);
    expect(ok.json.slug).toBe("on-call");
    expect(ok.json.parent_ignored).toBeUndefined();
    expect((await place("on-call"))?.parent_slug).toBe("handbook");
    const lost = await call<{ parent_ignored?: { reason: string } }>("POST", "/api/o/saplinglearn/docs/propose", member, { title: "Lost child", section: "reference", space: "engineering", body: "b", parent_slug: "nope" });
    expect(lost.json.parent_ignored).toMatchObject({ reason: "not_found" });
  });

  it("MCP propose_doc_update takes parent_slug", async () => {
    await ensureMember("agent-person");
    await live("mcp-parent");
    const server = buildTrovMcpServer(env as unknown as import("../src/env").Env, await bearerCtx("agent-person"));
    const client = new Client({ name: "test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const res = (await client.callTool({ name: "propose_doc_update", arguments: doc("mcp-child", { parent: "mcp-parent" }) })) as { content: { text: string }[] };
      expect(JSON.parse(res.content[0].text)).toMatchObject({ outcome: "written" });
    } finally {
      await client.close();
      await server.close();
    }
    expect((await place("mcp-child"))?.parent_slug).toBe("mcp-parent");
  });

  it("the import options are server-only: written to the version, never read from the proposal", async () => {
    const run = await env.DB.prepare(`INSERT INTO doc_imports (org_id, space_slug, file_name, started_by, started_at, updated_at) VALUES (?, 'engineering', 'handbook.zip', ?, 't', 't')`).bind(ORG_A, OWNER).run();
    const id = run.meta.last_row_id;
    const sneaky = { ...doc("imp-a"), import_id: 999, import_path: "x.md" } as Parameters<typeof ingestDocProposal>[1];
    await ingestDocProposal(A(), sneaky, OWNER, ledger());
    expect(await first(env.DB, `SELECT import_id, import_path FROM doc_versions WHERE org_id = ? AND slug = 'imp-a'`, ORG_A)).toEqual({ import_id: null, import_path: null });
    await ingestDocProposal(A(), doc("imp-b"), OWNER, ledger(), { importId: id, importPath: "onboarding/first-week.md" });
    expect(await first(env.DB, `SELECT import_id, import_path FROM doc_versions WHERE org_id = ? AND slug = 'imp-b'`, ORG_A)).toEqual({ import_id: id, import_path: "onboarding/first-week.md" });
    const owner = await cookieFor(OWNER);
    expect((await page(owner, "imp-b")).info.imported_from).toEqual({ path: "onboarding/first-week.md", file_name: "handbook.zip" });
  });
});

describe("links: doc_links rebuilt on promote, and the doc page's read", () => {
  it("promote rebuilds the page's links from its live body (code is not scanned; itself is not kept)", async () => {
    await live("target-a");
    await live("linker", { body: "See [[target-a]] and [[missing-page|the missing one]], and [[linker]].\n\n`[[in-code]]`\n\n```\n[[fenced]]\n```\n" });
    const links = async () => (await all<{ to_slug: string }>(env.DB, `SELECT to_slug FROM doc_links WHERE org_id = ? AND from_slug = 'linker' ORDER BY to_slug`, ORG_A)).map((r) => r.to_slug);
    expect(await links()).toEqual(["missing-page", "target-a"]);
    // A staged edit changes nothing; its promote replaces the set.
    const r = await ingestDocProposal(A(), doc("linker", { body: "Only [[missing-page]] now." }), OWNER, ledger());
    expect(await links()).toEqual(["missing-page", "target-a"]);
    if (r.outcome !== "written") throw new Error("not staged");
    await promote_doc(A(), "linker", r.version, OWNER);
    expect(await links()).toEqual(["missing-page"]);
  });

  it("GET …/doc/:slug carries the page: ancestors, children, resolved and broken links, live backlinks, the rail", async () => {
    const owner = await cookieFor(OWNER);
    await live("arch", { title: "Architecture" });
    await live("api", { title: "API", parent: "arch" });
    await live("auth", { title: "Authentication", parent: "api", body: "Read [[rate-limits]] and [[gone]] first." });
    await live("sso", { title: "Single sign-on", parent: "auth" });
    await live("rate-limits", { title: "Rate limits", parent: "api", body: "Back to [[auth]]." });
    // A page never approved that links to auth: not a backlink (only live sources count — its body is not live).
    await ingestDocProposal(A(), doc("draft-linker", { body: "[[auth]]" }), OWNER, ledger());
    // A pending change on auth.
    await ingestDocProposal(A(), doc("auth", { body: "A newer body." }), MEMBER, ledger());

    const p = await page(owner, "auth");
    expect(p.ancestors).toEqual([{ slug: "arch", title: "Architecture" }, { slug: "api", title: "API" }]);
    expect(p.parent_slug).toBe("api");
    expect(p.children.map((c) => c.slug)).toEqual(["sso"]);
    expect(p.links).toEqual([{ slug: "rate-limits", title: "Rate limits", space: "engineering", path: ["Architecture", "API"], authority: "live" }]);
    expect(p.broken_links).toEqual(["gone"]);
    expect(p.backlinks.map((b) => b.slug)).toEqual(["rate-limits"]);
    expect(p.authority).toBe("staged_pending");
    expect(p.body).toBe("Read [[rate-limits]] and [[gone]] first.");
    expect(p.info).toMatchObject({ owner: OWNER, edited_by: OWNER, version: 1, pending_version: 2, imported_from: null });

    // A page never approved shows its newest staged body, and has no backlinks.
    const d = await page(owner, "draft-linker");
    expect(d.authority).toBe("unpromoted");
    expect(d.body).toBe("[[auth]]");
    expect(d.info).toMatchObject({ version: 0, pending_version: 1 });
  });

  it("another org's doc is not found, and its links never reach this org's page", async () => {
    const owner = await cookieFor(OWNER);
    await live("shared-slug");
    await live("b-linker", { body: "[[shared-slug]]" }, B());
    expect((await page(owner, "shared-slug")).backlinks).toEqual([]);
    expect((await call("GET", "/api/o/saplinglearn/doc/b-linker", owner)).status).toBe(404);
  });
});
