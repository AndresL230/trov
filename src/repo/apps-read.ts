// Apps — the READ half of ./apps.ts (0070_repo_apps). Split out so the Repo dashboard's facts
// (src/tools/repo-facts.ts, reachable from src/mcp.ts) can read apps without importing ./apps.ts's writers, whose
// errors come from src/integrations/settings.ts — and that module reaches the secrets module, which nothing
// reachable from src/mcp.ts may import (test/secrets.mcp.test.ts). Tenant statements only; never a secret.
import { isAppKind, kindForRole, type AppSource, type RepoApp } from "@shared/repo-apps-core";
import { all, first, type TenantContext } from "../data/sql";
import { listAllParts, type PartRow } from "../hosting/parts";

export interface AppRow {
  key: string; repo: string; label: string; folder: string; kind: string; watch: string; release_signal: string | null;
  source: string; position: number;
}

export const parseWatch = (json: string, folder: string): string[] => {
  try {
    const v = JSON.parse(json) as unknown;
    if (Array.isArray(v)) {
      const globs = v.filter((g): g is string => typeof g === "string" && g.length > 0);
      if (globs.length) return globs;
    }
  } catch { /* fall through to the default */ }
  return [folder];
};

const primaryRepo = async (ctx: TenantContext): Promise<string> =>
  (await first<{ repo_full_name: string }>(ctx,
    `SELECT repo_full_name FROM org_repos WHERE org_id = ? ORDER BY is_primary DESC, created_at, id LIMIT 1`, ctx.orgId))?.repo_full_name ?? "";

export const sourceOf = (v: string): AppSource => (v === "migrated" || v === "suggested" ? v : "manual");

/**
 * The org's apps, in order (`position`, then key): every `repo_apps` row, then an app for each part key with
 * no row — repository = the primary one, folder `/`, kind from the role of the key's part in the FIRST
 * environment (drift order), label from that part. `repo` narrows to one repository (case-insensitive, as
 * GitHub compares names); a row stored with repo '' is the primary repository's. `parts`: the org's parts when
 * the caller already read them (`listAllParts`), so they are not read twice.
 */
export async function listRepoApps(ctx: TenantContext, repo?: string, parts?: PartRow[]): Promise<RepoApp[]> {
  const [rows, allParts, primary] = [
    await all<AppRow>(ctx, `SELECT key, repo, label, folder, kind, watch, release_signal, source, position
      FROM repo_apps WHERE org_id = ? ORDER BY position, key`, ctx.orgId),
    parts ?? await listAllParts(ctx),
    await primaryRepo(ctx),
  ];
  const out: RepoApp[] = [];
  for (const r of rows) {
    if (!isAppKind(r.kind)) continue; // a kind the code no longer knows is skipped, never guessed
    out.push({
      key: r.key, repo: r.repo || primary, label: r.label, folder: r.folder || "/", kind: r.kind,
      watch: parseWatch(r.watch, r.folder || "/"), releaseSignal: r.release_signal, source: sourceOf(r.source), position: r.position,
    });
  }
  const known = new Set(out.map((a) => a.key));
  let next = out.reduce((m, a) => Math.max(m, a.position + 1), 0);
  // `listAllParts` is in drift order, so the first part seen for a key is its first environment's.
  for (const p of allParts) {
    if (known.has(p.key)) continue;
    known.add(p.key);
    out.push({
      key: p.key, repo: primary, label: p.label, folder: "/", kind: kindForRole(p.role), watch: ["/"], releaseSignal: null,
      source: "synthesised", position: next++,
    });
  }
  const want = repo?.toLowerCase();
  return want === undefined ? out : out.filter((a) => a.repo.toLowerCase() === want);
}

/** The app a part key belongs to, as `listRepoApps` reads it — or null. */
export async function repoAppOf(ctx: TenantContext, key: string): Promise<RepoApp | null> {
  return (await listRepoApps(ctx)).find((a) => a.key === key) ?? null;
}
