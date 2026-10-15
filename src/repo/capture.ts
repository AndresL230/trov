// PURE: one verified GitHub delivery → the repo events it implies. No DB, no
// clock, no network. Each arm stores a SLICE of the payload in `raw` (enough to
// re-derive the typed columns), never the whole delivery — commit bodies and PR
// descriptions stay out of D1.
import type { RepoEnvConfig } from "./config";
import type { RepoEvent, RepoMetric } from "./types";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === "object" ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const subject = (message: unknown): string => (str(message) ?? "").split("\n")[0].slice(0, 200);

/** A PR's label names, as GitHub lists them (`[{ name }]`), at most 20. */
export const labelNames = (labels: unknown): string[] =>
  (Array.isArray(labels) ? labels : []).map((l) => str(obj(l)?.name)).filter((n): n is string => n !== null).map((n) => n.slice(0, 100)).slice(0, 20);

/** PR actions that change something the dashboard shows (state, head, title). */
const PR_ACTIONS = ["opened", "reopened", "closed", "ready_for_review", "converted_to_draft", "synchronize", "edited"];

function fromPush(p: Obj): RepoEvent[] {
  const ref = str(p.ref);
  if (!ref?.startsWith("refs/heads/") || p.deleted === true) return [];
  const branch = ref.slice("refs/heads/".length);
  const after = str(p.after);
  if (!after) return [];
  const commits = Array.isArray(p.commits) ? p.commits.map(obj).filter((c): c is Obj => c !== null) : [];
  const head = obj(p.head_commit);
  // A push HAPPENED when GitHub says it did (`repository.pushed_at`, unix
  // seconds) — not when its head commit was originally authored. A rebase or
  // cherry-pick carries an old commit timestamp but is pushed just now; using
  // the commit's own timestamp would land it in a stale day bucket.
  const pushedAt = num(obj(p.repository)?.pushed_at);
  // Second-precision, no milliseconds — matches GitHub's own timestamp shape
  // (every other `occurred_at` on this arm comes straight off the payload).
  const at = pushedAt !== null
    ? new Date(pushedAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
    : str(head?.timestamp) ?? str(commits[commits.length - 1]?.timestamp);
  if (!at) return [];
  return [{
    semantic_key: `gh:push:${after}:${branch}`,
    kind: "push", ref: branch, sha: after,
    actor_login: str(obj(p.sender)?.login) ?? str(obj(p.pusher)?.name),
    count: commits.filter((c) => c.distinct === true).length,
    title: subject(head?.message ?? commits[commits.length - 1]?.message),
    url: str(p.compare),
    raw: JSON.stringify({
      before: str(p.before), forced: p.forced === true,
      commits: commits.map((c) => ({ id: str(c.id), distinct: c.distinct === true, subject: subject(c.message), at: str(c.timestamp), author: str(obj(c.author)?.username) })),
    }),
    provenance: "webhook", occurred_at: at,
  }];
}

function fromPullRequest(p: Obj): RepoEvent[] {
  const action = str(p.action);
  const pr = obj(p.pull_request);
  if (!action || !pr || !PR_ACTIONS.includes(action)) return [];
  const number = num(pr.number);
  const at = str(pr.updated_at) ?? str(pr.merged_at) ?? str(pr.closed_at);
  if (number === null || !at) return [];
  const state = pr.merged === true ? "merged" : str(pr.state) === "closed" ? "closed" : pr.draft === true ? "draft" : "review";
  const head = obj(pr.head);
  return [{
    semantic_key: `gh:prs:${number}:${action}:${at}`,
    kind: "pr", number, state, ref: str(head?.ref), sha: str(head?.sha),
    actor_login: str(obj(pr.user)?.login), title: (str(pr.title) ?? "").slice(0, 300), url: str(pr.html_url),
    // `labels` (names, ≤ 20): a release's waiting PR is a feature by a `feature` / `enhancement` label (src/repo/releases.ts).
    raw: JSON.stringify({ action, base: str(obj(pr.base)?.ref), draft: pr.draft === true, labels: labelNames(pr.labels) }),
    provenance: "webhook", occurred_at: at,
  }];
}

/** Every check run, as it is: name, conclusion, details link and — in `raw` — the GitHub App that posted it
 *  (src/hosting/detect.ts reads that). It is never an environment's DEPLOY any more: a host's deploys come
 *  from its provider (`hosting_deploys`), so `env` / `part` stay null. */
function fromCheckRun(p: Obj): RepoEvent[] {
  const action = str(p.action);
  const cr = obj(p.check_run);
  if (!cr || (action !== "created" && action !== "completed")) return [];
  const id = num(cr.id);
  const name = str(cr.name);
  const sha = str(cr.head_sha);
  const at = action === "completed" ? str(cr.completed_at) : str(cr.started_at);
  if (id === null || !name || !sha || !at) return [];
  const ref = str(obj(cr.check_suite)?.head_branch);
  return [{
    semantic_key: `gh:check:${id}:${action}`,
    kind: "check", number: id, sha, ref, name,
    state: action === "completed" ? (str(cr.conclusion) ?? "neutral") : "pending",
    url: str(cr.details_url),
    // `output_title`: a failed check's one-line summary — the failure reason of a `github` part's deploy.
    raw: JSON.stringify({ app: str(obj(cr.app)?.slug), status: str(cr.status), output_title: str(obj(cr.output)?.title)?.split(/\r?\n/)[0].slice(0, 200) ?? null }),
    provenance: "webhook", occurred_at: at,
  }];
}

function fromWorkflowRun(p: Obj): RepoEvent[] {
  const run = obj(p.workflow_run);
  if (!run || str(p.action) !== "completed") return [];
  const id = num(run.id);
  const at = str(run.updated_at);
  if (id === null || !at) return [];
  const attempt = num(run.run_attempt) ?? 1;
  return [{
    semantic_key: `gh:run:${id}:${attempt}`,
    kind: "run", number: id, name: str(run.name), ref: str(run.head_branch), sha: str(run.head_sha),
    state: str(run.conclusion) ?? "neutral", actor_login: str(obj(run.actor)?.login), url: str(run.html_url), count: attempt,
    // `path` (`.github/workflows/<file>.yml`) is what a `github` part's workflow setting names (src/hosting/github-deploys.ts).
    raw: JSON.stringify({ event: str(run.event), started_at: str(run.run_started_at), path: str(run.path) }),
    provenance: "webhook", occurred_at: at,
  }];
}

// ── GitHub deploy signals (repo setups, Phase A) ─────────────────────────────
// A deployment, a deployment status and a commit status other than `canopy/*` are captured UNTAGGED — `env`
// and `part` NULL — as the existing kind `deploy`, `raw.signal` saying which (`deployment` | `status`). They
// say what GitHub saw: who created it (`render[bot]`, `railway-app[bot]`, `vercel[bot]`, `github-actions[bot]`),
// the environment name exactly as the host spells it (`Production – web`, `web / production`, `main - api`), the
// state, the sha, the ref, a description, the log / target link and — for a GitHub Actions deployment — the
// workflow file. They feed src/hosting/detect.ts, the `github` provider's parts (src/hosting/github-deploys.ts,
// ONLY through a matching part setting) and the commit join (src/hosting/sha-join.ts). Kept 90 days
// (`pruneRepoCapture`).

/** A GitHub description: one line, ≤ 200 characters. */
const line200 = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const one = s.split(/\r?\n/)[0].replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return one || null;
};

/** `deployment_status`: one row per (deployment, state). The deployment's own `ref` may be a branch (Render,
 *  Actions) or a sha (Vercel, Railway) — stored as given; the sha is the deployment's `sha`. */
function fromDeploymentStatus(p: Obj): RepoEvent[] {
  const st = obj(p.deployment_status);
  const dep = obj(p.deployment);
  const id = num(dep?.id);
  const state = str(st?.state);
  const at = str(st?.updated_at) ?? str(st?.created_at);
  const environment = str(st?.environment) ?? str(dep?.environment);
  if (!st || !dep || id === null || !state || !at || !environment) return [];
  return [{
    semantic_key: `gh:deploy:${id}:${state}`,
    kind: "deploy", number: id, sha: str(dep.sha), ref: str(dep.ref), state, name: environment.slice(0, 200),
    actor_login: str(obj(dep.creator)?.login), title: line200(st.description), url: str(st.log_url) ?? str(st.target_url),
    raw: JSON.stringify({
      signal: "deployment", environment, environment_url: str(st.environment_url), description: line200(st.description),
      workflow: str(obj(p.workflow)?.path), run_id: num(obj(p.workflow_run)?.id), status_id: num(st.id),
      deployment_created_at: str(dep.created_at), task: str(dep.task),
    }),
    provenance: "webhook", occurred_at: at,
  }];
}

/** `deployment` (created): the deployment before any status — state `created`. */
function fromDeployment(p: Obj): RepoEvent[] {
  const dep = obj(p.deployment);
  if (!dep || str(p.action) !== "created") return [];
  const id = num(dep.id);
  const at = str(dep.created_at);
  const environment = str(dep.environment);
  if (id === null || !at || !environment) return [];
  return [{
    semantic_key: `gh:deploy:${id}:created`,
    kind: "deploy", number: id, sha: str(dep.sha), ref: str(dep.ref), state: "created", name: environment.slice(0, 200),
    actor_login: str(obj(dep.creator)?.login), title: line200(dep.description), url: null,
    raw: JSON.stringify({
      signal: "deployment", environment, environment_url: null, description: line200(dep.description),
      workflow: str(obj(p.workflow)?.path), run_id: num(obj(p.workflow_run)?.id), status_id: null,
      deployment_created_at: at, task: str(dep.task),
    }),
    provenance: "webhook", occurred_at: at,
  }];
}

/** A commit status whose context is NOT `canopy/*` (those are CI metrics — `metricsFromStatus`): `Vercel`,
 *  `netlify/<site>/deploy-preview`, `Render`, a CI's own. One row per status id. GitHub lists up to 10 of the
 *  branches the commit is on (`branches`) — kept in `raw` for the commit join; `ref` stays NULL. */
function fromStatus(p: Obj): RepoEvent[] {
  const context = str(p.context);
  const id = num(p.id);
  const sha = str(p.sha);
  const state = str(p.state);
  const at = str(p.updated_at) ?? str(p.created_at);
  if (!context || context.startsWith("canopy/") || id === null || !sha || !state || !at) return [];
  const branches = (Array.isArray(p.branches) ? p.branches : []).map((b) => str(obj(b)?.name)).filter((b): b is string => b !== null).slice(0, 10);
  return [{
    semantic_key: `gh:status:${id}`,
    kind: "deploy", number: id, sha, ref: null, state, name: context.slice(0, 200),
    actor_login: str(obj(p.sender)?.login), title: line200(p.description), url: str(p.target_url),
    raw: JSON.stringify({ signal: "status", context, description: line200(p.description), branches }),
    provenance: "webhook", occurred_at: at,
  }];
}

function fromReview(p: Obj): RepoEvent[] {
  const action = str(p.action);
  const review = obj(p.review);
  const number = num(obj(p.pull_request)?.number);
  if (!review || number === null || (action !== "submitted" && action !== "dismissed")) return [];
  const id = num(review.id);
  const at = str(review.submitted_at);
  if (id === null || !at) return [];
  return [{
    semantic_key: `gh:review:${id}:${action}`,
    kind: "review", number, state: action === "dismissed" ? "dismissed" : (str(review.state) ?? "commented").toLowerCase(),
    actor_login: str(obj(review.user)?.login), url: str(review.html_url),
    raw: JSON.stringify({ action }), provenance: "webhook", occurred_at: at,
  }];
}

/** The commit-status contexts the target repo's CI posts (see
 *  `docs/superpowers/specs/2026-09-20-sapling-ci-metrics.md`) — one status per
 *  metric, `description` carrying the number. The plausible range lives right
 *  beside the metric so the two read as one table: `repo_metrics` is
 *  append-only and these three metrics are never pruned, so an out-of-range
 *  value (coverage 500, a negative bundle size) is not a display bug, it is a
 *  PERMANENT bad point. `integer` additionally rejects a fractional TODO count. */
interface StatusMetricSpec {
  metric: string;
  min: number;
  max: number;
  integer?: boolean;
}
const STATUS_METRICS: Record<string, StatusMetricSpec> = {
  "canopy/coverage": { metric: "coverage", min: 0, max: 100 },
  "canopy/bundle-kb": { metric: "bundle_kb", min: 0, max: 10_000_000 },
  "canopy/todo": { metric: "todo_count", min: 0, max: 10_000_000, integer: true },
};

/** A strict decimal: digits, an optional `.digits` — no sign, no exponent, no
 *  hex, no percent sign, no empty string. `Number(str(description))` alone
 *  accepted all of those (and `Number(null) === 0`, which is finite — the bug
 *  this guards: an absent description silently stored a metric of 0, forever). */
const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** `null` for anything that is not a valid, in-range reading for this metric. */
function parseMetricValue(raw: string | null, spec: StatusMetricSpec): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!DECIMAL_RE.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (spec.integer && !Number.isInteger(value)) return null;
  if (value < spec.min || value > spec.max) return null;
  return value;
}

export interface StatusMetricOutcome {
  metrics: RepoMetric[];
  /** Set only when the context IS one of the three `canopy/*` names AND the
   *  point was dropped — by the branch filter or by description validation.
   *  `null` for a context this derivation does not report on at all (silent,
   *  no cost — Railway/CodeRabbit statuses arrive constantly) and for a
   *  successfully-captured point. `metricsFromStatus` stays PURE (no DB, no
   *  console) — `src/webhook.ts` is the one that logs this, from this result. */
  dropped: { context: string; reason: string } | null;
}

/** A commit status whose description is a number, posted by the target repo's
 *  CI — a SIBLING derivation to `repoEventsFromDelivery`, not a branch of it:
 *  a `status` delivery produces `RepoMetric`s, never `RepoEvent` rows. Only a
 *  status on the FIRST configured environment's branch counts (today "main";
 *  falls back to "main" when no environment is configured) — a feature
 *  branch's coverage is not the repo's. An unrelated context (Railway's own
 *  deploy statuses, CodeRabbit's review statuses — frequent once the webhook
 *  subscribes to Statuses) is dropped after one cheap map lookup. */
export function metricsFromStatus(payload: unknown, envs: RepoEnvConfig[]): StatusMetricOutcome {
  const none: StatusMetricOutcome = { metrics: [], dropped: null };
  const p = obj(payload);
  if (!p) return none;
  const context = str(p.context) ?? "";
  const spec = STATUS_METRICS[context];
  if (!spec) return none; // not a context we report on — silent, no cost
  // GitHub's own `updated_at` (falling back to `created_at`) — a poster
  // cannot future/back-date a point by claiming an `at` of its own choosing.
  const at = str(p.updated_at) ?? str(p.created_at);
  if (!at) return { metrics: [], dropped: { context, reason: "no timestamp" } };
  // GitHub caps a status payload's `branches[]` at 10: a status for an OLD sha
  // still reachable from many branches can be dropped here even though it IS
  // on the configured branch — and if the cap happens to include it, this
  // records that old value as "now" (the branch list says nothing about
  // recency, only reachability).
  const branch = envs[0]?.branch ?? "main";
  const branches = Array.isArray(p.branches) ? p.branches.map((b) => str(obj(b)?.name)) : [];
  if (!branches.includes(branch)) return { metrics: [], dropped: { context, reason: `not on ${branch}` } };
  const raw = str(p.description);
  const value = parseMetricValue(raw, spec);
  if (value === null) {
    // Never the raw description beyond ~40 chars in a log line.
    return { metrics: [], dropped: { context, reason: `invalid description "${(raw ?? "").slice(0, 40)}"` } };
  }
  return { metrics: [{ metric: spec.metric, env: "", part: "", value, at }], dropped: null };
}

/** One verified delivery → its `repo_events` rows. A deployment / deployment status / non-`canopy/*` commit
 *  status is a GitHub deploy SIGNAL, captured untagged (above) — never matched to an environment here: an
 *  environment's deploys come from its hosting provider (src/hosting/, `hosting_deploys`), or, for a `github`
 *  part, from a signal that matches the part's own setting (src/hosting/github-deploys.ts). */
export function repoEventsFromDelivery(eventName: string, payload: unknown): RepoEvent[] {
  const p = obj(payload);
  if (!p) return [];
  switch (eventName) {
    case "push": return fromPush(p);
    case "pull_request": return fromPullRequest(p);
    case "check_run": return fromCheckRun(p);
    case "workflow_run": return fromWorkflowRun(p);
    case "pull_request_review": return fromReview(p);
    case "deployment_status": return fromDeploymentStatus(p);
    case "deployment": return fromDeployment(p);
    case "status": return fromStatus(p);
    default: return [];
  }
}
