import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import { app } from "../src/routes";
import { propose_doc_update, promote_doc } from "../src/tools/writes";
import type { QueryResult } from "@shared/contract";
import { cookieFor as authedCookie, seedPerson } from "./helpers/persons";
import { create_ticket } from "../src/tools/tickets";
import { bearerCtx, systemCtx } from "./helpers/tenant";

const AUTHOR = "agent";

// Drive the ACTUAL registered MCP `query` tool through an in-memory MCP
// client/server pair — the same closures production runs, not a re-impl.
async function callQuery(args: Record<string, unknown>): Promise<QueryResult> {
  const server = buildTrovMcpServer(env as unknown as import("../src/env").Env, await bearerCtx(AUTHOR));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const res = (await client.callTool({ name: "query", arguments: args })) as {
      content: Array<{ type: string; text: string }>;
    };
    return JSON.parse(res.content[0].text) as QueryResult;
  } finally {
    await client.close();
    await server.close();
  }
}

async function searchRoute(qs: string): Promise<QueryResult> {
  const cookie = await authedCookie("human");
  const res = await app.request(`/search?${qs}`, { headers: { cookie } }, env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: QueryResult };
  return body.result;
}

describe("registered MCP query tool + live GET /search route", () => {
  it("the MCP query tool returns the assembled QueryResult envelope from the real registration", async () => {
    await propose_doc_update(systemCtx(), { slug: "live-doc", section: "reference", title: "Live Doc", body: "the promoted falcon body", change_summary: "s", confidence: "high" }, AUTHOR);
    await promote_doc(systemCtx(), "live-doc", 1, AUTHOR);

    const r = await callQuery({ q: "falcon" });
    expect(r.meta.engine).toBe("fts5");
    const hit = r.primary.find((p) => p.id === "live-doc");
    expect(hit?.authority).toBe("live");
    expect(hit?.body).toBe("the promoted falcon body");
  });

  it("MCP surfaces staged (agent default include_staged:true); /search does not (human default false)", async () => {
    // An UNPROMOTED doc — found by title (its live body is empty until promotion).
    await propose_doc_update(systemCtx(), { slug: "secret-plan", section: "reference", title: "Pelican Plan", body: "the unpromoted pelican details", change_summary: "s", confidence: "high" }, AUTHOR);

    // Agent via the registered MCP tool: sees it, flagged unpromoted, staged body reached.
    const mcp = await callQuery({ q: "pelican" });
    const a = mcp.primary.find((p) => p.id === "secret-plan");
    expect(a?.authority).toBe("unpromoted");
    expect(a?.body).toBe("the unpromoted pelican details");

    // Human via the live route: the unpromoted doc is withheld entirely.
    const human = await searchRoute("q=pelican");
    expect(human.primary.find((p) => p.id === "secret-plan")).toBeUndefined();
    expect(human.pointers.find((p) => p.id === "secret-plan")).toBeUndefined();
  });

  it("/search returns { result } and a promoted doc is visible to humans", async () => {
    await propose_doc_update(systemCtx(), { slug: "human-doc", section: "reference", title: "Human Doc", body: "the heron is promoted", change_summary: "s", confidence: "high" }, AUTHOR);
    await promote_doc(systemCtx(), "human-doc", 1, AUTHOR);

    const result = await searchRoute("q=heron");
    expect(result.meta.engine).toBe("fts5");
    const hit = result.primary.find((p) => p.id === "human-doc");
    expect(hit?.authority).toBe("live");
    expect(hit?.staged_body).toBeNull();
  });

  it("/search honors the types csv filter", async () => {
    await propose_doc_update(systemCtx(), { slug: "owl-doc", section: "reference", title: "Owl Doc", body: "owl content", change_summary: "s", confidence: "high" }, AUTHOR);
    await promote_doc(systemCtx(), "owl-doc", 1, AUTHOR);
    await env.DB.prepare(`INSERT INTO feed (author, summary, body, artifacts, created_at) VALUES (?, 'owl feed', 'owl content', NULL, ?)`)
      .bind(AUTHOR, "2026-01-01T00:00:00Z").run();

    const docsOnly = await searchRoute("q=owl&types=doc");
    expect(docsOnly.primary.every((p) => p.type === "doc")).toBe(true);
    expect([...docsOnly.primary, ...docsOnly.pointers].some((p) => p.id === "owl-doc")).toBe(true);
  });

  it("tickets are not a query type: the MCP tool schema has no `ticket`, and /search never returns one", async () => {
    await seedPerson(AUTHOR);
    const id = await create_ticket(
      env.DB,
      { title: "Kestrel import crashes", body: "kestrel payloads over 1MB", category: "bug", priority: "high", assignees: [] },
      AUTHOR
    );

    // The registered MCP tool's `types` enum lists exactly four types — no ticket.
    const server = buildTrovMcpServer(env as unknown as import("../src/env").Env, await bearerCtx(AUTHOR));
    const client = new Client({ name: "test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const tools = await client.listTools();
      const schema = JSON.stringify(tools.tools.find((t) => t.name === "query")?.inputSchema);
      expect(schema).toContain("sprint");
      expect(schema).not.toContain('"ticket"');
    } finally {
      await client.close();
      await server.close();
    }

    // Neither surface returns it, whatever the caller asks for.
    const mcp = await callQuery({ q: "kestrel" });
    expect([...mcp.primary, ...mcp.pointers].some((p) => p.id === `ticket:${id}`)).toBe(false);

    const human = await searchRoute("q=kestrel");
    expect([...human.primary, ...human.pointers].some((p) => p.id.startsWith("ticket:"))).toBe(false);

    // …and an explicit `types=ticket` csv is simply not a recognized type.
    const asked = await searchRoute("q=kestrel&types=ticket");
    expect([...asked.primary, ...asked.pointers].some((p) => p.id.startsWith("ticket:"))).toBe(false);
  });

  it("/search requires a session (401 without a cookie)", async () => {
    const res = await app.request("/search?q=anything", {}, env);
    expect(res.status).toBe(401);
  });
});
