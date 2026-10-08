// Free organizations (docs/architecture/plans.md › Free; issue #94): a signed-in person creates one of their
// own with NO grant — `POST /api/orgs` with `plan: "free"`, or with nothing named and no grant to use. Each
// person may OWN `DEFAULT_ORG_LIMIT` (one) Free organization at a time: owning one on Free is what stops
// them; an org they upgraded to Pro, or one somebody else owns, does not count.
//
// The rule is held INSIDE the creating batch, not only before it: `freeGuardStmt` writes the org's
// `org.create_free` audit row with a NULL `detail` (a NOT NULL column) when, counting the org being
// created, the person owns more Free orgs than allowed — which fails the statement and with it the whole
// batch. Two racing requests cannot both make a second Free org (the pattern of src/plans/grants.ts
// `consumeStmt`).
import { isSuperadmin } from "../data/context";
import { type PlatformContext, type Stmt, first, stmt } from "../data/platform-sql";
import { OrgError, createOrg, type OrgRow } from "../orgs/repo";
import { FREE_PLAN } from "@shared/plans";
import { DEFAULT_ORG_LIMIT, type OrgSummary } from "@shared/orgs";

// The Free orgs a person OWNS — suspended ones too: suspending one is not a way to make another.
const OWNED_FREE = `FROM memberships m JOIN orgs o ON o.id = m.org_id
  WHERE m.user_id = ?1 COLLATE NOCASE AND m.role = 'owner' AND o.plan = '${FREE_PLAN}'`;

/** The Free organization `handle` owns (the oldest, should there be more), or null. */
export async function ownedFreeOrg(p: PlatformContext, handle: string): Promise<OrgSummary | null> {
  return first<{ slug: string; name: string }>(p, `SELECT o.slug, o.name ${OWNED_FREE} ORDER BY o.created_at ASC LIMIT 1`, handle);
}

/** What `GET /api/orgs` says about Free. A superadmin creates none here (Platform is where they add one). */
export async function freeOrgState(p: PlatformContext, handle: string): Promise<{ can_create: boolean; owned: OrgSummary | null }> {
  if (await isSuperadmin(p, handle)) return { can_create: false, owned: null };
  const owned = await ownedFreeOrg(p, handle);
  const n = owned ? (await first<{ n: number }>(p, `SELECT COUNT(*) AS n ${OWNED_FREE}`, handle))?.n ?? 1 : 0;
  return { can_create: n < DEFAULT_ORG_LIMIT, owned };
}

/** The guard (see the header): runs after the org row and its owner's membership, in the same batch. */
export const freeGuardStmt = (p: PlatformContext, handle: string, orgId: string, slug: string, at: string): Stmt =>
  stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at)
           VALUES (?2, ?1, 'org.create_free', ?3, CASE WHEN (SELECT COUNT(*) ${OWNED_FREE}) <= ?4 THEN '{}' END, ?5)`,
    handle, orgId, slug, DEFAULT_ORG_LIMIT, at);
/** The failure `freeGuardStmt` causes on purpose. */
const FREE_SPENT = /NOT NULL constraint failed: org_admin_audit\.detail/i;

const limitReached = (owned: OrgSummary | null): OrgError =>
  new OrgError("free_org_limit", `you already own a Free organization${owned ? ` (${owned.name})` : ""}; upgrade it to Pro, or ask Trov for another`);

/**
 * Create a Free organization owned by `handle`. Refused with 403 `free_org_limit` when they already own
 * one (also when a racing request made it first), and with 403 `no_grant` for a superadmin.
 */
export async function createFreeOrg(p: PlatformContext, handle: string, input: { slug: string; name: string }): Promise<OrgRow> {
  if (await isSuperadmin(p, handle)) throw new OrgError("no_grant", "a superadmin adds organizations in Platform");
  const state = await freeOrgState(p, handle);
  if (!state.can_create) throw limitReached(state.owned);
  try {
    // Awaited, not returned: workerd reports a refusal thrown before the caller's handler attaches as unhandled.
    return await createOrg(p, {
      slug: input.slug, name: input.name, owner: handle,
      plan: { id: FREE_PLAN, overrides: {}, source: "granted" },
      extra: (orgId, at) => [freeGuardStmt(p, handle, orgId, input.slug.trim(), at)],
    });
  } catch (e) {
    if (FREE_SPENT.test(e instanceof Error ? e.message : String(e))) throw limitReached(await ownedFreeOrg(p, handle));
    throw e;
  }
}
