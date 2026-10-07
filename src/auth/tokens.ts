// Personal MCP tokens (§7.1): each is bound to ONE (person, org). Minting, listing and revoking run
// through the caller's TenantContext — a member manages THEIR OWN tokens for THAT org; only the lookup
// of a presented token is cross-org, because the row is what names the org.
import { type TenantContext, all, run, nowIso } from "../data/sql";
import { type PlatformContext, first as platformFirst, run as platformRun } from "../data/platform-sql";
import type { McpTokenSummary } from "@shared/rows";
import { randomToken, sha256Hex } from "./crypto";
import { requirePlan } from "../plans/gate";

// Tokens minted since the rename to Trov carry `trov_mcp_`. A token is looked up by the hash of the WHOLE
// string, so every `canopy_mcp_` token already pasted into an agent's config keeps working unchanged.
const TOKEN_PREFIX = "trov_mcp_";
/** How much of the random part is kept in the clear to label a token in Settings:
 *  4 of 43 base64url characters — enough to tell tokens apart, nothing to guess from. */
const HINT_LENGTH = 4;

/** Mint a token for `ctx.userId` in `ctx.orgId`: returns the raw token ONCE; stores only its SHA-256
 *  hash and the hint. The org is the context's — the membership the gate just checked — never an input.
 *  A token is one of the person's AGENT CONNECTIONS into the org (0044_plans; 402 `plan_limit` at the cap). */
export async function mintToken(ctx: TenantContext): Promise<{ raw: string }> {
  await requirePlan(ctx, "agent_connections");
  const raw = TOKEN_PREFIX + randomToken(32);
  const token_hash = await sha256Hex(raw);
  const hint = raw.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + HINT_LENGTH);
  await run(ctx, `INSERT INTO mcp_tokens (org_id, person, token_hash, token_hint, created_at) VALUES (?, ?, ?, ?, ?)`,
    ctx.orgId, ctx.userId, token_hash, hint, nowIso());
  return { raw };
}

/** Resolve a presented raw token to the (person, org) on its row; null if missing/unknown/revoked.
 *  Bumps last_used_at. The caller still checks the LIVE membership (src/data/bearer.ts): a row only
 *  says who the token was minted for, not that they are still in that org. */
export async function resolveToken(p: PlatformContext, raw: string): Promise<{ handle: string; orgId: string } | null> {
  if (!raw) return null;
  const token_hash = await sha256Hex(raw);
  const row = await platformFirst<{ id: number; person: string; org_id: string }>(
    p, `SELECT id, person, org_id FROM mcp_tokens WHERE token_hash = ? AND revoked = 0`, token_hash);
  if (!row) return null;
  await platformRun(p, `UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?`, nowIso(), row.id);
  return { handle: row.person, orgId: row.org_id };
}

/** The caller's live (unrevoked) tokens for this org, newest first — the hint, never the hash. */
export function listTokens(ctx: TenantContext): Promise<McpTokenSummary[]> {
  return all<McpTokenSummary>(ctx,
    `SELECT id, token_hint AS hint, created_at, last_used_at FROM mcp_tokens
     WHERE org_id = ? AND person = ? COLLATE NOCASE AND revoked = 0 ORDER BY created_at DESC, id DESC`, ctx.orgId, ctx.userId);
}

/** Revoke one of the caller's OWN tokens for this org. False for an unknown id, someone else's id and
 *  the caller's token for ANOTHER org alike (so it is never an existence oracle); true again on a
 *  repeat — soft, like every other exit here: the row stays, `resolveToken` stops honouring it. */
export async function revokeToken(ctx: TenantContext, id: number): Promise<boolean> {
  const res = await run(ctx, `UPDATE mcp_tokens SET revoked = 1 WHERE id = ? AND org_id = ? AND person = ? COLLATE NOCASE`, id, ctx.orgId, ctx.userId);
  return res.meta.changes > 0;
}
