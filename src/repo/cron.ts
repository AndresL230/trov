// One cron trigger, several cadences, dispatched here by the minute/hour of the
// fire time (cron expressions are static UTC — the cadence lives in code, not
// in wrangler.toml). This replaced the old "0 */6 * * *" progress-only
// trigger, so the trigger count stays at three (Cloudflare bills per Worker).
//
// Background work is PER ORG (canopy-multitenancy.md §8.3): each cadence is a JOB, a job is a list of
// units — one per (org, environment) or one per org — and `handleRepoCron` serves them by rotation
// (./dispatch.ts). A unit reads its repo and environments from the org's rows (./config.ts) and its
// credentials through `resolveCredential`; nothing here reads `GITHUB_REPO` / `REPO_ENVIRONMENTS`.
import type { PollOutcome, RepoRefreshResult, UsagePollResult, UsagePollSource } from "@shared/repo";
import type { IntegrationKind } from "@shared/integrations";
import type { Env } from "../env";
import { pruneOAuth } from "../auth/oauth";
import { recomputeAllProgress } from "../tools/progress";
import { orgEnvironment, orgEnvironments, orgPrimaryRepo, type RepoEnvConfig } from "./config";
import { run } from "../data/sql";
import { platform, systemTenant, type TenantContext } from "../data/context";
import { type Revealed, type Secret, markSecretUsed, recordSecretOutcome, resolveCloudflareAccountId, resolveCredential, scrub } from "../data/secrets";
import { jobTenant, listEnvUnits, listRepoUnits } from "../platform/jobs";
import { importLogoForOrg } from "../integrations/logo";
import { LOGO_IMPORT_COST } from "../orgs/logo";
import { CRON_SUBREQUEST_BUDGET, newBudget, serveJob, type Unit } from "./dispatch";
import { reconcileRepo, type ReconcileResult } from "./github";
import { HEALTH_ON_DEMAND_BUCKET_MS, pingHealth, pollCloudflare, pollRailway, pollSaplingMetrics } from "./poll";
import { getSnapshot } from "./store";
import { expireDueHandoffs, pruneRepoCapture } from "../platform/sweeps";

export const REPO_CRON = "*/10 * * * *";

export type { RepoRefreshResult, UsagePollResult };

// ── credentials, and what may be logged ──────────────────────────────────────
// A job reads each credential through `resolveCredential` (src/data/secrets.ts): the org's stored
// secret, else — for SaplingLearn ONLY, until its admin enters them on the Integrations screen — the
// legacy Worker secret, else null. This module is not reachable from src/mcp.ts
// (test/secrets.mcp.test.ts), so it may resolve one; the revealed VALUE goes down to the pollers and
// to src/repo/github.ts as a parameter.

/** The legacy Worker secrets (§8.7.6), named ONLY so that no log line can carry one. Nothing here
 *  authenticates with them any more — `resolveCredential`'s fallback does, for SaplingLearn alone —
 *  but an error thrown before a unit resolved anything (a dead D1 binding) may still quote the
 *  environment. Deleted with the fallback in the cleanup phase. */
function legacyEnvSecrets(env: Env): string[] {
  const bag = env as unknown as Record<string, unknown>;
  return [
    env.GITHUB_SERVICE_TOKEN, env.CF_ANALYTICS_TOKEN, env.CF_ANALYTICS_ACCOUNT_ID, env.SAPLING_METRICS_TOKEN,
    ...Object.keys(bag).filter((k) => k.startsWith("RAILWAY_TOKEN_")).map((k) => bag[k]),
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** What this module LOGS for an arm that threw: the error's MESSAGE — never the
 *  Error object, so no stack — with every credential the unit revealed (and the
 *  legacy Worker secrets) scrubbed out of it. Literal replacement, and nothing
 *  downstream cuts the string, so no cut can leave half a token behind.
 *  "These arms never throw" was the argument for logging the raw error in
 *  src/repo/github.ts too, and it was wrong there: the progress arm fetches
 *  GitHub with the service token, and a thrown fetch can quote its own
 *  `authorization` header back. */
function scrubbedLog(e: unknown, env: Env, revealed: Revealed = []): string {
  return scrub(e instanceof Error ? e.message : String(e), [revealed, legacyEnvSecrets(env)]);
}

/** Resolve one credential for a unit and remember it in `revealed`, so every later log line and
 *  stored `last_error` of that unit is scrubbed of it. A secret that cannot be read (no key, a row
 *  that does not decrypt) is logged by KIND — the error's text is fixed and value-free — and reads
 *  as not configured: it must not cost the unit's other sources. */
async function credential(ctx: TenantContext, env: Env, kind: IntegrationKind, scope: string, revealed: Revealed[]): Promise<Secret | null> {
  try {
    const secret = await resolveCredential(ctx, env, kind, scope);
    if (secret) revealed.push(secret);
    return secret;
  } catch (e) {
    console.error("repo cron", "credential", kind, scrubbedLog(e, env, revealed), `org=${ctx.orgId}`);
    return null;
  }
}

/** Tell the org's integration row what a use of its credential came to (`last_used_at` /
 *  `last_error` — the Integrations screen). A `skipped` outcome used nothing; a no-op when the org
 *  has no row (SaplingLearn on the legacy fallback). Never throws — bookkeeping must not cost a job. */
async function recordOutcomes(ctx: TenantContext, kind: IntegrationKind, scope: string, outcomes: PollOutcome[], revealed: Revealed, now: number): Promise<void> {
  const failed = outcomes.find((o) => o.status === "failed");
  if (!failed && !outcomes.some((o) => o.status === "ok")) return;
  await recordSecretOutcome(ctx, kind, scope, failed ? { ok: false, message: failed.detail ?? "failed", revealed } : { ok: true }, now).catch(() => undefined);
}

/** What a source reports when its arm threw — the pollers never throw, so this
 *  should be unreachable; it names no cause on purpose (nothing unscrubbed may
 *  reach the response). */
const unexpected = (envKey: string): PollOutcome[] => [{ env: envKey, status: "failed", written: 0, detail: "unexpected error" }];

// ── the job functions: one per (org, environment), or one per org (§8.3) ─────

/**
 * The three HOURLY usage pollers for ONE environment of ONE org. A source whose
 * credential is absent is `"not_configured"` and is not called (its sections
 * stay `not_connected`); each of the others runs in its OWN guarded arm — a
 * throw (the pollers never throw, so: unreachable) is logged scrubbed and
 * reported as `unexpected`, never skipping the next.
 *
 *   cloudflare  `cloudflare_analytics` (scope "") + the account id from the org's integration
 *               config — BOTH, or not called.
 *   railway     `railway`, scope = the environment key: a project token reaches ONE environment.
 *   sapling     `metrics_endpoint`, scope = the environment key — ONE token per environment (the
 *               legacy `SAPLING_METRICS_TOKEN` answers for each of SaplingLearn's).
 *
 * `now` may be ANY instant: every poller keys its window on the HOUR FLOOR of
 * `now`, and every write is `INSERT OR IGNORE` (`putMetric`, first-write-wins),
 * so an on-demand run at :37 asks for the same hours and writes the same rows
 * the :00 tick of that hour did — idempotent with the cron, in either order.
 *
 * Subrequests: at most 3. The `cf_polled` snapshot stays ONE row per org
 * (`{ [env]: interval }`): units run one after another, so its read-modify-write
 * cannot lose another environment's entry. (Concurrent units — Queues — need it
 * split per environment first, §8.3.)
 */
async function usageForEnv(env: Env, ctx: TenantContext, cfg: RepoEnvConfig, now: number, fetchImpl?: typeof fetch): Promise<UsagePollResult> {
  const revealed: Revealed[] = [];
  const arm = async (label: string, kind: IntegrationKind, scope: string, fn: () => Promise<PollOutcome[]>): Promise<UsagePollSource> => {
    let outcomes: PollOutcome[];
    try {
      outcomes = await fn();
    } catch (e) {
      console.error("repo cron", label, scrubbedLog(e, env, revealed), `org=${ctx.orgId}`);
      outcomes = unexpected(cfg.key);
    }
    await recordOutcomes(ctx, kind, scope, outcomes, revealed, now);
    return outcomes;
  };
  // Cloudflare: BOTH values, or not called. The account id is not a secret, but Cloudflare's own
  // errors can name the account they refused — so it is scrubbed like one.
  const cfToken = await credential(ctx, env, "cloudflare_analytics", "", revealed);
  const accountId = cfToken ? await resolveCloudflareAccountId(ctx, env).catch(() => null) : null;
  if (accountId) revealed.push(accountId);
  const cloudflare = cfToken && accountId
    ? await arm("cloudflare", "cloudflare_analytics", "", () => pollCloudflare(ctx, { token: cfToken.reveal(), accountId }, [cfg], now, fetchImpl))
    : "not_configured";
  // Railway: this environment's own project token, or not called.
  const rwToken = await credential(ctx, env, "railway", cfg.key, revealed);
  const railway = rwToken
    ? await arm("railway", "railway", cfg.key, () => pollRailway(ctx, { [cfg.key]: rwToken.reveal() }, [cfg], now, fetchImpl))
    : "not_configured";
  // The app's own metrics endpoint — active users AND product metrics (one response carries both).
  // Absent → not called, and Active users / the Product blocks stay "not connected".
  const appToken = await credential(ctx, env, "metrics_endpoint", cfg.key, revealed);
  const sapling = appToken
    ? await arm("sapling", "metrics_endpoint", cfg.key, () => pollSaplingMetrics(ctx, appToken.reveal(), [cfg], now, fetchImpl))
    : "not_configured";
  return { cloudflare, railway, sapling };
}

export type EnvJob = "health" | "usage";
export type OrgJob = "progress" | "reconcile";

/**
 * ONE (org, environment) job — the unit the cron dispatches by rotation, and what a queue consumer
 * would call unchanged. `health` = the environment's two pings (no credential); `usage` = its three
 * hourly pollers (`usageForEnv`). An environment deleted since the dispatcher listed it is a no-op.
 * TOTAL: a failure is logged here, scrubbed, with the org id — it never reaches the dispatcher.
 */
export async function runEnvJob(env: Env, orgId: string, envKey: string, job: EnvJob, now: number, fetchImpl?: typeof fetch): Promise<void> {
  try {
    const ctx = systemTenant(platform(env, "system"), orgId, "system");
    const cfg = await orgEnvironment(ctx, envKey);
    if (!cfg) return;
    // A dead target costs one data point, never the cron — pingHealth itself never throws.
    if (job === "health") await pingHealth(ctx, [cfg], now, fetchImpl);
    else await usageForEnv(env, ctx, cfg, now, fetchImpl);
  } catch (e) {
    console.error("repo cron", job, scrubbedLog(e, env), `org=${orgId}`);
  }
}

/** The free plan's cap on outbound `fetch` per invocation (D1 does not count) — what ONE org's
 *  on-demand refresh is still held to (`runRepoRefresh`). The cron's own budget: ./dispatch.ts. */
export const SUBREQUEST_CAP = 50;
/** `runRepoRefresh`'s worst case for N environments: health 2N + usage 3N +
 *  reconcile (19 + 2N) = 19 + 7N. 33 for two; 47 at N = 4; 54 at N = 5. */
export const refreshSubrequests = (n: number): number => 19 + 7 * n;
/** The one fixed phrase `github.failed` carries when the arm was not run. */
export const BUDGET_SKIP = "skipped: would exceed the subrequest budget";

export interface ReconcileJobOpts {
  fetchImpl?: typeof fetch;
  /** A test seam: every arm of the real one is guarded, so the "unexpected error" path cannot be reached through it. */
  reconcile?: typeof reconcileRepo;
  /** The log prefix — which caller's run this was. */
  label?: string;
  /** "Poll now" only: skip (and say so, `BUDGET_SKIP`) when the whole refresh would not fit `SUBREQUEST_CAP`. */
  budgetSkip?: boolean;
}

/**
 * The org's GitHub reconcile (`reconcileRepo`): its PRIMARY repo, read with its `github_token`.
 * The cron's `:20` unit, "Poll now"'s GitHub arm and Sync GitHub's closing reconcile all call THIS.
 * `null` = not configured (no primary repo, or no token): nothing was fetched and nothing is logged.
 * Never throws for a system or session caller: an unexpected throw is logged scrubbed and reported
 * as `failed: ["unexpected error"]` (reconcile's own arms never throw out of it — they land in
 * `failed` by NAME). 19 + 2N subrequests worst case for N environments.
 */
export async function runReconcileJob(env: Env, caller: TenantContext, now: number = Date.now(), opts: ReconcileJobOpts = {}): Promise<ReconcileResult | null> {
  const ctx = jobTenant(env, caller);
  const label = opts.label ?? "repo cron";
  const revealed: Revealed[] = [];
  try {
    const repo = await orgPrimaryRepo(ctx);
    const token = repo ? await credential(ctx, env, "github_token", "", revealed) : null;
    if (!repo || !token) return null;
    const envs = await orgEnvironments(ctx);
    if (opts.budgetSkip && refreshSubrequests(envs.length) > SUBREQUEST_CAP) return { written: 0, unchanged: 0, failed: [BUDGET_SKIP] };
    const res = await (opts.reconcile ?? reconcileRepo)(ctx, { token: token.reveal(), repo: repo.repo, fetchImpl: opts.fetchImpl }, envs, now);
    if (res.failed.length) console.error(`${label} reconcile: arms failed`, res.failed, `org=${ctx.orgId}`);
    // `failed` is arm NAMES — nothing an upstream wrote — so it is safe to keep as the last error.
    await recordSecretOutcome(ctx, "github_token", "",
      res.failed.length ? { ok: false, message: `reconcile: arms failed: ${res.failed.join(", ")}`, revealed } : { ok: true }, now).catch(() => undefined);
    return res;
  } catch (e) {
    console.error(label, "reconcile", scrubbedLog(e, env, revealed), `org=${ctx.orgId}`);
    return { written: 0, unchanged: 0, failed: ["unexpected error"] };
  }
}

/**
 * ONE org-level job. `progress` = the sprint-progress backstop (`recomputeAllProgress`); `reconcile`
 * = `runReconcileJob`. Both read the org's primary repo with its `github_token`; an org missing
 * either is skipped without a word. TOTAL, like `runEnvJob`.
 */
export async function runOrgJob(env: Env, orgId: string, job: OrgJob, now: number, fetchImpl?: typeof fetch): Promise<void> {
  const ctx = systemTenant(platform(env, "system"), orgId, "system");
  if (job === "reconcile") {
    // reconcileRepo already covers drift and branches as arms (and writes
    // env_heads) — calling refreshDrift/refreshBranches here too would double
    // the requests, not add coverage.
    await runReconcileJob(env, ctx, now, { fetchImpl });
    // The org's image follows its primary repository's owner (src/orgs/logo.ts): imported here so it
    // arrives for an org connected before the image existed, and refreshes when the owner changes
    // their avatar. Never over an uploaded one; TOTAL; at most `LOGO_IMPORT_COST` requests; and, like
    // the reconcile itself, nothing is asked for an org that has no GitHub token.
    await importLogoForOrg(env, platform(env, "system"), ctx, { fetchImpl, tokenOnly: true });
    return;
  }
  const revealed: Revealed[] = [];
  try {
    const repo = await orgPrimaryRepo(ctx);
    const token = repo ? await credential(ctx, env, "github_token", "", revealed) : null;
    if (!repo || !token) return;
    await recomputeAllProgress(ctx, { token: token.reveal(), repo: repo.repo, fetchImpl });
    await markSecretUsed(ctx, "github_token", "", now).catch(() => undefined);
  } catch (e) {
    console.error("repo cron", job, scrubbedLog(e, env, revealed), `org=${orgId}`);
  }
}

// ── on demand, for ONE org (the admin routes) ────────────────────────────────

/** What an environment WITHOUT its own credential reads as once another environment of the org has
 *  one — the source is then configured, and this environment was skipped. */
const NO_TOKEN: Record<keyof UsagePollResult, string> = { cloudflare: "no token", railway: "no project token", sapling: "no metrics token" };

/**
 * The org's three usage pollers, on demand — the admin-only `POST /admin/poll-usage`
 * ("Poll usage now") and "Poll now"'s usage arm. It runs the cron's OWN `usage`
 * job (`usageForEnv`) for each of the org's environments in turn — ONE function,
 * so an on-demand run is the cron's own run, with its outcomes handed back
 * instead of only logged: per source, one `PollOutcome` per environment, or
 * `"not_configured"` when NO environment has that credential.
 *
 * `caller` names the org — an admin's session context, or a system one; the job runs as that org's
 * system tenant (`jobTenant`, which refuses a bearer context). The ROUTE decides who may ask.
 *
 * Subrequests: Cloudflare N + Railway ≤N + the app's metrics N = 3N for N
 * environments (6 today), no health pings.
 *
 * The result carries outcomes and NEVER a token, a header or an account id: a
 * `detail` is a poller's scrubbed, truncated message, or a few fixed words.
 */
export async function runUsagePolls(env: Env, caller: TenantContext, now: number, fetchImpl?: typeof fetch): Promise<UsagePollResult> {
  const ctx = jobTenant(env, caller);
  const envs = await orgEnvironments(ctx);
  const per: UsagePollResult[] = [];
  for (const cfg of envs) per.push(await usageForEnv(env, ctx, cfg, now, fetchImpl));
  const merged = (source: keyof UsagePollResult): UsagePollSource => {
    if (per.every((r) => r[source] === "not_configured")) return "not_configured";
    return per.flatMap((r, i): PollOutcome[] => {
      const one = r[source];
      return one === "not_configured" ? [{ env: envs[i].key, status: "skipped", written: 0, detail: NO_TOKEN[source] }] : one;
    });
  };
  return { cloudflare: merged("cloudflare"), railway: merged("railway"), sapling: merged("sapling") };
}

/**
 * What the Repo dashboard POLLS for, refreshed on demand for ONE org — the
 * function behind the admin's "Poll now" (`POST /admin/poll`). Three sources, in
 * this order, each in its OWN guarded arm (a failure in one never skips another):
 *
 *   health   `pingHealth`, stamped to the SECOND (see `HEALTH_ON_DEMAND_BUCKET_MS`
 *            — floored to the cron's bucket, or even to its minute, a
 *            first-write-wins reading is dropped). `"not_configured"` with no
 *            environment.
 *   usage    `runUsagePolls` — Cloudflare, Railway, the app's metrics.
 *   github   `runReconcileJob`: deploys, checks, runs, branches, drift, open
 *            PRs, env heads, the `canopy/*` commit statuses and PR reviews.
 *            `"not_configured"` without a primary repo AND a `github_token`; an
 *            unexpected throw → `failed: ["unexpected error"]`.
 *
 * THE CRON DOES NOT CALL THIS. `handleRepoCron` below spreads one heavy job per
 * tick; this function fits one invocation only because it leaves the unbounded
 * one out. The on-demand budget, counted from the code: health 2N + usage 3N +
 * reconcile (19 + 2N) = **19 + 7N** subrequests — 33 for two environments, and
 * the free plan's 50 caps it at **N ≤ 4** (47; N = 5 is 54). Past that the
 * GITHUB arm is SKIPPED and says so (`BUDGET_SKIP`) rather than risk the whole
 * invocation dying half-way — health and usage (5N) still run. The formula is
 * the worst case on purpose: it does not discount an unconfigured poller.
 *
 * Deliberately NOT here:
 *   `recomputeAllProgress`  UNBOUNDED — one request per issue number of every
 *                           array-ref sprint; it is the reason the cron gives it
 *                           a tick of its own, and it feeds the Roadmap, not
 *                           this dashboard.
 *   `pruneRepoCapture`      maintenance, not a refresh — nothing on screen
 *                           changes because old rows were deleted.
 *   `runBackfill`/summaries that is "Sync GitHub": My Work's capture, with its
 *                           own Gemini budget loop. It is ALSO the only
 *                           non-webhook writer of the `events` issue snapshots,
 *                           so the Overview's Open issues / Open bugs tiles and
 *                           deltas, Planning's issues by label and the feed's
 *                           issue lines do NOT move on a poll — they refresh
 *                           with Sync GitHub. The button's title says so.
 *
 * The result carries outcomes and NEVER a token, a header or an account id:
 * health details are fixed words, usage details are the pollers' scrubbed
 * messages, and `github.failed` is arm names or one of two fixed phrases.
 */
export async function runRepoRefresh(env: Env, caller: TenantContext, now: number, fetchImpl?: typeof fetch, reconcile: typeof reconcileRepo = reconcileRepo): Promise<RepoRefreshResult> {
  const ctx = jobTenant(env, caller);
  const envs = await orgEnvironments(ctx);

  let health: UsagePollSource = "not_configured";
  if (envs.length) {
    try {
      health = await pingHealth(ctx, envs, now, fetchImpl, HEALTH_ON_DEMAND_BUCKET_MS);
    } catch (e) {
      console.error("repo refresh", "health", scrubbedLog(e, env), `org=${ctx.orgId}`);
      health = unexpected("*");
    }
  }

  let usage: UsagePollResult;
  try {
    usage = await runUsagePolls(env, ctx, now, fetchImpl);
  } catch (e) {
    // Unreachable today (the usage arms scrub their own logs; only the environment read can throw)
    // — the message is logged with every secret scrubbed all the same.
    console.error("repo refresh", "usage", scrubbedLog(e, env), `org=${ctx.orgId}`);
    usage = { cloudflare: unexpected("*"), railway: unexpected("*"), sapling: unexpected("*") };
  }

  const github = (await runReconcileJob(env, ctx, now, { fetchImpl, reconcile, label: "repo refresh", budgetSkip: true })) ?? "not_configured";

  return { health, ...usage, github };
}

// ── the refresh lock ─────────────────────────────────────────────────────────
/** A `repo_snapshots` row, NOT a dashboard section: `{ by, at }` while a refresh
 *  runs — one per ORG (the key is `(org_id, kind)`). Every write the refresh makes
 *  is idempotent, so two overlapping runs are CORRECT — the lock only stops a
 *  pile-up (two admins, a double click from two tabs) from spending the
 *  subrequest budget twice for nothing. */
export const REFRESH_LOCK = "refresh_lock";
/** How long a lock is honoured. It outlives the REALISTIC worst case — a
 *  refresh is seconds when GitHub answers, and even with every poller hanging
 *  to its timeout (≈ 64 s for two environments) plus a slow reconcile it stays
 *  well inside three minutes — but NOT the theoretical one: every fetch is
 *  bounded (8–15 s each), and 23 GitHub reads all timing out is ≈ 6 minutes.
 *  So a run CAN overrun its lock, and then a second run may start beside it.
 *  Correctness holds: every write is idempotent, and the overrun run's release
 *  is a no-op because the row's `json` is no longer its own. Only budget is
 *  wasted. A lock older than this is otherwise a run that died without its
 *  `finally`, and is ignored. */
export const REFRESH_LOCK_MS = 180_000;

export type LockedRefresh =
  | { ok: true; result: RepoRefreshResult }
  | { ok: false; since: string };

/**
 * `runRepoRefresh` behind the caller's ORG's lock. Taking it is ONE statement —
 * an upsert that only overwrites a row older than `REFRESH_LOCK_MS` — so two
 * callers racing cannot both win; `changes = 0` means a live lock stands, and
 * the caller gets its `since` without running anything. Released in a `finally`
 * (so a thrown arm cannot strand it), and only when the row is still OURS: a run
 * that outlived its own lock (see `REFRESH_LOCK_MS` — possible, merely wasteful)
 * must not delete the lock of the run that replaced it.
 */
export async function runLockedRepoRefresh(env: Env, caller: TenantContext, by: string, now: number, fetchImpl?: typeof fetch, refresh: typeof runRepoRefresh = runRepoRefresh): Promise<LockedRefresh> {
  const ctx = jobTenant(env, caller);
  const at = new Date(now).toISOString();
  const mine = JSON.stringify({ by, at });
  const staleBefore = new Date(now - REFRESH_LOCK_MS).toISOString();
  const took = await run(ctx,
    `INSERT INTO repo_snapshots (org_id, kind, json, computed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(org_id, kind) DO UPDATE SET json = excluded.json, computed_at = excluded.computed_at
     WHERE repo_snapshots.computed_at <= ?`,
    ctx.orgId, REFRESH_LOCK, mine, at, staleBefore);
  if (!took.meta.changes) {
    const held = await getSnapshot<{ at?: unknown }>(ctx, REFRESH_LOCK);
    return { ok: false, since: held?.computedAt ?? at };
  }
  try {
    return { ok: true, result: await refresh(env, ctx, now, fetchImpl) };
  } finally {
    await run(ctx, `DELETE FROM repo_snapshots WHERE org_id = ? AND kind = ? AND json = ?`, ctx.orgId, REFRESH_LOCK, mine).catch(() => undefined);
  }
}

// ── the dispatcher ───────────────────────────────────────────────────────────

/** Worst-case subrequests of one unit, per job — what the rotation budgets with (./dispatch.ts). */
export const HEALTH_COST = 2;                                   // the two pings (a redirect costs one more: the budget's headroom)
export const USAGE_COST = 3;                                    // Cloudflare + Railway + the app's metrics
/** `reconcileRepo`'s 19 + 2N, plus the org image's import that rides the same unit (`runOrgJob`). */
export const reconcileCost = (envs: number): number => 19 + 2 * envs + LOGO_IMPORT_COST;
/** `recomputeAllProgress` is UNBOUNDED (one request per issue number of every array-ref sprint), so
 *  this is an ESTIMATE for deciding whether another org may start; what a unit really spent is
 *  counted (`Budget.spent`), so one large org shortens the slice instead of overrunning it. */
export const PROGRESS_COST_ESTIMATE = 40;

/**
 * The repo trigger's dispatcher. REPO_CRON gives six ticks an hour and the jobs
 * are spread ACROSS them — ONE heavy job per invocation, never stacked — and
 * each job runs for EVERY active org, a unit at a time, by rotation:
 *
 *   every tick   `health` — one unit per (org, environment): 2 pings
 *                (`pingHealth`), 4 for two environments — and the handoff
 *                expiry sweep (`expireDueHandoffs`, D1 only, cross-org).
 *   :00          `usage` — one unit per (org, environment), and NOTHING else
 *                may run on this tick. Three pollers, each its own guarded arm
 *                (one failing never skips another), each skipped entirely when
 *                the org has no credential for it (`usageForEnv`):
 *                `pollCloudflare` 1 GraphQL request, `pollRailway` 1,
 *                `pollSaplingMetrics` 1 GET (`redirect: "manual"`, so never a
 *                second hop). So this tick is 5 requests per environment: 10
 *                for SaplingLearn's two. Wall clock, everything hanging: 8s
 *                health (concurrent) + 10s Cloudflare + 10s Railway + 8s
 *                metrics per environment, all of it I/O wait, not CPU.
 *   :10 (h%6)    `progress` — one unit per org with a primary repo:
 *                `recomputeAllProgress`, UNBOUNDED (`fetchGithubRefProgress`
 *                issues one request per issue number of every array-ref
 *                sprint), so it gets an invocation to itself.
 *   :20 (h%6)    `reconcile` — one unit per org with a primary repo:
 *                `reconcileRepo`, worst case 19 + 2N requests for N
 *                environments (23 for two): 2 PR lists + 1 pre-capture commit
 *                window + 1 GraphQL deployments + 1 workflow-run list + ≤5 job
 *                lookups + 1 commit-status list + 1 GraphQL reviews + 5 GraphQL
 *                branch pages + 2 drift compares + 2 per environment (head
 *                commit, head checks). With the tick's own pings: 19 + 4N.
 *   :30 (h%6)    `pruneRepoCapture` + `pruneOAuth` — D1 only, cross-org sweeps.
 *
 * THE BUDGET. One invocation may spend `CRON_SUBREQUEST_BUDGET` outbound
 * requests (and `CRON_WALL_BUDGET_MS` of wall clock) — ./dispatch.ts. `health`
 * goes first and, on a tick that also has a heavy job, may use at most HALF, so
 * neither can starve the other; each job resumes after the unit its previous
 * invocation stopped at (`cron_cursor`). With one org and two environments every
 * tick serves every unit and the cursor is never written.
 *
 * ISOLATION. A unit runs as its own org's system tenant, with its own org's
 * credentials, in its own guarded arm: its failure is logged (scrubbed, with the
 * org id) and recorded on THAT org's integration row, and the loop moves on. An
 * org with no environment and no repo has no unit: it costs nothing and logs
 * nothing. A suspended org is not listed. Nothing throws out of here.
 *
 * `limit` is the invocation's subrequest budget — a parameter only so a test can
 * make it small enough to watch the rotation.
 */
export async function handleRepoCron(env: Env, scheduledTime: number, fetchImpl?: typeof fetch, limit: number = CRON_SUBREQUEST_BUDGET): Promise<void> {
  const when = new Date(scheduledTime);
  const minute = when.getUTCMinutes();
  const hour = when.getUTCHours();
  const p = platform(env, "system");
  const budget = newBudget(fetchImpl, limit);
  const safely = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      console.error("repo cron", label, scrubbedLog(e, env));
    }
  };
  const heavy: "usage" | OrgJob | null = minute === 0 ? "usage"
    : hour % 6 !== 0 ? null
    : minute === 10 ? "progress" : minute === 20 ? "reconcile" : null;

  // Every tick: the health pings of every (org, environment).
  let envUnits: (Unit & { envKey: string })[] = [];
  await safely("health", async () => {
    envUnits = (await listEnvUnits(p)).map((u) => ({ key: `${u.org_id}/${u.key}`, orgId: u.org_id, envKey: u.key, cost: HEALTH_COST }));
    await serveJob(p, "health", envUnits, budget, heavy ? limit / 2 : limit,
      (u) => runEnvJob(env, u.orgId, u.envKey, "health", scheduledTime, budget.fetch));
  });
  // Every tick: pending handoffs past their expires_at flip to expired — in EVERY org (a cross-org,
  // write-only sweep on the platform context, §4.4). D1 only (no subrequest), so it adds nothing to
  // any tick's budget, and it runs BEFORE the :00 early return so no hour is skipped.
  await safely("handoff expiry", () => expireDueHandoffs(p, scheduledTime));

  if (heavy === "usage") {
    // The hourly polls — and NOTHING else may join this tick: the slot exists
    // so these pollers get an invocation of their own. The outcomes are for the
    // on-demand route; the pollers already log every failure, so the cron logs
    // nothing new.
    await safely("usage polls", () => serveJob(p, "usage", envUnits.map((u) => ({ ...u, cost: USAGE_COST })), budget, limit,
      (u) => runEnvJob(env, u.orgId, u.envKey, "usage", scheduledTime, budget.fetch)));
    return;
  }

  if (hour % 6 !== 0) return;

  // The progress backstop this trigger has always run (:10) and the GitHub reconcile (:20) — each on
  // its own invocation, for every org with a primary repo.
  if (heavy) {
    await safely(heavy, async () => {
      const units = (await listRepoUnits(p)).map((u) => ({ key: u.org_id, orgId: u.org_id, cost: heavy === "reconcile" ? reconcileCost(u.envs) : PROGRESS_COST_ESTIMATE }));
      await serveJob(p, heavy, units, budget, limit, (u) => runOrgJob(env, u.orgId, heavy, scheduledTime, budget.fetch));
    });
  }

  if (minute === 30) {
    // The two retention sweeps are, like the handoff expiry above, deliberately CROSS-ORG and
    // write-only (§4.4's allowlist): they take the platform context, not one org's.
    await safely("prune", () => pruneRepoCapture(p, scheduledTime));
    // MCP OAuth housekeeping rides the same D1-only tick: spent codes, dead tokens,
    // never-used client registrations. Grants are never deleted.
    await safely("oauth-prune", () => pruneOAuth(p, scheduledTime));
  }
}
