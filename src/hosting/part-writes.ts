// The WRITE side of an environment's parts (#97): `PUT` / `DELETE /api/o/:slug/environments/:env/parts/:part`
// (src/hosting/routes.ts). Admin+, every refusal a `SettingsError` with fixed text (it names the field and the
// rule, never a submitted value).
//
// It is NOT in ./parts.ts on purpose: ./parts.ts is the READ side the Repo dashboard projection lists parts
// through, and that projection is reachable from src/mcp.ts — which may import nothing under src/integrations/
// and nothing that reaches src/data/secrets.ts (test/secrets.mcp.test.ts). A legacy part is written through
// `putEnvironment` (src/integrations/settings.ts), so this module must never be imported from ./parts.ts.
//
//   legacy   provider `cloudflare` → key `frontend`, the environment's `worker` / `worker_check` columns;
//            provider `railway` → key `backend`, its `railway_env` / `railway_environment_id` /
//            `railway_service_id`. Written (and removed — the columns blanked) through `putEnvironment`, so its
//            validation and its `environment.set` audit apply unchanged and SaplingLearn's jobs read the same
//            columns they always did. A legacy provider is never stored under any other key (400), and a stored
//            part never takes a legacy key while the environment has that legacy part (409).
//   stored   every other provider: one `org_environment_parts` row, upserted, audited `part.set` /
//            `part.delete` in `org_admin_audit` in the SAME batch. The audit names the provider and the KEYS of
//            what changed — never a value. A part whose provider changes loses its `hosting_poll_state` row and
//            the old provider's `hosting_deploys` rows in that batch: both describe what the OLD provider
//            reported. Its normalised `hx_*` points stay — they are the part's traffic, whoever served it.
import {
  LEGACY_PART_KEY, MAX_PARTS_PER_ENVIRONMENT, PART_KEY_RE, isHostingProvider, isLegacyProvider, isPartRole,
  type HostingProviderId, type LegacyProviderId, type PartRole,
} from "@shared/hosting";
import type { OrgSettingsAuditAction } from "@shared/integrations";
import { requireRole } from "../data/context";
import { batch, nowIso, stmt, type Stmt, type TenantContext } from "../data/sql";
import { SettingsError, listEnvironments, putEnvironment } from "../integrations/settings";
import { listAllParts, type PartRow } from "./parts";
import { PROVIDERS, checkFields } from "./registry";
import type { HostingProvider } from "./types";

/** The provider registry, injectable so a test can stand a fake provider in for one whose file is still a placeholder. */
export type ProviderMap = Readonly<Record<HostingProviderId, HostingProvider>>;

const invalid = (field: string, message: string) => new SettingsError("invalid", 400, message, field);
const PART_BODY_KEYS = ["provider", "role", "label", "settings"];
export const PART_LABEL_MAX = 60;
/** What a legacy part is called — the label ./parts.ts `legacyParts` gives it (it has no column to hold another). */
const LEGACY_LABEL: Record<LegacyProviderId, string> = { cloudflare: "Frontend", railway: "Backend" };

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

  if (isLegacyProvider(provider.id)) {
    return await putLegacyPart(ctx, envKey, partKey, provider.id, label, existing, settings);
  }

  // A stored part may not take a legacy key the environment's own columns hold.
  for (const legacy of ["cloudflare", "railway"] as const) {
    if (partKey === LEGACY_PART_KEY[legacy] && existing?.legacy && existing.provider === legacy) {
      throw new SettingsError("part_conflict", 409, `this environment's ${providers[legacy].label} part uses the key ${partKey} — remove it before giving the key to another provider`);
    }
  }

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

/** The legacy facade: a Cloudflare frontend / Railway backend IS the environment's columns. */
async function putLegacyPart(
  ctx: TenantContext, envKey: string, partKey: string, provider: LegacyProviderId, label: string | null,
  existing: PartRow | null, settings: Record<string, string>,
): Promise<PartWriteResult> {
  const fixedKey = LEGACY_PART_KEY[provider];
  if (partKey !== fixedKey) throw invalid("part", `a ${provider === "cloudflare" ? "Cloudflare" : "Railway"} part is the environment's ${fixedKey}: its key is ${fixedKey}`);
  if (existing && !existing.legacy) {
    throw new SettingsError("part_conflict", 409, `this environment has another part called ${fixedKey} — remove it before giving the key to ${provider === "cloudflare" ? "Cloudflare" : "Railway"}`);
  }
  if (label !== null && label.toLowerCase() !== LEGACY_LABEL[provider].toLowerCase()) {
    throw invalid("label", `the ${LEGACY_LABEL[provider].toLowerCase()}'s label is fixed (${LEGACY_LABEL[provider]})`);
  }
  const columns: Record<string, string | null> = provider === "cloudflare"
    ? { worker: settings.worker ?? "", worker_check: settings.worker_check ?? "" }
    : { railway_env: settings.railway_env ?? "", railway_environment_id: settings.railway_environment_id ?? null, railway_service_id: settings.railway_service_id ?? null };
  await putEnvironment(ctx, envKey, columns);
  return { part: await partAfterWrite(ctx, envKey, partKey), created: existing === null };
}

async function partAfterWrite(ctx: TenantContext, envKey: string, partKey: string): Promise<PartRow> {
  const part = (await listAllParts(ctx)).find((p) => p.env === envKey && p.key === partKey);
  if (!part) throw new SettingsError("not_found", 404, "no such part"); // removed underneath us
  return part;
}

export interface PartDeleteResult { env: string; part: string; provider: HostingProviderId; legacy: boolean }

/**
 * Remove one part (admin+). A stored part: its row, its last-poll row and its deploy history, audited
 * `part.delete`, one batch. A legacy part: its environment columns blanked through `putEnvironment` (Cloudflare:
 * `worker` / `worker_check` → ""; Railway: `railway_env` → "", the two ids → null) — the environment itself and
 * its credentials stay. No such part → 404.
 */
export async function deletePart(ctx: TenantContext, envKey: string, partKey: string): Promise<PartDeleteResult> {
  requireRole(ctx, "admin");
  if (!(await listEnvironments(ctx)).some((e) => e.key === envKey)) throw new SettingsError("not_found", 404, "no such environment");
  const part = (await listAllParts(ctx)).find((p) => p.env === envKey && p.key === partKey);
  if (!part) throw new SettingsError("not_found", 404, "no such part");
  if (part.legacy) {
    await putEnvironment(ctx, envKey, part.provider === "cloudflare"
      ? { worker: "", worker_check: "" }
      : { railway_env: "", railway_environment_id: null, railway_service_id: null });
    return { env: envKey, part: partKey, provider: part.provider, legacy: true };
  }
  const at = nowIso();
  await batch(ctx, [
    stmt(ctx, `DELETE FROM hosting_poll_state WHERE org_id = ? AND env = ? AND part = ?`, ctx.orgId, envKey, partKey),
    stmt(ctx, `DELETE FROM hosting_deploys WHERE org_id = ? AND env = ? AND part = ?`, ctx.orgId, envKey, partKey),
    stmt(ctx, `DELETE FROM org_environment_parts WHERE org_id = ? AND env_key = ? AND part_key = ?`, ctx.orgId, envKey, partKey),
    auditStmt(ctx, "part.delete", `${envKey}/${partKey}`, { provider: part.provider }, at),
  ]);
  return { env: envKey, part: partKey, provider: part.provider, legacy: false };
}
