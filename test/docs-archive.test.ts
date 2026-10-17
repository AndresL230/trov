// Archive page / Restore (0083_doc_archive; docs/architecture/docs-library.md › Archiving a page). The owner's rule:
// a page "should not be able to be deleted or archived with the agent mcp" — so archive and restore are cookie routes
// for PEOPLE (an org admin or an owner of the page's space), a bearer is refused, no MCP tool does it, and no
// proposal, session record or import can archive, restore or re-parent around an archived page. Also: the children
// move up a level in the same batch, the page leaves every read, its links read "Archived", its staged versions leave
// Review while it is archived, and Restore puts it back under its old parent when it can.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DocArchiveResult, DocPageDTO, DocRestoreResult, LibraryDTO, SpaceHomeDTO } from "@shared/docs-core";
import { MAX_DEPTH, planArchive, planRestore, RANK_STEP } from "@shared/docs-tree-core";
import { titleFromMarkdown, type ImportStartAnswer } from "@shared/docs-import-core";
import type { Env } from "../src/env";
import { ingestDocProposal } from "../src/consumer";
import { buildTrovMcpServer } from "../src/mcp";
import { promote_doc } from "../src/tools/writes";
import { all, first } from "./helpers/db";
import { call } from "./helpers/orgs";
import { cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, bearerCtx, ensureMember, mintTokenFor, systemCtx } from "./helpers/tenant";

const OWNER = "AndresL230";        // the org's owner: an admin
const MEMBER = "lpcooper-arch";    // a member, neither admin nor (until made one) a space owner
const A = () => systemCtx(ORG_A);
const B = () => systemCtx(ORG_B);
const ledger = () => ({ sessionId: crypto.randomUUID(), itemIndex: 0 });
const proposal = (slug: string, o: { parent?: string; body?: string; title?: string; space?: string } = {}) => ({
  slug, section: "reference", title: o.title ?? `${slug} title`, body: o.body ?? `${slug} body`, change_summary: "s", confidence: "high" as const,
  ...(o.space ? { space: o.space } : {}), ...(o.parent ? { parent_slug: o.parent } : {}),
});
/** Stage and promote a page (version 1, or the next one). */
async function live(slug: string, o: Parameters<typeof proposal>[1] = {}, ctx = A()): Promise<void> {
  const r = await ingestDocProposal(ctx, proposal(slug, o), OWNER, ledger());
  if (r.outcome !== "written") throw new Error(`not staged: ${slug} ${JSON.stringify(r)}`);
  await promote_doc(ctx, slug, r.version, OWNER);
}
const row = (slug: string, org = ORG_A) => first<{ parent_slug: string | null; tree_rank: number | null; archived_at: string | null; archived_by: string | null }>(env.DB,
  `SELECT parent_slug, tree_rank, archived_at, archived_by FROM docs WHERE org_id = ? AND slug = ?`, org, slug);
const archive = (cookie: string, slug: string, headers: Record<string, string> = {}) => call<DocArchiveResult & { error?: string; message?: string }>("POST", `/doc/${slug}/archive`, cookie, {}, { headers });
const restore = (cookie: string, slug: string, headers: Record<string, string> = {}) => call<DocRestoreResult & { error?: string; message?: string }>("POST", `/doc/${slug}/restore`, cookie, {}, { headers });
const home = async (cookie: string, space = "engineering") => (await call<SpaceHomeDTO>("GET", `/api/spaces/${space}`, cookie)).json;
const docPage = async (cookie: string, slug: string) => (await call<{ page: DocPageDTO }>("GET", `/doc/${slug}`, cookie)).json.page;

/** Call one MCP tool as `handle`'s bearer, through the real registered server. */
async function mcp(handle: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx(handle));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content[0]?.text ?? "", isError: res.isError };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Engineering: guide › (alpha, beta › beta-kid, gamma), and a sibling after guide. */
async function tree(): Promise<void> {
  await live("before-guide");
  await live("guide");
  await live("guide-after");
  for (const k of ["alpha", "beta", "gamma"]) await live(k, { parent: "guide" });
  await live("beta-kid", { parent: "beta" });
  // Saved order: before-guide, guide, guide-after at the top; alpha, beta, gamma under guide.
  const top = ["before-guide", "guide", "guide-after"];
  for (const [i, s] of top.entries()) await env.DB.prepare(`UPDATE docs SET tree_rank = ? WHERE org_id = ? AND slug = ?`).bind((i + 1) * 100, ORG_A, s).run();
  for (const [i, s] of ["alpha", "beta", "gamma"].entries()) await env.DB.prepare(`UPDATE docs SET tree_rank = ? WHERE org_id = ? AND slug = ?`).bind((i + 1) * 10, ORG_A, s).run();
}

describe("the tree's rules (shared/docs-tree-core.ts)", () => {
  const n = (slug: string, parent: string | null, rank: number | null, space = "s") => ({ slug, parent_slug: parent, tree_rank: rank, space });
  it("planArchive: the children take the page's place among its siblings, in their own order, renumbered", () => {
    const nodes = [n("a", null, 1), n("p", null, 2), n("z", null, 3), n("k2", "p", 2), n("k1", "p", 1), n("gk", "k1", 1)];
    expect(planArchive(nodes, "p")).toEqual({
      parent_slug: null,
      places: ["a", "k1", "k2", "z"].map((slug, i) => ({ slug, parent_slug: null, tree_rank: (i + 1) * RANK_STEP })),
    });
    expect(planArchive(nodes, "a")).toEqual({ parent_slug: null, places: [] });   // no children: nothing moves
    expect(planArchive(nodes, "nope")).toBeNull();
  });

  it("planRestore: back under the old parent when it is in the tree and the cap allows, else at the top level", () => {
    const nodes = [n("p", null, 1), n("q", null, 2)];
    expect(planRestore(nodes, { slug: "x", space: "s" }, "p")).toMatchObject({ parent_slug: "p" });
    expect(planRestore(nodes, { slug: "x", space: "s" }, "gone")).toMatchObject({ parent_slug: null });
    expect(planRestore(nodes, { slug: "x", space: "s" }, null)).toMatchObject({ parent_slug: null, tree_rank: 2 + RANK_STEP });
    const chain = Array.from({ length: MAX_DEPTH }, (_, i) => n(`d${i}`, i ? `d${i - 1}` : null, 1));
    expect(planRestore(chain, { slug: "x", space: "s" }, `d${MAX_DEPTH - 2}`)).toMatchObject({ parent_slug: `d${MAX_DEPTH - 2}` });
    expect(planRestore(chain, { slug: "x", space: "s" }, `d${MAX_DEPTH - 1}`)).toMatchObject({ parent_slug: null });   // would be level 7
  });
});

describe("POST /doc/:slug/archive — a person's write", () => {
  it("an admin archives: the page leaves the Library, its children move up into its place in one go, its slug stays reserved", async () => {
    await tree();
    const admin = await cookieFor(OWNER);
    const res = await archive(admin, "guide");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, slug: "guide", parent_slug: null });
    expect(res.json.places.map((p) => p.slug)).toEqual(["before-guide", "alpha", "beta", "gamma", "guide-after"]);
    expect(await row("guide")).toMatchObject({ archived_by: OWNER, parent_slug: null });
    expect((await row("guide"))?.archived_at).toBeTruthy();
    for (const k of ["alpha", "beta", "gamma"]) expect((await row(k))?.parent_slug).toBeNull();
    expect((await row("beta-kid"))?.parent_slug).toBe("beta");   // only the DIRECT children move

    // Space home, its count, the Archived pages list; Library home's counts.
    const h = await home(admin);
    expect(h.pages.map((p) => p.slug)).not.toContain("guide");
    expect(h.space.pages).toBe(6);
    expect(h.archived_pages).toEqual([expect.objectContaining({ slug: "guide", title: "guide title", archived_by: OWNER })]);
    expect(h.can_archive).toBe(true);
    const lib = (await call<LibraryDTO>("GET", "/api/spaces", admin)).json;
    expect(lib.spaces.find((s) => s.slug === "engineering")?.pages).toBe(6);
    expect(lib.recent.map((p) => p.slug)).not.toContain("guide");

    // Every other read: the docs list, quick search, search.
    expect(((await call<{ docs: { slug: string }[] }>("GET", "/docs", admin)).json.docs).map((d) => d.slug)).not.toContain("guide");
    expect(((await call<{ docs: { slug: string }[] }>("GET", "/docs?fields=meta", admin)).json.docs).map((d) => d.slug)).not.toContain("guide");
    const qs = await call<{ result: { groups: { hits: { id: string }[] }[] } }>("GET", "/search/quick?q=guide", admin);
    const hits = qs.json.result.groups.flatMap((g) => g.hits.map((h) => h.id));
    expect(hits).toEqual(expect.arrayContaining(["before-guide", "guide-after"]));
    expect(hits).not.toContain("guide");

    // A second archive is refused; the page still reads by its link, read-only, with who archived it.
    expect((await archive(admin, "guide")).json).toMatchObject({ error: "archived" });
    const page = await docPage(admin, "guide");
    expect(page.archived).toMatchObject({ by: OWNER });
    expect(page.can_archive).toBe(true);

    // The slug stays reserved: New page with it is refused, and nothing moves next to or under it.
    const taken = await call<{ error: string }>("POST", "/api/docs/propose", admin, { title: "Guide", section: "reference", space: "engineering", body: "new", slug: "guide" });
    expect(taken.status).toBe(409);
    // …and says it is an ARCHIVED page that holds the name — none shows in the Library (e2e AR15)
    expect(taken.json.error).toBe("an archived page is named guide");
    expect((await call("POST", "/doc/guide/move", admin, { target: "top" })).json).toMatchObject({ error: "archived" });
    expect((await call("POST", "/doc/alpha/move", admin, { target: "into", ref: "guide" })).status).toBe(404);
  });

  it("MCP and Ask's reads see no archived page: get_doc, list_docs, query", async () => {
    await live("secret-plan", { body: "zanzibar quokka plan" });
    await live("kept-plan", { body: "zanzibar kept" });
    await ensureMember("agent-person");
    expect((await archive(await cookieFor(OWNER), "secret-plan")).status).toBe(200);
    const got = await mcp("agent-person", "get_doc", { slug: "secret-plan" });
    expect(got.text).not.toContain("zanzibar quokka");
    expect(got).toEqual(await mcp("agent-person", "get_doc", { slug: "never-was" }));   // exactly a slug that never existed
    expect(JSON.parse((await mcp("agent-person", "list_docs", {})).text).map((d: { slug: string }) => d.slug)).not.toContain("secret-plan");
    const q = JSON.parse((await mcp("agent-person", "query", { q: "zanzibar" })).text);
    expect(JSON.stringify(q)).not.toContain("secret-plan");
    expect(JSON.stringify(q)).toContain("kept-plan");
    const browse = JSON.parse((await mcp("agent-person", "query", { q: "", types: ["doc"] })).text);
    expect(JSON.stringify(browse)).not.toContain("secret-plan");
  });

  it("who: an admin or an owner of the page's space; a member is refused 403, another org's page is 404, a bearer is 403", async () => {
    await live("owned-page");
    await live("b-page", {}, B());
    const member = await cookieFor(MEMBER);
    expect(await archive(member, "owned-page")).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect((await home(member)).can_archive).toBe(false);
    expect((await docPage(member, "owned-page")).can_archive).toBe(false);
    expect((await row("owned-page"))?.archived_at).toBeNull();

    // Another org's page is no page of this org: 404, untouched.
    expect((await archive(await cookieFor(OWNER), "b-page")).status).toBe(404);
    expect((await restore(await cookieFor(OWNER), "b-page")).status).toBe(404);
    expect((await row("b-page", ORG_B))?.archived_at).toBeNull();

    // A bearer is refused before anything is read — even an admin's token, on both routes.
    const { raw } = await mintTokenFor(OWNER);
    const admin = await cookieFor(OWNER);
    for (const go of [archive, restore]) {
      const r = await go(admin, "owned-page", { authorization: `Bearer ${raw}` });
      expect(r).toMatchObject({ status: 403, json: { error: "forbidden" } });
    }
    expect((await row("owned-page"))?.archived_at).toBeNull();

    // An owner of the space may (an admin makes the member one).
    expect((await call("PUT", "/api/spaces/engineering/owners", admin, { owners: [MEMBER] })).status).toBe(200);
    expect((await home(member)).can_archive).toBe(true);
    expect((await archive(member, "owned-page")).status).toBe(200);
    expect((await row("owned-page"))?.archived_by).toBe(MEMBER);
    expect((await restore(member, "owned-page")).status).toBe(200);
    // …but not in a space they do not own.
    await live("prod-page", { space: "product" });
    expect((await archive(member, "prod-page")).status).toBe(403);

    // A page of an archived space does not move: archive and restore wait for the space.
    expect((await call("POST", "/api/spaces/product/archive", admin, {})).status).toBe(200);
    expect((await archive(admin, "prod-page")).json).toMatchObject({ error: "space_archived" });
  });
});

describe("links, Review and the gate around an archived page", () => {
  it("a [[link]] to it reads as archived (not broken); its own links leave the other pages' Linked from", async () => {
    await live("target");
    await live("linker", { body: "See [[target]] and [[nowhere]]." });
    await live("source", { body: "Points at [[linker]]." });
    const admin = await cookieFor(OWNER);
    expect((await docPage(admin, "linker")).backlinks.map((b) => b.slug)).toEqual(["source"]);
    await archive(admin, "target");
    await archive(admin, "source");
    const page = await docPage(admin, "linker");
    expect(page.archived_links).toEqual([{ slug: "target", title: "target title" }]);
    expect(page.broken_links).toEqual(["nowhere"]);
    expect(page.links).toEqual([]);
    expect(page.backlinks).toEqual([]);
  });

  it("its staged versions leave Review and the badge while it is archived; approving one is refused 409; Restore brings them back", async () => {
    await live("pending");
    const r = await ingestDocProposal(A(), proposal("pending", { body: "a change" }), "agent-person", ledger());
    expect(r).toMatchObject({ outcome: "written", version: 2 });
    const admin = await cookieFor(OWNER);
    const inReview = async () => (await call<{ proposals: { slug: string }[] }>("GET", "/proposals", admin)).json.proposals.some((p) => p.slug === "pending");
    const badge = async () => (await call<{ proposals: number }>("GET", "/badges", admin)).json.proposals;
    expect(await inReview()).toBe(true);
    const before = await badge();
    await archive(admin, "pending");
    expect(await inReview()).toBe(false);
    expect(await badge()).toBe(before - 1);
    expect(await call("POST", "/doc/pending/promote", admin, { version: 2 })).toMatchObject({ status: 409, json: { error: "archived" } });
    // Kept, not rejected: the version is still staged.
    expect((await first<{ status: string }>(env.DB, `SELECT status FROM doc_versions WHERE org_id = ? AND slug = 'pending' AND version = 2`, ORG_A))?.status).toBe("staged");
    await restore(admin, "pending");
    expect(await inReview()).toBe(true);
  });

  it("no agent path archives, restores or places around it: propose_doc_update and record_session triage, a parent is ignored, an import keeps out", async () => {
    await live("parked");
    await live("parked-kid", { parent: "parked" });
    const admin = await cookieFor(OWNER);
    await archive(admin, "parked");
    await ensureMember("agent-person");

    // A proposal against the archived page — the gate's own path, the MCP tool, and record_session — goes to triage.
    expect(await ingestDocProposal(A(), proposal("parked", { body: "revive" }), "agent-person", ledger())).toEqual({ outcome: "triaged", reason: "archived page: parked" });
    expect(JSON.parse((await mcp("agent-person", "propose_doc_update", proposal("parked", { body: "revive via mcp" }))).text)).toMatchObject({ outcome: "triaged", reason: "archived page: parked" });
    const recRaw = (await mcp("agent-person", "record_session", { session: { id: crypto.randomUUID(), author: "ignored", ended_at: "2026-10-17T00:00:00Z", skill_version: "2.0" }, doc_proposals: [proposal("parked", { body: "revive via session" })] })).text;
    expect(JSON.parse(recRaw)).toMatchObject({ docs: { staged: 0, triaged: 1 } });
    const triage = await all<{ reason: string }>(env.DB, `SELECT reason FROM needs_triage WHERE org_id = ? AND reason = 'archived page: parked'`, ORG_A);
    expect(triage).toHaveLength(3);
    expect(await row("parked")).toMatchObject({ archived_by: OWNER });
    expect((await all(env.DB, `SELECT 1 FROM doc_versions WHERE org_id = ? AND slug = 'parked'`, ORG_A))).toHaveLength(1);

    // A new page asking to go under it is placed at the top level (its parent ignored), and the moved child stays put.
    const under = await ingestDocProposal(A(), proposal("wants-parked", { parent: "parked" }), "agent-person", ledger());
    expect(under).toMatchObject({ outcome: "written", parent_ignored: { parent_slug: "parked", reason: "not_found" } });
    expect((await row("wants-parked"))?.parent_slug).toBeNull();
    // An existing page's staged version asking for it as parent does not move under it on promote.
    const v = await ingestDocProposal(A(), proposal("parked-kid", { parent: "parked", body: "edited" }), "agent-person", ledger());
    expect(v).toMatchObject({ outcome: "written", parent_ignored: { reason: "not_found" } });
    if (v.outcome === "written") await promote_doc(A(), "parked-kid", v.version, OWNER);
    expect((await row("parked-kid"))?.parent_slug).toBeNull();

    // An import: no target under it (404), no title conflict with it, and never its slug.
    const text = "# parked title\n\nimported\n";
    const md = { path: "parked.md", size: new TextEncoder().encode(text).byteLength, title: titleFromMarkdown(text) };
    const under404 = await call<{ error?: string }>("POST", "/api/o/saplinglearn/imports", admin, { space: "engineering", parent_slug: "parked", file_name: "parked.md", files: [md] });
    expect(under404).toMatchObject({ status: 404, json: { error: "not_found" } });
    const s = await call<ImportStartAnswer>("POST", "/api/o/saplinglearn/imports", admin, { space: "engineering", file_name: "parked.md", files: [md] });
    expect(s.status).toBe(201);
    expect(s.json.plan.conflicts).toEqual([]);
    expect(s.json.plan.writes.map((w) => w.slug)).toEqual(["parked-2"]);
    await call("POST", `/api/o/saplinglearn/imports/${s.json.run.id}/finish`, admin, { cancel: true });
  });
});

describe("POST /doc/:slug/restore", () => {
  it("back under its old parent when that page is in the Library; it does not take its old children back", async () => {
    await tree();
    const admin = await cookieFor(OWNER);
    await archive(admin, "beta");
    expect((await row("beta-kid"))?.parent_slug).toBe("guide");
    const back = await restore(admin, "beta");
    expect(back.status).toBe(200);
    expect(back.json).toMatchObject({ ok: true, slug: "beta", parent_slug: "guide" });
    expect(await row("beta")).toMatchObject({ parent_slug: "guide", archived_at: null, archived_by: null });
    expect((await row("beta-kid"))?.parent_slug).toBe("guide");
    expect((await home(admin)).archived_pages).toEqual([]);
    expect((await restore(admin, "beta")).json).toMatchObject({ error: "not_archived" });
  });

  it("to the top level when its old parent is archived too, or the 6-level cap would be broken", async () => {
    await tree();
    const admin = await cookieFor(OWNER);
    await archive(admin, "alpha");
    await archive(admin, "guide");
    expect((await restore(admin, "alpha")).json).toMatchObject({ parent_slug: null });

    // A chain d0 … d(MAX-1), the deepest at the cap.
    await live("d0");
    for (let i = 1; i < MAX_DEPTH; i++) await live(`d${i}`, { parent: `d${i - 1}` });
    await live("leaf", { parent: `d${MAX_DEPTH - 2}` });
    await archive(admin, "leaf");
    // Say its stored parent is the deepest page: going back under it would be a 7th level, so it goes to the top.
    await env.DB.prepare(`UPDATE docs SET parent_slug = ? WHERE org_id = ? AND slug = ?`).bind(`d${MAX_DEPTH - 1}`, ORG_A, "leaf").run();
    expect((await restore(admin, "leaf")).json).toMatchObject({ parent_slug: null });
  });
});
