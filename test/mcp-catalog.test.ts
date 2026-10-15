// The MCP tool list the public site describes (the reference at /docs/mcp-tools, /llms-full.txt and the
// landing's count) is the server's OWN: shared/mcp-tools.generated.ts is written by the web build from
// src/mcp-catalog.ts, which lists the real registered tools through the SDK's client. This holds the
// committed copy to the live registration, so a tool added, renamed, re-described or given a new argument
// fails here until `npm run build:web` rewrites the file (docs/architecture/web-ui.md › Docs for people and
// agents). And a tool with no group on the site (shared/mcp-tools-core.ts) fails here too.
import { describe, it, expect } from "vitest";
import { mcpToolCatalog } from "../src/mcp-catalog";
import { MCP_TOOLS, MCP_TOOL_NAMES } from "@shared/mcp-tools.generated";
import { MCP_TOOL_GROUPS, generatedToolsModule, groupProblems, mcpToolCounts } from "@shared/mcp-tools-core";
import generatedSrc from "../shared/mcp-tools.generated.ts?raw";

describe("the MCP tool catalog", () => {
  it("the committed list IS what the server registers — run `npm run build:web` to rewrite it if this fails", async () => {
    const live = await mcpToolCatalog();
    expect(MCP_TOOLS).toEqual(live);
    expect(generatedSrc).toBe(generatedToolsModule(live));
  });

  it("43 tools for every member, plus update_plan for admins — the count the landing and the reference say", async () => {
    const live = await mcpToolCatalog();
    expect(mcpToolCounts(live)).toEqual({ everyone: 43, adminOnly: 1 });
    expect(live.filter((t) => t.admin).map((t) => t.name)).toEqual(["update_plan"]);
    expect(MCP_TOOL_NAMES).toEqual(live.map((t) => ({ name: t.name, admin: t.admin })));
    // the connection's own tools are listed like the rest
    expect(live.map((t) => t.name)).toEqual(expect.arrayContaining(["get_connection", "switch_org", "assign_ticket", "list_people"]));
  });

  it("every registered tool is in exactly one of the site's groups, and no group names a tool the server lacks", async () => {
    const names = (await mcpToolCatalog()).map((t) => t.name);
    expect(groupProblems(names), "add the tool to MCP_TOOL_GROUPS in shared/mcp-tools-core.ts").toEqual({ ungrouped: [], unknown: [] });
    const grouped = MCP_TOOL_GROUPS.flatMap((g) => g.tools);
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("describes without reaching any database: the catalog context throws on a read", async () => {
    const { catalogTenant } = await import("../src/data/context");
    const { d1Of } = await import("../src/data/context");
    expect(() => d1Of(catalogTenant("member"))).toThrow(/no database/);
  });
});
