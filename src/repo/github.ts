// Service-token reads of the GitHub API for the repo dashboard. NEVER on the
// render path: called from the webhook handler (event-triggered) and scheduled().
import type { TenantContext } from "../data/sql";
import { fanOut, first, run } from "../data/sql";
import { ingestRepoEvent } from "../consumer";
import { putMetric, putSnapshot } from "./store";
import { untitledFailedRuns } from "./reads";
import type { RepoEnvConfig } from "./config";
import type { RepoEvent } from "./types";
import { metricsFromStatus, repoEventsFromDelivery } from "./capture";
import type { RepoBranches, RepoDrift, RepoDriftGroup } from "@shared/repo";

/** At most this many `.../jobs` lookups per `reconcileRepo` call, so a first
 *  Sync over 100 untitled failed runs cannot fan out into 100 extra API calls.
 *  The backlog drains a slice at a time, over successive Syncs. */
const MAX_JOB_LOOKUPS = 5;
/** How far back the job-title pass looks for an untitled failed run. */
const JOB_LOOKUP_DAYS = 7;

export interface GhOpts { token: string; repo: string; fetchImpl?: typeof fetch }

/** What one `reconcileRepo` reports: the gate's counts, plus the NAME of every
 *  arm whose `safely` block threw — a Sync that silently lost its deployments
 *  looked identical to one that had none. `/admin/backfill` passes this through
 *  as its `repo` object. */
export interface ReconcileResult { written: number; unchanged: number; failed: string[] }

const DAY = 86_400_000;
/** What this module LOGS for a failed GitHub read: the error's MESSAGE with the
 *  service token scrubbed — never the Error object. A thrown fetch, or a
 *  GraphQL `errors` body, may quote the request (and so the `authorization`
 *  header) back, and `ghGraphql` puts that body's message in what it throws.
 *  The result objects never needed this: `failed` holds arm NAMES only. */
export const scrubbedMessage = (e: unknown, token: string): string => {
  const message = e instanceof Error ? e.message : String(e);
  return token ? message.split(token).join("[redacted]") : message;
};
/** Every GitHub read is bounded, like every poller's fetch: an un-timed call
 *  let ONE hung connection hold a reconcile (and the refresh lock, and the
 *  admin's spinner) for as long as the platform allowed. A timeout is a thrown
 *  `TimeoutError`, so it surfaces exactly like any other failed read — in
 *  `reconcileRepo`, as that arm's name in `failed[]`. */
const GH_TIMEOUT_MS = 15_000;
const HEADERS = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "trov-worker" });

export async function ghJson<T>(opts: GhOpts, path: string): Promise<T> {
  const res = await (opts.fetchImpl ?? fetch)(`https://api.github.com/repos/${opts.repo}${path}`, { headers: HEADERS(opts.token), signal: AbortSignal.timeout(GH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`github ${res.status} ${path}`);
  return (await res.json()) as T;
}

/** `ghJson`, where a 404 is an ANSWER (`null`), not a failure — a ref with
 *  nothing posted on it, or one that does not exist yet. Every other non-2xx
 *  still throws. */
export async function ghJsonOrNull<T>(opts: GhOpts, path: string): Promise<T | null> {
  const res = await (opts.fetchImpl ?? fetch)(`https://api.github.com/repos/${opts.repo}${path}`, { headers: HEADERS(opts.token), signal: AbortSignal.timeout(GH_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github ${res.status} ${path}`);
  return (await res.json()) as T;
}

/** The GraphQL sibling of `ghJson`: same auth/user-agent, POSTed to the v4
 *  endpoint. GraphQL answers 200 with an `errors` array on a bad query or a
 *  missing repo, so a non-2xx is NOT the only failure — both throw, and the
 *  caller's `safely` arm turns either into a named entry in `failed`. */
export async function ghGraphql<T>(opts: GhOpts, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await (opts.fetchImpl ?? fetch)(`https://api.github.com/graphql`, {
    method: "POST",
    headers: { ...HEADERS(opts.token), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(GH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`github graphql ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message?: string }[] };
  if (body.errors?.length) throw new Error(`github graphql: ${body.errors.map((e) => e?.message ?? "error").join("; ")}`);
  return (body.data ?? ({} as T)) as T;
}

interface GhPull { number: number; title: string; html_url: string; state: string; draft: boolean; merged_at: string | null; updated_at: string; user: { login: string }; head: { ref: string; sha: string }; base: { ref: string } }
interface GhCommit { sha: string; commit: { message: string; committer: { date: string } }; author: { login: string } | null }

const prEvent = (pr: GhPull): RepoEvent => ({
  semantic_key: `gh:prs:${pr.number}:backfill:${pr.updated_at}`,
  kind: "pr", number: pr.number,
  state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "review",
  ref: pr.head.ref, sha: pr.head.sha, actor_login: pr.user.login, title: pr.title.slice(0, 300), url: pr.html_url,
  raw: JSON.stringify({ action: "backfill", base: pr.base.ref, draft: pr.draft }),
  provenance: "backfill", occurred_at: pr.merged_at ?? pr.updated_at,
});

/** The shape/key scheme `reconcileRepo`'s pre-capture commit backfill has always
 *  used: `gh:push:<sha>:<branch>`, `count: 1`, `provenance: "backfill"`. */
const commitToPushEvent = (c: GhCommit, branch: string): RepoEvent => ({
  semantic_key: `gh:push:${c.sha}:${branch}`, kind: "push", ref: branch, sha: c.sha, actor_login: c.author?.login ?? null,
  count: 1, title: c.commit.message.split("\n")[0].slice(0, 200), raw: JSON.stringify({ backfill: true }),
  provenance: "backfill", occurred_at: c.commit.committer.date,
});

// ── deployments over GraphQL ─────────────────────────────────────────────────
//
// ONE request replaces the old `GET /deployments?per_page=20` plus a
// `/statuses` call per deployment (21 subrequests, most of them spent on
// Railway's PR-preview environments). `environments:` filters server-side to the
// environments this deployment reports on, and `statuses(first:10)` brings each
// deployment's status rows along in the same round trip.
//
// Facts verified live against the target repo: `databaseId` EQUALS the REST /
// webhook `deployment.id`, so `gh:deploy:<id>:<state>` still collides with a
// webhook row (a redelivery overlap drops as `unchanged`); `state` arrives
// UPPERCASE; a Bot creator's `login` arrives WITHOUT the `[bot]` suffix the
// webhook carries; timestamps already have no milliseconds. GraphQL statuses
// have no numeric id, so `raw.status_id` is null.
const DEPLOYMENTS_QUERY = `query($owner:String!,$name:String!,$envs:[String!]){ repository(owner:$owner,name:$name){
  deployments(environments:$envs, first:20, orderBy:{field:CREATED_AT,direction:DESC}){ nodes{
    databaseId commitOid environment createdAt creator{ login __typename }
    statuses(first:10){ nodes{ state createdAt logUrl } } } } } }`;

interface GqlDeployment {
  databaseId?: number | null; commitOid?: string | null; environment?: string | null; createdAt?: string | null;
  creator?: { login?: string | null; __typename?: string | null } | null;
  statuses?: { nodes?: ({ state?: string | null; createdAt?: string | null; logUrl?: string | null } | null)[] | null } | null;
}
interface GqlDeployments { repository?: { deployments?: { nodes?: (GqlDeployment | null)[] | null } | null } | null }

/** The webhook says `railway-app[bot]`; GraphQL says `railway-app` with
 *  `__typename: "Bot"`. Re-suffix so a backfilled row and a webhook row for the
 *  same deploy carry the same actor. */
function creatorLogin(creator: GqlDeployment["creator"]): string | null {
  const login = typeof creator?.login === "string" && creator.login ? creator.login : null;
  if (!login) return null;
  return creator?.__typename === "Bot" && !login.endsWith("[bot]") ? `${login}[bot]` : login;
}

// ── PR reviews over GraphQL ──────────────────────────────────────────────────
//
// `pull_request_review` used to be WEBHOOK-ONLY, so the contributors' `R` and a
// PR's APPROVED state could not be backfilled or polled. ONE request: the 30
// most recently updated open PRs, each with its last 10 reviews. Every review
// is re-wrapped into the WEBHOOK's `pull_request_review` payload and put
// through the unchanged `fromReview` (src/repo/capture.ts) — one derivation, so
// the key is the webhook's own: `gh:review:<id>:<action>`.
//
// Key parity, verified live against the target repo (PR #658, 2026-09-21, the
// same two reviews read over GraphQL and over REST `/pulls/658/reviews`):
// `databaseId` EQUALS the REST / webhook `review.id`; `submittedAt` is the same
// string as `submitted_at`; `url` is the same string as `html_url`; `state`
// arrives UPPERCASE (`fromReview` lower-cases it; done here too, so the payload
// is the webhook's shape); a Bot author's `login` arrives WITHOUT the `[bot]`
// suffix (`github-code-quality` vs `github-code-quality[bot]`) and is
// re-suffixed by `creatorLogin`, exactly as the deployments arm does.
//
// A DISMISSED review is wrapped as the webhook's `dismissed` action (key
// `…:dismissed`, the same row the dismissal delivery writes) and NOT also as a
// `submitted` one: GraphQL no longer says what the review's state was when it
// was submitted, and a guessed state would shadow the real webhook row forever
// (first write wins). PENDING reviews (never submitted) and reviews with no
// author or no `submittedAt` are skipped.
const REVIEWS_QUERY = `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){
  pullRequests(states:OPEN, first:30, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{
    number reviews(last:10){ nodes{ databaseId state submittedAt url author{ login __typename } } } } } } }`;

interface GqlReview {
  databaseId?: number | null; state?: string | null; submittedAt?: string | null; url?: string | null;
  author?: { login?: string | null; __typename?: string | null } | null;
}
interface GqlReviews { repository?: { pullRequests?: { nodes?: ({ number?: number | null; reviews?: { nodes?: (GqlReview | null)[] | null } | null } | null)[] | null } | null } | null }

/** One GraphQL review as the webhook's `pull_request_review` payload, or null when it is not a submitted review. */
function reviewDelivery(number: number, r: GqlReview): Record<string, unknown> | null {
  const login = creatorLogin(r.author);
  const state = typeof r.state === "string" ? r.state.toLowerCase() : "";
  if (typeof r.databaseId !== "number" || !login || !r.submittedAt || !state || state === "pending") return null;
  return {
    action: state === "dismissed" ? "dismissed" : "submitted",
    review: { id: r.databaseId, state, submitted_at: r.submittedAt, html_url: r.url ?? null, user: { login } },
    pull_request: { number },
  };
}

/** The commit-status list item (`GET /commits/<ref>/statuses`). It has no `sha`
 *  and no `branches` — the webhook's `status` payload does, so the arm adds them. */
interface GhStatus { context?: string; description?: string | null; state?: string; created_at?: string; updated_at?: string }
/** At most this many statuses per context from one poll — they are distinct
 *  points in time (a status is immutable; a re-run posts a NEW one), newest first. */
const MAX_STATUSES_PER_CONTEXT = 10;

/**
 * The backfill AND the self-heal — the same function from an admin's Sync
 * GitHub, the cron's 6-hourly `:20` tick and the admin's "Poll now". Every arm
 * is its own `safely` block, named in `failed` when it throws.
 *
 * Worst case **19 + 2N outbound requests** for N environments (23 for today's
 * two): 2 PR lists + 1 pre-capture commit window + 1 GraphQL deployments + 1
 * workflow-run list + ≤5 job lookups + 1 commit-status list + 1 GraphQL reviews
 * + ≤5 GraphQL branch pages + ≤2 drift compares + 2 per environment (head
 * commit, head checks). The callers' budgets (src/repo/cron.ts) build on this
 * number: the `:20` tick is 19 + 4N with its pings, "Poll now" 19 + 7N.
 */
export async function reconcileRepo(ctx: TenantContext, opts: GhOpts, envs: RepoEnvConfig[], now: number = Date.now()): Promise<ReconcileResult> {
  const out: ReconcileResult = { written: 0, unchanged: 0, failed: [] };
  /** Every event goes through the SAME gate the webhook uses; a redelivery or a
   *  backfill overlap drops as `unchanged` on the UNIQUE semantic key. */
  const take = async (events: RepoEvent[]): Promise<void> => {
    for (const ev of events) {
      const res = await ingestRepoEvent(ctx, ev);
      if (res.outcome === "written") out.written++; else out.unchanged++;
    }
  };
  // Each arm is independent: one failing must not starve the others. The arm's
  // NAME lands in `failed` so a caller can tell "no deployments" from "the
  // deployments read blew up" (each name appears at most once).
  const safely = async (arm: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) {
      console.error("reconcileRepo", arm, scrubbedMessage(e, opts.token));
      if (!out.failed.includes(arm)) out.failed.push(arm);
    }
  };

  // The completeness marker: written only after the OPEN-PR list has been both
  // fetched AND ingested without throwing. `prCaptured` in src/tools/repo.ts
  // gates on THIS snapshot, not on "any pr row exists" — a lone webhook
  // delivery (the first `pull_request` after deploy) must not make the
  // Overview claim a complete open-PR count. A marker (not `provenance =
  // 'backfill'`) because a repo with zero open PRs would otherwise never earn
  // one.
  await safely("open_prs", async () => {
    const openPrs = await ghJson<GhPull[]>(opts, `/pulls?state=open&sort=updated&direction=desc&per_page=100`);
    await take(openPrs.map(prEvent));
    await putSnapshot(ctx, "prs_reconciled", { at: new Date(now).toISOString() }, new Date(now).toISOString());
  });
  await safely("closed_prs", async () => { await take((await ghJson<GhPull[]>(opts, `/pulls?state=closed&sort=updated&direction=desc&per_page=50`)).map(prEvent)); });

  // Commits on the default environment branch, ONLY for the stretch before push
  // capture began — a backfilled commit is a count-1 push, and overlapping a real
  // push (count N, same head sha) would shadow it. This fills ONLY the
  // pre-capture stretch: it cannot and does not recover a push missed AFTER
  // capture began (a gap from a webhook outage, say) — that stays lost.
  await safely("commits", async () => {
    const branch = envs[0]?.branch ?? "main";
    const earliest = await first<{ at: string }>(ctx, `SELECT MIN(occurred_at) AS at FROM repo_events WHERE org_id = ? AND kind = 'push' AND provenance = 'webhook'`, ctx.orgId);
    const since = new Date(now - 14 * DAY).toISOString();
    const until = earliest?.at ?? new Date(now).toISOString();
    if (until <= since) return;
    const commits = await ghJson<GhCommit[]>(opts, `/commits?sha=${encodeURIComponent(branch)}&since=${since}&until=${until}&per_page=100`);
    await take(commits.map((c) => commitToPushEvent(c, branch)));
  });

  const asBackfill = (events: RepoEvent[]): RepoEvent[] => events.map((e) => ({ ...e, provenance: "backfill" as const }));

  // Deployments: ONE GraphQL request, filtered to the configured environments
  // (see DEPLOYMENTS_QUERY above). Each status is re-wrapped into the webhook's
  // own `deployment_status` payload shape and put through the SAME pure arm, so
  // there is one derivation of a deploy row, not two.
  if (envs.length) await safely("deployments", async () => {
    const [owner, name] = opts.repo.split("/");
    const data = await ghGraphql<GqlDeployments>(opts, DEPLOYMENTS_QUERY, { owner, name, envs: envs.map((e) => e.railwayEnv) });
    const nodes = data?.repository?.deployments?.nodes;
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node || typeof node.databaseId !== "number") continue;
      const deployment = {
        id: node.databaseId, sha: node.commitOid ?? null, ref: null, environment: node.environment ?? null,
        created_at: node.createdAt ?? null, creator: { login: creatorLogin(node.creator) },
      };
      const statuses = node.statuses?.nodes;
      for (const st of Array.isArray(statuses) ? statuses : []) {
        if (!st || typeof st.state !== "string") continue;
        // `id: null` — a GraphQL status carries no numeric id. Never invented.
        const deployment_status = { id: null, state: st.state.toLowerCase(), created_at: st.createdAt ?? null, log_url: st.logUrl ?? null };
        await take(asBackfill(repoEventsFromDelivery("deployment_status", { deployment_status, deployment }, envs)));
      }
    }
  });

  // Completed workflow runs.
  await safely("runs", async () => {
    const { workflow_runs = [] } = await ghJson<{ workflow_runs?: Record<string, unknown>[] }>(opts, `/actions/runs?status=completed&per_page=100`);
    for (const workflow_run of workflow_runs) {
      await take(asBackfill(repoEventsFromDelivery("workflow_run", { action: "completed", workflow_run }, envs)));
    }
  });

  // The failing-job label a live webhook delivery gets (src/webhook.ts), applied
  // to the BACKLOG rather than to whatever this Sync happened to write: the
  // newest untitled failure/timed_out runs of the last week, capped at
  // MAX_JOB_LOOKUPS. A first Sync's leftovers therefore drain over later Syncs
  // instead of staying nameless forever. `fillFailedJob` never throws.
  await safely("job_titles", async () => {
    const backlog = await untitledFailedRuns(ctx, new Date(now - JOB_LOOKUP_DAYS * DAY).toISOString(), MAX_JOB_LOOKUPS);
    for (const r of backlog) await fillFailedJob(ctx, opts, r.number, r.semantic_key);
  });

  // Each configured environment branch's HEAD, as ONE `env_heads` snapshot
  // (`{ [branch]: sha }`). Deliberately NOT a synthetic push row any more: a
  // Sync landing between a real push and its webhook delivery would write the
  // count-1 row first and the real count-N push would then drop as `unchanged`,
  // permanently under-counting commits and losing the push from the feed; and
  // every Sync that saw a new head added a phantom commit to the totals.
  // `branchHeads` (src/repo/reads.ts) prefers this snapshot over a captured
  // push only when the snapshot is the NEWER of the two.
  const heads = new Map<string, string>();
  for (const cfg of envs) {
    await safely("env_heads", async () => {
      const commits = await ghJson<GhCommit[]>(opts, `/commits?sha=${encodeURIComponent(cfg.branch)}&per_page=1`);
      if (commits[0]?.sha) heads.set(cfg.branch, commits[0].sha);
    });
  }
  // Only what this reconcile actually observed: a branch whose fetch failed is
  // dropped rather than carried forward under a fresh `computed_at` (which would
  // let a stale sha outrank a newer captured push).
  if (heads.size) await safely("env_heads", () => putSnapshot(ctx, "env_heads", Object.fromEntries(heads), new Date(now).toISOString()));

  // Each environment head's check runs (also the frontend deploy record: a
  // Workers Builds check IS a deploy, but only on the branch that environment
  // ships from). Independent per environment so one branch's failure never
  // starves another's.
  for (const cfg of envs) {
    await safely("checks", async () => {
      const { check_runs = [] } = await ghJson<{ check_runs?: Record<string, unknown>[] }>(opts, `/commits/${encodeURIComponent(cfg.branch)}/check-runs?per_page=100`);
      for (const cr of check_runs) {
        if (cr.status !== "completed") continue;
        // The list item may omit check_suite.head_branch. Do NOT blindly inject
        // the branch we asked for: when two configured branches share a HEAD,
        // both environments' Workers Builds checks come back on the first branch
        // asked, and tagging the other one with this branch leaves it untagged
        // forever (the correctly-tagged row later drops as `unchanged`). The
        // owner is the config whose workerCheck matches the run's NAME and whose
        // head is the run's head sha; absent that, the branch we asked for.
        const owner = envs.find((e) => e.workerCheck === cr.name && heads.get(e.branch) === cr.head_sha);
        const check_run = { ...cr, check_suite: { head_branch: owner?.branch ?? cfg.branch } };
        await take(asBackfill(repoEventsFromDelivery("check_run", { action: "completed", check_run }, envs)));
      }
    });
  }

  // Coverage / bundle size / TODO count: the `canopy/*` commit statuses the
  // target repo's CI posts. They used to arrive ONLY as `status` webhook
  // deliveries, so a repo whose hook does not subscribe to Statuses — or an
  // admin pressing "Poll now" — never saw them. ONE request: the statuses on the
  // HEAD of the first environment's branch (the sha the env_heads arm just read;
  // the branch name when that failed, and "main" with no environment — the same
  // fallback `metricsFromStatus` applies). Each is rebuilt as the webhook's own
  // `status` payload and put through the UNCHANGED `metricsFromStatus` →
  // `putMetric`: one derivation, one validator, and the same `at` — the
  // status's `updated_at` (else `created_at`), which `putMetric` normalises —
  // so a polled point and a webhook-delivered one for the same status collide
  // on `(metric, env, part, at)`. A 404 or an empty list is not a failure.
  // HEAD ONLY, on purpose: a status posted on a commit that was superseded
  // before this reconcile is the webhook's to capture or nobody's — older
  // commits would cost a request each, and this arm's budget is one.
  await safely("statuses", async () => {
    const branch = envs[0]?.branch ?? "main";
    const ref = heads.get(branch) ?? branch;
    const list = await ghJsonOrNull<GhStatus[]>(opts, `/commits/${encodeURIComponent(ref)}/statuses?per_page=100`);
    const seen = new Map<string, number>();
    for (const st of Array.isArray(list) ? list : []) {
      const context = typeof st?.context === "string" ? st.context : "";
      if (!context.startsWith("canopy/")) continue;
      const n = (seen.get(context) ?? 0) + 1;
      seen.set(context, n);
      if (n > MAX_STATUSES_PER_CONTEXT) continue; // newest first — the cap keeps the newest
      const outcome = metricsFromStatus({
        context, description: st.description ?? null, state: st.state ?? null,
        created_at: st.created_at ?? null, updated_at: st.updated_at ?? null,
        sha: heads.get(branch) ?? null, branches: [{ name: branch }],
      }, envs);
      if (outcome.dropped) console.warn("reconcileRepo: dropped status", outcome.dropped.context, "-", outcome.dropped.reason);
      for (const m of outcome.metrics) {
        if (await putMetric(ctx, m)) out.written++; else out.unchanged++;
      }
    }
  });

  // PR reviews (see REVIEWS_QUERY above): ONE GraphQL request, each review put
  // back through the webhook's own `pull_request_review` derivation so its
  // semantic key is the webhook row's.
  await safely("reviews", async () => {
    const [owner, name] = opts.repo.split("/");
    const data = await ghGraphql<GqlReviews>(opts, REVIEWS_QUERY, { owner, name });
    const prs = data?.repository?.pullRequests?.nodes;
    for (const pr of Array.isArray(prs) ? prs : []) {
      if (!pr || typeof pr.number !== "number") continue;
      const reviews = pr.reviews?.nodes;
      for (const r of Array.isArray(reviews) ? reviews : []) {
        const delivery = r ? reviewDelivery(pr.number, r) : null;
        if (delivery) await take(asBackfill(repoEventsFromDelivery("pull_request_review", delivery, envs)));
      }
    }
  });

  // Branches: every ref, ahead/behind `main` (envs[0]?.branch ?? "main" —
  // same fallback the `commits` arm above uses) and flagged stale, in ONE
  // GraphQL page (see computeBranches below). Runs UNCONDITIONALLY — unlike
  // `deployments`, which genuinely cannot filter without environment names,
  // computeBranches degrades correctly with envs: [] (empty exclusion set,
  // "main" as head), so a repo with no REPO_ENVIRONMENTS configured still
  // gets a branches list instead of losing it for no structural reason.
  await safely("branches", () => computeBranches(ctx, opts, envs, now));

  // Branch drift (`<base>...<head>`, e.g. `production...main`), so the
  // Overview strip has data even before any push webhook lands on an
  // environment branch. `computeDrift` (below) THROWS on failure — this arm
  // calls it directly, not the never-throwing `refreshDrift` wrapper, so a
  // failing compare lands in `failed` instead of vanishing into a swallowed
  // catch (Task 11 carry-over fix: it used to be invisible here).
  await safely("drift", () => computeDrift(ctx, opts, envs));

  return out;
}

interface GhJobs { jobs: { name: string; conclusion: string | null; steps?: { name: string; conclusion: string | null }[] }[] }

/** Enrichment, not capture: the run row already landed. A failure here costs a label, nothing else. */
export async function fillFailedJob(ctx: TenantContext, opts: GhOpts, runId: number, semanticKey: string): Promise<void> {
  try {
    const { jobs } = await ghJson<GhJobs>(opts, `/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
    const job = jobs.find((j) => j.conclusion === "failure" || j.conclusion === "timed_out");
    if (!job) return;
    const step = job.steps?.find((s) => s.conclusion === "failure")?.name;
    await run(ctx, `UPDATE repo_events SET title = ? WHERE org_id = ? AND semantic_key = ?`, step ? `${job.name} · ${step}` : job.name, ctx.orgId, semanticKey);
  } catch (e) {
    console.error("fillFailedJob", runId, scrubbedMessage(e, opts.token));
  }
}

interface GhCompare { ahead_by: number; behind_by: number; commits: GhCommit[] }
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Computes and stores the drift snapshot — `envs[0]` is the head (deploys "up
 * front", e.g. `main`), `envs[last]` the base (e.g. `production`) — grouped by
 * the PR that brought each ahead commit. THROWS on any GitHub/D1 failure; the
 * never-throwing `refreshDrift` wrapper below is what callers outside
 * `reconcileRepo`'s `safely` arm should use.
 */
async function computeDrift(ctx: TenantContext, opts: GhOpts, envs: RepoEnvConfig[]): Promise<void> {
  if (envs.length < 2) return;
  const head = envs[0].branch;
  const base = envs[envs.length - 1].branch;
  if (head === base) return;
  // GitHub's compare only returns the AHEAD side's commits, so the behind
  // side (base has commits head lacks) needs its own, second compare.
  const ahead = await ghJson<GhCompare>(opts, `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  const behind = ahead.behind_by > 0 ? await ghJson<GhCompare>(opts, `/compare/${encodeURIComponent(head)}...${encodeURIComponent(base)}`) : null;

  const toCommit = (c: GhCommit) => ({ sha: c.sha.slice(0, 7), msg: c.commit.message.split("\n")[0].slice(0, 160), at: c.commit.committer.date });
  const newestFirst = <T extends { at: string }>(rows: T[]) => rows.sort((a, b) => (a.at < b.at ? 1 : -1));

  // A squash merge ends "(#123)" — the repo's merge style. Anything else is a direct push.
  const byPr = new Map<number, GhCommit[]>();
  const direct: GhCommit[] = [];
  for (const c of ahead.commits) {
    const m = c.commit.message.split("\n")[0].match(/\(#(\d+)\)\s*$/);
    if (m) byPr.set(Number(m[1]), [...(byPr.get(Number(m[1])) ?? []), c]);
    else direct.push(c);
  }
  // GitHub's compare returns up to 250 commits, so this id list can far exceed
  // D1's 100-BOUND-PARAMETER ceiling — past it the statement throws `too many
  // SQL variables` and the whole drift snapshot is lost. Fan out in chunks like
  // every sibling id-list read (src/db.ts).
  const numbers = [...byPr.keys()];
  const titles = await fanOut<{ number: number; title: string | null; actor_login: string | null }>(
    ctx, numbers,
    (p) => `SELECT number, MAX(title) AS title, MAX(actor_login) AS actor_login FROM repo_events WHERE org_id = ? AND kind = 'pr' AND number IN (${p}) GROUP BY number`,
    [ctx.orgId]
  );

  const groups: RepoDriftGroup[] = [];
  for (const [number, commits] of [...byPr.entries()].sort((a, b) => b[0] - a[0])) {
    const known = titles.find((t) => t.number === number);
    groups.push({
      tag: `#${number}`, kind: "pr", title: known?.title ?? commits[0].commit.message.split("\n")[0],
      meta: `${known?.actor_login ?? commits[0].author?.login ?? "unknown"} · ${plural(commits.length, "commit")}`,
      commits: newestFirst(commits.map(toCommit)),
    });
  }
  if (direct.length) {
    groups.push({ tag: "PUSH", kind: "push", title: `Direct pushes to ${head}`, meta: plural(direct.length, "commit"), commits: newestFirst(direct.map(toCommit)) });
  }
  if (behind?.commits.length) {
    groups.push({ tag: "BEHIND", kind: "behind", title: `Only on ${base} — not yet on ${head}`, meta: plural(behind.commits.length, "commit"), commits: newestFirst(behind.commits.map(toCommit)) });
  }

  // `ahead`/`behind` are GitHub's own TOTALS, while `groups` is built from the
  // commits the compare actually returned — and that list is capped at 250. On
  // a bigger divergence the strip's header stays TRUTHFUL ("main is 612 commits
  // ahead") while the expanded breakdown below it covers only the newest 250:
  // partial, never wrong. Deliberately not reconciled into a smaller header,
  // which would under-report the real gap; and no DTO change, because nothing
  // on screen claims the breakdown is exhaustive.
  const drift: RepoDrift = { head, base, ahead: ahead.ahead_by, behind: ahead.behind_by, groups };
  await putSnapshot(ctx, "drift", drift);
}

/**
 * Snapshot the drift between the two environment branches. NEVER on the
 * render path: called off a push to either branch (`src/webhook.ts`) and,
 * later, from `reconcileRepo` via the throwing `computeDrift` directly (see
 * above). Never throws — GitHub failing leaves the previous snapshot (if any)
 * standing.
 */
export async function refreshDrift(ctx: TenantContext, opts: GhOpts, envs: RepoEnvConfig[]): Promise<void> {
  try {
    await computeDrift(ctx, opts, envs);
  } catch (e) {
    console.error("refreshDrift", scrubbedMessage(e, opts.token)); // the last good snapshot stands
  }
}

// ── branches over GraphQL ────────────────────────────────────────────────────
//
// `refs(refPrefix:"refs/heads/")` with `compare(headRef:$head)` per ref answers
// the whole branch list (ahead/behind main, last commit) in one page for up to
// 100 branches — REST would need one `/compare` request PER branch (74 on the
// target repo). No `orderBy` clause: `TAG_COMMIT_DATE` orders TAGS, not refs by
// commit date (verified live) — order is decided client-side below instead.
//
// GraphQL gotcha, verified live against the target repo: `Ref.compare` treats
// THE BRANCH as base and `$head` (main) as head, so `aheadBy` = commits on
// main the branch lacks (i.e. the branch is BEHIND by that many) and
// `behindBy` = commits only on the branch (the branch is AHEAD by that many).
// Inverted below on purpose.
const REFS_QUERY = `query($owner:String!,$name:String!,$head:String!,$after:String){
  repository(owner:$owner,name:$name){ refs(refPrefix:"refs/heads/",first:100,after:$after){
    pageInfo{hasNextPage endCursor}
    nodes{ name target{ ... on Commit { committedDate } } compare(headRef:$head){ aheadBy behindBy } } } } }`;

interface RefNode { name: string; target: { committedDate?: string | null } | null; compare: { aheadBy: number; behindBy: number } | null }
interface GqlRefs { repository?: { refs?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (RefNode | null)[] } | null } | null }

const STALE_DAYS = 14;
/** How many rows the snapshot keeps: the live branches first, then a handful
 *  of the stalest-but-unmerged (`ahead > 0`) ones — the ones worth deleting. A
 *  fully-merged stale branch (`ahead: 0`) is not worth a row; it is just gone. */
const BRANCH_ROWS = 8;
/** Pages of 100 refs the branches query will walk before giving up (below). */
const BRANCH_PAGES = 5;

/** Computes and stores the branches snapshot. THROWS on any GitHub failure;
 *  the never-throwing `refreshBranches` wrapper below is what
 *  `reconcileRepo`'s outside callers (the webhook, later the cron) should use. */
async function computeBranches(ctx: TenantContext, opts: GhOpts, envs: RepoEnvConfig[], now: number): Promise<void> {
  const [owner, name] = opts.repo.split("/");
  const head = envs[0]?.branch ?? "main";
  const skip = new Set(envs.map((e) => e.branch));
  const nodes: RefNode[] = [];
  let after: string | null = null;
  let truncated = false;
  for (let page = 0; page < BRANCH_PAGES; page++) { // 500 branches is a ceiling, not a target
    const resp: GqlRefs = await ghGraphql<GqlRefs>(opts, REFS_QUERY, { owner, name, head, after });
    const refs = resp?.repository?.refs;
    if (!refs) throw new Error("graphql: no refs");
    nodes.push(...refs.nodes.filter((n): n is RefNode => n !== null));
    truncated = refs.pageInfo.hasNextPage;
    if (!truncated) break;
    after = refs.pageInfo.endCursor;
  }
  // Past the ceiling the counts and the "stalest branches" pick would describe
  // an arbitrary 500-branch prefix while READING as the whole repo. Throw: the
  // arm lands in reconcileRepo's `failed[]` and the last good snapshot stands,
  // which is the same contract every other failure here has.
  if (truncated) throw new Error(`graphql: more than ${BRANCH_PAGES * 100} branches — refs list truncated`);
  const cutoff = new Date(now - STALE_DAYS * DAY).toISOString();
  const rows = nodes
    .filter((n) => !skip.has(n.name) && n.target?.committedDate)
    .map((n) => ({
      name: n.name,
      at: n.target!.committedDate!,
      // Inverted on purpose — see the GraphQL gotcha comment above.
      ahead: n.compare?.behindBy ?? 0,
      behind: n.compare?.aheadBy ?? 0,
      stale: n.target!.committedDate! < cutoff,
    }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  const stale = rows.filter((r) => r.stale);
  const fresh = rows.filter((r) => !r.stale);
  // `stale` (like `rows`) is newest-first, so `.slice(0, 3)` would pick the
  // three LEAST stale — the opposite of "worth deleting". Take the tail (the
  // three OLDEST stale-and-unmerged branches) and reverse it so the single
  // most-overdue branch leads the trailing group.
  const worthDeleting = stale.filter((r) => r.ahead > 0).slice(-3).reverse();
  // Reserve by what is actually APPENDED, not by how many stale branches exist:
  // a repo whose stale branches are all merged (`ahead: 0`) appends none of
  // them, and reserving for them under-filled the list for nothing.
  const shown = [...fresh.slice(0, BRANCH_ROWS - worthDeleting.length), ...worthDeleting];
  // `head` travels with the counts it qualifies: the screen says "vs <head>".
  const data: RepoBranches = { active: fresh.length, stale: stale.length, head, rows: shown };
  await putSnapshot(ctx, "branches", data);
}

/** Never throws — GitHub failing leaves the previous snapshot (if any) standing. */
export async function refreshBranches(ctx: TenantContext, opts: GhOpts, envs: RepoEnvConfig[], now: number = Date.now()): Promise<void> {
  try {
    await computeBranches(ctx, opts, envs, now);
  } catch (e) {
    console.error("refreshBranches", scrubbedMessage(e, opts.token)); // the last good snapshot stands
  }
}
