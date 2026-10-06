// Per-org integration secrets (canopy-multitenancy.md §8.7.1, §8.7.5; D14, D19). Envelope encryption:
// the Worker secret TROV_KEK wraps ONE data key (DEK) per org and version (`org_keys`); the DEK encrypts
// each credential (`org_secrets`) with AES-256-GCM, bound by its AAD to (org, kind, scope). This module
// is the only place a credential is encrypted or decrypted, and `getSecret` is the ONLY decrypt path.
//
// Nothing here logs, and no error it throws carries a value: every message is fixed text. The audit row
// of a change is written in the SAME batch as the change (§2.1). NOTHING REACHABLE FROM src/mcp.ts MAY
// IMPORT THIS FILE (test/secrets.mcp.test.ts walks the import graph).
//
// The key-encryption key comes from the context (`kekOf`, ./context.ts — the Env a context was built
// from, narrowed to TROV_KEK / TROV_KEK_PREVIOUS), so the API is the spec's: `getSecret(ctx, kind, scope)`.
// Only the cut-over fallbacks at the bottom (`resolveCredential` …) take an `env`: they read the legacy
// Worker secrets, which a context deliberately does not expose.
import type { IntegrationKind, OrgAuditAction, OrgAuditDTO } from "@shared/integrations";
import type { Env } from "../env";
import { kekOf, requireRole } from "./context";
import { SAPLINGLEARN_ORG_ID } from "./legacy";
import { all, batch, first, nowIso, run, stmt, type Stmt, type TenantContext } from "./sql";

export type KekEnv = Pick<Env, "TROV_KEK" | "TROV_KEK_PREVIOUS">;

// ── errors (value-free by construction) ──────────────────────────────────────

/** TROV_KEK is missing, malformed, or not the key that wrapped this org's data key. A route answers
 *  503 `{ error: "secrets_unavailable" }`; nothing is ever stored in plaintext instead. */
export class SecretsUnavailableError extends Error {
  readonly code = "secrets_unavailable" as const;
  constructor(why: string) { super(`secrets unavailable: ${why}`); this.name = "SecretsUnavailableError"; }
}
/** `getSecret` refused the context: an MCP (bearer) caller, or a plain member (§8.7.5). */
export class SecretAccessError extends Error {
  readonly code = "forbidden" as const;
  constructor() { super("this context may not read a secret"); this.name = "SecretAccessError"; }
}
/** GCM authentication failed: a row moved between orgs / kinds / scopes, a tampered byte, a wrong key. */
export class SecretDecryptError extends Error {
  readonly code = "undecryptable_secret" as const;
  constructor(readonly target: string) { super(`secret ${target} could not be decrypted`); this.name = "SecretDecryptError"; }
}
export class SecretConflictError extends Error {
  readonly code = "already_configured" as const;
  constructor() { super("a secret is already set — rotate it instead"); this.name = "SecretConflictError"; }
}
export class SecretNotFoundError extends Error {
  readonly code = "not_configured" as const;
  constructor() { super("no secret is set"); this.name = "SecretNotFoundError"; }
}
/** The submitted value was refused. The message names the rule, never the value. */
export class SecretValueError extends Error {
  readonly code = "invalid_secret" as const;
  constructor(message: string) { super(message); this.name = "SecretValueError"; }
}

// ── Secret + scrub ───────────────────────────────────────────────────────────

/** A decrypted credential. It renders `"[secret]"` however it is stringified, serialised or inspected;
 *  the plaintext is read only by `reveal()`, at the one line that builds the outbound header. */
export class Secret {
  readonly #value: string;
  constructor(value: string) { this.#value = value; }
  reveal(): string { return this.#value; }
  toString(): string { return "[secret]"; }
  toJSON(): string { return "[secret]"; }
  [Symbol.for("nodejs.util.inspect.custom")](): string { return "[secret]"; }
}

export type Revealed = string | Secret | null | undefined | readonly Revealed[];

const plainValues = (r: Revealed, out: string[] = []): string[] => {
  if (Array.isArray(r)) for (const x of r as readonly Revealed[]) plainValues(x, out);
  else if (r instanceof Secret) out.push(r.reveal());
  else if (typeof r === "string") out.push(r);
  return out;
};

/**
 * Replace every occurrence of each revealed value (and its URL-encoded spelling) with `[redacted]`.
 * EVERY message that may quote an upstream response goes through here BEFORE it is cut, logged or
 * stored — a cut first could leave half a token behind (the `scrubbedMessage` rule, src/repo/github.ts).
 */
export function scrub(text: string, revealed: Revealed): string {
  const values = new Set<string>();
  for (const v of plainValues(revealed)) {
    if (!v) continue;
    values.add(v);
    values.add(encodeURIComponent(v));
  }
  return [...values].sort((a, b) => b.length - a.length).reduce((m, v) => m.split(v).join("[redacted]"), text);
}

export const LAST_ERROR_CHARS = 300;
/** What `last_error` holds: scrubbed FIRST, then one line, then cut to 300 characters. */
export const lastErrorText = (message: string, revealed: Revealed): string =>
  scrub(message, revealed).replace(/\s+/g, " ").trim().slice(0, LAST_ERROR_CHARS);

/** `hint_last4`: the last 4 characters, only for a secret of 16+ characters (0037's rule) — on a shorter
 *  one, 4 characters are too large a share of the value to show. */
export const HINT_MIN_CHARS = 16;
const hintOf = (value: string): string => (value.length >= HINT_MIN_CHARS ? value.slice(-4) : "");

export const SECRET_MAX_CHARS = 4096;
export const WEBHOOK_SECRET_MIN_CHARS = 16;
/** Why a submitted value is refused, or null. Fixed text: it names the rule and never quotes the value. */
export function secretValueProblem(kind: IntegrationKind, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "secret is required";
  if (value.length > SECRET_MAX_CHARS) return `secret is longer than ${SECRET_MAX_CHARS} characters`;
  if (value !== value.trim()) return "secret has leading or trailing whitespace";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "secret contains a control character or a line break";
  if (kind === "github_webhook" && value.length < WEBHOOK_SECRET_MIN_CHARS) return `a webhook secret needs at least ${WEBHOOK_SECRET_MIN_CHARS} characters`;
  return null;
}

// ── bytes ────────────────────────────────────────────────────────────────────

const utf8 = new TextEncoder();
const b64 = (bytes: ArrayBuffer | Uint8Array): string => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
const randomIv = (): Uint8Array => crypto.getRandomValues(new Uint8Array(12));

// ── KEK ──────────────────────────────────────────────────────────────────────

interface Kek { key: CryptoKey; fingerprint: string }

// Imported once per isolate and per value (§8.7.1): non-extractable, wrapKey / unwrapKey ONLY — the KEK
// can never encrypt or decrypt a credential directly. A failed import is not kept.
const keks = new Map<string, Promise<Kek>>();

async function importKek(value: string, name: "TROV_KEK" | "TROV_KEK_PREVIOUS"): Promise<Kek> {
  let raw: Uint8Array;
  try { raw = unb64(value.trim()); } catch { throw new SecretsUnavailableError(`${name} is not valid base64`); }
  if (raw.byteLength !== 32) throw new SecretsUnavailableError(`${name} is not 32 bytes`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const fingerprint = [...digest.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["wrapKey", "unwrapKey"]);
  return { key, fingerprint };
}

function kek(value: string, name: "TROV_KEK" | "TROV_KEK_PREVIOUS"): Promise<Kek> {
  let held = keks.get(value);
  if (!held) {
    held = importKek(value, name);
    keks.set(value, held);
    held.catch(() => keks.delete(value));
  }
  return held;
}

async function currentKek(env: KekEnv): Promise<Kek> {
  if (!env.TROV_KEK) throw new SecretsUnavailableError("TROV_KEK is not set");
  return kek(env.TROV_KEK, "TROV_KEK");
}

/** The KEK that wrapped a row: the current one, else TROV_KEK_PREVIOUS — picked by fingerprint. */
async function kekFor(env: KekEnv, fingerprint: string): Promise<Kek> {
  const current = await currentKek(env);
  if (current.fingerprint === fingerprint) return current;
  if (env.TROV_KEK_PREVIOUS) {
    const previous = await kek(env.TROV_KEK_PREVIOUS, "TROV_KEK_PREVIOUS");
    if (previous.fingerprint === fingerprint) return previous;
  }
  throw new SecretsUnavailableError("no configured key matches the one that wrapped this org's data key");
}

/** Is the platform key usable? What the Integrations page shows a banner for. Never throws. */
export const secretsAvailable = (env: KekEnv): Promise<boolean> => currentKek(env).then(() => true, () => false);

// ── DEK ──────────────────────────────────────────────────────────────────────

interface KeyRow { key_version: number; wrapped_key: string; wrap_iv: string; kek_fingerprint: string }
const KEY_COLS = `key_version, wrapped_key, wrap_iv, kek_fingerprint`;
const keyAad = (orgId: string, version: number): Uint8Array => utf8.encode(`org_key:${orgId}:${version}`);

/** A fresh random DEK, wrapped under the CURRENT KEK for (org, version). The raw key exists only inside
 *  WebCrypto: it is generated extractable so `wrapKey` can export it, and that handle is dropped here. */
async function wrapNewDek(ctx: TenantContext, version: number): Promise<KeyRow> {
  const { key, fingerprint } = await currentKek(kekOf(ctx));
  const dek = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])) as CryptoKey;
  const iv = randomIv();
  const wrapped = await crypto.subtle.wrapKey("raw", dek, key, { name: "AES-GCM", iv, additionalData: keyAad(ctx.orgId, version) });
  return { key_version: version, wrapped_key: b64(wrapped), wrap_iv: b64(iv), kek_fingerprint: fingerprint };
}

/** Unwrap a key row as a NON-extractable encrypt/decrypt key. The AAD names `ctx.orgId`, so another
 *  org's wrapped key fails here. No cross-request cache: a DEK lives for the call that needs it. */
async function unwrapDek(ctx: TenantContext, row: KeyRow): Promise<CryptoKey> {
  const { key } = await kekFor(kekOf(ctx), row.kek_fingerprint);
  try {
    return await crypto.subtle.unwrapKey(
      "raw", unb64(row.wrapped_key), key,
      { name: "AES-GCM", iv: unb64(row.wrap_iv), additionalData: keyAad(ctx.orgId, row.key_version) },
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } catch {
    throw new SecretDecryptError("org_keys");
  }
}

const activeKeyRow = (ctx: TenantContext): Promise<KeyRow | null> =>
  first<KeyRow>(ctx, `SELECT ${KEY_COLS} FROM org_keys WHERE org_id = ? AND retired_at IS NULL ORDER BY key_version DESC LIMIT 1`, ctx.orgId);

const insertKeyStmt = (ctx: TenantContext, row: KeyRow, at: string, orIgnore = false): Stmt =>
  stmt(ctx, `INSERT${orIgnore ? " OR IGNORE" : ""} INTO org_keys (org_id, key_version, wrapped_key, wrap_iv, kek_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, row.key_version, row.wrapped_key, row.wrap_iv, row.kek_fingerprint, at);

/** The org's current DEK — created on its FIRST secret write. Two first writes racing both insert
 *  version N; OR IGNORE keeps one, and both then unwrap the row that is actually stored. */
async function activeDek(ctx: TenantContext): Promise<{ version: number; key: CryptoKey }> {
  let row = await activeKeyRow(ctx);
  if (!row) {
    const top = await first<{ v: number | null }>(ctx, `SELECT MAX(key_version) AS v FROM org_keys WHERE org_id = ?`, ctx.orgId);
    await batch(ctx, [insertKeyStmt(ctx, await wrapNewDek(ctx, (top?.v ?? 0) + 1), nowIso(), true)]);
    row = await activeKeyRow(ctx);
    if (!row) throw new SecretsUnavailableError("the org's data key could not be created");
  }
  return { version: row.key_version, key: await unwrapDek(ctx, row) };
}

// ── encrypt / decrypt ────────────────────────────────────────────────────────

// D14's AAD. Built from ctx.orgId and the REQUESTED kind / scope — never from the row being read — so a
// ciphertext moved to another org, kind or scope fails GCM authentication instead of decrypting.
const secretAad = (orgId: string, kind: string, scope: string): Uint8Array => utf8.encode(`${orgId}:${kind}:${scope}`);

async function seal(dek: CryptoKey, aad: Uint8Array, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = randomIv(); // fresh on every write
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, dek, utf8.encode(plaintext));
  return { ciphertext: b64(sealed), iv: b64(iv) };
}

async function open(dek: CryptoKey, aad: Uint8Array, ciphertext: string, iv: string, target: string): Promise<string> {
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: aad }, dek, unb64(ciphertext));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plain);
  } catch {
    throw new SecretDecryptError(target);
  }
}

// ── metadata + audit ─────────────────────────────────────────────────────────

/** Everything a route may select from `org_secrets` — never `ciphertext`, `iv` or `key_version`. */
export interface SecretMeta {
  kind: IntegrationKind;
  scope: string;
  hint_last4: string;
  created_by: string;
  created_at: string;
  rotated_at: string | null;
  last_used_at: string | null;
  last_error: string | null;
}
const META_COLS = `kind, scope, hint_last4, created_by, created_at, rotated_at, last_used_at, last_error`;

export const listSecretMeta = (ctx: TenantContext): Promise<SecretMeta[]> =>
  all<SecretMeta>(ctx, `SELECT ${META_COLS} FROM org_secrets WHERE org_id = ? ORDER BY kind, scope`, ctx.orgId);

export const getSecretMeta = (ctx: TenantContext, kind: IntegrationKind, scope: string): Promise<SecretMeta | null> =>
  first<SecretMeta>(ctx, `SELECT ${META_COLS} FROM org_secrets WHERE org_id = ? AND kind = ? AND scope = ?`, ctx.orgId, kind, scope);

const targetOf = (kind: string, scope: string): string => `${kind}:${scope}`;

const auditStmt = (ctx: TenantContext, action: OrgAuditAction, target: string, detail: Record<string, unknown>, at: string): Stmt =>
  stmt(ctx, `INSERT INTO org_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, ctx.userId, action, target, JSON.stringify(detail), at);

const parseObject = (json: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
};

/**
 * The org's recent audit rows, newest first: this module's secret trail (`org_audit`) merged with the
 * repository / environment changes src/integrations/settings.ts records in `org_admin_audit` (0043 —
 * `org_audit.action` has a CHECK that admits only the five secret actions). One list, the way
 * `GET /api/platform/audit` merges the same two tables; ids are `s<n>` / `a<n>`. Rows of one batch share
 * their `at`: there the secret rows come first (a removed environment's secret deletions, then the
 * removal), each trail in its own id order.
 */
export async function listOrgAudit(ctx: TenantContext, limit = 50): Promise<OrgAuditDTO[]> {
  const rows = await all<Omit<OrgAuditDTO, "detail"> & { detail: string; n: number; secret: number }>(ctx,
    `SELECT * FROM (
       SELECT 's' || s.id AS id, s.actor, s.action, s.target, s.detail, s.at, s.id AS n, 1 AS secret FROM org_audit s WHERE s.org_id = ?
       UNION ALL
       SELECT 'a' || a.id AS id, a.actor, a.action, a.target, a.detail, a.at, a.id AS n, 0 AS secret FROM org_admin_audit a
        WHERE a.org_id = ? AND (a.action LIKE 'repo.%' OR a.action LIKE 'environment.%')
     ) ORDER BY at DESC, secret DESC, n DESC LIMIT ?`, ctx.orgId, ctx.orgId, limit);
  return rows.map(({ n: _n, secret: _secret, ...r }) => ({ ...r, detail: parseObject(r.detail) }));
}

// ── non-secret config (org_integration_config) ───────────────────────────────

export type IntegrationConfig = Record<string, string>;

const stringsOnly = (o: Record<string, unknown>): IntegrationConfig =>
  Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => typeof e[1] === "string"));

export async function getIntegrationConfig(ctx: TenantContext, kind: IntegrationKind, scope: string): Promise<IntegrationConfig> {
  const row = await first<{ config: string }>(ctx, `SELECT config FROM org_integration_config WHERE org_id = ? AND kind = ? AND scope = ?`, ctx.orgId, kind, scope);
  return row ? stringsOnly(parseObject(row.config)) : {};
}

export async function listIntegrationConfig(ctx: TenantContext): Promise<{ kind: string; scope: string; config: IntegrationConfig }[]> {
  const rows = await all<{ kind: string; scope: string; config: string }>(ctx, `SELECT kind, scope, config FROM org_integration_config WHERE org_id = ?`, ctx.orgId);
  return rows.map((r) => ({ kind: r.kind, scope: r.scope, config: stringsOnly(parseObject(r.config)) }));
}

// The audit detail names the KEYS that were set, not their values: `detail` never needs scanning.
const configStmts = (ctx: TenantContext, kind: IntegrationKind, scope: string, config: IntegrationConfig, at: string): Stmt[] => [
  stmt(ctx, `INSERT INTO org_integration_config (org_id, kind, scope, config, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(org_id, kind, scope) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ctx.orgId, kind, scope, JSON.stringify(config), at, ctx.userId),
  auditStmt(ctx, "integration.config", targetOf(kind, scope), { keys: Object.keys(config).sort() }, at),
];

/** Replace an integration's non-secret config (admin+). The caller has validated `config` for the kind. */
export async function setIntegrationConfig(ctx: TenantContext, kind: IntegrationKind, scope: string, config: IntegrationConfig): Promise<void> {
  requireRole(ctx, "admin");
  await batch(ctx, configStmts(ctx, kind, scope, config, nowIso()));
}

// ── writes ───────────────────────────────────────────────────────────────────

const isUniqueViolation = (e: unknown): boolean => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

/** Store a NEW secret (admin+). An existing one is a `SecretConflictError` — rotation is its own verb.
 *  `config`, when given, is written (and audited) in the same batch. */
export async function setSecret(
  ctx: TenantContext, kind: IntegrationKind, scope: string, value: string, config?: IntegrationConfig
): Promise<SecretMeta> {
  requireRole(ctx, "admin");
  const problem = secretValueProblem(kind, value);
  if (problem) throw new SecretValueError(problem);
  if (await getSecretMeta(ctx, kind, scope)) throw new SecretConflictError();
  const dek = await activeDek(ctx);
  const sealed = await seal(dek.key, secretAad(ctx.orgId, kind, scope), value);
  const at = nowIso();
  const hint = hintOf(value);
  try {
    await batch(ctx, [
      stmt(ctx, `INSERT INTO org_secrets (org_id, kind, scope, ciphertext, iv, key_version, hint_last4, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.orgId, kind, scope, sealed.ciphertext, sealed.iv, dek.version, hint, ctx.userId, at),
      auditStmt(ctx, "secret.set", targetOf(kind, scope), { hint_last4: hint, key_version: dek.version }, at),
      ...(config ? configStmts(ctx, kind, scope, config, at) : []),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new SecretConflictError(); // lost a race with another set
    throw e;
  }
  return (await getSecretMeta(ctx, kind, scope))!;
}

/** Replace an existing secret (admin+): new ciphertext, fresh IV, `rotated_at`, and the old value's
 *  `last_error` cleared. None stored → `SecretNotFoundError`. */
export async function rotateSecret(ctx: TenantContext, kind: IntegrationKind, scope: string, value: string): Promise<SecretMeta> {
  requireRole(ctx, "admin");
  const problem = secretValueProblem(kind, value);
  if (problem) throw new SecretValueError(problem);
  if (!(await getSecretMeta(ctx, kind, scope))) throw new SecretNotFoundError();
  const dek = await activeDek(ctx);
  const sealed = await seal(dek.key, secretAad(ctx.orgId, kind, scope), value);
  const at = nowIso();
  const hint = hintOf(value);
  await batch(ctx, [
    stmt(ctx, `UPDATE org_secrets SET ciphertext = ?, iv = ?, key_version = ?, hint_last4 = ?, rotated_at = ?, last_error = NULL WHERE org_id = ? AND kind = ? AND scope = ?`,
      sealed.ciphertext, sealed.iv, dek.version, hint, at, ctx.orgId, kind, scope),
    auditStmt(ctx, "secret.rotate", targetOf(kind, scope), { hint_last4: hint, key_version: dek.version }, at),
  ]);
  const meta = await getSecretMeta(ctx, kind, scope);
  if (!meta) throw new SecretNotFoundError(); // deleted underneath us
  return meta;
}

/**
 * The statements that delete each of `targets` that is actually stored, each with its `secret.delete`
 * audit row — for a caller that removes secrets inside its OWN batch (deleting an environment or a
 * repo deletes its secrets with it, §8.7.3). Empty when none is stored.
 */
export async function secretDeleteStmts(
  ctx: TenantContext, targets: readonly { kind: IntegrationKind; scope: string }[], reason?: string, at: string = nowIso()
): Promise<Stmt[]> {
  requireRole(ctx, "admin");
  const out: Stmt[] = [];
  for (const t of targets) {
    const meta = await getSecretMeta(ctx, t.kind, t.scope);
    if (!meta) continue;
    out.push(
      stmt(ctx, `DELETE FROM org_secrets WHERE org_id = ? AND kind = ? AND scope = ?`, ctx.orgId, t.kind, t.scope),
      auditStmt(ctx, "secret.delete", targetOf(t.kind, t.scope), { hint_last4: meta.hint_last4, ...(reason ? { reason } : {}) }, at),
    );
  }
  return out;
}

/** Delete a secret (admin+). None stored → `SecretNotFoundError`. */
export async function deleteSecret(ctx: TenantContext, kind: IntegrationKind, scope: string): Promise<void> {
  const stmts = await secretDeleteStmts(ctx, [{ kind, scope }]);
  if (stmts.length === 0) throw new SecretNotFoundError();
  await batch(ctx, stmts);
}

// ── the only decrypt path ────────────────────────────────────────────────────

/**
 * Decrypt the org's secret for (kind, scope), or null when none is stored. THROWS for an MCP context
 * (`via: "bearer"`) and for a plain member; serves `system` contexts (cron, webhook) and admin / owner
 * session contexts (Test connection, Poll now, Sync GitHub). Writes nothing — a caller that USED the
 * credential reports it with `recordSecretOutcome` / `markSecretUsed`.
 */
export async function getSecret(ctx: TenantContext, kind: IntegrationKind, scope: string): Promise<Secret | null> {
  if (ctx.via === "bearer" || ctx.role === "member") throw new SecretAccessError();
  const row = await first<{ ciphertext: string; iv: string; key_version: number }>(ctx,
    `SELECT ciphertext, iv, key_version FROM org_secrets WHERE org_id = ? AND kind = ? AND scope = ?`, ctx.orgId, kind, scope);
  if (!row) return null;
  const target = targetOf(kind, scope);
  const key = await first<KeyRow>(ctx, `SELECT ${KEY_COLS} FROM org_keys WHERE org_id = ? AND key_version = ?`, ctx.orgId, row.key_version);
  if (!key) throw new SecretDecryptError(target);
  const dek = await unwrapDek(ctx, key);
  return new Secret(await open(dek, secretAad(ctx.orgId, kind, scope), row.ciphertext, row.iv, target));
}

export const LAST_USED_THROTTLE_MS = 10 * 60_000;

const usedStmt = (ctx: TenantContext, kind: IntegrationKind, scope: string, now: number): Stmt =>
  stmt(ctx, `UPDATE org_secrets SET last_used_at = ? WHERE org_id = ? AND kind = ? AND scope = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
    new Date(now).toISOString(), ctx.orgId, kind, scope, new Date(now - LAST_USED_THROTTLE_MS).toISOString());

/** Bump `last_used_at` — at most once per 10 minutes per row (a no-op UPDATE otherwise). */
export async function markSecretUsed(ctx: TenantContext, kind: IntegrationKind, scope: string, now: number = Date.now()): Promise<void> {
  await batch(ctx, [usedStmt(ctx, kind, scope, now)]);
}

/**
 * What a use of the credential came to. Success clears `last_error` and bumps `last_used_at`
 * (throttled); failure stores the message — scrubbed of `revealed` FIRST, then cut to 300 characters.
 * A no-op when the org has no row for it (the legacy env fallback, §8.7.6).
 */
export async function recordSecretOutcome(
  ctx: TenantContext, kind: IntegrationKind, scope: string,
  outcome: { ok: true } | { ok: false; message: string; revealed: Revealed }, now: number = Date.now()
): Promise<void> {
  if (outcome.ok) {
    await batch(ctx, [
      usedStmt(ctx, kind, scope, now),
      stmt(ctx, `UPDATE org_secrets SET last_error = NULL WHERE org_id = ? AND kind = ? AND scope = ? AND last_error IS NOT NULL`, ctx.orgId, kind, scope),
    ]);
    return;
  }
  await run(ctx, `UPDATE org_secrets SET last_error = ? WHERE org_id = ? AND kind = ? AND scope = ?`,
    lastErrorText(outcome.message, outcome.revealed), ctx.orgId, kind, scope);
}

// ── DEK rotation ─────────────────────────────────────────────────────────────

export interface KeyRotation { rotated: boolean; key_version: number | null; secrets: number }

/**
 * Rotate the org's data key (OWNER): a new version, every secret re-encrypted under it, the old version
 * retired — ONE batch, audited `key.rotate`. An org with no key yet has nothing to rotate. A secret
 * that does not decrypt stops the rotation (`SecretDecryptError` names its kind:scope) — delete or
 * rotate that one, then retry. A secret written while this runs keeps its (retired, still readable)
 * version: the re-encrypt is guarded on the IV it read.
 */
export async function rotateOrgKey(ctx: TenantContext): Promise<KeyRotation> {
  requireRole(ctx, "owner");
  const old = await activeKeyRow(ctx);
  if (!old) return { rotated: false, key_version: null, secrets: 0 };
  const oldDek = await unwrapDek(ctx, old);
  const top = await first<{ v: number }>(ctx, `SELECT MAX(key_version) AS v FROM org_keys WHERE org_id = ?`, ctx.orgId);
  const version = (top?.v ?? old.key_version) + 1;
  const wrapped = await wrapNewDek(ctx, version);
  const newDek = await unwrapDek(ctx, wrapped);
  const rows = await all<{ kind: IntegrationKind; scope: string; ciphertext: string; iv: string; key_version: number }>(ctx,
    `SELECT kind, scope, ciphertext, iv, key_version FROM org_secrets WHERE org_id = ? AND key_version = ?`, ctx.orgId, old.key_version);
  const at = nowIso();
  const stmts: Stmt[] = [insertKeyStmt(ctx, wrapped, at)];
  for (const r of rows) {
    const aad = secretAad(ctx.orgId, r.kind, r.scope);
    const sealed = await seal(newDek, aad, await open(oldDek, aad, r.ciphertext, r.iv, targetOf(r.kind, r.scope)));
    stmts.push(stmt(ctx, `UPDATE org_secrets SET ciphertext = ?, iv = ?, key_version = ? WHERE org_id = ? AND kind = ? AND scope = ? AND key_version = ? AND iv = ?`,
      sealed.ciphertext, sealed.iv, version, ctx.orgId, r.kind, r.scope, old.key_version, r.iv));
  }
  stmts.push(
    stmt(ctx, `UPDATE org_keys SET retired_at = ? WHERE org_id = ? AND key_version = ?`, at, ctx.orgId, old.key_version),
    auditStmt(ctx, "key.rotate", "org_keys", { key_version: version, from_version: old.key_version, secrets: rows.length }, at),
  );
  await batch(ctx, stmts);
  return { rotated: true, key_version: version, secrets: rows.length };
}

/** The org's current data-key version, or null before its first secret. */
export async function currentKeyVersion(ctx: TenantContext): Promise<number | null> {
  return (await activeKeyRow(ctx))?.key_version ?? null;
}

// ── the cut-over bridge (§8.7.6) ─────────────────────────────────────────────

// SaplingLearn's credentials are still Worker secrets until its owner enters each through the
// Integrations page; ONLY this org may fall back to them, and only while it has no row for the
// kind / scope. Phase 7 deletes the fallback, this constant and those Worker secrets.
const LEGACY_ENV_ORG = SAPLINGLEARN_ORG_ID;

/** `RAILWAY_TOKEN_<KEY>` — src/repo/cron.ts `railwayTokens`' naming (key upper-cased, non-alphanumerics → `_`). */
const railwayEnvName = (scope: string): string => `RAILWAY_TOKEN_${scope.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/** The legacy Worker secret that answers for (kind, scope), or null. Does NOT check the org. */
async function legacyEnvValue(ctx: TenantContext, env: Env, kind: IntegrationKind, scope: string): Promise<string | null> {
  const pick = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  switch (kind) {
    case "github_token": return scope === "" ? pick(env.GITHUB_SERVICE_TOKEN) : null;
    case "cloudflare_analytics": return scope === "" ? pick(env.CF_ANALYTICS_TOKEN) : null;
    case "railway": return scope ? pick((env as unknown as Record<string, unknown>)[railwayEnvName(scope)]) : null;
    case "metrics_endpoint": return scope ? pick(env.SAPLING_METRICS_TOKEN) : null; // ONE token for every environment
    case "github_webhook": {
      // Only the repo the old /webhook/github still routes to (`legacy_hook = 1`, §8.5).
      if (!pick(env.GITHUB_WEBHOOK_SECRET)) return null;
      const repo = await first<{ legacy_hook: number }>(ctx, `SELECT legacy_hook FROM org_repos WHERE org_id = ? AND id = ?`, ctx.orgId, scope);
      return repo?.legacy_hook === 1 ? pick(env.GITHUB_WEBHOOK_SECRET) : null;
    }
  }
}

/**
 * The credential a poller / the webhook should use: the org's stored secret if there is one; otherwise,
 * ONLY for `org_saplinglearn`, the matching legacy Worker secret; otherwise null. Same access rule as
 * `getSecret` (it throws for a bearer or member context before anything is looked up).
 */
export async function resolveCredential(ctx: TenantContext, env: Env, kind: IntegrationKind, scope: string): Promise<Secret | null> {
  const stored = await getSecret(ctx, kind, scope);
  if (stored) return stored;
  if (ctx.orgId !== LEGACY_ENV_ORG) return null;
  const legacy = await legacyEnvValue(ctx, env, kind, scope);
  return legacy === null ? null : new Secret(legacy);
}

/** Is a legacy Worker secret answering for (kind, scope)? For the page's "still on the old secret" note. */
export async function hasLegacyCredential(ctx: TenantContext, env: Env, kind: IntegrationKind, scope: string): Promise<boolean> {
  return ctx.orgId === LEGACY_ENV_ORG && (await legacyEnvValue(ctx, env, kind, scope)) !== null;
}

/** Cloudflare's account id (not a secret — `org_integration_config`), with the same SaplingLearn-only
 *  fallback to `CF_ANALYTICS_ACCOUNT_ID`. */
export async function resolveCloudflareAccountId(ctx: TenantContext, env: Env): Promise<string | null> {
  const stored = (await getIntegrationConfig(ctx, "cloudflare_analytics", "")).account_id;
  if (stored) return stored;
  return ctx.orgId === LEGACY_ENV_ORG && env.CF_ANALYTICS_ACCOUNT_ID ? env.CF_ANALYTICS_ACCOUNT_ID : null;
}
