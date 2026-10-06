# The GitHub App — connect repositories by installing, not by pasting (issue #95)

Status: building on `claude/tender-fermat-oehpwj`, stacked on the Organizations work (PR #93). Supersedes the
"interim until the GitHub App" kinds of `canopy-multitenancy.md` §8.7.2 (`github_token`, `github_webhook`) for
every org that installs the App; those kinds stay as the fallback path (D13 lifted).

## 1. What changes, what does not

| | Before (0037) | With the App |
|---|---|---|
| Connect a repo | type `owner/repo`, paste a fine-grained token | **Install on GitHub**, pick repos; connect one from the installation's list |
| Live events | a webhook per repo, `/webhook/github/:hookId` + a generated secret | ONE App webhook, `POST /webhook/github-app`, signed with the App's secret |
| Credential | a long-lived token tied to a person | a 1-hour **installation token** minted per job, scoped to the one repo, read-only |
| Who may bind | — | an ADMIN of the Trov org, whose GitHub account can read EVERY repo the installation covers |

Unchanged: Cloudflare / Railway / the metrics endpoint stay pasted credentials; memberships and roles are Trov's;
sign-in stays the GitHub OAuth app (a later step may move it onto the App). **Capture stays primary-repo only**
(§7): the App delivers every installed repo's events, and a non-primary repo's are acknowledged and ignored,
exactly as the per-repo hook does today.

## 2. Platform secrets (`src/env.ts`)

`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_APP_WEBHOOK_SECRET` — all `wrangler secret put` (none in `[vars]`: a var and a secret sharing a name fail
the deploy). `githubAppConfig(env)` (`src/github-app/config.ts`) returns a typed config ONLY when all six are
non-empty (else `null` = "not configured": no Install button, `/webhook/github-app` is a bare 401, every org
keeps its pasted token). The private key is PEM — PKCS#1 (`BEGIN RSA PRIVATE KEY`, what GitHub downloads) or
PKCS#8 (`BEGIN PRIVATE KEY`); literal `\n` escapes (a one-line `.dev.vars` value) are turned back into newlines.
None of the six is ever logged, returned, put in an error, or stored in D1. `vitest.config.ts` blanks all six.

## 3. Storage (`migrations/0048_github_app.sql`, rollback `scripts/mt/rollback/0048.down.sql`)

- `github_installations` — PK `installation_id` (GitHub's id), so an installation belongs to exactly ONE org;
  `org_id`, `account_login` / `account_id` / `account_type` (User | Organization), `repository_selection`
  (all | selected), `suspended_at`, `connected_by` (a handle, in `HANDLE_COLUMNS`), `connected_at`,
  `updated_at`, `last_delivery_at` (throttled, 10 min), `repos_synced_at`.
- `github_installation_repos` — `(installation_id, repo_id)` PK, `org_id`, `repo_full_name` (NOCASE), `private`;
  `ON DELETE CASCADE` from the installation. What Org settings › Repositories lists — read from D1, never GitHub.
- `org_repos.installation_id` — NULL = connected the 0037 way; set = connected through that installation.

Both tables carry `org_id`, so they are TENANT tables to `test/data-layer.static.test.ts`: every statement binds
`org_id` through `src/data/sql.ts`. The two lookups that happen BEFORE the org is known — the App webhook's
"which org owns installation N" and the bind's "is N already bound to another org" — go through
`src/data/platform-sql.ts` with a `PLATFORM_ALLOW` entry each (as `hookRepo` has).

Audit (`org_admin_audit`, `shared/orgs.ts`): `github.connect` / `github.disconnect` (an admin) / `github.uninstall`
/ `github.suspend` / `github.unsuspend` (GitHub, actor `github-webhook`) / `github.repos` (the list changed:
`{ added, removed }` counts) / `repo.attach` / `repo.detach` (an `org_repos` row gained / lost its installation).

## 4. Modules — `src/github-app/` (NONE reachable from `src/mcp.ts`)

`test/secrets.mcp.test.ts` asserts no file under `src/github-app/` is reachable from `src/mcp.ts`, and its regex
forbids calling `resolveGithubToken(` / `mintInstallationToken(` there, beside `getSecret(` / `resolveCredential(`.
`src/repo/github.ts`, `src/webhook.ts` and `src/tools/progress.ts` ARE reachable from MCP: they keep taking the
token as a plain string parameter and never import anything here.

| File | Exports | Notes |
|---|---|---|
| `config.ts` | `GithubAppConfig { appId, slug, clientId, clientSecret, privateKeyPem, webhookSecret }`, `githubAppConfig(env)`, `appSecrets(cfg)` (the values every scrub list includes) | pure |
| `jwt.ts` | `pemToPkcs8(pem): Uint8Array`, `appJwt(cfg, nowMs): Promise<string>` | RS256 via Web Crypto (`importKey("pkcs8", …, RSASSA-PKCS1-v1_5/SHA-256, false, ["sign"])`), PKCS#1 wrapped into PKCS#8 by hand (DER), `iat = now − 60 s`, `exp = now + 9 min`, `iss = appId`; no key cache across requests |
| `client.ts` | `getAppInstallation`, `mintInstallationToken`, `listInstallationRepos`, `exchangeUserCode`, `listUserInstallationRepos`, `revokeUserToken`, `GithubAppError` | every call takes `{ fetchImpl?: typeof fetch }`, carries `AbortSignal.timeout(15_000)`, the `trov-worker` user-agent and `x-github-api-version: 2022-11-28`; a failure throws `GithubAppError(code, message)` whose message is `scrub`bed of the JWT, the client secret and any token BEFORE it is built; tokens come back as `Secret` (`src/data/secrets.ts`) |
| `installations.ts` | the D1 repository (§5) | tenant statements + the two platform reads |
| `credential.ts` | `resolveGithubToken(ctx, env, repo, opts?)` (§6) | the ONE GitHub-credential resolver every job uses |
| `install.ts` | the install flow (§8) | |
| `webhook.ts` | `githubAppWebhookPath`, `handleGithubAppWebhook` (§7) | dispatched from `src/index.ts` before Hono |
| `routes.ts` | the Hono routes (§9) | |

GitHub endpoints used (REST, `https://api.github.com`):

| Call | Auth | Purpose |
|---|---|---|
| `GET /app/installations/{id}` | App JWT | account, selection, suspended — the bind's existence check |
| `POST /app/installations/{id}/access_tokens` `{ repositories?: [name], permissions? }` | App JWT | an installation token (1 h) |
| `GET /installation/repositories?per_page=100&page=n` | installation token | the installation's repos (≤ 10 pages) |
| `POST https://github.com/login/oauth/access_token` (`accept: application/json`) | client id + secret | the install flow's user token, never stored |
| `GET /user/installations/{id}/repositories?per_page=100&page=n` | user token | the repos THE PERSON can read in it (≤ 10 pages; 404 = none) |
| `DELETE /applications/{client_id}/token` `{ access_token }` | basic (client id : secret) | revoke the user token, best effort |

## 5. `installations.ts` — the repository

- `bindInstallation(ctx, input)` — admin session ctx. `input = { installation, repos, by }` where `installation`
  is GitHub's object (`id`, `account { login, id, type }`, `repository_selection`, `suspended_at`) and `repos` is
  the full list. Refuses with `InstallationBoundElsewhereError` when the id is bound to ANOTHER org (platform
  read; the message never names that org). Otherwise ONE batch: upsert the installation row, replace its repo
  list, ATTACH every `org_repos` row of this org whose `repo_full_name` is in the list and whose
  `installation_id` is NULL (`repo.attach` audit each), `github.connect` audit.
- `syncInstallationRepos(ctx, installationId, repos | { added, removed }, actor)` — a full list replaces; a delta
  applies. A repo leaving the list DETACHES its `org_repos` row (`installation_id = NULL`, `repo.detach`); a repo
  arriving attaches a matching unattached row. `github.repos` audit with counts; `repos_synced_at` on a full list.
- `unbindInstallation(ctx, installationId, actor, action: "github.disconnect" | "github.uninstall")` — detach
  every `org_repos` row of the installation, delete the installation (its repos cascade), audit.
- `setInstallationSuspended(ctx, installationId, at | null)` — `github.suspend` / `github.unsuspend`.
- `noteDelivery(ctx, installationId, now)` — `last_delivery_at`, at most once per 10 minutes.
- `listInstallations(ctx)` → `GithubInstallationDTO[]` (with each repo's `org_repo_id` / `is_primary`).
- `repoInstallation(ctx, orgRepoId)` → `{ installation_id, suspended_at } | null` (only when the row is attached
  AND the installation row exists).
- `installationOwner(p, installationId)` → `{ org_id, suspended_at, org_suspended } | null` — platform read.
- `addRepo` (`src/integrations/settings.ts`) ATTACHES a new or promoted repo when the org's installations cover
  it (the `github_installation_repos` row of this org with that name).

## 6. `resolveGithubToken` — the one GitHub credential

```ts
resolveGithubToken(ctx: TenantContext, env: Env, repo: { id: string; repo: string },
                   opts?: { fetchImpl?: typeof fetch; now?: number }): Promise<Secret | null>
```

1. Throws `SecretAccessError` for `ctx.via === "bearer"` or `ctx.role === "member"` — the same rule as `getSecret`.
2. When the App is configured AND `repoInstallation(ctx, repo.id)` is attached and not suspended: mint an
   installation token for `repositories: [<repo name>]` with the READ permissions the jobs need, and return it.
   A mint failure is logged (scrubbed) and falls through — the pasted token is the fallback during a cut-over.
3. Else `resolveCredential(ctx, env, "github_token", "")` (the stored token, or SaplingLearn's env fallback).

Callers (all already outside MCP's reach): `runReconcileJob` + the progress unit (`src/repo/cron.ts`),
`runBackfill` (`src/tools/backfill.ts`), the per-repo hook's lazy `githubToken` thunk (`src/github-hook.ts`),
the App webhook's thunk, and Test connection for `github_token` (`src/integrations/probe.ts`, which keeps testing
the PASTED token). Each pushes the returned `Secret` into its scrub list as today. Minting costs ONE subrequest:
`reconcileCost` becomes `20 + 2N`, `refreshSubrequests` `20 + 7N` (48 at N = 4 — still under 50), backfill +1.

## 7. The App webhook — `POST /webhook/github-app`

Dispatched in `src/index.ts` beside `webhookPath` (`/webhook/github-app` never matches `/webhook/github/:id`).

1. App not configured, or a missing / bad `X-Hub-Signature-256` (HMAC over the raw body with
   `GITHUB_APP_WEBHOOK_SECRET`, the existing `verifyGithubSignature`) → bare `401 {error:"unauthorized"}`,
   NOTHING written.
2. `installation.id` → `installationOwner`. Unbound, the org suspended, or (except for `installation` events)
   the installation suspended → `202 { ok: true, ignored: true }`, nothing written.
3. `installation`: `deleted` → `unbindInstallation(…, "github.uninstall")`; `suspend` / `unsuspend` →
   `setInstallationSuspended`; `created` / `new_permissions_accepted` → `syncInstallationRepos` from the
   payload's `repositories` when present. `installation_repositories`: `added` / `removed` → the delta, and
   `repository_selection`. Each 200 `{ ok: true }`.
4. Any other event: `repository.full_name` must be an `org_repos` row OF THAT ORG attached to THIS installation
   and `is_primary = 1`, else 202 ignored. Then `noteDelivery` and the SAME `captureDelivery(systemTenant(p, org,
   "github-webhook"), env, { repo, githubToken }, event, rawBody, opts)` the per-repo hook runs, with
   `githubToken` = a lazy `resolveGithubToken`.

During a cut-over both the legacy hook and the App may deliver one event: every capture is keyed and
`INSERT OR IGNORE`, the mirror is idempotent on `updated_at`, so the second copy is `unchanged`.

## 8. The install flow

1. `POST /api/o/:slug/github/install` (admin, cookie, refuses an `Authorization` header; 503
   `github_app_not_configured` when unset) → sets the sealed cookie `gh_install` (`hmacSeal` with its own purpose
   label; `{ org, slug, handle, nonce, exp }`, 30 minutes, `Path=/github/app; HttpOnly; Secure; SameSite=Lax`)
   and returns `{ url: "https://github.com/apps/<slug>/installations/new?state=<nonce>" }`.
2. GitHub sends the browser to the App's Setup URL **and** Callback URL, both `GET /github/app/setup`:
   - Needs the session cookie AND `gh_install` naming the SAME handle, unexpired, and that person must still be
     an admin of the org (re-checked) — else an error page (never a redirect into an org).
   - `setup_action=request` (a GitHub org member asked an owner to approve) → redirect
     `/o/<slug>/#org/repos?github=requested`.
   - No `code`: re-seal the cookie with `installation_id` (digits only) and redirect to
     `https://github.com/login/oauth/authorize?client_id=…&state=<nonce>&redirect_uri=<origin>/github/app/setup`.
   - With `code`: `state` MUST equal the cookie's nonce (no state, or a different one → refused: a code is only
     ever accepted for the flow this browser started). The installation id is the query's or the cookie's.
3. Verification — **an installation id from the query string is never trusted**:
   `exchangeUserCode` → `getAppInstallation` (404 → refused) → mint → `listInstallationRepos` →
   `listUserInstallationRepos` (404 → refused: "your GitHub account cannot access this installation"). Bind
   ONLY when every installation repo id is in the person's set — a person connects only what they can already
   read on GitHub (a refusal states a COUNT, never names repos the person cannot see). Then `bindInstallation`;
   bound to another org → refused ("already connected to another Trov organization", no name). The user token
   is revoked best effort and never stored or logged.
4. Success clears the cookie and redirects `/o/<slug>/#org/repos?github=connected`. Every refusal is a
   server-rendered page (the style of `src/auth/oauth-pages.ts`) with a link back to Org settings; an unexpected
   error is a 503 page, never a 500.

## 9. Routes (`src/github-app/routes.ts`)

Tenant, under `/api/o/:slug` (mounted beside `orgSettingsApp`), cookie only (an `Authorization` header is a 403,
like `personOnly`), admin:

| Route | Effect |
|---|---|
| `GET /github` | `GithubAppStateDTO` |
| `POST /github/install` | §8.1 |
| `POST /github/installations/:installationId/refresh` | re-list (mint + `listInstallationRepos`), `syncInstallationRepos` full; returns the state |
| `POST /github/installations/:installationId/disconnect` | `unbindInstallation(…, "github.disconnect")` — Trov forgets it; the page says to uninstall on GitHub too |

Platform: `GET /github/app/setup` (§8.2). Every route is in `test/isolation.http.test.ts` (`TENANT` /
`PLATFORM`, `/github` in `NO_ALIAS`) and the tenant ones in `test/secrets.api.test.ts`'s REQUESTS.

## 10. Org settings (the SPA)

- **Repositories**: a "GitHub App" panel above the list when `configured` — no installation: one accent
  **Install on GitHub** button (and the setup checklist's GitHub step becomes "Install the GitHub App"); each
  installation: the account, "all / N selected repositories", suspended state, last delivery, Refresh,
  Disconnect (the confirmation modal), "Manage on GitHub" (`manage_url`), and its repos with Connect /
  Make primary / Connected. A repo row with `connection: "app"` shows "via GitHub App" and no webhook-secret
  action. The `?github=connected|requested` landing flashes a toast.
- **Integrations**: for an org whose primary repo is on the App, the `github_token` slot and every App-connected
  repo's `github_webhook` slot are not EXPECTED (`src/integrations/catalog.ts` `slots()`); a still-stored one
  shows as `expected: false` so it can be deleted.

## 11. Registering the App (owner steps — verify against real calls)

- Homepage `<origin>`; **Callback URL** and **Setup URL** both `<origin>/github/app/setup` ("Redirect on update"
  on); "Request user authorization (OAuth) during installation" OFF (the flow does its own hop); user-token
  expiry ON. **Webhook** active, URL `<origin>/webhook/github-app`, a generated secret.
- **Repository permissions, read-only**: Metadata, Contents (commits, compare, branches), Pull requests (lists,
  reviews), Issues, Deployments, Checks, Actions (workflow runs and jobs), Commit statuses. No write permission,
  no organization or account permission.
- **Events**: Issues, Pull request, Push, Pull request review, Deployment status, Check run, Workflow run,
  Status (installation events are always delivered).
- "Where can this App be installed": Any account.
- Generate a private key; set the six secrets. Then install on SaplingLearn/sapling from Org settings: the
  existing `org_repos` row attaches, the token path and the legacy webhook keep working beside it, and once the
  Repositories panel shows deliveries arriving, the legacy webhook and `GITHUB_SERVICE_TOKEN` can go (Phase 7).

The permission list above is what the readers call; it has NOT been checked against a live App. The first
reconcile after installing is the check: any arm in `failed` names a missing permission.

## 12. Tests

`test/github-app.*.test.ts`: the JWT (PKCS#1 and PKCS#8 keys generated in-test, verified with the public key),
minting and the resolver (installation preferred, suspended → fallback, mint failure → fallback, bearer and
member refused), the webhook (bad signature writes nothing; an installation bound to org A never delivers into
org B; unbound / suspended ignored; non-primary ignored; installation and installation_repositories events),
the install flow (a forged installation id — one the person's token cannot see — is refused; a superset
failure; bound elsewhere; state mismatch; a member; no cookie), the routes' gates, and the leak rule: no App
secret, JWT, installation token or user token appears in a response, a log line or a D1 column.

## 13. Deferred

Capturing NON-primary repos (the capture tables already key on `(org_id, repo, semantic_key)` — but no insert
writes `repo`, every row carries the transitional default, and no reader filters on it: writing it, a backfill
of existing rows and repo-filtered readers is its own change). Sign-in through the App. Deleting the legacy
token / webhook path (Phase 7).
