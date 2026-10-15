// A `github` part's deploys (repo setups, Phase A), written from the GitHub CAPTURE — the provider is never
// polled (src/hosting/providers/github.ts). When the webhook stores a new signal (src/webhook.ts
// `captureDelivery`) it is offered here; it becomes a `hosting_deploys` row (`source = 'github'`, `sha_source =
// 'provider'` — GitHub gives the sha) ONLY for a `github` part whose OWN setting it matches:
//
//   environment   a deployment / deployment status (`deploy`, `raw.signal = 'deployment'`) whose environment
//                 name is EXACTLY the setting — and, when its ref is a branch (Render, Actions), the
//                 environment's branch (a sha ref — Vercel, Railway — says nothing about the branch);
//   check run     a check run (`check`) posted by the setting's app (`raw.app`) with the setting's name, on the
//                 environment's branch (`check_suite.head_branch`);
//   workflow      a completed workflow run (`run`) of the setting's file (`raw.path`) on the environment's branch.
//
// THE GUARD: an untagged signal never sets a part's deploy without a matching part setting — `signalMatchesPart`
// is the one place that decides, and an org with no `github` part writes nothing at all. The same matcher fills a
// part from HISTORY (`backfillGithubDeploys`, below): reconcile's backfilled runs and checks, and the signals
// captured before the part or its setting existed.
//
// Reads and writes D1 through the tenant surface only and imports nothing that reads a secret, so the webhook's
// capture (reachable from src/mcp.ts) may call it. The rollback check it may run uses the GitHub token the
// webhook entry point resolved (`resolveGithubCredential`) and hands down.
import type { DeployState } from "@shared/hosting";
import { all, type TenantContext } from "../data/sql";
import type { RepoEvent } from "../repo/types";
import { upsertDeploys, REASON_STORED_MAX, type CleanDeploy } from "./deploy-store";
import { listAllParts, type PartRow } from "./parts";
import { workflowPath } from "./providers/github";

type Obj = Record<string, unknown>;
const rawOf = (ev: Pick<RepoEvent, "raw">): Obj => {
  try { const v = JSON.parse(ev.raw) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {}; } catch { return {}; }
};
const s = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const SHA = /^[0-9a-f]{7,64}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** One line, no control character, ≤ max — a GitHub-supplied string as stored. */
const line = (v: unknown, max: number): string | null => {
  const t = s(v);
  if (!t) return null;
  const one = t.split(/\r?\n/)[0].replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return one || null;
};
const ident = (v: unknown, max: number): string | null => {
  const t = s(v)?.trim();
  return t && t.length <= max && !CONTROL.test(t) ? t : null;
};
const https = (v: unknown): string | null => {
  const t = s(v);
  if (!t || t.length > 500) return null;
  try { const u = new URL(t); return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null; } catch { return null; }
};
const instantIso = (v: unknown): string | null => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** A deployment-status state → `DEPLOY_STATES`; null = not a deploy state change to record (`inactive`: a later
 *  deployment replaced it — it LANDED, and its last real state stays). */
const DEPLOYMENT_STATE: Readonly<Record<string, DeployState>> = {
  created: "queued", queued: "queued", pending: "queued", waiting: "queued", in_progress: "building",
  success: "ready", failure: "error", error: "error",
};
/** A check run's / workflow run's conclusion (or `pending` while it runs) → `DEPLOY_STATES`. `neutral` and
 *  anything unknown are skipped, never guessed. */
const CONCLUSION_STATE: Readonly<Record<string, DeployState>> = {
  pending: "building", success: "ready",
  failure: "error", timed_out: "error", action_required: "error", startup_failure: "error",
  cancelled: "canceled", skipped: "canceled", stale: "canceled",
};

/** The ref a deployment carries is a BRANCH (Render, Actions) rather than a sha (Vercel, Railway). */
const isBranchRef = (ref: string | null | undefined): ref is string => !!ref && !SHA.test(ref) && !ref.startsWith("refs/tags/");

/**
 * THE GUARD. Does this captured signal belong to this `github` part? Only by the part's own setting — exact
 * environment name, exact app + check name, exact workflow file — on the environment's branch. A part on any
 * other provider, a part with no setting, a look-alike name or another branch: no. PURE.
 */
export function signalMatchesPart(ev: Pick<RepoEvent, "kind" | "name" | "ref" | "raw">, part: Pick<PartRow, "provider" | "branch" | "settings">): boolean {
  if (part.provider !== "github") return false;
  const set = part.settings;
  const raw = rawOf(ev);
  if (set.environment) {
    if (ev.kind !== "deploy" || raw.signal !== "deployment" || ev.name !== set.environment) return false;
    return !isBranchRef(ev.ref) || ev.ref === part.branch;
  }
  if (set.check_app && set.check_name) {
    return ev.kind === "check" && s(raw.app) === set.check_app && ev.name === set.check_name && ev.ref === part.branch;
  }
  if (set.workflow) {
    return ev.kind === "run" && s(raw.path) === workflowPath(set.workflow) && ev.ref === part.branch;
  }
  return false;
}

/** The deploy a matched signal says — or null when its state is not one to record. PURE. */
export function deployFromSignal(ev: RepoEvent): CleanDeploy | null {
  const raw = rawOf(ev);
  const at = instantIso(ev.occurred_at);
  if (!at || ev.number === null || ev.number === undefined) return null;
  const sha = ev.sha && SHA.test(ev.sha) ? ev.sha.toLowerCase() : null;
  if (ev.kind === "deploy") {
    const state = DEPLOYMENT_STATE[ev.state ?? ""] ?? null;
    if (!state) return null;
    const settled = state === "ready" || state === "error";
    return {
      id: `gh-deployment:${ev.number}`, state, target: null, sha, branch: isBranchRef(ev.ref) ? ident(ev.ref, 200) : null,
      message: line(raw.description, 200), by: line(ev.actor_login, 100),
      createdAt: instantIso(raw.deployment_created_at) ?? at, readyAt: settled ? at : null,
      url: https(raw.environment_url), inspectUrl: https(ev.url),
      reason: state === "error" ? line(raw.description, REASON_STORED_MAX) : null,
    };
  }
  if (ev.kind === "check" || ev.kind === "run") {
    const state = CONCLUSION_STATE[ev.state ?? ""] ?? null;
    if (!state) return null;
    const settled = state !== "building";
    return {
      id: ev.kind === "check" ? `gh-check:${ev.number}` : `gh-run:${ev.number}:${ev.count ?? 1}`, state, target: null, sha,
      branch: ident(ev.ref, 200), message: ev.kind === "run" ? line(ev.name, 200) : null, by: line(ev.actor_login, 100),
      createdAt: ev.kind === "run" ? instantIso(raw.started_at) ?? at : at, readyAt: settled ? at : null,
      url: null, inspectUrl: https(ev.url),
      reason: state === "error" ? line(ev.kind === "check" ? raw.output_title ?? ev.name : ev.name, REASON_STORED_MAX) : null,
    };
  }
  return null;
}

export interface GithubDeployWrite { env: string; part: string; id: string; state: DeployState; changed: boolean }

/**
 * Offer ONE newly captured signal to the org's `github` parts: each part whose setting it matches gets the
 * deploy upserted (`source = 'github'`). `afterReady` runs for a deploy that was new or changed and is `ready`
 * (the rollback check, src/hosting/rollback.ts). Returns what was written. An org with no `github` part reads
 * its parts once and writes nothing.
 */
export async function writeGithubDeploys(
  ctx: TenantContext, ev: RepoEvent, now: number,
  afterReady?: (part: PartRow, deployId: string) => Promise<void>,
): Promise<GithubDeployWrite[]> {
  if (ev.kind !== "deploy" && ev.kind !== "check" && ev.kind !== "run") return [];
  const parts = (await listAllParts(ctx)).filter((p) => p.provider === "github" && signalMatchesPart(ev, p));
  if (!parts.length) return [];
  const d = deployFromSignal(ev);
  if (!d) return [];
  const out: GithubDeployWrite[] = [];
  for (const part of parts) {
    const changed = (await upsertDeploys(ctx, part, [d], now, "github")).length > 0;
    out.push({ env: part.env, part: part.key, id: d.id, state: d.state, changed });
    if (changed && d.state === "ready" && afterReady) await afterReady(part, d.id);
  }
  return out;
}

// ── history: the signals captured BEFORE a part could match them ─────────────
//
// A live delivery reaches `writeGithubDeploys` above; two things never do: the check runs and workflow runs that
// RECONCILE backfills (src/repo/github.ts, through the gate), and the signals captured before a `github` part — or
// its current setting — existed (the Apps tab's deploy-signal picker names exactly such a signal). So reconcile (a
// guarded arm after its capture arms) and `putPart` (src/hosting/part-writes.ts, after a `github` part is written)
// replay the captured, untagged signals of the last 30 days through the SAME matcher — `signalMatchesPart`, THE
// GUARD — and upsert what matches. D1 only: no GitHub request, so no rollback compare (the live path's job).

/** How far back a part is filled from captured signals — the window the Apps tab's picker offers signals from. */
export const GITHUB_DEPLOY_HISTORY_DAYS = 30;
/** At most this many captured signals are read per pass (the newest), and this many deploys written per part. */
const HISTORY_SIGNAL_MAX = 500;
const HISTORY_DEPLOYS_PER_PART = 50;

/** A deploy's later signal over an earlier one, as the upsert's COALESCE would fold them one by one: the state
 *  moves, a field a later signal does not carry keeps the earlier value, the creation instant stays the first. */
const fold = (prev: CleanDeploy, next: CleanDeploy): CleanDeploy => ({
  id: next.id, state: next.state, target: next.target ?? prev.target, sha: next.sha ?? prev.sha, branch: next.branch ?? prev.branch,
  message: next.message ?? prev.message, by: next.by ?? prev.by, createdAt: prev.createdAt, readyAt: next.readyAt ?? prev.readyAt,
  url: next.url ?? prev.url, inspectUrl: next.inspectUrl ?? prev.inspectUrl, reason: next.reason ?? prev.reason,
});

/**
 * Fill the org's `github` parts (or just `only`) from the captured, untagged deployment / check-run / workflow-run
 * signals of the last 30 days: each part gets the deploys of the signals ITS OWN setting matches
 * (`signalMatchesPart`), oldest first so the newest state wins, each deploy upserted once (idempotent — a second
 * pass writes nothing). Returns the deploys that were new or changed. An org with no `github` part reads its parts
 * once and nothing else.
 */
export async function backfillGithubDeploys(ctx: TenantContext, now: number, only?: { env: string; key: string }): Promise<GithubDeployWrite[]> {
  const parts = (await listAllParts(ctx)).filter((p) => p.provider === "github" && (!only || (p.env === only.env && p.key === only.key)));
  if (!parts.length) return [];
  // A narrowing by the names the settings carry, so a busy org's every check run is not read — the decision is
  // still `signalMatchesPart`'s alone, below (a look-alike on another branch or from another App passes this).
  const names = [...new Set(parts.flatMap((p) => [p.settings.environment, p.settings.check_name].filter((v): v is string => !!v)))];
  const paths = [...new Set(parts.map((p) => p.settings.workflow).filter((v): v is string => !!v).map(workflowPath))];
  const or: string[] = [];
  const args: unknown[] = [];
  if (names.length) { or.push(`(kind IN ('deploy', 'check') AND name IN (${names.map(() => "?").join(", ")}))`); args.push(...names); }
  if (paths.length) { or.push(`(kind = 'run' AND json_extract(raw, '$.path') IN (${paths.map(() => "?").join(", ")}))`); args.push(...paths); }
  if (!or.length) return [];
  const since = new Date(now - GITHUB_DEPLOY_HISTORY_DAYS * 86_400_000).toISOString();
  const rows = (await all<RepoEvent & { id: number }>(ctx,
    `SELECT id, semantic_key, kind, ref, sha, number, env, part, state, name, actor_login, title, url, count, raw, provenance, occurred_at
       FROM repo_events WHERE org_id = ? AND env IS NULL AND occurred_at >= ? AND (${or.join(" OR ")})
      ORDER BY occurred_at DESC, id DESC LIMIT ${HISTORY_SIGNAL_MAX}`,
    ctx.orgId, since, ...args)).reverse();
  const out: GithubDeployWrite[] = [];
  for (const part of parts) {
    const byId = new Map<string, CleanDeploy>();
    for (const ev of rows) {
      if (!signalMatchesPart(ev, part)) continue;
      const d = deployFromSignal(ev);
      if (!d) continue;
      const prev = byId.get(d.id);
      byId.delete(d.id); // re-inserted last: the map keeps the order each deploy was LAST heard of
      byId.set(d.id, prev ? fold(prev, d) : d);
    }
    const list = [...byId.values()].slice(-HISTORY_DEPLOYS_PER_PART);
    if (!list.length) continue;
    const changed = new Set(await upsertDeploys(ctx, part, list, now, "github"));
    for (const d of list) if (changed.has(d.id)) out.push({ env: part.env, part: part.key, id: d.id, state: d.state, changed: true });
  }
  return out;
}
