// What the App menu narrows Code and CI by (Repo setups, Phase E): which apps a set of changed files touches, which
// apps a Package serves, and which app a workflow run belongs to. Pure helpers plus three D1 reads — nothing here
// fetches (it backs the Repo dashboard's projection, src/tools/repo-scope.ts, reachable from src/mcp.ts).
import type { RepoApp } from "@shared/repo-apps-core";
import type { ScopeApp, Touch } from "@shared/repo-scope-core";
import { type TenantContext, all } from "../data/sql";
import type { PartRow } from "../hosting/parts";
import type { KnownPaths } from "./commit-paths";
import { matchesWatch } from "./watch";

/** The apps a set of changed files touches: the apps (not Packages) and the Packages whose watch paths it hits. */
export function touchesOf(paths: readonly string[], apps: readonly RepoApp[]): { touches: string[]; packages: string[] } {
  const hit = apps.filter((a) => paths.some((p) => matchesWatch(p, a.watch)));
  return { touches: hit.filter((a) => a.kind !== "Package").map((a) => a.key), packages: hit.filter((a) => a.kind === "Package").map((a) => a.key) };
}

/** Each Package app's users (app keys), from the repo scan's workspace graph: the newest suggestion of that folder and
 *  kind Package (`repo_app_suggestions.used_by`, folders), matched to the repository's apps by folder. A Package the
 *  scan never described reads `null` — not known, never `[]`. */
export async function packageUsers(ctx: TenantContext, repo: string, apps: readonly RepoApp[]): Promise<Map<string, string[] | null>> {
  const out = new Map<string, string[] | null>();
  const pkgs = apps.filter((a) => a.kind === "Package");
  if (!pkgs.length || !repo) return out;
  const rows = await all<{ folder: string; used_by: string }>(ctx,
    `SELECT folder, used_by FROM repo_app_suggestions WHERE org_id = ? AND repo = ? COLLATE NOCASE AND kind = 'Package' ORDER BY created_at DESC`,
    ctx.orgId, repo);
  const norm = (f: string) => f.trim().replace(/^\/+|\/+$/g, "") || "/";
  for (const p of pkgs) {
    const row = rows.find((r) => norm(r.folder) === norm(p.folder));
    if (!row) { out.set(p.key, null); continue; }
    let folders: string[] = [];
    try { const v = JSON.parse(row.used_by) as unknown; if (Array.isArray(v)) folders = v.filter((x): x is string => typeof x === "string"); } catch { /* none */ }
    out.set(p.key, apps.filter((a) => a.kind !== "Package" && folders.some((f) => norm(f) === norm(a.folder))).map((a) => a.key));
  }
  return out;
}

/** The apps as the shared rules read them (shared/repo-scope-core.ts). */
export const scopeApps = (apps: readonly RepoApp[], users: Map<string, string[] | null>): ScopeApp[] =>
  apps.map((a) => ({ key: a.key, kind: a.kind, usedBy: a.kind === "Package" ? users.get(a.key) ?? null : null }));

/** A workflow run as CI's narrowing reads it. */
export interface RunRow {
  number: number | null; sha: string | null; state: string | null; name: string | null; ref: string | null;
  title: string | null; url: string | null; occurred_at: string; path: string | null;
}

/** Every `run` row since `sinceIso`, newest first — the CI tab's narrowing attributes each. ONE statement. */
export async function runRowsSince(ctx: TenantContext, sinceIso: string): Promise<RunRow[]> {
  return all<RunRow>(ctx,
    `SELECT number, sha, state, name, ref, title, url, occurred_at, json_extract(raw, '$.path') AS path FROM repo_events
      WHERE org_id = ? AND kind = 'run' AND occurred_at > ? ORDER BY occurred_at DESC, id DESC`, ctx.orgId, sinceIso);
}

const fileOf = (p: string): string => p.split("/").pop() ?? p;

/** The apps a run's workflow file names: a `github` part whose setting is that workflow (by file name — a setting
 *  may be a bare file or the whole `.github/workflows/…` path), or an app whose watch paths cover the file. */
export function workflowApps(path: string | null, apps: readonly RepoApp[], parts: readonly PartRow[]): string[] {
  if (!path) return [];
  const keys = new Set<string>();
  for (const p of parts) {
    const wf = p.provider === "github" ? p.settings.workflow : undefined;
    if (wf && fileOf(wf) === fileOf(path) && apps.some((a) => a.key === p.key)) keys.add(p.key);
  }
  for (const a of apps) if (a.watch.some((w) => w.includes(".github")) && matchesWatch(path, a.watch)) keys.add(a.key);
  return [...keys];
}

/** One run's apps: the workflow file's, plus its head commit's files — exact (`commit`), or its push's (`approx`).
 *  `touches: null` = unknown (no workflow names an app, and the head commit's files are not known — or its push's
 *  list was cut short and hits nothing). */
export function runTouch(run: Pick<RunRow, "path">, head: KnownPaths | undefined, apps: readonly RepoApp[], parts: readonly PartRow[]): Touch & { approx: boolean; complete: boolean } {
  const byFile = workflowApps(run.path, apps, parts);
  const fileApps = byFile.filter((k) => apps.find((a) => a.key === k)?.kind !== "Package");
  const filePkgs = byFile.filter((k) => apps.find((a) => a.key === k)?.kind === "Package");
  // Named by its workflow alone: those apps for certain; whether it touches others is not known (`complete: false`).
  if (!head) return byFile.length ? { touches: fileApps, packages: filePkgs, approx: false, complete: false } : { touches: null, packages: [], approx: false, complete: false };
  const t = touchesOf(head.paths, apps);
  const touches = [...new Set([...fileApps, ...t.touches])];
  const packages = [...new Set([...filePkgs, ...t.packages])];
  if (head.scope === "push_partial" && !touches.length && !packages.length) return { touches: null, packages: [], approx: true, complete: false };
  return { touches, packages, approx: head.scope !== "commit", complete: head.scope !== "push_partial" };
}
