// How an org pays, as its members read it — the `billing` part of `GET /api/o/:slug/plan` (shared/billing.ts
// `OrgBillingView`). Trov's own rows only: no Stripe call, no key, no id of Stripe's. Kept apart from
// ./routes.ts so the org surface (src/orgs/routes.ts) can read it without importing the payment routes.
import type { Env } from "../env";
import type { PlatformContext } from "../data/platform-sql";
import { orgPlan } from "../plans/billing";
import { FREE_PLAN } from "@shared/plans";
import { PURCHASABLE_PLANS, type BillingInterval, type OrgBillingView } from "@shared/billing";
import { billingConfig, intervalsOf } from "./config";
import { orgSubscription } from "./store";

/** Null for an org that neither pays through Stripe nor is on Free (a granted one): nothing about payment
 *  is shown. A Free org — never paid, or its subscription ended — gets the view its upgrade needs, and so
 *  does an org whose plan is a GIFT (0048_plan_gifts): its owner may start paying before the gift ends. */
export async function orgBillingView(p: PlatformContext, env: Env, orgId: string): Promise<OrgBillingView | null> {
  const plan = await orgPlan(p, orgId);
  const billed = plan.source === "billing" && !!plan.subscription_id;
  const free = plan.plan === FREE_PLAN;
  const gifted = !billed && !free && plan.gift_until !== null;
  if (!billed && !free && !gifted) return null;
  const cfg = billingConfig(env);
  const held = billed ? await orgSubscription(p, orgId) : null;
  // Ended: the subscription is over (the org moved to Free), or a legacy org frozen as `canceled`.
  const ended = billed && (free || plan.status === "canceled" || held?.plan_status === "canceled");
  const live = billed && !ended;
  const interval: BillingInterval | null = live && (held?.interval === "month" || held?.interval === "year") ? held.interval : null;
  return {
    available: cfg !== null, subscribed: live, ended, customer: billed && !!plan.customer_id, interval,
    seats: live ? plan.overrides.seats ?? null : null,
    cancel_at_period_end: live && held?.cancel_at_period_end === 1, pinned: live && held?.plan_pinned === 1,
    upgrade_to: cfg && !live ? PURCHASABLE_PLANS.filter((id) => intervalsOf(cfg, id).length > 0) : [],
    ...(gifted ? { gifted: true } : {}),
  };
}
