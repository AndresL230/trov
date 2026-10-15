// The suggestion lifecycle and an admin's Scan again (repo setups, Phase D) — the CREDENTIALED side of the repo scan.
// Called by the cookie routes (./scan-routes.ts, and the Apps tab's) and by the reconcile job (src/repo/cron.ts,
// `describeSources`). NEVER reachable from src/mcp.ts: it resolves credentials and writes apps and parts. The facts
// read (MCP-reachable) imports the read side from ./scan-reads.ts — re-exported here for the routes' convenience.
//
//   acceptSuggestion   admin: the suggestion's app (`putRepoApp`, source `suggested`, audited `app.set`) and its parts
//                      (`putPart`, audited `part.set` — one per environment the evidence names, else the first; a
//                      part's settings are the provider's own keys only), as that admin. Each writer is its own
//                      batch (their audits ride with them); if a part is refused, what this accept wrote is removed
//                      again (audited) and the refusal stands. Refused when the app key already names an app or a
//                      part (409 `key_taken`) — so everything Undo removes is what the accept made. → `{ undo }`.
//   ignoreSuggestion   admin: hidden until an admin's Scan again. → `{ undo }`.
//   undoAccept         admin, within UNDO_WINDOW_MS of the decision the token names: an accept's parts and app
//                      removed (audited `part.delete` / `app.delete`), or an ignore lifted; the suggestion is pending.
//   runScanNow         admin: Scan again — the scan forced past the tree-sha guard, ignored suggestions back.
import { HOSTING_INTEGRATION_KIND } from "@shared/hosting";
import { APP_KIND_ROLE, isAppKind, type RepoApp } from "@shared/repo-apps-core";
import type { AppSuggestionDTO, RepoScanDTO } from "@shared/repo-scan-core";
import type { Env } from "../env";
import { requireRole } from "../data/context";
import { first, run, type TenantContext } from "../data/sql";
import { resolveCredential, resolveIntegrationConfig } from "../data/secrets";
import { resolveGithubCredential } from "../github-app/credential";
import { hostFetch } from "../hosting/http";
import { deletePart, putPart } from "../hosting/part-writes";
import { listAllParts } from "../hosting/parts";
import { PROVIDERS } from "../hosting/registry";
import { SettingsError, listEnvironments } from "../integrations/settings";
import { deleteRepoApp, putRepoApp } from "./apps";
import { DESCRIBE_PROVIDERS, recordScanError, scanRepo, validSettings, type DescribeSource, type ProviderMap } from "./scan";
import { listSuggestions, readScan, type StoredPart, type SuggestionRow } from "./scan-reads";

export { listSuggestions, readScan, readFound, readUnseen } from "./scan-reads";

/** How long after an accept / ignore its Undo still works (the toast shows for 5 s; a slow click is still honoured). */
export const UNDO_WINDOW_MS = 10 * 60_000;

const notFound = () => new SettingsError("not_found", 404, "no such suggestion");

/**
 * The connected hosts the scan may describe — each provider that has `describe` and an org-wide credential, with
 * that credential (resolved here, never in the scan) and its fixed-host fetch. D1 only; a credential that cannot be
 * read is simply left out.
 */
export async function describeSources(env: Env, ctx: TenantContext, fetchImpl?: typeof fetch, now: number = Date.now(), providers: ProviderMap = PROVIDERS): Promise<DescribeSource[]> {
  const out: DescribeSource[] = [];
  for (const id of DESCRIBE_PROVIDERS) {
    const provider = providers[id];
    const kind = HOSTING_INTEGRATION_KIND[id];
    if (!provider?.describe || provider.status !== "available" || !kind) continue;
    try {
      const secret = await resolveCredential(ctx, env, kind, "");
      if (!secret) continue;
      const config = await resolveIntegrationConfig(ctx, env, kind, "");
      out.push({ provider, pc: { fetch: hostFetch(provider.apiHosts, fetchImpl), credential: { secret, config }, now } });
    } catch {
      console.error("repo scan", "describe credential", id, `org=${ctx.orgId}`); // the kind only — never a value
    }
  }
  return out;
}

const ROW_COLS = `id, repo, key, folder, kind, provider, evidence, parts, used_by, state, decided_at, decided_by, created_at`;
const rowOf = (ctx: TenantContext, id: string) =>
  first<SuggestionRow>(ctx, `SELECT ${ROW_COLS} FROM repo_app_suggestions WHERE org_id = ? AND id = ?`, ctx.orgId, id);
const parts = (json: string): StoredPart[] => {
  try { const v = JSON.parse(json) as unknown; return Array.isArray(v) ? (v as StoredPart[]) : []; } catch { return []; }
};
const undoToken = (id: string, at: string) => `${id}~${at}`;

export interface AcceptSuggestionResult {
  app: RepoApp;
  /** The parts written: environment, key (= the app's), provider. */
  parts: { env: string; key: string; provider: string }[];
  /** Hand back to `undoAccept` within UNDO_WINDOW_MS. */
  undo: string;
}

/** Accept one suggestion (see the header). `handle` is the authenticated admin (decided_by). */
export async function acceptSuggestion(ctx: TenantContext, handle: string, id: string, opts: { providers?: ProviderMap; now?: number } = {}): Promise<AcceptSuggestionResult> {
  requireRole(ctx, "admin");
  const providers = opts.providers ?? PROVIDERS;
  const row = await rowOf(ctx, id);
  if (!row) throw notFound();
  if (row.state === "accepted") throw new SettingsError("already_accepted", 409, "this suggestion is already accepted");
  if (!isAppKind(row.kind)) throw new SettingsError("invalid", 400, "this suggestion's kind is not one Trov knows");
  const kind = row.kind;
  const taken = await first<{ key: string }>(ctx,
    `SELECT key FROM repo_apps WHERE org_id = ? AND key = ? UNION SELECT part_key FROM org_environment_parts WHERE org_id = ? AND part_key = ?`,
    ctx.orgId, row.key, ctx.orgId, row.key);
  if (taken) throw new SettingsError("key_taken", 409, "an app or a part already has this suggestion's key");

  // One part per environment the evidence named, if that environment still exists; else the first environment.
  const envKeys = (await listEnvironments(ctx)).map((e) => e.key);
  const proposed = kind === "Package" ? [] : parts(row.parts);
  let targets = proposed.filter((p) => envKeys.includes(p.env));
  if (!targets.length && proposed.length && envKeys.length) targets = [{ ...proposed[0], env: envKeys[0] }];
  targets = targets.filter((p, i) => targets.findIndex((q) => q.env === p.env) === i);

  const { app } = await putRepoApp(ctx, row.key, { repo: row.repo, folder: row.folder, kind, source: "suggested" });
  const written: { env: string; key: string; provider: string }[] = [];
  try {
    for (const p of targets) {
      const provider = providers[p.provider];
      const settings = validSettings(provider, p.settings);
      if (!provider || !settings) continue; // a host that can no longer take it (not available, settings refused) — the app stands without it
      const role = APP_KIND_ROLE[kind];
      await putPart(ctx, p.env, row.key, { provider: p.provider, settings, ...(role && provider.roles.includes(role) ? { role } : {}) }, providers);
      written.push({ env: p.env, key: row.key, provider: p.provider });
    }
  } catch (e) {
    for (const w of written) await deletePart(ctx, w.env, w.key).catch(() => undefined);
    await deleteRepoApp(ctx, row.key).catch(() => undefined);
    throw e;
  }
  const at = new Date(opts.now ?? Date.now()).toISOString();
  await run(ctx, `UPDATE repo_app_suggestions SET state = 'accepted', decided_at = ?, decided_by = ? WHERE org_id = ? AND id = ?`, at, handle, ctx.orgId, id);
  return { app, parts: written, undo: undoToken(id, at) };
}

/** Ignore one pending suggestion: hidden until an admin's Scan again. */
export async function ignoreSuggestion(ctx: TenantContext, handle: string, id: string, now: number = Date.now()): Promise<{ undo: string }> {
  requireRole(ctx, "admin");
  const row = await rowOf(ctx, id);
  if (!row) throw notFound();
  if (row.state === "accepted") throw new SettingsError("already_accepted", 409, "this suggestion is already accepted");
  const at = new Date(now).toISOString();
  await run(ctx, `UPDATE repo_app_suggestions SET state = 'ignored', decided_at = ?, decided_by = ? WHERE org_id = ? AND id = ?`, at, handle, ctx.orgId, id);
  return { undo: undoToken(id, at) };
}

/** Undo an accept or an ignore (see the header). */
export async function undoAccept(ctx: TenantContext, _handle: string, token: string, now: number = Date.now()): Promise<{ id: string; undone: "accept" | "ignore" }> {
  requireRole(ctx, "admin");
  const m = typeof token === "string" ? /^(sg_[0-9a-f]{20})~(\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/.exec(token) : null;
  if (!m) throw new SettingsError("invalid", 400, "the undo token is not valid", "undo");
  const [, id, at] = m;
  const row = await rowOf(ctx, id);
  if (!row || row.decided_at !== at || (row.state !== "accepted" && row.state !== "ignored")) throw new SettingsError("not_found", 404, "there is nothing to undo");
  if (now - Date.parse(at) > UNDO_WINDOW_MS) throw new SettingsError("too_late", 409, "it is too late to undo that");
  if (row.state === "accepted") {
    // The accept refused an existing key, so every part with it (and the app row, if still the suggestion's) is its.
    for (const p of (await listAllParts(ctx)).filter((x) => x.key === row.key)) await deletePart(ctx, p.env, p.key);
    const app = await first<{ source: string }>(ctx, `SELECT source FROM repo_apps WHERE org_id = ? AND key = ?`, ctx.orgId, row.key);
    if (app?.source === "suggested") await deleteRepoApp(ctx, row.key);
  }
  await run(ctx, `UPDATE repo_app_suggestions SET state = 'pending', decided_at = NULL, decided_by = NULL WHERE org_id = ? AND id = ?`, ctx.orgId, id);
  return { id, undone: row.state === "accepted" ? "accept" : "ignore" };
}

export interface ScanNowResult {
  ok: boolean;
  /** Suggestions this scan added. */
  added: number;
  scan: RepoScanDTO;
  suggestions: AppSuggestionDTO[];
}

/**
 * An admin's Scan again: the repository (default: the primary; it must be one of the org's) scanned NOW — past the
 * tree-sha guard — with ignored suggestions back to pending. `ok: false` when it could not run; `scan.error` says
 * why (no GitHub connection, a refused read), in fixed words.
 */
export async function runScanNow(env: Env, ctx: TenantContext, repo?: string, opts: { fetchImpl?: typeof fetch; now?: number; providers?: ProviderMap } = {}): Promise<ScanNowResult> {
  requireRole(ctx, "admin");
  const now = opts.now ?? Date.now();
  const held = await first<{ repo_full_name: string }>(ctx, repo
    ? `SELECT repo_full_name FROM org_repos WHERE org_id = ? AND lower(repo_full_name) = lower(?)`
    : `SELECT repo_full_name FROM org_repos WHERE org_id = ? ORDER BY is_primary DESC, created_at, id LIMIT 1`, ...(repo ? [ctx.orgId, repo] : [ctx.orgId]));
  if (!held) throw new SettingsError("not_found", 404, "no such repository");
  const name = held.repo_full_name;
  const done = async (ok: boolean, added: number): Promise<ScanNowResult> => ({ ok, added, scan: await readScan(ctx, name), suggestions: await listSuggestions(ctx, name, now) });
  const gh = await resolveGithubCredential(ctx, env, { repo: name, fetchImpl: opts.fetchImpl, now }).catch(() => null);
  if (!gh) {
    await recordScanError(ctx, name, "GitHub isn't connected for this repository", now);
    return done(false, 0);
  }
  try {
    const out = await scanRepo(ctx, { token: gh.token.reveal(), repo: name, fetchImpl: gh.fetch(opts.fetchImpl) }, {
      now, force: true, resetIgnored: true, providers: opts.providers,
      describe: () => describeSources(env, ctx, opts.fetchImpl, now, opts.providers),
    });
    return done(!out.failed, out.added); // a refusal: scanRepo recorded why in repo_scans.error (fixed words)
  } catch {
    await recordScanError(ctx, name, "the repository's files could not be read", now).catch(() => undefined);
    return done(false, 0);
  }
}
