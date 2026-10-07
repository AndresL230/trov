# Data layer — tenant and platform contexts

Spec: `canopy-multitenancy.md` §4–§8. Code: `src/data/`, `src/routes.ts`. Phases 3–5 are complete: every statement in `src/` runs
through a context, every tenant statement names its org, and `test/data-layer.static.test.ts` enforces both.
What is left (Phase 7 cleanup) and the deploy runbook: `HANDOFF.md`. Rate limits and mail: `abuse-limits.md`.
The flow a human operator follows — add an org, name its admin, set it up, invite the team: `organizations.md`.

## The two contexts

| | Type | Built by | Query surface |
|---|---|---|---|
| Tenant data | `TenantContext { orgId, userId, role, via }` | `resolveTenant` (slug + membership), `resolveTenantById` (a credential that names its org), `resolveSoleTenant` (cut-over alias: the caller's one org), `resolveBearerTenant` (`src/data/bearer.ts`), `systemTenant(p, orgId, actor)` | `src/data/sql.ts` |
| Platform data | `PlatformContext { actor }` | `platform(env, actor)` | `src/data/platform-sql.ts` |

Both surfaces export the same helpers — `first`, `all`, `run`, `stmt`, `batch`, `fanOut`, plus `nowIso`, `ph`,
`chunked`. D1 is reachable ONLY inside `src/data/` (the handle sits behind a module-private symbol in
`context.ts`); nothing else names `D1Database`, `env.DB`, `.prepare(` or `.batch(`.

- Every resolver is ONE statement and also reads `orgs.suspended_at`: a suspended org resolves for no one
  (`resolveTenant` / `resolveTenantById` → null; `resolveSoleTenant` → `reason: "suspended"`; bearer → `unauthorized`).
  The bearer resolver is two reads: the credential by hash, then `resolveTenantById` for the org on its row.
- `c.var.ctx` / `c.var.p` are set by `src/data/gate.ts`. `tenantGate` is mounted ONCE, on `/api/o/:slug/*` in
  `src/routes.ts`, and meters the request — a sub-app never applies it again. See "Routes and gates" below.
- A repository never builds a context. A module that touches both kinds takes the tenant ctx and receives
  `p` as a parameter. (One exception: `createOrg` writes the new org's seed rows as `systemTenant(p, newId)`.)
- `src/data/secrets.ts` reads its key through `kekOf(ctx)`; no other module can reach a context's `Env`.

## Bearer: MCP is bound to (user, org) — Phase 5a (spec §7)

- A personal token (`mcp_tokens`) and an OAuth grant (`oauth_grants`, with its `oauth_codes`) each carry the
  `org_id` they were made for. `resolveBearerTenant` reads the credential by hash → `{ handle, orgId }` from the
  ROW, then builds the context with `resolveTenantById(env, handle, orgId, "bearer")`: the role is the person's
  role in that org today. No header, query or body value can name another org; no tool takes an org argument.
- Every miss is the same `unauthorized` (`/mcp` → 401 `invalid_token`): unknown / revoked / expired credential,
  the person no longer a member of the row's org, that org suspended or gone. There is no 409 on `/mcp` any more.
- Rows from before org-scoping carry `org_saplinglearn` (the organizations migration's column default backfilled them), so they resolve
  as they always did. The Phase 7 cleanup drops the default; every writer already names the org.
- Tokens: `mintToken(ctx)` / `listTokens(ctx)` / `revokeToken(ctx, id)` are TENANT statements (the caller's own
  tokens for `ctx.orgId`), served at `GET|POST /api/o/:slug/mcp-tokens`, `POST …/:id/revoke`
  (`src/auth/token-routes.ts`). `/auth/mcp-token…` is the cut-over alias for a person with exactly one org.
- OAuth: the consent page lists the person's orgs (`listMyOrgs`; a radio group when there are several, a hidden
  field when there is one, a "join an organization first" page when there are none). The POSTed `org` slug is
  bound through `resolveTenant` — a live membership check — and `issueAuthorization(ctx, …)` writes the grant and
  code as tenant statements. Code exchange and refresh re-read the grant's standing (`GRANT_STANDING`): a
  membership that is gone refuses AND revokes the grant (`member_removed`); a suspended org refuses without
  revoking. `GET /auth/oauth-grants` stays user-level and each row carries `org: { slug, name }`.
- "Admin" over MCP is `hasRole(ctx, "admin")` — `update_plan`'s registration and the lane's two admin
  exceptions (`src/tools/tickets-agent.ts`). There is no allowlist of handles anywhere.
- `get_repo_dashboard` reads the org's own `org_repos` / `org_environments` (`orgRepoConfig`,
  `src/tools/repo-agent.ts` — it may not import `src/integrations`, see `test/secrets.mcp.test.ts`); a bare
  `#214` resolves against the org's primary repo (`ticketLinkRepo`, `src/tools/tickets.ts`).

## A ticket's and a handoff's two ids (spec §12 Q2)

`tickets.number` / `handoffs.number` (0042_organizations: allocated per org by an AFTER INSERT trigger from `org_counters`)
is the id a person or an agent SEES and TYPES. **The wire's `id` IS that number** — every route param and
body field (`/tickets/:id`, `child_id`, `after_id`, `/handoffs/:id`), every MCP argument and result, quick
search (`#12`), My Work, a sprint's ticket list, `parent_id`, each sub-row's `ticket_id`, and an artifact's
link ref (`artifact_links.target_ref` stores the number; the row has its own `org_id`). The global row `id`
never leaves the Worker: the exported functions of `src/tools/tickets.ts`, `reads.ts`, `tickets-agent.ts`
and `handoffs.ts` take and return numbers, resolve the row once (`WHERE number = ? AND org_id = ?`) and use
its `id` for joins and foreign keys (`parent_id`, `ticket_assignees.ticket_id`, `tickets_fts`). Sprints,
comments, links and history rows have no per-org number: their ids are still global.

SaplingLearn's numbers equal its ids (the organizations migration's backfill; `test/migrations.multitenancy.test.ts` asserts it and
`scripts/mt/verify-migration.mjs` checks it on a production export), so its existing links name the same
rows. `test/numbers.per-org.test.ts` drives every route and tool with row ids that differ from numbers.

**Links into an org** (`src/tools/org-links.ts`): a URL the Worker hands out — an MCP result's `url` /
`raw_url`, a digest's deep link — is `<origin>/o/<slug>/#…` (`<origin>/api/o/<slug>/raw/a/…`), built from the
org of the context that produced it.

## Which tables are which

The lists are derived from the live schema — every table with an `org_id` column is **org-keyed**.

- **Tenant tables**: every org-keyed table except the five below. That includes all content tables and their
  FTS tables, the per-user-per-org tables (`mcp_tokens`, `oauth_grants`, `oauth_codes`, `notification_*`), and an
  org's own configuration: `org_repos`, `org_environments`, `org_integration_config`, `org_login_map`,
  `org_secrets`, `org_keys`, `org_audit` (read through a tenant ctx by `src/integrations/*`, `src/data/secrets.ts`)
  and `org_github_installations` (0043_github_app — the org's GitHub App installation, `src/github-app/store.ts`).
- **Platform-owned org-keyed tables**: `memberships`, `org_invites`, `org_counters`, `org_usage_daily`,
  `org_admin_audit` — an org's place on the platform, written by `src/orgs`, `src/platform`, `src/data/meter.ts`.
  A tenant statement may read or write them too (membership checks, the settings audit) — with its `org_id`.
- **Global tables** (no `org_id`): `persons`, `identities`, `sessions`, `invites`, `oauth_clients`,
  `oauth_tokens`, `orgs`, `platform_admins`, `cron_cursor`, `abuse_counters` (0042_organizations), `sections`, `tags`.

## Writing a statement

- A predicate is written exactly `org_id = ?` / `<alias>.org_id = ?`, bound from `ctx.orgId` — never a literal,
  never a request value. One per org-keyed table the statement references, JOINs and subqueries included.
- The predicate is in the STATEMENT TEXT, not in a `clauses` array:
  `` `… WHERE t.org_id = ?${clauses.map((c) => ` AND ${c}`).join("")}` ``.
- Every `INSERT INTO <org-keyed table>` lists `org_id`; an upsert target names it (`ON CONFLICT(org_id, …)`).
- A lookup by a global id is `WHERE id = ? AND org_id = ?` — another org's id reads as not found.
- FTS: `org_id` is the LAST column; every `MATCH` adds `AND <fts>.org_id = ?` in the `WHERE` that carries the `LIMIT`.
- ``fanOut(ctx, ids, (ph) => `… WHERE org_id = ? AND id IN (${ph})`, [ctx.orgId])`` — the org goes in `leading`.
- A handle from input that must be a person in the org goes through `requireMember(ctx, handle)` /
  `memberHandle` / `memberPerson` (`src/auth/persons.ts`): unknown, reserved and non-member read the same
  (`PersonError`, a `bad_request` on HTTP and MCP). A ticket's assignees and requester, a handoff's recipient
  and a sprint's `lead` (`sprintLead` — `create_sprint` and the plan write) all do.
- A bare issue ref (`#214`) resolves against the org's PRIMARY repository (`ticketLinkRepo`) or is refused:
  there is no default repository.
- SQL keywords are upper-case, and a file that imports BOTH surfaces aliases one of them (`platformFirst`).

## The static test (`test/data-layer.static.test.ts`)

It reads the source text of `src/` (extractor: `test/helpers/sql-extract.ts` — comments, strings, template
holes and regex literals are tokenised; each literal knows its enclosing calls and its top-level declaration).
A statement's surface is the helper call around it, else the file's only surface, else (a two-surface file)
the surface of whatever uses the constant it is bound to. A failure names `file:line`, the rule and the statement.

1. No D1 access outside `src/data/`. No allowlist.
2. A tenant statement has `org_id` once per org-keyed table reference, in every INSERT column list and upsert
   target, and never against a literal. A statement that cannot be attributed to a surface fails.
3. A platform statement names no tenant table, except `PLATFORM_ALLOW` (below). A stale entry fails.
4. The table lists come from `sqlite_master` / `pragma_table_info`, so a new table is covered automatically.

Also checked: the cut-over entry points (below) are the only callers of `src/data/legacy.ts`, each marked `// MT:`.
It is a text heuristic, not a proof — it counts `org_id` mentions, it does not check which parameter is bound —
so the isolation tests (and the §10.3 mutation check) remain the behavioural half.

### Allowlist (each entry: file + function + why — in the test)

| Where | Why |
|---|---|
| `src/platform/sweeps.ts` `expireDueHandoffs`, `pruneRepoCapture` (incl. `hosting_deploys`); `src/auth/oauth.ts` `pruneOAuth` | cross-org retention sweeps: write-only, bounded by age |
| `src/platform/jobs.ts` (`org_repos`, `org_environments`, `org_github_installations`, `org_hosting_connections`) | the cron's unit lists, the webhook's hook lookup and the installation → org lookups — the GitHub App's (`installationOrg`) and a hosting provider's (`connectionsForExternalId`: the uninstall notice, and the connect callback's one-org-per-installation check) — before any org is known — ids, a scope, an environment key and a repo name |
| `src/platform/repo.ts` `listPlatformOrgs` (`org_github_installations`) | the superadmin's org list: the GitHub account an org's installation is on — a name |
| `src/platform/jobs.ts` `listPartUnits` (`org_environment_parts`) | the `hosting` job's units (0044): env / part keys and a provider id — the part's settings are re-read by the unit as its org's tenant |
| `src/auth/tokens.ts` `resolveToken`; `src/auth/oauth.ts` `resolveOAuthAccessToken`, `exchangeAuthorizationCode`, `refreshAccessToken`, `revokeOAuthToken`, `grantRefusal` | credential lookup by HASH before any org is known (the row names the org), and the revoke of the one grant just found |
| `src/auth/oauth.ts` `listGrants`, `revokeGrant` | Connected apps is user-level: a person's own grants across their orgs, keyed by person |
| `src/artifacts/upload.ts` `uploadTokenOrg` | upload-token lookup by hash, returning only its `org_id` |
| `src/platform/usage.ts` (whole file); `src/platform/repo.ts` `listAudit` (`org_audit`) | the superadmin's cross-org counts and merged audit trail — no content, no secret |
| `src/orgs/repo.ts` `removeMember` | revokes the removed person's tokens / grants for that org, in the same batch |
| `src/auth/persons.ts` `renamePerson` (interpolated) | the `HANDLE_COLUMNS` update — a rename must span every org |
| `src/tools/artifacts.ts` `normalizeLinkRef` (interpolated, tenant) | `tickets WHERE number` or `sprints WHERE id` from a two-value literal, with `org_id = ?` |
| `src/tools/progress.ts` upsert on `sprint_progress` | its PK is `sprint_id` alone; guarded by `WHERE sprint_progress.org_id = excluded.org_id` (asserted) |

## Background jobs (Phase 5b — spec §8.3–§8.5)

No background entry point names an org any more: each one ENUMERATES the orgs (or finds the one a delivery
belongs to) through `src/platform/jobs.ts`, then does its work as that org's `systemTenant`.

| Entry point | Org comes from | Runs as |
|---|---|---|
| repo cron `handleRepoCron` (`src/repo/cron.ts`) | `listEnvUnits` / `listRepoUnits` — every non-suspended org | `systemTenant(p, org, "system")` per unit |
| digest crons `handleNotificationCron` (`src/notifications/cron.ts`) | `listActiveOrgIds` | the same, per org |
| `POST /webhook/github/:hookId`, legacy `/webhook/github` (`src/github-hook.ts`) | `hookRepo(p, id)` / `legacyHookRepo(p)` | `systemTenant(p, row.org_id, "github-webhook")` |
| `POST /webhook/github/app` — the GitHub App's one endpoint (`src/github-app/webhook.ts`, `github-app.md`) | `installationOrg(p, <the delivery's installation id>)` | the same |
| repo cron `hosting` job at `:40` (`src/repo/cron.ts`, `src/hosting/poll.ts`) | `listPartUnits` — one per (org, environment, stored part) | `systemTenant(p, org, "system")` per unit |
| `POST /webhook/hosting/:provider` (`src/hosting/webhook.ts`) | `connectionsForExternalId(p, provider, id)` after the provider's signature is verified | `systemTenant(p, org, "system")` per org — `systemRevocationDeleteStmts` deletes the secret |
| `GET /hosting/:provider/callback` (`src/hosting/connections.ts`) | the HMAC-sealed intent in the `trov_hx` cookie, then a LIVE membership check of the signed-in admin (`resolveTenantById`) | that admin's own session tenant — a public path that reads the session cookie itself; exactly `/hosting/<provider>/callback` is a platform path in `src/data/gate.ts` |
| Test connection's 401 on an install / OAuth credential (`src/integrations/probe.ts` → `endRefusedConnection`) | the admin's session tenant | `jobTenant(env, ctx)` — `systemRevocationDeleteStmts` deletes the secret |
| Poll now / Poll usage / Sync GitHub (`runLockedRepoRefresh`, `runUsagePolls`, `runBackfill`, `runReconcileJob`) | the caller's `ctx` | `jobTenant(env, ctx)` — that org's system tenant; a bearer context is refused |

**The rotation dispatcher** (`src/repo/dispatch.ts`). The repo trigger keeps its cadence — `health` every
tick, `usage` at `:00`, and every 6th hour `progress` at `:10`, `reconcile` at `:20`, the cross-org prune
sweeps at `:30` — and each cadence is a JOB over UNITS: one per (org, environment) for `health` / `usage`
(key `<org>/<env key>`, in org then `position` order), one per org with a primary repo for `progress` /
`reconcile` (key `<org>`). One invocation serves units in order, starting after `cron_cursor.last_key` for
that job, while the unit's worst-case cost still fits `CRON_SUBREQUEST_BUDGET` (900 fetches; what a unit
really spent is counted through the budget's own `fetch`) and `CRON_WALL_BUDGET_MS` (8 min) is not spent;
then it stores the last key served (`''` once every unit was served — so with few orgs the cursor is never
written). `health` goes first and may use at most half the budget on a tick that also has a heavy job.
Queues stay a deferred seam: a unit runner (`runEnvJob(env, orgId, envKey, job, now)`,
`runOrgJob(env, orgId, job, now)`) is what a consumer would call, unchanged.

**Isolation.** A unit is TOTAL: it catches its own failure, logs it with `org=<id>`, records it on THAT
org's integration row (`recordSecretOutcome` → `last_error`; a success → `last_used_at`), and the loop moves
on. An org with no environment and no primary repo has no unit — no statement, no request, no log line. A
suspended org is absent from every list, and its hook reads as unknown.

**Configuration and credentials.** The repo is the org's primary `org_repos` row (`orgPrimaryRepo`), the
environments are `org_environments` in `position` order (`orgEnvironments`) — `GITHUB_REPO` and
`REPO_ENVIRONMENTS` are read by NOTHING any more (the dashboard reads use the same rows). The GitHub
credential comes from `resolveGithubCredential(ctx, env, { repo })` (`src/github-app/credential.ts`,
`github-app.md`): the org's live App installation → an installation token, else its stored `github_token`,
else SaplingLearn's legacy secret. Every other credential comes from
`resolveCredential(ctx, env, kind, scope)`: `github_webhook` (the hook id),
`cloudflare_analytics` (`""`, + `resolveCloudflareAccountId`), `railway` and `metrics_endpoint` (the
environment key). Both are resolved ONLY in modules that `src/mcp.ts` cannot reach — `src/repo/cron.ts`,
`src/github-hook.ts`, `src/tools/backfill.ts`, `src/integrations/*`, `src/github-app/*` — and the revealed value is passed down as a parameter
(`src/webhook.ts` and `src/repo/github.ts` ARE reachable from MCP; `test/secrets.mcp.test.ts`). Every log
line and stored `last_error` is scrubbed of every credential the unit revealed.

**Webhooks.** `POST /webhook/github/:hookId`: look the row up, verify the HMAC against that repo's secret,
require the payload to name that repo (else 202 ignored), then `captureDelivery` as the org. Every refusal —
unknown hook id, suspended org, no (readable) secret, bad signature — is the SAME bare 401
`{ "error": "unauthorized" }` with NOTHING written, so a hook id cannot be probed (§8.5). Only the org's PRIMARY repo is captured today —
the capture's keys (`gh:pr:<n>:…`) carry no repo — so a non-primary repo's verified delivery is ignored.
The legacy `POST /webhook/github` delivers to the one `legacy_hook = 1` row with no repository check,
exactly as before.

**Email.** One digest per (person, org): each org is due on its own `notification_settings`, the outbox key
is `org:user:cadence:window`, the unsubscribe is global. The From ADDRESS is the platform's on EVERY mail
path (digest, test send, invite, welcome): `deliveryFor` builds the header, and an org's `from_address`
contributes a sanitised display name only (`platformFrom`, `abuse-limits.md`). `notification_policy` is seeded by
`createOrg` and topped up per org by the cron; the per-isolate seed in `src/index.ts` is gone.

**SaplingLearn's fallback (owner steps).** These Worker secrets are now read ONLY by `resolveCredential`'s
`org_saplinglearn` fallback (and by the cron's log scrubber): `GITHUB_SERVICE_TOKEN`, `GITHUB_WEBHOOK_SECRET`,
`CF_ANALYTICS_TOKEN` + `CF_ANALYTICS_ACCOUNT_ID`, `RAILWAY_TOKEN_<ENV>`, `SAPLING_METRICS_TOKEN`. Each stops
being read the moment SaplingLearn's admin stores that integration on the Integrations screen (a stored
secret wins). The cleanup phase deletes the fallback, those secrets, the legacy hook route and the
`legacy_hook` flag.

## Routes and gates (Phase 4 — spec §5, §6)

Every session request passes `sessionGate`, then exactly one of three things (`src/routes.ts`, `src/data/gate.ts`):

| Path | Gate | Tenant |
|---|---|---|
| `/api/o/:slug/*` — the tenant routes, the org surface (`src/orgs`, `src/integrations`) and a member's own MCP tokens (`src/auth/token-routes.ts`) | `tenantGate` | the org the path names, if the caller is a member — else 404 `{ error: "not_found" }` (unknown slug, non-member, suspended: all alike) |
| `/auth/*`, `/avatar/*`, `/org-logo/*`, `/api/orgs`, `/api/invites`, `/api/platform/*` | none (person-level) | none: these read and write the caller's own person, or are `requireSuperadmin`. `/auth/callback` is also where GitHub returns after the App is installed: it binds an installation only for the org and person a sealed cookie names (`github-app.md`) |
| every OTHER path | `soleTenantGate` (the cut-over alias) | the caller's ONE org — 409 `{ error: "org_required" }` with none or several, 404 if it is suspended |

`soleTenantGate` is the DEFAULT, so a route added without thought is tenant-gated, never open.

- **Defined once, mounted twice.** A tenant route is registered on `tenantRoot` (its suffix is its old path:
  `/docs`) or `tenantApi` (its old path had an `/api/`: `/handoffs` ↔ `/api/handoffs`), and both sub-apps are
  mounted under `/api/o/:org` and at the old prefix. A handler reads `c.var.ctx`, never the path. The org
  segment is `:org` on those mounts because many routes have a `:slug` of their own; `tenantGate` reads its
  own `:slug`. A sub-app mounted at `/` takes no `use("*")`.
- **Alias-only** (`legacyOnly`): `/invites…` (→ `/api/o/:slug/invites…`) and `PUT /api/people/:handle`
  (→ `PUT /api/o/:slug/members/:handle`). Phase 7 deletes the aliases and `soleTenantGate`.
- **Raw artifact bytes** (`src/artifacts/raw.ts`) are ONE sub-app mounted at `/api/o/:slug/raw/a/…` and, as
  its alias, at `/raw/a/…`: the same lock-down headers, sandbox / CSP and access rules on both, wrapped by
  `rawHeaders` BEFORE the gates so the session gate's 401 and the tenant gate's 404 carry them too. Another
  org's slug is the same 404 as an unknown one. Still the app's own origin — moving them off it is §8.6.
- **The SPA shell** is answered by `src/index.ts` for `GET /o/*` and `GET /platform*` (the superadmin's area
  outside any org); neither path reaches the session gate, and both hold no data.
- **Roles** (§5.2): admin means `hasRole(ctx, "admin")` (admin or owner of the request's org) — in the repository
  (`requireRole` → `RoleError` → 403 `forbidden`) or, on a route whose 403 body predates roles, `adminGate`
  (403 `{ error: "admin only" }`). `isAdmin` and the `ADMIN_LOGINS` var are deleted.
- **Confirm verbs** (D6) — promote / reject a doc, ratify / reject an ADR, publish a prompt, ratify an artifact —
  and the whole org surface refuse a request that carries an `Authorization` header (`cookieOnly`).
- **Sync / Poll are the caller's org's**: `POST …/admin/{backfill,poll,poll-usage}` (admin+) run the same job
  functions as the cron for `c.var.ctx`'s org — its repo, environments and stored credentials. An org with
  nothing configured gets "not configured" (503 from Sync GitHub, `"not_configured"` per source from the two
  polls) and no outbound request (`test/jobs.multi-org.test.ts`).
- **Rate limits** (`abuse-limits.md`): a route that sends mail, stores bytes or answers a lookup takes one unit
  with `rateLimited(c, "<key>")` after its validation and role gate — 429 `{ error: "rate_limited", retry_after }`.

### People, invites, attribution

- **Sign-in** (§5.1, `src/auth/onboard.ts`): no GitHub org is checked. A known identity signs in; a new identity
  whose provider-VERIFIED email is another identity's `verified_email` is linked to that person (never
  `persons.email`, which is an editable notification address); otherwise GitHub always reaches onboarding and
  Google only with a pending invite for its verified email. `identities.verified_email` is written at every
  sign-in; `identities.provider_uid` (0042_organizations) pins a GitHub identity to the account's numeric id, and a sign-in
  with the same login but another id is refused.
- **Onboarding creates a person, never a membership** — a new person accepts an invite (`/api/invites`) or creates
  an org (`/api/orgs`). The ONE exception: a live legacy invite for their verified email is consumed as a
  SaplingLearn membership (`consumeLegacyInvite`), and only then is the welcome mail sent.
- **Invitation and welcome mail** (`src/orgs/mail.ts`, 0042_organizations). An e-mail invite created through
  `POST /api/o/:slug/invites` — or by the superadmin naming an owner — is MAILED as the inviting org, and the
  outcome is on its row: `name`, `mail_status` (`sent` / `failed` / null = none), `mail_at`, `mail_error`.
  `POST …/invites/:id/resend` mails a pending one again (409 `no_address` for a GitHub-login invite, which is
  never mailed). The mail's only link is the site root. The welcome is sent on a person's FIRST membership of
  any org (`neverJoined`, asked before the join is written) to a provider-verified address. Neither can fail
  the request that caused it.
- **The legacy `/invites…` routes** (`src/orgs/legacy-invites.ts`) are a view of the caller's org's EMAIL
  `org_invites` rows in the old `InviteRow` shape, and send through the same code. The global `invites` table
  is still read for org #1 only: a pre-0042_organizations row's name and outcome, and the row a first sign-in consumes.
- **Attribution** (C-1): Org settings › Members' login map (Unmatched logins) writes `org_login_map` (admin+), never `identities`.
  `resolvePersonForLogin(ctx, login)` / `memberGithubLogins` read the map first, then a MEMBER's own GitHub identity.
- **`persons.email`**: the person sets their own (`PUT …/notifications/prefs`); an org admin may set it only for a
  member who is in NO other org (`PUT …/notifications/persons/:handle` — 404 for a non-member, 409 otherwise).
  It is a notification address, not an identity and not unique: neither route says whether an address is on
  someone else's row (`abuse-limits.md`).
- **Residue of login-based identity** (invites by GitHub login, `org_login_map`, identities not yet pinned):
  `abuse-limits.md` › Residual risks.

## What is still org #1's alone (Phase 7 removes it)

No entry point acts on "the" org any more. `src/data/legacy.ts` is the only file that names org #1, for two
things that predate orgs:

- **The legacy `invites` table** — `liveLegacyInvite` / `consumeLegacyInvite` (a new person with a live legacy
  invite joins SaplingLearn at onboarding and gets its welcome mail) and `isLegacyOrg` (the sidecar is read and
  written for org #1 only). Callers, each marked `// MT:` and listed with its reason in the static test:
  `src/auth/onboard.ts`, `src/auth/routes.ts`, `src/orgs/legacy-invites.ts`.
- **The env-secret fallback** — `SAPLINGLEARN_ORG_ID`, imported only by `src/data/secrets.ts`
  (`resolveCredential`, `hasLegacyCredential`, `resolveCloudflareAccountId`).

Also cut-over, with no org named: the legacy `POST /webhook/github` (`legacyHookRepo`, the `legacy_hook` flag),
and `resolveSoleTenant` / `soleTenantGate` behind the old-path aliases.

## Tests

`test/helpers/tenant.ts`: `systemCtx(org?)`, `tenantCtx(handle, role?, { orgId, via, env })`,
`bearerCtx(handle, role?, env?, orgId?)`, `mintTokenFor(handle, orgId?)`, `credentialOf(request)`,
`platformCtx`, `ensureMember`, `ORG_A`, `ORG_B`. `test/isolation.mcp.test.ts` is the MCP matrix: its entries are
checked against the server's own registry, so a new tool needs an entry (what to call it with from the other org). `test/helpers/org-config.ts`: an org's repo / environment rows
(`addOrgRepo`, `setOrgEnvironments`), and the one-org call shapes of the background entry points for the
SaplingLearn-only suites (`syncOrgConfig` copies the Env's `GITHUB_REPO` / `REPO_ENVIRONMENTS` into its rows,
as 0042_organizations did). Fixture SQL may use `env.DB` directly; the raw `first` / `all` /
`run` helpers for it live in `test/helpers/db.ts` (production has none). Each module has an isolation
assertion in `test/isolation.*.test.ts`: write through `systemCtx(ORG_B)`, read through `systemCtx()`, expect nothing.

`test/isolation.http.test.ts` is the route-level matrix (§10.2), generated from the Hono route registry: a route
registered on the app with no entry in `TENANT` / `LEGACY_ONLY` / `PLATFORM` fails the suite. Add the entry — a
body that would succeed against org A — with the route (and its prefix to `NO_ALIAS` if it has no old-path
twin). `seedPerson("admin-user")` is the suite's org ADMIN
(`FIXTURE_ADMIN`); `AndresL230` is SaplingLearn's owner; `seedPerson(h, { email, verified: true })` records the
address as provider-verified. Role gates: `test/role-gates.http.test.ts`; sign-in: `test/signin.multitenant.test.ts`;
limits and mail: `test/abuse-limits.test.ts`.
