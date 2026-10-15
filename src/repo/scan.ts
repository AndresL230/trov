// The repo scan (repo setups, Phase D): which apps a repository holds, SUGGESTED for an admin to accept. A guarded arm
// of `reconcileRepo` (src/repo/github.ts) and an admin's Scan again (src/repo/scan-store.ts `runScanNow`). Never on a
// render path. Secret-free: the GitHub token comes in `GhOpts`, a connected host's credential in a `DescribeSource`
// the caller built (src/repo/scan-store.ts `describeSources`).
//
// Cost — at most `SCAN_COST` requests:
//   1. ONE tree read: `GET /repos/:o/:r/git/trees/HEAD?recursive=1` (HEAD = the default branch). Its `sha` is the
//      root tree's. THE GUARD: the same sha as `repo_scans.tree_sha` → stop here, ZERO further requests (unless an
//      admin's Scan again forces it). A TRUNCATED tree (GitHub stops at 100,000 entries / 7 MB) is scanned with the
//      entries GitHub did list — nearest the root, as GitHub lists them breadth-first — and the scan's `error` says
//      so; its sha is stored like any other, so a huge repository is not re-read every reconcile.
//   2. ONE GraphQL batch of ≤ 24 files (`object(expression: "HEAD:<path>")`, step 0 confirmed — a missing path is
//      null, not an error): the tree's paths the detectors' patterns name, nearest the root first (./detect/index.ts).
//   3. ≤ 1 `describe` list call per CONNECTED host that has one (Vercel, Render, Netlify) — which folder each of
//      its projects builds. A failure there is logged scrubbed and the scan goes on without it.
// D1: the stored scan, the org's apps (never re-suggest a folder that has one), environments and seen signals.
//
// What it writes (ONE batch): `repo_app_suggestions` — a pending row per candidate (stable id = repo + folder +
// kind), never touching an accepted one, keeping an ignored one ignored unless `resetIgnored` (an admin's Scan
// again), deleting pending / ignored rows the scan no longer finds — and the `repo_scans` row. Nothing else: a
// suggestion changes nothing on the Repo screen until an admin accepts it.
import { PART_KEY_RE, type HostingProviderId } from "@shared/hosting";
import type { AppKind } from "@shared/repo-apps-core";
import type { SeenSignal, SuggestionEvidence } from "@shared/repo-scan-core";
import { all, batch, first, stmt, type Stmt, type TenantContext } from "../data/sql";
import { PROVIDERS, checkFields } from "../hosting/registry";
import { DESCRIBE_COST, type DescribedProject, type HostingProvider, type ProviderContext } from "../hosting/types";
import { listRepoApps } from "./apps";
import { orgEnvironments, type RepoEnvConfig } from "./config";
import { detectAll, lookedFor, pickFiles, scannable, SCAN_FILE_MAX, type Candidate } from "./detect";
import { envForHint, matchSignals, parseSignalName } from "./detect/match";
import { ghGraphql, ghJson, scrubbedMessage, type GhOpts } from "./github";
import { seenSignals } from "./signals";
import type { StoredEvidence, StoredPart } from "./scan-reads";

export type ProviderMap = Readonly<Record<HostingProviderId, HostingProvider>>;

/** Providers that can say which folder a project builds. */
export const DESCRIBE_PROVIDERS = (Object.values(PROVIDERS) as HostingProvider[]).filter((p) => typeof p.describe === "function").map((p) => p.id);
/** Worst-case requests of one scan: the tree, the file batch, one describe per describe-capable provider. */
export const SCAN_COST = 2 + DESCRIBE_PROVIDERS.length * DESCRIBE_COST;
/** A file's text is used only up to this size (a config file is a few KB; a lockfile is not read). */
const FILE_TEXT_MAX = 200_000;

/** A connected host the scan may ask (`describe`), with its credential — built by the caller, never here. */
export interface DescribeSource { provider: HostingProvider; pc: ProviderContext }

export interface ScanOpts {
  now?: number;
  /** An admin's Scan again: read even when the tree sha is the stored one. */
  force?: boolean;
  /** An admin's Scan again: ignored suggestions come back as pending. */
  resetIgnored?: boolean;
  /** The connected hosts to describe — resolved LAZILY, only when the scan gets past the tree-sha guard. */
  describe?: () => Promise<DescribeSource[]>;
  providers?: ProviderMap;
}

export interface ScanOutcome {
  /** True when the tree sha was the stored one: nothing past the tree read was asked. */
  skipped: boolean;
  treeSha: string | null;
  /** Pending suggestions after the scan (accepted ones excluded). */
  pending: number | null;
  /** Suggestions this scan added (not seen before). */
  added: number;
  /** Requests it made (≤ SCAN_COST). */
  requests: number;
}

export type { StoredEvidence, StoredPart } from "./scan-reads";

/** One suggestion as the scan builds it (pure — `buildSuggestions`). */
export interface BuiltSuggestion {
  id: string;
  key: string;
  folder: string;
  kind: AppKind;
  provider: HostingProviderId | null;
  evidence: StoredEvidence[];
  parts: StoredPart[];
  usedBy: string[];
}

// ── reading GitHub ───────────────────────────────────────────────────────────

interface GhTree { sha?: string; truncated?: boolean; tree?: { path?: string; type?: string }[] }

/** The ONE GraphQL batch: ≤ 24 files by `HEAD:<path>`, passed as variables (never spliced into the query). */
async function readFiles(gh: GhOpts, paths: readonly string[]): Promise<Map<string, string>> {
  const [owner, name] = gh.repo.split("/");
  const vars: Record<string, unknown> = { owner, name };
  const decl = ["$owner:String!", "$name:String!"];
  const fields: string[] = [];
  paths.slice(0, SCAN_FILE_MAX).forEach((p, i) => {
    vars[`p${i}`] = `HEAD:${p}`;
    decl.push(`$p${i}:String!`);
    fields.push(`f${i}: object(expression: $p${i}) { ... on Blob { text isBinary byteSize } }`);
  });
  const query = `query(${decl.join(",")}){ repository(owner:$owner,name:$name){ ${fields.join(" ")} } }`;
  const data = await ghGraphql<{ repository?: Record<string, { text?: string | null; isBinary?: boolean; byteSize?: number } | null> | null }>(gh, query, vars);
  const out = new Map<string, string>();
  paths.slice(0, SCAN_FILE_MAX).forEach((p, i) => {
    const blob = data?.repository?.[`f${i}`];
    if (!blob || blob.isBinary || typeof blob.text !== "string" || blob.text.length > FILE_TEXT_MAX) return;
    out.set(p, blob.text);
  });
  return out;
}

// ── building suggestions (pure) ──────────────────────────────────────────────

const slug = (s: string): string => s.toLowerCase().replace(/^@[^/]+\//, "").replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 32).replace(/-$/, "");

/** The stable id of a suggestion: a hash of repo + folder + kind. */
export async function suggestionId(repo: string, folder: string, kind: AppKind): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${repo.toLowerCase()}\n${folder}\n${kind}`)));
  return `sg_${[...bytes.slice(0, 10)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A signal as a sentence ("GitHub deployment “Production – storefront-web” seen 31 times"). */
export function signalEvidence(s: SeenSignal): StoredEvidence {
  const times = `${s.count} ${s.count === 1 ? "time" : "times"}`;
  const text = s.kind === "deployment" ? `GitHub deployment “${s.name}” seen ${times}`
    : s.kind === "check" ? `Check run “${s.name}” seen ${times}`
    : s.kind === "status" ? `Commit status “${s.name}” seen ${times}`
    : `Workflow ${s.name}, ${s.count} ${s.count === 1 ? "run" : "runs"}`;
  return { kind: "signal", text, signal: { kind: s.kind, name: s.name } };
}

/** A `github` part's settings that name this signal, or null (a commit status cannot be one). */
function githubSettingsOf(s: SeenSignal): Record<string, string> | null {
  if (s.kind === "deployment") return { environment: s.name };
  if (s.kind === "check" && s.source) return { check_app: s.source, check_name: s.name };
  if (s.kind === "workflow" && s.source) return { workflow: s.source };
  return null;
}

/** Settings a provider would accept for a part (its own keys only — extras such as `crons` dropped), or null. */
export function validSettings(provider: HostingProvider | undefined, settings: Readonly<Record<string, string>> | undefined): Record<string, string> | null {
  if (!provider || provider.status !== "available") return null;
  const own = Object.fromEntries(Object.entries(settings ?? {}).filter(([k]) => provider.partSettings.some((f) => f.key === k)));
  const checked = checkFields(provider.partSettings, own, "settings");
  if ("field" in checked) return null;
  if (provider.checkSettings?.(checked.values)) return null;
  return checked.values;
}

const SIGNAL_RANK: Record<SeenSignal["kind"], number> = { deployment: 0, check: 1, workflow: 2, status: 3 };

/**
 * The parts a suggestion proposes: one per environment the evidence names, else the first environment.
 *   - the candidate's own host, when its settings are complete (a Worker name, a Fly.io app, a described Vercel
 *     project…): wrangler's `[env.<name>]` Workers go to the environments they name; the main settings go to the
 *     environment a `production` signal names, else one called production, else the first named, else the first;
 *   - every other environment a matched signal names gets a `github` part naming that signal (its deployment
 *     environment, check run or workflow);
 *   - nothing named and no own host: the deploying workflow (a Dockerfile's), else the one matched signal, on the
 *     first environment.
 * Settings keep the detector's extras (a Worker's `d1_database_ids`, `crons`) for Phase G; Accept writes only the
 * provider's own keys. A Package has no parts.
 */
export function buildParts(c: Candidate, signals: readonly SeenSignal[], envs: readonly RepoEnvConfig[], providers: ProviderMap): StoredPart[] {
  if (c.kind === "Package" || !envs.length) return [];
  const out: StoredPart[] = [];
  const github = providers.github;
  // The environment each matched signal names (the best signal per environment: deployment > check > workflow).
  const named = new Map<string, SeenSignal>();
  for (const s of [...signals].sort((a, b) => SIGNAL_RANK[a.kind] - SIGNAL_RANK[b.kind])) {
    const env = envForHint(parseSignalName(s).envHint, envs);
    if (env && !named.has(env) && githubSettingsOf(s)) named.set(env, s);
  }
  const used = new Set<string>();
  const provider = c.provider ? providers[c.provider] : undefined;
  const own = provider && provider.id !== "github" ? validSettings(provider, c.settings) : null;
  if (provider && own) {
    for (const [envName, s] of Object.entries(c.envSettings ?? {})) {
      const env = envForHint(envName, envs);
      if (!env || used.has(env) || !validSettings(provider, s)) continue;
      used.add(env);
      out.push({ env, provider: provider.id, settings: { ...s } });
    }
    const prodSignal = [...named].find(([, s]) => parseSignalName(s).envHint === "production")?.[0];
    const primary = [prodSignal, envForHint("production", envs), ...named.keys(), ...envs.map((e) => e.key)].find((e): e is string => !!e && !used.has(e));
    if (primary) { used.add(primary); out.push({ env: primary, provider: provider.id, settings: { ...(c.settings ?? {}) } }); }
  }
  for (const [env, s] of named) {
    if (used.has(env)) continue;
    const settings = validSettings(github, githubSettingsOf(s) ?? undefined);
    if (!settings) continue;
    used.add(env);
    out.push({ env, provider: "github", settings });
  }
  if (!out.length) {
    const fromWorkflow = c.workflow ? validSettings(github, { workflow: c.workflow }) : null;
    const unnamed = signals.filter((s) => githubSettingsOf(s) && !parseSignalName(s).envHint);
    const fromSignal = unnamed.length === 1 ? validSettings(github, githubSettingsOf(unnamed[0]) ?? undefined) : null;
    const settings = fromWorkflow ?? fromSignal;
    if (settings) out.push({ env: envs[0].key, provider: "github", settings });
  }
  return out;
}

/** Fold what the connected hosts said (`describe`) into the candidates: a project building a folder that has a
 *  candidate upgrades its evidence (and fills its host's settings, or makes a Package an app); one building a
 *  folder nothing else proposed becomes a candidate of its own. */
export function foldDescribed(candidates: Candidate[], described: readonly { provider: HostingProviderId; label: string; project: DescribedProject }[]): Candidate[] {
  const out = candidates.map((c) => ({ ...c, evidence: [...c.evidence], names: [...(c.names ?? [])] }));
  for (const { provider, label, project } of described) {
    const ev: SuggestionEvidence = { kind: "provider", text: `${label} project ${project.name} builds ${project.folder === "/" ? "the repository root" : project.folder}` };
    const at = out.filter((c) => c.folder === project.folder);
    const target = at.find((c) => c.provider === provider) ?? at.find((c) => c.provider === null && c.kind !== "Package") ?? at.find((c) => c.kind === "Package");
    if (target) {
      if (target.kind === "Package") { target.kind = project.kind ?? "Site"; target.source = "deploy"; target.usedBy = []; }
      if (target.provider === null || target.provider === provider) {
        target.provider = provider;
        target.settings = { ...(target.settings ?? {}), ...project.settings };
      }
      target.evidence.push(ev);
      if (!target.names!.includes(project.name)) target.names!.push(project.name);
      continue;
    }
    out.push({ folder: project.folder, kind: project.kind ?? "Site", provider, source: "deploy", evidence: [ev], settings: { ...project.settings }, names: [project.name] });
  }
  return out;
}

/**
 * Candidates → suggestions (pure, but for the id hash): skip a folder the repository already has an app at; give
 * each a key (an existing suggestion's key for the same id, else the folder's last segment — the root's: a name the
 * host knows it by, else the repository's — unique against the org's app keys); attach its matched signals'
 * evidence; propose its parts.
 */
export async function buildSuggestions(args: {
  repo: string; candidates: readonly Candidate[]; signals: readonly SeenSignal[]; envs: readonly RepoEnvConfig[];
  appFolders: ReadonlySet<string>; appKeys: ReadonlySet<string>; keptKeys: ReadonlyMap<string, string>; providers: ProviderMap;
}): Promise<BuiltSuggestion[]> {
  const cands = args.candidates.filter((c) => !args.appFolders.has(c.folder));
  const matched = matchSignals(cands, args.signals, args.repo);
  const taken = new Set(args.appKeys);
  const out: BuiltSuggestion[] = [];
  // Ids first, so kept keys are reserved before new ones are chosen.
  const ids = await Promise.all(cands.map((c) => suggestionId(args.repo, c.folder, c.kind)));
  for (const id of ids) { const k = args.keptKeys.get(id); if (k) taken.add(k); }
  cands.forEach((c, i) => {
    const sigs = matched[i];
    let key = args.keptKeys.get(ids[i]);
    if (!key) {
      const base = slug(c.folder === "/" ? (c.names?.[0] ?? args.repo.split("/").pop() ?? "app") : c.folder.split("/").pop()!) || "app";
      const tries = [base, slug(`${base}-${c.kind}`), ...Array.from({ length: 20 }, (_, n) => slug(`${base.slice(0, 28)}-${n + 2}`))];
      key = tries.find((k) => PART_KEY_RE.test(k) && !taken.has(k));
      if (!key) return; // twenty-odd apps of the same name: not suggested rather than guessed
      taken.add(key);
    }
    // A host the files did not name, but every matched signal agrees on.
    const hosts = [...new Set(sigs.map((s) => s.provider).filter((p): p is HostingProviderId => p !== null))];
    const provider = c.provider ?? (hosts.length === 1 ? hosts[0] : null);
    const cand = provider === c.provider ? c : { ...c, provider };
    out.push({
      id: ids[i], key, folder: c.folder, kind: c.kind, provider,
      evidence: [...c.evidence, ...sigs.map(signalEvidence)],
      parts: buildParts(cand, sigs, args.envs, args.providers),
      usedBy: c.usedBy ?? [],
    });
  });
  return out;
}

// ── the scan ─────────────────────────────────────────────────────────────────

interface SuggestionStateRow { id: string; key: string; state: string }

/** Why a scan could not run, in fixed words (never a token: `ghJson` throws `github <status> <path>`). */
export function scanErrorText(e: unknown, token: string): string {
  const m = /^github (\d{3})\b/.exec(scrubbedMessage(e, token));
  if (m?.[1] === "404" || m?.[1] === "409") return "GitHub has no files for this repository's default branch yet";
  if (m?.[1] === "401" || m?.[1] === "403") return `GitHub refused to list the repository's files (HTTP ${m[1]})`;
  if (m) return `GitHub could not list the repository's files (HTTP ${m[1]})`;
  if (/graphql/.test(scrubbedMessage(e, token))) return "GitHub could not read the repository's files";
  return "the repository's files could not be read";
}

/** Record a failed scan (keeping the last good tree sha, so the next reconcile tries again only on a change). */
export async function recordScanError(ctx: TenantContext, repo: string, error: string, now: number): Promise<void> {
  await batch(ctx, [stmt(ctx, `INSERT INTO repo_scans (org_id, repo, tree_sha, scanned_at, looked, error) VALUES (?, ?, NULL, ?, ?, ?)
    ON CONFLICT(org_id, repo) DO UPDATE SET scanned_at = excluded.scanned_at, error = excluded.error`,
    ctx.orgId, repo, new Date(now).toISOString(), JSON.stringify(lookedFor()), error.slice(0, 200))]);
}

/**
 * Scan `gh.repo` (see the header). Throws when GitHub refuses the tree or the file batch — after recording why in
 * `repo_scans.error` — so `reconcileRepo`'s arm lands in `failed` as `scan`.
 */
export async function scanRepo(ctx: TenantContext, gh: GhOpts, opts: ScanOpts = {}): Promise<ScanOutcome> {
  const now = opts.now ?? Date.now();
  const providers = opts.providers ?? PROVIDERS;
  const repo = gh.repo;
  let requests = 0;
  const stored = await first<{ tree_sha: string | null }>(ctx, `SELECT tree_sha FROM repo_scans WHERE org_id = ? AND lower(repo) = lower(?)`, ctx.orgId, repo);

  let tree: GhTree;
  let files: Map<string, string>;
  let paths: string[];
  try {
    requests++;
    tree = await ghJson<GhTree>(gh, `/git/trees/HEAD?recursive=1`);
    if (typeof tree?.sha !== "string" || !Array.isArray(tree.tree)) throw new Error("github 502 tree: no sha");
    // THE GUARD: the same root tree as last time → nothing in the repository changed; no further request.
    if (!opts.force && stored?.tree_sha === tree.sha) return { skipped: true, treeSha: tree.sha, pending: null, added: 0, requests };
    paths = tree.tree.filter((e) => e?.type === "blob" && typeof e.path === "string").map((e) => e.path!).filter(scannable);
    const pick = pickFiles(paths);
    files = new Map();
    if (pick.length) { requests++; files = await readFiles(gh, pick); }
  } catch (e) {
    await recordScanError(ctx, repo, scanErrorText(e, gh.token), now).catch(() => undefined);
    throw e;
  }

  let candidates = detectAll({ repo, tree: paths, files });

  // Connected hosts: which folder each of their projects builds. Bounded: one list call per host; a failure is no evidence.
  const described: { provider: HostingProviderId; label: string; project: DescribedProject }[] = [];
  for (const src of (await opts.describe?.().catch(() => [])) ?? []) {
    if (!src.provider.describe) continue;
    requests += DESCRIBE_COST;
    try {
      for (const project of await src.provider.describe(src.pc, repo)) described.push({ provider: src.provider.id, label: src.provider.label, project });
    } catch (e) {
      console.error("repo scan", "describe", src.provider.id, e instanceof Error ? e.message : "error", `org=${ctx.orgId}`); // HostingError: scrubbed at construction
    }
  }
  candidates = foldDescribed(candidates, described);

  const [apps, envs, signals, existing] = [
    await listRepoApps(ctx, repo),
    await orgEnvironments(ctx),
    await seenSignals(ctx, repo, undefined, now),
    await all<SuggestionStateRow>(ctx, `SELECT id, key, state FROM repo_app_suggestions WHERE org_id = ? AND lower(repo) = lower(?)`, ctx.orgId, repo),
  ];
  const allKeys = new Set((await listRepoApps(ctx)).map((a) => a.key));
  const built = await buildSuggestions({
    repo, candidates, signals, envs, providers,
    appFolders: new Set(apps.map((a) => a.folder)), appKeys: allKeys,
    keptKeys: new Map(existing.map((r) => [r.id, r.key])),
  });

  const at = new Date(now).toISOString();
  const byId = new Map(existing.map((r) => [r.id, r]));
  const stmts: Stmt[] = [];
  let added = 0;
  let pending = 0;
  const builtIds = new Set(built.map((b) => b.id));
  for (const b of built) {
    const prev = byId.get(b.id);
    if (prev?.state === "accepted") continue; // never re-suggested
    const state = prev?.state === "ignored" && !opts.resetIgnored ? "ignored" : "pending";
    if (state === "pending") pending++;
    if (!prev) added++;
    stmts.push(stmt(ctx, `INSERT INTO repo_app_suggestions (org_id, repo, id, key, folder, kind, provider, evidence, parts, used_by, state, decided_at, decided_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
        ON CONFLICT(org_id, id) DO UPDATE SET key = excluded.key, folder = excluded.folder, kind = excluded.kind, provider = excluded.provider,
          evidence = excluded.evidence, parts = excluded.parts, used_by = excluded.used_by, state = excluded.state,
          decided_at = CASE WHEN excluded.state = repo_app_suggestions.state THEN repo_app_suggestions.decided_at ELSE NULL END,
          decided_by = CASE WHEN excluded.state = repo_app_suggestions.state THEN repo_app_suggestions.decided_by ELSE NULL END`,
      ctx.orgId, repo, b.id, b.key, b.folder, b.kind, b.provider, JSON.stringify(b.evidence), JSON.stringify(b.parts), JSON.stringify(b.usedBy), state, at));
  }
  // What the scan no longer finds goes (an accepted one stays: it is the record of an app an admin added).
  for (const r of existing) {
    if (!builtIds.has(r.id) && r.state !== "accepted") stmts.push(stmt(ctx, `DELETE FROM repo_app_suggestions WHERE org_id = ? AND id = ?`, ctx.orgId, r.id));
  }
  const error = tree.truncated ? "the repository is too large to list in one read; Trov looked at the files GitHub listed" : null;
  stmts.push(stmt(ctx, `INSERT INTO repo_scans (org_id, repo, tree_sha, scanned_at, looked, error) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, repo) DO UPDATE SET tree_sha = excluded.tree_sha, scanned_at = excluded.scanned_at, looked = excluded.looked, error = excluded.error`,
    ctx.orgId, repo, tree.sha, at, JSON.stringify(lookedFor()), error));
  await batch(ctx, stmts);
  return { skipped: false, treeSha: tree.sha!, pending, added, requests };
}
