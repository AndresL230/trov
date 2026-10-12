// Deleting an ORGANIZATION — the one core every caller uses: its owner in Org settings (src/orgs/routes.ts),
// a superadmin in Platform (src/platform/routes.ts), and an account's deletion for an organization nobody
// else is in (./person.ts). What it removes and keeps, and why: docs/architecture/organizations.md › What
// deletion removes and what it keeps.
//
// In order — and nothing is deleted unless every step before the batch succeeded:
//   1. BILLING. Anything that could still charge for this org is ended at Stripe first: an open Checkout
//      Session for it is expired, and every subscription that pays for it is cancelled NOW (no refund for
//      the period already paid — the owner's policy). A Stripe failure refuses the whole deletion
//      (`billing_failed`, 502): nothing is deleted. A live subscription on a deployment with no Stripe keys
//      is refused too (`billing_unavailable`, 503).
//   2. ONE D1 batch (one transaction, foreign keys deferred): every row with this org's `org_id` (./tables.ts —
//      a test holds that list to the schema), the global rows that point at the org (its billing mirror and
//      checkouts, the grant it was made from, support reports sent from it), the `orgs` row, and ONE
//      `org.delete` row in the platform's audit trail. All of it lands, or none of it.
//   3. R2, after the commit: each object only the org pointed at (./r2.ts). A failure orphans bytes; it can
//      never leave a row pointing at bytes that are gone.
//
// A Stripe webhook that arrives afterwards finds no row for the subscription (`unknown_subscription`) or the
// checkout (`unknown_checkout`) and changes nothing: no org, grant or plan comes back.
import type { Env } from "../env";
import { type PlatformContext, type Stmt, all, first, stmt, batch, ph, nowIso } from "../data/platform-sql";
import { systemTenant } from "../data/context";
import { billingConfig } from "../billing/config";
import { cancelSubscriptionNow, expireCheckoutNow, subscriptionEnded } from "../billing/cancel";
import { StripeError } from "../billing/stripe";
import { seatCounts } from "../plans/state";
import type { AccountBlocker, DeletionBy, DeletionErrorCode, OrgDeletionPreview } from "@shared/deletion-core";
import { orgObjectRefs, orgRepoCount, orgRowDeletes } from "./tables";
import { artifactShas, sweepR2, type R2Sweep } from "./r2";

export class DeletionError extends Error {
  constructor(readonly code: DeletionErrorCode, message: string, readonly blockers?: AccountBlocker[]) {
    super(message);
    this.name = "DeletionError";
  }
}
export const DELETION_ERROR_STATUS: Record<DeletionErrorCode, 400 | 403 | 404 | 409 | 502 | 503> = {
  confirm_mismatch: 400, blocked: 409, forbidden: 403, not_found: 404, billing_failed: 502, billing_unavailable: 503,
};

/** A route's answer for a `DeletionError` — `{ error, message, blockers? }` with its status — or null for
 *  anything else (which the route rethrows: a real 500). */
export function deletionRefusal(e: unknown): { status: 400 | 403 | 404 | 409 | 502 | 503; body: { error: DeletionErrorCode; message: string; blockers?: AccountBlocker[] } } | null {
  if (!(e instanceof DeletionError)) return null;
  return { status: DELETION_ERROR_STATUS[e.code], body: { error: e.code, message: e.message, ...(e.blockers ? { blockers: e.blockers } : {}) } };
}

/** What a typed confirmation that does not match is answered. */
export const confirmMismatch = (what: "handle" | "slug"): { error: "confirm_mismatch"; message: string } =>
  ({ error: "confirm_mismatch", message: what === "handle" ? "Type the handle exactly to confirm. Nothing was deleted." : "Type the organization's slug exactly to confirm. Nothing was deleted." });

export interface OrgToDelete {
  id: string; slug: string; name: string; logo_sha: string | null;
  plan_source: string | null; billing_customer_id: string | null; billing_subscription_id: string | null;
}
const ORG_COLS = `id, slug, name, logo_sha, plan_source, billing_customer_id, billing_subscription_id`;
export const orgForDeletion = (p: PlatformContext, by: { id: string } | { slug: string }): Promise<OrgToDelete | null> =>
  "id" in by
    ? first<OrgToDelete>(p, `SELECT ${ORG_COLS} FROM orgs WHERE id = ?`, by.id)
    : first<OrgToDelete>(p, `SELECT ${ORG_COLS} FROM orgs WHERE slug = ?`, by.slug);

// ── billing: what could still charge for this org ────────────────────────────

interface OrgSubscription { id: string; live: boolean; customer: string | null; period_end: string | null; cancel_at_period_end: boolean }

/** Every Stripe subscription Trov knows paid for this org: the one on the org, an upgrade's, and the purchase
 *  its grant came from. `live` = it may still charge (Stripe's own status is not an ended one, or Trov has
 *  no mirror row to say so — then Stripe is asked). */
export async function orgSubscriptions(p: PlatformContext, org: OrgToDelete): Promise<OrgSubscription[]> {
  const ids = new Set<string>();
  if (org.billing_subscription_id) ids.add(org.billing_subscription_id);
  const linked = await all<{ id: string }>(p,
    `SELECT subscription_id AS id FROM billing_checkouts WHERE for_org = ?1 AND subscription_id IS NOT NULL
      UNION SELECT external_ref AS id FROM org_grants WHERE used_org = ?1 AND external_ref IS NOT NULL`, org.id);
  for (const r of linked) ids.add(r.id);
  if (!ids.size) return [];
  const mirror = await all<{ subscription_id: string; customer_id: string; stripe_status: string; period_end: string | null; cancel_at_period_end: number }>(p,
    `SELECT subscription_id, customer_id, stripe_status, period_end, cancel_at_period_end FROM billing_subscriptions WHERE subscription_id IN (${ph(ids.size)})`, ...ids);
  return [...ids].map((id) => {
    const m = mirror.find((r) => r.subscription_id === id);
    return { id, live: !m || !subscriptionEnded(m.stripe_status), customer: m?.customer_id ?? null, period_end: m?.period_end ?? null, cancel_at_period_end: m?.cancel_at_period_end === 1 };
  });
}

/** Checkout Sessions still open (Stripe's last 24 hours) that would pay for something being deleted. */
export async function openCheckouts(p: PlatformContext, where: { forOrg: string } | { person: string }, now = Date.now()): Promise<string[]> {
  const since = new Date(now - 25 * 3_600_000).toISOString();
  const rows = "forOrg" in where
    ? await all<{ session_id: string }>(p, `SELECT session_id FROM billing_checkouts WHERE for_org = ? AND subscription_id IS NULL AND session_id IS NOT NULL AND created_at > ?`, where.forOrg, since)
    : await all<{ session_id: string }>(p, `SELECT session_id FROM billing_checkouts WHERE person = ? COLLATE NOCASE AND subscription_id IS NULL AND session_id IS NOT NULL AND created_at > ?`, where.person, since);
  return rows.map((r) => r.session_id);
}

const STRIPE_FAILED = "Trov couldn't reach Stripe to cancel the subscription, so nothing was deleted. Try again in a minute; if it keeps failing, cancel the plan in Manage billing first, or contact us.";
const STRIPE_OFF = "This organization has a paid subscription, and Stripe isn't set up on this deployment to cancel it, so nothing was deleted. Contact us.";

/**
 * End at Stripe everything in `subscriptions` and `checkouts` — the step every deletion takes BEFORE it
 * deletes anything. Throws `DeletionError` (`billing_failed` / `billing_unavailable`) and deletes nothing.
 * Returns the subscriptions it ended (for the audit row).
 */
export async function endAtStripe(env: Env, subscriptions: string[], checkouts: string[], fetchImpl?: typeof fetch): Promise<string[]> {
  if (!subscriptions.length && !checkouts.length) return [];
  const cfg = billingConfig(env);
  if (!cfg) {
    if (subscriptions.length) throw new DeletionError("billing_unavailable", STRIPE_OFF);
    return []; // an open checkout on a deployment that no longer sells: nothing it pays could be fulfilled
  }
  const ended = new Set<string>(subscriptions);
  try {
    for (const session of checkouts) {
      const paid = await expireCheckoutNow(cfg, session, fetchImpl);
      if (paid.subscription) ended.add(paid.subscription);
    }
    for (const id of ended) await cancelSubscriptionNow(cfg, id, fetchImpl);
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    console.error("deletion: stripe failed", `${e.kind} ${e.status} ${e.message}`);
    throw new DeletionError("billing_failed", STRIPE_FAILED);
  }
  return [...ended];
}

// ── preview ──────────────────────────────────────────────────────────────────

/** What deleting `org` would do — counts and the subscription, never its content. */
export async function orgDeletionPreview(env: Env, p: PlatformContext, org: OrgToDelete): Promise<OrgDeletionPreview> {
  const [seats, repositories, subs] = await Promise.all([
    seatCounts(p, org.id), orgRepoCount(systemTenant(p, org.id, "system")), orgSubscriptions(p, org),
  ]);
  const live = subs.find((s) => s.live) ?? null;
  return {
    org: { slug: org.slug, name: org.name }, members: seats.members, pending_invites: seats.pending, repositories,
    subscription: live ? { period_end: live.period_end, cancel_at_period_end: live.cancel_at_period_end } : null,
    billing_ready: !live || billingConfig(env) !== null,
    confirm: org.slug,
  };
}

// ── delete ───────────────────────────────────────────────────────────────────

export interface DeleteOrgOpts {
  by: DeletionBy;
  /** Who is recorded in the audit row: the owner's handle, or the superadmin's. */
  actor: string;
  fetchImpl?: typeof fetch;
  /** The caller has already ended this org's billing at Stripe (an account's deletion does it for every org
   *  it deletes before it deletes any): skip step 1. */
  billingSettled?: boolean;
  /** Called by an account's deletion: the audit row says so. */
  withAccount?: boolean;
}
export interface DeletedOrg { slug: string; cancelled: string[]; r2: R2Sweep }

/** Step 1 alone, for a caller that deletes several things and must not start until all of them are paid off. */
export async function settleOrgBilling(env: Env, p: PlatformContext, org: OrgToDelete, fetchImpl?: typeof fetch): Promise<string[]> {
  const subs = (await orgSubscriptions(p, org)).filter((s) => s.live).map((s) => s.id);
  const checkouts = await openCheckouts(p, { forOrg: org.id });
  return await endAtStripe(env, subs, checkouts, fetchImpl); // awaited HERE: a refusal is never a promise in flight with no handler
}

export async function deleteOrganization(env: Env, p: PlatformContext, org: OrgToDelete, o: DeleteOrgOpts): Promise<DeletedOrg> {
  const cancelled = o.billingSettled ? [] : await settleOrgBilling(env, p, org, o.fetchImpl);
  const sys = systemTenant(p, org.id, "system");
  const [refs, seats, subs] = await Promise.all([orgObjectRefs(sys), seatCounts(p, org.id), orgSubscriptions(p, org)]);
  const subIds = subs.map((s) => s.id);
  const at = nowIso();
  const stripe = org.billing_customer_id || subIds.length ? { customer: org.billing_customer_id, subscriptions: subIds, cancelled } : undefined;
  const stmts: Stmt[] = [
    stmt(p, "PRAGMA defer_foreign_keys = true"),
    ...orgRowDeletes(sys),
    // The global rows that point at the org. Its billing mirror and checkouts go (Stripe keeps the customer,
    // the invoices and the payments); a checkout still OPEN was expired at Stripe in step 1.
    stmt(p, `DELETE FROM billing_checkouts WHERE for_org = ?${subIds.length ? ` OR subscription_id IN (${ph(subIds.length)})` : ""}`, org.id, ...subIds),
    ...(subIds.length ? [stmt(p, `DELETE FROM billing_subscriptions WHERE subscription_id IN (${ph(subIds.length)})`, ...subIds)] : []),
    stmt(p, `DELETE FROM org_grants WHERE used_org = ?`, org.id),
    stmt(p, `DELETE FROM support_reports WHERE from_org = ?`, org.id),
    stmt(p, `DELETE FROM orgs WHERE id = ?`, org.id),
    // The one record that it happened: a platform row (the org is gone), its slug as the reference, and the
    // Stripe ids a refund or a dispute would be looked up by — never its content or its people.
    stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (NULL, ?, 'org.delete', ?, ?, ?)`,
      o.actor, org.slug, JSON.stringify({ by: o.by, members: seats.members, ...(o.withAccount ? { with_account: true } : {}), ...(stripe ? { stripe } : {}) }), at),
  ];
  await batch(p, stmts);
  const r2 = await sweepR2(p, env.ARTIFACTS_BUCKET, {
    artifacts: artifactShas(refs.artifactKeys), docImages: refs.docImages, orgLogos: org.logo_sha ? [org.logo_sha] : [], avatars: [],
  });
  return { slug: org.slug, cancelled, r2 };
}
