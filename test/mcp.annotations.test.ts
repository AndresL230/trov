// `readOnlyHint` on tools/list (src/mcp.ts READ_ONLY_TOOLS): a client that asks the person before every
// call that may write (ChatGPT, claude.ai) runs the reads without asking. A tool marked read-only must never
// write — a use count or a delivered note included — so the list is held here by name.
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer, READ_ONLY_TOOLS } from "../src/mcp";
import { catalogTenant } from "../src/data/context";
import type { Env } from "../src/env";

async function listed(): Promise<{ name: string; annotations?: { readOnlyHint?: boolean } }[]> {
  const server = buildTrovMcpServer({} as Env, catalogTenant("admin"), { origin: "https://example.com", orgSlug: null });
  const client = new Client({ name: "t", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP tool annotations", () => {
  it("exactly the read tools are read-only; every other org tool says it is not", async () => {
    const tools = await listed();
    const names = tools.map((t) => t.name);
    expect([...READ_ONLY_TOOLS].filter((n) => !names.includes(n))).toEqual([]);
    expect(tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort()).toEqual([...READ_ONLY_TOOLS].sort());
    for (const n of ["get_prompt", "link_inbox", "switch_org", "claim_handoff", "create_ticket", "propose_doc_update", "record_session", "update_plan"]) {
      expect(tools.find((t) => t.name === n)?.annotations?.readOnlyHint, n).not.toBe(true);
    }
  });
});
