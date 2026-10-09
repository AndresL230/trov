// The /mcp tenant — and THE rule for which organization a bearer call acts in (0051; the full rule is
// docs/architecture/data-layer.md § Bearer). Its own module, not context.ts: it needs the bearer lookup
// in src/auth, and src/auth reaches D1 through src/data — context.ts importing it back would be a cycle.
//
// A credential names a PERSON and a way of choosing among that person's organizations:
//   • a pasted `trov_mcp_` / `canopy_mcp_` token — ONE organization, the one on its row, for good;
//   • an OAuth grant in MANUAL mode — the organizations its person allowed, acting in its CURRENT one;
//   • an OAuth grant that FOLLOWS THE REPOSITORY — whichever of the person's organizations has the
//     repository a call names connected.
// Whatever the mode, an organization is only ever reached through `liveTenants` (./context.ts): the
// person's membership of it TODAY, in an org that is not suspended, with the role held there now.
// Nothing in a request can add an organization to that list — `repo` and `org` only choose within it.
import type { Env } from "../env";
import { resolveToken } from "../auth/tokens";
import { isAccessToken, resolveOAuthAccessToken, admitGrantOrg, setGrantCurrent, GrantScopeError } from "../auth/oauth";
import { normalizeOrgSlug, normalizeRepoRef } from "@shared/repo-ref";
import { liveTenants, platform, type OrgTenant, type TenantContext } from "./context";

export type BearerTenant = { ok: true; ctx: TenantContext } | { ok: false; reason: "unauthorized" };
export type ConnectionMode = "manual" | "repo";

/**
 * One authenticated /mcp connection.
 *   `orgs`     everything it can reach RIGHT NOW (read once per request): manual — its allowed
 *              organizations the person is still a live member of; repo — every organization the person
 *              is a live member of. Never empty: a connection with nowhere to act is `unauthorized`.
 *   `current`  manual only: the organization it acts in when a call names none, or null when that one
 *              has dropped out (the person left it, or it is suspended) while others remain.
 *   `fixed`    its organization can never change: a pasted token, or a context a caller pinned.
 */
export interface BearerConnection {
  readonly handle: string;
  readonly mode: ConnectionMode;
  readonly kind: "token" | "oauth";
  readonly fixed: boolean;
  readonly grantId: number | null;
  readonly orgs: readonly OrgTenant[];
  readonly current: OrgTenant | null;
  readonly env: Env;
}

export type BearerConnectionResult = { ok: true; conn: BearerConnection } | { ok: false; reason: "unauthorized" };

/** The credential a bearer header carries. Dispatches on the token prefix — an OAuth access token
 *  (`trov_oat_`, legacy `canopy_oat_`, obtained through /oauth/*) or a pasted `trov_mcp_` / legacy
 *  `canopy_mcp_` token. `orgId` is the org on a token's row, a manual grant's current organization,
 *  or '' for a grant that follows the repository. */
async function bearerCredential(env: Env, request: Request, nowMs: number):
  Promise<{ handle: string; orgId: string; mode: ConnectionMode; grantId: number | null } | null> {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return null;
  const raw = match[1].trim();
  const p = platform(env, "anonymous");
  if (isAccessToken(raw)) return resolveOAuthAccessToken(p, raw, nowMs);
  const token = await resolveToken(p, raw);
  return token ? { ...token, mode: "manual", grantId: null } : null;
}

/** The (person, org) on a bearer's row — before any membership check. For a grant that follows the
 *  repository `orgId` is ''. */
export async function resolveBearerCredential(env: Env, request: Request, nowMs: number = Date.now()): Promise<{ handle: string; orgId: string } | null> {
  const cred = await bearerCredential(env, request, nowMs);
  return cred ? { handle: cred.handle, orgId: cred.orgId } : null;
}

/**
 * Bearer header → connection. Two reads: the credential by hash, then its reach through `liveTenants`.
 * Every way of having NOWHERE to act is the same "unauthorized" (a 401 at /mcp): an unknown, revoked or
 * expired credential; a token whose person has left its org, or whose org is suspended or gone; a manual
 * grant none of whose allowed organizations the person is still a live member of; a repo grant whose
 * person is in no organization. A grant made before 0051 is a manual one allowed exactly its one
 * organization, so it resolves — and stops resolving — exactly as it always did.
 */
export async function resolveBearerConnection(env: Env, request: Request, nowMs: number = Date.now()): Promise<BearerConnectionResult> {
  const cred = await bearerCredential(env, request, nowMs);
  if (!cred) return { ok: false, reason: "unauthorized" };
  const base = { handle: cred.handle, env };
  if (cred.grantId === null) {
    // A pasted token: the one org on its row, or nothing.
    const own = (await liveTenants(env, cred.handle, { kind: "all" })).filter((o) => o.ctx.orgId === cred.orgId);
    if (own.length === 0) return { ok: false, reason: "unauthorized" };
    return { ok: true, conn: { ...base, mode: "manual", kind: "token", fixed: true, grantId: null, orgs: own, current: own[0] } };
  }
  if (cred.mode === "repo") {
    const orgs = await liveTenants(env, cred.handle, { kind: "all" });
    if (orgs.length === 0) return { ok: false, reason: "unauthorized" };
    return { ok: true, conn: { ...base, mode: "repo", kind: "oauth", fixed: false, grantId: cred.grantId, orgs, current: null } };
  }
  const orgs = await liveTenants(env, cred.handle, { kind: "grant", grantId: cred.grantId });
  if (orgs.length === 0) return { ok: false, reason: "unauthorized" };
  const current = orgs.find((o) => o.ctx.orgId === cred.orgId) ?? null;
  return { ok: true, conn: { ...base, mode: "manual", kind: "oauth", fixed: false, grantId: cred.grantId, orgs, current } };
}

/** The tenant a bearer acts in when a call names nothing: a token's org, a manual grant's current
 *  organization. A grant that follows the repository has none (every call names its repository), and
 *  neither has a manual grant whose current organization dropped out — both are `unauthorized` HERE,
 *  though `resolveBearerConnection` still answers for them. */
export async function resolveBearerTenant(env: Env, request: Request, nowMs: number = Date.now()): Promise<BearerTenant> {
  const r = await resolveBearerConnection(env, request, nowMs);
  return r.ok && r.conn.current ? { ok: true, ctx: r.conn.current.ctx } : { ok: false, reason: "unauthorized" };
}

/** A connection pinned to one context — what a caller that already holds a bearer TenantContext (a
 *  test, a tool run for one org) hands the MCP server. It behaves as a pasted token does: one org. */
export function pinnedConnection(env: Env, ctx: TenantContext, org: { slug?: string | null; name?: string | null } = {}): BearerConnection {
  const own: OrgTenant = { ctx, slug: org.slug ?? "", name: org.name ?? "" };
  return { handle: ctx.userId, env, mode: "manual", kind: "token", fixed: true, grantId: null, orgs: [own], current: own };
}

// ── which organization ONE call acts in ──────────────────────────────────────

export type ScopeCode = "repo_required" | "not_connected" | "ambiguous_org" | "org_unavailable" | "org_not_allowed" | "bad_request";

/** A call that resolves to no organization. `orgs` are slugs of the person's OWN organizations the
 *  connection can reach — never anything about an organization outside that list. */
export interface ScopeRefusal { ok: false; code: ScopeCode; message: string; orgs?: string[] }
export type CallTarget = { ok: true; org: OrgTenant; repo: string | null } | ScopeRefusal;

const refuse = (code: ScopeCode, message: string, orgs?: string[]): ScopeRefusal => ({ ok: false, code, message, ...(orgs ? { orgs: orgs.filter(Boolean) } : {}) });
const NOTHING = "Nothing was read or written.";
const list = (orgs: readonly OrgTenant[]): string => orgs.map((o) => o.slug).join(", ");

/**
 * The organization ONE tool call acts in — the only place this rule lives.
 *
 * MANUAL (and a pasted token): the connection's current organization. `org` (a slug) picks another for
 * this call alone, only from the allowed organizations the person is still a live member of; any other
 * value — unknown, someone else's, one the person belongs to but did not allow — is one and the same
 * `org_not_allowed`. If the current organization has dropped out, the call is refused
 * (`org_unavailable`, naming what is left): it never falls through to another. `repo` is ignored.
 *
 * REPO: `repo` is required (`repo_required`). Among the organizations the person is a live member of,
 * those that have that repository connected: exactly one → it; none → `not_connected` (the same bytes
 * whether the repository is unknown, connected nowhere, or connected only in an organization the person
 * is not in); several → `ambiguous_org`, listing those slugs, settled by `org` — which must be one of
 * them, else it is the same `not_connected`.
 */
export async function resolveCall(conn: BearerConnection, args: { repo?: unknown; org?: unknown }): Promise<CallTarget> {
  const wantsOrg = args.org !== undefined && args.org !== null && args.org !== "";
  const slug = wantsOrg ? normalizeOrgSlug(args.org) : null;
  if (wantsOrg && !slug) return refuse("bad_request", `\`org\` must be an organization's slug (e.g. "acme"). ${NOTHING}`);

  if (conn.mode === "manual") {
    if (slug) {
      const hit = conn.orgs.find((o) => o.slug === slug);
      if (hit) return { ok: true, org: hit, repo: null };
      return refuse("org_not_allowed",
        conn.fixed
          ? `This connection is bound to one organization and cannot act in "${slug}". ${NOTHING}`
          : `This connection may not act in "${slug}". It can use: ${list(conn.orgs)}. A person adds an organization in Trov › Settings › MCP access. ${NOTHING}`,
        conn.orgs.map((o) => o.slug));
    }
    if (conn.current) return { ok: true, org: conn.current, repo: null };
    return refuse("org_unavailable",
      `This connection's current organization is no longer available to you. Choose one of: ${list(conn.orgs)} — call switch_org, or pass \`org\` on the call. ${NOTHING}`,
      conn.orgs.map((o) => o.slug));
  }

  if (args.repo === undefined || args.repo === null || args.repo === "") {
    return refuse("repo_required",
      `This connection follows the repository you are working in: pass \`repo\` as owner/name (from \`git remote get-url origin\`) on every call. ${NOTHING}`);
  }
  const repo = normalizeRepoRef(args.repo);
  if (!repo) return refuse("bad_request", `\`repo\` must be a GitHub repository as owner/name. ${NOTHING}`);
  const found = await liveTenants(conn.env, conn.handle, { kind: "repo", repo });
  const candidates = slug ? found.filter((o) => o.slug === slug) : found;
  if (candidates.length === 1) return { ok: true, org: candidates[0], repo };
  if (candidates.length === 0) {
    return refuse("not_connected",
      `${repo} is not connected to ${slug ? `an organization of yours named "${slug}"` : "any of your organizations"}. Connect it in Trov › Org settings › Repositories, or pass a repository that is connected. ${NOTHING}`);
  }
  return refuse("ambiguous_org",
    `${repo} is connected to more than one of your organizations: ${list(candidates)}. Pass \`org\` with the one you mean. ${NOTHING}`,
    candidates.map((o) => o.slug));
}

/** Before a call's work runs in the organization it resolved to: a connection that follows the
 *  repository takes one of the person's agent-connection slots there the FIRST time (0044_plans) — or
 *  the plan refuses (`PlanLimitError`), and nothing is read or written. A manual connection's slots
 *  were taken when its person allowed each organization. */
export async function admitCall(conn: BearerConnection, org: OrgTenant, nowMs: number = Date.now()): Promise<void> {
  if (conn.mode === "repo" && conn.grantId !== null) await admitGrantOrg(org.ctx, conn.grantId, nowMs);
}

/** `switch_org`: move a MANUAL connection's current organization to another it is ALLOWED and the
 *  person is still a live member of. Navigation inside what the person granted — it can add nothing. */
export async function switchOrg(conn: BearerConnection, org: unknown): Promise<{ ok: true; org: OrgTenant } | ScopeRefusal> {
  if (conn.mode === "repo") {
    return refuse("bad_request", `This connection follows the repository you are working in, so it has no current organization to switch: pass \`repo\` on each call. ${NOTHING}`);
  }
  const slug = normalizeOrgSlug(org);
  if (!slug) return refuse("bad_request", `\`org\` must be an organization's slug (e.g. "acme"). ${NOTHING}`);
  const hit = conn.orgs.find((o) => o.slug === slug);
  if (conn.fixed || conn.grantId === null) {
    if (hit) return { ok: true, org: hit }; // its own organization: nothing to change
    return refuse("org_not_allowed", `This connection is bound to one organization and cannot switch to "${slug}". ${NOTHING}`, conn.orgs.map((o) => o.slug));
  }
  if (!hit) {
    return refuse("org_not_allowed",
      `This connection may not act in "${slug}". It can use: ${list(conn.orgs)}. A person adds an organization in Trov › Settings › MCP access. ${NOTHING}`,
      conn.orgs.map((o) => o.slug));
  }
  try {
    await setGrantCurrent(hit.ctx, conn.grantId);
  } catch (e) {
    if (e instanceof GrantScopeError) return refuse("org_not_allowed", `This connection may not act in "${slug}". ${NOTHING}`, conn.orgs.map((o) => o.slug));
    throw e;
  }
  return { ok: true, org: hit };
}
