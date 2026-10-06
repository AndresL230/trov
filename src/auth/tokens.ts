import { type DB, first, all, run, nowIso } from "../db";
import type { McpTokenSummary } from "@shared/rows";
import { randomToken, sha256Hex } from "./crypto";

// Tokens minted since the rename to Trov carry `trov_mcp_`. A token is looked up by the hash of the WHOLE
// string, so every `canopy_mcp_` token already pasted into an agent's config keeps working unchanged.
const TOKEN_PREFIX = "trov_mcp_";
/** How much of the random part is kept in the clear to label a token in Settings:
 *  4 of 43 base64url characters — enough to tell tokens apart, nothing to guess from. */
const HINT_LENGTH = 4;

/** Mint a token: returns the raw token ONCE; stores only its SHA-256 hash and the hint. */
export async function mintToken(db: DB, handle: string): Promise<{ raw: string }> {
  const raw = TOKEN_PREFIX + randomToken(32);
  const token_hash = await sha256Hex(raw);
  const hint = raw.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + HINT_LENGTH);
  await run(db, `INSERT INTO mcp_tokens (person, token_hash, token_hint, created_at) VALUES (?, ?, ?, ?)`,
    handle, token_hash, hint, nowIso());
  return { raw };
}

/** Resolve a presented raw token to its owner; null if missing/unknown/revoked. Bumps last_used_at. */
export async function resolveToken(db: DB, raw: string): Promise<{ handle: string } | null> {
  if (!raw) return null;
  const token_hash = await sha256Hex(raw);
  const row = await first<{ id: number; person: string }>(
    db, `SELECT id, person FROM mcp_tokens WHERE token_hash = ? AND revoked = 0`, token_hash);
  if (!row) return null;
  await run(db, `UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?`, nowIso(), row.id);
  return { handle: row.person };
}

/** A person's live (unrevoked) tokens, newest first — the hint, never the hash. */
export function listTokens(db: DB, handle: string): Promise<McpTokenSummary[]> {
  return all<McpTokenSummary>(db,
    `SELECT id, token_hint AS hint, created_at, last_used_at FROM mcp_tokens
     WHERE person = ? AND revoked = 0 ORDER BY created_at DESC, id DESC`, handle);
}

/** Revoke one of the caller's OWN tokens. False for an unknown id and for someone else's
 *  id alike (so it is never an existence oracle); true again on a repeat — soft, like every
 *  other exit here: the row stays, `resolveToken` stops honouring it. */
export async function revokeToken(db: DB, handle: string, id: number): Promise<boolean> {
  const res = await run(db, `UPDATE mcp_tokens SET revoked = 1 WHERE id = ? AND person = ?`, id, handle);
  return res.meta.changes > 0;
}
