// THE AI ROUTER, as the AI side names it (docs/architecture/ai.md › The router). The table from a write to the
// scopes it made stale, and the marking itself, live in MCP-safe modules — src/tools/ai-route.ts (the table,
// `routeAi`) and src/data/ai-dirty.ts (the rows) — because the MCP writers mark too and nothing reachable from
// src/mcp.ts may import src/ai/ (test/secrets.mcp.test.ts). This file only re-exports them: nothing here calls a
// model, and nothing in src/ai/ marks a scope any other way.
export { AI_ROUTES, routeAi, scopesFor, type AiEvent, type AiEventType } from "../tools/ai-route";
export { AI_ANYONE_MAX, AI_MAX_ATTEMPTS, markDirty, type DirtyScope, type ScopeKey, type ScopeRef } from "../data/ai-dirty";
