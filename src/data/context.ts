// The data layer's two contexts (canopy-multitenancy.md §4.1). This is the ONLY module that sees
// D1Database: a repository reaches D1 through a context, and a context is only ever built by one of
// the constructors below — a TenantContext needs a membership check or an explicit system scope.
import type { Env } from "../env";

/** The D1 binding's type, for `Env` — the one place outside this directory that has to name it. */
export type Database = D1Database;

const DB = Symbol("db"); // module-private: nothing outside this file can read a context's D1 handle…
const ENV = Symbol("env");

export type OrgRole = "owner" | "admin" | "member";
/** How the caller reached us. `getSecret` (§8.7.5) refuses `bearer`; role gates refuse `system`. */
export type Via = "session" | "bearer" | "system";
export type SystemActor = "github-webhook" | "system";

export interface TenantContext {
  readonly orgId: string;
  readonly userId: string; // a person handle; the actor's name for a system context
  readonly role: OrgRole | "system";
  readonly via: Via;
  readonly [DB]: D1Database;
  readonly [ENV]: Env;
}

export interface PlatformContext {
  readonly actor: string;
  readonly [DB]: D1Database;
  readonly [ENV]: Env;
}

/** …except through this accessor, which is for `src/data/*` ONLY (sql.ts, platform-sql.ts, legacy.ts). */
export const d1Of = (ctx: TenantContext | PlatformContext): D1Database => ctx[DB];

/** The key-encryption keys, for src/data/secrets.ts ONLY: a secret is sealed and opened with the KEK of
 *  the Env its context was built from, so no caller has to hand an Env to `getSecret` (§8.7). It returns
 *  those two values and nothing else — the rest of the Env stays out of a repository's reach. */
export const kekOf = (ctx: TenantContext): Pick<Env, "TROV_KEK" | "TROV_KEK_PREVIOUS"> =>
  ({ TROV_KEK: ctx[ENV].TROV_KEK, TROV_KEK_PREVIOUS: ctx[ENV].TROV_KEK_PREVIOUS });

// A context holds the Env and reads `env.DB` at each use, as the code it replaces did: building one
// costs nothing and cannot throw, so a broken binding still fails inside the caller's own guarded read.
const tenant = (env: Env, orgId: string, userId: string, role: OrgRole | "system", via: Via): TenantContext =>
  Object.freeze({ orgId, userId, role, via, [ENV]: env, get [DB]() { return env.DB; } });

// ── constructors ─────────────────────────────────────────────────────────────

/** The global tables (persons, identities, sessions, tokens, oauth, orgs, memberships). `actor` is a
 *  handle, or a label for a caller with no person ("anonymous", "system", "github-webhook"). */
export function platform(env: Env, actor: string): PlatformContext {
  return Object.freeze({ actor, [ENV]: env, get [DB]() { return env.DB; } });
}

/** HTTP (§5.2): the org named by `slug`, IF `userId` is a member of it and the org is not SUSPENDED
 *  (0042_organizations). One statement; null for an unknown slug, a non-member and a suspended org alike, so an
 *  org's existence — and its suspension — is never disclosed. */
export async function resolveTenant(env: Env, userId: string, slug: string): Promise<TenantContext | null> {
  const row = await env.DB.prepare(
    `SELECT o.id, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id
      WHERE o.slug = ? AND m.user_id = ? COLLATE NOCASE AND o.suspended_at IS NULL`
  ).bind(slug, userId).first<{ id: string; role: OrgRole }>();
  return row ? tenant(env, row.id, userId, row.role, "session") : null;
}

/** The same check by org ID, for a credential that names its org (an MCP token or OAuth grant —
 *  ./bearer.ts — or a signed download URL): `userId`'s LIVE membership of a non-suspended `orgId`, or null. */
export async function resolveTenantById(env: Env, userId: string, orgId: string, via: "session" | "bearer"): Promise<TenantContext | null> {
  const row = await env.DB.prepare(
    `SELECT m.role FROM memberships m JOIN orgs o ON o.id = m.org_id
      WHERE m.org_id = ? AND m.user_id = ? COLLATE NOCASE AND o.suspended_at IS NULL`
  ).bind(orgId, userId).first<{ role: OrgRole }>();
  return row ? tenant(env, orgId, userId, row.role, via) : null;
}

export type SoleTenant =
  | { ok: true; ctx: TenantContext }
  | { ok: false; reason: "no_membership" | "org_required" | "suspended" };

/**
 * CUT-OVER ALIAS (§6.3, Phases 3–5): the tenant is "the caller's only org". Every pre-multitenancy
 * path resolves through this until the `/api/o/:slug` routes replace it; Phase 7 deletes it. A person
 * with no membership and a person with more than one are told apart, so a caller can answer each —
 * and so is a person whose one org is SUSPENDED (0042_organizations): the same statement reads `suspended_at`, and
 * no context is built for it (each caller answers it as it answers an org that is not there).
 */
export async function resolveSoleTenant(env: Env, userId: string, via: "session" | "bearer"): Promise<SoleTenant> {
  const { results } = await env.DB.prepare(
    `SELECT m.org_id, m.role, o.suspended_at FROM memberships m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? COLLATE NOCASE LIMIT 2`
  ).bind(userId).all<{ org_id: string; role: OrgRole; suspended_at: string | null }>();
  if (results.length === 0) return { ok: false, reason: "no_membership" };
  if (results.length > 1) return { ok: false, reason: "org_required" };
  if (results[0].suspended_at !== null) return { ok: false, reason: "suspended" };
  return { ok: true, ctx: tenant(env, results[0].org_id, userId, results[0].role, via) };
}

/** Webhook / cron: act ON an org with no human member. Role and via are both "system" — it passes no
 *  human role gate, and system-only writers assert it. */
export function systemTenant(p: PlatformContext, orgId: string, actor: SystemActor): TenantContext {
  return tenant(p[ENV], orgId, actor, "system", "system");
}

// ── gates ────────────────────────────────────────────────────────────────────

/** Thrown by the `require*` gates; a route maps it to 403 `{ error: "forbidden" }`. */
export class RoleError extends Error {
  readonly code = "forbidden" as const;
  constructor() { super("forbidden"); }
}

/** "admin" = admin or owner; "owner" = owner only. A system context never passes. */
export function hasRole(ctx: TenantContext, min: "admin" | "owner"): boolean {
  return ctx.role === "owner" || (min === "admin" && ctx.role === "admin");
}

export function requireRole(ctx: TenantContext, min: "admin" | "owner"): void {
  if (!hasRole(ctx, min)) throw new RoleError();
}

/** The platform-wide role (§5.4, `platform_admins`). NOT an org role: it grants nothing inside an org. */
export async function isSuperadmin(p: PlatformContext, handle: string): Promise<boolean> {
  const row = await p[DB].prepare(`SELECT 1 AS ok FROM platform_admins WHERE person = ? COLLATE NOCASE`).bind(handle).first<{ ok: number }>();
  return row !== null;
}

export async function requireSuperadmin(p: PlatformContext, handle: string): Promise<void> {
  if (!(await isSuperadmin(p, handle))) throw new RoleError();
}
