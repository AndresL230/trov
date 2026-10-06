# Data layer — tenant and platform contexts

Spec: `canopy-multitenancy.md` §4–§6. Code: `src/data/`, `src/routes.ts`. Phases 3 and 4 are complete: every statement in `src/` runs
through a context, every tenant statement names its org, and `test/data-layer.static.test.ts` enforces both.

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
- Rows from before org-scoping carry `org_saplinglearn` (0038's column default backfilled them), so they resolve
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
  exceptions (`src/tools/tickets-agent.ts`). `ADMIN_LOGINS` grants nothing over MCP.
- `get_repo_dashboard` reads the org's own `org_repos` / `org_environments` (`orgRepoConfig`,
  `src/tools/repo-agent.ts` — it may not import `src/integrations`, see `test/secrets.mcp.test.ts`); a bare
  `#214` resolves against the org's primary repo (`ticketLinkRepo`, `src/tools/tickets.ts`).

## Which tables are which

The lists are derived from the live schema — every table with an `org_id` column is **org-keyed**.

- **Tenant tables**: every org-keyed table except the five below. That includes all content tables and their
  FTS tables, the per-user-per-org tables (`mcp_tokens`, `oauth_grants`, `oauth_codes`, `notification_*`), and an
  org's own configuration: `org_repos`, `org_environments`, `org_integration_config`, `org_login_map`,
  `org_secrets`, `org_keys`, `org_audit` (read through a tenant ctx by `src/integrations/*`, `src/data/secrets.ts`).
- **Platform-owned org-keyed tables**: `memberships`, `org_invites`, `org_counters`, `org_usage_daily`,
  `org_admin_audit` — an org's place on the platform, written by `src/orgs`, `src/platform`, `src/data/meter.ts`.
  A tenant statement may read or write them too (membership checks, the settings audit) — with its `org_id`.
- **Global tables** (no `org_id`): `persons`, `identities`, `sessions`, `invites`, `oauth_clients`,
  `oauth_tokens`, `orgs`, `platform_admins`, `cron_cursor`, `sections`, `tags`.

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
  (`PersonError`, a `bad_request` on HTTP and MCP).
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
| `src/platform/sweeps.ts` `expireDueHandoffs`, `pruneRepoCapture`; `src/auth/oauth.ts` `pruneOAuth` | cross-org retention sweeps: write-only, bounded by age |
| `src/platform/jobs.ts` (`org_repos`, `org_environments`) | the cron's unit lists and the webhook's hook lookup, before any org is known — ids, an environment key and a repo name |
| `src/auth/tokens.ts` `resolveToken`; `src/auth/oauth.ts` `resolveOAuthAccessToken`, `exchangeAuthorizationCode`, `refreshAccessToken`, `revokeOAuthToken`, `grantRefusal` | credential lookup by HASH before any org is known (the row names the org), and the revoke of the one grant just found |
| `src/auth/oauth.ts` `listGrants`, `revokeGrant` | Connected apps is user-level: a person's own grants across their orgs, keyed by person |
| `src/artifacts/upload.ts` `uploadTokenOrg` | upload-token lookup by hash, returning only its `org_id` |
| `src/platform/usage.ts` (whole file); `src/platform/repo.ts` `listAudit` (`org_audit`) | the superadmin's cross-org counts and merged audit trail — no content, no secret |
| `src/orgs/repo.ts` `removeMember` | revokes the removed person's tokens / grants for that org, in the same batch |
| `src/auth/persons.ts` `renamePerson` (interpolated) | the `HANDLE_COLUMNS` update — a rename must span every org |
| `src/tools/artifacts.ts` `normalizeLinkRef` (interpolated, tenant) | `tickets` or `sprints` from a two-value literal, with `org_id = ?` |
| `src/tools/progress.ts` upsert on `sprint_progress` | its PK is `sprint_id` alone; guarded by `WHERE sprint_progress.org_id = excluded.org_id` (asserted) |

## Background jobs (Phase 5b — spec §8.3–§8.5)

No background entry point names an org any more: each one ENUMERATES the orgs (or finds the one a delivery
belongs to) through `src/platform/jobs.ts`, then does its work as that org's `systemTenant`.

| Entry point | Org comes from | Runs as |
|---|---|---|
| repo cron `handleRepoCron` (`src/repo/cron.ts`) | `listEnvUnits` / `listRepoUnits` — every non-suspended org | `systemTenant(p, org, "system")` per unit |
| digest crons `handleNotificationCron` (`src/notifications/cron.ts`) | `listActiveOrgIds` | the same, per org |
| `POST /webhook/github/:hookId`, legacy `/webhook/github` (`src/github-hook.ts`) | `hookRepo(p, id)` / `legacyHookRepo(p)` | `systemTenant(p, row.org_id, "github-webhook")` |
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
`REPO_ENVIRONMENTS` are read by no background job (the two dashboard READS in `src/routes.ts` /
`src/mcp.ts` still parse the var; they move with their phases). Every credential comes from
`resolveCredential(ctx, env, kind, scope)`: `github_token` (`""`), `github_webhook` (the hook id),
`cloudflare_analytics` (`""`, + `resolveCloudflareAccountId`), `railway` and `metrics_endpoint` (the
environment key). It is resolved ONLY in modules that `src/mcp.ts` cannot reach — `src/repo/cron.ts`,
`src/github-hook.ts`, `src/tools/backfill.ts` — and the revealed value is passed down as a parameter
(`src/webhook.ts` and `src/repo/github.ts` ARE reachable from MCP; `test/secrets.mcp.test.ts`). Every log
line and stored `last_error` is scrubbed of every credential the unit revealed.

**Webhooks.** `POST /webhook/github/:hookId`: look the row up (unknown or suspended → 404), verify the HMAC
against that repo's secret (none / wrong → bare 401, NOTHING written), require the payload to name that
repo (else 202 ignored), then `captureDelivery` as the org. Only the org's PRIMARY repo is captured today —
the capture's keys (`gh:pr:<n>:…`) carry no repo — so a non-primary repo's verified delivery is ignored.
The legacy `POST /webhook/github` delivers to the one `legacy_hook = 1` row with no repository check,
exactly as before.

**Email.** One digest per (person, org): each org is due on its own `notification_settings`, the outbox key
is `org:user:cadence:window`, the unsubscribe is global. The From ADDRESS is the platform's — an org's
`from_address` contributes its display name only (`platformFrom`). `notification_policy` is seeded by
`createOrg` and topped up per org by the cron; the per-isolate seed in `src/index.ts` is gone.

**SaplingLearn's fallback (owner steps).** These Worker secrets are now read ONLY by `resolveCredential`'s
`org_saplinglearn` fallback (and by the cron's log scrubber): `GITHUB_SERVICE_TOKEN`, `GITHUB_WEBHOOK_SECRET`,
`CF_ANALYTICS_TOKEN` + `CF_ANALYTICS_ACCOUNT_ID`, `RAILWAY_TOKEN_<ENV>`, `SAPLING_METRICS_TOKEN`. Each stops
being read the moment SaplingLearn's admin stores that integration on the Integrations screen (a stored
secret wins). The cleanup phase deletes the fallback, those secrets, the legacy hook route and the
`legacy_hook` flag.

## Cut-over entry points (not shims — replaced in later phases)

`src/data/legacy.ts` keeps `legacySystemTenant(env, actor)` and `joinLegacyOrg(p, handle)`: the entry points
that cannot name their org yet act on SaplingLearn. After Phase 5b the only caller left is `src/auth/routes.ts`
(onboarding → Phase 4). `resolveSoleTenant` / `soleTenantGate` are the route alias Phase 4 replaces.
## Routes and gates (Phase 4 — spec §5, §6)

Every session request passes `sessionGate`, then exactly one of three things (`src/routes.ts`, `src/data/gate.ts`):

| Path | Gate | Tenant |
|---|---|---|
| `/api/o/:slug/*` | `tenantGate` | the org the path names, if the caller is a member — else 404 `{ error: "not_found" }` (unknown slug, non-member, suspended: all alike) |
| `/auth/*`, `/avatar/*`, `/api/orgs`, `/api/invites`, `/api/platform/*` | none (person-level) | none: these read and write the caller's own person, or are `requireSuperadmin` |
| every OTHER path | `soleTenantGate` (the cut-over alias) | the caller's ONE org — 409 `{ error: "org_required" }` with none or several, 404 if it is suspended |

`soleTenantGate` is the DEFAULT, so a route added without thought is tenant-gated, never open.

- **Defined once, mounted twice.** A tenant route is registered on `tenantRoot` (its suffix is its old path:
  `/docs`) or `tenantApi` (its old path had an `/api/`: `/handoffs` ↔ `/api/handoffs`), and both sub-apps are
  mounted under `/api/o/:org` and at the old prefix. A handler reads `c.var.ctx`, never the path. The org
  segment is `:org` on those mounts because many routes have a `:slug` of their own; `tenantGate` reads its
  own `:slug`. A sub-app mounted at `/` takes no `use("*")`.
- **Alias-only** (`legacyOnly`): `/invites…` (→ `/api/o/:slug/invites…`), `PUT /api/people/:handle`
  (→ `PUT /api/o/:slug/members/:handle`), and `/raw/a/*` (→ the artifact origin, §8.6). Phase 7 deletes the
  aliases and `soleTenantGate`.
- **Roles** (§5.2): admin means `hasRole(ctx, "admin")` (admin or owner of the request's org) — in the repository
  (`requireRole` → `RoleError` → 403 `forbidden`) or, on a route whose 403 body predates roles, `adminGate`
  (403 `{ error: "admin only" }`). `ADMIN_LOGINS` / `isAdmin` grant nothing on a session route; ONE reader is
  left — the MCP `update_plan` registration in `src/mcp.ts` (Phase 5a).
- **Confirm verbs** (D6) — promote / reject a doc, ratify / reject an ADR, publish a prompt, ratify an artifact —
  and the whole org surface refuse a request that carries an `Authorization` header (`cookieOnly`).
- **Org #1 only, for now** (`isLegacyOrg`, each marked `MT:`): `POST …/admin/{backfill,poll,poll-usage}` answer
  503 for any other org (what they call acts on SaplingLearn until Phase 5b), and the Repo dashboard gives another
  org its own primary repo with no environment config.

### People, invites, attribution

- **Sign-in** (§5.1, `src/auth/onboard.ts`): no GitHub org is checked. A known identity signs in; a new identity
  whose provider-VERIFIED email is another identity's `verified_email` is linked to that person (never
  `persons.email`, which is an editable notification address); otherwise GitHub always reaches onboarding and
  Google only with a pending invite for its verified email. `identities.verified_email` is written at every
  sign-in; `identities.provider_uid` (0045) pins a GitHub identity to the account's numeric id, and a sign-in
  with the same login but another id is refused.
- **Onboarding creates a person, never a membership** — a new person accepts an invite (`/api/invites`) or creates
  an org (`/api/orgs`). The ONE exception: a live legacy invite for their verified email is consumed as a
  SaplingLearn membership (`consumeLegacyInvite`), and only then is the welcome mail sent.
- **The legacy `/invites…` routes** (`src/orgs/legacy-invites.ts`) are a view of the caller's org's EMAIL
  `org_invites` rows in the old `InviteRow` shape. The invitee's name and the mail's delivery outcome stay in the
  global `invites` table, read and written for org #1 only; for any other org they are null.
- **Attribution** (C-1): Maintenance › Identity's map writes `org_login_map` (admin+), never `identities`.
  `resolvePersonForLogin(ctx, login)` / `memberGithubLogins` read the map first, then a MEMBER's own GitHub identity.
- **`persons.email`**: the person sets their own (`PUT …/notifications/prefs`); an org admin may set it only for a
  member who is in NO other org (`PUT …/notifications/persons/:handle` — 404 for a non-member, 409 otherwise).

## Cut-over entry points (not shims — replaced in later phases)

`src/data/legacy.ts` is the only file that names org #1. It keeps `legacySystemTenant(env, actor)` (the entry
points that cannot name their org yet), `isLegacyOrg(ctx)` (what is still org #1's alone) and the legacy-invite
rule (`liveLegacyInvite`, `consumeLegacyInvite`). Callers, each marked `// MT:` and listed in the static test:
`src/index.ts` (policy seed), `src/webhook.ts`, `src/tools/backfill.ts`, `src/repo/cron.ts`,
`src/notifications/cron.ts` (→ Phase 5b); `src/routes.ts` (Sync / Poll / dashboard config → 5b);
`src/auth/routes.ts`, `src/auth/onboard.ts`, `src/orgs/legacy-invites.ts`, `src/notifications/invite.ts` (the
legacy invite table and the welcome mail → Phase 7 / 5b). `resolveSoleTenant` / `soleTenantGate` stay until
Phase 7 deletes the aliases.

## Tests

`test/helpers/tenant.ts`: `systemCtx(org?)`, `tenantCtx(handle, role?, { orgId, via, env })`,
`bearerCtx(handle, role?, env?, orgId?)`, `mintTokenFor(handle, orgId?)`, `credentialOf(request)`,
`platformCtx`, `ensureMember`, `ORG_A`, `ORG_B`. `test/isolation.mcp.test.ts` is the MCP matrix: its entries are
checked against the server's own registry, so a new tool needs an entry (what to call it with from the other org). `test/helpers/org-config.ts`: an org's repo / environment rows
(`addOrgRepo`, `setOrgEnvironments`), and the one-org call shapes of the background entry points for the
SaplingLearn-only suites (`syncOrgConfig` copies the Env's `GITHUB_REPO` / `REPO_ENVIRONMENTS` into its rows,
as 0037 did). Fixture SQL may use `env.DB` directly; the raw `first` / `all` /
`run` helpers for it live in `test/helpers/db.ts` (production has none). Each module has an isolation
assertion in `test/isolation.*.test.ts`: write through `systemCtx(ORG_B)`, read through `systemCtx()`, expect nothing.

`test/isolation.http.test.ts` is the route-level matrix (§10.2), generated from the Hono route registry: a route
registered on the app with no entry in `TENANT` / `LEGACY_ONLY` / `PLATFORM` fails the suite. Add the entry — a
body that would succeed against org A — with the route. `seedPerson("admin-user")` is the suite's org ADMIN
(`FIXTURE_ADMIN`); `AndresL230` is SaplingLearn's owner; `seedPerson(h, { email, verified: true })` records the
address as provider-verified. Role gates: `test/role-gates.http.test.ts`; sign-in: `test/signin.multitenant.test.ts`.
