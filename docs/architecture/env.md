# Env, secrets and bindings

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

## Env / bindings

Secrets (`wrangler secret put …`; local: `.dev.vars`): `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`GOOGLE_CLIENT_ID` (Google OAuth client id for the second session-class provider — absent →
`/auth/google/login` itself returns 503), `GOOGLE_CLIENT_SECRET` (absent → the login redirect still
happens, but the code exchange fails and `/auth/google/callback` 401s `exchange_failed`), `COOKIE_SECRET`,
`GITHUB_WEBHOOK_SECRET` (HMAC for the LEGACY webhook URL — absent → that surface 401s), `GITHUB_SERVICE_TOKEN`
(**with `GITHUB_WEBHOOK_SECRET`, `CF_ANALYTICS_*`, `RAILWAY_TOKEN_*` and `SAPLING_METRICS_TOKEN`: read ONLY as
SaplingLearn's fallback, through `resolveCredential`, until its admin enters each on the Integrations screen —
every other org's credentials are per-org secrets; the cleanup phase deletes the fallback and these Worker
secrets.** App-level token for the sprint-progress backstop, for `reconcileRepo` — from Sync GitHub AND the repo cron
— and for the webhook's two follow-up reads, `fillFailedJob` and `refreshDrift`; absent → Sync GitHub 503s,
the cron's 6-hourly `:10` and `:20` ticks and those follow-ups are skipped, while the `:30` prune and the
health pings run regardless), `GEMINI_API_KEY`
(Google Gemini key for capture-time PR/issue summaries — absent → the excerpt fallback), `RESEND_API_KEY`
(email delivery; needed only when `NOTIFICATIONS_MODE = "resend"`), and the GitHub App's three:
`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (the whole `.pem`), `GITHUB_APP_WEBHOOK_SECRET` — with the var
`GITHUB_APP_SLUG`; missing any of slug / id / key → only the token path is offered, nothing 500s
(`docs/architecture/github-app.md`).

The repo cron's three hourly pollers each have their own secret(s). Each poller is skipped when its secret
is absent — its section then stays `not_connected` — and none of these values may ever be logged:
- `CF_ANALYTICS_TOKEN` (a Cloudflare API token with Account Analytics: Read) + `CF_ANALYTICS_ACCOUNT_ID` (the
  account the frontend Workers live under). Absent EITHER → `pollCloudflare` is not called, and the Usage
  tab's requests / error rate and the Cloudflare panel stay `not_connected`. The account id is a SECRET,
  deliberately NOT a `[vars]` entry: it was created as a secret, and a var and a secret sharing a binding
  name collide and fail the deploy. Neither is named `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`,
  because those are the names the wrangler CLI itself authenticates with.
- `RAILWAY_TOKEN_STAGING` / `RAILWAY_TOKEN_PRODUCTION` — Railway PROJECT tokens, ONE PER ENVIRONMENT, named
  `RAILWAY_TOKEN_<environment key, upper-cased, non-alphanumerics → _>` and sent as `Project-Access-Token`.
  Absent one → `pollRailway` skips THAT environment; absent both → it is not called and `hosting` stays
  `not_connected`. **These tokens are NOT read-only** — Railway has no read-only scope; one environment of
  one project is the narrowest it offers. A third environment needs its secret plus a line in `src/env.ts`
  (and `test/env.d.ts`) for the type.
- `SAPLING_METRICS_TOKEN` — the bearer token Sapling's `GET {apiUrl}/api/internal/metrics` expects (the same
  value on both sides; ONE token for every environment, so staging and production Sapling must accept the
  same one — a stated limitation of the contract doc). Absent or empty → `pollSaplingMetrics` is not called
  and the Usage tab's Active users stays "not connected". Never sent to a non-https URL or across a redirect.

**Preview deployments** (`[previews.*]` in `wrangler.toml`; `npm run deploy:preview`). A Workers Builds
build of any branch but `main` deploys a Preview: the branch's code on its own URL, with ONLY the bindings
of the `[previews]` section — the empty D1 `trov-preview` and the R2 bucket `trov-preview-artifacts`,
`NOTIFICATIONS_MODE = "local"`, no GitHub App slug. It never gets production's database or bucket, so a
branch's migrations run against `trov-preview` only (`[env.preview]` exists solely so that database can be
migrated by name; nothing is deployed to it). **The non-production deploy command in the Cloudflare
dashboard must be `npm run deploy:preview` — never the production command**: Cloudflare refuses `wrangler
deploy` from a branch build, but it does NOT refuse `wrangler d1 migrations apply trov --remote`, which
would apply an unreviewed branch's migration to production. Build command for both: `npm run build:web`.

Vars (`[vars]` in `wrangler.toml`): `PUBLIC_ORIGIN` (absolute origin for links inside email),
`NOTIFICATIONS_MODE` (`resend` in production since 2026-10-07; `local` writes bodies to a table and sends nothing — a deploy sets it from `wrangler.toml`, so a dashboard-only change is undone by the next deploy), `GITHUB_APP_SLUG` (the App's URL name; empty = not
configured), `SUPPORT_NOTIFY_EMAIL` (where each bug report / support message is mailed — the operator's inbox;
not a secret; empty or absent = the report is stored and shown in Platform › Support but NOT mailed, its mail
outcome `skipped`; also in `[previews.vars]`, empty — `support.md`), the billing vars `STRIPE_PRICE_TEAM` /
`STRIPE_PRICE_TEAM_YEARLY` / `STRIPE_TAX` and `STRIPE_PUBLISHABLE_KEY` (Stripe's PUBLIC key, `pk_test_…` /
`pk_live_…`: the one Stripe value that is a var and not a secret, because it is sent to the buyer's browser.
Set, in the secret key's own mode → checkout is embedded in Trov's `/billing/checkout`; empty → Stripe's
hosted page. Never put `sk_…` here: a value that is not a `pk_` key is ignored. Also in `[previews.vars]`,
empty — `billing.md` › Configuration, › Embedded checkout), and two LEGACY ones nothing reads any more (`0042_organizations` copied them
into SaplingLearn's `org_repos` / `org_environments` rows; Phase 7 deletes them): `GITHUB_REPO` and
`REPO_ENVIRONMENTS` — a JSON list in the shape `repoEnvironments()` (`src/repo/config.ts`) parses: per environment
`key`, `label`, `note`, `branch`, `railwayEnv` (the GitHub deployment environment name), `worker` +
`workerCheck` (the Cloudflare script and its Workers Builds check name), `frontendUrl`, `apiUrl`,
`healthPath`, and — optional — `railwayEnvironmentId` / `railwayServiceId` (ids, not secrets; the service id
is the same in both environments). An entry missing a required string is dropped; absent or malformed →
`[]`. Today it encodes two: **staging** deploys from `main`, **production** from a `production` branch;
backend on Railway, frontend on Cloudflare Workers. **Order matters**: entry `[0]` is the drift HEAD and the
branch a `canopy/*` status must be on; the LAST entry is the drift base. It is read by the webhook's repo
capture (matching a `deployment_status` / `check_run` to its environment, the status branch filter, which
pushes refresh drift), the projection (`getRepoDashboard`'s `envs`), `reconcileRepo` (the environment NAMES
the deployments query filters on; the BRANCHES whose head, head checks and drift it reads) and all four
pollers (`pingHealth`: `frontendUrl`, `apiUrl + healthPath`; `pollCloudflare`: `worker`; `pollRailway`: the
two Railway ids; `pollSaplingMetrics`: `apiUrl`). Absent → no deployments / env-head / head-checks arms, no
drift (it needs two environments), no pings and no polls, and `environments` / `deploys` / `health` /
`usage` / `cloudflare` / `hosting` stay `not_connected` — but the **branches arm still runs**
(`computeBranches` degrades correctly with `envs: []`), and `ciFailures` never consults it.

Bindings: `DB` (D1), `ASSETS` (static), `ARTIFACTS_BUCKET` (R2, bucket `trov-artifacts` — binary artifact
bodies at `artifacts/<sha256>`; **the bucket must exist before the first deploy that carries this binding**:
`wrangler r2 bucket create trov-artifacts`). Capture-time summaries call Gemini over REST (`GEMINI_API_KEY`),
never at render — not a Cloudflare binding, so there is no `[ai]` block. `[triggers] crons` is three
expressions: `*/10 * * * *` is the repo cron — its per-tick schedule and subrequest arithmetic are described
ONCE, under "The repo cron" in the Repo dashboard section — plus the two hourly digest candidates (see Email
notifications). `REPO_CRON` and the expression in `wrangler.toml` must stay identical (pinned by a test),
and a change to this list needs `wrangler triggers deploy` after the merge (see "Owner prerequisites").
