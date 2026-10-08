// Grants (0044_plans `org_grants`, docs/architecture/plans.md): "this person may set up ONE organization
// of their own, on this plan". A superadmin creates one (Platform › Access) — later, so does billing
// (./billing.ts) — and the grantee creates the org themselves with `POST /api/orgs`, which CONSUMES it.
// This is the only way a person who is not a superadmin comes to create an org: `persons.org_limit` is
// read by nothing any more.
//
// A grant names its person the three ways Platform names an org's admin, and is matched the way an
// invitation is (src/orgs/repo.ts `MINE`): a handle to the person, a GitHub login to one of their GitHub
// identities, an e-mail to a provider-VERIFIED address — never the editable `persons.email`. So the
// grantee needs no account when the grant is made.
import type { Env } from "../env";
import { isSuperadmin } from "../data/context";
import { type PlatformContext, type Stmt, first, all, stmt, batch, nowIso } from "../data/platform-sql";
import { OrgError, createOrg, parseInviteAddress, type OrgRow } from "../orgs/repo";
import { sendGrantNotice } from "../notifications/grant";
import { takeLimit } from "../platform/limits";
import {
  planDef, resolveEntitlements, storedOverrides, GRANT_NOTE_MAX, GRANT_EXPIRY_MAX_DAYS,
  type MyGrant, type PlatformGrant, type PlanId, type PlanOverrides, type PlanSource, type OrgGrantStatus,
} from "@shared/plans";
import { cleanPlan, cleanOverrides, PlanError } from "./state";

export type GrantErrorCode = "invalid_grant" | "no_such_person" | "not_found" | "grant_used";
export const GRANT_ERROR_STATUS: Record<GrantErrorCode, 400 | 404 | 409> = { invalid_grant: 400, no_such_person: 404, not_found: 404, grant_used: 409 };
export class GrantError extends Error {
  constructor(readonly code: GrantErrorCode, message?: string) { super(message ?? code); }
}

interface GrantRow {
  id: number; person: string | null; github_login: string | null; email: string | null; plan: string; overrides: string;
  note: string | null; source: string; granted_by: string; created_at: string; expires_at: string | null;
  status: "unused" | "used" | "revoked"; used_at: string | null; used_by: string | null;
  revoked_at: string | null; revoked_by: string | null; mail_status: "sent" | "failed" | null; mail_at: string | null; mail_error: string | null;
  org_slug: string | null; org_name: string | null;
}
const GRANT_SELECT = `SELECT g.id, g.person, g.github_login, g.email, g.plan, g.overrides, g.note, g.source, g.granted_by, g.created_at, g.expires_at,
  g.status, g.used_at, g.used_by, g.revoked_at, g.revoked_by, g.mail_status, g.mail_at, g.mail_error, o.slug AS org_slug, o.name AS org_name
  FROM org_grants g LEFT JOIN orgs o ON o.id = g.used_org`;

const statusOf = (r: Pick<GrantRow, "status" | "expires_at">, now: string): OrgGrantStatus =>
  r.status === "unused" && r.expires_at !== null && r.expires_at <= now ? "expired" : r.status;

const toGrant = (r: GrantRow, now: string): PlatformGrant => ({
  id: r.id, handle: r.person, github_login: r.github_login, email: r.email, plan: planDef(r.plan).id, overrides: storedOverrides(r.overrides),
  note: r.note, source: r.source === "billing" ? "billing" : "granted", granted_by: r.granted_by, created_at: r.created_at, expires_at: r.expires_at,
  status: statusOf(r, now), used_at: r.used_at, used_by: r.used_by,
  org: r.org_slug ? { slug: r.org_slug, name: r.org_name ?? r.org_slug } : null,
  revoked_at: r.revoked_at, revoked_by: r.revoked_by, mail_status: r.mail_status, mail_at: r.mail_at, mail_error: r.mail_error,
});

export async function getGrant(p: PlatformContext, id: number): Promise<PlatformGrant | null> {
  const row = await first<GrantRow>(p, `${GRANT_SELECT} WHERE g.id = ?`, id);
  return row ? toGrant(row, nowIso()) : null;
}

/** Every grant, newest first — unused, used (with the org it became), revoked and expired. */
export async function listGrants(p: PlatformContext): Promise<PlatformGrant[]> {
  const now = nowIso();
  return (await all<GrantRow>(p, `${GRANT_SELECT} ORDER BY g.created_at DESC, g.id DESC LIMIT 500`)).map((r) => toGrant(r, now));
}

// ── creating one ─────────────────────────────────────────────────────────────

type Target = { person: string } | { github_login: string } | { email: string };

/** Exactly one of `handle` (an existing person — 404 otherwise), `github_login`, `email`. */
async function resolveTarget(p: PlatformContext, to: unknown): Promise<Target> {
  const t = (to && typeof to === "object" ? to : {}) as { handle?: unknown; github_login?: unknown; email?: unknown };
  const given = [t.handle, t.github_login, t.email].filter((v) => v !== undefined && v !== null && v !== "");
  if (given.length !== 1) throw new GrantError("invalid_grant", "name the person by exactly one of handle, github_login or email");
  if (t.handle !== undefined && t.handle !== null && t.handle !== "") {
    const row = typeof t.handle === "string" ? await first<{ handle: string }>(p, `SELECT handle FROM persons WHERE handle = ? COLLATE NOCASE`, t.handle.trim().replace(/^@/, "")) : null;
    if (!row) throw new GrantError("no_such_person", "no person has that handle — grant by github_login or email instead");
    if (await isSuperadmin(p, row.handle)) throw new GrantError("invalid_grant", "a superadmin adds organizations in Platform and needs no grant");
    return { person: row.handle };
  }
  try {
    const a = parseInviteAddress(t);
    return a.github_login !== undefined ? { github_login: a.github_login } : { email: a.email };
  } catch (e) {
    throw new GrantError("invalid_grant", e instanceof Error ? e.message : undefined);
  }
}

function cleanNote(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new GrantError("invalid_grant", "note must be text");
  const t = v.trim();
  if (t.length > GRANT_NOTE_MAX) throw new GrantError("invalid_grant", `a note is at most ${GRANT_NOTE_MAX} characters`);
  return t === "" ? null : t;
}

/** `expires_in_days` (a whole number, 1–365) → the instant; null / omitted = never. */
function expiryOf(days: unknown, now: number): string | null {
  if (days === undefined || days === null) return null;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > GRANT_EXPIRY_MAX_DAYS) {
    throw new GrantError("invalid_grant", `expires_in_days is a whole number from 1 to ${GRANT_EXPIRY_MAX_DAYS}, or null for never`);
  }
  return new Date(now + days * 86_400_000).toISOString();
}

export interface GrantInput {
  /** `{ handle }` | `{ github_login }` | `{ email }`. */
  to: unknown;
  plan: unknown;
  overrides?: unknown;
  note?: unknown;
  expires_in_days?: unknown;
}

/**
 * Write one grant. `p.actor` is recorded as `granted_by` — a superadmin's handle, or `billing`.
 * `external_ref` (billing's payment id) makes it idempotent: a second call with the same ref returns the
 * first grant and writes nothing. Audited as `grant.create`, in the same batch.
 */
export async function createGrant(p: PlatformContext, input: GrantInput, opts: { source?: PlanSource; external_ref?: string | null } = {}): Promise<PlatformGrant> {
  const ref = opts.external_ref ?? null;
  if (ref !== null) {
    const held = await first<{ id: number }>(p, `SELECT id FROM org_grants WHERE external_ref = ?`, ref);
    if (held) return (await getGrant(p, held.id))!;
  }
  let plan: PlanId, overrides: PlanOverrides;
  try {
    plan = cleanPlan(input.plan);
    overrides = cleanOverrides(input.overrides);
  } catch (e) {
    if (e instanceof PlanError) throw new GrantError("invalid_grant", e.message);
    throw e;
  }
  const note = cleanNote(input.note);
  const now = Date.now();
  const expires = expiryOf(input.expires_in_days, now);
  const to = await resolveTarget(p, input.to);
  const at = new Date(now).toISOString();
  const target = "person" in to ? `@${to.person}` : "github_login" in to ? `github:${to.github_login}` : to.email;
  let id: number;
  try {
    const [res] = await batch(p, [
      stmt(p, `INSERT INTO org_grants (person, github_login, email, plan, overrides, note, source, external_ref, granted_by, created_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "person" in to ? to.person : null, "github_login" in to ? to.github_login : null, "email" in to ? to.email : null,
        plan, JSON.stringify(overrides), note, opts.source ?? "granted", ref, p.actor, at, expires),
      stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (NULL, ?, 'grant.create', 'grant:' || last_insert_rowid(), ?, ?)`,
        p.actor, JSON.stringify({ to: target, plan, ...(Object.keys(overrides).length ? { overrides } : {}), ...(expires ? { expires_at: expires } : {}) }), at),
    ]);
    id = res.meta.last_row_id;
  } catch (e) {
    // Lost a race on `external_ref`: the other writer's grant is the answer.
    const held = ref !== null && /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e))
      ? await first<{ id: number }>(p, `SELECT id FROM org_grants WHERE external_ref = ?`, ref) : null;
    if (!held) throw e;
    id = held.id;
  }
  return (await getGrant(p, id))!;
}

/**
 * Mail the notice of an E-MAIL grant (nothing for a handle or a GitHub login: there is no address). It
 * takes one unit of the granter's daily `invite` allowance (src/platform/limits.ts) — a superadmin is
 * exempt, as for every limit, and `billing` is not a person — and is skipped, silently, when that is
 * spent. Never throws; the outcome is on the grant's row.
 */
export async function mailGrant(env: Env, p: PlatformContext, grant: Pick<PlatformGrant, "id" | "email" | "plan" | "source" | "granted_by">, origin: string, fetchImpl?: typeof fetch): Promise<void> {
  if (grant.email === null) return;
  const byPerson = grant.source !== "billing";
  try {
    if (byPerson && !(await isSuperadmin(p, grant.granted_by)) && (await takeLimit(p, grant.granted_by, "invite")) !== null) return;
  } catch {
    return;
  }
  const def = planDef(grant.plan);
  await sendGrantNotice(env, p, { grantId: grant.id, email: grant.email, granterHandle: byPerson ? grant.granted_by : null, planName: def.name, planDescription: def.description, origin, fetchImpl });
}

/** Revoke an UNUSED grant (an expired one too). A used one is 409 `grant_used`: the org exists, and
 *  suspending or re-planning it is done on the org. Audited as `grant.revoke`. */
export async function revokeGrant(p: PlatformContext, id: number): Promise<PlatformGrant> {
  const at = nowIso();
  const [res] = await batch(p, [
    stmt(p, `UPDATE org_grants SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ? AND status = 'unused'`, at, p.actor, id),
    stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) SELECT NULL, ?, 'grant.revoke', ?, '{}', ? WHERE changes() > 0`, p.actor, `grant:${id}`, at),
  ]);
  const grant = await getGrant(p, id);
  if (!grant) throw new GrantError("not_found");
  if ((res.meta.changes ?? 0) === 0) throw new GrantError(grant.status === "used" ? "grant_used" : "not_found");
  return grant;
}

// ── the grantee's side ───────────────────────────────────────────────────────

// A grant is the caller's when it names their handle, one of THEIR GitHub identity logins, or one of
// THEIR provider-verified e-mails. (The grant columns are COLLATE NOCASE; `IN` uses the left operand's.)
const MINE = `(g.person = ?1
  OR g.github_login IN (SELECT subject FROM identities WHERE person = ?1 COLLATE NOCASE AND provider = 'github')
  OR g.email IN (SELECT verified_email FROM identities WHERE person = ?1 COLLATE NOCASE AND verified_email IS NOT NULL))`;
const USABLE = `g.status = 'unused' AND (g.expires_at IS NULL OR g.expires_at > ?2)`;

/** The grants `handle` can use now, OLDEST first — the order one is picked in when none is named.
 *  A superadmin holds none here: they add organizations in Platform. */
export async function usableGrants(p: PlatformContext, handle: string): Promise<MyGrant[]> {
  if (await isSuperadmin(p, handle)) return [];
  const rows = await all<GrantRow>(p, `${GRANT_SELECT} WHERE ${MINE} AND ${USABLE} ORDER BY g.created_at ASC, g.id ASC`, handle, nowIso());
  return rows.map((r) => {
    const def = planDef(r.plan);
    return {
      id: r.id, plan: def.id, plan_name: def.name, entitlements: resolveEntitlements(def.id, storedOverrides(r.overrides)),
      granted_by: r.granted_by, created_at: r.created_at, expires_at: r.expires_at,
    };
  });
}

/**
 * The consuming UPDATE, a statement of the batch that creates the org. It is by id alone and ALWAYS
 * writes the row: `used` when the grant is still usable — and, when it is not (used by a double submit,
 * revoked or expired since it was read), a status the table's CHECK (`org_grant_usable`) refuses, which
 * fails the statement and with it the whole batch. So one grant makes one org, with no window between "check" and "use".
 */
export const consumeStmt = (p: PlatformContext, grantId: number, handle: string, orgId: string, at: string): Stmt =>
  stmt(p, `UPDATE org_grants SET
             status = CASE WHEN status = 'unused' AND (expires_at IS NULL OR expires_at > ?1) THEN 'used' ELSE 'spent' END,
             used_at = ?1, used_by = ?2, used_org = ?3
            WHERE id = ?4`, at, handle, orgId, grantId);

/**
 * A PAID grant's org (0045_billing; docs/architecture/billing.md): a statement of the SAME batch that
 * creates the org. The grant's `external_ref` is its Stripe subscription; the org takes that
 * subscription's ids and its CURRENT plan, status and period from `billing_subscriptions`, and the seats
 * it pays for from the grant's overrides (kept current by `setPaidGrantPlan`) — read here, at write
 * time, so a subscription event that landed while the form was open is not lost. Writes nothing for a
 * grant a superadmin gave (no `billing` source, no subscription row).
 */
export const linkPaidOrgStmt = (p: PlatformContext, grantId: number, orgId: string): Stmt =>
  stmt(p, `UPDATE orgs SET billing_subscription_id = s.subscription_id, billing_customer_id = s.customer_id,
                  plan = s.plan, plan_status = s.plan_status, plan_period_end = s.period_end, plan_overrides = s.overrides
             FROM (SELECT b.subscription_id, b.customer_id, b.plan, b.plan_status, b.period_end, g.overrides
                     FROM billing_subscriptions b JOIN org_grants g ON g.external_ref = b.subscription_id
                    WHERE g.id = ?1 AND g.source = 'billing') AS s
            WHERE orgs.id = ?2`, grantId, orgId);

/** BILLING: an UNUSED paid grant follows its subscription — its plan, and the seats it pays for (its
 *  overrides) — while the buyer has not named their organization yet. A used, revoked or hand-made
 *  grant is left alone. */
export async function setPaidGrantPlan(p: PlatformContext, externalRef: string, plan: PlanId, overrides: PlanOverrides = {}): Promise<boolean> {
  const json = JSON.stringify(overrides);
  const res = await batch(p, [stmt(p, `UPDATE org_grants SET plan = ?1, overrides = ?3
    WHERE external_ref = ?2 AND source = 'billing' AND status = 'unused' AND (plan <> ?1 OR overrides <> ?3)`, plan, externalRef, json)]);
  return (res[0].meta.changes ?? 0) > 0;
}

/** The failure `consumeStmt` causes on purpose: the named CHECK on `org_grants.status` (0044_plans). */
const GRANT_SPENT = /CHECK constraint failed: org_grant_usable/i;
const noGrant = (): OrgError => new OrgError("no_grant", "you can create an organization once Trov has granted you one");

/**
 * `POST /api/orgs`: create an org of one's own by USING a grant — `input.grant` (its id) or, when none
 * is named, the oldest usable one. The caller becomes its owner; the org takes the grant's plan,
 * overrides and source; the grant is consumed in the SAME batch (`consumeStmt`). Refused with 403
 * `no_grant` for a person with no usable grant, for a grant that is not theirs, and for a superadmin.
 */
export async function createOrgFromGrant(p: PlatformContext, handle: string, input: { slug: string; name: string; grant?: unknown }): Promise<OrgRow> {
  const mine = await usableGrants(p, handle);
  const wanted = input.grant === undefined || input.grant === null ? mine[0] : mine.find((g) => g.id === input.grant);
  if (!wanted) throw noGrant();
  const row = (await first<{ plan: string; overrides: string; source: string }>(p, `SELECT plan, overrides, source FROM org_grants WHERE id = ?`, wanted.id))!;
  try {
    // Awaited, not returned: workerd reports a refusal thrown before the caller's handler attaches as unhandled.
    return await createOrg(p, {
      slug: input.slug, name: input.name, owner: handle,
      plan: { id: planDef(row.plan).id, overrides: storedOverrides(row.overrides), source: row.source === "billing" ? "billing" : "granted" },
      extra: (orgId, at) => [
        consumeStmt(p, wanted.id, handle, orgId, at),
        stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, 'grant.use', ?, ?, ?)`,
          orgId, p.actor, `grant:${wanted.id}`, JSON.stringify({ plan: wanted.plan }), at),
        linkPaidOrgStmt(p, wanted.id, orgId),
      ],
    });
  } catch (e) {
    if (GRANT_SPENT.test(e instanceof Error ? e.message : String(e))) throw noGrant(); // the grant went while the form was open
    throw e;
  }
}
