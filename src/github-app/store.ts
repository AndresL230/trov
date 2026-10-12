// An org's GitHub App installation, as rows (0043_github_app; docs/architecture/github-app.md): the
// binding itself (`org_github_installations`) and what it means for the org's repositories
// (`org_repos.connection` / `access_lost_at`). TENANT statements, every one with its `org_id`; the
// reads that have no org yet — installation id → orgs, a repository's orgs — are src/platform/jobs.ts.
//
// An installation may be bound by SEVERAL orgs (0053_installation_repos); an org has one live binding.
// A binding is `repo_access = 'all'` (it spans the installation) or `'selected'`: it reaches only the
// repositories in `org_github_installation_repos` — the ones the admin who connected it could read.
// Everything this org does through the App is cut to that list (`allowedRepos`, `repoAllowed`).
//
// Every change writes its audit row in the SAME batch (`org_admin_audit`, actions `github.*` in
// shared/orgs.ts). A row names an account and an installation id — never a token.
import type { GithubRemovedReason, GithubRepoAccess, GithubRepoSelection } from "@shared/github-app";
import type { OrgSettingsAuditAction } from "@shared/integrations";
import { LAST_USED_THROTTLE_MS, lastErrorText, type Revealed } from "../data/secrets";
import { all, batch, first, nowIso, run, stmt, type Stmt, type TenantContext } from "../data/sql";
import type { InstallationInfo, ListedRepo } from "./api";

export interface InstallationRow {
  id: number;
  installation_id: number;
  account_login: string;
  account_id: string;
  account_type: "User" | "Organization";
  repository_selection: GithubRepoSelection;
  /** `all`: the binding spans the installation. `selected`: only `org_github_installation_repos`. */
  repo_access: GithubRepoAccess;
  connected_by: string;
  connected_at: string;
  suspended_at: string | null;
  removed_at: string | null;
  removed_reason: GithubRemovedReason | null;
  last_used_at: string | null;
  last_error: string | null;
}
const COLS = `id, installation_id, account_login, account_id, account_type, repository_selection, repo_access, connected_by, connected_at,
  suspended_at, removed_at, removed_reason, last_used_at, last_error`;

const auditStmt = (ctx: TenantContext, action: OrgSettingsAuditAction, target: string, detail: Record<string, unknown>, at: string): Stmt =>
  stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, ctx.userId, action, target, JSON.stringify(detail), at);

/** The org's LIVE installation (not ended; it may be suspended), or null. */
export const liveInstallation = (ctx: TenantContext): Promise<InstallationRow | null> =>
  first<InstallationRow>(ctx, `SELECT ${COLS} FROM org_github_installations WHERE org_id = ? AND removed_at IS NULL`, ctx.orgId);

/** The org's most recent binding, live or ended — what tells "never connected" from "it went away". */
export const latestInstallation = (ctx: TenantContext): Promise<InstallationRow | null> =>
  first<InstallationRow>(ctx, `SELECT ${COLS} FROM org_github_installations WHERE org_id = ? ORDER BY id DESC LIMIT 1`, ctx.orgId);

/** The binding lost a race with another one: this org got another installation between the check and
 *  the write (the partial unique index on the org). */
export class InstallationConflictError extends Error {
  constructor() { super("the org is already connected to another installation"); this.name = "InstallationConflictError"; }
}
const isUniqueViolation = (e: unknown): boolean => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

/**
 * Bind `info`'s installation to `ctx`'s org, by `ctx.userId` — the LAST step of the connect flow, after
 * every check (src/github-app/connect.ts). An org that already holds this installation has its account
 * fields refreshed instead (a reconnect, or an "update" return). Audited `github.connect`.
 *
 * Another org holding the same installation is no obstacle (0053): each has its own row.
 *
 * `access` is what check 5 found: `all`, or the repositories the person connecting can read. Connecting
 * again never narrows: a binding that is `all` stays `all`, and a `selected` one ADDS the repositories
 * this person can read to those it already reaches (two admins who read different repositories do not
 * take each other's away). Only ending the binding empties the list.
 *
 * `replace` is the live binding the caller read and means to END in the same batch (the admin connected
 * a DIFFERENT installation — the App on another account): it is ended as `disconnected`, audited, and
 * its repositories go back to `manual` before the new row is written, so the org never holds two and
 * never holds none. Without it a second installation is the unique index's conflict, as before.
 */
export async function bindInstallation(
  ctx: TenantContext, info: InstallationInfo, replace: InstallationRow | null = null, access: RepoAccess = { mode: "all" }
): Promise<"connected" | "refreshed"> {
  const at = nowIso();
  const live = await liveInstallation(ctx);
  // The binding the list is written for: the live one, by a subquery — a new row's id is not known yet.
  const BINDING = `(SELECT id FROM org_github_installations WHERE org_id = ? AND removed_at IS NULL)`;
  const listed = (repos: readonly ListedRepo[]): Stmt[] => {
    const out: Stmt[] = [];
    for (let i = 0; i < repos.length; i += LIST_CHUNK) {
      const chunk = repos.slice(i, i + LIST_CHUNK);
      out.push(stmt(ctx,
        `INSERT OR REPLACE INTO org_github_installation_repos (org_id, binding_id, repo_id, repo_full_name, private) VALUES ${chunk.map(() => `(?, ${BINDING}, ?, ?, ?)`).join(", ")}`,
        ...chunk.flatMap((r) => [ctx.orgId, ctx.orgId, r.id, r.full_name, r.private ? 1 : 0])));
    }
    return out;
  };
  if (live && live.installation_id === info.installation_id) {
    const widen = access.mode === "all" && live.repo_access !== "all";
    await batch(ctx, [
      stmt(ctx,
        `UPDATE org_github_installations SET account_login = ?, account_id = ?, account_type = ?, repository_selection = ?, suspended_at = ?, last_error = NULL${widen ? ", repo_access = 'all'" : ""}
          WHERE org_id = ? AND id = ?`,
        info.account_login, info.account_id, info.account_type, info.repository_selection, info.suspended_at, ctx.orgId, live.id),
      ...(widen ? [stmt(ctx, `DELETE FROM org_github_installation_repos WHERE org_id = ? AND binding_id = ?`, ctx.orgId, live.id)] : []),
      ...(access.mode === "selected" && live.repo_access === "selected" ? listed(access.repos) : []),
    ]);
    return "refreshed";
  }
  // The audit row reads `changes()` — written only when the UPDATE just before it ended the binding
  // (`endInstallation`'s rule). A binding that ended in between costs nothing: the INSERT still stands.
  const ending: Stmt[] = replace && replace.installation_id !== info.installation_id ? [
    stmt(ctx, `UPDATE org_github_installations SET removed_at = ?, removed_reason = 'disconnected' WHERE org_id = ? AND id = ? AND removed_at IS NULL`, at, ctx.orgId, replace.id),
    stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0`,
      ctx.orgId, ctx.userId, "github.disconnect", replace.account_login,
      JSON.stringify({ installation_id: replace.installation_id, reason: "disconnected", replaced_by: info.installation_id }), at),
    stmt(ctx, `UPDATE org_repos SET connection = 'manual', access_lost_at = NULL WHERE org_id = ? AND connection = 'app'`, ctx.orgId),
    stmt(ctx, `DELETE FROM org_github_installation_repos WHERE org_id = ? AND binding_id = ?`, ctx.orgId, replace.id),
  ] : [];
  try {
    await batch(ctx, [
      ...ending,
      stmt(ctx,
        `INSERT INTO org_github_installations (org_id, installation_id, account_login, account_id, account_type, repository_selection, repo_access, connected_by, connected_at, suspended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.orgId, info.installation_id, info.account_login, info.account_id, info.account_type, info.repository_selection, access.mode, ctx.userId, at, info.suspended_at),
      auditStmt(ctx, "github.connect", info.account_login, {
        installation_id: info.installation_id, account_type: info.account_type, repository_selection: info.repository_selection,
        repo_access: access.mode, ...(access.mode === "selected" ? { repositories: access.repos.length } : {}),
      }, at),
      ...(access.mode === "selected" ? listed(access.repos) : []),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new InstallationConflictError();
    throw e;
  }
  return "connected";
}

/**
 * End the org's binding: `disconnected` (an admin, in Trov — the App stays installed on GitHub),
 * `uninstalled` (GitHub's `installation.deleted`) or `not_found` (GitHub no longer knows it). The
 * repositories stay connected and go back to `manual`: from here they are read with the org's token, if
 * it has one. Guarded on `removed_at IS NULL`, so a second caller changes nothing — no second audit
 * row, no repository touched. Audited.
 */
export async function endInstallation(ctx: TenantContext, row: InstallationRow, reason: GithubRemovedReason): Promise<boolean> {
  const at = nowIso();
  // The two statements after the UPDATE act only when it TOOK: each reads SQLite's `changes()` — the rows
  // the statement just before it wrote, on this one connection, inside this one batch. (Comparing
  // `removed_at` to `at` instead would let a second call in the same millisecond write a second audit row.)
  const [ended] = await batch(ctx, [
    stmt(ctx, `UPDATE org_github_installations SET removed_at = ?, removed_reason = ? WHERE org_id = ? AND id = ? AND removed_at IS NULL`, at, reason, ctx.orgId, row.id),
    stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0`,
      ctx.orgId, ctx.userId, reason === "disconnected" ? "github.disconnect" : "github.uninstall", row.account_login,
      JSON.stringify({ installation_id: row.installation_id, reason }), at),
    stmt(ctx, `UPDATE org_repos SET connection = 'manual', access_lost_at = NULL WHERE org_id = ? AND connection = 'app' AND changes() > 0`, ctx.orgId),
    // What the binding reached goes with it (an ended binding reaches nothing; a new one starts empty).
    stmt(ctx, `DELETE FROM org_github_installation_repos WHERE org_id = ? AND binding_id = ?
                AND EXISTS (SELECT 1 FROM org_github_installations i WHERE i.org_id = ? AND i.id = ? AND i.removed_at IS NOT NULL)`, ctx.orgId, row.id, ctx.orgId, row.id),
  ]);
  return (ended?.meta.changes ?? 0) > 0;
}

/** Suspended / unsuspended on GitHub. A no-op when the row already says so. Audited. */
export async function setInstallationSuspended(ctx: TenantContext, row: InstallationRow, suspended: boolean): Promise<void> {
  if ((row.suspended_at !== null) === suspended) return;
  const at = nowIso();
  await batch(ctx, [
    stmt(ctx, `UPDATE org_github_installations SET suspended_at = ? WHERE org_id = ? AND id = ? AND removed_at IS NULL`, suspended ? at : null, ctx.orgId, row.id),
    auditStmt(ctx, suspended ? "github.suspend" : "github.unsuspend", row.account_login, { installation_id: row.installation_id }, at),
  ]);
}

/** The installation accepted new permissions on GitHub — recorded, nothing else changes. */
export async function notePermissionsAccepted(ctx: TenantContext, row: InstallationRow): Promise<void> {
  await batch(ctx, [auditStmt(ctx, "github.permissions", row.account_login, { installation_id: row.installation_id }, nowIso())]);
}

/** A use of the installation's token: `last_used_at`, at most once per ten minutes (a secret's throttle). */
export async function markInstallationUsed(ctx: TenantContext, row: Pick<InstallationRow, "id">, now: number = Date.now()): Promise<void> {
  await run(ctx, `UPDATE org_github_installations SET last_used_at = ? WHERE org_id = ? AND id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
    new Date(now).toISOString(), ctx.orgId, row.id, new Date(now - LAST_USED_THROTTLE_MS).toISOString());
}

/** What a use came to — `recordSecretOutcome`'s rule on the installation's row: success clears
 *  `last_error` and bumps `last_used_at`; failure stores the message, scrubbed FIRST, then cut. */
export async function recordInstallationOutcome(
  ctx: TenantContext, row: Pick<InstallationRow, "id">, outcome: { ok: true } | { ok: false; message: string; revealed: Revealed }, now: number = Date.now()
): Promise<void> {
  if (outcome.ok) {
    await markInstallationUsed(ctx, row, now);
    await run(ctx, `UPDATE org_github_installations SET last_error = NULL WHERE org_id = ? AND id = ? AND last_error IS NOT NULL`, ctx.orgId, row.id);
    return;
  }
  await run(ctx, `UPDATE org_github_installations SET last_error = ? WHERE org_id = ? AND id = ?`, lastErrorText(outcome.message, outcome.revealed), ctx.orgId, row.id);
}

// ── what a binding reaches ───────────────────────────────────────────────────

/** What the connect flow found the person can read: the whole installation, or these repositories. */
export type RepoAccess = { mode: "all" } | { mode: "selected"; repos: readonly ListedRepo[] };
/** Rows per INSERT of the list: five bound values each, under D1's hundred per statement. */
const LIST_CHUNK = 15;

export interface AllowedRepo { full_name: string; private: boolean }

/** The repositories a `selected` binding reaches, by name — or null for an `all` binding, which reaches
 *  whatever the installation covers. */
export async function allowedRepos(ctx: TenantContext, row: Pick<InstallationRow, "id" | "repo_access">): Promise<AllowedRepo[] | null> {
  if (row.repo_access === "all") return null;
  const rows = await all<{ repo_full_name: string; private: number }>(ctx,
    `SELECT repo_full_name, private FROM org_github_installation_repos WHERE org_id = ? AND binding_id = ? ORDER BY repo_full_name`, ctx.orgId, row.id);
  return rows.map((r) => ({ full_name: r.repo_full_name, private: r.private === 1 }));
}

/** May this org reach `repo` through the binding? Always for `all`; for `selected`, only a listed one. */
export async function repoAllowed(ctx: TenantContext, row: Pick<InstallationRow, "id" | "repo_access">, repo: string): Promise<boolean> {
  if (row.repo_access === "all") return true;
  return (await first(ctx,
    `SELECT 1 AS x FROM org_github_installation_repos WHERE org_id = ? AND binding_id = ? AND repo_full_name = ?`, ctx.orgId, row.id, repo)) !== null;
}

// ── the org's repositories, seen through the installation ────────────────────

const lower = (names: readonly string[]): Set<string> => new Set(names.map((n) => n.toLowerCase()));

/**
 * Bring `org_repos.connection` / `access_lost_at` in step with what the installation can see.
 *   `visible`  the installation's COMPLETE list: a connected repository in it is `app` and reachable; an
 *              `app` one missing from it has lost access. (Never pass a cut list — absence must be real.)
 *   `added` / `removed`  GitHub's `installation_repositories` event: the same, for the names it carries.
 * The caller passes only what THIS org's binding reaches (`allowedRepos`): a repository outside a
 * `selected` binding's list is not "seen", whatever the installation covers.
 * Bookkeeping, not an admin's action: no audit row of its own (the event's handler writes one).
 */
export async function syncRepoAccess(ctx: TenantContext, change: { visible?: readonly string[]; added?: readonly string[]; removed?: readonly string[] }): Promise<void> {
  const rows = await all<{ id: string; repo_full_name: string; connection: string; access_lost_at: string | null }>(ctx,
    `SELECT id, repo_full_name, connection, access_lost_at FROM org_repos WHERE org_id = ?`, ctx.orgId);
  const visible = change.visible ? lower(change.visible) : null;
  const added = lower(change.added ?? []);
  const removed = lower(change.removed ?? []);
  const at = nowIso();
  const stmts: Stmt[] = [];
  for (const r of rows) {
    const name = r.repo_full_name.toLowerCase();
    const seen = visible ? visible.has(name) : added.has(name);
    const gone = visible ? !visible.has(name) : removed.has(name);
    if (seen && (r.connection !== "app" || r.access_lost_at !== null)) {
      stmts.push(stmt(ctx, `UPDATE org_repos SET connection = 'app', access_lost_at = NULL WHERE org_id = ? AND id = ?`, ctx.orgId, r.id));
    } else if (gone && r.connection === "app" && r.access_lost_at === null) {
      stmts.push(stmt(ctx, `UPDATE org_repos SET access_lost_at = ? WHERE org_id = ? AND id = ?`, at, ctx.orgId, r.id));
    }
  }
  if (stmts.length) await batch(ctx, stmts);
}

/** GitHub's `installation_repositories` event, on the binding: the selection it now reports, the
 *  repositories' marks, and ONE audit row naming what was added and removed (names only). */
export async function recordRepositoriesChanged(
  ctx: TenantContext, row: InstallationRow, change: { selection: GithubRepoSelection | null; added: string[]; removed: string[] }
): Promise<void> {
  const at = nowIso();
  await batch(ctx, [
    ...(change.selection && change.selection !== row.repository_selection
      ? [stmt(ctx, `UPDATE org_github_installations SET repository_selection = ? WHERE org_id = ? AND id = ? AND removed_at IS NULL`, change.selection, ctx.orgId, row.id)] : []),
    auditStmt(ctx, "github.repos", row.account_login, { installation_id: row.installation_id, added: change.added.slice(0, 50), removed: change.removed.slice(0, 50) }, at),
  ]);
  // A repository newly added to the installation is this org's only if its binding reaches it.
  const allowed = await allowedRepos(ctx, row);
  const mine = allowed ? lower(allowed.map((r) => r.full_name)) : null;
  await syncRepoAccess(ctx, { added: mine ? change.added.filter((n) => mine.has(n.toLowerCase())) : change.added, removed: change.removed });
}
