// The /mcp tenant. Its own module, not context.ts: it needs the bearer lookup in src/auth, and
// src/auth reaches D1 through src/data — context.ts importing it back would be a cycle.
import type { Env } from "../env";
import { resolveToken } from "../auth/tokens";
import { isAccessToken, resolveOAuthAccessToken } from "../auth/oauth";
import { platform, resolveTenantById, type TenantContext } from "./context";

export type BearerTenant = { ok: true; ctx: TenantContext } | { ok: false; reason: "unauthorized" };

/** The credential a bearer header carries: the (person, org) on its row. Dispatches on the token prefix —
 *  an OAuth access token (`trov_oat_`, legacy `canopy_oat_`, obtained through /oauth/*) or a pasted
 *  `trov_mcp_` / legacy `canopy_mcp_` token — so nothing downstream of /mcp can tell them apart. */
export async function resolveBearerCredential(env: Env, request: Request, nowMs: number = Date.now()): Promise<{ handle: string; orgId: string } | null> {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return null;
  const raw = match[1].trim();
  const p = platform(env, "anonymous");
  return isAccessToken(raw) ? resolveOAuthAccessToken(p, raw, nowMs) : resolveToken(p, raw);
}

/**
 * Bearer token → (user, org), `via: "bearer"` (§7.1). The org is the one recorded on the token row / the
 * OAuth grant when it was minted — NOTHING in the request can name another — and the context is built
 * only through a LIVE membership check of that org (`resolveTenantById`), so the role is the person's
 * role there today. Every way of not having that is the same "unauthorized" (a 401 at /mcp): an unknown,
 * revoked or expired credential, a person who has since left or been removed from the org, an org that
 * is SUSPENDED (0042_organizations) or gone. A row minted before tokens were org-scoped carries `org_saplinglearn`
 * (the organizations migration's column default backfilled every existing row), so it resolves exactly as it always did.
 */
export async function resolveBearerTenant(env: Env, request: Request, nowMs: number = Date.now()): Promise<BearerTenant> {
  const cred = await resolveBearerCredential(env, request, nowMs);
  const ctx = cred ? await resolveTenantById(env, cred.handle, cred.orgId, "bearer") : null;
  return ctx ? { ok: true, ctx } : { ok: false, reason: "unauthorized" };
}
