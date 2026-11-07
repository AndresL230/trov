// Projects over MCP (src/tools/projects-agent.ts; docs/architecture/projects.md › Over MCP), driven through the REAL
// registered tools: list and open a project, create one, change its details and instructions, add items to it and
// take them out — under the same rules as the web app (owner / editor change it, a viewer reads, the one not_found,
// archived is read-only, private artifacts, the plan limits). Who can see a project, its members, archive and delete
// have no tool at all.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { createPage } from "../src/tools/artifacts";
import { create_ticket } from "../src/tools/tickets";
import { mcpToolCatalog } from "../src/mcp-catalog";
import { first } from "./helpers/db";
import { call } from "./helpers/ask";
import { bearerCtx, tenantCtx } from "./helpers/tenant";
import { EDITOR, OTHER, OWNER, P, STRANGER, VIEWER, cast, newProject, planOf, teamProject } from "./helpers/projects";

async function tool(handle: string, name: string, args: Record<string, unknown> = {}, orgSlug = "saplinglearn") {
  const ctx = handle === STRANGER ? await bearerCtx(handle, undefined, undefined, "org_b") : await bearerCtx(handle);
  const server = buildTrovMcpServer(env as unknown as Env, ctx, { origin: "https://trov.test", orgSlug: handle === STRANGER ? "acme" : orgSlug });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content[0].text;
    // An argument outside the tool's input schema is refused by the SDK itself, as plain text.
    return { json: text.startsWith("MCP error") ? { schema: text } : JSON.parse(text), isError: res.isError === true };
  } finally {
    await client.close();
    await server.close();
  }
}

const ok = (r: { json: any; isError: boolean }) => { expect(r.isError, JSON.stringify(r.json)).toBe(false); return r.json; };
const refused = (r: { json: any; isError: boolean }, code: string) => { expect([r.isError, r.json.code], JSON.stringify(r.json)).toEqual([true, code]); return r.json; };
/** Refused by the tool's input schema, before anything is read or written. */
const outOfSchema = (r: { json: any; isError: boolean }) => expect([r.isError, typeof r.json.schema], JSON.stringify(r.json)).toEqual([true, "string"]);
const pins = async () => (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM project_pins`))!.n;
const ticket = async (title: string) => create_ticket(await tenantCtx(OWNER), { title, body: "", category: "bug", priority: "normal", assignees: [] }, OWNER);

describe("reading projects over MCP", () => {
  it("list_projects: what the person can open, with their access and a url; get_project: instructions, knowledge, artifacts", async () => {
    const c = await cast();
    const p = await teamProject(c, { instructions: "Focus on blockers." });
    const n = await ticket("Connect Netlify");
    await call("POST", `${P}/${p.slug}/pins`, c.owner, { refs: [`ticket:${n}`] });

    const list = ok(await tool(VIEWER, "list_projects"));
    expect(list.projects).toEqual([expect.objectContaining({
      slug: p.slug, name: "Hosting providers", visibility: "members", owner: OWNER, your_access: "viewer", pins: 1,
      url: `https://trov.test/saplinglearn/#project/${p.slug}`,
    })]);
    expect(ok(await tool(VIEWER, "list_projects", { q: "nothing like it" })).projects).toEqual([]);
    expect(ok(await tool(OTHER, "list_projects")).projects).toEqual([]); // a members project they are not in

    const d = ok(await tool(VIEWER, "get_project", { project: p.slug }));
    expect(d).toMatchObject({ slug: p.slug, instructions: "Focus on blockers.", archived: false, your_access: "viewer", pin_limit: { used: 1, cap: null } });
    expect(d.members).toEqual([{ handle: OWNER, role: "owner" }, { handle: EDITOR, role: "editor" }, { handle: VIEWER, role: "viewer" }]);
    expect(d.knowledge).toEqual([expect.objectContaining({ ref: `ticket:${n}`, type: "ticket", title: "Connect Netlify", added_by: OWNER })]);
    expect(d.knowledge[0].url).toMatch(/^https:\/\/trov\.test\/saplinglearn\/#/);
    expect(d).not.toHaveProperty("chats"); // Ask's threads are never read over MCP
  });

  it("a project the person can't open is the one not_found — another member's, another org's, an unknown slug alike", async () => {
    const c = await cast();
    const p = await teamProject(c);
    const a = refused(await tool(OTHER, "get_project", { project: p.slug }), "not_found");
    const b = refused(await tool(STRANGER, "get_project", { project: p.slug }), "not_found");
    const u = refused(await tool(OWNER, "get_project", { project: "no-such-project" }), "not_found");
    expect(a).toEqual(b);
    expect(a).toEqual(u);
    for (const name of ["edit_project", "add_to_project", "remove_from_project"]) {
      refused(await tool(OTHER, name, { project: p.slug, name: "x", refs: ["doc:x"] }), "not_found");
    }
  });

  it("a pin the reader can't see is { ref, hidden: true }", async () => {
    const c = await cast();
    const p = await teamProject(c);
    const pub = await createPage(await tenantCtx(EDITOR), { title: "Editor plan", kind: "markdown", area: "data", repo: "", visibility: "org", content: "x" }, EDITOR);
    ok(await tool(EDITOR, "add_to_project", { project: p.slug, refs: [`artifact:${pub.slug}`] }));
    await env.DB.prepare(`UPDATE artifact_pages SET visibility = 'private' WHERE slug = ?`).bind(pub.slug).run();
    expect(ok(await tool(VIEWER, "get_project", { project: p.slug })).knowledge).toEqual([
      { ref: `artifact:${pub.slug}`, hidden: true, added_by: EDITOR, added_at: expect.any(String) },
    ]);
    expect(ok(await tool(EDITOR, "get_project", { project: p.slug })).knowledge[0]).toMatchObject({ title: "Editor plan", type: "artifact" });
  });
});

describe("creating and changing projects over MCP", () => {
  it("create_project: the token's person owns it, with the web app's defaults; the plan limit is plan_limit", async () => {
    await cast();
    const d = ok(await tool(OWNER, "create_project", { name: "Billing revamp", instructions: "Keep answers short." }));
    expect(d).toMatchObject({ slug: "billing-revamp", owner: OWNER, your_access: "owner", visibility: "members", instructions: "Keep answers short." });
    expect(await first(env.DB, `SELECT owner, icon, color FROM projects WHERE slug = 'billing-revamp'`)).toEqual({ owner: OWNER, icon: "server", color: "#525cc3" });
    // A client-supplied owner is not an argument (invariant 3): the SDK drops it, the token's person still owns it.
    ok(await tool(EDITOR, "create_project", { name: "Mine", owner: OWNER, visibility: "private" }));
    expect(await first(env.DB, `SELECT owner, visibility FROM projects WHERE slug = 'mine'`)).toEqual({ owner: EDITOR, visibility: "private" });
    outOfSchema(await tool(OWNER, "create_project", { name: "" }));

    await planOf("free");
    refused(await tool(OWNER, "create_project", { name: "Third" }), "plan_limit");
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM projects`))!.n).toBe(2);
  });

  it("edit_project: the owner and an editor change details and instructions; a viewer is forbidden; visibility is not an argument", async () => {
    const c = await cast();
    const p = await teamProject(c);
    expect(ok(await tool(EDITOR, "edit_project", { project: p.slug, instructions: "Cite the ticket.", description: "All hosts" })))
      .toMatchObject({ instructions: "Cite the ticket.", description: "All hosts", name: "Hosting providers" });
    refused(await tool(VIEWER, "edit_project", { project: p.slug, name: "Mine now" }), "forbidden");
    refused(await tool(OWNER, "edit_project", { project: p.slug }), "bad_request"); // nothing to change
    outOfSchema(await tool(OWNER, "edit_project", { project: p.slug, instructions: "y".repeat(2001) }));
    // Who can see it is the owner's, in the web app: the argument is not in the tool, so it changes nothing.
    ok(await tool(OWNER, "edit_project", { project: p.slug, name: "Hosts", visibility: "org" }));
    expect(await first(env.DB, `SELECT name, visibility FROM projects WHERE slug = ?`, p.slug)).toEqual({ name: "Hosts", visibility: "members" });
  });

  it("an archived project is read-only: every write is a conflict, and reading it still works", async () => {
    const c = await cast();
    const p = await teamProject(c);
    await call("POST", `${P}/${p.slug}/archive`, c.owner);
    expect(ok(await tool(OWNER, "get_project", { project: p.slug })).archived).toBe(true);
    expect(ok(await tool(OWNER, "list_projects")).archived).toEqual([expect.objectContaining({ slug: p.slug })]);
    refused(await tool(OWNER, "edit_project", { project: p.slug, name: "Again" }), "conflict");
    refused(await tool(OWNER, "add_to_project", { project: p.slug, refs: ["repo:SaplingLearn/sapling"] }), "conflict");
    refused(await tool(OWNER, "remove_from_project", { project: p.slug, refs: ["repo:SaplingLearn/sapling"] }), "conflict");
  });
});

describe("adding to and removing from a project over MCP", () => {
  it("add_to_project pins as the token's person; remove_from_project unpins and leaves the item itself alone", async () => {
    const c = await cast();
    const p = await teamProject(c);
    const [a, b] = [await ticket("One"), await ticket("Two")];
    const d = ok(await tool(EDITOR, "add_to_project", { project: p.slug, refs: [`ticket:${a}`, `ticket:${b}`, `ticket:${a}`] }));
    expect(d.knowledge.map((k: { ref: string }) => k.ref).sort()).toEqual([`ticket:${a}`, `ticket:${b}`]);
    expect(d.knowledge.every((k: { added_by: string }) => k.added_by === EDITOR)).toBe(true);
    // Adding again what is already there adds nothing.
    expect(ok(await tool(EDITOR, "add_to_project", { project: p.slug, refs: [`ticket:${a}`] })).pin_limit.used).toBe(2);

    const after = ok(await tool(OWNER, "remove_from_project", { project: p.slug, refs: [`ticket:${a}`, "doc:never-pinned"] }));
    expect(after.knowledge.map((k: { ref: string }) => k.ref)).toEqual([`ticket:${b}`]);
    expect(await first(env.DB, `SELECT title FROM tickets WHERE org_id = 'org_saplinglearn' AND number = ?`, a)).toEqual({ title: "One" });
    refused(await tool(VIEWER, "add_to_project", { project: p.slug, refs: [`ticket:${a}`] }), "forbidden");
    refused(await tool(VIEWER, "remove_from_project", { project: p.slug, refs: [`ticket:${b}`] }), "forbidden");
    expect(await pins()).toBe(1);
  });

  it("a bad ref — a type a project can't pin, or nothing the person can see — refuses the whole call", async () => {
    const c = await cast();
    const p = await newProject(c.owner);
    const n = await ticket("Real");
    for (const refs of [["person:pj-editor"], ["feed:1"], ["ticket:99999"], ["not a ref"], [`ticket:${n}`, "doc:missing"]]) {
      const r = refused(await tool(OWNER, "add_to_project", { project: p.slug, refs }), "bad_request");
      expect(r.error, JSON.stringify(refs)).toBeTruthy();
    }
    expect(await pins()).toBe(0);
  });

  it("a private artifact goes only into a private project; a new artifact made with upload_asset can be added by its slug", async () => {
    const c = await cast();
    const p = await teamProject(c);
    const secret = await createPage(await tenantCtx(OWNER), { title: "Mine", kind: "markdown", area: "data", repo: "", visibility: "private", content: "x" }, OWNER);
    expect(refused(await tool(OWNER, "add_to_project", { project: p.slug, refs: [`artifact:${secret.slug}`] }), "bad_request").error).toMatch(/private/i);
    const priv = await newProject(c.owner, { name: "Notes", visibility: "private" });
    ok(await tool(OWNER, "add_to_project", { project: priv.slug, refs: [`artifact:${secret.slug}`] }));

    const made = ok(await tool(OWNER, "upload_asset", { title: "Host matrix", kind: "markdown", area: "data", repo: "", visibility: "org", content: "# Hosts", summary: "first" }));
    const d = ok(await tool(OWNER, "add_to_project", { project: p.slug, refs: [`artifact:${made.slug}`] }));
    expect(d.knowledge).toEqual([expect.objectContaining({ ref: `artifact:${made.slug}`, title: "Host matrix" })]);
  });

  it("Free: the project's pin limit is plan_limit, and nothing is pinned", async () => {
    const c = await cast();
    await planOf("free");
    const p = await newProject(c.owner);
    const refs: string[] = [];
    for (let i = 0; i < 21; i++) refs.push(`ticket:${await ticket(`T${i}`)}`);
    ok(await tool(OWNER, "add_to_project", { project: p.slug, refs: refs.slice(0, 20) }));
    refused(await tool(OWNER, "add_to_project", { project: p.slug, refs: [refs[20]] }), "plan_limit");
    expect(await pins()).toBe(20);
  });
});

describe("what stays a person's", () => {
  it("no tool changes who can see a project, its members, or archives, restores or deletes one", async () => {
    const names = (await mcpToolCatalog()).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_projects", "get_project", "create_project", "edit_project", "add_to_project", "remove_from_project"]));
    expect(names.filter((n) => /project/.test(n) && /archive|restore|delete|member|visib|share|upload|thread|chat/.test(n))).toEqual([]);
    const edit = (await mcpToolCatalog()).find((t) => t.name === "edit_project")!;
    expect(Object.keys((edit.inputSchema as { properties: object }).properties)).not.toContain("visibility");
  });
});
