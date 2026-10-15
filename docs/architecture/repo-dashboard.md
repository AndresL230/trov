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
The Repo-setups design's scenarios A–N live in `repo-sample.ts` too, as `RepoFacts` (`repo-apps.md` › The sample
scenarios A–N).

**Apps, the Overview's facts and its blocks** (repo setups) are `repo-apps.md`: an app is a part key (`repo_apps`);
`facts: RepoFacts` rides every `GET /repo/dashboard?repo=&app=` payload and MCP `get_repo_dashboard`, assembled
INSIDE this one projection by `readRepoFacts` (`src/tools/repo-facts.ts`) from the reads `getRepoDashboard` already
made, then narrowed by `narrowFacts` — a throw there costs the facts alone (`emptyRepoFacts`, `degraded: true`).
`?repo=` is checked against `org_repos` (unknown → 404 `{ error: "unknown repository" }`; MCP reads the primary);
`?app=` (an app key or `__repo`) ALSO narrows the per-part sections — environments' parts, `deploys`, `usage`,
`providers` — to that key's parts; the other sections stay the org's capture. The layout is
`layoutOf(layoutInputOf(facts), group)` (`shared/repo-layout-core.ts`), the same on the screen and over MCP.

Three capture shapes feed it: `repo_events` rows (through the `ingestRepoEvent` gate — see Core invariant),
`repo_snapshots` (one JSON row per kind: `prs_reconciled`, `env_heads`, `drift`, `branches`, and the Overview
facts' `drift_chain`, `not_shipped`, `out_of_step` (`src/repo/facts-store.ts`), the releases arm's
`releases_reconciled` marker and contract v3's `app_metrics:<env>` descriptions —
plus the transient `refresh_lock`, which is "Poll now"'s lock and feeds no section) and
`repo_metrics` points (`putMetric`). Every section, its source, and what triggers the capture:

| Section (tab) | Source | Trigger |
| --- | --- | --- |
| `stats` tiles (Overview) | open issues / bugs from `events` issue snapshots (latest per issue, now vs 7 days ago, read with `json_extract` so bodies never leave D1); Open PRs / Awaiting review from `repo_events` `pr` | webhook `issues`, `pull_request`; reconcile PR lists |
| `environments` | every part of the environment (`org_environment_parts`, any host) with its newest `hosting_deploys` row, a part's successful poll (`hosting_poll_state`), head checks, fresh `health_*` metrics | cron `:40` — `pollPart` per part; webhook `check_run`; reconcile `env_heads` / `checks` arms; cron health ping |
| `drift` | snapshot `drift` | webhook `push` to a configured environment branch; reconcile `drift` arm |
| `health` | metrics `health_up` / `health_ms` | cron, every tick |
| `codeStats`, `bars`, `prs` (Code) | `repo_events` `pr` / `push`; merged/closed PRs in `events` as the fallback; under the App menu `pr_files` / `commit_paths` (Phase E) | webhook `pull_request` / `push`; reconcile open + closed PR lists and the pre-capture commit window |
| `branches` (+ the Active branches tile) | snapshot `branches` | reconcile `branches` arm only |
| `deploys` (CI) | each part's settled `hosting_deploys` rows (a dot strip per part); checks and health excluded | cron `:40` — `pollPart` per part |
| `ciFailures` | `run` rows (by app: the run's workflow file and head commit's `commit_paths`, Phase E) | webhook `workflow_run` (+ `fillFailedJob`); reconcile `runs` + `job_titles` arms |
| `coverage`, `bundle` (CI); `todos` (Planning) | metrics `coverage` / `bundle_kb` / `todo_count` | a `canopy/*` commit status the target repo's CI posts — webhook `status`; reconcile `statuses` arm |
| `activity` | PR closes + issue moves from `events`; webhook `push` rows, `review` rows, landed deploys | the captures above |
| `usage` (Usage) | each environment's WEB parts' `hx_requests` / `hx_errors` summed (requests, error rate; covered intervals from `hosting_poll_state`) and `active_users_*` — on screen only the active users (on the environment's first web target) | cron `:40` — `pollPart`; cron `:00` — `pollSaplingMetrics` |
| `product` (Usage) | metrics `sap_c_<key>_<24h\|7d\|30d>` / `sap_t_<key>` — whatever keys the app reports; contract v3's self-description is the `app_metrics:<env>` snapshot | cron `:00` — `pollSaplingMetrics` (the same response as active users) |
| `providers` (Usage — the targets, the extra families and the Hosting section: `web/src/repo-usage.ts`, `web/src/repo-hosting.ts`) | every part of every environment, provider-neutral (Cloudflare and Railway like the rest): `hx_*` metrics (the extra families' `hx_outcome_*` / `hx_subrequests` / `hx_cpu_time_*` / `hx_wall_time_*` / `hx_d1_*` / `hx_cron_*` in one more read), `hosting_deploys`, `hosting_poll_state` | cron `:40` — `pollPart` per part |
| `release` (Overview R3), `unseen.tags`, week `releases` | `releases` (0074): `readRelease` / `readTags` / `releaseWeekFigure`, `src/repo/releases.ts`; `since` / `waiting` from `repo_events` `push` / `pr` | webhook `release` / `create` (gate: `ingestRepoRelease`); reconcile `releases` arm |
| `sprint`, `labels`, `contributors` (Planning) | live D1: the sprint a person marked `active` (the Roadmap's `sprintProgress`); open-issue snapshots; webhook pushes · merged PRs · `review` rows this week | none / webhook `issues` / `push`, `pull_request`, `pull_request_review`; reconcile `reviews` arm |

"Reconcile" is `reconcileRepo` (`src/repo/github.ts`), run by an admin's Sync GitHub and by the cron's
6-hourly `:20` tick; "cron" is the `*/10` repo trigger — both below. **Everything the cron and reconcile
capture also runs on demand from an admin's "Poll now"** (`POST /admin/poll`, below: health pings, the three
`:00` pollers, reconcile) — and reconcile reads EVERY GitHub input the dashboard has, including the two that
used to be webhook-only (`canopy/*` commit statuses, PR reviews). What stays webhook-only is `issues`, which
feeds `events` (My Work's capture, refreshed by Sync GitHub). The capture names a PR's AUTHOR and an
issue's subject, not who merged/closed, so the feed never claims an actor it does not have.

**Releases and tags** (`releases`, 0074; `src/repo/releases.ts`) feed R3, the unseen card's tags and the week tile
`releases`: gated capture of `release` / `create`, reconcile's backfill, and the reads `readRelease` / `readTags` /
`releaseWeekFigure` — `repo-apps.md` › Releases.

**Monorepos — the App menu on Code and CI** (repo setups, Phase E; `0073_commit_paths`): which files a commit and a
pull request touched (`commit_paths`, `pr_files`), and how the Code tiles, bars and PR list and the CI failures narrow
to one app — `repo-apps.md` › Monorepos.

**Owner prerequisites — what must be true OUTSIDE this repo** (the one place they are listed):
- **The target repo's GitHub webhook must be SUBSCRIBED to every name in `REPO_EVENT_NAMES`**
  (`src/webhook.ts`; for an org connected through the GitHub App the subscription is the App's own event
  list, set once on the App — `github-app.md`): `pull_request`, `push`, `pull_request_review`, `check_run`,
  `workflow_run`, `status`, `deployment_status`, `deployment`. Every capture arm exists, but GitHub delivers only
  what the hook subscribes to. It must ALSO carry `release` and `create` (`RELEASE_EVENT_NAMES`: releases and
  tags — `repo-apps.md` › Releases); the App is also subscribed to `workflow_job` (`LATER_EVENT_NAMES`: verified,
  acknowledged, not captured yet). The `deployment` / `deployment_status` deliveries and every non-`canopy/*`
  status are captured as UNTAGGED GitHub deploy signals (`repo_events` kind `deploy`, `raw.signal`, kept 90 days)
  that feed Detected, the repo scan's seen signals, a `github` part's deploys and the commit join — never an
  environment's deploys by name (`repo-apps.md` › The `github` provider). Without `check_run` / `workflow_run`, reconcile is the
  ONLY source of checks and runs (up to 6 hours late). The same now holds for `pull_request_review` and `status`: without them the
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
- **The organization's own configuration and credentials** — nothing here is a Worker secret or var any
  more (`data-layer.md` › Configuration and credentials). The org needs a PRIMARY repository (Org settings ›
  Repositories, `org_repos`) and its environments (Org settings › Environments, `org_environments`, in
  `position` order); a GitHub credential — its App installation, else a stored `github_token`
  (`resolveGithubCredential`, `github-app.md`); and, optionally, an app-metrics token per environment
  (`resolveCredential`; set in a part's editor — Org settings › Repositories › a repo › Apps). What HOSTS an
  environment — Cloudflare, Railway, Vercel, … — is its parts (set per app on that Apps page, `repo-apps.md`), each
  provider with ONE org-wide credential (Org settings › Hosting, `hosting-providers.md`). The
  Worker secrets of the same purpose (`GITHUB_SERVICE_TOKEN`, `CF_ANALYTICS_*`, `SAPLING_METRICS_TOKEN`)
  answer for SaplingLearn ALONE, only until it stores each (`env.md` › Legacy); the vars `GITHUB_REPO` /
  `REPO_ENVIRONMENTS` are read by nothing.
- **After a merge that changes `[triggers] crons`, run `wrangler triggers deploy`** — a Workers Builds deploy
  did NOT update the schedule (observed 2026-09-20).

**The repo cron** (`src/repo/cron.ts`, `REPO_CRON = "*/10 * * * *"`; THE description of this trigger —
`env.md` points here; the dispatcher's rotation is `data-layer.md` › Background jobs). The work is PER ORG.
Each cadence is a JOB over UNITS — one per (org, environment) for `health` / `usage`, one per org with a
primary repository for `progress` / `reconcile` — and `handleRepoCron` spreads ONE heavy job per invocation
across the six ticks an hour, keyed off the fire time's UTC minute/hour, serving each job's units for every
non-suspended org by rotation (`src/repo/dispatch.ts`). A unit runs as its own org's system tenant, reads its
repo and environments from that org's rows and its credentials through the resolvers, in its own guarded
arm: a failure is logged scrubbed with `org=<id>`, recorded on THAT org's integration row, and the loop moves
on. An org with no environment and no primary repository has no unit and costs nothing.
- **every tick** — `health`: `pingHealth`, 2 requests per (org, environment), no credential. Also two D1-only
  cross-org sweeps: `expireDueHandoffs` and `expireGifts` (a lapsed gifted plan moves to Free).
- **`:00`, every hour** — `usage` and no other heavy job: per (org, environment) the app's own metrics
  endpoint (`usageForEnv` → `pollSaplingMetrics`, 1 GET, `redirect: "manual"` so never a second hop), in a
  guarded arm and skipped entirely when THAT org has no `metrics_endpoint` token for that environment. With
  the tick's own pings that is **3 requests per environment** (`HEALTH_COST` 2 + `USAGE_COST` 1); worst case
  ≈ 16 s of wall clock per environment, all I/O wait. The cron ignores the outcomes (the poller logs its own
  failures). A HOST's usage (Cloudflare, Railway, …) is not read here: it is the `:40` `hosting` job's.
- **every 6th hour** (UTC hour % 6 = 0) — `:10` `progress`: `recomputeAllProgress` per org, UNBOUNDED (one
  request per issue number of every array-ref sprint; budgeted as an estimate, `PROGRESS_COST_ESTIMATE`);
  `:20` `reconcile`: `runReconcileJob` per org (`reconcileRepo`, `reconcileRequests(N)` worst case for N environments (its releases arm included),
  below, + the repo scan's `SCAN_COST` — plus one request when an App installation token has to be minted, and the org image's import that
  rides the same unit: `reconcileCost`; logs `failed` when non-empty); `:30` `pruneRepoCapture` + `pruneOAuth`
  (D1 only, cross-org). `:10` and `:20` skip, without a word, an org with no primary repository or no GitHub
  credential; `:30` and the pings run regardless.
- **`:40`, every hour** — the `hosting` job (0057; `hosting-providers.md`): one unit per (org, environment, part)
  from `listPartUnits` — Cloudflare and Railway parts included — each costing its provider's `pollCost` (≤ 6),
  served by rotation like the others; health keeps half the budget on this tick only when some org has a part.
  With no part anywhere `:40` has no heavy job and is a plain health tick (below).
- `:50`, `:40` when no org has a part, and `:10`–`:30` of any other hour, ping health and nothing else — and then the AI pass
  (`src/ai/pass.ts`, `ai.md`) on what the pings left of the budget, on every tick with no heavy job. Its job
  registry is empty, so today it reads and fetches nothing. At `:50` the digest pre-warm (`prewarmDigests`,
  `notifications.md`) runs first: D1 only, it marks the briefs the coming hour's digests lead with.
- The repo capture marks the AI router (`ai.md` › The router): a webhook delivery's written `repo_events` row marks
  `session:<repo>:<actor>` (and `repo:<repo>` for a default-branch push, a deploy, a default-branch run failure;
  the PR author's `person` for a failure on their branch), and a hosting deploy that lands or fails on an
  environment's branch marks `repo:<repo>` (`upsertDeploys`, `src/hosting/poll.ts`). Reconcile's backfilled rows
  mark nothing: a session is about a live burst.

**The budget.** One invocation may spend `CRON_SUBREQUEST_BUDGET` = **900** outbound requests (Workers Paid
allows 1,000 an invocation; D1 does not count) and `CRON_WALL_BUDGET_MS` = 8 minutes of wall clock. `health`
goes first and, on a tick that also has a heavy job, may use at most HALF, so neither starves the other. A
unit is started only while its worst-case cost still fits, what it really spent is counted through the
budget's own `fetch`, and each job resumes after the unit its previous invocation stopped at (`cron_cursor`)
— so more orgs than one invocation can serve lengthen the cycle; they never overrun it. With few orgs every
tick serves every unit and the cursor is never written. ONE org's on-demand "Poll now" has its own, smaller
ceiling, `SUBREQUEST_CAP` = 100 (below; it was the free plan's 50 until repo setups' compares outgrew it).
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
been captured; it does not consult the org's environments. Backfilled `push` rows (one synthetic count-1 row PER
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

**Environments and deploys — an environment ships its PARTS, on whatever hosts** (`hosting-providers.md`): a card
lists every part of its environment (`org_environment_parts`, in position order — a Cloudflare Workers
frontend and a Railway backend exactly like a Vercel site or a Fly.io app) with its NEWEST deploy as the
hosting job stored it in `hosting_deploys` (`RepoEnvPart`: the part's key and label, its provider and the
provider's label as `host`, the sha cut to 7 — null when the provider reports none —, `ready_at` else the
creation instant, who triggered it on the provider, and `result`: ready → `ok`, error → `fail`, canceled →
`cancel`, queued / building → `running`). The deploys are the providers section's own read (`hostingReads`:
the newest 10 of each part created in the last 90 days, of its CURRENT provider only — a re-pointed part's
old host's rows are not its history) and one derivation (`partInfos` in `src/tools/repo.ts`) feeds the
cards, the strips, the Usage compare and the providers section. The CI tab's strips (`RepoDeployRow`, one per
part with a SETTLED deploy, labelled "<environment> · <part label>", oldest first) and the cards' lines are
`deployDots` / `envPartOf` (`shared/repo.ts` — the sample uses the same two): a deploy still queued or
building is not a dot; canceled is abandoned, never a failure. Nothing here reads GitHub's deployments or
Workers Builds checks directly: a GitHub signal reaches a card only as a `github` part's own `hosting_deploys` row
(`repo-apps.md` › The `github` provider). **The section's pill is a verdict about CHECKS, with health as an override**:
`HEALTHY` needs checks captured on the branch head, none failing, and no failed part; a deploy that landed
with NO checks captured reads `UNKNOWN`; a part whose newest deploy errored is a fact on its own, so
`FAILING` does not wait for checks; failing head checks read `DEGRADED`; `DOWN` OUTRANKS everything — a fresh
health ping saying the environment is unreachable is the headline. `RepoEnv.pill` is still computed and served
over MCP, but the screen draws it only for a payload WITHOUT `facts` — every Worker payload carries them now, and
then the header pills and cards draw `envVerdict` (`repo-apps.md` › The Overview: Healthy only on passing checks,
else Live). Without facts the verdict is a status mark,
never a pill (`ENV_VERDICT` in `web/src/repo.ts` over `kindMark`: Healthy / Degraded / Failing / Down /
Unknown, with what each means in its tooltip — `web-ui.md` › Status marks); a part's line is its label, the
sha (when there is one), "<ago> ago · by <who> · <host>", FAILED in red or a quiet "deploying"; a part with no
deploy reads "No <host> deploy captured yet". A PR's state is the progress glyphs (Draft → In review →
Approved → Merged, Closed the cross), and a stale branch (no commit in 14 days) a warning mark. Whether the
`environments` section is CONNECTED is a separate question: it is `ok` once deploy capture exists for it
(below), any head check is captured, OR a fresh health ping landed — a ping alone connects the card but never
makes it `HEALTHY`. **`deploys` is gated on a narrower flag — deploy capture**: a deploy on record (in flight
included), or a part whose provider reads deploys and was polled SUCCESSFULLY (`last_ok_at`) — so "No deploys
recorded." is something a poll looked for and did not find. A check, a health ping or a failed / skipped poll
is not grounds for it: `deploys` stays `not_connected`. A failed hosting read (the tables missing) leaves the
cards without parts, `deploys` and `providers` `not_connected`, and the dashboard `degraded`.

**The checks column** (`checkState`, `src/repo/reads.ts`): `failure`/`error`/`timed_out` = fail, `pending` =
running, and everything else — `success`, `neutral`/`skipped` (nothing happened), and the abandoned bucket
(`cancelled`/`stale`/`action_required`) — is not failing.

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

**Drift and branches are snapshots, computed off the render path.** `computeDrift` (`src/repo/github.ts`) first
stores the PROMOTION CHAIN (`computeDriftChain`, `src/repo/facts-compute.ts`: one `GET /compare/<next>...<earlier>`
per ADJACENT pair of environments whose branches differ, the ahead commits grouped by PR — the `drift_chain`
snapshot the facts read), then the `drift` section's `RepoDrift` from the chain's LAST step (head = that step's
earlier branch, base = the last environment's — for two environments exactly the old first↔last pair, request for
request): the step's compare, plus a second `GET /compare/<head>...<base>` for the BEHIND side (compare returns only
the AHEAD side's commits), grouped by the PR that landed them (a squash merge's trailing `(#123)`) or as a direct
push. ≤ `driftCompares(N)` = max(2, N) requests. The PR-title lookup fans out in chunks (`fanOut`,
`src/data/sql.ts`) — a compare returns up to 250 commits and D1 caps a statement at 100 bound parameters.
`ahead`/`behind` are GitHub's own TOTALS while `groups` is built from the commits actually returned, so past
the 250 cap the strip's HEADER stays truthful and only the expanded breakdown is partial. Two triggers: a
webhook `push` to a configured environment branch (the never-throwing `refreshDrift`, needs the org's
GitHub credential) and every reconcile; it needs two environments. `computeBranches` pages
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
heals within 6 hours (an admin's "Poll now" runs it too). Every caller needs the org's primary repository and
a GitHub credential (`resolveGithubCredential`: its App installation's token, else its stored `github_token`).
Its arms, each in its own `safely`
block: open PRs (+ the `prs_reconciled` marker), closed PRs, the pre-capture commit window,
completed workflow runs, the failing-job label pass, the environment heads, each environment's head checks,
the `canopy/*` commit statuses, PR reviews, branches, drift (the promotion chain), and the Overview facts'
`not_shipped` and `out_of_step` (below), releases (below) — and, when the caller asks (`runReconcileJob`'s
`scan`: the cron and Sync GitHub, not Poll now), the repo scan (`scan`: one tree read, and only when the default
branch's root tree sha changed, one GraphQL file batch + ≤ 1 describe per connected host; ≤ `SCAN_COST` = 5 —
`repo-apps.md` › Detection). It returns `{ written, unchanged, failed: string[] }` — `failed` NAMES every arm that threw
(`"runs"`, `"checks"`, …); `/admin/backfill` passes that through as its `repo` object and the cron logs
it.
- **The failing-job label pass reads the BACKLOG, not this run's writes**: the ≤5 newest `run` rows of the
  last 7 days whose state is `failure`/`timed_out` and whose `title IS NULL` (`untitledFailedRuns`) each get
  a `fillFailedJob`, so a first Sync's leftovers drain over later ones. (The webhook calls `fillFailedJob`
  itself for a failed `workflow_run` delivery.)
- **A head check run is captured as it is** (name, conclusion, details link, the posting App's slug in `raw`
  — `src/hosting/detect.ts` reads it), never as an environment's deploy; the list item may omit
  `check_suite.head_branch`, so the branch the poll asked for stands in.
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
- **The facts arms** (`not_shipped`, `out_of_step`, after drift — the promotion chain is the `drift` arm; each its
  own `safely`, also run on a push to an environment branch; `FACTS_COMPARE_CAP` = 6 shared): `repo-apps.md` › The
  reconcile's facts arms.
- **The `releases` arm** (`reconcileReleases`, `src/repo/releases.ts`; ≤ `RELEASES_RECONCILE_COST` = 2 — the releases
  list, and the tags query only when there is no release; every row through the gate's release arm; writes the
  `releases_reconciled` marker): `repo-apps.md` › Releases.
- **The `pr_files` arm (Phase E, `reconcilePrFiles` in `src/repo/pr-files.ts`)**: in a repository with two or more
  apps, the open PRs and the PRs merged in the last 14 days whose files were never read for their current head
  (`pr_file_reads.head_sha`) — open first, then merged, newest first — each `GET /pulls/{n}/files` ≤ 3 pages of 100,
  started only while a whole PR (3 requests) still fits the allowance: `PR_FILES_REQUESTS` = 9 (counted in
  `reconcileRequests` — Poll now), `PR_FILES_SYNC_REQUESTS` = 30 for the cron's unit and Sync GitHub
  (`ReconcileLimits`; `reconcileCost` counts the difference). Every list through the gate's PR-files arm.
- Worst case **`reconcileRequests(N)` = 16 + 2N + max(2, N) + 6 + 2 + 9** outbound requests for N environments (39 for two):
  2 PR lists + 1 commit window + 1 workflow-run list + ≤5 job lookups + 1 status list + 1 GraphQL reviews + ≤5
  branch pages + 2 per environment (head commit, head checks), the chain's max(2, N), the facts arms' 6, the releases arm's 2
  and the PR-files arm's 9. Under an admin Sync it shares the invocation with `runBackfill`'s ~13.
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
`runLockedRepoRefresh(env, ctx, handle, Date.now())` → `runRepoRefresh` (`src/repo/cron.ts`) for the
CALLER's org — its repo, environments and stored credentials — which runs its sources **in this order, each in
its OWN guarded arm** (a failure in one never skips another): **health** (`pingHealth`), **usage**
(`runUsagePolls` — the app's metrics), **hosting** (every part, through the hosting providers — present only when
the org has a part; `hosting-providers.md`), **github** (`runReconcileJob` → `reconcileRepo`
with the org's GitHub credential: checks, runs, branches, drift, open PRs, env heads, the `canopy/*` commit statuses,
PR reviews, the facts arms and releases — NOT the repo scan, which an admin runs with Scan again). The result is
`RepoRefreshResult` (`shared/repo.ts`, types only): `UsagePollResult`'s `sapling`, plus `health` — one `PollOutcome` per TARGET (`part` set; `ok` = up, `failed` = down with FIXED
words `timeout` / `HTTP <status>` / `unreachable`; `"not_configured"` with no environment) — and `github`:
`{ written, unchanged, failed }` (`failed` = reconcile's ARM NAMES), `"not_configured"` without a primary
repository and a GitHub credential, `failed: ["unexpected error"]` on an unexpected throw. **The cron
does NOT call it** — its per-tick spreading stands. **Budget: health 2N + usage N + reconcile
(`reconcileRequests(N)`) = `refreshSubrequests(N)` — 45 for two environments, and `SUBREQUEST_CAP` = 100 (a tenth of
Workers Paid's 1,000 an invocation; the cron's own budget is 900 — it was the free plan's 50 until the promotion chain,
the facts arms and releases pushed a five-environment org past it) caps it at N ≤ 11** (99; 105 at twelve — the PR-files
arm's 9 took it from twelve); past that the
github arm is SKIPPED and says so (`failed: ["skipped: would exceed the subrequest budget"]`) rather than
risk the invocation, while health and usage still run. The hosting arm runs only when the WHOLE refresh still
fits (`refreshSubrequests(N)` + a mint + Σ `providerPollCost` ≤ `SUBREQUEST_CAP` — 54 left for two environments), else every part reads `skipped`. **Deliberately excluded**: `recomputeAllProgress`
(UNBOUNDED — the reason it has a tick of its own — and it feeds the Roadmap, not this dashboard),
`pruneRepoCapture` (maintenance, not a refresh) and `runBackfill` / summaries (that is Sync GitHub: My Work's
capture, with its own summary allowance). **That last exclusion has a visible cost**: `runBackfill` is also
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
account id**; `src/repo/github.ts` now LOGS a failed read as its message with the token it was handed scrubbed
(`scrubbedMessage`), never the Error object, since a thrown fetch or a GraphQL `errors` body can quote the
`authorization` header back — and `src/repo/cron.ts` does the same at EVERY log site it has (`scrubbedLog`:
the cron's generic `safely` logger, the job runners and the usage arms), scrubbing every credential the unit
revealed — and the legacy Worker secrets — literally and empty-guarded.
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
timeout`, the usage line as below, a line per hosting provider, `GitHub — 12 new · 240 unchanged` / `✗ failed: runs, checks`
/ `– skipped: …` / `not configured`; a 409 reads "A refresh is already running — try again in a minute.",
any other failure "Poll failed — try again."

**`POST /admin/poll-usage` remains — the narrower, older route** (same gate, no lock): the usage poller only,
via `runUsagePolls(env, ctx, Date.now())` (`src/repo/cron.ts`) for the caller's org — it runs the `:00`
tick's own per-environment job (`usageForEnv`) for each of the org's environments; the SPA no longer calls it.
**Idempotent with the cron**: the poller keys on the HOUR FLOOR of `now` and every write is `INSERT OR
IGNORE`. **N subrequests** (2 for two environments; no health pings). The poller returns one `PollOutcome`
per environment (`shared/repo.ts`, types only: `ok` with `written` = NEW `repo_metrics` rows — `0` is a
legitimate re-poll; `failed` with `detail` = the SAME scrubbed message it logs; `skipped` with a few fixed
words — `apiUrl` not https — or no token for THAT environment while another has one), and `UsagePollResult`
is `{ sapling }`: those outcomes, or `"not_configured"` when NO environment of the org has the credential —
exactly when the cron skips it. The response is 200 even when the source failed (the body says so), 502
`{ error: "poll failed" }` only if `runUsagePolls` itself throws, never a 500 — and it never carries a token
or a header. In the strip the line is labelled "App metrics" (one response carries active users AND product
metrics); an `ok` outcome's `detail` (dropped product keys) and a `failed` outcome's partial `written` are
both shown.

**A host's usage is a hosting provider's** (`hosting-providers.md`): the legacy `pollCloudflare` /
`pollRailway` (and the `cf_polled` coverage snapshot they kept) are gone with 0057, whose rows became
`hx_requests` / `hx_errors` / `hx_cpu` / `hx_mem_mb`; a Cloudflare or Railway part's covered interval is its
`hosting_poll_state` row like any other part's.

**The Usage compare — requests and error rate are the environment's WEB parts, summed** (`projectUsage`,
`src/tools/repo.ts`). Each environment's `requests` / `errorRate` are its web parts' hourly `hx_requests` /
`hx_errors` (whoever hosts the part; a service part and a part of another environment never count), each
part's covered interval its last poll's `covered_from` / `covered_to` (`hosting_poll_state`, current provider
only). The render costs **ONE statement** for every range, environment, part and series — `metricsSince`
(`src/repo/store.ts`), sliced in memory. It takes GROUPS, each with its OWN bound (`(metric IN (…) AND at >= ?)
OR (…)`, `usageReadGroups`): the web `hx_*` series and `active_users_30d` over 30 days, `active_users_7d` over
7, `active_users_24h` over 24 hours, and the service gauges (`hx_cpu` / `hx_mem_mb`) over 24 hours — plus ONE
`metricsEver` only on the not-`ok` path (`USAGE_METRICS`: `hx_requests`, `hx_errors`, `active_users_*`). The
covered intervals come from the hosting read the cards already made. Nothing reads `cf_*`, `rw_*` or the
`cf_polled` snapshot any more. A range is its last N COMPLETE hours (24 / 168 / 720) in equal buckets (1h / 24h
/ 24h) ending at the last complete hour, never at UTC midnight. Per part the trend is DENSE but zero only where
a zero is entitled (`knownStretch`, the same rule as the providers section): the fill STARTS at the first
captured point (or the range's start when capture predates it) — **unless that would cross a HOLE** (an hour
before the covered `from` with no real point: nothing ever looked at it), in which case it starts at the
covered `from` — and ENDS at `max(covered to, the last real point + 1h)`, clamped to the last complete hour;
with no covered interval it ends at the last real point, so a dead poll draws no zeros after it. **A covered
interval is evidence** (the provider's contract, `src/hosting/types.ts`: inside it, an hour with no point is a
true zero) — but only for a metric the provider READS (its capabilities, minus what its last poll called
`unavailable`): a quiet, freshly polled Cloudflare part reads "0"; a Vercel part's coverage proves nothing about
requests. **Summing**: a part counts in a range only when something about it is known there (else it is left
out — it says nothing, it is not a zero); the trend is drawn over the INTERSECTION of the counted parts'
stretches (a bucket is a sum only where every summed part is known; an empty intersection draws no trend);
**the first bucket drawn is the first WHOLE one** (a 7d/30d day-bucket capture or coverage began inside is
counted in the total but not drawn). Totals are sums of real points only. `requests` is non-null when some web
part is known in the range — otherwise `null`, never "0". `errorRate` needs a real request point in range AND
known errors for every counted part (its provider reads errors, or it has an error point): points summing to
0 requests read "0.00%", but with NO point 0 of 0 is not a rate → `null` (the screen shows "—" beside live
requests). `usage` is `ok` when any metric of any range is non-null. **A per-metric `null` does not say WHY**,
so each `RepoUsageEnv` carries `seen: { requests, users }` — whether any of that environment's web parts has an
`hx_requests` point / any `active_users_*` point exists AT ALL in the one 30-day read, the same in every range.
`null` + seen renders **"no recent reading"**; `null` + not seen renders **"not connected"**; the error rate
follows `seen.requests`, keeping its "—" beside live requests. `seen` looks back those 30 days only: a source
silent for longer reads "not connected" per metric again while the section-level `metricsEver` (any age) still
says `empty` — whose copy is "No current usage reading — the hourly polls have gone quiet." Tests:
`test/repo-dashboard.usage.test.ts`.

**Active users come from Sapling's own backend** — the one number Trov CANNOT compute. `pollSaplingMetrics`
sends `GET {cfg.apiUrl}/api/internal/metrics` with `Authorization: Bearer <token>` — the org's
`metrics_endpoint` secret stored for that environment (set from a part's editor — opened from Org settings ›
Repositories › a repo › Apps, or Hosting's checklist — since repo-setups Phase 0; SaplingLearn's fallback:
`SAPLING_METRICS_TOKEN`) —
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

**Contract v3 — self-described groups** (repo setups, Phase G; `docs/superpowers/specs/2026-10-15-app-metrics-v3.md`).
A body with `version: 3` may name the `part` it reports and a `label`, leave `active_users` out, and carry `groups` —
each with its id, label, SHAPE (`ranked` / `stats` / `figure` / `status`), note, and metrics all windowed (`values`) or
all point-in-time (`value`), each with its own label, `format: "cents"` and (status) `tone: "neutral"`.
`appMetricsV3` (`src/repo/poll.ts`, pure) judges them per group and per metric under v2's key pattern, value rules and
shared caps; values are stored exactly as v2's (`sap_c_*` / `sap_t_*`), the DESCRIPTION (never a value) as the
environment's `app_metrics:<env>` snapshot — rewritten by every v3 body, DELETED by a v1 / v2 one. v1 and v2 parse
unchanged. `projectProduct` puts the described groups FIRST, in the body's order, with `shape` / `now` / `note` / `tone`
(`RepoProductGroup`, `RepoProductCount`) and the body's `version` / `part` / `label` on the environment; a key a v3
group names leaves the v2 grouping. One more statement: `snapshotsByPrefix` (a key range over `app_metrics:`).
**Trov's own `GET /api/internal/metrics`** answers v3 for ONE organization (`src/internal-metrics.ts`,
`src/data/own-metrics.ts`): the bearer class — a Trov MCP credential, the organization chosen only by
`resolveBearerTenant` (`src/data/bearer.ts`); anything else a bare 401, `GET` / `HEAD` only, `Cache-Control: no-store`,
D1 only, counts only (people, live docs, awaiting review, in triage, open tickets, agents connected; MCP tool calls
ranked; doc proposals staged / promoted / rejected and items sent to triage; sessions recorded, people active — the
meter's windows are whole UTC days and say so). Tests: `test/repo-poll.v3.test.ts`, `test/internal-metrics.test.ts`.

**On screen the Usage tab is a hierarchy, not tables** (`web/src/repo.ts`): the TARGETS (repo setups, Phase G — the
design's UsageTarget, `web/src/repo-usage.ts`) → the EXTRA families of the parts that carry them → ONE **Product**
section → the Hosting section. **A target is a part** (an app in an environment), narrowed by the App menu (Repo-wide
only has none, and says so); with facts (every Worker payload now, and the sample) the targets are the facts' parts, each with its providers
figures when the section carries it, else `partFromFacts` (no figure). A card is in exactly ONE of four states
(`targetState`), read from the part's role, `families` (what its provider reads — shared/usage-families-core.ts),
`connection` (THE status function) and figures — NEVER its provider id: figures for the range (`ok`: requests and
error rate with their lines, p95 latency and bandwidth only when the payload carries them, Active users on the
environment's FIRST web target when the app's endpoint has ever reported them; a service's CPU and memory with their
24-hour gap lines); "No recent reading" (`stale` — read before, or connected and not read yet, with the last poll's
age); "Not connected" (`nc` — the host is not connected; an admin outside the sample gets Connect <host> → Org settings ›
Hosting, a member reads who does it); "Not available from <host>" with its reason (`na` — the host has nothing Trov can
read for the role: Vercel, Netlify, GitHub deployments). A repository never reads "not connected" for a thing it does
not have (`test/render.repo-usage.test.ts`, every scenario × variant). Then, per target whose card is `ok` / `stale`,
the blocks of its EXTRA families (`usageExtras`): requests by OUTCOME (a bar and a legend in Cloudflare's own outcome
names, shape marks, "not an HTTP status" — no 4xx / 5xx, ever), the Worker's runtime (CPU time p50 / p99, wall time p50
of the last completed UTC day, subrequests in range, the CPU p99 daily line), each D1 database (read / write queries,
rows read / written over the range's completed days, the size, the reads-per-day line), and the cron triggers (runs,
failed — red when any —, last run). A family never read is not drawn; one the provider could not read says "Not
available from <host>: <reason>" (a Worker with no D1 id: "no D1 database is named for this part"). Product shows ONE environment,
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
compacted or dollar figure counts up without the browser ever re-deriving the Worker's string. A contract-v3 group is
drawn BY ITS SHAPE, never by id or key (`shapedGroups`): a point-in-time `stats` group as a strip titled by the group,
`ranked` as the bar list, `stats` as stat pairs, `figure` with its FIRST metric as the feature figure, `status` with its
metrics' own tones; they come first, two to a row, then the v2 groups as above; the header reads "Product · <label>".
Infrastructure is the ONE Hosting section (`providers`, `hosting-providers.md` › Repo dashboard › Usage › Hosting).

**Pruning** (`pruneRepoCapture`, `src/platform/sweeps.ts` — the retention constants in `src/repo/store.ts` —, the
cron's 6-hourly `:30` tick): `health_*` metrics
and `check` rows older than 45 days — the `check` deletion ONLY `WHERE part IS NULL`, because a FRONTEND
deploy record IS a `check` row (`part = 'frontend'`) and must be kept forever like `deploy` rows; and the
HOURLY usage metrics (`hx_*` / `active_users_*`) older than 100 days; and `sap_*` product metrics
older than **7 days, EXCEPT the rows stamped exactly 00:00 UTC, kept 100 days** (the daily totals the trend
reads — `sap_*` and the usage globs never match each other's names); UNTAGGED `deploy` rows (`env IS NULL`: the
GitHub deploy signals) older than 90 days (`DEPLOY_SIGNAL_RETENTION_DAYS`); and `hosting_deploys` older than 180
days by the provider's creation instant. `pr` / `push` / `run` / `review` rows, a `deploy` row tagged with an
environment (from before 0057) and `coverage` / `bundle_kb` / `todo_count` match no rule and are kept forever. Which
files a commit touched (`commit_paths`, by the commit's own `at`) and a PR's files (`pr_files` / `pr_file_reads`, by
the read's `fetched_at`) go after 100 days (`COMMIT_PATHS_RETENTION_DAYS`, Phase E); a PR still open past that is read
again.

**Written by Trov — `state` and `themes`** (`shared/repo.ts`, typed in `shared/ai-core.ts`): Overview's first
block ("State") and Planning's ("Where the work went", per range). They are NOT sections, so `REPO_TAB_SECTIONS`
does not name them, and absent means off / nothing written — never a `not_connected` section. **`state` is not
written yet** (production omits it). **`themes` is** (`src/tools/themes.ts` `readRepoThemes`, called at the end of
`getRepoDashboard`, so the route and `get_repo_dashboard` get the same field): a D1 aggregation on read — merged PRs
per theme per UTC Monday week from `pr_themes`, a proposal's lane from the PRs it cited, the newest caption on the 8-week
range — present only while the org's AI switch is on and the primary repository has an active theme or a proposal
waiting on an admin; a failed read leaves it out and sets `degraded` (`ai.md` › Themes). `LOCAL_AI_PREVIEW` replaces both
with the fixtures under `wrangler dev` only, never over MCP (`ai.md`). When the dashboard has them,
`get_repo_dashboard` carries `state` with `tab: overview` (or no tab) and `themes` with `planning` (or no tab).

**The Overview from facts** — whenever the payload carries `facts` (every Worker payload now, and the sample) the
Overview is `overviewFacts` (`web/src/repo-overview.ts`), else the older section-built Overview: the composition, the
blocks, the verdict, Needs attention, the connect card, week tiles, the header's repository / App menus and Group by,
the address `#repo[/<tab>]?repo=&app=`, the admin's default Group by (`repo_settings`) and the sample's scenario switch
are `repo-apps.md` › The Overview.

**`get_repo_dashboard` is the Repo dashboard's read over MCP, for every principal too** — it exposes nothing
a signed-in member cannot see at `#repo`, and nothing per-user. `src/tools/repo-agent.ts` is a VIEW over
`getRepoDashboard` (the same D1-only projection the route serves — never a second projection, never a
fetch): `tab` returns only that tab's sections via `REPO_TAB_SECTIONS` (`shared/repo.ts` — the ONE
section→tab mapping, also read by the screen's "not connected" footer, and compile-time exhaustive over
`RepoDashboard`'s sections — the usage tab is `usage`, `providers`, `product`; the old `cloudflare` / `hosting`
sections are gone); `range` (default `7d`) collapses `usage`, each `product` count and each provider part's
`traffic` to that one range; `include_trends` (default `false`) governs every `trend` array and the drift breakdown —
drift is the one section with no small bound, TWICE over (up to 250 commits a side, and one group per
squash-merged PR among them, on the OVERVIEW tab), so without the flag a group carries `commitCount` instead
of its `commits` AND only the first `DRIFT_GROUP_LIMIT` (20) groups travel, with `groupCount` the full number
beside GitHub's own `ahead` / `behind`; with it, every group and its commits. A section's STATUS is never
touched — `not_connected` / `empty` pass through, never coerced to zeros — and the tool's description says
the same of a `null` INSIDE an `ok` section (`usage[].requests`, a `product` value, `contributors[].reviews`,
`ciFailures.rate`, `prs.openCount`, a delta): unknown, never zero, with `usage[].seen` saying whether the source ever
reported. A projection throw is the degraded empty payload, not an MCP error. The view is per-call and only
serialized — it SHARES structure with the projection, it is not a deep copy. **`repo` and `app`** (repo setups)
pick the repository and narrow as the route does (an unknown `repo` reads the primary — see the facts above). With
`tab` overview or no tab the view carries **`facts`** and **`layout`** = `layoutOf(layoutInputOf(facts),
facts.groupDefault)` — the shared core the screen runs (`web/src/repo.ts` `factsView`), so the same facts draw the
same opener on both (`test/repo-facts.parity.test.ts`, every scenario × variant × App × default Group by, is THE
parity guard). Without `include_trends` each commit group in `facts` (not shipped, drift) carries `commitCount`
(first 20, `groupCount` beside) and each part's `history` its newest 2 (`historyCount`); apps, environments and
parts are never cut. The pure view is `src/tools/repo-agent-view.ts` (shared types only). Output: `{ repo,
generatedAt, degraded, tab, range, sections, facts?, layout? }`.

## Written by Trov: State and Where the work went (`web/src/repo-ai.ts`)

Two OPTIONAL fields of the dashboard read, not `RepoSection`s (`shared/repo.ts`): `state?` (`AiRepoState`) and
`themes?` (`Partial<Record<AiThemeRange, AiThemes>>`). Each is drawn as its own card ABOVE the tab's one panel (the
mock's layout), only on a live dashboard (never on sample data, never with no repository connected), and only
when present — absent, the tab is byte-for-byte what it was (`test/render.ai-absent.test.ts`).

- **Overview › State**: an 18px headline; three wrapping columns — Shipped recently (the done glyph, green), In
  flight (the half glyph, blue), Needs attention (the warning glyph, amber) — each line with its sources; "Written
  by Trov from N events, 2h ago" (no "from N events" when `eventCount` is null) and "Wrong?". Empty: "Trov writes
  this after your next merge: what shipped, what is in flight, and what needs attention, each linked to its
  source." Capped: the headline and "this state is from <day> and resumes <day>".
- **Planning › Where the work went**: title, caption, "Themes and caption written by Trov from N pull requests",
  an 8 weeks / Quarter `segmented()` switching between `themes["8w"]` and `themes.quarter` client-side
  (`state.ai.themesRange`), and Edit themes for admins (it goes to the proposed themes; with none it says editing
  is not available yet). A lane per theme in `--p-<colorKey>`, a band per week sized against the busiest week in
  view (zero = no band), weeks labelled "Aug 24". Picking a lane (`aria-pressed`) fades the others and shows its
  description and pull requests under the chart. **Proposed** lanes (`status: "proposed"`) are suggestions:
  "Trov suggests these themes", each an `aiSuggestionChip` with Accept / Rename (an inline field, then accept
  with `{ value: { name } }`) / Remove (dismiss) for admins; a member reads "Waiting for an admin to accept
  themes". A 409 `not_available` shows "Not available yet". Empty: "Themes appear once this repo has 15 merged
  pull requests." Accept / Rename / Remove are an admin's on the server too (the `themes.propose` handler's `role` and
  `dismissRole`, `src/ai/themes-accept.ts`); production sends the field only when there is a lane to draw, so the
  empty state is the preview's.
