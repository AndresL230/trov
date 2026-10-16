// Cadence resolution (canopy-email.md §3). Three layers, first match wins:
// user pref → policy default_cadence → registry default. Absence inherits.
// Admin authority is existence only: policy.enabled = 0 is 'off' for everyone
// and the user layer is never consulted.
import type { Cadence, NotificationKindMeta } from "@shared/notifications";
import type { NotificationPolicyRow, NotificationPrefRow } from "@shared/rows";
import { type TenantContext, all, first, run } from "../data/sql";
import { getKind } from "./registry";

export type PolicyMap = Map<string, NotificationPolicyRow>;
export type PrefMap = Map<string, Cadence>;

export async function loadPolicies(ctx: TenantContext): Promise<PolicyMap> {
  const rows = await all<NotificationPolicyRow>(ctx, `SELECT * FROM notification_policy WHERE org_id = ?`, ctx.orgId);
  return new Map(rows.map((r) => [r.kind, r]));
}

export async function loadPrefs(ctx: TenantContext, userId: string): Promise<PrefMap> {
  const rows = await all<NotificationPrefRow>(ctx, `SELECT * FROM notification_prefs WHERE org_id = ? AND user_id = ?`, ctx.orgId, userId);
  return new Map(rows.map((r) => [r.kind, r.cadence]));
}

/** Pure resolution over preloaded layers — the run assembler's hot path. */
export function resolveWith(kind: NotificationKindMeta, policy: NotificationPolicyRow | undefined, pref: Cadence | undefined): Cadence {
  if (policy && policy.enabled === 0) return "off";
  if (pref !== undefined) return pref;
  if (policy) return policy.default_cadence;
  return kind.defaultCadence;
}

// ── a member's e-mail options that are not a kind's cadence (0067_digest_email) ─────────────────────

/** "Only when something needs me" — false when never set. */
export async function loadOnlyWhenNeeded(ctx: TenantContext, userId: string): Promise<boolean> {
  const row = await first<{ only_when_needed: number }>(ctx,
    `SELECT only_when_needed FROM notification_person_prefs WHERE org_id = ? AND user_id = ? COLLATE NOCASE`, ctx.orgId, userId);
  return Number(row?.only_when_needed ?? 0) === 1;
}

/** Set it — the person's OWN row only (the caller passes the principal). */
export async function saveOnlyWhenNeeded(ctx: TenantContext, userId: string, on: boolean, at: string): Promise<void> {
  await run(ctx,
    `INSERT INTO notification_person_prefs (org_id, user_id, only_when_needed, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(org_id, user_id) DO UPDATE SET only_when_needed = excluded.only_when_needed, updated_at = excluded.updated_at`,
    ctx.orgId, userId, on ? 1 : 0, at);
}

/** The kind whose ONE line (the Sprint line) rides every daily, whatever its own cadence (owner ruling Q45). */
export const DAILY_SPRINT_KIND = "roadmap_plan";

/**
 * The kinds one person's run of `cadence` carries, in registry order: every kind resolved to that cadence — and, on
 * the WEEKLY, the brief (`my_work`) when it resolves to daily and the weekly has anything else, so the weekly leads
 * with the brief too (Phase E: "Weekly: the brief, then This week…"). A weekly with nothing but the brief is not
 * sent to someone who gets the brief daily anyway. On the DAILY, the Sprint line (`roadmap_plan`) rides along whatever
 * `roadmap_plan` resolves to (owner ruling Q45; its own cadence governs the weekly only) — when the daily has anything
 * else, and unless the org's policy turned the kind off for everyone.
 */
export function selectKinds<K extends NotificationKindMeta>(registry: readonly K[], policies: PolicyMap, prefs: PrefMap, cadence: "daily" | "weekly"): K[] {
  const at = (k: K) => resolveWith(k, policies.get(k.id), prefs.get(k.id));
  const own = registry.filter((k) => at(k) === cadence);
  if (own.length === 0) return own;
  if (cadence === "daily") {
    return registry.filter((k) => at(k) === "daily" || (k.id === DAILY_SPRINT_KIND && policies.get(k.id)?.enabled !== 0));
  }
  return registry.filter((k) => at(k) === cadence || (k.id === "my_work" && at(k) === "daily"));
}

/** resolveCadence(userId, kind): one user, one kind. Unknown kind → 'off'. */
export async function resolveCadence(ctx: TenantContext, userId: string, kindId: string): Promise<Cadence> {
  const kind = getKind(kindId);
  if (!kind) return "off";
  const policy = (await first<NotificationPolicyRow>(
    ctx, `SELECT * FROM notification_policy WHERE org_id = ? AND kind = ?`, ctx.orgId, kindId)) ?? undefined;
  if (policy && policy.enabled === 0) return "off";
  const pref = await first<NotificationPrefRow>(
    ctx, `SELECT * FROM notification_prefs WHERE org_id = ? AND user_id = ? AND kind = ?`, ctx.orgId, userId, kindId);
  return resolveWith(kind, policy, pref?.cadence);
}
