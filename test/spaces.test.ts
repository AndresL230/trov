// The Docs Library's spaces (0081_docs_library; docs/architecture/docs-library.md › Spaces): the shared core, the
// gate's space routing, the cookie routes (admin / owner gating, a bearer refused), createOrg's seed, Unplaced's
// assign, and the MCP `list_spaces` / `space` filters.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  STARTER_SPACES, pageSummary, resolveSpaceAlias, spaceNamedLike, spaceOrder, spaceSlugFromName, uniqueSpaceSlug, ownedBy, pageAuthority,
  type LibraryDTO, type SpaceDTO, type SpaceHomeDTO,
} from "@shared/docs-core";
import { ingestDocProposal } from "../src/consumer";
import { buildTrovMcpServer } from "../src/mcp";
import { createOrg } from "../src/orgs/repo";
import { query } from "../src/tools/reads";
import { assign_triage, promote_doc, propose_doc_update } from "../src/tools/writes";
import { all, first } from "./helpers/db";
import { call } from "./helpers/orgs";
import { cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, bearerCtx, ensureMember, mintTokenFor, platformCtx, systemCtx } from "./helpers/tenant";

const OWNER = "AndresL230";         // owner of SaplingLearn (an admin)
const MEMBER = "lpcooper-arch";     // a plain member
const OTHER = "Darkest-Teddy";      // another member
const A = () => systemCtx(ORG_A);
const doc = (slug: string, space?: string, confidence: "high" | "low" = "high") =>
  ({ slug, section: "reference", title: `${slug} title`, body: `${slug} body`, change_summary: "s", confidence, ...(space !== undefined ? { space } : {}) });
const ledger = () => ({ sessionId: crypto.randomUUID(), itemIndex: 0 });
const library = async (cookie: string) => (await call<LibraryDTO>("GET", "/api/spaces", cookie)).json;
const audit = () => all<{ actor: string; action: string; target: string }>(env.DB, `SELECT actor, action, target FROM org_admin_audit WHERE org_id = ? AND action LIKE 'space.%' ORDER BY id`, ORG_A);

describe("the shared core (shared/docs-core.ts)", () => {
  it("one alias map: technical → engineering; any other value is itself, trimmed and lowercased; nothing → null", () => {
    expect(resolveSpaceAlias("technical")).toBe("engineering");
    expect(resolveSpaceAlias(" Product ")).toBe("product");
    expect(resolveSpaceAlias("security")).toBe("security");
    expect(resolveSpaceAlias("")).toBeNull();
    expect(resolveSpaceAlias(undefined)).toBeNull();
  });

  it("slugs come from names and are never reused; names clash case-insensitively among live spaces only", () => {
    expect(spaceSlugFromName("  Café & Ops! ")).toBe("cafe-ops");
    expect(spaceSlugFromName("!!!")).toBe("space");
    expect(uniqueSpaceSlug("security", new Set(["security", "security-2"]))).toBe("security-3");
    const spaces = [{ slug: "a", name: "Engineering", archived: false }, { slug: "b", name: "Old", archived: true }];
    expect(spaceNamedLike(spaces, " engineering ")?.slug).toBe("a");
    expect(spaceNamedLike(spaces, "old")).toBeNull();
    expect(spaceNamedLike(spaces, "Engineering", "a")).toBeNull(); // itself, when renaming
  });

  it("order: A to Z by name (case and accents aside), then oldest, then slug — the rank orders nothing", () => {
    const s = [
      { slug: "z", name: "zeta", sort_rank: 1, created_at: "1" }, { slug: "b2", name: "Beta", sort_rank: null, created_at: "2" },
      { slug: "b1", name: "beta", sort_rank: 9000, created_at: "1" }, { slug: "a", name: "Álpha", sort_rank: 5000, created_at: "3" },
    ];
    expect([...s].sort(spaceOrder).map((x) => x.slug)).toEqual(["a", "b1", "b2", "z"]);
  });

  it("a page's card line: its first sentence, Markdown stripped, cut on a word (E2E SH2)", () => {
    expect(pageSummary("# Title\n\nSet up your machine, learn the repository and ship a first change. Then more.")).toBe("Set up your machine, learn the repository and ship a first change.");
    expect(pageSummary("## Why\n\nSee **the** [guide](https://x.test) and `npm test`, then [[deploys|Deploys]]!\nNext")).toBe("See the guide and npm test, then Deploys!");
    expect(pageSummary("```sh\ncurl x\n```\n\n> Rotate keys every 90 days.\n")).toBe("Rotate keys every 90 days.");
    expect(pageSummary("- First item of a list\n- second item")).toBe("First item of a list");
    expect(pageSummary("![a diagram](/img/abc)\n\n| a | b |\n|---|---|\n\n<div>Plain words</div> here")).toBe("Plain words here");
    expect(pageSummary("# Only a heading\n")).toBe("");
    expect(pageSummary("<script>alert('x')</script> Safe words.")).toBe("Safe words.");
    expect(pageSummary("[click me](javascript:alert('x')) now")).toBe("click me now");
    expect(pageSummary("")).toBe("");
    const long = pageSummary(`${"word ".repeat(60)}end.`);
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long).toMatch(/word…$/);
    expect(pageSummary("Version 2.5 ships e.g. today")).toBe("Version 2.5 ships e.g. today");
  });

  it("statuses and copy", () => {
    expect(pageAuthority(0, 1)).toBe("unpromoted");
    expect(pageAuthority(2, 3)).toBe("staged_pending");
    expect(pageAuthority(2, 2)).toBe("live");
    expect(pageAuthority(2, null)).toBe("live");
    expect(ownedBy(["Priya"])).toBe("Owned by Priya");
    expect(ownedBy(["A", "B", "C"])).toBe("Owned by A, B and C");
  });
});

describe("the gate places a doc in a live space of the org — never guessed", () => {
  it("a sent space must be live: unknown and archived go to triage with a reason; an alias resolves", async () => {
    expect(await ingestDocProposal(A(), doc("one", "nope"), OWNER, ledger())).toEqual({ outcome: "triaged", reason: "unknown space: nope" });
    await env.DB.prepare(`UPDATE doc_spaces SET archived_at = 't' WHERE org_id = ? AND slug = 'design'`).bind(ORG_A).run();
    expect(await ingestDocProposal(A(), doc("two", "design"), OWNER, ledger())).toEqual({ outcome: "triaged", reason: "archived space: design" });
    expect((await ingestDocProposal(A(), doc("three", "technical"), OWNER, ledger())).outcome).toBe("written");
    expect((await first<{ space: string }>(env.DB, `SELECT space FROM docs WHERE org_id = ? AND slug = 'three'`, ORG_A))?.space).toBe("engineering");
    const triage = await all<{ reason: string }>(env.DB, `SELECT reason FROM needs_triage WHERE org_id = ? ORDER BY id`, ORG_A);
    expect(triage.map((t) => t.reason)).toEqual(["unknown space: nope", "archived space: design"]);
    expect(await first(env.DB, `SELECT 1 AS x FROM docs WHERE org_id = ? AND slug IN ('one', 'two')`, ORG_A)).toBeNull();
  });

  it("an org's OWN space is a place for a doc; another org's is not", async () => {
    await env.DB.prepare(`INSERT INTO doc_spaces (org_id, slug, name, icon, color, created_at, created_by) VALUES (?, 'security', 'Security', 'shield', '#b4562c', 't', 'x')`).bind(ORG_B).run();
    expect((await ingestDocProposal(A(), doc("sec", "security"), OWNER, ledger())).outcome).toBe("triaged");
    expect((await ingestDocProposal(systemCtx(ORG_B), doc("sec", "security"), "boss", ledger())).outcome).toBe("written");
  });

  it("no space: a NEW doc goes to engineering only while it is live; an existing doc keeps its own space", async () => {
    expect((await ingestDocProposal(A(), doc("fresh"), OWNER, ledger())).outcome).toBe("written");
    expect((await first<{ space: string }>(env.DB, `SELECT space FROM docs WHERE org_id = ? AND slug = 'fresh'`, ORG_A))?.space).toBe("engineering");
    await propose_doc_update(A(), { ...doc("prod-doc", "product") }, OWNER);
    await env.DB.prepare(`UPDATE doc_spaces SET archived_at = 't' WHERE org_id = ? AND slug = 'engineering'`).bind(ORG_A).run();
    const r = await ingestDocProposal(A(), doc("orphan"), OWNER, ledger());
    expect(r).toEqual({ outcome: "triaged", reason: "no space given, and the default space (engineering) is archived" });
    // An edit of an existing doc names no space: it stages on the doc, in the doc's own space.
    expect((await ingestDocProposal(A(), { ...doc("prod-doc"), body: "an edit" }, OWNER, ledger())).outcome).toBe("written");
    expect((await ingestDocProposal(A(), { ...doc("fresh"), body: "an edit in an archived space" }, OWNER, ledger())).outcome).toBe("written");
    // A space sent with an existing doc never moves it.
    expect((await ingestDocProposal(A(), { ...doc("prod-doc", "design"), body: "edit 2" }, OWNER, ledger())).outcome).toBe("written");
    expect((await first<{ space: string }>(env.DB, `SELECT space FROM docs WHERE org_id = ? AND slug = 'prod-doc'`, ORG_A))?.space).toBe("product");
  });

  it("Unplaced › assign places a held doc in the space the person picks, through the same gate", async () => {
    const held = await ingestDocProposal(A(), doc("held", "nope"), MEMBER, ledger());
    expect(held.outcome).toBe("triaged");
    const id = (await first<{ id: number }>(env.DB, `SELECT id FROM needs_triage WHERE org_id = ? ORDER BY id DESC LIMIT 1`, ORG_A))!.id;
    await expect(assign_triage(A(), id, OWNER, { type: "doc", space: "also-nope" })).rejects.toThrow(/unknown space: also-nope/);
    const r = await assign_triage(A(), id, OWNER, { type: "doc", space: "design" });
    expect(r.assigned_ref).toBe("doc:held@1");
    expect((await first<{ space: string }>(env.DB, `SELECT space FROM docs WHERE org_id = ? AND slug = 'held'`, ORG_A))?.space).toBe("design");
  });
});

describe("createOrg seeds the three starter spaces", () => {
  it("a new org has Engineering, Product and Design, by 'system', in order", async () => {
    const org = await createOrg(platformCtx(OWNER), { slug: "fresh-spaces", name: "Fresh", owner: OWNER, plan: { id: "free", overrides: {}, source: "granted" } });
    const rows = await all(env.DB, `SELECT slug, name, icon, color, sort_rank, created_by FROM doc_spaces WHERE org_id = ? ORDER BY sort_rank`, org.id);
    expect(rows).toEqual(STARTER_SPACES.map((s) => ({ ...s, created_by: "system" })));
  });
});

describe("the space routes (cookie only)", () => {
  it("GET /spaces: live spaces in order with page counts, waiting and owners; recent pages; archived for an admin only", async () => {
    await propose_doc_update(A(), doc("live-one", "engineering"), OWNER);
    await promote_doc(A(), "live-one", 1, OWNER);
    await propose_doc_update(A(), doc("waiting-one", "engineering"), OWNER);
    await propose_doc_update(A(), doc("prod-one", "product"), MEMBER);
    const owner = await cookieFor(OWNER);
    const lib = await library(owner);
    expect(lib.spaces.map((s) => [s.slug, s.pages, s.waiting])).toEqual([["design", 0, 0], ["engineering", 2, 1], ["product", 1, 1]]);
    expect(lib.waiting).toBe(2);
    expect(lib.can_admin).toBe(true);
    expect(lib.recent.map((p) => p.slug).sort()).toEqual(["live-one", "prod-one", "waiting-one"]);
    expect(lib.recent.find((p) => p.slug === "live-one")).toMatchObject({ authority: "live", path: [], parent_slug: null, space: "engineering" });
    expect(lib.recent.find((p) => p.slug === "waiting-one")?.authority).toBe("unpromoted");

    await call("POST", "/api/spaces/design/archive", owner, {});
    expect((await library(owner)).archived.map((s) => s.slug)).toEqual(["design"]);
    const member = await library(await cookieFor(MEMBER));
    expect(member.spaces.map((s) => s.slug)).toEqual(["engineering", "product"]);
    expect(member.archived).toEqual([]);
    expect(member.can_admin).toBe(false);
  });

  it("GET /spaces/:slug: the space and every page in it (staged-only too); an unknown space is 404", async () => {
    await propose_doc_update(A(), doc("only-staged", "product"), OWNER);
    const res = await call<SpaceHomeDTO>("GET", "/api/spaces/product", await cookieFor(MEMBER));
    expect(res.status).toBe(200);
    expect(res.json.space).toMatchObject({ slug: "product", name: "Product", pages: 1, waiting: 1, owners: [] });
    expect(res.json.pages.map((p) => [p.slug, p.authority])).toEqual([["only-staged", "unpromoted"]]);
    expect(res.json).toMatchObject({ can_edit: false, can_admin: false });
    expect((await call("GET", "/api/spaces/nope", await cookieFor(MEMBER))).status).toBe(404);
  });

  it("GET /spaces/:slug: each top-level page's card line is its first sentence, read from the body it shows (E2E SH2)", async () => {
    await propose_doc_update(A(), { ...doc("top-live", "product"), body: "# Top live\n\nThe one place for **plans**. And more." }, OWNER);
    await promote_doc(A(), "top-live", 1, OWNER);
    await propose_doc_update(A(), { ...doc("top-staged", "product"), body: "Only a [[top-live|draft]] so far" }, OWNER);
    await propose_doc_update(A(), { ...doc("top-empty", "product"), body: "# Just a heading\n" }, OWNER);
    await propose_doc_update(A(), { ...doc("child", "product"), body: "Under the top.", parent_slug: "top-live" } as never, OWNER);
    const home = (await call<SpaceHomeDTO>("GET", "/api/spaces/product", await cookieFor(MEMBER))).json;
    // Live: the live body; never approved: its newest staged body; nothing but a heading: no line; a child: none sent.
    expect(home.summaries).toEqual({ "top-live": "The one place for plans.", "top-staged": "Only a draft so far" });
  });

  it("create (admin): slug from the name, the creator its owner, in A to Z order, audited; duplicates and bad input refused", async () => {
    const owner = await cookieFor(OWNER);
    const made = await call<{ ok: boolean; space: SpaceDTO }>("POST", "/api/spaces", owner, { name: " Security ", icon: "shield", color: "#B4562C", description: "Threat models." });
    expect(made.status).toBe(201);
    expect(made.json.space).toMatchObject({ slug: "security", name: "Security", icon: "shield", color: "#b4562c", description: "Threat models.", owners: [OWNER], pages: 0, archived: false });
    expect((await library(owner)).spaces.map((s) => s.slug)).toEqual(["design", "engineering", "product", "security"]);

    expect((await call("POST", "/api/spaces", owner, { name: "security", icon: "shield", color: "#b4562c" })).json).toMatchObject({ error: "name_taken" });
    expect((await call("POST", "/api/spaces", owner, { name: "", icon: "shield", color: "#b4562c" })).json).toMatchObject({ error: "invalid", field: "name" });
    expect((await call("POST", "/api/spaces", owner, { name: "x".repeat(41) })).status).toBe(400);
    expect((await call("POST", "/api/spaces", owner, { name: "Ok", icon: "rocketship" })).json).toMatchObject({ error: "invalid", field: "icon" });
    expect((await call("POST", "/api/spaces", owner, { name: "Ok", color: "#000000" })).json).toMatchObject({ error: "invalid", field: "color" });
    expect((await call("POST", "/api/spaces", owner, { name: "Ok", description: "d".repeat(141) })).json).toMatchObject({ error: "invalid", field: "description" });

    // A slug is reserved forever: archive Security, then make another "Security" — it gets security-2.
    await call("POST", "/api/spaces/security/archive", owner, {});
    const again = await call<{ space: SpaceDTO }>("POST", "/api/spaces", owner, { name: "Security", icon: "lock", color: "#2467af" });
    expect(again.json.space.slug).toBe("security-2");
    // …and the archived one cannot come back while a live space has its name.
    expect((await call("POST", "/api/spaces/security/restore", owner, {})).json).toMatchObject({ error: "name_taken" });

    expect(await audit()).toEqual([
      { actor: OWNER, action: "space.create", target: "security" },
      { actor: OWNER, action: "space.archive", target: "security" },
      { actor: OWNER, action: "space.create", target: "security-2" },
    ]);
  });

  it("a member cannot create, rename, reorder, archive or restore; an owner of a space edits its description and owners only", async () => {
    const owner = await cookieFor(OWNER);
    const member = await cookieFor(MEMBER);
    expect((await call<{ message: string }>("POST", "/api/spaces", member, { name: "Mine" })).json.message).toBe("only an admin can create a space");
    expect((await call<{ message: string }>("PUT", "/api/spaces/design", member, { description: "not mine" })).json).toEqual({ error: "forbidden", message: "only an admin, or an owner of this space, can change its description and owners" });
    expect((await call("PUT", "/api/spaces/design/owners", member, { owners: [MEMBER] })).status).toBe(403);
    expect((await call<{ message: string }>("POST", "/api/spaces/design/archive", member, {})).json.message).toBe("only an admin can archive a space");

    // An admin makes the member an owner of Design.
    const set = await call<{ space: SpaceDTO }>("PUT", "/api/spaces/design/owners", owner, { owners: [MEMBER.toUpperCase()] });
    expect(set.json.space.owners).toEqual([MEMBER]);
    expect((await call<SpaceHomeDTO>("GET", "/api/spaces/design", member)).json.can_edit).toBe(true);
    // The owner edits the description and the owners…
    const edited = await call<{ space: SpaceDTO }>("PUT", "/api/spaces/design", member, { description: "  Principles and   components. " });
    expect(edited.json.space.description).toBe("Principles and components.");
    expect((await call<{ space: SpaceDTO }>("PUT", "/api/spaces/design/owners", member, { owners: [MEMBER, OTHER] })).json.space.owners).toEqual([MEMBER, OTHER]);
    // …but not the name, icon or color, and not another space.
    // A refusal says what only an admin may do — never "an owner of this space can" to that owner (Batch B finding).
    const rename = await call<{ error: string; message: string }>("PUT", "/api/spaces/design", member, { name: "Mine" });
    expect(rename.status).toBe(403);
    expect(rename.json).toEqual({ error: "forbidden", message: "only an admin can rename a space or change its icon or color" });
    expect((await call("PUT", "/api/spaces/design", member, { icon: "lock", description: "x" })).status).toBe(403);
    expect((await call("PUT", "/api/spaces/product", member, { description: "x" })).status).toBe(403);
    // Owners must be members of the org.
    expect((await call("PUT", "/api/spaces/design/owners", owner, { owners: ["not-a-member"] })).json).toMatchObject({ error: "not_member" });
    // An admin renames (a live name clash is refused) and re-icons.
    expect((await call("PUT", "/api/spaces/design", owner, { name: "PRODUCT" })).json).toMatchObject({ error: "name_taken" });
    expect((await call<{ space: SpaceDTO }>("PUT", "/api/spaces/design", owner, { name: "Design system", icon: "book", color: "#7a4f8f" })).json.space)
      .toMatchObject({ slug: "design", name: "Design system", icon: "book", color: "#7a4f8f" });
  });

  it("no org order to set: there is no move route; archive hides a space, restore brings it back in A to Z order", async () => {
    const owner = await cookieFor(OWNER);
    expect((await call("POST", "/api/spaces/design/move", owner, { after: null })).status).toBe(404);
    expect((await call("POST", "/api/spaces/engineering/archive", owner, {})).json).toMatchObject({ space: { archived: true } });
    expect((await library(owner)).spaces.map((s) => s.slug)).toEqual(["design", "product"]);
    // The archived space's home is still read (its pages stay).
    expect((await call<SpaceHomeDTO>("GET", "/api/spaces/engineering", owner)).json.space.archived).toBe(true);
    expect((await call("POST", "/api/spaces/engineering/restore", owner, {})).json).toMatchObject({ space: { archived: false } });
    expect((await library(owner)).spaces.map((s) => s.slug)).toEqual(["design", "engineering", "product"]);
    // A rename moves it to its new place in A to Z.
    expect((await call("PUT", "/api/spaces/design", owner, { name: "Visual design" })).status).toBe(200);
    expect((await library(owner)).spaces.map((s) => s.slug)).toEqual(["engineering", "product", "design"]);
  });

  it("every space route refuses a request that carries a bearer — never a token's", async () => {
    const owner = await cookieFor(OWNER);
    const { raw } = await mintTokenFor(OWNER);
    const auth = { headers: { authorization: `Bearer ${raw}` } };
    for (const [method, path, body] of [
      ["GET", "/api/spaces", undefined], ["GET", "/api/spaces/engineering", undefined], ["POST", "/api/spaces", { name: "Via token" }],
      ["PUT", "/api/spaces/engineering", { description: "via token" }], ["PUT", "/api/spaces/engineering/owners", { owners: [] }],
      ["PUT", "/api/spaces/prefs/me", { sidebar: ["design"] }], ["POST", "/api/spaces/engineering/archive", {}], ["POST", "/api/spaces/engineering/restore", {}],
    ] as const) {
      const res = await call(method, path, owner, body, auth);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(await audit()).toEqual([]);
  });

  it("POST /docs/propose places a person's new page in a live space; an unknown or archived one is a 400, never triage", async () => {
    const member = await cookieFor(MEMBER);
    const ok = await call<{ ok: boolean }>("POST", "/api/docs/propose", member, { title: "A design page", section: "reference", space: "design", body: "b" });
    expect(ok.status).toBe(200);
    expect((await first<{ space: string }>(env.DB, `SELECT space FROM docs WHERE org_id = ? AND slug = 'a-design-page'`, ORG_A))?.space).toBe("design");
    expect((await call("POST", "/api/docs/propose", member, { title: "Lost", section: "reference", space: "nope", body: "b" })).status).toBe(400);
    await env.DB.prepare(`UPDATE doc_spaces SET archived_at = 't' WHERE org_id = ? AND slug = 'product'`).bind(ORG_A).run();
    expect((await call("POST", "/api/docs/propose", member, { title: "Lost 2", section: "reference", space: "product", body: "b" })).status).toBe(400);
    expect(await all(env.DB, `SELECT id FROM needs_triage WHERE org_id = ?`, ORG_A)).toEqual([]);
  });
});

describe("MCP: list_spaces and the space filters", () => {
  async function tool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const server = buildTrovMcpServer(env as unknown as import("../src/env").Env, await bearerCtx("agent-person"));
    const client = new Client({ name: "test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      expect(res.isError, name).toBeFalsy();
      return JSON.parse(res.content[0].text);
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("list_spaces: the org's LIVE spaces with slug, name, description and page count", async () => {
    await ensureMember("agent-person");
    await propose_doc_update(A(), doc("e1", "engineering"), OWNER);
    await env.DB.prepare(`UPDATE doc_spaces SET archived_at = 't' WHERE org_id = ? AND slug = 'design'`).bind(ORG_A).run();
    expect(await tool("list_spaces")).toEqual({ spaces: [
      { slug: "engineering", name: "Engineering", description: "", pages: 1 },
      { slug: "product", name: "Product", description: "", pages: 0 },
    ] });
  });

  it("list_docs and query take a space (a slug or an alias); an unknown space matches nothing", async () => {
    await ensureMember("agent-person");
    await propose_doc_update(A(), { ...doc("eng-doc", "engineering"), body: "zebra in engineering" }, OWNER);
    await promote_doc(A(), "eng-doc", 1, OWNER);
    await propose_doc_update(A(), { ...doc("prod-doc", "product"), body: "zebra in product" }, OWNER);
    await promote_doc(A(), "prod-doc", 1, OWNER);
    const slugs = (r: unknown) => (r as { slug: string }[]).map((d) => d.slug);
    expect(slugs(await tool("list_docs", { space: "product" }))).toEqual(["prod-doc"]);
    expect(slugs(await tool("list_docs", { space: "technical" }))).toEqual(["eng-doc"]);
    expect(slugs(await tool("list_docs", { space: "nope" }))).toEqual([]);
    expect(slugs(await tool("list_docs"))).toEqual(["eng-doc", "prod-doc"]);
    const hits = async (space?: string) => (await query(A(), { q: "zebra", space })).primary.map((p) => p.id);
    expect(await hits("engineering")).toEqual(["eng-doc"]);
    expect(await hits("technical")).toEqual(["eng-doc"]);
    expect(await hits("nope")).toEqual([]);
    expect((await hits()).sort()).toEqual(["eng-doc", "prod-doc"]);
    const q = (await tool("query", { q: "zebra", space: "product" })) as { primary: { id: string }[] };
    expect(q.primary.map((p) => p.id)).toEqual(["prod-doc"]);
  });
});
