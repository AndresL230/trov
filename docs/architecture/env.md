# Env, secrets and bindings

<!-- The complete list of what `Env` (`src/env.ts`) holds and what `wrangler.toml` sets. Keep it current when you add, rename or stop reading a name: every name in `Env` has a row here. Values never appear in this file — names only. Detail for an area lives in that area's file; this one says what each name is, where it is set, and what happens without it. -->

## Env / bindings

`src/env.ts` is the type; `wrangler.toml` holds the bindings, the `[vars]` and the cron triggers. A **secret**
is set with `wrangler secret put <NAME>` (local: `.dev.vars`, see `.dev.vars.example`) and never appears in
the repo, a log or a response. A **var** is a plain value in `wrangler.toml` `[vars]`, and a deploy sets it
from THERE — a value changed only in the Cloudflare dashboard is put back by the next deploy. **Changing a
secret creates a new deployment at once** (`HANDOFF.md` › Secrets). A var and a secret must never share a
name: the deploy fails.

Per-organization credentials are NOT here. An organization's GitHub access is its App installation or its
stored token, and its Cloudflare / Railway / app-metrics tokens are rows it enters on Org settings ›
Integrations, envelope-encrypted under `TROV_KEK` (`data-layer.md` › Configuration and credentials,
`github-app.md`, `organizations.md`). Code reads them only through `resolveGithubCredential` /
`resolveCredential` — never a Worker secret directly.

### Bindings

| Name | What it is | Missing → |
|---|---|---|
| `DB` | D1, database `trov`. Reached only through a context, inside `src/data/` (`data-layer.md`) | nothing works |
| `ASSETS` | the static assets binding over `web/dist` (the SPA and the public pages) | no page is served |
| `ARTIFACTS_BUCKET` | R2, bucket `trov-artifacts`: binary artifact bodies at `artifacts/<sha256>`, doc images, and uploaded avatars and organization images (`avatars/<sha256>`, `org-logos/<sha256>`) — `artifacts.md` | **the bucket must exist before the first deploy that carries the binding** (`wrangler r2 bucket create trov-artifacts`), or the deploy fails |

Capture-time summaries call Gemini over REST (`GEMINI_API_KEY`), never at render — not a Cloudflare binding,
so there is no `[ai]` block.

### Sign-in and sessions

| Name | Kind | What it is | Missing → |
|---|---|---|---|
| `GITHUB_CLIENT_ID` | secret | the GitHub App's OAuth client id — the same App signs people in and connects repositories (`auth-identity-people.md`, `github-app.md`) | required: GitHub sign-in does not work without it |
| `GITHUB_CLIENT_SECRET` | secret | its client secret | the code exchange fails; nobody signs in with GitHub |
| `GOOGLE_CLIENT_ID` | secret | the Google OAuth client id (the second sign-in provider) | `/auth/google/login` answers 503 |
| `GOOGLE_CLIENT_SECRET` | secret | its client secret | the redirect still happens, the exchange fails and `/auth/google/callback` 401s `exchange_failed` |
| `COOKIE_SECRET` | secret | the HMAC key for the session cookie, the sealed onboarding / OAuth-transaction cookies, the unsubscribe token (`/u/…`), artifact download links, and the hashed client address of a signed-out support report | no session can be made or read |
| `DEV_LOGIN` | local only (`.dev.vars`) | bypasses OAuth and acts as this seeded user | — never set in production |

### The GitHub App (`github-app.md`)

| Name | Kind | What it is | Missing → |
|---|---|---|---|
| `GITHUB_APP_ID` | secret | the App's numeric id (the JWT's `iss`) | with any of id / key / slug missing, Org settings offers only the pasted-token path and says the App is not configured on this deployment; nothing 500s |
| `GITHUB_APP_PRIVATE_KEY` | secret | the whole `.pem` GitHub generated; signs the App JWT; never logged | as above |
| `GITHUB_APP_SLUG` | var | the App's URL name, for the "Connect with GitHub" link (`https://github.com/apps/<slug>/installations/new`); empty = not configured | as above |
| `GITHUB_APP_WEBHOOK_SECRET` | secret | verifies deliveries to `POST /webhook/github/app` | every delivery there is the bare 401 |

### Mail (`notifications.md`, `support.md`, `abuse-limits.md`)

| Name | Kind | What it is | Missing → |
|---|---|---|---|
| `NOTIFICATIONS_MODE` | var | the delivery gate. `resend` (production) = mail is really sent, from the one platform address; `local` = rendered bodies go to a table and nothing is sent | absent reads as `local` |
| `RESEND_API_KEY` | secret | the Resend API key | needed only in `resend` mode, where every send is then a configuration error — never a silent fallback to `local` |
| `PUBLIC_ORIGIN` | var | the absolute origin for links Trov hands out: mail deep links and unsubscribe, MCP tool results (artifact and handoff URLs), webhook URLs shown in Org settings | a request-driven path uses the request's own origin; the digest cron, which has no request, writes relative links |
| `SUPPORT_NOTIFY_EMAIL` | var | where each bug report / support message is mailed — the operator's inbox; not a secret | empty or absent: the report is stored and shown in Platform › Support but NOT mailed (mail outcome `skipped`) |

### Summaries

| Name | Kind | What it is | Missing → |
|---|---|---|---|
| `GEMINI_API_KEY` | secret | the ONE Google Gemini key that serves every organization's capture-time PR / issue summaries, each call counted against that organization's monthly allowance (`plans.md` › AI summaries, `sync.md`) | the excerpt fallback: an item shows its excerpt, and a later Sync fills it in |

### Stored credentials

| Name | Kind | What it is | Missing → |
|---|---|---|---|
| `TROV_KEK` | secret | the key-encryption key for per-organization integration secrets: 32 random bytes, base64. It wraps each organization's data key and never encrypts a credential itself (`src/data/secrets.ts`, `organizations.md`) | absent or malformed: every secret read and write fails closed — the Integrations API answers 503 `secrets_unavailable` and nothing is ever stored in plaintext. **Losing it loses every organization's stored credentials** — keep a copy outside Cloudflare |
| `TROV_KEK_PREVIOUS` | secret | set ONLY during a KEK rotation: the old key, picked by fingerprint | normal state — unset |

### Billing — Stripe (`billing.md` › Configuration; `src/billing/config.ts` is the only reader)

| Name | Kind | What it is | Missing → |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | secret | sent only as the bearer of a request to Stripe's API; test or live mode is whichever key is set | billing is OFF: every billing route answers 503 `billing_unavailable`, `GET /api/billing/config` says `available: false`, and nothing else in the app changes |
| `STRIPE_WEBHOOK_SECRET` | secret | the signing secret of the endpoint `POST /webhook/stripe` | billing is OFF (as above), and every delivery there is the bare 401 |
| `STRIPE_PRICE_TEAM` | var | the Stripe Price id of ONE SEAT of Pro (plan id `team`), monthly | Pro cannot be bought monthly |
| `STRIPE_PRICE_TEAM_YEARLY` | var | the optional yearly per-seat Price id | Pro is not offered yearly |
| `STRIPE_TAX` | var | `on` → a checkout asks Stripe Tax to work out the tax and takes a billing address. Turn it on only after Stripe Tax is set up in the dashboard, or Stripe refuses the checkout | anything else: no tax lines |
| `STRIPE_TEST_API_BASE` | local / test only | a stand-in for Stripe's API, honoured ONLY for a loopback `http://` origin and never with a live key (`src/platform/loopback.ts`) | production: unset |

### Local development only

`DEV_LOGIN` and `STRIPE_TEST_API_BASE` (above), and `LOCAL_UPSTREAM` — a loopback http stand-in for GitHub and
Gemini during a Sync (`src/sync/local-upstream.ts`); ignored unless it is `http://127.0.0.1` or
`http://localhost`, and never honoured beside a live Stripe key. The two stand-ins are described in `.dev.vars.example`.

### Legacy — SaplingLearn's fallback, and two vars nothing reads

These predate organizations. Each of the SECRETS below is read in exactly one way: as the fallback inside
`resolveCredential` / `resolveGithubCredential` / `resolveCloudflareAccountId`, for `org_saplinglearn` ALONE,
and only until that organization's admin stores the same integration on Org settings › Integrations (a stored
secret wins; no other organization ever reads one). The repo cron also names them so no log line can carry
one (`legacyEnvSecrets`). The cleanup phase deletes the fallback and these secrets (`data-layer.md` ›
SaplingLearn's fallback).

| Name | Kind | Answers for (SaplingLearn only) | Missing → |
|---|---|---|---|
| `GITHUB_SERVICE_TOKEN` | secret | its `github_token`, when it has no App installation and no stored token | it has no GitHub credential from this source: Sync GitHub says not configured, its `:10` / `:20` cron units and the webhook's two follow-up reads (`fillFailedJob`, `refreshDrift`) are skipped |
| `GITHUB_WEBHOOK_SECRET` | secret | the HMAC of the LEGACY `POST /webhook/github`, which delivers only to the one `legacy_hook = 1` repo | that URL answers the bare 401 |
| `CF_ANALYTICS_TOKEN` + `CF_ANALYTICS_ACCOUNT_ID` | secrets (both) | its Cloudflare analytics poll. The account id is a secret on purpose — it was created as one, and a var and a secret sharing a name fail the deploy. Neither is named `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`, the names the wrangler CLI itself authenticates with | absent either: `pollCloudflare` is not called and the Usage tab's requests / error rate and the Cloudflare panel stay `not_connected` |
| `RAILWAY_TOKEN_STAGING`, `RAILWAY_TOKEN_PRODUCTION` | secrets | its Railway PROJECT tokens, one per environment, looked up by name: `RAILWAY_TOKEN_<environment key, upper-cased, non-alphanumerics → _>` (`railwayEnvName` in `src/data/secrets.ts`), sent as `Project-Access-Token`. **Not read-only** — Railway has no read-only scope | that environment's Railway poll is skipped; `hosting` stays `not_connected` with none |
| `SAPLING_METRICS_TOKEN` | secret | the bearer its app's `GET {apiUrl}/api/internal/metrics` expects — ONE value for every environment | `pollSaplingMetrics` is not called; Active users and the Product blocks stay "not connected" |

`GITHUB_REPO` and `REPO_ENVIRONMENTS` are **read by nothing in `src/`**. `0042_organizations` copied them
into SaplingLearn's `org_repos` / `org_environments` rows; an organization's repository and environments are
rows it edits in Org settings, and neither var is in `wrangler.toml` any more. They remain in `Env` only as
types: the parser `repoEnvironments()` (`src/repo/config.ts`) is called by the SaplingLearn-era test suites
to seed those rows. The shape it parsed is the shape of an `org_environments` row (`RepoEnvConfig`): `key`,
`label`, `note`, `branch`, `railwayEnv`, `worker` + `workerCheck`, `frontendUrl`, `apiUrl`, `healthPath`, and
optional `railwayEnvironmentId` / `railwayServiceId`. What the order of an organization's environments means,
and which capture reads which field, is `repo-dashboard.md`.

## Preview deployments

`[previews.*]` in `wrangler.toml`; `npm run deploy:preview`. A Preview is a branch's code on its own URL, with
ONLY the bindings of the `[previews]` section — the empty D1 `trov-preview` and the R2 bucket
`trov-preview-artifacts`, `NOTIFICATIONS_MODE = "local"`, no GitHub App slug, no Stripe price, no sign-in
secrets (nobody can sign in to one). `[env.preview]` exists solely so that database can be migrated by name;
nothing is deployed to it. Preview-only secrets: `wrangler preview secret put <NAME>`.

**The non-production deploy command in the Cloudflare dashboard (Workers Builds) must be `npm run
deploy:preview` — never the production command**: Cloudflare refuses `wrangler deploy` from a branch build,
but it does NOT refuse `wrangler d1 migrations apply trov --remote`, which applies an unreviewed branch's
migration to production. Build command for both: `npm run build:web`. **This is a dashboard setting, not
something the repo can enforce, and as of 2026-10-09 it is not set this way**: a push of any branch applies
that branch's new migrations to the PRODUCTION database (and does not deploy the Worker). `HANDOFF.md` ›
"A push of any other branch" says how to check and what to do until it is changed.

## Cron triggers

`[triggers] crons` is three expressions: `*/10 * * * *` is the repo cron — its per-tick schedule and
subrequest budget are described ONCE, under "The repo cron" in `repo-dashboard.md` — plus the two hourly
digest candidates, `0 * * * *` and `0 * * * SUN,MON` (`notifications.md`). `REPO_CRON` in `src/repo/cron.ts`
and the expression in `wrangler.toml` must stay identical (pinned by a test), Cloudflare cron weekdays are
1–7 or SUN–SAT (never 0), and a change to this list needs `wrangler triggers deploy` after the merge — a
Workers Builds deploy does not update the schedule (`HANDOFF.md`).
