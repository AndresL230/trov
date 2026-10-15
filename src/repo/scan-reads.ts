// The READ side of the repo scan (repo setups, Phase D) — D1 only, secret-free, never a call to GitHub or a host:
// the facts read (src/tools/repo-facts.ts, reachable from MCP) and the Apps tab both call it. It must never import
// the credentialed side (./scan-store.ts, src/data/secrets.ts, src/github-app/, src/hosting/part-writes.ts).
//
//   readScan(ctx, repo)         the last scan: tree sha, when, what it looked for, why it could not run.
//   listSuggestions(ctx, repo)  pending suggestions, and accepted ones whose app still exists — ignored ones hidden —
//                               each with its matched signals refreshed from the seen signals.
//   readFound(ctx, repo)        FactsFound: the pending suggestions + the deploy names GitHub has seen.
//   readUnseen(ctx, repo)       FactsUnseen: what the scan looked for, and what GitHub shows of the repository (tags:
//                               `readTags`, ./releases.ts — null until a reconcile read the repository's releases;
//                               PRs only once the open-PR list was read, else null).
import type { FactsFound, FactsUnseen } from "@shared/repo-facts-core";
import { isAppKind } from "@shared/repo-apps-core";
import type { AppSuggestionDTO, RepoScanDTO, SeenSignal, SuggestionState } from "@shared/repo-scan-core";
import { isHostingProvider } from "@shared/hosting";
import { all, first, type TenantContext } from "../data/sql";
import type { HostingProviderId } from "@shared/hosting";
import type { SuggestionEvidence } from "@shared/repo-scan-core";
import { seenSignals } from "./signals";
import { readTags } from "./releases";

/** A stored evidence entry: the DTO's `{ kind, text }`, plus — for a signal — which signal (so a read can refresh
 *  its count and list the suggestion's signals). Declared HERE (not in ./scan.ts) so this module never reaches the
 *  scan's imports. */
export interface StoredEvidence extends SuggestionEvidence { signal?: { kind: SeenSignal["kind"]; name: string } }
export interface StoredPart { env: string; provider: HostingProviderId; settings: Record<string, string> }

interface ScanRow { tree_sha: string | null; scanned_at: string | null; looked: string; error: string | null }
export interface SuggestionRow {
  id: string; repo: string; key: string; folder: string; kind: string; provider: string | null; evidence: string; parts: string;
  used_by: string; state: string; decided_at: string | null; decided_by: string | null; created_at: string;
}

const parse = <T>(json: string, fallback: T): T => {
  try { const v = JSON.parse(json) as unknown; return (Array.isArray(fallback) ? (Array.isArray(v) ? v : fallback) : (v ?? fallback)) as T; } catch { return fallback; }
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function readScan(ctx: TenantContext, repo: string): Promise<RepoScanDTO> {
  const row = await first<ScanRow>(ctx, `SELECT tree_sha, scanned_at, looked, error FROM repo_scans WHERE org_id = ? AND lower(repo) = lower(?)`, ctx.orgId, repo);
  return { treeSha: row?.tree_sha ?? null, scannedAt: row?.scanned_at ?? null, looked: row ? strings(parse(row.looked, [])) : [], error: row?.error ?? null };
}

/** One stored row as the DTO, its signal evidence refreshed from `signals` (the current counts). A signal no longer
 *  seen in the window drops out of both `signals` and the evidence. */
export function suggestionDTO(r: SuggestionRow, signals: readonly SeenSignal[]): AppSuggestionDTO | null {
  if (!isAppKind(r.kind)) return null;
  const stored = parse<StoredEvidence[]>(r.evidence, []);
  const matched: SeenSignal[] = [];
  const evidence = stored.flatMap((e) => {
    if (!e || typeof e.text !== "string") return [];
    if (!e.signal) return [{ kind: e.kind, text: e.text }];
    const s = signals.find((x) => x.kind === e.signal!.kind && x.name === e.signal!.name);
    if (!s) return [];
    matched.push(s);
    const times = `${s.count} ${s.count === 1 ? "time" : "times"}`;
    const text = s.kind === "workflow" ? `Workflow ${s.name}, ${s.count} ${s.count === 1 ? "run" : "runs"}` : e.text.replace(/seen \d+ times?$/, `seen ${times}`);
    return [{ kind: e.kind, text }];
  });
  const parts = parse<StoredPart[]>(r.parts, []).filter((p) => p && typeof p.env === "string" && isHostingProvider(p.provider) && p.settings && typeof p.settings === "object");
  return {
    id: r.id, key: r.key, folder: r.folder, kind: r.kind, provider: isHostingProvider(r.provider) ? r.provider : null,
    evidence, parts: parts.map((p) => ({ env: p.env, provider: p.provider, settings: { ...p.settings } })),
    signals: matched, usedBy: strings(parse(r.used_by, [])), state: r.state as SuggestionState,
  };
}

const ROW_COLS = `id, repo, key, folder, kind, provider, evidence, parts, used_by, state, decided_at, decided_by, created_at`;

/** The repository's suggestion rows in a state, ordered by folder. */
export async function suggestionRows(ctx: TenantContext, repo: string, states: readonly SuggestionState[]): Promise<SuggestionRow[]> {
  const rows = await all<SuggestionRow>(ctx, `SELECT ${ROW_COLS} FROM repo_app_suggestions WHERE org_id = ? AND lower(repo) = lower(?) ORDER BY folder, kind`, ctx.orgId, repo);
  return rows.filter((r) => (states as readonly string[]).includes(r.state));
}

/** Pending suggestions, and accepted ones whose app still exists (the list's "Accepted" rows); ignored ones hidden. */
export async function listSuggestions(ctx: TenantContext, repo: string, now: number = Date.now()): Promise<AppSuggestionDTO[]> {
  const [rows, signals, appKeys] = [
    await suggestionRows(ctx, repo, ["pending", "accepted"]), await seenSignals(ctx, repo, undefined, now),
    // The org's app keys: its `repo_apps` rows and the part keys an app is synthesised for (src/repo/apps.ts) —
    // read directly, so this module stays clear of the writers' imports.
    await all<{ key: string }>(ctx, `SELECT key FROM repo_apps WHERE org_id = ? UNION SELECT part_key AS key FROM org_environment_parts WHERE org_id = ?`, ctx.orgId, ctx.orgId),
  ];
  const keys = new Set(appKeys.map((a) => a.key));
  return rows
    .filter((r) => r.state === "pending" || keys.has(r.key))
    .map((r) => suggestionDTO(r, signals))
    .filter((d): d is AppSuggestionDTO => d !== null);
}

/** At most this many deploy names on the found card. */
const FOUND_SIGNALS_MAX = 12;

/** FactsFound — null when the repository was never scanned and GitHub has shown no deploy name. */
export async function readFound(ctx: TenantContext, repo: string, now: number = Date.now()): Promise<FactsFound | null> {
  const [scan, rows, signals] = [await readScan(ctx, repo), await suggestionRows(ctx, repo, ["pending"]), await seenSignals(ctx, repo, undefined, now)];
  const names = signals.filter((s) => s.kind !== "workflow").sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1)).slice(0, FOUND_SIGNALS_MAX);
  if (!scan.scannedAt && !rows.length && !names.length) return null;
  const apps = rows.map((r) => suggestionDTO(r, signals)).filter((d): d is AppSuggestionDTO => d !== null).map((d) => ({
    id: d.id, folder: d.folder, kind: d.kind, provider: d.provider,
    evidence: (d.evidence.find((e) => e.kind !== "signal") ?? d.evidence[0])?.text ?? "",
  }));
  return { apps, signals: names.map((s) => ({ name: s.name, provider: s.provider, count: s.count })) };
}

/** FactsUnseen — null when the repository was never scanned (nothing to say what was looked for), and for a
 *  repository that is not the org's primary one: the capture is the primary repository's, so what GitHub showed of
 *  any other is unknown — never zero. */
export async function readUnseen(ctx: TenantContext, repo: string, now: number = Date.now()): Promise<FactsUnseen | null> {
  const scan = await readScan(ctx, repo);
  if (!scan.scannedAt) return null;
  const since30 = new Date(now - 30 * 86_400_000).toISOString();
  const d = new Date(now);
  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  // The capture is the primary repository's: another repository reads nothing (and its PR counts are unknown).
  const row = await first<{ is_primary: number; reconciled: number; open_prs: number; merged: number; deployments: number; workflows: string | null }>(ctx, `
    WITH primary_repo AS (SELECT lower(repo_full_name) AS r FROM org_repos WHERE org_id = ? ORDER BY is_primary DESC, created_at, id LIMIT 1),
    latest AS (SELECT number, state, occurred_at, ROW_NUMBER() OVER (PARTITION BY number ORDER BY occurred_at DESC, id DESC) AS rn
               FROM repo_events WHERE org_id = ? AND kind = 'pr')
    SELECT (lower(?) = (SELECT r FROM primary_repo)) AS is_primary,
           EXISTS (SELECT 1 FROM repo_snapshots s WHERE s.org_id = ? AND s.kind = 'prs_reconciled') AS reconciled,
           (SELECT COUNT(*) FROM latest WHERE rn = 1 AND state IN ('review', 'draft')) AS open_prs,
           (SELECT COUNT(*) FROM latest WHERE rn = 1 AND state = 'merged' AND occurred_at >= ?) AS merged,
           (SELECT COUNT(DISTINCT e.number) FROM repo_events e WHERE e.org_id = ? AND e.kind = 'deploy' AND e.occurred_at >= ?
              AND COALESCE(json_extract(e.raw, '$.signal'), 'deployment') = 'deployment') AS deployments,
           (SELECT json_group_array(p) FROM (SELECT DISTINCT json_extract(w.raw, '$.path') AS p FROM repo_events w
              WHERE w.org_id = ? AND w.kind = 'run' AND w.occurred_at >= ? AND json_extract(w.raw, '$.path') IS NOT NULL ORDER BY p)) AS workflows`,
    ctx.orgId, ctx.orgId, repo, ctx.orgId, monthStart, ctx.orgId, since30, ctx.orgId, since30);
  if (!row?.is_primary) return null;
  const known = !!row.reconciled;
  return {
    looked: scan.looked,
    tags: await readTags(ctx, repo), // Phase F: releases and bare tags (`releases`), null until a reconcile read them
    prs: { open: known ? Number(row.open_prs) : null, mergedThisMonth: known ? Number(row.merged) : null },
    workflows: strings(parse(row.workflows ?? "[]", [])).map((p) => p.replace(/^.*\//, "")),
    deploymentsSeen30d: Number(row.deployments ?? 0),
  };
}
