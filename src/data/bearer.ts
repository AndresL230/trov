// The /mcp tenant. Its own module, not context.ts: it needs the bearer lookup in src/auth, and
// src/auth reaches D1 through src/data — context.ts importing it back would be a cycle.
import type { Env } from "../env";
import { resolveBearerPrincipal } from "../auth/principal";
import { resolveSoleTenant, type SoleTenant } from "./context";

export type BearerTenant = SoleTenant | { ok: false; reason: "unauthorized" };

/**
 * Bearer token → (user, org), `via: "bearer"`. For now the token names only a PERSON (resolved exactly
 * as before — a pasted MCP token or an OAuth access token) and the org is their sole membership;
 * Phase 5a makes tokens org-scoped (§7.1) and this reads the org off the token row instead.
 */
export async function resolveBearerTenant(env: Env, request: Request): Promise<BearerTenant> {
  const principal = await resolveBearerPrincipal(request, env);
  if (!principal) return { ok: false, reason: "unauthorized" };
  return resolveSoleTenant(env, principal.handle, "bearer");
}
