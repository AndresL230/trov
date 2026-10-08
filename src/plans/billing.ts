// THE SEAM FOR BILLING (docs/architecture/plans.md › The billing seam). Everything a payment integration
// calls to change who may create an org and what plan an org is on — with no superadmin in the loop and
// no change to the plan, grant or enforcement code. Stripe's is src/billing/ (docs/architecture/billing.md):
// its webhook has no session, makes its context with `platform(env, BILLING_ACTOR)`, and calls only these.
//
//   A payment succeeded for plan X by person Y, who has NO org yet
//       → `grantOrganization(env, p, { to, plan, external_ref })`. Y sees "You can set up an organization
//         — <Plan>", names it, and owns it. Idempotent on `external_ref` (the Stripe subscription id).
//   …when Y uses it, `createOrgFromGrant` links the org to the subscription in the creating batch
//     (./grants.ts `linkPaidOrgStmt`); from then on, and for a renewal of an org that already exists
//       → `setOrgPlan(p, slug, { plan, source: "billing", status, period_end, customer_id, subscription_id })`.
//   A renewal failed            → `markOrgPastDue(p, slug)`     (nothing is enforced differently)
//   The subscription ended      → `moveOrgToFree(p, slug)`      (Free; nothing deleted, what is over a limit waits)
//   It was paid again           → `setOrgPlanStatus(p, slug, "active", { period_end })`
//   Y changed plan or seats before use → `setPaidGrantPlan(p, external_ref, plan, { seats })`
//   It ended before Y used it   → `revokeGrant(p, id)`
import type { Env } from "../env";
import type { PlatformContext } from "../data/platform-sql";
import type { GrantTarget, PlanId, PlanOverrides, PlatformGrant } from "@shared/plans";
import { createGrant, getGrant, mailGrant } from "./grants";

export { setOrgPlan, setOrgPlanStatus, markOrgPastDue, cancelOrgPlan, moveOrgToFree, orgPlan, type SetOrgPlanInput, type OrgPlan } from "./state";
export { getGrant, revokeGrant, setPaidGrantPlan, GrantError } from "./grants";

/** The `p.actor` a billing integration acts as — what `granted_by`, `plan_changed_by` and the audit trail record. */
export const BILLING_ACTOR = "billing";

export interface BillingGrantInput {
  /** Who paid: `{ email }` (matched to a provider-VERIFIED address at sign-in), `{ github_login }`, or `{ handle }` of an existing person. */
  to: GrantTarget;
  plan: PlanId;
  /** Per-org limits on top of the plan's (an Enterprise deal). */
  overrides?: PlanOverrides;
  note?: string;
  /** Days until an unused grant lapses (1–365); omitted = never. */
  expires_in_days?: number;
  /** The payment's own id at the provider. REQUIRED in practice: it is what makes a re-delivered event a no-op. */
  external_ref?: string;
  /** The absolute origin for the notice's one link (the site root). Omitted = no notice is mailed. */
  origin?: string;
}

/**
 * "A payment succeeded for `plan` by `to`" → a grant: the right to set up ONE organization on that plan.
 * No superadmin, no session. The grantee need not have an account; an e-mail grant is mailed the notice
 * when `origin` is given (never to a handle or a GitHub login — there is no address). Calling it again
 * with the same `external_ref` returns the first grant and neither writes nor mails. Throws `GrantError`
 * (`invalid_grant`, `no_such_person`) on a bad input. Audited as `grant.create` by `p.actor`.
 */
export async function grantOrganization(env: Env, p: PlatformContext, input: BillingGrantInput): Promise<PlatformGrant> {
  const grant = await createGrant(p, input, { source: "billing", external_ref: input.external_ref ?? null });
  // `mail_status` is null only on the call that wrote the grant: a replay finds the first outcome and stays quiet.
  if (input.origin && grant.status === "unused" && grant.mail_status === null) {
    await mailGrant(env, p, grant, input.origin);
    return (await getGrant(p, grant.id)) ?? grant;
  }
  return grant;
}
