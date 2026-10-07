# The GitHub App — how an organization connects its repositories

Issue #95. Code: `src/github-app/`, `src/auth/tx.ts`, `shared/github-app.ts`, `web/src/github-app.ts`.
Migration: `0043_github_app`. Tests: `test/github-app.*.test.ts`, `test/render.github-app.test.ts`.

Trov is ONE GitHub App. It signs people in (its client id and secret are `GITHUB_CLIENT_ID` /
`GITHUB_CLIENT_SECRET`), and an organization connects its repositories by **installing** it: no token to
paste, no webhook to add. The pasted token and the per-repository webhook stay as the fallback —
SaplingLearn runs on them until it installs the App, and a self-hosted Trov may have no App at all.

## What is stored

`org_github_installations` — the binding of a GitHub installation to a Trov org: the installation id, the
account it is on (login, numeric id, `User` / `Organization`), `all` / `selected` repositories, who
connected it and when, `suspended_at`, `removed_at` + `removed_reason`, `last_used_at`, `last_error`.
A row is never deleted; ending a binding sets `removed_at`.

- **An installation belongs to at most one org, and an org has at most one live installation** — two partial
  unique indexes (`WHERE removed_at IS NULL`). One installation is one GitHub account, so an org connects
  one account at a time. That is the simplest rule that is correct today: an org's GitHub credential is a
  single value and only its primary repository is captured, so a second account could be listed but not
  read. Lifting it means dropping the org index and resolving the credential per repository owner.
- `org_repos.connection` is `app` for a repository the installation can see and `manual` otherwise;
  `org_repos.access_lost_at` marks an `app` repository the installation stopped seeing.
- **The same repository in two orgs.** An App-connected repository belongs to one installation, and an
  installation to one org — so it is tracked by one org, by construction. A repository added by name
  (`manual`) is unchanged: two orgs may each track it with their own token and webhook, as before. No
  new unique index was needed, and none was added.

No token is ever stored: not the user's, not an installation's. Nothing in these tables is secret.

## The connect flow

```
Org settings › Repositories › Connect with GitHub          (an <a>, not a fetch)
  → GET /api/o/:slug/github/install                         tenantGate, cookie only, admin+
      sets `gh_install`: HMAC-sealed { org id, slug, person, state, mode, exp }, HttpOnly, Secure,
      SameSite=Lax, Path=/auth, 15 minutes — and redirects to
  → https://github.com/apps/<slug>/installations/new?state=<state>
  … the person picks an account and repositories on GitHub …
  → GET /auth/callback?code=…&installation_id=…&setup_action=install|update&state=…
      (the App has "Request user authorization (OAuth) during installation" on, so GitHub returns to
       the CALLBACK URL with a user authorization code — there is no Setup URL)
  → 302 /o/<slug>/?github=<outcome>#org/repos               always a redirect, never JSON
```

The start route is a GET, so it refuses a navigation that did not come from Trov's own page
(`Sec-Fetch-Site` other than `same-origin` / `none`): a link on another site must not be able to begin a
connection — or, with `?existing=1` and GitHub's instant re-authorization, finish one — in an admin's
browser.

`/auth/callback` recognises the install return by `installation_id` / `setup_action` — parameters a
sign-in never carries — and handles it apart (`installReturn`). A callback without them runs the sign-in
exactly as before.

### Why a forged or replayed return cannot bind (`verifyAndBind`)

`installation_id` arrives in a URL, so by itself it proves nothing. An installation is bound only when
ALL of these hold; a failure at any step writes nothing:

1. **Our cookie and state.** The browser holds the sealed `gh_install` cookie, unexpired, and the `state`
   GitHub handed back equals the one sealed in it. So the return answers a flow THIS browser started,
   for THAT org. The seal key is `gh-install:` + `COOKIE_SECRET`; the cookie is spent on first use.
2. **The same person, still an admin.** The person signed in to Trov now is the person the cookie names,
   and `resolveTenantById` says they are an admin or owner of that org today.
3. **Their own GitHub account.** The code is exchanged for a GitHub user token; `GET /user` must name the
   GitHub identity linked to that Trov person (login, and the pinned numeric id when one is pinned) — the
   match sign-in makes. A code minted for another GitHub account is refused here.
4. **GitHub says they can reach it.** `GET /user/installations` (paginated, with the user token) must list
   `installation_id`. A list that did not arrive in full is not a yes. A guessed or copied id that the
   account cannot reach stops here — before Trov asks the App anything about it.
5. **No escalation.** `GET /user/installations` lists an installation for anyone with access to at least
   one of its repositories, so step 4 alone would let a collaborator on one repository attach an
   organization's whole installation. The account must be able to read EVERY repository the installation
   covers — see "The no-escalation check" below.
6. **One org, one installation.** No other org holds it (`installationOrg`, a platform read — it sees a
   suspended org's binding too) and this org holds no other; the unique indexes say so again at the write.

The installation's account comes from GitHub **as the App** (`GET /app/installations/:id`), never from
the URL or the user's list. The user token is used for those reads and then revoked (below).

A replayed callback URL has no cookie (it was spent) → nothing. A return opened in another person's
browser fails 1 or 2. A code for another GitHub account fails 3. An attacker's own valid flow with a
victim's `installation_id` fails 4.

### The no-escalation check (`installationRepoIds`, `userInstallationRepoIds`)

Two lists of repository **ids**, each read to its end, 100 a page:

- what the installation covers — `GET /installation/repositories`, with an installation token that spans
  the installation and carries Metadata only;
- what the connecting account can read of it — `GET /user/installations/:id/repositories`, with the
  user token. GitHub's 404 on the first page means "none".

The installation is bound only when **every id of the first list is in the second**. Ids, not counts: two
counts can agree while the repositories differ (the account reads two repositories, the installation
covers two, and only one is the same), and a count taken from one page says nothing of the others.

- A refusal says HOW MANY repositories the account cannot read (`?github=partial_access&missing=<n>`),
  never which — their names are exactly what the person may not be allowed to see.
- **It fails closed.** A page that is not a 200, a thrown fetch, a body with no `total_count` or no list,
  a row with no numeric id, a short page that is not the last, more rows than the count, a 404 anywhere
  but the user's first page → `github_failed`, nothing bound.
- **The cap: `REPO_ID_PAGES` = 10 pages, 1,000 repositories.** An installation that covers more is not
  checked at all (GitHub's own `total_count` says so on the first page, so it costs one request):
  `too_many_repos`, and the sentence tells the admin to choose **Only select repositories** for the Trov
  App on GitHub and connect again. The cap bounds the check at 20 requests — a Worker invocation's
  subrequests are limited, and the rest of the flow spends about a dozen. Raising it is a constant.
- **No exemption for a personal account.** Its owner can read every repository of their own account, so
  they pass the same check as anyone; the earlier special case (skip the check when the installation's
  account IS the connecting account) saved two requests and was one more branch to get wrong.

### The user token is revoked (`dropUserToken`)

The code is exchanged for a GitHub user token only to answer checks 3–5. Once the decision is made —
bound, refused, or an error after the exchange — Trov revokes it:
`DELETE /applications/{client_id}/token`, HTTP Basic `client_id:client_secret`, body
`{ "access_token": … }`. Best effort: it runs after the response (`waitUntil`), has a five-second
timeout, never changes the redirect, and is not retried. A revoke GitHub did not confirm (anything but
204) is one fixed log line; the token is in no log line, no response and no row. The token was never
stored, so a failed revoke leaves it to expire on GitHub's side (eight hours, with "Expire user
authorization tokens" on).

**Sign-in does not revoke.** Its token is used for `GET /user` and `GET /user/emails` and dropped, in
the same request. Revoking there would add a request to every sign-in for a call that has not been run
against real GitHub yet, in a path that is otherwise untouched by this feature (`src/auth/github.ts`'s
surface is pinned by `test/auth-github.test.ts`). Once the revoke is seen working on a connect, sign-in
can call the same `revokeUserToken`.

### PKCE and `state` on GitHub's side

GitHub starts the installation-initiated authorization itself, so Trov never sent a `code_challenge`
for it and there is no verifier to present: the exchange sends `client_id`, `client_secret` and `code`
only (`exchangeCode` leaves `code_verifier` and `redirect_uri` out when it has none). The binding to this
browser is the `state` round trip plus the sealed cookie. **This could not be run against real GitHub
from here** — see "Verify after deploy".

### Linking an installation that already exists

`GET /api/o/:slug/github/install?existing=1[&account=<login>]` runs an ORDINARY authorization
(`/login/oauth/authorize`, our `state` + PKCE, `beginTx(c, "connect")`), then finds the installation from
`GET /user/installations`: exactly one that is free → the same checks 2–6 and the binding; several →
`?github=choose&accounts=…`, and the page offers each account. It exists because GitHub's install page
does not have to redirect back for an App that is already installed (it was installed from GitHub's side,
or Trov was disconnected and the App left in place).

### Everything else that can come back

| Return | What happens |
|---|---|
| `setup_action=request` (a member asked a GitHub org owner to approve) | nothing exists yet → Repositories says the request is pending; no GitHub call, no row |
| install / update with NO cookie of ours (installed from GitHub's side, "Configure" there) | nothing is bound. Signed in → their Repositories tab, with how to connect it; not signed in → the landing page. The code is NOT used to sign anyone in: with no state of ours behind it that would be a sign-in an attacker could start in someone else's browser. (If the request does answer a sign-in transaction of this browser — its sealed `oauth_tx` state — the ordinary sign-in runs.) |
| GitHub unreachable, a code it will not exchange, a suspended installation, App credentials it refuses | `github_failed` / `suspended` / `not_configured`; nothing written |

Outcomes are `shared/github-app.ts` `GITHUB_CONNECT_OUTCOMES`; the SPA reads `?github=` once at boot,
shows one sentence (`connectNoticeCopy`) and rewrites the address bar.

## Tokens

- **App JWT** (`jwt.ts`): `{ alg: RS256, typ: JWT }`, `iat` = now − 60 s, `exp` = now + 9 min, `iss` = the
  numeric App id, signed with WebCrypto. GitHub issues the key as PKCS#1 (`BEGIN RSA PRIVATE KEY`);
  WebCrypto imports PKCS#8, so the PKCS#1 bytes are wrapped in a `PrivateKeyInfo`. A PKCS#8 PEM is
  accepted as is, and a key pasted on one line with `\n` is read. Every failure is a fixed-text
  `GithubAppKeyError` — never the PEM, never the underlying exception.
- **Installation token** (`api.ts`): `POST /app/installations/:id/access_tokens` → good for about an
  hour, and **never wider than the read it is for** — the mint's body names the one repository and the
  permissions (the table below). Cached **per isolate, in memory**, keyed by App id + installation id +
  repository + permissions, handed out until ten minutes before expiry; concurrent callers for the same
  scope share one mint, and a token minted for one repository is never handed to a read of another.
  Never in D1, never logged. A 401 on a read made with it forgets THAT token; the next use mints again.
  The binding ending, a suspension or `new_permissions_accepted` forgets every token of the installation.
- **The credential order** (`credential.ts` `resolveGithubCredential`): (a) the org's live, unsuspended
  installation — for a repository its account owns; (b) the org's stored `github_token`; (c) for
  SaplingLearn alone, the Worker's `GITHUB_SERVICE_TOKEN`. It throws for an MCP (bearer) context and for
  a member, like `getSecret`. It is called only from modules `src/mcp.ts` cannot reach
  (`src/repo/cron.ts`, `src/github-hook.ts`, `src/tools/backfill.ts`, `src/integrations/logo.ts`,
  `src/github-app/*`) and the revealed token goes down as a parameter; `test/secrets.mcp.test.ts`
  forbids anything MCP-reachable from importing `src/github-app/` at all.
- **When GitHub will not issue one.** 404 → the installation is gone: the binding is ended
  (`not_found`), audited as `system`. 403 naming a suspension → `suspended_at` is set. 401 (the App's own
  id / key), an outage, or 422 (the repository is not one the installation covers, or a permission the
  App was not granted) → `last_error` only; the binding stays. In every case the stored token answers
  in the same run, and an ended or suspended binding is not asked again — no loop. A 422 IS asked again
  by the next job for that repository (one request): a repository under the installation's account that
  the installation does not cover is read with the stored token, as a repository of any other account is.

### What each token is minted for

| Caller | `repositories` | `permissions` | Cached |
|---|---|---|---|
| The reconcile, Sync GitHub (backfill), the progress backstop — `resolveGithubCredential({ repo })` | the org's primary repository, by name | Metadata, Contents, Pull requests, Issues, Actions, Checks, Deployments, Commit statuses — all `read` (`READ_PERMISSIONS`) | yes, per (installation, repository) — these callers share one token |
| The follow-up reads of a webhook delivery (the App's webhook and the per-repository hook), resolved lazily | the delivery's repository | the same | the same entry |
| The org image's import (`GET /users/{owner}`) | the primary repository | the same — it rides the reconcile's unit and uses that unit's token. The lookup needs no permission; a second, Metadata-only token would add a mint an hour and take nothing away from what the isolate already holds | the same entry |
| The repository picker and its re-marking (`visibleRepos`), Test connection, the connect flow's no-escalation check — `GET /installation/repositories` | none: the list has to span the installation (a token narrowed to repositories lists only those) | Metadata only (`INSTALLATION_SCOPE`) — it can read no code, pull request or issue | yes, per installation |

GitHub refuses a mint that asks for a permission the App was not granted, so `READ_PERMISSIONS` is
exactly the App's registered repository permissions. Adding a reader that needs another means adding it
to the App on GitHub first (existing installations must accept it), then here.

Every log line and every stored `last_error` is fixed text or goes through `scrub`
(`test/github-app.jwt.test.ts` drives upstreams that echo the Authorization header back).

## The webhook

`POST /webhook/github/app` — one URL for every installation (`webhook.ts`; matched in `src/index.ts`
before the per-repo hook's path).

1. HMAC-SHA256 over the raw body against `GITHUB_APP_WEBHOOK_SECRET`, constant time. No secret
   configured, no signature, a bad one → the same bare `401 {"error":"unauthorized"}` the per-repo hook
   gives, nothing written.
2. `installation.id` → the org of its LIVE binding. Unknown installation, or none in the payload → `202
   ignored`, no rows.
3. `installation` — `deleted` ends the binding (`uninstalled`), `suspend` / `unsuspend` mark it,
   `new_permissions_accepted` is recorded; `created` binds nothing. `installation_repositories` —
   `added` / `removed` re-mark the org's repositories and update the selection. All audited with the
   actor `github-webhook`.
4. Any other event is a repository's: it must be one THAT org tracks, and its **primary** — otherwise
   `202 ignored`. Then `captureDelivery` runs as that org's system tenant, exactly as the per-repo hook
   runs it, with the installation token resolved lazily for follow-up reads.

**Capture is still the primary repository only.** The capture's keys (`gh:pr:<n>:…`) carry no
repository, so a second repository's PR #7 would collide with the first's. Other tracked repositories
are listed, resolve links, and can be made the primary; the UI says so.

**Both paths at once.** During a cut-over the same event may arrive through the App's webhook AND the
org's old per-repo (or legacy) webhook. The capture's keys are per org, so the second arrival writes
nothing (`test/github-app.webhook.test.ts` › "one event through BOTH paths").

## Uninstall, suspend, disconnect

| | Binding | Repositories | Reads |
|---|---|---|---|
| **Disconnect** (an admin, in Trov) | ended, `disconnected` | stay connected, back to `manual` | the stored token, if any. The App stays installed on GitHub |
| **Uninstalled on GitHub** (webhook, or a 404 at the next token) | ended, `uninstalled` / `not_found` | same | same; Org settings says "GitHub is no longer connected" until reconnected |
| **Suspended on GitHub** | live, `suspended_at` set | unchanged | the stored token, if any; a banner; Test connection re-reads the state from GitHub and lifts it |
| **A repository removed from the App's selection** | unchanged | that one gets `access_lost_at` | reads of it fail until access is restored |

## Permissions ↔ endpoints

Read-only everywhere. The App's registered permissions: Metadata, Contents, Pull requests, Issues,
Actions, Checks, Deployments, Commit statuses (repository); Email addresses (account).

| Endpoint | Called by | Needs |
|---|---|---|
| `GET /repos/{r}` | Test connection (the token's row) | Metadata |
| `GET /repos/{r}/pulls` (open, closed) | reconcile, Sync GitHub | Pull requests |
| GraphQL `repository.pullRequests{ reviews }` | reconcile (reviews) | Pull requests |
| `GET /repos/{r}/issues`, `/issues/{n}`, `/milestones/{n}` | Sync GitHub, sprint progress | Issues (a PR returned by `/issues` also needs Pull requests) |
| `GET /repos/{r}/commits`, `/compare/{a}...{b}` | reconcile (pre-capture window, environment heads), drift | Contents |
| GraphQL `repository.refs{ target, compare }` | reconcile (branches) | Contents |
| GraphQL `repository.deployments{ statuses }` | reconcile (deployments) | Deployments |
| `GET /repos/{r}/actions/runs`, `/actions/runs/{id}/jobs` | reconcile, the failed-job lookup | Actions |
| `GET /repos/{r}/commits/{ref}/check-runs` | reconcile (environment head checks) | Checks |
| `GET /repos/{r}/commits/{ref}/statuses` | reconcile (`canopy/*` statuses) | Commit statuses |
| `GET /users/{owner}`, then `avatars.githubusercontent.com` | the org image's import | none (public; the avatar is fetched with no token) |
| `GET /installation/repositories` | the repository picker, Test connection, the no-escalation check | any installation token (Trov's carries Metadata only) |
| `GET /app/installations/{id}`, `POST …/access_tokens` | binding, minting, Test connection | the App JWT |
| `GET /user`, `/user/emails` | sign-in, connect | Email addresses (for `/user/emails`) |
| `GET /user/installations`, `/user/installations/{id}/repositories` | connect | a user token of this App |
| `DELETE /applications/{client_id}/token` | connect, when it is done with the user token | the App's client id and secret (HTTP Basic) |

Webhook events and the permission each requires: Pull request, Pull request review → Pull requests;
Issues → Issues; Push → Contents; Deployment status → Deployments; Check run → Checks; Workflow run →
Actions; Status → Commit statuses. **Nothing the code calls is outside the registered set**, and every
repository read above is made with a token minted for that repository with exactly these eight ("What
each token is minted for"). GraphQL is served to installation tokens; the three queries above read only
what those permissions cover.

## When the App is not configured

`appConfigured(env)` = a valid `GITHUB_APP_SLUG`, a numeric `GITHUB_APP_ID` and a `GITHUB_APP_PRIVATE_KEY`.
Without all three: `GET …/github` says `configured: false`, Repositories offers adding by name as its
primary action and says the App is not configured on this Trov, the start route redirects back with that
sentence, and no org's reads change. Without `GITHUB_APP_WEBHOOK_SECRET` every delivery to the App's
webhook is the bare 401. A key that does not import behaves like a missing one at use (`credentials`).
Nothing 500s.

## Owner checklist — production, in order

1. **Secrets.** `npx wrangler secret put GITHUB_APP_ID` (paste the App's numeric id — "App ID" on its
   settings page, not the client id), then
   `npx wrangler secret put GITHUB_APP_PRIVATE_KEY < /path/to/your-app.private-key.pem` (the whole file
   GitHub generated; the redirect keeps its line breaks). `GITHUB_APP_WEBHOOK_SECRET` is already set. A
   secret change ships the latest uploaded build, so do this when that build is the one you mean to run.
2. **The slug.** In `wrangler.toml` set `GITHUB_APP_SLUG = "<the last part of https://github.com/apps/…>"`
   and deploy (merging to `main` deploys, and applies `0043_github_app`).
3. **On GitHub, in the App's settings:** Webhook → Active, URL `https://trov.dev/webhook/github/app`,
   the secret you already set; subscribe to Pull request, Pull request review, Issues, Push, Deployment
   status, Check run, Workflow run, Status. Leave `https://trov.dev/auth/callback` as the FIRST callback
   URL (GitHub returns there after an install) and "Request user authorization (OAuth) during
   installation" on.
4. **In Trov:** sign in as SaplingLearn's owner → Org settings › Repositories › **Connect with GitHub** →
   install on the SaplingLearn GitHub organization, choose the repositories → you come back to
   Repositories with "GitHub is connected". `SaplingLearn/sapling` is marked "Through the GitHub App".
   Open Integrations → the App's row → **Test connection**.
5. **Check deliveries.** On GitHub: the App's settings › Advanced › Recent Deliveries should show 200s
   (202 for events about repositories Trov does not capture).
6. **Then retire the old path, in this order:** delete SaplingLearn's repository webhook on GitHub (it and
   the App were both delivering; each event was captured once); in Org settings › Integrations › Manual
   connection delete the stored GitHub token and webhook secret, if any were entered; and delete the
   Worker secrets `GITHUB_SERVICE_TOKEN` and `GITHUB_WEBHOOK_SECRET` (they are only SaplingLearn's
   fallback). Nothing breaks if you leave them: the App is asked first.

## Verify after deploy (could not be run against real GitHub)

Everything above is tested against a stubbed GitHub. These rest on GitHub's documented behaviour and
were not exercised for real:

- that the install return carries `state` back when `installations/new?state=…` was used, on `install`
  AND on `update`. If it does not, the return reads as "not started here" (`expired`) and binds nothing —
  the fallback is **Link the existing installation**, which does not depend on it;
- that the token exchange for an installation-initiated authorization succeeds with no `code_verifier`
  and no `redirect_uri` (step 4 of the checklist proves it);
- that `GET /user/installations/:id/repositories` lists, for an owner of the account (an organization's
  owner AND the owner of a personal account, which no longer skips the check), every repository
  `GET /installation/repositories` lists, with the same ids. If GitHub leaves one out for a legitimate
  owner, connecting is refused with "cannot read N of the repositories" — it fails closed;
- that GitHub accepts the scoped mint body exactly as sent — `{ "repositories": ["<name>"], "permissions":
  { "metadata": "read", "contents": "read", "pull_requests": "read", "issues": "read", "actions": "read",
  "checks": "read", "deployments": "read", "statuses": "read" } }`, and `{ "permissions": { "metadata":
  "read" } }` for the installation-wide token — and that a refusal is the 422 the code expects. If it
  refuses, the binding's `last_error` says so and the stored token (if any) answers; an org with no
  stored token reads nothing until it is fixed. **Run Test connection and one Sync GitHub right after
  connecting**: the first proves the Metadata-only mint, the second the repository-scoped one;
- that a repository's name is matched without regard to case in `repositories` (Trov sends the name as
  the org tracks it, which for an App-connected repository is GitHub's own spelling);
- the revoke: `DELETE /applications/{client_id}/token` with Basic auth and `{ "access_token" }` answering
  204 for a user token of a GitHub App. If it does not, the log shows "GitHub did not confirm revoking
  the user token" on every connect and nothing else changes;
- that `iss` as a number is accepted for this App (it is the form GitHub has always documented);
- the exact 403 body of a suspended installation's token request (matched on the word "suspended");
- the three GraphQL queries under an installation token with the permissions above.

Local development: the App's FIRST callback URL is production's, so GitHub's install return cannot land
on `localhost`. `?existing=1` passes its own `redirect_uri` and can be used locally with a dev App.
