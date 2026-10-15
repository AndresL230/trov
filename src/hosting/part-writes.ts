// The WRITE side of an environment's parts (#97): `PUT` / `DELETE /api/o/:slug/environments/:env/parts/:part`
// (src/hosting/routes.ts). Admin+, every refusal a `SettingsError` with fixed text (it names the field and the
// rule, never a submitted value).
//
// Every part is one `org_environment_parts` row, whoever hosts it: upserted, audited `part.set` / `part.delete`
// in `org_admin_audit` in the SAME batch. The audit names the provider and the KEYS of what changed — never a
// value. A part whose provider changes loses its `hosting_poll_state` row and the old provider's
// `hosting_deploys` rows in that batch: both describe what the OLD provider reported. Its normalised `hx_*`
// points stay — they are the part's traffic, whoever served it.
import { MAX_PARTS_PER_ENVIRONMENT, PART_KEY_RE, isHostingProvider, isPartRole, type HostingProviderId, type PartRole } from "@shared/hosting";
import type { OrgSettingsAuditAction } from "@shared/integrations";
import { requireRole } from "../data/context";
import { batch, nowIso, stmt, type Stmt, type TenantContext } from "../data/sql";
import { SettingsError, listEnvironments } from "../integrations/settings";
import { listAllParts, type PartRow } from "./parts";
import { PROVIDERS, checkFields } from "./registry";
import type { HostingProvider } from "./types";

/** The provider registry, injectable so a test can stand a fake provider in for one whose file is still a placeholder. */
export type ProviderMap = Readonly<Record<HostingProviderId, HostingProvider>>;

const invalid = (field: string, message: string) => new SettingsError("invalid", 400, message, field);
const PART_BODY_KEYS = ["provider", "role", "label", "settings"];
export const PART_LABEL_MAX = 60;

/** A new part's label when none is sent: the key, capitalised, separators as spaces (`api-gateway` → "Api gateway"). */
export const defaultPartLabel = (key: string): string => {
  const words = key.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
};

const auditStmt = (ctx: TenantContext, action: OrgSettingsAuditAction, target: string, detail: Record<string, unknown>, at: string): Stmt =>
  stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, ctx.userId, action, target, JSON.stringify(detail), at);

/** The keys whose values differ between two settings objects (added, removed or changed), sorted. */
const changedKeys = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

export interface PartWriteResult { part: PartRow; created: boolean }

/**
 * Create or replace one part of an environment (admin+). Body: `{ provider, role?, label?, settings? }`
 * (`PartWrite`, shared/hosting.ts); any other key is refused. `provider` must be one Trov knows and can poll
 * now (`status: "available"` — AWS is `later` and cannot be chosen); `role` one the provider serves (default:
 * the part's current role on the same provider, else the provider's first); `label` ≤ 60 characters (default:
 * the current label, else the capitalised key). `settings` is checked against the provider's `partSettings`
 * (required fields, patterns); left out on an existing part of the SAME provider it keeps the stored settings.
 */
export async function putPart(
  ctx: TenantContext, envKey: string, partKey: string, body: unknown, providers: ProviderMap = PROVIDERS,
): Promise<PartWriteResult> {
  requireRole(ctx, "admin");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("body", "the body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !PART_BODY_KEYS.includes(k))) throw invalid("body", "the body has a field a part does not have");
  if (!(await listEnvironments(ctx)).some((e) => e.key === envKey)) throw new SettingsError("not_found", 404, "no such environment");
  if (!PART_KEY_RE.test(partKey)) throw invalid("part", "the part key must be 1–32 characters: a–z, 0–9, _ or -");

  if (!isHostingProvider(b.provider) || !providers[b.provider]) throw invalid("provider", "provider is not one Trov knows");
  const provider = providers[b.provider];
  if (provider.status !== "available") throw invalid("provider", `${provider.label} is not supported yet`);

  const envParts = (await listAllParts(ctx)).filter((p) => p.env === envKey);
  const existing = envParts.find((p) => p.key === partKey) ?? null;
  const created = existing === null;
  if (created && envParts.length >= MAX_PARTS_PER_ENVIRONMENT) {
    throw new SettingsError("too_many_parts", 409, `an environment can have at most ${MAX_PARTS_PER_ENVIRONMENT} parts`);
  }

  // role
  let role: PartRole;
  if (b.role !== undefined) {
    if (!isPartRole(b.role) || !provider.roles.includes(b.role)) throw invalid("role", `role must be one ${provider.label} serves: ${provider.roles.join(" or ")}`);
    role = b.role;
  } else {
    role = existing && existing.provider === provider.id && provider.roles.includes(existing.role) ? existing.role : provider.roles[0];
  }

  // label
  let label: string | null = null;
  if (b.label !== undefined) {
    if (typeof b.label !== "string") throw invalid("label", "label must be a string");
    label = b.label.trim();
    if (!label) throw invalid("label", "label must not be empty");
    if (label.length > PART_LABEL_MAX) throw invalid("label", `label is longer than ${PART_LABEL_MAX} characters`);
    if (/[\u0000-\u001f\u007f]/.test(label)) throw invalid("label", "label contains a control character");
  }

  // settings: the stored ones carry over only on the same provider
  const given = b.settings === undefined && existing && existing.provider === provider.id ? existing.settings : b.settings;
  const checked = checkFields(provider.partSettings, given, "settings");
  if ("field" in checked) throw invalid(checked.field, checked.message);
  const settings = checked.values;
  // What a field list cannot say ("exactly one of…" — the `github` provider's settings).
  const cross = provider.checkSettings?.(settings) ?? null;
  if (cross) throw invalid(cross.field, cross.message);

  const at = nowIso();
  const next = { label: label ?? existing?.label ?? defaultPartLabel(partKey), role, provider: provider.id, settings };
  const fields = (existing
    ? [
      ...(existing.label !== next.label ? ["label"] : []),
      ...(existing.role !== next.role ? ["role"] : []),
      ...(existing.provider !== next.provider ? ["provider"] : []),
      ...changedKeys(existing.settings, settings).map((k) => `settings.${k}`),
    ]
    : Object.keys(settings).map((k) => `settings.${k}`)).sort();
  const providerChanged = existing !== null && existing.provider !== provider.id;
  await batch(ctx, [
    stmt(ctx, `INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
               VALUES (?, ?, ?, (SELECT COALESCE(MAX(p.position), -1) + 1 FROM org_environment_parts p WHERE p.org_id = ? AND p.env_key = ?), ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(org_id, env_key, part_key) DO UPDATE SET label = excluded.label, role = excluded.role, provider = excluded.provider,
                 settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ctx.orgId, envKey, partKey, ctx.orgId, envKey, next.label, next.role, next.provider, JSON.stringify(settings), at, at, ctx.userId),
    ...(providerChanged ? [
      stmt(ctx, `DELETE FROM hosting_poll_state WHERE org_id = ? AND env = ? AND part = ?`, ctx.orgId, envKey, partKey),
      stmt(ctx, `DELETE FROM hosting_deploys WHERE org_id = ? AND env = ? AND part = ? AND provider = ?`, ctx.orgId, envKey, partKey, existing!.provider),
    ] : []),
    auditStmt(ctx, "part.set", `${envKey}/${partKey}`, {
      provider: provider.id, created, fields, ...(providerChanged ? { previous_provider: existing!.provider } : {}),
    }, at),
  ]);
  return { part: await partAfterWrite(ctx, envKey, partKey), created };
}

async function partAfterWrite(ctx: TenantContext, envKey: string, partKey: string): Promise<PartRow> {
  const part = (await listAllParts(ctx)).find((p) => p.env === envKey && p.key === partKey);
  if (!part) throw new SettingsError("not_found", 404, "no such part"); // removed underneath us
  return part;
}

export interface PartDeleteResult { env: string; part: string; provider: HostingProviderId }

/**
 * Remove one part (admin+): its row, its last-poll row and its deploy history, audited `part.delete`, one
 * batch. The environment itself and the provider's credential stay. No such part → 404.
 */
export async function deletePart(ctx: TenantContext, envKey: string, partKey: string): Promise<PartDeleteResult> {
  requireRole(ctx, "admin");
  if (!(await listEnvironments(ctx)).some((e) => e.key === envKey)) throw new SettingsError("not_found", 404, "no such environment");
  const part = (await listAllParts(ctx)).find((p) => p.env === envKey && p.key === partKey);
  if (!part) throw new SettingsError("not_found", 404, "no such part");
  const at = nowIso();
  await batch(ctx, [
    stmt(ctx, `DELETE FROM hosting_poll_state WHERE org_id = ? AND env = ? AND part = ?`, ctx.orgId, envKey, partKey),
    stmt(ctx, `DELETE FROM hosting_deploys WHERE org_id = ? AND env = ? AND part = ?`, ctx.orgId, envKey, partKey),
    stmt(ctx, `DELETE FROM org_environment_parts WHERE org_id = ? AND env_key = ? AND part_key = ?`, ctx.orgId, envKey, partKey),
    auditStmt(ctx, "part.delete", `${envKey}/${partKey}`, { provider: part.provider }, at),
  ]);
  return { env: envKey, part: partKey, provider: part.provider };
}
