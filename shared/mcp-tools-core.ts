// The MCP tools as the public site describes them (docs/architecture/web-ui.md › Docs for people and
// agents). Zod-free and dependency-free: the SPA imports it as a VALUE (the landing's tool chips and
// count), and so do the docs pages and the Worker-side generator.
//
// The tools THEMSELVES are not typed here. `shared/mcp-tools.generated.ts` holds them as a client sees
// them (name, description, input schema, admin-only), written by the web build from src/mcp.ts's live
// registration (src/mcp-catalog.ts), and test/mcp-catalog.test.ts fails while it differs from what the
// server registers. What IS here is the one thing the registration cannot say: which group a tool is
// shown in. A new tool needs a line in MCP_TOOL_GROUPS (the test names the one that is missing).

/** One registered tool, as `tools/list` returns it to a client, plus whether only an admin is given it. */
export interface McpToolDoc {
  name: string;
  description: string;
  /** Listed only for a person who is an admin (or owner) in an organization the connection reaches. */
  admin: boolean;
  /** The tool's input as JSON Schema, exactly as `tools/list` sends it. */
  inputSchema: Record<string, unknown>;
}

/** The landing's view of a tool: its name and whether it is admin-only (no description, so the SPA's
 *  bundle does not carry the reference). */
export interface McpToolName { name: string; admin: boolean }

export interface McpToolGroup {
  key: string;
  label: string;
  /** One sentence for the reference page: what the group is for. */
  blurb: string;
  tools: readonly string[];
}

/** Every registered tool, in exactly one group, in the order the site lists them. */
export const MCP_TOOL_GROUPS: readonly McpToolGroup[] = [
  {
    key: "read", label: "Read",
    blurb: "Read-only. Orient with these before working an existing area; every result says whether it is settled (live) or only proposed.",
    tools: ["query", "get_doc", "list_docs", "get_feed", "get_roadmap", "get_my_work", "get_events", "get_repo_dashboard", "list_people"],
  },
  {
    key: "contribute", label: "Contribute",
    blurb: "Knowledge an agent proposes. Each goes through the gate and is staged; a person promotes it in the web app.",
    tools: ["append_feed", "propose_doc_update", "record_session"],
  },
  {
    key: "tickets", label: "Tickets",
    blurb: "The ticket queue. Reading and filing are open; every other write needs the ticket to be assigned to you already.",
    tools: ["list_tickets", "get_ticket", "create_ticket", "edit_ticket", "transition_ticket", "add_ticket_comment", "add_ticket_link", "set_ticket_sprint", "set_ticket_parent", "assign_ticket"],
  },
  {
    key: "sprints", label: "Sprints",
    blurb: "The roadmap's sprints. Direct writes, open to every member; a sprint is finished only when a person says so.",
    tools: ["list_sprints", "get_sprint", "create_sprint", "set_sprint_active", "complete_sprint", "add_sprint_resource", "delete_sprint"],
  },
  {
    key: "handoffs", label: "Handoffs and prompts",
    blurb: "Notes from one session to the next, and the team's reusable prompts. A saved prompt is staged until a person publishes it.",
    tools: ["send_handoff", "list_handoffs", "get_handoff", "claim_handoff", "expire_handoff", "search_prompts", "get_prompt", "save_prompt"],
  },
  {
    key: "artifacts", label: "Artifacts and doc images",
    blurb: "Versioned pages and files the team keeps, and the images a doc embeds. Only a person ratifies an artifact.",
    tools: ["upload_asset", "artifact_update", "artifact_get", "artifact_list"],
  },
  {
    key: "connection", label: "Connection",
    blurb: "About the connection itself, not an organization's data: who you are, and which organization a call acts in.",
    tools: ["get_connection", "switch_org"],
  },
  {
    key: "admin", label: "Admin",
    blurb: "Listed only for an organization's admins.",
    tools: ["update_plan"],
  },
];

/** How many tools every member gets, and how many more an admin gets. */
export function mcpToolCounts(tools: readonly Pick<McpToolDoc, "admin">[]): { everyone: number; adminOnly: number } {
  const adminOnly = tools.filter((t) => t.admin).length;
  return { everyone: tools.length - adminOnly, adminOnly };
}

/** "43 tools, plus 1 admin-only". */
export function mcpToolCountPhrase(tools: readonly Pick<McpToolDoc, "admin">[]): string {
  const { everyone, adminOnly } = mcpToolCounts(tools);
  return `${everyone} tools${adminOnly ? `, plus ${adminOnly} admin-only` : ""}`;
}

/** The registered tools whose group is missing, and the grouped names nothing registers (both must be empty). */
export function groupProblems(names: readonly string[]): { ungrouped: string[]; unknown: string[] } {
  const grouped = MCP_TOOL_GROUPS.flatMap((g) => g.tools);
  return { ungrouped: names.filter((n) => !grouped.includes(n)), unknown: grouped.filter((n) => !names.includes(n)) };
}

// ── input schemas, in words ──────────────────────────────────────────────────

export interface McpParamDoc {
  name: string;
  /** "string", "number", "array of string", "`technical` | `product`", … */
  type: string;
  required: boolean;
  description: string | null;
}

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Schema => !!v && typeof v === "object" && !Array.isArray(v);

/** A JSON Schema type in a few words. Enums list their values in backticks. */
export function schemaType(s: unknown): string {
  if (!isObj(s)) return "any";
  if (Array.isArray(s.enum)) return s.enum.map((v) => `\`${String(v)}\``).join(" | ");
  if ("const" in s) return `\`${String(s.const)}\``;
  const union = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null) as unknown[] | null;
  if (union) return union.map(schemaType).join(" or ");
  const t = s.type;
  if (Array.isArray(t)) return t.join(" or ");
  if (t === "array") return `array of ${schemaType(s.items)}`;
  if (t === "integer") return "integer";
  if (t === "object") {
    if (isObj(s.properties) && Object.keys(s.properties).length) return `object { ${Object.keys(s.properties).join(", ")} }`;
    if (isObj(s.additionalProperties)) return `map of ${schemaType(s.additionalProperties)}`;
    return "object";
  }
  return typeof t === "string" ? t : "any";
}

/** A tool's top-level arguments, in the schema's own order. */
export function toolParams(tool: Pick<McpToolDoc, "inputSchema">): McpParamDoc[] {
  const props = isObj(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
  const required = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : [];
  return Object.entries(props).map(([name, s]) => ({
    name,
    type: schemaType(s),
    required: required.includes(name),
    description: isObj(s) && typeof s.description === "string" ? s.description : null,
  }));
}

/** The arguments most tools share with the same schema (`repo`, `org`): said once, not per tool. A name
 *  counts when the same schema stands under it in more than half of the tools. */
export function commonParams(tools: readonly McpToolDoc[]): { name: string; schema: unknown; doc: McpParamDoc }[] {
  const seen = new Map<string, { name: string; schema: unknown; doc: McpParamDoc; n: number }>();
  for (const t of tools) {
    const props = isObj(t.inputSchema.properties) ? t.inputSchema.properties : {};
    for (const p of toolParams(t)) {
      const key = `${p.name}\u0000${JSON.stringify(props[p.name])}`;
      const hit = seen.get(key);
      if (hit) hit.n += 1;
      else seen.set(key, { name: p.name, schema: props[p.name], doc: p, n: 1 });
    }
  }
  return [...seen.values()].filter((v) => v.n > tools.length / 2).map(({ name, schema, doc }) => ({ name, schema, doc }));
}

/** Is this argument of `tool` one of the shared ones (same name AND same schema)? */
export function isCommonParam(tool: McpToolDoc, name: string, common: ReturnType<typeof commonParams>): boolean {
  const props = isObj(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
  return common.some((c) => c.name === name && JSON.stringify(c.schema) === JSON.stringify(props[name]));
}

/** The generated module's text (web/site-build.ts writes it): the tools in registration order, and their
 *  names alone for the landing. Deterministic, so an unchanged registration rewrites nothing. */
export function generatedToolsModule(tools: readonly McpToolDoc[]): string {
  const names: McpToolName[] = tools.map((t) => ({ name: t.name, admin: t.admin }));
  return [
    "// GENERATED by the web build (web/site-build.ts) from src/mcp.ts's registrations (src/mcp-catalog.ts).",
    "// Do not edit: `npm run build:web` rewrites it, and test/mcp-catalog.test.ts fails while it differs from",
    "// the tools the server registers. shared/mcp-tools-core.ts says how the site groups and describes them.",
    'import type { McpToolDoc, McpToolName } from "./mcp-tools-core";',
    "",
    "/** Every tool, by name and whether it is admin-only (the landing's chips and count). */",
    `export const MCP_TOOL_NAMES: readonly McpToolName[] = [\n${names.map((n) => `  ${JSON.stringify(n)},`).join("\n")}\n];`,
    "",
    "/** Every tool as `tools/list` returns it (the MCP tools reference, /docs/mcp-tools). */",
    `export const MCP_TOOLS: readonly McpToolDoc[] = ${JSON.stringify(tools, null, 2)};`,
    "",
  ].join("\n");
}
