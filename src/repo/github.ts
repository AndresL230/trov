// Service-token reads of the GitHub API for the repo dashboard. NEVER on the
// render path: called from the webhook handler (event-triggered) and scheduled().
import type { TenantContext } from "../data/sql";
import { fanOut, first, run } from "../data/sql";
import { ingestRepoEvent } from "../consumer";
import { putMetric, putSnapshot } from "./store";
import { untitledFailedRuns } from "./reads";
import type { RepoEnvConfig } from "./config";
import type { RepoEvent } from "./types";
import { labelNames, metricsFromStatus, repoEventsFromDelivery } from "./capture";
import { reconcileReleases, RELEASES_RECONCILE_COST } from "./releases";
import { ghGraphql, ghJson, ghJsonOrNull, scrubbedMessage, type GhOpts } from "./gh-http";
import { FACTS_COMPARE_CAP, computeDriftChain, computeNotShipped, computeOutOfStep, driftCompares, factsBudget } from "./facts-compute";
import { PR_FILES_REQUESTS, reconcilePrFiles } from "./pr-files";

// The GitHub HTTP helpers live in ./gh-http.ts (so the facts arms, ./facts-compute.ts, can use them without an
// import cycle); re-exported here for every existing caller.
export { ghGraphql, ghJson, ghJsonOrNull, scrubbedMessage, type GhOpts } from "./gh-http";
import { scanRepo, type ScanOpts } from "./scan";
import type { RepoBranches, RepoDrift, RepoDriftGroup } from "@shared/repo";

/** At most this many `.../jobs` lookups per `reconcileRepo` call, so a first
 *  Sync over 100 untitled failed runs cannot fan out into 100 extra API calls.
 *  The backlog drains a slice at a time, over successive Syncs. */
const MAX_JOB_LOOKUPS = 5;
/** How far back the job-title pass looks for an untitled failed run. */
const JOB_LOOKUP_DAYS = 7;


/** What one `reconcileRepo` reports: the gate's counts, plus the NAME of every
 *  arm whose `safely` block threw — a Sync that silently lost its workflow runs
 *  looked identical to one that had none. `/admin/backfill` passes this through
 *  as its `repo` object. */
export interface ReconcileResult { written: number; unchanged: number; failed: string[] }

const DAY = 86_400_000;
interface GhPull { number: number; title: string; html_url: string; state: string; draft: boolean; merged_at: string | null; updated_at: string; user: { login: string }; head: { ref: string; sha: string }; base: { ref: string }; labels?: { name?: string }[] }
interface GhCommit { sha: string; commit: { message: string; committer: { date: string } }; author: { login: string } | null }

const prEvent = (pr: GhPull): RepoEvent => ({
  semantic_key: `gh:prs:${pr.number}:backfill:${pr.updated_at}`,
  kind: "pr", number: pr.number,
  state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "review",
  ref: pr.head.ref, sha: pr.head.sha, actor_login: pr.user.login, title: pr.title.slice(0, 300), url: pr.html_url,
  raw: JSON.stringify({ action: "backfill", base: pr.base.ref, draft: pr.draft, labels: labelNames(pr.labels) }),
  provenance: "backfill", occurred_at: pr.merged_at ?? pr.updated_at,
});

/** The shape/key scheme `reconcileRepo`'s pre-capture commit backfill has always
 *  used: `gh:push:<sha>:<branch>`, `count: 1`, `provenance: "backfill"`. */
const commitToPushEvent = (c: GhCommit, branch: string): RepoEvent => ({
  semantic_key: `gh:push:${c.sha}:${branch}`, kind: "push", ref: branch, sha: c.sha, actor_login: c.author?.login ?? null,
  count: 1, title: c.commit.message.split("\n")[0].slice(0, 200), raw: JSON.stringify({ backfill: true }),
  provenance: "backfill", occurred_at: c.commit.committer.date,
});

/** The webhook says `github-code-quality[bot]`; GraphQL says `github-code-quality` with
 *  `__typename: "Bot"`. Re-suffix so a backfilled row and a webhook row for the
 *  same review carry the same actor. */
function creatorLogin(creator: { login?: string | null; __typename?: string | null } | null | undefined): string | null {
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
// re-suffixed by `creatorLogin`.
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
 * Worst case **`reconcileRequests(N)`** outbound requests for N environments
 * (39 for two): 2 PR lists + 1 pre-capture commit window + 1 workflow-run list +
 * ≤5 job lookups + 1 commit-status list + 1 GraphQL reviews + ≤5 GraphQL branch
 * pages + 2 per environment (head commit, head checks) — 16 + 2N — plus the
 * promotion chain's compares (`driftCompares(N)` = max(2, N): N − 1 steps and the
 * last step's behind side; it replaced the old ≤ 2 first↔last compares) and the
 * facts arms' shared `FACTS_COMPARE_CAP` (6: not shipped + out of step,
 * ./facts-compute.ts), and the `releases` arm's `RELEASES_RECONCILE_COST` (2: the releases list, the tags
 * query, src/repo/releases.ts), and the `pr_files` arm's `PR_FILES_REQUESTS` (9: three PRs' 3 pages,
 * src/repo/pr-files.ts — the cron and Sync GitHub widen it, `ReconcileLimits`). GitHub deployments are not read: an environment's deploys
 * come from its hosting provider (src/hosting/). The callers' budgets
 * (src/repo/cron.ts) build on this number. With `scan` (the cron's and Sync's reconcile, not Poll now),
 * + `SCAN_COST` (src/repo/scan.ts).
 */
export const reconcileRequests = (n: number): number => 16 + 2 * n + driftCompares(n) + FACTS_COMPARE_CAP + RELEASES_RECONCILE_COST + PR_FILES_REQUESTS;

/** What a caller may widen beyond Poll now's bound. */
export interface ReconcileLimits {
  /** The `pr_files` arm's request allowance (src/repo/pr-files.ts): `PR_FILES_REQUESTS` (counted in
   *  `reconcileRequests`) unless the caller's budget says more — the cron and Sync GitHub pass `PR_FILES_SYNC_REQUESTS`. */
  prFiles?: number;
}

export async function reconcileRepo(ctx: TenantContext, opts: GhOpts, envs: RepoEnvConfig[], now: number = Date.now(), scan?: ScanOpts, limits: ReconcileLimits = {}): Promise<ReconcileResult> {
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
  // NAME lands in `failed` so a caller can tell "no workflow runs" from "the
  // runs read blew up" (each name appears at most once).
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

  // Completed workflow runs.
  await safely("runs", async () => {
    const { workflow_runs = [] } = await ghJson<{ workflow_runs?: Record<string, unknown>[] }>(opts, `/actions/runs?status=completed&per_page=100`);
    for (const workflow_run of workflow_runs) {
      await take(asBackfill(repoEventsFromDelivery("workflow_run", { action: "completed", workflow_run })));
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

  // Each environment head's check runs. Independent per environment so one
  // branch's failure never starves another's. The list item may omit
  // check_suite.head_branch, so the branch we asked for stands in (when two
  // configured branches share a HEAD, the first one asked wins — the key is the
  // check run's own id, first write wins).
  for (const cfg of envs) {
    await safely("checks", async () => {
      const { check_runs = [] } = await ghJson<{ check_runs?: Record<string, unknown>[] }>(opts, `/commits/${encodeURIComponent(cfg.branch)}/check-runs?per_page=100`);
      for (const cr of check_runs) {
        if (cr.status !== "completed") continue;
        const check_run = { ...cr, check_suite: { head_branch: cfg.branch } };
        await take(asBackfill(repoEventsFromDelivery("check_run", { action: "completed", check_run })));
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
        if (delivery) await take(asBackfill(repoEventsFromDelivery("pull_request_review", delivery)));
      }
    }
  });

  // Branches: every ref, ahead/behind `main` (envs[0]?.branch ?? "main" —
  // same fallback the `commits` arm above uses) and flagged stale, in ONE
  // GraphQL page (see computeBranches below). Runs UNCONDITIONALLY —
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

  // The Overview's facts (./facts-compute.ts): what each part's branch has that it does not serve, and which
  // apps of an environment run an older commit than the others. Both incremental and sharing one bound
  // (`FACTS_COMPARE_CAP` compares); each stores what it computed before it throws.
  const budget = factsBudget();
  await safely("not_shipped", () => computeNotShipped(ctx, opts, envs, budget, now));
  await safely("out_of_step", () => computeOutOfStep(ctx, opts, envs, budget, now));

  // Releases (Phase F, src/repo/releases.ts): the 30 newest releases, and the 30 newest tags only when there
  // are none — ≤ 2 requests (`RELEASES_RECONCILE_COST`), every row through the gate's release arm.
  await safely("releases", async () => {
    const r = await reconcileReleases(ctx, opts, now);
    out.written += r.written;
    out.unchanged += r.unchanged;
  });

  // PR files (Phase E, src/repo/pr-files.ts): the open PRs and those merged in 14 days whose files were never read
  // for their head — only in a repository with two or more apps, a PR started only while its 3 pages still fit the
  // allowance, every list through the gate's PR-files arm. After the PR lists above, so a new head is seen.
  await safely("pr_files", async () => {
    const r = await reconcilePrFiles(ctx, opts, now, limits.prFiles ?? PR_FILES_REQUESTS);
    out.written += r.written;
    out.unchanged += r.unchanged;
  });

  // The repo scan (repo setups, Phase D — src/repo/scan.ts): which apps the repository holds, as SUGGESTIONS. Only
  // when the caller asks (`scan` — the cron's and Sync's reconcile; not Poll now) and only when the default branch's
  // root tree changed since the last scan: same sha → no request past the tree read. ≤ SCAN_COST requests.
  if (scan) await safely("scan", async () => { await scanRepo(ctx, opts, { ...scan, now }); });

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
 * Computes and stores the PROMOTION CHAIN (`drift_chain`, ./facts-compute.ts — one step per adjacent pair of
 * environments) and, from its LAST step, the `drift` section's snapshot: the head is the earlier branch of that
 * step and the base the last environment's (e.g. `main` → `production`) — for two environments exactly the old
 * first↔last pair, request for request. The ahead commits are grouped by the PR that brought each; the behind
 * side (the base has commits the head lacks) needs its own, second compare, because GitHub's compare returns
 * only the ahead side's commits. THROWS on any GitHub/D1 failure; the never-throwing `refreshDrift` wrapper
 * below is what callers outside `reconcileRepo`'s `safely` arm should use. ≤ `driftCompares(N)` requests.
 */
async function computeDrift(ctx: TenantContext, opts: GhOpts, envs: RepoEnvConfig[]): Promise<void> {
  const last = await computeDriftChain(ctx, opts, envs);
  if (!last) return;
  const { head, base } = last;
  const ahead = last.ahead as unknown as GhCompare;
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
 * Snapshot the drift along the environment branches, and the facts arms. NEVER
 * on the render path: called off a push to an environment branch
 * (`src/webhook.ts`, `pushedBranch` = the pushed one: only its parts' not-shipped
 * are compared); `reconcileRepo` calls the throwing arms directly. Never throws —
 * GitHub failing leaves the previous snapshots (if any) standing.
 */
export async function refreshDrift(ctx: TenantContext, opts: GhOpts, envs: RepoEnvConfig[], pushedBranch?: string, now: number = Date.now()): Promise<void> {
  try {
    await computeDrift(ctx, opts, envs);
  } catch (e) {
    console.error("refreshDrift", scrubbedMessage(e, opts.token)); // the last good snapshot stands
  }
  // The facts arms ride the same trigger (./facts-compute.ts): what the pushed branch has that its parts do not
  // serve, and — incremental, so usually free — the environments' out-of-step compares. Each on its own.
  const budget = factsBudget();
  try {
    await computeNotShipped(ctx, opts, envs, budget, now, pushedBranch);
  } catch (e) {
    console.error("refreshDrift: not shipped", scrubbedMessage(e, opts.token));
  }
  try {
    await computeOutOfStep(ctx, opts, envs, budget, now);
  } catch (e) {
    console.error("refreshDrift: out of step", scrubbedMessage(e, opts.token));
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
