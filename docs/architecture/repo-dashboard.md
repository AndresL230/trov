# The Repo dashboard (capture, cron, pollers, projection)

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

**The Repo dashboard** (`GET /repo/dashboard` → `getRepoDashboard` in `src/tools/repo.ts`; screen `#repo`,
`#repo/code|ci|usage|planning`, its tabs the underline tab bar heading the page body) is the same class of read as My Work: D1-only, session-cookie, never a 500
(a throw yields `emptyRepoDashboard(repo, degraded:true)`) — and, like My Work, the READ is also an MCP tool
for every principal (`get_repo_dashboard`, see Read side); "Poll now" and Sync GitHub stay session-cookie +
admin, NEVER MCP. **Nothing on its render
path fetches**: every external read happens in the webhook, in `reconcileRepo`, or in the repo cron. Every
block travels as a `RepoSection<T>`, and **never guess** governs all of them: `ok` = something to show;
`empty` = capture HAS landed but nothing falls in the window, or every reading has gone stale (the poll
stopped); `not_connected` = nothing has EVER been captured for it (or no environment is configured). **Every
section has a capture path** — the old list of uncaptured sections is gone from `src/tools/repo.ts` — so
`not_connected` means "its capture has not landed YET", and the screen's copy (`web/src/repo.ts`) names what
each one waits on: a setting or secret by NAME, a webhook event, the target repo's CI, or Sync GitHub. There
is no connect button or flow. "Preview with sample data" swaps in `repo-sample.ts` client-side
(session-only, labelled on screen); it never touches the Worker.

Three capture shapes feed it: `repo_events` rows (through the `ingestRepoEvent` gate — see Core invariant),
`repo_snapshots` (one JSON row per kind: `prs_reconciled`, `env_heads`, `drift`, `branches`, `cf_polled` —
plus the transient `refresh_lock`, which is "Poll now"'s lock and feeds no section) and
`repo_metrics` points (`putMetric`). Every section, its source, and what triggers the capture:

| Section (tab) | Source | Trigger |
| --- | --- | --- |
| `stats` tiles (Overview) | open issues / bugs from `events` issue snapshots (latest per issue, now vs 7 days ago, read with `json_extract` so bodies never leave D1); Open PRs / Awaiting review from `repo_events` `pr` | webhook `issues`, `pull_request`; reconcile PR lists |
| `environments` | `deploy` rows (backend), `check` rows with `part = 'frontend'`, head checks, fresh `health_*` metrics | webhook `deployment_status` / `check_run`; reconcile `deployments` / `env_heads` / `checks` arms; cron health ping |
| `drift` | snapshot `drift` | webhook `push` to a configured environment branch; reconcile `drift` arm |
| `health` | metrics `health_up` / `health_ms` | cron, every tick |
| `codeStats`, `bars`, `prs` (Code) | `repo_events` `pr` / `push`; merged/closed PRs in `events` as the fallback | webhook `pull_request` / `push`; reconcile open + closed PR lists and the pre-capture commit window |
| `branches` (+ the Active branches tile) | snapshot `branches` | reconcile `branches` arm only |
| `deploys` (CI) | the same `deploy` / frontend-`check` rows as `environments`, health excluded | as `environments`, minus the ping |
| `ciFailures` | `run` rows | webhook `workflow_run` (+ `fillFailedJob`); reconcile `runs` + `job_titles` arms |
| `coverage`, `bundle` (CI); `todos` (Planning) | metrics `coverage` / `bundle_kb` / `todo_count` | a `canopy/*` commit status the target repo's CI posts — webhook `status`; reconcile `statuses` arm |
| `activity` | PR closes + issue moves from `events`; webhook `push` rows, `review` rows, landed deploys | the captures above |
| `usage` (Usage) | metrics `cf_requests` / `cf_errors` (requests, error rate) and `active_users_*` | cron `:00` — `pollCloudflare`, `pollSaplingMetrics` |
| `cloudflare` | metrics `cf_*` + snapshot `cf_polled` | cron `:00` — `pollCloudflare` |
| `hosting` | metrics `rw_cpu` / `rw_mem_mb` | cron `:00` — `pollRailway` |
| `product` (Usage) | metrics `sap_c_<key>_<24h\|7d\|30d>` / `sap_t_<key>` — whatever keys the app reports | cron `:00` — `pollSaplingMetrics` (the same response as active users) |
| `sprint`, `labels`, `contributors` (Planning) | live D1: the sprint a person marked `active` (the Roadmap's `sprintProgress`); open-issue snapshots; webhook pushes · merged PRs · `review` rows this week | none / webhook `issues` / `push`, `pull_request`, `pull_request_review`; reconcile `reviews` arm |

"Reconcile" is `reconcileRepo` (`src/repo/github.ts`), run by an admin's Sync GitHub and by the cron's
6-hourly `:20` tick; "cron" is the `*/10` repo trigger — both below. **Everything the cron and reconcile
capture also runs on demand from an admin's "Poll now"** (`POST /admin/poll`, below: health pings, the three
`:00` pollers, reconcile) — and reconcile reads EVERY GitHub input the dashboard has, including the two that
used to be webhook-only (`canopy/*` commit statuses, PR reviews). What stays webhook-only is `issues`, which
feeds `events` (My Work's capture, refreshed by Sync GitHub). The capture names a PR's AUTHOR and an
issue's subject, not who merged/closed, so the feed never claims an actor it does not have.

**Owner prerequisites — what must be true OUTSIDE this repo** (the one place they are listed):
- **The target repo's GitHub webhook must be SUBSCRIBED to every name in `REPO_EVENT_NAMES`**
  (`src/webhook.ts`): `pull_request`, `push`, `pull_request_review`, `deployment_status`, `check_run`,
  `workflow_run`, `status`. Every capture arm exists, but GitHub delivers only what the hook subscribes to.
  Without `deployment_status` / `check_run` / `workflow_run`, reconcile is the ONLY source of deploys, checks
  and runs (up to 6 hours late). The same now holds for `pull_request_review` and `status`: without them the
  reconcile's `reviews` and `statuses` arms are the only source (up to 6 hours late, or an admin's Poll now),
  and a review on a PR outside the 30 most recently updated OPEN ones, or older than that PR's last 10, is
  never backfilled (which is why a polled review never opens the contributors' `R` gate — see below).
  Likewise the `statuses` arm reads ONLY the branch HEAD's statuses: a `canopy/*` status CI posted on a
  commit that was superseded before the next reconcile is captured by the webhook or not at all — a
  permanent, invisible hole in the trend (deliberate: older commits cost one request EACH against the
  subrequest budget, and the arm has exactly one).
- **The target repo's CI must post the three `canopy/*` commit statuses** on a push to the first configured
  environment's branch — the YAML is `docs/superpowers/specs/2026-09-20-sapling-ci-metrics.md`, a PR against
  the separate `SaplingLearn/sapling` repo (bundle size is optional there).
- **The target app must implement `GET /api/internal/metrics`** —
  `docs/superpowers/specs/2026-09-20-sapling-metrics-endpoint.md`. It was not built as of 2026-09-20; until it
  is, every poll is a non-200, nothing is written, and Active users reads "not connected" beside live
  Requests / Error rate — the true, designed state.
- **The secrets under Env / bindings** (`GITHUB_SERVICE_TOKEN`, `CF_ANALYTICS_*`, `RAILWAY_TOKEN_*`,
  `SAPLING_METRICS_TOKEN`) and a `REPO_ENVIRONMENTS` var. **The Cloudflare and Railway query shapes were
  built to the vendors' documentation, never verified against a live call** (no token was available to the
  build), and Railway's docs do not confirm a PROJECT token may read `metrics` — the first live poll of each
  is an owner check. A refusal is a logged failure: nothing is written, the section stays `not_connected`,
  nothing false is ever shown.
- **After a merge that changes `[triggers] crons`, run `wrangler triggers deploy`** — a Workers Builds deploy
  did NOT update the schedule (observed 2026-09-20).

**The repo cron** (`src/repo/cron.ts`, `REPO_CRON = "*/10 * * * *"`; THE description of this trigger — Env /
bindings points here). Cloudflare caps one invocation at 50 subrequests (outbound `fetch`; D1 does not
count), so `handleRepoCron` spreads ONE heavy job per invocation across the six ticks an hour, keyed off the
fire time's UTC minute/hour, each job in its own `safely` arm:
- **every tick** — `pingHealth`: 2 requests per environment (4 today).
- **`:00`, every hour** — the three pollers and nothing else, each skipped entirely when its credentials are
  absent: `pollCloudflare` (1 GraphQL request per environment; needs BOTH `CF_ANALYTICS_TOKEN` and
  `CF_ANALYTICS_ACCOUNT_ID`), `pollRailway` (1 per environment that has a `RAILWAY_TOKEN_<KEY>`),
  `pollSaplingMetrics` (1 GET per environment, `redirect: "manual"` so never a second hop; needs
  `SAPLING_METRICS_TOKEN`). The tick is health 2N + Cloudflare N + Railway N + Sapling N = **5N requests —
  10 today**, which caps the configuration at **N ≤ 9 environments** under the free plan's 50 (a tenth lands
  exactly on the cap, and a health ping that follows a redirect costs a subrequest more). The pollers run
  sequentially, each fetch under its own timeout: worst case ≈ 64 s of wall clock for two environments, all
  I/O wait. The tick calls `runUsagePolls`, and the cron ignores what it returns.
- **every 6th hour** (UTC hour % 6 = 0) — `:10` `recomputeAllProgress` alone (UNBOUNDED: one request per
  issue number of every array-ref sprint); `:20` `reconcileRepo` alone (19 + 2N worst case, below — **19 + 4N with the tick's own
  pings: 27 today, N ≤ 7 under the 50**; logs `failed` when non-empty); `:30` `pruneRepoCapture` (D1 only). `:10` and `:20` need `GITHUB_SERVICE_TOKEN`
  + `GITHUB_REPO`; `:30` and the pings run regardless.
- `:40` / `:50`, and `:10`–`:30` of any other hour, ping health and nothing else.
`src/index.ts` dispatches by EXACT string equality on `controller.cron`, so `REPO_CRON` and the expression
in `wrangler.toml` must stay identical (pinned by a test).

**PR and commit capture — the fallback turns on a completeness marker, deltas on a recording window.**
`prCaptured` = the `prs_reconciled` snapshot exists, which `reconcileRepo` writes only after the open-PR list
was BOTH fetched AND ingested without throwing — a marker, not `provenance = 'backfill'`, because a repo with
zero open PRs would otherwise never earn one. Until it exists the Overview reads Merged PRs · issues · Open
tickets (a live ticket count with a net 7-day delta from `ticket_events`) and the Code tab reads Closed
unmerged, instead of lying with "Open PRs: 0" off one webhook delivery, and the PR list stays the
merged/closed list from `events`; once it flips, Open PRs / Awaiting review replace them (Open tickets
leaves the Overview) and the list includes open PRs with their own head branch. **`prs` is `{ rows,
openCount }`**: `rows` is the capped list (8), `openCount` the Overview's own "Open PRs" figure (one
definition, `prsNow`) — `null` until `prCaptured`, never a count of `rows`; a known count with no recent rows
is still `ok` (My Work's Repo tile reads "Open PRs not captured yet — showing recent merged/closed" on `null`,
and tags `repo.sample` data "Sample data"). The 14-day bars are MERGE
bars until a `push` row exists in the trailing 14-day window (not "ever"), then COMMIT bars; the Commits
tile replaces Issues opened on that same condition, and Active branches replaces Issues closed once a
`branches` snapshot exists. A week-over-week DELTA is a further, independent gate: `recordingSince(db, kind)`
(`MIN(recorded_at)` — not `occurred_at`, which a backfilled row predates) must predate the comparison
window, else the delta reads `0` (rendered "—") rather than an artifact of when capture began — PR tiles
need `recordingSince('pr') <= weekAgo`, the Commits tile `recordingSince('push') <= twoWeeksAgo` (else its
`sub` is just "this week"). **The CI-failure rate follows the same rule**: `RepoCiFailures.rate` is `number
| null` and `trend` may be `[]` until `recordingSince('run') <= weekAgo` — before that a day with no captured
runs is a day capture was not running, not a green day. The failures LIST is NOT gated (those rows are
facts, and `empty` would render "No CI failures this week", itself false); rate and trend share the SAME
seven UTC calendar-day buckets, and a `null` rate draws no percentage and no sparkline, just "A 7-day rate
appears after a week of captured runs." `rate` is a PERCENTAGE (3.5 = 3.5%). `rows` is capped at 5;
**`RepoCiFailures.total`** counts every failed/timed-out run in the same window, and every "N failures" reads
it, never `rows.length`. `ciFailures` itself is `not_connected` until a `run` row has ever
been captured; it does not consult `REPO_ENVIRONMENTS`. Backfilled `push` rows (one synthetic count-1 row PER
COMMIT) are excluded from the activity feed and the contributors' `P` tally — a 40-commit backfill would
otherwise read as 40 feed lines and P=40 — but still count toward the Commits tile and the bars; bots are
excluded from `P` and `R`. `reviews` is `null` (rendered "—", excluded from the bar width, not tallied, so
it neither orders the list nor adds a row) until a `review` row has been captured **BY THE WEBHOOK**
(`hasCaptured(db, 'review', 'webhook')`), never a guessed `0`. A POLLED row does not open that gate: the
reconcile's `reviews` arm sees only the 30 most recently updated OPEN PRs × their last 10 reviews, so a
person whose one review sits on a PR merged before the poll would read a hard `0` — "reviewed nothing", a
claim that arm cannot support; the webhook, once subscribed, is complete going forward. With the gate open,
polled rows count like any other (they dedupe against the webhook's). **`approvedPrs` / "Awaiting review"
are NOT gated** and use polled rows at once: they ask only about OPEN PRs — the set the arm reads — and act
on a positive fact; what the arm misses leaves a PR reading "awaiting review", which is what every open PR
read before the arm existed.

**Environments and deploys — each environment ships two deployables, on two hosts** (`HOSTS` / `PARTS` in
`src/tools/repo.ts`): **Backend** is a Railway `deployment_status`, matched by `deployment.environment`
equalling `cfg.railwayEnv`; **Frontend** is the Cloudflare "Workers Builds" `check_run`, which counts as THAT
environment's frontend deploy only when BOTH its name matches `cfg.workerCheck` AND its branch matches
`cfg.branch` (`fromCheckRun` in `src/repo/capture.ts`) — the same check on a PR branch is just a check.
`deployHistories` (`src/repo/reads.ts`) builds the per-part dot strips and carries its own 90-day bound,
because deploy rows are never pruned. **The pill is a verdict about CHECKS, with health as an override**:
`HEALTHY` needs checks captured on the branch head, none failing, and no failed part; a deploy that landed
with NO checks captured reads `UNKNOWN`; a failed part is a fact on its own, so `FAILING` does not wait for
checks; failing head checks read `DEGRADED`; `DOWN` OUTRANKS everything — a fresh health ping saying the
environment is unreachable is the headline. Whether the `environments` section is CONNECTED is a separate
question: it is `ok` once any part has a result, any head check is captured, OR a fresh health ping landed —
a ping alone connects the card but never makes it `HEALTHY`. **`deploys` is gated on a narrower flag** (a
part with a result OR head checks — health EXCLUDED): a ping is not grounds for "No deploys recorded", so
`deploys` stays `not_connected` until deploy capture itself exists.

**ONE policy for a non-decisive conclusion**, stated at `foldResult` and again at `checkState`
(`src/repo/reads.ts`) and shared by the deploy dots and the PR checks column: `success` = ok;
`failure`/`error`/`timed_out` = fail; `stale`/`action_required`/`cancelled`/`inactive`-without-a-preceding-
success = cancel (abandoned, not failed — `inactive` AFTER a success is just the supersede marker of a
deploy that DID land, which is why `success` is tested first); `neutral`/`skipped` = nothing happened, so
NOT a dot at all, and a pass for the checks icon. The checks column has only pass/fail/run, so the cancel
bucket reads there as not-failing.

**A branch's head comes from `branchHeads`** (`src/repo/reads.ts`), which reads TWO sources and takes the
newer: that branch's latest captured `push` row, and the **`env_heads` snapshot** (`{ [branch]: sha }`)
`reconcileRepo` writes — so a rarely-pushed branch (production) still has a head for checks to key off. The
snapshot wins only when its `computed_at` is newer than the branch's latest push `occurred_at` (or no push
was ever captured), compared as PARSED instants (`Date.parse`), never raw strings: `occurred_at` is stored
WITHOUT milliseconds and `computed_at` WITH them, so within one UTC second a string compare calls a newer
snapshot older. It is deliberately a SNAPSHOT, not a synthetic `push` row: a Sync landing between a real
push and its webhook delivery wrote a count-1 row first and the real count-N push then dropped as
`unchanged` — under-counting commits forever — while every Sync that saw a new head added a phantom commit.
It is replaced wholesale, so one branch's failed head fetch drops that branch's previous entry until the
next reconcile (the arm lands in `failed`). The pre-capture commit backfill still writes real backfill push
rows.

**Health is a standing 10-minute ping, not event capture**: `pingHealth` (`src/repo/poll.ts`) sends a polite
`GET` (8s `AbortSignal.timeout`, `redirect: "follow"`, a `canopy-health` user-agent, no retries) to each
environment's TWO deployables (the frontend URL, `apiUrl + healthPath`), all CONCURRENTLY (`Promise.all` —
sequentially, four dead targets would burn 4 × the timeout; each target still times itself, so `health_ms`
is unaffected). `redirect: "follow"` + `res.ok` means a redirect that LANDS on a 200 counts as up — a
reachability check, not a content check. A thrown fetch is recorded as down, never an exception out of the
cron. Written as `health_up` (0/1) / `health_ms`, bucketed to the 10-minute tick, so a double-fired tick is a
no-op. **A health row older than 30 minutes means the cron has stopped** — `getRepoDashboard` treats it as
ABSENT, both for display and for the pill (a stale "down" cannot drag an environment to `DOWN`). So `health`
has THREE states: `ok` with any fresh reading, **`empty` when readings exist but every one has aged out**
("No fresh health reading — the last ping is over 30 minutes old."), `not_connected` only when none EVER
landed. The read is ONE statement (`latestHealth` in `src/repo/store.ts`) however many environments exist.

**There is exactly ONE `repo_metrics.at` format, enforced at the write seam**: `putMetric` re-serialises `at`
through `toISOString()` and SKIPS an unparseable value — every read (`latestMetric` / `metricSeries` /
`metricsSince` / `latestHealth`) compares `at` as a raw string and the UNIQUE key `(metric, env, part, at)`
includes it, so two spellings of one instant would both mis-order and duplicate. The readers normalise their
`sinceIso` bound the same way (a bound lacking milliseconds would sort AFTER the normalised row of the same
instant and exclude it; an unparseable bound returns `[]`, not every row ever written). `putMetric` is
`INSERT OR IGNORE` — **first write wins, forever** — and returns whether it wrote a NEW row. That permanence
is why every poller below stores only values that can no longer change.

**Drift and branches are snapshots, computed off the render path.** `computeDrift` (`src/repo/github.ts`)
compares `envs[0]`'s branch (the head, e.g. `main`) against `envs[last]`'s (the base, e.g. `production`) via
TWO `GET /compare/<base>...<head>` calls (compare returns only the AHEAD side's commits, so the BEHIND side
needs its own), groups the ahead commits by the PR that landed them (a squash merge's trailing `(#123)`) or
as a direct push, and stores one `RepoDrift` snapshot. The PR-title lookup fans out in chunks (`fanOut`,
`src/data/sql.ts`) — a compare returns up to 250 commits and D1 caps a statement at 100 bound parameters.
`ahead`/`behind` are GitHub's own TOTALS while `groups` is built from the commits actually returned, so past
the 250 cap the strip's HEADER stays truthful and only the expanded breakdown is partial. Two triggers: a
webhook `push` to a configured environment branch (the never-throwing `refreshDrift`, needs
`GITHUB_SERVICE_TOKEN`) and every reconcile; it needs two environments. `computeBranches` pages
`refs(refPrefix:"refs/heads/")` over GraphQL with a per-ref `compare(headRef:$head)` (100 branches per page,
5 pages max — REST would cost one `/compare` PER BRANCH; still paging after the 5th it THROWS rather than
pass off a 500-branch prefix as the whole repo) and stores a `RepoBranches` snapshot: active/stale counts,
the `head` it compared against (the first environment's branch — the list renders `vs <head>`, and a
snapshot written before `head` was recorded renders NO "vs …" rather than guess `main`) and
up to 8 rows — the freshest branches plus up to 3 of the stalest-but-unmerged (14 days untouched = stale).
GraphQL's `Ref.compare` treats THE BRANCH as base and `$head` as head, so `aheadBy`/`behindBy` arrive
INVERTED from the product's meaning — `computeBranches` flips them back on purpose (verified live). It runs
only from reconcile (a full refs page on every push would be wasteful), and still runs with `envs: []` (head
`main`, nothing excluded). Both THROW on failure so reconcile's `safely` can name them in `failed` without
clobbering the LAST GOOD snapshot; `refreshDrift` / `refreshBranches` are the never-throwing wrappers for
other callers. Both sections read `not_connected` until a first snapshot exists and then show a STALE one
rather than nothing — **nothing on screen says how old it is** (`computedAt` never reaches the DTO).

**`reconcileRepo` is the backfill AND the self-heal**, the same function from both triggers: an admin's Sync
GitHub (`POST /admin/backfill`) and the cron's 6-hourly `:20` tick, so a repo nobody clicks Sync on still
heals within 6 hours. Both need `GITHUB_SERVICE_TOKEN` + `GITHUB_REPO`. Its arms, each in its own `safely`
block: open PRs (+ the `prs_reconciled` marker), closed PRs, the pre-capture commit window, deployments,
completed workflow runs, the failing-job label pass, the environment heads, each environment's head checks,
the `canopy/*` commit statuses, PR reviews, branches, drift. It returns `{ written, unchanged, failed: string[] }` — `failed` NAMES every arm that threw
(`"deployments"`, `"runs"`, …); `/admin/backfill` passes that through as its `repo` object and the cron logs
it.
- **Deployments are ONE GraphQL request** (`ghGraphql` beside `ghJson`; throws on non-2xx AND on an `errors`
  body), filtered server-side by `environments: [<every cfg.railwayEnv>]` with `statuses(first:10)` inline —
  deployments are selected by ENVIRONMENT NAME, only heads and checks are per branch; the arm is skipped when
  no environment is configured. Each status is re-wrapped into the WEBHOOK's `deployment_status` payload
  shape and put back through the pure `repoEventsFromDelivery`, so there is one derivation of a deploy row.
  Verified live: `databaseId` EQUALS the REST/webhook `deployment.id` (so `gh:deploy:<id>:<state>` still
  collides with a webhook row), `state` arrives UPPERCASE and is lowercased, a Bot creator's `login` arrives
  WITHOUT the `[bot]` suffix and is re-suffixed, and a GraphQL status has no numeric id, so `raw.status_id` is
  `null`, never invented.
- **The failing-job label pass reads the BACKLOG, not this run's writes**: the ≤5 newest `run` rows of the
  last 7 days whose state is `failure`/`timed_out` and whose `title IS NULL` (`untitledFailedRuns`) each get
  a `fillFailedJob`, so a first Sync's leftovers drain over later ones. (The webhook calls `fillFailedJob`
  itself for a failed `workflow_run` delivery.)
- **Which environment a Workers Builds check belongs to is decided by NAME + HEAD SHA**, not by the branch
  the poll asked for: the owner is the config whose `workerCheck` matches the run's name AND whose captured
  head equals the run's `head_sha` (falling back to the polled branch) — two branches sharing a HEAD
  otherwise left one environment permanently untagged.
- **The `statuses` arm closes coverage / bundle / TODO** (they used to arrive ONLY as `status` deliveries):
  ONE `GET /commits/<ref>/statuses?per_page=100`, `<ref>` = the head sha the env_heads arm just read for the
  FIRST environment's branch (the branch name when that read failed; `main` with no environment). Each
  `canopy/*` item — at most the newest 10 per context — is rebuilt as the WEBHOOK's `status` payload (context,
  description, state, created/updated_at, sha, `branches: [{ name }]`) and put through the UNCHANGED
  `metricsFromStatus` → `putMetric`: one derivation, one validator, and the same `at` (`updated_at`, else
  `created_at`, normalised by `putMetric`), so a polled point and a delivered one collide on `(metric, env,
  part, at)`. New rows count into `written`, repeats into `unchanged`; a dropped one is `console.warn`ed as
  the webhook does; a 404 or an empty list is not a failure (`ghJsonOrNull`).
- **The `reviews` arm closes the contributors' `R` and APPROVED**: ONE GraphQL request — the 30 most recently
  updated OPEN PRs, each with its last 10 reviews — each review rebuilt as the webhook's
  `pull_request_review` payload and put through the UNCHANGED `fromReview`, `provenance: "backfill"`.
  **Key parity, verified live 2026-09-21** (PR #658's two reviews read over GraphQL and over REST):
  `databaseId` EQUALS the REST/webhook `review.id`, so `gh:review:<id>:<action>` is the webhook row's key;
  `submittedAt` = `submitted_at` and `url` = `html_url`, string for string; `state` arrives UPPERCASE and is
  lower-cased; a Bot's `login` arrives WITHOUT `[bot]` and is re-suffixed. A DISMISSED review is wrapped as
  the webhook's `dismissed` action only (key `…:dismissed`) — its state at submission is no longer knowable,
  and a guessed `…:submitted` row would shadow the real one forever. PENDING reviews and ones with no author
  or no `submittedAt` are skipped.
- Worst case **19 + 2N outbound requests** for N environments (23 today): 2 PR lists + 1 commit window + 1
  GraphQL deployments + 1 workflow-run list + ≤5 job lookups + 1 status list + 1 GraphQL reviews + ≤5 branch
  pages + ≤2 drift compares + 2 per environment (head commit, head checks). Under an admin Sync it shares the
  invocation with `runBackfill`'s ~13 (36 today).
- **`/admin/backfill` runs it once per Sync, on the batch that ENDS the loop**: the batch whose
  `summaryBudgetExhausted` reads `false`, OR the one that hits the SPA's own cap while still exhausted —
  `isFinalBackfillBatch(result, batch?, of?)` (`src/tools/backfill.ts`); `runAdminBackfillLoop`
  (`web/src/main.ts`) sends its 1-based `{ batch, of }` (`MAX_BACKFILL_BATCHES` = 10), read defensively
  (absent/malformed → gate on the budget alone). Reconcile redoes ~250 no-op statements on a reconciled repo,
  so not on every batch; `repo` is in the response only when it ran; best-effort, unable to fail the route.

**Coverage, bundle size and the TODO/FIXME count are commit-status metrics**: the target repo's CI posts each
as a GitHub commit status (`context` names the metric, `description` is the number); the `status` delivery
reaches `metricsFromStatus` (`src/repo/capture.ts`) — a SIBLING arm to `repoEventsFromDelivery` in the
webhook's repo-capture branch, since a status produces no `RepoEvent`; reconcile's `statuses` arm feeds the
SAME function the same payload — which turns it into a `repo_metrics` point: `canopy/coverage` → `coverage`, `canopy/bundle-kb` → `bundle_kb`, `canopy/todo` → `todo_count`. A
status counts only when its `branches[].name` includes the FIRST configured environment's branch (the
literal `"main"` when none is configured); an unrelated context (Railway's, CodeRabbit's) is dropped after
one cheap parse, costing zero D1 writes. **`description` must be a strict decimal, range-checked per
metric** — these metrics are never pruned, so a bad point is PERMANENT, and `Number()` alone accepts far too
much (`Number(null) === 0`, `"1e3"`, `"0x10"`, a leading `-`): the trimmed description must match
`/^\d+(\.\d+)?$/` AND fall in range — coverage 0–100, bundle_kb 0–10,000,000, todo_count an INTEGER
0–10,000,000 (`STATUS_METRICS`, one table with the context map). `metricsFromStatus` stays PURE: it returns
`{ metrics, dropped }`, `dropped` set only for a `canopy/*` context refused by the branch filter or by
validation, and the webhook `console.warn`s it once (context + reason, ≤ ~40 chars of the description). A
newly-written point counts into `repo.captured`, a redelivery into `repo.unchanged`. **A delta claims a
trend only once the window holds ≥2 points whose first and last are ≥7 days apart** (`windowDelta`):
coverage/bundle read 30 days, the TODO count 90 (it moves too slowly for 30); the baseline is the window's
FIRST point, which may lie left of the 10-point sparkline. Below that bar `RepoTrend.delta` is `""` and
`RepoTodos.delta` is `null` — value shown, no delta text, no "since" — and `spark()` renders nothing under 2
points. All three read `empty`, not `not_connected`, once a point has EVER landed but none is in the window
(`latestMetric` with no bound, checked only on the empty path).

**"Poll now" — health, usage and GitHub on demand; NOT the issue-derived sections** (`POST /admin/poll`; session-cookie,
admin-only — a non-admin is 403 `{ error: "admin only" }` — no request body, NEVER an MCP tool). It calls
`runRepoRefresh(env, Date.now())` (`src/repo/cron.ts`), which runs three sources **in this order, each in
its OWN guarded arm** (a failure in one never skips another): **health** (`pingHealth`), **usage**
(`runUsagePolls`, unchanged — Cloudflare, Railway, the app's metrics), **github** (`reconcileRepo` with the
service token: deploys, checks, runs, branches, drift, open PRs, env heads, the `canopy/*` commit statuses
and PR reviews). The result is
`RepoRefreshResult` (`shared/repo.ts`, types only): `UsagePollResult`'s `cloudflare` / `railway` /
`sapling`, plus `health` — one `PollOutcome` per TARGET (`part` set; `ok` = up, `failed` = down with FIXED
words `timeout` / `HTTP <status>` / `unreachable`; `"not_configured"` with no environment) — and `github`:
`{ written, unchanged, failed }` (`failed` = reconcile's ARM NAMES), `"not_configured"` without
`GITHUB_SERVICE_TOKEN` + `GITHUB_REPO`, `failed: ["unexpected error"]` on an unexpected throw. **The cron
does NOT call it** — its per-tick spreading stands. **Budget: health 2N + usage 3N + reconcile (19 + 2N) =
19 + 7N subrequests — 33 for two environments, and the free plan's 50 caps it at N ≤ 4** (47; 54 at five); past that the
github arm is SKIPPED and says so (`failed: ["skipped: would exceed the subrequest budget"]`) rather than
risk the invocation, while health and usage still run. **Deliberately excluded**: `recomputeAllProgress`
(UNBOUNDED — the reason it has a tick of its own — and it feeds the Roadmap, not this dashboard),
`pruneRepoCapture` (maintenance, not a refresh) and `runBackfill` / summaries (that is Sync GitHub: My Work's
capture, with its own Gemini budget loop). **That last exclusion has a visible cost**: `runBackfill` is also
the ONLY non-webhook writer of the `events` issue snapshots, so the Overview's Open issues / Open bugs tiles
and their deltas, Planning's Issues by label and the activity feed's issue lines do NOT move on a poll — they
refresh with Sync GitHub, and the button's title says so. **Idempotent with the cron**: the pollers key on the HOUR FLOOR,
reconcile on semantic keys and snapshot upserts. **The on-demand health ping is stamped to the SECOND, not
the ten-minute tick** (`HEALTH_ON_DEMAND_BUCKET_MS = 1_000`): `putMetric` is first-write-wins, so a reading
floored to the cron's bucket is dropped and the screen keeps the tick's — and a one-MINUTE floor still
collided for the whole of the tick's own minute (`:X0:40` floors to `:X0:00` either way), so a real DOWN was
shown in the strip and then dropped while the pill stayed HEALTHY. A second lands a NEWER row, which
`latestHealth` (the only reader, latest row per target) picks up; the double-fire guard on this path is the
lock, not the floor. Second-stamped rows read and prune like any other (45 days); a poll every 2 minutes for
a day costs 5,760 health rows for two environments, beside the cron's own 1,152. **The lock**: overlapping runs are correct but wasteful, so `runLockedRepoRefresh` takes a
`repo_snapshots` row `refresh_lock` (`{ by, at }` — not a dashboard section) in ONE statement, an upsert that
only overwrites a row older than **3 minutes** (`REFRESH_LOCK_MS = 180_000`); a younger one is a 409 `{ error:
"a refresh is already running", since }` that runs nothing. It is cleared in a `finally`, and only when the
row is still the caller's own. **What the lock does and does not promise**: it outlives the REALISTIC worst
case (seconds when GitHub answers; ≈ 64 s of pollers all hanging plus a slow reconcile is still inside it),
not the theoretical one — every GitHub read is now bounded (`ghJson` / `ghJsonOrNull` / `ghGraphql` carry an
`AbortSignal.timeout(15_000)`, a timeout surfacing as that arm's name in `failed[]`), and 23 of them all
timing out is ≈ 6 minutes. If a run ever overruns its lock a second run may start beside it: correctness
holds (every write is idempotent, and the overrun run's release is a no-op because the row's `json` is no
longer its own) — only budget is wasted.
The response is 200 even when every source failed (the body says so), 502 `{ error: "poll failed" }` only if
the lock statement itself throws, never a 500 — and it carries outcomes but **never a token, a header or an
account id**; `src/repo/github.ts` now LOGS a failed read as its message with the service token scrubbed
(`scrubbedMessage`), never the Error object, since a thrown fetch or a GraphQL `errors` body can quote the
`authorization` header back — and `src/repo/cron.ts` does the same at EVERY log site it has (`scrubbedLog`:
the cron's generic `safely` logger — which wraps the progress arm's service-token fetches — and
`runUsagePolls`' arm), scrubbing every secret the module hands to a fetch, literally and empty-guarded.
**On screen** the button lives in the **Repo top bar, beside the refresh icon, on every tab** and in every
state of the dashboard (loading, failed, degraded, all `not_connected`) — admins only, hidden in sample
mode, and a non-admin's bar is byte-for-byte what it was (pinned by a test; the refresh icon's title is
"Reload from Trov's database" only beside the button, whose own is "Poll deploys, CI, usage and health now
(admin) — issues refresh with Sync GitHub", and "Polling…" while it runs). A
container query on the BAR (`.repo-pollbtn` in `trov.css`; only a bar that has the button is a container)
makes it icon-only when title + repo slug + labelled controls no longer fit (bar content < 624px — a viewport
under ~735px with the rail collapsed; the crumb is only the slug, the tab bar names the tab) and drops the
"updated …" text under 560px, so at phone width an admin's
controls (281px) are narrower than a non-admin's (343px). While in flight it is disabled and reads
"Polling…" (the refresh icon's `cnpy-spin`, off under reduced motion); a second click does nothing. On
completion the dashboard reloads (the payload stays on screen, so the entrance is not replayed) and a
dismissible strip flashes in at the top of WHICHEVER tab is open, under the tab bar's line (`state.repoPoll`, `repoPollFor`:
session-only, survives a tab switch, cleared on leaving the Repo screen): `Health — 3 up · staging api ✗
timeout`, the three usage lines as below, `GitHub — 12 new · 240 unchanged` / `✗ failed: deployments, runs`
/ `– skipped: …` / `not configured`; a 409 reads "A refresh is already running — try again in a minute.",
any other failure "Poll failed — try again."

**`POST /admin/poll-usage` remains — the narrower, older route** (same gate, no lock): the three usage
pollers only, via `runUsagePolls(env, Date.now())` (`src/repo/cron.ts`), the SAME function as the `:00`
tick; the SPA no longer calls it. **Idempotent with the cron**: every poller keys on the HOUR
FLOOR of `now` and every write is `INSERT OR IGNORE`, so a run at any minute asks for the same hours and
writes the same rows. **3N subrequests** (6 today; no health pings). Each poller returns one `PollOutcome`
per environment (`shared/repo.ts`, types only: `ok` with `written` = NEW `repo_metrics` rows — `0` is a
legitimate re-poll; `failed` with `detail` = the SAME scrubbed message it logs (scrubbed BEFORE any cut, on the non-2xx AND the 200-with-`errors` path; an error body is read to at most 8 KB); `skipped` with a
few fixed words — no worker / no project token / no `railwayEnvironmentId` / no `railwayServiceId` /
`apiUrl` not https), and `UsagePollResult` is those per source, or `"not_configured"` when the source's
secret(s) are absent — exactly when the cron skips it. The response is 200 even when every source failed
(the body says so), 502 `{ error: "poll failed" }` only if `runUsagePolls` itself throws, never a 500 — and
it carries outcomes but **never a token, a header or an account id** (`pollCloudflare`'s one scrub covers
the account id as well as the token). A Cloudflare or Railway **non-2xx says why**: the body's
`errors[0].message` (+ `code`), else the raw text's start, scrubbed BEFORE it is cut (`failureReason`), and
Cloudflare's 400 / 401 / 403 each append a fixed hint (malformed token value / invalid token / lacks Account
Analytics: Read). In the strip the
Sapling line is labelled "App metrics" (one response carries active users AND product metrics); an `ok`
outcome's `detail` (dropped product keys) and a `failed` outcome's partial `written` are both shown.

**Cloudflare Workers analytics** (`pollCloudflare`, `src/repo/poll.ts`) asks Cloudflare's GraphQL analytics
API (`https://api.cloudflare.com/client/v4/graphql`, dataset `workersInvocationsAdaptive`, `scriptName` =
each environment's `cfg.worker`, grouped by `datetimeHour`, `sum { requests errors }`) and writes hourly
`cf_requests` / `cf_errors` (`env` = the config key, `part = 'frontend'`). Cloudflare's schema spells its
scalar **`string`, lowercase** — `String!` is rejected. **The window is LAGGED one hour** — `to` = the
current hour's floor − 1h, `from` = `to` − 3h (at 12:00 it reads 08:00–11:00): the poll fires seconds after
an hour closes, when the adaptive dataset may not have caught up, and a short count would be permanent.
`datetime_leq` is inclusive, so the bucket AT `to` is skipped (`at >= to`); the overlap heals a missed tick
and cannot re-count a written hour. A GraphQL failure arrives as HTTP **200 with an `errors` array** — that,
a non-2xx, a thrown fetch, or a body with no account in it costs THAT environment the tick (logged; `data`
is never read beside `errors`) and the loop moves on; a malformed row is skipped on its own. Never throws.
**The `cf_polled` marker — no row ≠ zero unless we know we looked**: Cloudflare returns NO row for an hour
with no invocations, so a quiet hour and a dead poll look identical in `repo_metrics`. Each environment whose
poll SUCCEEDED (even with zero rows) has its window merged into ONE snapshot row, `cf_polled` (`CF_POLLED` in
`src/repo/types.ts`): `{ [envKey]: { from, to } }` — ONE contiguous covered INTERVAL, `to` exclusive. An
interval, not a high-water bound, because a bound cannot say a stretch in the middle was never looked at: when
the previous interval reaches the new window (`prev.to >= window.from`) it keeps its `from` and `to` becomes
the max; otherwise (no previous, or a GAP — an outage longer than the 3-hour window) `from` RESTARTS at the
window's start, and that jump is the record of the hole. One read + at most one write per poll (an unlocked
read-modify-write, safe because ticks never overlap and a lost update re-writes identically); a failed
environment keeps its interval, and within one run neither end moves BACKWARDS (the write is an unlocked
read-modify-write, so an on-demand run overlapping a cron tick can put back an older `to` — accepted: that
stretch draws unknown, never zero, and the next poll re-extends it). A LEGACY string value (the pre-interval
shape, still in local dev DBs) reads through `cfCovered` as `{ from: bound − 3h, to: bound }`.
The projection (`projectUsage`) costs the render **ONE statement** — `metricsSince` (`src/repo/store.ts`)
for every range, environment and series, sliced in memory. It takes GROUPS, each with its OWN bound
(`(metric IN (…) AND at >= ?) OR (…)`, `usageReadGroups` in `src/tools/repo.ts`): `cf_*` and
`active_users_30d` over 30 days, `active_users_7d` over 7, `active_users_24h` over 24 hours, and `rw_*` over
the 3-hour staleness window — every row left out is one the projection already discarded (over half of the
~10,000 a flat 30-day read returned). It sits beside ONE
`getSnapshot('cf_polled')`, plus ONE `metricsEver` only on the not-`ok` path. A range is its last N COMPLETE
hours (24 / 168 / 720) in equal buckets (1h / 24h / 24h) ending at the last complete hour, never at UTC
midnight. The trend is DENSE but zero only where a zero is entitled: the fill STARTS at the first captured
point (or the range's start when capture predates it) — **unless that would cross a HOLE** (an hour before
the covered `from` with no real point: nothing ever looked at it), in which case the series starts at the
covered `from` and shows the contiguous covered stretch only, while totals still sum every real point in the
range — and ENDS at `min(last complete hour, that environment's covered `to`)`; with NO marker it ends at the
last real point, so a dead poll draws no zeros after it. **The first bucket drawn is the first WHOLE one**: a
7d/30d day-bucket that capture or coverage began inside is counted in the total but not drawn as a day.
`requests` is non-null when something is known in the range — a point in range, or capture predating the
range AND covered hours inside it (a "0" that is true of the COVERED hours — known limit: when only part of
the range was covered, e.g. a poll that resumed three quiet hours ago after a long outage, the card still
reads "0" for the whole range label) — otherwise `null`, never "0". `errorRate`
needs a real point in range: points summing to 0 requests read "0.00%", but with NO point 0 of 0 is not a
rate → `null` (the screen shows "—" beside live requests). Totals are sums of real points only. `usage` is
`ok` when any metric of any range is non-null; the `cloudflare` panel when the WIDEST (30d) range has rows,
so a narrower range can be `[]` ("Nothing recorded in this range." — never "no requests": the range may be
one no poll covered). **A per-metric `null` does not say WHY**, so each `RepoUsageEnv` carries `seen: {
requests, users }` — whether that environment's `cf_requests` / any `active_users_*` point exists AT ALL in
the one 30-day read, the same in every range. `null` + seen renders **"no recent reading"** (no point in this
range, a poll that stopped, a gauge gone stale); `null` + not seen renders **"not connected"**; the error
rate follows `seen.requests`, keeping its "—" beside live requests. `seen` looks back those 30 days only: a
source silent for longer reads "not connected" per metric again while the section-level `metricsEver` (any
age) still says `empty` — whose copy is "No current usage reading — the hourly polls have gone quiet."

**Railway CPU and memory** (`pollRailway`) asks Railway's public GraphQL API
(`https://backboard.railway.com/graphql/v2`, `metrics(environmentId, serviceId, startDate, measurements:
[CPU_USAGE, MEMORY_USAGE_GB], sampleRateSeconds: 3600)`, `ts` in unix SECONDS) once per environment and
writes hourly `rw_cpu` (vCPU) / `rw_mem_mb` (GB × 1024, one decimal), `part = 'backend'`. **Auth is a PROJECT
token PER ENVIRONMENT, sent as `Project-Access-Token` — never `Authorization`** (a project token is refused
as a bearer): the ONE helper `railwayTokens` (`src/repo/cron.ts`) maps each `cfg.key` to the secret
`RAILWAY_TOKEN_<KEY>` (upper-cased, anything outside A–Z/0–9 → `_`), so a third environment is its secret
and no new cron line. An environment with no token, no `railwayEnvironmentId` or no `railwayServiceId` is
skipped while the others poll. **A token is never logged** — only `cfg.key` and the error's MESSAGE, scrubbed
of every token in the map. Only COMPLETE hours are stored: a sample stamped at or after the current hour's
floor, or before the 3-hour window, is skipped; each is bucketed to its hour; values are validated one by one
(finite, ≥ 0, under 1024 vCPU / 4096 GB); an unknown measurement is ignored. **Within ONE response, per
metric per hour bucket, the valid sample with the LATEST `ts` is the one written** (Railway's array order is
undocumented) — but a row an EARLIER poll stored for that bucket still wins. These are gauges, so — unlike
Cloudflare's counts — there is NO extra hour of lag. A non-2xx, a thrown fetch, a 200 carrying `errors`, or
no metrics list costs THAT environment the tick; never throws. The projection costs **NO new statement**:
`rw_*` ride the same `metricsSince` read, and `projectHosting` picks each environment's latest backend point
in memory. The sources share a read but NOT a state — a Railway row never connects `usage`, a Cloudflare row
never connects `hosting`. **A "current" figure must be current: a value shows only while its latest point is
≤ 3 hours older than `now`**, else that cell reads "—"; `hosting` is `empty` when an `rw_*` row has EVER
landed but none is fresh ("No fresh hosting reading — the last Railway sample is over 3 hours old.").

**Active users come from Sapling's own backend** — the one number Trov CANNOT compute. `pollSaplingMetrics`
sends `GET {cfg.apiUrl}/api/internal/metrics` with `Authorization: Bearer <SAPLING_METRICS_TOKEN>`
(user-agent `canopy-metrics`, the 8s timeout) per environment and expects `200` → `{ "active_users": {
"24h": n, "7d": n, "30d": n } }`. **The token goes to ONE place**: a non-`https:` `apiUrl` is never fetched,
trailing slashes are normalised, and `redirect: "manual"` + "only a 200 is an answer" means a 3xx is a
failure, never a hop that carries the header elsewhere. The token, headers and request init are never logged
— only `cfg.key` and a short message, scrubbed BEFORE it is cut, quoting ≤ 80 characters of a refused body.
**Validation is the whole response or nothing** (`saplingActiveUsers`): each window a non-negative INTEGER ≤
10,000,000 AND `24h ≤ 7d ≤ 30d`, else NOTHING is written for that environment that tick. Stored as hourly
`active_users_24h` / `_7d` / `_30d` (`part = ''`), `at` = the CURRENT hour's floor with NO lag — a
point-in-time GAUGE is whole the moment it is read; `INSERT OR IGNORE` keeps the first reading of each hour.
The projection costs **NO new statement** (the names are in `USAGE_METRICS` and `usageReadGroups`). For range R, `users.value` is
the LATEST `active_users_R` reading — **never a sum** — shown only while ≤ 3 hours old (the same
`HOSTING_STALE_MS` rule; a reading stamped ahead of the clock does not count), else `users: null`;
`users.trend` is **never zero-filled** (a missing hour is a poll that did not land, not zero users) and is
THINNED for the wider ranges, never truncated (`thinGauge`): 30d keeps the LAST reading of each UTC day (≤ 31
points), 7d the last of each 6-hour block ending at the current hour (≤ 28), 24h stays hourly. A
current users reading makes `usage` `ok` on its own; readings all gone stale leave it `empty`.

**Product metrics ride that SAME response** (contract v2,
`docs/superpowers/specs/2026-09-21-sapling-product-metrics.md`): optional `counts` (windowed `{24h,7d,30d}`
integers) and `totals` (point-in-time integers). `saplingProductMetrics` (`src/repo/poll.ts`, pure) validates
them **per key** — key `^[a-z][a-z0-9_]{0,39}$`, JSON integers `0..1e12`, a count's windows exactly three and
nesting; a section that is not an object or holds more than 48 / 24 keys is ignored whole — reading OWN keys
only into prototype-less objects. Trov is **generic over keys**: every valid key is stored, as
`sap_c_<key>_<window>` / `sap_t_<key>` hourly gauges (`part = ''`, the hour floor, first write wins), so
Sapling adds a metric with no Trov change. The two halves never cost each other: a v1 body is a plain
success, and a body whose `active_users` is refused still stores its product keys — that environment reads
`failed`, with `written` the rows that landed. One environment's rows (≤ 171) go in ONE `putMetrics` call.
Dropped keys are logged once per environment by NAME only and named in the outcome's `detail` — an `ok`'s,
and (appended to the refusal) a `failed`'s; an ignored SECTION is one name (`counts.*`) but counts every key
it held. **A rejected name is scrubbed BEFORE it is cut to 40 characters**: the validator takes the poller's
`scrub` as its optional `clean` argument (default identity, so it stays pure), because a scrub matches a WHOLE
secret and 40 characters of a 64-character token (`openssl rand -hex 32`) match nothing — the same rule as
every other cut in `src/repo/poll.ts`, including `failureReason`'s 8 KB READ cap, which scrubs the capped text
whole and then drops a 256-character tail a cut-off secret could be hiding in. Token-leak tests use a
64-character token (`LONG_TOKEN`, `test/helpers/repo.ts`) and assert no 8-character piece of it gets out.
The `product` section (`projectProduct`, `src/tools/repo.ts`) lists every configured environment: `counts`
grouped Growth / Learning activity / Community / AI spend / Reliability / Other (`src/repo/product.ts`; an
unknown key → Other, labelled from the key; `llm_cost_cents` reads as dollars with a "lower bound" note —
`flashcards_created` and `errors_4xx` carry notes too, printed as one footnote block under their group, a
line per noted key; the registry lists what Sapling SERVES, so `study_guides` is not in it and
`rag_chunks_dropped` is labelled "RAG runs that dropped chunks"), one
figure per range, and `totals` on their own ("Right now" — they ignore the range selector). A figure shows
only while its latest reading is ≤ 3 hours old (`HOSTING_STALE_MS`), else `null` → "no recent reading"; a key
with no row in the read is absent. The trend is the daily totals — for a `counts` key its `24h` reading, for a `totals` key its own reading —
stamped EXACTLY 00:00 UTC of each of the last 30 days, a missed midnight ABSENT, the same line for every range. `ok` = any
figure current; `empty` = a `sap_*` row has ever landed (`metricsEver`'s prefix family, in its existing
statement); else `not_connected`. It costs the render **ONE statement** — `productReadings`, a loose index
scan (a recursive CTE hops distinct `sap_*` names, then seeks each name × environment: the fresh range, and
each midnight by equality), because the plain `metric GLOB 'sap_*'` form walks every stored `sap_` entry
(~33k at steady state for two environments) to return ~3k. The shape saves rows READ, not the sort — the
`UNION ALL … ORDER BY` still costs a temp b-tree in both arms.

**On screen the Usage tab is a hierarchy, not tables** (`web/src/repo.ts`): APP USAGE compare (side by side —
comparing environments is its job) → ONE **Product** section → infrastructure. Product shows ONE environment,
picked by a segmented control (`state.repoProductEnv`, session-only; default = the LAST configured environment
that has reported anything, else the first; the pressed button carries no `data-act`, so re-pressing it never
replays the cross-fade; `repoProductEnv` flashes only `.repo-pswap`, a range switch flashes every `.repo-swap`).
Inside it: the `totals` as an inline "Right now" stat strip; up to four headline tiles picked by KEY in a fixed
order (`signups`, `tutor_sessions`, `llm_cost_cents`, `errors_5xx`, then `chat_messages`, `logins`,
`quizzes_completed`; fewer than two present → no strip; `errors_5xx` > 0 is the one toned tile); then a block
per group on a 12-column grid, its SHAPE keyed by the group `id` — `learning` a ranked bar list (sorted by the
range's raw figure, bar = raw ÷ group max, null last with no bar), `ai` one feature figure (`llm_cost_cents`
leads, the other keys are one quiet line — nothing derived, no cost-per-call), `reliability` a status list
(non-zero rows with a tone dot — `bad`, except `errors_4xx` which stays neutral; every measured ZERO folds into
one "N at zero — …" line; a null is named on its own "no recent reading" line and is NEVER counted a zero; the
block's `min-height` is its tallest form across every range and environment so a switch shifts nothing under
it), `growth` / `community` stat pairs, and `other` or ANY unrecognised group id as quiet rows at the end — no
shape may depend on a key existing. `data-count` now takes an optional `data-count-fmt` (`compact` / `usd`,
`formatCount`): `countUp` formats the in-between frames and LANDS on the element's own rendered text, so a
compacted or dollar figure counts up without the browser ever re-deriving the Worker's string. Cloudflare and
Railway are figure-over-label blocks per environment; the Cloudflare error-share bar is `errorShare` over the
two compact strings that block itself shows (`parseCompact`), drawn only when both parse and requests > 0, and
it prints NO percentage (the Worker's own error rate sits in the compare block above — a second, re-derived
figure could disagree with it by a rounding).

**Pruning** (`pruneRepoCapture`, `src/repo/store.ts`, the cron's 6-hourly `:30` tick): `health_*` metrics
and `check` rows older than 45 days — the `check` deletion ONLY `WHERE part IS NULL`, because a FRONTEND
deploy record IS a `check` row (`part = 'frontend'`) and must be kept forever like `deploy` rows; and the
HOURLY usage metrics (`cf_*` / `rw_*` / `active_users_*`) older than 100 days; and `sap_*` product metrics
older than **7 days, EXCEPT the rows stamped exactly 00:00 UTC, kept 100 days** (the daily totals the trend
reads — `sap_*` and the usage globs never match each other's names). `pr` / `push` / `deploy` /
`run` / `review` rows and `coverage` / `bundle_kb` / `todo_count` match no rule and are kept forever.

**`get_repo_dashboard` is the Repo dashboard's read over MCP, for every principal too** — it exposes nothing
a signed-in member cannot see at `#repo`, and nothing per-user. `src/tools/repo-agent.ts` is a VIEW over
`getRepoDashboard` (the same D1-only projection the route serves — never a second projection, never a
fetch): `tab` returns only that tab's sections via `REPO_TAB_SECTIONS` (`shared/repo.ts` — the ONE
section→tab mapping, also read by the screen's "not connected" footer, and compile-time exhaustive over
`RepoDashboard`'s sections); `range` (default `7d`) collapses `usage` / `cloudflare` / each `product` count
to that one range; `include_trends` (default `false`) governs every `trend` array and the drift breakdown —
drift is the one section with no small bound, TWICE over (up to 250 commits a side, and one group per
squash-merged PR among them, on the OVERVIEW tab), so without the flag a group carries `commitCount` instead
of its `commits` AND only the first `DRIFT_GROUP_LIMIT` (20) groups travel, with `groupCount` the full number
beside GitHub's own `ahead` / `behind`; with it, every group and its commits. A section's STATUS is never
touched — `not_connected` / `empty` pass through, never coerced to zeros — and the tool's description says
the same of a `null` INSIDE an `ok` section (`usage[].requests`, a `product` value, `contributors[].reviews`,
`ciFailures.rate`, `prs.openCount`, a delta): unknown, never zero, with `usage[].seen` saying whether the source ever
reported. A projection throw is the degraded empty payload, not an MCP error. The view is per-call and only
serialized — it SHARES structure with the projection, it is not a deep copy. Output: `{ repo, generatedAt,
degraded, tab, range, sections }`.
