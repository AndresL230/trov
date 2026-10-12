// The MCP tools as a client sees them — the source of the public reference (/docs/mcp-tools, /llms-full.txt)
// and of the landing's tool count. docs/architecture/web-ui.md › Docs for people and agents.
//
// Nothing here describes a tool by hand: it builds the REAL server (`buildTrovMcpServer`, the closures
// production runs) for an admin and for a member, and asks each for `tools/list` through the SDK's own
// client over an in-memory transport — so names, descriptions and input schemas are exactly what an MCP
// client receives, the `repo` / `org` arguments the connection adds included. A tool only the admin's list
// has is admin-only. Registering reads nothing (`catalogTenant` has no database), so this runs anywhere:
//   • at build time, in Node (web/site-build.ts loads it through Vite with `agents/mcp` stubbed — the
//     transport adapter is not part of registration), and writes shared/mcp-tools.generated.ts;
//   • in the test pool (test/mcp-catalog.test.ts), which fails while that file differs from this.
// The Worker never imports this module.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "./mcp";
import { catalogTenant, type OrgRole } from "./data/context";
import { SITE_ORIGIN } from "@shared/site-pages";
import type { McpToolDoc } from "@shared/mcp-tools-core";
import type { Env } from "./env";

interface Listed { name: string; description?: string; inputSchema: Record<string, unknown> }

async function listedFor(role: OrgRole): Promise<Listed[]> {
  // The public origin is the one a result's links would carry; no other binding is read by registration.
  const env = { PUBLIC_ORIGIN: SITE_ORIGIN } as Env;
  const server = buildTrovMcpServer(env, catalogTenant(role), { origin: SITE_ORIGIN, orgSlug: null });
  const client = new Client({ name: "trov-catalog", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    return (await client.listTools()).tools as Listed[];
  } finally {
    await client.close();
    await server.close();
  }
}

/** Every tool, in registration order, as `tools/list` returns it; `admin` = listed for an admin only. */
export async function mcpToolCatalog(): Promise<McpToolDoc[]> {
  const [admin, member] = await Promise.all([listedFor("admin"), listedFor("member")]);
  const everyone = new Set(member.map((t) => t.name));
  return admin.map((t) => ({ name: t.name, description: t.description ?? "", admin: !everyone.has(t.name), inputSchema: t.inputSchema }));
}
