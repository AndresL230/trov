// GIFTS (0048_plan_gifts, docs/architecture/plans.md › Gifts): a plan given for free UNTIL A DATE. A
// superadmin puts an org on Pro or Enterprise with an end (`orgs.plan_gift_until`); when the end passes
// the org moves to Free by itself — nothing deleted, nobody removed, the over-limit rule and nothing else
// (shared/plans.ts `planRefusal`). A grant can carry the same thing as a length (`org_grants.gift_days`):
// the clock starts when the grantee creates the organization.
//
//   give     `giftOrgPlan`     — `setOrgPlan` with `gift_until` (audited `plan.gift`)
//   extend   `extendOrgGift`   — moves the end, the plan untouched (audited `plan.gift`)
//   end now  `endOrgGift`      — to Free at once (audited `plan.gift_end`, reason `ended`)
//   expire   `expireGifts`     — the cron: every lapsed gift to Free (audited `plan.gift_end`, reason `expired`)
//
// A gift is only ever an org's that does NOT pay through Stripe. Any other plan write clears it
// (`setOrgPlan` without `gift_until`): a plan a superadmin sets by hand has no end, and an owner who
// starts paying before the end (`POST /api/o/:slug/billing/upgrade`) keeps the paid plan.
//
// Ending a gift writes what `moveOrgToFree` writes for a cancelled subscription — Free, active, overrides
// cleared — but as ONE guarded statement per org, so a payment or an extension that lands between the
// cron's read and its write wins: the statement then changes nothing and the org is left alone.
import { type PlatformContext, type Stmt, all, batch, nowIso, stmt } from "../data/platform-sql";
import { FREE_PLAN, GIFT_MAX_DAYS, giftEnd, planDef, type PlanId } from "@shared/plans";
import { PlanError, auditPlan, cleanPlan, orgBySlug, orgPlan, setOrgPlan, type OrgPlan } from "./state";

const DAY_MS = 86_400_000;
const BAD_LENGTH = `a gift's length is { days } (a whole number from 1 to ${GIFT_MAX_DAYS}) or { until } (a date in the future, at most ${GIFT_MAX_DAYS} days away)`;

export interface GiftInput {
  plan: unknown;
  /** As for `setOrgPlan`: omitted = keep the org's overrides when the plan does not change, clear them when it does. */
  overrides?: unknown;
  /** `{ days }` or `{ until }` (shared/plans.ts `giftEnd`). */
  gift: unknown;
}

/**
 * Give `slug` a plan for free until a date — or replace the gift it has (another plan, other limits,
 * another end). The caller has checked the org does not pay through a live subscription. Throws
 * `PlanError`: `invalid_gift` (Free, or a bad length), `invalid_plan`, `invalid_overrides`, `not_found`.
 */
export async function giftOrgPlan(p: PlatformContext, slug: string, input: GiftInput, now: number = Date.now()): Promise<OrgPlan> {
  const plan = cleanPlan(input.plan);
  if (plan === FREE_PLAN) throw new PlanError("invalid_gift", "Free is already free: a gift is for a plan above it");
  const until = giftEnd(input.gift, now);
  if (!until) throw new PlanError("invalid_gift", BAD_LENGTH);
  return setOrgPlan(p, slug, { plan, overrides: input.overrides, gift_until: until });
}

/** An audit row written only when the statement before it in the batch changed a row. */
const auditIfChanged = (p: PlatformContext, orgId: string, action: "plan.gift" | "plan.gift_end", slug: string, detail: Record<string, unknown>, at: string): Stmt =>
  stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0`,
    orgId, p.actor, action, slug, JSON.stringify(detail), at);

/**
 * Move a gift's end: `{ days }` are added to the CURRENT end, `{ until }` sets it outright (earlier is
 * allowed — it is still in the future). The plan and its limits are untouched. `not_gifted` (409) for an
 * org that holds no gift; `invalid_gift` for a bad length.
 */
export async function extendOrgGift(p: PlatformContext, slug: string, length: unknown, now: number = Date.now()): Promise<OrgPlan> {
  const org = await orgBySlug(p, slug);
  const before = await orgPlan(p, org.id);
  if (!before.gift_until || before.source === "billing") throw new PlanError("not_gifted", "this organization's plan is not a gift");
  const until = giftEnd(length, now, Date.parse(before.gift_until));
  if (!until) throw new PlanError("invalid_gift", BAD_LENGTH);
  const at = nowIso();
  // Compare-and-set on the end it was read with: of two extensions at once, one lands.
  const [res] = await batch(p, [
    stmt(p, `UPDATE orgs SET plan_gift_until = ?1, plan_changed_at = ?2, plan_changed_by = ?3 WHERE id = ?4 AND plan_gift_until = ?5`, until, at, p.actor, org.id, before.gift_until),
    auditIfChanged(p, org.id, "plan.gift", org.slug, { to: before.plan, until, extended_from: before.gift_until }, at),
  ]);
  if ((res.meta.changes ?? 0) === 0) throw new PlanError("not_gifted", "this organization's gift changed while you were extending it");
  return orgPlan(p, org.id);
}

/**
 * The statements that END one org's gift. `cutoff` = only if the end has passed by then (the cron);
 * null = whatever its end (End now).
 *   1–2  an org that does not pay: to Free (what `moveOrgToFree` writes), the gift cleared, audited;
 *   3–4  an org that pays through Stripe: the gift is only cleared — its paid plan is left alone.
 * Every statement is by the org's id and guarded on the gift still being there, so running it twice, or
 * after the gift was extended or the plan changed, writes nothing.
 */
function endStmts(p: PlatformContext, org: { id: string; slug: string; plan: PlanId; gift_until: string }, at: string, reason: "expired" | "ended", cutoff: string | null): Stmt[] {
  const due = cutoff === null ? `plan_gift_until IS NOT NULL` : `plan_gift_until IS NOT NULL AND plan_gift_until <= ?`;
  const bound = cutoff === null ? [] : [cutoff];
  return [
    stmt(p, `UPDATE orgs SET plan = '${FREE_PLAN}', plan_overrides = '{}', plan_status = 'active', plan_source = 'granted',
                    plan_changed_at = ?, plan_changed_by = ?, plan_gift_until = NULL
              WHERE id = ? AND COALESCE(plan_source, '') <> 'billing' AND ${due}`, at, p.actor, org.id, ...bound),
    auditIfChanged(p, org.id, "plan.gift_end", org.slug, { from: org.plan, to: FREE_PLAN, until: org.gift_until, reason }, at),
    stmt(p, `UPDATE orgs SET plan_gift_until = NULL WHERE id = ? AND plan_source = 'billing' AND ${due}`, org.id, ...bound),
    auditIfChanged(p, org.id, "plan.gift_end", org.slug, { kept: org.plan, until: org.gift_until, reason: "paid" }, at),
  ];
}

/** End a gift NOW: the org moves to Free at once, as it would have at the gift's end. Nothing is deleted.
 *  `not_gifted` (409) for an org that holds none. */
export async function endOrgGift(p: PlatformContext, slug: string): Promise<OrgPlan> {
  const org = await orgBySlug(p, slug);
  const before = await orgPlan(p, org.id);
  if (!before.gift_until) throw new PlanError("not_gifted", "this organization's plan is not a gift");
  const res = await batch(p, endStmts(p, { ...org, plan: before.plan, gift_until: before.gift_until }, nowIso(), "ended", null));
  if ((res[0].meta.changes ?? 0) + (res[2].meta.changes ?? 0) === 0) throw new PlanError("not_gifted", "this organization's plan is not a gift");
  return orgPlan(p, org.id);
}

export interface GiftSweep {
  /** Orgs whose gift had lapsed and that moved to Free. */
  expired: number;
  /** Orgs that pay through Stripe: the lapsed gift was cleared, the paid plan left alone. */
  cleared: number;
  /** Orgs whose statement failed; the next tick tries them again. */
  failed: number;
}

/**
 * THE EXPIRY, run by the repo cron's every tick (src/repo/cron.ts): every org whose gift has ended by
 * `now` moves to Free. One read across orgs (ids and plan state — no content), then one guarded batch
 * PER ORG, each bound to that org. Idempotent — a second run, a late run, or two runs at once find
 * nothing left to do — and it never throws: a failure is counted and the next tick tries again.
 * `p.actor` (`system`) is what the audit rows and `plan_changed_by` record.
 */
export async function expireGifts(p: PlatformContext, now: number): Promise<GiftSweep> {
  const out: GiftSweep = { expired: 0, cleared: 0, failed: 0 };
  const cutoff = new Date(now).toISOString();
  let due: { id: string; slug: string; plan: string; plan_gift_until: string }[];
  try {
    due = await all(p, `SELECT id, slug, plan, plan_gift_until FROM orgs WHERE plan_gift_until IS NOT NULL AND plan_gift_until <= ? ORDER BY plan_gift_until LIMIT 500`, cutoff);
  } catch {
    return { ...out, failed: 1 };
  }
  for (const o of due) {
    try {
      const res = await batch(p, endStmts(p, { id: o.id, slug: o.slug, plan: planDef(o.plan).id, gift_until: o.plan_gift_until }, nowIso(), "expired", cutoff));
      out.expired += res[0].meta.changes ?? 0;
      out.cleared += res[2].meta.changes ?? 0;
    } catch {
      out.failed += 1;
    }
  }
  return out;
}

/**
 * A gifted GRANT becoming an org (./grants.ts `createOrgFromGrant`): statements of the batch that creates
 * it. The clock starts at `at`, the org's creation; the end is `days` later.
 */
export function grantGiftStmts(p: PlatformContext, o: { orgId: string; slug: string; plan: PlanId; days: number; by: string; grant: number; at: string }): Stmt[] {
  const until = new Date(Date.parse(o.at) + o.days * DAY_MS).toISOString();
  return [
    stmt(p, `UPDATE orgs SET plan_gift_until = ? WHERE id = ?`, until, o.orgId),
    auditPlan(p, o.orgId, "plan.gift", o.slug, { to: o.plan, until, days: o.days, grant: o.grant, by: o.by }, o.at),
  ];
}
