// Org settings › Repositories › a repo › Apps (repo setups, Phase D2) — the read the screen draws in one request,
// and the app writes it sends, each bound to ONE connected repository.
//
//   read    `getRepoAppsSetup` → `RepoAppsSetupDTO`: the repository's apps (`listRepoApps`) with every part of
//           each app key in every environment (`describeParts` — the part rows Hosting has always drawn, with
//           THE status function's connection), the scan's suggestions (`listSuggestions`), the GitHub deploy
//           signals seen in 30 days (`seenSignals`), the "unassigned deploy names" (signals no `github` part's
//           setting names and no pending suggestion carries — shared/repo-apps-setup-core.ts), the last scan, the
//           tags seen, the environments in drift order and the provider catalogue's words. D1 rows only: nothing
//           here calls GitHub or a host (invariant 7). A failed sub-read (suggestions, signals, scan) is that
//           part empty and `degraded: true` — never a 500.
//   write   `putAppInRepo` / `removeAppInRepo` — through Phase A's audited writers (`putRepoApp`, `deleteRepoApp`;
//           `deletePart` for an app's parts when the person asks for them to go too). An app key that belongs to
//           ANOTHER repository is refused (409), never moved by a write addressed to this one.
import { requireRole } from "../data/context";
import { first, type TenantContext } from "../data/sql";
import type { Env } from "../env";
import { HOSTING_PROVIDERS, type EnvironmentPartDTO } from "@shared/hosting";
import type { AppSuggestionDTO, RepoAppsSetupDTO, RepoScanDTO, SeenSignal } from "@shared/repo-scan-core";
import { SIGNAL_WINDOW_DAYS, unassignedSignals } from "@shared/repo-apps-setup-core";
import type { RepoApp } from "@shared/repo-apps-core";
import { SettingsError, listEnvironments } from "../integrations/settings";
import { listAllParts } from "../hosting/parts";
import { deletePart, type ProviderMap } from "../hosting/part-writes";
import { PROVIDERS } from "../hosting/registry";
import { describeParts } from "../hosting/setup";
import { deleteRepoApp, listRepoApps, putRepoApp } from "./apps";
import { seenSignals } from "./signals";
import { listSuggestions, readScan } from "./scan-store";
import { readTags } from "./releases";

/** What the read stands on — injectable so a test can stand the scan's (D1's) reads in. */
export interface AppsSetupDeps {
  seenSignals: (ctx: TenantContext, repo: string, sinceDays?: number) => Promise<SeenSignal[]>;
  listSuggestions: (ctx: TenantContext, repo: string) => Promise<AppSuggestionDTO[]>;
  readScan: (ctx: TenantContext, repo: string) => Promise<RepoScanDTO>;
  /** The tags Trov holds for the repository (releases, Phase F). */
  readTags: (ctx: TenantContext, repo: string) => Promise<{ count: number; latest: { tag: string; at: string } | null } | null>;
  providers: ProviderMap;
}
export const APPS_SETUP_DEPS: AppsSetupDeps = { seenSignals, listSuggestions, readScan, readTags, providers: PROVIDERS };

const NO_SCAN: RepoScanDTO = { treeSha: null, scannedAt: null, looked: [], error: null };

/** `owner/name` as the org connected it (GitHub compares names case-insensitively) — or null: not this org's. */
export async function connectedRepo(ctx: TenantContext, owner: string, name: string): Promise<string | null> {
  const want = `${owner}/${name}`;
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(want)) return null;
  return (await first<{ repo_full_name: string }>(ctx,
    `SELECT repo_full_name FROM org_repos WHERE org_id = ? AND lower(repo_full_name) = lower(?) LIMIT 1`, ctx.orgId, want))?.repo_full_name ?? null;
}

const notFound = (what: string) => new SettingsError("not_found", 404, `no such ${what}`);

/** A sub-read that may fail without failing the screen: its answer, or the fallback and a mark. */
async function soft<T>(read: () => Promise<T>, fallback: T, mark: { degraded: boolean }): Promise<T> {
  try { return await read(); } catch (e) {
    console.error("apps setup sub-read failed", e instanceof Error ? e.name : "error"); // the name only
    mark.degraded = true;
    return fallback;
  }
}

/** Everything the Apps tab draws for one repository (admin). `repo` is the canonical `owner/name`. */
export async function getRepoAppsSetup(ctx: TenantContext, env: Env, repo: string, deps: AppsSetupDeps = APPS_SETUP_DEPS): Promise<RepoAppsSetupDTO> {
  requireRole(ctx, "admin");
  const mark = { degraded: false };
  const apps = await listRepoApps(ctx, repo);
  const allParts = await listAllParts(ctx);
  const keys = new Set(apps.map((a) => a.key));
  const described = await describeParts(ctx, env, allParts.filter((p) => keys.has(p.key)), deps.providers);
  const environments = (await listEnvironments(ctx)).map((e) => ({ key: e.key, label: e.label, branch: e.branch }));
  const suggestions = await soft(() => deps.listSuggestions(ctx, repo), [] as AppSuggestionDTO[], mark);
  const signals = await soft(() => deps.seenSignals(ctx, repo, SIGNAL_WINDOW_DAYS), [] as SeenSignal[], mark);
  const scan = await soft(() => deps.readScan(ctx, repo), NO_SCAN, mark);
  // null until a reconcile has read the repository's releases: unknown, never "0 tags".
  const tags = await soft(() => deps.readTags(ctx, repo), null, mark);
  // Every `github` part of the org names what it reads, whichever repository its app lives in.
  const githubSettings = allParts.filter((p) => deps.providers[p.provider]?.credential === "github_app").map((p) => p.settings);
  const byKey = new Map<string, EnvironmentPartDTO[]>();
  for (const p of described) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
  return {
    repo,
    apps: apps.map((a: RepoApp) => ({ ...a, parts: byKey.get(a.key) ?? [] })),
    suggestions,
    unassigned: unassignedSignals(signals, githubSettings, suggestions),
    signals,
    scan: scan ?? NO_SCAN,
    // The tags held for the repository (src/repo/releases.ts `readTags`), as the release-signal choice reads them.
    tags: tags ? { count: tags.count, latest: tags.latest ? { tag: tags.latest.tag, at: tags.latest.at } : null } : null,
    environments,
    providers: HOSTING_PROVIDERS.map((id) => deps.providers[id]).filter((p) => p && p.status === "available")
      .map((p) => ({ id: p.id, label: p.label, via_github: p.credential === "github_app" })),
    ...(mark.degraded ? { degraded: true } : {}),
  };
}

const APP_FIELDS = ["kind", "label", "folder", "watch", "release_signal", "position"];

/** The app this key names in the org, if any (a row, or a part key read as an app), and whether it is this repo's. */
async function appOf(ctx: TenantContext, repo: string, key: string): Promise<{ app: RepoApp | null; elsewhere: boolean }> {
  const app = (await listRepoApps(ctx)).find((a) => a.key === key) ?? null;
  return { app, elsewhere: !!app && app.repo.toLowerCase() !== repo.toLowerCase() };
}

/** Create or change an app of THIS repository (admin), through `putRepoApp` (validated, audited `app.set`). The
 *  body is the app's own fields — never `repo` (the path names it) or `source`. */
export async function putAppInRepo(ctx: TenantContext, repo: string, key: string, body: unknown): Promise<{ app: RepoApp; created: boolean }> {
  requireRole(ctx, "admin");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SettingsError("invalid", 400, "the body must be a JSON object", "body");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !APP_FIELDS.includes(k))) throw new SettingsError("invalid", 400, "the body has a field an app does not have", "body");
  const { elsewhere, app } = await appOf(ctx, repo, key);
  if (elsewhere) throw new SettingsError("app_conflict", 409, `that key belongs to an app of ${app?.repo || "another repository"}`, "key");
  return putRepoApp(ctx, key, { ...b, repo });
}

export interface AppRemoved { key: string; removed_parts: { env: string; part: string }[]; kept_parts: number }

/**
 * Remove an app of THIS repository (admin). Its `repo_apps` row goes (`deleteRepoApp`, audited `app.delete`);
 * its parts stay unless `removeParts` (each through `deletePart`, audited `part.delete`, its deploys and poll
 * state with it). An app with no row IS its parts (a part key read as an app): it can only be removed with them.
 */
export async function removeAppInRepo(ctx: TenantContext, repo: string, key: string, removeParts: boolean): Promise<AppRemoved> {
  requireRole(ctx, "admin");
  const { app, elsewhere } = await appOf(ctx, repo, key);
  if (!app || elsewhere) throw notFound("app");
  const parts = (await listAllParts(ctx)).filter((p) => p.key === key);
  if (app.source === "synthesised" && !removeParts) {
    throw new SettingsError("invalid", 400, "this app is read from its parts: remove them to remove it", "parts");
  }
  if (app.source !== "synthesised") await deleteRepoApp(ctx, key);
  const removed: { env: string; part: string }[] = [];
  if (removeParts) for (const p of parts) { await deletePart(ctx, p.env, p.key); removed.push({ env: p.env, part: p.key }); }
  return { key, removed_parts: removed, kept_parts: removeParts ? 0 : parts.length };
}
