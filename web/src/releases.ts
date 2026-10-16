// What's new (Help › What's new): `#releases` is a grid of every release; each release
// has two pages, `#releases/<v>` (its release notes) and `#releases/<v>/patches` (its
// patch notes), where `<v>` is the version ("0.14") or "unreleased".
//
// Pure data + a pure renderer, no backend: RELEASES below is the whole record, and
// `releasesScreen` turns it into the screen's markup. Every string goes through `esc`.
//
// ── How to add the next release ──────────────────────────────────────────────
// Every PR that ships something adds its lines to the FIRST entry, "Unreleased":
// The RELEASE NOTES (the index cards, `#releases/<v>`) are for Trov's USERS; the PATCH
// NOTES (`#releases/<v>/patches`) are for the people who build and deploy it.
//   • `highlights` — for users: what you can now do, in product words (no files,
//     routes, tables, migrations or PR numbers). 3–6 lines per release.
//   • `headsUp`    — for users: a change they will NOTICE in the product, in plain words
//     (a limit, a removed option). Omit it when there is none.
//   • `ops`        — for whoever deploys: migrations to apply, secrets, triggers, plugin
//     updates. Shown as "Upgrade notes" at the top of the patch notes only.
//   • `patches`    — the granular log, grouped added / changed / fixed / removed. Terse,
//     may name files, routes and migrations; `code` in backticks; end a line with
//     `(#123)` to link that pull request on GitHub (github.com/AndresL230/trov — the repo moved from SaplingLearn/canopy; GitHub redirects old PR links).
//   • `prs`        — the pull requests the release carries (listed on the patch notes).
// A merge to `main` IS a production deploy, so the PR that merges a batch also cuts it:
// set `version` to the next `0.N`, `date` to the merge day (YYYY-MM-DD) and drop
// `unreleased` — main never carries an "Unreleased" entry. A small follow-up with too
// little for its own 3–6 highlights adds its patch lines (and PR) to the newest version
// instead. Newest first; dates never increase down the list
// (test/releases.test.ts checks the order, unique versions, and that every release has
// highlights).
//
// Versioning: `0.N`, one number per feature milestone (the merges that shipped together,
// usually a day or a few days of work), counted from the first deploy in June 2026.
// Every line below is traceable to a merged pull request, a commit on `main`, or — for
// Unreleased — the working tree it describes.

import { esc, attr, surface } from "./ui";
import { segmented } from "./segmented";
import { stateMark } from "./marks";
import { SOURCE_PATH, TROV_SOURCE_REPO } from "@shared/legal-core";

export interface ReleasePatches {
  added: string[];
  changed: string[];
  fixed: string[];
  removed: string[];
}

export interface Release {
  /** `0.N`, or "Unreleased" for the batch not yet deployed. */
  version: string;
  /** YYYY-MM-DD — the day it merged (for Unreleased: the day the entry was last updated). */
  date: string;
  /** Not deployed yet: rendered with an "Unreleased" tag instead of a ship date. */
  unreleased?: boolean;
  title: string;
  /** One line under the title. */
  headline: string;
  /** 3–6 bullets for people, in product words. */
  highlights: string[];
  /** For USERS: a change they will notice in the product, in plain words (never a
   *  migration, secret, deploy step or plugin version — those are `ops`). Omit when none. */
  headsUp?: string[];
  /** Upgrade notes for whoever deploys: migrations, secrets, triggers, plugin updates.
   *  Shown only at the top of the release's PATCH notes. */
  ops?: string[];
  patches: ReleasePatches;
  /** Pull requests on AndresL230/trov (formerly SaplingLearn/canopy — PR numbers carried over). */
  prs?: number[];
}

export const TROV_REPO_URL = TROV_SOURCE_REPO;
export const prUrl = (n: number): string => `${TROV_REPO_URL}/pull/${n}`;

export const RELEASES: Release[] = [
  // Repo setups (handoff #11, `feat/repo-setups`), in progress. Phase 0: Org settings bugs, and one place for each thing.
  // Phase A: apps, the GitHub provider, a commit on every deploy. Phase C: the Overview from facts.
  {
    version: "Unreleased",
    date: "2026-10-15",
    unreleased: true,
    title: "Repo setups",
    headline: "The Repo screen fits every kind of repository, every deploy carries its commit, and Org settings says plainly what is connected.",
    highlights: [
      "The Repo screen's Overview takes the shape of the repository — its apps and environments — and opens with what needs attention, in plain sentences: a deploy that failed and what is still serving, an app that is down, a rollback, a check failing, commits merged and not yet live. A repository that ships by releases or tags opens on its latest release: what has merged since, the features waiting to ship, and how often it releases.",
      "A repository with several apps gets an App menu that narrows every tab to one app; an organization with several repositories gets a repository menu. Each environment's state sits in the header, and Group by switches between environment cards and a table of apps (an admin can make either the default). In Code and CI each pull request says which apps it touches (\"api, jobs\", or \"via packages/ui\" when it reaches an app only through a shared package), and the counts, commit bars, CI failures and deploy history follow the App menu; a pull request Trov has not read yet shows under All apps only — never guessed into an app.",
      "Every deploy shows the commit it shipped, or says it doesn't know; a failed deploy says why, a production deploy that went back to an older commit is marked as a rollback, and Vercel and Netlify previews are read with their branch.",
      "An app deployed by GitHub Actions — or on a host Trov cannot read yet — can be a part too: pick GitHub deployments as its host. Render, Railway and Fly.io are now detected from what they report to GitHub. Trov also reads a repository's deploy files (Cloudflare, Vercel, Netlify, Fly.io, Render and Railway configs, monorepo workspaces…) and the deploys GitHub has seen, and suggests its apps — nothing changes until an admin accepts one, and an accept can be undone.",
      "Each repository has an Apps page in Org settings › Repositories: accept or ignore the apps Trov found (with Undo), add one by hand, set an app's kind, folder and watch paths, and choose how Trov sees its deploys from the names GitHub reported in the last 30 days. Org settings › Hosting keeps one card per host, its status the same everywhere, and offers old Railway tokens for removal instead of posing them as connections. Preview with sample data gains a switch over fourteen kinds of repository.",
      "The Usage tab shows each app in each environment on its own card — its traffic, or its CPU and memory — or says plainly that its host is not connected, has nothing to report, or has gone quiet. A Cloudflare Worker also shows how its requests ended, its CPU time, its D1 databases and its cron runs, and Trov itself can report its own product figures to the Repo screen.",
    ],
    ops: [
      "Apply `migrations/0070_repo_apps.sql` (merging to main applies it): ADDITIVE — the `repo_apps` table with a row per existing part key (SaplingLearn's `frontend` / `backend`), and four `hosting_deploys` columns (`source`, `reason`, `sha_source`, `rolled_back_from`). No rebuild, no data removed.",
      "Subscribe the GitHub App to deployment, release, create, workflow_job (GitHub › Developer settings › GitHub Apps › trov-by-trovlabs › Permissions & events › Subscribe to events). It already has the permissions they need (Deployments, Contents, Actions: read), so installations need not re-approve. It is already subscribed to `deployment_status` and `status`, which Trov now captures.",
      "Optional, for Cloudflare deploys' commits: give the Cloudflare API token a third permission, Account › Workers CI › Read (it must be a USER token — My Profile › API Tokens). Without it the Cloudflare part's state says \"commit: the token needs Workers CI Read\" and the commit is matched from GitHub when it can be. UNVERIFIED: that Read (not Edit) suffices.",
      "The hosting job's cost per part grows by one (the possible GitHub compare for a rollback), and Cloudflare, Vercel and Netlify each make one more request per poll — still inside the `:40` budget; no trigger change.",
      "Apply `migrations/0071_repo_settings.sql` (merging to main applies it): ADDITIVE — the `repo_settings` table (an admin's per-repository Overview default). Rollback: `DROP TABLE repo_settings; DELETE FROM org_admin_audit WHERE action = 'repo.settings';`.",
      "Apply `migrations/0074_releases.sql` (merging to main applies it): ADDITIVE — the `releases` table (a repository's releases and tags). Rollback: `DROP TABLE releases;`. Releases arrive through the App's `release` / `create` subscription (above); the first reconcile after the merge backfills the 30 newest releases (or tags). The reconcile costs 2 more GitHub requests (`reconcileCost`; \"Poll now\" is `refreshSubrequests(N)`, 45 for two environments with the PR-files arm below) — no trigger change.",
      "Apply `migrations/0072_repo_scans.sql` (merging to main applies it): ADDITIVE — `repo_scans` and `repo_app_suggestions`. The `:20` reconcile unit now budgets the repo scan (`SCAN_COST` = 5: a tree read, and only when the default branch's tree changed a GraphQL file batch + one describe per connected Vercel / Render / Netlify) — no trigger change.",
      "Usage families (Phase G): no migration, no new secret, no trigger change. A Cloudflare part's poll now makes one more request every hour (its cron runs) and two more once a day (the day's CPU / wall-time quantiles and, when the part names D1 database ids, D1) — Cloudflare's `pollCost` is 6 (+1 rollback compare), inside the `:40` budget; the existing token's Account Analytics Read covers all of it. To see D1 on a Cloudflare part, set its D1 database ids in the part editor (the repo scan proposes them).",
      "Optional — Trov's own Product block: in the org that runs Trov's repository, set the Production environment's API URL to Trov's origin and paste a member's `trov_mcp_` token as its app metrics token (a Production part's editor, opened from Org settings › Repositories › a repo › Apps); the `:00` poll then reads `GET /api/internal/metrics` (contract v3, `docs/superpowers/specs/2026-10-15-app-metrics-v3.md`).",
      "Apply `migrations/0073_commit_paths.sql` (merging to main applies it): ADDITIVE — `commit_paths`, `pr_files`, `pr_file_reads` (which files a commit and a pull request touched; 100-day retention in `pruneRepoCapture`). Rollback: `DROP TABLE pr_file_reads; DROP TABLE pr_files; DROP TABLE commit_paths;`. No new secret, no trigger change, no new App permission (Pull requests: read already covers `/pulls/{n}/files`). Reconcile's worst case grows by 9 requests (the PR-files arm; the cron and Sync GitHub read up to 30), so Poll now's `refreshSubrequests` is 45 for two environments and fits `SUBREQUEST_CAP` (100) up to 11 environments (was 12).",
    ],
    headsUp: [
      "Hosting tokens moved from Integrations to Hosting, and each environment's app metrics token to its parts' editor (Org settings › Repositories › a repository › Apps). Nothing was reset: every token you saved is still there.",
    ],
    patches: {
      added: [
        "Migration `0072_repo_scans`; `src/repo/scan.ts` — the repo scan as a guarded `reconcileRepo` arm (`scan`; the cron and Sync GitHub, not Poll now): one tree read, then ONLY when the root tree sha changed one GraphQL batch of ≤ 24 files and ≤ 1 `describe` per connected host (`SCAN_COST`, in `reconcileCost`)",
        "`src/repo/detect/`: the detector registry (workspaces, wrangler, vercel, netlify, fly, render, railway, amplify, `.do/app.yaml`, Procfile, Dockerfile + a deploying workflow), safe TOML / YAML / JSONC subset parsers, the signal token rules (exactly one candidate per signal)",
        "`HostingProvider.describe` (optional): Vercel `rootDirectory` + `link.repo`, Render `rootDir`, Netlify `build_settings.base` — one list call each, in the scan only",
        "`src/repo/signals.ts` `seenSignals`; `src/repo/scan-reads.ts` (`readFound`, `readUnseen`, `listSuggestions`, `readScan` — secret-free); `src/repo/scan-store.ts` (`acceptSuggestion` / `ignoreSuggestion` / `undoAccept` / `runScanNow`); `POST /api/o/:slug/repos/:owner/:name/scan`, `…/suggestions/:id/accept|ignore`, `…/suggestions/undo` (admin, cookie only)",
        "Tests: `test/repo-detect.test.ts`, `test/repo-scan.test.ts` (fixtures in `fixtures/repo-scan/`)",
        "`shared/hosting-status-core.ts`: THE status function (`hostingStatus`, `providerStatus`, `orgConnection`) — the provider card, part rows, checklist, lead, Test this part and the Repo dashboard's not-connected copy all read it.",
        "`DELETE /api/o/:slug/hosting/:provider/leftovers` (admin, cookie only): removes a provider's credentials stored under a non-empty scope, audited `hosting.leftovers_removed` (+ `secret.delete` reason `leftover`); \"Remove old tokens\" in the provider's Manage dialog, behind the page's confirmation.",
        "`HostingSetupDTO.leftovers` and `HostingEnvironmentDTO.app_metrics`; `RepoProviderPart.connection` (the part's provider status, from `org_secrets` metadata and `org_hosting_connections` — never a value).",
        "The Hosting sample preview's Flow switcher gains \"Leftover tokens\"; a test holds the card, the part rows, the checklist and Test this part to the same status for every Flow × Stack.",
        "The part editor's app metrics token field (stored as before: `metrics_endpoint`, scoped to the environment, so the `:00` poller reads it unchanged).",
        "Migration `0070_repo_apps`: `repo_apps` (PK `(org_id, key)`; kind Site / Service / Worker / Job / Package; watch globs; source migrated / manual / suggested), a row per existing part key; `hosting_deploys.source` / `reason` / `sha_source` / `rolled_back_from`",
        "`src/repo/apps.ts`: `listRepoApps(ctx, repo?)` (synthesises an app at the primary repo's root for a part key with no row) and the admin writers `putRepoApp` / `deleteRepoApp`, audited `app.set` / `app.delete`; `shared/repo-apps-core.ts` `RepoApp`",
        "The `github` hosting provider (`src/hosting/providers/github.ts`): GitHub deployments, NO credential of its own (`credential: \"github_app\"`, `via_github` on the DTO, always live in `hostingStatus`), `pollCost` 0, roles web + service; exactly one of a deployment environment, a check run (app + name) or a workflow file (`checkSettings`)",
        "`src/hosting/github-deploys.ts`: a `github` part's deploys from the webhook capture — only through the part's own setting, on the environment's branch (`signalMatchesPart`)",
        "`src/hosting/sha-join.ts`: after a poll, a deploy with no sha takes the ONE commit whose GitHub check / run / deployment / status finished on the environment's branch in the 10 minutes before it (`sha_source = 'joined'`); none or several leave it NULL",
        "`src/hosting/rollback.ts`: a new production `ready` sha costs ONE GitHub compare (previous...new) through `resolveGithubCredential`; `behind` sets `rolled_back_from` — on the poll path and the webhook path",
        "`src/hosting/deploy-store.ts`: the `hosting_deploys` upsert, shared by the poll and the capture (secret-free, so the webhook may call it)",
        "Cloudflare reads the newest deployment's commit from the Workers Builds API (`/builds/builds?version_ids=`) — `pollCost` 3; refused, the poll notes it (`PollResult.notes`) and the join takes over",
        "Tests: `test/repo-apps.test.ts`, `test/hosting.provider.github.test.ts`, `test/hosting.github-deploys.test.ts`, `test/hosting.sha-join.test.ts`, `test/hosting.previews.test.ts`",
        "The Overview from facts: `web/src/repo-overview.ts` (`overviewFacts` — the state slot, attention, the connect card, the opener by `layoutOf`, not shipped, week, links; each block wrapped in `data-repo-block`), `repo-attention.ts` (structured attention worded into the design's sentences, hosts by their part's label), `repo-week.ts`, `repo-connect.ts`, `repo-verdict.ts` (`envVerdict`, shared with the environment cards), `repo-header.ts` (repository / App menus, environment pills, Group by)",
        "Migration `0071_repo_settings`: `repo_settings` (PK `(org_id, repo)`, `overview_group` env / app / NULL); `PUT /api/o/:slug/repo/settings` (admin, cookie only, audited `repo.settings`); `readRepoSettings(ctx, repo)` for the facts read",
        "`#repo[/<tab>]?repo=<owner%2Fname>&app=<key>` and `GET /repo/dashboard?repo=&app=` (read by the Worker with the facts read); `RepoDashboard.facts`; `FactsPart.reportsMetrics`",
        "The sample's scenario switch (Scenario × Variant dropdowns; names in `web/src/repo-sample-keys.ts`)",
        "Tests: `test/render.repo-overview.test.ts` (every scenario × variant × app × Group by against the design's `buildScreen`; no \"not connected\" for absent things), `test/repo-settings.routes.test.ts`, hash routes",
        "Repo › Overview blocks (Phase C2), each an `OverviewBlock` over `RepoFacts`: `envCardsBlock` (`web/src/repo-env-cards.ts`), `driftBlock` (`web/src/repo-drift.ts`), `appsTableBlock` (`web/src/repo-apps-table.ts`), `notShippedBlock` (`web/src/repo-not-shipped.ts`); `envVerdict(f, env)` (`web/src/repo-verdict.ts`, the design's `verdictFor`); the shared marks, sha chip, byline, URL and commit groups in `web/src/repo-block-kit.ts`; disclosures through one act, `repoOpen` + the block's key",
        "Tests: `test/render.repo-env-cards.test.ts`, `test/render.repo-drift.test.ts`, `test/render.repo-apps-table.test.ts`, `test/render.repo-not-shipped.test.ts`",
        "Overview blocks from `RepoFacts`, per the Repo-setups design: `productionBlock` (`web/src/repo-production.ts`: verdict, serving row, failed / cancelled block, Next row, URL and health, CI on head, the last-20 strip and its sentence), `previewsBlock` (`web/src/repo-previews.ts`), `releaseBlock` (`web/src/repo-release.ts`: since, waiting PRs, cadence strip, gaps sentence), `foundBlock` and `unseenBlock` (`web/src/repo-found.ts`: Accept / Ignore as `repoFoundAccept` / `repoFoundIgnore`, disabled in sample mode); shared pieces in `web/src/repo-block-kit.ts` (deploy-state marks on `stateMark`, https-only links that never leave sample data)",
        "Org settings › Repositories › a repo › Apps (`#org/repos/<owner>/<name>[/apps/<key>|/new]`; `web/src/repo-apps.ts`, `web/src/repo-apps-actions.ts`): suggestions with Accept / Ignore / Accept all / Scan again and a 5-second Undo toast, the accepted apps with a targets line, unassigned deploy names with Make an app, an app's page (kind `segmented()`, folder, watch paths, how a release shows up, a target per environment — Hosting's part row, or the deploy-signal `dropdown()` offering only signals seen in 30 days), Add an app, Remove behind `confirmModal` (keep the parts, or remove them too)",
        "`GET|PUT|DELETE /api/o/:slug/repos/:owner/:name/apps[/:key]` (admin, cookie only; `src/repo/apps-routes.ts`, `src/repo/apps-setup.ts`): the Apps read (`RepoAppsSetupDTO` + `environments`, `providers`, `degraded`) and the app writes through `putRepoApp` / `deleteRepoApp` (`?parts=remove` also `deletePart`s); a key of another repository is a 409 `app_conflict`",
        "`shared/repo-apps-setup-core.ts`: which `github` part setting a seen signal fills (`signalSettings`), whether a setting names it, unassigned deploy names, the picker's list (`pickableSignals`), a key from a deploy name",
        "The Repo screen's found-apps card: `repoFoundAccept` / `repoFoundIgnore` call the scan's accept / ignore routes, with the same toast + Undo, then read the dashboard again",
        "Tests: `test/repo-apps-setup.test.ts`, `test/render.repo-apps.test.ts`",
        "Tests: `test/render.repo-production.test.ts`, `test/render.repo-previews.test.ts`, `test/render.repo-release.test.ts`, `test/render.repo-found.test.ts` — every scenario that opens on each block, narrowed facts, unknown drawn as unknown, no \"not connected\" for a thing the repository does not have",
        "The facts read (Phase B): `RepoDashboard.facts` from `src/tools/repo-facts.ts` inside the one projection — apps (implicit ones too), environments with a part of them, each part's serving / latest / history, health per part (stale past 30 minutes), previews matched to open PRs with their fail streak, CI per environment, the seven week figures (null = unknown), structured attention, the admin's connect hint, `groupDefault` from `repo_settings`; `narrowFacts` for `?app=`",
        "`GET /repo/dashboard?repo=&app=`: `repo` checked against `org_repos` (unknown → 404 `{ error }`), `app` narrows the facts and the per-part sections (environments' parts, deploys, usage, providers); an unknown app is every app",
        "MCP `get_repo_dashboard` takes `repo` and `app` and returns `facts` and `layout` (`layoutOf(layoutInputOf(facts), facts.groupDefault)`) with the overview; the pure view is `src/tools/repo-agent-view.ts`",
        "Reconcile arms `not_shipped` and `out_of_step` and the promotion chain (`src/repo/facts-compute.ts`; snapshots `not_shipped`, `out_of_step`, `drift_chain`), also run on a push to an environment branch; `FACTS_COMPARE_CAP` = 6, incremental; watch-path filtering (`src/repo/watch.ts`) when a compare's commits list their files",
        "Tests: `test/repo-facts.test.ts`, `test/repo-facts.reconcile.test.ts`, `test/repo-facts.parity.test.ts` (decide() parity SPA ↔ MCP over every scenario × variant × app × default Group by)",
        "Migration `0074_releases`: `releases` (PK `(org_id, repo, tag)`; `source` release | tag; `author` a GitHub login; `content_hash`); in `ORG_TABLES` and the test reset",
        "The gate's release arm `ingestRepoRelease` (`src/consumer.ts`): content-hash dedupe on `(repo, tag)`; a tag never downgrades a release; drafts and rows without GitHub's own date are never written. Writers in `src/repo/release-store.ts`",
        "`src/repo/releases.ts`: `releaseEventsFromDelivery` (`release` published / released / prereleased / edited / deleted / unpublished; `create` of a tag, dated by `repository.pushed_at`), reconcile's `releases` arm `reconcileReleases` (`GET /releases?per_page=30`, else one GraphQL page of tags with dates; `RELEASES_RECONCILE_COST` = 2; the `releases_reconciled` marker), and the reads `readRelease(ctx, repo, app?)` → `FactsRelease`, `readTags(ctx, repo)` → `FactsUnseen.tags`, `releaseWeekFigure(ctx, repo, now)` → the week tile `releases`",
        "`isFeaturePr`: a waiting PR is a feature only by a `feat:` / `feat(scope):` title prefix or a `feature` / `enhancement` label",
        "Tests: `test/repo-releases.test.ts` (capture arms, gate dedupe, backfill with releases present / absent, the cost, since / waiting / cadence, the feature guard, tags, the week figure)",
        "Usage families (Phase G): `shared/usage-families-core.ts` — traffic / latency / compute over `HOSTING_METRICS`, the extra outcomes / runtime / storage / schedules a provider declares in `capabilities.families`, their `hx_` names (`hx_outcome_<status>`, `hx_subrequests`, `hx_cpu_time_p50_us` / `_p99_us`, `hx_wall_time_p50_us`, `hx_daily_read`, `hx_d1_<field>:<id>`, `hx_cron_<field>:<expr>`); `RepoProviderPart.families` / `.extras`",
        "Cloudflare poll: the analytics query grouped by invocation outcome (`status`) with `subrequests`; `workersInvocationsScheduled` per cron; once a day (`ProviderContext.daily`, the `hx_daily_read` marker) the completed day's quantiles and, for the part's optional `d1_database_ids`, D1 analytics and storage; optional `crons` part setting; `pollCost` 3 → 6; fixtures `scheduled.json`, `runtime.json`, `d1.json`",
        "`validatePoll` checks extra points by name, declared family, role and grain; `PollResult.families` and `{ family, reason }` entries in `hosting_poll_state.unavailable` (`mergeFamilies`); `dailyDay` / `dailyRead` (the once-a-day rule)",
        "`src/tools/repo-extras.ts`: a part's outcomes, runtime, storage and schedules from ONE more read (`extraMetricsSince`), made only when a provider declares an extra family; MCP collapses them to the asked range",
        "App metrics contract v3 (`appMetricsV3`): self-described groups with shapes (`ranked` / `stats` / `figure` / `status`), the description in the `app_metrics:<env>` snapshot (`snapshotsByPrefix`, `deleteSnapshot`); `RepoProductGroup.shape` / `now` / `note`, `RepoProductCount.tone`, `RepoProductEnv.version` / `part` / `label`; spec `docs/superpowers/specs/2026-10-15-app-metrics-v3.md`",
        "`GET /api/internal/metrics` (`src/internal-metrics.ts`, `src/data/own-metrics.ts`): Trov's own v3 body for the bearer's one org — right now, MCP tool calls ranked, the gate, activity; D1 only",
        "`web/src/repo-usage.ts`: the Usage tab's targets (`targetState`: ok / stale / nc / na; `targetsFromFacts`, `partFromFacts`) and extra blocks (outcome bar, runtime, D1, crons); the Product block draws a v3 group by its shape; the sample's `repoScenarioUsage`",
        "Tests: `test/hosting.poll.families.test.ts`, `test/repo-dashboard.extras.test.ts`, `test/repo-poll.v3.test.ts`, `test/internal-metrics.test.ts`, `test/render.repo-usage.test.ts`; the Cloudflare provider test grows outcomes, schedules and the daily read",
        "Migration `0073_commit_paths`; `src/repo/commit-paths.ts` (a push's own `added / modified / removed` → exact `commit` rows; ONE compare only when the head commit's lists were cut short, its files stored as the PUSH's: `push` / `push_partial`), `src/repo/path-capture.ts` (the webhook's push arm, before the drift refresh), `src/repo/pr-files.ts` + `pr-files-store.ts` (≤ 3 pages of `/pulls/{n}/files`, repositories with two or more apps, open PRs and PRs merged in 14 days; the webhook on opened / reopened / synchronize / closed-merged, skipped when read for the head; reconcile's bounded `pr_files` arm — `PR_FILES_REQUESTS` 9, `PR_FILES_SYNC_REQUESTS` 30 for the cron and Sync). The gate's two sibling arms `ingestCommitPaths` / `ingestPrFiles` (`src/consumer.ts`).",
        "The App menu narrows Code and CI (`src/tools/repo-scope.ts`, `src/repo/app-scope.ts`, `shared/repo-scope-core.ts`): `RepoPr.touches` / `packages`, `RepoCiFailure.apps` / `approx`, `RepoDeployRow.envLabel` / `host`; under an app the tiles (nullable `RepoCodeStat.value`), bars, PR list and CI failures are its own; `__repo` = touching no app; unknown is never counted into one. `FactsApp.openPrs` per app and a Package's `usedBy` (from the scan's workspace graph). `web/src/repo-scope.ts`: the scope line + Show all apps, the touches cell, failures' apps, strips per app; the sample's `sampleScopes` (scenario E, the design's `CODE_E_API` / `CI_E`).",
        "Tests: `test/repo-monorepo.capture.test.ts`, `test/repo-monorepo.scope.test.ts` (incl. the watch-path filtering guard), `test/render.repo-monorepo.test.ts`.",
        "`docs/architecture/repo-apps.md`: the area reference for apps, the Overview's facts and layout, detection and Repositories › Apps, releases, their costs and guards (a row in CLAUDE.md's table); `repo-dashboard.md` and `hosting-providers.md` point to it instead of repeating it",
      ],
      changed: [
        "`listConnections` returns ONE org-wide row per provider; a scoped hosting credential is a leftover, never a connection, never counted.",
        "Org settings › Hosting: the environment tiles are gone; a card lists what uses it (\"Backend in Staging and Production\"). Its Parts are one line per environment pointing to Repositories › <repo> › Apps, where a part's row (status, last poll, Test this part, Edit — `hostingPartRow`) now lives; the part editor opened from an app is prefilled with the app key, fixed.",
        "`POST /hosting/:provider/test` on a provider that is not connected answers `{ ok: false, detail: \"<Provider> isn't connected.\" }` without probing (was 404 \"No secret is set\").",
        "Org settings › Integrations lists GitHub and the non-hosting integrations only, with one line to Hosting; Environments links to Hosting for what each one runs.",
        "GitHub deploy signals are captured again, untagged: `deployment` / `deployment_status` deliveries and every commit status other than `canopy/*` become `repo_events` kind `deploy` with `raw.signal` (`deployment` | `status`), kept 90 days (`pruneRepoCapture`); workflow runs keep their `path`, check runs their `output_title`",
        "`detect.ts` also reads deployments by creator login and commit statuses by context (`Vercel`, `netlify/…`, `Render`, `Workers Builds`), still narrowly",
        "Failure reasons: Netlify `error_message`, Vercel `errorMessage` (else the alias error), Render's failed status, a GitHub deployment's description or a check's `output.title` — scrubbed before the cut to 140",
        "Vercel and Netlify production parts read their previews too (a second list each — `pollCost` 2); the Repo dashboard's deploy strips leave a production part's previews out",
        "The webhook accepts `workflow_job` (verified, acknowledged, not captured yet); `release` and `create` are captured into `releases` (`RELEASE_EVENT_NAMES`)",
        "A `pr` row's `raw` keeps the PR's label names (`labels`, ≤ 20) — from the webhook and the PR-list backfill",
        "`reconcileCost` and `refreshSubrequests` carry the releases arm's 2 requests (\"Poll now\", with the PR-files arm: 33 + 5N + max(2, N), 45 for two environments)",
        "A hosting unit costs its provider's `pollCost` + 1 (the rollback compare)",
        "The `drift` section's snapshot is the promotion chain's last step (for two environments, the same pair as before); `reconcileRequests(N)` = 16 + 2N + max(2, N) + 6 + 2 (the releases arm) + 9 (the PR-files arm), so Poll now's ceiling (`SUBREQUEST_CAP`) rises from the free plan's 50 to 100 — a tenth of Workers Paid's 1,000 — so its GitHub arm runs for up to 11 environments and leaves 54 requests for hosting with two",
        "`listRepoApps` moves to `src/repo/apps-read.ts` and the GitHub HTTP helpers to `src/repo/gh-http.ts` (both re-exported where they were)",
        "Repo › Usage: the environment-by-environment compare is replaced by one card per target (the design's UsageTarget); active users ride the environment's first web target",
        "A v3 app metrics body may leave `active_users` out; v1 and v2 bodies parse unchanged",
        "Not shipped filters a multi-app repository's commits by the app's watch paths from `commit_paths`; a commit with unknown paths stays in, counted, and its group says how many (`FactsCommitGroup.pathsUnknown`); a part is computed again once such a commit has paths (a D1 check, no GitHub request).",
        "A captured workflow run keeps its `run_number` in `raw` (a workflow release's tag)",
        "`putRepoApp` accepts a `release_signal` only as `tag:<glob>` (≤ 100 characters, ≤ 10 wildcards) or `workflow:<file>@<branch>` (`parseReleaseSignal`, `shared/repo-apps-core.ts`), else 400 on `release_signal` — shown beside the field on Repositories › Apps",
        "Org settings › Integrations' hosting line: an app's metrics token is set in its part's editor (Repositories › a repository › Apps), not on Hosting",
      ],
      fixed: [
        "A `github` part got deploys only from live webhook deliveries — never from the check runs and workflow runs reconcile backfills, nor from signals captured before the part (or its setting) existed: reconcile's `github_deploys` arm and `putPart` now replay the captured signals of 30 days through `signalMatchesPart` (`backfillGithubDeploys`, D1 only, no GitHub request)",
        "A `workflow:<file>@<branch>` release signal was stored and drawn but read by nothing: `readRelease` follows it — the latest successful run of that file on that branch, tag `<file> #<run number>`, since / waiting from its head sha, cadence from the runs before",
        "The facts' Merged PRs week delta compared with a week nobody recorded: null until `recordingSince('pr')` predates two weeks",
        "Railway's old per-environment project tokens showed as two Connected \"workspace token\" cards while the org-wide connection the Backend parts need did not exist.",
        "A host disconnected by an admin read Removed on its parts but Not connected on its card.",
        "A deploy with no target (every GitHub-sourced deploy) was dropped from the Repo dashboard's deploy reads: `NOT (NULL AND …)` is NULL in SQL.",
      ],
      removed: [],
    },
  },
  // Trov writes for you (#178): the AI screens, My Work's new layout, a handoff's reading list.
  {
    version: "0.34",
    date: "2026-10-15",
    title: "Trov writes for you",
    headline: "Trov reads what your team captures and writes the short version: your brief, where the repo stands, and what each session shipped.",
    highlights: [
      "My Work's Queued handoffs has Claim & copy: one press claims the newest handoff and copies it as a prompt for a fresh session, and claiming one lists what to read first (the docs, decisions, feed entries and artifacts that match it; it says plainly the list is not complete). The date sits at the top right, and Needs your review says its count once.",
      "Ask Trov: ask about your organization in plain words and get an answer built from what Trov holds, with every source linked and open beside the answer. It can draft tickets, handoffs and doc changes for you to confirm, or make them at once in Auto with Undo. Attach screenshots and files, save any answer as an artifact, and pick up past conversations from the list.",
      "Trov writes the Feed's record of what shipped, about 45 minutes after your last push, from your commits and merged pull requests, each with its sources; and Repo › Overview opens with where the repository stands: what shipped, what is in flight and what needs attention. Press Wrong? on either to hide it.",
      "Digest e-mails are shorter and lead with your brief: what you are in the middle of and the next three things, then at most three notable or breaking changes that touched your work, then one line per queue. The weekly adds \"This week\": up to three highlights of the team's week, each with its sources, and the week's numbers. Settings › Email notifications has a new switch, \"Only when something needs me\".",
      "Tickets, the Feed and Artifacts can be filtered in your own words: open Filter, choose Describe a filter, type \"my open high-priority bugs\" and Trov sets the screen's filters for you. You see each one in the Filter menu, change any of them, or press Undo. When part of what you asked is not a filter there, it says so.",
      "With your organization's AI on, Trov suggests a new ticket's category and priority, and points out when it looks like the same request as another ticket. It also suggests where an unplaced doc belongs, and marks a Review item that changes a decision, contradicts a doc or changes a process. Each suggestion shows the words it is based on; you accept or dismiss it, and accepting a duplicate only links the two tickets.",
    ],
    headsUp: [
      "Digests no longer list each merged pull request with What / Why / Impact, each assigned issue with its labels, or the whole plan change: My Work, the Feed and the Roadmap hold those. With Trov's AI off, the digest lists your three most recently updated assigned tickets instead of the brief.",
      "Org settings has an AI tab: whether Trov's AI is on for your organization, this month's use of each AI allowance, and exactly what is sent to Anthropic and to TypeSafe AI, and what never is. An admin turns it on or off; off stops Sift too.",
      "Turning Trov's AI off now also stops the summaries of new pull requests and issues, from GitHub and from Sync. Summaries already written stay as they are, and the next Sync after it is back on catches up.",
      "Tickets no longer shows declined tickets in its All view, on the board or in the table, so tickets Ask Trov made and then undid stay out of the way. Pick Closed to see them beside the done ones.",
    ],
    ops: [
      "Apply `0058_ai_dirty` (the deploy does it). ADDITIVE: the `ai_dirty` table (the AI router writes it from `0059` on) and `orgs.ai_chat_auto` (on for every organization). Safe on the Worker from before it; the by-hand rollback is in the file's header.",
      "Apply `0061_ai_digests` (the deploy does it). ADDITIVE: `feed.origin` (default `agent`, so every existing entry reads as an agent's), `feed.model`, `feed.subject`, the table `ai_sessions`, and the reserved system person `trov` (the author of what Trov writes; never a member, never listed, never deletable). Safe on the Worker from before it; the by-hand rollback is in the file's header.",
      "Apply `0062_repo_state` (the deploy does it). ADDITIVE: the table `repo_state` (append-only, the last 20 versions per repository). Safe on the Worker from before it; the by-hand rollback is in the file's header.",
      "Publish the Trov plugin 0.9.0 (skill text only: `claude plugin marketplace update trov`, then `claude plugin update trov@trov`): `record-session` records decisions, findings and incidents and cites its commits (what shipped is Trov's session digest now), and `load-context` reads the repository's written state first. An older plugin keeps working; it only records what shipped twice.",
      "Apply `0059_ai_batches` (the deploy does it) AFTER `0058`. ADDITIVE: the platform tables `ai_batches` / `ai_batch_requests` (empty: no batch job exists yet) and `ai_dirty.marked_at` / `ai_dirty.urgent`. From this deploy every write path marks `ai_dirty` rows for orgs with AI on (rows only — no model runs: the pass's registry is empty). Safe on the Worker from before it; the by-hand rollback is in the file's header.",
      "Apply `0064_repo_themes` (the deploy does it). ADDITIVE: the tenant tables `repo_themes`, `pr_themes` and `repo_theme_captions` (all empty until Trov proposes themes and an admin accepts them). Safe on the Worker from before it; the by-hand rollback is in the file's header. Locally, `npm run db:migrate:local` then the dev seed draws Repo › Planning's \"Where the work went\" from real rows.",
      "Apply `0066_ask` (the deploy does it). ADDITIVE: Ask Trov's tables — `chat_threads`, `chat_messages` (with its `chat_fts` index and triggers), `chat_actions`, `chat_artifacts`, `person_ask_settings`, `ask_flags` — and `ai_feedback.detail_json`. Nothing existing changes; the by-hand rollback is in the file's header. Ask runs on the existing `ANTHROPIC_API_KEY` (no new secret); without it every Ask answer is `no_key`.",
      "Apply `0060_ai_importance` (the deploy does it) AFTER `0059`. ADDITIVE: the nullable `feed.importance` and `pr_summaries.importance` (`routine` | `notable` | `breaking`; NULL = unknown, drawn as before). No row is rewritten; safe on the Worker from before it; the by-hand rollback is in its header. The AI pass rates new feed entries and merged PRs from this deploy on (`TYPESAFE_API_KEY` and each org's AI switch), and Sift checks a newly promoted doc against the active tags where an admin has Sift on.",
      "From this deploy the AI pass runs Phase C's Jev cards (ticket category / priority / duplicate, Review risk, Unplaced destination) for organizations with AI on, when `TYPESAFE_API_KEY` is set: Jev requests count against `jev_checks`. No migration.",
      "Apply `0063_person_brief` (the deploy does it). ADDITIVE: the `person_brief` table (each member's last 5 briefs, written by the AI pass) and `memberships.mywork_opened_at` (NULL for everyone until they next open My Work). Safe on the Worker from before it; the by-hand rollback is in the migration's header and loses only stored briefs and those timestamps.",
      "Apply `0065_org_insights` (the deploy does it). ADDITIVE: the `org_insights` table (the Roadmap's sprint notes and drift line, the last 10 per key; in `ORG_TABLES`). Nothing writes it until the AI pass runs with `ANTHROPIC_API_KEY` set; doc drift also needs `TYPESAFE_API_KEY` (without Jev it is skipped, never guessed) (#178)",
      "Apply `0067_digest_email` (the deploy does it). ADDITIVE: two tenant tables — `notification_person_prefs` (a member's \"Only when something needs me\"; no row = off) and `digest_highlights` (the weekly's \"This week\", written by the AI pass's `digest.week` job through the Batch API). Nothing existing changes; the by-hand rollback is in the file's header. No new secret: the weekly job runs on the existing `ANTHROPIC_API_KEY` and each org's AI switch.",
    ],
    patches: {
      added: [
        "Repo themes, \"Where the work went\" (Phase D; `src/ai/themes.ts`, `src/ai/themes-accept.ts`, `src/tools/themes.ts`, `src/data/themes.ts`, `0064_repo_themes`): `themes.propose` (Haiku, Batch API, `theme_window:<repo>`) proposes themes once the repo has 15 carded PRs in 12 weeks and then monthly, additions only — each a `proposed` theme plus an `ai_suggestions` row (kind `themes.propose`) that only an admin accepts, renames (`{ value: { name } }`), merges (`{ value: { mergeInto } }`) or removes (dismiss); every PR it cites must be in its input and a theme needs 3; the server picks the colours. Accepting marks `theme_backfill:<repo>` (#178)",
        "`pr.theme` (Jev `choice` over the active themes plus \"none of these\", `card:pr:<n>`): one request per merged PR once themes exist, written to `pr_themes` with `source='ai'` at 0.5 confidence or more; a person's choice is never asked about and never overwritten (the upsert is guarded in SQL). `themes.backfill` (Haiku, Batch API) classifies the 12-week window's unclassified PRs and the model's picks older than the newest acceptance (#178)",
        "`themes.caption` (Haiku, Batch API): the server computes each active theme's share of the merged PRs per week and per half of the 8 weeks and passes them in; a caption with a digit, naming a theme that is not active (by id or by name), naming none, or outside 20–280 characters is discarded; the same shares make no second call (`basis_hash`); the last 10 kept (#178)",
        "`RepoDashboard.themes` / `get_repo_dashboard`'s planning tab: a D1 aggregation on read (merged PRs per theme per UTC Monday week, 8 weeks and a quarter; a proposal's lane draws the PRs it cited); absent when the org's AI is off or the repo has neither an active theme nor a proposal waiting. `themeShares(ctx, repo, from, to)` is the read the roadmap's drift uses. The cached org prefix now lists the org's active themes (#178)",
        "Accept handlers may check a value before the claim (`valid`), refuse with a code (`AcceptRefused`), make dismissing an admin's (`dismissRole`) and act on a dismissal (`dismissed`) (`src/ai/accept.ts`) (#178)",
        "Evals: `test/ai-evals/pr.theme/` (39 of this repo's merged PRs and their expected theme; live 38/39) and `test/ai-evals/themes.caption/` (6 eight-week windows; live 6/6 kept by the rules), run live by `test/ai-evals/run-live.mjs` and replayed from the recordings by `test/ai-evals.themes.test.ts` (#178)",
        "Local dev seed: `fixtures/dev/themes.json` + `scripts/seed/themes-dev.mjs` give Repo › Planning four active themes, a person's pick, a caption and a proposal to decide, from real rows (#178)",
        "\"Wrong?\" on Where the work went hides that range for the person on their next read too (`readRepoThemes` reads `hiddenFor`; `RepoDashboard.themes` is now a `Partial` record); Accept / Rename / Remove re-read the Repo dashboard so a decided proposal shows what it became; the Rename field takes at most 40 characters, as the server does (`AI_THEME_NAME_MAX`) (#178)",
        "The AI kit (`web/src/ai-ui.ts`): the Trov AI mark (`aiMark` in `marks.ts`, the Trov logo in the accent), the \"Written by Trov\" byline with its not-official tooltip, \"Wrong?\" as a thumbs-down icon button at the bottom right, source links (`AiCite`), \"Wrong?\" (`POST /ai/feedback`, hidden at once for the person, back on a failure), the suggestion chip (#157: dashed outline, the mark, a \"because…\" disclosure, Accept / Dismiss, \"Not available yet\" on a 409 `not_available`) and the capped / empty lines; acts in `web/src/ai-actions.ts` (#178)",
        "Four AI screens, each drawn ONLY when its read carries the field (production omits them all, so nothing shows yet): My Work › Your brief (`briefTile`, `brief?`; with it the bento is laid out by area, `.mw-bento-brief`: Brief tall beside Review over Tickets, Your sessions tall beside Repo over Docs you own and Queued handoffs; every tile one fixed height, its overflow scrolling inside it), Repo › Overview › State and Repo › Planning › Where the work went (`web/src/repo-ai.ts`, `state?` / `themes?`: lanes, weekly bands, 8 weeks / Quarter, proposed themes with Accept / Rename / Remove), and Feed entries written by Trov (`FeedRow.ai?`) with a Source switch (All / Agents / Trov) and a one-time note (`trov.aiFeedNote`, per person on this browser). `test/render.ai-absent.test.ts` pins each screen's field-absent markup byte for byte; `test/render.ai.test.ts` covers every state (#178)",
        "Org settings › AI (`web/src/org-ai.ts`, `#org/ai`): the switch (admin; `PUT /ai/settings`), this month's runs against the allowance, and what is sent to Anthropic; the web API client gains `getAiSettings` / `putAiSettings` / `acceptAiSuggestion` / `dismissAiSuggestion` / `sendAiFeedback` (`AI_ROUTES`) (#178)",
        "Platform › Usage: AI runs, failures, capped runs and tokens per organization and in total, from `OrgUsage.ai` / `PlatformUsageResponse.ai` (nothing drawn when absent) (#178)",
        "`src/ai/client.ts`: `KIND_PROVIDER`, the ONE table from a kind to its provider (`claude` | `jev`); `providerFor(kind)` returns the provider typed by its kind (`tag.fit` → Jev). `src/tools/classify.ts` is the Jev provider — its `classify` unchanged — and gains `ask`: several `noul` / `choice` / `score` questions about one item in one request, each answer parsed against its question and null when malformed (#178)",
        "`ai_chat` (Ask Trov) in `PLANS`: QUESTIONS a month (a Fast or Smart question is 1, a Thinking one 5; metric `ai_chat`, nothing writes it yet), 50 on Free and Personal, 300 PER SEAT on Pro (`PlanDef.perSeat`; `resolveEntitlements` multiplies by the paid seats, or by the members for a gifted Pro, at least 1; `PLAN_COLS` reads `plan_members`), unlimited on Enterprise; an override of `ai_chat` is the whole cap; not listed on public pages (#178)",
        "`0058_ai_dirty`: `ai_dirty` (the AI router's stale scopes, PK `(org_id, scope, scope_key)`; in `ORG_TABLES` and the reset seed; the router writes it) and `orgs.ai_chat_auto` (Ask Trov's Auto switch, moved here from the reserved 0066_ask) (#178)",
        "The plain-language filter (issue 162 on GitHub): `POST /api/o/:slug/ai/filter { screen, text }` (cookie only; `src/ai/filter.ts`, `src/ai/routes.ts`) — ONE Haiku call (kind `filter` in `KIND_PROVIDER`, effort low) whose output format is the screen's own filter schema (`shared/ai-filter.ts`: Tickets, Feed, Artifacts, defined once). Each field is checked on its own (a value or key the schema refuses is dropped); a person, sprint or tag resolves to a real row of the org or is dropped; `unmatched` keeps only words quoted from the request. Nothing left, a refusal or `max_tokens` is 422 `unreadable`. Gated by the org's AI switch (403 `off`), the key (503 `no_key`), `ai_runs` (402 `plan_limit`, `ai_run_capped:filter`) and a new per-person limit `ai_filter` (60 an hour); counted `ai_run:filter` before the call (#178)",
        "The filter on Tickets, the Feed and Artifacts (`web/src/ai-filter.ts`, `web/src/ai-filter-actions.ts`): shown only when `GET /ai/settings` says the org's AI is on (read once per org); the answer is applied to the screen's own filter state (`applyAiFilter` in `main.ts`, replacing every filter), with Undo back to what was set by hand. `LOCAL_AI_PREVIEW` answers it from per-screen fixtures (`aiFilterFixture` in `shared/ai-fixtures.ts`) with no key (#178)",
        "Handoff reading list (issue 167 on GitHub): a claim builds \"Read these first (not complete)\" — up to 5 docs, decisions, feed entries and artifacts — from the handoff's own words through `query()` (one bm25 pass per kind, then ranked by which of the words each holds; no model, no network). The claiming org only, settled content only, a private artifact only for its author; never a handoff's own feed line. Not stored: `POST /api/handoffs/:id/claim` answers `reading_list` (`HandoffClaimResult`; `null` if it could not be built, the claim still stands), MCP `claim_handoff` ends with the section, and the handoff screen shows it after a claim and adds it to Copy as prompt (`claimHandoffWithReading`, `readingListBlock`) (#178)",
        "THE AI ROUTER (Phase B): `src/tools/ai-route.ts` is the ONE table from a write to the scopes it made stale (the design's table plus the hosting-deploy row; `src/ai/router.ts` re-exports it), `src/data/ai-dirty.ts` writes the rows — rows only, no model, no network, only while the org's AI switch is on; a re-mark keeps `dirty_since`, moves `marked_at` and resets `attempts`. Called in one line after the write by the webhook's repo capture, the events gate (a merged PR), the hosting poll's deploy upsert, tickets (native and mirrored), handoffs, the gate's feed / doc / ADR / Unplaced writers, doc promote, artifact create / version, and the `:50` digest pre-warm (`prewarmDigests`); a failed mark never fails the write (#178)",
        "The debounce: `debounceMs(scope, plan, { urgent })` and `debounceFrom` in `shared/ai-core.ts` — sessions close 45 min after their LAST event, cards next tick, person 30 min / 2 h, repo 60 min / 6 h (a breaking change skips it on Pro and Enterprise), org and sprint 6 h / 24 h, theme windows daily / weekly, doc drift weekly / monthly (#178)",
        "The AI pass's machinery (`src/ai/pass.ts`, `src/ai/jobs.ts`): per eligible org the due scopes run in stages (sessions, cards, briefs, repo state, the org rollup, themes, doc drift); Jev jobs one item per request, Haiku jobs up to 20 items per call (`HAIKU_GROUP_MAX`), an optional Jev gate before a Haiku call with a plain-rule fallback; a written scope clears, a failure counts and after 3 waits for a new mark; at most `AI_RUNS_PER_TICK` (12) Haiku calls and `JEV_CALLS_PER_TICK` (60) Jev requests a tick. The registry (`AI_JOBS`) stays empty: Phases C and D add the producers (#178)",
        "The cached org prefix (`src/ai/prefix.ts`): org name, tag vocabulary, active themes, active sprints and the plan narrative, sent before every Haiku prompt with a `cache_control: ephemeral` breakpoint (#178)",
        "The Message Batches API for non-urgent jobs (`batch: true`, `src/ai/batches.ts`): one `batches.create` at the end of a tick, collected on a later one (`retrieve`, then `results`); `0059_ai_batches` records them with `custom_id` = `org:scope:key:prompt_version`; a result for an org deleted, suspended or switched off since writes nothing. The Claude provider gains `submitBatch` / `retrieveBatch` / `batchResults` / `answer` (#178)",
        "Section isolation (`src/ai/sections.ts`: `sections`, `each`, `keep`): an answer is checked one section (or list item) at a time, so a bad one drops alone (#178)",
        "Metering per provider: Jev requests from the pass count as `ai_suggest` (the `jev_checks` allowance, as Sift's do) with Jev's tokens in `ai_jev_tokens_in` / `_out`; Platform › Usage shows them as Sift checks and tokens when the read carries them (#178)",
        "Session digests (`src/ai/digests.ts`, `0061_ai_digests`): the pass's `digest.session` job turns one login's burst (`session:<repo>:<login>`, closed 45 min after its last event) into ONE `Shipped:` / `Status:` feed entry — commit subjects and merged PRs' cards in, never a PR body — behind `gate.session` (Jev `noul`, below 0.5 `skipped`; without Jev: a PR or 3+ commits); an agent entry already citing the burst's commits or PRs skips it with ZERO model calls; `checkDigest` keeps it only with a valid cite, the right prefix and type, no ref in the brief and no invented number; written through `ingestFeedEntry` as `trov` with `feed.origin = 'ai'`, `model`, `subject` (the ONE author exception, ingestion-gate.md); `ai_sessions` keeps the burst's bookkeeping (#178)",
        "Repo state (`src/ai/repo-state.ts`, `src/tools/repo-state.ts`, `0062_repo_state`): the pass's `repo.state` job updates the repository's headline and three lists INCREMENTALLY from the last version plus merged PR cards, digests, open PRs, the default branches' failing runs and every environment part's hosting deploys (any provider), behind `gate.state` (Jev; without it: a merge, a deploy or a red default branch); every cite resolved by the server; a line with an unknown cite, an invented number or a ref in its sentence is dropped; appended, the last 20 kept. `GET /repo/dashboard` and `get_repo_dashboard` read the newest as `state` (absent when none, off or flagged \"Wrong?\") (#178)",
        "The feed's `ai` on Trov's entries (`src/tools/feed-ai.ts` `withAiMeta`): subject, sources built from the entry's artifacts and linked to the digest's repository, model; `/feed` and MCP `get_feed` leave out an entry the caller flagged \"Wrong?\" (`hideWrongFor`) (#178)",
        "Evals for `gate.session`, `digest.session`, `gate.state`, `repo.state` (`test/ai-evals/`, real cases from this repository and Personal Dev): live 17/17, 10/10, 18/19, 8/8; `scripts/ai-evals/digests-live.ts` records, `test/ai-evals.digests.test.ts` replays in CI and fails on a changed prompt (#178)",
        "`test/ai.hookup.test.ts`: real rows end to end — webhook → pass → the four reads → Repo › Overview › State and the Feed's Trov entry rendered by the existing screens, and \"Wrong?\" round-tripped through the real route (#178)",
        "Motion on what Trov wrote, in the app's own system: \"Wrong?\" on Repo › Overview › State or a Trov feed entry, and \"Got it\" on the Feed's note, take the item out with Review's exit timing (`AI_EXIT_MS` 310 ms: dimmed, then a one-track grid `1fr` → `0fr` over `--fx-fast`) — drawn `inert` in `.cnpy-ai-leave` from `state.ai.leaving`, a keyframe clocked by `--leave-t` (elapsed, negative) so a rebuild mid-exit joins it; a Repo tab switch flashes State with the panel (`.repo-ai`) and the Feed's Source switch flashes the list; none of it under reduced motion (`test/render.ai-motion.test.ts`) (#178)",
        "`pr.theme` sends the PR card through `excerptOf` (no code, link targets or credential-shaped text), and `repo.state` names each hosting part by its label, never the provider id (the Repo setups rule); both eval sets re-recorded live (pr.theme 38/39, repo.state 8/8) (#178)",
        "Ask's inspector shows a feed entry's kind — the summary's leading `Shipped:` / `Status:` / `Decision:` / `Finding:` / `Incident:` / `Triage:` — as a plain word in its meta line, the title the rest (`feedKind`, `web/src/feed-kind.ts`) (#178)",
        "Tags › Sift's switch keeps the keyboard's focus while its write is out, like every `switchBtn` (`aria-disabled` + `aria-busy`, never `disabled`; plainly disabled only while Sift is unavailable) (#178)",
        "Review's list cards (RV-OWNER-1): a one-line footer, and Trov's risk is a mark in the card's header (`aiStateMark`, `web/src/marks.ts`) instead of a line of its own; Review also draws the \"Flagged in Ask\" line (handoff #12 § 2.14) (#178)",
        "The brief tile (on My Work) and a themes range (on Repo › Planning) leave by the AI kit's one exit on \"Wrong?\" — the brief inside its bento slot, then the bento's other layout fades in; a range inside its card, its heading and switch staying (#178)",
        "A Trov feed entry with no readable sources says \"Written by Trov.\", never \"from .\"; the Unplaced row's Trov mark ends in an ellipsis instead of being cut off; \"because…\" and the theme lanes keep keyboard focus (#178)",
        "One malformed sprint draft no longer hides every Roadmap suggestion; the e2e seed stores suggestion values as the JSON the writer stores (#178)",
        "ONE exit for the whole AI kit (`web/src/ai-ui.ts` › Leaving): `state.ai.leaving`, `.cnpy-ai-leave` (`[data-inline]` for a mark in a line), `AI_EXIT_MS` and `aiLeaving` cover \"Wrong?\", the Feed note's \"Got it\" and every decided suggestion — Phase C's chips, the risk line, a row's mark and a proposed theme (`aiSuggestionKey`, held until the screen's re-read, which waits `AI_EXIT_MS`); Phase C's `AppState.aiLeaving`, `.cnpy-ai-out` and `AI_CHIP_EXIT_MS` are gone (#178)",
        "Local seed: real Trov rows (`fixtures/dev/ai.json`: three digests, a skipped session, two `repo_state` versions and the primary repository), so the Feed and Repo › Overview show them on localhost without `LOCAL_AI_PREVIEW` (#178)",
        "`test/ai.harness.test.ts`: the pass harness — ten pushes plus a merge give ONE repo call, 25 ticket cards give 25 Jev requests and zero Haiku calls, a non-substantive burst gives one Jev call and no Haiku call — and the measured spend of a tick for 1, 10 and 50 orgs (#178)",
        "Ask Trov's backend (Phase F, as amended by handoff #12 §2; no screen yet): `POST /api/o/:slug/ask` streams an answer over SSE (`thread`, `thinking`, `activity` run/done, `text`, `block`, `action`, `action_result`, `artifact_saved`, `followups`, `done`, `error`), cookie only, gated by the org's AI switch and the `ai_chat` allowance counted in questions by the mode (Fast 1 / Smart 1 / Thinking 5; Free is Smart only). `src/ai/ask/` (routes, turn, tools, actions, refs, attachments, render, history, prompt), `src/data/ask.ts`, the contract in `shared/ai-ask.ts` / `shared/ai-ask-core.ts` (`ASK_MODES` — one table, re-exported from `shared/ai.ts`) (#178)",
        "Ask's tools are the MCP catalog less `switch_org`, `get_connection`, `record_session`, `upload_asset` and `delete_sprint`, calling the same `src/tools/*` functions as the cookie person, plus `trov_docs`, `read_attachment`, `save_artifact`, `publish_doc`, `show_items`, `show_chart`, `show_themes`, `show_diagram` (structured, ≤ 8 nodes) and `show_not_found`. Fast is offered the index only, at most 3 calls; Smart and Thinking the full catalog, 8 (#178)",
        "Every Ask write is a card (`chat_actions`): Confirm / Cancel / Undo (`POST /ask/actions/:id/…`) run AS the person through the lane-scoped writers; editable fields re-validated on Confirm; consecutive calls grouped (one card, one Undo); Undo refuses when the item changed since (\"Changed since. Undo it by hand.\"). Auto mode runs up to 5 per answer, never `update_plan`, completing a sprint or a Publish (which waits, outside the cap). Publish a staged doc calls the web promote path, only for someone who may promote (#178)",
        "Ask's ref views: `RefView` (one view model for chips, cards, hover cards and the inspector), `POST /ask/peek` (an item the person can't see is `{ ref, hidden: true }`) and `GET /ask/item/:ref`; ref tokens (`[[ticket:14]]`, `[[ticket:14|status]]`) are linked only for items a tool returned in the thread (#178)",
        "Ask's attachments: stored as PRIVATE artifacts on attach (`POST /ask/attachments`, ≤ 5 files, 10 MB each, images / PDFs / text), read back from the artifacts store for the model in their own turn only; later turns use `read_attachment`, scoped to the person and the thread. Threads: list (Pinned / Today / This week / Earlier), search (`chat_fts`, snippet offsets), rename, pin, draft, export, delete; Stop; edit-and-resend and regenerate replace (`replaced_at`) and expire the replaced cards; save as artifact (Markdown, or an HTML page the server renders); \"Wrong?\" with three reasons, the first two flagging the cited items for Review (`ask_flags`: the reason only); Settings › Trov (`/ask/settings`) (#178)",
        "Ask fixtures: a recorded SSE transcript per design scenario in `shared/ai-fixtures.ts` (and `docs/superpowers/specs/ask-transcripts/`), streamed at real pacing by the dev-only `GET /api/o/:slug/ai/ask-replay/:scenario` behind `LOCAL_AI_PREVIEW` (#178)",
        "Phase C, `feed.importance` (`src/ai/importance.ts`): the AI pass's Jev job over `card:feed:<id>` and `card:pr:<n>` — ONE `choice` question (routine / notable / breaking) per item, one request each, metered `ai_suggest`; stored as a COMPUTED fact on `feed.importance` / `pr_summaries.importance` (`0060_ai_importance`) only at confidence 0.7 or more (`IMPORTANCE_MIN_CONFIDENCE`, the eval's choice), else NULL — never a guessed `routine`; an item already rated is never asked again; a PR is sent as its title and capture-time summary (or, with none, a scrubbed body excerpt); a BREAKING item marks the primary repo's scope `urgent` (`ai_dirty.urgent`, so the repo state skips its wait on Pro) (#178)",
        "Phase C, Sift on new items (`src/ai/sift-items.ts`, kind `tag.fit`): the AI pass's job over `card:tagfit:<type>:<id>` (a doc promoted; an artifact's card is written with no request — artifacts carry no tags yet) — ONE request per item, Sift's own question once per active tag it does not carry and nobody said no to (`itemFitInput`, at most 60), Sift's bands (0.85 adds with provenance, 0.6 suggests) through the ONE writer a run uses too (`storeFit`), each touched tag recorded as a one-item run of that tag so the Tags tab's Undo takes exactly it (`storeNewItemFit`); only while both the org's switch and Sift's are on; the reason is the item's own words (FTS) or Sift's score (#178)",
        "The Feed marks an entry Sift rated notable (an accent dot) or breaking (an amber triangle) in its byline (`importanceMark`, `IMPORTANCE_MARK` in `web/src/marks.ts`); routine and unrated draw nothing, byte for byte; `get_feed` (the Feed and MCP) and My Work's merged PRs (`MyWorkPr.importance`) carry it only when set; `LOCAL_AI_PREVIEW` adds two rated agent entries (`feedImportanceFixtures`) and the dev seed rates a few feed entries and PRs (#178)",
        "Eval sets with a recorded-response CI test (`test/ai.evals.test.ts`): `test/ai-evals/feed.importance/` (25 real items: Personal Dev feed entries and this repo's merged PRs; live 2026-10-15, at 0.7: 18 rated, 18 right) and `test/ai-evals/tag.fit/` (16 Personal Dev docs × the six starter tags: 9 of 11 clear fits added or suggested, 33 of 33 clear non-fits left alone); `scripts/ai-evals/run-live.ts` re-runs them live and re-records (#178)",
        "`test/render.feed-ai-real.test.ts`: Phase C on real rows into the screens that exist — entries through the gate and a doc through `promote_doc`, the real pass with Jev stubbed, read back through `/feed`, `get_feed` over `/mcp`, `/doc` and `/tags/:name`, then drawn by the Feed and the tag page (no `LOCAL_AI_PREVIEW`); an unrated or routine entry renders byte for byte as before (#178)",
        "Phase C's Jev cards (`src/ai/jobs/`, registered in `AI_JOBS` and `KIND_PROVIDER`): `ticket.card` — ONE request per open ticket carrying `ticket.category` (while it is `other`), `ticket.priority` (while `normal`) and `ticket.duplicate` (a `choice` over the top five `tickets_fts` hits, never itself, its parent or children or a ticket it links, or `none`); `review.risk` on a staged doc proposal or drafted ADR (`decision` / `contradicts` / `process` / `routine`; routine writes nothing); `unplaced.destination` on a doc-shaped Unplaced item (the sections, or next to one of the top three live docs). Thresholds 0.7 / 0.75 / 0.9 / 0.6 / 0.55; a kind a person decided is never re-asked; reasons are the item's own words or the full-text snippet, never model text (#178)",
        "Accepting a card suggestion (`src/ai/jobs/accept.ts`, in `AI_ACCEPT_HANDLERS`) writes through the existing writer as the person: `set_ticket_classification` (new in `src/tools/tickets.ts`, no MCP tool) for a category or priority, `add_ticket_link` for a duplicate (its GitHub issue if mirrored, else its in-app `#tickets/<n>` address — which `parseTicketLink` now names `#<n>`), `assign_triage` as a doc for a destination; `review.risk` has no handler (Dismiss only). Nothing closes, promotes, rejects or ratifies (#178)",
        "The suggestions on the screens (`src/ai/attach.ts`, `web/src/ai-cards.ts`): `TicketDetail.ai?` on `GET /tickets/:id` (chips under Properties and above Linked work), each Unplaced row's `ai?` on `GET /needs-triage` (a chip above \"File it as\" and a mark on the row), each Review item's `ai?` on `GET /proposals` / `GET /adrs` (a quiet risk line, Dismiss only). Open suggestions only, only while the switch is on; never MCP's `get_ticket`. `LOCAL_AI_PREVIEW` puts sample suggestions on the real rows (`shared/ai-fixtures.ts`). `test/render.ai-cards.test.ts` pins the three screens' markup with no `ai` byte for byte; `test/ai.cards-live.test.ts` runs it end to end on real rows (the pass, the SPA's api client over the real routes, its render, Accept / Dismiss through the AI kit's acts) (#178)",
        "The suggestions move like the rest of the app: each chip and the risk line rise with their screen (`.cnpy-rise`), and once Accept or Dismiss answers they leave by the AI kit's one exit (#178)",
        "The Phase C evals (`test/ai-evals/<kind>/`, 18–48 hand-labelled cases each from Personal Dev and this repo): `node scripts/ai-evals/run.mjs record` runs them against the live Jev API, `score` sweeps the thresholds; `test/ai.evals.cards.test.ts` replays the recorded responses at the `Response` level and fails on any drift in a request or a decision. Recorded accuracy: category 96%, priority 98%, duplicate 95%, risk 61% (every risk written was right), destination 85% (#178)",
        "Ask Trov's screen, foundation (handoff #12 §3): the Trov row in Workspace, `#ask` / `#ask/<id>`, the three columns (thread list 260px, conversation 720px, inspector 380–720px), the controller (`web/src/ask-controller.ts`: reads, streams with Stop, batched ref peeks, the Escape stack, ⌘J), the reducer over the SSE events, ref chips and the hover card, the motion hooks (`web/src/ask-motion.ts`), and a dev replay (`?askReplay=<scenario>`) that plays every recorded transcript with no key; the conversation, composer, inspector views, write cards, ⌘J panel and phone are stubs their parts replace (#178)",
        "Ask's repo refs read the Repo Overview's facts, per Repo setups' rules: a `repo:` RefView is `extra.facts` (`askRepoFacts` of `getRepoDashboard`'s RepoFacts) with `status: null`, and the hover card draws each environment with the Overview's `envVerdict` and `stateMark`; the dev replay fills the facts from the Overview's sample scenario N / `trov`; the six recorded transcripts that cite the repo were regenerated (#178)",
        "Ask's ⌘J panel (`web/src/ask-cmdj.ts`): a 420px panel over any page (full screen on a phone) that repaints alone, ⌘J / Ctrl+J by platform, the page's item as its context chip, Open as thread (moves the draft and the inspector to `#ask/<id>`), a Tab trap with focus returned on close, the inspector sliding out from behind it, and Ask about this ⌘J in a ticket's header — its one change to the Tickets page; Escape closes the panel's own inspector before the panel (#178)",
        "Ask's composer (`web/src/ask-composer.ts`): every limit and flag from `GET /ask/state`, files uploaded on attach with a red Too large chip for one over the limit, `@` mentions through the quick search and the five `/` commands, the mode and the Auto switch remembered per thread, unsent words kept per thread as a draft, and the usage line under a fifth left (#178)",
        "Ask on a phone (`web/src/ask-phone.ts`): Open threads and New thread in the header, the thread list as a drawer (a modal: focus in, Tab kept in, back on close), the composer's controls under ONE + menu (Attach, Mention, Run a command, Mode, Changes in this thread) beside a meta line, and the inspector as a full-height sheet; every touch target 44px or more (#178)",
        "Ask's conversation (`web/src/ask-conversation.ts`, `ask-cvref.ts`): the question with its files and context and Edit on the last one, the activity steps with their results, thinking, the answer's markdown with ref chips and status cells, the rich blocks (item cards, charts, themes, dependency chains, not found) with their hover toolbar, Stopped and error rows, the footer with sources, and the follow-ups (#178)",
        "Ask's write cards (`web/src/ask-actions.ts`): ticket, handoff, doc edit and publish cards with inline edits of the editable fields, Confirm / Cancel, the done / cancelled / undone lines with Undo (one per group; a change made since is said, with a link), Save as artifact as a form and its saved line, and Wrong? with its three reasons; an Undo refreshes an open board (#178)",
        "Ask's inspector (`web/src/ask-inspector.ts`): a view per type — ticket, pull request, doc, sprint, repository, handoff, feed entry, person, artifact (the app's sandboxed viewer, Publish to org), an attached file, a chart with its Chart / Table switch — read outside the render path, with Back through what was opened and every item the person cannot see saying so in one sentence (#178)",
        "Settings › Trov (`web/src/ask-settings.ts`, `ask-settings-actions.ts`; three tiles of personal Settings after MCP access): How Trov should answer you (≤ 500 characters, the counter amber in the last tenth, the Try chips), the default mode as a `segmented()` switch over `GET /ask/state`'s modes on Pro (one-mode plans read \"On Free, every question uses Smart.\"), the org's off line (linking Org settings › AI), What Trov can see (where GitHub, hosts and environments are connected links each Org settings tab), and Save (`PUT /ask/settings`; the mode is sent only when the plan offers a choice); house skeletons that settle, the counter's colour and Save easing, \"Saved\" rising once, all off under reduced motion (#178)",
        "My Work's brief, the first AI producer (Phase D, `brief.person` in `KIND_PROVIDER` and `AI_JOBS`; `src/ai/brief.ts`, `src/ai/brief-core.ts`): one Haiku call per person on `person:<handle>`, led by the cached org prefix — Now (their open PRs, the runs and checks failing on them, their latest `Status:` note), Recently (7 days of session notes and merged-PR cards, never a raw PR body), Next (ONLY server-offered items in the server's order: overdue, blocked, someone waiting, due soon, assigned; the model writes one \"why\" each, an unoffered item is dropped, titles are the items' own). A cite not in the input is dropped and a line without one is not written; a ref or an ungrounded number in the text drops the line; `refusal` / `max_tokens` write nothing; an unchanged input calls nothing (#178)",
        "`0063_person_brief`: `person_brief` (the last 5 versions per member; in `ORG_TABLES`, `HANDLE_COLUMNS` and the reset seed; `src/data/person-brief.ts`) and `memberships.mywork_opened_at` — `GET /me/dashboard` records it at most once an hour, and a brief is written only for someone who opened My Work in 14 days or receives the digest (#178)",
        "`GET /me/dashboard` and MCP `get_my_work` carry the newest stored brief (`storedBrief`, `src/tools/mywork.ts`: plain D1, nothing from `src/ai/`): absent when the org's AI is off, none is stored, or the person pressed \"Wrong?\" on that version; `capped` keeps the last one with the day it resumes (#178)",
        "The brief's eval set (`test/ai-evals/brief.person/`: 10 cases from Personal Dev's real rows, graded by rules), its live runner (`scripts/ai-evals/brief-live.ts`, by hand) and the recorded answers replayed in CI (`test/ai-evals.brief.test.ts`); the local dev seed stores a brief for AndresL230 (`scripts/seed/brief-dev.mjs`) (#178)",
        "`test/render.brief-real.test.ts`: My Work › Your brief end to end over real data — real rows, the real `brief.person` job, `GET /me/dashboard` and `getMyWork`, the real `render` into `briefTile` — and its \"Wrong?\" button's own `data-arg` POSTed to `/ai/feedback`, after which the read leaves the field out (#178)",
        "My Work › Your brief in the app's motion: the tile rises with the page entrance, its Now / Recently / Next, each Next item and the byline rise in order (`.cnpy-rise` + `--i`), and a brief landing after the entrance takes the dashboard skeleton's settle fade — `syncSkeletons` also fades a node naming the gone skeleton's key in `data-settle-with`; nothing replays on a rerender, off under reduced motion (`test/render.brief-motion.test.ts`) (#178)",
        "The Roadmap's AI (Phase D, `src/ai/roadmap.ts`): a one-line note on each ACTIVE sprint (kind `org.rollup`, scope `sprint:<id>`, ≤10 sprints a call) and the drift line (scope `org`) — the SERVER counts each theme's share of the primary repo's merged PRs over 14 days (`themeShares`, over the themes module's read) and the model only words it; both stored in `org_insights` (`putInsight`) and read on `GET /roadmap` and MCP `get_roadmap` while the AI switch is on (#178)",
        "The sprint forecast (`sprintForecast`, `src/tools/sprints.ts`): ARITHMETIC on read, never a model — tickets closed per day since the start, carried over the open ones, against the due day; null when unknown (not active, no start, nothing closed) (#178)",
        "Sprint drafts (kind `sprint.draft`, when ≥8 open tickets sit outside every sprint and none is active) and the weekly narrative proposal (kind `plan.narrative`) through the Batch API into `ai_suggestions`; accepting runs `create_sprint` / `set_ticket_sprint` / `write_plan` AS the admin who pressed it, admins only (`src/ai/roadmap-accept.ts`); a writer's refusal is a 400 with its words and the suggestion stays open (#178)",
        "Doc drift (issue 161 on GitHub, `src/ai/doc-drift.ts`): weekly per doc (`doc_drift:<slug>`), only past `gate.drift` (Jev `noul` over the entries and the doc's passages that share words with them; below 0.6 no Haiku call; no Jev → skipped), then Haiku through the Batch API; an edit with a valid cite and an exact passage becomes a LOW-CONFIDENCE proposal through `ingestDocProposal`, authored by `trov`, staged for Review (#178)",
        "Grounding for every written line (`src/ai/grounding.ts`): cites only from the input (the server builds each `AiCite`), numbers only as given, refs in the text read as their labels (an unoffered one drops the line), people's words fenced as data (#178)",
        "The Roadmap's AI pieces (`web/src/roadmap-ai.ts`, over the AI kit): the forecast and the note on each active sprint card, the drift line under the narrative, and an admin's suggestion cards (Accept / Dismiss) above it; each renders nothing when its field is absent (#178)",
        "The Roadmap's AI pieces move like the rest of the app: the cards and the drift rise with the screen, and a card you accept or dismiss — or a note or the drift you mark Wrong? — leaves by the AI kit's one exit (#178)",
        "Evals (`test/ai-evals/gate.drift`, `doc.drift`, `org.rollup`: 20 / 12 / 10 cases from Personal Dev) run live once and replayed in CI by `test/ai.evals-roadmap.test.ts` (#178)",
        "Phase E, the shorter e-mail (`notifications.md` › The digest's shape): `my_work` is \"Your brief\" — the SAME stored brief My Work's `briefTile` reads (`storedBrief`), its Now and up to 3 Next items, the subject from its top item (\"Netlify test failing, plus 1 more\"); with no brief, the 3 most recently updated assigned tickets (`listAssignedTickets`) — and \"Also\": at most 3 notable or breaking merged PRs (`toMyWorkPr`) and feed entries (`get_feed`) that touched the person's work in the window. The queues are one line each (`queueLine`): Review (with Sift's \"changes a decision\" count while AI is on), Sprint, Tickets; empty sections are left out (#178)",
        "Phase E, the weekly's \"This week\" (`week_recap`, `renderers/week-recap.ts`): the stored highlights, then one numbers line the server computes (pull requests merged — only with a repository connected —, tickets done, Feed entries; zero parts left out). The `digest.week` job (`src/ai/week.ts`, `week-core.ts`; `KIND_PROVIDER`, `AI_JOBS`, scope `digest`, stage last): ONE Batch API request per org per week, marked by the `:50` pre-warm 3 hours before the weekly send (`WEEK_HIGHLIGHTS_LEAD_MS`, router event `digest_week`); cites checked by the server, ungrounded numbers and refs in text dropped, at most 3; `0067_digest_email` `digest_highlights` (in `ORG_TABLES` and the reset seed) (#178)",
        "Phase E, \"Only when something needs me\" (`notification_person_prefs`, 0067; `PUT /api/notifications/prefs { onlyWhenNeeded }`; Settings › Email notifications): the run marks the row `skipped` unless the brief has a Next item or something notable or breaking touched the person's work (`needsMe`) (#178)",
        "Phase E, the e-mail previews: `GET /api/notifications/preview?sample=index` lists six fixtures (`sample.ts`: daily AI on / off / nearly empty, weekly AI on / off, only-when-needed skipped), built with the renderers' own pure halves; screenshots in `docs/superpowers/specs/ai-screens-shots/email-*.png` (#178)",
        "Phase E evals: `test/ai-evals/digest.week/` (17 real cases), `scripts/ai-evals/week-live.ts`, recorded answers replayed by `test/ai-evals.week.test.ts`; `test/ai.week.test.ts` runs the job through the real router, pass and Batch API; `test/notifications.digest-length.test.ts` holds the daily under half the old one's words (#178)",
      ],
      changed: [
        "The org's AI switch (`orgs.ai_automation`) covers PR and issue summaries: `planAndSummaries` reads it in the same statement as the plan, `summaryAllowance` answers `disabled` (a new `SummariesStatus`) when it is off, and `orgSummarizers().switchedOff()` makes the webhook (`captureDelivery`) and Sync (`runBackfill`) write nothing for the item — no call, no summary row (not even the excerpt), no meter — so an existing summary is never replaced. The Sync panel says the switch is why; Org settings › AI lists summaries among what off stops. `test/summaries.switch.test.ts` (#178)",
        "Every on/off switch (`switchBtn`) stands still under reduced motion: its knob slide and track fade are off (`trov.css`) (#178)",
        "Sift's run (`src/ai/sift.ts`) reads its question, bands and writer from `src/tools/tag-fit.ts` (`fitQuestion`, `fitBand`, `storeFit`) — the same ones Sift on new items uses; behaviour unchanged. `storePrSummary` upserts the summary's own columns instead of `INSERT OR REPLACE`, so a re-summarized PR keeps its rating (#178)",
        "Ask Trov, the owner's rulings: deleting a conversation deletes its attachments (rows at once, R2 bytes after the commit) unless a ticket links or names one, a doc or any version of it names one, or the person published it (`src/deletion/ask.ts`); deleting an account deletes the person's private Ask attachments with it; a declined ticket stays out of Ask's `list_tickets`, its starters, My Work and the queue's default; an image past the API's real limits (10 MB base64, 8000 px a side, read from its header — was 5 MB) is stored, not read, and the turn's first activity line tells the person (#178)",
        "Ask Trov: `GET /ask/state`'s allowance is the cap the gate enforces — a gifted Pro's is 300 × its members (an `ai_chat` override is the whole cap) — and `GET /ask/item/%25` (a ref that will not decode) is the unknown ref's 404, not a 500 (#178)",
        "Terms and Privacy (`web/src/legal.ts`): DRAFT passages, each visibly marked \"DRAFT —\" until the owner approves them, for Ask Trov (what is sent when a person asks, the models, private and deletable conversations), the plain-language filter, the AI pass's notes, briefs and suggestions, the weekly email's \"This week\", the org's AI switch (which covers pull request and issue summaries too; summaries already written stay readable), the widened Anthropic and TypeSafe AI rows, Ask attachments deleted with their conversation (unless a ticket or doc refers to one) and with the account, \"Only when something needs me\" deciding with AI judgements, and `trov.aiFeedNote` on its own storage row (the handles that dismissed the Feed's note); Terms section 10 is now \"AI features\", and Org settings › AI's \"Never sent\" says source code goes only in a file you attach to Ask (`AI_NEVER_SENT`); the approved summaries and Sift passages and the dates are unchanged (#178)",
        "Deleting an account also deletes the AI router's scopes keyed on the person (their brief, their GitHub sessions) (#178)",
        "Deleting an account also deletes its logins' `ai_sessions`; its digests stay, their `subject` tombstoned like every handle column. A reserved handle (`github-webhook`, `trov`) can never be deleted (#178)",
        "Trov plugin 0.9.0 (skill text only): `record-session` records decisions, findings and incidents and cites its commits — what shipped is Trov's session digest; `load-context` reads `get_repo_dashboard`'s `state` first; the `trov` skill says both (#178)",
        "The brief reads the session digests Trov wrote for the person (`origin = 'ai'`, `subject`): Now carries the latest `Status:` digest, Recently the week's digests beside their own notes (Q61) (#178)",
        "The Tickets screen's default view hides declined tickets (owner's ruling, 2026-10-15): `SEG_STATUSES.all` in `web/src/tickets.ts` is every status but `declined`, so the All board draws no Declined column and the table no declined row; `segRows` narrows the loaded rows before search, the filter menu's counts and \"N shown\". Closed (Done + Declined) is the way to them, and the switch's tooltips say so. A card a refetch finds declined while All is up leaves by the AI kit's one exit (`declinedLeavers`, `state.qLeaving`, `aiLeave`). The server's `seg=all` and MCP `list_tickets` are unchanged (#178)",
        "Deleting an account also deletes the person's stored briefs (`person_brief`), in every organization (#178)",
        "`switchBtn` (`web/src/notifications.ts`) takes an optional accessible name and a busy state; without them its markup is unchanged (#178)",
        "My Work › Queued handoffs: the button is Claim & copy (`mwHandoffClaim`): it copies the newest handoff as a prompt and claims it, as the handoff screen's Claim does (#178)",
        "My Work: the date sits top right of the greeting, and the line under the greeting is only what is waiting on you (`myWorkLayout` takes `date` and `stat`) (#178)",
        "Sift runs only while the organization's AI switch (`orgs.ai_automation`) AND its own `tag.fit` switch are on: `siftSwitches` reads both before the run and before every request, so turning the org's off stops a run in progress; the Tags tab says so (`TagAiDTO.org`). The run moved to `src/ai/sift.ts`, out of MCP's reach; `src/tools/tag-fit.ts` keeps the rest (#178)",
        "Org settings › AI: all four allowances with this month's use (Summaries, Written by Trov, Sift, Ask Trov), the Auto mode switch for Ask Trov (`PUT /ai/settings { chatAuto }`, admin, audited `org.ai_chat_auto`), and what is sent to each provider, Anthropic and TypeSafe AI (`AiSettings.allowances`, `chatAuto`, `AiSendLine.provider`; `runs` is gone). `LOCAL_AI_PREVIEW` fills its numbers in every mode (#178)",
        "The plain-language filter moves into each screen's Filter menu on Tickets, the Feed and Artifacts: \"Describe a filter\" (the AI mark) is the menu's first row and opens its field in place (`aiFilterMenuTop`, `FilterMenuProps.top`), growing open on `--fx-base` without a repaint; Enter or Apply runs `POST /ai/filter` as before, a refusal shows under the field and goes on the next keystroke, and the menu closes on its exit once a filter is applied. The standalone bar above the toolbar is gone; the \"Filtered: …\" line and Undo stay there (`aiFilterLine`) and leave by the AI kit's one exit (`AiController.leave`, key `filter:<screen>`). ↓ / ↑ walk a filter menu's rows, Escape hands focus back to its Filter button, and a field being typed in holds a hover-opened menu open (#178)",
        "`test/secrets.mcp.test.ts` pins the filter route as a model call site (`src/ai/filter.ts`, imported only by `src/ai/routes.ts`), and it as a reader of `ANTHROPIC_API_KEY` (#178)",
        "`test/secrets.mcp.test.ts` pins the three model call sites (the summary seams, the AI pass, the Sift run), that nothing MCP reaches imports `src/ai/` or the Jev provider, and that only `src/tools/classify.ts` names TypeSafe's URL (#178)",
        "`test/secrets.mcp.test.ts` also pins Ask's call sites (`src/ai/ask/turn.ts`, `history.ts`) and its boundary: nothing under `src/ai/ask/` reaches `src/data/secrets.ts`, `src/github-app/`, `src/billing/` or `src/mcp.ts`. Review's `GET /proposals` and `GET /adrs` carry `askFlags` (the reason and a count per item, never thread text). `KIND_PROVIDER` gains `ask.fast` / `ask.smart` / `ask.thinking` / `ask.compact`; `askChatClient` hands Ask's turn the SDK client for a mode (#178)",
      ],
      fixed: [
        "Org settings › AI's What is sent lists every AI use the Privacy Policy names — Ask Trov, plain-language filters and the notes and briefs to Anthropic, sorting and checking to TypeSafe AI — not only summaries and Sift (e2e OA-1 / LG-2) (#178)",
        "A digest whose brief block is only Also says Also once (e2e EM-4) (#178)",
        "A handoff's reading list rises in when a claim draws it, and never again on a rerender (e2e MO-13) (#178)",
        "Org settings › AI's switches keep the keyboard's focus while they save (`switchBtn` busy is `aria-disabled`) (e2e EV-OA-admin-K) (#178)",
        "The plain-language filter's \"Filtered: …\" line rises in when applied and leaves with the AI kit's one exit on Undo (e2e MO-10 / MO-11) (#178)",
      ],
      removed: [
        "The digest's per-PR What / Why / Impact cards, its assigned-issue rows and labels, the ticket queue's per-ticket rows and the Roadmap section's plan diff (Phase E: one line per queue) (#178)",
      ],
    },
    prs: [178],
  },
  // Hosting providers: Org settings › Hosting, the Repo dashboard's Hosting section, Detected, Vercel events.
  {
    version: "0.33",
    date: "2026-10-15",
    title: "Hosting providers",
    headline: "Connect Vercel, Netlify, Render or Fly.io, and the Repo dashboard shows every part of every environment, whoever hosts it.",
    highlights: [
      "Org settings has a new Hosting tab. Say which host runs each part of each environment (the web app, the API, a worker) and connect Trov to it once: Cloudflare, Railway, Vercel, Netlify, Render or Fly.io, every one the same way. AWS is listed as coming later.",
      "Where a host offers it, connecting is one click: Connect with Vercel installs Trov on the projects you pick, and Connect with Netlify signs in with Netlify. Otherwise you paste a token or a key, and Trov says what it can do and the only place it is ever sent.",
      "The Repo dashboard's Usage tab has one Hosting section for every part: its last deploy and the ten before it, then requests, error rate, latency and bandwidth for a web part, or CPU and memory for a service.",
      "A figure a host cannot report is a dash with the reason, never a zero. Vercel and Netlify publish no usage figures, so their parts show deploys and say so.",
      "Trov looks for your host on your repository and says how it is going: what to connect or add first, that it is looking (Sync GitHub now does it straight away), that it found nothing it knows, or Detected: Vercel, which picks that host for you when you add the part. Nothing is connected until you connect it.",
      "Vercel deploys show up as they happen: when a deploy starts, finishes or is rolled back, Trov reads that project again straight away instead of waiting for the hourly check.",
    ],
    ops: [
      "Apply `migrations/0057_hosting_providers.sql` (merging to main applies it). It adds the hosting tables, REBUILDS `org_secrets` only to widen its kind CHECK, moves each environment's Cloudflare / Railway columns into parts (`frontend` / `backend`), renames their `cf_*` / `rw_*` metric history to `hx_*`, and DROPS the five columns (`worker`, `worker_check`, `railway_env`, `railway_environment_id`, `railway_service_id`). Rollback: `scripts/hosting/0057_hosting_providers.down.sql`, run before 0042's.",
      "Railway: after the merge, SaplingLearn's Railway parts read nothing until Railway is connected ONCE on Org settings › Hosting with a workspace (team) token — the per-environment project tokens (`RAILWAY_TOKEN_*`, and `railway` secrets scoped to an environment) cannot serve the org-wide connection. Remove the `RAILWAY_TOKEN_*` Worker secrets once it is connected.",
      "Cloudflare: its traffic keeps working with the current token; its deploys now come from Cloudflare's Workers Deployments API, which needs the token to ALSO have Account › Workers Scripts › Read. Edit the token in the Cloudflare dashboard (no new value to paste) — until then the Cloudflare part shows its traffic and no deploys.",
      "No trigger change: the hosting job rides the existing `*/10` repo trigger at `:40`, so no `wrangler triggers deploy` is needed.",
      "Optional, for Connect with Vercel: create a Vercel Integration (scopes Projects: Read, Deployments: Read, Team: Read, User: Read, Integration Configuration: Read/Write; Redirect URL `<origin>/hosting/vercel/callback`; Configuration URL `<origin>/hosting/vercel/configure`; Webhook URL `<origin>/webhook/hosting/vercel` with `integration-configuration.removed`, `deployment.created` / `ready` / `succeeded` / `error` / `canceled` and `project.removed` ticked) and set `VERCEL_INTEGRATION_CLIENT_ID`, `VERCEL_INTEGRATION_CLIENT_SECRET` (secrets) and `VERCEL_INTEGRATION_SLUG`. Without them, Vercel falls back to a pasted token.",
      "Optional, for Connect with Netlify: register a Netlify OAuth application (Redirect URI `<origin>/hosting/netlify/callback`) and set `NETLIFY_OAUTH_CLIENT_ID` / `NETLIFY_OAUTH_CLIENT_SECRET`. Without them, Netlify falls back to a personal access token.",
      "Before relying on a provider, check its UNCONFIRMED points against a live account — listed per provider in `docs/superpowers/specs/2026-10-07-hosting-providers-research.md` and each `fixtures/hosting/<provider>/README.md`.",
    ],
    patches: {
      added: [
        "Hosting providers behind one interface, issue #97: `shared/hosting.ts` (the contract — providers, parts, roles, connection methods, the `hx_<metric>` vocabulary, deploy states, setup and dashboard DTOs) and `src/hosting/` (`types.ts`, `http.ts` — the fixed-host fetch with scrubbed errors and the shared poll window —, `registry.ts`, `parts.ts`, `part-writes.ts`, `connections.ts`, `setup.ts`, `routes.ts`, `webhook.ts`, `probe.ts`, `poll.ts`) (#185)",
        "Providers (issues #98–#102): Vercel — install or token —, Render — API key —, Netlify — OAuth or token —, Fly.io — a read-only token; AWS described as `later`; Cloudflare and Railway as the first two, LEGACY parts read from the environment's own columns (#185)",
        "Migration `0057_hosting_providers`: `org_environment_parts`, `org_hosting_connections`, `hosting_deploys`, `hosting_poll_state`; `org_secrets.kind` admits `vercel` / `render` / `netlify` / `fly` / `aws` (#185)",
        "Routes under `/api/o/:slug`: `GET /hosting`, `GET /hosting/providers`, `PUT|DELETE /environments/:key/parts/:part`, `POST /hosting/:provider/connect|disconnect|test`; the root `GET /hosting/:provider/callback` and the provider-side uninstall notice `POST /webhook/hosting/:provider` (#185)",
        "The `hosting` job on the repo cron's `:40` tick (one unit per stored part, budgeted by the provider's `pollCost`), a `hosting` arm in Poll now, and the Repo dashboard's provider-neutral `providers` section (also in MCP `get_repo_dashboard`) (#185)",
        "Data stubs for the UI: `web/src/hosting-sample.ts` (every Hosting setup state), the `providers` section of `web/src/repo-sample.ts`, recorded-shape API fixtures under `fixtures/hosting/<provider>/`; the design brief `docs/design/hosting-providers-claude-design-prompt.md` (#185)",
        "Org settings › Hosting (`#org/hosting`, admins; `web/src/hosting.ts`, `web/src/hosting-actions.ts`): the setup checklist, a tile per environment with its parts, a grid of provider cards with each host's logo, what it is and what Trov reads (Cloudflare, Railway, Vercel, Render, Netlify, Fly.io; AWS as later), one Connect or Manage button each and no hint of which connects more easily; Manage opens a dialog with Test connection, Rotate, Disconnect and the rest, and three dialogs: the part editor (host, role, key, a form generated from the provider's part settings), the install / OAuth confirmation, and the paste-a-token form, which says what the token can do and where it is sent. Test connection, Rotate, Disconnect and Remove; a notice for every `?hosting=<outcome>` return (#185)",
        "Repo dashboard › Usage › Hosting (`web/src/repo-hosting.ts`): one section for every part of every environment, whoever hosts it: the last deploy and a strip of the last ten, traffic per range for a web part, CPU and memory for a service. A figure a provider cannot read is a dash with its reason, never 0 (#185)",
        "`HostingSetupDTO.detected` (`src/hosting/detect.ts`): the providers the captured GitHub check runs and deployments already show, read from `repo_events` alone. Org settings › Hosting says Detected: Vercel and preselects it in the part editor; it connects nothing (#185)",
        "`POST /webhook/hosting/vercel` also takes `deployment.created` / `ready` / `succeeded` / `error` / `canceled` / `promoted` / `rollback` and `project.removed` / `project.renamed`: a verified one polls that project's parts again, after the response; any other event type is a 200 that does nothing (#185)",
        "`GET /hosting/:provider/configure?configurationId=…` (Vercel's Configuration URL): Org settings › Hosting of the org that holds that installation, for a signed-in admin of it; everything else is the same redirect to `/` (#185)",
        "Preview with sample data on Org settings › Hosting: five states from `web/src/hosting-sample.ts` (a dynamic import), with nothing sent while it is on (#185)",
        "Both screens use the empty-layout system: one shape builder each behind the loading skeleton and the empty layouts (`envTilesShape` / `partRowsShape`, `hostingShapes`), and `?preview=empty` / `?preview=loading` cover the Hosting tab through `previewState` (#185)",
        "Tests: `test/render.hosting.test.ts`, `test/render.repo-hosting.test.ts`, `test/hosting.detect.test.ts`, `test/hosting.webhook.events.test.ts` (#185)",
        "Tests: `test/hosting.contract.test.ts` (every provider), `test/hosting.provider.<id>.test.ts`, `test/hosting.setup.*.test.ts`, `test/hosting.poll.test.ts`, `test/hosting.cron.test.ts`, `test/hosting.dashboard.test.ts`, `test/hosting.sample.test.ts` (#185)",
      ],
      changed: [
        "`HostingSetupDTO.detection` (`readDetectionStatus`, src/hosting/detect.ts): no_repo → no_environment → looking → none / found, drawn in the Detected slot with its next step; the tab re-reads itself while looking; the Sync panel opens for an admin from any screen. Preview with sample data has two switchers, Flow × Stack (`hostingScenario`, 8 × 7 payloads, each held to the providers' checks) (#185)",
        "Form errors float in a small box right under their input (`fieldError` / `anchoredField`, org-ui.ts) instead of a line that pushes the form down; every \"Where to get it\" is numbered steps then short notes (`howToHtml` reads `1. …` lines as a list) (#185)",
        "Cloudflare and Railway are ordinary providers, with no legacy path left: their parts are `org_environment_parts` rows (0057 moves the environment's `worker` / `railway_*` columns into parts and drops the columns), each is connected ONCE for the org (Railway: a workspace token sent as Bearer — no per-environment project token; Cloudflare: Account Analytics Read + Workers Scripts Read), both are polled by the `:40` hosting job through `probe` / `poll` in `src/hosting/providers/`, and Railway serves both roles. `pollCloudflare` / `pollRailway`, the `cf_polled` marker, GitHub `deployment_status` capture and the check-run part tags are gone; the Repo dashboard's environment cards, deploy strips and Usage compare read `hosting_deploys` / `hx_*` for every part, and MCP `get_repo_dashboard` drops its `cloudflare` / `hosting` sections (#185)",
        "`hx_*` metrics are pruned with the hourly usage metrics (100 days); `hosting_deploys` after 180 days (#185)",
        "Repo dashboard › Usage: the Cloudflare — frontend Workers and Hosting — Railway backend blocks give way to the one Hosting section, where the Cloudflare frontend and the Railway backend are parts like any other. `parseCompact` / `errorShare` are gone with them (#185)",
        "The hosting provider callback lands on `/<slug>/?hosting=<outcome>&provider=<id>#org/hosting` (was `#org`), and the page opens on the Hosting tab (#185)",
        "Org settings › Environments points from its Cloudflare and Railway names to Hosting; quick search finds Org settings › Hosting (#185)",
        "Deleting an environment also deletes its stored parts, their poll state and deploy history, in the same batch (#185)",
        "`hosting` is a reserved org slug (`RESERVED_ORG_SLUGS`): the provider callback answers at the root, `/hosting/<provider>/callback`, and lands back on the org's own address, `/<slug>/?hosting=<outcome>` (#185)",
        "Org settings › Integrations lists a hosting provider's credential once a part uses it; pasting a token over an installed connection supersedes the install (#185)",
        "Connect with Vercel / Netlify holds the GitHub App's guarantees: one org per installation (a partial unique index; a second org gets `taken`), one live install per org — connecting a different one REPLACES it, no Disconnect first (the GitHub App's rule since #110; the replaced grant is removed on the provider's side, best effort), the installation id only from the provider's own answer, a random `state` with the sealed intent in the `trov_hx` cookie, a public callback that never answers JSON, the outcome as `?hosting=<outcome>` (`HOSTING_CONNECT_OUTCOMES`), the row, credential and config written in ONE batch, a provider-side 401 at Test connection ending the binding, `revoked_by = 'system'` and a CHECKed `revoked_reason`, and `manage_url` on every connection (#185)",
      ],
      fixed: [],
      removed: [],
    },
    prs: [185],
  },
  // Tags of your own, sorted by Sift: one tag list per organization, automatic tagging, a tag's page (#179).
  {
    version: "0.32",
    date: "2026-10-14",
    title: "Tags of your own, sorted by Sift",
    headline: "Each organization keeps its own tag list, and Sift finds the feed entries, docs and decisions that fit a new tag.",
    highlights: [
      "Tags are now each organization's own list, in Org settings › Tags. It starts with the six you know; an admin can add a tag, rename one, merge two or retire one, and give each a description and a colour.",
      "An admin can let Sift, Trov's automatic tagging, tag existing items for a new tag: it judges which feed entries, docs and decisions fit it. Where it is at least 85% sure it adds the tag; where it is 60–85% sure it suggests it, and anyone can add or dismiss the suggestion on the tag's To review tab. It is off until an admin turns it on in Org settings › Tags. An admin can undo a run, and anyone can take a tag off an item; Trov does not add it back.",
      "Click a tag to open its page: every feed entry, doc and decision that carries it, side by side, with when it was used, who writes about it, what it is often seen with, and which items Sift added. Docs have a Tags row of their own.",
      "The tag list is one even line per tag. Click what a tag is for to change it, or its square to change its colour; Rename, Merge into… and Retire are in each row's ⋯ menu. After you change a tag's words, Trov offers to look for items again.",
      "New tag, at the top right of the tag table, opens a short form: a name, what it is for, a colour, and whether Sift should find the items that fit it now.",
      "Tags an agent suggests now sit at the bottom of the tag list, shaded and marked Suggested, with Approve on the row.",
    ],
    headsUp: [
      "A feed entry with a tag that is not on your list is no longer held in Unplaced. It is posted without the tag, and the tag waits in Org settings › Tags, where an admin adds it, points it at a tag you already have, or dismisses it.",
      "Org settings no longer has a separate GitHub token step: Connect a repository is the GitHub step, done once Trov can read the repository.",
      "A tag list holds up to 30 tags on Free, 50 on Pro and any number on Enterprise. Retired tags do not count.",
      "While Trov looks, the tag's row shows a progress bar and a count of the items checked and tagged; the bar takes the tag's colour when it added the tag to something. Afterwards the row keeps the count, with Undo. A tag whose words match nothing still gets the newest items checked.",
    ],
    ops: [
      "Apply `0056_org_tags` (the deploy does it). It adds `org_tags` and `org_tag_suggestions`, gives every organization the six starter tags, and REBUILDS `entry_tags` without its reference to the global `tags` table: same columns and rows, a guard fails the migration if a row would be lost. Safe on the Worker from before it. Check first that every stored tag is one of the six: `SELECT tag, COUNT(*) FROM entry_tags WHERE tag NOT IN (SELECT tag FROM tags) GROUP BY tag` must return nothing. The by-hand rollback is in the file's header.",
      "A tag list holds up to 30 tags on Free, 50 on Pro, and any number on Enterprise; Sift checks up to 1,000 items a month on Free, 10,000 on Pro, and any number on Enterprise.",
      "Automatic tagging needs a NEW secret, `TYPESAFE_API_KEY` (TypeSafe AI's Jev); without it nothing is sent and the Tags tab says no key is set. Suggestions are OFF for every organization until one of its admins turns them on. The monthly allowance `jev_checks` is one per Jev request (a run makes up to 60). The Privacy Policy and Terms name TypeSafe AI as a new processor for automatic tagging (approved by the owner, dated 2026-10-14).",
      "Trov plugin 0.8.2 (skill text only): feed tags come from the organization's list (`list_tags`), and an unknown tag is a suggestion, not a triage item. Update the plugin from the marketplace.",
    ],
    patches: {
      added: [
        "`0056_org_tags`: `org_tags` (the org's own list: name, description, colour, `starter`, `retired_at`, `merged_into`) and `org_tag_suggestions` (one row per item and suggested tag: `source`, `confidence`, `reason`, `model`, `prompt_version`, `state`); `entry_tags` rebuilt without `REFERENCES tags(tag)`. No pull request yet (#179)",
        "`src/tools/tags.ts`: the list's rules (add, rename with its items, merge, retire, restore, settle a suggestion), each `requireRole(admin)` with an `org_admin_audit` row (`tag.*`); `setItemTags` for a member; `sortAgentTags` / `recordTagSuggestions` for the gate (#179)",
        "`src/tags/routes.ts`: `GET /api/o/:slug/tags[/:name]`, `POST /tags`, `PUT /tags/:name`, `POST /tags/:name/merge|retire|restore`, `POST /tags/suggestions/:name/resolve`, `POST /item-tags`. Cookie only: a request with an `Authorization` header is refused (#179)",
        "MCP `list_tags` (read-only): the organization's live tags and what each is for. 44 tools for every member (#179)",
        "The `tags` limit in `PLANS` (`LIMIT_KEYS`, `requirePlan(ctx, \"tags\")`): 30 Free and Personal, 50 Pro, unlimited Enterprise; `jev_checks` 1,000 / 10,000 / unlimited (#179)",
        "`src/tools/classify.ts`: the one classify call (issue 155 on GitHub), on TypeSafe AI's Jev (`POST /v1/systemone`): one request per item, one `noul` question, at most 4 in flight; the probability is the answer and its confidence; 429/529 retried once then the run stops, 401 stops it, 422 / timeout / bad answer is no judgement for that item (#179)",
        "`src/tools/tag-fit.ts`: which existing items fit a tag — candidates from the org's own FTS (≤ 60, newest first), ≤ 400-character excerpts with code and credential-shaped text removed; \"fits\" at 0.85 or more ADDS the tag, at 0.60–0.85 SUGGESTS it (an `open` model row; `POST /tags/:name/review/add|dismiss`, any member, cookie only; the tag page's To review tab), recorded with Jev's reported model, `jev-fit-1` and a reason built by Trov (the FTS snippet that matched, or Jev's score), since Jev writes no text; one run per tag (`org_tag_runs`), a re-run supersedes; started in the background after a tag is added and by Find items (#179)",
        "`org_ai_settings` (OFF by default; `PUT /api/o/:slug/tag-settings`), `POST /tags/:name/find-items`; the `jev_checks` monthly limit in `PLANS` (#179)",
        "A run, live: `org_tag_runs.checked` / `added` written as the run goes; `GET /api/o/:slug/tags/:name/run` (admins), polled every 600 ms while it runs; `web/src/fit-run.ts` draws ONE bar (fill = checked / candidates, eased, never ahead) whose colour says how it ended (#179)",
        "No review step (the owner's call, overriding issue 154's \"suggestions, never actions\" for this one feature): a fit at 0.85 or more ADDS the tag — the `entry_tags` row and its `org_tag_suggestions` provenance (`accepted`, resolved by `jev`, `run_id`) in one batch, one `tag.fit` audit row per run; `POST /tags/:name/undo-run` removes exactly that run's tags (`undone`); a person removing one is remembered (`removed`) and never re-added. The review list and `GET /tags/:name/fits`, `POST /tags/:name/fits/resolve` are removed; `jev` is a reserved handle (#179)",
        "Fewer than 20 keyword matches: the newest other items top the run up to 20; a topped-up fit's reason is `Sift rates it a fit (N%)`; an empty org ends the run with nothing checked, said plainly; the New tag modal says a description helps (#179)",
        "Web: Org settings › Tags (`web/src/tags.ts`, `tags-actions.ts`), a tag's page at `#tags/<name>`, a doc's Tags row, and `tagMark` / `tagWords` in `marks.ts` (a square and the word; plain words in a list, three then \"and N more\") (#179)",
      ],
      changed: [
        "The gate (`ingestFeedEntry`) reads the ORG's live tag list instead of `shared/vocabulary.ts` `TAGS`: known tags are written, an unknown one is recorded in `org_tag_suggestions` and the entry is written without it, never sent to `needs_triage` for that. `append_feed` / `record_session` answer `suggested_tags`. Replay ledger, section and confidence routing unchanged (#179)",
        "`get_feed` (HTTP and MCP) carries each entry's `tags`; `GET /doc/:slug` carries the doc's. The Feed's tag filter and Unplaced's tag picker read the org's list (#179)",
        "`createOrg` seeds the six starter tags; `shared/vocabulary.ts` `TAGS` and `0002_seed_vocab` now name the STARTER set, not the gate's vocabulary (#179)",
        "`assign_triage` (feed): a picked tag must be on the org's list; with none picked, the item's own tags go through the gate as they came (#179)",
      ],
      fixed: [
        "A tag page's Who writes about it and Often seen with bars all took the tag's colour; each is now the person's or the other tag's own (`meters` `tone`, `TagPageProps.colorOf` / `tagColorOf`) (#180)",
        "The header's breadcrumb (\"Tags › auth\", a ticket, a sprint, an artifact) set the page's name smaller and lighter than the title before it; both are 15px semibold now, the page you are on in full strength (#180)",
        "To review: adding or dismissing one of Sift's suggestions turned EVERY row's button to \"Adding…\" and waited for the whole page to reload; now only that row slides out at once (`TagsUi.reviewLeaving`, `data-leaving`), the write and a quiet refresh follow (`refreshPage`), and a refusal brings the row back (#182)",
        "To review: adding or dismissing a suggestion now says so in the app's confirmation at the bottom (a checkmark and \"Added latency to “…”\"), like every other write; the row leaves by the app's one row exit (Review's `.cnpy-rv-row`: it wears “Added” / “Dismissed”, then closes up in one motion over `REVIEW_EXIT_MS`, however fast the server answers), the list pairs rows by item (`data-morph-list`), the hero's split bar resizes smoothly, the row slides aside as it closes up, the tag page is morphed in place (`data-morph` = `tag:<name>`; it was rebuilt on every paint, so no transition could play), and the numbers that change (Items, Feed, Docs, Decisions, To review) tick into place (`TagsUi.bump`, `data-bump`) (#184)",
      ],
      removed: [],
    },
    prs: [179, 180, 182, 184],
  },
  // States drawn as marks instead of tags: the 2026-10 tag audit (#173).
  // Also: capture-time summaries move from Google Gemini to Anthropic's Claude, behind one model client (#176),
  // and the AI base (#177).
  {
    version: "0.31",
    date: "2026-10-14",
    title: "Calmer status, fewer tags",
    headline: "Every screen shows a state with a small shape and a plain word, not a coloured capitals tag on every row, and hovering one tells you what it means.",
    highlights: [
      "A ticket's status is a circle that fills as the work moves along: dashed for Triage, half for In progress, three quarters for Testing, a check for Done. Priority is a set of signal bars. Both say their name when you hover.",
      "Review shows no status tag. Everything in it is waiting, and the Promote, Ratify and Reject buttons already say so. A proposal the agent was unsure about says Low confidence next to a small amber triangle.",
      "Search no longer marks every result Live. Only a result that is not settled yet says so, for example Awaiting review.",
      "Sprints on the Roadmap use the same circles as tickets, and a late sprint shows a red warning triangle. Handoffs, artifacts, the doc you are reading, the Repo screen, Settings and the email digests show their state the same way: a small shape and the word.",
      "Hover a state to see what it means. Testing says \"Built, and being checked before it is done.\" and a stale branch says it has had no commit in 14 days.",
      "Pull request and issue summaries are now written by Anthropic's Claude.",
    ],
    headsUp: [
      "States now read in sentence case, for example \"In progress\" instead of \"IN PROGRESS\".",
      "A pull request's state on the Repo screen is a circle too: dashed for Draft, filling through In review and Approved, a check for Merged.",
      "Roles, \"(you)\", a plan's name and other plain facts are plain text now, not coloured chips.",
      "The Terms of Service and the Privacy Policy now name Anthropic, which writes the summaries, in place of Google.",
    ],
    ops: [
      "Set the `ANTHROPIC_API_KEY` secret before merging (`wrangler secret put ANTHROPIC_API_KEY`). Without it summaries fall back to excerpts and nothing breaks.",
      "Delete `GEMINI_API_KEY` (`wrangler secret delete GEMINI_API_KEY`) once summaries land with model `claude-haiku-5-5` (`SELECT model, COUNT(*) FROM pr_summaries GROUP BY model`). Existing Gemini rows stay; nothing is resummarized.",
      "Local development: `.dev.vars` takes `ANTHROPIC_API_KEY` in place of `GEMINI_API_KEY`; a `LOCAL_UPSTREAM` stand-in now answers `POST /anthropic/v1/messages` in the Messages API shape instead of `/gemini/…`.",
      "Apply migration 0055 before merging (`npm run db:migrate:remote`): `0055_ai` adds `orgs.ai_automation` (on for every org) and the `ai_suggestions` and `ai_feedback` tables. It is additive; the Worker from before it names none of them.",
      "Local development: `LOCAL_AI_PREVIEW=ready` (or `empty`, `capped`, `proposed`) in `.dev.vars` shows the AI screens' sample content under `wrangler dev` only (`docs/architecture/ai.md`). Never set it on a deployed Worker.",
    ],
    patches: {
      added: [
        "`web/src/marks.ts`: the one place a state is drawn. Progress glyphs (`glyph`, `ticketStatusIcon`, `priorityIcon`), shape-and-word marks (`stateMark`, `handoffMark`, `artifactStatusMark`, `authorityMark`, `LOW_CONFIDENCE`), `agentMark`, and the tone tables (`TICKET_STATUS_TONE`, `HANDOFF_MARK`, `ARTIFACT_MARK`, `AUTHORITY_MARK`) (#173)",
        "`EMAIL_CARD.mark` (`src/notifications/assemble.ts`): a small square and the word in its own face, for the digests (#173)",
        "`web/src/tip.ts`: one styled tooltip bubble (`.cnpy-mtip`) for every mark's `data-mtip`, placed by script so no container clips it; `placeTip` is pure and tested; off on touch and in the tour mocks (#173)",
        "`kindMark` / `STATE_KIND` (`marks.ts`): a state by what it means (good, waiting, warn, bad, stopped, done, off) for settings, billing, the Repo verdicts and the platform pages; `roleWord` and `(you)` in `org-ui.ts` (#173)",
        "`artifactKindLabel` (`shared/artifacts-core.ts`): HTML / SVG / PDF / Markdown / …, shared by the viewer and the site (#173)",
        "`test/render.marks.test.ts`: the marks are never a pill, and the signed-out site and every tour mock draw no pill and take their states from `marks.ts` (#173)",
        "Docs for Claude on the web: `/docs/connect` walks through adding Trov as a custom connector and gains \"In a chat, with no repository\" (what to ask, what differs with no checkout, the 1 MB file limit) with `CHAT_SNIPPET`, the agent rules for a claude.ai Project's instructions; `/docs/setup` steps 4 and 5 point to it (`web/src/docs-content.ts`) (#174)",
        "`otherClientsLink` (`web/src/mcp-connect.ts`): \"Not using Claude Code?\" links the guided setup's agent step, Settings › MCP access and the Guide to `/docs/connect`; the Guide's Other agents says how Claude on the web connects (#174)",
        "`src/ai/client.ts`: the one model client. `providerFor(kind)` (the `AiKind` union, today `summary_pr` / `summary_issue`, every kind mapped to Claude) hands out an `AiProvider` whose `structured()` sends `claude-haiku-5-5` a system prompt, an optional cached prefix and an input with `output_config.format` `json_schema`, checks the answer with the same zod schema, reports `AiUsage` (tokens, cached tokens, characters) through `onCall`, and never throws: a refusal, `max_tokens`, an API error, a timeout or a bad parse is `null` (#176)",
        "`src/ai/schema.ts`: `toClaudeSchema`, a zod schema's JSON Schema with what structured outputs reject stripped (lengths, bounds, `minItems` above 1, `$schema`) and every object closed (#176)",
        "`test/ai.client.test.ts`, `test/ai.schema.test.ts` and `test/helpers/anthropic.ts` (Messages API bodies for every summary test); `test/secrets.mcp.test.ts` checks that nothing reachable from `src/mcp.ts` imports `src/ai/` (#176)",
        "The AI contracts: `shared/ai-core.ts` (zod-free) and `shared/ai.ts` type the brief, the repo State, entries written by Trov, \"Where the work went\", AI settings, suggestions, \"Wrong?\" and usage; `shared/ai-fixtures.ts` holds the preview's sample DTOs. `brief?`, `state?`, `themes?` and `FeedRow.ai?` are optional on the existing reads and omitted in production: nothing produces them yet (#177)",
        "The `ai_runs` allowance (`shared/plans.ts`): 250 a month on Free and Personal, 2,000 on Pro, unlimited on Enterprise, counted from `ai_run:*`; `LimitDef.listed: false` and `LISTED_LIMIT_KEYS` keep it off the pricing page, the Plan block and Settings › Limits until something uses it (#177)",
        "`0055_ai`: `orgs.ai_automation`, the org's AI switch; `GET` / `PUT /api/o/:slug/ai/settings` (any member reads, admin+ writes, audited `org.ai`, cookie only) in `src/ai/routes.ts` (#177)",
        "`aiEligibility` (`src/ai/eligibility.ts`): `ok` / `off` / `no_key` / `capped` from one statement (`planAndAiRuns`: the plan, the switch and the month's runs) (#177)",
        "`src/ai/pass.ts`: the AI pass, after the health pings on every repo tick with no heavy job, on the cron's own budget. Its job registry `AI_JOBS` is empty, so it reads and fetches nothing; with a job it rotates orgs on `cron_cursor` (`ai_pass`), makes at most `AI_RUNS_PER_TICK` = 12 calls a tick, never overspends an org's allowance, and meters `ai_run:<kind>` before each call, then `ai_run_failed:<kind>`, `ai_run_capped:<kind>` and `ai_tokens_in` / `_out` / `_cached` (#177)",
        "`0055_ai`: `ai_suggestions` and `ai_feedback` (in `ORG_TABLES`, `HANDLE_COLUMNS` and the reset seed; data in `src/data/ai.ts`). `POST /api/o/:slug/ai/suggestions/:id/accept` runs a per-kind handler from `AI_ACCEPT_HANDLERS` (empty: every accept is 409 `not_available`) as the signed-in person, `…/dismiss` is any member's, and `POST /api/o/:slug/ai/feedback` records \"Wrong?\" once per person and item (`hiddenFor`) (#177)",
        "`LOCAL_AI_PREVIEW` (`src/ai/preview.ts`): the fixtures on `/me/dashboard`, `/repo/dashboard` and `/feed`, honoured only for a request to a loopback `http://` origin and never beside a live Stripe key; never over MCP (#177)",
        "`docs/architecture/ai.md`: where a model may be called (the summary seams and the AI pass only), the job registry, eligibility, the allowance, suggestions and the preview (#177)",
        "`test/ai.pass.test.ts`, `test/ai.routes.test.ts`, `test/ai.preview.test.ts` (#177)",
      ],
      changed: [
        "Platform › Usage: `OrgUsage.ai` and `PlatformUsageResponse.ai` carry AI runs, failures, caps and tokens when a key is set; AI metrics are never \"active people\" or an org's last activity (#177)",
        "`get_repo_dashboard` carries `state` with the overview tab and `themes` with planning when the dashboard has them (never today) (#177)",
        "Tickets: the table, board column heads, the status control and its menu, the rail, sub-ticket rows, sprint cards and the artifact attach picker draw `ticketStatusMark` / `priorityMark`; category, relation and source are plain text (`metaWord`) (#173)",
        "Review and Unplaced: no STAGED / DRAFT / FLAGGED tags; `ReviewItem` loses `badge` / `badgeColor`; a low-confidence proposal wears `LOW_CONFIDENCE`; the triage reason reads Low confidence / Flagged by an agent (#173)",
        "Search: the kind is an icon and a word, and `authorityMark` shows nothing for `live`. The feed's agent chip is `agentMark` (#173)",
        "Roadmap: Timeline rows and popovers use the progress glyphs (`stateTag`), Today is plain red text, and sprint cards show Next up, Overdue, the urgency bars, Due and the domain as marks and plain text. `shortDue` reads \"Sep 26\" (#173)",
        "Handoffs, artifacts (status, kind, area, Private, the compare sides, the upload warnings) and the doc page (the proposal notice, Promoted in history) use marks; the old-version banner has no tag (#173)",
        "The signed-out site and the tour mocks draw every state through `marks.ts`; `pill()` is removed from `landing-mocks.ts`. The pricing badge is a soft label and the tool names in For agents are set in the code face (#173)",
        "Ticket and review digests: status is a mark, priority is words, and the kind is a word instead of a chip (#173)",
        "Repo: an environment's verdict is `kindMark` over `ENV_VERDICT` (Healthy / Degraded / Failing / Down / Unknown) with what it means as its tooltip, the header's dots explain themselves the same way, a PR's state is the progress glyphs, Stale and Sample data are marks, and Due and the drift groups are plain text (#173)",
        "Settings and Org settings: roles are `roleWord`, your own row says (you), Primary / Private / the plan's name / Admin on a person card are plain text, and every status (integrations, the GitHub App, delivery, billing, a repository the App lost) is a `kindMark` (#173)",
        "Prompts: a version's status is a mark (Draft, Staged, Published), a published prompt's card shows none, and its tags are one line of plain words (#173)",
        "Platform: an org's status, invites, grants, a plan's billing and a support report's status are `kindMark`s; roles, a report's kind and Signed out are plain text (#173)",
        "Review's stale-base notice is a warning mark on a plain surface (no coloured left edge); What's new marks Unreleased; the MCP consent page's Recommended is a soft label; Unplaced's activity kinds and Notifications' Org default are plain text (#173)",
        "My Work and roadmap digests: Merged and the plan changes (Added / Changed / Reordered / Done) are marks, and a GitHub issue's labels are plain words (#173)",
        "Summaries: `makeGeminiSummarizer` is `makeClaudeSummarizer` on `structured()` behind the unchanged `Summarizer` interface (10s timeout, same prompts, `capSummaryBody`, excerpt fallback and storage; rows record `model = 'claude-haiku-5-5'`); `geminiPrSummarizer` / `geminiIssueSummarizer` / `GeminiOpts` are `claudePrSummarizer` / `claudeIssueSummarizer` / `AiOpts`, and the answers are the zod `PrSummarySchema` / `IssueSummarySchema` (#176)",
        "The `gemini` seam option is `ai` in `orgSummarizers`, `captureDelivery`, `runBackfill` and `runSyncBatch`; `GEMINI_API_KEY` is `ANTHROPIC_API_KEY` in `env.ts`, the Platform pages' `summaries_enabled` and off sentence, `vitest.config.ts` and `.dev.vars.example` (#176)",
        "`LOCAL_UPSTREAM` sends `api.anthropic.com` to `<base>/anthropic/…` in place of the Gemini host (#176)",
        "Terms › AI-generated summaries and Third-party services name Anthropic Claude; Privacy splits the Google row (sign-in only) from a new Anthropic row (summaries) and names Anthropic's Commercial Terms of Service; both are dated 2026-10-14 (#176)",
        "`progressFromIssueEvent` moves from `src/webhook.ts` (which re-exports it) to `src/tools/progress.ts`, so `src/mcp.ts` no longer reaches the webhook, or the model client, through the sprint reads (#176)",
      ],
      fixed: [
        "The docs' page tabs reloaded the whole page: `docs-page.ts` now fetches the other page's prerendered HTML (prefetched on hover) and swaps its band and body in, with Back / Forward, the head's title and links, and focus on the new title; the contents column no longer shows a scrollbar (#174)",
        "A mark in an email took the mail client's serif default where its cell set no face (#173)",
        "The artifact attach picker called a Triage ticket SUBMITTED and showed a Testing ticket as a plain grey tag (#173)",
        "Email digests coloured ticket statuses differently from the app (#173)",
        "The site's Docs mockups drew the tree's disclosure chevrons as text triangles (▾ / ▸); they are the app's stroked chevron now (`treeChev` in `landing-mocks.ts`), muted and turned for an open doc (#175)",
      ],
      removed: [
        "`statusBadge` (`ui.ts`), `chip` / `roleChip` (`org-ui.ts`), `EMAIL_CARD.chip`, `.cnpy-rel-tag`, and native `<title>` tooltips on the glyphs (#173)",
        "`ticketPill`, `priorityChip`, `tagChip`, `handoffPill` and the per-file `CHIP_BASE` / `TAG_BASE` copies; the unused `ticketPill` / `priorityChip` import in `render.ts` (#173)",
        "The Gemini REST call (`generateContent`), `parseStructuredJson` and the hand-written `validatePrSummary` / `validateIssueSummary`",
      ],
    },
    prs: [173, 174, 175, 176, 177],
  },
  // The public site, readable by search engines, share cards and AI assistants: prerendered pages, robots.txt,
  // sitemap, canonical links, noindex on the app, a real 404; then public docs, llms.txt, Markdown versions and
  // errors an agent can act on. (#172)
  // Also: self-serve deletion — one's own account (Settings), an organization (its owner, Org settings), and both from Platform.
  // Also: the compliance pass — the Terms, Privacy and a new Refund and Cancellation Policy, consent at sign-up, billing
  // terms before checkout, the footer's business details, the AGPL source link, accessibility basics, third-party notices.
  {
    version: "0.30",
    date: "2026-10-12",
    title: "Readable by search engines and agents, yours to delete, and plain about the terms",
    headline: "The public site and new docs arrive with their words on the page for search engines and AI assistants; Trov loads nothing from anyone else; and you can delete your account, or an owner an organization, without writing to us.",
    highlights: [
      "The site's pages open with their words already there, each under one address search engines can find, with a preview card when a link is shared. Your organization's pages, sign-in and the API stay out of search results.",
      "New public docs at trov.dev/docs: setting up, connecting Claude Code, Claude Desktop, Cursor, VS Code, Codex or Windsurf (with the config to copy), how Trov decides what is settled, every MCP tool, and the changelog. Each page is also plain Markdown, and trov.dev/llms.txt lists them for AI assistants.",
      "Trov no longer contacts anyone else when you open it: its typefaces and the diagram renderer come from trov.dev itself, not Google Fonts or a CDN. Text, links, status labels and form fields meet the WCAG AA contrast guidelines in both themes, and every button, link, menu item and field shows where keyboard focus is.",
      "The Unsubscribe link at the bottom of a Trov email works without signing in. It opens a page that says whose email it stops and what still arrives, and nothing changes until you press Unsubscribe.",
      "You can delete your account in Settings, and an organization's owner can delete it in Org settings › General. An account takes its sign-ins, sessions, agent connections, email settings, photo and support messages, and signs you out everywhere; what you wrote in organizations that carry on stays, credited to “Deleted user”. An organization goes whole, and if it pays for Pro its subscription is cancelled at Stripe right away, with no refund for time already paid. Trov's operators can delete either from Platform, under the same rules, and each deletion is recorded.",
      "New Terms of Service and Privacy Policy, and a Refund and Cancellation Policy at trov.dev/refunds. They say who runs Trov (TrovLabs, Inc., a New Jersey corporation), what is collected and why, which services process it, every cookie, how long things are kept and what deletion keeps; and that Pro renews monthly until you cancel, stays active until the end of the period paid, and is not refunded for partial periods except where the law requires.",
    ],
    headsUp: [
      "The home page's headline no longer fades in: it is there at once and settles into place.",
      "When a call fails, the error your agent gets now says what to do next, for example that a ticket must be assigned to you first, or that the repository is not connected.",
      "The home page's Questions also answer what Trov is, how it differs from a README or a wiki, which MCP clients work, what Pro adds, and whether you can run Trov yourself.",
      "Trov's emails now use your device's own fonts instead of downloading the site's, so opening one no longer contacts Google.",
      "The welcome email now says what was always true: email digests are on from the start, and when they arrive. It has an Unsubscribe link, like the digests, and someone who has unsubscribed is not sent one.",
      "Settings › Email notifications says exactly what still arrives after you unsubscribe: an invitation, a test digest you send yourself, and word that an organization you were given or paid for is ready. Invitation and organization emails now say why they came.",
      "The old in-app unsubscribe address now opens Settings and changes nothing. Before, opening it turned off email for whoever was signed in.",
      "Some colors are a little deeper so they are easier to read: quiet grey text, links, the green, amber, blue and red labels, and the purple banner in the light theme; quiet text and red in the dark theme. Text fields have a clearer edge.",
      "In the dark theme, the initials on a colored avatar and the label of a red Delete button are now dark rather than white.",
      "The home page no longer shows \"Signing you in…\" to someone who is signed out.",
      "An address that does not exist shows a Page not found page with a way back, instead of asking you to sign in.",
      "In the dark theme the site opens dark, with no white flash first.",
      "Before anything is deleted you type your handle or the organization's slug, and Trov tells you what is in the way first: being the only owner of a team that has other people in it, or paying for a team that carries on.",
      "Signing in again with the same GitHub or Google account after deleting your account starts a new, empty account.",
      "A deletion can't be undone. An organization nobody else is in is deleted together with your account, and the confirmation names it.",
      "If you pay for a team that carries on, cancel its plan first (it stays Pro until the end of the period already paid), or ask us to move the billing to another owner.",
      "Creating an account now asks you to tick a box agreeing to the Terms of Service and the Privacy Policy and confirming you are 16 or older. The sign-in screens, including the one an agent opens to connect, say what continuing agrees to.",
      "Before you pay for Pro — on the pricing page, in Get started, beside Upgrade to Pro and on the payment page — Trov shows the per-seat total, that tax is added at checkout, that Pro renews monthly until you cancel and that you can cancel any time from Billing, with links to the Terms and the refund policy. The email after a purchase says the same.",
      "The pricing page no longer labels Pro “Most teams start here”. The home page no longer says tickets are never closed automatically (a ticket mirrored from a GitHub issue follows that issue), and the pricing questions and the docs now say what Trov's operators can see.",
      "Every page's footer names TrovLabs, Inc. of New Jersey and hello@trov.dev, and links the Terms, Privacy, Refunds, the source code and the third-party licences. Settings › Help, What's new, the agent sign-in pages and the MCP server link the source code of the version you are using.",
      "A Skip to content link is the first thing the keyboard reaches on every page. The sign-up form, New doc, New handoff, New sprint and the artifact forms label every field, the Guide's screenshots describe themselves, links in the legal pages and docs are underlined, and the sign-in dialog keeps the keyboard inside it.",
    ],
    ops: [
      "`wrangler.toml` `[assets]` gains `run_worker_first = [\"/\"]`: `/` is answered by the Worker (the prerendered landing, or the app shell with a session cookie). It ships with the Worker; nothing to run.",
      "The build now writes `web/dist/_redirects` and `web/dist/_headers` (Workers Static Assets reads both): no setting to change. The build command is unchanged (`npm run build:web`).",
      "New reserved organization slugs `og` and `404` (and, from now on, the path of every page in `shared/site-pages.ts`). Before deploying: `npx wrangler d1 execute trov --remote --command \"SELECT slug FROM orgs WHERE slug IN ('og','404')\"` must return nothing.",
      "One-time, outside the repo (`HANDOFF.md` › 10): Always Use HTTPS on, a www → apex Redirect Rule, optionally the workers.dev route off; verify `trov.dev` in Google Search Console as a Domain property (DNS TXT) and submit `https://trov.dev/sitemap.xml`.",
      "One-time, Cloudflare dashboard (`HANDOFF.md` › 10, AI crawlers): AI Crawl Control must not block the search and assistant crawlers (\"Block AI bots\" is on by default for new zones), the managed robots.txt must be off (it would prepend its own rules), and Bot Fight Mode / WAF rules must not challenge them. Check `curl -s https://trov.dev/robots.txt | head` starts with `# trov.dev:`.",
      "`shared/mcp-tools.generated.ts` is written by `npm run build:web` from the MCP server's own registrations; commit it whenever a tool changes (`test/mcp-catalog.test.ts` fails until you do). Nothing to run at deploy: the build regenerates it.",
      "New reserved paths: the docs live under `/docs/<page>` (`docs` was already a reserved slug); `/llms.txt`, `/llms-full.txt`, `/pricing.md` and `/docs/<page>.md` are static files.",
      "New dependency `mermaid` (exact `11.17.2`): `npm ci` picks it up; nothing to configure. New reserved organization slug `fonts`: before deploying, `npx wrangler d1 execute trov --remote --command \"SELECT slug FROM orgs WHERE slug = 'fonts'\"` must return nothing.",
      "No migration, no new secret, no trigger. Deletion is live on merge.",
      "Before relying on it: (1) check D1 Time Travel's retention in the Cloudflare dashboard — a deleted account or organization stays restorable from it until that window passes, and the Privacy Policy should say so; (2) a Time Travel restore across a deletion brings it back: re-apply the deletions it undid (`scripts/deletion-refs.mjs`, and `docs/architecture/organizations.md` › After a restore); (3) the Stripe webhook needs no change — the cancel a deletion makes sends `customer.subscription.deleted`, which Trov acknowledges and ignores.",
      "New reserved organization slug `source` (and `refunds`, a page of `SITE_PAGES`): before deploying, `npx wrangler d1 execute trov --remote --command \"SELECT slug FROM orgs WHERE slug IN ('source','refunds')\"` must return nothing.",
      "`/source` (the AGPL source link) is a `_redirects` rule the build writes from Workers Builds' `WORKERS_CI_COMMIT_SHA`: nothing to configure. A build that knows no commit (local) points it at the repository; so does the Worker, should the rule be missing.",
      "Stripe dashboard, test and live (the Terms and refund policy describe these; the code cannot check them): Settings › Public details: the Terms of Service (`https://trov.dev/terms`), Privacy (`https://trov.dev/privacy`) and refund policy (`https://trov.dev/refunds`) URLs; Customer Portal: cancel AT THE END OF THE PERIOD, allow resuming, and the proration you want on seat changes; Emails: successful-payment receipts on. Checkout's own `consent_collection` / `custom_text` are not sent (they need the Terms URL set first): the owner's call.",
      "`THIRD-PARTY-NOTICES.txt` (served at `/third-party-notices.txt`) is generated: after a dependency change run `node scripts/licenses/notices.mjs` and commit the file.",
      "Human decisions this pass left open (no deploy step): governing law and venue (the Terms say New Jersey), whether the Gemini key's Google project is a paid one (the Privacy Policy says only that Google handles the text under the Gemini API terms that apply), the D1 Time Travel and Workers Logs retention to verify against \"up to 30 days\" and \"a few days\", and a lawyer's review of all three texts.",
    ],
    patches: {
      added: [
        "`shared/site-pages.ts`: the public site's ONE page list (`SITE_PAGES`) — titles, descriptions, Open Graph images; `siteHead` (canonical, Open Graph, Twitter), `softwareApplicationLd` (Free and Pro from `PLANS` / `PRICING`, Pro per seat per month as a `UnitPriceSpecification`; Enterprise has no price, so no Offer), and the generated `_redirects` / `_headers`. A new page is one entry (#172)",
        "`web/site-build.ts` (a Vite plugin) and `web/src/site-prerender.ts`: every input is generated and prerendered from the code that boots it — `index.html`, `pricing.html`, `terms.html`, `privacy.html`, `404.html` — plus the empty app shell `app.html`; `THEME_BOOT` paints the stored theme before the page is parsed (#172)",
        "`src/site.ts`: `GET /robots.txt`, `GET /sitemap.xml`, `/` as the landing (no `session` / `onboard` cookie) or the app shell (`Vary: Cookie`; `?denied=` and `DEV_LOGIN` get the shell), `canonicalRedirect` (www and plain http → `https://` + the public host, 301), `noindex`, `notFound` (#172)",
        "`isAppRoute` (`src/routes.ts`): an address no handler answers (by method and path; `use()` middleware does not count) is a 404 before the session gate — the built page, or `{ error: \"not_found\" }` under `/api` and for other methods (#172)",
        "`web/src/not-found.ts`: the 404 page, no script (#172)",
        "`test/site.test.ts`, `test/site-pages.test.ts` (#172)",
        "Public docs (`kind: \"docs\"` in `SITE_PAGES`): `/docs/setup`, `/docs/connect`, `/docs/concepts`, `/docs/mcp-tools`, `/docs/changelog` — each ONE Markdown text (`web/src/docs-content.ts`, `docs-tools.ts`, `docs-changelog.ts`) served at `/docs/<page>.md` and rendered into the page (`web/src/docs.ts`, raw HTML escaped); `<link rel=\"alternate\" type=\"text/markdown\">` in each head; script `docs-page.ts` (theme, Copy, contents) (#172)",
        "`/llms.txt` and `/llms-full.txt` (`web/src/llms.ts`, llmstxt.org), `/pricing.md` (`pricingMarkdown`), written by the build; `_headers` gives the Markdown `text/markdown; charset=utf-8` and `Link: <page>; rel=\"canonical\"`, the two text files `text/plain; charset=utf-8` (#172)",
        "The MCP tools reference is generated: `src/mcp-catalog.ts` lists the real registered tools (admin and member, through the SDK client) and `web/site-build.ts` writes `shared/mcp-tools.generated.ts` before prerendering; groups in `shared/mcp-tools-core.ts`; `catalogTenant` (`src/data/context.ts`, no database); `test/mcp-catalog.test.ts` (#172)",
        "`hint` on errors: `shared/error-hints.ts` (one table by code and status), `withErrorHint` (`src/error-hints.ts`) on the Worker's JSON errors (the app, the artifact token routes, the 404), `toolError` in `src/mcp.ts` for every tool error, and `/mcp`'s 401 body; `test/error-hints.test.ts` (#172)",
        "robots.txt names the AI search and assistant crawlers (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, Googlebot, Bingbot, Applebot, DuckAssistBot) and the training ones (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot) in groups that repeat every Disallow; the training ones follow ONE switch, `AI_TRAINING_CRAWLERS` in `src/site.ts` (default `\"allow\"`, as before) (#172)",
        "FAQPage JSON-LD on `/` from the landing's own Questions (`web/src/site-questions.ts` + `pricingQuestions`, `faqPageLd`); new questions: what Trov is, README / wiki, MCP clients, what Pro adds (from `PLANS`), running Trov yourself (#172)",
        "Open Graph cards for the five docs pages (`scripts/og/render.mjs`) (#172)",
        "`src/notifications/unsubscribe-page.ts` + `handleUnsubscribe` (`src/notifications/unsubscribe.ts`): `GET /u/<token>` is a server page — who the token names (name, handle, masked address), what unsubscribing stops and what still arrives, a form POSTing `?confirm=1` (→ 303 back) — and changes nothing; CSP `default-src 'none'`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `no-store`, noindex. The one-click POST is unchanged; a bad token is a 404 page / 401; other methods 405 (#172)",
        "`shared/email-unsubscribe.ts`: what unsubscribing stops and what still arrives (`STILL_SENT`), one wording for Settings and the `/u/` page (#172)",
        "`emailHead` / `emailFooter` (`src/notifications/assemble.ts`): every non-digest mail's `<head>` (no link) and last row (why it came; the Unsubscribe link on a notification) (#172)",
        "`test/notifications.unsubscribe.test.ts`, `test/notifications.email-kinds.test.ts`: the page and both POSTs, forged tokens; per-kind flag, link and header behavior; no web font in any rendered mail (#172)",
        "Self-hosted fonts: `web/src/fonts/` (Geist latin + latin-ext, Archivo Narrow latin — the variable woff2 subsets Google Fonts serves — with their SIL OFL 1.1 texts), `@font-face` at the top of `trov.css` (`font-weight:100 900`, `swap`, Google's `unicode-range`), `shared/fonts.ts`, and `FONT_PRELOAD` (Geist latin) in every built document; Vite hashes the files into `/assets/` (#172)",
        "`'Geist Fallback'`: local Arial / Helvetica / Liberation Sans with `size-adjust` and ascent / descent overrides measured against Geist (three weight bands), after `'Geist'` in every stack, so the `swap` barely moves prerendered text (#172)",
        "The build writes the fonts and licenses at stable paths, `/fonts/<file>`, for the Worker's own pages (OAuth, billing notices); `fonts` joins `RESERVED_ORG_SLUGS` (#172)",
        "Tokens `--border-input`, `--focus`, `--red-fg`, `--p-ink`; `test/render.contrast.test.ts` computes every text / control token pair of both themes (text 4.5:1 on `--bg`, `--surface` and its own 12% chip; field edges and focus 3:1; the banner's text at its two light points) and fails under WCAG AA (#172)",
        "`test/render.focus.test.ts` (no `:focus` rule removes the outline; every ring is 2px in an allowed colour; fields are covered) and `test/render.fonts.test.ts` (no third party in any document, the preload, the faces, the licenses, mermaid pinned) (#172)",
        "`src/deletion/`: ONE core per deletion. `org.ts` `deleteOrganization` — Stripe first (`src/billing/cancel.ts`: open Checkout Sessions expired, every live subscription cancelled with `DELETE /v1/subscriptions/:id`, Stripe's defaults: no proration, no final invoice), then one D1 batch with foreign keys deferred, then R2. `person.ts` `deleteAccount` — the guard rails, the orgs nobody else is in deleted with the account, then one batch: personal rows deleted and the handle rewritten to a `deleted-<random>` tombstone through `HANDLE_COLUMNS`",
        "`src/deletion/tables.ts` `ORG_TABLES`: every table with an `org_id` column, deleted by `org_id`; a manual connection that can still reach another org moves there. `test/deletion.org.test.ts` fails when a migration adds an `org_id` table it does not list",
        "`src/deletion/r2.ts` `sweepR2`: after the commit, an `artifacts/`, `doc-images/`, `org-logos/` or `avatars/` object is deleted only when no row anywhere (and no unexpired upload token) still points at its sha",
        "Routes, cookie only, never MCP: `GET /auth/me/deletion`, `POST /auth/me/delete { confirm }`; `GET /api/o/:slug/deletion`, `POST /api/o/:slug/delete { confirm }` (owner only); `GET|POST /api/platform/orgs/:slug/deletion|delete`, `GET|POST /api/platform/persons/:handle/deletion|delete` (superadmin; never a superadmin's account or one's own)",
        "Audit: `org.delete` (a platform row, the slug as target, the Stripe ids a refund would need) and `person.delete` (the tombstone as target, `ref` = a keyed hash of the old handle so a restored database can be matched); every org the person left gets `member.leave`. `scripts/deletion-refs.mjs` matches refs after a restore",
        "Web: Settings › Delete account, Org settings › General › Delete organization (owners), Platform › an organization › Delete, Platform › Admins › Accounts (`web/src/deletion.ts`, `deletion-actions.ts`); `confirmModal` gains a typed confirmation field, `detail`, `error` and a wide box (`web/src/confirm.ts`); the landing says `?deleted=account|org` once",
        "`shared/deletion-core.ts`: the previews' DTOs, the guard-rail codes and every sentence the screens use; `test/deletion.{org,account,platform}.test.ts`, `test/render.deletion.test.ts`",
        "`/refunds`: the Refund and Cancellation Policy, a `legal` page of `SITE_PAGES` (`REFUNDS` in `web/src/legal.ts`, `LEGAL_DOCS` / `LEGAL_ORDER`), with its Open Graph card (`scripts/og/render.mjs refunds`), sitemap line, 301s and reserved slug; the legal tab row is `legalTabs`, built from `LEGAL_ORDER` (#172)",
        "`shared/legal-core.ts`: the operator (`LEGAL_ENTITY` TrovLabs, Inc., `LEGAL_STATE` New Jersey), `LEGAL_EMAIL`, `MIN_AGE` (16), the legal paths, `SOURCE_PATH` / `sourceUrl`, `NOTICES_PATH`, `copyrightLine`, the consent sentence (`consentHtml`, `agreeHtml`) and `LEGAL_LINKS` — one copy for the site, the app, the Worker's pages, the mail and MCP (#172)",
        "Consent: `consentHtml()` under the landing's sign-in / Get started dialog (every mode and plan), on the refused-Google card and on the MCP OAuth sign-in page; onboarding has an unchecked, required checkbox (`onbAgree`, `OnboardState.agreed`) that Continue waits for — not asked again when editing an account (#172)",
        "Billing terms before payment: `seatMath` + `CHECKOUT_TAX` / `RENEWAL_TERMS` / `CANCEL_TERMS` (`shared/pricing.ts`) on the Pro card (`planTerms`, inside `.site-plan-ctabox` so the subgrid holds), the Pro side of Get started, the Plan block and Settings › Plan (`upgradeLine` with the org's own seats, `checkoutTerms` / `cancelTerms`), the Members tab's Upgrade to Pro, the embedded payment card, and the paid confirmation mail (`paidTermsText`) (#172)",
        "AGPL §13: `/source` → the deployed commit (`assetRedirects(commit)` / `sourceRedirect` in `shared/site-pages.ts`, `WORKERS_CI_COMMIT_SHA` read by `web/site-build.ts`; `src/site.ts` answers it too), linked from the footer, Settings › Help (`legalLinksRow`), What's new, the OAuth / billing pages (`LEGAL_FOOT` in `oauth-pages.ts` `shell`), the Terms, and the MCP server's `instructions` (`mcpInstructions`) with `serverInfo.websiteUrl` (#172)",
        "`THIRD-PARTY-NOTICES.txt` + `scripts/licenses/notices.mjs` (what the browser bundle and the Worker actually contain, from Rollup's chunks and esbuild's metafile, with licence texts; the fonts' OFL; Lucide's ISC for the inline icons), served at `/third-party-notices.txt` (`text/plain; charset=utf-8`) (#172)",
        "Skip links (`skipLink` / `followSkipLink` in `site-chrome.ts`, `.site-skip`) on every public page and the app shell (`#cnpy-main`), never writing the hash; a Tab trap for the sign-in dialog; `role=\"main\"` on the sign-up card's wrapper (#172)",
        "`test/render.legal.test.ts` (rewritten), `test/legal.compliance.test.ts`, `test/legal.worker.test.ts` (#172)",
      ],
      changed: [
        "`X-Robots-Tag: noindex` on every GET / HEAD the Worker answers but `/robots.txt`, `/sitemap.xml` and the landing, and on everything on a host other than `PUBLIC_ORIGIN`'s; `_headers` adds it to every static file on `*.workers.dev`, and to `/app` and `/404` (#172)",
        "The app shell is `/app` (`web/app.html`: `noindex`, no canonical, no landing), served for `/<org>/`, `/platform`, `/billing/done`, `/billing/checkout` and `/` with a session — no longer the landing's `index.html` (#172)",
        "`main.ts`: on the prerendered landing the boot paints it at once (a morph, nothing rebuilt) and asks no `/auth/me`; the hero copy is rendered settled with a transform-only CSS rise (`site-rise`); `@media (scripting: none)` shows every reveal; `pricing-page.ts` / `legal-page.ts` patch their prerendered root (`paintRoot`); `syncPageBackground` keeps `<html>` in the theme (#172)",
        "`/index`, `/index.html`, `/<page>.html` and `/<page>/` answer 301 to the clean URL (were the assets binding's 307) (#172)",
        "`RESERVED_ORG_SLUGS` gains `og`, `404` and every page of `SITE_PAGES` (#172)",
        "An unknown address is a 404 instead of the session gate's 401 (`test/spa-shell.test.ts`, `test/billing.signature.test.ts` follow); a real cookie route is unchanged (#172)",
        "`/docs/` and a browser's signed-out `/docs` (accepts `text/html`, no session cookie) 302 to `/docs/setup`; `/docs` stays the cookie route for a fetch and for anyone signed in (#172)",
        "The landing's MCP card counts and lists the tools from the generated list (43 tools, plus 1 admin-only), with links to the reference and the client setup; pricing's \"Can we read the source?\" now also says what running your own copy takes (#172)",
        "`get_ticket` / `get_sprint` on an unknown id answer `code: \"not_found\"` (same sentence as before, now with its code) (#172)",
        "`test/isolation.mcp.test.ts`: the three every-tool matrices (~3.5s each alone) take a 20s budget instead of 5s, so a busy machine no longer times them out (#172)",
        "The welcome is a NOTIFICATION: `welcomeFirstJoin` sends none to a person with `email_unsubscribed = 1`, and it carries the unsubscribe link (footer + `List-Unsubscribe`); its digest line comes from the joined org's policy and send hour (`welcomeDigests`, `digestSentence`). Invitations and grant / paid notices stay transactional, with a footer saying why they came (#172)",
        "`List-Unsubscribe` is the https one-click link alone (`unsubscribeHeaders`): the `mailto:` alternative is gone, since nothing processed it (#172)",
        "Every mail is set in a system font stack (`EMAIL_FONT_STACK`); `FONTS_HREF` and every Google Fonts `<link>` are gone from mail (#172)",
        "Mermaid is the `mermaid` npm dependency pinned to `11.17.2`, loaded by `import(\"mermaid\")` (lazy Vite chunks on Trov's origin; `securityLevel: \"strict\"` unchanged) instead of `cdn.jsdelivr.net/npm/mermaid@11` (unpinned) (#172)",
        "WCAG AA token values, hue kept: light `--fg-40` #8e8e98 → #70707a, `--accent` #5e6ad2 → #525cc3 (and `--accent-soft`), `--green` → #007545, `--amber` → #945800, `--blue` → #2467af, `--red` → #c22231, `--purple` → #804db7, `--p-moss` → #607a29, `--p-ochre` → #966800; dark `--fg-40` .40 → .52, `--red` #cc6262 → #df7372; the banner gradient one step deeper in both themes, its highlight .16 → .10 (light), its text ≥ 92% white. `src/auth/oauth-pages.ts` copies the light values (#172)",
        "Every text field's edge is `--border-input` and its focus a 2px `--focus` ring — one `!important` rule in `trov.css`, since the fields' borders and `outline:none` are inline; a borderless field inside a box colours the box (`:has`). Focus rings use `var(--focus)` (was the accent at 70%) (#172)",
        "The OAuth / billing pages' CSP is `font-src 'self'` (was Google Fonts); `scripts/og/render.mjs` inlines the vendored Geist and needs no network (the PNGs come out byte-identical) (#172)",
        "`deleted-…` handles are reserved: no sign-up or rename can take one (`handleAvailable`)",
        "The handoff sentence Trov writes into the feed (\"<sender> left a handoff for <recipient>\") names the tombstone once its person is deleted; text people typed is never rewritten",
        "`stripeCall` takes `DELETE` (no idempotency key: Stripe ignores one there); the Stripe stand-ins (`scripts/dev/stripe-standin.mjs`, `test/helpers/billing.ts`) answer the cancel and the session expiry",
        "CLAUDE.md invariant 11: accounts and organizations are hard-deleted, and only through `src/deletion/`",
        "The Terms and the Privacy Policy are rewritten from the code (effective 2026-10-12): TrovLabs, Inc. of New Jersey, eligibility 16+, agents act as the person, per-seat billing, Stripe Tax, anniversary-date renewal, cancellation and refunds (pointing at `/refunds`), deletion and what it keeps, the six cookies, a retention table, rights, transfers, governing law; the legal tab row shows Terms · Privacy · Refunds and the date reads \"Effective and last updated\" (#172)",
        "The site footer: Contact · hello@trov.dev · Pricing · Terms · Privacy · Refunds · Source (AGPL-3.0) · Licenses, then `© <year> TrovLabs, Inc. · New Jersey` (`copyrightLine`); the bare \"Licensed under AGPL-3.0\" text and `.site-foot-lic` are gone (#172)",
        "`PRICING.team.badge` is null (no \"Most teams start here\"); the accent still falls on Pro, so the pricing card and its OG image are unchanged (#172)",
        "Labels: onboarding Handle / Display name (`for` / `id`, help and status as `aria-describedby`, the colors a named radiogroup, swatches named), New doc, New handoff, New sprint, the artifact forms; Guide screenshots get `GUIDE_ALT` text; site navs are named landmarks; links in `.site-legal-sec` text and the legal summary are underlined; `.site-signin-foot` text is `--fg-70` (axe contrast) (#172)",
        "The Guide's 42 screenshots (`web/public/guide/`) are retaken on the current UI and brand with a made-up team and organization: `node scripts/seed-dev.mjs --guide-demo` loads `scripts/seed/guide-demo.mjs` (the dev fixtures with fictional people, org and product, dates moved to the present), so no real person's name, handle or address and no \"Canopy\" appears; `scripts/capture-guide.mjs` frames Board / Table with the queue's view switch, shows My Work's Repo tile on the labelled sample data and falls back to the Chromium under `PLAYWRIGHT_BROWSERS_PATH` (#172)",
      ],
      fixed: [
        "Search Console's \"Duplicate without user-selected canonical\" on `/`: the home page carries a canonical, and no other address serves its HTML — the app shell at `/<org>/`, `/platform` and `/billing/*` was `index.html`, byte-identical to `/`, with no canonical anywhere (#172)",
        "`/robots.txt` and `/sitemap.xml` answered the session gate's 401 (#172)",
        "`/pricing`'s description named the retired Personal and Team plans; it is built from the plan tables now (#172)",
        "The landing said \"39 tools, plus 1 admin-only\"; the server registers 43, plus 1 (#172)",
        "`AGENTS.md` sent agents to a token screen Settings no longer has; it points at the browser sign-in and the docs (#172)",
        "A digest's footer Unsubscribe link (`GET /u/<token>`) redirected to `/#unsubscribe` and dropped the token, so it needed a sign-in and then turned off mail for whoever was signed in — not the person the mail was for (#172)",
        "The welcome email said digests were off until a cadence was picked; they are on by default (#172)",
        "Settings › Email notifications said nothing of any kind sends after unsubscribing; invitations, grant notices and test sends do, and now it says so (#172)",
        "The avatar menu's rows, `dropdown()` options and the filter bar's button showed keyboard focus only as a faint hover tint; the New sprint form and the New doc body showed none, and no inline-styled field ever showed `.cnpy-input:focus` (#172)",
        "Weight 640 (`trov.css`) rendered as 650: the static Google weights are replaced by the variable axis (#172)",
        "Legal and marketing claims the code did not back: the GitHub `read:org` scope (sign-in asks `read:user user:email`); \"seats cannot be reduced below the number of people\"; \"charged at the start of each month\" (it is the subscription's anniversary); \"expired and revoked tokens are cleared\" (pasted tokens and revoked grants are kept); content visible \"to nobody else\" (operators and processors); Google Fonts as a processor; \"tickets and sprints are never closed automatically\" (mirrored tickets follow their issue); \"rejected proposals and old versions are kept, never deleted\"; the retention the Privacy Policy left out (usage counts 400 days, audit trail, support reports, invitations, the email log, expired sessions) (#172)",
        "The landing's sign-in dialog let Tab wander onto the page behind it (#172)",
      ],
      removed: [
        "`web/index.html`, `web/pricing.html`, `web/terms.html`, `web/privacy.html` (generated now) (#172)",
        "The in-app `#unsubscribe` screen (`unsubscribeView`, `runUnsubscribe`, Settings' \"Preview the unsubscribe page\"): `#unsubscribe` now parses to Settings and changes nothing (#172)",
        "Google Fonts from every built page, the app shell and the OAuth / billing pages (stylesheet, preconnects, CSP), and jsDelivr from the app (#172)",
      ],
    },
    prs: [172],
  },
  // One GitHub account, several Trov organizations: repositories split between orgs (#170).
  {
    version: "0.29",
    date: "2026-10-11",
    title: "One GitHub account, several organizations",
    headline: "Several Trov organizations can connect the same GitHub account, track the same repository, and connect with whatever repositories their admin can read.",
    highlights: [
      "More than one organization can connect the same GitHub account through the Trov App. Before, the first organization to connect an account kept it, and a second one had to paste a token and add a webhook by hand.",
      "Several organizations can track the same repository. Each gets its own copy of that repository's pull requests, checks and deploys, and nothing in one organization says who else tracks it.",
      "You no longer need to read every repository of a GitHub account to connect it. Connect with the repositories you can read: your organization can then use exactly those. An owner of the GitHub account still gets all of them.",
      "When an organization is connected with part of an account, Repositories lists only that part and says whose access it is. Got access to more on GitHub since? Choose Connect again to add them.",
      "Disconnecting GitHub in one organization leaves the others connected. Uninstalling the Trov App on GitHub ends the connection for every organization that used it, and each is told.",
      "Getting ready for Claude on the web: connecting from claude.ai preselects Manual, so the connection works in the organization you pick, and handoffs, prompts and artifacts no longer assume a code repository. An agent with no shell can open and add image, PDF and file artifacts up to 1 MB.",
    ],
    headsUp: [
      "An organization still captures events for its primary repository only. Other tracked repositories are listed and resolve links, as before.",
      "What an organization can read is checked when its admin connects, not again later. To drop access someone no longer has on GitHub, disconnect and connect again.",
      "Claude on the web has not been tried against Trov yet. There, a file over 1 MB can be linked but not opened or uploaded, and a picture you attach in the chat usually cannot be passed on to Trov.",
      "A connection that says \"cannot read N of the repositories\" no longer happens: it now connects with the repositories you can read. With none, it says so and connects nothing.",
    ],
    ops: [
      "Migration `0053_installation_repos` (applied on merge): the index on an installation stops being unique, `org_github_installations` gains `repo_access` (default `all`, which is what every existing connection is), and the table `org_github_installation_repos` is added. No table is rebuilt and no row changes. Rollback is in the file's header. No secret, no trigger, no change on GitHub.",
    ],
    patches: {
      added: [
        "`0053_installation_repos`: `idx_org_github_installations_installation` is no longer unique (several orgs may bind one installation; `idx_org_github_installations_org` stays); `org_github_installations.repo_access` (`all` | `selected`); `org_github_installation_repos` (what a `selected` binding reaches: GitHub's id, the name, private or not) (#171)",
        "`src/platform/jobs.ts`: `installationOrgs` (every org bound to an installation) and `installationRepoOrgs` (every bound org that tracks a repository and whose binding reaches it). `installationOrg` is gone (#171)",
        "`src/github-app/store.ts`: `allowedRepos` / `repoAllowed`, and `bindInstallation` takes what the connect flow found readable; connecting again adds to a `selected` list or widens it to `all`, never narrows (#171)",
        "`GithubInstallationDTO.repo_access`; Repositories says whose access a `selected` connection carries and links Connect again (`web/src/github-app.ts`) (#171)",
        "`content_base64` on `upload_asset` (artifact and doc image) and `artifact_update`, and `include_file` on `artifact_get` (an image block or an embedded resource; `file` says what happened): binary bytes inside the call, ≤ `ARTIFACT_INLINE_BINARY_MAX` (1 MB), through the same token mint and consume as a PUT (`src/tools/artifacts-agent.ts`, `src/mcp.ts`) (#171)",
        "`test/github-app.shared.test.ts`: two orgs on one installation and on one repository, and a `selected` org through the webhook, the picker, Disconnect and the token (#171)",
      ],
      changed: [
        "The connect flow no longer refuses an installation another org holds, nor an account that reads only part of it: check 5 now decides `all` or `selected` (the readable repositories, by id), and refuses only an account that reads none (`no_access`, which replaces `partial_access`). `?existing=1` offers every reachable installation (`src/github-app/connect.ts`) (#171)",
        "An installation past 1,000 repositories is connected as `selected` when the account reads 1,000 or fewer of them; `too_many_repos` is now about what the ACCOUNT reads (#171)",
        "`POST /webhook/github/app`: `installation` and `installation_repositories` events are applied to every org bound to the installation; a repository's event is captured once in every org that tracks it as its primary and reaches it (`src/github-app/webhook.ts`) (#171)",
        "`visibleRepos`, and so the picker, `POST …/github/repositories` and `syncRepoAccess`, are cut to what the org's binding reaches (`src/github-app/repos.ts`) (#171)",
        "`resolveGithubCredential` / `githubCredentialSource`: the installation does not answer for a repository outside a `selected` binding's list; the stored token does, if there is one (`src/github-app/credential.ts`) (#171)",
        "The connect outcome `taken` is replaced by `conflict` (two connects racing for one org) (#171)",
        "The MCP consent page preselects and recommends Manual for a client that returns to `claude.ai` / `claude.com` (`isWebClient`, `src/auth/oauth-pages.ts`): such an app is in no repository to follow (#171)",
        "Tool descriptions say what to do with no checkout and no shell: `send_handoff`, `claim_handoff`, `save_prompt`, `artifact_get`, `upload_asset`, the shared `repo` argument, and the `repo_required` refusal (`src/mcp.ts`, `src/data/bearer.ts`) (#171)",
      ],
      fixed: [],
      removed: [],
    },
    prs: [171],
  },
  // Embedded checkout: pay inside Trov's own card instead of on Stripe's page. OFF until Trov turns it on (#136).
  {
    version: "0.28",
    date: "2026-10-10",
    title: "Pay without leaving Trov",
    headline: "Buying Pro can happen on a Trov page, in the same card as the rest of signing up, instead of on Stripe's site.",
    highlights: [
      "You can pay for Pro without leaving Trov. The payment form opens on a Trov page; it is still Stripe's own form, so your card details go straight to Stripe and Trov never sees them.",
      "The form sits in the same card as the rest of signing up, with the same banner, so paying is one more step of setting up your organization and not a trip to another site. Upgrading an organization from Free works the same way.",
      "Reloading the page, or coming back to it, picks up the same payment where you left it. If you already paid, you are taken to the confirmation and never asked to pay twice.",
      "If the form cannot load, for example behind a content blocker, the page says so and offers Stripe's own page for the same purchase, and you come back to Trov when it is done.",
      "Nothing changes until Trov turns this on. Until then, and whenever it is turned off again, buying Pro goes to Stripe's page exactly as before.",
    ],
    ops: [
      "Embedded checkout is OFF until `STRIPE_PUBLISHABLE_KEY` is set in `wrangler.toml` `[vars]` (empty by default; nothing changes for buyers until then). To turn it on: paste the Stripe publishable key of the SAME mode as `STRIPE_SECRET_KEY` (`pk_test_…` beside `sk_test_…`, `pk_live_…` beside `sk_live_…`; Developers › API keys — it is public, never the secret key) and merge. No migration, no secret, no trigger. For Apple Pay, Google Pay and Link in the form, add `trov.dev` under Stripe › Settings › Payments › Payment method domains (per mode). To turn it off: empty the var and merge; checkout is Stripe's hosted page again. `docs/architecture/billing.md` › Owner checklist.",
    ],
    patches: {
      added: [
        "Embedded checkout (`STRIPE_PUBLISHABLE_KEY`, var; empty = off): `/billing/checkout` (`web/src/billing-checkout.ts`), a payment page in the bannered first-run card with Stripe's embedded form mounted in its body (`data-morph=\"billing-checkout\"`, the mount node `data-keep`, so a repaint never rebuilds Stripe's iframe). States: a skeleton while it loads, the form, \"The payment form did not open\" with Continue on Stripe's page (a hosted session for the same purchase) and Try again, an expired checkout, and a refusal as a sentence. `BillingConfig.embedded` (`src/billing/config.ts`) is the one switch: on only for a `pk_` key of the secret key's mode against the real Stripe API, never with `STRIPE_TEST_API_BASE` (#136)",
        "`POST /api/billing/checkout` (session cookie only) and `POST /api/o/:slug/billing/upgrade { ui }`: the payment page's call. `startCheckout` makes the same session with `ui_mode: \"embedded\"` and `return_url` in place of `success_url` / `cancel_url` and answers its client secret to the signed-in buyer, `no-store`, never logged or stored; `session_id` resumes an open session (no new Stripe object, no `checkout` unit), answers `complete` for a paid one (the page goes to `/billing/done`) and `expired` for an expired one; `ui: \"hosted\"` is the fallback. `GET /api/billing/config` says `embedded: true` while it is on (#136)",
        "`web/src/stripe-js.ts`: Stripe.js from `https://js.stripe.com/v3/`, injected by the payment page's boot only (never the landing or the app), no npm dependency, a 15 s timeout; `test/billing.embedded.test.ts`, `test/render.billing-checkout.test.ts`, and a client-secret canary in `test/billing.leak.test.ts` (#136)",
        "The state preview (`web/src/preview.ts`) never opens a checkout: `/billing/checkout` under a preview shows \"Nothing can be paid in a preview\" and asks the Worker for nothing, and Stripe.js is not loaded (#136)",
        "`docs/architecture/billing.md` › First real test: the owner's Stripe TEST-mode walk of the embedded form on their own machine (#136)",
      ],
      changed: [
        "With embedded checkout on, `GET /billing/start` (signed in) answers 303 to `/billing/checkout?plan=…` and the org's Upgrade to Pro answers `{ url: \"/billing/checkout?…&org=<slug>\" }`; neither creates a session (the page does). Off, both are the hosted redirect, unchanged. After payment Stripe returns to `/billing/done?session_id=…` either way and the webhook still fulfils (#136)",
        "Privacy (`web/src/legal.ts`): Stripe's script (Stripe.js) runs on the payment page, and only there, and sets Stripe's own cookies; `updated` stays 2026-10-09 (#136)",
        "The Stripe client cuts anything shaped like a Checkout Session client secret out of an upstream error before it is logged (`src/billing/stripe.ts` `clean`) (#136)",
      ],
      fixed: [],
      removed: [],
    },
    prs: [136],
  },
  // The signed-out site on a phone (#139).
  {
    version: "0.27",
    date: "2026-10-10",
    title: "The site on a phone",
    headline: "The front page, pricing, the terms and the sign-in and contact forms are laid out for a phone, not shrunk to fit one.",
    highlights: [
      "On a phone the top bar is one row: Trov, Get started and a Menu button. The menu opens from the bottom of the screen with every section of the page, the theme switch, the source on GitHub, Sign in and Get started.",
      "The pictures of the product are drawn for a narrow screen. The Review screen at the top shows one change in a single column with Reject and Promote under it, each screen in the tour shows its most telling part, and none of the text in them is too small to read.",
      "Opening a screen from the tour fills the phone: the screen, what the Guide says about it, and Previous and Next at the bottom under your thumb. Swipe left or right to move between the seven.",
      "Sign in, Get started and the Contact form rise from the bottom of the screen with full-size buttons. When the keyboard opens the form ends above it, and Send stays in view while you type.",
      "Pricing is a readable stack of the three plans with one column of questions, the install commands for the Claude Code plugin sit in their own box over a Copy button, and the footer is a list of links you can tap.",
      "The Terms of Service and Privacy Policy read as a page on a phone: larger text, and the contents folded behind a Contents button until you want them.",
    ],
    patches: {
      added: [
        "The site's menu under 900px: `menuSheet` in `web/src/landing.ts`, a root-level `data-overlay=\"sitemenu\"` (`role=\"dialog\"` `aria-modal`) drawn from `state.siteMenu`, with the five `siteJump` links, `cycleTheme`, the GitHub link and both `openSignIn` buttons (Back to the app when reopened from inside it). The nav always carries its button (`openSiteMenu`, `aria-expanded`, `aria-controls`); GitHub, the theme toggle and Sign in carry `site-nav-x` and leave the bar under 900px (#139)",
        "`web/src/site-menu.ts` (`createMenuCtl`): the scroll lock (undone at once on close, so a section link scrolls the page while the sheet leaves), focus to the first link and back to the button, Esc, the Tab trap (`trapIndex`), an exit on `--fx-fast` (`data-closing`, `MENU_EXIT_MS`), none under reduced motion, and a close when the window grows past 900px. Acts `openSiteMenu` / `closeSiteMenu`; `siteJump`, `openSignIn` and `siteBack` close it first (#139)",
        "One block in `web/src/trov.css`, \"the site on a phone\", holds every rule the signed-out site changes for a narrow or touch screen. All of it is behind `max-width:900px`, `max-width:640px`, `max-width:480px` or `(hover:none)`; the only rules outside a query hide what a wide screen never shows, or style the menu, which `min-width:901px` hides (#139)",
        "A swipe steps the tour's dialog on a phone: `swipeStep` in `web/src/site-feature-core.ts` (at least 56px, twice as far across as down, under 700ms) and `onPointerDown` / `onPointerUp` / `onPointerCancel` in `web/src/site-feature.ts`, touch and pen only. The panel and its scroller are `touch-action:pan-y`, so a vertical scroll stays the browser's and cancels the gesture (#139)",
        "`web/src/site-viewport.ts` (`initSiteViewport`, `coveredBottom`): `--site-kb` on `<html>` is the height of the window the on-screen keyboard covers, read from `visualViewport`. Under 640px the sign-in and Contact sheets are lifted by it and lose it from their `max-height`, and the focused field is scrolled into view inside the sheet (#139)",
        "The legal contents disclosure: `legalView(doc, dark, tocOpen)` emits a `data-legal-tocb` button (`aria-expanded`, `aria-controls`) and a `.site-legal-tocw` wrapper round the list; under 900px the box is folded (`grid-template-rows:0fr`, the list `visibility:hidden`) until `web/src/legal-page.ts` opens it, it survives the theme toggle, and a contents link folds it at once before scrolling (#139)",
        "`test/render.site-mobile.test.ts`: the menu's markup, state and acts, that every rule of the phone block is behind a width or hover query, the hero's unified-diff hooks, the 11px type floor covering every smaller size the mockups use, the sheet rules, `swipeStep`, `coveredBottom`, the Copy button, the footer and the legal disclosure (#139)",
        "`docs/architecture/web-ui.md`: a section \"The site on a phone\" (the menu overlay, the sheet pattern, the mockup rule) (#139)",
      ],
      changed: [
        "The hero under 640px: the headline at `clamp(32px, 9.4vw, 40px)`, the two buttons 50px tall (stacked under 480px), the banner's dots masked toward its foot and its tilted mark placed bottom right. The Review mockup drops its fixed 568px height and shows ONE unified diff: the left pane's twin lines (`site-hero-twin`) and both pane heads are hidden, the removed line is ordered above the added ones, the verdict is two buttons under the diff and the toast sits at the top of the window (#139)",
        "No text in a mockup renders under 11px under 640px: one rule keyed on the inline sizes (`[style*=\"font-size:9px\"]` and the six others in use) inside the hero mockup, the tour's teasers, the how-it-works cards, the agents cards, the Contact form and the dialog's screens; the 18px and 20px avatars that hold initials grow to 22px and 24px (#139)",
        "Tour rows under 640px stack copy then mockup with a 22px gap and 64px between rows; Explore is a bordered 44px button; the Tickets teaser keeps two columns (`site-hide-ph` drops Testing), the Artifacts teaser is one column, and the dots run edge to edge behind each mockup (#139)",
        "The tour's dialog under 640px: a 44px close button, 48px Previous and Next with `env(safe-area-inset-bottom)` under them, the board at two columns, and three rows re-laid (`fxm-hrow`: a handoff's title over who, state and when; `fxm-staged`; `fxm-stats`) (#139)",
        "Sign in / Get started under 640px: the card slides up (`site-sheet-up` on `--fx-slow`), the plan switch is 44px, the providers 50px, the close button 44px. Contact: 46px fields, a 44px kind switch, and Cancel / Send in a sticky row at the foot of the sheet (`scroll-padding-bottom` keeps a focused field above it) (#139)",
        "Pricing under 640px: a full-width interval switch, 48px plan buttons, 14.5px limits, 15px answers, 56px question rows. Sections carry `site-sec` and take 84px of top padding and a 20px gutter; a nav jump lands the heading 16px under the bar (`scroll-margin-top:-8px`) (#139)",
        "The plugin card under 640px: each install command stays on its line and scrolls inside its box, and Copy is a labelled 44px button under them (`mcp-connect.ts` `copyBox`, restyled for `.cnpy-site` only; Settings and the guided setup are unchanged) (#139)",
        "Terms and Privacy under 640px: 16px text at line-height 1.72, the document switch as two 44px halves, contents links as 44px rows. The footer stacks left-aligned with its links as 44px rows in two columns and the licence after the copyright (`site-foot-lic`, a span only a phone shows) (#139)",
        "On a touch screen (`hover:none`) cards and mockups no longer stay lifted after a tap, and a tour mockup answers a press with its accent edge (#139)",
      ],
      fixed: [
        "The hero's Review mockup was cut off at the bottom on a phone: its two diff panes wrapped to a few words a line inside a window fixed at 568px (#139)",
        "The tour dialog's Tickets board overflowed its cards on a phone (an avatar outside its card), and a handoff's title was cut to a few letters (#139)",
      ],
      removed: [],
    },
    prs: [139],
  },
  // Review, polished after its first real queue (26 staged docs) (#138).
  {
    version: "0.26",
    date: "2026-10-10",
    title: "Review, made for a long queue",
    headline: "Rendered shows a proposed doc the way it will read, and a card you decide on leaves the list in one clear move.",
    highlights: [
      "Rendered now shows the document, not its source. A proposed doc reads the way it will in Docs once promoted: headings, tables, lists, code and images, where before you saw the raw text with its # and | marks.",
      "For a change to an existing doc, Rendered marks what the proposal adds in green and shows what it removes struck through, inside the text where a sentence, a list item or a table cell was edited, and a whole paragraph, item or row at a time where one was added, removed or rewritten. A brand-new doc is shown plain, with one line saying nothing is live yet.",
      "When you promote, ratify or reject, the card shows the verdict, folds away, and the next one is already open on the right. The counts drop with it, and you can decide several in a row without waiting. If a decision could not be saved, the card comes back and a message says why.",
      "The queue's filter and the way a change is shown are now switches like the rest of Trov. All, Proposals and Decisions each say how many are waiting.",
      "The list keeps its place. Picking a card far down a long queue no longer jumps the list back to the top.",
      "The screen says Review once, in the top bar, with one line under it.",
    ],
    patches: {
      added: [
        "`web/src/html-words.ts`: two renderings of one block merged word by word (`mergeInline`), so Rendered marks an edit INSIDE a paragraph, heading, list item or table cell (`<ins class=\"cnpy-rv-w\">` / `<del class=\"cnpy-rv-w\">`, `data-chg=\"mix\"`, `tr.cnpy-rv-row-chg`) instead of showing the old block and then the new one. A tag is one token with its quoted attribute values, only text tokens are wrapped, no old tag is kept, and anything the tokenizer cannot account for refuses the merge; an edited table row pairs with the added row it still shares a cell with (#138)",
        "`web/src/review-rendered.ts` + `web/src/md-blocks.ts`: Review's Rendered view renders the two BODIES through `renderMarkdown` (the Docs reader's pipeline: marked, DOMPurify, the code / table / doc-image pass) in `.cnpy-md`. An edit is cut into top-level blocks with marked's lexer, compared with `diffSeq`, and each changed block sits in an `<ins>` / `<del>` (`.cnpy-rv-blk`); a table whose header stayed is ONE table with its changed rows classed (`cnpy-rv-row-add` / `-del`), a list is compared item by item. A new doc (`isNew`: nothing live) is one call, unmarked, under one note (#138)",
        "`morph.ts` `data-morph-list`: a keyed child list. Children pair by `data-morph-key` instead of by index, so a row taken out of the middle leaves every other row the element it was. `docs/architecture/web-ui.md` › A row leaving a list is the pattern to reuse (#138)",
        "Review's list exit: `state.reviewLeaving` (`{ verdict, gone }` by item id), `reviewVerdict` / `settleReview` / `pruneReviewLeaving` in `main.ts`, `.cnpy-rv-row[data-verdict]` in `trov.css` (the verdict held .13s, then `grid-template-rows:1fr → 0fr` and opacity over `--fx-fast`; `REVIEW_EXIT_MS` 310). The refetch is held until no card is still collapsing; a failed write deletes the entry and restores the selection (#138)",
        "`test/render.review-rendered.test.ts`; the switch, title, keyed-list, verdict and reduced-motion cases in `test/render.review.test.ts` (#138)",
      ],
      changed: [
        "Review is `data-morph=\"review\"`: the page is patched in place, the detail body is keyed by item (`rvd:<id>`) and the diff body by mode (`diff:<mode>`). The list pane keeps its scroll position across a repaint, and the detail pane starts at the top for a new item (`syncReviewDetail`, which also hands focus from a verdict button to the next item's) (#138)",
        "Unified / Side by side / Rendered and All / Proposals / Decisions are `segmented()` (`review-diff`, `review-filter`, size `sm`); the filter's options carry counts (`.cnpy-seg-n`), absent while the queue is still being read. `selectChip` is no longer used by Review (#138)",
        "`triageCounts().review` leaves out items in `reviewLeaving`, so the sidebar badge drops with the card; it is derived per paint, never stored (#138)",
        "`ReviewItem` carries `liveBody`, `proposedBody` and `isNew`; `diffViewer(item, view)` replaces `diffViewer(entries, view, liveLabel)`; `lineDiff` is built on the new `diffSeq` (#138)",
      ],
      fixed: [
        "Review › Rendered: removed text inside a table row or block was struck twice where it held inline code or bold (the strike was set on the cell and again on the child); it is set once, on the removed box (#138)",
        "Review › Rendered showed raw markdown: it printed the line-cut diff one escaped line at a time, so no table, list or code fence could ever form, and unchanged runs were collapsed away (#138)",
        "Review said its name twice (the header's title and an in-page heading); the in-page `<h1>` is gone and the one-line description stays (#138)",
        "Selecting a card rebuilt the whole screen and reset the list's scroll to the top (#138)",
      ],
      removed: [
        "`renderedPreview` and its per-line image handling in `review.ts` (the reader's own doc-image pass does it now) (#138)",
      ],
    },
    prs: [138],
  },
  // The signed-out landing page, revamped around the first-run card's banner (#134).
  {
    version: "0.25",
    date: "2026-10-09",
    title: "A new front page",
    headline: "The page you see before signing in now opens on Trov's purple banner, with the product standing in front of it.",
    highlights: [
      "The front page opens on a banner in Trov's purple, the same one that greets you when you set up an account, with a live picture of the Review screen standing on it. \"Agents propose, people decide\" is a card of its own, in the same banner.",
      "Signing in opens a clearer card: Continue with GitHub or Continue with Google, and a line that says either one creates your account. No invitation is needed.",
      "A bug button in the top bar, beside the theme switch, opens a short report form on any screen, and Settings has Contact support for questions and feedback. The form shows exactly what is sent with your message (the screen you were on, your organization, the app version and your browser) and tells you where the reply will come. Signed out, Contact at the foot of the site opens the same form and asks for an email address to reply to.",
      "Every screen in the tour opens for a closer look: the screen itself drawn at full size the way it looks in Trov, what the Guide says about it, and Previous and Next to move through all seven. The arrow keys work, and Esc closes it.",
      "The Claude Code plugin card now shows the two install commands with a Copy button, and the three steps to connect.",
      "Moving through the front page is calmer: sections arrive with a short, small fade, and a link in the top bar scrolls once and stops with the heading just under the bar.",
    ],
    headsUp: [
      "The Terms of Service and Privacy Policy changed on October 9, 2026. They now cover paid plans: how Pro is billed, changing seats, cancelling, refunds, what happens when a plan ends, and Stripe as the company that takes payment.",
      "The Privacy Policy also says what a bug report or support message stores: what you wrote, the screen you were on, your organization, the app version and your browser. Sent from the site without signing in, it stores what you wrote, the page, your browser and the email address you type, which is used only to reply to you.",
      "Connecting Claude Code changed: one connection now covers every organization you belong to. When you allow it you choose how it picks one: Follow the repository (it works in whichever of your organizations has the repository you are in connected, and reads and writes nothing anywhere else) or Manual (the organizations you tick, one at a time). Connections you already have keep working exactly as before, in their one organization; you can add organizations to one, or switch it to follow the repository, in Settings › MCP access (Change organization\u2026 on the connection). The Allow page now says which account it is signed in as: a connection you approve shows up under that account. If you added the Trov server twice to reach two organizations, you can remove the second.",
    ],
    ops: [
      "Apply migration `0049_support_reports` (additive: one new global table, `support_reports`, and two indexes; rollback by hand in its header). `SUPPORT_NOTIFY_EMAIL` in `wrangler.toml` `[vars]` is `hello@trov.dev`: the inbox that receives bug reports and support messages, including those from the public Contact form (at most 50 signed-out reports a day). Make sure that address receives mail. Emptied, reports are stored and shown in Platform \u203a Support and no mail is sent (the report's mail outcome reads `skipped`). Mail goes out only when `NOTIFICATIONS_MODE = \"resend\"`.",
      "`STRIPE_TAX = \"on\"` in `wrangler.toml` `[vars]`: checkout asks Stripe Tax for the tax. Stripe is set up for it in TEST and LIVE mode (each Pro price is tax-exclusive, an origin address, the SaaS business-use category, no registrations), so no tax is charged until a registration is added in Stripe.",
      "Apply migration `0051_mcp_connection_orgs` BEFORE the Worker that reads it (additive: `oauth_grants.mode` with default `manual`, the new table `oauth_grant_orgs` backfilled with each live grant's ONE organization, and the trigger `oauth_grants_revoked_au`; rollback by hand in its header). No existing connection gains reach. Then publish the Trov plugin 0.8.0 (`claude plugin marketplace update trov` then `claude plugin update trov@trov`): its skills pass `repo` on every call and `load-context` opens by saying which organization it is in. An older plugin keeps working with existing connections; a connection that follows the repository needs 0.8.0, or it is refused with `repo_required`.",
    ],
    patches: {
      added: [
        "The support form: one dialog (`web/src/support.ts`, a root-level `data-overlay=\"support\"`) with a `segmented()` kind switch (Bug, Question, Feedback), an optional subject, a required message and a read-only block naming what is attached (route hash, org slug, app version, user agent). Opened by a bug icon button in the app header beside the theme toggle (`bugBtn`, on Bug), by Settings \u203a Help \u203a Contact support (`helpSection`, `.cnpy-set-help`, on Question) and by a link in the org picker's foot. Sending, failed (the text is kept) and sent states; a draft closed with Esc is kept; \u2318/Ctrl+Enter sends. Nothing is added to the sidebar (#134)",
        "The signed-out Contact form: Contact in the site footer (`siteFooter(\"dialog\")` on the landing page; a link to `/?contact=1` on pricing, terms and privacy) opens the same dialog in the sign-in card's style with a required email field, a honeypot and a Privacy Policy link. It posts to the public `POST /api/support/public` (admitted through `PUBLIC_PATHS`; JSON only; zod `SupportPublicSubmit`), which stores a report with no reporter and `contact_email` (unverified, as typed), reads the browser from the request's User-Agent header, and with a session cookie files it as the signed-in person instead (#134)",
        "Abuse bounds of the public form: no mail is ever sent to the address typed (it is only the operator notice's `Reply-To`); `support_anon_ip` 3 a client address a UTC day, keyed by an HMAC of the IP under `COOKIE_SECRET` (no raw IP is stored); `support_anon_all` 50 signed-out reports a UTC day in total (429 `support_closed`: the form says to email the contact address); a filled honeypot is answered 201 and dropped; a form sent under 3 seconds is 400 `too_fast`. No third-party script (#134)",
        "`POST /api/support` (session cookie only, never MCP; any signed-in person, with or without an org): zod-validated (`shared/support.ts`, values in the zod-free `shared/support-core.ts`), the reporter is the session's person, the org is kept only if the caller is a member of it, and it takes one unit of the new `support` limit (10 a person a UTC day; 429 with `Retry-After`) (#134)",
        "Migration `0049_support_reports`: the GLOBAL table `support_reports` (kind, subject, message, `reporter` or \u2014 signed out \u2014 `contact_email`, exactly one of the two by a CHECK; `from_org` / `from_org_slug`, route, app version, user agent, `status` open | resolved, `resolved_by`, `resolved_at`, the mail outcome). `reporter` and `resolved_by` are in `HANDLE_COLUMNS`; the table is in `scripts/seed/reset.mjs` (#134)",
        "Platform \u203a Support (`web/src/platform-support.ts`): a tab with the count of open reports, a status `segmented()` and a kind `dropdown()`, a paged table (kind, subject, who, organization, when, status) and one report at `#platform/support/<id>` with the whole message, the attached context, the mail outcome, Resolve / Reopen and a Reply by email `mailto:`. A report sent signed out carries a SIGNED OUT badge and its typed address labelled unverified, and Reply by email uses it. Skeleton, error and empty states. Routes `GET /api/platform/support`, `GET \u2026/:id`, `POST \u2026/:id/resolve`, `POST \u2026/:id/reopen` (superadmin; 404 for anyone else) (#134)",
        "The support notice (`src/notifications/support.ts`): every report is mailed to `SUPPORT_NOTIFY_EMAIL` (var; unset = stored, not mailed, outcome `skipped`) in the shared email card, subject `[Trov bug] <subject>`, with a link to the report in Platform and `Reply-To` the reporter's provider-verified address (`OutboundMessage.replyTo` \u2192 Resend's `reply_to`). A mail failure never fails the submission; the provider key is scrubbed from the stored error before the cut (#134)",
        "`docs/architecture/support.md` (one row in CLAUDE.md's table); `test/support.routes.test.ts`, `test/render.support.test.ts` (#134)",
        "Empty layouts: a screen that has loaded and holds nothing draws its own shape empty instead of one centred line. ONE helper, `emptyLayout(key, { text, action, shapes })` beside the skeleton helpers in `web/src/skeleton.ts` (`emptySay`, `emptyShapes`, `CONNECT_AGENT`): one sentence, at most one action, and the SAME shape builders the loading skeleton uses, drawn hollow and still (`.cnpy-empty*` in `trov.css`: a hairline outline for a bar, a dashed outline for a card, no fill, no animation), `aria-hidden` (#134)",
        "Empty layouts on My Work's four tiles, the Tickets board and table, Roadmap › Narrative (the narrative, the sprint cards, Recent happenings) and Timeline, a sprint's ticket grid, the Feed and its two aside boxes, the Docs tree and reader, Artifacts, Handoffs, the Prompt Library, Review, Unplaced, the Repo dashboard with no repository (its tab bar and every section's chrome, pointing at Preview with sample data), and Org settings' and Platform's lists (`orgEmpty`, `emptyCard`) (#134)",
        "The state preview: `?preview=empty` or `?preview=loading` on any app address (`/<org>/?preview=empty#tickets`) paints every screen's empty layout or loading skeleton whatever the organization holds. `web/src/preview.ts` projects the state at render time (`previewState`, `shownState` in `render.ts`), so the real state is never touched; a banner (`previewBanner`, `.cnpy-preview`) says which state is on, switches to the other and closes it (#134)",
        "While a preview is on, `web/src/api.ts` refuses every request that is not a GET before it leaves the browser (`setWriteBlock`, `PreviewBlocked` in `call`, the one sender) and a toast says nothing was changed (#134)",
        "`test/render.empty.test.ts`: the helper's contract, the CSS that tells empty from loading, every screen in four states (loading, empty for a member, empty for an admin, with data), that no shape holds text, a control or a status colour, and the preview (no organization data on any screen, the real state untouched, writes refused) (#134)",
        "`STRIPE_TAX` (var): `on` makes a checkout send `automatic_tax[enabled]`, `tax_id_collection[enabled]` and, for an existing Stripe customer, `customer_update[address|name]=auto`. Stripe charges tax only where the account holds a registration; Trov computes none (`src/billing/config.ts` `tax`, `startCheckout`) (#134)",
        "`.site-banner` (`web/src/trov.css`): the first-run card's banner as ONE definition with `.cnpy-orgs-banner` (gradient, dot grid, the faint tilted mark as `.site-banner-art`), used by the landing's hero, the authority card (`.site-split`) and the sign-in dialog; a step deeper on the dark theme (#134)",
        "`.site-stage`: every tour mockup stands on a field of the banner's dots in the page accent, mirrored on flipped rows. Static paint only: no `filter`, no `backdrop-filter` (#134)",
        "`test/render.landing.test.ts`: open sign-up wording, the Guide (never Get Started), the three banners, `data-morph` / `data-overlay`, and both reduced-motion rules (#134)",
        "The tour is explorable: `featureDialog` in `web/src/landing.ts` (a root-level `data-overlay=\"feature\"`, `role=\"dialog\"` `aria-modal`) drawn from `state.siteFeature`, and `web/src/site-feature.ts` for opening, stepping, closing, Esc / arrow keys, the Tab trap, focus return and the scroll lock. Acts `openFeature` / `stepFeature` / `closeFeature`. Each tour row has ONE labelled control (Explore); the mockup is the same action for a pointer (#134)",
        "The card grows into the dialog through a View Transition (`view-transition-name:site-fx`, rules scoped to `html.site-fx-vt` so the first run's morph is untouched); without View Transitions or in a hidden tab it plays a keyframe entrance and exit instead (`data-in`, `data-closing`); under reduced motion it is instant (`fxMode`) (#134)",
        "`web/src/landing-mocks.ts` (`featureMock`): the dialog draws each of the seven screens at its own size from the real renderer — Docs (tree, outline, the STAGED banner, Version history), Feed (For reading / For agents, briefs, PR / commit / issue chips, This week, Waiting on review), Tickets (the five-status board over the table grouped by sprint), Roadmap \u203a Timeline (legend, summary strip, lanes, Ready and Overdue), My Work (the four tiles), Handoffs (the two sections and \"Where it stands\"), Artifacts (version menu, Draft / Published / Ratified, Linked work). Inert (`aria-hidden`, nothing focusable), theme tokens only, no zoom; ticket and artifact statuses come from `shared/`; a test pins every other label to the module that renders it (#134)",
        "`TOUR_FACTS`: three or four statements per feature, each taken from Help \u203a Guide; `test/render.site-feature.test.ts` pins a phrase of every one to `guideView` (#134)",
        "One motion clock on `:root`: `--fx-ease` (`cubic-bezier(0.4, 0, 0.2, 1)`), `--fx-fast` .18s, `--fx-base` .24s, `--fx-slow` .3s. The dialog, the tour cards, the scroll reveals and the mockups' checks, bars and swaps all read it; only transform and opacity move in the dialog, and `will-change` is set only while it moves (`data-moving`) (#134)",
        "An MCP connection has a MODE (`oauth_grants.mode`, migration `0051_mcp_connection_orgs`): `manual` (a set of allowed organizations in the new tenant table `oauth_grant_orgs`, acting in its current one, `oauth_grants.org_id`) or `repo` (it follows the repository; `org_id` is ''). `src/data/bearer.ts` is the one place a call's organization is decided (`resolveBearerConnection`, `resolveCall`, `admitCall`, `switchOrg`), always among `liveTenants`: the person's live memberships of orgs that are not suspended (#134)",
        "Every MCP tool takes optional `repo` (`owner/name`, or what `git remote get-url origin` prints: `shared/repo-ref.ts` `normalizeRepoRef`) and `org` (a slug). A repo connection resolves `repo` among the person's organizations that have it in `org_repos` (manual or App, no case, not `access_lost_at`): one is used, none is `not_connected` (the same bytes for an unknown repository and one connected only where the person is not a member), several is `ambiguous_org` settled by `org`, no `repo` is `repo_required`. A manual connection acts in its current organization, `org` picks another allowed one for one call (`org_not_allowed` otherwise), and a current organization that dropped out is `org_unavailable`, never a fall-through (#134)",
        "MCP tools `get_connection` (handle, mode, the organization this call would act in and the role there, the current organization, what the connection can reach, `unresolved`) and `switch_org` (a manual connection's current organization, only among those already allowed). Adding an organization is not a tool (#134)",
        "The consent page asks how the connection picks an organization: Follow the repository (preselected with several organizations) or Manual (a tick per organization, all ticked up to `CONSENT_TICK_ALL_MAX`, and which one it starts in). No script: `:has()` shows and hides the list. A missing tick or start re-renders the page with the reason. The page says \"Signed in as <name> (@handle)\" above the choice, with \"Not you? Sign out\" (`POST /oauth/switch-account`: the consent CSRF value, ends that session, 303 back to the same authorize URL) (#134)",
        "Settings › MCP access: each connection shows its scope (`grantScopeChip`) and a \"Change organization\u2026\" button that opens `grantScopeDialog`, a root-level `data-overlay=\"grant-scope\"` in the `.cnpy-cmodal` shell (a bottom sheet on a phone), never a panel under the row: the mode as a `segmented()` with what it does, and for Manual a `dropdown()` for the organization it is working in and a switch per organization. Changes save as they are made and the dialog says saving / saved / refused (a plan limit on that organization's row); Escape, the backdrop and Done close it, Tab stays inside, focus returns to the row's button. The tile names the account connections land under. `POST /auth/oauth-grants/:id/orgs`, `/current`, `/mode` (session cookie, own grant only, organizations bound through `resolveTenant`; 404 for anything else) (#134)",
        "`test/mcp.connection-scope.test.ts`: both modes end to end over consent, the token endpoint, `POST /mcp` and the Settings routes (#134)",
      ],
      changed: [
        "`agent_connections` counts a connected app once in every organization that holds an `oauth_grant_orgs` row for it: a manual connection in each organization it is allowed (consent, and adding one in Settings, go through `requirePlan` there), a repo connection in each organization it has been used in (its first call there goes through `requirePlan`; `plan_limit` and nothing read). A revoked grant holds no row (the trigger) (#134)",
        "A pasted token or a one-organization connection that names ANOTHER organization in `org` is refused (`org_not_allowed`) instead of being answered from its own; `repo` is ignored by both (#134)",
        "`removeMember` drops each of the person's connections' rows for that organization and revokes a manual connection left with none; one that can still act elsewhere lives on. The token endpoint's standing check (`GRANT_STANDING`) is over every organization the grant can reach (#134)",
        "MCP usage: a tool call is counted in the organization it resolved to (`meterMcpTool`, `mcp_request` + `mcp_tool:<name>`), a request with no tool call in a manual connection's current organization, an unresolved call nowhere. `update_plan` is listed when the person is an admin in any organization the connection can reach and is `forbidden` where they are not (#134)",
        "Trov plugin 0.8.0: every skill passes `repo` on each call and says what to do on `not_connected` / `ambiguous_org` / `org_unavailable`; `load-context` starts with `get_connection` and states the organization; the `trov` skill documents both modes and `switch_org`, and no longer tells a person in two organizations to add the server twice (#134)",
        "`GET /auth/oauth-grants` rows carry `mode`, `org` (a manual connection's current organization, or null) and `orgs`; `ONE_ORG_NOTE` is now `CONNECTION_NOTE` (#134)",
        "My Work always shows its five tiles: Tickets for you used to leave the grid when nothing was assigned (and Your sessions took the full row); it now stays at 7 | 5 and draws its rows empty, so a tile never appears or leaves when a count crosses zero (#134)",
        "Empty-state wording no longer claims work that did not happen: Review's \"Everything an agent produced has been reviewed\" and Unplaced's \"Everything an agent produced found its place on its own\" are now \"Nothing is waiting for review…\" and \"Nothing is unplaced, which is this queue's normal state…\"; the Tickets queue, the Feed and Docs show \"nothing matches\" only when a filter or search is on (`queueNarrowed`) (#134)",
        "The Repo dashboard with no repository keeps its tab bar and panel (it was one dashed card): `sec()` has a `blank` phase that draws each section's bars empty. Preview with sample data is its action for everyone; an admin also gets Open Org settings › Repositories. My Work's Repo tile says no repository is connected instead of holding a skeleton (#134)",
        "The Artifacts library's toolbar (search, Filter) is real while its first read is out; only the card grid is a skeleton, and no count is claimed until the list lands (#134)",
        "Each screen's loading skeleton and empty layout share one shape builder (`tableShapes`, `boardCardShapes`, `feedCardShape`, `sprintCardShape`, `timelineShapes`, `handoffRowsShape`, `promptCardShape`, `libraryCardShape`, `reviewCardShape`, `unplacedShapes`, `skRowsShape`), so the two cannot drift apart (#134)",
        "Privacy \u203a What we collect names bug reports and support messages, signed in and from the site's Contact form: what is stored and who reads it (#134)",
        "Pricing cards climb: Free is a plain card, the accented plan is lit in the accent with a filled badge, and the top plan (Enterprise) wears the site banner (`.site-plan.is-top.site-banner`) with a white button; every limit has a square bullet, cards lift 3px on hover, and the edge is a ring in the shadow, not a border (#134)",
        "Tour dialog mockups: the Feed's aside is 244px (was 190px, which wrapped \"This week\"); My Work's four tiles fill the window as one rectangle (`.fxm-mywork`, two equal rows); the artifact in Artifacts is drawn as its own page in fixed colours and a serif (`.fxm-art*`: the 429 response and the budget), so it reads as a document inside Trov (#134)",
        "Terms and Privacy (`web/src/legal.ts`): a new Terms section 3 \"Plans, payment and cancellation\" (numbers from `shared/plans.ts` / `shared/pricing.ts`), a liability cap, Stripe as a processor, billing data, retention and Stripe's cookies in Privacy; `updated` is 2026-10-09 and later Terms sections are renumbered (#134)",
        "The legal pages open on the site banner (`.site-legal-band`) with a Terms / Privacy switch, an \"In short\" box (`LegalDoc.brief`), and the contents riding beside the text: a link glides to its section, and the section in view is marked by colour only, so its line never re-wraps (`web/src/legal-page.ts`); under 900px the contents are a box above the text (#134)",
        "The payment confirmation card is the organization picker's width (the 520px override is gone), so the morph between them changes height only and no longer crops both faces sideways (#134)",
        "After payment the card STAYS on \"Payment received\" with its one button (it is the confirmation; it used to jump on at once), and the org picker it leads to no longer opens the Create an organization dialog by itself: the paid-for organization is one of the things to do there. Its button is the size of its label and goes on IN PLACE (`billingSetup`: the card morphs into the picker; it used to load `/?setup=…`) (#134)",
        "Get started: either plan is one line (\"$10 per seat / month · up to 50 people\"), with the pricing link in the lede (\"Pick a plan to start, or compare them.\") and Pro shows the same two provider buttons with no note under them, so the dialog is the same height on both; the card is 380px (#134)",
        "Sign in and Get started open ONE dialog that says which the visitor came for (`SignInMode`, `state.signInMode`), with a switch in its foot between the two. Get started (the nav's accent button and the hero's) opens on a choice of plan (`planChoice`, `state.signInPlan`): Free, then the two providers; or Pro, then the same two providers as links to the billing route with the provider picked (`&via=`), so signing in carries on to payment — shown only while Pro can be bought, with every word and number from `shared/plans.ts` / `shared/pricing.ts`. The nav's Sign in is a quiet button beside it (#134)",
        "Sign-in dialog: a plain card with the mark, the title and the two providers (the neutral solid GitHub button, both reading Continue with …) as a narrow centred pair with an \"or\" rule between them — no banner of its own, since it opens over the hero's. Bannered cards (the first run's, the \"Agents propose\" card) have no border, so no pale frame shows round the banner; their edge is a ring in the shadow (#134)",
        "Dark theme: the banner is a deep olive of the dark accent (the green mark), not purple, on the landing page and the first-run cards alike (one rule); the glows behind the cards take `--mark` from the theme (#134)",
        "The landing is `data-morph=\"landing\"` and the sign-in dialog one root-level `data-overlay=\"signin\"`, so `paint()` patches the page in place when the dialog opens or closes instead of rebuilding it (#134)",
        "Hero: left-aligned on the banner; the first button is Start for free (`openSignIn`) signed out and Open the Guide (`siteGuide`) when reopened from the app; a line under it states open sign-up and links `/pricing` (#134)",
        "Security's first line now reads \"Anyone can sign up with GitHub or Google. An organization's content is open only to its members.\" (was \"restricted to your org\") (#134)",
        "Reveal keys: `authority-copy` / `authority-card` are one `authority`; a tour mockup's reveal is its stage (`<key>-mock`) (#134)",
        "For agents: the plugin card shows `connectSteps()` and `ONE_ORG_NOTE` from `web/src/mcp-connect.ts` (the commands are no longer retyped in `landing.ts`); the row is two weighted columns (`.site-agents-row`, 1.65fr / 1fr) whose cards are the same natural height (#134)",
        "Scroll reveals travel 6 to 14px (were 12 to 56) over `--fx-slow`, start 6% of the viewport before the element enters, and are settled with no motion while a nav jump is in flight (`noteJump`, `revealClass` in `web/src/landing-motion.ts`); tour mockups start their contents at 160 ms (was 380) (#134)",
        "Nav jumps land the section heading about 32px under the sticky nav (`scroll-margin-top:-58px` on `section[id^=site-]`) (#134)",
        "Redundancy pass on the landing copy: open sign-up is said once (under the hero buttons); the sign-up clause left Security and the dialog foot; Security's person-only line now covers decisions, artifacts and prompts, and the same claim left the Artifacts row, the Decisions card and the Prompt Library card; the loop's lede, the authority card's second sentence, the plugin card's \"installed in two commands\" and the hero's pricing link and Free-plan claim are gone; the hero button is Start for free, the plan card's own label (#134)",
        "The tour's small Tickets mockup uses the board card's real parts (`#id \u00b7 High|Low`): the invented `P0` / `P2` chips and comment count are gone. Docs' fourth dialog fact is now \"New doc lets you propose one yourself.\" (the labels new / edit / rewrite live on Review, not Docs) (#134)",
        "Dark theme: the sign-in and feature scrims dim with the page's warm black, and the dialog and hero-mockup shadows are neutral (were blue-black) (#134)",
        "Docs corrected to match the code, no behaviour change: `docs/architecture/env.md` now lists every name in `Env` (the Stripe names and `TROV_KEK` were missing); `repo-dashboard.md` describes the per-org repo cron and its 900-request budget; `notifications.md` (the welcome mail on a first membership, the outbox key with its org, the per-org policy seed), `feed-and-search.md` (`query` types: `artifact`, not `ticket`), `ingestion-gate.md`, `roadmap-my-work.md`, `data-layer.md` (open sign-up), `auth-identity-people.md`, `tickets.md`, `layout.md`, `docs/artifact-contract.md` (links carry the organization) and three sentences of `CLAUDE.md`; `HANDOFF.md` is rewritten as the current deploy runbook (#137)",
        "Trov plugin 0.8.1 (skill text only): a sprint's `progress` is its tickets alone and its GitHub issue counts are the separate `issues` field; any member completes a sprint; connecting is browser sign-in, with no pasted-token setup step (`trov`, `read-plan`, `update-plan`) (#137)",
      ],
      fixed: [
        "A NEW account that signed up to buy Pro was taken through the first run and never reached checkout: `POST /auth/onboard` handed back the purchase path, but the SPA followed only an MCP authorize link. It follows `signInReturnPath` (`shared/billing.ts`: an authorize request or a purchase link, nothing else), and the purchase path's shape is defined once (`isBillingStartPath`) for the Worker's return allowlist and the SPA alike (#168)",
        "A first-run card morphing into the organization picker landed on the picker's short \"Loading…\" card and then snapped to full height when the list arrived (squeezed, then stretched) — after the handle step and after payment alike. The list is read first (`morphToPicker`, `web/src/main.ts`), so the card morphs once, to its real size (#134)",
        "Opening the sign-in dialog rebuilt the whole landing page, restarting the terminal carets and cutting any reveal in flight (#134)",
        "Org settings › Notifications showed \"No sends yet\" and an Outbox count of 0 until the outbox's first read landed. It is a skeleton until then (`outboxLoading`) (#134)",
        "The Prompt Library with no prompts read \"No prompts match\" with a Clear filters button, as if a search were hiding them (#134)",
      ],
      removed: [],
    },
    prs: [134, 137, 168],
  },
  // The guided first-run setup: a new owner, admin or member is walked through it instead of landing on a checklist or an empty feed (#121).
  {
    version: "0.24",
    date: "2026-10-08",
    title: "A guided setup",
    headline: "Create an organization or accept an invitation, and Trov walks you through what to do first.",
    highlights: [
      "A new organization opens on a guided setup: connect the repository your team ships from, connect your coding agent, invite your team. One step at a time, each one skippable, with Back always there.",
      "Connecting your coding agent is now part of getting started. The setup shows the two commands to run, with a Copy button, and notices by itself when your agent is connected.",
      "Accept an invitation and you land on a short setup of your own: connect your coding agent, then see where the Feed, Docs, Tickets and Roadmap are.",
      "Signed in with Google? The setup says to link your GitHub account before connecting a repository, takes you there, and brings you back to the same step.",
      "The setup can be reopened at any time, from Help › Get Started, from search, or from Org settings while steps remain. It always shows what is really done.",
      "Trov can give an organization a plan for free for a set time. Org settings › General says until when, and what happens after: the organization moves to Free and nothing is deleted. Its owner can start paying before then to keep a paid plan.",
    ],
    headsUp: [
      "Creating an organization no longer opens Org settings, and accepting an invitation no longer opens My Work: both open the guided setup. Skip setup takes you straight in.",
    ],
    ops: [
      "Migration `0048_plan_gifts` (additive: `orgs.plan_gift_until`, `org_grants.gift_days`, one partial index) is applied by the merge to `main`. Nothing existing changes: no org or grant has a gift until a superadmin gives one.",
      "No new cron and no `wrangler triggers deploy`: a gift's end is checked on the repo cron's existing 10-minute tick, so an organization moves to Free within about ten minutes of its gift ending.",
    ],
    patches: {
      added: [
        "Cancel plan (Org settings › General and Settings › Plan, an owner of a paying org): `POST /api/o/:slug/billing/portal { cancel: true }` opens Stripe's portal on the subscription's cancel flow (`flow_data.type = subscription_cancel`) and returns to Trov when it is done. Cancelling inside Manage billing ended on Stripe's confirmation page with only a back link (#134)",
        "`GET /billing/start` no longer has a sign-in page of its own. A signed-out buyer who already picked a provider (`&via=github|google`, `billingViaHref`: the Get started dialog's Pro buttons) goes straight to that provider with the purchase sealed to return to; one who has not is sent to the landing page, which opens Get started on that plan (`billingAskHref`, `/?start=team`) (#134)",
        "`scripts/dev/stripe-standin.mjs`: a local stand-in for Stripe (the API calls billing makes, a checkout page, a portal, signed webhooks) for walking the paid flows with no Stripe account; `.dev.vars.example` says how (#134)",
        "Personal Settings shows the PLAN of the organization on screen (`web/src/settings-plan.ts`): a Plan tile (whose plan, its name, the price it is actually charged from `shared/pricing.ts`, the gift / renewal / past-due sentence, and for an owner the Plan block's own `orgBilling…` buttons: Upgrade to Pro, Change seats, Manage billing, Keep Pro by paying; anyone else reads who can change it and a link to Org settings › General) and a Limits tile (every limit as used of limit with a meter; an unread number is a dash, never 0). Same read as Org settings (`GET /api/o/:slug/plan`), same words (`planParts` in `org-plan.ts`) (#126)",
        "Settings › Organizations: every organization you belong to with your role and its plan, each a link that opens it; who pays is said only for an org on a live subscription; Create organization when you may, else the sentence saying why not. `GET /api/orgs` and `/auth/me` now carry `plan` and `paid` on each org (`listMyOrgs`) (#126)",
        "Settings › Session: who is signed in and a labelled Sign out button with its icon, in a tile of its own at the top right (last on a phone) (#126)",
        "`GET /api/orgs/slug-check?slug=`: is an organization handle free (`{ available, reason?: invalid | reserved | taken }`, `orgSlugAvailable`), capped by the `handle_check` allowance. The create dialog asks as the person types and shows checking / available / taken beside the field (#124)",
        "`firstRunBackdrop()` in `web/src/render.ts`: behind a first-run card, the real app shell in its loading (skeleton) state, inert and softened (`.cnpy-fr-bg`). Used by onboarding, the org picker and the guided setup (#124)",
        "`morphStep` (`web/src/transition.ts`): one step of a flow morphs into the next through a View Transition; the first-run card keeps one `view-transition-name`, so cards of different heights grow into each other. Off under reduced motion (#124)",
        "Back in the sign-up flow: from \"how you'll appear\" to sign-in, and from the welcome card back to \"how you'll appear\", which then edits the account (`updateMe`, `renameHandle`) (#124)",
        "`#welcome[/<step>]` (`web/src/welcome.ts`, `welcome-actions.ts`): the guided first-run setup, a full page without the sidebar. An owner or admin gets repository → coding agent → team → done; a member gets coding agent → done. No migration and no new route: it is entered by navigation and is stateless (#121)",
        "Every step's state is derived from reads the SPA already makes (`githubStepState`, `agentStepState`, `teamStepState`): Org settings' slices, `GET /auth/oauth-grants` filtered to the org on screen, and the org's MCP tokens. A read that is out or failed is `unknown`, never done or to-do (#121)",
        "The agent step re-reads `GET /auth/oauth-grants` every 5 s while it is on screen, not yet connected and the tab is visible, and at once when the tab regains focus (#121)",
        "`WELCOME_RETURN_KEY` (sessionStorage): leaving the setup to link a GitHub account or to connect the GitHub App notes it, and `enterOrg` lands that one return (`/#settings`, or `?github=…#org/repos`) on `#welcome` instead (`welcomeReturnHash`) (#121)",
        "`web/src/mcp-connect.ts`: the plugin install commands, the by-hand command and the three sign-in steps (`connectSteps`), shared by Settings › MCP access and the setup (#121)",
        "\"Open the guided setup\" on Org settings' checklist and on Get Started; \"Guided setup\" in quick search (#121)",
        "A plan as a GIFT (`src/plans/gifts.ts`, `0048_plan_gifts`): Platform › an organization › Plan has **Gift a plan** (plan, optional seats, 1 / 2 / 3 / 6 / 12 months or a date) — `PUT /api/platform/orgs/:slug/plan { plan, overrides?, gift: { days } | { until } }` — then \"Gifted until <date>\" with **Extend** (`POST …/gift/extend`) and **End now** (`POST …/gift/end`). Superadmin only, audited as `plan.gift` / `plan.gift_end`; 409 `billed` for an org on a live subscription (#123)",
        "`expireGifts` runs on every tick of the repo cron: an org whose `plan_gift_until` has passed moves to Free (Free, active, overrides cleared, nothing deleted) in one guarded statement per org, audited by `system`. Idempotent; an org that pays through Stripe only has the lapsed gift cleared (#123)",
        "Platform › Access › Grant an organization takes an optional **Free for** (`gift_days` on `POST /api/platform/grants`): the clock starts when the grantee creates the organization, whose `plan_gift_until` it becomes. The grant's notice mail, the picker and the create dialog say so (#123)",
        "Org settings › General › Plan shows \"Free until <date>, a gift from Trov. After that this organization moves to Free; nothing is deleted.\" (`OrgPlanView.gift_until`), as the amber note in its last 7 days; the owner gets \"Keep Pro by paying\" where billing is set up (#123)",
      ],
      changed: [
        "Pricing: the \"Limits, side by side\" table. Each plan card already lists every limit; its one footnote (which plans' limits can be set per organization) sits under the cards (#134)",
        "Pricing › Questions is an accordion: each question a native `<details>`, the first open, one open at a time; the heading sits in a left column and the accordion in the right (`.site-faq-wrap`). `web/src/site-faq.ts` animates the answer's box open and shut with the Web Animations API (CSS cannot animate a `<details>` in most browsers): one duration and curve for the box that opens and the one that closes, a mid-flight click reverses from where the box is, off under reduced motion (#134)",
        "The page Stripe returns a buyer to (`/billing/done`, `billingDonePage`) is the first-run card: the banner with what is happening, the body with what to do, a foot, in front of the app's backdrop — a step before naming the organization, no longer a small card on a blank page. It is `data-morph`, so the two-second poll patches it in place. The Worker-rendered pages around it — the billing route's sign-in and notices (`src/billing/pages.ts`) and Connect an app (`src/auth/oauth-pages.ts`, one shared shell) — are the same card too: the purple banner with the title and the faint mark, the body, a foot strip (#134)",
        "Personal Settings is a twelve-column bento whose tiles are as tall as what they hold: Profile | Account | Session over Appearance, then Plan | Limits, Organizations, MCP access, Email. Profile and Account no longer stretch to the MCP tile's height (they were 55px and 30px taller than their content at 1440px); Account is the sign-in methods only, and says why the last one can't be unlinked; Appearance drops its hint line (it is the System card's tooltip) (#126)",
        "Personal Settings is patched in place (`data-morph=\"settings\"`): typing in the name, handle or digest-address field no longer rebuilds the page (#126)",
        "Opening Settings reads the org's plan alone (`orgCtl.loadPlan`, act `orgPlanReload`) and re-reads `GET /api/orgs`, not Org settings' other slices (#126)",
        "Every email's banner takes the shape of the app's first-run card (`emailBanner` in `src/notifications/assemble.ts`): the brand top left, a label top right, and the mail's headline reversed out of the purple band, over a gradient and a large faint mark. The invitation, welcome and grant mails move their headline into it; a digest keeps its \"Daily digest · date\" line there. Each layer degrades alone (solid band without gradients, no faint mark without `rgba`) (#127)",
        "Org settings › Members: the members are a table (`.cnpy-mem-row`: member, handle, title, joined, role, Edit), one grid for the head and every row; the invite bar spans its surface instead of stopping at 820px; the email invite's help line no longer says a Google account must be invited first (#128)",
        "Help › Get Started is now Help › Guide, titled How Trov works: a reference, not a second onboarding. The numbered Sign in / Connect your agent / Learn the skills steps are gone; the skills come first, then how review works and the tour, then Accounts and organizations and Connecting a coding agent as reference sections. Its sign-in facts match open Google sign-up (#124)",
        "The guided setup closes with Your first session (three lines: start as usual, work, say record this session) and a link to the Guide, in place of the four Where things live cards, which repeated the sidebar (#124)",
        "The welcome e-mail opens the guided setup (`/<org>/#welcome`), where a new person now begins, not the Guide (#124)",
        "The sidebar is 228px wide expanded (was 244px; `.cnpy-aside` in `trov.css`), the narrowest width at which no label, count, search hint or account chip truncates. The collapsed rail (64px) and the phone drawer are unchanged (#125)",
        "The menu the org switcher opens is 248px wide (was 316px; `.cnpy-orgmenu`). The switcher itself still fills the sidebar's row whatever the name (#125)",
        "Signing up counts its steps in the top right of each card: Step 1 of 3 (how you'll appear), 2 of 3 (an organization), 3 of 3 (the guided setup, only when it ends a sign-up: `FIRST_RUN_KEY` in sessionStorage). The setup's eyebrow names the organization and no longer carries a second count (#124)",
        "The guided setup is the same bannered card as onboarding and the org picker, in front of the same backdrop; finishing onboarding goes on to the welcome card without a page load (#124)",
        "Onboarding (pick a handle and a color) is the same bannered card as the org picker that follows it, with the handle and display name side by side and the colors on one line; it no longer scrolls the page (#124)",
        "Create an organization: the Address field is called Handle (it is still the slug, the `/<slug>/` its links start with), and its messages say handle (#124)",
        "The org picker / first run is one card in the middle of the window: a purple Trov banner (the mark, the welcome, what Trov is), the things to do, and who is signed in (`.cnpy-orgs-card`, `-banner`, `-body`, `-foot`). A first run no longer scrolls the page (#122)",
        "Org settings › Notifications: the digests are a grid of tiles, two to a line (`.cnpy-digests`), one to a line at phone width; each tile holds the name, the default cadence beside its org-wide switch, and what it carries (#122)",
        "`createLanding` / `acceptLanding` (`web/src/org-picker.ts`): creating an organization lands on `#welcome` (was `#org`); accepting an invitation lands an owner or admin on `#welcome` and a member on `#welcome/agent` (were `#org` for an owner, My Work for anyone else) (#121)",
        "Members' invite form is `inviteSection` (`web/src/org-settings.ts`), rendered by the Members tab and by the setup's team step, so both obey the same seat gate (#121)",
        "`POST /api/o/:slug/billing/upgrade` also accepts an org whose plan is a gift (was 409 `not_free` for anything but Free): its owner starts paying before the gift ends, and fulfilment clears the gift. Every `setOrgPlan` without `gift_until` clears a gift, so Change plan on a gifted org makes the plan permanent (#123)",
      ],
      fixed: [
        "Every email came out 680px wide on a phone: the card was a `width=\"680\"` table, which cannot shrink whatever its `max-width`. The card is now fluid up to 680px (`emailCardOpen`, with a fixed-width wrapper for Outlook only), and at phone width the gutter tightens, the banner's faint mark makes room and the headline steps down (`EMAIL_MOBILE_CSS`) (#130)",
        "Open Trov at the end of the guided setup loaded My Work again and replayed its entrance. Behind the setup's card is now the real My Work of that organization, read while the person is in the setup; leaving removes the card with no entrance, no skeleton and no request (#124)",
        "A first-run card lost its shadow while it morphed into the next step and got it back with a pop: the moving box clips its faces, shadow included. The moving box now carries the card's shadow itself (`::view-transition-group(first-run-card)`) (#124)",
        "The app behind the guided setup replayed its page entrance on every step: the backdrop is the app's own markup, and each step re-arms `[data-enter]` on the root. Nothing inside `.cnpy-fr-bg` animates or transitions now (51 animations per step before, 0 after) (#124)",
        "Creating or joining an organization from the first-run picker reloaded the page before the guided setup. A page that has held no organization's data now enters the new one in place (`enterNew`), and the card morphs into the setup; from inside another organization it is still a page load (#124)",
        "Each step of the guided setup made the app behind the card vanish and fade back in: `syncSkeletons` gave the backdrop's skeletons a loading clock, reset on every step. Skeletons inside an `inert` region are a picture and are skipped (#124)",
        "Typing in a first-run form or in Create an organization rebuilt the whole page behind it on every letter (`paint()` swaps any page that does not set `data-morph`). Onboarding, the org picker and the guided setup are now patched in place; the rule is in `docs/architecture/web-ui.md` (#124)",
        "Finishing onboarding left a new person on the handle card: `/#onboard` to `/#guide` is a same-document navigation, so nothing loaded. The page now reloads once the account exists (#122)",
        "Org settings › General lines up with the tab bar and the other tabs: its 640px column (`.cnpy-org-narrow`) is now a bento grid across the tab (`.cnpy-org-gen`: image + name, plan, slug, and the plan's limits as their own tile), folding to one column by container width (#122)",
      ],
      removed: [],
    },
    prs: [121, 122, 123, 124, 125, 126, 127, 128, 130, 134],
  },
  // Free and per-seat Pro: self-serve Free organizations, Team renamed Pro and sold per seat, a downgrade to Free (#117).
  {
    version: "0.23",
    date: "2026-10-08",
    title: "Free, and Pro per seat",
    headline: "Anyone can start a Free organization, and Pro is paid per seat: as few as one.",
    highlights: [
      "Sign in with GitHub or Google (either one creates your account, no invitation needed) and create a Free organization for your team: up to 3 people, one repository, two environments and 300 AI summaries a month. You can own one Free organization at a time.",
      "Team is now called Pro, and it is paid per seat: $10 a month for each one, with no minimum, so a person on their own can buy a single seat. Pro holds up to 50 people.",
      "Upgrade a Free organization to Pro from Org settings › General. The checkout starts with one seat for each member and pending invitation, and you can change the number before you pay.",
      "When every seat is taken, Members says so and gives the owner one button: Add a seat on Pro, or Upgrade to Pro on Free.",
      "The pricing page shows Free, Pro and Enterprise, with what each one includes and how per-seat pricing works.",
      "Pages no longer jump when they load. While a screen waits for its data it shows the outline of what is coming, in the same place and at the same size, and the content then fills in where the outline was.",
    ],
    headsUp: [
      "The seats an organization pays for are the seats it has. Removing a seat in Stripe leaves everyone in place; new invitations wait until the organization is back under.",
      "If a Pro subscription is cancelled, the organization moves to Free when the paid period ends. Nothing is deleted and everyone keeps reading; adding more of anything over a Free limit is refused until the organization is back under or upgrades again.",
      "Personal is no longer offered. An organization already on it keeps its plan.",
      "AI summaries read at most the first 8,000 characters of a pull request's or issue's description.",
    ],
    ops: [
      "Google sign-in needs its OAuth client on the Worker: `wrangler secret put GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, with `https://<host>/auth/google/callback` as an authorized redirect URI in Google Cloud. Without them `/auth/google/login` answers 503.",
      "Apply migration `0047_billing_seats` (additive: the nullable column `billing_subscriptions.quantity`). Safe on live data and with the previous Worker running; rollback is in its header.",
      "Stripe: create ONE product, Trov Pro, with a recurring PER-UNIT price of $10 per month (and optionally a yearly one). Put its id in `wrangler.toml` `[vars]` as `STRIPE_PRICE_TEAM` (and `STRIPE_PRICE_TEAM_YEARLY`). `STRIPE_PRICE_PERSONAL` and `STRIPE_PRICE_PERSONAL_YEARLY` are gone: delete them from any dashboard config. `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are unchanged secrets.",
      "In Stripe's Customer Portal settings, allow customers to update subscription QUANTITIES for the Pro price (minimum 1, maximum 50) — \"Add a seat\" opens that page. The webhook's event list is unchanged.",
      "The pricing page now announces Pro at $10 per seat and links \"Choose Pro\" to checkout. Set the Stripe keys and the price before (or with) this deploy, or that link answers \"Paid plans are not available yet\".",
      "Self-serve organization creation is ON (issue #94): any signed-in person may create one Free organization they own. `docs/architecture/abuse-limits.md` lists what bounds it.",
    ],
    patches: {
      added: [
        "Plan `free` in `shared/plans.ts` (3 seats, 1 repository, 2 environments, 250 MB, 5 agent connections per person, 300 summaries a month); `FREE_PLAN`, `UPGRADE_PLAN`, `OFFERED_PLAN_IDS`, `isSoloPlan` (#117)",
        "`PlanDef.features` and `FEATURE_KEYS` (empty: nothing is gated yet), `planFeatureRefusal`, and `requireFeature(ctx, feature)` beside `requirePlan` in `src/plans/gate.ts` — 402 `plan_feature` through `app.onError`, MCP code `plan_feature` (#117)",
        "`PlanRefusal.next`: `add_seat` (a paid Pro org's seat cap, below 50) or `upgrade` (any Free refusal); `planRefusalSentence` points an owner at it (#117)",
        "`src/plans/free.ts`: `POST /api/orgs` with no grant (or `plan: \"free\"`) creates a Free org; one OWNED Free org per person, held inside the creating batch by the `org.create_free` audit row; 403 `free_org_limit`. `GET /api/orgs` answers `free: { can_create, owned }` (#117)",
        "`POST /api/o/:slug/billing/upgrade`: a Free org (never paid, or its subscription ended) starts a Pro checkout for the same org, with its Stripe customer when it has one; 409 `not_free` (#117)",
        "`POST /api/o/:slug/billing/portal { seats: true }`: the portal's `subscription_update` flow for the org's subscription (\"Add a seat\", \"Change seats\") (#117)",
        "Migration `0047_billing_seats`: `billing_subscriptions.quantity`, so Platform's Follow subscription restores the paid seats; `PlatformOrgBilling.ended` and `seats` (#117)",
        "`moveOrgToFree` in the billing seam (`src/plans/billing.ts`) (#117)",
        "`capSummaryBody` / `SUMMARY_BODY_MAX` (8,000) in `src/tools/summarize.ts` (#117)",
        "`web/src/skeleton.ts`: the one loading-skeleton helper (`skeleton`, `skBar`, `skLine`, `skRow`, `skList`, `skCard`, `skRows`, `skForm`, `skTable`, `skDetail`). Every screen that waits on a read composes its loading state from it, in the screen's own frame: My Work's tiles, Feed and its aside boxes, Docs (tree and page), Roadmap (both tabs), the ticket board and table, a ticket, a sprint, Review, Unplaced, Search, Handoffs, the Prompt Library, Artifacts (library, viewer, comparison), every Repo section, Settings, Org settings, Platform and the org picker (#119)",
        "`syncSkeletons` (after every paint): each skeleton region keeps its clock across rerenders (`--skel-t`), stays invisible for its first 150 ms so a fast read never shows one, and what replaces it gets one short fade (`.cnpy-settle`). Off under reduced motion (#119)",
      ],
      changed: [
        "Google sign-up is open: `completeSignIn` sends any unknown Google account with a verified address to onboarding, as it does a GitHub account. The pending-invite gate (`hasPendingEmailInvite`, `OnboardPayload.invite_email`, 403 `invite_revoked` on `POST /auth/onboard`) is gone. An unverified address is still refused, now at `/?denied=unverified` (was `/?denied=invite`) (#120)",
        "Plan `team` is shown as \"Pro\", with 50 seats; `PURCHASABLE_PLANS` is `[\"team\"]`. Checkout sends quantity = members + pending invitations (at least 1; 1 for a first purchase) with `adjustable_quantity` 1–50 (#117)",
        "`src/billing/sync.ts`: the subscription's quantity is written as the org's `seats` override (`paidSeats`, held to the plan's cap); an unused paid grant carries it in its overrides and `linkPaidOrgStmt` copies them onto the org; an ended subscription moves the org to Free (active, still a billing org) instead of freezing it as `canceled` — a pinned plan too (#117)",
        "`OrgBillingView`: `subscribed`, `ended`, `customer`, `seats`, `upgrade_to` (was `renew_on`); a Free org gets one. The Plan block shows seats, Change seats, and Upgrade to Pro (#117)",
        "Platform's Change plan treats an ended subscription by its mirror (`ended`), not by the org's status; Follow subscription restores the paid seats. Platform's plan pickers hide Personal unless it is the current plan (#117)",
        "`shared/pricing.ts`: Free `price: 0`, Pro $10 per seat / month, Enterprise custom, Personal not self-serve; the pricing page shows offered plans only, a Free card that opens Trov, \"Up to 50\" seats on Pro, and per-seat answers in the questions (#117)",
        "The picker offers \"Create a Free organization\"; the landing's sign-in line and Get Started guide mention creating one again (issue #94) (#117)",
        "`DEFAULT_ORG_LIMIT` is 1: the Free organizations a person may own (#117)",
        "The return-to allowlist (`src/auth/return-to.ts`) is built from `PURCHASABLE_PLANS` (#117)",
        "The screen entrance (`[data-enter]`) belongs to the route: it plays once when a page opens and is no longer replayed when the page's read lands (`screenSettled` is gone from `main.ts`) (#119)",
        "Search keeps the results on screen while a new query is out instead of swapping them for \"Searching…\"; the ticket queue, Review and Unplaced keep their toolbar and frame while loading; `loadingNote` (`org-ui.ts`) and Platform's `loadingLine` render skeleton rows and keep \"Loading <what>…\" for screen readers (#119)",
      ],
      fixed: [
        "A one-seat paid Pro org is not a one-person plan: Members keeps the invite section with \"Add a seat\", and the setup checklist keeps \"Invite your team\" (#117)",
      ],
      removed: [
        "`STRIPE_PRICE_PERSONAL`, `STRIPE_PRICE_PERSONAL_YEARLY`; Personal can no longer be bought (#117)",
        "`POST /api/o/:slug/billing/change`, `OrgBillingView.switch_to` and the switch-to-a-smaller-plan confirmation: with one plan sold there is nothing to switch to (#117)",
        "`POST /api/o/:slug/billing/renew` (an ended subscription now leaves the org on Free; Upgrade to Pro is how it pays again); `firstTeamPlan` (#117)",
      ],
    },
    prs: [117, 119, 120],
  },
  // Sync GitHub as a recorded run, and AI summaries counted per organization (#109).
  {
    version: "0.22",
    date: "2026-10-07",
    title: "Sync you can see",
    headline: "Sync GitHub now says what it will do, shows its progress as it runs, and leaves a result everyone in the organization can read.",
    highlights: [
      "Sync GitHub opens a small panel before anything runs. It names the repository, says what a sync reads and updates, shows when the last one ran and who started it, and has one button: Sync now.",
      "While a sync runs you see what it is doing: reading pull requests, reading issues, saving them, then checking deployments and CI, with how many are done and what has changed so far. You can close the panel or go to another screen; the button keeps showing the progress.",
      "When it finishes, the result stays until you dismiss it: what changed, how long it took, and anything that could not be read, with what to do about it. If nothing changed it says so.",
      "Everyone in the organization can see when the last sync ran and who started it, on My Work and on the Repo screen. Only admins can start one, and only one runs at a time.",
      "AI summaries of pull requests and issues now have a monthly allowance that comes with your plan. Org settings › General shows how many you have used this month, the panel shows how many a sync will write, and the pricing page lists each plan's allowance.",
    ],
    headsUp: [
      "When an organization has used its AI summaries for the month, new pull requests and issues show a short excerpt instead. Nothing fails, and a sync in the next month fills them in.",
      "A sync writes at most 50 summaries each time you run it. A larger backlog takes more than one sync.",
      "Closing or reloading the tab that started a sync stops it after the step it is on. Nothing is lost: the panel says it did not finish, and the next sync picks up where it left off.",
      "If GitHub is not connected, the panel says so and takes an admin to the place to connect it: Org settings › Repositories where the Trov App is offered, or Integrations for a token.",
      "The page where you approve an app (Connect an app), and its sign-in and error pages, are in the brand's purple on white.",
      "Trov's emails are in the brand's purple: the digest, invitations and the welcome message, in light and in dark mail clients.",
      "An organization's address is shorter: trov.dev/your-org/ instead of trov.dev/o/your-org/. Old links and bookmarks still work and take you to the new address.",
      "If the Trov App is installed on a GitHub account that does not own your repository, Org settings › Repositories and the Sync panel now say so, naming the account and the repository. Connecting the right account replaces the old connection; you no longer have to disconnect first.",
      "A payment that is past due does not stop AI summaries. When a plan ends they stop, and new items show an excerpt until the plan is renewed.",
    ],
    ops: [
      "Apply migration `0046_sync_runs` (additive: the table `sync_runs` and one index). It is safe on live data and with the previous Worker running. To roll back, deploy the previous Worker and `DROP TABLE sync_runs`.",
      "AI summaries stay OFF until the platform key is set: `wrangler secret put GEMINI_API_KEY`. One key serves every organization. From then on each summarizer call is counted per organization in `org_usage_daily` and each plan's monthly allowance applies (`ai_summaries` in `shared/plans.ts`: 300 Personal, 3,000 Team, unlimited Enterprise — placeholders; an override per org works like every other limit). `docs/architecture/plans.md` › AI summaries has what counts, the reset, and how to estimate cost.",
      "Outgoing mail is ON: `NOTIFICATIONS_MODE = \"resend\"` in `wrangler.toml` (it had been set in the Cloudflare dashboard, and the next deploy put it back to `local`). Needs the `RESEND_API_KEY` secret, which is set.",
      "Branch builds deploy a Preview against their own empty database (`[previews]` in `wrangler.toml`: D1 `trov-preview`, R2 `trov-preview-artifacts`). In the Cloudflare dashboard, Builds › non-production branches must use build command `npm run build:web` and deploy command `npm run deploy:preview` — never the production deploy command, which applies migrations to the production database.",
      "No cron trigger change: run records older than 90 days are deleted by the existing daily cron.",
      "Trov plugin 0.7.1 connects to `https://trov.dev/mcp` (0.7.0 still pointed at the old canopy.saplinglearn.com address, which now redirects and cannot be signed in to). Update the plugin (`/plugin marketplace update trov`, then reinstall or `/reload-plugins`), then `/mcp` → trov → Authenticate.",
      "`LOCAL_UPSTREAM` is a local-development value only (a loopback stand-in for GitHub and Gemini during a Sync). Do not set it as a secret; a value that is not `http://127.0.0.1` or `http://localhost` is ignored, and so is any value while a live Stripe key is set. It and `STRIPE_TEST_API_BASE` are described together in `.dev.vars.example`.",
    ],
    patches: {
      added: [
        "`shared/sync.ts`: the run and status shapes, the batch and summary bounds, and every sentence the panel shows (built from counts and failure codes, never upstream text)",
        "Migration `0046_sync_runs` and `src/sync/runs.ts`: each Sync GitHub run is a row (who, when, batch, phase, running counts, failure codes, how it ended); the row is the org's lock",
        "`GET /api/o/:slug/sync` (any member; alias `/api/sync`): the run in progress, the last one, why a sync cannot start, the summaries allowance, when deployments and CI were last refreshed",
        "`POST /admin/backfill` takes `start` / `run` and answers with `run` and `summaries` beside its existing fields; 409 `sync_running` with the run in progress",
        "`src/plans/summaries.ts` `orgSummarizers`: the one place a summarizer is chosen for an org, for the webhook and for Sync; `summaryAllowance`",
        "The limit `ai_summaries` (per calendar month, UTC) in `shared/plans.ts`, shown in the Plan block and editable in Platform's limit fields",
        "Summary metering in `org_usage_daily`: `summary:pr|issue` (attempts), `summary_failed:*`, `summary_capped:*`, `summary_chars_in|out`, `summary_tokens_in|out`",
        "Platform › Usage: AI summaries per org and in total (attempted, succeeded, fell back, the month against the cap)",
        "`web/src/sync.ts`: the Sync panel and the header control's states; `docs/architecture/sync.md`",
        "`pruneSyncRuns` on the daily cron; `sync_runs.started_by` in `HANDLE_COLUMNS`",
        "`githubCredentialSource` (`src/github-app/credential.ts`): where an org's GitHub credential would come from, in the order every read resolves it (the App's installation, the stored token, SaplingLearn's legacy secret), asked without minting a token. `GET /sync` answers `via` and `connect` from it (#109)",
        "The pricing page and its comparison table list AI summaries per month for each plan",
        "`src/platform/loopback.ts` and `holdsLiveKey` (`src/billing/config.ts`): the one test both local stand-ins (`LOCAL_UPSTREAM`, `STRIPE_TEST_API_BASE`) pass — a loopback http origin, and no live Stripe key",
      ],
      changed: [
        "An org's page is `/<slug>/` (was `/o/<slug>/`): `orgPath` / `orgSlugOfPath` in `shared/orgs.ts` are the one definition; `src/index.ts` serves the shell for `GET /<slug>[/]` when the segment is a valid slug not in `RESERVED_ORG_SLUGS`, and answers `GET /o/<slug>/…` with a 301 (query kept). `RESERVED_ORG_SLUGS` now lists every root route and static page; `test/spa-shell.test.ts` walks the app's routes and fails on a missing one. The API stays at `/api/o/:slug` (#111)",
        "Sync GitHub's blocking modal and its closing toast are gone: progress and the result are in the panel",
        "A batch reports its phase and items done as it goes (`runBackfill` `onProgress`), and its result carries what it captured, mirrored and summarized",
        "A batch that throws answers 502 `{ error: \"sync failed\", run }` instead of a bare 500, and its run is closed as failed",
        "Platform › Usage's active people and last activity leave out the summary counters (they are the platform's calls, not a person's requests)",
        "`formatUse` says \"this month\" for a monthly allowance; `overLimits` never lists one",
        "`formatLimit` and `formatUse` write counts with thousands separators (3,000), in the Plan block, Platform and the pricing page alike",
        "A sync's failure names the credential it read with (`via`), so its fix points at Repositories for the App and at Integrations for a token",
        "Platform's organization page shows AI summaries as off when the deployment has no `GEMINI_API_KEY`, as Platform › Usage does",
      ],
      fixed: [
        "A sync with no summarizer no longer loops ten batches rewriting the same excerpt rows: nothing is spent from the batch budget when nothing can be attempted, so it is one batch",
        "An explicit `summarizer: null` passed to `runBackfill` means no summarizer (it fell through to the environment's)",
        "The GitHub App on an account that does not own the primary repository was silent (the repository just read \"manual\"): `GET …/github` carries `mismatch`, Repositories shows a banner with a Connect link, and `GET /sync` carries `wrong_account` so the panel names the account instead of \"GitHub is not connected\" (#110)",
        "Connecting a different installation replaces the org's current one in one batch (`bindInstallation(ctx, info, replace)`: the old binding ends as `disconnected`, audited with `replaced_by`); the `already_connected` refusal is gone (#110)",
      ],
      removed: [],
    },
    prs: [109, 110, 111],
  },
  // Billing (#106), with the pricing page (#105), which merged without a release line of its own.
  {
    version: "0.21",
    date: "2026-10-07",
    title: "Paid plans",
    headline: "You can buy the Personal or Team plan and set your organization up yourself, and its owner manages billing in Org settings.",
    highlights: [
      "You can buy a plan. Choose Personal or Team, sign in, and pay on Stripe's page. When the payment is confirmed you name your organization and you are its owner. Enterprise is still arranged with Trov.",
      "After paying you land on a page that waits for the payment to be confirmed, then takes you to set up your organization. If confirmation is slow it says your payment was received and that your organization will be on your organizations page shortly.",
      "Org settings › General shows how a paid organization pays: when it renews, a payment that is past due, or a cancelled plan and the day it ends.",
      "An owner can open Manage billing to change the card, see invoices or cancel, can move the organization between Personal and Team, and can renew a plan that has ended. Each of these opens Stripe's own pages.",
      "When a plan's limit stops something in an organization that pays, its owner is pointed at Org settings to upgrade, manage billing or renew.",
    ],
    headsUp: [
      "Paid plans are switched on by Trov. Until they are, buying a plan says it is not available yet and nothing else changes.",
      "Organizations that Trov set up or granted are not billed, and their Plan section shows nothing about payment.",
      "A payment that is past due changes nothing while Stripe retries the card. If the retries run out, the plan ends.",
      "When a plan ends, everything in the organization stays and keeps working, and nobody loses access. You can't add people, repositories, environments, artifacts or agent connections until an owner renews it.",
      "Moving from Team to Personal with more than one person removes nobody and deletes nothing, but no one can be invited until the organization is back to one seat. Trov says so before you confirm.",
      "Signing in with Google does not create an account. To buy a plan as someone new, sign in with GitHub.",
    ],
    ops: [
      "Apply migration `0045_billing` (additive: the tables `billing_events`, `billing_checkouts`, `billing_subscriptions`; no column added to an existing table). Safe on live data and with the previous Worker running. Rollback steps are in the file's header.",
      "Billing is OFF until both secrets are set: `wrangler secret put STRIPE_SECRET_KEY` and `wrangler secret put STRIPE_WEBHOOK_SECRET`. While off, every billing route answers 503 `billing_unavailable` and `POST /webhook/stripe` answers a bare 401.",
      "Prices are not in Trov. Create the Products and recurring Prices in Stripe and paste the Price ids into `wrangler.toml` `[vars]`: `STRIPE_PRICE_PERSONAL`, `STRIPE_PRICE_TEAM`, and optionally `STRIPE_PRICE_PERSONAL_YEARLY`, `STRIPE_PRICE_TEAM_YEARLY`. A plan with no id cannot be bought.",
      "Add the webhook endpoint `https://trov.dev/webhook/stripe` in Stripe with `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.",
      "Configure the Stripe Customer Portal (payment methods, invoices, cancel; plan switching with both products) or Upgrade and Switch answer that the plan change could not be opened. Do one purchase in test mode with card 4242 4242 4242 4242 before live keys. The full checklist is in `docs/architecture/billing.md`.",
      "No cron trigger and no plugin change. The daily cron also prunes handled `billing_events` older than 90 days.",
      "Update the Terms and Privacy text for paid plans and Stripe as a processor before taking live payments.",
    ],
    patches: {
      added: [
        "Migration `0045_billing`: `billing_events` (each Stripe event id once), `billing_checkouts` (a Checkout Session bound to the person who started it), `billing_subscriptions` (Stripe's current state of each subscription, and the superadmin's pin)",
        "`src/billing/`: `stripe.ts` (the one fetch client: fixed host, no redirects, timeout, pinned `Stripe-Version`, an `Idempotency-Key` on every POST, every error scrubbed of the key), `config.ts`, `signature.ts`, `store.ts`, `sync.ts`, `webhook.ts`, `routes.ts`, `view.ts`, `pages.ts`; `shared/billing.ts` (the wire)",
        "`GET /billing/start?plan=personal|team[&interval=month|year]` (public: sign in and come back, or a Stripe Checkout Session), `GET /api/billing/config` (public), `GET /api/billing/status?session_id=` (the caller's own checkout)",
        "`POST /webhook/stripe`: `Stripe-Signature` verified over the raw body (several `v1`, a 5-minute tolerance), one bare 401 for every refusal, each event id handled once, every handler re-reads the subscription and converges",
        "Fulfilment calls `grantOrganization` with the subscription id as `external_ref`, so a replayed event and the waiting room's own look at Stripe make one grant; `createOrgFromGrant` links the org to the customer and subscription in the creating batch (`linkPaidOrgStmt`)",
        "`POST /api/o/:slug/billing/portal`, `/billing/change`, `/billing/renew` (owner, cookie only): each answers a URL on Stripe's pages",
        "`src/auth/return-to.ts`: a sealed, allowlisted return path taken by the sign-in tail after `oauth_pending`",
        "SPA: `web/src/billing.ts` (the waiting room at `/billing/done`, then `/?setup=<grant>` opens the picker on that organization's form), `web/src/org-billing-actions.ts`, the Plan block's billing states in `web/src/org-plan.ts`",
        "Platform: an org's row and page say granted or paid, Stripe's status and the period, with a link to the customer in the Stripe dashboard (test or live); Follow subscription",
        "The `checkout` limit: 10 Checkout Sessions per person per day (`src/platform/limits.ts`)",
        "A public pricing page at `/pricing` and a pricing section on the landing page: the three plans and what each includes, from `shared/pricing.ts`. Prices are not announced yet, so every plan reads Pricing to be announced and no plan links to checkout (#105)",
        "`test/billing.signature.test.ts`, `billing.flow.test.ts`, `billing.lifecycle.test.ts`, `billing.leak.test.ts` (canary key against a Stripe that echoes it), `render.billing.test.ts`; the isolation matrix, the MCP import rule and the API prefix test cover the new routes",
      ],
      changed: [
        "`GET /api/o/:slug/plan` carries `billing` (`OrgBillingView`, null for a granted org) and `period_end` is now written",
        "A plan refusal (402 `plan_limit`) carries `paid: true` for an org that pays; `planRefusalSentence` points its owner at Org settings",
        "`PUT /api/platform/orgs/:slug/plan` on an org with a live subscription keeps it a billing org and pins a plan that differs from the paid one; `{ follow_subscription: true }` lifts the pin. On an ended subscription it takes the org back as granted",
        "`PlatformOrgPlan` carries `billing` for a paid org",
        "The grant notice e-mail has a paid wording, sent to the buyer's provider-verified address",
        "The picker says Paid for, not Granted by, on a grant a payment made",
        "`PlanDef.billing` stays null: a plan's price is deployment config",
      ],
      fixed: [
        "Tracking a repository from the GitHub App's list when the plan's repositories are all used answered 500 `internal`. It is the 402 `plan_limit` every other route gives, and Org settings shows the plan's sentence",
      ],
      removed: [],
    },
    prs: [105, 106],
  },
  {
    version: "0.20",
    date: "2026-10-07",
    title: "Plans",
    headline: "An organization is now on a plan (Personal, Team or Enterprise), and Trov can hand someone an organization to set up themselves.",
    highlights: [
      "Every organization is on a plan. Personal is for one person, Team is for up to 10 people, and Enterprise has limits Trov sets for that organization. Org settings › General shows your plan, what it includes, and how much of each limit you use.",
      "Org settings › Members shows your seats, like 7 of 10 seats used. A seat is a member or a pending invitation. When every seat is in use the invite form gives way to a sentence saying so, and how to free one.",
      "You can be given an organization of your own. When Trov grants you one, the page that lists your organizations says You can set up an organization, with its plan. You choose its name and address and become its owner.",
      "When a plan's limit stops something, Trov says which limit and who can change it, in one sentence, wherever it happens.",
    ],
    headsUp: [
      "Organizations that existed before plans are on Enterprise with no limit on people, so nothing changes for them.",
      "On the Personal plan there are no invitations: Members says the plan is for one person.",
      "If an organization ends up over a limit after its plan changes, nothing is removed and nobody loses access. You can't add more of that kind until it is back under the limit.",
      "A plan also limits connected repositories, environments, stored artifacts and how many agent connections each person has. Removing one you no longer use frees room.",
      "Create organization appears in the switcher's menu only when you have been given an organization to set up.",
    ],
    ops: [
      "Apply migration `0044_plans` (additive: nine columns on `orgs`, the tables `org_grants` and `platform_outbox_bodies`, and one backfill that puts every existing org on `enterprise` with `plan_source = 'granted'`). It is safe on live data and with the previous Worker running. Rollback steps are in the file's header.",
      "No secret, no cron trigger and no plugin change. No prices and no payment code: `src/plans/billing.ts` is the seam a billing integration calls, and `orgs.plan_period_end`, `orgs.billing_customer_id`, `orgs.billing_subscription_id` and `org_grants.external_ref` are reserved for it, written by nothing yet.",
      "Every plan number is a placeholder in `shared/plans.ts` `PLANS`: change a number there and nothing else. The numbers and what counts toward each are in `docs/architecture/plans.md`.",
      "`persons.org_limit` is no longer read and Platform's Organization limit control is gone. To let someone create an organization, grant them one in Platform › Access. Anyone given an allowance by hand before this needs a grant instead.",
      "A grant by e-mail sends a notice through the platform's own sender. `NOTIFICATIONS_MODE` is `local` today, so nothing leaves: the body is written to `platform_outbox_bodies`.",
    ],
    patches: {
      added: [
        "`shared/plans.ts`: the three plans, the five limits (`seats`, `repositories`, `environments`, `artifact_bytes`, `agent_connections`), `resolveEntitlements` (plan + per-org overrides) and `planRefusal`, the one answer to \"may this org add this now\"",
        "Migration `0044_plans`: `orgs.plan`, `plan_overrides`, `plan_source`, `plan_status`, the billing columns; `org_grants`; `platform_outbox_bodies`",
        "`src/plans/`: `state.ts` (the org's plan, the seat gate, `setOrgPlan`, `setOrgPlanStatus`), `gate.ts` (`requirePlan` for the limits counted over tenant tables, `orgPlanView`), `grants.ts`, `billing.ts` (the seam: `grantOrganization`, `setOrgPlan`, `markOrgPastDue`, `cancelOrgPlan`), `routes.ts`",
        "`GET /api/o/:slug/plan` (any member); `GET|POST /api/platform/grants`, `POST /api/platform/grants/:id/revoke`, `PUT /api/platform/orgs/:slug/plan` (superadmin)",
        "A plan refusal is HTTP 402 `{ error: \"plan_limit\", limit, used, cap, plan, status, message }` from every route (one `app.onError` in `src/routes.ts`), and an MCP tool error with `code: \"plan_limit\"`",
        "Enforcement at the write: an invitation created (members + pending) and accepted (members), the superadmin's owner, the legacy invite alias, a repository connected, an environment added, an artifact version stored (and its upload link), an MCP token minted and an app connected",
        "The grant notice e-mail (`src/notifications/grant.ts`, `platformDeliveryFor`): names the granter and the plan, links only to the site root",
        "Audit actions `plan.change`, `plan.overrides`, `plan.status`, `grant.create`, `grant.revoke`, `grant.use`",
        "SPA: `web/src/org-plan.ts` (the Plan block, the seats lead, the invite gate), `web/src/platform-access.ts` and `platform-access-actions.ts` (Platform › Access, the grant dialog, Change plan and its confirmation)",
      ],
      changed: [
        "`POST /api/orgs` creates an org by consuming one of the caller's grants (`grant` = its id, else the oldest) in the creating batch; refused with 403 `no_grant` otherwise, and for a superadmin",
        "`GET /api/orgs` carries `grants` (the usable ones) and `can_create` (holds one); `created` and `limit` are gone",
        "`POST /api/platform/orgs` takes `plan` and `overrides` (default `team`); `PlatformOrgRow` carries `plan` (plan, overrides, status, source, entitlements, seats used)",
        "The repository and environment caps (10 each) are the Enterprise plan's defaults now: `too_many_repos` / `too_many_environments` (409) became the 402 `plan_limit`",
        "Platform: the Organizations list shows each org's plan and seats; Add organization picks a plan; the tab Admins & limits is Admins",
        "The setup checklist leaves out Invite your team on a one-person plan",
        "A dropdown opened inside a dialog that is still sliding in is placed again once it settles (`web/src/dropdown.ts`)",
      ],
      fixed: [],
      removed: [
        "`PUT /api/platform/persons/:handle/org-limit`, `setOrgLimit`, `orgAllowance`, the error code `org_limit` and Platform's Organization limit form. `persons.org_limit` stays as a dead column until the cleanup migration",
      ],
    },
    prs: [104],
  },
  {
    version: "0.19",
    date: "2026-10-07",
    title: "Connect with GitHub",
    headline: "An organization now connects its repositories by installing the Trov App on GitHub: no token to paste, no webhook to set up.",
    highlights: [
      "Org settings › Repositories has Connect with GitHub. It takes you to GitHub to install the Trov App on your account or organization and choose which repositories it may read, then brings you back connected.",
      "Once connected, Repositories lists the repositories the App can see. Track one with a click instead of typing its name; the first you track becomes the primary.",
      "Trov reads through the App and GitHub sends it events directly, so an organization on the App needs no GitHub token and no webhook of its own. Sync GitHub, the Repo dashboard and the organization's image all use it.",
      "Org settings › Integrations shows the connection as one row: the GitHub account it is on, who connected it, Test connection, Manage on GitHub and Disconnect. The token and webhook rows move under Manual connection, where they stay for anyone who prefers them.",
      "If the App is suspended or uninstalled on GitHub, or stops seeing a repository you track, Org settings says so and what to do about it.",
    ],
    headsUp: [
      "Only an admin or an owner can connect GitHub, and the GitHub account you approve it with has to be the one linked to your Trov account and able to read every repository the App covers.",
      "An organization connects one GitHub account at a time. Disconnecting leaves the Trov App installed on GitHub until you uninstall it there, and leaves your repositories connected.",
      "Events are still captured for the primary repository only. Other tracked repositories are listed and resolve links.",
      "Connecting by hand still works exactly as before: a GitHub token, and a webhook for each repository.",
      "The setup checklist's GitHub step now reads Connect GitHub, and is done by the App or by a token.",
    ],
    ops: [
      "Migration `0043_github_app` (additive: the table `org_github_installations`, and `connection` / `access_lost_at` on `org_repos`) is applied by the deploy. Rollback is by hand: the statements are in the migration's header, and must run BEFORE `scripts/mt/rollback/0042_organizations.down.sql` if that is ever used.",
      "Set two Worker secrets — `wrangler secret put GITHUB_APP_ID` (the App's numeric id) and `wrangler secret put GITHUB_APP_PRIVATE_KEY < the-app.private-key.pem` (the whole file GitHub generated) — and put the App's URL name in `wrangler.toml` as `GITHUB_APP_SLUG`. `GITHUB_APP_WEBHOOK_SECRET` is already set. Until all of slug, id and key are present, Org settings offers only the token path and says the App is not configured; nothing fails.",
      "On GitHub, in the App's settings: make the webhook Active with the URL `https://trov.dev/webhook/github/app` and subscribe to Pull request, Pull request review, Issues, Push, Deployment status, Check run, Workflow run and Status. The first Callback URL must stay `https://trov.dev/auth/callback`: GitHub returns there after an install.",
      "Then connect SaplingLearn: Org settings › Repositories › Connect with GitHub. Its old webhook and the Worker's `GITHUB_SERVICE_TOKEN` / `GITHUB_WEBHOOK_SECRET` keep working beside the App (one event through both is captured once) and can be removed once the App's row shows deliveries and a passing Test connection. The full checklist: `docs/architecture/github-app.md`.",
    ],
    patches: {
      added: [
        "The GitHub App as an org's GitHub connection (`src/github-app/`, `shared/github-app.ts`, `docs/architecture/github-app.md`): an RS256 App JWT signed with WebCrypto (GitHub's PKCS#1 PEM is wrapped as PKCS#8; a PKCS#8 PEM works too), installation tokens minted on demand — for the ONE repository being read, with the App's eight read permissions; for the installation's own repository list, Metadata only — and cached per isolate, per installation and repository, until ten minutes before expiry; never stored, never logged",
        "`resolveGithubCredential` (`src/github-app/credential.ts`): the org's live installation, then its stored `github_token`, then SaplingLearn's legacy Worker secret. The reconcile, the progress backstop, Sync GitHub, the webhook's follow-up reads and the org image's import resolve through it; a refused mint ends (404) or suspends (403) the binding and falls back to the stored token",
        "The connect flow: `GET /api/o/:slug/github/install` (admin+, cookie only) seals `{ org, person, state, expiry }` in an HttpOnly cookie and redirects to GitHub; `GET /auth/callback` recognises the install return (`installation_id` / `setup_action`) and binds only after the cookie, the state, the signed-in person, their admin role, their linked GitHub identity, `GET /user/installations` and the no-escalation check (every repository id of the installation is one that account can read; at most 1,000 are checked) all hold, and revokes the GitHub user token once it has decided; `?existing=1` links an installation that already exists through an ordinary authorization with PKCE (`src/github-app/connect.ts`, `src/auth/tx.ts`)",
        "`GET /api/o/:slug/github` (the connection, any member), `GET|POST …/github/repositories` (what the installation can see; track one), `POST …/github/test`, `POST …/github/disconnect` (admin+, cookie only, audited as `github.*` in `org_admin_audit`)",
        "`POST /webhook/github/app`: one endpoint for every installation, verified against `GITHUB_APP_WEBHOOK_SECRET` (the per-repo hook's bare 401 otherwise), the org resolved from the delivery's installation id, capture for that org's primary repository; `installation` (`deleted`, `suspend`, `unsuspend`, `new_permissions_accepted`) and `installation_repositories` events update the binding and the repositories' marks (`src/github-app/webhook.ts`)",
        "Migration `0043_github_app`: `org_github_installations` (one live installation per org, one org per installation) and `org_repos.connection` / `access_lost_at`",
        "Org settings (`web/src/github-app.ts`): Connect with GitHub, the installation's repositories to track, the App's row (Test connection, Manage on GitHub, Disconnect), Manual connection, the sentence after a return from GitHub; Platform's org list and org page name the GitHub account",
        "Tests: `test/github-app.jwt.test.ts`, `github-app.connect.test.ts`, `github-app.webhook.test.ts`, `github-app.jobs.test.ts`, `render.github-app.test.ts`; the App's routes in `test/isolation.http.test.ts`; `test/secrets.mcp.test.ts` forbids anything reachable from MCP from importing `src/github-app/`",
      ],
      changed: [
        "Org settings › Repositories: where the App is configured its one accent action is Connect with GitHub and adding by name is behind a disclosure; where it is not, the tab is as before and says why. A repository reached through the App shows no webhook URL",
        "Org settings › Integrations: the GitHub group leads with the App's row; with an installation the token and webhook-secret rows fold under Manual connection and no longer count as owed or as errors",
        "The setup checklist's third step is Connect GitHub where the App is offered, and is satisfied by an installation, a stored token or the legacy credential (`setupSteps`)",
        "`exchangeCode` (`src/auth/github.ts`) sends `redirect_uri` and `code_verifier` only when it has them: the installation-initiated authorization has neither. Sign-in is unchanged",
        "`reconcileCost` budgets one more subrequest per unit for a token mint (`GITHUB_MINT_COST`)",
        "The GitHub token's how-to names the Checks permission and points to the App first",
      ],
      fixed: [],
      removed: [],
    },
    prs: [103],
  },
  {
    version: "0.18",
    date: "2026-10-06",
    title: "Organizations",
    headline: "Trov now runs for any number of teams: each has its own organization, invites its own people, and you switch between the ones you're in.",
    highlights: [
      "Trov now holds more than one organization. Each has its own docs, tickets, roadmap, feed, handoffs, prompts and artifacts, and nothing crosses from one to another. Tickets and handoffs are numbered from #1 in each organization. The switcher at the top of the sidebar shows the one you're in and takes you to the others.",
      "Anyone with a GitHub account can sign in and accept an invitation to an organization. New organizations are added by whoever runs Trov for now. A new page lists your organizations and your invitations when you belong to none, or to several.",
      "Org settings is the one place an organization is run from: Members is the people directory, Notifications holds the email digest settings, and Maintenance is gone (its queue is now Triage › Unplaced). In Members, invite people by GitHub login or email, make them an admin or a member, give them a title, or remove them. An email invitation is sent by Trov, names your organization, and the page shows whether it went out; you can send it again. Owners manage other owners.",
      "Org settings also holds what used to be set by whoever deploys Trov: the repositories an organization tracks, the environments its Repo dashboard reports on, and the credentials Trov uses for it. A credential is write-only: once saved, only its last four characters are ever shown.",
      "Connecting Claude Code is per organization: you pick the organization when you allow the connection, and Settings › MCP access shows which one each connected app reaches.",
      "A new organization's admin gets a short checklist: connect a repository, add an environment, set the GitHub token, invite the team. Each Org settings tab starts with one line saying what is set and what needs attention, and a row opens for its details.",
    ],
    headsUp: [
      "The address of every page now starts with your organization, like /o/your-org/. Old links and links in emails still open, in your organization if you have one, or the last one you used.",
      "Maintenance is split up. Its Unplaced queue is now Triage › Unplaced in the sidebar. People is Org settings › Members, which you open from the switcher at the top of the sidebar: the directory for everyone, and inviting, roles and titles for admins. Identity is there too, as Unmatched logins. The email digest settings are Org settings › Notifications. Old Maintenance links open the new place.",
      "The sidebar's Unplaced count is the queue alone. Logins waiting to be matched are counted on the organization switcher and on the Members tab, for admins only.",
      "Admin now means admin or owner of the organization you're in. If you could sync GitHub, change the email digest or delete other people's prompts and artifacts before and can't now, ask an owner to make you an admin in Org settings › Members.",
      "Signing in with GitHub no longer requires being in a particular GitHub organization. Signing in with Google still needs an invitation.",
      "An organization can have an image, shown beside its name everywhere. An admin uploads one in Org settings › General; without one, Trov uses the GitHub picture of whoever owns the organization's main repository. An uploaded image is never replaced by GitHub's.",
      "A person's title is set per organization.",
      "A ticket or handoff number is its number within your organization. Existing tickets and handoffs keep the numbers they had, so old links still open the same ones.",
      "The email digest's sender is a name now, not an address: every organization's mail is sent from Trov's own address under the name its admin picks.",
      "A few actions have a daily limit per person (invitations, test emails, changing your digest address, photo and organization image uploads). When you reach one, Trov says when you can try again.",
      "Typing a bare issue number like #214 as a link needs a repository connected in Org settings; without one, paste the full link.",
    ],
    ops: [
      "Before applying the multitenancy migration (`0042_organizations`: one file, all-or-nothing; `0041_trov_name` is already applied), take `wrangler d1 export` (data, base tables — see `scripts/mt/verify-migration.mjs`) and note the D1 Time Travel bookmark; run `node scripts/mt/verify-migration.mjs` on the export (it also checks that every existing ticket's and handoff's per-org number equals its id, which is what keeps old `#12` links pointing at the same row); then `npm run db:migrate:remote` (the scripts now name the D1 database `trov`, as `wrangler.toml` does). Rollback: Time Travel + `wrangler rollback`, or by hand `scripts/mt/rollback/0042_organizations.down.sql` (the whole migration, back to the schema before it; it does not undo `0041`'s sender rename and refuses once a second organization exists).",
      "Set the `TROV_KEK` secret before this deploys: 32 random bytes, base64 (`openssl rand -base64 32`, then `wrangler secret put TROV_KEK`). It encrypts every organization's stored credentials; without it Org settings › Integrations answers 503 `secrets_unavailable` and no credential can be saved. Keep a copy: losing it loses every stored credential.",
      "Confirm the Worker is on Workers Paid before a second organization adds environments: the background jobs spend up to 900 subrequests per cron invocation (`CRON_SUBREQUEST_BUDGET`, `src/repo/dispatch.ts`); the free plan's cap is 50.",
      "Enter SaplingLearn's credentials in Org settings › Integrations: the GitHub token, the webhook secret, the Cloudflare analytics token and account id, and each environment's Railway and app metrics tokens. Until each is stored, the Worker secret it replaces still answers for SaplingLearn only (`GITHUB_SERVICE_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `CF_ANALYTICS_TOKEN` + `CF_ANALYTICS_ACCOUNT_ID`, `RAILWAY_TOKEN_<ENV>`, `SAPLING_METRICS_TOKEN`). Then re-point SaplingLearn's GitHub webhook at `/webhook/github/hook_saplinglearn_sapling`; the legacy `/webhook/github` keeps working until then.",
      "Promote SaplingLearn's admins: `0042_organizations` makes andres the owner and everyone else a member, and `ADMIN_LOGINS` no longer grants anything on a signed-in route. Anyone who should keep admin rights is made an admin in Org settings › Members.",
      "`0042_organizations` seeds andres as the one superadmin. The Platform area reads it: inside an organization (the sidebar's Platform entry) and at `/platform/`, which needs no membership. A superadmin has no access to an organization's content. The same migration adds `identities.provider_uid`, which pins a GitHub identity to the account's numeric id at each person's next sign-in.",
      "`0042_organizations` adds four nullable columns to `org_invites` (the invitee's name and the invitation email's outcome). Invitations and the welcome are real mail once `NOTIFICATIONS_MODE` is `resend`: verify trov.dev as a sending domain first, since every organization's mail goes out from `hello@trov.dev`.",
      "`0042_organizations` adds five nullable columns to `orgs` (the organization's image and where it came from); no backfill. Images are stored in the artifacts R2 bucket under `org-logos/`. An organization with a repository and a GitHub token gets its image at the next 6-hourly reconcile; the import asks `api.github.com` and `avatars.githubusercontent.com` only.",
      "The Worker now answers `GET /o/*` and `GET /platform*` with the app shell. `GITHUB_REPO` and `REPO_ENVIRONMENTS` are read only as SaplingLearn's seed (`0042_organizations` copied them into its repository and environment rows); change them in Org settings from now on.",
    ],
    patches: {
      added: [
        "Multitenancy schema (`canopy-multitenancy.md`): ONE migration, `0042_organizations`, in ten sections — orgs (orgs, memberships, org invites, repos, environments, integration-secret tables, per-org attribution map, counters; SaplingLearn seeded as `org_saplinglearn`), tenant columns, tenant rebuilds (20 tables re-keyed by org, ending in a foreign-key guard that fails the whole migration), tenant FTS (every search index org-scoped), then the platform admins, platform orgs, identity uid, abuse limits, invite mail and org logo additions; per-org ticket and handoff numbers; a generated rollback (`scripts/mt/build-rollback.py`) and a production-copy check (`scripts/mt/verify-migration.mjs`); CI on every push (`.github/workflows/ci.yml`). Nothing on screen changes yet",
        "Data layer (`src/data/`): every repository takes a `TenantContext` or a `PlatformContext` and every tenant statement binds its org; D1 is reachable only there, enforced by `test/data-layer.static.test.ts`; cross-org isolation suites `test/isolation.*.test.ts`",
        "Routes: every tenant route is served at `/api/o/:slug/<suffix>` behind a membership gate (404 for a non-member) and, for the cut-over, at its old path for a person in exactly one org (409 `org_required` otherwise); `GET /api/orgs`, `POST /api/orgs`, `POST /api/invites/:id/accept|decline`, `GET /api/o/:slug/me` (role, title, connected repositories); org roles replace `ADMIN_LOGINS` on every session route; `identities.provider_uid` (`0042_organizations`, section 7)",
        "Orgs, members, invites and the superadmin surface (`src/orgs`, `src/platform`, `0042_organizations` sections 5–6): Platform › Organizations (add, suspend / unsuspend, owners), Usage, Admins & limits, Audit — `web/src/platform*.ts`",
        "Per-org integrations (`src/integrations`, `shared/integrations.ts`): envelope-encrypted, write-only secrets under `TROV_KEK`, Test connection, an audit trail, key rotation; Org settings (`web/src/org-settings.ts`, `integrations.ts`, `org-actions.ts`): Integrations, Repositories, Environments, Members, General, and the setup checklist",
        "MCP: a token and an OAuth grant are bound to (person, org); `GET/POST /api/o/:slug/mcp-tokens`, the consent page's org picker, `GET /auth/oauth-grants` rows carry their org",
        "Background work per org: the rotation dispatcher (`src/repo/dispatch.ts`), per-(org, environment) jobs, `POST /webhook/github/:hookId`, one digest per (person, org)",
        "The SPA at `/o/<slug>/` with the hash route after it: `src/index.ts` answers `GET /o/*` with `index.html` from the assets binding; `/` opens the person's only org, the last one opened in the browser (`trov.org`) or the org picker; sign-in returns to the org it started from (`web/src/org-context.ts`)",
        "One API prefix: `web/src/api.ts` `apiUrl` puts every tenant request under `/api/o/<slug>/` and one sender carries them all; a 404 confirmed by the membership gate lands on the picker; `test/api.prefix.test.ts` calls every exported request function and fails on an unprefixed tenant path",
        "The org switcher in the sidebar header, the org picker / first run and the create-organization dialog (`web/src/org-picker.ts`, `org-picker-actions.ts`)",
        "Settings › MCP access: each connected app shows its org; the caller's access tokens for the current org are listed with Revoke",
        "`confirmModal` takes `tone: \"neutral\"` (the accent button); Platform's Unsuspend uses it",
        "Invitation mail from the org routes (`0042_organizations`, section 9): `POST /api/o/:slug/invites` takes an optional `name`, mails an email invite and returns `name` / `mail_status` / `mail_at` / `mail_error` on the row; `POST /api/o/:slug/invites/:id/resend`; the superadmin's owner invite (`POST /api/platform/orgs`, `…/orgs/:slug/admin` with `{ email }`) sends the same mail worded for an owner; the mail names the org, the inviter and the role and links to the site root only (`src/orgs/mail.ts`, `src/notifications/invite.ts`)",
        "The welcome mail names the org, links into it, and is sent on a person's first membership of any org: accepting an invitation, creating an org, or being named its owner",
        "Raw artifact serving per org: `GET /api/o/:slug/raw/a/…` — the same sub-app, headers, sandbox, CSP and access rules as the `/raw/a/…` alias (`test/artifacts.security-raw.test.ts` runs its header table against both)",
        "`/platform/`: the Platform screens in a minimal shell outside any org, for a superadmin with no membership; linked from the org picker and the switcher's menu; `src/index.ts` answers `GET /platform*` with the app shell",
        "`src/tools/org-links.ts`: links in MCP tool results and digest emails carry the org (`<origin>/o/<slug>/#…`, `<origin>/api/o/<slug>/raw/a/…`)",
        "`shared/sender.ts`: the mail sender-name rule, one definition for the Worker and the SPA; `test/numbers.per-org.test.ts`, `test/org-invite-mail.test.ts`",
        "The organization's image (`0042_organizations` section 10, `src/orgs/logo.ts`, `web/src/org-logo.ts`): `POST /api/o/:slug/logo` and `…/logo/remove` (admin+, cookie only, audited, 20 uploads a day per person), `GET /org-logo/<sha>` served like a person's photo, `logo_url` on every org the API returns, and an import of the primary repository owner's GitHub avatar (on connecting a repository, setting the token, the reconcile, and removing an upload) that never replaces an uploaded image; `test/org-logo.test.ts`, `test/render.org-logo.test.ts`",
      ],
      changed: [
        "Admin-only controls (Sync GitHub, Poll now, the email digest settings, deleting someone else's prompt or artifact) read the role in the org on screen (`viewerIsAdmin`); `/auth/me`'s `admin` / `org` / `role` are no longer read by the SPA",
        "Maintenance is consolidated into Org settings: the screen (still `maintenance` in state) is the Unplaced queue alone, titled Unplaced, at `#unplaced`, with no tab bar; `#maintenance` resolves to it and `#maintenance/identity` / `#maintenance/people` to `#org/members` (`web/src/hash.ts`). Identity is Org settings › Members › Unmatched logins (`web/src/identity.ts`, admins only); the admin email-notification sections are the new Org settings › Notifications tab (`notificationsAdminSections`, admin+); the People tab, its pointer and `peopleSection` are gone (Members is the directory). `triageCounts().maintenance` counts unplaced items only; `identityCount` (admins) shows on the org switcher, its Org settings row and the Members tab",
        "Org settings › Members sends and re-sends the invitation email through the org routes, for an admin in any number of orgs, takes the invitee's name, and shows each pending invite's email outcome",
        "A ticket's and a handoff's `id` on every surface is its per-org number (spec §12 Q2): route params and bodies (`/tickets/:id`, `child_id`, `after_id`, `/handoffs/:id`), every MCP ticket / handoff tool, quick search (`#12`), My Work, a sprint's ticket list, an artifact's link to a ticket. The global row id no longer leaves the Worker. `MyWorkTicket.number` is gone (`id` is the number)",
        "`POST …/admin/poll` and `…/admin/poll-usage` results: a source the org has not set up reads \"Not connected — set it up in Org settings › Integrations\"; Sync GitHub's 503 for an org with no repository or token says so and offers Org settings",
        "Org settings, Platform and the org picker share one hierarchy (`web/src/org-ui.ts`): a tab opens with a lead line (`tabLead` — what is there, what needs attention, the tab's one accent action), sections are the uppercase eyebrow (`orgHead`, `.cnpy-sechead`), a row shows a name, a status chip and one quiet action and opens to the rest (`openRow`, `orgRowToggle`, `OrgUi.openRows`), and destructive actions are text (`dangerLink`). Integrations' status chip is one word (the last four move to the row's metadata), its encryption key and history are rows at the foot; the setup checklist is one line; an environment's Delete is in its edit form; Platform's Add organization is the Organizations tab's lead action, not a header button; a Platform organization's page lists members and pending invites together, with Add an owner behind a button (`platOwnerToggle`)",
        "Org settings › Notifications: the sender is a NAME field over the fixed address, checked with the Worker's rule; a 429 `rate_limited` is one sentence with the local time wherever a limited route is called",
        "A sprint's `lead` must be a member of the org (`create_sprint`, the plan write): a non-member is a 400 and nothing is written",
        "A bare issue ref (`#214`) on a ticket link or sprint resource resolves against the org's primary repository only; with none connected it is a 400 that names Org settings › Repositories",
        "`package.json` `db:*` scripts, `scripts/mt/verify-migration.mjs` and the rollback headers name the D1 database `trov`",
        "Issue, pull request and commit links, the new-artifact repo list and a new handoff's default repo come from `GET /api/o/:slug/me` (`web/src/github.ts`); with no repository connected a bare `#12` is plain text and the Repo dashboard, the artifact form and the handoff form link to Org settings › Repositories",
        "The Repo dashboard's not-connected sentences name Org settings › Environments / Integrations instead of Worker variables and secrets",
        "Per-repository webhook URLs are shown as live (`WEBHOOKS_LIVE`); a webhook secret's test is \"Check deliveries\", and no delivery yet reads as waiting, not failed",
        "`GET /api/orgs` is loaded once at boot into `state.myOrgs`; the Platform and Org settings controllers both read it",
        "The landing page, the sign-in dialog, the two refused-sign-in screens and the Get Started guide state the new rules: any GitHub account signs in; Google needs an invitation",
        "The sidebar: Org settings moved into the switcher's menu; below 990px and again below 850px of height the rail tightens so every entry, Platform included, stays on screen at 800px",
        "Sign-in checks no GitHub org; onboarding creates a person with no membership (a live legacy SaplingLearn invite is still consumed as one)",
      ],
      fixed: [
        "Switching tabs in Org settings or Platform replayed the screen's entrance and could flash a loading state: the entrance is keyed on the page without its tab (`pageKey`, `web/src/hash.ts`), both pages are patched in place so the tab bar is the same element and only the panel is replaced (`data-morph` / `data-morph-key`, `web/src/morph.ts`), a loaded slice is refreshed behind what is on screen, and Platform reads every tab when it opens (`test/tabs.instant.test.ts`)",
        "A doc image in Review's Rendered view was requested at `/img/<sha>`; it is the org's, at `/api/o/<slug>/img/<sha>`",
        "HTML, image and PDF artifact previews, thumbnails, Download and Open in new tab work for a person in several orgs (they load the org's raw route)",
        "A superadmin who belongs to no organization can reach Platform",
        "Accepting an owner invitation lands on Org settings, where the setup checklist is; the checklist's \"Invite your team\" step is no longer ticked by the owner's own accepted invitation",
        "Poll now on an organization with no repository connected shows its answer (every source not connected) above the empty state instead of nothing",
        "Settings › Account no longer truncates \"Signed in as …\" at narrow tile widths: the line wraps",
      ],
      removed: [
        "`REPO_URL`, `ARTIFACT_REPOS` and the hardcoded handoff repo in the SPA; the `admin_handle_not_allowlisted` toast (the Worker no longer sends it); the landing dialog's \"Preview the non-member screen\" link",
        "`PUT /api/people/:handle` and every legacy `/invites…` route are no longer called by the SPA (alias-only on the Worker until the cleanup phase)",
        "The artifact viewer's \"This preview can't open here yet\" state; `DEFAULT_TICKET_REPO` (`shared/tickets.ts`); the unused `.cnpy-roleedit*` styles",
      ],
    },
  },
  {
    version: "0.17",
    date: "2026-10-06",
    title: "Canopy is now Trov",
    headline: "Same tool, new name and a new logo — plus public Terms of Service and Privacy Policy pages.",
    highlights: [
      "Canopy is now called Trov — in the app, on the site, in every email and in the Claude Code plugin. Your docs, tickets, sprints, handoffs, prompts and artifacts are exactly where they were.",
      "Your theme and sidebar settings carry over to the new name on their own.",
      "A new logo: the Trov mark replaces the three bars in the app, on the site, in the tab icon and in every email.",
      "Terms of Service and Privacy Policy now have their own pages, linked from the site's footer.",
    ],
    headsUp: [
      "The Claude Code plugin is now called Trov. Remove the old Canopy plugin and install Trov — Settings › MCP access shows the two commands — then sign in again from Claude Code.",
      "If you connected Claude Code without the plugin, connect it again under the new name from Settings › MCP access. Tokens you already use keep working.",
    ],
    ops: [
      "Apply migration `0041_trov_name`: the untouched default sender becomes `Trov <hello@trov.dev>` (digests, invites, welcome mail, the unsubscribe mailto, and the Terms / Privacy contact). BEFORE it deploys, verify trov.dev as a Resend sending domain (SPF / DKIM) and make sure hello@trov.dev receives mail — otherwise every send fails and lands as `failed` in the outbox.",
      "Trov plugin 0.7.0 — the plugin, its marketplace and the auto-wired MCP server are renamed `trov`. Everyone reinstalls: `/plugin uninstall canopy`, `/plugin marketplace add AndresL230/trov`, `/plugin install trov@trov`, then `/mcp` → trov → Authenticate. Agent tools are now `mcp__trov__…`; a by-hand `claude mcp add … canopy` server must be re-added as `trov`.",
      "Unchanged on purpose: the canopy.saplinglearn.com domain the app is served from, the Worker / D1 `canopy` / R2 `canopy-artifacts` names, the `canopy/coverage|bundle-kb|todo` commit statuses Sapling's CI posts, the `canopy-health` / `canopy-metrics` user-agents in the metrics contract, and tickets' stored `source = 'canopy'`.",
    ],
    patches: {
      added: [
        "Terms of Service and Privacy Policy: two public pages at `/terms` and `/privacy` (Vite inputs `web/terms.html` / `web/privacy.html`, content and renderer in `web/src/legal.ts`, boot in `web/src/legal-page.ts`), linked from the landing page's footer (`siteFooter`, now in `web/src/site-chrome.ts` and shared with both pages); readable signed out, following the app's stored theme",
        "The Trov mark (`shared/mark.ts`: one path, brand purple `#616ACB` on light and the dark theme's green `#9aab65` on dark, through a `--mark` token) replaces the three-bar mark in the sidebar, sign-in, landing, legal and OAuth pages; the tab icon (`favicon.svg`, `favicon.ico` in place of `favicon-32.png`, an apple-touch icon); the email banner draws it as table cells",
        "`web/src/storage-migrate.ts`: moves every `canopy.*` browser key (theme, feed / prompt view, rail, open nav groups, sign-in return-to) to `trov.*` once, at boot",
      ],
      changed: [
        "Renamed Canopy → Trov across the app, landing page, legal pages, emails, OAuth consent pages, MCP server name and tool descriptions, skills (the `canopy` skill is now `trov`), plugin and marketplace (`plugins/trov`), README / AGENTS / CLAUDE.md; `canopy.css` → `trov.css`; repo links → AndresL230/trov",
        "New MCP and OAuth tokens are minted `trov_mcp_` / `trov_oat_` / `trov_ort_`; `canopy_*` tokens issued before the rename still resolve",
        "`trov` is a reserved handle (beside `canopy`)",
      ],
      fixed: [
        "The record-session skill and the `query` reference named the doc spaces `sapling` / `canopy`; they are `product` / `technical` (0020)",
      ],
      removed: [],
    },
  },
  {
    version: "0.16",
    date: "2026-09-27",
    title: "Photos, roles and person cards",
    headline: "Click anyone's name to see their photo and role, upload your own photo, and agents can read what each person owns.",
    highlights: [
      "Click anyone's name — on a ticket, in the Feed, in search or in Maintenance › People — to see their card: their photo, name, role, when they joined and their GitHub.",
      "Click your photo in Settings › Profile to upload a new one or remove it. It's cropped to a square and shows everywhere your avatar does; removing it goes back to your GitHub or Google picture.",
      "Everyone has a role, shown on their card. Admins set it, with each person's responsibilities, in Maintenance › People. Responsibilities aren't shown anywhere: agents read them when deciding whom to assign work.",
      "Tickets you filed in Canopy can be deleted from the ticket page (tickets mirrored from GitHub can't), after a confirmation.",
      "In Maintenance › Identity, discard a GitHub login that isn't on the team — outside contributors stop showing up there, even when they open another pull request, and Undo brings one back.",
      "Agents can now assign and unassign people on existing tickets — when the person they work for is an admin, the ticket's requester or already on it. Tickets mirrored from GitHub included.",
    ],
    headsUp: [
      "Opening Settings no longer lights up the account chip at the bottom of the sidebar as if it were a selected row.",
      "Your picture and name no longer change with the way you sign in. If you linked both GitHub and Google, the picture you have now stays — it only updates when that same provider's picture changes — and a name you set in Settings sticks.",
      "Settings no longer mints MCP tokens — connect with the steps on Settings › MCP access and sign in in the browser. Tokens you already use keep working.",
      "Settings' boxes are only as tall as what they hold, and MCP access now walks you through the browser sign-in, with your connected apps right under it.",
      "Canopy now opens in Light mode — the landing page and the app — until you pick a theme. A theme you already chose in Settings › Appearance or with the toggle stays as it is.",
    ],
    ops: [
      "Apply migration `0036_person_profiles` with `npm run db:migrate:remote` before this deploys.",
      "Canopy plugin 0.6.8.",
    ],
    patches: {
      added: [
        "Migration `0036_person_profiles`: `persons.avatar_sha`, `role`, `responsibilities`; `shared/people.ts` — `ROLE_MAX`, `RESPONSIBILITIES_MAX`, `AVATAR_MAX_BYTES`, `AVATAR_TYPES`, `avatarSrc` and the profile DTOs (#89)",
        "`GET /api/people/:handle` / `PUT /api/people/:handle` (admins only), `POST /api/people/me/avatar` and `/avatar/remove`, `GET /avatar/<sha>`; `GET /persons` and `/auth/me` carry `role` and a resolved `avatar_url` (#89)",
        "`web/src/profile.ts` `personCardModal`: the person card a click on a name opens (the confirm modal's shell) — no People screen, no profile page; `GET /api/people/:handle` returns only the card's fields (#89)",
        "Settings › Profile: the avatar is the photo control — a hover veil with a camera, and a click menu with Upload (Change) photo, Remove photo over an uploaded one and the accepted types (`web/src/avatar.ts` centre-crops to a 512px square and encodes WebP, else PNG, before upload) (#89)",
        "Tickets: `POST /tickets/:id/delete` hard-deletes a native ticket (any member, never MCP; a ticket mirrored from GitHub is a 403); Delete ticket in the rail, through the confirmation modal (#89)",
        "Maintenance › Identity: `POST /identity-tasks/:login/discard` / `restore` — a soft, sticky discard (`identity_tasks.status = 'discarded'` + `resolved_at` / `resolved_by`, no migration; the login's PK keeps it from being re-raised, its events are still captured); a Discard on each card, a \"Discarded @login · Undo\" toast, and an \"N discarded\" list with Restore; `GET /identity-tasks` adds `discarded` (#89)",
        "MCP `assign_ticket { id, login, on }` (issue #90): adds or removes one assignee over the web's `toggle_assignee`, scoped to an admin, the ticket's requester or a current assignee (`assertTicketAssignable`); idempotent with no write, never changes status; the `tickets` / `canopy` skills and `create_ticket`'s description say so (#89)",
      ],
      changed: [
        "`personChip` draws the initials under the photo; a photo that fails to load is dropped for the session (one capture-phase `error` listener), so it falls back to initials instead of a broken image (#89)",
        "Quick search: a person hit opens their person card, with their role as the context line (was the queue filtered to them) (#89)",
        "The ticket rail's requester and assignees, the Feed's authors and Maintenance › People's rows open the person card; Maintenance › People shows each role and, for admins, Edit role — the one role + responsibilities editor (#89)",
        "Every name or photo opens the person card — the ticket queue (table rows and board cards), sprints and the Timeline's lead, handoffs, prompts, artifacts, docs, Review, Unplaced, the Repo dashboard's contributors and activity, the Feed's review box and Settings › Account — as one photo + name chip (`personLink`) where both fit; a card or row that opens something else is a container with its own click target laid over it (`ui.ts` `hitArea`), so a person is never a button inside a button (#89)",
        "Repo dashboard: PR authors and contributors show their avatar photo (#89)",
        "The default theme is Light (`initialState().theme`, was Dark), for the landing page and the app alike; a stored `canopy.theme` still wins (#91)",
        "Sidebar: no selected fill on the account chip while Settings is open or on hover — only its gear turns (#89)",
        "Maintenance: Unplaced / Identity / People are an underline tab bar at the top of the page body (`maintTabBar`, each tab with its count badge — the new `tabBar()` in `web/src/tabs.ts`, page-level sections as opposed to `segmented()`'s values: text tabs on a hairline, a 2px accent underline that slides between them via `syncTabBars`, tablist semantics and ←/→ / Home/End) instead of a sub-page list under the sidebar entry, which is now a plain row with its badge; the tabs are peers, so the header drops the \"Maintenance › Identity\" back-button crumb, and a tab switch no longer replays the screen's entrance; `maintenance` leaves `NAV_GROUPS` (#89)",
        "Roadmap: Narrative / Timeline are the same underline tab bar at the top of the page body (`roadmapTabBar`, the Timeline tab carrying the red overdue dot) instead of a `segmented()` switch in the header — both tabs open in one page frame so the underline slides and the bar never moves (`asideColumns` takes an optional `tabs` head for the Narrative's columns), the New sprint panel opens under its line, New sprint stays in the header, and a switch is one rerender (`setRoadmapTab`) that never replays the entrance (#89)",
        "Repo dashboard: Overview / Code / CI & Deploys / Usage / Team & Planning are the same underline tab bar at the top of the page body (`repoTabBar`, in every state of the dashboard — loading, failed, degraded, sample, nothing connected — with the sample / degraded banner, the Poll now strip and the not-connected footer under its line) instead of a sub-page list under the sidebar entry, which is now a plain row — `repo` leaves `NAV_GROUPS`, so only Docs keeps one; a switch (`setRepoTab`) is one rerender with no reload and no replayed entrance, the new tab's content rising in with its bars, fills, sparklines and deploy dots; the header crumb is just the repo slug; quick search's Repo › … entries and `#repo/<tab>` still land on their tab (#89)",
        "Settings: ONE bento grid with even edges — Profile | Account | MCP access (spanning two rows), Appearance under the first two, Email notifications full width — every tile stretched to its grid area, content balanced so a stretch is a few pixels, Profile's color and Account's sign-in methods pinned to the tile's foot (`.cnpy-tile-foot`); MCP access (`mcpAccessSection`) is OAuth only — one line, three browser sign-in steps (`PLUGIN_INSTALL`), Connected apps capped at 3 rows with Show all (no fixed-height scroller), and a Set it up without the plugin link that opens the by-hand `claude mcp add` in a modal (`mcpSetupModal`), so the tile never changes height; the Get Started guide says the same (#89)",
      ],
      fixed: [
        "A person with GitHub and Google linked got the picture (and the name) of whichever they signed in with last: the provider picture now has one owner, `persons.avatar_source` (0036 PART B, backfilled from the picture's host) — only that provider's sign-in refreshes it, and a sign-in never writes the name, so a Settings edit sticks (#89)",
      ],
      removed: [
        "Settings' token UI: Get connection command (`connectModal` / `connectSnippet` / `CONNECT_CLIENTS`, and with it the Codex, `.mcp.json`-with-header and Token only setups), the token list (`tokenListBody`) and the web client's `mintMcpToken` / `listMcpTokens` / `revokeMcpToken`; the guide's `connect` figure. The `/auth/mcp-token*` routes, `canopy_mcp_` bearer resolution and `mcp_tokens` stay, so existing tokens keep working (#89)",
      ],
    },
    prs: [89, 91],
  },
  {
    version: "0.15",
    date: "2026-09-26",
    title: "My Work tiles, a Roadmap timeline, one card look",
    headline: "My Work becomes five tiles, the Roadmap gets a calendar, search answers from the sidebar as you type, and every screen shares one card style.",
    highlights: [
      "My Work is five tiles: Tickets for you, Needs your review, Your sessions (your recent feed entries and handoffs left for you), Repo (PRs, CI and deploys) and Your library (docs you own, artifacts published this week, queued handoffs).",
      "The Roadmap's Narrative sits in two columns with a side panel, and a new Timeline tab draws every sprint on a calendar from its start to its due date. New sprint is in the header, and reloading keeps the tab you were on.",
      "Sprints have real start dates: the New sprint panel uses date pickers, a start can't be after the due date, and a sprint counts as overdue from the day after it is due, the same on every screen.",
      "Beside the Feed: This week (entries per day, who posted and the top tags, each a click to filter) and Waiting on review.",
      "Search everything from the sidebar: results for tickets, docs, decisions, roadmap, artifacts, prompts, handoffs, people, feed and app screens appear in a compact dropdown after a short pause (⌘K opens a palette when the rail is collapsed).",
      "One look: white cards on a light grey background in the new light theme, Geist type everywhere except the sidebar, search and Filter as one box on Tickets, Artifacts and the Prompt Library, and a tab icon that follows the app's theme. You can also delete a prompt or an artifact you made: a confirmation asks first (Enter confirms), and Undo brings it back. Get Started shows the new screens.",
    ],
    headsUp: [
      "The Roadmap's plan narrative is now limited to 800 characters, so it stays a short Now / Next / Later; the detail lives in each sprint.",
      "The Midnight theme is gone. If you had picked it, Canopy now opens in Dark.",
    ],
    ops: [
      "Apply migration `0035_library_and_sprint_dates` (one file) with `npm run db:migrate:remote` before this deploys.",
    ],
    patches: {
      added: [
        "`web/src/mywork.ts`: the My Work bento — Tickets for you, Needs your review, Your sessions, Repo (PRs / CI / Deploys tabs, PRs by default) and the Your library strip",
        "`web/src/timeline.ts`: Roadmap › Timeline as a Gantt graph — In progress / Upcoming / Done lanes, a today line, an Unscheduled list",
        "`GET /feed/stats?days=&tz=` (`src/tools/feed-stats.ts`, `shared/feed-stats.ts`) behind the Feed's This week box; Waiting on review reads the boot-loaded Review queue",
        "`asideColumns` in `web/src/ui.ts`: the two-column page with a sticky 360px aside, shared by Roadmap › Narrative and the Feed",
        "`.cnpy-surface` + `surface()`: the one card look, with `--surface` and `--shadow` theme tokens",
        "`searchFilterBar` in `web/src/filter-menu.ts`: search and Filter as one control on the ticket queue, the Artifacts library and the Prompt Library",
        "Migration `0035_library_and_sprint_dates`, PART A: `docs.owner`, `artifact_pages.published_at`, `prompts.use_count` / `last_used_at` (each backfilled); `prompts_fts_au` narrowed to the indexed columns",
        "`POST /api/prompts/:slug/used` (the web Copy button) and MCP `get_prompt` bump a prompt's use count; `GET /api/prompts?sort=used`",
        "Migration `0035_library_and_sprint_dates`, PART B: `sprints.start_date` (DTO `start`), backfilled only where `dates` gives an unambiguous start",
        "`sprintDatesProblem` (one sprint-date rule: real `YYYY-MM-DD` days, start ≤ due) and `sprintDueState` (one overdue rule) in `shared/sprints-core.ts`",
        "`web/src/favicon.ts`: the tab icon follows the app's resolved theme; `favicon-32.png` for browsers without SVG favicons",
        "`npm run watch:web`, which `npm run dev` now runs beside `wrangler dev`",
        "`GET /search/quick` (`src/tools/quick-search.ts`, `shared/quick-search.ts`): one D1 batch, FTS prefix matching, live-only visibility, a degraded read answers empty, never a 500",
        "`web/src/quicksearch.ts`: the sidebar search dropdown — debounced prefetch, abort, a 40-entry cache, a 1 s show delay, animated open and height, keyboard navigation",
        "Prompt soft delete: `POST /api/prompts/:slug/delete` and `/restore` (author or admin, session cookie, never MCP); the slug stays reserved; `web/src/confirm.ts` in-app confirm and an Undo toast",
        "Migration `0035_library_and_sprint_dates`, PART C: `prompts.deleted_at` / `deleted_by`; the `prompts_fts` triggers index live prompts only",
        "Artifact soft delete: `POST /api/artifacts/:slug/delete` and `/restore` (author or admin, session cookie, never MCP); a deleted page is the one byte-identical not-found on every surface, versions, links and R2 bytes kept; migration 0035 PART D (`artifact_pages.deleted_at` / `deleted_by`)",
        "`confirmModal` in `web/src/confirm.ts`: one confirmation dialog for destructive actions (Delete focused, Enter confirms once, Esc cancels, a bottom sheet on phones)",
        "Get Started and the landing page describe the new screens; screenshots recaptured in dark and light, plus Timeline, search and What's new figures",
      ],
      changed: [
        "My Work's Repo tile: PRs · CI · Deploys, opening on PRs; the environment-named drift tab is gone — drift stays on the Repo dashboard (#85)",
        "Review: a drafted decision's Proposed record card drops its green left edge (#85)",
        "Sidebar (light): the selected row is a white card, not a darker fill, and hover previews it; Tickets has no sub-page list — Board / Table / Submit a ticket are in its header (#86)",
        "My Work: Needs your review always holds its place and reads clear in it; Your sessions shows 2 sessions and 1 handoff; the Repo tile keeps one height across PRs / CI / Deploys (#86)",
        "Tickets table: 20px sides inside its card, no hairline under every row, category and priority as plain text (#86)",
        "My Work: with nothing to review, the clear Needs your review tile sits beside Repo instead of leading the page (#87)",
        "Tickets: every status moves to any other — Done and Declined are no longer terminal, so a resolved ticket drags (or is set) back to an open status; `tickets` skill, plugin 0.6.7 (#88)",
        "Light theme palette from the Claude Design `Canopy Restyled.dc.html` (cool neutral grey, indigo accent)",
        "`--label` is Geist everywhere except the sidebar, which keeps Archivo Narrow",
        "Roadmap: New sprint in the header; `#roadmap/timeline` in the URL; the rail's Narrative / Timeline sub-pages removed",
        "New sprint panel: native Start / Due date inputs instead of a free-text Dates field; `dates` is now a display label only",
        "`update_plan` refuses a narrative over 800 characters (`PLAN_NARRATIVE_MAX`) before its first write; `update-plan` / `read-plan` / `canopy` skills say so; plugin 0.6.6",
        "My Work's `tickets` lists assigned tickets of both sources (native and mirrored from GitHub), capped at 6, plus an uncapped `ticketsTotal`",
        "Repo DTO: `prs` is `{ rows, openCount }` and `ciFailures.total` counts every failure in the window, so My Work's Repo tile shows real counts",
        "Favicon: the original Canopy mark, with an indigo top bar in light and the green one in dark",
      ],
      fixed: [
        "`npm run dev` served stale or missing assets after a web rebuild; the watch keeps old bundles (`--emptyOutDir false`)",
        "A multi-word FTS query whose last word got stem-shortened alternatives came back empty; the terms are now joined with an explicit AND",
        "My Work › Your library: a narrow cell's header link (Queued handoffs' \"Handoffs →\") ran past the tile's edge and was clipped; the header row now wraps the link under its title (#85)",
        "What's new still tagged this release Unreleased after it deployed; it is v0.15, and the merging PR now cuts the version (#85)",
      ],
      removed: [
        "The Midnight theme and its Get Started screenshots",
      ],
    },
    prs: [84, 85, 86, 87, 88],
  },
  {
    version: "0.14",
    date: "2026-09-26",
    title: "Ticket board, feed briefs, New version for artifacts",
    headline: "Tickets open on a board you can drag to order, feed entries get a short brief for people, and artifacts get a New version button.",
    highlights: [
      "Tickets open on the Board. Drag a card to another column or to a new spot in its column; the order is saved for everyone.",
      "A new, optional Testing status sits between In progress and Done, and an open ticket can move to any other open status, Triage straight to Done included. Done and Declined stay final.",
      "The ticket queue has a search box and a Filter menu: assignee (anyone, me, unassigned or one person), category, priority and sprint.",
      "Feed entries carry a one- or two-sentence brief. The Feed opens For reading (title, brief and links); For agents shows the full record.",
      "Artifacts: New version on the viewer (edit the text or upload a replacement file), a green Org / purple Private switch, and text pages up to 750 KB.",
      "Labels, dates and badges use Archivo Narrow instead of Geist Mono; real code keeps a monospace face.",
    ],
    headsUp: [
      "Feed entries written before this release show only their title in For reading until their briefs are filled in.",
    ],
    ops: [
      "Apply migrations 0033 (rebuilds `tickets` and `ticket_events`) and 0034 (`feed.brief`, the artifact text cap) before the deploy.",
      "Fill older feed briefs with `scripts/backfill-feed-briefs.mjs` (dry run with `--limit 10`, then `--apply`).",
    ],
    prs: [77, 78, 79, 80, 81, 82, 83],
    patches: {
      added: [
        "`testing` ticket status and `tickets.board_rank`; `POST /tickets/:id/move {to, after_id}` (`move_ticket`) sets status and position in one batch (#78)",
        "Migration `0033_ticket_testing_rank`: rebuilds `tickets` and `ticket_events` to admit `testing`, carrying both AUTOINCREMENT counters over (#78)",
        "`boardOrder` / `placeInColumn` in `shared/tickets-core.ts`, one definition for the Worker and the optimistic drop (#78)",
        "`feed.brief` (at most 280 characters) on `append_feed`, `record_session` and `/ingest`; `query` leads a feed hit with `Brief:` (#83)",
        "Migration `0034_feed_brief_artifact_cap`: `feed.brief`, and `artifact_versions` rebuilt with a 768000-byte text CHECK (#83)",
        "`scripts/backfill-feed-briefs.mjs`: one-off Gemini backfill, dry run by default, `--apply` writes only `WHERE brief IS NULL` (#83)",
        "Artifact viewer New version dialog over `POST /api/artifacts/:slug/versions`: edit, restore an older version, or upload a same-type file (#82)",
        "`isBundledExport`: a FLATTEN FIRST warning for bundled Claude Design exports, on the web form and in MCP `warnings` (#81)",
        "`web/src/segmented.ts`: one segmented switch with a sliding indicator, used by all 20 pick-one switches (#83)",
        "`--purple` theme token (#79)",
      ],
      changed: [
        "Ticket queue opens on the Board with All selected; the Table is the other view (#78)",
        "Free moves between open statuses (`OPEN_STATUSES`); `done` / `declined` stay terminal (#78)",
        "Queue search and Filter menu (Assignee incl. one person, Category, Priority, Sprint) replace the two dropdowns (#78)",
        "Board drag is pointer-driven: a full-size copy follows the pointer and the other cards slide around a slot (#78)",
        "`tickets` skill for the new rules, plugin 0.6.3 (#78); `record-session` always writes a brief, body soft target ~2,500 characters, plugin 0.6.5 (#83)",
        "Artifact text cap 500 KB → 750 KB; `artifact_get` and `query` inline text only up to 64 KB (`content_omitted`, `include_content`) (#83)",
        "Feed: author, tag and time in one Filter menu; the For reading / For agents choice is saved per browser (#83)",
        "html card previews in the Artifacts library run with `sandbox=\"allow-scripts\"`, so script-rendered pages show (#83)",
        "`--mono` (Geist Mono) → `--label` (Archivo Narrow); new `--code` system monospace for real code; @handles in Geist (#77)",
        "Artifact visibility switch coloured in both states; making a page private shows a toast instead of a standing banner (#79)",
        "Toasts fade out, stay centred, and a newer toast is no longer cleared by an older one's timer (#79)",
        "Settings: the top tiles keep one height whatever the number of tokens; three-column layout (#77)",
      ],
      fixed: [
        "The Feed's time range now filters; the old range dropdown set state nothing read (#83)",
        "A refetch no longer replays the ticket board's entrance (#78)",
        "The prompt detail box runs to the bottom of the screen; Review's header chip and buttons are one height (#77)",
        "Typing deep in a long textarea no longer jumps it back to the top (#82)",
      ],
      removed: [
        "The Geist Mono webfont (#77)",
        "`blob:` scripts in the raw html CSP — added in #80, reverted (#81)",
        "The artifact PRIVATE banner and its Publish button (#79)",
      ],
    },
  },
  {
    version: "0.13",
    date: "2026-09-25",
    title: "GitHub issues become tickets",
    headline: "Every GitHub issue now shows up as a ticket, and any member can create, complete or delete a sprint.",
    highlights: [
      "Each issue in the Sapling repo appears as a ticket linked to its issue. After import the title, description, priority and assignees are Canopy's to edit; closing or reopening the issue on GitHub closes or reopens the ticket.",
      "The link back to the source issue is locked, so it can't be removed by accident.",
      "Any ticket's title and description can now be edited.",
      "Delete a sprint from its page; its tickets move to the backlog.",
      "Agents can create, complete and delete sprints for every member, as on the web. Only the whole-plan rewrite stays admin-only.",
      "The ticket queue's Assignee and Category filters are themed menus instead of the browser's own dropdowns.",
    ],
    ops: [
      "Apply migration 0032 before the deploy, then run Sync GitHub once to mirror the issues that are already open.",
    ],
    prs: [65, 75, 76],
    patches: {
      added: [
        "Migration `0032_ticket_source`: `tickets.source` / `source_ref` (partial UNIQUE) / `source_author` / `source_updated_at`, `ticket_links.locked`, the reserved `github-webhook` person (#75)",
        "`src/tools/ticket-mirror.ts`: `mirrorIssue` on every verified `issues` delivery and in Sync GitHub (open issues only) (#75)",
        "`edit_ticket`: `POST /tickets/:id/edit` and a lane-scoped MCP tool (#75)",
        "`delete_sprint`: `POST /sprints/:id/delete` and an MCP tool — a hard delete in one batch, tickets to the backlog (#65)",
        "`src/tools/issue-gone.ts`: a `deleted` / `transferred` issue counts as no longer open everywhere (#75)",
      ],
      changed: [
        "Sprint MCP writes (`create_sprint`, `set_sprint_active`, `complete_sprint`, `add_sprint_resource`, `delete_sprint`) registered for every principal; `update_plan` stays admin-only (#65)",
        "ADR-007 amended: a ticket may be sourced from a GitHub issue but is never the issue itself; plugin 0.6.1 (#75)",
        "My Work, the ticket badge, the ticketq digest and the Repo Open tickets tile read `source = 'canopy'`, so a mirrored issue is not counted twice (#75)",
        "Sidebar section labels in Archivo Narrow (#75)",
        "Queue Assignee / Category filters are menus (`role=\"listbox\"`) like the ticket screens' status menu (#76)",
      ],
      fixed: [
        "GitHub sends `SaplingLearn/Sapling`: the mirror's repo check ignores case and always keys on the configured spelling, so the webhook and Sync never create duplicates (#75)",
      ],
      removed: [
        "The two native `<select>` filters on the ticket queue (#76)",
      ],
    },
  },
  {
    version: "0.12",
    date: "2026-09-24",
    title: "Browser sign-in for agents, images in docs",
    headline: "Agents connect to Canopy by signing in through the browser, and docs can carry images.",
    highlights: [
      "Claude Code connects by browser sign-in: run /mcp, choose Authenticate and approve on Canopy's consent page. No token to paste.",
      "Settings › MCP access lists the apps you've connected, and you can revoke any of them.",
      "Docs can contain images an agent uploads; click one to open it full size.",
      "Review's Rendered view shows a proposal's images, outlined green when added and dimmed red when removed.",
    ],
    ops: [
      "Apply migrations 0029 (OAuth) and 0031 (doc images) on production.",
      "MCP `artifact_create` is renamed `upload_asset` with no alias: agents update the plugin with `/plugin marketplace update canopy`.",
    ],
    prs: [74],
    patches: {
      added: [
        "MCP OAuth phase 1: RFC 9728 / 8414 metadata, RFC 7591 client registration, authorization code with S256 PKCE, a consent page on every authorization, rotating refresh tokens (migration `0029_oauth`)",
        "`/mcp` accepts `canopy_oat_` access tokens; its 401 carries `WWW-Authenticate` with `resource_metadata`",
        "Settings › Connected apps: `GET /auth/oauth-grants`, `POST /auth/oauth-grants/:id/revoke`",
        "Sign-in and onboarding resume a pending authorize request; `pruneOAuth` on the repo cron's `:30` tick",
        "Migration `0031_doc_images`: `doc_images` and `doc_image_upload_tokens`; bytes in R2 at `doc-images/<sha256>` (#74)",
        "`GET /img/<sha>`: session cookie, `nosniff`, sandbox CSP, immutable cache (#74)",
      ],
      changed: [
        "MCP `artifact_create` renamed `upload_asset`, with `destination: \"artifact\" | \"doc\"` (#74)",
        "`ingestDocProposal` refuses a body whose `/img/` ref is not uploaded or that uses any other image source (outcome `refused`, not ledgered) (#74)",
        "Plugin 0.5.0 signs in by browser; 0.6.0 for `upload_asset` (#74)",
        "The OAuth pages wear the landing page's sign-in dialog",
      ],
      fixed: [],
      removed: [
        "MCP tool `artifact_create`, with no alias (#74)",
      ],
    },
  },
  {
    version: "0.11",
    date: "2026-09-24",
    title: "Artifacts",
    headline: "Canopy stores, versions and shares the pages agents produce: specs, reports, designs, diagrams, images, PDFs and files.",
    highlights: [
      "Knowledge › Artifacts: browse pages, open one, compare two versions and ratify the one you stand behind.",
      "Agents publish, list, read and download artifacts, and link them to the ticket or sprint they came from.",
      "A ticket's page lists its artifacts, and a page can be kept private to its author.",
      "The ticket page is laid out like the sprint page: the title on the left, the properties rail beside it, the requester and opened date in the rail.",
      "Get Started is an onboarding path with an On this page list; every figure opens in a lightbox.",
    ],
    ops: [
      "Apply migration 0030, and create the R2 bucket `canopy-artifacts` (`wrangler r2 bucket create canopy-artifacts`) before the first deploy with the binding.",
    ],
    prs: [71, 72, 73],
    patches: {
      added: [
        "Migration `0030_artifacts`: `artifact_pages`, `artifact_versions`, `artifact_links`, `artifact_upload_tokens`, `artifacts_fts`; R2 binding `ARTIFACTS_BUCKET` (#72)",
        "`/api/artifacts/*` routes, `/raw/a/:slug[@vN]` with a per-kind CSP, the token upload `PUT`, an SSRF-guarded From-URL fetch (#72)",
        "MCP `artifact_list`, `artifact_get` (a signed 5-minute `download_url` + sha256), `artifact_create`, `artifact_update`; `query` type `artifact`; `artifact_links` on `record_session` and `/ingest` (#72)",
        "`artifacts` skill and plugin 0.4.0; `docs/artifact-contract.md` and `AGENTS.md` (#72)",
        "`web/src/lightbox.ts`; Get Started's On this page rail with scrollspy (#73)",
      ],
      changed: [
        "Ticket detail: status is set only from the rail; REQUESTER and OPENED rows (#71)",
        "Prompt Library shows three cards a row on a wide window (#71)",
        "Landing page: Handoffs and Artifacts tour rows, Prompt Library and Repo cards, the updated tool list (#73)",
      ],
      fixed: [
        "html / svg opened in their own tab ran script on Canopy's origin; the raw CSP adds `sandbox allow-scripts` (#72)",
        "A binary 1 byte over 10 MB returned 400 instead of 413 `too_large` (#72)",
      ],
      removed: [],
    },
  },
  {
    version: "0.10",
    date: "2026-09-23",
    title: "Handoffs and the Prompt Library",
    headline: "A session can hand its work to the next one, the team gets a shared library of prompts, and connecting an agent is one button.",
    highlights: [
      "Handoffs: leave where a task stands for the next session, yours or anyone's. The next session claims it and starts from that context. Unclaimed handoffs expire after 7 days.",
      "Prompt Library: versioned, reusable prompts with {{variables}}. An agent can only stage a prompt; a person publishes it.",
      "Settings › Get connection command mints a token and shows the exact setup for Claude Code, Codex, a .mcp.json file or the bare token.",
      "A link can be removed from a ticket: hover it and choose ⋯ › Remove link.",
      "Docs › New doc lets a person propose a new doc from the web, and Maintenance has tabs: Unplaced, Identity and People.",
      "Get Started now covers tickets, sprints and the Repo dashboard.",
    ],
    ops: [
      "Apply migration 0028 before the deploy.",
    ],
    prs: [66, 67, 68, 69],
    patches: {
      added: [
        "Migration `0028_handoffs_prompts`: `handoffs`, `prompts`, `prompt_versions`, `prompts_fts` (#69)",
        "`/api/handoffs*`, `/api/prompts*` and `POST /api/docs/propose` (session cookie) (#69)",
        "MCP `send_handoff`, `list_handoffs`, `get_handoff`, `claim_handoff`, `expire_handoff`, `search_prompts`, `get_prompt`, `save_prompt` (always staged) (#69)",
        "`handoff` and `prompts` skills; `load-context` lists waiting handoffs at session start (#69)",
        "`expireDueHandoffs` on every repo cron tick (#69)",
        "`remove_ticket_link` and `POST /tickets/:id/links/:linkId/remove` (#67)",
        "The Get connection command modal (`connectModal` / `connectSnippet`) (#66)",
      ],
      changed: [
        "The ticket page is centred in a 1120px shell; the sprint page shows its tickets as cards; Enter or a pasted link adds a link (#66)",
        "Settings: Appearance above Email notifications (#66)",
        "`scripts/capture-guide.mjs` moves to Playwright; 15 surfaces in 3 themes (#68)",
      ],
      fixed: [],
      removed: [
        "Settings' Mint new token button and inline token reveal, replaced by Get connection command (#66)",
      ],
    },
  },
  {
    version: "0.9",
    date: "2026-09-21",
    title: "The Repo dashboard",
    headline: "Monitor › Repo shows what the code, CI, deploys and the running app are doing, and says so when a source isn't connected instead of guessing.",
    highlights: [
      "Five tabs, Overview, Code, CI, Usage and Planning: environments and deploys, branch drift, health checks, PRs and commits, CI failures, coverage, bundle size, traffic, hosting and product metrics.",
      "A section with no data reads \"not connected\" and names what it is waiting for, never a made-up zero. Preview with sample data shows the finished design.",
      "Admins can Poll now to refresh health, usage and GitHub on demand, with one line per source saying what answered.",
      "Agents can read the dashboard too.",
      "A new sidebar: Workspace, Monitor, Knowledge, Triage and Help sections, a search box with ⌘K, sub-pages, and a rail that collapses smoothly.",
      "Tighter corners across the app, and feed entries render as formatted text.",
    ],
    ops: [
      "Apply migration 0027 before the deploy.",
      "Subscribe the target repo's webhook to deployment statuses, check runs, workflow runs, pull request reviews and statuses; set each usage source's secrets (`CF_ANALYTICS_*`, `RAILWAY_TOKEN_*`, `SAPLING_METRICS_TOKEN`).",
      "The cron is now `*/10 * * * *`: run `wrangler triggers deploy` after the merge.",
    ],
    prs: [53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63],
    patches: {
      added: [
        "`GET /repo/dashboard` → `getRepoDashboard`: D1-only, never a 500 (#53)",
        "`web/src/morph.ts` patches the `<aside>` in place; `web/src/sidebar.ts` emits a stable element tree (#53)",
        "Migration `0027_repo_capture`: `repo_events`, `repo_snapshots`, `repo_metrics`; the `ingestRepoEvent` gate (#54)",
        "`reconcileRepo`: service-token backfill and self-heal (#54, #55)",
        "Capture for `deployment_status`, `check_run`, `workflow_run`, `pull_request_review`; `fillFailedJob` (#55)",
        "Drift and branches snapshots, health pings and the `*/10` repo cron (#56)",
        "`canopy/coverage`, `canopy/bundle-kb` and `canopy/todo` commit statuses → `repo_metrics` via `metricsFromStatus` (#57)",
        "Hourly pollers `pollCloudflare`, `pollRailway`, `pollSaplingMetrics` (#58)",
        "`POST /admin/poll-usage` (#59), then `POST /admin/poll` → `runRepoRefresh` behind a `refresh_lock` (#62)",
        "Product metrics (contract v2), `putMetrics`, `productReadings` (#60, #61)",
        "MCP `get_repo_dashboard`; `reconcileRepo` `statuses` and `reviews` arms (#62)",
      ],
      changed: [
        "Usage tab: one Product section with an environment switch, headline tiles, a shape per group (#63)",
        "Every radius renders at `--corner-scale` (0.4), pinned by `test/render.corners.test.ts` (#63)",
        "Feed entry bodies render through the sanitised markdown pipeline; `record-session` defines the feed entry types and limits (#62)",
        "The Search nav row became the sidebar search box (⌘K / Ctrl+K) (#53)",
      ],
      fixed: [
        "The test suite called the live Gemini API through `.dev.vars`; the vitest pool now blanks every network secret (#58)",
        "A token could survive in part when a vendor error was cut before scrubbing; scrub first, then cut (#60)",
        "A manual health ping is stamped to the second, so a real DOWN reading is no longer dropped (#62)",
      ],
      removed: [
        "The half-landed Corners preference (#63)",
      ],
    },
  },
  {
    version: "0.8",
    date: "2026-09-19",
    title: "Landing page and a one-screen Settings",
    headline: "Signed-out visitors see a product page, Settings fits on one screen, and you can see and revoke your MCP tokens.",
    highlights: [
      "A landing page replaces the bare sign-in card; Sign in (GitHub or Google) opens as a dialog.",
      "Settings is a bento: Profile, Account and MCP access tokens on top, email notifications and appearance below.",
      "Your MCP tokens are listed by their first characters with minted and last-used times, and each can be revoked.",
      "The sidebar logo reopens the landing page, and its nav takes you back to where you were.",
      "Canopy is licensed under the AGPL v3.",
    ],
    ops: [
      "Apply migration 0026 before the deploy.",
    ],
    prs: [49, 50],
    patches: {
      added: [
        "`web/src/landing.ts` (from `Canopy Site.dc.html`) and `web/src/landing-motion.ts` scroll reveals (#49)",
        "Migration `0026_token_hint`; `GET /auth/mcp-tokens` and `POST /auth/mcp-tokens/:id/revoke` (#50)",
        "The `#site` route (#50)",
        "The AGPL v3 license",
      ],
      changed: [
        "Sign out lands on `/` instead of leaving `/#settings` as a return-to (#50)",
        "The sign-in dialog says Canopy is for the Sapling team and which provider is for whom (#50)",
        "Settings folds on container queries (#50)",
      ],
      fixed: [],
      removed: [],
    },
  },
  {
    version: "0.7",
    date: "2026-09-18",
    title: "Tickets and sprints",
    headline: "One ticket queue the whole team files into, with sprints as the Roadmap's containers.",
    highlights: [
      "File a ticket, assign people, add sub-tickets, link the work (GitHub, Figma, anything) and discuss it in a thread.",
      "The queue shows as a table or a board, and the sidebar counts tickets nobody has picked up.",
      "Milestones became sprints. Each sprint has a page with its tickets, resources and progress, and a person confirms it done.",
      "My Work lists the tickets assigned to you, and there is a Ticket queue email digest.",
      "Agents can file tickets and work the ones assigned to their person: status, comments, links, sprint and parent.",
      "New members land on Get Started and get a welcome email.",
    ],
    ops: [
      "Apply migrations 0024 and 0025 before the deploy; 0025 renames `milestones` to `sprints`, so old and new code each break on the other's schema.",
    ],
    prs: [44, 47, 48],
    patches: {
      added: [
        "Migrations `0024_tickets` (tickets, assignees, links, comments, events, `tickets_fts`) and `0025_sprints` (#44)",
        "Ten `/tickets` and six `/sprints` session-cookie routes; tickets in `/search` (#44)",
        "MCP reads `list_tickets`, `get_ticket`, `list_sprints`, `get_sprint` (#44)",
        "The `ticketq` digest kind (#44)",
        "`src/tools/tickets-agent.ts` (the lane rule) and MCP `create_ticket`, `transition_ticket`, `add_ticket_comment`, `add_ticket_link`, `set_ticket_sprint`, `set_ticket_parent`; admin sprint tools; the `tickets` skill (#48)",
        "Welcome email, `src/notifications/welcome.ts` (#47)",
      ],
      changed: [
        "`milestones` renamed `sprints` in place; `milestone_progress` → `sprint_progress` (#44)",
        "`submitted` displays as Triage; status is set from a status menu; `in_progress → declined` is allowed (#47)",
        "Ticket screens take the full width (`WORK_SHELL`) (#47)",
        "Finishing onboarding lands on `#guide` (#47)",
      ],
      fixed: [
        "A long sprint name pushed the new-ticket form's sprint chip past the card; the form uses the rail's sprint menu (#47)",
      ],
      removed: [
        "`milestone_proposals` and the agent-proposed roadmap surface (#44)",
      ],
    },
  },
  {
    version: "0.6",
    date: "2026-09-16",
    title: "Google sign-in and people",
    headline: "Teammates without GitHub can sign in with Google, and an account is now a person rather than a GitHub login.",
    highlights: [
      "Continue with Google, for teammates an admin has invited by email.",
      "Choose your handle and colour when you first sign in, and rename your handle later in Settings.",
      "Link GitHub and Google to one account from Settings.",
      "Names show in each person's colour across the app.",
      "Every email opens with the same Canopy band, and the invite explains what Canopy is.",
    ],
    headsUp: [
      "Your GitHub login became your handle. You can pick a different one in Settings › Profile.",
    ],
    ops: [
      "Migration 0023 replaces `users` and `people` with `persons` — a one-way cutover: migrate, then deploy.",
    ],
    prs: [41, 42, 43],
    patches: {
      added: [
        "Migration `0023_persons`: `persons`, `identities`, `invites`; `sessions` / `mcp_tokens` repointed to `persons.handle` (#41, #42)",
        "`src/auth/google.ts` (PKCE, JWKS-verified ID token) and `src/auth/onboard.ts` (`completeSignIn`); the `#onboard` screen (#41)",
        "Admin invite routes and the invite email (#41)",
        "`POST /auth/me/handle`, rewriting every `HANDLE_COLUMNS` column in one batch (#41)",
        "Settings › Profile and Maintenance › People (#41)",
      ],
      changed: [
        "`Principal` is `{ handle }`; event subjects resolve to a person through the github identity (#41)",
        "One shared `emailBanner`; emails 680px wide (#43)",
        "The invite link opens Canopy's sign-in screen instead of Google's account chooser (#43)",
      ],
      fixed: [
        "Three notification retry tests failed once their fixed date aged out; the fixture is stamped relative to now (#42)",
      ],
      removed: [
        "The `users` and `people` tables (#41)",
      ],
    },
  },
  {
    version: "0.5",
    date: "2026-09-13",
    title: "Email digests",
    headline: "Canopy emails a daily or weekly digest of your work, the review queue and roadmap changes.",
    highlights: [
      "Digests for My Work, the Review queue and Roadmap plan changes, each daily, weekly or off in Settings › Email notifications.",
      "One-click unsubscribe in every email.",
      "Admins set the defaults and the send hour under Maintenance › Notifications, preview a digest and send a test to themselves.",
      "Emails use Canopy's own look, with a dark version where the mail client supports one.",
      "Clicking a button low on a long screen no longer jumps the page back to the top.",
    ],
    headsUp: [
      "The next time you sign in with GitHub, you'll be asked to let Canopy see your email address, so digests can reach you.",
    ],
    ops: [
      "Apply migrations 0021 and 0022; the OAuth scope adds `user:email`, so existing sessions re-consent on their next sign-in.",
    ],
    prs: [34, 35, 36, 37, 38, 39],
    patches: {
      added: [
        "`src/notifications/`: registry, renderers (`my_work`, `review_queue`, `roadmap_plan`), resolver, run assembler, retry, Resend delivery (#34)",
        "Migrations `0021_notifications` and `0022_notification_bodies` (#34)",
        "Two hourly digest triggers, gated in code on `send_hour` and the org timezone (#34)",
        "`/u/<login.sig>` one-click unsubscribe (#34)",
        "`GET /api/notifications/preview` and `POST /api/notifications/test-send` (#37)",
        "`web/src/scroll.ts` keeps the main pane's scroll across rerenders (#38)",
      ],
      changed: [
        "`NOTIFICATIONS_MODE = \"resend\"` in production (#36)",
        "The digest is styled on the site's theme tokens, with a `prefers-color-scheme: dark` block (#39)",
      ],
      fixed: [
        "The weekly trigger is `0 * * * SUN,MON`; Cloudflare's weekdays are 1–7, never 0 (#35)",
      ],
      removed: [],
    },
  },
  {
    version: "0.4",
    date: "2026-07-10",
    title: "Structured summaries and a new Docs reader",
    headline: "My Work cards get structured summaries, Docs is rebuilt around Technical and Product, and a reload keeps you on the same page.",
    highlights: [
      "Cards on My Work read as labelled rows: what changed, why and the impact for a PR; a summary and the next step for an issue.",
      "Summaries now come from Google Gemini.",
      "Docs has Technical and Product spaces; each page expands to its own headings, and the outline follows your scroll.",
      "The screen you're on is in the URL, so a reload stays there.",
      "Get Started is a tour of every screen with fresh screenshots.",
    ],
    ops: [
      "Apply migrations 0018, 0019 and 0020.",
    ],
    prs: [19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33],
    patches: {
      added: [
        "Migrations `0018_structured_summaries`, `0019_drop_pr_summary`, `0020_docs_space_vocab` (#22, #27, #33)",
        "Local dev seed: `npm run seed`, `fixtures/dev/*.json`, `scripts/seed/` (#21)",
        "`web/src/outline.ts` and the Docs reader's heading scrollspy (#25, #29)",
        "`scripts/capture-guide.mjs` (#32)",
      ],
      changed: [
        "Summarizer: Workers AI → Gemini `gemini-2.5-flash-lite` over REST (`GEMINI_API_KEY`), with a timeout (#28)",
        "PR cards are structured-only (What changed / Why / Impact), else \"No summary recorded\" (#27)",
        "Sync GitHub summarizes issues before PRs (#23)",
        "My Work cards in an even 2×3 grid (#24)",
        "Doc `space` is a fixed `{technical, product}` vocabulary; an off-vocab value is rejected at the tool boundary (#33)",
        "The screen is in the URL hash and restored on boot (#29)",
      ],
      fixed: [
        "Sync GitHub reported 0 of 0 on a bad GitHub token; it now fails with the status (#19)",
        "Issue summaries reached the client but never showed on To-do cards (#20)",
        "A hung Workers AI call could wedge Sync GitHub; calls now time out (#26)",
        "Feed chips showed a full PR URL or a 40-character SHA; they show `#321` and 7 characters (#31)",
      ],
      removed: [
        "The prose `pr_summaries.summary` column (#27)",
        "The Workers AI `[ai]` binding (#28)",
      ],
    },
  },
  {
    version: "0.3",
    date: "2026-07-04",
    title: "My Work, Roadmap and Triage rebuilt",
    headline: "My Work and the Roadmap read captured GitHub activity instead of calling GitHub live, and Triage becomes Review and Maintenance.",
    highlights: [
      "My Work shows your open assigned issues and your recently merged PRs, each summarized once when it is captured.",
      "The Roadmap is an admin-written plan: a narrative plus milestones with progress.",
      "Admins get Sync GitHub to backfill PRs and issues, with a progress bar.",
      "Review is one queue for agent proposals and draft decisions, with unified, side-by-side and rendered diffs. Maintenance holds unplaced items and unknown GitHub logins.",
      "Triage items show when they were staged.",
    ],
    ops: [
      "Apply migrations 0012–0017, set the `GITHUB_WEBHOOK_SECRET` and `GITHUB_SERVICE_TOKEN` secrets, and add the GitHub webhook on the Sapling repo (pull requests + issues).",
    ],
    prs: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    patches: {
      added: [
        "`/webhook/github` (HMAC `X-Hub-Signature-256`) → `ingestEvent` into `events`; capture-time PR summaries; the progress cache and its cron backstop (#8)",
        "Migrations `0012_events_plan`, `0013_roadmap_fts`, `0014_drop_focus`, `0015_drop_user_token` (#8), `0016_identity_tasks` (#14, #16), `0017_issue_summaries` (#18)",
        "MCP `update_plan`, `get_my_work`, `get_events`; the `read-plan`, `update-plan` and `my-work` skills (#8)",
        "`POST /admin/backfill` and `ADMIN_LOGINS`; `update_plan` admin-only (#9)",
        "The issue summarizer (#18)",
        "`GET /identity-tasks` and `POST /identity-tasks/:login/map` (#16)",
        "`web/src/review.ts`, `web/src/maintenance.ts`, `web/src/triage-map.ts` (#15, #17)",
      ],
      changed: [
        "My Work: To-do first, previous activity capped at the 5 latest PRs (#10, #11)",
        "Sync GitHub caps AI summaries per batch and chains batches behind a progress modal (#14)",
      ],
      fixed: [
        "The Workers AI summarizer model had been retired; switched model and response shape (#12)",
      ],
      removed: [
        "`focus`, `set_focus` and `propose_milestone`; the per-user `users.github_token` (#8)",
        "The four-tab Triage screen (#15)",
      ],
    },
  },
  {
    version: "0.2",
    date: "2026-07-01",
    title: "The Canopy plugin",
    headline: "Canopy's skills and MCP connection install together as one Claude Code plugin.",
    highlights: [
      "Install Canopy into Claude Code as one plugin from the SaplingLearn/canopy marketplace: the skills arrive and the connection to Canopy is set up for you.",
      "Milestone proposals get their own Triage queue with Promote and Reject.",
      "Searching from an agent works again.",
    ],
    ops: [
      "Apply migration 0011.",
    ],
    prs: [5, 6, 7],
    patches: {
      added: [
        "`plugins/canopy/` and `.claude-plugin/marketplace.json` — `/plugin marketplace add SaplingLearn/canopy`, `/plugin install canopy@canopy`; `.claude/skills/*` symlink into the plugin (#5)",
        "`POST /milestone-proposals/:id/reject` and a Milestones Triage queue (#6)",
        "Migration `0011_fts_recreate` (#7)",
      ],
      changed: [],
      fixed: [
        "`query` failed in production with `no such table: docs_fts` (#7)",
      ],
      removed: [],
    },
  },
  {
    version: "0.1",
    date: "2026-06-29",
    title: "The shared context store",
    headline: "The first Canopy: agents propose context through a gate, people confirm it, and all of it is searchable.",
    highlights: [
      "Sign in with GitHub, for members of the Sapling org.",
      "Feed, Docs, Roadmap, Search, Triage and a first My Work screen.",
      "Agents connect over MCP with a personal token: they search, propose doc changes, add to the feed, and record a whole session in one call.",
      "An agent's proposal waits in Triage until a person promotes, ratifies or rejects it.",
      "Light and dark themes, a Midnight theme, and a Get Started page.",
    ],
    prs: [1, 2, 3, 4],
    patches: {
      added: [
        "The Worker: Hono routes, the `/ingest` gate (`consume()`), a stateless MCP server at `/mcp` (bearer only)",
        "GitHub OAuth with PKCE, D1 sessions, hashed MCP tokens",
        "The web SPA wired to the real routes (#1)",
        "FTS5 `query` engine with authority flags (`0008_fts`); the `load-context` skill (#2)",
        "Replay ledger, content-hash dedupe, `change_kind` / `base_version` (`0009_reconcile`) (#2)",
        "Triage write-back — reject, discard, assign — and `GET /proposals` (`0010_triage_resolve`) (#2)",
        "MCP `record_session` over the same gate as `/ingest` (#3)",
      ],
      changed: [
        "The `record-session` skill calls the `record_session` tool instead of `POST /ingest` (#3, #4)",
      ],
      fixed: [
        "Stored XSS through an agent-controlled doc slug in Triage (#2)",
      ],
      removed: [],
    },
  },
];

// ── rendering ────────────────────────────────────────────────────────────────
// Three pages, all the `releases` screen:
//   #releases                  → the index: a grid of release cards, newest first
//   #releases/<v>              → one release's notes (highlights, Heads-up)
//   #releases/<v>/patches      → the same release's patch notes (Added / Changed / …)
// `<v>` is `releaseSlug`: the version ("0.14"), or "unreleased". Cards, the back link
// and the newer/older links are real `<a href="#…">` (the hash is the route, so Back
// works); the page's Release notes / Patch notes switch is a `segmented()`.

export type ReleasePage = "notes" | "patches";

/** A release's URL segment: its version, or "unreleased". */
export const releaseSlug = (r: Pick<Release, "version" | "unreleased">): string =>
  r.unreleased ? "unreleased" : r.version.toLowerCase();

/** The release a URL segment names, or null. */
export function findRelease(slug: string, releases: readonly Release[] = RELEASES): Release | null {
  const s = slug.toLowerCase();
  return releases.find((r) => releaseSlug(r) === s) ?? null;
}

/** The hash of a releases page (the index when `slug` is null). */
export function releaseHash(slug: string | null, page: ReleasePage = "notes"): string {
  if (!slug) return "#releases";
  return `#releases/${encodeURIComponent(slug)}${page === "patches" ? "/patches" : ""}`;
}

/** The anchor id of a release (kept for links into a card). */
export const releaseAnchor = (r: Pick<Release, "version">): string =>
  `rel-${r.version.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-26" → "Sep 26, 2026" (no Date parsing, so no timezone drift). */
export function releaseDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const mo = MONTHS[Number(m[2]) - 1];
  return mo ? `${mo} ${Number(m[3])}, ${m[1]}` : iso;
}

const prLink = (n: number): string =>
  `<a href="${attr(prUrl(n))}" target="_blank" rel="noopener noreferrer" class="cnpy-rel-pr">#${n}</a>`;

/** One line of text: escaped, `code` in backticks as <code>, and a `(#123)` /
 *  `(#1, #2)` group as links to those pull requests (a bare `#12` stays text). */
export function releaseLine(text: string): string {
  return esc(text)
    // A short token (a name, a flag) never breaks mid-way; a long path may wrap.
    .replace(/`([^`]+)`/g, (_m, c: string) => `<code${c.length <= 28 ? ' class="is-short"' : ""}>${c}</code>`)
    .replace(/\((#\d+(?:, #\d+)*)\)/g, (_m, refs: string) =>
      `(${refs.split(", ").map((r) => prLink(Number(r.slice(1)))).join(", ")})`);
}

const GROUPS: { key: keyof ReleasePatches; label: string; tone: string }[] = [
  { key: "added", label: "Added", tone: "var(--green)" },
  { key: "changed", label: "Changed", tone: "var(--blue)" },
  { key: "fixed", label: "Fixed", tone: "var(--amber)" },
  { key: "removed", label: "Removed", tone: "var(--red)" },
];

const patchCount = (r: Release): number =>
  r.patches.added.length + r.patches.changed.length + r.patches.fixed.length + r.patches.removed.length;
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "v0.14 · Sep 26, 2026", or the Unreleased tag. */
function metaRow(r: Release): string {
  const inner = r.unreleased
    ? `${stateMark("Unreleased", "var(--accent)", "ring", 12, "Merged, not deployed yet.")}<span aria-hidden="true">·</span><span>Not deployed yet</span>`
    : `<span class="cnpy-rel-ver">v${esc(r.version)}</span><span aria-hidden="true">·</span><time datetime="${attr(r.date)}">${esc(releaseDate(r.date))}</time>`;
  return `<div class="cnpy-rel-meta">${inner}</div>`;
}

const ARROW_L = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"></path></svg>`;
const ARROW_R = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>`;

// ── the index ────────────────────────────────────────────────────────────────

function indexCard(r: Release, i: number): string {
  // Release notes are for users: no PR count here (the patch notes carry the PRs).
  const counts = `${plural(r.highlights.length, "highlight")} · ${plural(patchCount(r), "patch line")}`;
  return `<a href="${attr(releaseHash(releaseSlug(r)))}" aria-label="${attr(`${r.unreleased ? "Unreleased" : `v${r.version}`}: ${r.title}`)}"${surface(`--i:${Math.min(i, 8)}`, { hover: true, cls: `cnpy-relcard cnpy-rise${r.unreleased ? " is-next" : ""}` })}>
    ${metaRow(r)}
    <h2 class="cnpy-relcard-title">${esc(r.title)}</h2>
    <p class="cnpy-relcard-headline">${esc(r.headline)}</p>
    <div class="cnpy-relcard-foot"><span>${counts}</span><span class="cnpy-relcard-go" aria-hidden="true">${ARROW_R}</span></div>
  </a>`;
}

/** `#releases`: every release as a card, newest first. */
export function releasesIndex(releases: readonly Release[] = RELEASES): string {
  return `<div class="cnpy-relidx">
    <div class="cnpy-relidx-head">
      <h1 class="cnpy-relidx-title">What's new in Trov</h1>
      <p class="cnpy-relidx-intro">Every release, newest first. Open one for its notes, and switch to Patch notes for the full list of changes with links to the pull requests on <a href="${attr(TROV_REPO_URL)}" target="_blank" rel="noopener noreferrer" class="cnpy-rel-pr">GitHub</a>. Trov is open source under AGPL-3.0: <a href="${SOURCE_PATH}" target="_blank" rel="noopener" class="cnpy-rel-pr" data-source-link>the source code of the version you are using</a>.</p>
    </div>
    <div class="cnpy-relgrid">${releases.map(indexCard).join("")}</div>
  </div>`;
}

// ── one release ──────────────────────────────────────────────────────────────
// A release's two pages are ONE wide document: the header (back link, version /
// date / tag, title, lede, the Release notes / Patch notes switch) on the page
// background, then the whole body in a SINGLE full-width surface card — two columns
// for the notes (highlights | Heads-up + at a glance), the four patch groups side by
// side — with hairlines between sections and no box inside it. Newer / older links
// sit under the card. Everything stacks to one column on a narrow page.

/** A release page's Release notes / Patch notes switch — on the page header's back-link row. */
export function releasePageSwitch(page: ReleasePage): string {
  return segmented({
    id: "release-page", ariaLabel: "Release page", act: "releasePage", value: page, inertOn: true,
    options: [{ value: "notes", label: "Release notes" }, { value: "patches", label: "Patch notes" }],
  });
}

const dot = (tone: string): string =>
  `<span style="width:7px;height:7px;border-radius:50%;background:${tone};flex:none"></span>`;

function docHead(r: Release, page: ReleasePage): string {
  // The PR count shows on the patch notes only (release notes are for users).
  const facts = `${plural(r.highlights.length, "highlight")} · ${plural(patchCount(r), "patch line")}${page === "patches" && r.prs?.length ? ` · ${plural(r.prs.length, "pull request")}` : ""}`;
  // The page's note sits in the header, to the right of the title block: the Heads-up on the
  // release notes, the Upgrade notes on the patch notes. Below ~900px of page it drops under
  // the lede (trov.css, a container query). The Release notes / Patch notes switch sits on
  // the back link's row, right-aligned — its right edge on the note's.
  const note = page === "notes" ? headsUp(r) : upgradeNotes(r);
  return `<header class="cnpy-reldoc-head cnpy-rise${note ? " has-heads" : ""}">
    <div class="cnpy-reldoc-toprow">
      <a href="#releases" class="cnpy-rel-back">${ARROW_L}All releases</a>
      ${releasePageSwitch(page)}
    </div>
    <div class="cnpy-reldoc-head-main">
      ${metaRow(r)}
      <h1 class="cnpy-reldoc-title">${esc(r.title)}</h1>
      <p class="cnpy-reldoc-lede">${releaseLine(r.headline)}</p>
      <span class="cnpy-reldoc-facts">${facts}</span>
    </div>
    ${note}
  </header>`;
}

const INFO = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" style="flex:none"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 7.5v.5"></path></svg>`;
const WRENCH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" style="flex:none"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`;

/** A note in the page header, right of the title block: a small icon + label over a short list
 *  (one item is one paragraph) — compact and calm. Omitted when there are no lines. */
function headerNote(label: string, icon: string, lines: readonly string[]): string {
  if (!lines.length) return "";
  const body = lines.length === 1
    ? `<p class="cnpy-relheads-one">${releaseLine(lines[0])}</p>`
    : `<ul class="cnpy-relheads-list">${lines.map((h) => `<li>${releaseLine(h)}</li>`).join("")}</ul>`;
  return `<aside class="cnpy-relheads" aria-label="${attr(label)}" style="border-radius:6px"><span class="cnpy-relheads-l">${icon}${esc(label)}</span>${body}</aside>`;
}

/** The release notes' Heads-up (user-facing changes). */
const headsUp = (r: Release): string => headerNote("Heads-up", INFO, r.headsUp ?? []);

/** The patch notes' Upgrade notes (`ops`): what whoever deploys must do. */
const upgradeNotes = (r: Release): string => headerNote("Upgrade notes", WRENCH, r.ops ?? []);

/** The patch notes' PR line: one quiet chip per pull request. */
function prChips(r: Release): string {
  return r.prs?.length
    ? r.prs.map((n) => `<a href="${attr(prUrl(n))}" target="_blank" rel="noopener noreferrer" class="cnpy-relpr-chip" style="border-radius:5px">#${n}</a>`).join("")
    : `<span style="color:var(--fg-40)">None recorded</span>`;
}

/** Release notes, one column in one card: the "At a glance" strip (version, date, and the
 *  change counts as large figures — each opens that group on the patch notes), then the
 *  highlights (the Heads-up lives in the page header, `docHead`) —
 *  in two balanced columns when there are LONG_HIGHLIGHTS or more and the card is very
 *  wide (trov.css, a container query). */
const LONG_HIGHLIGHTS = 5;
function notesDoc(r: Release): string {
  const slug = releaseSlug(r);
  const fact = (label: string, value: string) =>
    `<div class="cnpy-relglance-fact"><span class="cnpy-relglance-lab">${label}</span><span class="cnpy-relglance-val">${value}</span></div>`;
  const stats = GROUPS.filter((g) => r.patches[g.key].length).map((g) =>
    `<button type="button" data-act="releaseGroup" data-arg="${g.key}" class="cnpy-relstat" style="border-radius:6px" title="${attr(`${g.label} — open on the patch notes`)}">
      <span class="cnpy-relstat-n">${r.patches[g.key].length}</span>
      <span class="cnpy-relstat-l">${dot(g.tone)}${g.label}</span>
    </button>`).join("");
  const glance = `<section class="cnpy-relglance" aria-label="At a glance">
      ${fact("Version", r.unreleased ? "Unreleased" : `v${esc(r.version)}`)}
      ${fact(r.unreleased ? "Last updated" : "Released", esc(releaseDate(r.date)))}
      <div class="cnpy-relglance-stats">${stats}</div>
      <a href="${attr(releaseHash(slug, "patches"))}" class="cnpy-rel-pr cnpy-relglance-all">All ${plural(patchCount(r), "patch line")}${ARROW_R}</a>
    </section>`;
  return `${glance}
    <section class="cnpy-reldoc-main">
      <h2 class="cnpy-rel-h3">Highlights</h2>
      <ul class="cnpy-rel-list cnpy-reldoc-hl${r.highlights.length >= LONG_HIGHLIGHTS ? " is-long" : ""}">${r.highlights.map((h) => `<li>${releaseLine(h)}</li>`).join("")}</ul>
    </section>`;
}

/** Patch notes (the Upgrade notes live in the page header, `docHead`): each non-empty group as a STACKED
 *  full-width section (Added, Changed, Fixed, Removed) — one row per line, a quiet heading
 *  (dot, label, count), hairlines only between groups — then the PRs as one line of chips.
 *  A long group (LONG_GROUP lines or more) may flow into two balanced columns on a very
 *  wide card (trov.css, a container query); never more. */
const LONG_GROUP = 8;
function patchesDoc(r: Release): string {
  const present = GROUPS.filter((g) => r.patches[g.key].length);
  const groups = present.map((g) => {
    const lines = r.patches[g.key];
    return `<section class="cnpy-relpatch-group" id="relgroup-${g.key}">
      <h2 class="cnpy-relpatch-h">${dot(g.tone)}<span>${g.label}</span><span class="cnpy-relpatch-n">${lines.length}</span></h2>
      <ul class="cnpy-relpatch-list${lines.length >= LONG_GROUP ? " is-long" : ""}">${lines.map((l) => `<li>${releaseLine(l)}</li>`).join("")}</ul>
    </section>`;
  }).join("");
  return `${present.length
      ? `<div class="cnpy-relpatch">${groups}</div>`
      : `<p class="cnpy-rel-empty cnpy-reldoc-pad">No patch notes recorded for this release.</p>`}
    <footer class="cnpy-relpatch-prs"><span class="cnpy-relpatch-prs-l">Pull requests</span><span class="cnpy-relpatch-chips">${prChips(r)}</span></footer>`;
}

/** Newer / older links under the card (plain links on the page, no boxes). */
function pager(r: Release, page: ReleasePage, releases: readonly Release[]): string {
  const i = releases.indexOf(r);
  const newer = i > 0 ? releases[i - 1] : null;
  const older = i >= 0 && i < releases.length - 1 ? releases[i + 1] : null;
  const name = (x: Release) => `${x.unreleased ? "Unreleased" : `v${esc(x.version)}`} · ${esc(x.title)}`;
  const link = (x: Release | null, dir: "newer" | "older") => x
    ? `<a href="${attr(releaseHash(releaseSlug(x), page))}" class="cnpy-relpager-i is-${dir}">
        <span class="cnpy-relpager-dir">${dir === "newer" ? `${ARROW_L}Newer` : `Older${ARROW_R}`}</span>
        <span class="cnpy-relpager-name">${name(x)}</span>
      </a>`
    : `<span class="cnpy-relpager-i is-${dir} is-none" aria-hidden="true"></span>`;
  return `<nav class="cnpy-relpager" aria-label="Other releases">${link(newer, "newer")}${link(older, "older")}</nav>`;
}

/** `#releases/<v>` and `#releases/<v>/patches`. */
export function releasePageView(slug: string, page: ReleasePage, releases: readonly Release[] = RELEASES): string {
  const r = findRelease(slug, releases);
  if (!r) {
    return `<div class="cnpy-reldoc">
      <header class="cnpy-reldoc-head">
        <a href="#releases" class="cnpy-rel-back">${ARROW_L}All releases</a>
        <h1 class="cnpy-reldoc-title">No release called “${esc(slug)}”</h1>
        <p class="cnpy-reldoc-lede">It may have been renamed when it shipped. Every release is listed on the <a href="#releases" class="cnpy-rel-pr">All releases</a> page.</p>
      </header>
    </div>`;
  }
  return `<div class="cnpy-reldoc">
    ${docHead(r, page)}
    <article${surface("--i:1", { cls: "cnpy-reldoc-card cnpy-rise" })} aria-label="${attr(page === "patches" ? "Patch notes" : "Release notes")}">
      ${page === "patches" ? patchesDoc(r) : notesDoc(r)}
    </article>
    ${pager(r, page, releases)}
  </div>`;
}

/** The whole `releases` screen: the index, or one release's page. */
export function releasesScreen(slug: string | null, page: ReleasePage, releases: readonly Release[] = RELEASES): string {
  return slug ? releasePageView(slug, page, releases) : releasesIndex(releases);
}
