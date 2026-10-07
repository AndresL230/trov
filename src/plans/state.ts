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
  planRefusal, resolveEntitlements, storedOverrides, parseOverrides, planDef, isPlanId, PLAN_STATUSES, PLAN_SOURCES,
  type OrgPlanState, type PlanRefusal, type PlanId, type PlanOverrides, type PlanSource, type PlanStatus, type PlatformOrgPlan,
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

/** Throw when `state` refuses `adding` more of `limit` at `used`. */
export function assertWithinPlan(state: OrgPlanState, limit: Parameters<typeof planRefusal>[1], used: number, adding = 1): void {
  const refusal = planRefusal(state, limit, used, adding);
  if (refusal) throw new PlanLimitError(refusal);
}

export interface OrgPlanRow {
  plan: string; plan_overrides: string; plan_source: string | null; plan_status: string;
  plan_period_end: string | null; billing_customer_id: string | null; billing_subscription_id: string | null;
}
export const PLAN_COLS = `plan, plan_overrides, plan_source, plan_status, plan_period_end, billing_customer_id, billing_subscription_id`;

export interface OrgPlan extends OrgPlanState {
  source: PlanSource | null;
  period_end: string | null;
  customer_id: string | null;
  subscription_id: string | null;
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);

/** A stored row as the state every gate reads. An unknown plan id reads as the smallest plan and an
 *  unknown status as `active` — a bad value can only ever make an org SMALLER, never unlimited. */
export function planOf(r: OrgPlanRow | null): OrgPlan {
  return {
    plan: planDef(r?.plan).id, overrides: storedOverrides(r?.plan_overrides), status: oneOf(PLAN_STATUSES, r?.plan_status) ?? "active",
    source: oneOf(PLAN_SOURCES, r?.plan_source), period_end: r?.plan_period_end ?? null,
    customer_id: r?.billing_customer_id ?? null, subscription_id: r?.billing_subscription_id ?? null,
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

export type PlanErrorCode = "invalid_plan" | "invalid_overrides" | "invalid_status" | "not_found";
export const PLAN_ERROR_STATUS: Record<PlanErrorCode, 400 | 404> = { invalid_plan: 400, invalid_overrides: 400, invalid_status: 400, not_found: 404 };
export class PlanError extends Error {
  constructor(readonly code: PlanErrorCode, message?: string) { super(message ?? code); }
}

/** A plan id from input, or `invalid_plan`. */
export function cleanPlan(v: unknown): PlanId {
  if (!isPlanId(v)) throw new PlanError("invalid_plan", "plan must be personal, team or enterprise");
  return v;
}
/** Overrides from input, or `invalid_overrides`. */
export function cleanOverrides(v: unknown): PlanOverrides {
  const o = parseOverrides(v);
  if (!o) throw new PlanError("invalid_overrides", "overrides is an object of limit → a whole number, or null for unlimited");
  return o;
}

const auditPlan = (p: PlatformContext, orgId: string, action: OrgAuditAction, slug: string, detail: Record<string, unknown>, at: string): Stmt =>
  stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`, orgId, p.actor, action, slug, JSON.stringify(detail), at);

const orgBySlug = async (p: PlatformContext, slug: string): Promise<{ id: string; slug: string }> => {
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
}

/**
 * THE way an org's plan changes — the superadmin's "Change plan", and what billing calls when a
 * subscription starts, changes or renews (`source: "billing"`, with its ids). `p.actor` is recorded.
 *
 * It never deletes or removes anything: an org left OVER a limit by the change keeps every member,
 * invitation, repository, environment and artifact it has, and is refused ADDITIONS of that kind until
 * it is back under (shared/plans.ts `planRefusal`). Audited as `plan.change` (the plan moved) or
 * `plan.overrides` (only the limits did).
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
  await batch(p, [
    stmt(p, `UPDATE orgs SET plan = ?1, plan_overrides = ?2, plan_source = ?3, plan_status = ?4, plan_changed_at = ?5, plan_changed_by = ?6,
                    plan_period_end = CASE WHEN ?7 THEN ?8 ELSE plan_period_end END,
                    billing_customer_id = CASE WHEN ?9 THEN ?10 ELSE billing_customer_id END,
                    billing_subscription_id = CASE WHEN ?11 THEN ?12 ELSE billing_subscription_id END
              WHERE id = ?13`,
      plan, JSON.stringify(overrides), source, status, at, p.actor,
      input.period_end !== undefined ? 1 : 0, input.period_end ?? null,
      input.customer_id !== undefined ? 1 : 0, input.customer_id ?? null,
      input.subscription_id !== undefined ? 1 : 0, input.subscription_id ?? null, org.id),
    auditPlan(p, org.id, moved ? "plan.change" : "plan.overrides", org.slug,
      { from: before.plan, to: plan, overrides, source, ...(status !== before.status ? { status } : {}) }, at),
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
 *     `setOrgPlan` puts it on a plan again. Nothing is deleted. (To shrink instead of freeze, call
 *     `setOrgPlan(p, slug, { plan: "personal" })`.)
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
/** BILLING: the subscription ended — readable, working, no additions (see `setOrgPlanStatus`). */
export const cancelOrgPlan = (p: PlatformContext, slug: string): Promise<OrgPlan> => setOrgPlanStatus(p, slug, "canceled");

/** An org's plan as Platform lists it (the list, the org page). */
export async function platformOrgPlan(p: PlatformContext, orgId: string): Promise<PlatformOrgPlan> {
  const [state, n] = await Promise.all([orgPlan(p, orgId), seatCounts(p, orgId)]);
  return {
    plan: state.plan, overrides: state.overrides, status: state.status, source: state.source,
    entitlements: resolveEntitlements(state.plan, state.overrides), seats_used: n.members + n.pending,
  };
}
