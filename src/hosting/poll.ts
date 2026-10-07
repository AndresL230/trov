// The hosting POLL framework (#97): it runs ONE provider for ONE stored part and stores what came back.
// A provider (./providers/*, registered in ./registry.ts) is pure apart from its fetches and returns
// NORMALISED data (`PollResult`, ./types.ts); everything that touches D1, a credential or the outcome
// lives here, once, for every provider:
//
//   1. the provider must be `available`, else `skipped` ("not supported yet");
//   2. its credential comes through `resolveCredential` — scope "" for an org-wide credential, the
//      environment key for a per-environment one — and an org without it is `skipped` ("not connected")
//      BEFORE anything is fetched: a part whose provider is not connected costs no request;
//   3. the org's non-secret provider settings (`org_integration_config`, scope "") and the part's own
//      settings must carry every REQUIRED field, in its pattern, else `skipped` naming the field (never
//      its value) — so a provider is only ever handed settings that passed (./types.ts promises it);
//   4. the provider polls through `hostFetch` (./http.ts): its own API hosts only, https, no redirect;
//   5. what it returned is VALIDATED here, item by item, before anything is stored — a provider is code
//      Trov runs, but its numbers come from a vendor's API, and a stored point is permanent (first write
//      wins). An item that fails is DROPPED and counted, never repaired into a guess;
//   6. points → `putMetrics` as `hx_<metric>` (env = environment key, part = part key); deploys → ONE
//      batch of upserts into `hosting_deploys` (a deploy's state MOVES, so not first-write-wins); the
//      outcome → `hosting_poll_state`, with the covered interval MERGED (the `cf_polled` rule, below);
//   7. the credential's integration row learns the outcome (`recordSecretOutcome`: `last_used_at`, or a
//      scrubbed `last_error` — for a 401, the fixed `refusedText`; a poll never deletes a credential).
//
// `pollPart` NEVER throws. A provider's refusal is a `HostingError` (scrubbed at construction, and again
// here with the credential this module revealed); anything else becomes `asHostingError`'s fixed text —
// a thrown fetch or a parse error can quote part of a request, which no whole-value scrub would catch. A
// failure is logged as `hosting poll <provider> <env> <part> <detail> org=<id>` — the message, never the
// Error object, never the token.
//
// This module imports src/data/secrets.ts, so nothing reachable from src/mcp.ts may import it
// (test/secrets.mcp.test.ts): its callers are src/repo/cron.ts (the `:40` job and Poll now) only.
import {
  HOSTING_INTEGRATION_KIND, HOSTING_METRICS, hostingMetricName, isDeployState, isHostingMetric, isHostingProvider,
  type DeployState, type DeployTarget, type HostingMetric, type HostingPollOutcome, type HostingProviderId,
} from "@shared/hosting";
import type { Env } from "../env";
import { type Stmt, type TenantContext, batch, first, run, stmt } from "../data/sql";
import { type Revealed, type Secret, getIntegrationConfig, lastErrorText, recordSecretOutcome, resolveCredential, scrub } from "../data/secrets";
import { jobTenant } from "../platform/jobs";
import { DAY, HOSTING_DEPLOY_RETENTION_DAYS, USAGE_RETENTION_DAYS, putMetrics } from "../repo/store";
import type { RepoMetric } from "../repo/types";
import { HOUR, HostingError, asHostingError, hostFetch, hourFloor, iso } from "./http";
import { listStoredParts, partRef, type PartRow } from "./parts";
import { PROVIDERS } from "./registry";
import type { HostingField, HostingProvider, PollResult } from "./types";

/** The providers a poll may run — the registry, or (tests) a map holding a fake. */
export type ProviderMap = Readonly<Partial<Record<HostingProviderId, HostingProvider>>>;

/** What a unit is budgeted at when its provider's `pollCost` is unusable (unknown provider, a bad value). */
export const DEFAULT_HOSTING_COST = 5;

/** A provider's declared worst-case fetches for one poll — what the cron's rotation and Poll now's
 *  budget size a part by. `provider` is a stored string, so an id the code no longer knows (or a
 *  provider whose `pollCost` is not a positive number) is budgeted at `DEFAULT_HOSTING_COST`. */
export function providerPollCost(providers: ProviderMap, provider: string): number {
  const cost = isHostingProvider(provider) ? providers[provider]?.pollCost : undefined;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 1 ? Math.ceil(cost) : DEFAULT_HOSTING_COST;
}

/** The worst case of polling every one of `parts`, in subrequests. */
export const hostingPollCost = (parts: readonly PartRow[], providers: ProviderMap = PROVIDERS): number =>
  parts.reduce((n, p) => n + providerPollCost(providers, p.provider), 0);

// ── validation: never trust a provider ───────────────────────────────────────

/** Above these a value is not believed — sanity ceilings far past any real figure for ONE hour of ONE
 *  part, so a unit mix-up (bytes for MB, ms for s × 1000) or garbage is dropped rather than stored for
 *  100 days. A `Record` over the vocabulary, so a metric added to shared/hosting.ts must be given one. */
const METRIC_CAP: Record<HostingMetric, number> = {
  requests: 1e12,
  errors: 1e12,
  latency_p50_ms: 3_600_000,      // an hour
  latency_p95_ms: 3_600_000,
  bandwidth_bytes: 1e16,          // 10 PB in an hour
  cpu: 1024,                      // vCPU — the Railway poller's own ceiling
  mem_mb: 4096 * 1024,            // 4 TB — likewise
};
/** At most this many points / deploys are stored from ONE poll: a 3-hour window of seven metrics is 21
 *  points and a provider lists its newest deploys, so these only ever stop a provider gone wrong. */
export const MAX_POINTS_PER_POLL = 1000;
export const MAX_DEPLOYS_PER_POLL = 50;
const DEPLOY_ID_MAX = 200;
const MESSAGE_MAX = 200;
const URL_MAX = 500;
const BRANCH_MAX = 200;
const ACTOR_MAX = 100;
const REASON_MAX = 200;
/** A deploy "created" further ahead of the clock than this is a provider's bad clock, not a deploy. */
const FUTURE_SLACK_MS = HOUR;
/** Detail strings (`hosting_poll_state.detail`, an outcome's `detail`) — `lastErrorText`'s 300. */
const DETAIL_MAX = 300;

/** A deploy as it is stored — every string checked, scrubbed and capped, every instant normalised. */
export interface CleanDeploy {
  id: string; state: DeployState; target: DeployTarget; sha: string | null; branch: string | null; message: string | null;
  by: string | null; createdAt: string; readyAt: string | null; url: string | null; inspectUrl: string | null;
}
export interface CleanPoll {
  points: RepoMetric[];
  deploys: CleanDeploy[];
  unavailable: { metric: HostingMetric; reason: string }[];
  /** Snapped INWARD to whole hours, its end clamped to the current hour's floor; null when the provider
   *  claimed none, or claimed one that is not an interval. */
  covered: { from: number; to: number } | null;
  dropped: { points: number; deploys: number; unavailable: number };
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A provider string, scrubbed FIRST (it may quote an upstream), then one line, trimmed, then cut. */
const prose = (v: unknown, max: number, revealed: Revealed): string | null => {
  if (typeof v !== "string") return null;
  const s = scrub(v, revealed).split(/\r?\n/)[0].replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return s || null;
};
/** An identifier-like string: one line, no control character, within `max` — else null. NEVER cut: a cut
 *  id could collide with another, a cut branch name names a different branch. */
const ident = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.length <= max && !CONTROL.test(s) ? s : null;
};
/** An https URL with no credentials in it, scrubbed, at most `URL_MAX` long — else null (a cut URL is a
 *  broken link). */
const httpsUrl = (v: unknown, revealed: Revealed): string | null => {
  if (typeof v !== "string") return null;
  const s = scrub(v.trim(), revealed);
  if (!s || s.length > URL_MAX || CONTROL.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch { return null; }
};
const instantMs = (v: unknown): number | null => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * PURE: what a provider returned, checked item by item against the contract (./types.ts) and the part.
 *   points       a known `HostingMetric` of the part's ROLE (a web part stores no CPU), `at` an hour start
 *                STRICTLY before the current hour's floor (a running hour stored short is stored short
 *                forever) and inside the 100-day retention, a finite number ≥ 0 under the metric's ceiling;
 *                one per (metric, hour) — the first wins, as it would in D1.
 *   deploys      an id (≤ 200, one line), a state in `DEPLOY_STATES`, a parseable creation instant no more
 *                than an hour ahead and inside the 180-day retention; the rest is optional and NULLED when
 *                it does not hold (a target outside production / preview, a sha that is not 7–64 hex, a
 *                non-https URL). Prose is scrubbed of the credential, one line, cut. The newest 50 are kept;
 *                one id once.
 *   unavailable  a known metric of the part's role with a reason (scrubbed, ≤ 200), once per metric.
 *   covered      `[from, to)` snapped inward to whole hours, `to` clamped to the current hour's floor; not an
 *                interval → null. A point outside it is still a real point; the interval only decides where
 *                a MISSING hour may be read as zero.
 */
export function validatePoll(result: unknown, part: Pick<PartRow, "env" | "key" | "role">, now: number, revealed: Revealed = null): CleanPoll {
  const r = record(result);
  const nowHour = hourFloor(now);
  const oldestPoint = now - USAGE_RETENTION_DAYS * DAY;
  const oldestDeploy = now - HOSTING_DEPLOY_RETENTION_DAYS * DAY;
  const dropped = { points: 0, deploys: 0, unavailable: 0 };
  const ofRole = (m: unknown): m is HostingMetric => isHostingMetric(m) && HOSTING_METRICS[m].role === part.role;

  const points: RepoMetric[] = [];
  const seenPoint = new Set<string>();
  for (const raw of Array.isArray(r.points) ? r.points : []) {
    const p = record(raw);
    const t = instantMs(p.at);
    const value = p.value;
    const okValue = typeof value === "number" && Number.isFinite(value) && value >= 0 && ofRole(p.metric) && value < METRIC_CAP[p.metric];
    const key = `${String(p.metric)}@${t}`;
    if (!ofRole(p.metric) || t === null || t % HOUR !== 0 || t >= nowHour || t < oldestPoint || !okValue
      || seenPoint.has(key) || points.length >= MAX_POINTS_PER_POLL) {
      dropped.points++;
      continue;
    }
    seenPoint.add(key);
    points.push({ metric: hostingMetricName(p.metric), env: part.env, part: part.key, value: value as number, at: iso(t) });
  }

  const deploys: CleanDeploy[] = [];
  const seenDeploy = new Set<string>();
  for (const raw of Array.isArray(r.deploys) ? r.deploys : []) {
    const d = record(raw);
    const id = ident(d.id, DEPLOY_ID_MAX);
    const created = instantMs(d.createdAt);
    if (!id || !isDeployState(d.state) || created === null || created > now + FUTURE_SLACK_MS || created < oldestDeploy || seenDeploy.has(id)) {
      dropped.deploys++;
      continue;
    }
    seenDeploy.add(id);
    const ready = instantMs(d.readyAt);
    const sha = typeof d.sha === "string" && /^[0-9a-fA-F]{7,64}$/.test(d.sha.trim()) ? d.sha.trim().toLowerCase() : null;
    deploys.push({
      id, state: d.state, target: d.target === "production" || d.target === "preview" ? d.target : null, sha,
      branch: ident(d.branch, BRANCH_MAX), message: prose(d.message, MESSAGE_MAX, revealed), by: prose(d.by, ACTOR_MAX, revealed),
      createdAt: iso(created), readyAt: ready === null ? null : iso(ready),
      url: httpsUrl(d.url, revealed), inspectUrl: httpsUrl(d.inspectUrl, revealed),
    });
  }
  // The newest `MAX_DEPLOYS_PER_POLL`; whatever a provider over-delivered beyond them is counted, not kept.
  deploys.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  if (deploys.length > MAX_DEPLOYS_PER_POLL) dropped.deploys += deploys.splice(MAX_DEPLOYS_PER_POLL).length;

  const unavailable: { metric: HostingMetric; reason: string }[] = [];
  for (const raw of Array.isArray(r.unavailable) ? r.unavailable : []) {
    const u = record(raw);
    const reason = prose(u.reason, REASON_MAX, revealed);
    if (!ofRole(u.metric) || !reason || unavailable.some((x) => x.metric === u.metric)) { dropped.unavailable++; continue; }
    unavailable.push({ metric: u.metric, reason });
  }

  let covered: CleanPoll["covered"] = null;
  const c = record(r.covered);
  const cFrom = instantMs(c.from), cTo = instantMs(c.to);
  if (cFrom !== null && cTo !== null) {
    const from = Math.ceil(cFrom / HOUR) * HOUR;
    const to = Math.min(nowHour, Math.floor(cTo / HOUR) * HOUR);
    if (from < to) covered = { from, to };
  }
  return { points, deploys, unavailable, covered, dropped };
}

/**
 * The covered interval after this poll — the `cf_polled` rule (src/repo/poll.ts `pollCloudflare`),
 * generalised to an interval that may arrive on either side. When the two OVERLAP or TOUCH they become one
 * (neither end ever moves backwards); when the new window lies AFTER a gap — an outage longer than the
 * window left hours nothing looked at — the interval RESTARTS at the new window, and that jump is the
 * record of the hole: the projection never draws a zero before `from`. A window wholly OLDER than the
 * previous interval (and apart from it) leaves the previous one standing: the newest stretch is the one
 * the trend is drawn in. PURE.
 */
export function mergeCovered(prev: { from: number; to: number } | null, next: { from: number; to: number } | null): { from: number; to: number } | null {
  if (!next) return prev;
  if (!prev) return next;
  if (next.from <= prev.to && next.to >= prev.from) return { from: Math.min(prev.from, next.from), to: Math.max(prev.to, next.to) };
  return next.from > prev.to ? next : prev;
}

// ── storage ──────────────────────────────────────────────────────────────────

/**
 * ONE batch of upserts, keyed `(org_id, env, part, provider, deploy_id)`. A deploy's state moves (building →
 * ready), so a row is UPDATED — but only when something actually changed (the `WHERE`), so a re-poll of a
 * settled deploy writes nothing and `meta.changes` counts new OR changed rows only. A later poll that no
 * longer reports a field (a message, a URL) never erases one already known (`COALESCE`); the creation
 * instant and the first `recorded_at` are kept. Returns how many rows were new or changed.
 */
async function upsertDeploys(ctx: TenantContext, part: PartRow, deploys: CleanDeploy[], now: number): Promise<number> {
  if (!deploys.length) return 0;
  const at = iso(now);
  const stmts: Stmt[] = deploys.map((d) => stmt(ctx,
    `INSERT INTO hosting_deploys (org_id, env, part, provider, deploy_id, state, target, sha, branch, message, actor, url, inspect_url,
                                  created_at, ready_at, recorded_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, env, part, provider, deploy_id) DO UPDATE SET
       state = excluded.state,
       target = COALESCE(excluded.target, hosting_deploys.target),
       sha = COALESCE(excluded.sha, hosting_deploys.sha),
       branch = COALESCE(excluded.branch, hosting_deploys.branch),
       message = COALESCE(excluded.message, hosting_deploys.message),
       actor = COALESCE(excluded.actor, hosting_deploys.actor),
       url = COALESCE(excluded.url, hosting_deploys.url),
       inspect_url = COALESCE(excluded.inspect_url, hosting_deploys.inspect_url),
       ready_at = COALESCE(excluded.ready_at, hosting_deploys.ready_at),
       updated_at = excluded.updated_at
     WHERE hosting_deploys.state IS NOT excluded.state
        OR (excluded.target IS NOT NULL AND hosting_deploys.target IS NOT excluded.target)
        OR (excluded.sha IS NOT NULL AND hosting_deploys.sha IS NOT excluded.sha)
        OR (excluded.branch IS NOT NULL AND hosting_deploys.branch IS NOT excluded.branch)
        OR (excluded.message IS NOT NULL AND hosting_deploys.message IS NOT excluded.message)
        OR (excluded.actor IS NOT NULL AND hosting_deploys.actor IS NOT excluded.actor)
        OR (excluded.url IS NOT NULL AND hosting_deploys.url IS NOT excluded.url)
        OR (excluded.inspect_url IS NOT NULL AND hosting_deploys.inspect_url IS NOT excluded.inspect_url)
        OR (excluded.ready_at IS NOT NULL AND hosting_deploys.ready_at IS NOT excluded.ready_at)`,
    ctx.orgId, part.env, part.key, part.provider, d.id, d.state, d.target, d.sha, d.branch, d.message, d.by, d.url, d.inspectUrl,
    d.createdAt, d.readyAt, at, at));
  let changed = 0;
  // ≤ MAX_DEPLOYS_PER_POLL (50) statements — exactly one D1 batch, one transaction.
  for (const res of await batch(ctx, stmts)) if (res.meta.changes > 0) changed++;
  return changed;
}

interface StateRow { provider: string; last_ok_at: string | null; covered_from: string | null; covered_to: string | null; unavailable: string }

/**
 * `hosting_poll_state` after this poll — a read-modify-write of ONE row (no lock: the cron's units run one
 * after another, and an on-demand poll overlapping a tick computes the same window, so a lost update is
 * re-written identically by the next poll — the `cf_polled` argument). A row left by a DIFFERENT provider
 * (the part was re-pointed) is not this provider's history: its interval, `last_ok_at` and `unavailable`
 * are dropped. A failed or skipped poll keeps the interval and `unavailable` of the last good one.
 */
async function writeState(
  ctx: TenantContext, part: PartRow, now: number, status: HostingPollOutcome["status"], detail: string | null,
  ok: { covered: { from: number; to: number } | null; unavailable: CleanPoll["unavailable"] } | null,
): Promise<void> {
  const prev = await first<StateRow>(ctx,
    `SELECT provider, last_ok_at, covered_from, covered_to, unavailable FROM hosting_poll_state WHERE org_id = ? AND env = ? AND part = ?`,
    ctx.orgId, part.env, part.key);
  const mine = prev && prev.provider === part.provider ? prev : null;
  const prevFrom = instantMs(mine?.covered_from), prevTo = instantMs(mine?.covered_to);
  const prevCovered = prevFrom !== null && prevTo !== null && prevFrom <= prevTo ? { from: prevFrom, to: prevTo } : null;
  const covered = ok ? mergeCovered(prevCovered, ok.covered) : prevCovered;
  const at = iso(now);
  await run(ctx,
    `INSERT INTO hosting_poll_state (org_id, env, part, provider, polled_at, status, detail, last_ok_at, covered_from, covered_to, unavailable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, env, part) DO UPDATE SET provider = excluded.provider, polled_at = excluded.polled_at, status = excluded.status,
       detail = excluded.detail, last_ok_at = excluded.last_ok_at, covered_from = excluded.covered_from, covered_to = excluded.covered_to,
       unavailable = excluded.unavailable`,
    ctx.orgId, part.env, part.key, part.provider, at, status, detail,
    ok ? at : mine?.last_ok_at ?? null,
    covered ? iso(covered.from) : null, covered ? iso(covered.to) : null,
    ok ? JSON.stringify(ok.unavailable) : mine?.unavailable ?? "[]");
}

/** Why a part cannot be polled with these values, or null — the first REQUIRED field that is absent, or
 *  any field present outside its pattern. Fixed text naming the field (its label), never the value. A key
 *  the field list does not name is left alone: an installed integration may have stored more (Vercel's
 *  `team_id`), and only the declared fields are this check's business. */
function fieldProblem(fields: readonly HostingField[], values: Readonly<Record<string, string>>): string | null {
  for (const f of fields) {
    const v = values[f.key];
    if (v === undefined || v === "") {
      if (f.required) return `${f.label} is not set`;
      continue;
    }
    if (typeof v !== "string" || v.length > 200 || CONTROL.test(v) || (f.pattern && !f.pattern.test(v))) return `${f.label} is not in the expected form`;
  }
  return null;
}

const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What a poll's 401 is recorded as — in `last_error`, the poll state and the outcome. Fixed text. */
export const refusedText = (p: Pick<HostingProvider, "label">): string =>
  `${p.label} refused the token — the grant may have been removed; Test connection to confirm`;
function droppedText(d: CleanPoll["dropped"]): string {
  const parts = [d.points ? plural(d.points, "point") : "", d.deploys ? plural(d.deploys, "deploy") : "", d.unavailable ? plural(d.unavailable, "unavailable note") : ""].filter(Boolean);
  return parts.length ? `dropped as invalid: ${parts.join(", ")}` : "";
}

// ── the poll ─────────────────────────────────────────────────────────────────

/**
 * Poll ONE stored part and store what its provider reported (the numbered steps at the top of this file).
 * `now` may be any instant: a provider's window keys on its hour floor (`pollWindow`), points are
 * first-write-wins and deploys upsert, so an on-demand poll and the cron's `:40` write the same rows.
 * NEVER throws; the outcome carries no token, no header, nothing unscrubbed.
 */
export async function pollPart(
  env: Env, ctx: TenantContext, part: PartRow, now: number, fetchImpl?: typeof fetch, providers: ProviderMap = PROVIDERS,
): Promise<HostingPollOutcome> {
  const base = { env: part.env, part: part.key, provider: part.provider };
  const revealed: Revealed[] = [];
  // Record the outcome, then return it. A failure to WRITE the state is logged and does not change what
  // the poll came to (its points and deploys are already stored).
  const settle = async (out: HostingPollOutcome, ok: Parameters<typeof writeState>[5] = null, stateDetail?: string): Promise<HostingPollOutcome> => {
    try {
      await writeState(ctx, part, now, out.status, stateDetail ?? out.detail ?? null, ok);
    } catch (e) {
      console.error("hosting poll", part.provider, part.env, part.key, "state", lastErrorText(e instanceof Error ? e.message : String(e), revealed), `org=${ctx.orgId}`);
    }
    return out;
  };
  if (part.legacy) {
    // Cloudflare's frontend and Railway's backend live in the environment's own columns and are polled by
    // the `:00` usage job (src/repo/cron.ts `usageForEnv`) — never here, and no poll state is written.
    return { ...base, status: "skipped", written: 0, detail: "polled by the hourly usage job" };
  }
  try {
    const provider = providers[part.provider];
    if (!provider || provider.status !== "available") return await settle({ ...base, status: "skipped", written: 0, detail: "not supported yet" });
    const kind = HOSTING_INTEGRATION_KIND[part.provider];
    const scope = provider.credentialScope === "org" ? "" : part.env;

    let secret: Secret | null;
    try {
      secret = await resolveCredential(ctx, env, kind, scope);
    } catch {
      // A row that does not decrypt, or no platform key: the error's text is fixed and value-free, but it
      // is not repeated — the KIND says which credential.
      console.error("hosting poll", part.provider, part.env, part.key, "credential", kind, `org=${ctx.orgId}`);
      return await settle({ ...base, status: "failed", written: 0, detail: "the stored credential could not be read" });
    }
    // No credential: nothing is fetched — "an org without it costs no requests".
    if (!secret) return await settle({ ...base, status: "skipped", written: 0, detail: "not connected" });
    revealed.push(secret);

    const config = await getIntegrationConfig(ctx, kind, "");
    const missing = fieldProblem(provider.orgConfigFields, config) ?? fieldProblem(provider.partSettings, part.settings);
    if (missing) return await settle({ ...base, status: "skipped", written: 0, detail: missing });

    let result: PollResult;
    try {
      result = await provider.poll({ fetch: hostFetch(provider.apiHosts, fetchImpl), credential: { secret, config }, now }, partRef(ctx.orgId, part));
    } catch (e) {
      // `asHostingError` keeps a HostingError's message (already scrubbed by the provider with what IT
      // revealed) and replaces anything else with fixed text; `lastErrorText` scrubs again with the
      // credential THIS module revealed, then one line, then cuts — scrub before cut, always. A 401 is FIXED
      // text: the provider no longer accepts the credential — for an install / OAuth grant, most likely
      // removed on its side. A poll never ends a connection or deletes a credential for it (a transient 401
      // must not cost an org its install); Test connection confirms, and ends it (src/integrations/probe.ts).
      const detail = e instanceof HostingError && e.status === 401 ? refusedText(provider)
        : lastErrorText(asHostingError(provider.label.toLowerCase(), e).message, revealed) || "failed";
      console.error("hosting poll", part.provider, part.env, part.key, detail, `org=${ctx.orgId}`);
      await recordSecretOutcome(ctx, kind, scope, { ok: false, message: detail, revealed }, now).catch(() => undefined);
      return await settle({ ...base, status: "failed", written: 0, detail });
    }

    const clean = validatePoll(result, part, now, revealed);
    const newPoints = await putMetrics(ctx, clean.points);
    const changedDeploys = await upsertDeploys(ctx, part, clean.deploys, now);
    const dropped = droppedText(clean.dropped);
    if (dropped) console.warn("hosting poll", part.provider, part.env, part.key, dropped, `org=${ctx.orgId}`);
    await recordSecretOutcome(ctx, kind, scope, { ok: true }, now).catch(() => undefined);
    // The state says what was written; the outcome says only what was dropped (an `ok` with nothing to
    // add carries no detail — `PollOutcome`'s convention).
    const wrote = `${plural(newPoints, "new point")}, ${plural(changedDeploys, "new or changed deploy")}`;
    return await settle(
      { ...base, status: "ok", written: newPoints + changedDeploys, ...(dropped ? { detail: dropped.slice(0, DETAIL_MAX) } : {}) },
      { covered: clean.covered, unavailable: clean.unavailable },
      lastErrorText(dropped ? `${wrote}; ${dropped}` : wrote, revealed),
    );
  } catch (e) {
    // A D1 failure (the config read, a write): logged scrubbed, reported as fixed words.
    console.error("hosting poll", part.provider, part.env, part.key, lastErrorText(e instanceof Error ? e.message : String(e), revealed), `org=${ctx.orgId}`);
    return { ...base, status: "failed", written: 0, detail: "unexpected error" };
  }
}

/** Poll each of `parts` in turn (sequentially — one provider's slowness is the next one's wait, never a
 *  burst of concurrent requests against the subrequest budget). */
export async function pollParts(
  env: Env, ctx: TenantContext, parts: readonly PartRow[], now: number, fetchImpl?: typeof fetch, providers: ProviderMap = PROVIDERS,
): Promise<HostingPollOutcome[]> {
  const out: HostingPollOutcome[] = [];
  for (const part of parts) out.push(await pollPart(env, ctx, part, now, fetchImpl, providers));
  return out;
}

/**
 * Every STORED part of the caller's org, polled now — what the cron's `:40` job does a unit at a time,
 * for one org in one call. `caller` names the org (an admin's session, or a system context); it runs as
 * that org's system tenant (`jobTenant`, which refuses a bearer context). `"not_configured"` = the org has
 * no stored part (its legacy Cloudflare / Railway parts are the usage job's).
 */
export async function runHostingPolls(
  env: Env, caller: TenantContext, now: number, fetchImpl?: typeof fetch, providers: ProviderMap = PROVIDERS,
): Promise<HostingPollOutcome[] | "not_configured"> {
  const ctx = jobTenant(env, caller);
  const parts = await listStoredParts(ctx);
  return parts.length ? pollParts(env, ctx, parts, now, fetchImpl, providers) : "not_configured";
}
