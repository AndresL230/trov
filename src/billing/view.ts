// How an org pays, as its members read it — the `billing` part of `GET /api/o/:slug/plan` (shared/billing.ts
// `OrgBillingView`). Trov's own rows only: no Stripe call, no key, no id of Stripe's. Kept apart from
// ./routes.ts so the org surface (src/orgs/routes.ts) can read it without importing the payment routes.
import type { Env } from "../env";
import type { PlatformContext } from "../data/platform-sql";
import { orgPlan } from "../plans/billing";
import { PURCHASABLE_PLANS, type BillingInterval, type OrgBillingView } from "@shared/billing";
import { billingConfig, intervalsOf, priceFor } from "./config";
import { orgSubscription } from "./store";

/** Null for an org that does not pay through Stripe (a granted one): nothing about payment is shown. */
export async function orgBillingView(p: PlatformContext, env: Env, orgId: string): Promise<OrgBillingView | null> {
  const plan = await orgPlan(p, orgId);
  if (plan.source !== "billing" || !plan.subscription_id) return null;
  const cfg = billingConfig(env);
  const held = await orgSubscription(p, orgId);
  const interval: BillingInterval | null = held?.interval === "month" || held?.interval === "year" ? held.interval : null;
  const live = plan.status !== "canceled";
  return {
    available: cfg !== null, interval, cancel_at_period_end: live && held?.cancel_at_period_end === 1, pinned: held?.plan_pinned === 1,
    // A switch keeps the interval the org pays on; a plan Trov pinned by hand is not the owner's to switch.
    switch_to: cfg && live && held?.plan_pinned !== 1 ? PURCHASABLE_PLANS.filter((id) => id !== plan.plan && priceFor(cfg, id, interval ?? "month") !== null) : [],
    renew_on: cfg && !live ? PURCHASABLE_PLANS.filter((id) => intervalsOf(cfg, id).length > 0) : [],
  };
}
