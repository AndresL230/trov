# Repo setups — step 0 fact check (2026-10-15)

Read-only. No secret values printed. Credentials used:
- **CF-OAUTH** — wrangler's OAuth token from `~/.config/.wrangler/config/default.toml` (user login, scopes incl. `account (read)`, `workers_scripts (write)`, `d1 (write)`; NO builds scope). Read into a shell var by a scratch script, sent only to api.cloudflare.com.
- **CF-MCP** — the Cloudflare Workers Builds MCP server (`mcp__plugin_cloudflare_cloudflare-builds__*`), its own OAuth grant.
- **GH-USER** — `gh` CLI keyring token for AndresL230 (scopes `gist, read:org, repo, workflow`).
- `.dev.vars` key names: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, COOKIE_SECRET, DEV_LOGIN, GITHUB_WEBHOOK_SECRET, GEMINI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, VERCEL_INTEGRATION_SLUG, VERCEL_INTEGRATION_CLIENT_SECRET, VERCEL_INTEGRATION_CLIENT_ID, NETLIFY_OAUTH_CLIENT_ID, NETLIFY_OAUTH_CLIENT_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, TYPESAFE_API_KEY, ANTHROPIC_API_KEY. **No RAILWAY_*, no CLOUDFLARE_*.** No railway CLI / `~/.railway`.

`trov` worker tag (= Builds `external_script_id`): `4ca7155d25bc4643833af2ee4b74565b` (from `GET /accounts/0bda…/workers/scripts`, CF-OAUTH). Prod D1 `trov` id `6c71838c-18f7-4f68-8513-b58e86c237b9` (wrangler.toml).

## 1. Cloudflare commit via Workers Builds API — CONFIRMED (data exists), permission partly UNVERIFIED

- CF-OAUTH: `GET /accounts/0bda…/builds/workers/4ca7155d…/builds?per_page=3` → `{"success":false,"errors":[{"code":12004,"message":"Forbidden"}]}`; `/builds/builds`, `/builds/workers/{tag}/triggers` → `10000 Authentication error`. Wrangler's OAuth has no builds scope.
- CF-MCP `workers_builds_list_builds(workerId=4ca7155d…, account_id=0bda…)` → 42 builds total; newest:
  `d92c9bc0-… | 2026-10-15T06:43:15Z | stopped | success | branch main | commitHash 6c965ac5f99429b7af6fa244ad577e3557211071 | "Merge pull request #185 …" | Andres Lopez`.
  `workers_builds_get_build` adds `deployCommand: npx wrangler d1 migrations apply trov --remote && npx wrangler deploy`. The MCP flattens fields (camelCase); raw REST names per docs (Builds API reference): `build_trigger_metadata.commit_hash`, `build_trigger_metadata.branch`, `trigger.trigger_uuid`. Event-subscription schema shows the same object as `buildTriggerMetadata { buildTriggerSource, branch, commitHash, commitMessage, author, repoName, providerAccountName, providerType }`.
- Useful: `GET /accounts/{id}/builds/builds?version_ids={version_id}` maps a Deployments-API version id to its build (docs) — the join from a deployment to its commit.
- Permission (docs): Builds API reference says token needs **"Workers Builds Configuration"** (Edit listed, for trigger/manage) + **Workers Scripts Read** (only to get the tag). The API-token permission table names the group **"Workers CI Read" / "Workers CI Edit"** — same thing, different label. **The Builds API requires a USER-scoped token; account-owned tokens return "Invalid token".** Trov's Cloudflare form already asks for a user token (My Profile › API Tokens), so it is compatible; it would need a THIRD permission (Workers CI / Builds Configuration Read). UNVERIFIED: that **Read** (not Edit) suffices for `GET …/builds` — needs a test user token with Workers CI Read only. Not "Account Analytics Read", not "Workers Scripts Read" (CF-OAUTH has workers_scripts write and was still refused).

## 2. Cloudflare GraphQL analytics — CONFIRMED (CF-OAUTH)

`POST https://api.cloudflare.com/client/v4/graphql`, account 0bda…, window 2026-10-08T07:00Z → 2026-10-15T07:00Z.

(a) `workersInvocationsAdaptive(filter:{scriptName:"trov",…}){dimensions{status} sum{requests errors subrequests}}` →
`clientDisconnected: requests 114, errors 0` · `success: requests 16386, errors 0, subrequests 11664`. Only these two statuses in 7 days. Dimensions available (introspection): cacheStatus, coloCode, date/datetime*, dispatchNamespaceName, environmentName, isDispatcher, isPreview, previewSlug, scriptName, scriptTag, scriptVersion, status, usageModel — **no fetch/scheduled dimension**.

(b) `d1AnalyticsAdaptiveGroups(filter:{databaseId:"6c71838c-…",date_geq,date_leq}){dimensions{date} sum{readQueries writeQueries rowsRead rowsWritten}}` → e.g. 2026-10-14: readQueries 9672, writeQueries 3093, rowsRead 2354377, rowsWritten 13712. Sum fields: queryBatchResponseBytes, readQueries, rowsRead, rowsWritten, writeQueries; dims incl. databaseRole, servedByInstance, servedByRegion. `d1StorageAdaptiveGroups{max{databaseSizeBytes}}` → 2026-10-15: 27545600. Permission (docs, GraphQL API token auth): **Account › Account Analytics › Read**. (Also present: `d1QueriesAdaptiveGroups`, `workersBuildsBuildMinutesAdaptiveGroups`.)

(c) **Yes: `workersInvocationsScheduled`** (fields: cpuTimeUs, cron, datetime, environmentName, scheduledDatetime, scriptName, status). 7-day query (limit 10000) → 1226 rows: `*/10 * * * *` success 1010, `0 * * * *` success 168, `0 * * * SUN,MON` success 48 — all environmentName `production`, matching `[triggers] crons` in wrangler.toml. Per-run rows (not aggregated).

(d) **Yes**: `workersInvocationsAdaptive.quantiles` has cpuTimeP25…P999, wallTimeP25…P999, durationP*, requestDurationP*, memoryUsageBytesP*, responseBodySizeP*, wasmMemoryBytesP*. Live: success → cpuTimeP50 2257, cpuTimeP99 55106 (µs), wallTimeP50 23491, wallTimeP99 18118452 (µs).

## 3. Railway `meta.commitHash` / `meta.branch` — UNVERIFIED (no token)

- No Railway credential locally (no RAILWAY_* in .dev.vars, no CLI). Prod D1: `SELECT org_id, provider, COUNT(*) FROM org_hosting_connections GROUP BY …` and `SELECT provider, COUNT(*), SUM(sha IS NOT NULL), SUM(branch IS NOT NULL) FROM hosting_deploys GROUP BY provider` → both empty (no hosting connections in prod at all).
- `fixtures/hosting/railway/deployments.json` is hand-shaped (hashes like `c1d2e3f4…`); README marks the `meta` keys UNCONFIRMED. Shape recorded: `meta: { commitHash, branch, commitMessage, commitAuthor }`, `{ image }` for an image deploy, `null` for SKIPPED.
- Indirect evidence (GH-USER, public): railwayapp/cli `src/commands/mcp/handler.rs:842-847` reads `node.meta.get("commitHash")` from `deployments` — so `commitHash` is a real meta key. `branch` is not read by the CLI; Railway's webhook docs (`railwayapp/docs content/docs/observability/webhooks.md`) show `details { source, branch, commitHash, commitAuthor, commitMessage }` for Deployment.* events — likely the same source, not proof of `meta.branch`.
- To verify: a Railway account/workspace token for SaplingLearn's project, then `deployments(first:5, input:{serviceId,environmentId}){edges{node{meta}}}` on backboard.railway.com/graphql/v2.

## 4. GitHub

(a) **CONFIRMED** (GH-USER, not an App installation token). `gh api graphql -f query='query { repository(owner:"AndresL230", name:"trov") { f0: object(expression:"HEAD:package.json") { ... on Blob { byteSize isBinary text } } … f23: … } rateLimit { cost remaining } }'` with 24 aliases → exit 0, `errors: None`, `rateLimit.cost 1`. 12 existing paths returned text (package.json 1409 B, wrangler.toml, tsconfig.json, package-lock.json 271982 B full text, vitest.config.ts, README.md, CLAUDE.md, HANDOFF.md, .github/workflows/ci.yml, tsconfig.worker.json, tsconfig.web.json, migrations/0001_init.sql), `isBinary false`. 12 missing paths (vercel.json, netlify.toml, fly.toml, render.yaml, railway.json, railway.toml, Dockerfile, Procfile, nixpacks.toml, app.yaml, wrangler.jsonc, pnpm-lock.yaml) → `null` each, query not failed. Under an installation token this needs **Contents: read** (the App has it; already in `READ_PERMISSIONS`).

(b) `gh api /apps/trov-by-trovlabs` (slug from wrangler.toml `GITHUB_APP_SLUG`; public endpoint) →
`permissions: { actions: read, checks: read, contents: read, deployments: read, emails: read, issues: read, metadata: read, pull_requests: read, statuses: read }`;
`events: [check_run, deployment_status, issues, pull_request, pull_request_review, push, status, workflow_run]`; owner AndresL230, updated_at 2026-10-07T19:55:22Z.

GitHub docs (`/en/webhooks/webhook-events-and-payloads`, fetched via docs.github.com article API), "To subscribe to this event, a GitHub App must have at least read-level access for…":

| Event | Needs | App has it | Subscribed now |
|---|---|---|---|
| `deployment` | Deployments | yes | no |
| `deployment_status` | Deployments | yes | **yes** |
| `release` | Contents | yes | no |
| `create` | Contents | yes | no |
| `workflow_job` | Actions | yes | no |

So adding `deployment`, `release`, `create`, `workflow_job` needs **no new permission**. Approval rule (docs `/en/apps/maintaining-github-apps/modifying-a-github-app-registration`): "When you add new repository or organization permissions … each account where the app is installed will need to approve the new permissions"; "If you remove permissions or webhooks … the changes will take effect immediately." The docs tie re-approval to permissions only; they do not state in words that adding an event under existing permissions skips approval — CONFIRMED by that rule, not by an explicit sentence.

## 5. Host deployment environment names on GitHub — CONFIRMED (GH-USER, public repos)

- **Vercel** — `gh api repos/shadcn-ui/ui/deployments?per_page=8`: `Production – ui`, `Preview – ui`; dash is **U+2013 EN DASH** (checked codepoint `0x2013`); creator `vercel[bot]`; `ref` = full sha; `task: deploy`; `production_environment: false` even for Production; `payload: {}`. vercel/vercel: `Preview – vercel-vercel-pi` (one per project). vercel/next.js deployments are its own bot (`release-canary`), not Vercel's. Status (`…/deployments/7070491200/statuses`): `state success, description "Deployment has completed", environment "Production – ui", environment_url / target_url / log_url = https://ui-npe97x7h4-shadcn-pro.vercel.app` (the per-deployment URL, not the production domain), creator `vercel[bot]`.
- **Railway** — railwayapp/docs: environment `<service> / <environment>` (ASCII `/`), e.g. `*.railway.com / production`, `railway-docs / production`, PR envs `… / mono-pr-29813`; creator `railway-app[bot]`; `ref` = sha; `production_environment: false`. Status: `description ""`, `environment_url` = `https://railway.com/project/<p>?environmentId=<e>` (dashboard, not the app URL). railwayapp-templates/django: `authentic-energy / production`.
- **Render** — render-examples/express-hello-world: environment `<branch> - <service>` with ASCII hyphen-minus (`0x2d`), e.g. `main - express-hello-world`; creator `render[bot]`; **`ref` = branch name `main`, not a sha**; `production_environment: true`. Statuses `in_progress` → `success`, `description ""`, `environment_url` = `https://express-hello-world-ge6g.onrender.com`, `log_url` = `https://dashboard.render.com/web/srv-…/deploys/dep-…`.

## What each finding changed (master)

- **Cloudflare commit** — Phase A reads the commit from the Workers Builds API (`builds?version_ids=`, pollCost +1)
  and falls back to the 10-minute join when the token is refused, saying "the token needs Workers CI Read" — never
  a guess. The Cloudflare token copy names Workers CI Read as optional, for commits. (Read-vs-Edit is unverified.)
- **Cloudflare analytics** — Phase G: schedules from `workersInvocationsScheduled` (confirmed); D1 from
  `d1AnalyticsAdaptiveGroups` / `d1StorageAdaptiveGroups` (confirmed, Account Analytics Read); quantiles from
  `workersInvocationsAdaptive.quantiles` (confirmed). Outcomes: the `status` dimension is the invocation outcome
  (`success`, `clientDisconnected`, …), NOT an HTTP status — Phase G maps outcomes from what the dataset really
  carries and shows "not available" for any bucket it cannot read.
- **Railway `meta`** — unverified: sha from `meta.commitHash` when present, else the join (already the design).
- **GitHub** — the scan's one-query GraphQL batch is confirmed (missing paths are `null`); the four new App events
  need no new permission (ops: subscribe `deployment`, `release`, `create`, `workflow_job`).
- **Deployment environment names** — the `github` provider's matching and the found-signals token rules use the
  real formats: Vercel `Production – <project>` (en dash), Railway `<service> / <env>`, Render `<branch> - <service>`
  (Render's `ref` is a branch; the sha is the deployment's `sha`).
