// Billing's own rows (0045_billing): the event ledger, the checkouts Trov started, and the mirror of each
// Stripe subscription. Platform surface only — a purchase happens before any org exists. No Stripe call
// and no key here; the org's PLAN is never written from this file (that is the seam's, src/plans/billing.ts).
import { type PlatformContext, first, all, run, nowIso } from "../data/platform-sql";
import { planDef, PLAN_STATUSES, type PlanId, type PlanStatus } from "@shared/plans";
import { isBillingInterval, orgBillingHref, stripeCustomerUrl, type BillingInterval, type BillingManagedOrg, type PlatformOrgBilling } from "@shared/billing";

// ── the event ledger ─────────────────────────────────────────────────────────

/**
 * Record a verified event's id. `new` = first sight; `retry` = seen, but its handler never finished
 * (Stripe is re-delivering after a failure) — run it again; `done` = already handled: acknowledge and
 * do nothing.
 */
export async function claimEvent(p: PlatformContext, e: { id: string; type: string; livemode: boolean }): Promise<"new" | "retry" | "done"> {
  const res = await run(p, `INSERT OR IGNORE INTO billing_events (event_id, type, livemode, received_at) VALUES (?, ?, ?, ?)`, e.id, e.type, e.livemode ? 1 : 0, nowIso());
  if ((res.meta.changes ?? 0) > 0) return "new";
  const row = await first<{ processed_at: string | null }>(p, `SELECT processed_at FROM billing_events WHERE event_id = ?`, e.id);
  return row?.processed_at ? "done" : "retry";
}
export async function finishEvent(p: PlatformContext, id: string, outcome: string): Promise<void> {
  await run(p, `UPDATE billing_events SET processed_at = ?, outcome = ? WHERE event_id = ?`, nowIso(), outcome.slice(0, 64), id);
}
/** The daily cron: handled events past Stripe's own retry horizon (it retries for three days) are dropped. */
export const EVENT_RETENTION_DAYS = 90;
export async function pruneEvents(p: PlatformContext, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  return (await run(p, `DELETE FROM billing_events WHERE received_at < ? AND processed_at IS NOT NULL`, cutoff)).meta.changes ?? 0;
}

// ── checkouts ────────────────────────────────────────────────────────────────

export interface CheckoutRow {
  ref: string; person: string; plan: string; interval: string; for_org: string | null;
  session_id: string | null; subscription_id: string | null; created_at: string; completed_at: string | null; checked_at: string | null;
}
const CHECKOUT_COLS = `ref, person, plan, interval, for_org, session_id, subscription_id, created_at, completed_at, checked_at`;

export async function createCheckout(p: PlatformContext, o: { ref: string; person: string; plan: PlanId; interval: BillingInterval; forOrg?: string | null }): Promise<void> {
  await run(p, `INSERT INTO billing_checkouts (ref, person, plan, interval, for_org, created_at) VALUES (?, ?, ?, ?, ?, ?)`, o.ref, o.person, o.plan, o.interval, o.forOrg ?? null, nowIso());
}
export async function setCheckoutSession(p: PlatformContext, ref: string, sessionId: string): Promise<void> {
  await run(p, `UPDATE billing_checkouts SET session_id = ? WHERE ref = ? AND session_id IS NULL`, sessionId, ref);
}
/** A checkout Stripe never answered for is not kept. */
export async function dropCheckout(p: PlatformContext, ref: string): Promise<void> {
  await run(p, `DELETE FROM billing_checkouts WHERE ref = ? AND session_id IS NULL`, ref);
}
export const checkoutBySession = (p: PlatformContext, sessionId: string): Promise<CheckoutRow | null> =>
  first<CheckoutRow>(p, `SELECT ${CHECKOUT_COLS} FROM billing_checkouts WHERE session_id = ?`, sessionId);
export async function completeCheckout(p: PlatformContext, ref: string, subscriptionId: string): Promise<void> {
  await run(p, `UPDATE billing_checkouts SET subscription_id = ?, completed_at = COALESCE(completed_at, ?) WHERE ref = ?`, subscriptionId, nowIso(), ref);
}
/** The waiting room may look at Stripe for one session at most once per `everyMs`: true = this caller's turn. */
export async function takeCheckoutLook(p: PlatformContext, ref: string, everyMs: number, now: number = Date.now()): Promise<boolean> {
  const res = await run(p, `UPDATE billing_checkouts SET checked_at = ?1 WHERE ref = ?2 AND (checked_at IS NULL OR checked_at <= ?3)`,
    new Date(now).toISOString(), ref, new Date(now - everyMs).toISOString());
  return (res.meta.changes ?? 0) > 0;
}

// ── subscriptions ────────────────────────────────────────────────────────────

export interface SubscriptionRow {
  subscription_id: string; customer_id: string; person: string | null; plan: string; price_id: string | null; interval: string | null;
  stripe_status: string; plan_status: string; period_end: string | null; cancel_at_period_end: number; livemode: number; plan_pinned: number;
  /** The seats paid for (0047_billing_seats); null = not known. */
  quantity: number | null;
  created_at: string; updated_at: string;
}
const SUB_COLS = `subscription_id, customer_id, person, plan, price_id, interval, stripe_status, plan_status, period_end, cancel_at_period_end, livemode, plan_pinned, quantity, created_at, updated_at`;

export const getSubscription = (p: PlatformContext, id: string): Promise<SubscriptionRow | null> =>
  first<SubscriptionRow>(p, `SELECT ${SUB_COLS} FROM billing_subscriptions WHERE subscription_id = ?`, id);

export interface SubscriptionWrite {
  subscription_id: string; customer_id: string; person: string | null; plan: PlanId; price_id: string | null; interval: BillingInterval | null;
  stripe_status: string; plan_status: PlanStatus; period_end: string | null; cancel_at_period_end: boolean; livemode: boolean;
  quantity: number | null;
}
/** Write Stripe's current state of one subscription. The buyer, once known, and the pin are kept. */
export async function putSubscription(p: PlatformContext, s: SubscriptionWrite): Promise<void> {
  const at = nowIso();
  await run(p,
    `INSERT INTO billing_subscriptions (subscription_id, customer_id, person, plan, price_id, interval, stripe_status, plan_status, period_end, cancel_at_period_end, livemode, quantity, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?13, ?12, ?12)
     ON CONFLICT(subscription_id) DO UPDATE SET customer_id = excluded.customer_id, person = COALESCE(billing_subscriptions.person, excluded.person),
       plan = excluded.plan, price_id = excluded.price_id, interval = excluded.interval, stripe_status = excluded.stripe_status,
       plan_status = excluded.plan_status, period_end = excluded.period_end, cancel_at_period_end = excluded.cancel_at_period_end,
       livemode = excluded.livemode, quantity = excluded.quantity, updated_at = excluded.updated_at`,
    s.subscription_id, s.customer_id, s.person, s.plan, s.price_id, s.interval, s.stripe_status, s.plan_status, s.period_end, s.cancel_at_period_end ? 1 : 0, s.livemode ? 1 : 0, at, s.quantity);
}
export async function setPlanPinned(p: PlatformContext, subscriptionId: string, pinned: boolean): Promise<void> {
  await run(p, `UPDATE billing_subscriptions SET plan_pinned = ?, updated_at = ? WHERE subscription_id = ?`, pinned ? 1 : 0, nowIso(), subscriptionId);
}

// ── the org a subscription pays for ──────────────────────────────────────────

export interface BilledOrg { id: string; slug: string; name: string; plan_source: string | null }
export const orgOfSubscription = (p: PlatformContext, subscriptionId: string): Promise<BilledOrg | null> =>
  first<BilledOrg>(p, `SELECT id, slug, name, plan_source FROM orgs WHERE billing_subscription_id = ?`, subscriptionId);
export const orgById = (p: PlatformContext, id: string): Promise<BilledOrg | null> =>
  first<BilledOrg>(p, `SELECT id, slug, name, plan_source FROM orgs WHERE id = ?`, id);

/** The grant a payment made, by the subscription it is for (`org_grants.external_ref`), with the org it became. */
export interface PaidGrant { id: number; plan: string; status: "unused" | "used" | "revoked"; org_slug: string | null; org_name: string | null }
export const grantOfSubscription = (p: PlatformContext, subscriptionId: string): Promise<PaidGrant | null> =>
  first<PaidGrant>(p, `SELECT g.id, g.plan, g.status, o.slug AS org_slug, o.name AS org_name FROM org_grants g LEFT JOIN orgs o ON o.id = g.used_org WHERE g.external_ref = ?`, subscriptionId);

const asStatus = (v: string): PlanStatus => ((PLAN_STATUSES as readonly string[]).includes(v) ? (v as PlanStatus) : "active");

/** The subscription behind an org that pays through Stripe, or null (a granted org; a paid one whose mirror is gone). */
export async function orgSubscription(p: PlatformContext, orgId: string): Promise<SubscriptionRow | null> {
  return first<SubscriptionRow>(p,
    `SELECT ${SUB_COLS.split(", ").map((c) => `s.${c}`).join(", ")} FROM orgs o JOIN billing_subscriptions s ON s.subscription_id = o.billing_subscription_id
      WHERE o.id = ? AND o.plan_source = 'billing'`, orgId);
}

const platformBilling = (s: SubscriptionRow): PlatformOrgBilling => ({
  customer_id: s.customer_id, subscription_id: s.subscription_id, stripe_status: s.stripe_status, plan: planDef(s.plan).id, ended: s.plan_status === "canceled", seats: s.quantity,
  interval: isBillingInterval(s.interval) ? s.interval : null, period_end: s.period_end, cancel_at_period_end: s.cancel_at_period_end === 1,
  pinned: s.plan_pinned === 1, livemode: s.livemode === 1, dashboard_url: stripeCustomerUrl(s.customer_id, s.livemode === 1),
});

/** Platform: the subscription of every paid org, by slug — one query for the whole list. */
export async function platformBillingBySlug(p: PlatformContext, slug?: string): Promise<Map<string, PlatformOrgBilling>> {
  const rows = await all<SubscriptionRow & { slug: string }>(p,
    `SELECT o.slug, ${SUB_COLS.split(", ").map((c) => `s.${c}`).join(", ")} FROM orgs o JOIN billing_subscriptions s ON s.subscription_id = o.billing_subscription_id
      WHERE o.plan_source = 'billing'${slug === undefined ? "" : " AND o.slug = ?"}`, ...(slug === undefined ? [] : [slug]));
  return new Map(rows.map((r) => [r.slug, platformBilling(r)]));
}

/** The organizations `handle` OWNS that pay through Stripe, oldest first — where "Manage billing" goes. */
export async function managedOrgs(p: PlatformContext, handle: string): Promise<BillingManagedOrg[]> {
  const rows = await all<{ slug: string; name: string; plan: string; plan_status: string }>(p,
    `SELECT o.slug, o.name, o.plan, o.plan_status FROM memberships m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? COLLATE NOCASE AND m.role = 'owner' AND o.suspended_at IS NULL AND o.plan_source = 'billing' AND o.billing_subscription_id IS NOT NULL
      ORDER BY o.created_at ASC`, handle);
  return rows.map((r) => ({ slug: r.slug, name: r.name, plan: planDef(r.plan).id, status: asStatus(r.plan_status), href: orgBillingHref(r.slug) }));
}
