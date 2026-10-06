// `/api/o/:slug/mcp-tokens…` (§6.3, §7.1): a member manages THEIR OWN personal MCP tokens for THIS org.
// Mounted behind `tenantGate` in src/routes.ts, so `c.var.ctx` is the caller's live membership of the
// org the path names; the token's org and owner are that context's, never a body or query value. Any
// member may — a token carries no more than its holder's own role in the org, re-read on every request.
// Session cookie only, like every route that hands out or revokes a credential: never an MCP tool.
import { Hono } from "hono";
import type { AppEnv } from "./principal";
import { mintToken, listTokens, revokeToken } from "./tokens";

export const mcpTokensApp = new Hono<AppEnv>();

/** The caller's live tokens for this org: `{ tokens: [{ id, hint, created_at, last_used_at }] }`. */
mcpTokensApp.get("/mcp-tokens", async (c) => c.json({ tokens: await listTokens(c.var.ctx) }));

/** Mint one. The raw token is in this response and nowhere else, ever: `{ token }`. */
mcpTokensApp.post("/mcp-tokens", async (c) => c.json({ token: (await mintToken(c.var.ctx)).raw }));

/** Revoke one of the caller's own tokens for this org. Someone else's id, the caller's token for
 *  ANOTHER org and an unknown id are the same 404. */
mcpTokensApp.post("/mcp-tokens/:id/revoke", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || !(await revokeToken(c.var.ctx, id))) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});
