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
`repo-sample.ts` also holds the Repo-setups design's scenarios A–N (`repoScenario(key, variant, { now, app })`,
`REPO_SCENARIOS`, `SCENARIO_TITLES`, `SCENARIO_VARIANTS` — the design's variants plus G `signals`) as
`RepoFacts` (`shared/repo-facts-core.ts`), narrowed by `narrowFacts` exactly as the server narrows (`app` = an
app key, `REPO_WIDE` = no app rows, only the PR / CI-level facts). `test/repo-sample.scenarios.test.ts` holds
every scenario × variant × App narrowing × Group by to the design's own `buildScreen` (same rule, opener and
Group by from `layoutOf(layoutInputOf(facts))`), and checks unknown stays `null` and every part's app and
environment exist. H's Cloud Run app uses provider `github` through a cast until Phase A adds it.

**The Overview's facts (Repo setups, Phase B)** — `facts: RepoFacts` on the payload (`GET
/repo/dashboard?repo=&app=` and MCP `get_repo_dashboard`), assembled INSIDE the one projection by
`readRepoFacts` (`src/tools/repo-facts.ts`) from the reads `getRepoDashboard` already made (parts, hosting reads,
branch heads and their checks, health rows, the PR / commit / run gates) plus its own: the repository's apps
(`listRepoApps`, `src/repo/apps-read.ts` — the read half of `apps.ts`, split so nothing reachable from MCP imports
the settings module), `factsDeploys` / `deployWeekCounts` (`src/repo/facts-store.ts`, one statement each),
`runCounts`, `readRepoSettings` (the admin's default Group by → `groupDefault`) and three snapshots. Then
`narrowFacts(facts, app)`. A throw there costs the facts alone (`emptyRepoFacts`, `degraded: true`).
- `?repo=` is checked against `org_repos` (any case; absent → the primary; unknown → **404 `{ error: "unknown
  repository" }`**). MCP's `repo` doubles as the connection scope's argument (an agent passes its checkout on
  every call), so there an unknown one reads the primary and the output's `repo` says which. `?app=` is an app
  key of that repository or `__repo` (`REPO_WIDE`); an unknown key reads as every app (`facts.app: null`). The
  app ALSO narrows the per-part sections (environments' parts, `deploys`, `usage`, `providers`): an app IS a part
  key, so they keep that key's parts (`REPO_WIDE`: none). The other sections stay the org's capture.
- **apps** — `repo_apps` rows of the repository plus a part key with no row (`source: "implicit"`, at the primary's
  root); `previews` = a preview landed in 30 days; `openPrs` = the open-PR count for a repository's only app,
  `null` with two or more (which PR touches which is Phase E's). **envs** — only those with a part of the apps in
  view, `position` the org's. **parts** (app × environment, apps' order then promotion order) — `serving` the
  newest `ready` production deploy of the part's CURRENT provider (any age), `latest` the newest when it is not
  that one, `history` the last ≤ 20 settled oldest first (a previews-only part reads its previews, as
  `hostingReads` does); `connection` from the one status function (`partConnectionOf`); `reportsDeploys` /
  `reportsMetrics` from the registry's capabilities; `viaGithub` for a `github` part, or a GitHub-sourced serving
  deploy while the host is not live; `via` the workflow / environment / check a `github` part names.
  **health** — the environment's two pinged targets (`frontend`, `backend`) are a part's only when the part
  carries that key, or is the ONE part of the target's role in the environment and no other part carries the key
  (two web parts: no health, never a guess); stale past 30 minutes (`stale: true`, shown as neither up nor down).
- **previews** — a production part's `target = 'preview'` rows of 30 days, newest per branch, matched to OPEN PRs
  by head branch from captured `pr` rows; a branch whose PR merged or closed (and none is open) is left out;
  `failStreak` counts consecutive `error`s from the newest; ≤ 20 per app.
- **notShipped** — one per part; the snapshot's entry only while the part still serves the sha it was computed
  for, else `count: null`. **outOfStep** — an environment's rows only while its apps still serve the shas they
  were computed for. **drift** — the chain's steps between two shown, adjacent environments of the current
  config. **ci** — per shown environment (every environment for a packages-only repository): head checks, `fail`
  with its failing names, `running` with `total` / `failing` null, `pass`, or all-null when nothing is captured.
- **week** — all seven `WeekKey`s: `mergedPrs` (`events`, null until one was ever captured), `deploys` /
  `failedDeploys` (settled production deploys of the parts in view, null with no deploy capture; a delta only when
  every counted part's capture began two weeks ago, `MIN(recorded_at)`), `openPrs` (the `prs_reconciled` gate and
  its recording window), `commits` (the Commits tile's gates), `releases` (`releaseWeekFigure`, Phase F), `ciRuns` (`run` rows;
  delta when `recordingSince('run')` predates two weeks). A null value has a null delta.
- **attention** (structured; worded in the SPA), most urgent first: `down` (fresh health down), `failed` (the
  newest production deploy errored: `failedSha`, `sha` still serving, `reason`), `rolledBack` (the serving deploy
  has `rolled_back_from`), `outOfStep`, `stale`, `degraded` (an environment's CI fails; `app: null`), `waiting`
  (not shipped > 2 and the oldest > 1 day), `previewFailing` (a streak ≥ 3; `env: null`). **connect** — admins
  only: the first host in part order that is not connected (`not_connected` / `revoked`, never a `github_app`
  provider), `need: "metrics"` when GitHub already gives every such part its deploys, else `"deploys"`.
- **The PR / CI facts are the PRIMARY repository's capture** (reconcile and the webhook capture one repository per
  org): for another connected repository `ci`, `drift`, `outOfStep` are empty, `notShipped` counts and the PR /
  commit / CI week figures null — its own parts, deploys and previews are its own. `release` is `readRelease(ctx, repo,
  app)` (Phase F, `src/repo/releases.ts` — narrowed by the app's release signal when the App menu names one) and the
  `releases` week figure `releaseWeekFigure` (null until reconcile read the repository's releases); `found` / `unseen`
  stay null until Phase D.

**The Overview's deploy blocks** (Repo setups, Phase C) are `OverviewBlock`s — `(facts, ctx) => html`
(`web/src/repo-overview-ctx.ts`) — each in its own module and its own `trov.css` section, worded in the SPA from
`RepoFacts` (nothing arrives worded): `envCardsBlock` (`repo-env-cards.ts`: a card per environment in promotion
order, a row per part in the apps' order — sha, "<age> ago · by <who> · <host>[ via <workflow> | via GitHub]",
URL, ms / Down / "Reading 34m old", a failed line with the reason and what still serves, a building line, a
rollback line, the out-of-step flag; a part with no deploy is Unknown and says why — "<host> does not report
deploys to GitHub" when its host is not connected — and the CI line worded from `FactsCi`, "<check> running on
<sha>" while a running set has no total), `driftBlock` (`repo-drift.ts`: one strip, or the chain form for three or
more environments), `appsTableBlock` (`repo-apps-table.ts`: worst first — failed, building, waiting (> 2 commits),
unknown, live — Production, then Previews or the other environment, then Not shipped; a missing or `null` count
is "Unknown", never "Up to date"; then the packages) and `notShippedBlock` (`repo-not-shipped.ts`: one deployed
app → its production entry, "<app> is up to date in Production" at 0; several → the one with the most commits
waiting, only when its commits are listed — E's web; nothing for a `null` count). The environment verdict is ONE
function, `envVerdict(f, env)` (`repo-verdict.ts`, the design's `verdictFor`: unknown, down, failing, out of step,
degraded, then Healthy only on passing checks, else Live — never Healthy on unknown checks; the header's
pills and every block draw its tone and shape). What they share is `repo-block-kit.ts`: ONE table of the design's `MARKS` (`REPO_MARK`, drawn through marks.ts
`stateMark` / `markShape` with the design's shape and tone per state — Building a blue ring pulsing by
`.repo-kit-pulse`, still under reduced motion; `deployMark` is the same table), the sha chip (`shaOrNone` says "no
commit" and why), the byline
person (people.ts, never in sample mode), a URL that never links out in sample mode, and the commit groups drift
and not-shipped both list. A disclosure is ONE act, `repoOpen` with the block's key in `data-arg`
(`drift:<from>><to>`, `ns:<app>><env>`), read back from `ctx.open`; its panel is always emitted and shown by
`data-open`. Tests: `test/render.repo-env-cards.test.ts`, `render.repo-drift`, `render.repo-apps-table`,
`render.repo-not-shipped` (every scenario × variant, narrowed facts).

**The Overview's blocks (Repo setups, Phase C)** are `OverviewBlock`s (`web/src/repo-overview-ctx.ts`: `(facts,
ctx) => html`), one module each, drawn from `RepoFacts` alone — every sentence is made in the block, nothing is
pre-worded by the server, and each returns `""` when its facts are absent:
- **R4** `productionBlock` (`repo-production.ts`): the one app's part in the one environment — the verdict
  (`envVerdict`, `repo-verdict.ts`), the serving row (sha or "no commit", age, who via people.ts, host and
  `via`), the URL and its health (ms; "Reading 34m old" when stale; Down), a failed or cancelled newest deploy
  ("e07b3a2 failed 12m ago", its reason, "c41e7d9 is still serving."), a deploy in flight as the Next row, a
  rollback ("Rolled back from …"), CI on the head (`ciLine`: a count only when one is known — a running set
  says "Checks running on …"), and the strip: `history` plus an in-flight `latest`, ≤ 20, newest right, ready
  green / error red / building blue and pulsing (`.repo-kit-pulse` on a mark; the strip square blinks, both still under reduced motion) / rolled back amber
  / canceled grey, with its sentence ("Last 20 deploys · 17 live, 1 failed, 1 rolled back, 1 building"). A part
  with no deploy reads Unknown and why ("<host> does not report deploys to GitHub" when its host is not
  connected and nothing came via GitHub).
- `previewsBlock` (`repo-previews.ts`): "Previews · N open", a row per preview (a live one unmarked), the
  failing streak only from two failures ("Failing for 3 days, last 4 builds"); nothing at all when no app in
  view has previews, "No open pull requests, so no previews." when one has and none is open.
- **R3** `releaseBlock` (`repo-release.ts`): tag, age in words, date, who, notes; since (commits / PRs, "—"
  when unknown); the waiting PRs (merged glyph, "feature" only where `feature: true`); the cadence strip over
  the last 100 days (wider for an older history) and the gaps sentence derived newest first.
- **R1** `foundBlock` / **R2** `unseenBlock` (`repo-found.ts`): the suggested apps with Accept / Ignore for an
  admin (`repoFoundAccept` / `repoFoundIgnore` + the suggestion id, wired in Phase D; disabled in sample mode)
  and the seen deploy names; or what Trov looked for and what it does see (tags, PRs, CI workflows, GitHub
  deployments in 30 days), the latest tags, and "Add an app by hand" (admin → Org settings › Repositories).
Shared pieces (`repo-block-kit.ts`): the design's deploy-state `MARKS` on `stateMark` shapes, links that are
https only and plain text in sample mode, a handle as a person link (plain in sample mode).

Three capture shapes feed it: `repo_events` rows (through the `ingestRepoEvent` gate — see Core invariant),
`repo_snapshots` (one JSON row per kind: `prs_reconciled`, `env_heads`, `drift`, `branches`, and the Overview
facts' `drift_chain`, `not_shipped`, `out_of_step` (`src/repo/facts-store.ts`) —
plus the transient `refresh_lock`, which is "Poll now"'s lock and feeds no section) and
`repo_metrics` points (`putMetric`). Every section, its source, and what triggers the capture:

| Section (tab) | Source | Trigger |
| --- | --- | --- |
| `stats` tiles (Overview) | open issues / bugs from `events` issue snapshots (latest per issue, now vs 7 days ago, read with `json_extract` so bodies never leave D1); Open PRs / Awaiting review from `repo_events` `pr` | webhook `issues`, `pull_request`; reconcile PR lists |
| `environments` | every part of the environment (`org_environment_parts`, any host) with its newest `hosting_deploys` row, a part's successful poll (`hosting_poll_state`), head checks, fresh `health_*` metrics | cron `:40` — `pollPart` per part; webhook `check_run`; reconcile `env_heads` / `checks` arms; cron health ping |
| `drift` | snapshot `drift` | webhook `push` to a configured environment branch; reconcile `drift` arm |
| `health` | metrics `health_up` / `health_ms` | cron, every tick |
| `codeStats`, `bars`, `prs` (Code) | `repo_events` `pr` / `push`; merged/closed PRs in `events` as the fallback | webhook `pull_request` / `push`; reconcile open + closed PR lists and the pre-capture commit window |
| `branches` (+ the Active branches tile) | snapshot `branches` | reconcile `branches` arm only |
| `deploys` (CI) | each part's settled `hosting_deploys` rows (a dot strip per part); checks and health excluded | cron `:40` — `pollPart` per part |
| `ciFailures` | `run` rows | webhook `workflow_run` (+ `fillFailedJob`); reconcile `runs` + `job_titles` arms |
| `coverage`, `bundle` (CI); `todos` (Planning) | metrics `coverage` / `bundle_kb` / `todo_count` | a `canopy/*` commit status the target repo's CI posts — webhook `status`; reconcile `statuses` arm |
| `activity` | PR closes + issue moves from `events`; webhook `push` rows, `review` rows, landed deploys | the captures above |
| `usage` (Usage) | each environment's WEB parts' `hx_requests` / `hx_errors` summed (requests, error rate; covered intervals from `hosting_poll_state`) and `active_users_*` | cron `:40` — `pollPart`; cron `:00` — `pollSaplingMetrics` |
| `product` (Usage) | metrics `sap_c_<key>_<24h\|7d\|30d>` / `sap_t_<key>` — whatever keys the app reports | cron `:00` — `pollSaplingMetrics` (the same response as active users) |
| `providers` (Usage — the tab's ONE Hosting section, `web/src/repo-hosting.ts`) | every part of every environment, provider-neutral (Cloudflare and Railway like the rest): `hx_*` metrics, `hosting_deploys`, `hosting_poll_state` | cron `:40` — `pollPart` per part |
| `release` (Overview R3), `unseen.tags`, week `releases` | `releases` (0074): `readRelease` / `readTags` / `releaseWeekFigure`, `src/repo/releases.ts`; `since` / `waiting` from `repo_events` `push` / `pr` | webhook `release` / `create` (gate: `ingestRepoRelease`); reconcile `releases` arm |
| `sprint`, `labels`, `contributors` (Planning) | live D1: the sprint a person marked `active` (the Roadmap's `sprintProgress`); open-issue snapshots; webhook pushes · merged PRs · `review` rows this week | none / webhook `issues` / `push`, `pull_request`, `pull_request_review`; reconcile `reviews` arm |

"Reconcile" is `reconcileRepo` (`src/repo/github.ts`), run by an admin's Sync GitHub and by the cron's
6-hourly `:20` tick; "cron" is the `*/10` repo trigger — both below. **Everything the cron and reconcile
capture also runs on demand from an admin's "Poll now"** (`POST /admin/poll`, below: health pings, the three
`:00` pollers, reconcile) — and reconcile reads EVERY GitHub input the dashboard has, including the two that
used to be webhook-only (`canopy/*` commit statuses, PR reviews). What stays webhook-only is `issues`, which
feeds `events` (My Work's capture, refreshed by Sync GitHub). The capture names a PR's AUTHOR and an
issue's subject, not who merged/closed, so the feed never claims an actor it does not have.

**Releases and tags (Repo setups, Phase F — `releases`, 0074; `src/repo/releases.ts`)** feed R3, the unseen card's
tags and the week tile `releases`. Capture is gated: `release` (published / released / prereleased / edited →
upsert; deleted / unpublished → the row goes; a DRAFT never) and `create` of a tag (dated by the delivery's
`repository.pushed_at`, else nothing) are derived by `releaseEventsFromDelivery` and put through
`ingestRepoRelease` (`src/consumer.ts` — identity `(org, repo, tag)`, content-hash dedupe; a tag never
downgrades a release; a release over a tag row keeps the tag's sha), then written by
`src/repo/release-store.ts`; reconcile's `releases` arm is the backfill (below). `author` is a GitHub login,
mapped to a person on read. The reads, D1 only:
- `readRelease(ctx, repo, app?)` → `FactsRelease | null`: the newest published non-prerelease release — or, for a
  repository with no release, its newest tag (notes only for a release: headings and comments dropped, ≤ 280
  characters). `app` narrows by that app's `release_signal` when it reads `tag:<glob>` (SQLite GLOB). `since`
  is counted on the default branch (the first environment's, else `main`) from the push that carried the tagged
  commit when one was captured, else from the release's date: `commits` sums captured pushes after it, `prs`
  counts PRs merged into that branch after it (`raw.base`; a PR's merge is its FIRST merged row) — each `null`
  unless its capture was recording by then (`recordingSince`), never a partial count. `waiting` lists those PRs
  newest first (≤ 10; listed even when the count is unknown — they are facts). **`feature: true` ONLY by
  `isFeaturePr`**: a `feat:` / `feat(scope):` title prefix (any case) or a label named `feature` / `enhancement`
  (any case) — PR labels are now kept in the `pr` row's `raw.labels` by the webhook and the PR-list backfill.
  `cadence` = the ≤ 8 releases before it, newest last.
- `readTags(ctx, repo)` → `FactsUnseen.tags` (also `RepoAppsSetupDTO.tags`): every tag held, releases included.
- `releaseWeekFigure(ctx, repo, now)` → `{ key: "releases", value, delta }` over the same pool: `null` until the
  `releases_reconciled` snapshot names the repository (before a read, 0 would be a guess).

**Owner prerequisites — what must be true OUTSIDE this repo** (the one place they are listed):
- **The target repo's GitHub webhook must be SUBSCRIBED to every name in `REPO_EVENT_NAMES`**
  (`src/webhook.ts`; for an org connected through the GitHub App the subscription is the App's own event
  list, set once on the App — `github-app.md`): `pull_request`, `push`, `pull_request_review`, `check_run`,
  `workflow_run`, `status`, `deployment_status`, `deployment`. Every capture arm exists, but GitHub delivers only
  what the hook subscribes to. The App is ALSO subscribed to `release` and `create` (`RELEASE_EVENT_NAMES`:
  releases and tags, Phase F — below) and `workflow_job` (`LATER_EVENT_NAMES`: verified, acknowledged, not
  captured yet). **GitHub deploy signals** (repo setups,
  Phase A — `src/repo/capture.ts`): a `deployment` / `deployment_status` delivery and every commit status whose
  context is NOT `canopy/*` become `repo_events` rows of kind `deploy`, UNTAGGED (`env` / `part` NULL), with
  `raw.signal` = `deployment` | `status` — creator login, environment name exactly as the host spells it, state,
  sha, ref, description, log / environment / target link, the workflow file of an Actions deployment, a status's
  `branches` — through the gate's `ingestRepoEvent` (content-hash dedupe as every repo event), kept 90 days
  (`DEPLOY_SIGNAL_RETENTION_DAYS`; a `deploy` row tagged with an environment from before 0057 is kept). They
  feed detection (`hosting-providers.md` › Detection), a `github` part's deploys (only through its own setting,
  `src/hosting/github-deploys.ts`) and the commit join (`src/hosting/sha-join.ts`) — never an environment's
  deploys by name. Without `check_run` / `workflow_run`, reconcile is the
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
  (`resolveGithubCredential`, `github-app.md`); and, optionally, on Org settings › Integrations, an app-metrics
  token per environment (`resolveCredential`). What HOSTS an environment — Cloudflare, Railway, Vercel, … — is
  its parts, each provider with ONE org-wide credential (Org settings › Hosting, `hosting-providers.md`). The
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
  registry is empty, so today it reads and fetches nothing.

**The budget.** One invocation may spend `CRON_SUBREQUEST_BUDGET` = **900** outbound requests (Workers Paid
allows 1,000 an invocation; D1 does not count) and `CRON_WALL_BUDGET_MS` = 8 minutes of wall clock. `health`
goes first and, on a tick that also has a heavy job, may use at most HALF, so neither starves the other. A
unit is started only while its worst-case cost still fits, what it really spent is counted through the
budget's own `fetch`, and each job resumes after the unit its previous invocation stopped at (`cron_cursor`)
— so more orgs than one invocation can serve lengthen the cycle; they never overrun it. With few orgs every
tick serves every unit and the cursor is never written. The free plan's 50-subrequest cap is NOT what the
cron is sized against any more; it survives only as `SUBREQUEST_CAP`, the ceiling ONE org's on-demand
"Poll now" still honours (below).
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
Workers Builds checks any more. **The pill is a verdict about CHECKS, with health as an override**:
`HEALTHY` needs checks captured on the branch head, none failing, and no failed part; a deploy that landed
with NO checks captured reads `UNKNOWN`; a part whose newest deploy errored is a fact on its own, so
`FAILING` does not wait for checks; failing head checks read `DEGRADED`; `DOWN` OUTRANKS everything — a fresh
health ping saying the environment is unreachable is the headline. On screen the verdict is a status mark,
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
`not_shipped` and `out_of_step` (below) — and, when the caller asks (`runReconcileJob`'s
`scan`: the cron and Sync GitHub, not Poll now), the repo scan (`scan`: one tree read, and only when the default
branch's root tree sha changed, one GraphQL file batch + ≤ 1 describe per connected host — `hosting-providers.md` ›
The repo scan). It returns `{ written, unchanged, failed: string[] }` — `failed` NAMES every arm that threw
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
- **The facts arms** (`src/repo/facts-compute.ts`, repo setups Phase B), after drift, each its own `safely`:
  `not_shipped` — per part of the PRIMARY repository's apps with a serving sha (`servingShas`), `GET
  /compare/<serving sha>...<branch>`: GitHub's `ahead_by` as the count, the commits grouped by PR (`groupCommits`),
  the oldest commit's date. In a repository with ≥ 2 apps the commits are kept to the app's watch paths
  (`src/repo/watch.ts`) ONLY when every returned commit lists its `files` — GitHub's compare does not today (one
  combined list for the range), so the groups stay unfiltered until Phase E's per-commit paths; filtered, the count
  is exact only when the compare returned every commit, else `null`. Incremental: a part is compared again only
  when its serving sha or its branch head (`branchHeads`) changed; never-computed parts first, then the oldest.
  `out_of_step` — per environment whose parts serve different commits (a 7- and a 40-character sha are one): the
  NEWEST serving deploy is the reference and one compare per other distinct sha (`<other>...<reference>`):
  `ahead` → the other apps are behind by `ahead_by`; `behind` (the newest deploy runs older code) → the reference
  apps are behind; recomputed only when the environment's shas changed. Both share **`FACTS_COMPARE_CAP` = 6**
  compares per run (the rest keep their entries and go first next time); each stores what it computed before it
  throws. The same arms run on a push to an environment branch (`refreshDrift(…, pushedBranch)` — not shipped only
  for that branch's parts).
- **The `releases` arm (Phase F, `reconcileReleases` in `src/repo/releases.ts`)**: ONE `GET /releases?per_page=30`
  (drafts skipped; a list shorter than the page is the whole history, so a captured release no longer in it is
  removed) and, ONLY when the repository has no published release, ONE GraphQL page of its 30 newest tags
  (`refs(refPrefix:"refs/tags/", orderBy: TAG_COMMIT_DATE)` — REST `/tags` carries no date; an annotated tag is
  dated by its tagger, a lightweight one by its commit). Every row goes through the gate's release arm
  (`ingestRepoRelease`), so a re-read writes nothing; a successful read writes the `releases_reconciled`
  snapshot (`{ repo }`), the week figure's "read" marker. `RELEASES_RECONCILE_COST` = 2.
- Worst case **`reconcileRequests(N)` = 16 + 2N + max(2, N) + 6 + 2** outbound requests for N environments (30 for two):
  2 PR lists + 1 commit window + 1 workflow-run list + ≤5 job lookups + 1 status list + 1 GraphQL reviews + ≤5
  branch pages + 2 per environment (head commit, head checks), the chain's max(2, N), the facts arms' 6 and the releases arm's 2. Under an
  admin Sync it shares the invocation with `runBackfill`'s ~13.
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
with the org's GitHub credential: checks, runs, branches, drift, open PRs, env heads, the `canopy/*` commit statuses
and PR reviews). The result is
`RepoRefreshResult` (`shared/repo.ts`, types only): `UsagePollResult`'s `sapling`, plus `health` — one `PollOutcome` per TARGET (`part` set; `ok` = up, `failed` = down with FIXED
words `timeout` / `HTTP <status>` / `unreachable`; `"not_configured"` with no environment) — and `github`:
`{ written, unchanged, failed }` (`failed` = reconcile's ARM NAMES), `"not_configured"` without a primary
repository and a GitHub credential, `failed: ["unexpected error"]` on an unexpected throw. **The cron
does NOT call it** — its per-tick spreading stands. **Budget: health 2N + usage N + reconcile
(`reconcileRequests(N)`) = `refreshSubrequests(N)` — 36 for two environments, and `SUBREQUEST_CAP` = 50 (the free
plan's per-invocation cap, which this ONE-org refresh is still held to; the cron's own budget is 900) caps it at N ≤
4** (48; 54 at five — it was N ≤ 6 before the promotion chain and the facts arms); past that the
github arm is SKIPPED and says so (`failed: ["skipped: would exceed the subrequest budget"]`) rather than
risk the invocation, while health and usage still run. The hosting arm runs only when the WHOLE refresh still
fits (`refreshSubrequests(N)` + a mint + Σ `pollCost` ≤ 50 — 13 left for two environments), else every part reads `skipped`. **Deliberately excluded**: `recomputeAllProgress`
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
`metrics_endpoint` secret stored for that environment (set from its parts' editor on Org settings › Hosting since
repo-setups Phase 0; SaplingLearn's fallback: `SAPLING_METRICS_TOKEN`) —
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
compacted or dollar figure counts up without the browser ever re-deriving the Worker's string. Infrastructure
is the ONE Hosting section (`providers`, `hosting-providers.md` › Repo dashboard › Usage › Hosting).

**Pruning** (`pruneRepoCapture`, `src/repo/store.ts`, the cron's 6-hourly `:30` tick): `health_*` metrics
and `check` rows older than 45 days — the `check` deletion ONLY `WHERE part IS NULL`, because a FRONTEND
deploy record IS a `check` row (`part = 'frontend'`) and must be kept forever like `deploy` rows; and the
HOURLY usage metrics (`hx_*` / `active_users_*`) older than 100 days; and `sap_*` product metrics
older than **7 days, EXCEPT the rows stamped exactly 00:00 UTC, kept 100 days** (the daily totals the trend
reads — `sap_*` and the usage globs never match each other's names). `pr` / `push` / `deploy` /
`run` / `review` rows and `coverage` / `bundle_kb` / `todo_count` match no rule and are kept forever.

**Written by Trov — `state` and `themes`** (`shared/repo.ts`, typed in `shared/ai-core.ts`): Overview's first
block ("State") and Planning's ("Where the work went", per range). They are NOT sections, so `REPO_TAB_SECTIONS`
does not name them, and absent means off / nothing written — never a `not_connected` section. **Nothing writes
them yet: production omits both** (`GET /repo/dashboard` and `get_repo_dashboard`); `LOCAL_AI_PREVIEW` fills
them from the fixtures under `wrangler dev` only, never over MCP (`ai.md`). When the dashboard has them,
`get_repo_dashboard` carries `state` with `tab: overview` (or no tab) and `themes` with `planning` (or no tab).

**The Overview from facts (Repo setups, Phase C)** — when the payload carries `facts` (`RepoDashboard.facts`,
`shared/repo-facts-core.ts`; the sample sets it today, the Worker adds it with the facts read) the Overview is
`overviewFacts` (`web/src/repo-overview.ts`), else today's sections. The composition is the design's `buildScreen`,
top to bottom: `<div data-repo-state-slot>` (where #178's `state` block goes), Needs attention, the connect card, the
opener by `layoutOf(layoutInputOf(facts), group).opener` (found / unseen / release / production + previews /
chain and envCards → environment cards + drift / appsTable), not shipped where a part has commit groups waiting, the
week tiles, and the links row. Every block is its own module exporting an `OverviewBlock` (`(f, x) => string`,
`web/src/repo-overview-ctx.ts`) and is wrapped in `data-repo-block="<name>"` (an empty one takes no room); "Repo-wide
only" (`REPO_WIDE`) draws its own note instead of an opener. The frame's modules:
- `repo-attention.ts` WORDS each structured `FactsAttention` (kind + refs, never a sentence on the wire) into the
  design's sentences — "Production deploy e07b3a2 failed 12m ago on Cloudflare Workers. c41e7d9 is still serving." —
  naming the host by its part's `host` label (never a switch on a provider id) and an app first ("api: …") when the
  repository has more than one deployed app. An action leaves Trov only with an https address and outside the
  sample; otherwise it opens the tab that holds it.
- `repo-verdict.ts` `envVerdict(f, envKey)` is THE environment verdict (Unknown → Down → Failing → Out of step →
  Degraded, the design's `verdictFor`; then Healthy ONLY when checks pass on the branch head — with no checks
  captured, or checks still running, live parts read Live, never Healthy on unknown checks), read by the header pills
  and the environment cards alike; `ciLine(ci)` there is the one wording of a branch head's checks ("All 14 checks
  passing on 3e9a1f2", "2 of 9 checks failing on e07b3a2", "Checks running on f19ad20", "<check> running on <sha>").
- `repo-week.ts`: "—" for a null figure (never 0), ▲ / ▼, failed deploys inverted, "vs last week" / "since
  connecting" / "unknown until <host> is connected". `repo-connect.ts`: need `deploys` → the design's G card; need
  `metrics` → deploys arrive via GitHub and the card asks for CPU and memory only; the action (admins) opens Org
  settings › Hosting, members read the note.
- The links row's Usage line reads the parts' `reportsMetrics` capability and `connection`: "from <hosts>", "not
  available from Netlify" (no host in view reports a metric) or "not connected" — so a repository never reads "not
  connected" for a thing it does not have (`test/render.repo-overview.test.ts`, every scenario × variant × app).
- The header (`repo-header.ts`): the repository menu (`dropdown()`, `facts.repos`, only with two or more), the App
  menu (monorepos only: All apps, each app with its folder and open PRs, Repo-wide only), the environment pills, and
  Group by (`segmented()`, only when `layout.canGroup`, above the panel). Repository and app are in the address
  (`#repo[/<tab>]?repo=<owner%2Fname>&app=<key>`, hash.ts; the App menu is left out of the page key) and go to
  `GET /repo/dashboard?repo=&app=`, which the Worker ignores until the facts read lands; the sample narrows with
  `narrowFacts` client-side. Group by is the session's (`state.repoGroup`) over `facts.groupDefault`; after a flip
  an admin (never in the sample) is offered "Make this the default" → `PUT /api/o/:slug/repo/settings
  { repo, overview_group }` (`src/repo/settings-routes.ts`: admin, cookie only, 404 for a repository the org does not
  have, audited `repo.settings` in `org_admin_audit`), stored in `repo_settings` (0071) and read back by
  `readRepoSettings(ctx, repo)` (`src/data/repo-settings.ts`) for the facts read.
- "Preview with sample data" gains a scenario switch: a `dropdown()` per axis in the sample bar — Scenario (A–N) and
  Variant (when the scenario has more than one) — session-only (`state.repoScenario`). The names live in
  `web/src/repo-sample-keys.ts` (no fixture data, like `hosting-keys.ts`), so the switch never pulls the sample into
  the main bundle; a pick recomputes only `facts`, and picking a repository in the sample shows that scenario.

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
