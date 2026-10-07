import { env } from "cloudflare:test";
import type { Env } from "../../src/env";
import {
  platform, resolveTenant, resolveTenantById, systemTenant,
  type OrgRole, type PlatformContext, type SystemActor, type TenantContext,
} from "../../src/data/context";
import { mintToken } from "../../src/auth/tokens";
import { resolveBearerCredential } from "../../src/data/bearer";

/** The two orgs scripts/seed/reset.mjs keeps: SaplingLearn (every seeded person) and its empty neighbour. */
export const ORG_A = "org_saplinglearn";
export const ORG_B = "org_b";
const SLUG: Record<string, string> = { [ORG_A]: "saplinglearn", [ORG_B]: "acme" };

const e = env as unknown as Env;

// Every helper takes an optional `env` LAST, for a test that drives its own (extra secrets, a failing
// DB): the context is bound to the Env it was built from.

/** A PlatformContext — for the global tables (persons, identities, sessions, tokens, oauth, orgs). */
export const platformCtx = (actor = "test", envOver: Env = e): PlatformContext => platform(envOver, actor);

/** A SYSTEM TenantContext (role and via "system"), with no person behind it and no write: what a
 *  repository test passes where it passed `env.DB`, and what the webhook / cron run as. */
export const systemCtx = (orgId: string = ORG_A, actor: SystemActor = "system", envOver: Env = e): TenantContext =>
  systemTenant(platformCtx(actor, envOver), orgId, actor);

/** Make `handle` a member of `orgId` with `role`, creating the person if missing (as seedPerson does).
 *  Idempotent; an existing membership's role is overwritten. */
export async function ensureMember(handle: string, role: OrgRole = "member", orgId: string = ORG_A): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO persons (handle, name, color, created_at, onboarded_at) VALUES (?, ?, 'stone', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).bind(handle, handle),
    env.DB.prepare(`INSERT INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, ?, ?, '2026-01-01T00:00:00Z', 'seed')
                    ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role`).bind(orgId, handle, role),
  ]);
}

export interface TenantCtxOpts { via?: "session" | "bearer"; orgId?: string; env?: Env }

/**
 * A REAL member's TenantContext, through the production resolvers: `ensureMember(handle, role)`, then
 * `resolveTenant` (session) or `resolveTenantById` (bearer — the live-membership check a token's own
 * org gets, src/data/bearer.ts). With no `role`, an existing membership keeps its role (AndresL230
 * stays the owner) and a new one is a member.
 */
export async function tenantCtx(handle = "AndresL230", role?: OrgRole, o: TenantCtxOpts = {}): Promise<TenantContext> {
  const orgId = o.orgId ?? ORG_A;
  const held = await env.DB.prepare(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ? COLLATE NOCASE`).bind(orgId, handle).first<{ role: OrgRole }>();
  if (!held || (role && held.role !== role)) await ensureMember(handle, role ?? "member", orgId);
  const ctx = o.via === "bearer"
    ? await resolveTenantById(o.env ?? e, handle, orgId, "bearer")
    : await resolveTenant(o.env ?? e, handle, SLUG[orgId] ?? orgId);
  if (!ctx) throw new Error(`tenantCtx(${handle}): not a member of ${orgId}`);
  return ctx;
}

/** The /mcp context for `handle` IN `orgId` (default SaplingLearn): `tenantCtx` via "bearer" — what
 *  `buildTrovMcpServer` is bound to for a token minted for that org. */
export const bearerCtx = (handle: string, role?: OrgRole, envOver?: Env, orgId: string = ORG_A): Promise<TenantContext> =>
  tenantCtx(handle, role, { via: "bearer", env: envOver, orgId });

/** The (person, org) a bearer request's credential names (src/data/bearer.ts) — before the membership check. */
export const credentialOf = (request: Request, envOver: Env = e): Promise<{ handle: string; orgId: string } | null> =>
  resolveBearerCredential(envOver, request);

/** Mint a personal MCP token for `handle` in `orgId`, as production does — through that member's own
 *  session context (`handle` is made a member first if they are not one). */
export const mintTokenFor = async (handle: string, orgId: string = ORG_A): Promise<{ raw: string }> =>
  mintToken(await tenantCtx(handle, undefined, { orgId }));
