// ── The MCP tools reference (/docs/mcp-tools), generated ────────────────────
// Everything about a tool here comes from shared/mcp-tools.generated.ts — the server's own `tools/list`,
// written by the build (src/mcp-catalog.ts) — so its name, description, arguments and admin-only flag are
// exactly what an MCP client receives. Hand-written: only the groups (shared/mcp-tools-core.ts) and the
// errors' hints (shared/error-hints.ts, the same text the server sends). PURE.

import { SITE_ORIGIN, type SitePage } from "@shared/site-pages";
import { MCP_TOOLS } from "@shared/mcp-tools.generated";
import { MCP_TOOL_GROUPS, commonParams, isCommonParam, mcpToolCounts, toolParams, type McpToolDoc, type McpParamDoc } from "@shared/mcp-tools-core";
import { MCP_ERROR_HINTS, MCP_FALLBACK_HINT, MCP_INVALID_TOKEN_HINT, MCP_UNAUTHORIZED_HINT } from "@shared/error-hints";

const MCP_URL = `${SITE_ORIGIN}/mcp`;

const param = (p: McpParamDoc): string =>
  `- \`${p.name}\` (${p.type}, ${p.required ? "required" : "optional"})${p.description ? `: ${p.description}` : ""}`;

function tool(t: McpToolDoc, common: ReturnType<typeof commonParams>): string {
  const own = toolParams(t).filter((p) => !isCommonParam(t, p.name, common));
  const shared = toolParams(t).filter((p) => isCommonParam(t, p.name, common)).map((p) => `\`${p.name}\``);
  const args = own.length ? `Arguments:\n\n${own.map(param).join("\n")}` : "No arguments of its own.";
  return [
    `### \`${t.name}\``,
    t.admin ? `**Admin only:** listed for a person who is an admin or owner of an organization the connection reaches.\n\n${t.description}` : t.description,
    shared.length ? `${args}\n\nAlso takes ${shared.join(" and ")} (see Common arguments).` : args,
  ].join("\n\n");
}

/** The whole reference, from the registered tools (a test passes its own list). */
export function mcpToolsMarkdown(page: SitePage, tools: readonly McpToolDoc[] = MCP_TOOLS): string {
  const { everyone, adminOnly } = mcpToolCounts(tools);
  const common = commonParams(tools);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const groups = MCP_TOOL_GROUPS.map((g) => {
    const members = g.tools.map((n) => byName.get(n)).filter((t): t is McpToolDoc => !!t);
    return members.length ? [`## ${g.label}`, g.blurb, ...members.map((t) => tool(t, common))].join("\n\n") : "";
  }).filter(Boolean);
  const codes = Object.entries(MCP_ERROR_HINTS).map(([code, hint]) => `- \`${code}\`: ${hint}`).join("\n");
  return [
    `# MCP tools reference\n\n${page.description}`,
    `Trov's MCP server is \`${MCP_URL}\` (Streamable HTTP). It gives **${everyone} tools** to every member${adminOnly ? `, plus **${adminOnly}** to an organization's admins (${everyone + adminOnly} in all)` : ""}. This page is written from the server's own tool list at every build, so the names, descriptions and arguments below are exactly what your client receives from \`tools/list\`. To connect a client: [Connect an MCP client](${SITE_ORIGIN}/docs/connect). What staged and live mean: [Concepts](${SITE_ORIGIN}/docs/concepts).`,
    "## Common arguments",
    `These decide which organization a call acts in (see get_connection), and the tool itself never sees them. Every tool below that lists them takes them, the same way:\n\n${common.map((c) => param(c.doc)).join("\n")}`,
    ...groups,
    "## Errors",
    "A tool that fails answers `isError: true` with one text block holding JSON, and nothing was written unless the error says otherwise:",
    "```json\n{ \"error\": \"what went wrong, in a sentence\", \"code\": \"not_found\", \"hint\": \"what to do next\" }\n```",
    "`code` is one of these; `hint` is always the sentence beside it (a refusal about which organization a call acts in also lists the organizations you may use, as `orgs`):",
    codes,
    `An error with no \`code\` (an unexpected failure) carries this hint: ${MCP_FALLBACK_HINT}`,
    "**Arguments that do not match a tool's input schema** are refused by the MCP SDK before the tool runs: the text starts `MCP error -32602: Input validation error: Invalid arguments for tool <name>` and lists each wrong argument with what was expected. Fix those arguments and call again.",
    `**Not signed in.** \`/mcp\` answers \`401\` with \`WWW-Authenticate: Bearer resource_metadata="${SITE_ORIGIN}/.well-known/oauth-protected-resource"\` (and \`error="invalid_token"\` when a token was sent and refused), and a JSON body, \`{ "error": "unauthorized", "hint": "…" }\`. With no token, the hint is:\n\n> ${MCP_UNAUTHORIZED_HINT}\n\nWith a refused token:\n\n> ${MCP_INVALID_TOKEN_HINT}`,
    "**Plan limits** come back as `code: \"plan_limit\"`, with the limit in words in `error`. The MCP server has no rate limit of its own.",
    "**The HTTP API** (the web app's, behind its session cookie) answers its JSON errors the same way: the status and the `error` code, any `message`, and a `hint` chosen by that code and status alone.",
  ].join("\n\n");
}
