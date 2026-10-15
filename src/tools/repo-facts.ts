// The Repo Overview's facts (repo setups, Phase B) — `RepoFacts` (shared/repo-facts-core.ts), assembled from D1 for
// one repository and narrowed to one app by `narrowFacts`. Part of the Repo dashboard's ONE projection: called by
// `getRepoDashboard` (src/tools/repo.ts) with the reads it already made (the parts, the hosting reads, the branch
// heads and their checks, the health rows, the PR and commit gates), so `GET /repo/dashboard` and MCP
// `get_repo_dashboard` return the same facts — and the same layout (`layoutOf(layoutInputOf(facts))`, both sides).
//
// D1 only, like the rest of the projection: what it adds is the apps (src/repo/apps-read.ts), the deploy read
// (`factsDeploys`: serving / latest / history and previews), the week's deploy and run counts, and the three
// snapshots the reconcile's facts arms store (src/repo/facts-compute.ts: `not_shipped`, `out_of_step`,
// `drift_chain`). Nothing here fetches; nothing here reads a secret (it is reachable from src/mcp.ts).
//
// Never guess: unknown is `null` (a count), `[]` with nothing implied, or absent — never a borrowed 0:
//   - a part's serving / latest is null when no production deploy says so; a sha null when no provider value
//     and no single join candidate (Phase A);
//   - health is null unless ONE pinged target is the part's (below); older than 30 minutes it is `stale`;
//   - not shipped is `count: null` until the snapshot was computed FOR the commit the part serves now;
//   - out of step lists an environment only while its apps still serve the commits it was computed for;
//   - the PR / commit / CI facts (open PRs, CI, drift, not shipped, those week figures) are the PRIMARY
//     repository's capture — reconcile and the webhook capture one repository per org — so for another
//     connected repository they read unknown until capture is per repository.
import type { DeployState, HostingProviderId } from "@shared/hosting";
import {
  REPO_WIDE, narrowFacts,
  type AttentionKind, type FactsApp, type FactsAttention, type FactsCi, type FactsConnect, type FactsDeploy, type FactsDriftStep,
  type FactsEnv, type FactsHealth, type FactsNotShipped, type FactsOutOfStep, type FactsPart, type FactsPreview, type FactsWeekFigure,
  type RepoFacts, type WeekKey,
} from "@shared/repo-facts-core";
import { isDeployState } from "@shared/hosting";
import type { RepoApp } from "@shared/repo-apps-core";
import { hasRole } from "../data/context";
import { all, type TenantContext } from "../data/sql";
import type { PartRow } from "../hosting/parts";
import type { HostingProvider } from "../hosting/types";
import {
  deployWeekCounts, factsDeploys, notShippedKey,
  type DriftChainSnapshot, type FactsDeployRow, type NotShippedSnapshot, type OutOfStepSnapshot,
} from "../repo/facts-store";
import { runCounts } from "../repo/reads";
import { readRepoSettings } from "../data/repo-settings";
import { readRelease, releaseWeekFigure } from "../repo/releases";
import { readFound, readUnseen } from "../repo/scan-reads";
import { getSnapshot, type HostingPollStateRow } from "../repo/store";
import type { RepoPrRow } from "../repo/types";

const DAY = 86_400_000;
/** A health reading older than this is shown as stale — never as up or down (the cron pings every 10 minutes). */
export const FACTS_HEALTH_STALE_MS = 30 * 60_000;
/** A part's history: the last N settled production deploys. */
export const FACTS_HISTORY = 20;
/** Previews read back this far (and an app "has previews" when one landed in it). */
export const FACTS_PREVIEW_DAYS = 30;
/** At most this many previews per app, newest first. */
export const FACTS_PREVIEWS_PER_APP = 20;
/** Waiting: more than this many commits not shipped … */
export const WAITING_COUNT = 2;
/** … the oldest of them older than this. */
export const WAITING_AGE_MS = DAY;
/** A preview branch failing this many deploys in a row is an attention item. */
export const PREVIEW_FAIL_STREAK = 3;

export const WEEK_KEYS: readonly WeekKey[] = ["mergedPrs", "deploys", "failedDeploys", "openPrs", "commits", "releases", "ciRuns"];
/** Attention items, most urgent first. */
export const ATTENTION_ORDER: readonly AttentionKind[] = ["down", "failed", "rolledBack", "outOfStep", "stale", "degraded", "waiting", "previewFailing"];

const FAIL_STATES = ["failure", "error", "timed_out"];
const SHA = /^[0-9a-f]{7,64}$/i;
const sameSha = (a: string | null, b: string | null): boolean => {
  if (!a || !b) return false;
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
};

/** What a facts read with nothing known reads: every list empty, every figure null. `decide()` draws it as R2. */
export function emptyRepoFacts(repo: string): RepoFacts {
  return {
    repo, app: null, repos: [], allApps: [], apps: [], envs: [], parts: [], previews: [], notShipped: [], outOfStep: [],
    drift: [], ci: [], release: null, found: null, unseen: null,
    week: WEEK_KEYS.map((key) => ({ key, value: null, delta: null })), attention: [], connect: null, groupDefault: null,
  };
}

/** The org's environment as the facts need it (the projection's `RepoDashboardEnv` fits). */
export interface FactsEnvConfig { key: string; label: string; branch: string; frontendUrl: string; apiUrl: string; healthPath: string }

/** What `getRepoDashboard` already read, handed over so nothing is read twice. */
export interface FactsInputs {
  repo: string;
  /** The App menu's value: an app key, `REPO_WIDE`, or null. */
  app: string | null;
  now: number;
  /** The org's environments, in promotion order. */
  envs: FactsEnvConfig[];
  /** The org's parts (`listAllParts`) — [] when there is no environment or the hosting read failed. */
  parts: PartRow[];
  /** This repository's apps (`listRepoApps(ctx, repo, parts)`). */
  apps: RepoApp[];
  providers: Readonly<Partial<Record<HostingProviderId, HostingProvider>>>;
  /** Each part's last poll (current provider), by `<env>/<key>`. */
  pollState: (p: PartRow) => HostingPollStateRow | undefined;
  /** The one status function's answer for a part's provider (src/tools/repo.ts `partConnectionOf`). */
  connectionOf: (p: PartRow) => FactsPart["connection"];
  /** The part's console link, https only, or null. */
  consoleUrlOf: (p: PartRow) => string | null;
  heads: Map<string, string>;
  checks: Map<string, { name: string; state: string }[]>;
  healthRows: Map<string, { at: string; value: number }>;
  pr: {
    /** The `prs_reconciled` marker: open-PR counts are complete. */
    captured: boolean;
    /** The latest `pr` row of every PR, as of now (any state). */
    states: RepoPrRow[];
    openNow: number;
    openThen: number;
    deltaOk: boolean;
  };
  merged: { any: boolean; thisWeek: number; lastWeek: number };
  commits: { captured: boolean; thisWeek: number; lastWeek: number; deltaOk: boolean };
  runs: { captured: boolean; recordingSince: string | null };
}

const isOpenPr = (r: RepoPrRow): boolean => r.state === "draft" || r.state === "review";
const isSettled = (s: string): boolean => s === "ready" || s === "error" || s === "canceled";

function toDeploy(r: FactsDeployRow): FactsDeploy | null {
  if (!isDeployState(r.state)) return null; // a state the code no longer knows is left out, never guessed at
  return {
    id: r.id, state: r.state, target: r.target === "production" || r.target === "preview" ? r.target : null,
    sha: r.sha, shaSource: r.sha_source === "provider" || r.sha_source === "joined" ? r.sha_source : null,
    branch: r.branch, message: r.message, by: r.by_login, createdAt: r.at, readyAt: r.ready_at, url: r.url,
    logUrl: r.inspect_url, reason: r.reason, rolledBackFrom: r.rolled_back_from, source: r.source === "github" ? "github" : "provider",
  };
}

/** The workflow file, deployment environment or check a `github` part names — what "via …" shows. */
function viaOf(p: PartRow): string | null {
  if (p.provider !== "github") return null;
  const wf = p.settings.workflow;
  if (wf) return wf.split("/").pop() ?? wf;
  return p.settings.environment || p.settings.check_name || null;
}

/**
 * Which health target is this part's: the projection pings two per environment — `frontend` (its frontend URL)
 * and `backend` (its API URL + health path), stored under those names (src/repo/poll.ts `pingHealth`). A part
 * keyed `frontend` / `backend` is that target; otherwise the ONE part of the environment with the target's role
 * (`web` → frontend, `service` → backend) when no other part carries the target's name. Two web parts — which is
 * the site? — is not a guess the read makes: no target, no health.
 */
function healthTargetOf(p: PartRow, envParts: PartRow[], cfg: FactsEnvConfig): { key: string; url: string; base: string } | null {
  const of = (key: "frontend" | "backend") =>
    key === "frontend" ? (cfg.frontendUrl ? { key, url: cfg.frontendUrl, base: cfg.frontendUrl } : null)
      : (cfg.apiUrl ? { key, url: cfg.apiUrl + cfg.healthPath, base: cfg.apiUrl } : null);
  if (p.key === "frontend" || p.key === "backend") return of(p.key);
  const key = p.role === "web" ? "frontend" : "backend";
  if (envParts.some((o) => o.key === key)) return null;
  if (envParts.filter((o) => o.role === p.role).length !== 1) return null;
  return of(key);
}

/** One environment's head checks as the Overview reads them. `total` / `failing` stay null while any check runs. */
function ciOf(env: FactsEnvConfig, heads: Map<string, string>, checks: Map<string, { name: string; state: string }[]>): FactsCi {
  const sha = heads.get(env.branch) ?? null;
  const on = sha ? checks.get(sha) ?? [] : [];
  if (!on.length) return { env: env.key, sha, state: null, total: null, failing: null, names: [] };
  const failing = on.filter((c) => FAIL_STATES.includes(c.state));
  const running = on.filter((c) => c.state === "pending");
  const state: FactsCi["state"] = failing.length ? "fail" : running.length ? "running" : "pass";
  return {
    env: env.key, sha, state,
    total: running.length ? null : on.length,
    failing: running.length ? null : failing.length,
    names: (failing.length ? failing : running).slice(0, 3).map((c) => c.name),
  };
}

/** The facts of one repository — UNNARROWED, then narrowed by `narrowFacts(facts, app)`. */
export async function readRepoFacts(ctx: TenantContext, i: FactsInputs): Promise<RepoFacts> {
  const weekAgo = new Date(i.now - 7 * DAY).toISOString();
  const twoWeeksAgo = new Date(i.now - 14 * DAY).toISOString();
  const previewSince = new Date(i.now - FACTS_PREVIEW_DAYS * DAY).toISOString();

  const repos = await all<{ repo_full_name: string; is_primary: number }>(ctx,
    `SELECT repo_full_name, is_primary FROM org_repos WHERE org_id = ? ORDER BY is_primary DESC, created_at, id`, ctx.orgId);
  const primary = repos[0]?.repo_full_name ?? "";
  const isPrimary = i.repo.toLowerCase() === primary.toLowerCase();

  const envIndex = new Map(i.envs.map((e, n) => [e.key, n]));
  const appIndex = new Map(i.apps.map((a, n) => [a.key, n]));
  const mine = i.parts
    .filter((p) => appIndex.has(p.key) && envIndex.has(p.env) && i.apps[appIndex.get(p.key)!].kind !== "Package")
    .sort((a, b) => appIndex.get(a.key)! - appIndex.get(b.key)! || envIndex.get(a.env)! - envIndex.get(b.env)!);

  // The release block reads the repository's releases (`releases`, per repository — so any connected one), narrowed by
  // the app's own release signal when the App menu names an app of this repository.
  const releaseApp = i.app && i.app !== REPO_WIDE && appIndex.has(i.app) ? i.app : null;
  const [rows, weekRows, nsSnap, oosSnap, chainSnap, runs, settings, release, releasesWeek, found, unseen] = await Promise.all([
    mine.length ? factsDeploys(ctx, previewSince) : Promise.resolve([] as FactsDeployRow[]),
    mine.length ? deployWeekCounts(ctx, weekAgo, twoWeeksAgo) : Promise.resolve([]),
    getSnapshot<NotShippedSnapshot>(ctx, "not_shipped"),
    getSnapshot<OutOfStepSnapshot>(ctx, "out_of_step"),
    getSnapshot<DriftChainSnapshot>(ctx, "drift_chain"),
    isPrimary && i.runs.captured ? runCounts(ctx, weekAgo, twoWeeksAgo) : Promise.resolve(null),
    i.repo ? readRepoSettings(ctx, i.repo) : Promise.resolve(null),
    i.repo ? readRelease(ctx, i.repo, releaseApp) : Promise.resolve(null),
    i.repo ? releaseWeekFigure(ctx, i.repo, i.now) : Promise.resolve(null),
    // What the repo scan suggested (pending only) and what it looked for (Phase D, src/repo/scan-reads.ts — the
    // secret-free read side). The layout draws them only while no app is accepted (`decide`: R1 / R2).
    i.repo ? readFound(ctx, i.repo, i.now) : Promise.resolve(null),
    i.repo ? readUnseen(ctx, i.repo, i.now) : Promise.resolve(null),
  ]);
  const of = (p: PartRow) => (r: { env: string; part: string; provider: string }) => r.env === p.env && r.part === p.key && r.provider === p.provider;

  // ── parts ──────────────────────────────────────────────────────────────────
  const parts: FactsPart[] = mine.map((p) => {
    const provider = i.providers[p.provider];
    const own = rows.filter(of(p));
    const prod = own.filter((r) => r.src === "prod");
    const servingRow = own.find((r) => r.src === "serving") ?? null;
    const serving = servingRow ? toDeploy(servingRow) : null;
    const newest = prod[0] ?? null;
    const latest = newest && newest.id !== servingRow?.id ? toDeploy(newest) : null;
    const history = prod.filter((r) => isSettled(r.state)).slice(0, FACTS_HISTORY).reverse()
      .map(toDeploy).filter((d): d is FactsDeploy => d !== null);

    const cfg = i.envs[envIndex.get(p.env)!];
    const target = healthTargetOf(p, i.parts.filter((o) => o.env === p.env), cfg);
    const up = target ? i.healthRows.get(`health_up:${p.env}:${target.key}`) : undefined;
    const ms = target ? i.healthRows.get(`health_ms:${p.env}:${target.key}`) : undefined;
    const health: FactsHealth | null = target && up
      ? { url: target.url, up: up.value === 1, ms: ms ? Math.round(ms.value) : null, at: up.at, stale: i.now - Date.parse(up.at) > FACTS_HEALTH_STALE_MS }
      : null;

    const connection = i.connectionOf(p);
    const live = connection === "connected" || connection === "error";
    return {
      app: p.key, env: p.env, label: p.label, role: p.role, provider: p.provider, host: provider?.label ?? p.provider,
      via: viaOf(p), connection, reportsDeploys: provider?.capabilities.deploys ?? false,
      viaGithub: p.provider === "github" || (serving?.source === "github" && !live),
      serving, latest, history, health,
      url: target?.base ?? serving?.url ?? null,
      consoleUrl: i.consoleUrlOf(p),
      // Any usage metric in the registry's capabilities (`github` reads none) — a capability,
      // never a provider id.
      reportsMetrics: (provider?.capabilities.metrics.length ?? 0) > 0,
    };
  });

  const visibleEnvs = i.envs.filter((e) => mine.some((p) => p.env === e.key));
  const envs: FactsEnv[] = visibleEnvs.map((e) => ({ key: e.key, name: e.label, branch: e.branch || null, position: envIndex.get(e.key)! }));

  // ── previews: a production part's preview deploys, newest per branch, matched to open PRs by branch ──
  const prByBranch = new Map<string, RepoPrRow>();
  const doneBranches = new Set<string>();
  for (const r of i.pr.states) {
    if (!r.ref) continue;
    if (isOpenPr(r)) prByBranch.set(r.ref, r);
    else if (r.state === "merged" || r.state === "closed") doneBranches.add(r.ref);
  }
  const previews: FactsPreview[] = [];
  const appHasPreviews = new Set<string>();
  for (const a of i.apps) {
    const pv = rows.filter((r) => r.src === "preview" && mine.some((p) => p.key === a.key && of(p)(r)));
    if (pv.length) appHasPreviews.add(a.key);
    const branches = [...new Set(pv.map((r) => r.branch!))];
    const list: FactsPreview[] = [];
    for (const branch of branches) {
      const open = prByBranch.get(branch) ?? null;
      // A branch whose PR was merged or closed (and none is open on it) is done — its previews are history.
      if (!open && doneBranches.has(branch)) continue;
      const seq = pv.filter((r) => r.branch === branch).filter((r) => isDeployState(r.state)); // newest first
      const head = seq[0];
      if (!head) continue;
      let streak = 0;
      while (streak < seq.length && seq[streak].state === "error") streak++;
      list.push({
        app: a.key, pr: open?.number ?? null, title: open?.title ?? null, branch, by: open?.actor_login ?? head.by_login,
        state: head.state as DeployState, at: head.at, url: head.url, failStreak: streak, failingSince: streak ? seq[streak - 1].at : null,
      });
    }
    previews.push(...list.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, FACTS_PREVIEWS_PER_APP));
  }

  // ── apps ───────────────────────────────────────────────────────────────────
  const openPrCount = isPrimary && i.pr.captured ? i.pr.openNow : null;
  const apps: FactsApp[] = i.apps.map((a) => ({
    key: a.key, label: a.label, folder: a.folder, kind: a.kind, watch: a.watch,
    source: a.source === "synthesised" ? "implicit" : a.source,
    usedBy: null, // the workspace graph is Phase D's
    previews: appHasPreviews.has(a.key),
    // Every open PR touches a repository's only app; with two or more, which one needs PR files (Phase E).
    openPrs: i.apps.length === 1 ? openPrCount : null,
  }));

  // ── not shipped, out of step, drift (the reconcile's snapshots, read back) ──
  const notShipped: FactsNotShipped[] = parts.map((p) => {
    const e = isPrimary ? nsSnap?.data?.parts?.[notShippedKey(p.env, p.app)] : undefined;
    return e && p.serving?.sha && sameSha(e.servingSha, p.serving.sha)
      ? { app: p.app, env: p.env, count: e.count, oldestAt: e.oldestAt, groups: e.groups }
      : { app: p.app, env: p.env, count: null, oldestAt: null, groups: [] };
  });

  const outOfStep: FactsOutOfStep[] = [];
  if (isPrimary) {
    for (const env of visibleEnvs) {
      const e = oosSnap?.data?.envs?.[env.key];
      if (!e) continue;
      const here = parts.filter((p) => p.env === env.key && p.serving?.sha && SHA.test(p.serving.sha));
      const still = Object.keys(e.shas).length === here.length
        && here.every((p) => e.shas[p.app] !== undefined && sameSha(e.shas[p.app], p.serving!.sha));
      if (still) outOfStep.push(...e.rows.filter((r) => appIndex.has(r.app)));
    }
  }

  const drift: FactsDriftStep[] = isPrimary
    ? (chainSnap?.data?.steps ?? []).filter((s) => {
        const a = envIndex.get(s.fromEnv), b = envIndex.get(s.toEnv);
        // a step of the CURRENT chain (adjacent, the same branches), between two environments this screen shows
        return a !== undefined && b !== undefined && b === a + 1 && i.envs[a].branch === s.from && i.envs[b].branch === s.to
          && visibleEnvs.some((v) => v.key === s.fromEnv) && visibleEnvs.some((v) => v.key === s.toEnv);
      })
    : [];

  // ── CI per environment: the environments this screen shows, else (a packages-only repository) every one ──
  const ci: FactsCi[] = isPrimary ? (visibleEnvs.length ? visibleEnvs : i.envs).map((e) => ciOf(e, i.heads, i.checks)) : [];

  // ── the week ───────────────────────────────────────────────────────────────
  const counted = weekRows.filter((r) => mine.some((p) => of(p)(r)));
  const deployCapture = mine.some((p) => rows.some(of(p)) || (i.providers[p.provider]?.capabilities.deploys === true && i.pollState(p)?.last_ok_at != null));
  const sum = (k: "this_ready" | "this_error" | "last_ready" | "last_error") => counted.reduce((n, r) => n + (r[k] ?? 0), 0);
  // A delta is real only when deploy capture of every counted part began before last week (`recorded_at`).
  const deployDeltaOk = counted.length > 0 && counted.every((r) => r.since !== null && r.since <= twoWeeksAgo);
  const fig = (key: WeekKey, value: number | null, delta: number | null): FactsWeekFigure => ({ key, value, delta: value === null ? null : delta });
  const runDeltaOk = i.runs.recordingSince !== null && i.runs.recordingSince <= twoWeeksAgo;
  const week: FactsWeekFigure[] = [
    fig("mergedPrs", isPrimary && i.merged.any ? i.merged.thisWeek : null, i.merged.thisWeek - i.merged.lastWeek),
    fig("deploys", deployCapture ? sum("this_ready") + sum("this_error") : null,
      deployDeltaOk ? sum("this_ready") + sum("this_error") - sum("last_ready") - sum("last_error") : null),
    fig("failedDeploys", deployCapture ? sum("this_error") : null, deployDeltaOk ? sum("this_error") - sum("last_error") : null),
    fig("openPrs", openPrCount, i.pr.deltaOk ? i.pr.openNow - i.pr.openThen : null),
    fig("commits", isPrimary && i.commits.captured ? i.commits.thisWeek : null, i.commits.deltaOk ? i.commits.thisWeek - i.commits.lastWeek : null),
    // Phase F: null until reconcile has read this repository's releases (`releases_reconciled`), then the week's count.
    releasesWeek ?? fig("releases", null, null),
    fig("ciRuns", runs ? runs.thisWeek : null, runs && runDeltaOk ? runs.thisWeek - runs.lastWeek : null),
  ];

  // ── attention: structured here, worded in the SPA ──────────────────────────
  const attention: FactsAttention[] = [];
  for (const p of parts) {
    const inFlight = p.latest && (p.latest.state === "queued" || p.latest.state === "building") ? p.latest : null;
    if (p.health && !p.health.stale && !p.health.up) attention.push({ kind: "down", app: p.app, env: p.env, refs: { url: p.health.url, since: p.health.at } });
    if (p.latest?.state === "error") {
      attention.push({ kind: "failed", app: p.app, env: p.env, refs: {
        ...(p.latest.sha ? { failedSha: p.latest.sha } : {}), ...(p.serving?.sha ? { sha: p.serving.sha } : {}),
        since: p.latest.createdAt, provider: p.provider, ...(p.latest.reason ? { reason: p.latest.reason } : {}),
      } });
    }
    if (p.serving?.rolledBackFrom) {
      attention.push({ kind: "rolledBack", app: p.app, env: p.env, refs: {
        ...(p.serving.sha ? { sha: p.serving.sha } : {}), prevSha: p.serving.rolledBackFrom,
        ...(inFlight?.sha ? { nextSha: inFlight.sha } : {}), since: p.serving.readyAt ?? p.serving.createdAt,
      } });
    }
    if (p.health?.stale) {
      attention.push({ kind: "stale", app: p.app, env: p.env, refs: { since: p.health.at, provider: p.provider, ...(inFlight?.sha ? { nextSha: inFlight.sha } : {}) } });
    }
  }
  for (const o of outOfStep) {
    attention.push({ kind: "outOfStep", app: o.app, env: o.env, refs: { sha: o.sha, behindBy: o.behindBy, of: o.of, provider: parts.find((p) => p.app === o.app && p.env === o.env)?.provider } });
  }
  for (const c of ci) {
    if (c.state === "fail") attention.push({ kind: "degraded", app: null, env: c.env, refs: { ...(c.failing !== null ? { count: c.failing } : {}), ...(c.names[0] ? { check: c.names[0] } : {}) } });
  }
  for (const n of notShipped) {
    if (n.count !== null && n.count > WAITING_COUNT && n.oldestAt && i.now - Date.parse(n.oldestAt) > WAITING_AGE_MS) {
      const sha = parts.find((p) => p.app === n.app && p.env === n.env)?.serving?.sha;
      attention.push({ kind: "waiting", app: n.app, env: n.env, refs: { count: n.count, since: n.oldestAt, ...(sha ? { sha } : {}) } });
    }
  }
  for (const pv of previews) {
    if (pv.failStreak >= PREVIEW_FAIL_STREAK) {
      attention.push({ kind: "previewFailing", app: pv.app, env: null, refs: { ...(pv.pr !== null ? { pr: pv.pr } : {}), count: pv.failStreak, ...(pv.failingSince ? { since: pv.failingSince } : {}) } });
    }
  }
  attention.sort((a, b) => ATTENTION_ORDER.indexOf(a.kind) - ATTENTION_ORDER.indexOf(b.kind)
    || (appIndex.get(a.app ?? "") ?? -1) - (appIndex.get(b.app ?? "") ?? -1)
    || (envIndex.get(a.env ?? "") ?? -1) - (envIndex.get(b.env ?? "") ?? -1));

  // ── the connect hint (admins): a part's host is not connected ───────────────
  let connect: FactsConnect | null = null;
  if (hasRole(ctx, "admin")) {
    const missing = parts.filter((p) => i.providers[p.provider]?.credential !== "github_app" && (p.connection === "not_connected" || p.connection === "revoked"));
    const provider = missing[0]?.provider;
    if (provider) {
      const its = missing.filter((p) => p.provider === provider);
      // `metrics`: GitHub already gives every such part its deploys — the host is wanted for CPU and memory only.
      const viaGithub = its.every((p) => rows.some((r) => of(mine.find((m) => m.key === p.app && m.env === p.env)!)(r) && r.source === "github"));
      connect = { provider, need: viaGithub ? "metrics" : "deploys", apps: [...new Set(its.map((p) => p.app))] };
    }
  }

  const facts: RepoFacts = {
    repo: i.repo, app: null, repos: repos.map((r) => r.repo_full_name), allApps: apps, apps, envs, parts, previews, notShipped,
    outOfStep, drift, ci, release, found, unseen, week, attention, connect,
    // the admin's default Group by for this repository (`repo_settings.overview_group`, 0071), else none
    groupDefault: settings?.overview_group ?? null,
  };
  return narrowFacts(facts, i.app);
}
