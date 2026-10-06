// The org's repositories and environments (canopy-multitenancy.md §2.1, D16): what GITHUB_REPO and
// REPO_ENVIRONMENTS were, as rows an admin edits. The integrations hang off them — a repo's id is its
// webhook path id and its `github_webhook` scope; an environment's key is the `railway` /
// `metrics_endpoint` scope — so removing one removes its secrets in the SAME batch, audited.
//
// Every change here writes an audit row in the SAME batch. `org_audit.action` (0037) has a CHECK that
// admits only the five secret / key actions, so a repo or environment change goes to `org_admin_audit`
// (0043; actions in shared/orgs.ts) and the secret deletions it causes stay in `org_audit`; the page's
// history (`listOrgAudit`, src/data/secrets.ts) reads both as one list. A row names WHAT changed — a
// repo, an environment key, the fields touched — never a field's value.
import type { IntegrationKind, OrgEnvironmentDTO, OrgRepoDTO, OrgSettingsAuditAction } from "@shared/integrations";
import { checkFetchUrl, FetchUrlError } from "../artifacts/fetch-url";
import { requireRole } from "../data/context";
import { listSecretMeta, secretDeleteStmts } from "../data/secrets";
import { all, batch, first, nowIso, stmt, type Stmt, type TenantContext } from "../data/sql";

/** A refused settings write. `message` is fixed text — it names the field, never the submitted value. */
export class SettingsError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409, message: string, readonly field?: string) {
    super(message);
    this.name = "SettingsError";
  }
}
const invalid = (field: string, message: string) => new SettingsError("invalid", 400, message, field);

/** One `org_admin_audit` row for this org, by the acting member — always a statement of the change's own batch. */
const auditStmt = (ctx: TenantContext, action: OrgSettingsAuditAction, target: string, detail: Record<string, unknown>, at: string): Stmt =>
  stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, ctx.userId, action, target, JSON.stringify(detail), at);

// ── repos ────────────────────────────────────────────────────────────────────

export interface OrgRepoRow { id: string; repo_full_name: string; is_primary: number; legacy_hook: number; created_at: string; created_by: string }
const REPO_COLS = `id, repo_full_name, is_primary, legacy_hook, created_at, created_by`;
export const MAX_ORG_REPOS = 10;
// GitHub's own shape: an owner login (≤ 39, alphanumerics and inner hyphens) and a repository name.
const REPO_FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export const listRepoRows = (ctx: TenantContext): Promise<OrgRepoRow[]> =>
  all<OrgRepoRow>(ctx, `SELECT ${REPO_COLS} FROM org_repos WHERE org_id = ? ORDER BY is_primary DESC, created_at, id`, ctx.orgId);

/** The org's primary repository (`owner/repo`), or null. */
export async function primaryRepo(ctx: TenantContext): Promise<string | null> {
  const row = await first<{ repo_full_name: string }>(ctx, `SELECT repo_full_name FROM org_repos WHERE org_id = ? AND is_primary = 1`, ctx.orgId);
  return row?.repo_full_name ?? null;
}

/** The Payload URL an admin configures in GitHub for one repo (§8.5): `<origin>/webhook/github/<org_repos.id>`. */
export const webhookUrl = (origin: string, hookId: string): string => `${origin.replace(/\/+$/, "")}/webhook/github/${hookId}`;

/** Wire shape. A non-admin sees the repo, not its hook id or URL (§8.5: hook ids are not handed out). */
export async function listRepos(ctx: TenantContext, origin: string, admin: boolean): Promise<OrgRepoDTO[]> {
  const [rows, secrets] = [await listRepoRows(ctx), admin ? await listSecretMeta(ctx) : []];
  const hooked = new Set(secrets.filter((s) => s.kind === "github_webhook").map((s) => s.scope));
  return rows.map((r) => ({
    id: admin ? r.id : null,
    repo_full_name: r.repo_full_name,
    is_primary: r.is_primary === 1,
    legacy_hook: r.legacy_hook === 1,
    webhook_url: admin ? webhookUrl(origin, r.id) : null,
    webhook_secret_configured: hooked.has(r.id),
    created_at: r.created_at,
    created_by: r.created_by,
  }));
}

const newHookId = (): string =>
  "hook_" + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Add a repository (admin+). The org's FIRST repo is its primary; `is_primary: true` on a later one
 * moves the primary to it — and naming a repo the org already has, with `is_primary: true`, promotes
 * that one. Returns the row's id.
 */
export async function addRepo(ctx: TenantContext, input: { repo_full_name: unknown; is_primary?: unknown }): Promise<{ id: string; created: boolean }> {
  requireRole(ctx, "admin");
  const name = typeof input.repo_full_name === "string" ? input.repo_full_name.trim() : "";
  if (!REPO_FULL_NAME.test(name)) throw invalid("repo_full_name", "repo_full_name must be owner/repo");
  if (input.is_primary !== undefined && typeof input.is_primary !== "boolean") throw invalid("is_primary", "is_primary must be true or false");
  const rows = await listRepoRows(ctx);
  const held = rows.find((r) => r.repo_full_name.toLowerCase() === name.toLowerCase());
  const unsetPrimary = stmt(ctx, `UPDATE org_repos SET is_primary = 0 WHERE org_id = ? AND is_primary = 1`, ctx.orgId);
  if (held) {
    if (input.is_primary !== true) throw new SettingsError("repo_exists", 409, "that repository is already connected");
    if (held.is_primary !== 1) {
      await batch(ctx, [
        unsetPrimary,
        stmt(ctx, `UPDATE org_repos SET is_primary = 1 WHERE org_id = ? AND id = ?`, ctx.orgId, held.id),
        auditStmt(ctx, "repo.primary", held.repo_full_name, {}, nowIso()),
      ]);
    }
    return { id: held.id, created: false };
  }
  if (rows.length >= MAX_ORG_REPOS) throw new SettingsError("too_many_repos", 409, `an org can connect at most ${MAX_ORG_REPOS} repositories`);
  const primary = rows.length === 0 || input.is_primary === true;
  const id = newHookId();
  const at = nowIso();
  await batch(ctx, [
    ...(primary && rows.length > 0 ? [unsetPrimary] : []),
    stmt(ctx, `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by) VALUES (?, ?, ?, ?, 0, ?, ?)`,
      id, ctx.orgId, name, primary ? 1 : 0, at, ctx.userId),
    auditStmt(ctx, "repo.add", name, { primary }, at),
  ]);
  return { id, created: true };
}

/** Remove a repository and its webhook secret, one batch (admin+). The primary can only go last: make
 *  another repo primary first. Returns the audit targets of the secrets removed with it. */
export async function removeRepo(ctx: TenantContext, id: string): Promise<string[]> {
  requireRole(ctx, "admin");
  const rows = await listRepoRows(ctx);
  const row = rows.find((r) => r.id === id);
  if (!row) throw new SettingsError("not_found", 404, "no such repository");
  if (row.is_primary === 1 && rows.length > 1) throw new SettingsError("primary_repo", 409, "make another repository the primary before removing this one");
  const at = nowIso();
  const secrets = await secretDeleteStmts(ctx, [{ kind: "github_webhook", scope: id }], "repo_removed", at);
  const removed = secrets.length ? [`github_webhook:${id}`] : [];
  await batch(ctx, [
    ...secrets,
    stmt(ctx, `DELETE FROM org_repos WHERE org_id = ? AND id = ?`, ctx.orgId, id),
    auditStmt(ctx, "repo.remove", row.repo_full_name, { removed_secrets: removed }, at),
  ]);
  return removed;
}

// ── environments ─────────────────────────────────────────────────────────────

const ENV_COLS = `key, position, label, note, branch, railway_env, worker, worker_check, frontend_url, api_url, health_path,
  railway_environment_id, railway_service_id, created_at, updated_at, updated_by`;
export const MAX_ORG_ENVIRONMENTS = 10;
const ENV_KEY = /^[a-z0-9_-]{1,32}$/; // 0037's CHECK
/** The integrations whose scope is an environment key. */
const ENV_SECRET_KINDS: readonly IntegrationKind[] = ["railway", "metrics_endpoint"];

export const listEnvironments = (ctx: TenantContext): Promise<OrgEnvironmentDTO[]> =>
  all<OrgEnvironmentDTO>(ctx, `SELECT ${ENV_COLS} FROM org_environments WHERE org_id = ? ORDER BY position`, ctx.orgId);

type EnvFields = Omit<OrgEnvironmentDTO, "key" | "position" | "created_at" | "updated_at" | "updated_by">;
const TEXT_FIELDS = ["label", "branch", "railway_env", "worker", "worker_check", "frontend_url", "api_url", "health_path"] as const;
const NULLABLE_FIELDS = ["note", "railway_environment_id", "railway_service_id"] as const;
const FIELD_MAX: Record<keyof EnvFields, number> = {
  label: 60, note: 120, branch: 255, railway_env: 200, worker: 200, worker_check: 200,
  frontend_url: 500, api_url: 500, health_path: 200, railway_environment_id: 100, railway_service_id: 100,
};

/** `""`, or an https URL the Worker may fetch (`checkFetchUrl`: no credentials, no private / loopback /
 *  link-local address) with no query or fragment — the pollers append a path to it. */
function checkUrlField(field: "frontend_url" | "api_url", value: string): void {
  if (value === "") return;
  let u: URL;
  try { u = checkFetchUrl(value); } catch (e) { throw invalid(field, `${field}: ${e instanceof FetchUrlError ? e.message : "not a valid URL"}`); }
  if (u.search || u.hash) throw invalid(field, `${field} must not carry a query string or a fragment`);
}

const originOf = (url: string): string => { try { return new URL(url).origin; } catch { return ""; } };

/** Merge a PUT body over the current row (or the defaults), then check the whole. Unknown fields are refused. */
function mergeEnvironment(current: OrgEnvironmentDTO | null, key: string, body: Record<string, unknown>): EnvFields {
  const next: EnvFields = current
    ? { label: current.label, note: current.note, branch: current.branch, railway_env: current.railway_env, worker: current.worker,
        worker_check: current.worker_check, frontend_url: current.frontend_url, api_url: current.api_url, health_path: current.health_path,
        railway_environment_id: current.railway_environment_id, railway_service_id: current.railway_service_id }
    : { label: key, note: null, branch: "", railway_env: "", worker: "", worker_check: "", frontend_url: "", api_url: "", health_path: "/",
        railway_environment_id: null, railway_service_id: null };
  for (const field of Object.keys(body)) {
    const v = body[field];
    if ((TEXT_FIELDS as readonly string[]).includes(field)) {
      if (typeof v !== "string") throw invalid(field, `${field} must be a string`);
      (next as unknown as Record<string, string>)[field] = v.trim();
    } else if ((NULLABLE_FIELDS as readonly string[]).includes(field)) {
      if (v !== null && typeof v !== "string") throw invalid(field, `${field} must be a string or null`);
      (next as unknown as Record<string, string | null>)[field] = typeof v === "string" && v.trim() ? v.trim() : null;
    } else {
      throw invalid("body", "the body has a field an environment does not have"); // never quoted back
    }
  }
  for (const field of Object.keys(FIELD_MAX) as (keyof EnvFields)[]) {
    const v = next[field];
    if (typeof v === "string" && v.length > FIELD_MAX[field]) throw invalid(field, `${field} is longer than ${FIELD_MAX[field]} characters`);
    if (typeof v === "string" && /[\u0000-\u001f\u007f]/.test(v)) throw invalid(field, `${field} contains a control character`);
  }
  if (!next.label) throw invalid("label", "label is required");
  if (!next.branch) throw invalid("branch", "branch is required");
  if (/\s/.test(next.branch)) throw invalid("branch", "branch must not contain whitespace");
  if (!next.health_path.startsWith("/")) throw invalid("health_path", "health_path must start with /");
  checkUrlField("frontend_url", next.frontend_url);
  checkUrlField("api_url", next.api_url);
  for (const field of ["railway_environment_id", "railway_service_id"] as const) {
    if (next[field] !== null && !/^[A-Za-z0-9-]+$/.test(next[field]!)) throw invalid(field, `${field} must be an id (letters, digits and hyphens)`);
  }
  return next;
}

export interface EnvironmentWrite { environment: OrgEnvironmentDTO; created: boolean; removed_secrets: string[] }

/**
 * Create or update one environment (admin+). A body field left out keeps its current value; a new
 * environment takes the next position (the new drift base). Pointing `api_url` at ANOTHER origin
 * deletes the environment's `metrics_endpoint` secret in the same batch: that token goes to `api_url`,
 * and a write-only secret must not become readable by re-aiming it at a host of the editor's choosing.
 */
export async function putEnvironment(ctx: TenantContext, key: string, body: Record<string, unknown>): Promise<EnvironmentWrite> {
  requireRole(ctx, "admin");
  if (!ENV_KEY.test(key)) throw invalid("key", "key must be 1–32 characters: a–z, 0–9, _ or -");
  const envs = await listEnvironments(ctx);
  const current = envs.find((e) => e.key === key) ?? null;
  if (!current && envs.length >= MAX_ORG_ENVIRONMENTS) throw new SettingsError("too_many_environments", 409, `an org can have at most ${MAX_ORG_ENVIRONMENTS} environments`);
  const next = mergeEnvironment(current, key, body);
  const at = nowIso();
  const values = [next.label, next.note, next.branch, next.railway_env, next.worker, next.worker_check, next.frontend_url, next.api_url,
    next.health_path, next.railway_environment_id, next.railway_service_id];
  let secrets: Stmt[] = [];
  if (current && current.api_url && originOf(current.api_url) !== originOf(next.api_url)) {
    secrets = await secretDeleteStmts(ctx, [{ kind: "metrics_endpoint", scope: key }], "api_url_changed", at);
  }
  const write = current
    ? stmt(ctx, `UPDATE org_environments SET label = ?, note = ?, branch = ?, railway_env = ?, worker = ?, worker_check = ?, frontend_url = ?, api_url = ?,
                 health_path = ?, railway_environment_id = ?, railway_service_id = ?, updated_at = ?, updated_by = ? WHERE org_id = ? AND key = ?`,
        ...values, at, ctx.userId, ctx.orgId, key)
    : stmt(ctx, `INSERT INTO org_environments (org_id, key, position, label, note, branch, railway_env, worker, worker_check, frontend_url, api_url,
                 health_path, railway_environment_id, railway_service_id, created_at, updated_at, updated_by)
                 VALUES (?, ?, (SELECT COALESCE(MAX(e.position), -1) + 1 FROM org_environments e WHERE e.org_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.orgId, key, ctx.orgId, ...values, at, at, ctx.userId);
  const removed = secrets.length ? [`metrics_endpoint:${key}`] : [];
  // The audit row lists the FIELDS that changed, not their values.
  const fields = (Object.keys(FIELD_MAX) as (keyof EnvFields)[]).filter((f) => !current || current[f] !== next[f]);
  await batch(ctx, [...secrets, write, auditStmt(ctx, "environment.set", key, { created: !current, fields, removed_secrets: removed }, at)]);
  const environment = (await listEnvironments(ctx)).find((e) => e.key === key);
  if (!environment) throw new SettingsError("not_found", 404, "no such environment");
  return { environment, created: !current, removed_secrets: removed };
}

// Positions are UNIQUE per org, so a renumbering goes through the negatives: every moved row is parked
// at a distinct negative position, then flipped back (`-p - 1`), all in the caller's one batch.
const unparkStmt = (ctx: TenantContext): Stmt =>
  stmt(ctx, `UPDATE org_environments SET position = -position - 1 WHERE org_id = ? AND position < 0`, ctx.orgId);

/** Reorder the environments (admin+): `order` is every key exactly once; [0] is the drift head. */
export async function reorderEnvironments(ctx: TenantContext, order: unknown): Promise<OrgEnvironmentDTO[]> {
  requireRole(ctx, "admin");
  const envs = await listEnvironments(ctx);
  const keys = new Set(envs.map((e) => e.key));
  if (!Array.isArray(order) || order.length !== keys.size || new Set(order).size !== order.length || !order.every((k) => typeof k === "string" && keys.has(k))) {
    throw invalid("order", "order must list every environment key exactly once");
  }
  if (order.length > 0) {
    await batch(ctx, [
      ...(order as string[]).map((key, i) => stmt(ctx, `UPDATE org_environments SET position = ? WHERE org_id = ? AND key = ?`, -(i + 1), ctx.orgId, key)),
      unparkStmt(ctx),
      auditStmt(ctx, "environment.reorder", "environments", { order }, nowIso()),
    ]);
  }
  return listEnvironments(ctx);
}

/** Delete an environment, its `railway` / `metrics_endpoint` secrets and close the gap in the order —
 *  one batch (admin+, §8.7.3). Returns the audit targets of the secrets removed with it. */
export async function deleteEnvironment(ctx: TenantContext, key: string): Promise<string[]> {
  requireRole(ctx, "admin");
  const row = await first<{ position: number }>(ctx, `SELECT position FROM org_environments WHERE org_id = ? AND key = ?`, ctx.orgId, key);
  if (!row) throw new SettingsError("not_found", 404, "no such environment");
  const targets = ENV_SECRET_KINDS.map((kind) => ({ kind, scope: key }));
  const held = new Set((await listSecretMeta(ctx)).map((s) => `${s.kind}:${s.scope}`));
  const at = nowIso();
  const secrets = await secretDeleteStmts(ctx, targets, "environment_deleted", at);
  const removed = targets.map((t) => `${t.kind}:${t.scope}`).filter((t) => held.has(t));
  await batch(ctx, [
    ...secrets,
    stmt(ctx, `DELETE FROM org_integration_config WHERE org_id = ? AND scope = ? AND kind IN ('railway', 'metrics_endpoint')`, ctx.orgId, key),
    stmt(ctx, `DELETE FROM org_environments WHERE org_id = ? AND key = ?`, ctx.orgId, key),
    stmt(ctx, `UPDATE org_environments SET position = -position WHERE org_id = ? AND position > ?`, ctx.orgId, row.position),
    unparkStmt(ctx),
    auditStmt(ctx, "environment.delete", key, { removed_secrets: removed }, at),
  ]);
  return removed;
}
