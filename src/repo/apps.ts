// Apps (0070_repo_apps): what a repository ships. An app IS a part key — `org_environment_parts.part_key`
// names it — with a home: the repository and folder it lives in, its kind (the role follows the kind,
// shared/repo-apps-core.ts), the paths that count as its changes.
//
//   read    `listRepoApps(ctx, repo?)` (./apps-read.ts) — the org's `repo_apps` rows PLUS an app synthesised for every part
//           key that has no row (at the primary repository's root, kind from its part's role), so a part
//           from before apps existed still reads as an app and nothing existing breaks. Reads only this
//           org's rows through the tenant surface; never a secret — the dashboard and MCP may call it.
//   write   `putRepoApp` / `deleteRepoApp` — AUTHORED writes (admin+), each audited `app.set` / `app.delete`
//           in `org_admin_audit` in the same batch, the audit naming the KEYS that changed, never a value.
//           Called by Org settings › Repositories › a repo › Apps (./apps-routes.ts) and the repo scan's Accept
//           (./scan-store.ts).
import { PART_KEY_RE } from "@shared/hosting";
import type { OrgSettingsAuditAction } from "@shared/integrations";
import { APP_KINDS, isAppKind, parseReleaseSignal, type AppKind, type AppSource, type RepoApp } from "@shared/repo-apps-core";
import { requireRole } from "../data/context";
import { all, batch, first, nowIso, stmt, type Stmt, type TenantContext } from "../data/sql";
import { SettingsError } from "../integrations/settings";
import { type AppRow, listRepoApps, parseWatch, sourceOf } from "./apps-read";

// The read half lives in ./apps-read.ts — it imports nothing that reaches the secrets module, so the Repo
// dashboard's facts (reachable from src/mcp.ts, test/secrets.mcp.test.ts) may call it. Re-exported here.
export { listRepoApps, repoAppOf } from "./apps-read";

export const APP_LABEL_MAX = 60;
export const APP_FOLDER_MAX = 200;
export const APP_WATCH_MAX = 20;
export const APP_RELEASE_SIGNAL_MAX = 200;

// ── writes ───────────────────────────────────────────────────────────────────

const invalid = (field: string, message: string) => new SettingsError("invalid", 400, message, field);
const CONTROL = /[\u0000-\u001f\u007f]/;
const APP_BODY_KEYS = ["repo", "label", "folder", "kind", "watch", "release_signal", "source", "position"];

const auditStmt = (ctx: TenantContext, action: OrgSettingsAuditAction, target: string, detail: Record<string, unknown>, at: string): Stmt =>
  stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, ctx.userId, action, target, JSON.stringify(detail), at);

/** A folder as stored: '/' for the root, else the path without leading / trailing slashes. No `..`, no
 *  control character, ≤ 200 characters — else null. */
export function normaliseFolder(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^\/+|\/+$/g, "");
  if (s === "" || s === ".") return "/";
  if (s.length > APP_FOLDER_MAX || CONTROL.test(s) || s.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return s;
}

export interface RepoAppWrite {
  repo?: string;
  label?: string;
  folder?: string;
  kind?: AppKind;
  watch?: string[];
  release_signal?: string | null;
  source?: "manual" | "suggested";
  position?: number;
}

/**
 * Create or replace one app (admin+). Body: `RepoAppWrite`; any other key is refused. A NEW app needs `kind`;
 * `repo` must be a connected repository (default: the current one, else the primary); `folder` defaults to
 * `/`, `watch` to `[folder]`, `label` to the current one or the key. `source` is `manual` (default) or
 * `suggested` (an accepted suggestion, Phase D) — `migrated` is the migration's alone. One batch with its
 * `app.set` audit row (the changed field names, never a value).
 */
export async function putRepoApp(ctx: TenantContext, key: string, body: unknown): Promise<{ app: RepoApp; created: boolean }> {
  requireRole(ctx, "admin");
  if (!PART_KEY_RE.test(key)) throw invalid("key", "the app key must be 1–32 characters: a–z, 0–9, _ or -");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("body", "the body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !APP_BODY_KEYS.includes(k))) throw invalid("body", "the body has a field an app does not have");

  const existing = await first<AppRow>(ctx, `SELECT key, repo, label, folder, kind, watch, release_signal, source, position
    FROM repo_apps WHERE org_id = ? AND key = ?`, ctx.orgId, key);
  const repos = await all<{ repo_full_name: string; is_primary: number }>(ctx,
    `SELECT repo_full_name, is_primary FROM org_repos WHERE org_id = ? ORDER BY is_primary DESC, created_at, id`, ctx.orgId);

  let repo: string;
  if (b.repo !== undefined) {
    const held = typeof b.repo === "string" ? repos.find((r) => r.repo_full_name.toLowerCase() === (b.repo as string).trim().toLowerCase()) : undefined;
    if (!held) throw invalid("repo", "repo must be a repository connected to this organization");
    repo = held.repo_full_name;
  } else {
    repo = existing?.repo ?? repos[0]?.repo_full_name ?? "";
  }

  let kind: AppKind;
  if (b.kind !== undefined) {
    if (!isAppKind(b.kind)) throw invalid("kind", `kind must be one of ${APP_KINDS.join(", ")}`);
    kind = b.kind;
  } else if (existing && isAppKind(existing.kind)) {
    kind = existing.kind;
  } else {
    throw invalid("kind", "kind is required for a new app");
  }

  let label = existing?.label ?? key;
  if (b.label !== undefined) {
    if (typeof b.label !== "string" || !b.label.trim()) throw invalid("label", "label must be a non-empty string");
    label = b.label.trim();
    if (label.length > APP_LABEL_MAX) throw invalid("label", `label is longer than ${APP_LABEL_MAX} characters`);
    if (CONTROL.test(label)) throw invalid("label", "label contains a control character");
  }

  let folder = existing?.folder ?? "/";
  if (b.folder !== undefined) {
    const f = normaliseFolder(b.folder);
    if (f === null) throw invalid("folder", "folder must be a path inside the repository (no `..`), at most 200 characters");
    folder = f;
  }

  let watch: string[] = existing && b.folder === undefined ? parseWatch(existing.watch, folder) : [folder];
  if (b.watch !== undefined) {
    if (!Array.isArray(b.watch) || b.watch.length === 0 || b.watch.length > APP_WATCH_MAX) throw invalid("watch", `watch must be a list of 1–${APP_WATCH_MAX} path globs`);
    const globs: string[] = [];
    for (const g of b.watch) {
      if (typeof g !== "string" || !g.trim() || g.trim().length > APP_FOLDER_MAX || CONTROL.test(g)) throw invalid("watch", "each watch entry must be a path glob of at most 200 characters");
      globs.push(g.trim());
    }
    watch = [...new Set(globs)];
  }

  let releaseSignal = existing?.release_signal ?? null;
  if (b.release_signal !== undefined) {
    if (b.release_signal === null || b.release_signal === "") releaseSignal = null;
    else {
      // Exactly one of the two forms `readRelease` follows (`parseReleaseSignal`, shared/repo-apps-core.ts) — never
      // a free line that nothing reads.
      const signal = typeof b.release_signal === "string" && b.release_signal.length <= APP_RELEASE_SIGNAL_MAX ? b.release_signal.trim() : null;
      if (signal === null || !parseReleaseSignal(signal)) {
        throw invalid("release_signal", "release_signal must be tag:<glob> (at most 100 characters) or workflow:<file>@<branch>");
      }
      releaseSignal = signal;
    }
  }

  let source: AppSource = existing ? sourceOf(existing.source) : "manual";
  if (b.source !== undefined) {
    if (b.source !== "manual" && b.source !== "suggested") throw invalid("source", "source must be manual or suggested");
    source = b.source;
  }

  let position: number | null = existing?.position ?? null;
  if (b.position !== undefined) {
    if (typeof b.position !== "number" || !Number.isInteger(b.position) || b.position < 0 || b.position > 1000) throw invalid("position", "position must be an integer from 0 to 1000");
    position = b.position;
  }

  const next = { repo, label, folder, kind, watch: JSON.stringify(watch), release_signal: releaseSignal, source };
  const before: Record<string, unknown> | null = existing ? { ...existing } : null;
  const fields = before
    ? [...Object.keys(next).filter((k) => before[k] !== next[k as keyof typeof next]), ...(position !== before.position ? ["position"] : [])].sort()
    : Object.keys(next).sort();
  const at = nowIso();
  await batch(ctx, [
    stmt(ctx, `INSERT INTO repo_apps (org_id, key, repo, label, folder, kind, watch, release_signal, source, position, created_at, created_by, updated_at, updated_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT COALESCE(MAX(a.position), -1) + 1 FROM repo_apps a WHERE a.org_id = ?)), ?, ?, ?, ?)
               ON CONFLICT(org_id, key) DO UPDATE SET repo = excluded.repo, label = excluded.label, folder = excluded.folder, kind = excluded.kind,
                 watch = excluded.watch, release_signal = excluded.release_signal, source = excluded.source, position = excluded.position,
                 updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ctx.orgId, key, next.repo, next.label, next.folder, next.kind, next.watch, next.release_signal, next.source, position, ctx.orgId,
      at, ctx.userId, at, ctx.userId),
    auditStmt(ctx, "app.set", key, { created: !existing, kind, fields }, at),
  ]);
  const app = (await listRepoApps(ctx)).find((a) => a.key === key);
  if (!app) throw new SettingsError("not_found", 404, "no such app"); // removed underneath us
  return { app, created: !existing };
}

/** Remove one app's row (admin+), audited `app.delete`. Its parts stay: a part key with no row reads as an
 *  app at the primary repository's root again. No row → 404. */
export async function deleteRepoApp(ctx: TenantContext, key: string): Promise<{ key: string }> {
  requireRole(ctx, "admin");
  const row = await first<{ kind: string }>(ctx, `SELECT kind FROM repo_apps WHERE org_id = ? AND key = ?`, ctx.orgId, key);
  if (!row) throw new SettingsError("not_found", 404, "no such app");
  const at = nowIso();
  await batch(ctx, [
    stmt(ctx, `DELETE FROM repo_apps WHERE org_id = ? AND key = ?`, ctx.orgId, key),
    auditStmt(ctx, "app.delete", key, { kind: row.kind }, at),
  ]);
  return { key };
}
