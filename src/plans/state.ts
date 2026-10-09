// An org's plan, on the PLATFORM surface (docs/architecture/plans.md): reading it, the SEAT gate, and
// the writes that change it — the superadmin's "Change plan" and the functions billing will call.
// `orgs.plan*` (0044_plans) are global columns; `memberships` and `org_invites` are platform-owned, so
// seats are counted here. The limits counted over TENANT tables are in ./gate.ts.
//
// The numbers live in shared/plans.ts. Nothing in this file (or anywhere else) compares a count to a
// cap: `planRefusal` answers, and a refusal travels as a `PlanLimitError` — HTTP 402 with its body
// (src/routes.ts `app.onError`), an MCP tool error with `code: "plan_limit"`.
import { type PlatformContext, type Stmt, first, stmt, batch, nowIso } from "../data/platform-sql";
import {
  planRefusal, resolveEntitlements, storedOverrides, parseOverrides, planDef, isPlanId, PLAN_STATUSES, PLAN_SOURCES, FREE_PLAN,
  type OrgPlanState, type PlanFeatureRefusal, type PlanRefusal, type PlanId, type PlanOverrides, type PlanSource, type PlanStatus, type PlatformOrgPlan,
} from "@shared/plans";
import type { OrgAuditAction } from "@shared/orgs";

/** A plan refused an addition. Thrown by every enforcement point; never caught to be ignored. */
export class PlanLimitError extends Error {
  readonly code = "plan_limit" as const;
  constructor(readonly refusal: PlanRefusal) {
    super(refusal.message);
    this.name = "PlanLimitError";
  }
}
/** The status every plan refusal answers with. 402, not 403: a 403 here means "your ROLE may not" and
 *  an owner can fix that; this one no role in the org can — the plan has to change. Nothing else in the
 *  app answers 402, so a client can branch on the status alone. */
export const PLAN_LIMIT_STATUS = 402;

/** A plan does not include a feature (shared/plans.ts `planFeatureRefusal`). The same 402 as a limit, its
 *  own body; thrown by `requireFeature` (./gate.ts). */
export class PlanFeatureError extends Error {
  readonly code = "plan_feature" as const;
  constructor(readonly refusal: PlanFeatureRefusal) {
    super(refusal.message);
    this.name = "PlanFeatureError";
  }
}

/** Throw when `state` refuses `adding` more of `limit` at `used`. */
export function assertWithinPlan(state: OrgPlanState, limit: Parameters<typeof planRefusal>[1], used: number, adding = 1): void {
  const refusal = planRefusal(state, limit, used, adding);
  if (refusal) throw new PlanLimitError(refusal);
}

export interface OrgPlanRow {
  plan: string; plan_overrides: string; plan_source: string | null; plan_status: string;
  plan_period_end: string | null; billing_customer_id: string | null; billing_subscription_id: string | null;
  plan_gift_until: string | null;
}
export const PLAN_COLS = `plan, plan_overrides, plan_source, plan_status, plan_period_end, billing_customer_id, billing_subscription_id, plan_gift_until`;

export interface OrgPlan extends OrgPlanState {
  source: PlanSource | null;
  period_end: string | null;
  customer_id: string | null;
  subscription_id: string | null;
  /** The plan is a gift that ends at this instant (0048_plan_gifts, ./gifts.ts); null = it is not a gift. */
  gift_until: string | null;
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);

/** A stored row as the state every gate reads. An unknown plan id reads as the smallest plan and an
 *  unknown status as `active` — a bad value can only ever make an org SMALLER, never unlimited. */
export function planOf(r: OrgPlanRow | null): OrgPlan {
  return {
    plan: planDef(r?.plan).id, overrides: storedOverrides(r?.plan_overrides), status: oneOf(PLAN_STATUSES, r?.plan_status) ?? "active",
    source: oneOf(PLAN_SOURCES, r?.plan_source), period_end: r?.plan_period_end ?? null,
    customer_id: r?.billing_customer_id ?? null, subscription_id: r?.billing_subscription_id ?? null,
    gift_until: r?.plan_gift_until ?? null,
  };
}

export async function orgPlan(p: PlatformContext, orgId: string): Promise<OrgPlan> {
  return planOf(await first<OrgPlanRow>(p, `SELECT ${PLAN_COLS} FROM orgs WHERE id = ?`, orgId));
}

// ── seats ────────────────────────────────────────────────────────────────────
// A seat is a MEMBER or a PENDING INVITATION. Two questions, one per way a seat is taken:
//   • `reserve` — a NEW seat: an invitation created, or a person added directly (the superadmin's
//     owner). Counted against members + pending, so ten invitations cannot become an eleventh member.
//   • `accept`  — a pending invitation turning into a member. Its seat was reserved when it was created,
//     so only MEMBERS are counted: it is refused only when the org is already full of members (it was
//     downgraded, or its cap lowered, after the invitation went out).
// The check here is for the sentence; the same condition is IN the INSERT that takes the seat
// (`SEAT_FREE` / `MEMBER_SEAT_FREE`), so two racing requests cannot both take the last one.

export type SeatUse = "reserve" | "accept";

export async function seatCounts(p: PlatformContext, orgId: string): Promise<{ members: number; pending: number }> {
  const r = await first<{ members: number; pending: number }>(p,
    `SELECT (SELECT COUNT(*) FROM memberships WHERE org_id = ?1) AS members,
            (SELECT COUNT(*) FROM org_invites WHERE org_id = ?1 AND status = 'pending') AS pending`, orgId);
  return { members: r?.members ?? 0, pending: r?.pending ?? 0 };
}

/** SQL, true while a NEW seat is free. Binds: (cap, org, org, cap). */
export const SEAT_FREE = `(? IS NULL OR (SELECT COUNT(*) FROM memberships WHERE org_id = ?) + (SELECT COUNT(*) FROM org_invites WHERE org_id = ? AND status = 'pending') < ?)`;
/** SQL, true while the org has room for one more MEMBER. Binds: (cap, org, cap). */
export const MEMBER_SEAT_FREE = `(? IS NULL OR (SELECT COUNT(*) FROM memberships WHERE org_id = ?) < ?)`;

export interface SeatGate {
  /** The seat cap to bind into the guarded INSERT: null = unlimited, 0 = refuse (a canceled plan). */
  cap: number | null;
  /** The refusal to throw when that INSERT wrote nothing (a race took the seat). */
  refuse: () => PlanLimitError;
}

/**
 * May `orgId` take one more seat? Throws the refusal when it may not; otherwise returns the cap for the
 * statement that takes it. `held` = the person already has a seat (a member being lifted to owner, an
 * invitation upgraded): nothing new is taken, so nothing is refused.
 */
export async function seatGate(p: PlatformContext, orgId: string, use: SeatUse, held = false): Promise<SeatGate> {
  const [state, n] = await Promise.all([orgPlan(p, orgId), seatCounts(p, orgId)]);
  const used = use === "reserve" ? n.members + n.pending : n.members;
  const check = () => planRefusal(state, "seats", used);
  const refusal = held ? null : check();
  if (refusal) throw new PlanLimitError(refusal);
  const cap = state.status === "canceled" ? 0 : resolveEntitlements(state.plan, state.overrides).seats;
  return {
    cap: held ? null : cap,
    refuse: () => new PlanLimitError(check() ?? planRefusal(state, "seats", cap ?? used)!),
  };
}

// ── changing a plan (the superadmin today; billing tomorrow) ─────────────────

export type PlanErrorCode = "invalid_plan" | "invalid_overrides" | "invalid_status" | "not_found" | "invalid_gift" | "not_gifted" | "billed";
export const PLAN_ERROR_STATUS: Record<PlanErrorCode, 400 | 404 | 409> = {
  invalid_plan: 400, invalid_overrides: 400, invalid_status: 400, not_found: 404,
  // Gifts (./gifts.ts): a bad length or plan; nothing to extend or end; an org that pays through Stripe.
  invalid_gift: 400, not_gifted: 409, billed: 409,
};
export class PlanError extends Error {
  constructor(readonly code: PlanErrorCode, message?: string) { super(message ?? code); }
}

/** A plan id from input, or `invalid_plan`. */
export function cleanPlan(v: unknown): PlanId {
  if (!isPlanId(v)) throw new PlanError("invalid_plan", "plan must be free, personal, team or enterprise");
  return v;
}
/** Overrides from input, or `invalid_overrides`. */
export function cleanOverrides(v: unknown): PlanOverrides {
  const o = parseOverrides(v);
  if (!o) throw new PlanError("invalid_overrides", "overrides is an object of limit → a whole number, or null for unlimited");
  return o;
}

export const auditPlan = (p: PlatformContext, orgId: string, action: OrgAuditAction, slug: string, detail: Record<string, unknown>, at: string): Stmt =>
  stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`, orgId, p.actor, action, slug, JSON.stringify(detail), at);

export const orgBySlug = async (p: PlatformContext, slug: string): Promise<{ id: string; slug: string }> => {
  const org = await first<{ id: string; slug: string }>(p, `SELECT id, slug FROM orgs WHERE slug = ?`, slug);
  if (!org) throw new PlanError("not_found");
  return org;
};

export interface SetOrgPlanInput {
  plan: unknown;
  /** Omitted = keep the org's overrides when the plan does not change, clear them when it does. */
  overrides?: unknown;
  /** Who is putting the org on the plan. Default `granted` (a superadmin). */
  source?: PlanSource;
  /** Default `active`: setting a plan is how a canceled org comes back. */
  status?: PlanStatus;
  /** BILLING: the paid period's end and the provider's ids. Omitted = left as they are. */
  period_end?: string | null;
  customer_id?: string | null;
  subscription_id?: string | null;
  /** GIFTS (./gifts.ts `giftOrgPlan`): the plan is free until this instant, then the org moves to Free.
   *  Omitted or null = the plan is NOT a gift, and any gift the org held is cleared: a plan set by hand
   *  or paid for through billing has no end of its own. */
  gift_until?: string | null;
}

/**
 * THE way an org's plan changes — the superadmin's "Change plan", and what billing calls when a
 * subscription starts, changes or renews (`source: "billing"`, with its ids). `p.actor` is recorded.
 *
 * It never deletes or removes anything: an org left OVER a limit by the change keeps every member,
 * invitation, repository, environment and artifact it has, and is refused ADDITIONS of that kind until
 * it is back under (shared/plans.ts `planRefusal`). Audited as `plan.change` (the plan moved),
 * `plan.overrides` (only the limits did) or `plan.gift` (it was given until a date).
 *
 * Every call also settles the org's GIFT (0048_plan_gifts): `gift_until` makes the plan one, and a call
 * without it clears whatever gift was there — so an org that starts paying, or whose plan a superadmin
 * sets by hand, is no longer ended by a date.
 */
export async function setOrgPlan(p: PlatformContext, slug: string, input: SetOrgPlanInput): Promise<OrgPlan> {
  const org = await orgBySlug(p, slug);
  const plan = cleanPlan(input.plan);
  const before = await orgPlan(p, org.id);
  const overrides = input.overrides === undefined ? (plan === before.plan ? before.overrides : {}) : cleanOverrides(input.overrides);
  const source = input.source ?? "granted";
  const status = input.status ?? "active";
  if (!PLAN_STATUSES.includes(status)) throw new PlanError("invalid_status");
  const at = nowIso();
  const moved = plan !== before.plan || status !== before.status || source !== before.source;
  const gift = input.gift_until ?? null;
  await batch(p, [
    stmt(p, `UPDATE orgs SET plan = ?1, plan_overrides = ?2, plan_source = ?3, plan_status = ?4, plan_changed_at = ?5, plan_changed_by = ?6,
                    plan_period_end = CASE WHEN ?7 THEN ?8 ELSE plan_period_end END,
                    billing_customer_id = CASE WHEN ?9 THEN ?10 ELSE billing_customer_id END,
                    billing_subscription_id = CASE WHEN ?11 THEN ?12 ELSE billing_subscription_id END,
                    plan_gift_until = ?14
              WHERE id = ?13`,
      plan, JSON.stringify(overrides), source, status, at, p.actor,
      input.period_end !== undefined ? 1 : 0, input.period_end ?? null,
      input.customer_id !== undefined ? 1 : 0, input.customer_id ?? null,
      input.subscription_id !== undefined ? 1 : 0, input.subscription_id ?? null, org.id, gift),
    auditPlan(p, org.id, gift ? "plan.gift" : moved ? "plan.change" : "plan.overrides", org.slug, {
      from: before.plan, to: plan, overrides, source, ...(status !== before.status ? { status } : {}),
      ...(gift ? { until: gift } : before.gift_until ? { gift_cleared: before.gift_until } : {}),
    }, at),
  ]);
  return orgPlan(p, org.id);
}

/**
 * BILLING: move an org's plan STATUS without touching its plan.
 *   • `past_due` — a payment failed. Nothing is enforced differently (a grace period is billing's to
 *     run); the org's Plan block says so.
 *   • `canceled` — the subscription ended. The org stays READABLE and WORKING — every member keeps
 *     access, tickets, docs, the feed and agents carry on — but every ADDITION a limit governs (a
 *     seat, a repository, an environment, an artifact version, an agent connection) is refused until
 *     `setOrgPlan` puts it on a plan again. Nothing is deleted. (Billing shrinks instead of freezing:
 *     an ended subscription is `moveOrgToFree`.)
 *   • `active` — back to normal.
 * Audited as `plan.status`. Idempotent.
 */
export async function setOrgPlanStatus(p: PlatformContext, slug: string, status: PlanStatus, opts: { period_end?: string | null } = {}): Promise<OrgPlan> {
  if (!PLAN_STATUSES.includes(status)) throw new PlanError("invalid_status");
  const org = await orgBySlug(p, slug);
  const before = await orgPlan(p, org.id);
  if (before.status === status && opts.period_end === undefined) return before;
  const at = nowIso();
  await batch(p, [
    stmt(p, `UPDATE orgs SET plan_status = ?1, plan_changed_at = ?2, plan_changed_by = ?3, plan_period_end = CASE WHEN ?4 THEN ?5 ELSE plan_period_end END WHERE id = ?6`,
      status, at, p.actor, opts.period_end !== undefined ? 1 : 0, opts.period_end ?? null, org.id),
    auditPlan(p, org.id, "plan.status", org.slug, { from: before.status, to: status }, at),
  ]);
  return orgPlan(p, org.id);
}
/** BILLING: a payment failed (see `setOrgPlanStatus`). */
export const markOrgPastDue = (p: PlatformContext, slug: string): Promise<OrgPlan> => setOrgPlanStatus(p, slug, "past_due");
/** BILLING: the subscription ended — readable, working, no additions (see `setOrgPlanStatus`). Billing
 *  itself no longer calls it: an ended subscription moves the org to Free (`moveOrgToFree`). */
export const cancelOrgPlan = (p: PlatformContext, slug: string): Promise<OrgPlan> => setOrgPlanStatus(p, slug, "canceled");
/**
 * BILLING: the subscription ended → the org is on Free, `active`, and still a billing org (its Stripe
 * customer is kept, for its invoices and for an upgrade). The over-limit rule is all that applies:
 * nothing is deleted, nobody is removed, everyone reads, and an addition over a Free limit is refused
 * until the org is back under it or on Pro again. Overrides (the paid seats) are cleared.
 */
export const moveOrgToFree = (p: PlatformContext, slug: string, opts: { period_end?: string | null } = {}): Promise<OrgPlan> =>
  setOrgPlan(p, slug, { plan: FREE_PLAN, overrides: {}, source: "billing", status: "active", ...opts });

/** An org's plan as Platform lists it (the list, the org page). */
export async function platformOrgPlan(p: PlatformContext, orgId: string): Promise<PlatformOrgPlan> {
  const [state, n] = await Promise.all([orgPlan(p, orgId), seatCounts(p, orgId)]);
  return {
    plan: state.plan, overrides: state.overrides, status: state.status, source: state.source,
    entitlements: resolveEntitlements(state.plan, state.overrides), seats_used: n.members + n.pending,
  };
}
