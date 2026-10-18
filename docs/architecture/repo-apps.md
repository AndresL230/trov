# Apps, the Repo Overview's facts and layout, detection and releases (repo setups)

<!-- The area reference for the repo-setups build (handoff #11, `feat/repo-setups`). Keep it current when you change the area. The build spec is `docs/superpowers/specs/2026-10-15-repo-setups.md` (it wins over every other spec), its step-0 fact check `2026-10-15-repo-setups-step0.md`, the design export `docs/superpowers/specs/repo-setups-design/` (`repo-data.js` is the design's data module, `trovData`). The code wins if any of them disagree. -->

The Repo screen used to assume one stack. Repo setups keeps #185's model — org-wide **environments**
(`org_environments`), **parts** (`org_environment_parts`), **provider-first deploys** (`hosting_deploys`,
`hosting-providers.md`) — and adds **apps** on top, one **facts** object for the Overview, layout rules that live
in shared code, a **repo scan** that suggests apps, and **releases**. Neighbours: the dashboard as a whole (capture,
cron, pollers, every other section, MCP) is `repo-dashboard.md`; hosts, connections, the poll, Detected and the
Usage families are `hosting-providers.md`; the App's webhook subscription is `github-app.md`; the gate's release
arm is `ingestion-gate.md`.

Rules this area keeps (CLAUDE.md's invariants, applied):
- **Ingested is gated, computed is direct.** GitHub deploy signals and releases go through `src/consumer.ts`
  (`ingestRepoEvent`, `ingestRepoRelease`); deploys, the sha join, rollbacks, snapshots, suggestions are computed,
  direct writes. Apps, parts, repository settings and accepted suggestions are AUTHORED, admin-only, cookie-only,
  audited — never MCP.
- **Nothing external on a render path.** `GET /repo/dashboard` and MCP `get_repo_dashboard` read D1 only; every
  compare, tree read, file batch and `describe` call runs in reconcile, on a push, in the hosting poll or on an
  admin's Scan again.
- **Never guess.** No sha without a provider value or exactly one join candidate; no feature claim without a
  `feat` prefix or a `feature` / `enhancement` label; no Cloudflare figure that was not read; unknown is `null`
  (drawn "—" / "Unknown"), never 0; "not connected" is said only of a host the repository really has.
- **The SPA never branches on a provider id.** It reads capabilities (`reportsDeploys`, `reportsMetrics`,
  `families`), the one status function (`connection`) and `via_github`.

## Apps

**An app is a part key.** `repo_apps` (0070; PK `(org_id, key)`) gives a key a home: `repo` (`owner/name`; `''`
= the org's primary repository), `label`, `folder` (`'/'` = the root, else a path with no leading / trailing
slash, no `.` / `..` segment, ≤ 200), `kind`, `watch` (JSON array of path globs, default `[folder]`),
`release_signal`, `source`, `position`, `created_*` / `updated_*` (handles, in `HANDLE_COLUMNS`). Every part of
the app, in every environment, carries the key as its `part_key`. The key alphabet is `PART_KEY_RE` (1–32 of
`a–z 0–9 _ -`, CHECKed in SQL too).

- **Kinds and roles** (`shared/repo-apps-core.ts`, zod-free): `APP_KINDS` = Site, Service, Worker, Job, Package.
  `APP_KIND_ROLE`: Site and Worker are `web`, Service and Job are `service`, a Package is `null` — it has no
  parts and is never deployed on its own (the facts read drops any part whose key names a Package).
- **Implicit apps.** A part key with no row reads as an app: `listRepoApps(ctx, repo?, parts?)`
  (`src/repo/apps-read.ts`) returns the rows (position, then key; a kind the code no longer knows is skipped)
  and then one app per remaining part key — the primary repository, folder `/`, `watch: ["/"]`, kind
  `kindForRole` (web → Site, service → Service), label from the key's part in its FIRST environment (drift order),
  `source: "synthesised"` (`FactsApp.source` calls it `"implicit"`). So nothing from before apps breaks.
  `repo` narrows case-insensitively; a row stored with `''` is the primary's.
- **Sources**: `migrated` (0070's own rows only), `manual`, `suggested` (an accepted suggestion).
- **0070's seed**: a row per existing part key per org — repo = the primary (or `''`), folder `/`, label from the
  first environment's part, kind `Service` for a `service` part, `Worker` for a `web` part on Cloudflare, else
  `Site`; written by `migration`. SaplingLearn: `frontend` (Worker), `backend` (Service) — also the test seed
  (`scripts/seed/reset.mjs`).
- **Watch paths** (`src/repo/watch.ts` `matchesWatch`, pure): `/`, `''`, `.`, `**` are the whole repository; a
  plain path is itself and everything under it; `*` one segment, `**` any number, `?` one character, and anything
  under what a glob matches. Read by the not-shipped arm (below) and by the App menu's narrowing of Code and CI (Monorepos, below).
- **`release_signal`** — how a release of this app shows up (`web/src/repo-apps.ts` offers it for a Package or
  an app with no part): `tag:<glob>` (an SQLite GLOB on the tag — `tag:v*`, `tag:ui-kit@*`), `workflow:<file>@<branch>`
  (the latest successful run of that workflow on that branch), or NULL (not tracked). ONE parser,
  `parseReleaseSignal` (`shared/repo-apps-core.ts`), is both the writer's check and `readRelease`'s reading: the glob
  1–100 of `A–Z a–z 0–9 . _ - @ / + * ? [ ] ! ^` with ≤ 10 wildcards; the file a workflow file name (the `github`
  provider's own pattern, folder optional, no `..`); the branch no whitespace or control character, ≤ 200 (split at
  the first `@` — a file has none). Anything else is a 400 on `release_signal`, said beside the field on the Apps tab
  (above the form for an app on a host, whose page has no such field).
- **The writers** (`src/repo/apps.ts`, admin+, each ONE batch with its audit row in `org_admin_audit`):
  `putRepoApp(ctx, key, body)` — body keys `repo`, `label`, `folder`, `kind`, `watch`, `release_signal`, `source`,
  `position`, any other refused; a new app needs `kind`; `repo` must be one of the org's repositories (default the
  current, else the primary); `watch` 1–20 globs; `source` `manual` | `suggested` (never `migrated`); audited
  `app.set` with the changed FIELD NAMES, never a value. `deleteRepoApp` removes the row (audited `app.delete`)
  and leaves the parts, which then read as an implicit app again. `src/repo/apps.ts` reaches the settings module
  (its errors), so the MCP-reachable reads import `apps-read.ts`, never `apps.ts` (`test/secrets.mcp.test.ts`).
- **Routes** (`src/repo/apps-routes.ts` over `src/repo/apps-setup.ts`; cookie only, admin, `/api/o/:slug`, the
  repository checked against `org_repos` — another org's or an unconnected one is a 404):
  `GET /repos/:owner/:name/apps` → `RepoAppsSetupDTO` (`shared/repo-scan-core.ts`; below, Org settings);
  `PUT /repos/:owner/:name/apps/:key` (kind, label, folder, watch, release_signal, position — never `repo` or
  `source`; 201 when created; a key that is ANOTHER repository's app — a row, or a part key read as an app there —
  is 409 `app_conflict`, never moved); `DELETE …/apps/:key` (the row; its parts stay unless `?parts=remove`, each
  then through `deletePart`, audited `part.delete`, its deploys and poll state with it; an implicit app IS its
  parts, so only `?parts=remove` removes it).
- Tests: `test/repo-apps.test.ts` (0070, `listRepoApps`, the writers, › validates release_signal),
  `test/repo-apps-setup.test.ts` (the routes).

**Environments are hidden per repository.** Environments stay org-wide; the Repo screen for repository R shows
R's apps and only the environments where one of them has a part (`FactsEnv`, in the org's `position` order). A
packages-only repository shows no environment card, and its CI line reads every environment.

## The `github` provider, GitHub deploy signals and deploy provenance

**GitHub deploy signals are captured again, untagged** (`src/repo/capture.ts`, through the gate's
`ingestRepoEvent`): a `deployment` / `deployment_status` delivery and every commit status whose context is NOT
`canopy/*` become `repo_events` rows of the EXISTING kind `deploy` (no CHECK rebuild) with `env` / `part` NULL and
`raw.signal` = `deployment` | `status` — creator login, the environment name exactly as the host spells it, state,
sha, ref, description, log / environment / target link, an Actions deployment's workflow file, a status's
`branches`. Kept 90 days (`DEPLOY_SIGNAL_RETENTION_DAYS`, `pruneRepoCapture` in `src/platform/sweeps.ts`: an
untagged `deploy` row; one tagged with an environment from before 0057 is kept). They feed provider-level Detected
(`hosting-providers.md` › Detection), the seen signals (below), a `github` part's deploys and the commit join —
never an environment's deploys by name. The host formats (step 0): Vercel `Production – <project>` (EN DASH),
Railway `<service> / <env>`, Render `<branch> - <service>` (Render's `ref` is a branch; the sha is the
deployment's).

**The `github` provider** (`src/hosting/providers/github.ts`, label "GitHub deployments", roles web + service): a
part whose deploys come from GITHUB — an app deployed by Actions (scenario H), or a host Trov has no credential for
yet. `credential: "github_app"` (it uses the org's GitHub connection; anything it ever reads goes through
`resolveGithubCredential`), no connection method, no card, checklist step or Integrations slot, `via_github: true`
on the DTO, always live in `hostingStatus`, `capabilities: { deploys: true, metrics: [] }` (every metric of the
role is "not available" — `NO_GITHUB_METRICS`), `pollCost` 0, and its `poll` is never run. Part settings — EXACTLY
one of (`checkSettings`, enforced on the part write): `environment` (a deployment environment, exactly as GitHub
names it), `check_app` + `check_name` (a check run: the posting App's slug and the check's name), `workflow`
(`.github/workflows/<file>.yml`, or the file alone).

**Webhook-fed deploys** (`src/hosting/github-deploys.ts`): when `src/webhook.ts` stores a NEW signal it offers it
to `writeGithubDeploys`, which writes a `hosting_deploys` row (`source = 'github'`, `sha_source = 'provider'`) for
every `github` part whose OWN setting it matches — `signalMatchesPart`, THE guard: a deployment / status with that
exact environment name (a branch ref must be the environment's branch; a sha ref says nothing), a check run of that
app and name on the branch, a completed workflow run of that file on the branch. A failed one's `reason` is the
deployment's description or the check's `output.title`; neutral is skipped. The write may run the rollback check
(below) with the GitHub token the webhook entry point resolved. Its own failure never costs the capture.

**History-fed deploys** (`backfillGithubDeploys`, same module): a live delivery is not the only source. The check
runs and workflow runs that RECONCILE backfills, and the signals captured before a `github` part — or its current
setting — existed (the Apps tab's deploy-signal picker names exactly those), are replayed through the SAME matcher:
the captured, untagged (`env IS NULL`) deployment / check-run / workflow-run rows of the last 30 days
(`GITHUB_DEPLOY_HISTORY_DAYS`; ≤ 500 newest rows, pre-narrowed in SQL by the names and workflow paths the settings
carry — the decision is still `signalMatchesPart`'s), oldest first, each deploy folded to its newest state and
upserted once (≤ 50 per part; a second pass writes nothing). It runs as reconcile's guarded `github_deploys` arm
(after the capture arms; every `github` part of the org) and right after `putPart` writes a `github` part (that part
only — the Apps tab's Save, the scan's Accept, Hosting's part editor; a failure is logged and never costs the write).
D1 only: no GitHub request, so no rollback compare and `reconcileRequests` is unchanged.

**Deploy provenance — `hosting_deploys` columns (0070)**, written through ONE upsert, `src/hosting/deploy-store.ts`
(secret-free, so the webhook may call it):
- `source` — `provider` (the host's poll) | `github` (the capture above). Existing rows are `provider`.
- `sha_source` — `provider` (the host — or GitHub, for a `github` part — said so) | `joined` | NULL (no commit
  known). Existing rows with a sha became `provider`. A provider sha replaces a joined one, never the reverse.
- **The one-candidate join** (`src/hosting/sha-join.ts`, after every poll): each of the part's provider deploys with
  NO sha (not a preview, not GitHub-sourced, created in the last 2 days, ≤ 10 a poll) looks for GitHub signals on
  the ENVIRONMENT'S branch that FINISHED in the 10 minutes before its creation — a completed check run, a completed
  workflow run, a settled deployment status whose ref is the branch, a settled commit status listing the branch.
  EXACTLY ONE distinct sha → the deploy's (`sha_source = 'joined'`); none or several → NULL (`joinCandidate`, THE
  guard). App attribution is the branch alone until Phase E. **Cloudflare** reads the newest deployment's commit
  from the Workers Builds API instead (`builds?version_ids=`, one more fetch; refused without Workers CI Read on a
  USER token → the poll state's note "commit: the token needs Workers CI Read" and the join takes over). Fly.io, and
  Railway when `meta` lacks `commitHash`, rely on the join.
- `rolled_back_from` — `src/hosting/rollback.ts`: when a write creates or changes a part's NEWEST non-preview
  `ready` deploy and its sha differs from the previous ready one's, ONE GitHub compare (previous...new) — through
  `resolveGithubCredential` on the poll path, the webhook's token on the capture path, never on a read. `behind` →
  the previous sha; `ahead` / `identical` / `diverged`, a failed compare or no credential → nothing. No request for
  a preview, the first ready deploy, the same sha or a deploy with no sha. Budgeted as `ROLLBACK_COMPARE_COST` (1)
  on every hosting unit whose provider reports deploys (`providerPollCost`).
- `reason` — a failure reason, scrubbed BEFORE it is cut to 140, one line, kept for an `error` deploy only
  (`validatePoll`): Netlify `error_message`, Vercel `errorMessage` (else the alias error's message), Render's failed
  status in words, the GitHub description or check `output.title`.

**Previews.** Not parts: `hosting_deploys` rows with `target = 'preview'` of an app's PRODUCTION part. Vercel and
Netlify production parts read them with a second list (`pollCost` 2 each); Render does not (a Render preview is a
SEPARATE service with its own id). A deploy with NO target (every GitHub-sourced one) is never a preview — the
test is `COALESCE`d (`NOT (NULL AND …)` is NULL and once dropped the row). A part that has ONLY preview rows reads
them as its deploys. The facts match them to open PRs by branch (below).

Tests: `test/hosting.provider.github.test.ts`, `test/hosting.github-deploys.test.ts` (› THE GUARD —
`signalMatchesPart`; › history — reconcile's backfilled runs and checks, and a part created or re-pointed later, filled
through the guard, a look-alike never; › THE ROLLBACK COMPARE), `test/hosting.sha-join.test.ts` (› THE ONE-CANDIDATE RULE),
`test/hosting.previews.test.ts`, `test/repo-capture.test.ts`.

## `RepoFacts` — the Overview's one read

`facts: RepoFacts` (`shared/repo-facts-core.ts`, zod-free) rides every `GET /repo/dashboard?repo=&app=` payload
and MCP `get_repo_dashboard` (overview / no tab). It is assembled INSIDE the dashboard's one projection by
`readRepoFacts` (`src/tools/repo-facts.ts`) from the reads `getRepoDashboard` (`src/tools/repo.ts`) already made
(parts, hosting reads, branch heads and their checks, health rows, the PR / commit / run gates) plus its own:
`listRepoApps`, `factsDeploys` and `deployWeekCounts` (`src/repo/facts-store.ts`, ONE statement each), `runCounts`,
`readRepoSettings`, the three snapshots (`not_shipped`, `out_of_step`, `drift_chain`), `readRelease` /
`releaseWeekFigure` and `readFound` / `readUnseen`. Then `narrowFacts(facts, app)`. A throw (or a failed apps read)
costs the facts alone: `emptyRepoFacts(repo)` and `degraded: true`, every section still read. Nothing in it
fetches or imports a secret (it is reachable from `src/mcp.ts`).

**`?repo=`** is checked against `org_repos` (any case; absent → the primary; unknown → **404 `{ error: "unknown
repository" }`**). MCP's `repo` doubles as the connection scope's argument, so there an unknown one reads the
primary and the output's `repo` says which. **`?app=`** is an app key of that repository or `__repo`
(`REPO_WIDE`); an unknown key reads as every app. The app ALSO narrows the per-part sections (environments' parts,
`deploys`, `usage`, `providers`) to that key's parts (`REPO_WIDE`: none); the other sections stay the org's capture.

**The PR / CI facts are the PRIMARY repository's capture** — reconcile and the webhook capture one repository per
org, and `repo_events` keep no repository. For another connected repository `ci`, `drift`, `outOfStep` are empty,
`notShipped` counts and the PR / commit / CI week figures null, `unseen` null, seen signals empty; its own apps,
parts, deploys, previews and releases (`releases` is per repository) are its own.

Every field (null rules in brackets):
- `repo`, `app` (the narrowing: a key, `REPO_WIDE`, or null = all apps), `repos` (the org's, primary first — the
  repository menu), `groupDefault` (`repo_settings.overview_group`, else null).
- `allApps` / `apps` — `FactsApp`: key, label, folder, kind, watch, `source` (`migrated` / `manual` / `suggested` /
  `implicit`), `usedBy` (a Package: the apps that use it — the repo scan's workspace graph, `repo_app_suggestions.used_by`
  folders matched to the apps' folders; null when the scan never described it), `previews` (a preview landed in 30
  days), `openPrs` (once `prs_reconciled` exists: the open-PR count for a repository's ONLY app; with two or more, the
  open PRs whose files reach the app — directly or via a Package it uses — `null` while one open PR's files were
  never read; Monorepos, below).
- `envs` — `FactsEnv` (key, name, branch or null, position): only environments with a part of the apps in view.
- `parts` — `FactsPart`, one per app × environment (apps' order, then promotion order), Packages excluded:
  `serving` = the newest `ready` production deploy of the part's CURRENT provider, any age; `latest` = the newest
  production deploy when it is NOT the serving one (in flight, failed, canceled) else null; `history` = the last ≤ 20
  settled (`FACTS_HISTORY`), oldest first; each a `FactsDeploy` carrying `sha` / `shaSource` / `source` / `reason` /
  `rolledBackFrom` as stored. `connection` = the one status function (`partConnectionOf`); `reportsDeploys` /
  `reportsMetrics` from the registry's capabilities; `viaGithub` for a `github` part, or a GitHub-sourced serving
  deploy while the host is not live; `via` = the workflow file / environment / check a `github` part names; `host` =
  the provider's label; `url` = the health target's base, else the serving deploy's URL; `consoleUrl` https only.
  **`health`** — the environment's two pinged targets (`frontend` = its frontend URL, `backend` = API URL + health
  path) are a part's only when the part carries that key, or is the ONE part of the target's role in the
  environment and no other part carries the key (two web parts: null, never a guess); `stale: true` past 30
  minutes (`FACTS_HEALTH_STALE_MS`) — shown as neither up nor down.
- `previews` — per app, a production part's preview rows of 30 days, newest per branch, matched to OPEN PRs by head
  branch from the captured `pr` rows; a branch whose PR merged or closed (and none is open) is left out;
  `failStreak` = consecutive `error`s from the newest, `failingSince`; ≤ 20 per app.
- `notShipped` — one per part: the snapshot's entry only while the part still serves the sha it was computed for,
  else `count: null`, no groups.
- `outOfStep` — an environment's rows only while every app there still serves the sha it was computed for.
- `drift` — the chain's steps between two SHOWN, adjacent environments whose branches are still the snapshot's.
- `ci` — per shown environment (every environment for a packages-only repository): the branch head's checks —
  `fail` (failing names, ≤ 3), `running` (`total` / `failing` null while any check runs), `pass`, or all-null when
  nothing is captured.
- `release` — `readRelease(ctx, repo, app)` (below), else null.
- `found` / `unseen` — the scan's read side (below).
- `week` — all seven `WeekKey`s, each `{ key, value, delta }`, a null value always with a null delta:
  `mergedPrs` (`events`; null until one was ever captured; a delta only when `recordingSince('pr')` predates two
  weeks — this week is compared with last week, so capture must cover both),
  `deploys` / `failedDeploys` (settled production deploys of the parts in view; null with no deploy capture — no
  deploy row and no successful poll of a deploy-reporting provider; a delta only when every counted part's capture
  began two weeks ago, `MIN(recorded_at)`), `openPrs` (the `prs_reconciled` gate and its recording window),
  `commits` (the Commits tile's gates), `releases` (`releaseWeekFigure`), `ciRuns` (`run` rows; delta when
  `recordingSince('run')` predates two weeks).
- `attention` — `FactsAttention { kind, app, env, refs }`, STRUCTURED (never a sentence on the wire), most urgent
  first (`ATTENTION_ORDER`), then app order, then environment order: `down` (a fresh health reading down),
  `failed` (the newest production deploy errored — `failedSha`, the `sha` still serving, `reason`, `provider`),
  `rolledBack` (the serving deploy has `rolled_back_from`; `nextSha` when one is in flight), `outOfStep`, `stale`
  (a stale health reading), `degraded` (an environment's CI fails; `app: null`), `waiting` (not shipped > 2
  commits and the oldest > 1 day — `WAITING_COUNT`, `WAITING_AGE_MS`), `previewFailing` (a streak ≥ 3; `env: null`).
- `connect` — everyone's (members see the note, only an admin gets the action — the design's rule): the first host in part order that is `not_connected` / `revoked` (never a `github_app`
  provider), with its apps; `need: "metrics"` when GitHub already gives every such part its deploys, else
  `"deploys"`.

**`narrowFacts(f, app)`** — the design's `narrow()`, one function for the server and the SPA: null → unchanged; an
app key → that app's parts, previews, not shipped, out of step and attention items, `apps` = [it], `allApps`
unchanged, `envs` = those it has a part in, `connect` only if it names the app (drift, CI, release, week, found /
unseen stay the repository's; attention with no app is dropped); `REPO_WIDE` → no app rows at all (apps, envs,
parts, previews, not shipped, out of step, connect) and found / unseen null, the PR / CI-level facts and the
app-less attention kept; an unknown key → unchanged.

Tests: `test/repo-facts.test.ts` (every field, the null rules, other repositories, `?repo=&app=`, never a 500).

## The reconcile's facts arms

`src/repo/facts-compute.ts`, each its own guarded `safely` arm of `reconcileRepo` (`src/repo/github.ts`) after
drift, also run on a push to an environment branch (`refreshDrift(…, pushedBranch)`, `src/webhook.ts`). Each stores
a `repo_snapshots` row the facts read only reads back, and THROWS after storing what it did compute, so reconcile
names it in `failed` and the last good entries stand.
- **`drift_chain`** (`computeDriftChain`): one `GET /compare/<next>...<earlier>` per ADJACENT pair of environments
  whose branches differ, the ahead commits grouped by PR (a squash merge's trailing `(#123)`) or as direct pushes.
  The `drift` section's snapshot is the chain's LAST step plus its behind side (for two environments the old
  first↔last pair, request for request) — `repo-dashboard.md` › Drift. ≤ `driftCompares(N)` = max(2, N).
- **`not_shipped`** (`computeNotShipped`): per part of the PRIMARY repository's apps with a serving sha
  (`servingShas`), `GET /compare/<serving sha>...<branch>` — GitHub's `ahead_by` as the count, the commits grouped
  by PR, the oldest commit's date. In a repository with ≥ 2 apps the commits are kept to the app's watch paths, each
  commit's files from `commit_paths` (exact `commit` rows only — GitHub's compare lists one combined file list for
  the range). **A commit whose files are not known stays IN**: counted, and its group says how many
  (`FactsCommitGroup.pathsUnknown`, "paths unknown" on screen) — never dropped (GUARD, `test/repo-monorepo.scope.test.ts`).
  With no commit known nothing is filtered and the count is GitHub's total; filtered, the count is exact only when the
  compare returned every commit, else null. A one-app repository is never filtered. Incremental: a part is compared
  again only when its serving sha or its branch head changed, or a commit it kept as unknown (`NotShippedEntry.unknown`)
  has paths now (a D1 read, no GitHub request); never-computed parts first, then the oldest.
- **`out_of_step`** (`computeOutOfStep`): per environment whose parts serve different commits (a 7- and a
  40-character sha are one), the NEWEST serving deploy is the reference and one compare per other distinct sha
  (`<other>...<reference>`): `ahead` → the others are behind by `ahead_by`; `behind` → the reference apps are behind.
  Recomputed only when the environment's shas changed.
- **The bound**: not shipped and out of step share **`FACTS_COMPARE_CAP` = 6** compares per run; the rest keep their
  entries and go first next time.

Tests: `test/repo-facts.reconcile.test.ts` (the arms, incremental, bounded, the cost, a failed compare, the push
path, watch-path filtering, one app unfiltered).

## The layout core (`shared/repo-layout-core.ts`)

The design's `RULES`, `decide`, `TABS` and `buildScreen`'s group-by override, moved from `repo-data.js`
**unchanged**, zod-free. Nothing is chosen at view time: the SPA (`web/src/repo.ts` `factsView`) and MCP
(`src/tools/repo-agent-view.ts`) both run `layoutOf(layoutInputOf(facts), group)`.
- `layoutInputOf(facts)` (`repo-facts-core.ts`) projects the facts onto `LayoutInput`: apps by key + kind,
  environments by key, targets (= parts) by app + env, `found.apps`.
- **`decide(s)`**: no app → `found` (R1) when the scan found one, else `unseen` (R2); no deployed app (every app a
  Package, or none with a part) → `release` (R3); one deployed app → `production` (R4) in ≤ 1 environment, else
  `chain` (R5); 2–3 deployed apps all in the same environments → `envCards` (R6); else `appsTable` (R7). `RULES`
  carries each rule's id, name, opener and when.
- **`TABS(s)`**: `release` → Overview, Code, CI, Planning (no Usage); otherwise Overview, Code, CI & deploys, Usage,
  Planning.
- **`layoutOf(s, group)`** → `{ rule, opener, canGroup, group, tabs }`. `canGroup` = two or more deployed apps AND
  two or more environments — the only case Group by is offered; then `group: "app"` draws `appsTable`, `"env"`
  draws `envCards`, whatever the rule. `group` is the viewer's session choice (`state.repoGroup`), else the admin's
  default.
- **The admin's default** — `repo_settings` (0071, PK `(org_id, repo)`, `overview_group` `env` | `app` | NULL,
  `updated_by` a handle): `PUT /api/o/:slug/repo/settings { repo, overview_group }` (`src/repo/settings-routes.ts`:
  admin, cookie only, 404 for a repository the org does not have, audited `repo.settings` in `org_admin_audit`),
  read by `readRepoSettings(ctx, repo)` (`src/data/repo-settings.ts`) into `facts.groupDefault`. On screen, after a
  flip, an admin (never in the sample) is offered "Make this the default".
- **Parity, three ways**: `test/repo-layout.test.ts` runs the design's own `repo-data.js` beside the core over every
  scenario × variant × App narrowing × Group by (same rule, opener, Group by, tabs; `RULES` equal; G/after is the
  one design-data slip that throws in the design's view model); `test/repo-facts.parity.test.ts` is THE `decide()`
  parity guard SPA ↔ MCP (every scenario × variant × App × default Group by, `factsView` vs `shapeRepoDashboard`);
  `test/repo-sample.scenarios.test.ts` holds the sample's facts to the design's `buildScreen`.

## The Overview

When the payload carries `facts` — every Worker payload now (the empty facts on a failure), and the sample — the
Overview is `overviewFacts` (`web/src/repo-overview.ts`), else the older section-built Overview. Top to bottom (the
design's `buildScreen`): `<div data-repo-state-slot>` (the design's place for #178's AI `state`, above the rule-picked
opener — always EMPTY: the owner split State out to the Repo screen's Summary tab, `repo-dashboard.md` › Written by
Trov), the connect card, the opener by `layout.opener` (found / unseen / release / production +
previews / chain and envCards → environment cards + drift / appsTable), not shipped where a part has commit groups
waiting, the week tiles. There is NO links row into the tabs: the design closes with one, but it repeated the tab
bar at the top of the screen, so the owner removed it. "Repo-wide only" draws its own note instead of an opener. Every block is an `OverviewBlock` (`(f, x) => string`, `web/src/repo-overview-ctx.ts`) in its
own module and `trov.css` section, wrapped in `data-repo-block="<name>"`, worded in the SPA from `RepoFacts` alone,
`""` when its facts are absent.

- **The verdict** — ONE function, `envVerdict(f, env)` (`web/src/repo-verdict.ts`, the design's `verdictFor`),
  read by the header's pills and every block: every part unknown (no serving, latest or history) → Unknown; a fresh
  health reading down → Down; a newest production deploy failed → Failing; out of step → Out of step; checks fail on
  the branch head → Degraded; **checks PASS on the branch head → Healthy; otherwise Live** — no checks captured, or
  still running, is never Healthy. Marks are marks.ts kinds with the design's shape and tone (`VERDICT`). `ciLine(ci)`
  is the one wording of a head's checks ("All 14 checks passing on 3e9a1f2", "2 of 9 checks failing on e07b3a2",
  "Checks running on f19ad20", "<check> running on <sha>").
- **Needs attention** (`repo-attention.ts`) is NOT a block (the owner's call, 2026-10-18: it pushed the Overview
  down): a button at the left of the bar above the panel (`attentionButton`: "Needs attention", its count, a red dot
  at its corner; Group by stays at the bar's right) opens the list in a dialog (`attentionDialog`, drawn by
  `repoAttentionOverlay` through repo-lazy.ts; `state.repoAttentionOpen`, closed by Done, ×, Escape, the backdrop or
  any route change). It words each `FactsAttention` from its kind and refs — "Production deploy
  e07b3a2 failed 12m ago on Cloudflare Workers. c41e7d9 is still serving." — the host by its part's `host` label
  (never a switch on a provider id), the app first ("api: …") when the repository has more than one deployed app.
  An action leaves Trov only with an https address and outside the sample; else it opens the tab that holds it.
- **The connect card** (`repo-connect.ts`): `need: "deploys"` → the design's G card; `need: "metrics"` → deploys
  arrive via GitHub and it asks for CPU and memory only. An admin's action opens Org settings › Hosting; a member
  reads the note.
- **The openers**: `productionBlock` (R4, `repo-production.ts`: verdict, serving row, URL and health, a failed /
  cancelled newest deploy and what still serves, a deploy in flight as Next, a rollback, CI on the head, the last-20
  strip and its sentence; a part with no deploy is Unknown and says why — "<host> does not report deploys to
  GitHub" when its host is not connected); `previewsBlock` (`repo-previews.ts`; the failing streak from two
  failures; "No open pull requests, so no previews." when an app has previews and none is open);
  `envCardsBlock` (`repo-env-cards.ts`, R5 / R6: a card per environment, a row per part) + `driftBlock`
  (`repo-drift.ts`, one strip or the chain form); `appsTableBlock` (R7, `repo-apps-table.ts`: worst first — failed,
  building, waiting, unknown, live; a null count is "Unknown", never "Up to date"; then the packages);
  `releaseBlock` (R3, `repo-release.ts`); `foundBlock` / `unseenBlock` (R1 / R2, `repo-found.ts`: Accept / Ignore for
  an admin — `repoFoundAccept` / `repoFoundIgnore` + the suggestion id, the scan's own routes, a toast with Undo,
  then the dashboard read again; disabled in sample mode; or what Trov looked for and what it does see — tags,
  PRs, CI workflows, GitHub deployments in 30 days — and "Add an app by hand"). `notShippedBlock`
  (`repo-not-shipped.ts`). Shared pieces in `repo-block-kit.ts` (the design's `MARKS` on `stateMark` shapes — ONE table, `REPO_MARK`;
Building is a blue ring pulsing by `.repo-kit-pulse`, still under reduced motion —, the sha
  chip that says "no commit" and why, the byline person via people.ts, https-only links, plain text in the sample,
  the commit groups; a disclosure is ONE act, `repoOpen` with the block's key, read back from `ctx.open`).
- **Week tiles** (`repo-week.ts`): "—" for a null figure (never 0), ▲ / ▼, failed deploys inverted, "vs last week" /
  "since connecting" / "unknown until <host> is connected".
- **`reportsMetrics`** (a capability, never a provider id) is read by the Usage tab's targets (`repo-usage.ts`): a
  part whose host reports no metric is "Not available from <host>", never "not connected" for a thing the repository
  does not have.
- **The header** (`repo-header.ts`): the repository menu (`dropdown()`, only with two or more repositories), the App
  menu (monorepos only: All apps, each app with its folder and open PRs, Repo-wide only), the environment pills
  (`envVerdict`), Group by (`segmented()`, only when `layout.canGroup`). Repository and app live in the address —
  `#repo[/<tab>]?repo=<owner%2Fname>&app=<key>` (hash.ts; the App menu is left out of the page key) — and go to
  `GET /repo/dashboard?repo=&app=`; `factsView` narrows client-side only when the payload is not already narrowed
  to it (the sample).
- The Usage tab's targets are the facts' parts too (`targetsFromFacts`) — `repo-dashboard.md` › On screen the
  Usage tab.

Tests: `test/render.repo-overview.test.ts` (› no "not connected" for a thing the repository does not have — every
scenario × variant × app), `render.repo-env-cards`, `render.repo-drift`, `render.repo-apps-table`,
`render.repo-not-shipped`, `render.repo-production`, `render.repo-previews`, `render.repo-release`,
`render.repo-found`.

## The sample scenarios A–N

"Preview with sample data" carries the design's scenarios as `RepoFacts` (`web/src/repo-sample.ts`
`repoScenario(key, variant, { now, app })`, a dynamic import; names, titles and variants in
`web/src/repo-sample-keys.ts`, so the switch never pulls the sample into the main bundle). The sample bar's
Scenario and Variant `dropdown()`s are session-only (`state.repoScenario`); a pick recomputes only `facts`.

| Key | Title (design) | Apps · environments · hosts | Rule |
| --- | --- | --- | --- |
| A | Frontend and backend (variants: out of step, trouble) | web Worker + api Service · staging, production · Cloudflare, Railway | R6 envCards |
| B | One Worker, main to production (failed, trouble) | trov Worker · production · Cloudflare (Trov's own Product block) | R4 production |
| C | Static site with previews | site Site · production · Netlify | R4 |
| D | Full-stack on one host | dashboard Site · production · Vercel | R4 |
| E | Turborepo, five apps | web, api, docs, jobs + ui Package · production · Vercel, Render, Cloudflare, Fly.io | R7 appsTable |
| F | Large monorepo, 14 apps | 12 deployed + 2 Packages · production · five hosts | R7 |
| G | Backend services only (signals, after) | four Services / Job · production, staging · Railway — "signals": deploys via GitHub, connect card asks for metrics only | R7 |
| H | Containers by GitHub Actions | collector, normalizer · staging, production · Fly.io, `github` | R6 |
| I | Package with releases only | ui-kit Package · — | R3 release |
| J | Promotion chain | core Service · dev, staging, production · Render | R5 chain |
| K | One product, two repos | web-app Site · staging, production · Vercel (the cross-repo Product view is out of scope) | R5 |
| L | Just connected | none — the scan found apps | R1 found |
| M | Nothing recognised | none | R2 unseen |
| N | Trouble states (A's '' and B's `trov`) | as A / B | R6 / R4 |

G/after is one design-data slip the design's own view model cannot draw (`DESIGN_DATA_SLIPS` in
`test/repo-layout.test.ts`); the sample still draws it (an apps table). H's Cloud Run app names the registered
`github` provider (`GITHUB_PROVIDER`). Tests: `test/repo-sample.scenarios.test.ts`
(every scenario × variant × App × Group by against `buildScreen`; unknown stays null; every part's app and
environment exist).

## Detection: the repo scan, detectors, seen signals, suggestions

Detection SUGGESTS; a person decides. Provider-level "Detected: Vercel" stays `hosting-providers.md` › Detection
(which now also reads the re-captured deployments and commit statuses); this is APP-level. 0072: `repo_scans` (PK `(org_id, repo)`: root `tree_sha`, `scanned_at`, `looked` —
the file names looked for —, a fixed-words `error` ≤ 200) and `repo_app_suggestions` (PK `(org_id, id)`, `id` = a
hash of repo + folder + kind, stable across rescans; key, folder, kind, provider, evidence `[{ kind, text[, signal] }]`,
parts `[{ env, provider, settings }]`, `used_by`, `state` pending / accepted / ignored, `decided_by` a handle).

- **The scan** (`src/repo/scan.ts` `scanRepo`) — a guarded arm of `reconcileRepo` (`scan`: the cron's `:20` unit
  and Sync GitHub's closing reconcile; NOT Poll now) and an admin's Scan again. Cost ≤ **`SCAN_COST` = 5** (2 +
  `DESCRIBE_PROVIDERS.length` × `DESCRIBE_COST`): ONE tree read (`GET /repos/:o/:r/git/trees/HEAD?recursive=1`, its
  `sha` the root tree's), then — **only when that sha differs from `repo_scans.tree_sha` (THE GUARD: the same sha →
  zero further requests; Scan again forces past it)** — ONE GraphQL batch of ≤ 24 files (`SCAN_FILE_MAX`;
  `object(expression: "HEAD:<path>")`, paths as variables, a missing path null — step 0), and ≤ 1 `describe` list
  call per CONNECTED host that has one. A truncated tree (100,000 entries / 7 MB) is scanned with what GitHub listed,
  its sha stored, `error` saying so. A refused tree / batch records fixed words in `error` (the last good sha kept)
  and nothing else — a scan is detection, so a refusal never marks the GitHub credential failing or a Sync partial;
  only an unexpected throw (D1) lands in reconcile's `failed` as `scan`. The connected hosts' credentials are
  resolved by the caller (`describeSources`, `src/repo/scan-store.ts`), lazily, only past the guard; the scan itself
  is secret-free. ONE batch writes the suggestions and the scan row.
- **The detector registry** (`src/repo/detect/<id>.ts`, `index.ts`; `patterns`, `seen`, a pure `detect`): wrangler
  (`name` → Worker, `pages_build_output_dir` → Site; `d1_databases` and `triggers.crons` as the Cloudflare part's
  `d1_database_ids` (≤ 5) / `crons` (≤ 10) settings; `[env.<name>]` Workers), vercel.json, netlify.toml (`[build]
  base`), fly.toml (`app`), render.yaml (services, `rootDir`, type; a database is not an app), railway.json / .toml,
  amplify.yml (AWS, `later`), `.do/app.yaml`, Procfile, Dockerfile + a workflow that references its folder AND uses a
  deploy action, and workspaces (pnpm, package.json, lerna, go.work, Cargo — a member with no deploy config of its
  own is a Package whose `usedBy` is the members depending on it). Files nearest the root first, then detector
  order, outside dependencies / fixtures / tests / examples, ≤ 4 folders deep (`SCAN_DEPTH_MAX`). TOML / YAML / JSONC
  through a tiny safe subset parser (`detect/parse.ts`, no dependency). Candidates merge per folder (the first
  detector with a host leads).
- **`describe()`** (optional on `HostingProvider`; Vercel `GET /v9/projects` — `link.repo`, `rootDirectory`;
  Render `GET /services` — `repo`, `rootDir`, type; Netlify `GET /sites` — `build_settings.repo_url` / `base`;
  shapes UNCONFIRMED live): a match upgrades evidence, fills the host's part settings, and turns a Package it builds
  into an app. A refused describe is no evidence, never a failure.
- **Seen signals** (`src/repo/signals.ts` `seenSignals`, ONE statement over `repo_events`, 30 days,
  `SIGNAL_LIMIT` 200): deployments (by environment name + creator, distinct deployments; rows from before 0057
  count), commit statuses (by context, distinct commits), check runs (by app slug + name — `github-actions`' are left
  to their workflow), workflow runs (by file). The primary repository's only. **Token rules** (`detect/match.ts`):
  names normalised per the step-0 formats and split into tokens; a candidate matches when the tokens contain its
  folder's last segment (the repository's name at the root) or equal a name its host knows it by. EXACTLY ONE
  candidate per signal — ambiguous matches none; Packages never match. A matched signal's environment word (or
  Render's branch) names an org environment (`envForHint`).
- **Proposed parts**: the candidate's own host when its settings are complete (`checkFields`), on the environment a
  production signal names, else one called production, else the first; every other environment a signal names gets
  a `github` part naming that signal; else the deploying workflow on the first environment; a Package none.
- **Lifecycle** (`src/repo/scan-store.ts`, routes `src/repo/scan-routes.ts`: admin, cookie only, `/api/o/:slug`,
  repository checked against `org_repos`): a scan upserts pending rows, never touches an accepted one, keeps an
  ignored one ignored, deletes what it no longer finds. **Scan again** `POST /repos/:o/:n/scan` (`runScanNow`:
  forced past the guard, ignored ones back to pending; no GitHub credential → `ok: false` with the reason).
  **Accept** `POST …/suggestions/:id/accept` → `{ undo, app, parts }`: the app (`putRepoApp`, source `suggested`,
  audited `app.set`) and its parts (`putPart`, audited `part.set`, the provider's own keys only) as that admin —
  each writer its own batch; a refused part rolls the accept back (audited); 409 `key_taken` when the key already
  names an app or part. **Ignore** `…/ignore` → `{ undo }`. **Undo** `POST …/suggestions/undo { undo }` within
  `UNDO_WINDOW_MS` (10 minutes) removes what the accept wrote or lifts the ignore. **A suggestion changes nothing on
  the Repo screen but the found-apps card until accepted.**
- **The read side** (`src/repo/scan-reads.ts`, secret-free, MCP-reachable — it must never import `scan-store.ts`,
  `apps.ts`, the secrets module, `src/github-app/` or `part-writes.ts`): `readScan`, `listSuggestions` (pending, and
  accepted ones whose app still exists; signal evidence refreshed from the current counts), **`readFound`** →
  `FactsFound` (pending suggestions + ≤ 12 seen names, workflow runs excluded; null when never scanned and nothing seen), **`readUnseen`**
  → `FactsUnseen` (null when never scanned, and for a non-primary repository): `looked`, `tags` (`readTags` — null
  until a reconcile read the repository's releases), `prs.open` / `mergedThisMonth` (null until `prs_reconciled`),
  workflow files and GitHub deployments of 30 days. `decide` draws `found` / `unseen` only while the repository has
  no app.

Tests: `test/repo-detect.test.ts` (parsers, every detector on its fixture, the registry, the token rules, proposed
parts), `test/repo-scan.test.ts` (› THE GUARD: the same root tree sha → zero further requests; › THE GUARD: a scan
with suggestions changes nothing; seen signals; describe; the lifecycle; the routes; fixtures in `fixtures/repo-scan/`).

## Org settings › Repositories › a repo › Apps

Admins only (a member on the address sees the Repositories list). `web/src/repo-apps.ts` (pure views),
`web/src/repo-apps-actions.ts` (the controller; every act `orgApps…`, handed over by `org-actions.ts`). Three pages of
the Repositories tab — `#org/repos/<owner>/<name>`, `…/apps/<key>`, `…/new` (hash.ts `orgRepo`; a repository row's
**Apps** button opens the first) — from ONE read, `GET …/repos/:owner/:name/apps` → `RepoAppsSetupDTO`: the
repository's apps each with every part of its key per environment (`describeParts`, so each carries THE status
function's connection), the suggestions and the last scan, the signals seen in 30 days, the **unassigned deploy
names** (`unassignedSignals`: deployment environments, or checks / statuses of a host Trov knows, that no `github`
part's setting names and no pending suggestion carries), `tags` (`readTags` — null until read, never "0 tags"), the
environments in drift order, the provider catalogue's words (`providers`, with `via_github`) and `degraded` (a failed
suggestions / signals / scan sub-read is that part empty, never a 500).

- **Apps** — the lead (N apps · Trov found M more; Scan again; Add an app; Accept all as the one accent action);
  **Suggestions** (a blue-ring "Suggested" `stateMark`, folder, kind · host or "no host", evidence, Ignore / Accept);
  **Apps** (name, folder, kind · host, a targets line — "Production from main · Staging from develop", "No targets ·
  ships inside web and docs" for a Package); **Unassigned deploy names** with **Make an app** (a key from the name —
  `keyFromSignalName`).
- **An app** — Name (the key is fixed), Folder, Kind (`segmented()`), Watch paths as a list, How a release shows up
  (a `dropdown()` for a Package or an app with no part: "A tag matching v*" only when tags were seen, "A workflow run
  of <file> on <branch>" per environment branch only for a workflow seen, "Not tracked"), and **Targets**, one row
  per environment: a part on a host is Hosting's own part row (`hostingPartRow`); a `github` part, or an environment
  where the app has no part, is the **deploy-signal picker** — a `dropdown()` of ONLY the signals seen in the last 30
  days a setting can name (`pickableSignals`), never a name not seen, not even the part's own stale setting (said
  under it). Add part / Edit open #185's `partEditorModal`, prefilled with the env and the APP KEY as the fixed part
  key (`PartDraft.app`); the environment's app-metrics token is set there too. Save writes the app, then each picked
  signal as the `github` part's setting. **Remove app** is the page's `confirmModal` with one `segmented()` choice:
  keep its parts (default) or remove them too.
- **Add an app** — Name (the key), Folder, Kind, How a release shows up; then the app's page.
- Accept, Accept all, Ignore and Remove (parts kept) answer with a 5-second toast carrying **Undo**
  (`orgAppsUndo`, a closure kept in the controller — never a token in the markup).
- **Signals and `github` settings** (`shared/repo-apps-setup-core.ts`, shared by the read and the screen): a
  deployment fills `environment`, a check run `check_app` + `check_name`, a workflow run `workflow` — exactly the
  identity `signalMatchesPart` holds a captured signal to, minus the branch. A commit status can name no part, so it
  is never offered.
- Org settings › Hosting keeps connections only: its Parts are one line per environment pointing here
  (`hosting-providers.md` › The screens).

Tests: `test/render.repo-apps.test.ts` (› the deploy-signal picker — GUARD: only signals seen in 30 days),
`test/repo-apps-setup.test.ts`.

## Releases

`releases` (0074, PK `(org_id, repo, tag)`; `source` `release` | `tag`; `published_at` GitHub's own instant; `author`
a GitHub LOGIN — not a handle column, mapped to a person on read; `notes` ≤ 4,000; `sha` only when GitHub said it;
`content_hash`). `src/repo/releases.ts`, writers in `src/repo/release-store.ts`.
- **Capture is gated**: `release` (published / released / prereleased / edited → upsert; deleted / unpublished →
  the row goes; a DRAFT never) and `create` of a tag (dated by the delivery's `repository.pushed_at`, else nothing)
  are derived by `releaseEventsFromDelivery` (`RELEASE_EVENT_NAMES` in `src/webhook.ts`) and put through
  `ingestRepoRelease` (`src/consumer.ts`: identity `(org, repo, tag)`, content-hash dedupe; a tag never downgrades a
  release; a release over a tag row keeps the tag's sha) — `ingestion-gate.md`.
- **Reconcile's `releases` arm** (`reconcileReleases`, ≤ **`RELEASES_RECONCILE_COST` = 2**): ONE `GET
  /releases?per_page=30` (drafts skipped; a list shorter than the page is the whole history, so a captured release
  no longer in it is removed) and, ONLY when the repository has no published release, ONE GraphQL page of its 30
  newest tags (`refs(refPrefix:"refs/tags/", orderBy: TAG_COMMIT_DATE)`; an annotated tag dated by its tagger, a
  lightweight one by its commit). Every row through the gate's release arm; a successful read writes the
  `releases_reconciled` snapshot (`{ repo }`).
- **`readRelease(ctx, repo, app?)`** → `FactsRelease | null`: the newest published non-prerelease release, or — for a
  repository with none — its newest tag (notes only for a release: headings and comments dropped, ≤ 280). `app`
  narrows by that app's `release_signal`: `tag:<glob>` keeps the matching tags; **`workflow:<file>@<branch>`** reads
  the app's latest SUCCESSFUL captured `run` of that workflow file (`raw.path`) on that branch instead — tag
  `<file> #<run number>` (`raw.run_number`, kept by the capture's `workflow_run` arm) or `<file> <short sha>` for a run
  row from before it carried one, dated by the run's completion, by its actor, notes null, `since` / `waiting` from the run's head sha on
  THAT branch, `cadence` the ≤ 8 successful runs before it (a re-run's attempts are one run); no run captured, or an
  app of a repository that is not the primary (runs are its capture) → null, never a tag in its place. A run says
  nothing about whether it reached a store, and the read claims nothing about it. `since` is counted on the default branch (the
  first environment's, else `main`) from the push that carried the tagged commit when one was captured, else from the
  release's date: `commits` sums captured pushes after it, `prs` counts PRs merged into that branch after it — each
  null unless its capture was recording by then (`recordingSince`), never a partial count. `waiting` lists those
  PRs newest first (≤ 10, listed even when the count is unknown). **`feature: true` ONLY by `isFeaturePr`**: a
  `feat:` / `feat(scope):` title prefix (any case) or a label `feature` / `enhancement` (any case) — the `pr` row's
  `raw.labels` (≤ 20, from the webhook and the PR-list backfill). `cadence` = the ≤ 8 releases before it, newest last.
- **`readTags(ctx, repo)`** → `FactsUnseen.tags` and `RepoAppsSetupDTO.tags`: every tag held, releases included.
- **`releaseWeekFigure(ctx, repo, now)`** → the week tile `releases`: null until `releases_reconciled` names the
  repository (0 before a read would be a guess).
- On screen: `releaseBlock` (R3) — tag, age, date, who, notes; since ("—" when unknown); the waiting PRs (merged
  glyph, "feature" only where `feature: true`); the cadence strip over the last 100 days and the gaps sentence.

Tests: `test/repo-releases.test.ts` (› a feature claim comes only from a feat prefix or a feature label (guard); › an
app whose release_signal is workflow:<file>@<branch>),
`test/render.repo-release.test.ts`.

## Costs: the reconcile arms and Poll now

Every number is a worst case, counted from the code; the callers start a unit only while it fits (`repo-dashboard.md`
› The budget).
- **`reconcileRequests(N)` = 16 + 2N + max(2, N) + `FACTS_COMPARE_CAP` (6) + `RELEASES_RECONCILE_COST` (2) +
  `PR_FILES_REQUESTS` (9)** (`src/repo/github.ts`; 39 for two environments): 16 + 2N for the capture arms,
  `driftCompares(N)` for the promotion chain, 6 for not shipped + out of step, 2 for releases, 9 for PR files. The
  `github_deploys` arm (a `github` part's deploys from history, above) reads D1 only and costs nothing.
- **`reconcileCost(N)`** (`src/repo/cron.ts`, the `:20` unit) = `reconcileRequests(N)` + (`PR_FILES_SYNC_REQUESTS` −
  `PR_FILES_REQUESTS`, the cron's wider PR-files allowance) + **`SCAN_COST` (5)** + `LOGO_IMPORT_COST` (3) +
  `GITHUB_MINT_COST` (1).
- **Poll now** (`runRepoRefresh`): `refreshSubrequests(N)` = 3N + `reconcileRequests(N)` (45 for two environments;
  the scan is off). **`SUBREQUEST_CAP` = 100** (it was the free plan's 50 until the promotion chain, the facts arms,
  releases and PR files pushed a five-environment org past it): the GitHub arm runs for N ≤ 11 (99; 105 at twelve),
  else it is skipped and says so; the hosting arm runs only when `refreshSubrequests(N)` + 1 (a mint) + Σ
  `providerPollCost` ≤ `SUBREQUEST_CAP` (54 left for two environments).
- **A hosting unit** (`:40`) = its provider's `pollCost` + `ROLLBACK_COMPARE_COST` (1) when the provider reports
  deploys; a `github` part 0. Cloudflare's `pollCost` is 6, Vercel's and Netlify's 2 (previews).
- Tests: `test/repo-facts.reconcile.test.ts` › the cost, `test/repo-releases.test.ts` › is counted,
  `test/repo-refresh.test.ts`.

## Guards — what each is and the test that holds it

| Guard | Where | Test |
| --- | --- | --- |
| One card per provider; a scoped (leftover) credential is never a connection, never counted | `listConnections`, `shared/hosting-status-core.ts` | `test/hosting.leftovers.test.ts`, `test/hosting.status.test.ts` › leftovers are never the connection |
| Card / part row / checklist / Test this part agree for every sample combination | `hostingStatus` (THE status function) | `test/render.hosting.test.ts` › ONE status, everywhere |
| An untagged signal never sets a part's deploy without a matching part setting | `signalMatchesPart` | `test/hosting.github-deploys.test.ts` › THE GUARD |
| The sha join's one-candidate rule | `joinCandidate` | `test/hosting.sha-join.test.ts` › THE ONE-CANDIDATE RULE |
| The rollback compare: one compare, `behind` only | `checkRollback` | `test/hosting.github-deploys.test.ts` › THE ROLLBACK COMPARE |
| The scan's tree-sha skip | `scanRepo` | `test/repo-scan.test.ts` › THE GUARD: the same root tree sha |
| Suggestions change nothing until accepted | `scanRepo` writes suggestions only | `test/repo-scan.test.ts` › THE GUARD: a scan with suggestions changes nothing |
| `decide()` parity SPA ↔ MCP (and core ↔ design) | `shared/repo-layout-core.ts` | `test/repo-facts.parity.test.ts`, `test/repo-layout.test.ts` |
| Watch-path filtering (≥ 2 apps, only when commits list files) | `computeNotShipped`, `matchesWatch` | `test/repo-facts.reconcile.test.ts` |
| No "not connected" for absent things, per scenario | the Overview's blocks, the Usage targets, found / unseen | `test/render.repo-overview.test.ts`, `test/render.repo-usage.test.ts`, `test/render.repo-found.test.ts` |
| A feature claim only from a `feat` prefix or a feature label | `isFeaturePr` | `test/repo-releases.test.ts` |
| The deploy-signal picker offers only signals seen in 30 days | `pickableSignals` | `test/render.repo-apps.test.ts` |

## Migrations 0070–0074

The build reserved `0070`–`0079` (clear of #178's renumbering). All additive.
- `0070_repo_apps` (Phase A) — `repo_apps` + a row per existing part key; `hosting_deploys.source` / `reason` /
  `sha_source` / `rolled_back_from`.
- `0071_repo_settings` (Phase C) — `repo_settings`. Rollback: `DROP TABLE repo_settings; DELETE FROM org_admin_audit
  WHERE action = 'repo.settings';`.
- `0072_repo_scans` (Phase D) — `repo_scans`, `repo_app_suggestions`.
- `0073_commit_paths` (Phase E) — `commit_paths`, `pr_files`, `pr_file_reads` (no handle column). Rollback: `DROP TABLE
  pr_file_reads; DROP TABLE pr_files; DROP TABLE commit_paths;`. See Monorepos below.
- `0074_releases` (Phase F) — `releases`. Rollback: `DROP TABLE releases;`.
- `0075`–`0079` spare.

Every new table is in `ORG_TABLES` (`src/deletion/tables.ts`) and the test reset (`scripts/seed/reset.mjs`); the
handle columns `repo_apps.created_by` / `updated_by`, `repo_app_suggestions.decided_by` and `repo_settings.updated_by`
are in `HANDLE_COLUMNS` (`src/auth/persons.ts`). `releases.author` is a GitHub login, deliberately not.

## Monorepos (Phase E)

Two captures, both through the gate (`ingestion-gate.md` — `ingestCommitPaths`, `ingestPrFiles`), both off the render path:
- **Commit paths** (`src/repo/commit-paths.ts`, `src/repo/path-capture.ts`): a `push` delivery's own `commits[].added /
  modified / removed` → `commit_paths` rows with `scope = 'commit'` (exactly that commit's files), written FIRST on the
  delivery so the drift refresh's not-shipped compare already reads them. A push that lists `PUSH_PAYLOAD_COMMIT_CAP`
  (20) commits, or a commit whose lists are missing or reach `PATHS_PER_COMMIT_CAP` (300 — UNVERIFIED: GitHub documents
  no per-commit cap), was cut short; when the HEAD commit has no exact list and `before` is a real commit, ONE `compare`
  (before...after, deferred under `waitUntil`) fills in — its `files` belong to the whole push, so they are stored under
  the head commit as `scope = 'push'` (`'push_partial'` at the compare's own 300-file cap). A `push*` row is never read
  as a commit's: the not-shipped filter and the commit counts read `commit` rows only; only CI's head-commit attribution
  reads a push's, marked `approx`. A commit with neither is UNKNOWN. ≤ `PUSH_PATH_ROWS_CAP` (1,000) rows per push.
- **PR files** (`src/repo/pr-files.ts`, `src/repo/pr-files-store.ts`): `GET /pulls/{n}/files`, ≤ 3 pages of 100 (three
  full pages = `complete: false`), only for a repository with two or more apps (Packages count), for open PRs and PRs
  merged in the last 14 days — on the `pull_request` webhook (opened / reopened / synchronize / closed-merged; no
  request when the files were read for that head) and reconcile's `pr_files` arm (`repo-dashboard.md` › reconcile; ≤ 9 requests on Poll now, 30 on the cron's unit and Sync GitHub). `pr_file_reads` holds the
  head each list was read for: no row = never read = unknown.
- **The narrowing** (`src/tools/repo-scope.ts`, `src/repo/app-scope.ts`; the rules in `shared/repo-scope-core.ts`, which
  the SPA words with): a PR / commit / run TOUCHES the apps (not Packages) whose watch paths its files hit and the
  Packages they hit; it REACHES an app it touches, or that uses a Package it touches (`usedBy`). Only in a repository
  with two or more apps: under All apps each listed PR carries `touches` / `packages` (`null` = never read: no
  "touches" line) and each CI failure `apps` (`null` = unknown) and `approx`; under an app key the Code tiles (Open
  PRs, Merged this week, Commits this week — the week's pushed commits by their own files —, Contributors; a figure
  with one unknown member is `value: null` with how many in its `sub`, "—" on screen), the 14-day bars (the app's
  commits per push day, the note naming how many have unknown paths), the PR list (its 8 among the 100 most recently
  touched PRs of 90 days, their checks and approvals read for just those) and the CI failures (the app's failed runs;
  the 7-day rate over its decisive runs, `null` unless a week of run capture AND every run of the window is
  attributed) are its own; `__repo` = touching no app and no package. **Unknown is never guessed into an app**, nor
  into `__repo`; a PR read past its page cap belongs where it hits and is unknown where it does not. A run belongs to
  the apps a `github` part's `workflow` setting names (by file name) or whose watch paths cover its workflow file,
  plus its head commit's files. The deploy strips carry `envLabel` / `host`; the screen groups them per app. A throw
  costs the narrowing alone (`degraded`, the narrowed sections empty). On screen (`web/src/repo-scope.ts`): the scope
  line ("Pull requests that touch apps/api/** or packages/db/**", Show all apps), the touches cell (the apps it reaches,
  "Repo-wide", and "via packages/ui" — under an app only when the app is reached through a Package alone), a failure's
  apps after its workflow (All apps), strips per app. The sample narrows scenario E with `sampleScopes` (the design's
  `CODE_E_API` / `CI_E`). Tests: `test/repo-monorepo.capture.test.ts`, `test/repo-monorepo.scope.test.ts`,
  `test/render.repo-monorepo.test.ts`.

Costs: the webhook's push arm asks ONE compare at most per delivery (only when the head commit's lists were cut
short); a `pull_request` delivery ≤ 3 requests (none when already read for that head); reconcile's `pr_files` arm is
in `reconcileRequests` (`PR_FILES_REQUESTS` = 9 — Poll now's `refreshSubrequests` fits `SUBREQUEST_CAP` up to 11
environments) and widened by `ReconcileLimits` to `PR_FILES_SYNC_REQUESTS` = 30 for the cron's unit and Sync GitHub
(`reconcileCost`). Retention: 100 days (`pruneRepoCapture`). Not done in Phase E: the sha join's app attribution stays
the branch alone (above).
