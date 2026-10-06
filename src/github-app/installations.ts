// The GitHub App's D1 repository (spec §5): `github_installations`, `github_installation_repos` and
// `org_repos.installation_id` (0048). Every statement here is a TENANT statement — it names and binds
// `ctx.orgId` — except `installationOwner`, the one PLATFORM read: which org owns installation N, asked
// before any org is known (the App webhook) and by the bind ("is N bound to ANOTHER org?"). It returns an
// org id and two suspension flags, never content (test/data-layer.static.test.ts, PLATFORM_ALLOW).
//
// Every change writes its `org_admin_audit` row(s) in the SAME batch (shared/orgs.ts's actions): an
// installation bound (`github.connect`) or forgotten (`github.disconnect` by an admin, `github.uninstall`
// by GitHub), suspended / unsuspended, its repository list changed (`github.repos`, counts only), and an
// `org_repos` row attached to (`repo.attach`) or detached from (`repo.detach`) an installation. A row names
// the account or the repository; it never holds a credential — none passes through this module.
import { installationManageUrl, type GithubAppStateDTO, type GithubInstallationDTO, type GithubInstallationRepoDTO } from "@shared/github-app";
import type { OrgSettingsAuditAction } from "@shared/integrations";
import type { Env } from "../env";
import { hasRole, RoleError } from "../data/context";
import { all, batch, chunked, first, nowIso, ph, run, stmt, type Stmt, type TenantContext } from "../data/sql";
import { first as platformFirst, type PlatformContext } from "../data/platform-sql";
import type { AppInstallation, InstallationRepo } from "./client";
import { githubAppConfig } from "./config";

// ── errors ───────────────────────────────────────────────────────────────────

/** The installation is bound to ANOTHER org. The message never names that org. */
export class InstallationBoundElsewhereError extends Error {
  readonly code = "bound_elsewhere" as const;
  constructor() { super("this GitHub App installation is already connected to another Trov organization"); this.name = "InstallationBoundElsewhereError"; }
}

/** No installation with that id is bound to THIS org (another org's reads the same). */
export class InstallationNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor() { super("no such GitHub App installation"); this.name = "InstallationNotFoundError"; }
}

// ── gates ────────────────────────────────────────────────────────────────────

/** A human write (the bind): an admin's session — never a bearer, never a system context. */
function requireAdmin(ctx: TenantContext): void {
  if (ctx.via === "bearer" || !hasRole(ctx, "admin")) throw new RoleError();
}

/** A write GitHub may cause too (an uninstall, a repository-list change): an admin, or the system tenant
 *  the App webhook runs as. Never a bearer — nothing an agent holds reaches this module. */
function requireAdminOrSystem(ctx: TenantContext): void {
  if (ctx.via === "bearer" || (ctx.role !== "system" && !hasRole(ctx, "admin"))) throw new RoleError();
}

// ── rows ─────────────────────────────────────────────────────────────────────

interface InstallationRow {
  installation_id: number;
  account_login: string;
  account_id: number;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
  suspended_at: string | null;
  connected_by: string;
  connected_at: string;
  updated_at: string;
  last_delivery_at: string | null;
  repos_synced_at: string | null;
}
const INST_COLS = `installation_id, account_login, account_id, account_type, repository_selection, suspended_at, connected_by, connected_at,
  updated_at, last_delivery_at, repos_synced_at`;

interface RepoRow { repo_id: number; repo_full_name: string; private: number }
interface OrgRepoLite { id: string; repo_full_name: string; installation_id: number | null }

const installationRow = (ctx: TenantContext, installationId: number): Promise<InstallationRow | null> =>
  first<InstallationRow>(ctx, `SELECT ${INST_COLS} FROM github_installations WHERE org_id = ? AND installation_id = ?`, ctx.orgId, installationId);

const installationRepoRows = (ctx: TenantContext, installationId: number): Promise<RepoRow[]> =>
  all<RepoRow>(ctx, `SELECT repo_id, repo_full_name, private FROM github_installation_repos WHERE org_id = ? AND installation_id = ?`, ctx.orgId, installationId);

const orgRepoRows = (ctx: TenantContext): Promise<OrgRepoLite[]> =>
  all<OrgRepoLite>(ctx, `SELECT id, repo_full_name, installation_id FROM org_repos WHERE org_id = ? ORDER BY created_at, id`, ctx.orgId);

const auditStmt = (ctx: TenantContext, actor: string, action: OrgSettingsAuditAction, target: string, detail: Record<string, unknown>, at: string): Stmt =>
  stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, actor, action, target, JSON.stringify(detail), at);

/** A positive integer id — GitHub's ids are, and a path or a payload may carry anything. */
function checkInstallationId(id: unknown): number {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new TypeError("installation id must be a positive integer");
  return id;
}

/** The repositories as GitHub listed them, de-duplicated by id; an entry without a numeric id and an
 *  `owner/repo` name is dropped (a malformed payload item must not cost the rest of the list). */
function cleanRepos(repos: readonly unknown[]): InstallationRepo[] {
  const out = new Map<number, InstallationRepo>();
  for (const v of repos) {
    const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    if (typeof r.id !== "number" || !Number.isSafeInteger(r.id) || r.id <= 0) continue;
    if (typeof r.full_name !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(r.full_name) || r.full_name.length > 200) continue;
    out.set(r.id, { id: r.id, full_name: r.full_name, private: r.private === true });
  }
  return [...out.values()];
}

// D1 binds at most 100 parameters per statement: 20 rows of 5.
const REPO_ROWS_PER_INSERT = 20;

function insertRepoStmts(ctx: TenantContext, installationId: number, repos: InstallationRepo[]): Stmt[] {
  const out: Stmt[] = [];
  for (let i = 0; i < repos.length; i += REPO_ROWS_PER_INSERT) {
    const chunk = repos.slice(i, i + REPO_ROWS_PER_INSERT);
    out.push(stmt(ctx,
      `INSERT INTO github_installation_repos (org_id, installation_id, repo_id, repo_full_name, private) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
      ...chunk.flatMap((r) => [ctx.orgId, installationId, r.id, r.full_name, r.private ? 1 : 0])));
  }
  return out;
}

const deleteRepoStmts = (ctx: TenantContext, installationId: number, repoIds: number[]): Stmt[] =>
  chunked(repoIds).map((ids) => stmt(ctx,
    `DELETE FROM github_installation_repos WHERE org_id = ? AND installation_id = ? AND repo_id IN (${ph(ids.length)})`, ctx.orgId, installationId, ...ids));

/**
 * The `org_repos` side of a repository list: a row ATTACHED to this installation whose name the list no
 * longer holds is DETACHED (`installation_id = NULL` — it falls back to the pasted token), and a row with
 * NO installation whose name the list holds is ATTACHED. Names compare case-insensitively, as GitHub's do
 * (both columns are NOCASE). A row attached to some OTHER installation is left alone. Each change is one
 * guarded UPDATE by row id plus its audit row, for the caller's batch.
 */
function attachments(ctx: TenantContext, installationId: number, rows: OrgRepoLite[], covered: Set<string>, actor: string, at: string):
  { stmts: Stmt[]; attached: string[]; detached: string[] } {
  const stmts: Stmt[] = [];
  const attached: string[] = [];
  const detached: string[] = [];
  for (const r of rows) {
    const held = covered.has(r.repo_full_name.toLowerCase());
    if (r.installation_id === installationId && !held) {
      detached.push(r.repo_full_name);
      stmts.push(
        stmt(ctx, `UPDATE org_repos SET installation_id = NULL WHERE org_id = ? AND id = ? AND installation_id = ?`, ctx.orgId, r.id, installationId),
        auditStmt(ctx, actor, "repo.detach", r.repo_full_name, { installation_id: installationId }, at),
      );
    } else if (r.installation_id === null && held) {
      attached.push(r.repo_full_name);
      stmts.push(
        stmt(ctx, `UPDATE org_repos SET installation_id = ? WHERE org_id = ? AND id = ? AND installation_id IS NULL`, installationId, ctx.orgId, r.id),
        auditStmt(ctx, actor, "repo.attach", r.repo_full_name, { installation_id: installationId }, at),
      );
    }
  }
  return { stmts, attached, detached };
}

const lowerNames = (repos: Iterable<{ full_name: string }>): Set<string> => new Set([...repos].map((r) => r.full_name.toLowerCase()));

/** How many repository ids `next` has that `prev` had not, and the reverse. */
function countChange(prev: Iterable<number>, next: Iterable<number>): { added: number; removed: number } {
  const p = new Set(prev);
  const n = new Set(next);
  return { added: [...n].filter((id) => !p.has(id)).length, removed: [...p].filter((id) => !n.has(id)).length };
}

// ── the platform read ────────────────────────────────────────────────────────

export interface InstallationOwner { org_id: string; suspended_at: string | null; org_suspended: boolean }

/**
 * Which org installation N is bound to — the App webhook's first question, and the bind's "bound
 * elsewhere?" check — or null when no org has bound it. Also says whether the INSTALLATION is suspended
 * (GitHub's `installation.suspend`) and whether the ORG is (0043): a suspended org's deliveries are
 * ignored, and its installation stays its own (a second org still cannot bind it).
 */
export async function installationOwner(p: PlatformContext, installationId: number): Promise<InstallationOwner | null> {
  const row = await platformFirst<{ org_id: string; suspended_at: string | null; org_suspended_at: string | null }>(p,
    `SELECT i.org_id, i.suspended_at, o.suspended_at AS org_suspended_at FROM github_installations i JOIN orgs o ON o.id = i.org_id
      WHERE i.installation_id = ?`, checkInstallationId(installationId));
  return row ? { org_id: row.org_id, suspended_at: row.suspended_at, org_suspended: row.org_suspended_at !== null } : null;
}

// ── writes ───────────────────────────────────────────────────────────────────

export interface BindInput {
  /** GitHub's installation object (`getAppInstallation`). */
  installation: AppInstallation;
  /** EVERY repository it covers (`listInstallationRepos`) — the list is replaced, not merged. */
  repos: InstallationRepo[];
  /** The admin who completed the install flow (a handle) — `connected_by` and the audit actor. */
  by: string;
}

export interface BindResult { created: boolean; attached: string[]; detached: string[] }

/**
 * Bind an installation to the caller's org (an ADMIN's session — the install flow, after GitHub confirmed
 * with the admin's own user token that they can read every repository it covers). Refused with
 * `InstallationBoundElsewhereError` when ANOTHER org holds it, and nothing is written. Otherwise ONE batch:
 * the installation row (inserted, or — a re-bind — updated in place, keeping `last_delivery_at`), its repo
 * list replaced, every `org_repos` row of this org the list names and no installation holds ATTACHED (and,
 * on a re-bind, one the list no longer names detached), `github.connect` audited.
 *
 * `p` is the platform context for the one cross-org read (data-layer.md: a repository that touches both
 * kinds takes the tenant ctx and receives `p`). A new binding is a plain INSERT on the installation's
 * primary key, so a second org racing the check fails its whole batch instead of sharing the row — and
 * then reads as bound elsewhere.
 */
export async function bindInstallation(ctx: TenantContext, p: PlatformContext, input: BindInput): Promise<BindResult> {
  requireAdmin(ctx);
  const inst = input.installation;
  const id = checkInstallationId(inst.id);
  const repos = cleanRepos(input.repos);
  const owner = await installationOwner(p, id);
  if (owner && owner.org_id !== ctx.orgId) throw new InstallationBoundElsewhereError();

  const at = nowIso();
  const current = owner ? await installationRepoRows(ctx, id) : [];
  const { stmts: attach, attached, detached } = attachments(ctx, id, await orgRepoRows(ctx), lowerNames(repos), input.by, at);
  const change = countChange(current.map((r) => r.repo_id), repos.map((r) => r.id));
  const fields = [inst.account.login, inst.account.id, inst.account.type, inst.repository_selection, inst.suspended_at, input.by, at, at, at];
  const write = owner
    ? stmt(ctx, `UPDATE github_installations SET account_login = ?, account_id = ?, account_type = ?, repository_selection = ?, suspended_at = ?,
                 connected_by = ?, connected_at = ?, updated_at = ?, repos_synced_at = ? WHERE org_id = ? AND installation_id = ?`,
        ...fields, ctx.orgId, id)
    : stmt(ctx, `INSERT INTO github_installations (installation_id, org_id, account_login, account_id, account_type, repository_selection, suspended_at,
                 connected_by, connected_at, updated_at, repos_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, ctx.orgId, ...fields);
  try {
    await batch(ctx, [
      write,
      stmt(ctx, `DELETE FROM github_installation_repos WHERE org_id = ? AND installation_id = ?`, ctx.orgId, id),
      ...insertRepoStmts(ctx, id, repos),
      ...attach,
      auditStmt(ctx, input.by, "github.connect", inst.account.login, {
        installation_id: id, account_type: inst.account.type, repository_selection: inst.repository_selection,
        repositories: repos.length, added: change.added, removed: change.removed, rebind: owner !== null,
      }, at),
    ]);
  } catch (e) {
    const now = owner ? null : await installationOwner(p, id).catch(() => null);
    if (now && now.org_id !== ctx.orgId) throw new InstallationBoundElsewhereError();
    throw e;
  }
  return { created: owner === null, attached, detached };
}

/** A repository-list change: the FULL list (bind, an admin's Refresh, `installation.created`), or a delta
 *  (`installation_repositories` added / removed — each item at least `{ id, full_name }`). */
export type RepoListChange = InstallationRepo[] | { added?: readonly unknown[]; removed?: readonly unknown[] };

export interface SyncResult { added: number; removed: number; attached: string[]; detached: string[] }

/**
 * Bring an installation's repository list up to date — an admin's Refresh (session) or GitHub's events (the
 * App webhook's system tenant). A full list REPLACES the stored one and stamps `repos_synced_at`; a delta
 * deletes the removed ids and (re)inserts the added ones, touching nothing else, so two deltas never lose
 * each other's rows. Either way the `org_repos` side follows (`attachments`): a repository leaving the list
 * DETACHES its row, one arriving attaches a matching unattached row. `repositorySelection` (the
 * `installation_repositories` payload carries it) is stored when given. `github.repos` is audited with the
 * counts when anything changed. Throws `InstallationNotFoundError` when this org has no such installation.
 */
export async function syncInstallationRepos(
  ctx: TenantContext, installationId: number, change: RepoListChange, actor: string,
  opts: { repositorySelection?: "all" | "selected" } = {},
): Promise<SyncResult> {
  requireAdminOrSystem(ctx);
  const id = checkInstallationId(installationId);
  const row = await installationRow(ctx, id);
  if (!row) throw new InstallationNotFoundError();
  const current = await installationRepoRows(ctx, id);
  const at = nowIso();
  const writes: Stmt[] = [];
  let next: InstallationRepo[];
  const full = Array.isArray(change);
  if (Array.isArray(change)) {
    next = cleanRepos(change);
    writes.push(stmt(ctx, `DELETE FROM github_installation_repos WHERE org_id = ? AND installation_id = ?`, ctx.orgId, id), ...insertRepoStmts(ctx, id, next));
  } else {
    const added = cleanRepos(change.added ?? []);
    const removed = (change.removed ?? []).map((v) => (v && typeof v === "object" ? (v as { id?: unknown }).id : null))
      .filter((v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0);
    const gone = new Set(removed);
    const map = new Map<number, InstallationRepo>(current.map((r) => [r.repo_id, { id: r.repo_id, full_name: r.repo_full_name, private: r.private === 1 }]));
    for (const rid of gone) map.delete(rid);
    for (const r of added) map.set(r.id, r);
    next = [...map.values()];
    writes.push(...deleteRepoStmts(ctx, id, [...new Set([...removed, ...added.map((r) => r.id)])]), ...insertRepoStmts(ctx, id, added));
  }
  const counts = countChange(current.map((r) => r.repo_id), next.map((r) => r.id));
  const selection = opts.repositorySelection === "all" || opts.repositorySelection === "selected" ? opts.repositorySelection : null;
  const { stmts: attach, attached, detached } = attachments(ctx, id, await orgRepoRows(ctx), lowerNames(next), actor, at);
  const changed = counts.added > 0 || counts.removed > 0 || (selection !== null && selection !== row.repository_selection);
  await batch(ctx, [
    ...writes,
    stmt(ctx, `UPDATE github_installations SET updated_at = ?, repos_synced_at = COALESCE(?, repos_synced_at),
               repository_selection = COALESCE(?, repository_selection) WHERE org_id = ? AND installation_id = ?`,
      at, full ? at : null, selection, ctx.orgId, id),
    ...attach,
    ...(changed ? [auditStmt(ctx, actor, "github.repos", row.account_login, {
      installation_id: id, added: counts.added, removed: counts.removed,
      ...(selection !== null && selection !== row.repository_selection ? { repository_selection: selection } : {}),
    }, at)] : []),
  ]);
  return { ...counts, attached, detached };
}

/**
 * Forget an installation: every `org_repos` row attached to it DETACHED (each falls back to the pasted
 * token and its own webhook), its repo list and its row deleted, audited — `github.disconnect` (an admin:
 * Trov forgets it; it stays installed on GitHub) or `github.uninstall` (GitHub said `deleted`). One batch.
 * false when this org has no such installation (a second `deleted` delivery is a no-op).
 */
export async function unbindInstallation(
  ctx: TenantContext, installationId: number, actor: string, action: "github.disconnect" | "github.uninstall",
): Promise<boolean> {
  requireAdminOrSystem(ctx);
  const id = checkInstallationId(installationId);
  const row = await installationRow(ctx, id);
  if (!row) return false;
  const held = (await orgRepoRows(ctx)).filter((r) => r.installation_id === id);
  const at = nowIso();
  await batch(ctx, [
    stmt(ctx, `UPDATE org_repos SET installation_id = NULL WHERE org_id = ? AND installation_id = ?`, ctx.orgId, id),
    ...held.map((r) => auditStmt(ctx, actor, "repo.detach", r.repo_full_name, { installation_id: id }, at)),
    // The repos would CASCADE from the installation's row; deleted by name all the same, so the batch says what it does.
    stmt(ctx, `DELETE FROM github_installation_repos WHERE org_id = ? AND installation_id = ?`, ctx.orgId, id),
    stmt(ctx, `DELETE FROM github_installations WHERE org_id = ? AND installation_id = ?`, ctx.orgId, id),
    auditStmt(ctx, actor, action, row.account_login, { installation_id: id, detached: held.length }, at),
  ]);
  return true;
}

/**
 * GitHub's `installation.suspend` (`at` = when) / `unsuspend` (`at` = null). While suspended GitHub refuses
 * tokens, so the resolver falls back to the pasted token (src/github-app/credential.ts). Audited by the
 * context's actor — `github-webhook`. false when nothing changed (no such installation, or already in that
 * state — a redelivery writes nothing).
 */
export async function setInstallationSuspended(ctx: TenantContext, installationId: number, at: string | null): Promise<boolean> {
  requireAdminOrSystem(ctx);
  const id = checkInstallationId(installationId);
  const row = await installationRow(ctx, id);
  if (!row || (row.suspended_at === null) === (at === null)) return false;
  const now = nowIso();
  const stamp = at === null ? null : Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : now;
  await batch(ctx, [
    stmt(ctx, `UPDATE github_installations SET suspended_at = ?, updated_at = ? WHERE org_id = ? AND installation_id = ?`, stamp, now, ctx.orgId, id),
    auditStmt(ctx, ctx.userId, stamp === null ? "github.unsuspend" : "github.suspend", row.account_login, { installation_id: id }, now),
  ]);
  return true;
}

/** How often a verified delivery may stamp `last_delivery_at` — a busy repo must not cost a write per event. */
export const DELIVERY_THROTTLE_MS = 10 * 60_000;

/** Stamp a verified App delivery on its installation — at most once per 10 minutes (a no-op UPDATE
 *  otherwise). true when it wrote. */
export async function noteDelivery(ctx: TenantContext, installationId: number, now: number = Date.now()): Promise<boolean> {
  requireAdminOrSystem(ctx);
  const id = checkInstallationId(installationId);
  const res = await run(ctx,
    `UPDATE github_installations SET last_delivery_at = ? WHERE org_id = ? AND installation_id = ? AND (last_delivery_at IS NULL OR last_delivery_at < ?)`,
    new Date(now).toISOString(), ctx.orgId, id, new Date(now - DELIVERY_THROTTLE_MS).toISOString());
  return (res.meta.changes ?? 0) > 0;
}

// ── reads ────────────────────────────────────────────────────────────────────

/**
 * The org's installations with their repositories (what Org settings › Repositories lists, from D1 — never
 * GitHub on render), oldest first; each repository says whether the org has connected it (`org_repo_id`,
 * by name) and whether that row is the primary. Admin (or system) only: `org_repo_id` is a hook id, which a
 * member is never handed (src/integrations/settings.ts `listRepos`).
 */
export async function listInstallations(ctx: TenantContext): Promise<GithubInstallationDTO[]> {
  requireAdminOrSystem(ctx);
  const rows = await all<InstallationRow>(ctx, `SELECT ${INST_COLS} FROM github_installations WHERE org_id = ? ORDER BY connected_at, installation_id`, ctx.orgId);
  if (rows.length === 0) return [];
  const repos = await all<RepoRow & { installation_id: number; org_repo_id: string | null; is_primary: number | null }>(ctx,
    `SELECT g.installation_id, g.repo_id, g.repo_full_name, g.private, r.id AS org_repo_id, r.is_primary
       FROM github_installation_repos g LEFT JOIN org_repos r ON r.org_id = g.org_id AND r.repo_full_name = g.repo_full_name
      WHERE g.org_id = ? ORDER BY g.repo_full_name, g.repo_id`, ctx.orgId);
  return rows.map((i) => ({
    installation_id: i.installation_id,
    account_login: i.account_login,
    account_type: i.account_type,
    repository_selection: i.repository_selection,
    suspended_at: i.suspended_at,
    connected_by: i.connected_by,
    connected_at: i.connected_at,
    last_delivery_at: i.last_delivery_at,
    repos_synced_at: i.repos_synced_at,
    manage_url: installationManageUrl(i),
    repos: repos.filter((r) => r.installation_id === i.installation_id).map((r): GithubInstallationRepoDTO => ({
      repo_id: r.repo_id,
      full_name: r.repo_full_name,
      private: r.private === 1,
      org_repo_id: r.org_repo_id,
      is_primary: r.is_primary === 1,
    })),
  }));
}

/**
 * The installation a connected repository (`org_repos.id`) is attached to — only when the row is attached
 * AND the installation row exists — or null (connected the 0037 way). The credential resolver's question.
 */
export async function repoInstallation(ctx: TenantContext, orgRepoId: string): Promise<{ installation_id: number; suspended_at: string | null } | null> {
  return first<{ installation_id: number; suspended_at: string | null }>(ctx,
    `SELECT i.installation_id, i.suspended_at FROM org_repos r JOIN github_installations i ON i.org_id = r.org_id AND i.installation_id = r.installation_id
      WHERE r.org_id = ? AND r.id = ?`, ctx.orgId, orgRepoId);
}

/**
 * Is the org "on the App"? The App is configured AND its PRIMARY repository is attached to an installation —
 * then the GitHub token and that repo's webhook secret are no longer EXPECTED on the Integrations screen
 * (src/integrations/catalog.ts asks the same of its own rows). With the App unconfigured the attachment means
 * nothing: every job is back on the pasted token.
 */
export async function primaryOnApp(ctx: TenantContext, env: Env): Promise<boolean> {
  if (!githubAppConfig(env)) return false;
  const row = await first<{ installation_id: number | null }>(ctx, `SELECT installation_id FROM org_repos WHERE org_id = ? AND is_primary = 1`, ctx.orgId);
  return row?.installation_id != null;
}

/** `GET /api/o/:slug/github` (admin): the App panel's whole state. */
export async function githubAppState(ctx: TenantContext, env: Env): Promise<GithubAppStateDTO> {
  const cfg = githubAppConfig(env);
  return {
    configured: cfg !== null,
    app_url: cfg ? `https://github.com/apps/${encodeURIComponent(cfg.slug)}` : null,
    installations: await listInstallations(ctx),
    primary_on_app: await primaryOnApp(ctx, env),
  };
}
